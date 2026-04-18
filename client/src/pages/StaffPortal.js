import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import BrandLogo from '../components/BrandLogo';
import api from '../utils/api';
import { WHATSAPP_GROUP_URL, COMPANY_PHONE, COMPANY_PHONE_TEL } from '../utils/constants';
import { getEventTypeLabel } from '../utils/eventTypes';

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

export default function StaffPortal() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
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
      .catch(() => toast.error('Failed to load shifts. Try refreshing.'))
      .finally(() => setLoadingShifts(false));
  }, [isApproved, toast]);

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
      toast.success('Shift requested!');
    } catch (e) {
      toast.error(e.message || 'Failed to request shift.');
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
      toast.success('Request cancelled.');
    } catch (e) {
      toast.error(e.message || 'Failed to cancel request.');
    }
  }

  // ── Calendar helpers ──
  const [calFeedUrl, setCalFeedUrl] = useState('');
  const [calCopied, setCalCopied] = useState(false);
  const [calLoading, setCalLoading] = useState(false);

  const fetchCalendarUrl = useCallback(async () => {
    if (calFeedUrl) return; // already fetched
    setCalLoading(true);
    try {
      const res = await api.get('/calendar/token');
      setCalFeedUrl(res.data.feed_url);
    } catch (err) {
      toast.error('Failed to load calendar URL. Try again.');
    } finally {
      setCalLoading(false);
    }
  }, [calFeedUrl, toast]);

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
      toast.error('Failed to download calendar event.');
    }
  }

  async function copyCalUrl() {
    try {
      await navigator.clipboard.writeText(calFeedUrl);
    } catch {
      const input = document.createElement('input');
      input.value = calFeedUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
    }
    setCalCopied(true);
    setTimeout(() => setCalCopied(false), 2000);
  }

  // My Events state
  const [myEvents, setMyEvents] = useState(null);
  const [myEventsLoading, setMyEventsLoading] = useState(false);

  useEffect(() => {
    if (tab !== 'my-events' || !isApproved || !user?.id) return;
    setMyEventsLoading(true);
    api.get(`/shifts/user/${user.id}/events`)
      .then(r => setMyEvents(r.data))
      .catch(() => toast.error('Failed to load your events. Try refreshing.'))
      .finally(() => setMyEventsLoading(false));
  }, [tab, isApproved, user?.id, toast]);

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
                href={WHATSAPP_GROUP_URL}
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
              Questions? Text us at <a href={COMPANY_PHONE_TEL} style={{ color: 'var(--amber)' }}>{COMPANY_PHONE}</a> or email{' '}
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
              <button className={`tab-btn ${tab === 'my-events' ? 'active' : ''}`} onClick={() => setTab('my-events')}>
                My Events
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
                      Make sure you're in the <a href={WHATSAPP_GROUP_URL} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--amber)' }}>WhatsApp group</a> for real-time updates.
                    </p>
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '0.5rem' }}>
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
                                {shift.client_name || 'Event'} — {getEventTypeLabel({ event_type: shift.event_type, event_type_custom: shift.event_type_custom })}
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
                      <div key={req.id} className="card" style={{ padding: '1rem 1.25rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' }}>
                          <div>
                            <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>{req.client_name || 'Event'} — {getEventTypeLabel({ event_type: req.event_type, event_type_custom: req.event_type_custom })}</div>
                            <div style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>
                              {fmtDate(req.event_date)}
                              {req.start_time && <> · {req.start_time}{req.end_time && ` – ${req.end_time}`}</>}
                              {req.location && <> · {req.location}</>}
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
                              <button className="btn btn-secondary btn-sm"
                                onClick={() => cancelRequest(req.id)}>
                                Cancel
                              </button>
                            )}
                            {req.status === 'approved' && (
                              <button
                                className="btn btn-secondary btn-sm"
                                title="One-time import. Use 'Sync My Shifts' in Resources for ongoing updates."
                                onClick={() => downloadShiftIcs(req.shift_id)}
                              >
                                Add to Calendar
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Dr. Bartender Team */}
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
              </>
            )}

            {/* ── My Events ── */}
            {tab === 'my-events' && (
              <>
                {myEventsLoading ? (
                  <div className="loading"><div className="spinner" />Loading your events...</div>
                ) : !myEvents ? (
                  <div className="card text-center" style={{ padding: '2.5rem', marginTop: '0.5rem' }}>
                    <p style={{ color: 'var(--text-muted)' }}>Could not load event history.</p>
                  </div>
                ) : (
                  <div style={{ marginTop: '0.5rem' }}>
                    {/* Upcoming */}
                    <h3 style={{ fontSize: '1rem', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
                      Upcoming Events ({myEvents.upcoming.length})
                    </h3>
                    {myEvents.upcoming.length === 0 ? (
                      <div className="card" style={{ padding: '1.5rem', textAlign: 'center', marginBottom: '1.25rem' }}>
                        <p style={{ color: 'var(--text-muted)', margin: 0 }}>No upcoming events. Check Available Shifts to find your next gig!</p>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '1.25rem' }}>
                        {myEvents.upcoming.map(ev => (
                          <div key={ev.id + '-up'} className="card" style={{ padding: '1rem 1.25rem', borderLeft: '3px solid var(--success)' }}>
                            <div style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.2rem' }}>
                              {ev.client_name || 'Event'} — {getEventTypeLabel({ event_type: ev.event_type, event_type_custom: ev.event_type_custom })}
                            </div>
                            <div style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>
                              {fmtDate(ev.event_date)}
                              {ev.start_time && <> &middot; {ev.start_time}{ev.end_time && ` - ${ev.end_time}`}</>}
                            </div>
                            {ev.location && (
                              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                {ev.location}
                              </div>
                            )}
                            {ev.position && (
                              <div style={{ marginTop: '0.35rem' }}>
                                <span className="badge badge-inprogress">{ev.position}</span>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Past */}
                    <h3 style={{ fontSize: '1rem', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
                      Past Events ({myEvents.past.length})
                    </h3>
                    {myEvents.past.length === 0 ? (
                      <div className="card" style={{ padding: '1.5rem', textAlign: 'center' }}>
                        <p style={{ color: 'var(--text-muted)', margin: 0 }}>No past events yet.</p>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        {myEvents.past.map(ev => (
                          <div key={ev.id + '-past'} className="card" style={{ padding: '0.85rem 1.25rem' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
                              <div>
                                <div style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.15rem' }}>
                                  {ev.client_name || 'Event'} — {getEventTypeLabel({ event_type: ev.event_type, event_type_custom: ev.event_type_custom })}
                                </div>
                                <div style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>
                                  {fmtDate(ev.event_date)}
                                  {ev.location && <> &middot; {ev.location}</>}
                                </div>
                              </div>
                              {ev.position && <span className="badge badge-inprogress">{ev.position}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
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
                      href={WHATSAPP_GROUP_URL}
                      target="_blank" rel="noopener noreferrer"
                      className="btn btn-secondary" style={{ textAlign: 'left', textDecoration: 'none' }}
                    >
                      💬 WhatsApp Group
                    </a>
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="card">
                    <h3 style={{ marginBottom: '0.75rem', fontSize: '1rem' }}>Calendar Sync</h3>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                      Subscribe to your confirmed shifts in any calendar app. This keeps your calendar updated automatically as shifts are added or changed.
                    </p>

                    {!calFeedUrl ? (
                      <button className="btn btn-secondary btn-sm" onClick={fetchCalendarUrl} disabled={calLoading}>
                        {calLoading ? 'Loading...' : 'Get Sync URL'}
                      </button>
                    ) : (
                      <>
                        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.6rem' }}>
                          <input
                            type="text" readOnly value={calFeedUrl}
                            onClick={e => e.target.select()}
                            style={{
                              flex: 1, padding: '0.45rem 0.6rem', fontSize: '0.75rem',
                              border: '1px solid var(--border)', borderRadius: '6px',
                              background: 'var(--cream)', fontFamily: 'monospace',
                            }}
                          />
                          <button className="btn btn-primary btn-sm" onClick={copyCalUrl} style={{ whiteSpace: 'nowrap' }}>
                            {calCopied ? 'Copied!' : 'Copy'}
                          </button>
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                          <strong>Google Calendar</strong> (desktop): "+" next to Other calendars → From URL → paste<br />
                          <strong>Apple Calendar</strong>: File → New Calendar Subscription → paste<br />
                          <strong>Outlook</strong>: Add calendar → Subscribe from web → paste
                        </div>
                        <p style={{ fontSize: '0.75rem', color: 'var(--warm-brown)', marginTop: '0.5rem', marginBottom: 0, fontStyle: 'italic' }}>
                          Keep this link private — anyone with it can see your schedule.
                        </p>
                      </>
                    )}
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
                      Questions? Text <a href={COMPANY_PHONE_TEL} style={{ color: 'var(--amber)' }}>{COMPANY_PHONE}</a>
                      {' '}or email <a href="mailto:contact@drbartender.com" style={{ color: 'var(--amber)' }}>contact@drbartender.com</a>
                    </div>
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
