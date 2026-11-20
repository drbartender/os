// Upcoming events in a date window, one row per shift with its staffing: the read the Claude connector's events tool calls.
//
// One rule, one copy (spec 2026-11-19 law 4): this runs
// adminScopedShiftsSql('upcoming', { window: true }) from
// server/routes/shifts.queries.js, the query behind the phone Events list
// (GET /shifts?scope=upcoming), with its date window and hold exclusion
// switched on. So the bucket law (not finished by the shift's end instant,
// not cancelled, proposal not archived), the needs-staff flag (NEEDS_STAFF_SQL,
// the badge's predicate) and every column are the phone list's own. Staffing
// comes from the shift rows: positions_needed, approved_by_role,
// approved_count and open_slots (openSlotsSql, positionsNeeded.js), never
// from guest count (money law 10). A hand-made shift with no proposal carries
// the client name typed on the shift (COALESCE(c.name, s.client_name)).
//
// The window is the caller's: start and end are Chicago calendar days
// (YYYY-MM-DD, inclusive, on the shift's event_date); the tool's default and
// its cap are the tools lane's, and this read takes both ends. Rows page by
// event, so a two-shift event never splits: `limit` counts events (default
// 100, at most 200) and has_more says when more exist.
//
// `exclude` is REQUIRED (legalHold.holdExclusion()): a held proposal's shifts
// and every shift of a held client's other bookings are left out in the SQL
// that picks the rows. No admin screen calls this read, so it fails closed: a
// missing or malformed exclusion throws rather than leaving nothing out. An
// explicit empty exclusion ({ proposalIds: [], clientIds: [] }) excludes
// nothing, for a test.

const { pool } = require('../../db');
const { adminScopedShiftsSql } = require('../../routes/shifts.queries');
const { readExclusion } = require('./exclusion');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const UPCOMING_WINDOW_SQL = adminScopedShiftsSql('upcoming', { window: true });
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

// A real calendar day as YYYY-MM-DD, or null (2026-02-30 is not one).
function readDay(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return null;
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day ? day : null;
}

/**
 * Every upcoming shift whose event day is in [start, end].
 * @param {{start: string, end: string, limit?: number,
 *   exclude: {proposalIds: number[], clientIds: number[]}}} args
 * @returns {Promise<{rows: object[], total_events: number, has_more: boolean}>}
 *   each row is the phone Events list's row (every shifts column, then
 *   event_key, needs_staff, venue_city, venue_state, open_slots,
 *   created_by_email, proposal_total, proposal_amount_paid,
 *   proposal_balance_due_date, proposal_guest_count, proposal_token,
 *   proposal_status, bar_required, client_name, client_phone, client_email,
 *   request_count, approved_count, pending_count, approved_by_role,
 *   approved_staff, pending_staff and the plan-queue columns), earliest event
 *   first, then date, start time and shift id
 * @throws {TypeError} when start or end is not a calendar day, end is before
 *   start, or the exclusion is missing or malformed
 */
async function listUpcomingEvents({ start, end, limit = DEFAULT_LIMIT, exclude } = {}) {
  const from = readDay(start);
  const to = readDay(end);
  if (!from || !to) throw new TypeError('upcoming events: start and end must be calendar days (YYYY-MM-DD)');
  if (to < from) throw new TypeError('upcoming events: end is before start');
  const hold = readExclusion(exclude);
  if (!hold) throw new TypeError('upcoming events: pass the hold exclusion (legalHold.holdExclusion())');
  const lim = Math.min(MAX_LIMIT, Math.max(1, Number.isInteger(limit) ? limit : DEFAULT_LIMIT));
  const { rows } = await pool.query(UPCOMING_WINDOW_SQL, [
    0, lim, false, from, to, hold.proposalIds, hold.clientIds,
  ]);
  // The totals ride a one-row CTE with the page LEFT JOINed on, so row 0
  // always carries them; an empty page is that one placeholder (id NULL).
  const totalEvents = Number((rows[0] || {}).total_events || 0);
  const shifts = rows
    .filter((r) => r.id !== null)
    // eslint-disable-next-line no-unused-vars
    .map(({ event_rank, event_first_date, event_last_date, total_events, scope_events, needs_staff_events, ...row }) => row);
  return { rows: shifts, total_events: totalEvents, has_more: lim < totalEvents };
}

module.exports = { listUpcomingEvents };
