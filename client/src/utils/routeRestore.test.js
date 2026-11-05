import {
  recordRoute,
  consumeRestoredRoute,
  resetRestoreCaptureForTests,
  LAUNCH_PATH,
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

test('a launch at any page but the start page restores nothing: a push alert or a link opened in the app lands where it points', () => {
  recordRoute('/proposals/42', '');
  // A tapped push alert opens the closed app at its own page (admin-sw.js openWindow).
  expect(consumeRestoredRoute('/events/7', '')).toBe(null);
  // The launch still uses up this window's one restore: signing in again later in
  // the same window does not throw the admin back to the saved route.
  resetRestoreCaptureForTests();
  expect(consumeRestoredRoute('/events', '')).toBe(null);
});

test('the start page with a query is a link, not the icon: it restores nothing', () => {
  recordRoute('/proposals/42', '');
  expect(consumeRestoredRoute('/events', '?tab=past')).toBe(null);
});

test('the start page the restore waits for is the admin manifest start_url', () => {
  const fs = require('fs');
  const path = require('path');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../../public/admin-manifest.json'), 'utf8'));
  expect(manifest.start_url).toBe(LAUNCH_PATH);
});

test('the search screen is never recorded: the screen before it stays the resume target', () => {
  recordRoute('/proposals/42', '');
  recordRoute('/search', '');
  expect(consumeRestoredRoute('/events')).toBe('/proposals/42');
});
