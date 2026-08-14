import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import * as Sentry from '@sentry/react';
import api from '../utils/api';
import Sidebar from './adminos/Sidebar';
import Header from './adminos/Header';
import CommandPalette from './adminos/CommandPalette';
import PaletteContext from '../context/PaletteContext';
import { MobileViewProvider, useMobileView } from '../context/MobileViewContext';
import { routeScreenKey, screenTitle } from '../utils/screenKey';
import { recordRoute, consumeRestoredRoute } from '../utils/routeRestore';
import MobileHeader from './mobile/MobileHeader';
import MobileTabBar from './mobile/MobileTabBar';

function AdminLayoutInner() {
  const navigate = useNavigate();
  const location = useLocation();
  const [badges, setBadges] = useState({});
  const [presence, setPresence] = useState(null);
  const lastPresenceMutationRef = useRef(0);

  // POST responses are server truth and must not be overwritten by a poll
  // that started earlier (spec: Fetch and display, stale-poll guard).
  const applyPresence = useCallback((data) => {
    lastPresenceMutationRef.current = Date.now();
    setPresence(data);
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Where focus goes back to when the palette closes. Captured at open time
  // (launcher click or Cmd/Ctrl+K), restored on ANY close path (Esc, scrim,
  // navigation) so a keyboard user is never dropped to <body>.
  const paletteTriggerRef = useRef(null);
  const prevPaletteOpenRef = useRef(false);

  const openPalette = useCallback(() => {
    paletteTriggerRef.current = document.activeElement;
    setPaletteOpen(true);
  }, []);
  const paletteCtx = useMemo(() => ({ openPalette }), [openPalette]);

  useEffect(() => {
    if (prevPaletteOpenRef.current && !paletteOpen) {
      const el = paletteTriggerRef.current;
      paletteTriggerRef.current = null;
      // The opener may have unmounted (e.g. Enter navigated to a new page);
      // only restore focus if it's still in the document.
      if (el && el.isConnected && typeof el.focus === 'function') el.focus();
    }
    prevPaletteOpenRef.current = paletteOpen;
  }, [paletteOpen]);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Mark the document as being inside the Admin OS shell so the scoped CSS
  // (html[data-app="admin-os"] …) takes effect. Remove on unmount so public /
  // staff / auth pages revert to their own styling.
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-app');
    root.setAttribute('data-app', 'admin-os');
    return () => {
      if (prev) root.setAttribute('data-app', prev);
      else root.removeAttribute('data-app');
    };
  }, []);

  // Lazy-load the admin-OS font set (Inter / JetBrains Mono / Libre Caslon)
  // from inside the admin shell so the public pages never pay the ~80-200ms
  // first-paint cost. The `media="print"` + onload trick fetches the
  // stylesheet without blocking initial render — the swap to `media="all"`
  // applies the rules once they arrive (system-font fallback in the meantime).
  // The link is appended once and persists across admin page navigations.
  useEffect(() => {
    const ID = 'admin-os-fonts';
    let link = document.getElementById(ID);
    let createdHere = false;
    if (!link) {
      link = document.createElement('link');
      link.id = ID;
      link.rel = 'stylesheet';
      link.media = 'print';
      link.onload = () => { link.media = 'all'; };
      link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&display=swap';
      document.head.appendChild(link);
      createdHere = true;
    }
    return () => {
      // Only remove if this mount created it — guards against rapid remount
      // races (StrictMode or hot reload) yanking fonts mid-render.
      if (createdHere && link.parentNode) link.parentNode.removeChild(link);
    };
  }, []);

  useEffect(() => {
    const fetchBadges = () => {
      if (document.visibilityState !== 'visible') return;
      const startedAt = Date.now();
      api.get('/admin/badge-counts').then(r => {
        const { presence: p, ...counts } = r.data || {};
        setBadges(counts);
        if (p && startedAt > lastPresenceMutationRef.current) setPresence(p);
      }).catch(() => {});
    };
    fetchBadges();
    const interval = setInterval(fetchBadges, 60000);
    // Refresh immediately when the tab becomes visible again after being hidden,
    // so the admin doesn't see stale counts the moment they return.
    const onVisibility = () => { if (document.visibilityState === 'visible') fetchBadges(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const onKey = useCallback((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      setPaletteOpen(v => {
        if (!v) paletteTriggerRef.current = document.activeElement;
        return !v;
      });
    } else if (e.key === 'Escape') {
      setPaletteOpen(false);
      setMobileNavOpen(false);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  // Close the mobile nav drawer whenever the route changes so the user lands on
  // the page they tapped — never on a covered overlay.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the mobile nav drawer is open so the page behind
  // doesn't scroll under the user's finger.
  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [mobileNavOpen]);

  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);
  const openMobileNav = useCallback(() => setMobileNavOpen(true), []);

  // ---- Phone fork (spec 2026-08-13-mobile-admin section 3) -----------------
  const { isPhone, desktopView, setDesktopView } = useMobileView();
  const screenKey = routeScreenKey(location.pathname);
  const mobileChrome = isPhone && !desktopView(screenKey);

  // Resume-where-I-left-off (spec section 9). The restore target is captured
  // DURING THE FIRST RENDER, before any effect runs: the record effect below
  // flushes first on mount and would overwrite the saved route with the
  // current one before an effect-based restore could read it (lane review
  // proved the effect-ordered version dead on arrival). consumeRestoredRoute
  // memoizes per JS load, so StrictMode's double-invoked initializer gets the
  // same answer twice. Both gates live HERE so a non-qualifying launch never
  // consumes the one-shot.
  const [restoreTarget] = useState(() => {
    const standalone =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(display-mode: standalone)').matches;
    if (!standalone || !isPhone) return null;
    return consumeRestoredRoute(location.pathname);
  });
  useEffect(() => {
    if (restoreTarget) navigate(restoreTarget, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Record every admin route AFTER the restore capture above. recordRoute
  // lives INSIDE the AdminLayout element on purpose: /login and the
  // auth/reset pages mount outside it and can never be recorded.
  useEffect(() => {
    recordRoute(location.pathname, location.search);
  }, [location.pathname, location.search]);

  // Dead-route fallback (spec section 9): a restored route whose entity is
  // gone (archived proposal, role change) must fall back to /events, never
  // strand. The chrome owns the listener; the screen lanes dispatch
  // `mobile-route-dead` from their 404/403 read handlers. Persistent (every
  // dead route falls back, not just the first) and gated on the phone chrome
  // being live, so shared screen code dispatching at desktop width can never
  // yank a desktop user off their page.
  useEffect(() => {
    if (!mobileChrome) return undefined;
    const onDead = () => navigate('/events', { replace: true });
    window.addEventListener('mobile-route-dead', onDead);
    return () => window.removeEventListener('mobile-route-dead', onDead);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobileChrome]);

  // Phone-specific breakage must be independently visible (spec section 10).
  // Cleared on unmount so post-logout surfaces are never mistagged.
  useEffect(() => {
    Sentry.setTag('surface', mobileChrome ? 'mobile-admin' : undefined);
    return () => Sentry.setTag('surface', undefined);
  }, [mobileChrome]);

  if (mobileChrome) {
    const isDetail = screenKey === 'event-detail' || screenKey === 'proposal-detail';
    // On a restored cold launch history has no in-app entry behind the detail
    // screen; navigate(-1) would exit the PWA. Fall back to the parent list.
    const backTarget = screenKey === 'proposal-detail' ? '/proposals' : '/events';
    const onBack = () => {
      if (window.history.state && window.history.state.idx > 0) navigate(-1);
      else navigate(backTarget, { replace: true });
    };
    return (
      <PaletteContext.Provider value={paletteCtx}>
        <a href="#main-content" className="skip-nav">Skip to main content</a>
        <div className="m-shell">
          <MobileHeader
            title={screenTitle(screenKey)}
            screenKey={screenKey}
            onBack={isDetail ? onBack : null}
          />
          <main className="m-main" id="main-content"><Outlet context={{ badges }} /></main>
          <MobileTabBar badges={badges} />
        </div>
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      </PaletteContext.Provider>
    );
  }

  return (
    <PaletteContext.Provider value={paletteCtx}>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <div className={`shell${mobileNavOpen ? ' mobile-nav-open' : ''}`}>
        <Sidebar badges={badges} presence={presence} onPresenceChange={applyPresence} onCloseMobileNav={closeMobileNav} />
        <Header
          onQuickAdd={() => navigate('/proposals/new')}
          onOpenMobileNav={openMobileNav}
          mobileNavOpen={mobileNavOpen}
        />
        <main className="main scroll-thin" id="main-content">
          <Outlet />
        </main>
        <div
          className={`shell-scrim${mobileNavOpen ? ' open' : ''}`}
          onClick={closeMobileNav}
          aria-hidden="true"
        />
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      {isPhone && (
        <button
          type="button"
          className="m-return-pill"
          onClick={() => setDesktopView(screenKey, false)}
        >
          <span className="m-return-pill-rx" aria-hidden="true">&#8478;</span> Phone view
        </button>
      )}
    </PaletteContext.Provider>
  );
}

// The provider wraps the inner layout so every admin page, current and
// future, can fork on useMobileView() (spec section 3).
export default function AdminLayout() {
  return (
    <MobileViewProvider>
      <AdminLayoutInner />
    </MobileViewProvider>
  );
}
