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
