# Consult Call Bridge (Cal.com phone consults, auto-dial at the slot)

Design, 2026-08-25. Brainstormed section by section with Dallas; every section below was approved in chat, so this document is the contract for the plan and the build.

## 1. Why

Cal.com consults are live: the webhook files each "Potion Planning Call" (15 minutes) into `consults`, auto-creates or links the client, and Cal.com emails the organizer and writes the Google Calendar entry. The event type asks the booker for THEIR phone number, so the organizer is expected to place the call at the slot. That is the step that gets missed: Dallas is mid-shift, mid-drive, or heads-down, and the client sits waiting for a call that never comes.

The Thumbtack lead bridge already solved the mirror problem for leads: the system rings Dallas, speaks a briefing, and press-1 bridges him to the lead. Dallas's framing: "if they call ME then I get the call." So the consult should arrive the same way an inbound call does.

## 2. Decisions (locked in brainstorm)

- **Timing.** Ring Dallas about one minute before the slot, so that pressing 1 lands the client's phone ringing at the booked time. Target `next_ring_at = scheduled_at - 90s`; on a 60-second sweep that fires between 90 and 30 seconds before the slot.
- **Chain.** Three rings to Dallas (`ADMIN_PHONE`): targets T-90s, T+60s, T+180s, 25 seconds each, same briefing each time (rings 2 and 3 prefixed "Second try" / "Last try"). If all three miss, one ring to Zul (`VA_CELL`) with a "Dallas missed" briefing. If Zul also misses, one text to Dallas with the client's number, then the chain is `missed`. No further nags.
- **Caller ID on the client leg.** The 1922 (new env `CONSULT_CALLER_ID`, the company line printed on proposals) when Dallas pressed 1, so a client's callback rings through to him. The 0082 (`VOICE_CALLER_ID`) when Zul pressed 1, so a callback reaches her.
- **Agent legs** (to Dallas and to Zul) dial from `TWILIO_PHONE_NUMBER` (the 888), matching the lead bridge.
- **The number dialed is the booking's own phone**, persisted on the consult row. The client record's phone is never used: a returning client can book with a different number (Tyler Anderson, consult 21: client record 630, booking 256).
- **Consult status and the consult form are untouched.** `completed` keeps meaning "consult form submitted" (that flip drives the shopping list). The bridge writes only to its own attempt row.
- **Approach: sibling module, not a shared engine.** The lead bridge is billed-call code that has been live and clean since July. The consult chain reuses its building blocks (`placeBridgedCall`, `cancelBridgedCall`, `toUsE164`, the spoken-date formatter, the fail-closed Twilio signature gate, the claim-then-call law) but owns its own table, trigger, sweep, and webhook routes. The lead bridge's only change is exporting `spokenEventDate` from `leadCallBriefing.js`.

## 3. Non-goals (v1)

- No changes inside Cal.com (event type, form, workflows). The webhook payload is what it already is.
- No fallback for non-US booker numbers: they are skipped with an email (section 6), never dialed.
- No admin screen for consults or consult calls. One line on the proposal and client detail pages, failures in the existing needs-attention feed.
- No quiet-hours window for Zul's leg. Consults are booked inside Dallas's Cal.com availability; the lead bridge already rings her in that window.
- No handling of other Google Calendar meetings. Cal.com consults are the only source.
- Self-hosting, branding, and embedding Cal.com are a separate project (backlog entry added with this spec).

## 4. Architecture

### 4.1 Schema (in `server/db/schema.sql`, idempotent, applied by initDb at boot)

```sql
ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_phone TEXT;  -- raw as typed, <= 50 chars

CREATE TABLE IF NOT EXISTS consult_call_attempts (
  id               BIGSERIAL PRIMARY KEY,
  consult_id       INTEGER NOT NULL REFERENCES consults(id) ON DELETE CASCADE,
  scheduled_at     TIMESTAMPTZ NOT NULL,      -- the slot this chain serves
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','calling_admin','calling_va',
                                       'connected','missed','failed',
                                       'skipped_cancelled','skipped_invalid_phone',
                                       'skipped_unconfigured')),
  admin_ring       SMALLINT NOT NULL DEFAULT 0,  -- 0 = none placed; 1..3 = last ring placed
  next_ring_at     TIMESTAMPTZ,               -- when the sweep places the next admin ring; NULL = none due
  answered_by      TEXT CHECK (answered_by IN ('admin','va')),
  admin_call_sid   TEXT,                      -- latest admin ring's SID
  va_call_sid      TEXT,
  admin_call_status TEXT,                     -- raw Twilio final status of the latest admin ring
  va_call_status   TEXT,
  bridge_started_at   TIMESTAMPTZ,
  bridge_duration_sec INTEGER,
  detail           TEXT,                      -- terse machine note: twilio code, skip reason, 'stale_reaped', 'cap_tripped'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (consult_id, scheduled_at)
);
CREATE INDEX IF NOT EXISTS idx_consult_call_attempts_due ON consult_call_attempts(status, next_ring_at);
CREATE INDEX IF NOT EXISTS idx_consult_call_attempts_status_created ON consult_call_attempts(status, created_at);
```

Why `(consult_id, scheduled_at)` and not `consult_id` alone: a reschedule moves `consults.scheduled_at` in place (same row, same `calcom_event_id` swap). A chain that already opened for the old slot stays as it is, and the new slot opens its own chain. A cancel simply never opens one.

### 4.2 Webhook capture and the post-commit tail (`server/routes/calcom.js`, `server/utils/calcomWebhookHelpers.js`)

- `normalizeBooker` already extracts `phone`. `handleCreated` writes it to `consults.booker_phone`; `handleRescheduled` overwrites it (`COALESCE($new, booker_phone)` like the name and email columns). The `handleCancelled` upsert leaves it alone.
- New post-commit tail `consultCallTail({ consultId, scheduledAt, bookerPhone, triggerEvent })` in `server/utils/consultCallChain.js`, called after `COMMIT` in `handleCreated` and after the in-place `UPDATE` in `handleRescheduled`. Never throws, bare `pool.query` only, and it must not change the webhook's 200/503 semantics (lead bridge tail law).
  - Phone fails `toUsE164` (or is missing): insert `consult_call_attempts (consult_id, scheduled_at, status='skipped_invalid_phone', detail='no_phone'|'invalid_phone') ON CONFLICT DO NOTHING`; on `rowCount 1` send the one email (section 5.1) so Dallas knows to call by hand. Skipped only when `scheduled_at` is already in the past (a late-arriving webhook for an old booking needs no email).
  - Phone valid AND the event is a reschedule: `DELETE FROM consult_call_attempts WHERE consult_id = $1 AND status LIKE 'skipped_%'`, so a booker who fixed their number on reschedule gets the chain back (the sweep re-opens it).
  - Phone valid on create: nothing. The sweep opens the chain when the slot approaches.
- Kill switch `CONSULT_CALL_ENABLED=false` silences the tail as well as the sweep.

### 4.3 The sweep (`server/utils/consultCallSweep.js`, wired in `server/index.js`)

A 60-second scheduler `consult_call_sweep`, gated by `enabled('RUN_CONSULT_CALL_SWEEP_SCHEDULER')`, wrapped in `wrapScheduler` with the same in-flight reentrancy guard as `service_extension_sweep`, on its own stagger slot (pick one no sibling uses; document the choice in the code comment as the siblings do). Each tick, in order:

1. **Open.** For every `consults` row with `status = 'scheduled'`, `booker_phone` valid through `toUsE164`, `scheduled_at` in `(NOW(), NOW() + 5 minutes]`, and no `consult_call_attempts` row for `(consult_id, scheduled_at)`: insert `status='pending', next_ring_at = scheduled_at - 90s`, guarded by the rolling-24h cap in the same statement (lead bridge pattern: `INSERT ... SELECT ... WHERE (count of non-skipped rows in 24h) < cap ON CONFLICT DO NOTHING`). Cap trip: insert `failed / cap_tripped` and email once per rolling 24h (min-id dedupe, verbatim from the lead bridge). A `booker_phone` that fails validation here (no tail ran, pre-deploy booking) inserts `skipped_invalid_phone` and emails, same as the tail.
2. **Fire.** For every row with `status='pending' AND next_ring_at <= NOW()`: re-check the consult is still `scheduled` with the same `scheduled_at` (else claim `pending -> skipped_cancelled`); check `ADMIN_PHONE` or `VA_CELL` configured (else `skipped_unconfigured`); then hand to `advanceChain({ attemptId, fromLeg: null })`.

Why the sweep and not `scheduled_messages`: the dispatcher is email/SMS shaped and runs on its own cadence; a billed call chain with retries wants its own claim-driven row, exactly as the lead bridge does.

### 4.4 Chain driver (`server/utils/consultCallChain.js`)

State machine, every transition a guarded `UPDATE ... WHERE id = $1 AND status = $expected` (claim winner fires the billed side effect, loser no-ops):

- `advanceChain({ attemptId, fromLeg: null })`: claim `pending -> calling_admin`, `admin_ring = admin_ring + 1`, `next_ring_at = NULL`; place the admin leg (`placeLeg`, below). If `ADMIN_PHONE` is unset, go straight to the VA branch.
- Admin leg terminal without a press-1 (status callback, section 4.5): record `admin_call_status`; if `admin_ring < 3`, claim `calling_admin -> pending` and set `next_ring_at = scheduled_at + (admin_ring == 1 ? 60s : 180s)`; the sweep places the next ring on its first tick at or after that (a callback arriving after that instant fires on the very next tick). If `admin_ring == 3`, claim `calling_admin -> calling_va` and place the VA leg immediately (inside the callback, as the lead bridge does), or, with `VA_CELL` unset, claim `calling_admin -> missed` and send the missed text.
- VA leg terminal without a press-1: claim `calling_va -> missed`, send the missed text (section 5.2).
- `placeLeg({ attemptId, leg, to })`: `placeBridgedCall({ to, callerId: TWILIO_PHONE_NUMBER, url: /api/voice/consult/answer?attempt&leg&play=1, statusCallback: /api/voice/consult/status?attempt&leg, timeLimit, timeout: 25 })`, persist the SID (best-effort `cancelBridgedCall` if the SID cannot be persisted, exactly as the lead bridge). A `calls.create` throw records `create_failed` on the leg and falls through: admin ring N failing to place counts as that ring (the chain moves on, it does not retry the same ring), and the chain exhausting on throws terminates `failed` with the one failure email.
- `sendChainEmail({ attemptId, reason })`: one email through the admin notification category (section 5.1); claim winners only.
- Dependency-injection seam `__setDeps` mirroring `leadCallTrigger.js` so tests never touch Twilio.

### 4.5 Twilio webhooks (`server/routes/voiceConsultCall.js`, mounted at `/api/voice/consult` BEFORE the `/api/voice` catch-all)

Signature policy: fail closed in every environment (`isValidTwilioRequest`, 403 otherwise, Sentry warning), the lead router's policy.

- `POST /answer?attempt&leg&play`: load the row plus consult, client, and proposal facts; if the row is not `calling_admin`/`calling_va`, speak a polite apology and hang up. Otherwise `<Gather numDigits=1 timeout=10 action=/digit>` wrapping `<Say>{briefing}</Say>`, one automatic repeat, `<Hangup/>` (voicemail can never press 1; the status callback drives the chain).
- `POST /digit?attempt&leg&play`: `9` replays (max 3 plays); anything but `1` hangs up. `1`: validate `booker_phone` through `toUsE164` FIRST (a bad target apologizes and lets the callback advance), then claim `calling_admin|calling_va -> connected`, `answered_by = leg`, `bridge_started_at = NOW()`; then `<Dial answerOnBridge="true" callerId="{leg == admin ? CONSULT_CALLER_ID : VOICE_CALLER_ID}" timeLimit="{VA_CALL_TIME_LIMIT_SEC || 1800}"><Number statusCallback="/status?attempt&leg=client">{target}</Number></Dial>`. `CONSULT_CALLER_ID` unset falls back to `VOICE_CALLER_ID` with a startup warning (the same warning shape `server/index.js` prints for the 1a env). Attribute-value invariant from the lead router: nothing but validated integers, fixed enums, env values, and `toUsE164` output ever lands in a TwiML attribute.
- `POST /status?attempt&leg`: ignore non-terminal statuses. `leg=client`: record `bridge_duration_sec` from `CallDuration`. `leg=admin|va`: record the raw status, then advance per section 4.4. A leg that already pressed 1 leaves the row `connected` and every guard no-ops. Always 200 TwiML, even on internal error (Twilio retries 5xx; the claims already guard state).

### 4.6 Briefing builder (`server/utils/consultCallBriefing.js`)

Pure text; the TwiML layer escapes. Inputs: booker name, `scheduled_at`, ring number, whether the listener is Zul, and the linked proposal's `event_date` and `guest_count` when a proposal is linked. Absent fields are skipped, never spoken as "unknown". Spoken date via `spokenEventDate` exported from `leadCallBriefing.js` (Chicago wall clock; a DATE column is spoken without a time).

- Dallas, ring 1: "Potion planning call with Tyler Anderson, booked for 10 AM. Event Saturday October 10th, 120 guests, proposal 718. Press 1 to call them now. Press 9 to hear this again."
- Ring 2 / 3: same, prefixed "Second try." / "Last try."
- Zul: "Dallas missed his potion planning call with Tyler Anderson, booked for 10 AM. Press 1 to call them for him. Press 9 to hear this again."

### 4.7 Stuck-row reaper

Rides the hourly `pruneVaCallingRows` pass in `vaCallingScheduler.js`, guarded separately like the lead reap: rows in `pending`/`calling_admin`/`calling_va` with `scheduled_at < NOW() - 30 minutes` become `failed / stale_reaped` and email once. A healthy chain is terminal within about 5 minutes of the slot, so 30 minutes never clips a live one.

## 5. Surfacing

### 5.1 Admin email (system faults and undialable numbers only)

Category: the existing `lead_call` admin-notification category, with its settings label renamed from "Lead call failures" to "Call bridge failures" (`client/src/pages/admin/NotificationSettings.js`). No new category, no new preference key. Sent for: `failed` (create throws, cap trip, stale reap) and `skipped_invalid_phone` (at booking time). Never for `missed` or `skipped_cancelled`. Template `consultCallAdmin` in `emailTemplates.js` alongside `missedLeadCallAdmin`: booker name, slot in Chicago time, the reason, the raw number when the reason is a bad number, links to the client and proposal when linked.

### 5.2 Missed text to Dallas

Exactly one SMS per fully-missed chain, sent by the claim winner of the `missed` transition: "Missed consult call with Tyler Anderson at 10:00 AM. Their number is 256-328-1203." Destination `VM_TEXT_DESTINATION` (the established "text Dallas" target), falling back to `ADMIN_PHONE`; from `TWILIO_PHONE_NUMBER`; sent as an internal alert the way the primary-line voicemail text is (no client message-ledger row). Cost is one SMS per missed consult, accepted in brainstorm.

### 5.3 Needs-attention feed and detail pages

- `GET /api/admin/lead-call-attention` (`server/routes/admin/leadCalls.js`) gains a UNION of `consult_call_attempts` rows in `failed`/`skipped_unconfigured`/`skipped_invalid_phone` from the last 7 days whose consult is still `scheduled`, shaped like the lead rows (`kind: 'consult'`), so the Sales-tab item renders both with a per-kind label. Healthy steady state stays empty.
- `server/routes/proposals/getOne.js` attaches `consult_call` (the latest attempt row joined through `consults.proposal_id`); `server/routes/clients.js` getOne attaches `consult_calls` (latest attempt per consult for that client). `ProposalDetail.js` and `ClientDetail.js` render one muted line each: "Consult call Aug 14, 10:00 AM: connected 4m 12s (Dallas)" / "missed" / "failed" / "skipped, bad number". Absent rows render nothing.

## 6. Error handling and edge cases

- **Non-US or missing booker number** (Aaran's `+2482280958` is the live example): never dialed. `skipped_invalid_phone` at booking time plus the one email; visible in the attention feed until the consult leaves `scheduled`.
- **Pre-deploy bookings** have no `booker_phone`. None are in the future at spec time; any that appear are handled by the sweep's open step (skip + email), no backfill.
- **Cancel after the chain opened.** The fire step re-checks the consult before every admin ring and before the VA leg; a cancel mid-chain lands `skipped_cancelled` at the next placement. A bridge already in progress is left alone.
- **Reschedule after the chain opened.** The old slot's row runs or ends on its own; the fire step's `scheduled_at` equality check stops it (`skipped_cancelled`, detail `rescheduled`) as soon as the consult's slot no longer matches. The new slot opens its own row.
- **Two consults in the same minute.** Independent chains, both ring. Dallas presses 1 on one; the other rolls to ring 2. Not special-cased.
- **Duplicate Twilio callbacks, overlapping ticks, retried webhooks.** Every transition is a guarded claim; the `UNIQUE (consult_id, scheduled_at)` plus `ON CONFLICT DO NOTHING` make the open step idempotent.
- **Late callbacks.** A ring-N terminal callback arriving after the next ring's target instant sets `next_ring_at` in the past; the sweep fires it on the next tick. Order is preserved by `admin_ring`.
- **Twilio down / calls.create throws.** Per-leg fallthrough; chain exhaustion is `failed` with the one email. The stale reaper catches anything a crash left non-terminal.
- **Kill switch mid-chain.** `CONSULT_CALL_ENABLED=false` stops the tail and the sweep from opening or firing; an in-flight leg finishes on its own. Same semantics as the lead bridge.
- **Toll-fraud posture.** Agent legs dial only env-configured numbers; the client leg dials only `toUsE164` output; the cap (default 10 per rolling 24h) bounds spend if the Cal.com secret ever leaks; `timeLimit` caps every bridged leg.

## 7. Testing

TDD per module, run one suite at a time from the repo root against the shared dev DB (each file carries the dotenv line; read the pass count).

- `consultCallSweep.test.js`: window selection (`(NOW, NOW+5m]`), idempotence on `(consult_id, scheduled_at)`, cap and cap-trip email once, kill switch, reschedule and cancel between ticks (`skipped_cancelled` with the right detail), unconfigured skip, invalid-phone open-step skip + email.
- `consultCallChain.test.js`: ring 1 -> 2 -> 3 -> VA -> missed + one text under duplicate callbacks (each transition once), `next_ring_at` arithmetic, create-throw fallthrough on each leg, exhaustion `failed` emails once, `VA_CELL` unset goes `missed` from ring 3, tail behavior (invalid phone insert + email once; valid phone on reschedule clears skipped rows; past slot no email; kill switch).
- `voiceConsultCall.test.js`: signature fail-closed in every env, `/answer` TwiML and apology states, `/digit` 1/9/other, validate-before-claim, per-leg caller ID (`CONSULT_CALLER_ID` vs `VOICE_CALLER_ID`, and the fallback), `/status` duration record and advance, attribute-value invariant.
- `consultCallBriefing.test.js`: all three variants, absent fields skipped, DATE spoken without a time.
- `calcom.test.js` additions: `booker_phone` written on create, overwritten on reschedule, untouched on cancel; the tail runs post-commit and a tail throw never changes the response.
- `vaCallingScheduler.test.js` addition: consult reaper.
- `leadCalls` attention route, `proposals/getOne`, `clients` getOne: the new fields.
- `emailTemplates.consultCall.test.js`: template wire shape.

Suites the change reaches (grep callers before running): `calcom.test.js`, `leadCallBriefing.test.js` (export change), `vaCallingScheduler.test.js`, `voice.test.js` (mount order), the proposals getOne and clients suites.

## 8. Rollout and launch gate

Sensitive paths (billed voice + the Cal.com webhook): full 5-agent fleet at lane merge and again at push, plus `/second-opinion`.

In order, one sitting:

1. **Before the push**, in Render: `CONSULT_CALL_ENABLED=false` (the switch defaults ON; the lead bridge's push-order trap), `CONSULT_CALLER_ID=+12242221922`. Confirm `ADMIN_PHONE`, `VA_CELL`, `VOICE_CALLER_ID`, `VM_TEXT_DESTINATION` are still set.
2. Push. initDb applies the column and the table; the sweep boots and finds nothing to do.
3. Flip `CONSULT_CALL_ENABLED` on (delete the var or set anything but `false`).
4. **Launch gate (Dallas):** book a 15-minute slot on his own Cal.com page a few minutes out with the 970 as the number. Expect: the 312 rings between 90 and 30 seconds before the slot, the briefing speaks his own name, press 1, the 970 rings showing the 1922, two-way audio, the attempt row shows `connected` with a duration. Then cancel that booking in Cal.com (the consult goes `cancelled`; the client row from the test booking can be deleted by hand).
5. First-week watch: any `failed`/`stale_reaped` rows, any `connected` row with near-zero `bridge_duration_sec`.

Nothing changes in Cal.com itself.

## 9. Config and documentation

New env (`.env.example`, `README.md` env table, `.claude/CLAUDE.md` env table):

- `CONSULT_CALL_ENABLED`: kill switch; only the literal `false` disables (tail + sweep).
- `CONSULT_CALL_DAILY_CAP`: max chains opened per rolling 24h, default 10.
- `CONSULT_CALLER_ID`: strict E.164, the 1922; caller ID on the client leg when Dallas answered. Unset falls back to `VOICE_CALLER_ID` with a startup warning.
- `RUN_CONSULT_CALL_SWEEP_SCHEDULER`: scheduler gate, default on in prod like its siblings.

Docs: `ARCHITECTURE.md` (Cal.com section gains the capture + tail; a "Consult call bridge" subsection beside the lead bridge; `consults.booker_phone` and the new table in the schema section; the new routes in the route table), `README.md` tree entries for the new files, `NotificationSettings` label rename noted. Backlog (`docs/fix-list-remaining-2026-07-02.md`): one entry for the Cal.com self-host + branding + embed project, and this feature's owed launch gate in `docs/walkthroughs-owed.md`.

## 10. Sensitive-path note for the build

Billed outbound voice, client PII spoken aloud, a public webhook tail. The build lane must: keep every transition a guarded claim; never interpolate free text into a TwiML attribute; validate the dial target at trigger time AND at dial time; keep the tail non-throwing and post-commit; add the new voice surfaces to `sensitive-paths.txt`.
