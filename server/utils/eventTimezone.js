const DEFAULT_TZ = 'America/Chicago';

/**
 * Verify a string is a valid IANA timezone identifier.
 * @param {string} tz
 * @returns {boolean}
 */
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Pull the event timezone from a proposal-like object, falling back to
 * the admin default if missing or invalid.
 *
 * @param {{ event_timezone?: string | null }} proposal
 * @returns {string} IANA zone
 */
function resolveEventTimezone(proposal) {
  const tz = proposal && proposal.event_timezone;
  return isValidTimezone(tz) ? tz : DEFAULT_TZ;
}

/**
 * Format a Date in the given timezone for display in messages.
 *
 * @param {Date} date
 * @param {string} tz - IANA zone (resolved via resolveEventTimezone)
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {string}
 */
function formatEventLocalTime(date, tz, options = {}) {
  // Backstop against an Invalid Date reaching Intl.format, which would throw the
  // opaque "RangeError: Invalid time value" with no clue which caller or field
  // produced it (Sentry DRBARTENDER-SERVER-Z — a null event_date built
  // `new Date('nullT12:00:00Z')`). Fail with a self-identifying message instead.
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new RangeError(`formatEventLocalTime: invalid date value (received ${String(date)})`);
  }
  return new Intl.DateTimeFormat('en-US', {
    ...options,
    timeZone: tz,
  }).format(date);
}

module.exports = {
  DEFAULT_TZ,
  isValidTimezone,
  resolveEventTimezone,
  formatEventLocalTime,
};
