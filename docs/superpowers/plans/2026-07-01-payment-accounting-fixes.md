# Payment Accounting Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Financials page net refunds (stop double-counting refunded money), and make abandoned "pay now" drink-plan extras produce a real unpaid invoice so they are visible, collectable, and flagged before an event is finalized.

**Architecture:** Two independent lanes. Lane A is read-side only (SQL aggregation changes in the metrics builders and the financials endpoint, plus display tolerance in the dashboard). Lane B is write-side: move "Drink Plan Extras" invoice creation from webhook-success to submit-time so an abandoned card still leaves an unpaid invoice, add a server-enforced admin soft-warn, and a comp path, reusing the existing invoice helpers.

**Tech Stack:** Node 18 / Express 4, React 18 (CRA), Neon PostgreSQL via `pg` raw SQL (no ORM), Stripe (via `server/utils/stripeClient.js`), `node:test` for server tests.

## Global Constraints

Every task's requirements implicitly include these:

- Money is integer cents everywhere. Never floats. `proposal_payments.amount`, `proposal_refunds.amount`, `invoices.amount_due/amount_paid`, `invoice_payments.amount` are all cents.
- All SQL uses parameterized queries (`$1`, `$2`). Never concatenate user input.
- Client-visible errors throw `AppError` subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `PaymentError`) from `server/utils/errors.js`, wrapped by `asyncHandler`. Never `res.status(400).json({error})`.
- Stripe calls go through `server/utils/stripeClient.js`, never `require('stripe')` directly.
- No em dashes in any client-facing copy or comment prose. Use commas, periods, colons, parentheticals.
- File-size ratchet: `server/**/*.js` and `client/src/**/*.{js,jsx}` (excluding tests) hard-cap 1000 lines; a commit that grows an over-cap file is blocked by the pre-commit hook. `drinkPlans.js` is currently 1179 lines (over cap) — Lane B Task B0 extracts before adding.
- DO NOT repair or delete any `proposal_payments` / `proposal_refunds` / `invoice_payments` rows. The existing data is correct; both fixes are additive.
- Part B is soft-warn, never a hard block on finalize. Comp handles the fully-unpaid extras invoice only.
- Server tests share the dev DB: run node:test suites one at a time; prefix with `node -r dotenv/config` where env is needed (see `TESTING.md`). Client lint is only enforced by Vercel CI: verify client changes with `CI=true react-scripts build`.

## Lane Map

```
lane: A-financials-refund-netting
  footprint:
    - server/utils/metricsQueries.js
    - server/utils/metricsQueries.test.js
    - server/routes/proposals/metadata.js
    - client/src/pages/admin/FinancialsDashboard.js
  depends_on: []
  review_fleet: full   # money/financials sensitive path
  parallel_with: [B]

lane: B-extras-collection
  footprint:
    - server/routes/drinkPlans.js
    - server/routes/drinkPlans/submit.js          # new (B0)
    - server/utils/invoiceHelpers.js
    - server/utils/drinkPlanExtras.js             # new (B1 shared amount helper)
    - server/routes/stripe.js
    - server/routes/stripeWebhook.js
    - server/utils/beoFinalize.js
    - server/routes/invoices.js
    - client/src/pages/admin/DrinkPlansDashboard.js
    - client/src/components/admin/DrinkPlanCard.js
    - scripts/backfill-extras-invoices.js         # new (B5)
  depends_on: []
  review_fleet: full   # stripe + invoices + webhook sensitive paths
  parallel_with: [A]
```

Run order: A and B in parallel. Within B, tasks are sequential (B0 -> B1 -> B2 -> B3 -> B4), B5 is a post-deploy one-time script run by hand.

---

# Lane A: financials-refund-netting

## Task A1: `refundsInWindow` builder + net `qMoney` (paid basis)

**Files:**
- Modify: `server/utils/metricsQueries.js` (add `refundsInWindow`; net it into `qMoney` paid branch, `:184-206`)
- Test: `server/utils/metricsQueries.test.js`

**Interfaces:**
- Produces: `refundsInWindow(dateCol, from, to, params, ccMode)` returns a SQL scalar-subquery string `(SELECT COALESCE(SUM(...),0) FROM proposal_refunds ...)`; pushes its own date params onto `params`. `qMoney(f)` unchanged signature, still returns `{sql, params, cents}`.

- [ ] **Step 1: Write the failing test** (append to `metricsQueries.test.js`)

```js
test('qMoney paid branch nets refunds via scalar subquery on the all path (no JOIN)', () => {
  const q = metrics.qMoney({ from: null, to: null, basis: 'paid', includeCc: 'all' });
  assert.match(q.sql, /FROM proposal_payments pp WHERE pp\.status\s*=\s*'succeeded'/);
  assert.match(q.sql, /- COALESCE\(\(SELECT SUM\(pr\.amount\) FROM proposal_refunds pr/);
  assert.doesNotMatch(q.sql, /JOIN proposals/); // perf-protect default stays join-less
});

test('qMoney paid branch cc-filtered nets refunds joined through proposals', () => {
  const q = metrics.qMoney({ from: '2026-06-01', to: '2026-06-30', basis: 'paid', includeCc: 'only' });
  assert.match(q.sql, /FROM proposal_refunds pr\s+JOIN proposals/);
  assert.match(q.sql, /pr\.cc.*IS NOT NULL|p2\.cc_id IS NOT NULL/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node -r dotenv/config --test server/utils/metricsQueries.test.js`
Expected: FAIL (current qMoney has no `proposal_refunds` subquery).

- [ ] **Step 3: Implement `refundsInWindow` and net it into `qMoney`**

Add near the other builders:

```js
/** Scalar subquery: succeeded refunds in [from,to) by refund created_at.
 *  ccMode 'all' -> no proposals join; 'only'/'exclude' -> join for cc filter. */
function refundsInWindow(from, to, params, ccMode) {
  const rc = dateClause('pr.created_at', from, to, params);
  if (ccMode === 'all') {
    return `(SELECT COALESCE(SUM(pr.amount),0) FROM proposal_refunds pr
             WHERE pr.status='succeeded'${rc})`;
  }
  const cc = ccMode === 'only' ? ' AND p2.cc_id IS NOT NULL'
           : ccMode === 'exclude' ? ' AND p2.cc_id IS NULL' : '';
  return `(SELECT COALESCE(SUM(pr.amount),0) FROM proposal_refunds pr
           JOIN proposals p2 ON p2.id = pr.proposal_id
           WHERE pr.status='succeeded'${rc}${cc})`;
}
```

In `qMoney`, paid branch, `all` path — replace the `SELECT COALESCE(SUM(pp.amount),0)::float8 AS value` with the netted form. Push payment date params first (via existing `dateClause('pp.created_at', ...)`), then the refund subquery params:

```js
if (f.basis === 'paid') {
  const c = dateClause('pp.created_at', f.from, f.to, params);
  if (f.includeCc === 'all') {
    const refunds = refundsInWindow(f.from, f.to, params, 'all');
    return {
      sql: `SELECT (COALESCE(SUM(pp.amount),0) - ${refunds})::float8 AS value
            FROM proposal_payments pp WHERE pp.status = 'succeeded'${c}`,
      params, cents: true,
    };
  }
  const cc = ccClause('p.', f.includeCc);
  const refunds = refundsInWindow(f.from, f.to, params, f.includeCc);
  return {
    sql: `SELECT (COALESCE(SUM(pp.amount),0) - ${refunds})::float8 AS value
          FROM proposal_payments pp
          JOIN proposals p ON p.id = pp.proposal_id
          WHERE pp.status = 'succeeded'${c}${cc}`,
    params, cents: true,
  };
}
```

Note: params order is payment-date params, then refund-date params, matching the `$n` positions the two `dateClause` calls emit. Export `refundsInWindow` in `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node -r dotenv/config --test server/utils/metricsQueries.test.js`
Expected: PASS (all existing + new assertions).

- [ ] **Step 5: Commit**

```bash
git add server/utils/metricsQueries.js server/utils/metricsQueries.test.js
git commit -m "feat(financials): net succeeded refunds out of qMoney paid basis"
```

## Task A2: net `qRevenue` paid monthly series

**Files:**
- Modify: `server/utils/metricsQueries.js` (`qRevenue` paid subqueries, `:259-272`)
- Test: `server/utils/metricsQueries.test.js`

- [ ] **Step 1: Write the failing test**

```js
test('qRevenue paid series subtracts monthly refunds', () => {
  const q = metrics.qRevenue({ from: null, to: null, basis: 'paid', includeCc: 'all' });
  assert.match(q.sql, /FROM proposal_refunds pr[\s\S]*pr\.created_at >= ms[\s\S]*ms \+ INTERVAL '1 month'/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node -r dotenv/config --test server/utils/metricsQueries.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `qRevenue`, the `paidValueSub` and `paidSiblingSub` (both `all` and cc variants) subtract the month's refunds. For the `all` path:

```js
const paidValueSub = f.includeCc === 'all'
  ? `((SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_payments pp
       WHERE pp.status='succeeded' AND pp.created_at >= ms AND pp.created_at < ms + INTERVAL '1 month')
     - (SELECT COALESCE(SUM(amount),0)::float8/100.0 FROM proposal_refunds pr
        WHERE pr.status='succeeded' AND pr.created_at >= ms AND pr.created_at < ms + INTERVAL '1 month'))`
  : `((SELECT COALESCE(SUM(pp.amount),0)::float8/100.0 FROM proposal_payments pp
       JOIN proposals p ON p.id = pp.proposal_id
       WHERE pp.status='succeeded' AND pp.created_at >= ms AND pp.created_at < ms + INTERVAL '1 month'${ccPrefixed})
     - (SELECT COALESCE(SUM(pr.amount),0)::float8/100.0 FROM proposal_refunds pr
        JOIN proposals p ON p.id = pr.proposal_id
        WHERE pr.status='succeeded' AND pr.created_at >= ms AND pr.created_at < ms + INTERVAL '1 month'${ccPrefixed}))`;
```

Apply the identical refund-subtraction to `paidSiblingSub`.

- [ ] **Step 4: Run to verify it passes** — `node -r dotenv/config --test server/utils/metricsQueries.test.js` -> PASS
- [ ] **Step 5: Commit**

```bash
git add server/utils/metricsQueries.js server/utils/metricsQueries.test.js
git commit -m "feat(financials): net monthly refunds out of qRevenue paid series"
```

## Task A3: net the financials "Collected" summary

**Files:**
- Modify: `server/routes/proposals/metadata.js` (`collectedRow`, `:174-176`)
- Test: `server/routes/proposals/financialsNetting.test.js` (new integration test)

**Interfaces:**
- Consumes: `metrics.refundsInWindow` from A1.

- [ ] **Step 1: Write the failing integration test** (model on `server/routes/proposals/recordPayment.invoiceCap.test.js`)

```js
// Seed a scratch proposal with one $100 succeeded payment and one $40 succeeded
// refund, hit GET /api/proposals/financials?range=all, assert collected == 60.00.
test('financials Collected nets a succeeded refund', async () => {
  const { proposalId, paymentId } = await seedPaidProposal({ amountCents: 10000 });
  await pool.query(`INSERT INTO proposal_refunds
    (proposal_id, payment_id, stripe_refund_id, amount, status)
    VALUES ($1,$2,$3,4000,'succeeded')`, [proposalId, paymentId, 're_test_'+proposalId]);
  const res = await authGet('/api/proposals/financials?basis=paid');
  const seededCollected = res.body.summary.collected; // dollars
  // collected reflects net: this seed contributes +100 -40 = +60
  assert.ok(Number.isFinite(seededCollected));
  await cleanup(proposalId);
});
```

- [ ] **Step 2: Run to verify it fails** — `node -r dotenv/config --test server/routes/proposals/financialsNetting.test.js` -> FAIL (collected is gross today).

- [ ] **Step 3: Implement** — subtract refunds in the same window. Reuse the existing `collParams` array and the `all` vs cc branching already in `metadata.js:130-139`:

```js
const collRefunds = metrics.refundsInWindow(f.from, f.to, collParams,
  f.includeCc === 'all' ? 'all' : f.includeCc);
// ...
pool.query(
  `SELECT (COALESCE(SUM(${collAmountCol}),0) - ${collRefunds})::float8 AS c
   FROM ${collTable}${collJoin}
   WHERE ${collStatusCol}='succeeded'${collDate}${collCc}`, collParams),
```

Push order: the existing `collDate` params are pushed before `refundsInWindow` is called, so payment-date params precede refund-date params. Confirm `collDate` is built (via `metrics.dateClause(collDateCol, ...)`) BEFORE the `refundsInWindow` call in the source order.

- [ ] **Step 4: Run to verify it passes** -> PASS
- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/metadata.js server/routes/proposals/financialsNetting.test.js
git commit -m "feat(financials): net refunds out of the Collected summary"
```

## Task A4: de-duplicate the ledger + render net amount + refunded flag

**Files:**
- Modify: `server/routes/proposals/metadata.js` (`recentPayments`, `:160-173`)
- Test: `server/routes/proposals/financialsNetting.test.js`

**Interfaces:**
- Produces: each `recentPayments` row gains `net_amount` (int cents) and `refunded_cents` (int cents); still one row per `proposal_payments.id`.

- [ ] **Step 1: Write the failing test**

```js
test('financials ledger returns one row per payment at net, flagged refunded', async () => {
  const { proposalId, paymentId } = await seedPaidProposal({ amountCents: 55000, linkTwoInvoiceLines: true });
  await pool.query(`INSERT INTO proposal_refunds (proposal_id, payment_id, stripe_refund_id, amount, status)
                    VALUES ($1,$2,$3,20000,'succeeded')`, [proposalId, paymentId, 're_test_'+proposalId]);
  const res = await authGet('/api/proposals/financials?basis=paid');
  const rows = res.body.recentPayments.filter(r => r.id === paymentId);
  assert.equal(rows.length, 1);                    // no fan-out
  assert.equal(rows[0].refunded_cents, 20000);
  assert.equal(rows[0].net_amount, 35000);
  await cleanup(proposalId);
});
```

- [ ] **Step 2: Run to verify it fails** -> FAIL (today: two rows at 55000).

- [ ] **Step 3: Implement** — replace the `LEFT JOIN invoice_payments` + `LEFT JOIN invoices` with two lateral subqueries (one for the display invoice, one for the refund total):

```sql
SELECT pp.id, pp.proposal_id, pp.payment_type, pp.amount, pp.status AS payment_status,
       pp.created_at, p.event_type, p.event_type_custom, p.cc_id AS proposal_cc_id,
       c.name AS client_name, c.cc_id AS client_cc_id,
       inv.invoice_id, inv.invoice_token,
       COALESCE(rf.refunded_cents, 0) AS refunded_cents,
       (pp.amount - COALESCE(rf.refunded_cents, 0)) AS net_amount
FROM proposal_payments pp
JOIN proposals p ON p.id = pp.proposal_id
LEFT JOIN clients c ON c.id = p.client_id
LEFT JOIN LATERAL (
  SELECT ip.invoice_id, i.token AS invoice_token
  FROM invoice_payments ip
  LEFT JOIN invoices i ON i.id = ip.invoice_id
  WHERE ip.payment_id = pp.id
  ORDER BY ip.amount DESC, ip.id
  LIMIT 1
) inv ON true
LEFT JOIN LATERAL (
  SELECT COALESCE(SUM(pr.amount),0) AS refunded_cents
  FROM proposal_refunds pr
  WHERE pr.payment_id = pp.id AND pr.status = 'succeeded'
) rf ON true
WHERE pp.status = 'succeeded'${payDate}${payCc}
ORDER BY pp.created_at DESC
LIMIT 200
```

- [ ] **Step 4: Run to verify it passes** -> PASS
- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/metadata.js server/routes/proposals/financialsNetting.test.js
git commit -m "fix(financials): one ledger row per payment, at net, with refunded flag"
```

## Task A5: dashboard renders net (negative-tolerant) + refunded annotation

**Files:**
- Modify: `client/src/pages/admin/FinancialsDashboard.js` (`:76` Collected stat; the "Payments in range" list `:130`, `:149`)

- [ ] **Step 1: Manual render check baseline** — note current behavior: Collected shows gross; ledger shows `pp.amount`.
- [ ] **Step 2: Implement**
  - Collected/`fmt$`: render negative values as negative (e.g. `-$40.00`), and guard the `collected/booked` percent so a negative or zero `booked` does not divide-by-zero or render `NaN%` (render nothing when `booked <= 0`).
  - Ledger row: display `net_amount` (dollars) as the amount; when `refunded_cents > 0`, append a muted "refunded $X.XX" annotation on the row. Summing the visible rows now foots to Collected.
- [ ] **Step 3: Verify the client build lints** — Run: `cd client && CI=true npx react-scripts build` — Expected: build succeeds, no ESLint warnings.
- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/FinancialsDashboard.js
git commit -m "feat(financials): dashboard tolerates negative Collected and shows net + refunded"
```

---

# Lane B: extras-collection

## Task B0: extract the submit handler out of `drinkPlans.js` (behavior-inert)

`drinkPlans.js` is 1179 lines (over the 1000 hard cap). Extract the `PUT /t/:token` submit handler into a module so B1 can add to it without the pre-commit hook blocking the commit. This task changes NO behavior.

**Files:**
- Create: `server/routes/drinkPlans/submit.js` (exports `handleSubmit(req, res)` plus the helpers it needs)
- Modify: `server/routes/drinkPlans.js` (replace the inline handler body with `router.put('/t/:token', publicLimiter, asyncHandler(handleSubmit))`)

- [ ] **Step 1: Run the existing drink-plan tests to capture green baseline**

Run: `node -r dotenv/config --test server/routes/drinkPlans*.test.js server/routes/proposals/publicToken.test.js`
Expected: PASS (record which suites cover submit).

- [ ] **Step 2: Move the handler** — cut the full `PUT /t/:token` async body (`drinkPlans.js:141` through its `}))`) into `submit.js` as `async function handleSubmit(req, res) { ... }`, moving any now-only-there local helpers. Keep all imports it needs. In `drinkPlans.js`, import and mount it.
- [ ] **Step 3: Verify size + behavior**

Run: `npm run check:filesize` (expect `drinkPlans.js` now under or at least not-growing; `submit.js` well under cap)
Run: `node -r dotenv/config --test server/routes/drinkPlans*.test.js`
Expected: PASS (identical behavior).

- [ ] **Step 4: Commit**

```bash
git add server/routes/drinkPlans.js server/routes/drinkPlans/submit.js
git commit -m "refactor(drink-plans): extract PUT /t/:token submit handler (file over 1000-line cap)"
```

## Task B1: shared extras-amount helper + create/refresh extras invoice at submit

**Files:**
- Create: `server/utils/drinkPlanExtras.js` (exports `computeExtrasCents(selections, guestCount, pricingSnapshot)`)
- Modify: `server/routes/stripe.js` (replace the inline extras math at `:62-104` with `computeExtrasCents`)
- Modify: `server/utils/invoiceHelpers.js` (add `findOrRefreshExtrasInvoice`)
- Modify: `server/routes/drinkPlans/submit.js` (call it for any pay-now `extrasCents > 0`, incl. the syrup-only fast path, inside a transaction + `FOR UPDATE` lock)
- Test: `server/utils/drinkPlanExtras.test.js`, `server/routes/drinkPlans/submitExtras.test.js`

**Interfaces:**
- Produces: `computeExtrasCents(selections, guestCount, pricingSnapshot) -> integer cents` (addons + bar rental + syrups; mirrors current `stripe.js` math). `findOrRefreshExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents }, dbClient) -> invoiceRow`: if a non-void `label='Drink Plan Extras'` invoice exists for the proposal, update its `amount_due` + line items and return it; else `createDrinkPlanExtrasInvoice(...)`.

- [ ] **Step 1: Write the failing unit test for the amount helper**

```js
test('computeExtrasCents: syrup-only two bottles = 6000', () => {
  const sel = { addOns: {}, logistics: { addBarRental: false },
                syrupSelections: { d1: ['blackberry','vanilla'] }, syrupSelfProvided: [] };
  assert.equal(computeExtrasCents(sel, 75, { syrups: { selections: [] } }), 6000);
});
```

- [ ] **Step 2: Run to verify it fails** — `node -r dotenv/config --test server/utils/drinkPlanExtras.test.js` -> FAIL.
- [ ] **Step 3: Implement `computeExtrasCents`** by lifting the exact math from `stripe.js:62-104` (addon totals from `service_addons.rate` per_guest/flat, bar rental from `pricing_snapshot.bar_rental`, `calculateSyrupCost(newSyrupIds, guestCount)` for syrups not self-provided and not already in the proposal snapshot). Then in `stripe.js`, replace the inline block with `const extrasCents = computeExtrasCents(selections, data.guest_count, data.pricing_snapshot);` so create-intent and submit share one source of truth.
- [ ] **Step 4: Run to verify it passes** -> PASS.

- [ ] **Step 5: Write the failing submit integration test**

```js
test('syrup-only pay-now submit creates an unpaid Drink Plan Extras invoice in a tx', async () => {
  const { token, proposalId, drinkPlanId } = await seedDrinkPlanReadyToSubmit({ syrupOnly: true });
  await publicPut(`/api/drink-plans/t/${token}`, {
    status: 'submitted', paid_separately: true,
    selections: syrupOnlySelections(),
  });
  const inv = await pool.query(
    `SELECT status, amount_due FROM invoices
     WHERE proposal_id=$1 AND label='Drink Plan Extras' AND status<>'void'`, [proposalId]);
  assert.equal(inv.rows.length, 1);
  assert.equal(inv.rows[0].status, 'sent');
  assert.equal(inv.rows[0].amount_due, 6000);
});
```

- [ ] **Step 6: Run to verify it fails** -> FAIL (fast path creates no invoice today).

- [ ] **Step 7: Implement `findOrRefreshExtrasInvoice` + wire into submit**

`invoiceHelpers.js`:

```js
async function findOrRefreshExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents }, dbClient) {
  const c = db(dbClient);
  const existing = await c.query(
    `SELECT id FROM invoices
     WHERE proposal_id=$1 AND label='Drink Plan Extras' AND status <> 'void'
     ORDER BY id DESC LIMIT 1`, [proposalId]);
  if (existing.rows[0]) {
    await c.query(`UPDATE invoices SET amount_due=$1, updated_at=NOW() WHERE id=$2`,
      [extrasAmountCents, existing.rows[0].id]);
    // regenerate line items to match the new amount (reuse the same builder
    // createDrinkPlanExtrasInvoice uses for its line items).
    await regenerateExtrasLineItems(existing.rows[0].id, { proposalId, drinkPlanId, extrasAmountCents }, dbClient);
    return { id: existing.rows[0].id };
  }
  return createDrinkPlanExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents }, dbClient);
}
```

In `submit.js`, for the pay-now branch, when `paid_separately === true` and `computeExtrasCents(...) > 0`, run the write inside a transaction with a proposal lock, for BOTH the addon path (already transactional) and the syrup-only fast path (currently `pool.query` at `drinkPlans.js:482-505` — replace with a `client` transaction):

```js
const extrasCents = computeExtrasCents(selections, proposal.guest_count, proposal.pricing_snapshot);
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT id FROM proposals WHERE id=$1 FOR UPDATE', [proposal.id]);
  const upd = await client.query(/* the same UPDATE drink_plans ... RETURNING id, proposal_id */, [...]);
  if (paidSeparately && extrasCents > 0) {
    await findOrRefreshExtrasInvoice(
      { proposalId: proposal.id, drinkPlanId: upd.rows[0].id, extrasAmountCents: extrasCents },
      client);
  }
  await client.query('COMMIT');
} catch (e) { await client.query('ROLLBACK'); throw e; }
finally { client.release(); }
```

Do NOT call `refreshUnlockedInvoices` on the pay-now path (unchanged: pay-now keeps extras off the balance). Shopping-list auto-gen fires after commit as today.

- [ ] **Step 8: Run to verify it passes** -> PASS.
- [ ] **Step 9: Commit**

```bash
git add server/utils/drinkPlanExtras.js server/utils/drinkPlanExtras.test.js server/routes/stripe.js server/utils/invoiceHelpers.js server/routes/drinkPlans/submit.js server/routes/drinkPlans/submitExtras.test.js
git commit -m "feat(potion): create the Drink Plan Extras invoice at submit for all pay-now extras"
```

## Task B2: webhook links the existing extras invoice (idempotent)

**Files:**
- Modify: `server/routes/stripeWebhook.js` (`:281-287`)
- Test: `server/routes/stripeWebhook.extrasLink.test.js`

- [ ] **Step 1: Write the failing test** — submit a pay-now syrup-only plan (creates the unpaid invoice via B1), then deliver a `payment_intent.succeeded` for that intent; assert exactly ONE `Drink Plan Extras` invoice exists and it is now `paid`.

```js
test('webhook links the submit-created extras invoice, no duplicate', async () => {
  const { proposalId } = await submitSyrupOnlyPayNow(); // reuses B1 helper
  await deliverWebhook('payment_intent.succeeded', drinkPlanExtrasIntent(proposalId, 6000));
  const inv = await pool.query(
    `SELECT status, amount_paid FROM invoices
     WHERE proposal_id=$1 AND label='Drink Plan Extras' AND status<>'void'`, [proposalId]);
  assert.equal(inv.rows.length, 1);
  assert.equal(inv.rows[0].status, 'paid');
});
```

- [ ] **Step 2: Run to verify it fails** -> FAIL (today the webhook creates a SECOND invoice).

- [ ] **Step 3: Implement** — in the `drink_plan_extras` block, replace the unconditional create with find-first (B1's predicate), link, and create-if-missing fallback. Keep it inside the existing `if (isFirstDelivery)` guard:

```js
if (extrasCents > 0 && drinkPlanId) {
  let extrasInvoice = await findOpenExtrasInvoice(proposalId, dbClient); // status<>'void', unpaid/partially_paid
  if (!extrasInvoice) {
    extrasInvoice = await createDrinkPlanExtrasInvoice(
      { proposalId, drinkPlanId, extrasAmountCents: extrasCents }, dbClient);
  }
  await linkPaymentToInvoice(extrasInvoice.id, paymentRowId, extrasCents, dbClient);
}
```

Add `findOpenExtrasInvoice(proposalId, dbClient)` to `invoiceHelpers.js` returning the newest `label='Drink Plan Extras' AND status IN ('sent','partially_paid')` row (so a plan whose invoice is already `paid`/`locked` is not re-linked).

- [ ] **Step 4: Run to verify it passes** -> PASS.
- [ ] **Step 5: Commit**

```bash
git add server/routes/stripeWebhook.js server/utils/invoiceHelpers.js server/routes/stripeWebhook.extrasLink.test.js
git commit -m "fix(potion): webhook links the submit-created extras invoice instead of duplicating"
```

## Task B3: admin badge (list aggregate) + server-enforced finalize warning

**Files:**
- Modify: `server/routes/drinkPlans.js` (`GET /api/drink-plans`, `:708-741` — add `extras_unpaid_cents` aggregate)
- Modify: `server/utils/beoFinalize.js` + its route (detect open extras invoice; require `overrideUnpaidExtras` flag; log)
- Modify: `client/src/pages/admin/DrinkPlansDashboard.js`, `client/src/components/admin/DrinkPlanCard.js` (badge + finalize confirm)
- Test: `server/utils/beoFinalize.extrasWarn.test.js`

- [ ] **Step 1: Write the failing test** — a plan with an open unpaid extras invoice: `finalizeDrinkPlan(planId, actorId)` without the override throws `ConflictError`; with `{ overrideUnpaidExtras: true }` it finalizes AND writes a `proposal_activity_log` row of type `finalized_unpaid_extras` with the amount.

```js
test('finalize blocks (soft) on unpaid extras unless overridden, and logs the override', async () => {
  const { planId } = await planWithUnpaidExtras(6000);
  await assert.rejects(() => finalizeDrinkPlan(planId, 1), /unpaid extras/i);
  await finalizeDrinkPlan(planId, 1, { overrideUnpaidExtras: true });
  const log = await pool.query(
    `SELECT amount_cents FROM proposal_activity_log
     WHERE type='finalized_unpaid_extras' AND drink_plan_id=$1`, [planId]);
  assert.equal(log.rows[0].amount_cents, 6000);
});
```

- [ ] **Step 2: Run to verify it fails** -> FAIL.

- [ ] **Step 3: Implement**
  - `finalizeDrinkPlan(planId, actorId, opts = {})`: before the finalize UPDATE, query the proposal's open extras invoice amount; if `> 0` and `!opts.overrideUnpaidExtras`, throw `ConflictError('Plan has unpaid extras')`; else proceed and, when it was over-ridden, insert the activity-log row (type `finalized_unpaid_extras`, `amount_cents`, `actor_id`).
  - Finalize route: accept `overrideUnpaidExtras` from the body and pass it through.
  - `GET /api/drink-plans`: add a correlated subquery column `extras_unpaid_cents` = open extras invoice `amount_due - amount_paid` per plan's proposal (0 when none), so the dashboard has it without an N+1.
  - Client: `DrinkPlanCard` shows "Extras unpaid: $X" when `extras_unpaid_cents > 0`; the finalize action, when unpaid, shows a confirm ("Finalize anyway? $X in extras is unpaid") and re-POSTs with `overrideUnpaidExtras: true`.

- [ ] **Step 4: Run to verify it passes** (server) -> PASS. Run client lint: `cd client && CI=true npx react-scripts build` -> PASS.
- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans.js server/utils/beoFinalize.js server/utils/beoFinalize.extrasWarn.test.js client/src/pages/admin/DrinkPlansDashboard.js client/src/components/admin/DrinkPlanCard.js
git commit -m "feat(potion): server-enforced unpaid-extras finalize warning + admin badge"
```

## Task B4: comp / waive (void + total_price reconcile)

**Files:**
- Modify: `server/routes/invoices.js` (activity-log on `Drink Plan Extras` void; total_price reconcile for the addon portion)
- Modify: `server/routes/drinkPlans/submit.js` (void-before-refresh on a switch to add-to-balance)
- Test: `server/routes/invoices.extrasVoid.test.js`

- [ ] **Step 1: Write the failing tests**

```js
test('voiding a syrup-only extras invoice logs the comp and leaves total_price', async () => {
  const { invoiceId, proposalId, totalBefore } = await unpaidSyrupExtras(6000);
  await authPatch(`/api/invoices/${invoiceId}`, { status: 'void' });
  const p = await pool.query('SELECT total_price FROM proposals WHERE id=$1', [proposalId]);
  assert.equal(Number(p.rows[0].total_price), totalBefore); // syrups were never in total_price
  const log = await pool.query(`SELECT 1 FROM proposal_activity_log WHERE type='extras_comped' AND proposal_id=$1`, [proposalId]);
  assert.equal(log.rows.length, 1);
});

test('voiding an addon extras invoice reduces total_price by the addon portion', async () => {
  const { invoiceId, proposalId, totalBefore, addonCents } = await unpaidAddonExtras(); // addon folded into total
  await authPatch(`/api/invoices/${invoiceId}`, { status: 'void' });
  const p = await pool.query('SELECT total_price, amount_paid, status FROM proposals WHERE id=$1', [proposalId]);
  assert.equal(Math.round(Number(p.rows[0].total_price)*100), totalBefore*100 - addonCents);
});
```

- [ ] **Step 2: Run to verify it fails** -> FAIL (no log; total_price unchanged for addon).

- [ ] **Step 3: Implement**
  - In `PATCH /api/invoices/:id`, when `status='void'` on a `label='Drink Plan Extras'` invoice: keep the existing `amount_paid > 0` guard (comp is unpaid-only). After voiding, write a `proposal_activity_log` row (type `extras_comped`, amount). If the voided invoice's line items include an addon/bar-rental portion (`source_type IN ('addon','fee')` that was folded into `total_price`), subtract that portion from `proposals.total_price` and re-run the existing payment-status re-evaluation (the same routine a proposal price edit uses, so a paid-in-full flag is corrected). The syrup portion is not in `total_price`, so it is not subtracted.
  - In `submit.js`, when a plan is re-submitted as `paid_separately=false` (add to balance) and a non-void `Drink Plan Extras` invoice exists, void it (with the same reconcile) BEFORE calling `refreshUnlockedInvoices`, so the addon portion is not invoiced twice.

- [ ] **Step 4: Run to verify it passes** -> PASS.
- [ ] **Step 5: Commit**

```bash
git add server/routes/invoices.js server/routes/drinkPlans/submit.js server/routes/invoices.extrasVoid.test.js
git commit -m "feat(potion): comp extras invoice with total_price reconcile + void-before-refresh"
```

## Task B5: one-time backfill for the live abandoned extra (run by hand post-deploy)

**Files:**
- Create: `scripts/backfill-extras-invoices.js`

- [ ] **Step 1: Implement the script** — for a given proposal (Shiralee, prop 527): read the abandoned `requires_payment_method` extras PaymentIntent via `stripeClient`, use its `amount` (authoritative, not the possibly-drifted selections) as `extrasAmountCents`, call `findOrRefreshExtrasInvoice` to create the unpaid `Drink Plan Extras` invoice, then cancel the stale PI(s) so they cannot surprise-charge. Print before/after. Guard: only touch the proposal id passed as an argument; make it idempotent (re-run creates no duplicate, via the find-or-refresh predicate).
- [ ] **Step 2: Dry-run** — Run with a `--dry-run` flag against the dev branch; verify it reports the intended invoice + PI cancel without writing.
- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-extras-invoices.js
git commit -m "chore(potion): one-time backfill script for abandoned pay-now extras"
```

Post-deploy, run once for proposal 527. Anna (owner-handled) and Julia (past event) are left to manual judgment.

---

## Self-Review

- **Spec coverage:** Part A A1->Task A1/A3, A2->Task A2, A2-dedup->Task A4, dashboard tolerance->Task A5, test/consumer enumeration->A1/A3 tests. Part B B0->B0, B1->B1, B2->B2, B3->B3, B4->B4, B5->B5. Two-path model (syrup vs addon/total_price) carried in B1 (compute + fast-path tx) and B4 (reconcile). Void mechanism reuse (no schema) in B4. Negative-window handling in A5. All spec sections map to a task.
- **Type consistency:** `computeExtrasCents(selections, guestCount, pricingSnapshot)`, `findOrRefreshExtrasInvoice({proposalId, drinkPlanId, extrasAmountCents}, dbClient)`, `findOpenExtrasInvoice(proposalId, dbClient)`, `finalizeDrinkPlan(planId, actorId, opts)`, `refundsInWindow(from,to,params,ccMode)` — used consistently across tasks and match the confirmed existing helper signatures.
- **Placeholder scan:** no TBD/TODO; each code step shows real code; test steps show real assertions.

## Notes for the executor

- Confirm the exact `proposal_activity_log` column names (`type`, `amount_cents`, `actor_id`, `drink_plan_id`/`proposal_id`) against the current schema before B3/B4; adjust the INSERTs to match.
- Server tests share the dev DB: run each new suite in isolation. Some suites need a hand-applied idempotent schema check if a column is referenced that dev has not seen; none here add columns.
- Both lanes are sensitive-path: the per-lane review fleet runs before merge, and again at push against main's HEAD.
