---
spec: docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md   # rev 3 plus section 10 (spike results, GO); plan rev 4 folds the three-agent plan review and three re-verifies
lanes:
  - id: gv-post-server
    footprint:
      - .claude/CLAUDE.md
      - .env.example
      - ARCHITECTURE.md
      - README.md
      - scripts/sensitive-paths.txt
      - server/db/schema.sql
      - server/db/index.js
      - server/db/constraintContract.test.js
      - server/db/criticalIndexes.test.js
      - server/index.js
      - server/utils/gvPost/*.js
      - server/utils/gvPostSweepScheduler.js
      - server/utils/gvPostSweepScheduler.test.js
      - server/routes/gvAgent.js
      - server/routes/gvAgent*.test.js
      - server/routes/comms.js
      - server/routes/comms.gvPost.test.js
      - server/utils/sendProposalSentEmail.js
      - server/utils/sendProposalSentEmail.gvPost.test.js
      - server/utils/comms/actions/proposalResend.js
      - server/utils/comms/actions/proposalResend.gvPost.test.js
    blockedBy: []
    review: full-fleet + second-opinion at lane end; database-review after Task 1, code-review + consistency-check after Task 5, security-review after Task 7   # outward texts from Dallas's personal GV, a new agent secret, schema, the live proposal send path
  - id: gv-post-ui
    footprint:
      - server/routes/proposals/getOne.js
      - server/routes/proposals/getOne.gvPost.test.js
      - client/src/components/GvPostStatus.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/components/SendModal/SendModal.jsx
      - client/src/components/SendModal/sendResult.js
      - client/src/components/SendModal/sendResult.test.js
      - README.md
      - ARCHITECTURE.md
    blockedBy: [gv-post-server]
    review: code-review + ui-ux-review
  - id: gv-post-inbox
    footprint:
      - server/utils/inbox/constants.js
      - server/utils/inbox/readThumbtack.js
      - server/utils/inbox/readMessageLog.js
      - server/utils/inbox/normalize.js
      - server/utils/inbox/thread.js
      - server/utils/inbox/normalize.test.js
      - server/utils/inbox/readers.test.js
      - server/utils/inbox/thread.test.js
    blockedBy: [gv-post-server]
    review: full-fleet   # server/utils/inbox/** is sensitive
  - id: gv-sender
    footprint:
      - gv-agent/package.json
      - gv-agent/package-lock.json
      - gv-agent/.env.example
      - gv-agent/README.md
      - gv-agent/systemd/gv-agent.service
      - gv-agent/src/*.js
    blockedBy: []   # code only; built against the Task 7 API contract; merges AFTER gv-post-server so its sensitive-paths line is already on main
    review: full-fleet   # drives Dallas's personal Google account; the at-most-once send law
  - id: gv-sender-live
    footprint:
      - gv-agent/src/*.js   # only if a dry run pins a selector, copy or link format that moved since the spike
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
    blockedBy: [gv-post-server, gv-sender]
    review: code-review   # box dry runs plus docs
mergeOrder: gv-post-server first (it carries the sensitive-paths lines and the shared docs rows); then gv-sender, gv-post-ui, gv-post-inbox in any order; gv-sender-live last.
pushGate: Ships dark. GV_PROPOSAL_POST_ENABLED stays unset in Render until the gv-agent service runs on the box with GV_AGENT_SECRET set on both sides and the gv-sender-live dry runs pass (Rollout below). The flip is Dallas's, at a quiet moment; the first relay proposal after it is the live proof.
---

# Proposal link into the Thumbtack thread through Google Voice: implementation plan (rev 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an admin sends or resends a proposal to a Thumbtack relay client, the box posts the proposal text through Google Voice into the customer's Thumbtack thread instead of the 888 text. Today's text goes out instead whenever the post definitely did not happen.

**Architecture:** The proposal-text choke points ask one router (`routeProposalText`) whether to queue a GV post or text from the 888. Queued posts live in `gv_posts`. A box service (`gv-agent/`) leases one at a time over a secret-gated API, sends through the spike-proven GV web flow, and reports back. A 60-second sweep drains stale rows to the 888 fallback and raises one email per outage. "In the thread" is derived at read time from `thumbtack_messages`.

**Tech Stack:**
- Server: Node, Express, raw SQL on Neon Postgres, `node --test`.
- Client: React 18 (CRA).
- Box agent: Playwright with `channel: 'chrome'` under `xvfb-run`, the same recipe as `thumbtack-agent`.
- No new npm dependency in the server or client. `gv-agent` pins `playwright` `^1.61.0` (the `thumbtack-agent` range) and `dotenv`.

**Spec:** `docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md`. Read sections 5, 6 and 10 before any task.

## Global Constraints

- The repo is public: no real person's name, email or phone number in code, tests, fixtures, commits or docs. Fixtures use invented names and `555-01xx` numbers.
- Dev DB is shared: one suite at a time (`node --test <file>` from the repo root), no TEMP tables, read the pass count. Each new DB test file starts with `require('dotenv').config()`, a production guard, and `process.env.SEND_NOTIFICATIONS = 'false'`. Tests that need the router's notifications gate open inject it through `__setDeps` (Task 4); they never set `SEND_NOTIFICATIONS=true`, so `sendSMS` stays on its dev-skip path.
- No em dashes in copy or docs. API JSON snake_case, JS camelCase. Errors are `AppError` subclasses; `ValidationError(fieldErrors, message)` passes the copy as both. Parameterized SQL only. Schema statements are idempotent, and enumerated CHECKs are drop-and-re-add `DO` blocks.
- Kill switch: `GV_PROPOSAL_POST_ENABLED === 'true'` only. Off means exactly today's behavior (spec law 2).
- Never a phone number in logs, UI, diag file names or Sentry beyond last-4 (spec law 11).
- One pooled connection per request. Release the client BEFORE calling `sendGvFallback` or `notifyAdminCategory`, both of which take their own connections.
- No new writer of `initial_proposal` or `proposal_sent_sms`. The 888 fallback calls the existing send sites, so `server/utils/answeringMessageTypes.test.js` passes unchanged.
- The GV sender never touches the Call panel, except to read that its input is empty (spec section 10, the call-dialer trap).
- No agent may poll a dev or lane server with `GV_PROPOSAL_POST_ENABLED=true` while any task's hand-inserted `gv_posts` fixture row exists. Every task deletes its fixtures (rows, invented clients, leads, proposals) in `after()` or a final step.
- Every lane: the review named in front-matter, `npm run check:filesize`, files under 700 lines. `ProposalDetail.js` is 968 lines and stays under 1000.
- Lanes are cut with `npm run worktree:new <lane-id>`, squash-merged from `os` by `scripts/merge-lane.sh` in `mergeOrder`, and never pushed without Dallas's own imperative cue.

## Decisions made in planning (builder calls inside the spec's laws)

1. **The lease carries no request id.** The GV notice's `bids/{id}` IS `thumbtack_leads.negotiation_id`. The spec is amended to match.
2. **Four env vars:** `GV_PROPOSAL_POST_ENABLED`, `GV_AGENT_SECRET`, `RUN_GV_POST_SWEEP_SCHEDULER` and `GV_POST_DAILY_CAP` (default 25, via `readEnvInt`). Every other window is a constant in `server/utils/gvPost/rules.js`.
3. **One job per lease.**
4. **The relay flag lives in `resolveRecipient`.** It is already async; `resolveFromRow` stays sync and unchanged. The spec is amended to match.
5. **The 888 fallback goes back through the path that queued the post:** `sendInitialProposalText` for `send_path 'auto'` (the lifecycle and crud sends) and `sendResendText` for `'compose'` (the SendModal send and resend). Each still holds its one pinned write literal.
6. **`gv_posts` rows are never pruned.** The token in a post body already lives in `thumbtack_messages`, and the Inbox (whose floor is fixed) needs the rows to read old sends. Diag captures are pruned by age and count. The spec is amended to match.
7. **No unread restore.** The box's send marks that GV conversation read, the same as Dallas opening it. Restoring it would mean clicking a thread menu where Delete and Block sit; dropped as beyond the spec.
8. **Spike check 3 passed, so `no_thread` names no real outcome.** It stays in the whitelist per the spec, but nothing reports it. Any "Send to" mismatch is `ui_error_before_send`, which counts toward the outage email.

## Review Focus

Inputs the spec implies that no task's tests would otherwise exercise; each line's test is pinned to the task named.
1. **An admin double-clicks Send or Resend.** One `gv_posts` row, and the second call returns `merged`, with no 888 text, no second post and no spacing trip. Test: Task 4, `concurrent routes for one proposal yield one row and one merged`.
2. **The proposal is archived, or the client opts out, between enqueue and lease.** The row ends `cancelled` with no fallback text. Test: Task 7, `lease cancels an archived proposal without a fallback`.
3. **A box report lands after the sweep marked the row `unknown`.** It is ignored and no fallback goes out. Test: Task 7, `report on a non-leased row is ignored`.
4. **The flag is flipped off with rows queued.** The lease returns `[]`, the sweep still stales each row and sends exactly one fallback, and no outage email goes out. Test: Task 9, `flag off drains queued rows to one fallback each and emails nobody`.
5. **The box crashes after clicking Send and restarts.** It reports `clicked_unverified` and never re-sends. Test: Task 15, `a journaled job id is reported clicked_unverified and never re-sent`.

---

## Lane gv-post-server

### Task 1: Schema, boot contract, sensitive paths

**Files:**
- Modify: `server/db/schema.sql` (append at the END of the file)
- Modify: `server/db/index.js` (`CRITICAL_INDEXES`, `CONSTRAINT_CONTRACT`)
- Modify: `server/db/constraintContract.test.js`, `server/db/criticalIndexes.test.js`
- Modify: `scripts/sensitive-paths.txt` (add `server/utils/gvPost/*.js`, `server/routes/gvAgent.js`, `server/utils/sendProposalSentEmail.js`, `gv-agent/src/*.js`)

**Interfaces:**
- Produces: table `gv_posts` with columns
  - `id` SERIAL PK
  - `proposal_id` INT NOT NULL FK proposals ON DELETE CASCADE
  - `client_id` INT FK clients SET NULL
  - `lead_id` INT FK thumbtack_leads SET NULL
  - `negotiation_id` VARCHAR(100) NOT NULL (matches `thumbtack_leads`)
  - `body` TEXT NOT NULL
  - `send_path` TEXT NOT NULL
  - `sent_by` INT FK users SET NULL
  - `status` TEXT NOT NULL DEFAULT 'queued'
  - `reason` TEXT
  - `fallback_status` TEXT
  - `fallback_at` TIMESTAMPTZ (stamped by the fallback claim, right before the 888 send)
  - `leased_at`, `reported_at`, `clicked_at` TIMESTAMPTZ
  - `created_at`, `updated_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Produces: CHECKs (one `DO` block each):
  - `gv_posts_status_check`: status IN ('queued','leased','sent','clicked_unverified','failed_preclick','skipped_already_posted','stale','unknown','cancelled')
  - `gv_posts_send_path_check`: send_path IN ('auto','compose')
  - `gv_posts_fallback_status_check`: fallback_status NULL or IN ('claimed','sent','suppressed','failed')
- Produces: indexes
  - `uq_gv_posts_open_per_proposal` UNIQUE (proposal_id) WHERE status IN ('queued','leased')
  - `idx_gv_posts_queued` (created_at) WHERE status = 'queued'
  - `idx_gv_posts_proposal` (proposal_id, created_at DESC)
  - `idx_gv_posts_negotiation` (negotiation_id)
- Produces: table `gv_sender_state`, with `id` SMALLINT PK DEFAULT 1 CHECK (id = 1), `outage_since`, `outage_reason`, `outage_alerted_at`, `last_lease_at`, `last_success_at`, `consecutive_preclick_failures` INT NOT NULL DEFAULT 0, and `updated_at`. Seed it with `INSERT INTO gv_sender_state (id) VALUES (1) ON CONFLICT DO NOTHING`.
- No phone number column.

- [ ] **Step 1: Write the failing tests.** In `constraintContract.test.js`, assert a `gv_posts_status_check` entry whose `mustContain` lists all nine statuses. In `criticalIndexes.test.js`, assert `uq_gv_posts_open_per_proposal` is listed.
- [ ] **Step 2: Run** `node --test server/db/constraintContract.test.js`, then `node --test server/db/criticalIndexes.test.js`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Add the schema, the contract entries and the sensitive paths.**
- [ ] **Step 4: Apply twice on dev:** `node -e "require('dotenv').config(); require('./server/db').initDb().then(()=>{console.log('ok');process.exit(0)})"`. Expected: `ok` twice, with no `unexpected` warning naming `gv_`. Then run, one at a time: `constraintContract.test.js`, `criticalIndexes.test.js`, `server/db/schemaIndexGuards.test.js`. Expected: PASS.
- [ ] **Step 5: Commit** (lane checkpoint). Run `database-review` on this task before Task 2.

### Task 2: Identity rule (spec law 1)

**Files:**
- Create: `server/utils/gvPost/identity.js`
- Test: `server/utils/gvPost/identity.test.js` (DB, invented fixtures under a `RUN` prefix)

**Interfaces:**
- Consumes: `THUMBTACK_PROXY_ROLLOUT` from `server/utils/inbox/constants.js` (never redeclare it), `last10` from `server/utils/phone.js`, and `normalizePhone` from `server/utils/sms.js`.
- Produces: `async function resolveGvTarget(proposalId, db = pool)`. It returns `{ ok: true, clientId, leadId, negotiationId, phone }` (phone in E.164) or `{ ok: false, reason }`, where `reason` is one of:
  - `no_client`
  - `no_phone`
  - `not_relay`
  - `foreign_lead`
  - `ambiguous_lead`
  - `lead_not_on_phone`
  - `lead_too_old`
- Rule order:
  1. Read the client's `clients.phone`.
  2. Find the leads whose `customer_phone` last10 matches and whose `created_at >= THUMBTACK_PROXY_ROLLOUT`. None means `not_relay`.
  3. If any such lead's `client_id` IS DISTINCT FROM the proposal's client, return `foreign_lead`. A NULL `client_id` counts as foreign.
  4. The chosen lead is the one with `proposal_id = proposalId`. Otherwise it is this client's leads on that number; more than one means `ambiguous_lead`.
  5. The chosen lead's own last10 must equal the client's, else `lead_not_on_phone`.
  6. Its `created_at` must be within 180 days, else `lead_too_old`.

- [ ] **Step 1: Write the failing tests:**
  - `linked lead on the client phone resolves`
  - `single unlinked lead of the same client resolves`
  - `two unlinked leads of the same client on one number is ambiguous_lead`
  - `another client's lead on the number is foreign_lead`
  - `a lead with no client on the number is foreign_lead`
  - `only a pre-rollout lead is not_relay`
  - `linked lead on a different number is lead_not_on_phone`
  - `lead older than 180 days is lead_too_old`
- [ ] **Step 2: Run** `node --test server/utils/gvPost/identity.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Parameterized reads on the passed `db`; no writes.
- [ ] **Step 4: Run.** Expected: 8/8 PASS.
- [ ] **Step 5: Commit.**

### Task 3: Rules, body validation, suppression

**Files:**
- Create: `server/utils/gvPost/rules.js`, `server/utils/gvPost/suppression.js`
- Modify: `server/utils/comms/actions/proposalResend.js` (add `RESENDABLE` to its exports, for the drift test only; nothing else)
- Test: `server/utils/gvPost/rules.test.js` (pure), `server/utils/gvPost/suppression.test.js` (DB)

**Interfaces:**
- Produces in `rules.js`:
  - `GV_BODY_MAX = 320`
  - `GV_WINDOWS = { staleMin: 5, leaseMin: 3, spacingMin: 10, pasteBeforeMin: 30, notSeenGraceMin: 2, livenessMin: 30, outageFailures: 3, leadMaxAgeDays: 180 }`
  - `GV_PRECLICK_REASONS`, a Set of `no_thread`, `wrong_thread`, `invalid_body`, `invalid_number`, `session_expired`, `challenge`, `cap`, `timeout`, `ui_error_before_send`
  - `GV_OUTAGE_EXEMPT`, a Set of `cap` and `no_thread`
  - `GV_SENDABLE_STATUSES = ['sent', 'viewed', 'modified', 'accepted']`, the same values as `proposalResend.js` `RESENDABLE`, pinned by a drift test
  - `function gvPostEnabled()`, which is `process.env.GV_PROPOSAL_POST_ENABLED === 'true'`
  - `function gvDailyCap()`, which is `readEnvInt('GV_POST_DAILY_CAP', 25)`
  - `function normalizeGvBody(body)`: collapse every whitespace run to one space, then trim
  - `function validateGvBody(body, token)`, which returns `{ ok: true, body }` or `{ ok: false, reason }` with reason `too_long`, `no_link`, `wrong_link` or `multiple_links`. It requires exactly one `${PUBLIC_SITE_URL}/proposal/<uuid>` (from `server/utils/urls.js`) whose uuid equals `token`, and a normalized length of at most 320.
- Produces in `suppression.js`: `async function gvSuppression({ proposal, client, phone }, db = pool)`, which returns `{ ok: true }` or `{ ok: false, reason }`.
  - `shouldSendImmediate({ proposal: { id, status }, client: { communication_preferences, email_status, phone_status }, channel: 'sms' })` gives `archived`, `channel_disabled` or `bad_contact` (spec law 8: today's suppression carries over unchanged).
  - Then `activeOptOut(phone, db)` gives `opted_out`.
  - Then a `proposal.status` outside `GV_SENDABLE_STATUSES` gives `not_sendable`.
  - `suppression.js` never imports `proposalResend.js`. Once Task 5 makes `proposalResend.js` import `queue.js`, that would be a require cycle loading `RESENDABLE` as undefined.

- [ ] **Step 1: Write the failing tests:**
  - rules: `whitespace runs and line breaks collapse to single spaces`, `a 321-character body is too_long`, `a body without the link is no_link`, `a link with another token is wrong_link`, `two links is multiple_links`, `the template body with its trailing period validates`, `GV_SENDABLE_STATUSES matches proposalResend RESENDABLE`
  - suppression: `archived proposal is archived`, `sms_enabled false is channel_disabled`, `phone_status bad is bad_contact`, `active sms_optouts row is opted_out`, `a cleared opt-out passes`, `status draft is not_sendable`
- [ ] **Step 2: Run both files.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both.** Expected: 7/7 and 6/6 PASS.
- [ ] **Step 5: Commit.**

### Task 4: The router and queue (`routeProposalText`)

**Files:**
- Create: `server/utils/gvPost/queue.js`
- Test: `server/utils/gvPost/queue.test.js` (DB)

**Interfaces:**
- Consumes: Task 2, Task 3, and `notificationsEnabled` from `server/utils/notificationsEnabled.js`.
- Produces: `async function checkGvCapacity({ phoneLast10, excludeProposalId = null, excludePostId = null }, db = pool)`, which returns `{ ok: true }` or `{ ok: false, reason: 'cap' | 'spacing' }`.
  - Cap: rows with status IN ('queued','leased','sent','clicked_unverified','unknown') created in the last 24 h, compared with `gvDailyCap()`.
  - Spacing: such a row whose `negotiation_id` belongs to any proxy-era lead on `phoneLast10`, created within 10 min.
  - Both counts exclude `excludeProposalId`'s rows and `excludePostId`.
- Produces: `async function routeProposalText({ proposalId, token, body, sentBy = null, sendPath })`, where `sendPath` is `'auto'` or `'compose'`. It returns:
  - `{ route: 'gv', id }`
  - `{ route: 'merged', id }`
  - `{ route: 'twilio', reason }`
- Order:
  1. flag, giving `disabled`
  2. `deps.notificationsEnabled()`, giving `notifications_off`
  3. `deps.resolveGvTarget`, giving the identity reason
  4. `gvSuppression` (Task 3), giving its reason (in practice `opted_out` or `not_sendable`; the choke point already applied the rest)
  5. `validateGvBody`, giving the body reason
  6. an open row for this proposal (`status IN ('queued','leased')`), giving `merged`
  7. `checkGvCapacity({ phoneLast10, excludeProposalId: proposalId })`, giving `cap` or `spacing`
  8. `INSERT ... ON CONFLICT (proposal_id) WHERE status IN ('queued','leased') DO NOTHING RETURNING id`. If the insert loses the race, select the open id and return `merged`.
- On a `cap` or `spacing` result: one console line (proposal id, reason) and a Sentry warning, throttled in memory to one per reason per hour (`{ feature: 'gv_post', event: 'cap' | 'spacing' }`).
- Any throw goes to Sentry (`{ feature: 'gv_post', stage: 'route' }`, no number) and returns `{ route: 'twilio', reason: 'error' }`.
- Seam: `routeProposalText.__setDeps({ resolveGvTarget, notificationsEnabled })`. The defaults are the real functions.

- [ ] **Step 1: Write the failing tests** (all inject `notificationsEnabled: () => true` except the notifications test):
  - `flag off routes twilio disabled`
  - `notifications off routes twilio notifications_off`
  - `relay client with a valid body queues one row with status queued`
  - `non-relay client routes twilio not_relay`
  - `a second route while one is open returns merged with the same id and no spacing trip`
  - `concurrent routes for one proposal yield one row and one merged` (Review Focus 1)
  - `cap reached routes twilio cap` (`GV_POST_DAILY_CAP=1`, another proposal's open row)
  - `another proposal's post to the same number within 10 minutes routes twilio spacing`
  - `a throwing identity lookup routes twilio error`
  - `an opted-out number routes twilio opted_out`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: 10/10 PASS.
- [ ] **Step 5: Commit.**

### Task 5: The two choke points and the SendModal's server side

**Files:**
- Modify: `server/utils/sendProposalSentEmail.js`, `server/utils/comms/actions/proposalResend.js`, `server/routes/comms.js`
- Test: `server/utils/sendProposalSentEmail.gvPost.test.js`, `server/utils/comms/actions/proposalResend.gvPost.test.js`, `server/routes/comms.gvPost.test.js`

**Interfaces:**
- Consumes: `routeProposalText` (Task 4), `resolveGvTarget` (Task 2), and `gvPostEnabled`, `GV_BODY_MAX` and `validateGvBody` (Task 3).
- Produces in `sendProposalSentEmail.js`: `async function sendInitialProposalText(proposal, { sentBy = null, actorType = 'admin', via = 'auto' } = {})`, exported.
  - It holds the existing SMS leg (L69-115), including the single `messageType: 'initial_proposal'` literal.
  - After `shouldSendImmediate` passes, when `via === 'auto'` and `actorType === 'admin'`, it calls `routeProposalText({ proposalId: proposal.id, token: proposal.token, body, sentBy, sendPath: 'auto' })`. A `gv` or `merged` result returns `'queued'` without `sendAndLogSms`.
  - `via: 'twilio'` skips the router.
  - Returns `'queued' | 'sent' | 'suppressed' | 'skipped' | 'failed'`, where `'failed'` is the caught `sendAndLogSms` throw.
  - `sendProposalSentEmail` passes its `actorType` through, so the website wizard (`'client'`) never routes.
- Produces in `proposalResend.js`:
  - export `load`;
  - export `async function sendResendText({ row, phone, body, ctx = {} })`, holding L211-228 (the entry, with its single `` `${messageType}_sms` `` shape, plus the Twilio leg) and returning `{ status: 'sent' | 'failed', error? }`, so `dispatch` keeps `results.sms_error` for the modal's "Text failed" line;
  - add `__setDeps({ resolveGvTarget, routeProposalText })` to the module, so tests can make the lookup throw;
  - in `dispatch`, inside `wantSms && available`, route first with `sendPath: 'compose'`. A `gv` or `merged` result sets `results.sms = 'queued'` and `results.sms_route = 'thumbtack'`, with no `message_log` row.
- `resolveRecipient` adds, under `channels.sms` (comms.js passes `channels` through whole): `via: 'thumbtack' | 'twilio'`, `max_chars: 320 | 640`, and `phone_last4` (relay only).
  - It is `'thumbtack'` only when `gvPostEnabled()` and `resolveGvTarget(...).ok`.
  - It checks the flag first, then wraps `resolveGvTarget` in try/catch, so a throw gives `via: 'twilio'` plus a Sentry event (spec law 5's fail-open; the preview and send must never 500).
- Produces in `comms.js`:
  - For a relay body (`channels.sms.via === 'thumbtack'`, token from the exported `load`): over 320 throws `ValidationError({ sms_body: 'Thumbtack texts are capped at 320 characters.' }, 'Thumbtack texts are capped at 320 characters.')`; failing `validateGvBody` throws the same shape with `The text must include the proposal link.`.
  - The `/send` response adds `sms_route`.

- [ ] **Step 1: Write the failing tests** (router stubbed through its `__setDeps`; `SEND_NOTIFICATIONS='false'`):
  - `admin initial send to a relay client returns queued and never calls sendAndLogSms`
  - `admin initial send to a non-relay client texts as today`
  - `wizard send with actorType client never routes`
  - `via twilio skips the router`
  - `a sendAndLogSms throw returns failed`
  - `resend dispatch to a relay client returns sms queued with sms_route thumbtack and writes no message_log row`
  - `resolveRecipient marks a relay client via thumbtack with max_chars 320 and phone_last4`
  - `resolveRecipient falls back to twilio when the identity lookup throws`
  - `comms send rejects a relay body over 320 with the cap message`
  - `comms send rejects a relay body without the link`
  - `comms send response carries sms_route`
- [ ] **Step 2: Run each new file alone.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the three new files, then these existing suites, one at a time, reading each pass count:** `server/utils/sendProposalSentEmail.test.js`, `server/utils/comms/actions/proposalActions.test.js`, `server/utils/comms/registry.test.js`, `server/routes/comms.test.js`, `server/routes/comms.silent.test.js`, `server/routes/proposals/crud.test.js`, `server/routes/proposals/crud.guards.test.js`, `server/utils/answeringMessageTypes.test.js`. Expected: all PASS, with the pin test unchanged.
- [ ] **Step 5: Commit.** Run `code-review` + `consistency-check` on Tasks 2-5 before Task 6.

### Task 6: Fallback and outage

**Files:**
- Create: `server/utils/gvPost/fallback.js`, `server/utils/gvPost/outage.js`
- Test: `server/utils/gvPost/fallback.test.js`, `server/utils/gvPost/outage.test.js` (DB; senders and `notifyAdminCategory` stubbed through `__setDeps`)

**Interfaces:**
- Produces in `fallback.js`: `async function sendGvFallback(postId)`, which returns `'sent' | 'suppressed' | 'failed' | 'already'`.
  1. Claim with `UPDATE gv_posts SET fallback_status = 'claimed', fallback_at = now(), updated_at = now() WHERE id = $1 AND fallback_status IS NULL RETURNING *`; no row means `'already'`.
  2. Load the proposal with its own explicit query: `p.id, p.token, p.status, p.event_type, p.event_type_custom, p.event_date, p.client_id`, and from `clients c`: `c.name AS client_name, c.email AS client_email, c.phone AS client_phone, c.communication_preferences, c.email_status, c.phone_status`.
  3. Re-check `gvSuppression`; suppressed means `fallback_status = 'suppressed'`.
  4. For `'auto'`, call `sendInitialProposalText(loaded, { sentBy: post.sent_by, via: 'twilio' })`.
  5. For `'compose'`, call `sendResendText({ row: await load(post.proposal_id), phone, body: post.body, ctx: { sentBy: post.sent_by } })`.
  6. Map the result (for `'compose'`, `sendResendText`'s `status`): `sent` gives `sent`; `suppressed` gives `suppressed`; `skipped` or `failed` give `failed`.
- Produces in `outage.js`, all on `gv_sender_state`:
  - `async function noteOutage(reason)`: opens the episode if closed. It emails once per episode through `UPDATE ... SET outage_alerted_at = now() WHERE outage_alerted_at IS NULL RETURNING`, using `notifyAdminCategory({ category: 'routine_thumbtack', subject, emailHtml, emailText })` with no `smsBody`.
  - `async function noteSuccess()`: closes the episode and zeroes the counter.
  - `async function notePreclickFailure(reason)`: skips reasons in `GV_OUTAGE_EXEMPT`; otherwise increments the counter and calls `noteOutage('preclick_failures')` at 3.
  - Copy, verbatim:
    - Subject: `Google Voice sender is down: Thumbtack customers are getting the toll-free text`
    - Text: `The box's Google Voice sender stopped posting proposal links (reason: {reason}). Thumbtack customers are getting today's toll-free text instead, so nothing is lost. To fix it, sign GV back in on the box (gv-agent/README.md); the sender picks up on its next poll.`

- [ ] **Step 1: Write the failing tests:**
  - `a second fallback for the same post returns already`
  - `a suppressed client gets no text and fallback_status suppressed`
  - `an auto post falls back through sendInitialProposalText with via twilio`
  - `a compose post falls back through sendResendText with its stored body`
  - `noteOutage emails once per episode with no smsBody`
  - `noteSuccess reopens the episode for a later alert`
  - `three non-exempt pre-click failures email once and cap failures never count`
- [ ] **Step 2: Run each alone.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run each alone.** Expected: 4/4 and 3/3 PASS.
- [ ] **Step 5: Commit.**

### Task 7: The agent API

**Files:**
- Create: `server/routes/gvAgent.js`
- Modify: `server/index.js` (`app.use('/api/gv-agent', require('./routes/gvAgent'));` beside the `/api/admin/thumbtack` mount at L353)
- Test: `server/routes/gvAgent.test.js` (auth), `server/routes/gvAgent.queue.test.js` (DB; real router on `express()` with the `node:http` helper pattern of `thumbtackAgent.replies.test.js`)

**Interfaces:**
- Consumes: Tasks 2-4 and 6, and `safeEqual` (`server/utils/secrets.js`).
- Produces:
  - `module.exports = router`, with `router.__setDeps = (...)` (the `thumbtackAgent.js` convention).
  - Its own `rateLimit({ windowMs: 60000, max: 30 })`.
  - Header `x-gv-agent-secret` against `GV_AGENT_SECRET`. Unset or wrong means a 401 `AppError` in every env, with a Sentry warning naming the path and no secret.
- Routes:
  - `GET /pending` returns `[]` unless `gvPostEnabled()`.
    1. On one client, in a transaction: `SELECT * FROM gv_posts WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`.
    2. Re-validate:
       - `resolveGvTarget` fails: `failed_preclick`, reason `identity_mismatch` (fallback after release; Sentry warning)
       - `gvSuppression` fails: `cancelled`, with no fallback
       - the token is in `thumbtack_messages.text` (no `from_type` filter) on any proxy-era negotiation carrying that number since `created_at - 30 min`: `skipped_already_posted`
       - `checkGvCapacity({ phoneLast10, excludePostId: row.id })` fails: `failed_preclick`, reason `cap` (fallback; Sentry warning)
       - otherwise: `leased`, with `leased_at = now()`
    3. Stamp `last_lease_at`, COMMIT, release.
    4. Run any fallback.
    5. Respond `[{ id, phone, body, negotiation_id }]` or `[]`.
  - `POST /report` takes `{ id, outcome, reason? }`.
    - `outcome` must be one of `sent`, `clicked_unverified`, `failed_preclick`, `skipped_already_posted`, and a `failed_preclick` reason must be in `GV_PRECLICK_REASONS`; anything else is 400.
    - It runs `UPDATE ... SET status = $2, reason = $3, reported_at = now(), updated_at = now(), clicked_at = CASE WHEN $2 IN ('sent','clicked_unverified') THEN now() END WHERE id = $1 AND status = 'leased' RETURNING id`. No row means 200 `{ ignored: true }` and a log line.
    - `sent` calls `noteSuccess()`. `failed_preclick` calls `notePreclickFailure(reason)`, then `sendGvFallback(id)` after release.
    - `clicked_unverified` and `failed_preclick` send a Sentry warning.
  - `POST /status` takes `{ state }`, which must be `session_expired` or `challenge`, and calls `noteOutage(state)` with a Sentry warning.
- Logs: one line per lease, report and status (post id, outcome, last-4 at most).

- [ ] **Step 1: Write the failing tests.**
  - auth:
    - `no secret configured is 401`
    - `wrong secret is 401`
    - `right secret with flag off returns []`
  - queue:
    - `lease returns one job with phone, body and negotiation_id and marks it leased`
    - `lease does not trip spacing or cap on the row being leased`
    - `lease cancels an archived proposal without a fallback` (Review Focus 2)
    - `lease skips a row whose token is already in the thread`
    - `lease turns an identity mismatch into failed_preclick and sends one fallback`
    - `report sent closes the outage episode`
    - `report failed_preclick with a whitelisted reason sends one fallback`
    - `report with an unknown reason is 400`
    - `report on a non-leased row is ignored` (Review Focus 3)
    - `status session_expired emails once per episode`
- [ ] **Step 2: Run each alone.** Expected: FAIL.
- [ ] **Step 3: Implement and mount.**
- [ ] **Step 4: Run each alone** (3/3 and 10/10 PASS). Then, on the lane server with the flag off: `curl -s -o /dev/null -w '%{http_code}' localhost:<port>/api/gv-agent/pending` gives `401`, and the same call with `-H "x-gv-agent-secret: $GV_AGENT_SECRET"` gives `[]`.
- [ ] **Step 5: Commit.** Run `security-review` on Tasks 6-7 before Task 8.

### Task 8: Read-time status

**Files:**
- Create: `server/utils/gvPost/status.js`
- Test: `server/utils/gvPost/status.test.js` (pure, plus one DB case)

**Interfaces:**
- Produces: `function deriveGvDisplay(post, echoes, now = new Date())`, pure. It returns one of:
  - `queued`
  - `sending` (leased)
  - `sent` (sent within the 2-minute grace)
  - `sent_not_seen`
  - `in_thread`
  - `check_thread` (clicked_unverified or unknown)
  - `skipped_already_posted`
  - `fallback` (stale or failed_preclick with fallback `sent` or `claimed`)
  - `fallback_suppressed`
  - `fallback_failed`
  - `cancelled`

  `in_thread` means an echo whose `normalizeGvBody(text)` equals `normalizeGvBody(post.body)`; it beats every other state. An echo holding the token without a body match sets `hand_pasted: true`.
- Produces: `async function gvPostStatusForProposal(proposalId, db = pool)`, which returns `null` or `{ status, display, reason, fallback_status, created_at, clicked_at, in_thread_at, hand_pasted, phone_last4 }`. It reads the latest row plus `thumbtack_messages` on its `negotiation_id` from `created_at - 30 min` whose text holds the token, and `phone_last4` from the client.

- [ ] **Step 1: Write the failing tests:**
  - `exact body echo is in_thread`
  - `token-only echo is hand_pasted, not in_thread`
  - `sent within 2 minutes is sent`
  - `sent past 2 minutes with no echo is sent_not_seen`
  - `stale with fallback sent is fallback`
  - `failed_preclick with fallback failed is fallback_failed`
  - `unknown is check_thread`
  - (DB) `gvPostStatusForProposal returns null with no post and the latest post otherwise`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: 8/8 PASS.
- [ ] **Step 5: Commit.**

### Task 9: The sweep, its registration, the lane's docs

**Files:**
- Create: `server/utils/gvPostSweepScheduler.js`
- Modify: `server/index.js` (register beside `RUN_FIRST_REPLY_FALLBACK_SCHEDULER`, L759-773)
- Modify: `.claude/CLAUDE.md` (env table), `README.md` (env table; folder tree under `server/utils/` and `server/routes/`), `ARCHITECTURE.md` (a "GV agent" route block beside the Thumbtack harvester table at L765; schema; third-party integrations), `.env.example`
- Test: `server/utils/gvPostSweepScheduler.test.js` (DB)

**Interfaces:**
- Produces: `async function runGvPostSweep()`, which returns `{ staled, unknowned, alerted }` and rethrows the first arm error after all arms run. Arms:
  1. `UPDATE gv_posts SET status = 'stale', updated_at = now() WHERE status = 'queued' AND created_at < now() - interval '5 minutes' RETURNING id`, then `sendGvFallback` for each.
  2. `UPDATE ... SET status = 'unknown', updated_at = now() WHERE status = 'leased' AND leased_at < now() - interval '3 minutes'` (no fallback).
  - Retry arm: rows with `status IN ('stale','failed_preclick') AND fallback_status IS NULL AND updated_at < now() - interval '1 minute'` get `sendGvFallback`. A restart between the status UPDATE and the fallback leaves them unclaimed, and the claim makes the retry safe. Every status UPDATE in Tasks 4, 7 and 9 sets `updated_at = now()`.
  3. ONLY when `gvPostEnabled()`: if arm 1 staled any row and `last_lease_at` is NULL or older than 30 min, call `noteOutage('no_lease')`.
  - Arms 1 and 2 each send one Sentry warning per run that touched rows, with the count, plus a console line.
- Registration: `if (enabled('RUN_GV_POST_SWEEP_SCHEDULER'))`, using `wrapScheduler('gv_post_sweep', 60, ...)`, `setTimeout(wrapped, 25000)` and `setInterval(wrapped, 60000)`, else `clearHealthRow('gv_post_sweep')`. It is not gated by the flag.
- CLAUDE.md env rows:
  - `GV_PROPOSAL_POST_ENABLED`: default OFF, `'true'` enables; gates enqueue and empties `/api/gv-agent/pending`; the sweep stays ungated so a rollback drains to the 888.
  - `GV_AGENT_SECRET`: BLAST RADIUS: reads pending post bodies (proposal tokens) and relay numbers, and can mark rows. Leak response: rotate it on Render and in `gv-agent/.env`, and flip `GV_PROPOSAL_POST_ENABLED` off.
  - `RUN_GV_POST_SWEEP_SCHEDULER`.
  - `GV_POST_DAILY_CAP` (default 25; `0`, blank or nonsense fall back).

- [ ] **Step 1: Write the failing tests:**
  - `a queued row older than 5 minutes goes stale and sends one fallback across two sweeps`
  - `a leased row older than 3 minutes goes unknown with no fallback`
  - `stale rows with no lease in 30 minutes email once`
  - `flag off still drains queued rows to one fallback each and emails nobody` (Review Focus 4)
  - `an unclaimed failed_preclick row gets its fallback on the next sweep`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement, register, write the docs.**
- [ ] **Step 4: Run the new file, then every file from Tasks 1-8, then Task 5's existing-suite list, one at a time, reading the counts. Then** `npm run check:filesize`. Expected: all PASS, with no new RED.
- [ ] **Step 5: Commit.** Then the lane-end full fleet + `/second-opinion`, then merge (first in `mergeOrder`).

## Lane gv-post-ui

### Task 10: The proposal-page status row

**Files:**
- Modify: `server/routes/proposals/getOne.js`:
  - add `gvPostStatusForProposal(req.params.id)` to the `Promise.all` at L55, with response key `gv_post`;
  - add `router.get('/:id/gv-post', auth, requireAdminOrManager, ...)` returning `{ gv_post }`, registered BEFORE the greedy `GET /:id` in this file.
- Create: `client/src/components/GvPostStatus.js`
- Modify: `client/src/pages/admin/ProposalDetail.js` (one import and one element in the Client card `<dl>` beside `first_reply`, L562-564)
- Modify: `README.md` (folder tree row for `GvPostStatus.js`), `ARCHITECTURE.md` (proposal routes: `GET /api/proposals/:id/gv-post`, and the `gv_post` key on `GET /api/proposals/:id`)
- Test: `server/routes/proposals/getOne.gvPost.test.js`

**Interfaces:**
- Consumes: `gvPostStatusForProposal` (Task 8).
- Produces: `export default function GvPostStatus({ proposalId, initial, refreshKey })`. It re-syncs from `initial` when that changes and refetches when `refreshKey` changes. ProposalDetail bumps `refreshKey` in `onSendComplete` (L254-258), so a SendModal resend shows its new post. It renders `<><dt>Thumbtack message</dt><dd className="muted">{copy}</dd></>`, or nothing when there is no post.
  - It polls its OWN endpoint, `GET /proposals/:id/gv-post` through `utils/api.js`, every 15 s while `display` is `queued`, `sending`, `sent` or `sent_not_seen`, for at most 10 minutes.
  - It never calls ProposalDetail's `loadProposal`, which resets the notes and re-fetches cancel targets.
- Copy by `display`, verbatim (time = Chicago `h:mm a`):
  - queued: `Queued for Thumbtack`
  - sending: `Sending through Google Voice`
  - sent: `Sent from GV`
  - in_thread: `In the Thumbtack thread ({time})`
  - sent_not_seen: `Sent from GV, not in the Thumbtack thread yet`
  - check_thread: `Clicked Send but couldn't confirm: check the thread before pasting`
  - skipped_already_posted: `Skipped: the link was already in the thread`
  - fallback: `Didn't go out: the toll-free text went instead ({reasonLabel})`
  - fallback_suppressed: `Didn't go out, and no text was sent (client can't be texted)`
  - fallback_failed: `Didn't go out, and the toll-free text failed too ({reasonLabel})`
  - cancelled: `Cancelled: the proposal or client is no longer textable`
- When `hand_pasted` is true, append ` (a hand-pasted link is in the thread)`.
- `reasonLabel` by reason:
  - stale: `the sender didn't pick it up in time`
  - session_expired: `GV is signed out`
  - challenge: `Google asked for a check`
  - cap: `daily cap reached`
  - identity_mismatch: `the Thumbtack lead didn't match`
  - anything else: `the sender hit a problem`

- [ ] **Step 1: Write the failing tests:** `GET /proposals/:id carries gv_post, null without a post`, `GET /proposals/:id/gv-post returns the latest status and 401 without auth`.
- [ ] **Step 2: Run alone.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it, then** `server/routes/proposals/getOne.consultCall.test.js` **and** `getOne.leadCall.test.js`**, one at a time** (all PASS). Then `cd client && CI=true npx react-scripts build`. Expected: compiles clean. Then check in the dev app (sign in with `scripts/dev-signin.js`), using hand-inserted `gv_posts` rows on an invented dev proposal: `queued`, `stale` with `fallback_status 'sent'`, and `unknown` each show their exact copy. With no agent polling, delete the rows after.
- [ ] **Step 5: Commit.**

### Task 11: SendModal for relay clients

**Files:**
- Modify: `client/src/components/SendModal/sendResult.js`, `client/src/components/SendModal/SendModal.jsx`
- Test: `client/src/components/SendModal/sendResult.test.js`

**Interfaces:**
- Consumes: `results.sms === 'queued'`, `results.sms_route`, `channels.sms.via`, `channels.sms.max_chars` and `channels.sms.phone_last4` (Task 5).
- Produces in `sendResult.js`:
  - `describeSendResult`: the sms `queued` clause is `Queued for Thumbtack`, at success level.
  - New `export function channelResultLine(key, results, channels)`, which returns `{ kind: 'sent' | 'failed' | 'queued' | 'skipped', text }`. For `queued` the text is `Queued for Thumbtack (ending {phone_last4})`.
  - `SendModal.jsx`'s `renderChannelResult` renders from `channelResultLine` (the Retry button stays on `failed`).
- Compose block when `via === 'thumbtack'`:
  - label `Text via Thumbtack (GV)`
  - counter `/ {max_chars}`
  - `toLine` shows `ending {phone_last4}`
  - Send is blocked with `The text must include the proposal link.` when the body lacks the default body's `/proposal/<token>` URL, and with `Thumbtack texts are capped at 320 characters.` over the cap (Task 5's strings).

- [ ] **Step 1: Write the failing tests:**
  - `queued sms reads Queued for Thumbtack at success level`
  - `email sent plus sms queued reads both clauses`
  - `channelResultLine queued reads Queued for Thumbtack ending 0123`
  - `channelResultLine failed keeps kind failed`
- [ ] **Step 2: Run** `cd client && CI=true npx react-scripts test --watchAll=false src/components/SendModal/sendResult.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run (PASS) and the CI build.** Then, in the dev app, open a resend for an invented relay client: on a lane server with `GV_PROPOSAL_POST_ENABLED=true`, check the label, the 320 counter and both block messages. The queued line is proven by the unit test. Delete the invented client, lead and proposal after.
- [ ] **Step 5: Commit.** Add the README Key Features line, run the lane review, merge.

## Lane gv-post-inbox

### Task 12: The GV post counts as the proposal going out

**Files:**
- Modify: `server/utils/inbox/constants.js` (add `GV_POST_ABSORB_MINUTES = 2` beside `PROPOSAL_ABSORB_MINUTES` and export it), `server/utils/inbox/readThumbtack.js` (`TT_HEADERS_SQL` and `mapThumbtackHeader`), `server/utils/inbox/readMessageLog.js` (`ML_HEADERS_SQL` and `mapMessageLogHeader`), `server/utils/inbox/normalize.js`, `server/utils/inbox/thread.js`
- Test: `server/utils/inbox/normalize.test.js` (pure cases), `server/utils/inbox/readers.test.js` (DB cases), `server/utils/inbox/thread.test.js`

**Interfaces:**
- Consumes: `gv_posts` (Task 1). The match is done in SQL, because the header queries carry no message text.
  - `TT_HEADERS_SQL` gains a `LEFT JOIN LATERAL` producing `gv_post_proposal_id` and `gv_post_created_at`. It matches only when:
    - `t.from_type = 'Business'` (a customer quoting the body keeps their message);
    - `gp.negotiation_id = t.negotiation_id`;
    - `btrim(regexp_replace(gp.body, '\\s+', ' ', 'g')) = btrim(regexp_replace(t.text, '\\s+', ' ', 'g'))`. Write the backslash doubled inside the JS template literal, the house style of `'\\D'` at `smsInbound.js:122`. The regexp runs first and then btrim, matching `normalizeGvBody`.
    - The pick rule: `gp.status IN ('leased','sent','clicked_unverified','unknown') AND gp.created_at <= COALESCE(t.sent_at, t.created_at) ORDER BY gp.created_at DESC LIMIT 1`. A resend's default text is byte-identical to the first send's, so the echo must take the newest post made before it, and only a post the box actually worked. `LIMIT 1` also keeps `engine.js:342` from duplicating the header row.
  - `mapThumbtackHeader` sets `e.meta.gvPost = { proposalId, postCreatedAt }`.
  - `ML_HEADERS_SQL` gains a lateral producing `gv_fallback_proposal_id` and `gv_post_created_at`. It matches only:
    - rows with `channel = 'sms'` and `message_type IN ('initial_proposal','proposal_sent_sms')`;
    - against a post for the row's proposal with `fallback_status = 'sent'`;
    - where the row's `created_at` is within 2 minutes after `gp.fallback_at`, the claim that came right before that 888 send;
    - with the pick rule `gp.fallback_at <= l.created_at ORDER BY gp.fallback_at DESC LIMIT 1`.

    An 888 proposal text the router sent directly (rollback, cap, error) has no matching `fallback_at` and is never mistaken for a fallback.
  - `mapMessageLogHeader` sets `e.meta.gvFallback = { proposalId, postCreatedAt }`.
- Produces in `normalize.js`: `function absorbGvPosts(events)`, called right after the proposal absorb (L119-149) and BEFORE the twins filter (L227-228).
  - It absorbs an event with `meta.gvPost` or `meta.gvFallback` into a `pal` proposal-send event for that proposal ONLY when the pal's time is within `GV_POST_ABSORB_MINUTES` (2) of `postCreatedAt`. Lifecycle and proposal_send write their pal seconds before the insert, and the legacy /resend writes it just after.
  - On absorb it pushes `{ channel: 'thumbtack', failed: false }` (echo), or the fallback's delivery, onto `meta.deliveries` and removes the event. For an absorbed `ml` row it also records the twin ref, so the auto fallback's `sms_messages` twin goes with it.
  - Otherwise the event stands: an echo stays a counted outbound Thumbtack reply (as a Business message counts today), and a fallback stays a counted `ml` row (as today's 888 row). This covers the SendModal resend and the crud born-sent create, which write no pal, and a resend of an older send.
  - Never `autoFirstReply`, never a holding reply.
- Produces in `thread.js`: a `proposal_sent` row with a thumbtack delivery reads `You sent the proposal (also posted to Thumbtack)`.

- [ ] **Step 1: Write the failing tests.**
  - pure:
    - `a GV echo is absorbed into its proposal send as a thumbtack delivery`
    - `a text-only send with a GV echo reads delivered`
    - `an 888 fallback row 8 minutes after the send is absorbed into it`
    - `an echo with no proposal send stays a counted reply`
    - `a resend's echo and fallback never attach to an older send`
    - `an auto fallback with its sms_messages twin reads delivered`
    - `a GV echo is never a holding reply`
  - DB (`readers.test.js`):
    - `TT headers carry gv_post_proposal_id for a matching Business row`
    - `with two same-body posts on one proposal the echo takes the newest post made before it`
    - `a skipped or stale post never claims an echo`
    - `ML headers carry gv_fallback_proposal_id within 2 minutes of fallback_at and not otherwise`
    - `a direct 888 proposal text with no fallback claim is not a fallback`
  - thread: `a send with a thumbtack delivery reads also posted to Thumbtack`
- [ ] **Step 2: Run each alone.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run every `server/utils/inbox/*.test.js`, then `server/routes/admin/inbox.test.js` (the real engine over the header SQL), one at a time, reading counts** (all PASS). Then check the dev Inbox with fixture rows for an invented client: a `pal` send, a `gv_posts` row and a matching Business `thumbtack_messages` row should show one proposal send reading "also posted to Thumbtack", and no separate reply item. Delete the fixtures after.
- [ ] **Step 5: Commit.** Then the lane review (full fleet) and merge.

## Lane gv-sender

### Task 13: Scaffold and pure modules

**Files:**
- Create: `gv-agent/package.json`, `gv-agent/package-lock.json` (from `npm install` inside `gv-agent/` only), `gv-agent/.env.example`, `gv-agent/README.md`, `gv-agent/systemd/gv-agent.service`
- Create: `gv-agent/src/config.js`, `gv-agent/src/validate.js`, `gv-agent/src/interstitial.js`, `gv-agent/src/journal.js`, `gv-agent/src/pageLogic.js`, plus a `*.test.js` beside each pure module

**Interfaces:**
- `package.json`: scripts `start` (`node src/index.js`), `dry-run` (`node src/index.js --dry-run`), `test` (`node --test src/*.test.js`); dependencies `dotenv` (the `thumbtack-agent` version) and `playwright` `^1.61.0`.
- `config.js` exports `CFG` with:
  - `apiBase` (API_BASE_URL)
  - `secret` (GV_AGENT_SECRET)
  - `profileDir` (GV_PROFILE_DIR, default `~/.gvoice-profile`)
  - `pollMs` (10000)
  - `outagePollMs` (60000)
  - `dailyCap` (25)
  - `jobBudgetMs` (90000)
  - `dryRun`
  - `dryRunPhone` (DRY_RUN_PHONE: the company 1922 line from `server/utils/companyPhone.js`, never a client)
- `validate.js`: `function validateJob({ phone, body, negotiation_id })` returns `{ ok: true }` or `{ ok: false, reason: 'invalid_number' | 'invalid_body' }`. The phone must match `/^\+1\d{10}$/`; the body must be one line of at most 320 characters with exactly one `https://drbartender.com/proposal/<uuid>`.
- `interstitial.js`: `function classifyPage({ host, texts })` returns `'ok' | 'session_expired' | 'challenge'`.
  - `accounts.google.com`, `Choose an account` or `Sign in` give `session_expired`.
  - `Verify it's you`, `unusual activity` or a reCAPTCHA challenge give `challenge`.
- `journal.js`: `function loadJournal(file)` returns a Set; `function journalBeforeClick(file, id)` uses `appendFileSync` and throws on failure. The file is `<profileDir>/gv-sent.journal`.
- `pageLogic.js` (pure):
  - `function parseBidId(noticeHref)` returns the `bids/<id>` id or null
  - `function digitsEqual(text, phone)` compares the last 10 digits
  - `function oneSendToEntry(entries, phone)` takes `[{ ownText, w, h, containsOther }]` and returns the index or -1. The entry must be rendered above 4 px, outermost, start with `Send to`, and have equal digits.
  - `function oneRecipientChip(labels, phone)` is true when exactly one `Remove ...` label carries the number
  - `function verifyDecision({ tokenInBubble, boxEmpty })` returns `'sent' | 'clicked_unverified'`
- `systemd/gv-agent.service` copies `thumbtack-agent/systemd/thumbtack-agent.service`: `UnsetEnvironment=WAYLAND_DISPLAY DISPLAY XAUTHORITY GNOME_SETUP_DISPLAY XDG_SESSION_TYPE`, `Environment=OZONE_PLATFORM=x11`, `EnvironmentFile=/home/drbartender/projects/os/gv-agent/.env`, `ExecStart=/usr/bin/xvfb-run -a /home/drbartender/.nvm/versions/node/v24.16.0/bin/node src/index.js`, `Restart=on-failure`, `RestartSec=30`.
- `README.md` carries spec section 10's sign-in recipe and the call-dialer trap.

- [ ] **Step 1: Write the failing tests** (one file per module):
  - `a 10-digit E.164 number passes and a short form fails`
  - `a two-link body is invalid_body`
  - `a body with a line break is invalid_body`
  - `accounts.google.com is session_expired`
  - `Verify it's you is challenge`
  - `a journaled id is found after reload`
  - `parseBidId reads the bids id from a notice link`
  - `oneSendToEntry ignores the 1px screen-reader twin`
  - `two visible Send-to entries is -1`
  - `oneRecipientChip needs exactly one matching chip`
  - `verifyDecision needs both the bubble and the empty box`
- [ ] **Step 2: Run** `cd gv-agent && npm install && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 14: The GV flow (Playwright glue)

**Files:**
- Create: `gv-agent/src/gvFlow.js`, `gv-agent/src/diag.js`

**Interfaces:**
- Consumes: `pageLogic.js` for every judgment. The glue only reads the DOM into plain values.
- Produces in `gvFlow.js` (selectors exactly as spec section 10):
  - `async function openThreadIfAny(page, phone, negotiationId = null)` returns `{ ok: true, existed, bidId }` or `{ ok: false, reason }`.
    - If a `gv-thread-list-item` matches the number, open it (the send marks it read anyway; decision 7) and read the newest `a[href*="/bids/"]` in the conversation into `bidId`.
    - When a `negotiationId` is given and `bidId` is a different id, fail `wrong_thread`. The dry run passes none and only reads.
    - A thread with no notice (one we started) has nothing to check.
  - `async function composeTo(page, phone)` is the proven new-message flow, used for both a new and an existing conversation (GV appends to the existing one). It returns `{ ok: true }` or `{ ok: false, reason }`.
    1. Click `[aria-label="Send new message"]`.
    2. In `[role=region][aria-label="Select recipients"]`, use `input[placeholder="Type a name or phone number"]`: click, then `pressSequentially` the 10 digits with a 100 ms delay.
    3. Pick with `oneSendToEntry`. -1 fails `ui_error_before_send`.
    4. Require `oneRecipientChip`, else `ui_error_before_send`.
  - `async function threadHasToken(page, token)` returns a boolean.
  - `async function fillAndCheck(page, body)` uses `textarea[placeholder="Type a message"]`: `fill`, `inputValue() === body`, the Call panel input empty, no visible reCAPTCHA bframe (`challenge`), and `button[aria-label="Send message"]` enabled. Any other failure is `ui_error_before_send`.
  - `async function clickSend(page)`.
  - `async function readVerify(page, token)` returns `{ tokenInBubble, boxEmpty }`, polled up to 20 s by the caller.
  - Between steps, pause a random 300 to 1000 ms (the `thumbtack-agent` humanPause precedent).
- Produces in `diag.js`: `async function captureDiag(page, jobId, tag)`. It writes `<profileDir>/diag/<stamp>-<jobId>-<tag>.png/.json` with fs-safe names and digits masked in the JSON, keeps the newest 40, and deletes anything older than 30 days.

- [ ] **Step 1:** No unit test for the glue (the judgments are tested in Task 13). Its proof is the dry runs in Task 16.
- [ ] **Step 2: Implement.**
- [ ] **Step 3:** `node --check gv-agent/src/gvFlow.js gv-agent/src/diag.js`. Expected: no output.
- [ ] **Step 4: Commit.**

### Task 15: The per-job runner and the loop

**Files:**
- Create: `gv-agent/src/runJob.js`, `gv-agent/src/decide.js`, `gv-agent/src/index.js`
- Test: `gv-agent/src/runJob.test.js`, `gv-agent/src/decide.test.js`

**Interfaces:**
- Produces in `decide.js` (pure):
  - `function decideJob({ job, journal, sentToday, cap })` returns `{ action: 'report', outcome, reason? }` or `{ action: 'run' }`:
    - a journaled id gives `clicked_unverified`;
    - `sentToday >= cap` gives `failed_preclick cap`;
    - `validateJob` failing gives `failed_preclick <reason>`.
  - `function underBudget(startMs, nowMs, budgetMs)`.
  - `function chicagoDayKey(date)`, the `YYYY-MM-DD` in `America/Chicago` via `Intl.DateTimeFormat`, so the daily cap rolls at Chicago midnight.
- Produces in `runJob.js`: `async function runJob(job, deps)`, which returns `{ outcome, reason? }`. `deps` = `{ page, flow, journal: { has, write }, classify, diag, now, budgetMs }`. The order is fixed and tested:
  1. `classify(page)` non-ok gives `failed_preclick` with that reason.
  2. `flow.openThreadIfAny` (`wrong_thread` fails here).
  3. When a thread existed, `flow.threadHasToken`; true gives `skipped_already_posted`, with no journal and no click.
  4. `flow.composeTo`.
  5. `flow.fillAndCheck`.
  6. `underBudget`; false gives `failed_preclick timeout`.
  7. `journal.write(job.id)`; a throw gives `failed_preclick ui_error_before_send` and NO click.
  8. `flow.clickSend`.
  9. Poll `flow.readVerify` up to 20 s, then `verifyDecision`.

  Any definitive failure calls `diag(page, job.id, reason)`.
- Produces in `index.js`, the loop:
  - poll `GET /api/gv-agent/pending` (header `x-gv-agent-secret`) every `pollMs`;
  - `sentToday` comes from `<profileDir>/gv-sent-count.json` (`{ day: chicagoDayKey, count }`). It is incremented on every `sent` or `clicked_unverified` report and read at start, so a restart keeps the box's cap;
  - per job: `decideJob`, then launch the persisted profile (`launchPersistentContext(profileDir, { headless: false, channel: 'chrome' })`), open `https://voice.google.com/u/0/messages`, call `runJob`, close;
  - report through `POST /report`, retried 3 times with only 2xx counted;
  - on `session_expired` or `challenge`: `POST /status`, then `outagePollMs` until a poll's `classify` is ok.
- `--dry-run` runs three read-only stages and exits:
  1. API: `GET /pending` against the configured server, expecting a 2xx (`[]` with the flag off).
  2. Compose: `composeTo` and `fillAndCheck` against `CFG.dryRunPhone` with the body `dry run, never sent`, then clear the textarea.
  3. Thread: given `--thread-phone <E.164>` for an already-read relay thread (the one the spike started qualifies) and `--thread-token <uuid>` for a proposal token known to be in it:
     - `openThreadIfAny` finds the thread;
     - `threadHasToken(known)` is true, and `threadHasToken('00000000-0000-0000-0000-000000000000')` is false;
     - the bid id is read (null is fine for a thread we started).

  It never calls `clickSend`.

- [ ] **Step 1: Write the failing tests:**
  - decide:
    - `a journaled job id is reported clicked_unverified and never re-sent` (Review Focus 5)
    - `cap reached reports failed_preclick cap`
    - `invalid body reports failed_preclick invalid_body`
    - `a fresh valid job runs`
    - `chicagoDayKey rolls at Chicago midnight, not UTC`
  - runJob (stubbed deps):
    - `the journal is written before the click`
    - `a failed journal write means no click`
    - `a token already in the thread skips without journal or click`
    - `over budget reports timeout before the journal`
    - `a non-ok page reports its reason and captures diag`
    - `a verified send reports sent`
- [ ] **Step 2: Run** `cd gv-agent && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.** Then the lane review (full fleet). Merge after gv-post-server.

## Lane gv-sender-live

### Task 16: Box dry runs and the docs

**Files:**
- Modify: `README.md` (folder tree: `gv-agent/`; Tech Stack row: Google Voice web automation on the box), `ARCHITECTURE.md` (box agents: gv-agent, its API, the profile), `.claude/CLAUDE.md` (Tech Stack)
- Box, outside the repo: `~/.config/restic/excludes.txt`

- [ ] **Step 1: Dry runs on the box.** With main (gv-post-server + gv-sender) on a dev server and `GV_PROPOSAL_POST_ENABLED` unset, write `gv-agent/.env`: the dev API base, a dev-only `GV_AGENT_SECRET` (the same value in the dev server env), and `DRY_RUN_PHONE`. Then run:

  `cd ~/projects/os/gv-agent && npm ci && env -u WAYLAND_DISPLAY -u DISPLAY -u XAUTHORITY -u GNOME_SETUP_DISPLAY -u XDG_SESSION_TYPE OZONE_PLATFORM=x11 xvfb-run -a node src/index.js --dry-run --thread-phone <the spike thread's relay number> --thread-token <proposal 943's token>`

  Both values are passed by env and never printed. Expected stages, in order:
  - API 2xx `[]`;
  - compose opened, recipient exactly one, body ok, Call panel empty, send enabled, cleared;
  - thread found, known token true, dummy token false, bid id read. Exit 0, and the journal is empty.
- [ ] **Step 2: The backup.** Add `/home/drbartender/.gvoice-profile` to `~/.config/restic/excludes.txt` (spec law 11's explicit guarantee). Check that `~/bin/restic-backup.sh` `HOME_INCLUDES` does not name it, and `stat -c %a ~/.gvoice-profile`. Expected: absent, and `700`.
- [ ] **Step 3: Write the docs.**
- [ ] **Step 4:** `cd gv-agent && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** Then review and merge (last).

---

## Rollout (after every lane is merged and Dallas cues the push)

1. **Install on the box.** `cd ~/projects/os/gv-agent && npm ci`. Claude generates `GV_AGENT_SECRET` (`openssl rand -hex 32`) into `gv-agent/.env`, with API base `https://api.drbartender.com`. Dallas sets the same value in Render; Render env is Dallas by hand.
2. **Start the service.** `cp gv-agent/systemd/gv-agent.service ~/.config/systemd/user/ && systemctl --user daemon-reload && systemctl --user enable --now gv-agent`. Check the log: with the flag off, it polls and leases nothing.
3. **Flip the switch.** Dallas sets `GV_PROPOSAL_POST_ENABLED=true` in Render at a quiet moment.
4. **Live proof.** Send the next relay proposal and watch it through:
   - the `gv_posts` row goes queued, then leased, then sent;
   - a Business `thumbtack_messages` row with the exact body arrives in about 15 s;
   - the proposal page reads `In the Thumbtack thread`;
   - the Inbox shows one proposal send "also posted to Thumbtack".
5. **Rollback.** Flip `GV_PROPOSAL_POST_ENABLED` off. Queued rows drain to the 888 within 5 minutes, and `systemctl --user stop gv-agent` stops the box. To revert code: flag off first; wait until no row is `queued` or `leased`; revert gv-post-inbox and gv-post-ui before gv-post-server (they import `gvPost/*`). The new tables can stay.
