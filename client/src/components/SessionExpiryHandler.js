import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { useClientAuth } from '../context/ClientAuthContext';
import { clientLoginPath } from './PublicLayout';

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
      firedRef.current = true;

      const url = e.detail?.url || '';
      const isClientRequest = url.startsWith('/client-portal/') || url.startsWith('/client-auth/');
      const target = isClientRequest ? clientLoginPath() : '/login';

      toast.error('Your session expired — please log in again.');

      timerRef.current = setTimeout(() => {
        if (isClientRequest) clientLogout();
        else logout();
        navigate(target, { replace: true });
      }, 1500);
    };

    window.addEventListener('session-expired', onExpired);
    return () => {
      window.removeEventListener('session-expired', onExpired);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [toast, navigate, logout, clientLogout]);

  return null;
}
