import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';
import { WHATSAPP_GROUP_URL } from '../../utils/constants';

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

export default function StaffShifts() {
  const { user } = useAuth();
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [requestingId, setRequestingId] = useState(null);
  const [selectedPositions, setSelectedPositions] = useState({});

  const isApproved = user?.onboarding_status === 'approved';

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get('/shifts');
      setShifts(res.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (isApproved) fetchData(); }, [isApproved]);

  async function requestShift(shiftId) {
    const position = selectedPositions[shiftId] || '';
    setRequestingId(shiftId);
    try {
      await api.post(`/shifts/${shiftId}/request`, { position });
      await fetchData();
    } catch (e) {
      console.error(e);
    } finally {
      setRequestingId(null);
    }
  }

  async function cancelRequest(requestId) {
    try {
      await api.delete(`/shifts/requests/${requestId}`);
      await fetchData();
    } catch (e) {
      console.error(e);
    }
  }

  return (
    <div className="page-container" style={{ maxWidth: 860 }}>
      <h1 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.5rem' }}>Available Shifts</h1>
      <p className="text-muted text-small" style={{ marginBottom: '1rem' }}>Open gigs you can request</p>

      {loading ? (
        <div className="loading"><div className="spinner" />Loading shifts...</div>
      ) : shifts.length === 0 ? (
        <div className="card text-center" style={{ padding: '2.5rem' }}>
          <h3 style={{ marginBottom: '0.5rem' }}>No Open Shifts Yet</h3>
          <p style={{ color: 'var(--text-muted)' }}>
            Check back soon — upcoming gigs will appear here when they're posted.
            Make sure you're in the <a href={WHATSAPP_GROUP_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--amber)' }}>WhatsApp group</a> for real-time updates.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {shifts.map(shift => {
            const alreadyRequested = !!shift.my_request_id;
            const reqStatus = shift.my_request_status;
            let positions = [];
            try { positions = JSON.parse(shift.positions_needed || '[]').map(p => typeof p === 'string' ? p : p.position || 'Bartender'); } catch (e) {}

            return (
              <div key={shift.id} className="card" style={{ padding: '1.25rem 1.5rem' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.05rem', color: 'var(--deep-brown)', marginBottom: '0.3rem' }}>
                      {shift.event_name}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--warm-brown)', fontWeight: 600 }}>
                      {fmtDate(shift.event_date)}
                      {shift.start_time && <> &middot; {shift.start_time}{shift.end_time && ` - ${shift.end_time}`}</>}
                    </div>
                    {shift.location && (
                      <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                        {shift.location}
                      </div>
                    )}
                    {positions.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem', marginTop: '0.5rem' }}>
                        {positions.map((p, i) => (
                          <span key={i} className="badge badge-inprogress">{p}</span>
                        ))}
                      </div>
                    )}
                    {shift.notes && (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.82rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
                        {shift.notes}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', flexShrink: 0 }}>
                    {alreadyRequested ? (
                      <>
                        <StatusPill status={reqStatus} />
                        {reqStatus === 'pending' && (
                          <button className="btn btn-secondary btn-sm"
                            onClick={() => cancelRequest(shift.my_request_id)}>
                            Cancel Request
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {positions.length > 1 && (
                          <select
                            className="form-select"
                            style={{ fontSize: '0.82rem', padding: '0.3rem 0.6rem', marginBottom: 0, minWidth: 140 }}
                            value={selectedPositions[shift.id] || ''}
                            onChange={e => setSelectedPositions(p => ({ ...p, [shift.id]: e.target.value }))}
                          >
                            <option value="">Any position</option>
                            {positions.map((p, i) => <option key={i} value={p}>{p}</option>)}
                          </select>
                        )}
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={requestingId === shift.id}
                          onClick={() => requestShift(shift.id)}
                        >
                          {requestingId === shift.id ? 'Sending...' : 'Request This Shift'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
