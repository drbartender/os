// Lead call bridge: needs-attention feed (spec 2026-07-18 section 5.2).
// Open attention rows = chains that ended without a real conversation
// (missed / failed / skipped_*), younger than 7 days, on leads still 'new'.
// Driven FROM lead_call_attempts, so pre-feature leads (no attempt row)
// never surface. Read-only; the overview NeedsYouStrip consumes it.
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

/** GET /api/admin/lead-call-attention — open lead-call attention rows. */
router.get('/lead-call-attention', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT a.id, a.status, a.detail, a.created_at,
           l.customer_name, l.proposal_id, l.client_id
    FROM lead_call_attempts a
    JOIN thumbtack_leads l ON l.id = a.lead_id
    WHERE a.status IN ('missed','failed','skipped_after_hours','skipped_unconfigured','skipped_invalid_phone')
      AND a.created_at > NOW() - INTERVAL '7 days'
      AND l.status = 'new'
    ORDER BY a.created_at DESC, a.id DESC
  `);
  res.json(result.rows);
}));

module.exports = router;
