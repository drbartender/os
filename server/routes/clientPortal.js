const express = require('express');
const { pool } = require('../db');
const { clientAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError } = require('../utils/errors');
const { PROPOSAL_SUMMARY_COLUMNS, shapeFocus } = require('./clientPortal/summary');
const { requireUuidToken } = require('../utils/tokens');

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
  // asyncHandler funnels any rejection to the global error middleware, which
  // captures to Sentry with req.user context — no local try/catch needed (and
  // the detail route below has none either; keep them consistent).
  const clientId = req.user.id;
  const email = req.user.email;
  // Focus ordering prefers BOOKED proposals so a newer draft can never shadow a
  // booked event on the same date/time (fix #9). open_invoice_token/label carry
  // the oldest still-payable invoice (status sent|partially_paid) so Next-Up can
  // route "Pay balance" straight to the invoice page instead of the planner.
  // partially_paid is load-bearing: sent-only would re-dead-end a part-payer.
  const BOOKED_FIRST = `ORDER BY (p.status IN ('deposit_paid','balance_paid','confirmed')) DESC,
                                 p.event_date ASC, p.event_start_time ASC NULLS LAST, p.created_at DESC LIMIT 1`;
  const focusSelect = `
    SELECT ${PROPOSAL_SUMMARY_COLUMNS},
           dp.token AS drink_plan_token, dp.submitted_at AS drink_plan_submitted_at,
           oi.open_invoice_token, oi.open_invoice_label
    FROM proposals p
    LEFT JOIN LATERAL (
      SELECT token, submitted_at FROM drink_plans
      WHERE proposal_id = p.id AND proposal_id IN (SELECT id FROM proposals WHERE client_id = $1)
      ORDER BY id LIMIT 1
    ) dp ON true
    LEFT JOIN LATERAL (
      SELECT token AS open_invoice_token, label AS open_invoice_label
      FROM invoices WHERE proposal_id = p.id AND status IN ('sent','partially_paid')
      ORDER BY created_at ASC LIMIT 1
    ) oi ON true
    WHERE p.client_id = $1 AND p.status <> 'archived' AND p.status <> 'completed'`;
  const [dated, nullDraft, countRes, archiveRes, draftRes] = await Promise.all([
    pool.query(`${focusSelect} AND p.event_date >= CURRENT_DATE ${BOOKED_FIRST}`, [clientId]),
    pool.query(`${focusSelect} AND p.event_date IS NULL ${BOOKED_FIRST}`, [clientId]),
    pool.query(`SELECT COUNT(*)::int AS n FROM proposals
                WHERE client_id = $1 AND status NOT IN ('archived','completed') AND event_date >= CURRENT_DATE`, [clientId]),
    // Archive is bounded (LIMIT 50) so the landing payload can't grow without
    // limit for a repeat client; if one ever exceeds it, back the dedicated
    // /my-proposals/archive route with a paged endpoint.
    pool.query(`SELECT p.token, p.event_type, p.event_type_custom, p.event_date,
                       COALESCE(p.total_price_override, p.total_price) AS total_price, p.status
                FROM proposals p WHERE p.client_id = $1 AND (
                  p.status = 'completed'
                  OR (p.status = 'archived' AND p.archive_reason = 'event_completed')
                  OR (p.status IN ('deposit_paid','balance_paid','confirmed') AND p.event_date < CURRENT_DATE))
                ORDER BY p.event_date DESC NULLS LAST LIMIT 50`, [clientId]),
    pool.query(`SELECT EXISTS(SELECT 1 FROM quote_drafts WHERE LOWER(email) = LOWER($1) AND status = 'draft') AS has`, [email]),
  ]);
  const focusRow = dated.rows[0] || nullDraft.rows[0] || null;
  res.json({
    focus: focusRow ? shapeFocus(focusRow) : null,
    upcoming_count: countRes.rows[0].n,
    archive: archiveRes.rows.map(r => ({ ...r, total_price: Number(r.total_price) })),
    has_quote_draft: draftRes.rows[0].has,
  });
}));

// GET /api/client-portal/proposals/:token — full proposal detail
router.get('/proposals/:token', requireUuidToken('token', 'Proposal not found.'), asyncHandler(async (req, res) => {
  // Public-safe column allowlist — even the client themselves should not see
  // admin_notes, stripe_customer_id, stripe_payment_method_id, or signature IP/UA.
  const result = await pool.query(`
    SELECT
      p.id, p.token, p.client_id,
      p.event_date, p.event_start_time, p.event_duration_hours,
      p.event_location, p.event_type, p.event_type_category, p.event_type_custom,
      p.guest_count, p.package_id, p.num_bars, p.num_bartenders,
      p.total_price, p.status,
      p.amount_paid, p.deposit_amount, p.payment_type, p.autopay_enrolled,
      p.balance_due_date,
      p.client_signed_name, p.client_signed_at, p.client_signature_method,
      p.client_signature_document_version,
      p.view_count, p.last_viewed_at, p.created_at, p.updated_at,
      p.venue_name, p.venue_city, p.venue_state, p.total_price_override,
      dp.token AS drink_plan_token, dp.submitted_at AS drink_plan_submitted_at,
      oi.open_invoice_token, oi.open_invoice_label,
      sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category,
      sp.includes AS package_includes,
      c.name AS client_name, c.email AS client_email, c.phone AS client_phone
    FROM proposals p
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN LATERAL (
      SELECT token, submitted_at FROM drink_plans
      WHERE proposal_id = p.id AND proposal_id IN (SELECT id FROM proposals WHERE client_id = $2)
      ORDER BY id LIMIT 1
    ) dp ON true
    LEFT JOIN LATERAL (
      SELECT token AS open_invoice_token, label AS open_invoice_label
      FROM invoices WHERE proposal_id = p.id AND status IN ('sent','partially_paid')
      ORDER BY created_at ASC LIMIT 1
    ) oi ON true
    WHERE p.token = $1 AND p.client_id = $2
  `, [req.params.token, req.user.id]);

  if (!result.rows[0]) throw new NotFoundError('Proposal not found.');

  const proposal = result.rows[0];

  // Fetch add-ons + payments in parallel — both depend only on proposal.id
  // (explicit columns — no SELECT *)
  // The proposal row above is already client-scoped (WHERE client_id = $2), so
  // proposal.id is owned. The extra `proposal_id IN (... WHERE client_id)` filter
  // is belt-and-suspenders against IDOR surviving a future refactor of the lookup.
  const [addons, payments] = await Promise.all([
    pool.query(
      `SELECT id, proposal_id, addon_id, addon_name, billing_type, rate, quantity::float8 AS quantity, line_total, variant
         FROM proposal_addons
        WHERE proposal_id = $1
          AND proposal_id IN (SELECT id FROM proposals WHERE client_id = $2)
        ORDER BY id`,
      [proposal.id, req.user.id]
    ),
    pool.query(
      `SELECT id, proposal_id, payment_type, amount, status, created_at
         FROM proposal_payments
        WHERE proposal_id = $1
          AND proposal_id IN (SELECT id FROM proposals WHERE client_id = $2)
        ORDER BY created_at DESC`,
      [proposal.id, req.user.id]
    ),
  ]);

  res.json({
    proposal: { ...proposal, addons: addons.rows, payments: payments.rows },
  });
}));

// Change-request endpoints (calculate / create / list / cancel). Inherits the
// router-level clientAuth applied above.
router.use('/', require('./clientPortal/changeRequests'));

module.exports = router;
