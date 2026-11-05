// The drink-plan rail decides "past due" by the Chicago calendar day (audit
// PAY-07, 2026-11-05).
//
// THE DEFECT. create-drink-plan-intent compared the current instant with the
// balance due DATE read back as a JS Date at the process's local midnight,
// which under the production GMT session is 00:00 UTC, i.e. 19:00 Chicago the
// evening before. So from the prior evening and for the whole due day the rail
// called the balance past due, hid the extras-only choice and forced the
// client to pay the extras plus the entire balance to submit the plan, a day
// before the scheduler charged it and the reminders called it due (both of
// which use the Chicago calendar day). Now the due day, and the event_date
// minus 14 default, are calendar strings compared with chicagoTodayYmd().
//
// PURE and pinned to TZ=UTC in-process (the production shape): the pool is
// stubbed on the shared pool object, Stripe through the getStripe seam. The
// fixture's balance_due_date is the Chicago day of the run, as pg hands the
// column back.
//
//   TZ=UTC node --test server/routes/stripe.drinkPlanIntentDueDay.test.js
process.env.TZ = 'UTC';
process.env.SEND_NOTIFICATIONS = 'false';
process.env.STRIPE_TEST_MODE_UNTIL = '';

const createCalls = [];
require('../utils/stripeClient').getStripe = () => ({
  customers: { retrieve: async (id) => ({ id, deleted: false }), create: async () => ({ id: 'cus_fake_new' }) },
  paymentIntents: {
    create: async (params) => { createCalls.push(params); return { id: `pi_fake_${createCalls.length}`, client_secret: `secret_${createCalls.length}` }; },
    retrieve: async (id) => { const e = new Error(`No such payment_intent: ${id}`); e.code = 'resource_missing'; throw e; },
  },
});

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { chicagoTodayYmd } = require('../utils/businessTime');
const stripeRouter = require('./stripe');

const TOKEN = crypto.randomUUID();
// A pg DATE arrives as a JS Date at the process-local midnight of that
// calendar day; under TZ=UTC that is 00:00 UTC.
const localMidnight = (ymd) => new Date(`${ymd}T00:00:00`);
const shift = (ymd, days) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

let plan;
function seed(over = {}) {
  plan = {
    plan_id: 77, plan_token: TOKEN, plan_status: 'draft', proposal_id: 4242, proposal_status: 'deposit_paid',
    total_price: '1000.00', amount_paid: '100.00', event_date: localMidnight(shift(chicagoTodayYmd(), 40)),
    balance_due_date: localMidnight(chicagoTodayYmd()), guest_count: 75, num_bars: 0, stripe_customer_id: 'cus_fixture',
    event_type: 'wedding', event_type_custom: null, pricing_snapshot: { syrups: { selections: [] } }, event_timezone: 'America/Chicago',
    client_email: 'due-day@example.com', client_name: 'Client',
    ...over,
  };
}

let server, baseUrl, realQuery;
before(async () => {
  realQuery = pool.query;
  pool.query = async function stubbed(text) {
    if (/FROM drink_plans dp/.test(text) && /WHERE dp\.token = \$1/.test(text)) return { rows: [plan], rowCount: 1 };
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
beforeEach(() => { createCalls.length = 0; seed(); });

const SYRUPS = { syrupSelections: { d1: ['blackberry', 'vanilla-bean'] }, syrupSelfProvided: [], addOns: {}, logistics: { addBarRental: false } };
function post(body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const u = new URL(`${baseUrl}/api/stripe/create-drink-plan-intent/${TOKEN}`);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject); r.write(payload); r.end();
  });
}

test('a balance due TODAY (Chicago) is not past due: the extras-only choice stays and the balance option is offered', async () => {
  assert.equal(process.env.TZ, 'UTC');
  const r = await post({ selections: SYRUPS, paymentChoice: 'extras_only' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paymentScenario, 'extras_optional');
  assert.equal(r.body.balanceOptionAvailable, true);
  assert.equal(r.body.pastDueAmount, 0);
  assert.equal(createCalls[0].metadata.payment_type, 'drink_plan_extras');
  assert.equal(createCalls[0].amount, Math.round(r.body.extrasAmount * 100), 'extras only');
});

test('a balance due YESTERDAY is past due: extras plus the balance', async () => {
  seed({ balance_due_date: localMidnight(shift(chicagoTodayYmd(), -1)) });
  const r = await post({ selections: SYRUPS, paymentChoice: 'extras_only' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paymentScenario, 'extras_plus_balance');
  assert.equal(r.body.balanceOptionAvailable, false);
  assert.equal(r.body.pastDueAmount, 900);
  assert.equal(createCalls[0].metadata.payment_type, 'drink_plan_with_balance');
});

test('no due date: the default is the event day minus 14, as a calendar day (due today when the event is in 14 days)', async () => {
  seed({ balance_due_date: null, event_date: localMidnight(shift(chicagoTodayYmd(), 14)) });
  const r = await post({ selections: SYRUPS, paymentChoice: 'extras_only' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paymentScenario, 'extras_optional', 'due today is not past due');
  assert.equal(r.body.balanceOptionAvailable, true);
});

test('no due date, event in 13 days: the default due day was yesterday, so the balance is past due', async () => {
  seed({ balance_due_date: null, event_date: localMidnight(shift(chicagoTodayYmd(), 13)) });
  const r = await post({ selections: SYRUPS, paymentChoice: 'extras_only' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.paymentScenario, 'extras_plus_balance');
});
