/**
 * DB-side tip helpers for payroll: match a tip to the shift (event) it belongs
 * to, and capture the real Stripe processing fee for tips and proposal
 * payments. Fee capture runs at accrual time, not in the tip webhook: when the
 * webhook fires the Stripe charge has usually not settled, so the
 * balance-transaction fee is not yet available.
 */
const { pool } = require('../db');
const Sentry = require('@sentry/node');
const { getStripe } = require('./stripeClient');
const { matchTipToShift } = require('./payrollMath');

const POST_GRACE = "INTERVAL '3 hours'";

/**
 * The actual Stripe processing fee for a payment intent, in cents, or null
 * when the charge has not settled yet (no balance transaction available).
 */
async function stripeFeeFor(paymentIntentId) {
  const stripe = getStripe();
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
    expand: ['latest_charge.balance_transaction'],
  });
  const fee = pi
    && pi.latest_charge
    && pi.latest_charge.balance_transaction
    && pi.latest_charge.balance_transaction.fee;
  return fee === null || fee === undefined ? null : fee;
}

/**
 * Match a tip to the shift whose service window contains tipped_at, among the
 * shifts the tipped bartender worked. Sets tips.shift_id, or leaves it NULL
 * (unassigned) when no window matches. Called from the tip webhook.
 *
 * The service window runs from the event's setup start (event start minus the
 * shift's setup lead) to 3 hours after the scheduled end, computed in the
 * event's own timezone. ORDER BY s.id makes the overlap tie-break deterministic.
 */
async function matchTipToEvent(tipId) {
  const tipRes = await pool.query(
    'SELECT target_user_id, tipped_at FROM tips WHERE id = $1',
    [tipId]
  );
  const tip = tipRes.rows[0];
  if (!tip) return;

  const windowRes = await pool.query(
    `SELECT s.id AS shift_id,
            EXTRACT(EPOCH FROM (
              ((p.event_date + p.event_start_time::time)
                  AT TIME ZONE COALESCE(p.event_timezone, 'America/Chicago'))
                - (COALESCE(s.setup_minutes_before, 60) || ' minutes')::interval
            )) * 1000 AS start_ms,
            EXTRACT(EPOCH FROM (
              ((p.event_date + p.event_start_time::time)
                  AT TIME ZONE COALESCE(p.event_timezone, 'America/Chicago'))
                + (COALESCE(p.event_duration_hours, 0) || ' hours')::interval
                + ${POST_GRACE}
            )) * 1000 AS end_ms
     FROM shift_requests sr
     JOIN shifts s ON s.id = sr.shift_id
     JOIN proposals p ON p.id = s.proposal_id
     WHERE sr.user_id = $1
       AND sr.status = 'approved'
       AND p.event_start_time ~* '^[0-9]{1,2}:[0-9]{2}( ?[AP]M)?$'
     ORDER BY s.id`,
    [tip.target_user_id]
  );

  const windows = windowRes.rows.map(r => ({
    shiftId: r.shift_id,
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
  }));
  const tippedAtMs = new Date(tip.tipped_at).getTime();
  if (!Number.isFinite(tippedAtMs)) return;
  const shiftId = matchTipToShift(tippedAtMs, windows);
  if (shiftId !== null && shiftId !== undefined) {
    await pool.query('UPDATE tips SET shift_id = $1 WHERE id = $2', [shiftId, tipId]);
    // Accrual already ran once at event completion, so the tip is not yet on any
    // payout. If the matched shift's pay period is already frozen, roll it forward
    // so the tip lands on a bartender payout next period. Otherwise (period open,
    // or none yet) re-accrue the proposal so the tip folds into this period's
    // payout, mirroring the admin manual-assign route. Both followups manage
    // their own transactions, so they run outside any transaction here. A failed
    // followup must never crash tip matching, but it must be loudly captured.
    try {
      const { rows: ps } = await pool.query(
        `SELECT s.proposal_id, pp.status
           FROM shifts s
           JOIN proposals pr ON pr.id = s.proposal_id
      LEFT JOIN pay_periods pp ON pr.event_date BETWEEN pp.start_date AND pp.end_date
          WHERE s.id = $1
          LIMIT 1`,
        [shiftId]
      );
      const row = ps[0];
      if (row && row.status && row.status !== 'open') {
        const { rollForwardLateTip } = require('./payrollLateTip');
        await rollForwardLateTip(tipId);
      } else if (row && row.proposal_id) {
        const { accruePayoutsForProposal } = require('./payrollAccrual');
        await accruePayoutsForProposal(row.proposal_id);
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { util: 'matchTipToEvent', step: 'post_match_followup' } });
    }
  }
}

/**
 * Capture missing Stripe fees for the credit-card tips matched to a proposal's
 * shifts, storing each on tips.fee_cents. Run at accrual time, by which point
 * the charges have settled. Best-effort per tip.
 */
async function captureTipFeesForProposal(proposalId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.stripe_payment_intent_id
     FROM tips t JOIN shifts s ON s.id = t.shift_id
     WHERE s.proposal_id = $1 AND t.fee_cents IS NULL`,
    [proposalId]
  );
  for (const row of rows) {
    try {
      const fee = await stripeFeeFor(row.stripe_payment_intent_id);
      if (fee !== null && fee !== undefined) {
        await pool.query('UPDATE tips SET fee_cents = $1 WHERE id = $2', [fee, row.id]);
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { step: 'tip_fee_capture' } });
    }
  }
}

/**
 * Capture missing Stripe fees for a proposal's card payments, storing each on
 * proposal_payments.fee_cents. Payments with no Stripe payment intent (cash,
 * check) are skipped and correctly carry no fee. Best-effort per payment.
 */
async function captureProposalPaymentFees(proposalId) {
  const { rows } = await pool.query(
    `SELECT id, stripe_payment_intent_id FROM proposal_payments
     WHERE proposal_id = $1 AND fee_cents IS NULL
       AND stripe_payment_intent_id IS NOT NULL`,
    [proposalId]
  );
  for (const row of rows) {
    try {
      const fee = await stripeFeeFor(row.stripe_payment_intent_id);
      if (fee !== null && fee !== undefined) {
        await pool.query(
          'UPDATE proposal_payments SET fee_cents = $1 WHERE id = $2',
          [fee, row.id]
        );
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { step: 'proposal_payment_fee_capture' } });
    }
  }
}

module.exports = {
  matchTipToEvent, captureTipFeesForProposal, captureProposalPaymentFees,
};
