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
      - server/routes/voice.js                    # SHRINKS: imports the extracted helper, behavior unchanged
      - server/utils/leadCallBriefing.js          # new: pure TTS briefing builder
      - server/utils/leadCallBriefing.test.js
      - server/utils/businessTime.js              # new chicagoHourNow() helper
      - server/utils/businessTime.test.js
      - server/utils/sms.js                       # placeBridgedCall optional timeout passthrough
      - server/utils/vaCallingScheduler.js        # stale-attempt reaper rides the hourly pass
      - server/utils/vaCallingScheduler.test.js
      - server/utils/adminNotifications.js        # VALID_CATEGORIES + 'lead_call'
      - server/routes/me.js                       # NOTIFICATION_CATEGORIES mirror + PATCH allowlist
      - server/utils/emailTemplates.js            # missedLeadCallAdmin template (additive)
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
      - client/src/pages/admin/overview/OverviewPage.js   # fetch the new source
      - client/src/pages/admin/overview/queueItems.js     # buildLeadCallItems + Sales-tab merge
      - client/src/pages/admin/overview/NeedsYouStrip.js  # 'client' href target + QUEUE_ICON entry
      - client/src/pages/admin/ProposalDetail.js  # call-outcome line
      - client/src/pages/admin/NotificationSettings.js    # CATEGORY_LABELS entry
      - README.md
      - ARCHITECTURE.md
    blockedBy: [lead-call-core]
    review: full-fleet   # touches proposals getOne + a new admin endpoint
---

# Thumbtack Lead Call Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **House override:** this repo executes plans through the lane model (CLAUDE.md): one worktree lane per lane id, checkpoint commits in-lane, squash merge to main. Run order (encoded in blockedBy): `lead-call-core`, then `lead-call-surfacing`. The Launch checklist is NOT a lane: Dallas-driven ops steps gating go-live.

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
- No em dashes in any client-facing or spoken copy.
- Server test law: suites run ALONE against the shared dev DB: `node -r dotenv/config --test <file>`; cleanup in `after()`.
- Client gate (surfacing lane): `cd client && CI=true npx react-scripts build`.
- Git: explicit pathspec staging; footprint discipline (out-of-footprint need = ABORT and surface).

## Lane lead-call-core

- [ ] C1. **Schema.** Append the spec 4.1 `lead_call_attempts` block to `server/db/schema.sql` verbatim (statuses: `pending`,`calling_admin`,`calling_va`,`connected`,`missed`,`skipped_after_hours`,`skipped_unconfigured`,`skipped_invalid_phone`,`failed`; per-leg `admin_call_status`/`va_call_status`; `lead_id INTEGER NOT NULL UNIQUE REFERENCES thumbtack_leads(id) ON DELETE CASCADE`). Plus `CREATE INDEX IF NOT EXISTS idx_lead_call_attempts_status_created ON lead_call_attempts(status, created_at);` (the attention query and the 24h cap count both filter on these). Apply to dev DB, verify with `\d lead_call_attempts` equivalent. **Checkpoint: database-review agent on this task before dependent code.**
- [ ] C2. **PK threading in `server/routes/thumbtack.js`.** The lead INSERT (`thumbtack.js:436`) gains `RETURNING id`; capture as `leadRowId`. `runPostCommitSteps({ lead, clientId })` becomes `({ lead, clientId, leadId })`; normal path (`:479`) passes `leadRowId`, heal path (`:417`) passes `row.id` (already selected at `:377`). Existing tests still pass (`node -r dotenv/config --test server/routes/thumbtack.test.js`).
- [ ] C3. **`server/utils/businessTime.js`: `chicagoHourNow()`.** Returns integer 0-23 via `new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' })` (same Intl pattern as `chicagoYmdOf`). Export alongside existing helpers. Test in `businessTime.test.js` (new file if absent): mock-free assertion that the value is 0-23 plus a formatter-level check of a known UTC instant in both DST (June) and standard (January) time via an injectable `now` param: `chicagoHourNow(new Date('2026-01-15T03:30:00Z')) === 21`, `chicagoHourNow(new Date('2026-06-15T13:30:00Z')) === 8`.
- [ ] C4. **`server/utils/leadCallBriefing.js`.** Pure `buildLeadBriefing(leadRow)` per spec 4.4: input is the DB-shaped row (`customer_name`, `category`, `event_date`, `guest_count`, `location_city`); output e.g. `"New Thumbtack lead: Sarah M. Wedding, Saturday October 10th, 6 PM, 120 guests, Naperville. Press 1 to call them now. Press 9 to hear this again."` Absent fields skipped (never "unknown"); null/absent row returns `"New Thumbtack lead. Press 1 to call them now. Press 9 to hear this again."`; date via Intl in America/Chicago (`weekday: 'long', month: 'long', day: 'numeric'` + `hour`/`minute` with dayPeriod), no numeric `10/10 18:00` forms. Returns PLAIN text; xmlEscape happens at the TwiML layer, not here. Tests: full row, each field individually absent, null row, midnight/noon rendering, a UTC `event_date` that crosses the Chicago date line.
- [ ] C5. **`server/utils/twilioSignature.js` extraction.** Move `isValidTwilioRequest(req)` (verbatim from `voice.js:40-52`) into the new util; `voice.js` requires it and keeps its own `passesSignature` policy and `__setVoiceDeps` seam unchanged (its default dep now points at the shared fn). `voice.test.js` still passes untouched.
- [ ] C6. **`server/utils/sms.js`: `timeout` passthrough.** `placeBridgedCall({ to, callerId, url, statusCallback, timeLimit, timeout })` forwards `timeout` to `calls.create` when present (Twilio ring-seconds). JSDoc updated to note the generic agent-leg use; dev-gate and redaction untouched. Existing `placeBridgedCall.test.js` passes; add one case asserting `timeout` reaches the stubbed `calls.create`.
- [ ] C7. **`server/utils/leadCallTrigger.js`.** Exports `triggerLeadCall({ lead, leadId })`, `advanceChain({ attemptId, fromLeg })` (shared with the status webhook), and `__setDeps`. Implements spec 4.2 exactly, in order:
  1. `LEAD_CALL_ENABLED === 'false'` short-circuit (no row).
  2. Window: outside `8 <= chicagoHourNow() < 21` inserts `skipped_after_hours`, stop.
  3. Both `ADMIN_PHONE` and `VA_CELL` unset inserts `skipped_unconfigured`, stop.
  4. `toUsE164(lead.customerPhone)` (from `server/utils/usPhone.js`; it already blocks 900/976 and non-US NANP) null → insert `skipped_invalid_phone` (detail `no_phone` when the field was empty), stop. Store nothing else; the validated E.164 is re-derived by the digit webhook from the lead row.
  5. Atomic cap + idempotent insert in ONE statement:
     ```sql
     INSERT INTO lead_call_attempts (lead_id, status)
     SELECT $1, 'pending'
     WHERE (SELECT COUNT(*) FROM lead_call_attempts
            WHERE created_at > NOW() - INTERVAL '24 hours'
              AND status NOT LIKE 'skipped%') < $2
     ON CONFLICT (lead_id) DO NOTHING
     ```
     rowCount 0 with no existing row for this lead = cap trip: insert a `failed` row (detail `cap_tripped`) via a second `ON CONFLICT DO NOTHING` insert, and email admin only if this is the first `cap_tripped` in 24h (`SELECT COUNT(*) ... detail='cap_tripped' AND created_at > NOW() - INTERVAL '24 hours'` = 1). rowCount 0 with an existing row = duplicate webhook, stop silently.
  6. `advanceChain({ attemptId, fromLeg: null })`: claims `pending` → `calling_admin` (guarded UPDATE), winner places `placeBridgedCall({ to: ADMIN_PHONE, callerId: TWILIO_PHONE_NUMBER, url: <answer?attempt&leg=admin&play=1>, statusCallback: <status?attempt&leg=admin>, timeLimit: timeLimitSec(), timeout: 25 })` (local `timeLimitSec()` = the same 2-line `parseInt(VA_CALL_TIME_LIMIT_SEC) || 1800` as `voice.js:90`, duplicated rather than exported), writes `admin_call_sid`; SID-write failure runs `cancelBridgedCall` (existing dead-bridge cleanup). `ADMIN_PHONE` unset skips straight to the VA claim. A leg's `calls.create` throw records `detail` + `<leg>_call_status='create_failed'` and falls through to the next leg; the last configured leg failing marks `failed` + one admin email.
  Callback URLs build from the same base resolution voice.js uses (`API_URL` / `RENDER_EXTERNAL_URL`). All wrapped so the caller (webhook tail) can never throw. Tests (stubbed deps, shared-DB law): every branch above, including concurrent-insert cap atomicity (two parallel `triggerLeadCall` calls, cap 1: exactly one `pending`), duplicate-webhook silence, failover on create-throw, email-exactly-once.
- [ ] C8. **Wire the trigger into `runPostCommitSteps`.** Third guarded step after the admin notification, mirroring the existing try/catch Sentry pattern (`thumbtack.js:299-346`): `await _deps.triggerLeadCall({ lead, leadId })`, added to `_deps` for testability. Tests: trigger failure does not affect webhook status; heal path fires it too; `SEND_NOTIFICATIONS` gating observed via the sms.js gate (no real dial in dev).
- [ ] C9. **`server/routes/voiceLeadCall.js`.** Express router mounted at `/api/voice/lead` (`server/index.js`, next to the `/api/voice` mount at `:310`). Signature gate: `requireSignature(req, res)` uses the shared `isValidTwilioRequest` but **403s in EVERY environment** (spec 4.3; telegram.js precedent), Sentry-tagged like `voice.js:74`. `__setDeps` seam for the gate, DB, `placeBridgedCall`, `notifyAdminCategory`. Endpoints:
  - `POST /answer?attempt&leg&play`: load attempt + lead row (JOIN); missing or terminal-status row → apology TwiML (`<Say>Sorry, this lead call has expired. Goodbye.</Say><Hangup/>`), never 500. Else `<Gather numDigits="1" timeout="10" action="<digit?attempt&leg&play>">` around `<Say>` xmlEscape(briefing), then a second `<Say>` of the briefing, then `<Hangup/>`.
  - `POST /digit`: `Digits === '1'` → guarded UPDATE `SET status='connected', answered_by=$leg, bridge_started_at=NOW(), updated_at=NOW() WHERE id=$1 AND status IN ('calling_admin','calling_va')`; winner responds `<Dial answerOnBridge="true" callerId="<VOICE_CALLER_ID>" timeLimit="<timeLimitSec()>"><Number statusCallback="<status?attempt&leg=lead>">toUsE164(lead phone)</Number></Dial>`; loser gets the apology TwiML. `Digits === '9'` → redirect-to-answer with `play+1`; `play >= 3` → apology-and-hangup. Any other digit → `<Hangup/>`.
  - `POST /status`: reads `CallStatus`, `CallDuration`. `leg=admin|va` terminal (`completed`,`no-answer`,`busy`,`failed`,`canceled`) while row still in that leg's `calling_*`: record `<leg>_call_status`, then admin → `advanceChain({ attemptId, fromLeg: 'admin' })` (claims `calling_va`, winner dials Zul), va → guarded UPDATE to `missed` whose winner sends the ONE `lead_call` email (template task C10) with the proposal/client admin URLs. `leg=lead` terminal: `bridge_duration_sec = Number.isInteger(parseInt(CallDuration, 10)) ? parseInt(CallDuration, 10) : NULL`; when `>= 20` flip the lead: `UPDATE thumbtack_leads SET status='contacted', updated_at=NOW() WHERE id=(SELECT lead_id FROM lead_call_attempts WHERE id=$1) AND status='new'`. Unknown `CallStatus` → log + 200, no state change. Always 200 with empty TwiML.
  Tests (stub gate + deps): every branch of every endpoint, duplicated VA-terminal callback places the PH leg once and emails once, press-1 vs status race (first writer wins), stale digit press, missing-row answer, non-integer CallDuration, 19s vs 20s flip boundary, hostile `customer_name` (`<Say>` payload escaped), signature-fail 403 with `NODE_ENV` unset AND `production`.
- [ ] C10. **Notification category + template.** `adminNotifications.js` `VALID_CATEGORIES` += `'lead_call'`; `me.js` `NOTIFICATION_CATEGORIES` array += `'lead_call'` (PATCH allowlist + settings list); `emailTemplates.js` gains `missedLeadCallAdmin({ customerName, category, eventDate, guestCount, locationCity, reason, adminUrl, proposalUrl })` (sibling of `newThumbtackLeadAdmin` at `:465`, exported at the bottom; `reason` renders "missed", "call failed", or "daily cap tripped"; no em dashes in copy). schema.sql `notification_preferences` JSONB default += `"lead_call": true` (optional-but-tidy; COALESCE already defaults true).
- [ ] C11. **Reaper.** `vaCallingScheduler.js` `pruneVaCallingRows()` gains a guarded sweep: `UPDATE lead_call_attempts SET status='failed', detail='stale_reaped', updated_at=NOW() WHERE status IN ('pending','calling_admin','calling_va') AND created_at < NOW() - INTERVAL '30 minutes' RETURNING id, lead_id` ; each returned row sends the one `lead_call` email (reuse the missed template, reason "call failed"). `connected` rows are never touched. Tests in `vaCallingScheduler.test.js`: reaps only the three statuses, respects the 30-minute floor, emails per reaped row, leaves `connected` alone.
- [ ] C12. **Docs + env.** `.env.example` += `LEAD_CALL_ENABLED`, `LEAD_CALL_DAILY_CAP` with one-line comments; CLAUDE.md env table rows; README env table + folder tree (`voiceLeadCall.js`, `leadCallTrigger.js`, `leadCallBriefing.js`, `twilioSignature.js`) + Key Features bullet; ARCHITECTURE route table (three `/api/voice/lead/*` rows) + `lead_call_attempts` schema section + util mentions.
- [ ] C13. **Lane gate.** Full suite pass for every touched test file (one at a time, shared-DB law). **Full review fleet on the lane diff (sensitive path: billed voice, webhook surfaces, TT tail), plus `/second-opinion` at push time per house law.** Manual dev check: with `SEND_NOTIFICATIONS` off, POST a synthetic TT lead to the local webhook and confirm the `[DEV] Bridged call skipped` log line, a `calling_admin` row, and clean `skipped_after_hours` / `skipped_invalid_phone` rows for a 10pm-Chicago clock stub and a `+44` phone.

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
- [ ] S2. **Overview wiring.** `OverviewPage.js`: one new `api.get('/admin/lead-call-attention')` effect (pattern of the `/stripe-payouts` fetch at `:155`), state `leadCallAttention`. `queueItems.js`: `buildLeadCallItems(rows)` returning items `{ id: 'leadcall-'+r.id, type: 'lead-call', priority: 'warn', title: (r.customer_name || 'Thumbtack lead') + ' ' + label, sub: <hours-or-days-ago string, same `Math.floor((nowMs - Date.parse(...)) / 86400e3)` arithmetic as buildSalesItems:76>, meta: '', target, ref }` with label map `missed: 'missed call'`, `failed: 'call failed'`, `skipped_after_hours: 'after hours'`, `skipped_unconfigured`/`skipped_invalid_phone`: `'call misconfigured'`; `target`/`ref`: `proposal_id` → `('proposal', proposal_id)`, else `client_id` → `('client', client_id)`, else `(null, null)` (plain-text row). Merge into the Sales tab inside `computeTabs` ahead of the unviewed-proposal items (misses outrank stale sends). `NeedsYouStrip.js`: `queueItemHref` += `if (a.target === 'client') return '/clients/' + a.ref;`; `QUEUE_ICON['lead-call'] = 'alert'`. Tests: none client-side (no client test harness); covered by S4's build gate + manual check.
- [ ] S3. **Proposal detail line.** `proposals/getOne.js`: additive `lead_call` field via
  ```sql
  SELECT a.status, a.answered_by, a.bridge_duration_sec, a.created_at
  FROM lead_call_attempts a JOIN thumbtack_leads l ON l.id = a.lead_id
  WHERE l.proposal_id = $1
  ```
  (null when absent). `ProposalDetail.js`: one read-only line in the existing Thumbtack/lead metadata region: `connected` → `"Lead call: connected (<answered_by === 'admin' ? 'Dallas' : 'Zul'>, <m:ss from bridge_duration_sec>)"`; `missed`/`failed` → `"Lead call: missed"` / `"Lead call: failed"`; `skipped_after_hours` → `"Lead call: after hours"`; other skips → `"Lead call: not placed"`; absent field renders nothing (pre-feature and non-TT proposals). No loading spinner: it rides the existing getOne fetch.
- [ ] S4. **Settings label + gates.** `NotificationSettings.js` `CATEGORY_LABELS.lead_call = { label: 'Missed lead calls', help: 'Both of you missed a Thumbtack lead call, or a call failed.' }`. Then: `getOne` route test extended for the new field (present/absent); client build gate `CI=true npx react-scripts build`; manual dev check: seed a `missed` row for a dev lead, see the Sales-tab item, click through to the proposal, see the outcome line, toggle the category in Notification Settings.
- [ ] S5. **Docs.** README tree row (`admin/leadCalls.js`); ARCHITECTURE route row (`GET /api/admin/lead-call-attention`) + getOne field note.
- [ ] S6. **Lane gate.** Full review fleet on the lane diff (getOne + new admin endpoint), re-confirmed against main's HEAD at merge.

## Launch checklist (ops, Dallas-driven, NOT a lane)

- [ ] L1. Add the 224 (`(224) 222-0082`) to the Thumbtack business profile (888 already on file).
- [ ] L2. **Before pushing the lanes:** set `LEAD_CALL_ENABLED=false` in Render (default is ON; the var must exist before first deploy ships the code).
- [ ] L3. Live relay go/no-go (spec section 8): quiet moment, flip `LEAD_CALL_ENABLED=true` (env change restarts the service), next masked 839 lead with Dallas on the line: briefing plays, press 1, relay connects from the 224, two-way audio. Refusal → flip off, regroup on the fallback (briefing-only alert calls).
- [ ] L4. First week: check `lead_call_attempts` for near-zero `bridge_duration_sec` on `connected` rows (silent relay failure) before trusting unattended.
