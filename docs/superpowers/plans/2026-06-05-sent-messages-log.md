# Sent Messages Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-facing, newest-first "Messages" card on the event detail page that records every client-facing email and SMS (sent or failed), so the operator can confirm a send fired and catch silent failures.

**Architecture:** A single append-only `message_log` table keyed by `proposal_id`. Logging happens at the two send choke points (`sendEmail`, `sendSMS`) via a shared helper, so coverage is structural, not a per-callsite checklist. Pure entry-builders make the logging decision testable without mocking providers; the effectful `logClientMessage` resolves client/proposal and inserts, and never throws. The read folds a `messageLog` array into the existing `GET /proposals/:id` payload.

**Tech Stack:** Node/Express, raw SQL via `pg`, React 18 (CRA), node:test against the dev Neon DB.

**Spec:** `docs/superpowers/specs/2026-06-05-sent-messages-log-design.md`
**Plan-review folded in:** 2026-06-05 (see changelog at the bottom).

**Conventions used below:**
- Run one server suite at a time: `node --test server/utils/<file>.test.js` (the suites share the dev DB; running all in parallel can FK-collide on teardown).
- Apply `schema.sql` to the dev DB: `node -e "require('dotenv').config(); require('./server/db').initDb().then(()=>{console.log('schema applied');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"` (idempotent; same path the server runs on boot).
- Verify client changes compile: `cd client && set CI=true&& npx react-scripts build` (PowerShell: `cd client; $env:CI='true'; npx react-scripts build`). No client unit-test runner exists; the CRA build is the gate, plus a manual look.
- Commit style (per CLAUDE.md): explicit `git add <path>`, single-line `git commit -m "..."`, no `-A`.
- **File-size ratchet:** a file already over 1000 lines may not *grow* in a commit. `server/routes/stripe.js` (1720) and `server/routes/drinkPlans.js` (1178) are over the cap; edits to them must not add net lines (see Task 10).

---

### Task 1: Schema — `message_log` table

**Files:**
- Modify: `server/db/schema.sql` (append a new table block near the other comms tables, e.g. after the `scheduled_messages` block)

- [ ] **Step 1: Add the table + index (idempotent)**

Append to `server/db/schema.sql`:

```sql
-- message_log: append-only ledger of client-facing outbound messages (email + SMS).
-- Written at the send choke points (sendEmail / sendSMS). Keyed by proposal_id,
-- which survives proposal -> event conversion. Read by the event detail Messages
-- card. provider_id (Resend id / Twilio SID) is stored for future delivery tracking.
CREATE TABLE IF NOT EXISTS message_log (
  id            SERIAL PRIMARY KEY,
  proposal_id   INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  client_id     INTEGER NOT NULL REFERENCES clients(id),
  channel       TEXT NOT NULL CHECK (channel IN ('email','sms')),
  message_type  TEXT NOT NULL DEFAULT 'other',
  recipient     TEXT NOT NULL,
  subject       TEXT,
  status        TEXT NOT NULL CHECK (status IN ('sent','failed')),
  error_message TEXT,
  provider_id   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- created_at + id DESC: id is the deterministic tiebreaker when two rows share
-- the same created_at (back-to-back sends on one connection), so newest-first is stable.
CREATE INDEX IF NOT EXISTS idx_message_log_proposal
  ON message_log (proposal_id, created_at DESC, id DESC);
```

- [ ] **Step 2: Apply to the dev DB**

Run: `node -e "require('dotenv').config(); require('./server/db').initDb().then(()=>{console.log('schema applied');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `schema applied` and exits 0.

- [ ] **Step 3: Verify the table exists**

Run: `node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query('SELECT to_regclass($1) AS t',['public.message_log']).then(r=>{console.log(r.rows[0].t); return pool.end();})"`
Expected: prints `message_log`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(message-log): add message_log ledger table"
```

- [ ] **Step 5: Execution-review checkpoint** — dispatch the `database-review` agent on this commit (new table, FKs, index, NOT NULL columns). Address blockers before continuing.

---

### Task 2: Logging core — `server/utils/messageLog.js`

**Files:**
- Create: `server/utils/messageLog.js`
- Test: `server/utils/messageLog.test.js`

This module has no dependency on `email.js`/`sms.js` (it inlines phone normalization) to avoid a circular require, since those two will require this module.

- [ ] **Step 1: Write the failing test**

Create `server/utils/messageLog.test.js`:

```js
require('dotenv').config();
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  buildEmailLogEntry, buildSmsLogEntry, logClientMessage, getMessageLogForProposal,
} = require('./messageLog');

const TEST_EMAIL = 'msglog-test@example.com';
let clientId, proposalId;

before(async () => {
  // Clean any leftovers from a crashed prior run (clients.email is uniquely indexed).
  await pool.query('DELETE FROM message_log WHERE recipient = $1', [TEST_EMAIL]);
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = $1)', [TEST_EMAIL]);
  await pool.query('DELETE FROM clients WHERE email = $1', [TEST_EMAIL]);

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('MsgLog Test', $1, '3125550199') RETURNING id",
    [TEST_EMAIL]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party', 100000, 10000, CURRENT_DATE + INTERVAL '14 days', false)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

// Start each test with an empty ledger for this proposal so a mid-suite failure
// does not leave stale rows that confuse the next assertion.
beforeEach(async () => {
  await pool.query('DELETE FROM message_log WHERE proposal_id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM message_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('buildEmailLogEntry maps a successful send', () => {
  const e = buildEmailLogEntry({ to: 'a@b.com', subject: 'Hi', meta: { proposalId: 5, messageType: 'proposal_sent' }, result: { id: 're_123' } });
  assert.equal(e.channel, 'email');
  assert.equal(e.status, 'sent');
  assert.equal(e.providerId, 're_123');
  assert.equal(e.recipient, 'a@b.com');
  assert.equal(e.messageType, 'proposal_sent');
});

test('buildEmailLogEntry returns null for a dev-skipped result', () => {
  assert.equal(buildEmailLogEntry({ to: 'a@b.com', subject: 'x', result: { id: 'dev-skipped' } }), null);
});

test('buildEmailLogEntry marks skipLog entries', () => {
  assert.equal(buildEmailLogEntry({ to: 'a@b.com', meta: { skipLog: true }, result: { id: 're_1' } }).skipLog, true);
});

test('buildEmailLogEntry uses the first address for a multi-recipient send', () => {
  const e = buildEmailLogEntry({ to: ['first@b.com', 'second@b.com'], subject: 'x', result: { id: 're_1' } });
  assert.equal(e.recipient, 'first@b.com');
});

test('buildEmailLogEntry maps an error to failed', () => {
  const e = buildEmailLogEntry({ to: 'a@b.com', subject: 'x', error: new Error('quota reached') });
  assert.equal(e.status, 'failed');
  assert.match(e.error, /quota/);
  assert.equal(e.providerId, null);
});

test('buildSmsLogEntry returns null for a dev-skipped sid', () => {
  assert.equal(buildSmsLogEntry({ to: '+13125550199', body: 'hi', result: { sid: 'dev-skipped-1' } }), null);
});

test('logClientMessage resolves client by email + most-recent proposal and inserts', async () => {
  await logClientMessage(buildEmailLogEntry({ to: TEST_EMAIL, subject: 'Proposal', meta: { messageType: 'proposal_sent' }, result: { id: 're_abc' } }));
  const rows = await getMessageLogForProposal(proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'email');
  assert.equal(rows[0].message_type, 'proposal_sent');
  assert.equal(rows[0].status, 'sent');
});

test('logClientMessage resolves client by phone last-10', async () => {
  await logClientMessage(buildSmsLogEntry({ to: '+13125550199', body: 'reminder', meta: { messageType: 'drink_plan_nudge' }, result: { sid: 'SM_x' } }));
  const rows = await getMessageLogForProposal(proposalId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'sms');
});

test('logClientMessage writes nothing for an unknown recipient', async () => {
  await logClientMessage(buildEmailLogEntry({ to: 'nobody@nowhere.test', subject: 'x', result: { id: 're_1' } }));
  assert.equal((await getMessageLogForProposal(proposalId)).length, 0);
});

test('logClientMessage writes nothing for a skipLog entry', async () => {
  await logClientMessage(buildEmailLogEntry({ to: TEST_EMAIL, meta: { skipLog: true }, result: { id: 're_1' } }));
  assert.equal((await getMessageLogForProposal(proposalId)).length, 0);
});

test('logClientMessage never throws on a bad entry', async () => {
  await assert.doesNotReject(() => logClientMessage({ channel: 'email', recipient: null, status: 'sent' }));
});

test('getMessageLogForProposal returns newest first', async () => {
  await logClientMessage({ channel: 'email', recipient: TEST_EMAIL, clientId, proposalId, status: 'sent', messageType: 'first', subject: 'a' });
  await logClientMessage({ channel: 'email', recipient: TEST_EMAIL, clientId, proposalId, status: 'sent', messageType: 'second', subject: 'b' });
  const rows = await getMessageLogForProposal(proposalId);
  assert.equal(rows[0].message_type, 'second'); // id DESC tiebreaker makes this deterministic
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/messageLog.test.js`
Expected: FAIL with a module-not-found / `buildEmailLogEntry is not a function` error.

- [ ] **Step 3: Implement `server/utils/messageLog.js`**

```js
const { pool } = require('../db');
let Sentry = null;
try { Sentry = require('@sentry/node'); } catch (_) { /* optional */ }

// Pure: an email send outcome -> a log entry, or null to skip logging.
function buildEmailLogEntry({ to, subject, meta = {}, result, error }) {
  if (meta.skipLog) return { skipLog: true };
  const recipient = Array.isArray(to) ? to[0] : to;
  if (!recipient) return null;
  if (result && result.id === 'dev-skipped') return null; // gated/dev — not a real send
  return {
    channel: 'email',
    recipient,
    subject: subject || null,
    status: error ? 'failed' : 'sent',
    error: error ? String(error.message || error).slice(0, 500) : null,
    providerId: result && result.id ? result.id : null,
    proposalId: meta.proposalId || null,
    clientId: meta.clientId || null,
    messageType: meta.messageType || 'other',
  };
}

// Pure: an SMS send outcome -> a log entry, or null to skip logging.
function buildSmsLogEntry({ to, body, meta = {}, result, error }) {
  if (meta.skipLog) return { skipLog: true };
  if (!to) return null;
  const sid = result && result.sid ? result.sid : null;
  if (sid && String(sid).startsWith('dev-skipped')) return null; // gated/dev
  return {
    channel: 'sms',
    recipient: to,
    subject: body ? String(body).slice(0, 140) : null,
    status: error ? 'failed' : 'sent',
    error: error ? String(error.message || error).slice(0, 500) : null,
    providerId: sid,
    proposalId: meta.proposalId || null,
    clientId: meta.clientId || null,
    messageType: meta.messageType || 'other',
  };
}

// Effectful: resolve client/proposal if not supplied, then insert the ledger row.
// NEVER throws and never rejects — safe to call fire-and-forget from a send path.
async function logClientMessage(entry) {
  try {
    if (!entry || entry.skipLog) return;
    let { channel, recipient, subject, status, error, providerId,
          proposalId, clientId, messageType } = entry;

    if (!clientId) {
      if (channel === 'email') {
        const r = await pool.query(
          'SELECT id FROM clients WHERE LOWER(email) = LOWER($1) LIMIT 1',
          [recipient]
        );
        clientId = r.rows[0] ? r.rows[0].id : null;
      } else {
        const last10 = recipient ? String(recipient).replace(/\D/g, '').slice(-10) : null;
        if (last10 && last10.length === 10) {
          const r = await pool.query(
            "SELECT id FROM clients WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1 LIMIT 1",
            [last10]
          );
          clientId = r.rows[0] ? r.rows[0].id : null;
        }
      }
    }
    if (!clientId) return; // recipient is not a client — not a client ping

    if (!proposalId) {
      const r = await pool.query(
        'SELECT id FROM proposals WHERE client_id = $1 ORDER BY created_at DESC LIMIT 1',
        [clientId]
      );
      proposalId = r.rows[0] ? r.rows[0].id : null;
    }
    if (!proposalId) return; // nothing to attach to (rare, pre-event)

    await pool.query(
      `INSERT INTO message_log
         (proposal_id, client_id, channel, message_type, recipient, subject, status, error_message, provider_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [proposalId, clientId, channel, messageType || 'other', recipient,
       subject || null, status, error || null, providerId || null]
    );
  } catch (e) {
    console.error('[messageLog] log failed (send unaffected):', e.message);
    if (Sentry && Sentry.captureException) {
      Sentry.captureException(e, { tags: { area: 'message_log' } });
    }
  }
}

// Read: newest-first ledger rows for one proposal (the event detail Messages card).
// id DESC tiebreaks rows that share created_at so ordering is deterministic.
async function getMessageLogForProposal(proposalId) {
  const { rows } = await pool.query(
    `SELECT id, channel, message_type, recipient, subject, status, error_message, created_at
       FROM message_log
      WHERE proposal_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [proposalId]
  );
  return rows;
}

module.exports = { buildEmailLogEntry, buildSmsLogEntry, logClientMessage, getMessageLogForProposal };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/messageLog.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add server/utils/messageLog.js server/utils/messageLog.test.js
git commit -m "feat(message-log): logging core (builders, logClientMessage, read)"
```

---

### Task 3: Wire `sendEmail`

**Files:**
- Modify: `server/utils/email.js` (add `require`, `meta` param, two fire-and-forget log calls)

- [ ] **Step 1: Add the require**

At the top of `server/utils/email.js`, after the existing requires (line 3 area):

```js
const { buildEmailLogEntry, logClientMessage } = require('./messageLog');
```

- [ ] **Step 2: Add `meta` to the signature and log after the real send**

Change the `sendEmail` signature (line 51) to accept `meta`, and add the two log calls. The dev/gated early-return stays untouched (so dev sends are never logged). Replace the function body's send-and-return section:

```js
async function sendEmail({ to, subject, html, text, from, replyTo, attachments, meta }) {
  if (!resend || !notificationsEnabled()) {
    const why = !resend ? 'RESEND_API_KEY not set' : 'notifications gated off';
    console.log(`[DEV] Email skipped (${why}) → ${to} | Subject: ${subject}${attachments ? ` (with ${attachments.length} attachment(s))` : ''}`);
    return { id: 'dev-skipped' };
  }

  const effectiveReplyTo = replyTo || process.env.ADMIN_EMAIL || null;
  const { data, error } = await resend.emails.send({
    from: from || FROM_EMAIL,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(text && { text }),
    ...(effectiveReplyTo && { reply_to: effectiveReplyTo }),
    ...(attachments && attachments.length && { attachments }),
  });

  if (error) {
    console.error('[email] Resend send FAILED for', to, '—', error?.message || JSON.stringify(error));
    logClientMessage(buildEmailLogEntry({ to, subject, meta, error })); // fire-and-forget
    if (isQuotaError(error)) throw new QuotaExceededError(error?.message || 'Resend daily sending quota reached');
    throw new Error(error?.message || 'Resend send failed');
  }

  logClientMessage(buildEmailLogEntry({ to, subject, meta, result: data })); // fire-and-forget
  return data;
}
```

- [ ] **Step 3: Verify the module loads and an existing caller suite still passes**

Run: `node -e "require('dotenv').config(); require('./server/utils/email'); console.log('email.js loads')"`
Expected: prints `email.js loads` (proves no circular-require break).

Run: `node --test server/utils/adminNotifications.test.js`
Expected: PASS (confirms the wiring did not break an unrelated `sendEmail` caller). Note: this suite does NOT exercise the new logging branch — see Step 4.

- [ ] **Step 4: Required smoke — prove a real send logs**

The suites above do not hit the logging branch (dev gates `sendEmail` to a no-op). Do this smoke before committing: with `SEND_NOTIFICATIONS=true` in `.env`, against a scratch client+proposal, trigger one client email (e.g. POST a proposal send, or call `sendEmail` directly with `meta: { proposalId: <scratch>, messageType: 'proposal_sent' }`), then confirm a row landed:

Run: `node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query('SELECT channel,message_type,status,recipient FROM message_log ORDER BY id DESC LIMIT 5').then(r=>{console.table(r.rows); return pool.end();})"`
Expected: the new `sent` row is present. Revert `SEND_NOTIFICATIONS` after.

- [ ] **Step 5: Commit**

```bash
git add server/utils/email.js
git commit -m "feat(message-log): log client emails at the sendEmail choke point"
```

---

### Task 4: Wire `sendSMS` + thread context through `sendAndLogSms`

**Files:**
- Modify: `server/utils/sms.js` (add `require`, `meta` on `sendSMS`, log calls, `proposalId` on `sendAndLogSms`)

- [ ] **Step 1: Add the require**

At the top of `server/utils/sms.js`, after the existing requires (line 3 area):

```js
const { buildSmsLogEntry, logClientMessage } = require('./messageLog');
```

- [ ] **Step 2: Add `meta` to `sendSMS` and log around the Twilio call**

Replace the `sendSMS` body (lines 19-33):

```js
async function sendSMS({ to, body, meta }) {
  if (!to) throw new Error('SMS recipient phone number is required');
  if (!client || !notificationsEnabled()) {
    const why = !client ? 'Twilio creds not set' : 'notifications gated off';
    console.log(`[DEV] SMS skipped (${why}) → ${to} | Body: ${body}`);
    return { sid: `dev-skipped-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` };
  }
  let message;
  try {
    message = await client.messages.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body });
  } catch (err) {
    logClientMessage(buildSmsLogEntry({ to, body, meta, error: err })); // fire-and-forget
    throw err;
  }
  console.log(`SMS sent: ${message.sid} → ${to}`);
  logClientMessage(buildSmsLogEntry({ to, body, meta, result: message })); // fire-and-forget
  return message;
}
```

- [ ] **Step 3: Add `proposalId` to `sendAndLogSms` and thread `meta` into `sendSMS`**

In `sendAndLogSms` (line 79), add `proposalId = null` to the destructured args and pass `meta` to the inner send. Change the signature line and the `_deps.sendSMS` call (line 91):

```js
async function sendAndLogSms({ to, body, clientId = null, proposalId = null, messageType, recipientName = null }) {
```

```js
    const msg = await _deps.sendSMS({ to: normalized, body, meta: { proposalId, clientId, messageType } });
```

(The `sms_messages` inserts and the rest of the function are unchanged. `sendSMS` is the only writer to `message_log`, so there is no double-logging.)

- [ ] **Step 4: Verify SMS-path suites still pass (they stub `_deps.sendSMS`, so they intentionally bypass the new logging)**

Run: `node --test server/utils/balanceSmsHandlers.test.js`
Expected: PASS.

Run: `node --test server/utils/channelFallback.test.js`
Expected: PASS.

(The new logging branch is covered by the `buildSmsLogEntry` + `logClientMessage` unit tests in Task 2; these suites confirm no regression in the dispatcher/SMS callers.)

- [ ] **Step 5: Commit**

```bash
git add server/utils/sms.js
git commit -m "feat(message-log): log client SMS at the sendSMS choke point"
```

---

### Task 5: Exclude lead marketing; tag the admin SMS reply

**Files:**
- Modify: `server/routes/emailMarketing.js:492`, `server/routes/emailMarketing.js:785`
- Modify: `server/utils/emailSequenceScheduler.js:93`
- Modify: `server/routes/sms.js:145`

- [ ] **Step 1: Add `skipLog` to the three lead-campaign sends**

Add `meta: { skipLog: true },` to the options object at each site. The three are all lead-funnel sends (to `email_leads` addresses), which is exactly why the recipient gate alone is not enough:
- `emailMarketing.js:492` — campaign blast send loop.
- `emailMarketing.js:785` — per-lead send.
- `emailSequenceScheduler.js:93` — drip sequence per-step send.

Example shape:

```js
const result = await sendEmail({
  to: lead.email,
  subject,
  html,
  meta: { skipLog: true }, // lead campaign — never enters the client message log
});
```

- [ ] **Step 2: Tag the admin SMS reply with the known client**

At `server/routes/sms.js:145`, the admin reply has `clientId` in scope (used in the `sms_messages` insert below it). Pass it for exact attribution:

```js
const sent = await sendSMS({ to, body, meta: { clientId } });
```

- [ ] **Step 3: Verify the flag is present and lint is clean**

Run: `npm run lint`
Expected: no new errors in the four files.

Run: `node -e "const fs=require('fs'); for (const f of ['server/routes/emailMarketing.js','server/utils/emailSequenceScheduler.js']) { const n=(fs.readFileSync(f,'utf8').match(/skipLog:\s*true/g)||[]).length; console.log(f, n); }"`
Expected: `emailMarketing.js 2`, `emailSequenceScheduler.js 1`. (The `skipLog` mechanism itself is proven by the `buildEmailLogEntry` skipLog test in Task 2.)

- [ ] **Step 4: Commit**

```bash
git add server/routes/emailMarketing.js server/utils/emailSequenceScheduler.js server/routes/sms.js
git commit -m "feat(message-log): exclude lead marketing, tag admin SMS reply"
```

---

### Task 6: Read path — fold `messageLog` into `GET /proposals/:id`

**Files:**
- Modify: `server/routes/proposals/crud.js` (the `router.get('/:id', ...)` handler, ~lines 353-393)
- Test: `server/routes/proposals/crud.test.js` (append one route-level case)

Note: `crud.js` is 797 lines (over the 700-line soft cap, under the 1000 hard cap). This additive edit (~4 lines) keeps it under the hard cap and commits fine; a future split is out of scope here.

- [ ] **Step 1: Require the read helper**

Near the other util requires at the top of `server/routes/proposals/crud.js`:

```js
const { getMessageLogForProposal } = require('../../utils/messageLog');
```

- [ ] **Step 2: Add the helper to the existing `Promise.all` and the response**

Extend the `Promise.all` (currently `const [addons, activity] = await Promise.all([...])`) and the `res.json`:

```js
  const [addons, activity, messageLog] = await Promise.all([
    pool.query(
      'SELECT * FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [req.params.id]
    ),
    pool.query(
      'SELECT * FROM proposal_activity_log WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.params.id]
    ),
    getMessageLogForProposal(req.params.id),
  ]);

  const row = result.rows[0];
  res.json({
    ...row,
    setup_time_display: setupTimeDisplay(row),
    addons: addons.rows,
    activity: activity.rows,
    messageLog,
  });
```

(`getMessageLogForProposal` returns the rows array directly, so `messageLog` is the array — no `.rows`.)

- [ ] **Step 3: Add a route-level test that proves the field rides through the response**

Append this case to `server/routes/proposals/crud.test.js` (it reuses the file's existing `request()` HTTP helper and `primaryToken`; a GET is not adminWriteLimiter-gated, so the shared token is fine). Match the `request()` resolve shape used by the other cases in the file (`res.statusCode` / `res.body`):

```js
test('GET /:id includes the messageLog array', async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('MsgLog Route', 'msglog-route@example.com', '3125550177') RETURNING id"
  );
  createdClientIds.add(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party', 100000, 10000, CURRENT_DATE + INTERVAL '14 days', false)
     RETURNING id`,
    [c.rows[0].id]
  );
  createdProposalIds.add(p.rows[0].id);
  await pool.query(
    `INSERT INTO message_log (proposal_id, client_id, channel, message_type, recipient, status)
     VALUES ($1, $2, 'email', 'proposal_sent', 'msglog-route@example.com', 'sent')`,
    [p.rows[0].id, c.rows[0].id]
  );

  const res = await request('GET', `/api/proposals/${p.rows[0].id}`, { token: primaryToken });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.messageLog));
  assert.ok(res.body.messageLog.some((m) => m.message_type === 'proposal_sent'));
});
```

(The `message_log` rows cascade-delete when `after()` purges `createdProposalIds`, since `proposal_id` is `ON DELETE CASCADE`.)

- [ ] **Step 4: Run the route suite**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS, including the new `messageLog` case.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/crud.test.js
git commit -m "feat(message-log): return messageLog on GET /proposals/:id"
```

- [ ] **Step 6: Execution-review checkpoint** — dispatch `security-review` on this commit (admin-only PII is now exposed through `GET /proposals/:id`; confirm no public/token route picked up the field). Address blockers before continuing.

---

### Task 7: Client label util — `messageTypeLabel`

**Files:**
- Create: `client/src/utils/messageTypes.js`

- [ ] **Step 1: Implement the label map + fallback**

```js
// Display-only labels for message_log rows. Server stores the raw machine
// message_type; this maps the known ones to friendly text and falls back to the
// stored subject line (then a humanized type) for auto-captured 'other' rows.
const LABELS = {
  proposal_sent: 'Proposal sent',
  proposal_signed: 'Signed confirmation',
  signed_and_paid: 'Signed and paid',
  drink_plan_ready: 'Drink plan sent',
  drink_plan_nudge: 'Drink plan reminder',
  shopping_list_ready: 'Shopping list sent',
  payment_received: 'Payment receipt',
  balance_due_today: 'Balance due reminder',
  event_week_reminder: 'Event week reminder',
  event_eve: 'Event eve reminder',
  reschedule: 'Reschedule notice',
  review_request: 'Review request',
};

export function messageTypeLabel(type, subject) {
  if (type && LABELS[type]) return LABELS[type];
  if (type && type.startsWith('balance_')) return 'Balance reminder';
  if (subject) return subject;
  if (!type || type === 'other') return 'Message';
  return type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
```

- [ ] **Step 2: Verify it compiles in the client build (covered by Task 8's build run).**

- [ ] **Step 3: Commit**

```bash
git add client/src/utils/messageTypes.js
git commit -m "feat(message-log): client messageTypeLabel util"
```

---

### Task 8: `MessageLogCard` component + styles

**Files:**
- Create: `client/src/pages/admin/eventDetail/MessageLogCard.js`
- Modify: `client/src/index.css` (append the card's list styles)

- [ ] **Step 1: Implement the card**

```jsx
import React from 'react';
import { messageTypeLabel } from '../../../utils/messageTypes';

function timeLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export default function MessageLogCard({ messages }) {
  const rows = Array.isArray(messages) ? messages : [];
  return (
    <div className="card">
      <div className="card-head"><h3>Messages</h3></div>
      <div className="card-body">
        {rows.length === 0 ? (
          <div className="muted tiny">No messages sent yet.</div>
        ) : (
          <ul className="message-log-list">
            {rows.map((m) => (
              <li key={m.id} className="message-log-row">
                <span className={`message-log-channel ${m.channel}`}>
                  {m.channel === 'sms' ? 'Text' : 'Email'}
                </span>
                <span className="message-log-label">{messageTypeLabel(m.message_type, m.subject)}</span>
                <span className="message-log-recipient tiny muted">{m.recipient}</span>
                <span className="message-log-time tiny muted">{timeLabel(m.created_at)}</span>
                <span
                  className={`message-log-status ${m.status === 'failed' ? 'danger' : 'ok'}`}
                  title={m.status === 'failed' ? (m.error_message || 'Failed') : 'Sent'}
                >
                  {m.status === 'failed' ? 'Failed' : 'Sent'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Append styles to `client/src/index.css`**

The `var(name, fallback)` syntax means these render correctly even if the theme vars are not defined (the fallback hex applies):

```css
/* Message log card (event detail) */
.message-log-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.message-log-row { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 8px; font-size: 12.5px; }
.message-log-channel { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 5px; border-radius: 4px; background: var(--surface-2, #eee); color: var(--text-muted, #666); }
.message-log-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-log-recipient { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.message-log-status.ok { color: var(--success, #2e7d32); font-weight: 600; }
.message-log-status.danger { color: var(--danger, #c62828); font-weight: 600; }
```

- [ ] **Step 3: Verify the client build compiles**

Run: `cd client && set CI=true&& npx react-scripts build`
Expected: build succeeds (no ESLint/compile errors).

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/eventDetail/MessageLogCard.js client/src/index.css
git commit -m "feat(message-log): MessageLogCard component + styles"
```

---

### Task 9: Wire the card into the event page + refresh-after-action

**Files:**
- Modify: `client/src/pages/admin/EventDetailPage.js` (import + render the card; pass `reload` to `DrinkPlanCard`)
- Modify: `client/src/components/DrinkPlanCard.js` (accept `reload`; call it after the in-card send-capable actions)

**Refresh scope (corrected from the design review):** `DrinkPlanCard`'s in-card admin actions are `generate`, `markReviewed`, `finalize`. The **shopping-list-ready** email fires from `PATCH /drink-plans/:id/shopping-list/approve`, whose UI is the public `ClientShoppingList` / admin `DrinkPlanDetail` page, NOT this card — that row surfaces on the next event-page load, which is acceptable. The payment-receipt rows refresh for free because `ProposalDetailPaymentPanel` already calls `loadProposal` on `onUpdate`. So we wire `reload` only into the three in-card actions; we do not chase a reload into surfaces that are not on this page.

- [ ] **Step 1: Import and render `MessageLogCard` at the top of the right column**

In `client/src/pages/admin/EventDetailPage.js`, add the import near the other component imports (line 11 area):

```js
import MessageLogCard from './eventDetail/MessageLogCard';
```

Then, inside the right-column `vstack` (line 427), render the card as the FIRST child, above `ProposalDetailPaymentPanel`:

```jsx
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <MessageLogCard messages={proposal.messageLog} />

          <ProposalDetailPaymentPanel proposal={proposal} onUpdate={loadProposal} />
```

- [ ] **Step 2: Pass the proposal-only refetch to `DrinkPlanCard`**

In the same file, add the `reload` prop to the `DrinkPlanCard` usage (line 430):

```jsx
          <DrinkPlanCard
            proposalId={proposal.id}
            drinkPlan={drinkPlan}
            setDrinkPlan={setDrinkPlan}
            loading={drinkPlanLoading}
            fullControls
            guestCount={proposal.guest_count}
            reload={loadProposal}
          />
```

- [ ] **Step 3: Accept `reload` in `DrinkPlanCard` and call it after the three send-capable actions**

In `client/src/components/DrinkPlanCard.js`, add `reload` to the props (line 30):

```js
function DrinkPlanCard({ proposalId, drinkPlan, setDrinkPlan, loading, fullControls = false, guestCount, reload }) {
```

Then add `if (reload) await reload();` immediately after the `setDrinkPlan(...)` line in each of `generate` (line 41), `markReviewed` (line 60), and `finalize` (line 70). Concretely:

`generate`:
```js
      const res = await api.post(`/drink-plans/for-proposal/${proposalId}`);
      setDrinkPlan(res.data);
      if (reload) await reload(); // refresh the Messages card if a client email fired
```

`markReviewed`:
```js
      const res = await api.patch(`/drink-plans/${drinkPlan.id}/status`, { status: 'reviewed' });
      setDrinkPlan(prev => ({ ...prev, status: res.data.status }));
      if (reload) await reload(); // refresh the Messages card if a client email fired
```

`finalize`:
```js
      const res = await api.post(`/drink-plans/${drinkPlan.id}/finalize`);
      setDrinkPlan(res.data);
      if (reload) await reload(); // refresh the Messages card if a client email fired
```

(Calling `reload` is harmless if a given action did not send.)

- [ ] **Step 4: Verify the client build compiles**

Run: `cd client && set CI=true&& npx react-scripts build`
Expected: build succeeds.

- [ ] **Step 5: Manual check**

With the dev server running, open an event detail page, confirm the Messages card renders (empty state or rows). Trigger a client send (e.g. finalize a drink plan with `SEND_NOTIFICATIONS=true`), and confirm a new row appears at the top after the action.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/EventDetailPage.js client/src/components/DrinkPlanCard.js
git commit -m "feat(message-log): render Messages card + refresh after drink-plan actions"
```

- [ ] **Step 7: Execution-review checkpoint** — dispatch `code-review` + `consistency-check` on the client+server wire-up (Tasks 6-9): response-shape consumer parity, card rendering, no stray fetch. Address blockers before continuing.

---

### Task 10: Precision retrofit on the headline sends (labels + exact attribution)

Optional polish (completeness already works without it; un-tagged rows show the subject line). This upgrades the sends the user named to clean labels and exact proposal attribution. Each callsite already has the proposal id in scope.

**File-size ratchet caution:** `stripe.js` (1720) and `drinkPlans.js` (1178) are over the 1000-line hard cap, so the commit must not add net lines to them. All the callsites below are single-line `sendEmail({ ... })` calls EXCEPT `stripe.js:966`, which is a multi-line object. For the single-line calls, add `, meta: { ... }` on the same line before the closing `})` — no new line, no growth. For `stripe.js:966`, append the `meta:` property onto an existing line of that object (do not add a new line) so the file count stays flat.

**Callsites + message types (verified line numbers):**
- `server/utils/sendProposalSentEmail.js:52` — `await _deps.sendEmail({ to: proposal.client_email, ...tpl });` → add `meta: { proposalId: proposal.id, messageType: 'proposal_sent' }`. Also `sendProposalSentEmail.js:95` `sendAndLogSms({ ... })` → add `proposalId: proposal.id` (it already passes `messageType: 'initial_proposal'`). (118-line file, no ratchet concern.)
- `server/routes/drinkPlans.js:466` — `sendEmail({ to: clientEmail, ...tpl }).catch(...)` → inline `meta: { proposalId: row.proposal_id, messageType: 'drink_plan_ready' }` (confirm the in-scope proposal id variable on that line's row object).
- `server/routes/drinkPlans.js:557` — `sendEmail({ to: row.client_email, ...tpl }).catch(...)` → inline `meta: { proposalId: row.proposal_id, messageType: 'drink_plan_ready' }`.
- `server/routes/drinkPlans.js:1084` — `sendEmail({ to: plan.client_email, ...tpl }).catch(...)` → inline `meta: { proposalId: plan.proposal_id, messageType: 'shopping_list_ready' }`.
- `server/routes/stripe.js:983` — `await sendEmail({ to: pi.client_email, ...tpl });` (single line) → inline `meta: { proposalId, messageType: 'signed_and_paid' }` (`proposalId` is the `sendPaymentNotifications` param).
- `server/routes/stripe.js:1028` — `await sendEmail({ to: pi.client_email, ...tpl });` (single line) → inline `meta: { proposalId, messageType: 'payment_received' }`.
- `server/routes/stripe.js:966` — MULTI-LINE `await sendEmail({ ... })` (966-970, signed-and-paid). Append `meta: { proposalId, messageType: 'signed_and_paid' }` onto an existing property line so no net line is added.

(`drinkPlanConsult.js` has no direct client `sendEmail` — its consult emails are covered by the choke point automatically, so it is not retrofitted.)

- [ ] **Step 1: Add `meta` to each headline send (single-line inline; `stripe.js:966` onto an existing line)**

Example (`drinkPlans.js:1084`):

```js
sendEmail({ to: plan.client_email, ...tpl, meta: { proposalId: plan.proposal_id, messageType: 'shopping_list_ready' } })
  .catch(emailErr => { /* existing handler unchanged */ });
```

- [ ] **Step 2: Verify lint, line counts unchanged on the capped files, and a representative suite**

Run: `npm run lint`
Expected: no new errors.

Run: `node -e "const fs=require('fs'); for (const f of ['server/routes/stripe.js','server/routes/drinkPlans.js']) console.log(f, fs.readFileSync(f,'utf8').split('\n').length)"`
Expected: `stripe.js 1720`, `drinkPlans.js 1178` (unchanged — proves no net line growth on the capped files).

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS (crud.test stubs `sendProposalSentEmail`, so it stays green).

- [ ] **Step 3: Commit**

```bash
git add server/utils/sendProposalSentEmail.js server/routes/drinkPlans.js server/routes/stripe.js
git commit -m "feat(message-log): tag headline client sends for clean labels"
```

---

### Task 11: Documentation

**Files:**
- Modify: `README.md` (folder-structure tree: new `server/utils/messageLog.js`, `client/src/utils/messageTypes.js`, `client/src/pages/admin/eventDetail/MessageLogCard.js`; Key Features: a line on the message log)
- Modify: `ARCHITECTURE.md` (Database Schema section: `message_log` table)

- [ ] **Step 1: Update `README.md`**

Add the three new files to the folder-structure tree in their correct locations (note the new `client/src/pages/admin/eventDetail/` directory), and a Key Features bullet:

```
- Client message log: every client-facing email/SMS is recorded at the send choke
  points and shown newest-first on the event detail page (sent/failed).
```

- [ ] **Step 2: Update `ARCHITECTURE.md`**

Add a `message_log` entry to the Database Schema section describing its columns and that it is written by `sendEmail`/`sendSMS` via `server/utils/messageLog.js` and read on `GET /proposals/:id`.

- [ ] **Step 3: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(message-log): document message_log table + feature"
```

---

## Execution review checkpoints

Per the project's batch-checkpoint review pattern, dispatch specialized review agents at these points (also embedded as the final step of the relevant tasks):

- **After Task 1** — `database-review` (new table, FKs, index, NOT NULL columns, idempotency).
- **After Task 6** — `security-review` (admin-only PII now exposed via `GET /proposals/:id`; confirm no public/token route inherits the field).
- **After Task 9** — `code-review` + `consistency-check` (cross-cutting client+server wire-up; response-shape consumer parity).

The full pre-push fleet still runs at deploy time per CLAUDE.md; these are mid-execution catches so issues surface at the batch that introduced them.

---

## Self-Review

**Spec coverage:**
- Completeness via choke point → Tasks 3, 4. Client-recipient gate → Task 2. Marketing `skipLog` → Tasks 2 + 5. Data model → Task 1. Fire-and-forget / never-throws / Sentry → Task 2. Depth = send-confirmation + provider_id → Task 2 builders. Read folded into `GET /proposals/:id` → Task 6. Refresh-after-action (payment free, DrinkPlanCard reload, shopping-list on next load) → Task 9. UI card + subject fallback + empty state → Tasks 7, 8, 9. Precision retrofit → Task 10. Docs → Task 11. Out-of-scope items correctly absent.

**Placeholder scan:** No TBD/TODO; every code step shows complete code. Task 10 cites exact line numbers and the in-scope proposal id per callsite.

**Type consistency:** `buildEmailLogEntry` / `buildSmsLogEntry` / `logClientMessage` / `getMessageLogForProposal` names and shapes are consistent across Tasks 2, 3, 4, 6. `meta` shape `{ proposalId, clientId, messageType, skipLog }` is consistent across `sendEmail`, `sendSMS`, `sendAndLogSms`, and the retrofit. `messageTypeLabel(type, subject)` matches its call in `MessageLogCard`. The `messageLog` response field matches `proposal.messageLog` consumed by the card.

---

## Changelog — plan-review folded in (2026-06-05)

`/review-plan` fleet (decomposition + feasibility full; fidelity coordinator-completed after a truncated run). Folded in:
- **#1 [blocker, feasibility]** File-size ratchet on `stripe.js`/`drinkPlans.js` — Task 10 now flags the single-line-inline rule and the one multi-line callsite (`stripe.js:966`), with a line-count verification step.
- **#2 [warning, cross-confirmed]** Task 6 verify was hollow — replaced with a real route-level `crud.test.js` case asserting `body.messageLog`.
- **#3 [warning, decomposition]** Task 5 lint-only verify — added a `skipLog` grep-count check (mechanism itself proven in Task 2).
- **#4 [warning, feasibility]** Flaky newest-first ordering — added `id DESC` tiebreaker to the read query and the index.
- **#5 [warning, feasibility]** Task 2 fixture email collision — `before()` now cleans leftovers first.
- **#6 [warning, feasibility]** `crud.js` yellow-zone note added to Task 6.
- **#7 [warning, decomposition]** Execution-review checkpoints added (Tasks 1/6/9 + a dedicated section).
- **#8 [warning, fidelity]** Shopping-list refresh corrected — it fires from `PATCH /shopping-list/approve` (not `DrinkPlanCard`), so it surfaces on next load; spec + Task 9 reframed.
- **#9 [suggestion, decomposition]** Task 3 manual smoke promoted to required.
- **#10 [suggestion, decomposition]** Task 2 `beforeEach` truncate added.
- **#11 [suggestion, decomposition]** Task 9 spells out all three `reload()` snippets.
- **#12 [suggestion, feasibility]** Task 10 now has exact line numbers; `drinkPlanConsult.js` dropped (no direct client `sendEmail`).
- **#13 [suggestion, feasibility]** Spec's stale `messageLog.rows` corrected to `messageLog` (helper returns the array).
- **#14 [suggestion, feasibility]** Task 5 has a one-line role note per lead-campaign site.
