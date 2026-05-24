/**
 * Admin-only payroll portal routes mounted at /api/admin/payroll/*.
 *
 * Auth: every route below is gated by `auth` + `adminOnly` (Section 13:
 * Payroll is admin-only in this version; managers do not have access).
 * Money-touching endpoints wrap multi-statement work in a transaction.
 */
const express = require('express');
const { pool } = require('../../db');
const { auth, adminOnly } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError } = require('../../utils/errors');
const { findOpenPeriodForDate } = require('../../utils/payrollProcessing');

const router = express.Router();

// Cheap liveness probe. Real endpoints follow in subsequent tasks.
router.get('/payroll/healthcheck', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ ok: true, ts: Date.now() });
}));

// Reusable: hydrate a period with its payouts and each payout's events.
async function loadPeriodWithPayouts(periodRow) {
  const payoutsRes = await pool.query(
    `SELECT po.id, po.contractor_id, po.status, po.total_cents,
            po.payment_method, po.payment_handle, po.paid_at, po.paystub_storage_key,
            COALESCE(cp.preferred_name, u.email) AS contractor_name,
            pp.preferred_payment_method, pp.venmo_handle, pp.cashapp_handle, pp.paypal_url
       FROM payouts po
       JOIN users u ON u.id = po.contractor_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = po.contractor_id
  LEFT JOIN payment_profiles pp ON pp.user_id = po.contractor_id
      WHERE po.pay_period_id = $1
      ORDER BY COALESCE(cp.preferred_name, u.email) ASC`,
    [periodRow.id]
  );
  const payoutIds = payoutsRes.rows.map(p => p.id);
  const eventsByPayout = {};
  if (payoutIds.length > 0) {
    const eventsRes = await pool.query(
      `SELECT pe.id, pe.payout_id, pe.shift_id,
              pe.contracted_hours, pe.hours, pe.rate_cents, pe.wage_cents, pe.late,
              pe.gratuity_share_cents,
              pe.card_tip_gross_cents, pe.card_tip_fee_cents, pe.card_tip_net_cents,
              pe.adjustment_cents, pe.adjustment_note, pe.line_total_cents,
              p.event_date, p.event_type, p.event_type_custom
         FROM payout_events pe
         JOIN shifts s ON s.id = pe.shift_id
    LEFT JOIN proposals p ON p.id = s.proposal_id
        WHERE pe.payout_id = ANY($1::int[])
        ORDER BY p.event_date ASC, pe.id ASC`,
      [payoutIds]
    );
    for (const ev of eventsRes.rows) {
      (eventsByPayout[ev.payout_id] ||= []).push(ev);
    }
  }
  const payouts = payoutsRes.rows.map(p => ({ ...p, events: eventsByPayout[p.id] || [] }));
  return { period: periodRow, payouts };
}

router.get('/payroll/periods', auth, adminOnly, asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pp.id, pp.start_date, pp.end_date, pp.payday, pp.status,
            COALESCE(SUM(po.total_cents), 0) AS total_cents,
            COUNT(po.id) FILTER (WHERE po.status = 'paid') AS paid_count,
            COUNT(po.id) FILTER (WHERE po.status = 'pending') AS pending_count
       FROM pay_periods pp
  LEFT JOIN payouts po ON po.pay_period_id = pp.id
   GROUP BY pp.id
   ORDER BY pp.start_date DESC`
  );
  res.json({ periods: rows });
}));

router.get('/payroll/periods/current', auth, adminOnly, asyncHandler(async (req, res) => {
  // Today in the server's local tz, then fall back to the most recent open
  // period if today is not inside any open one (e.g., between the freeze of
  // one period and the accrual of the first event in the next).
  const todayYmd = new Date().toISOString().slice(0, 10);
  let period = await findOpenPeriodForDate(pool, todayYmd);
  if (!period) {
    const { rows } = await pool.query(
      `SELECT id, start_date, end_date, payday, status
         FROM pay_periods WHERE status = 'open'
        ORDER BY start_date DESC LIMIT 1`
    );
    period = rows[0] || null;
  }
  if (!period) return res.json({ period: null, payouts: [] });
  res.json(await loadPeriodWithPayouts(period));
}));

router.get('/payroll/periods/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new NotFoundError('Period not found');
  const { rows } = await pool.query(
    `SELECT id, start_date, end_date, payday, status FROM pay_periods WHERE id = $1`,
    [id]
  );
  if (!rows[0]) throw new NotFoundError('Period not found');
  res.json(await loadPeriodWithPayouts(rows[0]));
}));

module.exports = router;
