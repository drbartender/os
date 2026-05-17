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
