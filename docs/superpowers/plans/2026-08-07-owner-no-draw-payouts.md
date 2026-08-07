---
lanes:
  - id: no-draw-engine
    footprint:
      - server/db/schema.sql
      - server/utils/payrollProcessing.js
      - server/utils/payrollProcessing.test.js
      - server/utils/payrollAccrual.js
      - server/utils/payrollAccrual.test.js
      - server/utils/payrollAccrual.sweepPreserve.test.js
      - server/utils/payrollLateTip.js
      - server/utils/payrollClawback.js
      - server/utils/dutyLines.js
      - server/routes/admin/payroll.js
      - server/routes/admin/payroll.test.js
      - server/routes/admin/payrollTax.legalName.test.js
      - server/routes/staffPortal/payouts.js
      - server/routes/staffPortal/payouts.test.js
      - README.md
      - ARCHITECTURE.md
    deps: []
    review: full-fleet
  - id: no-draw-ui
    footprint:
      - client/src/pages/admin/payroll/PayoutRow.js
      - client/src/pages/admin/payroll/PayRunView.js
      - client/src/pages/admin/payroll/HistoryView.js
      - client/src/pages/admin/userDetail/tabs/PayoutsTab.js
      - client/src/pages/staff/PayPage.js
      - client/src/pages/staff/PayoutDetail.js
      - client/src/index.css
    deps: [no-draw-engine]
    review: full-fleet
---

# Owner No-Draw Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third payout status `no_draw` for the owner's payouts: tracked and editable but never owed, never paid, never blocking period close, never leaking into 1099 totals.

**Architecture:** All four payout-creation sites share one identical upsert; they collapse into a single `ensurePayout` helper in `payrollProcessing.js` that births `no_draw` when `contractor_profiles.takes_draw = false`. Everything that filters `status = 'pending'` (finalize, rollups, owed stats) or `status = 'paid'` (1099, paystubs, staff YTD source) excludes `no_draw` automatically; the deltas are the two empty-stub DELETEs, one client owed-delta lift, and presentation.

**Tech Stack:** Node/Express, raw SQL via pg, React (CRA), node:test suites against the shared dev DB.

**Spec:** `docs/superpowers/specs/2026-08-07-owner-no-draw-payouts-design.md`
**Plan-fleet review:** 2026-08-07, 3 blockers + 6 warnings folded in (rev 2). Post-spec decision (Dallas, 2026-08-07): the staff page's all-time blended total ALSO counts `no_draw` as-if-paid (Task 4b); admin tax surfaces stay strictly `paid`.

## Global Constraints

- Money is integer cents; parameterized SQL only; multi-table writes in BEGIN/COMMIT.
- Server tests run one suite at a time, from repo root: `node -r dotenv/config --test <file>` (shared dev DB).
- Prod DDL + backfill run BEFORE the push that ships this code (display-name precedent). Ship-time section at the bottom.
- No em dashes in user-facing copy.
- `recomputePayoutTotal` stays the single writer of `payouts.total_cents`; this plan adds no new writer.
- The four insert-site swaps must not change ON CONFLICT semantics: an existing row's status is never rewritten by the upsert.

---

### Task 1: Schema (dev) and `ensurePayout` helper

**Files:**
- Modify: `server/db/schema.sql` (payouts block ~line 2912; contractor_profiles column block ~line 1210)
- Modify: `server/utils/payrollProcessing.js`
- Test: `server/utils/payrollProcessing.test.js`

**Interfaces:**
- Produces: `ensurePayout(executor, payPeriodId, contractorId) -> Promise<number>` (payout id), exported from `payrollProcessing.js`. Later tasks replace all four inline upserts with it.

- [ ] **Step 1: schema.sql changes**

Widen the status CHECK (existing DO-block at ~2912, edit in place):

```sql
DO $$ BEGIN
  ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
  ALTER TABLE payouts ADD CONSTRAINT payouts_status_check
    CHECK (status IN ('pending', 'no_draw', 'paid'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

Add the flag next to the other contractor_profiles ALTERs (~line 1210):

```sql
-- Owner/no-draw flag (spec 2026-08-07): a contractor with takes_draw = false
-- accrues payouts born 'no_draw' (tracked, never owed). SQL-only toggle; no UI.
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS takes_draw BOOLEAN NOT NULL DEFAULT true;
```

- [ ] **Step 2: apply to the dev DB**

From repo root:

```bash
node -r dotenv/config -e "
const { pool } = require('./server/db');
(async () => {
  await pool.query(\"ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check\");
  await pool.query(\"ALTER TABLE payouts ADD CONSTRAINT payouts_status_check CHECK (status IN ('pending','no_draw','paid'))\");
  await pool.query('ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS takes_draw BOOLEAN NOT NULL DEFAULT true');
  console.log('dev DDL applied');
  await pool.end();
})();"
```

Expected: `dev DDL applied`.

- [ ] **Step 3: write the failing tests**

The suite's existing fixtures create `users` rows only (no `contractor_profiles`), and its `afterEach` deletes only the single fixture payout before deleting the period, so the new tests need BOTH a fixture extension and a period-scoped teardown or the period delete FK-violates (plan-fleet finding).

Extend the `before` hook in `server/utils/payrollProcessing.test.js`:

```js
let flaggedId, cpDefaultId, profilelessId;
// ...inside before(), after the existing user insert:
const mkUser = (e) => pool.query(
  "INSERT INTO users (email, password_hash, role) VALUES ($1,'x','staff') RETURNING id", [e]
);
flaggedId = (await mkUser('proc-flagged@example.com')).rows[0].id;
cpDefaultId = (await mkUser('proc-cpdefault@example.com')).rows[0].id;
profilelessId = (await mkUser('proc-noprofile@example.com')).rows[0].id;
// flagged = owner shape; cpDefault = profile row with the default flag;
// profilelessId deliberately gets NO contractor_profiles row.
await pool.query('INSERT INTO contractor_profiles (user_id, takes_draw) VALUES ($1, false)', [flaggedId]);
await pool.query('INSERT INTO contractor_profiles (user_id) VALUES ($1)', [cpDefaultId]);
```

Also extend the `before` pre-clean and the `after` hook to delete the three new emails' `contractor_profiles` + `users` rows (mirror the existing single-user cleanup), and replace the `afterEach` payout cleanup with a period-scoped one so ensurePayout-created rows never strand the period delete:

```js
afterEach(async () => {
  await pool.query(
    'DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE pay_period_id = $1)',
    [periodId]
  );
  await pool.query('DELETE FROM payouts WHERE pay_period_id = $1', [periodId]);
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [periodId]);
});
```

Then the tests:

```js
test('ensurePayout > births pending for a contractor with the default flag', async () => {
  const id = await ensurePayout(pool, periodId, cpDefaultId);
  const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'pending');
});

test('ensurePayout > births no_draw when takes_draw = false', async () => {
  const id = await ensurePayout(pool, periodId, flaggedId);
  const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'no_draw');
});

test('ensurePayout > upsert never rewrites an existing status', async () => {
  const first = await ensurePayout(pool, periodId, cpDefaultId); // born pending
  await pool.query('UPDATE contractor_profiles SET takes_draw = false WHERE user_id = $1', [cpDefaultId]);
  try {
    const second = await ensurePayout(pool, periodId, cpDefaultId);
    assert.equal(second, first);
    const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [first]);
    assert.equal(rows[0].status, 'pending');
  } finally {
    await pool.query('UPDATE contractor_profiles SET takes_draw = true WHERE user_id = $1', [cpDefaultId]);
  }
});

test('ensurePayout > no contractor_profiles row defaults to pending', async () => {
  const id = await ensurePayout(pool, periodId, profilelessId);
  const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'pending');
});
```

- [ ] **Step 4: run to verify they fail**

Run: `node -r dotenv/config --test server/utils/payrollProcessing.test.js`
Expected: FAIL, `ensurePayout is not a function` (or not exported).

- [ ] **Step 5: implement `ensurePayout`**

In `server/utils/payrollProcessing.js`, above `maybeFinalizePeriod`:

```js
/**
 * THE single payout-creation path (spec 2026-08-07). Upserts the contractor's
 * payout for the period and returns its id. A contractor whose
 * contractor_profiles.takes_draw is false gets a payout born 'no_draw'
 * (owner rows: tracked, never owed). The ON CONFLICT arm deliberately touches
 * only pay_period_id (a no-op, to get RETURNING) so an EXISTING row's status
 * is never rewritten here; pending <-> no_draw flips go through the
 * toggle-draw route only. No contractor_profiles row = takes_draw true.
 */
async function ensurePayout(executor, payPeriodId, contractorId) {
  const { rows } = await executor.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status)
     VALUES ($1, $2,
       CASE WHEN COALESCE(
         (SELECT takes_draw FROM contractor_profiles WHERE user_id = $2), true)
       THEN 'pending' ELSE 'no_draw' END)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE
       SET pay_period_id = EXCLUDED.pay_period_id
     RETURNING id`,
    [payPeriodId, contractorId]
  );
  return rows[0].id;
}
```

Add `ensurePayout` to the module.exports object.

- [ ] **Step 6: run to verify they pass**

Run: `node -r dotenv/config --test server/utils/payrollProcessing.test.js`
Expected: PASS (all, including the pre-existing findOpenPeriodForDate/recompute/finalize tests).

- [ ] **Step 7: commit**

```bash
git add server/db/schema.sql server/utils/payrollProcessing.js server/utils/payrollProcessing.test.js
git commit -m "feat(payroll): no_draw payout status + ensurePayout single creation path"
```

---

### Task 2: Swap the four insert sites onto `ensurePayout`

**Files:**
- Modify: `server/utils/payrollAccrual.js:460-467`
- Modify: `server/utils/payrollLateTip.js:148-155`
- Modify: `server/utils/payrollClawback.js:176-183`
- Modify: `server/utils/dutyLines.js:493-500`

**Interfaces:**
- Consumes: `ensurePayout(executor, payPeriodId, contractorId)` from Task 1.

- [ ] **Step 1: replace each inline upsert**

All four sites hold this exact statement (variable names differ):

```js
const payoutRes = await client.query(
  `INSERT INTO payouts (pay_period_id, contractor_id)
   VALUES ($1, $2)
   ON CONFLICT (pay_period_id, contractor_id) DO UPDATE
     SET pay_period_id = EXCLUDED.pay_period_id
   RETURNING id`,
  [payPeriodId, w.user_id]
);
const payoutId = payoutRes.rows[0].id;
```

Replace with:

```js
const payoutId = await ensurePayout(client, payPeriodId, w.user_id);
```

Per file: `payrollAccrual.js` uses `(payPeriodId, w.user_id)`; `payrollLateTip.js` uses `(period.id, userId)`; `payrollClawback.js` uses `(period.id, userId)`; `dutyLines.js` `openPeriodPayout` uses `(period.id, contractorId)` and returns the id. Each file imports it from `./payrollProcessing` (payrollAccrual and dutyLines already require that module for other helpers; extend the destructure. lateTip/clawback: add the require if absent).

Check `dutyLines.js` for a require-cycle: `payrollProcessing.js` must NOT require `dutyLines.js` at module top (it doesn't today; keep it that way).

- [ ] **Step 2: run the suites these files reach**

One at a time, from repo root:

```bash
node -r dotenv/config --test server/utils/payrollAccrual.test.js
node -r dotenv/config --test server/utils/payrollAccrual.sweepPreserve.test.js
node -r dotenv/config --test server/utils/payrollAccrual.duty.test.js
node -r dotenv/config --test server/utils/payrollLateTip.test.js
node -r dotenv/config --test server/utils/payrollClawback.test.js
node -r dotenv/config --test server/utils/dutyLines.test.js
```

Expected: PASS each (behavior identical for takes_draw=true contractors, which is all existing fixtures).

- [ ] **Step 3: pin the accrual path (plan-fleet suggestion)**

One fixture test in `server/utils/payrollAccrual.test.js` so the swap can never silently regress to an inline insert: clone the suite's smallest happy-path accrual fixture (contractor + proposal + shift + open period), give that contractor a `contractor_profiles` row with `takes_draw = false`, run the suite's accrual entry point exactly as the neighboring tests do, then:

```js
const { rows } = await pool.query(
  'SELECT status FROM payouts WHERE pay_period_id = $1 AND contractor_id = $2',
  [periodId, flaggedContractorId]
);
assert.equal(rows[0].status, 'no_draw', 'accrual births no_draw for a flagged contractor');
```

(Follow that file's existing fixture/teardown helpers verbatim; the assertion above is the only new idea.)

- [ ] **Step 4: run to verify**

Run: `node -r dotenv/config --test server/utils/payrollAccrual.test.js`
Expected: PASS including the new pin.

- [ ] **Step 5: commit**

```bash
git add server/utils/payrollAccrual.js server/utils/payrollAccrual.test.js server/utils/payrollLateTip.js server/utils/payrollClawback.js server/utils/dutyLines.js
git commit -m "refactor(payroll): all payout creation through ensurePayout"
```

---

### Task 3: Finalize regression + empty-stub deletes + mark-paid guard message

**Files:**
- Modify: `server/utils/payrollAccrual.js:262-266` and `:667-671` (the two empty-stub DELETEs)
- Modify: `server/routes/admin/payroll.js` (mark-paid guard, ~line 525)
- Test: `server/utils/payrollProcessing.test.js`, `server/routes/admin/payroll.test.js`

**Interfaces:**
- Consumes: `maybeFinalizePeriod(executor, periodId)` (unchanged behavior, newly proven against no_draw).

- [ ] **Step 1: write the failing/regression tests**

NOTE (plan-fleet): `payroll.test.js` has NO supertest. Its harness is a local `req(method, path, token, body)` helper over `node:http` (lines ~165-186) returning `{ status, body }` where `body` is a raw JSON STRING every test `JSON.parse`s. All route-test snippets below use that idiom; mirror the file's existing 409 assertions for the error envelope.

In `payrollProcessing.test.js` (pool-level, uses the Task 1 fixtures):

```js
test('maybeFinalizePeriod > no_draw payouts do not block the flip', async () => {
  await pool.query("UPDATE pay_periods SET status = 'processing' WHERE id = $1", [periodId]);
  await pool.query("UPDATE payouts SET status = 'paid', paid_at = NOW() WHERE id = $1", [payoutId]);
  await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, 'no_draw', 5000)`,
    [periodId, flaggedId]
  );
  const flipped = await maybeFinalizePeriod(pool, periodId);
  assert.equal(flipped, true);
  const { rows } = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [periodId]);
  assert.equal(rows[0].status, 'paid');
});
```

In `payroll.test.js` (self-seeding, try/finally cleanup, the file's idiom):

```js
test('mark-paid > refuses a no_draw payout with a status-aware 409', async () => {
  const pp = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2019-07-02','2019-07-08','2019-07-09','processing')
     ON CONFLICT (start_date) DO UPDATE SET status = 'processing' RETURNING id`
  );
  const ppId = pp.rows[0].id;
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, 'no_draw', 1000) RETURNING id`,
    [ppId, contractorId]
  );
  try {
    const r = await req('POST', `/api/admin/payroll/payouts/${po.rows[0].id}/mark-paid`, adminToken,
      { payment_method: 'other' });
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.body).error, /no_draw/);
  } finally {
    await pool.query('DELETE FROM payouts WHERE id = $1', [po.rows[0].id]);
    await pool.query(
      `DELETE FROM pay_periods pp WHERE pp.id = $1
         AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = pp.id)`,
      [ppId]
    );
  }
});
```

Also pin line editability (plan-fleet suggestion: the freeze guards are `=== 'paid'` today; this test catches anyone later tightening them to `=== 'pending'`): duplicate the suite's existing happy-path line-PATCH test verbatim, but seed the payout as `status = 'no_draw'` in an OPEN period; expect the same 200 + recomputed total the pending version gets.

Run both suites; the finalize and editability tests prove existing behavior once seeded correctly; the mark-paid test FAILS on the message (`payout is already paid`).

- [ ] **Step 2: status-aware mark-paid message**

In `payroll.js` (~line 525) replace:

```js
    if (rows[0].payout_status !== 'pending') {
      await client.query('ROLLBACK');
      throw new ConflictError('payout is already paid');
    }
```

with:

```js
    if (rows[0].payout_status !== 'pending') {
      await client.query('ROLLBACK');
      throw new ConflictError(
        rows[0].payout_status === 'no_draw'
          ? 'payout is no_draw; convert it to pending before paying'
          : 'payout is already paid'
      );
    }
```

- [ ] **Step 3: extend the two empty-stub DELETEs**

Both DELETEs in `payrollAccrual.js` (lines ~262 and ~667) change one predicate. An emptied no_draw payout is the same phantom stub as an emptied pending one (it has no payment record; only `paid` rows are memory worth keeping):

```sql
WHERE po.id = ANY($1) AND po.status IN ('pending', 'no_draw')
```

(replacing `AND po.status = 'pending'` in each; keep the two NOT EXISTS clauses untouched).

- [ ] **Step 4: run to verify**

```bash
node -r dotenv/config --test server/utils/payrollProcessing.test.js
node -r dotenv/config --test server/routes/admin/payroll.test.js
node -r dotenv/config --test server/utils/payrollAccrual.test.js
node -r dotenv/config --test server/utils/payrollAccrual.sweepPreserve.test.js
```

Expected: PASS.

- [ ] **Step 5: commit**

```bash
git add server/utils/payrollAccrual.js server/routes/admin/payroll.js server/utils/payrollProcessing.test.js server/routes/admin/payroll.test.js
git commit -m "feat(payroll): no_draw-aware stub cleanup, finalize regression, mark-paid guard message"
```

---

### Task 4: Toggle-draw route

**Files:**
- Modify: `server/routes/admin/payroll.js` (new route after mark-paid; also `loadPeriodWithPayouts` projection)
- Test: `server/routes/admin/payroll.test.js`

**Interfaces:**
- Produces: `POST /api/admin/payroll/payouts/:id/toggle-draw` -> `{ payout: { id, status, total_cents }, period_status }`. UI lane consumes it.
- Produces: `loadPeriodWithPayouts` payouts gain `takes_draw` (boolean) for the UI's park-button gating.

- [ ] **Step 1: write the failing tests**

In `payroll.test.js`, using the file's `req()` helper (see the Task 3 note) and a shared self-seeding helper local to these tests:

```js
// Seed a period + one payout for the fixture contractor; caller cleans up.
async function seedToggleFixture(periodStatus, payoutStatus, startDate) {
  // startDate must be unique per test (ON CONFLICT keys on start_date).
  const pp = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, ($1::date + 6), ($1::date + 7), $2)
     ON CONFLICT (start_date) DO UPDATE SET status = $2 RETURNING id`,
    [startDate, periodStatus]
  );
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, $3, 2000)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET status = $3
     RETURNING id`,
    [pp.rows[0].id, contractorId, payoutStatus]
  );
  return { ppId: pp.rows[0].id, poId: po.rows[0].id };
}
async function cleanToggleFixture({ ppId }) {
  await pool.query('DELETE FROM payouts WHERE pay_period_id = $1', [ppId]);
  await pool.query('DELETE FROM pay_periods WHERE id = $1', [ppId]);
}

test('toggle-draw > pending -> no_draw and back', async () => {
  const fx = await seedToggleFixture('open', 'pending', '2019-08-06');
  try {
    let r = await req('POST', `/api/admin/payroll/payouts/${fx.poId}/toggle-draw`, adminToken, {});
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).payout.status, 'no_draw');
    r = await req('POST', `/api/admin/payroll/payouts/${fx.poId}/toggle-draw`, adminToken, {});
    assert.equal(JSON.parse(r.body).payout.status, 'pending');
  } finally { await cleanToggleFixture(fx); }
});

test('toggle-draw > refuses a paid payout', async () => {
  const fx = await seedToggleFixture('processing', 'paid', '2019-08-13');
  try {
    const r = await req('POST', `/api/admin/payroll/payouts/${fx.poId}/toggle-draw`, adminToken, {});
    assert.equal(r.status, 409);
  } finally { await cleanToggleFixture(fx); }
});

test('toggle-draw > refuses when the period is paid', async () => {
  const fx = await seedToggleFixture('paid', 'no_draw', '2019-08-20');
  try {
    const r = await req('POST', `/api/admin/payroll/payouts/${fx.poId}/toggle-draw`, adminToken, {});
    assert.equal(r.status, 409);
  } finally { await cleanToggleFixture(fx); }
});

test('toggle-draw > parking the last pending payout of a processing period finalizes it', async () => {
  // processing period whose ONLY payout is the fixture contractor's pending one
  const fx = await seedToggleFixture('processing', 'pending', '2019-08-27');
  try {
    const r = await req('POST', `/api/admin/payroll/payouts/${fx.poId}/toggle-draw`, adminToken, {});
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.payout.status, 'no_draw');
    assert.equal(body.period_status, 'paid');
  } finally { await cleanToggleFixture(fx); }
});
```

Run: `node -r dotenv/config --test server/routes/admin/payroll.test.js`
Expected: FAIL with 404s (route missing).

- [ ] **Step 2: implement the route**

In `payroll.js`, after the mark-paid route:

```js
// Flip a payout between 'pending' (owed, payable) and 'no_draw' (owner row:
// tracked, never owed). Spec 2026-08-07. Guards mirror mark-paid: row-locked,
// unpaid only, period not 'paid'. Parking the LAST pending payout of a
// processing period runs the same finalize check as mark-paid so the period
// closes; un-parking in a processing period makes the pay panel live again.
router.post('/payroll/payouts/:id/toggle-draw', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new ValidationError(null, 'invalid payout id');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT po.id, po.status AS payout_status, po.pay_period_id,
              pp.status AS period_status
         FROM payouts po
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE po.id = $1
        FOR UPDATE OF po, pp`,
      [id]
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      throw new NotFoundError('payout not found');
    }
    const row = rows[0];
    if (row.payout_status === 'paid') {
      await client.query('ROLLBACK');
      throw new ConflictError('payout is already paid');
    }
    if (row.period_status === 'paid') {
      await client.query('ROLLBACK');
      throw new ConflictError('period is paid; nothing to toggle');
    }
    const next = row.payout_status === 'pending' ? 'no_draw' : 'pending';
    await client.query(
      `UPDATE payouts SET status = $1 WHERE id = $2`,
      [next, id]
    );
    const finalized = next === 'no_draw'
      ? await maybeFinalizePeriod(client, row.pay_period_id)
      : false;
    await client.query('COMMIT');

    // Post-COMMIT reads on the client we already hold (one-connection rule).
    const refreshed = await client.query(
      `SELECT id, contractor_id, status, total_cents FROM payouts WHERE id = $1`, [id]
    );
    const period = await client.query(
      `SELECT status FROM pay_periods WHERE id = $1`, [row.pay_period_id]
    );
    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: refreshed.rows[0].contractor_id,
      action: 'payout_toggle_draw',
      metadata: { payout_id: id, status: next, finalized },
    });
    res.json({
      payout: refreshed.rows[0],
      period_status: finalized ? 'paid' : period.rows[0].status,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  } finally {
    client.release();
  }
}));
```

(`logAdminAction` is already imported in this file for the reopen route; verify and reuse the same import.)

File-size note (plan-fleet): `payroll.js` is 772 lines, already past the 700 soft cap; Tasks 3+4 grow it to ~840. The pre-commit hook will WARN ("plan a split") but not block (hard cap is 1000). Proceed through the warning; do not stall on it and do not attempt a split inside this lane.

- [ ] **Step 3: project `takes_draw` in `loadPeriodWithPayouts`**

In the payouts SELECT (~line 31), add one column to the projection:

```sql
            COALESCE(cp.takes_draw, true) AS takes_draw,
```

(cp is already LEFT JOINed there.)

- [ ] **Step 4: run to verify**

Run: `node -r dotenv/config --test server/routes/admin/payroll.test.js`
Expected: PASS.

- [ ] **Step 5: 1099 exclusion regression test (route-level, plan-fleet cross-confirmed fix)**

Pin the actual code path, not an equivalent SQL sum: `paidPayoutCents` lives in `server/routes/admin/payrollTax.js:40-44` and feeds `GET /api/admin/payroll/contractors/:userId/payment-history` (`blended_total_cents`). Add to `server/routes/admin/payrollTax.legalName.test.js` (its `req(method, path, body)` helper auto-parses JSON and auto-attaches the admin token):

```js
test('payment-history blended total ignores no_draw payouts', async () => {
  const pp = await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ('2019-09-03','2019-09-09','2019-09-10','paid')
     ON CONFLICT (start_date) DO UPDATE SET status = 'paid' RETURNING id`
  );
  const po = await pool.query(
    `INSERT INTO payouts (pay_period_id, contractor_id, status, total_cents)
     VALUES ($1, $2, 'no_draw', 12345)
     ON CONFLICT (pay_period_id, contractor_id) DO UPDATE SET status = 'no_draw', total_cents = 12345
     RETURNING id`,
    [pp.rows[0].id, contractorUserId] // the suite's existing contractor fixture
  );
  try {
    const before = await req('GET', `/api/admin/payroll/contractors/${contractorUserId}/payment-history`);
    assert.equal(before.status, 200);
    // The no_draw 12345 cents must be absent from the blended (ledger + PAID) total.
    const paidOnly = await pool.query(
      `SELECT COALESCE(SUM(total_cents),0)::bigint AS cents
         FROM payouts WHERE contractor_id = $1 AND status = 'paid'`,
      [contractorUserId]
    );
    const ledger = before.body.total_cents;
    assert.equal(before.body.blended_total_cents, ledger + Number(paidOnly.rows[0].cents));
  } finally {
    await pool.query('DELETE FROM payouts WHERE id = $1', [po.rows[0].id]);
    await pool.query(
      `DELETE FROM pay_periods p WHERE p.id = $1
         AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = p.id)`,
      [pp.rows[0].id]
    );
  }
});
```

(Adapt the contractor fixture variable name to the suite's own; if the suite's user is admin-only, seed a contractor the way its sibling tests do.)

Run: `node -r dotenv/config --test server/routes/admin/payrollTax.legalName.test.js`
Expected: PASS.

- [ ] **Step 6: commit**

```bash
git add server/routes/admin/payroll.js server/routes/admin/payroll.test.js server/routes/admin/payrollTax.legalName.test.js
git commit -m "feat(payroll): toggle-draw route + takes_draw projection + 1099 exclusion pin"
```

- [ ] **Step 7: intra-lane review checkpoint (plan-fleet suggestion)**

After Tasks 2-4 are committed (the creation-path swap + stub-DELETE predicate + new route are the lane's riskiest batch), run `consistency-check` + `database-review` agents on the lane's diff so far, before building Task 4b on top. Findings fix-first, then continue.

---

### Task 4b: Staff portal server: blended total counts no_draw + list pin

**Files:**
- Modify: `server/routes/staffPortal/payouts.js:100-104` (the paid-sum inside `GET /api/me/payment-history`)
- Test: `server/routes/staffPortal/payouts.test.js`

**Interfaces:**
- Consumes: nothing new (pure SQL predicate change).
- Produces: `/api/me/payment-history` `blended_total_cents` now = imported ledger + payouts with `status IN ('paid','no_draw')`. `/api/me/payouts` continues returning every status (no change; pinned here).

Decision context (Dallas, 2026-08-07): the staff page presents the owner's rows as-if-paid, so the all-time blended total counts `no_draw` too. This deliberately DIVERGES from the admin tax surface (`payrollTax.js` `paidPayoutCents`), which stays strictly `'paid'`: 1099 money is real money only.

- [ ] **Step 1: write the failing tests**

In `server/routes/staffPortal/payouts.test.js` (its helper is `request(method, path, { token })`; fixtures already build userA with a paid payout, a period keyed by fixed dates, and ON CONFLICT-guarded inserts; mirror that style). Seed in the `before` hook a second, `no_draw` payout for userA in its own fixed-date period (e.g. `'2025-12-15'..'2025-12-21'`, payday `'2025-12-22'`, period status `'paid'`, total_cents 7000), with matching cleanup in `after`:

```js
test('GET /me/payouts > includes no_draw rows with their status', async () => {
  const res = await request('GET', '/api/me/payouts', { token: tokenA });
  assert.equal(res.status, 200);
  const row = res.body.payouts.find(p => p.id === noDrawPayoutId);
  assert.ok(row, 'no_draw payout is listed');
  assert.equal(row.status, 'no_draw');
});

test('GET /me/payment-history > blended total counts no_draw as-if-paid', async () => {
  const res = await request('GET', '/api/me/payment-history', { token: tokenA });
  assert.equal(res.status, 200);
  // ledger + paid (30000) + no_draw (7000)
  assert.equal(res.body.blended_total_cents, res.body.total_cents + 30000 + 7000);
});
```

Run: `node -r dotenv/config --test server/routes/staffPortal/payouts.test.js`
Expected: the list pin PASSES already (endpoint has no status filter; this pins it); the blended test FAILS (7000 missing).

- [ ] **Step 2: implement**

In `payouts.js` `GET /payment-history`, change the paid-sum predicate and its comment:

```js
    // Own OS payouts counted as-if-paid: 'paid' plus the owner's 'no_draw'
    // rows (spec 2026-08-07; staff-facing only — 1099/tax stays strictly paid).
    const paidRes = await pool.query(
      `SELECT COALESCE(SUM(total_cents), 0)::bigint AS cents
         FROM payouts
        WHERE contractor_id = $1 AND status IN ('paid', 'no_draw')`,
      [req.user.id]
    );
```

- [ ] **Step 3: run to verify**

```bash
node -r dotenv/config --test server/routes/staffPortal/payouts.test.js
node -r dotenv/config --test server/routes/staffPortal/payouts.paystub.test.js
node -r dotenv/config --test server/routes/staffPortal.test.js
```

Expected: PASS all three (the paystub suite pins that a non-paid payout still 409s the PDF; staffPortal.test.js is the suite the spec's §6 names).

- [ ] **Step 4: commit**

```bash
git add server/routes/staffPortal/payouts.js server/routes/staffPortal/payouts.test.js
git commit -m "feat(staff-pay): blended all-time total counts no_draw as-if-paid; /me/payouts no_draw pin"
```

---

### Task 5: Docs

**Files:**
- Modify: `ARCHITECTURE.md` (route table: toggle-draw; schema section: payouts.status values, contractor_profiles.takes_draw)
- Modify: `README.md` (only if the folder tree or scripts changed; expected: no change)

- [ ] **Step 1: add the route-table row and schema notes, mirroring the mark-paid row's wording**
- [ ] **Step 2: commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs: no_draw payout status + toggle-draw route"
```

---

### Task 6: Admin pay-run UI (PayoutRow, PayRunView)

**Files:**
- Modify: `client/src/pages/admin/payroll/PayoutRow.js`
- Modify: `client/src/pages/admin/payroll/PayRunView.js`

**Interfaces:**
- Consumes: `payout.status` now includes `'no_draw'`; `payout.takes_draw` boolean; `POST /admin/payroll/payouts/:id/toggle-draw` -> `{ payout, period_status }`.

- [ ] **Step 1: PayoutRow rendering**

In `PayoutRow.js`:

```js
  const isPaid = payout.status === 'paid';
  const isNoDraw = payout.status === 'no_draw';
```

Grey the whole card (outer div, line ~71):

```jsx
    <div className="card" style={{ marginBottom: 8, ...(isNoDraw ? { opacity: 0.6 } : {}) }}>
```

Status chip (line ~96):

```jsx
          {isPaid
            ? <StatusChip kind="ok">Paid</StatusChip>
            : isNoDraw
              ? <StatusChip kind="neutral">No draw</StatusChip>
              : <StatusChip kind="info">Pending</StatusChip>}
```

Pay button and PayPanel gate on pending only (two sites, lines ~99 and ~203):

```jsx
          {payable && payout.status === 'pending' && ( /* Pay button */ )}
...
          {payable && payout.status === 'pending' && (
            <PayPanel payout={payout} period={period} onPaid={onPaid} onDrift={onRefetch} />
          )}
```

Line/duty editability is freeze-based and already correct (`editable && !isPaid` stays as-is; a no_draw row edits like pending while the period is open/reopened).

- [ ] **Step 2: toggle action in the expansion**

Inside the expanded card-body, after the "Payout total" row, add:

```jsx
            {payable && !isPaid && (isNoDraw || payout.takes_draw === false) && (
              <div className="hstack" style={{ gap: 8, paddingTop: 8 }}>
                <button
                  type="button" className="btn btn-ghost btn-sm" disabled={toggleBusy}
                  onClick={toggleDraw}
                >
                  {isNoDraw ? 'Convert to payable' : 'Park as no-draw'}
                </button>
                <span className="tiny muted">
                  {isNoDraw
                    ? 'Makes this payout owed and payable again.'
                    : 'Tracks it without owing it.'}
                </span>
              </div>
            )}
```

with the handler + state near the other handlers. ENGINE CHANGE (fleet review, built): a park that would CLOSE a processing period 409s without `confirm_finalize: true` — the handler confirms and retries, mirroring the runProcess force pattern:

```js
  const [toggleBusy, setToggleBusy] = useState(false);
  const toggleDraw = async (confirm = false) => {
    setToggleBusy(true);
    try {
      await api.post(`/admin/payroll/payouts/${payout.id}/toggle-draw`,
        confirm ? { confirm_finalize: true } : {});
      // Status + rollups (owed, possibly period close) changed: full refetch.
      onRefetch?.();
    } catch (err) {
      const msg = String(err.message || '');
      if (err.status === 409 && msg.includes('confirm')) {
        // One-way door: parking the last pending payout closes the period.
        const go = window.confirm('Parking this payout closes the period for good (no reopen). Continue?');
        if (go) { setToggleBusy(false); return toggleDraw(true); }
        return;
      }
      toast.error(msg);
      if (err.status === 409) onRefetch?.();
    } finally {
      setToggleBusy(false);
    }
  };
```

Gating logic: the convert-to-payable button shows on every no_draw row; the park button shows only for a takes_draw=false contractor (nobody else's pending rows grow a park affordance).

- [ ] **Step 3: PayRunView owed-delta skip**

In `handleLineSaved` and `handleDutyChanged`, the owed rollup must not move for a no_draw payout (its total is not in `owed_cents`). In BOTH handlers, wrap only the `onOwedDelta` call:

```js
    if (before) {
      if (before.status !== 'no_draw') {
        onOwedDelta(period.id, payoutTotal - Number(before.total_cents || 0));
      }
      detailRef.current = { /* unchanged total-patching */ };
    }
```

(The detailRef/setDetail total patching still runs for no_draw rows so the on-screen tracked total stays true.)

Note: `onRefetch` (used by toggleDraw) already exists on PayoutRow and maps to `loadDetail(); onQueueChanged();` in PayRunView; History passes none, and History renders `payable={false}` so the toggle never shows there. No PayRunView wiring change needed for the toggle.

- [ ] **Step 4: verify (build + behavioral walk, plan-fleet fix)**

Run: `cd client && CI=true npx react-scripts build` -> exit 0, no ESLint warnings.

Then a local browser walk BEFORE merge (the CI build proves compilation only; this is a money-display seam). Dev server is the Claude-managed background process — restart it after the server-side lane merge so the toggle route exists. Against the dev DB: seed a `takes_draw = false` contractor + a payout via SQL, then in the admin payroll page verify: (1) the row renders greyed with the "No draw" chip and NO Pay button; (2) expanding shows lines and the "Convert to payable" action; (3) toggling flips it live (chip -> Pending, Pay button appears, owed stat moves); (4) a line edit on the no_draw row updates the row total but does NOT move the "Still owed" stat. Clean up the seeded rows after.

- [ ] **Step 5: commit**

```bash
git add client/src/pages/admin/payroll/PayoutRow.js client/src/pages/admin/payroll/PayRunView.js
git commit -m "feat(payroll-ui): no_draw rows greyed, pay affordances gated, toggle-draw action, owed-delta skip"
```

---

### Task 7: History shows genuinely-paid money only

**Files:**
- Modify: `client/src/pages/admin/payroll/HistoryView.js`

**Interfaces:**
- Consumes: `GET /admin/payroll/periods` rollup fields `paid_cents` (already returned).

- [ ] **Step 1: list row dollar figure**

Line ~157, replace `p.total_cents` with `p.paid_cents`:

```jsx
            <div className="num"><strong>{fmt$fromCents(p.paid_cents)}</strong></div>
```

- [ ] **Step 2: drill-in "Total paid"**

Line ~83, sum paid rows only:

```js
    const totalPaid = payouts
      .filter(po => po.status === 'paid')
      .reduce((s, po) => s + Number(po.total_cents || 0), 0);
```

The no_draw row itself still renders in the drill-in via PayoutRow (greyed by Task 6), read-only as History already is.

- [ ] **Step 3: verify + commit**

Run: `cd client && CI=true npx react-scripts build` -> exit 0.

```bash
git add client/src/pages/admin/payroll/HistoryView.js
git commit -m "fix(payroll-ui): history figures count genuinely-paid only"
```

---

### Task 8: Staff Pay page + detail (dallas@ account)

**Files:**
- Modify: `client/src/pages/staff/PayPage.js`
- Modify: `client/src/pages/staff/PayoutDetail.js`

**Interfaces:**
- Consumes: `/me/payouts` list rows with `status: 'no_draw'` (server already returns every status; zero server change).

- [ ] **Step 1: PayPage list + YTD**

Around line ~187:

```js
  const paidPayouts = payouts.filter((p) => p.status === 'paid');
  // Owner rows: tracked as if paid (spec 2026-08-07). Everyone else has none.
  const listPayouts = payouts.filter((p) => p.status === 'paid' || p.status === 'no_draw');
  ...
  const ytdCents = computeYtdCents(listPayouts);
```

Empty-state gate (line ~214): swap `paidPayouts.length === 0` for `listPayouts.length === 0`.

Paystubs section (lines ~347-377): iterate `listPayouts` instead of `paidPayouts` (both gates), and in the row foot:

```jsx
                <span>
                  {pp.status === 'no_draw'
                    ? 'Not drawn'
                    : `Paid ${fmtShortDate(pp.paid_at) || '—'}`}
                  {Number.isFinite(pp.event_count) && (
                    <> {' · '}{pp.event_count} event{pp.event_count !== 1 ? 's' : ''}</>
                  )}
                </span>
```

Grey the no_draw row: `className={'sp-paystub' + (pp.status === 'no_draw' ? ' sp-paystub-nodraw' : '')}` and add to `index.css`:

```css
.sp-paystub-nodraw { opacity: 0.6; }
```

`computeYtdCents` needs no logic change (payday-year over whatever list it receives); rename its parameter to `payoutsForYtd` for honesty.

The current-period banner (line ~112 `p.status !== 'paid'`) already matches a no_draw current-week payout and keeps showing this week's accrual; leave it.

- [ ] **Step 2: PayoutDetail chip + copy**

`PayoutDetail.js` already renders non-paid periods as "Period preview / Projected total". Add a third state:

```js
  const isPaid = payout.status === 'paid';
  const isNoDraw = payout.status === 'no_draw';
```

Heading (line ~195): `{isPaid ? 'Paystub' : isNoDraw ? 'Pay record' : 'Period preview'}`.
Total label (line ~210): `{isPaid ? 'Paid total' : isNoDraw ? 'Tracked total' : 'Projected total'}`.
Chip (lines ~212-220): for no_draw render `<span className="sp-chip neutral"><span className="sp-chip-dot" />Not drawn</span>` — the neutral variant is the explicit `.sp-chip.neutral` class (index.css ~14724), NOT the bare `sp-chip` (plan-fleet fix).
Confirm the paystub download affordance is gated on `isPaid` (the server 409s regardless; the button should not show).

The blended all-time total on this page needs NO client change: it renders `blended_total_cents` straight from `/me/payment-history`, which Task 4b already teaches to count no_draw.

- [ ] **Step 3: verify (build + staff-portal walk)**

Run: `cd client && CI=true npx react-scripts build` -> exit 0.

Local staff-portal walk (host-gating override + client/.env API base per the staff-portal local-review recipe): log in as a dev staff account owning a seeded no_draw payout; verify the Pay page lists the week greyed as "Not drawn", YTD includes it, drill-in shows "Pay record"/"Tracked total"/"Not drawn" chip and no paystub button.

- [ ] **Step 4: commit**

```bash
git add client/src/pages/staff/PayPage.js client/src/pages/staff/PayoutDetail.js client/src/index.css
git commit -m "feat(staff-pay): owner no_draw rows listed as Not drawn, YTD as-if-paid"
```

---

### Task 9: Admin userDetail PayoutsTab chip

**Files:**
- Modify: `client/src/pages/admin/userDetail/tabs/PayoutsTab.js:92`

- [ ] **Step 1: three-way chip**

```jsx
                <span className={`chip ${po.status === 'paid' ? 'ok' : po.status === 'no_draw' ? 'neutral' : 'info'}`}>
                  {po.status === 'no_draw' ? 'no draw' : po.status}
                </span>
```

(The neutral variant is the explicit `.chip.neutral` class, index.css ~12734 — a bare `chip` is NOT it; plan-fleet fix.)

- [ ] **Step 2: verify + commit**

Run: `cd client && CI=true npx react-scripts build` -> exit 0.

```bash
git add client/src/pages/admin/userDetail/tabs/PayoutsTab.js
git commit -m "feat(payroll-ui): no_draw chip on the contractor payouts tab"
```

---

## Ship time (NOT a lane; runs at push, prod DDL + backfill BEFORE the push)

Per the display-name precedent: prod schema + backfill land before the code deploys. Run via Neon MCP against project `round-tooth-34649976` default branch, each step confirmed with Dallas watching:

- [ ] **0. Verify prod state first (spec §1 requirement, plan-fleet blocker fix)**

```sql
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'payouts'::regclass AND contype = 'c';
```

Expected: exactly ONE row, `payouts_status_check | CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text])))` (matched live 2026-08-07). If the name differs, use THAT name in step 1's DROP; if extra CHECK rows exist, stop and reconcile before any write. Then re-verify the backfill targets:

```sql
SELECT po.id, po.status, po.total_cents, pp.id AS period, pp.status AS period_status
  FROM payouts po JOIN pay_periods pp ON pp.id = po.pay_period_id
 WHERE po.contractor_id = 12 ORDER BY pp.start_date;
```

Expected: exactly payouts 80 (period 72, processing), 83 (76, processing), 92 (80, processing), 98 (89, open), all `pending`. Any drift (a new week accrued, a row already handled): adjust the id list deliberately, never blindly.

- [ ] **1. DDL (safe before deploy: old code never writes 'no_draw')**

```sql
ALTER TABLE payouts DROP CONSTRAINT IF EXISTS payouts_status_check;
ALTER TABLE payouts ADD CONSTRAINT payouts_status_check
  CHECK (status IN ('pending','no_draw','paid'));
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS takes_draw BOOLEAN NOT NULL DEFAULT true;
```

- [ ] **2. Flag + backfill (id-pinned, status-guarded)**

```sql
UPDATE contractor_profiles SET takes_draw = false WHERE user_id = 12;
UPDATE payouts SET status = 'no_draw'
 WHERE id IN (80, 83, 92, 98) AND contractor_id = 12 AND status = 'pending';
```

Expected: 1 row, then 4 rows.

- [ ] **3. Close period 72 (Dallas was its only pending)**

```sql
UPDATE pay_periods pp SET status = 'paid'
 WHERE pp.id = 72 AND pp.status = 'processing'
   AND NOT EXISTS (SELECT 1 FROM payouts WHERE pay_period_id = 72 AND status = 'pending');
```

Expected: 1 row. Periods 76/80 intentionally untouched (Debbie L., Kevin D. still genuinely pending); period 89 stays open.

- [ ] **4. Verify**

```sql
SELECT po.id, po.status, pp.id AS period, pp.status AS period_status
  FROM payouts po JOIN pay_periods pp ON pp.id = po.pay_period_id
 WHERE po.contractor_id = 12 ORDER BY pp.start_date;
```

Expected: 4 rows all `no_draw`; period 72 `paid`.

- [ ] **5. Push** (normal push gate: full fleet on the payroll commits + second-opinion, both lanes are sensitive-path)

- [ ] **6. Post-deploy walk**: Payroll page: queue shows 89/80/76 (newest first, no 72), Dallas rows greyed "No draw", stats exclude him, toggle round-trips on one row; History shows 72 with paid-only figures in both the list row and drill-in; contractor profile PayoutsTab shows the "no draw" chip; dallas@ staff account shows the four weeks "Not drawn", YTD and the blended all-time total including them, drill-in reads "Pay record / Tracked total" with no paystub button.

## Self-review notes

- Spec coverage: status+flag (T1), creation sites (T2 incl. accrual-path pin), finalize/stubs/guards/editability pin (T3), toggle + 1099 route-level pin (T4), staff server blended + list pin (T4b), admin UI (T6, T7, T9), staff page (T8), backfill (ship time), docs (T5).
- The spec's "PATCH guards extend to no_draw" turned out to be already true (guards are freeze-based, `=== 'paid'`, not `=== 'pending'`); T3 pins it with a test instead of changing code. Overview `PayrollStatus` verified free (keys off `pending_count`); the periods-rollup exclusions are pinned by the T3/T4 suites.
- Type consistency: `ensurePayout(executor, payPeriodId, contractorId) -> id` used identically in T1/T2; toggle payload `{ payout, period_status }` consumed in T6.
- Plan-fleet rev 2 (2026-08-07): folded 3 blockers (prod-constraint verify step, payroll.test.js `req()` idiom rewrite, index.css footprint), 6 warnings (fixture/teardown gaps, neutral chip classes, route-level 1099 pin, UI browser walks, staffPortal suite + pins, soft-cap note), and the suggestions (editability + accrual-path pins, intra-lane checkpoint after T4, fuller post-deploy walk). Stub-DELETE extension to no_draw stands as a documented plan-level decision.
