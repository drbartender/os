import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import BrandLogo from './BrandLogo';

const NAV_ITEMS = [
  { label: 'Staffing',   path: '/admin/staffing',   icon: '👥' },
  { label: 'Events',     path: '/admin/events',     icon: '📅' },
  { label: 'Clients',    path: '/admin/clients',    icon: '🤝' },
  { label: 'Financials', path: '/admin/financials',  icon: '📒' },
  'divider',
  { label: 'Settings',   path: '/admin/settings',   icon: '⚙' },
];

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
          <span className="header-user">{user?.email}</span>
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
                </NavLink>
              )
            )}
          </nav>
        </aside>

        <main className="admin-content">
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
