'use strict';

// Format validation for contractor_profiles.preferred_name. Spec §3.4.
//
// This is about SHAPE, not worth. It is deliberately narrow so that real names
// never trip: there is no camelCase detection, because McKenna, DeShawn and
// LaToya are real names and `LumpyIceCream` is not worth breaking them over.
// A well-formed handle passes this function and always will. The onboarding
// copy is what prevents that, and the §3.5 notice is how it gets noticed.

const { TITLES } = require('./staffDisplayName');

const MIN_LEN = 2;
const MAX_LEN = 20;
// Must start with a letter; may then contain letters, spaces, hyphens,
// apostrophes and periods. Allows "D.J.", "Mary-Kate", "O'Brien" — and any
// Unicode letter (\p{L}), so "José" and "Renée" are settable (widened
// 2026-08-14, Dallas call; keep in sync with client/src/utils/preferredName.js).
const NAME_CHARS = /^[\p{L}][\p{L} .'-]*$/u;

// Curly apostrophes only. U+2018/U+2019 are what an iPhone, macOS and Word all
// substitute for a typed ', so "O'Brien" arrives as punctuation the letter class
// rejects, and the rejection says apostrophes are allowed. Deliberately NOT
// folded: U+02BC and U+02BB (the Hawaiian okina), which are Unicode LETTERS,
// already pass, and rewriting them would corrupt an orthography to fix nothing.
const CURLY_APOSTROPHE = /[\u2018\u2019]/g;

function norm(v) {
  return String(v === null || v === undefined ? '' : v)
    // NFC first. A decomposed "e" + U+0301 is a letter followed by a COMBINING
    // MARK, and \p{L} does not match marks, so NFD "Jose" with an accent failed
    // the same letters-only test that NFC "Jose" with an accent passes. Which
    // form arrives depends on the keyboard and the paste source, not the name.
    .normalize('NFC')
    .replace(CURLY_APOSTROPHE, "'")
    .trim()
    .replace(/\s+/g, ' ');
}

function validatePreferredName(raw) {
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

/**
 * Validate a name that is CHANGING. An unchanged value always passes, however
 * malformed, so nobody is locked out of editing their own phone number by a
 * legacy name they cannot fix through the form (spec §3.4 grandfathering).
 * Every write path uses this, not validatePreferredName directly.
 */
function validatePreferredNameChange(submitted, stored) {
  const s = norm(submitted);
  const prev = norm(stored);
  if (prev !== '' && s === prev) return { valid: true, value: prev };
  return validatePreferredName(submitted);
}

module.exports = { validatePreferredName, validatePreferredNameChange, MIN_LEN, MAX_LEN };
