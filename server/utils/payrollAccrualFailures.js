/**
 * The record of a payroll accrual that failed, one payroll_accrual_failures row per proposal, so a failure shows on the payroll page and blocks Process instead of passing as success.
 *
 * noteAccrualOutcome runs after every accruePayoutsForProposal (payrollAccrual.js
 * wraps the helper with it, so all of its callers are covered):
 *   - a throw records reason 'error';
 *   - a pay_period_not_open skip on a completed event with an approved worker
 *     who holds no wage line records 'period_closed' (their wages went nowhere,
 *     since accrual never writes a frozen period); the same skip when every
 *     approved worker holds a wage line deletes the row, since a frozen period
 *     is then the designed outcome;
 *   - a completed accrual and every other skip (not completed, no approved
 *     workers, no event date, a legacy CC participant) delete the row: there is
 *     nothing left for the accrual to write.
 * The row keeps the unpaid workers' shift_request ids (unpaid_request_ids). A
 * dismissed 'period_closed' row (an admin paid those workers by hand) stays
 * dismissed while every unpaid worker is one the admin dismissed; a worker who
 * becomes unpaid after the dismissal reopens it. A dismissed 'error' row
 * reopens on the next throw, since a throw can carry new money (a tip placed
 * since). A later completed accrual deletes the row either way. The
 * legal-hold booking is never recorded or listed (money law 15).
 * It is best-effort: a failure to write the record goes to Sentry and never
 * changes what the accrual returned or threw. The row carries a reason code,
 * never an error message; the details are in Sentry.
 *
 * "Holds a wage line" is per approved, non-dropped worker: a payout_events row
 * on their shift under their own payout, in any period, that is not the zero
 * stub the late-tip roll-forward and the clawback write (no contracted hours,
 * no hours, no rate: accrual's own priorStub test, payrollAccrual.js) and not
 * a held line (an off-roster hold zeroes the pay but keeps hours and rate). So
 * a tip-only line, a claw stub, a held line or a teammate's line never stands
 * for a worker's pay, and a worker stopped because their line lives in another
 * period counts.
 *
 * listAccrualProblems feeds the payroll page and the Process gate: every
 * recorded, undismissed failure, plus each completed event dated in an open
 * period with no legacy CC participant and an approved worker without a wage
 * line, reason 'no_lines' (a failure from before this record existed, one whose
 * record write failed, or one an admin dismissed while a worker is still
 * unpaid). With a periodId it narrows both to events dated inside that period,
 * whatever its status. The roster and legacy reads mirror accrual's own
 * (payrollAccrual.js workers query, payrollGuards.isLegacyCcParticipant).
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { isLegalHold, heldProposalIds } = require('./legalHold');

// The approved, non-dropped workers on proposal <p> with no wage line of their
// own on their shift, in any period. <p> is the SQL expression for the id.
const UNPAID_FROM_SQL = (p) => `
  FROM shifts s JOIN shift_requests sr ON sr.shift_id = s.id
   WHERE s.proposal_id = ${p} AND sr.status = 'approved' AND sr.dropped_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM payout_events pe JOIN payouts po ON po.id = pe.payout_id
        WHERE pe.shift_id = sr.shift_id AND po.contractor_id = sr.user_id
          AND pe.held_state IS DISTINCT FROM 'held'
          AND NOT (pe.contracted_hours = 0 AND pe.hours = 0 AND pe.rate_cents = 0))`;
const UNPAID_WORKER_SQL = (p) => `EXISTS (SELECT 1 ${UNPAID_FROM_SQL(p)})`;
// Built once, so a query interpolates only module constants (the
// parameterized-sql static check reads a call inside a query as input).
const UNPAID_FROM_BY_PARAM = UNPAID_FROM_SQL('$1');
const UNPAID_WORKER_BY_ROW = UNPAID_WORKER_SQL('p.id');

// The ON CONFLICT test for keeping a dismissal: a repeated 'period_closed'
// whose unpaid workers are all ones the admin dismissed.
const KEEP_DISMISSAL_SQL = `(payroll_accrual_failures.dismissed_at IS NOT NULL
  AND payroll_accrual_failures.reason = 'period_closed' AND EXCLUDED.reason = 'period_closed'
  AND EXCLUDED.unpaid_request_ids <@ COALESCE(payroll_accrual_failures.unpaid_request_ids, '{}'::int[]))`;

async function recordAccrualFailure(proposalId, reason, unpaidIds = null) {
  // The EXISTS keeps a deleted proposal from raising an FK error here. Every
  // SET reads the existing row (Postgres evaluates ON CONFLICT DO UPDATE
  // against it), so KEEP_DISMISSAL_SQL compares the stored reason and set.
  await pool.query(
    `INSERT INTO payroll_accrual_failures (proposal_id, reason, unpaid_request_ids)
     SELECT $1, $2::text, $3::int[] WHERE EXISTS (SELECT 1 FROM proposals WHERE id = $1)
     ON CONFLICT (proposal_id) DO UPDATE
       SET attempts = payroll_accrual_failures.attempts + 1,
           last_failed_at = NOW(),
           dismissed_at = CASE WHEN ${KEEP_DISMISSAL_SQL} THEN payroll_accrual_failures.dismissed_at END,
           dismissed_by = CASE WHEN ${KEEP_DISMISSAL_SQL} THEN payroll_accrual_failures.dismissed_by END,
           unpaid_request_ids = CASE WHEN ${KEEP_DISMISSAL_SQL} THEN payroll_accrual_failures.unpaid_request_ids
                                     ELSE EXCLUDED.unpaid_request_ids END,
           reason = EXCLUDED.reason`,
    [proposalId, reason, unpaidIds]
  );
}

async function clearAccrualFailure(proposalId) {
  await pool.query('DELETE FROM payroll_accrual_failures WHERE proposal_id = $1', [proposalId]);
}

// The unpaid workers' shift_request ids, sorted; empty when everyone is paid.
async function unpaidRequestIds(proposalId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(array_agg(sr.id ORDER BY sr.id), '{}'::int[]) AS ids ${UNPAID_FROM_BY_PARAM}`,
    [proposalId]
  );
  return rows[0].ids.map(Number);
}

/**
 * outcome is { thrown: true } or { result } (what the accrual returned).
 * Never throws.
 */
async function noteAccrualOutcome(proposalId, outcome) {
  const id = Number(proposalId);
  if (!Number.isInteger(id) || id <= 0) return;
  try {
    if (isLegalHold(id)) return;
    if (outcome && outcome.thrown) {
      await recordAccrualFailure(id, 'error');
      return;
    }
    const r = outcome ? outcome.result : null;
    if (r && r.skipped && r.reason === 'pay_period_not_open') {
      const unpaid = await unpaidRequestIds(id);
      if (unpaid.length) await recordAccrualFailure(id, 'period_closed', unpaid);
      else await clearAccrualFailure(id);
      return;
    }
    await clearAccrualFailure(id);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { util: 'payrollAccrualFailures', step: 'note_outcome' },
      extra: { proposalId: id },
    });
  }
}

/** The recorded, undismissed reason for one proposal ('error' | 'period_closed'), or null. */
async function accrualFailureReason(proposalId, db = pool) {
  const { rows } = await db.query(
    'SELECT reason FROM payroll_accrual_failures WHERE proposal_id = $1 AND dismissed_at IS NULL',
    [Number(proposalId)]
  );
  return rows[0] ? rows[0].reason : null;
}

async function listAccrualProblems(db = pool, { periodId = null } = {}) {
  const pid = periodId === null || periodId === undefined ? null : Number(periodId);
  // Called before any read so a missing or malformed hold list stops here.
  const held = heldProposalIds();
  const { rows } = await db.query(
    `WITH flagged AS (
       SELECT f.proposal_id, f.reason, f.attempts, f.last_failed_at
         FROM payroll_accrual_failures f
         JOIN proposals p ON p.id = f.proposal_id
        WHERE f.dismissed_at IS NULL
          AND NOT (p.id = ANY($2::int[]))
          AND ($1::int IS NULL
               OR EXISTS (SELECT 1 FROM pay_periods pp
                           WHERE pp.id = $1::int AND p.event_date BETWEEN pp.start_date AND pp.end_date))
     ), gaps AS (
       SELECT p.id AS proposal_id, 'no_lines'::text AS reason,
              NULL::int AS attempts, NULL::timestamptz AS last_failed_at
         FROM pay_periods pp
         JOIN proposals p ON p.event_date BETWEEN pp.start_date AND pp.end_date
        WHERE (CASE WHEN $1::int IS NULL THEN pp.status = 'open' ELSE pp.id = $1::int END)
          AND p.status = 'completed'
          AND NOT (p.id = ANY($2::int[]))
          AND NOT EXISTS (SELECT 1 FROM shifts s JOIN shift_requests sr ON sr.shift_id = s.id
                            JOIN users u ON u.id = sr.user_id
                           WHERE s.proposal_id = p.id AND sr.status = 'approved'
                             AND u.cc_id LIKE 'legacy_cc:%')
          AND ${UNPAID_WORKER_BY_ROW}
          AND NOT EXISTS (SELECT 1 FROM flagged fl WHERE fl.proposal_id = p.id)
     )
     SELECT x.proposal_id, x.reason, x.attempts, x.last_failed_at,
            p.event_date, p.event_type, p.event_type_custom, COALESCE(c.name, '') AS client_name
       FROM (SELECT * FROM flagged UNION ALL SELECT * FROM gaps) x
       JOIN proposals p ON p.id = x.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
      ORDER BY p.event_date, x.proposal_id`,
    [Number.isInteger(pid) ? pid : null, held]
  );
  return rows;
}

/**
 * Mark a recorded row settled by an admin. Returns the reason it held, or null
 * when there was no undismissed row. A worker still without a wage line in an
 * open period keeps blocking Process through the 'no_lines' arm regardless.
 */
async function dismissAccrualFailure(proposalId, userId) {
  const { rows } = await pool.query(
    `UPDATE payroll_accrual_failures SET dismissed_at = NOW(), dismissed_by = $2
      WHERE proposal_id = $1 AND dismissed_at IS NULL
      RETURNING reason`,
    [Number(proposalId), userId]
  );
  return rows[0] ? rows[0].reason : null;
}

module.exports = {
  noteAccrualOutcome,
  accrualFailureReason,
  listAccrualProblems,
  dismissAccrualFailure,
};
