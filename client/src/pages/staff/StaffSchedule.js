import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';

const STATUS_STYLES = {
  pending:  { background: '#FFF3DC', color: '#8B5E0A', border: '1px solid #E5C97A' },
  approved: { background: '#E8F5E8', color: '#1A6B1A', border: '1px solid #90CC90' },
  denied:   { background: '#F5F5F5', color: '#666',    border: '1px solid #CCC' },
};

function StatusPill({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.pending;
  const labels = { pending: 'Pending', approved: 'Confirmed', denied: 'Denied' };
  return (
    <span style={{ ...s, display: 'inline-block', borderRadius: 99, padding: '0.15rem 0.65rem', fontSize: '0.75rem', fontWeight: 700 }}>
      {labels[status] || status}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  const dateStr = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function StaffSchedule() {
  const { user } = useAuth();
  const [myRequests, setMyRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/shifts/my-requests');
      setMyRequests(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchData(); }, []);

  async function cancelRequest(requestId) {
    try {
      await api.delete(`/shifts/requests/${requestId}`);
      await fetchData();
    } catch (e) {
      console.error(e);
    }
  }

  async function downloadShiftIcs(shiftId) {
    try {
      const res = await api.get(`/calendar/event/${shiftId}.ics`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'event.ics';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Failed to download calendar event:', err);
    }
  }

  return (
    <div className="page-container" style={{ maxWidth: 860 }}>
      <h1 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.5rem' }}>My Schedule</h1>
      <p className="text-muted text-small" style={{ marginBottom: '1rem' }}>Your shift requests and confirmed gigs</p>

      {loading ? (
        <div className="loading"><div className="spinner" />Loading...</div>
      ) : myRequests.length === 0 ? (
        <div className="card text-center" style={{ padding: '2.5rem' }}>
          <p style={{ color: 'var(--text-muted)' }}>You haven't requested any shifts yet.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {myRequests.map(req => (
            <div key={req.id} className="card" style={{ padding: '1rem 1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>{req.event_name}</div>
                  <div style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>
                    {fmtDate(req.event_date)}
                    {req.start_time && <> &middot; {req.start_time}{req.end_time && ` - ${req.end_time}`}</>}
                    {req.location && <> &middot; {req.location}</>}
                  </div>
                  {req.position && (
                    <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                      Position: {req.position}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                  <StatusPill status={req.status} />
                  {req.status === 'pending' && (
                    <button className="btn btn-secondary btn-sm" onClick={() => cancelRequest(req.id)}>
                      Cancel
                    </button>
                  )}
                  {req.status === 'approved' && (
                    <button
                      className="btn btn-secondary btn-sm"
                      title="Download calendar event"
                      onClick={() => downloadShiftIcs(req.shift_id)}
                    >
                      Add to Calendar
                    </button>
                  )}
                </div>
              </div>

              {/* Team */}
              {req.status === 'approved' && req.team && req.team.length > 0 && (
                <div style={{ marginTop: '0.65rem', paddingTop: '0.6rem', borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--deep-brown)', marginBottom: '0.3rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                    Dr. Bartender Team
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                    {req.team.map((t, i) => (
                      <span key={i} style={{
                        fontSize: '0.78rem',
                        padding: '0.15rem 0.55rem',
                        borderRadius: 99,
                        background: t.user_id === user?.id ? 'var(--amber)' : 'var(--cream)',
                        color: t.user_id === user?.id ? 'white' : 'var(--warm-brown)',
                        border: t.user_id === user?.id ? 'none' : '1px solid var(--border)',
                        fontWeight: t.user_id === user?.id ? 700 : 500,
                      }}>
                        {t.user_id === user?.id ? `You (${t.name})` : t.name}
                        {t.position ? ` — ${t.position}` : ''}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
