// Resume-where-I-left-off (spec section 9). A cold standalone launch from the
// app icon opens the admin manifest's start_url (/events), and the shell
// restores the last recorded admin route instead. A launch anywhere else is
// not the icon: a tapped push alert opens the closed app at its own page
// (admin-sw.js openWindow), and a link Android opens in the installed app lands
// where it points, so those restore nothing. sessionStorage guards
// once-per-launch, and every launch uses it up. Half-finished edit sheets are
// deliberately NOT restored; this is route-level only. recordRoute is only ever
// called from inside the AdminLayout route element, so /login and the
// auth/reset pages can never be recorded (spec section 9).
const LAST_ROUTE_KEY = 'adminLastRoute';
const RESTORED_KEY = 'adminRouteRestoredThisLaunch';

// The admin manifest's start_url (client/public/admin-manifest.json); a test
// keeps the two equal.
export const LAUNCH_PATH = '/events';

// Same-load memo: consumeRestoredRoute is called from a lazy useState
// initializer, and React StrictMode invokes initializers twice keeping the
// SECOND result. Without this cache the first call burns the sessionStorage
// one-shot and the second returns null, killing resume in every dev render.
// `undefined` = not captured yet this JS load; anything else is the answer.
let capturedThisLoad;

/** Test-only: reset the same-load memo (simulates a fresh page load). */
export function resetRestoreCaptureForTests() {
  capturedThisLoad = undefined;
}

// The search screen is never a resume target: its term lives in history
// state, which a cold launch does not have, and an empty field with the
// keyboard up is not "where I left off" (lane ma-f3). The screen before it
// stays recorded.
const NEVER_RECORDED = new Set(['/search']);

export function recordRoute(pathname, search) {
  if (NEVER_RECORDED.has(pathname)) return;
  try {
    window.localStorage.setItem(
      LAST_ROUTE_KEY,
      JSON.stringify({ pathname, search: search || '' })
    );
  } catch (e) {
    // Best-effort; a full store just means no resume this time.
  }
}

export function consumeRestoredRoute(currentPathname, currentSearch = '') {
  if (capturedThisLoad !== undefined) return capturedThisLoad;
  try {
    if (window.sessionStorage.getItem(RESTORED_KEY)) {
      capturedThisLoad = null;
      return null;
    }
    // Used up before the launch is judged, so a launch that restores nothing
    // still ends this window's chance to restore.
    window.sessionStorage.setItem(RESTORED_KEY, '1');
    const fromIcon = currentPathname === LAUNCH_PATH && !currentSearch;
    const raw = fromIcon ? window.localStorage.getItem(LAST_ROUTE_KEY) : null;
    const saved = raw ? JSON.parse(raw) : null;
    const valid =
      saved &&
      typeof saved.pathname === 'string' &&
      saved.pathname.startsWith('/') && // same-origin paths only
      !saved.pathname.startsWith('//') && // protocol-relative guard
      saved.pathname !== currentPathname;
    capturedThisLoad = valid
      ? saved.pathname + (typeof saved.search === 'string' ? saved.search : '')
      : null;
    return capturedThisLoad;
  } catch (e) {
    capturedThisLoad = null;
    return null;
  }
}
