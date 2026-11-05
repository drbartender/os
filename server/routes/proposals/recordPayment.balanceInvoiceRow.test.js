// Admin record-payment of a partial mints the Balance invoice (audit PAY-05,
// 2026-11-05). DB-BACKED: run alone against the shared dev DB.
//
//   node --test server/routes/proposals/recordPayment.balanceInvoiceRow.test.js
//
// The pure pin is recordPayment.balanceInvoice.test.js; this suite asserts the
// rows in the fullOnDeposit suite's shape: a hand-recorded deposit on a sent
// proposal leaves a Balance invoice at the remaining contract, the Deposit
// invoice paid and locked; a full record mints none.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('recordPayment.balanceInvoiceRow.test.js refuses to run against production');
}

require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => {};
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};

const actionsRouter = require('./actions');

const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
let server, baseUrl, adminId, adminToken, clientId;
const proposalIds = [];

async function seed() {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours,
                            total_price, amount_paid, deposit_amount, external_paid, pricing_snapshot, payment_type, balance_due_date)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'sent', 'Cocktail Party', '6:00 PM', 4,
             1000, 0, 100, 0, '{"package": {"name": "The Core Reaction", "base_cost": 800}, "total": 1000}'::jsonb, 'deposit',
             CURRENT_DATE + INTERVAL '16 days')
     RETURNING id`,
    [clientId]
  );
  proposalIds.push(p.rows[0].id);
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent', false) RETURNING id`,
    [p.rows[0].id, `RBI${NONCE}${proposalIds.length}`]
  );
  return { proposalId: p.rows[0].id, depositInvoiceId: i.rows[0].id };
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

before(async () => {
  const a = await pool.query(`INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'admin') RETURNING id`, [`recpay-bal-${NONCE}-admin@example.test`]);
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);
  const c = await pool.query(`INSERT INTO clients (name, email, email_status) VALUES ('Record Balance Invoice', $1, 'ok') RETURNING id`, [`recpay-bal-${NONCE}@example.test`]);
  clientId = c.rows[0].id;
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', actionsRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE id = $1', [adminId]);
  await pool.end();
});

test('a partial record leaves a Balance invoice at the remaining contract, beside the paid, locked Deposit', async () => {
  const f = await seed();
  const r = await post(`/api/proposals/${f.proposalId}/record-payment`, { amount: 100, method: 'zelle' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.status, 'deposit_paid');
  const dep = (await pool.query('SELECT status, locked FROM invoices WHERE id = $1', [f.depositInvoiceId])).rows[0];
  assert.equal(dep.status, 'paid');
  assert.equal(dep.locked, true);
  const bal = await pool.query(`SELECT amount_due, status FROM invoices WHERE proposal_id = $1 AND label = 'Balance' AND status <> 'void'`, [f.proposalId]);
  assert.equal(bal.rows.length, 1, 'exactly one Balance invoice');
  assert.equal(Number(bal.rows[0].amount_due), 90000);
  assert.equal(bal.rows[0].status, 'sent');
});

test('a full record mints no Balance invoice', async () => {
  const f = await seed();
  const r = await post(`/api/proposals/${f.proposalId}/record-payment`, { paid_in_full: true, method: 'zelle' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.status, 'balance_paid');
  const bal = await pool.query(`SELECT id FROM invoices WHERE proposal_id = $1 AND label = 'Balance' AND status <> 'void'`, [f.proposalId]);
  assert.equal(bal.rows.length, 0);
});
