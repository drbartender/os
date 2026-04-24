import React from 'react';
import { useLocation } from 'react-router-dom';
import Icon from './Icon';
import NAV from './nav';

function findNavLabel(pathname) {
  for (const group of NAV) {
    for (const item of group.items) {
      if (pathname === item.path || pathname.startsWith(item.path + '/')) return item.label;
    }
  }
  return 'Dashboard';
}

export default function Header({ onOpenPalette, onQuickAdd, unreadCount = 0 }) {
  const { pathname } = useLocation();
  const title = findNavLabel(pathname);

  return (
    <header className="header">
      <div className="header-crumbs">
        <span>Workspace</span>
        <span className="crumb-sep">/</span>
        <span className="crumb-current">{title}</span>
      </div>
      <button type="button" className="header-search" onClick={onOpenPalette} aria-label="Open command palette">
        <Icon name="search" />
        <span>Search events, clients, proposals…</span>
        <span className="kbd-group" style={{ display: 'flex', gap: 2 }}>
          <span className="kbd">⌘</span><span className="kbd">K</span>
        </span>
      </button>
      <div className="header-actions">
        <button type="button" className="icon-btn" title="Notifications" aria-label="Notifications">
          <Icon name="bell" />
          {unreadCount > 0 && <span className="dot" />}
        </button>
        <button type="button" className="icon-btn" title="New proposal" aria-label="Quick create" onClick={onQuickAdd}>
          <Icon name="plus" />
        </button>
      </div>
    </header>
  );
}
