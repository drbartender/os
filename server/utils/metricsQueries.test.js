const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveFilters, priorPeriod, dateClause, toDollars,
} = require('./metricsQueries');

// ── resolveFilters ──
test('resolveFilters: defaults basis to booked, no dates = All time', () => {
  assert.deepEqual(resolveFilters({}), { from: null, to: null, basis: 'booked' });
});

test('resolveFilters: valid range + basis passes through', () => {
  assert.deepEqual(
    resolveFilters({ from: '2026-04-01', to: '2026-04-30', basis: 'paid' }),
    { from: '2026-04-01', to: '2026-04-30', basis: 'paid' }
  );
});

test('resolveFilters: unknown basis throws', () => {
  assert.throws(() => resolveFilters({ basis: 'bogus' }), /basis/);
});

test('resolveFilters: malformed date throws', () => {
  assert.throws(() => resolveFilters({ from: '2026-13-99', to: '2026-04-30' }), /date/i);
});

test('resolveFilters: only one bound throws (ambiguous)', () => {
  assert.throws(() => resolveFilters({ from: '2026-04-01' }), /both/i);
});

test('resolveFilters: from after to throws', () => {
  assert.throws(() => resolveFilters({ from: '2026-05-01', to: '2026-04-01' }), /before/i);
});

// ── priorPeriod ──
test('priorPeriod: April 2026 → March 2026 (equal length, immediately prior)', () => {
  assert.deepEqual(
    priorPeriod('2026-04-01', '2026-04-30'),
    { from: '2026-03-02', to: '2026-03-31' }
  );
});

test('priorPeriod: 7-day window shifts back exactly 7 days', () => {
  assert.deepEqual(
    priorPeriod('2026-04-08', '2026-04-14'),
    { from: '2026-04-01', to: '2026-04-07' }
  );
});

test('priorPeriod: All time (null) → null', () => {
  assert.equal(priorPeriod(null, null), null);
});

// ── dateClause ──
test('dateClause: null range → empty fragment, params untouched', () => {
  const params = [];
  assert.equal(dateClause('p.sent_at', null, null, params), '');
  assert.deepEqual(params, []);
});

test('dateClause: half-open range, 1-based param placeholders', () => {
  const params = [];
  const frag = dateClause('p.accepted_at', '2026-04-01', '2026-04-30', params);
  assert.equal(frag, ' AND p.accepted_at >= $1::date AND p.accepted_at < ($2::date + 1)');
  assert.deepEqual(params, ['2026-04-01', '2026-04-30']);
});

test('dateClause: appends to existing params with correct offset', () => {
  const params = ['x'];
  const frag = dateClause('pp.created_at', '2026-01-01', '2026-01-31', params);
  assert.equal(frag, ' AND pp.created_at >= $2::date AND pp.created_at < ($3::date + 1)');
  assert.deepEqual(params, ['x', '2026-01-01', '2026-01-31']);
});

// ── toDollars ──
test('toDollars: passthrough for dollar values', () => {
  assert.equal(toDollars(1234.5), 1234.5);
  assert.equal(toDollars(null), 0);
});

test('toDollars: divides by 100 when fromCents', () => {
  assert.equal(toDollars(65000, { fromCents: true }), 650);
  assert.equal(toDollars(null, { fromCents: true }), 0);
});
