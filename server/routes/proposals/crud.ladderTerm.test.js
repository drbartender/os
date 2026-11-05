// The admin PATCH's status ladder nets the off-contract money (round 3 M1,
// 2026-11-05).
//
// THE DEFECT. Any admin save re-ran reconcileProposalPaymentStatus on raw
// amount_paid, so the M2 shape (total 15000, the 10000 deposit and a paid
// 6000 syrup-only invoice) was promoted to balance_paid again by a guest
// count edit, undoing the netted flag the webhook and the ladder's other
// callers now derive. The PATCH reads sumOffContractPaidCents on the held
// client before the ladder and hands it the term.
//
// PURE, the narrowest seam: the router is mounted; the pool is stubbed on the
// shared pool object (the auth lookup); pool.connect hands the PATCH a
// scripted client that answers its reads by shape; the engine, the hours
// resolver, the shift sync, the reschedule hook, the invoice refresh and the
// audit tail the route destructures at load are stubbed before it is
// required; and the ladder is wrapped in a spy that still runs the real one,
// so the term it receives is observed and the status decision is the ladder's
// own.
//
//   node --test server/routes/proposals/crud.ladderTerm.test.js
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'crud-ladder-term-test-secret';

const ladderCalls = [];
const proposalStatus = require('../../utils/proposalStatus');
const realLadder = proposalStatus.reconcileProposalPaymentStatus;
proposalStatus.reconcileProposalPaymentStatus = (args) => { ladderCalls.push(args); return realLadder(args); };
const SNAPSHOT = {
  total: 150, base_cost: 150, addons: [], syrups: { selections: [], total: 0 }, bar_rental: { total: 0 },
  staffing: { actual: 1, required: 1, total: 0 }, gratuity: { rate: 0, total: 0, basis: 0 },
};
require('../../utils/pricingEngine').calculateProposal = () => ({ ...SNAPSHOT });
require('./patchContractHours').resolvePatchHours = async () => ({ workedHours: 4, contractHours: 4 });
const eventCreation = require('../../utils/eventCreation');
eventCreation.syncShiftsFromProposal = async () => {};
eventCreation.createEventShifts = async () => null;
require('../../utils/rescheduleProposal').rescheduleProposalInTx = async () => ({ shouldSendEmail: false });
const invoiceHelpers = require('../../utils/invoiceHelpers');
invoiceHelpers.refreshUnlockedInvoices = async () => {};
invoiceHelpers.createAdditionalInvoiceIfNeeded = async () => null;
invoiceHelpers.createInvoiceOnSend = async () => null;
require('../../utils/adminAuditLog').logAdminAction = async () => {};
require('../../utils/gratuityDisclosureNotify').sendGratuityStaffingDisclosure = async () => {};
require('../../utils/marketingHandlers').recomputeNewYearHelloForProposal = async () => {};

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const crudRouter = require('./crud');

const ADMIN = { id: 9001, email: 'crud-ladder@example.com', role: 'admin', onboarding_status: 'approved', token_version: 0, presence_lead_rank: null };
const OLD = {
  id: 4242, status: 'deposit_paid', total_price: '150.00', amount_paid: '160.00', package_id: 3, guest_count: 50,
  event_duration_hours: 4, event_date: '2099-06-01', event_start_time: '18:00', event_timezone: 'America/Chicago',
  num_bars: 0, num_bartenders: 1, pricing_snapshot: { ...SNAPSHOT }, adjustments: [], total_price_override: null,
  gratuity_rate: 0, tip_jar: false, gratuity_floor_rate: null, gratuity_mandate_total: null, gratuity_rate_change_origin: null,
  client_signed_at: null, setup_minutes_before: null, class_options: null, client_provides_glassware: false,
  autopay_enrolled: false, external_paid: 0, adjustments_token: 'tok',
};
const PKG = { id: 3, pricing_type: 'flat', bar_type: 'full', name: 'Flat', min_guests: null, covered_addon_slugs: [], is_active: true };
let offContract = [];
let server, baseUrl, realQuery, realConnect;
const txQueries = [];

function scriptedClient() {
  return {
    release() {},
    async query(text, params) {
      txQueries.push({ text, params });
      if (/FROM proposals WHERE id = \$1 FOR UPDATE/.test(text)) return { rows: [{ ...OLD }], rowCount: 1 };
      if (/SELECT \* FROM service_packages WHERE id = \$1/.test(text)) return { rows: [PKG], rowCount: 1 };
      if (/SELECT \* FROM service_addons WHERE is_active = true/.test(text)) return { rows: [], rowCount: 0 };
      if (/^\s*UPDATE proposals SET\s+event_date = COALESCE/.test(text)) return { rows: [{ ...OLD, total_price: '150.00' }], rowCount: 1 };
      if (/FROM invoices\s+WHERE proposal_id = \$1 AND status <> 'void' AND amount_paid > 0/.test(text)) {
        return { rows: offContract, rowCount: offContract.length };
      }
      if (/UPDATE proposals SET status = \$1/.test(text)) return { rows: [{ ...OLD, status: params[0] }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
}

before(async () => {
  realQuery = pool.query; realConnect = pool.connect;
  pool.query = async function stubbed(text) {
    if (/FROM users WHERE id = \$1/.test(text)) return { rows: [ADMIN], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  pool.connect = async () => scriptedClient();
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', crudRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    console.error(err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  pool.query = realQuery; pool.connect = realConnect;
  if (server) await new Promise((r) => server.close(r));
});

beforeEach(() => { txQueries.length = 0; ladderCalls.length = 0; offContract = []; });

function patch(body) {
  const payload = JSON.stringify(body);
  const token = jwt.sign({ userId: ADMIN.id, tokenVersion: 0 }, process.env.JWT_SECRET);
  return new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl}/api/proposals/${OLD.id}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject); r.write(payload); r.end();
  });
}
const statusWrites = () => txQueries.filter((q) => /UPDATE proposals SET status = \$1/.test(q.text));

test('a guest-count save on the M2 shape hands the ladder the 6000 term and the row stays deposit_paid', async () => {
  offContract = [{ id: 77, label: 'Drink Plan Extras', amount_paid: 6000, folded_into_total: false }];
  const r = await patch({ guest_count: 50 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(ladderCalls.length, 1, 'the ladder ran once');
  assert.equal(ladderCalls[0].offContractPaidCents, 6000, 'the term reached the ladder');
  assert.equal(ladderCalls[0].status, 'deposit_paid');
  assert.equal(statusWrites().length, 0, 'no promotion: 100.00 of contract money against 150.00');
  assert.equal(r.body.status, 'deposit_paid');
  const lockIdx = txQueries.findIndex((q) => /FOR UPDATE/.test(q.text));
  const netIdx = txQueries.findIndex((q) => /amount_paid > 0/.test(q.text));
  assert.ok(netIdx > lockIdx, 'the term is read on the held client, under the row lock');
});

test('no off-contract money: the same save promotes, as the raw ladder always did', async () => {
  const r = await patch({ guest_count: 50 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(ladderCalls[0].offContractPaidCents, 0);
  assert.equal(statusWrites().length, 1);
  assert.equal(r.body.status, 'balance_paid');
});
