import React, { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../../utils/api';
import { formatCents } from '../money';
import ShareButton from '../ShareButton';
export default function ReceiptsTab({ focus }) {
  const [invoices, setInvoices] = useState(null); const [state, setState] = useState('loading');
  useEffect(() => { let off = false; (async () => {
    try { const token = localStorage.getItem('db_client_token');
      const { data } = await api.get(`/invoices/client/${focus.token}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!off) { setInvoices(data.invoices || []); setState('ready'); }
    } catch (e) { if (!off) { Sentry.captureException(e, { tags: { area: 'client-portal', tab: 'receipts', token: focus.token } }); setState('error'); } }
  })(); return () => { off = true; }; }, [focus.token]);
  if (state === 'loading') return <div className="loading" role="status"><div className="spinner" />Loading...</div>;
  if (state === 'error') return <div className="client-alert client-alert-error">Could not load invoices.</div>;
  if (invoices.length === 0) return <div className="cp-empty"><p>No invoices yet.</p></div>;
  return (<div className="cp-receipts">{invoices.map(inv => (<div key={inv.id} className="cp-receipt-row">
    <span>{inv.invoice_number} · {inv.label}</span>
    <span>{formatCents(inv.status === 'paid' ? inv.amount_paid : inv.amount_due)} · {inv.status}</span>
    <a className="btn" href={`/invoice/${inv.token}`} target="_blank" rel="noopener noreferrer">Open</a>
    <ShareButton url={`/invoice/${inv.token}`} label="Share" />
  </div>))}</div>);
}
