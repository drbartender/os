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
  const [addons, activity, messageLog, leadCall, firstReply] = await Promise.all([
    pool.query(
      'SELECT * FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [req.params.id]
    ),
    pool.query(
      'SELECT * FROM proposal_activity_log WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 100',
      [req.params.id]
    ),
    getMessageLogForProposal(req.params.id),
    // Lead call bridge outcome for TT-drafted proposals (newest lead wins,
    // matching the budget lateral above). NULL for pre-feature / non-TT
    // proposals; the detail view renders nothing then.
    pool.query(
      `SELECT a.status, a.answered_by, a.bridge_duration_sec, a.created_at
         FROM lead_call_attempts a
         JOIN thumbtack_leads l ON l.id = a.lead_id
        WHERE l.proposal_id = $1
        ORDER BY a.id DESC
        LIMIT 1`,
      [req.params.id]
    ),
    // Auto first-reply outcome for TT-drafted proposals (newest lead wins,
    // matching the laterals above). `not_needed` collapses to null below —
    // the detail view renders a line only when a reply was actually queued.
    pool.query(
      `SELECT l.first_reply_status, l.first_reply_template, l.first_reply_sent_at
         FROM thumbtack_leads l
        WHERE l.proposal_id = $1
        ORDER BY l.id DESC
        LIMIT 1`,
      [req.params.id]
    ),
  ]);

  const fr = firstReply.rows[0];

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
    lead_call: leadCall.rows[0] || null,
    first_reply: (!fr || fr.first_reply_status === 'not_needed') ? null : {
      status: fr.first_reply_status,
      template: fr.first_reply_template,
      sent_at: fr.first_reply_sent_at,
    },
  });
}));

module.exports = router;
