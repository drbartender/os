'use strict';
// The rule that keeps a settled on-site extension out of the contract's price.
// Pure: no database. Spec 2026-09-30-extension-contract-duration-design.md.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  contractHoursFrom, contractHoursFromAggregate, SETTLED_EXTENSION_COLUMNS, MIN_HOURS,
} = require('./contractDuration');
const { SETTLE_OUTCOMES, CLOSE_OUTCOMES } = require('./serviceExtensionOutcomes');

// Rows as pg returns them: NUMERIC(4,1) arrives as a string.
const ext = (status, contracted, requested) => ({
  status, contracted_duration_hours: String(contracted), requested_duration_hours: String(requested),
});
const plain = { clamped: false, corrupt: false };

test('no extensions: the row is the contract, and settled is 0', () => {
  assert.deepEqual(contractHoursFrom('4.0', []), { hours: 4, settled: 0, ...plain });
  assert.deepEqual(contractHoursFrom(5.5, null), { hours: 5.5, settled: 0, ...plain });
});

test('one paid extension comes out of the contract', () => {
  assert.deepEqual(contractHoursFrom('5.0', [ext('paid', 4, 5)]), { hours: 4, settled: 1, ...plain });
});

test('two paid extensions both come out, in tenths, with no float noise', () => {
  assert.deepEqual(
    contractHoursFrom('5.5', [ext('paid', 4, 5), ext('paid', 5, 5.5)]),
    { hours: 4, settled: 1.5, ...plain }
  );
});

test('an overridden extension counts: the time was granted, not billed, so the contract must not bill it either', () => {
  assert.deepEqual(contractHoursFrom('5.0', [ext('overridden', 4, 5)]), { hours: 4, settled: 1, ...plain });
});

test('expired, cancelled and pending rows never moved the row, so they are ignored', () => {
  const rows = [ext('expired', 4, 5), ext('cancelled', 4, 6), ext('pending', 4, 4.5)];
  assert.deepEqual(contractHoursFrom('4.0', rows), { hours: 4, settled: 0, ...plain });
  for (const s of CLOSE_OUTCOMES) assert.ok(!SETTLE_OUTCOMES.has(s), `${s} is not a settle outcome`);
});

test('a status this module has never heard of is ignored, never subtracted', () => {
  assert.deepEqual(contractHoursFrom('5.0', [ext('refunded', 4, 5)]), { hours: 5, settled: 0, ...plain });
});

test('an admin who lengthens the booking after an extension adds contract time', () => {
  // 4h contract, +1h extension (row 5), admin sets 6 in the editor: contract 5.
  assert.deepEqual(contractHoursFrom('6.0', [ext('paid', 4, 5)]), { hours: 5, settled: 1, ...plain });
});

test('the clamp: a row reverted below what the extension started from holds the contract there', () => {
  // Refund, then the admin reverts the row from 5 back to 4 by hand. Plain
  // subtraction would say 3h; the contract cannot be shorter than the 4h the
  // extension found, so 4h, and the caller is told the clamp bound.
  assert.deepEqual(contractHoursFrom('4.0', [ext('paid', 4, 5)]), { hours: 4, settled: 0, clamped: true, corrupt: false });
  // Two extensions, row reverted to the second one's start: clamp to the FIRST.
  assert.deepEqual(
    contractHoursFrom('5.0', [ext('paid', 4, 5), ext('paid', 5, 6)]),
    { hours: 4, settled: 1, clamped: true, corrupt: false }
  );
});

test('a derivation under the minimum falls back to the row and reports corrupt, never a silent under-bill', () => {
  const r = contractHoursFromAggregate('1.0', 2, null);
  assert.equal(r.corrupt, true);
  assert.equal(r.hours, 1);
  assert.equal(r.settled, 0);
  assert.ok(MIN_HOURS > 0);
});

test('garbage inputs never throw and never subtract', () => {
  assert.deepEqual(contractHoursFrom(null, [ext('paid', 4, 5)]).settled, 0);
  assert.deepEqual(contractHoursFrom('abc', [ext('paid', 4, 5)]).settled, 0);
  assert.deepEqual(contractHoursFrom('5.0', [{ status: 'paid' }]), { hours: 5, settled: 0, ...plain });
  assert.deepEqual(contractHoursFrom('5.0', [null, undefined]), { hours: 5, settled: 0, ...plain });
});

test('the aggregate form and the row form agree', () => {
  const rows = [ext('paid', 4, 5), ext('overridden', 5, 5.5), ext('expired', 5.5, 6)];
  assert.deepEqual(contractHoursFrom('5.5', rows), contractHoursFromAggregate('5.5', 1.5, 4));
});

test('the SQL columns use the same status list as the rule and COALESCE the sum', () => {
  for (const s of SETTLE_OUTCOMES) assert.ok(SETTLED_EXTENSION_COLUMNS.includes(`'${s}'`));
  for (const s of CLOSE_OUTCOMES) assert.ok(!SETTLED_EXTENSION_COLUMNS.includes(`'${s}'`));
  assert.match(SETTLED_EXTENSION_COLUMNS, /COALESCE\(\(SELECT SUM/);
  assert.match(SETTLED_EXTENSION_COLUMNS, /AS pa_settled_added_hours/);
  assert.match(SETTLED_EXTENSION_COLUMNS, /AS pa_min_contracted_hours/);
});
