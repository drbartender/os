'use strict';

// Staff display name: the preferred name the person gave us, plus one initial
// taken from their legal surname. Spec:
//   docs/superpowers/specs/2026-07-26-staff-display-name-design.md
//
// THE RULE (spec §2): the preferred name is authoritative. The legal name
// supplies the last initial, plus one narrow fallback when the person gave us
// NO preferred name at all (better "Nevver S." than "nsayles@gmail.com" on a
// client-facing BEO). It never displaces a name someone did give us: a person
// who says "Joey" is "Joey K." forever, never "Joseph". There is deliberately
// no heuristic relating the two names.

// Leading titles are a form of address, not a name ("Miss Taylor"). Shared with
// the validator in staffDisplayName.validate.js.
const TITLES = new Set([
  'miss', 'ms', 'ms.', 'mrs', 'mrs.', 'mr', 'mr.', 'dr', 'dr.', 'chef',
  'sir', 'madam', 'master', 'coach', 'captain', 'capt', 'capt.',
  'prof', 'prof.', 'rev', 'rev.',
]);

function tokens(s) {
  return String(s === null || s === undefined ? '' : s).trim().split(/\s+/).filter(Boolean);
}

// A bare middle initial: "D" or "D." Never belongs in a display name.
function isMiddleInitial(tok) {
  return /^[A-Za-z]\.?$/.test(tok);
}

// Capitalize a token only when it is at least 3 characters AND entirely
// lowercase. The length floor exists so the connector in "Nicholas or Nick"
// does not become "Or". Mixed case is never touched, because LaToya, McKenna
// and d'Angelo are correct as typed. This is a two-line repair for the one
// all-lowercase row on production (`veronica martinez`), NOT a title-caser.
// Known imperfection: lowercase name particles (van, del, mac) are 3 chars and
// would be promoted. The escape hatch is that typing mixed case wins.
function fixCase(tok) {
  if (tok.length < 3) return tok;
  if (tok !== tok.toLowerCase()) return tok;
  // Spread, not charAt/slice: charAt(0) on a token whose first character is
  // outside the BMP returns a lone UTF-16 surrogate, which encodes to U+FFFD
  // on the way into Postgres and renders the person as "�..." forever.
  const [first, ...rest] = [...tok];
  return first.toUpperCase() + rest.join('');
}

// One display-safe initial from a token. Same surrogate rule as fixCase: a
// name starting with an astral-plane character must yield that whole
// character, never half of it.
function firstChar(tok) {
  return [...String(tok)][0] || '';
}

function computeDisplayName({ preferredName, legalFullName } = {}) {
  const pref = tokens(preferredName);
  const legal = tokens(legalFullName);
  if (pref.length === 0 && legal.length === 0) return null;

  // Where does the last initial come from? Prefer the legal surname; fall back
  // to the preferred name's own last token when the agreement is single-token
  // or missing; otherwise there is no initial and we do NOT invent one.
  let initialSource = null;
  let lastInitial = '';
  if (legal.length >= 2) {
    initialSource = 'legal';
    lastInitial = firstChar(legal[legal.length - 1]).toUpperCase();
  } else if (pref.length >= 2) {
    initialSource = 'preferred';
    lastInitial = firstChar(pref[pref.length - 1]).toUpperCase();
  }

  let short;
  if (pref.length === 0) {
    // No preferred name at all: legal first name. Nothing is being displaced.
    short = [legal[0]];
  } else if (initialSource === 'legal') {
    // Drop a trailing token ONLY when it repeats the legal SURNAME. Matching
    // against every legal token would eat the "Jean" in "Billie Jean", whose
    // legal name is "Billie Jean Barrone", and a two-part given name is exactly
    // what she asked to be called.
    const surname = legal[legal.length - 1].toLowerCase();
    short = pref.slice();
    if (short.length > 1 && short[short.length - 1].toLowerCase() === surname) short.pop();
  } else if (initialSource === 'preferred') {
    short = pref.slice(0, -1);
  } else {
    short = pref.slice();
  }
  while (short.length > 1 && isMiddleInitial(short[short.length - 1])) short.pop();
  // Defensive only (unreachable today: every branch above leaves >= 1 token).
  // The || keeps a future edit from ever rendering the string "undefined" as
  // a person's name.
  if (short.length === 0) short = [pref[0] || legal[0]];

  const shortStr = short.map(fixCase).join(' ');
  return lastInitial ? `${shortStr} ${lastInitial}.` : shortStr;
}

module.exports = { computeDisplayName, TITLES };
