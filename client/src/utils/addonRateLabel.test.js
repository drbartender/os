import { TIMED_PER_GUEST, isTimedPerGuestAddon, timedPerGuestRateLabel } from './addonRateLabel';

// Catalog rows as seeded in server/db/schema.sql (service_addons).
const FULL_COMPOUND = { billing_type: TIMED_PER_GUEST, rate: '8.00', extra_hour_rate: '2.00' };
const FORMULA = { billing_type: TIMED_PER_GUEST, rate: '5.50', extra_hour_rate: '1.25' };
const FOUNDATION = { billing_type: TIMED_PER_GUEST, rate: '3.00', extra_hour_rate: '0.75' };
const MOCKTAIL_BAR = { billing_type: TIMED_PER_GUEST, rate: '7.50', extra_hour_rate: '2.00' };

const fmt2dp = (n) =>
  '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

test('identifies the billing type, not the slug', () => {
  expect(isTimedPerGuestAddon(FULL_COMPOUND)).toBe(true);
  expect(isTimedPerGuestAddon({ billing_type: 'per_guest', rate: '2.00' })).toBe(false);
  expect(isTimedPerGuestAddon(null)).toBe(false);
  expect(isTimedPerGuestAddon(undefined)).toBe(false);
});

test('full form matches the accepted admin phrasing', () => {
  expect(timedPerGuestRateLabel(FULL_COMPOUND)).toBe('$8/guest (4hr) + $2/guest/hr after');
});

test('all four seeded rows keep their real cents', () => {
  expect(timedPerGuestRateLabel(FORMULA)).toBe('$5.50/guest (4hr) + $1.25/guest/hr after');
  expect(timedPerGuestRateLabel(FOUNDATION)).toBe('$3/guest (4hr) + $0.75/guest/hr after');
  expect(timedPerGuestRateLabel(MOCKTAIL_BAR)).toBe('$7.50/guest (4hr) + $2/guest/hr after');
});

test('a caller-supplied money formatter is honored', () => {
  expect(timedPerGuestRateLabel(FULL_COMPOUND, { money: fmt2dp }))
    .toBe('$8.00/guest (4hr) + $2.00/guest/hr after');
  expect(timedPerGuestRateLabel(FOUNDATION, { money: fmt2dp }))
    .toBe('$3.00/guest (4hr) + $0.75/guest/hr after');
});

test('a narrow unit shortens the noun but never the qualifier', () => {
  expect(timedPerGuestRateLabel(FULL_COMPOUND, { money: fmt2dp, unit: '/g' }))
    .toBe('$8.00/g (4hr) + $2.00/g/hr after');
});

test('compact is the FLOOR: still qualified, never a bare rate', () => {
  const label = timedPerGuestRateLabel(FULL_COMPOUND, { compact: true });
  expect(label).toBe('$8/guest (4hr)');
  expect(label).toContain('(4hr)');
});

test('a missing or zero extra_hour_rate degrades to the floor, never $NaN', () => {
  expect(timedPerGuestRateLabel({ billing_type: TIMED_PER_GUEST, rate: '8.00' }))
    .toBe('$8/guest (4hr)');
  expect(timedPerGuestRateLabel({ billing_type: TIMED_PER_GUEST, rate: '8.00', extra_hour_rate: null }))
    .toBe('$8/guest (4hr)');
  expect(timedPerGuestRateLabel({ billing_type: TIMED_PER_GUEST, rate: '8.00', extra_hour_rate: '0.00' }))
    .toBe('$8/guest (4hr)');
  expect(timedPerGuestRateLabel({ billing_type: TIMED_PER_GUEST, rate: '8.00', extra_hour_rate: 'oops' }))
    .toBe('$8/guest (4hr)');
});

test('every produced label carries the four-hour qualifier', () => {
  for (const addon of [FULL_COMPOUND, FORMULA, FOUNDATION, MOCKTAIL_BAR]) {
    for (const opts of [{}, { compact: true }, { money: fmt2dp, unit: '/g' }]) {
      expect(timedPerGuestRateLabel(addon, opts)).toContain('(4hr)');
    }
  }
});

test('no add-on returns an empty string rather than throwing', () => {
  expect(timedPerGuestRateLabel(null)).toBe('');
  expect(timedPerGuestRateLabel(undefined)).toBe('');
});
