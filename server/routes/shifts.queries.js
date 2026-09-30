/**
 * Long SQL strings for server/routes/shifts.js (Task 28 projections).
 *
 * Extracted so shifts.js stays under its 1000-line hard cap when adding the
 * cover_requested_at + cover_for_first_initial + payout_id projections.
 * The LATERAL subqueries are not reused elsewhere (yet) but live here as
 * sibling exports to keep the route handler readable.
 *
 * It also owns the ADMIN list projection, adminShiftsSelectSql (the bare-array
 * legacy feed the Events dashboard, the Overview page and the staff pages
 * read), and adminScopedShiftsSql, the scoped, event-paged builder behind
 * GET /shifts?scope=upcoming|past that the phone Events list reads. The scoped
 * builder splices its window keys into the same projection text rather than
 * restating it, so the two feeds cannot drift a column apart.
 */

const { shiftNotFinishedSql, shiftFinishedSql } = require('../utils/shiftEndInstant');
const { openSlotsSql } = require('../utils/positionsNeeded');

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
// plan_input_landed (submitted or consult-filled, straight off the plan) is
// the second input signal, and eventPlan.js ORs the two for every row. It is
// the ONLY one on a hosted row, because DRB stocks the bar and the generator
// is gated off hosted plans (shoppingListGen.isHostedPlan); on BYOB it covers
// the submit whose best-effort auto-gen skipped or threw, which used to read
// as "waiting on the planner" forever. package_bar_type rides along for the
// cocktail-class exception in that same rule.
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
        SELECT dp.shopping_list_status,
               (dp.submitted_at IS NOT NULL OR dp.consult_filled_at IS NOT NULL) AS plan_input_landed
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
        dpl.plan_input_landed,
        cns.scheduled_at AS consult_at,
        (p.menu_print_key IS NOT NULL OR COALESCE(p.menu_not_required, false)) AS menu_done,
        spk.category AS package_category,
        spk.bar_type AS package_bar_type,
        spk.name AS package_name`,
};

// ── Admin branch of GET /shifts ────────────────────────────────────────────
// One row per shift with the proposal, client, request counts and roster
// aggregates that the Events dashboard, the Overview page and the phone Events
// list read. Moved here from shifts.js (2026-09-18) so the scoped, event-paged
// variant below reuses the projection verbatim: two hand-maintained copies is
// how a column goes missing on one screen and not the other.
//
// `extraColumns` is spliced right after `SELECT s.*,` so the scoped builder
// can add its window keys without touching the legacy text.
function adminShiftsSelectSql(extraColumns = '') {
  return `
    SELECT s.*,${extraColumns}
        u.email AS created_by_email,
        p.total_price AS proposal_total,
        p.amount_paid AS proposal_amount_paid,
        COALESCE(p.guest_count, s.guest_count) AS proposal_guest_count,
        p.token AS proposal_token,
        p.status AS proposal_status,
        -- Derived, never stored (fix list 2026-08-13): see barRequiredSql.
        ${barRequiredSql('p', 'spk')} AS bar_required,
        COALESCE(c.name, s.client_name) AS client_name,
        COALESCE(c.phone, s.client_phone) AS client_phone,
        COALESCE(c.email, s.client_email) AS client_email,
        rc.request_count,
        rc.approved_count,
        rc.pending_count,
        abr.approved_by_role,
        -- Who is confirmed, for the events-list hover card. Same filter as
        -- rc.approved_count (approved AND not dropped) so the names always add
        -- up to the ratio beside them; same name rule as /by-proposal. Pending
        -- applicants are deliberately absent from THIS aggregate: they have
        -- their own, pending_staff below, behind the chip. The full-roster
        -- waitlist rule is enforced in StaffingCell's showChip, not here.
        -- Aliases are asr/au/acp because the outer query already owns u.
        --
        -- GATE, deliberately weaker than its siblings (decided 2026-08-25):
        -- every other route projecting staff identities (/by-proposal,
        -- /unstaffed-upcoming, /detail/:id, /:id/requests) is behind
        -- requireStaffing, i.e. admin OR manager-with-can_staff. This branch is
        -- behind requireOnboarded plus role admin/manager, so a manager with
        -- can_staff = false sees these names where it sees none elsewhere. That
        -- is intentional: this is the Events LIST, the roster is already the
        -- column being read, and a manager who can open the events dashboard at
        -- all can see the same people via the shift drawer. Prod has no
        -- manager-role users today, so it changes nobody's access now. If a
        -- non-staffing manager role is ever created and this should tighten,
        -- the change is to gate BOTH staff aggregates (approved_staff and
        -- pending_staff, which exposes applicant identities and is therefore a
        -- slightly broader disclosure) on requireStaffing's predicate
        -- (:42), NOT to move the whole route behind it: the counts on this feed
        -- are load-bearing for every admin surface.
        (SELECT COALESCE(json_agg(json_build_object(
                  'user_id', asr.user_id,
                  'name', COALESCE(acp.display_name, acp.preferred_name, au.email),
                  'position', asr.position
                ) ORDER BY COALESCE(acp.display_name, acp.preferred_name, au.email)), '[]'::json)
           FROM shift_requests asr
           JOIN users au ON au.id = asr.user_id
           LEFT JOIN contractor_profiles acp ON acp.user_id = asr.user_id
          WHERE asr.shift_id = s.id AND asr.status = 'approved' AND asr.dropped_at IS NULL) AS approved_staff,
        -- Who has APPLIED, for the requests chip's hover card. Sibling of
        -- approved_staff above, with three deliberate differences:
        --   * status = 'pending' (an approved person is not an applicant), and
        --     no dropped_at filter, because dropping applies to an approved
        --     assignment and a pending row never carries one. rc.pending_count
        --     filters the same way, and pending_staff must always equal it.
        --   * ORDER BY created_at: this is a QUEUE, and who has waited longest
        --     is the actionable fact. The confirmed card is alphabetical because
        --     it is a roster, which is a different question.
        --   * the role comes from requested_positions, not position, which is
        --     NULL until approval resolves it. Flattened to a display string
        --     here so the client needs no new shape: one role sends its name, an
        --     empty array sends NULL (38 legacy prod rows, the card then shows a
        --     bare name), several send a comma list (never yet seen in prod).
        -- DELIBERATE EXCEPTION to "every reader goes through parsePositionsNeeded":
        -- this flattens in SQL, which handles the flat-string shape only. The
        -- legacy object shape [{position,count}] would render as raw JSON text.
        -- Unreachable for THIS column (its only writer, shifts.approval.js, emits
        -- canonical flat arrays; prod holds only flat arrays and empties), and
        -- doing it here is what lets StaffHoverCard stay untouched. If that ever
        -- stops being true, move the flatten to the client and use the parser.
        -- The ORDER BY carries a psr.id tiebreak because dev rows share a
        -- created_at and the list would otherwise be nondeterministic there.
        -- IS JSON ARRAY is a CRASH GUARD, the same one openSlotsSql carries:
        -- one legacy row holding a non-array would raise and 500 this whole feed.
        -- Aliases psr/pu/pcp: the outer query owns u and approved_staff owns a*.
        (SELECT COALESCE(json_agg(json_build_object(
                  'user_id', psr.user_id,
                  'name', COALESCE(pcp.display_name, pcp.preferred_name, pu.email),
                  'position', NULLIF(
                    (SELECT string_agg(elem, ', ' ORDER BY ord)
                       FROM jsonb_array_elements_text(
                              CASE WHEN psr.requested_positions IS JSON ARRAY
                                   THEN psr.requested_positions::jsonb
                                   ELSE '[]'::jsonb END
                            ) WITH ORDINALITY AS t(elem, ord)),
                    '')
                ) ORDER BY psr.created_at, psr.id), '[]'::json)
           FROM shift_requests psr
           JOIN users pu ON pu.id = psr.user_id
           LEFT JOIN contractor_profiles pcp ON pcp.user_id = psr.user_id
          WHERE psr.shift_id = s.id AND psr.status = 'pending') AS pending_staff,
${planQueueSql.select}
      FROM shifts s
      LEFT JOIN users u ON u.id = s.created_by
      LEFT JOIN proposals p ON p.id = s.proposal_id
      LEFT JOIN service_packages spk ON spk.id = p.package_id
      LEFT JOIN clients c ON c.id = p.client_id${planQueueSql.drinkPlanJoin}${planQueueSql.consultJoin}
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE sr.status != 'denied') AS request_count,
               COUNT(*) FILTER (WHERE sr.status = 'approved' AND sr.dropped_at IS NULL) AS approved_count,
               COUNT(*) FILTER (WHERE sr.status = 'pending') AS pending_count
        FROM shift_requests sr WHERE sr.shift_id = s.id
      ) rc ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb) AS approved_by_role
        FROM (SELECT position, COUNT(*) c FROM shift_requests
              WHERE shift_id = s.id AND status = 'approved' AND dropped_at IS NULL
                AND position IS NOT NULL
              GROUP BY position) g
      ) abr ON true
  `;
}

// The phone Events list (spec 2026-08-13-mobile-admin section 4, amended
// 2026-09-15 and 2026-09-18). Pages by EVENT (proposal, or the shift itself
// when manual) so a two-shift wedding never splits across pages. $1 offset in
// events, $2 limit in events, $3 needs_staff boolean.
//
// `needs_staff` is the unstaffed_events badge predicate from
// routes/admin/settings.js: both are "not finished, open, and openSlotsSql > 0",
// the staffing rule BY ROLE (server/utils/positionsNeeded.js), so an extra
// bartender never hides an open barback slot and the chip agrees with the card
// (lane staffing-rule-by-role, 2026-09-30). shifts.adminScoped.test.js pins the
// two to the same rows. The chip keeps whole events: a flagged shift pulls its
// siblings along.
//
// It carries its OWN end-instant term rather than leaning on the scope's WHERE,
// so the flag means "staffing is still possible" in every scope it is read in.
// Without it the predicate silently changed meaning on Past (where nothing
// supplies the guard) to "was never fully staffed", and 24 finished dev rows
// came back flagged beside an envelope reporting needs_staff_events: 0.
// Scope-independent is the whole point: the flag travels with the row.
//
// Bucket law: every shift is in exactly one scope. Upcoming = not finished
// (the end instant, never a calendar day) and live. Past = finished, or
// cancelled, or archived, whatever the date, which is where the muted
// Cancelled card lives.
// COALESCEd to a real boolean, never NULL: a NULL s.status would otherwise ship
// needs_staff: null and every client truthiness check would quietly disagree
// with the badge. openSlotsSql owns the roster parsing, including the
// IS JSON ARRAY crash guard; a NULL, malformed or empty roster is one slot, the
// client's neededCount law.
const NEEDS_STAFF_SQL = `COALESCE((${shiftNotFinishedSql('s', 'p')}
      AND s.status = 'open'
      AND ${openSlotsSql('s')} > 0), false)`;

function adminScopedShiftsSql(scope) {
  const upcoming = scope === 'upcoming';
  // COALESCE on BOTH statuses: a bare s.status <> 'cancelled' is NULL, not
  // true, on a NULL-status shift, so such a row would fall out of Upcoming and
  // out of Past and vanish from the phone entirely. Every shift lands in
  // exactly one bucket, including the ones with no status at all.
  const scopeWhere = upcoming
    ? `${shiftNotFinishedSql('s', 'p')} AND COALESCE(s.status, '') <> 'cancelled' AND COALESCE(p.status, '') <> 'archived'`
    : `(${shiftFinishedSql('s', 'p')} OR COALESCE(s.status, '') = 'cancelled' OR COALESCE(p.status, '') = 'archived')`;
  // Rank on the EVENT's own date, not the row's. A proposal whose shifts sit on
  // two dates would otherwise take two ranks: the event would split across
  // pages and MAX(event_rank) would exceed COUNT(DISTINCT event_key), drifting
  // has_more and next_offset. event_first_date/event_last_date are functions of
  // event_key, so every shift of an event shares one rank.
  const rankOrder = upcoming
    ? 'event_first_date ASC, event_key ASC'
    : 'event_last_date DESC, event_key DESC';
  // Inside one event the rows run in DATE order before start_time, so a
  // multi-date card reads forwards on Upcoming and backwards on Past. Load
  // bearing: eventCards takes the card's date from its first row, so a card
  // whose rows arrived start_time-first would be dated by whichever shift
  // happened to start earliest rather than by when the event begins.
  const dateOrder = upcoming ? 'ASC' : 'DESC';
  const extra = `
        COALESCE('p' || s.proposal_id::text, 's' || s.id::text) AS event_key,
        ${NEEDS_STAFF_SQL} AS needs_staff,
        -- Phone-only (Dallas, 2026-09-24): the card's town line reads the
        -- proposal's structured venue. Spliced here, not into the base
        -- projection, so the legacy bare array stays pinned without them.
        p.venue_city,
        p.venue_state,`;
  return `
    WITH base AS (
      ${adminShiftsSelectSql(extra)}
      WHERE ${scopeWhere}
    ), scoped AS (
      SELECT base.*,
             MIN(event_date) OVER (PARTITION BY event_key) AS event_first_date,
             MAX(event_date) OVER (PARTITION BY event_key) AS event_last_date
        FROM base
       WHERE $3::boolean IS NOT TRUE
          OR event_key IN (SELECT event_key FROM base WHERE needs_staff)
    ), ranked AS (
      SELECT scoped.*, DENSE_RANK() OVER (ORDER BY ${rankOrder}) AS event_rank FROM scoped
    ), totals AS (
      SELECT COUNT(DISTINCT event_key) AS scope_events,
             COUNT(DISTINCT event_key) FILTER (WHERE needs_staff) AS needs_staff_events
        FROM base
    )
    -- Driven FROM totals, which is one row whatever base holds, with the page
    -- LEFT JOINed on. An EMPTY page therefore still returns exactly one row
    -- carrying the totals and NULL for every shift column, instead of no rows
    -- at all. That matters at offset 0: the chip with nothing needing staff
    -- makes scoped empty, and totals read off an empty result would report a
    -- scope of zero events on a full calendar, which is the one state the
    -- "Fully staffed" screen has to tell apart from an empty scope. The route
    -- drops the placeholder by filtering on a NULL id.
    SELECT ranked.*,
           totals.scope_events,
           totals.needs_staff_events,
           (SELECT MAX(event_rank) FROM ranked) AS total_events
      FROM totals
      LEFT JOIN ranked ON ranked.event_rank > $1 AND ranked.event_rank <= $1 + $2
     ORDER BY ranked.event_rank ASC NULLS LAST,
              ranked.event_date ${dateOrder} NULLS LAST,
              ranked.start_time ASC NULLS LAST,
              ranked.id ASC NULLS LAST
  `;
}

module.exports = {
  STAFF_OPEN_SHIFTS_SQL, USER_EVENTS_SQL, barRequiredSql, planQueueSql,
  adminShiftsSelectSql, adminScopedShiftsSql,
};
