// PORT of server/utils/staffDisplayName.js + staffDisplayName.validate.js.
// The browser needs the live preview without a round trip per keystroke, and
// CRA cannot import from outside client/src. The server is the source of truth
// and validates every write regardless of what happens here.
//
// If you change the rule, change BOTH files and BOTH case tables:
//   server/utils/staffDisplayName.test.js
//   client/src/utils/preferredName.test.js

// Leading titles are a form of address, not a name ("Miss Taylor"). Shared with
// the validator below.
export const TITLES = new Set([
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
  return tok.charAt(0).toUpperCase() + tok.slice(1);
}

export function computeDisplayName({ preferredName, legalFullName } = {}) {
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
    lastInitial = legal[legal.length - 1].charAt(0).toUpperCase();
  } else if (pref.length >= 2) {
    initialSource = 'preferred';
    lastInitial = pref[pref.length - 1].charAt(0).toUpperCase();
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
  if (short.length === 0) short = [pref[0]];

  const shortStr = short.map(fixCase).join(' ');
  return lastInitial ? `${shortStr} ${lastInitial}.` : shortStr;
}

// Format validation for contractor_profiles.preferred_name. Spec §3.4.
//
// This is about SHAPE, not worth. It is deliberately narrow so that real names
// never trip: there is no camelCase detection, because McKenna, DeShawn and
// LaToya are real names and `LumpyIceCream` is not worth breaking them over.
// A well-formed handle passes this function and always will. The onboarding
// copy is what prevents that, and the §3.5 notice is how it gets noticed.
export const MIN_LEN = 2;
export const MAX_LEN = 20;
// Must start with a letter; may then contain letters, spaces, hyphens,
// apostrophes and periods. Allows "D.J.", "Mary-Kate", "O'Brien" — and any
// Unicode letter (\p{L}), so "José" and "Renée" are settable (widened
// 2026-08-14; keep in sync with server/utils/staffDisplayName.validate.js).
const NAME_CHARS = /^[\p{L}][\p{L} .'-]*$/u;

function norm(v) {
  return String(v === null || v === undefined ? '' : v).trim().replace(/\s+/g, ' ');
}

export function validatePreferredName(raw) {
  const t = norm(raw);
  if (!t) return { valid: false, error: 'Tell us what to call you.' };
  if (t.length < MIN_LEN) return { valid: false, error: 'That is a little short. Use at least 2 characters.' };
  if (t.length > MAX_LEN) return { valid: false, error: 'Keep it to 20 characters or fewer.' };
  if (!NAME_CHARS.test(t)) {
    return { valid: false, error: 'Letters only, plus hyphens, apostrophes and periods.' };
  }
  const parts = t.split(' ');
  if (parts.length > 2) {
    return { valid: false, error: 'One or two words. Pick the one you actually go by.' };
  }
  if (TITLES.has(parts[0].toLowerCase())) {
    return { valid: false, error: 'Skip the title, just the name you go by.' };
  }
  return { valid: true, value: t };
}
