import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { purgeMobileAdminState, announceAdminSwUser } from '../utils/adminSw';
import api from '../utils/api';

const AuthContext = createContext(null);

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
          // A dead session must not leave its cached reads on the device
          // (security review M2), but session death means a REAL 401: a
          // transport-failed bootstrap is the offline cold launch, and
          // purging there deletes the exact cache offline mode serves
          // (caught by the lane's own offline verification). The token
          // clear below still over-fires on transport failures; that is
          // the pre-existing defect lane ma-d-auth owns.
          if (err?.status === 401) purgeMobileAdminState();
          localStorage.removeItem('token');
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
      // Mirror the bootstrap behavior: a dead JWT should sign the user out
      // instead of lingering as a stale token.
      if (err?.status === 401) {
        purgeMobileAdminState(); // security review M2: cache dies with the session
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
