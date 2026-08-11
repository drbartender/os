'use strict';

const { TITLES } = require('./staffDisplayName');

/**
 * The name to greet someone by in a message.
 *
 * "Hi Monica Donnely," reads like a form letter; "Hi Monica," reads like a
 * person wrote it. Every client- and staff-facing greeting routes through here
 * so the whole system says it the same way.
 *
 * Takes the first whitespace-separated token, skipping a leading form of
 * address so "Dr. Monica Donnely" greets as "Monica" rather than "Dr.". The
 * title list is shared with staffDisplayName.js instead of duplicated, since it
 * encodes the same judgment: a title is a form of address, not a name.
 *
 * IDEMPOTENT by design — a value that has already been narrowed to a first name
 * comes back unchanged. That is what makes it safe to apply at a greeting site
 * whose input may or may not have been narrowed upstream, which is the actual
 * situation across the template files (some callers pass `clientFirstName`,
 * most pass a full `client_name`).
 *
 * @param {string|null|undefined} fullName
 * @param {string} [fallback='there'] - used when nothing usable remains
 * @returns {string}
 */
function firstNameOf(fullName, fallback = 'there') {
  const parts = String(fullName === null || fullName === undefined ? '' : fullName)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // find(), not [0]: "Dr. Monica" must skip the title, but a name that is ONLY
  // a title ("Chef") still falls through to the fallback rather than greeting
  // someone as "Chef" by accident of parsing.
  const first = parts.find((tok) => !TITLES.has(tok.toLowerCase()));
  return first || fallback;
}

module.exports = { firstNameOf };
