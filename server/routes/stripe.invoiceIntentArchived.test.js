require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Deterministic Stripe mode: force "not in a test window" so nothing here depends
// on a local .env STRIPE_TEST_MODE_UNTIL. The public intent routes never verify a
// webhook secret, so this only affects the (unused) mode gate.
process.env.STRIPE_TEST_MODE_UNTIL = '';

// Fake Stripe via the getStripe seam. stripe.js AND stripeRouteHelpers.js both
// destructure getStripe at load, so the override MUST land before the router is
// required (mirrors stripe.chargeBalanceDurable.test.js). A shared paymentIntents
// .create spy proves the archived guard short-circuits BEFORE any Stripe call.
const createCalls = [];
const fakeStripe = {
  customers: {
    retrieve: async (id) => ({ id, deleted: false }),
    create: async () => ({ id: `cus_fake_${Date.now()}` }),
  },
  paymentIntents: {
    create: async (params) => {
      createCalls.push(params);
      return { id: `pi_fake_${Date.now()}_${createCalls.length}`, client_secret: `secret_${Date.now()}_${createCalls.length}` };
    },
  },
};
require('../utils/stripeClient').getStripe = () => fakeStripe;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripe.invoiceIntentArchived.test.js refuses to run against production');
}

// B3 piece 1 + 1b: the two public "mint a Stripe intent" routes never consulted
// proposals.status, so a cancelled (archived) event's invoice / drink-plan link
// stayed a live charge surface. Both now throw 409 EVENT_CANCELLED before any
// Stripe call. RED before the fix: archived seeds mint an intent (200 + spy fires).

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

async function seedProposal({ status = 'sent', totalPrice = 1000, amountPaid = 100, balanceDueDate = null } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Invoice Intent Archived', $1) RETURNING id`,
    [`inv-arch-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const archived = status === 'archived';
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, status, total_price, amount_paid, event_type, pricing_snapshot,
        stripe_customer_id, balance_due_date, archive_reason, cancelled_at)
     VALUES ($1, $2, $3, $4, 'wedding', '{}'::jsonb, 'cus_faketest', $5, $6, $7)
     RETURNING id`,
    [
      c.rows[0].id, status, totalPrice, amountPaid, balanceDueDate,
      archived ? 'client_cancelled' : null,
      archived ? new Date() : null,
    ]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedInvoice(proposalId, { status = 'partially_paid', amountDue = 50000, amountPaid = 10000 } = {}) {
  const token = crypto.randomUUID();
  await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Balance', $4, $5, $6)`,
    [proposalId, token, `INV${crypto.randomBytes(5).toString('hex')}`, amountDue, amountPaid, status]
  );
  return token;
}

async function seedDrinkPlan(proposalId, { status = 'reviewed' } = {}) {
  const token = crypto.randomUUID();
  await pool.query(
    `INSERT INTO drink_plans (proposal_id, token, status, selections) VALUES ($1, $2, $3, '{}'::jsonb)`,
    [proposalId, token, status]
  );
  return token;
}

function postJson(path, body) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = Buffer.from(payload);
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length },
      },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const createdForProposal = (pid) => createCalls.filter((c) => String(c.metadata?.proposal_id) === String(pid)).length;

before(async () => {
  const app = express();
  app.use('/api/stripe', express.json());
  app.use('/api/stripe', stripeRouter);
  // Mirror the production error middleware (server/index.js) so AppError.code
  // serializes to JSON — the tests assert body.code === 'EVENT_CANCELLED'.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

// ── Piece 1: create-intent-for-invoice archived guard ────────────────────────

test('create-intent-for-invoice on an ARCHIVED proposal returns 409 EVENT_CANCELLED and mints no intent', async () => {
  const p = await seedProposal({ status: 'archived' });
  const token = await seedInvoice(p, { status: 'partially_paid', amountDue: 50000, amountPaid: 10000 });

  const r = await postJson(`/api/stripe/create-intent-for-invoice/${token}`, {});
  assert.equal(r.status, 409, `expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.code, 'EVENT_CANCELLED', 'error code is EVENT_CANCELLED');
  assert.equal(createdForProposal(p), 0, 'no paymentIntents.create call for the archived proposal');

  const sess = await one('SELECT COUNT(*)::int AS n FROM stripe_sessions WHERE proposal_id = $1', [p]);
  assert.equal(sess.n, 0, 'no stripe_sessions row minted for the archived proposal');
});

test('create-intent-for-invoice on a deposit_paid proposal still returns 200 + clientSecret (no over-block)', async () => {
  const p = await seedProposal({ status: 'deposit_paid' });
  const token = await seedInvoice(p, { status: 'partially_paid', amountDue: 50000, amountPaid: 10000 });

  const r = await postJson(`/api/stripe/create-intent-for-invoice/${token}`, {});
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(r.body?.clientSecret, 'a clientSecret is returned');
  assert.equal(createdForProposal(p), 1, 'exactly one paymentIntents.create call');
});

test('create-intent-for-invoice on a draft proposal (archived->draft restore) is NOT blocked by the guard', async () => {
  const p = await seedProposal({ status: 'draft' });
  const token = await seedInvoice(p, { status: 'sent', amountDue: 50000, amountPaid: 0 });

  const r = await postJson(`/api/stripe/create-intent-for-invoice/${token}`, {});
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(r.body?.clientSecret, 'a clientSecret is returned for a restored (draft) proposal');
});

// ── Piece 1b: create-drink-plan-intent archived guard ────────────────────────

test('create-drink-plan-intent on an ARCHIVED proposal (past-due balance) returns 409 EVENT_CANCELLED and mints no intent', async () => {
  // Past-due balance so the pre-fix route WOULD fold the balance in and charge:
  // isPastDue && currentBalance>0 => totalCharge = balance, Stripe.create fires.
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const p = await seedProposal({ status: 'archived', totalPrice: 1000, amountPaid: 100, balanceDueDate: yesterday });
  const token = await seedDrinkPlan(p);

  const r = await postJson(`/api/stripe/create-drink-plan-intent/${token}`, { selections: {} });
  assert.equal(r.status, 409, `expected 409, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body?.code, 'EVENT_CANCELLED', 'error code is EVENT_CANCELLED');
  assert.equal(createdForProposal(p), 0, 'no paymentIntents.create call for the archived drink-plan proposal');

  const sess = await one('SELECT COUNT(*)::int AS n FROM stripe_sessions WHERE proposal_id = $1', [p]);
  assert.equal(sess.n, 0, 'no stripe_sessions row minted for the archived proposal');
});

test('create-drink-plan-intent on a deposit_paid proposal is NOT blocked by the archived guard', async () => {
  // Not past due, empty selections => the route reaches its own noPaymentNeeded
  // branch (proves the guard let it through without a 409).
  const p = await seedProposal({ status: 'deposit_paid', totalPrice: 1000, amountPaid: 100, balanceDueDate: null });
  const token = await seedDrinkPlan(p);

  const r = await postJson(`/api/stripe/create-drink-plan-intent/${token}`, { selections: {} });
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.notEqual(r.body?.code, 'EVENT_CANCELLED', 'not blocked by the archived guard');
});
