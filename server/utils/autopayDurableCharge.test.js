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

// Each guard test scans EVERY pending row for the proposal, so wipe the
// proposal's sessions first to keep tests independent.
async function clearSessions() {
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [propId]);
}
// Insert a pending intent row with an explicit age so newest-first ordering is
// deterministic (agoInterval e.g. '1 hour'; omit for NOW()).
async function seedSession(intentId, amount, agoInterval) {
  const createdAt = agoInterval ? `NOW() - INTERVAL '${agoInterval}'` : 'NOW()';
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, created_at)
     VALUES ($1, $2, $3, 'pending', ${createdAt})`, [propId, intentId, amount]
  );
}

test('priorBalanceChargeSettling > (a) SKIP on a settling balance intent at a DIFFERENT amount than the new balance', async () => {
  // fixes (1): total_price changed mid-outage, so the settling prior intent's amount
  // (25000) no longer equals the new balanceCents. The old amount-filtered query
  // missed it and double-charged; the amount-blind scan catches it.
  await clearSessions();
  const priorId = `pi_${MARK}_diffamt`;
  await seedSession(priorId, 25000);
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'succeeded', metadata: { payment_type: 'balance' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, true, 'a settling balance intent must block regardless of amount drift');
  assert.equal(r.reason, 'settling');
  assert.equal(r.priorStatus, 'succeeded');
});

test('priorBalanceChargeSettling > (b) SKIP when a NEWER non-balance intent shadows an OLDER settling balance intent', async () => {
  // fixes (2): invoice/drink-plan checkout inserts a newer pending non-balance row.
  // The old newest-only + not_balance→skip:false returned CHARGE; the bounded scan
  // steps past the non-balance intent and finds the older settling balance one.
  await clearSessions();
  const balId = `pi_${MARK}_oldbal`;
  const invId = `pi_${MARK}_newinv`;
  await seedSession(balId, 30000, '2 hours'); // older
  await seedSession(invId, 40000);            // newer (NOW)
  const stripe = fakeStripe({
    [invId]: { id: invId, status: 'succeeded', metadata: { payment_type: 'invoice' } },
    [balId]: { id: balId, status: 'succeeded', metadata: { payment_type: 'balance' } },
  });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, true, 'a newer non-balance intent must not shadow an older settling balance intent');
  assert.equal(r.reason, 'settling');
  assert.equal(r.priorIntentId, balId);
});

test('priorBalanceChargeSettling > (c) a webhook-confirmed (status=succeeded) row is NOT a candidate → CHARGE', async () => {
  // fixes (3): a historically paid-and-credited balance is flipped to 'succeeded'
  // locally by the webhook. status='pending'-only selection excludes it, so it can
  // never read as "settling forever" and wedge every future legitimate charge.
  await clearSessions();
  const paidId = `pi_${MARK}_paidsucc`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 31000, 'succeeded')`, [propId, paidId]
  );
  const stripe = fakeStripe({ [paidId]: { id: paidId, status: 'succeeded', metadata: { payment_type: 'balance' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, false, 'a locally-resolved succeeded row must not block a fresh legitimate charge');
  assert.equal(r.reason, 'absent');
});

test('priorBalanceChargeSettling > (d) scan past a NEWER terminal balance intent to an OLDER settling one → SKIP', async () => {
  await clearSessions();
  const oldSucc = `pi_${MARK}_oldsucc`;
  const newReqpm = `pi_${MARK}_newreqpm`;
  await seedSession(oldSucc, 32000, '2 hours'); // older, settling
  await seedSession(newReqpm, 32000);           // newer, terminal retry
  const stripe = fakeStripe({
    [newReqpm]: { id: newReqpm, status: 'requires_payment_method', metadata: { payment_type: 'balance' } },
    [oldSucc]: { id: oldSucc, status: 'succeeded', metadata: { payment_type: 'balance' } },
  });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, true, 'a newer failed retry must not unblock past an older settling original');
  assert.equal(r.reason, 'settling');
  assert.equal(r.priorIntentId, oldSucc);
});

test('priorBalanceChargeSettling > (d2) a lone terminal balance intent (requires_payment_method) → CHARGE', async () => {
  await clearSessions();
  const priorId = `pi_${MARK}_reqpm`;
  await seedSession(priorId, 26000);
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'requires_payment_method', metadata: { payment_type: 'balance' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, false, 'a terminal requires_payment_method prior intent must NOT block a re-charge');
  assert.equal(r.reason, 'no_settling_balance_intent');
});

test('priorBalanceChargeSettling > (e) SKIP (money-safe) when the prior intent cannot be retrieved', async () => {
  await clearSessions();
  const priorId = `pi_${MARK}_gone`;
  await seedSession(priorId, 28000);
  const stripe = fakeStripe({}); // retrieve throws → can't confirm safe
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, true, 'unconfirmable prior intent leans money-safe: do not fire a second charge');
  assert.equal(r.reason, 'retrieve_failed');
});

test('priorBalanceChargeSettling > (f) CHARGE when no pending rows exist (absent = fresh charge)', async () => {
  await clearSessions();
  const stripe = fakeStripe({});
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, false);
  assert.equal(r.reason, 'absent');
});

test('priorBalanceChargeSettling > a newest non-balance intent with no balance intent behind it → CHARGE', async () => {
  await clearSessions();
  const priorId = `pi_${MARK}_dep`;
  await seedSession(priorId, 27000);
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'succeeded', metadata: { payment_type: 'deposit' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, false, 'a non-balance intent alone must not skip the balance charge');
  assert.equal(r.reason, 'no_settling_balance_intent');
});

test('priorBalanceChargeSettling > (g) a settling drink_plan_with_balance intent (covers balance) → SKIP', async () => {
  // The drink-plan checkout mints payment_type='drink_plan_with_balance' carrying
  // balance_amount_cents when the client pays their outstanding balance through the
  // drink-plan flow. During an outage it settles the balance, so it must block autopay.
  await clearSessions();
  const priorId = `pi_${MARK}_dpbal`;
  await seedSession(priorId, 50000);
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'succeeded', metadata: { payment_type: 'drink_plan_with_balance', balance_amount_cents: '50000' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, true, 'a settling drink_plan_with_balance intent must block a second balance charge');
  assert.equal(r.reason, 'settling');
  assert.equal(r.priorIntentId, priorId);
});

test('priorBalanceChargeSettling > (h) a drink_plan_extras intent (balance_amount_cents=0) does NOT cover balance → CHARGE', async () => {
  // Extras-only drink-plan intents carry balance_amount_cents='0' and do not settle the
  // outstanding balance, so they must not block the legitimate balance charge.
  await clearSessions();
  const priorId = `pi_${MARK}_dpextras`;
  await seedSession(priorId, 12000);
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'succeeded', metadata: { payment_type: 'drink_plan_extras', balance_amount_cents: '0' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, false, 'an extras-only drink-plan intent must not skip the balance charge');
  assert.equal(r.reason, 'no_settling_balance_intent');
});

test('priorBalanceChargeSettling > (i) a covering intent with balance_amount_cents absent but payment_type=balance → SKIP', async () => {
  // Regression on the original type: a plain balance intent has no balance_amount_cents
  // metadata but still covers the balance via payment_type==='balance'.
  await clearSessions();
  const priorId = `pi_${MARK}_balnoamt`;
  await seedSession(priorId, 33000);
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'processing', metadata: { payment_type: 'balance' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, stripe });
  assert.equal(r.skip, true, 'a plain balance intent (no balance_amount_cents) must still block');
  assert.equal(r.reason, 'settling');
  assert.equal(r.priorStatus, 'processing');
});
