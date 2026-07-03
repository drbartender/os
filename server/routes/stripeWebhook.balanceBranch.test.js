require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Known webhook secret so the test can locally HMAC-sign events the handler's
// constructEvent verifies (no Stripe API call). Set before the router runs; the
// handler reads these env vars per-request.
const WEBHOOK_SECRET = 'whsec_test_balancebranch';
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
  throw new Error('stripeWebhook.balanceBranch.test.js refuses to run against production');
}

// FIX M3 (phantom-Outstanding). A balance payment_intent.succeeded must credit
// proposals.amount_paid in EVERY money-bearing state, not just 'deposit_paid'.
// The pre-fix `WHERE status = 'deposit_paid'` matched zero rows once an admin
// moved the proposal to 'confirmed', so amount_paid stayed short (phantom
// Outstanding) even though the payment row committed. Two cases below:
//   (1) balance lands on an already-'confirmed' proposal -> amount_paid credited,
//       status stays 'confirmed' (the exact repro).
//   (2) balance in the normal 'deposit_paid' flow -> still transitions as before.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

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

async function seedProposal({ status, totalPrice, amountPaid, eventDate }) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('WH Balance', $1) RETURNING id`,
    [`wh-balance-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, pricing_snapshot, event_date)
     VALUES ($1, $2, $3, $4, 100, '{}'::jsonb, $5) RETURNING id`,
    [c.rows[0].id, status, totalPrice, amountPaid, eventDate]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

// Event ~60 days out so the post-commit shift/booking-window path stays normal.
const EVENT_DATE = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);

before(async () => {
  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Let fire-and-forget post-commit work (createEventShifts, notifications) settle.
  await new Promise((r) => setTimeout(r, 400));
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', ids]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) {
    await pool.query('DELETE FROM sms_messages WHERE client_id = ANY($1::int[])', [clientIds]);
    await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  }
  await pool.end();
});

// ── (1) The exact phantom-Outstanding repro ──────────────────────────────────
test('balance payment on an already-confirmed proposal credits amount_paid and keeps status confirmed', async () => {
  // total $200, deposit $100 already paid, admin moved it to 'confirmed'.
  const p = await seedProposal({ status: 'confirmed', totalPrice: 200, amountPaid: 100, eventDate: EVENT_DATE });

  const r = await postWebhook({
    id: `evt_${NONCE}_balconf`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_balconf`, amount: 10000, // $100 balance in cents
      metadata: { proposal_id: String(p), payment_type: 'balance' } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const prop = await one('SELECT amount_paid, status FROM proposals WHERE id = $1', [p]);
  // Pre-fix this stayed at 100 (WHERE status='deposit_paid' matched 0 rows) -> phantom Outstanding.
  assert.equal(Number(prop.amount_paid), 200, 'balance must increment amount_paid to the full total even when confirmed');
  assert.equal(prop.status, 'confirmed', 'a balance payment must not rewind a confirmed proposal');
});

// ── (2) Normal deposit_paid flow still transitions ───────────────────────────
test('balance payment in the normal deposit_paid flow still transitions status to balance_paid', async () => {
  const p = await seedProposal({ status: 'deposit_paid', totalPrice: 200, amountPaid: 100, eventDate: EVENT_DATE });

  const r = await postWebhook({
    id: `evt_${NONCE}_baldep`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_baldep`, amount: 10000, // $100 balance in cents
      metadata: { proposal_id: String(p), payment_type: 'balance' } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const prop = await one('SELECT amount_paid, status FROM proposals WHERE id = $1', [p]);
  assert.equal(Number(prop.amount_paid), 200, 'amount_paid credited to total');
  assert.equal(prop.status, 'balance_paid', 'deposit_paid fully paid by balance advances to balance_paid');
});
