// Register the admin service worker and speak its message protocol.
// Callers do not await anything useful from failure: an unregistered SW just
// means no offline shell this session.
import { isAdminHost } from './installAdminPwaMeta';

export async function registerAdminSw() {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return null;
  if (!isAdminHost(window.location.hostname)) return null;
  try {
    return await navigator.serviceWorker.register('/admin-sw.js');
  } catch (e) {
    return null;
  }
}

// Post to whichever admin SW controls the page (active registration is fine
// even before controllerchange). Fire-and-forget by design.
async function postToAdminSw(message) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // getRegistration resolves by SCOPE, not script URL: on the staff host it
  // would return the STAFF registration and post admin messages into it.
  if (!isAdminHost(window.location.hostname)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/admin-sw.js');
    const target = (reg && (reg.active || reg.waiting)) || navigator.serviceWorker.controller;
    if (target) target.postMessage(message);
  } catch (e) { /* no SW, nothing to scope or purge */ }
}

// Spec section 7: the API cache is namespaced per authenticated user. The
// announce is chained on serviceWorker.ready because on the very first load
// the registration has no active worker yet and controller is null; posting
// immediately would drop the message and the whole session would cache into
// the anonymous namespace.
export async function announceAdminSwUser(userId) {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.ready;
    await postToAdminSw({ type: 'admin-user', id: String(userId) });
  } catch (e) { /* no SW this session */ }
}

// Spec section 7 purge rule: logout clears EVERYTHING phone-local: the SW
// caches AND the localStorage the shell writes (desktop-view overrides,
// saved route). One call site in AuthContext.logout.
const PHONE_LOCAL_KEYS = ['adminDesktopViewOverrides', 'adminLastRoute'];
export function purgeMobileAdminState() {
  postToAdminSw({ type: 'admin-logout' });
  try {
    PHONE_LOCAL_KEYS.forEach((k) => window.localStorage.removeItem(k));
    window.sessionStorage.removeItem('adminRouteRestoredThisLaunch');
  } catch (e) { /* storage blocked: nothing to clear */ }
}
