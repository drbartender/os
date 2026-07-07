const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { calculateProposal, deriveGratuityRate, computeGratuityBasis } = require('../../utils/pricingEngine');
const { stripIncludedAddons } = require('../../utils/proposalRules');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError } = require('../../utils/errors');
const metrics = require('../../utils/metricsQueries');

const router = express.Router();

// Coerce a client-supplied addon quantity into a bounded positive integer.
// Mirrors public.js / crud.js safeAddonQty — keeps the /calculate preview's
// money math identical to the persist path.
const MAX_ADDON_QTY = 20;
function safeAddonQty(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_ADDON_QTY, n);
}

// ─── Package & add-on listing (auth required) ────────────────────

/** GET /api/proposals/packages — list active packages */
router.get('/packages', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM service_packages WHERE is_active = true ORDER BY sort_order'
  );
  res.json(result.rows);
}));

/** GET /api/proposals/addons — list active add-ons */
router.get('/addons', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM service_addons WHERE is_active = true ORDER BY sort_order'
  );
  res.json(result.rows);
}));

/** POST /api/proposals/calculate — preview pricing without saving.
 *  Mirrors the POST / persist path: add-ons run through stripIncludedAddons
 *  (bundle-covered add-ons dropped) and carry a bounded quantity, so the
 *  preview total matches what the proposal would actually be saved at. */
router.post('/calculate', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { package_id, guest_count, duration_hours, num_bars, num_bartenders, addon_ids, addon_variants, addon_quantities, syrup_selections, adjustments, total_price_override, tip_jar, gratuity_total, gratuity_rate } = req.body;
  if (!package_id) {
    throw new ValidationError({ package_id: 'Package is required' });
  }

  const pkgResult = await pool.query('SELECT * FROM service_packages WHERE id = $1', [package_id]);
  if (!pkgResult.rows[0]) {
    throw new ValidationError({ package_id: 'Package not found' });
  }

  // Fetch the FULL active add-on set so stripIncludedAddons can detect bundles
  // and resolve covered slugs — then build priced rows from the STRIPPED ids.
  let addons = [];
  if (addon_ids && addon_ids.length > 0) {
    const addonResult = await pool.query(
      'SELECT * FROM service_addons WHERE is_active = true'
    );
    const allActiveAddons = addonResult.rows;
    const strippedIds = stripIncludedAddons(addon_ids, allActiveAddons);
    addons = allActiveAddons
      .filter(a => strippedIds.includes(a.id))
      .map(a => ({
        ...a,
        variant: addon_variants?.[String(a.id)] || null,
        quantity: safeAddonQty(addon_quantities?.[String(a.id)]),
      }));
  }

  // Gratuity preview: derive a rate from an entered total so the admin preview
  // reflects the gratuity line (same derivation the persist path uses, §7).
  let previewRate = 0;
  const previewTipJar = tip_jar !== false;
  if (gratuity_total !== undefined) {
    const { staffCount, hours } = computeGratuityBasis({
      pkg: pkgResult.rows[0], guestCount: guest_count || 50,
      durationHours: duration_hours || 4, numBartenders: num_bartenders, addons,
    });
    const g = deriveGratuityRate({ enteredTotal: gratuity_total, staffCount, hours, tipJar: previewTipJar });
    if (!g.ok) throw new ValidationError({ gratuity: g.message });
    previewRate = g.rate;
  } else if (gratuity_rate !== undefined) {
    // Not an explicit gratuity edit — preview at the stored rate so the gratuity
    // line scales with staff/hours (mirrors the persist path when gratuity_total
    // is omitted). No re-derivation, so an unrelated edit can't shift the rate.
    previewRate = Number(gratuity_rate) || 0;
  }

  const snapshot = calculateProposal({
    pkg: pkgResult.rows[0],
    guestCount: guest_count || 50,
    durationHours: duration_hours || 4,
    numBars: num_bars ?? 1,
    numBartenders: num_bartenders,
    addons,
    syrupSelections: syrup_selections || [],
    adjustments: adjustments || [],
    totalPriceOverride: total_price_override ?? null,
    gratuityRate: previewRate, tipJar: previewTipJar,
  });

  res.json(snapshot);
}));

// ─── Financials ─────────────────────────────────────────────────

/** GET /api/proposals/financials — aggregate financial data */
router.get('/financials', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const f = metrics.resolveFilters(req.query); // throws ValidationError on bad input
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const money = metrics.qMoney(f);
  const out = metrics.qOutstanding(f);
  const acc = metrics.qAccepted(f);

  // Proposals + payments lists filter by event_date / payment date (NOT the
  // lens) — a list is rows of events; event_date is the intuitive axis.
  const listParams = [];
  const propDate = metrics.dateClause('p.event_date', f.from, f.to, listParams);
  const propCc = metrics.ccClause('p.', f.includeCc);
  const payParams = [];
  const payDate = metrics.dateClause('pp.created_at', f.from, f.to, payParams);
  const payCc = metrics.ccClause('p.', f.includeCc);
  const collParams = [];
  // `collectedRow` queries proposal_payments without an alias on the default
  // path. Only when a cc filter is active do we join to proposals to filter.
  const collTable = f.includeCc === 'all' ? 'proposal_payments' : 'proposal_payments pp';
  const collDateCol = f.includeCc === 'all' ? 'created_at' : 'pp.created_at';
  const collJoin = f.includeCc === 'all' ? '' : ' JOIN proposals p ON p.id = pp.proposal_id';
  const collStatusCol = f.includeCc === 'all' ? 'status' : 'pp.status';
  const collAmountCol = f.includeCc === 'all' ? 'amount' : 'pp.amount';
  const collDate = metrics.dateClause(collDateCol, f.from, f.to, collParams);
  const collCc = metrics.ccClause('p.', f.includeCc);
  // Net succeeded refunds out of Collected (cash basis: the refund's own
  // created_at). Built AFTER collDate so the refund date params follow the
  // payment date params in `collParams`.
  const collRefunds = metrics.refundsInWindow(f.from, f.to, collParams, f.includeCc === 'all' ? 'all' : f.includeCc);
  // CC-era collected (signed cents over paid_on; '0' under 'exclude'). Same
  // cash-basis window; the ledger's negative refund rows net themselves.
  const collCcLedger = metrics.ccPaidLeg(f.from, f.to, collParams, f.includeCc);
  // Unlinked refunds (payment_id NULL): netted in Collected but attach to no
  // payment row, so the ledger rows cannot reflect them. Surface the total (same
  // refund-date window + cc basis as Collected) so the UI can explain any gap
  // between the visible rows and Collected.
  const unlinkedParams = [];
  const unlinkedDate = metrics.dateClause('pr.created_at', f.from, f.to, unlinkedParams);
  const unlinkedCcJoin = f.includeCc === 'all' ? '' : ' JOIN proposals p2 ON p2.id = pr.proposal_id';
  const unlinkedCc = f.includeCc === 'only' ? ' AND p2.cc_id IS NOT NULL'
    : f.includeCc === 'exclude' ? ' AND p2.cc_id IS NULL' : '';
  // Thumbtack lead spend (acquisition cost), cash basis by the lead's created_at.
  // lead_price is a "$18.60"-style VARCHAR from the TT webhook: the regex admits
  // only clean dollar strings before the numeric cast (junk parses to nothing,
  // never 500s the dashboard). charge_state='Charged' is real spend; the NULL
  // rows are pre-chargeState legacy leads that carry real prices ("Pending"
  // rows carry no price at all). Attribution rides thumbtack_leads.proposal_id,
  // stamped by the auto-draft. No cc clause: TT leads are all post-cutover native.
  const leadParams = [];
  const leadDate = metrics.dateClause('tl.created_at', f.from, f.to, leadParams);

  const [moneyR, outR, accR, totalR, proposalsR, paymentsR, collectedRow, unlinkedR, leadSpendR] = await Promise.all([
    pool.query(money.sql, money.params),
    pool.query(out.sql, out.params),
    pool.query(acc.sql, acc.params),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM proposals p
       WHERE p.status NOT IN ('draft')${propDate}${propCc}`, listParams),
    pool.query(`
      SELECT p.id, p.client_id, p.event_type, p.event_type_custom, p.event_date, p.total_price, p.amount_paid,
             p.deposit_amount, p.status, p.created_at, p.cc_id AS proposal_cc_id,
             c.name AS client_name, c.email AS client_email, c.cc_id AS client_cc_id,
             sp.name AS package_name
      FROM proposals p
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.status NOT IN ('draft')${propDate}${propCc}
      ORDER BY p.event_date DESC NULLS LAST
      LIMIT $${listParams.length + 1} OFFSET $${listParams.length + 2}
    `, [...listParams, limit, offset]),
    pool.query(`
      SELECT pp.id, pp.proposal_id, p.client_id, pp.payment_type, pp.amount, pp.status AS payment_status,
             pp.created_at, p.event_type, p.event_type_custom, p.cc_id AS proposal_cc_id,
             c.name AS client_name, c.cc_id AS client_cc_id,
             inv.invoice_id, inv.invoice_token,
             COALESCE(rf.refunded_cents, 0) AS refunded_cents,
             GREATEST(pp.amount - COALESCE(rf.refunded_cents, 0), 0) AS net_amount
      FROM proposal_payments pp
      JOIN proposals p ON p.id = pp.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN LATERAL (
        SELECT ip.invoice_id, i.token AS invoice_token
        FROM invoice_payments ip
        LEFT JOIN invoices i ON i.id = ip.invoice_id
        WHERE ip.payment_id = pp.id
        ORDER BY ip.amount DESC, ip.id
        LIMIT 1
      ) inv ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(pr.amount), 0) AS refunded_cents
        FROM proposal_refunds pr
        WHERE pr.payment_id = pp.id AND pr.status = 'succeeded'
      ) rf ON true
      WHERE pp.status = 'succeeded'${payDate}${payCc}
      ORDER BY pp.created_at DESC
      LIMIT 200
    `, payParams),
    pool.query(
      `SELECT (COALESCE(SUM(${collAmountCol}),0) - ${collRefunds} + ${collCcLedger})::float8 AS c FROM ${collTable}${collJoin}
       WHERE ${collStatusCol}='succeeded'${collDate}${collCc}`, collParams),
    pool.query(
      `SELECT COALESCE(SUM(pr.amount),0)::int AS c FROM proposal_refunds pr${unlinkedCcJoin}
        WHERE pr.status='succeeded' AND pr.payment_id IS NULL${unlinkedDate}${unlinkedCc}`, unlinkedParams),
    pool.query(`
      SELECT COALESCE(SUM(x.cents),0)::int AS total_cents,
             COALESCE(SUM(x.cents) FILTER (WHERE x.proposal_id IS NOT NULL),0)::int AS attributed_cents,
             COUNT(*)::int AS charged_leads,
             COUNT(x.proposal_id)::int AS attributed_leads
      FROM (
        SELECT tl.proposal_id,
               ROUND(REPLACE(tl.lead_price, '$', '')::numeric * 100)::int AS cents
          FROM thumbtack_leads tl
         WHERE tl.lead_price ~ '^\\$?[0-9]{1,6}(\\.[0-9]{1,2})?$'
           AND (tl.charge_state = 'Charged' OR tl.charge_state IS NULL)${leadDate}
      ) x`, leadParams),
  ]);

  const booked = metrics.toDollars(moneyR.rows[0].value, { fromCents: !!money.cents });
  const acceptedCount = accR.rows[0].count;

  res.json({
    filters: { from: f.from, to: f.to, basis: f.basis },
    summary: {
      booked,
      collected: metrics.toDollars(collectedRow.rows[0].c, { fromCents: true }),
      outstanding: metrics.toDollars(outR.rows[0].value),
      avgEvent: acceptedCount > 0 ? Math.round(booked / acceptedCount) : 0,
      unlinkedRefundsCents: unlinkedR.rows[0].c,
      leadSpend: {
        totalCents: leadSpendR.rows[0].total_cents,
        attributedCents: leadSpendR.rows[0].attributed_cents,
        unattributedCents: leadSpendR.rows[0].total_cents - leadSpendR.rows[0].attributed_cents,
        chargedLeads: leadSpendR.rows[0].charged_leads,
        attributedLeads: leadSpendR.rows[0].attributed_leads,
      },
    },
    proposals: proposalsR.rows,
    recentPayments: paymentsR.rows,
    pagination: { page, limit, total: totalR.rows[0].total },
  });
}));

/** GET /api/proposals/:id/lead-cost — Thumbtack acquisition cost for one proposal.
 *  The charged (or legacy NULL-state priced) lead linked via
 *  thumbtack_leads.proposal_id, stamped by the auto-draft. Informational,
 *  read-only; drives the "Acquisition" line on the admin payment panel.
 *  Non-numeric / unlinked ids resolve to { leadCost: null } (never a 500). */
router.get('/:id/lead-cost', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.json({ leadCost: null });
  const { rows } = await pool.query(
    `SELECT tl.lead_price, tl.charge_state,
            CASE WHEN tl.lead_price ~ '^\\$?[0-9]{1,6}(\\.[0-9]{1,2})?$'
                  AND (tl.charge_state = 'Charged' OR tl.charge_state IS NULL)
                 THEN ROUND(REPLACE(tl.lead_price, '$', '')::numeric * 100)::int
                 ELSE NULL END AS lead_price_cents
       FROM thumbtack_leads tl
      WHERE tl.proposal_id = $1
      ORDER BY tl.id DESC
      LIMIT 1`,
    [id]
  );
  res.json({ leadCost: rows[0] || null });
}));

/** GET /api/proposals/dashboard-stats — aggregates that the admin home dashboard renders.
 *  Server-side so totals stay accurate past the 50-row default LIMIT on /api/proposals.
 *  A `source` query param (thumbtack|manual) returns ONLY { pipeline, paidCount,
 *  archivedCount } (the tab-count subset) — the full-KPI cards never pass `source`. */
router.get('/dashboard-stats', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Source-scoped counts for the Proposals list filter. Returns ONLY the tab
  // count fields the dashboard reads (pipeline / paidCount / archivedCount);
  // KPI cards never pass `source`, so they keep the full metrics path below.
  const srcParam = req.query.source === 'thumbtack' ? 'thumbtack'
    : req.query.source === 'manual' ? 'manual' : null;
  if (srcParam) {
    const clause = srcParam === 'thumbtack' ? "source = 'thumbtack'" : 'source IS NULL';
    const [pipeR, paidR, archR] = await Promise.all([
      pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
                  FROM proposals WHERE status IN ('draft','sent','viewed','modified','accepted') AND ${clause} GROUP BY status`),
      pool.query(`SELECT COUNT(*)::int AS count FROM proposals WHERE status IN ('deposit_paid','balance_paid','confirmed','completed') AND ${clause}`),
      pool.query(`SELECT COUNT(*)::int AS count FROM proposals WHERE status = 'archived' AND ${clause}`),
    ]);
    const byStatus = Object.fromEntries(pipeR.rows.map(r => [r.status, { count: r.count, value: r.value }]));
    const pipeline = [
      { key: 'draft', label: 'Draft' }, { key: 'sent', label: 'Sent' },
      { key: 'viewed', label: 'Viewed' }, { key: 'modified', label: 'Modified' },
      { key: 'accepted', label: 'Accepted' },
    ].map(b => ({ key: b.key, label: b.label, count: byStatus[b.key]?.count || 0, value: byStatus[b.key]?.value || 0 }));
    return res.json({ pipeline, paidCount: paidR.rows[0].count, archivedCount: archR.rows[0].count });
  }
  const f = metrics.resolveFilters(req.query);
  const prior = metrics.priorPeriod(f.from, f.to);

  const money = metrics.qMoney(f);
  const out = metrics.qOutstanding(f);
  const sent = metrics.qSent(f);
  const acc = metrics.qAccepted(f);
  const wr = metrics.qWinRate(f);
  const tta = metrics.qTimeToAccept(f);
  const lost = metrics.qLostValue(f);
  const pipeOut = metrics.qPipelineOutstanding(f);
  const rev = metrics.qRevenue(f);
  const paidCnt = metrics.qPaidCount(f);

  // Prior-period variants (null when All time → no prior window).
  const priorF = prior ? { ...f, from: prior.from, to: prior.to } : null;
  const moneyPrior = priorF ? metrics.qMoney(priorF) : null;
  const outPrior = priorF ? metrics.qOutstanding(priorF) : null;

  const PIPELINE_STATUSES = "('draft', 'sent', 'viewed', 'modified', 'accepted')";

  const [
    moneyR, outR, sentR, accR, wrR, ttaR, lostR, pipeOutR, revR,
    pipelineR, moneyPriorR, outPriorR, paidCntR, archivedCntR,
  ] = await Promise.all([
    pool.query(money.sql, money.params),
    pool.query(out.sql, out.params),
    pool.query(sent.sql, sent.params),
    pool.query(acc.sql, acc.params),
    pool.query(wr.sql, wr.params),
    pool.query(tta.sql, tta.params),
    pool.query(lost.sql, lost.params),
    pool.query(pipeOut.sql, pipeOut.params),
    pool.query(rev.sql, rev.params),
    pool.query(`
      SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_price),0)::float8 AS value
      FROM proposals WHERE status IN ${PIPELINE_STATUSES}${metrics.ccClause('', f.includeCc)} GROUP BY status
    `),
    moneyPrior ? pool.query(moneyPrior.sql, moneyPrior.params) : Promise.resolve(null),
    outPrior ? pool.query(outPrior.sql, outPrior.params) : Promise.resolve(null),
    pool.query(paidCnt.sql, paidCnt.params),
    pool.query(`SELECT COUNT(*)::int AS count FROM proposals WHERE status = 'archived'${metrics.ccClause('', f.includeCc)}`),
  ]);

  const PIPELINE_ORDER = [
    { key: 'draft', label: 'Draft' }, { key: 'sent', label: 'Sent' },
    { key: 'viewed', label: 'Viewed' }, { key: 'modified', label: 'Modified' },
    { key: 'accepted', label: 'Accepted' },
  ];
  const pipelineByStatus = Object.fromEntries(
    pipelineR.rows.map(r => [r.status, { count: r.count, value: r.value }])
  );
  const pipeline = PIPELINE_ORDER.map(b => ({
    key: b.key, label: b.label,
    count: pipelineByStatus[b.key]?.count || 0,
    value: pipelineByStatus[b.key]?.value || 0,
  }));

  const fc = { fromCents: !!money.cents };
  const value = metrics.toDollars(moneyR.rows[0].value, fc);
  const priorValue = moneyPriorR ? metrics.toDollars(moneyPriorR.rows[0].value, fc) : null;
  const outstanding = metrics.toDollars(outR.rows[0].value);
  const outstandingPrior = outPriorR ? metrics.toDollars(outPriorR.rows[0].value) : null;
  const pct = (cur, pre) =>
    // Guard a non-positive prior: refund netting can drive a prior paid value
    // to <= 0, where a percent delta is nonsensical (or divides by zero).
    (pre === null || pre === undefined || pre <= 0) ? null : Math.round(((cur - pre) / pre) * 100);
  const sc = wrR.rows[0].sent_cohort;
  const md = ttaR.rows[0].median_days;

  res.json({
    filters: { from: f.from, to: f.to, basis: f.basis },
    money: {
      basis: f.basis,
      value, priorValue, deltaPct: pct(value, priorValue),
      outstanding, outstandingPrior, outstandingDeltaPct: pct(outstanding, outstandingPrior),
    },
    funnel: {
      sent: { count: sentR.rows[0].count, value: metrics.toDollars(sentR.rows[0].value) },
      accepted: { count: accR.rows[0].count, value: metrics.toDollars(accR.rows[0].value) },
      winRate: {
        sentCohort: sc,
        acceptedFromCohort: wrR.rows[0].accepted_from_cohort,
        pending: wrR.rows[0].pending,
        pct: sc > 0 ? Math.round((wrR.rows[0].accepted_from_cohort / sc) * 100) : null,
      },
      timeToAcceptMedianDays: (md === null || md === undefined) ? null : Math.round(Number(md) * 10) / 10,
      lostValue: metrics.toDollars(lostR.rows[0].value),
      pipelineOutstanding: { count: pipeOutR.rows[0].count, value: metrics.toDollars(pipeOutR.rows[0].value) },
    },
    revenue: revR.rows,
    pipeline,
    paidCount: paidCntR.rows[0].count,
    archivedCount: archivedCntR.rows[0].count,
  });
}));

module.exports = router;
