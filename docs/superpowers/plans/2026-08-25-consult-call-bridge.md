---
spec: docs/superpowers/specs/2026-08-25-consult-call-bridge-design.md
lanes:
  - id: consult-call-core
    footprint:
      - server/db/schema.sql                        # consults.booker_phone + consult_call_attempts (spec 4.1)
      - server/utils/calcomWebhookHelpers.js        # no change expected; listed because C6 reads extractPhone
      - server/routes/calcom.js                     # booker_phone capture + post-commit tail (spec 4.2)
      - server/routes/calcom.test.js                # exists: extend
      - server/utils/consultCallBriefing.js         # new: pure spoken briefing + date/time helpers (spec 4.6)
      - server/utils/consultCallBriefing.test.js
      - server/utils/consultCallChain.js            # new: tail, open, claim-then-call chain driver, email, missed text (spec 4.2, 4.4)
      - server/utils/consultCallChain.test.js
      - server/utils/consultCallSweep.js            # new: 60s open + fire sweep (spec 4.3)
      - server/utils/consultCallSweep.test.js
      - server/routes/voiceConsultCall.js           # new: /api/voice/consult/{answer,digit,status} (spec 4.5)
      - server/routes/voiceConsultCall.test.js
      - server/utils/emailTemplates.js              # consultCallAdmin template (additive)
      - server/utils/emailTemplates.consultCall.test.js
      - server/utils/vaCallingScheduler.js          # stale reaper rides the hourly pass (spec 4.7)
      - server/utils/vaCallingScheduler.test.js     # exists: extend
      - server/index.js                             # mount + scheduler + CONSULT_CALLER_ID boot warning
      - scripts/sensitive-paths.txt
      - .env.example
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
    blockedBy: []
    review: full-fleet   # billed outbound voice + Twilio webhook surface + Cal.com webhook tail; sensitive
  - id: consult-call-surfacing
    footprint:
      - server/routes/admin/leadCalls.js            # UNION consult fault rows (spec 5.3)
      - server/routes/admin/leadCalls.test.js       # exists: extend
      - server/utils/consultCallLookups.js          # new: latest-attempt lookups for proposal + client detail
      - server/utils/consultCallLookups.test.js
      - server/routes/proposals/getOne.js           # consult_call field
      - server/routes/clients.js                    # consult_calls field on GET /:id
      - client/src/utils/consultCallLabel.js        # new: shared outcome + slot labels
      - client/src/utils/consultCallLabel.test.js
      - client/src/pages/admin/overview/queueItems.js   # buildLeadCallItems handles kind='consult'
      - client/src/pages/admin/overview/queueItems.test.js  # exists if present: extend, else create
      - client/src/pages/admin/ProposalDetail.js    # one line
      - client/src/pages/admin/ClientDetail.js      # one line per consult
      - client/src/pages/admin/NotificationSettings.js  # label rename
      - README.md
      - ARCHITECTURE.md
    blockedBy: [consult-call-core]
    review: full-fleet   # touches proposals getOne + clients getOne + an admin endpoint
---

# Consult Call Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** this repo executes plans through the lane model (CLAUDE.md): one worktree lane per lane id (`npm run worktree:new -- <lane>`), checkpoint commits in-lane, squash merge to main via `scripts/merge-lane.sh`. Run order (encoded in blockedBy): `consult-call-core`, then `consult-call-surfacing`. Both lanes touch README/ARCHITECTURE; the second to merge resolves the trivial doc conflict. On lane cut, append the board line with `scripts/board-write.sh "In flight" "..."`. The Launch checklist is NOT a lane: Dallas-driven ops steps gating go-live.
> **Deviation from the spec, recorded here:** spec section 2 says the lead bridge's only change is exporting `spokenEventDate`. Not needed: the consult briefing wants a bare clock time for the slot and a date-only rendering for `proposals.event_date` (a DATE column, which node-pg returns as a Date at LOCAL midnight; formatting that instant in America/Chicago on a UTC box would speak the day before). So `consultCallBriefing.js` carries its own two helpers and the lead bridge files are untouched. Everything else in the spec stands.

**Goal:** At each Cal.com consult slot, ring Dallas with a spoken briefing (three tries), then Zul, and let press-1 bridge whoever answered to the booker's own phone, with a text to Dallas if everyone missed.

**Architecture:** The Cal.com webhook persists `consults.booker_phone` and runs a never-throwing post-commit tail that files undialable numbers. A 60-second sweep opens one `consult_call_attempts` row per upcoming slot (`next_ring_at = scheduled_at - 90s`) and fires due rows through a claim-then-call chain driver; Twilio status callbacks (`/api/voice/consult/*`, signature fail-closed everywhere) advance rings 1 to 3, then the VA leg, then `missed` + one SMS. Press 1 claims `connected` and `<Dial>`s the booker from the 1922 (Dallas) or the 0082 (Zul). An hourly reaper fails anything stranded.

**Tech Stack:** Express + raw parameterized SQL (`pool.query`), Twilio Programmable Voice TwiML via the existing gated `placeBridgedCall`/`sendSMS`, React 18 CRA, `node:test` with `__setDeps` stubs against the shared dev DB.

**Spec:** `docs/superpowers/specs/2026-08-25-consult-call-bridge-design.md`

## Global Constraints

- Raw SQL only, parameterized; schema changes idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`); initDb replays `schema.sql` every boot, so every block must be re-runnable.
- API JSON keys snake_case; JS camelCase. Client API calls via `client/src/utils/api.js` only.
- Voice endpoints return TwiML or 403, never stack traces, never a 5xx to Twilio.
- Post-commit tail law: `consultCallTail` never throws to the webhook, never takes the caller's pooled client, uses bare `pool.query()`.
- Claim-then-call: every billed or notifying side effect (`calls.create`, the failure email, the missed SMS) fires only when its guarded `UPDATE` returned `rowCount === 1`.
- Dial-target law: the client leg dials ONLY `toUsE164(booker_phone)` output, validated at open time (sweep/tail) AND at press-1 time. Agent legs dial ONLY `ADMIN_PHONE` / `VA_CELL` env values verbatim.
- TwiML attribute-value invariant: only validated integers, fixed enums, env values, and `toUsE164` output ever land in an attribute; free text goes through `xmlEscape` in element text only.
- Phone logging: last-4 redaction (`String(p).slice(-4)`).
- Ring plan constants (code, not env): `RING_OFFSETS_SEC = { 1: -90, 2: 60, 3: 180 }` relative to `scheduled_at`, `MAX_ADMIN_RINGS = 3`, `AGENT_RING_SECONDS = 25`, `OPEN_AHEAD_MINUTES = 5`, `STALE_MINUTES = 30`.
- Daily cap: `dailyCap()` = `parseInt(process.env.CONSULT_CALL_DAILY_CAP, 10) || 10` (the `|| 10` fallback is load-bearing: unset must not become `count < NaN`).
- Kill switch: `process.env.CONSULT_CALL_ENABLED === 'false'` silences the tail AND the sweep. Default on.
- Instants, not dates: every time comparison in SQL uses `NOW()` against `TIMESTAMPTZ` columns. Never `CURRENT_DATE`.
- No em dashes in any spoken, texted, or emailed copy.
- Suites run ONE AT A TIME from the repo root (`node --test server/path/file.test.js`); every new test file starts with `require('dotenv').config();`. Read the pass count.

## Lane consult-call-core

- [ ] C1. **Schema.** Append to `server/db/schema.sql` directly after the `consults` index block (the `idx_consults_scheduled_at` line):
  ```sql
  -- Consult call bridge (spec 2026-08-25 section 4.1). booker_phone is the number the
  -- booker typed into Cal.com, raw; it is the ONLY number the bridge ever dials
  -- (a returning client can book with a different phone than their client row).
  ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_phone TEXT;

  CREATE TABLE IF NOT EXISTS consult_call_attempts (
    id               BIGSERIAL PRIMARY KEY,
    consult_id       INTEGER NOT NULL REFERENCES consults(id) ON DELETE CASCADE,
    scheduled_at     TIMESTAMPTZ NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','calling_admin','calling_va',
                                         'connected','missed','failed',
                                         'skipped_cancelled','skipped_invalid_phone',
                                         'skipped_unconfigured')),
    admin_ring       SMALLINT NOT NULL DEFAULT 0,
    next_ring_at     TIMESTAMPTZ,
    answered_by      TEXT CHECK (answered_by IN ('admin','va')),
    admin_call_sid   TEXT,
    va_call_sid      TEXT,
    admin_call_status TEXT,
    va_call_status   TEXT,
    bridge_started_at   TIMESTAMPTZ,
    bridge_duration_sec INTEGER,
    detail           TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (consult_id, scheduled_at)
  );
  CREATE INDEX IF NOT EXISTS idx_consult_call_attempts_due
    ON consult_call_attempts(status, next_ring_at);
  CREATE INDEX IF NOT EXISTS idx_consult_call_attempts_status_created
    ON consult_call_attempts(status, created_at);
  ```
  Apply to the dev DB by restarting the dev server (initDb) or `psql "$DATABASE_URL" -f server/db/schema.sql` from the lane; verify with `\d consult_call_attempts` and `SELECT column_name FROM information_schema.columns WHERE table_name='consults' AND column_name='booker_phone'`. Prod gets it via initDb on deploy (the `webhook_events` precedent). Commit.

- [ ] C2. **`server/utils/consultCallBriefing.js` (pure, TDD).** Exports:
  - `spokenClockTime(instant)`: Chicago wall clock, `"10 AM"` when minutes are `00`, else `"10:15 AM"`. Uses `Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts`.
  - `spokenDateOnly(value)`: accepts a `Date` (node-pg DATE: read `getFullYear()/getMonth()/getDate()`, the LOCAL getters, because pg built it from local components) or a `'YYYY-MM-DD…'` string (slice the first 10 chars). Builds `new Date(Date.UTC(y, m, d, 12))` and formats weekday + month + ordinal day with `timeZone: 'UTC'`: `"Saturday October 10th"`. Returns `null` on anything unparseable. Ordinal rule copied from `leadCallBriefing.js` (`1st/2nd/3rd/11th/12th/13th`).
  - `buildConsultBriefing({ bookerName, scheduledAt, ring, forVa, eventDate, guestCount, proposalId })`:
    - name = trimmed `bookerName` with one trailing period stripped, else `"the client"`.
    - details (each skipped when absent): `Event ${spokenDateOnly(eventDate)}`, `${guestCount} guests` (only when `Number(guestCount) > 0`), `proposal ${proposalId}` (only when a positive integer).
    - Dallas: `${prefix}Potion planning call with ${name}, booked for ${time}.${details ? ' ' + details.join(', ') + '.' : ''} Press 1 to call them now. Press 9 to hear this again.` where prefix is `''` for ring 1, `'Second try. '` for ring 2, `'Last try. '` for ring 3.
    - Zul (`forVa`): `Dallas missed his potion planning call with ${name}, booked for ${time}.${details…} Press 1 to call them for him. Press 9 to hear this again.`
  - `formatUsPhoneForText(e164)`: `+12563281203` to `256-328-1203`; anything else returned as given.
  Tests (`consultCallBriefing.test.js`): clock time on the hour and off the hour, a DATE-shaped `Date` on a box whose TZ is not Chicago still speaks the right calendar day (construct `new Date(2026, 9, 10)` and assert `"Saturday October 10th"`), string input, null on garbage, all three ring prefixes, the Zul variant, absent fields skipped with no double spaces or "unknown", `"Sarah M."` does not stutter, the phone formatter. Commit.

- [ ] C3. **Email template.** `server/utils/emailTemplates.js`: add `consultCallAdmin({ bookerName, scheduledAt, reason, rawPhone, adminUrl, proposalUrl })` next to `missedLeadCallAdmin`, export it. Subject `Consult call ${reason}: ${bookerName || 'Cal.com booker'}`. Slot line `new Date(scheduledAt).toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })`. Body table: Name, Slot, Reason, and a Number row ONLY when `rawPhone` is given (the undialable-number case shows what the booker typed so Dallas can call by hand). Banner copy per reason: `undialable number` = "The consult call bridge will not ring for this booking because the number cannot be dialed. Call them by hand at the slot."; `call failed` / `daily cap tripped` / `stale` = "The consult call bridge could not complete calls for this consult. Check the system if this repeats." CTA `Open Proposal` when `proposalUrl`, else `View Client` when `adminUrl`. `text` mirrors the html. All values through `esc`. Tests (`emailTemplates.consultCall.test.js`, pattern of `emailTemplates.leadCall.test.js`): each reason lands in subject/html/text; the Number row appears only with `rawPhone`; HTML-escaping of a `<script>` name; CTA precedence. Commit.

- [ ] C4. **`server/utils/consultCallChain.js` (TDD, stubbed deps, real DB).** Deps seam `__setDeps` over `{ pool, placeBridgedCall, cancelBridgedCall, notifyAdminCategory, sendSMS }` (defaults from `../db`, `./sms`, `./adminNotifications`). URL base `API_URL` from `./urls`. Exports and exact behavior:
  1. `dailyCap()`, `isEnabled()` (see Global Constraints), `RING_OFFSETS_SEC`, `MAX_ADMIN_RINGS`, `AGENT_RING_SECONDS`, `STALE_MINUTES`.
  2. `async consultCallTail({ consultId, scheduledAt, bookerPhone, triggerEvent })` (spec 4.2). Never throws (outer try/catch -> `console.error` + Sentry tag `component: 'consult-call', step: 'tail'`). Order: `!isEnabled()` return; `!consultId || !scheduledAt` return; `new Date(scheduledAt) <= new Date()` return (past slot, no email); `const target = toUsE164(bookerPhone)`; if valid AND `triggerEvent === 'BOOKING_RESCHEDULED'`: `DELETE FROM consult_call_attempts WHERE consult_id = $1 AND status IN ('skipped_invalid_phone','skipped_unconfigured')`, return; if valid: return; else `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail) VALUES ($1, $2, 'skipped_invalid_phone', $3) ON CONFLICT (consult_id, scheduled_at) DO NOTHING RETURNING id` with `$3 = bookerPhone ? 'invalid_phone' : 'no_phone'`; on `rowCount === 1` -> `sendChainEmail({ attemptId, reason: 'undialable number' })`.
  3. `async openChain({ consultId, scheduledAt })` returns `'opened' | 'exists' | 'cap_tripped'`:
     ```sql
     INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, next_ring_at)
     SELECT $1, $2::timestamptz, 'pending', $2::timestamptz - INTERVAL '90 seconds'
     WHERE (SELECT COUNT(*) FROM consult_call_attempts
            WHERE created_at > NOW() - INTERVAL '24 hours'
              AND status NOT LIKE 'skipped%') < $3
     ON CONFLICT (consult_id, scheduled_at) DO NOTHING
     RETURNING id
     ```
     `rowCount 0`: if a row exists for the pair -> `'exists'`; else insert `failed / cap_tripped` (`ON CONFLICT DO NOTHING RETURNING id`) and, when this row holds `MIN(id)` among `detail = 'cap_tripped'` rows in the last 24h, email reason `'daily cap tripped'`; return `'cap_tripped'`.
  4. `async guardStillScheduled(attemptId)`: returns `{ ok: true }` when `consults.status = 'scheduled' AND consults.scheduled_at = attempt.scheduled_at`, else `{ ok: false, detail: consult.status !== 'scheduled' ? 'cancelled' : 'rescheduled' }`.
  5. `async advanceChain({ attemptId, fromLeg })` (spec 4.4):
     - `fromLeg === null` (sweep fire): `const g = await guardStillScheduled(attemptId)`; not ok -> `UPDATE … SET status='skipped_cancelled', detail=$2, next_ring_at=NULL WHERE id=$1 AND status='pending'`, return. No `ADMIN_PHONE` and no `VA_CELL` -> claim `pending -> skipped_unconfigured`, return. `ADMIN_PHONE` set -> claim
       ```sql
       UPDATE consult_call_attempts
       SET status='calling_admin', admin_ring = admin_ring + 1, next_ring_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'pending' AND admin_ring < 3
       RETURNING admin_ring
       ```
       winner -> `placeLeg({ attemptId, leg: 'admin', to: ADMIN_PHONE })`; a `false` return (create threw) -> `await onLegTerminal({ attemptId, leg: 'admin', callStatus: 'create_failed' })`. `ADMIN_PHONE` unset but `VA_CELL` set -> claim `pending -> calling_va`, place the VA leg; create throw -> `onLegTerminal({ leg: 'va', callStatus: 'create_failed' })`.
  6. `async onLegTerminal({ attemptId, leg, callStatus })` (called by `/status` and by create-throw fallthrough): write `${leg}_call_status = callStatus.slice(0,40)` unconditionally (telemetry). Then:
     - `leg === 'admin'`: read `admin_ring`, `scheduled_at`. If `admin_ring < 3`: claim
       ```sql
       UPDATE consult_call_attempts
       SET status='pending',
           next_ring_at = scheduled_at + ($2::int * INTERVAL '1 second'),
           updated_at = NOW()
       WHERE id = $1 AND status = 'calling_admin'
       ```
       with `$2 = RING_OFFSETS_SEC[admin_ring + 1]`. Else (ring 3 done): `const g = await guardStillScheduled(attemptId)`; not ok -> claim `calling_admin -> skipped_cancelled`; `VA_CELL` set -> claim `calling_admin -> calling_va`, winner places the VA leg (create throw -> recurse with `leg: 'va', callStatus: 'create_failed'`); `VA_CELL` unset -> claim `calling_admin -> missed`, winner -> `sendMissedText`.
     - `leg === 'va'`: `callStatus === 'create_failed'` -> claim `calling_va -> failed` (detail `create_failed`), winner emails `'call failed'`. Otherwise claim `calling_va -> missed`, winner -> `sendMissedText({ attemptId })`.
  7. `async placeLeg({ attemptId, leg, to })`: `placeBridgedCall({ to, callerId: process.env.TWILIO_PHONE_NUMBER, url: \`${API_URL}/api/voice/consult/answer?attempt=${attemptId}&leg=${leg}&play=1\`, statusCallback: \`${API_URL}/api/voice/consult/status?attempt=${attemptId}&leg=${leg}\`, timeLimit: parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800, timeout: AGENT_RING_SECONDS })`; persist the SID into `admin_call_sid`/`va_call_sid` (on persist failure `cancelBridgedCall` best-effort and rethrow into the catch); catch -> set `${leg}_call_status='create_failed'`, `detail = String(err.code || err.message).slice(0,200)`, Sentry, return `false`. Returns `true` on success.
  8. `async sendChainEmail({ attemptId, reason })`: load `c.booker_name, c.booker_phone, c.scheduled_at, c.client_id, c.proposal_id` through the attempt; `notifyAdminCategory({ category: 'lead_call', subject, emailHtml, emailText })` with the C3 template (`rawPhone` only for `'undialable number'`; `adminUrl = ${ADMIN_URL}/clients/${client_id}`, `proposalUrl = ${ADMIN_URL}/proposals/${proposal_id}`). Swallows and logs.
  9. `async sendMissedText({ attemptId })`: `to = VM_TEXT_DESTINATION || ADMIN_PHONE` (strict `/^\+[1-9]\d{6,14}$/`, else log and return); body `Missed consult call with ${name} at ${spokenClockTime(scheduled_at)}. Their number is ${formatUsPhoneForText(toUsE164(booker_phone))}.`; `sendSMS({ to, body, meta: { skipLog: true, messageType: 'consult_call_missed' } })`. Swallows and logs. (`skipLog` is the voicemail alert's flag: no client ledger row.)
  Tests (`consultCallChain.test.js`, harness of `leadCallTrigger.test.js`: `RUN` prefix, fixture consults inserted with `calcom_event_id = ${RUN}-n`, cleanup by `DELETE FROM consults WHERE calcom_event_id LIKE '${RUN}-%'`, attempts cascade; env saved/restored; `__setDeps` captures `placed`, `emails`, `texts`):
  - tail: kill switch inserts nothing; past slot inserts nothing; invalid phone inserts `skipped_invalid_phone`/`invalid_phone` and emails ONCE across two calls; empty phone -> `no_phone`; valid phone inserts nothing; reschedule with valid phone deletes a prior `skipped_invalid_phone` row but not a `skipped_cancelled` one; a throwing pool never rejects.
  - openChain: `'opened'` sets `next_ring_at = scheduled_at - 90s` (assert within 1s); second call `'exists'`; cap: set `CONSULT_CALL_DAILY_CAP=1`, open two -> second is `'cap_tripped'` with a `failed/cap_tripped` row and exactly one email; skipped rows do not count toward the cap.
  - fire: pending row -> `calling_admin`, `admin_ring 1`, one `placed` to `ADMIN_PHONE` from `TWILIO_PHONE_NUMBER` with `timeout 25` and `leg=admin` URLs; cancelled consult -> `skipped_cancelled/cancelled`, nothing placed; moved slot -> `skipped_cancelled/rescheduled`; both phones unset -> `skipped_unconfigured`; `ADMIN_PHONE` unset + `VA_CELL` set -> `calling_va` directly.
  - onLegTerminal admin: ring 1 `no-answer` -> `pending`, `next_ring_at = scheduled_at + 60s`; ring 2 -> `+180s`; ring 3 -> `calling_va` and one VA placement; duplicate callback after ring 3 places NOTHING more (assert `placed.length` unchanged); ring 3 with `VA_CELL` unset -> `missed` + exactly one text whose body names the booker and `256-328-1203`; a row already `connected` is untouched by any callback.
  - onLegTerminal va: `no-answer` -> `missed` + one text; duplicate -> still one; `create_failed` -> `failed` + one email reason `call failed`.
  - placeLeg create throw on ring 1: `admin_call_status='create_failed'`, row back to `pending` with ring-2 timing (the throw counted as ring 1).
  Commit.

- [ ] C5. **`server/utils/consultCallSweep.js` (TDD).** Exports `runConsultCallSweep()` returning `{ opened, capTripped, skippedInvalid, fired, skippedCancelled, skippedUnconfigured }` and `__setDeps` over `{ pool, chain }` (chain = the C4 module, so tests can spy on `openChain`/`advanceChain` OR let them run against the DB). `!chain.isEnabled()` -> return `{ skipped: true }`. Step 1 (open):
  ```sql
  SELECT c.id, c.scheduled_at, c.booker_phone
    FROM consults c
   WHERE c.status = 'scheduled'
     AND c.scheduled_at > NOW()
     AND c.scheduled_at <= NOW() + INTERVAL '5 minutes'
     AND NOT EXISTS (SELECT 1 FROM consult_call_attempts a
                      WHERE a.consult_id = c.id AND a.scheduled_at = c.scheduled_at)
   ORDER BY c.scheduled_at, c.id
   LIMIT 50
  ```
  per row: `toUsE164(booker_phone)` null -> insert `skipped_invalid_phone` (`ON CONFLICT DO NOTHING RETURNING id`, detail `no_phone`/`invalid_phone`) and on `rowCount 1` email `'undialable number'` (the pre-deploy-booking path); else `chain.openChain`. Step 2 (fire):
  ```sql
  SELECT id FROM consult_call_attempts
   WHERE status = 'pending' AND next_ring_at IS NOT NULL AND next_ring_at <= NOW()
   ORDER BY next_ring_at, id
   LIMIT 20
  ```
  per row `await chain.advanceChain({ attemptId, fromLeg: null })`, counting outcomes by re-reading the row's status. Each per-row body is try/caught (one bad row never stops the tick); the error is logged with the attempt id, and the sweep rethrows the LAST error at the end so `wrapScheduler` records a failed run (the `vaCallingScheduler` prune precedent). Tests (`consultCallSweep.test.js`, real DB + real chain with stubbed Twilio through the chain's `__setDeps`): opens only in-window scheduled consults (fixtures at +2m, +4m59s, +6m, -1m, and a `cancelled` at +2m); the +2m row's `next_ring_at` is 30s in the future so nothing fires this tick; a row with `next_ring_at` in the past fires exactly once across two consecutive ticks (second tick: `placed.length` unchanged); kill switch returns `{ skipped: true }` and touches nothing; invalid-phone consult in window inserts the skip row and emails once across two ticks; a consult rescheduled between open and fire ends `skipped_cancelled/rescheduled`. Commit.

- [ ] C6. **Webhook capture + tail wiring (`server/routes/calcom.js`).** `handleCreated`: the consults INSERT gains `booker_phone` (`$7 = phone` from `normalizeBooker`, already computed); after `COMMIT` and BEFORE `res.status(200).send('OK')`, `await _deps.consultCallTail({ consultId: consultResult.rows[0]?.id, scheduledAt: startTime, bookerPhone: phone, triggerEvent: 'BOOKING_CREATED' })` (only when the INSERT won, i.e. `rowCount === 1`; the `RETURNING id` is already there). `handleRescheduled`: the in-place UPDATE gains `booker_phone = COALESCE($6, booker_phone)` and `RETURNING id`; on `rowCount > 0` run the tail with `triggerEvent: 'BOOKING_RESCHEDULED'`, `scheduledAt: newStartTime`, `bookerPhone: phone` BEFORE the `'Rescheduled in place'` response; the fallthrough to `handleCreated` already runs the create tail. `handleCancelled`: untouched. Add a module-level `let _deps = { consultCallTail }` + `router.__setCalcomDeps = (d) => { _deps = { ..._deps, ...d }; }` seam (the tail is already never-throwing, but the route test must not dial). Tests (`calcom.test.js`, opt-in guard already present): `BOOKING_CREATED` with `attendees[0].phoneNumber` stores `booker_phone`; reschedule with a new phone overwrites it; reschedule without a phone keeps it; cancel leaves it; the tail is invoked exactly once per create/reschedule with the right `triggerEvent` (spy via `__setCalcomDeps`); a tail that throws still yields a 200 (belt and braces on the never-throws law). Commit.

- [ ] C7. **`server/routes/voiceConsultCall.js` (TDD).** Router mounted at `/api/voice/consult`. Copy the shape of `voiceLeadCall.js` (`sendTwiml`, `apologyTwiml` text "Sorry, this consult call has expired. Goodbye.", `requireSignature` FAIL-CLOSED with Sentry tag `webhook: 'twilio-voice-consult'`, `parseAttemptId`, `parseLeg` accepting `admin|va`, `TERMINAL_STATUSES`, `MAX_BRIEFING_PLAYS = 3`, seam `router.__setConsultVoiceDeps` over `{ isValidTwilioRequest, pool, onLegTerminal }`). `loadAttempt(attemptId)`:
  ```sql
  SELECT a.id, a.status, a.admin_ring, a.scheduled_at, a.answered_by,
         c.booker_name, c.booker_phone,
         p.id AS proposal_id, p.event_date, p.guest_count
    FROM consult_call_attempts a
    JOIN consults c ON c.id = a.consult_id
    LEFT JOIN proposals p ON p.id = c.proposal_id
   WHERE a.id = $1
  ```
  - `POST /answer?attempt&leg&play`: row must be `calling_admin` when `leg=admin`, `calling_va` when `leg=va`, else apology. Briefing = `buildConsultBriefing({ bookerName: row.booker_name, scheduledAt: row.scheduled_at, ring: row.admin_ring, forVa: leg === 'va', eventDate: row.event_date, guestCount: row.guest_count, proposalId: row.proposal_id })`, xml-escaped inside `<Gather numDigits="1" timeout="10" method="POST" action="/api/voice/consult/digit?attempt&leg&play">`, one repeat `<Say>`, `<Hangup/>`.
  - `POST /digit`: `9` -> redirect to `/answer` with `play+1` (apology past 3); not `1` -> `<Hangup/>`; `1` -> `loadAttempt`, status check as above, `target = toUsE164(row.booker_phone)` (null -> apology), then
    ```sql
    UPDATE consult_call_attempts
       SET status='connected', answered_by=$2, bridge_started_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status = $3
    ```
    with `$3 = leg === 'admin' ? 'calling_admin' : 'calling_va'`; loser -> apology; winner -> `<Dial answerOnBridge="true" callerId="${xmlEscape(callerIdFor(leg))}" timeLimit="${timeLimitSec()}"><Number statusCallback="${xmlEscape(API_URL + '/api/voice/consult/status?attempt=' + attemptId + '&leg=client')}">${xmlEscape(target)}</Number></Dial>`. `callerIdFor(leg)`: `admin` -> `process.env.CONSULT_CALLER_ID || process.env.VOICE_CALLER_ID || ''`; `va` -> `process.env.VOICE_CALLER_ID || ''`.
  - `POST /status?attempt&leg`: `leg` in `admin|va|client`; non-terminal -> `<Response/>`; `client` -> `UPDATE … SET bridge_duration_sec = $2` from a validated non-negative integer `CallDuration` (else NULL); `admin|va` -> `await _deps.onLegTerminal({ attemptId, leg, callStatus })`. Always 200 TwiML, `if (!res.headersSent)` on the catch path.
  Tests (`voiceConsultCall.test.js`, harness of `voiceLeadCall.test.js`, fixtures = a consult + optional proposal + attempt row): signature gate 403s on every route with the gate stubbed false; `/answer` speaks the booker name, the slot time, "Second try." on `admin_ring 2`, the Zul wording on `leg=va`, includes `Event Saturday October 10th, 120 guests, proposal N` when a proposal is linked and nothing of the sort when not; apology on a `pending`/`connected`/missing row and on a leg/status mismatch; `/digit` 1 claims `connected` with `answered_by`, emits `<Dial>` with `callerId="+12242221922"` when `CONSULT_CALLER_ID` is set and `leg=admin`, `+12242220082` when `leg=va`, falls back to `VOICE_CALLER_ID` when `CONSULT_CALLER_ID` is unset; a second press is an apology and the row stays `connected`; an invalid `booker_phone` apologizes WITHOUT claiming; `9` redirects with `play=2`, `play=4` apologizes; `/status` client leg stores `CallDuration`, rejects `-1`/`abc` to NULL; admin/va terminal calls `onLegTerminal` once with the raw status; non-terminal calls nothing; TwiML attributes never contain the booker name (grep the response for the name outside `<Say>` elements). Commit.

- [ ] C8. **Wire-up in `server/index.js`.** Mount `app.use('/api/voice/consult', require('./routes/voiceConsultCall'));` immediately after the `/api/voice/lead` line (before the `/api/voice` catch-all). Boot warning next to the 1a env check (the `VM_PRIMARY_DIAL_TARGET` block near the top): if `CONSULT_CALLER_ID` is unset or fails `/^\+[1-9]\d{6,14}$/`, `console.warn('[consultCall] CONSULT_CALLER_ID unset or not strict E.164; consult bridges answered by Dallas will show VOICE_CALLER_ID (the 0082) until fixed')`. Scheduler, placed after the `first_reply_sweep` block:
  ```js
  // Consult call sweep (spec 2026-08-25 section 4.3): opens a chain for each
  // upcoming Cal.com consult and places the ring that is due. Billed voice,
  // claim-guarded per row; the in-flight guard keeps a slow tick from
  // overlapping the next one (service_extension_sweep precedent).
  if (enabled('RUN_CONSULT_CALL_SWEEP_SCHEDULER')) {
    const { runConsultCallSweep } = require('./utils/consultCallSweep');
    let consultSweepInFlight = false;
    const wrapped = wrapScheduler('consult_call_sweep', 60, async () => {
      if (consultSweepInFlight) return { skipped: true };
      consultSweepInFlight = true;
      try { return await runConsultCallSweep(); } finally { consultSweepInFlight = false; }
    });
    setTimeout(wrapped, 35000); // 60s cadence; 35s is off every sibling's boot slot
    setInterval(wrapped, 60000);
  } else if (!globalScheduleDisabled) {
    clearHealthRow('consult_call_sweep');
  }
  ```
  Boot the dev server from the lane and confirm the mount answers 403 to an unsigned `POST /api/voice/consult/status` and the scheduler logs a first tick. Commit.

- [ ] C9. **Reaper.** `server/utils/vaCallingScheduler.js`: add `reapStaleConsultCallAttempts()`:
  ```sql
  UPDATE consult_call_attempts
     SET status='failed', detail='stale_reaped', next_ring_at=NULL, updated_at=NOW()
   WHERE status IN ('pending','calling_admin','calling_va')
     AND scheduled_at < NOW() - INTERVAL '30 minutes'
   RETURNING id
  ```
  each reaped id -> `deps.sendConsultCallChainEmail({ attemptId, reason: 'stale' })` (new dep wired to `consultCallChain.sendChainEmail`). Call it from `pruneVaCallingRows()` in its own try/catch after the lead reap (each guarded separately, same comment rationale). Export it. Test (`vaCallingScheduler.test.js`): stale `pending` and `calling_va` rows are reaped and emailed once each; a `connected` row and a fresh `pending` row (slot 5 minutes ago) are untouched. Commit.

- [ ] C10. **Sensitive paths, env, docs.** `scripts/sensitive-paths.txt`: under the billed-voice comment add `server/routes/voiceConsultCall.js`, `server/utils/consultCallChain.js`, `server/utils/consultCallSweep.js` with one line saying why (billed outbound voice on a timer; the client leg dials a webhook-supplied number). `.env.example` after the lead-call block:
  ```
  # Consult call bridge (auto-dial Dallas at each Cal.com consult slot; spec 2026-08-25).
  #   CONSULT_CALL_ENABLED     kill switch; only the literal 'false' disables the
  #                            webhook tail AND the sweep. Default on. Set 'false' in
  #                            Render BEFORE the first deploy, flip after the launch test.
  #   CONSULT_CALL_DAILY_CAP   max chains opened per rolling 24h (toll-fraud backstop).
  #                            Default 10; 0 is NOT off (parseInt || 10).
  #   CONSULT_CALLER_ID        strict E.164, the 1922: caller ID the client sees when
  #                            Dallas pressed 1. Unset falls back to VOICE_CALLER_ID (the
  #                            0082, Zul's line) with a boot warning.
  #   RUN_CONSULT_CALL_SWEEP_SCHEDULER  'false' disables the 60s sweep (default on).
  CONSULT_CALL_ENABLED=
  CONSULT_CALL_DAILY_CAP=10
  CONSULT_CALLER_ID=+12242221922
  ```
  `README.md`: env table rows for the four vars; tree rows for `voiceConsultCall.js`, `consultCallBriefing.js`, `consultCallChain.js`, `consultCallSweep.js`; one bullet under the Cal.com feature section. `.claude/CLAUDE.md`: env table rows. `ARCHITECTURE.md`: (a) new route subsection `### Consult Call Bridge — Twilio Voice — /api/voice/consult` after the lead bridge one with the three rows; (b) the Cal.com integration section gains two bullets (booker_phone capture; the post-commit tail and what it files); (c) schema section: `consults` paragraph gains `booker_phone`, and a `**consult_call_attempts**` entry after `lead_call_attempts` describing the state machine, the `(consult_id, scheduled_at)` key, and `next_ring_at`; (d) the scheduler list gains `consult_call_sweep` (60s) and the reaper note. Commit.

- [ ] C11. **Lane gate.** Run, one at a time, reading pass counts: `consultCallBriefing`, `emailTemplates.consultCall`, `consultCallChain`, `consultCallSweep`, `calcom` (with `ALLOW_TEST_DB_WRITES=1`), `voiceConsultCall`, `vaCallingScheduler`, `leadCallBriefing` (untouched, proves it), `voice.test.js` (mount order), `voiceLeadCall.test.js`. Then the pre-prod fleet on the lane diff, verdicts explicit: `security-review` (fail-closed gate, dial-target validation at both points, cap, attribute invariant, the tail's never-throw), `code-review`, `database-review` (claim guards under duplicate callbacks, the UNIQUE key, index use by the two sweep queries), `consistency-check` (spec sections 4.2 to 4.7 line by line; env docs in all three tables), `test-review` (every claim has a duplicate-callback assertion; no vacuous pass). A DOA agent is re-dispatched once; DOA is never a pass. Fix, re-verify prescriptions only, squash-merge with `scripts/merge-lane.sh`, then `npm install` in os if the lane ever ran an install.

## Lane consult-call-surfacing

- [ ] S1. **Attention feed union (`server/routes/admin/leadCalls.js`).** Replace the single query with:
  ```sql
  SELECT * FROM (
    SELECT a.id, 'lead' AS kind, a.status, a.detail, a.created_at,
           l.customer_name, l.proposal_id, l.client_id
      FROM lead_call_attempts a
      JOIN thumbtack_leads l ON l.id = a.lead_id
     WHERE a.status IN ('failed','skipped_unconfigured','skipped_invalid_phone')
       AND a.created_at > NOW() - INTERVAL '7 days'
       AND l.status = 'new'
    UNION ALL
    SELECT a.id, 'consult' AS kind, a.status, a.detail, a.created_at,
           c.booker_name AS customer_name, c.proposal_id, c.client_id
      FROM consult_call_attempts a
      JOIN consults c ON c.id = a.consult_id
     WHERE a.status IN ('failed','skipped_unconfigured','skipped_invalid_phone')
       AND a.created_at > NOW() - INTERVAL '7 days'
       AND c.status = 'scheduled'
  ) x
  ORDER BY created_at DESC, id DESC
  LIMIT 200
  ```
  Tests (`leadCalls.test.js`, extend): existing assertions still pass with `kind: 'lead'`; a consult `failed` row appears with `kind: 'consult'` and the booker name; a consult whose status left `scheduled` is excluded; a `missed` consult is excluded. Commit.

- [ ] S2. **Queue item (`client/src/pages/admin/overview/queueItems.js`).** `buildLeadCallItems` keys on `r.kind`: `consult` rows get `id: 'consultcall-' + r.id`, `title: \`Consult call with ${r.customer_name || 'Cal.com booker'} ${CONSULT_CALL_LABELS[r.status] || 'call failed'}\`` with `CONSULT_CALL_LABELS = { failed: 'call failed', skipped_unconfigured: 'call misconfigured', skipped_invalid_phone: 'bad number' }`; everything else (type `lead-call`, priority, target/ref) unchanged so `NeedsYouStrip` needs no change. Test: a consult row renders the consult title and a distinct id; a lead row is byte-identical to before. Commit.

- [ ] S3. **Detail lookups.** New `server/utils/consultCallLookups.js` exporting `latestConsultCallForProposal(proposalId)` and `consultCallsForClient(clientId)` (both `pool.query`, both return snake_case rows `{ status, answered_by, bridge_duration_sec, scheduled_at, detail }`; the client version returns the latest attempt PER consult via `DISTINCT ON (a.consult_id) … ORDER BY a.consult_id, a.id DESC`, then sorted by `scheduled_at DESC`, capped at 10). `server/routes/proposals/getOne.js`: add `latestConsultCallForProposal(req.params.id)` to the `Promise.all`, attach `consult_call: row || null`. `server/routes/clients.js` `GET /:id`: add `consultCallsForClient(req.params.id)`, attach `consult_calls: rows`. Tests (`consultCallLookups.test.js`, real DB fixtures): proposal lookup returns the newest attempt and null when none; client lookup returns one row per consult, newest attempt each. Commit.

- [ ] S4. **Detail lines + label.** New `client/src/utils/consultCallLabel.js`: `consultCallOutcomeLabel(cc)` (`connected` -> `connected (Dallas|Zul, m:ss)`; `missed`; `failed`; `skipped_invalid_phone` -> `skipped, bad number`; `skipped_cancelled` -> `cancelled`; `skipped_unconfigured` -> `misconfigured`; `pending|calling_*` -> `in progress`) and `consultCallSlotLabel(cc)` (`new Date(cc.scheduled_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })` -> `Aug 14, 10:00 AM`), with a small test file. `ProposalDetail.js`: directly under the existing `Lead call` line, `{proposal.consult_call && (<><dt>Consult call</dt><dd className="muted">{consultCallSlotLabel(proposal.consult_call)}: {consultCallOutcomeLabel(proposal.consult_call)}</dd></>)}`. `ClientDetail.js`: in the Lifetime card's `<dl className="dl">`, after Outstanding, one `<dt>Consult call</dt><dd className="muted">…</dd>` pair per `client.consult_calls` row (keyed by `scheduled_at`). `NotificationSettings.js`: `lead_call.label = 'Call bridge failures'`, `help = 'The lead or consult call bridge could not place calls (Twilio failure, bad config, an undialable consult number, or the daily cap tripped). Missed calls do not alert.'`. Client build gate `cd client && CI=true npx react-scripts build`. Commit.

- [ ] S5. **Docs + lane gate.** README tree row for `consultCallLookups.js` and `consultCallLabel.js`; ARCHITECTURE route-table rows for `GET /api/admin/lead-call-attention` (now both kinds), proposals `GET /:id` (`consult_call`), clients `GET /:id` (`consult_calls`). Resolve the README/ARCHITECTURE overlap with the core lane at merge. Suites: `leadCalls`, `consultCallLookups`, `queueItems` (client, `cd client && CI=true npx react-scripts test --watchAll=false src/pages/admin/overview/queueItems.test.js`), `consultCallLabel`. Fleet: `code-review` + `security-review` (admin endpoint role guard; IDOR-free by construction) + `consistency-check` (label copy matches the spec; both detail pages render the same label helper). Squash-merge.

## Launch checklist (ops, Dallas-driven, NOT a lane)

1. In Render, BEFORE the push: `CONSULT_CALL_ENABLED=false`, `CONSULT_CALLER_ID=+12242221922`. Confirm `ADMIN_PHONE`, `VA_CELL`, `VOICE_CALLER_ID`, `VM_TEXT_DESTINATION`, `TWILIO_PHONE_NUMBER` are set.
2. Push (normal cue + push-time fleet + `/second-opinion`; both lanes touch sensitive paths). initDb applies the column and table. Watch the boot log for the `[consultCall]` warning (should be absent) and the `consult_call_sweep` first tick.
3. Flip `CONSULT_CALL_ENABLED` on (delete the var).
4. Launch gate: Dallas books a slot on his own Cal.com page a few minutes out with the 970 as the number. Expect the 312 to ring 90 to 30 seconds before the slot, the briefing to speak his own name and the slot time, press 1, the 970 rings showing the 1922, two-way audio, and `SELECT status, answered_by, bridge_duration_sec FROM consult_call_attempts ORDER BY id DESC LIMIT 1` reads `connected / admin / >0`. Then cancel the booking in Cal.com and delete the test client row by hand.
5. Add the launch gate to `docs/walkthroughs-owed.md` at merge time and tick it here when it passes.
6. First-week watch: `SELECT status, detail, count(*) FROM consult_call_attempts WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY 1,2` should show no `failed`/`stale_reaped`; any `connected` row with `bridge_duration_sec < 20` gets a look.
