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
    deps: [no-draw-engine]
    review: full-fleet
---

# Owner No-Draw Payouts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A third payout status `no_draw` for the owner's payouts: tracked and editable but never owed, never paid, never blocking period close, never leaking into 1099 totals.

**Architecture:** All four payout-creation sites share one identical upsert; they collapse into a single `ensurePayout` helper in `payrollProcessing.js` that births `no_draw` when `contractor_profiles.takes_draw = false`. Everything that filters `status = 'pending'` (finalize, rollups, owed stats) or `status = 'paid'` (1099, paystubs, staff YTD source) excludes `no_draw` automatically; the deltas are the two empty-stub DELETEs, one client owed-delta lift, and presentation.

**Tech Stack:** Node/Express, raw SQL via pg, React (CRA), node:test suites against the shared dev DB.

**Spec:** `docs/superpowers/specs/2026-08-07-owner-no-draw-payouts-design.md`

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

Append to `server/utils/payrollProcessing.test.js`, following its existing fixture style (create users/periods in a before hook, tear down after; reuse its helpers if present):

```js
test('ensurePayout > births pending for a normal contractor', async () => {
  const id = await ensurePayout(pool, periodId, normalContractorId);
  const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'pending');
});

test('ensurePayout > births no_draw when takes_draw = false', async () => {
  await pool.query('UPDATE contractor_profiles SET takes_draw = false WHERE user_id = $1', [flaggedContractorId]);
  const id = await ensurePayout(pool, periodId, flaggedContractorId);
  const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'no_draw');
});

test('ensurePayout > upsert never rewrites an existing status', async () => {
  // Existing pending payout for a contractor who later flips to no-draw:
  const first = await ensurePayout(pool, periodId, laterFlaggedId);
  await pool.query('UPDATE contractor_profiles SET takes_draw = false WHERE user_id = $1', [laterFlaggedId]);
  const second = await ensurePayout(pool, periodId, laterFlaggedId);
  assert.equal(second, first);
  const { rows } = await pool.query('SELECT status FROM payouts WHERE id = $1', [first]);
  assert.equal(rows[0].status, 'pending');
});

test('ensurePayout > no contractor_profiles row defaults to pending', async () => {
  const id = await ensurePayout(pool, periodId, profilelessUserId);
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

- [ ] **Step 3: commit**

```bash
git add server/utils/payrollAccrual.js server/utils/payrollLateTip.js server/utils/payrollClawback.js server/utils/dutyLines.js
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

In `payrollProcessing.test.js`:

```js
test('maybeFinalizePeriod > no_draw payouts do not block the flip', async () => {
  // period in 'processing' with one paid + one no_draw payout
  const flipped = await maybeFinalizePeriod(pool, mixedPeriodId);
  assert.equal(flipped, true);
  const { rows } = await pool.query('SELECT status FROM pay_periods WHERE id = $1', [mixedPeriodId]);
  assert.equal(rows[0].status, 'paid');
});
```

In `payroll.test.js` (follow its existing mark-paid test setup):

```js
test('mark-paid > refuses a no_draw payout with a status-aware 409', async () => {
  // seed: processing period + payout with status 'no_draw'
  const res = await request(app)
    .post(`/api/admin/payroll/payouts/${noDrawPayoutId}/mark-paid`)
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ payment_method: 'other' });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /no_draw/);
});
```

Run both suites; the finalize test needs its fixture built first and should pass immediately once seeded correctly (it proves existing behavior); the mark-paid test FAILS on the message (`payout is already paid`).

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

In `payroll.test.js`:

```js
test('toggle-draw > pending -> no_draw and back', async () => {
  let res = await request(app)
    .post(`/api/admin/payroll/payouts/${pendingPayoutId}/toggle-draw`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.payout.status, 'no_draw');
  res = await request(app)
    .post(`/api/admin/payroll/payouts/${pendingPayoutId}/toggle-draw`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  assert.equal(res.body.payout.status, 'pending');
});

test('toggle-draw > refuses a paid payout', async () => {
  const res = await request(app)
    .post(`/api/admin/payroll/payouts/${paidPayoutId}/toggle-draw`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  assert.equal(res.status, 409);
});

test('toggle-draw > refuses when the period is paid', async () => {
  const res = await request(app)
    .post(`/api/admin/payroll/payouts/${payoutInPaidPeriodId}/toggle-draw`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  assert.equal(res.status, 409);
});

test('toggle-draw > parking the last pending payout of a processing period finalizes it', async () => {
  // processing period: one paid payout + one pending payout
  const res = await request(app)
    .post(`/api/admin/payroll/payouts/${lastPendingId}/toggle-draw`)
    .set('Authorization', `Bearer ${adminToken}`).send({});
  assert.equal(res.status, 200);
  assert.equal(res.body.period_status, 'paid');
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

- [ ] **Step 3: project `takes_draw` in `loadPeriodWithPayouts`**

In the payouts SELECT (~line 31), add one column to the projection:

```sql
            COALESCE(cp.takes_draw, true) AS takes_draw,
```

(cp is already LEFT JOINed there.)

- [ ] **Step 4: run to verify**

Run: `node -r dotenv/config --test server/routes/admin/payroll.test.js`
Expected: PASS.

- [ ] **Step 5: 1099 exclusion regression test**

`payrollTax.js` `paidPayoutCents` already filters `status = 'paid'`; pin it. In `payroll.test.js` (or the tax suite if fixtures fit better):

```js
test('no_draw payouts never count toward paid totals', async () => {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(total_cents),0)::bigint AS cents
       FROM payouts WHERE contractor_id = $1 AND status = 'paid'`,
    [flaggedContractorId]
  );
  // flagged contractor has only no_draw rows in fixtures
  assert.equal(Number(rows[0].cents), 0);
});
```

Run the suite; expected PASS.

- [ ] **Step 6: commit**

```bash
git add server/routes/admin/payroll.js server/routes/admin/payroll.test.js
git commit -m "feat(payroll): toggle-draw route + takes_draw projection"
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

with the handler + state near the other handlers:

```js
  const [toggleBusy, setToggleBusy] = useState(false);
  const toggleDraw = async () => {
    setToggleBusy(true);
    try {
      await api.post(`/admin/payroll/payouts/${payout.id}/toggle-draw`, {});
      // Status + rollups (owed, possibly period close) changed: full refetch.
      onRefetch?.();
    } catch (err) {
      toast.error(err.message);
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

- [ ] **Step 4: verify**

Run: `cd client && CI=true npx react-scripts build`
Expected: exit 0, no ESLint warnings.

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
Chip (lines ~212-220): for no_draw render `<span className="sp-chip"><span className="sp-chip-dot" />Not drawn</span>` (neutral, not the info/ok variants).
Confirm the paystub download affordance is gated on `isPaid` (the server 409s regardless; the button should not show).

- [ ] **Step 3: verify + commit**

Run: `cd client && CI=true npx react-scripts build` -> exit 0.

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
                <span className={`chip ${po.status === 'paid' ? 'ok' : po.status === 'no_draw' ? '' : 'info'}`}>
                  {po.status === 'no_draw' ? 'no draw' : po.status}
                </span>
```

(bare `chip` renders the neutral variant; verify against StatusChip/chip classes in index.css and match the neutral idiom actually present).

- [ ] **Step 2: verify + commit**

Run: `cd client && CI=true npx react-scripts build` -> exit 0.

```bash
git add client/src/pages/admin/userDetail/tabs/PayoutsTab.js
git commit -m "feat(payroll-ui): no_draw chip on the contractor payouts tab"
```

---

## Ship time (NOT a lane; runs at push, prod DDL + backfill BEFORE the push)

Per the display-name precedent: prod schema + backfill land before the code deploys. Run via Neon MCP against project `round-tooth-34649976` default branch, each step confirmed with Dallas watching:

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

- [ ] **6. Post-deploy walk**: Payroll page: queue shows 89/80/76 (newest first, no 72), Dallas rows greyed "No draw", stats exclude him; History shows 72 with paid-only total; dallas@ staff account shows the four weeks "Not drawn" + YTD including them.

## Self-review notes

- Spec coverage: status+flag (T1), creation sites (T2), finalize/stubs/guards (T3), toggle (T4), free-fallout verification is embedded as regression tests (T3 finalize, T4 step 5 tax), admin UI (T6, T7, T9), staff page (T8), backfill (ship time), docs (T5).
- The spec's "PATCH guards extend to no_draw" turned out to be already true (guards are freeze-based, `=== 'paid'`, not `=== 'pending'`); T6 notes it instead of changing code.
- Type consistency: `ensurePayout(executor, payPeriodId, contractorId) -> id` used identically in T1/T2; toggle payload `{ payout, period_status }` consumed in T6.
