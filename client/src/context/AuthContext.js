import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { purgeMobileAdminState, announceAdminSwUser } from '../utils/adminSw';
import { clearLastActive, isRevocationCode, phoneUnlockArmed } from '../utils/mobileLock';
import api from '../utils/api';

const AuthContext = createContext(null);

// How a failed /auth/me maps to state (spec section 8 purge law, four-way):
//   'purge': revoked (version bump, deleted user), or any dead session on a
//            surface without phone unlock armed: cache + token die (M2).
//   'keep': transport failure (the offline cold launch: the SW serves the
//           cached /auth/me and this path never runs), any non-401 answer,
//           or a plain 401 on a phone with an enrolled passkey, where the
//           lock screen owns re-entry and the caches stay, occluded.
function authFailureAction(err) {
  if (err?.status !== 401) return 'keep';
  // ONE revocation list, shared with the lock's 401 claim (utils/mobileLock).
  if (isRevocationCode(err.code)) return 'purge';
  return phoneUnlockArmed() ? 'keep' : 'purge';
}

// Throttle visibilitychange refreshes — admins who tab-flip heavily would
// otherwise trigger /auth/me on every focus event.
const TAB_FOCUS_REFRESH_COOLDOWN_MS = 30_000;

// Shallow-compare auth-relevant fields. /auth/me always returns a fresh
// object, so a literal setUser would re-render every useAuth() consumer
// (sidebar, route guards, layout) on every refresh — even when nothing the
// app cares about changed. Comparing the relevant fields lets us preserve
// the previous reference and skip the cascade.
function isSameUser(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id
    && a.email === b.email
    && a.role === b.role
    && a.onboarding_status === b.onboarding_status
    && a.has_application === b.has_application
    && a.can_hire === b.can_hire
    && a.can_staff === b.can_staff
    && a.pre_hired === b.pre_hired;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      api.get('/auth/me')
        .then(res => {
          setUser(res.data.user);
          // Announce the SW cache namespace as soon as the user is KNOWN
          // (security review M1: announcing from AdminLayout misses staff
          // users on the admin origin and races first-paint fetches).
          announceAdminSwUser(res.data.user.id);
        })
        .catch((err) => {
          // The four-way purge law lives in authFailureAction. On 'keep'
          // with a real 401 (expired token, unlock armed) the artifact and
          // caches survive, occluded: ProtectedRoute renders the lock gate
          // and a biometric tap re-mints without losing the offline cache.
          if (authFailureAction(err) === 'purge') {
            purgeMobileAdminState();
            localStorage.removeItem('token');
          }
        })
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = (token, userData) => {
    localStorage.setItem('token', token);
    setUser(userData);
    announceAdminSwUser(userData.id);
    clearLastActive(); // authenticated in the foreground: no background interval to measure
    // Re-auth in a long-lived PWA document: the expiry handler's once-only
    // guard resets so a LATER expiry can fire again (spec section 8).
    window.dispatchEvent(new Event('session-restored'));
  };

  const logout = () => {
    // Spec 2026-08-13-mobile-admin section 7: logout purges the phone's SW
    // caches and shell localStorage (one call, defined in utils/adminSw.js).
    purgeMobileAdminState();
    localStorage.removeItem('token');
    setUser(null);
  };

  // Re-fetch the authenticated user. Call this after mutations that change
  // onboarding_status (e.g. finishing payday protocols) so route guards
  // like RequirePortal see the fresh status without a hard reload.
  // useCallback keeps the identity stable so consumers can safely list it in
  // effect dependency arrays without re-fetching on every render.
  const refreshUser = useCallback(async () => {
    const token = localStorage.getItem('token');
    if (!token) return null;
    try {
      const res = await api.get('/auth/me');
      const next = res.data.user;
      setUser(prev => (isSameUser(prev, next) ? prev : next));
      return next;
    } catch (err) {
      // Mirror the bootstrap behavior via the same four-way law. On 'keep'
      // with a 401 the phone lock overlay claims the surface through the
      // session-expired event; leaving user state mounted preserves the
      // exact screen the unlock returns to.
      if (authFailureAction(err) === 'purge') {
        purgeMobileAdminState();
        localStorage.removeItem('token');
        setUser(null);
      }
      throw err;
    }
  }, []);

  // Pick up role/status changes the moment the user returns to the tab.
  // Auth middleware already reads role from the DB per-request, so server-side
  // permission checks are always fresh — this just keeps the *UI* in sync
  // (sidebar links, route guards) without forcing the user to manually refresh
  // after an admin promotes/deactivates them in another window.
  const lastRefreshAt = useRef(0);
  const refreshInflight = useRef(false);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      if (!localStorage.getItem('token')) return;
      if (refreshInflight.current) return;
      if (Date.now() - lastRefreshAt.current < TAB_FOCUS_REFRESH_COOLDOWN_MS) return;
      refreshInflight.current = true;
      refreshUser()
        .catch(() => { /* swallow — refreshUser already handles 401 */ })
        .finally(() => {
          refreshInflight.current = false;
          lastRefreshAt.current = Date.now();
        });
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refreshUser]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
