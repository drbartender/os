// server/routes/invoices.pendingPayment.test.js
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
const invoicesRouter = require('./invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoices.pendingPayment.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminToken, adminUserId;
const proposalIds = [];
const clientIds = [];

function request(method, path, { token } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j, raw: d }); }); }
    );
    req.on('error', reject);
    req.end();
  });
}

async function seedProposal() {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Pending Payload', $1) RETURNING id`, [`pp-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, event_type, pricing_snapshot, event_timezone)
     VALUES ($1, 'deposit_paid', 500, 100, 'wedding', '{}'::jsonb, 'America/Chicago') RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}
async function seedInvoice(proposalId, label = 'Balance') {
  const token = crypto.randomUUID();
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, $4, 40000, 0, 'sent') RETURNING id, invoice_number`,
    // invoices.invoice_number is VARCHAR(20); NONCE plus the label overruns it (22001).
    [proposalId, token, `INV-${crypto.randomBytes(6).toString('hex')}`, label]
  );
  return { token, id: r.rows[0].id, number: r.rows[0].invoice_number };
}
async function seedProcessing(proposalId, invoiceId, ago = '1 day') {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id)
     VALUES ($1, $2, 40000, 'processing', NOW() - $3::interval, $4)`,
    [proposalId, `pi_${NONCE}_${crypto.randomBytes(3).toString('hex')}`, ago, invoiceId]
  );
}

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version) VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`pp-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await pool.end();
});

test('public invoice GET > pending_payment null and for_this_invoice false when nothing is in flight', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  const r = await request('GET', `/api/invoices/t/${inv.token}`);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.invoice.pending_payment, null);
  assert.equal(r.body.invoice.pending_payment_for_this_invoice, false);
});

test('public invoice GET > carries the newest in-flight payment, inside invoice, with the intent id stripped', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  await seedProcessing(p, inv.id);
  const r = await request('GET', `/api/invoices/t/${inv.token}`);
  assert.equal(r.status, 200, r.raw);
  const pp = r.body.invoice.pending_payment;
  assert.equal(pp.amount_cents, 40000);
  assert.ok(pp.started_at);
  assert.equal(pp.invoice_id, inv.id);
  assert.equal(pp.invoice_number, inv.number);
  assert.equal('stripe_payment_intent_id' in pp, false);
  assert.equal(r.body.invoice.pending_payment_for_this_invoice, true);
  assert.equal('pending_payment' in r.body, false, 'never a top-level sibling the page would not read');
});

test('public invoice GET > an in-flight payment for another invoice on the proposal is reported, for_this_invoice false', async () => {
  const p = await seedProposal();
  const target = await seedInvoice(p, 'Balance');
  const other = await seedInvoice(p, 'Additional Services');
  await seedProcessing(p, other.id);
  const r = await request('GET', `/api/invoices/t/${target.token}`);
  assert.equal(r.body.invoice.pending_payment.invoice_id, other.id);
  assert.equal(r.body.invoice.pending_payment_for_this_invoice, false);
});

test('admin invoices-by-proposal > pending_payments lists every in-flight payment, intent id stripped', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  await seedProcessing(p, inv.id, '2 days');
  await seedProcessing(p, null, '1 hour');
  const r = await request('GET', `/api/invoices/proposal/${p}`, { token: adminToken });
  assert.equal(r.status, 200, r.raw);
  assert.ok(Array.isArray(r.body.invoices));
  assert.equal(r.body.pending_payments.length, 2);
  assert.equal(r.body.pending_payments[0].invoice_id, null, 'newest first');
  assert.equal(r.body.pending_payments[1].invoice_number, inv.number);
  assert.ok(r.body.pending_payments.every((x) => !('stripe_payment_intent_id' in x)));
});
