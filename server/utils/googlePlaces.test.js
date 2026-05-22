'use strict';

// Pure-function tests for the Google Places venue mapper. Run:
//   node server/utils/googlePlaces.test.js
// No network, no DB — exercises mapPlaceToVenue only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapPlaceToVenue } = require('./googlePlaces');

function comp(longText, ...types) {
  return { longText, shortText: longText, types };
}
function place(components, name) {
  return { displayName: { text: name }, addressComponents: components };
}

test('maps a full in-area address', () => {
  const result = mapPlaceToVenue(place([
    comp('123', 'street_number'),
    comp('Oak Road', 'route'),
    comp('Springfield', 'locality'),
    comp('Illinois', 'administrative_area_level_1'),
    comp('62704', 'postal_code'),
  ], 'The Wedding Barn'));
  assert.deepEqual(result, {
    venue_name: 'The Wedding Barn',
    venue_street: '123 Oak Road',
    venue_city: 'Springfield',
    venue_state: 'Illinois',
    venue_zip: '62704',
  });
});

test('drops the address for an out-of-area state, keeps the name', () => {
  const result = mapPlaceToVenue(place([
    comp('1 Main St', 'route'),
    comp('Columbus', 'locality'),
    comp('Ohio', 'administrative_area_level_1'),
  ], 'Some Ohio Hall'));
  assert.deepEqual(result, { venue_name: 'Some Ohio Hall' });
});

test('omits fields Google did not return', () => {
  const result = mapPlaceToVenue(place([
    comp('Milwaukee', 'locality'),
    comp('Wisconsin', 'administrative_area_level_1'),
  ], 'Lakeside Venue'));
  assert.deepEqual(result, {
    venue_name: 'Lakeside Venue',
    venue_city: 'Milwaukee',
    venue_state: 'Wisconsin',
  });
});

test('falls back to postal_town when locality is absent', () => {
  const result = mapPlaceToVenue(place([
    comp('Lansing', 'postal_town'),
    comp('Michigan', 'administrative_area_level_1'),
  ], 'Town Hall'));
  assert.equal(result.venue_city, 'Lansing');
});

test('omits the street when Google returns a number but no route', () => {
  const result = mapPlaceToVenue(place([
    comp('500', 'street_number'),
    comp('Chicago', 'locality'),
    comp('Illinois', 'administrative_area_level_1'),
  ], 'Numbered Place'));
  assert.deepEqual(result, {
    venue_name: 'Numbered Place',
    venue_city: 'Chicago',
    venue_state: 'Illinois',
  });
});

test('returns an empty object for junk input', () => {
  assert.deepEqual(mapPlaceToVenue(null), {});
  assert.deepEqual(mapPlaceToVenue({}), {});
});
