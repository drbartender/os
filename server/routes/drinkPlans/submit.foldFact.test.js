// The submit paths tell the extras invoice whether its money folded into
// total_price (round 2, H1, 2026-11-05).
//
// THE DEFECT. The transaction path folds the whole extras (new add-on rows,
// a bar, the new syrups) into total_price; the fast path folds nothing. The
// invoice carried no record of which path minted it, so the readers guessed
// from its line shape and a syrup-only-looking invoice from the transaction
// path (an already-sold upgrade toggled beside two new syrups) was netted as
// off-contract money the contract already held: autopay and charge-balance
// then collected 6000 too much (96000 against 90000 owed).
//
// PURE, the narrowest seam: handleSubmit is called directly; pool.query
// answers the pre-transaction read, pool.connect hands it a scripted client,
// and the fold, the catalog loads, the breakdown, the notifications and the
// invoice helper the handler destructures at load are stubbed before it is
// required, so the fact the submit hands the invoice helper is observed as a
// call. The DB-backed sibling is submitExtras.foldDelta.test.js.
//
//   node --test server/routes/drinkPlans/submit.foldFact.test.js
process.env.SEND_NOTIFICATIONS = 'false';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../db');

const invoiceCalls = [];
const invoiceHelpers = require('../../utils/invoiceHelpers');
invoiceHelpers.findOrRefreshExtrasInvoice = async (a) => { invoiceCalls.push(a); return { id: 900 }; };
invoiceHelpers.refreshUnlockedInvoices = async () => {};
invoiceHelpers.createAdditionalInvoiceIfNeeded = async () => null;
const SOLD_UPGRADE = { id: 7, slug: 'premium-glassware', name: 'Premium Glassware', billing_type: 'per_guest', rate: '2.00', quantity: 50, line_total: '100.00' };
const fold = require('../../utils/proposalExtrasFold');
let foldTotal = 1060;
const foldCalls = [];
fold.foldExtrasIntoProposal = async (a) => { foldCalls.push(a); return { snapshot: { total: foldTotal, addons: [] }, statusChanged: false }; };
fold.loadRepriceAddons = async () => [SOLD_UPGRADE];
require('../../utils/contractDuration').contractDurationHours = async () => 4;
const SYRUP_LINE = { description: 'Hand-Crafted Syrups (2 bottles)', quantity: 1, unit_price: 6000, line_total: 6000, source_type: 'fee', source_id: null };
let breakdown = null;
require('../../utils/drinkPlanExtras').computeExtrasBreakdown = async () => breakdown;
require('../../utils/shoppingListGen').triggerShoppingListAutoGen = () => {};
const notify = require('./submitNotify');
notify.scheduleLabFollowupAfterSubmit = () => {};
notify.sendFinancialSubmitNotifications = async () => {};
notify.sendFastPathConfirmation = async () => {};

const { handleSubmit } = require('./submit');

const TOKEN = '0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
const PLAN = {
  id: 55, status: 'draft', proposal_id: 4242, finalized_at: null, client_name: 'Client', client_email: 'client@example.com',
  event_type: 'wedding', event_type_custom: null, planner_version: 1, proposal_status: 'deposit_paid',
  package_category: 'byob', package_bar_type: 'full', client_id: 9, live_client_email: 'client@example.com',
  live_client_name: 'Client', communication_preferences: null, email_status: 'ok', phone_status: 'ok',
};
const PROPOSAL = {
  id: 4242, status: 'deposit_paid', total_price: '1000.00', amount_paid: '100.00', guest_count: 50, package_id: 3,
  num_bars: 0, num_bartenders: 1, event_duration_hours: 4, event_date: '2099-06-01', balance_due_date: '2099-05-18',
  pricing_snapshot: { total: 1000, syrups: { selections: [] } }, adjustments: [], gratuity_rate: 0, tip_jar: false,
};
const txQueries = [];
function scriptedClient() {
  return {
    release() {},
    async query(text, params) {
      txQueries.push({ text, params });
      if (/UPDATE drink_plans SET/.test(text)) {
        return { rows: [{ id: 55, token: TOKEN, status: params[2], serving_type: null, submitted_at: params[3], proposal_id: 4242 }], rowCount: 1 };
      }
      if (/SELECT \* FROM proposals WHERE id = \$1 FOR UPDATE/.test(text)) return { rows: [{ ...PROPOSAL }], rowCount: 1 };
      if (/SELECT id, covered_addon_slugs FROM service_packages/.test(text)) return { rows: [{ id: 3, covered_addon_slugs: [] }], rowCount: 1 };
      if (/SELECT \* FROM service_packages WHERE id = \$1/.test(text)) return { rows: [{ id: 3, pricing_type: 'flat', category: 'byob' }], rowCount: 1 };
      if (/SELECT \* FROM service_addons WHERE slug = ANY/.test(text)) {
        const rows = params[0].includes('premium-glassware') ? [{ id: 7, slug: 'premium-glassware', name: 'Premium Glassware', billing_type: 'per_guest', rate: '2.00' }] : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

const realQuery = pool.query;
const realConnect = pool.connect;
pool.query = async (text) => {
  if (/FROM drink_plans dp/.test(text)) return { rows: [{ ...PLAN }], rowCount: 1 };
  return { rows: [], rowCount: 0 };
};
pool.connect = async () => scriptedClient();
process.on('exit', () => { pool.query = realQuery; pool.connect = realConnect; });

beforeEach(() => { invoiceCalls.length = 0; foldCalls.length = 0; txQueries.length = 0; });

function submit(selections) {
  const req = { body: { status: 'submitted', paid_separately: true, selections }, params: { token: TOKEN } };
  let body = null;
  const res = { json(b) { body = b; return this; } };
  return handleSubmit(req, res).then(() => body);
}

test('the transaction path (an already-sold upgrade toggled beside two new syrups, paid now): the fold ran, the invoice is told folded', async () => {
  breakdown = { totalCents: 6000, addonCents: 0, barRentalCents: 0, syrupCents: 6000, lines: [SYRUP_LINE], folded: true };
  foldTotal = 1060;
  const body = await submit({ addOns: { 'premium-glassware': { enabled: true } }, syrupSelections: ['blackberry', 'vanilla'] });
  assert.equal(body.status, 'submitted');
  assert.equal(foldCalls.length, 1, 'the fold ran (the contract absorbed the syrups)');
  assert.equal(invoiceCalls.length, 1);
  assert.equal(invoiceCalls[0].foldedIntoTotal, true, 'the invoice is told its money is inside total_price');
  assert.equal(invoiceCalls[0].breakdown.totalCents, 6000);
  assert.ok(txQueries.some((q) => q.text === 'COMMIT'));
});

test('the fast path (syrups alone, paid now): nothing folded, the invoice is told so', async () => {
  breakdown = { totalCents: 6000, addonCents: 0, barRentalCents: 0, syrupCents: 6000, lines: [SYRUP_LINE], folded: false };
  const body = await submit({ syrupSelections: ['blackberry', 'vanilla'] });
  assert.equal(body.status, 'submitted');
  assert.equal(foldCalls.length, 0, 'no fold on the fast path');
  assert.equal(invoiceCalls.length, 1);
  assert.equal(invoiceCalls[0].foldedIntoTotal, false);
  assert.ok(txQueries.some((q) => q.text === 'COMMIT'));
});
