// Public "compare your options" page data + admin preview. A group bundles two or
// three sibling proposal "options" behind one /compare/:token link. The projection
// here is a POSITIVE allowlist — only the fields the compare page needs — so it can
// never leak admin_notes / stripe_* / signature / other PII (those columns are
// simply never selected).
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { publicLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError } = require('../../utils/errors');
const { requireUuidToken } = require('../../utils/tokens');

const router = express.Router();

// Per-option public-safe columns. Event fields repeat per row but are identical
// across options (they share the same event); the response hoists them into one
// shared header. pricing_type drives the BYOB/Hosted badge; package_slug lets the
// client resolve the full section detail from its own packages catalog.
const OPTION_SELECT = `
  p.id, p.token, p.status, p.total_price, p.deposit_amount, p.package_id,
  sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category, sp.pricing_type,
  p.event_type, p.event_type_category, p.event_type_custom, p.event_date,
  p.event_start_time, p.event_duration_hours, p.guest_count, p.event_location`;

// An option is client-visible once it has been sent (never a bare draft).
const VISIBLE_STATUSES = ['sent', 'viewed', 'modified', 'accepted', 'deposit_paid', 'balance_paid', 'confirmed', 'completed'];

async function loadGroup(token) {
  const { rows: [g] } = await pool.query(
    `SELECT g.id, g.token, g.chosen_proposal_id, cp.token AS chosen_token, c.name AS client_name
       FROM proposal_groups g
       LEFT JOIN proposals cp ON cp.id = g.chosen_proposal_id
       LEFT JOIN clients c ON c.id = g.client_id
      WHERE g.token = $1`,
    [token]);
  if (!g) return null;
  const { rows: members } = await pool.query(
    `SELECT ${OPTION_SELECT}
       FROM proposals p
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.group_id = $1
      ORDER BY p.created_at ASC`,
    [g.id]);
  return { g, members };
}

function shape(g, options) {
  const first = options[0] || {};
  return {
    group_token: g.token,
    decided: g.chosen_proposal_id !== null,
    chosen_token: g.chosen_token || null,
    client_name: g.client_name || null,
    event_header: {
      event_type: first.event_type,
      event_type_category: first.event_type_category,
      event_type_custom: first.event_type_custom,
      event_date: first.event_date,
      event_start_time: first.event_start_time,
      event_duration_hours: first.event_duration_hours,
      guest_count: first.guest_count,
      event_location: first.event_location,
    },
    options: options.map((o) => ({
      id: o.id,
      token: o.token,
      status: o.status,
      package_name: o.package_name,
      package_slug: o.package_slug,
      package_category: o.package_category,
      pricing_type: o.pricing_type,
      total_price: o.total_price,
      deposit_amount: o.deposit_amount,
    })),
  };
}

// GET /api/proposals/group/:token — public compare-page data. 404 while every
// option is still an unsent draft. When decided, `decided` + `chosen_token` tell
// the client to route to the booked option.
router.get('/group/:token', publicLimiter, requireUuidToken('token', 'This comparison is no longer available'), asyncHandler(async (req, res) => {
  const loaded = await loadGroup(req.params.token);
  if (!loaded) throw new NotFoundError('This comparison is no longer available');
  const visible = loaded.members.filter((m) => VISIBLE_STATUSES.includes(m.status));
  if (visible.length === 0) throw new NotFoundError('This comparison is no longer available');
  res.json(shape(loaded.g, visible));
}));

// GET /api/proposals/group/:token/preview — admin preview; ignores the visibility
// gate so admin can review the comparison (including draft options) before sending.
router.get('/group/:token/preview', auth, requireAdminOrManager, requireUuidToken('token', 'Comparison not found'), asyncHandler(async (req, res) => {
  const loaded = await loadGroup(req.params.token);
  if (!loaded) throw new NotFoundError('Comparison not found');
  res.json(shape(loaded.g, loaded.members));
}));

module.exports = router;
