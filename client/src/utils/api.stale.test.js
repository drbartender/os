import { markStaleFromHeaders } from './api';

test('stamps staleAt from the SW header, leaves fresh responses alone', () => {
  const cached = { headers: { 'x-sw-cached-at': '2026-08-13T14:02:00.000Z' } };
  expect(markStaleFromHeaders(cached).staleAt).toBe('2026-08-13T14:02:00.000Z');
  const fresh = { headers: {} };
  expect(markStaleFromHeaders(fresh).staleAt).toBe(undefined);
  expect(markStaleFromHeaders(null)).toBe(null);
});
