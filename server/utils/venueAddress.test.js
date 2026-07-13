const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composeVenueLocation, composeVenueMapQuery } = require('./venueAddress');

const FULL = {
  venue_name: 'Citadel Banquet Hall',
  venue_street: '410 E North Ave',
  venue_city: 'Chicago',
  venue_state: 'Illinois',
  venue_zip: '60611',
};

test('composeVenueMapQuery excludes the venue name (the "title")', () => {
  const q = composeVenueMapQuery(FULL);
  assert.equal(q, '410 E North Ave, Chicago, Illinois 60611');
  assert.ok(!q.includes('Citadel'), 'venue name must not leak into the maps query');
  // Regression guard: the display string still leads with the name.
  assert.ok(composeVenueLocation(FULL).startsWith('Citadel Banquet Hall'));
});

test('composeVenueMapQuery omits ZIP when absent', () => {
  const { venue_zip, ...noZip } = FULL;
  assert.equal(composeVenueMapQuery(noZip), '410 E North Ave, Chicago, Illinois');
});

test('composeVenueMapQuery returns null when there is nothing to geocode', () => {
  assert.equal(composeVenueMapQuery({ venue_name: 'Some Place' }), null);
  assert.equal(composeVenueMapQuery({}), null);
  assert.equal(composeVenueMapQuery(null), null);
  assert.equal(composeVenueMapQuery(undefined), null);
});

test('composeVenueMapQuery still geocodes a city/state-only address', () => {
  assert.equal(
    composeVenueMapQuery({ venue_name: 'X', venue_city: 'Chicago', venue_state: 'Illinois' }),
    'Chicago, Illinois',
  );
});
