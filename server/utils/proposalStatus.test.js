const { test } = require('node:test');
const assert = require('node:assert');
const { reconcileProposalPaymentStatus } = require('./proposalStatus');

test('demotes balance_paid -> deposit_paid when a price rise outruns paid', () => {
  const r = reconcileProposalPaymentStatus({ status: 'balance_paid', amountPaid: 1000, totalPrice: 1500 });
  assert.strictEqual(r.status, 'deposit_paid');
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.autopayDisarmed, true);
  assert.strictEqual(r.overpaid, false);
});

test('demotes to accepted when nothing is held', () => {
  const r = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 0, totalPrice: 1500 });
  assert.strictEqual(r.status, 'accepted');
  assert.strictEqual(r.autopayDisarmed, false);
});

test('still fully paid stays balance_paid (no promotion, no demotion)', () => {
  const r = reconcileProposalPaymentStatus({ status: 'balance_paid', amountPaid: 1500, totalPrice: 1500 });
  assert.strictEqual(r.status, 'balance_paid');
  assert.strictEqual(r.changed, false);
});

test('overpayment is flagged with cents, status untouched', () => {
  const r = reconcileProposalPaymentStatus({ status: 'balance_paid', amountPaid: 1500, totalPrice: 1200 });
  assert.strictEqual(r.overpaid, true);
  assert.strictEqual(r.overpaidCents, 30000);
  assert.strictEqual(r.status, 'balance_paid');
  assert.strictEqual(r.changed, false);
});

test('lifecycle states (confirmed/completed) are never demoted', () => {
  assert.strictEqual(reconcileProposalPaymentStatus({ status: 'completed', amountPaid: 0, totalPrice: 1500 }).status, 'completed');
  assert.strictEqual(reconcileProposalPaymentStatus({ status: 'confirmed', amountPaid: 0, totalPrice: 1500 }).status, 'confirmed');
});
