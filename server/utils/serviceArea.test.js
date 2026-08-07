require('dotenv').config();

// Pure unit tests for the service-area geometry (spec §6). No DB, no network:
// the band table and the distance helpers are the only things under test here.
// The lock lifecycle and the routes are covered by shifts.bonus.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  HOME_BASE,
  OUT_OF_AREA_MAX_CENTS,
  suggestOutOfAreaCents,
  milesFromHomeBase,
  milesBetween,
  roundMiles,
} = require('./serviceArea');

if (process.env.NODE_ENV === 'production') {
  throw new Error('serviceArea.test.js refuses to run against production');
}

test('HOME_BASE is the DRB storage (1500 S Blue Island Ave)', () => {
  assert.equal(HOME_BASE.lat, 41.8612);
  assert.equal(HOME_BASE.lng, -87.6586);
});

test('cap matches the DB CHECK', () => {
  assert.equal(OUT_OF_AREA_MAX_CENTS, 25000);
});

test('suggestOutOfAreaCents: band boundaries are half-open [lo, hi)', () => {
  // Under 40 miles is not out of area at all.
  assert.equal(suggestOutOfAreaCents(0), null);
  assert.equal(suggestOutOfAreaCents(39.99), null);
  // [40, 60) -> $10
  assert.equal(suggestOutOfAreaCents(40), 1000);
  assert.equal(suggestOutOfAreaCents(59.99), 1000);
  // [60, 90) -> $20
  assert.equal(suggestOutOfAreaCents(60), 2000);
  assert.equal(suggestOutOfAreaCents(85), 2000);
  assert.equal(suggestOutOfAreaCents(89.99), 2000);
  // [90, 120) -> $35
  assert.equal(suggestOutOfAreaCents(90), 3500);
  assert.equal(suggestOutOfAreaCents(119.99), 3500);
  // Beyond 120 is a custom judgment call, not "no bonus".
  assert.equal(suggestOutOfAreaCents(120), null);
  assert.equal(suggestOutOfAreaCents(500), null);
});

test('suggestOutOfAreaCents: non-finite input never suggests', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, 'far', {}, '']) {
    assert.equal(suggestOutOfAreaCents(bad), null, `bad input ${String(bad)}`);
  }
  // A negative distance is nonsense but must not crash or suggest.
  assert.equal(suggestOutOfAreaCents(-50), null);
});

test('suggestOutOfAreaCents: numeric strings are tolerated (pg NUMERIC shape)', () => {
  assert.equal(suggestOutOfAreaCents('85'), 2000);
  assert.equal(suggestOutOfAreaCents('40.0'), 1000);
});

test('milesFromHomeBase: home base to itself is zero', () => {
  assert.equal(roundMiles(milesFromHomeBase(HOME_BASE.lat, HOME_BASE.lng)), 0);
});

test('milesFromHomeBase: Madison WI lands in the custom-beyond-120 zone', () => {
  // Madison, WI ~ (43.0731, -89.4012): roughly 120 miles from the Blue Island storage.
  const miles = milesFromHomeBase(43.0731, -89.4012);
  assert.ok(miles > 110 && miles < 135, `expected ~120 mi, got ${miles}`);
});

test('milesFromHomeBase: Rockford IL lands in the $20 band', () => {
  // Rockford, IL ~ (42.2711, -89.0940).
  const miles = milesFromHomeBase(42.2711, -89.0940);
  assert.ok(miles >= 60 && miles < 90, `expected the 60-90 band, got ${miles}`);
  assert.equal(suggestOutOfAreaCents(miles), 2000);
});

test('milesFromHomeBase: a downtown Chicago venue is well under the 40-mile floor', () => {
  const miles = milesFromHomeBase(41.8781, -87.6298);
  assert.ok(miles < 5, `expected a short hop, got ${miles}`);
  assert.equal(suggestOutOfAreaCents(miles), null);
});

test('milesBetween / milesFromHomeBase: a missing coordinate on EITHER side is null', () => {
  assert.equal(milesFromHomeBase(null, -87.65), null);
  assert.equal(milesFromHomeBase(41.85, null), null);
  assert.equal(milesFromHomeBase(undefined, undefined), null);
  assert.equal(milesBetween(41.85, -87.65, null, null), null);
  assert.equal(milesBetween(null, null, 41.85, -87.65), null);
  assert.equal(milesBetween('', '', 41.85, -87.65), null);
});

test('milesBetween: pg NUMERIC strings coerce', () => {
  const miles = milesBetween('41.857000', '-87.656000', '41.857000', '-87.656000');
  assert.equal(roundMiles(miles), 0);
});

test('roundMiles: one decimal, null-safe', () => {
  assert.equal(roundMiles(12.34), 12.3);
  assert.equal(roundMiles(12.35), 12.4);
  assert.equal(roundMiles(null), null);
  assert.equal(roundMiles(undefined), null);
});
