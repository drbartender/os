require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Override the webhook secret to a known value so the test can sign events the handler's
// constructEvent will verify (Stripe signature check is local HMAC — no API call). Set
// BEFORE the router handles requests; the handler reads these env vars per-request.
const WEBHOOK_SECRET = 'whsec_test_invoicelink';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.invoiceLink.test.js refuses to run against production');
}

// Audit sec-webhooks (proposal_id cross-check): the payment_intent.succeeded `invoice`
// branch linked a payment to the metadata `invoice_id` with NO check that the invoice
// belongs to the metadata `proposal_id` — unlike every other branch, which derives the
// invoice from proposal_id. Proves a mismatched invoice is never credited, and a matching
// invoice still is.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const invoiceIds = [];
const clientIds = [];

function sign(payloadStr) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payloadStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

async function seedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('WH Test', $1) RETURNING id`,
    [`wh-invlink-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price) VALUES ($1, 'sent', 100) RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedInvoice(proposalId) {
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, amount_due, status) VALUES ($1, $2, 10000, 'sent') RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  invoiceIds.push(inv.rows[0].id);
  return inv.rows[0].id;
}

async function invoiceState(id) {
  const r = await pool.query('SELECT amount_paid, status FROM invoices WHERE id = $1', [id]);
  const links = await pool.query('SELECT COUNT(*)::int AS n FROM invoice_payments WHERE invoice_id = $1', [id]);
  return { amount_paid: r.rows[0].amount_paid, status: r.rows[0].status, links: links.rows[0].n };
}

before(async () => {
  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (invoiceIds.length) await pool.query('DELETE FROM invoice_payments WHERE invoice_id = ANY($1::int[])', [invoiceIds]);
  if (proposalIds.length) {
    await pool.query('DELETE FROM invoice_payments WHERE payment_id IN (SELECT id FROM proposal_payments WHERE proposal_id = ANY($1::int[]))', [proposalIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

function postWebhook(eventObj) {
  const payload = JSON.stringify(eventObj);
  const sig = sign(payload);
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/stripe/webhook');
    const buf = Buffer.from(payload);
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'stripe-signature': sig },
      },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

test('invoice payment does NOT link to an invoice belonging to a different proposal', async () => {
  const p1 = await seedProposal();   // proposal named in the intent metadata
  const p2 = await seedProposal();   // owns the invoice
  const inv = await seedInvoice(p2); // belongs to p2, NOT p1
  const r = await postWebhook({
    id: `evt_${NONCE}_mismatch`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_mismatch`, amount: 5000,
      metadata: { proposal_id: String(p1), payment_type: 'invoice', invoice_id: String(inv) } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);
  const st = await invoiceState(inv);
  assert.equal(st.amount_paid, 0, 'mismatched invoice must not be credited');
  assert.equal(st.links, 0, 'no invoice_payments link should be created for a mismatched invoice');
});

test('invoice payment DOES link to an invoice belonging to the metadata proposal', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);  // belongs to p
  const r = await postWebhook({
    id: `evt_${NONCE}_match`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_match`, amount: 5000,
      metadata: { proposal_id: String(p), payment_type: 'invoice', invoice_id: String(inv) } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);
  const st = await invoiceState(inv);
  assert.equal(st.amount_paid, 5000, 'matching invoice should be credited the captured amount');
  assert.equal(st.links, 1, 'one invoice_payments link should be created');
});
