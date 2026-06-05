import React, { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../../utils/api';
import { formatDollars, formatCents } from '../money';
import ShareButton from '../ShareButton';

export default function PrescriptionTab({ focus }) {
  const [p, setP] = useState(null);
  const [state, setState] = useState('loading');
  useEffect(() => { let off = false; (async () => {
    try { const token = localStorage.getItem('db_client_token');
      const { data } = await api.get(`/client-portal/proposals/${focus.token}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!off) { setP(data.proposal || {}); setState('ready'); }
    } catch (e) { if (!off) { Sentry.captureException(e, { tags: { area: 'client-portal', tab: 'prescription', token: focus.token } }); setState('error'); } }
  })(); return () => { off = true; }; }, [focus.token]);

  if (state === 'loading') return <div className="loading" role="status"><div className="spinner" />Loading...</div>;
  if (state === 'error') return <div className="client-alert client-alert-error">Could not load this proposal. <button onClick={() => window.location.reload()}>Retry</button></div>;
  const includes = Array.isArray(p.package_includes) ? p.package_includes : [];
  return (<div className="cp-rx">
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
      {focus.balance_due > 0 && <a className="btn client-btn-primary" href={`/proposal/${focus.token}`}>Pay balance</a>}
      <ShareButton url={`/proposal/${focus.token}`} label="Share this proposal" />
    </div>
  </div>);
}
