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
// apostrophes and periods. Allows "D.J.", "Mary-Kate", "O'Brien".
const NAME_CHARS = /^[A-Za-z][A-Za-z .'-]*$/;

function norm(v) {
  return String(v === null || v === undefined ? '' : v).trim().replace(/\s+/g, ' ');
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
