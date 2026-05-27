# Cal.com Integration

**Created:** 2026-05-26 · **Branch:** `cal-com` · **Parent design:** `2026-05-20-automated-communication-design.md` (sections 6, 8.7, 3.10, 11 item 3) · **Revised:** 2026-05-26 (folded in spec-review fleet findings)

## 1. Summary

Wire drb-os to a Cal.com instance so client-side consult bookings flow through to our system. Receive Cal.com webhooks (booking created, cancelled, rescheduled, no-show), file each into the existing `consults` table, auto-create a `clients` row when the booker is not already known, and flip consults to `'completed'` when admin submits the existing consult form. Also surface the public booking URL in three already-placeholdered client comms touches (drink-plan nudge email, drink-plan nudge SMS, six-months-out marketing email).

Cal.com itself owns admin notification. drb-os does not send a parallel SMS or email on booking events.

## 2. Context

### 2.1 What is already in place

Built ahead of this spec, shipped via Phase 2a of the automated-communication project:

- **`consults` table** (`server/db/schema.sql:2362`): `id`, `client_id` (FK → clients ON DELETE SET NULL), `proposal_id` (FK → proposals ON DELETE SET NULL), `scheduled_at`, `calcom_event_id`, `status` (CHECK: `'scheduled' | 'completed' | 'cancelled' | 'no_show'`, default `'scheduled'`), `created_at`. Indexes on `proposal_id`, `client_id`, and a partial `(scheduled_at) WHERE status = 'scheduled'`.
- **`scheduled_messages.entity_type` accepts `'consult'`** and the dispatcher's `lookupEntity` knows how to SELECT a consult row by id (`server/utils/scheduledMessageDispatcher.js:355`). Nothing currently schedules against this entity type, but the rails exist for future work.
- **Post-consult client email already exists.** `server/routes/drinkPlanConsult.js` PUT `/:id/consult` (the existing admin consult-form route) persists `consult_selections`, generates the shopping list as `pending_review`, and fires the `postConsultClient` email once (gated by `isFirstTimeConsultSave`, tracked via `drink_plans.consult_filled_at`). Template at `server/utils/emailTemplates.js#postConsultClient` (re-exported from `server/utils/lifecycleEmailTemplates.js:285`), formatter at `server/utils/consultRecap.js`. The template takes `{ clientName, eventTypeLabel, formattedEventDate, drinkRecapLines, nextStepLine }`. No `consultUrl` parameter; it is a recap, not a CTA. Out of scope for this spec.
- **Drink-plan-nudge suppression already keys on `consult_filled_at`** (`server/utils/drinkPlanNudge.js:108-125`). Once admin captures consult notes, the T-21 nudge stops firing for that proposal. No changes to this flow are needed.
- **Three `consultUrl: null` placeholders** already wired through email + SMS templates: `server/utils/marketingHandlers.js:464` (six-months-out marketing email), `server/utils/drinkPlanNudge.js:148` (drink-plan-nudge email), `server/utils/drinkPlanNudge.js:160` (drink-plan-nudge SMS). Templates already render the consult line when the URL is set and gracefully omit it when null.
- **Partial UNIQUE index on `clients.email`** (`server/db/schema.sql:1220`): `CREATE UNIQUE INDEX IF NOT EXISTS idx_clients_email_unique ON clients(email) WHERE email IS NOT NULL`. This load-bearing constraint shapes the auto-create flow in Section 5.1.
- **Stripe + Resend webhook reference pattern** (`server/routes/stripe.js:784-816`, `server/index.js:128-132`): raw body via `express.raw`, 503 on missing secret, Sentry capture on signature failure, bare `res.status().send(...)` (deliberate divergence from CLAUDE.md's `AppError` convention because Cal.com expects plain HTTP status, not JSON envelopes). The Cal.com handler mirrors this pattern exactly.

### 2.2 What is deliberately not built in V1, and why

- **No drb-os admin SMS on booking, cancel, reschedule, or no-show.** Cal.com emails the organizer on every booking event and syncs the entry onto the organizer's Google Calendar. Duplicating that with our own SMS is noise. The parent comms spec called for a parallel SMS in section 6; revisited during design, V1 leaves admin notification entirely to Cal.com.
- **No drb-os event link inside the Cal.com calendar entry.** Cal.com's hosted v2 API does not cleanly expose a post-creation booking-update endpoint. Once Cal.com is self-hosted on the always-on office box (deferred workstream, separate project), the integration can write directly into Cal.com's Postgres `booking.description` and have Cal.com's normal sync push the drb-os URL into the Google Calendar entry. Until that lands, admin uses Cal.com's standard notification and opens the matched (or auto-created) client in drb-os manually.
- **No save-draft vs mark-complete split on the consult form.** Existing single-action consult form ("Generate shopping list") stays as-is.
- **No drb-os admin UI for browsing consults.** Cal.com's interface is the canonical booking browser. The drb-os `consults` table is purely internal state for status tracking, entity-typed scheduled messages, and audit.
- **No `consultUrl` injection into the `postConsultClient` recap email.** That template is a "great talking through your drink plan" recap, not a "book another consult" CTA. Adding the booking URL here is semantically wrong. If a follow-up-consult CTA is ever wanted, that is a separate copy decision.

## 3. Goals and non-goals

**Goals.**
1. Cal.com booking events land in drb-os reliably and idempotently, with replay protection against captured-signature reuse.
2. Every Cal.com booking corresponds to a `clients` row (matched or auto-created) so admin has the client record ready before the call.
3. The existing consult-form admin action flips the linked consults row to `'completed'`.
4. Public booking URL surfaces in the three client comms touches that already placeholder it.
5. Webhook signature verification fails closed.
6. Cancel, reschedule, and no-show keep the consults row's status in sync with Cal.com.
7. PII coming from Cal.com is normalized and length-capped before landing in our canonical `clients` table.

**Non-goals.**
1. Admin notification on any booking event (Cal.com handles).
2. Calendar-entry enrichment with drb-os links (deferred until self-hosted).
3. Any change to the consult-form UI, the post-consult email copy or trigger, or the shopping-list approval flow.
4. Any change to `drink_plans` schema.
5. Cal.com event-type or availability configuration (admin sets up in Cal.com directly).

## 4. Architecture

### 4.1 Route file

New file `server/routes/calcom.js` exports an Express router with a single endpoint, `POST /webhook`. Mounted in `server/index.js` at `/api/calcom` so the public URL is `POST /api/calcom/webhook`.

The handler is bare (no `auth` middleware, no `requireAdminOrManager`). Authentication is HMAC signature verification on the raw body, plus the replay-protection check in §4.5.

### 4.2 Raw body capture

Cal.com signs the request body. Computing the HMAC requires the exact byte sequence Cal.com signed, not a re-serialized JSON object. Following the existing Stripe and Resend webhook pattern in `server/index.js:128-132`, register `express.raw({ type: 'application/json' })` on this path BEFORE the global `express.json()` middleware:

```js
// server/index.js (alongside the existing stripe + resend lines)
app.use('/api/calcom/webhook', express.raw({ type: 'application/json' }));
```

The handler then reads `req.body` as a Buffer for HMAC computation, and `JSON.parse`s it after the signature passes.

### 4.3 Signature verification

Cal.com sends `x-cal-signature-256: <hex_digest>` (per `https://cal.com/docs/core-features/webhooks`). Verification, with explicit pre-checks:

```js
const crypto = require('crypto');
const Sentry = require('@sentry/node');

// Pre-check #1: secret must be configured. Fail closed.
if (!process.env.CAL_WEBHOOK_SECRET) {
  console.error('[calcom] CAL_WEBHOOK_SECRET not set; rejecting webhook');
  return res.status(503).send('Cal.com webhook not configured');
}

// Pre-check #2: signature header present.
const provided = req.header('x-cal-signature-256') || '';
if (!provided) {
  Sentry.captureMessage('Cal.com webhook missing signature header', {
    level: 'warning',
    tags: { webhook: 'calcom', reason: 'missing_signature' },
  });
  return res.status(400).send('Missing signature');
}

// HMAC compare. Constant-time.
const expected = crypto
  .createHmac('sha256', process.env.CAL_WEBHOOK_SECRET)
  .update(req.body) // raw Buffer
  .digest('hex');

const ok = expected.length === provided.length &&
           crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));

if (!ok) {
  console.error('[calcom] signature verification failed');
  Sentry.captureMessage('Cal.com webhook signature failure', {
    level: 'warning',
    tags: { webhook: 'calcom', reason: 'invalid_signature' },
  });
  return res.status(400).send('Invalid signature');
}
```

Mirrors the Stripe pattern at `server/routes/stripe.js:784-816` (503 on missing config, 400 + Sentry on bad sig, bare `res.status().send()`). Deliberate divergence from CLAUDE.md's `AppError` convention because webhook clients consume plain HTTP semantics, not JSON envelopes; this divergence is precedented and consistency-check should treat it as accepted.

**Startup-time secret check.** On `server/index.js` boot, if `process.env.CAL_WEBHOOK_SECRET` is unset, emit a single warning via `Sentry.captureMessage(..., { level: 'warning' })` so the missed-config alarm fires even when no traffic hits the endpoint. Same pattern can ride alongside the existing scheduler-disable env-var warnings.

### 4.4 Body parse and dispatch on triggerEvent

After signature passes, parse the body inside a try/catch. A malformed JSON body should not throw a 500 (which Cal.com retries forever); it should be a 400.

```js
let body;
try {
  body = JSON.parse(req.body.toString('utf8'));
} catch (e) {
  Sentry.captureMessage('Cal.com webhook JSON parse failure', {
    level: 'warning',
    tags: { webhook: 'calcom', reason: 'malformed_body' },
  });
  return res.status(400).send('Malformed body');
}

const event = body.triggerEvent;
const data = body.payload || {};

// Replay protection (see §4.5) runs here, BEFORE the dispatch switch.

switch (event) {
  case 'BOOKING_CREATED':         return handleCreated(data, res);
  case 'BOOKING_CANCELLED':       return handleCancelled(data, res);
  case 'BOOKING_RESCHEDULED':     return handleRescheduled(data, res);
  case 'BOOKING_NO_SHOW_UPDATED': return handleNoShow(data, res);
  default:
    // BOOKING_REQUESTED, BOOKING_REJECTED, BOOKING_PAID, MEETING_STARTED,
    // MEETING_ENDED, RECORDING_READY, FORM_SUBMITTED, etc. Log + 200 OK so
    // Cal.com does not retry.
    console.log(`[calcom] ignored event: ${event}`);
    return res.status(200).json({ ok: true, ignored: event });
}
```

Each handler returns `200` on success (including the no-op success of "we already had this booking"). DB errors throw and bubble to `asyncHandler`'s global error handler, which returns `500` and lets Cal.com retry; the replay-dedupe + uniqueness guarantees in §4.5 and §5.1 make retries idempotent.

### 4.5 Replay protection via `webhook_events` table

`calcom_event_id` uniqueness in §5.1 dedupes legitimate Cal.com retries of the same `BOOKING_CREATED`. It does NOT dedupe an attacker who captured a valid signed body once and replays it: the cancel/reschedule/no-show handlers operate by UPDATEs keyed on `calcom_event_id`, so a replayed `BOOKING_CANCELLED` will flip a `scheduled` row to `cancelled` over and over (each call is idempotent, but a determined replay can confuse the state machine, e.g., replay a `BOOKING_CANCELLED` after a legitimate `BOOKING_RESCHEDULED` to un-do the reschedule).

New table `webhook_events(provider, event_id, received_at)` with `UNIQUE (provider, event_id)`. At the top of the webhook handler (after signature verification, before dispatch), attempt an INSERT:

```js
// Dedupe key = SHA-256 of the entire raw signed body. Two events with
// identical raw bodies are identical events (legitimate Cal.com retry of
// a 5xx, or attacker replay). Any change to the body (different uid,
// startTime, createdAt, or any other field) produces a different hash
// and is processed as a distinct event. This avoids fragile assumptions
// about which fields Cal.com populates on which trigger event.
const eventUid = crypto.createHash('sha256').update(req.body).digest('hex');

const dedupe = await pool.query(
  `INSERT INTO webhook_events (provider, event_id, received_at)
   VALUES ('calcom', $1, NOW())
   ON CONFLICT (provider, event_id) DO NOTHING
   RETURNING received_at`,
  [eventUid]
);
if (dedupe.rowCount === 0) {
  // Replay (or legitimate Cal.com retry on a 5xx, same wire shape).
  return res.status(200).send('Already processed');
}
```

The legitimate-Cal.com-retry case (we 5xx'd, Cal.com re-fires same envelope) collapses with the replay case (attacker re-sends): both hit the dedupe and short-circuit. This is fine because the original processing either succeeded (no work to do) or failed (the error is in our logs/Sentry; admin debugs from there, not via Cal.com nudging us).

**Why body-hash instead of structured key.** Earlier draft used `${triggerEvent}:${payload.uid}:${body.createdAt}`. That assumed `createdAt` is always populated at the outer envelope, which Cal.com docs do not guarantee uniformly across all four trigger events (notably `BOOKING_NO_SHOW_UPDATED`, which is a state-flip not a creation). If `createdAt` were ever missing, two distinct legitimate events would collapse into one dedupe hit. The raw-body SHA-256 sidesteps the field-shape uncertainty entirely.

**Retention.** A 30-day prune runs alongside the existing schedulers (§8 declares the prune block; runs hourly, deletes rows older than 30 days). Critical to have before any other webhook provider starts using this table, since Stripe at higher volume would balloon storage fast.

## 5. Event handlers

### 5.1 BOOKING_CREATED

Inputs read from `payload`:

| Field | Source |
|---|---|
| `uid` | `payload.uid` (Cal.com booking ID) |
| `startTime` | `payload.startTime` (ISO timestamp) |
| `bookerName` | `payload.attendees[0].name` |
| `bookerEmail` | `payload.attendees[0].email` |
| `bookerPhone` | `payload.attendees[0].phoneNumber` if present, else null. Cal.com may place phone in alternate locations depending on form configuration: handler probes `attendees[0].phoneNumber`, then `attendees[0].phone`, then `payload.responses.phone`, then `payload.customInputs.phone`. First non-empty value wins. NULL if none. |

**Normalization, before any DB write:**

```js
const nameRaw = String(payload.attendees?.[0]?.name || '').trim();
const name = nameRaw.slice(0, 255) || 'Unknown booker'; // clients.name VARCHAR(255) NOT NULL

const emailRaw = String(payload.attendees?.[0]?.email || '').trim().toLowerCase();
const email = emailRaw && emailRaw.length <= 255 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)
  ? emailRaw
  : null; // store NULL rather than garbage; partial UNIQUE permits multiple NULLs

const phoneRaw = String(extractPhone(payload) || '').trim();
const phone = phoneRaw.slice(0, 50) || null;
```

**Algorithm.** Single explicit transaction. Pseudocode shows the connection ceremony in full so the implementer cannot accidentally use `pool` directly.

```js
async function handleCreated(payload, res) {
  const { uid, startTime } = extractBookingFields(payload);
  const { name, email, phone, bookerNameRaw, bookerEmailRaw } = normalizeBooker(payload);

  if (!uid || !startTime) {
    Sentry.captureMessage('Cal.com BOOKING_CREATED missing uid or startTime', {
      level: 'warning', tags: { webhook: 'calcom' },
    });
    return res.status(200).send('Malformed payload, ignored');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fast-path optimization: skip the rest if we already have this consult.
    // This is a perf optimization; the ON CONFLICT in step 4 is the
    // correctness boundary that actually serializes concurrent creates.
    const existing = await client.query(
      'SELECT id FROM consults WHERE calcom_event_id = $1',
      [uid]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return res.status(200).send('Already filed');
    }

    // Lookup-or-create the client. The partial UNIQUE index on
    // clients(email) WHERE email IS NOT NULL is the serialization point
    // for concurrent auto-creates: the loser sees 23505 and we re-SELECT.
    // Track whether WE created the client in this transaction so we can
    // delete it if we lose the consults race at the end.
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
        try {
          const created = await client.query(
            `INSERT INTO clients (name, email, phone, source, notes)
             VALUES ($1, $2, $3, 'calcom',
                     'Auto-created from Cal.com consult booking on ' || CURRENT_DATE::text)
             RETURNING id`,
            [name, email, phone]
          );
          clientId = created.rows[0].id;
          createdClientInThisTx = true;
        } catch (err) {
          if (err.code === '23505') {
            // Lost the race against another concurrent create for same email.
            // The winner committed before our INSERT could land. Re-SELECT
            // to pick up the winner's clientId; do not flag this as a
            // we-created-it case because we did not actually create.
            const reLookup = await client.query(
              'SELECT id FROM clients WHERE LOWER(email) = $1 LIMIT 1',
              [email]
            );
            clientId = reLookup.rows[0]?.id || null;
          } else {
            throw err;
          }
        }
      }
    } else {
      // No usable email. Partial UNIQUE on clients.email permits multiple
      // NULL-email rows, which would let the same fat-fingered booker
      // accumulate orphan clients across multiple bookings. Soft-dedupe
      // on (LOWER(name), phone) so repeat email-less bookings reuse the
      // same client row. Soft because (name, phone) is not a real key;
      // best-effort to keep the clients table tidy without claiming
      // uniqueness as a constraint.
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

    // Proposal linkage. Excludes terminal statuses.
    // Allowed proposals.status values per schema.sql:2196 are:
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

    // Insert the consults row. ON CONFLICT is the correctness boundary:
    // if another concurrent create handler also got past the fast-path
    // and is racing us, exactly one will win the UNIQUE on calcom_event_id.
    // RETURNING id lets us detect race-loser. On race-loss, if we just
    // auto-created the client in this transaction, the client is now
    // orphaned (the winning consult points at the winner's clientId, not
    // ours). DELETE our orphan so the clients table stays clean.
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
      // Lost the consults race AND we just auto-created the client.
      // Discard the orphan so the clients table doesn't accumulate junk.
      // Safe because we just created the row this transaction, nothing
      // else can reference its id yet.
      await client.query('DELETE FROM clients WHERE id = $1', [clientId]);
    }

    await client.query('COMMIT');
    return res.status(200).send('OK');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
    throw err; // bubbles to asyncHandler → 500 → Cal.com retries
  } finally {
    client.release();
  }
}
```

`booker_name` and `booker_email` on the consults row hold the RAW (pre-normalization) booker data from the webhook. This preserves the original audit trail even if the auto-created client's name/email are later edited in drb-os.

### 5.2 BOOKING_CANCELLED

Defensive upsert. If we already have the booking, mark it cancelled. If we missed the original create (e.g., downtime), file a cancelled-from-the-start row so the audit trail is complete. Single transaction; populates `booker_name`/`booker_email` on the defensive insert path.

```js
async function handleCancelled(payload, res) {
  const uid = payload?.uid;
  const startTime = payload?.startTime; // may be missing on some cancel payloads
  const bookerName = String(payload?.attendees?.[0]?.name || '').trim().slice(0, 255) || null;
  const bookerEmail = String(payload?.attendees?.[0]?.email || '').trim().toLowerCase().slice(0, 255) || null;

  if (!uid) {
    return res.status(200).send('Missing uid, ignored');
  }

  // scheduled_at is NOT NULL in the consults schema. Use the original startTime
  // if present; otherwise fall through to NOW() so the defensive insert does
  // not violate NOT NULL.
  const effectiveStart = startTime || new Date().toISOString();

  await pool.query(
    `INSERT INTO consults
       (calcom_event_id, scheduled_at, status, booker_name, booker_email)
     VALUES ($1, $2, 'cancelled', $3, $4)
     ON CONFLICT (calcom_event_id) DO UPDATE
     SET status = 'cancelled'`,
    [uid, effectiveStart, bookerName, bookerEmail]
  );

  return res.status(200).send('OK');
}
```

Defensive-insert path leaves `client_id` and `proposal_id` NULL. We do not auto-create a client on a cancellation event (creating a client for someone who already cancelled is a bad signal). Admin sees the cancelled-with-NULL-client row and treats it as a historical record.

### 5.3 BOOKING_RESCHEDULED

Cal.com generates a new `uid` for the rescheduled booking and includes a reference to the original. Field name varies by Cal.com version. The handler probes a small set: `payload.rescheduleUid`, `payload.rescheduleId`, `payload.originalRescheduleEvent?.uid`, `payload.metadata?.rescheduleUid`. First non-empty wins. If none can be extracted, treats as a fresh `BOOKING_CREATED` (logged for visibility).

```js
async function handleRescheduled(payload, res) {
  const newUid = payload?.uid;
  const newStartTime = payload?.startTime;
  const oldUid = extractRescheduleOldUid(payload);
  const bookerName = ... // same normalization as 5.2
  const bookerEmail = ...

  if (!newUid || !newStartTime) {
    return res.status(200).send('Malformed payload, ignored');
  }

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
  Sentry.captureMessage('Cal.com BOOKING_RESCHEDULED with unresolvable old uid', {
    level: 'warning',
    tags: { webhook: 'calcom', triggerEvent: 'BOOKING_RESCHEDULED' },
    extra: { newUid, payloadShape: Object.keys(payload || {}) },
  });
  return handleCreated(payload, res);
}
```

This handles both Cal.com behaviors gracefully:
- "Single `BOOKING_RESCHEDULED` event with both uids" path (update in place).
- "Two events: `BOOKING_CANCELLED` for old + `BOOKING_CREATED` for new" fallback (we naturally end with two rows, one cancelled + one scheduled, which is functionally correct if slightly less tidy).

### 5.4 BOOKING_NO_SHOW_UPDATED

```js
async function handleNoShow(payload, res) {
  const uid = payload?.uid;
  if (!uid) return res.status(200).send('Missing uid, ignored');

  const result = await pool.query(
    `UPDATE consults SET status = 'no_show' WHERE calcom_event_id = $1`,
    [uid]
  );

  if (result.rowCount === 0) {
    // Surfaces silent earlier failures: a no-show on a booking we never
    // recorded means our BOOKING_CREATED was lost or never arrived.
    console.warn(`[calcom] no_show for unknown uid: ${uid}`);
    Sentry.captureMessage('Cal.com no-show for unknown booking', {
      level: 'warning',
      tags: { webhook: 'calcom', triggerEvent: 'BOOKING_NO_SHOW_UPDATED' },
      extra: { uid },
    });
  }

  return res.status(200).send('OK');
}
```

Idempotent. No defensive insert (a no-show on an unknown booking is too pathological to file blind).

### 5.5 Unhandled events

`default:` case logs and returns `200`. Specifically silenced: `BOOKING_REQUESTED`, `BOOKING_REJECTED`, `BOOKING_PAID`, `BOOKING_PAYMENT_INITIATED`, `MEETING_STARTED`, `MEETING_ENDED`, `RECORDING_READY`, `INSTANT_MEETING`, `FORM_SUBMITTED`, plus any future event type Cal.com adds.

## 6. `completed` status flip

Added to the existing `server/routes/drinkPlanConsult.js` PUT `/:id/consult` route. The existing handler uses `pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK` on a pooled `client` (declared at line ~133 of the current file). The new statement runs on THAT SAME `client`, not on `pool`, so it is part of the same transaction.

Insertion point: inside the `try` block, AFTER the existing UPDATE on `drink_plans` and BEFORE `await client.query('COMMIT')`. Wrapped in its own inner try/catch so a failure of the consults flip does NOT roll back the drink-plan / shopping-list save (that is the user's primary action; the consults-row flip is a side effect).

```js
// (existing UPDATE on drink_plans completes successfully above this point)

try {
  await client.query(
    `UPDATE consults
     SET status = 'completed'
     WHERE proposal_id = $1
       AND status = 'scheduled'
       AND scheduled_at <= NOW()`,
    [plan.proposal_id]
  );
} catch (flipErr) {
  // Don't roll back the consult save just because the side-effect flip
  // failed. Log + Sentry so operator can chase it.
  console.error('[drinkPlanConsult] consults status flip failed (non-fatal):', flipErr);
  if (process.env.SENTRY_DSN_SERVER) {
    const Sentry = require('@sentry/node');
    Sentry.captureException(flipErr, {
      tags: { route: 'drinkPlanConsult/putConsult', step: 'consults_complete_flip' },
      extra: { proposalId: plan.proposal_id },
    });
  }
}

await client.query('COMMIT');
```

Flips any past-and-scheduled consults for this proposal to `'completed'`. No-op if none match (admin held the consult off-platform, drink plan has no proposal, or admin re-submitted the form after already-completed runs). Idempotent on re-submission because `status = 'scheduled'` excludes already-completed rows.

Why `scheduled_at <= NOW()`: skips future consults. Edge case: client books consult #1, admin holds it and fills the form (#1 → completed), client books consult #2 for next week, admin re-saves the form for unrelated reasons. Without the time filter we would wrongly flip #2 to completed.

**Silent-failure caveat for future consult-targeting handlers.** The fire-and-forget log-and-Sentry on flip failure is acceptable today because nothing else acts on `consults.status`. Any future scheduled-message handler that targets `entity_type='consult'` (see §14 ideas around "consult in 1 hour" prep SMS or post-consult feedback) MUST defensively also check the linked `drink_plans.consult_filled_at` as a backup completion signal, OR the flip MUST be converted from fire-and-forget to a retry-backed job before those features ship. Otherwise stale `scheduled` rows from flip failures would trigger reminders for already-done consults.

No UI change. No new endpoint.

## 7. Booking URL surfacing

Replace the three `consultUrl: null` placeholders with `process.env.CAL_BOOKING_URL || null`:

| File | Line | Context |
|---|---|---|
| `server/utils/marketingHandlers.js` | 464 | `six_months_out` marketing email |
| `server/utils/drinkPlanNudge.js` | 148 | Drink-plan-nudge email |
| `server/utils/drinkPlanNudge.js` | 160 | Drink-plan-nudge SMS |

When the env var is unset, the substituted value is `null` (same as today) and existing template logic gracefully omits the consult line. When set, the line renders with the configured URL. Templates already handle both states; no template-side changes are required.

**Out of scope here:** the `postConsultClient` recap email (`lifecycleEmailTemplates.js:285`) is a "great talking through your drink plan" recap, not a CTA. It is intentionally NOT given a consultUrl parameter.

**Rollout note (cross-reference §13):** `CAL_BOOKING_URL` must be set on the server before the Cal.com webhook is subscribed in Cal.com's dashboard. If marketing or nudge sends fire between webhook-subscribed and env-var-set, those sends render without the consult line silently. Rollout step ordering enforces this.

## 8. Schema changes

Idempotent ALTERs appended to the bottom of `server/db/schema.sql`. Source-enum migration is split into separate blocks so a failure to add the new constraint surfaces as an error rather than being silently swallowed.

```sql
-- ─── Cal.com integration ────────────────────────────────────────

-- 1a. Drop old source check constraint (idempotent).
DO $$ BEGIN
  ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_source_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 1b. Add new source check constraint NOT VALID, then VALIDATE. If existing
-- data violates the new enum, VALIDATE fails loudly with the offending row
-- rather than being swallowed and leaving the constraint missing.
-- (Plain CREATE CONSTRAINT also works since none of the existing rows
-- should be outside the old enum, which is a subset of the new one. The
-- NOT VALID + VALIDATE pattern is documented here for the schema-evolution
-- discipline even though it is functionally equivalent in this case.)
ALTER TABLE clients
  ADD CONSTRAINT clients_source_check
  CHECK (source IN ('direct', 'thumbtack', 'referral', 'website', 'calcom'))
  NOT VALID;
ALTER TABLE clients VALIDATE CONSTRAINT clients_source_check;

-- 2. Booker context columns on consults, preserved separately from the
-- (potentially-edited-later) client record. VARCHAR(255) matches the
-- clients.name / clients.email width for consistent ceilings across
-- the audit pair.
ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_name VARCHAR(255);
ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_email VARCHAR(255);

-- 3. Unique constraint on calcom_event_id for webhook idempotency.
-- Nullable column: PostgreSQL allows multiple NULLs in a UNIQUE constraint,
-- so any pre-Cal.com consult rows (if they exist) are unaffected.
DO $$ BEGIN
  ALTER TABLE consults ADD CONSTRAINT consults_calcom_event_id_key UNIQUE (calcom_event_id);
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 4. Generic webhook-event dedupe table for replay protection (§4.5).
-- One row per processed event, with provider + event_id forming the
-- dedupe key. 30-day prune runs alongside existing schedulers (see below).
CREATE TABLE IF NOT EXISTS webhook_events (
  provider VARCHAR(50) NOT NULL,
  event_id TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_received_at
  ON webhook_events(received_at);
```

The `webhook_events` table is intentionally generic (provider as a column) rather than Cal.com-specific so future webhook integrations (a hypothetical second consult provider, or a new Cal.com event flavor) can reuse the same dedupe infrastructure.

**`webhook_events` prune scheduler.** A new `webhookEventsPruneScheduler` runs hourly, deleting rows where `received_at < NOW() - INTERVAL '30 days'`. Registered in `server/index.js` `start()` alongside existing schedulers, gated by `RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER` (default on; honored when `RUN_SCHEDULERS` is not `false`). Implementation is a single `DELETE FROM webhook_events WHERE received_at < NOW() - INTERVAL '30 days'` wrapped in the existing `wrapScheduler('webhook_events_prune', 3600, prune)` pattern. Including this scheduler in this spec (rather than deferring) prevents unbounded growth, especially as additional webhook providers (Stripe, Resend, Thumbtack) potentially adopt the same dedupe table.

No changes to `drink_plans`, `proposals`, or `scheduled_messages`.

## 9. Environment variables

Two new variables.

| Variable | Purpose | Required in prod | Failure mode if unset |
|---|---|---|---|
| `CAL_WEBHOOK_SECRET` | HMAC-SHA256 signing secret for the Cal.com webhook. Generated when configuring the webhook in Cal.com. | Yes | Webhook handler returns 503 with body `'Cal.com webhook not configured'`. Startup emits Sentry warning (level=warning) once so missed-config alarm fires even with no traffic. Fails closed. |
| `CAL_BOOKING_URL` | Public booking page URL. `https://cal.com/<username>/<event-type>` for hosted Cal.com, `https://book.drbartender.com/<event-type>` once self-hosted. | No (but see rollout §13) | Three client touches (drink-plan nudge email + SMS, six-months-out marketing) gracefully omit the consult line. Booking-receiver still works. Per §7 / §13, set BEFORE subscribing the Cal.com webhook to prevent the silent-omission window. |
| `RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER` | Optional. Set to `false` to disable the `webhook_events` 30-day prune (§8). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. | No | Prune never runs; table grows unbounded until manually deleted. |

Documentation updates: add both to `.env.example` and to the Environment Variables table in `CLAUDE.md`. All three placeholders consuming `CAL_BOOKING_URL` are server-side, so no client-side `REACT_APP_*` mirror is needed in V1.

## 10. Error handling and edge cases

**Bad signature.** `400 'Invalid signature'`, no DB write, no log of payload contents. Sentry capture (level=warning, tag `reason=invalid_signature`).

**Missing signature header.** `400 'Missing signature'`, Sentry capture with `reason=missing_signature`. Common attacker probe; test case included in §12.

**Missing `CAL_WEBHOOK_SECRET` in prod.** `503` on every request with `'Cal.com webhook not configured'` body. Startup logs once and emits a Sentry warning. Never silently accepts unsigned input.

**Malformed JSON body.** `400 'Malformed body'`, Sentry capture with `reason=malformed_body`. Prevents `JSON.parse` throwing a generic 500 (which Cal.com would retry forever).

**Replay (captured signed body re-sent).** `webhook_events` dedupe at §4.5 short-circuits with `200 'Already processed'`. Same path also catches legitimate Cal.com retries of events we already 5xx'd on, which is fine: the original failure is in our logs/Sentry; we don't need Cal.com to keep nudging us.

**Cal.com retries on 5xx.** Our handlers are idempotent via `calcom_event_id` uniqueness + `webhook_events` dedupe, so retries are safe. A handler that throws after partial work cannot leave partial state because both writes share one explicit transaction (§5.1).

**Bad payload shape.** Missing `payload.attendees`, missing `attendees[0].email`, missing `payload.uid`, missing `payload.startTime`: per-handler decisions documented in §5. `BOOKING_CREATED` with no `uid` or `startTime` returns `200 'Malformed payload, ignored'` + Sentry warning. `BOOKING_CANCELLED` falls back to `effectiveStart = NOW()` if `startTime` missing (consults.scheduled_at is NOT NULL so the COALESCE is mandatory).

**Attendee name empty.** `clients.name` is NOT NULL VARCHAR(255). Normalization (§5.1) trims, length-caps at 255, and falls back to literal `'Unknown booker'`. Admin renames during the call.

**Attendee email empty or malformed.** Normalization rejects anything failing a basic format check and stores NULL. Partial UNIQUE permits multiple NULLs, so multiple email-less auto-created clients can coexist. Admin can dedupe manually if a real human accidentally booked twice without email.

**Email collision under concurrent BOOKING_CREATED.** Two parallel webhook handlers race to auto-create a client for the same normalized email. The partial UNIQUE on `clients(email) WHERE email IS NOT NULL` (`server/db/schema.sql:1220`) serializes them: one wins the INSERT, the other catches SQLSTATE 23505 and re-SELECTs to pick up the winner's `clientId`. Documented in the §5.1 pseudocode.

**Phone field absent or in unexpected location.** Probes `attendees[0].phoneNumber`, then `attendees[0].phone`, then `responses.phone`, then `customInputs.phone`. First non-empty wins. NULL otherwise.

**Rescheduled booking missing the old uid reference.** Probes `payload.rescheduleUid`, `payload.rescheduleId`, `payload.originalRescheduleEvent?.uid`, `payload.metadata?.rescheduleUid`. Falls back to treating the event as a fresh `BOOKING_CREATED` if no old uid can be extracted, leaving a stale `scheduled` row from the original booking. Operator can clean up manually; logged for visibility.

**No-show event for an unknown booking.** Logs `console.warn` + Sentry warning. Returns 200. Indicates the original `BOOKING_CREATED` was lost; admin investigates from Sentry.

**Hosted-to-self-hosted Cal.com migration.** `CAL_WEBHOOK_SECRET` and `CAL_BOOKING_URL` change on cutover. Both are env vars editable in Render dashboards. No code change. Cal.com booking-side migration (event types, availability, OAuth, DNS) is the separate ops workstream.

## 11. Documentation and consumer updates

Per the Mandatory Documentation Updates table in CLAUDE.md, plus the Cross-Cutting Consistency rule:

**Documentation files (split across rollout phases per §13):**

*Bundled into the code-deploy commit (§13 step 4):*
- **`.env.example`**: add `CAL_WEBHOOK_SECRET`, `CAL_BOOKING_URL`, `RUN_WEBHOOK_EVENTS_PRUNE_SCHEDULER` with brief inline comments. Operator setting up a fresh environment between deploy and the rest-of-docs commit needs this to be discoverable.
- **`CLAUDE.md`**: add the three new env vars to the Environment Variables table. Add Cal.com to the Tech Stack list as "Booking / scheduling (Cal.com)".

*Bundled into the post-rollout docs commit (§13 step 9):*
- **`README.md`**: add `server/routes/calcom.js` to the folder-structure tree. Mirror the new env vars into the README Environment Variables table. Add Cal.com to Tech Stack. Add a one-line entry to Key Features. Add the new `webhook_events_prune` scheduler to the NPM Scripts / scheduler list.
- **`ARCHITECTURE.md`**: add `POST /api/calcom/webhook` to the API route table. Add a "Cal.com" subsection under Third-Party Integrations describing webhook events handled, signature scheme, replay-protection mechanism, consults-table linkage, and the deferred-V2 calendar-enrichment plan. Update the `consults` table description to include `booker_name`, `booker_email`, and the unique constraint on `calcom_event_id`. Update the `clients.source` enum value list to include `'calcom'`. Document the new `webhook_events` table.

**Code files that must be updated in lockstep with the `clients.source` enum change** (Cross-Cutting Consistency rule). All three `SOURCE` maps need the new entry, not just one:
- **`server/routes/clients.js:9`**: extend `VALID_SOURCES = ['direct', 'thumbtack', 'referral', 'website']` to include `'calcom'`. The same array is referenced at lines 56 and 93 for ValidationError messages; no separate edits needed there since they use `.join(', ')`.
- **`client/src/pages/admin/ClientsDashboard.js:18`**: extend the `SOURCE` map by adding `calcom: { label: 'Cal.com', kind: 'info' }` (or another `kind` value if `'info'` clashes visually; the dashboard already uses `neutral`, `info`, `ok`, `accent`, `violet`). Same map drives the dropdown on `:163`.
- **`client/src/pages/admin/ClientDetail.js:15`**: extend its own `SOURCE` map with the same `calcom` entry. Without this, the client-detail page renders Cal.com-sourced clients with the raw enum string and a neutral chip.
- **`client/src/components/adminos/drawers/ClientDrawer.js:12`**: extend its own `SOURCE` map with the same `calcom` entry. Same rendering concern as ClientDetail. (Path is under `components/adminos/drawers/`, not `pages/admin/` as an earlier draft cited.)
- **Deferred:** `client/src/pages/admin/ProposalCreate.js:26` carries a `SOURCES` array used by the manual-proposal-create form's source dropdown. The file is currently 1337 lines, over the 1000-line hard cap, so the file-size ratchet pre-commit hook blocks any line additions. Resolving this means a separate cleanup spec that first extracts a sub-component from `ProposalCreate.js` to bring the file under the cap, then adds the `{ value: 'calcom', label: 'Cal.com' }` entry. Until that ships, Cal.com-sourced clients are still selectable in the proposal-create flow by typing the client name or by changing the client's source from the client detail page; the manual-create form's dropdown just won't pre-list `Cal.com` as an option.
- Note: the existing `instagram` entry in all three SOURCE maps (not in `VALID_SOURCES`) is a pre-existing inconsistency outside this spec's scope. Worth flagging in a separate cleanup spec.

## 12. Testing strategy

**Webhook signature.** Unit test the verification function (with `node:test` to match codebase pattern) with cases:
- Valid signature → passes
- Tampered body → fails (400)
- Missing `x-cal-signature-256` header entirely → 400 + Sentry warning (the most common attacker probe; explicit test)
- Wrong-case header (`X-Cal-Signature-256`) → still works (Express normalizes)
- Missing `CAL_WEBHOOK_SECRET` env var → 503 (fail-closed)

**Body parsing.** Malformed JSON body → 400, not 500.

**Replay protection.** Same valid signed body delivered twice → first returns 200 with side effects, second returns 200 'Already processed' with no side effects. Different events with same booking uid but different `createdAt` → both processed (correct dedupe key includes trigger event + timestamp).

**Handler idempotency.** Integration test against a Postgres test instance:
- Fire `BOOKING_CREATED` twice with same payload → one consults row, one clients row.
- Fire `BOOKING_CREATED` for an email matching an existing client → no duplicate clients row, consults.client_id matches.
- Fire `BOOKING_CANCELLED` before any `BOOKING_CREATED` → defensive cancelled row appears with booker_name/booker_email populated.
- Concurrent `BOOKING_CREATED` for two new bookings with the same email → exactly one clients row created, both consults rows reference it (loser path through 23505 catch).

**PII normalization.** Booker name with embedded HTML / 1000 chars → stored as trimmed + 255-char-capped value, not raw. Booker email with mixed case / surrounding whitespace → stored as lowercased + trimmed. Booker email failing format check → stored as NULL.

**Proposal linkage.** Client with one in-progress proposal (`'deposit_paid'`, `'confirmed'`, etc.) → links. Client with proposals all in `'archived'` or `'completed'` → `proposal_id = NULL`. Client with two in-progress proposals → links most recent by `created_at`.

**Completion flip.** Drink plan with a past-scheduled consult → flips to completed. Drink plan with a future-scheduled consult → untouched. Drink plan with an already-completed consult → no-op. Drink plan with no consult → no-op. Forced failure of the flip UPDATE → consult save still commits, error logs + Sentry capture fires.

**Defensive cancel/reschedule.** Cancel payload missing `startTime` → uses NOW() fallback. Reschedule with no recognizable old-uid field → falls back through to `handleCreated` path, logged.

**URL surfacing.** Snapshot test the three templates with `CAL_BOOKING_URL` set and unset; confirm rendered output differs only by the consult line.

**E2E smoke (manual, post-deploy).** Configure Cal.com webhook against the deployed `/api/calcom/webhook` endpoint. Make a test booking from a non-client email. Verify a `clients` row was auto-created with `source = 'calcom'` and a `consults` row was created with `status = 'scheduled'` + `booker_name`/`booker_email` populated. Cancel the booking in Cal.com, verify the consults row flips to `cancelled`. Reschedule another test booking, verify the consults row updates rather than duplicating. Replay a captured signed webhook body using `curl`, verify the second delivery is dedupe-rejected with `200 'Already processed'`.

## 13. Rollout

Step ordering matters: env vars set, then code + bundled docs deployed, then Cal.com webhook subscribed. Inverting any step creates a silent-misconfiguration window.

1. **Spec → plan → implementation.** Merge this spec, write the implementation plan via `/writing-plans`, execute on the `cal-com` worktree branch.
2. **Cal.com hosted account setup (operator task, can run in parallel with step 1).** Create a 15-minute consult event type, configure the booking form (name + email default, add optional phone field as a custom input), connect organizer's Google Calendar, generate webhook signing secret.
3. **Set env vars BEFORE merging the code.** In Render: set `CAL_WEBHOOK_SECRET` to the secret from step 2, set `CAL_BOOKING_URL` to the public booking-page URL from step 2. Do NOT subscribe the webhook in Cal.com yet.
4. **Merge + deploy** the implementation to main. The deploy commit MUST include the bundled docs from §11 (`.env.example` + `CLAUDE.md` env-var-table updates) so any operator setting up a fresh environment between this deploy and the post-rollout docs commit can discover the new vars. Render auto-deploys. Idempotent schema ALTERs (including the UNIQUE on `consults.calcom_event_id` and the new `webhook_events` table) apply during boot, BEFORE the route becomes reachable; this is what makes the `ON CONFLICT (calcom_event_id)` in §5.1 safe on first deploy.
5. **Verify the endpoint responds.** `curl -X POST https://<api-domain>/api/calcom/webhook` without signature returns 400 'Missing signature'. With wrong signature returns 400 'Invalid signature'. Confirms route + signature pre-checks are live before Cal.com starts sending.
6. **Subscribe the webhook in Cal.com.** Configure Cal.com webhook endpoint = `https://<api-domain>/api/calcom/webhook`, subscribe to `BOOKING_CREATED`, `BOOKING_CANCELLED`, `BOOKING_RESCHEDULED`, `BOOKING_NO_SHOW_UPDATED`. Paste the secret (matches what step 3 set in Render).
7. **Run the E2E smoke (§12).** Confirm webhooks land, consults rows appear, clients auto-create, replay-dedupe works.
8. **Verify URL placeholders render** the consult line in client comms (trigger a six-months-out send manually if needed, or wait for a real send).
9. **Post-rollout docs commit.** Update `README.md` and `ARCHITECTURE.md` per §11 (the deeper structural docs that don't block fresh-environment setup). Update `server/routes/clients.js` `VALID_SOURCES` and all three client-side `SOURCE` maps (`client/src/pages/admin/ClientsDashboard.js`, `client/src/pages/admin/ClientDetail.js`, `client/src/components/adminos/drawers/ClientDrawer.js`). The `SOURCES` array in `client/src/pages/admin/ProposalCreate.js` is deferred per §11.

## 14. Future work (deferred V2 and beyond)

- **Calendar-entry enrichment with drb-os links.** Once Cal.com is self-hosted on the office box, a small extension to the webhook handler writes the drb-os event URL directly into Cal.com's Postgres `booking.description` (or the relevant column on that schema version). Cal.com's normal calendar sync pushes the description into the organizer's Google Calendar event, satisfying the original "click into the event from my calendar" requirement.
- **Scheduled consult-related touches.** `scheduled_messages.entity_type` already supports `'consult'`. Examples worth considering: "consult in 1 hour" prep SMS to admin, post-consult feedback request to client. Each becomes a registered message-type handler; no schema work needed. Per the silent-failure caveat in §6, any new handler MUST defensively check `drink_plans.consult_filled_at` as a backup completion signal, OR the completion-flip in §6 MUST be converted from fire-and-forget to a retry-backed job before such handlers ship. Otherwise stale `scheduled` rows from rare flip failures will trigger spurious reminders.
- **drb-os admin view for consults.** A small `/admin/consults` page if a need surfaces. Today, Cal.com's UI plus the auto-created clients view covers the access pattern.
- **Auto-merge orphan consults on manual client creation.** If admin manually creates a client whose email matches an earlier auto-created Cal.com client, optionally merge or surface a "link existing consults?" prompt.
- **Save-draft vs mark-complete split on the consult form.** Explicitly deferred from V1.
- **Stronger replay defenses.** Today the dedupe key is the SHA-256 of the raw signed body, which is robust against replay of identical bodies but does not enforce freshness. An attacker with the secret could craft a fresh body with any timestamp; an attacker without the secret cannot forge a valid signature regardless. Optional V2: also check a freshness window on `body.createdAt` (reject if older than 5 minutes from server time), matching Stripe/Resend timestamp-tolerance behavior. Useful as defense-in-depth if the secret is ever leaked.
- **Reschedule reason capture.** Cal.com may include `responses.rescheduleReason`; we could store it on the consults row for admin context.
- **`UNIQUE` constraint on `clients.email` (non-partial).** Today's partial UNIQUE allows multiple NULLs (intentional). If duplicate email-less clients become an operational problem, escalate to a stricter constraint.
