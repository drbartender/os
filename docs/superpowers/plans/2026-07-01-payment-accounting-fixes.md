# Payment Accounting Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Financials page net refunds (stop double-counting refunded money), and make abandoned "pay now" drink-plan extras produce a real unpaid invoice so they are visible, collectable, and flagged before an event is finalized.

**Architecture:** Two independent lanes. Lane A is read-side only. Lane B is write-side: move "Drink Plan Extras" invoice creation from webhook-success to submit-time so an abandoned card still leaves an unpaid invoice, add a server-enforced admin soft-warn, and a comp path, reusing existing invoice helpers.

**Tech Stack:** Node 18 / Express 4, React 18 (CRA), Neon PostgreSQL via `pg` raw SQL (no ORM), Stripe (via `server/utils/stripeClient.js`), `node:test` for server tests.

**Revision note:** This plan was revised after the plan-review fleet + Codex (7 blockers, 5 warnings). Corrections are inlined below; see the "Review corrections applied" list at the end.

## Global Constraints

- Money is integer cents everywhere. Never floats. `proposal_payments.amount`, `proposal_refunds.amount`, `invoices.amount_due/amount_paid`, `invoice_payments.amount` are all cents.
- All SQL uses parameterized queries (`$1`, `$2`). Never concatenate user input.
- Client-visible errors throw `AppError` subclasses (`ValidationError`, `NotFoundError`, `ConflictError`, `PaymentError`) from `server/utils/errors.js`, wrapped by `asyncHandler`.
- Stripe calls go through `server/utils/stripeClient.js`, never `require('stripe')` directly.
- Public token routes keep their `requireUuidToken(...)` guard and their rate limiter. NEVER drop a token guard while refactoring (UUID token-guard convention).
- `proposal_activity_log` columns are `(id, proposal_id, action, actor_type, actor_id, details jsonb, created_at)`. There is no `type`/`amount_cents`/`drink_plan_id` column. Log via `action` + `details` jsonb, exactly like `beoFinalize.js:66-73`.
- No em dashes in client-facing copy or comment prose.
- File-size ratchet: `server/**/*.js` and `client/src/**/*.{js,jsx}` hard-cap 1000 lines; a commit that grows an over-cap file is blocked. `drinkPlans.js` is 1179 (over cap); B0 extracts it to ~748 before B1 adds. `invoiceHelpers.js` is 736 (over the 700 soft cap); the new functions keep it under 1000 (allowed), but note the split is due.
- DO NOT repair or delete any `proposal_payments` / `proposal_refunds` / `invoice_payments` rows. Both fixes are additive.
- Part B is soft-warn, never a hard block. Comp handles a fully-unpaid extras invoice only.
- Server tests share the dev DB: run node:test suites one at a time, `node -r dotenv/config`. There is NO shared integration-test harness; each integration test hand-rolls setup like `server/routes/proposals/recordPayment.invoiceCap.test.js` (raw `http` server + `express` router mount, mock `sendEmail`/`notifyAdminCategory`/`createEventShifts`/`onProposalSignedAndPaid`, `jwt.sign` a token, `pool.query` INSERT fixtures, prefix teardown). Client lint: `CI=true react-scripts build`.
- After B0 shifts line numbers in `drinkPlans.js`, do NOT trust the `:NNN` citations below for that file; grep the route/handler by name.

## Lane Map

```
lane: A-financials-refund-netting
  footprint:
    - server/utils/metricsQueries.js
    - server/utils/metricsQueries.test.js
    - server/routes/proposals/metadata.js
    - client/src/pages/admin/FinancialsDashboard.js
    - client/src/pages/admin/Dashboard.js
  depends_on: []
  review_fleet: full           # money/financials sensitive path
  checkpoints: { A4: code-review, A6: code-review }
  parallel_with: [B]

lane: B-extras-collection
  footprint:
    - server/routes/drinkPlans.js
    - server/routes/drinkPlans/submit.js          # new (B0)
    - server/utils/drinkPlanExtras.js             # new (B1 amount helper)
    - server/utils/invoiceHelpers.js
    - server/routes/stripe.js
    - server/routes/stripeWebhook.js
    - server/utils/beoFinalize.js
    - server/routes/invoices.js
    - client/src/components/DrinkPlanCard.js
    - client/src/pages/admin/ProposalDetail.js
    - client/src/pages/admin/EventDetailPage.js
    - scripts/backfill-extras-invoices.js         # new (B5)
  depends_on: []
  review_fleet: full           # stripe + invoices + webhook sensitive paths
  checkpoints: { B2: [database-review, code-review, security-review], B4: [database-review, code-review] }
  parallel_with: [A]
```

Run order: A and B in parallel. Within B, sequential B0 -> B1 -> B2 -> B3 -> B4; B5 is a post-deploy one-time script.

---

# Lane A: financials-refund-netting

## Task A1: `refundsInWindow` builder + net `qMoney` (paid basis)

**Files:** Modify `server/utils/metricsQueries.js`; Test `server/utils/metricsQueries.test.js`.

**Interfaces:** Produces `refundsInWindow(from, to, params, ccMode)` returning a SQL scalar-subquery string; pushes its own date params onto `params`. `qMoney(f)` unchanged signature.

- [ ] **Step 1: Write the failing test** (regex matches the exact SQL Step 3 emits)

```js
test('qMoney paid all-path nets refunds via scalar subquery, no JOIN', () => {
  const q = metrics.qMoney({ from: null, to: null, basis: 'paid', includeCc: 'all' });
  assert.match(q.sql, /FROM proposal_payments pp WHERE pp\.status = 'succeeded'/);
  assert.match(q.sql, /- \(SELECT COALESCE\(SUM\(pr\.amount\),0\) FROM proposal_refunds pr/);
  assert.doesNotMatch(q.sql, /JOIN proposals/);
});
test('qMoney paid cc-filtered nets refunds joined through proposals', () => {
  const q = metrics.qMoney({ from: '2026-06-01', to: '2026-06-30', basis: 'paid', includeCc: 'only' });
  assert.match(q.sql, /FROM proposal_refunds pr\s+JOIN proposals p2/);
  assert.match(q.sql, /p2\.cc_id IS NOT NULL/);
});
```

- [ ] **Step 2: Run to verify it fails** — `node -r dotenv/config --test server/utils/metricsQueries.test.js` -> FAIL.

- [ ] **Step 3: Implement**

```js
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

In `qMoney` paid branch, both paths, subtract `refundsInWindow(...)`. The `all` path stays join-less (scalar subquery only). Push order: `dateClause('pp.created_at', ...)` first, then `refundsInWindow` (its params follow). Export `refundsInWindow`.

- [ ] **Step 4: Run to verify it passes** -> PASS.
- [ ] **Step 5: Commit** — `git add server/utils/metricsQueries.js server/utils/metricsQueries.test.js && git commit -m "feat(financials): net succeeded refunds out of qMoney paid basis"`

## Task A2: net `qRevenue` paid monthly series

**Files:** Modify `server/utils/metricsQueries.js`; Test same suite.

- [ ] **Step 1: Failing test**

```js
test('qRevenue paid series subtracts monthly refunds', () => {
  const q = metrics.qRevenue({ from: null, to: null, basis: 'paid', includeCc: 'all' });
  assert.match(q.sql, /FROM proposal_refunds pr[\s\S]*pr\.created_at >= ms[\s\S]*ms \+ INTERVAL '1 month'/);
});
```

- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement** — in `paidValueSub` and `paidSiblingSub` (both `all` and cc variants), subtract that month's `proposal_refunds` (mirroring the payment subquery, cc variant joins proposals). A month with refunds > payments yields a negative value (intended; A6 handles rendering).
- [ ] **Step 4: Run -> PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(financials): net monthly refunds out of qRevenue paid series"`

## Task A3: net the financials "Collected" summary

**Files:** Modify `server/routes/proposals/metadata.js` (`collectedRow`); Test `server/routes/proposals/financialsNetting.test.js` (new, hand-rolled harness).

- [ ] **Step 1: Failing integration test** — build inline setup per `recordPayment.invoiceCap.test.js`. Assert the exact net, not just finite:

```js
test('financials Collected nets a succeeded refund (exact)', async () => {
  const base = (await authGet('/api/proposals/financials?basis=paid')).body.summary.collected;
  const { proposalId, paymentId } = await seedOnePaidProposalInline({ amountCents: 10000 }); // +100
  await pool.query(`INSERT INTO proposal_refunds (proposal_id, payment_id, stripe_refund_id, amount, status, reason, total_price_before, total_price_after)
                    VALUES ($1,$2,$3,4000,'succeeded','test',0,0)`, [proposalId, paymentId, 're_test_'+proposalId]); // -40
  const after = (await authGet('/api/proposals/financials?basis=paid')).body.summary.collected;
  assert.equal(Math.round((after - base) * 100), 6000); // net +$60
  await cleanupInline(proposalId);
});
```

- [ ] **Step 2: Run -> FAIL** (today the seed contributes +$100 gross).
- [ ] **Step 3: Implement** — reuse the `all`/cc branching already in `metadata.js:130-139`. Build `collDate` first, then:

```js
const collRefunds = metrics.refundsInWindow(f.from, f.to, collParams,
  f.includeCc === 'all' ? 'all' : f.includeCc);
pool.query(
  `SELECT (COALESCE(SUM(${collAmountCol}),0) - ${collRefunds})::float8 AS c
   FROM ${collTable}${collJoin}
   WHERE ${collStatusCol}='succeeded'${collDate}${collCc}`, collParams),
```

- [ ] **Step 4: Run -> PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(financials): net refunds out of the Collected summary"`

## Task A4: de-duplicate the ledger + net amount + refunded flag

**Files:** Modify `server/routes/proposals/metadata.js` (`recentPayments`); Test `financialsNetting.test.js`.

- [ ] **Step 1: Failing test**

```js
test('ledger: one row per payment, at net, flagged refunded', async () => {
  const { proposalId, paymentId } = await seedOnePaidProposalInline({ amountCents: 55000, twoInvoiceLines: true });
  await pool.query(`INSERT INTO proposal_refunds (proposal_id, payment_id, stripe_refund_id, amount, status, reason, total_price_before, total_price_after)
                    VALUES ($1,$2,$3,20000,'succeeded','test',0,0)`, [proposalId, paymentId, 're_test_'+proposalId]);
  const rows = (await authGet('/api/proposals/financials?basis=paid')).body.recentPayments.filter(r => r.id === paymentId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].refunded_cents, 20000);
  assert.equal(rows[0].net_amount, 35000);
  await cleanupInline(proposalId);
});
```

- [ ] **Step 2: Run -> FAIL** (today two rows at 55000).
- [ ] **Step 3: Implement** — replace the `LEFT JOIN invoice_payments`/`LEFT JOIN invoices` with two `LEFT JOIN LATERAL` subqueries: one picks a single display invoice (`ORDER BY ip.amount DESC, ip.id LIMIT 1`), one sums succeeded refunds. Project `refunded_cents` and `(pp.amount - refunded_cents) AS net_amount`. One row per `pp.id`.
- [ ] **Step 4: Run -> PASS.**
- [ ] **Step 5: Commit** — `git commit -m "fix(financials): one ledger row per payment, at net, with refunded flag"`

## Task A5: FinancialsDashboard renders net + refunded

**Files:** Modify `client/src/pages/admin/FinancialsDashboard.js` (`collected` at `:42`, stat at `:76`, list at `:130/:149`).

- [ ] **Step 1: Implement** — render `net_amount` per ledger row; when `refunded_cents > 0` append a muted "refunded $X.XX"; ensure `fmt$` renders a negative `collected` as negative (the existing `booked > 0 ? … : 0` guard already prevents divide-by-zero). Visible rows now foot to Collected.
- [ ] **Step 2: Verify build** — `cd client && CI=true npx react-scripts build` -> PASS.
- [ ] **Step 3: Commit** — `git commit -m "feat(financials): FinancialsDashboard shows net + refunded, tolerates negative"`

## Task A6: Dashboard.js negative tolerance + server deltaPct guard

The revenue chart (`AreaChart`), paid KPI, and prior-period `Delta` live in `Dashboard.js` (`:30/45-46/171/241`), not FinancialsDashboard. The paid basis can now go negative.

**Files:** Modify `client/src/pages/admin/Dashboard.js`; Modify `server/routes/proposals/metadata.js` (`dashboard-stats` deltaPct, `:196-245`).

- [ ] **Step 1: Server guard** — where `deltaPct` is computed from `qMoney(priorF)`, guard a negative or zero prior value so the percent does not divide-by-zero or invert sign nonsensically (render `null`/`—` when `priorValue <= 0`).
- [ ] **Step 2: Client** — the paid KPI value and the `AreaChart` `paid` series must render a negative value without crashing; the prior-period `Delta` handles a `null` pct (renders neutral).
- [ ] **Step 3: Verify build** — `cd client && CI=true npx react-scripts build` -> PASS.
- [ ] **Step 4: Commit** — `git commit -m "feat(financials): dashboard revenue chart + delta tolerate negative paid"`

---

# Lane B: extras-collection

## Task B0: extract the submit handler out of `drinkPlans.js` (behavior-inert)

**Files:** Create `server/routes/drinkPlans/submit.js`; Modify `server/routes/drinkPlans.js`.

- [ ] **Step 1: Green baseline** — `node -r dotenv/config --test server/routes/drinkPlans*.test.js` -> PASS.
- [ ] **Step 2: Move the handler** — cut the full `PUT /t/:token` body into `submit.js` as `async function handleSubmit(req, res) {...}`, keeping every import it uses (`sanitizeSelections`, `pool`, helpers). Mount in `drinkPlans.js`, **preserving the exact guard + limiter**:

```js
const { handleSubmit } = require('./drinkPlans/submit');
router.put('/t/:token',
  requireUuidToken('token', 'This drink plan is no longer available'),
  drinkPlanWriteLimiter,
  asyncHandler(handleSubmit));
```

- [ ] **Step 3: Verify size + behavior** — `npm run check:filesize` (drinkPlans.js ~748, non-growing; submit.js under cap); `node -r dotenv/config --test server/routes/drinkPlans*.test.js` -> PASS (identical behavior).
- [ ] **Step 4: Commit** — `git commit -m "refactor(drink-plans): extract PUT /t/:token submit handler (file over cap)"`

## Task B1: DB-backed extras helper + create/refresh extras invoice at submit

**Files:** Create `server/utils/drinkPlanExtras.js`; Modify `server/routes/stripe.js`, `server/utils/invoiceHelpers.js`, `server/routes/drinkPlans/submit.js`; Test `server/utils/drinkPlanExtras.test.js`, `server/routes/drinkPlans/submitExtras.test.js`.

**Interfaces:**
- `async computeExtrasBreakdown({ selections, guestCount, pricingSnapshot, numBars }, dbClient) -> { totalCents, addonCents, barRentalCents, syrupCents }` — integer cents. Mirrors the current `stripe.js:62-104` math EXACTLY (add-on rates read from `service_addons` via `dbClient`; bar rental from `pricingSnapshot.bar_rental` branching on `(numBars||0) >= 1` for first-vs-additional; syrups via `calculateSyrupCost(newSyrupIds, guestCount)`, excluding self-provided and already-in-snapshot), converting each component to cents with `Math.round(x * 100)`.
- `async findExtrasInvoice(proposalId, dbClient) -> row|null` — newest `label='Drink Plan Extras' AND status <> 'void'` (ANY non-void, INCLUDING paid/locked). This is the DEDUP finder: it guarantees we never create a second extras invoice, even in the out-of-order webhook case where the webhook already created + paid one (which `linkPaymentToInvoice` flips to `status='paid', locked=true`, invoiceHelpers.js:537-544, matching neither 'sent'/'partially_paid' nor unlocked).
- `async writeExtrasLineItems(invoiceId, { selections, guestCount, pricingSnapshot, numBars, totalCents }, dbClient)` — the addon/bar/syrup line-item logic EXTRACTED from `createDrinkPlanExtrasInvoice`. MUST take `totalCents` and keep the per-line rounding-drift reconcile block (invoiceHelpers.js:650-671) so the lines sum to `amount_due` (else a refreshed invoice shows a 1-2 cent phantom balance).
- `async findOrRefreshExtrasInvoice({ proposalId, drinkPlanId, breakdown, selections, guestCount, pricingSnapshot, numBars }, dbClient) -> invoiceRow` — `const inv = await findExtrasInvoice(...)`. If `inv` exists AND is OPEN (`status IN ('sent','partially_paid') AND NOT locked`): UPDATE `amount_due = breakdown.totalCents` and `writeExtrasLineItems(..., totalCents: breakdown.totalCents)`. If `inv` exists AND is paid/locked: return it AS-IS (extras already paid; NEVER mutate a paid invoice). If no `inv`: `createDrinkPlanExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents: breakdown.totalCents }, dbClient)`.

- [ ] **Step 1: Failing unit test for the helper** (assert against the real pricing functions, not a magic number)

```js
const { calculateSyrupCost } = require('../utils/pricingEngine');
test('computeExtrasBreakdown: syrup-only equals calculateSyrupCost in cents', async () => {
  const sel = { addOns: {}, logistics: { addBarRental: false },
                syrupSelections: { d1: ['blackberry','vanilla'] }, syrupSelfProvided: [] };
  const expectSyrupCents = Math.round(calculateSyrupCost(['blackberry','vanilla'], 75).total * 100);
  const bd = await computeExtrasBreakdown(
    { selections: sel, guestCount: 75, pricingSnapshot: { syrups: { selections: [] } }, numBars: 0 }, pool);
  assert.equal(bd.syrupCents, expectSyrupCents);
  assert.equal(bd.addonCents, 0);
  assert.equal(bd.totalCents, expectSyrupCents);
});
```

- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement `computeExtrasBreakdown`** by lifting `stripe.js:62-104` verbatim into `drinkPlanExtras.js`, taking `dbClient` for the `service_addons` lookup, and returning each component in cents. Then refactor `stripe.js` to call it: `const bd = await computeExtrasBreakdown({ selections, guestCount: data.guest_count, pricingSnapshot: data.pricing_snapshot, numBars: data.num_bars }, pool); const extrasAmount = bd.totalCents / 100;` (keeps the rest of `stripe.js`'s dollar flow byte-identical; `extrasCents` there becomes `bd.totalCents`).
- [ ] **Step 4: Run -> PASS.**

- [ ] **Step 5: Failing submit integration test** (hand-rolled harness)

```js
test('syrup-only pay-now submit creates an unpaid Drink Plan Extras invoice in a tx', async () => {
  const { token, proposalId } = await seedDrinkPlanReadyInline({ syrupOnly: true, guestCount: 75 });
  await publicPutInline(`/api/drink-plans/t/${token}`, { status: 'submitted', paid_separately: true, selections: syrupSel() });
  const inv = await pool.query(
    `SELECT status, amount_due FROM invoices WHERE proposal_id=$1 AND label='Drink Plan Extras' AND status<>'void'`,
    [proposalId]);
  assert.equal(inv.rows.length, 1);
  assert.equal(inv.rows[0].status, 'sent');
  assert.ok(inv.rows[0].amount_due > 0);
});
```

- [ ] **Step 6: Run -> FAIL.**
- [ ] **Step 7: Implement — extract `writeExtrasLineItems`, add `findExtrasInvoice` + `findOrRefreshExtrasInvoice`, wire into submit.** In `submit.js`, the syrup-only fast path (currently a single `pool.query` UPDATE) must:
  - fetch the proposal's `guest_count`, `pricing_snapshot`, `num_bars` (the current handler SELECT does not load these — extend it or add a fetch),
  - run inside a transaction with `SELECT id FROM proposals WHERE id=$1 FOR UPDATE`,
  - after the drink-plan UPDATE, when `paidSeparately && breakdown.totalCents > 0`, call `findOrRefreshExtrasInvoice(...)`,
  - do NOT call `refreshUnlockedInvoices` on the pay-now path.

```js
const bd = await computeExtrasBreakdown(
  { selections, guestCount: proposal.guest_count, pricingSnapshot: proposal.pricing_snapshot, numBars: proposal.num_bars }, client);
if (paidSeparately && bd.totalCents > 0) {
  await findOrRefreshExtrasInvoice(
    { proposalId: proposal.id, drinkPlanId: plan.id, breakdown: bd,
      selections, guestCount: proposal.guest_count, pricingSnapshot: proposal.pricing_snapshot, numBars: proposal.num_bars },
    client);
}
```

- [ ] **Step 8: Run -> PASS.**
- [ ] **Step 9: Commit** — `git commit -m "feat(potion): create Drink Plan Extras invoice at submit for all pay-now extras (incl syrup-only)"`

## Task B2: webhook links the existing extras invoice (idempotent, one predicate)

**Files:** Modify `server/routes/stripeWebhook.js` (the `drink_plan_extras`/`with_balance` block, currently `:281-287`); Test `server/routes/stripeWebhook.extrasLink.test.js`.

- [ ] **Step 1: Failing test** — submit a pay-now syrup-only plan (B1 creates the unpaid invoice), deliver `payment_intent.succeeded`; assert exactly ONE non-void extras invoice and it is now `paid`.
- [ ] **Step 2: Run -> FAIL** (today the webhook creates a second invoice).
- [ ] **Step 3: Implement** — inside the existing `if (isFirstDelivery)` guard, `const inv = await findExtrasInvoice(proposalId, dbClient)` (any non-void). If `inv` and NOT already fully paid, `linkPaymentToInvoice(inv.id, paymentRowId, extrasCents, dbClient)`; if `inv` and already paid, do nothing (idempotent); if none, `createDrinkPlanExtrasInvoice(...)` then link. The `with_balance` balance-portion routing to `findOpenInvoiceForBalance` is unchanged.
- [ ] **Step 4: Run -> PASS. Add TWO tests: (a) the `with_balance` split still links the balance portion to `findOpenInvoiceForBalance`; (b) OUT-OF-ORDER: deliver the webhook (creates + pays the invoice) BEFORE submit runs `findOrRefreshExtrasInvoice`, then assert exactly ONE non-void extras invoice exists (no duplicate).**
- [ ] **Step 5: Commit** — `git commit -m "fix(potion): webhook links the submit-created extras invoice, one canonical predicate"`

## Task B3: admin badge on the card + server-enforced finalize warning

**Files:** Modify `server/utils/beoFinalize.js` (both `finalizeDrinkPlan` and `registerFinalizeRoute`, `:85+`); the endpoint that populates the `drinkPlan` prop for `ProposalDetail.js:571` / `EventDetailPage.js:466` (grep the fetch; add `extras_unpaid_cents`); `client/src/components/DrinkPlanCard.js` (badge + finalize confirm). Test `server/utils/beoFinalize.extrasWarn.test.js`.

- [ ] **Step 1: Failing test** — a plan with an open unpaid extras invoice: `finalizeDrinkPlan(planId, actorId)` throws `ConflictError`; `finalizeDrinkPlan(planId, actorId, { overrideUnpaidExtras: true })` finalizes AND writes a `proposal_activity_log` row `action='finalized_unpaid_extras'` with the amount in `details`.

```js
await assert.rejects(() => finalizeDrinkPlan(planId, 1), /unpaid extras/i);
await finalizeDrinkPlan(planId, 1, { overrideUnpaidExtras: true });
const log = await pool.query(
  `SELECT details->>'amount_cents' AS amt FROM proposal_activity_log
   WHERE action='finalized_unpaid_extras' AND proposal_id=$1`, [proposalId]);
assert.equal(Number(log.rows[0].amt), 6000);
```

- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement**
  - `finalizeDrinkPlan(planId, actorId, opts = {})`: inside the existing transaction, before COMMIT, `const inv = await findExtrasInvoice(plan.proposal_id, client)`; if `inv` has `amount_due - amount_paid > 0` and `!opts.overrideUnpaidExtras`, throw `ConflictError('Plan has unpaid extras; confirm to finalize anyway.')`; else if overridden, add a second activity-log row mirroring the `:66-73` pattern: `INSERT ... (proposal_id, action, actor_type, actor_id, details) VALUES ($1,'finalized_unpaid_extras','admin',$2, $3)` with `details = JSON.stringify({ amount_cents, drink_plan_id: plan.id })`.
  - `registerFinalizeRoute`: read `req.body.overrideUnpaidExtras` and pass through.
  - Endpoint feeding the card: add `extras_unpaid_cents` (open extras invoice `amount_due - amount_paid`, 0 if none) to the `drinkPlan` payload.
  - `DrinkPlanCard.js`: when `drinkPlan.extras_unpaid_cents > 0`, show "Extras unpaid: $X"; the finalize control, when unpaid, confirms ("Finalize anyway? $X in extras is unpaid") and re-POSTs `{ overrideUnpaidExtras: true }`.
- [ ] **Step 4: Run server -> PASS; `cd client && CI=true npx react-scripts build` -> PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(potion): server-enforced unpaid-extras finalize warning + card badge"`

## Task B4: comp / waive (void + total_price reconcile)

**Files:** Modify `server/routes/invoices.js` (`PATCH /:id`, extend the state SELECT + void branch); `server/routes/drinkPlans/submit.js` (void-before-refresh); Test `server/routes/invoices.extrasVoid.test.js`.

- [ ] **Step 1: Failing tests** — voiding a syrup-only extras invoice leaves `total_price` and logs `action='extras_comped'`; voiding an addon extras invoice reduces `total_price` by the addon+bar-rental portion.
- [ ] **Step 2: Run -> FAIL.**
- [ ] **Step 3: Implement**
  - Extract a shared `async voidExtrasInvoiceWithReconcile(invoiceId, actorId, dbClient)` into `invoiceHelpers.js` (used by BOTH the PATCH route and `submit.js`, so the logic never drifts). It extends the state SELECT to also fetch `label, proposal_id` and the line items; keeps the `amount_paid > 0` guard (comp is unpaid-only); voids; writes `proposal_activity_log` `action='extras_comped'` (amount in `details`).
  - `total_price` reconcile: derive the folded-into-total portion from the invoice's PERSISTED line items at creation (addon lines `source_type='addon'` PLUS the bar-rental fee line identified by its description; NOT syrups), NOT a fresh price recompute, so a pricing change between submit and comp cannot corrupt the total. `proposals.total_price` is `NUMERIC(10,2)` DOLLARS (schema.sql:545), so subtract `foldedCents / 100` DOLLARS (NOT cents), then re-run `reconcileProposalPaymentStatus({ status, amountPaid, totalPrice })` (`server/utils/proposalStatus.js:18`). Syrup-only → folded = 0, `total_price` untouched.
  - In `submit.js`, on a re-submit with `paid_separately=false` where a non-void extras invoice exists, call `voidExtrasInvoiceWithReconcile(...)` BEFORE `refreshUnlockedInvoices`.
- [ ] **Step 4: Run -> PASS.**
- [ ] **Step 5: Commit** — `git commit -m "feat(potion): comp extras invoice with addon-portion total_price reconcile + void-before-refresh"`

## Task B5: one-time backfill for the live abandoned extra

**Files:** Create `scripts/backfill-extras-invoices.js`.

- [ ] **Step 1: Implement** — for a proposal id passed as an argument (Shiralee, 527): read the abandoned `requires_payment_method` extras PaymentIntent via `stripeClient`; guard with `findExtrasInvoice` (skip if a non-void one already exists), else `createDrinkPlanExtrasInvoice({ proposalId, drinkPlanId, extrasAmountCents: pi.amount }, pool)` using the PI `amount` as the authoritative figure; then cancel the stale PI(s). Idempotent. `--dry-run` flag prints intended actions without writing.
- [ ] **Step 2: Dry-run against dev** — verify the intended invoice + PI cancel with no writes.
- [ ] **Step 3: Commit** — `git commit -m "chore(potion): one-time backfill script for abandoned pay-now extras"`

Post-deploy: run once for 527. Anna (owner-handled) and Julia (past event) are manual.

---

## Review corrections applied (from the plan-review fleet + Codex)

1. B0 preserves `requireUuidToken(...) + drinkPlanWriteLimiter` (was dropping the UUID guard and referencing a nonexistent `publicLimiter`).
2. All activity-log writes/reads use `action` + `details` jsonb (no `type`/`amount_cents`/`drink_plan_id` columns exist).
3. `computeExtrasBreakdown` is async + DB-backed (service_addons), takes `numBars`, returns integer cents; the submit fast path now fetches `guest_count`/`pricing_snapshot`/`num_bars`; unit test asserts against `calculateSyrupCost`, not a magic `6000`.
4. `findExtrasInvoice` (any non-void) dedups for B1 and B2; `findOrRefreshExtrasInvoice` refreshes only when open and unlocked, reusing a paid one as-is (see Round-2 corrections).
5. B4 subtracts only `addonCents + barRentalCents` (recomputed), never syrups, from `total_price` (syrup lines are `source_type='fee'` too, so `source_type` can't discriminate).
6. B3 badge rides on the `drinkPlan` prop feeding `DrinkPlanCard` (correct path `client/src/components/DrinkPlanCard.js`, rendered by `ProposalDetail`/`EventDetailPage`), not the list endpoint; finalize gate is server-side in `beoFinalize.js`.
7. Lane A adds `Dashboard.js` (revenue chart + KPI + Delta negative tolerance) and the server `deltaPct` guard.
8. Integration tests hand-roll setup (no fictional shared helpers); assertions check exact net; the A1 test regex matches the emitted SQL.
9. `writeExtrasLineItems` extracted from `createDrinkPlanExtrasInvoice` for reuse; B4 void SELECT extended to `label`/`proposal_id`; per-checkpoint review agents named in the lane map; stale-line-number caveat noted after B0.

## Round-2 corrections (fold-in from the second plan-review + Codex)

- **Finder split (blocker):** `findExtrasInvoice` dedups on any non-void; `findOrRefreshExtrasInvoice` refreshes ONLY when open+unlocked and reuses a paid one as-is (fixes the out-of-order duplicate). B2 uses the same `findExtrasInvoice`.
- **Refund-seed NOT NULL (blocker):** every `proposal_refunds` test INSERT includes `reason, total_price_before, total_price_after` (all NOT NULL, no defaults; schema.sql:1028-1042).
- **Cents vs dollars (blocker):** B4 subtracts `foldedCents / 100` DOLLARS from `proposals.total_price` (NUMERIC dollars), never raw cents.
- **Lane footprints must include the new test files** (`financialsNetting.test.js`, `drinkPlanExtras.test.js`, `submitExtras.test.js`, `stripeWebhook.extrasLink.test.js`, `beoFinalize.extrasWarn.test.js`, `invoices.extrasVoid.test.js`) or the footprint-drift guard aborts the lane on first test write.
- **Groundings:** B3 badge endpoint = `GET /api/drink-plans/by-proposal/:proposalId` (drinkPlans.js:802, feeds both cards); price-status re-eval = `reconcileProposalPaymentStatus` (proposalStatus.js:18); the deltaPct guard site is the shared `pct` helper (metadata.js:285-286), not the route top.
- **B4 shared helper:** `voidExtrasInvoiceWithReconcile` in `invoiceHelpers.js`, called by both `invoices.js` PATCH and `submit.js` void-before-refresh.
- **B5 backfill:** use `createDrinkPlanExtrasInvoice({ ..., extrasAmountCents: pi.amount })` (authoritative PI amount), guarded by `findExtrasInvoice` for idempotency; NOT the `findOrRefreshExtrasInvoice(breakdown)` shape.
- **`computeExtrasBreakdown.totalCents` = `Math.round((addon+bar+syrup)*100)`** (the rounded SUM, matching `stripe.js:151`); the per-component `*Cents` are individually rounded for B4.
- **Missing tests to add:** out-of-order webhook (one invoice), negative-window Collected (renders negative, no floor, deltaPct null when prior <= 0), path-switch to add-to-balance (extras invoiced once).
- **Client behavior verification** (A5/A6/B3): beyond `CI=true` build, manually confirm visible rows foot to Collected, the "refunded $X" annotation renders, the chart/KPI tolerate a negative paid value, and the card badge + finalize-confirm re-POST `{overrideUnpaidExtras:true}`.
- **B0 baseline caveat:** `drinkPlans.beo.test.js` only exercises the finalized-409 guard, so B0's "identical behavior" is fully proven only once B1 adds `submitExtras.test.js`; a broken import throws at require-time, a subtle logic break would not.
