import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';

const fmtDate = (iso) => {
  if (!iso) return '—';
  const dateStr = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

const formatCurrency = (amount) => {
  if (amount == null) return '—';
  return `$${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export default function Dashboard() {
  const navigate = useNavigate();
  const [events, setEvents] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/shifts').then(r => r.data).catch(() => []),
      api.get('/proposals').then(r => r.data).catch(() => []),
      api.get('/admin/applications').then(r => r.data).catch(() => ({ applications: [] })),
    ]).then(([shiftsData, proposalsData, appsData]) => {
      setEvents(shiftsData.filter(s => s.proposal_id));
      setProposals(proposalsData);
      setApplications(appsData.applications || appsData || []);
      setLoading(false);
    });
  }, []);

  const today = new Date().toISOString().slice(0, 10);

  const upcomingEvents = events
    .filter(e => e.event_date && e.event_date.slice(0, 10) >= today)
    .sort((a, b) => a.event_date.localeCompare(b.event_date));

  const unstaffedEvents = upcomingEvents.filter(e => {
    const needed = Number(e.bartenders_needed || e.positions_needed || 1);
    const filled = Number(e.request_count || 0);
    return filled < needed;
  });

  const pendingProposals = proposals.filter(p =>
    ['sent', 'viewed', 'modified'].includes(p.status)
  );

  const paymentsDue = proposals.filter(p =>
    p.status === 'deposit_paid' || p.status === 'accepted'
  );

  const staffingRequests = Array.isArray(applications)
    ? applications.filter(a => a.onboarding_status === 'applied')
    : [];

  if (loading) return <div className="page-container wide"><p>Loading...</p></div>;

  return (
    <div className="page-container wide">
      <div className="mb-2">
        <h1 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.2rem' }}>Dashboard</h1>
        <p className="text-muted text-small">Business overview at a glance</p>
      </div>

      {/* ── Stat Cards ── */}
      <div className="dashboard-stats">
        <div className="dashboard-stat-card" onClick={() => navigate('/admin/events')}>
          <div className="dashboard-stat-number">{upcomingEvents.length}</div>
          <div className="dashboard-stat-label">Upcoming Events</div>
        </div>
        <div className="dashboard-stat-card" onClick={() => navigate('/admin/proposals')}>
          <div className="dashboard-stat-number">{pendingProposals.length}</div>
          <div className="dashboard-stat-label">Pending Proposals</div>
        </div>
        <div className="dashboard-stat-card" onClick={() => navigate('/admin/financials')}>
          <div className="dashboard-stat-number">{paymentsDue.length}</div>
          <div className="dashboard-stat-label">Payments Due</div>
        </div>
        <div className="dashboard-stat-card" onClick={() => navigate('/admin/events')}>
          <div className="dashboard-stat-number">{unstaffedEvents.length}</div>
          <div className="dashboard-stat-label">Unstaffed Events</div>
        </div>
        <div className="dashboard-stat-card" onClick={() => navigate('/admin/staffing')}>
          <div className="dashboard-stat-number">{staffingRequests.length}</div>
          <div className="dashboard-stat-label">Staffing Requests</div>
        </div>
      </div>

      {/* ── Detail Sections ── */}
      <div className="dashboard-grid">

        {/* Upcoming Events */}
        <div className="card">
          <div className="flex-between mb-1">
            <h3 style={{ margin: 0 }}>Upcoming Events</h3>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin/events')}>View all</button>
          </div>
          {upcomingEvents.length === 0 ? (
            <p className="text-muted text-small">No upcoming events</p>
          ) : (
            <table className="admin-table">
              <thead><tr><th>Event</th><th>Date</th><th>Client</th></tr></thead>
              <tbody>
                {upcomingEvents.slice(0, 5).map(e => (
                  <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/events/${e.id}`)}>
                    <td>{e.event_name || '—'}</td>
                    <td>{fmtDate(e.event_date)}</td>
                    <td>{e.client_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pending Proposals */}
        <div className="card">
          <div className="flex-between mb-1">
            <h3 style={{ margin: 0 }}>Pending Proposals</h3>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin/proposals')}>View all</button>
          </div>
          {pendingProposals.length === 0 ? (
            <p className="text-muted text-small">No pending proposals</p>
          ) : (
            <table className="admin-table">
              <thead><tr><th>Client</th><th>Status</th><th>Total</th></tr></thead>
              <tbody>
                {pendingProposals.slice(0, 5).map(p => (
                  <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/proposals/${p.id}`)}>
                    <td>{p.client_name || p.client_email || '—'}</td>
                    <td><span className={`badge ${p.status === 'sent' || p.status === 'viewed' ? 'badge-submitted' : 'badge-inprogress'}`}>{p.status}</span></td>
                    <td>{formatCurrency(p.total_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Payments Due */}
        <div className="card">
          <div className="flex-between mb-1">
            <h3 style={{ margin: 0 }}>Payments Due</h3>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin/financials')}>View all</button>
          </div>
          {paymentsDue.length === 0 ? (
            <p className="text-muted text-small">No payments due</p>
          ) : (
            <table className="admin-table">
              <thead><tr><th>Client</th><th>Event</th><th>Balance</th></tr></thead>
              <tbody>
                {paymentsDue.slice(0, 5).map(p => (
                  <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/proposals/${p.id}`)}>
                    <td>{p.client_name || p.client_email || '—'}</td>
                    <td>{p.event_name || fmtDate(p.event_date)}</td>
                    <td>{formatCurrency(p.total_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Unstaffed Events */}
        <div className="card">
          <div className="flex-between mb-1">
            <h3 style={{ margin: 0 }}>Unstaffed Events</h3>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin/events')}>View all</button>
          </div>
          {unstaffedEvents.length === 0 ? (
            <p className="text-muted text-small">All events are staffed</p>
          ) : (
            <table className="admin-table">
              <thead><tr><th>Event</th><th>Date</th><th>Filled</th></tr></thead>
              <tbody>
                {unstaffedEvents.slice(0, 5).map(e => (
                  <tr key={e.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/events/${e.id}`)}>
                    <td>{e.event_name || '—'}</td>
                    <td>{fmtDate(e.event_date)}</td>
                    <td>{Number(e.request_count || 0)} / {Number(e.bartenders_needed || e.positions_needed || 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Staffing Requests */}
        <div className="card">
          <div className="flex-between mb-1">
            <h3 style={{ margin: 0 }}>Staffing Requests</h3>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate('/admin/staffing')}>View all</button>
          </div>
          {staffingRequests.length === 0 ? (
            <p className="text-muted text-small">No new applications</p>
          ) : (
            <table className="admin-table">
              <thead><tr><th>Applicant</th><th>Applied</th></tr></thead>
              <tbody>
                {staffingRequests.slice(0, 5).map(a => (
                  <tr key={a.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/admin/staffing/applications/${a.id}`)}>
                    <td>{a.email}</td>
                    <td>{fmtDate(a.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

      </div>
    </div>
  );
}
