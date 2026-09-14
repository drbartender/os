// server/routes/stripeWebhook.processing.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const WEBHOOK_SECRET = 'whsec_test_processing';
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
  throw new Error('stripeWebhook.processing.test.js refuses to run against production');
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
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

async function seedProposal() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('WH Processing', $1) RETURNING id`,
    [`wh-proc-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, pricing_snapshot, event_timezone)
     VALUES ($1, 'deposit_paid', 500, 100, 100, '{}'::jsonb, 'America/Chicago') RETURNING id`,
    [c.rows[0].id]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

async function seedInvoice(proposalId) {
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Balance', 40000, 0, 'sent') RETURNING id`,
    // invoices.invoice_number is VARCHAR(20); NONCE plus the id overruns it (22001).
    [proposalId, crypto.randomUUID(), `INV-${crypto.randomBytes(6).toString('hex')}`]
  );
  return r.rows[0].id;
}

async function seedSession(proposalId, piId, status = 'pending') {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 40000, $3)`,
    [proposalId, piId, status]
  );
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

function processingEvent({ id, piId, proposalId, invoiceId, livemode = true }) {
  return {
    id, type: 'payment_intent.processing', livemode,
    data: { object: {
      id: piId, object: 'payment_intent', amount: 40000, status: 'processing',
      metadata: { proposal_id: String(proposalId), payment_type: 'invoice', ...(invoiceId ? { invoice_id: String(invoiceId) } : {}) },
    } },
  };
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
  await pool.query("DELETE FROM webhook_events WHERE provider = 'stripe' AND event_id LIKE $1", [`evt_${NONCE}%`]);
  if (proposalIds.length) {
    const ids = proposalIds;
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('processing flips a pending row, stamps processing_at and an owned invoice_id, logs once', async () => {
  const p = await seedProposal();
  const inv = await seedInvoice(p);
  const piId = `pi_${NONCE}_flip`;
  await seedSession(p, piId);

  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_flip`, piId, proposalId: p, invoiceId: inv }));
  assert.equal(r.status, 200, r.body);

  const sess = await one('SELECT status, processing_at, invoice_id FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'processing');
  assert.ok(sess.processing_at, 'processing_at stamped');
  assert.equal(Number(sess.invoice_id), inv);

  const log = await one(`SELECT COUNT(*)::int AS n, MAX(details->>'invoice_id') AS inv FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_processing'`, [p]);
  assert.equal(log.n, 1);
  assert.equal(Number(log.inv), inv);
});

test('a redelivery is a no-op: status unchanged, still exactly one activity row', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_redeliver`;
  await seedSession(p, piId);
  await postWebhook(processingEvent({ id: `evt_${NONCE}_rd1`, piId, proposalId: p }));
  const first = await one('SELECT processing_at FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  await new Promise((r) => setTimeout(r, 20));
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_rd2`, piId, proposalId: p }));
  assert.equal(r.status, 200);
  const again = await one('SELECT status, processing_at FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(again.status, 'processing');
  assert.equal(String(again.processing_at), String(first.processing_at), 'processing_at not restamped');
  const log = await one(`SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_processing'`, [p]);
  assert.equal(log.n, 1);
});

test('a processing event after succeeded never downgrades the row', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_late`;
  await seedSession(p, piId, 'succeeded');
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_late`, piId, proposalId: p }));
  assert.equal(r.status, 200);
  const sess = await one('SELECT status, processing_at FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'succeeded');
  assert.equal(sess.processing_at, null);
  const log = await one(`SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_processing'`, [p]);
  assert.equal(log.n, 0);
});

test('an invoice_id that belongs to another proposal is stored as NULL', async () => {
  const p = await seedProposal();
  const other = await seedProposal();
  const foreignInv = await seedInvoice(other);
  const piId = `pi_${NONCE}_foreign`;
  await seedSession(p, piId);
  await postWebhook(processingEvent({ id: `evt_${NONCE}_foreign`, piId, proposalId: p, invoiceId: foreignInv }));
  const sess = await one('SELECT status, invoice_id FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'processing');
  assert.equal(sess.invoice_id, null);
});

test('a missing row is inserted as processing so the guard can see an intent minted outside the app', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_missing`;
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_missing`, piId, proposalId: p }));
  assert.equal(r.status, 200);
  const sess = await one('SELECT proposal_id, amount, status, processing_at FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(Number(sess.proposal_id), p);
  assert.equal(Number(sess.amount), 40000);
  assert.equal(sess.status, 'processing');
  assert.ok(sess.processing_at);
});

test('a livemode:false event outside a test window is dropped by the dispatcher gate', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_testmode`;
  await seedSession(p, piId);
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_testmode`, piId, proposalId: p, livemode: false }));
  assert.equal(r.status, 200);
  assert.match(r.body, /test_mode/);
  const sess = await one('SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'pending');
});

test('an event with no proposal_id is acked and writes nothing', async () => {
  const piId = `pi_${NONCE}_noprop`;
  const r = await postWebhook({
    id: `evt_${NONCE}_noprop`, type: 'payment_intent.processing', livemode: true,
    data: { object: { id: piId, object: 'payment_intent', amount: 100, status: 'processing', metadata: {} } },
  });
  assert.equal(r.status, 200);
  const sess = await one('SELECT COUNT(*)::int AS n FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.n, 0);
});

test('a FAILED row moves to processing: a declined card retried as a bank debit on the same intent', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_after_fail`;
  await seedSession(p, piId, 'failed');
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_after_fail`, piId, proposalId: p }));
  assert.equal(r.status, 200, r.body);
  const sess = await one('SELECT status, processing_at FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'processing');
  assert.ok(sess.processing_at);
  const log = await one(`SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_processing'`, [p]);
  assert.equal(log.n, 1);
});

test('an event whose metadata names a different proposal than the row never moves that row', async () => {
  const owner = await seedProposal();
  const other = await seedProposal();
  const piId = `pi_${NONCE}_xprop`;
  await seedSession(owner, piId);
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_xprop`, piId, proposalId: other }));
  assert.equal(r.status, 200);
  const sess = await one('SELECT proposal_id, status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(Number(sess.proposal_id), owner);
  assert.equal(sess.status, 'pending');
  const log = await one(`SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = ANY($1::int[]) AND action = 'payment_processing'`, [[owner, other]]);
  assert.equal(log.n, 0);
});

test('the same event id delivered twice is a no-op the second time, even after the row was released', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_replay`;
  await seedSession(p, piId);
  const evt = processingEvent({ id: `evt_${NONCE}_replay`, piId, proposalId: p });
  assert.equal((await postWebhook(evt)).status, 200);
  // The debit bounces: payment_failed releases the row.
  await pool.query("UPDATE stripe_sessions SET status = 'failed' WHERE stripe_payment_intent_id = $1", [piId]);
  // Stripe redelivers the original processing event.
  assert.equal((await postWebhook(evt)).status, 200);
  const sess = await one('SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'failed', 'a replay must not resurrect a released row');
  const log = await one(`SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_processing'`, [p]);
  assert.equal(log.n, 1);
});

test('a failed row that had already processed (a bounced debit) never moves back to processing', async () => {
  const p = await seedProposal();
  const piId = `pi_${NONCE}_bounced`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at)
     VALUES ($1, $2, 40000, 'failed', NOW() - INTERVAL '3 days')`,
    [p, piId]
  );
  const r = await postWebhook(processingEvent({ id: `evt_${NONCE}_bounced_new`, piId, proposalId: p }));
  assert.equal(r.status, 200);
  const sess = await one('SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [piId]);
  assert.equal(sess.status, 'failed');
  const log = await one(`SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'payment_processing'`, [p]);
  assert.equal(log.n, 0);
});
