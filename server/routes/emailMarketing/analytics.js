/**
 * Aggregate email-marketing analytics.
 *
 * Extracted from the single 987-line emailMarketing.js. Paths and mount
 * order are unchanged; see ./index.js for why the order still matters.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');

const router = express.Router();
// ─── Analytics ────────────────────────────────────────────────────

/** GET /analytics/overview — aggregate stats */
router.get('/analytics/overview', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const [leadsResult, campaignsResult, sendsResult] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'active') AS active FROM email_leads`),
    pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'sent' OR status = 'active') AS active FROM email_campaigns`),
    pool.query(`
      SELECT
        COUNT(*) AS total_sends,
        COUNT(*) FILTER (WHERE status IN ('delivered','opened','clicked')) AS total_delivered,
        COUNT(*) FILTER (WHERE status IN ('opened','clicked')) AS total_opens,
        COUNT(*) FILTER (WHERE status = 'clicked') AS total_clicks,
        COUNT(*) FILTER (WHERE status = 'bounced') AS total_bounces,
        COUNT(*) FILTER (WHERE status = 'complained') AS total_complaints
      FROM email_sends
    `),
  ]);

  const sends = sendsResult.rows[0];
  const totalSends = parseInt(sends.total_sends, 10) || 0;

  res.json({
    leads: leadsResult.rows[0],
    campaigns: campaignsResult.rows[0],
    sends: {
      ...sends,
      open_rate: totalSends > 0 ? (parseInt(sends.total_opens, 10) / totalSends * 100).toFixed(1) : '0.0',
      click_rate: totalSends > 0 ? (parseInt(sends.total_clicks, 10) / totalSends * 100).toFixed(1) : '0.0',
      bounce_rate: totalSends > 0 ? (parseInt(sends.total_bounces, 10) / totalSends * 100).toFixed(1) : '0.0',
    },
  });
}));

module.exports = router;
