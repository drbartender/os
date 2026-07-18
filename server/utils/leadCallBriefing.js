/**
 * Spoken briefing for the lead-call bridge (spec 2026-07-18 section 4.4).
 *
 * Pure text builder: DB-shaped thumbtack_leads row in, plain sentence out.
 * The TwiML layer owns xmlEscape (this module must NOT escape, or the
 * escaping would double up). Absent fields are skipped, never spoken as
 * "unknown". Dates render TTS-friendly in America/Chicago; numeric forms
 * like "10/10 18:00" read badly through <Say>.
 */

const CHICAGO = 'America/Chicago';

/**
 * "Saturday October 10th, 6 PM" (minutes only when non-zero) for a
 * TIMESTAMPTZ instant, in Chicago wall-clock time.
 */
function spokenEventDate(value) {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(instant);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  const day = Number(get('day'));
  const suffix =
    day % 10 === 1 && day !== 11 ? 'st'
    : day % 10 === 2 && day !== 12 ? 'nd'
    : day % 10 === 3 && day !== 13 ? 'rd'
    : 'th';
  const minute = get('minute');
  const time = minute === '00'
    ? `${get('hour')} ${get('dayPeriod')}`
    : `${get('hour')}:${minute} ${get('dayPeriod')}`;
  return `${get('weekday')} ${get('month')} ${day}${suffix}, ${time}`;
}

/**
 * Build the spoken briefing for one lead.
 *
 * @param {Object|null} leadRow thumbtack_leads row (customer_name, category,
 *   event_date, guest_count, location_city); null/undefined tolerated
 * @returns {string} plain text for a TwiML <Say> (escape at the TwiML layer)
 */
function buildLeadBriefing(leadRow) {
  const row = leadRow || {};
  const details = [];
  if (row.category) details.push(String(row.category));
  const when = row.event_date ? spokenEventDate(row.event_date) : null;
  if (when) details.push(when);
  if (row.guest_count !== null && row.guest_count !== undefined && Number(row.guest_count) > 0) {
    details.push(`${row.guest_count} guests`);
  }
  if (row.location_city) details.push(String(row.location_city));

  // Strip one trailing period so an initialed name ("Sarah M.") does not
  // render a stuttering "Sarah M.." through <Say>.
  const name = row.customer_name ? String(row.customer_name).trim().replace(/\.$/, '') : null;
  const intro = name ? `New Thumbtack lead: ${name}.` : 'New Thumbtack lead.';
  const body = details.length ? ` ${details.join(', ')}.` : '';
  return `${intro}${body} Press 1 to call them now. Press 9 to hear this again.`;
}

module.exports = { buildLeadBriefing };
