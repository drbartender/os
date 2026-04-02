import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import PublicLayout from '../../components/PublicLayout';
import { useClientAuth } from '../../context/ClientAuthContext';
import { API_BASE_URL } from '../../utils/api';

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

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function formatCurrency(cents) {
  if (cents == null) return '$0.00';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function ClientDashboard() {
  const { clientUser, clientLoading, clientLogout, isClientAuthenticated } = useClientAuth();
  const navigate = useNavigate();
  const [proposals, setProposals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!clientLoading && !isClientAuthenticated) {
      navigate('/login', { replace: true });
    }
  }, [clientLoading, isClientAuthenticated, navigate]);

  useEffect(() => {
    if (!isClientAuthenticated) return;
    const token = localStorage.getItem('db_client_token');
    fetch(`${API_BASE_URL}/client-portal/proposals`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed to load proposals');
        return res.json();
      })
      .then(data => setProposals(data.proposals))
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [isClientAuthenticated]);

  if (clientLoading) {
    return (
      <PublicLayout>
        <section className="client-dashboard-section">
          <div className="loading"><div className="spinner" />Loading...</div>
        </section>
      </PublicLayout>
    );
  }

  if (!isClientAuthenticated) return null;

  return (
    <PublicLayout>
      <section className="client-dashboard-section">
        <div className="client-dashboard-header">
          <h2>Welcome back, {clientUser?.name || 'Client'}</h2>
          <button className="btn client-btn-outline" onClick={() => { clientLogout(); navigate('/login'); }}>
            Log Out
          </button>
        </div>

        {error && <div className="client-alert client-alert-error">{error}</div>}

        {loading ? (
          <div className="loading"><div className="spinner" />Loading proposals...</div>
        ) : proposals.length === 0 ? (
          <div className="card client-empty-card">
            <h3>No Proposals Yet</h3>
            <p>When we create a proposal for your event, it will appear here.</p>
          </div>
        ) : (
          <div className="client-proposals-grid">
            {proposals.map(p => (
              <div key={p.id} className="card client-proposal-card">
                <div className="client-proposal-card-header">
                  <h3>{p.event_name || 'Untitled Event'}</h3>
                  <span className={`badge ${STATUS_CLASSES[p.status] || 'badge-inprogress'}`}>
                    {STATUS_LABELS[p.status] || p.status}
                  </span>
                </div>
                <div className="client-proposal-card-details">
                  <div className="client-proposal-detail">
                    <span className="client-detail-label">Event Date</span>
                    <span>{formatDate(p.event_date)}</span>
                  </div>
                  <div className="client-proposal-detail">
                    <span className="client-detail-label">Total</span>
                    <span>{formatCurrency(p.total_price)}</span>
                  </div>
                  <div className="client-proposal-detail">
                    <span className="client-detail-label">Paid</span>
                    <span>{formatCurrency(p.amount_paid)}</span>
                  </div>
                </div>
                <Link to={`/proposal/${p.token}`} className="btn client-btn-primary client-btn-view">
                  View Proposal
                </Link>
              </div>
            ))}
          </div>
        )}
      </section>
    </PublicLayout>
  );
}
