import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import PublicLayout, { clientLoginPath } from '../../../components/PublicLayout';
import { useClientAuth } from '../../../context/ClientAuthContext';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import EventCommandCenter from './EventCommandCenter';
import ArchiveList from './ArchiveList';
import { BrandNewEmpty, NoEvent } from './EmptyStates';

export default function PortalHome() {
  const { clientUser, clientLoading, isClientAuthenticated } = useClientAuth();
  const navigate = useNavigate(); const toast = useToast();
  const [home, setHome] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => { if (!clientLoading && !isClientAuthenticated) navigate(clientLoginPath(), { replace: true }); }, [clientLoading, isClientAuthenticated, navigate]);
  useEffect(() => {
    if (clientLoading || !isClientAuthenticated) { if (!clientLoading) setLoading(false); return; }
    let off = false; (async () => {
      try { const token = localStorage.getItem('db_client_token');
        const { data } = await api.get('/client-portal/home', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!off) setHome(data);
      } catch { if (!off) { setError('Could not load your portal. Please try again.'); toast.error('Failed to load your portal.'); } }
      finally { if (!off) setLoading(false); }
    })(); return () => { off = true; };
  }, [clientLoading, isClientAuthenticated, toast]);
  if (clientLoading || loading) return <PublicLayout><div className="loading" role="status"><div className="spinner" />Loading...</div></PublicLayout>;
  if (!isClientAuthenticated) return null;
  if (error) return <PublicLayout><div className="client-alert client-alert-error">{error}</div></PublicLayout>;
  const firstName = (clientUser?.name || '').split(' ')[0];
  let body;
  if (home.focus) body = <EventCommandCenter focus={home.focus} upcomingCount={home.upcoming_count} />;
  else if (home.archive.length > 0 || home.has_quote_draft) body = <><NoEvent archiveCount={home.archive.length} /><ArchiveList archive={home.archive} /></>;
  else body = <BrandNewEmpty name={firstName} />;
  return <PublicLayout><section className="cp-portal">{body}</section></PublicLayout>;
}
