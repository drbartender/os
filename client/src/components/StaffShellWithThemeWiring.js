import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import api from '../utils/api';
import { useAuth } from '../context/AuthContext';
import StaffShell from './StaffShell';

const STAFF_TABS = [
  { id: 'home',     label: 'Home',     icon: 'home',     path: '/' },
  { id: 'shifts',   label: 'Shifts',   icon: 'calendar', path: '/shifts' },
  { id: 'pay',      label: 'Pay',      icon: 'dollar',   path: '/pay' },
  { id: 'tip-card', label: 'Tip Card', icon: 'card',     path: '/tip-card' },
];

const SUPPORT_MAILTO = 'mailto:staff@drbartender.com';

/**
 * Derive two-character uppercase initials from a name. Falls back to the
 * email local-part's first two chars when no name is available, then to
 * an empty string so the avatar is never `undefined`.
 */
function deriveInitials(user) {
  if (!user) return '';
  const name = (user.preferred_name || '').trim();
  if (name) {
    const parts = name.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }
  const email = (user.email || '').trim();
  if (email) {
    const local = email.split('@')[0] || '';
    return local.slice(0, 2).toUpperCase();
  }
  return '';
}

/**
 * Map the current pathname under /* onto a tab id. Account routes
 * keep whatever tab the user was on (treated as an overlay per spec §6.1),
 * so the active id falls through to whichever tab matched last.
 */
function pickActiveTab(pathname) {
  if (pathname.startsWith('/shifts')) return 'shifts';
  if (pathname.startsWith('/pay')) return 'pay';
  if (pathname.startsWith('/tip-card')) return 'tip-card';
  return 'home';
}

/**
 * Pre-paint default for the skin. Server hydration runs in an effect AFTER
 * first paint, so reading the OS preference + any pre-set <html data-skin>
 * attribute synchronously avoids a one-frame flash.
 */
function detectInitialSkin() {
  if (typeof document === 'undefined') return 'dark';
  const existing = document.documentElement.dataset.skin;
  if (existing === 'light' || existing === 'dark') return existing;
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'dark';
}

/**
 * Wraps StaffShell with theme persistence wiring (spec §6.16) and the
 * route-driven plumbing (tabs from useLocation, navigation via useNavigate).
 * Used by the early / stub mount in App.js so subsequent tasks can
 * render real pages via the <Outlet/> without re-doing the chrome.
 */
export default function StaffShellWithThemeWiring() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  const [skin, setSkin] = useState(detectInitialSkin);

  // Hydrate skin from the server on mount. Falls back to prefers-color-scheme
  // only when ui_preferences.theme is null (new user / never toggled).
  useEffect(() => {
    let cancelled = false;
    api
      .get('/me/ui-preferences')
      .then((res) => {
        if (cancelled) return;
        const theme = res?.data?.ui_preferences?.theme;
        if (theme === 'light' || theme === 'dark') {
          setSkin(theme);
        }
        // theme === null → keep the prefers-color-scheme default from
        // detectInitialSkin so the user sees their OS preference until
        // they explicitly pick one.
      })
      .catch(() => {
        // Network/server error — fall back silently to the initial skin.
        // The user can still toggle (PATCH may fail too, but that's its
        // own surface to error on).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist on user toggle. Optimistically apply the new skin first (the
  // dataset write happens via StaffShell's effect on `skin`), then PATCH.
  // If the PATCH fails we leave the optimistic state in place — the user's
  // current session still reflects their pick, and the next mount will
  // re-hydrate from whatever the server actually has.
  const handleSkinChange = useCallback((next) => {
    if (next !== 'light' && next !== 'dark') return;
    setSkin(next);
    api.patch('/me/ui-preferences', { theme: next }).catch(() => {
      // Swallow — the optimistic skin is already applied. A toast hook
      // can land in a later task when the staff-portal toast system is
      // wired (spec §6.1.5 disabled/error states).
    });
  }, []);

  const handleLogout = useCallback(() => {
    logout();
    navigate('/login');
  }, [logout, navigate]);

  const active = pickActiveTab(location.pathname);

  const handleTabChange = useCallback(
    (id) => {
      const tab = STAFF_TABS.find((t) => t.id === id);
      if (tab) navigate(tab.path);
    },
    [navigate]
  );

  // 5 menu items per spec §6.1. account/:section routes are placeholders
  // until Task 47 wires the real AccountPage; the menu items still navigate
  // there so the existing routes light up.
  const userMenu = useMemo(
    () => [
      { id: 'profile', icon: 'pen',      label: 'Edit profile',           onClick: () => navigate('/account/profile') },
      { id: 'calendar', icon: 'calendar', label: 'Calendar sync',          onClick: () => navigate('/account/calendar') },
      { id: 'notif',   icon: 'bell',     label: 'Notification preferences', onClick: () => navigate('/account/notifications') },
      { id: 'support', icon: 'mail',     label: 'Get support',            onClick: () => { window.location.href = SUPPORT_MAILTO; } },
      { id: 'signout', icon: 'logout',   label: 'Sign out', tone: 'danger', onClick: handleLogout },
    ],
    [navigate, handleLogout]
  );

  const shellUser = useMemo(
    () => ({
      initials: deriveInitials(user),
      preferred_name: user?.preferred_name || '',
      name: user?.preferred_name || user?.email || '',
      email: user?.email || '',
    }),
    [user]
  );

  return (
    <StaffShell
      tabs={STAFF_TABS}
      active={active}
      onTabChange={handleTabChange}
      badges={{}}
      user={shellUser}
      userMenu={userMenu}
      skin={skin}
      onSkinChange={handleSkinChange}
    >
      <Outlet />
    </StaffShell>
  );
}
