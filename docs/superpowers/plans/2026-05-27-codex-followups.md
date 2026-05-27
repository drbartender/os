# Codex pre-push follow-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** Four entries in `docs/tech-debt.md:159-185` (committed `af947bb` on `main`, unpushed). Each entry has its own `**Source / What / Why deferred / Next step:**` block — the equivalent of a per-finding mini-spec. No separate spec doc; the tech-debt entries are concrete enough.

**Goal:** Apply the 4 codex findings queued during the 2026-05-27 pre-push review fleet. These are real bugs in cc-import admin flows and tip payroll handling that were deliberately deferred so we could ship the larger batch on tempo. None are exploitable security issues; all are correctness defects in operator workflows or money-path corner cases.

**Architecture:** Four independent fixes, each landed as its own commit on branch `codex-followups`. Order is smallest/safest → riskiest: Fix 1 (one-line additive call) → Fix 2 (defensive branching) → Fix 3 (date-based reclassification helper) → Fix 4 (money-path math change with new tests). Each fix follows TDD — failing test first, minimal fix, verify. The matching `docs/tech-debt.md` entry is DELETED INSIDE THE SAME COMMIT as its fix (no separate cleanup commit); keeps `tech-debt.md` consistent with `main` at every intermediate sha.

Worktree at `..\worktrees\codex-followups\`; merge back to `main` from the `os` integration folder on explicit user cue when all four are green.

**Tech Stack:** Node.js 18 / Express 4.22, raw SQL via `pg` 8.20, `node:test` (built-in test runner), Sentry for non-blocking observability, Neon Postgres (dev branch for local test DB).

---

## Prerequisite — completed

The dev-branch `pay_periods` row #783 was stuck in `status='processing'`, which made `accruePayoutsForProposal` skip and the existing `payrollAccrual.test.js` baseline tests fail with "0 rows". Resolved 2026-05-27 via Neon MCP against branch `br-delicate-union-adt2hvor`:

```sql
UPDATE pay_periods SET status='open' WHERE id=783 RETURNING id, start_date, end_date, status;
-- returned: { id: 783, start_date: 2026-05-26, end_date: 2026-06-01, status: 'open' }
```

Tests in this plan assume an `'open'` pay_period covering today exists in the dev branch. If a test run reproduces the same skip-with-0-rows symptom in the future, re-run the UPDATE.

---

## File structure

| File | Responsibility | Touched by |
|---|---|---|
| `server/routes/admin/ccImport/review.js` | Orphan-payment + errored-row + skipped-event admin routes | Task 1, 2, 3 |
| `server/routes/admin/ccImport/review.test.js` | Integration tests for the cc-import Review endpoints | Task 1, 2, 3 |
| `scripts/cc-import/phases/phase3.js` | Source of `promoteBucketA`/`promoteBucketB` and the bucket dispatch | Task 3 (extracts a helper) |
| `scripts/cc-import/lib/buckets.js` | `classify(row, today)` returning A/B/C/D | Task 3 (read-only, reused) |
| `server/utils/payrollLateTip.js` | Late-tip rollforward util | Task 4 |
| `server/utils/payrollLateTip.test.js` | Unit tests for rollForwardLateTip | Task 4 |
| `server/utils/payrollClawback.js` | Tip-clawback util | Task 4 |
| `server/utils/payrollClawback.test.js` | Unit tests for clawbackTip | Task 4 |
| `docs/tech-debt.md` | Tracks the four deferred entries we are resolving | Each task's commit deletes its matching entry |

---

## Test harness primer

Two patterns the new test snippets all share, captured here once so each task can stay terse.

**Pattern A — admin route tests use `req()`, NOT supertest's `adminAgent.post(...)`.** The helper is defined inline in `server/routes/admin/ccImport/review.test.js:618-643` and is backed by `http.request`. Pattern:

```javascript
const r = await req('POST', '/api/admin/cc-import/review/orphan-payment/123/link', adminToken, { proposal_id: 999 });
assert.equal(r.status, 200);
const body = JSON.parse(r.body);  // r.body is the raw response string, not pre-parsed
assert.equal(body.ok, true);
```

`adminToken` is set up in `before()` and is in module scope; reuse it.

**Pattern B — `legacy_cc_payments` rows MUST seed a `legacy_cc_raw_imports` row first and reference it.** Schema (`server/db/schema.sql:2725-2727`) declares `raw_import_id BIGINT NOT NULL REFERENCES legacy_cc_raw_imports(id) ON DELETE RESTRICT` plus `UNIQUE (raw_import_id)`. A NULL `raw_import_id` violates the constraint and the INSERT throws before the route is ever hit. Mirror the existing pattern at `review.test.js:265-307`:

```javascript
// Seed the raw_imports parent first.
const rawIns = await pool.query(
  `INSERT INTO legacy_cc_raw_imports
     (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
   VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
   RETURNING id`,
  [nextSrn(), nextHash('codex-followup')]
);
const rawImportId = rawIns.rows[0].id;

// Then the legacy_cc_payments child, referencing it.
const legacyRes = await pool.query(
  `INSERT INTO legacy_cc_payments
     (cc_event_title, cc_type, paid_on, payment_applied_cents, payment_method, raw_import_id)
   VALUES ('Test Event', 'Payment', CURRENT_DATE, 10000, 'card', $1)
   RETURNING id`,
  [rawImportId]
);
```

`nextSrn()` and `nextHash()` already exist (`review.test.js:61-63`). Cleanup order in `finally`: delete from `legacy_cc_payments` first, then `legacy_cc_raw_imports` (FK is RESTRICT, not CASCADE).

---

## Task 1: Suppress stale balance reminders on orphan-payment link

**Codex finding:** [P2] When a legacy payment is linked to a proposal via the Review page, `recomputeAmountPaid` + `rederivePaymentTypeAndStatus` run, but `suppressStaleBalanceReminders` does not. `phase4.run()` already calls it at the end of the initial import pass — the manual link path is the gap. If the linked payment fully settles a future-dated imported proposal, any pending `balance_*` rows in `scheduled_messages` will fire even though the balance is paid.

**Files:**
- Modify: `server/routes/admin/ccImport/review.js:421-427`
- Test: `server/routes/admin/ccImport/review.test.js` (add one case)
- Modify: `docs/tech-debt.md` (delete the matching entry in the same commit)

- [ ] **Step 1: Confirm `phase4.suppressStaleBalanceReminders` signature**

Already verified by the plan author (against `scripts/cc-import/phases/phase4.js:763-777`):

```javascript
async function suppressStaleBalanceReminders(client) {
  const r = await client.query(`UPDATE scheduled_messages SET status='suppressed' ...
    WHERE entity_type='proposal' AND status='pending'
      AND message_type = ANY($1::text[])
      AND entity_id IN (SELECT id FROM proposals WHERE cc_id IS NOT NULL AND amount_paid >= total_price)`,
    [STALE_BALANCE_REMINDER_TYPES]);
  return r.rowCount;
}
```

Takes a `pg` client (NOT a `proposalId`), scans across all cc-imported fully-paid proposals. The tech-debt entry at `docs/tech-debt.md:171` said `(proposalId)` — that was wrong; the actual signature is `(client)`. The plan calls it `suppressStaleBalanceReminders(tail)`, which matches.

- [ ] **Step 2: Read the existing orphan-link tests to confirm the harness**

Run:
```bash
grep -n "/review/orphan-payment.*link" server/routes/admin/ccImport/review.test.js
```
Expected: a mix of existing tests at the file's `// ── §2 orphan-payment/:id/link ──` section. All use `req('POST', path, adminToken, body)` and assert `r.status` + `JSON.parse(r.body)`. Mirror that.

- [ ] **Step 3: Write the failing test**

Append to `server/routes/admin/ccImport/review.test.js`, after the existing orphan-link tests:

```javascript
test('POST /orphan-payment/:id/link suppresses stale balance reminders when legacy payment fully settles a future proposal', async () => {
  // A cc-imported proposal with a future event_date and a pending balance_reminder.
  // The legacy payment we link covers total_price in full, so post-link the
  // proposal is paid AND the pending reminder must flip to 'suppressed' (otherwise
  // it fires even though balance is 0).
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES (NULL, 'confirmed', CURRENT_DATE + INTERVAL '30 days', 500, 0,
             'cc-fix1-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;

  const smRes = await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'balance_reminder_non_autopay_t3', 'client', NULL, 'email',
             NOW() + INTERVAL '20 days', 'pending')
     RETURNING id`,
    [proposalId]
  );
  const smId = smRes.rows[0].id;

  // Seed the legacy_cc_raw_imports parent first (NOT NULL FK at schema.sql:2725).
  const rawIns = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
     VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
     RETURNING id`,
    [nextSrn(), nextHash('fix1-orphan')]
  );
  const rawImportId = rawIns.rows[0].id;

  // Legacy payment NOT yet linked (cc_event_id NULL = orphan).
  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments
       (cc_event_title, cc_type, paid_on, payment_applied_cents, payment_method, raw_import_id)
     VALUES ('Fix1 Test', 'Payment', CURRENT_DATE - INTERVAL '5 days', 50000, 'card', $1)
     RETURNING id`,
    [rawImportId]
  );
  const legacyId = legacyRes.rows[0].id;

  try {
    const r = await req('POST', `/api/admin/cc-import/review/orphan-payment/${legacyId}/link`,
      adminToken, { proposal_id: proposalId, cc_event_id: proposalCcId });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);

    const after = await pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [smId]);
    assert.equal(after.rows[0].status, 'suppressed');
  } finally {
    await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [smId]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    await pool.query('DELETE FROM legacy_cc_raw_imports WHERE id = $1', [rawImportId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "suppresses stale"
```
Expected: `✖ ... suppresses stale balance reminders ...` with `AssertionError: 'pending' !== 'suppressed'`.

- [ ] **Step 5: Apply the fix**

In `server/routes/admin/ccImport/review.js`, find the tail-connection block around line 421:

```javascript
const tail = await pool.connect();
try {
  await phase4.recomputeAmountPaid(tail);
  await phase4.rederivePaymentTypeAndStatus(tail);
} finally {
  tail.release();
}
```

Replace with:

```javascript
const tail = await pool.connect();
try {
  await phase4.recomputeAmountPaid(tail);
  await phase4.rederivePaymentTypeAndStatus(tail);
  // Mirror phase4.run() — when a manual link fully settles a future proposal,
  // any already-scheduled balance_* rows must be suppressed so they don't fire.
  // suppressStaleBalanceReminders runs on the same client; its UPDATE commits
  // when the client returns to the pool (no explicit BEGIN/COMMIT here — the
  // helper's UPDATE is auto-committed by the driver since we never opened a txn
  // on this connection).
  await phase4.suppressStaleBalanceReminders(tail);
} finally {
  tail.release();
}
```

- [ ] **Step 6: Run the new test — verify it passes**

```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "suppresses stale"
```
Expected: PASS.

- [ ] **Step 7: Run the full file — verify no regression**

```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | tail -10
```
Expected: `tests N, pass N, fail 0`.

- [ ] **Step 8: Delete the matching tech-debt entry**

Open `docs/tech-debt.md`. Find the entry `### CC-Import: orphan-payment link skips suppressStaleBalanceReminders` (around line 166). Delete the entire `### ... **Source:** / **What:** / **Why deferred:** / **Next step:**` block.

- [ ] **Step 9: Commit**

```bash
git add server/routes/admin/ccImport/review.js server/routes/admin/ccImport/review.test.js docs/tech-debt.md
git commit -m "fix(cc-import): suppress stale balance reminders on orphan-payment link"
```

---

## Task 2: Reject orphan-payment link on non-success promote status (atomic txn)

**Codex finding:** [P1] `phase4.promoteSingleLegacyPayment` and `promoteSingleLegacyRefund` return `{ status: 'errored', error: '<reason>' }` for failure modes and `{ status: 'orphan' }` for the missing-cc_event_id branch. The link route at `server/routes/admin/ccImport/review.js` treats non-success the same as success — runs the tail, audit-logs success, returns 200 — leaving `legacy_cc_payments.cc_event_id` set but `promoted_payment_id` / `promoted_refund_id` NULL. The orphan-queue filter on `cc_event_id IS NULL` then drops the row, stranding the operator.

**Asymmetric fix.** The PAYMENT and REFUND branches have different transaction shapes (called out in the in-code comment at `review.js:364-372`) and require different fixes:

- **Payment branch** (`review.js:396-414`) — already uses a shared transaction (`BEGIN`/`COMMIT` with a client that's passed into `promoteSingleLegacyPayment`). Add a status check inside the txn; on non-success, `throw new ConflictError(...)` so the BEGIN rolls back the `cc_event_id` UPDATE.
- **Refund branch** (`review.js:373-395`) — CANNOT share a transaction with `promoteSingleLegacyRefund` (per Approach A — proposal row-locks against autopay). Already has an explicit revert-on-throw catch block at lines 382-394 that NULLs cc_event_id back. We add the same status check AFTER the call; on non-success, throw `ConflictError`. The existing catch block runs the revert UPDATE and reportException — no new revert code needed.

**Files:**
- Modify: `server/routes/admin/ccImport/review.js:373-414`
- Test: `server/routes/admin/ccImport/review.test.js` (add 2 cases — errored, happy-path regression)
- Modify: `docs/tech-debt.md` (delete the matching entry in the same commit)

- [ ] **Step 1: Read the current branches to confirm the asymmetry**

```bash
sed -n '360,415p' server/routes/admin/ccImport/review.js
```
Expected: lines 360-372 carry the Approach A comment explaining why refund uses a different shape. Lines 373-395 are the refund branch (`pool.query` direct, explicit catch revert). Lines 396-414 are the payment branch (shared client BEGIN/COMMIT).

- [ ] **Step 2: Confirm `ConflictError(message, code)` propagates `code` to the JSON body**

Already verified against `server/utils/errors.js:17-21`:

```javascript
class ConflictError extends AppError {
  constructor(message, code = 'CONFLICT') {
    super(message, 409, code);
  }
}
```

`AppError.code` is rendered into `res.body.code` by the global error middleware. Other call sites in `review.js` (e.g. lines 276-280, 289, 932) already use the `(message, code)` form. Safe to throw `new ConflictError('Promote failed: ...', 'CC_PROMOTE_FAILED')`.

- [ ] **Step 3: Write the first failing test (errored status, payment branch)**

The errored-status branch CANNOT be reproduced by seeding alone — verified against `scripts/cc-import/phases/phase4.js:357-485`. When `cc_event_id` is set in the same txn to a cc_id that resolves to a real proposal (which any clean seed does), `promoteSingleLegacyPayment` finds the proposal at lines 384-388 and returns `{ status: 'promoted' }`. The only deterministic path to `'errored'` is mocking the helper.

Append to `server/routes/admin/ccImport/review.test.js`:

```javascript
test('POST /orphan-payment/:id/link rolls back cc_event_id and 409s on errored promote status', async () => {
  // promoteSingleLegacyPayment is mocked to return errored; the new code in the
  // route throws ConflictError, and the BEGIN rolls back the cc_event_id UPDATE.
  // We can't reproduce 'errored' from a seed alone because the helper resolves
  // any matching proposal cleanly (see phase4.js:357-485).
  const phase4 = require('../../../../scripts/cc-import/phases/phase4');
  const { mock } = require('node:test');
  const spy = mock.method(phase4, 'promoteSingleLegacyPayment',
    async () => ({ status: 'errored', error: 'forced_for_test' }));

  const rawIns = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
     VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
     RETURNING id`,
    [nextSrn(), nextHash('fix2-err')]
  );
  const rawImportId = rawIns.rows[0].id;

  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_event_title, cc_type, paid_on, payment_applied_cents, raw_import_id)
     VALUES ('Fix2 Err', 'Payment', CURRENT_DATE, 10000, $1)
     RETURNING id`,
    [rawImportId]
  );
  const legacyId = legacyRes.rows[0].id;

  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES (NULL, 'confirmed', CURRENT_DATE + INTERVAL '30 days', 500, 0,
             'cc-fix2-err-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;

  try {
    const r = await req('POST', `/api/admin/cc-import/review/orphan-payment/${legacyId}/link`,
      adminToken, { proposal_id: proposalId, cc_event_id: proposalCcId });

    assert.equal(r.status, 409);
    const body = JSON.parse(r.body);
    assert.equal(body.code, 'CC_PROMOTE_FAILED');

    // cc_event_id stays NULL — row stays on the orphan queue with a recovery path.
    // This is the load-bearing assertion: proves BEGIN/ROLLBACK fired even
    // though the promote helper was mocked.
    const after = await pool.query('SELECT cc_event_id FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    assert.equal(after.rows[0].cc_event_id, null);
  } finally {
    spy.mock.restore();
    await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    await pool.query('DELETE FROM legacy_cc_raw_imports WHERE id = $1', [rawImportId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
});
```

- [ ] **Step 4: Run the new test — verify it fails**

```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "rolls back cc_event_id"
```
Expected: FAIL — current code returns 200.

- [ ] **Step 5: Refactor the PAYMENT branch (lines 396-414)**

Current code:

```javascript
// Payment path — shared transaction.
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(
    `UPDATE legacy_cc_payments SET cc_event_id = $1 WHERE id = $2`,
    [targetCcId, legacyId]
  );
  promoteResult = await phase4.promoteSingleLegacyPayment(legacyId, { client });
  await client.query('COMMIT');
} catch (err) {
  try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
  reportException(req, err, { step: 'promote_single', legacyId });
  throw err;
} finally {
  client.release();
}
```

Replace with:

```javascript
// Payment path — shared transaction. The cc_event_id UPDATE and the promote
// MUST be atomic so a non-success promote does not strand cc_event_id set
// (which would drop the row off the orphan queue's `cc_event_id IS NULL`
// filter without actually promoting it).
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query(
    `UPDATE legacy_cc_payments SET cc_event_id = $1 WHERE id = $2`,
    [targetCcId, legacyId]
  );
  promoteResult = await phase4.promoteSingleLegacyPayment(legacyId, { client });
  if (promoteResult.status !== 'promoted' && promoteResult.status !== 'already_promoted') {
    // Throw so BEGIN rolls back the cc_event_id UPDATE — keeps the row in the
    // orphan queue with a recovery path.
    throw new ConflictError(
      `Promote failed: ${promoteResult.error || promoteResult.status}`,
      'CC_PROMOTE_FAILED'
    );
  }
  await client.query('COMMIT');
} catch (err) {
  try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
  // ConflictError is the operator-visible failure — don't Sentry-spam on it.
  if (!(err instanceof ConflictError)) {
    reportException(req, err, { step: 'promote_single', legacyId });
  }
  throw err;
} finally {
  client.release();
}
```

- [ ] **Step 6: Refactor the REFUND branch (lines 373-395) — asymmetric fix**

The refund branch already has a revert-on-throw catch block. Add a status check AFTER `promoteSingleLegacyRefund(legacyId)` returns; on non-success, throw `ConflictError`. The existing catch block runs the cc_event_id revert UPDATE and (per the Sentry-skip change in Step 5) we also suppress Sentry on the new ConflictError.

Current refund branch:

```javascript
if (legacy.cc_type === 'Refund') {
  // Refund path — UPDATE + explicit revert-on-throw.
  await pool.query(
    `UPDATE legacy_cc_payments SET cc_event_id = $1 WHERE id = $2`,
    [targetCcId, legacyId]
  );
  try {
    promoteResult = await phase4.promoteSingleLegacyRefund(legacyId);
  } catch (err) {
    // Revert the cc_event_id assignment so the orphan stays on the worklist.
    try {
      await pool.query(
        `UPDATE legacy_cc_payments SET cc_event_id = NULL WHERE id = $1
            AND promoted_payment_id IS NULL AND promoted_refund_id IS NULL`,
        [legacyId]
      );
    } catch (revertErr) {
      reportException(req, revertErr, { step: 'cc_event_id_revert', legacyId });
    }
    reportException(req, err, { step: 'promote_single', legacyId });
    throw err;
  }
}
```

Replace with:

```javascript
if (legacy.cc_type === 'Refund') {
  // Refund path — UPDATE + explicit revert-on-throw. promoteSingleLegacyRefund
  // MUST own its own connection (Approach A; cannot share a txn). Add a status
  // check after the call so non-success non-throws still trigger the existing
  // revert catch block via re-throw.
  await pool.query(
    `UPDATE legacy_cc_payments SET cc_event_id = $1 WHERE id = $2`,
    [targetCcId, legacyId]
  );
  try {
    promoteResult = await phase4.promoteSingleLegacyRefund(legacyId);
    if (promoteResult.status !== 'promoted' && promoteResult.status !== 'already_promoted') {
      throw new ConflictError(
        `Promote failed: ${promoteResult.error || promoteResult.status}`,
        'CC_PROMOTE_FAILED'
      );
    }
  } catch (err) {
    // Revert the cc_event_id assignment so the orphan stays on the worklist.
    try {
      await pool.query(
        `UPDATE legacy_cc_payments SET cc_event_id = NULL WHERE id = $1
            AND promoted_payment_id IS NULL AND promoted_refund_id IS NULL`,
        [legacyId]
      );
    } catch (revertErr) {
      reportException(req, revertErr, { step: 'cc_event_id_revert', legacyId });
    }
    // ConflictError is the operator-visible failure — don't Sentry-spam on it.
    if (!(err instanceof ConflictError)) {
      reportException(req, err, { step: 'promote_single', legacyId });
    }
    throw err;
  }
}
```

- [ ] **Step 7: Confirm `ConflictError` is imported (no edit expected)**

```bash
grep -n "ConflictError" server/routes/admin/ccImport/review.js | head -3
```
Expected: line 38 already imports it via `const { ValidationError, NotFoundError, ConflictError } = require('../../../utils/errors');`. No edit needed; this is a sanity check.

- [ ] **Step 8: Run the errored-status test — verify it passes**

```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "rolls back cc_event_id"
```
Expected: PASS.

- [ ] **Step 9: Add the success-still-works regression test**

Append:

```javascript
test('POST /orphan-payment/:id/link still succeeds and persists cc_event_id on promoted status', async () => {
  // Regression guard: the refactor must not break the happy path. We use the
  // file's existing rawOp/orphanPaymentId fixture pattern if one is still
  // un-used at this point in the run; otherwise we mint fresh rows.
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES (NULL, 'confirmed', CURRENT_DATE + INTERVAL '60 days', 500, 0,
             'cc-fix2-ok-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;

  const rawIns = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
     VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
     RETURNING id`,
    [nextSrn(), nextHash('fix2-ok')]
  );
  const rawImportId = rawIns.rows[0].id;

  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_event_title, cc_type, paid_on, payment_applied_cents, raw_import_id)
     VALUES ('Fix2 Happy', 'Payment', CURRENT_DATE, 10000, $1)
     RETURNING id`,
    [rawImportId]
  );
  const legacyId = legacyRes.rows[0].id;

  try {
    const r = await req('POST', `/api/admin/cc-import/review/orphan-payment/${legacyId}/link`,
      adminToken, { proposal_id: proposalId, cc_event_id: proposalCcId });
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.ok, true);
    assert.equal(body.promote_status, 'promoted');

    const after = await pool.query(
      'SELECT cc_event_id, promoted_payment_id FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    assert.equal(after.rows[0].cc_event_id, proposalCcId);
    assert.notEqual(after.rows[0].promoted_payment_id, null);
  } finally {
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    await pool.query('DELETE FROM legacy_cc_raw_imports WHERE id = $1', [rawImportId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
});
```

> Not testing the `'orphan'` promote-status branch: in the new atomic-txn design we always SET cc_event_id BEFORE the promote, so `'orphan'` (the missing-anchor branch) is unreachable from this route. The `'errored'` test in Step 3 is the canonical non-success reproducer.

- [ ] **Step 10: Add a Sentry-not-called assertion (suggestion folded in)**

The Step 5 / Step 6 change explicitly does NOT call `reportException` when the thrown error is a `ConflictError` (operator-visible failure, not a code defect). Add a regression test so this stays true. Uses the same `mock.method(phase4, 'promoteSingleLegacyPayment', ...)` approach as Step 3 plus a second mock on `Sentry.captureException`.

Append:

```javascript
test('POST /orphan-payment/:id/link does NOT capture ConflictError to Sentry on non-success promote', async () => {
  // The point of the `if (!(err instanceof ConflictError))` guard around
  // reportException is that operator-visible failures (a bad row in the legacy_cc
  // queue) should NOT spam Sentry. Stub Sentry.captureException and assert it
  // was not called when the route 409s.
  const Sentry = require('@sentry/node');
  const phase4 = require('../../../../scripts/cc-import/phases/phase4');
  const { mock } = require('node:test');
  const promoteSpy = mock.method(phase4, 'promoteSingleLegacyPayment',
    async () => ({ status: 'errored', error: 'forced_for_test' }));
  const sentrySpy = mock.method(Sentry, 'captureException', () => {});

  const rawIns = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status)
     VALUES ('review-test', 'payments', $1, $2, '{}'::jsonb, 'pending')
     RETURNING id`,
    [nextSrn(), nextHash('fix2-sentry')]
  );
  const rawImportId = rawIns.rows[0].id;
  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_event_title, cc_type, paid_on, payment_applied_cents, raw_import_id)
     VALUES ('Fix2 Sentry', 'Payment', CURRENT_DATE, 10000, $1) RETURNING id`,
    [rawImportId]
  );
  const legacyId = legacyRes.rows[0].id;
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES (NULL, 'confirmed', CURRENT_DATE + INTERVAL '30 days', 500, 0,
             'cc-fix2-sentry-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;
  try {
    const r = await req('POST', `/api/admin/cc-import/review/orphan-payment/${legacyId}/link`,
      adminToken, { proposal_id: proposalId, cc_event_id: proposalCcId });
    assert.equal(r.status, 409);
    assert.equal(sentrySpy.mock.callCount(), 0, 'ConflictError must not be sent to Sentry');
  } finally {
    promoteSpy.mock.restore();
    sentrySpy.mock.restore();
    await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
    await pool.query('DELETE FROM legacy_cc_raw_imports WHERE id = $1', [rawImportId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
});
```

- [ ] **Step 11: Run the full file — verify all new tests pass**

```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | tail -10
```
Expected: `tests N, pass N, fail 0`.

- [ ] **Step 12: Delete the matching tech-debt entry**

Open `docs/tech-debt.md`. Find the entry `### CC-Import: orphan-payment link silently no-ops on non-success status` (around line 159). Delete the entire block.

- [ ] **Step 13: Commit**

```bash
git add server/routes/admin/ccImport/review.js server/routes/admin/ccImport/review.test.js docs/tech-debt.md
git commit -m "fix(cc-import): atomic-rollback orphan-payment link on non-success promote status"
```

**Checkpoint review.** This commit changes data-integrity (atomic-txn around a money-adjacent UPDATE). Run two review agents in parallel against the diff before moving to Task 3:

```bash
# from os integration window — agents read against worktree HEAD
# (database-review for the txn/rollback correctness; code-review for the
#  ConflictError + Sentry-skip pattern)
```

Launch `database-review` and `code-review` via the Agent tool. Wait for both to return clean (or flag) before Task 3.

---

## Task 3: Errored-row and skipped-event retry reclassifies by date

**Codex finding:** [P1] Two retry endpoints in `review.js` hardcode `phase3.promoteBucketA` regardless of the row's effective bucket:
- Line 820: `/errored-row/:row_id/retry`
- Line 930: `/skipped-event/:row_id/promote`

For both, if the underlying row is a past-dated event (would classify as Bucket B), forcing Bucket A creates a `confirmed` proposal with a past event_date and enrolls in auto-comms — the scheduler would then send "your event is next week!" emails for an event that already happened.

The duplicate-promote retry (line 286) is **out of scope** — that endpoint is for dedup-suspect rows where the operator has already confirmed the row is NOT a duplicate. The classification was correct at first run; bypassing dedup keeps the same classification.

**Approach:** Reclassify by `event_date`. Past-dated rows route to `promoteBucketB` (writes to `proposals` with `status='completed'` + completed shifts + NO auto-comms enrollment). Future-dated rows continue to `promoteBucketA`. Bucket C and D archive paths are not single-row-callable on retry — the operator explicitly chose to promote — so they degrade to A with the audit log carrying the original bucket letter.

**Files:**
- Modify: `server/routes/admin/ccImport/review.js:820, 930` (the two flagged retry sites + audit-log metadata)
- Modify: `scripts/cc-import/phases/phase3.js` — export `classifyForRetry(payload, today)`
- Test: `server/routes/admin/ccImport/review.test.js` (add 2 cases — past-dated retry → B; future-dated retry → A)
- Modify: `docs/tech-debt.md` (delete the matching entry in the same commit)

- [ ] **Step 1: Confirm the existing `classify()` signature**

```bash
cat scripts/cc-import/lib/buckets.js
```
Expected:
```javascript
function classify({ status, eventDate, packageName }, today) {
  if (status === 'Confirmed' && isSkippedPackage(packageName)) return 'D';
  if (status !== 'Confirmed') return 'C';
  if (!eventDate) return 'C';
  return eventDate >= today ? 'A' : 'B';
}
```

- [ ] **Step 2: Confirm `phase3.buildRowContext(row)` exists and exports the right keys**

Already verified at `scripts/cc-import/phases/phase3.js:160-200`. `buildRowContext(row)` returns a `ctx` object with `status`, `eventDate`, `packageName`, `ccId`, etc. — the keys `classify` consumes. The CSV column names it reads internally are `'Status'`, `'Package Name'`, `'Event Date'`, `'ID'` (NOT `'Event Status'`/`'Package'`/`'Event Id'`). The new `classifyForRetry` reuses `buildRowContext` instead of re-implementing the extraction — keeps a single source of truth for CSV column names.

`buildRowContext` is currently module-local. Step 3 adds it to the exports.

- [ ] **Step 3: Write the failing test (past-dated skipped-event retry → Bucket B)**

`phase3.promoteBucketA._promote` calls `resolveClientId(client, ctx)` at `scripts/cc-import/phases/phase3.js:469-472` and returns `{ status: 'errored', error: 'client_not_found_for_email_or_missing' }` when the row has no email match. The test must seed a `clients` row first AND include `'Contact Email(s)'` in the payload so the row resolves to that client and the date-classification fix actually runs.

Append to `server/routes/admin/ccImport/review.test.js`:

```javascript
test('POST /skipped-event/:row_id/promote past-dated event lands in Bucket B (completed, no auto-comms)', async () => {
  // Seed a clients row first so phase3's resolveClientId finds a match.
  const clientEmail = `fix3-past-${Date.now()}@example.com`;
  const clientIns = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Past Event Test', $1, '555-0100') RETURNING id`,
    [clientEmail]
  );
  const seededClientId = clientIns.rows[0].id;

  // Seed a 'skipped' raw row whose payload is a Confirmed PAST event. Column
  // names must match what phase3.buildRowContext reads: 'Status', 'Package Name',
  // 'Event Date', 'ID', 'Contact Email(s)'.
  const payload = {
    'Status': 'Confirmed',
    'Event Date': '2024-01-15',  // far past
    'Package Name': 'Bartending Services',  // a skip-list package
    'Client Name': 'Past Event Test',
    'Contact Email(s)': clientEmail,
    'ID': 'cc-fix3-past-' + Date.now(),
  };
  const rawRes = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status, cc_id)
     VALUES ('report (10).csv', 'events', $1, $2,
             $3::jsonb, 'skipped', $4)
     RETURNING id`,
    [nextSrn(), nextHash('fix3-past'), JSON.stringify(payload), payload['ID']]
  );
  const rowId = rawRes.rows[0].id;
  let proposalId = null;

  try {
    const r = await req('POST', `/api/admin/cc-import/review/skipped-event/${rowId}/promote`, adminToken, {});
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(body.proposal_id, 'expected a proposal_id in the response');
    proposalId = body.proposal_id;

    const propRow = await pool.query('SELECT status FROM proposals WHERE id = $1', [proposalId]);
    assert.equal(propRow.rows[0].status, 'completed');

    const shiftRow = await pool.query('SELECT status FROM shifts WHERE proposal_id = $1', [proposalId]);
    if (shiftRow.rowCount > 0) {
      assert.equal(shiftRow.rows[0].status, 'completed');
    }

    const smCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM scheduled_messages
         WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
      [proposalId]
    );
    assert.equal(smCount.rows[0].c, 0, 'past-dated retry must not enroll in auto-comms');
  } finally {
    if (proposalId) {
      await pool.query("DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id = $1", [proposalId]);
      await pool.query("DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = $1)", [proposalId]);
      await pool.query("DELETE FROM shifts WHERE proposal_id = $1", [proposalId]);
      await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id = $1", [proposalId]);
      await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
    }
    await pool.query("DELETE FROM legacy_cc_raw_imports WHERE id = $1", [rowId]);
    await pool.query("DELETE FROM clients WHERE id = $1", [seededClientId]);
  }
});
```

- [ ] **Step 4: Run the test — verify it fails**

```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "past-dated event lands"
```
Expected: FAIL — current code routes to Bucket A so `proposals.status='confirmed'`.

- [ ] **Step 5: Add `classifyForRetry` to phase3.js**

In `scripts/cc-import/phases/phase3.js`, add this near the `promoteBucketA`/`promoteBucketB` definitions (around line 436):

```javascript
/**
 * Used by the cc-import Review page's retry endpoints (/errored-row/:id/retry,
 * /skipped-event/:id/promote). Reuses buildRowContext to extract the same
 * fields the initial-pass dispatch uses, runs classify(), and returns the
 * matching promote function reference plus the genuine bucket letter.
 *
 * Bucket A (future + Confirmed) → promoteBucketA.
 * Bucket B (past + Confirmed)   → promoteBucketB.
 * Bucket C / D                  → degrade to promoteBucketA. C/D archive paths
 *   are not single-row callable, and the operator's retry click means "make
 *   this active." The `bucket` field still carries 'C' or 'D' so the audit log
 *   records the genuine classification (useful for back-tracing intent).
 */
function classifyForRetry(payload, today = new Date()) {
  const ctx = buildRowContext(payload);
  const bucket = classify(
    { status: ctx.status, eventDate: ctx.eventDate, packageName: ctx.packageName },
    today
  );
  if (bucket === 'B') return { bucket: 'B', promote: promoteBucketB };
  // A, C, D — all degrade to promoteBucketA on operator retry. `bucket` retains
  // the genuine letter for audit clarity.
  return { bucket, promote: promoteBucketA };
}
```

Then update the `module.exports` block at the bottom of `phase3.js`. Current state at `phase3.js:841-851` (verified):

```javascript
module.exports = {
  run,
  promoteBucketA,
  promoteBucketB,
  // Internals re-exported for unit tests.
  parseAddons,
  parseBookedAt,
  computeBalanceDueDateA,
  buildPricingSnapshot,
  buildRowContext,
};
```

`buildRowContext` is ALREADY exported. Add a single line for `classifyForRetry`:

```javascript
module.exports = {
  run,
  promoteBucketA,
  promoteBucketB,
  classifyForRetry,
  // Internals re-exported for unit tests.
  parseAddons,
  parseBookedAt,
  computeBalanceDueDateA,
  buildPricingSnapshot,
  buildRowContext,
};
```

Run after the edit:
```bash
grep -n "classifyForRetry" scripts/cc-import/phases/phase3.js
```
Expected: 2 matches — the function definition and the exports line.

- [ ] **Step 6: Update the skipped-event retry endpoint (review.js:919-933) and its audit log**

Find:

```javascript
const result = await phase3.promoteBucketA(guard.rows[0].payload, { skipDedup: true });
if (result.status !== 'promoted' && result.status !== 'already_promoted') {
  throw new ConflictError(`Promote failed: ${result.error || result.status}`, 'CC_PROMOTE_FAILED');
}

await pool.query(
  `UPDATE legacy_cc_raw_imports
      SET import_status = 'promoted',
          import_notes = $2::jsonb
    WHERE id = $1`,
  [rowId, JSON.stringify({
    promoted_by_user_id: req.user.id,
    promoted_at: new Date().toISOString(),
    proposal_id: result.proposalId || null,
    skip_rule_bypassed: true,
  })]
);

await logAdminAction({
  actorUserId: req.user.id,
  targetUserId: null,
  action: 'cc_review_skipped_event_promoted',
  metadata: { row_id: rowId, proposal_id: result.proposalId || null },
});
```

Replace with:

```javascript
// Reclassify by status + event_date so a past-dated event lands in Bucket B
// (completed, no auto-comms enrollment) instead of being force-promoted as
// Bucket A and scheduling stale reminders. classifyForRetry mirrors the
// initial phase 3 pass via buildRowContext + classify.
const { bucket, promote } = phase3.classifyForRetry(guard.rows[0].payload);
const result = await promote(guard.rows[0].payload, { skipDedup: true });
if (result.status !== 'promoted' && result.status !== 'already_promoted') {
  throw new ConflictError(`Promote failed: ${result.error || result.status}`, 'CC_PROMOTE_FAILED');
}

await pool.query(
  `UPDATE legacy_cc_raw_imports
      SET import_status = 'promoted',
          import_notes = $2::jsonb
    WHERE id = $1`,
  [rowId, JSON.stringify({
    promoted_by_user_id: req.user.id,
    promoted_at: new Date().toISOString(),
    proposal_id: result.proposalId || null,
    skip_rule_bypassed: true,
    retry_bucket: bucket,
  })]
);

await logAdminAction({
  actorUserId: req.user.id,
  targetUserId: null,
  action: 'cc_review_skipped_event_promoted',
  metadata: { row_id: rowId, proposal_id: result.proposalId || null, retry_bucket: bucket },
});
```

- [ ] **Step 7: Run the failing test — verify it now passes**

```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "past-dated event lands"
```
Expected: PASS.

- [ ] **Step 8: Update the errored-row retry endpoint (review.js:820) and its audit log**

Find:

```javascript
const r = await phase3.promoteBucketA(workingPayload, { skipDedup: false });
retryResult = r;
retryStatus = r.status;
```

Replace with:

```javascript
const { bucket: retryBucket, promote } = phase3.classifyForRetry(workingPayload);
const r = await promote(workingPayload, { skipDedup: false });
retryResult = r;
retryStatus = r.status;
```

Then update the audit-log block at `review.js:884-894`:

```javascript
await logAdminAction({
  actorUserId: req.user.id,
  targetUserId: null,
  action: 'cc_review_errored_row_retried',
  metadata: {
    row_id: rowId,
    source_entity: sourceEntity,
    payload_overridden: !!payloadOverride,
    result_status: retryStatus,
    retry_bucket: retryBucket,
  },
});
```

(`retryBucket` is `undefined` on the `'payments'` and other `source_entity` branches that don't call `classifyForRetry` — JSON serialization drops undefined keys, so the metadata stays clean.)

- [ ] **Step 9: Add the parallel errored-row retry test (past-dated → B)**

Same `clients`-seed pattern as Step 3 so `resolveClientId` resolves cleanly and the date-classification code path actually runs.

Append:

```javascript
test('POST /errored-row/:row_id/retry past-dated event lands in Bucket B', async () => {
  const clientEmail = `fix3-err-${Date.now()}@example.com`;
  const clientIns = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Past Errored Test', $1, '555-0101') RETURNING id`,
    [clientEmail]
  );
  const seededClientId = clientIns.rows[0].id;

  const payload = {
    'Status': 'Confirmed',
    'Event Date': '2023-12-01',
    'Package Name': 'Open Bar',  // not a skip-list package
    'Client Name': 'Past Errored Test',
    'Contact Email(s)': clientEmail,
    'ID': 'cc-fix3-err-past-' + Date.now(),
  };
  const rawRes = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status, cc_id, import_notes)
     VALUES ('report (10).csv', 'events', $1, $2,
             $3::jsonb, 'errored', $4, $5::jsonb)
     RETURNING id`,
    [nextSrn(), nextHash('fix3-err'), JSON.stringify(payload), payload['ID'],
     JSON.stringify({ error: 'simulated for test', phase: 'phase3' })]
  );
  const rowId = rawRes.rows[0].id;
  let proposalId = null;

  try {
    const r = await req('POST', `/api/admin/cc-import/review/errored-row/${rowId}/retry`, adminToken, {});
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(body.result?.proposalId);
    proposalId = body.result.proposalId;

    const propRow = await pool.query('SELECT status FROM proposals WHERE id = $1', [proposalId]);
    assert.equal(propRow.rows[0].status, 'completed');
  } finally {
    if (proposalId) {
      await pool.query("DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = $1)", [proposalId]);
      await pool.query("DELETE FROM shifts WHERE proposal_id = $1", [proposalId]);
      await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id = $1", [proposalId]);
      await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
    }
    await pool.query("DELETE FROM legacy_cc_raw_imports WHERE id = $1", [rowId]);
    await pool.query("DELETE FROM clients WHERE id = $1", [seededClientId]);
  }
});
```

- [ ] **Step 10: Run the full file — verify all tests pass**

```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | tail -10
```
Expected: `tests N, pass N, fail 0`.

- [ ] **Step 11: Delete the matching tech-debt entry**

Open `docs/tech-debt.md`. Find `### CC-Import: \`promoteBucketA\` hardcodes Bucket A on errored-row + skipped-event retry` (around line 173). Delete the entire block.

- [ ] **Step 12: Commit**

```bash
git add server/routes/admin/ccImport/review.js server/routes/admin/ccImport/review.test.js scripts/cc-import/phases/phase3.js docs/tech-debt.md
git commit -m "fix(cc-import): errored-row + skipped-event retry reclassifies by date"
```

---

## Task 4: payrollLateTip + clawbackTip filter stubs from split

**Codex finding:** [P1] Both `rollForwardLateTip` (`server/utils/payrollLateTip.js:36-49`) and `clawbackTip` (`server/utils/payrollClawback.js:32-45`) early-return on `isLegacyCcStubUser(tip.target_user_id)`. After that, they split the money across ALL approved bartenders on `tip.shift_id`. On a mixed shift (stub + real bartender, possible after operator linked a real user via `/review/unmatched-payee/.../link`), a tip whose `target_user_id` resolves to the stub now skips entirely — the real bartender on the same shift gets nothing from a tip, and a later refund won't claw their share back.

**Approach:** Replace the target-user gate with a **per-bartender-split filter**. Stubs are excluded from the denominator. If ALL bartenders on the shift are stubs, the entire rollforward/clawback is skipped under a new reason string (`'all_bartenders_are_legacy_cc_stubs'`).

**Critical test-rewrite caveat.** The existing `'skips when target is a legacy CC stub'` tests in both `payrollLateTip.test.js:143` and `payrollClawback.test.js:142` set `tips.target_user_id = stubId` but DO NOT add the stub to `shift_requests` for the test shift. The `beforeEach` block puts `bartenderA + bartenderB` (both real) on the shift. Under the new logic those tests would land the tip on the two real bartenders (correct new behavior) and the old assertion `result = { skipped: true, reason: 'legacy_cc_stub_target' }` would fail. The existing tests are testing the OLD gate, which is being REMOVED — they cannot be saved by a reason-string rename. They must be **deleted and replaced** with tests that genuinely exercise the new behavior:

1. **Mixed-shift test** (NEW): one stub + one real bartender on a FRESH shift (NOT `frozenShiftId`/`paidShiftId` — those already have 2 real bartenders from `beforeEach`). Assert the real bartender gets the full tip.
2. **All-stubs test** (REPLACES the old target-stub test): a FRESH shift with stub-only bartenders, tip targeted at a stub. Assert the new reason string fires and no payouts are created.

`clawbackTipByPaymentIntent > inherits the legacy-stub skip` (`payrollClawback.test.js:179`) has the same problem and gets the same treatment — delete it and add a parallel all-stubs test under the new gate name.

**Files:**
- Modify: `server/utils/payrollLateTip.js:36-65` (remove target-user gate; add per-bartender filter + all-stubs guard)
- Modify: `server/utils/payrollClawback.js:32-73` (same pattern)
- Modify: `server/utils/payrollLateTip.test.js` (DELETE the old target-stub test; ADD mixed-shift + all-stubs tests)
- Modify: `server/utils/payrollClawback.test.js` (same)
- Modify: `docs/tech-debt.md` (delete the matching entry in the same commit)

- [ ] **Step 1: Read the existing target-stub tests in both files**

```bash
sed -n '143,178p' server/utils/payrollLateTip.test.js
sed -n '142,213p' server/utils/payrollClawback.test.js
```
Confirm: each test (a) creates a fresh stub user, (b) inserts a tip with `target_user_id = stubId`, (c) does NOT touch `shift_requests` for the test shift. The shift retains `bartenderA + bartenderB` from `beforeEach`. These tests will be deleted.

Confirm fixture variable names: `payrollLateTip.test.js` uses `frozenShiftId`; `payrollClawback.test.js` uses `paidShiftId` (NOT `openShiftId`). All new test snippets in this task use those names where they reference the file's existing fixtures.

- [ ] **Step 2: Confirm no external callers switch on the old reason string**

```bash
grep -rn "legacy_cc_stub_target" --include="*.js" .
```
Expected: 4 matches total — `payrollLateTip.js`, `payrollClawback.js`, `payrollLateTip.test.js`, `payrollClawback.test.js`. No callers in routes, schedulers, or webhooks. Rename is safe.

- [ ] **Step 3: Write the failing mixed-shift test for rollForwardLateTip**

Append to `server/utils/payrollLateTip.test.js` (BEFORE the existing target-stub test at line 143, which we'll delete in Step 6):

```javascript
test('rollForwardLateTip > mixed-stub shift: real bartender gets the whole tip, stubs filtered out', async () => {
  // FRESH shift — beforeEach already populated frozenShiftId with bartenderA + bartenderB,
  // so we cannot reuse it for a mixed-stub test. New shift, new proposal, new pay_period
  // membership (it's in the same frozen period for the original-shift label, but we add
  // shift_requests just for our two users).
  const stub = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('mixed-stub@example.com','x','staff','legacy_cc:test:mixed-stub')
     RETURNING id`
  );
  const stubId = stub.rows[0].id;
  const real = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('mixed-real@example.com','x','staff')
     RETURNING id`
  );
  const realId = real.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [realId]
  );

  // Fresh shift on the same frozen proposal (different shift id so we don't
  // collide with beforeEach's frozenShiftId).
  const mixedShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','7:00 PM','open',$1) RETURNING id`,
    [frozenProposalId]
  );
  const mixedShiftId = mixedShift.rows[0].id;

  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')`,
    [mixedShiftId, stubId, realId]
  );

  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_mixed_late_tip', '2026-05-15 23:30:00+00', $2)
     RETURNING id`,
    [stubId, mixedShiftId]
  );
  const mixedTipId = tipRes.rows[0].id;

  try {
    const result = await rollForwardLateTip(mixedTipId);
    assert.notEqual(result?.skipped, true);
    assert.equal(result.bartenders, 1, 'only the real bartender takes the split');

    const realEvent = await pool.query(
      `SELECT pe.card_tip_gross_cents, pe.card_tip_fee_cents, pe.card_tip_net_cents
         FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1 AND pe.shift_id = $2`,
      [realId, mixedShiftId]
    );
    assert.equal(realEvent.rowCount, 1);
    assert.equal(Number(realEvent.rows[0].card_tip_gross_cents), 4000);
    assert.equal(Number(realEvent.rows[0].card_tip_fee_cents), 128);
    assert.equal(Number(realEvent.rows[0].card_tip_net_cents), 3872);

    const stubEvent = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1`,
      [stubId]
    );
    assert.equal(stubEvent.rows[0].c, 0);
  } finally {
    await pool.query(
      `DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))`,
      [stubId, realId]
    );
    await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)', [stubId, realId]);
    await pool.query('DELETE FROM tips WHERE id = $1', [mixedTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [mixedShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [mixedShiftId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [realId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubId, realId]);
  }
});
```

- [ ] **Step 4: Run the test — verify it fails**

```bash
node --test server/utils/payrollLateTip.test.js 2>&1 | grep -A 4 "mixed-stub shift"
```
Expected: FAIL — current code skips on the target-stub gate, so `result.skipped === true`.

- [ ] **Step 5: Apply the fix to payrollLateTip.js**

Find lines 36-65 (the target-stub gate + the bartender query block + the no-bartenders branch). Replace the whole block with:

```javascript
    // Bartenders on the original shift. Stub users (cc_id LIKE 'legacy_cc:%')
    // are filtered out of the per-bartender split — they can't be paid through
    // Stripe Connect, so they receive no share. If ALL bartenders are stubs,
    // the entire rollforward is skipped (renamed reason).
    const bartendersRes = await client.query(
      `SELECT sr.user_id, (u.cc_id LIKE 'legacy_cc:%') AS is_stub
         FROM shift_requests sr
         JOIN users u ON u.id = sr.user_id
        WHERE sr.shift_id = $1 AND sr.status = 'approved'
          AND LOWER(sr.position) = 'bartender'
        ORDER BY sr.user_id`,
      [tip.shift_id]
    );
    const allBartenders = bartendersRes.rows;
    const bartenders = allBartenders.filter(r => !r.is_stub).map(r => r.user_id);
    const stubCount = allBartenders.length - bartenders.length;

    if (allBartenders.length === 0) {
      // No bartenders at all — permanent: mark rolled so we don't retry forever.
      await client.query('UPDATE tips SET rolled_forward_at = NOW() WHERE id = $1', [tipId]);
      await client.query('COMMIT');
      return { bartenders: 0 };
    }

    if (bartenders.length === 0) {
      // All shift bartenders are stubs — recoverable: leave rolled_forward_at NULL
      // so a future de-stub can replay.
      Sentry.captureMessage('rollForwardLateTip: all shift bartenders are legacy_cc stubs; skipping', {
        level: 'info',
        tags: { util: 'payrollLateTip', step: 'skip_all_stubs' },
        extra: { tipId, shiftId: tip.shift_id, stubCount },
      });
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' };
    }
```

(Note the explicit asymmetry: "no bartenders ever" sets `rolled_forward_at = NOW()` and commits — permanent; "all stubs" rolls back and leaves NULL — recoverable.)

The downstream `const n = bartenders.length;` and the rest of the file stays unchanged — `bartenders` is now the filtered list. Also delete the `isLegacyCcStubUser` import if it's no longer used (grep first).

```bash
grep -n "isLegacyCcStubUser" server/utils/payrollLateTip.js
```
If zero matches after the fix, also remove `isLegacyCcStubUser` from the `require('./payrollGuards')` line at the top. (Keep `payrollClawback.js`'s import — it's still imported there until Step 8.)

- [ ] **Step 6: Run the mixed-shift test — verify it passes; delete the old target-stub test**

```bash
node --test server/utils/payrollLateTip.test.js 2>&1 | grep -A 4 "mixed-stub shift"
```
Expected: PASS.

Then DELETE the test block at lines 143-178 (the `'rollForwardLateTip > skips and returns structured shape when target is a legacy CC stub'` test). The gate it was testing has been removed.

- [ ] **Step 7: Add an all-stubs test (replaces what the deleted test was supposed to cover)**

Append to `payrollLateTip.test.js`:

```javascript
test('rollForwardLateTip > skips with all_bartenders_are_legacy_cc_stubs when every shift bartender is a stub', async () => {
  // Fresh shift with stub-only roster.
  const stubA = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('all-stub-a@example.com','x','staff','legacy_cc:test:all-a')
     RETURNING id`
  );
  const stubB = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('all-stub-b@example.com','x','staff','legacy_cc:test:all-b')
     RETURNING id`
  );
  const stubAId = stubA.rows[0].id;
  const stubBId = stubB.rows[0].id;

  const allStubShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','8:00 PM','open',$1) RETURNING id`,
    [frozenProposalId]
  );
  const allStubShiftId = allStubShift.rows[0].id;

  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')`,
    [allStubShiftId, stubAId, stubBId]
  );

  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 3000, 96, 'pi_all_stub_late', '2026-05-15 23:30:00+00', $2)
     RETURNING id`,
    [stubAId, allStubShiftId]
  );
  const allStubTipId = tipRes.rows[0].id;

  try {
    const result = await rollForwardLateTip(allStubTipId);
    assert.deepEqual(result, { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' });

    const noPayout = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events WHERE payout_id IN
         (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))`,
      [stubAId, stubBId]
    );
    assert.equal(noPayout.rows[0].c, 0);

    const tip = await pool.query('SELECT rolled_forward_at FROM tips WHERE id = $1', [allStubTipId]);
    assert.equal(tip.rows[0].rolled_forward_at, null, 'recoverable: stays NULL so a future de-stub can replay');
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [allStubTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [allStubShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [allStubShiftId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubAId, stubBId]);
  }
});
```

Run the full file:

```bash
node --test server/utils/payrollLateTip.test.js 2>&1 | tail -10
```
Expected: `tests N, pass N, fail 0`.

- [ ] **Step 8: Apply the parallel fix to payrollClawback.js**

In `server/utils/payrollClawback.js`, find lines 32-73 (the target-stub gate at 32-45 + the no-shift-id guard at 55-59 + the bartender query + no-bartenders branch at 61-73). Replace the target-stub gate block and the bartender section with:

```javascript
    // (The `if (!tip.shift_id)` block at lines 55-59 stays unchanged.)

    const bartendersRes = await client.query(
      `SELECT sr.user_id, (u.cc_id LIKE 'legacy_cc:%') AS is_stub
         FROM shift_requests sr
         JOIN users u ON u.id = sr.user_id
        WHERE sr.shift_id = $1 AND sr.status = 'approved'
          AND LOWER(sr.position) = 'bartender'
        ORDER BY sr.user_id`,
      [tip.shift_id]
    );
    const allBartenders = bartendersRes.rows;
    const bartenders = allBartenders.filter(r => !r.is_stub).map(r => r.user_id);
    const stubCount = allBartenders.length - bartenders.length;

    if (allBartenders.length === 0) {
      // No bartenders to claw from — track the new cumulative and exit.
      await client.query('UPDATE tips SET refunded_amount_cents = $1 WHERE id = $2', [newAmt, tipId]);
      await client.query('COMMIT');
      return { delta, bartenders: 0 };
    }

    if (bartenders.length === 0) {
      // All shift bartenders are stubs — recoverable: do NOT advance refunded_amount_cents
      // so a future de-stub can replay.
      Sentry.captureMessage('clawbackTip: all shift bartenders are legacy_cc stubs; skipping', {
        level: 'info',
        tags: { util: 'payrollClawback', step: 'skip_all_stubs' },
        extra: { tipId, shiftId: tip.shift_id, stubCount },
      });
      await client.query('ROLLBACK');
      return { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' };
    }
```

Delete the original lines 32-45 (the `if (await isLegacyCcStubUser(...))` block) entirely.

The downstream per-bartender split loop (lines 113-146) uses `bartenders.length` — now the filtered count — so it splits across reals only. No other changes needed below.

Grep to confirm `isLegacyCcStubUser` is no longer used:

```bash
grep -n "isLegacyCcStubUser" server/utils/payrollClawback.js
```
If zero matches, drop it from the `require('./payrollGuards')` line at the top.

- [ ] **Step 9: Add a failing mixed-shift test for clawbackTip**

Append to `server/utils/payrollClawback.test.js`:

```javascript
test('clawbackTip > mixed-stub shift: claws back from real bartender only, stubs filtered out', async () => {
  const stub = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('cb-mixed-stub@example.com','x','staff','legacy_cc:test:cb-mixed')
     RETURNING id`
  );
  const stubId = stub.rows[0].id;
  const real = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('cb-mixed-real@example.com','x','staff') RETURNING id`
  );
  const realId = real.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
     ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
    [realId]
  );

  // Fresh shift on the same paid proposal (different shift id so we don't
  // collide with beforeEach's paidShiftId roster).
  const mixedShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','7:00 PM','open',$1) RETURNING id`,
    [paidProposalId]
  );
  const mixedShiftId = mixedShift.rows[0].id;

  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')`,
    [mixedShiftId, stubId, realId]
  );

  // Tip already paid (rolled_forward_at set so the system thinks the late-tip
  // pipeline already ran). Seed a payout_event for the real bartender so there's
  // something to claw back FROM.
  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, rolled_forward_at, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_cb_mixed', NOW() - INTERVAL '1 day', $2, NOW(), 0)
     RETURNING id`,
    [stubId, mixedShiftId]
  );
  const cbTipId = tipRes.rows[0].id;

  // Seed the real bartender's payout_event (what rollForwardLateTip on a mixed
  // shift would have created via the new code path).
  await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id)
     VALUES ((SELECT id FROM pay_periods WHERE status='open' AND CURRENT_DATE BETWEEN start_date AND end_date), $1)
     ON CONFLICT (pay_period_id, contractor_id) DO NOTHING`,
    [realId]
  );
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
                                card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents, line_total_cents)
     SELECT id, $2, 0, 0, 0, 0, 4000, 128, 3872, 3872
       FROM payouts WHERE contractor_id = $1
     ON CONFLICT (payout_id, shift_id) DO NOTHING`,
    [realId, mixedShiftId]
  );

  try {
    const result = await clawbackTip(cbTipId, 4000);
    assert.notEqual(result?.skipped, true);
    assert.equal(result.bartenders, 1);

    const adj = await pool.query(
      `SELECT adjustment_cents FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1 AND pe.shift_id = $2`,
      [realId, mixedShiftId]
    );
    assert.equal(Number(adj.rows[0].adjustment_cents), -3872);  // net delta, not gross
  } finally {
    await pool.query('DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))',
      [stubId, realId]);
    await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)', [stubId, realId]);
    await pool.query('DELETE FROM tips WHERE id = $1', [cbTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [mixedShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [mixedShiftId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [realId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubId, realId]);
  }
});
```

- [ ] **Step 10: Delete the old target-stub clawback tests**

Both `clawbackTip > skips and returns structured shape when target is a legacy CC stub` (line 142) AND `clawbackTipByPaymentIntent > inherits the legacy-stub skip from clawbackTip` (line 179) test the OLD gate. Delete both blocks.

- [ ] **Step 11: Add an all-stubs clawback test**

Append:

```javascript
test('clawbackTip > skips with all_bartenders_are_legacy_cc_stubs when every shift bartender is a stub', async () => {
  const stubA = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('cb-all-stub-a@example.com','x','staff','legacy_cc:test:cb-all-a')
     RETURNING id`
  );
  const stubB = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('cb-all-stub-b@example.com','x','staff','legacy_cc:test:cb-all-b')
     RETURNING id`
  );
  const stubAId = stubA.rows[0].id;
  const stubBId = stubB.rows[0].id;

  const allStubShift = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','8:00 PM','open',$1) RETURNING id`,
    [paidProposalId]
  );
  const allStubShiftId = allStubShift.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')`,
    [allStubShiftId, stubAId, stubBId]
  );

  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_all_stub_cb', NOW() - INTERVAL '1 day', $2, 0)
     RETURNING id`,
    [stubAId, allStubShiftId]
  );
  const allStubTipId = tipRes.rows[0].id;

  try {
    const result = await clawbackTip(allStubTipId, 2500);
    assert.deepEqual(result, { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' });

    // Recoverable: refunded_amount_cents stays at 0.
    const tipAfter = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [allStubTipId]);
    assert.equal(Number(tipAfter.rows[0].refunded_amount_cents), 0);
  } finally {
    await pool.query('DELETE FROM tips WHERE id = $1', [allStubTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [allStubShiftId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [allStubShiftId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubAId, stubBId]);
  }
});
```

> `clawbackTipByPaymentIntent` does NOT get a dedicated all-stubs test — it's a thin wrapper that calls `clawbackTip` and inherits its behavior. The all-stubs test above proves the inner function's behavior; the wrapper is exercised by the existing happy-path tests at lines 94-140. If a future refactor splits the wrapper, add a dedicated test then.

- [ ] **Step 12: Run both payroll test files — verify everything passes**

```bash
node --test server/utils/payrollLateTip.test.js server/utils/payrollClawback.test.js 2>&1 | tail -15
```
Expected: `tests N, pass N, fail 0`.

- [ ] **Step 13: Run the broader payroll suite for regression**

```bash
node --test server/utils/payrollLateTip.test.js server/utils/payrollClawback.test.js server/utils/payrollAccrual.test.js server/utils/payrollGuards.test.js 2>&1 | tail -10
```
Expected: all pass. (`payrollAccrual.test.js` requires the dev DB `pay_periods` row #783 to be `'open'` — the prerequisite at the top of this plan.)

- [ ] **Step 14: Delete the matching tech-debt entry**

Open `docs/tech-debt.md`. Find `### CC-Import: \`payrollLateTip\` / \`clawbackTip\` stub gate fires on target` (around line 180). Delete the entire block.

- [ ] **Step 15: Commit**

```bash
git add server/utils/payrollLateTip.js server/utils/payrollLateTip.test.js server/utils/payrollClawback.js server/utils/payrollClawback.test.js docs/tech-debt.md
git commit -m "fix(payroll): mixed-stub shifts route the tip to real bartenders instead of skipping"
```

**Checkpoint review.** This commit is a money-path math change with cross-cutting tip-handling implications. Run two review agents in parallel against the diff before pre-merge:

- `code-review` — verifies the per-bartender split denominator change and the asymmetric "all stubs" vs "no bartenders" handling.
- `consistency-check` — verifies the `'all_bartenders_are_legacy_cc_stubs'` reason string is identical across all 4 files, and that no caller still switches on `'legacy_cc_stub_target'`.

---

## Pre-merge verification

Before merging `codex-followups` back to `main`:

- [ ] **Step 1: Confirm the branch's commit list**

```bash
git log --oneline main..HEAD
```
Expected: 4 fix commits (Tasks 1-4) in order. NO standalone Task 5 commit — the tech-debt deletions are absorbed into each fix.

- [ ] **Step 2: Run the full impacted-tests set**

```bash
node --test \
  server/routes/admin/ccImport/review.test.js \
  server/utils/payrollLateTip.test.js \
  server/utils/payrollClawback.test.js \
  server/utils/payrollAccrual.test.js \
  server/utils/payrollGuards.test.js \
  2>&1 | tail -10
```
Expected: all pass.

- [ ] **Step 3: File-size ratchet — binding constraint, check carefully**

```bash
npm run check:filesize
```

`review.js` is at 962 lines on `HEAD`. Task 2 adds ~20 lines and Task 3 adds ~5 lines — combined ~987 lines, under the 1000-line hard cap but ON the edge. The ratchet RED-blocks any future commit that grows this file further until something is extracted. Expected report state:

- `review.js`: YELLOW (~987 / 1000) — over the 700 soft cap; "plan a split"
- `phase3.js`: YELLOW (~860 / 1000)

If either file exceeds 1000 lines, the commit RED-blocks and you must extract before merging. Do NOT bypass with `--no-verify`.

After merge, queue a tech-debt entry to extract `review.js` (per-concern split mirroring `proposals/` — `orphans.js`, `errored.js`, `skipped.js`, `unmatched.js`). The current ~987 lines on this branch leave essentially no headroom; the next codex-followups-style batch will RED-block on the first growing commit. Out of scope for this branch.

- [ ] **Step 4: Verify the matching tech-debt entries are gone**

```bash
grep -c "### CC-Import" docs/tech-debt.md
```
Expected: `0`. The four CC-Import entries were deleted across Tasks 1-4 commits.

```bash
grep -n "^### " docs/tech-debt.md | grep -i "metricsQueries"
```
Expected: 1 match — the `### metricsQueries include_cc filter join lacks composite index` entry is preserved (it's a real follow-up, not codex-followups scope).

- [ ] **Step 5: Wait for explicit user cue before merging**

Per CLAUDE.md Rule 4 + Rule 11: do NOT auto-merge. The merge is a hard-to-reverse operation that consolidates 4 commits onto `main`. State to the user: *"All 4 fixes green, ratchet passes, tech-debt entries removed. Ready to merge `codex-followups` into `main`?"* and wait.

- [ ] **Step 6: On explicit yes, switch to `os` and merge**

From the `os` folder (NOT the worktree):
```bash
git merge codex-followups
```
Expected: fast-forward merge (no conflicts — `codex-followups` branched from `main` and no parallel work touched these files).

- [ ] **Step 7: Clean up the worktree**

```bash
npm run worktree:rm -- codex-followups
```

- [ ] **Step 8: Push only on explicit user cue (per CLAUDE.md Rule 4)**

Do NOT auto-push. Wait for the user to issue a push cue. When they do, the 0.5-step confirmation gate fires the pre-push agent fleet on the batched commits (4 from `codex-followups` + the pre-existing unpushed `af947bb` doc-queue commit).

---

## Self-review notes

**Spec coverage:** All 4 codex findings have dedicated tasks (1: P2 suppress, 2: P1 atomic-rollback, 3: P1 reclassify-by-date, 4: P1 mixed-stub split). The `docs/tech-debt.md` cleanup is dispersed across the 4 fix commits so the file stays consistent with `main` at every sha — no standalone Task 5.

**Asymmetries that are intentional and called out:**
- Task 2 payment vs refund branch — different transaction shapes per Approach A; both get a status check but the payment branch relies on BEGIN-rollback while the refund branch relies on the existing catch-block revert.
- Task 4 "no bartenders ever" vs "all stubs" — permanent (`rolled_forward_at = NOW()`, commit) vs recoverable (rollback, leaves NULL for future de-stub replay).
- Task 4 `clawbackTipByPaymentIntent` — no dedicated all-stubs test because it's a thin wrapper; the inner function's test covers the behavior.

**Type / string consistency** (also enforced by `consistency-check` at the post-Task-4 checkpoint):
- `classifyForRetry(payload, today)` returns `{ bucket: 'A' | 'B' | 'C' | 'D', promote: function }` consistently across the definition in Task 3 Step 5 and consumers in Steps 6 / 8.
- The reason string `'all_bartenders_are_legacy_cc_stubs'` is identical across Task 4 (4 files: payrollLateTip.js, payrollLateTip.test.js, payrollClawback.js, payrollClawback.test.js).
- `phase4.suppressStaleBalanceReminders(client)` signature matches Task 1 Step 5's `suppressStaleBalanceReminders(tail)` call.

**Open risks:**
- Task 3: `classifyForRetry` degrades buckets C and D to `promoteBucketA` (with `bucket` letter preserved in audit log). If a future requirement says retried Bucket C rows should archive to `legacy_cc_proposals` instead, that's a small extension to the helper. Out of scope today.
- Task 2 errored-status test: cannot be reproduced from a seed alone (verified against `phase4.js:357-485` — a clean cc_id match always returns `'promoted'`). The test mocks `phase4.promoteSingleLegacyPayment` via `node:test`'s `mock.method`. The load-bearing assertion is that `cc_event_id` returns to NULL after the route 409s — proves the BEGIN/ROLLBACK fired even with the helper mocked. If a future phase4 refactor changes the return shape, only the mock return value needs updating; the 409 + `CC_PROMOTE_FAILED` + cc_event_id-NULL invariants stay.
- Pre-merge step 3: `review.js` at ~987 lines after Tasks 2 + 3 is on the edge of the 1000-line ratchet. ANY additional growth in a follow-up commit on this branch will RED-block; either flat-or-shrinking commits only, or extract before adding.

---

## Execution handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended for this plan)** — dispatch a fresh subagent per task, two-stage review between tasks, fast iteration. Best fit because Task 4 is a money path and benefits from independent eyes per checkpoint.

2. **Inline Execution** — execute tasks in this session with the named checkpoint reviews (after Task 2: database-review + code-review; after Task 4: code-review + consistency-check). Faster end-to-end if no surprises, but less rigorous per-task review.

Which approach?
