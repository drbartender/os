import React, { useEffect, useState, useCallback } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import api from '../utils/api';
import Sidebar from './adminos/Sidebar';
import Header from './adminos/Header';
import CommandPalette from './adminos/CommandPalette';

export default function AdminLayout() {
  const navigate = useNavigate();
  const [badges, setBadges] = useState({});
  const [paletteOpen, setPaletteOpen] = useState(false);

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
      api.get('/admin/badge-counts').then(r => setBadges(r.data || {})).catch(() => {});
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
      setPaletteOpen(v => !v);
    } else if (e.key === 'Escape') {
      setPaletteOpen(false);
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onKey]);

  return (
    <>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <div className="shell">
        <Sidebar badges={badges} />
        <Header
          onOpenPalette={() => setPaletteOpen(true)}
          onQuickAdd={() => navigate('/admin/proposals/new')}
        />
        <main className="main scroll-thin" id="main-content">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}
