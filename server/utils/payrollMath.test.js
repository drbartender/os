const { test } = require('node:test');
const assert = require('node:assert/strict');
const { contractedHours, wageCents } = require('./payrollMath');

test('contractedHours > event duration plus 1h setup plus 0.5h breakdown', () => {
  assert.equal(contractedHours(4), 5.5);
  assert.equal(contractedHours(3.5), 5);
});

test('wageCents > exact when hours times rate is a whole number of cents', () => {
  assert.equal(wageCents(5.5, 2000), 11000);   // 5.5h @ $20.00
});

test('wageCents > rounds a fractional-cent result', () => {
  // 5.25 * 2083 = 10935.75, rounds to 10936
  assert.equal(wageCents(5.25, 2083), 10936);
});

const { splitEvenly } = require('./payrollMath');

test('splitEvenly > divides evenly when there is no remainder', () => {
  assert.deepEqual(splitEvenly(10000, 2), [5000, 5000]);
});

test('splitEvenly > hands remainder cents to the earliest shares', () => {
  // 10001 / 3 = 3333 r 2 -> first two shares get the extra cent
  assert.deepEqual(splitEvenly(10001, 3), [3334, 3334, 3333]);
});

test('splitEvenly > shares always sum to the exact total', () => {
  const shares = splitEvenly(9997, 4);
  assert.equal(shares.reduce((a, b) => a + b, 0), 9997);
});

test('splitEvenly > zero recipients yields an empty array', () => {
  assert.deepEqual(splitEvenly(5000, 0), []);
});

const { extractGratuityCents, proRataFeeCents } = require('./payrollMath');

test('extractGratuityCents > sums every Shared Gratuity breakdown line', () => {
  const snapshot = { breakdown: [
    { label: 'Package', amount: 800 },
    { label: 'Shared Gratuity', amount: 150 },
    { label: 'Shared Gratuity', amount: 50 },
  ] };
  assert.equal(extractGratuityCents(snapshot), 20000); // (150 + 50) dollars
});

test('extractGratuityCents > returns 0 when there is no gratuity line', () => {
  assert.equal(extractGratuityCents({ breakdown: [{ label: 'Package', amount: 800 }] }), 0);
});

test('extractGratuityCents > tolerates a missing or empty snapshot', () => {
  assert.equal(extractGratuityCents(null), 0);
  assert.equal(extractGratuityCents({}), 0);
});

test('proRataFeeCents > the gratuity slice carries its share of the payment fee', () => {
  // gratuity 20000 of a 100000 payment that cost 3200 in fees -> 640
  assert.equal(proRataFeeCents(20000, 100000, 3200), 640);
});

test('proRataFeeCents > returns 0 when the payment total is 0 (non-card payment)', () => {
  assert.equal(proRataFeeCents(20000, 0, 0), 0);
});

test('proRataFeeCents > clamps the ratio at 1 so a slice never over-nets the fee', () => {
  // A slice larger than the payment total must still carry at most the whole fee.
  assert.equal(proRataFeeCents(150000, 100000, 3200), 3200);
});

const { matchTipToShift } = require('./payrollMath');

const windows = [
  { shiftId: 10, startMs: 1000, endMs: 5000 },
  { shiftId: 20, startMs: 8000, endMs: 12000 },
];

test('matchTipToShift > returns the shift whose window contains the tip', () => {
  assert.equal(matchTipToShift(3000, windows), 10);
  assert.equal(matchTipToShift(9000, windows), 20);
});

test('matchTipToShift > returns null when no window contains the tip', () => {
  assert.equal(matchTipToShift(6000, windows), null);
});

test('matchTipToShift > on overlap, picks the window whose start is nearest', () => {
  const overlap = [
    { shiftId: 1, startMs: 0, endMs: 10000 },
    { shiftId: 2, startMs: 7000, endMs: 20000 },
  ];
  assert.equal(matchTipToShift(8000, overlap), 2); // 8000 is nearer 7000 than 0
});
