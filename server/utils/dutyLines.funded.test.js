// The payroll funded gate nets the off-contract money (round 3 L2,
// 2026-11-05).
//
// THE DEFECT. isFundedProposal compared raw amount_paid with total_price, so
// on the M2 shape (15000 total, the 10000 deposit and a paid 6000 syrup-only
// invoice) the gate opened with 5000 owed and the duty lines accrued. The
// duty context now carries the off-contract term, read in the proposal SELECT
// through the netting's SQL twin (the same partition contractPaidCents nets),
// and the gate compares the contract money.
//
// PURE: the gate is a pure predicate over the context row; the loader is
// driven with a scripted executor to pin the term's read.
//
//   node --test server/utils/dutyLines.funded.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isFundedProposal, loadProposalDutyContext } = require('./dutyLines');
const { NOT_OFF_CONTRACT_LABELS } = require('./invoiceExtras');

test('the M2 shape: 16000 paid of which 6000 is syrup money against 15000 is not funded', () => {
  assert.equal(isFundedProposal({ total_price: 150, amount_paid: 160, off_contract_paid_cents: 6000 }), false);
  assert.equal(isFundedProposal({ total_price: 150, amount_paid: 160, off_contract_paid_cents: '6000' }), false, 'a bigint column arrives as a string');
});

test('contract money at the total is funded, with or without off-contract money beside it', () => {
  assert.equal(isFundedProposal({ total_price: 150, amount_paid: 150, off_contract_paid_cents: 0 }), true);
  assert.equal(isFundedProposal({ total_price: 150, amount_paid: 210, off_contract_paid_cents: 6000 }), true);
  assert.equal(isFundedProposal({ total_price: 150, amount_paid: 150 }), true, 'a row without the column reads raw, as the existing cases do');
});

test('the duty context reads the term with the netting\'s SQL twin, bound to the same skip list', async () => {
  const calls = [];
  const executor = { async query(text, params) { calls.push({ text, params }); return { rows: [], rowCount: 0 }; } };
  assert.equal(await loadProposalDutyContext(executor, 4242), null);
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /AS off_contract_paid_cents/);
  assert.match(calls[0].text, /COALESCE\(oc\.folded_into_total, EXISTS/);
  assert.deepEqual(calls[0].params, [4242, NOT_OFF_CONTRACT_LABELS]);
});
