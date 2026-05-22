'use strict';

// Google Places (New) proxy for venue-name search. Pure HTTP wrapper, no DB.
// Fails soft on every path: returns [] or null, never throws — so the
// venue-name field degrades to a plain text input when the key is missing or
// Google is unreachable. Mirrors the server-mediated pattern of stripeClient.js.

const { VENUE_STATES } = require('./venueAddress');

const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const DETAILS_URL = 'https://places.googleapis.com/v1/places/';

// Length caps on user-supplied input. Enforced in this util so the bound
// travels with the function, not only with the route handler.
const MAX_QUERY_LEN = 200;
const MIN_QUERY_LEN = 3;
const MAX_PLACE_ID_LEN = 300;
const MAX_TOKEN_LEN = 100;

// Coarse bounding box over the five service-area states (IL, IN, MI, MN, WI).
// Biases autocomplete results toward the region; VENUE_STATES is the precise
// gate (see mapPlaceToVenue).
const REGION_RECTANGLE = {
  low: { latitude: 36.95, longitude: -97.3 },
  high: { latitude: 49.4, longitude: -82.0 },
};

function isConfigured() {
  return !!process.env.GOOGLE_PLACES_API_KEY;
}

// Long text of the first address component matching a Google type.
function pick(components, type) {
  const c = (components || []).find(
    (x) => Array.isArray(x.types) && x.types.includes(type),
  );
  return c ? (c.longText || c.shortText || '') : '';
}

/**
 * Map a Google Place Details response to our structured venue. Pure.
 * Returns an object holding ONLY the fields that have a value (always
 * venue_name when Google supplied a name). Service-area guard: when the
 * resolved state is not one of VENUE_STATES, the address fields are dropped
 * and only venue_name is returned.
 * @param {object} place Google Place Details JSON
 * @returns {{venue_name?:string,venue_street?:string,venue_city?:string,venue_state?:string,venue_zip?:string}}
 */
function mapPlaceToVenue(place) {
  if (!place || typeof place !== 'object') return {};
  const components = place.addressComponents || [];
  // A usable street needs a route (the street name). A street_number with no
  // route is not a street, so venue_street stays empty in that case.
  const route = pick(components, 'route');
  const street = route
    ? [pick(components, 'street_number'), route].filter(Boolean).join(' ')
    : '';
  const city = pick(components, 'locality')
    || pick(components, 'postal_town')
    || pick(components, 'sublocality_level_1');
  const state = pick(components, 'administrative_area_level_1');
  const zip = pick(components, 'postal_code');
  const name = (place.displayName && place.displayName.text) || '';

  const venue = {};
  if (name) venue.venue_name = name;

  // Out-of-area: keep the name, drop the address.
  if (state && !VENUE_STATES.includes(state)) return venue;

  if (street) venue.venue_street = street;
  if (city) venue.venue_city = city;
  if (state) venue.venue_state = state;
  if (zip) venue.venue_zip = zip;
  return venue;
}

/**
 * Autocomplete a venue-name query. Returns [] when not configured, when the
 * query is under 3 characters, or on any error.
 * @param {string} input
 * @param {string} sessionToken
 * @returns {Promise<Array<{place_id:string,name:string,address:string}>>}
 */
async function searchVenues(input, sessionToken) {
  if (!isConfigured()) return [];
  const q = String(input || '').trim().slice(0, MAX_QUERY_LEN);
  if (q.length < MIN_QUERY_LEN) return [];
  const token = String(sessionToken || '').slice(0, MAX_TOKEN_LEN);
  try {
    const res = await fetch(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
      },
      body: JSON.stringify({
        input: q,
        sessionToken: token || undefined,
        includedRegionCodes: ['us'],
        // locationBias (not locationRestriction): bias results toward the
        // service-area box but still allow strong matches just outside it.
        // VENUE_STATES in mapPlaceToVenue is the precise in-area gate.
        locationBias: { rectangle: REGION_RECTANGLE },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.suggestions || [])
      .filter((s) => s.placePrediction)
      .map((s) => {
        const p = s.placePrediction;
        const sf = p.structuredFormat || {};
        return {
          place_id: p.placeId || '',
          name: (sf.mainText && sf.mainText.text) || (p.text && p.text.text) || '',
          address: (sf.secondaryText && sf.secondaryText.text) || '',
        };
      })
      .filter((r) => r.place_id && r.name);
  } catch (err) {
    // Log err.message only; never log the API key or the request URL.
    console.error('[googlePlaces] searchVenues error:', err.message);
    return [];
  }
}

/**
 * Fetch place details and map to a structured venue. Returns null when not
 * configured, when placeId is missing or empty, when Google returns nothing
 * usable, or on any error.
 * @param {string} placeId
 * @param {string} sessionToken
 * @returns {Promise<object|null>}
 */
async function getVenueDetails(placeId, sessionToken) {
  if (!isConfigured()) return null;
  const id = String(placeId || '').slice(0, MAX_PLACE_ID_LEN);
  if (!id) return null;
  const token = String(sessionToken || '').slice(0, MAX_TOKEN_LEN);
  try {
    const url = `${DETAILS_URL}${encodeURIComponent(id)}`
      + (token ? `?sessionToken=${encodeURIComponent(token)}` : '');
    const res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'addressComponents,displayName',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const venue = mapPlaceToVenue(data);
    // An empty map means Google returned nothing usable; report a miss so the
    // documented object|null contract holds (callers expect at least a name).
    return Object.keys(venue).length > 0 ? venue : null;
  } catch (err) {
    // Log err.message only; never log the API key or the request URL.
    console.error('[googlePlaces] getVenueDetails error:', err.message);
    return null;
  }
}

module.exports = {
  isConfigured,
  searchVenues,
  getVenueDetails,
  mapPlaceToVenue,
  REGION_RECTANGLE,
};
