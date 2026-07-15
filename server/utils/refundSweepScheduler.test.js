require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// refundSweepScheduler (B6): the stranded-pending-refund healer. Aged 'pending'
// proposal_refunds rows (no stripe_refund_id) are reconciled against Stripe's
// refunds.list — adopted through applyRefundReconciliation (the single
// authority) when a matching refund exists, else marked 'failed'. DB-bound;
// Stripe is a DI stub. One pooled connection per adoption (Stripe list()
// happens BEFORE pool.connect(); the client notification tails after release).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const sweep = require('./refundSweepScheduler');

if (process.env.NODE_ENV === 'production') {
  throw new Error('refundSweepScheduler.test.js refuses to run against production');
}

const N = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const adoptIntent = `pi_swp_adopt_${N}`;
let clientId, proposalId, invoiceId, payId;

// Fake Stripe. byIntent maps a payment_intent → the array refunds.list should
// return for it, or the sentinel '__throw__'. An UNKNOWN intent throws (a
// StripeInvalidRequestError), which both isolates this suite from any foreign
// aged-pending rows on the shared dev DB (a foreign row is skipped, never
// marked failed) and exercises the amendment's "thrown list error → skip".
function fakeStripe(byIntent = {}, calls = []) {
  return {
    _calls: calls,
    refunds: {
      list: async (params = {}) => {
        calls.push(params);
        const pi = params.payment_intent;
        if (!(pi in byIntent)) {
          const e = new Error('no such payment_intent (test isolation)');
          e.type = 'StripeInvalidRequestError';
          throw e;
        }
        const spec = byIntent[pi];
        if (spec === '__throw__') {
          const e = new Error('list error (wrong mode / outage)');
          e.type = 'StripeAPIError';
          throw e;
        }
        return { data: spec };
      },
    },
  };
}

async function insertPending({ intent, amount, ageMinutes, paymentId = null, reason }) {
  const { rows } = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, status, created_at)
     VALUES ($1,$2,$3,$4,$5,1000,900,'pending', NOW() - make_interval(mins => $6))
     RETURNING id`,
    [proposalId, paymentId, intent, amount, reason || `sweep test ${intent || 'nullintent'}`, ageMinutes]
  );
  return rows[0].id;
}

const refundRow = async (id) =>
  (await pool.query('SELECT status, stripe_refund_id FROM proposal_refunds WHERE id = $1', [id])).rows[0];
const amountPaid = async () =>
  Number((await pool.query('SELECT amount_paid FROM proposals WHERE id = $1', [proposalId])).rows[0].amount_paid);

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('RefundSweep Test', $1) RETURNING id`,
    [`refsweep-${N}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid)
     VALUES ($1, 'balance_paid', 1000, 1000) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Balance', 100000, 100000, 'paid') RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  invoiceId = inv.rows[0].id;
  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status, stripe_payment_intent_id)
     VALUES ($1, 'balance', 100000, 'succeeded', $2) RETURNING id`,
    [proposalId, adoptIntent]
  );
  payId = pay.rows[0].id;
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 100000)`,
    [invoiceId, payId]
  );
});

after(async () => {
  if (proposalId) {
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [proposalId]);
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('strand-heal: an aged pending row whose Stripe list is empty is marked failed', async () => {
  const intent = `pi_swp_strand_${N}`;
  const rowId = await insertPending({ intent, amount: 11000, ageMinutes: 120 });
  await sweep.sweepStalePendingRefunds({ stripe: fakeStripe({ [intent]: [] }) });
  const r = await refundRow(rowId);
  assert.equal(r.status, 'failed', 'stranded pre-Stripe row healed to failed (today nothing transitions it)');
});

test('adoption: metadata-matched refund reconciles exactly once; second sweep is a no-op', async () => {
  const rowId = await insertPending({ intent: adoptIntent, amount: 20000, ageMinutes: 120, paymentId: payId });
  const refundObj = {
    id: `re_swp_adopt_${N}`,
    amount: 20000,
    status: 'succeeded',
    metadata: { proposal_refund_row_id: String(rowId), proposal_id: String(proposalId) },
  };
  const stripe = fakeStripe({ [adoptIntent]: [refundObj] });

  const paidBefore = await amountPaid();
  await sweep.sweepStalePendingRefunds({ stripe });

  const r = await refundRow(rowId);
  assert.equal(r.status, 'succeeded', 'row adopted to succeeded');
  assert.equal(r.stripe_refund_id, refundObj.id, 'stripe_refund_id stamped from the matched candidate');
  const paidAfter = await amountPaid();
  assert.equal(paidBefore - paidAfter, 200, 'amount_paid dropped by the refund exactly once ($200 = 20000c)');
  const rev = await pool.query(
    `SELECT COUNT(*)::int AS n FROM invoice_payments WHERE refund_id = $1 AND amount < 0`, [rowId]);
  assert.equal(rev.rows[0].n, 1, 'exactly one invoice reversal row');

  // Second sweep: the row is now 'succeeded' → excluded from the aged-pending
  // SELECT; the ledger must not move again.
  await sweep.sweepStalePendingRefunds({ stripe });
  assert.equal(await amountPaid(), paidAfter, 'idempotent: second sweep does not re-decrement amount_paid');
  const rev2 = await pool.query(
    `SELECT COUNT(*)::int AS n FROM invoice_payments WHERE refund_id = $1 AND amount < 0`, [rowId]);
  assert.equal(rev2.rows[0].n, 1, 'idempotent: no second reversal');
});

test('ambiguity: two same-amount unmatched candidates leave the row untouched', async () => {
  const intent = `pi_swp_ambig_${N}`;
  const rowId = await insertPending({ intent, amount: 13000, ageMinutes: 120 });
  const stripe = fakeStripe({ [intent]: [
    { id: `re_amb_a_${N}`, amount: 13000, status: 'succeeded', metadata: {} },
    { id: `re_amb_b_${N}`, amount: 13000, status: 'succeeded', metadata: {} },
  ] });
  await sweep.sweepStalePendingRefunds({ stripe });
  const r = await refundRow(rowId);
  assert.equal(r.status, 'pending', 'ambiguous multi-candidate row is never guessed → stays pending');
  assert.equal(r.stripe_refund_id, null);
});

test('age gate: a pending row younger than 30 minutes is untouched and never queried', async () => {
  const intent = `pi_swp_age_${N}`;
  const rowId = await insertPending({ intent, amount: 14000, ageMinutes: 5 });
  const calls = [];
  await sweep.sweepStalePendingRefunds({ stripe: fakeStripe({ [intent]: [] }, calls) });
  const r = await refundRow(rowId);
  assert.equal(r.status, 'pending', 'fresh (<30m) row not swept');
  assert.ok(!calls.some((c) => c.payment_intent === intent), 'fresh row never queried against Stripe');
});

test('race guard: a row adopted between list and mark-failed is not clobbered', async () => {
  const intent = `pi_swp_race_${N}`;
  const rowId = await insertPending({ intent, amount: 15000, ageMinutes: 120 });
  // The fake flips the row to 'succeeded' DURING list() (a concurrent webhook
  // adoption), then returns [] so the sweep would try to mark-failed. The
  // guarded UPDATE (WHERE status='pending' AND stripe_refund_id IS NULL) must
  // match nothing → rowCount 0 → the adopted row survives.
  const stripe = {
    refunds: {
      list: async ({ payment_intent }) => {
        if (payment_intent === intent) {
          await pool.query(
            `UPDATE proposal_refunds SET status = 'succeeded', stripe_refund_id = $2 WHERE id = $1`,
            [rowId, `re_race_${N}`]);
          return { data: [] };
        }
        const e = new Error('unknown'); e.type = 'StripeInvalidRequestError'; throw e;
      },
    },
  };
  await sweep.sweepStalePendingRefunds({ stripe });
  const r = await refundRow(rowId);
  assert.equal(r.status, 'succeeded', 'guarded UPDATE did not clobber the concurrently-adopted row');
});

test('NULL-intent aged pending row is never listed and stays untouched [amendment]', async () => {
  const rowId = await insertPending({ intent: null, amount: 16000, ageMinutes: 120 });
  const calls = [];
  await sweep.sweepStalePendingRefunds({ stripe: fakeStripe({}, calls) });
  const r = await refundRow(rowId);
  assert.equal(r.status, 'pending', 'NULL-intent row left pending (unadoptable — must never be marked failed)');
  assert.ok(
    calls.every((c) => c.payment_intent !== null && c.payment_intent !== undefined),
    'refunds.list was NEVER called with a null/undefined payment_intent (stripe-node would drop it → account-wide list)'
  );
});

test('a thrown refunds.list error skips the row (stays pending, never mark-failed) [amendment]', async () => {
  const intent = `pi_swp_lerr_${N}`;
  const rowId = await insertPending({ intent, amount: 17000, ageMinutes: 120 });
  await sweep.sweepStalePendingRefunds({ stripe: fakeStripe({ [intent]: '__throw__' }) });
  const r = await refundRow(rowId);
  assert.equal(r.status, 'pending', 'thrown list error leaves the row pending, never marks it failed');
});
