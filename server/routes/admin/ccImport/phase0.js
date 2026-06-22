/**
 * Admin CC-Import Review — Section 9.2 §7 Phase 0 give-up endpoints.
 *
 * Two mutation endpoints (both auth + adminOnly, both audited):
 *
 *   /review/phase0-failure/:row_id/accept-loss      — set given_up_at + reason
 *   /review/phase0-failure/:row_id/revert-give-up   — clear give-up + reset attempts
 *
 * Extracted from review.js for the line-count ratchet (CLAUDE.md §"File Size
 * Discipline"). The handlers are conceptually independent of the rest of the
 * Section 9.2 actions: they operate on a sibling table (cc_import_phase0_failures)
 * with no shared state, no cross-section helpers.
 *
 * Spec reference: docs/superpowers/specs/2026-05-25-checkcherry-import-design.md §9.2 §7.
 */

const express = require('express');

const { pool } = require('../../../db');
const { auth, adminOnly } = require('../../../middleware/auth');
const asyncHandler = require('../../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../../utils/errors');
const { logAdminAction } = require('../../../utils/adminAuditLog');

const router = express.Router();

function intParam(name, value) {
  const n = parseInt(value, 10);
  if (!Number.isInteger(n)) {
    throw new ValidationError(undefined, `${name} must be an integer`);
  }
  return n;
}

function trimText(name, value, { required = false, max = 2000, min = 0 } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ValidationError(undefined, `${name} is required`);
    return null;
  }
  const s = String(value).trim();
  if (s.length < min) throw new ValidationError(undefined, `${name} must be at least ${min} chars`);
  if (s.length > max) throw new ValidationError(undefined, `${name} exceeds ${max} chars`);
  return s;
}

// §7 — Phase 0 give-ups: accept loss (URL is permanently dead).
router.post(
  '/review/phase0-failure/:row_id/accept-loss',
  auth,
  adminOnly,
  asyncHandler(async (req, res) => {
    const rowId = intParam('row_id', req.params.row_id);
    const reason = trimText('reason', req.body?.reason, { required: true, min: 1, max: 500 });

    // State guard: row exists, attempts ≥ 10, not yet given up, not resolved.
    const r = await pool.query(
      `UPDATE cc_import_phase0_failures
          SET given_up_at = NOW(), given_up_reason = $2
        WHERE id = $1
          AND given_up_at IS NULL
          AND resolved_at IS NULL
          AND attempt_count >= 10
        RETURNING id, source_url, source_entity, attempt_count`,
      [rowId, reason]
    );
    if (r.rowCount === 0) {
      // Determine whether the row exists or just isn't eligible.
      const exists = await pool.query(
        `SELECT id, given_up_at, resolved_at, attempt_count FROM cc_import_phase0_failures WHERE id = $1`,
        [rowId]
      );
      if (exists.rowCount === 0) throw new NotFoundError('row not found');
      throw new ConflictError('row is not eligible for accept-loss (already actioned or attempt_count < 10)');
    }

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_phase0_accept_loss',
      metadata: {
        row_id: rowId,
        source_url: r.rows[0].source_url,
        source_entity: r.rows[0].source_entity,
        attempt_count: r.rows[0].attempt_count,
        reason,
      },
    });

    res.json({ ok: true });
  })
);

// §7 — Phase 0 give-ups: revert (URL is fetchable again; reset attempt count
// so the next phase 0 run can re-try without immediately hitting the cap).
router.post(
  '/review/phase0-failure/:row_id/revert-give-up',
  auth,
  adminOnly,
  asyncHandler(async (req, res) => {
    const rowId = intParam('row_id', req.params.row_id);

    const r = await pool.query(
      `UPDATE cc_import_phase0_failures
          SET given_up_at = NULL,
              given_up_reason = NULL,
              attempt_count = 0
        WHERE id = $1
          AND given_up_at IS NOT NULL
        RETURNING id, source_url, source_entity`,
      [rowId]
    );
    if (r.rowCount === 0) {
      const exists = await pool.query(
        `SELECT id, given_up_at FROM cc_import_phase0_failures WHERE id = $1`,
        [rowId]
      );
      if (exists.rowCount === 0) throw new NotFoundError('row not found');
      throw new ConflictError('row is not currently in given-up state');
    }

    await logAdminAction({
      actorUserId: req.user.id,
      targetUserId: null,
      action: 'cc_review_phase0_revert_give_up',
      metadata: {
        row_id: rowId,
        source_url: r.rows[0].source_url,
        source_entity: r.rows[0].source_entity,
      },
    });

    res.json({ ok: true });
  })
);

module.exports = router;
