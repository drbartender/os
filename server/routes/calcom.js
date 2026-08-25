const express = require('express');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { calcomWebhookLimiter } = require('../middleware/rateLimiters');
const {
  verifyCalcomSignature,
  computeBodyHash,
  parseCalcomBody,
  extractBookingFields,
  extractRescheduleOldUid,
  normalizeBooker,
} = require('../utils/calcomWebhookHelpers');
const { consultCallTail } = require('../utils/consultCallChain');
const { chicagoTodayYmd } = require('../utils/businessTime');

let Sentry = null;
try { Sentry = require('@sentry/node'); } catch (_) { /* optional in dev */ }

function sentryWarn(message, ctx = {}) {
  if (Sentry && process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage(message, { level: 'warning', ...ctx });
  }
}

const router = express.Router();

// Dependency-injection seam for tests (leadCallTrigger.js __setDeps idiom).
// calcom.test.js re-requires this router on every buildApp(), so the seam has
// to be reinstallable rather than a one-time module-level swap.
let _deps = { consultCallTail };
router.__setCalcomDeps = (d) => { _deps = { ..._deps, ...d }; };

router.post('/webhook', calcomWebhookLimiter, asyncHandler(async (req, res) => {
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
    // Strand-heal (audit F1 sibling). The dedupe row is autocommitted BEFORE the
    // consult is written. The try/catch below un-strands a CAUGHT handler throw,
    // but a HARD crash (process death) between that commit and the consult write
    // leaves the row with no consult, and Cal.com's retry would short-circuit
    // here forever, permanently losing the booking. So on a redelivery of a
    // consult-CREATING event (CREATE / RESCHEDULE — both leave a consult keyed by
    // payload.uid on success) whose consult is genuinely absent, drop the dedupe
    // row and fall through to reprocess (both handlers are idempotent). Any other
    // event, a missing uid, or a still-present consult is a true replay:
    // short-circuit unchanged (happy path untouched).
    const replayEvent = body.triggerEvent;
    const replayUid = body.payload && body.payload.uid;
    // startTime gate: a malformed CREATE/RESCHEDULE (uid but no startTime) is
    // intentionally 200-ignored by the handlers and never writes a consult, so
    // without this check every redelivery of such an event would loop
    // delete-dedupe-and-reprocess for nothing.
    const healable = (replayEvent === 'BOOKING_CREATED' || replayEvent === 'BOOKING_RESCHEDULED')
      && Boolean(body.payload && body.payload.startTime);
    let stranded = false;
    if (healable && replayUid) {
      const consult = await pool.query(
        'SELECT 1 FROM consults WHERE calcom_event_id = $1 LIMIT 1',
        [replayUid]
      );
      stranded = consult.rowCount === 0;
    }
    if (!stranded) {
      return res.status(200).send('Already processed');
    }
    await pool.query(
      `DELETE FROM webhook_events WHERE provider = 'calcom' AND event_id = $1`,
      [eventUid]
    );
    sentryWarn('Cal.com dedupe strand healed on redelivery', {
      tags: { webhook: 'calcom', reason: 'strand_heal' },
      extra: { triggerEvent: replayEvent, uid: replayUid },
    });
    // fall through to normal dispatch below, reprocessing the stranded event.
  }

  const event = body.triggerEvent;
  const data = body.payload || {};

  // Strand-on-failure guard (audit F1). The dedupe row above is committed
  // (autocommit) BEFORE the handler runs. If a handler throws mid-processing,
  // Cal.com retries the delivery — but the committed dedupe row would
  // short-circuit that retry as "Already processed", permanently losing the
  // consult create / cancel / reschedule / no-show. So on ANY handler failure
  // we delete the dedupe row, letting the retry re-run the handler. All four
  // handlers are idempotent (consult fast-path + ON CONFLICT, fixed-status
  // UPDATEs guarded on status <> 'completed', reschedule's create fallthrough),
  // so a heal re-run never double-applies. The row therefore persists only on
  // success — exactly when a later true replay should be skipped. (await so a
  // rejection is caught here, not after the function returns.)
  try {
    switch (event) {
      case 'BOOKING_CREATED':         return await handleCreated(data, res);
      case 'BOOKING_CANCELLED':       return await handleCancelled(data, res);
      case 'BOOKING_RESCHEDULED':     return await handleRescheduled(data, res);
      case 'BOOKING_NO_SHOW_UPDATED': return await handleNoShow(data, res);
      default:
        console.log(`[calcom] ignored event: ${event || 'unknown'}`);
        return res.status(200).send(`ignored: ${event || 'unknown'}`);
    }
  } catch (err) {
    // Un-strand: drop the dedupe row so Cal.com's retry re-runs the handler.
    // Best-effort — if this DELETE also fails, asyncHandler still 500s and
    // Cal.com keeps retrying; the row stays only in the rare DB-down window.
    try {
      await pool.query(
        `DELETE FROM webhook_events WHERE provider = 'calcom' AND event_id = $1`,
        [eventUid]
      );
    } catch (_) { /* swallow; surfaced via the rethrow below */ }
    throw err;
  }
}));

// The consult-call tail runs in its OWN try/catch, never the handler's. A
// rejection that reached the handler catch would ROLLBACK an already-COMMITted
// transaction, rethrow, 500 the route, and send the error path above into
// DELETEing the dedupe row, so Cal.com would retry a booking that was already
// filed successfully. A tail failure is a missed call chain, never a lost
// booking, so it is logged and swallowed here.
async function runTail(fn) {
  try {
    await fn();
  } catch (err) {
    console.error('[calcom] tail failed:', (err && err.message) || err);
  }
}

// Event handlers. All four ship: created, cancelled, rescheduled, no-show.
// opts.unresolvedOldUid is set only by handleRescheduled's fallthrough (this
// booking moved off a slot Cal.com named but we could not resolve).
async function handleCreated(payload, res, opts) {
  const { uid, startTime } = extractBookingFields(payload);
  if (!uid || !startTime) {
    sentryWarn('Cal.com BOOKING_CREATED missing uid or startTime', {
      tags: { webhook: 'calcom', triggerEvent: 'BOOKING_CREATED' },
    });
    return res.status(200).send('Malformed payload, ignored');
  }

  const { name, email, phone, bookerNameRaw, bookerEmailRaw } = normalizeBooker(payload);

  const client = await pool.connect();
  // Set once the post-commit path releases early; the finally then knows not to
  // release a second time (pg throws on a double release).
  let released = false;
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
                     'Auto-created from Cal.com consult booking on ' || $4::text)
             RETURNING id`,
            [name, email, phone, chicagoTodayYmd()]
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
    } else if (phone) {
      // No usable email but phone is present. Soft-dedupe on
      // (LOWER(name), phone) so repeat email-less bookings reuse the
      // same client row. Phone is the disambiguator; without it (see
      // the !phone branch below) we always insert a fresh row to
      // prevent name-only client takeover from a public booking page.
      const lookup = await client.query(
        `SELECT id FROM clients
         WHERE email IS NULL
           AND LOWER(name) = LOWER($1)
           AND phone = $2
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
                   'Auto-created from Cal.com consult booking (no email) on ' || $3::text)
           RETURNING id`,
          [name, phone, chicagoTodayYmd()]
        );
        clientId = created.rows[0].id;
        createdClientInThisTx = true;
      }
    } else {
      // No email AND no phone: always insert fresh. Soft-dedupe by name
      // alone would let any unauthenticated Cal.com booking with a
      // victim's name attach to that victim's client row. Multiple
      // orphan rows from repeat email-less + phone-less bookings is the
      // safer failure mode; admin can manually merge if needed.
      const created = await client.query(
        `INSERT INTO clients (name, email, phone, source, notes)
         VALUES ($1, NULL, NULL, 'calcom',
                 'Auto-created from Cal.com consult booking (no email, no phone) on ' || $2::text)
         RETURNING id`,
        [name, chicagoTodayYmd()]
      );
      clientId = created.rows[0].id;
      createdClientInThisTx = true;
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
          booker_name, booker_email, booker_phone)
       VALUES ($1, $2, $3, $4, 'scheduled', $5, $6, $7)
       ON CONFLICT (calcom_event_id) DO NOTHING
       RETURNING id, scheduled_at, booker_phone`,
      [clientId, proposalId, startTime, uid, bookerNameRaw, bookerEmailRaw, phone]
    );

    if (consultResult.rowCount === 0 && createdClientInThisTx) {
      // Lost the race AND we just auto-created the client. Discard the
      // orphan so the clients table doesn't accumulate junk. Safe because
      // we just created this row in this transaction, nothing else
      // references its id yet.
      await client.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }

    await client.query('COMMIT');

    // Release BEFORE the tail (thumbtack.js /leads precedent). consultCallTail
    // runs on bare pool.query, so holding this client across it would make one
    // request occupy a pooled connection while waiting for a second one, which
    // is the pool-deadlock pattern that has already bitten this codebase twice.
    // The transaction is committed and nothing below touches `client`.
    client.release();
    released = true;

    // Only a WON insert opens a chain. rowCount 0 means we lost the ON CONFLICT
    // race (the winner's own tail covers that consult), and the Already filed
    // fast path returned long before here: neither moved a booking, so neither
    // may ring anyone. The tail gets the RETURNED row, never the payload: on a
    // create they agree, but keeping one source for both handlers is what stops
    // the reschedule case from ever passing a payload null over a stored number.
    if (consultResult.rowCount === 1) {
      const row = consultResult.rows[0];
      await runTail(() => _deps.consultCallTail({
        consultId: row.id,
        scheduledAt: row.scheduled_at,
        bookerPhone: row.booker_phone,
        triggerEvent: 'BOOKING_CREATED',
        unresolvedOldUid: Boolean(opts && opts.unresolvedOldUid),
        // The RAW email, i.e. what consults.booker_email actually stores. The
        // tail's sibling lookup matches on that column, and the validated
        // `email` is null for anything that fails the format check.
        bookerEmail: bookerEmailRaw,
      }));
    }

    return res.status(200).send('OK');
  } catch (err) {
    // ROLLBACK only while we still hold the client. pg-pool re-wraps release()
    // but never query(), so after the post-commit release the pool may already
    // have handed this client to another request, and a stray ROLLBACK would
    // end SOMEONE ELSE's transaction. Unreachable today (only runTail, which
    // swallows everything, and res.send sit between the release and the return)
    // but the blast radius is another request's data, so it is guarded.
    if (!released) {
      try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
    }
    throw err;
  } finally {
    if (!released) client.release();
  }
}
async function handleCancelled(payload, res) {
  const uid = payload?.uid;
  if (!uid) {
    return res.status(200).send('Missing uid, ignored');
  }

  const startTime = payload?.startTime || new Date().toISOString();
  const { bookerNameRaw, bookerEmailRaw } = normalizeBooker(payload);

  // WHERE guards against a late cancel arriving after an admin (or another
  // path) marked the consult `completed`. Without it, the UPSERT would flip
  // the completed row back to `cancelled` and undo admin work. The same
  // protection is mirrored in handleNoShow below.
  await pool.query(
    `INSERT INTO consults
       (calcom_event_id, scheduled_at, status, booker_name, booker_email)
     VALUES ($1, $2, 'cancelled', $3, $4)
     ON CONFLICT (calcom_event_id) DO UPDATE
     SET status = 'cancelled'
     WHERE consults.status <> 'completed'`,
    [uid, startTime, bookerNameRaw, bookerEmailRaw]
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
  const { phone, bookerNameRaw, bookerEmailRaw } = normalizeBooker(payload);

  if (oldUid) {
    // COALESCE on booker_phone and booker_email: a reschedule payload that
    // carries neither keeps what the booker gave at the original booking.
    // RETURNING then hands the tail the STORED values, and this is the one
    // handler where stored and payload can differ, so the tail reads EVERY
    // field off the returned row. Passing the payload's null number would file
    // a bogus undialable row that blocks the sweep from ever ringing this
    // consult; passing its null email would make the tail's sibling lookup
    // match nothing. calcom_event_id is UNIQUE, so this matches at most one row.
    const result = await pool.query(
      `UPDATE consults
       SET calcom_event_id = $1, scheduled_at = $2, status = 'scheduled',
           booker_name = COALESCE($3, booker_name),
           booker_email = COALESCE($4, booker_email),
           booker_phone = COALESCE($6, booker_phone)
       WHERE calcom_event_id = $5
       RETURNING id, scheduled_at, booker_phone, booker_email`,
      [newUid, newStartTime, bookerNameRaw, bookerEmailRaw, oldUid, phone]
    );
    if (result.rowCount > 0) {
      const row = result.rows[0];
      await runTail(() => _deps.consultCallTail({
        consultId: row.id,
        scheduledAt: row.scheduled_at,
        bookerPhone: row.booker_phone,
        triggerEvent: 'BOOKING_RESCHEDULED',
        bookerEmail: row.booker_email,
      }));
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
    extra: {
      newUid,
      reason: oldUid ? 'old_uid_not_in_db' : 'no_old_uid_in_payload',
      oldUid: oldUid || null,
      payloadShape: Object.keys(payload || {}),
    },
  });
  return handleCreated(payload, res, { unresolvedOldUid: true });
}
async function handleNoShow(payload, res) {
  const uid = payload?.uid;
  if (!uid) {
    return res.status(200).send('Missing uid, ignored');
  }

  // status <> 'completed' guards against a late no-show flip overwriting an
  // admin's manual completion. The zero-row branch below covers two cases
  // now: uid not in DB, and uid present but already completed. We probe with
  // one extra SELECT on the rare miss path so the Sentry signal carries a
  // `reason` discriminator (mirrors the pattern in handleRescheduled).
  const result = await pool.query(
    `UPDATE consults SET status = 'no_show' WHERE calcom_event_id = $1 AND status <> 'completed'`,
    [uid]
  );

  if (result.rowCount === 0) {
    const probe = await pool.query(
      `SELECT status FROM consults WHERE calcom_event_id = $1`,
      [uid]
    );
    const reason = probe.rowCount === 0 ? 'unknown_uid' : 'already_completed';
    console.warn(`[calcom] no_show skipped (${reason}): ${uid}`);
    sentryWarn('Cal.com no-show skipped', {
      tags: { webhook: 'calcom', triggerEvent: 'BOOKING_NO_SHOW_UPDATED', reason },
      extra: { uid, reason },
    });
  }

  return res.status(200).send('OK');
}

module.exports = router;
module.exports._handlers = { handleCreated, handleCancelled, handleRescheduled, handleNoShow };
