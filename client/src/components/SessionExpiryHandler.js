import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { useClientAuth } from '../context/ClientAuthContext';
import { clientLoginPath } from './PublicLayout';
import { requestMobileLock } from '../utils/mobileLock';

export default function SessionExpiryHandler() {
  const toast = useToast();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { clientLogout } = useClientAuth();
  const firedRef = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => {
    const onExpired = (e) => {
      if (firedRef.current) return; // First event wins

      const url = e.detail?.url || '';
      const isClientRequest = url.startsWith('/client-portal/') || url.startsWith('/client-auth/');

      // Phone surface (mobile-admin spec section 8): a 401 routes to the lock
      // screen, not a logout. Claimed only when a mounted phone chrome with an
      // enrolled passkey registered a handler; desktop and the staff portal
      // never register one and keep the path below. The once-only guard is NOT
      // set on a claim: repeated 401s just re-assert the (idempotent) lock,
      // and the unlock restores the session in place. The code rides along so
      // the handler can refuse a revocation, which must reach the full logout
      // below and purge (external review, 2026-08-14).
      if (!isClientRequest && requestMobileLock(e.detail?.code)) return;

      firedRef.current = true;
      const target = isClientRequest ? clientLoginPath() : '/login';

      toast.error('Your session expired. Please log in again.');

      timerRef.current = setTimeout(() => {
        if (isClientRequest) clientLogout();
        else logout();
        navigate(target, { replace: true });
      }, 1500);
    };
    // Re-auth (password login or biometric unlock) re-opens the guard so a
    // LATER expiry in this long-lived PWA document can fire again.
    const onRestored = () => { firedRef.current = false; };

    window.addEventListener('session-expired', onExpired);
    window.addEventListener('session-restored', onRestored);
    return () => {
      window.removeEventListener('session-expired', onExpired);
      window.removeEventListener('session-restored', onRestored);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        // The pending logout was cancelled (deps changed or unmount inside
        // the 1.5s window); the guard must re-open or later 401s are
        // swallowed until a session-restored (lane fleet, 2026-08-14).
        firedRef.current = false;
      }
    };
  }, [toast, navigate, logout, clientLogout]);

  return null;
}
