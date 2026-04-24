import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { getEventTypeLabel } from '../../utils/eventTypes';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import StaffPills from '../../components/adminos/StaffPills';
import AreaChart from '../../components/adminos/AreaChart';
import { fmt$, fmtDate, relDay, dayDiff } from '../../components/adminos/format';

// Map a proposal-y row to the event status chip used in handoff dashboard.jsx.
function eventStatusChip(e) {
  const total = Number(e.proposal_total || e.total_price || 0);
  const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
  if (e.proposal_status === 'sent' || e.proposal_status === 'viewed' || e.proposal_status === 'modified') {
    return <StatusChip kind="warn">Contract out</StatusChip>;
  }
  if (paid <= 0) return <StatusChip kind="warn">No payment</StatusChip>;
  if (paid < total) return <StatusChip kind="info">Deposit paid</StatusChip>;
  return <StatusChip kind="ok">Paid in full</StatusChip>;
}

// Convert shift rows into a positions[] shape that StaffPills expects.
function shiftPositions(s) {
  const needed = Number(s.bartenders_needed || s.positions_needed || 1);
  const filled = Number(s.assignments_count || 0);
  const pending = Math.min(needed - filled, Number(s.request_count || 0));
  return Array.from({ length: needed }, (_, i) => {
    if (i < filled) return { role: 'Bartender', name: 'Filled', status: 'approved' };
    if (i < filled + pending) return { role: 'Bartender', name: null, status: 'pending' };
    return { role: 'Bartender', name: null, status: null };
  });
}

const SHORT_MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Group events by event_date month, last 12 months ending this month.
// Returns [{ m: 'May', booked: <total>, collected: <paid> }, ...]
function buildRevenueSeries(events) {
  const now = new Date();
  const buckets = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    buckets.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      m: SHORT_MONTH[d.getMonth()],
      booked: 0,
      collected: 0,
    });
  }
  const byKey = Object.fromEntries(buckets.map(b => [b.key, b]));
  events.forEach(e => {
    if (!e.event_date) return;
    const key = e.event_date.slice(0, 7);
    const bucket = byKey[key];
    if (!bucket) return;
    bucket.booked += Number(e.proposal_total || e.total_price || 0);
    bucket.collected += Number(e.proposal_amount_paid || e.amount_paid || 0);
  });
  return buckets;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [events, setEvents] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let anyFailed = false;
    const trackFail = () => { anyFailed = true; };
    Promise.all([
      api.get('/shifts').then(r => r.data).catch(() => { trackFail(); return []; }),
      api.get('/proposals').then(r => r.data).catch(() => { trackFail(); return []; }),
      api.get('/admin/applications').then(r => r.data).catch(() => { trackFail(); return { applications: [] }; }),
    ])
      .then(([shiftsData, proposalsData, appsData]) => {
        setEvents((shiftsData || []).filter(s => s.proposal_id));
        setProposals(proposalsData || []);
        setApplications(appsData?.applications || appsData || []);
        if (anyFailed) toast.error('Some dashboard data failed to load. Try refreshing.');
      })
      .catch((err) => {
        toast.error('Some dashboard data failed to load. Try refreshing.');
        console.error(err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [toast]);

  const upcoming = useMemo(() =>
    events
      .filter(e => e.event_date && dayDiff(e.event_date.slice(0, 10)) >= 0)
      .sort((a, b) => a.event_date.localeCompare(b.event_date)),
  [events]);

  const totalBooked = useMemo(() =>
    events.reduce((s, e) => s + Number(e.proposal_total || 0), 0),
  [events]);

  const totalCollected = useMemo(() =>
    events.reduce((s, e) => s + Number(e.proposal_amount_paid || e.amount_paid || 0), 0),
  [events]);

  const outstanding = totalBooked - totalCollected;

  const eventsOwingBalance = useMemo(() =>
    events.filter(e => Number(e.proposal_total || 0) > Number(e.proposal_amount_paid || e.amount_paid || 0)).length,
  [events]);

  const unstaffed = useMemo(() =>
    upcoming.filter(e => {
      const needed = Number(e.bartenders_needed || e.positions_needed || 1);
      const filled = Number(e.assignments_count || 0);
      return filled < needed;
    }),
  [upcoming]);

  const openShifts = useMemo(() =>
    upcoming.reduce((sum, e) => {
      const needed = Number(e.bartenders_needed || e.positions_needed || 1);
      const filled = Number(e.assignments_count || 0);
      return sum + Math.max(0, needed - filled);
    }, 0),
  [upcoming]);

  const revenueSeries = useMemo(() => buildRevenueSeries(events), [events]);

  const newApplications = useMemo(() =>
    Array.isArray(applications) ? applications.filter(a => a.onboarding_status === 'applied').length : 0,
  [applications]);

  const actionQueue = useMemo(() => {
    const items = [];
    unstaffed.slice(0, 3).forEach(e => {
      const needed = Number(e.bartenders_needed || e.positions_needed || 1);
      const filled = Number(e.assignments_count || 0);
      const open = needed - filled;
      const days = dayDiff(e.event_date.slice(0, 10));
      items.push({
        id: 'unstaffed-' + e.id,
        type: 'unstaffed',
        priority: days < 7 ? 'danger' : 'warn',
        title: `${e.client_name || 'Event'} needs ${open} ${open === 1 ? 'bartender' : 'bartenders'}`,
        sub: `${getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })} · ${fmtDate(e.event_date.slice(0, 10))} · ${days}d out`,
        meta: `${open} open`,
        target: 'event',
        ref: e.proposal_id,
      });
    });
    proposals.filter(p => ['sent', 'viewed', 'modified'].includes(p.status)).slice(0, 2).forEach(p => {
      items.push({
        id: 'prop-' + p.id,
        type: 'proposal',
        priority: 'info',
        title: `${p.client_name || p.client_email} proposal — ${p.status}`,
        sub: getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom }),
        meta: fmt$(Number(p.total_price || 0)),
        target: 'proposal',
        ref: p.id,
      });
    });
    if (newApplications > 0) {
      items.push({
        id: 'apps',
        type: 'application',
        priority: 'info',
        title: `${newApplications} new ${newApplications === 1 ? 'application' : 'applications'}`,
        sub: 'Review in hiring',
        meta: `${newApplications} new`,
        target: 'hiring',
        ref: null,
      });
    }
    return items;
  }, [unstaffed, proposals, newApplications]);

  const pipeline = useMemo(() => {
    const buckets = [
      { key: 'draft',    label: 'Draft',    color: 'var(--ink-3)' },
      { key: 'sent',     label: 'Sent',     color: 'hsl(var(--info-h) var(--info-s) 62%)' },
      { key: 'viewed',   label: 'Viewed',   color: 'var(--accent)' },
      { key: 'modified', label: 'Modified', color: 'hsl(var(--violet-h) var(--violet-s) 65%)' },
      { key: 'accepted', label: 'Accepted', color: 'hsl(var(--ok-h) var(--ok-s) 52%)' },
    ];
    return buckets.map(b => {
      const items = proposals.filter(p => p.status === b.key);
      return {
        ...b,
        count: items.length,
        value: items.reduce((s, p) => s + Number(p.total_price || 0), 0),
      };
    });
  }, [proposals]);

  const maxPipelineValue = Math.max(1, ...pipeline.map(p => p.value));

  if (loading) {
    return (
      <div className="page">
        <div className="muted">Loading dashboard…</div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Dashboard</div>
          <div className="page-subtitle">
            {upcoming.length} upcoming {upcoming.length === 1 ? 'event' : 'events'}
            {unstaffed.length > 0 && ` · ${unstaffed.length} need staff`}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/admin/financials')}>
            <Icon name="external" />Financials
          </button>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/admin/proposals/new')}>
            <Icon name="plus" />New proposal
          </button>
        </div>
      </div>

      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat" onClick={() => navigate('/admin/financials')}>
          <div className="stat-label">Booked</div>
          <div className="stat-value">{fmt$(totalBooked)}</div>
          <div className="stat-sub"><span>{events.length} events on record</span></div>
        </div>
        <div className="stat" onClick={() => navigate('/admin/financials')}>
          <div className="stat-label">Collected</div>
          <div className="stat-value">{fmt$(totalCollected)}</div>
          <div className="stat-sub"><span>{totalBooked > 0 ? Math.round((totalCollected / totalBooked) * 100) : 0}% of booked</span></div>
        </div>
        <div className="stat" onClick={() => navigate('/admin/financials')}>
          <div className="stat-label">Outstanding</div>
          <div className="stat-value" style={{ color: outstanding > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>
            {fmt$(outstanding)}
          </div>
          <div className="stat-sub"><span>{eventsOwingBalance} {eventsOwingBalance === 1 ? 'event' : 'events'} owe balance</span></div>
        </div>
        <div className="stat" onClick={() => navigate('/admin/events')}>
          <div className="stat-label">Upcoming events</div>
          <div className="stat-value">{upcoming.length}</div>
          <div className="stat-sub">
            <span>{upcoming[0] ? `Next: ${fmtDate(upcoming[0].event_date.slice(0, 10))}` : 'No upcoming'}</span>
          </div>
        </div>
        <div className="stat" onClick={() => navigate('/admin/events')}>
          <div className="stat-label">Unstaffed</div>
          <div className="stat-value" style={{ color: unstaffed.length > 0 ? 'hsl(var(--danger-h) var(--danger-s) 65%)' : '' }}>
            {unstaffed.length}
          </div>
          <div className="stat-sub"><span>{openShifts} open {openShifts === 1 ? 'shift' : 'shifts'}</span></div>
        </div>
      </div>

      <div className="dash-main">
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <div className="card">
            <div className="card-head">
              <div className="hstack">
                <h3>Revenue</h3>
                <span className="k">12 months</span>
              </div>
              <div className="hstack" style={{ gap: 14 }}>
                <span className="hstack tiny muted" style={{ gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--accent)' }} />Booked
                </span>
                <span className="hstack tiny muted" style={{ gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'hsl(var(--ok-h) var(--ok-s) 52%)' }} />Collected
                </span>
              </div>
            </div>
            <div className="card-body">
              <AreaChart data={revenueSeries} />
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Upcoming events</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/admin/events')}>
                View all <Icon name="right" size={11} />
              </button>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Event</th><th>Date</th><th>Staffing</th><th>Status</th>
                    <th className="num">Total</th><th className="num">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {upcoming.length === 0 && (
                    <tr><td colSpan={6} className="muted">No upcoming events</td></tr>
                  )}
                  {upcoming.slice(0, 6).map(e => {
                    const total = Number(e.proposal_total || 0);
                    const paid = Number(e.proposal_amount_paid || e.amount_paid || 0);
                    const bal = total - paid;
                    return (
                      <tr key={e.id} onClick={() => navigate(`/admin/events/${e.proposal_id}`)}>
                        <td>
                          <strong>{e.client_name || '—'}</strong>
                          <div className="sub">{getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })}</div>
                        </td>
                        <td>
                          <div>{fmtDate(e.event_date.slice(0, 10))}</div>
                          <div className="sub">{relDay(e.event_date.slice(0, 10))}</div>
                        </td>
                        <td><StaffPills positions={shiftPositions(e)} /></td>
                        <td>{eventStatusChip(e)}</td>
                        <td className="num">{fmt$(total)}</td>
                        <td className="num" style={{ color: bal > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'var(--ink-3)' }}>
                          {bal > 0 ? fmt$(bal) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <div className="card">
            <div className="card-head">
              <h3><Icon name="alert" size={12} /> Needs attention</h3>
              <span className="k">{actionQueue.length}</span>
            </div>
            <div>
              {actionQueue.length === 0 && (
                <div className="muted tiny" style={{ padding: '0.75rem 1rem' }}>Nothing pressing right now.</div>
              )}
              {actionQueue.map(a => (
                <div
                  key={a.id}
                  className="queue-item"
                  onClick={() => {
                    if (a.target === 'event') navigate(`/admin/events/${a.ref}`);
                    else if (a.target === 'proposal') navigate(`/admin/proposals/${a.ref}`);
                    else if (a.target === 'hiring') navigate('/admin/hiring');
                  }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}
                >
                  <div className={`queue-icon ${a.priority}`}>
                    <Icon name={
                      a.type === 'unstaffed' ? 'userplus' :
                      a.type === 'proposal' ? 'eye' :
                      a.type === 'application' ? 'pen' :
                      'alert'
                    } />
                  </div>
                  <div className="queue-main">
                    <div className="queue-title">{a.title}</div>
                    <div className="queue-sub">{a.sub}</div>
                  </div>
                  <div className="queue-meta">{a.meta}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head"><h3>Pipeline</h3><span className="k">Proposals</span></div>
            <div className="card-body" style={{ padding: '0.75rem 1rem' }}>
              {pipeline.map(row => (
                <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 50px 80px', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 12 }}>
                  <span style={{ color: 'var(--ink-2)' }}>{row.label}</span>
                  <div className="bar"><div className="bar-fill" style={{ width: `${Math.min(100, (row.value / maxPipelineValue) * 100)}%`, background: row.color }} /></div>
                  <span className="num muted" style={{ textAlign: 'right' }}>{row.count}</span>
                  <span className="num" style={{ textAlign: 'right', color: 'var(--ink-1)', fontWeight: 600 }}>{fmt$(row.value)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
