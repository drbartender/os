import React, { useState, useEffect } from 'react';

// Lightweight reject-with-reason modal. The reason becomes
// applications.rejection_reason and is surfaced on the rejected banner +
// recently-rejected card on the kanban.
export default function RejectModal({ open, onClose, onConfirm }) {
  const [reason, setReason]     = useState('');
  const [submitting, setSubmit] = useState(false);

  useEffect(() => {
    if (!open) {
      setReason('');
      setSubmit(false);
    }
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!reason.trim()) return;
    setSubmit(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setSubmit(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      onClick={onClose}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Reject application"
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
        display: 'grid', placeItems: 'center',
      }}
    >
      <div onClick={e => e.stopPropagation()} className="card" style={{ width: 420, maxWidth: '92vw' }}>
        <div className="card-head"><h3>Reject application</h3></div>
        <div className="card-body vstack" style={{ gap: 12 }}>
          <p className="tiny muted">A short reason helps when reviewing later. Visible only to admins.</p>
          <textarea
            className="input"
            placeholder="e.g. limited availability, no BASSET, didn't show for screen…"
            value={reason}
            onChange={e => setReason(e.target.value)}
            style={{ minHeight: 90, padding: 10, resize: 'vertical' }}
            autoFocus
          />
          <div className="hstack" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={!reason.trim() || submitting}
              style={{ background: 'hsl(var(--danger-h) var(--danger-s) 50%)', borderColor: 'transparent' }}
            >
              {submitting ? 'Rejecting…' : 'Reject'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
