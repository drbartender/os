import React, { useCallback, useEffect, useRef } from 'react';

// One negative-number convention everywhere in this modal: minus BEFORE the
// dollar sign (−$575.00), Unicode minus, matching the signed delta.
const usd = (n) => (Number(n) < 0 ? '\u2212' : '') + '$' + Math.abs(Number(n)).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

const sign = (n) => (n >= 0 ? '+' : '\u2212') + '$' + Math.abs(Number(n)).toLocaleString('en-US', {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});

// Booked-event reprice confirmation. Numbers + consequence lines come fully
// formed from buildRepriceSummary; this component only renders. Mirrors
// ConfirmModal's overlay/escape/focus-trap behavior but with a structured
// body (ConfirmModal renders a single string message, which cannot show the
// old/new/delta table).
export default function RepriceConfirmModal({ isOpen, summary, onConfirm, onCancel }) {
  const confirmRef = useRef(null);
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    confirmRef.current?.focus();
    const handleKeyDown = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onCancel]);

  // Tab trap, ported from ConfirmModal: aria-modal promises focus containment,
  // and this dialog gates a money mutation, so Tab must not wander into the
  // dimmed editor behind the overlay.
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

  if (!isOpen || !summary) return null;

  return (
    <div className="confirm-modal-overlay" onClick={onCancel}>
      <div
        ref={modalRef}
        className="confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reprice-modal-title"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleTabTrap}
      >
        <h3 id="reprice-modal-title">This changes the price of a booked event</h3>
        {!summary.unknown && (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto auto', gap: '4px 16px', margin: '10px 0', fontSize: 13 }}>
            <span className="muted">Total</span>
            <span>{usd(summary.oldTotal)} {'→'} <strong>{usd(summary.newTotal)}</strong> ({sign(summary.delta)})</span>
            <span className="muted">Paid so far</span>
            <span>{usd(summary.paid)}</span>
            <span className="muted">New balance</span>
            <span>{usd(summary.newBalance)}</span>
          </div>
        )}
        <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
          {summary.lines.map((line, i) => <li key={i} style={{ marginBottom: 4 }}>{line}</li>)}
        </ul>
        <div className="confirm-modal-actions">
          <button className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
          <button ref={confirmRef} className="btn btn-primary btn-sm" onClick={onConfirm}>Save and reprice</button>
        </div>
      </div>
    </div>
  );
}
