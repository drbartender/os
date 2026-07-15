import { fmtTime24, fmtTimeRange24 } from './format';

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

describe('fmtTimeRange24', () => {
  test('stored end + duration', () => {
    expect(fmtTimeRange24('7:00 PM', '11:00 PM', 5)).toBe('19:00–23:00 · 5h');
    expect(fmtTimeRange24('18:00', '23:00', 5)).toBe('18:00–23:00 · 5h');
  });

  test('derives end from start + duration when end is missing', () => {
    expect(fmtTimeRange24('18:00', null, 5)).toBe('18:00–23:00 · 5h');
    expect(fmtTimeRange24('6:00 PM', '', 4)).toBe('18:00–22:00 · 4h');
  });

  test('fractional duration strips trailing zero', () => {
    expect(fmtTimeRange24('18:00', null, 4.5)).toBe('18:00–22:30 · 4.5h');
    expect(fmtTimeRange24('18:00', null, 5.0)).toBe('18:00–23:00 · 5h');
  });

  test('past-midnight wrap', () => {
    expect(fmtTimeRange24('10:00 PM', null, 4)).toBe('22:00–02:00 · 4h');
  });

  test('end present, no duration → derive hours from span', () => {
    expect(fmtTimeRange24('18:00', '23:00', null)).toBe('18:00–23:00 · 5h');
    expect(fmtTimeRange24('18:00', '22:30', null)).toBe('18:00–22:30 · 4.5h');
  });

  test('start only', () => {
    expect(fmtTimeRange24('18:00', null, null)).toBe('18:00');
    expect(fmtTimeRange24('7:00 PM', '', undefined)).toBe('19:00');
  });

  test('missing / unparseable start', () => {
    expect(fmtTimeRange24('', null, 5)).toBe('');
    expect(fmtTimeRange24(null, null, 5)).toBe('');
    expect(fmtTimeRange24('garbage', null, 5)).toBe('garbage');
  });

  test('paren style for EventDetailPage parity', () => {
    expect(fmtTimeRange24('18:00', null, 5, { durStyle: 'paren' })).toBe('18:00–23:00 (5 hrs)');
    expect(fmtTimeRange24('18:00', null, 1, { durStyle: 'paren' })).toBe('18:00–19:00 (1 hr)');
  });
});
