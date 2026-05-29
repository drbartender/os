/**
 * Staff calendar feed extension — BEO-confirm VEVENTs.
 *
 * Spec ref: section 6.12 of docs/superpowers/specs/2026-05-27-staff-portal-redesign-design.md.
 *
 * For each staff-side shift whose linked drink_plan has been BEO-finalized
 * (drink_plans.finalized_at IS NOT NULL) but the staffer has NOT yet
 * acknowledged the BEO (shift_requests.beo_acknowledged_at IS NULL), emit an
 * all-day reminder VEVENT 3 days before the event so the staffer sees a
 * "Confirm BEO" block on their personal calendar.
 *
 * The reminder is transparent (TRANSP:TRANSPARENT) so it shows as
 * free-not-busy — it's a nudge, not a real obligation on the day.
 *
 * Helpers are local and tiny so this stays a pure-unit-testable module with
 * no dependency on the route file. It does not connect to the DB; the caller
 * passes already-fetched JOIN rows.
 */

/** Escape iCal TEXT field per RFC 5545 (backslash, semi, comma, newline). */
function escapeIcsText(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Current UTC time as iCal timestamp YYYYMMDDTHHMMSSZ. */
function nowIcs() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * "20260308" -> "20260309". All-day iCal DTEND convention: DTEND is the day
 * AFTER DTSTART. Date math runs in UTC so DST transitions (eg. 2026-03-08)
 * cannot off-by-one the reminder.
 */
function addDayIcs(yyyymmdd) {
  const y = parseInt(yyyymmdd.slice(0, 4), 10);
  const m = parseInt(yyyymmdd.slice(4, 6), 10) - 1;
  const d = parseInt(yyyymmdd.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Normalize a shift's event_date (pg DATE column or string) to YYYYMMDD,
 * then return YYYYMMDD that is 3 days earlier (UTC).
 * Returns null if event_date is missing or unparseable.
 */
function reminderYyyymmdd(eventDate) {
  if (!eventDate) return null;
  let isoDate;
  if (eventDate instanceof Date) {
    if (Number.isNaN(eventDate.getTime())) return null;
    isoDate = eventDate.toISOString().slice(0, 10);
  } else {
    isoDate = String(eventDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  }
  // Build UTC date so DST does not shift the day.
  const [y, m, d] = isoDate.split('-').map((v) => parseInt(v, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 3);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

/**
 * Build an array of CRLF-joined VEVENT block strings for the staff-side
 * BEO-confirm reminder.
 *
 * @param {Array<object>} rows - shift JOIN rows. Each row needs:
 *   - shift_id        (number) — the shifts.id
 *   - event_date      (Date|string)
 *   - client_name     (string|null)
 *   - finalized_at    (Date|null) — drink_plans.finalized_at
 *   - beo_acknowledged_at (Date|null) — shift_requests.beo_acknowledged_at
 *     for THIS staffer (the calling user)
 * @param {string} portalBaseUrl - eg. "https://staff.drbartender.com"
 * @returns {string[]} VEVENT blocks ready to splice into a VCALENDAR body
 */
function buildBeoConfirmVEvents(rows, portalBaseUrl) {
  const out = [];
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || !row.finalized_at) continue;
    if (row.beo_acknowledged_at) continue;
    const yyyymmdd = reminderYyyymmdd(row.event_date);
    if (!yyyymmdd) continue;
    const shiftId = row.shift_id;
    if (shiftId === undefined || shiftId === null) continue;
    out.push([
      'BEGIN:VEVENT',
      `UID:beo-confirm-${shiftId}@drbartender.com`,
      `DTSTAMP:${nowIcs()}`,
      `DTSTART;VALUE=DATE:${yyyymmdd}`,
      `DTEND;VALUE=DATE:${addDayIcs(yyyymmdd)}`,
      `SUMMARY:Confirm BEO: ${escapeIcsText(row.client_name || 'client')}`,
      `DESCRIPTION:Open the staff portal to confirm: ${portalBaseUrl}/shifts/${shiftId}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    ].join('\r\n'));
  }
  return out;
}

/**
 * Best-effort User-Agent detection for which calendar app subscribed to the
 * iCal feed. Stamped onto users.ui_preferences.calendar_subscribed_app so
 * the admin can see what staff use without a back-channel survey.
 *
 * @param {string|undefined|null} userAgent - the raw User-Agent header
 * @returns {"google"|"apple"|"outlook"|"other"}
 */
function detectCalendarApp(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') return 'other';
  const ua = userAgent;
  if (/Google-Calendar-Importer|Calendar\.google\.com|GoogleCalendar/i.test(ua)) return 'google';
  // Check Outlook BEFORE Apple — "Outlook-iOS" contains the "iOS/" substring
  // the Apple regex would otherwise claim. (Order = specificity.)
  if (/Microsoft Office|Outlook|MSOffice|Outlook-iOS|Outlook-Android/i.test(ua)) return 'outlook';
  if (/iCal\/|iOS\/|CalendarAgent|dataaccessd|Mac OS X.*Calendar|macOS.*Calendar/i.test(ua)) return 'apple';
  return 'other';
}

module.exports = {
  buildBeoConfirmVEvents,
  detectCalendarApp,
  // exported for unit tests and reuse
  escapeIcsText,
  nowIcs,
  addDayIcs,
  reminderYyyymmdd,
};
