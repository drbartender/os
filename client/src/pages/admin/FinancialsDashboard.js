import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';

const formatCurrency = (amount) => {
  if (amount == null) return '$0.00';
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatDate = (d) => {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

const STATUS_LABELS = {
  sent: 'Sent', viewed: 'Viewed', modified: 'Modified', accepted: 'Accepted',
  deposit_paid: 'Deposit Paid', balance_paid: 'Balance Paid', confirmed: 'Confirmed', completed: 'Completed',
};
const STATUS_CLASSES = {
  sent: 'badge-submitted', viewed: 'badge-submitted', modified: 'badge-inprogress',
  accepted: 'badge-approved', deposit_paid: 'badge-approved', balance_paid: 'badge-approved',
  confirmed: 'badge-approved', completed: 'badge-approved',
};

export default function FinancialsDashboard() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/proposals/financials')
      .then(r => setData(r.data))
      .catch(() => setError('Failed to load financial data'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="page-container wide"><p>Loading...</p></div>;
  if (error) return <div className="page-container wide"><div className="card"><p className="text-error">{error}</p></div></div>;

  const { summary, proposals, recentPayments } = data;

  return (
    <div className="page-container wide">
      <div className="mb-2">
        <h1 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.2rem' }}>Financials</h1>
        <p className="text-muted text-small">Revenue, payments, and outstanding balances</p>
      </div>

      {/* ── Stat Cards ── */}
      <div className="dashboard-stats">
        <div className="dashboard-stat-card" style={{ cursor: 'default' }}>
          <div className="dashboard-stat-number">{formatCurrency(summary.total_revenue)}</div>
          <div className="dashboard-stat-label">Total Revenue</div>
        </div>
        <div className="dashboard-stat-card" style={{ cursor: 'default' }}>
          <div className="dashboard-stat-number" style={{ color: 'var(--sage)' }}>{formatCurrency(summary.total_collected)}</div>
          <div className="dashboard-stat-label">Collected</div>
        </div>
        <div className="dashboard-stat-card" style={{ cursor: 'default' }}>
          <div className="dashboard-stat-number" style={{ color: 'var(--rust)' }}>{formatCurrency(summary.total_outstanding)}</div>
          <div className="dashboard-stat-label">Outstanding</div>
        </div>
      </div>

      {/* ── Proposals Table ── */}
      <div className="card mb-2">
        <h3 style={{ margin: '0 0 1rem 0' }}>All Proposals</h3>
        {proposals.length === 0 ? (
          <p className="text-muted text-small">No proposals yet</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Event</th>
                  <th>Date</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Balance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {proposals.map(p => (
                  <tr
                    key={p.id}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/admin/proposals/${p.id}`)}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/proposals/${p.id}`)}
                    tabIndex={0}
                    role="link"
                  >
                    <td>{p.client_name || '—'}</td>
                    <td>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</td>
                    <td>{formatDate(p.event_date)}</td>
                    <td>{formatCurrency(p.total_price)}</td>
                    <td>{formatCurrency(p.amount_paid)}</td>
                    <td>{formatCurrency(Number(p.total_price || 0) - Number(p.amount_paid || 0))}</td>
                    <td>
                      <span className={`badge ${STATUS_CLASSES[p.status] || ''}`}>
                        {STATUS_LABELS[p.status] || p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Recent Payments ── */}
      <div className="card">
        <h3 style={{ margin: '0 0 1rem 0' }}>Recent Payments</h3>
        {recentPayments.length === 0 ? (
          <p className="text-muted text-small">No payments recorded yet</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Event</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {recentPayments.map(pp => (
                  <tr
                    key={pp.id}
                    style={{ cursor: pp.invoice_token ? 'pointer' : 'default' }}
                    onClick={() => pp.invoice_token && window.open(`/invoice/${pp.invoice_token}`, '_blank')}
                    onKeyDown={(e) => e.key === 'Enter' && pp.invoice_token && window.open(`/invoice/${pp.invoice_token}`, '_blank')}
                    tabIndex={pp.invoice_token ? 0 : undefined}
                    role={pp.invoice_token ? 'link' : undefined}
                    title={pp.invoice_token ? 'View invoice' : 'No invoice linked'}
                  >
                    <td>{pp.client_name || '—'}</td>
                    <td>{getEventTypeLabel({ event_type: pp.event_type, event_type_custom: pp.event_type_custom })}</td>
                    <td style={{ textTransform: 'capitalize' }}>{pp.payment_type}</td>
                    <td>{formatCurrency(pp.amount / 100)}</td>
                    <td>{formatDate(pp.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
