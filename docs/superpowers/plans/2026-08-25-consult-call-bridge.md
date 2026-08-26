---
spec: docs/superpowers/specs/2026-08-25-consult-call-bridge-design.md
lanes:
  - id: consult-call-core
    footprint:
      - server/db/schema.sql                        # consults.booker_phone + consult_call_attempts (spec 4.1)
      - server/routes/calcom.js                     # booker_phone capture + release-before-tail + tail wiring (spec 4.2)
      - server/routes/calcom.test.js                # exists: extend
      - server/utils/consultCallBriefing.js         # new: pure spoken briefing + clock/date/phone helpers (spec 4.6)
      - server/utils/consultCallBriefing.test.js
      - server/utils/consultCallChain.js            # new: tail, open, fileUndialable, claim-then-call chain driver, email, texts (spec 4.2, 4.4)
      - server/utils/consultCallChain.test.js
      - server/utils/consultCallSweep.js            # new: 60s open + missed-window + fire sweep (spec 4.3)
      - server/utils/consultCallSweep.test.js
      - server/routes/voiceConsultCall.js           # new: /api/voice/consult/{answer,digit,dialend,status} (spec 4.5)
      - server/routes/voiceConsultCall.test.js
      - server/utils/emailTemplates.js              # consultCallAdmin template (additive; file is past the 700 soft cap, warning expected)
      - server/utils/emailTemplates.consultCall.test.js
      - server/utils/vaCallingScheduler.js          # stale reaper rides the hourly pass (spec 4.7)
      - server/utils/vaCallingScheduler.test.js     # exists: extend
      - server/index.js                             # mount + scheduler + CONSULT_CALLER_ID boot check (past the 700 soft cap, warning expected)
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
      - server/routes/proposals/getOne.consultCall.test.js  # new, the getOne.leadCall.test.js pattern
      - server/routes/clients.js                    # consult_calls field on GET /:id
      - server/routes/clients.getOne.consultCalls.test.js   # new
      - client/src/utils/consultCallLabel.js        # new: shared outcome + slot labels
      - client/src/utils/consultCallLabel.test.js
      - client/src/pages/admin/overview/queueItems.js   # buildLeadCallItems handles kind='consult'
      - client/src/pages/admin/overview/queueItems.test.js  # exists: extend
      - client/src/pages/admin/ProposalDetail.js    # one line (975 of the 1000 hard cap: import + one dt/dd pair only)
      - client/src/pages/admin/ClientDetail.js      # one line per consult
      - client/src/pages/admin/NotificationSettings.js  # label rename (its own commit)
      - README.md
      - ARCHITECTURE.md
    blockedBy: [consult-call-core]
    review: full-fleet   # touches proposals getOne + clients getOne + an admin endpoint; S5 names all five agents
---

# Consult Call Bridge Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** this repo executes plans through the lane model (CLAUDE.md): one worktree lane per lane id (`npm run worktree:new -- <lane>`), checkpoint commits in-lane, squash merge to main via `scripts/merge-lane.sh`. Run order (encoded in blockedBy): `consult-call-core`, then `consult-call-surfacing`. Both lanes touch README/ARCHITECTURE; the second to merge resolves the trivial doc conflict. On lane cut, append the board line with `scripts/board-write.sh "In flight" "..."`. The Launch checklist is NOT a lane: Dallas-driven ops steps gating go-live. `docs/walkthroughs-owed.md` is outside both footprints and gets its launch-gate line as a quick-fix commit on main at merge time.
> **Rev 2 note:** re-cut after the six-lens design fleet. Spec rev 2 absorbed every blocker and warning (release-before-tail, stored-phone tail input, ring-guarded admin transitions, cancel re-check at the Zul hop and press-1, trailing open window + missed-window terminal, too-late rule, `/dialend` for the client leg, kill-switch semantics, bounded invalid-number email, 20-second admin rings, pinned copy). Plan changes on top: C4 split at the open/fire seam, one shared `fileUndialable`, route + mount + boot check in one task (old C8 dissolved into C5 and C7), route-level tests for both detail attachments, a manual walk in the surfacing lane, a database-review checkpoint after C1, an end-to-end dev walk in C11, the `calcom.test.js` seam re-applied per `buildApp`. The lead bridge files are not modified.

**Goal:** At each Cal.com consult slot, ring Dallas with a spoken briefing (three tries), then Zul, and let press-1 bridge whoever answered to the booker's own phone, with a text to Dallas if everyone missed or the client did not pick up.

**Architecture:** The Cal.com webhook persists `consults.booker_phone`, releases its pooled client, and runs a never-throwing post-commit tail that files undialable numbers. A 60-second sweep opens one `consult_call_attempts` row per upcoming slot (`next_ring_at = scheduled_at - 90s`, trailing catch-up of 3 minutes), files missed windows, and fires due rows through a claim-then-call chain driver whose admin transitions are ring-guarded; Twilio callbacks (`/api/voice/consult/*`, signature fail-closed everywhere) advance rings 1 to 3, then the VA leg, then `missed` + one SMS. Press 1 re-checks the consult, claims `connected`, and `<Dial>`s the booker from the 1922 (Dallas) or the 0082 (Zul), with `/dialend` speaking and texting a client no-answer. An hourly reaper fails anything stranded (or parks it as `skipped_disabled` when the switch is off).

**Tech Stack:** Express + raw parameterized SQL (`pool.query`), Twilio Programmable Voice TwiML via the existing gated `placeBridgedCall`/`sendSMS`, React 18 CRA, `node:test` with `__setDeps` stubs against the shared dev DB.

**Spec:** `docs/superpowers/specs/2026-08-25-consult-call-bridge-design.md` (rev 2)

## Global Constraints

- Raw SQL only, parameterized; schema changes idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`); initDb replays `schema.sql` every boot, so every block must be re-runnable.
- API JSON keys snake_case; JS camelCase. Client API calls via `client/src/utils/api.js` only.
- Voice endpoints return TwiML or 403, never stack traces, never a 5xx to Twilio.
- Post-commit tail law: `consultCallTail` never throws to the webhook, never takes the caller's pooled client, uses bare `pool.query()`, and runs only AFTER the handler has released its client.
- Claim-then-call: every billed or notifying side effect (`calls.create`, the failure email, either text) fires only when its guarded `UPDATE` returned `rowCount === 1`. Every admin-leg claim carries `AND admin_ring = $ring`.
- Dial-target law: the client leg dials ONLY `toUsE164(booker_phone)` output, validated at open time (sweep/tail) AND at press-1 time. Agent legs dial ONLY `ADMIN_PHONE` / `VA_CELL` env values verbatim.
- TwiML attribute-value invariant: only validated integers, fixed enums, env values, and `toUsE164` output ever land in an attribute; free text goes through `xmlEscape` in element text only.
- Phone logging: last-4 redaction (`String(p).slice(-4)`); `booker_phone` never in Sentry extras; HTML-escaped in email.
- Ring plan constants (code, not env): `RING_OFFSETS_SEC = { 1: -90, 2: 60, 3: 180 }` relative to `scheduled_at`, `MAX_ADMIN_RINGS = 3`, `ADMIN_RING_SECONDS = 20`, `VA_RING_SECONDS = 25`, `OPEN_AHEAD_MINUTES = 5`, `OPEN_BEHIND_MINUTES = 3`, `MISSED_WINDOW_MINUTES = 30`, `TOO_LATE_ADMIN_SEC = 600`, `TOO_LATE_VA_SEC = 720`, `STALE_MINUTES = 30`.
- Daily cap: `dailyCap()` = `parseInt(process.env.CONSULT_CALL_DAILY_CAP, 10) || 10` (the `|| 10` fallback is load-bearing: unset must not become `count < NaN`).
- Kill switch: `isEnabled()` = `process.env.CONSULT_CALL_ENABLED !== 'false'`. Off silences the tail, the sweep, and the callback branches that would dial Zul or text. Default on.
- Instants, not dates: every time comparison in SQL uses `NOW()` against `TIMESTAMPTZ` columns. Never `CURRENT_DATE`. `proposals.event_date` is a DATE and is spoken via `spokenDateOnly`, never as an instant.
- No em dashes in any spoken, texted, or emailed copy.
- Suites run ONE AT A TIME from the repo root (`node --test server/path/file.test.js`); every new test file starts with `require('dotenv').config();`. Read the pass count. `calcom.test.js` needs `ALLOW_TEST_DB_WRITES=1`.
- File-size ratchet: `emailTemplates.js` (823) and `server/index.js` (818) are past the 700 soft cap and will print the warning on commit; that is expected, do not reach for a sibling file. `ProposalDetail.js` is at 975 of the 1000 hard cap: the import plus one `<dt>/<dd>` pair only.

## Lane consult-call-core

- [ ] C1. **Schema.** Append to `server/db/schema.sql` directly after the `idx_consults_scheduled_at` line (schema.sql ~3100):
  ```sql
  -- Consult call bridge (spec 2026-08-25 section 4.1). booker_phone is the number the
  -- booker typed into Cal.com, raw (<= 50 chars, MAX_PHONE_LEN upstream); it is the
  -- ONLY number the bridge ever dials. consult_call_attempts is the ring-chain state
  -- machine AND the call log, one row per (consult, slot): a reschedule opens a fresh
  -- chain for the new slot. admin_ring is part of every admin-leg claim (the row
  -- re-enters calling_admin up to three times, so status alone cannot guard).
  ALTER TABLE consults ADD COLUMN IF NOT EXISTS booker_phone TEXT;

  CREATE TABLE IF NOT EXISTS consult_call_attempts (
    id               BIGSERIAL PRIMARY KEY,
    consult_id       INTEGER NOT NULL REFERENCES consults(id) ON DELETE CASCADE,
    scheduled_at     TIMESTAMPTZ NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','calling_admin','calling_va',
                                         'connected','missed','failed',
                                         'skipped_cancelled','skipped_invalid_phone',
                                         'skipped_unconfigured','skipped_disabled',
                                         'skipped_missed_window')),
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
  Apply to the dev DB with `psql "$DATABASE_URL" -c` on just the new block (quieter than replaying the whole file); verify with `\d consult_call_attempts` and the `information_schema.columns` check for `booker_phone`. Prod gets it via initDb on deploy. **Checkpoint: `database-review` on this task alone** (the CHECK list, the composite UNIQUE every later task relies on, whether the two indexes serve the sweep's open/fire/missed-window queries and the cap count) BEFORE C4a starts, so a key or index change never re-cuts five tasks' SQL. Commit.

- [ ] C2. **`server/utils/consultCallBriefing.js` (pure, TDD).** Exports:
  - `spokenClockTime(instant)`: Chicago wall clock via `Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts`; `"10 AM"` when minutes are `00`, else `"10:15 AM"`.
  - `clockTimeWithMinutes(instant)`: same parts, always `"10:00 AM"`.
  - `spokenDateOnly(value)`: a `Date` (node-pg DATE at LOCAL midnight: read `getFullYear()/getMonth()/getDate()`) or a `'YYYY-MM-DD…'` string (first 10 chars); build `new Date(Date.UTC(y, m, d, 12))`, format weekday + month + ordinal day with `timeZone: 'UTC'` -> `"Saturday October 10th"`; `null` on anything unparseable. Ordinal rule as in `leadCallBriefing.js` (`1st/2nd/3rd/11th/12th/13th`), re-implemented locally (no import).
  - `formatUsPhoneForText(e164)`: `+12563281203` -> `256-328-1203`; anything not matching `/^\+1\d{10}$/` returned as given.
  - `buildConsultBriefing({ bookerName, scheduledAt, ring, forVa, adminWasRung, eventDate, guestCount, proposalId })`:
    - name = trimmed `bookerName` with one trailing period stripped, else `"the client"`; `time = spokenClockTime(scheduledAt)`.
    - details (each skipped when absent): `Event ${spokenDateOnly(eventDate)}`, `${guestCount} guests` (only when `Number(guestCount) > 0`), `proposal ${proposalId}` (positive integer only). `detailSentence = details.length ? ' ' + details.join(', ') + '.' : ''`.
    - Dallas: `${prefix}Potion planning call with ${name}, booked for ${time}.${detailSentence} Press 1 to call them now. Press 9 to hear this again.` with prefix `''` / `'Second try. '` / `'Last try. '` for ring 1/2/3.
    - Zul, `adminWasRung`: `Dallas missed his potion planning call with ${name}, booked for ${time}.${detailSentence} Press 1 to call them for him. Press 9 to hear this again.`
    - Zul, not `adminWasRung`: `Potion planning call with ${name}, booked for ${time}, for Dallas.${detailSentence} Press 1 to call them for him. Press 9 to hear this again.`
  Tests (`consultCallBriefing.test.js`): clock time on and off the hour; `clockTimeWithMinutes` on the hour gives `10:00 AM`; `spokenDateOnly(new Date(2026, 9, 10))` is `"Saturday October 10th"` regardless of `process.env.TZ` (set `TZ=UTC` in a child `node -e` inside the test for the second assertion, or construct the Date and assert the local getters path); string input; null on garbage; all three prefixes; both Zul variants; absent fields leave no double spaces and no "unknown"; `"Sarah M."` does not stutter; phone formatter both branches. Commit.

- [ ] C3. **Email template.** `server/utils/emailTemplates.js`: add `consultCallAdmin({ bookerName, scheduledAt, reason, phoneDisplay, adminUrl, proposalUrl })` next to `missedLeadCallAdmin`, export it. `reason` is one of `call failed`, `daily cap tripped`, `too late`, `missed window`, `undialable number`, `missed, no text destination`. Subject `Consult call ${reason}: ${bookerName || 'Cal.com booker'}`. Slot line via `toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })`. Body table: Name, Slot, Reason, **Number (always; `phoneDisplay` is the caller's choice of formatted E.164 or the raw typed string)**. Banner by reason: `undialable number` -> "The consult call bridge will not ring for this booking because the number cannot be dialed. Call them by hand at the slot."; `missed window` -> "The slot passed before the bridge could ring. Call them now."; `missed, no text destination` -> "Everyone missed this consult and no text destination is configured. Call them now."; the rest -> "The consult call bridge could not complete calls for this consult. Check the system if this repeats." CTAs: `View Client` when `adminUrl` AND `Open Proposal` when `proposalUrl` (both when both). `text` mirrors the html. All values through `esc`. Tests (`emailTemplates.consultCall.test.js`, pattern of `emailTemplates.leadCall.test.js`): each reason in subject/html/text; the Number row always present; both CTAs when both links; a `<script>` name is escaped in subject and body. Commit.

- [ ] C4a. **`server/utils/consultCallChain.js`, open side (TDD, stubbed deps, real DB).** Deps seam `__setDeps` over `{ pool, placeBridgedCall, cancelBridgedCall, notifyAdminCategory, sendSMS }` (defaults from `../db`, `./sms`, `./adminNotifications`). `API_URL`/`ADMIN_URL` from `./urls`. Sentry tag `component: 'consult-call'`. Exports in this task:
  1. Constants from Global Constraints, `dailyCap()`, `isEnabled()`.
  2. `async sendChainEmail({ attemptId, reason })`: load `c.booker_name, c.booker_phone, c.scheduled_at, c.client_id, c.proposal_id` through the attempt; `phoneDisplay = toUsE164(booker_phone) ? formatUsPhoneForText(toUsE164(booker_phone)) : String(booker_phone || 'none')`; `notifyAdminCategory({ category: 'lead_call', subject, emailHtml, emailText })` with the C3 template and both URLs. Swallows and logs.
  3. `async fileUndialable({ consultId, scheduledAt, bookerPhone })`: `INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, detail) VALUES ($1, $2, 'skipped_invalid_phone', $3) ON CONFLICT (consult_id, scheduled_at) DO NOTHING RETURNING id` with `$3 = bookerPhone ? 'invalid_phone' : 'no_phone'`. On `rowCount === 1`: bounded email, i.e. email only when this row's id is `MIN(id)` among `skipped_invalid_phone` rows with `created_at > NOW() - INTERVAL '24 hours'` (the cap-trip min-id pattern). Returns `'filed' | 'exists'`.
  4. `async consultCallTail({ consultId, scheduledAt, bookerPhone, triggerEvent, unresolvedOldUid, bookerEmail })`: never throws (outer try/catch). Order: `!isEnabled()` return; `!consultId || !scheduledAt` return; `new Date(scheduledAt) <= new Date()` return; `target = toUsE164(bookerPhone)`; if `!target` -> `fileUndialable`, return; if `triggerEvent === 'BOOKING_RESCHEDULED'` -> `DELETE FROM consult_call_attempts WHERE consult_id = $1 AND status IN ('skipped_invalid_phone','skipped_unconfigured')`; if `unresolvedOldUid && bookerEmail` -> for each row of `SELECT id, scheduled_at FROM consults WHERE booker_email = $1 AND status = 'scheduled' AND scheduled_at > NOW() AND id <> $2`, `INSERT ... ('skipped_cancelled', 'rescheduled_unresolved') ON CONFLICT DO NOTHING`.
  5. `async openChain({ consultId, scheduledAt })` -> `'opened' | 'exists' | 'cap_tripped'`:
     ```sql
     INSERT INTO consult_call_attempts (consult_id, scheduled_at, status, next_ring_at)
     SELECT $1, $2::timestamptz, 'pending', $2::timestamptz - INTERVAL '90 seconds'
     WHERE (SELECT COUNT(*) FROM consult_call_attempts
            WHERE created_at > NOW() - INTERVAL '24 hours'
              AND status NOT LIKE 'skipped%') < $3
     ON CONFLICT (consult_id, scheduled_at) DO NOTHING
     RETURNING id
     ```
     `rowCount 0`: row exists for the pair -> `'exists'`; else insert `failed / cap_tripped` (`ON CONFLICT DO NOTHING RETURNING id`) and, when that id is `MIN(id)` among `detail = 'cap_tripped'` rows in 24h, email `'daily cap tripped'`; return `'cap_tripped'`.
  6. `async fileMissedWindow({ consultId, scheduledAt })`: `INSERT ... ('skipped_missed_window') ON CONFLICT DO NOTHING RETURNING id`; `rowCount 1` -> email `'missed window'`.
  Tests (`consultCallChain.test.js`, harness of `leadCallTrigger.test.js`: `RUN` prefix, fixture consults with `calcom_event_id = ${RUN}-n` and `booker_email = ${RUN}@example.test`, cleanup `DELETE FROM consults WHERE calcom_event_id LIKE '${RUN}-%'`, env saved/restored, `__setDeps` capturing `placed`/`emails`/`texts`): tail kill switch and past slot insert nothing; invalid phone files once across two calls and emails once; a second invalid consult in the same 24h does NOT email (bound); empty phone -> `no_phone`; valid create inserts nothing; reschedule clears only the two skip states, keeps `skipped_cancelled`; unresolved fallthrough files `rescheduled_unresolved` for the sibling future consult and not for the new row or a past one; a throwing pool never rejects. openChain: `next_ring_at` within 1s of `scheduled_at - 90s`; `'exists'`; `CONSULT_CALL_DAILY_CAP=1` -> second is `'cap_tripped'` with one email; skip rows do not count. fileMissedWindow files once and emails once. Commit.

- [ ] C4b. **`server/utils/consultCallChain.js`, fire side (TDD).** Adds:
  7. `async guardStillScheduled(attemptId)` -> `{ ok: true }` when `consults.status = 'scheduled' AND consults.scheduled_at = attempt.scheduled_at`, else `{ ok: false, detail: status !== 'scheduled' ? 'cancelled' : 'rescheduled' }`.
  8. `async claim(attemptId, fromStatus, toStatus, { ring, extraSet } = {})`: `UPDATE consult_call_attempts SET status = $3, updated_at = NOW() ${extraSet} WHERE id = $1 AND status = $2 ${ring ? 'AND admin_ring = $4' : ''}` -> boolean.
  9. `async placeLeg({ attemptId, leg, ring, to })`: `placeBridgedCall({ to, callerId: process.env.TWILIO_PHONE_NUMBER, url: \`${API_URL}/api/voice/consult/answer?attempt=${attemptId}&leg=${leg}&ring=${ring}&play=1\`, statusCallback: \`${API_URL}/api/voice/consult/status?attempt=${attemptId}&leg=${leg}&ring=${ring}\`, timeLimit: parseInt(process.env.VA_CALL_TIME_LIMIT_SEC, 10) || 1800, timeout: leg === 'admin' ? ADMIN_RING_SECONDS : VA_RING_SECONDS })`; persist the SID into `admin_call_sid`/`va_call_sid` (persist failure -> best-effort `cancelBridgedCall`, rethrow into the catch); catch -> `${leg}_call_status='create_failed'`, `detail = String(err.code || err.message).slice(0,200)`, Sentry, return `false`. Returns `true` on success.
  10. `async sendMissedText({ attemptId, kind })` with `kind` in `'missed' | 'client_no_answer'`: `to = VM_TEXT_DESTINATION || ADMIN_PHONE`, must match `/^\+[1-9]\d{6,14}$/`, else return `false`; body `Missed consult call with ${name} at ${clockTimeWithMinutes(scheduled_at)}. Their number is ${formatUsPhoneForText(toUsE164(booker_phone))}.` or `Consult client did not answer: ${name} at ${time}. Their number is ${...}.`; `sendSMS({ to, body, meta: { skipLog: true, messageType: 'consult_call_alert' } })`; returns `true`. Swallows and logs.
  11. `async advanceChain({ attemptId, fromLeg: null })`: load `scheduled_at, admin_ring`; `!isEnabled()` -> `claim(pending -> skipped_disabled)`, return; `guardStillScheduled` not ok -> `claim(pending -> skipped_cancelled, extraSet detail=$detail, next_ring_at=NULL)`, return; `Date.now() > scheduled_at + TOO_LATE_ADMIN_SEC*1000` -> `claim(pending -> failed, detail 'too_late')` winner emails `'too late'`, return; neither phone -> `claim(pending -> skipped_unconfigured)`, return; `ADMIN_PHONE` set -> `UPDATE ... SET status='calling_admin', admin_ring = admin_ring + 1, next_ring_at = NULL, updated_at = NOW() WHERE id = $1 AND status = 'pending' AND admin_ring < 3 RETURNING admin_ring` -> winner `placeLeg({ leg: 'admin', ring })`, `false` -> `onLegTerminal({ attemptId, leg: 'admin', ring, callStatus: 'create_failed' })`; else `VA_CELL` set -> `claim(pending -> calling_va)` -> `placeLeg({ leg: 'va', ring: 0 })`, `false` -> `onLegTerminal({ leg: 'va', callStatus: 'create_failed' })`.
  12. `async onLegTerminal({ attemptId, leg, ring, callStatus })`: write `${leg}_call_status = callStatus.slice(0,40)` (`AND admin_ring = $ring` for admin). Then, `leg === 'admin'`: read `admin_ring, scheduled_at`; if `admin_ring !== ring` return (stale ring callback; nothing else); if `admin_ring < 3` -> `claim(calling_admin -> pending, { ring, extraSet: next_ring_at = scheduled_at + ($n * INTERVAL '1 second') })` with `$n = RING_OFFSETS_SEC[admin_ring + 1]`; else (ring 3): `!isEnabled()` -> `claim(calling_admin -> skipped_disabled, {ring})`; guard fails -> `claim(calling_admin -> skipped_cancelled, {ring, detail})`; `Date.now() > scheduled_at + TOO_LATE_VA_SEC*1000` -> `claim(calling_admin -> failed 'too_late', {ring})` + email; `VA_CELL` set -> `claim(calling_admin -> calling_va, {ring})` winner `placeLeg({ leg: 'va', ring: 0 })`, `false` -> recurse `va / create_failed`; `VA_CELL` unset -> `callStatus === 'create_failed'` ? `claim(calling_admin -> failed 'create_failed', {ring})` + email `'call failed'` : `claim(calling_admin -> missed, {ring})` winner -> `sendMissedText({ kind: 'missed' })` returning false -> email `'missed, no text destination'`. `leg === 'va'`: `create_failed` -> `claim(calling_va -> failed)` + email `'call failed'`; `!isEnabled()` -> `claim(calling_va -> skipped_disabled)`; else `claim(calling_va -> missed)` winner -> `sendMissedText({ kind: 'missed' })`, false -> email.
  Tests (same file, extend): fire re-check order (disabled -> `skipped_disabled`; cancelled -> `skipped_cancelled/cancelled`; moved slot -> `/rescheduled`; T+11m -> `failed/too_late` + one email; both phones unset -> `skipped_unconfigured`); ring 1 placement shape (`to` = `ADMIN_PHONE`, `callerId` = `TWILIO_PHONE_NUMBER`, `timeout 20`, URLs contain `leg=admin&ring=1`); admin unset -> `calling_va` with `timeout 25`; onLegTerminal ring 1 `no-answer` -> `pending`, `next_ring_at = scheduled_at + 60s`; ring 2 -> `+180s`; ring 3 -> `calling_va` and one VA placement; **replaying the ring-1 callback while the row is `calling_admin` at ring 2 changes nothing** (status, `next_ring_at`, `placed.length` all unchanged); ring 3 with the consult cancelled -> `skipped_cancelled`, nothing placed; ring 3 at T+13m -> `failed/too_late` + email; ring 3 `VA_CELL` unset -> `missed` + one text naming the booker and `256-328-1203`; ring 3 `create_failed` with `VA_CELL` unset -> `failed` + email, no text; VA `no-answer` -> `missed` + one text, duplicate -> still one; VA `create_failed` -> `failed` + one email; kill switch flipped between ring 3 and the callback -> `skipped_disabled`, no VA leg, no text; no valid text destination -> `missed` + email reason `missed, no text destination`; a `connected` row is untouched by any callback; ring-1 create throw -> `admin_call_status='create_failed'`, row `pending` with ring-2 timing. Commit.

- [ ] C5. **`server/utils/consultCallSweep.js` (TDD) + scheduler wiring.** Exports `runConsultCallSweep()` -> `{ opened, capTripped, skippedInvalid, missedWindow, fired }` and `__setDeps` over `{ pool, chain }`. `!chain.isEnabled()` -> `{ skipped: true }`. Step 1 (open):
  ```sql
  SELECT c.id, c.scheduled_at, c.booker_phone
    FROM consults c
   WHERE c.status = 'scheduled'
     AND c.scheduled_at > NOW() - INTERVAL '3 minutes'
     AND c.scheduled_at <= NOW() + INTERVAL '5 minutes'
     AND NOT EXISTS (SELECT 1 FROM consult_call_attempts a
                      WHERE a.consult_id = c.id AND a.scheduled_at = c.scheduled_at)
   ORDER BY c.scheduled_at, c.id
   LIMIT 50
  ```
  per row: `toUsE164(booker_phone)` null -> `chain.fileUndialable`, else `chain.openChain`. Step 2 (missed window): same shape with `c.scheduled_at > NOW() - INTERVAL '30 minutes' AND c.scheduled_at <= NOW() - INTERVAL '3 minutes'` and a valid phone -> `chain.fileMissedWindow`. Step 3 (fire): `SELECT id FROM consult_call_attempts WHERE status = 'pending' AND next_ring_at IS NOT NULL AND next_ring_at <= NOW() ORDER BY next_ring_at, id LIMIT 20` -> `chain.advanceChain({ attemptId, fromLeg: null })`. Each per-row body try/caught with the attempt id logged; the last error rethrown at the end. **Scheduler block in `server/index.js`** after the `first_reply_sweep` block:
  ```js
  // Consult call sweep (spec 2026-08-25 section 4.3): opens a chain for each
  // upcoming Cal.com consult, files missed windows, and places the ring that is
  // due. Billed voice, claim-guarded per row; the in-flight guard keeps a slow
  // tick from overlapping the next one (service_extension_sweep precedent).
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
  Tests (`consultCallSweep.test.js`, real DB + real chain with Twilio stubbed via the chain's `__setDeps`; header states the open queries are GLOBAL over the shared dev DB, so assert on fixture ids only): fixtures at +2m, +4m59s, +6m, -2m, -4m, -20m, -40m, and a `cancelled` at +2m -> opened: +2m, +4m59s, -2m; missed window: -4m, -20m (one email each... no: emails once per row, so two emails, both `missed window`); untouched: +6m, -40m, cancelled; nothing fires this tick for the +2m row (`next_ring_at` 30s ahead) while the -2m row fires immediately; a due row fires exactly once across two consecutive ticks; kill switch `{ skipped: true }`; an invalid-phone consult in window files once across two ticks; a consult rescheduled between open and fire ends `skipped_cancelled/rescheduled`. Dev checkpoint: `node -e "require('dotenv').config(); require('./server/utils/consultCallSweep').runConsultCallSweep().then(r => { console.log(r); process.exit(0); })"` from the lane (schedulers are OFF on dev unless `RUN_SCHEDULERS=true`, which would fire every sibling; do not set it). Commit.

- [ ] C6. **Webhook capture + release-before-tail (`server/routes/calcom.js`).**
  - `handleCreated`: consults INSERT gains `booker_phone` (`$7 = phone`, already destructured) and `RETURNING id, scheduled_at, booker_phone`. After `await client.query('COMMIT')`: `client.release(); released = true;` (declare `let released = false;` before the `try`; the `finally` becomes `if (!released) client.release();`). THEN, only when `consultResult.rowCount === 1`, `await runTail(() => _deps.consultCallTail({ consultId: row.id, scheduledAt: row.scheduled_at, bookerPhone: row.booker_phone, triggerEvent: 'BOOKING_CREATED', unresolvedOldUid: Boolean(opts && opts.unresolvedOldUid), bookerEmail: email }))` where `runTail` is a local `try { await fn(); } catch (err) { console.error('[calcom] tail failed:', err.message); }`, THEN `res.status(200).send('OK')`. The "Already filed" and race-lost paths do not run the tail. `handleCreated(payload, res, opts)` gains the optional third arg.
  - `handleRescheduled`: destructure `phone` from `normalizeBooker` too; the UPDATE gains `booker_phone = COALESCE($6, booker_phone)` and `RETURNING id, scheduled_at, booker_phone`; on `rowCount > 0` run the tail (same `runTail`) with the RETURNED row and `triggerEvent: 'BOOKING_RESCHEDULED'`, then respond `'Rescheduled in place'`. The fallthrough calls `handleCreated(payload, res, { unresolvedOldUid: true })`.
  - Seam: `let _deps = { consultCallTail }` + `router.__setCalcomDeps = (d) => { _deps = { ..._deps, ...d }; }`.
  Tests (`calcom.test.js`, opt-in guard already present). `buildApp()` deletes the require cache and re-requires the router on EVERY call, so: change `buildApp` to return the router, make it install a NO-OP tail by default (`router.__setCalcomDeps({ consultCallTail: async () => {} })`, so the ~30 existing tests never run the real tail against the shared DB), and have the new tests install their spy on the returned router. Cases: `booker_phone` stored on create (from `attendees[0].phoneNumber`); overwritten on a reschedule with a phone; kept on a reschedule WITHOUT a phone and the spy receives the STORED number; untouched on cancel; the spy runs once per create/reschedule with the right `triggerEvent`; the unresolved fallthrough passes `unresolvedOldUid: true`; a spy that throws still yields 200 AND the `webhook_events` dedupe row is still present (proves the tail ran outside the transactional try); the tail runs after release: spy asserts `pool.idleCount + pool.waitingCount` shows no held client, or simpler, the spy itself runs `pool.query('SELECT 1')` with a 2s timeout under `max: 1` (construct a one-connection `Pool` in the test and inject it via the seam) and passes. Commit.

- [ ] C7. **`server/routes/voiceConsultCall.js` (TDD) + mount + boot check.** Router mounted at `/api/voice/consult`. Copy the shape of `voiceLeadCall.js` (`sendTwiml`, `apologyTwiml` "Sorry, this consult call has expired. Goodbye.", `requireSignature` FAIL-CLOSED with Sentry tag `webhook: 'twilio-voice-consult'`, `parseAttemptId`, `parseLeg` accepting `admin|va`, `parseRing` (integer 0..3), `TERMINAL_STATUSES`, `MAX_BRIEFING_PLAYS = 3`, seam `router.__setConsultVoiceDeps` over `{ isValidTwilioRequest, pool, onLegTerminal, guardStillScheduled, sendMissedText }`). `loadAttempt(attemptId)`:
  ```sql
  SELECT a.id, a.status, a.admin_ring, a.scheduled_at, a.answered_by, a.detail,
         c.booker_name, c.booker_phone,
         p.id AS proposal_id, p.event_date, p.guest_count
    FROM consult_call_attempts a
    JOIN consults c ON c.id = a.consult_id
    LEFT JOIN proposals p ON p.id = c.proposal_id
   WHERE a.id = $1
  ```
  `legMatches(row, leg, ring)`: `leg === 'admin' ? row.status === 'calling_admin' && row.admin_ring === ring : row.status === 'calling_va'`.
  - `POST /answer?attempt&leg&ring&play`: `legMatches` or apology. Briefing = `buildConsultBriefing({ bookerName, scheduledAt: row.scheduled_at, ring: row.admin_ring, forVa: leg === 'va', adminWasRung: row.admin_ring > 0, eventDate: row.event_date, guestCount: row.guest_count, proposalId: row.proposal_id })`, xml-escaped inside `<Gather numDigits="1" timeout="10" method="POST" action="/api/voice/consult/digit?attempt&leg&ring&play">`, one repeat `<Say>`, `<Hangup/>`.
  - `POST /digit`: `9` -> redirect to `/answer` with `play+1` (apology past 3); not `1` -> `<Hangup/>`; `1` -> `loadAttempt`, `legMatches` or apology; `target = toUsE164(row.booker_phone)` null -> apology; `guardStillScheduled(attemptId)` not ok -> `<Say>This consult was cancelled. Goodbye.</Say><Hangup/>` (no claim; the callback lands `skipped_cancelled`); then `UPDATE ... SET status='connected', answered_by=$2, bridge_started_at=NOW(), updated_at=NOW() WHERE id=$1 AND status=$3 AND ($3 <> 'calling_admin' OR admin_ring = $4)`; loser -> apology; winner -> `<Dial answerOnBridge="true" callerId="${xmlEscape(callerIdFor(leg))}" timeLimit="${timeLimitSec()}" action="${xmlEscape('/api/voice/consult/dialend?attempt=' + attemptId + '&leg=' + leg)}"><Number statusCallback="${xmlEscape(API_URL + '/api/voice/consult/status?attempt=' + attemptId + '&leg=client')}">${xmlEscape(target)}</Number></Dial>`. `callerIdFor(leg)`: `admin` -> `isStrictE164(CONSULT_CALLER_ID) ? CONSULT_CALLER_ID : (VOICE_CALLER_ID || '')`; `va` -> `VOICE_CALLER_ID || ''`.
  - `POST /dialend?attempt&leg`: `DialCallStatus === 'completed'` -> `<Hangup/>`. Else `UPDATE consult_call_attempts SET detail = 'client_no_answer', updated_at = NOW() WHERE id = $1 AND status = 'connected' AND detail IS NULL`; `rowCount 1` -> `await _deps.sendMissedText({ attemptId, kind: 'client_no_answer' })`; respond `<Say>They did not answer. Their number is ${xmlEscape(formatUsPhoneForText(target))}. Goodbye.</Say><Hangup/>` (target re-derived from the row through `toUsE164`; if somehow null, say "They did not answer. Goodbye.").
  - `POST /status?attempt&leg&ring`: `leg` in `admin|va|client`; non-terminal -> `<Response/>`; `client` -> `UPDATE ... SET bridge_duration_sec = $2` from a validated non-negative integer `CallDuration` (else NULL); `admin|va` -> `await _deps.onLegTerminal({ attemptId, leg, ring, callStatus })`. Always 200 TwiML; `if (!res.headersSent)` on the catch path.
  - **Mount** in `server/index.js`: `app.use('/api/voice/consult', require('./routes/voiceConsultCall'));` immediately after the `/api/voice/lead` line. **Boot check** next to the 1a env block: `const cid = String(process.env.CONSULT_CALLER_ID || '').trim(); if (!/^\+[1-9]\d{6,14}$/.test(cid)) console.warn('[consultCall] CONSULT_CALLER_ID unset or not strict E.164; consult bridges answered by Dallas will show VOICE_CALLER_ID (the 0082) until fixed');`. Dev check from the lane with `PORT=5001 node server/index.js` (the managed dev server holds :5000): unsigned `curl -X POST localhost:5001/api/voice/consult/status` returns 403; then stop it.
  Tests (`voiceConsultCall.test.js`, harness of `voiceLeadCall.test.js`, fixtures = a consult (+ optional proposal) + attempt row): every route 403s with the gate stubbed false; `/answer` speaks the booker name and the slot time, "Second try." on `admin_ring 2`, both Zul wordings (`admin_ring 0` vs `3`), proposal details present/absent, apology on `pending`/`connected`/missing rows, on a leg mismatch, and on a ring mismatch (`admin_ring 2`, `ring=1`); `/digit` `1` claims `connected` with `answered_by`, `<Dial>` has `callerId="+12242221922"` when `CONSULT_CALLER_ID` is set and `leg=admin`, `+12242220082` when `leg=va`, falls back when `CONSULT_CALLER_ID` is unset or malformed, includes `action="...dialend..."`; a cancelled consult gets the cancelled TwiML WITHOUT claiming; an invalid `booker_phone` apologizes WITHOUT claiming; a second press apologizes and the row stays `connected`; `9` -> `play=2`, `play=4` -> apology; `/dialend` `completed` -> bare hangup, no text; `no-answer` -> `detail='client_no_answer'` and one text, a duplicate `/dialend` sends no second text; `/status` client leg stores `CallDuration`, `-1`/`abc` -> NULL; admin/va terminal -> `onLegTerminal` once with `ring`; non-terminal -> nothing; TwiML attributes never contain the booker name. Commit.

- [ ] C8. **Reaper.** `server/utils/vaCallingScheduler.js`: add `reapStaleConsultCallAttempts()`:
  ```sql
  UPDATE consult_call_attempts
     SET status = $1, detail = $2, next_ring_at = NULL, updated_at = NOW()
   WHERE status IN ('pending','calling_admin','calling_va')
     AND scheduled_at < NOW() - INTERVAL '30 minutes'
   RETURNING id
  ```
  with `$1,$2 = isEnabled() ? ['failed','stale_reaped'] : ['skipped_disabled','stale_reaped']`; when enabled, each id -> `deps.sendConsultCallChainEmail({ attemptId, reason: 'call failed' })` (new dep -> `consultCallChain.sendChainEmail`); when disabled, no email. Call it from `pruneVaCallingRows()` in its own try/catch after the lead reap. Export it. Tests: enabled -> stale `pending` and `calling_va` reaped + emailed once each, `connected` and a 5-minute-old `pending` untouched; disabled -> `skipped_disabled`, zero emails. Commit.

- [ ] C9. **Sensitive paths, env, docs.** `scripts/sensitive-paths.txt` under the billed-voice comment: `server/routes/voiceConsultCall.js`, `server/utils/consultCallChain.js`, `server/utils/consultCallSweep.js`, `server/utils/consultCallBriefing.js`, `server/utils/calcomWebhookHelpers.js`, with one comment line ("consult call bridge: billed outbound voice on a timer; the client leg dials a number extracted from a public webhook payload"). `.env.example` after the lead-call block:
  ```
  # Consult call bridge (auto-dial Dallas at each Cal.com consult slot; spec 2026-08-25).
  #   CONSULT_CALL_ENABLED     kill switch; only the literal 'false' disables the
  #                            webhook tail, the sweep, and the callback hops that
  #                            would dial Zul or text. Default on. Set 'false' in
  #                            Render BEFORE the first deploy, flip after the launch test.
  #   CONSULT_CALL_DAILY_CAP   max chains opened per rolling 24h. Default 10; 0 is NOT
  #                            off (parseInt || 10). The booking page is PUBLIC, so this
  #                            is also the ceiling on what the open internet can make
  #                            the bridge do per day (30 rings + 10 Manila legs + 10
  #                            texts). Raising it widens a public surface.
  #   CONSULT_CALLER_ID        strict E.164, the 1922: caller ID the client sees when
  #                            Dallas pressed 1. Unset or malformed falls back to
  #                            VOICE_CALLER_ID (the 0082, Zul's line) with a boot warning.
  #   RUN_CONSULT_CALL_SWEEP_SCHEDULER  'false' disables the 60s sweep (default on).
  CONSULT_CALL_ENABLED=
  CONSULT_CALL_DAILY_CAP=10
  CONSULT_CALLER_ID=+12242221922
  RUN_CONSULT_CALL_SWEEP_SCHEDULER=
  ```
  `README.md`: env rows for the four vars; tree rows for `voiceConsultCall.js`, `consultCallBriefing.js`, `consultCallChain.js`, `consultCallSweep.js`; one bullet under the Cal.com feature section. `.claude/CLAUDE.md`: env rows. `ARCHITECTURE.md` (no scheduler list exists; schedulers are documented inline per feature): (a) route subsection `### Consult Call Bridge — Twilio Voice — /api/voice/consult` after the lead bridge one with four rows (answer, digit, dialend, status); (b) Cal.com integration section gains bullets for `booker_phone` capture, release-before-tail, and what the tail files; (c) schema section: `consults` paragraph gains `booker_phone`; a `**consult_call_attempts**` entry after `lead_call_attempts` describing the state machine, the ring guard, the `(consult_id, scheduled_at)` key, `next_ring_at`, the 60s sweep with its windows, and the reaper's two modes. Commit.

- [ ] C10. **Lane gate.** Suites, one at a time, pass counts read: `consultCallBriefing`, `emailTemplates.consultCall`, `consultCallChain`, `consultCallSweep`, `calcom` (`ALLOW_TEST_DB_WRITES=1`), `voiceConsultCall`, `vaCallingScheduler`, `leadCallBriefing` + `voiceLeadCall` (untouched, proves it). **End-to-end dev walk** with `SEND_NOTIFICATIONS` off: POST a signed synthetic `BOOKING_CREATED` (the `calcom.test.js` signer) for a slot 3 minutes out with a valid `phoneNumber`; confirm `booker_phone` stored; run the C5 one-liner and confirm a `pending` row with `next_ring_at = scheduled_at - 90s`; run it again after that instant and confirm `calling_admin`, `admin_ring 1`, and the `[DEV] Bridged call skipped` log line (the `dev-skipped-` SID persist exercises `placeLeg` for real); cancel the consult by hand (`UPDATE consults SET status='cancelled'`) and run once more after `next_ring_at` to see nothing further placed; delete the fixture rows. Then the pre-prod fleet on the lane diff, verdicts explicit: `security-review` (fail-closed gate, dial-target validation at both points, the consult re-check at press-1 and the Zul hop, cap, attribute invariant, the tail's never-throw and post-release placement), `code-review`, `database-review` (ring-guarded claims under replayed callbacks, the UNIQUE key, index use by the three sweep queries and the cap count), `consistency-check` (spec rev 2 sections 4.2 to 4.7 line by line; env docs in all three tables; copy pins), `test-review` (every claim has a duplicate-callback assertion, the ring-replay test exists and fails on a status-only guard, no vacuous pass). A DOA agent is re-dispatched once; DOA is never a pass. Fix, re-verify prescriptions only, squash-merge with `scripts/merge-lane.sh`, then `npm install` in os if the lane ever ran an install.

## Lane consult-call-surfacing

**Revised 2026-08-26, before the lane was cut.** These tasks were written before the core lane was
built, and six things moved underneath them. Each correction is marked AMENDED where it lands.

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
     WHERE a.status IN ('failed','skipped_unconfigured','skipped_invalid_phone',
                        'skipped_missed_window','skipped_cap')
       AND a.created_at > NOW() - INTERVAL '7 days'
       AND c.status = 'scheduled'
  ) x
  ORDER BY created_at DESC, id DESC
  LIMIT 300
  ```
  **AMENDED (rev 3): there is NO `scheduled_at > NOW()` filter, and each half carries its OWN inner
  LIMIT.** Lead inner `LIMIT 200` (its exact pre-change capacity, so the lead half stays
  byte-identical), consult inner `LIMIT 100`, outer `LIMIT 300` as belt and braces that can then
  never truncate either half. Without per-half limits the consult half, which a stranger can fill
  from the PUBLIC booking page, starves the revenue-critical lead half off the feed. Pin it with a
  test seeding more than 100 consult rows NEWER than the lead rows, so it fails on the limits
  rather than passing on ordering.
  **AMENDED: `skipped_cap` joins the consult status list.** It predates ruling R15 and it is the one
  fault class reachable from the PUBLIC booking page, so omitting it leaves the feed silent on
  precisely the abuse signal it exists to show.
  Tests (`leadCalls.test.js`, extend): existing assertions still pass with `kind: 'lead'`; a consult
  `failed` row appears as `kind: 'consult'` with the booker name; a `skipped_cap` row appears; a
  consult whose slot has passed is excluded; a non-`scheduled` consult is excluded; a `missed`
  consult is excluded. Commit.

- [ ] S2. **Queue item (`client/src/pages/admin/overview/queueItems.js`).** `buildLeadCallItems` keys
  on `r.kind`. Consult rows get `id: 'consultcall-' + r.id` and a title of
  `Consult call with ${r.customer_name || 'Cal.com booker'} ${label}`.
  **AMENDED: the cap trip is TWO different events and the label must say which.** The dial-cap lane
  added `detail = 'dial_cap_tripped'` (the rings to Dallas) and `detail = 'va_leg_cap_tripped'` (the
  international legs), and BOTH land on status `skipped_cap`. They mean different things to an
  operator: the first says the public booking page is being hammered, the second says Manila spend
  hit its ceiling. So the consult label keys on `(status, detail)`, not status alone:
  ```
  failed                                  -> 'call failed'
  skipped_unconfigured                    -> 'call misconfigured'
  skipped_invalid_phone                   -> 'bad number'
  skipped_missed_window                   -> 'missed window'
  skipped_cap + dial_cap_tripped          -> 'dial cap tripped'
  skipped_cap + va_leg_cap_tripped        -> 'international leg cap tripped'
  skipped_cap + cap_tripped               -> 'daily cap tripped'   (chain-open cap, the DOMINANT one)
  skipped_cap + anything else             -> 'daily cap tripped'
  ```
  Everything else (type `lead-call`, priority, target/ref) is unchanged, so `NeedsYouStrip` needs no
  edit. Tests (`queueItems.test.js`, extend): each consult label renders including both cap variants;
  a lead row is byte-identical to before; a lead and a consult sharing an id produce distinct keys.
  Commit.

- [ ] S3. **Detail lookups + route attachments.** New `server/utils/consultCallLookups.js`.
  **AMENDED, and this one would have shipped a dead label:** both lookups must select
  `client_no_answer_at`, which the original task omitted while S4 keys the "connected, no answer"
  label on it. Without the column the label can never fire.
  **AMENDED, from the database review, with its RATIONALE corrected by S3's own review.** Write
  `latestConsultCallForProposal` driving from `consults`. The SQL below is right; the reason first
  given here was not, and the reason is the part a future reader uses. Postgres COLLAPSES a
  two-relation inner join and reorders freely, so the textual FROM order constrains nothing and the
  flipped text yields the same plan. What actually prevents the backward whole-table walk on the
  common case, an ordinary proposal that never had a consult, is `idx_consults_proposal_id` plus
  the selectivity of the equality predicate, after which the composite
  `UNIQUE (consult_id, scheduled_at)` serves the inner side of both read paths. So do NOT write a
  test pinning the join TEXT believing it pins the plan: it pins a form.
  ```sql
  -- latestConsultCallForProposal(proposalId)
  SELECT a.status, a.answered_by, a.bridge_duration_sec, a.scheduled_at, a.detail,
         a.client_no_answer_at
    FROM consults c
    JOIN consult_call_attempts a ON a.consult_id = c.id
   WHERE c.proposal_id = $1
   ORDER BY a.id DESC
   LIMIT 1
  ```
  ```sql
  -- consultCallsForClient(clientId)
  -- AMENDED: a.consult_id rides along as the STABLE LIST KEY. S4 renders one line per row and
  -- needs a key that is not scheduled_at, since two consults for one client can share a slot.
  SELECT * FROM (
    SELECT DISTINCT ON (a.consult_id)
           a.consult_id, a.status, a.answered_by, a.bridge_duration_sec, a.scheduled_at, a.detail,
           a.client_no_answer_at
      FROM consults c
      JOIN consult_call_attempts a ON a.consult_id = c.id
     WHERE c.client_id = $1
     ORDER BY a.consult_id, a.id DESC
  ) t ORDER BY scheduled_at DESC, consult_id DESC LIMIT 10   -- tiebreaker: without it the order
  -- of two rows sharing a slot is undefined and the list can reshuffle between requests
  ```
  `proposals/getOne.js`: add to the `Promise.all`, attach `consult_call: row || null`.
  `clients.js` `GET /:id`: add to the `Promise.all`, attach `consult_calls: rows`.
  Tests: `consultCallLookups.test.js` (newest attempt; null when none; one row per consult; and an
  explicit assertion that `client_no_answer_at` comes back, since that is the column S4 depends on);
  `proposals/getOne.consultCall.test.js` (the `getOne.leadCall.test.js` harness); a `clients` GET
  `/:id` case. Also run the reached `getOne.leadCall.test.js` and `clients.list.test.js`. Commit.

- [ ] S4. **Label helper + detail lines.** New `client/src/utils/consultCallLabel.js`.
  `consultCallOutcomeLabel(cc)`:
  ```
  connected + client_no_answer_at NON-NULL -> 'connected, no answer'
  connected                                -> 'connected (Dallas|Zul, m:ss)'   (duration only when integer)
  missed                                   -> 'missed'
  failed                                   -> 'failed'
  skipped_cancelled                        -> 'cancelled'
  skipped_invalid_phone                    -> 'skipped, bad number'
  skipped_missed_window                    -> 'missed window'
  skipped_cap + dial_cap_tripped           -> 'dial cap tripped'
  skipped_cap + va_leg_cap_tripped         -> 'international leg cap tripped'
  skipped_cap + cap_tripped                -> 'daily cap tripped'
  skipped_cap                              -> 'daily cap tripped'
  skipped_unconfigured                     -> 'misconfigured'
  skipped_disabled                         -> 'disabled'
  pending | calling_*                      -> 'in progress'
  ```
  **AMENDED: the three `skipped_cap` rows are new** (R15 plus the dial-cap lane). Ruling R14's
  column latch is already reflected above; `detail === 'client_no_answer'` is a string the code NEVER
  writes and must not appear anywhere in this helper.
  `consultCallSlotLabel(cc)`: `toLocaleString('en-US', { month: 'short', day: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })` -> `Aug 14, 10:00 AM`.
  Test file covers every branch above.
  `ProposalDetail.js` is **975 lines against a 1000-line hard cap**, so: the import plus ONE
  `<dt>/<dd>` pair under the existing `Lead call` line, nothing else. `ClientDetail.js`: one pair per
  `client.consult_calls` row in the Lifetime card's `<dl>`, **keyed by `consult_id`, not by
  `scheduled_at`**: two consults for one client can share a slot, and a slot is not an identity.
  Client build gate `cd client && CI=true npx react-scripts build`.
  **Manual walk on dev, recorded in the commit body:** seed a `failed` consult attempt on a future
  consult and see it in the Sales tab, click through; seed a `connected` row with
  `bridge_duration_sec 252` and see the line on both detail pages; seed one with
  `client_no_answer_at` set and confirm it reads "connected, no answer"; delete the seeds. Commit.

- [ ] S5. **Settings label, docs, lane gate.** Own commit: `NotificationSettings.js`
  `lead_call.label = 'Call bridge failures'`, help text covering both bridges and naming the cap
  trips, since those are now two distinct reasons an operator can receive.
  Docs commit: README tree rows for `consultCallLookups.js` and `consultCallLabel.js`; ARCHITECTURE
  route rows for `GET /api/admin/lead-call-attention`. **Describe it as rev 3 actually shipped,
  not as rev 2 read:** both kinds, the five consult fault statuses including `skipped_cap`, NO
  slot-ahead filter (a fault outlives its slot, because the slot passing creates the callback
  obligation rather than retiring it), `c.status = 'scheduled'` as the clearing mechanism, and
  per-half limits of 200 lead / 100 consult under an outer 300 so the public half cannot starve
  the lead half. Then proposals
  `GET /:id` (`consult_call`), clients `GET /:id` (`consult_calls`).
  **AMENDED: the old index claim was wrong.** This task previously told the reviewer the table is
  indexed only on `(status, next_ring_at)` and `(status, created_at)`. It is ALSO indexed on the
  composite `UNIQUE (consult_id, scheduled_at)`, which is exactly what both new read paths use, so
  no new index is needed and the database reviewer should be told that rather than left to rederive it.
  Suites: `leadCalls`, `consultCallLookups`, `getOne.consultCall`, `getOne.leadCall`,
  `clients.list`, the new clients getOne case, `queueItems` and `consultCallLabel` (client, via
  `CI=true npx react-scripts test --watchAll=false <path>`).
  Fleet, all five, verdicts explicit: `security-review` (admin endpoint role guard, IDOR-free by
  construction), `code-review`, `database-review` (the UNION and the `DISTINCT ON` are new read paths;
  confirm the plans), `consistency-check` (label copy matches spec 5.3 and both detail pages use the
  one helper), `test-review`. Squash-merge.

## Launch checklist (ops, Dallas-driven, NOT a lane)

1. In Render, BEFORE the push: `CONSULT_CALL_ENABLED=false`, `CONSULT_CALLER_ID=+12242221922`. Confirm `ADMIN_PHONE`, `VA_CELL`, `VOICE_CALLER_ID`, `VM_TEXT_DESTINATION`, `TWILIO_PHONE_NUMBER` are set.
2. Push (normal cue + push-time fleet + `/second-opinion`; both lanes touch sensitive paths). initDb applies the column and table. Watch the boot log: no `[consultCall]` warning, and `consult_call_sweep` appears in `scheduler_health` after the first minute.
3. Flip `CONSULT_CALL_ENABLED` on (delete the var).
4. Launch gate: confirm the Cal.com event type's minimum booking notice allows a slot a few minutes out (lower it for the test if not). Dallas books a slot on his own Cal.com page with a phone that is NOT his own cell and is not the 312 (which forwards to it), because `ADMIN_PHONE` is the 970 itself. Expect the 970 to ring 90 to 30 seconds before the slot, the briefing to speak his own name and the slot time, press 1, the 970 rings showing the 1922, two-way audio, and `SELECT status, answered_by, bridge_duration_sec, detail FROM consult_call_attempts ORDER BY id DESC LIMIT 1` reads `connected / admin / >0 / NULL`. Then cancel the booking in Cal.com and delete the test client row by hand.
5. Tick the launch gate in `docs/walkthroughs-owed.md` when it passes.
6. First-week watch: `SELECT status, detail, count(*) FROM consult_call_attempts WHERE created_at > NOW() - INTERVAL '7 days' GROUP BY 1,2` should show no `failed` and no `skipped_missed_window`; any `connected` row with `client_no_answer_at IS NOT NULL` or `bridge_duration_sec < 20` gets a look (the no-answer latch is that COLUMN, not a `detail` value, per ruling R14, so add `count(*) FILTER (WHERE client_no_answer_at IS NOT NULL)` to the select rather than grouping on `detail` for it).
