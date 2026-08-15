import '@testing-library/jest-dom';
import { purgeMobileAdminState } from './adminSw';
import { ENROLLED_KEY, LAST_ACTIVE_KEY, NUDGE_DISMISSED_KEY } from './mobileLock';

// Pins the purge contract: every phone-local key dies on logout. jsdom has no
// serviceWorker, so postToAdminSw exits early and only the storage side runs.
test('purgeMobileAdminState removes every phone-local key', () => {
  const keys = [
    'adminDesktopViewOverrides',
    'adminLastRoute',
    LAST_ACTIVE_KEY,
    ENROLLED_KEY,
    NUDGE_DISMISSED_KEY,
  ];
  keys.forEach((k) => window.localStorage.setItem(k, 'x'));
  window.sessionStorage.setItem('adminRouteRestoredThisLaunch', '1');
  purgeMobileAdminState();
  keys.forEach((k) => expect(window.localStorage.getItem(k)).toBeNull());
  expect(window.sessionStorage.getItem('adminRouteRestoredThisLaunch')).toBeNull();
});
