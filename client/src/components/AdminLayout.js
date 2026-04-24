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

  useEffect(() => {
    const fetchBadges = () => {
      api.get('/admin/badge-counts').then(r => setBadges(r.data || {})).catch(() => {});
    };
    fetchBadges();
    const interval = setInterval(fetchBadges, 60000);
    return () => clearInterval(interval);
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
