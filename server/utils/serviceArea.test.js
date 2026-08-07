require('dotenv').config();

// Pure unit tests for the service-area geometry (spec §6) and the Nominatim
// queue. No DB, no network: the queue tests inject a fake geocodeFn through
// the seam geocodeThrottled exposes for exactly this purpose.
// The lock lifecycle and the routes are covered by shifts.bonus.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  HOME_BASE,
  OUT_OF_AREA_MAX_CENTS,
  GEOCODE_MIN_INTERVAL_MS,
  suggestOutOfAreaCents,
  milesFromHomeBase,
  milesBetween,
  roundMiles,
  geocodeThrottled,
  geocodeThrottledBackground,
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

// ─── Nominatim queue (no network: geocodeFn is the test seam) ─────
// Declared in this order on purpose: the cold-path test must run before
// anything stamps lastGeocodeAt, or "cold" stops being cold.

test('geocodeThrottled: a COLD queue pays 0ms, not the full interval', async () => {
  const t0 = Date.now();
  const out = await geocodeThrottled('1500 S Blue Island Ave, Chicago, IL', {
    geocodeFn: async () => ({ lat: 41.8612, lng: -87.6586 }),
  });
  const elapsed = Date.now() - t0;
  assert.deepEqual(out, { lat: 41.8612, lng: -87.6586 });
  assert.ok(elapsed < GEOCODE_MIN_INTERVAL_MS,
    `a cold queue must dispatch immediately, waited ${elapsed}ms`);
});

test('geocodeThrottled: queued lookups dispatch serialized, FIFO, an interval apart', async () => {
  const dispatched = [];
  const fn = (label, sleepMs = 0) => async () => {
    dispatched.push({ label, at: Date.now() });
    if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
    return { lat: dispatched.length, lng: dispatched.length };
  };
  // First is slow on purpose: the second must still wait its turn AND the
  // throttle remainder, never overtake.
  const p1 = geocodeThrottled('addr one', { geocodeFn: fn('one', 40) });
  const p2 = geocodeThrottled('addr two', { geocodeFn: fn('two') });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(dispatched.map((d) => d.label), ['one', 'two'], 'FIFO order');
  assert.deepEqual(r1, { lat: 1, lng: 1 });
  assert.deepEqual(r2, { lat: 2, lng: 2 });
  // Elapsed-time pacing: the second dispatch waits out the interval measured
  // from the FIRST dispatch (small slack for timer jitter only).
  const gap = dispatched[1].at - dispatched[0].at;
  assert.ok(gap >= GEOCODE_MIN_INTERVAL_MS - 50,
    `expected ~${GEOCODE_MIN_INTERVAL_MS}ms between dispatches, got ${gap}ms`);
});

test('geocodeThrottledBackground: sheds (null, nothing enqueued) at the depth cap, never wedges', async () => {
  const slowFn = async () => ({ lat: 0, lng: 0 });
  // Fill the queue to the cap through the background variant itself.
  const queued = [];
  for (let i = 0; i < 4; i++) {
    const p = geocodeThrottledBackground(`addr ${i}`, { geocodeFn: slowFn });
    assert.ok(p, `lookup ${i} under the cap must enqueue`);
    queued.push(p);
  }
  // At the cap: shed immediately, nothing enqueued.
  assert.equal(geocodeThrottledBackground('addr overflow', { geocodeFn: slowFn }), null);
  // The AWAITED variant is never shed, even at the cap.
  const awaited = geocodeThrottled('addr awaited', { geocodeFn: slowFn });
  assert.ok(awaited && typeof awaited.then === 'function');
  await Promise.all([...queued, awaited]);
  // Drained: background lookups flow again (no negative caching, no stuck depth).
  const after = geocodeThrottledBackground('addr after drain', { geocodeFn: slowFn });
  assert.ok(after, 'a drained queue accepts background lookups again');
  assert.deepEqual(await after, { lat: 0, lng: 0 });
});
