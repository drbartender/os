/**
 * Enrolling leads into a sequence, and reading enrollments.
 *
 * Extracted from the single 987-line emailMarketing.js. Paths and mount
 * order are unchanged; see ./index.js for why the order still matters.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const router = express.Router();
// ─── Enrollment ───────────────────────────────────────────────────

/** POST /campaigns/:id/enroll — enroll leads in a sequence */
router.post('/campaigns/:id/enroll', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { lead_ids } = req.body;
  if (!lead_ids || !lead_ids.length) {
    throw new ValidationError({ lead_ids: 'Select at least one lead to enroll.' });
  }
  const campaign = await pool.query(
    'SELECT * FROM email_campaigns WHERE id = $1 AND type = $2',
    [req.params.id, 'sequence']
  );
  if (!campaign.rows[0]) throw new NotFoundError('Sequence campaign not found.');

  // Get first step delay to calculate next_step_due_at
  const firstStep = await pool.query(
    'SELECT delay_days, delay_hours FROM email_sequence_steps WHERE campaign_id = $1 ORDER BY step_order LIMIT 1',
    [req.params.id]
  );

  // Bulk INSERT: one query for N leads instead of N per-lead round-trips.
  // Only enroll lead IDs that actually exist (guards against stale client state).
  const delay_days = firstStep.rows[0]?.delay_days ?? 0;
  const delay_hours = firstStep.rows[0]?.delay_hours ?? 0;

  const bulkResult = await pool.query(
    `INSERT INTO email_sequence_enrollments (campaign_id, lead_id, next_step_due_at)
     SELECT $1, id, NOW() + MAKE_INTERVAL(days => $2, hours => $3)
     FROM email_leads WHERE id = ANY($4)
     ON CONFLICT (campaign_id, lead_id) DO NOTHING
     RETURNING id`,
    [req.params.id, delay_days, delay_hours, lead_ids]
  );

  res.json({ enrolled: bulkResult.rowCount });
}));

/** GET /campaigns/:id/enrollments — list enrollments */
router.get('/campaigns/:id/enrollments', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    `SELECT e.*, el.name AS lead_name, el.email AS lead_email
     FROM email_sequence_enrollments e
     JOIN email_leads el ON el.id = e.lead_id
     WHERE e.campaign_id = $1 ORDER BY e.enrolled_at DESC`,
    [req.params.id]
  );
  res.json(result.rows);
}));

module.exports = router;
