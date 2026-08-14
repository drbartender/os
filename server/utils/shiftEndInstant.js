'use strict';

// shiftEndInstant — THE definition of when a shift is over.
//
// Spec: docs/superpowers/specs/2026-08-14-shift-lifecycle-design.md
//
// Every shift-visibility surface used to ask "is this shift dated today or
// later" (`event_date >= CURRENT_DATE`). That is a proxy for the real question
// and it is wrong twice over:
//
//   - CURRENT_DATE resolves in the SESSION timezone, which is GMT on this
//     database (SHOW TimeZone -> GMT, verified dev and prod). From 19:00
//     Chicago (18:00 in winter) it is already tomorrow there, so TONIGHT's
//     shift vanished from the staff Available tab, the admin assign modal, the
//     staffer's own next-shift card and the SMS responder — five hours before
//     the bar opened.
//   - Widening that to the Chicago calendar day fixes the disappearance and
//     creates a worse bug: a shift that ENDED this morning stays "upcoming" all
//     day, so a bartender texting CANT at 20:00 about tomorrow has this
//     morning's finished brunch denied and re-opened, pulling somebody who
//     actually worked off the roster payroll pays from.
//
// So: ask whether the shift has FINISHED. `upcoming` = the end instant is in
// the future; `finished` = it is in the past. No calendar-day arithmetic, so no
// timezone boundary to get wrong, and no dependence on closure having run.
//
// The codebase already trusts this shape — balanceScheduler.js completes an
// EVENT with ((event_date + event_start_time::time + duration) AT TIME ZONE
// event_timezone) < NOW(), guarded by a regex against the free-text time
// column. This is the same idea applied to a SHIFT.
//
// ─── WHY A SQL FRAGMENT AND NOT A VIEW OR A GENERATED COLUMN ────────────────
//
// A GENERATED column is out on correctness: the zone lives on the PROPOSAL
// (proposals.event_timezone), so the expression is cross-table and cannot be
// stored generated on shifts. It would also freeze at write time while
// event_date / end_time are edited by PUT /shifts/:id afterwards.
//
// A VIEW was the close call. It would be one definition enforced by the
// database, but it buys nothing the fragment does not: every consumer below
// already has to add a LEFT JOIN to reach the proposal, so joining a view is
// the same edit surface. Against it: it needs a schema.sql migration replayed
// by initDb on every boot, and initDb deliberately swallows some DDL errors
// (that is exactly why server/scripts/verify-marketing-schema.js exists), so a
// view that failed to install boots clean and silently changes what every
// staffing surface returns. The fragment ships with the code, cannot be out of
// step with the deployed server, and is pinned by a unit test.
//
// ONE definition. Two copies is how the count and the list it counts diverged
// in the round this replaces, twice, with in-code comments claiming they
// mirrored each other. If you need the end instant somewhere new, import it —
// do not retype the CASE.
//
// ─── THE RULES ──────────────────────────────────────────────────────────────
//
//   1. BOTH end_time and start_time parse ->
//        (event_date + end_time) AT TIME ZONE tz, plus a day when the end is at
//        or before the start (an 8pm-1am shift ends at 01:00 TOMORROW).
//   2. only start_time parses (end_time NULL or malformed) ->
//        (event_date + start_time + booked length + overrun grace) AT TIME ZONE tz
//   3. neither parses -> end of that calendar day in tz.
//   4. tz = the proposal's event_timezone, falling back to 'America/Chicago'
//      when the shift has no proposal (5 of 78 prod shifts).
//
// ─── WHY RULE 2 IS NOT SIMPLY "END OF DAY" (review finding, 2026-08-14) ─────
//
// The first cut of this module used end-of-day for everything that was not a
// clean end_time, on the reasoning that visible-is-safer. On the READ paths that
// is true. On the CANT WRITE path it is the opposite, and it was a REGRESSION
// against the code this replaces:
//
//     A staffer is approved on a 10:00 AM shift today with a NULL end_time, and
//     on a 2:00 PM shift tomorrow. At 19:30 they text CANT meaning tomorrow.
//     Under end-of-day, today's finished brunch is still "not finished" until
//     midnight and sorts FIRST, so handleCant denies and re-opens the shift they
//     already worked, pulling them off the roster payroll pays from. The old
//     `event_date >= CURRENT_DATE` excluded it by accident of the GMT rollover.
//
// So an unknown end is ASSUMED, not deferred to midnight: the booked length off
// the proposal (or ASSUMED_HOURS) plus OVERRUN_GRACE_HOURS. That is late enough
// that a shift running long never vanishes mid-service, and early enough that a
// morning shift is finished by evening.
//
// Rule 3 keeps the fail-safe-toward-VISIBLE stance for the genuinely unknowable
// case. A malformed time is never a parse error — it takes a fallback.
//
// ─── ONE DEVIATION FROM THE SPEC'S LITERAL TEXT, TOWARD VISIBLE ─────────────
//
// (a) OVERNIGHT WRAP. The spec's rule 1 is written as if end_time is always
//     later in the day than start_time. It is not: 6 shifts in the dev database
//     carry end_time '12:00 AM' or '1:00 AM' against an 8:00 PM start (New
//     Year's Eve, weddings). Taken literally, an 8pm-1am shift's end instant is
//     01:00 on the MORNING of the event — nineteen hours before it starts — so
//     the shift would be invisible for its entire day. That is the exact P0 this
//     spec exists to kill, so the wrap is corrected against the parsed start.
//     A wrap CANNOT be detected without a start, so rule 1 now requires both to
//     parse; an end_time with no usable start falls to rule 3 rather than being
//     compared against midnight. The earlier version compared against midnight
//     and therefore resolved a '1:00 AM' end with no start to that MORNING,
//     hiding the shift for its whole service day — the same P0, reintroduced.
//
// (b) TIGHTER PARSE REGEX. The spec names ^[0-9]{1,2}:[0-9]{2}( ?[AP]M)?$,
//     inherited from balanceScheduler. That shape accepts '25:00' and '13:70',
//     which match the regex and then throw 22007 on ::time — a 500 on the staff
//     Available tab, not a fallback. The regex below is that regex INTERSECTED
//     WITH "is actually a valid clock time", so it is a strict subset: every
//     value it rejects takes rule 2 (visible) instead of raising. Zero of the
//     64 populated prod end_time values and zero of the 14 distinct dev values
//     are affected.
//
// ─── KNOWN, ACCEPTED ────────────────────────────────────────────────────────
//
// AT TIME ZONE raises on an unknown zone name. proposals.event_timezone is
// TEXT NOT NULL DEFAULT 'America/Chicago' and holds exactly one distinct value
// across all 571 prod rows; it is only ever written by our own code. NULLIF
// covers the empty string. A genuinely bogus IANA name would still raise, the
// same exposure balanceScheduler.js:228 has carried in production for months.

/**
 * The spec's end_time shape, narrowed to values Postgres can actually cast to
 * TIME. Two alternatives: a 24-hour clock with no meridiem, or a 12-hour clock
 * that must carry one. Applied case-insensitively (`~*`) so '7:00 pm' parses.
 *
 * Contains no interpolated input — it is a literal embedded in the SQL text.
 */
const SHIFT_TIME_RE = '^((0?[0-9]|1[0-9]|2[0-3]):[0-5][0-9]|(0?[1-9]|1[0-2]):[0-5][0-9] ?[AP]M)$';

/**
 * Rule 2's assumed length when the PROPOSAL carries no event_duration_hours
 * (or there is no proposal at all). Four hours is the modal booked length.
 */
const ASSUMED_HOURS = 4;

/**
 * Rule 2's tail on top of the booked length. A shift that runs long must not
 * disappear while people are still behind the bar, so the assumed end sits well
 * past any realistic overrun — but still EARLIER than "midnight regardless",
 * which is what let a finished 10am brunch outrank tomorrow's wedding on the
 * CANT write path.
 */
const OVERRUN_GRACE_HOURS = 4;

/**
 * With no parseable start_time an overnight wrap cannot be detected from the
 * data, so it is decided by the clock: an end_time before this hour is treated
 * as belonging to the NEXT day. No bar shift legitimately ends at 01:00 on the
 * morning of its own event date without having started the previous evening,
 * and the alternative — reading it literally — hid a New Year's Eve shift for
 * its entire service day.
 */
const WRAP_CUTOFF_HOUR = 6;

/**
 * SQL expression yielding a shift's end instant as a TIMESTAMPTZ.
 *
 * Both aliases must be in scope in the surrounding query. `proposalAlias` may
 * be LEFT JOINed (a shift with no proposal is normal); the zone COALESCEs to
 * America/Chicago in that case.
 *
 * @param {string} [shiftAlias='s'] alias of the `shifts` row
 * @param {string} [proposalAlias='p'] alias of the joined `proposals` row
 * @returns {string} a parenthesised SQL expression
 */
function shiftEndInstantSql(shiftAlias = 's', proposalAlias = 'p') {
  const s = shiftAlias;
  const p = proposalAlias;
  const tz = `COALESCE(NULLIF(${p}.event_timezone, ''), 'America/Chicago')`;
  return `(CASE
      -- 1. end_time parses: the real end, rolled to the next day on an overnight
      --    wrap (an 8pm-1am shift ends at 01:00 TOMORROW). The wrap is decided
      --    against the start when there is one; with no usable start it is
      --    decided by the clock, because no shift legitimately ENDS in the small
      --    hours of its own event date without having started the evening before.
      WHEN ${s}.end_time ~* '${SHIFT_TIME_RE}'
      THEN (${s}.event_date
              + ${s}.end_time::time
              + CASE
                  WHEN ${s}.start_time ~* '${SHIFT_TIME_RE}'
                  THEN CASE WHEN ${s}.end_time::time <= ${s}.start_time::time
                            THEN INTERVAL '1 day' ELSE INTERVAL '0' END
                  ELSE CASE WHEN ${s}.end_time::time < TIME '${String(WRAP_CUTOFF_HOUR).padStart(2, '0')}:00'
                            THEN INTERVAL '1 day' ELSE INTERVAL '0' END
                END
           ) AT TIME ZONE ${tz}
      -- 2. Only the START parses: assume the booked length plus a generous
      --    tail. See ASSUMED END below for why this is not end-of-day.
      WHEN ${s}.start_time ~* '${SHIFT_TIME_RE}'
      THEN (${s}.event_date
              + ${s}.start_time::time
              + (COALESCE(${p}.event_duration_hours, ${ASSUMED_HOURS}) * INTERVAL '1 hour')
              + INTERVAL '${OVERRUN_GRACE_HOURS} hours'
           ) AT TIME ZONE ${tz}
      -- 3. Nothing usable: end of the calendar day, the only safe guess.
      ELSE (${s}.event_date + INTERVAL '1 day') AT TIME ZONE ${tz}
    END)`;
}

/**
 * "This shift has not finished yet" — the ONE visibility predicate. Drop it
 * into a WHERE clause in place of any `event_date >= CURRENT_DATE`.
 *
 * @param {string} [shiftAlias='s']
 * @param {string} [proposalAlias='p']
 * @returns {string} SQL boolean expression
 */
function shiftNotFinishedSql(shiftAlias = 's', proposalAlias = 'p') {
  return `${shiftEndInstantSql(shiftAlias, proposalAlias)} > NOW()`;
}

/**
 * "This shift has finished" — the exact complement of shiftNotFinishedSql, so
 * a shift is in exactly one of the two buckets at every instant. Used by the
 * closure sweep and its backfill.
 *
 * @param {string} [shiftAlias='s']
 * @param {string} [proposalAlias='p']
 * @returns {string} SQL boolean expression
 */
function shiftFinishedSql(shiftAlias = 's', proposalAlias = 'p') {
  return `${shiftEndInstantSql(shiftAlias, proposalAlias)} <= NOW()`;
}

module.exports = {
  shiftEndInstantSql, shiftNotFinishedSql, shiftFinishedSql,
  SHIFT_TIME_RE, ASSUMED_HOURS, OVERRUN_GRACE_HOURS,
};
