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
