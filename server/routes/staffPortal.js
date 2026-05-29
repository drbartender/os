// Staff portal API — composite + account-management endpoints (spec
// docs/superpowers/specs/2026-05-27-staff-portal-redesign-design.md).
//
// Mounted at /api/me, AFTER server/routes/me.js so existing paths win on any
// path collision. Verified no overlap at write time: me.js owns /tip-page,
// /tips, /notification-preferences; this router owns /staff-home,
// /payment-methods, /preferred-payment-method, /tip-card-order, /profile,
// /ui-preferences, /staff-notifications, /push-subscriptions, /documents/...,
// /request-email-change, /cancel-pending-email-change.

const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(auth);

// ─── Task 12: GET /staff-home (composite home payload) ─────────────────────
//
// One round-trip for the redesigned HomePage. Four parallel queries via
// Promise.all (none depend on each other's results):
//   1. Next upcoming approved shift, with BEO finalize + ack projection.
//   2. Pending shift_requests for this user.
//   3. Cover broadcasts visible to this user (any shift_request with
//      cover_requested_at NOT NULL, requester != this user). Each broadcast
//      carries `you_are_on_team` derived from same-proposal approved requests.
//   4. Current pay-period summary (projected payout total + event count +
//      payday + status). Mirrors the payoutAccrual / payouts pattern.
//
// Open-shifts teaser is intentionally a hardcoded empty array for now —
// spec §6.2 lists it as a section but the wire-up to /api/shifts open list
// lands in a later task; this route projects an empty list so the client can
// render the section with an "All →" link with no crash.
router.get('/staff-home', asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const [nextShift, pendingRequests, coverBroadcasts, currentPeriod] = await Promise.all([
    pool.query(`
      SELECT s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             s.positions_needed,
             sr.id AS request_id, sr.status AS request_status, sr.position,
             sr.beo_acknowledged_at,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             p.event_timezone, p.event_duration_hours,
             c.name AS client_name,
             dp.finalized_at AS drink_plan_finalized_at,
             dp.id AS drink_plan_id
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        LEFT JOIN drink_plans dp ON dp.proposal_id = p.id
       WHERE sr.user_id = $1
         AND sr.status = 'approved'
         AND sr.dropped_at IS NULL
         AND s.event_date >= CURRENT_DATE
       ORDER BY s.event_date ASC, s.start_time ASC
       LIMIT 1
    `, [userId]),

    pool.query(`
      SELECT sr.id AS request_id, sr.created_at, sr.position,
             s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             c.name AS client_name
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
       WHERE sr.user_id = $1
         AND sr.status = 'pending'
         AND s.event_date >= CURRENT_DATE
       ORDER BY s.event_date ASC
    `, [userId]),

    pool.query(`
      SELECT sr.id AS request_id, sr.cover_requested_at, sr.cover_reason,
             sr.user_id AS requester_id,
             s.id AS shift_id, s.event_date, s.start_time, s.end_time, s.location,
             p.id AS proposal_id, p.event_type, p.event_type_custom,
             c.name AS client_name,
             u.email AS requester_email,
             cp.preferred_name AS requester_preferred_name,
             EXISTS (
               SELECT 1 FROM shift_requests sr2
                WHERE sr2.shift_id = sr.shift_id
                  AND sr2.user_id = $1
                  AND sr2.status = 'approved'
                  AND sr2.dropped_at IS NULL
             ) AS you_are_on_team
        FROM shift_requests sr
        JOIN shifts s ON s.id = sr.shift_id
        LEFT JOIN proposals p ON p.id = s.proposal_id
        LEFT JOIN clients c ON c.id = p.client_id
        LEFT JOIN users u ON u.id = sr.user_id
        LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
       WHERE sr.cover_requested_at IS NOT NULL
         AND sr.user_id <> $1
         AND sr.status = 'approved'
         AND sr.dropped_at IS NULL
         AND s.event_date >= CURRENT_DATE
       ORDER BY s.event_date ASC
       LIMIT 20
    `, [userId]),

    pool.query(`
      SELECT pp.id AS pay_period_id, pp.start_date, pp.end_date,
             pp.payday, pp.status,
             po.id AS payout_id, COALESCE(po.total_cents, 0) AS total_cents,
             COALESCE((
               SELECT COUNT(*)::int FROM payout_events pe WHERE pe.payout_id = po.id
             ), 0) AS event_count
        FROM pay_periods pp
        LEFT JOIN payouts po ON po.pay_period_id = pp.id AND po.contractor_id = $1
       WHERE CURRENT_DATE BETWEEN pp.start_date AND pp.end_date
       ORDER BY pp.start_date DESC
       LIMIT 1
    `, [userId]),
  ]);

  res.json({
    next_shift: nextShift.rows[0] || null,
    pending_requests: pendingRequests.rows,
    cover_broadcasts: coverBroadcasts.rows,
    current_period: currentPeriod.rows[0] || null,
    open_shifts_teaser: [],
  });
}));

module.exports = router;
