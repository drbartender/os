require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
// Known webhook secret so the test can locally HMAC-sign events the handler's
// constructEvent verifies (no Stripe API call). Set before the router runs; the
// handler reads these env vars per-request. STRIPE_WEBHOOK_SECRET_TEST must be
// EMPTY: otherwise the dispatch-level test-mode gate in stripeWebhook.js
// ack-and-drops the event ({received:true, skipped:'test_mode'}) and every
// assertion below fails for the wrong reason.
const WEBHOOK_SECRET = 'whsec_test_gratuityapply';
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
  throw new Error('stripeWebhook.gratuityApply.test.js refuses to run against production');
}

// Election-at-payment (spec 2026-08-03). create-intent no longer persists the
// client's tip-jar election; it rides the PaymentIntent metadata. This suite
// pins the webhook side: on FIRST delivery of a deposit/full intent carrying
// tip_jar/gratuity_rate, the proposal's gratuity is applied BEFORE the credit
// and BEFORE createBalanceInvoice, exactly once, and never when metadata is
// absent (balance / invoice / drink-plan / legacy / admin payment links).

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl;
const proposalIds = [];
const clientIds = [];

// Same snapshot shape as the create-intent suite: the frozen gratuity basis
// resolves 1 staff x 5h, so a $50/staff/hr rate is a $250 gratuity line.
const SNAPSHOT = {
  total: 450,
  breakdown: [{ label: 'The Core Reaction (5hrs, 50 guests)', amount: 450 }],
  staffing: { actual: 1 },
  staff_noun: 'bartender',
  gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 5, staff_noun: 'bartender', total: 0 },
};

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

async function seedProposal({ snapshot = SNAPSHOT } = {}) {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('Grat Apply Test', $1) RETURNING id`,
    [`grat-apply-${NONCE}-${clientIds.length}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid,
                            tip_jar, gratuity_rate, event_date, event_duration_hours,
                            pricing_snapshot, token)
     VALUES ($1, 'viewed', 'wedding', 450, 0, true, 0,
             CURRENT_DATE + INTERVAL '60 days', 5, $2, $3)
     RETURNING id`,
    [c.rows[0].id, JSON.stringify(snapshot), crypto.randomUUID()]
  );
  proposalIds.push(p.rows[0].id);
  return p.rows[0].id;
}

function intentEvent({ proposalId, amount, paymentType, meta = {}, piId }) {
  return {
    id: `evt_${piId}`, type: 'payment_intent.succeeded',
    data: { object: { id: piId, amount, payment_method: null,
      metadata: { proposal_id: String(proposalId), payment_type: paymentType, ...meta } } },
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
  // Let fire-and-forget post-commit work (createEventShifts, notifications) settle.
  await new Promise((r) => setTimeout(r, 600));
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

test('deposit with skip-jar metadata: election applied before credit + balance invoice', async () => {
  const id = await seedProposal();
  const res = await postWebhook(intentEvent({ proposalId: id, amount: 10000, paymentType: 'deposit',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId: `pi_grat_dep_${NONCE}` }));
  assert.equal(res.status, 200, res.body);
  const p = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price, amount_paid, status, pricing_snapshot FROM proposals WHERE id = $1',
    [id])).rows[0];
  assert.equal(p.tip_jar, false);
  assert.equal(Number(p.gratuity_rate), 50);
  assert.equal(Number(p.total_price), 700, 'gratuity folded into total at payment');
  assert.equal(Number(p.amount_paid), 100);
  assert.equal(p.status, 'deposit_paid');
  assert.equal(Number(p.pricing_snapshot.gratuity.total), 250);
  assert.ok(p.pricing_snapshot.breakdown.some(l => l.label === 'Gratuity'));
  const inv = (await pool.query(
    "SELECT amount_due FROM invoices WHERE proposal_id = $1 AND label = 'Balance'", [id])).rows[0];
  assert.equal(Number(inv.amount_due), 60000, 'balance invoice = (700 - 100) in cents');
});

test('full-pay with metadata: balance_paid at the gratuity-inclusive total', async () => {
  const id = await seedProposal();
  await postWebhook(intentEvent({ proposalId: id, amount: 70000, paymentType: 'full',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId: `pi_grat_full_${NONCE}` }));
  const p = (await pool.query(
    'SELECT total_price, amount_paid, status FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(Number(p.total_price), 700);
  assert.equal(Number(p.amount_paid), 700);
  assert.equal(p.status, 'balance_paid');
});

test('no election metadata: gratuity untouched (balance/invoice/legacy path)', async () => {
  const id = await seedProposal();
  await postWebhook(intentEvent({ proposalId: id, amount: 10000, paymentType: 'deposit',
    piId: `pi_grat_none_${NONCE}` }));
  const p = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(p.tip_jar, true);
  assert.equal(Number(p.gratuity_rate), 0);
  assert.equal(Number(p.total_price), 450);
});

test('full-pay onto an existing pre-gratuity Full Payment invoice: link caps, overflow logged', async () => {
  // Pre-existing behavior surfaced deliberately (review finding): a non-grouped
  // proposal gets a 'Full Payment' invoice minted AT SEND for the pre-gratuity
  // total. Raising total_price in-tx then linking the 70000c charge hits the
  // cap in linkPaymentToInvoice and logs invoice_link_overflow_capped. This
  // test freezes that behavior so it is a decision, not a surprise.
  //
  // DEVIATION FROM PLAN (recorded, not weakened): the plan seeded the invoice
  // with status 'open', which the invoices CHECK constraint rejects
  // (draft|sent|paid|partially_paid|void). 'sent' is what createInvoiceOnSend
  // actually writes, and it is what linkPaymentToInvoice will credit, so the
  // seed uses the real status. The asserted outcome is unchanged.
  const id = await seedProposal();
  const invToken = crypto.randomUUID();
  await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Full Payment', 45000, 0, 'sent')`,
    [id, invToken, `INV${crypto.randomBytes(5).toString('hex')}`]);
  await postWebhook(intentEvent({ proposalId: id, amount: 70000, paymentType: 'full',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId: `pi_grat_inv_${NONCE}` }));
  const p = (await pool.query(
    'SELECT total_price, amount_paid, status FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(Number(p.total_price), 700);
  assert.equal(Number(p.amount_paid), 700);
  const inv = (await pool.query(
    "SELECT amount_paid FROM invoices WHERE proposal_id = $1 AND label = 'Full Payment'", [id])).rows[0];
  assert.equal(Number(inv.amount_paid), 45000, 'link capped at the invoice amount_due');
});

// ── Fix round 1: the payment must never be hostage to the gratuity apply ─────

test('sub-floor rate metadata: payment IS recorded, gratuity apply SKIPPED', async () => {
  // THE BLOCKER REGRESSION TEST (merge fleet, cross-confirmed x3). Before the
  // engine fix a crafted gratuity_total of 249.999 on a 1 staff x 5h basis
  // cleared deriveGratuityRate's half-cent total tolerance and derived rate
  // 49.9998 with tip_jar=false. create-intent charged it; the webhook apply then
  // violated proposals_gratuity_jar_check INSIDE the payment-recording
  // transaction, rolling back the proposal_payments idempotency insert too — 5xx,
  // Stripe retries forever, captured money never recorded, no self-heal path.
  // The engine now rejects it at intent creation, and the webhook independently
  // refuses to apply metadata that cannot satisfy the CHECK. The credit must
  // survive regardless.
  const id = await seedProposal();
  const piId = `pi_grat_subfloor_${NONCE}`;
  const res = await postWebhook(intentEvent({ proposalId: id, amount: 10000, paymentType: 'deposit',
    meta: { tip_jar: 'false', gratuity_rate: '49.9998' }, piId }));
  assert.equal(res.status, 200, `webhook must ack, not 5xx: ${res.body}`);

  const pay = (await pool.query(
    'SELECT amount, status FROM proposal_payments WHERE stripe_payment_intent_id = $1', [piId])).rows[0];
  assert.ok(pay, 'the payment row MUST exist (money is recorded even when the election is refused)');
  assert.equal(Number(pay.amount), 10000);
  assert.equal(pay.status, 'succeeded');

  const p = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [id])).rows[0];
  assert.equal(Number(p.amount_paid), 100, 'credit proceeds untouched');
  assert.equal(p.status, 'deposit_paid', 'status still derived from the credit');
  assert.equal(p.tip_jar, true, 'invalid election NOT applied');
  assert.equal(Number(p.gratuity_rate), 0, 'invalid rate NOT persisted');
  assert.equal(Number(p.total_price), 450, 'total NOT rewritten');
});

test('degenerate {} snapshot: payment recorded, total_price NOT zeroed, apply skipped', async () => {
  // A proposal whose pricing_snapshot is an empty '{}' (dev has 26 payable rows
  // like this) has no gratuity basis, so recomputeSnapshotGratuity would return
  // total 0 — zeroing total_price AFTER the money was captured and flipping the
  // proposal to balance_paid at $0. The apply requires a non-degenerate snapshot.
  const id = await seedProposal({ snapshot: {} });
  const piId = `pi_grat_emptysnap_${NONCE}`;
  const res = await postWebhook(intentEvent({ proposalId: id, amount: 10000, paymentType: 'deposit',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId }));
  assert.equal(res.status, 200, res.body);

  const pay = (await pool.query(
    'SELECT amount FROM proposal_payments WHERE stripe_payment_intent_id = $1', [piId])).rows[0];
  assert.ok(pay, 'the payment row MUST exist');

  const p = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [id])).rows[0];
  assert.equal(Number(p.total_price), 450, 'total_price must NOT be zeroed post-capture');
  assert.equal(Number(p.amount_paid), 100, 'credit proceeds untouched');
  assert.equal(p.status, 'deposit_paid', 'must NOT flip to balance_paid at a zeroed total');
  assert.equal(p.tip_jar, true, 'apply skipped on a degenerate snapshot');
  assert.equal(Number(p.gratuity_rate), 0);
});

test('corrupt snapshot that throws mid-apply: SAVEPOINT degrades, payment still recorded', async () => {
  // Exercises layer 3 (the SAVEPOINT bracket) through the REAL handler rather
  // than asserting the SQL strings by eye. A snapshot whose `breakdown` is not
  // an array passes the non-degenerate check (total > 0) and then makes
  // recomputeSnapshotGratuity throw inside the bracket. Without the SAVEPOINT
  // this aborts the transaction and the payment record dies with it; with it,
  // the gratuity alone rolls back and the credit still commits.
  const id = await seedProposal({
    snapshot: { total: 450, breakdown: 'corrupt-not-an-array', staff_noun: 'bartender',
      gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 5, total: 0 } },
  });
  const piId = `pi_grat_corrupt_${NONCE}`;
  const res = await postWebhook(intentEvent({ proposalId: id, amount: 10000, paymentType: 'deposit',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId }));
  assert.equal(res.status, 200, `webhook must ack, not 5xx: ${res.body}`);

  const pay = (await pool.query(
    'SELECT amount FROM proposal_payments WHERE stripe_payment_intent_id = $1', [piId])).rows[0];
  assert.ok(pay, 'the payment row MUST survive a failed gratuity write');

  const p = (await pool.query(
    'SELECT tip_jar, gratuity_rate, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [id])).rows[0];
  assert.equal(Number(p.amount_paid), 100, 'credit committed despite the failed apply');
  assert.equal(p.status, 'deposit_paid');
  assert.equal(Number(p.total_price), 450, 'gratuity write rolled back to the savepoint');
  assert.equal(p.tip_jar, true);
  assert.equal(Number(p.gratuity_rate), 0);
});

test('duplicate delivery: election + credit applied exactly once', async () => {
  const id = await seedProposal();
  const evt = intentEvent({ proposalId: id, amount: 10000, paymentType: 'deposit',
    meta: { tip_jar: 'false', gratuity_rate: '50' }, piId: `pi_grat_dup_${NONCE}` });
  await postWebhook(evt);
  await postWebhook(evt);
  const p = (await pool.query(
    'SELECT total_price, amount_paid FROM proposals WHERE id = $1', [id])).rows[0];
  assert.equal(Number(p.total_price), 700, 'not re-applied');
  assert.equal(Number(p.amount_paid), 100, 'not re-credited');
});
