// The first-payment and balance CASE rails net the off-contract money
// (round 3 L2, 2026-11-05), on both webhook handlers.
//
// THE DEFECT. The deposit, full and balance rails of payment_intent.succeeded
// and the deposit and full rails of checkout.session.completed derived the
// status inline as COALESCE(amount_paid,0) + $2 >= total_price, on raw
// amount_paid, so off-contract money that landed before the first contract
// payment promoted it: an admin-minted Travel invoice (1000) paid from the
// proposal page before booking, then the signed 10000 deposit on an 11000
// contract read 11000 >= 11000 and wrote balance_paid with 1000 owed; and a
// partial balance on the M2 shape (15000 total, 10000 deposit, a paid 6000
// syrup-only invoice) promoted the same way. Each rail now subtracts the
// term read on the transaction client before its UPDATE (one extra bound
// parameter, the rail's shape otherwise untouched).
//
// PURE, the paymentIntentSucceeded.unsignedSettle seam: the handlers are
// called directly, pool.connect hands them a scripted client that answers by
// SQL shape and records every statement (the netting read returns the paid
// off-contract invoices), and the post-commit helpers are stubbed. The CASE
// itself is Postgres's: the pin is the term in the text and the cents bound
// to it; stripeWebhook.nettedRails.test.js commits the Travel shape for real.
//
//   node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.nettedRails.test.js
process.env.SEND_NOTIFICATIONS = 'false';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../db');

const invoiceHelpers = require('../../utils/invoiceHelpers');
invoiceHelpers.createBalanceInvoice = async () => null;
invoiceHelpers.linkOpenContractInvoice = async () => null;
invoiceHelpers.upgradeDepositInvoiceToFull = async () => null;
invoiceHelpers.createInvoiceOnSend = async () => null;
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/stripePaymentNotifications').sendPaymentNotifications = async () => {};
require('../../utils/adminNotifications').notifyAdminCategory = async () => {};
require('../../utils/depositPaidSchedulers').scheduleDepositPaidReminders = async () => {};
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};
require('../../utils/lastMinuteAlert').notifyLastMinuteBooking = () => {};

const handleIntent = require('./paymentIntentSucceeded');
const handleCheckout = require('./checkoutSessionCompleted');

const TRAVEL = [{ id: 70, label: 'Travel', amount_paid: 1000, folded_into_total: null }];
const SYRUPS = [{ id: 77, label: 'Drink Plan Extras', amount_paid: 6000, folded_into_total: false }];

function scriptedClient({ status, offContract }) {
  const queries = [];
  let paid = 0;
  return {
    queries,
    release() {},
    async query(text, params) {
      queries.push({ text, params });
      if (/INSERT INTO proposal_payments/.test(text)) return { rows: [{ id: 501 }], rowCount: 1 };
      if (/SELECT status, archive_reason FROM proposals/.test(text)) return { rows: [{ status, archive_reason: null }], rowCount: 1 };
      if (/SELECT id, group_id FROM proposals/.test(text)) return { rows: [{ id: 4242, group_id: null }], rowCount: 1 };
      if (/SELECT id, client_id FROM proposals/.test(text)) return { rows: [{ id: 4242, client_id: 9 }], rowCount: 1 };
      if (/SET amount_paid = COALESCE\(amount_paid, 0\) \+ \$2/.test(text)) {
        paid += Number(params[1]);
        return { rows: [{ client_signed_at: new Date(), amount_paid: String(paid), total_price: '110.00' }], rowCount: 1 };
      }
      if (/FROM invoices\s+WHERE proposal_id = \$1 AND status <> 'void' AND amount_paid > 0/.test(text)) {
        return { rows: offContract, rowCount: offContract.length };
      }
      if (/SELECT event_date, event_start_time FROM proposals/.test(text)) {
        return { rows: [{ event_date: new Date('2099-06-01T00:00:00Z'), event_start_time: '18:00' }], rowCount: 1 };
      }
      if (/SELECT id FROM proposal_payments WHERE stripe_payment_intent_id/.test(text)) return { rows: [{ id: 501 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
}

const realConnect = pool.connect;
let current = null;
beforeEach(() => { pool.connect = async () => current; });
process.on('exit', () => { pool.connect = realConnect; });

const creditUpdate = (client, type) => client.queries.find((q) => new RegExp(`payment_type = '${type}'`).test(q.text) && /SET amount_paid/.test(q.text));
const TERM = /COALESCE\(amount_paid, ?0\) \+ \$2 - \(\$3 \/ 100\.0\) >= total_price/;
function assertNetted(client, upd, cents, what) {
  assert.ok(upd, `${what}: the credit UPDATE ran`);
  assert.match(upd.text, TERM, `${what}: the CASE subtracts the bound term`);
  assert.equal(upd.params.length, 3, `${what}: one extra bound parameter`);
  assert.equal(upd.params[2], cents, `${what}: the off-contract cents`);
  const netIdx = client.queries.findIndex((q) => /amount_paid > 0/.test(q.text));
  assert.ok(netIdx >= 0 && netIdx < client.queries.indexOf(upd), `${what}: the term is read on the transaction client before the UPDATE`);
}

test('intent deposit rail, the Travel shape: the 1000 paid before booking is bound as the term', async () => {
  current = scriptedClient({ status: 'viewed', offContract: TRAVEL });
  await handleIntent({ data: { object: { id: 'pi_dep', amount: 10000, payment_method: 'pm_x',
    metadata: { proposal_id: '4242', payment_type: 'deposit' } } } });
  assertNetted(current, creditUpdate(current, 'deposit'), 1000, 'deposit');
});

test('intent full rail: the term is bound too', async () => {
  current = scriptedClient({ status: 'viewed', offContract: TRAVEL });
  await handleIntent({ data: { object: { id: 'pi_full', amount: 11000, payment_method: 'pm_x',
    metadata: { proposal_id: '4242', payment_type: 'full' } } } });
  assertNetted(current, creditUpdate(current, 'full'), 1000, 'full');
});

test('intent balance rail, the M2 shape: a partial balance on a row holding 6000 of syrup money binds 6000', async () => {
  current = scriptedClient({ status: 'deposit_paid', offContract: SYRUPS });
  await handleIntent({ data: { object: { id: 'pi_bal', amount: 4000, payment_method: 'pm_x',
    metadata: { proposal_id: '4242', payment_type: 'balance' } } } });
  const upd = current.queries.find((q) => /autopay_status = NULL/.test(q.text) && /SET amount_paid/.test(q.text));
  assertNetted(current, upd, 6000, 'balance');
});

test('no off-contract money: the term is 0 and the rails read as before', async () => {
  current = scriptedClient({ status: 'viewed', offContract: [] });
  await handleIntent({ data: { object: { id: 'pi_dep0', amount: 10000, payment_method: 'pm_x',
    metadata: { proposal_id: '4242', payment_type: 'deposit' } } } });
  assertNetted(current, creditUpdate(current, 'deposit'), 0, 'deposit');
});

test('checkout deposit and full rails: the Payment Link settles with the same term', async () => {
  for (const type of ['deposit', 'full']) {
    current = scriptedClient({ status: 'viewed', offContract: TRAVEL });
    const res = { headersSent: false, json() { this.headersSent = true; return this; } };
    await handleCheckout({ data: { object: { id: `cs_${type}`, payment_status: 'paid', payment_intent: `pi_link_${type}`,
      payment_link: 'plink_1', amount_total: type === 'full' ? 11000 : 10000,
      metadata: { proposal_id: '4242', payment_type: type } } } }, res);
    assertNetted(current, creditUpdate(current, type), 1000, `link ${type}`);
  }
});
