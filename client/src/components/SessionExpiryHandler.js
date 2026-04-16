import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { useClientAuth } from '../context/ClientAuthContext';

export default function SessionExpiryHandler() {
  const toast = useToast();
  const navigate = useNavigate();
  const { logout } = useAuth();
  const { clientLogout } = useClientAuth();

  useEffect(() => {
    const onExpired = (e) => {
      const url = e.detail?.url || '';
      const isClientRequest = url.startsWith('/client-portal/') || url.startsWith('/client-auth/');
      const target = isClientRequest ? '/client/login' : '/login';

      toast.error('Your session expired — please log in again.');

      setTimeout(() => {
        if (isClientRequest) clientLogout();
        else logout();
        navigate(target, { replace: true });
      }, 1500);
    };

    window.addEventListener('session-expired', onExpired);
    return () => window.removeEventListener('session-expired', onExpired);
  }, [toast, navigate, logout, clientLogout]);

  return null;
}
