// The deposit the checkout charges is the row's deposit_amount (audit PAY-06,
// 2026-11-05).
//
// THE DEFECT. create-intent and the admin Payment Link charged the global
// STRIPE_DEPOSIT_AMOUNT, while the Deposit invoice, the cancellation retainer
// and the compare page read the row's deposit_amount. A hand-set deposit of
// 500 on a large booking minted a 50000 Deposit invoice, said "Pay $500
// Deposit" nowhere the client paid, and charged 10000: the retainer was
// under-collected by 40000 and a client cancel more than 14 days out forfeited
// only the 10000 actually held. Both rails now charge
// stripeRouteHelpers.depositCentsFor(proposal): the row's deposit_amount, with
// STRIPE_DEPOSIT_AMOUNT only for a NULL or non-positive column.
//
// PURE: the pool is stubbed on the shared pool object (the autopayIdentity
// pattern), Stripe through the getStripe seam before the router is required.
//
//   node --test server/routes/stripeCreateIntent.depositAmount.test.js
process.env.SEND_NOTIFICATIONS = 'false';
process.env.STRIPE_TEST_MODE_UNTIL = '';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'deposit-amount-test-secret';

const createCalls = [];
const priceCalls = [];
require('../utils/stripeClient').getStripe = () => ({
  customers: { retrieve: async (id) => ({ id, deleted: false }), create: async () => ({ id: 'cus_fake_new' }) },
  paymentIntents: {
    create: async (params) => { createCalls.push(params); return { id: `pi_fake_${createCalls.length}`, client_secret: `secret_${createCalls.length}` }; },
    retrieve: async (id) => { const e = new Error(`No such payment_intent: ${id}`); e.code = 'resource_missing'; throw e; },
    cancel: async (id) => ({ id, status: 'canceled' }),
  },
  prices: { create: async (params) => { priceCalls.push(params); return { id: `price_fake_${priceCalls.length}` }; } },
  paymentLinks: {
    create: async () => ({ id: `plink_fake_${priceCalls.length}`, url: 'https://buy.stripe.test/fake' }),
    retrieve: async () => ({ active: false }),
    update: async () => ({}),
  },
});

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');

const TOKEN = crypto.randomUUID();
const ADMIN = { id: 9001, email: 'deposit-amount@example.com', role: 'admin', onboarding_status: 'approved', token_version: 0, presence_lead_rank: null };
let proposal;
function seed(over = {}) {
  proposal = {
    id: 4242, token: TOKEN, status: 'viewed', event_type: 'wedding', event_type_custom: null, total_price: '4500.00',
    event_date: new Date(Date.now() + 60 * 86400000), event_start_time: '18:00', event_duration_hours: 5,
    stripe_customer_id: 'cus_fixture', deposit_amount: '100.00', gratuity_floor_rate: 0,
    pricing_snapshot: { total: 4500, staffing: { actual: 1 }, staff_noun: 'bartender',
      gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 5, staff_noun: 'bartender', total: 0 } },
    event_timezone: 'America/Chicago', client_email: 'deposit-amount@example.com', client_name: 'Client',
    ...over,
  };
}

let server, baseUrl, realQuery;
before(async () => {
  realQuery = pool.query;
  pool.query = async function stubbed(text) {
    if (/FROM users WHERE id = \$1/.test(text)) return { rows: [ADMIN], rowCount: 1 };
    if (/FROM proposals p/.test(text) && /WHERE p\.token = \$1/.test(text)) return { rows: [proposal], rowCount: 1 };
    if (/FROM proposals WHERE id = \$1/.test(text)) return { rows: [proposal], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const app = express();
  app.use(express.json());
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
after(async () => {
  pool.query = realQuery;
  if (server) await new Promise((r) => server.close(r));
});
beforeEach(() => { createCalls.length = 0; priceCalls.length = 0; seed(); });

function post(path, body, token) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject); r.write(payload); r.end();
  });
}
const adminToken = () => jwt.sign({ userId: ADMIN.id, tokenVersion: 0 }, process.env.JWT_SECRET);

test('create-intent charges the row deposit: deposit_amount 500 -> 50000', async () => {
  seed({ deposit_amount: '500.00' });
  const r = await post(`/api/stripe/create-intent/${TOKEN}`, { payment_option: 'deposit' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].amount, 50000);
  assert.equal(createCalls[0].metadata.payment_type, 'deposit');
});

test('create-intent falls back to STRIPE_DEPOSIT_AMOUNT (10000) only for a NULL deposit_amount', async () => {
  seed({ deposit_amount: null });
  const r = await post(`/api/stripe/create-intent/${TOKEN}`, { payment_option: 'deposit' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(createCalls[0].amount, 10000);
});

test('the admin Payment Link prices the row deposit: deposit_amount 500 -> a 50000 one-time price', async () => {
  seed({ deposit_amount: '500.00' });
  const r = await post('/api/stripe/payment-link/4242', {}, adminToken());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(priceCalls.length, 1);
  assert.equal(priceCalls[0].unit_amount, 50000);
  assert.match(priceCalls[0].product_data.name, /Event Deposit/);
});

// Audit PAY-09 (2026-11-05): a contract at or below the deposit is paid in
// full in one payment; offering the deposit charged more than the contract and
// left an overpayment to refund. create-intent refuses the deposit option for
// such a row (the booking-window code, which the page already honours by
// locking the full tablet); the full option stays.
test('PAY-09: the deposit option is refused on a 75 total (409 FULL_PAYMENT_REQUIRED, no Stripe call)', async () => {
  seed({ total_price: '75.00', pricing_snapshot: { total: 75, staffing: { actual: 1 }, staff_noun: 'bartender' } });
  const r = await post(`/api/stripe/create-intent/${TOKEN}`, { payment_option: 'deposit' });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'FULL_PAYMENT_REQUIRED');
  assert.match(r.body.error, /not more than the deposit/);
  assert.equal(createCalls.length, 0);
});

test('PAY-09: the full option on the same row charges the 7500 total', async () => {
  seed({ total_price: '75.00', pricing_snapshot: { total: 75, staffing: { actual: 1 }, staff_noun: 'bartender' } });
  const r = await post(`/api/stripe/create-intent/${TOKEN}`, { payment_option: 'full' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(createCalls[0].amount, 7500);
  assert.equal(createCalls[0].metadata.payment_type, 'full');
});

test('PAY-09: the yardstick is the row deposit: a 300 total is refused against a 500 deposit and allowed against 100', async () => {
  seed({ total_price: '300.00', pricing_snapshot: { total: 300, staffing: { actual: 1 }, staff_noun: 'bartender' }, deposit_amount: '500.00' });
  assert.equal((await post(`/api/stripe/create-intent/${TOKEN}`, { payment_option: 'deposit' })).status, 409);
  seed({ total_price: '300.00', pricing_snapshot: { total: 300, staffing: { actual: 1 }, staff_noun: 'bartender' }, deposit_amount: '100.00' });
  const r = await post(`/api/stripe/create-intent/${TOKEN}`, { payment_option: 'deposit' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(createCalls[createCalls.length - 1].amount, 10000);
});
