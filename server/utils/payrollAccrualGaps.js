// Payroll accrual gaps: finds workers on a completed event in a pay period with no pay line anywhere, retries their accrual, and lists what is still missing.
//
// Accrual runs from many places (mark completed, auto-complete, tip assign,
// roster changes on a completed event), and each one treats a failure as
// best-effort: it reports to Sentry and moves on. Nothing retried it, so a
// failed accrual left a staffer unpaid with no trace on the payroll screen.
// The period-process route calls healAccrualGaps before it freezes a period:
// a transient failure heals on the retry, and a lasting one refuses the
// process with the proposals named, so payroll sees it before payday.
//
// A gap is an approved, undropped worker on a shift of a completed proposal
// whose event date falls in the period, with no payout_events row for that
// contractor and shift in ANY period (accrual never mints a second line for a
// shift whose line already lives in another period). Proposals with a legacy
// CC stub participant are left out, since accrual skips them by design, and so
// is the legal-hold proposal (money law 15: nothing writes to it, so a retry
// must never reach it and a gap on it must never block a payday).

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { heldProposalIds } = require('./legalHold');

/**
 * Workers on completed events in the period with no pay line anywhere.
 * @returns {Promise<Array<{proposal_id:number, shift_id:number, user_id:number}>>}
 */
async function findAccrualGaps(periodId, exec = pool) {
  const { rows } = await exec.query(
    `SELECT DISTINCT p.id AS proposal_id, s.id AS shift_id, sr.user_id
       FROM pay_periods pp
       JOIN proposals p ON p.event_date BETWEEN pp.start_date AND pp.end_date
       JOIN shifts s ON s.proposal_id = p.id
       JOIN shift_requests sr ON sr.shift_id = s.id
      WHERE pp.id = $1
        AND p.status = 'completed'
        AND p.id <> ALL($2::int[])
        AND sr.status = 'approved' AND sr.dropped_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM shift_requests sr2
            JOIN shifts s2 ON s2.id = sr2.shift_id
            JOIN users u ON u.id = sr2.user_id
           WHERE s2.proposal_id = p.id AND sr2.status = 'approved'
             AND u.cc_id LIKE 'legacy_cc:%')
        AND NOT EXISTS (
          SELECT 1 FROM payout_events pe
            JOIN payouts po ON po.id = pe.payout_id
           WHERE pe.shift_id = s.id AND po.contractor_id = sr.user_id)
      ORDER BY p.id, s.id, sr.user_id`,
    [periodId, heldProposalIds()]
  );
  return rows;
}

/**
 * Retry accrual once for every proposal with a gap, then list what is still
 * missing. A retry that throws is reported and left as a gap.
 * @param {number} periodId
 * @param {{ accrue: Function }} deps accruePayoutsForProposal, injected so the
 *   caller's binding is the one that runs
 * @returns {Promise<{ retried: number[], remaining: Array<{proposal_id, shift_id, user_id}> }>}
 */
async function healAccrualGaps(periodId, { accrue }) {
  const gaps = await findAccrualGaps(periodId);
  const proposalIds = [...new Set(gaps.map((g) => g.proposal_id))];
  for (const proposalId of proposalIds) {
    try {
      await accrue(proposalId);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { route: 'payroll_process', step: 'accrual_gap_retry' },
        extra: { periodId, proposalId },
      });
    }
  }
  const remaining = proposalIds.length ? await findAccrualGaps(periodId) : [];
  return { retried: proposalIds, remaining };
}

module.exports = { findAccrualGaps, healAccrualGaps };
