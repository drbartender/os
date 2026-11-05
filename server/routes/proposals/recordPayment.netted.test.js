// Admin record-payment's remainder, cap and paid flag read the contract money,
// net of the money collected outside it (round 3 H2, 2026-11-05).
//
// THE DEFECT. paid_in_full's arithmetic (total - amount_paid), the Math.min cap
// and isFullyPaid ran on raw amount_paid: total 100000, amount_paid 16000 (the
// 10000 deposit plus a paid unfolded 6000 syrup invoice), the client pays the
// 90000 balance by check, the admin ticks paid in full: appliedAmount 84000, a
// proposal_payments row of 84000, balance_paid, while the reminders kept
// quoting 60.00 owed and a later cancel refunded 6000 short. The remainder is
// now total less contractPaidCents (the netting helper on the held client,
// under the row lock), so paid-in-full records the 90000 the client handed
// over, a typed amount is capped at that remainder, and the flag follows.
//
// PURE, the recordPayment.balanceInvoice seam: the router is mounted, the pool
// is stubbed on the shared pool object, pool.connect hands the handler a
// scripted client that answers the netting read, and the invoice helpers the
// route destructures at load are stubbed before it is required.
//
//   node --test server/routes/proposals/recordPayment.netted.test.js
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'record-payment-netted-test-secret';

const invoiceHelpers = require('../../utils/invoiceHelpers');
invoiceHelpers.createBalanceInvoice = async () => null;
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

const ADMIN = { id: 9001, email: 'record-netted@example.com', role: 'admin', onboarding_status: 'approved', token_version: 0, presence_lead_rank: null };
const SYRUP_INVOICE = { id: 77, label: 'Drink Plan Extras', amount_paid: 6000, folded_into_total: false };
let proposalRow;
let offContract = [];
let server, baseUrl, realQuery, realConnect;
const txQueries = [];

const nettingRead = (text) => /FROM invoices\s+WHERE proposal_id = \$1 AND status <> 'void' AND amount_paid > 0/.test(text);

function scriptedClient() {
  let paid = Number(proposalRow.amount_paid);
  return {
    release() {},
    async query(text, params) {
      txQueries.push({ text, params });
      if (/SELECT id, group_id FROM proposals/.test(text)) return { rows: [{ id: proposalRow.id, group_id: null }], rowCount: 1 };
      if (/SELECT id, client_id FROM proposals/.test(text)) return { rows: [{ id: proposalRow.id, client_id: 9 }], rowCount: 1 };
      if (/SELECT total_price, amount_paid, status FROM proposals WHERE id = \$1 FOR UPDATE/.test(text)) {
        return { rows: [{ total_price: proposalRow.total_price, amount_paid: String(paid), status: proposalRow.status }], rowCount: 1 };
      }
      if (nettingRead(text)) return { rows: offContract, rowCount: offContract.length };
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
    if (nettingRead(text)) return { rows: offContract, rowCount: offContract.length };
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
  txQueries.length = 0;
  offContract = [SYRUP_INVOICE];
  // The report's shape: contract 100000, the 10000 deposit and a paid unfolded
  // 6000 syrup invoice in amount_paid.
  proposalRow = { id: 4242, total_price: '1000.00', amount_paid: '160.00', deposit_amount: '100.00', status: 'deposit_paid' };
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
const paymentRow = () => txQueries.find((q) => /INSERT INTO proposal_payments/.test(q.text));
const paidWrite = () => txQueries.find((q) => /UPDATE proposals SET amount_paid = \$1/.test(q.text));

test('paid in full on the report shape records the 90000 the client handed over, not 84000', async () => {
  const r = await post({ paid_in_full: true, method: 'check' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(paymentRow().params[2], 90000, 'the ledger holds what the client paid');
  assert.equal(Number(paidWrite().params[0]), 1060, '160.00 + 900.00: amount_paid keeps the 60.00 of syrup money beside the 1000.00 of contract money, as the webhook rails leave it');
  assert.equal(r.body.status, 'balance_paid');
  const lockIdx = txQueries.findIndex((q) => /FOR UPDATE/.test(q.text));
  const netIdx = txQueries.findIndex((q) => nettingRead(q.text));
  assert.ok(netIdx > lockIdx, 'the term is read on the held client, under the lock');
});

test('a typed amount is capped at the netted remainder, and a partial stays deposit_paid', async () => {
  const over = await post({ amount: 950, method: 'cash' });
  assert.equal(over.status, 200, JSON.stringify(over.body));
  assert.equal(paymentRow().params[2], 90000, '950.00 typed, 900.00 owed: capped at the contract remainder');
  assert.equal(over.body.status, 'balance_paid');

  txQueries.length = 0;
  const part = await post({ amount: 100, method: 'cash' });
  assert.equal(part.status, 200, JSON.stringify(part.body));
  assert.equal(paymentRow().params[2], 10000);
  assert.equal(part.body.status, 'deposit_paid', '110.00 of contract money against 1000.00');
});

test('a row the raw read calls paid up (amount_paid = total) still owes the syrup money: paid in full records 6000', async () => {
  proposalRow = { ...proposalRow, amount_paid: '1000.00' };
  const r = await post({ paid_in_full: true, method: 'check' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(paymentRow().params[2], 6000);
  assert.equal(r.body.status, 'balance_paid');
});

test('no off-contract money: the arithmetic is unchanged', async () => {
  offContract = [];
  const r = await post({ paid_in_full: true, method: 'check' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(paymentRow().params[2], 84000);
  assert.equal(r.body.status, 'balance_paid');
});
