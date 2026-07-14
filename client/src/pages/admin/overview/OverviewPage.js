import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useAuth } from '../../../context/AuthContext';
import Icon from '../../../components/adminos/Icon';
import MetricsFilterBar from '../../../components/adminos/MetricsFilterBar';
import useMetricsFilter from '../../../hooks/useMetricsFilter';
import useUrlListState from '../../../hooks/useUrlListState';
import { dayDiff } from '../../../components/adminos/format';
import { parsePositionsCount, approvedCount } from '../../../components/adminos/shifts';
import StripePayoutsTab from '../StripePayoutsTab';
import NeedsYouStrip from './NeedsYouStrip';
import { buildPrepItems } from './PrepQueue';
import {
  buildStaffingItems, buildClientItems, buildSalesItems, buildMoneyItems, computeTabs,
} from './queueItems';
import PipelineCard from './PipelineCard';
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
  // Payroll-overdue flag reported up by the admin-only PayrollStatus block
  // (via NeedsYouStrip). A manager never mounts the block, so this stays
  // false: it feeds the Money tab's danger dot, not an item.
  const [payrollOverdue, setPayrollOverdue] = useState(false);

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
  const [drinkPlansLoading, setDrinkPlansLoading] = useState(true);
  const [payoutsLoading, setPayoutsLoading] = useState(true);
  const [changeRequests, setChangeRequests] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(true);

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
      .catch(() => {}) // badge is best-effort; the tab itself surfaces errors
      .finally(() => setPayoutsLoading(false));
  }, []);

  // Operational fetches — each isolated, no shared loading gate.
  useEffect(() => {
    let cancelled = false;
    setShiftsLoading(true);
    api.get('/shifts')
      .then(r => { if (!cancelled) setShifts(r.data || []); })
      .catch(() => {}) // unstaffed queue items simply stay absent
      .finally(() => { if (!cancelled) setShiftsLoading(false); });

    // limit=200 (the route's cap): the default newest-50 window drops the
    // OLDEST still-sent proposals, which is exactly what sales aging surfaces.
    setProposalsLoading(true);
    api.get('/proposals', { params: { limit: 200 } })
      .then(r => { if (!cancelled) setProposals(r.data || []); })
      .catch(() => {}) // proposal-derived queue items simply stay absent
      .finally(() => { if (!cancelled) setProposalsLoading(false); });

    // Clients tab sources (admin+manager). One shared loading flag so the
    // card's collapsed state can't flash before these resolve; either failing
    // just means those items stay absent.
    setClientsLoading(true);
    Promise.allSettled([
      api.get('/proposals/change-requests', { params: { status: 'pending' } }),
      api.get('/sms/conversations'),
    ]).then(([crRes, smsRes]) => {
      if (cancelled) return;
      if (crRes.status === 'fulfilled') setChangeRequests(crRes.value.data?.requests || []);
      if (smsRes.status === 'fulfilled') setConversations(Array.isArray(smsRes.value.data) ? smsRes.value.data : []);
      setClientsLoading(false);
    });

    // Prep pipeline: the Potions-enriched drink-plans list (admin+manager).
    // Isolated like the rest: a failure just means no prep pills or items.
    setDrinkPlansLoading(true);
    api.get('/drink-plans?limit=200')
      .then(r => { if (!cancelled) setDrinkPlans(Array.isArray(r.data) ? r.data : []); })
      .catch(() => {}) // prep items simply stay absent
      .finally(() => { if (!cancelled) setDrinkPlansLoading(false); });

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

  // Tab assembly (spec 2026-07-14 §2): pure builders over the fetched state.
  // The old un-aged proposal followups are gone by design; only sent-unviewed
  // past 72h survives, as the conditional Sales tab.
  const staffingItems = useMemo(() => buildStaffingItems(unstaffed, newApplications), [unstaffed, newApplications]);
  const prepItems = useMemo(() => buildPrepItems(drinkPlans), [drinkPlans]);
  const clientItems = useMemo(() => buildClientItems(changeRequests, conversations), [changeRequests, conversations]);
  const salesItems = useMemo(() => buildSalesItems(proposals, Date.now()), [proposals]);
  const moneyItems = useMemo(() => buildMoneyItems(payoutBadge), [payoutBadge]);
  const tabs = useMemo(
    () => computeTabs({ staffing: staffingItems, prep: prepItems, clients: clientItems, money: moneyItems, sales: salesItems, payrollOverdue, isAdmin }),
    [staffingItems, prepItems, clientItems, moneyItems, salesItems, payrollOverdue, isAdmin]
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

      {/* Band 1 — live zone (ignores the metrics filter). One row: the tabbed
          Needs-attention card (payroll status absorbed as the Money tab body,
          admin-only per spec §1 role gating) beside Pipeline. */}
      <div className="ov-band1">
        {/* Every item source gates `loading` so the terminal collapsed state
            can never flash and then expand as a late fetch lands. */}
        <NeedsYouStrip tabs={tabs}
          loading={shiftsLoading || proposalsLoading || clientsLoading || drinkPlansLoading || payoutsLoading}
          isAdmin={isAdmin} onPayrollOverdue={setPayrollOverdue} />
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
