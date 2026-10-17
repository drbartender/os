---
spec: docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md   # rev 3 plus section 10 (spike results, GO)
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
      - server/routes/comms*.test.js
      - server/utils/sendProposalSentEmail.js
      - server/utils/sendProposalSentEmail*.test.js
      - server/utils/comms/actions/proposalResend.js
      - server/utils/comms/actions/proposalResend*.test.js
    blockedBy: []
    review: full-fleet + second-opinion   # outward texts from Dallas's personal GV, a new agent secret, schema, the proposal send path
  - id: gv-post-ui
    footprint:
      - server/routes/proposals/getOne.js
      - server/routes/proposals/getOne*.test.js
      - client/src/components/GvPostStatus.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/components/SendModal/SendModal.jsx
      - client/src/components/SendModal/sendResult.js
      - client/src/components/SendModal/sendResult.test.js
      - README.md
    blockedBy: [gv-post-server]
    review: code-review + ui-ux-review
  - id: gv-post-inbox
    footprint:
      - server/utils/inbox/readThumbtack.js
      - server/utils/inbox/normalize.js
      - server/utils/inbox/classify.js
      - server/utils/inbox/thread.js
      - server/utils/inbox/*.test.js
    blockedBy: [gv-post-server]
    review: full-fleet   # server/utils/inbox/** is sensitive
  - id: gv-sender
    footprint:
      - gv-agent/**
      - .gitignore
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
    blockedBy: []   # built against the endpoint contract in Task 6; its live dry run (Task 14) waits for gv-post-server on main
    review: full-fleet   # drives Dallas's personal Google account; the at-most-once send law
pushGate: Ships dark. GV_PROPOSAL_POST_ENABLED stays unset in Render until the gv-agent service runs on the box with GV_AGENT_SECRET set on both sides and its dry run passes (Rollout below). The flip is Dallas's, at a quiet moment; the first relay proposal after it is the live proof.
---

# Proposal link into the Thumbtack thread through Google Voice: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an admin sends or resends a proposal to a Thumbtack relay client, the box posts the proposal text through Google Voice into the customer's Thumbtack thread instead of the 888 text. Today's text goes out instead whenever the post definitely did not happen.

**Architecture:** The proposal-text choke points ask one router (`routeProposalText`) whether to queue a GV post or text from the 888. Queued posts live in `gv_posts`. A box service (`gv-agent/`) leases one at a time over a secret-gated API, sends through the spike-proven GV web flow, and reports back. A 60-second sweep drains stale rows to the 888 fallback and raises one email per outage. "In the thread" is derived at read time from `thumbtack_messages`, never written by the webhook.

**Tech Stack:**
- Server: Node, Express, raw SQL on Neon Postgres, `node --test`.
- Client: React 18 (CRA).
- Box agent: Playwright with `channel: 'chrome'` under `xvfb-run`, the same recipe as `thumbtack-agent`.
- No new npm dependency in the server or client. `gv-agent` pins the same `playwright` range as `thumbtack-agent` (`^1.61.0`) plus `dotenv`.

**Spec:** `docs/superpowers/specs/2026-10-17-tt-proposal-link-via-gv-design.md`. Read sections 5, 6 and 10 before any task.

## Global Constraints

- The repo is public: no real person's name, email or phone number in code, tests, fixtures, commits or docs. Fixtures use invented names and `555-01xx` numbers.
- Dev DB is shared: one suite at a time (`node --test <file>` from the repo root), no TEMP tables, read the pass count. Each new DB test file starts with `require('dotenv').config()`, a production guard, and `process.env.SEND_NOTIFICATIONS = 'false'`, like `server/routes/thumbtackAgent.replies.test.js`.
- No em dashes in copy or docs. API JSON snake_case, JS camelCase, errors as `AppError` subclasses, parameterized SQL only. Schema statements are idempotent, and enumerated CHECKs are drop-and-re-add `DO` blocks.
- Kill switch: `GV_PROPOSAL_POST_ENABLED === 'true'` only. Off means exactly today's behavior (spec law 2).
- Never a phone number in logs, UI, diag file names or Sentry beyond last-4 (spec law 11).
- One pooled connection per request. Release the client BEFORE calling the fallback sender or `notifyAdminCategory`, both of which take their own connections.
- No new writer of `initial_proposal` or `proposal_sent_sms`. The 888 fallback calls the existing send sites, so `server/utils/answeringMessageTypes.test.js` passes unchanged.
- The GV sender never touches the Call panel (spec section 10, the call-dialer trap).
- Every lane: the review named in front-matter, `npm run check:filesize`, files under 700 lines. `ProposalDetail.js` is 968 lines and must stay under 1000.
- Lanes are cut with `npm run worktree:new <lane-id>`, squash-merged from `os` by `scripts/merge-lane.sh`, and never pushed without Dallas's own imperative cue.

## Decisions made in planning (builder calls inside the spec's laws)

1. **The lease carries no request id.** The GV notice URL's `bids/{id}` IS `thumbtack_leads.negotiation_id`, so `wrong_thread` needs only the negotiation id.
2. **Four env vars:** `GV_PROPOSAL_POST_ENABLED`, `GV_AGENT_SECRET`, `RUN_GV_POST_SWEEP_SCHEDULER` and `GV_POST_DAILY_CAP` (default 25, through `readEnvInt`). Every other window is a code constant in `server/utils/gvPost/rules.js`:
   - stale: 5 min
   - lease: 3 min
   - spacing: 10 min
   - paste-before window: 30 min
   - not-seen grace: 2 min
   - liveness: 30 min
   - consecutive pre-click failures that count as an outage: 3
   - lead age: 180 days
   - prune: 30 days
3. **One job per lease.** The box handles one post at a time.
4. **The unread restore.** When the box sends into an existing GV thread that showed unread before, it marks the thread unread again afterwards. This is best-effort and never fails the send, so Dallas's phone badge for the customer's own message survives.
5. **The 888 fallback goes through the send path that queued the post.** That is `sendInitialProposalText` for `initial` and `sendResendText` for `resend`, both still holding their single pinned write literal.

## Review Focus

Inputs the spec implies that no task's tests would otherwise exercise; each line's test is pinned to the task named.
1. **An admin double-clicks Send or Resend.** Two concurrent `routeProposalText` calls produce one `gv_posts` row; the second returns `merged`, with no 888 text and no second post. Test: Task 4, `concurrent routes for one proposal yield one row and one merged`.
2. **The proposal is archived, or the client opts out, between enqueue and lease.** The row ends `cancelled` with no fallback text. Test: Task 6, `lease cancels an archived proposal without a fallback`.
3. **A box report lands after the sweep marked the row `unknown`.** It is ignored, the status stays `unknown`, and no fallback goes out. Test: Task 6, `report on a non-leased row is ignored`.
4. **The flag is flipped off with rows queued.** The lease returns `[]`, and the sweep still stales each row and sends exactly one fallback. Test: Task 7, `flag off still drains queued rows to one fallback each`.
5. **The box crashes after clicking Send and restarts.** The journal holds the id, so it reports `clicked_unverified` and never re-sends. Test: Task 13, `journaled job id is reported clicked_unverified and never re-sent`.

---

## Lane gv-post-server

### Task 1: Schema, boot contract, sensitive paths

**Files:**
- Modify: `server/db/schema.sql` (append after the `zola_leads` block)
- Modify: `server/db/index.js` (`CRITICAL_INDEXES`, `CONSTRAINT_CONTRACT`)
- Modify: `server/db/constraintContract.test.js`, `server/db/criticalIndexes.test.js`
- Modify: `scripts/sensitive-paths.txt` (add `server/utils/gvPost/*.js`, `server/routes/gvAgent.js`, `server/utils/sendProposalSentEmail.js`, `gv-agent/src/*.js`)

**Interfaces:**
- Produces: table `gv_posts` with columns
  - `id` SERIAL PK
  - `proposal_id` INT NOT NULL FK proposals ON DELETE CASCADE
  - `client_id` INT FK clients SET NULL
  - `lead_id` INT FK thumbtack_leads SET NULL
  - `negotiation_id` VARCHAR(64) NOT NULL
  - `body` TEXT NOT NULL
  - `send_path` TEXT NOT NULL
  - `sent_by` INT FK users SET NULL
  - `status` TEXT NOT NULL DEFAULT 'queued'
  - `reason` TEXT
  - `fallback_status` TEXT
  - `leased_at`, `reported_at`, `clicked_at` TIMESTAMPTZ
  - `created_at`, `updated_at` TIMESTAMPTZ NOT NULL DEFAULT NOW()
- Produces: CHECKs (one `DO` block each):
  - `gv_posts_status_check`: status IN ('queued','leased','sent','clicked_unverified','failed_preclick','skipped_already_posted','stale','unknown','cancelled')
  - `gv_posts_send_path_check`: send_path IN ('initial','resend')
  - `gv_posts_fallback_status_check`: fallback_status IS NULL OR IN ('claimed','sent','suppressed','failed')
- Produces: indexes
  - `uq_gv_posts_open_per_proposal` UNIQUE (proposal_id) WHERE status IN ('queued','leased')
  - `idx_gv_posts_queued` (created_at) WHERE status = 'queued'
  - `idx_gv_posts_proposal` (proposal_id, created_at DESC)
- Produces: table `gv_sender_state`, with `id` SMALLINT PK DEFAULT 1 CHECK (id = 1), `outage_since` TIMESTAMPTZ, `outage_reason` TEXT, `outage_alerted_at` TIMESTAMPTZ, `last_lease_at` TIMESTAMPTZ, `last_success_at` TIMESTAMPTZ, `consecutive_preclick_failures` INT NOT NULL DEFAULT 0, and `updated_at`. Seed it with `INSERT ... (id) VALUES (1) ON CONFLICT DO NOTHING`.
- No phone number column (spec law 11: the number is resolved at lease).

- [ ] **Step 1: Write the failing tests.** In `constraintContract.test.js`, assert `CONSTRAINT_CONTRACT` has `{ table: 'gv_posts', constraint: 'gv_posts_status_check' }` whose `mustContain` lists all nine statuses. In `criticalIndexes.test.js`, assert `CRITICAL_INDEXES` includes `uq_gv_posts_open_per_proposal`.
- [ ] **Step 2: Run them.** `node --test server/db/constraintContract.test.js` then `node --test server/db/criticalIndexes.test.js`. Expected: FAIL on the new assertions.
- [ ] **Step 3: Add the schema statements, the contract entries and the sensitive paths.**
- [ ] **Step 4: Prove the schema applies twice cleanly on dev:** `node -e "require('dotenv').config(); require('./server/db').initDb().then(()=>{console.log('ok');process.exit(0)})"`, run twice. Expected: `ok` both times, with no `unexpected` contract or index warning naming `gv_posts`. Then re-run both test files. Expected: PASS.
- [ ] **Step 5: Commit** (lane checkpoint): `git add server/db/schema.sql server/db/index.js server/db/constraintContract.test.js server/db/criticalIndexes.test.js scripts/sensitive-paths.txt`.

### Task 2: Identity rule (spec law 1)

**Files:**
- Create: `server/utils/gvPost/identity.js`
- Test: `server/utils/gvPost/identity.test.js` (DB; invented fixture clients, leads and proposals created and deleted under a `RUN` prefix)

**Interfaces:**
- Consumes: `THUMBTACK_PROXY_ROLLOUT` from `server/utils/inbox/constants.js` (never redeclare it; `inbox/personKey.test.js` allows one); `last10` from `server/utils/phone.js`; `normalizePhone` from `server/utils/sms.js`.
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
  3. If any such lead has a `client_id` other than the proposal's, return `foreign_lead`.
  4. The chosen lead is the one with `proposal_id = proposalId`. Otherwise it is this client's leads on that number; more than one means `ambiguous_lead`.
  5. The chosen lead's own last10 must equal the client's, else `lead_not_on_phone`.
  6. Its `created_at` must be within 180 days, else `lead_too_old`.

- [ ] **Step 1: Write the failing tests:**
  - `linked lead on the client phone resolves`
  - `single unlinked lead of the same client resolves`
  - `two unlinked leads of the same client on one number is ambiguous_lead`
  - `another client's lead on the number is foreign_lead`
  - `only a pre-rollout lead is not_relay`
  - `linked lead on a different number is lead_not_on_phone`
  - `lead older than 180 days is lead_too_old`

  Each asserts the exact `reason`, or `ok: true` with the expected `negotiationId`.
- [ ] **Step 2: Run** `node --test server/utils/gvPost/identity.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `resolveGvTarget`.** Two parameterized queries on the passed `db`; no writes.
- [ ] **Step 4: Run again.** Expected: 7/7 PASS.
- [ ] **Step 5: Commit.**

### Task 3: Rules, body validation, suppression

**Files:**
- Create: `server/utils/gvPost/rules.js`, `server/utils/gvPost/suppression.js`
- Modify: `server/utils/comms/actions/proposalResend.js` (add `RESENDABLE` to its exports; nothing else)
- Test: `server/utils/gvPost/rules.test.js` (pure), `server/utils/gvPost/suppression.test.js` (DB, one `sms_optouts` fixture row)

**Interfaces:**
- Produces in `rules.js`:
  - `GV_BODY_MAX = 320`
  - the constants named in Decision 2, as `GV_WINDOWS = { staleMin: 5, leaseMin: 3, spacingMin: 10, pasteBeforeMin: 30, notSeenGraceMin: 2, livenessMin: 30, outageFailures: 3, leadMaxAgeDays: 180, pruneDays: 30 }`
  - `GV_PRECLICK_REASONS`, a Set of `no_thread`, `wrong_thread`, `invalid_body`, `invalid_number`, `session_expired`, `challenge`, `cap`, `timeout`, `ui_error_before_send`
  - `function gvPostEnabled()`, which is `process.env.GV_PROPOSAL_POST_ENABLED === 'true'`
  - `function gvDailyCap()`, which is `readEnvInt('GV_POST_DAILY_CAP', 25)`
  - `function normalizeGvBody(body)`: collapse `\r?\n` runs to one space, then trim
  - `function validateGvBody(body, token)`, which returns `{ ok: true, body }` or `{ ok: false, reason }` with reason `too_long`, `no_link`, `wrong_link` or `multiple_links`. It requires exactly one `${PUBLIC_SITE_URL}/proposal/<uuid>` (from `server/utils/urls.js`), and that uuid must equal `token`.
- Produces in `suppression.js`: `async function gvSuppression({ proposal, client, phone }, db = pool)`, which returns `{ ok: true }` or `{ ok: false, reason }`.
  - It calls `shouldSendImmediate({ proposal: { id, status }, client: { communication_preferences, email_status, phone_status }, channel: 'sms' })` (`server/utils/messageSuppression.js`) and passes its reason through (`archived`, `channel_disabled`, `bad_contact`).
  - Then `activeOptOut(phone, db)` (`server/utils/smsOptOut.js`) gives `opted_out`.
  - Then `proposal.status` must be in `RESENDABLE` (exported from `proposalResend.js` by this task), else `not_sendable`.

- [ ] **Step 1: Write the failing tests:**
  - rules: `line breaks collapse to single spaces`, `a 321-character body is too_long`, `a body without the link is no_link`, `a link with another token is wrong_link`, `two links is multiple_links`, `the template body with its trailing period validates`
  - suppression: `archived proposal is archived`, `sms_enabled false is channel_disabled`, `active sms_optouts row is opted_out`, `a cleared opt-out passes`, `status draft is not_sendable`
- [ ] **Step 2: Run both files.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both.** Expected: PASS (6/6 and 5/5).
- [ ] **Step 5: Commit.**

### Task 4: The router and queue (`routeProposalText`)

**Files:**
- Create: `server/utils/gvPost/queue.js`
- Test: `server/utils/gvPost/queue.test.js` (DB)

**Interfaces:**
- Consumes: `resolveGvTarget` (Task 2); `gvPostEnabled`, `normalizeGvBody`, `validateGvBody`, `gvDailyCap` and `GV_WINDOWS` (Task 3); `notificationsEnabled` from `server/utils/notificationsEnabled.js`.
- Produces: `async function routeProposalText({ proposalId, token, body, sentBy = null, sendPath })`, where `sendPath` is `'initial'` or `'resend'`. It returns:
  - `{ route: 'gv', id }` when it inserted a queued row
  - `{ route: 'merged', id }` when an open row already exists for the proposal (the unique index fired)
  - `{ route: 'twilio', reason }` otherwise, with reason one of: `disabled`, `notifications_off`, an identity reason, a body reason, `cap`, `spacing`, `error`
- Order of checks:
  1. flag
  2. notifications
  3. identity
  4. body
  5. cap: rows with status IN ('queued','leased','sent','clicked_unverified','unknown') created in the last 24 h, compared with `gvDailyCap()`
  6. spacing: any such row for the same `negotiation_id`, or a lead on the same number, within 10 min
  7. `INSERT ... ON CONFLICT (proposal_id) WHERE status IN ('queued','leased') DO NOTHING RETURNING id`; on no row, select the open row's id and return `merged`

  Any throw goes to Sentry (tags `{ feature: 'gv_post', stage: 'route' }`, no number) and returns `{ route: 'twilio', reason: 'error' }`. This is spec law 5's fail-open.

- [ ] **Step 1: Write the failing tests:**
  - `flag off routes twilio disabled`
  - `notifications off routes twilio notifications_off`
  - `relay client with a valid body queues one row with status queued and no phone column`
  - `non-relay client routes twilio not_relay`
  - `a second route while one is open returns merged with the same id`
  - `concurrent routes for one proposal yield one row and one merged` (Review Focus 1: `Promise.all` of two calls; exactly one `gv`, one `merged`, count(*) = 1)
  - `cap reached routes twilio cap` (set `GV_POST_DAILY_CAP=1` with one open row)
  - `a post to the same number within 10 minutes routes twilio spacing`
  - `a throwing identity lookup routes twilio error` (stub via a `__setDeps` seam)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `routeProposalText`** with a `__setDeps({ resolveGvTarget })` seam.
- [ ] **Step 4: Run.** Expected: 9/9 PASS.
- [ ] **Step 5: Commit.**

### Task 5: The two choke points and the SendModal's server side

**Files:**
- Modify: `server/utils/sendProposalSentEmail.js`
- Modify: `server/utils/comms/actions/proposalResend.js`
- Modify: `server/routes/comms.js` (the SMS validation, L102-108)
- Test: `server/utils/sendProposalSentEmail.gvPost.test.js`, `server/utils/comms/actions/proposalResend.gvPost.test.js`, `server/routes/comms.gvPost.test.js`

**Interfaces:**
- Consumes: `routeProposalText` (Task 4); `resolveGvTarget` (Task 2); `GV_BODY_MAX` and `validateGvBody` (Task 3).
- Produces in `sendProposalSentEmail.js`: `async function sendInitialProposalText(proposal, { sentBy = null, actorType = 'admin', via = 'auto' } = {})`, exported.
  - It holds the existing SMS leg (L69-115), including the single `messageType: 'initial_proposal'` literal.
  - After `shouldSendImmediate` passes, when `via === 'auto'` and `actorType === 'admin'`, it calls `routeProposalText({ proposalId: proposal.id, token: proposal.token, body, sentBy, sendPath: 'initial' })`. A `gv` or `merged` result returns `{ outcome: 'queued' }` without calling `sendAndLogSms`.
  - `via: 'twilio'` (the fallback) skips the router.
  - Returns `{ outcome: 'queued' | 'sent' | 'suppressed' | 'skipped' }`.
  - `sendProposalSentEmail` calls it with its `actorType`, so the website wizard (`actorType: 'client'`) never routes.
- Produces in `proposalResend.js`:
  - export `load` (`RESENDABLE` was exported in Task 3);
  - export `async function sendResendText({ row, phone, body, ctx = {} })`, holding the existing Twilio leg (L218-228) and its single `` `${messageType}_sms` `` ledger shape, returning `'sent' | 'failed'`;
  - in `dispatch`, inside the `wantSms && available` block, call `routeProposalText({ proposalId: row.id, token: row.token, body, sentBy: ctx.sentBy, sendPath: 'resend' })` first. A `gv` or `merged` result sets `results.sms = 'queued'` and `results.sms_route = 'thumbtack'`, and writes no `message_log` row.
  - `resolveRecipient` (async) adds `channels.sms.via` and `channels.sms.max_chars`, plus `recipient.phone_last4` when relay. `via` is `'thumbtack'` when `gvPostEnabled()` and `resolveGvTarget(...).ok`, else `'twilio'`; `max_chars` is `GV_BODY_MAX` for thumbtack and 640 otherwise. `resolveFromRow` stays sync and unchanged.
- Produces in `comms.js`: for a `proposal_send` or `proposal_resend` action whose resolved `channels.sms.via === 'thumbtack'`, a body over 320 throws `ValidationError({ sms_body: 'Thumbtack texts are capped at 320 characters.' })`, and a body failing `validateGvBody` throws `ValidationError({ sms_body: 'The text must include the proposal link.' })`.

- [ ] **Step 1: Write the failing tests:**
  - `admin initial send to a relay client queues and never calls sendAndLogSms`
  - `admin initial send to a non-relay client texts as today`
  - `wizard send with actorType client never routes`
  - `via twilio skips the router` (stub `sendAndLogSms` and `routeProposalText` through `__setDeps`)
  - `resend dispatch to a relay client returns sms queued with sms_route thumbtack and writes no message_log row`
  - `resolveRecipient marks a relay client via thumbtack with max_chars 320 and phone_last4`
  - `comms send rejects a relay body over 320 with the cap message`
  - `comms send rejects a relay body without the link`
- [ ] **Step 2: Run each file.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run each file, then** `node --test server/utils/answeringMessageTypes.test.js`. Expected: all PASS, with the pin test unchanged.
- [ ] **Step 5: Commit.**

### Task 6: Fallback, outage, the agent API, and the read-time status

**Files:**
- Create: `server/utils/gvPost/fallback.js`, `server/utils/gvPost/outage.js`, `server/utils/gvPost/status.js`, `server/routes/gvAgent.js`
- Modify: `server/index.js` (mount at `/api/gv-agent`, next to the `/api/admin/thumbtack` mount at L353)
- Test: `server/utils/gvPost/status.test.js` (pure), `server/routes/gvAgent.test.js` (auth), `server/routes/gvAgent.queue.test.js` (lease and report, DB, real router on `express()` with the `node:http` helper pattern of `thumbtackAgent.replies.test.js`)

**Interfaces:**
- Consumes: Tasks 2-5, `notifyAdminCategory` (`server/utils/adminNotifications.js:158`), and `safeEqual` (`server/utils/secrets.js`).
- Produces in `fallback.js`: `async function sendGvFallback(postId)`, which returns `'sent' | 'suppressed' | 'failed' | 'already'`.
  1. Claim with `UPDATE gv_posts SET fallback_status = 'claimed' WHERE id = $1 AND fallback_status IS NULL RETURNING *`; no row means `'already'`.
  2. Re-check `gvSuppression` at send time; suppressed means `fallback_status = 'suppressed'`.
  3. For `send_path 'initial'`, call `sendInitialProposalText(<proposal re-fetched with the lifecycle.js L167-173 client join>, { sentBy: post.sent_by, via: 'twilio' })`.
  4. For `'resend'`, call `sendResendText({ row: await load(post.proposal_id), phone, body: post.body, ctx: { sentBy: post.sent_by } })`.
  5. Set `fallback_status` from the result: `sent` stays `sent`, `suppressed` stays `suppressed`, and `skipped` or `failed` become `failed`.
- Produces in `outage.js`, all on `gv_sender_state`:
  - `async function noteOutage(reason)`: opens the episode if closed. Email when `outage_alerted_at IS NULL`, setting it in the same UPDATE ... RETURNING claim. `notifyAdminCategory({ category: 'routine_thumbtack', subject, emailHtml, emailText })` gets no `smsBody` (email only).
  - `async function noteSuccess()`: closes the episode and zeroes the counter.
  - `async function notePreclickFailure(reason)`: increments the counter unless the reason is `cap` or `no_thread`; at 3, calls `noteOutage('preclick_failures')`.
  - Copy, verbatim:
    - Subject: `Google Voice sender is down: Thumbtack customers are getting the toll-free text`
    - Text: `The box's Google Voice sender stopped posting proposal links (reason: {reason}). Thumbtack customers are getting today's toll-free text instead, so nothing is lost. To fix it, sign GV back in on the box (gv-agent/README.md); the sender picks up on its next poll.`
- Produces in `status.js`:
  - `function deriveGvDisplay(post, echoes, now = new Date())`, pure. It returns one of `queued`, `sent_not_seen`, `in_thread`, `check_thread` (for clicked_unverified and unknown), `skipped_already_posted`, `fallback`, `fallback_suppressed`, `fallback_failed`, `cancelled`, `sending` (for leased, or sent within the 2-minute grace).
    - `in_thread` means an echo whose `normalizeGvBody(text)` equals `normalizeGvBody(post.body)`.
    - An echo holding the token without a body match sets `hand_pasted: true` and never makes `in_thread`.
  - `async function gvPostStatusForProposal(proposalId, db = pool)`, which returns `null` or `{ status, display, reason, fallback_status, created_at, clicked_at, in_thread_at, hand_pasted, phone_last4 }`. It reads the latest row plus `thumbtack_messages` on `negotiation_id` from `created_at - 30 min` whose text holds the token.
- Produces in `gvAgent.js`:
  - Its own `rateLimit({ windowMs: 60000, max: 30 })`.
  - Header `x-gv-agent-secret` against `GV_AGENT_SECRET` through `safeEqual`. Unset means 401 in every env, with a Sentry warning naming the path and no secret.
  - Exports `{ router, __setDeps }`.
- Routes:
  - `GET /pending` returns `[]` unless `gvPostEnabled()`.
    1. In one transaction on one client, `SELECT ... WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`.
    2. Re-validate:
       - identity fails: `failed_preclick`, reason `identity_mismatch`, plus fallback
       - suppression fails: `cancelled`, with no fallback
       - the token is in `thumbtack_messages` on any negotiation whose lead carries that number since `created_at - 30 min`: `skipped_already_posted`
       - cap or spacing fails: `failed_preclick` (`cap`), plus fallback
       - otherwise: `leased`, with `leased_at = now()`
    3. Stamp `gv_sender_state.last_lease_at`, COMMIT, release.
    4. Then run any fallback.
    5. Respond `[{ id, phone, body, negotiation_id }]` or `[]`.
  - `POST /report` takes `{ id, outcome, reason? }`.
    - `outcome` must be one of `sent`, `clicked_unverified`, `failed_preclick`, `skipped_already_posted`, and a `failed_preclick` reason must be in `GV_PRECLICK_REASONS`; anything else is 400.
    - It runs `UPDATE ... SET status = $outcome, reason, reported_at = now(), clicked_at = CASE WHEN $outcome IN ('sent','clicked_unverified') THEN now() END WHERE id = $1 AND status = 'leased' RETURNING id`. No row means 200 `{ ignored: true }` and a log line.
    - `sent` calls `noteSuccess()`. `failed_preclick` calls `notePreclickFailure(reason)`, then `sendGvFallback(id)` after release.
  - `POST /status` takes `{ state }`, which must be `session_expired` or `challenge`, and calls `noteOutage(state)`.
- Observability:
  - A Sentry warning, tagged `{ feature: 'gv_post', event }`, on `/report` with `clicked_unverified` or `failed_preclick` and on `/status`. Its extras are the post id and reason only.
  - One console line per lease, report and status, with the post id, the outcome and the last-4 at most.

- [ ] **Step 1: Write the failing tests.**
  - status (pure):
    - `exact body echo is in_thread`
    - `token-only echo is hand_pasted, not in_thread`
    - `sent with no echo past 2 minutes is sent_not_seen`
    - `stale with fallback sent is fallback`
    - `unknown is check_thread`
  - auth:
    - `no secret configured is 401`
    - `wrong secret is 401`
    - `right secret with flag off returns []`
  - queue:
    - `lease returns one job with phone, body and negotiation_id and marks it leased`
    - `lease cancels an archived proposal without a fallback` (Review Focus 2)
    - `lease skips a row whose token is already in the thread`
    - `lease turns an identity mismatch into failed_preclick and sends one fallback` (stub `sendGvFallback` via `__setDeps`)
    - `report sent closes the outage episode`
    - `report failed_preclick with a whitelisted reason sends one fallback`
    - `report with an unknown reason is 400`
    - `report on a non-leased row is ignored` (Review Focus 3)
    - `three non-cap pre-click failures email once`
    - `status session_expired emails once per episode` (stub `notifyAdminCategory`; assert one call and no `smsBody`)
- [ ] **Step 2: Run each file alone.** Expected: FAIL.
- [ ] **Step 3: Implement, and mount in `server/index.js`.**
- [ ] **Step 4: Run each file alone.** Expected: all PASS.
- [ ] **Step 5: Commit.**

### Task 7: The sweep, its registration, and the lane's docs

**Files:**
- Create: `server/utils/gvPostSweepScheduler.js`
- Modify: `server/index.js` (register next to `RUN_FIRST_REPLY_FALLBACK_SCHEDULER`, L759-773)
- Modify: `.claude/CLAUDE.md` (env table), `README.md` (env table, folder tree under `server/utils/` and `server/routes/`), `ARCHITECTURE.md` (route table: a "GV agent" block beside the Thumbtack harvester table at L765; schema; third-party integrations: Google Voice web automation), `.env.example`
- Test: `server/utils/gvPostSweepScheduler.test.js` (DB)

**Interfaces:**
- Consumes: `sendGvFallback`, `noteOutage` (Task 6), `GV_WINDOWS` (Task 3).
- Produces: `async function runGvPostSweep()`, which returns `{ staled, unknowned, alerted, pruned }` and rethrows the first arm error after all arms run. Arms:
  1. `UPDATE gv_posts SET status = 'stale' WHERE status = 'queued' AND created_at < now() - 5 min RETURNING id`, then `sendGvFallback` for each id.
  2. `UPDATE ... SET status = 'unknown' WHERE status = 'leased' AND leased_at < now() - 3 min` (no fallback).
  3. When arm 1 staled any row and `last_lease_at` is NULL or older than 30 min, call `noteOutage('no_lease')`.
  4. `DELETE FROM gv_posts WHERE created_at < now() - 30 days`.
  - Arms 1 and 2 each send one Sentry warning per run that touched rows (`{ feature: 'gv_post', event: 'stale' | 'unknown' }`, with the count as an extra).
- Registration: `if (enabled('RUN_GV_POST_SWEEP_SCHEDULER'))`, using `wrapScheduler('gv_post_sweep', 60, ...)`, `setTimeout(wrapped, 25000)` and `setInterval(wrapped, 60000)`, else `clearHealthRow('gv_post_sweep')`. It is NOT gated by `GV_PROPOSAL_POST_ENABLED` (spec law 2).
- The CLAUDE.md env rows follow the table's voice:
  - `GV_PROPOSAL_POST_ENABLED`: master switch, default OFF, `'true'` enables; gates enqueue and empties `/api/gv-agent/pending`; the sweep stays ungated so a rollback drains to the 888.
  - `GV_AGENT_SECRET`: BLAST RADIUS: reads pending post bodies, which carry proposal tokens, and relay numbers, and can mark rows. Leak response: rotate it on Render and in `gv-agent/.env`, and flip `GV_PROPOSAL_POST_ENABLED` off.
  - `RUN_GV_POST_SWEEP_SCHEDULER`.
  - `GV_POST_DAILY_CAP` (default 25; `0`, blank or nonsense fall back).

- [ ] **Step 1: Write the failing tests:**
  - `a queued row older than 5 minutes goes stale and sends one fallback across two sweeps`
  - `a leased row older than 3 minutes goes unknown with no fallback`
  - `stale rows with no lease in 30 minutes email once`
  - `flag off still drains queued rows to one fallback each` (Review Focus 4)
  - `rows older than 30 days are pruned`
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement, register, and write the docs.**
- [ ] **Step 4: Run the new file alone, then each earlier Task 1-6 file alone, then** `npm run check:filesize`. Expected: all PASS, no new RED.
- [ ] **Step 5: Commit.** Then the lane review (front-matter) and merge.

## Lane gv-post-ui

### Task 8: The proposal-page status row

**Files:**
- Modify: `server/routes/proposals/getOne.js` (add `gvPostStatusForProposal(req.params.id)` to the existing `Promise.all`; response key `gv_post`)
- Create: `client/src/components/GvPostStatus.js`
- Modify: `client/src/pages/admin/ProposalDetail.js` (one import, and one element in the Client card `<dl>` beside the `first_reply` row at L562-564; stays under 1000 lines)
- Test: `server/routes/proposals/getOne.gvPost.test.js`

**Interfaces:**
- Consumes: `gvPostStatusForProposal` (Task 6). The proposal response gains `gv_post: null | { status, display, reason, fallback_status, created_at, clicked_at, in_thread_at, hand_pasted, phone_last4 }`.
- Produces: `export default function GvPostStatus({ gvPost, onRefresh })`. It renders `<><dt>Thumbtack message</dt><dd className="muted">{copy}</dd></>`, or nothing when `gvPost` is null. It calls `onRefresh()` every 15 s while `display` is `queued`, `sending` or `sent_not_seen`, and for at most 10 minutes.
- Copy by `display`, verbatim (time = Chicago `h:mm a`):
  - queued: `Queued for Thumbtack`
  - sending: `Sending through Google Voice`
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
  - no_thread: `GV couldn't start the conversation`
  - identity_mismatch: `the Thumbtack lead didn't match`
  - anything else: `the sender hit a problem`

- [ ] **Step 1: Write the failing test:** `GET /proposals/:id carries gv_post for a proposal with a post and null without one`.
- [ ] **Step 2: Run alone.** Expected: FAIL.
- [ ] **Step 3: Implement the server field, the component and the one-element wiring.** `onRefresh` is ProposalDetail's existing loader.
- [ ] **Step 4: Run the test (PASS), then** `cd client && CI=true npx react-scripts build`. Expected: compiles with no ESLint warnings. Then verify in the dev app (sign in with `scripts/dev-signin.js`) on a dev proposal with a hand-inserted `gv_posts` row in each of `queued`, `stale` with `fallback_status 'sent'`, and `unknown`. Each shows its exact copy. Delete the rows after.
- [ ] **Step 5: Commit.**

### Task 9: SendModal for relay clients

**Files:**
- Modify: `client/src/components/SendModal/sendResult.js`, `client/src/components/SendModal/SendModal.jsx`
- Test: `client/src/components/SendModal/sendResult.test.js`

**Interfaces:**
- Consumes: `results.sms === 'queued'`, `results.sms_route`, `channels.sms.via`, `channels.sms.max_chars`, `recipient.phone_last4` (Task 5).
- Produces:
  - `describeSendResult`: the sms `queued` clause is `Queued for Thumbtack`, and success level applies.
  - `renderChannelResult`: `queued` renders `✓ Queued for Thumbtack (ending {phone_last4})`.
  - Compose block when `via === 'thumbtack'`:
    - label `Text via Thumbtack (GV)`
    - counter `/ {max_chars}`
    - `toLine` shows `ending {phone_last4}` instead of the number
    - Send is blocked with `The text must include the proposal link.` when the body no longer contains the default body's `/proposal/<token>` URL, and with `Thumbtack texts are capped at 320 characters.` over the cap. These are the same strings as Task 5's server validation.

- [ ] **Step 1: Write the failing tests:** `queued sms reads Queued for Thumbtack at success level`, `email sent plus sms queued reads both clauses`.
- [ ] **Step 2: Run** `cd client && CI=true npx react-scripts test --watchAll=false src/components/SendModal/sendResult.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Re-run (PASS), then the CI build.** Then, in the dev app, check a relay client's resend modal: the label, the 320 counter, both block messages, and the queued result line. Use a dev client with an invented relay lead; set `SEND_NOTIFICATIONS=false` and `GV_PROPOSAL_POST_ENABLED=true` on the lane server only.
- [ ] **Step 5: Commit.** Then add the README Key Features line, run the lane review, and merge.

## Lane gv-post-inbox

### Task 10: The GV echo counts as delivery of the proposal send

**Files:**
- Modify: `server/utils/inbox/readThumbtack.js`, `server/utils/inbox/normalize.js`, `server/utils/inbox/classify.js`, `server/utils/inbox/thread.js`
- Test: `server/utils/inbox/gvPost.test.js` (pure, fixture events)

**Interfaces:**
- Consumes: `gv_posts` (Task 1) and `normalizeGvBody` (Task 3).
- Produces:
  - `readThumbtack.js` loads `gv_posts (id, proposal_id, negotiation_id, body, fallback_status, created_at)` for the negotiations it reads. A Business row whose `normalizeGvBody(text)` equals a post's body on that negotiation gets `e.meta.gvPost = { postId, proposalId }`.
  - `normalize.js` gains `function absorbGvPosts(events)`, called right after the proposal absorb (L119-149).
    - For each `pal` proposal-send event whose proposal has a GV echo, it pushes `{ channel: 'thumbtack', failed: false }` onto `e.meta.deliveries` and removes the echo event from the stream.
    - It absorbs that proposal's `ml` rows of `PROPOSAL_SEND_MESSAGE_TYPES` created within 15 minutes of the post (the 888 fallback), whatever `PROPOSAL_ABSORB_MINUTES` says.
  - `classify.js` `case 'tt'` returns `!e.meta.gvPost`, a defensive guard for an echo with no matching send. It never makes a holding reply and never sets `autoFirstReply`.
  - `thread.js`: a `proposal_sent` row with a thumbtack delivery reads `You sent the proposal (also posted to Thumbtack)`.

- [ ] **Step 1: Write the failing tests:**
  - `a GV echo is absorbed into its proposal send as a thumbtack delivery`
  - `a text-only send with a GV echo reads delivered, not No email or text went out`
  - `an 888 fallback row 8 minutes after the send is absorbed into it`
  - `an unmatched Business message still counts as a reply`
  - `a GV echo is never a holding reply`
- [ ] **Step 2: Run alone.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new file, then every existing `server/utils/inbox/*.test.js`, one at a time.** Expected: all PASS, with the pass counts read.
- [ ] **Step 5: Commit.** Then the lane review (full fleet) and merge.

## Lane gv-sender

### Task 11: Scaffold and pure modules

**Files:**
- Create: `gv-agent/package.json`, `gv-agent/.env.example`, `gv-agent/README.md`, `gv-agent/systemd/gv-agent.service`
- Create: `gv-agent/src/config.js`, `gv-agent/src/validate.js`, `gv-agent/src/interstitial.js`, `gv-agent/src/journal.js`, plus `*.test.js` beside each pure module
- Modify: `.gitignore` (add `gv-agent/.env`; `node_modules` is already matched)

**Interfaces:**
- `package.json`: `{ "scripts": { "start": "node src/index.js", "dry-run": "node src/index.js --dry-run", "test": "node --test src/*.test.js" }, "dependencies": { "dotenv": "...same as thumbtack-agent", "playwright": "^1.61.0" } }`.
- `config.js` exports `CFG` with:
  - `apiBase` (API_BASE_URL)
  - `secret` (GV_AGENT_SECRET)
  - `profileDir` (GV_PROFILE_DIR, default `~/.gvoice-profile`)
  - `pollMs` (default 10000)
  - `outagePollMs` (default 60000)
  - `dailyCap` (default 25)
  - `jobBudgetMs` (default 90000, under the server's 3-minute lease)
  - `dryRun` (`--dry-run`)
  - `dryRunPhone` (DRY_RUN_PHONE, E.164; the company 1922 line, never a client)
- `validate.js`: `function validateJob({ phone, body, negotiation_id })` returns `{ ok: true }` or `{ ok: false, reason: 'invalid_number' | 'invalid_body' }`.
  - The phone must match `/^\+1\d{10}$/`.
  - The body must be one line of at most 320 characters with exactly one `https://drbartender.com/proposal/<uuid>`. This mirrors the server's `validateGvBody`.
- `interstitial.js`: `function classifyPage({ host, path, texts })` returns `'ok' | 'session_expired' | 'challenge'`.
  - `accounts.google.com`, or texts that include `Choose an account` or `Sign in`, give `session_expired`.
  - Texts that include `Verify it's you`, `unusual activity` or a reCAPTCHA challenge give `challenge`.
  - `voice.google.com` and nothing else gives `ok`.
- `journal.js`: `function loadJournal(file)` returns a Set; `function journalBeforeClick(file, id)` uses `appendFileSync`. The file is `<profileDir>/gv-sent.journal`.
- `systemd/gv-agent.service` copies `thumbtack-agent/systemd/thumbtack-agent.service` exactly: `UnsetEnvironment=WAYLAND_DISPLAY DISPLAY XAUTHORITY GNOME_SETUP_DISPLAY XDG_SESSION_TYPE`, `Environment=OZONE_PLATFORM=x11`, `EnvironmentFile=/home/drbartender/projects/os/gv-agent/.env`, `ExecStart=/usr/bin/xvfb-run -a /home/drbartender/.nvm/versions/node/v24.16.0/bin/node src/index.js`, `Restart=on-failure`, `RestartSec=30`.
- `README.md` carries the sign-in recipe and the call-dialer trap from spec section 10, verbatim in substance.

- [ ] **Step 1: Write the failing tests:**
  - `a 10-digit E.164 number passes and a 555 short form fails`
  - `a two-link body is invalid_body`
  - `a body with a line break is invalid_body`
  - `accounts.google.com is session_expired`
  - `Verify it's you is challenge`
  - `a journaled id is found after reload`
- [ ] **Step 2: Run** `cd gv-agent && npm test` (after `npm install` inside `gv-agent/` only; never at the repo root of a lane). Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 12: The GV flow (Playwright)

**Files:**
- Create: `gv-agent/src/gvFlow.js`, `gv-agent/src/diag.js`

**Interfaces:**
- Produces in `gvFlow.js`. Every selector is the spike-proven one from spec section 10, and the flow never addresses the Call panel except to read its input.
  - `async function openCompose(page, phone, negotiationId)` returns `{ ok: true, wasUnread }` or `{ ok: false, reason }`.
    1. Look for a `gv-thread-list-item` whose digits contain the number. If it exists, read its unread state, and fail `wrong_thread` when its latest Thumbtack notice links a `bids/` id other than `negotiationId`.
    2. Click `[aria-label="Send new message"]`.
    3. In `[role=region][aria-label="Select recipients"]`, use `input[placeholder="Type a name or phone number"]`: click it, then `pressSequentially` the 10 digits with a 100 ms delay.
    4. Click the one rendered (above 4 px) outermost `gv-contact-list` "Send to" entry whose digits equal the number. Zero or two or more fails `no_thread`.
    5. Require exactly one `button[aria-label^="Remove"]` carrying the number, with the input emptied; otherwise fail `ui_error_before_send`.
  - `async function threadHasToken(page, token)` returns a boolean (spec law 6's box re-check).
  - `async function fillAndCheck(page, body)` uses `textarea[placeholder="Type a message"]`. It calls `fill(body)`, requires `inputValue() === body`, requires the `[role=region][aria-label="Call panel"] input` to be empty, requires no visible reCAPTCHA bframe, and requires `button[aria-label="Send message"]` to be enabled. Any failure is `ui_error_before_send`, or `challenge` for a captcha.
  - `async function clickSendAndVerify(page, token)` returns `'sent' | 'clicked_unverified'`. Sent means the token is in a message bubble and the textarea is emptied within 20 s.
  - `async function restoreUnread(page)`: when `wasUnread`, mark the thread unread through GV's thread menu. Best-effort: log and continue on any miss. Pin the control's label in Task 14's dry run.
- Between steps, pause a random 300 to 1000 ms (the `thumbtack-agent` humanPause precedent).
- Produces in `diag.js`: `async function captureDiag(page, jobId, tag)`. It writes `<profileDir>/diag/<stamp>-<jobId>-<tag>.png/.json` with fs-safe names, digits masked in the JSON, and keeps 40 files.

- [ ] **Step 1:** No unit test for the browser glue (the `thumbtack-agent` precedent: only pure modules are unit-tested). Its proof is Task 14's dry run.
- [ ] **Step 2: Implement both modules.**
- [ ] **Step 3:** `node --check` on both files. Expected: no output.
- [ ] **Step 4: Commit.**

### Task 13: The agent loop

**Files:**
- Create: `gv-agent/src/index.js`, `gv-agent/src/decide.js`
- Test: `gv-agent/src/decide.test.js`

**Interfaces:**
- Consumes: Tasks 11-12, and the Task 6 API: `GET /api/gv-agent/pending`, `POST /api/gv-agent/report`, `POST /api/gv-agent/status`, all with header `x-gv-agent-secret`.
- Produces in `decide.js` (pure):
  - `function decideJob({ job, journal, sentToday, cap })` returns `{ action: 'report', outcome, reason? }` or `{ action: 'run' }`:
    - a journaled id gives `report clicked_unverified`;
    - `sentToday >= cap` gives `report failed_preclick cap`;
    - an invalid job gives `report failed_preclick <reason>`.
  - `function underBudget(startMs, nowMs, budgetMs)` returns a boolean.
- `index.js`:
  - Loop: poll every `pollMs`, launching the browser once per job and closing it after.
  - On a non-ok `classifyPage`: POST `/status`, report `failed_preclick` with that reason, and switch to `outagePollMs` until a poll finds the session ok.
  - Before the click, if `underBudget` is false, report `failed_preclick timeout`.
  - Journal before the click.
  - Reports are retried 3 times, with only 2xx counted.
  - The day counter rolls over at Chicago midnight (`thumbtack-agent/src/cadence.js` `rolloverDay` pattern).
  - `--dry-run` runs `openCompose` and `fillAndCheck` against `CFG.dryRunPhone` with the body `dry run, never sent`, logs each stage, clears the textarea, and exits without any click on Send.

- [ ] **Step 1: Write the failing tests:**
  - `journaled job id is reported clicked_unverified and never re-sent` (Review Focus 5)
  - `cap reached reports failed_preclick cap`
  - `invalid body reports failed_preclick invalid_body`
  - `a fresh valid job runs`
  - `budget exceeded is not under budget`
- [ ] **Step 2: Run** `cd gv-agent && npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit.**

### Task 14: Box dry run and the lane's docs

**Files:**
- Modify: `README.md` (folder tree: add `gv-agent/` beside the agent entries; NPM/box notes), `ARCHITECTURE.md` (the box agents section: gv-agent, its API, the profile), `.claude/CLAUDE.md` (Tech Stack: Google Voice web automation on the box)

- [ ] **Step 1: On the box, with gv-post-server on main and a dev server running it:** set `gv-agent/.env` to the dev API base, a dev-only `GV_AGENT_SECRET`, and `DRY_RUN_PHONE` (the 1922, from `server/utils/companyPhone.js`). Then run `cd gv-agent && xvfb-run -a node src/index.js --dry-run`. Expected log stages, in order: compose opened, recipient exactly one, body ok, call panel empty, send enabled, cleared. It exits 0, and the journal is empty afterwards.
- [ ] **Step 2: Pin the "Mark as unread" control's label** in a dry run against an existing read thread (open, menu, read the label, Escape, no click), and record it in `gvFlow.js`.
- [ ] **Step 3: Write the docs. Then check** `restic` coverage: `~/.gvoice-profile` must NOT appear in `~/bin/restic-backup.sh` `HOME_INCLUDES` (spec law 11). Expected: absent. Also `stat -c %a ~/.gvoice-profile`. Expected: `700`.
- [ ] **Step 4:** `cd gv-agent && npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** Then the lane review (full fleet) and merge.

---

## Rollout (after every lane is merged and Dallas cues the push)

1. **Generate the secret.** Claude generates `GV_AGENT_SECRET` on the box (`openssl rand -hex 32`) and writes it to `gv-agent/.env` (API base `https://api.drbartender.com`). Dallas sets the same value in Render; Render env is Dallas by hand.
2. **Start the service.** Claude installs and starts the service: `cp gv-agent/systemd/gv-agent.service ~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now gv-agent`. Check its log: with the flag still off, it polls and leases nothing.
3. **Flip the switch.** Dallas sets `GV_PROPOSAL_POST_ENABLED=true` in Render at a quiet moment.
4. **Live proof.** Send the next relay proposal and watch it through:
   - the `gv_posts` row goes queued, then leased, then sent;
   - a `thumbtack_messages` Business row with the exact body arrives within about 15 s;
   - the proposal page reads `In the Thumbtack thread`;
   - the Inbox shows one proposal send with a thumbtack delivery.
5. **Rollback.** Flip `GV_PROPOSAL_POST_ENABLED` off. The sweep drains queued rows to the 888 within 5 minutes, and `systemctl --user stop gv-agent` stops the box.
