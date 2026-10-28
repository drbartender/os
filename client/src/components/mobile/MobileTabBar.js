// MobileTabBar (React component, default export). Header generated from the file's exports by
// migrate-headers on 2026-10-27; replace with what it does.

import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import Icon from '../adminos/Icon';
import NAV, { navBadgeCount } from '../adminos/nav';

// Bottom tab bar for the phone admin shell (spec section 3, benchmark
// composition). Inbox is the FIRST tab (spec 2026-10-06 section 9): it carries
// the waiting count, read through navBadgeCount like the sidebar, so a count
// the server could not compute (null) draws "!" and never a misleading 0.
// Events/Proposals carry needs-you badges from the sidebar's badgeKey mapping;
// More aggregates every nav item that is not one of the tabs into the NEUTRAL
// badge variant so "something is waiting in there" reads without crying
// danger. That aggregate is derived from NAV through navBadgeCount rather than
// a hand-kept key list, so an item that gains a badge key (the Staff hub sums
// two) is counted here with no second edit.
// Active tab carries the benchmark's accent stripe. The active tab is derived
// from the pathname, so every More-reached surface (/clients, /settings, ...)
// lights the More tab. Plain Link, not NavLink: NavLink runs its OWN matcher
// for aria-current and class, which disagrees with the derived active state on
// those surfaces.
const TAB_IDS = new Set(['inbox', 'events', 'proposals']);
const MORE_ITEMS = NAV.flatMap((s) => s.items).filter((i) => !TAB_IDS.has(i.id));
const TABS = [
  { id: 'inbox', label: 'Inbox', icon: 'mail', path: '/inbox', badgeKey: 'inbox_waiting' },
  { id: 'events', label: 'Events', icon: 'calendar', path: '/events', badgeKey: 'unstaffed_events' },
  { id: 'proposals', label: 'Proposals', icon: 'clipboard', path: '/proposals', badgeKey: 'pending_proposals' },
  { id: 'more', label: 'More', icon: 'menu', path: '/more', neutral: true },
];

function activeTabId(pathname) {
  if (pathname.startsWith('/inbox')) return 'inbox';
  if (pathname.startsWith('/events')) return 'events';
  if (pathname.startsWith('/proposals')) return 'proposals';
  return 'more';
}

export default function MobileTabBar({ badges = {} }) {
  const { pathname } = useLocation();
  const activeId = activeTabId(pathname);
  return (
    <nav className="m-tabbar" aria-label="Primary">
      {TABS.map((t) => {
        const count = t.neutral
          ? MORE_ITEMS.reduce((a, i) => a + (navBadgeCount(i, badges) || 0), 0)
          : navBadgeCount(t, badges);
        const unknown = count === null;
        const isActive = t.id === activeId;
        let label;
        if (unknown) label = `${t.label}, count unavailable`;
        else if (count > 0) label = `${t.label}, ${count} waiting`;
        return (
          <Link
            key={t.id}
            to={t.path}
            className={`m-tab${isActive ? ' active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            aria-label={label}
          >
            {isActive && <span className="m-tab-stripe" aria-hidden="true" />}
            <span className="m-tab-icon">
              <Icon name={t.icon} size={20} />
              {(unknown || count > 0) && (
                <span className={`m-tab-badge${t.neutral ? ' neutral' : ''}`} aria-hidden="true">{unknown ? '!' : count}</span>
              )}
            </span>
            <span className="m-tab-label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
