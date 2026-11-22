/**
 * Admin payroll accrual problems: the list of completed events payroll did not take (GET /payroll/accrual-problems), a retry of one event's accrual and the audited dismissal of a recorded row an admin settled by hand.
 *
 * The rows come from server/utils/payrollAccrualFailures.js: a recorded failure
 * ('error', 'period_closed') or a completed event in an open period with an
 * approved worker who has no wage line ('no_lines'). Process refuses an open
 * period while one is dated in it (payroll.js). Retry runs the one accrual
 * path, whose wrapper records or clears the row, and answers with the
 * accrual's own skip beside what the page now shows. Dismiss marks a recorded
 * row settled (the override for an accrual that keeps throwing); a 'no_lines'
 * row is never dismissed, since processing over a worker with no wage line
 * loses that pay for good, and dismissing a recorded row cannot hide one,
 * because the 'no_lines' arm still lists it. The legal-hold booking is refused
 * (money law 15). Admin-only, like the rest of payroll; mounted from
 * ./index.js with full paths.
 */
const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { AppError, NotFoundError, ConflictError } = require('../../utils/errors');
const { accruePayoutsForProposal } = require('../../utils/payrollAccrual');
const {
  listAccrualProblems, accrualFailureReason, dismissAccrualFailure,
} = require('../../utils/payrollAccrualFailures');
const { isLegalHold } = require('../../utils/legalHold');
const { logAdminAction } = require('../../utils/adminAuditLog');

const router = express.Router();

const PG_INT_MAX = 2147483647; // proposals.id is a Postgres integer

function proposalIdParam(req) {
  const raw = String(req.params.proposalId || '');
  const id = /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(id) || id <= 0 || id > PG_INT_MAX) throw new NotFoundError('Proposal not found');
  return id;
}

router.get('/payroll/accrual-problems', auth, adminOnly, asyncHandler(async (req, res) => {
  const items = await listAccrualProblems(pool);
  res.json({ items });
}));

// Re-runs the accrual for one event and answers with what the payroll page will
// now show for it: reason null once the event's lines are written.
router.post('/payroll/accrual-problems/:proposalId/retry', auth, adminOnly, asyncHandler(async (req, res) => {
  const proposalId = proposalIdParam(req);
  if (isLegalHold(proposalId)) {
    throw new ConflictError('This booking is on legal hold; payroll is not changed for it', 'LEGAL_HOLD');
  }
  const { rows } = await pool.query('SELECT id FROM proposals WHERE id = $1', [proposalId]);
  if (!rows[0]) throw new NotFoundError('Proposal not found');
  let accrual;
  try {
    accrual = await accruePayoutsForProposal(proposalId);
  } catch (err) {
    Sentry.captureException(err, { tags: { route: 'accrual_problem_retry' }, extra: { proposalId } });
    throw new AppError('The accrual failed again. The details are in Sentry.', 500, 'ACCRUAL_FAILED');
  }
  const reason = await accrualFailureReason(proposalId);
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: null,
    action: 'payroll_accrual_retry',
    metadata: { proposal_id: proposalId, skipped: !!accrual.skipped, skip_reason: accrual.skipped ? accrual.reason : null, reason },
  });
  res.json({ accrual: { skipped: !!accrual.skipped, reason: accrual.skipped ? accrual.reason : null }, reason });
}));

router.post('/payroll/accrual-problems/:proposalId/dismiss', auth, adminOnly, asyncHandler(async (req, res) => {
  const proposalId = proposalIdParam(req);
  const reason = await dismissAccrualFailure(proposalId, req.user.id);
  if (!reason) throw new ConflictError('Nothing recorded to dismiss; an event with no payroll lines needs a retry');
  await logAdminAction({
    actorUserId: req.user.id, targetUserId: null,
    action: 'payroll_accrual_dismiss',
    metadata: { proposal_id: proposalId, reason },
  });
  res.json({ dismissed: true, reason });
}));

module.exports = router;
