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

async function eventEndInstant(client, proposalId) {
  const { rows } = await client.query(
    'SELECT event_duration_hours FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!rows[0] || rows[0].event_duration_hours === null) return null;
  return eventEndInstantForDuration(client, proposalId, rows[0].event_duration_hours);
}

module.exports = { eventEndInstant, eventEndInstantForDuration };
