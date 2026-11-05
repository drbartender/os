// payment_intent.succeeded, invoice branch: a Deposit invoice paid on a
// pre-conversion row converts the booking (audit PAY-02, 2026-11-05).
//
// THE DEFECT. The invoice branch rolled the captured money into amount_paid
// and moved status only when fully paid, so a Deposit invoice paid from the
// public invoice page (an intent minted before create-intent-for-invoice
// refused it) left the row 'sent' with amount_paid 100: no deposit_paid, no
// Balance invoice, no reminder ladder, while createEventShifts still ran and
// the proposal page still offered Sign & Pay, so a second deposit could be
// taken. The branch now runs the deposit conversion (derived status, the
// Balance invoice, the reminder ladder), and records an unsigned settle (an
// activity row and an admin alert) when the row carries no signature.
//
// PURE, the narrowest seam: the handler is called directly with the event (no
// router, no signature), pool.connect hands it a scripted client that answers
// by SQL shape and records every statement, and the post-commit helpers the
// handler destructures at load are stubbed before it is required.
//
//   node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.invoiceConversion.test.js
process.env.SEND_NOTIFICATIONS = 'false';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../db');

const balanceInvoiceCalls = [];
require('../../utils/invoiceHelpers').createBalanceInvoice = async (proposalId) => { balanceInvoiceCalls.push(proposalId); return null; };
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/stripePaymentNotifications').sendPaymentNotifications = async () => {};
const adminAlerts = [];
require('../../utils/adminNotifications').notifyAdminCategory = async (args) => { adminAlerts.push(args); };
const reminderCalls = [];
require('../../utils/depositPaidSchedulers').scheduleDepositPaidReminders = async (proposalId, opts) => { reminderCalls.push({ proposalId, ...opts }); };
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};

const handle = require('./paymentIntentSucceeded');

// A proposal row and its send-time Deposit invoice, answered by SQL shape.
function scriptedClient({ status, clientSignedAt, label = 'Deposit', totalPrice = '1000.00', amountPaid = '0' }) {
  const queries = [];
  let paid = Number(amountPaid);
  const client = {
    queries,
    release() {},
    async query(text, params) {
      queries.push({ text, params });
      if (/INSERT INTO proposal_payments/.test(text)) return { rows: [{ id: 501 }], rowCount: 1 };
      if (/SELECT status, archive_reason FROM proposals/.test(text)) return { rows: [{ status, archive_reason: null }], rowCount: 1 };
      if (/SELECT id, group_id FROM proposals/.test(text)) return { rows: [{ id: 4242, group_id: null }], rowCount: 1 };
      if (/FROM invoices i JOIN proposals p/.test(text)) {
        return { rows: [{ label, status, client_signed_at: clientSignedAt }], rowCount: 1 };
      }
      if (/SELECT label FROM invoices WHERE id = \$1/.test(text)) return { rows: [{ label }], rowCount: 1 };
      if (/SET amount_paid = COALESCE\(amount_paid, 0\) \+ \$1/.test(text)) {
        paid += Number(params[0]);
        return { rows: [{ amount_paid: String(paid), total_price: totalPrice }], rowCount: 1 };
      }
      // The netted paid flag's own read (round 2 M2), after the invoice link.
      if (/SELECT total_price, amount_paid FROM proposals WHERE id = \$1/.test(text)) {
        return { rows: [{ total_price: totalPrice, amount_paid: String(paid) }], rowCount: 1 };
      }
      if (/SELECT event_date, event_start_time FROM proposals/.test(text)) {
        return { rows: [{ event_date: new Date('2099-06-01T00:00:00Z'), event_start_time: '18:00' }], rowCount: 1 };
      }
      if (/SELECT id FROM proposal_payments WHERE stripe_payment_intent_id/.test(text)) return { rows: [{ id: 501 }], rowCount: 1 };
      if (/SELECT id FROM invoices WHERE id = \$1 AND proposal_id = \$2/.test(text)) return { rows: [{ id: 77 }], rowCount: 1 };
      if (/FROM invoices WHERE id = \$1 FOR UPDATE/.test(text)) {
        return { rows: [{ proposal_id: 4242, status: 'sent', amount_due: 10000, amount_paid: 0 }], rowCount: 1 };
      }
      if (/UPDATE invoices SET amount_paid = amount_paid \+ \$1/.test(text)) return { rows: [{ amount_due: 10000, amount_paid: 10000 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  return client;
}

const realConnect = pool.connect;
let current = null;
beforeEach(() => {
  balanceInvoiceCalls.length = 0; adminAlerts.length = 0; reminderCalls.length = 0;
  pool.connect = async () => current;
});
process.on('exit', () => { pool.connect = realConnect; });

const depositEvent = {
  data: { object: { id: 'pi_invoice_deposit', amount: 10000, payment_method: 'pm_x',
    metadata: { proposal_id: '4242', payment_type: 'invoice', invoice_id: '77' } } },
};

function statusMoves(client) {
  return client.queries.filter((q) => /UPDATE proposals/.test(q.text) && /status/.test(q.text) && /deposit_paid/.test(q.text));
}

test('a Deposit invoice paid on a sent, unsigned row converts the booking and records the unsigned settle', async () => {
  current = scriptedClient({ status: 'sent', clientSignedAt: null });
  await handle(depositEvent);

  const moves = statusMoves(current);
  assert.equal(moves.length, 1, 'one status conversion UPDATE');
  assert.match(moves[0].text, /status IN \('sent', 'viewed', 'accepted'\)/, 'guarded to the pre-conversion statuses');
  assert.deepEqual(balanceInvoiceCalls, ['4242'], 'the Balance invoice is minted in the transaction');
  assert.equal(reminderCalls.length, 1, 'the deposit-paid reminder ladder is scheduled');
  assert.equal(reminderCalls[0].proposalId, '4242');

  const unsigned = current.queries.filter((q) => /INSERT INTO proposal_activity_log/.test(q.text) && /'unsigned_payment'/.test(q.text));
  assert.equal(unsigned.length, 1, 'an unsigned_payment activity row');
  const details = JSON.parse(unsigned[0].params[1]);
  assert.equal(details.payment_intent_id, 'pi_invoice_deposit');
  assert.equal(details.invoice_label, 'Deposit');
  assert.equal(adminAlerts.length, 1, 'one admin alert');
  assert.match(adminAlerts[0].subject, /unsigned/i);
  assert.equal(adminAlerts[0].category, 'payment_failure');
  const committed = current.queries.some((q) => q.text === 'COMMIT');
  assert.ok(committed);
});

test('a Deposit invoice paid on an accepted, SIGNED row converts without the unsigned record', async () => {
  current = scriptedClient({ status: 'accepted', clientSignedAt: new Date() });
  await handle(depositEvent);
  assert.equal(statusMoves(current).length, 1);
  assert.deepEqual(balanceInvoiceCalls, ['4242']);
  assert.equal(reminderCalls.length, 1);
  assert.equal(current.queries.filter((q) => /'unsigned_payment'/.test(q.text)).length, 0);
  assert.equal(adminAlerts.length, 0);
});

test('a Balance invoice paid on a deposit_paid row is the ordinary invoice credit: no conversion, no Balance mint, no ladder', async () => {
  current = scriptedClient({ status: 'deposit_paid', clientSignedAt: null, label: 'Balance', amountPaid: '100' });
  await handle({ data: { object: { id: 'pi_invoice_balance', amount: 90000,
    metadata: { proposal_id: '4242', payment_type: 'invoice', invoice_id: '77' } } } });
  assert.equal(statusMoves(current).length, 0, 'no deposit_paid conversion');
  assert.deepEqual(balanceInvoiceCalls, []);
  assert.equal(reminderCalls.length, 0);
  assert.equal(adminAlerts.length, 0);
  // Fully paid: the existing promotion still runs.
  assert.ok(current.queries.some((q) => /SET status = 'balance_paid'/.test(q.text)));
});

test('a manual invoice paid on a sent row is credited but never converts the booking', async () => {
  current = scriptedClient({ status: 'sent', clientSignedAt: null, label: 'Damage fee' });
  await handle({ data: { object: { id: 'pi_invoice_manual', amount: 25000,
    metadata: { proposal_id: '4242', payment_type: 'invoice', invoice_id: '77' } } } });
  assert.equal(statusMoves(current).length, 0);
  assert.deepEqual(balanceInvoiceCalls, []);
  assert.equal(reminderCalls.length, 0);
  assert.equal(adminAlerts.length, 0);
});
