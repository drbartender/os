import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

// Allowlist the only schemes any kebab item should ever produce. Rejects
// javascript:, data:, vbscript:, etc. — defense-in-depth so a future caller
// can't accidentally turn a user-controlled string into an XSS sink. Also
// strips CRLF to block mailto: header injection per RFC 6068.
const SAFE_HREF_PROTOCOLS = ['mailto:', 'tel:', 'sms:', 'http:', 'https:'];
function safeHref(href) {
  if (typeof href !== 'string') return undefined;
  const trimmed = href.trim();
  if (/[\r\n]/.test(trimmed)) return undefined;
  const lower = trimmed.toLowerCase();
  if (!SAFE_HREF_PROTOCOLS.some(p => lower.startsWith(p))) return undefined;
  return trimmed;
}

// KebabMenu — generic 3-dots-vertical action menu used inside data-table rows.
// Anchors the dropdown via getBoundingClientRect on toggle; the menu renders
// in a portal so the row's overflow / z-index doesn't clip it.
//
// Usage:
//   <KebabMenu items={[
//     { label: 'View', icon: 'eye', onClick: () => ... },
//     { label: 'Email', icon: 'mail', href: 'mailto:foo@bar.com' },
//     { label: 'Delete', icon: 'x', danger: true, disabled: false, onClick: () => ... },
//   ]} />
//
// An item with `href` renders as <a> so right-click/middle-click and native
// mailto:/tel:/sms: dispatch work. Disabled href items drop the href +
// add aria-disabled so they don't fire on click.
export default function KebabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (e) => {
      // Click inside the trigger: the trigger's own onClick toggles. No-op here.
      if (triggerRef.current?.contains(e.target)) return;
      // Click inside the portal-rendered menu: the item's onClick closes us.
      // If we close from here on mousedown, React unmounts the item before
      // the mouseup/click can reach it on a normal-length human click.
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onEsc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  const toggle = (e) => {
    e.stopPropagation();
    if (!open && triggerRef.current) {
      const r = triggerRef.current.getBoundingClientRect();
      setAnchor({
        top: r.bottom + window.scrollY + 4,
        left: r.right + window.scrollX,
      });
    }
    setOpen((o) => !o);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn kebab-trigger"
        onClick={toggle}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="kebab" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="kebab-menu"
          role="menu"
          style={{
            position: 'absolute',
            top: anchor.top,
            left: anchor.left,
            transform: 'translateX(-100%)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((item, i) => {
            if (item.href) {
              const cleanHref = safeHref(item.href);
              const isDisabled = !!item.disabled || !cleanHref;
              // Disabled href items render as a button (not an anchor without
              // href — that fails jsx-a11y/anchor-is-valid and isn't keyboard
              // accessible). Leaves the menu open on misclick so the user can
              // pick another item.
              if (isDisabled) {
                return (
                  <button
                    key={i}
                    type="button"
                    role="menuitem"
                    className={`kebab-item ${item.danger ? 'danger' : ''}`}
                    aria-disabled="true"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  >
                    {item.icon && <Icon name={item.icon} size={13} />}
                    <span>{item.label}</span>
                  </button>
                );
              }
              return (
                <a
                  key={i}
                  role="menuitem"
                  className={`kebab-item ${item.danger ? 'danger' : ''}`}
                  href={cleanHref}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                  }}
                >
                  {item.icon && <Icon name={item.icon} size={13} />}
                  <span>{item.label}</span>
                </a>
              );
            }
            return (
              <button
                key={i}
                type="button"
                role="menuitem"
                className={`kebab-item ${item.danger ? 'danger' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onClick?.();
                }}
                disabled={item.disabled}
              >
                {item.icon && <Icon name={item.icon} size={13} />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}
