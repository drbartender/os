// Autopay is part of the deposit intent's identity (audit PAY-03, 2026-11-05).
//
// THE DEFECT. The page mints the deposit intent on load with autopay false,
// then the client ticks "Automatically pay the remaining balance" and the page
// asks again with autopay true. create-intent reused the pending metadata-less
// intent at the same amount regardless of the election, so setup_future_usage
// was never set and autopay_enrolled kept the first request's false; the
// webhook then saved no card (it saves only WHERE autopay_enrolled = true) and
// the client who expected autopay was chased by the non-autopay ladder and
// never auto-charged. Now a pending intent is reused only when its
// setup_future_usage agrees with the request; otherwise it is cancelled and a
// fresh one minted with the right setup_future_usage and autopay_enrolled.
//
// PURE: the pool is stubbed on the shared pool object (the sms.status.test.js
// pattern), Stripe through the getStripe seam before the router is required.
// The DB-backed siblings of these two cases live in stripeCreateIntent.test.js.
//
//   node --test server/routes/stripeCreateIntent.autopayIdentity.test.js
process.env.SEND_NOTIFICATIONS = 'false';
process.env.STRIPE_TEST_MODE_UNTIL = '';

const createCalls = [];
const cancelCalls = [];
let pendingIntent = null; // what Stripe reports for the pending intent
require('../utils/stripeClient').getStripe = () => ({
  customers: { retrieve: async (id) => ({ id, deleted: false }), create: async () => ({ id: 'cus_fake_new' }) },
  paymentIntents: {
    create: async (params) => { createCalls.push(params); return { id: `pi_fake_${createCalls.length}`, client_secret: `secret_${createCalls.length}` }; },
    retrieve: async (id) => {
      if (pendingIntent && pendingIntent.id === id) return pendingIntent;
      const e = new Error(`No such payment_intent: ${id}`); e.code = 'resource_missing'; throw e;
    },
    cancel: async (id) => { cancelCalls.push(id); return { id, status: 'canceled' }; },
  },
});

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');

const TOKEN = crypto.randomUUID();
const inSixtyDays = new Date(Date.now() + 60 * 86400000);
const PROPOSAL = {
  id: 4242, status: 'viewed', event_type: 'wedding', event_type_custom: null, total_price: '450.00',
  event_date: inSixtyDays, event_start_time: '18:00', event_duration_hours: 5,
  stripe_customer_id: 'cus_fixture', deposit_amount: '100.00', gratuity_floor_rate: 0,
  pricing_snapshot: { total: 450, staffing: { actual: 1 }, staff_noun: 'bartender',
    gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 5, staff_noun: 'bartender', total: 0 } },
  event_timezone: 'America/Chicago', client_email: 'autopay-identity@example.com', client_name: 'Client',
};

let server, baseUrl, realQuery;
const proposalUpdates = [];

before(async () => {
  realQuery = pool.query;
  pool.query = async function stubbed(text, params) {
    if (/FROM proposals p/.test(text) && /WHERE p\.token = \$1/.test(text)) return { rows: [PROPOSAL], rowCount: 1 };
    // The in-flight guard's read, then the reuse branch's read: both name the pending intent.
    if (/FROM stripe_sessions/.test(text) && /status = 'processing'/.test(text)) {
      return { rows: pendingIntent ? [{ stripe_payment_intent_id: pendingIntent.id, status: 'pending', amount_cents: 10000, processing_at: null }] : [], rowCount: pendingIntent ? 1 : 0 };
    }
    if (/SELECT stripe_payment_intent_id, amount FROM stripe_sessions/.test(text)) {
      return { rows: pendingIntent ? [{ stripe_payment_intent_id: pendingIntent.id, amount: 10000 }] : [], rowCount: pendingIntent ? 1 : 0 };
    }
    if (/UPDATE proposals/.test(text) && /autopay_enrolled = \$2/.test(text)) { proposalUpdates.push(params); return { rows: [], rowCount: 1 }; }
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

beforeEach(() => { createCalls.length = 0; cancelCalls.length = 0; proposalUpdates.length = 0; });

function post(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl}/api/stripe/create-intent/${TOKEN}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject); r.write(payload); r.end();
  });
}

const pending = (setupFutureUsage) => ({
  id: 'pi_pending', status: 'requires_payment_method', amount: 10000, client_secret: 'secret_pending',
  metadata: {}, setup_future_usage: setupFutureUsage,
});

test('ticking autopay after the load-time mint: the no-autopay intent is cancelled and a fresh one minted with setup_future_usage and autopay_enrolled true', async () => {
  pendingIntent = pending(null);
  const r = await post({ payment_option: 'deposit', autopay: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(cancelCalls, ['pi_pending'], 'the stale intent is cancelled');
  assert.equal(createCalls.length, 1, 'a fresh intent is minted');
  assert.equal(createCalls[0].setup_future_usage, 'off_session');
  assert.equal(createCalls[0].amount, 10000);
  assert.equal(r.body.clientSecret, 'secret_1', 'the page gets the fresh secret');
  assert.equal(proposalUpdates.length, 1);
  assert.equal(proposalUpdates[0][1], true, 'autopay_enrolled true');
});

test('unticking autopay: the off_session intent is cancelled and a fresh one minted without it, autopay_enrolled false', async () => {
  pendingIntent = pending('off_session');
  const r = await post({ payment_option: 'deposit', autopay: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(cancelCalls, ['pi_pending']);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].setup_future_usage, undefined);
  assert.equal(proposalUpdates[0][1], false, 'autopay_enrolled false');
});

test('a pending intent whose setup_future_usage agrees with the request is still reused (no cancel, no mint)', async () => {
  pendingIntent = pending('off_session');
  const r = await post({ payment_option: 'deposit', autopay: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.clientSecret, 'secret_pending', 'reused');
  assert.deepEqual(cancelCalls, []);
  assert.equal(createCalls.length, 0);
  assert.equal(proposalUpdates.length, 0, 'nothing written on a reuse');
});

test('the existing behaviour stands: a metadata-less, no-autopay intent is reused for a no-autopay request', async () => {
  pendingIntent = pending(null);
  const r = await post({ payment_option: 'deposit' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.clientSecret, 'secret_pending');
  assert.deepEqual(cancelCalls, []);
  assert.equal(createCalls.length, 0);
});
