import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import { useAuth } from './AuthContext';

const DEFAULT_PREFS = { skin: 'dark', density: 'normal', sidebar: 'full' };

const PALETTES = {
  dark: {
    accent: { h: 212, s: 78, l: 44 },
    ok:     { h: 168, s: 62 },
    warn:   { h: 192, s: 72 },
    danger: { h: 262, s: 62 },
    info:   { h: 224, s: 72 },
    violet: { h: 280, s: 68 },
  },
  light: {
    accent: { h: 120, s: 16, l: 20 },
    ok:     { h: 120, s: 16 },
    warn:   { h: 36,  s: 62 },
    danger: { h: 10,  s: 58 },
    info:   { h: 208, s: 36 },
    violet: { h: 280, s: 40 },
  },
};

const FONTS = {
  dark:  { ui: "'Inter', system-ui, sans-serif",
           display: "'Inter', system-ui, sans-serif",
           mono: "'JetBrains Mono', ui-monospace, monospace",
           numeric: "'JetBrains Mono', ui-monospace, monospace" },
  light: { ui: "'Inter', system-ui, sans-serif",
           display: "'Libre Caslon Text', Georgia, serif",
           mono: "'JetBrains Mono', ui-monospace, monospace",
           numeric: "'Libre Caslon Text', Georgia, serif" },
};

const UserPrefsContext = createContext(null);

function storageKey(user) {
  if (!user?.id) return null;
  return `drb-admin-prefs-${user.id}`;
}

function load(user) {
  const key = storageKey(user);
  if (!key) return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_PREFS, ...parsed };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function UserPrefsProvider({ children }) {
  const { user } = useAuth();
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);

  useEffect(() => {
    setPrefs(load(user));
  }, [user?.id]);

  useEffect(() => {
    const key = storageKey(user);
    if (!key) return;
    try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* quota etc. */ }
  }, [prefs, user?.id]);

  // Apply prefs to <html> as data attributes and HSL custom properties.
  // These only take effect when [data-app="admin-os"] is also set on <html>,
  // which AdminLayout toggles on mount/unmount.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.skin = prefs.skin;
    root.dataset.density = prefs.density;
    root.dataset.sidebar = prefs.sidebar;
    root.dataset.palette = 'rainbow';

    const p = PALETTES[prefs.skin] || PALETTES.dark;
    root.style.setProperty('--accent-h', p.accent.h);
    root.style.setProperty('--accent-s', p.accent.s + '%');
    if (p.accent.l != null) root.style.setProperty('--accent-l', p.accent.l + '%');
    root.style.setProperty('--ok-h', p.ok.h);
    root.style.setProperty('--ok-s', p.ok.s + '%');
    root.style.setProperty('--warn-h', p.warn.h);
    root.style.setProperty('--warn-s', p.warn.s + '%');
    root.style.setProperty('--danger-h', p.danger.h);
    root.style.setProperty('--danger-s', p.danger.s + '%');
    root.style.setProperty('--info-h', p.info.h);
    root.style.setProperty('--info-s', p.info.s + '%');
    root.style.setProperty('--violet-h', p.violet.h);
    root.style.setProperty('--violet-s', p.violet.s + '%');

    const f = FONTS[prefs.skin] || FONTS.dark;
    root.style.setProperty('--font-ui', f.ui);
    root.style.setProperty('--font-display', f.display);
    root.style.setProperty('--font-mono', f.mono);
    root.style.setProperty('--font-numeric', f.numeric);
  }, [prefs]);

  const setPref = useCallback((key, value) => {
    setPrefs(p => ({ ...p, [key]: value }));
  }, []);

  const value = useMemo(() => ({ prefs, setPref }), [prefs, setPref]);
  return <UserPrefsContext.Provider value={value}>{children}</UserPrefsContext.Provider>;
}

export function useUserPrefs() {
  const ctx = useContext(UserPrefsContext);
  if (!ctx) throw new Error('useUserPrefs must be used inside UserPrefsProvider');
  return ctx;
}
