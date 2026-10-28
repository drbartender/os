// GET/POST /api/stripe-payouts - DB-only payout mirror list/detail + rate-limited sweep trigger
// (read-side; admin/manager)

const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { adminWriteLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler'); // cf. beo.js:18 — middleware/, not utils/
const { NotFoundError } = require('../utils/errors');
const payoutSync = require('../utils/stripePayoutSync');

const router = express.Router();

// staff_name resolves the tip line's staffer from contractor_profiles.display_name
// (preferred name plus last initial, see utils/staffDisplayName.js), then the raw
// preferred name, then the users.email fallback. Read-side display only: matching
// keys on tips.target_user_id, never on this string.
const LINE_SELECT = `
  SELECT l.id, l.stripe_balance_txn_id, l.payout_id, l.txn_type, l.reporting_category,
         l.amount_cents, l.fee_cents, l.net_cents, l.available_on, l.description,
         l.matched_kind, l.acknowledged_at, l.proposal_id, l.invoice_id, l.tip_id,
         c.name AS client_name, pr.event_type, pr.event_type_custom,
         inv.invoice_number, inv.token AS invoice_token,
         COALESCE(cp.display_name, cp.preferred_name, u.email) AS staff_name,
         t.target_user_id AS staff_user_id
  FROM stripe_payout_lines l
  LEFT JOIN proposals pr ON pr.id = l.proposal_id
  LEFT JOIN clients c ON c.id = pr.client_id
  LEFT JOIN invoices inv ON inv.id = l.invoice_id
  LEFT JOIN tips t ON t.id = l.tip_id
  LEFT JOIN users u ON u.id = t.target_user_id
  LEFT JOIN contractor_profiles cp ON cp.user_id = t.target_user_id`;

// In transit: what the coming deposits will carry. A manual payout's debit counts
// (the only payout-type line the pending path stores), so money already sent is
// netted out. An instant payout's advance (+) and the funding that repays it out
// of later charges (-) cancel inside the deposits that claim them, so unclaimed
// pair lines are left out of the sum and the list. A deposit can claim an advance
// before its funding exists (a bank-debit payout inside the repayment window), so
// the net of the pair lines already claimed, the advance still owed, is
// subtracted; it is zero whenever one deposit claims an advance with all its
// funding.
const ADVANCE_PAIR = `COALESCE(l.reporting_category, l.txn_type) IN ('advance', 'advance_funding')`;
const IN_TRANSIT = `l.payout_id IS NULL AND NOT ${ADVANCE_PAIR}`;

// DB-only: never calls Stripe (fetched on dashboard mount for the unmatched badge).
router.get('/', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const [summary, pending, payouts] = await Promise.all([
    pool.query(`
      SELECT
        (COALESCE(SUM(l.net_cents) FILTER (WHERE ${IN_TRANSIT}), 0)
          - COALESCE(SUM(l.net_cents) FILTER (WHERE l.payout_id IS NOT NULL AND ${ADVANCE_PAIR}), 0))::int AS in_transit_cents,
        -- Returned on its own so the tab can list it: the In transit lines less
        -- this add up to in_transit_cents.
        COALESCE(SUM(l.net_cents) FILTER (WHERE l.payout_id IS NOT NULL AND ${ADVANCE_PAIR}), 0)::int AS advance_owed_cents,
        COALESCE(SUM(fee_cents) FILTER (WHERE available_on >= date_trunc('month', NOW())), 0)::int AS fees_mtd_cents,
        COALESCE(SUM(fee_cents) FILTER (WHERE available_on >= date_trunc('year', NOW())), 0)::int AS fees_ytd_cents,
        COUNT(*) FILTER (WHERE matched_kind = 'unmatched' AND acknowledged_at IS NULL)::int AS unmatched_count
      FROM stripe_payout_lines l`),
    pool.query(`${LINE_SELECT} WHERE ${IN_TRANSIT} ORDER BY l.available_on ASC NULLS LAST`),
    pool.query(`
      SELECT p.id, p.stripe_payout_id, p.amount_cents, p.status, p.arrival_date,
             p.created_at_stripe, p.failure_code, p.failure_message, p.automatic,
             COALESCE(SUM(l.amount_cents), 0)::int AS gross_cents,
             COALESCE(SUM(l.fee_cents), 0)::int AS fee_cents,
             COUNT(l.id)::int AS line_count,
             COUNT(*) FILTER (WHERE l.matched_kind = 'unmatched' AND l.acknowledged_at IS NULL)::int AS unmatched_count
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

// One payout (`:id` = integer PK) with its reconciled balance-transaction lines
// (client/invoice/staff joins). 404 via `NotFoundError`.
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

// Trigger `sweep({ force })` through the module's in-flight guard + 15-min staleness gate.
// `{ synced: false }` = fresh/skipped.
router.post('/sync', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  // In-flight guard + 15-min staleness gate live in the module; force bypasses staleness only.
  const r = await payoutSync.sweep({ force: req.body?.force === true });
  res.json({ synced: !(r && r.fresh), last_synced_at: payoutSync.getLastSweepAt() });
}));

module.exports = router;
