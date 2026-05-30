import React, { useEffect } from 'react';

/**
 * Minimal stroke icons for the user-pill menu (Lucide-style, stroke 1.75).
 * Kept inline so this component has zero extra deps; if a project-wide icon
 * set lands later (per spec §6.1), this can swap out without touching the
 * shell.
 */
function SunIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
    </svg>
  );
}

function MoonIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 15.5A8 8 0 0 1 8.5 4a8 8 0 1 0 11.5 11.5Z" />
    </svg>
  );
}

function MenuItemIcon({ name, size = 14 }) {
  const paths = {
    pen: <path d="M4 20h4l10-10-4-4L4 16v4ZM14 6l4 4" />,
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></>,
    bell: <><path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9Z" /><path d="M10 21a2 2 0 0 0 4 0" /></>,
    mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
    logout: <path d="M10 17l-5-5 5-5M5 12h12M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />,
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

/**
 * Renders the popover menu opened by the user-pill button in StaffShell.
 * Mounted as a sibling of the pill, positioned absolutely. A transparent
 * scrim catches outside-clicks and closes the menu via `onClose`.
 *
 * Props:
 *   user           { initials, name, email }
 *   skin           'light' | 'dark'
 *   onSkinChange   (next) => void
 *   userMenu       [{ id, icon, label, tone?, onClick }]  // 5 items per spec
 *   onClose        () => void
 */
export default function StaffUserPillMenu({ user, skin, onSkinChange, userMenu, onClose }) {
  // Close on Escape so keyboard users can dismiss without a click.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = Array.isArray(userMenu) ? userMenu : [];

  return (
    <>
      <div
        className="sp-menu-scrim"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="sp-menu" role="menu">
        <div className="sp-menu-head">
          <div className="sp-avatar" style={{ width: 32, height: 32, fontSize: 12 }}>
            {user?.initials || ''}
          </div>
          <div className="sp-menu-head-l">
            <div className="sp-menu-head-name">{user?.name || ''}</div>
            <div className="sp-menu-head-sub">{user?.email || ''}</div>
          </div>
        </div>
        <div className="sp-menu-list">
          <div className="sp-menu-section">
            <div className="sp-menu-section-k">Lighting</div>
            <div className="sp-skin-seg" role="group" aria-label="Lighting">
              <button
                type="button"
                className={'sp-skin-seg-btn' + (skin === 'light' ? ' active' : '')}
                onClick={() => onSkinChange && onSkinChange('light')}
                aria-pressed={skin === 'light'}
              >
                <SunIcon size={13} />House lights
              </button>
              <button
                type="button"
                className={'sp-skin-seg-btn' + (skin === 'dark' ? ' active' : '')}
                onClick={() => onSkinChange && onSkinChange('dark')}
                aria-pressed={skin === 'dark'}
              >
                <MoonIcon size={13} />After hours
              </button>
            </div>
          </div>
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              role="menuitem"
              className={'sp-menu-item' + (it.tone ? ' ' + it.tone : '')}
              onClick={() => {
                onClose();
                if (it.onClick) it.onClick();
              }}
            >
              <MenuItemIcon name={it.icon} size={14} />
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
