/**
 * GET /api/admin/staff-hub/summary: the ONE read behind the Staff hub's chrome
 * (tab counts, badges, live subtitle). Mounted from ./index.js; routes declare
 * FULL paths under /api/admin.
 *
 * Read-only by construction: the open pay run is derived from the Chicago date
 * and LEFT JOINed to pay_periods on its UNIQUE start_date; this route must
 * never adopt the INSERT-fallback pattern payrollLateTip.js / payrollClawback.js
 * wrap around findOpenPeriodForDate.
 */
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { chicagoTodayYmd } = require('../../utils/businessTime');
const { payPeriodForDate } = require('../../utils/payrollPeriods');
const { summarizeOpenPeriod } = require('../../utils/staffHubSummary');

const router = express.Router();

router.get('/staff-hub/summary', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  // Same gate as GET /admin/active-staff: a manager without can_staff cannot
  // read the roster, so the hub must not hand them a headcount for it either.
  const canSeeRoster = isAdmin || (req.user.role === 'manager' && !!req.user.can_staff);

  let counts = {
    active_count: null,
    deactivated_count: null,
    former_staff_count: null,
    imported_count: null,
  };
  if (canSeeRoster) {
    // One predicate family, shared with the roster feed: the active set is the
    // roster's Active tab (approved + onboarding completed); the deactivated
    // set is status alone (imported placeholders have no progress row).
    // onboarding_progress.user_id is UNIQUE, so the LEFT JOIN is 1:1 and
    // cannot multiply a row into a count.
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE u.onboarding_status = 'approved' AND op.onboarding_completed = true)::int AS active_count,
        COUNT(*) FILTER (WHERE u.onboarding_status = 'deactivated')::int AS deactivated_count,
        COUNT(*) FILTER (WHERE u.onboarding_status = 'deactivated'
                           AND (u.cc_id LIKE 'legacy_cc:%' OR u.import_source = 'payment_history_import'))::int AS imported_count
      FROM users u
      LEFT JOIN onboarding_progress op ON op.user_id = u.id
      WHERE u.role IN ('staff', 'manager')
    `);
    const r = rows[0];
    counts = {
      active_count: r.active_count,
      deactivated_count: r.deactivated_count,
      imported_count: r.imported_count,
      former_staff_count: r.deactivated_count - r.imported_count,
    };
  }

  let adminFields = { new_applications: null, pending_reviews: null, open_period: null };
  if (isAdmin) {
    // chicagoTodayYmd, never new Date(): the late-evening UTC drift would name
    // tomorrow's pay run from 19:00 Chicago onward.
    const todayYmd = chicagoTodayYmd();
    const { startDate } = payPeriodForDate(todayYmd);
    const [decisions, period] = await Promise.all([
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM applications a JOIN users u ON u.id = a.user_id
            WHERE u.onboarding_status = 'applied')::int AS new_applications,
          (SELECT COUNT(*) FROM staff_reviews WHERE status = 'pending')::int AS pending_reviews
      `),
      pool.query(`
        SELECT pp.status, COUNT(p.id)::int AS payouts_accrued
          FROM pay_periods pp
          LEFT JOIN payouts p ON p.pay_period_id = pp.id
         WHERE pp.start_date = $1
         GROUP BY pp.id, pp.status
      `, [startDate]),
    ]);
    adminFields = {
      new_applications: decisions.rows[0].new_applications,
      pending_reviews: decisions.rows[0].pending_reviews,
      open_period: summarizeOpenPeriod({ todayYmd, row: period.rows[0] || null }),
    };
  }

  res.json({ ...counts, ...adminFields });
}));

module.exports = router;
