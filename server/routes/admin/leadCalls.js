// Lead call bridge: needs-attention feed. NARROWED 2026-07-20 per Dallas:
// a missed or after-hours lead needs no callback (speed-to-lead value dies
// with the moment; follow-up is the normal email/SMS pipeline), so those
// are NOT attention items. Only system-fault chains surface: the machine
// could not place calls at all (Twilio failure, missing config, bad phone
// data). At healthy steady state this feed is empty and the Sales tab's
// lead-call items simply never exist. 7-day window; a lead that leaves
// 'new' clears its item. Driven FROM lead_call_attempts, so pre-feature
// leads never surface. Read-only; the overview NeedsYouStrip consumes it.
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
    WHERE a.status IN ('failed','skipped_unconfigured','skipped_invalid_phone')
      AND a.created_at > NOW() - INTERVAL '7 days'
      AND l.status = 'new'
    ORDER BY a.created_at DESC, a.id DESC
  `);
  res.json(result.rows);
}));

module.exports = router;
