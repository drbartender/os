import React from 'react';

/**
 * IOSCoachmark — staff portal v2 Account / Notifications (spec §6.13).
 *
 * **Phase A STUB.** This is a minimal placeholder so NotificationsSection has
 * something to import. The real coachmark — a modal walking the staffer
 * through the iOS "Add to Home Screen" install flow so the PWA can receive
 * web push — ships in Phase B (Task 54), when the Push column is actually
 * live.
 *
 * In Phase A the Push column is gated off site-wide (every push toggle is
 * disabled with a "Coming in v1.5" tooltip), so there is no flow that can
 * trigger this modal. The stub is wired through anyway so the type
 * signature is stable across the phase boundary: NotificationsSection
 * already passes `open` + `onClose`, and Phase B drops in the real impl
 * without touching the caller.
 *
 * Spec §6.13 (Phase B target shape, for reference): scrim + modal + close,
 * 3-step ordered list (Share button → Add to Home Screen → open from the
 * home-screen icon) with inline icons, single "Got it" dismiss button.
 */

export default function IOSCoachmark({ open, onClose }) {
  if (!open) return null;
  return (
    <>
      <div className="sp-modal-scrim" onClick={onClose} />
      <div
        className="sp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sp-ios-coachmark-title"
      >
        <button
          type="button"
          className="sp-modal-close"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        <div id="sp-ios-coachmark-title" className="sp-modal-title">
          Push coming soon
        </div>
        <div className="sp-modal-sub">
          iOS install instructions land with push support in v1.5. Until
          then, SMS and email cover everything.
        </div>
        <div className="sp-modal-acts">
          <button
            type="button"
            className="sp-btn sp-btn-block sp-btn-primary"
            onClick={onClose}
          >
            Got it
          </button>
        </div>
      </div>
    </>
  );
}
