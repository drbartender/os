// Shared SMS event-date formatter. pg returns DATE columns as JS Date objects;
// the old per-file helpers did String(eventDate).slice(0, 10), which turns a
// Date into "Thu Jun 12" and rendered "Invalid Date" (unguarded call sites) or
// the 'your event' sentinel (guarded ones) in client-facing SMS. One formatter,
// one contract: returns "June 12" or null. Callers pass the result straight to
// the SMS templates, which own all fallback copy.

/**
 * @param {Date|string|null|undefined} eventDate proposals.event_date (a pg
 *   Date object) or an ISO-ish string.
 * @returns {string|null} e.g. "June 12", or null when missing/unparseable.
 */
function formatEventDateForSms(eventDate) {
  if (!eventDate) return null;
  let ymd;
  if (eventDate instanceof Date) {
    if (Number.isNaN(eventDate.getTime())) return null;
    // Local calendar parts: pg parses DATE columns to local midnight, so
    // toISOString() could shift the day in timezones east of UTC.
    ymd = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}-${String(eventDate.getDate()).padStart(2, '0')}`;
  } else {
    ymd = String(eventDate).slice(0, 10);
  }
  const parsed = new Date(ymd + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

module.exports = { formatEventDateForSms };
