const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
  resolveEventTimezone,
  formatEventLocalTime,
  isValidTimezone,
} = require('./eventTimezone');

describe('eventTimezone', () => {
  describe('isValidTimezone', () => {
    test('returns true for valid IANA zones', () => {
      assert.strictEqual(isValidTimezone('America/Chicago'), true);
      assert.strictEqual(isValidTimezone('America/New_York'), true);
      assert.strictEqual(isValidTimezone('UTC'), true);
    });

    test('returns false for invalid zones', () => {
      assert.strictEqual(isValidTimezone('Mars/Olympus'), false);
      assert.strictEqual(isValidTimezone(''), false);
      assert.strictEqual(isValidTimezone(null), false);
    });
  });

  describe('resolveEventTimezone', () => {
    test('returns event_timezone if set on the proposal', () => {
      const p = { event_timezone: 'America/New_York' };
      assert.strictEqual(resolveEventTimezone(p), 'America/New_York');
    });

    test('falls back to America/Chicago if event_timezone is null', () => {
      const p = { event_timezone: null };
      assert.strictEqual(resolveEventTimezone(p), 'America/Chicago');
    });

    test('falls back to America/Chicago for invalid timezone', () => {
      const p = { event_timezone: 'Bogus/Zone' };
      assert.strictEqual(resolveEventTimezone(p), 'America/Chicago');
    });
  });

  describe('formatEventLocalTime', () => {
    test('renders a UTC date in the specified zone', () => {
      const date = new Date('2026-06-15T23:00:00Z'); // 6pm CDT, 7pm EDT
      assert.strictEqual(
        formatEventLocalTime(date, 'America/Chicago', { timeStyle: 'short' }),
        '6:00 PM'
      );
      assert.strictEqual(
        formatEventLocalTime(date, 'America/New_York', { timeStyle: 'short' }),
        '7:00 PM'
      );
    });

    test('renders date format', () => {
      const date = new Date('2026-06-15T12:00:00Z');
      const out = formatEventLocalTime(date, 'America/Chicago', { dateStyle: 'long' });
      assert.match(out, /June 15, 2026/);
    });
  });
});
