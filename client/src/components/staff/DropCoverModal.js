import React, { useState } from 'react';

const REASON_MIN_EMERGENCY = 10;
const REASON_MAX = 500;

/**
 * DropCoverModal — staff-portal drop/cover sheet (spec §6.5).
 *
 * Mode is decided UPSTREAM by `hoursToEvent` (the ShiftDetail page computes
 * it and passes the mode in). Boundaries (per spec):
 *   - hoursToEvent >= 336   → 'drop'      (14+ days out, simple confirm)
 *   - 72 <= hours < 336      → 'cover'     (broadcast cover request)
 *   - hours < 72             → 'emergency' (reason 10..500 chars required)
 *
 * On submit, the component calls onSubmit with `{ mode, reason }`. Reason
 * is always trimmed to MAX_LEN before posting; the emergency mode also
 * enforces the >= MIN_LEN gate client-side (the server is the authoritative
 * gate, but a disabled button + inline counter is the UX feedback).
 *
 * The PII warning under the emergency textarea is fixed copy per the
 * implementation brief: "Don't include sensitive medical or personal
 * details. Admins can see this and it's retained in our records."
 *
 * Props:
 *   open       — boolean, render-on-mount toggle
 *   mode       — 'drop' | 'cover' | 'emergency'
 *   busy       — boolean, primary button disabled-with-spinner state
 *   onClose    — close handler (scrim click, ✕ button, Cancel)
 *   onSubmit   — async submitter: receives { mode, reason } and resolves
 *                when the network round-trip completes. Caller is
 *                responsible for closing the modal on success.
 */
export default function DropCoverModal({ open, mode, busy = false, onClose, onSubmit }) {
  const [reason, setReason] = useState('');

  // Reset the reason every time the modal opens fresh. A user who opens
  // cover → cancels → opens emergency on the same shift should start with
  // an empty textarea, not whatever they typed last time.
  React.useEffect(() => {
    if (open) setReason('');
  }, [open, mode]);

  if (!open) return null;
  if (mode !== 'drop' && mode !== 'cover' && mode !== 'emergency') return null;

  const trimmedLen = reason.trim().length;
  const isOver = trimmedLen > REASON_MAX;
  const emergencyValid = !isOver && trimmedLen >= REASON_MIN_EMERGENCY;

  function submit() {
    // Server caps at 500, but trim defensively so a copy-paste with trailing
    // whitespace doesn't tip a payload over the limit on the wire.
    const trimmed = reason.trim().slice(0, REASON_MAX);
    onSubmit({ mode, reason: trimmed });
  }

  if (mode === 'drop') {
    return (
      <DcSheet onClose={onClose}>
        <div className="sp-modal-icon" aria-hidden="true">
          <CalendarIcon size={20} />
        </div>
        <div className="sp-modal-title">Drop this shift?</div>
        <div className="sp-modal-sub">
          14+ days out. The slot returns to the open pool and management
          gets notified.
        </div>
        <div className="sp-modal-acts">
          <button
            type="button"
            className="sp-btn sp-btn-block"
            onClick={onClose}
            disabled={busy}
          >
            Never mind
          </button>
          <button
            type="button"
            className="sp-btn sp-btn-block sp-btn-primary"
            onClick={submit}
            disabled={busy}
          >
            <CheckIcon size={13} />
            {busy ? 'Dropping…' : 'Yes, drop the shift'}
          </button>
        </div>
      </DcSheet>
    );
  }

  if (mode === 'cover') {
    return (
      <DcSheet onClose={onClose}>
        <div className="sp-modal-icon warn" aria-hidden="true">
          <UsersIcon size={20} />
        </div>
        <div className="sp-modal-title">Broadcast a cover request</div>
        <div className="sp-modal-sub">
          Under 14 days. The shift goes to qualified bartenders;{' '}
          <strong>you stay on the roster until someone picks it up</strong>.
          Until then, show up.
        </div>
        <label className="sp-modal-label" htmlFor="dc-reason-cover">
          Reason (optional)
        </label>
        <textarea
          id="dc-reason-cover"
          className="sp-modal-input"
          rows={2}
          placeholder="Helps the next bartender understand the gig."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={REASON_MAX + 50}
        />
        {isOver && (
          <div className="sp-modal-error">
            {`Trim to ${REASON_MAX} characters or fewer (currently ${trimmedLen}).`}
          </div>
        )}
        <div className="sp-modal-acts">
          <button
            type="button"
            className="sp-btn sp-btn-block"
            onClick={onClose}
            disabled={busy}
          >
            Never mind
          </button>
          <button
            type="button"
            className="sp-btn sp-btn-block sp-btn-primary"
            onClick={submit}
            disabled={busy || isOver}
          >
            <SendIcon size={13} />
            {busy ? 'Broadcasting…' : 'Broadcast cover request'}
          </button>
        </div>
      </DcSheet>
    );
  }

  // emergency
  return (
    <DcSheet onClose={onClose}>
      <div className="sp-modal-icon danger" aria-hidden="true">
        <AlertIcon size={20} />
      </div>
      <div className="sp-modal-title">Emergency, can’t make it</div>
      <div className="sp-modal-sub">
        Under 72 hours. This pings management by SMS immediately. Repeated
        late-drops affect future bookings.
      </div>
      <label className="sp-modal-label" htmlFor="dc-reason-emergency">
        What happened? (required)
      </label>
      <textarea
        id="dc-reason-emergency"
        className="sp-modal-input"
        rows={4}
        placeholder="Be specific. Management will read this on their phone."
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={REASON_MAX + 50}
        aria-describedby="dc-reason-emergency-warn"
        aria-invalid={isOver || trimmedLen < REASON_MIN_EMERGENCY}
      />
      <div className="sp-modal-warn" id="dc-reason-emergency-warn">
        Don’t include sensitive medical or personal details. Admins can see
        this and it’s retained in our records.
      </div>
      {isOver ? (
        <div className="sp-modal-error">
          {`Trim to ${REASON_MAX} characters or fewer (currently ${trimmedLen}).`}
        </div>
      ) : trimmedLen > 0 && trimmedLen < REASON_MIN_EMERGENCY ? (
        <div className="sp-modal-error">
          {`Add a bit more, ${REASON_MIN_EMERGENCY - trimmedLen} more character${REASON_MIN_EMERGENCY - trimmedLen === 1 ? '' : 's'}.`}
        </div>
      ) : null}
      <div className="sp-modal-acts">
        <button
          type="button"
          className="sp-btn sp-btn-block"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="sp-btn sp-btn-block sp-btn-danger"
          disabled={!emergencyValid || busy}
          onClick={submit}
        >
          <SendIcon size={13} />
          {busy ? 'Notifying…' : 'Notify management now'}
        </button>
      </div>
    </DcSheet>
  );
}

function DcSheet({ children, onClose }) {
  // Esc closes the sheet (lightweight — no focus-trap library; the close
  // button is the first interactive descendant so Tab from the textarea
  // lands on it next).
  React.useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose && onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="sp-modal-scrim" onClick={onClose} />
      <div className="sp-modal" role="dialog" aria-modal="true">
        <button
          type="button"
          className="sp-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          <CloseIcon size={14} />
        </button>
        {children}
      </div>
    </>
  );
}

// ── Inline icons ─────────────────────────────────────────────────────────

function CalendarIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18M8 3v4M16 3v4" />
    </svg>
  );
}

function UsersIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function AlertIcon({ size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function CheckIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function SendIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function CloseIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
