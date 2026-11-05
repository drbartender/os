// Autopay balance charge after a syrup-only Drink Plan Extras payment (audit
// PAY-01, 2026-11-05).
//
// THE DEFECT. A syrup-only "Drink Plan Extras" payment rolls into
// proposals.amount_paid (the webhook's drink_plan_extras branch) but never into
// total_price (submit.js: "syrups are additive money that never fold into
// total_price"). chargeOne read the balance as total_price - amount_paid, so
// the autopay charge came up short by exactly the syrup money: contract 100000,
// deposit 10000, syrups 6000 -> charged 84000, not 90000, and the balance
// branch then marked the row balance_paid, so nothing ever flagged the 6000.
//
// PURE: the pool is stubbed on the shared pool object (the sms.status.test.js
// pattern), Stripe through the getStripe seam, and the durable-charge helpers
// on their module before balanceScheduler destructures them at load. The
// claim UPDATE answers with the report's row; the netting reads answer with
// one paid, unfolded extras invoice.
//
//   node --test server/utils/balanceScheduler.netting.test.js
process.env.SEND_NOTIFICATIONS = 'false';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

const durable = require('./autopayDurableCharge');
durable.recordBalanceIntent = async () => {};
durable.priorBalanceChargeSettling = async () => ({ skip: false });

const createCalls = [];
require('./stripeClient').getStripe = () => ({
  paymentIntents: {
    create: async (params) => {
      createCalls.push(params);
      return { id: `pi_fake_${createCalls.length}`, status: 'succeeded' };
    },
  },
});

const { processAutopayCharges } = require('./balanceScheduler');

const CLAIM_ROW = {
  id: 4242, total_price: '1000.00', amount_paid: '160.00',
  stripe_customer_id: 'cus_fixture', stripe_payment_method_id: 'pm_fixture',
  event_type: 'wedding', event_type_custom: null, balance_due_date: new Date('2026-06-10T00:00:00Z'),
};

// invoices.amount_paid is INTEGER CENTS: the syrup-only extras invoice, paid
// and locked, 6000 cents, syrup lines only (source_type 'fee', no addon line,
// no bar line), i.e. extrasLinesAreFolded() is false.
function stubPool(queries) {
  const realQuery = pool.query;
  pool.query = async function stubbed(text, params) {
    queries.push({ text, params });
    if (/SET autopay_status = 'in_progress'/.test(text)) return { rows: [CLAIM_ROW], rowCount: 1 };
    if (/FROM invoices/.test(text) && /amount_paid > 0/.test(text)) {
      return { rows: [{ id: 77, label: 'Drink Plan Extras', amount_paid: 6000 }], rowCount: 1 };
    }
    if (/FROM invoice_line_items/.test(text)) {
      return { rows: [
        { line_total: 3000, source_type: 'fee', description: 'Blackberry syrup' },
        { line_total: 3000, source_type: 'fee', description: 'Vanilla syrup' },
      ], rowCount: 2 };
    }
    return { rows: [], rowCount: 0 };
  };
  return () => { pool.query = realQuery; };
}

test('autopay charges the contract balance net of the syrup money: 100000 - 16000 + 6000 = 90000', async () => {
  const queries = [];
  const restore = stubPool(queries);
  try {
    await processAutopayCharges();
  } finally {
    restore();
  }
  assert.equal(createCalls.length, 1, 'exactly one balance intent');
  assert.equal(createCalls[0].amount, 90000);
  assert.equal(createCalls[0].metadata.proposal_id, '4242');
  assert.equal(createCalls[0].metadata.payment_type, 'balance');
  assert.ok(queries.some((q) => /FROM invoices/.test(q.text) && q.params && q.params[0] === 4242),
    'the netting read is keyed on the claimed proposal');
});
