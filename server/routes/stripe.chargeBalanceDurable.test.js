require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripe.chargeBalanceDurable.test.js refuses to run against production');
}

// Fake Stripe via the getStripe seam — stripe.js destructures getStripe at load,
// so stub BEFORE requiring the router.
const createdFor = new Set();
const retrieveMap = {};
const fakeStripe = {
  paymentIntents: {
    create: async (params) => {
      const pid = String(params.metadata.proposal_id);
      createdFor.add(pid);
      return { id: `pi_faketest_${pid}_${Date.now()}`, status: 'succeeded' };
    },
    retrieve: async (id) => {
      if (!retrieveMap[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
      return retrieveMap[id];
    },
  },
};
require('../utils/stripeClient').getStripe = () => fakeStripe;

const stripeRouter = require('./stripe');

const MARK = `cbdur-${Date.now()}`;
let server, baseUrl, adminToken, adminEmail, freshId, skipId;

async function seed(mark, { autopayStatus, attemptedInterval }) {
  const attempted = attemptedInterval ? `NOW() - INTERVAL '${attemptedInterval}'` : 'NULL';
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, status, event_type, autopay_enrolled, balance_due_date,
        stripe_customer_id, stripe_payment_method_id, total_price, amount_paid,
        autopay_status, autopay_attempted_at)
     VALUES (NULL, 'deposit_paid', $1, true, CURRENT_DATE,
             'cus_faketest', 'pm_faketest', 1000, 900, $2, ${attempted})
     RETURNING id`,
    [mark, autopayStatus]
  );
  return r.rows[0].id;
}

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

before(async () => {
  adminEmail = `cbdur-admin+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', 'admin', 0) RETURNING id, token_version`, [adminEmail]
  );
  adminToken = jwt.sign({ userId: u.rows[0].id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET);

  freshId = await seed(`${MARK}-fresh`, { autopayStatus: null });                                     // (a) durable insert
  skipId  = await seed(`${MARK}-skip`,  { autopayStatus: 'in_progress', attemptedInterval: '80 hours' }); // (b) guard

  const priorId = `pi_prior_${skipId}`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 10000, 'pending')`, [skipId, priorId]
  );
  retrieveMap[priorId] = { id: priorId, status: 'succeeded', metadata: { payment_type: 'balance' } };

  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
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
  for (const id of [freshId, skipId]) {
    if (!id) continue;
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  await pool.query('DELETE FROM users WHERE email = $1', [adminEmail]);
  await pool.end();
});

test('(a) charge-balance writes a durable stripe_sessions row and returns 200', async () => {
  const res = await post(`/api/stripe/charge-balance/${freshId}`, adminToken);
  assert.equal(res.status, 200, `expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(createdFor.has(String(freshId)), 'the fresh proposal must be charged');
  const { rows } = await pool.query(
    `SELECT amount, status FROM stripe_sessions
      WHERE proposal_id = $1 AND stripe_payment_intent_id LIKE 'pi_faketest_%'`, [freshId]
  );
  assert.equal(rows.length, 1, 'exactly one durable balance row persisted at charge time');
  assert.equal(Number(rows[0].amount), 10000);
  assert.equal(rows[0].status, 'pending');
});

test('(b) charge-balance SKIPS (409 CHARGE_SETTLING) when the prior balance intent is already succeeded', async () => {
  const res = await post(`/api/stripe/charge-balance/${skipId}`, adminToken);
  assert.equal(res.status, 409, `expected 409, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'CHARGE_SETTLING');
  assert.equal(createdFor.has(String(skipId)), false, 'must NOT fire a second charge when a prior balance intent is settling');
  const { rows } = await pool.query(
    `SELECT 1 FROM stripe_sessions
      WHERE proposal_id = $1 AND stripe_payment_intent_id LIKE 'pi_faketest_%'`, [skipId]
  );
  assert.equal(rows.length, 0, 'no new durable row — the re-charge was skipped');
});

test('(c) a Stripe verify blip releases the claim and returns 502 — no misleading 409, no 72h lockout', async () => {
  // Prior balance row whose intent is NOT in retrieveMap → the guard's retrieve()
  // throws resource_missing → reason 'retrieve_failed'. The manual route must release
  // the claim (retry works immediately) and surface a distinct upstream error, NOT the
  // 409 CHARGE_SETTLING that would strand the admin for 72h behind a transient blip.
  const blipId = await seed(`${MARK}-blip`, { autopayStatus: 'in_progress', attemptedInterval: '80 hours' });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 10000, 'pending')`, [blipId, `pi_gone_${blipId}`]
  );
  try {
    const res = await post(`/api/stripe/charge-balance/${blipId}`, adminToken);
    assert.equal(res.status, 502, `expected 502 verify-unavailable, got ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, 'EXTERNAL_SERVICE_ERROR');
    assert.equal(createdFor.has(String(blipId)), false, 'must not charge when it cannot verify the prior intent');
    const st = await pool.query('SELECT autopay_status FROM proposals WHERE id = $1', [blipId]);
    assert.equal(st.rows[0].autopay_status, null, 'claim released so the admin can retry immediately (no 72h lockout)');
  } finally {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [blipId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [blipId]);
  }
});
