// server/routes/stripe.invoiceIntentInFlight.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
process.env.STRIPE_TEST_MODE_UNTIL = '';

const createCalls = [];
const scripted = new Map(); // intent id -> object returned by retrieve
let retrieveFailure = null;
const fakeStripe = {
  customers: {
    retrieve: async (id) => ({ id, deleted: false }),
    create: async () => ({ id: `cus_fake_${Date.now()}` }),
  },
  paymentIntents: {
    create: async (params) => {
      createCalls.push(params);
      return { id: `pi_fake_${Date.now()}_${createCalls.length}`, client_secret: `secret_${createCalls.length}` };
    },
    retrieve: async (id) => {
      if (retrieveFailure) throw retrieveFailure;
      if (scripted.has(id)) return scripted.get(id);
      const e = new Error(`No such payment_intent: ${id}`); e.code = 'resource_missing'; throw e;
    },
  },
};
require('../utils/stripeClient').getStripe = () => fakeStripe;

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripe.invoiceIntentInFlight.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

async function seedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Invoice In Flight', $1) RETURNING id`,
    [`inv-flight-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, event_type, pricing_snapshot, stripe_customer_id, event_timezone)
     VALUES ($1, 'deposit_paid', 500, 100, 'wedding', '{}'::jsonb, 'cus_faketest', 'America/Chicago') RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedInvoice(proposalId) {
  const token = crypto.randomUUID();
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Balance', 40000, 0, 'sent') RETURNING id`,
    [proposalId, token, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  return { token, id: r.rows[0].id };
}

function post(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j, raw: b }); }); }
    );
    r.on('error', reject);
    r.write('{}');
    r.end();
  });
}

before(async () => {
  const app = express();
  app.use('/api/stripe', express.json());
  app.use('/api/stripe', stripeRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => { createCalls.length = 0; scripted.clear(); retrieveFailure = null; });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('a processing row on the proposal refuses with 409 PAYMENT_IN_FLIGHT before any Stripe call', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id)
     VALUES ($1, $2, 40000, 'processing', NOW() - INTERVAL '2 days', $3)`,
    [p, `pi_${NONCE}_proc`, inv.id]
  );
  const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'PAYMENT_IN_FLIGHT');
  assert.match(r.body.error, /\$400\.00 payment for this event has been processing since/);
  assert.equal(createCalls.length, 0);
});

test('a processing payment for ANOTHER invoice on the same proposal still blocks (D3)', async () => {
  const p = await seedProposal();
  const target = await seedInvoice(p);
  const other = await seedInvoice(p);
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id)
     VALUES ($1, $2, 40000, 'processing', NOW(), $3)`,
    [p, `pi_${NONCE}_otherinv`, other.id]
  );
  const r = await post(`/api/stripe/create-intent-for-invoice/${target.token}`);
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'PAYMENT_IN_FLIGHT');
});

test('a pending row that Stripe reports processing refuses (backstop), succeeded too, requires_payment_method mints', async () => {
  for (const status of ['processing', 'succeeded']) {
    const p = await seedProposal();
    const inv = await seedInvoice(p);
    const id = `pi_${NONCE}_${status}`;
    await pool.query(
      `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status) VALUES ($1, $2, 40000, 'pending')`, [p, id]
    );
    scripted.set(id, { id, status, amount: 40000, created: Math.floor(Date.now() / 1000) });
    const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
    assert.equal(r.status, 409, `${status}: ${r.raw}`);
    assert.equal(r.body.code, 'PAYMENT_IN_FLIGHT');
    assert.equal(createCalls.length, 0);
  }
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  const id = `pi_${NONCE}_rpm`;
  await pool.query(`INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status) VALUES ($1, $2, 40000, 'pending')`, [p, id]);
  scripted.set(id, { id, status: 'requires_payment_method', amount: 40000 });
  const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
  assert.equal(r.status, 200, r.raw);
  assert.equal(createCalls.length, 1);
});

// 502, not the 503 the plan names: ExternalServiceError has always been 502
// here (errors.js), and stripe.chargeBalanceDurable asserts 502 on the same
// fail-closed Stripe read. The behavior D7 requires is what is asserted.
test('a Stripe outage on the backstop read is a 502, never a fresh intent (D7)', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  await pool.query(`INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status) VALUES ($1, $2, 40000, 'pending')`, [p, `pi_${NONCE}_outage`]);
  retrieveFailure = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
  assert.equal(r.status, 502, r.raw);
  assert.equal(createCalls.length, 0);
});

test('with nothing in flight the rail mints and the session row carries invoice_id', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
  assert.equal(r.status, 200, r.raw);
  assert.ok(r.body.clientSecret);
  assert.equal(createCalls[0].metadata.invoice_id, String(inv.id));
  const sess = (await pool.query('SELECT invoice_id, status FROM stripe_sessions WHERE proposal_id = $1', [p])).rows[0];
  assert.equal(Number(sess.invoice_id), inv.id);
  assert.equal(sess.status, 'pending');
});

test('a paid invoice answers ALREADY_PAID even with a payment in flight on the proposal (guard order)', async () => {
  const p = await seedProposal();
  const token = crypto.randomUUID();
  await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Balance', 40000, 40000, 'partially_paid')`,
    [p, token, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 40000, 'processing', NOW())`,
    [p, `pi_${NONCE}_paidinv`]
  );
  const r = await post(`/api/stripe/create-intent-for-invoice/${token}`);
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'ALREADY_PAID');
});

test('a fresh invoice intent carries payment_method_types card, link, us_bank_account', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  const r = await post(`/api/stripe/create-intent-for-invoice/${inv.token}`);
  assert.equal(r.status, 200, r.raw);
  assert.deepEqual(createCalls[0].payment_method_types, ['card', 'link', 'us_bank_account']);
});
