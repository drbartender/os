import React, { useState, useEffect } from 'react';
import StaffUserPillMenu from './StaffUserPillMenu';

/**
 * Minimal tab-icon set used inline so the shell does not pull in a
 * project-wide icon module. Lucide-style strokes at 1.75. When the spec's
 * shared Icon module lands (later in the staff-portal redesign), this map
 * can be replaced without changing the StaffShell API.
 */
function TabIcon({ name, size = 18 }) {
  const paths = {
    home: <path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1V9.5Z" />,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></>,
    dollar: <path d="M12 3v18M16 7c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 3 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3" />,
    card: <><rect x="3" y="6" width="18" height="13" rx="2" /><path d="M3 11h18" /></>,
  };
  const inner = paths[name];
  if (!inner) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {inner}
    </svg>
  );
}

function CaretDown({ size = 11 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

/**
 * StaffShell — chrome for the redesigned staff portal (spec §6.1).
 *
 * Renders three regions:
 *   1. <header className="sp-topbar"> — brand mark on the left, user-pill on
 *      the right. The pill opens StaffUserPillMenu in a popover.
 *   2. <nav className="sp-tabs"> — 4 tabs with optional unread-badge dots.
 *   3. <main className="sp-page"> — children area.
 *
 * Theme persistence: a useEffect on `skin` writes
 * `document.documentElement.dataset.skin` so the skin-aware tokens
 * (--sp-ink-1, --sp-bg-0, etc.) resolve correctly. The actual fetch + PATCH
 * to `/api/me/ui-preferences` lives in StaffShellWithThemeWiring (Task 31).
 *
 * Props:
 *   tabs         [{ id, label, icon }]
 *   active       string  // id of the currently active tab
 *   onTabChange  (id) => void
 *   badges       { [tabId]: number }  // unread counts; > 0 renders a dot
 *   user         { initials, preferred_name, name, email }
 *   userMenu     [{ id, icon, label, tone?, onClick }]  // 5 items per spec
 *   skin         'light' | 'dark'
 *   onSkinChange (next) => void
 *   children     React node — page body
 */
export default function StaffShell({
  tabs,
  active,
  onTabChange,
  badges = {},
  user,
  userMenu = [],
  skin,
  onSkinChange,
  children,
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Mirror the skin onto <html data-skin="..."> so [data-skin] CSS tokens
  // resolve. Reset on unmount only if this component owns the value — leave
  // it intact otherwise so a parent wrapper can keep persisting it.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (skin === 'light' || skin === 'dark') {
      document.documentElement.dataset.skin = skin;
    }
  }, [skin]);

  const safeTabs = Array.isArray(tabs) ? tabs : [];

  return (
    <div className="sp-shell">
      <header className="sp-topbar">
        <div className="sp-brand">
          <div className="sp-brand-mark">R</div>
          Dr. Bartender
          <span className="sp-brand-sub">Staff</span>
        </div>
        <div className="sp-userpill-wrap">
          <button
            type="button"
            className={'sp-userpill' + (menuOpen ? ' open' : '')}
            onClick={() => setMenuOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <div className="sp-avatar">{user?.initials || ''}</div>
            <span className="sp-userpill-name">{user?.preferred_name || ''}</span>
            <CaretDown size={11} />
          </button>
          {menuOpen && (
            <StaffUserPillMenu
              user={user}
              skin={skin}
              onSkinChange={onSkinChange}
              userMenu={userMenu}
              onClose={() => setMenuOpen(false)}
            />
          )}
        </div>
      </header>
      <nav className="sp-tabs" aria-label="Staff portal sections">
        {safeTabs.map((t) => {
          const isActive = active === t.id;
          const badge = badges[t.id];
          return (
            <button
              key={t.id}
              type="button"
              className={'sp-tab' + (isActive ? ' active' : '')}
              onClick={() => onTabChange && onTabChange(t.id)}
              aria-current={isActive ? 'page' : undefined}
            >
              {badge > 0 && <span className="sp-tab-badge">{badge}</span>}
              <TabIcon name={t.icon} size={18} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </nav>
      <main className="sp-page">{children}</main>
    </div>
  );
}
