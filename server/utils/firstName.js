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
 * COUPLES are preserved. A client stored as "Aubrey & Dominic" names two
 * people, so taking the first token would drop one of them from every message
 * the system sends. Nine client rows are stored this way and nearly all of them
 * are weddings, which is the worst place to greet only half the couple. Each
 * side is narrowed on its own and rejoined with the joiner the data actually
 * used, so "Aubrey Smith & Dominic Jones" greets as "Aubrey & Dominic".
 *
 * @param {string|null|undefined} fullName
 * @param {string} [fallback='there'] - used when nothing usable remains
 * @returns {string}
 */

// Requires whitespace on BOTH sides so a name that merely contains the letters
// ("Alexander", "Andrea") is never split.
const JOINER = /\s+(&|\+|and)\s+/i;

// The greeting name for ONE person. find(), not [0]: "Dr. Monica" must skip the
// title, but a name that is ONLY a title ("Chef") yields nothing rather than
// greeting someone as "Chef" by accident of parsing. The \p{L} test drops
// punctuation-only tokens (a stray "&") while still accepting any script, so
// "Zoë" and "李 小龍" are unaffected.
function greetingToken(segment) {
  const parts = String(segment === null || segment === undefined ? '' : segment)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.find((tok) => /\p{L}/u.test(tok) && !TITLES.has(tok.toLowerCase())) || '';
}

function firstNameOf(fullName, fallback = 'there') {
  const raw = String(fullName === null || fullName === undefined ? '' : fullName).trim();

  // split() with a capture group interleaves the joiners: ["Aubrey", "&", "Dominic"].
  const segments = raw.split(JOINER);
  if (segments.length === 1) return greetingToken(raw) || fallback;

  let out = '';
  for (let i = 0; i < segments.length; i += 2) {
    const one = greetingToken(segments[i]);
    if (!one) continue;
    // segments[i - 1] is the joiner that preceded this name, kept verbatim so
    // "and" does not silently become "&".
    out = out ? `${out} ${segments[i - 1]} ${one}` : one;
  }
  return out || fallback;
}

module.exports = { firstNameOf };
