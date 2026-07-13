import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useAuth } from '../../../context/AuthContext';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import Icon from '../../../components/adminos/Icon';
import MetricsFilterBar from '../../../components/adminos/MetricsFilterBar';
import useMetricsFilter from '../../../hooks/useMetricsFilter';
import useUrlListState from '../../../hooks/useUrlListState';
import { fmt$, fmtDate, dayDiff } from '../../../components/adminos/format';
import { parsePositionsCount, approvedCount } from '../../../components/adminos/shifts';
import StripePayoutsTab from '../StripePayoutsTab';
import NeedsYouStrip from './NeedsYouStrip';
import { buildPrepItems } from './PrepQueue';
import PipelineCard from './PipelineCard';
import PayrollCard from './PayrollCard';
import MoneyTiles from './MoneyTiles';
import FunnelCard from './FunnelCard';
import LeadSpendCard from './LeadSpendCard';
import RangeTables from './RangeTables';
import RevenueChartCard from './RevenueChartCard';

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

// Financials LAW shape (spec §2). summary.booked/collected/outstanding/avgEvent
// are DOLLARS; unlinkedRefundsCents + leadSpend.*Cents are CENTS.
const EMPTY_FIN = {
  summary: {
    booked: 0, collected: 0, outstanding: 0, avgEvent: 0, unlinkedRefundsCents: 0,
    leadSpend: { totalCents: 0, attributedCents: 0, unattributedCents: 0, chargedLeads: 0, attributedLeads: 0 },
  },
  proposals: [], recentPayments: [],
};

const FIN_DEFAULTS = { tab: 'overview', show: '', split: '' };
const FIN_TABS = ['overview', 'payouts'];
// Funnel-card split lens. '' = None (existing funnel body). URL-backed via
// useUrlListState so a split is shareable/back-button-able.
const SPLIT_VALUES = ['source', 'event_type'];

export default function OverviewPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const filter = useMetricsFilter();
  const { from, to, basis, includeCc } = filter;

  const [listState, setListState] = useUrlListState(FIN_DEFAULTS);
  const tab = FIN_TABS.includes(listState.tab) ? listState.tab : 'overview';
  const split = SPLIT_VALUES.includes(listState.split) ? listState.split : '';
  const [payoutBadge, setPayoutBadge] = useState(0);
  // Payroll-overdue Needs-you item reported up by the admin-only PayrollCard.
  // A manager never mounts PayrollCard, so this stays null and no item appears.
  const [payrollItem, setPayrollItem] = useState(null);

  // Band 2 (analysis) — obeys the filter bar. The two LAW fetches (dashboard-stats
  // + financials) share ONE zone-level error + retry; a failure in either never
  // blanks Band 1. Per-zone loading, no page-level gate.
  const [stats, setStats] = useState(EMPTY_STATS);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(false);
  const [fin, setFin] = useState(EMPTY_FIN);
  const [finLoaded, setFinLoaded] = useState(false);
  const [finError, setFinError] = useState(false);

  // Band 1 (live) — ignores the filter. Each fetch degrades its own card.
  const [shifts, setShifts] = useState([]);
  const [shiftsLoading, setShiftsLoading] = useState(true);
  const [proposals, setProposals] = useState([]);
  const [proposalsLoading, setProposalsLoading] = useState(true);
  const [applications, setApplications] = useState([]);
  const [drinkPlans, setDrinkPlans] = useState([]);

  const band2Params = useCallback(() => {
    const params = { basis };
    if (from && to) { params.from = from; params.to = to; }
    if (includeCc && includeCc !== 'all') params.include_cc = includeCc;
    return params;
  }, [from, to, basis, includeCc]);

  const loadStats = useCallback(() => {
    setStatsLoading(true);
    setStatsError(false);
    api.get('/proposals/dashboard-stats', { params: band2Params() })
      .then(r => { setStats(r.data || EMPTY_STATS); setStatsLoaded(true); })
      .catch(() => { setStatsError(true); })
      .finally(() => { setStatsLoading(false); });
  }, [band2Params]);

  const loadFinancials = useCallback(() => {
    setFinError(false);
    api.get('/proposals/financials', { params: band2Params() })
      .then(r => { setFin(r.data || EMPTY_FIN); setFinLoaded(true); })
      .catch(() => { setFinError(true); });
  }, [band2Params]);

  const reloadBand2 = useCallback(() => { loadStats(); loadFinancials(); }, [loadStats, loadFinancials]);

  useEffect(() => { loadStats(); loadFinancials(); }, [loadStats, loadFinancials]);

  // Funnel-card split (lazy): only fetches when a split lens is active. Own
  // catch + cancelled flag, isolated from the two LAW fetches — a failure shows
  // a card-level error + retry and never blanks the funnel or the rest of Band 2.
  // Refetches on split / from / to change (and on an explicit retry nonce).
  const [splitData, setSplitData] = useState(null);
  const [splitLoading, setSplitLoading] = useState(false);
  const [splitError, setSplitError] = useState(false);
  const [splitNonce, setSplitNonce] = useState(0);
  const retrySplit = useCallback(() => setSplitNonce(n => n + 1), []);
  const onSplitChange = useCallback((next) => setListState({ split: next }), [setListState]);

  useEffect(() => {
    if (!split) { setSplitData(null); setSplitError(false); setSplitLoading(false); return undefined; }
    let cancelled = false;
    setSplitLoading(true);
    setSplitError(false);
    const params = { by: split };
    if (from && to) { params.from = from; params.to = to; }
    api.get('/proposals/metrics-split', { params })
      .then(r => { if (!cancelled) setSplitData(r.data || null); })
      .catch(() => { if (!cancelled) setSplitError(true); })
      .finally(() => { if (!cancelled) setSplitLoading(false); });
    return () => { cancelled = true; };
  }, [split, from, to, splitNonce]);

  const scrollToId = useCallback((id) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    api.get('/stripe-payouts')
      .then(r => setPayoutBadge(r.data?.summary?.unmatched_count || 0))
      .catch(() => {}); // badge is best-effort; the tab itself surfaces errors
  }, []);

  // Operational fetches — each isolated, no shared loading gate.
  useEffect(() => {
    let cancelled = false;
    setShiftsLoading(true);
    api.get('/shifts')
      .then(r => { if (!cancelled) setShifts(r.data || []); })
      .catch(() => {}) // unstaffed queue items simply stay absent
      .finally(() => { if (!cancelled) setShiftsLoading(false); });

    setProposalsLoading(true);
    api.get('/proposals')
      .then(r => { if (!cancelled) setProposals(r.data || []); })
      .catch(() => {}) // proposal-derived queue items simply stay absent
      .finally(() => { if (!cancelled) setProposalsLoading(false); });

    // Prep pipeline: the Potions-enriched drink-plans list (admin+manager).
    // Isolated like the rest: a failure just means no prep pills or items.
    api.get('/drink-plans?limit=200')
      .then(r => { if (!cancelled) setDrinkPlans(Array.isArray(r.data) ? r.data : []); })
      .catch(() => {}); // prep items simply stay absent

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

  // Payroll overdue is a money-urgency danger item; prepend it ahead of the
  // operational queue. Absent for managers (payrollItem is never set for them).
  // Unmatched payouts ride the same strip; the payouts route is
  // admin+manager, so this item is visible to both roles by design.
  const payoutsItem = useMemo(() => (payoutBadge > 0 ? {
    id: 'payouts-unmatched', type: 'payouts', priority: 'warn',
    title: `${payoutBadge} Stripe ${payoutBadge === 1 ? 'payout' : 'payouts'} unmatched`,
    sub: 'Settlement mirror', meta: String(payoutBadge), target: 'payouts', ref: null,
  } : null), [payoutBadge]);
  const prepItems = useMemo(() => buildPrepItems(drinkPlans), [drinkPlans]);
  const queueItems = useMemo(
    () => [payrollItem, payoutsItem, ...prepItems, ...actionQueue].filter(Boolean),
    [payrollItem, payoutsItem, prepItems, actionQueue]
  );

  const m = stats.money || EMPTY_STATS.money;
  const fn = stats.funnel || EMPTY_STATS.funnel;
  const pipeline = stats.pipeline || [];

  const band2Error = statsError || finError;
  const band2Ready = statsLoaded && finLoaded;

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
      <NeedsYouStrip items={queueItems} loading={shiftsLoading || proposalsLoading} />
      {/* Events card scrapped (Dallas, 2026-07-13): /events covers the week-ahead
          view. Prep queue items in the strip remain the prep surface. */}
      <div className="grid-2" style={{ marginBottom: 'var(--gap)' }}>
        {/* Payroll card is admin-only: managers mount nothing and fire zero
            /admin/payroll/* requests (spec §1 role gating). */}
        {isAdmin && <PayrollCard onOverdue={setPayrollItem} />}
        <PipelineCard pipeline={pipeline} loading={!statsLoaded && statsLoading} error={statsError} />
      </div>

      {/* Band 2 — analysis zone (obeys the filter bar) */}
      <div className="overview-tabs" style={{ display: 'flex', gap: '0.5rem', margin: 'var(--gap) 0' }}>
        <button className={`btn btn-sm ${tab === 'overview' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setListState({ tab: 'overview' })}>Overview</button>
        <button className={`btn btn-sm ${tab === 'payouts' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setListState(tab !== 'payouts' && payoutBadge > 0 ? { tab: 'payouts', show: 'unmatched' } : { tab: 'payouts' })}>
          Payouts{payoutBadge > 0 ? ` (${payoutBadge} unmatched)` : ''}
        </button>
      </div>

      {tab === 'payouts' && <StripePayoutsTab show={listState.show} onClearShow={() => setListState({ show: '' })} />}

      {tab === 'overview' && (
        <>
          <MetricsFilterBar filter={filter} />

          {band2Error ? (
            <div className="card">
              <div className="card-body vstack" style={{ gap: '0.75rem', alignItems: 'flex-start' }}>
                <div className="chip danger">Couldn't load metrics.</div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={reloadBand2}>Retry</button>
              </div>
            </div>
          ) : !band2Ready ? (
            <div className="muted" style={{ padding: '1rem 0' }}>Loading…</div>
          ) : (
            <>
              <MoneyTiles money={m} funnel={fn} summary={fin.summary} from={from} to={to} onScrollTo={scrollToId} />

              <RevenueChartCard data={stats.revenue || []} filter={filter} basis={m.basis} />

              <div className="grid-2" style={{ marginBottom: 'var(--gap)' }}>
                <FunnelCard
                  funnel={fn} from={from} to={to}
                  split={split} onSplitChange={onSplitChange}
                  splitData={splitData} splitLoading={splitLoading}
                  splitError={splitError} onRetrySplit={retrySplit}
                />
                <LeadSpendCard leadSpend={fin.summary.leadSpend} from={from} to={to} />
              </div>

              <RangeTables proposals={fin.proposals} payments={fin.recentPayments} summary={fin.summary} from={from} to={to} />
            </>
          )}
        </>
      )}
    </div>
  );
}
