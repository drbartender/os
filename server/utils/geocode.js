/**
 * Server-side geocoding via Nominatim (OpenStreetMap).
 * Same API the LocationInput component uses client-side.
 */

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'DrBartender/1.0';

/**
 * Geocode an address string to lat/lng coordinates.
 * @param {string} address - Full address string
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
async function geocodeAddress(address) {
  if (!address || !address.trim()) return null;

  try {
    const params = new URLSearchParams({
      format: 'json',
      limit: '1',
      countrycodes: 'us',
      q: address.trim(),
    });

    const res = await fetch(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (!data || data.length === 0) return null;

    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon), // Nominatim uses "lon"
    };
  } catch (err) {
    console.error('[Geocode] Error:', err.message);
    return null;
  }
}

/**
 * Build a full address string from parts.
 * @param {object} parts - { street_address, city, state, zip_code }
 * @returns {string}
 */
function buildAddressString(parts) {
  return [parts.street_address, parts.city, parts.state, parts.zip_code]
    .filter(Boolean)
    .join(', ');
}

/**
 * Delay helper for batched geocoding (Nominatim rate limit: 1 req/sec).
 * @param {number} ms
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { geocodeAddress, buildAddressString, delay };
