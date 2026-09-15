// server/routes/stripeWebhook.refundCreated.test.js
// refund.created is THE reconciler for a refund issued in the Stripe dashboard
// (spec 2026-09-15). Run ALONE against the shared dev DB:
//   node --test server/routes/stripeWebhook.refundCreated.test.js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const WEBHOOK_SECRET = 'whsec_test_refund_created';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_WEBHOOK_SECRET_TEST = '';
process.env.STRIPE_TEST_MODE_UNTIL = '';

// The handler makes no Stripe API call (the event payload IS the Refund), so
// the only Stripe surface needed is the signature helper. Keep the real one.
const realLive = require('../utils/stripeClient').getLiveClient();
const fakeStripe = { webhooks: realLive.webhooks };
require('../utils/stripeClient').getLiveClient = () => fakeStripe;
require('../utils/stripeClient').getTestClient = () => null;

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { pool } = require('../db');
const stripeRouter = require('./stripe');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripeWebhook.refundCreated.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server, baseUrl, seq = 0;
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

/**
 * A booked proposal with one succeeded balance payment.
 * `overpaid` decides whether amount_paid exceeds total_price: an overpaid seed
 * credits the invoice only up to its due (what linkPaymentToInvoice does) and
 * leaves the rest as uncredited headroom, which is the real duplicate geometry.
 */
async function seed({ overpaid = false, totalPrice = 500, payCents = 40000, linkCents = null } = {}) {
  seq += 1;
  const c = await pool.query(
    `INSERT INTO clients (name, email, email_status) VALUES ('WH RefundCreated', $1, 'bad') RETURNING id`,
    [`wh-rc-${NONCE}-${seq}@example.com`]
  );
  clientIds.push(c.rows[0].id);
  const amountPaid = overpaid ? totalPrice + payCents / 100 : totalPrice;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid, deposit_amount, pricing_snapshot, event_timezone)
     VALUES ($1, 'balance_paid', $2, $3, 100, '{}'::jsonb, 'America/Chicago') RETURNING id`,
    [c.rows[0].id, totalPrice, amountPaid]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, 'Balance', $4, $5, 'paid', true) RETURNING id`,
    [proposalId, crypto.randomUUID(), `INV-${crypto.randomBytes(6).toString('hex')}`,
      totalPrice * 100,
      // A credit can never exceed the payment that funded it: linkPaymentToInvoice
      // caps at the invoice's remaining due, and the payment caps the rest.
      linkCents === null ? Math.min(totalPrice * 100, payCents) : linkCents]
  );
  const intent = `pi_rc_${NONCE}_${seq}`;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'invoice', $2, 'succeeded', $3) RETURNING id`,
    [proposalId, payCents, intent]
  );
  const credited = linkCents === null ? Math.min(totalPrice * 100, payCents) : linkCents;
  if (credited !== 0) {
    await pool.query('INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
      [inv.rows[0].id, pay.rows[0].id, credited]);
  }
  return { proposalId, invId: inv.rows[0].id, paymentId: pay.rows[0].id, intent };
}

function refundEvent({ id, refundId, intent, amount = 40000, reason = 'requested_by_customer',
  status = 'succeeded', metadata = {}, livemode = true, noIntent = false }) {
  return {
    id, type: 'refund.created', livemode,
    data: { object: {
      id: refundId, object: 'refund', amount, status, reason, metadata,
      ...(noIntent ? {} : { payment_intent: intent }),
    } },
  };
}

const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const money = (pid) => one('SELECT total_price, amount_paid, status FROM proposals WHERE id = $1', [pid]);
const refundRow = (rid) => one('SELECT * FROM proposal_refunds WHERE stripe_refund_id = $1', [rid]);

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
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1::int[]))', [ids]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [ids]);
  }
  // The rethrow test orphans its payment row (proposal_id nulled), so it is not
  // covered by the proposal-scoped deletes above.
  await pool.query('DELETE FROM proposal_payments WHERE stripe_payment_intent_id LIKE $1', [`pi_rc_${NONCE}%`]);
  await pool.query('DELETE FROM stripe_sessions WHERE stripe_payment_intent_id LIKE $1', [`pi_rc_${NONCE}%`]);
  if (clientIds.length) await pool.query('DELETE FROM clients WHERE id = ANY($1::int[])', [clientIds]);
  await pool.end();
});

test('a dashboard refund reasoned "duplicate" lands as overpayment: the contract stands', async () => {
  // The prod 784 geometry: a second full payment, credited to nothing.
  const o = await seed({ overpaid: true, payCents: 40000, linkCents: 0 });
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_dup`, refundId: `re_${NONCE}_dup`, intent: o.intent, reason: 'duplicate',
  }));
  assert.equal(r.status, 200, r.body);
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 500, 'contract untouched');
  assert.equal(Number(m.amount_paid), 500, 'the duplicate came off amount_paid');
  const row = await refundRow(`re_${NONCE}_dup`);
  assert.equal(row.status, 'succeeded');
  assert.equal(row.total_scope, 'overpayment');
  assert.equal(row.issued_by, null);
  assert.match(row.reason, /Stripe dashboard \(duplicate\)/);
});

test('the DEFAULT dashboard reason still lands as overpayment when the netted excess covers it', async () => {
  // The blocker the design fleet caught: Stripe's dashboard default reason is
  // requested_by_customer, so a reason string alone must never decide a
  // contract-lowering rule.
  const o = await seed({ overpaid: true, payCents: 40000, linkCents: 0 });
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_def`, refundId: `re_${NONCE}_def`, intent: o.intent, reason: 'requested_by_customer',
  }));
  assert.equal(r.status, 200, r.body);
  assert.equal((await refundRow(`re_${NONCE}_def`)).total_scope, 'overpayment');
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 500, 'the contract did NOT shrink');
  assert.equal(Number(m.amount_paid), 500);
});

test('the same reason on a proposal that is NOT overpaid lands as contract and corrects the total', async () => {
  const o = await seed({ overpaid: false, totalPrice: 500, payCents: 40000 });
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_con`, refundId: `re_${NONCE}_con`, intent: o.intent, reason: 'requested_by_customer',
  }));
  assert.equal(r.status, 200, r.body);
  assert.equal((await refundRow(`re_${NONCE}_con`)).total_scope, 'contract');
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 100, 'Approach A: the refund corrected the contract');
  assert.equal(Number(m.amount_paid), 100);
});

test('a refund naming its own pending row adopts it and keeps THAT row scope', async () => {
  const o = await seed({ overpaid: false, totalPrice: 500, payCents: 40000 });
  const pend = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status, total_scope)
     VALUES ($1, $2, $3, 10000, 'panel refund', 500, 500, NULL, 'pending', 'overpayment')
     RETURNING id`,
    [o.proposalId, o.paymentId, o.intent]
  );
  const rowId = pend.rows[0].id;
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_adopt`, refundId: `re_${NONCE}_adopt`, intent: o.intent, amount: 10000,
    reason: 'requested_by_customer', metadata: { proposal_refund_row_id: String(rowId) },
  }));
  assert.equal(r.status, 200, r.body);
  const row = await refundRow(`re_${NONCE}_adopt`);
  assert.equal(row.id, rowId, 'adopted the named row, not a new one');
  assert.equal(row.total_scope, 'overpayment', 'the row rule wins over the reason mapping');
  assert.equal(row.reason, 'panel refund', 'the audit keeps the issuing path reason');
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 500, 'overpayment scope from the row: no contract change');
});

test('a STRANDED same-amount pending row is never adopted by a dashboard refund', async () => {
  // The heuristic this handler suppresses: the stranded row carries the other
  // money rule and would silently re-scope an unrelated refund.
  const o = await seed({ overpaid: false, totalPrice: 500, payCents: 40000 });
  const pend = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status, total_scope)
     VALUES ($1, $2, $3, 10000, 'stranded', 500, 500, NULL, 'pending', 'overpayment')
     RETURNING id`,
    [o.proposalId, o.paymentId, o.intent]
  );
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_strand`, refundId: `re_${NONCE}_strand`, intent: o.intent, amount: 10000,
    reason: 'requested_by_customer',
  }));
  assert.equal(r.status, 200, r.body);
  const row = await refundRow(`re_${NONCE}_strand`);
  assert.notEqual(row.id, pend.rows[0].id, 'a fresh row, not the stranded one');
  assert.equal(row.total_scope, 'contract', 'scope came from the netted excess, not the stray row');
  const stranded = await one('SELECT status FROM proposal_refunds WHERE id = $1', [pend.rows[0].id]);
  assert.equal(stranded.status, 'pending', 'the stranded row is left for the sweeper');
});

test('a failed or canceled refund reconciles nothing', async () => {
  const o = await seed({ overpaid: true, payCents: 40000, linkCents: 0 });
  for (const status of ['failed', 'canceled']) {
    const r = await postWebhook(refundEvent({
      id: `evt_${NONCE}_${status}`, refundId: `re_${NONCE}_${status}`, intent: o.intent, status,
    }));
    assert.equal(r.status, 200);
    assert.equal(await refundRow(`re_${NONCE}_${status}`), undefined);
  }
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 900, 'money untouched');
});

test('a refund with no succeeded payment row is never reconciled blind', async () => {
  // Reconciling with a null paymentId would skip the whole invoice walk and drop
  // total_price by the full amount with no non-contract and no off-ledger
  // netting. Whether it is ACKED or RETRIED depends on whether the charge is
  // ours: metadata naming a proposal says it is, so the delivery fails and
  // Stripe retries rather than dropping a real refund.
  const o = await seed({ overpaid: false, totalPrice: 500, payCents: 40000 });
  await pool.query(`UPDATE proposal_payments SET status = 'failed' WHERE id = $1`, [o.paymentId]);
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_nopay`, refundId: `re_${NONCE}_nopay`, intent: o.intent,
    metadata: { proposal_id: String(o.proposalId) },
  }));
  assert.equal(r.status, 500, 'ours but unrecorded: retried');
  assert.equal(await refundRow(`re_${NONCE}_nopay`), undefined);
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 500, 'nothing moved');
});

test('a refund on a charge that is not ours at all is acked and dropped, not retried forever', async () => {
  // No payment row, no session row, no metadata: a tip refund or a foreign
  // charge. Retrying that would 500 for days on something we will never record.
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_foreigncharge`, refundId: `re_${NONCE}_foreigncharge`,
    intent: `pi_notours_${NONCE}`,
  }));
  assert.equal(r.status, 200);
  assert.equal(await refundRow(`re_${NONCE}_foreigncharge`), undefined);
});

test('a refund with no payment_intent is skipped', async () => {
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_noint`, refundId: `re_${NONCE}_noint`, intent: null, noIntent: true,
  }));
  assert.equal(r.status, 200);
  assert.equal(await refundRow(`re_${NONCE}_noint`), undefined);
});

test('an unknown charge is a clean no-op', async () => {
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_alien`, refundId: `re_${NONCE}_alien`, intent: `pi_alien_${NONCE}`,
  }));
  assert.equal(r.status, 200);
  assert.equal(await refundRow(`re_${NONCE}_alien`), undefined);
});

test('a redelivery applies exactly once', async () => {
  const o = await seed({ overpaid: true, payCents: 40000, linkCents: 0 });
  const evt = refundEvent({
    id: `evt_${NONCE}_replay`, refundId: `re_${NONCE}_replay`, intent: o.intent, reason: 'duplicate',
  });
  assert.equal((await postWebhook(evt)).status, 200);
  assert.equal((await postWebhook(evt)).status, 200);
  const rows = await one(
    'SELECT COUNT(*)::int AS n FROM proposal_refunds WHERE stripe_refund_id = $1',
    [`re_${NONCE}_replay`]
  );
  assert.equal(rows.n, 1);
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 500, 'amount_paid dropped once, not twice');
  const log = await one(
    `SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'refund_issued'`,
    [o.proposalId]
  );
  assert.equal(log.n, 1);
});

test('a payment row with no proposal is skipped cleanly, not reconciled against proposal 0', async () => {
  const o = await seed({ overpaid: false, totalPrice: 500, payCents: 40000 });
  await pool.query('DELETE FROM invoice_payments WHERE payment_id = $1', [o.paymentId]);
  const nulled = await pool.query('UPDATE proposal_payments SET proposal_id = NULL WHERE id = $1', [o.paymentId])
    .then(() => true).catch(() => false);
  if (!nulled) return; // column is NOT NULL in this schema; nothing to assert
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_noprop`, refundId: `re_${NONCE}_noprop`, intent: o.intent,
  }));
  assert.equal(r.status, 200, 'acked, not retried forever');
  assert.equal(await refundRow(`re_${NONCE}_noprop`), undefined, 'and nothing recorded');
});

test('a reconciliation failure fails the delivery so Stripe retries', async () => {
  // Nothing else backstops a dashboard refund (the sweeper only selects pending
  // rows, and this refund has none), so a swallowed error would ack the event
  // and lose the refund permanently — the exact defect this handler closes.
  const helpers = require('../utils/refundHelpers');
  const real = helpers.applyRefundReconciliation;
  helpers.applyRefundReconciliation = async () => { throw new Error('boom: simulated DB failure'); };
  try {
    const o = await seed({ overpaid: true, payCents: 40000, linkCents: 0 });
    const r = await postWebhook(refundEvent({
      id: `evt_${NONCE}_boom`, refundId: `re_${NONCE}_boom`, intent: o.intent, reason: 'duplicate',
    }));
    assert.equal(r.status, 500, 'the delivery fails so Stripe retries');
    assert.equal(await refundRow(`re_${NONCE}_boom`), undefined, 'nothing was written');
    assert.equal(Number((await money(o.proposalId)).amount_paid), 900, 'money untouched');
  } finally {
    helpers.applyRefundReconciliation = real;
  }
});

test('a refund naming ANOTHER proposal pending row does not adopt it; the scope is derived instead', async () => {
  // The row id arrives in Stripe metadata, so it is externally supplied. An
  // unconstrained lookup would let another proposal's row decide this refund's
  // money rule AND be marked succeeded against this refund's id, stranding its
  // own refund forever.
  const victim = await seed({ overpaid: false, totalPrice: 500, payCents: 40000 });
  const pend = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status, total_scope)
     VALUES ($1, $2, $3, 40000, 'victim panel refund', 500, 500, NULL, 'pending', 'overpayment')
     RETURNING id`,
    [victim.proposalId, victim.paymentId, victim.intent]
  );
  const other = await seed({ overpaid: false, totalPrice: 500, payCents: 40000 });
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_foreign`, refundId: `re_${NONCE}_foreign`, intent: other.intent,
    amount: 40000, reason: 'requested_by_customer',
    metadata: { proposal_refund_row_id: String(pend.rows[0].id) },
  }));
  assert.equal(r.status, 200, r.body);
  const row = await refundRow(`re_${NONCE}_foreign`);
  assert.equal(Number(row.proposal_id), other.proposalId, 'a fresh row on the right proposal');
  assert.notEqual(row.id, pend.rows[0].id);
  assert.equal(row.total_scope, 'contract', 'scope derived, not borrowed from the foreign row');
  const untouched = await one('SELECT status, stripe_refund_id FROM proposal_refunds WHERE id = $1', [pend.rows[0].id]);
  assert.equal(untouched.status, 'pending', "the other proposal's row is left alone");
  assert.equal(untouched.stripe_refund_id, null);
  const vm = await money(victim.proposalId);
  assert.equal(Number(vm.amount_paid), 500, "the other proposal's money never moved");
});

test('a refund naming a pending row whose AMOUNT disagrees does not adopt it', async () => {
  const o = await seed({ overpaid: false, totalPrice: 500, payCents: 40000 });
  const pend = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status, total_scope)
     VALUES ($1, $2, $3, 10000, 'a different refund', 500, 500, NULL, 'pending', 'overpayment')
     RETURNING id`,
    [o.proposalId, o.paymentId, o.intent]
  );
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_amt`, refundId: `re_${NONCE}_amt`, intent: o.intent, amount: 40000,
    reason: 'requested_by_customer', metadata: { proposal_refund_row_id: String(pend.rows[0].id) },
  }));
  assert.equal(r.status, 200, r.body);
  const row = await refundRow(`re_${NONCE}_amt`);
  assert.notEqual(row.id, pend.rows[0].id);
  assert.equal(row.total_scope, 'contract');
  assert.equal((await one('SELECT status FROM proposal_refunds WHERE id = $1', [pend.rows[0].id])).status, 'pending');
});

test('a refund awaiting customer bank details (requires_action) records nothing', async () => {
  const o = await seed({ overpaid: true, payCents: 40000, linkCents: 0 });
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_ra`, refundId: `re_${NONCE}_ra`, intent: o.intent, status: 'requires_action',
  }));
  assert.equal(r.status, 200);
  assert.equal(await refundRow(`re_${NONCE}_ra`), undefined);
  assert.equal(Number((await money(o.proposalId)).amount_paid), 900, 'no money has moved yet');
});

test('two concurrent dashboard refunds cannot both classify against the same overpayment', async () => {
  // The scope decision reads amount_paid, so it has to happen under the
  // proposals row lock. Before that it was a read-then-act: both deliveries saw
  // the same pre-refund excess and both landed overpayment, leaving the
  // contract un-corrected.
  const o = await seed({ overpaid: true, payCents: 40000, linkCents: 0 });
  const mk = (n) => refundEvent({
    id: `evt_${NONCE}_conc${n}`, refundId: `re_${NONCE}_conc${n}`, intent: o.intent,
    amount: 40000, reason: 'requested_by_customer',
  });
  const [a, b] = await Promise.all([postWebhook(mk(1)), postWebhook(mk(2))]);
  assert.equal(a.status, 200, a.body);
  assert.equal(b.status, 200, b.body);
  const rows = await pool.query(
    `SELECT total_scope FROM proposal_refunds WHERE stripe_refund_id = ANY($1::text[]) ORDER BY id`,
    [[`re_${NONCE}_conc1`, `re_${NONCE}_conc2`]]
  );
  assert.equal(rows.rowCount, 2, 'both landed');
  const scopes = rows.rows.map((x) => x.total_scope).sort();
  assert.deepEqual(scopes, ['contract', 'overpayment'],
    'the first spends the excess as an overpayment; the second sees it gone and corrects the contract');
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 100, 'both refunds came off amount_paid');
  assert.equal(Number(m.total_price), 100, 'and exactly one of them corrected the contract');
});

test('an in-app refund that already reconciled is silent: no second row, no money movement', async () => {
  // refundExecute reconciles its OWN pending row inside the request, so by the
  // time Stripe delivers refund.created the row is already succeeded with the
  // refund id. Warning there would fire on EVERY panel refund and drown the one
  // alert that catches a forged row id.
  const o = await seed({ overpaid: true, payCents: 40000, linkCents: 0 });
  const refundId = `re_${NONCE}_already`;
  const row = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, stripe_refund_id, amount, reason,
        total_price_before, total_price_after, issued_by, status, total_scope)
     VALUES ($1, $2, $3, $4, 40000, 'panel refund', 500, 500, NULL, 'succeeded', 'overpayment')
     RETURNING id`,
    [o.proposalId, o.paymentId, o.intent, refundId]
  );
  await pool.query('UPDATE proposals SET amount_paid = 500 WHERE id = $1', [o.proposalId]);
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_already`, refundId, intent: o.intent, amount: 40000,
    reason: 'duplicate', metadata: { proposal_refund_row_id: String(row.rows[0].id) },
  }));
  assert.equal(r.status, 200, r.body);
  const count = await one(
    'SELECT COUNT(*)::int AS n FROM proposal_refunds WHERE proposal_id = $1', [o.proposalId]
  );
  assert.equal(count.n, 1, 'no duplicate row');
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 500, 'no second drop');
  assert.equal(Number(m.total_price), 500);
});

test('a dashboard refund on a FULLY CREDITED charge corrects the contract instead of reversing invoice credits', async () => {
  // The panel refuses this outright; the webhook cannot (the money has moved),
  // so it picks the rule the charge can honor. Landing overpayment here would
  // walk the invoice links and leave a settled invoice demanding less than an
  // unchanged contract.
  const o = await seed({ overpaid: true, totalPrice: 500, payCents: 50000, linkCents: 50000 });
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_credited`, refundId: `re_${NONCE}_credited`, intent: o.intent,
    amount: 40000, reason: 'duplicate',
  }));
  assert.equal(r.status, 200, r.body);
  const row = await refundRow(`re_${NONCE}_credited`);
  assert.equal(row.total_scope, 'contract', 'the charge holds no uncredited money');
  const m = await money(o.proposalId);
  assert.equal(Number(m.total_price), 100, 'the contract was corrected, which is the honest rule here');
});

test('a refund on one of our charges whose payment row is not recorded yet fails the delivery so Stripe retries', async () => {
  // Acking would lose it forever: a dashboard refund has no pending row for the
  // sweeper to heal. A stripe_sessions row is what says the charge is ours.
  const o = await seed({ overpaid: false, totalPrice: 500, payCents: 40000 });
  await pool.query('DELETE FROM invoice_payments WHERE payment_id = $1', [o.paymentId]);
  await pool.query('DELETE FROM proposal_payments WHERE id = $1', [o.paymentId]);
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 40000, 'pending')`,
    [o.proposalId, o.intent]
  );
  const r = await postWebhook(refundEvent({
    id: `evt_${NONCE}_early`, refundId: `re_${NONCE}_early`, intent: o.intent,
  }));
  assert.equal(r.status, 500, 'retried, not dropped');
  assert.equal(await refundRow(`re_${NONCE}_early`), undefined);
  await pool.query('DELETE FROM stripe_sessions WHERE stripe_payment_intent_id = $1', [o.intent]);
});

test('charge.refunded no longer reconciles: it records no refund row and moves no money', async () => {
  // Its reconciliation half was removed because the Charge object carries no
  // refunds list at this account API version, so it had been no-oping silently.
  // Subscribing it now is purely for the payroll tip clawback.
  const o = await seed({ overpaid: true, payCents: 40000, linkCents: 0 });
  const evt = {
    id: `evt_${NONCE}_chg`, type: 'charge.refunded', livemode: true,
    data: { object: { id: `ch_${NONCE}`, object: 'charge', payment_intent: o.intent,
      amount: 40000, amount_refunded: 40000, refunded: true, metadata: {} } },
  };
  const r = await postWebhook(evt);
  assert.equal(r.status, 200, r.body);
  const rows = await one(
    'SELECT COUNT(*)::int AS n FROM proposal_refunds WHERE proposal_id = $1', [o.proposalId]
  );
  assert.equal(rows.n, 0, 'no refund row from charge.refunded');
  const m = await money(o.proposalId);
  assert.equal(Number(m.amount_paid), 900, 'and no money moved');
  assert.equal(Number(m.total_price), 500);
});
