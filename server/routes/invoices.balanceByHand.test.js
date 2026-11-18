// An admin's "Balance" invoice is the system's own Balance (audit PAY-08 with
// the record-payment mint left out of this lane).
//
// THE GAP. The system-label fence refused an admin-made Balance invoice, but
// an admin-recorded deposit mints no Balance (only the two webhook rails call
// createBalanceInvoice), so a booking paid off-platform had no Balance and no
// way to get one: the monitor emailed "no payable invoice" and the one remedy,
// a hand-made Balance, was refused. A "Balance" request now mints through
// createBalanceInvoice under the proposal's row lock, only in the state the
// payment rails mint it in: the booking's one live invoice is its paid, locked
// Deposit and every paid dollar is inside it (BALANCE_NOT_AT_DEPOSIT
// otherwise), so total minus paid is also what the Balance refresh bills it at
// later. The typed amount is not used; a legal-hold booking is refused. Every
// other system label stays refused.
//
// DB-BACKED: run alone against the shared dev DB.
//
//   node --test server/routes/invoices.balanceByHand.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { __setLegalHoldIdsForTest } = require('../utils/legalHold');
const invoicesRouter = require('./invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoices.balanceByHand.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminUserId, adminToken;
const proposalIds = [];
const clientIds = [];

async function seedProposal({ depositStatus = 'paid', amountPaid = 100, extra = null } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Balance By Hand', $1) RETURNING id`,
    [`balance-hand-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, event_type, pricing_snapshot)
     VALUES ($1, 'deposit_paid', 1000, $2, 'wedding', '{}'::jsonb) RETURNING id`,
    [c.rows[0].id, amountPaid]
  );
  const id = p.rows[0].id;
  proposalIds.push(id);
  const paid = depositStatus === 'paid';
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, $3, $4, $5)`,
    [id, `BH${id}-${crypto.randomBytes(2).toString('hex')}`, paid ? 10000 : 0, depositStatus, paid]
  );
  if (extra) {
    await pool.query(
      `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
       VALUES ($1, $2, $3, $4, 0, 'sent')`,
      [id, `BX${id}-${crypto.randomBytes(2).toString('hex')}`, extra.label, extra.amountDue]
    );
  }
  return id;
}

function post(path, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Authorization: `Bearer ${adminToken}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j, raw: b }); }); }
    );
    r.on('error', reject); r.write(payload); r.end();
  });
}

const balances = async (id) => (await pool.query(
  `SELECT amount_due, status FROM invoices WHERE proposal_id = $1 AND label = 'Balance' AND status <> 'void'`, [id]
)).rows;

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`balance-hand-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await pool.end();
});

test('a recorded-deposit booking with no Balance: "Balance" mints the system Balance at total minus paid, never the typed amount', async () => {
  const id = await seedProposal();
  const r = await post(`/api/invoices/proposal/${id}`, { label: 'Balance', amount: 5 });
  assert.equal(r.status, 201, r.raw);
  assert.equal(r.body.invoice.label, 'Balance');
  const rows = await balances(id);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount_due), 90000, '1000 total less 100 paid, in cents');
  assert.equal(rows[0].status, 'sent');
});

test('a second "Balance" is refused (409) and leaves the one Balance alone; the label match is case-insensitive', async () => {
  const id = await seedProposal();
  assert.equal((await post(`/api/invoices/proposal/${id}`, { label: ' balance ', amount: 900 })).status, 201);
  const again = await post(`/api/invoices/proposal/${id}`, { label: 'Balance', amount: 900 });
  assert.equal(again.status, 409, again.raw);
  assert.equal(again.body.code, 'BALANCE_NOT_AT_DEPOSIT');
  assert.equal((await balances(id)).length, 1);
});

test('an open Deposit invoice still demands money: "Balance" is refused (409) so the two never bill the same money', async () => {
  const id = await seedProposal({ depositStatus: 'sent' });
  const r = await post(`/api/invoices/proposal/${id}`, { label: 'Balance', amount: 900 });
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'BALANCE_NOT_AT_DEPOSIT');
  assert.equal((await balances(id)).length, 0);
});

test('an open Additional Services invoice beside the paid Deposit: refused, since the Balance would bill its delta again', async () => {
  const id = await seedProposal({ extra: { label: 'Additional Services', amountDue: 20000 } });
  const r = await post(`/api/invoices/proposal/${id}`, { label: 'Balance', amount: 900 });
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'BALANCE_NOT_AT_DEPOSIT');
  assert.equal((await balances(id)).length, 0);
});

test('a recorded payment above the Deposit invoice (money no invoice holds): refused, since the next refresh would bill that money again', async () => {
  const id = await seedProposal({ amountPaid: 500 });
  const r = await post(`/api/invoices/proposal/${id}`, { label: 'Balance', amount: 500 });
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'BALANCE_NOT_AT_DEPOSIT');
  assert.equal((await balances(id)).length, 0);
});

test('a legal-hold booking gets no Balance minted (409 LEGAL_HOLD)', async () => {
  const id = await seedProposal();
  __setLegalHoldIdsForTest([id]);
  try {
    const r = await post(`/api/invoices/proposal/${id}`, { label: 'Balance', amount: 900 });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.code, 'LEGAL_HOLD');
    assert.equal((await balances(id)).length, 0);
  } finally {
    __setLegalHoldIdsForTest(null);
  }
});

test('every other system label is still refused (400)', async () => {
  const id = await seedProposal();
  for (const label of ['Deposit', 'Full Payment', 'Additional Services', 'Enhancement Lab', 'Drink Plan Extras', 'Service Extension']) {
    const r = await post(`/api/invoices/proposal/${id}`, { label, amount: 100 });
    assert.equal(r.status, 400, `${label}: ${r.raw}`);
  }
});
