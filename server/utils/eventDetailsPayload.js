// Staff event-details payload builder (spec 2026-07-22).
//
// Extracted from server/routes/beo.js so two routes can share one body:
//   GET /api/beo/:proposalId                  (proposal-keyed, legacy + admin)
//   GET /api/shifts/:shiftId/event-details     (shift-keyed, the staff page)
//
// READ AUTHORIZATION (loosened by the 2026-07-22 spec). Staff decide whether to
// REQUEST a shift from this payload, so gating the read behind an approved
// assignment left browsing staff with an error page and nothing else. Any
// ONBOARDED staffer may now read an event that has at least one non-cancelled
// shift; admin/manager always. A missing proposal, or a proposal with no
// staffable shift, is a 404 for staff and NEVER a 403 — a 403 would let a
// probing account enumerate proposal ids by the error boundary.
//
// "Onboarded" is doing real work in that sentence, and every caller MUST mount
// `requireOnboarded` alongside `auth`. Registration is public and mints a live
// JWT for an `in_progress` staff row, so plain `auth` would have made this
// payload — client names, venue addresses, drink plans, crew names — readable
// by anyone who signed up. Caught by the lane-1 review fleet before merge.
//
// What loosening the read does NOT do: contact details stay gated. A viewer who
// is not approved-and-active on the event gets `client.phone = null` and null
// teammate phones, so a brand-new staffer cannot harvest the crew's numbers.
// The WRITE path (acknowledge) is unchanged and still assigned-only.

const { pool } = require('../db');
const { NotFoundError } = require('./errors');
const { computeDisplayName } = require('./staffDisplayName');

/**
 * Read auth for any event-details surface. Throws NotFoundError when the
 * proposal does not exist or (for staff) carries no non-cancelled shift.
 * Admin / manager bypass the shift check entirely.
 *
 * This function assumes the route already ran `requireOnboarded` (see head).
 * It deliberately does not re-check, so the "who counts as staff" rule lives in
 * exactly one place: middleware/auth.js.
 */
async function authorizeEventRead(req, proposalId) {
  // Belt-and-suspenders against a NaN reaching pg as a bind param (22P02 → 500).
  // Each route also guards, but this keeps the util safe for any future caller.
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  const exists = await pool.query('SELECT 1 FROM proposals WHERE id = $1 LIMIT 1', [proposalId]);
  if (!exists.rowCount) throw new NotFoundError('Event not found.');
  if (req.user.role === 'admin' || req.user.role === 'manager') return;
  // Staff: the event must be staffable at all. Not "is this yours".
  const r = await pool.query(
    `SELECT 1 FROM shifts WHERE proposal_id = $1 AND status != 'cancelled' LIMIT 1`,
    [proposalId]
  );
  if (!r.rowCount) throw new NotFoundError('Event not found.');
}

/**
 * Build the full event-details payload for a proposal. Callers must have run
 * authorizeEventRead first.
 */
async function buildEventDetailsPayload(req, proposalId) {
  // Proposal + client + package join. We deliberately do NOT select fields like
  // pricing_snapshot, total_price, deposit_amount, amount_paid, autopay_*, or
  // stripe_* — bartenders do not need pricing/payment data to execute the event.
  const propRowP = pool.query(
    `SELECT p.id, p.event_type, p.event_type_custom, p.event_date, p.event_start_time,
            p.event_duration_hours, p.event_timezone, p.event_location, p.guest_count,
            p.venue_street, p.venue_city, p.venue_state, p.venue_zip,
            p.num_bars, p.num_bartenders, p.setup_minutes_before, p.status,
            p.balance_due_date, p.client_id,
            p.tip_jar, p.gratuity_rate, (p.pricing_snapshot->>'staff_noun') AS staff_noun,
            p.menu_print_key, p.menu_not_required,
            c.name AS client_name, c.phone AS client_phone,
            sp.id AS package_id, sp.name AS package_name, sp.pricing_type AS package_pricing_type,
            sp.guests_per_bartender
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );

  // Drink plan: explicit column list — `token` MUST NOT appear in the response,
  // because anyone with the drink_plans.token can hit the public client-facing
  // route. Leaking it to a bartender's compromised account would let them see
  // the proposal as the client does. `has_logo` is computed as a boolean so the
  // client can decide whether to render the logo proxy endpoint.
  const dpRowP = pool.query(
    `SELECT id, status, finalized_at, finalized_by, selections, consult_selections,
            admin_notes, shopping_list_status,
            (selections ? '_logoFilename') AS has_logo
       FROM drink_plans WHERE proposal_id = $1`,
    [proposalId]
  );

  const addonsRowP = pool.query(
    // Money columns (rate, line_total) are deliberately NOT selected: crew need
    // to know WHAT was bought, never what the client paid. This mattered less
    // when only assigned crew could read the payload; with the read ungated it
    // is load-bearing.
    `SELECT addon_id, addon_name, billing_type, quantity::float8 AS quantity
       FROM proposal_addons WHERE proposal_id = $1 ORDER BY addon_name`,
    [proposalId]
  );

  // Roster + per-staffer ack state. Admin viewers see only the user-id +
  // ack-timestamp pair; the viewer-flag below is derived from this set so each
  // staffer's status (is_acknowledged for self) is consistent with what admins
  // see for them.
  const shiftReqsRowP = pool.query(
    `SELECT sr.user_id, sr.id AS request_id, COALESCE(cp.display_name, cp.preferred_name, u.email) AS name,
            sr.beo_acknowledged_at
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN users u ON u.id = sr.user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE s.proposal_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL AND s.status != 'cancelled'
      ORDER BY name`,
    [proposalId]
  );

  // A worker is whoever holds an approved active shift on this proposal (the set
  // selected above). The admin-VIEW flag must NOT key on role alone: a manager
  // who is actually staffed (audit 3c W1) is a worker — they get the staff-portal
  // confirm/drop/cover UI and their ack must round-trip — while an admin, or a
  // manager who is only viewing, stays an admin-style viewer.

  // ── Team roster (spec §6.18). Spec defines `team_roster` as the active
  // approved bartenders on this proposal — the same hybrid-state filter the
  // payroll + auto-assign code uses (status='approved' AND dropped_at IS NULL,
  // matching idx_shift_requests_active_approved). An emergency-dropped
  // staffer keeps status='approved' for management to resolve but does NOT
  // appear on the roster the team sees. The roster also LEFT JOINs
  // applications + agreements to derive a display name even for legacy
  // staffers who never went through the modern application flow.
  const rosterRowP = pool.query(
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

  // Every non-cancelled shift on the event, plus the viewer's own request on
  // each. This is what lets the staff page render the brief (roles, gear,
  // supply run, times) and the correct action (request / withdraw / cover /
  // confirm) without a second round trip through the list feeds.
  const shiftsRowP = pool.query(
    `SELECT s.id, s.event_date, s.start_time, s.end_time, s.location, s.guest_count,
            s.positions_needed, s.equipment_required, s.supply_run_required,
            s.setup_minutes_before,
            -- event_type / client_name ride along so the page can title a shift
            -- whose proposal row is missing or thin (legacy manual shifts).
            s.event_type, s.event_type_custom, s.client_name,
            abr.approved_by_role,
            cov.cover_requested_at, cov.cover_for_first_initial,
            my.id AS my_request_id, my.status AS my_request_status, my.position AS my_position,
            my.requested_positions AS my_requested_positions
       FROM shifts s
       LEFT JOIN LATERAL (
         SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb) AS approved_by_role
           FROM (SELECT position, COUNT(*) c FROM shift_requests
                  WHERE shift_id = s.id AND status = 'approved' AND dropped_at IS NULL
                    AND position IS NOT NULL GROUP BY position) g
       ) abr ON true
       LEFT JOIN LATERAL (
         SELECT csr.cover_requested_at,
                -- display_name first: a staffer with no preferred name still
                -- has a display name ("Nevver S."), so the banner shows "N"
                -- instead of "?". Same chain as shifts.queries.js.
                UPPER(LEFT(TRIM(COALESCE(cp2.display_name, cp2.preferred_name, '?')), 1)) AS cover_for_first_initial
           FROM shift_requests csr
           LEFT JOIN contractor_profiles cp2 ON cp2.user_id = csr.user_id
          WHERE csr.shift_id = s.id AND csr.cover_requested_at IS NOT NULL
            AND csr.status = 'approved' AND csr.dropped_at IS NULL
          ORDER BY csr.cover_requested_at ASC LIMIT 1
       ) cov ON true
       LEFT JOIN LATERAL (
         SELECT sr.id, sr.status, sr.position, sr.requested_positions
           FROM shift_requests sr
          WHERE sr.shift_id = s.id AND sr.user_id = $2
            AND sr.status != 'denied' AND sr.dropped_at IS NULL
          ORDER BY sr.id DESC LIMIT 1
       ) my ON true
      WHERE s.proposal_id = $1 AND s.status != 'cancelled'
      ORDER BY s.id`,
    [proposalId, req.user.id]
  );

  // One barrier for the whole payload. Every query above depends only on
  // proposalId + req.user.id, so they are mutually independent; awaiting them
  // serially cost a Neon round trip apiece on the staff portal's hottest read.
  // Safe to fan out because nothing here holds a client from pool.connect()
  // (see the one-pooled-connection-per-request rule in CLAUDE.md).
  const [propRow, dpRow, addonsRow, shiftReqsRow, rosterRow, shiftsRow] = await Promise.all([
    propRowP, dpRowP, addonsRowP, shiftReqsRowP, rosterRowP, shiftsRowP,
  ]);

  const p = propRow.rows[0];
  // Defensive: authorizeEventRead proved existence a moment ago, but a delete in
  // that window (or a future caller that skips it) must 404, not TypeError→500.
  if (!p) throw new NotFoundError('Event not found.');
  const dp = dpRow.rows[0] || null;

  // A worker is whoever holds an approved active shift on this proposal. The
  // admin-VIEW flag must NOT key on role alone: a manager who is actually
  // staffed (audit 3c W1) is a worker — they get the confirm/drop/cover UI and
  // their ack must round-trip — while an admin, or a manager who is only
  // viewing, stays an admin-style viewer.
  const isStaffer = shiftReqsRow.rows.some((r) => r.user_id === req.user.id);
  const isAdmin = (req.user.role === 'admin' || req.user.role === 'manager') && !isStaffer;
  const isAck = shiftReqsRow.rows.some(
    (r) => r.user_id === req.user.id && r.beo_acknowledged_at !== null
  );

  // Phone gating (spec §6.18, carried forward unchanged by the 2026-07-22
  // ungating). Teammates' phones surface only when the VIEWER themselves is
  // approved+active on this proposal. A staffer who is merely browsing or has a
  // pending request does NOT get to harvest active bartenders' numbers.
  // viewerApproved IS isStaffer. `shiftReqsRow` already selected every approved
  // active request on this proposal with the identical JOIN + predicates; asking
  // the DB the same question again, filtered to one user_id, was a wasted round
  // trip AND a second copy of the rule that gates contact redaction.
  const viewerApproved = isStaffer;
  const isPrivileged = req.user.role === 'admin' || req.user.role === 'manager';
  // Client contact: assigned workers need it to call the host from the venue.
  // Admin/manager keep it because that is their existing contact path.
  const canSeeContact = viewerApproved || isPrivileged;

  function computeInitials(name) {
    if (!name) return '??';
    // Match a first-token+next-word-initial pair when the name has a space.
    const m = name.match(/(\S)\S*\s+(\S)/);
    if (m) return (m[1] + m[2]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  const team_roster = rosterRow.rows.map((r) => {
    // Shared helper (spec §5). Two deliberate differences from the deleted local
    // computeName: agreement-first precedence (it read applications first, but
    // the signed agreement is what everything else in this system prefers), and
    // the empty-preferred-name case, which the helper covers by falling back
    // to the legal first name so a client-facing surface never shows an email.
    const display_name =
      computeDisplayName({
        preferredName: r.preferred_name,
        legalFullName: r.agreements_name || r.applications_name,
      }) || (r.email && r.email.includes('@') ? r.email.split('@')[0] : 'Staff');
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

  return {
    proposal: {
      id: p.id,
      event_type: p.event_type,
      event_type_custom: p.event_type_custom,
      event_date: p.event_date,
      event_start_time: p.event_start_time,
      event_duration_hours: p.event_duration_hours,
      event_timezone: p.event_timezone,
      event_location: p.event_location,
      // Structured address parts (address-only, name excluded) so the staff
      // "Get directions" link geocodes the street address instead of the venue
      // name — see venueMapQuery in client/src/components/VenueAddressFields.js.
      venue_street: p.venue_street,
      venue_city: p.venue_city,
      venue_state: p.venue_state,
      venue_zip: p.venue_zip,
      guest_count: p.guest_count,
      num_bars: p.num_bars,
      num_bartenders: p.num_bartenders,
      setup_minutes_before: p.setup_minutes_before,
      // Gratuity / tip jar (§9) — crew-facing, NOT gated on funding. Defaults
      // backfill old rows (tip_jar true, gratuity_rate 0), so the fallback is safe.
      tip_jar: p.tip_jar !== false,
      gratuity_prepaid: Number(p.gratuity_rate) > 0,
      staff_noun: p.staff_noun || 'bartender',
    },
    client: { name: p.client_name, phone: canSeeContact ? p.client_phone : null },
    package: p.package_id ? {
      id: p.package_id,
      name: p.package_name,
      pricing_type: p.package_pricing_type,
      guests_per_bartender: p.guests_per_bartender,
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
    shift_requests: shiftReqsRow.rows.map((r) => ({ user_id: r.user_id, request_id: r.request_id, beo_acknowledged_at: r.beo_acknowledged_at })),
    team_roster,
    shifts: shiftsRow.rows,
    // Tri-state derived, never stored. The R2 key itself never leaves the
    // server; staff download through the authed proxy instead.
    menu_print: p.menu_print_key
      ? { status: 'ready' }
      : p.menu_not_required
      ? { status: 'not_required' }
      : { status: 'pending' },
    viewer: { is_admin: isAdmin, is_assigned: viewerApproved, is_acknowledged: isAck },
  };
}

module.exports = { authorizeEventRead, buildEventDetailsPayload };
