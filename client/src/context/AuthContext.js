import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '../utils/api';

const AuthContext = createContext(null);

// Throttle visibilitychange refreshes — admins who tab-flip heavily would
// otherwise trigger /auth/me on every focus event.
const TAB_FOCUS_REFRESH_COOLDOWN_MS = 30_000;

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (token) {
      api.get('/auth/me')
        .then(res => setUser(res.data.user))
        .catch(() => localStorage.removeItem('token'))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = (token, userData) => {
    localStorage.setItem('token', token);
    setUser(userData);
  };

  const logout = () => {
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
      setUser(res.data.user);
      return res.data.user;
    } catch (err) {
      // Mirror the bootstrap behavior: a dead JWT should sign the user out
      // instead of lingering as a stale token.
      if (err?.status === 401) {
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
