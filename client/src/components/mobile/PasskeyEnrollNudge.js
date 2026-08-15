import React, { useState } from 'react';
import { useToast } from '../../context/ToastContext';
import { isPasskeySupported, registerPasskey } from '../../utils/webauthnClient';
import {
  dismissNudge, markPasskeyEnrolled, nudgeDismissed, passkeyEnrolledHere, touchLastActive,
} from '../../utils/mobileLock';

// One-time post-login nudge (spec section 8: password login once, then
// passkey registration). Rendered only inside the phone chrome; gone forever
// on enroll or dismiss (both flags purge with the rest of the phone state on
// logout, so a fresh account sees it again, which is correct).
export default function PasskeyEnrollNudge() {
  const toast = useToast();
  const [visible, setVisible] = useState(
    () => isPasskeySupported() && !passkeyEnrolledHere() && !nudgeDismissed()
  );
  const [busy, setBusy] = useState(false);
  if (!visible) return null;

  const onEnroll = async () => {
    setBusy(true);
    try {
      await registerPasskey('This phone');
      markPasskeyEnrolled();
      touchLastActive();
      toast.success('Fingerprint unlock is on.');
      setVisible(false);
    } catch (err) {
      toast.error(err?.message || 'Could not set up fingerprint unlock.');
    } finally {
      setBusy(false);
    }
  };
  const onDismiss = () => { dismissNudge(); setVisible(false); };

  return (
    <div className="m-enroll-nudge" role="region" aria-label="Fingerprint unlock">
      <span className="m-enroll-copy">Unlock with your fingerprint next time</span>
      <button type="button" className="m-enroll-yes" onClick={onEnroll} disabled={busy}>
        {busy ? 'Setting up...' : 'Turn on'}
      </button>
      <button type="button" className="m-enroll-no" onClick={onDismiss} disabled={busy}>
        Not now
      </button>
    </div>
  );
}
