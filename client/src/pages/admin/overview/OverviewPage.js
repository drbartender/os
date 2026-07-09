import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useAuth } from '../../../context/AuthContext';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import Icon from '../../../components/adminos/Icon';
import AreaChart from '../../../components/adminos/AreaChart';
import MetricsFilterBar from '../../../components/adminos/MetricsFilterBar';
import useMetricsFilter from '../../../hooks/useMetricsFilter';
import useUrlListState from '../../../hooks/useUrlListState';
import { fmt$, fmtDate, dayDiff } from '../../../components/adminos/format';
import { parsePositionsCount, approvedCount } from '../../../components/adminos/shifts';
import StripePayoutsTab from '../StripePayoutsTab';
import NeedsYouStrip from './NeedsYouStrip';
import UpcomingEventsCard from './UpcomingEventsCard';
import PipelineCard from './PipelineCard';

// Ledger-era boundary. b2 and b3 import eraOverlaps from here: era artifacts
// (cutover marker, list notes, expansion split-lines) render only when the
// selected range overlaps the frozen ledger. String compare on YYYY-MM-DD; a
// null `from` means All time, which overlaps.
const ERA_END = '2026-05-15';
export const eraOverlaps = (from) => !from || from < ERA_END;

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
const FIN_DEFAULTS = { tab: 'overview' };
const FIN_TABS = ['overview', 'payouts'];

function Delta({ pct }) {
  if (pct == null) return null;
  const up = pct >= 0;
  return (
    <span className="tiny" style={{ color: up ? 'hsl(var(--ok-h) var(--ok-s) 45%)' : 'hsl(var(--danger-h) var(--danger-s) 55%)' }}>
      {up ? '▲' : '▼'} {Math.abs(pct)}% vs prior
    </span>
  );
}

export default function OverviewPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const filter = useMetricsFilter();
  const { from, to, basis, includeCc } = filter;

  const [listState, setListState] = useUrlListState(FIN_DEFAULTS);
  const tab = FIN_TABS.includes(listState.tab) ? listState.tab : 'overview';
  const [payoutBadge, setPayoutBadge] = useState(0);

  // Band 2 (analysis) — obeys the filter bar. Its own error + retry; a failure
  // here never blanks Band 1.
  const [stats, setStats] = useState(EMPTY_STATS);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);

  // Band 1 (live) — ignores the filter. Each fetch degrades its own card.
  const [shifts, setShifts] = useState([]);
  const [shiftsLoading, setShiftsLoading] = useState(true);
  const [shiftsError, setShiftsError] = useState(false);
  const [proposals, setProposals] = useState([]);
  const [proposalsLoading, setProposalsLoading] = useState(true);
  const [applications, setApplications] = useState([]);

  const loadStats = useCallback(() => {
    const params = { basis };
    if (from && to) { params.from = from; params.to = to; }
    if (includeCc && includeCc !== 'all') params.include_cc = includeCc;
    setStatsLoading(true);
    setStatsError(false);
    api.get('/proposals/dashboard-stats', { params })
      .then(r => { setStats(r.data || EMPTY_STATS); setStatsLoaded(true); })
      .catch(() => { setStatsError(true); })
      .finally(() => { setStatsLoading(false); });
  }, [from, to, basis, includeCc]);

  useEffect(() => { loadStats(); }, [loadStats]);

  useEffect(() => {
    api.get('/stripe-payouts')
      .then(r => setPayoutBadge(r.data?.summary?.unmatched_count || 0))
      .catch(() => {}); // badge is best-effort; the tab itself surfaces errors
  }, []);

  // Operational fetches — each isolated, no shared loading gate.
  useEffect(() => {
    let cancelled = false;
    setShiftsLoading(true);
    setShiftsError(false);
    api.get('/shifts')
      .then(r => { if (!cancelled) setShifts(r.data || []); })
      .catch(() => { if (!cancelled) setShiftsError(true); })
      .finally(() => { if (!cancelled) setShiftsLoading(false); });

    setProposalsLoading(true);
    api.get('/proposals')
      .then(r => { if (!cancelled) setProposals(r.data || []); })
      .catch(() => {}) // proposal-derived queue items simply stay absent
      .finally(() => { if (!cancelled) setProposalsLoading(false); });

    // /admin/applications is admin-only (the Hiring surface is adminOnly). A
    // manager would 403 here on every dashboard load and trip the role_denial
    // security audit (Sentry DRBARTENDER-SERVER-R), so only admins fetch it;
    // managers simply show no applications card.
    if (isAdmin) {
      api.get('/admin/applications')
        .then(r => { if (!cancelled) setApplications(r.data?.applications || r.data || []); })
        .catch(() => {}); // applications queue items simply stay absent
    }
    return () => { cancelled = true; };
  }, [isAdmin]);

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
        title: `${p.client_name || p.client_email} proposal · ${p.status}`,
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
  const wr = fn.winRate || EMPTY_STATS.funnel.winRate;
  const pipeline = stats.pipeline || [];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Overview</div>
          <div className="page-subtitle">
            {upcoming.length} upcoming {upcoming.length === 1 ? 'event' : 'events'}
            {unstaffed.length > 0 && ` · ${unstaffed.length} need staff`}
          </div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => navigate('/proposals/new')}>
            <Icon name="plus" />New proposal
          </button>
        </div>
      </div>

      {/* Band 1 — live zone (ignores the metrics filter) */}
      <NeedsYouStrip items={actionQueue} loading={shiftsLoading || proposalsLoading} />
      <div className="dash-main">
        <UpcomingEventsCard upcoming={upcoming} loading={shiftsLoading} error={shiftsError} />
        <div className="vstack" style={{ gap: 'var(--gap)' }}>
          {/* PayrollCard slot arrives in lane c */}
          <PipelineCard pipeline={pipeline} loading={!statsLoaded && statsLoading} />
        </div>
      </div>

      {/* Band 2 — analysis zone (obeys the filter bar) */}
      <div className="overview-tabs" style={{ display: 'flex', gap: '0.5rem', margin: 'var(--gap) 0' }}>
        <button className={`btn btn-sm ${tab === 'overview' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setListState({ tab: 'overview' })}>Overview</button>
        <button className={`btn btn-sm ${tab === 'payouts' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setListState({ tab: 'payouts' })}>
          Payouts{payoutBadge > 0 ? ` (${payoutBadge} unmatched)` : ''}
        </button>
      </div>

      {tab === 'payouts' && <StripePayoutsTab />}

      {tab === 'overview' && (
        <>
          <MetricsFilterBar filter={filter} />

          {statsError ? (
            <div className="card">
              <div className="card-body vstack" style={{ gap: '0.75rem', alignItems: 'flex-start' }}>
                <div className="chip danger">Couldn't load metrics.</div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={loadStats}>Retry</button>
              </div>
            </div>
          ) : !statsLoaded ? (
            <div className="muted" style={{ padding: '1rem 0' }}>Loading…</div>
          ) : (
            <>
              {/* Money zone — driven by the lens toggle */}
              <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
                <div className="stat">
                  <div className="stat-label">{LENS_LABEL[m.basis]}</div>
                  <div className="stat-value">{fmt$(m.value)}</div>
                  <div className="stat-sub"><Delta pct={m.deltaPct} /></div>
                </div>
                <div className="stat">
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
            </>
          )}
        </>
      )}
    </div>
  );
}
