// Contract money settled on a row the client never signed (audit ESIG-03,
// 2026-11-05), on both webhook rails.
//
// THE DEFECT. The deposit intent is minted at page load, before the signature,
// and the sign happens only in the browser before confirmPayment; neither
// create-intent nor the webhook read client_signed_at. A client holding the
// secret can confirm without signing: the row became deposit_paid with
// client_signed_at NULL and accepted_at NULL, so the financial dashboard
// (accepted_at IS NOT NULL) never counted the booking and nobody was told the
// contract was unsigned. Now the credit UPDATE stamps accepted_at (the money is
// the acceptance, as the admin record-payment precedent already held) and an
// unsigned settle is recorded in-tx (an unsigned_payment activity row) and
// surfaced post-commit (a Sentry warning, the admin money-anomaly lane). The
// mint-at-load flow is untouched: the Payment Element needs the secret first.
//
// PURE, the narrowest seam (the paymentIntentSucceeded.invoiceConversion
// pattern): the handlers are called directly with their events, pool.connect
// hands them a scripted client that answers by SQL shape and records every
// statement, and the post-commit helpers are stubbed before they are required.
//
//   node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.unsignedSettle.test.js
process.env.SEND_NOTIFICATIONS = 'false';
process.env.SENTRY_DSN_SERVER = process.env.SENTRY_DSN_SERVER || 'https://unsigned-settle-test@example.com/1';

const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');

const invoiceHelpers = require('../../utils/invoiceHelpers');
invoiceHelpers.createBalanceInvoice = async () => null;
invoiceHelpers.linkOpenContractInvoice = async () => null;
invoiceHelpers.upgradeDepositInvoiceToFull = async () => null;
invoiceHelpers.createInvoiceOnSend = async () => null;
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/stripePaymentNotifications').sendPaymentNotifications = async () => {};
const adminAlerts = [];
require('../../utils/adminNotifications').notifyAdminCategory = async (args) => { adminAlerts.push(args); };
require('../../utils/depositPaidSchedulers').scheduleDepositPaidReminders = async () => {};
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};
require('../../utils/lastMinuteAlert').notifyLastMinuteBooking = () => {};

const handleIntent = require('./paymentIntentSucceeded');
const handleCheckout = require('./checkoutSessionCompleted');

function scriptedClient({ status, clientSignedAt, totalPrice = '1000.00' }) {
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
        return { rows: [{ client_signed_at: clientSignedAt, amount_paid: String(paid), total_price: totalPrice }], rowCount: 1 };
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
beforeEach(() => {
  adminAlerts.length = 0;
  pool.connect = async () => current;
});
process.on('exit', () => { pool.connect = realConnect; });

const creditUpdate = (client, type) => client.queries.find((q) => new RegExp(`payment_type = '${type}'`).test(q.text) && /SET amount_paid/.test(q.text));
const unsignedRows = (client) => client.queries.filter((q) => /INSERT INTO proposal_activity_log/.test(q.text) && /'unsigned_payment'/.test(q.text));

test('a deposit confirmed on a viewed, unsigned row: accepted_at stamped, the unsigned row, the alert and the Sentry warning', async (t) => {
  const sentry = t.mock.method(Sentry, 'captureMessage', () => 'evt');
  current = scriptedClient({ status: 'viewed', clientSignedAt: null });
  await handleIntent({ data: { object: { id: 'pi_dep_unsigned', amount: 10000, payment_method: 'pm_x',
    metadata: { proposal_id: '4242', payment_type: 'deposit' } } } });

  const upd = creditUpdate(current, 'deposit');
  assert.ok(upd, 'the deposit credit UPDATE ran');
  assert.match(upd.text, /accepted_at = COALESCE\(accepted_at, NOW\(\)\)/);
  assert.match(upd.text, /RETURNING client_signed_at/);
  assert.equal(unsignedRows(current).length, 1, 'one unsigned_payment activity row');
  const details = JSON.parse(unsignedRows(current)[0].params[1]);
  assert.equal(details.payment_type, 'deposit');
  assert.equal(details.payment_intent_id, 'pi_dep_unsigned');
  assert.equal(adminAlerts.length, 1);
  assert.match(adminAlerts[0].subject, /unsigned proposal/);
  assert.ok(sentry.mock.calls.some((c) => /unsigned_payment: proposal 4242, deposit, 10000 cents/.test(String(c.arguments[0]))),
    'the Sentry warning names the proposal, the rail and the cents');
  assert.ok(current.queries.some((q) => q.text === 'COMMIT'));
  mock.restoreAll();
});

test('a full payment confirmed on a sent, unsigned row records the same', async () => {
  current = scriptedClient({ status: 'sent', clientSignedAt: null });
  await handleIntent({ data: { object: { id: 'pi_full_unsigned', amount: 100000,
    metadata: { proposal_id: '4242', payment_type: 'full' } } } });
  const upd = creditUpdate(current, 'full');
  assert.ok(upd);
  assert.match(upd.text, /accepted_at = COALESCE\(accepted_at, NOW\(\)\)/);
  assert.equal(unsignedRows(current).length, 1);
  assert.equal(JSON.parse(unsignedRows(current)[0].params[1]).payment_type, 'full');
  assert.equal(adminAlerts.length, 1);
});

test('a deposit confirmed on a signed (accepted) row stamps nothing new and records no unsigned settle', async () => {
  current = scriptedClient({ status: 'accepted', clientSignedAt: new Date('2026-11-01T12:00:00Z') });
  await handleIntent({ data: { object: { id: 'pi_dep_signed', amount: 10000, payment_method: 'pm_x',
    metadata: { proposal_id: '4242', payment_type: 'deposit' } } } });
  const upd = creditUpdate(current, 'deposit');
  assert.match(upd.text, /accepted_at = COALESCE\(accepted_at, NOW\(\)\)/, 'COALESCE keeps the signature stamp');
  assert.equal(unsignedRows(current).length, 0);
  assert.equal(adminAlerts.length, 0);
});

test('a balance payment never records an unsigned settle (the booking already exists)', async () => {
  current = scriptedClient({ status: 'deposit_paid', clientSignedAt: null });
  await handleIntent({ data: { object: { id: 'pi_balance', amount: 90000,
    metadata: { proposal_id: '4242', payment_type: 'balance' } } } });
  assert.equal(unsignedRows(current).length, 0);
  assert.equal(adminAlerts.length, 0);
});

test('the Payment Link rail stamps accepted_at on its deposit and full credits (no alert: the admin issued the link)', async () => {
  for (const type of ['deposit', 'full']) {
    current = scriptedClient({ status: 'viewed', clientSignedAt: null });
    const res = { headersSent: false, json() { this.headersSent = true; return this; } };
    await handleCheckout({ data: { object: { id: `cs_${type}`, payment_status: 'paid', payment_intent: `pi_link_${type}`,
      payment_link: 'plink_1', amount_total: type === 'full' ? 100000 : 10000,
      metadata: { proposal_id: '4242', payment_type: type } } } }, res);
    const upd = creditUpdate(current, type);
    assert.ok(upd, `${type}: the credit UPDATE ran`);
    assert.match(upd.text, /accepted_at = COALESCE\(accepted_at, NOW\(\)\)/);
    assert.equal(unsignedRows(current).length, 0, `${type}: no unsigned row on the link rail`);
    assert.equal(adminAlerts.length, 0);
    assert.ok(current.queries.some((q) => q.text === 'COMMIT'), `${type}: committed`);
  }
});
