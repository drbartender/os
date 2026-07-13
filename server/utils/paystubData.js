// server/utils/paystubData.js
//
// Assembles the render-ready paystub data object for a (contractor, period)
// pair: the payout head + contractor display name, this period's payout_events
// (mirroring the SELECT in staffPortal/payouts.js detail), and the YTD
// aggregates (net + category breakdown over [Jan 1 of payday's year, payday]).
//
// Money is integer cents throughout. The renderer (paystubPdf.js) formats only
// at render time. The endpoint (staffPortal/payouts.js) is responsible for
// IDOR scoping; this util takes whatever contractorId it is handed and does
// NOT enforce caller identity.

const { pool } = require('../db');

// pg returns DATE columns as JS Date objects; normalize to YYYY-MM-DD so the
// renderer never has to second-guess the format. Mirrors ymd() in
// server/routes/staffPortal/payouts.js.
function ymd(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

// Window predicate reused for both YTD aggregates: paid payouts for this
// contractor whose payday is in [Jan 1 of payday's year, this payday].
const YTD_WHERE = `
  po.contractor_id = $1
  AND po.status = 'paid'
  AND pp.payday >= date_trunc('year', $2::date)::date
  AND pp.payday <= $2::date`;

async function assemblePaystubData(contractorId, periodId) {
  // 1. Payout head + period + contractor display name. Legal name preferred for
  //    a pay document; then preferred_name, then email. (Same join sources as
  //    accountReads.js; precedence is deliberately legal-name-first here.)
  const head = await pool.query(
    `SELECT po.id AS payout_id, po.status, po.total_cents,
            po.paid_at, po.payment_method,
            pp.start_date, pp.end_date, pp.payday,
            COALESCE(ag.full_name, ap.full_name, cp.preferred_name, u.email) AS contractor_name
       FROM payouts po
       JOIN pay_periods pp ON pp.id = po.pay_period_id
       JOIN users u ON u.id = po.contractor_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
  LEFT JOIN agreements ag ON ag.user_id = u.id
  LEFT JOIN applications ap ON ap.user_id = u.id
      WHERE po.contractor_id = $1 AND po.pay_period_id = $2`,
    [contractorId, periodId]
  );
  if (!head.rows[0]) return null;
  const h = head.rows[0];

  // 2 + 3. This period's events (mirror the SELECT in staffPortal/payouts.js
  //   detail) and the two YTD aggregates (net + category breakdown). All three
  //   depend only on the head row, not on each other, so fan them out in one
  //   Promise.all instead of three serial Neon round-trips.
  const [ev, ytdNet, ytdCat] = await Promise.all([
    pool.query(
      `SELECT pe.shift_id, pe.hours, pe.wage_cents, pe.gratuity_share_cents,
              pe.card_tip_net_cents, pe.adjustment_cents, pe.adjustment_note,
              pe.line_total_cents, pe.held_state,
              pr.event_date, pr.event_type, pr.event_type_custom,
              c.name AS client_name
         FROM payout_events pe
         JOIN shifts s ON s.id = pe.shift_id
    LEFT JOIN proposals pr ON pr.id = s.proposal_id
    LEFT JOIN clients c ON c.id = pr.client_id
        WHERE pe.payout_id = $1
        ORDER BY pr.event_date ASC, pe.id ASC`,
      [h.payout_id]
    ),
    pool.query(
      `SELECT COALESCE(SUM(po.total_cents), 0) AS net
         FROM payouts po JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE ${YTD_WHERE}`,
      [contractorId, h.payday]
    ),
    pool.query(
      // Held reimbursements (payout_events.held_state = 'held') are tracked but
      // NON-payable: line_total_cents = 0, so payout totals (net) exclude them
      // by construction. The adjustments aggregate must exclude them too or the
      // stub stops footing (Adjustments vs NET PAID would disagree by exactly
      // the held amount). Confirmed lines pay out normally and stay included.
      `SELECT COALESCE(SUM(pe.wage_cents),0) AS wages,
              COALESCE(SUM(pe.gratuity_share_cents),0) AS gratuity,
              COALESCE(SUM(pe.card_tip_net_cents),0) AS card_tips,
              COALESCE(SUM(pe.adjustment_cents)
                FILTER (WHERE pe.held_state IS DISTINCT FROM 'held'),0) AS adjustments
         FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE ${YTD_WHERE}`,
      [contractorId, h.payday]
    ),
  ]);
  const sum = (k) => ev.rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const thisPeriod = {
    wages_cents: sum('wage_cents'),
    gratuity_cents: sum('gratuity_share_cents'),
    card_tips_net_cents: sum('card_tip_net_cents'),
    // Same held-exclusion as the YTD aggregate above (see the SQL comment).
    adjustments_cents: ev.rows.reduce(
      (a, r) => a + (r.held_state === 'held' ? 0 : Number(r.adjustment_cents || 0)), 0
    ),
    net_cents: Number(h.total_cents), // canonical payout total, not a re-sum
  };

  return {
    status: h.status,
    storageKey: `paystubs/${contractorId}/${periodId}.pdf`,
    contractorName: h.contractor_name,
    period: { start_date: ymd(h.start_date), end_date: ymd(h.end_date), payday: ymd(h.payday) },
    // payment_handle is intentionally omitted — it is PII (can hold bank hints
    // for direct_deposit) and the list/detail endpoints omit it too. Showing the
    // method on the paystub is enough; the staffer knows their own handle.
    paid: { at: ymd(h.paid_at), method: h.payment_method },
    events: ev.rows.map((r) => ({
      event_date: ymd(r.event_date),
      client_name: r.client_name || null,
      event_type: r.event_type || null,
      event_type_custom: r.event_type_custom || null,
      hours: r.hours,
      wage_cents: r.wage_cents,
      gratuity_share_cents: r.gratuity_share_cents,
      card_tip_net_cents: r.card_tip_net_cents,
      adjustment_cents: r.adjustment_cents,
      adjustment_note: r.adjustment_note,
      line_total_cents: r.line_total_cents,
    })),
    thisPeriod,
    ytd: {
      wages_cents: Number(ytdCat.rows[0].wages),
      gratuity_cents: Number(ytdCat.rows[0].gratuity),
      card_tips_net_cents: Number(ytdCat.rows[0].card_tips),
      adjustments_cents: Number(ytdCat.rows[0].adjustments),
      net_cents: Number(ytdNet.rows[0].net),
    },
  };
}

module.exports = { assemblePaystubData };
