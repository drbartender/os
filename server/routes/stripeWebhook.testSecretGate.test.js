// Regression guard for the live-mode gate's TRUST BOUNDARY (audit 2026-07-13, B1).
//
// The webhook verifier deliberately accepts EITHER the live or the test webhook secret
// (so an event straddling a STRIPE_TEST_MODE_UNTIL cutover still verifies). The
// out-of-window gate must therefore decide "is this a test event?" from WHICH SECRET
// VERIFIED IT — not from `event.livemode`, which is part of the signed body and is
// chosen by whoever signed it.
//
// The hole this pins shut: the TEST webhook secret is the low-trust one (it lives in
// CLI sessions, CI, shared envs, screenshots). If the gate keyed off `livemode`, anyone
// holding it could sign a body claiming `livemode: true` on a payment_intent.succeeded
// for a real proposal id and credit a real booking to paid, accruing real payroll.
//
// This suite configures BOTH secrets with DIFFERENT values (unlike guards.test.js, which
// blanks the test secret) so the test verifier actually registers, then signs with the
// TEST secret while lying about livemode.
//
// It also asserts the inverse, which is the more important safety property: an event
// signed with the LIVE secret is still processed. A gate that dropped live money would
// be far worse than the hole it closes.

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const LIVE_WEBHOOK_SECRET = 'whsec_live_gate_test';
const TEST_WEBHOOK_SECRET = 'whsec_test_gate_test';
process.env.STRIPE_WEBHOOK_SECRET = LIVE_WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = TEST_WEBHOOK_SECRET;
// Both API keys must be present or the corresponding verifier is filtered out
// (the verifier list requires `v.secret && v.client`). constructEvent is a local HMAC,
// so these keys are never used against Stripe's API and can be dummies.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_live_dummy_gate_test';
process.env.STRIPE_SECRET_KEY_TEST = process.env.STRIPE_SECRET_KEY_TEST || 'sk_test_dummy_gate_test';
// Force "outside a test window" so the gate is armed, regardless of local .env.
process.env.STRIPE_TEST_MODE_UNTIL = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.testSecretGate.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

function sign(payloadStr, secret) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${payloadStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

function postWebhook(eventObj, secret) {
  const payload = JSON.stringify(eventObj);
  const sig = sign(payload, secret);
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/stripe/webhook');
    const buf = Buffer.from(payload);
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'stripe-signature': sig },
      },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

async function seedProposal({ status = 'accepted', totalPrice = 100, amountPaid = 0 } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('WH Gate', $1) RETURNING id`,
    [`wh-gate-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, pricing_snapshot)
     VALUES ($1, $2, $3, $4, 100, '{}'::jsonb) RETURNING id`,
    [c.rows[0].id, status, totalPrice, amountPaid]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

before(async () => {
  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => setTimeout(r, 400));
  if (server) await new Promise((r) => server.close(r));
  await pool.query("DELETE FROM webhook_events WHERE provider = 'stripe' AND event_id LIKE $1", [`evt_${NONCE}%`]);
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('an event signed with the TEST secret but CLAIMING livemode:true is dropped (cannot forge a live credit)', async () => {
  const p = await seedProposal({ status: 'accepted' });
  const piId = `pi_${NONCE}_forged`;

  const r = await postWebhook({
    id: `evt_${NONCE}_forged`,
    type: 'payment_intent.succeeded',
    livemode: true, // <-- the lie. Signed, but with the LOW-TRUST test secret.
    data: {
      object: {
        id: piId, amount: 50000, payment_method: null,
        metadata: { proposal_id: String(p), payment_type: 'full' },
      },
    },
  }, TEST_WEBHOOK_SECRET);

  assert.equal(r.status, 200, `webhook should ack, got ${r.status} ${r.body}`);
  assert.match(r.body, /test_mode/, 'event verified by the TEST secret must be skipped as test_mode regardless of its livemode claim');

  const pay = await one('SELECT COUNT(*)::int AS n FROM proposal_payments WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(pay.n, 0, 'a test-secret-signed event must not create a payment row');
  const prop = await one('SELECT status, amount_paid FROM proposals WHERE id = $1', [p]);
  assert.equal(prop.status, 'accepted', 'a test-secret-signed event must not advance proposal status');
  assert.equal(Number(prop.amount_paid), 0, 'a test-secret-signed event must not credit money');
});

test('an event signed with the LIVE secret IS still processed (the gate must never drop real money)', async () => {
  const p = await seedProposal({ status: 'accepted', totalPrice: 500 });
  const piId = `pi_${NONCE}_genuine`;

  const r = await postWebhook({
    id: `evt_${NONCE}_genuine`,
    type: 'payment_intent.succeeded',
    livemode: true,
    data: {
      object: {
        id: piId, amount: 50000, payment_method: null,
        metadata: { proposal_id: String(p), payment_type: 'full' },
      },
    },
  }, LIVE_WEBHOOK_SECRET);

  assert.equal(r.status, 200, `webhook should ack, got ${r.status} ${r.body}`);
  assert.doesNotMatch(r.body, /test_mode/, 'a LIVE-secret event must not be skipped as test_mode');

  const pay = await one('SELECT COUNT(*)::int AS n FROM proposal_payments WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(pay.n, 1, 'the genuine live event must record its payment');
  const prop = await one('SELECT amount_paid FROM proposals WHERE id = $1', [p]);
  assert.equal(Number(prop.amount_paid), 500, 'the genuine live event must credit the proposal');
});
