// The public payload's payment_policy on a contract at or below the deposit
// (audit PAY-09, 2026-11-05).
//
// THE DEFECT. Nothing compared the deposit with the contract total on either
// side: a 7500 booking offered the deposit tablet, create-intent charged the
// full 10000 deposit, the webhook credited it, derived balance_paid, and the
// netted 2500 overpayment needed an admin refund (plus Stripe's fees). The
// payload now flags full_payment_required when the total is at or below the
// row's deposit, with full_payment_reason saying why (the page already hides
// the deposit tablet on the flag; the reason picks the explainer copy), and
// create-intent refuses the deposit option for such a row.
//
// PURE: buildPublicProposalPayload takes its db by injection; a scripted one
// answers its reads by SQL shape.
//
//   node --test server/routes/proposals/publicToken.paymentPolicy.test.js
process.env.SEND_NOTIFICATIONS = 'false';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { buildPublicProposalPayload } = require('./publicToken');

const inSixtyDays = new Date(Date.now() + 60 * 86400000);
function scriptedDb(row) {
  return {
    async query(text) {
      if (/WHERE p\.token = \$1/.test(text) && /p\.status <> 'archived'/.test(text)) return { rows: [row], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}
const base = (over = {}) => ({
  id: 4242, token: crypto.randomUUID(), client_id: 9, status: 'sent', event_type: 'wedding',
  event_date: inSixtyDays, event_start_time: '18:00', event_duration_hours: 4, guest_count: 20,
  total_price: '75.00', amount_paid: '0', deposit_amount: '100.00', payment_type: 'deposit',
  pricing_snapshot: { total: 75 }, total_price_override: null, group_id: null, group_chosen_proposal_id: null,
  comparable_pkg_count: 0, client_signed_at: null, package_name: 'Class', client_source: 'direct',
  ...over,
});

test('a 75 total against a 100 deposit: full payment required, reason total_at_or_below_deposit', async () => {
  const row = base();
  const p = await buildPublicProposalPayload(row.token, scriptedDb(row));
  assert.ok(p, 'payload built');
  assert.equal(p.payment_policy.full_payment_required, true);
  assert.equal(p.payment_policy.full_payment_reason, 'total_at_or_below_deposit');
  assert.equal(p.payment_policy.last_minute_hold, false);
});

test('a total exactly at the deposit is paid in full by the deposit: flagged too', async () => {
  const row = base({ total_price: '100.00', pricing_snapshot: { total: 100 } });
  const p = await buildPublicProposalPayload(row.token, scriptedDb(row));
  assert.equal(p.payment_policy.full_payment_required, true);
});

test('a total above the deposit, 60 days out: the deposit stays on offer with no reason', async () => {
  const row = base({ total_price: '1000.00', pricing_snapshot: { total: 1000 } });
  const p = await buildPublicProposalPayload(row.token, scriptedDb(row));
  assert.equal(p.payment_policy.full_payment_required, false);
  assert.equal(p.payment_policy.full_payment_reason, null);
});

test('the row deposit is the yardstick: a 300 total against a 500 deposit is flagged, against 100 it is not', async () => {
  const big = base({ total_price: '300.00', pricing_snapshot: { total: 300 }, deposit_amount: '500.00' });
  assert.equal((await buildPublicProposalPayload(big.token, scriptedDb(big))).payment_policy.full_payment_required, true);
  const small = base({ total_price: '300.00', pricing_snapshot: { total: 300 }, deposit_amount: '100.00' });
  assert.equal((await buildPublicProposalPayload(small.token, scriptedDb(small))).payment_policy.full_payment_required, false);
});

test('the booking window still names its own reason', async () => {
  const row = base({ total_price: '1000.00', pricing_snapshot: { total: 1000 }, event_date: new Date(Date.now() + 5 * 86400000) });
  const p = await buildPublicProposalPayload(row.token, scriptedDb(row));
  assert.equal(p.payment_policy.full_payment_required, true);
  assert.equal(p.payment_policy.full_payment_reason, 'booking_window');
});

// Round 2 L2: the page read the deposit off the row and fell back to a literal
// 100 while the server fell back to STRIPE_DEPOSIT_AMOUNT, so a row whose
// deposit_amount is NULL or 0 under a non-default env value quoted one figure
// and charged another. The payload now carries the effective deposit the
// server will charge (depositCentsFor), and the PAY-09 flag compares against
// that same figure.
test('L2: the payload carries deposit_amount_effective, the figure create-intent charges, and the flag reads it', async () => {
  const { DEPOSIT_AMOUNT } = require('../../utils/stripeRouteHelpers');
  const stated = base({ total_price: '1000.00', pricing_snapshot: { total: 1000 }, deposit_amount: '500.00' });
  assert.equal((await buildPublicProposalPayload(stated.token, scriptedDb(stated))).deposit_amount_effective, 500);

  const bare = base({ total_price: '1000.00', pricing_snapshot: { total: 1000 }, deposit_amount: null });
  const p = await buildPublicProposalPayload(bare.token, scriptedDb(bare));
  assert.equal(p.deposit_amount_effective, DEPOSIT_AMOUNT / 100, 'a NULL row deposit reads the server default, never a client literal');

  const small = base({ total_price: '75.00', pricing_snapshot: { total: 75 }, deposit_amount: '0' });
  const q = await buildPublicProposalPayload(small.token, scriptedDb(small));
  assert.equal(q.deposit_amount_effective, DEPOSIT_AMOUNT / 100);
  assert.equal(q.payment_policy.full_payment_required, DEPOSIT_AMOUNT >= 7500, 'the flag and the figure agree on a 0 row deposit');
});
