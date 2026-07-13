require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('balanceScheduler.autopayDurable.test.js refuses to run against production');
}

// Fake Stripe injected via the stripeClient.getStripe seam. balanceScheduler
// destructures getStripe at module load, so the stub MUST be installed before
// requiring balanceScheduler (mirrors the payrollAccrual stub in the sibling
// suite). create() records the proposal ids it charged and returns a prefixed
// fake intent id; retrieve() answers from a canned map.
const createdFor = new Set();
const retrieveMap = {};
const fakeStripe = {
  paymentIntents: {
    create: async (params) => {
      const pid = String(params.metadata.proposal_id);
      createdFor.add(pid);
      return { id: `pi_faketest_${pid}_${Date.now()}`, status: 'succeeded' };
    },
    retrieve: async (id) => {
      if (!retrieveMap[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
      return retrieveMap[id];
    },
  },
};
require('./stripeClient').getStripe = () => fakeStripe;

const { processAutopayCharges } = require('./balanceScheduler');

const MARK = `apdur-${Date.now()}`;
let freshId, skipId, ttlId;
let claimSnapshot = [];

async function seed(mark, { autopayStatus, attemptedInterval }) {
  const attempted = attemptedInterval ? `NOW() - INTERVAL '${attemptedInterval}'` : 'NULL';
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, status, event_type, autopay_enrolled, balance_due_date,
        stripe_customer_id, stripe_payment_method_id, total_price, amount_paid,
        autopay_status, autopay_attempted_at)
     VALUES (NULL, 'deposit_paid', $1, true, CURRENT_DATE,
             'cus_faketest', 'pm_faketest', 1000, 900, $2, ${attempted})
     RETURNING id`,
    [mark, autopayStatus]
  );
  return r.rows[0].id;
}

before(async () => {
  // Snapshot every OTHER proposal the DB-wide claim could grab so after() can
  // restore its claim state — the fake charge moves no real money but must not
  // strand a stranger's autopay claim on the shared dev DB.
  const claim = await pool.query(`
    SELECT id, autopay_status, autopay_attempted_at FROM proposals
     WHERE status = 'deposit_paid' AND autopay_enrolled = true
       AND balance_due_date <= CURRENT_DATE
       AND stripe_customer_id IS NOT NULL AND stripe_payment_method_id IS NOT NULL
       AND (autopay_status IS NULL OR autopay_status = 'failed'
            OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '72 hours'))
  `);
  claimSnapshot = claim.rows;

  freshId = await seed(`${MARK}-fresh`, { autopayStatus: null });                                   // (a) durable insert
  skipId  = await seed(`${MARK}-skip`,  { autopayStatus: 'in_progress', attemptedInterval: '80 hours' }); // (b) skip
  ttlId   = await seed(`${MARK}-ttl`,   { autopayStatus: 'in_progress', attemptedInterval: '48 hours' }); // (c) 72h TTL

  // Prior balance intent for the skip proposal: durable row exists (amount =
  // balanceCents = (1000-900)*100 = 10000) and Stripe reports it succeeded —
  // the webhook that would have cleared the claim is 'down'.
  const priorId = `pi_prior_${skipId}`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 10000, 'pending')`, [skipId, priorId]
  );
  retrieveMap[priorId] = { id: priorId, status: 'succeeded', metadata: { payment_type: 'balance' } };

  await processAutopayCharges(); // single DB-wide run; the tests assert on resulting state
});

after(async () => {
  for (const id of [freshId, skipId, ttlId]) {
    if (!id) continue;
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  // Purge durable rows the fake charge wrote for OTHER claimable proposals and
  // restore their claim state.
  await pool.query(`DELETE FROM stripe_sessions WHERE stripe_payment_intent_id LIKE 'pi_faketest_%'`);
  for (const row of claimSnapshot) {
    await pool.query(
      `UPDATE proposals SET autopay_status = $2, autopay_attempted_at = $3 WHERE id = $1`,
      [row.id, row.autopay_status, row.autopay_attempted_at]
    );
  }
  await pool.end();
});

test('(a) writes a durable stripe_sessions row for a fresh balance charge', async () => {
  assert.ok(createdFor.has(String(freshId)), 'the fresh proposal must be charged');
  const { rows } = await pool.query(
    `SELECT amount, status FROM stripe_sessions
      WHERE proposal_id = $1 AND stripe_payment_intent_id LIKE 'pi_faketest_%'`, [freshId]
  );
  assert.equal(rows.length, 1, 'exactly one durable balance row persisted at charge time');
  assert.equal(Number(rows[0].amount), 10000);
  assert.equal(rows[0].status, 'pending');
});

test('(b) SKIPS the re-charge when the prior balance intent is already succeeded', async () => {
  assert.equal(createdFor.has(String(skipId)), false,
    'must NOT fire a second charge for a stale in_progress claim whose prior balance intent succeeded');
  const { rows } = await pool.query(
    `SELECT 1 FROM stripe_sessions
      WHERE proposal_id = $1 AND stripe_payment_intent_id LIKE 'pi_faketest_%'`, [skipId]
  );
  assert.equal(rows.length, 0, 'no new durable row — the re-charge was skipped');
  const st = await pool.query('SELECT autopay_status FROM proposals WHERE id = $1', [skipId]);
  assert.equal(st.rows[0].autopay_status, 'in_progress', 'claim left in_progress for the webhook/reconcile');
});

test('(c) 72h TTL: a 48h-stale in_progress claim is NOT re-claimed', async () => {
  assert.equal(createdFor.has(String(ttlId)), false,
    'a 48h-old in_progress claim is inside the 72h TTL and must not be re-charged');
  const st = await pool.query('SELECT autopay_status FROM proposals WHERE id = $1', [ttlId]);
  assert.equal(st.rows[0].autopay_status, 'in_progress', 'untouched claim stays in_progress');
});
