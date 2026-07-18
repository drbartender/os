---
spec: docs/superpowers/specs/2026-07-18-lead-call-bridge-design.md
lanes:
  - id: lead-call-core
    footprint:
      - server/db/schema.sql                      # lead_call_attempts (spec 4.1)
      - server/routes/thumbtack.js                # RETURNING id + leadId threading + trigger step
      - server/utils/leadCallTrigger.js           # new: triggerLeadCall + claim-then-call chain driver
      - server/utils/leadCallTrigger.test.js
      - server/routes/voiceLeadCall.js            # new: /api/voice/lead/{answer,digit,status}
      - server/routes/voiceLeadCall.test.js
      - server/utils/twilioSignature.js           # new: isValidTwilioRequest extracted from voice.js
      - server/routes/voice.js                    # imports the extracted helper, behavior unchanged
      - server/utils/leadCallBriefing.js          # new: pure TTS briefing builder
      - server/utils/leadCallBriefing.test.js
      - server/utils/businessTime.js              # new chicagoHourNow() helper
      - server/utils/businessTime.test.js         # exists: extend
      - server/utils/sms.js                       # placeBridgedCall optional timeout passthrough
      - server/utils/vaCallingScheduler.js        # stale-attempt reaper rides the hourly pass
      - server/utils/vaCallingScheduler.test.js
      - server/utils/adminNotifications.js        # VALID_CATEGORIES + 'lead_call'
      - server/routes/me.js                       # NOTIFICATION_CATEGORIES mirror + PATCH allowlist
      - server/routes/me.notificationPrefs.test.js  # exists: extend for the new category
      - server/utils/emailTemplates.js            # missedLeadCallAdmin template (additive)
      - server/utils/emailTemplates.leadCall.test.js  # new: template render assertions
      - server/index.js                           # mount /api/voice/lead
      - .env.example                              # LEAD_CALL_ENABLED, LEAD_CALL_DAILY_CAP
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md                         # env table rows
    blockedBy: []
    review: full-fleet   # billed outbound voice + Twilio webhook surface + TT webhook tail; sensitive
  - id: lead-call-surfacing
    footprint:
      - server/routes/admin/leadCalls.js          # new: GET /api/admin/lead-call-attention
      - server/routes/admin/leadCalls.test.js
      - server/routes/admin/index.js              # mount
      - server/routes/proposals/getOne.js         # lead_call outcome join
      - client/src/pages/admin/overview/OverviewPage.js   # fetch the new source + sales-array prepend
      - client/src/pages/admin/overview/queueItems.js     # buildLeadCallItems
      - client/src/pages/admin/overview/NeedsYouStrip.js  # 'client' href target + QUEUE_ICON entry
      - client/src/pages/admin/ProposalDetail.js  # call-outcome line
      - client/src/pages/admin/NotificationSettings.js    # CATEGORY_LABELS entry
      - README.md
      - ARCHITECTURE.md
    blockedBy: [lead-call-core]
    review: full-fleet   # touches proposals getOne + a new admin endpoint
---

# Thumbtack Lead Call Bridge Implementation Plan (rev 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** this repo executes plans through the lane model (CLAUDE.md): one worktree lane per lane id, checkpoint commits in-lane, squash merge to main. Run order (encoded in blockedBy): `lead-call-core`, then `lead-call-surfacing`. Both lanes touch README/ARCHITECTURE; the second lane to merge resolves the trivial doc conflict during its merge. The Launch checklist is NOT a lane: Dallas-driven ops steps gating go-live.

**Rev 2 note:** reordered after the plan-review fleet (fidelity PASS, feasibility PASS, decomposition FAIL on task ordering). The notification category + email template task now precedes its consumers (was C10, now C7); cap fallback default pinned; schema apply mechanism spelled out; OverviewPage merge point corrected; getOne test moved into its own task; review-agent checkpoints named explicitly.

**Goal:** On each new in-window Thumbtack lead, auto-call Dallas (then Zul) with a spoken briefing and press-1 bridging to the lead, with missed chains logged and surfaced.

**Architecture:** The TT webhook's post-commit tail inserts an idempotent `lead_call_attempts` row and places the admin leg via the existing gated `placeBridgedCall`. Twilio webhooks (`/api/voice/lead/*`, signature fail-closed everywhere) drive a claim-then-call state machine: Gather briefing, press-1 `<Dial answerOnBridge>` to the lead from the 224, terminal-status failover Dallas to Zul, missed chains email + needs-attention. An hourly reaper kills stranded rows.

**Tech Stack:** Express + raw SQL (`pool.query`, parameterized), Twilio Programmable Voice TwiML, React 18 CRA, `node:test` with `__setDeps` stubs.

## Global Constraints

- Raw SQL only, parameterized; schema changes idempotent (`IF NOT EXISTS`).
- API JSON keys snake_case; JS camelCase. Client API calls via `client/src/utils/api.js` only.
- Server errors: `AppError` subclasses; voice endpoints return TwiML or 403, never stack traces.
- Post-commit tail law (CLAUDE.md): `triggerLeadCall` never throws to the webhook, takes no caller's pooled client, uses bare `pool.query()`.
- Every billed side effect (calls.create, missed email, VA-leg placement) fires only when its guarded UPDATE returns rowCount 1 (claim-then-call, spec 4.2 step 6).
- Dial-target law: lead legs dial ONLY a `toUsE164`-validated number (spec 4.2 step 4). Agent legs dial ONLY `ADMIN_PHONE` / `VA_CELL` env values verbatim.
- All TwiML interpolations pass through `xmlEscape` (`server/utils/xmlEscape.js`), the `<Say>` briefing included.
- Phone logging: last-4 redaction (`String(p).slice(-4)`), matching sms.js/telegram.js.
- Call window: constants `CALL_WINDOW_START_HOUR = 8`, `CALL_WINDOW_END_HOUR = 21`, allowed when `start <= chicagoHourNow() < end`. Code constants, not env.
- Daily cap: `dailyCap()` = `parseInt(process.env.LEAD_CALL_DAILY_CAP, 10) || 25` (the `|| 25` fallback is load-bearing: an unset var must NOT become `count < NaN`, which is always false and would cap-trip every lead).
- No em dashes in any client-facing or spoken copy.
- Server test law: suites run ALONE against the shared dev DB: `node -r dotenv/config --test <file>`; cleanup in `after()`.
- Client gate (surfacing lane): `cd client && CI=true npx react-scripts build`.
- Git: explicit pathspec staging; footprint discipline (out-of-footprint need = ABORT and surface).

## Lane lead-call-core

- [ ] C1. **Schema.** Append the spec 4.1 `lead_call_attempts` block to `server/db/schema.sql` verbatim (statuses: `pending`,`calling_admin`,`calling_va`,`connected`,`missed`,`skipped_after_hours`,`skipped_unconfigured`,`skipped_invalid_phone`,`failed`; per-leg `admin_call_status`/`va_call_status`; `lead_id INTEGER NOT NULL UNIQUE REFERENCES thumbtack_leads(id) ON DELETE CASCADE`). Plus `CREATE INDEX IF NOT EXISTS idx_lead_call_attempts_status_created ON lead_call_attempts(status, created_at);` (plan-originated supporting index, not in spec 4.1: the 24h cap count and the attention query both filter on these columns). **Apply mechanism:** `schema.sql` auto-applies on server boot via `initDb` (`server/db/index.js`; README convention), and the dev server is a Claude-managed background process with NO auto-reload, so restart it explicitly, then verify the table exists (Neon dashboard or a `SELECT ... FROM information_schema.tables`). **Checkpoint: database-review agent on this task before dependent code.**
- [ ] C2. **PK threading in `server/routes/thumbtack.js`.** The lead INSERT (`thumbtack.js:436`) gains `RETURNING id`; capture as `leadRowId`. `runPostCommitSteps({ lead, clientId })` becomes `({ lead, clientId, leadId })`; normal path (`:479`) passes `leadRowId`, heal path (`:417`) passes `row.id` (already selected at `:377`). Existing tests still pass (`node -r dotenv/config --test server/routes/thumbtack.test.js`).
- [ ] C3. **`server/utils/businessTime.js`: `chicagoHourNow()`.** Returns integer 0-23 via `new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' })`, optional injectable instant: `chicagoHourNow(now = new Date())`. Add to the `module.exports` list at `businessTime.js:81`. Extend the EXISTING `businessTime.test.js`: `chicagoHourNow(new Date('2026-01-15T03:30:00Z')) === 21` (standard time), `chicagoHourNow(new Date('2026-06-15T13:30:00Z')) === 8` (DST), plus a no-arg 0-23 range assertion.
- [ ] C4. **`server/utils/leadCallBriefing.js`.** Pure `buildLeadBriefing(leadRow)` per spec 4.4: input is the DB-shaped row (`customer_name`, `category`, `event_date`, `guest_count`, `location_city`); output e.g. `"New Thumbtack lead: Sarah M. Wedding, Saturday October 10th, 6 PM, 120 guests, Naperville. Press 1 to call them now. Press 9 to hear this again."` Absent fields skipped (never "unknown"); null/absent row returns `"New Thumbtack lead. Press 1 to call them now. Press 9 to hear this again."`; date via Intl in America/Chicago (`weekday: 'long', month: 'long', day: 'numeric'` + hour/minute with dayPeriod), no numeric `10/10 18:00` forms. Returns PLAIN text; xmlEscape happens at the TwiML layer, not here. Tests: full row, each field individually absent, null row, midnight/noon rendering, a UTC `event_date` that crosses the Chicago date line.
- [ ] C5. **`server/utils/twilioSignature.js` extraction.** Move `isValidTwilioRequest(req)` (verbatim from `voice.js:40-52`) into the new util; `voice.js` requires it and keeps its own `passesSignature` policy and `__setVoiceDeps` seam unchanged (its default dep now points at the shared fn). `voice.test.js` still passes untouched.
- [ ] C6. **`server/utils/sms.js`: `timeout` passthrough.** `placeBridgedCall({ to, callerId, url, statusCallback, timeLimit, timeout })` forwards `timeout` to `calls.create` when present (Twilio ring-seconds). JSDoc updated to note the generic agent-leg use; dev-gate and redaction untouched. Existing `placeBridgedCall.test.js` passes; add one case asserting `timeout` reaches the stubbed `calls.create`.
- [ ] C7. **Notification category + template (BEFORE its consumers C8/C10/C11).** `adminNotifications.js` `VALID_CATEGORIES` += `'lead_call'`; `me.js` `NOTIFICATION_CATEGORIES` array (`me.js:19`) += `'lead_call'` (PATCH allowlist + settings list); `emailTemplates.js` gains `missedLeadCallAdmin({ customerName, category, eventDate, guestCount, locationCity, reason, adminUrl, proposalUrl })` (sibling of `newThumbtackLeadAdmin` at `:465`, added to the export list at `:789`; `reason` renders "missed", "call failed", or "daily cap tripped"; no em dashes in copy). `schema.sql` `notification_preferences` JSONB default += `"lead_call": true` (optional-but-tidy; COALESCE already defaults true). Note: `emailTemplates.js` is 813 lines, already over the 700 soft cap; this additive template triggers the non-blocking soft-cap warning and stays far under the 1000 hard cap, which is acceptable (the sibling-file split remains available later). **Own verification:** new `server/utils/emailTemplates.leadCall.test.js` renders the template for each `reason` and asserts subject/body contain the name and reason; extend `me.notificationPrefs.test.js` to assert `lead_call` is PATCHable and listed.
- [ ] C8. **`server/utils/leadCallTrigger.js`.** Exports `triggerLeadCall({ lead, leadId })`, `advanceChain({ attemptId, fromLeg })` (shared with the status webhook), and `__setDeps`. Implements spec 4.2 exactly, in order:
  1. `LEAD_CALL_ENABLED === 'false'` short-circuit (no row).
  2. Window: outside `8 <= chicagoHourNow() < 21` inserts `skipped_after_hours`, stop.
  3. Both `ADMIN_PHONE` and `VA_CELL` unset inserts `skipped_unconfigured`, stop.
  4. `toUsE164(lead.customerPhone)` (from `server/utils/usPhone.js`; it already blocks 900/976 and non-US NANP) null → insert `skipped_invalid_phone` (detail `no_phone` when the field was empty), stop.
  5. Atomic cap + idempotent insert in ONE statement, `$2 = dailyCap()`:
     ```sql
     INSERT INTO lead_call_attempts (lead_id, status)
     SELECT $1, 'pending'
     WHERE (SELECT COUNT(*) FROM lead_call_attempts
            WHERE created_at > NOW() - INTERVAL '24 hours'
              AND status NOT LIKE 'skipped%') < $2
     ON CONFLICT (lead_id) DO NOTHING
     ```
     rowCount 0 with no existing row for this lead = cap trip: insert a `failed` row (detail `cap_tripped`) via a second `ON CONFLICT DO NOTHING` insert, and email admin (C7 template, reason "daily cap tripped") only if this is the first `cap_tripped` in 24h (`SELECT COUNT(*) ... WHERE detail='cap_tripped' AND created_at > NOW() - INTERVAL '24 hours'` = 1). rowCount 0 with an existing row = duplicate webhook, stop silently.
  6. `advanceChain({ attemptId, fromLeg: null })`: claims `pending` → `calling_admin` (guarded UPDATE), winner places `placeBridgedCall({ to: ADMIN_PHONE, callerId: TWILIO_PHONE_NUMBER, url: <answer?attempt&leg=admin&play=1>, statusCallback: <status?attempt&leg=admin>, timeLimit: timeLimitSec(), timeout: 25 })` (local `timeLimitSec()` = the same `parseInt(VA_CALL_TIME_LIMIT_SEC, 10) || 1800` as `voice.js:90`, duplicated rather than exported), writes `admin_call_sid`; SID-write failure runs `cancelBridgedCall` (existing dead-bridge cleanup). `ADMIN_PHONE` unset skips straight to the VA claim. A leg's `calls.create` throw records `detail` + `<leg>_call_status='create_failed'` and falls through to the next leg; the last configured leg failing marks `failed` + one admin email (C7 template, reason "call failed").
  Callback URLs build from `process.env.API_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:5000'` (the `telegram.js:54` pattern). All wrapped so the caller (webhook tail) can never throw. Tests (stubbed deps, shared-DB law): every branch above, window boundaries via stubbed `chicagoHourNow` returning 7 / 8 / 20 / 21 (call placed only for 8 and 20), concurrent-insert cap atomicity (two parallel `triggerLeadCall` calls, cap 1: exactly one `pending`), duplicate-webhook silence, failover on create-throw, email-exactly-once, unset-`LEAD_CALL_DAILY_CAP` still caps at 25 (never `NaN`).
- [ ] C9. **Wire the trigger into `runPostCommitSteps`.** Third guarded step after the admin notification, mirroring the existing try/catch Sentry pattern (`thumbtack.js:299-346`): `await _deps.triggerLeadCall({ lead, leadId })`, added to `_deps` for testability. Tests: trigger failure does not affect webhook status; heal path fires it too; `SEND_NOTIFICATIONS` gating observed via the sms.js gate (no real dial in dev).
- [ ] C10. **`server/routes/voiceLeadCall.js`.** Express router mounted at `/api/voice/lead` (`server/index.js`, next to the `/api/voice` mount at `:310`). Signature gate: `requireSignature(req, res)` uses the shared `isValidTwilioRequest` (C5) but **403s in EVERY environment** (spec 4.3; telegram.js precedent), Sentry-tagged like `voice.js:74`. `__setDeps` seam for the gate, DB, `placeBridgedCall`, `notifyAdminCategory`. Endpoints:
  - `POST /answer?attempt&leg&play`: load attempt + lead row (JOIN); missing or terminal-status row → apology TwiML (`<Say>Sorry, this lead call has expired. Goodbye.</Say><Hangup/>`), never 500. Else `<Gather numDigits="1" timeout="10" action="<digit?attempt&leg&play>">` around `<Say>` xmlEscape(briefing), then a second `<Say>` of the briefing, then `<Hangup/>`.
  - `POST /digit`: `Digits === '1'` → guarded UPDATE `SET status='connected', answered_by=$leg, bridge_started_at=NOW(), updated_at=NOW() WHERE id=$1 AND status IN ('calling_admin','calling_va')`; winner responds `<Dial answerOnBridge="true" callerId="<VOICE_CALLER_ID>" timeLimit="<timeLimitSec()>"><Number statusCallback="<status?attempt&leg=lead>">toUsE164(lead phone)</Number></Dial>`; loser gets the apology TwiML. `Digits === '9'` → redirect-to-answer with `play+1`; `play >= 3` → apology-and-hangup. Any other digit → `<Hangup/>`.
  - `POST /status`: reads `CallStatus`, `CallDuration`. `leg=admin|va` terminal (`completed`,`no-answer`,`busy`,`failed`,`canceled`) while row still in that leg's `calling_*`: record `<leg>_call_status`, then admin → `advanceChain({ attemptId, fromLeg: 'admin' })` (claims `calling_va`, winner dials Zul), va → guarded UPDATE to `missed` whose winner sends the ONE `lead_call` email (C7 template, reason "missed") with the proposal/client admin URLs. `leg=lead` terminal: `bridge_duration_sec = Number.isInteger(parseInt(CallDuration, 10)) ? parseInt(CallDuration, 10) : NULL`; when `>= 20` flip the lead: `UPDATE thumbtack_leads SET status='contacted', updated_at=NOW() WHERE id=(SELECT lead_id FROM lead_call_attempts WHERE id=$1) AND status='new'`. Unknown `CallStatus` → log + 200, no state change. Always 200 with empty TwiML.
  Tests (stub gate + deps): every branch of every endpoint, duplicated VA-terminal callback places the PH leg once and emails once, press-1 vs status race (first writer wins), stale digit press, missing-row answer, non-integer CallDuration, 19s vs 20s flip boundary, hostile `customer_name` (`<Say>` payload escaped), signature-fail 403 with `NODE_ENV` unset AND `production`.
- [ ] C11. **Reaper.** `vaCallingScheduler.js` `pruneVaCallingRows()` gains a guarded sweep (the module gains `require('../db')` and the C7 template import; it currently only delegates, so both are new-but-in-footprint): `UPDATE lead_call_attempts SET status='failed', detail='stale_reaped', updated_at=NOW() WHERE status IN ('pending','calling_admin','calling_va') AND created_at < NOW() - INTERVAL '30 minutes' RETURNING id, lead_id`; each returned row sends the one `lead_call` email (reason "call failed"). `connected` rows are never touched. Tests in `vaCallingScheduler.test.js`: reaps only the three statuses, respects the 30-minute floor, emails per reaped row, leaves `connected` alone.
- [ ] C12. **Docs + env.** `.env.example` += `LEAD_CALL_ENABLED`, `LEAD_CALL_DAILY_CAP` with one-line comments; CLAUDE.md env table rows; README env table + folder tree (`voiceLeadCall.js`, `leadCallTrigger.js`, `leadCallBriefing.js`, `twilioSignature.js`) + Key Features bullet; ARCHITECTURE route table (three `/api/voice/lead/*` rows) + `lead_call_attempts` schema section + util mentions.
- [ ] C13. **Lane gate.** Full suite pass for every touched test file (one at a time, shared-DB law). **Review fleet, named: `security-review` (the fail-closed gate, PII-in-TwiML, dial-target validation, toll-fraud caps) + `code-review` + `database-review` + `consistency-check`, on the lane diff.** At push time, house law adds the sensitive-path full fleet re-review + `/second-opinion`; the push-time `consistency-check` must confirm the `lead_call` category end to end across BOTH lanes (server category lands here, client label lands in surfacing). Manual dev check: with `SEND_NOTIFICATIONS` off, POST a synthetic TT lead to the local webhook and confirm the `[DEV] Bridged call skipped` log line, a `calling_admin` row, and clean `skipped_after_hours` / `skipped_invalid_phone` rows for a stubbed 10pm-Chicago clock and a `+44` phone.

## Lane lead-call-surfacing

- [ ] S1. **`server/routes/admin/leadCalls.js`.** `GET /api/admin/lead-call-attention` (`auth` + `requireAdminOrManager`, the `admin/settings.js:126` badge-counts pattern; mount in `server/routes/admin/index.js`). One query:
  ```sql
  SELECT a.id, a.status, a.detail, a.created_at,
         l.customer_name, l.proposal_id, l.client_id
  FROM lead_call_attempts a
  JOIN thumbtack_leads l ON l.id = a.lead_id
  WHERE a.status IN ('missed','failed','skipped_after_hours','skipped_unconfigured','skipped_invalid_phone')
    AND a.created_at > NOW() - INTERVAL '7 days'
    AND l.status = 'new'
  ORDER BY a.created_at DESC
  ```
  snake_case JSON array. Driven FROM `lead_call_attempts`, so pre-feature leads never surface. Tests: shape, 7-day cutoff, `connected` excluded, contacted-lead excluded, role guard (staff 403).
- [ ] S2. **Overview wiring.** `OverviewPage.js`: one new `api.get('/admin/lead-call-attention')` effect (pattern of the `/stripe-payouts` fetch at `:155`), state `leadCallAttention`. `queueItems.js`: `buildLeadCallItems(rows, nowMs)` returning items `{ id: 'leadcall-'+r.id, type: 'lead-call', priority: 'warn', title: (r.customer_name || 'Thumbtack lead') + ' ' + label, sub: <hours-or-days-ago string, same day-math as buildSalesItems:76>, meta: '', target, ref }` with label map `missed: 'missed call'`, `failed: 'call failed'`, `skipped_after_hours: 'after hours'`, `skipped_unconfigured` / `skipped_invalid_phone`: `'call misconfigured'`; `target`/`ref`: `proposal_id` → `('proposal', proposal_id)`, else `client_id` → `('client', client_id)`, else `(null, null)` (plain-text row, existing targetless behavior). **Merge point (feasibility fix): NOT inside `computeTabs`** (it receives `sales` prebuilt); prepend in `OverviewPage.js` where `salesItems` is assembled (`:227-:230`): `sales: [...leadCallItems, ...salesItems]` (array order IS the display order; misses outrank stale sends). `NeedsYouStrip.js`: `queueItemHref` += `if (a.target === 'client') return '/clients/' + a.ref;`; `QUEUE_ICON['lead-call'] = 'alert'` (icon name verified to exist).
- [ ] S3. **Proposal detail line.** `proposals/getOne.js`: additive `lead_call` field via
  ```sql
  SELECT a.status, a.answered_by, a.bridge_duration_sec, a.created_at
  FROM lead_call_attempts a JOIN thumbtack_leads l ON l.id = a.lead_id
  WHERE l.proposal_id = $1
  ```
  (null when absent; getOne stays mounted LAST, an additive field does not disturb the path-ordering constraint). `ProposalDetail.js`: one read-only line in the existing Thumbtack/lead metadata region: `connected` → `"Lead call: connected (<answered_by === 'admin' ? 'Dallas' : 'Zul'>, <m:ss from bridge_duration_sec>)"`; `missed`/`failed` → `"Lead call: missed"` / `"Lead call: failed"`; `skipped_after_hours` → `"Lead call: after hours"`; other skips → `"Lead call: not placed"`; absent field renders nothing (pre-feature and non-TT proposals). No loading spinner: it rides the existing getOne fetch. **In-task checkpoint (decomposition fix):** extend the getOne route test here (field present with a seeded attempt row, null without) rather than deferring to S4.
- [ ] S4. **Settings label + gates.** `NotificationSettings.js` `CATEGORY_LABELS.lead_call = { label: 'Missed lead calls', help: 'Both of you missed a Thumbtack lead call, or a call failed.' }`. Client build gate `CI=true npx react-scripts build`. Manual dev check: seed a `missed` row for a dev lead, see the Sales-tab item, click through to the proposal, see the outcome line, toggle the category in Notification Settings.
- [ ] S5. **Docs.** README tree row (`admin/leadCalls.js`); ARCHITECTURE route row (`GET /api/admin/lead-call-attention`) + getOne field note. Resolve the trivial README/ARCHITECTURE overlap with the core lane at merge (second-to-merge rebases the doc hunks).
- [ ] S6. **Lane gate.** Review fleet, named: `code-review` + `security-review` (new admin endpoint: role guard, IDOR-free by construction) + `consistency-check` (the `lead_call` category's client half; the getOne field's consumers), re-confirmed against main's HEAD at merge.

## Launch checklist (ops, Dallas-driven, NOT a lane)

- [ ] L1. Add the 224 (`(224) 222-0082`) to the Thumbtack business profile (888 already on file).
- [ ] L2. **Before pushing the lanes:** set `LEAD_CALL_ENABLED=false` in Render (default is ON; the var must exist before first deploy ships the code).
- [ ] L3. Live relay go/no-go (spec section 8): quiet moment, flip `LEAD_CALL_ENABLED=true` (env change restarts the service), next masked 839 lead with Dallas on the line: briefing plays, press 1, relay connects from the 224, two-way audio. Refusal → flip off, regroup on the fallback (briefing-only alert calls).
- [ ] L4. First week: check `lead_call_attempts` for near-zero `bridge_duration_sec` on `connected` rows (silent relay failure) before trusting unattended.
