require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Known webhook secret so we can locally sign events the handler will verify.
const WEBHOOK_SECRET = 'whsec_test_payout';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');
const sync = require('../utils/stripePayoutSync');
const { getLiveClient } = require('../utils/stripeClient');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.payout.test.js refuses to run against production');
}

// M10: the webhook now passes the event-verified client into syncPayout, so a fake
// must BE the resolved (live) client, not just the module fallback. Override only the
// API resources syncPayout touches; .webhooks.constructEvent stays real so signature
// verification still works.
function patchLiveClient(fake) {
  const live = getLiveClient();
  assert.ok(live, 'getLiveClient() must be non-null (STRIPE_SECRET_KEY set) to exercise the M10 path');
  live.payouts = fake.payouts;
  live.balanceTransactions = fake.balanceTransactions;
  return live;
}

const N = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const poId = `po_test_${N}`;
let server, baseUrl;

// Copied from stripePayoutSync.test.js — the fake Stripe surface + payout/txn builders.
function fakeStripe({ payouts = [], txnsByPayout = {}, recentTxns = [] } = {}) {
  const page = (arr) => ({ data: arr, has_more: false });
  return {
    payouts: { list: async () => page(payouts) },
    balanceTransactions: {
      list: async (params = {}) => page(params.payout ? (txnsByPayout[params.payout] || []) : recentTxns),
    },
  };
}
const chargeTxn = (id, over = {}) => ({
  id, object: 'balance_transaction', type: 'charge', reporting_category: 'charge',
  amount: 45000, fee: 1335, net: 43665, available_on: 1782604800,
  description: `test charge ${N}`,
  source: { id: `ch_test_${N}`, object: 'charge', payment_intent: `pi_test_${N}` },
  ...over,
});

function sign(payloadStr) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payloadStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

function postWebhook(eventObj) {
  const payload = JSON.stringify(eventObj);
  const sig = sign(payload);
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + '/api/stripe/webhook');
    const buf = Buffer.from(payload);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'stripe-signature': sig },
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject);
    r.write(buf); r.end();
  });
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
  await pool.query('DELETE FROM stripe_payout_lines WHERE stripe_balance_txn_id LIKE $1', [`txn_test_${N}%`]);
  await pool.query('DELETE FROM stripe_payouts WHERE stripe_payout_id LIKE $1', [`po_test_${N}%`]);
  await pool.end();
});

test('payout.failed (live) upserts a failed stripe_payouts row and alerts once', async () => {
  sync._setStripeClientForTests(fakeStripe()); // no line fetch on failed
  const ev = { id: `evt_${N}_1`, type: 'payout.failed', livemode: true,
    data: { object: { id: poId, object: 'payout', amount: 5000, currency: 'usd', status: 'failed',
      created: Math.floor(Date.now()/1000), arrival_date: null, automatic: true, livemode: true,
      method: 'standard', failure_code: 'account_closed', failure_message: 'The bank account is closed.' } } };
  let res = await postWebhook(ev);
  assert.equal(res.status, 200);
  res = await postWebhook(ev); // Stripe redelivery
  assert.equal(res.status, 200);
  const rows = (await pool.query('SELECT status, alerted_at FROM stripe_payouts WHERE stripe_payout_id=$1', [poId])).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.ok(rows[0].alerted_at); // claimed exactly once; SEND_NOTIFICATIONS=false no-ops the real send
});

test('payout.paid (live) upserts a paid payout and syncs its lines through the webhook', async () => {
  const poP = `po_test_${N}_paid`;
  const fake = fakeStripe({ txnsByPayout: { [poP]: [chargeTxn(`txn_test_${N}_wh`)] } });
  sync._setStripeClientForTests(fake);
  // FIX M10: the webhook routes the event-verified client into syncPayout, so the
  // fake must also be the resolved live client.
  patchLiveClient(fake);
  const ev = { id: `evt_${N}_paid`, type: 'payout.paid', livemode: true,
    data: { object: { id: poP, object: 'payout', amount: 43665, currency: 'usd', status: 'paid',
      created: Math.floor(Date.now()/1000), arrival_date: Math.floor(Date.now()/1000),
      automatic: true, livemode: true, method: 'standard' } } };
  const res = await postWebhook(ev);
  assert.equal(res.status, 200);
  const p = (await pool.query('SELECT id, lines_synced_at FROM stripe_payouts WHERE stripe_payout_id=$1', [poP])).rows[0];
  assert.ok(p && p.lines_synced_at, 'payout row missing or lines not synced');
  const l = (await pool.query('SELECT payout_id FROM stripe_payout_lines WHERE stripe_balance_txn_id=$1', [`txn_test_${N}_wh`])).rows[0];
  assert.equal(l.payout_id, p.id);
});

test('payout.paid line-sync uses the event-verified client, not the module fallback (M10)', async () => {
  const poV = `po_test_${N}_verified`;
  // If the webhook wrongly used the module fallback (getStripe / _setStripeClientForTests),
  // the synced line would carry the WRONG txn id; the event-verified (live) client carries
  // the RIGHT one. The M10 fix passes stripeForEvent through, so the RIGHT txn must win.
  sync._setStripeClientForTests(fakeStripe({ txnsByPayout: { [poV]: [chargeTxn(`txn_test_${N}_wrong`)] } }));
  patchLiveClient(fakeStripe({ txnsByPayout: { [poV]: [chargeTxn(`txn_test_${N}_right`)] } }));
  const ev = { id: `evt_${N}_verified`, type: 'payout.paid', livemode: true,
    data: { object: { id: poV, object: 'payout', amount: 43665, currency: 'usd', status: 'paid',
      created: Math.floor(Date.now()/1000), arrival_date: Math.floor(Date.now()/1000),
      automatic: true, livemode: true, method: 'standard' } } };
  const res = await postWebhook(ev);
  assert.equal(res.status, 200);
  const right = await pool.query('SELECT 1 FROM stripe_payout_lines WHERE stripe_balance_txn_id=$1', [`txn_test_${N}_right`]);
  const wrong = await pool.query('SELECT 1 FROM stripe_payout_lines WHERE stripe_balance_txn_id=$1', [`txn_test_${N}_wrong`]);
  assert.equal(right.rows.length, 1, 'line synced from the event-verified (live) client');
  assert.equal(wrong.rows.length, 0, 'the module-fallback client was NOT used');
});

test('payout.paid with livemode:false is acked and ignored', async () => {
  const ev = { id: `evt_${N}_2`, type: 'payout.failed', livemode: false,
    data: { object: { id: `po_tm_${N}`, object: 'payout', status: 'failed', amount: 1, created: 1, livemode: false } } };
  const res = await postWebhook(ev);
  assert.equal(res.status, 200);
  const rows = await pool.query('SELECT 1 FROM stripe_payouts WHERE stripe_payout_id=$1', [`po_tm_${N}`]);
  assert.equal(rows.rows.length, 0);
});

test('payment_intent branches unaffected: unknown event type still acks', async () => {
  const res = await postWebhook({ id: `evt_${N}_3`, type: 'payout.canceled', livemode: true,
    data: { object: { id: `po_x_${N}`, object: 'payout' } } });
  assert.equal(res.status, 200); // unhandled payout subtype falls through to the final ack
});
