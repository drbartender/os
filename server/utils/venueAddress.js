// Structured venue address: compose + validate. Pure, no DB calls.
// event_location and shifts.location are derived from these fields.
// VENUE_STATES + composeVenueLocation are mirrored client-side in
// client/src/components/VenueAddressFields.js (VENUE_STATES + formatVenue) —
// kept in sync manually (same pattern as eventTypes.js). Edit both together.

const VENUE_STATES = ['Illinois', 'Indiana', 'Michigan', 'Minnesota', 'Wisconsin'];

// Postal codes for the service area. Legacy writers (CC import, older Places
// short_name fallbacks) stored 'IL'-style abbreviations, which the strict
// VENUE_STATES check then rejected on EVERY subsequent admin save of those
// rows ("Select a valid state" with a value the system itself wrote; 11 booked
// prod events were un-editable this way, found 2026-07-21).
const STATE_CODE_TO_NAME = { IL: 'Illinois', IN: 'Indiana', MI: 'Michigan', MN: 'Minnesota', WI: 'Wisconsin' };

/**
 * Canonicalize a state input: full names (any case) and service-area postal
 * abbreviations map to the canonical VENUE_STATES entry; anything else returns
 * trimmed as-is so validateVenue still rejects genuine garbage. null/undefined
 * pass through untouched — COALESCE writers rely on "absent = keep stored".
 */
function normalizeVenueState(raw) {
  if (raw === null || raw === undefined) return raw;
  const v = String(raw).trim();
  if (!v) return v;
  const byCode = STATE_CODE_TO_NAME[v.toUpperCase()];
  if (byCode) return byCode;
  const byName = VENUE_STATES.find((st) => st.toLowerCase() === v.toLowerCase());
  return byName || v;
}
// Linear-time: fully anchored, fixed-length quantifiers, no ambiguous
// backtracking — the detect-unsafe-regex heuristic flags the optional group
// as a false positive here.
// eslint-disable-next-line security/detect-unsafe-regex
const ZIP_RE = /^\d{5}(-\d{4})?$/;

function s(v) { return (v === null || v === undefined ? '' : String(v)).trim(); }

/**
 * Join non-empty parts: [name, street, "City, State Zip"].
 * City/state only → "Chicago, Illinois" (byte-identical to legacy event_location).
 * Returns null when nothing is set.
 */
function composeVenueLocation(v = {}) {
  const name = s(v.venue_name);
  const street = s(v.venue_street);
  const city = s(v.venue_city);
  const state = s(v.venue_state);
  const zip = s(v.venue_zip);
  const cityState = [city, state].filter(Boolean).join(', ');
  const cityStateZip = [cityState, zip].filter(Boolean).join(' ');
  return [name, street, cityStateZip].filter(Boolean).join(', ') || null;
}

/**
 * Address-only Google Maps `?query=` string: [street, "City, State Zip"].
 * Deliberately EXCLUDES venue_name. The maps query param is a free-text search,
 * not a geocode; leading with the venue name makes Google match the name (often
 * a different same-named place, or a vague area) instead of the street address.
 * Returns null when there is no street/city to geocode, so callers fall back to
 * the full composed event_location (legacy rows that only have a free-text one).
 * Mirrored client-side as venueMapQuery in
 * client/src/components/VenueAddressFields.js — keep in sync.
 */
function composeVenueMapQuery(v) {
  const o = v || {};
  const street = s(o.venue_street);
  // No street means the venue NAME is the only thing that locates this place, so there
  // is nothing better to geocode: return null and let the caller fall back to the full
  // composed event_location (which includes the name). Dropping the name here without a
  // street to replace it would send staff to a city centroid instead of the venue --
  // most rows have no street (35 of 206 in prod at time of writing), so that fallback is
  // the common path, not the edge case.
  if (!street) return null;
  const city = s(o.venue_city);
  const state = s(o.venue_state);
  const zip = s(o.venue_zip);
  const cityState = [city, state].filter(Boolean).join(', ');
  const cityStateZip = [cityState, zip].filter(Boolean).join(' ');
  return [street, cityStateZip].filter(Boolean).join(', ') || null;
}

/** True when the address is "complete enough" to dispatch staff. */
function isVenueComplete(v = {}) {
  return !!(s(v.venue_street) && s(v.venue_city) && s(v.venue_state));
}

/**
 * Validate a venue payload. Returns a fieldErrors object (empty = valid).
 * @param {object} v
 * @param {object} opts { requireStreet, requireCityState }
 */
function validateVenue(v = {}, opts = {}) {
  const { requireStreet = false, requireCityState = false } = opts;
  const e = {};
  const name = s(v.venue_name);
  const street = s(v.venue_street);
  const city = s(v.venue_city);
  // Validate the CANONICAL form: legacy 'IL'-style rows must not be rejected
  // on unrelated edits. Writers normalize at persist; this keeps the validator
  // in agreement even for a writer that misses it.
  const state = normalizeVenueState(s(v.venue_state));
  const zip = s(v.venue_zip);

  if (requireStreet && !street) e.venue_street = 'Street address is required';
  if (requireCityState && !city) e.venue_city = 'City is required';
  if (requireCityState && !state) e.venue_state = 'State is required';

  if (name.length > 200) e.venue_name = 'Venue name is too long';
  if (street.length > 200) e.venue_street = 'Street address is too long';
  if (city.length > 120) e.venue_city = 'City is too long';
  if (state && !VENUE_STATES.includes(state)) e.venue_state = 'Select a valid state';
  if (zip && !ZIP_RE.test(zip)) e.venue_zip = 'Enter a valid ZIP (e.g. 60601)';

  return e;
}

module.exports = { VENUE_STATES, composeVenueLocation, composeVenueMapQuery, isVenueComplete, validateVenue, normalizeVenueState };
