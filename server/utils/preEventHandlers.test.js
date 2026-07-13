const { test, describe } = require('node:test');
const assert = require('node:assert');

// Pure date/time formatters only. These do no DB work, so the suite is safe to
// run in isolation; mirrors the timezone-sensitive, date-only style of
// eventTimezone.test.js.
const {
  formatEventDateLong,
  formatStartTimeShort,
  formatBalanceDueDate,
} = require('./preEventHandlers');

describe('preEventHandlers formatters', () => {
  describe('formatEventDateLong', () => {
    test('renders weekday + long month + day + year in the event timezone', () => {
      assert.strictEqual(
        formatEventDateLong({ event_date: '2026-08-15', event_timezone: 'America/Chicago' }),
        'Saturday, August 15, 2026'
      );
    });

    test('a date-only value does not roll back a day under a negative-offset zone (noon anchor)', () => {
      // event_date is combined with T12:00:00Z, so even Eastern (UTC-4/-5) keeps the same calendar day.
      assert.strictEqual(
        formatEventDateLong({ event_date: '2026-08-15', event_timezone: 'America/New_York' }),
        'Saturday, August 15, 2026'
      );
    });

    test('defaults to America/Chicago when event_timezone is null', () => {
      assert.strictEqual(
        formatEventDateLong({ event_date: '2026-01-01', event_timezone: null }),
        'Thursday, January 1, 2026'
      );
    });

    test('accepts a full ISO timestamp by slicing to the date portion', () => {
      assert.strictEqual(
        formatEventDateLong({ event_date: '2026-08-15T00:00:00.000Z', event_timezone: 'America/Chicago' }),
        'Saturday, August 15, 2026'
      );
    });

    test('throws a field-identifying error for a null/blank/missing event_date (regression: SERVER-Z)', () => {
      assert.throws(() => formatEventDateLong({ event_date: null }), /formatEventDateLong: invalid or missing event_date/);
      assert.throws(() => formatEventDateLong({ event_date: '' }), /formatEventDateLong: invalid or missing event_date/);
      assert.throws(() => formatEventDateLong({}), /formatEventDateLong: invalid or missing event_date/);
    });
  });

  describe('formatStartTimeShort', () => {
    test('returns TBD when no start time is set', () => {
      assert.strictEqual(
        formatStartTimeShort({ event_start_time: null, event_date: '2026-08-15' }),
        'TBD'
      );
    });

    test('converts 24-hour HH:MM to 12-hour and appends the summer (DST) TZ abbreviation', () => {
      assert.strictEqual(
        formatStartTimeShort({ event_start_time: '18:00', event_date: '2026-08-15', event_timezone: 'America/Chicago' }),
        '6:00 PM CDT'
      );
    });

    test('a winter date yields the standard-time abbreviation', () => {
      assert.strictEqual(
        formatStartTimeShort({ event_start_time: '18:00', event_date: '2026-01-01', event_timezone: 'America/Chicago' }),
        '6:00 PM CST'
      );
    });

    test('resolves the abbreviation for a non-default zone', () => {
      assert.strictEqual(
        formatStartTimeShort({ event_start_time: '9:30 AM', event_date: '2026-08-15', event_timezone: 'America/New_York' }),
        '9:30 AM EDT'
      );
    });

    test('handles midnight and noon boundaries', () => {
      assert.strictEqual(
        formatStartTimeShort({ event_start_time: '00:00', event_date: '2026-08-15', event_timezone: 'America/Chicago' }),
        '12:00 AM CDT'
      );
      assert.strictEqual(
        formatStartTimeShort({ event_start_time: '12:00', event_date: '2026-08-15', event_timezone: 'America/Chicago' }),
        '12:00 PM CDT'
      );
    });

    test('already-12-hour input passes through; a missing event_date yields no TZ suffix', () => {
      assert.strictEqual(formatStartTimeShort({ event_start_time: '6:00 PM' }), '6:00 PM');
    });
  });

  describe('formatBalanceDueDate', () => {
    test('formats a date-only value as "Month D, YYYY" in the event zone', () => {
      assert.strictEqual(
        formatBalanceDueDate({ balance_due_date: '2026-06-08', event_timezone: 'America/Chicago' }),
        'June 8, 2026'
      );
    });

    test('slices a full ISO timestamp to the date portion', () => {
      assert.strictEqual(
        formatBalanceDueDate({ balance_due_date: '2026-06-08T00:00:00.000Z', event_timezone: 'America/Chicago' }),
        'June 8, 2026'
      );
    });

    test('returns an empty string when balance_due_date is null (optional field)', () => {
      assert.strictEqual(formatBalanceDueDate({ balance_due_date: null }), '');
    });

    test('returns an empty string (does NOT throw) for a malformed date', () => {
      assert.strictEqual(formatBalanceDueDate({ balance_due_date: 'not-a-date' }), '');
    });
  });
});
