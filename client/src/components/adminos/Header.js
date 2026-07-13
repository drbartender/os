import React from 'react';
import { useLocation } from 'react-router-dom';
import Icon from './Icon';
import NAV from './nav';
import GlobalSearchButton from './GlobalSearchButton';

function findPageTitle(pathname) {
  for (const group of NAV) {
    for (const item of group.items) {
      if (pathname === item.path || pathname.startsWith(item.path + '/')) return item.label;
    }
  }
  return 'Dashboard';
}

export default function Header({ onQuickAdd, onOpenMobileNav, mobileNavOpen = false }) {
  const { pathname } = useLocation();
  const title = findPageTitle(pathname);

  return (
    <header className="header">
      <button
        type="button"
        className="header-menu-btn"
        onClick={onOpenMobileNav}
        aria-label="Open menu"
        aria-expanded={mobileNavOpen}
        aria-controls="primary-nav"
      >
        <Icon name="menu" size={20} />
      </button>
      <div className="header-title">{title}</div>
      <GlobalSearchButton />
      <div className="header-actions">
        <button type="button" className="icon-btn" title="New proposal" aria-label="Quick create" onClick={onQuickAdd}>
          <Icon name="plus" />
        </button>
      </div>
    </header>
  );
}
