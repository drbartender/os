import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';

const STATUS_LABELS = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  modified: 'Modified',
  accepted: 'Accepted',
};
const STATUS_CLASSES = {
  draft: 'badge-inprogress',
  sent: 'badge-submitted',
  viewed: 'badge-submitted',
  modified: 'badge-inprogress',
  accepted: 'badge-approved',
};

export default function ProposalsDashboard() {
  const navigate = useNavigate();
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [copyMessage, setCopyMessage] = useState('');

  const fetchProposals = useCallback(async () => {
    try {
      const params = {};
      if (search) params.search = search;
      if (statusFilter) params.status = statusFilter;
      const res = await api.get('/proposals', { params });
      setProposals(res.data);
    } catch (err) {
      console.error('Failed to fetch proposals:', err);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => { fetchProposals(); }, [fetchProposals]);

  const copyLink = (token) => {
    const url = `${window.location.origin}/proposal/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage(token);
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatCurrency = (amount) => {
    if (amount == null) return '—';
    return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2">
        <h1 style={{ fontFamily: 'var(--font-display)' }}>Proposals</h1>
        <button className="btn btn-primary" onClick={() => navigate('/admin/proposals/new')}>
          + New Proposal
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-1 mb-2" style={{ flexWrap: 'wrap' }}>
        <input
          className="form-input"
          style={{ maxWidth: '280px' }}
          placeholder="Search by client, event, or email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="form-select"
          style={{ maxWidth: '160px' }}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">All Statuses</option>
          {Object.entries(STATUS_LABELS).map(([val, label]) => (
            <option key={val} value={val}>{label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '2rem' }}>
          <div className="spinner" />
        </div>
      ) : proposals.length === 0 ? (
        <div className="card" style={{ textAlign: 'center' }}>
          <p className="text-muted">No proposals yet. Create one to get started!</p>
        </div>
      ) : (
        <div className="table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Client</th>
              <th>Event</th>
              <th>Date</th>
              <th>Package</th>
              <th>Total</th>
              <th>Status</th>
              <th>Link</th>
            </tr>
          </thead>
          <tbody>
            {proposals.map(p => (
              <tr key={p.id} onClick={() => navigate(`/admin/proposals/${p.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/admin/proposals/${p.id}`)} tabIndex={0} role="link" style={{ cursor: 'pointer' }}>
                <td>
                  <strong>{p.client_name && p.event_name ? `${p.client_name} - ${p.event_name}` : p.client_name || '—'}</strong>
                  {p.client_email && <div className="text-muted text-small">{p.client_email}</div>}
                </td>
                <td>{p.event_name || '—'}</td>
                <td>{formatDate(p.event_date)}</td>
                <td>{p.package_name || '—'}</td>
                <td style={{ fontWeight: 600 }}>{formatCurrency(p.total_price)}</td>
                <td>
                  <span className={`badge ${STATUS_CLASSES[p.status] || ''}`}>
                    {STATUS_LABELS[p.status] || p.status}
                  </span>
                </td>
                <td>
                  <button
                    className="btn btn-sm btn-secondary"
                    onClick={(e) => { e.stopPropagation(); copyLink(p.token); }}
                  >
                    {copyMessage === p.token ? 'Copied!' : 'Copy Link'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
