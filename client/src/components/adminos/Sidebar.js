import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useUserPrefs } from '../../context/UserPrefsContext';
import Icon from './Icon';
import NAV from './nav';

function isActive(pathname, itemPath) {
  return pathname === itemPath || pathname.startsWith(itemPath + '/');
}

function initialsOf(user) {
  const src = user?.name || user?.email || '?';
  return src.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

function roleLabel(role) {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  return 'Team';
}

export default function Sidebar({ badges = {} }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const { prefs, setPref } = useUserPrefs();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-mark">℞</div>
        <div className="sidebar-brand-text">Dr. Bartender <span className="muted">OS</span></div>
      </div>

      <nav className="sidebar-nav scroll-thin">
        {NAV.map(group => (
          <React.Fragment key={group.section}>
            <div className="sidebar-section">{group.section}</div>
            {group.items.map(item => {
              const active = isActive(pathname, item.path);
              const count = item.badgeKey ? badges[item.badgeKey] || 0 : 0;
              return (
                <div
                  key={item.id}
                  className={`nav-item ${active ? 'active' : ''}`}
                  onClick={() => navigate(item.path)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(item.path); } }}
                >
                  <Icon name={item.icon} />
                  <span className="nav-label">{item.label}</span>
                  {count > 0 && <span className="nav-badge">{count}</span>}
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </nav>

      <div className="sidebar-footer sidebar-footer-controls">
        <button
          type="button"
          className="sidebar-footer-action"
          title={prefs.sidebar === 'rail' ? 'Expand sidebar' : 'Collapse to rail'}
          onClick={() => setPref('sidebar', prefs.sidebar === 'rail' ? 'full' : 'rail')}
        >
          <Icon name={prefs.sidebar === 'rail' ? 'right' : 'left'} size={13} />
        </button>
        <div className="mode-toggle" role="radiogroup" aria-label="Visual mode">
          <button
            type="button"
            role="radio"
            aria-checked={prefs.skin === 'light'}
            className={`mode-opt ${prefs.skin === 'light' ? 'active' : ''}`}
            onClick={() => prefs.skin !== 'light' && setPref('skin', 'light')}
          >House Lights</button>
          <button
            type="button"
            role="radio"
            aria-checked={prefs.skin === 'dark'}
            className={`mode-opt ${prefs.skin === 'dark' ? 'active' : ''}`}
            onClick={() => prefs.skin !== 'dark' && setPref('skin', 'dark')}
          >After Hours</button>
        </div>
        <div className="mode-toggle" role="radiogroup" aria-label="Density">
          <button
            type="button"
            role="radio"
            aria-checked={prefs.density === 'comfy'}
            className={`mode-opt ${prefs.density === 'comfy' ? 'active' : ''}`}
            onClick={() => prefs.density !== 'comfy' && setPref('density', 'comfy')}
          >Comfy</button>
          <button
            type="button"
            role="radio"
            aria-checked={prefs.density === 'compact'}
            className={`mode-opt ${prefs.density === 'compact' ? 'active' : ''}`}
            onClick={() => prefs.density !== 'compact' && setPref('density', 'compact')}
          >Compact</button>
        </div>
      </div>

      <div className="sidebar-footer sidebar-footer--user">
        <div className="avatar">{initialsOf(user)}</div>
        <div className="sidebar-footer-main">
          <div className="sidebar-footer-name">{user?.name || user?.email || 'Signed in'}</div>
          <div className="sidebar-footer-role">{roleLabel(user?.role)} · Dr. Bartender</div>
        </div>
        <button type="button" className="sidebar-footer-action" title="Sign out" onClick={handleLogout}>
          <Icon name="logout" size={13} />
        </button>
      </div>
    </aside>
  );
}
