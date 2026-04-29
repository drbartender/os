// Hiring-page-specific endpoints. Lives alongside admin/applications.js but
// scopes the dashboard's KPI strip + cross-state search separately so the
// queries can evolve without touching the main applications list endpoint.

const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();

// KPI strip — three action-trigger stats shown at the top of /admin/hiring.
//   new_apps_7d      — fresh applications in the last week (funnel signal)
//   need_to_schedule — applicants in Interview stage with no time picked yet
//   stalled          — applicants who've sat too long in their current stage:
//                        applied >14d OR interview unscheduled >3d
//                        OR onboarding without progress >14d
router.get('/hiring/summary', auth, adminOnly, asyncHandler(async (_req, res) => {
  const [newApps, needSchedule, stalled, inPipeline] = await Promise.all([
    pool.query(`
      SELECT COUNT(*) FROM applications a
      INNER JOIN users u ON u.id = a.user_id
      WHERE u.role IN ('staff', 'manager')
        AND a.created_at > NOW() - INTERVAL '7 days'
        AND u.onboarding_status != 'rejected'
    `),
    pool.query(`
      SELECT COUNT(*) FROM applications a
      INNER JOIN users u ON u.id = a.user_id
      WHERE u.role IN ('staff', 'manager')
        AND u.onboarding_status = 'interviewing'
        AND a.interview_at IS NULL
    `),
    pool.query(`
      SELECT COUNT(*) FROM users u
      INNER JOIN applications a ON a.user_id = u.id
      WHERE u.role IN ('staff', 'manager') AND (
        (u.onboarding_status = 'applied'
          AND a.created_at < NOW() - INTERVAL '14 days')
        OR (u.onboarding_status = 'interviewing'
          AND a.interview_at IS NULL
          AND a.updated_at < NOW() - INTERVAL '3 days')
        OR (u.onboarding_status = 'in_progress'
          AND u.updated_at < NOW() - INTERVAL '14 days')
      )
    `),
    pool.query(`
      SELECT COUNT(*) FROM users u
      INNER JOIN applications a ON a.user_id = u.id
      WHERE u.role IN ('staff', 'manager')
        AND u.onboarding_status IN ('applied', 'interviewing', 'in_progress', 'hired')
    `),
  ]);

  res.json({
    new_apps_7d:      parseInt(newApps.rows[0].count, 10),
    need_to_schedule: parseInt(needSchedule.rows[0].count, 10),
    stalled:          parseInt(stalled.rows[0].count, 10),
    in_pipeline:      parseInt(inPipeline.rows[0].count, 10),
  });
}));

// Cross-state applicant search. Hits Applied / Interview / Onboarding / Active
// / Rejected (via the applications join) AND Unfinished signups (users without
// an applications row). Returns up to 20 matches.
router.get('/hiring/search', auth, adminOnly, asyncHandler(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ results: [] });
  const term = '%' + q.toLowerCase() + '%';

  const result = await pool.query(`
    SELECT
      u.id,
      u.email,
      u.onboarding_status,
      u.created_at AS user_created_at,
      a.full_name,
      a.created_at AS applied_at,
      CASE WHEN a.id IS NULL THEN 'unfinished' ELSE u.onboarding_status END AS state
    FROM users u
    LEFT JOIN applications a ON a.user_id = u.id
    WHERE u.role IN ('staff', 'manager')
      AND (
        LOWER(u.email)        LIKE $1 OR
        LOWER(a.full_name)    LIKE $1
      )
    ORDER BY (a.created_at IS NOT NULL) DESC, COALESCE(a.created_at, u.created_at) DESC
    LIMIT 20
  `, [term]);

  res.json({ results: result.rows });
}));

module.exports = router;
