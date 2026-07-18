// Pure-function tests for the quantity engine (no DB). Run:
//   node --test server/utils/quantityEngine.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { computeDemand, resolveSplit, apportion } = require('./quantityEngine');

const DEFAULTS = { cocktails: 45, beer: 30, wine: 25 };

test('the quantity-review canvas fixture: 100 guests, 60 drinkers, 4h, pace 1.0, cocktail-forward on 45/30/25 -> 240 pours at 55/25/20 = 132/60/48', () => {
  const demand = computeDemand({
    guestCount: 100,
    drinkers: 60,
    profile: 'cocktail_forward',
    hours: 4,
    pace: 1.0,
    splitDefaults: DEFAULTS,
    counts: { cocktails: 3 },
  });
  assert.equal(demand.pours, 240);
  assert.equal(Math.round(demand.splitPct.cocktails), 55);
  assert.equal(Math.round(demand.splitPct.beer), 25);
  assert.equal(Math.round(demand.splitPct.wine), 20);
  assert.deepEqual(demand.split, { cocktails: 132, beer: 60, wine: 48 });
  // even split within category: 132 cocktail pours across 3 drinks = 44 each
  assert.equal(demand.perDrinkPours.cocktails, 44);
});

test('unknown drinkers is a real answer: falls back to 75% of guests', () => {
  const demand = computeDemand({ guestCount: 100, drinkers: null, hours: 4, pace: 1.0, splitDefaults: DEFAULTS });
  assert.equal(demand.drinkers, 75);
  assert.equal(demand.pours, 300);
});

test('profile nudges are capped at ±10 points and applied to the DEFAULT split, never even thirds', () => {
  for (const profile of ['cocktail_forward', 'beer', 'wine', 'even']) {
    const split = resolveSplit(profile, DEFAULTS);
    for (const cat of ['cocktails', 'beer', 'wine']) {
      const drift = Math.abs(split[cat] - DEFAULTS[cat]);
      assert.ok(drift <= 10.0001, `${profile}/${cat} drifted ${drift} points`);
    }
  }
});

test('help-me-decide and unknown profiles leave the defaults untouched', () => {
  assert.deepEqual(resolveSplit('help', DEFAULTS), resolveSplit(undefined, DEFAULTS));
  const split = resolveSplit('help', DEFAULTS);
  assert.equal(Math.round(split.cocktails), 45);
});

test('wine profile: 45/30/25 -> 40/25/35', () => {
  const split = resolveSplit('wine', DEFAULTS);
  assert.equal(Math.round(split.cocktails), 40);
  assert.equal(Math.round(split.beer), 25);
  assert.equal(Math.round(split.wine), 35);
});

test('drinkers clamp to guest count; zero-guest events produce zero demand', () => {
  assert.equal(computeDemand({ guestCount: 50, drinkers: 90, hours: 4, pace: 1, splitDefaults: DEFAULTS }).drinkers, 50);
  const empty = computeDemand({ guestCount: 0, drinkers: null, hours: 4, pace: 1, splitDefaults: DEFAULTS });
  assert.equal(empty.pours, 0);
  assert.deepEqual(empty.split, { cocktails: 0, beer: 0, wine: 0 });
});

test('apportion conserves pours exactly (largest remainder)', () => {
  const split = apportion(241, { cocktails: 55, beer: 25, wine: 20 });
  assert.equal(split.cocktails + split.beer + split.wine, 241);
});

test('garbage split defaults normalize to 45/30/25', () => {
  const split = resolveSplit(undefined, { cocktails: 0, beer: 0, wine: 0 });
  assert.equal(Math.round(split.cocktails), 45);
});

test('per-drink pours are null when no drinks are selected in a category', () => {
  const demand = computeDemand({ guestCount: 100, drinkers: 60, hours: 4, pace: 1, splitDefaults: DEFAULTS });
  assert.equal(demand.perDrinkPours.cocktails, null);
});
