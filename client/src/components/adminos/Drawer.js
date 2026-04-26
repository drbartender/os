import React, { useEffect } from 'react';
import Icon from './Icon';

export default function Drawer({ open, onClose, crumb, children, onOpenPage, footer }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock body scroll while the drawer is open so wheel events don't bleed
  // through the scrim onto the underlying list page.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  return (
    <>
      <div className={`drawer-scrim ${open ? 'open' : ''}`} onClick={onClose} aria-hidden={!open} />
      <div
        className={`drawer ${open ? 'open' : ''}`}
        role="dialog"
        aria-modal={open ? 'true' : 'false'}
        aria-hidden={!open}
      >
        <div className="drawer-head">
          {crumb}
          {onOpenPage && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenPage}>
              <Icon name="external" size={11} />Open page
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close drawer">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="drawer-body scroll-thin">{children}</div>
        {footer}
      </div>
    </>
  );
}
