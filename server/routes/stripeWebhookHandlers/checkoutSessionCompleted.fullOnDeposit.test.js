// The third entrance (spec 2026-08-28 §4c). An admin-issued Stripe payment
// link inside the 14-day window carries payment_type 'full' and settles
// through checkout.session.completed, whose invoice integration links
// label-blind exactly like payment_intent.succeeded. Same helper, same guard,
// same one-invoice shape afterwards. Harness mirrors
// checkoutSessionCompleted.lastMinute.test.js: a signed event through the
// real webhook route.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
process.env.SENTRY_DSN_SERVER = '';
const WEBHOOK_SECRET = 'whsec_test_fullondeposit';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('checkoutSessionCompleted.fullOnDeposit.test.js refuses to run against production');
}

require('../../utils/email').sendEmail = async () => ({ skipped: true });
require('../../utils/adminNotifications').notifyAdminCategory = async () => ({ emailed: 0, texted: 0 });
require('../../utils/eventCreation').createEventShifts = async () => null;
require('../../utils/marketingHandlers').onProposalSignedAndPaid = async () => {};
require('../../utils/marketingHandlers').cancelMarketingForProposal = async () => {};
require('../../utils/depositPaidSchedulers').scheduleDepositPaidReminders = async () => {};
require('../../utils/stripePaymentNotifications').sendPaymentNotifications = async () => {};
require('../../utils/lastMinuteAlert').notifyLastMinuteBooking = () => {};
const overflowCalls = [];
require('../../utils/invoiceHelpers').notifyLinkOverflow = async (args) => { overflowCalls.push(args); };

const stripeRouter = require('../stripe');

// Base-36 timestamp, not `${Date.now()}-${hex}`: invoice_number is
// varchar(20) and `LFD` + the long form overflows it in seed(). Same shape
// the paymentIntentSucceeded.fullOnDeposit harness uses.
const NONCE = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
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
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length, 'stripe-signature': sig },
    }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject);
    r.write(buf); r.end();
  });
}

function linkEvent({ id, proposalId, paymentType, amountTotal }) {
  return {
    id: `evt_${id}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${id}`,
        payment_status: 'paid',
        payment_intent: `pi_${id}`,
        payment_link: `plink_${id}`,
        amount_total: amountTotal,
        customer_details: { email: `link-${id}@example.com` },
        metadata: { proposal_id: String(proposalId), payment_type: paymentType },
      },
    },
  };
}

async function seed({ paymentType }) {
  const c = await pool.query(`INSERT INTO clients (name, email) VALUES ('Link Full On Deposit', $1) RETURNING id`, [`lfod-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, external_paid, pricing_snapshot,
                            event_date, event_start_time, event_duration_hours, event_type, payment_type, balance_due_date)
     VALUES ($1, 'sent', 550, 0, 100, 0, '{"package": {"name": "The Core Reaction", "base_cost": 350}, "total": 550}'::jsonb,
             CURRENT_DATE + INTERVAL '30 days', '6:00 PM', 4, 'Cocktail Party', $2, CURRENT_DATE + INTERVAL '16 days')
     RETURNING id`,
    [c.rows[0].id, paymentType]
  );
  proposalIds.push(p.rows[0].id);
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Deposit', 10000, 0, 'sent', false)`,
    [p.rows[0].id, `LFD${NONCE}${proposalIds.length}`]
  );
  return p.rows[0].id;
}

const contractInvoices = async (proposalId) => (await pool.query(
  `SELECT id, label, amount_due, amount_paid, status, locked FROM invoices
    WHERE proposal_id = $1 AND status <> 'void' AND label IN ('Deposit', 'Balance', 'Full Payment') ORDER BY id`, [proposalId]
)).rows;

before(async () => {
  const app = express();
  // The raw-body mount lives in server/index.js:214, NOT in the stripe router.
  // Without it req.body is undefined, constructEvent throws, and the webhook
  // route 400s before the handler runs. Mirrors the lastMinute harness.
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Let un-awaited post-commit work land before teardown (the reference
  // harness does the same). The scheduleDepositPaidReminders stub above is
  // what makes it safe to skip the reference test's handler registration;
  // do not drop that stub.
  await new Promise((r) => setTimeout(r, 400));
  if (server) await new Promise((r) => server.close(r));
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('a FULL payment link on deposit terms ends with one Full Payment invoice at the capture, paid, locked', async () => {
  const proposalId = await seed({ paymentType: 'deposit' });
  const r = await postWebhook(linkEvent({ id: `${NONCE}-a`, proposalId, paymentType: 'full', amountTotal: 55000 }));
  assert.equal(r.status, 200, r.body);
  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 1, JSON.stringify(invs));
  assert.equal(invs[0].label, 'Full Payment');
  assert.equal(Number(invs[0].amount_due), 55000);
  assert.equal(Number(invs[0].amount_paid), 55000);
  assert.equal(invs[0].status, 'paid');
  assert.equal(invs[0].locked, true);
  const prop = (await pool.query('SELECT status, amount_paid, payment_type FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.equal(prop.status, 'balance_paid');
  assert.equal(Number(prop.amount_paid), 550);
  assert.equal(prop.payment_type, 'full');
  assert.equal(overflowCalls.length, 0);
});

test('a DEPOSIT payment link on the same shape is unchanged', async () => {
  const proposalId = await seed({ paymentType: 'deposit' });
  const r = await postWebhook(linkEvent({ id: `${NONCE}-b`, proposalId, paymentType: 'deposit', amountTotal: 10000 }));
  assert.equal(r.status, 200, r.body);
  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 2, JSON.stringify(invs));
  assert.ok(invs.find((i) => i.label === 'Deposit' && i.status === 'paid'));
  assert.ok(invs.find((i) => i.label === 'Balance' && Number(i.amount_due) === 45000));
});

// A payment link is fixed at creation and reused while it stays active, so a
// FULL link can capture LESS than the proposal's current total. The upgraded
// Full Payment invoice already carries the whole remainder; a Balance minted
// on top of it bills that remainder a second time.
test('a FULL payment link that captures LESS than the total leaves one partially paid Full Payment invoice and mints no Balance', async () => {
  const proposalId = await seed({ paymentType: 'deposit' });
  const r = await postWebhook(linkEvent({ id: `${NONCE}-c`, proposalId, paymentType: 'full', amountTotal: 50000 }));
  assert.equal(r.status, 200, r.body);
  const invs = await contractInvoices(proposalId);
  assert.equal(invs.length, 1, JSON.stringify(invs));
  assert.equal(invs[0].label, 'Full Payment');
  assert.equal(Number(invs[0].amount_due), 55000);
  assert.equal(Number(invs[0].amount_paid), 50000);
  assert.equal(invs[0].status, 'partially_paid');
  assert.equal(invs[0].locked, false);
  const prop = (await pool.query('SELECT status, amount_paid FROM proposals WHERE id = $1', [proposalId])).rows[0];
  assert.equal(prop.status, 'deposit_paid');
  assert.equal(Number(prop.amount_paid), 500);
  const balances = await pool.query(`SELECT id, status, amount_due FROM invoices WHERE proposal_id = $1 AND label = 'Balance'`, [proposalId]);
  assert.equal(balances.rows.length, 0, JSON.stringify(balances.rows));
});
