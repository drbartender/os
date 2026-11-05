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

test('still fully paid stays balance_paid (no-op at exact equality)', () => {
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

// 2026-09-16, prod proposal 823 (Sam White): paid in full at $425 on 9/09; a
// minute later the client added an Enhancement Lab syrup (total 455, demoted
// to deposit_paid), then removed it (total 425). Demote-only left the row at
// deposit_paid, so auto-complete never fired, payroll never accrued, and the
// bartender missed the pay run. A fully-paid row must read balance_paid
// whichever direction the last move came from.
test('promotes deposit_paid -> balance_paid once the total falls back to what was paid', () => {
  const demoted = reconcileProposalPaymentStatus({ status: 'balance_paid', amountPaid: 425, totalPrice: 455 });
  assert.strictEqual(demoted.status, 'deposit_paid');
  const restored = reconcileProposalPaymentStatus({ status: demoted.status, amountPaid: 425, totalPrice: 425 });
  assert.strictEqual(restored.status, 'balance_paid');
  assert.strictEqual(restored.changed, true);
  assert.strictEqual(restored.autopayDisarmed, false);
  assert.strictEqual(restored.overpaid, false);
});

test('promotes deposit_paid -> balance_paid when the corrected total drops below paid, and flags the overpayment', () => {
  const r = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 500, totalPrice: 420 });
  assert.strictEqual(r.status, 'balance_paid');
  assert.strictEqual(r.changed, true);
  assert.strictEqual(r.autopayDisarmed, false);
  assert.strictEqual(r.overpaid, true);
  assert.strictEqual(r.overpaidCents, 8000);
});

test('deposit_paid with a real balance outstanding stays deposit_paid', () => {
  const r = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 100, totalPrice: 425 });
  assert.strictEqual(r.status, 'deposit_paid');
  assert.strictEqual(r.changed, false);
});

test('pre-payment statuses never promote (only the paid ladder moves)', () => {
  for (const status of ['draft', 'sent', 'viewed', 'accepted']) {
    const r = reconcileProposalPaymentStatus({ status, amountPaid: 425, totalPrice: 425 });
    assert.strictEqual(r.status, status, status);
    assert.strictEqual(r.changed, false, status);
  }
});

test('a MISSING total never promotes (fail closed, matches the webhook reading paid >= NULL as not paid)', () => {
  for (const totalPrice of [null, undefined, NaN, '', 'abc']) {
    const r = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 425, totalPrice });
    assert.strictEqual(r.status, 'deposit_paid', String(totalPrice));
    assert.strictEqual(r.changed, false, String(totalPrice));
    const b = reconcileProposalPaymentStatus({ status: 'balance_paid', amountPaid: 425, totalPrice });
    assert.strictEqual(b.status, 'balance_paid', String(totalPrice));
    assert.strictEqual(b.changed, false, String(totalPrice));
    // An unreadable total is not an overpayment either (the raw comparison
    // would call the whole amount paid "over" a total of nothing).
    assert.strictEqual(r.overpaid, false, String(totalPrice));
    assert.strictEqual(r.overpaidCents, 0, String(totalPrice));
  }
});

test('an unparseable amount paid moves nothing and flags nothing (fail closed; NaN skips both demote arms)', () => {
  for (const amountPaid of ['1,000', 'abc', '$425', 'Infinity', Infinity]) {
    for (const status of ['deposit_paid', 'balance_paid']) {
      const r = reconcileProposalPaymentStatus({ status, amountPaid, totalPrice: 425 });
      assert.strictEqual(r.status, status, `${status} ${String(amountPaid)}`);
      assert.strictEqual(r.changed, false, `${status} ${String(amountPaid)}`);
      assert.strictEqual(r.overpaid, false, `${status} ${String(amountPaid)}`);
    }
  }
});

test('a genuine $0 total (fully comped event) promotes and flags the held deposit as overpaid, like the webhook', () => {
  for (const totalPrice of [0, '0', '0.00']) {
    const r = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 100, totalPrice });
    assert.strictEqual(r.status, 'balance_paid', String(totalPrice));
    assert.strictEqual(r.changed, true, String(totalPrice));
    assert.strictEqual(r.overpaid, true, String(totalPrice));
    assert.strictEqual(r.overpaidCents, 10000, String(totalPrice));
  }
});

test('pins the boundary on the deposit_paid side: one cent short stays, one cent inside promotes', () => {
  const short = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 424.99, totalPrice: 425 });
  assert.strictEqual(short.status, 'deposit_paid');
  assert.strictEqual(short.changed, false);
  const inside = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 425, totalPrice: 424.99 });
  assert.strictEqual(inside.status, 'balance_paid');
  assert.strictEqual(inside.changed, true);
  assert.strictEqual(inside.overpaidCents, 1);
});

// Round 2 M2 (2026-11-05): law 8's comparison is net of the money collected
// outside the contract (laws 5 and 7): a paid unfolded Drink Plan Extras
// invoice or a free-text manual invoice rolls into amount_paid and never into
// total_price, so the raw comparison promoted a row to balance_paid while the
// netted balance (quoted, invoiced, chased) still said money was owed, and
// autopay (deposit_paid claim) and charge-balance (INVALID_STATUS) then did not
// collect it while the completion sweep completed the event. The caller hands
// the ladder the netting term from sumOffContractPaidCents.
test('M2: 16000 paid of which 6000 is off-contract, against 15000, is NOT balance_paid', () => {
  const r = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 160, totalPrice: 150, offContractPaidCents: 6000 });
  assert.strictEqual(r.status, 'deposit_paid');
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.overpaid, false, 'no overpayment either: the 6000 is syrup money, not contract money');
  const demoted = reconcileProposalPaymentStatus({ status: 'balance_paid', amountPaid: 160, totalPrice: 150, offContractPaidCents: 6000 });
  assert.strictEqual(demoted.status, 'deposit_paid', 'a row the raw read promoted comes back down');
  assert.strictEqual(demoted.autopayDisarmed, true);
});

test('M2: 15000 of contract money against 15000 is balance_paid, with or without off-contract money beside it', () => {
  assert.strictEqual(reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 150, totalPrice: 150, offContractPaidCents: 0 }).status, 'balance_paid');
  assert.strictEqual(reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 210, totalPrice: 150, offContractPaidCents: 6000 }).status, 'balance_paid');
  assert.strictEqual(reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 150, totalPrice: 150 }).status, 'balance_paid', 'the term defaults to 0');
});

test('M2: an unreadable netting term fails closed: nothing moves, nothing is flagged', () => {
  const r = reconcileProposalPaymentStatus({ status: 'deposit_paid', amountPaid: 160, totalPrice: 150, offContractPaidCents: 'abc' });
  assert.strictEqual(r.changed, false);
  assert.strictEqual(r.overpaid, false);
});
