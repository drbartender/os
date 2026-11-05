// A syrup-only Drink Plan Extras payment and every balance that follows it
// (audit PAY-01, 2026-11-05). DB-BACKED: run alone against the shared dev DB.
//
//   node --test server/routes/stripe.syrupBalance.test.js
//
// THE DEFECT. The syrup-only fast path (routes/drinkPlans/submit.js) mints a
// "Drink Plan Extras" invoice and never touches total_price ("syrups are
// additive money that never fold into total_price"); the webhook's
// drink_plan_extras branch then rolls the captured money into amount_paid.
// Every balance derivation that read total_price - amount_paid was short by the
// syrup money from that moment: the admin charge-balance, the autopay charge,
// the refreshed Balance invoice (its lockedTotal counted the locked extras
// invoice), the proposal page and the portal. The report's cents: contract
// 100000, deposit 10000, syrups 6000 -> 90000 is still owed, 84000 was charged.
//
// Stripe is faked through the getStripe seam before the router is required
// (stripe.js destructures it at load); the fake records every intent created.
// The webhook is signed locally with a known secret (the extrasLink pattern).
// The autopay fixture carries 1999 dates, as balanceScheduler.chicagoDay.test.js
// does, so the UNSCOPED autopay claim can match nothing real on the dev DB.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const WEBHOOK_SECRET = 'whsec_test_syrupbalance';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const createCalls = [];
require('../utils/stripeClient').getStripe = () => ({
  customers: { retrieve: async (id) => ({ id, deleted: false }), create: async () => ({ id: `cus_fake_${Date.now()}` }) },
  paymentIntents: {
    create: async (params) => { createCalls.push(params); return { id: `pi_fake_${Date.now()}_${createCalls.length}`, status: 'succeeded', client_secret: 'secret' }; },
    retrieve: async (id) => { const e = new Error(`No such payment_intent: ${id}`); e.code = 'resource_missing'; throw e; },
  },
});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');
const publicTokenRouter = require('./proposals/publicToken');
const clientPortalRouter = require('./clientPortal');
const balanceScheduler = require('../utils/balanceScheduler');
const { refreshUnlockedInvoices } = require('../utils/invoiceLifecycle');
const { chicagoTodayYmd } = require('../utils/businessTime');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripe.syrupBalance.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminEmail, adminToken;
const proposalIds = [];
const clientIds = [];

function sign(payloadStr) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payloadStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

// The report's row: deposit_paid, total 1000, deposit 100 paid, a locked
// Deposit invoice and an open Balance invoice at 90000, a drink plan, and the
// submit-minted syrup-only extras invoice (6000, two syrup lines, unpaid).
async function seed({ eventDate, balanceDueDate }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('Syrup Balance', $1, 'ok') RETURNING id, email`,
    [`syrup-balance-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, deposit_amount,
                            guest_count, num_bars, pricing_snapshot, event_date, balance_due_date,
                            autopay_enrolled, stripe_customer_id, stripe_payment_method_id, token)
     VALUES ($1, 'deposit_paid', 'wedding', 1000, 100, 100, 75, 0, '{"total": 1000}'::jsonb,
             $2::date, $3::date, true, 'cus_fixtureNeverCharged', 'pm_fixtureNeverCharged', gen_random_uuid())
     RETURNING id, token`,
    [c.rows[0].id, eventDate, balanceDueDate]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const inv = async (label, due, paid, status, locked) => (await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, label, due, paid, status, locked]
  )).rows[0].id;
  await inv('Deposit', 10000, 10000, 'paid', true);
  const balanceId = await inv('Balance', 90000, 0, 'sent', false);
  const extrasId = await inv('Drink Plan Extras', 6000, 0, 'sent', false);
  for (const [name, cents] of [['Blackberry syrup', 3000], ['Vanilla syrup', 3000]]) {
    await pool.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type)
       VALUES ($1, $2, 1, $3, $3, 'fee')`,
      [extrasId, name, cents]
    );
  }
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections) VALUES ($1, 'submitted', '{}'::jsonb) RETURNING id`,
    [proposalId]
  );
  return { proposalId, token: p.rows[0].token, clientId: c.rows[0].id, clientEmail: c.rows[0].email, balanceId, extrasId, drinkPlanId: dp.rows[0].id };
}

function postWebhook(eventObj) {
  const payload = JSON.stringify(eventObj);
  const sig = sign(payload);
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/stripe/webhook');
    const buf = Buffer.from(payload);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'stripe-signature': sig } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    r.on('error', reject); r.write(buf); r.end();
  });
}

function request(method, path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': 0, ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j, raw: b }); }); }
    );
    r.on('error', reject); r.end();
  });
}

// The syrup-only extras payment lands: amount_paid 160, extras invoice paid+locked.
async function paySyrups(f) {
  const r = await postWebhook({
    id: `evt_${NONCE}_${f.proposalId}`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_${f.proposalId}`, amount: 6000,
      metadata: { proposal_id: String(f.proposalId), payment_type: 'drink_plan_extras',
        extras_amount_cents: '6000', balance_amount_cents: '0', drink_plan_id: String(f.drinkPlanId) } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);
  const row = (await pool.query('SELECT amount_paid, total_price FROM proposals WHERE id = $1', [f.proposalId])).rows[0];
  assert.equal(Number(row.amount_paid), 160, 'the syrup money rolled into amount_paid');
  assert.equal(Number(row.total_price), 1000, 'and never into total_price');
  const ex = (await pool.query('SELECT status, locked, amount_paid FROM invoices WHERE id = $1', [f.extrasId])).rows[0];
  assert.equal(ex.status, 'paid');
  assert.equal(ex.locked, true);
}

before(async () => {
  adminEmail = `syrup-balance-admin-${NONCE}@example.com`;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version) VALUES ($1, 'x', 'admin', 0) RETURNING id, token_version`,
    [adminEmail]
  );
  adminToken = jwt.sign({ userId: u.rows[0].id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET);

  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  app.use('/api/proposals', publicTokenRouter);
  app.use('/api/client-portal', clientPortalRouter);
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
  await new Promise((r) => setTimeout(r, 400));
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', ids]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.query('DELETE FROM users WHERE email = $1', [adminEmail]);
  await pool.end();
});

test('charge-balance, the refreshed Balance invoice, the proposal page and the portal all read 90000 after the syrups are paid', async () => {
  const f = await seed({ eventDate: chicagoTodayYmd().replace(/^\d{4}/, (y) => String(Number(y) + 1)), balanceDueDate: chicagoTodayYmd() });
  await paySyrups(f);

  // The refreshed Balance invoice: the locked, paid syrup-only extras invoice
  // must not shrink it (it did: 100000 - 0 - (10000 + 6000) = 84000).
  await refreshUnlockedInvoices(f.proposalId);
  const bal = (await pool.query('SELECT amount_due FROM invoices WHERE id = $1', [f.balanceId])).rows[0];
  assert.equal(Number(bal.amount_due), 90000, 'Balance invoice stays at the contract balance');

  // The proposal page's payload carries the netted balance in dollars.
  const page = await request('GET', `/api/proposals/t/${f.token}`);
  assert.equal(page.status, 200, page.raw);
  assert.equal(page.body.balance_due, 900);
  assert.equal(page.body.amount_paid, 160);

  // The portal: /home focus and the drill-down detail.
  const clientJwt = jwt.sign({ id: f.clientId, email: f.clientEmail, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const home = await request('GET', '/api/client-portal/home', clientJwt);
  assert.equal(home.status, 200, home.raw);
  assert.ok(home.body.focus, 'the booked proposal is the focus');
  assert.equal(home.body.focus.balance_due, 900);
  const detail = await request('GET', `/api/client-portal/proposals/${f.token}`, clientJwt);
  assert.equal(detail.status, 200, detail.raw);
  assert.equal(detail.body.proposal.balance_due, 900);

  // The admin's manual balance charge.
  const before = createCalls.length;
  const r = await request('POST', `/api/stripe/charge-balance/${f.proposalId}`, adminToken);
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.amount, 90000);
  assert.equal(createCalls.length, before + 1);
  assert.equal(createCalls[before].amount, 90000);
});

test('the autopay scheduler charges 90000 for the same shape', async () => {
  const f = await seed({ eventDate: '1999-04-01', balanceDueDate: '1999-03-02' });
  await paySyrups(f);

  const before = createCalls.length;
  balanceScheduler.__setDeps({ today: () => '1999-03-02' });
  try {
    await balanceScheduler.processAutopayCharges();
  } finally {
    balanceScheduler.__setDeps({ today: chicagoTodayYmd });
  }
  const mine = createCalls.slice(before).filter((c) => c.metadata && c.metadata.proposal_id === String(f.proposalId));
  assert.equal(mine.length, 1, 'one balance intent for the fixture');
  assert.equal(mine[0].amount, 90000);
});
