/**
 * Long SQL strings for server/routes/shifts.js (Task 28 projections).
 *
 * Extracted so shifts.js stays under its 1000-line hard cap when adding the
 * cover_requested_at + cover_for_first_initial + payout_id projections.
 * The LATERAL subqueries are not reused elsewhere (yet) but live here as
 * sibling exports to keep the route handler readable.
 */

const { shiftNotFinishedSql } = require('../utils/shiftEndInstant');

// Staff-side GET /api/shifts list. Projects BEO (drink plan + own ack) and
// cover (any active cover-requesting shift_request on this shift + the
// requester's first initial). Cover LATERAL returns NULL columns when no
// teammate has flipped cover on the shift.
// Columns are projected explicitly (not s.*) to keep client_email / client_phone
// OFF the staff feed: staff never need the client's contact info. equipment_required
// + supply_run_required ride along for the logistics tag. approved_by_role is the
// per-role approved-active aggregate the staff card needs to compute per-role fill
// (the staff feed does not return the full requests list, so it cannot count
// client-side the way the admin drawer does).
// The staffer-facing "you are hauling a bar" fact, matching the duty deriver's
// money predicates EXACTLY (server/utils/dutyLines.js): a hosted (per_guest)
// package carries the bar whenever the booking has one; BYOB only when the
// client actually paid bar rental. Bare `num_bars > 0` is NOT enough — the
// column DEFAULTS to 1, so 17 prod proposals carry a defaulted bar and no bar
// money (schema.sql:2243 zeroes bar fees on exactly those packages).
// ONE fragment, three queries (staff feed, request transport gate, event
// details payload), so the ack, the card, and the duty pay can never disagree.
// Reads pricing_snapshot inside the boolean only; no money field is returned.
const barRequiredSql = (p, spk) =>
  `(COALESCE(${p}.num_bars, 0) > 0 AND (
      ${spk}.pricing_type = 'per_guest'
      OR COALESCE((${p}.pricing_snapshot->'bar_rental'->>'total')::numeric, 0) > 0
    ))`;

const STAFF_OPEN_SHIFTS_SQL = `
  SELECT
    s.id, s.event_date, s.start_time, s.end_time, s.location, s.positions_needed,
    s.notes, s.status, s.created_by, s.created_at, s.updated_at, s.proposal_id,
    s.lat, s.lng, s.equipment_required, s.auto_assign_days_before, s.auto_assigned_at,
    s.setup_minutes_before, s.client_name, s.guest_count, s.event_duration_hours,
    s.event_type, s.event_type_custom, s.supply_run_required, s.supply_run_overridden,
    sr.id   AS my_request_id,
    sr.status AS my_request_status,
    sr.position AS my_request_position,
    sr.requested_positions AS my_requested_positions,
    sr.beo_acknowledged_at AS my_beo_acknowledged_at,
    dp.finalized_at AS drink_plan_finalized_at,
    dp.status AS drink_plan_status,
    cov.cover_requested_at,
    cov.cover_for_first_initial,
    abr.approved_by_role,
    spk.pricing_type AS package_pricing_type,
    -- Derived, never stored (fix list 2026-08-13): see barRequiredSql above.
    ${barRequiredSql('pp', 'spk')} AS bar_required
  FROM shifts s
  LEFT JOIN shift_requests sr ON sr.shift_id = s.id AND sr.user_id = $1
  LEFT JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
  -- Package pricing type ('per_guest' = hosted) drives the hosted-event warning
  -- in the staff RequestSheet. Contact columns stay OFF this feed; only the
  -- pricing type rides along.
  LEFT JOIN proposals pp ON pp.id = s.proposal_id
  LEFT JOIN service_packages spk ON spk.id = pp.package_id
  LEFT JOIN LATERAL (
    SELECT csr.cover_requested_at,
           -- display_name first: a staffer with no preferred name still has a
           -- display name ("Nevver S."), so the banner shows "N" instead of
           -- "?". Same chain as eventDetailsPayload.js.
           UPPER(LEFT(TRIM(COALESCE(cp2.display_name, cp2.preferred_name, '?')), 1)) AS cover_for_first_initial
      FROM shift_requests csr
      LEFT JOIN contractor_profiles cp2 ON cp2.user_id = csr.user_id
     WHERE csr.shift_id = s.id AND csr.cover_requested_at IS NOT NULL
       AND csr.status = 'approved' AND csr.dropped_at IS NULL
     ORDER BY csr.cover_requested_at ASC LIMIT 1
  ) cov ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb) AS approved_by_role
      FROM (
        SELECT position, COUNT(*) c FROM shift_requests
         WHERE shift_id = s.id AND status = 'approved' AND dropped_at IS NULL
           AND position IS NOT NULL
         GROUP BY position
      ) g
  ) abr ON true
  -- "Upcoming" is "has not finished yet", measured against the shift's END
  -- INSTANT (server/utils/shiftEndInstant.js), never a calendar day. The old
  -- event_date >= CURRENT_DATE resolved CURRENT_DATE in the GMT session zone,
  -- so tonight's open shift dropped off this tab at 19:00 Chicago; widening it
  -- to the Chicago day instead kept this MORNING's finished shift listed all
  -- day. The end instant answers both at once. The proposal alias pp is the
  -- LEFT JOIN above; it supplies event_timezone.
  --
  -- The staff-home teaser and its "All (N)" count (routes/staffPortal.js) are
  -- documented mirrors of this filter and use the SAME imported fragment.
  WHERE s.status = 'open' AND ${shiftNotFinishedSql('s', 'pp')}
  ORDER BY s.event_date ASC LIMIT 500
`;

// User events history (GET /api/shifts/user/:userId/events). Projects, for each
// past row, the user's payout_id + the per-shift line total (payout_line_total_cents)
// + the payout status, via a LATERAL JOIN restricted to the user's own payout
// (payouts is keyed on contractor_id). The staff Past tab renders the line total.
const USER_EVENTS_SQL = `
  SELECT s.id, s.proposal_id, s.event_date, s.start_time, s.end_time, s.location,
         s.setup_minutes_before,
         s.event_type, s.event_type_custom,
         ${barRequiredSql('p', 'spk')} AS bar_required,
         sr.position, sr.status AS request_status,
         sr.beo_acknowledged_at AS my_beo_acknowledged_at,
         p.event_type AS proposal_event_type,
         p.event_type_custom AS proposal_event_type_custom,
         COALESCE(c.name, s.client_name) AS client_name,
         COALESCE(p.guest_count, s.guest_count) AS guest_count,
         dp.finalized_at AS drink_plan_finalized_at,
         dp.status AS drink_plan_status,
         pay.payout_id,
         pay.line_total_cents AS payout_line_total_cents,
         pay.payout_status
  FROM shift_requests sr
  JOIN shifts s ON s.id = sr.shift_id
  LEFT JOIN proposals p ON p.id = s.proposal_id
  LEFT JOIN service_packages spk ON spk.id = p.package_id
  LEFT JOIN clients c ON c.id = p.client_id
  LEFT JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
  LEFT JOIN LATERAL (
    SELECT pe.payout_id, pe.line_total_cents, po.status AS payout_status
      FROM payout_events pe
      JOIN payouts po ON po.id = pe.payout_id
     WHERE pe.shift_id = s.id AND po.contractor_id = $1 LIMIT 1
  ) pay ON true
  WHERE sr.user_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL
  ORDER BY s.event_date DESC LIMIT 500
`;

// ─── Admin events-list "Plan" column (2026-08-25) ──────────────────────────
// Three facts the admin feed did not carry, feeding client/src/components/
// adminos/eventPlan.js. Kept here rather than inline because shifts.js sits
// against its 700-line soft cap.
//
// shopping_list_status is the ENTIRE client-input signal, deliberately without
// drink_plans.status beside it: the Plan column collapses pending and draft into
// one "Planner" state, so the plan's own status adds nothing. The list is
// generated server-side the instant a planner is submitted or an admin fills the
// consult form, which makes a NULL here mean "neither has happened" and
// 'pending_review' mean "generated, waiting on ADMIN approval" (approval is what
// makes it visible to the client; it is a handoff, not a formality). Verified in
// prod: the column is non-null exactly when a list exists, save one legacy
// 'reviewed' plan predating it.
//
// LATERAL, not the plain LEFT JOIN the staff feed uses: drink_plans.proposal_id
// carries an index but NO unique constraint, so a second plan on one proposal
// would silently DUPLICATE THE EVENT ROW in this list. Prod holds at most one
// per proposal today, so this is a guard against a shape the schema permits
// rather than a bug being fixed. The staff feed's plain join carries the same
// latent fan-out and is left alone here.
const planQueueSql = {
  // Newest plan wins, matching the LATERAL guard's intent if a second ever lands.
  drinkPlanJoin: `
      LEFT JOIN LATERAL (
        SELECT dp.shopping_list_status
          FROM drink_plans dp
         WHERE dp.proposal_id = s.proposal_id
         ORDER BY dp.id DESC LIMIT 1
      ) dpl ON true`,
  // The GOVERNING consult: latest scheduled wins, so a rebooking supersedes the
  // slot it replaced. Cancelled ones are excluded so a called-off meeting cannot
  // read as "waiting on the consult" forever. The other three statuses are dead
  // data (all prod rows read 'scheduled'; none has ever transitioned), so the
  // client can only judge a consult by whether its date has passed.
  consultJoin: `
      LEFT JOIN LATERAL (
        SELECT k.scheduled_at
          FROM consults k
         WHERE k.proposal_id = s.proposal_id AND k.status <> 'cancelled'
         ORDER BY k.scheduled_at DESC LIMIT 1
      ) cns ON true`,
  // menu_done mirrors AdminMenuPrintBlock's deriveStatus: an uploaded print key
  // and an explicit not-required flag both count as settled. Projected as a
  // boolean because the list needs the fact, never the R2 object key.
  select: `
        dpl.shopping_list_status,
        cns.scheduled_at AS consult_at,
        (p.menu_print_key IS NOT NULL OR COALESCE(p.menu_not_required, false)) AS menu_done,
        spk.category AS package_category,
        spk.name AS package_name`,
};

module.exports = { STAFF_OPEN_SHIFTS_SQL, USER_EVENTS_SQL, barRequiredSql, planQueueSql };
