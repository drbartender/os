// payment_intent.succeeded, the extras and invoice branches: the paid flag
// nets the money collected outside the contract (round 2 M2, 2026-11-05).
//
// THE DEFECT. Both branches compared raw amount_paid with total_price, so a
// 6000 syrup-only pay-now on a 15000 contract with the 10000 deposit paid
// read 16000 >= 15000 and promoted the row to balance_paid while the netted
// balance (quoted, invoiced, chased) still said 5000 was owed: autopay's
// deposit_paid claim and charge-balance's INVALID_STATUS then refused to
// collect it and the completion sweep completed the event. The flag now reads
// contractPaidCents (amount_paid less sumOffContractPaidCents, the partition
// the balance nets) and is derived AFTER this payment's invoice credit lands,
// so the invoice just paid is in the partition.
//
// PURE, the paymentIntentSucceeded.invoiceConversion seam: the handler is
// called directly with the event, pool.connect hands it a scripted client
// that answers by SQL shape and records every statement, and the post-commit
// helpers the handler destructures at load are stubbed before it is required.
//
//   node --test server/routes/stripeWebhookHandlers/paymentIntentSucceeded.netPaidFlag.test.js
process.env.SEND_NOTIFICATIONS = 'false';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../db');

require('../../utils/invoiceHelpers').createBalanceInvoice = async () => null;
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/stripePaymentNotifications').sendPaymentNotifications = async () => {};
require('../../utils/adminNotifications').notifyAdminCategory = async () => {};
require('../../utils/depositPaidSchedulers').scheduleDepositPaidReminders = async () => {};
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};

const handle = require('./paymentIntentSucceeded');

const SYRUP_LINES = [{ line_total: 6000, source_type: 'fee', description: 'Hand-Crafted Syrups (2 bottles)' }];

// A deposit_paid row (contract 15000, deposit 10000 paid) and one open invoice
// the payment lands on: the Drink Plan Extras invoice (fact per case) or a
// free-text manual invoice.
function scriptedClient({ invoice, lines = SYRUP_LINES, totalPrice = '150.00', amountPaid = '100.00' }) {
  const queries = [];
  let paid = Number(amountPaid);
  let invPaid = Number(invoice.amount_paid || 0);
  const client = {
    queries,
    release() {},
    async query(text, params) {
      queries.push({ text, params });
      if (/INSERT INTO proposal_payments/.test(text)) return { rows: [{ id: 501 }], rowCount: 1 };
      if (/SELECT status, archive_reason FROM proposals/.test(text)) return { rows: [{ status: 'deposit_paid', archive_reason: null }], rowCount: 1 };
      if (/SELECT id, group_id FROM proposals/.test(text)) return { rows: [{ id: 4242, group_id: null }], rowCount: 1 };
      if (/SET amount_paid = COALESCE\(amount_paid, 0\) \+ \$1/.test(text)) {
        paid += Number(params[0]);
        return { rows: [{ amount_paid: String(paid), total_price: totalPrice }], rowCount: 1 };
      }
      if (/SELECT total_price, amount_paid FROM proposals WHERE id = \$1/.test(text)) {
        return { rows: [{ total_price: totalPrice, amount_paid: String(paid) }], rowCount: 1 };
      }
      if (/FROM invoices i JOIN proposals p/.test(text)) {
        return { rows: [{ label: invoice.label, status: 'deposit_paid', client_signed_at: new Date() }], rowCount: 1 };
      }
      if (/SELECT id FROM proposal_payments WHERE stripe_payment_intent_id/.test(text)) return { rows: [{ id: 501 }], rowCount: 1 };
      if (/SELECT id FROM invoices WHERE id = \$1 AND proposal_id = \$2/.test(text)) return { rows: [{ id: invoice.id }], rowCount: 1 };
      if (/FROM invoices\s+WHERE proposal_id = \$1 AND label = 'Drink Plan Extras'/.test(text)) {
        return invoice.label === 'Drink Plan Extras' ? { rows: [{ ...invoice, amount_paid: invPaid }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/FROM invoices WHERE id = \$1 FOR UPDATE/.test(text)) {
        return { rows: [{ proposal_id: 4242, status: 'sent', amount_due: invoice.amount_due, amount_paid: invPaid }], rowCount: 1 };
      }
      if (/UPDATE invoices SET amount_paid = amount_paid \+ \$1/.test(text)) {
        invPaid += Number(params[0]);
        return { rows: [{ amount_due: invoice.amount_due, amount_paid: invPaid }], rowCount: 1 };
      }
      // The netting read (sumOffContractPaidCents): the invoice once credited,
      // unless its label is on the bound skip list (the in-contract and
      // off-ledger labels), as the SQL's own filter would drop it.
      if (/FROM invoices\s+WHERE proposal_id = \$1 AND status <> 'void' AND amount_paid > 0/.test(text)) {
        const skipped = Array.isArray(params[1]) && params[1].includes(invoice.label);
        return invPaid > 0 && !skipped ? { rows: [{ id: invoice.id, label: invoice.label, amount_paid: invPaid, folded_into_total: invoice.folded_into_total ?? null }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/FROM invoice_line_items WHERE invoice_id = \$1/.test(text)) return { rows: lines, rowCount: lines.length };
      return { rows: [], rowCount: 1 };
    },
  };
  return client;
}

const realConnect = pool.connect;
let current = null;
beforeEach(() => { pool.connect = async () => current; });
process.on('exit', () => { pool.connect = realConnect; });

const extrasEvent = {
  data: { object: { id: 'pi_extras', amount: 6000, payment_method: null,
    metadata: { proposal_id: '4242', payment_type: 'drink_plan_extras', extras_amount_cents: '6000', balance_amount_cents: '0', drink_plan_id: '55' } } },
};
const invoiceEvent = {
  data: { object: { id: 'pi_manual', amount: 6000, payment_method: null,
    metadata: { proposal_id: '4242', payment_type: 'invoice', invoice_id: '88' } } },
};
const promotions = (client) => client.queries.filter((q) => /status = 'balance_paid'/.test(q.text));
const credited = (client) => client.queries.findIndex((q) => /INSERT INTO invoice_payments/.test(q.text));

test('a 6000 syrup-only extras payment (stored as not folded) on a 15000 contract with the deposit paid: no balance_paid, the money and the link land', async () => {
  current = scriptedClient({ invoice: { id: 77, label: 'Drink Plan Extras', status: 'sent', locked: false, amount_due: 6000, amount_paid: 0, folded_into_total: false } });
  await handle(extrasEvent);
  assert.ok(credited(current) >= 0, 'the extras invoice is credited');
  assert.equal(promotions(current).length, 0, '16000 paid, 6000 of it off-contract: 10000 < 15000');
  assert.ok(current.queries.some((q) => q.text === 'COMMIT'));
});

test('the same shape with a FOLDED extras invoice: contract money, promoted, and only after the credit landed', async () => {
  current = scriptedClient({ invoice: { id: 77, label: 'Drink Plan Extras', status: 'sent', locked: false, amount_due: 6000, amount_paid: 0, folded_into_total: true } });
  await handle(extrasEvent);
  const p = promotions(current);
  assert.equal(p.length, 1);
  assert.match(p[0].text, /status NOT IN \('confirmed', 'completed', 'archived'\)/);
  assert.ok(current.queries.indexOf(p[0]) > credited(current), 'derived after the invoice credit, so the partition holds this payment');
});

test('a row minted before the column (NULL fact) is classified by its syrup-only lines: not promoted', async () => {
  current = scriptedClient({ invoice: { id: 77, label: 'Drink Plan Extras', status: 'sent', locked: false, amount_due: 6000, amount_paid: 0, folded_into_total: null } });
  await handle(extrasEvent);
  assert.equal(promotions(current).length, 0);
  assert.ok(current.queries.some((q) => /FROM invoice_line_items/.test(q.text)), 'the lines were read for the NULL row');
});

test('a free-text manual invoice paid through the invoice rail (money law 5, the third kind): not promoted either', async () => {
  current = scriptedClient({ invoice: { id: 88, label: 'Damage fee', status: 'sent', locked: false, amount_due: 6000, amount_paid: 0 } });
  await handle(invoiceEvent);
  assert.ok(credited(current) >= 0, 'the manual invoice is credited');
  assert.equal(promotions(current).length, 0, '16000 paid, 6000 of it a damage fee: 10000 < 15000');
});

test('a Balance invoice paid through the invoice rail is contract money: promoted', async () => {
  current = scriptedClient({ invoice: { id: 89, label: 'Balance', status: 'sent', locked: false, amount_due: 5000, amount_paid: 0 }, amountPaid: '100.00' });
  await handle({ data: { object: { ...invoiceEvent.data.object, amount: 5000 } } });
  assert.equal(promotions(current).length, 1, '10000 + 5000 = 15000');
});
