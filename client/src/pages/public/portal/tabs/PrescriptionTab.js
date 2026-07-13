import React, { useState, useEffect, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../../utils/api';
import { interpolatePackageIncludes } from '../../../../utils/packageIncludes';
import { formatDollars, formatCents } from '../money';
import ShareButton from '../ShareButton';
import ChangeRequestForm from '../ChangeRequestForm';
import ChangeRequestBanner from './ChangeRequestBanner';

export default function PrescriptionTab({ focus, proposalDetail }) {
  // Reuse a parent-fetched detail ONLY when it is THIS event's detail. After an
  // archive fallback PortalHome can still be holding a previously-viewed event's
  // detail; reusing it by truthiness alone would render the wrong proposal's
  // add-ons / payments / signature under this event's totals.
  const reusable = proposalDetail && proposalDetail.token === focus.token ? proposalDetail : null;
  const [p, setP] = useState(reusable);
  const [state, setState] = useState(reusable ? 'ready' : 'loading');
  useEffect(() => {
    if (proposalDetail && proposalDetail.token === focus.token) { setP(proposalDetail); setState('ready'); return; }
    let off = false; setState('loading'); (async () => {
      try { const token = localStorage.getItem('db_client_token');
        const { data } = await api.get(`/client-portal/proposals/${focus.token}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!off) { setP(data.proposal || {}); setState('ready'); }
      } catch (e) { if (!off) { Sentry.captureException(e, { tags: { area: 'client-portal', tab: 'prescription', token: focus.token } }); setState('error'); } }
    })(); return () => { off = true; }; }, [focus.token, proposalDetail]);

  const [requests, setRequests] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const loadRequests = useCallback(async () => {
    try {
      const token = localStorage.getItem('db_client_token');
      const { data } = await api.get(`/client-portal/proposals/${focus.token}/change-requests`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      setRequests(data.requests || []);
    } catch { /* non-fatal */ }
  }, [focus.token]);
  useEffect(() => { loadRequests(); }, [loadRequests]);
  const openRequest = requests.find(r => r.status === 'pending');
  const lastDecided = requests.find(r => r.status === 'approved' || r.status === 'declined');
  const editable = focus.status !== 'archived' && focus.status !== 'completed';
  const withdraw = async () => {
    if (!openRequest) return;
    try {
      const token = localStorage.getItem('db_client_token');
      await api.post(`/client-portal/proposals/${focus.token}/change-requests/${openRequest.id}/cancel`, {}, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      loadRequests();
    } catch { /* non-fatal */ }
  };

  if (state === 'loading') return <div className="loading" role="status"><div className="spinner" />Loading...</div>;
  if (state === 'error') return <div className="client-alert client-alert-error">Could not load this proposal. <button onClick={() => window.location.reload()}>Retry</button></div>;
  // The portal detail endpoint returns no pricing snapshot, so map the stored
  // columns: num_bartenders (can differ from the engine-computed staffing the
  // proposal page shows, but it is the value on the record) and
  // event_duration_hours. Absent values leave tokens visible rather than
  // rendering wrong numbers. This tab was the one consumer skipping
  // interpolation, so clients saw literal "{bartenders}" text (2026-07-02 audit).
  const includes = interpolatePackageIncludes(p.package_includes, {
    bartenders: p.num_bartenders ?? undefined,
    durationHours: p.event_duration_hours ?? undefined,
  });
  return (<div className="cp-rx">
    <ChangeRequestBanner request={openRequest || lastDecided} onWithdraw={withdraw} />
    <div className="cp-rx-pkg"><h3>{p.package_name || 'Your package'}</h3>
      <ul className="cp-rx-includes">{includes.map((it, i) => <li key={i}>{it}</li>)}</ul></div>
    {p.addons?.length > 0 && (<div className="cp-rx-addons"><h4>Add-ons</h4>
      {p.addons.map(a => <div key={a.id} className="cp-leader"><span>{a.addon_name}</span><span>{formatDollars(a.line_total)}</span></div>)}</div>)}
    <div className="cp-rx-totals">
      <div className="cp-leader"><span>Total</span><span>{formatDollars(focus.total_price)}</span></div>
      <div className="cp-leader"><span>Paid</span><span>{formatDollars(focus.amount_paid)}</span></div>
      {focus.balance_due > 0 && <div className="cp-leader"><span>Balance due</span><span>{formatDollars(focus.balance_due)}</span></div>}
    </div>
    <div className="cp-rx-sig">{p.client_signed_at
      ? <>Signed by {p.client_signed_name} on {new Date(p.client_signed_at).toLocaleDateString('en-US')}</>
      : <>Not yet signed</>}</div>
    {p.payments?.length > 0 && (<div className="cp-rx-payments"><h4>Payment history</h4>
      {p.payments.map(pay => <div key={pay.id} className="cp-leader"><span>{pay.payment_type}</span><span>{formatCents(pay.amount)}</span></div>)}</div>)}
    <div className="cp-rx-actions">
      {!focus.booked && <a className="btn client-btn-primary" href={`/proposal/${focus.token}`}>Review & book</a>}
      {focus.balance_due > 0 && <a className="btn client-btn-primary" href={focus.open_invoice_token ? `/invoice/${focus.open_invoice_token}` : `/proposal/${focus.token}`}>Pay balance</a>}
      <ShareButton url={`/proposal/${focus.token}`} label="Share this proposal" />
      {editable && !openRequest && !showForm && (
        <button type="button" className="btn client-btn-secondary" onClick={() => setShowForm(true)}>Request a change</button>
      )}
    </div>
    {showForm && (
      <ChangeRequestForm proposal={p} token={focus.token}
        onSubmitted={() => { setShowForm(false); loadRequests(); }}
        onCancel={() => setShowForm(false)} />
    )}
  </div>);
}
