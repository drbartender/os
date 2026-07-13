require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Known webhook secret so the test can locally HMAC-sign events the handler's
// constructEvent verifies (no Stripe API call). Set before the router runs.
const WEBHOOK_SECRET = 'whsec_test_lastminutelink';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../../db');

// Spy on the last-minute SMS blast BEFORE the router (and thus the handler,
// which destructures this export at module-load) is required. SEND_NOTIFICATIONS
// is already 'false' so no real SMS would fire, but the spy also lets us assert
// the fire-and-forget blast happens exactly once per first delivery.
const lastMinuteAlert = require('../../utils/lastMinuteAlert');
const notifyCalls = [];
lastMinuteAlert.notifyLastMinuteBooking = (proposalId) => { notifyCalls.push(String(proposalId)); };

const stripeRouter = require('../stripe');
const { addAlternative } = require('../../utils/proposalGroups');

if (process.env.NODE_ENV === 'production') {
  throw new Error('checkoutSessionCompleted.lastMinute.test.js refuses to run against production');
}

// M2: a proposal settled via an admin Payment Link (checkout.session.completed)
// must join the last-minute (<=72h) staffing path exactly as payment_intent.succeeded
// does. Covers: (a) <72h link settlement flags last_minute_hold + blasts once;
// (b) >72h does not; (c) webhook redelivery does not re-flag or re-blast;
// (d) a settlement on a non-chosen (conflict) option never flags a hold.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];
const groupIds = [];

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

// A checkout.session.completed for a proposal Payment-Link settlement.
function linkEvent({ id, proposalId, paymentType = 'deposit', amountTotal = 10000, paymentIntent }) {
  return {
    id: `evt_${id}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${id}`,
        payment_status: 'paid',
        payment_intent: paymentIntent || `pi_${id}`,
        payment_link: `plink_${id}`,
        amount_total: amountTotal,
        customer_details: { email: `link-${id}@example.com` },
        metadata: { proposal_id: String(proposalId), payment_type: paymentType },
      },
    },
  };
}

// daysOut > 0 = future; a fractional value lands inside the <=72h window.
function eventDateFrom(daysOut) {
  return new Date(Date.now() + daysOut * 24 * 3600 * 1000).toISOString().slice(0, 10);
}

async function seedProposal({ eventDate = null, eventStartTime = null, status = 'sent' } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('LM Link', $1) RETURNING id`,
    [`lmlink-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, deposit_amount, pricing_snapshot, event_date, event_start_time)
     VALUES ($1, $2, 100, 100, '{}'::jsonb, $3, $4) RETURNING id`,
    [c.rows[0].id, status, eventDate, eventStartTime]);
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

// A grouped pair (winner + one alternative) mirroring the optionGroup harness.
async function seedGroup({ eventDate = null } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('LM Group', $1) RETURNING id`,
    [`lmgroup-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, deposit_amount, pricing_snapshot, event_date)
     VALUES ($1, 'sent', 100, 100, '{}'::jsonb, $2) RETURNING id`, [c.rows[0].id, eventDate]);
  proposalIds.push(p.rows[0].id);
  const { groupId, newProposalId } = await addAlternative(p.rows[0].id, null, pool);
  groupIds.push(groupId);
  proposalIds.push(newProposalId);
  return { groupId, winnerId: p.rows[0].id, loserId: newProposalId };
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
  // Allow the webhook's fire-and-forget post-commit work (createEventShifts,
  // notifications) to settle before teardown.
  await new Promise((r) => setTimeout(r, 400));
  if (server) await new Promise((r) => server.close(r));
  const pids = proposalIds;
  if (pids.length) {
    await pool.query('DELETE FROM invoice_payments WHERE payment_id IN (SELECT id FROM proposal_payments WHERE proposal_id = ANY($1::int[]))', [pids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [pids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = ANY($2::int[])', ['proposal', pids]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = ANY($1::int[]))', [pids]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('UPDATE proposals SET group_id = NULL WHERE id = ANY($1::int[])', [pids]);
  }
  if (groupIds.length) await pool.query('DELETE FROM proposal_groups WHERE id = ANY($1::int[])', [groupIds]);
  if (pids.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [pids]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('(a) link settlement on a <72h-out event flags last_minute_hold and blasts once', async () => {
  const p = await seedProposal({ eventDate: eventDateFrom(1) }); // ~24-48h out
  const r = await postWebhook(linkEvent({ id: `${NONCE}_lm`, proposalId: p }));
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const row = await one('SELECT last_minute_hold, amount_paid FROM proposals WHERE id = $1', [p]);
  assert.equal(row.last_minute_hold, true, 'last_minute_hold flagged for the <72h link settlement');
  assert.equal(Number(row.amount_paid), 100, 'deposit still credited');
  assert.equal(notifyCalls.filter((id) => id === String(p)).length, 1, 'staff blast fired exactly once');
});

test('(b) link settlement on a >72h-out event does NOT flag last_minute_hold', async () => {
  const p = await seedProposal({ eventDate: eventDateFrom(10) }); // ~240h out
  const r = await postWebhook(linkEvent({ id: `${NONCE}_far`, proposalId: p }));
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const row = await one('SELECT last_minute_hold FROM proposals WHERE id = $1', [p]);
  assert.equal(row.last_minute_hold, false, 'no hold flagged outside the 72h window');
  assert.equal(notifyCalls.filter((id) => id === String(p)).length, 0, 'no staff blast fired');
});

test('(c) webhook redelivery does not re-flag or re-blast', async () => {
  const p = await seedProposal({ eventDate: eventDateFrom(1) });
  const ev = linkEvent({ id: `${NONCE}_redeliver`, proposalId: p });

  const r1 = await postWebhook(ev);
  assert.equal(r1.status, 200, `first delivery should 200, got ${r1.status} ${r1.body}`);
  // Redeliver the SAME event (same payment_intent → duplicate, isFirstDelivery=false).
  const r2 = await postWebhook(ev);
  assert.equal(r2.status, 200, `redelivery should 200, got ${r2.status} ${r2.body}`);

  const row = await one('SELECT last_minute_hold, amount_paid FROM proposals WHERE id = $1', [p]);
  assert.equal(row.last_minute_hold, true, 'hold set on first delivery');
  assert.equal(Number(row.amount_paid), 100, 'amount_paid credited once, not twice (idempotent)');
  assert.equal(notifyCalls.filter((id) => id === String(p)).length, 1, 'blast fired once across both deliveries');
});

test('(d) a settlement on a non-chosen (conflict) option never flags a hold', async () => {
  // Event ~tomorrow: inside the <=72h window, so absent the !conflict guard the
  // late loser settlement below would flag last_minute_hold + blast SMS.
  const { winnerId, loserId } = await seedGroup({ eventDate: eventDateFrom(1) });
  // Winner settles first (this decides the group + archives the loser).
  await postWebhook(linkEvent({ id: `${NONCE}_gw`, proposalId: winnerId }));
  // Loser (now archived) receives a late Payment-Link settlement.
  const r = await postWebhook(linkEvent({ id: `${NONCE}_gl`, proposalId: loserId }));
  assert.equal(r.status, 200, `webhook should still 200, got ${r.status} ${r.body}`);

  const loser = await one('SELECT status, last_minute_hold FROM proposals WHERE id = $1', [loserId]);
  assert.equal(loser.status, 'archived', 'loser stays archived (not converted)');
  assert.equal(loser.last_minute_hold, false, 'no last-minute hold flagged on the non-chosen option');
  assert.equal(notifyCalls.filter((id) => id === String(loserId)).length, 0, 'no staff blast for the non-chosen option');
});
