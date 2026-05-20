const {
  resolveEventTimezone,
  formatEventLocalTime,
  isValidTimezone,
} = require('./eventTimezone');

describe('eventTimezone', () => {
  describe('isValidTimezone', () => {
    it('returns true for valid IANA zones', () => {
      expect(isValidTimezone('America/Chicago')).toBe(true);
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
    });

    it('returns false for invalid zones', () => {
      expect(isValidTimezone('Mars/Olympus')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
      expect(isValidTimezone(null)).toBe(false);
    });
  });

  describe('resolveEventTimezone', () => {
    it('returns event_timezone if set on the proposal', () => {
      const p = { event_timezone: 'America/New_York' };
      expect(resolveEventTimezone(p)).toBe('America/New_York');
    });

    it('falls back to America/Chicago if event_timezone is null', () => {
      const p = { event_timezone: null };
      expect(resolveEventTimezone(p)).toBe('America/Chicago');
    });

    it('falls back to America/Chicago for invalid timezone', () => {
      const p = { event_timezone: 'Bogus/Zone' };
      expect(resolveEventTimezone(p)).toBe('America/Chicago');
    });
  });

  describe('formatEventLocalTime', () => {
    it('renders a UTC date in the specified zone', () => {
      const date = new Date('2026-06-15T23:00:00Z'); // 6pm CDT, 7pm EDT
      expect(formatEventLocalTime(date, 'America/Chicago', { timeStyle: 'short' })).toBe('6:00 PM');
      expect(formatEventLocalTime(date, 'America/New_York', { timeStyle: 'short' })).toBe('7:00 PM');
    });

    it('renders date format', () => {
      const date = new Date('2026-06-15T12:00:00Z');
      const out = formatEventLocalTime(date, 'America/Chicago', { dateStyle: 'long' });
      expect(out).toMatch(/June 15, 2026/);
    });
  });
});
