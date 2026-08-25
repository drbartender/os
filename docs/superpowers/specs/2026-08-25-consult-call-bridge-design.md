# Consult Call Bridge (Cal.com phone consults, auto-dial at the slot)

Design, 2026-08-25, **rev 2** after the six-lens design fleet (spec grounding/gaps/risk, plan fidelity/decomposition/feasibility). Brainstormed section by section with Dallas; every section was approved in chat, and the rev 2 amendments were approved as a batch ("your rec"). This document is the contract for the plan and the build.

Rev 2 changes, in one place: the webhook releases its pooled client before the post-commit tail; the tail reads the STORED booker phone; admin rings carry a ring number and every admin transition is guarded on it; the consult is re-checked before the Zul hop and at press-1; the open window has a trailing catch-up and a missed-window terminal; a too-late rule stops rings after the slot is 10 minutes gone; the client leg's non-answer is spoken and texted; kill-switch semantics are stated for in-flight chains; the invalid-number email is bounded; admin rings are 20 seconds; the lead bridge is not touched at all; copy for the text and the detail line is pinned.

## 1. Why

Cal.com consults are live: the webhook files each "Potion Planning Call" (15 minutes) into `consults`, auto-creates or links the client, and Cal.com emails the organizer and writes the Google Calendar entry. The event type asks the booker for THEIR phone number, so the organizer is expected to place the call at the slot. That is the step that gets missed: Dallas is mid-shift, mid-drive, or heads-down, and the client sits waiting for a call that never comes.

The Thumbtack lead bridge already solved the mirror problem for leads: the system rings Dallas, speaks a briefing, and press-1 bridges him to the lead. Dallas's framing: "if they call ME then I get the call." So the consult should arrive the same way an inbound call does.

## 2. Decisions (locked in brainstorm, amended in rev 2)

- **Timing.** Ring Dallas about one minute before the slot, so that pressing 1 lands the client's phone ringing at the booked time. Target `next_ring_at = scheduled_at - 90s`; on a 60-second sweep that fires between 90 and 30 seconds before the slot.
- **Chain.** Three rings to Dallas (`ADMIN_PHONE`): targets T-90s, T+60s, T+180s, **20 seconds each** (rev 2: `ADMIN_PHONE` is the 312 Google Voice number and GV voicemail picks up at about 25 seconds; a 25-second ring is a coin flip against GV "answering" the briefing into a voicemail three times per missed consult, the same reasoning that set `VM_PRIMARY_RING_SEC=18`), same briefing each time (rings 2 and 3 prefixed "Second try." / "Last try."). If all three miss, one ring to Zul (`VA_CELL`, 25 seconds, her cell has no GV hop) with a "Dallas missed" briefing. If Zul also misses, one text to Dallas with the client's number, then the chain is `missed`. No further nags.
- **Too late.** No admin ring is placed after `scheduled_at + 10 minutes`, and no Zul leg after `scheduled_at + 12 minutes`; a chain that reaches either bound terminates `failed / too_late` with the one email. A stale Twilio callback must never ring three people for a consult that is long over.
- **Caller ID on the client leg.** The 1922 (new env `CONSULT_CALLER_ID`, the company line printed on proposals) when Dallas pressed 1, so a client's callback rings through to him. The 0082 (`VOICE_CALLER_ID`) when Zul pressed 1, so a callback reaches her.
- **Agent legs** (to Dallas and to Zul) dial from `TWILIO_PHONE_NUMBER` (the 888), matching the lead bridge.
- **The number dialed is the booking's own phone**, persisted on the consult row. The client record's phone is never used: a returning client can book with a different number (Tyler Anderson, consult 21: client record 630, booking 256).
- **Consult status and the consult form are untouched.** `completed` keeps meaning "consult form submitted" (that flip drives the shopping list). The bridge writes only to its own attempt row. The webhook's own status flips (cancelled, no_show) are unchanged.
- **Approach: sibling module, not a shared engine.** The lead bridge is billed-call code that has been live and clean since July. The consult chain reuses its building blocks (`placeBridgedCall`, `cancelBridgedCall`, `toUsE164`, the fail-closed Twilio signature gate, the claim-then-call law) but owns its own table, trigger, sweep, webhook routes, and briefing helpers. **No lead bridge file is modified.** (Rev 1 planned to export `spokenEventDate`; it cannot serve here: it always appends a clock time and formats an instant in America/Chicago, while `proposals.event_date` is a DATE that node-pg returns as a Date at process-local midnight, so on a UTC host it would speak the day before.)
- **Copy pins (rev 2).** The missed text uses a clock with minutes always ("10:00 AM"); spoken briefings drop `:00` ("10 AM") for TTS. The detail line on the proposal and client pages uses the lead-call line's shape so the two lines read alike: "connected (Dallas, 4:12)", "missed", "failed", "cancelled", "skipped, bad number", "connected, no answer".

## 3. Non-goals (v1)

- No changes inside Cal.com (event type, form, workflows). The webhook payload is what it already is.
- No fallback for non-US booker numbers: they are skipped with an email (section 6), never dialed.
- No admin screen for consults or consult calls. One line on the proposal and client detail pages, failures in the existing needs-attention feed.
- No quiet-hours window for Zul's leg. Consults are booked inside Dallas's Cal.com availability; the lead bridge already rings her in that window.
- No decline digit. Pressing anything but 1 or 9 ends that ring and the chain continues; the closing text carries the number either way. (Considered in review, left out: a fourth thing to remember on a phone call.)
- No handling of other Google Calendar meetings. Cal.com consults are the only source.
- Self-hosting, branding, and embedding Cal.com are a separate project (backlog entry under "Unbuilt projects").

## 4. Architecture

### 4.1 Schema (in `server/db/schema.sql`, idempotent, applied by initDb at boot)

```sql
ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_phone TEXT;  -- raw as typed, <= 50 chars (enforced upstream by MAX_PHONE_LEN)

CREATE TABLE IF NOT EXISTS consult_call_attempts (
  id               BIGSERIAL PRIMARY KEY,
  consult_id       INTEGER NOT NULL REFERENCES consults(id) ON DELETE CASCADE,
  scheduled_at     TIMESTAMPTZ NOT NULL,      -- the slot this chain serves
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','calling_admin','calling_va',
                                       'connected','missed','failed',
                                       'skipped_cancelled','skipped_invalid_phone',
                                       'skipped_unconfigured','skipped_disabled',
                                       'skipped_missed_window')),
  admin_ring       SMALLINT NOT NULL DEFAULT 0,  -- 0 = none placed; 1..3 = last ring placed
  next_ring_at     TIMESTAMPTZ,               -- when the sweep places the next admin ring; NULL = none due
  answered_by      TEXT CHECK (answered_by IN ('admin','va')),
  admin_call_sid   TEXT,                      -- latest admin ring's SID
  va_call_sid      TEXT,
  admin_call_status TEXT,                     -- raw Twilio final status of the latest admin ring
  va_call_status   TEXT,
  bridge_started_at   TIMESTAMPTZ,
  bridge_duration_sec INTEGER,
  detail           TEXT,                      -- terse machine note: twilio code, skip reason, 'stale_reaped', 'cap_tripped', 'too_late', 'client_no_answer'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (consult_id, scheduled_at)
);
CREATE INDEX IF NOT EXISTS idx_consult_call_attempts_due ON consult_call_attempts(status, next_ring_at);
CREATE INDEX IF NOT EXISTS idx_consult_call_attempts_status_created ON consult_call_attempts(status, created_at);
```

Why `(consult_id, scheduled_at)` and not `consult_id` alone: a reschedule moves `consults.scheduled_at` in place (same row, `calcom_event_id` swapped). A chain that already opened for the old slot stays as it is, and the new slot opens its own chain. A cancel simply never opens one. Accepted edge: a consult rescheduled A to B and then back to A finds A's old row and never rings for A again (the row is `skipped_cancelled`); the delete in 4.2 deliberately does not clear it.

Ring identity (rev 2): `admin_ring` is part of every admin-leg claim. The row re-enters `calling_admin` up to three times, so a status guard alone cannot tell ring 1's late or redelivered callback from ring 2's; every admin-leg URL carries `ring=N` and every admin-leg transition adds `AND admin_ring = $ring`.

### 4.2 Webhook capture and the post-commit tail (`server/routes/calcom.js`, `server/utils/calcomWebhookHelpers.js`)

- `normalizeBooker` already extracts `phone`. `handleCreated` writes it to `consults.booker_phone`; `handleRescheduled` overwrites it with `COALESCE($new, booker_phone)` like the name and email columns. `handleCancelled` leaves it alone.
- **Tail preconditions (rev 2).** The tail runs only when a consult row was actually written or moved: in `handleCreated`, when the consults INSERT won (`rowCount === 1`; the "Already filed" fast path and the race-lost path never run it); in `handleRescheduled`, when the in-place UPDATE matched. The reschedule fallthrough into `handleCreated` reaches the tail through the create path with create semantics.
- **Pool law (rev 2).** `handleCreated` holds a `pool.connect()` client through its transaction. It must COMMIT, `client.release()` (with a `released` flag so `finally` does not double-release), and only THEN run the tail, inside the tail's own try/catch so a tail failure can never turn into a 500 that un-strands the dedupe row. This is the `thumbtack.js` "release before the post-commit tail" precedent and the CLAUDE.md one-connection-per-request invariant.
- **The tail reads the stored number (rev 2).** Both the INSERT and the UPDATE `RETURNING id, scheduled_at, booker_phone`; the tail receives those values, never the payload's phone (a reschedule payload without a phone keeps the old number via COALESCE, and evaluating the payload would file a bogus skip that blocks the new slot).
- New post-commit tail `consultCallTail({ consultId, scheduledAt, bookerPhone, triggerEvent, unresolvedOldUid })` in `server/utils/consultCallChain.js`. Never throws, bare `pool.query` only, never takes the caller's client.
  - Kill switch off (`CONSULT_CALL_ENABLED=false`): return.
  - `scheduledAt` already in the past: return (a late-arriving webhook for an old booking needs no email).
  - Phone fails `toUsE164` (or is missing): file `skipped_invalid_phone` through the shared `fileUndialable` helper (insert `ON CONFLICT DO NOTHING`, detail `no_phone` | `invalid_phone`; on `rowCount 1` send the bounded email of 5.1).
  - Phone valid AND `triggerEvent === 'BOOKING_RESCHEDULED'`: `DELETE FROM consult_call_attempts WHERE consult_id = $1 AND status IN ('skipped_invalid_phone','skipped_unconfigured')`, so a booker who fixed their number on reschedule gets the chain back. `skipped_cancelled` rows are history and stay.
  - Phone valid on create: nothing. The sweep opens the chain when the slot approaches.
  - **Reschedule fallthrough (rev 2).** When `handleRescheduled` could not resolve the old uid and fell through to `handleCreated` (the existing Sentry-warned path), Cal.com has told us the old slot is gone but we cannot name it. The tail then inserts `skipped_cancelled / rescheduled_unresolved` (`ON CONFLICT DO NOTHING`) for every OTHER `scheduled` consult with the same `booker_email` and a future `scheduled_at`, so the sweep never rings for the moved slot. Consult status is not touched (the consult row is the audit record); only the bridge declines to ring. A chain already in flight for that old slot is left to its own re-checks. This is the one path in the feature that turns a consult that WOULD have rung into one that silently will not, so when the marking stops MORE than one row (a booker who legitimately had two future consults, not just the slot they moved) it sends the 5.1 email once, reason `unresolved reschedule`. One row is the ordinary case and stays a log line.

### 4.3 The sweep (`server/utils/consultCallSweep.js`, wired in `server/index.js`)

A 60-second scheduler `consult_call_sweep`, gated by `enabled('RUN_CONSULT_CALL_SWEEP_SCHEDULER')`, wrapped in `wrapScheduler` with the same in-flight reentrancy guard as `service_extension_sweep` (reset in `finally`), on its own stagger slot (35 seconds, verified unused). Kill switch off: the tick returns `{ skipped: true }` and touches nothing. Each tick, in order:

1. **Open.** For every `consults` row with `status = 'scheduled'`, `scheduled_at` in `(NOW() - 3 minutes, NOW() + 5 minutes]` (rev 2: the trailing 3 minutes is the catch-up, so a webhook landing at T-20s, a deploy spanning the slot, or a wedged tick still rings, late), and no `consult_call_attempts` row for `(consult_id, scheduled_at)`: validate through `toUsE164` (a failure files `skipped_invalid_phone` via `fileUndialable`, the pre-deploy-booking path), else insert `status='pending', next_ring_at = scheduled_at - 90s` guarded by the rolling-24h cap in the same statement (lead bridge pattern: `INSERT ... SELECT ... WHERE (count of non-skipped rows in 24h) < cap ON CONFLICT DO NOTHING`). Cap trip: insert `failed / cap_tripped` and email once per rolling 24h (min-id dedupe, verbatim from the lead bridge).
2. **Missed window (rev 2).** For every `scheduled` consult with a valid phone, `scheduled_at` in `(NOW() - 30 minutes, NOW() - 3 minutes]`, and no row: insert `skipped_missed_window` (`ON CONFLICT DO NOTHING`) and on `rowCount 1` email reason `'missed window'` (the bridge never had a chance; Dallas needs to know the slot passed unrung). Bounded to 30 minutes back so the first deploy cannot email for history.
3. **Fire.** For every row with `status='pending' AND next_ring_at <= NOW()`, ordered by `next_ring_at, id`, at most 20 per tick: hand to `advanceChain({ attemptId, fromLeg: null })`, which owns the re-checks (4.4).

Each per-row body is try/caught so one bad row never stops the tick; the last error is rethrown at the end so `wrapScheduler` records a failed run.

Why the sweep and not `scheduled_messages`: the dispatcher is email/SMS shaped and runs on its own cadence; a billed call chain with retries wants its own claim-driven row, exactly as the lead bridge does.

### 4.4 Chain driver (`server/utils/consultCallChain.js`)

State machine, every transition a guarded `UPDATE ... WHERE id = $1 AND status = $expected` (claim winner fires the billed side effect, loser no-ops), and every admin-leg transition additionally `AND admin_ring = $ring`.

- `advanceChain({ attemptId, fromLeg: null })` (the sweep's fire step):
  1. Kill switch off: claim `pending -> skipped_disabled`, return.
  2. `guardStillScheduled`: the consult must still be `scheduled` with the same `scheduled_at`; else claim `pending -> skipped_cancelled` (detail `cancelled` | `rescheduled`), return.
  3. Too late: `NOW() > scheduled_at + 10 minutes` -> claim `pending -> failed / too_late`, email, return.
  4. Neither `ADMIN_PHONE` nor `VA_CELL` configured -> claim `pending -> skipped_unconfigured`, return.
  5. `ADMIN_PHONE` set: claim `pending -> calling_admin`, `admin_ring = admin_ring + 1`, `next_ring_at = NULL`, `RETURNING admin_ring` (guard also `admin_ring < 3`); winner places the admin leg with `ring = admin_ring` in both URLs. A `calls.create` throw is treated as that ring's terminal (`onLegTerminal` with `callStatus 'create_failed'`), so the chain moves on to the next ring's timing; it never retries the same ring.
  6. `ADMIN_PHONE` unset, `VA_CELL` set: claim `pending -> calling_va`, place the VA leg with the neutral briefing (4.6).
- `onLegTerminal({ attemptId, leg, ring, callStatus })` (from `/status` and from create-throw fallthrough): write `${leg}_call_status` (telemetry, unconditional but ring-guarded for admin). Then:
  - `leg === 'admin'`, `admin_ring < 3`: claim `calling_admin -> pending` (`AND admin_ring = $ring`), `next_ring_at = scheduled_at + (ring == 1 ? 60s : 180s)`. The sweep places the next ring on its first tick at or after that instant; a late callback sets a past `next_ring_at` and fires on the very next tick.
  - `leg === 'admin'`, `admin_ring == 3`: kill switch off -> claim `calling_admin -> skipped_disabled`; `guardStillScheduled` fails -> claim `calling_admin -> skipped_cancelled` (rev 2: the cancel re-check lives here too, not only in the sweep, because this hop bills a Manila leg); `NOW() > scheduled_at + 12 minutes` -> claim `calling_admin -> failed / too_late` + email; `VA_CELL` set -> claim `calling_admin -> calling_va`, winner places the VA leg immediately (create throw -> recurse as `va / create_failed`); `VA_CELL` unset -> if `callStatus === 'create_failed'` claim `calling_admin -> failed / create_failed` + email (rev 2: Dallas's phone never rang, so no "missed" text), else claim `calling_admin -> missed` + the missed text.
  - `leg === 'va'`: `create_failed` -> claim `calling_va -> failed` + email `'call failed'`; kill switch off -> claim `calling_va -> skipped_disabled` (no text); else claim `calling_va -> missed`, winner sends the missed text (5.2).
- `placeLeg({ attemptId, leg, ring, to })`: `placeBridgedCall({ to, callerId: TWILIO_PHONE_NUMBER, url: /api/voice/consult/answer?attempt&leg&ring&play=1, statusCallback: /api/voice/consult/status?attempt&leg&ring, timeLimit: VA_CALL_TIME_LIMIT_SEC || 1800, timeout: leg === 'admin' ? 20 : 25 })`, persist the SID (best-effort `cancelBridgedCall` if the SID cannot be persisted, exactly as the lead bridge). A throw records `create_failed` on the leg and returns false.
- `sendChainEmail({ attemptId, reason })`: one email through the admin notification category (5.1); claim winners only.
- `fileUndialable({ consultId, scheduledAt, bookerPhone })`: the one shared helper behind the tail and the sweep's open step.
- Dependency-injection seam `__setDeps` mirroring `leadCallTrigger.js` so tests never touch Twilio.

### 4.5 Twilio webhooks (`server/routes/voiceConsultCall.js`, mounted at `/api/voice/consult` BEFORE the `/api/voice` catch-all)

Signature policy: fail closed in every environment (`isValidTwilioRequest`, 403 otherwise, Sentry warning), the lead router's policy.

- `POST /answer?attempt&leg&ring&play`: load the row plus consult, client, and proposal facts; the row must be `calling_admin` with `admin_ring = ring` when `leg=admin`, or `calling_va` when `leg=va`; otherwise a polite apology and hang up ("Sorry, this consult call has expired. Goodbye."). Otherwise `<Gather numDigits=1 timeout=10 action=/digit?attempt&leg&ring&play>` wrapping `<Say>{briefing}</Say>`, one automatic repeat, `<Hangup/>` (voicemail can never press 1; the status callback drives the chain).
- `POST /digit?attempt&leg&ring&play`: `9` replays (max 3 plays); anything but `1` hangs up. `1`: validate `booker_phone` through `toUsE164` FIRST (a bad target apologizes and lets the callback advance); `guardStillScheduled` (rev 2: a cancel between rings must never dial the client; failure apologizes with "This consult was cancelled. Goodbye." and the callback terminates the chain as `skipped_cancelled`); then claim `calling_admin (AND admin_ring = ring) | calling_va -> connected`, `answered_by = leg`, `bridge_started_at = NOW()`; winner responds
  `<Dial answerOnBridge="true" callerId="{leg == admin ? CONSULT_CALLER_ID : VOICE_CALLER_ID}" timeLimit="{VA_CALL_TIME_LIMIT_SEC || 1800}" action="/api/voice/consult/dialend?attempt&leg"><Number statusCallback="/status?attempt&leg=client">{target}</Number></Dial>`.
  `CONSULT_CALLER_ID` unset or not strict E.164 falls back to `VOICE_CALLER_ID` with a boot warning (rev 2: format-checked, not just presence-checked, next to the 1a env check in `server/index.js`, so a Render typo cannot make every press-1 Dial fail at Twilio while the row sits `connected`). Attribute-value invariant from the lead router: nothing but validated integers, fixed enums, env values, and `toUsE164` output ever lands in a TwiML attribute.
- `POST /dialend?attempt&leg` (rev 2, the Dial `action`): reads `DialCallStatus`. `completed` -> `<Hangup/>` (the conversation happened). Anything else (`no-answer`, `busy`, `failed`, `canceled`) -> set `detail = 'client_no_answer'` on the `connected` row (guarded `WHERE status = 'connected' AND detail IS NULL`), the claim winner sends the client-no-answer text to Dallas (5.2), and the agent hears "They did not answer. Their number is 256-328-1203. Goodbye." then `<Hangup/>`. The row stays `connected` (it is terminal and never reaped) and the detail line renders "connected, no answer".
- `POST /status?attempt&leg&ring`: ignore non-terminal statuses. `leg=client`: record `bridge_duration_sec` from `CallDuration`. `leg=admin|va`: `onLegTerminal({ attemptId, leg, ring, callStatus })`. A leg that already pressed 1 leaves the row `connected` and every guard no-ops. Always 200 TwiML, even on internal error (Twilio retries 5xx; the claims already guard state).

### 4.6 Briefing builder (`server/utils/consultCallBriefing.js`)

Pure text; the TwiML layer escapes. Own helpers, no lead-bridge import:
- `spokenClockTime(instant)`: Chicago wall clock, "10 AM" on the hour, "10:15 AM" otherwise.
- `clockTimeWithMinutes(instant)`: "10:00 AM" always (for the text and the email).
- `spokenDateOnly(value)`: takes node-pg's DATE (a Date at local midnight; read the LOCAL calendar parts) or a `YYYY-MM-DD` string, formats "Saturday October 10th" without ever treating the value as an instant.
- `formatUsPhoneForText(e164)`: `+12563281203` -> `256-328-1203`.

Inputs: booker name, `scheduled_at`, ring number, whether the listener is Zul, whether Dallas was ever rung, and the linked proposal's `event_date`, `guest_count`, and id when a proposal is linked. Absent fields are skipped, never spoken as "unknown".

- Dallas, ring 1: "Potion planning call with Tyler Anderson, booked for 10 AM. Event Saturday October 10th, 120 guests, proposal 718. Press 1 to call them now. Press 9 to hear this again."
- Ring 2 / 3: same, prefixed "Second try." / "Last try."
- Zul after Dallas missed: "Dallas missed his potion planning call with Tyler Anderson, booked for 10 AM. Event Saturday October 10th, 120 guests, proposal 718. Press 1 to call them for him. Press 9 to hear this again."
- Zul when `ADMIN_PHONE` is unset (Dallas was never rung): "Potion planning call with Tyler Anderson, booked for 10 AM, for Dallas. Event ... Press 1 to call them for him. Press 9 to hear this again."

### 4.7 Stuck-row reaper

Rides the hourly `pruneVaCallingRows` pass in `vaCallingScheduler.js`, guarded separately like the lead reap: rows in `pending`/`calling_admin`/`calling_va` with `scheduled_at < NOW() - 30 minutes` become `failed / stale_reaped` and email once. **Kill switch off (rev 2):** the same rows become `skipped_disabled` with no email, so a deliberate stop is never reported as a system fault. A healthy chain is terminal within about 5 minutes of the slot (12 at the too-late bound), so 30 minutes never clips a live one.

## 5. Surfacing

### 5.1 Admin email (system faults, missed windows, and undialable numbers)

Category: the existing `lead_call` admin-notification category, with its settings label renamed from "Lead call failures" to "Call bridge failures" (`client/src/pages/admin/NotificationSettings.js`). No new category, no new preference key. Reasons: `call failed` (create throws, stale reap), `daily cap tripped`, `too late`, `missed window`, `undialable number`, `missed, no text destination` and `missed, text failed` (both 5.2), and `unresolved reschedule` (4.2). Never for `missed`, `skipped_cancelled` at one row, or `skipped_disabled`. Template `consultCallAdmin` in `emailTemplates.js` alongside `missedLeadCallAdmin`: booker name, slot in Chicago time, the reason, **the number always** (rev 2: formatted E.164 when valid, the raw typed string when the reason is a bad number; a failed chain is exactly the case where nobody was rung and no text went out, so the email must carry it), and both links when both exist (`View Client` and `Open Proposal`). Every attacker-typed field (name, raw number) is HTML-escaped.

**Bound on the undialable-number email (rev 2):** the booking page is public and skip rows sit outside the rolling cap, so junk bookings must not each cost a Resend send. At most ONE `undialable number` email per rolling 24 hours (the cap-trip min-id dedupe over `skipped_invalid_phone` rows); the rest surface on the attention feed only.

### 5.2 Texts to Dallas

Sent by the claim winner, from `TWILIO_PHONE_NUMBER`, to `VM_TEXT_DESTINATION` falling back to `ADMIN_PHONE` (strict E.164 check), as an internal alert the way the primary-line voicemail text is (`meta.skipLog`, no client message-ledger row; `messageType: 'consult_call_alert'`). The number is always formatted from the `toUsE164` output, never the raw column.

- Fully missed chain: "Missed consult call with Tyler Anderson at 10:00 AM. Their number is 256-328-1203."
- Client did not answer after a press-1 (4.5 `/dialend`): "Consult client did not answer: Tyler Anderson at 10:00 AM. Their number is 256-328-1203."

**No valid destination (rev 2):** if neither env value is a strict E.164 number, the `missed` transition sends the 5.1 email with reason `missed, no text destination` instead, so a fully missed consult is never invisible. `sendMissedText` returns a discriminated result (`sent` / `no_destination` / `no_attempt` / `send_failed`), not a boolean, because `sendSMS` THROWS on a Twilio failure: a send that failed is reported with its own reason, `missed, text failed`, so an outage is never described to the operator as an unset `VM_TEXT_DESTINATION`.

### 5.3 Needs-attention feed and detail pages

- `GET /api/admin/lead-call-attention` (`server/routes/admin/leadCalls.js`) gains a UNION of `consult_call_attempts` rows in `failed`/`skipped_unconfigured`/`skipped_invalid_phone`/`skipped_missed_window` from the last 7 days whose consult is still `scheduled` **and whose slot is still ahead** (`scheduled_at > NOW()`; rev 2: once the slot passes the moment is gone, the lead feed's own reasoning), shaped like the lead rows plus `kind: 'lead' | 'consult'`, aliasing `booker_name AS customer_name`. The consumer is `buildLeadCallItems` in `client/src/pages/admin/overview/queueItems.js` (fetched by `OverviewPage.js`); it keys items on `kind + id` (a bare id collides across the two tables) and titles consult rows "Consult call with Tyler Anderson call failed" / "bad number" / "call misconfigured" / "missed window". Healthy steady state stays empty.
- `server/routes/proposals/getOne.js` attaches `consult_call` (the latest attempt row joined through `consults.proposal_id`); `server/routes/clients.js` GET `/:id` attaches `consult_calls` (latest attempt per consult for that client, newest slot first, at most 10). `ProposalDetail.js` and `ClientDetail.js` render one muted line each through one shared label helper: "Consult call Aug 14, 10:00 AM: connected (Dallas, 4:12)" / "connected, no answer" / "missed" / "failed" / "cancelled" / "skipped, bad number" / "in progress". Absent rows render nothing.

## 6. Error handling and edge cases

- **Non-US or missing booker number** (Aaran's `+2482280958` is the live example): never dialed. `skipped_invalid_phone` at booking time plus the bounded email; visible in the attention feed until the slot passes.
- **Pre-deploy bookings** have no `booker_phone`. None are in the future at spec time; any that appear are handled by the sweep's open step (skip + email), no backfill.
- **Near-slot and past-slot bookings.** A webhook landing inside 90 seconds of the slot opens with `next_ring_at` already past and rings on the next tick; a slot that passed by up to 3 minutes still opens (late ring); beyond that, `skipped_missed_window` + email.
- **Cancel after the chain opened.** Re-checked before every admin ring, before the Zul hop, and at press-1; a cancel mid-chain lands `skipped_cancelled` at the next of those points. A bridge already in progress is left alone.
- **Reschedule after the chain opened.** The old slot's row ends `skipped_cancelled / rescheduled` at its next re-check (the `scheduled_at` equality); the new slot opens its own row. The unresolved-old-uid fallthrough is handled in 4.2.
- **Two consults in the same minute.** Independent chains, both ring. Dallas presses 1 on one; the other rolls to ring 2. Not special-cased.
- **Duplicate Twilio callbacks, overlapping ticks, retried webhooks, stale ring callbacks.** Every transition is a guarded claim, admin transitions are ring-guarded, and the `UNIQUE (consult_id, scheduled_at)` plus `ON CONFLICT DO NOTHING` make the open step idempotent.
- **Late callbacks.** A ring-N terminal callback arriving after the next ring's target sets `next_ring_at` in the past; the sweep fires it on the next tick, bounded by the too-late rule.
- **Twilio down / calls.create throws.** Per-leg fallthrough; chain exhaustion is `failed` with the one email. The stale reaper catches anything a crash left non-terminal.
- **Kill switch.** `CONSULT_CALL_ENABLED=false` stops the tail and the sweep; a ring already placed finishes on its own, and its callback lands the row `skipped_disabled` instead of dialing Zul or texting; parked `pending` rows are reaped to `skipped_disabled` without email. Flipping the switch back on does not resurrect a parked chain.
- **Toll-fraud and harassment posture (stated).** Agent legs dial only env-configured numbers; the client leg dials only `toUsE164` output; `timeLimit` caps every bridged leg. The trigger is a PUBLIC booking page, and the rolling cap (default 10) bounds the legs whose chains reach a COUNTED status: at most 10 rings to Manila, 10 texts and one bounded email per rolling 24h. **It does NOT bound the rings to the 312.** The cap counts `status NOT LIKE 'skipped%'`, and a chain that ends `skipped_cancelled` therefore frees its slot again, so a book, ring, cancel, rebook cycle can ring Dallas as many times as the Cal.com page has bookable slots to sell, at up to `MAX_ADMIN_RINGS` (3) twenty-second rings per opened chain. What actually bounds the admin rings is the supply of bookable slots plus `MAX_ADMIN_RINGS`, never `CONSULT_CALL_DAILY_CAP`. That is a deliberate trade, not an oversight (ruling R15): counting `skipped%` rows would let a burst of junk bookings on the public page hold the whole feature down for 24 hours past the last one, which is strictly worse than rings Dallas can decline. So nobody should raise or lower `CONSULT_CALL_DAILY_CAP` believing it is what holds the ring count down; raising it widens a public surface on the counted legs, and treat any such edit as a security change.
- **PII hygiene.** `booker_phone` is logged last-4 only, never placed in Sentry extras, and HTML-escaped wherever it lands in an email.

## 7. Testing

TDD per module, run one suite at a time from the repo root against the shared dev DB (each file carries the dotenv line; read the pass count).

- `consultCallBriefing.test.js`: clock time on and off the hour; `clockTimeWithMinutes`; a DATE-shaped `Date` on a non-Chicago-TZ box still speaks the right calendar day; string input; null on garbage; all three ring prefixes; both Zul variants; absent fields skipped with no double spaces or "unknown"; "Sarah M." does not stutter; the phone formatter.
- `emailTemplates.consultCall.test.js`: every reason in subject/html/text; the number row always present; raw string for the bad-number reason; both CTAs when both links exist; a `<script>` name is escaped.
- `consultCallChain.test.js`: tail (kill switch, past slot, invalid/no phone once across two calls, valid on reschedule clears only the two skip states, the unresolved fallthrough files `rescheduled_unresolved` for the sibling and not for the new row, a throwing pool never rejects); open (`next_ring_at` arithmetic, `exists`, cap and cap-trip email once, skips excluded from the cap); fire (re-check order: disabled, cancelled, rescheduled, too late, unconfigured; ring 1 placement shape incl. `ring=1` and `timeout 20`; admin-unset straight to VA with `timeout 25`); `onLegTerminal` (ring 1 -> pending +60s, ring 2 -> +180s, ring 3 -> VA once; **a ring-1 callback replayed during ring 2 changes nothing**; ring 3 with the consult cancelled -> `skipped_cancelled`, nothing placed; ring 3 past T+12 -> `failed / too_late` + email; `VA_CELL` unset -> `missed` + one text, or `failed` + email on `create_failed`; VA `no-answer` -> `missed` + one text, duplicate -> still one; kill switch mid-chain -> `skipped_disabled`, no leg, no text; no valid text destination -> email with reason `missed, no text destination`).
- `consultCallSweep.test.js`: window edges (+2m, +4m59s, +6m, -2m, -4m, -20m, a `cancelled` at +2m); the -4m/-20m rows file `skipped_missed_window` and email once across two ticks; fixture-scoped assertions only, header notes the query is global; fires exactly once across two ticks; kill switch `{ skipped: true }`.
- `voiceConsultCall.test.js`: signature fail-closed on every route; `/answer` states incl. ring mismatch apology; both Zul wordings; proposal details present/absent; `/digit` 1 claims with `answered_by`, per-leg caller ID and the fallback, cancelled consult apologizes without claiming, invalid number apologizes without claiming, second press apologizes; `9` replay and cap; `/dialend` `completed` hangs up silently, `no-answer` sets `client_no_answer` once and texts once under a duplicate; `/status` client duration, admin/va terminal calls `onLegTerminal` with `ring`; TwiML attributes never contain the booker name.
- `calcom.test.js` additions: `booker_phone` on create, overwritten on reschedule, kept on a phone-less reschedule, untouched on cancel; the tail is invoked once per create/reschedule with the STORED phone and the right `triggerEvent`; the tail runs after the client is released (assert via the seam that `pool.totalCount`/`idleCount` shows the client back, or that a tail throw still yields 200 and leaves the dedupe row in place).
- `vaCallingScheduler.test.js`: consult reaper, both switch states.
- `leadCalls.test.js`, `getOne.consultCall.test.js` (new, the `getOne.leadCall.test.js` pattern), a clients `GET /:id` case, `consultCallLookups.test.js`, `queueItems.test.js`, `consultCallLabel.test.js`.

Suites the change reaches (grep callers before running): `calcom.test.js`, `vaCallingScheduler.test.js`, `getOne.leadCall.test.js`, `clients.list.test.js`, `leadCalls.test.js`, `queueItems.test.js`. The `index.js` mount order is proven by the unsigned-POST-returns-403 dev check, not by `voice.test.js` (which mounts only its own router).

## 8. Rollout and launch gate

Sensitive paths (billed voice + the Cal.com webhook): full 5-agent fleet at each lane merge and again at push, plus `/second-opinion`.

In order, one sitting:

1. **Before the push**, in Render: `CONSULT_CALL_ENABLED=false` (the switch defaults ON; the lead bridge's push-order trap), `CONSULT_CALLER_ID=+12242221922`. Confirm `ADMIN_PHONE`, `VA_CELL`, `VOICE_CALLER_ID`, `VM_TEXT_DESTINATION`, `TWILIO_PHONE_NUMBER` are still set.
2. Push. initDb applies the column and the table; the sweep boots and finds nothing to do. The boot log must not show the `[consultCall]` caller-ID warning.
3. Flip `CONSULT_CALL_ENABLED` on (delete the var or set anything but `false`).
4. **Launch gate (Dallas):** confirm the Cal.com event type's minimum booking notice allows a slot a few minutes out (lower it for the test if not), then book a 15-minute slot on his own Cal.com page with a phone that is NOT his own cell and is not the 312 (which forwards to it), because `ADMIN_PHONE` is the 970 itself and both legs would otherwise land on one handset. Expect: the 970 rings between 90 and 30 seconds before the slot, the briefing speaks his own name and the slot time, press 1, the 970 rings showing the 1922, two-way audio, and the attempt row reads `connected / admin / duration > 0`. Then cancel that booking in Cal.com (the consult goes `cancelled`; the test client row can be deleted by hand).
5. First-week watch: any `failed` rows (`too_late`, `stale_reaped`, `create_failed`), any `skipped_missed_window`, any `connected` row with `client_no_answer` or near-zero `bridge_duration_sec`.

Nothing changes in Cal.com itself.

## 9. Config and documentation

New env (`.env.example`, `README.md` env table, `.claude/CLAUDE.md` env table):

- `CONSULT_CALL_ENABLED`: kill switch; only the literal `false` disables (tail + sweep + the callback branches that would dial Zul or text).
- `CONSULT_CALL_DAILY_CAP`: max chains opened per rolling 24h, default 10; also the public-surface ceiling (section 6).
- `CONSULT_CALLER_ID`: strict E.164, the 1922; caller ID on the client leg when Dallas answered. Unset or malformed falls back to `VOICE_CALLER_ID` with a boot warning.
- `RUN_CONSULT_CALL_SWEEP_SCHEDULER`: scheduler gate, default on in prod like its siblings; a bare `RUN_CONSULT_CALL_SWEEP_SCHEDULER=` line in `.env.example` like the others.

Docs: `ARCHITECTURE.md` (Cal.com section gains the capture + tail + release-before-tail note; a "Consult Call Bridge" route subsection beside the lead bridge; `consults.booker_phone` and the new table in the schema section, with the scheduler and reaper described there since ARCHITECTURE has no separate scheduler list; the attention route, proposals `GET /:id`, and clients `GET /:id` rows), `README.md` tree entries for the new files and the env rows, the `NotificationSettings` label rename noted. Backlog (`docs/fix-list-remaining-2026-07-02.md`): the Cal.com V2 entry already exists; this feature's launch gate goes in `docs/walkthroughs-owed.md` at merge time (a quick-fix commit on main, outside both lane footprints).

## 10. Sensitive-path note for the build

Billed outbound voice, client PII spoken aloud, a public webhook tail. The build lane must: keep every transition a guarded claim (ring-guarded on the admin leg); never interpolate free text into a TwiML attribute; validate the dial target at open time AND at dial time; re-check the consult before the Zul hop and at press-1; keep the tail non-throwing, post-release, and post-commit; and add BY NAME to `scripts/sensitive-paths.txt` (no existing glob matches them): `server/routes/voiceConsultCall.js`, `server/utils/consultCallChain.js`, `server/utils/consultCallSweep.js`, `server/utils/consultCallBriefing.js`, and `server/utils/calcomWebhookHelpers.js` (its phone extraction is now a dial target).
