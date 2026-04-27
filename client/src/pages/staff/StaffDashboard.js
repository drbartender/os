import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import api from '../../utils/api';
import { WHATSAPP_GROUP_URL } from '../../utils/constants';
import { getEventTypeLabel } from '../../utils/eventTypes';

function fmtDate(iso) {
  if (!iso) return '—';
  const dateStr = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function StaffDashboard() {
  const { user } = useAuth();
  const toast = useToast();
  const [stats, setStats] = useState(null);

  // Staff can view and request shifts as soon as onboarding is submitted —
  // admin approval is a back-office label, not a portal gate.
  const isOnboarded = ['submitted', 'reviewed', 'approved'].includes(user?.onboarding_status);
  const displayName = user?.preferred_name || user?.email?.split('@')[0] || 'there';

  useEffect(() => {
    if (!isOnboarded) return;
    Promise.all([
      api.get('/shifts'),
      api.get('/shifts/my-requests'),
      api.get(`/shifts/user/${user.id}/events`),
    ])
      .then(([shiftsRes, reqRes, eventsRes]) => {
        setStats({
          openShifts: shiftsRes.data.length,
          pendingRequests: reqRes.data.filter(r => r.status === 'pending').length,
          confirmedRequests: reqRes.data.filter(r => r.status === 'approved').length,
          upcomingEvents: eventsRes.data.upcoming?.length || 0,
          pastEvents: eventsRes.data.past?.length || 0,
          nextEvent: eventsRes.data.upcoming?.[0] || null,
        });
      })
      .catch(err => {
        console.error(err);
        toast.error("Couldn't load dashboard. Try refreshing.");
      });
  }, [isOnboarded, user?.id, toast]);

  return (
    <div className="page-container" style={{ maxWidth: 860 }}>
      {/* Welcome Banner */}
      <div className="card" style={{
        background: 'linear-gradient(135deg, #1a1410 0%, #2C1F0E 100%)',
        border: '1px solid rgba(193,125,60,0.4)',
        padding: '1.75rem 2rem',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: '1.5rem', color: 'var(--cream-text)', marginBottom: '0.3rem' }}>
              Welcome back, {displayName}
            </div>
            {isOnboarded && (
              <p style={{ color: 'var(--parchment)', opacity: 0.8, fontSize: '0.9rem', margin: 0 }}>
                You're an active Dr. Bartender team member.
              </p>
            )}
          </div>
          <a
            href={WHATSAPP_GROUP_URL}
            target="_blank" rel="noopener noreferrer"
            className="btn btn-secondary btn-sm"
          >
            WhatsApp Group
          </a>
        </div>
      </div>

      {isOnboarded && stats && (
        <>
          {/* Quick Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '0.75rem', marginTop: '1.25rem' }}>
            <Link to="/portal/shifts" className="card" style={{ padding: '1.25rem', textDecoration: 'none', textAlign: 'center' }}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--amber)' }}>{stats.openShifts}</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>Open Shifts</div>
            </Link>
            <Link to="/portal/schedule" className="card" style={{ padding: '1.25rem', textDecoration: 'none', textAlign: 'center' }}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--amber)' }}>{stats.pendingRequests}</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>Pending Requests</div>
            </Link>
            <Link to="/portal/schedule" className="card" style={{ padding: '1.25rem', textDecoration: 'none', textAlign: 'center' }}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--success)' }}>{stats.confirmedRequests}</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>Confirmed</div>
            </Link>
            <Link to="/portal/events" className="card" style={{ padding: '1.25rem', textDecoration: 'none', textAlign: 'center' }}>
              <div style={{ fontSize: '1.75rem', fontWeight: 700, color: 'var(--deep-brown)' }}>{stats.pastEvents}</div>
              <div style={{ fontSize: '0.82rem', color: 'var(--warm-brown)' }}>Events Worked</div>
            </Link>
          </div>

          {/* Next Upcoming Event */}
          {stats.nextEvent && (
            <div className="card" style={{ marginTop: '1rem', borderLeft: '3px solid var(--success)' }}>
              <h3 style={{ fontSize: '1rem', marginBottom: '0.5rem', color: 'var(--deep-brown)' }}>Next Event</h3>
              <div style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>
                {stats.nextEvent.client_name || 'Event'} — {getEventTypeLabel({ event_type: stats.nextEvent.event_type, event_type_custom: stats.nextEvent.event_type_custom })}
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--warm-brown)', marginTop: '0.2rem' }}>
                {fmtDate(stats.nextEvent.event_date)}
                {stats.nextEvent.start_time && <> &middot; {stats.nextEvent.start_time}{stats.nextEvent.end_time && ` - ${stats.nextEvent.end_time}`}</>}
                {stats.nextEvent.location && <> &middot; {stats.nextEvent.location}</>}
              </div>
              {stats.nextEvent.position && (
                <div style={{ marginTop: '0.35rem' }}>
                  <span className="badge badge-inprogress">{stats.nextEvent.position}</span>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
