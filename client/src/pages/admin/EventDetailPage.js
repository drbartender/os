import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { getEventTypeLabel } from '../../utils/eventTypes';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import { fmt$, fmt$cents, fmtDate, fmtDateFull, relDay } from '../../components/adminos/format';
import { eventStatusChip, parsePositionsCount, approvedCount } from '../../components/adminos/shifts';

export default function EventDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [proposal, setProposal] = useState(null);
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.get(`/proposals/${id}`).then(r => r.data),
      api.get(`/shifts/by-proposal/${id}`).then(r => Array.isArray(r.data) ? r.data : []).catch(() => []),
    ])
      .then(([pd, sd]) => {
        if (cancelled) return;
        setProposal(pd);
        setShifts(sd);
      })
      .catch(e => {
        if (cancelled) return;
        setErr(e?.message || 'Failed to load event');
        toast.error('Failed to load event.');
      })
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, toast]);

  if (loading) return <div className="page"><div className="muted">Loading event…</div></div>;
  if (err || !proposal) {
    return (
      <div className="page">
        <div className="hstack" style={{ marginBottom: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/events')}>
            <Icon name="left" size={11} />Events
          </button>
        </div>
        <div className="chip danger">{err || 'Event not found'}</div>
      </div>
    );
  }

  const total = Number(proposal.total_price || 0);
  const paid = Number(proposal.amount_paid || 0);
  const bal = total - paid;
  const eventTypeLabel = getEventTypeLabel({
    event_type: proposal.event_type,
    event_type_custom: proposal.event_type_custom,
  });

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="hstack" style={{ marginBottom: 8 }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/events')}>
          <Icon name="left" size={11} />Events
        </button>
      </div>

      {/* Identity bar */}
      <div className="card" style={{ padding: '1.5rem 1.75rem', marginBottom: 'var(--gap)' }}>
        <div className="hstack" style={{ gap: 18, alignItems: 'flex-start' }}>
          <div style={{
            width: 56, height: 56, display: 'grid', placeItems: 'center',
            background: 'var(--bg-2)', border: '1px solid var(--line-1)',
            borderRadius: 4, flexShrink: 0,
          }}>
            <Icon name="calendar" size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tiny muted" style={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontSize: 10, marginBottom: 4 }}>
              Event · {String(proposal.id).toUpperCase()}
            </div>
            <div className="hstack" style={{ gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 28, fontWeight: 500, margin: 0, lineHeight: 1.15 }}>
                {proposal.client_name || 'Event'} · {eventTypeLabel}
              </h1>
              {eventStatusChip(proposal)}
              {proposal.package_name && <span className="tag">{proposal.package_name}</span>}
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {fmtDateFull(proposal.event_date && String(proposal.event_date).slice(0, 10))}
              {proposal.event_start_time && ` · ${proposal.event_start_time}`}
              {proposal.event_location && ` · ${proposal.event_location}`}
            </div>
          </div>
          <div className="page-actions" style={{ flexShrink: 0 }}>
            <button type="button" className="btn btn-ghost" onClick={() => navigate(`/admin/proposals/${proposal.id}`)}>
              <Icon name="external" size={12} />Open proposal
            </button>
            {shifts.length === 1 && (
              <button type="button" className="btn btn-secondary" onClick={() => navigate(`/admin/events/shift/${shifts[0].id}`)}>
                <Icon name="userplus" size={12} />Manage staffing
              </button>
            )}
            {shifts.length > 1 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => document.getElementById('event-staffing-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              >
                <Icon name="userplus" size={12} />Manage staffing ({shifts.length})
              </button>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 'var(--gap)' }}>
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <div className="card">
            <div className="card-head"><h3>Event details</h3></div>
            <div className="card-body">
              <dl className="dl">
                <dt>Date</dt>
                <dd>{fmtDateFull(proposal.event_date && String(proposal.event_date).slice(0, 10))}</dd>
                <dt>Time</dt>
                <dd>
                  {proposal.event_start_time || '—'}
                  {proposal.event_duration_hours ? ` · ${proposal.event_duration_hours} ${Number(proposal.event_duration_hours) === 1 ? 'hour' : 'hours'}` : ''}
                </dd>
                <dt>Location</dt>
                <dd>{proposal.event_location || '—'}</dd>
                <dt>Guests</dt>
                <dd className="num">{proposal.guest_count || '—'}</dd>
                <dt>Event type</dt>
                <dd>{eventTypeLabel}</dd>
                {proposal.package_name && (<>
                  <dt>Package</dt>
                  <dd>{proposal.package_name}</dd>
                </>)}
              </dl>
            </div>
          </div>

          <div className="card" id="event-staffing-card">
            <div className="card-head">
              <h3>Staffing</h3>
              {shifts.length === 1 && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(`/admin/events/shift/${shifts[0].id}`)}>
                  <Icon name="external" size={11} />Manage
                </button>
              )}
            </div>
            <div className="card-body">
              {shifts.length === 0 && (
                <div className="muted tiny">No shifts created for this event yet.</div>
              )}
              {shifts.map(s => {
                const needed = parsePositionsCount(s);
                const filled = approvedCount(s);
                const requestCount = Number(s.request_count || 0);
                const goToShift = () => navigate(`/admin/events/shift/${s.id}`);
                return (
                  <div
                    key={s.id}
                    onClick={goToShift}
                    onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); goToShift(); } }}
                    role="button"
                    tabIndex={0}
                    className="event-shift-row"
                    style={{ marginBottom: 10, cursor: 'pointer', padding: '8px 10px', margin: '0 -10px 4px', borderRadius: 4 }}
                    title="Open shift"
                  >
                    <div className="hstack" style={{ marginBottom: 6 }}>
                      <strong>{s.event_date ? fmtDate(String(s.event_date).slice(0, 10)) : '—'}</strong>
                      <span className="tiny muted">{s.start_time || ''}{s.end_time ? ` – ${s.end_time}` : ''}</span>
                      <div className="spacer" />
                      <StatusChip kind={filled >= needed ? 'ok' : filled > 0 ? 'warn' : 'danger'}>
                        {filled}/{needed} staffed
                      </StatusChip>
                      <Icon name="right" size={10} />
                    </div>
                    {requestCount > 0 && (
                      <div className="tiny muted" style={{ marginLeft: 0 }}>
                        {requestCount} {requestCount === 1 ? 'request' : 'requests'} on file
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {Array.isArray(proposal.activity) && proposal.activity.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Activity</h3><span className="k">{proposal.activity.length}</span></div>
              <div className="card-body">
                <div className="vstack" style={{ gap: 10, fontSize: 12.5 }}>
                  {proposal.activity.slice(0, 12).map((a, i) => (
                    <div key={i} className="hstack" style={{ alignItems: 'flex-start' }}>
                      <div className="queue-icon info" style={{ flexShrink: 0 }}>
                        <Icon name={
                          a.action === 'payment' ? 'dollar' :
                          a.action === 'sent' ? 'send' :
                          a.action === 'viewed' ? 'eye' :
                          a.action === 'signed' ? 'check' :
                          'pen'
                        } size={12} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div>{a.action || a.event_type || 'Update'}</div>
                        {a.metadata && typeof a.metadata === 'object' && (
                          <div className="tiny muted">{a.metadata.note || a.metadata.message || ''}</div>
                        )}
                      </div>
                      <div className="tiny muted">{a.created_at ? relDay(String(a.created_at).slice(0, 10)) : ''}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <div className="card">
            <div className="card-head"><h3>Financial</h3></div>
            <div className="card-body">
              <div className="stat" style={{ padding: 0 }}>
                <div className="stat-label">Total</div>
                <div className="stat-value">{fmt$(total)}</div>
              </div>
              <div style={{ height: 12 }} />
              <dl className="dl">
                <dt>Paid</dt><dd className="num">{fmt$cents(paid)}</dd>
                <dt>Balance</dt>
                <dd className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>
                  {fmt$cents(bal)}
                </dd>
                <dt>Status</dt>
                <dd>{eventStatusChip(proposal)}</dd>
              </dl>
              <div className="hstack" style={{ marginTop: 12, gap: 6 }}>
                <button type="button" className="btn btn-secondary" style={{ flex: 1 }}
                  onClick={() => navigate(`/admin/proposals/${proposal.id}`)}>
                  <Icon name="external" size={11} />Edit proposal
                </button>
              </div>
            </div>
          </div>

          {(proposal.client_email || proposal.client_phone) && (
            <div className="card">
              <div className="card-head"><h3>Client</h3></div>
              <div className="card-body">
                <dl className="dl">
                  <dt>Name</dt><dd>{proposal.client_name || '—'}</dd>
                  {proposal.client_email && <><dt>Email</dt><dd>{proposal.client_email}</dd></>}
                  {proposal.client_phone && <><dt>Phone</dt><dd>{proposal.client_phone}</dd></>}
                  {proposal.client_source && <><dt>Source</dt><dd className="muted">{proposal.client_source}</dd></>}
                </dl>
                {proposal.client_id && (
                  <div className="hstack" style={{ marginTop: 12 }}>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(`/admin/clients/${proposal.client_id}`)}>
                      <Icon name="external" size={11} />Open client
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
