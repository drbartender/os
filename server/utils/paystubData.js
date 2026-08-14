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
const { chicagoYmdOf } = require('./businessTime');

// pg returns DATE columns as JS Date objects; normalize to YYYY-MM-DD so the
// renderer never has to second-guess the format. Mirrors ymd() in
// server/routes/staffPortal/payouts.js.
//
// DATE COLUMNS ONLY. A SQL DATE carries no zone, so pg builds it at LOCAL
// midnight and toISOString() recovers the same calendar day on any machine at
// or west of UTC (Render is UTC, the dev box is Chicago). A TIMESTAMPTZ is a
// true instant and must NOT come through here — toISOString() would render its
// GMT day, one day late for any Chicago evening. Use chicagoYmdOf() for those
// (see the paid_at call site below, and proposals/cancel.js:511).
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
  const [ev, ytdNet, ytdCat, duty, ytdDuty] = await Promise.all([
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
      // Held lines (payout_events.held_state = 'held') are sign-scoped (B13). A
      // held POSITIVE reimbursement is tracked but NON-payable (line_total = 0),
      // so it is excluded from the adjustments aggregate or the stub stops
      // footing (Adjustments vs NET PAID would disagree by the held amount). A
      // held NEGATIVE line (docked/clawed off-roster worker) keeps its debt in
      // line_total (LEAST(adj,0)) and thus IS inside the payout total, so it must
      // be COUNTED here or the stub un-foots by the debt. Exclude only held rows
      // with a positive adjustment; confirmed lines pay out normally and stay in.
      `SELECT COALESCE(SUM(pe.wage_cents),0) AS wages,
              COALESCE(SUM(pe.gratuity_share_cents),0) AS gratuity,
              COALESCE(SUM(pe.card_tip_net_cents),0) AS card_tips,
              COALESCE(SUM(pe.adjustment_cents)
                FILTER (WHERE pe.held_state IS DISTINCT FROM 'held'
                        OR pe.adjustment_cents < 0),0) AS adjustments
         FROM payout_events pe
         JOIN payouts po ON po.id = pe.payout_id
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE ${YTD_WHERE}`,
      [contractorId, h.payday]
    ),
    // This period's duty lines, itemized (spec 2026-08-06 §3.7). Only PAYABLE
    // lines (not removed, not held-unconfirmed) — same scope as the payout
    // total, so the stub keeps footing.
    pool.query(
      `SELECT d.kind, d.amount_cents, d.shift_id, d.note
         FROM payout_duty_lines d
        WHERE d.payout_id = $1 AND d.removed_at IS NULL
          AND (d.held_state IS NULL OR d.held_state = 'confirmed')
        ORDER BY d.id ASC`,
      [h.payout_id]
    ),
    // YTD duty category, payable lines over the same paid-payout window.
    pool.query(
      `SELECT COALESCE(SUM(d.amount_cents), 0) AS duty
         FROM payout_duty_lines d
         JOIN payouts po ON po.id = d.payout_id
         JOIN pay_periods pp ON pp.id = po.pay_period_id
        WHERE ${YTD_WHERE}
          AND d.removed_at IS NULL
          AND (d.held_state IS NULL OR d.held_state = 'confirmed')`,
      [contractorId, h.payday]
    ),
  ]);
  const { DUTY_KIND_LABELS } = require('./dutyLines');
  const sum = (k) => ev.rows.reduce((a, r) => a + Number(r[k] || 0), 0);
  const thisPeriod = {
    wages_cents: sum('wage_cents'),
    gratuity_cents: sum('gratuity_share_cents'),
    card_tips_net_cents: sum('card_tip_net_cents'),
    // Same sign-scoped held-exclusion as the YTD aggregate above (B13): exclude
    // only a held POSITIVE reimbursement (line_total 0); a held NEGATIVE line's
    // debt is inside the payout total, so it must be counted.
    adjustments_cents: ev.rows.reduce(
      (a, r) => a + ((r.held_state === 'held' && Number(r.adjustment_cents || 0) > 0)
        ? 0 : Number(r.adjustment_cents || 0)), 0
    ),
    duty_cents: duty.rows.reduce((a, r) => a + Number(r.amount_cents || 0), 0),
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
    // paid_at is a TIMESTAMPTZ (schema.sql:3112) written by NOW() at mark-paid,
    // i.e. a true instant — NOT a bare DATE like start_date/end_date/payday
    // above. ymd()'s toISOString() reads the GMT day, so a payout marked paid
    // at 8:30pm Chicago printed the NEXT day on the stub. Same trap, same fix
    // as proposals/cancel.js:511.
    paid: { at: h.paid_at ? chicagoYmdOf(h.paid_at) : null, method: h.payment_method },
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
    duty_lines: duty.rows.map((r) => ({
      kind: r.kind,
      label: DUTY_KIND_LABELS[r.kind] || r.kind,
      amount_cents: Number(r.amount_cents),
      shift_id: r.shift_id,
      note: r.note || null,
    })),
    thisPeriod,
    ytd: {
      wages_cents: Number(ytdCat.rows[0].wages),
      gratuity_cents: Number(ytdCat.rows[0].gratuity),
      card_tips_net_cents: Number(ytdCat.rows[0].card_tips),
      adjustments_cents: Number(ytdCat.rows[0].adjustments),
      duty_cents: Number(ytdDuty.rows[0].duty),
      net_cents: Number(ytdNet.rows[0].net),
    },
  };
}

module.exports = { assemblePaystubData };
