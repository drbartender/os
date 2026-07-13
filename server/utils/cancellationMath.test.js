require('dotenv').config();

// Pure unit tests for the cancellation refund math (P6.2). No DB, no Stripe.
// All inputs and outputs are CENTS. The route assembles the three cents values
// (amountPaid, retainer, gratuityPaid) from invoice/payment rows and calls this
// pure function; proposals-dollars never enter here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeCancellationRefund } = require('./cancellationMath');

test('client >14d, fully paid: excess less 5% fee, gratuity refunds in full', () => {
  const r = computeCancellationRefund({
    mode: 'client', daysOut: 30,
    amountPaidCents: 100000, retainerCents: 10000, gratuityPaidCents: 15000,
  });
  // excess = 100000 - 10000 - 15000 = 75000; fee = round(75000*0.05) = 3750
  assert.equal(r.excessCents, 71250);
  assert.equal(r.feeCents, 3750);
  assert.equal(r.gratuityCents, 15000);
  assert.equal(r.refundCents, 71250 + 15000); // 86250
});

test('client >14d, deposit-only with no gratuity: refund is $0 (retainer forfeited)', () => {
  const r = computeCancellationRefund({
    mode: 'client', daysOut: 30,
    amountPaidCents: 10000, retainerCents: 10000, gratuityPaidCents: 0,
  });
  assert.equal(r.refundCents, 0);
  assert.equal(r.gratuityCents, 0);
  assert.equal(r.excessCents, 0);
  assert.equal(r.feeCents, 0);
});

test('client >14d, gratuity paid but excess clamps at 0: gratuity still refunds in full', () => {
  // amountPaid barely over retainer; excess would go negative → clamps to 0,
  // but the gratuity portion always comes back.
  const r = computeCancellationRefund({
    mode: 'client', daysOut: 30,
    amountPaidCents: 12000, retainerCents: 10000, gratuityPaidCents: 5000,
  });
  // excess = max(0, 12000 - 10000 - 5000) = 0
  assert.equal(r.excessCents, 0);
  assert.equal(r.feeCents, 0);
  assert.equal(r.gratuityCents, 5000);
  assert.equal(r.refundCents, 5000);
});

test('client <=14d, fully paid: refund equals gratuity only (no excess, no fee)', () => {
  const r = computeCancellationRefund({
    mode: 'client', daysOut: 10,
    amountPaidCents: 100000, retainerCents: 10000, gratuityPaidCents: 15000,
  });
  assert.equal(r.refundCents, 15000);
  assert.equal(r.gratuityCents, 15000);
  assert.equal(r.excessCents, 0);
  assert.equal(r.feeCents, 0);
});

test('client <=14d, deposit-only, no gratuity: refund is $0', () => {
  const r = computeCancellationRefund({
    mode: 'client', daysOut: 5,
    amountPaidCents: 10000, retainerCents: 10000, gratuityPaidCents: 0,
  });
  assert.equal(r.refundCents, 0);
  assert.equal(r.gratuityCents, 0);
  assert.equal(r.excessCents, 0);
  assert.equal(r.feeCents, 0);
});

test('drb cancel: full refund of everything paid, including retainer; no fee', () => {
  const r = computeCancellationRefund({
    mode: 'drb', daysOut: 3,
    amountPaidCents: 100000, retainerCents: 10000, gratuityPaidCents: 15000,
  });
  assert.equal(r.refundCents, 100000);
  assert.equal(r.gratuityCents, 15000);
  assert.equal(r.excessCents, 85000); // amountPaid - gratuity
  assert.equal(r.feeCents, 0);
});

test('gratuity greater than amountPaid is clamped to amountPaid (drb)', () => {
  const r = computeCancellationRefund({
    mode: 'drb', daysOut: 30,
    amountPaidCents: 5000, retainerCents: 10000, gratuityPaidCents: 15000,
  });
  assert.equal(r.gratuityCents, 5000); // clamped to amountPaid
  assert.equal(r.refundCents, 5000);
  assert.equal(r.excessCents, 0);
  assert.equal(r.feeCents, 0);
});

test('gratuity greater than amountPaid is clamped (client >14d)', () => {
  const r = computeCancellationRefund({
    mode: 'client', daysOut: 30,
    amountPaidCents: 5000, retainerCents: 10000, gratuityPaidCents: 15000,
  });
  // gr = min(15000, 5000) = 5000; excess = max(0, 5000 - 10000 - 5000) = 0
  assert.equal(r.gratuityCents, 5000);
  assert.equal(r.excessCents, 0);
  assert.equal(r.feeCents, 0);
  assert.equal(r.refundCents, 5000);
});

test('boundary daysOut = 14 takes the <=14 branch (gratuity-only)', () => {
  const r = computeCancellationRefund({
    mode: 'client', daysOut: 14,
    amountPaidCents: 100000, retainerCents: 10000, gratuityPaidCents: 15000,
  });
  assert.equal(r.refundCents, 15000);
  assert.equal(r.excessCents, 0);
  assert.equal(r.feeCents, 0);
});

test('boundary daysOut = 15 takes the >14 branch (excess less fee + gratuity)', () => {
  const r = computeCancellationRefund({
    mode: 'client', daysOut: 15,
    amountPaidCents: 100000, retainerCents: 10000, gratuityPaidCents: 15000,
  });
  assert.equal(r.excessCents, 71250);
  assert.equal(r.feeCents, 3750);
  assert.equal(r.refundCents, 86250);
});

test('every component is >= 0 for a deposit-only payer at the >14d boundary', () => {
  const r = computeCancellationRefund({
    mode: 'client', daysOut: 15,
    amountPaidCents: 10000, retainerCents: 10000, gratuityPaidCents: 0,
  });
  assert.ok(r.refundCents >= 0);
  assert.ok(r.excessCents >= 0);
  assert.ok(r.feeCents >= 0);
  assert.ok(r.gratuityCents >= 0);
  assert.equal(r.refundCents, 0);
});
