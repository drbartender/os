// Resume-where-I-left-off (spec section 9). The admin manifest's start_url is
// /events; on a cold standalone launch the shell restores the last recorded
// admin route instead. sessionStorage guards once-per-launch. Half-finished
// edit sheets are deliberately NOT restored; this is route-level only.
// recordRoute is only ever called from inside the AdminLayout route element,
// so /login and the auth/reset pages can never be recorded (spec section 9).
const LAST_ROUTE_KEY = 'adminLastRoute';
const RESTORED_KEY = 'adminRouteRestoredThisLaunch';

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

export function recordRoute(pathname, search) {
  try {
    window.localStorage.setItem(
      LAST_ROUTE_KEY,
      JSON.stringify({ pathname, search: search || '' })
    );
  } catch (e) {
    // Best-effort; a full store just means no resume this time.
  }
}

export function consumeRestoredRoute(currentPathname) {
  if (capturedThisLoad !== undefined) return capturedThisLoad;
  try {
    if (window.sessionStorage.getItem(RESTORED_KEY)) {
      capturedThisLoad = null;
      return null;
    }
    window.sessionStorage.setItem(RESTORED_KEY, '1');
    const raw = window.localStorage.getItem(LAST_ROUTE_KEY);
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
