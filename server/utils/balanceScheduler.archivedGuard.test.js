require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// P6.5: an archived (cancelled) proposal must never be selected by the autopay
// charger or the auto-completer. Both scheduler queries filter on status, so an
// archived booking is inherently excluded; these tests pin that. Follows the
// claim-snapshot/restore isolation of balanceScheduler.autopayDurable.test.js so
// the shared dev DB is left untouched.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('balanceScheduler.archivedGuard.test.js refuses to run against production');
}

// Fake Stripe (never charge real cards) — install before requiring the SUT.
const createdFor = new Set();
const fakeStripe = {
  paymentIntents: {
    create: async (params) => {
      const pid = String(params.metadata.proposal_id);
      createdFor.add(pid);
      return { id: `pi_faketest_${pid}_${Date.now()}`, status: 'succeeded' };
    },
    retrieve: async (id) => { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; },
  },
};
require('./stripeClient').getStripe = () => fakeStripe;
// Stub auto-complete side effects so a real ended event we complete doesn't write
// payout/marketing rows on the shared DB.
require('./payrollAccrual').accruePayoutsForProposal = async () => {};
require('./marketingHandlers').scheduleReviewRequest = async () => {};
require('./marketingHandlers').scheduleRetentionNudge = async () => {};
require('./changeRequests').cancelPendingChangeRequestsForProposal = async () => {};

const { processAutopayCharges, processEventCompletions } = require('./balanceScheduler');

const MARK = `archguard-${Date.now()}`;
let autopayArchivedId, completeArchivedId;
let claimSnapshot = [];

before(async () => {
  // Snapshot every OTHER autopay-claimable proposal so after() restores its claim.
  const claim = await pool.query(`
    SELECT id, autopay_status, autopay_attempted_at FROM proposals
     WHERE status = 'deposit_paid' AND autopay_enrolled = true
       AND balance_due_date <= CURRENT_DATE
       AND stripe_customer_id IS NOT NULL AND stripe_payment_method_id IS NOT NULL
       AND (autopay_status IS NULL OR autopay_status = 'failed'
            OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '72 hours'))
  `);
  claimSnapshot = claim.rows;

  // An archived proposal that WOULD be autopay-eligible but for its status.
  const a = await pool.query(
    `INSERT INTO proposals
       (client_id, status, archive_reason, cancelled_at, cancelled_by,
        event_type, autopay_enrolled, balance_due_date,
        stripe_customer_id, stripe_payment_method_id, total_price, amount_paid)
     VALUES (NULL, 'archived', 'client_cancelled', NOW(), 'admin',
             $1, true, CURRENT_DATE,
             'cus_faketest', 'pm_faketest', 1000, 100)
     RETURNING id`,
    [`${MARK}-autopay`]
  );
  autopayArchivedId = a.rows[0].id;

  // An archived proposal that ended long ago and is fully paid (would auto-complete
  // if status were confirmed/balance_paid).
  const b = await pool.query(
    `INSERT INTO proposals (client_id, status, archive_reason, event_type, event_timezone,
                            event_date, event_start_time, event_duration_hours,
                            total_price, amount_paid)
     SELECT NULL, 'archived', 'we_cancelled', $1, 'America/Chicago',
            sn::date, to_char(sn, 'HH24:MI'), 4.5, 1000, 1000
       FROM (SELECT ((NOW() - interval '2 days') AT TIME ZONE 'America/Chicago')
                    - interval '4 hours 30 minutes' AS sn) q
     RETURNING id`,
    [`${MARK}-complete`]
  );
  completeArchivedId = b.rows[0].id;

  await processAutopayCharges();
  await processEventCompletions();
});

after(async () => {
  for (const id of [autopayArchivedId, completeArchivedId]) {
    if (!id) continue;
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  await pool.query(`DELETE FROM stripe_sessions WHERE stripe_payment_intent_id LIKE 'pi_faketest_%'`);
  for (const row of claimSnapshot) {
    await pool.query(
      `UPDATE proposals SET autopay_status = $2, autopay_attempted_at = $3 WHERE id = $1`,
      [row.id, row.autopay_status, row.autopay_attempted_at]
    );
  }
  await pool.end();
});

test('processAutopayCharges never charges an archived proposal', async () => {
  assert.equal(createdFor.has(String(autopayArchivedId)), false,
    'an archived proposal must never be autopay-charged');
  const st = await pool.query('SELECT autopay_status FROM proposals WHERE id = $1', [autopayArchivedId]);
  assert.equal(st.rows[0].autopay_status, null, 'archived proposal was not claimed');
});

test('processEventCompletions never completes an archived proposal', async () => {
  const { rows } = await pool.query('SELECT status FROM proposals WHERE id = $1', [completeArchivedId]);
  assert.equal(rows[0].status, 'archived', 'an archived proposal must stay archived, never auto-complete');
});
