import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './Icon';

// KebabMenu — generic 3-dots-vertical action menu used inside data-table rows.
// Anchors the dropdown via getBoundingClientRect on toggle; the menu renders
// in a portal so the row's overflow / z-index doesn't clip it.
//
// Usage:
//   <KebabMenu items={[
//     { label: 'View', icon: 'eye', onClick: () => ... },
//     { label: 'Delete', icon: 'x', danger: true, disabled: false, onClick: () => ... },
//   ]} />
export default function KebabMenu({ items }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ top: 0, left: 0 });
  const triggerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (e) => {
      if (triggerRef.current && !triggerRef.current.contains(e.target)) {
        // Defer so the item's own onClick fires first when clicking inside the menu.
        setTimeout(() => setOpen(false), 0);
      }
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
          {items.map((item, i) => (
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
          ))}
        </div>,
        document.body
      )}
    </>
  );
}
