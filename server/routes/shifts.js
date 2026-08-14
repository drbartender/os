const express = require('express');
const { pool } = require('../db');
const { auth, requireOnboarded } = require('../middleware/auth');
const { geocodeAddress } = require('../utils/geocode');
const { autoAssignShift } = require('../utils/autoAssign');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError, PermissionError, ConflictError } = require('../utils/errors');
const { findOrCreateClient } = require('../utils/clientDedup');
const { suppressBeoNudgesForStaffers } = require('../utils/beoHandlers');
const { logAdminAction } = require('../utils/adminAuditLog');
const { chicagoTodayYmd } = require('../utils/businessTime');
// THE shift-visibility predicate. See server/utils/shiftEndInstant.js.
const { shiftNotFinishedSql } = require('../utils/shiftEndInstant');
// Out-of-Area Bonus: bands, distances, lock lifecycle, duty re-derivation.
// The bands are server-only by design (spec §6 published-ambiguity rule), so
// the payloads below carry derived cents and the client never computes one.
const {
  OUT_OF_AREA_MAX_CENTS,
  suggestOutOfAreaCents,
  milesFromHomeBase,
  milesBetween,
  roundMiles,
  stampOutOfAreaLock,
  releaseOutOfAreaLock,
  reaccrueDutyForProposal,
} = require('../utils/serviceArea');
const { STAFF_OPEN_SHIFTS_SQL, USER_EVENTS_SQL, barRequiredSql } = require('./shifts.queries');
// Request -> approval money seam extracted to keep this file under the 1000-line
// hard cap. shifts.js still owns the route table + shared middleware; the bulky
// handler bodies (and position resolution) live in shifts.approval.js.
const { requestShiftHandler, assignShiftHandler, approveOrDenyRequestHandler } = require('./shifts.approval');
// Shift-lifecycle mutation bodies (PUT /:id, POST /:id/cancel-or-unassign)
// extracted to shifts.handlers.js under the same size-cap pressure; shifts.js
// keeps the route table + shared middleware.
const { updateShiftHandler, cancelOrUnassignShiftHandler } = require('./shifts.handlers');

const router = express.Router();

// ─── Permission helpers ────────────────────────────────────────────

/** Admin or manager with can_staff permission */
function requireStaffing(req, res, next) {
  if (req.user.role === 'admin') return next();
  if (req.user.role === 'manager' && req.user.can_staff) return next();
  return next(new PermissionError('Staffing access required.'));
}

// requireOnboarded now lives in middleware/auth.js — every staff-data surface
// needs it, not just this file (see the note there).

// ─── Out-of-Area helpers ──────────────────────────────────────────

/**
 * Server-derived out-of-area context for a shift row. `suggested_bonus_cents`
 * is computed HERE and only here: the bands are internal guidance (spec §6
 * published ambiguity) and the CRA bundle is shared with the public marketing
 * site, so no band number may ever reach the browser as a literal.
 *
 * A venue with no coordinates yields nulls, which correctly disables the
 * suggestion rather than guessing at a city centroid.
 */
function withOutOfAreaContext(shift, approvedCount = 0) {
  const miles = milesFromHomeBase(shift.lat, shift.lng);
  const approved = Number(approvedCount || 0);
  return {
    ...shift,
    // Normalized (pg COUNT arrives as a string) and always present, including on
    // the PATCH response where the row is a bare SELECT * with no aggregate.
    // The knob words its unlocked warning off this: one approved staffer is a
    // one-click fix, two or more needs a decision.
    approved_count: approved,
    venue_distance_miles: roundMiles(miles),
    suggested_bonus_cents: suggestOutOfAreaCents(miles),
    // Money attached but nobody holding it. The duty line derives from
    // out_of_area_locked_user_id, so an unlocked bonus on a shift that ALREADY
    // has approved staff pays nobody and does it silently. Reachable two ways:
    // the amount was attached while 2+ staffers were approved (ambiguous, no
    // auto-lock), or the holder dropped and left a teammate behind. Either way
    // the admin has to act, so the surfaces say so.
    unlocked_warning: shift.out_of_area_bonus_cents !== null
      && shift.out_of_area_bonus_cents !== undefined
      && !shift.out_of_area_locked_at
      && approved >= 1,
  };
}

/**
 * Attach `home_distance_miles` (the requester's home to this venue) and DROP
 * the raw home coordinates from the row. Admins and `can_staff` managers see
 * the derived distance beside approvals; nobody sees a staffer's home address.
 * Null whenever either side lacks coordinates.
 */
function withHomeDistance(row, shift) {
  const { staff_lat, staff_lng, ...rest } = row;
  return {
    ...rest,
    home_distance_miles: roundMiles(milesBetween(staff_lat, staff_lng, shift.lat, shift.lng)),
  };
}

// ─── Staff-facing routes ──────────────────────────────────────────

/** GET /shifts — open upcoming shifts for staff; all shifts for admin/manager */
router.get('/', auth, requireOnboarded, asyncHandler(async (req, res) => {
  const isManager = req.user.role === 'admin' || req.user.role === 'manager';

  if (isManager) {
    const result = await pool.query(`
      SELECT s.*,
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
        abr.approved_by_role
      FROM shifts s
      LEFT JOIN users u ON u.id = s.created_by
      LEFT JOIN proposals p ON p.id = s.proposal_id
      LEFT JOIN service_packages spk ON spk.id = p.package_id
      LEFT JOIN clients c ON c.id = p.client_id
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
      ORDER BY s.event_date ASC
      LIMIT 500
    `);
    return res.json(result.rows);
  }

  // Staff path. SQL extracted to ./shifts.queries to keep this file under
  // the 1000-line hard cap. Projection: own request status + BEO ack +
  // drink plan finalize + cover-request flag and requester's first initial.
  const result = await pool.query(STAFF_OPEN_SHIFTS_SQL, [req.user.id]);
  res.json(result.rows);
}));

/** GET /shifts/unstaffed-upcoming — admin-facing list of upcoming shifts that
 *  still need staffing. Smaller than the full /shifts dump and pre-filtered
 *  server-side so the AssignToEventModal can render without fetching ~500 rows.
 *  Uses the same `positions_needed::jsonb` pattern as admin.js badge-counts;
 *  the schema migration normalized every row to a valid JSON array, so the
 *  cast is safe in practice.
 *
 *  approved_by_role mirrors the aggregate on the admin GET / feed above. The
 *  modal needs per-role fill, not just a flat count, to preselect the position
 *  of an actually-open slot on a mixed roster.
 *
 *  It sums to approved_count for every row every write path can produce, but
 *  not by construction: approved_count does not filter `position IS NOT NULL`.
 *  An approved-and-active row with a NULL position would be counted there and
 *  dropped here. No such row exists (every approve path stamps a canonical
 *  role) and no CHECK enforces it, so treat a mismatch as a data alarm.
 *
 *  `AND position IS NOT NULL` is a CRASH GUARD, not tidying: jsonb_object_agg
 *  throws on a NULL key, and the surrounding COALESCE cannot catch it because
 *  the aggregate raises before returning. Drop that filter and one NULL-position
 *  approved row 500s this whole endpoint. Same in all copies of this aggregate.
 *
 *  "Upcoming" is "has not finished yet" — the shift's END INSTANT
 *  (server/utils/shiftEndInstant.js), never a calendar day. This list feeds
 *  AssignToEventModal, so under the old `event_date >= CURRENT_DATE` (the GMT
 *  day) a short-staffed shift starting at 20:00 was invisible to whoever was
 *  covering a no-show at 19:01.
 *
 *  THE BADGE COUNTS THIS LIST. `unstaffed_events` in
 *  routes/admin/settings.js badge-counts is the COUNT for exactly these rows
 *  and uses the SAME imported fragment. A count and the list it counts sharing
 *  one predicate is not tidiness — the two drifting apart, with comments in
 *  both claiming they mirrored each other, is what broke the round this
 *  replaces. Change one, change both, in the same commit. */
router.get('/unstaffed-upcoming', auth, requireStaffing, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT s.id, s.event_date, s.start_time, s.end_time, s.location, s.guest_count,
           s.event_type, s.event_type_custom, s.positions_needed, s.proposal_id,
           COALESCE(c.name, s.client_name) AS client_name,
           rc.request_count,
           rc.approved_count,
           abr.approved_by_role
    FROM shifts s
    LEFT JOIN proposals p ON p.id = s.proposal_id
    LEFT JOIN clients c ON c.id = p.client_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE sr.status != 'denied') AS request_count,
             COUNT(*) FILTER (WHERE sr.status = 'approved' AND sr.dropped_at IS NULL) AS approved_count
      FROM shift_requests sr WHERE sr.shift_id = s.id
    ) rc ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb) AS approved_by_role
      FROM (SELECT position, COUNT(*) c FROM shift_requests
            WHERE shift_id = s.id AND status = 'approved' AND dropped_at IS NULL
              AND position IS NOT NULL
            GROUP BY position) g
    ) abr ON true
    WHERE s.status = 'open'
      AND ${shiftNotFinishedSql('s', 'p')}
      AND s.positions_needed IS JSON ARRAY
      AND rc.approved_count
          < jsonb_array_length(CASE WHEN s.positions_needed IS JSON ARRAY THEN s.positions_needed::jsonb ELSE '[]'::jsonb END)
    ORDER BY s.event_date ASC, s.start_time ASC
    LIMIT 200
  `);
  res.json(result.rows);
}));

/** GET /shifts/user/:userId/events — event history for a user (staff or admin) */
router.get('/user/:userId/events', auth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (isNaN(userId)) throw new ValidationError({ userId: 'Invalid user ID.' });

  // Staff can only view their own events; admin/manager can view anyone's
  const isManager = req.user.role === 'admin' || req.user.role === 'manager';
  if (!isManager && req.user.id !== userId) {
    throw new PermissionError('Access denied.');
  }

  // Task 28: SQL extracted to ./shifts.queries; projection adds payout_id
  // for deep-linking each past row into a payout breakdown.
  const result = await pool.query(USER_EVENTS_SQL, [userId]);

  // "Today" is the CHICAGO business day, not the server's UTC day. Render runs
  // UTC, so new Date().toISOString().slice(0,10) rolled over at 7pm Chicago and
  // bucketed a shift starting in 30 minutes as PAST.
  const today = chicagoTodayYmd();
  // event_date is a bare SQL DATE (schema.sql:306), which pg builds at LOCAL
  // midnight — toISOString() recovers the same calendar day on any machine at
  // or west of UTC (Render is UTC, the dev box is Chicago), so this stays
  // correct. It would shift a day early only on a process timezone EAST of UTC,
  // which this deployment never runs; deliberately left alone here.
  const getDateStr = (d) => {
    if (!d) return null;
    if (typeof d === 'string') return d.slice(0, 10);
    return d.toISOString().slice(0, 10);
  };
  const upcoming = result.rows
    .filter(r => { const ds = getDateStr(r.event_date); return ds && ds >= today; })
    .sort((a, b) => new Date(a.event_date) - new Date(b.event_date));
  const past = result.rows
    .filter(r => { const ds = getDateStr(r.event_date); return !ds || ds < today; });

  res.json({ upcoming, past });
}));

/** GET /shifts/my-requests — current user's shift history (with team for approved) */
router.get('/my-requests', auth, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT sr.*, s.event_type, s.event_type_custom, s.client_name,
           s.event_date, s.start_time, s.end_time, s.location,
           s.setup_minutes_before, s.status AS shift_status
    FROM shift_requests sr
    JOIN shifts s ON s.id = sr.shift_id
    WHERE sr.user_id = $1
    ORDER BY s.event_date DESC
    LIMIT 500
  `, [req.user.id]);

  const requests = result.rows;

  // Fetch approved teammates for shifts where this user is approved
  const approvedShiftIds = requests
    .filter(r => r.status === 'approved')
    .map(r => r.shift_id);

  let teamsMap = new Map();
  if (approvedShiftIds.length > 0) {
    const teamRes = await pool.query(`
      SELECT sr.shift_id, sr.user_id, sr.position,
        COALESCE(cp.display_name, cp.preferred_name, u.email) AS name
      FROM shift_requests sr
      JOIN users u ON u.id = sr.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE sr.shift_id = ANY($1) AND sr.status = 'approved' AND sr.dropped_at IS NULL
      ORDER BY name ASC
    `, [approvedShiftIds]);

    for (const row of teamRes.rows) {
      if (!teamsMap.has(row.shift_id)) teamsMap.set(row.shift_id, []);
      teamsMap.get(row.shift_id).push(row);
    }
  }

  // Attach team to each request, moving current user to top
  const enriched = requests.map(r => {
    const team = teamsMap.get(r.shift_id) || [];
    // Move current user to top of list
    const sorted = [...team];
    const myIdx = sorted.findIndex(t => t.user_id === req.user.id);
    if (myIdx > 0) {
      const [me] = sorted.splice(myIdx, 1);
      sorted.unshift(me);
    }
    return { ...r, team: r.status === 'approved' ? sorted : [] };
  });

  res.json(enriched);
}));

/** GET /shifts/by-proposal/:proposalId — return every shift attached to a
 *  proposal as an array. A single proposal can spawn multiple shifts
 *  (e.g. multi-day events). Avoids the EventDetailPage shipping the full
 *  /shifts list to the browser just to filter for one proposal.
 *  LIMIT 100 is defensive — a single event with >100 shifts is unheard of,
 *  but it bounds the worst case if a future bug ever creates a runaway loop. */
router.get('/by-proposal/:proposalId', auth, requireStaffing, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT s.*,
      rc.request_count,
      rc.approved_count,
      (SELECT COALESCE(json_agg(json_build_object(
                'user_id', sr.user_id,
                'name', COALESCE(cp.display_name, cp.preferred_name, u.email),
                'beo_acknowledged_at', sr.beo_acknowledged_at
              ) ORDER BY COALESCE(cp.display_name, cp.preferred_name, u.email)), '[]'::json)
         FROM shift_requests sr
         JOIN users u ON u.id = sr.user_id
         LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
        WHERE sr.shift_id = s.id AND sr.status = 'approved' AND sr.dropped_at IS NULL) AS approved_staff,
      -- Every live requester (pending + approved), carrying the home
      -- coordinates the route converts to home_distance_miles and then
      -- strips. Denied rows are excluded: they are not candidates to weigh.
      (SELECT COALESCE(json_agg(json_build_object(
                'request_id', sr.id,
                'user_id', sr.user_id,
                'name', COALESCE(cp.display_name, cp.preferred_name, u.email),
                'status', sr.status,
                'position', sr.position,
                'dropped_at', sr.dropped_at,
                'staff_lat', cp.lat,
                'staff_lng', cp.lng
              ) ORDER BY sr.created_at), '[]'::json)
         FROM shift_requests sr
         JOIN users u ON u.id = sr.user_id
         LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
        WHERE sr.shift_id = s.id AND sr.status <> 'denied') AS requesters,
      abr.approved_by_role
    FROM shifts s
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE sr.status != 'denied') AS request_count,
             COUNT(*) FILTER (WHERE sr.status = 'approved' AND sr.dropped_at IS NULL) AS approved_count
      FROM shift_requests sr WHERE sr.shift_id = s.id
    ) rc ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(jsonb_object_agg(position, c), '{}'::jsonb) AS approved_by_role
      FROM (SELECT position, COUNT(*) c FROM shift_requests
            WHERE shift_id = s.id AND status = 'approved' AND dropped_at IS NULL
              AND position IS NOT NULL
            GROUP BY position) g
    ) abr ON true
    WHERE s.proposal_id = $1
    ORDER BY s.event_date ASC, s.start_time ASC, s.id ASC
    LIMIT 100
  `, [req.params.proposalId]);
  res.json(result.rows.map((s) => ({
    ...withOutOfAreaContext(s, s.approved_count),
    requesters: (Array.isArray(s.requesters) ? s.requesters : []).map((r) => withHomeDistance(r, s)),
  })));
}));

/** GET /shifts/detail/:id — single shift details (admin/manager only) */
router.get('/detail/:id', auth, requireStaffing, asyncHandler(async (req, res) => {
  // Shift and its requests are independent lookups — Promise.all saves a round-trip.
  const [result, reqResult] = await Promise.all([
    pool.query(`
      SELECT s.*,
        COALESCE(c.name, s.client_name) AS client_name,
        COALESCE(c.phone, s.client_phone) AS client_phone,
        COALESCE(c.email, s.client_email) AS client_email,
        c.id AS client_id,
        p.total_price AS proposal_total,
        p.token AS proposal_token,
        rc.request_count,
        rc.approved_count
      FROM shifts s
      LEFT JOIN proposals p ON p.id = s.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*) FILTER (WHERE sr.status != 'denied') AS request_count,
               COUNT(*) FILTER (WHERE sr.status = 'approved' AND sr.dropped_at IS NULL) AS approved_count
        FROM shift_requests sr WHERE sr.shift_id = s.id
      ) rc ON true
      WHERE s.id = $1
    `, [req.params.id]),
    pool.query(`
      SELECT sr.*,
        COALESCE(cp.display_name, cp.preferred_name, u.email) AS staff_name,
        u.email AS staff_email,
        cp.city AS staff_city,
        cp.reliable_transportation AS staff_reliable_transportation,
        -- Converted to home_distance_miles and stripped before the response.
        cp.lat AS staff_lat,
        cp.lng AS staff_lng
      FROM shift_requests sr
      JOIN users u ON u.id = sr.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE sr.shift_id = $1
      ORDER BY sr.status ASC, sr.created_at ASC
    `, [req.params.id]),
  ]);
  if (!result.rows[0]) throw new NotFoundError('Shift not found.');

  const shift = result.rows[0];
  res.json({
    shift: withOutOfAreaContext(shift, shift.approved_count),
    requests: reqResult.rows.map((r) => withHomeDistance(r, shift)),
  });
}));

/**
 * PATCH /shifts/:id/out-of-area — attach, raise, lower, or clear the
 * Out-of-Area Bonus on a shift (spec §6). Body: `{ amount_cents: int|null }`,
 * cents, `0 < amount <= 25000` (the DB CHECK carries the same bound); null
 * clears an UNLOCKED bonus.
 *
 * THE LOCK IS THE WHOLE POINT: once a staffer's request is approved while a
 * bonus is attached, that staffer took the shift on that number. From then on
 * the amount may only go UP. Any reduce or clear is a 409 — the money is not
 * negotiable after acceptance, which is exactly why the $250 cap exists.
 *
 * Access is `requireStaffing` (admin + `can_staff` managers), matching every
 * other staffing surface in this file.
 */
router.patch('/:id/out-of-area', auth, requireStaffing, asyncHandler(async (req, res) => {
  const shiftId = parseInt(req.params.id, 10);
  if (!Number.isInteger(shiftId) || shiftId <= 0) {
    throw new ValidationError({ id: 'Invalid shift id.' });
  }

  const raw = req.body ? req.body.amount_cents : undefined;
  let amountCents = null;
  if (raw !== null && raw !== undefined && raw !== '') {
    amountCents = Number(raw);
    if (!Number.isInteger(amountCents) || amountCents <= 0 || amountCents > OUT_OF_AREA_MAX_CENTS) {
      throw new ValidationError({
        amount_cents: `Enter a bonus between $0.01 and $${OUT_OF_AREA_MAX_CENTS / 100}.`,
      });
    }
  }

  const dbClient = await pool.connect();
  let updated, priorCents, proposalId, newlyLocked = false, approvedCount = 0, noOp = false;
  try {
    await dbClient.query('BEGIN');
    // FOR UPDATE so a concurrent approval cannot stamp the lock between the
    // guard read and the write (that race is exactly a silent reduction).
    const cur = await dbClient.query(
      `SELECT id, proposal_id, out_of_area_bonus_cents, out_of_area_locked_at
         FROM shifts WHERE id = $1 FOR UPDATE`,
      [shiftId]
    );
    if (!cur.rows[0]) throw new NotFoundError('Shift not found.');
    const shift = cur.rows[0];
    proposalId = shift.proposal_id;
    priorCents = shift.out_of_area_bonus_cents === null ? null : Number(shift.out_of_area_bonus_cents);

    if (shift.out_of_area_locked_at) {
      const isClear = amountCents === null;
      const isReduce = priorCents !== null && amountCents !== null && amountCents < priorCents;
      if (isClear || isReduce) {
        // Surfaced verbatim as the knob's inline error, so it has to read like
        // a sentence to a human, not a status code.
        throw new ConflictError(
          'This bonus is locked to an approved staffer and can only change after they drop.',
          'bonus_locked'
        );
      }
    }

    // Always counted, so the response can carry approved_count and the knob can
    // word its warning for the actual situation.
    const approved = await dbClient.query(
      `SELECT user_id FROM shift_requests
        WHERE shift_id = $1 AND status = 'approved' AND dropped_at IS NULL`,
      [shiftId]
    );
    approvedCount = approved.rowCount;

    // Attaching a bonus to a shift that is ALREADY staffed must not silently
    // never pay. The lock normally stamps at approval, but here approval has
    // already happened, so stamp it now for the one unambiguous case: exactly
    // one approved, non-dropped worker. That staffer is the shift, so there is
    // nothing to guess. With 2+ approved the choice is a judgment call, so we
    // leave it unlocked and the payload's unlocked_warning tells the admin.
    // This is also the escape hatch the knob offers for an already-warned
    // shift: a same-value re-save exists only to run this stamp.
    const canAutoLock = amountCents !== null && !shift.out_of_area_locked_at && approvedCount === 1;
    const sameValue = priorCents === amountCents;

    if (sameValue) {
      // The bonus is already attached at this exact amount, so the stamp can
      // run without the UPDATE below (its WHERE only needs a non-null bonus).
      if (canAutoLock) {
        newlyLocked = await stampOutOfAreaLock(dbClient, shiftId, approved.rows[0].user_id);
      }
      if (!newlyLocked) {
        // TRUE no-op: the amount did not move and nothing stamped (e.g. the
        // 2+-approved warning, where auto-lock is refused by design). Writing
        // here would only rewrite out_of_area_attached_by/_attached_at to
        // whoever clicked and log a from==to audit row, so skip the UPDATE,
        // the audit, and the re-accrue and answer with the row as it stands.
        const reread = await dbClient.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
        updated = reread.rows[0];
        noOp = true;
      }
    }

    if (!noOp) {
      const upd = await dbClient.query(
        `UPDATE shifts
            SET out_of_area_bonus_cents = $2::int,
                out_of_area_attached_by = CASE WHEN $2::int IS NULL THEN NULL ELSE $3::int END,
                out_of_area_attached_at = CASE WHEN $2::int IS NULL THEN NULL ELSE NOW() END
          WHERE id = $1
          RETURNING *`,
        [shiftId, amountCents, req.user.id]
      );
      updated = upd.rows[0];
      // Amount-changed path: the bonus may only just now exist, so the stamp
      // runs AFTER the UPDATE (same-value + stamped ran it above, and the
      // RETURNING * there already carries the fresh lock columns).
      if (!sameValue && canAutoLock) {
        newlyLocked = await stampOutOfAreaLock(dbClient, shiftId, approved.rows[0].user_id);
        const reread = await dbClient.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
        updated = reread.rows[0];
      }
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    dbClient.release();
  }

  if (!noOp) {
    // Audit + re-derivation run AFTER the pooled client is back in the pool
    // (one pooled connection per request): logAdminAction takes its own.
    await logAdminAction({
      actorUserId: req.user.id,
      action: 'shift_out_of_area_set',
      metadata: {
        shift_id: shiftId,
        proposal_id: proposalId,
        from_cents: priorCents,
        to_cents: amountCents,
        locked: !!updated.out_of_area_locked_at,
        newly_locked: newlyLocked,
      },
    });
    // A raise on a locked, already-accrued shift must propagate to the duty line;
    // pre-event shifts are not completed, so this no-ops after one cheap SELECT.
    // `newlyLocked` is part of the gate because the escape hatch above is a
    // SAME-VALUE save: the amount did not move, but the money just became payable
    // to a specific person, and without this the duty line would sit unwritten
    // until some unrelated accrual happened to run.
    if (proposalId && (priorCents !== amountCents || newlyLocked)) reaccrueDutyForProposal(proposalId);
  }

  res.json({ shift: withOutOfAreaContext(updated, approvedCount) });
}));

/** POST /shifts/:id/request — staff requests to work a shift (ranked roles +
 *  transport ack). Position is resolved at approval, not here. See
 *  shifts.approval.js. */
router.post('/:id/request', auth, requireOnboarded, asyncHandler(requestShiftHandler));

/** DELETE /shifts/requests/:requestId — staff withdraws their own request
 *  (pending-only); admin/manager can delete any status. */
router.delete('/requests/:requestId', auth, asyncHandler(async (req, res) => {
  const isManager = req.user.role === 'admin' || req.user.role === 'manager';
  const pre = await pool.query(
    `SELECT sr.user_id, sr.status, sr.shift_id, s.proposal_id
       FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id WHERE sr.id = $1`,
    [req.params.requestId]
  );
  const ctx = pre.rows[0];
  if (!ctx) throw new NotFoundError('Request not found.');
  if (!isManager) {
    if (ctx.user_id !== req.user.id) throw new PermissionError('You can only withdraw your own shift requests.');
    if (ctx.status === 'approved') throw new ConflictError('This request is already approved. Use Drop, Request Cover, or Emergency Drop instead.', 'already_approved');
    if (ctx.status === 'denied') throw new ConflictError('This request was already denied.', 'already_denied');
  }
  const result = isManager
    ? await pool.query('DELETE FROM shift_requests WHERE id = $1 RETURNING id', [req.params.requestId])
    : await pool.query('DELETE FROM shift_requests WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.requestId, req.user.id]);
  if (!result.rows[0]) throw new NotFoundError('Request not found.');
  // Out-of-Area lock: this is the ShiftDrawer "Remove" button, the primary way
  // an admin takes someone off a shift. The request row is DELETED outright, so
  // without this the bonus would stay frozen to a person with no request at all
  // and the duty line would pay them for a shift they never worked.
  if (await releaseOutOfAreaLock(pool, ctx.shift_id, ctx.user_id)) {
    reaccrueDutyForProposal(ctx.proposal_id);
  }
  if (ctx.proposal_id) {
    await suppressBeoNudgesForStaffers(ctx.proposal_id, [ctx.user_id], pool, 'staffer_unassigned: request deleted');
  }
  res.json({ success: true });
}));

// ─── Admin / Staffing manager routes ─────────────────────────────

/** POST /shifts — create a new shift */
router.post('/', auth, requireStaffing, asyncHandler(async (req, res) => {
  const { event_type, event_type_custom, event_date, start_time, end_time, location, positions_needed, notes,
          equipment_required, auto_assign_days_before, lat, lng,
          client_name, client_email, client_phone, guest_count, event_duration_hours } = req.body;
  if (!event_date) {
    throw new ValidationError({ event_date: 'Event date is required.' });
  }

  const pgClient = await pool.connect();
  let shift;
  try {
    await pgClient.query('BEGIN');

    // 1. Create or find client record
    let clientId = null;
    if (client_name) {
      clientId = await findOrCreateClient(pgClient, {
        name: client_name, email: client_email, phone: client_phone, source: 'direct',
      });
    }

    // 2. Create a proposal record so the full event detail page works
    const guestCountInt = guest_count ? parseInt(guest_count, 10) : 50;
    const durationFloat = event_duration_hours ? parseFloat(event_duration_hours) : 4;
    const proposalRes = await pgClient.query(`
      INSERT INTO proposals (client_id, event_type, event_type_custom, event_date, event_start_time,
                             event_duration_hours, event_location, guest_count,
                             status, pricing_snapshot, total_price, created_by, admin_notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'confirmed', '{}', 0, $9, $10) RETURNING *
    `, [
      clientId, event_type || null, event_type_custom || null,
      event_date, start_time || null,
      durationFloat, location || null, guestCountInt,
      req.user.id, 'Manually created event — no contract or payment on file.'
    ]);
    const proposal = proposalRes.rows[0];

    // 3. Create the shift linked to the proposal
    const shiftRes = await pgClient.query(`
      INSERT INTO shifts (event_type, event_type_custom, event_date, start_time, end_time, location, positions_needed, notes,
                          equipment_required, auto_assign_days_before, lat, lng, created_by, proposal_id,
                          client_name, client_email, client_phone, guest_count, event_duration_hours)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) RETURNING *
    `, [
      event_type || null, event_type_custom || null,
      event_date,
      start_time || null, end_time || null,
      location || null,
      // A shift always needs at least one bartender. When the caller omits
      // positions_needed (or passes an empty array), default the roster to a
      // single Bartender slot so no new empty-roster rows are created — an
      // empty roster hides the shift from Available and blocks the picker.
      JSON.stringify(
        Array.isArray(positions_needed) && positions_needed.length > 0
          ? positions_needed
          : ['Bartender']
      ),
      notes || null,
      equipment_required ? JSON.stringify(equipment_required) : '[]',
      auto_assign_days_before !== null && auto_assign_days_before !== undefined ? auto_assign_days_before : null,
      lat || null, lng || null,
      req.user.id, proposal.id,
      client_name || null, client_email || null, client_phone || null,
      guestCountInt, durationFloat
    ]);

    await pgClient.query('COMMIT');
    shift = shiftRes.rows[0];
  } catch (err) {
    try { await pgClient.query('ROLLBACK'); } catch (_e) { /* already rolled back */ }
    throw err;
  } finally {
    pgClient.release();
  }

  // Geocode location in background
  if (!lat && !lng && location) {
    geocodeAddress(location)
      .then(coords => {
        if (coords) {
          return pool.query('UPDATE shifts SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, shift.id]);
        }
      })
      .catch(err => console.error('[Shifts] Geocode error:', err.message));
  }

  res.status(201).json(shift);
}));

/** PUT /shifts/:id — update a shift. Body lives in shifts.handlers.js. */
router.put('/:id', auth, requireStaffing, asyncHandler(updateShiftHandler));

/** DELETE /shifts/:id — delete a shift */
router.delete('/:id', auth, requireStaffing, asyncHandler(async (req, res) => {
  // BEO: wrap in a transaction. Capture proposal_id + approved user_ids
  // BEFORE the DELETE (cascade would drop shift_requests rows otherwise),
  // then DELETE, then suppress BEO for staffers with no surviving approved
  // active shift on the proposal (NOT EXISTS guard in the helper).
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const propRow = await dbClient.query('SELECT proposal_id FROM shifts WHERE id = $1', [req.params.id]);
    if (!propRow.rows[0]) throw new NotFoundError('Shift not found.');
    const proposalIdForBeo = propRow.rows[0].proposal_id;
    let userIds = [];
    if (proposalIdForBeo) {
      const u = await dbClient.query(
        `SELECT user_id FROM shift_requests WHERE shift_id = $1 AND status = $2`,
        [req.params.id, 'approved']
      );
      userIds = u.rows.map((r) => r.user_id);
    }
    await dbClient.query('DELETE FROM shifts WHERE id = $1', [req.params.id]);
    if (proposalIdForBeo && userIds.length > 0) {
      await suppressBeoNudgesForStaffers(proposalIdForBeo, userIds, dbClient, 'staffer_unassigned: shift deleted');
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (_e) { /* already rolled back */ }
    throw err;
  } finally {
    dbClient.release();
  }
  res.json({ success: true });
}));

/**
 * POST /shifts/:id/cancel-or-unassign — first-class cancel / unassign action.
 * Body lives in shifts.handlers.js.
 */
router.post('/:id/cancel-or-unassign', auth, requireStaffing, asyncHandler(cancelOrUnassignShiftHandler));

/** POST /shifts/:id/assign — admin manually assigns a staff member.
 *  Requires an explicit canonical position; see shifts.approval.js. */
router.post('/:id/assign', auth, requireStaffing, asyncHandler(assignShiftHandler));

/** GET /shifts/:id/requests — get all requests for a shift */
router.get('/:id/requests', auth, requireStaffing, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT sr.*, u.email, cp.preferred_name, cp.display_name, cp.phone
    FROM shift_requests sr
    JOIN users u ON u.id = sr.user_id
    LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
    WHERE sr.shift_id = $1
    ORDER BY sr.created_at ASC
    LIMIT 500
  `, [req.params.id]);
  res.json(result.rows);
}));

/** PUT /shifts/requests/:requestId — approve or deny a request. On approval,
 *  position is resolved from the staffer's ranked requested_positions or an
 *  admin override (the money seam); see shifts.approval.js. */
router.put('/requests/:requestId', auth, requireStaffing, asyncHandler(approveOrDenyRequestHandler));

/** POST /shifts/:id/auto-assign — run auto-assign algorithm on pending requests */
router.post('/:id/auto-assign', auth, requireStaffing, asyncHandler(async (req, res) => {
  const { dry_run } = req.body;
  // Ensure shift has lat/lng; geocode if missing
  const shiftRes = await pool.query('SELECT id, location, lat, lng FROM shifts WHERE id = $1', [req.params.id]);
  if (!shiftRes.rows[0]) throw new NotFoundError('Shift not found.');

  const shift = shiftRes.rows[0];
  if (shift.lat === null && shift.lng === null && shift.location) {
    const coords = await geocodeAddress(shift.location);
    if (coords) {
      await pool.query('UPDATE shifts SET lat = $1, lng = $2 WHERE id = $3', [coords.lat, coords.lng, shift.id]);
    }
  }

  const result = await autoAssignShift(req.params.id, { dryRun: !!dry_run });
  res.json(result);
}));

module.exports = router;
