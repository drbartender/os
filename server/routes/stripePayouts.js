const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { adminWriteLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler'); // cf. beo.js:18 — middleware/, not utils/
const { NotFoundError } = require('../utils/errors');
const payoutSync = require('../utils/stripePayoutSync');

const router = express.Router();

// staff_name resolves the tip line's staffer: contractor_profiles.preferred_name,
// then the users.email fallback (contractor_profiles has no full_name column, so
// the plan's cp.full_name is replaced by a users join — read-side display only).
const LINE_SELECT = `
  SELECT l.id, l.stripe_balance_txn_id, l.payout_id, l.txn_type, l.reporting_category,
         l.amount_cents, l.fee_cents, l.net_cents, l.available_on, l.description,
         l.matched_kind, l.proposal_id, l.invoice_id, l.tip_id,
         c.name AS client_name, pr.event_type, pr.event_type_custom,
         inv.invoice_number, inv.token AS invoice_token,
         COALESCE(cp.preferred_name, u.email) AS staff_name
  FROM stripe_payout_lines l
  LEFT JOIN proposals pr ON pr.id = l.proposal_id
  LEFT JOIN clients c ON c.id = pr.client_id
  LEFT JOIN invoices inv ON inv.id = l.invoice_id
  LEFT JOIN tips t ON t.id = l.tip_id
  LEFT JOIN users u ON u.id = t.target_user_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = t.target_user_id`;

// DB-only: never calls Stripe (fetched on dashboard mount for the unmatched badge).
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const [summary, pending, payouts] = await Promise.all([
    pool.query(`
      SELECT
        COALESCE(SUM(net_cents) FILTER (WHERE payout_id IS NULL AND txn_type <> 'payout'), 0)::int AS in_transit_cents,
        COALESCE(SUM(fee_cents) FILTER (WHERE available_on >= date_trunc('month', NOW())), 0)::int AS fees_mtd_cents,
        COALESCE(SUM(fee_cents) FILTER (WHERE available_on >= date_trunc('year', NOW())), 0)::int AS fees_ytd_cents,
        COUNT(*) FILTER (WHERE matched_kind = 'unmatched')::int AS unmatched_count
      FROM stripe_payout_lines`),
    pool.query(`${LINE_SELECT} WHERE l.payout_id IS NULL AND l.txn_type <> 'payout' ORDER BY l.available_on ASC NULLS LAST`),
    pool.query(`
      SELECT p.id, p.stripe_payout_id, p.amount_cents, p.status, p.arrival_date,
             p.created_at_stripe, p.failure_code, p.failure_message,
             COALESCE(SUM(l.amount_cents), 0)::int AS gross_cents,
             COALESCE(SUM(l.fee_cents), 0)::int AS fee_cents,
             COUNT(l.id)::int AS line_count
      FROM stripe_payouts p
      LEFT JOIN stripe_payout_lines l ON l.payout_id = p.id
      GROUP BY p.id ORDER BY p.created_at_stripe DESC`),
  ]);
  res.json({
    summary: { ...summary.rows[0], last_synced_at: payoutSync.getLastSweepAt() },
    pending: pending.rows,
    payouts: payouts.rows,
  });
}));

router.get('/:id(\\d+)', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const p = await pool.query(`
    SELECT p.*, COALESCE(SUM(l.amount_cents),0)::int AS gross_cents,
           COALESCE(SUM(l.fee_cents),0)::int AS fee_cents, COUNT(l.id)::int AS line_count
    FROM stripe_payouts p LEFT JOIN stripe_payout_lines l ON l.payout_id = p.id
    WHERE p.id = $1 GROUP BY p.id`, [req.params.id]);
  if (!p.rows[0]) throw new NotFoundError('Payout not found');
  const lines = await pool.query(`${LINE_SELECT} WHERE l.payout_id = $1 ORDER BY l.amount_cents DESC`, [req.params.id]);
  res.json({ payout: p.rows[0], lines: lines.rows });
}));

router.post('/sync', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  // In-flight guard + 15-min staleness gate live in the module; force bypasses staleness only.
  const r = await payoutSync.sweep({ force: req.body?.force === true });
  res.json({ synced: !(r && r.fresh), last_synced_at: payoutSync.getLastSweepAt() });
}));

module.exports = router;
