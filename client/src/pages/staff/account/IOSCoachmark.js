import React from 'react';

/**
 * IOSCoachmark — staff portal v2 Account / Notifications (spec §6.13).
 *
 * iOS Safari only delivers web push to a PWA that has been added to the home
 * screen (the standalone-display context). The "iosNeedsInstall" banner in
 * NotificationsSection links here: a small modal walking the staffer through
 * Share button → Add to Home Screen → re-open from the home-screen icon, then
 * return and flip the Push toggles.
 *
 * Style: scrim + sp-modal + sp-modal-close + sp-modal-title + a single
 * full-width "Got it" primary button. The ordered list reuses `sp-modal-sub`
 * spacing for the body text; the inline icons match the Lucide 1.75-stroke
 * style used by NotificationsSection's WarnIcon and StaffShell.
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
          Add Dr. Bartender to your home screen
        </div>
        <div className="sp-modal-sub">
          iOS only delivers push notifications to apps installed on your home
          screen. Three taps and you're set.
        </div>
        <ol className="sp-ios-steps">
          <li>
            <span className="sp-ios-step-icon" aria-hidden="true">
              <ShareIcon />
            </span>
            <div>
              <div className="sp-ios-step-t">Tap the Share button</div>
              <div className="sp-ios-step-s">
                It's at the bottom of Safari (square with an up arrow).
              </div>
            </div>
          </li>
          <li>
            <span className="sp-ios-step-icon" aria-hidden="true">
              <AddSquareIcon />
            </span>
            <div>
              <div className="sp-ios-step-t">Choose "Add to Home Screen"</div>
              <div className="sp-ios-step-s">
                Scroll the share sheet if you don't see it right away.
              </div>
            </div>
          </li>
          <li>
            <span className="sp-ios-step-icon" aria-hidden="true">
              <HomeIcon />
            </span>
            <div>
              <div className="sp-ios-step-t">Open Dr. Bartender from your home screen</div>
              <div className="sp-ios-step-s">
                Then come back to this screen to turn on push.
              </div>
            </div>
          </li>
        </ol>
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

// ── Inline icons (Lucide-style 1.75 stroke, matches NotificationsSection) ──

function ShareIcon() {
  // Square-with-up-arrow — the iOS Safari share glyph.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function AddSquareIcon() {
  // Plus inside a rounded square — the Add to Home Screen glyph.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3" ry="3" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function HomeIcon() {
  // House outline — the home-screen step.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1Z" />
    </svg>
  );
}
