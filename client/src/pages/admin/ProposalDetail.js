import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import PricingBreakdown from '../../components/PricingBreakdown';

const STATUS_LABELS = {
  draft: 'Draft', sent: 'Sent', viewed: 'Viewed', modified: 'Modified',
  accepted: 'Accepted', deposit_paid: 'Deposit Paid', confirmed: 'Confirmed',
};
const STATUS_CLASSES = {
  draft: 'badge-inprogress', sent: 'badge-submitted', viewed: 'badge-submitted',
  modified: 'badge-inprogress', accepted: 'badge-approved', deposit_paid: 'badge-approved', confirmed: 'badge-approved',
};

export default function ProposalDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');

  useEffect(() => {
    api.get(`/proposals/${id}`).then(res => {
      setProposal(res.data);
      setNotes(res.data.admin_notes || '');
    }).catch(() => navigate('/admin/proposals')).finally(() => setLoading(false));
  }, [id, navigate]);

  const copyLink = () => {
    const url = `${window.location.origin}/proposal/${proposal.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage('Copied!');
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  const saveNotes = async () => {
    setSavingNotes(true);
    try {
      await api.patch(`/proposals/${id}/notes`, { admin_notes: notes });
    } catch (err) {
      console.error('Failed to save notes:', err);
    } finally { setSavingNotes(false); }
  };

  const updateStatus = async (status) => {
    try {
      const res = await api.patch(`/proposals/${id}/status`, { status });
      setProposal(prev => ({ ...prev, status: res.data.status }));
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  };

  const formatDate = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const formatDateTime = (d) => {
    if (!d) return '—';
    return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  if (loading) return <div className="page-container" style={{ textAlign: 'center', padding: '3rem' }}><div className="spinner" /></div>;
  if (!proposal) return null;

  const snapshot = proposal.pricing_snapshot;
  const includes = proposal.package_includes || [];

  return (
    <div className="page-container wide">
      <div className="flex-between mb-2">
        <h1 style={{ fontFamily: 'var(--font-display)' }}>Proposal #{proposal.id}</h1>
        <div className="flex gap-1">
          <button className="btn btn-secondary" onClick={() => navigate('/admin/proposals')}>Back</button>
          <button className="btn" onClick={copyLink}>{copyMessage || 'Copy Link'}</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', alignItems: 'start' }}>
        {/* Left column */}
        <div>
          {/* Status */}
          <div className="card mb-2">
            <div className="flex-between" style={{ alignItems: 'center' }}>
              <div>
                <span className={`badge ${STATUS_CLASSES[proposal.status] || ''}`} style={{ fontSize: '0.9rem' }}>
                  {STATUS_LABELS[proposal.status] || proposal.status}
                </span>
                {proposal.view_count > 0 && (
                  <span className="text-muted text-small" style={{ marginLeft: '0.75rem' }}>
                    Viewed {proposal.view_count} time{proposal.view_count !== 1 ? 's' : ''}
                    {proposal.last_viewed_at && <> · Last: {formatDateTime(proposal.last_viewed_at)}</>}
                  </span>
                )}
              </div>
              <div className="flex gap-05">
                {proposal.status === 'draft' && <button className="btn btn-sm" onClick={() => updateStatus('sent')}>Mark Sent</button>}
                {proposal.status === 'viewed' && <button className="btn btn-sm" onClick={() => updateStatus('accepted')}>Mark Accepted</button>}
              </div>
            </div>
          </div>

          {/* Client Info */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Client</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <div><span className="text-muted text-small">Name</span><div>{proposal.client_name || '—'}</div></div>
              <div><span className="text-muted text-small">Email</span><div>{proposal.client_email || '—'}</div></div>
              <div><span className="text-muted text-small">Phone</span><div>{proposal.client_phone || '—'}</div></div>
              <div><span className="text-muted text-small">Source</span><div>{proposal.client_source || '—'}</div></div>
            </div>
          </div>

          {/* Event Details */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Event</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
              <div><span className="text-muted text-small">Event</span><div>{proposal.event_name || '—'}</div></div>
              <div><span className="text-muted text-small">Date</span><div>{formatDate(proposal.event_date)}</div></div>
              <div><span className="text-muted text-small">Start Time</span><div>{proposal.event_start_time || '—'}</div></div>
              <div><span className="text-muted text-small">Duration</span><div>{proposal.event_duration_hours}hrs</div></div>
              <div><span className="text-muted text-small">Guests</span><div>{proposal.guest_count}</div></div>
              <div><span className="text-muted text-small">Location</span><div>{proposal.event_location || '—'}</div></div>
            </div>
          </div>

          {/* Admin Notes */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Admin Notes</h3>
            <textarea
              className="form-input"
              rows={4}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Internal notes about this proposal..."
              style={{ resize: 'vertical' }}
            />
            <button className="btn btn-sm mt-1" onClick={saveNotes} disabled={savingNotes}>
              {savingNotes ? 'Saving...' : 'Save Notes'}
            </button>
          </div>
        </div>

        {/* Right column */}
        <div>
          {/* Package & Pricing */}
          <div className="card mb-2">
            <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>
              {proposal.package_name || 'Package'}
            </h3>
            {includes.length > 0 && (
              <ul style={{ margin: '0 0 1rem 0', padding: '0 0 0 1.2rem', color: 'var(--warm-brown, #6b4226)' }}>
                {includes.map((item, i) => <li key={i} className="text-small" style={{ marginBottom: '0.2rem' }}>{item}</li>)}
              </ul>
            )}
            <PricingBreakdown snapshot={snapshot} />
          </div>

          {/* Activity Log */}
          {proposal.activity && proposal.activity.length > 0 && (
            <div className="card">
              <h3 style={{ fontFamily: 'var(--font-display)', color: 'var(--deep-brown)', marginBottom: '0.75rem' }}>Activity</h3>
              <div style={{ maxHeight: '250px', overflowY: 'auto' }}>
                {proposal.activity.map((entry, i) => (
                  <div key={i} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--cream-dark, #e8e0d4)' }}>
                    <span className="text-small" style={{ fontWeight: 500 }}>{entry.action}</span>
                    <span className="text-muted text-small" style={{ marginLeft: '0.5rem' }}>
                      {entry.actor_type} · {formatDateTime(entry.created_at)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
