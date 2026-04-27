const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { calculateProposal } = require('../../utils/pricingEngine');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError } = require('../../utils/errors');

const router = express.Router();

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

/** POST /api/proposals/calculate — preview pricing without saving */
router.post('/calculate', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { package_id, guest_count, duration_hours, num_bars, num_bartenders, addon_ids, addon_variants, syrup_selections, adjustments, total_price_override } = req.body;
  if (!package_id) {
    throw new ValidationError({ package_id: 'Package is required' });
  }

  const pkgResult = await pool.query('SELECT * FROM service_packages WHERE id = $1', [package_id]);
  if (!pkgResult.rows[0]) {
    throw new ValidationError({ package_id: 'Package not found' });
  }

  let addons = [];
  if (addon_ids && addon_ids.length > 0) {
    const addonResult = await pool.query(
      'SELECT * FROM service_addons WHERE id = ANY($1) AND is_active = true',
      [addon_ids]
    );
    addons = addonResult.rows.map(a => ({
      ...a,
      variant: addon_variants?.[String(a.id)] || null,
    }));
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
  });

  res.json(snapshot);
}));

// ─── Financials ─────────────────────────────────────────────────

/** GET /api/proposals/financials — aggregate financial data */
router.get('/financials', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const [summaryResult, proposalsResult, paymentsResult] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(total_price), 0) AS total_revenue,
        COALESCE(SUM(amount_paid), 0) AS total_collected,
        COALESCE(SUM(total_price - COALESCE(amount_paid, 0)), 0) AS total_outstanding
      FROM proposals
      WHERE status IN ('deposit_paid', 'balance_paid', 'confirmed', 'completed')
    `),
    pool.query(`
      SELECT p.id, p.event_type, p.event_type_custom, p.event_date, p.total_price, p.amount_paid,
             p.deposit_amount, p.status, p.created_at,
             c.name AS client_name, c.email AS client_email,
             sp.name AS package_name
      FROM proposals p
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.status NOT IN ('draft')
      ORDER BY p.event_date DESC NULLS LAST
      LIMIT $1 OFFSET $2
    `, [limit, offset]),
    pool.query(`
      SELECT pp.id, pp.proposal_id, pp.payment_type, pp.amount, pp.status AS payment_status,
             pp.created_at, p.event_type, p.event_type_custom, c.name AS client_name,
             ip.invoice_id, i.token AS invoice_token
      FROM proposal_payments pp
      JOIN proposals p ON p.id = pp.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN invoice_payments ip ON ip.payment_id = pp.id
      LEFT JOIN invoices i ON i.id = ip.invoice_id
      WHERE pp.status = 'succeeded'
      ORDER BY pp.created_at DESC
      LIMIT 20
    `)
  ]);

  res.json({
    summary: summaryResult.rows[0],
    proposals: proposalsResult.rows,
    recentPayments: paymentsResult.rows
  });
}));

/** GET /api/proposals/dashboard-stats — aggregates that the admin home dashboard renders.
 *  Server-side so totals stay accurate past the 50-row default LIMIT on /api/proposals. */
router.get('/dashboard-stats', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const PAID_STATUSES = "('deposit_paid', 'balance_paid', 'confirmed', 'completed')";
  const PIPELINE_STATUSES = "('draft', 'sent', 'viewed', 'modified', 'accepted')";

  const [totalsResult, pipelineResult, revenueResult] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(total_price), 0)::float8 AS booked,
        COALESCE(SUM(amount_paid), 0)::float8 AS collected,
        COALESCE(SUM(GREATEST(total_price - COALESCE(amount_paid, 0), 0)), 0)::float8 AS outstanding,
        COUNT(*)::int AS events_count,
        COUNT(*) FILTER (WHERE total_price > COALESCE(amount_paid, 0))::int AS events_owing_balance
      FROM proposals
      WHERE status IN ${PAID_STATUSES}
    `),
    pool.query(`
      SELECT status, COUNT(*)::int AS count, COALESCE(SUM(total_price), 0)::float8 AS value
      FROM proposals
      WHERE status IN ${PIPELINE_STATUSES}
      GROUP BY status
    `),
    pool.query(`
      WITH months AS (
        SELECT generate_series(
          date_trunc('month', NOW() - INTERVAL '11 months'),
          date_trunc('month', NOW()),
          INTERVAL '1 month'
        )::date AS month_start
      )
      SELECT
        to_char(m.month_start, 'YYYY-MM') AS key,
        to_char(m.month_start, 'Mon')     AS m,
        COALESCE(SUM(p.total_price), 0)::float8 AS booked,
        COALESCE(SUM(p.amount_paid), 0)::float8 AS collected
      FROM months m
      LEFT JOIN proposals p
        -- Range comparison keeps the idx_proposals_event_date btree usable —
        -- wrapping in date_trunc(...) on the join key would force a seq scan.
        ON p.event_date >= m.month_start
        AND p.event_date <  (m.month_start + INTERVAL '1 month')::date
        AND p.status IN ${PAID_STATUSES}
      GROUP BY m.month_start
      ORDER BY m.month_start
    `),
  ]);

  // Hydrate pipeline keys for any active status with no rows so the client always
  // receives the full set in display order.
  const PIPELINE_ORDER = [
    { key: 'draft',    label: 'Draft' },
    { key: 'sent',     label: 'Sent' },
    { key: 'viewed',   label: 'Viewed' },
    { key: 'modified', label: 'Modified' },
    { key: 'accepted', label: 'Accepted' },
  ];
  const pipelineByStatus = Object.fromEntries(
    pipelineResult.rows.map(r => [r.status, { count: r.count, value: r.value }])
  );
  const pipeline = PIPELINE_ORDER.map(b => ({
    key: b.key,
    label: b.label,
    count: pipelineByStatus[b.key]?.count || 0,
    value: pipelineByStatus[b.key]?.value || 0,
  }));

  res.json({
    totals: totalsResult.rows[0],
    pipeline,
    revenue: revenueResult.rows,
  });
}));

module.exports = router;
