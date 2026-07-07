import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';
import { useAuth } from '../../context/AuthContext';
import { getEventTypeLabel } from '../../utils/eventTypes';
import Icon from '../../components/adminos/Icon';
import StaffPills from '../../components/adminos/StaffPills';
import AreaChart from '../../components/adminos/AreaChart';
import MetricsFilterBar from '../../components/adminos/MetricsFilterBar';
import useMetricsFilter from '../../hooks/useMetricsFilter';
import { fmt$, fmtDate, relDay, dayDiff } from '../../components/adminos/format';
import { shiftPositions, parsePositionsCount, approvedCount, eventStatusChip } from '../../components/adminos/shifts';
import ClickableRow from '../../components/ClickableRow';
import EntityLink from '../../components/EntityLink';

const PIPELINE_COLORS = {
  draft: 'var(--ink-3)',
  sent: 'hsl(var(--info-h) var(--info-s) 62%)',
  viewed: 'var(--accent)',
  modified: 'hsl(var(--violet-h) var(--violet-s) 65%)',
  accepted: 'hsl(var(--ok-h) var(--ok-s) 52%)',
};

function eventRoute(e) {
  return e?.proposal_id ? `/events/${e.proposal_id}` : `/events/shift/${e?.id}`;
}

// Real-link target for a needs-attention queue item. Event/shift/proposal items
// get a canonical entity link (cmd-click opens a new tab); hiring and other
// targetless items return null and stay plain text (the row onClick still
// navigates them).
function queueItemHref(a) {
  if (a.target === 'event') return `/events/${a.ref}`;
  if (a.target === 'shift') return `/events/shift/${a.ref}`;
  if (a.target === 'proposal') return `/proposals/${a.ref}`;
  return null;
}

const EMPTY_STATS = {
  filters: { from: null, to: null, basis: 'booked' },
  money: { basis: 'booked', value: 0, priorValue: null, deltaPct: null, outstanding: 0, outstandingPrior: null, outstandingDeltaPct: null },
  funnel: {
    sent: { count: 0, value: 0 }, accepted: { count: 0, value: 0 },
    winRate: { sentCohort: 0, acceptedFromCohort: 0, pending: 0, pct: null },
    timeToAcceptMedianDays: null, lostValue: 0, pipelineOutstanding: { count: 0, value: 0 },
  },
  revenue: [], pipeline: [],
};

const LENS_LABEL = { booked: 'Booked', scheduled: 'Scheduled', paid: 'Paid' };

function Delta({ pct }) {
  if (pct == null) return null;
  const up = pct >= 0;
  return (
    <span className="tiny" style={{ color: up ? 'hsl(var(--ok-h) var(--ok-s) 45%)' : 'hsl(var(--danger-h) var(--danger-s) 55%)' }}>
      {up ? '▲' : '▼'} {Math.abs(pct)}% vs prior
    </span>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const filter = useMetricsFilter();
  const { from, to, basis, includeCc } = filter;

  const [stats, setStats] = useState(EMPTY_STATS);
  const [shifts, setShifts] = useState([]);
  const [proposals, setProposals] = useState([]);
  const [applications, setApplications] = useState([]);
  const [loading, setLoading] = useState(true);

  // Analytics zone — refetches on filter change.
  useEffect(() => {
    const params = { basis };
    if (from && to) { params.from = from; params.to = to; }
    if (includeCc && includeCc !== 'all') params.include_cc = includeCc;
    api.get('/proposals/dashboard-stats', { params })
      .then(r => setStats(r.data || EMPTY_STATS))
      .catch(() => toast.error('Dashboard metrics failed to load. Try refreshing.'));
  }, [from, to, basis, includeCc, toast]);

  // Operational zone — exempt from the filter, loads once.
  useEffect(() => {
    let anyFailed = false;
    Promise.all([
      api.get('/shifts').then(r => r.data).catch(() => { anyFailed = true; return []; }),
      api.get('/proposals').then(r => r.data).catch(() => { anyFailed = true; return []; }),
      // /admin/applications is admin-only (the Hiring surface is adminOnly). A
      // manager would 403 here on every dashboard load and trip the role_denial
      // security audit (Sentry DRBARTENDER-SERVER-R), so only admins fetch it;
      // managers simply show no applications card.
      isAdmin
        ? api.get('/admin/applications').then(r => r.data).catch(() => { anyFailed = true; return { applications: [] }; })
        : Promise.resolve({ applications: [] }),
    ]).then(([s, p, a]) => {
      setShifts(s || []);
      setProposals(p || []);
      setApplications(a?.applications || a || []);
      if (anyFailed) toast.error('Some dashboard data failed to load. Try refreshing.');
    }).finally(() => setLoading(false));
  }, [toast, isAdmin]);

  const upcoming = useMemo(() =>
    shifts.filter(e => e.event_date && dayDiff(e.event_date.slice(0, 10)) >= 0)
      .sort((a, b) => a.event_date.localeCompare(b.event_date)), [shifts]);
  const unstaffed = useMemo(() =>
    upcoming.filter(e => approvedCount(e) < parsePositionsCount(e)), [upcoming]);
  const newApplications = useMemo(() =>
    Array.isArray(applications) ? applications.filter(a => a.onboarding_status === 'applied').length : 0, [applications]);

  const actionQueue = useMemo(() => {
    const items = [];
    unstaffed.slice(0, 3).forEach(e => {
      const open = parsePositionsCount(e) - approvedCount(e);
      const days = dayDiff(e.event_date.slice(0, 10));
      items.push({
        id: 'unstaffed-' + e.id, type: 'unstaffed', priority: days < 7 ? 'danger' : 'warn',
        title: `${e.client_name || 'Event'} needs ${open} ${open === 1 ? 'bartender' : 'bartenders'}`,
        sub: `${getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })} · ${fmtDate(e.event_date.slice(0, 10))} · ${days}d out`,
        meta: `${open} open`, target: e.proposal_id ? 'event' : 'shift', ref: e.proposal_id || e.id,
      });
    });
    proposals.filter(p => ['sent', 'viewed', 'modified'].includes(p.status)).slice(0, 2).forEach(p => {
      items.push({
        id: 'prop-' + p.id, type: 'proposal', priority: 'info',
        title: `${p.client_name || p.client_email} proposal — ${p.status}`,
        sub: getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom }),
        meta: fmt$(Number(p.total_price || 0)), target: 'proposal', ref: p.id,
      });
    });
    if (newApplications > 0) {
      items.push({
        id: 'apps', type: 'application', priority: 'info',
        title: `${newApplications} new ${newApplications === 1 ? 'application' : 'applications'}`,
        sub: 'Review in hiring', meta: `${newApplications} new`, target: 'hiring', ref: null,
      });
    }
    return items;
  }, [unstaffed, proposals, newApplications]);

  const m = stats.money || EMPTY_STATS.money;
  const fn = stats.funnel || EMPTY_STATS.funnel;
  const pipeline = stats.pipeline || [];
  const maxPipelineValue = Math.max(1, ...pipeline.map(p => Number(p.value || 0)));
  const wr = fn.winRate || EMPTY_STATS.funnel.winRate;

  if (loading) {
    return <div className="page"><div className="muted">Loading dashboard…</div></div>;
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

      <MetricsFilterBar filter={filter} />

      {/* Money zone — driven by the lens toggle */}
      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat" onClick={() => navigate('/financials')}>
          <div className="stat-label">{LENS_LABEL[m.basis]}</div>
          <div className="stat-value">{fmt$(m.value)}</div>
          <div className="stat-sub"><Delta pct={m.deltaPct} /></div>
        </div>
        <div className="stat" onClick={() => navigate('/financials')}>
          <div className="stat-label">Outstanding</div>
          <div className="stat-value" style={{ color: m.outstanding > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>
            {fmt$(m.outstanding)}
          </div>
          <div className="stat-sub"><Delta pct={m.outstandingDeltaPct} /></div>
        </div>
        <div className="stat">
          <div className="stat-label">Sent</div>
          <div className="stat-value">{fn.sent.count}</div>
          <div className="stat-sub"><span>{fmt$(fn.sent.value)} quoted</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Accepted</div>
          <div className="stat-value">{fn.accepted.count}</div>
          <div className="stat-sub"><span>{fmt$(fn.accepted.value)} won</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Win rate</div>
          <div className="stat-value">{wr.pct == null ? '—' : `${wr.pct}%`}</div>
          <div className="stat-sub">
            <span>{wr.acceptedFromCohort} of {wr.sentCohort} sent · {wr.pending} pending</span>
          </div>
        </div>
      </div>

      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">Time to accept</div>
          <div className="stat-value">
            {fn.timeToAcceptMedianDays == null ? '—' : `${fn.timeToAcceptMedianDays}d`}
          </div>
          <div className="stat-sub"><span>median, accepted in range</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Pipeline <span className="k">Live</span></div>
          <div className="stat-value">{fn.pipelineOutstanding.count}</div>
          <div className="stat-sub"><span>{fmt$(fn.pipelineOutstanding.value)} in flight</span></div>
        </div>
        <div className="stat">
          <div className="stat-label">Lost</div>
          <div className="stat-value" style={{ color: fn.lostValue > 0 ? 'hsl(var(--danger-h) var(--danger-s) 55%)' : '' }}>
            {fmt$(fn.lostValue)}
          </div>
          <div className="stat-sub"><span>quoted, did not book</span></div>
        </div>
      </div>

      <div className="dash-main">
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          <div className="card">
            <div className="card-head">
              <div className="hstack">
                <h3>Revenue</h3>
                <span className="k">{LENS_LABEL[m.basis]} by month</span>
              </div>
              <div className="hstack" style={{ gap: 14 }}>
                <span className="hstack tiny muted" style={{ gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--accent)' }} />{LENS_LABEL[m.basis]}
                </span>
                <span className="hstack tiny muted" style={{ gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: 'hsl(var(--ok-h) var(--ok-s) 52%)' }} />Collected
                </span>
              </div>
            </div>
            <div className="card-body">
              {(stats.revenue || []).length === 0
                ? <div className="muted tiny" style={{ padding: '2rem 0', textAlign: 'center' }}>No revenue in this range.</div>
                : <AreaChart data={stats.revenue} keys={['value', 'paid']} />}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Upcoming events <span className="k">Live</span></h3>
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
                      <ClickableRow key={e.id} to={eventRoute(e)}>
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
                      </ClickableRow>
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
              <h3><Icon name="alert" size={12} /> Needs attention <span className="k">Live</span></h3>
              <span className="k">{actionQueue.length}</span>
            </div>
            <div>
              {actionQueue.length === 0 && (
                <div className="muted tiny" style={{ padding: '0.75rem 1rem' }}>Nothing pressing right now.</div>
              )}
              {actionQueue.map(a => (
                <div key={a.id} className="queue-item"
                  onClick={() => {
                    if (a.target === 'event') navigate(`/events/${a.ref}`);
                    else if (a.target === 'shift') navigate(`/events/shift/${a.ref}`);
                    else if (a.target === 'proposal') navigate(`/proposals/${a.ref}`);
                    else if (a.target === 'hiring') navigate('/hiring');
                  }}
                  role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.click(); }}>
                  <div className={`queue-icon ${a.priority}`}>
                    <Icon name={a.type === 'unstaffed' ? 'userplus' : a.type === 'proposal' ? 'eye' : a.type === 'application' ? 'pen' : 'alert'} />
                  </div>
                  <div className="queue-main">
                    <div className="queue-title">
                      <EntityLink to={queueItemHref(a)} onClick={(e) => e.stopPropagation()}>{a.title}</EntityLink>
                    </div>
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
              {pipeline.length === 0 && <div className="muted tiny">No active proposals.</div>}
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
