require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
process.env.STRIPE_TEST_MODE_UNTIL = '';

// Bank debit in flight (spec 2026-09-14 section 5.1, third rail): the drink-plan
// checkout can fold a past-due balance into its charge, so a balance already
// settling by bank debit must refuse here exactly as on the invoice rail.
const createCalls = [];
const scripted = new Map();
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
  throw new Error('stripe.drinkPlanIntentInFlight.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

async function seedProposal({ balanceDueDate }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Drink Plan In Flight', $1) RETURNING id`,
    [`dp-flight-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, event_type, pricing_snapshot, stripe_customer_id, balance_due_date, event_timezone, guest_count, num_bars)
     VALUES ($1, 'deposit_paid', 500, 100, 'wedding', '{}'::jsonb, 'cus_faketest', $2, 'America/Chicago', 50, 1) RETURNING id`,
    [c.rows[0].id, balanceDueDate]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedDrinkPlan(proposalId) {
  const token = crypto.randomUUID();
  await pool.query(
    `INSERT INTO drink_plans (proposal_id, token, status, selections) VALUES ($1, $2, 'reviewed', '{}'::jsonb)`,
    [proposalId, token]
  );
  return token;
}

function postJson(path, body) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = Buffer.from(payload);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j, raw: b }); }); }
    );
    r.on('error', reject);
    r.write(buf);
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

beforeEach(() => { createCalls.length = 0; scripted.clear(); });

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

const yesterday = () => new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
const nextMonth = () => new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

test('a past-due balance with a processing row refuses 409 PAYMENT_IN_FLIGHT before any Stripe call', async () => {
  const p = await seedProposal({ balanceDueDate: yesterday() });
  const token = await seedDrinkPlan(p);
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 40000, 'processing', NOW() - INTERVAL '1 day')`,
    [p, `pi_${NONCE}_dp_proc`]
  );
  const r = await postJson(`/api/stripe/create-drink-plan-intent/${token}`, { selections: {} });
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'PAYMENT_IN_FLIGHT');
  assert.match(r.body.error, /\$400\.00 payment for this event has been processing since/);
  assert.equal(createCalls.length, 0);
});

test('a pending row that Stripe reports processing refuses too (backstop)', async () => {
  const p = await seedProposal({ balanceDueDate: yesterday() });
  const token = await seedDrinkPlan(p);
  const id = `pi_${NONCE}_dp_stripe`;
  await pool.query(`INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status) VALUES ($1, $2, 40000, 'pending')`, [p, id]);
  scripted.set(id, { id, status: 'processing', amount: 40000, created: Math.floor(Date.now() / 1000) });
  const r = await postJson(`/api/stripe/create-drink-plan-intent/${token}`, { selections: {} });
  assert.equal(r.status, 409, r.raw);
  assert.equal(r.body.code, 'PAYMENT_IN_FLIGHT');
  assert.equal(createCalls.length, 0);
});

test('a plan that owes nothing still submits while a deposit is processing (guards sit after noPaymentNeeded)', async () => {
  const p = await seedProposal({ balanceDueDate: nextMonth() });
  const token = await seedDrinkPlan(p);
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 10000, 'processing', NOW())`,
    [p, `pi_${NONCE}_dp_nopay`]
  );
  const r = await postJson(`/api/stripe/create-drink-plan-intent/${token}`, { selections: {} });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.noPaymentNeeded, true);
  assert.equal(createCalls.length, 0);
});

test('with nothing in flight a past-due balance still mints the folded charge', async () => {
  const p = await seedProposal({ balanceDueDate: yesterday() });
  const token = await seedDrinkPlan(p);
  const r = await postJson(`/api/stripe/create-drink-plan-intent/${token}`, { selections: {} });
  assert.equal(r.status, 200, r.raw);
  assert.ok(r.body.clientSecret);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].metadata.payment_type, 'drink_plan_with_balance');
  assert.deepEqual(createCalls[0].payment_method_types, ['card', 'link', 'us_bank_account']);
});
