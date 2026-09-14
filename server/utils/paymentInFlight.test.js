// server/utils/paymentInFlight.test.js
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const {
  IN_FLIGHT_MAX_AGE_DAYS, STALE_PROCESSING_DAYS, STRIPE_RETRIEVE_OPTS, findInFlightPayments, findStaleProcessingPayments,
  toPublicPending, inFlightMessage, verificationMessage, settledMessage, pendingFromLateralRow, IN_FLIGHT_LATERAL_SQL,
  assertNoPaymentInFlight,
} = require('./paymentInFlight');

if (process.env.NODE_ENV === 'production') {
  throw new Error('paymentInFlight.test.js refuses to run against production');
}

const MARK = `pif-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
// invoices.invoice_number is VARCHAR(20); MARK alone overruns it (22001).
const INV_NUM = `INV-${crypto.randomBytes(6).toString('hex')}`;
let clientId, proposalId, invoiceId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('In Flight Test', $1) RETURNING id`, [`${MARK}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, pricing_snapshot, event_timezone)
     VALUES ($1, 'deposit_paid', 'wedding', 500, 100, '{}'::jsonb, 'America/Chicago') RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const i = await pool.query(
    `INSERT INTO invoices (proposal_id, token, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, $3, 'Balance', 40000, 0, 'sent') RETURNING id`,
    [proposalId, crypto.randomUUID(), INV_NUM]
  );
  invoiceId = i.rows[0].id;
});

beforeEach(async () => {
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

async function seed({ intentId, status = 'processing', amount = 40000, processingAgo = '1 hour', createdAgo = '1 hour', invoice = null }) {
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id, created_at)
     VALUES ($1, $2, $3, $4::text, CASE WHEN $4::text = 'processing' THEN NOW() - $5::interval ELSE NULL END, $6, NOW() - $7::interval)`,
    [proposalId, intentId, amount, status, processingAgo, invoice, createdAgo]
  );
}

function fakeStripe(byId, { failWith } = {}) {
  return { paymentIntents: { retrieve: async (id) => {
    if (failWith) throw failWith;
    if (!byId[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
    return byId[id];
  } } };
}

test('findInFlightPayments > a processing row inside the window is returned with its invoice number, newest first', async () => {
  await seed({ intentId: `pi_${MARK}_old`, processingAgo: '2 days', invoice: invoiceId });
  await seed({ intentId: `pi_${MARK}_new`, processingAgo: '1 hour', amount: 12300 });
  const rows = await findInFlightPayments(proposalId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stripe_payment_intent_id, `pi_${MARK}_new`);
  assert.equal(rows[0].amount_cents, 12300);
  assert.equal(rows[0].invoice_id, null);
  assert.equal(rows[1].invoice_id, invoiceId);
  assert.equal(rows[1].invoice_number, INV_NUM);
  assert.ok(rows[0].started_at instanceof Date);
});

test('findInFlightPayments > pending, succeeded, failed and canceled rows are never in flight', async () => {
  for (const status of ['pending', 'succeeded', 'failed', 'canceled']) {
    await seed({ intentId: `pi_${MARK}_${status}`, status });
  }
  assert.deepEqual(await findInFlightPayments(proposalId), []);
});

test(`findInFlightPayments > a processing row older than ${IN_FLIGHT_MAX_AGE_DAYS} days has expired (D6)`, async () => {
  await seed({ intentId: `pi_${MARK}_stale`, processingAgo: `${IN_FLIGHT_MAX_AGE_DAYS + 1} days` });
  assert.deepEqual(await findInFlightPayments(proposalId), []);
});

test('toPublicPending > newest row without the intent id, null when empty', () => {
  assert.equal(toPublicPending([]), null);
  const started = new Date('2026-09-05T16:05:35Z');
  const out = toPublicPending([{ stripe_payment_intent_id: 'pi_x', amount_cents: 40000, started_at: started, invoice_id: 363, invoice_number: 'INV-0363' }]);
  assert.deepEqual(out, { amount_cents: 40000, started_at: started, invoice_id: 363, invoice_number: 'INV-0363' });
  assert.equal('stripe_payment_intent_id' in out, false);
});

test('inFlightMessage > dollars, long date in the event timezone, no em dash', () => {
  const msg = inFlightMessage({ amountCents: 40000, startedAt: new Date('2026-09-05T16:05:35Z'), timeZone: 'America/Chicago' });
  assert.equal(msg, 'A $400.00 payment for this event has been processing since September 5. Bank payments take four to six business days to clear, and you will get a receipt by email when it does. If you think this is a mistake, email contact@drbartender.com.');
  assert.ok(!msg.includes('—'));
  const noDate = inFlightMessage({ amountCents: 10000, startedAt: null, timeZone: 'America/Chicago' });
  assert.ok(noDate.startsWith('A $100.00 payment for this event has been processing. '));
});

test('assertNoPaymentInFlight > throws 409 PAYMENT_IN_FLIGHT on a processing row, resolves with nothing in flight', async () => {
  await assertNoPaymentInFlight({ proposalId, stripe: fakeStripe({}), timeZone: 'America/Chicago' });
  await seed({ intentId: `pi_${MARK}_block` });
  await assert.rejects(
    assertNoPaymentInFlight({ proposalId, stripe: fakeStripe({}), timeZone: 'America/Chicago' }),
    (err) => err.statusCode === 409 && err.code === 'PAYMENT_IN_FLIGHT' && /\$400\.00/.test(err.message)
  );
});

test('assertNoPaymentInFlight > a pending row Stripe reports processing or succeeded is a 409', async () => {
  for (const status of ['processing', 'succeeded']) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
    const id = `pi_${MARK}_stripe_${status}`;
    await seed({ intentId: id, status: 'pending' });
    const stripe = fakeStripe({ [id]: { id, status, amount: 40000, created: Math.floor(Date.now() / 1000) } });
    await assert.rejects(
      assertNoPaymentInFlight({ proposalId, stripe, timeZone: 'America/Chicago' }),
      (err) => err.statusCode === 409 && err.code === 'PAYMENT_IN_FLIGHT'
    );
  }
});

test('assertNoPaymentInFlight > requires_payment_method and resource_missing pass; at most 5 recent rows are read', async () => {
  const seen = [];
  const byId = {};
  for (let n = 0; n < 7; n += 1) {
    const id = `pi_${MARK}_many_${n}`;
    await seed({ intentId: id, status: 'pending', createdAgo: `${n + 1} minutes` });
    if (n % 2 === 0) byId[id] = { id, status: 'requires_payment_method', amount: 40000 };
  }
  const stripe = { paymentIntents: { retrieve: async (id) => {
    seen.push(id);
    if (!byId[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
    return byId[id];
  } } };
  await assertNoPaymentInFlight({ proposalId, stripe, timeZone: 'America/Chicago' });
  assert.equal(seen.length, 5, 'bounded scan');
  assert.ok(!seen.includes(`pi_${MARK}_many_6`), 'the oldest rows fall outside the window of five');
});

test('assertNoPaymentInFlight > a pending row older than the window is not read', async () => {
  const id = `pi_${MARK}_ancient`;
  await seed({ intentId: id, status: 'pending', createdAgo: `${IN_FLIGHT_MAX_AGE_DAYS + 1} days` });
  const stripe = fakeStripe({ [id]: { id, status: 'processing', amount: 40000 } });
  await assertNoPaymentInFlight({ proposalId, stripe, timeZone: 'America/Chicago' });
});

// The plan and spec call this "a 503"; the codebase's ExternalServiceError is
// statusCode 502 and always has been (errors.js, and stripe.chargeBalanceDurable
// asserts 502 on the same fail-closed read). The behavior under test is the one
// D7 names: an unreadable Stripe fails closed rather than minting.
test('assertNoPaymentInFlight > any retrieve failure other than resource_missing fails closed as a 502 (D7)', async () => {
  const id = `pi_${MARK}_down`;
  await seed({ intentId: id, status: 'pending' });
  const boom = new Error('connection reset'); boom.code = 'ECONNRESET';
  await assert.rejects(
    assertNoPaymentInFlight({ proposalId, stripe: fakeStripe({}, { failWith: boom }), timeZone: 'America/Chicago' }),
    (err) => err.statusCode === 502 && /temporarily unavailable/.test(err.message)
  );
});

test('assertNoPaymentInFlight > a processing row refuses from the DB read alone, no Stripe call', async () => {
  await seed({ intentId: `pi_${MARK}_c_proc` });
  const seen = [];
  const stripe = { paymentIntents: { retrieve: async (id) => { seen.push(id); return { id, status: 'requires_payment_method' }; } } };
  await assert.rejects(
    assertNoPaymentInFlight({ proposalId, stripe, timeZone: 'America/Chicago' }),
    (err) => err.statusCode === 409 && err.code === 'PAYMENT_IN_FLIGHT' && /\$400\.00/.test(err.message)
  );
  assert.equal(seen.length, 0);
});

test('assertNoPaymentInFlight > a FAILED row whose intent Stripe now reports processing refuses (decline, then bank retry on the same intent)', async () => {
  const id = `pi_${MARK}_c_failed`;
  await seed({ intentId: id, status: 'failed' });
  const stripe = fakeStripe({ [id]: { id, status: 'processing', amount: 40000, created: Math.floor(Date.now() / 1000) } });
  await assert.rejects(
    assertNoPaymentInFlight({ proposalId, stripe, timeZone: 'America/Chicago' }),
    (err) => err.statusCode === 409 && err.code === 'PAYMENT_IN_FLIGHT'
  );
});

test('assertNoPaymentInFlight > an intent awaiting microdeposit verification refuses with the verification copy; a 3DS requires_action passes', async () => {
  const md = `pi_${MARK}_c_micro`;
  await seed({ intentId: md, status: 'pending' });
  const stripe = fakeStripe({ [md]: { id: md, status: 'requires_action', amount: 40000, next_action: { type: 'verify_with_microdeposits' } } });
  await assert.rejects(
    assertNoPaymentInFlight({ proposalId, stripe, timeZone: 'America/Chicago' }),
    (err) => err.statusCode === 409 && err.code === 'PAYMENT_IN_FLIGHT' && err.message === verificationMessage()
  );
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
  const tds = `pi_${MARK}_c_3ds`;
  await seed({ intentId: tds, status: 'pending' });
  const stripe2 = fakeStripe({ [tds]: { id: tds, status: 'requires_action', amount: 40000, next_action: { type: 'use_stripe_sdk' } } });
  const out = await assertNoPaymentInFlight({ proposalId, stripe: stripe2, timeZone: 'America/Chicago' });
  assert.equal(out.intents.get(tds).status, 'requires_action');
});

test('assertNoPaymentInFlight > returns the intents it fetched, and asks Stripe with a timeout and one retry', async () => {
  const id = `pi_${MARK}_c_ret`;
  await seed({ intentId: id, status: 'pending' });
  const opts = [];
  const stripe = { paymentIntents: { retrieve: async (pid, o) => { opts.push(o); return { id: pid, status: 'requires_payment_method', amount: 40000 }; } } };
  const out = await assertNoPaymentInFlight({ proposalId, stripe, timeZone: 'America/Chicago' });
  assert.equal(out.intents.get(id).id, id);
  assert.deepEqual(opts[0], STRIPE_RETRIEVE_OPTS);
  assert.equal(STRIPE_RETRIEVE_OPTS.maxNetworkRetries, 1);
});

test('inFlightMessage > an invalid event timezone falls back instead of throwing', () => {
  const msg = inFlightMessage({ amountCents: 40000, startedAt: new Date('2026-09-05T16:05:35Z'), timeZone: 'Not/AZone' });
  assert.match(msg, /processing since September 5\./);
});

test('IN_FLIGHT_LATERAL_SQL > joins the newest in-flight payment onto a proposals row in one query', async () => {
  await seed({ intentId: `pi_${MARK}_lat`, invoice: invoiceId });
  const { rows } = await pool.query(`SELECT p.id, pp.* FROM proposals p ${IN_FLIGHT_LATERAL_SQL} WHERE p.id = $1`, [proposalId]);
  const pending = pendingFromLateralRow(rows[0]);
  assert.equal(pending.amount_cents, 40000);
  assert.equal(pending.invoice_id, invoiceId);
  assert.equal(pending.invoice_number, INV_NUM);
  assert.ok(pending.started_at instanceof Date);
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [proposalId]);
  const { rows: none } = await pool.query(`SELECT p.id, pp.* FROM proposals p ${IN_FLIGHT_LATERAL_SQL} WHERE p.id = $1`, [proposalId]);
  assert.equal(pendingFromLateralRow(none[0]), null);
});

test(`findStaleProcessingPayments > a processing row older than ${STALE_PROCESSING_DAYS} days is reported until it expires`, async () => {
  await seed({ intentId: `pi_${MARK}_stale_a`, processingAgo: `${STALE_PROCESSING_DAYS + 1} days` });
  await seed({ intentId: `pi_${MARK}_fresh`, processingAgo: '1 day' });
  const stale = await findStaleProcessingPayments();
  const mine = stale.filter((r) => r.proposal_id === proposalId);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].stripe_payment_intent_id, `pi_${MARK}_stale_a`);
});

test('assertNoPaymentInFlight > a succeeded intent the webhook has not recorded refuses with the already-received copy, not the bank-days copy', async () => {
  const id = `pi_${MARK}_c_settled`;
  await seed({ intentId: id, status: 'pending' });
  const stripe = fakeStripe({ [id]: { id, status: 'succeeded', amount: 40000 } });
  await assert.rejects(
    assertNoPaymentInFlight({ proposalId, stripe, timeZone: 'America/Chicago' }),
    (err) => err.statusCode === 409 && err.code === 'PAYMENT_IN_FLIGHT' && err.message === settledMessage() && !/four to six/.test(err.message)
  );
});

test('assertNoPaymentInFlight > an intent gone at Stripe comes back as a null tombstone, so it is never fetched twice', async () => {
  const id = `pi_${MARK}_gone`;
  await seed({ intentId: id, status: 'pending' });
  const out = await assertNoPaymentInFlight({ proposalId, stripe: fakeStripe({}), timeZone: 'America/Chicago' });
  assert.equal(out.intents.has(id), true);
  assert.equal(out.intents.get(id), null);
});
