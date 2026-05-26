# Dispute-won Email Retry Bailout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the dispute-email retry storm at 3 attempts. After three failed sends, atomically mark the tip's `dispute_won_at` and a new `dispute_email_failed_at` so Stripe redeliveries short-circuit and the DB carries the canonical "abandoned" marker.

**Architecture:** Wrap the entire `notifyDisputeWon` flow in a held `pool.connect()` transaction with `SELECT FOR UPDATE OF t` on the tip row. Bound the email send with `Promise.race` against a 10-second timeout. Finalize via a single atomic UPDATE that uses CASE to fire the bailout. Capture Sentry AFTER commit with a try/catch + stderr fallback. The DB column (`dispute_email_failed_at`) is the canonical durable artifact; an admin sweep query is the failsafe.

**Tech Stack:** Node.js 18+, Express 4, PostgreSQL via `pg`, `@sentry/node`, Resend (email), `node:test` for tests.

**Source spec:** `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md`

---

## Task 1: Schema migration

**Files:**
- Modify: `server/db/schema.sql` (append after line 2592)

- [ ] **Step 1: Open `server/db/schema.sql` and locate line 2592.** It contains `ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_won_at TIMESTAMPTZ;` inside the Phase 2 staff-payments block.

- [ ] **Step 2: Append the two new ALTERs immediately after line 2592**

```sql
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_failed_at TIMESTAMPTZ;
```

- [ ] **Step 3: Verify the additions landed**

Run: `grep -n "dispute_email" server/db/schema.sql`

Expected: two lines listing `dispute_email_attempts` and `dispute_email_failed_at` immediately after line 2592 (line numbers may shift by 1 if there is a trailing blank line).

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(payroll): tips columns for dispute-email retry bailout"
```

---

## Task 2: Add scaffolding (constants + __setDeps seam) to `payrollDisputeNotify.js`

**Files:**
- Modify: `server/utils/payrollDisputeNotify.js`

This task adds the tunable constants and the test seam WITHOUT changing the function's runtime behavior. Task 3 does the structural refactor.

- [ ] **Step 1: Open `server/utils/payrollDisputeNotify.js` and locate the existing imports + `fmtDate` helper at the top.** The next line after `fmtDate` ends (around line 22) is where the new constants and seam land.

- [ ] **Step 2: Insert constants and the `_deps` seam between `fmtDate` and the `notifyDisputeWon` function**

Find this block:
```js
function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

async function notifyDisputeWon(tipId, { reinstatedAmountCents, disputeOpenedAt, disputeWonAt }) {
```

Replace with:
```js
function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return '';
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const MAX_DISPUTE_EMAIL_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 10_000;

let _deps = { sendEmail, Sentry, sendTimeoutMs: SEND_TIMEOUT_MS };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

async function notifyDisputeWon(tipId, { reinstatedAmountCents, disputeOpenedAt, disputeWonAt }) {
```

- [ ] **Step 3: Update the module.exports at the bottom of the file** to include `__setDeps`

Find:
```js
module.exports = { notifyDisputeWon };
```

Replace with:
```js
module.exports = { notifyDisputeWon, __setDeps };
```

- [ ] **Step 4: Verify the module still loads cleanly**

Run: `node -c server/utils/payrollDisputeNotify.js`
Expected: exit code 0, no output.

Run: `node -e "const m = require('./server/utils/payrollDisputeNotify'); console.log(Object.keys(m).sort());"`
Expected:
```
[email] RESEND_API_KEY is NOT set ...  (warning, ok in dev)
[ '__setDeps', 'notifyDisputeWon' ]
```

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollDisputeNotify.js
git commit -m "feat(payroll): __setDeps seam and tunable constants for dispute-email"
```

---

## Task 3: Refactor `notifyDisputeWon` to the transactional shape

**Files:**
- Modify: `server/utils/payrollDisputeNotify.js`

This task replaces the entire `notifyDisputeWon` function body with the new structure: held transaction, `SELECT FOR UPDATE OF t`, computation, `Promise.race`-bounded send, atomic finalization UPDATE, post-commit Sentry capture wrapped in try/catch, expanded return shape with `abandoned`. The constants and `_deps` seam from Task 2 remain.

- [ ] **Step 1: Locate the existing `notifyDisputeWon` function** in `server/utils/payrollDisputeNotify.js`. It starts with `async function notifyDisputeWon(tipId, { reinstatedAmountCents, disputeOpenedAt, disputeWonAt }) {` and ends at the closing brace before `module.exports`.

- [ ] **Step 2: Replace the entire function body** (everything between the `async function notifyDisputeWon(...)` opening brace and its matching closing brace) with this implementation:

```js
async function notifyDisputeWon(tipId, { reinstatedAmountCents, disputeOpenedAt, disputeWonAt }) {
  const client = await pool.connect();
  let reinstated = 0;
  let bartenders = [];
  let netTotal = 0;
  let abandoned = false;
  let bailedOut = false;
  let postCommitAttempts = MAX_DISPUTE_EMAIL_ATTEMPTS;
  let postCommitEventDateLabel = '';

  try {
    await client.query('BEGIN');

    // Lock + re-read. FOR UPDATE OF t scopes the lock to the tips row only,
    // which is required when joining nullable sides (mirrors drinkPlanConsult.js:144).
    const tipRes = await client.query(
      `SELECT t.id, t.amount_cents, t.fee_cents, t.dispute_won_at, t.shift_id, t.target_user_id,
              t.dispute_email_attempts,
              s.event_date, p.event_type, p.event_type_custom, p.client_id,
              c.name AS client_name
         FROM tips t
    LEFT JOIN shifts s ON s.id = t.shift_id
    LEFT JOIN proposals p ON p.id = s.proposal_id
    LEFT JOIN clients c ON c.id = p.client_id
        WHERE t.id = $1
          FOR UPDATE OF t`,
      [tipId]
    );
    const tip = tipRes.rows[0];

    if (!tip || tip.dispute_won_at) {
      await client.query('ROLLBACK');
      return null;
    }

    postCommitEventDateLabel = fmtDate(tip.event_date);

    let bartenderIds = [];
    if (tip.shift_id) {
      const bRes = await client.query(
        `SELECT sr.user_id FROM shift_requests sr
          WHERE sr.shift_id = $1 AND sr.status = 'approved'
            AND LOWER(sr.position) = 'bartender'
          ORDER BY sr.user_id`,
        [tip.shift_id]
      );
      bartenderIds = bRes.rows.map(r => r.user_id);
    }
    if (bartenderIds.length === 0 && tip.target_user_id) {
      bartenderIds = [tip.target_user_id];
    }

    if (bartenderIds.length) {
      const nRes = await client.query(
        `SELECT u.id, u.email, cp.preferred_name
           FROM users u
      LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
          WHERE u.id = ANY($1::int[])
          ORDER BY u.id`,
        [bartenderIds]
      );
      bartenders = nRes.rows.map(r => ({ id: r.id, name: r.preferred_name || r.email }));
    }

    reinstated = Math.max(0, Math.min(Number(reinstatedAmountCents || 0), Number(tip.amount_cents)));
    const original = Number(tip.amount_cents);
    const feePortion = original > 0
      ? Math.round(Number(tip.fee_cents || 0) * reinstated / original)
      : 0;
    netTotal = reinstated - feePortion;
    const shares = splitEvenly(netTotal, bartenders.length || 1);
    bartenders = bartenders.map((b, i) => ({
      ...b,
      shareCents: shares[i] || 0,
      shareDollars: ((shares[i] || 0) / 100).toFixed(2),
    }));

    let emailSent = false;
    try {
      if (!process.env.ADMIN_EMAIL) {
        throw new Error('ADMIN_EMAIL not set; cannot deliver dispute-won notification');
      }
      const tpl = emailTemplates.disputeWonAdminNotification({
        amountDollars: (reinstated / 100).toFixed(2),
        perBartender: bartenders.map(b => ({ name: b.name, shareDollars: b.shareDollars })),
        eventDateLabel: postCommitEventDateLabel,
        eventTypeLabel: getEventTypeLabel({ event_type: tip.event_type, event_type_custom: tip.event_type_custom }),
        clientName: tip.client_name || null,
        disputeOpenedLabel: fmtDate(disputeOpenedAt),
        disputeWonLabel: fmtDate(disputeWonAt),
        payrollUrl: `${process.env.CLIENT_URL || ''}/financials/payroll`,
      });
      const sendPromise = _deps.sendEmail({
        to: process.env.ADMIN_EMAIL,
        subject: tpl.subject,
        html: tpl.html,
        text: tpl.text,
      });
      // Suppress unhandled-rejection if the awaiter loses the race below.
      sendPromise.catch(() => {});
      await Promise.race([
        sendPromise,
        new Promise((_, reject) => {
          const t = setTimeout(() => reject(new Error('sendEmail timed out')), _deps.sendTimeoutMs);
          t.unref?.();
        }),
      ]);
      emailSent = true;
    } catch (err) {
      _deps.Sentry.captureException(err, { tags: { util: 'payrollDisputeNotify', step: 'send_email' } });
    }

    if (emailSent) {
      await client.query(
        `UPDATE tips
            SET dispute_won_at = NOW(),
                dispute_email_attempts = 0
          WHERE id = $1
            AND dispute_won_at IS NULL`,
        [tipId]
      );
    } else {
      const r = await client.query(
        `UPDATE tips
            SET dispute_email_attempts = dispute_email_attempts + 1,
                dispute_won_at = CASE WHEN dispute_email_attempts + 1 >= ${MAX_DISPUTE_EMAIL_ATTEMPTS} THEN NOW() ELSE dispute_won_at END,
                dispute_email_failed_at = CASE WHEN dispute_email_attempts + 1 >= ${MAX_DISPUTE_EMAIL_ATTEMPTS} THEN NOW() ELSE dispute_email_failed_at END
          WHERE id = $1
            AND dispute_won_at IS NULL
        RETURNING dispute_email_attempts, dispute_email_failed_at IS NOT NULL AS bailed_out`,
        [tipId]
      );
      bailedOut = r.rows[0]?.bailed_out === true;
      abandoned = bailedOut;
      if (r.rows[0]) postCommitAttempts = r.rows[0].dispute_email_attempts;
    }

    await client.query('COMMIT');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }

  // Post-commit Sentry capture. The DB column dispute_email_failed_at is the
  // canonical durable record of abandonment; the Sentry alert is best-effort.
  if (bailedOut) {
    try {
      _deps.Sentry.captureMessage('Dispute-won notification permanently abandoned after retry threshold', {
        level: 'error',
        tags: { util: 'payrollDisputeNotify', step: 'max_attempts_exceeded' },
        extra: {
          tipId,
          attempts: postCommitAttempts,
          reinstatedAmountCents: reinstated,
          bartenderIds: bartenders.map(b => b.id),
          eventDateLabel: postCommitEventDateLabel,
        },
      });
    } catch (sentryErr) {
      console.error(
        `[payrollDisputeNotify] BAILOUT_ALERT_FAILED tipId=${tipId} attempts=${postCommitAttempts}`,
        sentryErr
      );
    }
  }

  return { bartenders, reinstatedAmountCents: reinstated, netTotalCents: netTotal, abandoned };
}
```

- [ ] **Step 3: Verify the file is syntactically clean and still loads**

Run: `node -c server/utils/payrollDisputeNotify.js`
Expected: exit code 0, no output.

Run: `node -e "require('./server/utils/payrollDisputeNotify');" 2>&1 | grep -v "RESEND\|Twilio"; echo "exit $?"`
Expected: no error lines, `exit 0`.

- [ ] **Step 4: Spot-check the only call site still type-aligns**

Run: `grep -n "notifyDisputeWon" server/routes/stripe.js`
Expected: exactly one production callsite at around line 1654, called as `await notifyDisputeWon(tipId, { reinstatedAmountCents: dispute.amount, disputeOpenedAt: ..., disputeWonAt: ... });` (signature unchanged from before the refactor).

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollDisputeNotify.js
git commit -m "feat(payroll): wrap notifyDisputeWon in transaction + bounded send"
```

---

## Task 4: Test scaffolding + simpler test cases

**Files:**
- Create or modify: `server/utils/payrollDisputeNotify.test.js`

This task sets up the test file with imports, the `beforeEach`/`afterEach` hooks for `__setDeps` reset and `console.error` restoration, and the four simplest test cases. Subsequent tasks add the harder ones.

- [ ] **Step 1: Check if the test file already exists**

Run: `ls server/utils/payrollDisputeNotify.test.js 2>&1`

If the file exists, skim it to confirm whether the existing tests assume the old single-statement UPDATE behavior. If they do, plan to replace them entirely with the new file content below. If the file does not exist, create it.

- [ ] **Step 2: Write the test file scaffolding**

Open `server/utils/payrollDisputeNotify.test.js` and replace its contents with:

```js
// Serial execution required. This suite mutates process.env.ADMIN_EMAIL and
// reassigns console.error in some tests; running concurrently would corrupt
// other tests in the same process. Do NOT enable --test-concurrency.

require('dotenv').config();
const { test, describe, before, beforeEach, afterEach, after, mock } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const Sentry = require('@sentry/node');
const { notifyDisputeWon, __setDeps } = require('./payrollDisputeNotify');

const TEST_TIP_PREFIX = -990000000; // negative ids guaranteed unique vs. SERIAL prod rows

let sendEmailMock, captureExceptionMock, captureMessageMock, consoleErrorOriginal;

async function seedTip({ id, amount_cents = 5000, fee_cents = 100, dispute_won_at = null, dispute_email_attempts = 0, dispute_email_failed_at = null, shift_id = null, target_user_id = null }) {
  await pool.query(
    `INSERT INTO tips (id, amount_cents, fee_cents, dispute_won_at, dispute_email_attempts, dispute_email_failed_at, shift_id, target_user_id, stripe_payment_intent_id, tipped_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (id) DO UPDATE SET
       amount_cents = EXCLUDED.amount_cents,
       fee_cents = EXCLUDED.fee_cents,
       dispute_won_at = EXCLUDED.dispute_won_at,
       dispute_email_attempts = EXCLUDED.dispute_email_attempts,
       dispute_email_failed_at = EXCLUDED.dispute_email_failed_at,
       shift_id = EXCLUDED.shift_id,
       target_user_id = EXCLUDED.target_user_id`,
    [id, amount_cents, fee_cents, dispute_won_at, dispute_email_attempts, dispute_email_failed_at, shift_id, target_user_id, `pi_test_${Math.abs(id)}`]
  );
}

async function readTip(id) {
  const r = await pool.query(
    `SELECT id, dispute_won_at, dispute_email_attempts, dispute_email_failed_at
       FROM tips WHERE id = $1`,
    [id]
  );
  return r.rows[0] || null;
}

describe('notifyDisputeWon', () => {
  before(async () => {
    await pool.query('DELETE FROM tips WHERE id <= $1', [TEST_TIP_PREFIX]);
  });

  after(async () => {
    await pool.query('DELETE FROM tips WHERE id <= $1', [TEST_TIP_PREFIX]);
  });

  beforeEach(() => {
    sendEmailMock = mock.fn(async () => ({ id: 'msg_test' }));
    captureExceptionMock = mock.fn();
    captureMessageMock = mock.fn();
    __setDeps({
      sendEmail: sendEmailMock,
      Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
      sendTimeoutMs: 100,
    });
  });

  afterEach(async () => {
    __setDeps({ sendEmail, Sentry, sendTimeoutMs: 10_000 });
    if (consoleErrorOriginal) {
      console.error = consoleErrorOriginal;
      consoleErrorOriginal = null;
    }
    await pool.query('DELETE FROM tips WHERE id <= $1', [TEST_TIP_PREFIX]);
  });
});
```

- [ ] **Step 3: Add the "Success path" test inside the `describe` block** (just before the closing `});`)

```js
  test('success path: marks dispute_won_at, resets attempts, returns abandoned=false', async () => {
    const id = TEST_TIP_PREFIX - 1;
    await seedTip({ id, dispute_email_attempts: 0 });
    process.env.ADMIN_EMAIL = 'test@example.com';

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result.abandoned, false);
    assert.strictEqual(result.reinstatedAmountCents, 3000);
    assert.strictEqual(sendEmailMock.mock.callCount(), 1);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.notStrictEqual(after.dispute_won_at, null);
    assert.strictEqual(after.dispute_email_attempts, 0);
    assert.strictEqual(after.dispute_email_failed_at, null);
  });
```

- [ ] **Step 4: Add the "Counter reset on success after prior failure" test**

```js
  test('counter reset: prior failures zeroed on success', async () => {
    const id = TEST_TIP_PREFIX - 2;
    await seedTip({ id, dispute_email_attempts: 2 });
    process.env.ADMIN_EMAIL = 'test@example.com';

    await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 0);
    assert.notStrictEqual(after.dispute_won_at, null);
  });
```

- [ ] **Step 5: Add the "Already-completed short-circuit" test**

```js
  test('already-completed: returns null, does not touch state or send', async () => {
    const id = TEST_TIP_PREFIX - 3;
    await seedTip({ id, dispute_won_at: new Date('2026-01-01') });
    process.env.ADMIN_EMAIL = 'test@example.com';

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result, null);
    assert.strictEqual(sendEmailMock.mock.callCount(), 0);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);
    assert.strictEqual(captureExceptionMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 0);
  });
```

- [ ] **Step 6: Add the "ADMIN_EMAIL unset" test**

```js
  test('ADMIN_EMAIL unset: increments counter, fires captureException', async () => {
    const id = TEST_TIP_PREFIX - 4;
    await seedTip({ id, dispute_email_attempts: 0 });

    const saved = process.env.ADMIN_EMAIL;
    try {
      delete process.env.ADMIN_EMAIL;
      await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });
    } finally {
      if (typeof saved === 'string') process.env.ADMIN_EMAIL = saved;
    }

    assert.strictEqual(captureExceptionMock.mock.callCount(), 1);
    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 1);
    assert.strictEqual(after.dispute_won_at, null);
  });
```

- [ ] **Step 7: Run the test file and verify all four tests pass**

Run: `node --test server/utils/payrollDisputeNotify.test.js 2>&1 | tail -15`
Expected: `tests 4`, `pass 4`, `fail 0`.

If any test fails, read the failure message and fix the test (NOT the production code) unless the failure exposes a real bug in Task 3's implementation. If a real bug surfaces, fix it in `payrollDisputeNotify.js`, re-run, and only commit when all 4 pass.

- [ ] **Step 8: Commit**

```bash
git add server/utils/payrollDisputeNotify.test.js
git commit -m "test(payroll): scaffold + 4 simple cases for dispute-email retry"
```

---

## Task 5: Failure-path test cases

**Files:**
- Modify: `server/utils/payrollDisputeNotify.test.js`

- [ ] **Step 1: Add the "Single failure, attempts below threshold" test** inside the `describe` block, after the previous tests

```js
  test('single failure: attempts=1, no flags set, no captureMessage', async () => {
    const id = TEST_TIP_PREFIX - 5;
    await seedTip({ id, dispute_email_attempts: 0 });
    process.env.ADMIN_EMAIL = 'test@example.com';
    sendEmailMock.mock.mockImplementationOnce(() => Promise.reject(new Error('resend boom')));

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result.abandoned, false);
    assert.strictEqual(captureExceptionMock.mock.callCount(), 1);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 1);
    assert.strictEqual(after.dispute_won_at, null);
    assert.strictEqual(after.dispute_email_failed_at, null);
  });
```

- [ ] **Step 2: Add the "Bailout trigger" test**

```js
  test('bailout: attempts=2 + failure → attempts=3, both timestamps set and equal, captureMessage fires with full payload', async () => {
    const id = TEST_TIP_PREFIX - 6;
    await seedTip({ id, dispute_email_attempts: 2 });
    process.env.ADMIN_EMAIL = 'test@example.com';
    sendEmailMock.mock.mockImplementationOnce(() => Promise.reject(new Error('still down')));

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result.abandoned, true);
    assert.strictEqual(captureMessageMock.mock.callCount(), 1);

    const callArgs = captureMessageMock.mock.calls[0].arguments;
    assert.match(callArgs[0], /permanently abandoned/);
    assert.strictEqual(callArgs[1].level, 'error');
    assert.strictEqual(callArgs[1].tags.step, 'max_attempts_exceeded');
    assert.strictEqual(callArgs[1].extra.tipId, id);
    assert.strictEqual(callArgs[1].extra.attempts, 3);
    assert.strictEqual(callArgs[1].extra.reinstatedAmountCents, 3000);
    assert.ok(Array.isArray(callArgs[1].extra.bartenderIds));

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 3);
    assert.notStrictEqual(after.dispute_won_at, null);
    assert.notStrictEqual(after.dispute_email_failed_at, null);
    // Both NOW() in the same UPDATE should yield equal timestamps.
    assert.strictEqual(new Date(after.dispute_won_at).getTime(), new Date(after.dispute_email_failed_at).getTime());
  });
```

- [ ] **Step 3: Add the "Computation throw rolls back without incrementing" test**

Computation here means the bartender-resolution `client.query`. We override `__setDeps` to inject a `pool` shim that yields a client whose `query` rejects on the bartender lookup. Since the spec keeps `pool` direct (not in deps), this test simulates the throw by seeding a tip with a non-existent `shift_id` that violates a constraint OR by stubbing the underlying `pool.query` at the module level. The simplest approach: seed with a `shift_id` referencing a row, then drop the row mid-test. The cleaner approach is to stub `pool.query` using `mock.method`. Use the cleaner one:

```js
  test('computation throw: counter unchanged, dispute_won_at null, no Sentry from inside notify', async () => {
    const id = TEST_TIP_PREFIX - 7;
    await seedTip({ id, dispute_email_attempts: 0 });
    process.env.ADMIN_EMAIL = 'test@example.com';

    // Stub pool.connect().query to fail on the bartender-lookup statement.
    // Real pool clients have a query method; we wrap the connect to inject a
    // throwing query after the first two (BEGIN + tip SELECT) succeed.
    const realConnect = pool.connect.bind(pool);
    let queryCallNum = 0;
    pool.connect = async () => {
      const realClient = await realConnect();
      const realQuery = realClient.query.bind(realClient);
      realClient.query = async (...args) => {
        queryCallNum += 1;
        if (queryCallNum === 3) throw new Error('bartender lookup boom');
        return realQuery(...args);
      };
      return realClient;
    };

    try {
      await assert.rejects(
        notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
        /bartender lookup boom/
      );
    } finally {
      pool.connect = realConnect;
    }

    assert.strictEqual(captureExceptionMock.mock.callCount(), 0);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 0);
    assert.strictEqual(after.dispute_won_at, null);
    assert.strictEqual(after.dispute_email_failed_at, null);
  });
```

- [ ] **Step 4: Run the 7 tests and verify all pass**

Run: `node --test server/utils/payrollDisputeNotify.test.js 2>&1 | tail -15`
Expected: `tests 7`, `pass 7`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollDisputeNotify.test.js
git commit -m "test(payroll): failure-path cases for dispute-email retry"
```

---

## Task 6: Concurrency, timeout, and post-commit-Sentry-failure tests

**Files:**
- Modify: `server/utils/payrollDisputeNotify.test.js`

- [ ] **Step 1: Add the "Concurrency: bailout-trigger race" test**

```js
  test('concurrency bailout race: at attempts=2, first call bails out, second short-circuits', async () => {
    const id = TEST_TIP_PREFIX - 8;
    await seedTip({ id, dispute_email_attempts: 2 });
    process.env.ADMIN_EMAIL = 'test@example.com';
    sendEmailMock.mock.mockImplementation(() => Promise.reject(new Error('still down')));

    const results = await Promise.all([
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
    ]);

    // One delivery did the bailout, the other short-circuited.
    const abandonedCount = results.filter(r => r && r.abandoned === true).length;
    const nullCount = results.filter(r => r === null).length;
    assert.strictEqual(abandonedCount, 1);
    assert.strictEqual(nullCount, 1);

    assert.strictEqual(captureExceptionMock.mock.callCount(), 1);
    assert.strictEqual(captureMessageMock.mock.callCount(), 1);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 3);
    assert.notStrictEqual(after.dispute_won_at, null);
    assert.notStrictEqual(after.dispute_email_failed_at, null);
  });
```

- [ ] **Step 2: Add the "Concurrency: below-threshold race" test**

```js
  test('concurrency below-threshold race: both increment serially via row lock', async () => {
    const id = TEST_TIP_PREFIX - 9;
    await seedTip({ id, dispute_email_attempts: 0 });
    process.env.ADMIN_EMAIL = 'test@example.com';
    sendEmailMock.mock.mockImplementation(() => Promise.reject(new Error('flapping')));

    await Promise.all([
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
    ]);

    assert.strictEqual(captureExceptionMock.mock.callCount(), 2);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 2);
    assert.strictEqual(after.dispute_won_at, null);
    assert.strictEqual(after.dispute_email_failed_at, null);
  });
```

- [ ] **Step 3: Add the "Send-timeout" test**

```js
  test('send-timeout: Promise.race rejects, counter increments, lock released within bound', async () => {
    const id = TEST_TIP_PREFIX - 10;
    await seedTip({ id, dispute_email_attempts: 0 });
    process.env.ADMIN_EMAIL = 'test@example.com';

    __setDeps({
      sendEmail: () => new Promise(resolve => setTimeout(() => resolve({ id: 'late' }), 500)),
      Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
      sendTimeoutMs: 50,
    });

    const startedAt = Date.now();
    await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 300, `expected < 300ms, got ${elapsed}ms`);
    assert.strictEqual(captureExceptionMock.mock.callCount(), 1);
    const errArg = captureExceptionMock.mock.calls[0].arguments[0];
    assert.match(errArg.message, /timed out/);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 1);
    assert.strictEqual(after.dispute_won_at, null);
  });
```

- [ ] **Step 4: Add the "Post-commit Sentry capture failure" test**

```js
  test('post-commit Sentry capture failure: DB state still committed, console.error fired', async () => {
    const id = TEST_TIP_PREFIX - 11;
    await seedTip({ id, dispute_email_attempts: 2 });
    process.env.ADMIN_EMAIL = 'test@example.com';

    const throwingCaptureMessage = mock.fn(() => { throw new Error('sentry boom'); });
    __setDeps({
      sendEmail: sendEmailMock,
      Sentry: { captureException: captureExceptionMock, captureMessage: throwingCaptureMessage },
      sendTimeoutMs: 100,
    });
    sendEmailMock.mock.mockImplementationOnce(() => Promise.reject(new Error('still down')));

    consoleErrorOriginal = console.error;
    const consoleErrorMock = mock.fn();
    console.error = consoleErrorMock;

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result.abandoned, true);
    assert.strictEqual(throwingCaptureMessage.mock.callCount(), 1);

    const consoleErrorCalls = consoleErrorMock.mock.calls;
    assert.ok(consoleErrorCalls.length >= 1, 'console.error should have been called');
    const firstArg = consoleErrorCalls[0].arguments[0];
    assert.match(firstArg, /BAILOUT_ALERT_FAILED/);
    assert.match(firstArg, new RegExp(`tipId=${id}`));

    const after = await readTip(id);
    assert.notStrictEqual(after.dispute_won_at, null);
    assert.notStrictEqual(after.dispute_email_failed_at, null);
    assert.strictEqual(after.dispute_email_attempts, 3);
  });
```

- [ ] **Step 5: Run all 11 tests and verify all pass**

Run: `node --test server/utils/payrollDisputeNotify.test.js 2>&1 | tail -15`
Expected: `tests 11`, `pass 11`, `fail 0`.

If a concurrency test is flaky, run 3 times in a row: `for i in 1 2 3; do node --test server/utils/payrollDisputeNotify.test.js 2>&1 | tail -3; done`. All three runs must show `pass 11`. If a flake surfaces, inspect the row-lock serialization assumption in the spec's Race safety section and fix the underlying issue (NOT the test).

- [ ] **Step 6: Commit**

```bash
git add server/utils/payrollDisputeNotify.test.js
git commit -m "test(payroll): concurrency + timeout + Sentry-failure cases for dispute-email"
```

---

## Task 7: Update `ARCHITECTURE.md` (tips table + state machine + sweep query)

**Files:**
- Modify: `ARCHITECTURE.md` (existing tips-table description around lines 790-800; new Operational Practices section at the bottom)

- [ ] **Step 1: Locate the existing `tips` table description in `ARCHITECTURE.md`**

Run: `grep -n "tips" ARCHITECTURE.md | head -20`
Expected: at least one heading or column-list entry around line 790-800 referencing the `tips` table.

Open the file and locate the `tips` table description (it lists columns and their purposes).

- [ ] **Step 2: Update the column list to bring it current with `server/db/schema.sql`**

The current doc is missing five columns: `fee_cents`, `shift_id`, `rolled_forward_at`, `refunded_amount_cents`, `dispute_won_at`. Plus the two new ones from Task 1. Append the seven columns to the column list (preserving the existing column entries):

```
- `fee_cents`: integer cents of the Stripe fee withheld from the tip; populated on tip webhook
- `shift_id`: FK to `shifts.id` when the tip is matched to a specific shift; null until matched
- `rolled_forward_at`: set when a late tip is rolled forward into the next open payout period
- `refunded_amount_cents`: cumulative refund cents applied to this tip (clawback tracking)
- `dispute_won_at`: set when Stripe reinstates a previously-paid-out card tip (either via successful admin notification OR via the retry-bailout path)
- `dispute_email_attempts`: retry counter for the dispute-won admin notification (0 to 3)
- `dispute_email_failed_at`: set only when the dispute-won notification was abandoned after exhausting retries; canonical "needs manual reconciliation" marker
```

- [ ] **Step 3: Add the state-machine description immediately after the `tips` column list**

```markdown
### Dispute-won notification state machine

For tip rows that have entered the dispute-reinstatement flow, the `(dispute_won_at, dispute_email_failed_at)` pair describes one of four states:

- **In progress, no failures yet:** `dispute_won_at IS NULL AND dispute_email_attempts = 0`. Webhook has not delivered, or the first attempt has not run.
- **In progress, retrying:** `dispute_won_at IS NULL AND dispute_email_attempts > 0 AND dispute_email_attempts < 3`. One or more send failures, still inside the retry window.
- **Completed normally:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NULL`. Email delivered, admin notified.
- **Completed by bailout:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NOT NULL`. Three send failures; admin must reconcile manually.

The `dispute_email_failed_at IS NOT NULL` predicate is the canonical "needs manual reconciliation" marker.
```

- [ ] **Step 4: Add a `## Operational Practices` section at the end of `ARCHITECTURE.md`**

```markdown
## Operational Practices

### Weekly dispute-email-bailout sweep

The dispute-won email-retry bailout (see `server/utils/payrollDisputeNotify.js`) writes `tips.dispute_email_failed_at = NOW()` when it permanently abandons a notification after three send failures. The Sentry alert that accompanies the bailout is best-effort: a process crash between commit and the Sentry call, or a Sentry transport failure, can lose the alert silently while the DB row carries the canonical marker.

Run this query weekly to catch any abandonments that did not reach Sentry:

```sql
SELECT id, dispute_email_failed_at, amount_cents, shift_id, target_user_id
  FROM tips
 WHERE dispute_email_failed_at IS NOT NULL
 ORDER BY dispute_email_failed_at DESC;
```

For each row returned, follow the manual recovery runbook in `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md`. Search `proposal_activity_log` by tip id before posting adjustments to avoid double-paying bartenders.
```

- [ ] **Step 5: Verify the edits landed cleanly**

Run: `grep -n "dispute_email" ARCHITECTURE.md`
Expected: at least four matches (the two new columns in the table list, the state-machine description, and the Operational Practices section).

Run: `grep -n "Operational Practices" ARCHITECTURE.md`
Expected: one match.

- [ ] **Step 6: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(arch): tips state machine + operational practices for dispute-email bailout"
```

---

## Task 8: Add operational runbook reminder to `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Locate an existing operational / runbook section in `README.md`**

Run: `grep -nE "^#+ (Operations|Runbook|Maintenance|Operational)" README.md`

If a relevant section already exists, append a subsection inside it. If none exists, add a new `## Operational Runbook` section near the end of the file (before any "License" or trailing-meta sections).

- [ ] **Step 2: Add the runbook subsection**

```markdown
### Weekly dispute-email-bailout sweep

The dispute-won email notification (fires on Stripe `charge.dispute.funds_reinstated`) auto-abandons after 3 failed send attempts. The DB column `tips.dispute_email_failed_at` is the canonical "needs manual reconciliation" marker; the accompanying Sentry alert is best-effort.

**Weekly:** run the sweep query documented in `ARCHITECTURE.md` ("Weekly dispute-email-bailout sweep") to catch any abandonment whose Sentry alert was lost. The spec at `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md` has the recovery runbook.
```

- [ ] **Step 3: Verify the addition**

Run: `grep -n "dispute-email-bailout" README.md`
Expected: at least one match.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(readme): weekly dispute-email-bailout sweep runbook reminder"
```

---

## Final verification

- [ ] **Step 1: Confirm all eight tasks committed**

Run: `git log --oneline -10`
Expected: the most recent commits include schema, seam, refactor, three test commits, ARCHITECTURE update, README update.

- [ ] **Step 2: Run the test suite one more time, fresh**

Run: `node --test server/utils/payrollDisputeNotify.test.js 2>&1 | tail -15`
Expected: `tests 11`, `pass 11`, `fail 0`.

- [ ] **Step 3: Spot-check the call site in `stripe.js` still type-aligns**

Run: `grep -n "notifyDisputeWon" server/routes/stripe.js`
Expected: one callsite, signature unchanged.

- [ ] **Step 4: Run the full test suite to confirm no other tests broke**

Run: `npm test 2>&1 | tail -20`
Expected: total tests increased by 11 vs. baseline, all pass.
