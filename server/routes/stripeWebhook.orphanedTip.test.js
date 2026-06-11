require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Known webhook secret so the test can sign events the handler verifies (local HMAC).
const WEBHOOK_SECRET = 'whsec_test_orphantip';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.orphanedTip.test.js refuses to run against production');
}

// Audit sec-webhooks (A08-money-without-record): a tip checkout that completes with bad
// metadata (malformed/missing token, non-positive amount, or a token absent from
// payment_profiles) was acked 200 with NO db record — real money orphaned in Stripe with
// only a Sentry warn. The handler now records each case into tips_orphaned (idempotent on
// stripe_session_id) before acking, giving the operator a reconciliation surface.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const sessionIds = [];

function sign(payloadStr) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payloadStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

function newSessionId() {
  const id = `cs_${NONCE}_${sessionIds.length}`;
  sessionIds.push(id);
  return id;
}

async function orphanRows(sessionId) {
  const r = await pool.query(
    'SELECT reason, amount_cents, stripe_payment_intent_id, attempted_token, customer_email FROM tips_orphaned WHERE stripe_session_id = $1',
    [sessionId]
  );
  return r.rows;
}

before(async () => {
  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (sessionIds.length) await pool.query('DELETE FROM tips_orphaned WHERE stripe_session_id = ANY($1::text[])', [sessionIds]);
  await pool.end();
});

function postWebhook(eventObj) {
  const payload = JSON.stringify(eventObj);
  const sig = sign(payload);
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

function tipEvent(sessionId, { metadata, amount_total = 5000 } = {}) {
  return {
    id: `evt_${sessionId}`, type: 'checkout.session.completed',
    data: { object: {
      id: sessionId,
      payment_intent: `pi_${sessionId}`,
      amount_total,
      customer_details: { email: `tipper-${NONCE}@example.com` },
      metadata: { kind: 'tip', ...metadata },
    } },
  };
}

test('malformed tip metadata (bad token) is recorded as orphaned, acked 200', async () => {
  const sid = newSessionId();
  const r = await postWebhook(tipEvent(sid, { metadata: { bartender_user_id: '5', tip_page_token: 'not-a-uuid' } }));
  assert.equal(r.status, 200, `got ${r.status} ${r.body}`);
  const rows = await orphanRows(sid);
  assert.equal(rows.length, 1, 'one orphan row expected');
  assert.equal(rows[0].reason, 'malformed_metadata');
});

test('non-positive tip amount is recorded as orphaned, acked 200', async () => {
  const sid = newSessionId();
  const r = await postWebhook(tipEvent(sid, { amount_total: 0, metadata: { bartender_user_id: '5', tip_page_token: crypto.randomUUID() } }));
  assert.equal(r.status, 200, `got ${r.status} ${r.body}`);
  const rows = await orphanRows(sid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'non_positive_amount');
});

test('tip token not found in payment_profiles is recorded as orphaned, acked 200', async () => {
  const sid = newSessionId();
  const r = await postWebhook(tipEvent(sid, { metadata: { bartender_user_id: '5', tip_page_token: crypto.randomUUID() } }));
  assert.equal(r.status, 200, `got ${r.status} ${r.body}`);
  const rows = await orphanRows(sid);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, 'token_not_found');
  assert.equal(rows[0].amount_cents, 5000);
  assert.equal(rows[0].customer_email, `tipper-${NONCE}@example.com`);
});

test('redelivery of the same orphaned session records only one row (idempotent)', async () => {
  const sid = newSessionId();
  const ev = tipEvent(sid, { metadata: { bartender_user_id: '5', tip_page_token: crypto.randomUUID() } });
  await postWebhook(ev);
  await postWebhook(ev);
  const rows = await orphanRows(sid);
  assert.equal(rows.length, 1, 'ON CONFLICT (stripe_session_id) must keep it to one row');
});
