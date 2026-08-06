'use strict';

/**
 * The 2:00 AM service curfew, applied to CONTRACTED durations.
 *
 * WHY THIS IS NOT A BUSINESS PREFERENCE: the liquor liability application
 * (PK810225-GLLL230810) warrants "Do not have operations going past 2:00 AM",
 * and the program repeats it as a prohibited operation. Breaching a policy
 * warranty can void liquor liability coverage entirely — not just for the late
 * hour, for the claim. An uninsured incident costs orders of magnitude more
 * than the booking is worth.
 *
 * The extension flow (serviceExtensionPricing.js) already enforces this when a
 * staffer sells more time mid-event. This module covers the other, larger door:
 * a duration TYPED INTO THE CONTRACT, which is how a 4:00 AM end is far more
 * likely to happen in practice.
 *
 * Policy per surface, deliberately different:
 *   - Client-facing paths (public quote builder, client change requests):
 *     hard refusal. A client must never be able to self-serve a booking outside
 *     coverage, and there is nobody in that flow who can weigh the risk.
 *   - Admin proposal POST + PATCH: refused BY DEFAULT, but an admin may
 *     proceed by explicitly acknowledging. Dallas owns his own risk, and a
 *     hard block would be the code overruling the operator; what the code owes
 *     him is that it can never happen by accident or unnoticed. Every override
 *     is written to the admin audit log. The PATCH checks only when the save
 *     touches timing, so a legacy past-curfew booking does not demand an
 *     acknowledgement for an unrelated edit.
 *   - Settle (extension payment / override): hard refusal, because by then
 *     nobody is watching (see checkContractCurfew callers).
 *
 * NOT guarded, deliberately: shifts.js proposal-minting, the Thumbtack draft,
 * proposal cloning, and seed/import scripts. All admin- or system-driven, none
 * client-self-serve, and each is caught the next time the timing is edited.
 * Recorded in ARCHITECTURE.md rather than left as an implied guarantee.
 */

const { maxDurationHoursBeforeCurfew, SERVICE_CURFEW_HOUR } = require('./eventEndInstant');

// event_start_time is free text (varchar), so a row can hold "TBD" or "7pm".
// Casting that in SQL raises 22007 — and a caught 22007 still ABORTS the
// enclosing transaction, so every later statement dies 25P02. Both route call
// sites run inside BEGIN, which turned "we cannot tell, skip the guard" into a
// permanent 500 on any proposal holding an unparseable time.
//
// So the format is checked in JS BEFORE Postgres ever sees it. It must be
// STRICTLY conservative — narrower than Postgres's parser, never wider. A
// string this admits that Postgres then rejects re-opens the exact bug.
//
// Checking SHAPE is not enough; the fields must be RANGE-checked too. Measured
// against Postgres (a shape-only screen let 907 of 1,107 fuzzed strings through
// to a raise):
//
//   accepted:  "9:00 PM"  "9:00 pm"  "9:00pm"  "21:00"  "09:00"  "9:00:00 PM"
//   RAISES 22008 (looks fine, is not):  "9:60"  "25:00"  "13:00 PM"  "9:00:99"
//   RAISES 22007/22023:  "9:00 p.m."  "9 PM"  "9PM"  "9:00<NBSP>PM"
//
// Three traps worth naming, because each cost a round:
//   1. Hour/minute/second ranges: Postgres rejects minute > 59, and rejects an
//      hour > 12 when a meridiem is present ("13:00 PM").
//   2. `\s` in JS matches NBSP and friends; Postgres's parser does not. Word
//      and Google Docs paste NBSP, so this is an ordinary admin action.
//   3. Screen the EXACT string that gets cast. Screening a trimmed copy while
//      casting the original re-opens the hole for padded values, so anything
//      with surrounding whitespace is refused outright rather than trimmed.
//
// Anything unrecognized returns null (guard skipped), the same fail-open the
// unparseable case always had, rather than refusing a booking we cannot read.
const PARSEABLE_TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[ \t]*([AaPp][Mm]))?$/;

// The DAY operand of the same cast, and the same rule: screen it before
// Postgres sees it. Missing this was the second half of the identical bug —
// event_date arrives from the request body on the create, PATCH, and
// client-portal change-request paths, so `{"event_date":"banana"}` raised
// 22007 inside the caller's BEGIN and poisoned it exactly like a bad time.
// Requires a real calendar date, so "2026-13-45" is refused too.
// Coerce to string WITHOUT trusting the value: a JSON body can carry
// `{"toString":"x"}`, whose non-callable toString makes String() throw a
// TypeError. An unhandled throw here is a 500 where a 400 belongs.
function safeString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return '';
  }
}

function normalizeDay(value) {
  // The Date branch RENDERS a candidate; it does not get to skip validation.
  // Keeping one validated path is the point: an earlier version validated the
  // string branch only, and the Date branch emitted an unpadded year
  // ("26-06-15" for a year-26 row), which Postgres rejects — reintroducing the
  // transaction-poisoning bug through the very branch added to avoid it.
  let candidate;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // A pg DATE arrives at LOCAL midnight and the local date is what we want.
    // padStart on the YEAR too, not just month/day.
    candidate = `${String(value.getFullYear()).padStart(4, '0')}-`
      + `${String(value.getMonth() + 1).padStart(2, '0')}-`
      + `${String(value.getDate()).padStart(2, '0')}`;
  } else {
    candidate = safeString(value).slice(0, 10);
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Year floor of 1000 is deliberate: a 3-digit or year-0 date is never a real
  // booking, and Postgres reads a low unpadded year as a different date
  // entirely ("1-06-15" parses as 2015-06-01), which would silently evaluate
  // the curfew against the wrong day.
  if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Round-trip through Date to reject 2026-02-30 and friends.
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return null;
  return candidate;
}

function isParseableTime(value) {
  // Only a real string can be screened: anything else (array, object, number)
  // reaches the query in a form the screen did not inspect, which is the same
  // "screen one thing, cast another" trap that has bitten this module twice.
  if (typeof value !== 'string') return false;
  const s = value;
  if (s !== s.trim()) return false;          // screened string must equal the cast string
  const m = PARSEABLE_TIME.exec(s);
  if (!m) return false;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = m[3] ? Number(m[3]) : 0;
  if (minute > 59 || second > 59) return false;
  // With a meridiem the hour is 1-12; without it, 0-23. ("24:00" is legal to
  // Postgres but not worth admitting for one edge value.)
  return m[4] ? hour >= 1 && hour <= 12 : hour <= 23;
}

/**
 * Would this duration run the bar past the curfew?
 *
 * Times come from the proposal row, so this reads the event's own timezone and
 * free-text start time exactly the way every other consumer does.
 *
 * @returns {Promise<{past:boolean, maxHours:number, curfewDisplay:string}|null>}
 *   null when the stored start time is unparseable — the caller decides, since
 *   "cannot tell" means something different on a create than on a settle.
 */
async function checkContractCurfew(client, proposalId, durationHours) {
  const hours = Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  // Pre-screen the stored time so the probe below cannot raise inside the
  // caller's transaction (see PARSEABLE_TIME).
  const { rows: t } = await client.query(
    'SELECT event_start_time FROM proposals WHERE id = $1', [proposalId]
  );
  if (!t[0] || !isParseableTime(t[0].event_start_time)) return null;
  const curfew = await maxDurationHoursBeforeCurfew(client, proposalId);
  if (!curfew) return null;
  return {
    // Tolerance so float noise on a fractional duration cannot manufacture a
    // breach out of an exactly-at-curfew booking (ending AT 2:00 AM is legal).
    past: hours > curfew.maxHours + 1e-6,
    maxHours: curfew.maxHours,
    curfewDisplay: curfew.curfewDisplay,
  };
}

/**
 * The same question for a duration that has no proposal row yet (create paths),
 * given the start time directly.
 *
 * NOTE the timezone is accepted for call-site symmetry but is deliberately NOT
 * used: the curfew is a WALL-CLOCK rule ("no operations past 2:00 AM"), so it
 * is answered entirely in the event's own local frame. Converting to an instant
 * first would make the answer depend on the server's zone, which is exactly the
 * bug class eventEndInstant.js exists to avoid.
 */
async function checkCurfewForStart(client, { eventDate, startTime, timezone, durationHours }) { // eslint-disable-line no-unused-vars
  const hours = Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  if (!eventDate || !startTime) return null;
  // Pre-screen BEFORE the query: a cast failure here would abort the caller's
  // transaction even though we catch it (see PARSEABLE_TIME).
  if (!isParseableTime(startTime)) return null;
  // BOTH operands of the cast must be screened, not just the time. event_date
  // arrives from the request body on create / PATCH / change-request, so an
  // unscreened `{"event_date":"banana"}` raised 22007 inside the caller's BEGIN
  // and poisoned it exactly like a bad time did. normalizeDay also absorbs the
  // pg-Date shape (a DATE column arrives as a JS Date whose default
  // serialization is a full ISO instant, which concatenates into garbage).
  const day = normalizeDay(eventDate);
  if (!day) return null;
  let rows;
  try {
    ({ rows } = await client.query(
      `WITH s AS (
         SELECT (($1::text || ' ' || $2::text)::timestamp) AS local_start
       ), c AS (
         SELECT local_start,
           CASE
             WHEN local_start <= date_trunc('day', local_start) + ($3::int * INTERVAL '1 hour')
               THEN date_trunc('day', local_start) + ($3::int * INTERVAL '1 hour')
             ELSE date_trunc('day', local_start) + INTERVAL '1 day' + ($3::int * INTERVAL '1 hour')
           END AS curfew_at
         FROM s
       )
       SELECT EXTRACT(EPOCH FROM (curfew_at - local_start)) / 3600.0 AS max_hours,
              to_char(curfew_at, 'FMHH12:MI AM') AS curfew_display
         FROM c`,
      [day, startTime, SERVICE_CURFEW_HOUR]
    ));
  } catch (err) {
    if (err.code === '22007' || err.code === '22008' || err.code === '22023') return null;
    throw err;
  }
  if (!rows[0] || rows[0].max_hours === null) return null;
  const maxHours = Number(rows[0].max_hours);
  return { past: hours > maxHours + 1e-6, maxHours, curfewDisplay: rows[0].curfew_display };
}

/**
 * The whole admin-save decision in one call: does this save need an explicit
 * past-curfew acknowledgement?
 *
 * Lives here rather than in the route so create and edit cannot drift, and so
 * the "already breaching" nuance is stated once. Returns null to proceed, or
 * { message } when the caller must refuse and ask.
 *
 * @param {object} next      { eventDate, startTime, timezone, durationHours } after the save
 * @param {object|null} prev same shape BEFORE the save, or null on a create
 */
async function curfewGateForSave(client, { next, previous = null, acknowledged = false }) {
  const after = await checkCurfewForStart(client, next);
  if (!after || !after.past) return null;

  // An existing breach is not a new decision. A booking already past 2:00 AM
  // (legacy data, or one an admin knowingly accepted) must not re-prompt and
  // re-audit every time someone reschedules it or trims an hour off it. Only a
  // NEW breach, or one made WORSE, asks again. Overage is hours past the
  // curfew, which is date-independent, so this compares like with like.
  if (previous) {
    const before = await checkCurfewForStart(client, previous);
    if (before && before.past) {
      const wasOver = Number(previous.durationHours) - before.maxHours;
      const nowOver = Number(next.durationHours) - after.maxHours;
      if (!(nowOver > wasOver + 1e-6)) return null;
    }
  }

  if (acknowledged === true) {
    return { acknowledged: true, curfewDisplay: after.curfewDisplay, durationHours: next.durationHours };
  }
  return { message: `${curfewMessage(after.curfewDisplay, after.maxHours)} Confirm to book it anyway.` };
}

/** The one client-facing sentence, so every surface words it identically. */
function curfewMessage(curfewDisplay, maxHours) {
  // Rounded: the raw value is a float (an 8:10 PM start yields
  // 5.833333333333333) and this sentence is shown to clients.
  let cap = '';
  if (Number.isFinite(maxHours) && maxHours > 0) {
    const rounded = Math.round(maxHours * 4) / 4;   // quarter-hour, matching how events are sold
    cap = ` The longest we can book from this start time is ${rounded} hours.`;
  }
  return `Bar service cannot run past ${curfewDisplay || '2:00 AM'} (our liquor liability coverage requires it).${cap}`;
}

module.exports = {
  checkContractCurfew,
  checkCurfewForStart,
  curfewMessage,
  curfewGateForSave,
  // Exported for the test that asserts the screen stays strictly narrower than
  // the Postgres parser. That property is what keeps a swallowed cast error
  // from poisoning a caller's transaction, so it is pinned, not assumed.
  isParseableTime,
  normalizeDay,
  SERVICE_CURFEW_HOUR,
};
