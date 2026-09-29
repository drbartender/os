'use strict';

// Seniority and proximity facts for the staffing surfaces (spec
// 2026-08-13-mobile-admin section 3, design-session decisions of 2026-09-15):
// how many events a person has worked and how far their home is from a venue,
// shown as plain meta beside an applicant or a picker candidate. Information
// only. Nothing here ranks, sorts or scores; autoAssign.js owns ranking and is
// not a caller.
//
// events_worked has ONE definition and this is its third reader. The other two
// are server/utils/autoAssign.js (step 3) and GET /admin/users/:id/seniority.
// All three count approved, not-dropped requests on shifts dated before the
// CHICAGO business day (never CURRENT_DATE, which is a GMT day and counts
// tonight's shift as worked from 19:00 Chicago), plus the pre-migration
// contractor_profiles.historical_events_worked. It counts SHIFTS: a staffer
// approved on two shifts of one event counts two, in all three readers.
// server/routes/shifts.staffingMeta.test.js pins this reader to the seniority
// route so the three cannot drift silently.
const { pool } = require('../db');
const { chicagoTodayYmd } = require('./businessTime');
const { milesBetween } = require('./serviceArea');

function cleanIds(userIds) {
  return [...new Set((userIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

// WHOLE miles, on purpose. The picker returns a distance for EVERY active
// staffer against ANY shift, and the phone stores what it reads. At a tenth of
// a mile, ten venues place a home within about two hundred feet; at a whole
// mile the same ten give about four tenths of a mile. Dallas staffs on
// proximity, not on a tenth of a mile. The two legacy reads keep roundMiles
// (a tenth) for requesters, as the desktop has always shown them.
function wholeMiles(miles) {
  if (miles === null || miles === undefined) return null;
  const n = Number(miles);
  return Number.isFinite(n) ? Math.round(n) : null;
}

/** Map of user id -> events worked. A user with no profile and no shifts maps to 0. */
async function loadEventsWorked(userIds, db = pool) {
  const ids = cleanIds(userIds);
  if (ids.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT u.id AS user_id,
            COALESCE(cp.historical_events_worked, 0) + COALESCE(w.live, 0) AS events_worked
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
       LEFT JOIN (
         SELECT sr.user_id, COUNT(*)::int AS live
           FROM shift_requests sr
           JOIN shifts s ON s.id = sr.shift_id
          WHERE sr.user_id = ANY($1::int[])
            AND sr.status = 'approved'
            AND sr.dropped_at IS NULL
            AND s.event_date < $2::date
          GROUP BY sr.user_id
       ) w ON w.user_id = u.id
      WHERE u.id = ANY($1::int[])`,
    [ids, chicagoTodayYmd()]
  );
  return new Map(rows.map((r) => [Number(r.user_id), Number(r.events_worked)]));
}

/** The venue of one shift ({ id, lat, lng }), or null when there is no such shift. */
async function loadShiftVenue(shiftId, db = pool) {
  const { rows } = await db.query('SELECT id, lat, lng FROM shifts WHERE id = $1', [shiftId]);
  return rows[0] || null;
}

/**
 * Picker meta for one shift: for each user id, the events-worked count and the
 * distance, in whole miles, from that person's home to THIS shift's venue
 * (`shift` is the row loadShiftVenue returns; the route reads it beside its
 * staff list, so a shift that does not exist is a 404 one round earlier). The
 * raw home coordinates are read here and never returned.
 */
async function candidateMeta(shift, userIds, db = pool) {
  const ids = cleanIds(userIds);
  const out = new Map();
  if (ids.length === 0) return out;
  const [worked, homes] = await Promise.all([
    loadEventsWorked(ids, db),
    db.query('SELECT user_id, lat, lng FROM contractor_profiles WHERE user_id = ANY($1::int[])', [ids]),
  ]);
  const homeBy = new Map(homes.rows.map((h) => [Number(h.user_id), h]));
  for (const id of ids) {
    const home = homeBy.get(id);
    out.set(id, {
      events_worked: worked.get(id) ?? 0,
      home_distance_miles: home ? wholeMiles(milesBetween(home.lat, home.lng, shift.lat, shift.lng)) : null,
    });
  }
  return out;
}

module.exports = { loadEventsWorked, loadShiftVenue, candidateMeta, wholeMiles };
