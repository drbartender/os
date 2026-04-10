import React, { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';

function fmtDate(iso) {
  if (!iso) return '—';
  const dateStr = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export default function StaffEvents() {
  const { user } = useAuth();
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) return;
    setLoading(true);
    api.get(`/shifts/user/${user.id}/events`)
      .then(r => setEvents(r.data))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [user?.id]);

  return (
    <div className="page-container" style={{ maxWidth: 860 }}>
      <h1 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.5rem' }}>My Events</h1>
      <p className="text-muted text-small" style={{ marginBottom: '1rem' }}>Your event history and upcoming gigs</p>

      {loading ? (
        <div className="loading"><div className="spinner" />Loading your events...</div>
      ) : !events ? (
        <div className="card text-center" style={{ padding: '2.5rem' }}>
          <p style={{ color: 'var(--text-muted)' }}>Could not load event history.</p>
        </div>
      ) : (
        <>
          {/* Upcoming */}
          <h3 style={{ fontSize: '1rem', color: 'var(--deep-brown)', marginBottom: '0.5rem' }}>
            Upcoming Events ({events.upcoming.length})
          </h3>
          {events.upcoming.length === 0 ? (
            <div className="card" style={{ padding: '1.5rem', textAlign: 'center', marginBottom: '1.25rem' }}>
              <p style={{ color: 'var(--text-muted)', margin: 0 }}>No upcoming events. Check Available Shifts to find your next gig!</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginBottom: '1.25rem' }}>
              {events.upcoming.map(ev => (
                <div key={ev.id + '-up'} className="card" style={{ padding: '1rem 1.25rem', borderLeft: '3px solid var(--success)' }}>
                  <div style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.2rem' }}>
                    {ev.event_name || ev.proposal_event_name || 'Event'}
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
            Past Events ({events.past.length})
          </h3>
          {events.past.length === 0 ? (
            <div className="card" style={{ padding: '1.5rem', textAlign: 'center' }}>
              <p style={{ color: 'var(--text-muted)', margin: 0 }}>No past events yet.</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {events.past.map(ev => (
                <div key={ev.id + '-past'} className="card" style={{ padding: '0.85rem 1.25rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '0.5rem' }}>
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--deep-brown)', marginBottom: '0.15rem' }}>
                        {ev.event_name || ev.proposal_event_name || 'Event'}
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
        </>
      )}
    </div>
  );
}
