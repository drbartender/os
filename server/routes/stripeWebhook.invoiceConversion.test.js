// payment_intent.succeeded: a contract invoice paid on a pre-conversion row
// converts the booking (audit PAY-02, 2026-11-05). DB-BACKED: run alone
// against the shared dev DB.
//
//   node --test server/routes/stripeWebhook.invoiceConversion.test.js
//
// THE DEFECT. The invoice branch credited a Deposit invoice paid from the
// public invoice page on a 'sent' row (an intent minted before
// create-intent-for-invoice refused it) without converting the booking: the
// row stayed 'sent' with amount_paid 100, no Balance invoice, no reminder
// ladder, while a shift was still created and Sign & Pay still offered a
// second deposit. The pure pin of the branch's logic is
// stripeWebhookHandlers/paymentIntentSucceeded.invoiceConversion.test.js; this
// suite asserts the committed rows (the invoiceLink suite's shape).
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const WEBHOOK_SECRET = 'whsec_test_invoiceconversion';
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
  throw new Error('stripeWebhook.invoiceConversion.test.js refuses to run against production');
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

// A sent, unsigned proposal (total 1000, deposit 100) with its send-time
// Deposit invoice open, a balance due date and a client, as proposal send
// leaves it.
async function seed({ status = 'sent', signed = false } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('WH Conversion', $1, 'ok') RETURNING id`,
    [`wh-conv-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, deposit_amount, payment_type,
                            event_date, balance_due_date, client_signed_at, pricing_snapshot, token)
     VALUES ($1, $2, 'wedding', 1000, 0, 100, 'deposit',
             CURRENT_DATE + INTERVAL '60 days', CURRENT_DATE + INTERVAL '46 days', $3, '{"total": 1000}'::jsonb, gen_random_uuid())
     RETURNING id`,
    [c.rows[0].id, status, signed ? new Date() : null]
  );
  proposalIds.push(p.rows[0].id);
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent') RETURNING id`,
    [p.rows[0].id, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  return { proposalId: p.rows[0].id, depositInvoiceId: inv.rows[0].id };
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

test('a Deposit invoice paid on a sent, unsigned row: deposit_paid, a Balance invoice at the remainder, the ladder, the unsigned record', async () => {
  const f = await seed();
  const r = await postWebhook({
    id: `evt_${NONCE}_conv`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_conv`, amount: 10000,
      metadata: { proposal_id: String(f.proposalId), payment_type: 'invoice', invoice_id: String(f.depositInvoiceId) } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const row = (await pool.query('SELECT status, amount_paid FROM proposals WHERE id = $1', [f.proposalId])).rows[0];
  assert.equal(row.status, 'deposit_paid');
  assert.equal(Number(row.amount_paid), 100);

  const dep = (await pool.query('SELECT status, locked, amount_paid FROM invoices WHERE id = $1', [f.depositInvoiceId])).rows[0];
  assert.equal(dep.status, 'paid');
  assert.equal(dep.locked, true);

  const bal = await pool.query(
    `SELECT amount_due, status FROM invoices WHERE proposal_id = $1 AND label = 'Balance' AND status <> 'void'`,
    [f.proposalId]
  );
  assert.equal(bal.rows.length, 1, 'exactly one Balance invoice minted');
  assert.equal(Number(bal.rows[0].amount_due), 90000);
  assert.equal(bal.rows[0].status, 'sent');

  const ladder = await pool.query(
    `SELECT message_type FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
    [f.proposalId]
  );
  assert.ok(ladder.rows.some((m) => m.message_type === 'balance_due_today'), 'the balance reminder ladder is scheduled');

  const unsigned = await pool.query(
    `SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'unsigned_payment'`,
    [f.proposalId]
  );
  assert.equal(unsigned.rows.length, 1);
  assert.equal(unsigned.rows[0].details.invoice_label, 'Deposit');
});

test('a redelivery of the same event changes nothing a second time', async () => {
  const f = await seed();
  const event = {
    id: `evt_${NONCE}_redeliver`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_redeliver`, amount: 10000,
      metadata: { proposal_id: String(f.proposalId), payment_type: 'invoice', invoice_id: String(f.depositInvoiceId) } } },
  };
  assert.equal((await postWebhook(event)).status, 200);
  assert.equal((await postWebhook(event)).status, 200);
  const row = (await pool.query('SELECT status, amount_paid FROM proposals WHERE id = $1', [f.proposalId])).rows[0];
  assert.equal(row.status, 'deposit_paid');
  assert.equal(Number(row.amount_paid), 100, 'credited once');
  const bal = await pool.query(`SELECT id FROM invoices WHERE proposal_id = $1 AND label = 'Balance' AND status <> 'void'`, [f.proposalId]);
  assert.equal(bal.rows.length, 1);
  const unsigned = await pool.query(`SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'unsigned_payment'`, [f.proposalId]);
  assert.equal(unsigned.rows.length, 1);
});

test('a Deposit invoice paid on an accepted, signed row converts without the unsigned record', async () => {
  const f = await seed({ status: 'accepted', signed: true });
  const r = await postWebhook({
    id: `evt_${NONCE}_signed`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_signed`, amount: 10000,
      metadata: { proposal_id: String(f.proposalId), payment_type: 'invoice', invoice_id: String(f.depositInvoiceId) } } },
  });
  assert.equal(r.status, 200);
  const row = (await pool.query('SELECT status FROM proposals WHERE id = $1', [f.proposalId])).rows[0];
  assert.equal(row.status, 'deposit_paid');
  const unsigned = await pool.query(`SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'unsigned_payment'`, [f.proposalId]);
  assert.equal(unsigned.rows.length, 0);
});
