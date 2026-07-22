const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harvestTickEvery, isHarvestTick, rolloverDay, underCap } = require('./cadence');

// The piggyback math is load-bearing: a drifted N silently changes the
// harvest cadence and nothing downstream would notice.

test('defaults: 5-minute harvest over 25s ticks = every 12th tick', () => {
  assert.equal(harvestTickEvery(5 * 60 * 1000, 25000), 12);
});

test('non-dividing intervals round UP (never harvest more often than asked)', () => {
  assert.equal(harvestTickEvery(300000, 45000), 7);  // 6.67 -> 7
  assert.equal(harvestTickEvery(60000, 25000), 3);   // 2.4 -> 3
});

test('degenerate inputs collapse to every tick, never 0 or NaN', () => {
  for (const bad of [0, -5, NaN, undefined, null, 'x']) {
    assert.equal(harvestTickEvery(bad, 25000), 1, `harvest=${bad}`);
    assert.equal(harvestTickEvery(300000, bad), 1, `reply=${bad}`);
  }
  assert.equal(harvestTickEvery(10000, 25000), 1, 'harvest faster than tick clamps to every tick');
});

test('isHarvestTick: tick 0 harvests (first pass after boot), then every Nth', () => {
  const every = 12;
  const harvests = [];
  for (let t = 0; t < 25; t += 1) if (isHarvestTick(t, every)) harvests.push(t);
  assert.deepEqual(harvests, [0, 12, 24]);
});

test('isHarvestTick: every<=1 harvests every tick; junk ticks never harvest', () => {
  assert.ok(isHarvestTick(5, 1));
  assert.ok(isHarvestTick(5, 0));
  assert.equal(isHarvestTick(-1, 12), false);
  assert.equal(isHarvestTick(1.5, 12), false);
});

test('rolloverDay resets BOTH counters on a new UTC day, preserves within-day counts', () => {
  const c = { day: 20, today: 7, repliesToday: 3 };
  rolloverDay(c, 20);
  assert.deepEqual(c, { day: 20, today: 7, repliesToday: 3 });
  rolloverDay(c, 21);
  assert.deepEqual(c, { day: 21, today: 0, repliesToday: 0 });
});

test('underCap boundary: cap reached means stop', () => {
  assert.ok(underCap(39, 40));
  assert.equal(underCap(40, 40), false);
  assert.ok(underCap(999, NaN), 'unparseable cap fails open (existing daily-cap guard upstream)');
});
