const express = require('express');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const {
  verifyCalcomSignature,
  computeBodyHash,
  parseCalcomBody,
  extractBookingFields,
  extractRescheduleOldUid,
  normalizeBooker,
} = require('../utils/calcomWebhookHelpers');

let Sentry = null;
try { Sentry = require('@sentry/node'); } catch (_) { /* optional in dev */ }

function sentryWarn(message, ctx = {}) {
  if (Sentry && process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(message, { level: 'warning', ...ctx });
  }
}

const router = express.Router();

router.post('/webhook', asyncHandler(async (req, res) => {
  // Pre-check 1: secret configured. Fails closed.
  if (!process.env.CAL_WEBHOOK_SECRET) {
    console.error('[calcom] CAL_WEBHOOK_SECRET not set; rejecting webhook');
    return res.status(503).send('Cal.com webhook not configured');
  }

  // Pre-check 2: signature header present.
  const provided = req.headers['x-cal-signature-256'] || '';
  if (!provided) {
    sentryWarn('Cal.com webhook missing signature header', {
      tags: { webhook: 'calcom', reason: 'missing_signature' },
    });
    return res.status(400).send('Missing signature');
  }

  // Pre-check 3: signature valid.
  const sigOk = verifyCalcomSignature(req.body, provided, process.env.CAL_WEBHOOK_SECRET);
  if (!sigOk) {
    console.error('[calcom] signature verification failed');
    sentryWarn('Cal.com webhook signature failure', {
      tags: { webhook: 'calcom', reason: 'invalid_signature' },
    });
    return res.status(400).send('Invalid signature');
  }

  // Pre-check 4: body parses.
  let body;
  try {
    body = parseCalcomBody(req.body);
  } catch (_) {
    sentryWarn('Cal.com webhook JSON parse failure', {
      tags: { webhook: 'calcom', reason: 'malformed_body' },
    });
    return res.status(400).send('Malformed body');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sentryWarn('Cal.com webhook non-object body', {
      tags: { webhook: 'calcom', reason: 'malformed_body' },
    });
    return res.status(400).send('Malformed body');
  }

  // Replay protection: dedupe by SHA-256 of the raw signed body.
  const eventUid = computeBodyHash(req.body);
  const dedupe = await pool.query(
    `INSERT INTO webhook_events (provider, event_id, received_at)
     VALUES ('calcom', $1, NOW())
     ON CONFLICT (provider, event_id) DO NOTHING
     RETURNING received_at`,
    [eventUid]
  );
  if (dedupe.rowCount === 0) {
    return res.status(200).send('Already processed');
  }

  const event = body.triggerEvent;
  const data = body.payload || {};

  switch (event) {
    case 'BOOKING_CREATED':         return handleCreated(data, res);
    case 'BOOKING_CANCELLED':       return handleCancelled(data, res);
    case 'BOOKING_RESCHEDULED':     return handleRescheduled(data, res);
    case 'BOOKING_NO_SHOW_UPDATED': return handleNoShow(data, res);
    default:
      console.log(`[calcom] ignored event: ${event || 'unknown'}`);
      return res.status(200).send(`ignored: ${event || 'unknown'}`);
  }
}));

// Event handlers. handleCreated implemented; others are stubs that Tasks 6, 7, 8 fill in.
async function handleCreated(payload, res) {
  const { uid, startTime } = extractBookingFields(payload);
  if (!uid || !startTime) {
    sentryWarn('Cal.com BOOKING_CREATED missing uid or startTime', {
      tags: { webhook: 'calcom', triggerEvent: 'BOOKING_CREATED' },
    });
    return res.status(200).send('Malformed payload, ignored');
  }

  const { name, email, phone, bookerNameRaw, bookerEmailRaw } = normalizeBooker(payload);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fast-path: skip if already filed. Perf optimization; the consults
    // ON CONFLICT below is the real correctness boundary.
    const existing = await client.query(
      'SELECT id FROM consults WHERE calcom_event_id = $1',
      [uid]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return res.status(200).send('Already filed');
    }

    let clientId = null;
    let createdClientInThisTx = false;

    if (email) {
      const lookup = await client.query(
        'SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1',
        [email]
      );
      if (lookup.rows[0]) {
        clientId = lookup.rows[0].id;
      } else {
        // SAVEPOINT brackets the INSERT so a 23505 (lost race against a
        // concurrent auto-create for the same email) can be rolled back
        // without aborting the outer transaction. Without the savepoint,
        // the next query after a failed INSERT throws SQLSTATE 25P02
        // (current transaction is aborted, commands ignored until end of
        // transaction block) and the loser's whole transaction has to
        // ROLLBACK, losing the consult row.
        await client.query('SAVEPOINT clients_insert');
        try {
          const created = await client.query(
            `INSERT INTO clients (name, email, phone, source, notes)
             VALUES ($1, $2, $3, 'calcom',
                     'Auto-created from Cal.com consult booking on ' || CURRENT_DATE::text)
             RETURNING id`,
            [name, email, phone]
          );
          await client.query('RELEASE SAVEPOINT clients_insert');
          clientId = created.rows[0].id;
          createdClientInThisTx = true;
        } catch (err) {
          if (err.code === '23505') {
            // Lost the race against another concurrent create for same email.
            // ROLLBACK TO SAVEPOINT clears the aborted-transaction state
            // (otherwise the re-SELECT below throws 25P02). Re-SELECT to
            // pick up the winner's clientId; do not flag this as a
            // we-created-it case because we did not actually create.
            await client.query('ROLLBACK TO SAVEPOINT clients_insert');
            const reLookup = await client.query(
              'SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1',
              [email]
            );
            clientId = reLookup.rows[0]?.id || null;
          } else {
            // Unexpected error. Still need to either release or rollback
            // the savepoint before re-throwing; we choose rollback so
            // the outer transaction sees a clean state when it ROLLBACKs.
            try { await client.query('ROLLBACK TO SAVEPOINT clients_insert'); } catch (_) { /* swallow */ }
            throw err;
          }
        }
      }
    } else {
      // No usable email. Partial UNIQUE on clients.email permits multiple
      // NULL-email rows, which would let the same fat-fingered booker
      // accumulate orphan clients across multiple bookings. Soft-dedupe
      // on (LOWER(name), phone) so repeat email-less bookings reuse the
      // same client row.
      const lookup = await client.query(
        `SELECT id FROM clients
         WHERE email IS NULL
           AND LOWER(name) = LOWER($1)
           AND COALESCE(phone, '') = COALESCE($2, '')
         ORDER BY created_at DESC
         LIMIT 1`,
        [name, phone]
      );
      if (lookup.rows[0]) {
        clientId = lookup.rows[0].id;
      } else {
        const created = await client.query(
          `INSERT INTO clients (name, email, phone, source, notes)
           VALUES ($1, NULL, $2, 'calcom',
                   'Auto-created from Cal.com consult booking (no email) on ' || CURRENT_DATE::text)
           RETURNING id`,
          [name, phone]
        );
        clientId = created.rows[0].id;
        createdClientInThisTx = true;
      }
    }

    // Proposal linkage. Excludes terminal statuses ('archived', 'completed').
    // Allowed proposals.status values per schema.sql are:
    // 'draft','sent','viewed','modified','accepted','deposit_paid',
    // 'balance_paid','confirmed','completed','archived'. We exclude
    // 'completed' and 'archived'; all other values are link candidates.
    let proposalId = null;
    if (clientId) {
      const props = await client.query(
        `SELECT id FROM proposals
         WHERE client_id = $1 AND status NOT IN ('archived', 'completed')
         ORDER BY created_at DESC LIMIT 1`,
        [clientId]
      );
      proposalId = props.rows[0]?.id || null;
    }

    // Insert consults row. ON CONFLICT (calcom_event_id) DO NOTHING
    // serializes concurrent creates for the same uid. RETURNING id +
    // rowCount lets us detect race-loss and discard an orphan client.
    const consultResult = await client.query(
      `INSERT INTO consults
         (client_id, proposal_id, scheduled_at, calcom_event_id, status,
          booker_name, booker_email)
       VALUES ($1, $2, $3, $4, 'scheduled', $5, $6)
       ON CONFLICT (calcom_event_id) DO NOTHING
       RETURNING id`,
      [clientId, proposalId, startTime, uid, bookerNameRaw, bookerEmailRaw]
    );

    if (consultResult.rowCount === 0 && createdClientInThisTx) {
      // Lost the race AND we just auto-created the client. Discard the
      // orphan so the clients table doesn't accumulate junk. Safe because
      // we just created this row in this transaction, nothing else
      // references its id yet.
      await client.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }

    await client.query('COMMIT');
    return res.status(200).send('OK');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
    throw err;
  } finally {
    client.release();
  }
}
async function handleCancelled(payload, res) {
  const uid = payload?.uid;
  if (!uid) {
    return res.status(200).send('Missing uid, ignored');
  }

  const startTime = payload?.startTime || new Date().toISOString();
  const bookerName = String(payload?.attendees?.[0]?.name || '').trim().slice(0, 255) || null;
  const bookerEmail = String(payload?.attendees?.[0]?.email || '').trim().toLowerCase().slice(0, 255) || null;

  await pool.query(
    `INSERT INTO consults
       (calcom_event_id, scheduled_at, status, booker_name, booker_email)
     VALUES ($1, $2, 'cancelled', $3, $4)
     ON CONFLICT (calcom_event_id) DO UPDATE
     SET status = 'cancelled'`,
    [uid, startTime, bookerName, bookerEmail]
  );

  return res.status(200).send('OK');
}
async function handleRescheduled(payload, res) {
  const newUid = payload?.uid;
  const newStartTime = payload?.startTime;
  if (!newUid || !newStartTime) {
    return res.status(200).send('Malformed payload, ignored');
  }

  const oldUid = extractRescheduleOldUid(payload);
  const bookerName = String(payload?.attendees?.[0]?.name || '').trim().slice(0, 255) || null;
  const bookerEmail = String(payload?.attendees?.[0]?.email || '').trim().toLowerCase().slice(0, 255) || null;

  if (oldUid) {
    const result = await pool.query(
      `UPDATE consults
       SET calcom_event_id = $1, scheduled_at = $2, status = 'scheduled',
           booker_name = COALESCE($3, booker_name),
           booker_email = COALESCE($4, booker_email)
       WHERE calcom_event_id = $5`,
      [newUid, newStartTime, bookerName, bookerEmail, oldUid]
    );
    if (result.rowCount > 0) {
      return res.status(200).send('Rescheduled in place');
    }
    // Fall through if we never saw the original create.
  }

  // No old-uid reference, or old uid not in our DB. Treat as fresh CREATED.
  // Surface this in Sentry so operator can investigate the missing
  // create AND optionally clean up the stale 'scheduled' row from the
  // original booking that we never saw.
  sentryWarn('Cal.com BOOKING_RESCHEDULED with unresolvable old uid', {
    tags: { webhook: 'calcom', triggerEvent: 'BOOKING_RESCHEDULED' },
    extra: { newUid, payloadShape: Object.keys(payload || {}) },
  });
  return handleCreated(payload, res);
}
async function handleNoShow(payload, res) {
  const uid = payload?.uid;
  if (!uid) {
    return res.status(200).send('Missing uid, ignored');
  }

  const result = await pool.query(
    `UPDATE consults SET status = 'no_show' WHERE calcom_event_id = $1`,
    [uid]
  );

  if (result.rowCount === 0) {
    console.warn(`[calcom] no_show for unknown uid: ${uid}`);
    sentryWarn('Cal.com no-show for unknown booking', {
      tags: { webhook: 'calcom', triggerEvent: 'BOOKING_NO_SHOW_UPDATED' },
      extra: { uid },
    });
  }

  return res.status(200).send('OK');
}

module.exports = router;
module.exports._handlers = { handleCreated, handleCancelled, handleRescheduled, handleNoShow };
