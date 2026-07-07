/**
 * Admin re-trigger endpoints for cc-imported proposals — Task 21.
 *
 * Mounted at /api/admin (NOT under /cc-import/) so the URLs read as
 * /api/admin/proposals/:id/... — these are proposal-level admin actions whose
 * "cc" nature is incidental (only safe to invoke for cc proposals, but they
 * apply to a regular proposal endpoint surface).
 *
 *   /proposals/:id/reenroll-drink-plan-nudge — re-schedule drink-plan nudges
 *                                              for a proposal that already has
 *                                              a drink plan. Idempotent — the
 *                                              underlying scheduleMessage call
 *                                              no-ops on a pending duplicate.
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
const { ValidationError, NotFoundError, ConflictError } = require('../../../utils/errors');
const { logAdminAction } = require('../../../utils/adminAuditLog');
const { scheduleDrinkPlanNudge } = require('../../../utils/drinkPlanNudge');
const { accruePayoutsForProposal } = require('../../../utils/payrollAccrual');

const router = express.Router({ mergeParams: true });

// POST /admin/proposals/:id/reenroll-drink-plan-nudge
//
// Re-schedules drink-plan nudges (email + SMS, T-21 days, 10:00 event-local) for
// a proposal that already has a drink plan. Idempotent: scheduleDrinkPlanNudge
// (via scheduleMessage) no-ops if a pending row for the same recipient already
// exists, so a double-click can't fan out duplicate sends.
router.post(
  '/proposals/:id/reenroll-drink-plan-nudge',
  auth,
  adminOnly,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) throw new ValidationError(undefined, 'id must be an integer');

    const propRes = await pool.query(`SELECT id, client_id FROM proposals WHERE id = $1`, [id]);
    if (propRes.rowCount === 0) throw new NotFoundError('proposal not found');

    const planRes = await pool.query(`SELECT 1 FROM drink_plans WHERE proposal_id = $1 LIMIT 1`, [id]);
    if (planRes.rowCount === 0) throw new ConflictError('no drink plan exists for this proposal');

    try {
      // Clear the durable suppression first (cc-transfer sets it so automatic
      // re-enqueues stay silent) — this button IS the deliberate re-enroll.
      await pool.query('UPDATE drink_plans SET nudge_suppressed = false WHERE proposal_id = $1', [id]);
      await scheduleDrinkPlanNudge(id, pool);
    } catch (err) {
      Sentry.captureException(err, {
        tags: { route: req.path, op: 'reenroll_drink_plan_nudge' },
        extra: { proposalId: id },
      });
      throw err;
    }

    await logAdminAction({
      actorUserId: req.user.id,
      // admin_audit_log.target_user_id REFERENCES users(id); a proposal's
      // client_id targets the clients table (separate from users). Pass null
      // so the FK guard never trips; the proposal_id in metadata is the
      // disambiguator for post-incident lookups.
      targetUserId: null,
      action: 'cc_drink_plan_nudge_reenrolled',
      metadata: { proposal_id: id, client_id: propRes.rows[0].client_id },
    });

    res.json({ ok: true, message: 'Drink-plan nudges scheduled (or already pending)' });
  })
);

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
