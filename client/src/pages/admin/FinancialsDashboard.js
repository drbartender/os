import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { useToast } from '../../context/ToastContext';
import StatusChip from '../../components/adminos/StatusChip';
import { fmt$, fmt$2dp, fmt$fromCents, fmtDate } from '../../components/adminos/format';

const STATUS = {
  draft: 'neutral', sent: 'info', viewed: 'accent', modified: 'violet',
  accepted: 'ok', deposit_paid: 'ok', balance_paid: 'ok', confirmed: 'ok', completed: 'ok',
  declined: 'danger',
};

export default function FinancialsDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/proposals/financials')
      .then(r => setData(r.data))
      .catch((err) => toast.error(err.message || 'Failed to load financial data. Try refreshing.'))
      .finally(() => setLoading(false));
  }, [toast]);

  if (loading) return <div className="page"><div className="muted">Loading…</div></div>;
  if (!data) return (
    <div className="page">
      <div className="chip danger">Couldn't load financial data. Try refreshing.</div>
    </div>
  );

  const { summary, proposals, recentPayments } = data;
  const totalRevenue = Number(summary?.total_revenue || 0);
  const totalCollected = Number(summary?.total_collected || 0);
  const totalOutstanding = Number(summary?.total_outstanding || 0);
  const eventCount = proposals?.length || 0;
  const avgEvent = eventCount > 0 ? Math.round(totalRevenue / eventCount) : 0;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Financials</div>
          <div className="page-subtitle">Revenue, outstanding balances, and recent payments.</div>
        </div>
      </div>

      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">Booked</div>
          <div className="stat-value">{fmt$(totalRevenue)}</div>
          <div className="stat-sub"><span>{eventCount} {eventCount === 1 ? 'proposal' : 'proposals'}</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Collected</div>
          <div className="stat-value" style={{ color: 'hsl(var(--ok-h) var(--ok-s) 52%)' }}>{fmt$(totalCollected)}</div>
          <div className="stat-sub"><span>{totalRevenue > 0 ? Math.round((totalCollected / totalRevenue) * 100) : 0}% of booked</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Outstanding</div>
          <div className="stat-value" style={{ color: totalOutstanding > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>{fmt$(totalOutstanding)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Avg event</div>
          <div className="stat-value">{fmt$(avgEvent)}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 'var(--gap)', overflow: 'hidden' }}>
        <div className="card-head"><h3>All proposals</h3><span className="k">{proposals?.length || 0}</span></div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th>
                <th>Event</th>
                <th>Date</th>
                <th>Status</th>
                <th className="num">Total</th>
                <th className="num">Paid</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {(!proposals || proposals.length === 0) && (
                <tr><td colSpan={7} className="muted">No proposals yet.</td></tr>
              )}
              {proposals && proposals.map(p => {
                const total = Number(p.total_price || 0);
                const paid = Number(p.amount_paid || 0);
                const bal = total - paid;
                return (
                  <tr key={p.id} onClick={() => navigate(`/admin/proposals/${p.id}`)}>
                    <td><strong>{p.client_name || '—'}</strong></td>
                    <td>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</td>
                    <td>{p.event_date ? fmtDate(String(p.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</td>
                    <td><StatusChip kind={STATUS[p.status] || 'neutral'}>{p.status || '—'}</StatusChip></td>
                    <td className="num">{fmt$(total)}</td>
                    <td className="num muted">{fmt$(paid)}</td>
                    <td className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'var(--ink-3)' }}>
                      {bal > 0 ? fmt$(bal) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="card-head"><h3>Recent payments</h3><span className="k">{recentPayments?.length || 0}</span></div>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th>
                <th>Event</th>
                <th>Type</th>
                <th className="num">Amount</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {(!recentPayments || recentPayments.length === 0) && (
                <tr><td colSpan={5} className="muted">No payments recorded yet.</td></tr>
              )}
              {recentPayments && recentPayments.map(pp => (
                <tr key={pp.id} style={{ cursor: pp.invoice_token ? 'pointer' : 'default' }}
                  onClick={() => pp.invoice_token && window.open(`/invoice/${pp.invoice_token}`, '_blank', 'noopener,noreferrer')}
                  title={pp.invoice_token ? 'View invoice' : ''}>
                  <td><strong>{pp.client_name || '—'}</strong></td>
                  <td>{getEventTypeLabel({ event_type: pp.event_type, event_type_custom: pp.event_type_custom })}</td>
                  <td className="muted" style={{ textTransform: 'capitalize' }}>{pp.payment_type}</td>
                  <td className="num">{fmt$fromCents(pp.amount)}</td>
                  <td className="muted">{fmtDate(pp.created_at && String(pp.created_at).slice(0, 10), { year: 'numeric' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
