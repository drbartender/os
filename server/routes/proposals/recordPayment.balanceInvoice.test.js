// Admin record-payment of a partial mints the Balance invoice (audit PAY-05,
// 2026-11-05).
//
// THE DEFECT. Both webhook rails mint the Balance invoice after a deposit
// (paymentIntentSucceeded.js, checkoutSessionCompleted.js); the admin door did
// not. A deposit recorded by hand (Zelle, say) credited the Deposit invoice,
// which locked when paid, leaving nothing payable: the reminder ladder linked
// a proposal page with no pay control (create-intent refuses deposit_paid),
// the portal's Pay balance dead-ended on that page, autopay could not apply,
// and the balance monitor told the admin a day later to mint one by hand.
//
// PURE, the narrowest seam (the stripeCreateIntent.autopayIdentity pattern):
// the router is mounted, the pool is stubbed on the shared pool object (the
// auth lookup and the pre-transaction read), pool.connect hands the handler a
// scripted client, and the invoice helpers the route destructures at load are
// stubbed before it is required, so the Balance mint is observed as a call.
// The DB-backed sibling is recordPayment.balanceInvoiceRow.test.js.
//
//   node --test server/routes/proposals/recordPayment.balanceInvoice.test.js
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'record-payment-balance-test-secret';

const invoiceHelpers = require('../../utils/invoiceHelpers');
const balanceMints = [];
// The real helper runs for the Full Payment case below (round 2 L1); the rest
// observe the call only.
const realCreateBalanceInvoice = invoiceHelpers.createBalanceInvoice;
let runRealBalanceMint = false;
invoiceHelpers.createBalanceInvoice = async (proposalId, client) => {
  balanceMints.push(proposalId);
  return runRealBalanceMint ? realCreateBalanceInvoice(proposalId, client) : null;
};
invoiceHelpers.linkOpenContractInvoice = async () => null;
invoiceHelpers.upgradeDepositInvoiceToFull = async () => null;
invoiceHelpers.createInvoiceOnSend = async () => null;
invoiceHelpers.notifyLinkOverflow = async () => {};
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const actionsRouter = require('./actions');

actionsRouter.__setDeps({ sendEmail: async () => ({ id: 'dev-skipped' }), notifyAdminCategory: async () => {} });

const ADMIN = { id: 9001, email: 'record-balance@example.com', role: 'admin', onboarding_status: 'approved', token_version: 0, presence_lead_rank: null };
let proposalRow;
let openFullPayment = false; // an open Full Payment invoice demands the remainder
let server, baseUrl, realQuery, realConnect;
const txQueries = [];

function scriptedClient() {
  let paid = Number(proposalRow.amount_paid);
  return {
    release() {},
    async query(text, params) {
      txQueries.push({ text, params });
      if (/FROM invoices WHERE proposal_id = \$1 AND status <> 'void'/.test(text) && /label = 'Balance'/.test(text)) {
        return openFullPayment ? { rows: [{ id: 66 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/SELECT id, group_id FROM proposals/.test(text)) return { rows: [{ id: proposalRow.id, group_id: null }], rowCount: 1 };
      if (/SELECT id, client_id FROM proposals/.test(text)) return { rows: [{ id: proposalRow.id, client_id: 9 }], rowCount: 1 };
      if (/SELECT total_price, amount_paid, status FROM proposals WHERE id = \$1 FOR UPDATE/.test(text)) {
        return { rows: [{ total_price: proposalRow.total_price, amount_paid: String(paid), status: proposalRow.status }], rowCount: 1 };
      }
      if (/UPDATE proposals SET amount_paid = \$1/.test(text)) { paid = Number(params[0]); return { rows: [], rowCount: 1 }; }
      if (/INSERT INTO proposal_payments/.test(text)) return { rows: [{ id: 501 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
}

before(async () => {
  realQuery = pool.query; realConnect = pool.connect;
  pool.query = async function stubbed(text) {
    if (/FROM users WHERE id = \$1/.test(text)) return { rows: [ADMIN], rowCount: 1 };
    if (/SELECT id, total_price, amount_paid, deposit_amount, status FROM proposals/.test(text)) return { rows: [proposalRow], rowCount: 1 };
    return { rows: [{}], rowCount: 1 };
  };
  pool.connect = async () => scriptedClient();
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', actionsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
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

beforeEach(() => {
  balanceMints.length = 0; txQueries.length = 0; runRealBalanceMint = false; openFullPayment = false;
  proposalRow = { id: 4242, total_price: '1000.00', amount_paid: '0', deposit_amount: '100.00', status: 'sent' };
});

function post(body) {
  const payload = JSON.stringify(body);
  const token = jwt.sign({ userId: ADMIN.id, tokenVersion: 0 }, process.env.JWT_SECRET);
  return new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl}/api/proposals/${proposalRow.id}/record-payment`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject); r.write(payload); r.end();
  });
}

test('a partial record (the deposit by Zelle) mints the Balance invoice in the transaction, like both webhook rails', async () => {
  const r = await post({ amount: 100, method: 'zelle' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'deposit_paid');
  assert.deepEqual(balanceMints, [4242], 'createBalanceInvoice called once for the proposal');
  const order = txQueries.map((q) => q.text);
  assert.ok(order.indexOf('COMMIT') > 0, 'committed');
});

test('a full record mints no Balance invoice', async () => {
  const r = await post({ paid_in_full: true, method: 'zelle' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'balance_paid');
  assert.deepEqual(balanceMints, []);
});

test('a second partial on a deposit_paid row still asks for the Balance (the helper is idempotent on the existing one)', async () => {
  proposalRow = { id: 4242, total_price: '1000.00', amount_paid: '100.00', deposit_amount: '100.00', status: 'deposit_paid' };
  const r = await post({ amount: 200, method: 'cash' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'deposit_paid');
  assert.deepEqual(balanceMints, [4242]);
});

// Round 2 L1: the mint fires on every partial, so a row whose open contract
// invoice is a Full Payment invoice (a full-pay quote paid in part by hand)
// got a second open demand for the same remainder. The helper's own
// idempotency now covers it, for this door and the webhook deposit branch alike.
test('a partial record on a row whose open contract invoice is a Full Payment invoice mints no second demand', async () => {
  runRealBalanceMint = true;
  openFullPayment = true;
  const r = await post({ amount: 100, method: 'zelle' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'deposit_paid');
  assert.deepEqual(balanceMints, [4242], 'the route still asks');
  assert.ok(!txQueries.some((q) => /INSERT INTO invoices/.test(q.text)), 'the helper stood down: the Full Payment invoice already demands the remainder');
  assert.ok(txQueries.some((q) => q.text === 'COMMIT'));
});
