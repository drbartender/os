require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Known webhook secret so we can locally sign events the handler will verify.
const WEBHOOK_SECRET = 'whsec_test_optiongroup';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');
const { addAlternative } = require('../utils/proposalGroups');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.optionGroup.test.js refuses to run against production');
}

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

async function seedGroup({ eventDate = null } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('OG Test', $1) RETURNING id`,
    [`og-${NONCE}-${clientIds.length}@example.com`]);
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
  if (server) await new Promise((r) => server.close(r));
  const pids = proposalIds;
  if (pids.length) {
    await pool.query('DELETE FROM invoice_payments WHERE payment_id IN (SELECT id FROM proposal_payments WHERE proposal_id = ANY($1::int[]))', [pids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [pids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [pids]);
    await pool.query('UPDATE proposals SET group_id = NULL WHERE id = ANY($1::int[])', [pids]);
  }
  if (groupIds.length) await pool.query('DELETE FROM proposal_groups WHERE id = ANY($1::int[])', [groupIds]);
  if (pids.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [pids]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('grouped winner payment: loser archived, group decided, winner invoice created + linked', async () => {
  const { groupId, winnerId, loserId } = await seedGroup();
  const r = await postWebhook({
    id: `evt_${NONCE}_win`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_win`, amount: 10000, // $100 deposit == full for a $100 total
      metadata: { proposal_id: String(winnerId), payment_type: 'deposit' } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const winner = await one('SELECT status, amount_paid, group_id FROM proposals WHERE id = $1', [winnerId]);
  assert.equal(Number(winner.amount_paid), 100, 'winner credited');
  assert.ok(['deposit_paid', 'balance_paid'].includes(winner.status), `winner paid status, got ${winner.status}`);

  const loser = await one('SELECT status, archive_reason FROM proposals WHERE id = $1', [loserId]);
  assert.equal(loser.status, 'archived', 'loser archived');
  assert.equal(loser.archive_reason, 'option_not_chosen', 'loser archived for the right reason');

  const grp = await one('SELECT chosen_proposal_id FROM proposal_groups WHERE id = $1', [groupId]);
  assert.equal(grp.chosen_proposal_id, winnerId, 'group decided to the winner');

  // §7.1: the deferred winner invoice was created in-tx and the payment linked to it.
  const invCount = await one('SELECT COUNT(*)::int AS n FROM invoices WHERE proposal_id = $1', [winnerId]);
  assert.ok(invCount.n >= 1, 'winner has an invoice (deferred-then-created)');
  const linkCount = await one(
    `SELECT COUNT(*)::int AS n FROM invoice_payments ip JOIN invoices i ON i.id = ip.invoice_id WHERE i.proposal_id = $1`,
    [winnerId]);
  assert.ok(linkCount.n >= 1, 'winner payment linked to the winner invoice (no phantom/unlinked deposit)');
});

test('second option paying after the group is decided does NOT convert it', async () => {
  // Event ~tomorrow: inside the <=72h last-minute window, so absent the F1 guard
  // the conflicting loser payment below would flag last_minute_hold + blast SMS.
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { winnerId, loserId, groupId } = await seedGroup({ eventDate: tomorrow });
  // Winner settles first.
  await postWebhook({
    id: `evt_${NONCE}_w2`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_w2`, amount: 10000, metadata: { proposal_id: String(winnerId), payment_type: 'deposit' } } },
  });
  // Loser (already archived) receives a late payment.
  const r = await postWebhook({
    id: `evt_${NONCE}_l2`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_l2`, amount: 10000, metadata: { proposal_id: String(loserId), payment_type: 'deposit' } } },
  });
  assert.equal(r.status, 200, `webhook should still 200, got ${r.status} ${r.body}`);

  const loser = await one('SELECT status, amount_paid FROM proposals WHERE id = $1', [loserId]);
  assert.equal(loser.status, 'archived', 'loser stays archived (not converted)');
  assert.equal(Number(loser.amount_paid), 0, 'loser was NOT credited (archived status guard)');
  const grp = await one('SELECT chosen_proposal_id FROM proposal_groups WHERE id = $1', [groupId]);
  assert.equal(grp.chosen_proposal_id, winnerId, 'the winner stays the chosen option');
  const shifts = await one('SELECT COUNT(*)::int AS n FROM shifts WHERE proposal_id = $1', [loserId]);
  assert.equal(shifts.n, 0, 'no event shift created for the non-chosen option');

  // F1: the conflicting payment must not flag a last-minute hold on the loser
  // (event is ~tomorrow, so the window WOULD match absent the conflict guard).
  const hold = await one('SELECT last_minute_hold FROM proposals WHERE id = $1', [loserId]);
  assert.equal(hold.last_minute_hold, false, 'F1: no last-minute hold flagged on a non-chosen option');

  // F2: no dangling Balance invoice minted on the archived loser.
  const loserInv = await one(
    `SELECT COUNT(*)::int AS n FROM invoices WHERE proposal_id = $1 AND status <> 'void'`, [loserId]);
  assert.equal(loserInv.n, 0, 'F2: no non-void invoice on a non-chosen option');
});

// ── Ungrouped same-client sweep (no proposal_groups row involved) ────────────

async function seedUngroupedPair() {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('OG Sweep', $1) RETURNING id`,
    [`ogsweep-${NONCE}-${clientIds.length}@example.com`]);
  clientIds.push(c.rows[0].id);
  const mk = async (status, amountPaid) => {
    const p = await pool.query(
      `INSERT INTO proposals (client_id, status, total_price, deposit_amount, pricing_snapshot, amount_paid)
       VALUES ($1, $2, 100, 100, '{}'::jsonb, $3) RETURNING id`,
      [c.rows[0].id, status, amountPaid]);
    proposalIds.push(p.rows[0].id);
    return p.rows[0].id;
  };
  return { mk };
}

test('ungrouped same-client alternative is swept when an initial deposit settles', async () => {
  const { mk } = await seedUngroupedPair();
  const chosenId = await mk('sent', 0);
  const altId = await mk('draft', 0);

  const r = await postWebhook({
    id: `evt_${NONCE}_sw`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_sw`, amount: 10000, metadata: { proposal_id: String(chosenId), payment_type: 'deposit' } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const alt = await one('SELECT status, archive_reason FROM proposals WHERE id = $1', [altId]);
  assert.equal(alt.status, 'archived', 'the ungrouped alternative is swept');
  assert.equal(alt.archive_reason, 'option_not_chosen');
});

test('a balance payment does NOT sweep the client\'s other open proposals', async () => {
  const { mk } = await seedUngroupedPair();
  const bookedId = await mk('deposit_paid', 100); // already booked; balance still owed
  const nextEventDraftId = await mk('draft', 0);  // a legit new draft for their NEXT event

  const r = await postWebhook({
    id: `evt_${NONCE}_bal`, type: 'payment_intent.succeeded',
    data: { object: { id: `pi_${NONCE}_bal`, amount: 5000, metadata: { proposal_id: String(bookedId), payment_type: 'balance' } } },
  });
  assert.equal(r.status, 200, `webhook should 200, got ${r.status} ${r.body}`);

  const draft = await one('SELECT status FROM proposals WHERE id = $1', [nextEventDraftId]);
  assert.equal(draft.status, 'draft', 'a later balance payment never sweeps other proposals');
});
