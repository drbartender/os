require('dotenv').config();

// B4: comp / waive of a "Drink Plan Extras" invoice.
//   - PATCH /api/invoices/:id {status:'void'} on an extras invoice voids it,
//     logs extras_comped, and (comp mode) reduces proposals.total_price by the
//     ADD-ON + BAR-RENTAL portion only (never syrups), re-running the payment
//     status ladder.
//   - The shared helper's path-switch mode (reconcileTotalPrice:false) voids +
//     audits but leaves total_price untouched (used by submit's add-to-balance
//     re-submit).
//   - Voiding an extras invoice with payments applied is refused (409).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const invoicesRouter = require('./invoices');
const { voidExtrasInvoiceWithReconcile } = require('../utils/invoiceHelpers');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminToken, adminUserId;
const proposalIds = [];
const clientIds = [];

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
                   ...(buf ? { 'Content-Type': 'application/json', 'Content-Length': buf.length } : {}) } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j, raw: d }); }); }
    );
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

async function seedProposal({ totalPrice }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Void Test', $1) RETURNING id`,
    [`void-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid) VALUES ($1, 'deposit_paid', $2, 100) RETURNING id`,
    [c.rows[0].id, totalPrice]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedExtrasInvoice(proposalId, { amountDue, amountPaid = 0, lines }) {
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Drink Plan Extras', $3, $4, 'sent') RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, amountDue, amountPaid]
  );
  const invoiceId = inv.rows[0].id;
  for (const l of lines) {
    await pool.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type, source_id)
       VALUES ($1, $2, 1, $3, $3, $4, $5)`,
      [invoiceId, l.description, l.line_total, l.source_type, l.source_id ?? null]
    );
  }
  return invoiceId;
}

async function totalPriceOf(proposalId) {
  const r = await pool.query('SELECT total_price FROM proposals WHERE id = $1', [proposalId]);
  return Number(r.rows[0].total_price);
}
async function statusOf(invoiceId) {
  const r = await pool.query('SELECT status FROM invoices WHERE id = $1', [invoiceId]);
  return r.rows[0].status;
}
async function compLog(proposalId) {
  const r = await pool.query(
    `SELECT details->>'amount_cents' AS amt, details->>'reason' AS reason, actor_type
       FROM proposal_activity_log WHERE action = 'extras_comped' AND proposal_id = $1 ORDER BY id`,
    [proposalId]
  );
  return r.rows;
}

before(async () => {
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id`,
    [`void-admin-${NONCE}@example.com`, await bcrypt.hash('x', 4)]
  );
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) { const b = { error: err.message, code: err.code }; if (err.fieldErrors) b.fieldErrors = err.fieldErrors; return res.status(err.statusCode).json(b); }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});

after(async () => {
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('comp syrup-only: voids, total_price unchanged, logs extras_comped', async () => {
  const p = await seedProposal({ totalPrice: 1000 });
  const inv = await seedExtrasInvoice(p, { amountDue: 6000, lines: [
    { description: 'Hand-Crafted Syrups (2 bottles)', line_total: 6000, source_type: 'fee' },
  ] });
  const r = await request('PATCH', `/api/invoices/${inv}`, { token: adminToken, body: { status: 'void' } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(await statusOf(inv), 'void');
  assert.equal(await totalPriceOf(p), 1000, 'syrup-only comp must not touch total_price');
  const log = await compLog(p);
  assert.equal(log.length, 1);
  assert.equal(Number(log[0].amt), 6000);
  assert.equal(log[0].actor_type, 'admin');
});

test('comp mixed add-on/bar/syrup: removes the FULL extras from total_price (submit folded syrups too)', async () => {
  // A pay-now submit WITH add-ons runs calculateProposal, which folds add-ons,
  // bar AND new syrups into total_price (pricingEngine.js:366). So the whole
  // invoice must come back out on comp, not just addon+bar. Seed total_price =
  // base 1000 + the $310 extras that submit folded in.
  const p = await seedProposal({ totalPrice: 1310 });
  const inv = await seedExtrasInvoice(p, { amountDue: 31000, lines: [
    { description: 'Champagne Toast (75 guests)', line_total: 20000, source_type: 'addon', source_id: 42 },
    { description: 'Portable Bar Rental', line_total: 5000, source_type: 'fee' },
    { description: 'Hand-Crafted Syrups (2 bottles)', line_total: 6000, source_type: 'fee' },
  ] });
  const r = await request('PATCH', `/api/invoices/${inv}`, { token: adminToken, body: { status: 'void' } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(await statusOf(inv), 'void');
  // Whole $310 (addon 200 + bar 50 + syrup 60) comes back out: 1310 -> 1000.
  assert.equal(await totalPriceOf(p), 1000);
  const log = await compLog(p);
  assert.equal(Number(log[0].amt), 31000);
});

test('void with payments applied is refused (409)', async () => {
  const p = await seedProposal({ totalPrice: 1000 });
  const inv = await seedExtrasInvoice(p, { amountDue: 6000, amountPaid: 6000, lines: [
    { description: 'Hand-Crafted Syrups', line_total: 6000, source_type: 'fee' },
  ] });
  const r = await request('PATCH', `/api/invoices/${inv}`, { token: adminToken, body: { status: 'void' } });
  assert.equal(r.status, 409, r.raw);
  assert.equal(await statusOf(inv), 'sent', 'paid invoice stays open');
});

test('helper path-switch mode (reconcileTotalPrice:false): voids but leaves total_price', async () => {
  const p = await seedProposal({ totalPrice: 1000 });
  const inv = await seedExtrasInvoice(p, { amountDue: 25000, lines: [
    { description: 'Champagne Toast (75 guests)', line_total: 20000, source_type: 'addon', source_id: 42 },
    { description: 'Portable Bar Rental', line_total: 5000, source_type: 'fee' },
  ] });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await voidExtrasInvoiceWithReconcile(inv, null, c, { reconcileTotalPrice: false, reason: 'resubmit_add_to_balance' });
    await c.query('COMMIT');
  } finally { c.release(); }
  assert.equal(await statusOf(inv), 'void');
  assert.equal(await totalPriceOf(p), 1000, 'path-switch void must NOT reduce total_price (addon flows to Balance)');
  const log = await compLog(p);
  assert.equal(log[0].reason, 'resubmit_add_to_balance');
  assert.equal(log[0].actor_type, 'system');
});
