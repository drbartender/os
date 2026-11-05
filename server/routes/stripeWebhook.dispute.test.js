// A card dispute on a proposal charge, end to end (audit PAY-04, 2026-11-05).
// DB-BACKED: run alone against the shared dev DB.
//
//   node --test server/routes/stripeWebhook.dispute.test.js
//
// THE DEFECT. The dispatcher routed only funds_withdrawn and funds_reinstated
// and both handlers only clawed tips, so a chargeback on a balance payment
// left the row balance_paid, the Balance invoice paid, no refund-ledger row
// and no alert: a later refund or cancellation could return money the bank
// had already taken. The pure pins are stripeWebhookHandlers/disputes.test.js
// (the routing and the tip cumulative, POUT-06) and utils/disputeLedger.test.js
// (the reconciler arithmetic); this suite asserts the committed rows through
// the signed webhook. The tip case is not repeated here: its arithmetic is
// pinned in disputes.test.js and clawbackTip itself in payrollClawback.test.js.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const WEBHOOK_SECRET = 'whsec_test_dispute';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const stripeRouter = require('./stripe');
const { loadPaymentsWithRemaining } = require('../utils/refundHelpers');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.dispute.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
// The exceeds-remainder path reports to Sentry before it alerts; observed here
// so a redelivery that took it would show (round 2 M1).
const sentryMessages = [];
const realCaptureMessage = Sentry.captureMessage;
Sentry.captureMessage = (msg, ctx) => { sentryMessages.push(msg); return realCaptureMessage ? realCaptureMessage.call(Sentry, msg, ctx) : undefined; };
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

function sign(payloadStr) {
  const t = Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payloadStr}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

// The report's row after the balance was paid by card: contract 1000, paid in
// full (deposit 100 + balance 900), autopay armed, both invoices paid+locked,
// the balance payment linked to the Balance invoice.
async function seed() {
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('WH Dispute', $1, 'ok') RETURNING id`,
    [`wh-dispute-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, deposit_amount, payment_type,
                            event_date, balance_due_date, autopay_enrolled, pricing_snapshot, token)
     VALUES ($1, 'balance_paid', 'wedding', 1000, 1000, 100, 'deposit',
             CURRENT_DATE + INTERVAL '30 days', CURRENT_DATE + INTERVAL '16 days', true, '{"total": 1000}'::jsonb, gen_random_uuid())
     RETURNING id`,
    [c.rows[0].id]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const inv = async (label, due) => (await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, $4, $4, 'paid', true) RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, label, due]
  )).rows[0].id;
  const depositInvoiceId = await inv('Deposit', 10000);
  const balanceInvoiceId = await inv('Balance', 90000);
  const pay = async (type, cents, pi) => (await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1, $2, $3, $4, 'succeeded') RETURNING id`,
    [proposalId, pi, type, cents]
  )).rows[0].id;
  const depositPaymentId = await pay('deposit', 10000, `pi_${NONCE}_dep_${proposalId}`);
  const balanceIntent = `pi_${NONCE}_bal_${proposalId}`;
  const balancePaymentId = await pay('balance', 90000, balanceIntent);
  await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3), ($4, $5, $6)',
    [depositInvoiceId, depositPaymentId, 10000, balanceInvoiceId, balancePaymentId, 90000]);
  return { proposalId, balanceInvoiceId, balancePaymentId, balanceIntent };
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

const disputeEvent = (type, f, id) => ({
  id: `evt_${NONCE}_${type}_${f.proposalId}`, type,
  data: { object: { id, object: 'dispute', payment_intent: f.balanceIntent, amount: 90000, reason: 'fraudulent', created: Math.floor(Date.now() / 1000) } },
});

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
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('created, then funds withdrawn: the opened record, the dispute row, the money and the invoice re-opened, the status demoted, autopay off, the charge no longer refundable', async () => {
  const f = await seed();
  const disputeId = `dp_${NONCE}_${f.proposalId}`;
  assert.equal((await postWebhook(disputeEvent('charge.dispute.created', f, disputeId))).status, 200);
  const opened = await pool.query(`SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'dispute_opened'`, [f.proposalId]);
  assert.equal(opened.rows.length, 1);
  assert.equal(opened.rows[0].details.dispute_id, disputeId);

  const r = await postWebhook(disputeEvent('charge.dispute.funds_withdrawn', f, disputeId));
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const row = (await pool.query('SELECT status, total_price, amount_paid, autopay_enrolled FROM proposals WHERE id = $1', [f.proposalId])).rows[0];
  assert.equal(Number(row.amount_paid), 100, 'the balance money is gone');
  assert.equal(Number(row.total_price), 1000, 'the contract stands');
  assert.equal(row.status, 'deposit_paid');
  assert.equal(row.autopay_enrolled, false, 'autopay disarmed on the demotion');

  const inv = (await pool.query('SELECT amount_due, amount_paid, status FROM invoices WHERE id = $1', [f.balanceInvoiceId])).rows[0];
  assert.equal(Number(inv.amount_due), 90000, 'the demand is not lowered');
  assert.equal(Number(inv.amount_paid), 0);
  assert.equal(inv.status, 'partially_paid', 'payable again');

  const ledger = (await pool.query('SELECT amount, status, total_scope, reason FROM proposal_refunds WHERE stripe_refund_id = $1', [disputeId])).rows;
  assert.equal(ledger.length, 1);
  assert.equal(Number(ledger[0].amount), 90000);
  assert.equal(ledger[0].status, 'succeeded');
  assert.equal(ledger[0].total_scope, 'dispute');
  assert.match(ledger[0].reason, /Chargeback/);

  const charges = await loadPaymentsWithRemaining(f.proposalId);
  const bal = charges.find((c) => c.id === f.balancePaymentId);
  assert.equal(bal.remainingCents, 0, 'nothing of the disputed charge is refundable');

  // Redelivery changes nothing a second time, and is recognized as the same
  // dispute (round 2 M1): no second row, no exceeds-remainder path (the
  // netted remainder is 0 now, which used to read as an over-sized new one).
  sentryMessages.length = 0;
  assert.equal((await postWebhook(disputeEvent('charge.dispute.funds_withdrawn', f, disputeId))).status, 200);
  const again = (await pool.query('SELECT amount_paid FROM proposals WHERE id = $1', [f.proposalId])).rows[0];
  assert.equal(Number(again.amount_paid), 100);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM proposal_refunds WHERE stripe_refund_id = $1', [disputeId])).rows[0].n, 1);
  assert.ok(!sentryMessages.includes('dispute_withdrawal_exceeds_charge_remainder'), 'the redelivery did not read as a new over-sized dispute');
  const withdrawnRows = await pool.query(`SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'dispute_funds_withdrawn'`, [f.proposalId]);
  assert.equal(withdrawnRows.rows.length, 1, 'one withdrawal recorded');
});

test('funds reinstated: the money, the invoice and the status come back, the dispute row reads failed, the charge is refundable again', async () => {
  const f = await seed();
  const disputeId = `dp_${NONCE}_win_${f.proposalId}`;
  assert.equal((await postWebhook(disputeEvent('charge.dispute.funds_withdrawn', f, disputeId))).status, 200);
  const r = await postWebhook(disputeEvent('charge.dispute.funds_reinstated', f, disputeId));
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const row = (await pool.query('SELECT status, amount_paid, autopay_enrolled FROM proposals WHERE id = $1', [f.proposalId])).rows[0];
  assert.equal(Number(row.amount_paid), 1000);
  assert.equal(row.status, 'balance_paid');
  assert.equal(row.autopay_enrolled, false, 'not re-armed: the admin decides');
  const inv = (await pool.query('SELECT amount_due, amount_paid, status, locked FROM invoices WHERE id = $1', [f.balanceInvoiceId])).rows[0];
  assert.equal(Number(inv.amount_paid), 90000);
  assert.equal(inv.status, 'paid');
  assert.equal(inv.locked, true);
  const ledger = (await pool.query('SELECT status, reason FROM proposal_refunds WHERE stripe_refund_id = $1', [disputeId])).rows[0];
  assert.equal(ledger.status, 'failed');
  assert.match(ledger.reason, /funds reinstated/);
  const bal = (await loadPaymentsWithRemaining(f.proposalId)).find((c) => c.id === f.balancePaymentId);
  assert.equal(bal.remainingCents, 90000, 'the headroom is whole again');
  const reinstated = await pool.query(`SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'dispute_funds_reinstated'`, [f.proposalId]);
  assert.equal(reinstated.rows.length, 1);
});
