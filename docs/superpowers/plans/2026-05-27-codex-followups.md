# Codex pre-push follow-ups — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the 4 codex findings queued in `docs/tech-debt.md` (committed in `af947bb` on `main`, unpushed) that surfaced during the 2026-05-27 pre-push review fleet. These are real bugs in cc-import admin flows and tip payroll handling that were deliberately deferred so we could ship the larger batch on tempo. None are exploitable security issues; all are correctness defects in operator workflows or money-path corner cases.

**Architecture:** Four independent fixes, each landed as its own commit on branch `codex-followups`. Order is smallest/safest → riskiest: Fix 1 (one-line additive call) → Fix 2 (defensive branching with atomic-txn refactor) → Fix 3 (date-based reclassification helper) → Fix 4 (money-path math change with new tests). Each fix follows TDD — failing test first, minimal fix, verify. Worktree at `..\worktrees\codex-followups\`; merge back to `main` from the `os` integration folder when all four are green, then push triggers the standard agent fleet.

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
| `server/routes/admin/ccImport/review.js` | Orphan-payment + errored-row + skipped-event admin routes | Fix 1, 2, 3 |
| `server/routes/admin/ccImport/review.test.js` | Integration tests for the cc-import Review endpoints | Fix 1, 2, 3 |
| `scripts/cc-import/phases/phase3.js` | Source of `promoteBucketA`/`promoteBucketB` and the bucket dispatch | Fix 3 (extracts a helper) |
| `scripts/cc-import/lib/buckets.js` | `classify(row, today)` returning A/B/C/D | Fix 3 (read-only, reused) |
| `server/utils/payrollLateTip.js` | Late-tip rollforward util | Fix 4 |
| `server/utils/payrollLateTip.test.js` | Unit tests for rollForwardLateTip | Fix 4 |
| `server/utils/payrollClawback.js` | Tip-clawback util | Fix 4 |
| `server/utils/payrollClawback.test.js` | Unit tests for clawbackTip | Fix 4 |
| `docs/tech-debt.md` | Tracks the four deferred entries we are now resolving | Final task (remove resolved entries) |

---

## Task 1: Suppress stale balance reminders on orphan-payment link

**Codex finding:** [P2] When a legacy payment is linked to a proposal via the Review page, `recomputeAmountPaid` + `rederivePaymentTypeAndStatus` run, but `suppressStaleBalanceReminders` does not. `phase4.run()` already calls it at the end of the initial import pass — the manual link path is the gap. If the linked payment fully settles a future-dated imported proposal, any pending `balance_*` rows in `scheduled_messages` will fire even though the balance is paid.

**Files:**
- Modify: `server/routes/admin/ccImport/review.js:421-427`
- Test: `server/routes/admin/ccImport/review.test.js` (add one case)

- [ ] **Step 1: Confirm `phase4.suppressStaleBalanceReminders` signature and behavior**

Run:
```bash
grep -n "async function suppressStaleBalanceReminders" scripts/cc-import/phases/phase4.js
```
Expected: one match at line 763. Confirm the function accepts a `pg` client and returns the suppressed row count (`UPDATE ... RETURNING` style or similar).

Read 20 lines starting at the match to verify what it does — should be `UPDATE scheduled_messages SET status='suppressed' WHERE entity_type='proposal' AND message_type LIKE 'balance_%' AND status='pending' AND <proposal is fully paid>`.

- [ ] **Step 2: Read the existing orphan-link test to mirror its setup**

Run:
```bash
grep -n "/review/orphan-payment.*link\|recomputeAmountPaid" server/routes/admin/ccImport/review.test.js
```
Note the test fixture style (how `adminAgent` is set up, how proposals/legacy_cc_payments rows are seeded).

- [ ] **Step 3: Write the failing test**

Append to `server/routes/admin/ccImport/review.test.js`, after the existing orphan-link tests:

```javascript
test('POST /review/orphan-payment/:legacy_id/link > suppresses stale balance reminders when legacy payment fully settles a future proposal', async () => {
  // A cc-imported proposal with a future event_date and a pending
  // balance_reminder. The legacy payment we'll link covers total_price in full,
  // so post-link the proposal must be marked paid AND the pending reminder
  // must flip to 'suppressed' (otherwise it would fire even though balance is 0).

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

  // Legacy payment NOT yet linked (cc_event_id NULL = orphan).
  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments
       (cc_type, payment_applied_cents, paid_on, raw_import_id)
     VALUES ('Payment', 50000, CURRENT_DATE - INTERVAL '5 days', NULL)
     RETURNING id`
  );
  const legacyId = legacyRes.rows[0].id;

  const res = await adminAgent.post(`/api/admin/cc-import/review/orphan-payment/${legacyId}/link`)
    .send({ proposal_id: proposalId, cc_event_id: proposalCcId });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);

  const after = await pool.query('SELECT status FROM scheduled_messages WHERE id = $1', [smId]);
  assert.strictEqual(after.rows[0].status, 'suppressed');

  // Cleanup
  await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [smId]);
  await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run:
```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "suppresses stale"
```
Expected: `✖ POST /review/orphan-payment/:legacy_id/link > suppresses stale balance reminders ...` with `AssertionError: 'pending' !== 'suppressed'`.

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
  await phase4.suppressStaleBalanceReminders(tail);
} finally {
  tail.release();
}
```

- [ ] **Step 6: Run the new test — verify it passes**

Run:
```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "suppresses stale"
```
Expected: `✔ POST /review/orphan-payment/:legacy_id/link > suppresses stale balance reminders ...`.

- [ ] **Step 7: Run the full review.test.js file — verify no regression**

Run:
```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | tail -10
```
Expected: `tests N, pass N, fail 0`. The N depends on how many cases pre-existed plus the one we added.

- [ ] **Step 8: Commit**

```bash
git add server/routes/admin/ccImport/review.js server/routes/admin/ccImport/review.test.js
git commit -m "fix(cc-import): suppress stale balance reminders on orphan-payment link"
```

---

## Task 2: Reject orphan-payment link on non-success promote status (atomic txn)

**Codex finding:** [P1] `phase4.promoteSingleLegacyPayment` and `promoteSingleLegacyRefund` return `{ status: 'errored', error: '<reason>' }` for failure modes (`legacy_row_not_found`, `wrong_cc_type`, `proposal_not_found_for_cc_event_id`, `proposal_not_found_in_lock`, `insert_skipped_no_existing_row`) and `{ status: 'orphan' }` for the missing-cc_event_id branch. The link route at `server/routes/admin/ccImport/review.js:439` treats non-success the same as success — runs the tail, audit-logs success, returns 200 — leaving `legacy_cc_payments.cc_event_id` set but `promoted_payment_id` / `promoted_refund_id` NULL. The orphan-queue filter on `cc_event_id IS NULL` then drops the row, stranding the operator.

**Approach chosen (per user decision):** Option A — move the `UPDATE legacy_cc_payments SET cc_event_id` into the **same** transaction as the promote. On non-success status, throw inside the txn so the cc_event_id UPDATE rolls back atomically. No manual undo.

**Files:**
- Modify: `server/routes/admin/ccImport/review.js:395-440` (both refund and payment branches)
- Test: `server/routes/admin/ccImport/review.test.js` (add 3 cases — errored, orphan, already_promoted)

- [ ] **Step 1: Read the current refund branch around lines 380-395 to find the symmetric structure**

Run:
```bash
sed -n '380,440p' server/routes/admin/ccImport/review.js
```

The route has two parallel branches: one for refunds (calls `promoteSingleLegacyRefund`), one for payments (calls `promoteSingleLegacyPayment`). Both need the fix.

- [ ] **Step 2: Write the first failing test (errored status)**

Append to `server/routes/admin/ccImport/review.test.js`:

```javascript
test('POST /review/orphan-payment/:legacy_id/link > rolls back cc_event_id and 409s on errored promote status', async () => {
  // Seed a legacy_cc_payments row whose promote will fail (cc_type='Refund' but
  // we'll try to link as a Payment — phase4.promoteSingleLegacyPayment returns
  // { status: 'errored', error: 'wrong_cc_type' }).
  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_type, payment_applied_cents, paid_on, raw_import_id)
     VALUES ('Refund', 10000, CURRENT_DATE, NULL)
     RETURNING id`
  );
  const legacyId = legacyRes.rows[0].id;

  // A proposal to link against (the link request itself succeeds; the promote
  // is what fails downstream).
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES (NULL, 'confirmed', CURRENT_DATE + INTERVAL '30 days', 500, 0,
             'cc-fix2-err-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;

  const res = await adminAgent.post(`/api/admin/cc-import/review/orphan-payment/${legacyId}/link`)
    .send({ proposal_id: proposalId, cc_event_id: proposalCcId });

  // Server returns 409 with CC_PROMOTE_FAILED.
  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'CC_PROMOTE_FAILED');

  // cc_event_id stays NULL — row stays in the orphan queue.
  const after = await pool.query('SELECT cc_event_id FROM legacy_cc_payments WHERE id = $1', [legacyId]);
  assert.strictEqual(after.rows[0].cc_event_id, null);

  await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});
```

- [ ] **Step 3: Run the new test — verify it fails**

Run:
```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "rolls back cc_event_id"
```
Expected: FAIL — current code returns 200, cc_event_id is set.

- [ ] **Step 4: Refactor both branches to atomic txn + status check**

The current payment branch (around line 397-413):

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
    // Throw so the BEGIN/COMMIT rolls back the cc_event_id UPDATE — keeps the
    // row in the orphan queue with a recovery path.
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

Apply the **mirror change** to the refund branch (around line 380-395). The structure is identical; only the function called differs (`promoteSingleLegacyRefund` instead of `promoteSingleLegacyPayment`).

- [ ] **Step 5: Verify `ConflictError` is imported at the top of the file**

Run:
```bash
grep -n "ConflictError" server/routes/admin/ccImport/review.js | head -3
```
Expected: at least one import line. If not, add `ConflictError` to the existing `require('../../../utils/errors')` destructure at the top of the file.

- [ ] **Step 6: Run the new errored-status test — verify it passes**

Run:
```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "rolls back cc_event_id"
```
Expected: PASS.

- [ ] **Step 7: Add the orphan-status test**

Append to `review.test.js`:

```javascript
test('POST /review/orphan-payment/:legacy_id/link > 409s on orphan promote status', async () => {
  // promoteSingleLegacyPayment returns { status: 'orphan' } when the legacy
  // row has no cc_event_id at the start of the promote (we set it inside the
  // same txn, so this branch fires only on a race or a deliberately bad call).
  // Easiest reproduction: pass a non-existent proposal_id; the cc_event_id we
  // set won't resolve to any real proposal, so the promote walks back to its
  // missing-anchor branch.

  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_type, payment_applied_cents, paid_on, raw_import_id)
     VALUES ('Payment', 10000, CURRENT_DATE, NULL)
     RETURNING id`
  );
  const legacyId = legacyRes.rows[0].id;

  const res = await adminAgent.post(`/api/admin/cc-import/review/orphan-payment/${legacyId}/link`)
    .send({ proposal_id: 999999999, cc_event_id: 'definitely-not-a-real-cc-id' });

  assert.strictEqual(res.status, 409);
  assert.strictEqual(res.body.code, 'CC_PROMOTE_FAILED');

  const after = await pool.query('SELECT cc_event_id FROM legacy_cc_payments WHERE id = $1', [legacyId]);
  assert.strictEqual(after.rows[0].cc_event_id, null);

  await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
});
```

- [ ] **Step 8: Add the success-still-works regression test**

```javascript
test('POST /review/orphan-payment/:legacy_id/link > still succeeds and persists cc_event_id on promoted status', async () => {
  // Regression: refactor should not break the happy path.
  const propRes = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, total_price, amount_paid, cc_id, token, event_type)
     VALUES (NULL, 'confirmed', CURRENT_DATE + INTERVAL '60 days', 500, 0,
             'cc-fix2-ok-' || gen_random_uuid()::text, gen_random_uuid(), 'birthday-party')
     RETURNING id, cc_id`
  );
  const proposalId = propRes.rows[0].id;
  const proposalCcId = propRes.rows[0].cc_id;

  const legacyRes = await pool.query(
    `INSERT INTO legacy_cc_payments (cc_type, payment_applied_cents, paid_on, raw_import_id)
     VALUES ('Payment', 10000, CURRENT_DATE, NULL)
     RETURNING id`
  );
  const legacyId = legacyRes.rows[0].id;

  const res = await adminAgent.post(`/api/admin/cc-import/review/orphan-payment/${legacyId}/link`)
    .send({ proposal_id: proposalId, cc_event_id: proposalCcId });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ok, true);
  assert.strictEqual(res.body.promote_status, 'promoted');

  const after = await pool.query('SELECT cc_event_id, promoted_payment_id FROM legacy_cc_payments WHERE id = $1', [legacyId]);
  assert.strictEqual(after.rows[0].cc_event_id, proposalCcId);
  assert.notStrictEqual(after.rows[0].promoted_payment_id, null);

  // Cleanup
  await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM legacy_cc_payments WHERE id = $1', [legacyId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});
```

- [ ] **Step 9: Run the full file — verify all three new tests pass and nothing regressed**

Run:
```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | tail -10
```
Expected: `tests N, pass N, fail 0`.

- [ ] **Step 10: Commit**

```bash
git add server/routes/admin/ccImport/review.js server/routes/admin/ccImport/review.test.js
git commit -m "fix(cc-import): atomic-rollback orphan-payment link on non-success promote status"
```

---

## Task 3: Errored-row and skipped-event retry reclassifies by date

**Codex finding:** [P1] Three retry endpoints in `review.js` hardcode `phase3.promoteBucketA` regardless of the row's effective bucket:
- Line 286: `/duplicate/:row_id/promote` (dedup-skip retry)
- Line 820: `/errored-row/:row_id/retry`
- Line 930: `/skipped-event/:row_id/promote`

For the **errored-row** and **skipped-event** retries (the two codex flagged), if the underlying row is a past-dated event (would naturally classify as Bucket B), forcing Bucket A creates a `confirmed` proposal with a past event_date and enrolls in auto-comms — the scheduler would then send "your event is next week!" emails for an event that already happened.

The duplicate-promote retry (line 286) is **out of scope** — that endpoint is for dedup-suspect rows where the operator has already confirmed the row is NOT a duplicate. The classification was correct at first run; bypassing dedup keeps the same classification.

**Approach chosen (per user decision):** Option 1 — reclassify by `event_date`. Past-dated rows route to `promoteBucketB` (writes to `proposals` with `status='completed'` + completed shifts + NO auto-comms enrollment). Future-dated rows continue to `promoteBucketA`.

**Files:**
- Modify: `server/routes/admin/ccImport/review.js:820, 930` (the two flagged retry sites)
- Modify: `scripts/cc-import/phases/phase3.js` — export a tiny `classifyForRetry(payload, today)` helper that wraps `classify(...)` + returns the right `promote*` function reference
- Test: `server/routes/admin/ccImport/review.test.js` (add 2 cases — past-dated retry → B; future-dated retry → A)

- [ ] **Step 1: Confirm the existing classify() signature**

Run:
```bash
cat scripts/cc-import/lib/buckets.js
```
Expected output mirrors what's already in the file:
```javascript
function classify({ status, eventDate, packageName }, today) {
  if (status === 'Confirmed' && isSkippedPackage(packageName)) return 'D';
  if (status !== 'Confirmed') return 'C';
  if (!eventDate) return 'C';
  return eventDate >= today ? 'A' : 'B';
}
```

- [ ] **Step 2: Find how the row's status / eventDate / packageName are extracted in phase3.js for the initial bucket dispatch**

Run:
```bash
grep -n "classify(" scripts/cc-import/phases/phase3.js
```
Expected: at least one call site that builds the `{status, eventDate, packageName}` shape from the raw payload. Read that block — we'll reuse the same field-extraction logic.

- [ ] **Step 3: Write the failing test (past-dated retry routes to Bucket B)**

Append to `server/routes/admin/ccImport/review.test.js`:

```javascript
test('POST /review/skipped-event/:row_id/promote > past-dated event lands in Bucket B (completed, no auto-comms enrollment)', async () => {
  // Seed a 'skipped' raw row whose payload is a Confirmed PAST event.
  const payload = {
    'Event Status': 'Confirmed',
    'Event Date': '2024-01-15',  // far past
    'Package': 'Bartending Services',  // a skip-list package — that's why it's 'skipped' status
    'Client': 'Past Event Test',
    'Event Id': 'cc-fix3-past-' + Date.now(),
  };
  const rawRes = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status, cc_id)
     VALUES ('report (10).csv', 'events', 999999, md5(random()::text),
             $1::jsonb, 'skipped', $2)
     RETURNING id`,
    [JSON.stringify(payload), payload['Event Id']]
  );
  const rowId = rawRes.rows[0].id;

  const res = await adminAgent.post(`/api/admin/cc-import/review/skipped-event/${rowId}/promote`)
    .send({});
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.proposal_id, 'expected a proposal_id in the response');

  const proposalId = res.body.proposal_id;

  // Bucket B means: proposals.status='completed', shifts.status='completed',
  // and NO pending scheduled_messages enrolled.
  const propRow = await pool.query('SELECT status FROM proposals WHERE id = $1', [proposalId]);
  assert.strictEqual(propRow.rows[0].status, 'completed');

  const shiftRow = await pool.query('SELECT status FROM shifts WHERE proposal_id = $1', [proposalId]);
  // Shifts may not exist on Bucket B archive flow — accept either no shift or completed.
  if (shiftRow.rowCount > 0) {
    assert.strictEqual(shiftRow.rows[0].status, 'completed');
  }

  const smCount = await pool.query(
    `SELECT COUNT(*)::int AS c FROM scheduled_messages
       WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
    [proposalId]
  );
  assert.strictEqual(smCount.rows[0].c, 0, 'past-dated retry must not enroll in auto-comms');

  // Cleanup
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id = $1", [proposalId]);
  await pool.query("DELETE FROM shifts WHERE proposal_id = $1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
  await pool.query("DELETE FROM legacy_cc_raw_imports WHERE id = $1", [rowId]);
});
```

- [ ] **Step 4: Run the new test — verify it fails**

Run:
```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "past-dated event lands"
```
Expected: FAIL — current code routes to Bucket A, so `proposals.status='confirmed'` (not 'completed').

- [ ] **Step 5: Add `classifyForRetry` helper to phase3.js**

In `scripts/cc-import/phases/phase3.js`, add this near the existing `promoteBucketA`/`promoteBucketB` exports (around line 436):

```javascript
/**
 * Used by the cc-import Review page's retry endpoints (`/errored-row/:id/retry`
 * and `/skipped-event/:id/promote`). Reads the raw payload, runs the same
 * `classify(...)` the initial phase 3 pass uses, and returns the matching
 * promote function. Falls back to promoteBucketA when classification is
 * ambiguous (Bucket C archive isn't a single-row API — and the operator
 * explicitly chose to retry, so we honor "make this active" intent).
 *
 * Returns: { bucket: 'A' | 'B', promote: function(payload, options) }
 */
function classifyForRetry(payload, today = new Date()) {
  // Extract status / eventDate / packageName from the raw payload using the
  // same helpers as the initial-pass dispatch.
  const status = trimOrNull(getCol(payload, 'Event Status'));
  const eventDateRaw = getCol(payload, 'Event Date');
  const eventDate = eventDateRaw ? parseCcDate(eventDateRaw) : null;
  const packageName = trimOrNull(getCol(payload, 'Package'));

  const bucket = classify({ status, eventDate, packageName }, today);
  if (bucket === 'B') return { bucket: 'B', promote: promoteBucketB };
  // A, C, or D on retry: operator is force-promoting — honor "active" intent.
  // C and D archive paths aren't single-row-callable, so we promote as A.
  return { bucket: 'A', promote: promoteBucketA };
}
```

Add `classifyForRetry` to the module.exports list at the bottom of `phase3.js`.

- [ ] **Step 6: Update the skipped-event retry endpoint to use classifyForRetry**

In `server/routes/admin/ccImport/review.js`, find the block at lines 919-933:

```javascript
// Re-run via promoteBucketA. The row's natural bucket is determined by
// status + date inside the promote helper; for a Bucket D row that was
// skipped purely on package, bypassing means it now lands in A / B / C as
// appropriate. We call promoteBucketA which handles its own classification
// path through the underlying _promote.
// NOTE: phase3.promoteBucketA uses bucketLetter='A' explicitly — meaning
// the row will be inserted as Bucket A (future + Confirmed). For a more
// permissive re-classification, callers would need a dedicated bypass
// helper. For Task 19 we accept "promote as Bucket A" semantics: the
// operator who flips a skipped row is explicitly saying "this should be
// an active event."
const result = await phase3.promoteBucketA(guard.rows[0].payload, { skipDedup: true });
if (result.status !== 'promoted' && result.status !== 'already_promoted') {
  throw new ConflictError(`Promote failed: ${result.error || result.status}`, 'CC_PROMOTE_FAILED');
}
```

Replace with:

```javascript
// Reclassify by status + event_date so a past-dated event lands in Bucket B
// (completed, no auto-comms enrollment) instead of being force-promoted as
// Bucket A and scheduling stale reminders. Mirrors the initial phase 3 pass
// via classifyForRetry.
const { bucket, promote } = phase3.classifyForRetry(guard.rows[0].payload);
const result = await promote(guard.rows[0].payload, { skipDedup: true });
if (result.status !== 'promoted' && result.status !== 'already_promoted') {
  throw new ConflictError(`Promote failed: ${result.error || result.status}`, 'CC_PROMOTE_FAILED');
}
```

Also include `bucket` in the existing `logAdminAction` metadata block right after this (so the audit trail records which bucket the retry landed in).

- [ ] **Step 7: Run the failing test — verify it now passes**

Run:
```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | grep -A 4 "past-dated event lands"
```
Expected: PASS.

- [ ] **Step 8: Update the errored-row retry endpoint the same way**

Find the block at line 820 of `review.js`:

```javascript
const r = await phase3.promoteBucketA(workingPayload, { skipDedup: false });
retryResult = r;
retryStatus = r.status;
```

Replace with:

```javascript
const { bucket, promote } = phase3.classifyForRetry(workingPayload);
const r = await promote(workingPayload, { skipDedup: false });
retryResult = r;
retryStatus = r.status;
```

Include `bucket` in the route's audit log too.

- [ ] **Step 9: Add a parallel test for the errored-row retry (past-dated → B)**

Append:

```javascript
test('POST /review/errored-row/:row_id/retry > past-dated event lands in Bucket B', async () => {
  const payload = {
    'Event Status': 'Confirmed',
    'Event Date': '2023-12-01',
    'Package': 'Open Bar',  // not a skip-list package
    'Client': 'Past Errored Test',
    'Event Id': 'cc-fix3-err-past-' + Date.now(),
  };
  const rawRes = await pool.query(
    `INSERT INTO legacy_cc_raw_imports
       (source_file, source_entity, source_row_number, source_row_hash, payload, import_status, cc_id, import_notes)
     VALUES ('report (10).csv', 'events', 888888, md5(random()::text),
             $1::jsonb, 'errored', $2, $3::jsonb)
     RETURNING id`,
    [JSON.stringify(payload), payload['Event Id'], JSON.stringify({ error: 'simulated for test', phase: 'phase3' })]
  );
  const rowId = rawRes.rows[0].id;

  const res = await adminAgent.post(`/api/admin/cc-import/review/errored-row/${rowId}/retry`)
    .send({});
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.proposal_id);

  const propRow = await pool.query('SELECT status FROM proposals WHERE id = $1', [res.body.proposal_id]);
  assert.strictEqual(propRow.rows[0].status, 'completed');

  // Cleanup
  await pool.query("DELETE FROM shifts WHERE proposal_id = $1", [res.body.proposal_id]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [res.body.proposal_id]);
  await pool.query("DELETE FROM legacy_cc_raw_imports WHERE id = $1", [rowId]);
});
```

- [ ] **Step 10: Run the full file — verify all tests pass**

Run:
```bash
node --test server/routes/admin/ccImport/review.test.js 2>&1 | tail -10
```
Expected: `tests N, pass N, fail 0`.

- [ ] **Step 11: Commit**

```bash
git add server/routes/admin/ccImport/review.js server/routes/admin/ccImport/review.test.js scripts/cc-import/phases/phase3.js
git commit -m "fix(cc-import): errored-row + skipped-event retry reclassifies by date so past-dated events land in Bucket B"
```

---

## Task 4: payrollLateTip + clawbackTip filter stubs from split instead of skipping entirely

**Codex finding:** [P1] Both `rollForwardLateTip` (`server/utils/payrollLateTip.js:41-49`) and `clawbackTip` (`server/utils/payrollClawback.js:37-45`) early-return on `isLegacyCcStubUser(tip.target_user_id)`. After that, they split the money across ALL approved bartenders on `tip.shift_id`. On a mixed shift (stub + real bartender, possible after operator linked a real user via `/review/unmatched-payee/.../link`), a tip whose `target_user_id` resolves to the stub now skips entirely — the real bartender on the same shift gets nothing from a tip, and a later refund won't claw their share back.

**Approach chosen (per user decision):** Filter stubs out of the per-bartender split instead of skipping entirely. If ALL bartenders are stubs, keep the original skip (with a renamed reason string). The math change: per-bartender share = total / N where N is now `realBartenders.length` (smaller denominator when stubs are filtered → larger share for the real bartenders, which is the correct outcome).

**Files:**
- Modify: `server/utils/payrollLateTip.js:36-49`
- Modify: `server/utils/payrollClawback.js:32-45`
- Test: `server/utils/payrollLateTip.test.js` (update existing all-stub test for renamed reason; add mixed-shift test)
- Test: `server/utils/payrollClawback.test.js` (same updates)

- [ ] **Step 1: Read the existing all-stub tests for both files to plan the reason-string update**

Run:
```bash
grep -n "legacy_cc_stub_target" server/utils/payrollLateTip.test.js server/utils/payrollClawback.test.js
```
Expected: one match in each file at the existing `skipped: true, reason: 'legacy_cc_stub_target'` assertion.

- [ ] **Step 2: Write the failing mixed-shift test for rollForwardLateTip**

Append to `server/utils/payrollLateTip.test.js` (before the existing tail-cleanup):

```javascript
test('rollForwardLateTip > mixed-stub shift: real bartender gets the whole tip, stubs filtered out', async () => {
  // Setup: one stub bartender + one real bartender on the same shift. Tip is
  // targeted at the stub. Without the fix, the whole rollforward skips. With
  // the fix, the real bartender gets the full tip rolled forward.

  const stub = await pool.query(
    `INSERT INTO users (email, password_hash, role, cc_id)
     VALUES ('mixed-stub@example.com','x','staff','legacy_cc:test:mixed-stub')
     RETURNING id`
  );
  const stubId = stub.rows[0].id;

  // Mixed bartender: a fresh non-stub user (separate from the existing
  // bartenderA at the top of the file so we don't collide with other tests).
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

  // Both approved on the frozen shift (reusing frozenShiftId from the test file's setup).
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')
     ON CONFLICT DO NOTHING`,
    [frozenShiftId, stubId, realId]
  );

  // Late tip targeting the stub.
  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_mixed_late_tip', '2026-05-15 23:30:00+00', $2)
     RETURNING id`,
    [stubId, frozenShiftId]
  );
  const mixedTipId = tipRes.rows[0].id;

  try {
    const result = await rollForwardLateTip(mixedTipId);
    // Result is NOT skipped — money flowed.
    assert.notStrictEqual(result?.skipped, true);
    assert.strictEqual(result.bartenders, 1, 'only the real bartender takes the split');

    // The real bartender has a payout_event with the FULL tip amount (4000c gross, 128c fee).
    const realEvent = await pool.query(
      `SELECT pe.card_tip_gross_cents, pe.card_tip_fee_cents, pe.card_tip_net_cents
         FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1 AND pe.shift_id = $2`,
      [realId, frozenShiftId]
    );
    assert.strictEqual(realEvent.rowCount, 1);
    assert.strictEqual(Number(realEvent.rows[0].card_tip_gross_cents), 4000);
    assert.strictEqual(Number(realEvent.rows[0].card_tip_fee_cents), 128);
    assert.strictEqual(Number(realEvent.rows[0].card_tip_net_cents), 3872);

    // The stub has NO payout_event.
    const stubEvent = await pool.query(
      `SELECT COUNT(*)::int AS c FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1`,
      [stubId]
    );
    assert.strictEqual(stubEvent.rows[0].c, 0);
  } finally {
    await pool.query(
      `DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN ($1, $2))`,
      [stubId, realId]
    );
    await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)', [stubId, realId]);
    await pool.query('DELETE FROM tips WHERE id = $1', [mixedTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1 AND user_id IN ($2, $3)', [frozenShiftId, stubId, realId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [realId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubId, realId]);
  }
});
```

- [ ] **Step 3: Run the test — verify it fails**

Run:
```bash
node --test server/utils/payrollLateTip.test.js 2>&1 | grep -A 4 "mixed-stub shift"
```
Expected: FAIL with `result.skipped === true` (current code skips the whole rollforward).

- [ ] **Step 4: Apply the fix to payrollLateTip.js**

In `server/utils/payrollLateTip.js`, find the block at lines 36-49:

```javascript
// cc-import: tips paid TO a legacy_cc:* stub bartender never roll forward
// into modern payouts (we cannot pay stubs through Stripe Connect). Fires
// BEFORE any DB writes — leaves rolled_forward_at NULL so a re-run after
// a future de-stub can pick up the tip. Reuses the same transaction client
// so the read happens against the locked row.
if (await isLegacyCcStubUser(tip.target_user_id, client)) {
  Sentry.captureMessage('rollForwardLateTip: target is legacy_cc stub; skipping', {
    level: 'info',
    tags: { util: 'payrollLateTip', step: 'skip_legacy_cc_stub' },
    extra: { tipId, targetUserId: tip.target_user_id },
  });
  await client.query('ROLLBACK');
  return { skipped: true, reason: 'legacy_cc_stub_target' };
}

// Bartenders on the original shift.
const bartendersRes = await client.query(
  `SELECT sr.user_id FROM shift_requests sr
    WHERE sr.shift_id = $1 AND sr.status = 'approved'
      AND LOWER(sr.position) = 'bartender'
    ORDER BY sr.user_id`,
  [tip.shift_id]
);
const bartenders = bartendersRes.rows.map(r => r.user_id);
if (bartenders.length === 0) {
  // No bartenders to pay; flag the tip so we don't retry indefinitely.
  await client.query('UPDATE tips SET rolled_forward_at = NOW() WHERE id = $1', [tipId]);
  await client.query('COMMIT');
  return { bartenders: 0 };
}
```

Replace with:

```javascript
// Bartenders on the original shift. Stub users (cc_id LIKE 'legacy_cc:%') are
// filtered out of the per-bartender split — they can't be paid through Stripe
// Connect, so they receive no share. If ALL bartenders on the shift are stubs,
// the entire rollforward is skipped (original cc-import gate). The real
// bartenders on a mixed-stub shift then split the full tip.
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
  // No bartenders at all — flag the tip so we don't retry indefinitely.
  await client.query('UPDATE tips SET rolled_forward_at = NOW() WHERE id = $1', [tipId]);
  await client.query('COMMIT');
  return { bartenders: 0 };
}

if (bartenders.length === 0) {
  // All bartenders on the shift are stubs — no modern payouts possible.
  // Leave rolled_forward_at NULL so a future de-stub can replay.
  Sentry.captureMessage('rollForwardLateTip: all shift bartenders are legacy_cc stubs; skipping', {
    level: 'info',
    tags: { util: 'payrollLateTip', step: 'skip_all_stubs' },
    extra: { tipId, shiftId: tip.shift_id, stubCount },
  });
  await client.query('ROLLBACK');
  return { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' };
}

// Mixed shift (stub + real): the existing per-bartender split below uses
// `bartenders` (filtered, real only), so the real bartenders take the full
// tip — the stubs are correctly excluded from the denominator.
```

(The downstream `const n = bartenders.length;` and the rest of the file stays unchanged — `bartenders` is now the filtered list.)

- [ ] **Step 5: Run the mixed-shift test — verify it passes**

Run:
```bash
node --test server/utils/payrollLateTip.test.js 2>&1 | grep -A 4 "mixed-stub shift"
```
Expected: PASS.

- [ ] **Step 6: Update the existing all-stub test to assert the new reason string**

Find the existing test in `payrollLateTip.test.js`:

```javascript
test('rollForwardLateTip > skips and returns structured shape when target is a legacy CC stub', async () => {
  // ... existing setup ...
  const result = await rollForwardLateTip(stubTipId);
  assert.deepStrictEqual(result, { skipped: true, reason: 'legacy_cc_stub_target' });
  // ...
```

The current test setup creates ONE stub bartender on the shift (no real bartender). Under the new logic, that's "all bartenders are stubs" → still skips, but the reason string is now `'all_bartenders_are_legacy_cc_stubs'`. Update the assertion:

```javascript
assert.deepStrictEqual(result, { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' });
```

Also update the test name for clarity:

```javascript
test('rollForwardLateTip > skips when ALL shift bartenders are legacy CC stubs', async () => {
```

- [ ] **Step 7: Run the full payrollLateTip.test.js — verify both old and new tests pass**

Run:
```bash
node --test server/utils/payrollLateTip.test.js 2>&1 | tail -10
```
Expected: `tests N, pass N, fail 0`.

- [ ] **Step 8: Apply the parallel fix to payrollClawback.js**

In `server/utils/payrollClawback.js`, find the block at lines 32-45:

```javascript
// cc-import: tips paid TO a legacy_cc:* stub bartender never had a modern
// payout to claw back FROM (stubs are imports-only, no Stripe Connect).
// Fires BEFORE any DB writes — leaves refunded_amount_cents at the prior
// value so a re-run after a future de-stub can replay. clawbackTipByPaymentIntent
// inherits this skip automatically since it calls clawbackTip internally.
if (await isLegacyCcStubUser(tip.target_user_id, client)) {
  Sentry.captureMessage('clawbackTip: target is legacy_cc stub; skipping', {
    level: 'info',
    tags: { util: 'payrollClawback', step: 'skip_legacy_cc_stub' },
    extra: { tipId, targetUserId: tip.target_user_id },
  });
  await client.query('ROLLBACK');
  return { skipped: true, reason: 'legacy_cc_stub_target' };
}
```

Remove it entirely. Then find the later block that queries approved bartenders for the clawback split (look for `SELECT sr.user_id FROM shift_requests sr` around line 70-90) and apply the same filter + all-stub guard pattern as in Step 4.

The exact callsite differs slightly because clawbackTip already has an early-return for the no-shift-id case (`if (!tip.shift_id) ...`). The stub-filter logic goes right after the bartender query.

- [ ] **Step 9: Write the failing mixed-shift test for clawbackTip**

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

  // Both approved on the test shift (reuse the file's frozenShiftId / openShiftId
  // — whichever the existing tests use as the "current open period shift").
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status)
     VALUES ($1, $2, 'Bartender', 'approved'), ($1, $3, 'Bartender', 'approved')
     ON CONFLICT DO NOTHING`,
    [openShiftId, stubId, realId]
  );

  // A tip already paid + previously rolled forward (so there's a payout_event
  // for the real bartender to claw back from).
  const tipRes = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, rolled_forward_at, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, 'pi_cb_mixed', NOW() - INTERVAL '1 day', $2, NOW(), 0)
     RETURNING id`,
    [stubId, openShiftId]
  );
  const cbTipId = tipRes.rows[0].id;

  // Seed the existing payout_event for the real bartender (matches what
  // rollForwardLateTip would have created via the new mixed-shift path).
  await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id) VALUES ((SELECT id FROM pay_periods WHERE status='open' AND CURRENT_DATE BETWEEN start_date AND end_date), $1)
     ON CONFLICT (pay_period_id, contractor_id) DO NOTHING`,
    [realId]
  );
  await pool.query(
    `INSERT INTO payout_events (payout_id, shift_id, contracted_hours, hours, rate_cents, wage_cents,
                                card_tip_gross_cents, card_tip_fee_cents, card_tip_net_cents, line_total_cents)
     SELECT id, $2, 0, 0, 0, 0, 4000, 128, 3872, 3872
       FROM payouts WHERE contractor_id = $1
     ON CONFLICT (payout_id, shift_id) DO NOTHING`,
    [realId, openShiftId]
  );

  try {
    const result = await clawbackTip(cbTipId, 4000);  // full refund
    assert.notStrictEqual(result?.skipped, true);
    assert.strictEqual(result.bartenders, 1);

    // Real bartender's adjustment_cents reflects the negative clawback.
    const adj = await pool.query(
      `SELECT adjustment_cents FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
        WHERE po.contractor_id = $1 AND pe.shift_id = $2`,
      [realId, openShiftId]
    );
    assert.strictEqual(Number(adj.rows[0].adjustment_cents), -4000);
  } finally {
    await pool.query('DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id = $1)', [realId]);
    await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1, $2)', [stubId, realId]);
    await pool.query('DELETE FROM tips WHERE id = $1', [cbTipId]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1 AND user_id IN ($2, $3)', [openShiftId, stubId, realId]);
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [realId]);
    await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [stubId, realId]);
  }
});
```

- [ ] **Step 10: Update the existing all-stub clawback test to assert the new reason string**

Find:

```javascript
assert.deepStrictEqual(result, { skipped: true, reason: 'legacy_cc_stub_target' });
```

Replace with:

```javascript
assert.deepStrictEqual(result, { skipped: true, reason: 'all_bartenders_are_legacy_cc_stubs' });
```

- [ ] **Step 11: Run both payroll tests — verify everything passes**

Run:
```bash
node --test server/utils/payrollLateTip.test.js server/utils/payrollClawback.test.js 2>&1 | tail -15
```
Expected: `tests N, pass N, fail 0` (combined count for both files).

- [ ] **Step 12: Run the broader payroll suite for regression coverage**

Run:
```bash
node --test server/utils/payrollLateTip.test.js server/utils/payrollClawback.test.js server/utils/payrollAccrual.test.js server/utils/payrollGuards.test.js 2>&1 | tail -10
```
Expected: all pass. `payrollAccrual.test.js` should be green now that the prerequisite pay_period reset is in place.

- [ ] **Step 13: Commit**

```bash
git add server/utils/payrollLateTip.js server/utils/payrollLateTip.test.js server/utils/payrollClawback.js server/utils/payrollClawback.test.js
git commit -m "fix(payroll): mixed-stub shifts route the tip to real bartenders instead of skipping"
```

---

## Task 5: Remove the four resolved entries from tech-debt.md

**Why:** All four codex findings tracked in `docs/tech-debt.md` (added in commit `af947bb`, currently on `main` unpushed) are now resolved by Tasks 1-4. Leaving them in `tech-debt.md` would mislead a future reader.

**Files:**
- Modify: `docs/tech-debt.md` (remove four `### CC-Import: ...` blocks added in `af947bb`)

- [ ] **Step 1: Confirm the four entries exist**

Run:
```bash
grep -n "### CC-Import" docs/tech-debt.md
```
Expected: 4 matches, all under the "Low-value / nice-to-have" section.

- [ ] **Step 2: Delete the four `### CC-Import: ...` blocks**

Open `docs/tech-debt.md`. Find the section starting `### CC-Import: orphan-payment link silently no-ops on non-success status` and ending at the line BEFORE `### admin.js applications filter CASE expression blocks index` (which is a pre-existing entry — keep it).

Delete the four blocks (`### CC-Import: orphan-payment link silently no-ops...`, `### CC-Import: orphan-payment link skips suppressStaleBalanceReminders`, `### CC-Import: promoteBucketA hardcodes Bucket A on errored-row + skipped-event retry`, `### CC-Import: payrollLateTip / clawbackTip stub gate fires on target...`) including their `**Source:** / **What:** / **Why deferred:** / **Next step:**` blocks.

- [ ] **Step 3: Verify the file still parses cleanly**

Run:
```bash
grep -c "^###" docs/tech-debt.md
```
Expected: pre-existing-count + 0 (i.e., the entry count from before `af947bb` minus the one new `metricsQueries include_cc` L4 entry we keep, since L4 is still a real follow-up).

Wait — the L4 `metricsQueries include_cc` entry IS preserved. Only the 4 codex CC-Import entries get removed.

Re-check:
```bash
grep -n "^### " docs/tech-debt.md
```
Expected: still has `### metricsQueries include_cc filter join lacks composite index` (preserved) but no `### CC-Import: ...` entries (removed).

- [ ] **Step 4: Commit**

```bash
git add docs/tech-debt.md
git commit -m "docs(tech-debt): remove 4 CC-Import entries now resolved by codex-followups"
```

---

## Pre-merge verification

Before merging `codex-followups` back to `main`:

- [ ] **Step 1: Confirm the branch's commit list**

Run from inside the worktree:
```bash
git log --oneline main..HEAD
```
Expected: 5 commits in the order Tasks 1 → 5, plus this plan document if you committed it on this branch.

- [ ] **Step 2: Run the full impacted-tests set**

Run:
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

- [ ] **Step 3: Run the file-size ratchet check**

Run:
```bash
npm run check:filesize
```
Expected: `review.js` and `phase3.js` may YELLOW (700-1000 lines, planning a split) but must not RED-block.

- [ ] **Step 4: Switch back to `os` integration window and merge**

From the `os` folder (NOT the worktree):
```bash
git merge codex-followups
```
Expected: fast-forward merge (no conflicts — `codex-followups` branched from `main` and no parallel work touched these files).

- [ ] **Step 5: Clean up the worktree**

```bash
npm run worktree:rm -- codex-followups
```

- [ ] **Step 6: Push only on explicit user cue (per CLAUDE.md Rule 4)**

Do NOT auto-push. Wait for the user to issue a push cue. When they do, the 0.5-step confirmation gate fires the pre-push agent fleet on the batched commits (5 from `codex-followups` + the pre-existing unpushed `af947bb` doc-queue commit).

---

## Self-review notes

**Spec coverage:** All 4 codex findings have dedicated tasks (1: P2 suppress, 2: P1 atomic-rollback, 3: P1 reclassify-by-date, 4: P1 mixed-stub split). Task 5 cleans up the tech-debt entries those four resolved.

**Placeholders:** None — every step has the actual SQL, JS, or shell to paste.

**Type consistency:** `classifyForRetry(payload, today)` returns `{ bucket, promote }` consistently across Task 3 Step 5 (definition) and Steps 6/8 (consumers). The `reason` string `'all_bartenders_are_legacy_cc_stubs'` is identical across Task 4 Steps 4/6/8/10. `phase4.suppressStaleBalanceReminders(tail)` signature matches Task 1 Step 1 lookup.

**Open risks:**
- Task 3 assumes `classify(...)` results A/C/D should all route to `promoteBucketA` on operator retry. If a future requirement says retried Bucket C rows should archive to `legacy_cc_proposals` instead of being force-promoted as A, that's a small extension to `classifyForRetry` (return a `bucket: 'C', promote: archiveToBucketC` function). Out of scope today.
- Task 4 assumes mixed-stub shifts are possible. Verified by the existence of the `/review/unmatched-payee/.../link` endpoint, which reassigns a stub's shift_requests to a real user. If product later decides stubs should be HARD-deleted on link (not co-existing), the all-stubs check still works — it just becomes unreachable in practice.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-27-codex-followups.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks, fast iteration. Best fit when the tasks span money paths (Task 4) so each gets independent eyes.

2. **Inline Execution** — execute tasks in this session with checkpoint reviews. Faster end-to-end if no surprises, but less rigorous per-task review.

Which approach?
