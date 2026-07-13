require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { recordBalanceIntent, priorBalanceChargeSettling } = require('./autopayDurableCharge');

if (process.env.NODE_ENV === 'production') {
  throw new Error('autopayDurableCharge.test.js refuses to run against production');
}

const MARK = `adc-${Date.now()}`;
let propId;

// Fake Stripe — retrieve answers from a canned map; a missing id throws like Stripe.
function fakeStripe(intentsById) {
  return { paymentIntents: { retrieve: async (id) => {
    if (!intentsById[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
    return intentsById[id];
  } } };
}

before(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, balance_due_date)
     VALUES (NULL, 'deposit_paid', $1, 1000, 900, CURRENT_DATE) RETURNING id`,
    [`${MARK}-type`]
  );
  propId = p.rows[0].id;
});

after(async () => {
  if (propId) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [propId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [propId]);
  }
  await pool.end();
});

test('recordBalanceIntent > inserts one durable pending row; redelivery is a no-op', async () => {
  const intentId = `pi_${MARK}_dur`;
  await recordBalanceIntent({ proposalId: propId, intentId, amountCents: 10000 });
  await recordBalanceIntent({ proposalId: propId, intentId, amountCents: 10000 }); // ON CONFLICT DO NOTHING
  const { rows } = await pool.query(
    `SELECT amount, status FROM stripe_sessions WHERE stripe_payment_intent_id = $1`, [intentId]
  );
  assert.equal(rows.length, 1, 'exactly one durable row (idempotent on redelivery)');
  assert.equal(Number(rows[0].amount), 10000);
  assert.equal(rows[0].status, 'pending');
});

test('priorBalanceChargeSettling > SKIP when the prior balance intent is succeeded (webhook down)', async () => {
  const priorId = `pi_${MARK}_succ`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 25000, 'pending')`, [propId, priorId]
  );
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'succeeded', metadata: { payment_type: 'balance' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 25000, stripe });
  assert.equal(r.skip, true);
  assert.equal(r.priorStatus, 'succeeded');
});

test('priorBalanceChargeSettling > CHARGE when the prior balance intent is terminal (requires_payment_method)', async () => {
  const priorId = `pi_${MARK}_reqpm`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 26000, 'pending')`, [propId, priorId]
  );
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'requires_payment_method', metadata: { payment_type: 'balance' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 26000, stripe });
  assert.equal(r.skip, false, 'a canceled/requires_payment_method prior intent must NOT block a re-charge');
});

test('priorBalanceChargeSettling > CHARGE when no prior balance row exists (absent = fresh charge)', async () => {
  const stripe = fakeStripe({});
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 99999, stripe });
  assert.equal(r.skip, false);
  assert.equal(r.reason, 'absent');
});

test('priorBalanceChargeSettling > CHARGE when the amount-matching row is NOT a balance intent', async () => {
  const priorId = `pi_${MARK}_dep`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 27000, 'pending')`, [propId, priorId]
  );
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'succeeded', metadata: { payment_type: 'deposit' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 27000, stripe });
  assert.equal(r.skip, false, 'an amount-collision with a non-balance intent must not skip the balance charge');
  assert.equal(r.reason, 'not_balance');
});

test('priorBalanceChargeSettling > SKIP (money-safe) when the prior intent cannot be retrieved', async () => {
  const priorId = `pi_${MARK}_gone`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 28000, 'pending')`, [propId, priorId]
  );
  const stripe = fakeStripe({}); // retrieve throws → can't confirm safe
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 28000, stripe });
  assert.equal(r.skip, true, 'unconfirmable prior intent leans money-safe: do not fire a second charge');
  assert.equal(r.reason, 'retrieve_failed');
});
