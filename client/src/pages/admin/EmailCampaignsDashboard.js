import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';

export default function EmailCampaignsDashboard() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState([]);
  const [typeFilter, setTypeFilter] = useState('');
  const [loading, setLoading] = useState(true);

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (typeFilter) params.type = typeFilter;
      const res = await api.get('/email-marketing/campaigns', { params });
      setCampaigns(res.data);
    } catch (err) {
      console.error('Error fetching campaigns:', err);
    } finally {
      setLoading(false);
    }
  }, [typeFilter]);

  useEffect(() => { fetchCampaigns(); }, [fetchCampaigns]);

  const getStatusColor = (status) => {
    const colors = {
      draft: '#888', scheduled: '#2d6b8a', sending: '#c8a52d', sent: '#2d8a4e',
      active: '#2d8a4e', paused: '#c8a52d', archived: '#888',
    };
    return colors[status] || '#888';
  };

  return (
    <div className="em-campaigns">
      <div className="em-section-header">
        <div className="em-actions">
          <button className="btn btn-primary" onClick={() => navigate('/admin/email-marketing/campaigns/new')}>
            + New Campaign
          </button>
        </div>
      </div>

      <div className="em-filters">
        <button className={`em-chip ${typeFilter === '' ? 'em-chip-active' : ''}`} onClick={() => setTypeFilter('')}>All</button>
        <button className={`em-chip ${typeFilter === 'blast' ? 'em-chip-active' : ''}`} onClick={() => setTypeFilter('blast')}>Blasts</button>
        <button className={`em-chip ${typeFilter === 'sequence' ? 'em-chip-active' : ''}`} onClick={() => setTypeFilter('sequence')}>Sequences</button>
      </div>

      {loading ? (
        <div className="loading"><div className="spinner" />Loading...</div>
      ) : campaigns.length === 0 ? (
        <div className="em-empty">No campaigns yet. Create your first campaign.</div>
      ) : (
        <table className="em-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Status</th>
              <th>Sends</th>
              <th>Opens</th>
              <th>Clicks</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map(c => {
              const sends = parseInt(c.total_sends, 10) || 0;
              const opens = parseInt(c.total_opens, 10) || 0;
              const clicks = parseInt(c.total_clicks, 10) || 0;
              const openRate = sends > 0 ? (opens / sends * 100).toFixed(1) : '—';
              const clickRate = sends > 0 ? (clicks / sends * 100).toFixed(1) : '—';

              return (
                <tr key={c.id} onClick={() => navigate(`/admin/email-marketing/campaigns/${c.id}`)} className="em-row-clickable">
                  <td><strong>{c.name}</strong></td>
                  <td><span className="em-badge em-badge-type">{c.type}</span></td>
                  <td><span className="em-badge" style={{ background: getStatusColor(c.status), color: '#fff' }}>{c.status}</span></td>
                  <td>{sends}</td>
                  <td>{opens} {openRate !== '—' && <span className="em-rate">({openRate}%)</span>}</td>
                  <td>{clicks} {clickRate !== '—' && <span className="em-rate">({clickRate}%)</span>}</td>
                  <td>{new Date(c.created_at).toLocaleDateString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
