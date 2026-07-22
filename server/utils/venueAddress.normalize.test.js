require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVenueState, validateVenue, VENUE_STATES } = require('./venueAddress');

// Regression for the 2026-07-21 finding: legacy writers stored 'IL'-style
// abbreviations; the strict VENUE_STATES check then rejected every admin save
// on those rows ("Select a valid state"), locking 11 booked prod events out
// of editing entirely.

test('abbreviations canonicalize to full names', () => {
  assert.equal(normalizeVenueState('IL'), 'Illinois');
  assert.equal(normalizeVenueState('il'), 'Illinois');
  assert.equal(normalizeVenueState(' WI '), 'Wisconsin');
  assert.equal(normalizeVenueState('MI'), 'Michigan');
  assert.equal(normalizeVenueState('MN'), 'Minnesota');
  assert.equal(normalizeVenueState('IN'), 'Indiana');
});

test('full names pass through, case-insensitively canonicalized', () => {
  for (const st of VENUE_STATES) {
    assert.equal(normalizeVenueState(st), st);
    assert.equal(normalizeVenueState(st.toLowerCase()), st);
    assert.equal(normalizeVenueState(st.toUpperCase()), st);
  }
});

test('unknown values return trimmed as-is (validator still rejects them)', () => {
  assert.equal(normalizeVenueState('California'), 'California');
  assert.equal(normalizeVenueState('CA'), 'CA');
  assert.equal(normalizeVenueState('  Ontario '), 'Ontario');
});

test('null/undefined/empty pass through untouched (COALESCE writers rely on it)', () => {
  assert.equal(normalizeVenueState(null), null);
  assert.equal(normalizeVenueState(undefined), undefined);
  assert.equal(normalizeVenueState(''), '');
  assert.equal(normalizeVenueState('   '), '');
});

test('validateVenue accepts legacy abbreviations (the un-editable-event bug)', () => {
  const errs = validateVenue({ venue_name: 'BrighterDaze Farm', venue_city: 'Newark', venue_state: 'IL' });
  assert.equal(errs.venue_state, undefined, 'IL must validate as Illinois');
});

test('validateVenue still rejects out-of-area states', () => {
  const errs = validateVenue({ venue_state: 'California' });
  assert.equal(errs.venue_state, 'Select a valid state');
  const errs2 = validateVenue({ venue_state: 'CA' });
  assert.equal(errs2.venue_state, 'Select a valid state');
});
