// The portal Receipts list hides an unpaid contract invoice its proposal
// cannot take (audit PAY-02, the fourth place the open invoice is handed out).
//
// THE DEFECT. The booked gate reached the portal home, the drill-down and the
// public payload, but GET /invoices/client/:proposalToken still listed an
// unbooked proposal's send-time Deposit invoice, so Receipts offered Open and
// Share on an invoice whose Pay button the server refuses on every tap. The
// list now leaves out a sent or partially paid Deposit, Balance or Full
// Payment invoice unless the proposal is booked
// (stripeRouteHelpers.contractInvoicePayable); a paid one is a receipt and
// stays.
//
// DB-BACKED: run alone against the shared dev DB.
//
//   node --test server/routes/invoices.clientReceiptsGate.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const invoicesRouter = require('./invoices');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoices.clientReceiptsGate.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, clientId, clientToken;
const proposalIds = [];

async function seed(status, { signed = false, invoices }) {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, event_type, client_signed_at)
     VALUES ($1, $2, 1000, 0, 'wedding', $3) RETURNING id, token`,
    [clientId, status, signed ? new Date() : null]
  );
  proposalIds.push(p.rows[0].id);
  let n = 0;
  for (const inv of invoices) {
    n += 1;
    await pool.query(
      `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.rows[0].id, `RG${p.rows[0].id}-${n}${crypto.randomBytes(2).toString('hex')}`, inv.label, inv.amountDue, inv.amountPaid || 0, inv.status]
    );
  }
  return p.rows[0].token;
}

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET', headers: { Authorization: `Bearer ${clientToken}` } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j, raw: b }); }); }
    );
    r.on('error', reject);
    r.end();
  });
}

const labelsOf = (r) => r.body.invoices.map((i) => `${i.label}:${i.status}`).sort();

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, token_version) VALUES ('Receipts Gate Test', $1, 0) RETURNING id`,
    [`receipts-gate-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  clientToken = jwt.sign({ id: clientId, email: 'x@x', role: 'client', tokenVersion: 0 }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/invoices', invoicesRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [proposalIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('a sent, unsigned proposal: its send-time Deposit invoice is not listed, a manual invoice still is', async () => {
  const token = await seed('sent', { invoices: [
    { label: 'Deposit', amountDue: 10000, status: 'sent' },
    { label: 'Rush fee', amountDue: 5000, status: 'sent' },
  ] });
  const r = await get(`/api/invoices/client/${token}`);
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(labelsOf(r), ['Rush fee:sent']);
});

test('a signed but unpaid (accepted) proposal: the proposal page is the rail, so the Deposit invoice stays off', async () => {
  const token = await seed('accepted', { signed: true, invoices: [{ label: 'Deposit', amountDue: 10000, status: 'sent' }] });
  const r = await get(`/api/invoices/client/${token}`);
  assert.deepEqual(labelsOf(r), []);
});

test('an accepted proposal with no signature (an offline acceptance) lists no unpaid Deposit either: it pays through the admin Payment Link', async () => {
  const token = await seed('accepted', { invoices: [{ label: 'Deposit', amountDue: 10000, status: 'sent' }] });
  const r = await get(`/api/invoices/client/${token}`);
  assert.deepEqual(labelsOf(r), []);
});

test('a booked proposal lists its paid Deposit receipt and its open Balance', async () => {
  const token = await seed('deposit_paid', { signed: true, invoices: [
    { label: 'Deposit', amountDue: 10000, amountPaid: 10000, status: 'paid' },
    { label: 'Balance', amountDue: 90000, status: 'sent' },
  ] });
  const r = await get(`/api/invoices/client/${token}`);
  assert.deepEqual(labelsOf(r), ['Balance:sent', 'Deposit:paid']);
});

test('a paid contract invoice on an unbooked row is a receipt and stays listed', async () => {
  const token = await seed('sent', { invoices: [{ label: 'Deposit', amountDue: 10000, amountPaid: 10000, status: 'paid' }] });
  const r = await get(`/api/invoices/client/${token}`);
  assert.deepEqual(labelsOf(r), ['Deposit:paid']);
});
