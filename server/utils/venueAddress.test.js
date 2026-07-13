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

// Regression guard: a named venue with no street must NOT geocode to the bare city.
// Returning 'Chicago, Illinois' here is truthy, so it wins over the caller's
// `|| event_location` fallback and routes staff to the city centroid instead of the
// venue. Most rows have no street (35 of 206 in prod), so this is the common path.
test('composeVenueMapQuery returns null for a named venue with no street (falls back to event_location)', () => {
  assert.equal(
    composeVenueMapQuery({ venue_name: 'Trigger Chicago', venue_city: 'Chicago', venue_state: 'Illinois' }),
    null,
  );
});

test('composeVenueMapQuery geocodes the address only when a street is present', () => {
  assert.equal(
    composeVenueMapQuery({
      venue_name: 'Trigger Chicago',
      venue_street: '2005 W Fulton St',
      venue_city: 'Chicago',
      venue_state: 'Illinois',
      venue_zip: '60612',
    }),
    '2005 W Fulton St, Chicago, Illinois 60612',
  );
});

test('composeVenueMapQuery treats a whitespace-only street as no street', () => {
  assert.equal(
    composeVenueMapQuery({ venue_name: 'X', venue_street: '   ', venue_city: 'Chicago', venue_state: 'Illinois' }),
    null,
  );
});
