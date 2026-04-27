import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { getEventTypeLabel } from '../../utils/eventTypes';
import Icon from '../../components/adminos/Icon';
import StaffPills from '../../components/adminos/StaffPills';
import AreaChart from '../../components/adminos/AreaChart';
import { fmt$, fmtDate, relDay, dayDiff } from '../../components/adminos/format';
import { shiftPositions, parsePositionsCount, approvedCount, eventStatusChip } from '../../components/adminos/shifts';

const PIPELINE_COLORS = {
  draft:    'var(--ink-3)',
  sent:     'hsl(var(--info-h) var(--info-s) 62%)',
  viewed:   'var(--accent)',
  modified: 'hsl(var(--violet-h) var(--violet-s) 65%)',
  accepted: 'hsl(var(--ok-h) var(--ok-s) 52%)',
};

// Route a shift row to its event detail (proposal-backed) or shift detail (manual).
function eventRoute(e) {
  return e?.proposal_id ? `/events/${e.proposal_id}` : `/events/shift/${e?.id}`;
}

const EMPTY_STATS = {
  totals: { booked: 0, collected: 0, outstanding: 0, events_count: 0, events_owing_balance: 0 },
  pipeline: [],
  revenue: [],
};

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const [stats, setStats] = useState(EMPTY_STATS);
  const [shifts, setShifts] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let anyFailed = false;
    const trackFail = () => { anyFailed = true; };
    Promise.all([
      api.get('/proposals/dashboard-stats').then(r => r.data).catch(() => { trackFail(); return EMPTY_STATS; }),
      api.get('/shifts').then(r => r.data).catch(() => { trackFail(); return []; }),
      api.get('/proposals').then(r => r.data).catch(() => { trackFail(); return []; }),
      api.get('/admin/applications').then(r => r.data).catch(() => { trackFail(); return { applications: [] }; }),
    ])
      .then(([statsData, shiftsData, proposalsData, appsData]) => {
        setStats(statsData || EMPTY_STATS);
        setShifts(shiftsData || []);
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

  // All shifts (manual + proposal-backed) count for staffing-status views.
  // Revenue stats come from the server-side aggregation, not this list.
  const upcoming = useMemo(() =>
    shifts
      .filter(e => e.event_date && dayDiff(e.event_date.slice(0, 10)) >= 0)
      .sort((a, b) => a.event_date.localeCompare(b.event_date)),
  [shifts]);

  const unstaffed = useMemo(() =>
    upcoming.filter(e => approvedCount(e) < parsePositionsCount(e)),
  [upcoming]);

  const openShifts = useMemo(() =>
    upcoming.reduce((sum, e) => sum + Math.max(0, parsePositionsCount(e) - approvedCount(e)), 0),
  [upcoming]);

  const newApplications = useMemo(() =>
    Array.isArray(applications) ? applications.filter(a => a.onboarding_status === 'applied').length : 0,
  [applications]);

  const actionQueue = useMemo(() => {
    const items = [];
    unstaffed.slice(0, 3).forEach(e => {
      const needed = parsePositionsCount(e);
      const filled = approvedCount(e);
      const open = needed - filled;
      const days = dayDiff(e.event_date.slice(0, 10));
      items.push({
        id: 'unstaffed-' + e.id,
        type: 'unstaffed',
        priority: days < 7 ? 'danger' : 'warn',
        title: `${e.client_name || 'Event'} needs ${open} ${open === 1 ? 'bartender' : 'bartenders'}`,
        sub: `${getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })} · ${fmtDate(e.event_date.slice(0, 10))} · ${days}d out`,
        meta: `${open} open`,
        target: e.proposal_id ? 'event' : 'shift',
        ref: e.proposal_id || e.id,
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

  const totals = stats.totals || EMPTY_STATS.totals;
  const totalBooked = Number(totals.booked || 0);
  const totalCollected = Number(totals.collected || 0);
  const outstanding = Number(totals.outstanding || 0);
  const eventsOwingBalance = Number(totals.events_owing_balance || 0);
  const eventsCount = Number(totals.events_count || 0);

  const pipeline = stats.pipeline || [];
  const maxPipelineValue = Math.max(1, ...pipeline.map(p => Number(p.value || 0)));

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
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/financials')}>
            <Icon name="external" />Financials
          </button>
          <button type="button" className="btn btn-primary" onClick={() => navigate('/proposals/new')}>
            <Icon name="plus" />New proposal
          </button>
        </div>
      </div>

      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat" onClick={() => navigate('/financials')}>
          <div className="stat-label">Booked</div>
          <div className="stat-value">{fmt$(totalBooked)}</div>
          <div className="stat-sub"><span>{eventsCount} {eventsCount === 1 ? 'event' : 'events'} on record</span></div>
        </div>
        <div className="stat" onClick={() => navigate('/financials')}>
          <div className="stat-label">Collected</div>
          <div className="stat-value">{fmt$(totalCollected)}</div>
          <div className="stat-sub"><span>{totalBooked > 0 ? Math.round((totalCollected / totalBooked) * 100) : 0}% of booked</span></div>
        </div>
        <div className="stat" onClick={() => navigate('/financials')}>
          <div className="stat-label">Outstanding</div>
          <div className="stat-value" style={{ color: outstanding > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>
            {fmt$(outstanding)}
          </div>
          <div className="stat-sub"><span>{eventsOwingBalance} {eventsOwingBalance === 1 ? 'event' : 'events'} owe balance</span></div>
        </div>
        <div className="stat" onClick={() => navigate('/events')}>
          <div className="stat-label">Upcoming events</div>
          <div className="stat-value">{upcoming.length}</div>
          <div className="stat-sub">
            <span>{upcoming[0] ? `Next: ${fmtDate(upcoming[0].event_date.slice(0, 10))}` : 'No upcoming'}</span>
          </div>
        </div>
        <div className="stat" onClick={() => navigate('/events')}>
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
              <AreaChart data={stats.revenue || []} />
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Upcoming events</h3>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/events')}>
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
                      <tr key={e.id} onClick={() => navigate(eventRoute(e))}>
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
                        <td className="num">{total > 0 ? fmt$(total) : '—'}</td>
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
                    if (a.target === 'event') navigate(`/events/${a.ref}`);
                    else if (a.target === 'shift') navigate(`/events/shift/${a.ref}`);
                    else if (a.target === 'proposal') navigate(`/proposals/${a.ref}`);
                    else if (a.target === 'hiring') navigate('/hiring');
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
              {pipeline.length === 0 && (
                <div className="muted tiny">No active proposals.</div>
              )}
              {pipeline.map(row => {
                const value = Number(row.value || 0);
                return (
                  <div key={row.key} style={{ display: 'grid', gridTemplateColumns: '80px 1fr 50px 80px', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 12 }}>
                    <span style={{ color: 'var(--ink-2)' }}>{row.label}</span>
                    <div className="bar"><div className="bar-fill" style={{ width: `${Math.min(100, (value / maxPipelineValue) * 100)}%`, background: PIPELINE_COLORS[row.key] || 'var(--ink-3)' }} /></div>
                    <span className="num muted" style={{ textAlign: 'right' }}>{row.count}</span>
                    <span className="num" style={{ textAlign: 'right', color: 'var(--ink-1)', fontWeight: 600 }}>{fmt$(value)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
