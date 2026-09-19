import { formatStaleAt, formatStaleTime } from './staleTime';

test('same-day timestamps render as a time, older ones carry the day', () => {
  const now = new Date('2026-08-14T21:30:00');
  expect(formatStaleAt('2026-08-14T14:02:00', now)).toBe('as of 2:02 PM');
  expect(formatStaleAt('2026-08-13T21:12:00', now)).toBe('as of Aug 13, 9:12 PM');
  expect(formatStaleAt(null, now)).toBe(null);
  expect(formatStaleAt('garbage', now)).toBe(null);
});

test('formatStaleTime returns the time alone, with the day when it is not today', () => {
  const now = new Date('2026-08-13T20:00:00');
  expect(formatStaleTime('2026-08-13T14:14:00', now)).toBe('2:14 PM');
  expect(formatStaleTime('2026-08-12T14:14:00', now)).toBe('Aug 12, 2:14 PM');
  expect(formatStaleTime(null, now)).toBeNull();
  expect(formatStaleTime('garbage', now)).toBeNull();
});
