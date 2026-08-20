import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import Icon from '../adminos/Icon';
import NAV, { navBadgeCount } from '../adminos/nav';

// Bottom tab bar for the phone admin shell (spec section 3, benchmark
// composition). Events/Proposals carry needs-you badges from the sidebar's
// badgeKey mapping; More aggregates every nav item that is not one of those
// two tabs into the NEUTRAL badge variant so "something is waiting in there"
// reads without crying danger. That aggregate is derived from NAV through
// navBadgeCount rather than a hand-kept key list, so an item that gains a
// badge key (the Staff hub sums two) is counted here with no second edit.
// Active tab carries the benchmark's accent stripe. The active tab is derived
// from the pathname, so every More-reached surface (/clients, /settings, ...)
// lights the More tab. Plain Link, not NavLink: NavLink runs its OWN matcher
// for aria-current and class, which disagrees with the derived active state on
// those surfaces.
const TAB_IDS = new Set(['events', 'proposals']);
const MORE_ITEMS = NAV.flatMap((s) => s.items).filter((i) => !TAB_IDS.has(i.id));
const TABS = [
  { id: 'events', label: 'Events', icon: 'calendar', path: '/events', badgeKey: 'unstaffed_events' },
  { id: 'proposals', label: 'Proposals', icon: 'clipboard', path: '/proposals', badgeKey: 'pending_proposals' },
  { id: 'more', label: 'More', icon: 'menu', path: '/more', neutral: true },
];

export default function MobileTabBar({ badges = {} }) {
  const { pathname } = useLocation();
  const activeId = pathname.startsWith('/events')
    ? 'events'
    : pathname.startsWith('/proposals')
      ? 'proposals'
      : 'more';
  return (
    <nav className="m-tabbar" aria-label="Primary">
      {TABS.map((t) => {
        const count = t.neutral
          ? MORE_ITEMS.reduce((a, i) => a + navBadgeCount(i, badges), 0)
          : badges[t.badgeKey] || 0;
        const isActive = t.id === activeId;
        return (
          <Link
            key={t.id}
            to={t.path}
            className={`m-tab${isActive ? ' active' : ''}`}
            aria-current={isActive ? 'page' : undefined}
            aria-label={count > 0 ? `${t.label}, ${count} waiting` : undefined}
          >
            {isActive && <span className="m-tab-stripe" aria-hidden="true" />}
            <span className="m-tab-icon">
              <Icon name={t.icon} size={20} />
              {count > 0 && (
                <span className={`m-tab-badge${t.neutral ? ' neutral' : ''}`} aria-hidden="true">{count}</span>
              )}
            </span>
            <span className="m-tab-label">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
