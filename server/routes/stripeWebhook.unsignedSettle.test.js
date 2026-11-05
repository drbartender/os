// A deposit confirmed on a row the client never signed (audit ESIG-03,
// 2026-11-05). DB-BACKED: run alone against the shared dev DB.
//
//   node --test server/routes/stripeWebhook.unsignedSettle.test.js
//
// The pure pin of both rails' logic is
// stripeWebhookHandlers/paymentIntentSucceeded.unsignedSettle.test.js; this
// suite asserts the committed rows: the deposit converts the booking as it
// always did, accepted_at is stamped so the financial dashboard sees it, an
// unsigned_payment activity row records the missing signature, and a signed
// row keeps its own acceptance stamp and records nothing.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const WEBHOOK_SECRET = 'whsec_test_unsignedsettle';
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
  throw new Error('stripeWebhook.unsignedSettle.test.js refuses to run against production');
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

async function seed({ status = 'viewed', signedAt = null, acceptedAt = null } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('WH Unsigned', $1, 'ok') RETURNING id`,
    [`wh-unsigned-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, deposit_amount, payment_type,
                            event_date, balance_due_date, client_signed_at, accepted_at, pricing_snapshot, token)
     VALUES ($1, $2, 'wedding', 1000, 0, 100, 'deposit',
             CURRENT_DATE + INTERVAL '60 days', CURRENT_DATE + INTERVAL '46 days', $3, $4, '{"total": 1000}'::jsonb, gen_random_uuid())
     RETURNING id`,
    [c.rows[0].id, status, signedAt, acceptedAt]
  );
  proposalIds.push(p.rows[0].id);
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent')`,
    [p.rows[0].id, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  return p.rows[0].id;
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
  await pool.end();
});

test('a deposit on a viewed, unsigned row: deposit_paid, accepted_at stamped, an unsigned_payment row', async () => {
  const id = await seed();
  const r = await postWebhook({
    id: `evt_${NONCE}_unsigned`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_unsigned`, amount: 10000, metadata: { proposal_id: String(id), payment_type: 'deposit' } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);
  const row = (await pool.query('SELECT status, amount_paid, accepted_at, client_signed_at FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(row.status, 'deposit_paid');
  assert.equal(Number(row.amount_paid), 100);
  assert.ok(row.accepted_at, 'accepted_at is stamped at settle');
  assert.equal(row.client_signed_at, null, 'the signature is not invented');
  const unsigned = await pool.query(`SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'unsigned_payment'`, [id]);
  assert.equal(unsigned.rows.length, 1);
  assert.equal(unsigned.rows[0].details.payment_type, 'deposit');
});

test('a deposit on a signed row keeps the signature\'s own acceptance stamp and records nothing', async () => {
  const signedAt = new Date('2026-11-01T12:00:00Z');
  const id = await seed({ status: 'accepted', signedAt, acceptedAt: signedAt });
  const r = await postWebhook({
    id: `evt_${NONCE}_signed`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_signed`, amount: 10000, metadata: { proposal_id: String(id), payment_type: 'deposit' } } },
  });
  assert.equal(r.status, 200);
  const row = (await pool.query('SELECT status, accepted_at FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(row.status, 'deposit_paid');
  assert.equal(new Date(row.accepted_at).getTime(), signedAt.getTime(), 'COALESCE never moves the stamp');
  const unsigned = await pool.query(`SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'unsigned_payment'`, [id]);
  assert.equal(unsigned.rows.length, 0);
});
