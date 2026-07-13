import React from 'react';

/**
 * PushPermissionBanner — staff portal v2 Account / Notifications (spec §6.13).
 *
 * The single top-of-card banner that mirrors the browser's push permission
 * state. NotificationsSection computes a derived state and hands it here; we
 * only render. No async, no API calls, no state of our own — the caller owns
 * the subscribe flow + the coachmark open/close.
 *
 * Five states, matching the spec verbatim:
 *   granted          — green: push is on for this device.
 *   default          — neutral: "Enable push" CTA → onEnable().
 *   denied           — red: re-enable instructions (no CTA — can only be
 *                     fixed in browser settings).
 *   unsupported      — info: browser can't do push, SMS + email still work.
 *   iosNeedsInstall  — amber: install-to-home-screen → "Show me how" →
 *                     onShowCoachmark().
 *
 * Returns null for unknown states (defensive — caller controls the value, but
 * a future state added without a render branch should fail soft, not crash).
 */

export default function PushPermissionBanner({
  state,
  subscribed = true,
  removing = false,
  onEnable,
  onRemove,
  onShowCoachmark,
}) {
  if (state === 'granted') {
    // Permission is granted but this device has no active subscription (e.g.,
    // the user just removed it). Offer the enable affordance again rather than
    // claiming push is on.
    if (!subscribed) {
      return (
        <div className="sp-push-banner neutral" role="status">
          <BellIcon size={14} />
          <div className="sp-push-banner-body">
            <div>
              <div className="sp-push-banner-t">
                <strong>Push isn't on for this device.</strong>
              </div>
              <div className="sp-notif-banner-sub">
                Enable push to get app alerts on this device.
              </div>
            </div>
            <button
              type="button"
              className="sp-btn sp-btn-sm sp-btn-primary"
              onClick={onEnable}
            >
              Enable push
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="sp-push-banner ok" role="status">
        <CheckIcon size={14} />
        <div className="sp-push-banner-body">
          <div>
            <div className="sp-push-banner-t">
              <strong>Push is on for this device.</strong>
            </div>
            <div className="sp-notif-banner-sub">
              You'll get push for any category below where it's switched on.
            </div>
          </div>
          <button
            type="button"
            className="sp-btn sp-btn-sm"
            onClick={onRemove}
            disabled={removing}
          >
            {removing ? 'Removing…' : 'Remove this device'}
          </button>
        </div>
      </div>
    );
  }

  if (state === 'default') {
    return (
      <div className="sp-push-banner neutral" role="status">
        <BellIcon size={14} />
        <div className="sp-push-banner-body">
          <div>
            <div className="sp-push-banner-t">
              <strong>Push isn't on yet.</strong>
            </div>
            <div className="sp-notif-banner-sub">
              Enable push to get app alerts on this device.
            </div>
          </div>
          <button
            type="button"
            className="sp-btn sp-btn-sm sp-btn-primary"
            onClick={onEnable}
          >
            Enable push
          </button>
        </div>
      </div>
    );
  }

  if (state === 'denied') {
    return (
      <div className="sp-push-banner denied" role="status">
        <WarnIcon size={14} />
        <div>
          <div className="sp-push-banner-t">
            <strong>Push is blocked.</strong>
          </div>
          <div className="sp-notif-banner-sub">
            Turn it back on in your browser's site settings for this page, then
            reload. SMS and email still work in the meantime.
          </div>
        </div>
      </div>
    );
  }

  if (state === 'unsupported') {
    return (
      <div className="sp-push-banner info" role="status">
        <InfoIcon size={14} />
        <div>
          <div className="sp-push-banner-t">
            <strong>Your browser doesn't support push.</strong>
          </div>
          <div className="sp-notif-banner-sub">
            SMS and email still work. Try Chrome, Edge, or Firefox if you'd
            like push too.
          </div>
        </div>
      </div>
    );
  }

  if (state === 'iosNeedsInstall') {
    return (
      <div className="sp-push-banner ios" role="status">
        <PhoneIcon size={14} />
        <div className="sp-push-banner-body">
          <div>
            <div className="sp-push-banner-t">
              <strong>iOS: install Dr. Bartender on your home screen to receive push.</strong>
            </div>
            <div className="sp-notif-banner-sub">
              Three taps. SMS and email keep working in the meantime.
            </div>
          </div>
          <button
            type="button"
            className="sp-btn sp-btn-sm"
            onClick={onShowCoachmark}
          >
            Show me how
          </button>
        </div>
      </div>
    );
  }

  return null;
}

// ── Inline icons (Lucide-style 1.75 stroke, matches NotificationsSection) ──

function CheckIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function BellIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function WarnIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.7 3.86a2 2 0 0 0-3.4 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function InfoIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function PhoneIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
      <line x1="12" y1="18" x2="12.01" y2="18" />
    </svg>
  );
}
