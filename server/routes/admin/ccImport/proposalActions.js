/**
 * Admin re-trigger endpoint for cc-imported proposals — Task 21.
 *
 * Mounted at /api/admin (NOT under /cc-import/) so the URLs read as
 * /api/admin/proposals/:id/... — these are proposal-level admin actions whose
 * "cc" nature is incidental (only safe to invoke for cc proposals, but they
 * apply to a regular proposal endpoint surface).
 *
 *   /proposals/:id/reaccrue-payout            — re-run payroll accrual for a
 *                                              proposal. Useful after an admin
 *                                              has cleared stub co-participants
 *                                              from the (deleted 2026-07-07) v1 cc-import review page.
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §9.2 §9.3.D, §9.3.E.
 * Plan reference: docs/superpowers/plans/2026-05-26-checkcherry-import.md Task 21.
 */

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../../db');
const { auth, adminOnly } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../../utils/errors');
const { logAdminAction } = require('../../../utils/adminAuditLog');
const { accruePayoutsForProposal } = require('../../../utils/payrollAccrual');

const router = express.Router({ mergeParams: true });

// POST /admin/proposals/:id/reaccrue-payout
//
// Re-runs payroll accrual for a proposal. accruePayoutsForProposal is itself
// idempotent (UPSERT semantics on payout_events) and returns a structured
// result (skipped|completed) describing the outcome. Used post-link-cleanup
// when admins clear cc stub participants — see specs/2026-05-25-checkcherry-import-design.md §9.3.E.
router.post(
  '/proposals/:id/reaccrue-payout',
  auth,
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new ValidationError(undefined, 'id must be an integer');

    const propRes = await pool.query(`SELECT id, client_id FROM proposals WHERE id = $1`, [id]);
    if (propRes.rowCount === 0) throw new NotFoundError('proposal not found');

    let result;
    try {
      result = await accruePayoutsForProposal(id);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { route: req.path, op: 'reaccrue_payout' },
        extra: { proposalId: id },
      });
      throw err;
    }

    await logAdminAction({
      actorUserId: req.user.id,
      // See comment above re: client_id vs users.id FK.
      targetUserId: null,
      action: 'cc_payout_reaccrued',
      metadata: { proposal_id: id, client_id: propRes.rows[0].client_id, result },
    });

    res.json({ result });
  })
);

module.exports = router;
