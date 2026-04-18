import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import api from '../../utils/api';
import { WHATSAPP_GROUP_URL, COMPANY_PHONE, COMPANY_PHONE_TEL } from '../../utils/constants';
import { getEventTypeLabel } from '../../utils/eventTypes';

function fmtDate(iso) {
  if (!iso) return '—';
  const dateStr = typeof iso === 'string' ? iso.slice(0, 10) : new Date(iso).toISOString().slice(0, 10);
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function StaffDashboard() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);

  const isApproved = user?.onboarding_status === 'approved';
  const isPending = ['submitted', 'reviewed'].includes(user?.onboarding_status);
  const displayName = user?.preferred_name || user?.email?.split('@')[0] || 'there';

  useEffect(() => {
    if (!isApproved) return;
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
      .catch(console.error);
  }, [isApproved, user?.id]);

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
            {isPending && (
              <p style={{ color: 'var(--parchment)', opacity: 0.8, fontSize: '0.9rem', margin: 0 }}>
                Your onboarding is under review. You'll get full portal access once approved.
              </p>
            )}
            {isApproved && (
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

      {isPending && (
        <div className="card" style={{ marginTop: '1rem', textAlign: 'center', padding: '2.5rem' }}>
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

      {isApproved && stats && (
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
