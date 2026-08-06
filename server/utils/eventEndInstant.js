'use strict';

/**
 * Timezone-correct event start/end instants.
 *
 * The only correct precedent in the codebase is the completion gate in
 * balanceScheduler.js, which composes event_date + event_start_time +
 * event_duration_hours inside event_timezone. This module is that expression,
 * parameterized on duration, so the service-extension request window and
 * expires_at are real instants.
 *
 * Deliberately NOT shiftTime.js (hardcodes Chicago, literal -05:00/-06:00
 * offsets) and NOT addHoursToTime (naive string math with a % 24 midnight
 * wrap). addHoursToTime remains correct for the shift's DISPLAY string only.
 *
 * Postgres does the parsing so free-text event_start_time behaves identically
 * to every other consumer. An unparseable time returns null rather than
 * throwing, so callers can surface an explicit conflict.
 */

const SQL = `
  SELECT
    (((p.event_date::text || ' ' || p.event_start_time)::timestamp)
       AT TIME ZONE COALESCE(NULLIF(p.event_timezone, ''), 'America/Chicago')) AS start_instant,
    (((p.event_date::text || ' ' || p.event_start_time)::timestamp
       + ($2::numeric * INTERVAL '1 hour'))
       AT TIME ZONE COALESCE(NULLIF(p.event_timezone, ''), 'America/Chicago')) AS end_instant,
    to_char(((p.event_date::text || ' ' || p.event_start_time)::timestamp
       + ($2::numeric * INTERVAL '1 hour')), 'FMHH12:MI AM') AS end_display
  FROM proposals p
  WHERE p.id = $1
`;

async function eventEndInstantForDuration(client, proposalId, durationHours) {
  const hours = Number(durationHours);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  let rows;
  try {
    ({ rows } = await client.query(SQL, [proposalId, hours]));
  } catch (err) {
    // 22007 invalid_datetime_format / 22008 datetime_field_overflow: the stored
    // event_start_time is free text and this one is not a time. 22023
    // invalid_parameter_value: event_timezone is free TEXT and AT TIME ZONE
    // raises this on garbage. Not our bug to throw on; the caller turns each
    // into an explicit conflict.
    if (err.code === '22007' || err.code === '22008' || err.code === '22023') return null;
    throw err;
  }
  if (!rows[0] || !rows[0].end_instant) return null;
  return {
    startInstant: rows[0].start_instant,
    endInstant: rows[0].end_instant,
    endDisplay: rows[0].end_display,
  };
}

// Bar service may not run past this hour, local to the event. This is an
// INSURANCE WARRANTY, not a business preference: the liquor liability
// application (PK810225-GLLL230810) warrants "Do not have operations going
// past 2:00 AM", and the program's prohibited-operations list repeats it.
// Breaching a warranty can void liquor liability coverage entirely, so an
// extension that crosses this line is worse than no extension at all.
const SERVICE_CURFEW_HOUR = 2;

// The curfew is the FIRST 2:00 AM local at or after the event's start, and the
// comparison is deliberately WALL-CLOCK, not elapsed time: the warranty is
// about the hour on the clock. Working in local timestamps (before AT TIME
// ZONE) also makes the spring-forward night behave sensibly, since the policy
// cares that service stopped at 2:00 AM local, not how many real hours passed.
// Matches how event_duration_hours is already added in this module.
const CURFEW_SQL = `
  WITH s AS (
    SELECT ((p.event_date::text || ' ' || p.event_start_time)::timestamp) AS local_start
      FROM proposals p
     WHERE p.id = $1
  )
  , c AS (
    SELECT local_start,
      -- "<=", not "<": the curfew is the first 2:00 AM AT OR AFTER the start,
      -- so an event starting exactly AT 2:00 AM has ZERO room, not 24 hours.
      -- Exclusive here would fail OPEN at the single boundary this whole
      -- module exists to defend.
      CASE
        WHEN local_start <= date_trunc('day', local_start) + ($2::int * INTERVAL '1 hour')
          THEN date_trunc('day', local_start) + ($2::int * INTERVAL '1 hour')
        ELSE date_trunc('day', local_start) + INTERVAL '1 day' + ($2::int * INTERVAL '1 hour')
      END AS curfew_at
    FROM s
  )
  SELECT
    EXTRACT(EPOCH FROM (curfew_at - local_start)) / 3600.0 AS max_hours,
    to_char(curfew_at, 'FMHH12:MI AM') AS curfew_display
  FROM c
`;

/**
 * Longest TOTAL duration (from event start, in hours) that still ends the bar
 * at or before the curfew. Null when the stored time is unparseable, matching
 * eventEndInstantForDuration so callers surface one explicit conflict.
 *
 * @returns {Promise<{maxHours:number, curfewDisplay:string}|null>}
 */
async function maxDurationHoursBeforeCurfew(client, proposalId, curfewHour = SERVICE_CURFEW_HOUR) {
  let rows;
  try {
    ({ rows } = await client.query(CURFEW_SQL, [proposalId, curfewHour]));
  } catch (err) {
    // 22007/22008: event_start_time is free text and this one is not a time.
    // (22023 cannot fire here — this query has no AT TIME ZONE — but a garbage
    // event_timezone still fails closed overall, because every caller also
    // calls eventEndInstantForDuration on the same row and that one returns
    // null. Do not remove that pairing without re-checking this.)
    if (err.code === '22007' || err.code === '22008' || err.code === '22023') return null;
    throw err;
  }
  if (!rows[0] || rows[0].max_hours === null) return null;
  return { maxHours: Number(rows[0].max_hours), curfewDisplay: rows[0].curfew_display };
}

async function eventEndInstant(client, proposalId) {
  const { rows } = await client.query(
    'SELECT event_duration_hours FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!rows[0] || rows[0].event_duration_hours === null) return null;
  return eventEndInstantForDuration(client, proposalId, rows[0].event_duration_hours);
}

module.exports = {
  eventEndInstant,
  eventEndInstantForDuration,
  maxDurationHoursBeforeCurfew,
  SERVICE_CURFEW_HOUR,
};
