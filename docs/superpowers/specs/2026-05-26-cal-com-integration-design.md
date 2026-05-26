# Cal.com Integration

**Created:** 2026-05-26 · **Branch:** `cal-com` · **Parent design:** `2026-05-20-automated-communication-design.md` (sections 6, 8.7, 3.10, 11 item 3)

## 1. Summary

Wire drb-os to a Cal.com instance so client-side consult bookings flow through to our system. Receive Cal.com webhooks (booking created, cancelled, rescheduled, no-show), file each into the existing `consults` table, auto-create a `clients` row when the booker is not already known, and flip consults to `'completed'` when admin submits the existing consult form. Also surface the public booking URL in three already-placeholdered client comms touches (drink-plan nudge email, drink-plan nudge SMS, six-months-out marketing email).

Cal.com itself owns admin notification. drb-os does not send a parallel SMS or email on booking events.

## 2. Context

### 2.1 What is already in place

Built ahead of this spec, shipped via Phase 2a of the automated-communication project:

- **`consults` table** (`server/db/schema.sql:2362`): `id`, `client_id` (FK → clients ON DELETE SET NULL), `proposal_id` (FK → proposals ON DELETE SET NULL), `scheduled_at`, `calcom_event_id`, `status` (CHECK: `'scheduled' | 'completed' | 'cancelled' | 'no_show'`, default `'scheduled'`), `created_at`. Indexes on `proposal_id`, `client_id`, and a partial `(scheduled_at) WHERE status = 'scheduled'`.
- **`scheduled_messages.entity_type` accepts `'consult'`** and the dispatcher's `lookupEntity` knows how to SELECT a consult row by id (`server/utils/scheduledMessageDispatcher.js:354`). Nothing currently schedules against this entity type, but the rails exist for future work.
- **Post-consult client email already exists.** `server/routes/drinkPlanConsult.js` PUT `/:id/consult` (the existing admin consult-form route) persists `consult_selections`, generates the shopping list as `pending_review`, and fires the `postConsultClient` email once (gated by `isFirstTimeConsultSave`, tracked via `drink_plans.consult_filled_at`). Template at `server/utils/emailTemplates.js#postConsultClient`, formatter at `server/utils/consultRecap.js`.
- **Drink-plan-nudge suppression already keys on `consult_filled_at`** (`server/utils/drinkPlanNudge.js:108-125`). Once admin captures consult notes, the T-21 nudge stops firing for that proposal. No changes to this flow are needed.
- **Three `consultUrl: null` placeholders** already wired through email + SMS templates: `server/utils/marketingHandlers.js:464` (six-months-out marketing email), `server/utils/drinkPlanNudge.js:148` (drink-plan-nudge email), `server/utils/drinkPlanNudge.js:160` (drink-plan-nudge SMS). Templates already render the consult line when the URL is set and gracefully omit it when null.

### 2.2 What is deliberately not built in V1, and why

- **No drb-os admin SMS on booking, cancel, reschedule, or no-show.** Cal.com emails the organizer on every booking event and syncs the entry onto the organizer's Google Calendar. Duplicating that with our own SMS is noise. The parent comms spec called for a parallel SMS in section 6; revisited during design, V1 leaves admin notification entirely to Cal.com.
- **No drb-os event link inside the Cal.com calendar entry.** Cal.com's hosted v2 API does not cleanly expose a post-creation booking-update endpoint. Once Cal.com is self-hosted on the always-on office box (deferred workstream, separate project), the integration can write directly into Cal.com's Postgres `booking.description` and have Cal.com's normal sync push the drb-os URL into the Google Calendar entry. Until that lands, admin uses Cal.com's standard notification and opens the matched (or auto-created) client in drb-os manually.
- **No save-draft vs mark-complete split on the consult form.** Existing single-action consult form ("Generate shopping list") stays as-is.
- **No drb-os admin UI for browsing consults.** Cal.com's interface is the canonical booking browser. The drb-os `consults` table is purely internal state for status tracking, entity-typed scheduled messages, and audit.

## 3. Goals and non-goals

**Goals.**
1. Cal.com booking events land in drb-os reliably and idempotently.
2. Every Cal.com booking corresponds to a `clients` row (matched or auto-created) so admin has the client record ready before the call.
3. The existing consult-form admin action flips the linked consults row to `'completed'`.
4. Public booking URL surfaces in the three client comms touches that already placeholder it.
5. Webhook signature verification fails closed.
6. Cancel, reschedule, and no-show keep the consults row's status in sync with Cal.com.

**Non-goals.**
1. Admin notification on any booking event (Cal.com handles).
2. Calendar-entry enrichment with drb-os links (deferred until self-hosted).
3. Any change to the consult-form UI, the post-consult email, or the shopping-list approval flow.
4. Any change to `drink_plans` schema.
5. Cal.com event-type or availability configuration (admin sets up in Cal.com directly).

## 4. Architecture

### 4.1 Route file

New file `server/routes/calcom.js` exports an Express router with a single endpoint, `POST /webhook`. Mounted in `server/index.js` at `/api/calcom` so the public URL is `POST /api/calcom/webhook`.

The handler is bare (no `auth` middleware, no `requireAdminOrManager`). Authentication is HMAC signature verification on the raw body.

### 4.2 Raw body capture

Cal.com signs the request body. Computing the HMAC requires the exact byte sequence Cal.com signed, not a re-serialized JSON object. Following the existing Stripe and Resend webhook pattern in `server/index.js:128-132`, register `express.raw({ type: 'application/json' })` on this path BEFORE the global `express.json()` middleware:

```js
// server/index.js (alongside the existing stripe + resend lines)
app.use('/api/calcom/webhook', express.raw({ type: 'application/json' }));
```

The handler then reads `req.body` as a Buffer for HMAC computation, and `JSON.parse`s it after the signature passes.

### 4.3 Signature verification

Cal.com sends `x-cal-signature-256: <hex_digest>` (per `https://cal.com/docs/core-features/webhooks`). Verification:

```js
const crypto = require('crypto');
const expected = crypto
  .createHmac('sha256', process.env.CAL_WEBHOOK_SECRET)
  .update(req.body) // raw Buffer
  .digest('hex');
const provided = req.header('x-cal-signature-256') || '';
const ok = expected.length === provided.length &&
           crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
if (!ok) {
  return res.status(400).json({ error: 'invalid_signature' });
}
```

If `CAL_WEBHOOK_SECRET` is unset, the handler returns `500` with a one-shot startup warning logged. Fails closed in production (never silently accepts an unsigned webhook).

### 4.4 Dispatch on triggerEvent

After signature passes, parse the body and switch on `payload.triggerEvent`:

```js
const body = JSON.parse(req.body.toString('utf8'));
const event = body.triggerEvent;
const data = body.payload || {};

switch (event) {
  case 'BOOKING_CREATED':         return handleCreated(data, res);
  case 'BOOKING_CANCELLED':       return handleCancelled(data, res);
  case 'BOOKING_RESCHEDULED':     return handleRescheduled(data, res);
  case 'BOOKING_NO_SHOW_UPDATED': return handleNoShow(data, res);
  default:
    // BOOKING_REQUESTED, BOOKING_REJECTED, BOOKING_PAID, MEETING_STARTED,
    // MEETING_ENDED, RECORDING_READY, FORM_SUBMITTED, etc. We do not care
    // about these in V1. Log + 200 OK so Cal.com does not retry.
    console.log(`[calcom] ignored event: ${event}`);
    return res.status(200).json({ ok: true, ignored: event });
}
```

Each handler returns `200` on success (including the no-op success of "we already had this booking"). DB errors throw and bubble to `asyncHandler`'s global error handler, which returns `500` and lets Cal.com retry.

## 5. Event handlers

### 5.1 BOOKING_CREATED

Inputs read from `payload`:

| Field | Source |
|---|---|
| `uid` | `payload.uid` (Cal.com booking ID) |
| `startTime` | `payload.startTime` (ISO timestamp) |
| `bookerName` | `payload.attendees[0].name` |
| `bookerEmail` | `payload.attendees[0].email` |
| `bookerPhone` | `payload.attendees[0].phoneNumber` if present, else NULL |

Algorithm (single transaction):

1. **Fast-path idempotency.** `SELECT id FROM consults WHERE calcom_event_id = $uid`. If a row exists, return `200` immediately, no further work. Cal.com retries on transient failure, so this guard prevents duplicate client auto-creates.

2. **Client lookup.** `SELECT id FROM clients WHERE LOWER(email) = LOWER($bookerEmail) LIMIT 1`.

3. **Client auto-create if not found.**
   ```sql
   INSERT INTO clients (name, email, phone, source, notes)
   VALUES ($bookerName, $bookerEmail, $bookerPhone, 'calcom',
           'Auto-created from Cal.com consult booking on ' || CURRENT_DATE::text)
   RETURNING id;
   ```
   `name` is required (NOT NULL); Cal.com always provides `attendees[0].name`. Defensive: if for any reason `bookerName` is empty, fall back to the literal string `Unknown booker` so the INSERT does not fail.
   `source = 'calcom'` requires extending the existing `clients_source_check` constraint (section 8).
   `communication_preferences` defaults to the standard JSONB (`{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}`); not special-casing Cal.com clients.

4. **Proposal linkage.**
   ```sql
   SELECT id FROM proposals
   WHERE client_id = $clientId
     AND status NOT IN ('archived', 'completed', 'cancelled')
   ORDER BY created_at DESC
   LIMIT 1;
   ```
   If exactly one row, use that as `proposal_id`. If multiple (rare), take most recent by `created_at`. If zero (always true for auto-created clients), `proposal_id = NULL`. Admin creates the proposal during or after the call.

5. **Insert the consults row.**
   ```sql
   INSERT INTO consults (client_id, proposal_id, scheduled_at, calcom_event_id, status,
                         booker_name, booker_email)
   VALUES ($clientId, $proposalId, $startTime, $uid, 'scheduled',
           $bookerName, $bookerEmail)
   ON CONFLICT (calcom_event_id) DO NOTHING
   RETURNING id;
   ```
   `ON CONFLICT DO NOTHING` is belt-and-suspenders alongside the step-1 fast-path; if the create handler somehow fires concurrently for the same uid, only one row wins, and the loser bails harmlessly.

6. Commit. Return `200`.

`booker_name` and `booker_email` are stored on the consults row in addition to the client record to preserve the original webhook data even if the client's email is later edited in drb-os.

### 5.2 BOOKING_CANCELLED

Defensive upsert. If we already have the booking, mark it cancelled. If we missed the original create (e.g., downtime), file a cancelled-from-the-start row so the audit trail is complete.

```sql
INSERT INTO consults (calcom_event_id, scheduled_at, status, booker_name, booker_email)
VALUES ($uid, $startTime, 'cancelled', $bookerName, $bookerEmail)
ON CONFLICT (calcom_event_id) DO UPDATE
SET status = 'cancelled';
```

If the defensive path fires (no prior row), `client_id` and `proposal_id` stay NULL. Admin sees a cancelled-from-NULL row and treats it as a historical record. We do NOT auto-create the client on a cancellation event (creating a client for someone who already cancelled is weird).

Return `200`.

### 5.3 BOOKING_RESCHEDULED

Cal.com generates a new `uid` for the rescheduled booking and includes a reference to the original. The exact field name (`payload.rescheduleUid`, `payload.rescheduleId`, `payload.responses.rescheduleReason`, or nested in metadata) is verified against a live payload during implementation; assume `payload.rescheduleUid` here, fall back to scanning known alternates.

1. `UPDATE consults SET calcom_event_id = $newUid, scheduled_at = $newStartTime, status = 'scheduled' WHERE calcom_event_id = $oldUid RETURNING id`.
2. If 0 rows updated (we never saw the original create), fall through to the same flow as `BOOKING_CREATED` using the new uid.

This handles both Cal.com behaviors gracefully:
- The "single `BOOKING_RESCHEDULED` event with both uids" path (update in place).
- The "two events: `BOOKING_CANCELLED` for old + `BOOKING_CREATED` for new" fallback (we naturally end with two rows, one cancelled + one scheduled, which is functionally correct if slightly less tidy).

Return `200`.

### 5.4 BOOKING_NO_SHOW_UPDATED

```sql
UPDATE consults SET status = 'no_show' WHERE calcom_event_id = $uid;
```

Idempotent. No defensive insert (a no-show on an unknown booking is too pathological to file blind). Return `200` even on zero rows updated.

### 5.5 Unhandled events

`default:` case logs and returns `200`. Specifically silenced: `BOOKING_REQUESTED`, `BOOKING_REJECTED`, `BOOKING_PAID`, `BOOKING_PAYMENT_INITIATED`, `MEETING_STARTED`, `MEETING_ENDED`, `RECORDING_READY`, `INSTANT_MEETING`, `FORM_SUBMITTED`, plus any future event type Cal.com adds.

## 6. `completed` status flip

Added to the existing `server/routes/drinkPlanConsult.js` PUT `/:id/consult` route. Inside the existing transaction (after the UPDATE on `drink_plans`, before COMMIT):

```sql
UPDATE consults
SET status = 'completed'
WHERE proposal_id = $1
  AND status = 'scheduled'
  AND scheduled_at <= NOW();
```

`$1` is the drink plan's `proposal_id`. Flips any past-and-scheduled consults for this proposal to `'completed'`. No-op if none match (admin held the consult off-platform, drink plan has no proposal, or admin re-submitted the form after already-completed runs). Idempotent on re-submission because `status = 'scheduled'` excludes already-completed rows.

Why `scheduled_at <= NOW()`: skips future consults. Edge case: client books consult #1, admin holds it and fills the form (#1 → completed), client books consult #2 for next week, admin re-saves the form for unrelated reasons. Without the time filter we would wrongly flip #2 to completed.

No UI change. No new endpoint.

## 7. Booking URL surfacing

Replace the three `consultUrl: null` placeholders with `process.env.CAL_BOOKING_URL || null`:

| File | Line | Context |
|---|---|---|
| `server/utils/marketingHandlers.js` | 464 | `six_months_out` marketing email |
| `server/utils/drinkPlanNudge.js` | 148 | Drink-plan-nudge email |
| `server/utils/drinkPlanNudge.js` | 160 | Drink-plan-nudge SMS |

When the env var is unset, the substituted value is `null` (same as today) and existing template logic gracefully omits the consult line. When set, the line renders with the configured URL. Templates already handle both states; no template-side changes are required.

## 8. Schema changes

Idempotent ALTERs appended to the bottom of `server/db/schema.sql`:

```sql
-- ─── Cal.com integration ────────────────────────────────────────

-- 1. Extend clients.source enum to admit 'calcom' for auto-created records.
DO $$ BEGIN
  ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_source_check;
  ALTER TABLE clients ADD CONSTRAINT clients_source_check
    CHECK (source IN ('direct', 'thumbtack', 'referral', 'website', 'calcom'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- 2. Booker context columns on consults, preserved separately from the
-- (potentially-edited-later) client record.
ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_name TEXT;
ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_email TEXT;

-- 3. Unique constraint on calcom_event_id for webhook idempotency.
-- Nullable column: PostgreSQL allows multiple NULLs in a UNIQUE constraint,
-- so any pre-Cal.com consult rows (if they exist) are unaffected.
DO $$ BEGIN
  ALTER TABLE consults ADD CONSTRAINT consults_calcom_event_id_key UNIQUE (calcom_event_id);
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

No changes to `drink_plans`, `proposals`, or `scheduled_messages`.

## 9. Environment variables

Two new variables.

| Variable | Purpose | Required in prod | Failure mode if unset |
|---|---|---|---|
| `CAL_WEBHOOK_SECRET` | HMAC-SHA256 signing secret for the Cal.com webhook. Generated when configuring the webhook in Cal.com. | Yes | Webhook handler returns 500 on every request with a one-time startup warning. Fails closed. |
| `CAL_BOOKING_URL` | Public booking page URL. `https://cal.com/<username>/<event-type>` for hosted Cal.com, `https://book.drbartender.com/<event-type>` once self-hosted. | No | Three client touches (drink-plan nudge email + SMS, six-months-out marketing) gracefully omit the consult line. Booking-receiver still works. |

Documentation updates: add both to `.env.example` and to the Environment Variables table in `CLAUDE.md`. `CAL_BOOKING_URL` also needs to be set on the client side (`REACT_APP_CAL_BOOKING_URL`) if any client-side template ever needs it; in V1 all three surfaces are server-rendered so the server-side var is sufficient.

## 10. Error handling and edge cases

**Bad signature.** `400 invalid_signature`, no DB write, no log of payload contents.

**Missing `CAL_WEBHOOK_SECRET` in prod.** `500` on every request. Startup logs a single warning. Never silently accepts unsigned input.

**Cal.com retries on `5xx`.** Our handlers are idempotent via `calcom_event_id` uniqueness, so retries are safe. A handler that throws after partial work (e.g., client INSERT committed but consults INSERT failed) is impossible because both writes share one transaction.

**Bad payload shape.** Missing `payload.attendees`, missing `attendees[0].email`, missing `payload.uid`, missing `payload.startTime`: log the event with the offending payload (no PII beyond what Cal.com already sent us), return `200 ignored` so Cal.com does not retry. Operator follow-up via logs; in practice these shapes are stable and a violation indicates Cal.com schema drift worth investigating manually.

**Attendee name empty.** `clients.name` is NOT NULL. Fall back to literal `'Unknown booker'` so the INSERT does not throw. Admin sees this in the client record and renames it during the call.

**Email already attached to a different client (auto-create collision).** Not possible in normal flow because lookup runs first. If two BOOKING_CREATED events for the same email arrive concurrently, the consults `ON CONFLICT (calcom_event_id) DO NOTHING` plus the transaction boundary serialize the two; whichever client INSERT lost the race produces a duplicate clients row with the same email (no UNIQUE constraint on `clients.email` exists). Acceptable; admin can dedupe manually in the very rare race. Future spec: add UNIQUE on `clients.email` if duplicates become a real problem.

**Phone field absent or in unexpected location.** Cal.com places the phone under different keys depending on custom-field type (`attendees[0].phoneNumber`, `attendees[0].phone`, or inside `payload.responses` / `payload.customInputs`). Implementation: probe a small set of known locations in order, take the first non-empty value, fall through to NULL. Document the probe order in the handler comment.

**Rescheduled booking missing the old uid reference.** Cal.com payload schema is stable but field names for the "original booking" reference vary. Implementation probes `payload.rescheduleUid`, then `payload.rescheduleId`, then `payload.originalRescheduleEvent.uid`, then nested under `metadata`. Falls back to treating the event as a new `BOOKING_CREATED` if no old uid can be extracted, leaving a stale `scheduled` row from the original booking. Operator can clean up manually; logged for visibility.

**Concurrent BOOKING_CREATED for the same uid.** PostgreSQL UNIQUE constraint serializes; the second transaction sees the conflict and the `ON CONFLICT DO NOTHING` returns zero rows. Handler treats that as success.

**Hosted-to-self-hosted Cal.com migration.** `CAL_WEBHOOK_SECRET` and `CAL_BOOKING_URL` change on cutover. Both are env vars editable in Render / Vercel dashboards. No code change. Cal.com booking-side migration (event types, availability, OAuth, DNS) is the separate ops workstream.

## 11. Documentation updates

Per the Mandatory Documentation Updates table in CLAUDE.md:

- **`CLAUDE.md`**: add `CAL_WEBHOOK_SECRET` and `CAL_BOOKING_URL` to the Environment Variables table. Add Cal.com to the Tech Stack list as "Booking / scheduling (Cal.com)".
- **`README.md`**: add `server/routes/calcom.js` to the folder-structure tree. Add `CAL_WEBHOOK_SECRET` and `CAL_BOOKING_URL` to the Environment Variables table. Add Cal.com to Tech Stack. Add a one-line entry to Key Features.
- **`ARCHITECTURE.md`**: add `POST /api/calcom/webhook` to the API route table. Add a "Cal.com" subsection under Third-Party Integrations describing webhook events handled, signature scheme, consults-table linkage, and the deferred-V2 calendar-enrichment plan. Update the `consults` table description to include `booker_name`, `booker_email`, and the unique constraint on `calcom_event_id`. Update the `clients.source` enum value list to include `'calcom'`.
- **`.env.example`**: add both new env vars with brief inline comments.

## 12. Testing strategy

**Webhook signature.** Unit test the verification function with: a valid signature (passes), a tampered body (fails), a missing header (fails), a wrong-case header (Express normalizes headers, but pin the behavior in a test). Use `node:test` to match the codebase pattern.

**Handler idempotency.** Integration test against a Postgres test instance: fire `BOOKING_CREATED` twice with the same payload, assert one consults row and one clients row. Fire `BOOKING_CREATED` for an existing-email client, assert no duplicate clients row. Fire `BOOKING_CANCELLED` before a `BOOKING_CREATED`, assert a defensive cancelled row appears.

**Proposal linkage.** Test three cases: client with one active proposal (links), client with two active proposals (links most recent), client with zero active proposals (NULL `proposal_id`).

**Completion flip.** Test the modified `drinkPlanConsult.js` route: drink plan with a past-scheduled consult (flips to completed), drink plan with a future-scheduled consult (untouched), drink plan with an already-completed consult (no-op), drink plan with no consult (no-op).

**URL surfacing.** Snapshot test the three templates with `CAL_BOOKING_URL` set and unset; confirm rendered output differs only by the consult line.

**E2E smoke (manual, post-deploy).** Configure Cal.com webhook against the deployed `/api/calcom/webhook` endpoint. Make a test booking from a non-client email. Verify a `clients` row was auto-created with `source = 'calcom'` and a `consults` row was created with `status = 'scheduled'`. Cancel the booking in Cal.com, verify the consults row flips to `cancelled`. Reschedule another test booking, verify the consults row updates rather than duplicating.

## 13. Rollout

1. Merge this spec, write the implementation plan via `/writing-plans`, execute on the `cal-com` worktree branch.
2. Set up the Cal.com hosted account (operator task, parallel): create a 15-minute consult event type, configure the booking form (name + email default, add optional phone field), connect organizer's Google Calendar, generate webhook secret.
3. Set `CAL_WEBHOOK_SECRET` in Render. Set `CAL_BOOKING_URL` in Render. Push to main; deploy.
4. Configure Cal.com webhook endpoint = `https://<api-domain>/api/calcom/webhook`, subscribe to `BOOKING_CREATED`, `BOOKING_CANCELLED`, `BOOKING_RESCHEDULED`, `BOOKING_NO_SHOW_UPDATED`. Paste the secret.
5. Run the E2E smoke (section 12). Confirm webhooks land, consults rows appear, clients auto-create.
6. Verify the three URL placeholders now render the consult line in client comms (trigger a six-months-out send manually if needed).
7. Update `CLAUDE.md`, `README.md`, `ARCHITECTURE.md`, `.env.example` per section 11.

## 14. Future work (deferred V2 and beyond)

- **Calendar-entry enrichment with drb-os links.** Once Cal.com is self-hosted on the office box, a small extension to the webhook handler writes the drb-os event URL directly into Cal.com's Postgres `booking.description` (or the relevant column on that schema version). Cal.com's normal calendar sync pushes the description into the organizer's Google Calendar event, satisfying the original "click into the event from my calendar" requirement.
- **Scheduled consult-related touches.** `scheduled_messages.entity_type` already supports `'consult'`. Examples worth considering: "consult in 1 hour" prep SMS to admin, post-consult feedback request to client. Each becomes a registered message-type handler; no schema work needed.
- **drb-os admin view for consults.** A small `/admin/consults` page if a need surfaces. Today, Cal.com's UI plus the auto-created clients view covers the access pattern.
- **Auto-merge orphan consults on manual client creation.** If admin manually creates a client whose email matches an earlier auto-created Cal.com client, optionally merge or surface a "link existing consults?" prompt.
- **Save-draft vs mark-complete split on the consult form.** Explicitly deferred from V1.
- **UNIQUE constraint on `clients.email`.** Would prevent the rare concurrent-create race in section 10. Punted until duplicate clients become a real operational problem.
- **Reschedule reason capture.** Cal.com may include `responses.rescheduleReason`; we could store it on the consults row for admin context.
