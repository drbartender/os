import React, { useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { isPasskeySupported, registerPasskey } from '../../utils/webauthnClient';
import {
  markPasskeyEnrolled, passkeyEnrolledHere, touchLastActive,
} from '../../utils/mobileLock';

// The More page's Security section (spec section 8: enrollment stays one tap
// away after the nudge is gone). Known accepted residual: the enrolled flag
// is device-local; a revoke from desktop leaves it stale, the next unlock
// fails into the password path, and re-enrolling resets it. No sync
// round-trip is worth that edge.
export default function MoreSecurityRow() {
  const toast = useToast();
  const [enrolled, setEnrolled] = useState(passkeyEnrolledHere());
  const [busy, setBusy] = useState(false);
  if (!isPasskeySupported()) return null;
  const onEnroll = async () => {
    setBusy(true);
    try {
      await registerPasskey('This phone');
      markPasskeyEnrolled();
      touchLastActive();
      setEnrolled(true);
      toast.success('Fingerprint unlock is on.');
    } catch (err) {
      toast.error(err?.message || 'Could not set up fingerprint unlock.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section>
      <h2 className="m-more-heading">Security</h2>
      <ul className="m-more-list">
        <li>
          {enrolled ? (
            <div className="m-more-row"><span>Fingerprint unlock is on</span></div>
          ) : (
            <button type="button" className="m-more-row" onClick={onEnroll} disabled={busy}>
              <span>{busy ? 'Setting up...' : 'Set up fingerprint unlock'}</span>
            </button>
          )}
        </li>
      </ul>
      <div className="m-seg-note">manage or revoke passkeys in Settings on desktop</div>
    </section>
  );
}
