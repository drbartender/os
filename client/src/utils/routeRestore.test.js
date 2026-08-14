import {
  recordRoute,
  consumeRestoredRoute,
  resetRestoreCaptureForTests,
} from './routeRestore';

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetRestoreCaptureForTests();
});

test('restores the recorded route, and repeated same-load calls agree', () => {
  recordRoute('/proposals/42', '?tab=activity');
  expect(consumeRestoredRoute('/events')).toBe('/proposals/42?tab=activity');
  // StrictMode double-invokes lazy initializers keeping the SECOND result:
  // a second same-load call must return the SAME target, not null.
  expect(consumeRestoredRoute('/events')).toBe('/proposals/42?tab=activity');
});

test('a fresh load in the same browser session does not restore again', () => {
  recordRoute('/proposals/42', '');
  expect(consumeRestoredRoute('/events')).toBe('/proposals/42');
  // Simulate a new page load: module memo resets, sessionStorage survives.
  resetRestoreCaptureForTests();
  expect(consumeRestoredRoute('/events')).toBe(null);
});

test('returns null when already on the saved route', () => {
  recordRoute('/events', '');
  expect(consumeRestoredRoute('/events')).toBe(null);
});

test('returns null with nothing recorded', () => {
  expect(consumeRestoredRoute('/events')).toBe(null);
});

test('rejects non-path and protocol-relative junk', () => {
  window.localStorage.setItem(
    'adminLastRoute',
    JSON.stringify({ pathname: 'https://evil.example', search: '' })
  );
  expect(consumeRestoredRoute('/events')).toBe(null);
  window.sessionStorage.clear();
  resetRestoreCaptureForTests();
  window.localStorage.setItem(
    'adminLastRoute',
    JSON.stringify({ pathname: '//evil.example', search: '' })
  );
  expect(consumeRestoredRoute('/events')).toBe(null);
});
