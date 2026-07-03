// GET /api/proposals/:id (single-proposal read). Carved out of crud.js at the
// file-size ratchet: crud.js sat at the 1000-line hard cap when the stated-budget
// join landed, and this route is the read path that grows. Mounted LAST in the
// proposals composition router (see index.js): `/:id` is greedy, so every static
// GET path (`/financials`, `/dashboard-stats`, `/packages`, ...) must win first.
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError } = require('../../utils/errors');
const { setupTimeDisplay } = require('../../utils/setupTime');
const { getMessageLogForProposal } = require('../../utils/messageLog');

const router = express.Router();

/** GET /api/proposals/:id — get single proposal */
router.get('/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone, c.source AS client_source,
           c.cc_id AS client_cc_id,
           sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category, sp.includes AS package_includes,
           u.email AS created_by_email, u.cc_id AS user_cc_id,
           tb.budget_min, tb.budget_max, tb.budget_raw
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN LATERAL (
      -- Stated budget of the TT lead auto-drafted into this proposal: context for
      -- the admin over-budget badge. Newest lead wins, matching /lead-cost.
      SELECT tl.budget_min, tl.budget_max, tl.budget_raw
        FROM thumbtack_leads tl
       WHERE tl.proposal_id = p.id
       ORDER BY tl.id DESC
       LIMIT 1
    ) tb ON true
    WHERE p.id = $1
  `, [req.params.id]);

  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  // Fetch addons + activity log in parallel — both depend only on proposal id.
  // Cap activity log fetch at 100 entries (most recent) — an old proposal can
  // accumulate hundreds of view/update entries otherwise.
  const [addons, activity, messageLog] = await Promise.all([
    pool.query(
      'SELECT * FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [req.params.id]
    ),
    pool.query(
      'SELECT * FROM proposal_activity_log WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.params.id]
    ),
    getMessageLogForProposal(req.params.id),
  ]);

  // setup_time_display: server-derived clock time (service start − effective
  // minutes) for back-of-house display. Raw setup_minutes_before already flows
  // via SELECT p.* (NULL until an admin overrides; null display when unparseable
  // start time). Back-of-house only — never added to the public token response.
  const row = result.rows[0];
  res.json({
    ...row,
    setup_time_display: setupTimeDisplay(row),
    // SERVER-15: pg returns the now-NUMERIC quantity as a string; coerce to a number.
    addons: addons.rows.map(a => ({ ...a, quantity: a.quantity === null ? null : Number(a.quantity) })),
    activity: activity.rows,
    messageLog,
  });
}));

module.exports = router;
