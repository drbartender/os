import React, { useState, useMemo } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import BrandLogo from './BrandLogo';

const STAFF_NAV = [
  { label: 'Dashboard',   path: '/dashboard',  icon: '📊' },
  { label: 'Shifts',      path: '/shifts',     icon: '📅' },
  { label: 'My Schedule', path: '/schedule',   icon: '🗓' },
  { label: 'My Events',   path: '/events',     icon: '📋' },
  'divider',
  { label: 'Resources',   path: '/resources',  icon: '📖' },
  { label: 'Profile',     path: '/profile',    icon: '👤' },
];

// Admin/manager users see an extra entry to jump back to the admin shell.
// Cross-subdomain hop (staff.drbartender.com → admin.drbartender.com), so this
// renders as an <a href> anchor rather than a NavLink — React Router can't
// navigate across origins.
// Role flips (staff → manager) propagate via the AuthContext tab-focus refresh.
const ADMIN_LINK = { label: 'Admin Portal', href: 'https://admin.drbartender.com/dashboard', icon: '🛠', external: true };

export default function StaffLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const NAV_ITEMS = useMemo(() => {
    const isAdminOrManager = user?.role === 'admin' || user?.role === 'manager';
    return isAdminOrManager ? [ADMIN_LINK, 'divider', ...STAFF_NAV] : STAFF_NAV;
  }, [user?.role]);

  const handleLogout = () => { logout(); navigate('/login'); };

  return (
    <div className="admin-page" style={{ minHeight: '100vh' }}>
      <a href="#main-content" className="skip-nav">Skip to main content</a>
      <header className="site-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <button
            className="admin-sidebar-toggle"
            onClick={() => setSidebarOpen(o => !o)}
            aria-label="Toggle sidebar"
          >
            ☰
          </button>
          <BrandLogo />
        </div>
        <div className="header-actions">
          <span className="header-user">{user?.preferred_name || user?.email}</span>
          <button className="btn btn-secondary btn-sm" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      <div className="admin-shell">
        <aside className={`admin-sidebar${sidebarOpen ? ' open' : ''}`}>
          <nav className="admin-sidebar-nav">
            {NAV_ITEMS.map((item, i) =>
              item === 'divider' ? (
                <div key={i} className="admin-sidebar-divider" />
              ) : item.external ? (
                <a
                  key={item.href}
                  href={item.href}
                  className="admin-nav-item"
                  onClick={() => setSidebarOpen(false)}
                >
                  <span className="admin-nav-icon">{item.icon}</span>
                  {item.label}
                </a>
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

        <main id="main-content" className="admin-content">
          <Outlet />
        </main>
      </div>

      {sidebarOpen && (
        <div className="admin-sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}
    </div>
  );
}
