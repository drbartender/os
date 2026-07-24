---
lanes:
  - id: cancel-line-server
    footprint:
      - server/db/schema.sql
      - server/utils/proposalExtrasFold.js
      - server/utils/proposalExtrasFold.legs.test.js
      - server/utils/refundHelpers.js
      - server/utils/refundHelpers.splits.test.js
      - server/utils/refundHelpers.scope.test.js
      - server/utils/refundExecute.js
      - server/utils/lineItemCancel.js
      - server/utils/lineItemCancel.test.js
      - server/utils/gratuityStaffNotice.js
      - server/utils/lineItemRemovedNotify.js
      - server/routes/stripe.js
      - server/routes/proposals/cancelLineItem.js
      - server/routes/proposals/cancelLineItem.test.js
      - server/routes/proposals/index.js
      - scripts/money-smoke-list.txt
      - docs/fix-list-remaining-2026-07-02.md
      - README.md
      - ARCHITECTURE.md
    deps: []
    review: full-fleet
  - id: cancel-line-ui
    footprint:
      - client/src/components/PricingBreakdown.js
      - client/src/pages/admin/CancelLineDialog.js
      - client/src/pages/admin/ProposalDetail.js
      - client/src/pages/admin/EventDetailPage.js
    deps: [cancel-line-server]
    review: full-fleet
---

# Cancel Line Item Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One admin act that removes any client-visible priced line from a booked proposal, reprices the contract safely, and refunds exactly the resulting overpayment, behind a server-computed two-step confirm.

**Architecture:** A new core module (`server/utils/lineItemCancel.js`) with a per-kind target registry composes existing seams: `foldExtrasIntoProposal` (extended with staffing and adjustments legs), `refreshUnlockedInvoices`, `syncShiftsFromProposal`, and the `planRefund`/`refundExecute` chain (extended with a durable `total_scope` so overpayment refunds do not re-lower `total_price`). Preview and execute run the SAME core function; preview wraps it in a rolled-back transaction. Refunds fire post-commit, sequentially per charge, with the sweeper/webhook backstops unchanged. Spec: `docs/superpowers/specs/2026-07-22-cancel-line-item-design.md`. Plan-review fleet ran 2026-07-23; all findings folded in (see "Review-fleet resolutions" at the end).

**Tech Stack:** Node/Express, raw SQL via `pg`, node:test against the shared dev DB, Stripe via the `getStripe` DI seam, React admin client (axios `utils/api.js`).

## Global Constraints

- Proposals money is NUMERIC DOLLARS (`total_price`, `amount_paid`, `external_paid`, `proposal_addons`); invoices, `proposal_payments`, `proposal_refunds`, Stripe are INTEGER CENTS. Convert with `toCents()` (`server/utils/invoiceShared.js:21`) / `cents / 100`.
- One pooled connection per request: inside a `pool.connect()` transaction every query goes through the held `client`; release BEFORE any post-commit tail that uses helpers (CLAUDE.md).
- All Stripe calls via `server/utils/stripeClient.js` `getStripe()`; tests stub the seam (`require('../../utils/stripeClient').getStripe = () => fakeStripe` BEFORE requiring the router).
- Throw `AppError` subclasses; never `res.status(...)` for errors. `asyncHandler` lives at `server/middleware/asyncHandler` (NOT utils; cancel.js:19 is the import to copy).
- New proposals sub-route file MUST mount ABOVE `router.use('/', require('./getOne'))` in `server/routes/proposals/index.js` or `GET /:id` shadows it.
- The schema file is `server/db/schema.sql` (repo has no root-level schema.sql). Schema changes idempotent (`ADD COLUMN IF NOT EXISTS`).
- File-size soft cap 700 lines. `refundHelpers.js` and `refundExecute.js` have headroom; keep `lineItemCancel.js` under 700 (split `computeCancelTargets` into a sibling if it threatens the cap). `emailTemplates.js` is already over the soft cap: the two new email templates live INSIDE their notice modules, `emailTemplates.js` is not touched.
- Tests: co-located `*.test.js`, node:test, run ALONE against the shared dev DB. From the lane worktree (no `.env` there): `node --env-file=/home/drbartender/projects/os/.env --test <file>` (Node 26). Nonce-suffixed seed rows, full FK-ordered teardown, `await pool.end()` in `after()`.
- No em dashes in any client-visible copy.
- Hosted-package bartender rule: included 1:100 bartenders are $0 and never cancellable; only over-ratio bartenders carry price. Staffing floor everywhere in this feature: `Math.max(staffing.required, staffing.included)` (never below required, never into included $0 heads).
- Statuses: `'cancelled'` does not exist; archived+`archive_reason`. Eligibility here = status NOT IN (`'archived'`, `'completed'`).

## In-lane review cadence (server lane)

Per the execution-review cadence rule, specialized agents fire at checkpoints, not only at merge:
- After Task 2 (schema + reconciliation branch): `database-review` on the diff.
- After Task 8 (routes + refund firing): `security-review` + `code-review` on Tasks 4-8.
- Merge gate: full fleet on the whole lane, as declared in front-matter.

---

## Lane cancel-line-server

### Task 1: Fold legs for staffing and adjustments

**Files:**
- Modify: `server/utils/proposalExtrasFold.js` (params at :71-82, override branch :102-138, final snapshot :140-151)
- Test: `server/utils/proposalExtrasFold.legs.test.js` (new)

**Interfaces:**
- Consumes: `calculateProposal` (pricingEngine), existing fold contract.
- Produces: `foldExtrasIntoProposal` accepts four NEW optional params, all defaulting to current behavior: `numBartendersBefore`, `numBartendersAfter`, `adjustmentsBefore`, `adjustmentsAfter`. When omitted (`undefined`/`null`) the fold uses `proposal.num_bartenders` / `proposal.adjustments` exactly as today, so every existing caller (lab.js, submit.js) is byte-identical in behavior.

- [ ] **Step 1: Write the failing test**

Seed one client + one real hosted package + one override'd proposal directly with `pool.query` (nonce pattern), then call the fold inside a transaction and assert the override moves by the catalog delta of the changed leg only. Core test bodies:

```js
// server/utils/proposalExtrasFold.legs.test.js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { foldExtrasIntoProposal, loadRepriceAddons } = require('./proposalExtrasFold');
const { calculateProposal } = require('./pricingEngine');
if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');
const NONCE = `foldlegs-${Date.now()}`;
// before(): INSERT clients row; SELECT a real hosted service_packages row (pkg);
// INSERT proposals: guest_count 80, event_duration_hours 4, num_bars 0,
// num_bartenders 3, gratuity_rate 0, tip_jar true, adjustments
// '[{"type":"surcharge","label":"Travel","amount":100}]', total_price 2000,
// total_price_override 2000, status 'deposit_paid', amount_paid 100.
// Helper: catalogAt({numBartenders, adjustments}) = calculateProposal with
// override null and the proposal's other stored inputs; service portion =
// total - gratuity.total.

test('adjustments leg moves the override by the removed adjustment', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
    const addons = await loadRepriceAddons(client, proposalId);
    const before = [{ type: 'surcharge', label: 'Travel', amount: 100 }];
    const { snapshot } = await foldExtrasIntoProposal({
      client, proposal: p, pkg,
      addonsBefore: addons, addonsAfter: addons,
      syrupsBefore: [], syrupsAfter: [],
      numBarsBefore: 0, numBarsAfter: 0,
      adjustmentsBefore: before, adjustmentsAfter: [],
      statusChangeReason: 'test',
    });
    const row = (await client.query('SELECT total_price, total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.total_price_override), 1900); // 2000 - 100 surcharge
    assert.equal(Number(row.total_price), Number(snapshot.total));
    assert.deepEqual(snapshot.adjustments, []);           // final snapshot uses the After leg
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('numBartenders leg moves the override by hourly + surcharge for the dropped extra', async () => {
  // Same shape: numBartendersBefore 3, numBartendersAfter 2 (required for 80
  // guests on a 1:100 hosted pkg is 1, included = max(config, 1)).
  // Expected delta = serviceOf(catalogAt({numBartenders:2})) - serviceOf(catalogAt({numBartenders:3}))
  // computed from the ENGINE, not hardcoded, then assert
  // new override === 2000 + delta (delta is negative).
});

test('omitting the new params preserves existing behavior', async () => {
  // Call the fold exactly as lab.js does (no new params) with identical
  // before/after legs; assert total_price_override is unchanged (2000).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/proposalExtrasFold.legs.test.js`
Expected: FAIL. The adjustments test fails because today both legs read `proposal.adjustments` (the delta cancels, override stays 2000, and `snapshot.adjustments` still holds Travel).

- [ ] **Step 3: Implement the legs**

In `foldExtrasIntoProposal`'s destructured params add:

```js
  numBartendersBefore = null,
  numBartendersAfter = null,
  adjustmentsBefore = null,
  adjustmentsAfter = null,
```

Replace `const adjustments = proposal.adjustments || [];` usage with resolved legs directly below it:

```js
  const adjBefore = adjustmentsBefore ?? (proposal.adjustments || []);
  const adjAfter = adjustmentsAfter ?? (proposal.adjustments || []);
  const bartendersBefore = numBartendersBefore ?? proposal.num_bartenders;
  const bartendersAfter = numBartendersAfter ?? proposal.num_bartenders;
```

In the override branch, remove `numBartenders`/`adjustments` from the shared `catalogArgs` and pass per-leg:

```js
    const catalogBefore = calculateProposal({
      ...catalogArgs,
      numBartenders: bartendersBefore,
      adjustments: adjBefore,
      numBars: numBarsBefore,
      addons: addonsBefore,
      syrupSelections: syrupsBefore,
    });
    const catalogAfter = calculateProposal({
      ...catalogArgs,
      numBartenders: bartendersAfter,
      adjustments: adjAfter,
      numBars: numBarsAfter,
      addons: addonsAfter,
      syrupSelections: syrupsAfter,
    });
```

In the final snapshot call use the After legs: `numBartenders: bartendersAfter, adjustments: adjAfter`. Extend the header caller-contract comment: callers changing staffing or adjustments pass both legs AND persist the new `num_bartenders`/`adjustments` column values themselves (the fold writes only `total_price`/`pricing_snapshot`/`total_price_override`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/proposalExtrasFold.legs.test.js`
Expected: PASS (all 3).

- [ ] **Step 5: Run the suites this change reaches (fold callers)**

Run, one at a time, from the os checkout root (`node -r dotenv/config --test <f>`) or with `--env-file` from the lane:
`server/routes/drinkPlans/lab.test.js`, `server/routes/drinkPlans/submitOverride.test.js`, `server/routes/drinkPlans/submitReconcile.test.js`, `server/routes/drinkPlans/submitExtras.test.js`.
Expected: all PASS (defaults preserve behavior).

- [ ] **Step 6: Commit**

```bash
git add server/utils/proposalExtrasFold.js server/utils/proposalExtrasFold.legs.test.js
git commit -m "feat(cancel-line): fold gains staffing + adjustments before/after legs"
```

### Task 2: Durable refund scope (`proposal_refunds.total_scope`)

**Files:**
- Modify: `server/db/schema.sql` (near the `proposal_refunds` table, ~:1057-1100)
- Modify: `server/utils/refundHelpers.js` (`applyRefundReconciliation`, :112-302)
- Modify: `server/utils/refundExecute.js` (params :41-45, pending INSERT :49-58)
- Test: `server/utils/refundHelpers.scope.test.js` (new)

**Interfaces:**
- Consumes: existing reconciliation flow.
- Produces: `refundExecute({ ..., totalScope = 'contract' })` writes `proposal_refunds.total_scope`; `applyRefundReconciliation(params, dbClient)` accepts optional `params.totalScope` and resolves effective scope as: pending row's stored `total_scope` when a pending row is found, else `params.totalScope`, else `'contract'`. Behavior under `'overpayment'`: `proposals.total_price` NOT touched, invoice `amount_due` NOT touched; `amount_paid` (proposal and per-invoice) still drops; negative `invoice_payments` reversal rows still written; demote-only status reconcile unchanged.

**Why (verbatim rationale for the reviewer):** Approach A makes a contract-labeled refund lower `total_price` (refundHelpers.js:243-260). The cancel flow lowers the total via the fold FIRST; if its refund then re-lowers, the contract drops twice (a $200 removal ends $400 lower). The scope must live ON the refund row because the charge.refunded webhook and the stranded-pending sweeper adopt pending rows in a later process with no memory of the caller.

- [ ] **Step 1: Schema**

Append to `server/db/schema.sql` in the migrations region (idempotent):

```sql
-- Cancel-line-item refunds (2026-07-23): 'overpayment' refunds return money the
-- client overpaid AFTER the fold already corrected total_price, so reconciliation
-- must not re-lower the total (double-lower). Durable on the row because the
-- charge.refunded webhook and the stale-pending sweeper adopt pending rows later.
ALTER TABLE proposal_refunds ADD COLUMN IF NOT EXISTS total_scope TEXT NOT NULL DEFAULT 'contract';
```

Apply to the shared dev DB NOW, before any test run in this task or later ones: Claude runs the ALTER via the Neon MCP `run_sql` against the dev branch the os `.env` `DATABASE_URL` points at (fallback: psql with that URL). Prod picks the statement up through the normal idempotent schema apply at deploy. Verify: `SELECT column_name FROM information_schema.columns WHERE table_name = 'proposal_refunds' AND column_name = 'total_scope'` returns one row.

- [ ] **Step 2: Write the failing test**

```js
// server/utils/refundHelpers.scope.test.js
// Seeds: client; proposal total_price 800, amount_paid 1000 (the post-fold
// overpaid state), status 'balance_paid'; one locked 'Balance' invoice
// amount_due 70000, amount_paid 100000, status 'paid'; one proposal_payments
// row amount 100000 'succeeded' intent 'pi_scope_1'; invoice_payments link
// +100000. Then a pending proposal_refunds row amount 20000,
// total_scope 'overpayment', stripe_payment_intent_id 'pi_scope_1'
// (INSERT includes non-null total_price_before/total_price_after: 800/800).

test('overpayment scope: amount_paid drops, total_price and invoice amount_due untouched', async () => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const recon = await applyRefundReconciliation({
      proposalId, stripeRefundId: `re_${NONCE}_1`, paymentIntentId: 'pi_scope_1',
      paymentId, amountCents: 20000, reason: 'test', issuedBy: adminId,
    }, dbClient);
    await dbClient.query('COMMIT');
    assert.equal(recon.applied, true);
    const p = (await pool.query('SELECT total_price, amount_paid, status FROM proposals WHERE id=$1', [proposalId])).rows[0];
    assert.equal(Number(p.total_price), 800);      // NOT re-lowered
    assert.equal(Number(p.amount_paid), 800);      // 1000 - 200
    assert.equal(p.status, 'balance_paid');        // paid >= total: no demotion
    const inv = (await pool.query('SELECT amount_due, amount_paid, status FROM invoices WHERE id=$1', [invId])).rows[0];
    assert.equal(Number(inv.amount_due), 70000);   // due owned by refresh, untouched
    assert.equal(Number(inv.amount_paid), 80000);  // 100000 - 20000
    const rev = (await pool.query('SELECT amount FROM invoice_payments WHERE payment_id=$1 AND amount < 0', [paymentId])).rows;
    assert.equal(rev.length, 1); assert.equal(Number(rev[0].amount), -20000);
  } finally { dbClient.release(); }
});

test('contract scope (default) still drops total_price and amount_due', async () => {
  // Fresh geometry, NO pending row, params without totalScope: assert
  // total_price 800 -> 600 and invoice amount_due 70000 -> 50000 after a 20000
  // refund. This pins that existing panel/cancel-event behavior is unchanged.
});

test('webhook-style adoption honors the stored row scope', async () => {
  // Pending row with total_scope 'overpayment'; call applyRefundReconciliation
  // WITHOUT params.totalScope (as chargeRefunded does). Assert total_price
  // untouched: the row, not the caller, is the source of truth.
});

test('idempotent replay + tip clawback no-op (spec: gratuity rides existing clawback)', async () => {
  // Call applyRefundReconciliation a second time with the same stripeRefundId:
  // recon.applied === false, no double drop. Then
  // await clawbackTipByPaymentIntent('pi_scope_1', 20000): resolves without
  // touching payout_events (no tips row exists for this intent).
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/refundHelpers.scope.test.js`
Expected: FAIL on tests 1 and 3 (`total_price` drops to 600).

- [ ] **Step 4: Implement**

`refundExecute.js`: add `totalScope = 'contract'` to the destructured params. **Extend the CURRENT pending INSERT at :49-58 in place; do NOT retype it.** The existing statement binds nine values including the NOT NULL `total_price_before` and `total_price_after` (server/db/schema.sql:1065-1066, `NUMERIC(10,2) NOT NULL`, no default); dropping either breaks EVERY refund path at insert time. The change is append-only:

```
  columns:  ... existing nine ... , total_scope
  values:   ... existing $1..$N ..., $N+1
  params:   [...existing bindings..., totalScope]
```

Pass `totalScope` through to `applyRefundReconciliation`.

`refundHelpers.js` `applyRefundReconciliation`: add `total_scope` to the pending-row SELECT (the idempotency/pending lookup around :128-158); resolve once:

```js
  const scope = (pending.rows[0] && pending.rows[0].total_scope)
    || totalScope   // new optional destructured param
    || 'contract';
```

Fresh-insert branch (:160-169): include `total_scope` with value `scope`. In the link-walk loop the invoice UPDATE branches:

```js
      const upd = scope === 'overpayment'
        ? await dbClient.query(
            `UPDATE invoices SET amount_paid = GREATEST(amount_paid - $1, 0)
              WHERE id = $2 RETURNING amount_due, amount_paid`,
            [take, link.invoice_id])
        : await dbClient.query(
            `UPDATE invoices
                SET amount_paid = GREATEST(amount_paid - $1, 0),
                    amount_due  = GREATEST(amount_due  - $1, 0)
              WHERE id = $2 RETURNING amount_due, amount_paid`,
            [take, link.invoice_id]);
```

Then:

```js
  const contractCents = scope === 'overpayment' ? 0 : amountCents - nonContractCents;
```

(`paidDropCents` unchanged; `totalAfter` then computes to `totalBefore` for overpayment scope, which is the correct audit figure on the refund row.) Extend the block comment at :172-180 with the scope rule. Nothing else changes: status reconcile, autopay disarm, off-ledger subtraction all run as-is.

- [ ] **Step 5: Run to verify pass, then the reached suites**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/refundHelpers.scope.test.js` (PASS), then one at a time:
`server/utils/refundHelpers.test.js`, `server/routes/proposals/cancel.test.js`, `server/routes/stripe.webhook.test.js`, `server/utils/refundSweepScheduler.test.js`, `server/routes/proposals/notifyRefunds.test.js`.
Expected: all PASS (default scope preserves every existing path).

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql server/utils/refundHelpers.js server/utils/refundExecute.js server/utils/refundHelpers.scope.test.js
git commit -m "feat(cancel-line): durable total_scope on refunds; overpayment scope skips total_price re-lower"
```

- [ ] **Step 7: Checkpoint review**

Run the `database-review` agent on this task's diff (schema + reconciliation). Findings fixed before proceeding.

### Task 3: Overpayment split planner + shared payments query

**Files:**
- Modify: `server/utils/refundHelpers.js` (add two exports)
- Modify: `server/routes/stripe.js` (:459-472, replace inline SQL with the helper)
- Test: `server/utils/refundHelpers.splits.test.js` (new)

**Interfaces:**
- Produces:
  - `loadPaymentsWithRemaining(proposalId, dbClient)` → `[{ id, stripe_payment_intent_id, remainingCents }]`. EXACT extraction of the SQL at stripe.js:459-472 (succeeded payments, non-null intent, `payment_type IN ('deposit','balance','full','invoice')`, remaining = amount minus succeeded+pending refunds). `dbClient` optional, defaults to `pool`. This is the ONLY stripe.js edit in the feature: a minimal, behavior-identical extraction so the cancel route and the panel share one source of money truth instead of duplicating the SQL; the spec's "no change to panel refund behavior" fence is honored by the Step 4 regression runs.
  - `planOverpaymentSplits({ paymentsWithRemaining, overpaymentCents })` → `{ splits: [{ paymentId, paymentIntentId, amountCents }], stripeRefundableCents, manualReturnCents }`. PURE. Largest-remaining-first (same tie-break instinct as `planRefund`), greedy `min(needed, remaining)` per charge, never spans a charge in one split. `manualReturnCents` = overpayment left after all charge headroom (external/CC money): returned by hand, never via Stripe.

- [ ] **Step 1: Write the failing test (pure, no DB)**

```js
// server/utils/refundHelpers.splits.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planOverpaymentSplits } = require('./refundHelpers');

test('splits an overpayment across two charges, largest first', () => {
  const r = planOverpaymentSplits({
    paymentsWithRemaining: [
      { id: 1, stripe_payment_intent_id: 'pi_a', remainingCents: 10000 },
      { id: 2, stripe_payment_intent_id: 'pi_b', remainingCents: 90000 },
    ],
    overpaymentCents: 95000,
  });
  assert.deepEqual(r.splits, [
    { paymentId: 2, paymentIntentId: 'pi_b', amountCents: 90000 },
    { paymentId: 1, paymentIntentId: 'pi_a', amountCents: 5000 },
  ]);
  assert.equal(r.stripeRefundableCents, 95000);
  assert.equal(r.manualReturnCents, 0);
});

test('external-paid remainder becomes manualReturnCents', () => {
  const r = planOverpaymentSplits({
    paymentsWithRemaining: [{ id: 1, stripe_payment_intent_id: 'pi_a', remainingCents: 10000 }],
    overpaymentCents: 25000,   // 150.00 of it was Zelle/CC money
  });
  assert.equal(r.stripeRefundableCents, 10000);
  assert.equal(r.manualReturnCents, 15000);
});

test('zero overpayment yields no splits', () => {
  const r = planOverpaymentSplits({ paymentsWithRemaining: [], overpaymentCents: 0 });
  assert.deepEqual(r.splits, []);
  assert.equal(r.manualReturnCents, 0);
});

test('skips exhausted and intent-less rows', () => {
  const r = planOverpaymentSplits({
    paymentsWithRemaining: [
      { id: 1, stripe_payment_intent_id: null, remainingCents: 5000 },
      { id: 2, stripe_payment_intent_id: 'pi_b', remainingCents: 0 },
      { id: 3, stripe_payment_intent_id: 'pi_c', remainingCents: 3000 },
    ],
    overpaymentCents: 4000,
  });
  assert.deepEqual(r.splits, [{ paymentId: 3, paymentIntentId: 'pi_c', amountCents: 3000 }]);
  assert.equal(r.manualReturnCents, 1000);
});
```

- [ ] **Step 2: Run to verify it fails** (function not exported), **Step 3: Implement**

```js
// refundHelpers.js
function planOverpaymentSplits({ paymentsWithRemaining, overpaymentCents }) {
  const splits = [];
  let needed = Math.max(0, Math.trunc(Number(overpaymentCents) || 0));
  const candidates = (paymentsWithRemaining || [])
    .filter((p) => p.remainingCents > 0 && p.stripe_payment_intent_id)
    .sort((a, b) => b.remainingCents - a.remainingCents);
  for (const p of candidates) {
    if (needed <= 0) break;
    const take = Math.min(needed, p.remainingCents);
    splits.push({ paymentId: p.id, paymentIntentId: p.stripe_payment_intent_id, amountCents: take });
    needed -= take;
  }
  const stripeRefundableCents = splits.reduce((s, x) => s + x.amountCents, 0);
  return { splits, stripeRefundableCents, manualReturnCents: needed };
}
```

`loadPaymentsWithRemaining(proposalId, dbClient = pool)`: lift stripe.js:459-472 verbatim into the helper (note: `refundHelpers.js` currently has no `pool` import; add `const { pool } = require('../db');` matching sibling utils). Replace the inline block in stripe.js with a call. Export both.

- [ ] **Step 4: Run to verify pass, plus the refactored route's suite**

Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/refundHelpers.splits.test.js` (PASS), then `server/utils/refundHelpers.test.js` and `server/routes/stripe.webhook.test.js` (PASS: refactor is behavior-identical).

- [ ] **Step 5: Commit**

```bash
git add server/utils/refundHelpers.js server/utils/refundHelpers.splits.test.js server/routes/stripe.js
git commit -m "feat(cancel-line): pure overpayment split planner + shared payments-with-remaining loader"
```

### Task 4: Core module part 1: target parsing, seed factory, target enumeration

**Files:**
- Create: `server/utils/lineItemCancel.js`
- Test: `server/utils/lineItemCancel.test.js` (new; the `seedProposal` factory is DEFINED HERE and extended in Task 5)

**Interfaces:**
- Produces:
  - `parseCancelTarget(str)` → `{ kind, key }` or throws `ValidationError`. Kinds: `addon` (key = slug), `bar`, `syrup` (key = catalog id), `extra-bartender`, `adjustment` (key = integer index), `gratuity`, `package`.
  - `CANCEL_BLOCKED_STATUSES = ['archived', 'completed']`
  - `computeCancelTargets(dbClient, proposalId)` → `{ eligible: bool, targets: [...] }`. Target entry: `{ target, label, amount, quantity?, count?, rate?, labOwned?, cancellable, reason? }`. `amount` is the stored snapshot's dollar figure for display; the true money delta always comes from preview.
  - Staffing floor helper used by BOTH Task 4 and Task 5: `removableBartenders({ pkg, guestCount, actual })` = `Math.max(0, actual - Math.max(required, included))` where `required = Math.max(1, Math.ceil(guestCount / (pkg.guests_per_bartender || 100)))` and `included = isHostedPackage(pkg) ? Math.max(Number(pkg.bartenders_included || 1), required) : Number(pkg.bartenders_included || 1)` (the exact formulas at pricingEngine.js:118-152; comment cites them). `extra-bartender` count and the removal cap are the SAME number by construction, so the UI can never offer a removal the floor rejects.

- [ ] **Step 1: Define `seedProposal` + write the failing tests**

`seedProposal(opts)` (local to the test file; pattern: `cancel.test.js:95` `seedBooked`): inserts client, proposal (hosted pkg from catalog, guest_count 80, duration 4, `num_bars`, `num_bartenders`, `adjustments`, `gratuity_rate`, `tip_jar`, `total_price_override`, `status`, `amount_paid`, a REAL engine snapshot built by calling `calculateProposal` in the seed so the stored total is honest), addon rows via `INSERT INTO proposal_addons ...` (from the engine's addonResults), optional `drink_plans` row with `labAdded` selections, optional invoices/payments. All money assertions computed from the ENGINE at catalog (a `catalogAt` helper like Task 1's), never hardcoded dollars. Nonce + FK-ordered teardown.

```js
test('parseCancelTarget accepts every kind and rejects junk', () => {
  assert.deepEqual(parseCancelTarget('addon:champagne-toast'), { kind: 'addon', key: 'champagne-toast' });
  assert.deepEqual(parseCancelTarget('bar'), { kind: 'bar', key: null });
  assert.deepEqual(parseCancelTarget('syrup:jalapeno'), { kind: 'syrup', key: 'jalapeno' });
  assert.deepEqual(parseCancelTarget('extra-bartender'), { kind: 'extra-bartender', key: null });
  assert.deepEqual(parseCancelTarget('adjustment:2'), { kind: 'adjustment', key: 2 });
  assert.deepEqual(parseCancelTarget('gratuity'), { kind: 'gratuity', key: null });
  assert.throws(() => parseCancelTarget('adjustment:x'), /target/i);
  assert.throws(() => parseCancelTarget('addon:'), /target/i);
  assert.throws(() => parseCancelTarget('package:1'), /target/i);  // package takes no key
  assert.throws(() => parseCancelTarget('drop-everything'), /target/i);
});

test('computeCancelTargets enumerates every client-visible line', async () => {
  // seedProposal: override'd, num_bars 2, one flat addon qty 2, one lab-added
  // addon, snapshot syrups ['jalapeno'], num_bartenders = floor + 1 (floor =
  // max(required, included)), one discount adjustment, gratuity_rate 25.
  const { eligible, targets } = await computeCancelTargets(pool, proposalId);
  assert.equal(eligible, true);
  const byTarget = Object.fromEntries(targets.map((t) => [t.target, t]));
  assert.equal(byTarget['package'].cancellable, false);
  assert.equal(byTarget['package'].reason, 'event_cancel');
  assert.equal(byTarget['bar'].quantity, 2);
  assert.equal(byTarget['addon:photo-booth'].quantity, 2);
  assert.equal(byTarget['addon:champagne-toast'].labOwned, true);
  assert.ok(byTarget['syrup:jalapeno']);
  assert.equal(byTarget['extra-bartender'].count, 1);   // removableBartenders()
  assert.ok(byTarget['adjustment:0']);
  assert.equal(byTarget['gratuity'].rate, 25);
});

test('hosted proposal at included staffing offers NO extra-bartender target', async () => {
  // seedProposal with num_bartenders = max(required, included): assert no
  // 'extra-bartender' entry exists (included $0 heads are not cancel targets).
});

test('computeCancelTargets: archived proposal is ineligible', async () => {
  // seed status 'archived' -> { eligible: false, targets: [] }
});

test('orphaned addon row (addon_id NULL) is listed but not cancellable', async () => {
  // UPDATE proposal_addons SET addon_id = NULL on one row; assert entry has
  // target null, cancellable false, reason 'orphaned_addon' (the fold cannot
  // reprice a row that no longer joins service_addons; admin uses the editor).
});
```

- [ ] **Step 2: Run to fail**, **Step 3: Implement**

```js
// server/utils/lineItemCancel.js (header comment: cite the spec path and the
// caller contract: preview = same core inside a rolled-back tx)
const { ValidationError, ConflictError, NotFoundError } = require('./errors');

const CANCEL_BLOCKED_STATUSES = ['archived', 'completed'];
const KINDS = new Set(['addon', 'bar', 'syrup', 'extra-bartender', 'adjustment', 'gratuity', 'package']);
const KEYED = new Set(['addon', 'syrup', 'adjustment']);

function parseCancelTarget(str) {
  if (typeof str !== 'string' || !str) throw new ValidationError({ target: 'Missing cancel target' });
  const i = str.indexOf(':');
  const kind = i === -1 ? str : str.slice(0, i);
  const rawKey = i === -1 ? null : str.slice(i + 1);
  if (!KINDS.has(kind)) throw new ValidationError({ target: `Unknown cancel target kind: ${kind}` });
  if (KEYED.has(kind) === (rawKey === null || rawKey === ''))
    throw new ValidationError({ target: `Malformed cancel target: ${str}` });
  if (kind === 'adjustment') {
    const idx = Number(rawKey);
    if (!Number.isInteger(idx) || idx < 0) throw new ValidationError({ target: `Bad adjustment index: ${rawKey}` });
    return { kind, key: idx };
  }
  return { kind, key: rawKey };
}
```

`computeCancelTargets(dbClient, proposalId)`:
1. Load proposal + `service_packages` (LEFT JOIN); `NotFoundError` if missing; `eligible = !CANCEL_BLOCKED_STATUSES.includes(status)`; if ineligible return `{ eligible: false, targets: [] }`.
2. Load addon rows: `SELECT pa.id, pa.addon_id, pa.addon_name, pa.billing_type, pa.quantity, pa.line_total, sa.slug FROM proposal_addons pa LEFT JOIN service_addons sa ON sa.id = pa.addon_id WHERE pa.proposal_id = $1 ORDER BY pa.id`.
3. Load lab ownership: `SELECT selections FROM drink_plans WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`; `labSlugs` = keys of `selections.addOns` where `meta.labAdded === true`.
4. Emit, in this order (mirrors the breakdown): `package` (label = pkg name, amount = `snap.package.base_cost`, `cancellable: false, reason: 'event_cancel'`); `bar` when `num_bars > 0` and `Number(snap.bar_rental?.total || 0) > 0` (quantity = num_bars); one entry per addon row (`addon:<slug>`; orphaned rows as in the test; `quantity` exposed only when `billing_type` is not `per_guest`/`per_guest_timed`/`per_staff` AND stored quantity > 1, mirroring `withRepriceQuantities`); one `syrup:<id>` per `snap.syrups.selections` entry (amount null: syrup pricing is pack math, per-syrup delta is preview's job); `extra-bartender` when `removableBartenders(...) > 0` (count = that number, amount = snap.staffing.total); `adjustment:<idx>` per adjustments entry (label per the engine's fallback: `adj.label || (adj.type === 'discount' ? 'Discount' : 'Surcharge')`, amount signed negative for discounts); `gratuity` when `Number(gratuity_rate) > 0` (rate, amount = snap.gratuity?.total).
5. Every emitted entry defaults `cancellable: true` unless stated otherwise.

- [ ] **Step 4: Run to pass**: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/lineItemCancel.test.js`
- [ ] **Step 5: Commit**

```bash
git add server/utils/lineItemCancel.js server/utils/lineItemCancel.test.js
git commit -m "feat(cancel-line): target parsing + cancellable-line enumeration"
```

### Task 5: Core module part 2: `applyLineItemCancel` (mutations, fold, invoices, shifts, lab cleanup)

**Files:**
- Modify: `server/utils/lineItemCancel.js`
- Test: `server/utils/lineItemCancel.test.js` (extend the Task 4 file and its `seedProposal`)

**Interfaces:**
- Consumes: Task 1 fold legs; `loadRepriceAddons`/`withRepriceQuantities`; `refreshUnlockedInvoices`, `createAdditionalInvoiceIfNeeded`, `writeLineItems`, `syncShiftsFromProposal`; `reconcileProposalPaymentStatus` (via the fold); the tolerant snapshot reader `readSnapshot` (grep `readSnapshot` — payrollAccrual.js:299 imports it; use the same module).
- Produces:

```js
async function applyLineItemCancel(client, {
  proposalId, target,            // parsed or raw string
  quantity = null,               // addon partial / bar count to remove; default ALL
  newRate = null,                // gratuity kind only; null/0 = remove entirely
  actorId, expectFingerprint = null,
}) -> {
  oldTotal, newTotal, snapshot, statusChanged, newStatus,
  overpaymentCents,              // max(0, round(amount_paid*100) - round(newTotal*100))
  removedLabel,
  lockedInvoices,                // [{ id, label, amount_due }] cents
  deltaInvoicesAdjusted,         // [{ id, label, fromCents, toCents }]
  staffingWarning,               // { role, approved, desired } | null
  labCleaned,                    // bool (drink_plans.selections was stripped)
  labPlanId,                     // for the post-commit shopping-list refresh
  gratuity,                      // { newRate, tipJarAfter, staffNotice } | null
  fingerprint,                   // { updated_at, amount_paid, total_price } pre-mutation
}
```

MUST run inside the caller's transaction; takes its own `SELECT * FROM proposals WHERE id = $1 FOR UPDATE` as the first statement (mirrors the fold contract). Throws `ConflictError('...', 'STALE_PREVIEW')` when `expectFingerprint` mismatches, `ConflictError('...', 'NOT_CANCELLABLE')` on blocked status, `ValidationError` on bad targets/params, `ConflictError('...', 'PACKAGE_IS_EVENT_CANCEL')` for `package`, `ConflictError('...', 'AT_STAFFING_FLOOR')` when no bartender is removable.

- [ ] **Step 1: Extend `seedProposal` + write the failing per-kind tests**

Tests, each opening its own tx and ROLLBACKing (except where noted), every one asserting `total_price === snapshot.total` and `total_price_override` moved by exactly the engine's catalog service delta on override'd seeds:

```js
test('addon full removal deletes the row and lowers an override contract by catalog price', ...);
test('addon partial removal lowers quantity; snapshot line and row line_total agree', ...);
  // flat addon qty 2 -> quantity:1 removed; assert proposal_addons.quantity=1
  // and line_total === snapshot.addons entry line_total for that id.
test('quantity param rejected for per_guest and per_staff addons', ...);   // ValidationError
test('bar removal drops num_bars and prices via additional_bar_fee', ...); // 2 -> 1: delta = -additional_bar_fee
test('syrup removal prunes snapshot selections and prices the pack delta', ...);
test('extra-bartender removal floors at max(required, included)', ...);
  // actual = floor + 2, remove 5 -> newActual === floor; assert
  // proposals.num_bartenders === floor and snapshot.staffing.extra shrank;
  // then a proposal AT the floor: throws AT_STAFFING_FLOOR.
test('extra-bartender removal on a proposal with approved heads sets staffingWarning', ...);
  // seed shift + approved shift_requests > desired; assert warning shape.
test('adjustment removal of a discount RAISES the total', ...);
  // overpaymentCents 0; assert newTotal > oldTotal.
test('discount removal with locked invoices mints an Additional Services invoice for the rise', ...);
  // seed a locked paid Balance invoice; assert a new 'Additional Services'
  // invoice exists with amount_due === toCents(newTotal) - toCents(oldTotal).
test('discount removal with an unlocked Balance invoice mints NOTHING extra', ...);
  // the refreshed Balance absorbs it; assert no 'Additional Services' row.
test('gratuity full removal zeroes rate, flips tip_jar on, passes the DB CHECK', ...);
  // seed tip_jar false, rate 50; newRate null -> rate 0, tip_jar true,
  // gratuity.staffNotice true; COMMIT then re-read to prove the CHECK accepted it; cleanup after.
test('gratuity lower to 30 keeps notice on (below 50 floor) and forces jar', ...);
test('gratuity lower to 60 from 80 with jar already off: no flip, no notice', ...);
test('gratuity raise rejected', ...);                                      // ValidationError
test('package target throws PACKAGE_IS_EVENT_CANCEL', ...);
test('archived proposal throws NOT_CANCELLABLE', ...);
test('stale fingerprint throws STALE_PREVIEW', ...);
test('lab-added addon removal strips drink_plans.selections and reports labCleaned', ...);
  // assert selections.addOns no longer has the slug; labSyrupSelections intact.
test('lab syrup removal strips labSyrupSelections for that syrup id', ...);
test('fully-paid removal computes overpaymentCents and demotes nothing when paid >= new total is false', ...);
  // total 2000 paid 2000, remove catalog-100 addon -> overpaymentCents 10000,
  // statusChanged false (balance_paid stays: reconcile demotes only when paid < total).
test('open Additional Services invoice reconciles down to the remainder', ...);
  // locked Balance (paid) + open unlocked 'Additional Services' invoice 15000;
  // remove the addon behind it -> deltaInvoicesAdjusted reports from 15000 to
  // the lab-remainder-math figure; invoice amount_due floored at its amount_paid.
test('locked invoices are reported and untouched', ...);
```

- [ ] **Step 2: Run to fail**, **Step 3: Implement `applyLineItemCancel`**

Order of operations (each numbered step is code in this function; keep helpers module-local):

```js
const t = typeof target === 'string' ? parseCancelTarget(target) : target;
// 1. Lock + load
const pRes = await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId]);
const proposal = pRes.rows[0];
if (!proposal) throw new NotFoundError('Proposal not found');
if (CANCEL_BLOCKED_STATUSES.includes(proposal.status))
  throw new ConflictError('Line items cannot be removed from an archived or completed proposal.', 'NOT_CANCELLABLE');
const fingerprint = {
  updated_at: proposal.updated_at instanceof Date ? proposal.updated_at.toISOString() : String(proposal.updated_at),
  amount_paid: Number(proposal.amount_paid) || 0,
  total_price: Number(proposal.total_price) || 0,
};
if (expectFingerprint && (
    expectFingerprint.updated_at !== fingerprint.updated_at
    || Number(expectFingerprint.amount_paid) !== fingerprint.amount_paid
    || Number(expectFingerprint.total_price) !== fingerprint.total_price)) {
  throw new ConflictError('This proposal changed since the preview. Review the numbers again.', 'STALE_PREVIEW');
}
if (t.kind === 'package')
  throw new ConflictError('Removing the package is an event cancellation. Use the cancel-event flow.', 'PACKAGE_IS_EVENT_CANCEL');
const pkg = (await client.query('SELECT * FROM service_packages WHERE id = $1', [proposal.package_id])).rows[0];
const snapBefore = readSnapshot(proposal.pricing_snapshot);
const oldTotal = Number(proposal.total_price) || 0;
```

2. Capture Before legs: `addonsBefore = await loadRepriceAddons(client, proposalId)`; `syrupsBefore = snapBefore?.syrups?.selections || []`; `numBarsBefore = proposal.num_bars ?? 0`; `bartendersBefore = proposal.num_bartenders`; `adjustmentsBefore = proposal.adjustments || []`. Defaults for After = same references.

3. Per-kind mutation (switch on `t.kind`); each branch sets its After leg(s), performs its own column/row writes, and sets `removedLabel`:
   - **addon**: find the row by slug (`JOIN service_addons`); `NotFoundError` if absent. Resolve stored reprice qty exactly as `withRepriceQuantities` does; `removeN = quantity == null ? all : validated positive int ≤ all`; reject `quantity` when billing_type is `per_guest`/`per_guest_timed`/`per_staff`. Full: `DELETE FROM proposal_addons WHERE id = $1`. Partial: `UPDATE proposal_addons SET quantity = $1 WHERE id = $2` (line_total synced in step 5b). Lab cleanup when the slug is `labAdded` in the newest `drink_plans.selections`: `SELECT id, selections, shopping_list_status FROM drink_plans WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`, delete `selections.addOns[slug]`, write back with `UPDATE drink_plans SET selections = $1::jsonb, updated_at = NOW() WHERE id = $2`; set `labCleaned = true, labPlanId = plan.id`. (Full removal only; a partial-quantity removal of a lab item keeps the selection.) `addonsAfter = await loadRepriceAddons(client, proposalId)`.
   - **bar**: `n = quantity == null ? numBarsBefore : validated 1..numBarsBefore`; `numBarsAfter = numBarsBefore - n`; `UPDATE proposals SET num_bars = $1 WHERE id = $2`; mutate `proposal.num_bars` in memory.
   - **syrup**: key must be in `syrupsBefore` else `NotFoundError`. `syrupsAfter = syrupsBefore.filter((s) => s !== t.key)`. Lab cleanup: if the id appears in `selections.labSyrupSelections` values, remove it from every drink's array (drop empty arrays), write back as above, `labCleaned = true`.
   - **extra-bartender**: `removable = removableBartenders({ pkg, guestCount: proposal.guest_count, actual })` where `actual = proposal.num_bartenders ?? required` (Task 4 helper: floor is `Math.max(required, included)`, so included $0 heads are never removable and the count matches what the targets endpoint advertised). `if (removable <= 0) throw new ConflictError('No removable bartenders above the package staffing.', 'AT_STAFFING_FLOOR')`. `n = quantity == null ? removable : validated 1..removable`; `after = actual - n`. `UPDATE proposals SET num_bartenders = $1`; mutate in memory; `bartendersAfter = after`. Compute `staffingWarning`: desired roster bartender count vs `SELECT COUNT(*) FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id WHERE s.proposal_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL AND (sr.position IS NULL OR LOWER(TRIM(sr.position)) = 'bartender')`; warn when approved > desired.
   - **adjustment**: bounds-check idx against `adjustmentsBefore`; `adjustmentsAfter = adjustmentsBefore.filter((_, i) => i !== t.key)`; `UPDATE proposals SET adjustments = $1::jsonb`; mutate in memory; `removedLabel` per the engine fallback.
   - **gratuity**: `rate = Number(proposal.gratuity_rate) || 0`; `target = newRate == null ? 0 : Number(newRate)`; validate `Number.isFinite`, `>= 0`, `< rate` (equal or raise rejected: this flow only removes or lowers). `tipJarAfter = target >= 50 ? proposal.tip_jar : true`; `staffNotice = target < 50` (removal or below-floor shrink). `UPDATE proposals SET gratuity_rate = $1, tip_jar = $2, gratuity_rate_change_origin = 'admin' WHERE id = $3`; mutate both in memory (the fold's final snapshot reads them). Legs unchanged (serviceOf strips the client gratuity line, so the override never moves on a gratuity change; assert this in the tests).

4. Fold:

```js
const { snapshot, statusChanged } = await foldExtrasIntoProposal({
  client, proposal, pkg,
  addonsBefore, addonsAfter, syrupsBefore, syrupsAfter,
  numBarsBefore, numBarsAfter,
  numBartendersBefore: bartendersBefore, numBartendersAfter: bartendersAfter,
  adjustmentsBefore, adjustmentsAfter,
  statusChangeReason: 'line_item_cancelled',
});
```

5. Addon-partial line_total sync: `UPDATE proposal_addons SET line_total = $1 WHERE id = $2` from the matching `snapshot.addons` entry.

6. `await refreshUnlockedInvoices(proposalId, client);`

6b. Increase path (spec: adjustment removal of a discount RAISES the total): `if (toCents(snapshot.total) > toCents(oldTotal)) await createAdditionalInvoiceIfNeeded(proposalId, toCents(oldTotal), client);` — identical to the PATCH cascade (crud.js:712-713): an unlocked Balance/Full Payment absorbs the rise on rebuild; the AS invoice mints only when invoices are locked (`createAdditionalInvoiceIfNeeded` self-guards, invoiceLifecycle.js:293-335).

7. `deltaInvoicesAdjusted = await reconcileOpenDeltaInvoices(client, proposal, snapshot);` (below). Skip when the total ROSE (nothing was cancelled money-wise; step 6b owns increases).

8. `await syncShiftsFromProposal(proposalId, client);` (always; it no-ops on multi-shift and non-staffing changes).

9. Activity log (same INSERT shape as crud.js:623):

```js
await client.query(
  `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
   VALUES ($1, 'line_item_cancelled', 'admin', $2, $3)`,
  [proposalId, actorId, JSON.stringify({
    target: typeof target === 'string' ? target : `${t.kind}${t.key != null ? ':' + t.key : ''}`,
    quantity, new_rate: newRate, removed_label: removedLabel,
    old_total: oldTotal, new_total: snapshot.total,
  })]);
```

(Refund IDs cannot exist yet: refunds fire post-commit. Task 8's execute route writes the follow-up `line_item_cancel_refunded` row carrying them, per the spec's audit requirement.)

10. Result: `overpaymentCents = Math.max(0, Math.round(fingerprint.amount_paid * 100) - Math.round(Number(snapshot.total) * 100))`; `lockedInvoices` from `SELECT id, label, amount_due FROM invoices WHERE proposal_id = $1 AND locked = true AND status NOT IN ('void') ORDER BY id`; `newStatus = proposal.status` (the fold mutated it in memory on demotion).

Note on payroll (spec's extra-bartender sentence, verified during planning and confirmed by the plan fleet): `accruePayoutsForProposal` runs only for `status === 'completed'` events (payrollAccrual.js:143-145), and completed proposals are NOT cancellable here (`CANCEL_BLOCKED_STATUSES`). So there are never accrued lines to reconcile at cancel time; completion-time accrual reads the live roster and lands correct on its own. Dallas confirmed this reading at plan review (2026-07-23). The roster side is `syncShiftsFromProposal`'s shrink-cap (never below approved heads, `staffing_shrink_capped` logged), surfaced as `staffingWarning` in the preview.

`reconcileOpenDeltaInvoices(client, proposal, snapshot)` — module-local, mirrors lab.js:365-440 arithmetic with the same guarded update:

```js
const DELTA_LABELS = ['Additional Services', 'Enhancement Lab', 'Drink Plan Extras'];
// Open unlocked delta invoices, newest first, FOR UPDATE.
// absorbing = any unlocked non-void 'Balance'/'Full Payment' invoice exists.
// If absorbing: each delta invoice's demand collapses into the refreshed
//   Balance; keep = its own amount_paid (never demand below what it holds).
// Else (locked-invoice world): headroom = max(0, toCents(snapshot.total)
//   - toCents(proposal.external_paid) - lockedTotal(non-void, non-'Drink Plan
//   Extras') - openContractOthers) walked newest-first: each invoice keeps
//   min(current amount_due, max(its amount_paid, headroomLeft)); headroomLeft
//   -= kept.
// Guarded UPDATE (locked = false AND status IN ('sent','partially_paid'))
// exactly like lab.js guardedLabUpdate; when a kept figure changed, rewrite
// line items to a single line { description: `${label} (adjusted after item
// removal)`, amount: keptCents } via writeLineItems, or [] when kept = 0.
// Recompute status: amount_paid >= amount_due ? 'paid' : unchanged.
// Return [{ id, label, fromCents, toCents }] for changed rows only.
```

- [ ] **Step 4: Run to pass**: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/lineItemCancel.test.js`
- [ ] **Step 5: Re-run Task 1 and Task 2 suites** (fold + refund files share seams): `proposalExtrasFold.legs.test.js`, `refundHelpers.scope.test.js`. Expected: PASS.
- [ ] **Step 6: Commit**

```bash
git add server/utils/lineItemCancel.js server/utils/lineItemCancel.test.js
git commit -m "feat(cancel-line): applyLineItemCancel core: per-kind mutations, fold, invoice + lab + shift seams"
```

### Task 6: Gratuity staff notice

**Files:**
- Create: `server/utils/gratuityStaffNotice.js` (template lives IN this module; `emailTemplates.js` is over the soft cap and is not touched)
- Test: one direct unit test appended to `server/utils/lineItemCancel.test.js` (route-level coverage lands in Task 8)

**Interfaces:**
- Produces: `sendGratuityRemovedStaffNotice({ proposalId, newRate })` → `{ sent: n, failed: n }`. Exposes `__setDeps({ sendEmail })` for tests (the `refundNotify.__setDeps` convention).

- [ ] **Step 1: Implement (small module, ~100 lines)**

Recipient query: the exact approved-non-dropped roster join from `staffShiftHandlers.js:542-554` (copy it verbatim with a comment citing the source; recipients are the same people a reschedule notice reaches). Email only: SMS deliberately skipped (cost rule; the BEO page is the durable record and already renders tip-jar status via `GratuityTipsCard`, verified `beo.js:250-252` → `ShiftDetail.js:356-362, 500-505`). Template as a module-local function:

```js
function gratuityRemovedStaffNotice({ staffName, eventLabel, eventDate, newRate }) => {
  subject: `Tip jar update for ${eventLabel}`,
  text/html: newRate > 0
    ? `The client's prepaid gratuity for this event was lowered to $${newRate}/staff/hr. You are welcome to set out a tip jar at this event.`
    : `The client's prepaid gratuity for this event was removed. You are welcome to set out a tip jar at this event.`,
  // plus the standard event date/time block other staff emails carry
}
```

After the send loop, write the activity row:

```js
INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
VALUES ($1, 'gratuity_removed_staff_notified', 'system', NULL,
        jsonb: { new_rate, recipients: [...user ids...], failed: n })
```

Zero recipients (nobody approved yet) is a clean no-op returning `{ sent: 0, failed: 0 }` and still logs the activity row with `recipients: []`: future assignees learn from the BEO page, which reads live `tip_jar`.

- [ ] **Step 2: Unit test** (stub `sendEmail` via `__setDeps`; seed proposal + shift + 2 approved + 1 dropped `shift_requests`; assert 2 sends, dropped excluded, activity row written). Run: `node --env-file=/home/drbartender/projects/os/.env --test server/utils/lineItemCancel.test.js` → PASS.
- [ ] **Step 3: Commit**

```bash
git add server/utils/gratuityStaffNotice.js server/utils/lineItemCancel.test.js
git commit -m "feat(cancel-line): mandatory staff tip-jar notice on gratuity removal"
```

### Task 7: Client removal notice module

**Files:**
- Create: `server/utils/lineItemRemovedNotify.js` (template lives IN this module)

**Interfaces:**
- Produces: `sendLineItemRemovedNotice({ proposalId, removedLabel, newTotal })`, `__setDeps({ sendEmail })`.

Spec note (confirmed by Dallas at plan review): the spec's "nothing new is invented" refers to the notify-toggle MACHINERY (NotifyConfirmModal + `notify_client` param + send gates), which this module rides unchanged. The email template itself is necessarily new: no removal email exists.

- [ ] **Step 1: Implement**

Mirror `refundClientNotify.js`'s structure and gates (client email present + not placeholder + not archived; `__setDeps` seam). Module-local template `lineItemRemovedNotice`: subject `Your event total was updated`, body: `We removed ${removedLabel} from your event at your request. Your updated total is ${fmt dollars}.` plus the standard balance line when a balance remains. No em dashes. (Refund-case comms stay the existing refund notice; this fires only when no refund was owed.)

- [ ] **Step 2: Commit**

```bash
git add server/utils/lineItemRemovedNotify.js
git commit -m "feat(cancel-line): client removal notice (no-refund path)"
```

### Task 8: Routes: targets, preview, execute (+ refund firing, notices)

**Files:**
- Create: `server/routes/proposals/cancelLineItem.js`
- Modify: `server/routes/proposals/index.js` (mount ABOVE getOne)
- Test: `server/routes/proposals/cancelLineItem.test.js` (new)

**Interfaces:**
- Consumes: Tasks 1-7 (both notice modules now exist); `getStripe`, `refundExecute`, `loadPaymentsWithRemaining`, `planOverpaymentSplits`, `sendRefundClientNotification`, `refreshListAfterLabChange`.
- Produces (the UI lane's contract):
  - `GET /api/proposals/:id/cancel-line/targets` (auth, requireAdminOrManager) → `{ eligible, targets }` from `computeCancelTargets`.
  - `POST /api/proposals/:id/cancel-line/preview` (auth, adminOnly, adminWriteLimiter) body `{ target, quantity?, new_rate? }` → 
    ```json
    { "target": "...", "removed_label": "...",
      "old_total": 2000, "new_total": 1900, "delta": -100,
      "amount_paid": 2000, "external_paid": 0, "new_balance_due": 0,
      "overpayment_cents": 10000,
      "refund": { "splits": 1, "stripe_cents": 10000, "manual_return_cents": 0 },
      "status_will_change": false, "new_status": "balance_paid",
      "locked_invoices": [{ "id": 1, "label": "Balance", "amount_due_cents": 190000 }],
      "delta_invoices_adjusted": [{ "id": 2, "label": "Additional Services", "from_cents": 15000, "to_cents": 0 }],
      "staffing_warning": null,
      "gratuity": { "new_rate": 0, "tip_jar_after": true, "staff_notice": true },
      "lab_cleanup": false,
      "fingerprint": { "updated_at": "...", "amount_paid": 2000, "total_price": 2000 } }
    ```
    (dollars unless suffixed `_cents`; `gratuity`/`staffing_warning` null for other kinds; `new_balance_due = max(0, new_total - amount_paid)`)
  - `POST /api/proposals/:id/cancel-line` (auth, adminOnly, adminWriteLimiter) body `{ target, quantity?, new_rate?, reason, idempotency_key, notify_client, fingerprint }` → `{ removed: true, removed_label, new_total, new_status, refunds: [{ payment_id, amount_cents, status: 'succeeded'|'failed'|'unconfirmed' }], refund_incomplete: bool, manual_return_cents, notifications: [...] }`. Errors: 400 `REASON_REQUIRED`/`MISSING_IDEMPOTENCY_KEY`/`MISSING_FINGERPRINT`/validation, 409 `STALE_PREVIEW`/`NOT_CANCELLABLE`/`PACKAGE_IS_EVENT_CANCEL`/`AT_STAFFING_FLOOR`.

- [ ] **Step 1: Write the failing route tests**

Harness: exact `cancel.test.js` pattern (express app + real router + AppError middleware + `app.listen(0)` + `mintAdmin()` fresh admin per request + fake Stripe DI installed BEFORE requiring the router, with `refundFailRig`). Tests:

```js
test('targets endpoint lists lines for a booked proposal', ...);
test('preview computes the removal and CHANGES NOTHING', async () => {
  // POST preview for addon removal on a fully paid proposal; assert response
  // numbers (old/new/delta from engine, overpayment_cents, refund.splits);
  // then re-read proposals + proposal_addons + invoices: byte-identical to
  // pre-preview (the rollback guarantee).
});
test('execute removes, commits, then refunds the overpayment with scope overpayment', async () => {
  // Fully paid: assert proposal_addons row gone, total_price lowered,
  // amount_paid dropped by the refund, proposal_refunds row has
  // total_scope 'overpayment', refundsCreated captured the Stripe call,
  // response.refunds[0].status 'succeeded'.
});
test('execute splits across two charges sequentially', ...);  // seedFullChargeGeometry-style 2 intents
test('execute writes the refund audit row with refund IDs', async () => {
  // After the refund loop: proposal_activity_log has action
  // 'line_item_cancel_refunded' with details.refund_row_ids matching the
  // proposal_refunds ids and details.amount_cents summing the splits.
});
test('stripe failure leaves the removal standing and flags refund_incomplete', async () => {
  // refundFailRig.failOnCallN = 1: assert row deleted + total lowered +
  // amount_paid UNCHANGED + refunds[0].status 'failed' + refund_incomplete true;
  // proposal reads overpaid (the panel chip is the retry path); the audit row
  // records incomplete: true.
});
test('stale fingerprint 409s and changes nothing', ...);
test('partly paid removal fires no refund, just lowers the balance', ...);
test('external-paid remainder reported, only card portion fired', ...);
test('gratuity execute fires the staff notice and logs it', ...);
  // __setDeps-stub the notice module's sendEmail; assert recipients from
  // approved non-dropped shift_requests; activity row present.
test('notify_client true + refund sends the refund notice; removal-only sends the removal notice', ...);
test('lab-added removal triggers the shopping-list refresh post-commit', ...);
  // stub labListRefresh via require-cache injection; assert called with plan id.
test('lab replay after cancel does not resurrect the item (spec seam test)', async () => {
  // Mount drinkPlansRouter alongside proposalsRouter in this suite's app.
  // Cancel a lab-added addon via /cancel-line, then: (a) GET the lab: the
  // slug is absent from lab_additions; (b) PUT the lab with EMPTY desired
  // state ({ addOns: {}, labSyrupSelections: {} }): assert no proposal_addons
  // row reappears and total_price is unchanged by the PUT. (A stale tab
  // re-submitting the slug re-ADDS it as a fresh lab purchase; that is
  // deliberate client re-consent, not resurrection, and is out of scope.)
});
test('manager role can read targets but cannot POST preview/execute (403)', ...);
test('reason and idempotency_key required', ...);
test('GET /:id still returns the proposal (mount order not shadowed)', ...);
```

- [ ] **Step 2: Run to fail**, **Step 3: Implement the router**

```js
// server/routes/proposals/cancelLineItem.js
// POST preview runs applyLineItemCancel inside BEGIN..ROLLBACK: one
// computation, two callers (spec: Execution guards). Execute: same core,
// COMMIT, release, THEN refunds sequentially per split (post-commit so a
// Stripe failure can never un-remove the item), then notices.
const express = require('express');
const router = express.Router();
const { pool } = require('../../db');
// Middleware + asyncHandler imports: copy the import block VERBATIM from
// server/routes/proposals/cancel.js (asyncHandler is
// ../../middleware/asyncHandler, NOT utils; same auth/adminOnly/
// requireAdminOrManager/adminWriteLimiter modules and paths; do not guess).
const { AppError, ConflictError } = require('../../utils/errors');
const { getStripe } = require('../../utils/stripeClient');
const { refundExecute } = require('../../utils/refundExecute');
const { loadPaymentsWithRemaining, planOverpaymentSplits } = require('../../utils/refundHelpers');
const { computeCancelTargets, applyLineItemCancel } = require('../../utils/lineItemCancel');
const { sendRefundClientNotification } = require('../../utils/refundClientNotify');
const { refreshListAfterLabChange } = require('../drinkPlans/labListRefresh');
const { sendGratuityRemovedStaffNotice } = require('../../utils/gratuityStaffNotice');
const { sendLineItemRemovedNotice } = require('../../utils/lineItemRemovedNotify');

router.get('/:id/cancel-line/targets', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  res.json(await computeCancelTargets(pool, req.params.id));
}));

async function runCore(req, { expectFingerprint = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyLineItemCancel(client, {
      proposalId: req.params.id,
      target: req.body.target,
      quantity: req.body.quantity ?? null,
      newRate: req.body.new_rate ?? null,
      actorId: req.user.id,
      expectFingerprint,
    });
    const payments = await loadPaymentsWithRemaining(req.params.id, client);
    const plan = planOverpaymentSplits({ paymentsWithRemaining: payments, overpaymentCents: result.overpaymentCents });
    return { client, result, plan, commit: async () => { await client.query('COMMIT'); } };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  // On success the CALLER owns the held client: preview ROLLBACKs + releases,
  // execute COMMITs + releases BEFORE the refund/notice tail (one-pooled-
  // connection rule).
}
```

Preview handler: `const { client, result, plan } = await runCore(req);` then `await client.query('ROLLBACK'); client.release();` and shape the response per the interface (dollars from `result`, cents suffixed). Execute handler:

1. Validate `reason` (`REASON_REQUIRED`) and `idempotency_key` (`MISSING_IDEMPOTENCY_KEY`) exactly like stripe.js:435-438; require `fingerprint` object (else 400 `MISSING_FINGERPRINT`).
2. `runCore(req, { expectFingerprint: req.body.fingerprint })`; `await commit(); client.release();` (release BEFORE the tail: one-pooled-connection rule).
3. Refund loop, sequential:

```js
const refunds = [];
let refundIncomplete = false;
const stripe = getStripe();
for (let i = 0; i < plan.splits.length; i++) {
  const s = plan.splits[i];
  try {
    const r = await refundExecute({
      stripe, proposalId: req.params.id, paymentId: s.paymentId,
      paymentIntentId: s.paymentIntentId, amountCents: s.amountCents,
      reason: req.body.reason, issuedBy: req.user.id,
      idempotencyKey: `cancel-line-${req.params.id}-${req.body.idempotency_key}-${i}`,
      totalPriceBeforeDollars: result.newTotal, totalPriceAfterDollars: result.newTotal,
      totalScope: 'overpayment',
    });
    refunds.push({ payment_id: s.paymentId, amount_cents: s.amountCents, status: 'succeeded', refund_row_id: r.refundRowId });
  } catch (err) {
    refunds.push({ payment_id: s.paymentId, amount_cents: s.amountCents,
      status: err.code === 'REFUND_REJECTED' ? 'failed' : 'unconfirmed' });
    refundIncomplete = true;
    break;   // stop; the panel + sweeper are the retry path (spec: money movement)
  }
}
```

3b. Refund audit row (spec: "refund IDs when money moved"), best-effort on `pool` (client already released), only when `plan.splits.length > 0`:

```js
await pool.query(
  `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
   VALUES ($1, 'line_item_cancel_refunded', 'admin', $2, $3)`,
  [req.params.id, req.user.id, JSON.stringify({
    refund_row_ids: refunds.filter((r) => r.refund_row_id).map((r) => r.refund_row_id),
    amount_cents: refunds.filter((r) => r.status === 'succeeded').reduce((s, r) => s + r.amount_cents, 0),
    incomplete: refundIncomplete,
  })]).catch((e) => Sentry.captureException(e));
```

4. Notices, all best-effort with Sentry capture, never failing the response:
   - `result.gratuity?.staffNotice` → `await sendGratuityRemovedStaffNotice({ proposalId: req.params.id, newRate: result.gratuity.newRate })`.
   - Refund fired and succeeded and `notify_client === true` → `sendRefundClientNotification({ proposalId: req.params.id, amountCents: <succeeded sum>, source: 'cancel_line' })`.
   - No splits and `notify_client === true` → `sendLineItemRemovedNotice({ proposalId, removedLabel: result.removedLabel, newTotal: result.newTotal })`.
   - `result.labCleaned` → `setImmediate(() => refreshListAfterLabChange(result.labPlanId))`.
5. Respond per the interface.

Mount in `server/routes/proposals/index.js` with the other sub-routers, ABOVE the `getOne` line, with a comment matching the file's mount-order banner:

```js
router.use('/', require('./cancelLineItem'));   // line-item cancel: /:id/cancel-line/*
```

- [ ] **Step 4: Run to pass**: `node --env-file=/home/drbartender/projects/os/.env --test server/routes/proposals/cancelLineItem.test.js`
- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/cancelLineItem.js server/routes/proposals/cancelLineItem.test.js server/routes/proposals/index.js
git commit -m "feat(cancel-line): targets/preview/execute routes with post-commit scoped refunds"
```

- [ ] **Step 6: Checkpoint review**

Run `security-review` + `code-review` agents on Tasks 4-8 (the money core + routes). Findings fixed before proceeding.

### Task 9: Housekeeping (docs, fix-list, smoke list)

**Files:**
- Modify: `scripts/money-smoke-list.txt`, `docs/fix-list-remaining-2026-07-02.md`, `README.md`, `ARCHITECTURE.md`

- [ ] **Step 1: Edits**

- `scripts/money-smoke-list.txt`: append `server/utils/refundHelpers.scope.test.js`, `server/utils/lineItemCancel.test.js`, `server/routes/proposals/cancelLineItem.test.js`.
- `docs/fix-list-remaining-2026-07-02.md` line ~272: mark the 598987d owner-confirm item RESOLVED: `RESOLVED 2026-07-23 by the cancel-line-item feature (docs/superpowers/specs/2026-07-22-cancel-line-item-design.md): admin cancel removes the item AND settles the money in one act.`
- `README.md`: folder-tree entries for the new util/route files (`lineItemCancel.js`, `gratuityStaffNotice.js`, `lineItemRemovedNotify.js`, `proposals/cancelLineItem.js`).
- `ARCHITECTURE.md`: route table rows for the three endpoints; schema note for `proposal_refunds.total_scope`.

- [ ] **Step 2: Commit**

```bash
git add scripts/money-smoke-list.txt docs/fix-list-remaining-2026-07-02.md README.md ARCHITECTURE.md
git commit -m "docs(cancel-line): smoke list, fix-list resolution, README/ARCHITECTURE entries"
```

### Task 10 (lane gate): full server verification

- [ ] Run every touched/reached suite ONE AT A TIME (shared dev DB): `proposalExtrasFold.legs`, `refundHelpers`, `refundHelpers.scope`, `refundHelpers.splits`, `lineItemCancel`, `cancelLineItem`, `cancel`, `stripe.webhook`, `stripeWebhook.guards`, `refundSweepScheduler`, `notifyRefunds`, `lab`, `submitOverride`, `submitReconcile`, `submitExtras`, `invoiceLifecycle.external`. All PASS before the lane is offered for merge review.

---

## Lane cancel-line-ui (depends: cancel-line-server)

### Task 11: `CancelLineDialog`

**Files:**
- Create: `client/src/pages/admin/CancelLineDialog.js`

**Interfaces:**
- Consumes: the Task 8 response shapes verbatim.
- Produces: `<CancelLineDialog proposalId target label onClose onDone />`. `onDone()` = parent refetches the proposal.

- [ ] **Step 1: Implement (model: `CancelEventDialog.js`, same OVERLAY/card/btn classes; NotifyConfirmModal chaining: `ProposalDetailPaymentPanel.js:572-592`)**

Structure (~230 lines):

```jsx
// Steps: 'options' (only when the target needs input) -> 'preview' -> 'done'.
// - gratuity target: radio "Remove entirely" / "Lower to $__/staff/hr" (number
//   input; client-side hint under 50: "Below the $50 no-jar floor, the tip jar
//   turns on and staff are notified") -> loadPreview with new_rate.
// - quantity targets (targets entry has quantity > 1): "Remove how many?"
//   stepper defaulting to all.
// - everything else goes straight to loadPreview.
// Idempotency key minted at open with the panel's guarded pattern
// (ProposalDetailPaymentPanel.js:113-114):
//   window.crypto && window.crypto.randomUUID
//     ? window.crypto.randomUUID()
//     : `${Date.now()}-${Math.random()}`
const loadPreview = async () => {
  const res = await api.post(`/proposals/${proposalId}/cancel-line/preview`,
    { target, quantity, new_rate: newRate });
  setPreview(res.data); setStep('preview');
};
// Preview card rows (fmt$2dp for dollars, fmt$fromCents for *_cents):
//   Old total / New total / Change; Paid so far; then ONE consequence line:
//   - overpayment_cents > 0: "Client becomes overpaid: refund {stripe} to card"
//     + when manual_return_cents > 0 a warn row "Return {manual} manually
//     (paid outside Stripe)"
//   - else new_balance_due row: "Client now owes {new_balance_due}"
//   Conditional rows: locked_invoices ("A locked invoice for $X stands and
//   won't be rebuilt"), delta_invoices_adjusted, staffing_warning ("N approved
//   bartenders exceed the new roster; resolve assignments by hand"),
//   gratuity.staff_notice ("Staff will be notified they can set out a tip
//   jar"), status_will_change.
// Reason textarea (required) mirroring the refund panel.
// Confirm button restates the act (btn btn-danger):
//   stripe_cents > 0 ? `Remove and refund ${fmt$fromCents(stripe_cents)}`
//                    : `Remove (client owes ${fmt$2dp(Math.abs(delta))} less)`
//   (discount removal, delta > 0: `Remove (adds ${fmt$2dp(delta)} to the total)`)
// Clicking it: clientEmailUsable ? open NotifyConfirmModal (type
// 'line_item_removed', composable false, primary 'quiet') : doExecute(false).
const doExecute = async (notifyClient) => {
  try {
    const res = await api.post(`/proposals/${proposalId}/cancel-line`, {
      target, quantity, new_rate: newRate, reason: reason.trim(),
      idempotency_key: idemKey,
      notify_client: notifyClient, fingerprint: preview.fingerprint,
    });
    setResult(res.data); setStep('done');   // done view: what happened, incl.
                                            // refund_incomplete warning routing
                                            // the admin to the payment panel.
  } catch (err) {
    if (err.code === 'STALE_PREVIEW') { toast.error('Numbers changed. Review again.'); loadPreview(); }
    else toast.error(err.message || 'Failed to remove the line item.');
  }
};
```

Escape/overlay-click close on non-busy states; api error convention (`err.message`, `err.code`).

- [ ] **Step 2: Client build gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds with zero ESLint warnings (CI-fatal otherwise).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/CancelLineDialog.js
git commit -m "feat(cancel-line): admin preview/confirm dialog"
```

### Task 12: Breakdown affordance + ProposalDetail wiring

**Files:**
- Modify: `client/src/components/PricingBreakdown.js`
- Modify: `client/src/pages/admin/ProposalDetail.js` (pricing card, :588-646)

- [ ] **Step 1: PricingBreakdown optional cancel column**

New optional props `cancelTargets` (array from the targets endpoint) and `onCancelLine(targetEntry)`. Matching is by label, the codebase's established line-identity convention (`recomputeSnapshotGratuity` matches `GRATUITY_LABEL` the same way): build `const byLabel = new Map()` from `cancelTargets` using each entry's `label`, and for breakdown rows try exact label match first, then a `startsWith` match for parameterized labels (`Bar Rental (`, addon-name-prefixed lines). When a row matches an entry, render a right-aligned ✕ button (`aria-label` = `Remove ${label}`); `cancellable: false` entries render nothing (package handled below; orphaned rows get `title="Edit this in the proposal editor"` on a disabled ✕). The package row's entry (`reason: 'event_cancel'`) DOES render the ✕ but `onCancelLine` receives it and the page routes to the cancel-event flow. Unmatched cancellable entries (label drift on an old snapshot) are rendered by the page as a small "Other removable items" row under the table with the same ✕ handler, so no target is ever unreachable.

- [ ] **Step 2: ProposalDetail wiring**

- Fetch on load and after edits, only when `!['archived', 'completed'].includes(proposal.status)` (client-side literal; the server re-checks) and user is admin/manager: `api.get(`/proposals/${id}/cancel-line/targets`)` → state `cancelTargets` (silently ignore errors; affordance just doesn't render).
- `onCancelLine(entry)`: `entry.target === 'package'` → open the existing cancel-event dialog (the same state/handler the page already uses for CancelEventDialog); else `setCancelLine(entry)` → render `<CancelLineDialog proposalId={id} target={entry.target} label={entry.label} onClose={...} onDone={() => { refetch proposal + targets }} />`.
- Pass `cancelTargets={cancelTargets} onCancelLine={onCancelLine}` to the `<PricingBreakdown>` at :599. Non-admin/ineligible renders exactly as today (props undefined).

- [ ] **Step 3: Client build gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds with zero ESLint warnings.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/PricingBreakdown.js client/src/pages/admin/ProposalDetail.js
git commit -m "feat(cancel-line): per-line cancel affordance on the proposal pricing card"
```

### Task 13: EventDetailPage wiring + client gate

**Files:**
- Modify: `client/src/pages/admin/EventDetailPage.js` (pricing card :424-467)

- [ ] **Step 1:** Same wiring as Task 12 (targets fetch keyed off `derived` proposal id, `<PricingBreakdown snapshot={snapshot} cancelTargets onCancelLine>` at :435, CancelLineDialog mount, package → the page's cancel-event entry point).
- [ ] **Step 2: Client build gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds with zero ESLint warnings (CI-fatal otherwise).

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/admin/EventDetailPage.js
git commit -m "feat(cancel-line): cancel affordance on the event page pricing card"
```

---

## Manual verification (after both lanes merge, before push)

Dev DB + Stripe test mode (`STRIPE_TEST_MODE_UNTIL`), dev server restarted:

1. Booked+paid proposal with an addon: remove it from the PROPOSAL page. Preview numbers match the engine; confirm fires a real test-mode refund; payment panel shows the refund row; `total_price`/`amount_paid` consistent; Balance invoice rebuilt.
2. Same from the EVENT page on a second proposal.
3. Gratuity removal on a proposal with an approved bartender: staff email lands (SEND_NOTIFICATIONS=true against a scratch address); BEO page shows the tip-jar banner.
4. Lab-added item removal: client Lab page no longer lists it; shopping list regenerated to pending_review.
5. Simulated Stripe failure (unplug test key mid-flow or use the fail rig locally): removal stands, panel shows the overpaid chip, panel refund completes the money.

## Review scaling

Money path end to end. In-lane checkpoints as declared at the top (`database-review` after Task 2; `security-review` + `code-review` after Task 8). Both lanes get the full review fleet at merge, max effort; push-time sensitive-path fleet + `/second-opinion` per CLAUDE.md. Sensitive files touched: `refundHelpers.js`, `refundExecute.js`, `proposalExtrasFold.js`, `stripe.js`, `server/db/schema.sql`.

## Review-fleet resolutions (2026-07-23)

All plan-fleet findings folded in: lane footprint fixed (`lineItemRemovedNotify.js` added, `server/db/schema.sql` corrected); refundExecute INSERT made append-only to preserve the NOT NULL `total_price_before/after` columns; notice modules (Tasks 6-7) reordered ahead of the routes task (was a forward dependency); `seedProposal` moved to Task 4; staffing floor unified at `max(required, included)` in targets and apply; post-refund audit row added (Task 8 step 3b); dev-DB schema application owner named (Claude via Neon MCP, Task 2 step 1); asyncHandler path corrected to `server/middleware/asyncHandler`; client build gate added to every UI task; templates moved into notice modules (emailTemplates.js untouched, over soft cap); in-lane review checkpoints declared; hosted-included no-target test and clawback no-op test added; guarded randomUUID pattern adopted. Confirmed by Dallas: the payroll-accrual no-op reading (spec premise was wrong) and the necessarily-new removal-notice template riding existing toggle machinery.
