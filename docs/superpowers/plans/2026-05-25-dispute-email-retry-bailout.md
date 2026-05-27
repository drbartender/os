# Dispute-won Email Retry Bailout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap the dispute-email retry storm at 3 attempts. After three failed sends, atomically mark the tip's `dispute_won_at` and a new `dispute_email_failed_at` so Stripe redeliveries short-circuit and the DB carries the canonical "abandoned" marker.

**Architecture:** Wrap the entire `notifyDisputeWon` flow in a held `pool.connect()` transaction with `SELECT FOR UPDATE OF t` on the tip row. Bound the email send with `Promise.race` against a 10-second timeout. Finalize via a single atomic UPDATE that uses CASE to fire the bailout. Capture Sentry AFTER commit with a try/catch + stderr fallback. The DB column (`dispute_email_failed_at`) is the canonical durable artifact; an admin sweep query is the failsafe.

**Tech Stack:** Node.js 18+, Express 4, PostgreSQL via `pg`, `@sentry/node`, Resend (email), `node:test` for tests.

**Source spec:** `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md`

**Execution-review cadence:** Specialized review agents fire at two checkpoints during execution: after Task 1 (schema), dispatch `database-review`; after Task 2 (transactional refactor of money-adjacent webhook code), dispatch `database-review` + `code-review` + `consistency-check` in parallel. Tasks 3-8 land without per-task agent review; the pre-push fleet covers the whole batch.

---

## Task 1: Schema migration

**Files:**
- Modify: `server/db/schema.sql` (append after line 2592)

- [ ] **Step 1: Open `server/db/schema.sql` and locate line 2592.** It contains `ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_won_at TIMESTAMPTZ;` inside the Phase 2 staff-payments block.

- [ ] **Step 2: Append the two new ALTERs immediately after line 2592, prefixed with a date comment so future readers can locate them**

```sql
-- Dispute-email retry bailout (2026-05-25)
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_failed_at TIMESTAMPTZ;
```

- [ ] **Step 3: Verify the additions landed**

Run: `grep -n "dispute_email" server/db/schema.sql`

Expected: two lines listing `dispute_email_attempts` and `dispute_email_failed_at` immediately after the date comment, near line 2593-2595.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(payroll): tips columns for dispute-email retry bailout"
```

- [ ] **Step 5: Checkpoint review.** Dispatch the `database-review` agent against this commit. Prompt: `Review commit <SHA> for schema correctness. Two new ALTERs were added to server/db/schema.sql: dispute_email_attempts (INTEGER NOT NULL DEFAULT 0) and dispute_email_failed_at (TIMESTAMPTZ). Verify idempotency on fresh and existing DBs, rolling-restart safety, and no overlap with existing indexes.` Wait for the review. Address any findings before proceeding to Task 2.

---

## Task 2: Refactor `notifyDisputeWon` to the transactional shape (constants + seam + body in one commit)

**Files:**
- Modify: `server/utils/payrollDisputeNotify.js`

This task replaces the entire `notifyDisputeWon` function and introduces the module-level constants and `__setDeps` seam in the same commit. Per CLAUDE.md commit rule 3, the seam and constants exist only to support the refactor; they form a single logical feature.

- [ ] **Step 1: Open `server/utils/payrollDisputeNotify.js`.** Confirm the current shape:
   - Imports: `Sentry`, `pool`, `sendEmail`, `emailTemplates`, `splitEvenly`, `getEventTypeLabel`
   - `fmtDate` helper
   - One `notifyDisputeWon` function
   - `module.exports = { notifyDisputeWon }`

- [ ] **Step 2: Insert module-level constants and `__setDeps` seam between `fmtDate` and the function definition**

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

let _deps = { sendEmail, Sentry, sendTimeoutMs: SEND_TIMEOUT_MS, pool };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

async function notifyDisputeWon(tipId, { reinstatedAmountCents, disputeOpenedAt, disputeWonAt }) {
```

- [ ] **Step 3: Replace the entire `notifyDisputeWon` function body** (between the opening brace and its matching closing brace) with the new transactional implementation:

```js
async function notifyDisputeWon(tipId, { reinstatedAmountCents, disputeOpenedAt, disputeWonAt }) {
  const client = await _deps.pool.connect();
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
    // which is required when FOR UPDATE is combined with LEFT JOINs to
    // nullable rows. Precedent: server/routes/drinkPlanConsult.js:144
    // uses the same pattern with alias `dp`.
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

- [ ] **Step 4: Update the module.exports at the bottom of the file** to include `__setDeps`

Find:
```js
module.exports = { notifyDisputeWon };
```

Replace with:
```js
module.exports = { notifyDisputeWon, __setDeps };
```

- [ ] **Step 5: Verify the module loads cleanly**

Run: `node -c server/utils/payrollDisputeNotify.js`
Expected: exit code 0, no output.

Run: `node -e "const m = require('./server/utils/payrollDisputeNotify'); console.log(Object.keys(m).sort());"`
Expected output: `[ '__setDeps', 'notifyDisputeWon' ]`. A `[email] RESEND_API_KEY is NOT set` warning may or may not appear (conditional on the dev env).

- [ ] **Step 6: Spot-check the production callsite signature still aligns**

Run: `grep -n "notifyDisputeWon" server/routes/stripe.js`
Expected: exactly one production callsite around line 1654. Read the lines around it: the call is `await notifyDisputeWon(tipId, { reinstatedAmountCents: ..., disputeOpenedAt: ..., disputeWonAt: ... })`. Signature unchanged from before. The return value is `await`ed and the caller does not destructure the return shape, so the new `abandoned` field is additive-safe.

- [ ] **Step 7: Commit**

```bash
git add server/utils/payrollDisputeNotify.js
git commit -m "feat(payroll): transactional dispute-email retry bailout"
```

- [ ] **Step 8: Checkpoint review.** Dispatch `database-review`, `code-review`, and `consistency-check` in PARALLEL via a single Agent-tool message. Prompts:
   - `database-review`: review commit `<SHA>` for transaction safety, lock semantics (`FOR UPDATE OF t` with LEFT JOINs), the atomic CASE UPDATE, and idempotency of the new SQL statements.
   - `code-review`: review commit `<SHA>` for correctness of `Promise.race` with orphan-suppression `.catch(() => {})`, post-commit Sentry try/catch, error propagation, and the new `__setDeps` seam shape.
   - `consistency-check`: verify the state machine (`dispute_won_at`, `dispute_email_failed_at`) is internally consistent across the new SQL, the function logic, the test scaffolding to come, and the cited spec sections.
   Wait for all three. Address any blockers before proceeding to Task 3.

---

## Task 3: Test scaffolding + four simpler test cases

**Files:**
- Replace entirely: `server/utils/payrollDisputeNotify.test.js` (an existing 128-line file with 3 legacy tests EXISTS at this path; this task replaces it wholesale)

The legacy tests (`appendBug`-style three cases against the old non-transactional behavior) are subsumed by the new 11-test suite. The legacy idempotency test maps to the new "Already-completed short-circuit" test; the legacy name-resolution coverage is exercised by every test that asserts the return shape. No coverage is lost.

- [ ] **Step 1: Replace the file contents entirely.** Open `server/utils/payrollDisputeNotify.test.js` and replace ALL contents with the scaffolding below:

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

// Negative ids guaranteed unique vs. SERIAL prod rows; deterministic
// stripe_payment_intent_id values keyed off the test id avoid collisions
// across this file's tests.
const TEST_TIP_PREFIX = -990000000;
const ADMIN_EMAIL_DEFAULT = 'test@example.com';

let sendEmailMock, captureExceptionMock, captureMessageMock, consoleErrorOriginal, adminEmailOriginal;

async function purgeTestRows() {
  await pool.query(
    `DELETE FROM tips
       WHERE id <= $1
          OR stripe_payment_intent_id LIKE 'pi_test_%'
          OR stripe_payment_intent_id = 'pi_disp_won_test'`,
    [TEST_TIP_PREFIX]
  );
}

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
    await purgeTestRows();
  });

  after(async () => {
    await purgeTestRows();
  });

  beforeEach(() => {
    sendEmailMock = mock.fn(async () => ({ id: 'msg_test' }));
    captureExceptionMock = mock.fn();
    captureMessageMock = mock.fn();
    adminEmailOriginal = process.env.ADMIN_EMAIL;
    process.env.ADMIN_EMAIL = ADMIN_EMAIL_DEFAULT;
    __setDeps({
      sendEmail: sendEmailMock,
      Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
      sendTimeoutMs: 100,
      pool,
    });
  });

  afterEach(async () => {
    // Reset deps to harmless no-ops, NOT the real sendEmail/Sentry, so that
    // any orphan invocation from a misbehaving test cannot hit production
    // Resend or pollute Sentry. pool is restored to the real pool.
    __setDeps({
      sendEmail: async () => ({ id: 'noop' }),
      Sentry: { captureException: () => {}, captureMessage: () => {} },
      sendTimeoutMs: 10_000,
      pool,
    });
    if (typeof adminEmailOriginal === 'string') process.env.ADMIN_EMAIL = adminEmailOriginal;
    else delete process.env.ADMIN_EMAIL;
    if (consoleErrorOriginal) {
      console.error = consoleErrorOriginal;
      consoleErrorOriginal = null;
    }
    await purgeTestRows();
  });
});
```

- [ ] **Step 2: Add the "Success path" test** inside the `describe` block, just before the closing `});`

```js
  test('success path: marks dispute_won_at, resets attempts, returns abandoned=false', async () => {
    const id = TEST_TIP_PREFIX - 1;
    await seedTip({ id, dispute_email_attempts: 0 });

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

- [ ] **Step 3: Add the "Counter reset on success after prior failure" test**

```js
  test('counter reset: prior failures zeroed on success', async () => {
    const id = TEST_TIP_PREFIX - 2;
    await seedTip({ id, dispute_email_attempts: 2 });

    await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 0);
    assert.notStrictEqual(after.dispute_won_at, null);
  });
```

- [ ] **Step 4: Add the "Already-completed short-circuit" test**

```js
  test('already-completed: returns null, does not touch state or send', async () => {
    const id = TEST_TIP_PREFIX - 3;
    await seedTip({ id, dispute_won_at: new Date('2026-01-01') });

    const result = await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });

    assert.strictEqual(result, null);
    assert.strictEqual(sendEmailMock.mock.callCount(), 0);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);
    assert.strictEqual(captureExceptionMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 0);
  });
```

- [ ] **Step 5: Add the "ADMIN_EMAIL unset" test**

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
      else delete process.env.ADMIN_EMAIL;
    }

    assert.strictEqual(captureExceptionMock.mock.callCount(), 1);
    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 1);
    assert.strictEqual(after.dispute_won_at, null);
  });
```

- [ ] **Step 6: Run the test file and verify all four tests pass**

Run: `node --test server/utils/payrollDisputeNotify.test.js 2>&1 | grep -E "^# (tests|pass|fail|skip)"`
Expected:
```
# tests 4
# pass 4
# fail 0
```

If any test fails, read the failure and fix the test (not the production code) unless the failure exposes a real bug in Task 2. If Task 2 has a bug, fix it, re-run, only commit when green.

- [ ] **Step 7: Commit**

```bash
git add server/utils/payrollDisputeNotify.test.js
git commit -m "test(payroll): scaffold + 4 simple cases for dispute-email retry"
```

---

## Task 4: Failure-path test cases

**Files:**
- Modify: `server/utils/payrollDisputeNotify.test.js`

- [ ] **Step 1: Add the "Single failure, attempts below threshold" test** inside the `describe` block, after the prior tests

```js
  test('single failure: attempts=1, no flags set, no captureMessage', async () => {
    const id = TEST_TIP_PREFIX - 5;
    await seedTip({ id, dispute_email_attempts: 0 });
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
    // Both NOW() in the same UPDATE → equal timestamps.
    assert.strictEqual(new Date(after.dispute_won_at).getTime(), new Date(after.dispute_email_failed_at).getTime());
  });
```

- [ ] **Step 3: Add the "Computation throw rolls back without incrementing" test**

Use the `__setDeps` seam to inject a pool wrapper that throws on the users-resolution query (identified by SQL substring, not call-count, so the test is robust to query order). Seed `target_user_id` so the users-resolution query runs even with `shift_id = null`.

```js
  test('computation throw: counter unchanged, dispute_won_at null, no Sentry from inside notify', async () => {
    const id = TEST_TIP_PREFIX - 7;
    // target_user_id forces the users-resolution query to run even with shift_id = null.
    await seedTip({ id, dispute_email_attempts: 0, target_user_id: -1 });

    // Inject a pool wrapper that throws on the users join, identified by SQL substring.
    __setDeps({
      sendEmail: sendEmailMock,
      Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
      sendTimeoutMs: 100,
      pool: {
        connect: async () => {
          const realClient = await pool.connect();
          const realQuery = realClient.query.bind(realClient);
          realClient.query = async (sqlOrConfig, params) => {
            const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
            if (sql && sql.includes('contractor_profiles cp ON cp.user_id')) {
              throw new Error('users lookup boom');
            }
            return realQuery(sqlOrConfig, params);
          };
          return realClient;
        },
      },
    });

    await assert.rejects(
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
      /users lookup boom/
    );

    assert.strictEqual(captureExceptionMock.mock.callCount(), 0);
    assert.strictEqual(captureMessageMock.mock.callCount(), 0);

    const after = await readTip(id);
    assert.strictEqual(after.dispute_email_attempts, 0);
    assert.strictEqual(after.dispute_won_at, null);
    assert.strictEqual(after.dispute_email_failed_at, null);
  });
```

- [ ] **Step 4: Run the 7 tests and verify all pass**

Run: `node --test server/utils/payrollDisputeNotify.test.js 2>&1 | grep -E "^# (tests|pass|fail|skip)"`
Expected:
```
# tests 7
# pass 7
# fail 0
```

- [ ] **Step 5: Commit**

```bash
git add server/utils/payrollDisputeNotify.test.js
git commit -m "test(payroll): failure-path cases for dispute-email retry"
```

---

## Task 5: Concurrency, timeout, and post-commit-Sentry-failure tests

**Files:**
- Modify: `server/utils/payrollDisputeNotify.test.js`

The concurrency tests require `pool.max >= 2` so the second `pool.connect()` call can grab its own connection while the first holds the lock. Confirm before running:

Run: `grep -n "max" server/db/index.js | head -5`
Expected: a Pool config with `max` >= 2, OR no `max` set (pg default is 10). If `max = 1`, the concurrency tests will hang. Adjust the project pool config or document this as a precondition.

- [ ] **Step 1: Add the "Concurrency: bailout-trigger race" test**

```js
  test('concurrency bailout race: at attempts=2, first call bails out, second short-circuits', async () => {
    const id = TEST_TIP_PREFIX - 8;
    await seedTip({ id, dispute_email_attempts: 2 });
    sendEmailMock.mock.mockImplementation(() => Promise.reject(new Error('still down')));

    const results = await Promise.all([
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
      notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() }),
    ]);

    // One bailout, one short-circuit.
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

- [ ] **Step 3: Add the "Send-timeout" test** (spec-aligned constants: 50ms timeout, 200ms resolve, < 200ms wall-clock)

```js
  test('send-timeout: Promise.race rejects within bound, counter increments', async () => {
    const id = TEST_TIP_PREFIX - 10;
    await seedTip({ id, dispute_email_attempts: 0 });

    __setDeps({
      sendEmail: () => new Promise(resolve => setTimeout(() => resolve({ id: 'late' }), 200)),
      Sentry: { captureException: captureExceptionMock, captureMessage: captureMessageMock },
      sendTimeoutMs: 50,
      pool,
    });

    const startedAt = Date.now();
    await notifyDisputeWon(id, { reinstatedAmountCents: 3000, disputeOpenedAt: new Date(), disputeWonAt: new Date() });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 200, `expected < 200ms, got ${elapsed}ms`);
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
  test('post-commit Sentry capture failure: DB committed, console.error fired', async () => {
    const id = TEST_TIP_PREFIX - 11;
    await seedTip({ id, dispute_email_attempts: 2 });

    const throwingCaptureMessage = mock.fn(() => { throw new Error('sentry boom'); });
    __setDeps({
      sendEmail: sendEmailMock,
      Sentry: { captureException: captureExceptionMock, captureMessage: throwingCaptureMessage },
      sendTimeoutMs: 100,
      pool,
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

Run: `node --test server/utils/payrollDisputeNotify.test.js 2>&1 | grep -E "^# (tests|pass|fail|skip)"`
Expected:
```
# tests 11
# pass 11
# fail 0
```

If any concurrency test is flaky, run three times in a row:
```
for i in 1 2 3; do node --test server/utils/payrollDisputeNotify.test.js 2>&1 | grep -E "^# (tests|pass|fail)"; done
```
All three runs must show `pass 11`. A flake indicates the row-lock serialization assumption is wrong; fix the underlying issue, not the test.

- [ ] **Step 6: Commit**

```bash
git add server/utils/payrollDisputeNotify.test.js
git commit -m "test(payroll): concurrency + timeout + Sentry-failure cases for dispute-email"
```

---

## Task 6: Backfill pre-existing `tips`-table drift in `ARCHITECTURE.md`

**Files:**
- Modify: `ARCHITECTURE.md` (tips-table description around lines 790-800)

The current `tips` table description in `ARCHITECTURE.md` is missing five columns that have existed in `schema.sql` for some time: `fee_cents`, `shift_id`, `rolled_forward_at`, `refunded_amount_cents`, `dispute_won_at`. This task fixes the pre-existing drift; the bailout-specific additions land in Task 7.

- [ ] **Step 1: Locate the existing `tips` table description in `ARCHITECTURE.md`**

Run: `grep -n "tips" ARCHITECTURE.md | head -20`
Expected: at least one heading or column-list entry around line 790-800.

Open the file and read the tips table description.

- [ ] **Step 2: Verify which columns are present today, and which are missing**

For each of the five columns (`fee_cents`, `shift_id`, `rolled_forward_at`, `refunded_amount_cents`, `dispute_won_at`), grep ARCHITECTURE.md to confirm whether the column is already documented. Only append entries for columns NOT already present:

```bash
for col in fee_cents shift_id rolled_forward_at refunded_amount_cents dispute_won_at; do
  echo "=== $col ==="
  grep -n "$col" ARCHITECTURE.md || echo "(missing)"
done
```

- [ ] **Step 3: Append the missing column entries to the `tips` table description**

For each column flagged "missing" in Step 2, add to the column list (preserving the section's format; if the section uses backticks or a different bullet style, match it):

```
- `fee_cents`: integer cents of the Stripe fee withheld from the tip; populated on tip webhook
- `shift_id`: FK to `shifts.id` when the tip is matched to a specific shift; null until matched
- `rolled_forward_at`: set when a late tip is rolled forward into the next open payout period
- `refunded_amount_cents`: cumulative refund cents applied to this tip (clawback tracking)
- `dispute_won_at`: set when Stripe reinstates a previously-paid-out card tip (either via successful admin notification OR via the retry-bailout path)
```

- [ ] **Step 4: Verify the additions landed**

Run: `for col in fee_cents shift_id rolled_forward_at refunded_amount_cents dispute_won_at; do echo "$col: $(grep -c "$col" ARCHITECTURE.md) matches"; done`
Expected: every column shows at least 1 match.

- [ ] **Step 5: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(arch): backfill tips-table drift (fee_cents, shift_id, rolled_forward_at, refunded_amount_cents, dispute_won_at)"
```

---

## Task 7: Document new bailout columns + state machine + Operational Practices in `ARCHITECTURE.md`

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Append the two new bailout columns to the `tips` table description** (same column-list format as Task 6)

```
- `dispute_email_attempts`: retry counter for the dispute-won admin notification (0 to 3)
- `dispute_email_failed_at`: set only when the dispute-won notification was abandoned after exhausting retries; canonical "needs manual reconciliation" marker
```

- [ ] **Step 2: Add the state-machine subsection immediately after the `tips` column list**

```markdown
### Dispute-won notification state machine

For tip rows that have entered the dispute-reinstatement flow, the `(dispute_won_at, dispute_email_failed_at)` pair describes one of four states:

- **In progress, no failures yet:** `dispute_won_at IS NULL AND dispute_email_attempts = 0`. Webhook has not delivered, or the first attempt has not run.
- **In progress, retrying:** `dispute_won_at IS NULL AND dispute_email_attempts > 0 AND dispute_email_attempts < 3`. One or more send failures, still inside the retry window.
- **Completed normally:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NULL`. Email delivered, admin notified.
- **Completed by bailout:** `dispute_won_at IS NOT NULL AND dispute_email_failed_at IS NOT NULL`. Three send failures; admin must reconcile manually.

The `dispute_email_failed_at IS NOT NULL` predicate is the canonical "needs manual reconciliation" marker.
```

- [ ] **Step 3: Add a `## Operational Practices` section at the end of `ARCHITECTURE.md`** (if such a section already exists, append the subsection there instead)

```markdown
## Operational Practices

### Weekly dispute-email-bailout sweep

The dispute-won email-retry bailout (see `server/utils/payrollDisputeNotify.js`) writes `tips.dispute_email_failed_at = NOW()` when it permanently abandons a notification after three send failures. The Sentry alert accompanying the bailout is best-effort: a process crash between commit and the Sentry call, or a Sentry transport failure, can lose the alert silently while the DB row carries the canonical marker.

Run this query weekly to catch any abandonments that did not reach Sentry:

```sql
SELECT id, dispute_email_failed_at, amount_cents, shift_id, target_user_id
  FROM tips
 WHERE dispute_email_failed_at IS NOT NULL
 ORDER BY dispute_email_failed_at DESC;
```

For each row, follow the manual recovery runbook in `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md`. Always search `proposal_activity_log` by tip id before posting adjustments to avoid double-paying bartenders (the Promise.race timeout in `notifyDisputeWon` aborts the awaiter but does not cancel the in-flight Resend request, so the email may have actually delivered server-side even when the function treated it as a failure).
```

- [ ] **Step 4: Verify the edits**

Run: `grep -n "dispute_email" ARCHITECTURE.md`
Expected: at least four matches (two column entries, the state-machine description, the Operational Practices subsection).

Run: `grep -n "Operational Practices" ARCHITECTURE.md`
Expected: at least one match.

- [ ] **Step 5: Commit**

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

**Weekly:** run the sweep query documented in `ARCHITECTURE.md` ("Weekly dispute-email-bailout sweep") to catch any abandonment whose Sentry alert was lost. The spec at `docs/superpowers/specs/2026-05-25-dispute-email-retry-bailout-design.md` carries the recovery runbook.
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

Run: `git log --oneline -12`
Expected: the eight most recent commits are (in order): schema migration, transactional refactor, simple-tests scaffolding, failure-path tests, concurrency/timeout/Sentry tests, ARCHITECTURE drift backfill, ARCHITECTURE new columns + state machine + Operational Practices, README runbook.

- [ ] **Step 2: Run the dispute-notify test suite one final time**

Run: `node --test server/utils/payrollDisputeNotify.test.js 2>&1 | grep -E "^# (tests|pass|fail|skip)"`
Expected:
```
# tests 11
# pass 11
# fail 0
```

- [ ] **Step 3: Verify the production callsite still type-aligns AND tolerates the new return shape**

Run: `grep -n -A 3 "notifyDisputeWon" server/routes/stripe.js`
Expected: one callsite, awaits the return without destructuring. The new `abandoned` field is safely ignored (the call site does not depend on the return shape's fields).

- [ ] **Step 4: Run the full server test suite to confirm no other tests regressed**

Run: `npm test 2>&1 | grep -E "^# (tests|pass|fail|skip)" | tail -5`

Compare to the pre-implementation baseline. The expected delta is `+11 -3 tests = +8 tests`: 11 new dispute-notify tests minus the 3 legacy tests that Task 3 replaced. The pass count should track `+8` over baseline; the fail count should remain at the baseline (which is 0, or whatever pre-existing failures exist due to unrelated infrastructure).

If any test regressed (was passing before, fails now), investigate; the refactor in Task 2 should not have touched anything outside `payrollDisputeNotify.js`.
