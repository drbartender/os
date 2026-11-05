// The deposit rail nets the off-contract money, end to end (round 3 L2,
// 2026-11-05). DB-BACKED: run alone against the shared dev DB.
//
//   node --test server/routes/stripeWebhook.nettedRails.test.js
//
// THE DEFECT. The deposit rail's CASE compared raw amount_paid with
// total_price, so a Travel invoice (1000) an admin minted and the client paid
// from the proposal page before booking, followed by the signed 10000 deposit
// on an 11000 contract, read 11000 >= 11000 and wrote balance_paid with 1000
// owed. The pure pins are paymentIntentSucceeded.nettedRails.test.js (the
// term bound on every rail); this suite commits the Travel shape through the
// signed webhook and reads the row back.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const WEBHOOK_SECRET = 'whsec_test_netted_rails';
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
  throw new Error('stripeWebhook.nettedRails.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

function sign(payloadStr) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payloadStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

// A viewed 110.00 quote whose client already paid a 10.00 Travel invoice from
// the proposal page (money in amount_paid, outside total_price).
async function seed() {
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('WH Netted', $1, 'ok') RETURNING id`,
    [`wh-netted-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, deposit_amount, payment_type,
                            event_date, pricing_snapshot, token)
     VALUES ($1, 'viewed', 'wedding', 110, 10, 100, 'deposit',
             CURRENT_DATE + INTERVAL '30 days', '{"total": 110}'::jsonb, gen_random_uuid())
     RETURNING id`,
    [c.rows[0].id]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Travel', 1000, 1000, 'paid', true) RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1, $2, 'invoice', 1000, 'succeeded') RETURNING id`,
    [proposalId, `pi_${NONCE}_travel_${proposalId}`]
  );
  await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)', [inv.rows[0].id, pay.rows[0].id, 1000]);
  return { proposalId };
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

before(async () => {
  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => setTimeout(r, 300));
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('the Travel shape: the signed 100.00 deposit on a 110.00 quote holding 10.00 of Travel money lands as deposit_paid, 10.00 owed', async () => {
  const f = await seed();
  const r = await postWebhook({
    id: `evt_${NONCE}_dep_${f.proposalId}`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_dep_${f.proposalId}`, object: 'payment_intent', amount: 10000, payment_method: null,
      metadata: { proposal_id: String(f.proposalId), payment_type: 'deposit' } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);
  const row = (await pool.query('SELECT status, amount_paid, total_price FROM proposals WHERE id = $1', [f.proposalId])).rows[0];
  assert.equal(Number(row.amount_paid), 110, 'the deposit is credited beside the Travel money');
  assert.equal(row.status, 'deposit_paid', '100.00 of contract money against 110.00: not fully paid');
});
