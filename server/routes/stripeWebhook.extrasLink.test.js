require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Known webhook secret so the test can locally HMAC-sign events the handler's
// constructEvent verifies (no Stripe API call). Set before the router runs.
const WEBHOOK_SECRET = 'whsec_test_extraslink';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');
const { findOrRefreshExtrasInvoice } = require('../utils/invoiceHelpers');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.extrasLink.test.js refuses to run against production');
}

// B2: on payment_intent.succeeded for drink-plan extras, the webhook must LINK the
// submit-created "Drink Plan Extras" invoice (B1), not create a second one. Covers:
//   1. happy path — links the existing unpaid invoice (one invoice, now paid);
//   (a) with_balance — extras links to the extras invoice, balance to the Balance;
//   (b) out-of-order — webhook before submit creates+pays it; submit's
//       find-or-refresh then reuses it (no duplicate).

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

function sign(payloadStr) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payloadStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

async function seedProposal({ totalPrice = 5000, guestCount = 75 } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('WH Extras', $1) RETURNING id`,
    [`wh-extras-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, guest_count, num_bars, pricing_snapshot)
     VALUES ($1, 'deposit_paid', $2, 0, $3, 0, '{}'::jsonb) RETURNING id`,
    [c.rows[0].id, totalPrice, guestCount]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedDrinkPlan(proposalId) {
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections)
     VALUES ($1, 'submitted', $2::jsonb) RETURNING id`,
    [proposalId, JSON.stringify({ syrupSelections: { d1: ['blackberry', 'vanilla'] }, syrupSelfProvided: [] })]
  );
  return dp.rows[0].id;
}

async function seedInvoice(proposalId, { label, amountDue, status = 'sent' }) {
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, label, amountDue, status]
  );
  return inv.rows[0].id;
}

async function extrasInvoices(proposalId) {
  const r = await pool.query(
    `SELECT id, status, amount_due, amount_paid FROM invoices
      WHERE proposal_id = $1 AND label = 'Drink Plan Extras' AND status <> 'void'
      ORDER BY id`,
    [proposalId]
  );
  return r.rows;
}

async function linkCount(invoiceId) {
  const r = await pool.query('SELECT COUNT(*)::int AS n FROM invoice_payments WHERE invoice_id = $1', [invoiceId]);
  return r.rows[0].n;
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
  // Allow the webhook's fire-and-forget post-commit work (createEventShifts,
  // notifications) to settle before teardown.
  await new Promise((r) => setTimeout(r, 400));
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
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

test('links the submit-created extras invoice (no second invoice), marks it paid', async () => {
  const p = await seedProposal();
  const dp = await seedDrinkPlan(p);
  const invId = await seedInvoice(p, { label: 'Drink Plan Extras', amountDue: 10500 });

  const r = await postWebhook({
    id: `evt_${NONCE}_extras`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_extras`, amount: 10500,
      metadata: { proposal_id: String(p), payment_type: 'drink_plan_extras',
        extras_amount_cents: '10500', balance_amount_cents: '0', drink_plan_id: String(dp) } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const rows = await extrasInvoices(p);
  assert.equal(rows.length, 1, 'exactly ONE non-void extras invoice');
  assert.equal(rows[0].id, invId, 'the existing invoice was reused, not replaced');
  assert.equal(rows[0].status, 'paid');
  assert.equal(rows[0].amount_paid, 10500);
  assert.equal(await linkCount(invId), 1, 'exactly one payment link');
});

test('with_balance: extras portion links to extras invoice, balance portion to the Balance invoice', async () => {
  const p = await seedProposal({ totalPrice: 50000 });
  const dp = await seedDrinkPlan(p);
  const extrasId = await seedInvoice(p, { label: 'Drink Plan Extras', amountDue: 6000 });
  const balanceId = await seedInvoice(p, { label: 'Balance', amountDue: 40000 });

  const r = await postWebhook({
    id: `evt_${NONCE}_wb`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_wb`, amount: 46000,
      metadata: { proposal_id: String(p), payment_type: 'drink_plan_with_balance',
        extras_amount_cents: '6000', balance_amount_cents: '40000', drink_plan_id: String(dp) } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const rows = await extrasInvoices(p);
  assert.equal(rows.length, 1, 'one extras invoice');
  assert.equal(rows[0].id, extrasId);
  assert.equal(rows[0].amount_paid, 6000);
  assert.equal(rows[0].status, 'paid');

  const bal = await pool.query('SELECT amount_paid, status FROM invoices WHERE id = $1', [balanceId]);
  assert.equal(bal.rows[0].amount_paid, 40000, 'balance portion credited to the Balance invoice');
  assert.equal(bal.rows[0].status, 'paid');
});

test('out-of-order: webhook creates+pays it, then submit find-or-refresh reuses it (no duplicate)', async () => {
  const p = await seedProposal();
  const dp = await seedDrinkPlan(p); // NO extras invoice seeded (webhook lands before submit)

  const r = await postWebhook({
    id: `evt_${NONCE}_ooo`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_ooo`, amount: 10500,
      metadata: { proposal_id: String(p), payment_type: 'drink_plan_extras',
        extras_amount_cents: '10500', balance_amount_cents: '0', drink_plan_id: String(dp) } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  let rows = await extrasInvoices(p);
  assert.equal(rows.length, 1, 'webhook created exactly one extras invoice');
  assert.equal(rows[0].status, 'paid');
  assert.equal(rows[0].amount_paid, 10500);
  const invId = rows[0].id;

  // Now simulate the submit that landed AFTER the webhook: find-or-refresh must
  // reuse the paid/locked invoice AS-IS, never create a second one.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const reused = await findOrRefreshExtrasInvoice(
      { proposalId: p, drinkPlanId: dp, breakdown: { totalCents: 10500 },
        selections: { syrupSelections: { d1: ['blackberry', 'vanilla'] } }, guestCount: 75, pricingSnapshot: {}, numBars: 0 },
      c
    );
    await c.query('COMMIT');
    assert.equal(reused.id, invId, 'submit reused the webhook-created invoice');
  } finally {
    c.release();
  }

  rows = await extrasInvoices(p);
  assert.equal(rows.length, 1, 'still exactly ONE non-void extras invoice after submit');
  assert.equal(await linkCount(invId), 1, 'still one payment link (submit did not double-link)');
});
