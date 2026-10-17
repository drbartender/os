'use strict';

// The contract-to-invoice step (spec 2026-10-16 section 7). Pure: no DB.
// A Deposit, Balance or Full Payment invoice whose stored lines describe the
// current contract exactly shows Contract Total, one step row, then the
// Invoice Total. Display only (D5): nothing here changes a stored amount.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contractStep } = require('./invoiceStep');

test('deposit, balance, full payment', () => {
  const base = { lineTotalsCents: [80000, 20000], contractTotalCents: 100000 };
  assert.deepEqual(contractStep({ ...base, label: 'Deposit', amountDueCents: 10000 }),
    { contract_total_cents: 100000, step_cents: 90000, step_label: 'Balance, billed later' });
  assert.deepEqual(contractStep({ ...base, label: 'Balance', amountDueCents: 90000 }),
    { contract_total_cents: 100000, step_cents: 10000, step_label: 'Less deposit and earlier payments' });
  assert.deepEqual(contractStep({ ...base, label: 'Full Payment', amountDueCents: 95000 }),
    { contract_total_cents: 100000, step_cents: 5000, step_label: 'Less payments already received' });
});

test('no step when the lines are not the current contract, or nothing to explain', () => {
  const base = { lineTotalsCents: [80000, 20000], amountDueCents: 10000 };
  assert.equal(contractStep({ ...base, label: 'Deposit', contractTotalCents: 90000 }), null); // refunded / pre-fold / edited
  assert.equal(contractStep({ ...base, label: 'Balance', contractTotalCents: 100000, amountDueCents: 100000 }), null);
  assert.equal(contractStep({ ...base, label: 'Additional Services', contractTotalCents: 100000 }), null);
  assert.equal(contractStep({ ...base, label: 'Deposit', contractTotalCents: null }), null);
  assert.equal(contractStep({ lineTotalsCents: [], label: 'Deposit', amountDueCents: 0, contractTotalCents: 0 }), null);
});

test('a line with a negative total (a visible discount) counts toward the sum', () => {
  // Lines 120000 + (-20000) = 100000, the contract.
  assert.deepEqual(
    contractStep({ label: 'Deposit', lineTotalsCents: [120000, -20000], amountDueCents: 10000, contractTotalCents: 100000 }),
    { contract_total_cents: 100000, step_cents: 90000, step_label: 'Balance, billed later' });
});

test('an invoice that lists a refund shows no step, whatever its label', () => {
  const base = { lineTotalsCents: [80000, 20000], contractTotalCents: 100000 };
  for (const [label, amountDueCents] of [['Deposit', 10000], ['Balance', 90000], ['Full Payment', 95000]]) {
    assert.equal(contractStep({ ...base, label, amountDueCents, refunded: true }), null, `${label}, refunded`);
    assert.notEqual(contractStep({ ...base, label, amountDueCents, refunded: false }), null, `${label}, no refund`);
  }
});

test('a refund that makes the old line sum meet the new total by coincidence still shows no step', () => {
  // Prod invoice 211's shape, synthetic values: a Check Cherry Balance whose
  // lines carry a -$100.00 less-deposit line, locked and paid, then a $100.00
  // contract refund. total_price 300.00 -> 200.00 and amount_due 20000 ->
  // 10000; the lines never move. 30000 - 10000 = 20000 = the new contract, so
  // the line sum alone would subtract the deposit a second time.
  const shape = { label: 'Balance', lineTotalsCents: [30000, -10000], amountDueCents: 10000, contractTotalCents: 20000 };
  assert.notEqual(contractStep(shape), null, 'the line-sum gate alone lets this invoice through');
  assert.equal(contractStep({ ...shape, refunded: true }), null);
});

test('an amount due above the line sum explains nothing', () => {
  assert.equal(contractStep({ label: 'Deposit', lineTotalsCents: [5000], amountDueCents: 10000, contractTotalCents: 5000 }), null);
});

test('every other label is unchanged, matched exactly', () => {
  const base = { lineTotalsCents: [80000, 20000], amountDueCents: 10000, contractTotalCents: 100000 };
  for (const label of ['Service Extension', 'Drink Plan Extras', 'Enhancement Lab', 'Invoice', 'deposit', 'BALANCE', 'Full payment', '', null, undefined]) {
    assert.equal(contractStep({ ...base, label }), null, `label ${JSON.stringify(label)}`);
  }
});

test('a label that names an Object prototype member is not a contract label', () => {
  // Manual invoices take free-text labels; a plain-object lookup would hand
  // back a function for these.
  const base = { lineTotalsCents: [80000, 20000], amountDueCents: 10000, contractTotalCents: 100000 };
  for (const label of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(contractStep({ ...base, label }), null, `label ${label}`);
  }
});

test('missing or non-finite inputs never produce a step', () => {
  const base = { label: 'Deposit', lineTotalsCents: [80000, 20000], amountDueCents: 10000, contractTotalCents: 100000 };
  assert.equal(contractStep({ ...base, amountDueCents: null }), null);
  assert.equal(contractStep({ ...base, amountDueCents: undefined }), null);
  assert.equal(contractStep({ ...base, amountDueCents: NaN }), null);
  assert.equal(contractStep({ ...base, contractTotalCents: undefined }), null);
  assert.equal(contractStep({ ...base, contractTotalCents: NaN }), null);
  assert.equal(contractStep({ ...base, contractTotalCents: Infinity }), null);
  assert.equal(contractStep({ ...base, contractTotalCents: '100000' }), null);
  assert.equal(contractStep({ ...base, lineTotalsCents: null }), null);
  assert.equal(contractStep({ ...base, lineTotalsCents: [80000, NaN] }), null);
  assert.equal(contractStep({ ...base, lineTotalsCents: [80000, null, 20000] }), null);
  assert.equal(contractStep({ ...base, lineTotalsCents: ['80000', '20000'] }), null);
  // Dollars passed where cents belong: a fraction is never whole cents.
  assert.equal(contractStep({ ...base, contractTotalCents: 100000.5 }), null);
  assert.equal(contractStep({ ...base, amountDueCents: 10000.5 }), null);
  assert.equal(contractStep({ ...base, lineTotalsCents: [79999.5, 20000.5] }), null);
  assert.equal(contractStep({}), null);
  assert.equal(contractStep(), null);
});
