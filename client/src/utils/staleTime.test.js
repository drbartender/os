import { formatStaleAt } from './staleTime';

test('same-day timestamps render as a time, older ones carry the day', () => {
  const now = new Date('2026-08-14T21:30:00');
  expect(formatStaleAt('2026-08-14T14:02:00', now)).toBe('as of 2:02 PM');
  expect(formatStaleAt('2026-08-13T21:12:00', now)).toBe('as of Aug 13, 9:12 PM');
  expect(formatStaleAt(null, now)).toBe(null);
  expect(formatStaleAt('garbage', now)).toBe(null);
});
