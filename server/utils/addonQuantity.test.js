// server/utils/addonQuantity.test.js
// PURE unit tests, no DB. proposal_addons.quantity holds the ENGINE'S OUTPUT
// display quantity (calculateAddonCost's return .quantity), NOT the input
// count. These are the only sanctioned conversions between the two.
//   node --test server/utils/addonQuantity.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { storedToInputCount, effectiveHoursFor, storedIsInputCount, countLabelFor } = require('./addonQuantity');
const { calculateAddonCost } = require('./pricingEngine');

test('per_hour: stored is hours x count, so the count divides back out', () => {
  const addon = { billing_type: 'per_hour', rate: 75, minimum_hours: null };
  // 1 server on a 6h event stores 6 (matches prod proposal 624).
  assert.equal(storedToInputCount(addon, 6, 6), 1);
  // 2 bartenders on a 3h event store 6 (matches prod proposal 478).
  assert.equal(storedToInputCount(addon, 6, 3), 2);
  // Fractional durations are real: prod proposal 491 is a 3.5h event.
  assert.equal(storedToInputCount(addon, 3.5, 3.5), 1);
  // node-pg hands NUMERIC back as a STRING (quantity is NUMERIC(10,2),
  // event_duration_hours is NUMERIC(4,1), and no setTypeParser is registered
  // anywhere in server/), so strings are the shape every real caller passes.
  assert.equal(storedToInputCount(addon, '6.00', '3.0'), 2);
});

test('per_hour: minimum_hours is the divisor when it exceeds the event duration', () => {
  const addon = { billing_type: 'per_hour', rate: 75, minimum_hours: 4 };
  assert.equal(effectiveHoursFor(addon, 2), 4);
  // The engine billed 4 hours, so it stored 4 for one unit; recovering with the
  // raw 2-hour duration would wrongly read that as 2 units.
  assert.equal(storedToInputCount(addon, 4, 2), 1);
});

test('additional-bartender divides by RAW duration, never the minimum', () => {
  // Its engine branch (pricingEngine.js:387-405) is bespoke and ignores
  // minimum_hours; eventCreation.js:52-54 and formState.js:80-84 both encode
  // the same split. NULL on the catalog row today, so this pins the intent.
  const ab = { slug: 'additional-bartender', billing_type: 'per_hour', rate: 40, minimum_hours: 4 };
  assert.equal(effectiveHoursFor(ab, 2), 2, 'raw duration, not the 4h minimum');
  assert.equal(storedToInputCount(ab, 4, 2), 2, '2 bartenders on a 2h event store 4');
  // This branch returns the hours directly rather than through Math.max, so it
  // is the one place a node-pg string duration could escape uncoerced. Strict
  // equality, so returning '2.0' here would fail.
  assert.equal(effectiveHoursFor(ab, '2.0'), 2);
  // The SLUG decides, not billing_type: the engine's branch is keyed on slug
  // alone, so a catalog row edited off per_hour must still divide by hours
  // rather than hand the stored hours-times-count product back as a count.
  assert.equal(storedToInputCount({ ...ab, billing_type: 'flat' }, 4, 2), 2);
});

test('a legacy mis-shaped row recovers as 1 unit, not a fraction', () => {
  // lab.js / submit.js wrote a raw `1` before Task 5. Dividing that by 4 hours
  // gives 0.25, which would price a quarter of a server and UNDER-bill by 4x.
  // Rounding with a floor of 1 (what the client inverter does) keeps today's
  // money exactly where it is while the writers get fixed.
  const addon = { billing_type: 'per_hour', rate: 40, minimum_hours: null };
  assert.equal(storedToInputCount(addon, 1, 4), 1);
  assert.equal(storedToInputCount(addon, 2, 4), 1, 'still one unit, rounded');
  assert.equal(storedToInputCount(addon, 7, 4), 2, 'rounds to the nearest whole unit');
});

test('flat: stored IS the input count, round-trips unchanged', () => {
  const addon = { billing_type: 'flat', rate: 200 };
  assert.ok(storedIsInputCount('flat'));
  assert.equal(storedToInputCount(addon, 2, 4), 2);
});

test('an unrecognized billing_type keeps its count (the engine default branch)', () => {
  // billing_type is a bare VARCHAR with no CHECK, and the engine's `default:`
  // branch prices rate x qty exactly like flat, so the stored figure IS the
  // count. Reading it as "not a count" would drop it to 1 and under-bill, the
  // same defect the 2026-07-20 review found for per_hour.
  assert.ok(storedIsInputCount('some-future-type'));
  assert.ok(storedIsInputCount(null));
  assert.equal(storedToInputCount({ billing_type: 'some-future-type' }, 3, 4), 3);
  assert.equal(storedToInputCount({ billing_type: null }, 3, 4), 3);
});

test('types whose stored figure is not a count return null', () => {
  // The NO-OPTIONS call. per_guest belongs here only on this path: given the
  // row's own line_total and rate it recovers a real count (see below).
  for (const bt of ['per_guest', 'per_guest_timed', 'per_staff', 'per_100_guests']) {
    assert.equal(storedToInputCount({ billing_type: bt }, 80, 4), null, bt);
  }
});

test('per_guest: the count is recovered from line_total, not from quantity', () => {
  // Prod proposal 482's exact shape: 50 guests, $2.00, two mocktails.
  const addon = { billing_type: 'per_guest', slug: 'pre-batched-mocktail' };
  assert.equal(storedToInputCount(addon, 50, 4, { lineTotal: 200, rate: 2 }), 2);
  assert.equal(storedToInputCount(addon, 50, 4, { lineTotal: 100, rate: 2 }), 1);
  // pg hands both back as strings.
  assert.equal(storedToInputCount(addon, '50.00', '4.0', { lineTotal: '200.00', rate: '2.00' }), 2);
});

test('per_guest: recovery divides by the ROW rate, never the catalog rate', () => {
  // The catalog row says $2.00 today; this proposal was sold at $1.50. Dividing
  // by the catalog rate would recover 1 unit from a 2-unit line and halve it.
  const addon = { billing_type: 'per_guest', slug: 'pre-batched-mocktail', rate: 2 };
  assert.equal(storedToInputCount(addon, 50, 4, { lineTotal: 150, rate: 1.5 }), 2);
});

test('per_guest: without line_total and rate it stays null (the cancel-line path)', () => {
  const addon = { billing_type: 'per_guest' };
  assert.equal(storedToInputCount(addon, 50, 4), null);
  assert.equal(storedToInputCount(addon, 50, 4, { lineTotal: 0, rate: 2 }), null);
});

test('per_guest_timed is NOT recoverable this way (the extra-hours term)', () => {
  // Prod proposal 464: 150 guests, $8.00, line_total 1500 for a count of ONE.
  // The naive division reads 1.25, so this type must keep returning null.
  const addon = { billing_type: 'per_guest_timed' };
  assert.equal(storedToInputCount(addon, 150, 6, { lineTotal: 1500, rate: 8 }), null);
});

test('degenerate inputs never produce NaN or Infinity', () => {
  const addon = { billing_type: 'per_hour', rate: 40, minimum_hours: null };
  assert.equal(storedToInputCount(addon, 4, 0), null);     // no duration to divide by
  assert.equal(storedToInputCount(addon, 0, 4), null);     // nothing stored
  assert.equal(storedToInputCount(addon, null, 4), null);
  assert.equal(storedToInputCount({ billing_type: 'flat' }, null, 4), null);
});

test('round-trip against the ENGINE for every countable type', () => {
  // The contract in one assertion: price N units, store what the engine
  // returns, recover N. If calculateAddonCost ever changes shape, this fails.
  for (const [addon, count, hours] of [
    [{ billing_type: 'per_hour', rate: 40, minimum_hours: null }, 3, 4],
    [{ billing_type: 'per_hour', rate: 75, minimum_hours: 4 }, 2, 2],
    [{ billing_type: 'flat', rate: 150 }, 2, 4],
  ]) {
    const priced = calculateAddonCost(addon, 80, hours, 1, count);
    assert.equal(storedToInputCount(addon, priced.quantity, hours), count,
      `${addon.billing_type} count=${count} hours=${hours} stored=${priced.quantity}`);
  }
});

test('countLabelFor names the unit for the admin picker', () => {
  assert.equal(countLabelFor({ billing_type: 'per_hour' }), 'hour');
  assert.equal(countLabelFor({ billing_type: 'flat' }), 'unit');
  assert.equal(countLabelFor({ billing_type: 'per_guest' }), null);
});
