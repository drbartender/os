import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import BrandLogo from '../components/BrandLogo';
import api from '../utils/api';

const POSITIONS = ['Bartender', 'Barback', 'Banquet Server']; // eslint-disable-line no-unused-vars

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
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function StaffPortal() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [shifts, setShifts] = useState([]);
  const [myRequests, setMyRequests] = useState([]);
  const [loadingShifts, setLoadingShifts] = useState(true);
  const [requestingId, setRequestingId] = useState(null);
  const [selectedPositions, setSelectedPositions] = useState({});
  const [tab, setTab] = useState('shifts');

  const isApproved = user?.onboarding_status === 'approved';
  const isPending = ['submitted', 'reviewed'].includes(user?.onboarding_status);

  useEffect(() => {
    if (!isApproved) return;
    setLoadingShifts(true);
    Promise.all([
      api.get('/shifts'),
      api.get('/shifts/my-requests'),
    ])
      .then(([shiftsRes, reqRes]) => {
        setShifts(shiftsRes.data);
        setMyRequests(reqRes.data);
      })
      .catch(console.error)
      .finally(() => setLoadingShifts(false));
  }, [isApproved]);

  async function requestShift(shiftId) {
    const position = selectedPositions[shiftId] || '';
    setRequestingId(shiftId);
    try {
      await api.post(`/shifts/${shiftId}/request`, { position });
      // Refresh shifts to get updated request status
      const [shiftsRes, reqRes] = await Promise.all([
        api.get('/shifts'),
        api.get('/shifts/my-requests'),
      ]);
      setShifts(shiftsRes.data);
      setMyRequests(reqRes.data);
    } catch (e) {
      console.error(e);
    } finally {
      setRequestingId(null);
    }
  }

  async function cancelRequest(requestId) {
    try {
      await api.delete(`/shifts/requests/${requestId}`);
      const [shiftsRes, reqRes] = await Promise.all([
        api.get('/shifts'),
        api.get('/shifts/my-requests'),
      ]);
      setShifts(shiftsRes.data);
      setMyRequests(reqRes.data);
    } catch (e) {
      console.error(e);
    }
  }

  const displayName = user?.preferred_name || user?.email?.split('@')[0] || 'there';

  return (
    <div className="admin-page" style={{ minHeight: '100vh' }}>
      <header className="site-header">
        <BrandLogo />
        <div className="header-actions">
          <span className="header-user">{user?.email}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => { logout(); navigate('/login'); }}>
            Sign Out
          </button>
        </div>
      </header>

      <div className="page-container" style={{ maxWidth: 860 }}>

        {/* ── Welcome Banner ── */}
        <div className="card" style={{
          background: 'linear-gradient(135deg, #1a1410 0%, #2C1F0E 100%)',
          border: '1px solid rgba(193,125,60,0.4)',
          marginTop: '1.5rem', padding: '1.75rem 2rem',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
            <div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', color: 'var(--cream-text)', marginBottom: '0.3rem' }}>
                Welcome back, {displayName} 🍸
              </div>
              {isPending && (
                <p style={{ color: 'var(--parchment)', opacity: 0.8, fontSize: '0.9rem', margin: 0 }}>
                  Your onboarding is under review. You'll get full portal access once approved — usually within a few days.
                </p>
              )}
              {isApproved && (
                <p style={{ color: 'var(--parchment)', opacity: 0.8, fontSize: '0.9rem', margin: 0 }}>
                  You're an active Dr. Bartender team member. Check the shifts below and request the gigs you want.
                </p>
              )}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'flex-end' }}>
              <a
                href="https://chat.whatsapp.com/GjZsSHG5BsRCR2yc9Z2b5A"
                target="_blank" rel="noopener noreferrer"
                className="btn btn-secondary btn-sm"
              >
                💬 WhatsApp Group
              </a>
            </div>
          </div>
        </div>

        {/* ── Review Pending State ── */}
        {isPending && (
          <div className="card" style={{ marginTop: '1rem', textAlign: 'center', padding: '2.5rem' }}>
            <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }}>⏳</div>
            <h3 style={{ marginBottom: '0.5rem' }}>Onboarding Under Review</h3>
            <p style={{ color: 'var(--text-muted)', maxWidth: 480, margin: '0 auto 1.5rem' }}>
              The Dr. Bartender team is reviewing your submission. Once approved, you'll be able to view available shifts and request gigs here.
            </p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)' }}>
              Questions? Text us at <a href="tel:+13125889401" style={{ color: 'var(--amber)' }}>(312) 588-9401</a> or email{' '}
              <a href="mailto:contact@drbartender.com" style={{ color: 'var(--amber)' }}>contact@drbartender.com</a>
            </p>
          </div>
        )}

        {/* ── Approved: Full Portal ── */}
        {isApproved && (
          <>
            {/* Tabs */}
            <div className="tab-nav" style={{ marginTop: '1.25rem' }}>
              <button className={`tab-btn ${tab === 'shifts' ? 'active' : ''}`} onClick={() => setTab('shifts')}>
                Available Shifts
              </button>
              <button className={`tab-btn ${tab === 'my-requests' ? 'active' : ''}`} onClick={() => setTab('my-requests')}>
                My Requests {myRequests.length > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--amber)', color: 'white', borderRadius: 99, fontSize: '0.65rem', fontWeight: 700, minWidth: 17, height: 17, padding: '0 4px', marginLeft: '0.35rem' }}>
                    {myRequests.length}
                  </span>
                )}
              </button>
              <button className={`tab-btn ${tab === 'resources' ? 'active' : ''}`} onClick={() => setTab('resources')}>
                Resources & Profile
              </button>
            </div>

            {/* ── Available Shifts ── */}
            {tab === 'shifts' && (
              <>
                {loadingShifts ? (
                  <div className="loading"><div className="spinner" />Loading shifts…</div>
                ) : shifts.length === 0 ? (
                  <div className="card text-center" style={{ padding: '2.5rem' }}>
                    <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }}>📅</div>
                    <h3 style={{ marginBottom: '0.5rem' }}>No Open Shifts Yet</h3>
                    <p style={{ color: 'var(--text-muted)' }}>
                      Check back soon — upcoming gigs will appear here when they're posted.
                      Make sure you're in the <a href="https://chat.whatsapp.com/GjZsSHG5BsRCR2yc9Z2b5A" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--amber)' }}>WhatsApp group</a> for real-time updates.
                    </p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
                    {shifts.map(shift => {
                      const alreadyRequested = !!shift.my_request_id;
                      const reqStatus = shift.my_request_status;
                      let positions = [];
                      try { positions = JSON.parse(shift.positions_needed || '[]'); } catch (e) {}

                      return (
                        <div key={shift.id} className="card" style={{ padding: '1.25rem 1.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                            <div style={{ flex: 1, minWidth: 220 }}>
                              <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.05rem', color: 'var(--deep-brown)', marginBottom: '0.3rem' }}>
                                {shift.event_name}
                              </div>
                              <div style={{ fontSize: '0.85rem', color: 'var(--warm-brown)', fontWeight: 600 }}>
                                📅 {fmtDate(shift.event_date)}
                                {shift.start_time && <> &nbsp;·&nbsp; 🕐 {shift.start_time}{shift.end_time && ` – ${shift.end_time}`}</>}
                              </div>
                              {shift.location && (
                                <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                                  📍 {shift.location}
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
                                    {requestingId === shift.id ? 'Sending…' : 'Request This Shift'}
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
              </>
            )}

            {/* ── My Requests ── */}
            {tab === 'my-requests' && (
              <>
                {myRequests.length === 0 ? (
                  <div className="card text-center" style={{ padding: '2.5rem', marginTop: '0.5rem' }}>
                    <p style={{ color: 'var(--text-muted)' }}>You haven't requested any shifts yet.</p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '0.5rem' }}>
                    {myRequests.map(req => (
                      <div key={req.id} className="card" style={{ padding: '1rem 1.25rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                        <div>
                          <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>{req.event_name}</div>
                          <div style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>
                            {fmtDate(req.event_date)}
                            {req.start_time && <> · {req.start_time}{req.end_time && ` – ${req.end_time}`}</>}
                            {req.location && <> · {req.location}</>}
                          </div>
                          {req.position && (
                            <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                              Position requested: {req.position}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                          <StatusPill status={req.status} />
                          {req.status === 'pending' && (
                            <button className="btn btn-secondary btn-sm"
                              onClick={() => cancelRequest(req.id)}>
                              Cancel
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}

            {/* ── Resources & Profile ── */}
            {tab === 'resources' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '0.5rem' }}>
                <div className="card">
                  <h3 style={{ marginBottom: '1rem', fontSize: '1rem' }}>Quick Links</h3>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    <Link to="/field-guide" className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}>
                      📖 Field Guide
                    </Link>
                    <Link to="/agreement" className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}>
                      📝 My Signed Agreement
                    </Link>
                    <Link to="/payday-protocols" className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}>
                      💳 Payday Protocols
                    </Link>
                    <a
                      href="https://chat.whatsapp.com/GjZsSHG5BsRCR2yc9Z2b5A"
                      target="_blank" rel="noopener noreferrer"
                      className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}
                    >
                      💬 WhatsApp Group
                    </a>
                  </div>
                </div>

                <div className="card">
                  <h3 style={{ marginBottom: '1rem', fontSize: '1rem' }}>Update Your Info</h3>
                  <p style={{ fontSize: '0.88rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                    Keep your contact info, emergency contact, equipment, and documents up to date.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                    <Link to="/contractor-profile" className="btn btn-primary" style={{ textAlign: 'left', textDecoration: 'none' }}>
                      ✏️ Edit Contractor Profile
                    </Link>
                  </div>
                  <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    Questions? Text <a href="tel:+13125889401" style={{ color: 'var(--amber)' }}>(312) 588-9401</a>
                    {' '}or email <a href="mailto:contact@drbartender.com" style={{ color: 'var(--amber)' }}>contact@drbartender.com</a>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

      </div>
    </div>
  );
}
