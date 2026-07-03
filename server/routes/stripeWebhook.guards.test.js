require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Known webhook secret so the test can locally HMAC-sign events the handler's
// constructEvent verifies (no Stripe API call). Set before the router runs; the
// handler reads these env vars per-request.
const WEBHOOK_SECRET = 'whsec_test_guards';
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
  throw new Error('stripeWebhook.guards.test.js refuses to run against production');
}

// Two webhook guards:
//   FIX M9: checkout.session.completed with payment_status != 'paid' (a delayed-
//     settlement method whose funds are not yet captured) must ack WITHOUT recording
//     a proposal payment or running any side effect.
//   FIX L1: payment_intent.payment_failed that arrives AFTER a succeeded row for the
//     same PI (a stale, out-of-order retry) must ack WITHOUT flipping the session,
//     inserting a failed row, logging, or notifying the client.

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

async function seedProposal({ status = 'sent', totalPrice = 100, amountPaid = 0, eventDate = null } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('WH Guards', $1) RETURNING id`,
    [`wh-guards-${NONCE}-${clientIds.length}@example.com`]
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

before(async () => {
  const app = express();
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
  app.use('/api/stripe', stripeRouter);
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  // Let any post-commit fire-and-forget work (createEventShifts, notifications)
  // settle before teardown.
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

// ── FIX M9: checkout.session.completed delayed-settlement guard ──────────────

test('checkout.session.completed with payment_status "unpaid" records nothing', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_unpaid`;
  const linkId = `plink_${NONCE}_unpaid`;
  // Seed the pending link session so we can prove the guard does NOT flip it.
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_link_id, amount, status)
     VALUES ($1, $2, 10000, 'pending')`,
    [p, linkId]
  );

  const r = await postWebhook({
    id: `evt_${NONCE}_unpaid`, type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${NONCE}_unpaid`, object: 'checkout.session',
        payment_status: 'unpaid', amount_total: 10000, payment_intent: piId, payment_link: linkId,
        metadata: { proposal_id: String(p), payment_type: 'deposit' },
      },
    },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const pay = await one('SELECT COUNT(*)::int AS n FROM proposal_payments WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(pay.n, 0, 'no proposal_payments row recorded for an unpaid session');

  const prop = await one('SELECT status, amount_paid FROM proposals WHERE id = $1', [p]);
  assert.equal(prop.status, 'sent', 'proposal status unchanged');
  assert.equal(Number(prop.amount_paid), 0, 'amount_paid unchanged');

  const sess = await one('SELECT status FROM stripe_sessions WHERE stripe_payment_link_id = $1', [linkId]);
  assert.equal(sess.status, 'pending', 'link session NOT flipped to succeeded (no side effects)');
});

test('checkout.session.completed with payment_status "paid" DOES record (guard is specific)', async () => {
  const eventDate = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const p = await seedProposal({ eventDate });
  const piId = `pi_${NONCE}_paid`;
  const linkId = `plink_${NONCE}_paid`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_link_id, amount, status)
     VALUES ($1, $2, 10000, 'pending')`,
    [p, linkId]
  );

  const r = await postWebhook({
    id: `evt_${NONCE}_paid`, type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${NONCE}_paid`, object: 'checkout.session',
        payment_status: 'paid', amount_total: 10000, payment_intent: piId, payment_link: linkId,
        metadata: { proposal_id: String(p), payment_type: 'deposit' },
      },
    },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const pay = await one("SELECT COUNT(*)::int AS n FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = 'succeeded'", [piId]);
  assert.equal(pay.n, 1, 'a paid session records exactly one succeeded payment');
  const prop = await one('SELECT amount_paid FROM proposals WHERE id = $1', [p]);
  assert.equal(Number(prop.amount_paid), 100, 'amount_paid credited for a paid session');
});

// ── FIX L1: payment_intent.payment_failed monotonicity guard ─────────────────

test('payment_failed after a succeeded payment for the same PI does NOT flip the session or insert a failed row', async () => {
  const p = await seedProposal({ status: 'deposit_paid', amountPaid: 100 });
  const piId = `pi_${NONCE}_stale`;
  // Prior success: the succeeded proposal_payments row + a succeeded session.
  await pool.query(
    `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
     VALUES ($1, $2, 'deposit', 10000, 'succeeded')`,
    [p, piId]
  );
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 10000, 'succeeded')`,
    [p, piId]
  );

  const r = await postWebhook({
    id: `evt_${NONCE}_stale`, type: 'payment_intent.payment_failed',
    data: {
      object: {
        id: piId, amount: 10000, metadata: { proposal_id: String(p), payment_type: 'deposit' },
        last_payment_error: { message: 'stale failure delivered after success' },
      },
    },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const failed = await one("SELECT COUNT(*)::int AS n FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = 'failed'", [piId]);
  assert.equal(failed.n, 0, 'no failed proposal_payments row inserted after a success');

  const sess = await one('SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'succeeded', 'session NOT flipped to failed');

  const log = await one("SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_failed'", [p]);
  assert.equal(log.n, 0, 'no payment_failed activity log entry');

  const clientNotify = await one("SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_failed_email_client'", [p]);
  assert.equal(clientNotify.n, 0, 'no client-facing failure notification claimed');
});

test('payment_failed with NO prior success DOES record the failure (guard is specific)', async () => {
  const p = await seedProposal({ status: 'deposit_paid', amountPaid: 100 });
  const piId = `pi_${NONCE}_realfail`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 10000, 'pending')`,
    [p, piId]
  );

  const r = await postWebhook({
    id: `evt_${NONCE}_realfail`, type: 'payment_intent.payment_failed',
    data: {
      object: {
        id: piId, amount: 10000, metadata: { proposal_id: String(p), payment_type: 'deposit' },
        last_payment_error: { message: 'your card was declined' },
      },
    },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const failed = await one("SELECT COUNT(*)::int AS n FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = 'failed'", [piId]);
  assert.equal(failed.n, 1, 'a genuine failure records a failed proposal_payments row');
  const sess = await one('SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'failed', 'session flipped to failed for a genuine failure');
  const log = await one("SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_failed'", [p]);
  assert.equal(log.n, 1, 'payment_failed activity log recorded');
});
