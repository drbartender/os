// Staffer payout READ endpoints for the staff portal Pay tab (spec §6.6).
//
// Mounted at /api/me by the parent router. `auth` is already applied upstream
// (server/routes/staffPortal.js calls router.use(auth) before register).
//
// Both endpoints are hard-scoped to req.user.id — there is NO `:userId` path
// param, ever. This file is the staffer-facing counterpart to the admin-only
// /api/admin/payroll/contractors/:userId/payouts and /api/admin/payroll/periods/:id
// queries. Money + PII surface, so:
//
//   - SELECTs are parameterized and pinned to po.contractor_id = $1 = req.user.id
//   - We DO NOT project payment_method / payment_handle (those snapshot bank/
//     handle data and the Pay tab doesn't need them — see spec §6.6)
//   - A 404 on the detail endpoint for a payout that belongs to ANOTHER user
//     IS the IDOR guard: a staffer asking "give me /periods/:periodId" gets
//     NotFound iff no payouts row exists for (this user, this period)
//
// Money is integer cents only. summary sums are computed in SQL with COALESCE
// so an empty payout returns zeros, never NULL.

const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ValidationError } = require('../../utils/errors');

// pg returns DATE columns as JS Date objects; String(Date) yields a long
// "Fri May 29 2026 …" string. Normalize to YYYY-MM-DD so the client gets
// clean dates and never has to second-guess the format. Mirrors ymd() in
// server/routes/admin/payroll.js (load-bearing helper).
function ymd(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function register(router) {
  // ─── GET /api/me/payouts ─────────────────────────────────────────────────
  // List the logged-in staffer's payouts, newest pay period first.
  //
  // Mirrors the admin per-contractor list (admin/payroll.js:413) but:
  //   - WHERE po.contractor_id = $1 is hardcoded to req.user.id (no userId param)
  //   - payment_method + payment_handle ARE NOT projected (spec §6.6 PII)
  router.get('/payouts', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT po.id, po.status, po.total_cents, po.paid_at, po.paystub_storage_key,
              pp.id   AS period_id,
              pp.start_date, pp.end_date, pp.payday,
              pp.status AS period_status,
              (SELECT COUNT(*) FROM payout_events WHERE payout_id = po.id) AS event_count
         FROM payouts po
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE po.contractor_id = $1
        ORDER BY pp.start_date DESC`,
      [req.user.id]
    );
    res.json({
      payouts: rows.map((r) => ({
        id: r.id,
        status: r.status,
        total_cents: r.total_cents,
        paid_at: r.paid_at,
        paystub_storage_key: r.paystub_storage_key,
        event_count: Number(r.event_count),
        period: {
          id: r.period_id,
          start_date: ymd(r.start_date),
          end_date: ymd(r.end_date),
          payday: ymd(r.payday),
          status: r.period_status,
        },
      })),
    });
  }));

  // ─── GET /api/me/payouts/:periodId ───────────────────────────────────────
  // One pay period's detail for THIS staffer. The IDOR guard is the JOIN
  // condition po.contractor_id = $1 AND po.pay_period_id = $2: if there is
  // no payouts row for (this user, this period) we throw NotFound. A staffer
  // asking for a periodId that exists but belongs to someone else (or for a
  // periodId they were never paid in) gets exactly the same 404 — no info
  // leak about which periods exist.
  router.get('/payouts/:periodId', asyncHandler(async (req, res) => {
    const periodId = Number(req.params.periodId);
    if (!Number.isInteger(periodId) || periodId <= 0) {
      throw new ValidationError({ periodId: 'must be a positive integer' }, 'Invalid period id');
    }

    // One query that JOINs period + this user's payout. NotFound if either no
    // such period OR no payout for this user in that period. The combined
    // check is the whole point — we never reveal "the period exists but isn't
    // yours" vs "no such period".
    const payoutRes = await pool.query(
      `SELECT po.id            AS payout_id,
              po.status        AS payout_status,
              po.total_cents,
              po.paid_at,
              po.paystub_storage_key,
              pp.id            AS period_id,
              pp.start_date,
              pp.end_date,
              pp.payday,
              pp.status        AS period_status
         FROM payouts po
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE po.contractor_id = $1
          AND po.pay_period_id = $2`,
      [req.user.id, periodId]
    );
    if (!payoutRes.rows[0]) throw new NotFoundError('Payout not found');
    const p = payoutRes.rows[0];

    // Pull the payout_events for this payout + project the linked
    // shift/proposal/client labels. Mirrors the staff-home / admin-payroll
    // JOIN: shifts -> proposals -> clients. LEFT JOINs because a shift can
    // outlive its proposal/client in dev data, and we'd rather show the line
    // than 500 the page.
    const eventsRes = await pool.query(
      `SELECT pe.shift_id,
              pe.contracted_hours, pe.hours, pe.rate_cents, pe.wage_cents, pe.late,
              pe.gratuity_share_cents,
              pe.card_tip_gross_cents, pe.card_tip_fee_cents, pe.card_tip_net_cents,
              pe.adjustment_cents, pe.adjustment_note, pe.line_total_cents,
              pr.event_date, pr.event_type, pr.event_type_custom,
              c.name AS client_name
         FROM payout_events pe
         JOIN shifts s ON s.id = pe.shift_id
    LEFT JOIN proposals pr ON pr.id = s.proposal_id
    LEFT JOIN clients c   ON c.id = pr.client_id
        WHERE pe.payout_id = $1
        ORDER BY pr.event_date ASC, pe.id ASC`,
      [p.payout_id]
    );

    // Sum in JS off the same rows we're already returning. Money is integer
    // cents — Number() each column before summing (pg returns INTEGERs as JS
    // numbers, but we coerce defensively in case a NUMERIC sneaks in).
    let wages = 0;
    let gratuity = 0;
    let cardGross = 0;
    let cardFee = 0;
    let adjustments = 0;
    const events = eventsRes.rows.map((r) => {
      wages       += Number(r.wage_cents);
      gratuity    += Number(r.gratuity_share_cents);
      cardGross   += Number(r.card_tip_gross_cents);
      cardFee     += Number(r.card_tip_fee_cents);
      adjustments += Number(r.adjustment_cents);
      return {
        shift_id: r.shift_id,
        event_date: ymd(r.event_date),
        client_name: r.client_name || null,
        event_type: r.event_type || null,
        event_type_custom: r.event_type_custom || null,
        contracted_hours: r.contracted_hours,
        hours: r.hours,
        rate_cents: r.rate_cents,
        wage_cents: r.wage_cents,
        late: r.late,
        gratuity_share_cents: r.gratuity_share_cents,
        card_tip_gross_cents: r.card_tip_gross_cents,
        card_tip_fee_cents: r.card_tip_fee_cents,
        card_tip_net_cents: r.card_tip_net_cents,
        adjustment_cents: r.adjustment_cents,
        adjustment_note: r.adjustment_note,
        line_total_cents: r.line_total_cents,
      };
    });

    res.json({
      period: {
        id: p.period_id,
        start_date: ymd(p.start_date),
        end_date: ymd(p.end_date),
        payday: ymd(p.payday),
        status: p.period_status,
      },
      payout: {
        id: p.payout_id,
        status: p.payout_status,
        total_cents: p.total_cents,
        paid_at: p.paid_at,
        paystub_storage_key: p.paystub_storage_key,
      },
      events,
      // total_cents comes from the payout row (canonical) — NOT a JS sum of
      // events. The two can drift mid-period before recompute, and the
      // payout-row total is the one we hand to the bank/check-cutter.
      summary: {
        wages_cents: wages,
        gratuity_cents: gratuity,
        card_tips_gross_cents: cardGross,
        card_processing_fee_cents: cardFee,
        adjustments_cents: adjustments,
        total_cents: p.total_cents,
      },
    });
  }));
}

module.exports = { register };
