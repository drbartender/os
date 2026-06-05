import React, { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import { useNavigate, useParams } from 'react-router-dom';
import PublicLayout, { clientLoginPath } from '../../../components/PublicLayout';
import { useClientAuth } from '../../../context/ClientAuthContext';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import EventCommandCenter from './EventCommandCenter';
import ArchiveList from './ArchiveList';
import { BrandNewEmpty, NoEvent } from './EmptyStates';
import { mapDetailToFocus, mapArchiveRow } from './constants';

export default function PortalHome() {
  const { clientUser, clientLoading, isClientAuthenticated } = useClientAuth();
  const navigate = useNavigate(); const toast = useToast();
  const [home, setHome] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const { token: routeToken } = useParams();
  const [specific, setSpecific] = useState(null);
  const [specificDetail, setSpecificDetail] = useState(null);
  const [stale, setStale] = useState(false);
  const [notFound, setNotFound] = useState(false);
  useEffect(() => { if (!clientLoading && !isClientAuthenticated) navigate(clientLoginPath(), { replace: true }); }, [clientLoading, isClientAuthenticated, navigate]);
  useEffect(() => {
    if (clientLoading || !isClientAuthenticated) { if (!clientLoading) setLoading(false); return; }
    let off = false; (async () => {
      try { const token = localStorage.getItem('db_client_token');
        const { data } = await api.get('/client-portal/home', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!off) setHome(data);
      } catch (e) { if (!off) { Sentry.captureException(e, { tags: { area: 'client-portal', surface: 'home' } }); setError('Could not load your portal. Please try again.'); toast.error('Failed to load your portal.'); } }
      finally { if (!off) setLoading(false); }
    })(); return () => { off = true; };
  }, [clientLoading, isClientAuthenticated, toast]);
  useEffect(() => {
    if (!home || !routeToken || routeToken === 'archive' || routeToken === home.focus?.token) {
      setSpecific(null); setSpecificDetail(null); setNotFound(false); setStale(false); return;
    }
    let off = false;
    (async () => {
      try {
        const token = localStorage.getItem('db_client_token');
        const { data } = await api.get(`/client-portal/proposals/${routeToken}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!off) { setSpecific(mapDetailToFocus(data.proposal)); setSpecificDetail(data.proposal); }
      } catch (e) {
        if (off) return;
        // Never carry a previously-viewed event's detail into a fallback/error
        // render — PrescriptionTab also token-guards, this is belt-and-suspenders.
        setSpecificDetail(null);
        if (e.status === 404) { setNotFound(true); return; }
        const row = home.archive.find(r => r.token === routeToken);
        if (row) { setSpecific(mapArchiveRow(row)); setStale(true); } else setNotFound(true);
      }
    })();
    return () => { off = true; };
  }, [home, routeToken]);
  if (clientLoading || loading) return <PublicLayout><div className="loading" role="status"><div className="spinner" />Loading...</div></PublicLayout>;
  if (!isClientAuthenticated) return null;
  if (error) return <PublicLayout><div className="client-alert client-alert-error">{error}</div></PublicLayout>;
  if (notFound) return <PublicLayout><section className="cp-portal"><div className="cp-empty">
    <h3>We could not find that event.</h3>
    <a className="btn client-btn-primary" href="/my-proposals">Back to your portal</a></div></section></PublicLayout>;
  if (specific) return <PublicLayout><section className="cp-portal">
    {stale && <div className="client-alert">Some details are unavailable right now.</div>}
    <EventCommandCenter focus={specific} proposalDetail={specificDetail} upcomingCount={0} /></section></PublicLayout>;
  const firstName = (clientUser?.name || '').split(' ')[0];
  let body;
  if (home.focus) body = <EventCommandCenter focus={home.focus} upcomingCount={home.upcoming_count} />;
  else if (home.archive.length > 0 || home.has_quote_draft) body = <><NoEvent archiveCount={home.archive.length} /><ArchiveList archive={home.archive} /></>;
  else body = <BrandNewEmpty name={firstName} />;
  return <PublicLayout><section className="cp-portal">{body}</section></PublicLayout>;
}
