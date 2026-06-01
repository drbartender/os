// BEO (Banquet Event Order) read-only routes for staff + admin.
//
// GET /api/beo/:proposalId       — full BEO payload for an event (proposal-scoped).
// GET /api/beo/:proposalId/logo  — proxied download of the drink-plan logo (R2 stays private).
//
// Authorization model (mirrors the rest of the staff portal):
//   - admin / manager — always allowed.
//   - staff           — allowed iff they hold an `approved` shift_request on a
//                       non-cancelled shift linked to this proposal.
//
// `authorize()` runs the 404-then-403 check in that order so we don't leak the
// existence of a proposal to a probing staff account.

const express = require('express');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { beoReadLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError, PermissionError, ConflictError, ExternalServiceError } = require('../utils/errors');
const { getSignedUrl } = require('../utils/storage');

const router = express.Router();

/**
 * Authorization for any staff/admin viewer on a proposal-keyed BEO route.
 * Throws NotFoundError if the proposal does not exist, PermissionError if the
 * caller is staff without an approved, non-cancelled shift on the proposal.
 * Admin / manager bypass the shift check.
 *
 * Order matters: existence check first, then role check. Otherwise a staffer
 * could enumerate proposal ids via the 403/404 boundary.
 */
async function authorize(req, proposalId) {
  // 404 first to avoid leaking proposal existence to a probing staffer.
  const exists = await pool.query('SELECT 1 FROM proposals WHERE id = $1 LIMIT 1', [proposalId]);
  if (!exists.rowCount) throw new NotFoundError('Event not found.');
  if (req.user.role === 'admin' || req.user.role === 'manager') return;
  const r = await pool.query(
    `SELECT 1 FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1 AND sr.user_id = $2
        AND sr.status = 'approved' AND sr.dropped_at IS NULL AND s.status != 'cancelled'
      LIMIT 1`,
    [proposalId, req.user.id]
  );
  if (!r.rowCount) throw new PermissionError('You are not assigned to this event.');
}

router.get('/:proposalId', auth, beoReadLimiter, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  await authorize(req, proposalId);

  // Proposal + client + package join. We deliberately do NOT select fields like
  // pricing_snapshot, total_price, deposit_amount, amount_paid, autopay_*, or
  // stripe_* — bartenders do not need pricing/payment data to execute the event.
  const propRow = await pool.query(
    `SELECT p.id, p.event_type, p.event_type_custom, p.event_date, p.event_start_time,
            p.event_duration_hours, p.event_timezone, p.event_location, p.guest_count,
            p.num_bars, p.num_bartenders, p.setup_minutes_before, p.status,
            p.balance_due_date, p.client_id,
            c.name AS client_name, c.phone AS client_phone,
            sp.id AS package_id, sp.name AS package_name, sp.pricing_type AS package_pricing_type,
            sp.guests_per_bartender, sp.extra_bartender_hourly
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const p = propRow.rows[0];

  // Drink plan: explicit column list — `token` MUST NOT appear in the response,
  // because anyone with the drink_plans.token can hit the public client-facing
  // route. Leaking it to a bartender's compromised account would let them see
  // the proposal as the client does. `has_logo` is computed as a boolean so the
  // client can decide whether to render the logo proxy endpoint.
  const dpRow = await pool.query(
    `SELECT id, status, finalized_at, finalized_by, selections, consult_selections,
            admin_notes, shopping_list_status,
            (selections ? '_logoFilename') AS has_logo
       FROM drink_plans WHERE proposal_id = $1`,
    [proposalId]
  );
  const dp = dpRow.rows[0] || null;

  const addonsRow = await pool.query(
    `SELECT addon_id, addon_name, billing_type, rate, quantity, line_total
       FROM proposal_addons WHERE proposal_id = $1 ORDER BY addon_name`,
    [proposalId]
  );

  // Roster + per-staffer ack state. Admin viewers see only the user-id +
  // ack-timestamp pair; the viewer-flag below is derived from this set so each
  // staffer's status (is_acknowledged for self) is consistent with what admins
  // see for them.
  const shiftReqsRow = await pool.query(
    `SELECT sr.user_id, COALESCE(cp.preferred_name, u.email) AS name,
            sr.beo_acknowledged_at
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN users u ON u.id = sr.user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE s.proposal_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL AND s.status != 'cancelled'
      ORDER BY name`,
    [proposalId]
  );

  const isAdmin = req.user.role === 'admin' || req.user.role === 'manager';
  const isAck = isAdmin
    ? false
    : shiftReqsRow.rows.some((r) => r.user_id === req.user.id && r.beo_acknowledged_at !== null);

  // ── Team roster (spec §6.18). Spec defines `team_roster` as the active
  // approved bartenders on this proposal — the same hybrid-state filter the
  // payroll + auto-assign code uses (status='approved' AND dropped_at IS NULL,
  // matching idx_shift_requests_active_approved). An emergency-dropped
  // staffer keeps status='approved' for management to resolve but does NOT
  // appear on the roster the team sees on the BEO. The roster also LEFT JOINs
  // applications + agreements to derive a display name even for legacy
  // staffers who never went through the modern application flow.
  //
  // SCHEMA ADAPTATIONS from the planning SQL:
  //   - Plan said `s.canceled_at IS NULL`. The real `shifts` table uses a
  //     `status` column ('open' / 'cancelled' / etc.) — no `canceled_at`
  //     column exists. Mirrors the existing `s.status != 'cancelled'` guard
  //     in authorize() and the shift_requests projection above.
  const rosterRow = await pool.query(
    `SELECT sr.user_id,
            sr.position AS role,
            sr.cover_requested_at,
            cp.preferred_name,
            cp.phone,
            a.full_name AS applications_name,
            ag.full_name AS agreements_name,
            u.email
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN users u ON u.id = sr.user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
       LEFT JOIN applications a ON a.user_id = sr.user_id
       LEFT JOIN agreements ag ON ag.user_id = sr.user_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL
        AND s.status != 'cancelled'
      ORDER BY sr.id`,
    [proposalId]
  );

  // Phone gating (spec §6.18). Teammates' phones surface only when the
  // VIEWER themselves is approved+active on this proposal. A pending
  // requester (who could be a brand-new staffer the admin hasn't confirmed
  // yet) does NOT get to harvest active bartenders' numbers via the BEO
  // endpoint. Admins/managers are not staff and therefore do not satisfy
  // the approved-on-this-proposal predicate either — they get null phones
  // here, which is fine: admin contact paths use the existing admin UI,
  // not the team-roster card.
  const viewerRow = await pool.query(
    `SELECT 1
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1
        AND sr.user_id = $2
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL
        AND s.status != 'cancelled'
      LIMIT 1`,
    [proposalId, req.user.id]
  );
  const viewerApproved = viewerRow.rowCount > 0;

  // computeName: preferred_name + last-initial of legal name, falling back
  // through applications → agreements → email-local-part. Mirrors the
  // resolution chain in spec §6.18.
  function computeName(row) {
    const preferred = (row.preferred_name || '').trim();
    if (preferred) {
      const legal = ((row.applications_name || row.agreements_name) || '').trim();
      const lastToken = legal ? legal.split(/\s+/).pop() : '';
      const lastInit = lastToken && lastToken[0] ? lastToken[0].toUpperCase() : '';
      return lastInit ? `${preferred} ${lastInit}.` : preferred;
    }
    const legal = ((row.applications_name || row.agreements_name) || '').trim();
    if (legal) {
      const parts = legal.split(/\s+/);
      if (parts.length >= 2) {
        return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
      }
      return parts[0];
    }
    const email = (row.email || '').trim();
    if (email && email.includes('@')) return email.split('@')[0];
    return 'Staff';
  }

  function computeInitials(name) {
    if (!name) return '??';
    // Match a first-token+next-word-initial pair when the name has a space.
    const m = name.match(/(\S)\S*\s+(\S)/);
    if (m) return (m[1] + m[2]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  const team_roster = rosterRow.rows.map((r) => {
    const display_name = computeName(r);
    return {
      user_id: r.user_id,
      display_name,
      initials: computeInitials(display_name),
      is_me: r.user_id === req.user.id,
      role: r.role || 'Bartender',
      phone: viewerApproved ? (r.phone || null) : null,
      needs_cover: r.cover_requested_at !== null,
    };
  });

  res.json({
    proposal: {
      id: p.id,
      event_type: p.event_type,
      event_type_custom: p.event_type_custom,
      event_date: p.event_date,
      event_start_time: p.event_start_time,
      event_duration_hours: p.event_duration_hours,
      event_timezone: p.event_timezone,
      event_location: p.event_location,
      guest_count: p.guest_count,
      num_bars: p.num_bars,
      num_bartenders: p.num_bartenders,
      setup_minutes_before: p.setup_minutes_before,
    },
    client: { name: p.client_name, phone: p.client_phone },
    package: p.package_id ? {
      id: p.package_id,
      name: p.package_name,
      pricing_type: p.package_pricing_type,
      guests_per_bartender: p.guests_per_bartender,
      extra_bartender_hourly: p.extra_bartender_hourly,
    } : null,
    drink_plan: dp ? {
      id: dp.id,
      status: dp.status,
      finalized_at: dp.finalized_at,
      finalized_by: dp.finalized_by,
      selections: dp.selections,
      consult_selections: dp.consult_selections,
      admin_notes: dp.admin_notes,
      has_logo: dp.has_logo === true,
    } : null,
    shopping_list_status: dp ? dp.shopping_list_status : null,
    addons: addonsRow.rows,
    shift_requests: shiftReqsRow.rows.map((r) => ({ user_id: r.user_id, beo_acknowledged_at: r.beo_acknowledged_at })),
    team_roster,
    viewer: { is_admin: isAdmin, is_acknowledged: isAck },
  });
}));

router.get('/:proposalId/logo', auth, beoReadLimiter, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  await authorize(req, proposalId);

  const r = await pool.query(
    `SELECT selections->>'_logoFilename' AS filename
       FROM drink_plans WHERE proposal_id = $1`,
    [proposalId]
  );
  const filename = r.rows[0] && r.rows[0].filename;
  if (!filename) throw new NotFoundError('No logo uploaded for this plan.');
  // Path-traversal guard. The upload pipeline always writes under
  // `drink-plan-logos/`; rejecting anything else means a tampered drink_plan row
  // can't trick us into proxying an arbitrary R2 object.
  if (!filename.startsWith('drink-plan-logos/')) throw new NotFoundError('No logo uploaded for this plan.');

  const url = await getSignedUrl(filename);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let upstream;
  try {
    upstream = await fetch(url, { signal: ac.signal });
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'Logo is temporarily unavailable.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    throw new ExternalServiceError('r2', new Error(`Upstream returned ${upstream.status}`), 'Logo is temporarily unavailable.');
  }
  res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

// POST /:proposalId/acknowledge — staff stamps beo_acknowledged_at on every
// approved, non-cancelled shift_request they hold on this event. Admin/manager
// callers get a 200 no-op (acknowledged:false) so the same UI button is safe
// for both audiences. Requires the drink plan to be finalized — pre-finalize
// acknowledgement would let staff confirm a BEO that admin may still revise.
router.post('/:proposalId/acknowledge', auth, beoReadLimiter, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  await authorize(req, proposalId);

  // Admin/manager: no-op. They view the BEO but never "acknowledge" — the
  // ack timestamp is a per-bartender state used to drive the unack nudge.
  if (req.user.role === 'admin' || req.user.role === 'manager') {
    return res.json({ acknowledged: false });
  }

  // Single UPDATE…FROM. Covers staffers with multiple approved shifts on the
  // same proposal (multi-bar events) by stamping every matching row at once.
  // Joining drink_plans inside the UPDATE means the finalized_at gate runs
  // atomically — no TOCTOU between read and write.
  const result = await pool.query(
    `UPDATE shift_requests sr
        SET beo_acknowledged_at = NOW()
       FROM shifts s
       JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
      WHERE sr.shift_id = s.id
        AND s.proposal_id = $1
        AND sr.user_id = $2
        AND sr.status = 'approved'
        AND sr.dropped_at IS NULL
        AND s.status != 'cancelled'
        AND dp.finalized_at IS NOT NULL
      RETURNING sr.id, sr.shift_id, sr.beo_acknowledged_at`,
    [proposalId, req.user.id]
  );

  if (result.rowCount === 0) {
    // Discriminator: authorize() already proved the staffer has an approved
    // active shift, so the only thing the UPDATE can have rejected on is the
    // finalized_at gate. Re-check to give a precise error.
    const dp = await pool.query('SELECT finalized_at FROM drink_plans WHERE proposal_id = $1', [proposalId]);
    if (!dp.rows[0] || !dp.rows[0].finalized_at) {
      throw new ConflictError('Plan is not finalized.');
    }
    throw new ConflictError('No approved active shift for you on this event.');
  }

  console.log(`[beo] acknowledge proposal=${proposalId} user=${req.user.id} rows=${result.rowCount}`);
  res.json({
    acknowledged: true,
    beo_acknowledged_at: result.rows[0].beo_acknowledged_at,
    request_ids: result.rows.map((r) => r.id),
  });
}));

module.exports = router;
