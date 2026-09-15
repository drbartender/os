const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRefund, applyRefundReconciliation } = require('./refundHelpers');

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

test('amount exceeding base total_price is NOT rejected by the pure planner (extra-scope: authoritative total floor + label conditional live in applyRefundReconciliation, not here)', () => {
  const r = planRefund({
    paymentsWithRemaining: [pay(2, 'pi_inv', 120000)], // a $1200 invoice charge
    requestedDollars: 1200,
    amountPaidDollars: 2200,   // base $1000 + $1200 extras paid
    totalPriceDollars: 1000,   // base contract total
  });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 120000);
  assert.equal(r.targetPaymentId, 2);
  assert.equal(r.targetIntentId, 'pi_inv');
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

// ── applyRefundReconciliation: status ⟷ money invariant ──────────────
// A refund is the sole money-OUT path. Like every money-IN path it MUST keep
// proposals.status consistent with amount_paid/total_price, or status-driven
// surfaces (payment-panel "Paid in full" chip, record-payment gate) go stale.
// Mirror of record-payment's rule (crud.js): amount_paid>=total_price →
// balance_paid; <total → deposit_paid; here also amount_paid<=0 → accepted.
// On the balance_paid→deposit_paid demotion ONLY, autopay_enrolled is cleared
// so balanceScheduler.js can't off-session re-charge the refunded money.

// Minimal fake of a pg client driving applyRefundReconciliation's query
// sequence. Returns a superset row on the FOR UPDATE select + totals UPDATE so
// the same test holds before and after the RETURNING/status columns are added.
function makeFakeClient({ status, totalPrice, amountPaid, invoiceLabel, amountCents, alreadyApplied = false }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ s, params });

      if (/FROM proposals WHERE id = \$1 FOR UPDATE/.test(s)) {
        return { rows: [{ total_price: totalPrice, amount_paid: amountPaid, status }] };
      }
      if (/FROM proposal_refunds WHERE stripe_refund_id = \$1 AND status = 'succeeded'/.test(s)) {
        return { rows: alreadyApplied ? [{ id: 7 }] : [] };
      }
      if (/FROM proposal_refunds WHERE stripe_payment_intent_id = \$1 AND amount = \$2/.test(s)) {
        return { rows: [] }; // no pending → INSERT branch
      }
      if (/INSERT INTO proposal_refunds/.test(s)) return { rows: [{ id: 1 }] };
      if (/FROM invoice_payments ip JOIN invoices i/.test(s)) {
        return { rows: [{ invoice_id: 1, invoice_label: invoiceLabel, net_applied: amountCents }] };
      }
      if (/INSERT INTO invoice_payments/.test(s)) return { rows: [] };
      if (/UPDATE invoices SET amount_paid = GREATEST/.test(s)) return { rows: [{ amount_due: 0, amount_paid: 0 }] };
      if (/UPDATE invoices SET status = \$1/.test(s)) return { rows: [] };
      if (/UPDATE proposals SET total_price = GREATEST/.test(s)) {
        const [contractCents, amtCents] = params;
        const tp = Math.max(0, Number(totalPrice) - contractCents / 100);
        const ap = Math.max(0, Number(amountPaid) - amtCents / 100);
        return { rows: [{ total_price: tp, amount_paid: ap, status }] };
      }
      return { rows: [] }; // status-reconcile UPDATE, total_price_after, activity log
    },
  };
}

// Locate the status-reconciliation UPDATE (distinct from the totals UPDATE,
// which sets total_price/amount_paid and never `status =`).
function statusReconcile(calls) {
  const c = calls.find(({ s }) => /UPDATE proposals SET status =/.test(s));
  if (!c) return { found: false };
  return {
    found: true,
    value: c.params && c.params[0],
    disarmsAutopay: /autopay_enrolled = false/.test(c.s),
  };
}

const baseArgs = (over = {}) => ({
  proposalId: 42, stripeRefundId: 're_1', paymentIntentId: 'pi_1',
  paymentId: 9, amountCents: 20000, reason: 'second bartender no-show',
  issuedBy: 3, ...over,
});

test('extra-scope refund on a fully-paid proposal demotes balance_paid → deposit_paid AND disarms autopay', async () => {
  // $1000 proposal, paid in full, refund $200 of a non-contract invoice charge.
  const client = makeFakeClient({
    status: 'balance_paid', totalPrice: 1000, amountPaid: 1000,
    invoiceLabel: 'Additional Services', amountCents: 20000,
  });
  const r = await applyRefundReconciliation(baseArgs(), client);
  assert.equal(r.applied, true);
  const st = statusReconcile(client.calls);
  assert.equal(st.found, true, 'expected a status-reconciliation UPDATE');
  assert.equal(st.value, 'deposit_paid');
  assert.equal(st.disarmsAutopay, true, 'balance_paid→deposit_paid must clear autopay_enrolled');
});

test('contract refund that keeps amount_paid == total_price does NOT change status', async () => {
  // Contract-labeled refund drops total_price AND amount_paid equally → still
  // fully paid at the corrected total → balance_paid stays (correct).
  const client = makeFakeClient({
    status: 'balance_paid', totalPrice: 1000, amountPaid: 1000,
    invoiceLabel: 'Balance', amountCents: 20000,
  });
  await applyRefundReconciliation(baseArgs(), client);
  assert.equal(statusReconcile(client.calls).found, false);
});

test('refund draining amount_paid to zero demotes to accepted', async () => {
  const client = makeFakeClient({
    status: 'balance_paid', totalPrice: 1000, amountPaid: 1000,
    invoiceLabel: 'Full Payment', amountCents: 100000,
  });
  await applyRefundReconciliation(baseArgs({ amountCents: 100000 }), client);
  const st = statusReconcile(client.calls);
  assert.equal(st.found, true);
  assert.equal(st.value, 'accepted');
});

test('partial deposit refund while still deposit_paid leaves status and autopay untouched (legit future autopay preserved)', async () => {
  // $1000 proposal, $300 deposit paid, refund $100 of the deposit. Still
  // deposit_paid; the contract balance is legitimately still owed and autopay
  // must remain armed to collect it when due.
  const client = makeFakeClient({
    status: 'deposit_paid', totalPrice: 1000, amountPaid: 300,
    invoiceLabel: 'Deposit', amountCents: 10000,
  });
  await applyRefundReconciliation(baseArgs({ amountCents: 10000 }), client);
  assert.equal(statusReconcile(client.calls).found, false);
});

test('idempotent: an already-applied refund id is a no-op (no status write)', async () => {
  const client = makeFakeClient({
    status: 'balance_paid', totalPrice: 1000, amountPaid: 1000,
    invoiceLabel: 'Additional Services', amountCents: 20000, alreadyApplied: true,
  });
  const r = await applyRefundReconciliation(baseArgs(), client);
  assert.equal(r.applied, false);
  assert.equal(statusReconcile(client.calls).found, false);
});

test('reversal invoice_payments row is stamped with the refund row id (per-invoice attribution)', async () => {
  const client = makeFakeClient({
    status: 'balance_paid', totalPrice: 1000, amountPaid: 1000,
    invoiceLabel: 'Balance', amountCents: 20000,
  });
  await applyRefundReconciliation(baseArgs(), client);
  const rev = client.calls.find(({ s }) => /INSERT INTO invoice_payments/.test(s));
  assert.ok(rev, 'expected a reversal INSERT');
  assert.match(rev.s, /refund_id/, 'reversal INSERT carries the refund_id column');
  // invoice 1, payment 9, -take, refund row id 1 (the fake INSERT..RETURNING id)
  assert.deepEqual(rev.params, [1, 9, -20000, 1]);
});

// ── preferUncredited (spec 2026-09-15 D4) ──────────────────────────────────
// Overpaid dollars are the ones no invoice was ever credited, so an
// overpayment refund should land on the charge carrying that headroom. The
// preference is bounded: it only replaces the target with a charge that can
// COVER the refund, because the rejection message below names the target's
// headroom as "the largest refundable payment".
const payU = (id, intent, remainingCents, uncreditedCents) => ({
  id, stripe_payment_intent_id: intent, remainingCents, uncreditedCents,
});

test('preferUncredited targets the charge holding the uncredited money, not the largest', () => {
  const r = planRefund({
    paymentsWithRemaining: [
      payU(1, 'pi_dep', 120000, 0),      // biggest, fully credited to an invoice
      payU(2, 'pi_overflow', 90000, 40000), // smaller, carries the overpayment
    ],
    requestedDollars: 400,
    amountPaidDollars: 2100,
    totalPriceDollars: 1700,
    preferUncredited: true,
    scope: 'overpayment',
  });
  assert.equal(r.ok, true);
  assert.equal(r.targetPaymentId, 2);
  assert.equal(r.totalPriceAfterDollars, 1700, 'overpayment scope previews no change to the total');
});

test('preferUncredited falls back to largest-remaining when no uncredited charge can cover it, so the cap message stays true', () => {
  const r = planRefund({
    paymentsWithRemaining: [
      payU(1, 'pi_big', 120000, 0),
      payU(2, 'pi_small', 30000, 30000),
    ],
    requestedDollars: 1500, // 150000c: nothing covers it
    amountPaidDollars: 2100,
    totalPriceDollars: 600,
    preferUncredited: true,
    scope: 'overpayment',
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'EXCEEDS_SINGLE_CHARGE');
  assert.equal(r.maxRefundableCents, 120000, 'names the TRUE maximum, not the small uncredited charge');
});

test('preferUncredited falls back to the only charge that can cover the amount', () => {
  // pi_small carries MORE uncredited money, but cannot cover the refund; pi_big
  // can, and carries enough uncredited money to satisfy the overpayment rule.
  const r = planRefund({
    paymentsWithRemaining: [
      payU(1, 'pi_big', 120000, 60000),
      payU(2, 'pi_small', 30000, 30000),
    ],
    requestedDollars: 500, // 50000c: only pi_big covers it
    amountPaidDollars: 2100,
    totalPriceDollars: 1600,
    preferUncredited: true,
    scope: 'overpayment',
  });
  assert.equal(r.ok, true);
  assert.equal(r.targetPaymentId, 1, 'the only charge that can cover it wins');
});

test('an overpayment split across charges so no single one covers it is refused, not silently reversed', () => {
  // The no-spanning rule plus the uncredited rule together: $500 of excess sits
  // as $300 + $200 on two charges. Neither can carry the whole refund, and the
  // charge that CAN carry the amount has no uncredited money, so the walk would
  // have reversed credited invoice money while total_price stood.
  const r = planRefund({
    paymentsWithRemaining: [
      payU(1, 'pi_big', 120000, 0),
      payU(2, 'pi_small', 30000, 30000),
    ],
    requestedDollars: 500,
    amountPaidDollars: 2100,
    totalPriceDollars: 1600,
    preferUncredited: true,
    scope: 'overpayment',
    contractInvoiceSlackCents: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OVERPAYMENT_NOT_ON_A_CHARGE');
  assert.equal(r.maxOverpaymentRefundableCents, 30000, "names what CAN be returned");
});

test('without preferUncredited a tie on remaining is broken by id, not by row order', () => {
  const a = planRefund({
    paymentsWithRemaining: [payU(9, 'pi_b', 50000, 0), payU(4, 'pi_a', 50000, 0)],
    requestedDollars: 100, amountPaidDollars: 1000, totalPriceDollars: 1000,
  });
  const b = planRefund({
    paymentsWithRemaining: [payU(4, 'pi_a', 50000, 0), payU(9, 'pi_b', 50000, 0)],
    requestedDollars: 100, amountPaidDollars: 1000, totalPriceDollars: 1000,
  });
  assert.equal(a.targetPaymentId, 4);
  assert.equal(b.targetPaymentId, 4);
});

test('the headline overpayment is ALLOWED: paid in full by card, then repriced down', () => {
  // A contract paid in full credits the whole charge to a Balance invoice, which
  // then locks. Repricing down leaves that invoice demanding the old figure, so
  // there is no uncredited money anywhere — and reversing part of the credit is
  // exactly the right correction, because it brings the invoice back to the
  // contract rather than below it. Refusing this was a real defect: it left the
  // admin with a permanent overpayment or the uncapped contract path.
  const r = planRefund({
    paymentsWithRemaining: [payU(1, 'pi_full', 100000, 0)],
    requestedDollars: 200,
    amountPaidDollars: 1000,
    totalPriceDollars: 800,
    scope: 'overpayment',
    contractInvoiceSlackCents: 20000, // invoice still demands 1000 against an 800 contract
  });
  assert.equal(r.ok, true);
  assert.equal(r.targetPaymentId, 1);
  assert.equal(r.totalPriceAfterDollars, 800, 'and it still leaves the contract alone');
});

test('the same refund is refused once the invoices already match the contract', () => {
  // Money taken outside Stripe: every charge is fully credited AND the invoices
  // agree with the contract, so reversing a credit would push a settled invoice
  // BELOW the contract. Same headroom as the case above, opposite right answer.
  const r = planRefund({
    paymentsWithRemaining: [payU(1, 'pi_full', 100000, 0)],
    requestedDollars: 200,
    amountPaidDollars: 1000,
    totalPriceDollars: 800,
    scope: 'overpayment',
    contractInvoiceSlackCents: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OVERPAYMENT_NOT_ON_A_CHARGE');
  assert.match(r.message, /None of this overpayment can be returned through Stripe/);
});

test('an overpayment refund is refused when the target charge has no uncredited headroom', () => {
  // The external_paid shape: the charge exists and has refund headroom, but
  // every cent of it was credited to an invoice, so refunding it under
  // overpayment scope would reverse invoice money while total_price stands.
  const r = planRefund({
    paymentsWithRemaining: [payU(1, 'pi_bal', 50000, 0)],
    requestedDollars: 400,
    amountPaidDollars: 900,
    totalPriceDollars: 500,
    preferUncredited: true,
    scope: 'overpayment',
    contractInvoiceSlackCents: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OVERPAYMENT_NOT_ON_A_CHARGE');
  assert.equal(r.maxOverpaymentRefundableCents, 0);
  assert.match(r.message, /None of this overpayment can be returned through Stripe/);
});

test('an overpayment refund is capped at the uncredited headroom and names it', () => {
  const r = planRefund({
    paymentsWithRemaining: [payU(1, 'pi_bal', 90000, 10000)],
    requestedDollars: 400,
    amountPaidDollars: 900,
    totalPriceDollars: 500,
    preferUncredited: true,
    scope: 'overpayment',
    contractInvoiceSlackCents: 0,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'OVERPAYMENT_NOT_ON_A_CHARGE');
  assert.equal(r.maxOverpaymentRefundableCents, 10000);
  assert.match(r.message, /Only \$100\.00 of this overpayment/);
});

test('contract scope is never subject to the uncredited rule', () => {
  const r = planRefund({
    paymentsWithRemaining: [payU(1, 'pi_bal', 50000, 0)],
    requestedDollars: 400,
    amountPaidDollars: 900,
    totalPriceDollars: 500,
  });
  assert.equal(r.ok, true);
  assert.equal(r.targetPaymentId, 1);
});
