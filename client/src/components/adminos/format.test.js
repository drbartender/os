import { fmtTime24 } from './format';

describe('fmtTime24', () => {
  test('converts server-written 12h strings', () => {
    expect(fmtTime24('7:00 PM')).toBe('19:00');
    expect(fmtTime24('6:00 PM')).toBe('18:00');
    expect(fmtTime24('9:30 AM')).toBe('09:30');
  });

  test('handles legacy no-space form', () => {
    expect(fmtTime24('6:00PM')).toBe('18:00');
    expect(fmtTime24('11:15am')).toBe('11:15');
  });

  test('passes canonical 24h through (padded)', () => {
    expect(fmtTime24('18:00')).toBe('18:00');
    expect(fmtTime24('8:30')).toBe('08:30');
    expect(fmtTime24('00:00')).toBe('00:00');
  });

  test('midnight and noon edge cases', () => {
    expect(fmtTime24('12:00 AM')).toBe('00:00');
    expect(fmtTime24('12:00 PM')).toBe('12:00');
    expect(fmtTime24('12:30 AM')).toBe('00:30');
  });

  test('empty input returns empty string', () => {
    expect(fmtTime24('')).toBe('');
    expect(fmtTime24(null)).toBe('');
    expect(fmtTime24(undefined)).toBe('');
  });

  test('unparseable non-empty input is returned as-is, never blanked', () => {
    expect(fmtTime24('garbage')).toBe('garbage');
    expect(fmtTime24('25:00')).toBe('25:00');
    expect(fmtTime24('7:75 PM')).toBe('7:75 PM');
  });
});
