const { pool } = require('../db');

/**
 * Event types that qualify for the T+11mo retention nudge.
 * Excludes one-time-per-host event categories (weddings, engagements, baby
 * showers, retirements, bachelor/bachelorette parties, graduations) where
 * the nudge would be tone-deaf or simply not actionable. See spec 4.2.
 *
 * IDs mirror server/utils/eventTypes.js. Keep them in sync if either file
 * changes. The list is intentionally a code constant (not DB config) for V1;
 * a future admin UI to tune the whitelist is open item §12 in the spec.
 */
const RETENTION_ELIGIBLE_EVENT_TYPES = [
  'holiday-party',
  'birthday-party',
  'milestone-birthday',
  'corporate-event',
  'corporate-happy-hour',
  'anniversary',
  'cocktail-party',
  'cocktail-class',
];

function isRetentionEligibleEventType(eventType) {
  if (!eventType) return false;
  return RETENTION_ELIGIBLE_EVENT_TYPES.includes(eventType);
}

/**
 * New Year touch eligibility: event is in the calendar year immediately
 * following the sign year, AND the event date is at least 60 days into
 * that new year. The 60-day rule keeps us from sending "happy new year"
 * to a January 15 booking — they'd hear it less than two weeks before
 * the event, which feels off.
 */
function shouldScheduleNewYearTouch(signedAt, eventDate) {
  if (!signedAt || !eventDate) return false;
  const signYear = new Date(signedAt).getUTCFullYear();
  const eventYear = new Date(eventDate).getUTCFullYear();
  if (eventYear !== signYear + 1) return false;
  const jan1 = new Date(Date.UTC(eventYear, 0, 1));
  const diffDays = Math.floor((new Date(eventDate).getTime() - jan1.getTime()) / 86400000);
  return diffDays >= 60;
}

/**
 * 6-months-out touch eligibility: booking lead time strictly greater than
 * 6 calendar months. Strict so a 6-month-exactly booking doesn't fire a
 * touch the day it's signed.
 *
 * Uses a true calendar-month comparison (add 6 months to the sign date and
 * require the event to land strictly after that instant) rather than a
 * fixed 180-day proxy: a calendar half-year spans 181-184 days depending
 * on which months it crosses, so a 180-day threshold would misclassify a
 * 6-month-exactly booking (e.g. Feb 15 -> Aug 15 is 181 days) as eligible.
 */
function shouldScheduleSixMonthsTouch(signedAt, eventDate) {
  if (!signedAt || !eventDate) return false;
  const s = new Date(signedAt);
  const sixMonthsAfter = new Date(Date.UTC(
    s.getUTCFullYear(),
    s.getUTCMonth() + 6,
    s.getUTCDate(),
    s.getUTCHours(),
    s.getUTCMinutes(),
    s.getUTCSeconds(),
    s.getUTCMilliseconds()
  ));
  return new Date(eventDate).getTime() > sixMonthsAfter.getTime();
}

/**
 * Compute the UTC instant for "10:00 AM event-local on the given date" using
 * the proposal's event timezone (Gemini Finding 4 / spec 7.2).
 *
 * Callers pass an explicit `tz` (e.g. resolved via
 * `resolveEventTimezone(proposal)` from Plan 1's `eventTimezone.js`). The
 * default of `America/Chicago` is preserved as a fallback for tests and any
 * code path that genuinely has no proposal context, but production sites
 * MUST pass the event TZ. The dispatcher schedules wall-clock 10am on the
 * configured day; DST is handled because we probe Intl.DateTimeFormat for
 * the specific calendar date.
 */
function tenAmInTzUtc(localDate, tz = 'America/Chicago') {
  const d = new Date(localDate);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  // Probe over a 24-hour range. For tz offsets in [-12, +14] there are at
  // most ~26 valid UTC hour candidates; iterate and find the one whose
  // wall-clock hour in tz is 10.
  for (let utcHour = 0; utcHour < 36; utcHour++) {
    const probe = new Date(Date.UTC(year, month, day, utcHour, 0, 0));
    let zoneHour;
    try {
      zoneHour = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(probe);
    } catch {
      // Invalid tz → fall back to UTC math (treat tz as Etc/UTC offset 0)
      return new Date(Date.UTC(year, month, day, 10, 0, 0));
    }
    if (zoneHour === '10') return probe;
  }
  // Genuinely impossible (no 10am wall-clock in this tz on this date) →
  // emergency fallback to 10:00 UTC.
  return new Date(Date.UTC(year, month, day, 10, 0, 0));
}

/**
 * @deprecated kept temporarily for back-compat in tests. Prefer
 *   `tenAmInTzUtc(localDate, resolveEventTimezone(proposal))`.
 */
function chicagoTenAmUtc(localDate) {
  return tenAmInTzUtc(localDate, 'America/Chicago');
}

function computeNewYearSendAt(eventDate, tz = 'America/Chicago') {
  const year = new Date(eventDate).getUTCFullYear();
  return tenAmInTzUtc(new Date(Date.UTC(year, 0, 2)), tz); // Jan 2 of event year
}

function computeSixMonthsOutSendAt(eventDate, tz = 'America/Chicago') {
  const d = new Date(eventDate);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, d.getUTCDate()));
  return tenAmInTzUtc(target, tz);
}

function computeReviewRequestSendAt(eventDate, tz = 'America/Chicago') {
  const d = new Date(eventDate);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 2));
  return tenAmInTzUtc(target, tz);
}

function computeRetentionNudgeSendAt(eventDate, tz = 'America/Chicago') {
  const d = new Date(eventDate);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 11, d.getUTCDate()));
  return tenAmInTzUtc(target, tz);
}

/**
 * Check whether a client has another non-archived future event in the system,
 * excluding the proposal that triggered the retention check. Used to suppress
 * the retention nudge when the client is already actively booked again.
 */
async function clientHasUpcomingEvent(clientId, excludingProposalId) {
  const { rows } = await pool.query(
    `SELECT 1
     FROM proposals
     WHERE client_id = $1
       AND id != $2
       AND status != 'archived'
       AND event_date >= CURRENT_DATE
     LIMIT 1`,
    [clientId, excludingProposalId]
  );
  return rows.length > 0;
}

module.exports = {
  RETENTION_ELIGIBLE_EVENT_TYPES,
  isRetentionEligibleEventType,
  shouldScheduleNewYearTouch,
  shouldScheduleSixMonthsTouch,
  tenAmInTzUtc,
  chicagoTenAmUtc,
  computeNewYearSendAt,
  computeSixMonthsOutSendAt,
  computeReviewRequestSendAt,
  computeRetentionNudgeSendAt,
  clientHasUpcomingEvent,
};
