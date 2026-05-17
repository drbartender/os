# Partial Refunds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-issued partial refunds that refund a Stripe charge, correct the proposal total (Approach A), reverse any linked invoice, and leave a queryable audit ledger — with an idempotent Stripe-webhook backstop.

**Architecture:** A pure planner (`planRefund`) does all auto-targeting + validation + cents math and is unit-tested. A DB helper (`applyRefundReconciliation`) does the idempotent reconciliation and is shared verbatim by a new admin route (`POST /api/stripe/refund/:id`) and a new `charge.refunded` webhook handler. A new `proposal_refunds` table is the audit ledger. The admin UI is a collapsible section in the existing payment panel.

**Tech Stack:** Node 18 / Express, raw SQL via `pg`, Stripe Node SDK (via `server/utils/stripeClient.js`), React 18 (CRA), Node built-in test runner (`node:test` + `node:assert/strict`).

**Spec:** `docs/superpowers/specs/2026-05-17-partial-refunds-design.md`

**Money discipline (read once, applies to every task):**
- `proposals.total_price` / `proposals.amount_paid` = **dollars** (NUMERIC). Everything else (Stripe, `proposal_payments.amount`, `proposal_refunds.amount`, `invoices.amount_*`, `invoice_payments.amount`) = **integer cents**.
- All refund math runs in integer cents. The only dollar boundary is the two `proposals` columns, done in SQL with exact NUMERIC arithmetic (`- ($cents / 100.0)`), mirroring the existing webhook.
- Never `git add .` / `-A`. Stage only the exact paths listed.

**Testing reality (why tasks differ):** This repo has **no Jest/mocha**. `*.test.js` files run under `node --test` and only cover **pure** utilities (`bookingWindow.test.js`, `drinkPlanAccess.test.js`). DB helpers (`invoiceHelpers.js`) and routes have **no unit harness** by deliberate convention. So: the pure planner gets real TDD; DB/route/UI tasks are verified by `npm run lint`, careful read-through against spec invariants, and the explicit integration smoke in Task 5. Do **not** scaffold a new test framework — that would violate "follow existing patterns."

---

### Task 1: Schema — `proposal_refunds` audit ledger

**Files:**
- Modify: `server/db/schema.sql` (insert immediately after the `proposal_payments` table block + its indexes; that block ends at the `idx_proposal_payments_intent_unique` index, ~line 985)

- [ ] **Step 1: Add the idempotent table + indexes**

Insert this block right after the `idx_proposal_payments_intent_unique` index definition in `server/db/schema.sql`:

```sql
-- ─── Proposal Refunds (audit ledger for partial refunds) ─────────
-- Approach A: a refund corrects the proposal total downward (delivered
-- less than contracted). proposals.total_price + amount_paid both drop
-- by the refund, so balance-due stays $0 and nothing that computes
-- total_price − amount_paid needs to learn about refunds. This table is
-- the admin-facing history + the idempotency anchor shared by the
-- synchronous refund route and the charge.refunded webhook backstop.
CREATE TABLE IF NOT EXISTS proposal_refunds (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE RESTRICT,
  payment_id INTEGER REFERENCES proposal_payments(id) ON DELETE RESTRICT,
  stripe_payment_intent_id VARCHAR(255),
  stripe_refund_id VARCHAR(255),
  amount INTEGER NOT NULL,                 -- CENTS (Stripe-native)
  reason TEXT NOT NULL,
  total_price_before NUMERIC NOT NULL,     -- dollars, snapshot pre-refund
  total_price_after  NUMERIC NOT NULL,     -- dollars, post-refund
  issued_by INTEGER REFERENCES users(id),  -- admin/manager; NULL = dashboard refund
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_proposal_refunds_proposal_id
  ON proposal_refunds(proposal_id);
-- Idempotency anchor: at most one applied refund per Stripe refund id.
-- Partial so multiple pending rows (no refund id yet) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_proposal_refunds_stripe_refund_id
  ON proposal_refunds(stripe_refund_id)
  WHERE stripe_refund_id IS NOT NULL;
```

- [ ] **Step 2: Verify idempotency by static read-back**

Run: `grep -n "proposal_refunds" server/db/schema.sql`
Expected: the `CREATE TABLE IF NOT EXISTS proposal_refunds`, the proposal-id index, and the partial unique index all present; every statement uses `IF NOT EXISTS` (re-running schema is a no-op). No `DROP`.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(refunds): proposal_refunds audit ledger table"
```

---

### Task 2: Pure `planRefund` — auto-target + validation (TDD)

This is the heart and it is genuinely pure (no DB, no Stripe). Real failing-test-first TDD, exactly mirroring `server/utils/bookingWindow.test.js`.

**Files:**
- Create: `server/utils/refundHelpers.js`
- Test: `server/utils/refundHelpers.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/refundHelpers.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRefund } = require('./refundHelpers');

// Helper: a succeeded, intent-bearing payment with N cents still refundable.
const pay = (id, intent, remainingCents) => ({
  id, stripe_payment_intent_id: intent, remainingCents,
});

test('cents seam: $300.00 against a $1340.00 full charge → exactly 30000 cents', () => {
  const r = planRefund({
    paymentsWithRemaining: [pay(7, 'pi_full', 134000)],
    requestedDollars: '300.00',
    amountPaidDollars: 1340,
    totalPriceDollars: 1340,
  });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 30000);
  assert.equal(r.targetPaymentId, 7);
  assert.equal(r.targetIntentId, 'pi_full');
  assert.equal(r.totalPriceAfterDollars, 1040); // 1340 - 300, no float drift
});

test('auto-target picks the largest-remaining charge, never the deposit', () => {
  const r = planRefund({
    paymentsWithRemaining: [pay(1, 'pi_dep', 10000), pay(2, 'pi_bal', 124000)],
    requestedDollars: 300,
    amountPaidDollars: 1340,
    totalPriceDollars: 1340,
  });
  assert.equal(r.ok, true);
  assert.equal(r.targetPaymentId, 2);
  assert.equal(r.targetIntentId, 'pi_bal');
});

test('prior refund shrinks remaining: second refund sees reduced room', () => {
  // balance charge $1240, $1000 already refunded → only $240 left
  const r = planRefund({
    paymentsWithRemaining: [pay(2, 'pi_bal', 24000)],
    requestedDollars: 300,
    amountPaidDollars: 340,
    totalPriceDollars: 340,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXCEEDS_SINGLE_CHARGE');
  assert.equal(r.maxRefundableCents, 24000);
  assert.match(r.message, /\$240\.00/);
});

test('no-spanning: amount exceeds every single charge → reject with max', () => {
  const r = planRefund({
    paymentsWithRemaining: [pay(1, 'pi_dep', 10000), pay(2, 'pi_bal', 50000)],
    requestedDollars: 600,
    amountPaidDollars: 600,
    totalPriceDollars: 600,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXCEEDS_SINGLE_CHARGE');
  assert.equal(r.maxRefundableCents, 50000);
});

test('no refundable Stripe payments → NO_REFUNDABLE_PAYMENT', () => {
  const r = planRefund({
    paymentsWithRemaining: [],
    requestedDollars: 50,
    amountPaidDollars: 0,
    totalPriceDollars: 500,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_REFUNDABLE_PAYMENT');
});

test('amount exceeds amount_paid → EXCEEDS_AMOUNT_PAID', () => {
  const r = planRefund({
    paymentsWithRemaining: [pay(2, 'pi_bal', 999999)],
    requestedDollars: 600,
    amountPaidDollars: 100,
    totalPriceDollars: 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXCEEDS_AMOUNT_PAID');
});

test('refund below zero total → EXCEEDS_TOTAL', () => {
  const r = planRefund({
    paymentsWithRemaining: [pay(2, 'pi_bal', 999999)],
    requestedDollars: 600,
    amountPaidDollars: 600,
    totalPriceDollars: 500,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXCEEDS_TOTAL');
});

for (const bad of ['0', '-5', '', 'abc', null, undefined, NaN]) {
  test(`invalid amount rejected: ${JSON.stringify(bad)}`, () => {
    const r = planRefund({
      paymentsWithRemaining: [pay(2, 'pi_bal', 999999)],
      requestedDollars: bad,
      amountPaidDollars: 1000,
      totalPriceDollars: 1000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'INVALID_AMOUNT');
  });
}
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --test server/utils/refundHelpers.test.js`
Expected: FAIL — `Cannot find module './refundHelpers'` (file not created yet).

- [ ] **Step 3: Write the minimal implementation**

Create `server/utils/refundHelpers.js`:

```js
/**
 * Refund helpers — partial refunds (Approach A: refund corrects the total).
 *
 * planRefund() is PURE (no DB, no Stripe) → fully unit-tested.
 * applyRefundReconciliation() is DB-bound (added in Task 3).
 *
 * MONEY SEAM: proposals.total_price / amount_paid are DOLLARS (NUMERIC);
 * everything else is INTEGER CENTS. planRefund takes dollars in, returns
 * cents for all downstream Stripe/ledger use, and a dollars figure only
 * for the proposals columns.
 */

function fmtUSD(cents) {
  return '$' + (cents / 100).toFixed(2);
}

/**
 * Decide which single charge to refund against and validate the amount.
 * No DB. No spanning multiple charges.
 *
 * @param {object} args
 * @param {{id:number, stripe_payment_intent_id:string, remainingCents:number}[]} args.paymentsWithRemaining
 *        Succeeded, intent-bearing proposal_payments rows with cents still
 *        refundable (caller computes remainingCents = amount − Σ succeeded refunds).
 * @param {number|string} args.requestedDollars  raw admin input
 * @param {number} args.amountPaidDollars         proposals.amount_paid
 * @param {number} args.totalPriceDollars         proposals.total_price
 * @returns {{ok:true, amountCents:number, targetPaymentId:number,
 *            targetIntentId:string, totalPriceAfterDollars:number}
 *          | {ok:false, code:string, message:string, maxRefundableCents?:number}}
 */
function planRefund({ paymentsWithRemaining, requestedDollars, amountPaidDollars, totalPriceDollars }) {
  const n = Number(requestedDollars);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, code: 'INVALID_AMOUNT', message: 'Enter a refund amount greater than $0.00.' };
  }
  const amountCents = Math.round(n * 100);

  const candidates = (paymentsWithRemaining || []).filter(p => p.remainingCents > 0);
  if (candidates.length === 0) {
    return { ok: false, code: 'NO_REFUNDABLE_PAYMENT', message: 'No Stripe payment on this proposal is available to refund.' };
  }

  const target = candidates.reduce((a, b) => (b.remainingCents > a.remainingCents ? b : a));

  if (amountCents > target.remainingCents) {
    return {
      ok: false,
      code: 'EXCEEDS_SINGLE_CHARGE',
      maxRefundableCents: target.remainingCents,
      message: `Largest refundable payment is ${fmtUSD(target.remainingCents)}. Issue this as separate refunds of ${fmtUSD(target.remainingCents)} or less.`,
    };
  }

  const amountPaidCents = Math.round(Number(amountPaidDollars) * 100);
  if (amountCents > amountPaidCents) {
    return { ok: false, code: 'EXCEEDS_AMOUNT_PAID', message: 'Refund exceeds the amount currently paid on this proposal.' };
  }

  const totalAfterCents = Math.round(Number(totalPriceDollars) * 100) - amountCents;
  if (totalAfterCents < 0) {
    return { ok: false, code: 'EXCEEDS_TOTAL', message: 'Refund would drop the proposal total below $0.00.' };
  }

  return {
    ok: true,
    amountCents,
    targetPaymentId: target.id,
    targetIntentId: target.stripe_payment_intent_id,
    totalPriceAfterDollars: totalAfterCents / 100,
  };
}

module.exports = { planRefund, fmtUSD };
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test server/utils/refundHelpers.test.js`
Expected: PASS — all tests (cents seam, auto-target, prior-refund shrink, no-spanning, NO_REFUNDABLE_PAYMENT, EXCEEDS_AMOUNT_PAID, EXCEEDS_TOTAL, all INVALID_AMOUNT cases).

- [ ] **Step 5: Lint**

Run: `npm run lint`
Expected: no errors for `server/utils/refundHelpers.js` / `.test.js`.

- [ ] **Step 6: Commit**

```bash
git add server/utils/refundHelpers.js server/utils/refundHelpers.test.js
git commit -m "feat(refunds): pure planRefund — auto-target, no-spanning, cents-seam validation (TDD)"
```

---

### Task 3: `applyRefundReconciliation` — idempotent DB reconciliation

Shared verbatim by the route (Task 4) and the webhook (Task 5). Idempotent on `stripe_refund_id` per the spec's correlation order. No unit harness for DB helpers in this repo (consistent with `invoiceHelpers.js`); verified by lint + read-through here, integration in Task 5.

**Files:**
- Modify: `server/utils/refundHelpers.js` (append the function; extend `module.exports`)

- [ ] **Step 1: Append `applyRefundReconciliation` to `server/utils/refundHelpers.js`**

Add above `module.exports`:

```js
/**
 * Apply (idempotently) the financial reconciliation for one Stripe refund.
 * MUST run inside a caller-supplied transaction (dbClient = pool.connect()).
 *
 * Correlation order, keyed by Stripe refund id (spec §Webhook Backstop):
 *   1. a `succeeded` row already has this stripe_refund_id → no-op.
 *   2. else a `pending` row for this intent w/ matching amount & no
 *      refund id → adopt it (self-heal: Stripe refunded, sync write failed).
 *   3. else create a fresh `succeeded` row (out-of-band dashboard refund).
 *
 * Then, exactly once: proposals total/paid −= dollars; reverse linked
 * invoice(s); activity-log line.
 *
 * @param {object} a
 * @param {number} a.proposalId
 * @param {string} a.stripeRefundId
 * @param {string} a.paymentIntentId
 * @param {number|null} a.paymentId          proposal_payments.id (may be null for dashboard refunds)
 * @param {number} a.amountCents
 * @param {string} a.reason
 * @param {number|null} a.issuedBy           users.id, or null (dashboard)
 * @param {object} dbClient                  transaction client
 * @returns {Promise<{applied:boolean}>}     applied=false → was already done
 */
async function applyRefundReconciliation(
  { proposalId, stripeRefundId, paymentIntentId, paymentId, amountCents, reason, issuedBy },
  dbClient
) {
  // Serialize ALL refund reconciliation for this proposal on the proposals
  // row BEFORE the already-applied check. Closes the TOCTOU where two
  // concurrent submits both pass an unlocked check and double-decrement:
  // any waiter blocks here until the winner COMMITs, then sees the winner's
  // succeeded row and cleanly no-ops.
  const propRes = await dbClient.query(
    'SELECT total_price, amount_paid FROM proposals WHERE id = $1 FOR UPDATE',
    [proposalId]
  );
  if (!propRes.rows[0]) throw new Error(`applyRefundReconciliation: proposal ${proposalId} not found`);

  // Already applied? Safe now — we hold the row lock.
  const done = await dbClient.query(
    `SELECT id FROM proposal_refunds WHERE stripe_refund_id = $1 AND status = 'succeeded' LIMIT 1`,
    [stripeRefundId]
  );
  if (done.rows[0]) return { applied: false };

  const totalBefore = Number(propRes.rows[0].total_price);
  const dollars = amountCents / 100;
  const totalAfter = totalBefore - dollars;

  // 2/3. adopt a pending row, else create a succeeded row.
  let refundRowId;
  const pending = await dbClient.query(
    `SELECT id FROM proposal_refunds
      WHERE stripe_payment_intent_id = $1 AND amount = $2
        AND status = 'pending' AND stripe_refund_id IS NULL
      ORDER BY created_at ASC LIMIT 1`,
    [paymentIntentId, amountCents]
  );
  if (pending.rows[0]) {
    refundRowId = pending.rows[0].id;
    await dbClient.query(
      `UPDATE proposal_refunds
          SET status = 'succeeded', stripe_refund_id = $1,
              total_price_before = $2, total_price_after = $3
        WHERE id = $4`,
      [stripeRefundId, totalBefore, totalAfter, refundRowId]
    );
  } else {
    const ins = await dbClient.query(
      `INSERT INTO proposal_refunds
         (proposal_id, payment_id, stripe_payment_intent_id, stripe_refund_id,
          amount, reason, total_price_before, total_price_after, issued_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'succeeded')
       RETURNING id`,
      [proposalId, paymentId, paymentIntentId, stripeRefundId, amountCents,
       reason, totalBefore, totalAfter, issuedBy]
    );
    refundRowId = ins.rows[0].id;
  }

  // proposals: Approach A — total & paid drop together (exact NUMERIC).
  await dbClient.query(
    `UPDATE proposals
        SET total_price = GREATEST(total_price - ($1 / 100.0), 0),
            amount_paid = GREATEST(amount_paid - ($1 / 100.0), 0)
      WHERE id = $2`,
    [amountCents, proposalId]
  );

  // Reverse linked invoice(s). A payment may be split across >1 invoice
  // (drink_plan_with_balance); subtract greedily, clamped per link, until
  // the refunded cents are exhausted. Mirrors linkPaymentToInvoice in
  // reverse, incl. the amount_paid>=amount_due → 'paid' recompute.
  if (paymentId != null) {
    const links = await dbClient.query(
      `SELECT ip.id AS link_id, ip.invoice_id, ip.amount AS link_amount
         FROM invoice_payments ip
        WHERE ip.payment_id = $1
        ORDER BY ip.id ASC`,
      [paymentId]
    );
    let remaining = amountCents;
    for (const link of links.rows) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, link.link_amount);
      remaining -= take;
      // Negative linkage row keeps Σ invoice_payments.amount == invoices.amount_paid.
      await dbClient.query(
        'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1,$2,$3)',
        [link.invoice_id, paymentId, -take]
      );
      // Approach A: drop amount_due AND amount_paid by `take` → a paid
      // invoice stays paid at the corrected figure (no phantom unpaid).
      const upd = await dbClient.query(
        `UPDATE invoices
            SET amount_paid = GREATEST(amount_paid - $1, 0),
                amount_due  = GREATEST(amount_due  - $1, 0)
          WHERE id = $2
          RETURNING amount_due, amount_paid`,
        [take, link.invoice_id]
      );
      if (upd.rows[0]) {
        const inv = upd.rows[0];
        const newStatus = inv.amount_paid >= inv.amount_due ? 'paid' : 'partially_paid';
        await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [newStatus, link.invoice_id]);
      }
    }
  }

  // Activity log — chronological story. Use the dedicated actor_id column
  // (not just JSON) so the admin is queryable; 'admin' actor for an
  // operator-issued refund, 'system' for an out-of-band dashboard refund.
  await dbClient.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
     VALUES ($1, 'refund_issued', $2, $3, $4)`,
    [
      proposalId,
      issuedBy ? 'admin' : 'system',
      issuedBy,
      JSON.stringify({
        amount: amountCents, reason, stripe_refund_id: stripeRefundId,
        total_price_before: totalBefore, total_price_after: totalAfter,
        issued_by: issuedBy, refund_row_id: refundRowId,
      }),
    ]
  );

  return { applied: true };
}
```

Change the export line to:

```js
module.exports = { planRefund, fmtUSD, applyRefundReconciliation };
```

- [ ] **Step 2: Re-run the pure tests (regression — exports/syntax intact)**

Run: `node --test server/utils/refundHelpers.test.js`
Expected: PASS (all Task 2 tests still green; appending the DB function must not break `planRefund`).

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors for `server/utils/refundHelpers.js`.

- [ ] **Step 4: Read-through against spec invariants** (no code change — verification step)

Confirm by reading the function: (a) the `SELECT … FOR UPDATE` on the proposals row happens **before** the already-applied check (concurrency serialization point — no double-decrement under concurrent submits); (b) early-return `{applied:false}` no-op when a `succeeded` row exists for the refund id; (c) `proposals` uses exact NUMERIC `($1 / 100.0)`, never JS float; (d) both `total_price` and `amount_paid` drop by the same dollars (Approach A invariant: balance-due unchanged); (e) invoice loop inserts a **negative** `invoice_payments` row and drops both `amount_due` and `amount_paid` so a paid invoice stays paid (and a fully-paid invoice stays `locked` — settled at the corrected figure; the refund deliberately does **not** call `refreshUnlockedInvoices`/`createAdditionalInvoiceIfNeeded`); (f) `paymentId == null` path skips invoice reversal cleanly.

- [ ] **Step 5: Commit**

```bash
git add server/utils/refundHelpers.js
git commit -m "feat(refunds): idempotent applyRefundReconciliation — totals, invoice reversal, activity log"
```

---

### Task 4: Admin route + refund-history endpoint

**Files:**
- Modify: `server/routes/stripe.js` — add `POST /refund/:id` and `GET /refunds/:id`, both `auth, requireAdminOrManager`. Place directly after the `charge-balance/:id` handler (ends ~line 538).

- [ ] **Step 1a: Add `adminOnly` to the auth import**

In `server/routes/stripe.js` line ~6, change:

```js
const { auth, requireAdminOrManager } = require('../middleware/auth');
```

to:

```js
const { auth, adminOnly, requireAdminOrManager } = require('../middleware/auth');
```

(`adminOnly` is exported from `server/middleware/auth.js` and gates `req.user.role === 'admin'` only.)

- [ ] **Step 1b: Add the two endpoints**

After the `charge-balance/:id` route in `server/routes/stripe.js`, insert:

```js
// ─── Admin: list refunds for a proposal ──────────────────────────

/** GET /api/stripe/refunds/:id — admin/manager (read-only refund history) */
router.get('/refunds/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Exclude 'pending': a transient/stranded pre-Stripe row must never render
  // in history as if a refund actually happened. Only resolved rows show.
  const { rows } = await pool.query(
    `SELECT id, amount, reason, total_price_before, total_price_after,
            stripe_refund_id, status, created_at
       FROM proposal_refunds
      WHERE proposal_id = $1 AND status <> 'pending'
      ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

// ─── Admin: issue a partial refund ───────────────────────────────

/**
 * POST /api/stripe/refund/:id — admin ONLY (money OUT, stricter than the
 * money-IN charge-balance which allows managers). Body: { amount, reason,
 * idempotency_key }. All refund rejections throw AppError so the precise
 * planner message reaches the admin toast (ValidationError would bury it
 * in fieldErrors behind the generic "Please fix the errors below").
 */
router.post('/refund/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');

  const proposalId = req.params.id;
  const { amount, reason, idempotency_key } = req.body;
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw new AppError('A refund reason is required.', 400, 'REASON_REQUIRED');
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    throw new AppError('Missing idempotency key — reopen the refund form and retry.', 400, 'MISSING_IDEMPOTENCY_KEY');
  }

  const propRes = await pool.query(
    'SELECT id, total_price, amount_paid FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!propRes.rows[0]) throw new NotFoundError('Proposal not found');
  const proposal = propRes.rows[0];

  // Succeeded, intent-bearing payments with cents still refundable
  // (amount − Σ succeeded refunds against that payment).
  // Base-contract charges only. Approach A also lowers total_price, which is
  // only correct for money that IS in total_price (deposit/balance/full —
  // where a no-show-bartender refund lives). drink_plan_* / invoice charges
  // are extra scope NOT in total_price; refunding them must NOT shrink the
  // base total, so they are deliberately excluded from auto-target (see
  // spec Non-Goals). Stripe's own per-charge refund cap is the final
  // over-refund backstop on top of the remainingCents math below.
  const payRes = await pool.query(
    `SELECT pp.id,
            pp.stripe_payment_intent_id,
            pp.amount
              - COALESCE((SELECT SUM(pr.amount) FROM proposal_refunds pr
                           WHERE pr.payment_id = pp.id AND pr.status = 'succeeded'), 0)
              AS "remainingCents"
       FROM proposal_payments pp
      WHERE pp.proposal_id = $1
        AND pp.status = 'succeeded'
        AND pp.stripe_payment_intent_id IS NOT NULL
        AND pp.payment_type IN ('deposit', 'balance', 'full')`,
    [proposalId]
  );

  const { planRefund, applyRefundReconciliation } = require('../utils/refundHelpers');
  const plan = planRefund({
    paymentsWithRemaining: payRes.rows.map(r => ({
      id: r.id,
      stripe_payment_intent_id: r.stripe_payment_intent_id,
      remainingCents: Number(r.remainingCents),
    })),
    requestedDollars: amount,
    amountPaidDollars: Number(proposal.amount_paid),
    totalPriceDollars: Number(proposal.total_price),
  });
  if (!plan.ok) {
    // AppError → `.message` surfaces as response `error` → admin toast.
    // (ValidationError would hide plan.message in fieldErrors behind the
    // generic banner, defeating the precise no-spanning guidance.)
    throw new AppError(plan.message, 400, plan.code);
  }

  // Pending row BEFORE Stripe, so a Stripe success we then fail to record
  // is still discoverable (and adoptable by the webhook backstop).
  const pendRes = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
     RETURNING id`,
    [proposalId, plan.targetPaymentId, plan.targetIntentId, plan.amountCents,
     cleanReason, Number(proposal.total_price), plan.totalPriceAfterDollars, req.user.id]
  );
  const pendingRowId = pendRes.rows[0].id;

  let refund;
  try {
    refund = await stripe.refunds.create(
      { payment_intent: plan.targetIntentId, amount: plan.amountCents },
      { idempotencyKey: `refund-${proposalId}-${idempotency_key}` }
    );
  } catch (err) {
    await pool.query(`UPDATE proposal_refunds SET status = 'failed' WHERE id = $1`, [pendingRowId]);
    console.error('Stripe refund error:', err);
    if (err.type === 'StripeInvalidRequestError') {
      throw new PaymentError(`Refund rejected: ${err.message}`, 'REFUND_REJECTED');
    }
    throw new ExternalServiceError('Stripe', err, 'Refund temporarily unavailable. Please try again.');
  }

  const dbClient = await pool.connect();
  let recon;
  try {
    await dbClient.query('BEGIN');
    recon = await applyRefundReconciliation(
      {
        proposalId: Number(proposalId),
        stripeRefundId: refund.id,
        paymentIntentId: plan.targetIntentId,
        paymentId: plan.targetPaymentId,
        amountCents: plan.amountCents,
        reason: cleanReason,
        issuedBy: req.user.id,
      },
      dbClient
    );
    await dbClient.query('COMMIT');
  } catch (dbErr) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(dbErr, { tags: { route: '/stripe/refund', proposalId } });
    }
    // Money already left via Stripe; the charge.refunded webhook backstop
    // adopts our pending row and reconciles. Surface 502 (not a silent 200),
    // correct ExternalServiceError signature: (service, originalError, userMsg).
    console.error('Refund reconciliation failed (webhook will backstop):', dbErr);
    throw new ExternalServiceError(
      'Database',
      dbErr,
      'Refund was processed by Stripe; the records will finish syncing momentarily.'
    );
  } finally {
    dbClient.release();
  }

  // applied===false → reconciliation no-op'd because this refund id was
  // already applied (idempotent winner, e.g. a double-submit whose Stripe
  // idempotency key returned the same refund). The pending row we inserted
  // above is now redundant — delete it so it can't strand as a ghost
  // 'pending' history entry. Money/books are already correct.
  if (recon && recon.applied === false) {
    await pool.query(
      `DELETE FROM proposal_refunds
        WHERE id = $1 AND status = 'pending' AND stripe_refund_id IS NULL`,
      [pendingRowId]
    );
  }

  const after = await pool.query(
    'SELECT total_price, amount_paid FROM proposals WHERE id = $1',
    [proposalId]
  );
  res.json({
    refunded: plan.amountCents,
    total_price: Number(after.rows[0].total_price),
    amount_paid: Number(after.rows[0].amount_paid),
  });
}));
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors. (`AppError`, `ExternalServiceError`, `PaymentError`, `NotFoundError`, `Sentry`, `getStripe`, `auth`, `requireAdminOrManager`, `asyncHandler`, `pool` are already imported at the top of `server/routes/stripe.js` — confirm by reading lines 1–40. The ONLY import change is adding `adminOnly` in Step 1a. `ValidationError` is intentionally **not** used by these handlers — all rejections are `AppError` so the message reaches the toast.)

- [ ] **Step 3: Read-through verification**

Confirm: pending row is inserted **before** `stripe.refunds.create`; the idempotency key passed to Stripe is `refund-${proposalId}-${idempotency_key}`; Stripe failure marks the row `failed` and touches no proposal/invoice money; reconciliation runs in its own `BEGIN/COMMIT/ROLLBACK`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(refunds): POST /stripe/refund/:id + GET /stripe/refunds/:id (admin)"
```

---

### Task 5: `charge.refunded` webhook backstop + integration smoke

**Files:**
- Modify: `server/routes/stripe.js` — add a `charge.refunded` handler inside the existing webhook, after the `checkout.session.completed` block (before `res.json({ received: true })`, ~line 1172).

- [ ] **Step 1: Add the webhook handler**

In the `/webhook` handler, immediately before the final `res.json({ received: true });`, insert:

```js
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
    // charge.refunded delivers the whole charge; refunds.data is newest-first,
    // so data[0] is the refund this event is about. A mis-pick in a rare
    // multi-refund race is harmless: the unique stripe_refund_id index makes
    // applyRefundReconciliation a no-op for an id already applied by the
    // synchronous route.
    const refundObj = charge.refunds?.data?.[0];
    const proposalId = charge.metadata?.proposal_id
      || (paymentIntentId
            ? (await pool.query(
                'SELECT proposal_id FROM proposal_payments WHERE stripe_payment_intent_id = $1 LIMIT 1',
                [paymentIntentId]
              )).rows[0]?.proposal_id
            : null);

    if (proposalId && refundObj && paymentIntentId) {
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');
        const payRow = await dbClient.query(
          `SELECT id FROM proposal_payments
            WHERE stripe_payment_intent_id = $1 AND status = 'succeeded' LIMIT 1`,
          [paymentIntentId]
        );
        const { applyRefundReconciliation } = require('../utils/refundHelpers');
        await applyRefundReconciliation(
          {
            proposalId: Number(proposalId),
            stripeRefundId: refundObj.id,
            paymentIntentId,
            paymentId: payRow.rows[0]?.id ?? null,
            amountCents: refundObj.amount,
            reason: 'Refunded via Stripe dashboard',
            issuedBy: null,
          },
          dbClient
        );
        await dbClient.query('COMMIT');
        console.log(`charge.refunded reconciled for proposal ${proposalId} (refund ${refundObj.id})`);
      } catch (dbErr) {
        try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dbErr, { tags: { webhook: 'stripe', event: 'charge.refunded' } });
        }
        console.error('Webhook charge.refunded error:', dbErr);
        throw dbErr; // 5xx → Stripe retries (same posture as payment_intent.succeeded)
      } finally {
        dbClient.release();
      }
    }
  }
```

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Re-run pure tests (regression)**

Run: `node --test server/utils/refundHelpers.test.js`
Expected: PASS (unchanged; sanity that nothing in the helper module regressed).

- [ ] **Step 4: Integration smoke (Stripe test mode) — manual, documented**

Pre: dev server running (Claude-managed bg process per project norms), `STRIPE_TEST_MODE_UNTIL` in the future, a Stripe **test-mode** proposal that is paid in full with a succeeded `proposal_payments` row.

1. In the admin payment panel, issue a refund of part of the balance with a reason.
2. Verify: Stripe test dashboard shows the partial refund against the right charge; `SELECT total_price, amount_paid FROM proposals WHERE id=…` both dropped by the refund and are still equal (balance $0, still "Paid in full"); one `proposal_refunds` row `status='succeeded'` with before/after; one `proposal_activity_log` `refund_issued`; if a linked invoice existed, its `amount_due`/`amount_paid` both dropped and status stayed `paid`.
3. Idempotency: re-trigger the same `charge.refunded` from the Stripe CLI/dashboard → **no** second `proposal_refunds` row, totals unchanged.
4. No-spanning: attempt a refund larger than the largest charge → rejected with the `$X.XX` message; no Stripe call; no DB rows.

Record pass/fail for each in the execution log. Any fail → stop, fix root cause, re-run.

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(refunds): idempotent charge.refunded webhook backstop"
```

---

### Task 6: Admin UI — issue refund + history

**Files:**
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js`

- [ ] **Step 1: Add refund state + load history**

Below the existing invoice state (`const [creatingInvoice, setCreatingInvoice] = useState(false);`, ~line 53) add:

```js
  // Refund
  const [showRefund, setShowRefund] = useState(false);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundKey, setRefundKey] = useState('');
  const [issuingRefund, setIssuingRefund] = useState(false);
  const [refunds, setRefunds] = useState([]);

  useEffect(() => {
    let alive = true;
    api.get(`/stripe/refunds/${proposal.id}`)
      .then(res => { if (alive) setRefunds(res.data || []); })
      .catch(() => { /* non-fatal: history just won't render */ });
    return () => { alive = false; };
  }, [proposal.id, proposal.amount_paid, proposal.total_price]);

  const openRefund = () => {
    setRefundKey(
      (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : String(Date.now()) + Math.random().toString(16).slice(2)
    );
    setShowRefund(true);
  };

  const issueRefund = async () => {
    if (!refundAmount || Number(refundAmount) <= 0) { toast.error('Enter a valid amount.'); return; }
    if (!refundReason.trim()) { toast.error('A reason is required.'); return; }
    setIssuingRefund(true);
    try {
      const res = await api.post(`/stripe/refund/${proposal.id}`, {
        amount: Number(refundAmount),
        reason: refundReason.trim(),
        idempotency_key: refundKey,
      });
      toast.success(`Refunded ${fmt$2dp(res.data.refunded / 100)}.`);
      setShowRefund(false);
      setRefundAmount('');
      setRefundReason('');
      onUpdate?.();
    } catch (err) {
      toast.error(err.message || 'Refund failed.');
    } finally {
      setIssuingRefund(false);
    }
  };
```

First update the import at the top of the file:

```js
import React, { useState, useEffect } from 'react';
```

(File currently imports `import React, { useState } from 'react';` — add `useEffect`.)

- [ ] **Step 2: Render the refund section + history**

Immediately before the final closing `</div>\n      </div>\n    </div>` of the card-body (after the "Record outside payment" block, ~line 321) add:

```jsx
        {/* Issue refund */}
        {amountPaid > 0 && (
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-1)' }}>
            {!showRefund ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={openRefund}>
                <Icon name="dollar" size={11} />Issue refund
              </button>
            ) : (
              <div>
                <div className="meta-k" style={{ marginBottom: 6 }}>Issue refund</div>
                <div className="vstack" style={{ gap: 6 }}>
                  <input type="number" className="input" placeholder="Amount ($)"
                    value={refundAmount} onChange={e => setRefundAmount(e.target.value)}
                    min="0.01" step="0.01" />
                  <textarea className="input" placeholder="Reason (e.g. second bartender no-show)"
                    value={refundReason} onChange={e => setRefundReason(e.target.value)}
                    rows={2} style={{ resize: 'vertical' }} />
                  <div className="hstack" style={{ gap: 6 }}>
                    <button type="button" className="btn btn-primary btn-sm"
                      onClick={issueRefund} disabled={issuingRefund}>
                      {issuingRefund ? 'Refunding…' : 'Confirm refund'}
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm"
                      onClick={() => setShowRefund(false)}>Cancel</button>
                  </div>
                </div>
              </div>
            )}

            {refunds.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="meta-k" style={{ marginBottom: 4 }}>Refund history</div>
                {refunds.map(r => (
                  <div key={r.id} className="tiny" style={{ marginBottom: 4 }}>
                    <span style={{ color: 'hsl(var(--danger-h) var(--danger-s) 50%)' }}>
                      −{fmt$2dp(r.amount / 100)}
                    </span>{' '}
                    · {r.reason} ·{' '}
                    {new Date(r.created_at).toLocaleDateString('en-US', { timeZone: 'UTC' })}
                    {r.status !== 'succeeded' && <> · <em>{r.status}</em></>}
                    <div className="muted">
                      total {fmt$2dp(Number(r.total_price_before))} → {fmt$2dp(Number(r.total_price_after))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
```

- [ ] **Step 3: Verify client build (the only client gate — Vercel CI mirror)**

Run (via the Bash tool — POSIX): `cd client && CI=true npx react-scripts build`
Expected: build succeeds, **no ESLint warnings-as-errors** (unused vars, missing hook deps — note the `useEffect` dep array). Per project norm (memory: client lint only enforced by Vercel CI / `.husky/pre-push`), this build is the gate — it must be clean.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/ProposalDetailPaymentPanel.js
git commit -m "feat(refunds): admin issue-refund form + refund history in payment panel"
```

---

### Task 7: Documentation (mandatory per CLAUDE.md)

**Files:**
- Modify: `ARCHITECTURE.md` (Database Schema section; API route table; Stripe integration section)
- Modify: `README.md` (folder-structure tree; Key Features)

- [ ] **Step 1: ARCHITECTURE.md**

- In the Database Schema section, add a `proposal_refunds` entry next to `proposal_payments`: columns + the Approach-A note (refund corrects `total_price`/`amount_paid` together; idempotency anchor `stripe_refund_id`).
- In the API route table (Stripe rows), add: `POST /api/stripe/refund/:id` (admin — issue partial refund) and `GET /api/stripe/refunds/:id` (admin — refund history).
- In the Stripe integration section, add one paragraph: admin partial refunds, synchronous reconciliation via `refundHelpers.applyRefundReconciliation`, idempotent `charge.refunded` webhook backstop (also catches dashboard refunds).

- [ ] **Step 2: README.md**

- In the folder-structure tree, add `server/utils/refundHelpers.js` — "partial-refund planner + idempotent reconciliation" beside `invoiceHelpers.js`.
- In Key Features, add a line: "Admin partial refunds — Stripe refund + total correction + audit ledger, webhook-backstopped."

- [ ] **Step 3: Verify**

Run: `grep -n "proposal_refunds\|/stripe/refund\|refundHelpers" ARCHITECTURE.md README.md`
Expected: schema entry, both route rows, integration paragraph (ARCHITECTURE.md); folder-tree line + Key Features line (README.md).

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md README.md
git commit -m "docs(refunds): proposal_refunds schema, routes, refundHelpers in ARCHITECTURE + README"
```

---

## Self-Review (completed)

**1. Spec coverage:**
- Approach A (total correction) → Task 3 (`proposals` GREATEST(... − $/100), both columns) + Task 2 invariant test.
- `proposal_refunds` audit ledger → Task 1.
- Units seam → Task 2 (pure, cents) + Task 3 (exact NUMERIC SQL); explicit cents-seam test.
- Auto-target, no-spanning, validation order → Task 2 (full TDD).
- Idempotency (modal-open key, unique `stripe_refund_id`, correlation order) → Task 1 index, Task 4 pending-row + idempotencyKey, Task 3 correlation, Task 5 backstop.
- Synchronous route → Task 4. Webhook backstop incl. out-of-band dashboard refunds → Task 5.
- Linked-invoice reversal (drop due+paid, recompute status, negative linkage row, multi-link greedy) → Task 3.
- Activity log `refund_issued` → Task 3. Admin UI form + history → Task 6. Docs → Task 7.
- Non-goals respected: no staffing/shift code anywhere; Stripe-charges-only (planner filters `stripe_payment_intent_id IS NOT NULL`); no client email; no new proposal status enum.

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; commands have expected output; the one manual task (Task 5 Step 4) enumerates exact verifiable checks.

**3. Type/name consistency:** `planRefund` / `applyRefundReconciliation` / `fmtUSD` signatures and `{ok,code,amountCents,targetPaymentId,targetIntentId,totalPriceAfterDollars,maxRefundableCents}` shape are identical across Tasks 2→4. Route passes exactly `applyRefundReconciliation`'s documented args in Tasks 4 & 5. `proposal_refunds` columns identical in Tasks 1, 3, 4. API paths (`/stripe/refund/:id`, `/stripe/refunds/:id`) identical in Tasks 4 & 6. `fmt$2dp` / `Icon` / `useToast` / `api` already imported in the panel (verified in Task 6 prose).

## Security & Correctness Review — hardening applied (2026-05-17)

Verified against the actual codebase, then fixed inline:

1. **`proposal_activity_log` won't break the money path.** Confirmed `action`/`actor_type` are free-form VARCHAR (no CHECK) — `'refund_issued'`/`'admin'` insert cleanly, so reconciliation can't roll back *after* Stripe moved money on a constraint violation. Also now writes the dedicated `actor_id` column (not just JSON) for queryable attribution.
2. **Error messages reach the admin (confirmed bug, fixed).** Client toast shows `data.error` = the AppError `.message`. `ValidationError(msg)` puts `msg` in `fieldErrors` and `.message` defaults to *"Please fix the errors below"* — the precise *"Largest refundable payment is $X"* would be invisible. All refund rejections now throw `AppError(plan.message, 400, plan.code)`.
3. **`ExternalServiceError` signature (confirmed bug, fixed).** Constructor is `(service, originalError, message)`; the plan's 2-arg call mis-slotted the user message. Corrected to 3-arg.
4. **Concurrency double-decrement (closed).** `SELECT proposals … FOR UPDATE` now precedes the already-applied check, serializing concurrent submits on the proposal row. The partial unique index on `stripe_refund_id` is the second backstop. No path double-decrements `total_price`/`amount_paid`.
5. **Ghost pending rows (closed).** On idempotent no-op (`applied:false`) the route deletes its redundant pending row; `GET /refunds/:id` excludes `status='pending'` so a transient/stranded row never renders as a real refund.
6. **Approach-A scope tightened (correctness).** Auto-target restricted to `payment_type IN ('deposit','balance','full')`. Refunding `drink_plan_*`/`invoice` charges (extra scope NOT in `total_price`) would wrongly shrink the base total — now excluded by construction (spec Non-Goal). The no-show-bartender money is in the balance/full charge, unaffected.
7. **Authz raised for money-out.** `POST /refund/:id` guarded by `adminOnly` (admin role only) — stricter than the money-in `charge-balance` (`requireAdminOrManager`). Read-only history stays admin/manager.
8. **Over-refund backstops documented.** Stripe's per-charge refund cap is the final guarantee on top of the `remainingCents` math; noted in code comments (concurrent in-flight pending refunds aren't subtracted from `remainingCents`, but Stripe rejects an over-refund and the row is marked `failed`).
9. **Invoice-refresh non-interference.** Refund adjusts only the directly-linked invoice and never calls `refreshUnlockedInvoices`/`createAdditionalInvoiceIfNeeded`; a fully-paid invoice stays `locked` (settled at the corrected figure). Verified against `invoiceHelpers.js`.
10. **No regression surface.** All edits are additive (new table, new file, new route/webhook blocks, new UI section). No existing query, webhook branch, or pure util is modified; existing `*.test.js` unaffected. Stripe never replays historical events, so the new `charge.refunded` branch can't fire on legacy data.

Two items are owner decisions, not defects — surfaced for veto (default applied = the safer choice): **(7)** admin-only refunds, and **(6)** excluding drink-plan/invoice charges from refundability.
