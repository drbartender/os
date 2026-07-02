require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// Refunds under invoices: GET /t/:token includes a `refunds` array of SUCCEEDED
// refunds attributable to the invoice (via the payment its invoice_payments row
// funded). Pending/failed refunds, and refunds on payments NOT on this invoice,
// are excluded. Informational only — amount_paid / status stay the persisted
// values (a refund is money returned, not a reopened balance).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const invoicesRouter = require('./invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoices.refunds.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, clientId, proposalId, invoiceToken;

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Refund Test', $1) RETURNING id`,
    [`refund-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid) VALUES ($1, 'deposit_paid', 1000, 500) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Deposit', 50000, 50000, 'paid') RETURNING id, token`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  const invoiceId = inv.rows[0].id;
  invoiceToken = inv.rows[0].token;

  // PAY1 funds THIS invoice.
  const pay1 = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status) VALUES ($1, 'deposit', 50000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 50000)`,
    [invoiceId, pay1.rows[0].id]
  );
  // A negative reversal invoice_payments row (as refundHelpers writes on reconcile)
  // shares (invoice_id, payment_id) with the positive link, so the refunds JOIN fans
  // out to 2 rows for PAY1 — this exercises the DISTINCT in the refunds query.
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, -5000)`,
    [invoiceId, pay1.rows[0].id]
  );
  // R1 succeeded on PAY1 -> appears (once, thanks to DISTINCT). R2 pending on PAY1 -> excluded.
  await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 5000, 'Partial refund, over-served comp', 1000.00, 950.00, 'succeeded')`,
    [proposalId, pay1.rows[0].id]
  );
  await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 9999, 'Pending refund should be hidden', 1000.00, 900.00, 'pending')`,
    [proposalId, pay1.rows[0].id]
  );
  // PAY2 is NOT linked to this invoice; its SUCCEEDED refund must NOT appear here.
  const pay2 = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status) VALUES ($1, 'balance', 30000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO proposal_refunds (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 7000, 'Refund on a different invoice', 1000.00, 930.00, 'succeeded')`,
    [proposalId, pay2.rows[0].id]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  // proposal_refunds RESTRICTs proposal_payments + proposals, so delete refunds first.
  if (proposalId) {
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [proposalId]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('GET /t/:token returns only succeeded refunds attributable to this invoice', async () => {
  const r = await get(`/api/invoices/t/${invoiceToken}`);
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  const refunds = r.body.invoice.refunds;
  assert.ok(Array.isArray(refunds), 'refunds should be an array');
  assert.equal(refunds.length, 1, `expected exactly 1 refund, got ${JSON.stringify(refunds)}`);
  assert.equal(Number(refunds[0].amount), 5000, 'amount is Stripe-native cents');
  assert.equal(refunds[0].reason, undefined, 'reason is admin-only free-text, never exposed on the public invoice');
});

test('invoice amount_paid/status are unchanged by refunds (informational only)', async () => {
  const r = await get(`/api/invoices/t/${invoiceToken}`);
  assert.equal(Number(r.body.invoice.amount_paid), 50000, 'amount_paid stays the persisted value');
  assert.equal(r.body.invoice.status, 'paid', 'status is not reopened by a refund');
});
