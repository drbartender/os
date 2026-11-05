// Admin charge-balance after a syrup-only Drink Plan Extras payment (audit
// PAY-01, 2026-11-05).
//
// THE DEFECT. POST /api/stripe/charge-balance/:id charged
// total_price - amount_paid. A syrup-only extras payment sits in amount_paid
// but not in total_price (submit.js fast path), so the manual balance charge
// came up short by the syrup money: contract 100000, deposit 10000, syrups
// 6000 -> charged 84000, not 90000.
//
// PURE: the pool is stubbed on the shared pool object (sms.status.test.js
// pattern) so the auth lookup, the atomic claim and the netting reads answer
// from fixtures; Stripe through the getStripe seam; the durable-charge helpers
// on their module before stripe.js destructures them at load.
//
//   node --test server/routes/stripe.chargeBalanceNetting.test.js
process.env.SEND_NOTIFICATIONS = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'charge-balance-netting-test-secret';

const durable = require('../utils/autopayDurableCharge');
const recorded = [];
durable.recordBalanceIntent = async (args) => { recorded.push(args); };
durable.priorBalanceChargeSettling = async () => ({ skip: false });

const createCalls = [];
require('../utils/stripeClient').getStripe = () => ({
  paymentIntents: {
    create: async (params) => {
      createCalls.push(params);
      return { id: `pi_fake_${createCalls.length}`, status: 'succeeded' };
    },
  },
});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');

const ADMIN = { id: 9001, email: 'charge-balance-netting@example.com', role: 'admin', onboarding_status: 'approved', can_hire: true, can_staff: true, token_version: 0, pre_hired: false, presence_lead_rank: null };
const CLAIM_ROW = {
  id: 4242, total_price: '1000.00', amount_paid: '160.00',
  stripe_customer_id: 'cus_fixture', stripe_payment_method_id: 'pm_fixture',
  autopay_enrolled: true, status: 'deposit_paid', event_type: 'wedding', event_type_custom: null,
  balance_due_date: new Date('2026-06-10T00:00:00Z'),
};

let server, baseUrl, realQuery;
const queries = [];

before(async () => {
  realQuery = pool.query;
  pool.query = async function stubbed(text, params) {
    queries.push({ text, params });
    if (/FROM users WHERE id = \$1/.test(text)) return { rows: [ADMIN], rowCount: 1 };
    if (/SET autopay_status = 'in_progress'/.test(text)) return { rows: [CLAIM_ROW], rowCount: 1 };
    // The netting read: one paid, locked, syrup-only extras invoice (cents).
    if (/FROM invoices/.test(text) && /amount_paid > 0/.test(text)) {
      return { rows: [{ id: 77, label: 'Drink Plan Extras', amount_paid: 6000 }], rowCount: 1 };
    }
    if (/FROM invoice_line_items/.test(text)) {
      return { rows: [
        { line_total: 3000, source_type: 'fee', description: 'Blackberry syrup' },
        { line_total: 3000, source_type: 'fee', description: 'Vanilla syrup' },
      ], rowCount: 2 };
    }
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

function post(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': 0 } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject); r.end();
  });
}

test('charge-balance charges the contract balance net of the syrup money: 100000 - 16000 + 6000 = 90000', async () => {
  const token = jwt.sign({ userId: ADMIN.id, tokenVersion: 0 }, process.env.JWT_SECRET);
  const r = await post('/api/stripe/charge-balance/4242', token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount, 90000);
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].amount, 90000);
  assert.equal(createCalls[0].metadata.payment_type, 'balance');
  assert.equal(recorded[0].amountCents, 90000, 'the durable intent record carries the same figure');
  assert.ok(queries.some((q) => /FROM invoices/.test(q.text) && q.params && q.params[0] === 4242),
    'the netting read is keyed on the claimed proposal');
});
