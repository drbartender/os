// server/routes/stripe.refundScope.test.js
// The admin refund route's scope choice (spec 2026-09-15 sections 4 and 4b).
// Run ALONE against the shared dev DB:
//   node --test server/routes/stripe.refundScope.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// NEVER touch live Stripe: this box talks to the LIVE account by design, so a
// real refunds.create here would move real money. The route destructures
// getStripe at require time, so the stub MUST be installed before ./stripe is
// required. refundExecute takes the client by injection from the route, so this
// one stub covers the whole path.
const stripeClient = require('../utils/stripeClient');
let createdRefunds = [];
stripeClient.getStripe = () => ({
  refunds: {
    create: async (params) => {
      createdRefunds.push(params);
      return { id: `re_fake_${createdRefunds.length}_${Date.now()}`, ...params };
    },
  },
});

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripe.refundScope.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, adminToken, adminUserId, seq = 0;
const proposalIds = [];
const clientIds = [];

function request(method, path, { token, body } = {}) {
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        } },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * overpaidBy dollars of excess held beyond the contract, carried by a payment
 * that was credited to NO invoice — the duplicate geometry (prod 784).
 */
async function seed({ totalPrice = 500, payCents = 40000, overpaidBy = 400, withDuplicate = true } = {}) {
  seq += 1;
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('Refund Scope', $1, 'bad') RETURNING id`,
    [`refund-scope-${NONCE}-${seq}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, pricing_snapshot, event_timezone)
     VALUES ($1, 'balance_paid', $2, $3, 100, '{}'::jsonb, 'America/Chicago') RETURNING id`,
    [c.rows[0].id, totalPrice, totalPrice + overpaidBy]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  // The contract invoice, paid and locked, funded by its OWN payment.
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, 'Balance', $4, $4, 'paid', true) RETURNING id`,
    [proposalId, crypto.randomUUID(), `INV-${crypto.randomBytes(6).toString('hex')}`, totalPrice * 100]
  );
  const contractPay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'invoice', $2, 'succeeded', $3) RETURNING id`,
    [proposalId, totalPrice * 100, `pi_rs_c_${NONCE}_${seq}`]
  );
  await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
    [inv.rows[0].id, contractPay.rows[0].id, totalPrice * 100]);
  // The duplicate: credited to nothing, so every cent of it is uncredited.
  // withDuplicate false models the OTHER way a proposal reads overpaid: the
  // excess came in outside Stripe (external_paid rolls into amount_paid), so
  // every Stripe charge is fully credited and none of it can be returned.
  let dupPaymentId = null;
  if (withDuplicate) {
    const dupPay = await pool.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
       VALUES ($1, 'invoice', $2, 'succeeded', $3) RETURNING id`,
      [proposalId, payCents, `pi_rs_d_${NONCE}_${seq}`]
    );
    dupPaymentId = dupPay.rows[0].id;
  } else {
    await pool.query('UPDATE proposals SET external_paid = $1 WHERE id = $2', [overpaidBy, proposalId]);
  }
  return { proposalId, invId: inv.rows[0].id, contractPaymentId: contractPay.rows[0].id, dupPaymentId };
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const money = (pid) => one('SELECT total_price, amount_paid, status FROM proposals WHERE id = $1', [pid]);
const key = () => crypto.randomUUID();

before(async () => {
  const hash = await bcrypt.hash('x', 4);
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`refund-scope-admin-${NONCE}@example.com`, hash]
  );
  adminUserId = u.rows[0].id;
  adminToken = jwt.sign({ userId: adminUserId, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET);

  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  // Mirror the app's error middleware so AppError surfaces its statusCode+code.
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: 'server error' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  if (adminUserId) await pool.query('DELETE FROM users WHERE id = $1', [adminUserId]);
  await pool.end();
});

test('an unknown scope is refused', async () => {
  const o = await seed();
  const r = await request('POST', `/api/stripe/refund/${o.proposalId}`, {
    token: adminToken,
    body: { amount: 100, reason: 'test', idempotency_key: key(), total_scope: 'whatever' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_SCOPE');
});

test('an overpayment refund larger than the netted excess is refused with the figure', async () => {
  const o = await seed({ overpaidBy: 400 });
  const r = await request('POST', `/api/stripe/refund/${o.proposalId}`, {
    token: adminToken,
    body: { amount: 500, reason: 'too much', idempotency_key: key(), total_scope: 'overpayment' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'REFUND_EXCEEDS_OVERPAYMENT');
  assert.match(r.body.error, /overpaid by \$400\.00/);
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 900, 'nothing moved');
});

test('an overpayment refund within the excess leaves the contract and the invoice alone', async () => {
  const o = await seed({ overpaidBy: 400 });
  const r = await request('POST', `/api/stripe/refund/${o.proposalId}`, {
    token: adminToken,
    body: { amount: 400, reason: 'duplicate payment returned', idempotency_key: key(), total_scope: 'overpayment' },
  });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.refunded, 40000);
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 500, 'the contract stands');
  assert.equal(Number(m.amount_paid), 500, 'the excess came off');
  assert.equal(m.status, 'balance_paid', 'still fully paid at the unchanged total');
  const inv = await one('SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1', [o.invId]);
  assert.equal(inv.amount_due, 50000, 'the locked invoice still demands the contract');
  assert.equal(inv.amount_paid, 50000);
  assert.equal(inv.status, 'paid');
  const row = await one(
    `SELECT payment_id, total_scope FROM proposal_refunds WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`,
    [o.proposalId]
  );
  assert.equal(row.total_scope, 'overpayment');
  assert.equal(row.payment_id, o.dupPaymentId, 'targeted the charge carrying the uncredited money');
});

test('contract scope is unchanged: it still corrects the total', async () => {
  const o = await seed({ overpaidBy: 400 });
  const r = await request('POST', `/api/stripe/refund/${o.proposalId}`, {
    token: adminToken,
    body: { amount: 100, reason: 'service credit', idempotency_key: key() },
  });
  assert.equal(r.status, 200, r.raw);
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 400, 'Approach A lowered the contract');
  assert.equal(Number(m.amount_paid), 800);
  const row = await one(
    `SELECT total_scope FROM proposal_refunds WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1`,
    [o.proposalId]
  );
  assert.equal(row.total_scope, 'contract', 'the default when the body says nothing');
});

test('the refund history reports each row scope', async () => {
  const o = await seed({ overpaidBy: 400 });
  await request('POST', `/api/stripe/refund/${o.proposalId}`, {
    token: adminToken,
    body: { amount: 400, reason: 'duplicate', idempotency_key: key(), total_scope: 'overpayment' },
  });
  const r = await request('GET', `/api/stripe/refunds/${o.proposalId}`, { token: adminToken });
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].total_scope, 'overpayment');
});

test('two concurrent overpayment refunds cannot both spend the same excess', async () => {
  // The cap is asserted under the proposals row lock in the same transaction
  // that writes the pending row, so the loser is refused rather than firing a
  // second real refund and dropping amount_paid below total_price.
  const o = await seed({ overpaidBy: 400 });
  const body = (k) => ({ amount: 400, reason: 'duplicate', idempotency_key: k, total_scope: 'overpayment' });
  const [a, b] = await Promise.all([
    request('POST', `/api/stripe/refund/${o.proposalId}`, { token: adminToken, body: body(key()) }),
    request('POST', `/api/stripe/refund/${o.proposalId}`, { token: adminToken, body: body(key()) }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 400], `one wins, one is refused (got ${a.status}/${b.status}: ${a.raw} | ${b.raw})`);
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 500, 'exactly one refund landed');
  assert.equal(Number(m.total_price), 500, 'and the contract never moved');
  const rows = await one(
    `SELECT COUNT(*)::int AS n FROM proposal_refunds WHERE proposal_id = $1 AND status = 'succeeded'`,
    [o.proposalId]
  );
  assert.equal(rows.n, 1);
});

test('an overpayment that is not on a refundable charge is refused and says to return it by hand', async () => {
  // Every Stripe charge is fully credited to an invoice; the excess came in
  // outside Stripe. Refunding it as an overpayment would reverse invoice
  // credits while total_price stands, leaving a settled invoice demanding less
  // than the contract.
  const o = await seed({ overpaidBy: 400, withDuplicate: false });
  const r = await request('POST', `/api/stripe/refund/${o.proposalId}`, {
    token: adminToken,
    body: { amount: 400, reason: 'return the overpayment', idempotency_key: key(), total_scope: 'overpayment' },
  });
  assert.equal(r.status, 400, r.raw);
  assert.equal(r.body.code, 'OVERPAYMENT_NOT_ON_A_CHARGE');
  assert.match(r.body.error, /None of this overpayment can be returned through Stripe/);
  const inv = await one('SELECT amount_due, amount_paid FROM invoices WHERE id = $1', [o.invId]);
  assert.equal(inv.amount_due, 50000, 'the invoice was never touched');
  assert.equal(inv.amount_paid, 50000);
});

test('a refund already in flight is named as the reason, never as "not overpaid"', async () => {
  // The dangerous wording: "not overpaid, uncheck the box" would steer the
  // admin onto the CONTRACT path, which has no cap, and shrink the contract by
  // the amount already being returned.
  const o = await seed({ overpaidBy: 400 });
  await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status, total_scope)
     VALUES ($1, $2, $3, 40000, 'first window', 500, 500, NULL, 'pending', 'overpayment')`,
    [o.proposalId, o.dupPaymentId, `pi_rs_d_${NONCE}_${seq}`]
  );
  const r = await request('POST', `/api/stripe/refund/${o.proposalId}`, {
    token: adminToken,
    body: { amount: 400, reason: 'second window', idempotency_key: key(), total_scope: 'overpayment' },
  });
  assert.equal(r.status, 400, r.raw);
  assert.equal(r.body.code, 'REFUND_EXCEEDS_OVERPAYMENT');
  assert.match(r.body.error, /has not settled yet/);
  assert.doesNotMatch(r.body.error, /not overpaid/);
  assert.match(r.body.error, /Do not uncheck the box/);
});

test('a malformed amount reports INVALID_AMOUNT, not an overpayment problem', async () => {
  const o = await seed({ overpaidBy: 400 });
  const r = await request('POST', `/api/stripe/refund/${o.proposalId}`, {
    token: adminToken,
    body: { amount: 'abc', reason: 'typo', idempotency_key: key(), total_scope: 'overpayment' },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INVALID_AMOUNT');
});

test('a refund in flight is named as the reason even when it has consumed the whole excess', async () => {
  // The branch-order trap: excessCents can be 0 while the real cause is an
  // outstanding refund. Saying "not overpaid, uncheck the box" there would send
  // the admin down the CONTRACT path, which has no cap, while money is already
  // on its way back.
  const o = await seed({ overpaidBy: 0 });
  await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status, total_scope)
     VALUES ($1, $2, $3, 40000, 'in flight', 500, 500, NULL, 'pending', 'overpayment')`,
    [o.proposalId, o.dupPaymentId, `pi_rs_d_${NONCE}_${seq}`]
  );
  const r = await request('POST', `/api/stripe/refund/${o.proposalId}`, {
    token: adminToken,
    body: { amount: 100, reason: 'second window', idempotency_key: key(), total_scope: 'overpayment' },
  });
  assert.equal(r.status, 400, r.raw);
  assert.equal(r.body.code, 'REFUND_EXCEEDS_OVERPAYMENT');
  assert.match(r.body.error, /has not settled yet/);
  assert.doesNotMatch(r.body.error, /not overpaid/);
});

test('the headline overpayment works end to end: paid in full by card, then repriced down', async () => {
  // No uncredited money anywhere — the charge is fully credited to a LOCKED
  // Balance invoice that still demands the pre-reprice figure. Refusing this was
  // the defect the push-time code review caught: it is the case the editor's own
  // "a refund is likely owed" line announces, and the reconciler handles it
  // correctly, so the route must not stand in the way.
  seq += 1;
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('Repriced Down', $1, 'bad') RETURNING id`,
    [`refund-scope-reprice-${NONCE}-${seq}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, pricing_snapshot, event_timezone)
     VALUES ($1, 'balance_paid', 800, 1000, 100, '{}'::jsonb, 'America/Chicago') RETURNING id`,
    [c.rows[0].id]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  // The invoice locked at the ORIGINAL 1000 and the reprice left it there.
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, 'Balance', 100000, 100000, 'paid', true) RETURNING id`,
    [proposalId, crypto.randomUUID(), `INV-${crypto.randomBytes(6).toString('hex')}`]
  );
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'balance', 100000, 'succeeded', $2) RETURNING id`,
    [proposalId, `pi_rs_r_${NONCE}_${seq}`]
  );
  await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 100000)',
    [inv.rows[0].id, pay.rows[0].id]);

  const r = await request('POST', `/api/stripe/refund/${proposalId}`, {
    token: adminToken,
    body: { amount: 200, reason: 'repriced down, returning the excess', idempotency_key: key(), total_scope: 'overpayment' },
  });
  assert.equal(r.status, 200, r.raw);
  const m = await money(proposalId);
  assert.equal(Number(m.total_price), 800, 'the contract stands at the repriced figure');
  assert.equal(Number(m.amount_paid), 800, 'and the excess came off');
  const after = await one('SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1', [inv.rows[0].id]);
  assert.equal(after.amount_due, 80000, 'the stale locked invoice came back to the contract');
  assert.equal(after.amount_paid, 80000);
  assert.equal(after.status, 'paid', 'no phantom balance on a live pay link');
});
