import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import BrandLogo from './BrandLogo';
import AdminBreadcrumbs from './AdminBreadcrumbs';
import api from '../utils/api';

const NAV_ITEMS = [
  { label: 'Dashboard',   path: '/admin/dashboard',   icon: '📊' },
  { label: 'Events',      path: '/admin/events',      icon: '📅', badgeKey: 'unstaffed_events' },
  { label: 'Proposals',   path: '/admin/proposals',   icon: '📋', badgeKey: 'pending_proposals' },
  { label: 'Clients',     path: '/admin/clients',     icon: '🤝' },
  { label: 'Staff',       path: '/admin/staffing',    icon: '👥' },
  { label: 'Hiring',      path: '/admin/hiring',      icon: '📝', badgeKey: 'new_applications' },
  { label: 'Financials',  path: '/admin/financials',  icon: '📒' },
  { label: 'Blog',        path: '/admin/blog',        icon: '✏' },
  { label: 'Marketing',   path: '/admin/email-marketing', icon: '✉' },
  'divider',
  { label: 'Settings',    path: '/admin/settings',    icon: '⚙' },
];

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [badges, setBadges] = useState({});

  useEffect(() => {
    const fetchBadges = () => {
      api.get('/admin/badge-counts').then(r => setBadges(r.data)).catch(() => {});
    };
    fetchBadges();
    const interval = setInterval(fetchBadges, 60000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <div className="admin-page" style={{ minHeight: '100vh' }}>
      {/* ── Shared Header ── */}
      <header className="site-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            className="admin-sidebar-toggle"
            onClick={() => setSidebarOpen(o => !o)}
            aria-label="Toggle sidebar"
          >
            ☰
          </button>
          <BrandLogo admin />
        </div>
        <div className="header-actions">
          <span className="header-user">{user?.name || user?.email}</span>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      {/* ── Shell: Sidebar + Content ── */}
      <div className="admin-shell">
        <aside className={`admin-sidebar${sidebarOpen ? ' open' : ''}`}>
          <nav className="admin-sidebar-nav">
            {NAV_ITEMS.map((item, i) =>
              item === 'divider' ? (
                <div key={i} className="admin-sidebar-divider" />
              ) : (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={false}
                  className={({ isActive }) =>
                    `admin-nav-item${isActive ? ' active' : ''}`
                  }
                  onClick={() => setSidebarOpen(false)}
                >
                  <span className="admin-nav-icon">{item.icon}</span>
                  {item.label}
                  {item.badgeKey && badges[item.badgeKey] > 0 && (
                    <span className="nav-badge">{badges[item.badgeKey]}</span>
                  )}
                </NavLink>
              )
            )}
          </nav>
        </aside>

        <main className="admin-content">
          <AdminBreadcrumbs />
          <Outlet />
        </main>
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div className="admin-sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}
    </div>
  );
}
