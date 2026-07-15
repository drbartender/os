require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Known webhook secret so the test can locally HMAC-sign events the handler's
// constructEvent verifies (no Stripe API call). Set before the router runs; the
// handler reads these env vars per-request. Force "not a test window" and post
// livemode:true events so the live-mode gate (stripeWebhook.js) processes them.
const WEBHOOK_SECRET = 'whsec_test_archivedsettle';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';
process.env.STRIPE_TEST_MODE_UNTIL = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.archivedSettle.test.js refuses to run against production');
}

// B3 piece 2: a payment that settles onto an already-archived (cancelled)
// proposal must still credit (blocking it would strand charged money and break
// the /cancel/refund recompute pickup) BUT now leaves a signal: an in-tx
// proposal_activity_log action='payment_on_archived' row (+ a post-commit Sentry
// warning + admin email, not asserted here). RED before the fix: the credit
// lands but no 'payment_on_archived' row exists.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];
const invoiceIds = [];

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

async function seedArchivedProposal({ totalPrice = 1000, amountPaid = 100 } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('WH Archived Settle', $1) RETURNING id`,
    [`wh-archset-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, status, total_price, amount_paid, deposit_amount, pricing_snapshot,
        archive_reason, cancelled_at)
     VALUES ($1, 'archived', $2, $3, 100, '{}'::jsonb, 'client_cancelled', NOW())
     RETURNING id`,
    [c.rows[0].id, totalPrice, amountPaid]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedInvoice(proposalId, { status = 'partially_paid', amountDue = 50000, amountPaid = 10000 } = {}) {
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Balance', $3, $4, $5) RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, amountDue, amountPaid, status]
  );
  invoiceIds.push(inv.rows[0].id);
  return inv.rows[0].id;
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
  // Let post-commit fire-and-forget work (Sentry, notifyAdminCategory, shifts) settle.
  await new Promise((r) => setTimeout(r, 500));
  if (server) await new Promise((r) => server.close(r));
  await pool.query("DELETE FROM webhook_events WHERE provider = 'stripe' AND event_id LIKE $1", [`evt_${NONCE}%`]);
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

// ── TEST B: payment_intent.succeeded (invoice rail) onto an archived proposal ──

test('payment_intent.succeeded invoice payment on archived proposal STILL credits, and logs payment_on_archived', async () => {
  const p = await seedArchivedProposal({ totalPrice: 1000, amountPaid: 100 });
  const inv = await seedInvoice(p, { status: 'partially_paid', amountDue: 50000, amountPaid: 10000 });
  const piId = `pi_${NONCE}_invoice`;

  const r = await postWebhook({
    id: `evt_${NONCE}_invoice`, type: 'payment_intent.succeeded', livemode: true,
    data: {
      object: {
        id: piId, amount: 40000,
        metadata: { proposal_id: String(p), invoice_id: String(inv), payment_type: 'invoice' },
      },
    },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  // (1) Credit NOT blocked — pins the money-lands invariant.
  const pay = await one("SELECT COUNT(*)::int AS n FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = 'succeeded'", [piId]);
  assert.equal(pay.n, 1, 'a succeeded proposal_payments row was recorded');
  const prop = await one('SELECT amount_paid FROM proposals WHERE id = $1', [p]);
  assert.equal(Number(prop.amount_paid), 500, 'amount_paid incremented by $400 (100 -> 500) even on an archived proposal');

  // (2) Invoice credited via the link.
  const invRow = await one('SELECT amount_paid FROM invoices WHERE id = $1', [inv]);
  assert.equal(Number(invRow.amount_paid), 50000, 'invoice credited to fully paid via linkPaymentToInvoice');

  // (3) The new alert breadcrumb.
  const log = await one("SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_on_archived'", [p]);
  assert.equal(log.n, 1, "a 'payment_on_archived' activity-log row exists for the archived settle");
});

// ── TEST C: checkout.session.completed (Payment-Link rail) onto archived ──

test('checkout.session.completed on archived proposal logs payment_on_archived and does NOT change amount_paid', async () => {
  const p = await seedArchivedProposal({ totalPrice: 1000, amountPaid: 100 });
  await seedInvoice(p, { status: 'sent', amountDue: 50000, amountPaid: 0 });
  const piId = `pi_${NONCE}_checkout`;
  const linkId = `plink_${NONCE}_checkout`;

  const r = await postWebhook({
    id: `evt_${NONCE}_checkout`, type: 'checkout.session.completed', livemode: true,
    data: {
      object: {
        id: `cs_${NONCE}_checkout`, object: 'checkout.session',
        payment_status: 'paid', amount_total: 40000, payment_intent: piId, payment_link: linkId,
        metadata: { proposal_id: String(p), payment_type: 'deposit' },
      },
    },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  // Credit is already excluded on this rail (status NOT IN ... 'archived'):
  // amount_paid must be unchanged. The payment row still records.
  const pay = await one("SELECT COUNT(*)::int AS n FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = 'succeeded'", [piId]);
  assert.equal(pay.n, 1, 'a succeeded proposal_payments row was recorded on the link rail');
  const prop = await one('SELECT amount_paid FROM proposals WHERE id = $1', [p]);
  assert.equal(Number(prop.amount_paid), 100, 'amount_paid unchanged (archived exclusion on the link rail preserved)');

  // The new alert breadcrumb.
  const log = await one("SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_on_archived'", [p]);
  assert.equal(log.n, 1, "a 'payment_on_archived' activity-log row exists for the checkout settle");
});
