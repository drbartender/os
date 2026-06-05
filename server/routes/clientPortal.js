const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { clientAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError } = require('../utils/errors');
const { PROPOSAL_SUMMARY_COLUMNS, shapeFocus } = require('./clientPortal/summary');

const router = express.Router();

// All routes require client auth
router.use(clientAuth);

// GET /api/client-portal/home — landing read.
// Buckets the client's proposals into:
//   • focus      — soonest upcoming non-archived/non-completed proposal
//                  (dated >= today; null-date draft only if no dated upcoming)
//   • archive    — past events that happened (completed, event_completed
//                  archives, or booked-but-past)
//   • upcoming_count — total non-archived/non-completed with event_date >= today
//   • has_quote_draft — outstanding /quote draft tied to this client's email
// Scoped strictly by client_id = req.user.id (no IDOR). Money stays in DOLLARS
// (proposals.total_price / amount_paid are NUMERIC).
router.get('/home', asyncHandler(async (req, res) => {
  const clientId = req.user.id;
  const email = req.user.email;
  try {
    const focusSelect = `
      SELECT ${PROPOSAL_SUMMARY_COLUMNS},
             dp.token AS drink_plan_token, dp.submitted_at AS drink_plan_submitted_at
      FROM proposals p
      LEFT JOIN drink_plans dp
        ON dp.proposal_id = p.id AND dp.proposal_id IN (SELECT id FROM proposals WHERE client_id = $1)
      WHERE p.client_id = $1 AND p.status <> 'archived' AND p.status <> 'completed'`;
    const [dated, nullDraft, countRes, archiveRes, draftRes] = await Promise.all([
      pool.query(`${focusSelect} AND p.event_date >= CURRENT_DATE
                  ORDER BY p.event_date ASC, p.event_start_time ASC NULLS LAST, p.created_at DESC LIMIT 1`, [clientId]),
      pool.query(`${focusSelect} AND p.event_date IS NULL ORDER BY p.created_at DESC LIMIT 1`, [clientId]),
      pool.query(`SELECT COUNT(*)::int AS n FROM proposals
                  WHERE client_id = $1 AND status NOT IN ('archived','completed') AND event_date >= CURRENT_DATE`, [clientId]),
      pool.query(`SELECT p.token, p.event_type, p.event_type_custom, p.event_date,
                         COALESCE(p.total_price_override, p.total_price) AS total_price, p.status
                  FROM proposals p WHERE p.client_id = $1 AND (
                    p.status = 'completed'
                    OR (p.status = 'archived' AND p.archive_reason = 'event_completed')
                    OR (p.status IN ('deposit_paid','balance_paid','confirmed') AND p.event_date < CURRENT_DATE))
                  ORDER BY p.event_date DESC NULLS LAST`, [clientId]),
      pool.query(`SELECT EXISTS(SELECT 1 FROM quote_drafts WHERE LOWER(email) = LOWER($1) AND status = 'draft') AS has`, [email]),
    ]);
    const focusRow = dated.rows[0] || nullDraft.rows[0] || null;
    res.json({
      focus: focusRow ? shapeFocus(focusRow) : null,
      upcoming_count: countRes.rows[0].n,
      archive: archiveRes.rows.map(r => ({ ...r, total_price: Number(r.total_price) })),
      has_quote_draft: draftRes.rows[0].has,
    });
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, { tags: { route: 'client-portal/home', client_id: clientId } });
    throw err;
  }
}));

// GET /api/client-portal/proposals — list client's proposals
router.get('/proposals', asyncHandler(async (req, res) => {
  // cc_id is an internal/admin identifier (real CC ids on proposals/clients,
  // legacy_cc:* stubs on users) — excluded from the public client portal per
  // the CcImportBadge spec invariant (client/src/components/admin/CcImportBadge.js).
  const result = await pool.query(`
    SELECT p.id, p.token, p.event_type, p.event_type_custom, p.event_date, p.status, p.total_price, p.amount_paid, p.created_at, c.name AS client_name
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.client_id = $1
    ORDER BY p.created_at DESC
  `, [req.user.id]);

  res.json({ proposals: result.rows });
}));

// GET /api/client-portal/proposals/:token — full proposal detail
router.get('/proposals/:token', asyncHandler(async (req, res) => {
  // Public-safe column allowlist — even the client themselves should not see
  // admin_notes, stripe_customer_id, stripe_payment_method_id, or signature IP/UA.
  const result = await pool.query(`
    SELECT
      p.id, p.token, p.client_id,
      p.event_date, p.event_start_time, p.event_duration_hours,
      p.event_location, p.event_type, p.event_type_category, p.event_type_custom,
      p.guest_count, p.package_id, p.num_bars, p.num_bartenders,
      p.pricing_snapshot, p.total_price, p.status,
      p.amount_paid, p.deposit_amount, p.payment_type, p.autopay_enrolled,
      p.balance_due_date,
      p.client_signed_name, p.client_signed_at, p.client_signature_method,
      p.client_signature_document_version, p.client_signature_data,
      p.view_count, p.last_viewed_at, p.created_at, p.updated_at,
      p.venue_name, p.venue_city, p.venue_state, p.total_price_override,
      dp.token AS drink_plan_token, dp.submitted_at AS drink_plan_submitted_at,
      sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category,
      sp.includes AS package_includes,
      c.name AS client_name, c.email AS client_email, c.phone AS client_phone
    FROM proposals p
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN drink_plans dp
      ON dp.proposal_id = p.id AND dp.proposal_id IN (SELECT id FROM proposals WHERE client_id = $2)
    WHERE p.token = $1 AND p.client_id = $2
  `, [req.params.token, req.user.id]);

  if (!result.rows[0]) throw new NotFoundError('Proposal not found.');

  const proposal = result.rows[0];

  // Fetch add-ons + payments in parallel — both depend only on proposal.id
  // (explicit columns — no SELECT *)
  const [addons, payments] = await Promise.all([
    pool.query(
      'SELECT id, proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant FROM proposal_addons WHERE proposal_id = $1 ORDER BY id',
      [proposal.id]
    ),
    pool.query(
      `SELECT id, proposal_id, payment_type, amount, status, created_at
       FROM proposal_payments
       WHERE proposal_id = $1
       ORDER BY created_at DESC`,
      [proposal.id]
    ),
  ]);

  res.json({
    proposal: { ...proposal, addons: addons.rows, payments: payments.rows },
  });
}));

module.exports = router;
