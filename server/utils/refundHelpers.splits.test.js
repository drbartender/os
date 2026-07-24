// planOverpaymentSplits — PURE unit tests (no DB, no Stripe). Lane
// cancel-line-server, plan Task 3. The cancel flow refunds exactly the
// overpayment a removal created; a refund can never span a Stripe charge
// (EXCEEDS_SINGLE_CHARGE), so the overpayment splits greedily across charges,
// largest remaining first. Cents beyond all charge headroom are external/CC
// money returned by hand (manualReturnCents), never via Stripe.
//   node --test server/utils/refundHelpers.splits.test.js
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
    overpaymentCents: 25000,
  });
  assert.equal(r.stripeRefundableCents, 10000);
  assert.equal(r.manualReturnCents, 15000);
  assert.equal(r.splits.length, 1);
});

test('zero overpayment yields no splits', () => {
  const r = planOverpaymentSplits({ paymentsWithRemaining: [], overpaymentCents: 0 });
  assert.deepEqual(r.splits, []);
  assert.equal(r.stripeRefundableCents, 0);
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

test('negative or junk overpayment is treated as zero', () => {
  const r = planOverpaymentSplits({
    paymentsWithRemaining: [{ id: 1, stripe_payment_intent_id: 'pi_a', remainingCents: 5000 }],
    overpaymentCents: -200,
  });
  assert.deepEqual(r.splits, []);
  assert.equal(r.manualReturnCents, 0);
});
