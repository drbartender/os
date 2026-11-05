// The public invoice page and the contract invoices (audit PAY-02, 2026-11-05).
//
// THE DEFECT. The send-time Deposit (or Full Payment) invoice is minted 'sent'
// the moment the proposal goes out, and POST /api/stripe/create-intent-for-
// invoice/:token checked only the invoice status and the archived guard, so a
// client could pay the deposit from the invoice page BEFORE signing the
// agreement on the proposal page (the portal rendered "Pay balance" on an
// unbooked proposal, and the admin panel offered Resend on the Deposit
// invoice). The webhook then credited the money without converting the row.
//
// THE RULE. A contract invoice (Deposit, Balance, Full Payment) is payable from
// the invoice page only once the booking exists (status in BOOKED_STATUSES);
// before that the route refuses with 409 CONTRACT_INVOICE_NOT_BOOKED and
// points the client at the proposal page, the sign-and-pay rail. A booked row
// stays payable even without an online signature: an admin-recorded deposit
// or a Payment Link deposit books a proposal with client_signed_at NULL, and
// the Balance invoice is the only online rail for its balance.
//
// PURE: the pool is stubbed on the shared pool object (the sms.status.test.js
// pattern); Stripe through the getStripe seam before stripe.js destructures it.
//
//   node --test server/routes/stripe.invoiceIntentContract.test.js
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

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');

const PROPOSAL_TOKEN = crypto.randomUUID();
// The invoice row the route reads, by invoice token: label and proposal status
// are the two inputs the gate decides on.
const invoices = new Map();
function invoiceRow(label, proposalStatus, { clientSignedAt = null, amountDue = 10000, amountPaid = 0 } = {}) {
  const token = crypto.randomUUID();
  invoices.set(token, {
    invoice_id: 77, invoice_number: 'INV-0077', amount_due: amountDue, amount_paid: amountPaid, invoice_status: 'sent',
    label, proposal_id: 4242, proposal_status: proposalStatus, proposal_token: PROPOSAL_TOKEN,
    client_signed_at: clientSignedAt, event_type: 'wedding', event_type_custom: null,
    stripe_customer_id: 'cus_fixture', event_timezone: 'America/Chicago',
    client_email: 'invoice-contract@example.com', client_name: 'Client',
  });
  return token;
}

let server, baseUrl, realQuery;

before(async () => {
  realQuery = pool.query;
  pool.query = async function stubbed(text, params) {
    if (/FROM invoices i/.test(text) && /i\.token = \$1/.test(text)) {
      const row = invoices.get(params[0]);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
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

function post(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': 2 } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject); r.write('{}'); r.end();
  });
}

test('the Deposit invoice of a sent (unsigned) proposal is refused with 409 and no Stripe call, pointing at the proposal page', async () => {
  const token = invoiceRow('Deposit', 'sent');
  const before = createCalls.length;
  const r = await post(`/api/stripe/create-intent-for-invoice/${token}`);
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CONTRACT_INVOICE_NOT_BOOKED');
  assert.match(r.body.error, new RegExp(`/proposal/${PROPOSAL_TOKEN}`));
  assert.equal(createCalls.length, before, 'no intent minted');
});

test('the same on a viewed proposal, and on an accepted (signed, unpaid) one: the proposal page is the rail', async () => {
  for (const status of ['viewed', 'accepted']) {
    const token = invoiceRow('Deposit', status, { clientSignedAt: status === 'accepted' ? new Date() : null });
    const r = await post(`/api/stripe/create-intent-for-invoice/${token}`);
    assert.equal(r.status, 409, `${status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'CONTRACT_INVOICE_NOT_BOOKED');
  }
});

test('a Full Payment invoice on a sent proposal is refused too', async () => {
  const token = invoiceRow('Full Payment', 'sent', { amountDue: 100000 });
  const r = await post(`/api/stripe/create-intent-for-invoice/${token}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'CONTRACT_INVOICE_NOT_BOOKED');
});

test('the Balance invoice of a deposit_paid proposal with NO online signature is still payable', async () => {
  const token = invoiceRow('Balance', 'deposit_paid', { amountDue: 90000 });
  const before = createCalls.length;
  const r = await post(`/api/stripe/create-intent-for-invoice/${token}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.clientSecret);
  assert.equal(createCalls.length, before + 1);
  assert.equal(createCalls[before].amount, 90000);
  assert.equal(createCalls[before].metadata.payment_type, 'invoice');
});

test('a non-contract invoice (a manual label) on a sent proposal is unaffected by the gate', async () => {
  const token = invoiceRow('Damage fee', 'sent', { amountDue: 25000 });
  const before = createCalls.length;
  const r = await post(`/api/stripe/create-intent-for-invoice/${token}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(createCalls.length, before + 1);
});
