import React, { useEffect, useRef, useCallback } from 'react';

export default function ConfirmModal({ isOpen, title, message, onConfirm, onCancel }) {
  const confirmRef = useRef(null);
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    confirmRef.current?.focus();
    const handleKeyDown = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  const handleTabTrap = useCallback((e) => {
    if (e.key !== 'Tab' || !modalRef.current) return;
    const focusable = modalRef.current.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }, []);

  if (!isOpen) return null;

  return (
    <div className="confirm-modal-overlay" onClick={onCancel}>
      <div
        ref={modalRef}
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleTabTrap}
      >
        <h3 id="confirm-modal-title">{title || 'Confirm'}</h3>
        <p>{message || 'Are you sure?'}</p>
        <div className="confirm-modal-actions">
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} className="btn btn-primary btn-sm" onClick={onConfirm}>Confirm</button>
        </div>
      </div>
    </div>
  );
}
