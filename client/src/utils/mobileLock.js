import { PHONE_MEDIA_QUERY } from '../hooks/useIsPhone';

// Phone lock model (mobile-admin spec 2026-08-13 section 8): backgrounded
// more than 30 minutes, or an expired JWT, locks the phone surface behind a
// biometric re-assert. Pure decisions + a tiny handler registry; the UI is
// MobileLockScreen. Every key below is phone-local state and is purged by
// purgeMobileAdminState on logout (utils/adminSw.js imports them).
export const LOCK_AFTER_MS = 30 * 60 * 1000;
export const LAST_ACTIVE_KEY = 'adminLockLastActiveAt';
export const ENROLLED_KEY = 'adminPasskeyEnrolled';
export const NUDGE_DISMISSED_KEY = 'adminPasskeyNudgeDismissed';

// The 30-minute clock measures BACKGROUNDED time, not inactivity: the stamp
// is written when the app goes to background and CLEARED whenever it is
// live in the foreground. A stamp that is merely old (continuous use, or a
// short background that did not lock) must never lock a later re-evaluation.
export function touchLastActive(now = Date.now()) {
  try { window.localStorage.setItem(LAST_ACTIVE_KEY, String(now)); } catch (e) { /* storage blocked */ }
}
export function clearLastActive() {
  try { window.localStorage.removeItem(LAST_ACTIVE_KEY); } catch (e) { /* storage blocked */ }
}
export function readLastActive() {
  try {
    const v = parseInt(window.localStorage.getItem(LAST_ACTIVE_KEY), 10);
    return Number.isFinite(v) ? v : null;
  } catch (e) { return null; }
}
export function passkeyEnrolledHere() {
  try { return window.localStorage.getItem(ENROLLED_KEY) === '1'; } catch (e) { return false; }
}
export function markPasskeyEnrolled() {
  try { window.localStorage.setItem(ENROLLED_KEY, '1'); } catch (e) { /* storage blocked */ }
}
export function nudgeDismissed() {
  try { return window.localStorage.getItem(NUDGE_DISMISSED_KEY) === '1'; } catch (e) { return true; }
}
export function dismissNudge() {
  try { window.localStorage.setItem(NUDGE_DISMISSED_KEY, '1'); } catch (e) { /* storage blocked */ }
}

// exp claim of a JWT in ms, or null when unreadable. Informational only: the
// server still enforces expiry; this decides whether to SHOW the lock.
export function tokenExpMs(token) {
  try {
    const payload = token.split('.')[1];
    const json = JSON.parse(window.atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.exp === 'number' ? json.exp * 1000 : null;
  } catch (e) { return null; }
}

export function isPhoneViewport() {
  try { return window.matchMedia(PHONE_MEDIA_QUERY).matches; } catch (e) { return false; }
}

// Armed = this device enrolled a passkey AND is at phone width. Everything
// that diverges from today's desktop behavior gates on this.
export function phoneUnlockArmed() {
  return passkeyEnrolledHere() && isPhoneViewport();
}

export function shouldLock({ token, lastActiveAt, armed, now = Date.now() }) {
  if (!armed || !token) return false;
  const exp = tokenExpMs(token);
  if (exp !== null && exp <= now) return true;
  if (lastActiveAt !== null && now - lastActiveAt > LOCK_AFTER_MS) return true;
  return false;
}

// Revocation-class 401s (spec section 8): these die everywhere, armed or not.
// ONE list, consumed by AuthContext's purge law AND the lock's 401 claim, so
// the two paths implementing the same law cannot drift (external review,
// 2026-08-14: the claim originally ignored the code, so a revoke landing on
// any endpoint other than /auth/me locked the phone with its token and caches
// intact).
const REVOCATION_CODES = new Set(['TOKEN_VERSION_MISMATCH', 'USER_NOT_FOUND']);
export function isRevocationCode(code) {
  return REVOCATION_CODES.has(code);
}

// SessionExpiryHandler asks before logging out on a 401: a mounted phone
// chrome with an enrolled passkey claims the event into the lock instead.
// Desktop admin and the staff portal never register a handler and keep
// today's logout path. The handler returns true only when it accepted, and
// it is passed the 401's code so it can refuse to claim a revocation.
let lockHandler = null;
export function setMobileLockHandler(fn) {
  lockHandler = fn;
  return () => { if (lockHandler === fn) lockHandler = null; };
}
export function requestMobileLock(code) {
  return lockHandler ? lockHandler(code) === true : false;
}
