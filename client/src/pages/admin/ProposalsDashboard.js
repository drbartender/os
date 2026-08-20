import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel, EVENT_TYPES } from '../../utils/eventTypes';
import { presetRange } from '../../hooks/useMetricsFilter';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import Toolbar from '../../components/adminos/Toolbar';
import SortableTh from '../../components/adminos/SortableTh';
import { fmt$, fmtDate, relDay } from '../../components/adminos/format';
import ClickableRow from '../../components/ClickableRow';
import SourceBadge from '../../components/admin/SourceBadge';
import EntityLink from '../../components/EntityLink';
import useUrlListState from '../../hooks/useUrlListState';
import { proposalStatusMeta } from '../../utils/proposalStatusMap';

const TAB_IDS = ['active', 'draft', 'won', 'paid', 'archive', 'all'];
const SOURCE_IDS = ['thumbtack', 'manual'];
const AXIS_IDS = ['event', 'sent'];
const COHORT_IDS = ['quoted', 'won', 'lost'];
// Tab → server status/view bucket, as objects (not query strings) so the fetch
// composes them with the new filter params without emitting a duplicate `status`
// key. status chips and cohort supersede this bucket in the query builder.
const TAB_TO_PARAMS = {
  active:  { view: 'active' },
  draft:   { status: 'draft' },
  won:     { status: 'accepted' },
  paid:    { view: 'paid' },
  archive: { view: 'archive' },
  all:     { view: 'all' },
};
const PRESET_KEYS = ['this-month', 'last-month', 'this-quarter', 'ytd', 'last-12'];
const PRESET_CHIPS = [
  ['this-month', 'This month'], ['last-month', 'Last month'], ['this-quarter', 'Quarter'],
  ['ytd', 'YTD'], ['last-12', 'Last 12'], ['all', 'All'], ['custom', 'Custom'],
];
const STATUS_CHIPS = [['sent', 'Sent'], ['viewed', 'Viewed'], ['modified', 'Modified']];
const COHORT_LABELS = { quoted: 'Quoted', won: 'Won', lost: 'Lost' };
// Human labels for the archive_reason bucket, shown under the status chip on an
// archived row so the Archived shelf distinguishes no-hire from a cancellation.
const ARCHIVE_REASON_LABELS = {
  no_hire: 'No hire',
  client_cancelled: 'Client cancelled',
  we_cancelled: 'We cancelled',
  event_completed: 'Event completed',
  option_not_chosen: 'Option not chosen',
  event_passed: 'Event passed',
  other: 'Other',
};
// Server page size, sent explicitly as `limit` rather than leaning on the
// server's default also being 50 (list.js clamps to [1,200], default 50). If the
// two ever disagree, pageCount below is silently wrong with no error anywhere.
const PAGE_SIZE = 50;
// View state lives in the URL (admin cross-nav): every control writes through
// setListState so drill-outs are plain links and Back restores the filters.
// `page` is URL state too, so a refresh, or a drill-out and Back, lands on the
// page you were on rather than snapping to the top of the list.
const LIST_DEFAULTS = { tab: 'active', q: '', source: '', from: '', to: '', axis: 'event', status: '', event_type: '', balance: '', cohort: '', page: '1' };

export default function ProposalsDashboard() {
  const navigate = useNavigate();
  const toast = useToast();

  const [proposals, setProposals] = useState([]);
  // Server-side total for the current bucket (from the X-Total-Count header).
  // The list itself is capped at the server page size (default 50), so `total`
  // can exceed proposals.length — that's how we know more rows exist.
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ active: 0, draft: 0, accepted: 0, paid: 0, archived: 0 });
  const [loading, setLoading] = useState(true);
  // Distinguishes "the fetch failed" from "this filter genuinely matches nothing".
  // Both leave the table empty, and only one of them is worth retrying.
  const [loadError, setLoadError] = useState(false);
  const [listState, setListState] = useUrlListState(LIST_DEFAULTS);
  const tab = TAB_IDS.includes(listState.tab) ? listState.tab : 'active';
  const sourceFilter = SOURCE_IDS.includes(listState.source) ? listState.source : '';
  const axis = AXIS_IDS.includes(listState.axis) ? listState.axis : 'event';
  const cohort = COHORT_IDS.includes(listState.cohort) ? listState.cohort : '';
  const page = Math.max(1, parseInt(listState.page, 10) || 1);
  // total is the unpaginated count from X-Total-Count. Floored at 1 so an empty
  // result reads "Page 1 of 1" rather than "of 0".
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // What the pager DISPLAYS and steps from. `page` still drives the query (the
  // guard below is what corrects it); clamping here keeps the one render before
  // that guard fires coherent, so an out-of-range ?page never paints "Page 99 of
  // 5" or offers a Prev that steps to 98.
  const safePage = Math.min(page, pageCount);
  // Every filter/tab/sort write goes through setFilters, never setListState
  // directly: changing the filtered set while sitting on page 4 would otherwise
  // drop you on an empty table. The pager buttons and the stale-page guard are
  // the only legitimate writers of `page`.
  const setFilters = useCallback((patch) => setListState({ ...patch, page: '1' }), [setListState]);
  const [copyMessage, setCopyMessage] = useState('');
  // Custom-range date inputs reveal on the Custom chip (or off-preset URL dates).
  const [showCustom, setShowCustom] = useState(false);
  // Ephemeral sort (not URL-persisted): null = server default (created_at desc);
  // reverts to default on navigation. Drives server-side sort/dir params because
  // the list is paginated (50/tab) — client-side would only reorder the page.
  const [sort, setSort] = useState(null);
  const onSort = useCallback((key) => {
    setSort(prev => (prev && prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' }));
    // Re-sorting reorders the whole filtered set server-side, so page 4 of the
    // old order means nothing in the new one.
    setListState({ page: '1' });
  }, [setListState]);

  // Compose the server query from URL-truth listState. Precedence mirrors the
  // server: cohort supersedes everything; else status chips (a CSV) override the
  // tab bucket exactly as the server's `status` param overrides `view`; else the
  // tab's own bucket. Date / axis / event_type / balance layer on top.
  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (cohort) {
      p.set('cohort', cohort);
    } else if (listState.status) {
      p.set('status', listState.status);
    } else {
      Object.entries(TAB_TO_PARAMS[tab] || TAB_TO_PARAMS.active).forEach(([k, v]) => p.set(k, v));
    }
    if (sourceFilter) p.set('source', sourceFilter);
    if (listState.q) p.set('search', listState.q);
    if (listState.from) p.set('from', listState.from);
    if (listState.to) p.set('to', listState.to);
    if (axis === 'sent') p.set('axis', 'sent');
    if (listState.event_type) p.set('event_type', listState.event_type);
    if (listState.balance === 'open') p.set('balance', 'open');
    // Ephemeral sort → server params. Whitelisted server-side (list.js SORT_COLUMNS);
    // absent = server default (created_at desc).
    if (sort) { p.set('sort', sort.key); p.set('dir', sort.dir); }
    p.set('limit', String(PAGE_SIZE));
    if (page > 1) p.set('page', String(page));
    return p.toString();
  }, [cohort, listState.status, listState.q, listState.from, listState.to,
    listState.event_type, listState.balance, axis, sourceFilter, tab, sort, page]);

  // Tab counts come from /dashboard-stats, re-fetched when the source filter
  // changes so the counts stay consistent with the filtered list. Failing the
  // stats request leaves counts at zero (graceful degradation — tabs still
  // work, just without the count badge).
  useEffect(() => {
    const qs = sourceFilter ? `?source=${sourceFilter}` : '';
    api.get(`/proposals/dashboard-stats${qs}`)
      .then(r => {
        const pipeByKey = Object.fromEntries((r.data?.pipeline || []).map(p => [p.key, p.count]));
        setCounts({
          active:   (pipeByKey.sent || 0) + (pipeByKey.viewed || 0) + (pipeByKey.modified || 0),
          draft:    pipeByKey.draft || 0,
          accepted: pipeByKey.accepted || 0,
          paid:     r.data?.paidCount || 0,
          archived: r.data?.archivedCount || 0,
        });
      })
      .catch(() => { /* leave counts at zero — graceful degradation */ });
  }, [sourceFilter]);

  // The latest query owns the screen. Responses are not guaranteed to resolve
  // in request order: a slow page-2 response landing after a fast new-filter
  // response would otherwise overwrite the newer list (and its total) with the
  // previous query's rows, under controls that say otherwise (push-review
  // 2026-08-13, codex). Every state write below checks it still owns the slot.
  const activeQuery = useRef(null);
  const fetchProposals = useCallback(async () => {
    activeQuery.current = queryString;
    setLoading(true);
    try {
      const list = await api.get(`/proposals?${queryString}`);
      if (activeQuery.current !== queryString) return; // superseded mid-flight
      const rows = list.data || [];
      setProposals(rows);
      // X-Total-Count is the unpaginated total for this filtered set. Fall back to
      // the number of rows we actually got if the header is missing (older server).
      const headerTotal = Number(list.headers?.['x-total-count']);
      setTotal(Number.isFinite(headerTotal) ? headerTotal : rows.length);
      setLoadError(false);
    } catch (err) {
      if (activeQuery.current !== queryString) return; // superseded mid-flight
      console.error('Failed to fetch proposals:', err);
      toast.error('Failed to load proposals. Try refreshing.');
      // Drop the previous query's rows and total rather than leaving them under
      // the new page's controls. A failed page-2 fetch used to keep page 1's
      // rows on screen captioned "Page 2 of 5", which reads as data rather than
      // as a failure. We do not know the counts after a failure, so we claim
      // none: the table shows the error, and the pager hides until a load wins.
      setProposals([]);
      setTotal(0);
      setLoadError(true);
    } finally {
      // A superseded call must not clear the newer call's loading state.
      if (activeQuery.current === queryString) setLoading(false);
    }
  }, [toast, queryString]);

  useEffect(() => { fetchProposals(); }, [fetchProposals]);

  // Stale page: archive a proposal while sitting on the last page, refresh, and
  // the server hands back an empty page for a page that no longer exists. Snap
  // to the last page that does. Gated on total > 0 so a genuinely empty filter
  // result is left alone, and it terminates because it only ever DECREASES page
  // (to pageCount, which is floored at 1) and the predicate is false afterward.
  //
  // INVARIANT this depends on: `page` can never exceed the CURRENT query's
  // pageCount by more than a stale render. `total` is not keyed to the query
  // that produced it, so on the render where page changes this can briefly see
  // the previous query's total. That is harmless only because nothing can push
  // page above the live ceiling: Next is disabled at pageCount, every filter and
  // sort write goes through setFilters (page := 1), a cold load has total 0, and
  // useUrlListState writes with replace:true so history cannot restore a foreign
  // filter+page pair. Any NEW control that writes `page` directly must preserve
  // that, or this guard needs to key off the queryString that produced `total`.
  useEffect(() => {
    if (!loading && total > 0 && page > pageCount) {
      setListState({ page: String(pageCount) });
    }
  }, [loading, total, page, pageCount, setListState]);

  // Paging keeps your scroll position at the bottom of the table otherwise,
  // where the pager lives, so the new page's first rows open off-screen above.
  const goToPage = useCallback((n) => {
    setListState({ page: String(n) });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [setListState]);

  const copyLink = (e, token) => {
    e.stopPropagation();
    if (!token) return;
    const url = `${PUBLIC_SITE_URL}/proposal/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage(token);
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  // Option-group rollup: siblings sharing a non-null group_id collapse into one
  // row (first/newest member represents the set; _optionCount drives the badge).
  // Rows with group_id null stay individual — never collapse the nulls together.
  const rows = useMemo(() => {
    const counts = new Map();
    proposals.forEach(p => {
      if (p.group_id != null) counts.set(p.group_id, (counts.get(p.group_id) || 0) + 1);
    });
    const seen = new Set();
    return proposals
      .filter(p => {
        if (p.group_id == null) return true;
        if (seen.has(p.group_id)) return false;
        seen.add(p.group_id);
        return true;
      })
      .map(p => (p.group_id != null && counts.get(p.group_id) > 1
        ? { ...p, _optionCount: counts.get(p.group_id) }
        : p));
  }, [proposals]);

  const tabs = useMemo(() => ([
    { id: 'active',  label: 'Active',   count: counts.active },
    { id: 'draft',   label: 'Draft',    count: counts.draft },
    { id: 'won',     label: 'Accepted', count: counts.accepted },
    { id: 'paid',    label: 'Paid',     count: counts.paid },
    { id: 'archive', label: 'Archived', count: counts.archived },
    { id: 'all',     label: 'All' },
  ]), [counts]);

  // Which preset chip the current from/to matches (all = no dates; custom = an
  // off-preset URL range). All range math is America/Chicago via presetRange.
  const activePreset = useMemo(() => {
    if (!listState.from && !listState.to) return 'all';
    for (const key of PRESET_KEYS) {
      const r = presetRange(key);
      if (r.from === listState.from && r.to === listState.to) return key;
    }
    return 'custom';
  }, [listState.from, listState.to]);

  const statusSet = useMemo(
    () => new Set((listState.status || '').split(',').filter(Boolean)),
    [listState.status]
  );

  const anyFilterActive = Boolean(
    listState.from || listState.to || cohort || listState.status ||
    listState.event_type || listState.balance || sourceFilter ||
    listState.q || axis !== 'event'
  );

  const applyPreset = (key) => {
    if (key === 'all') { setShowCustom(false); setFilters({ from: '', to: '' }); return; }
    if (key === 'custom') {
      setShowCustom(true);
      if (!listState.from || !listState.to) {
        const seed = presetRange('last-12');
        setFilters({ from: seed.from, to: seed.to });
      }
      return;
    }
    setShowCustom(false);
    const r = presetRange(key);
    setFilters({ from: r.from, to: r.to });
  };
  const presetActive = (key) => (showCustom
    ? key === 'custom'
    : (key === 'custom' ? activePreset === 'custom' : activePreset === key));

  const toggleStatus = (s) => {
    const next = new Set(statusSet);
    if (next.has(s)) next.delete(s); else next.add(s);
    setFilters({ status: [...next].join(',') });
  };

  const clearFilters = () => { setShowCustom(false); setFilters(LIST_DEFAULTS); };

  const cohortRange = (listState.from && listState.to)
    ? ` · ${fmtDate(listState.from)} to ${fmtDate(listState.to)}`
    : '';

  // Paid statuses surface a "View event" jump-link so admins can move from a
  // paid proposal straight into its EventDetailPage (where shifts/staffing live).
  const isPaidStatus = (status) => ['deposit_paid', 'balance_paid', 'confirmed', 'completed'].includes(status);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Proposals</div>
          <div className="page-subtitle">Quotes out the door. Track which are sent, viewed, and accepted.</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => navigate('/proposals/new')}>
            <Icon name="plus" />New proposal
          </button>
        </div>
      </div>

      <Toolbar tabs={tabs} tab={tab} setTab={(t) => setFilters({ tab: t })} />

      <div className="hstack" style={{ gap: 8, marginBottom: 12 }}>
        <label className="tiny muted" htmlFor="source-filter">Source</label>
        <select
          id="source-filter"
          className="input"
          style={{ maxWidth: 200 }}
          value={sourceFilter}
          onChange={(e) => setFilters({ source: e.target.value })}
        >
          <option value="">All sources</option>
          <option value="thumbtack">Thumbtack</option>
          <option value="manual">Manual / Direct</option>
        </select>
      </div>

      <div className="ov-filter-row">
        <div className="metrics-seg" role="group" aria-label="Date range">
          {PRESET_CHIPS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`metrics-seg-btn${presetActive(key) ? ' is-active' : ''}`}
              aria-pressed={presetActive(key)}
              onClick={() => applyPreset(key)}
            >
              {label}
            </button>
          ))}
        </div>

        {(showCustom || activePreset === 'custom') && (
          <>
            <input
              type="date"
              className="input"
              aria-label="From date"
              value={listState.from || ''}
              max={listState.to || undefined}
              onChange={(e) => setFilters({ from: e.target.value })}
            />
            <span className="muted tiny">to</span>
            <input
              type="date"
              className="input"
              aria-label="To date"
              value={listState.to || ''}
              min={listState.from || undefined}
              onChange={(e) => setFilters({ to: e.target.value })}
            />
          </>
        )}

        <div className="metrics-seg" role="group" aria-label="Date axis">
          <button
            type="button"
            className={`metrics-seg-btn${axis === 'event' ? ' is-active' : ''}`}
            aria-pressed={axis === 'event'}
            onClick={() => setFilters({ axis: 'event' })}
          >
            Event date
          </button>
          <button
            type="button"
            className={`metrics-seg-btn${axis === 'sent' ? ' is-active' : ''}`}
            aria-pressed={axis === 'sent'}
            onClick={() => setFilters({ axis: 'sent' })}
          >
            Sent
          </button>
        </div>

        <div className="metrics-seg" role="group" aria-label="Status">
          {STATUS_CHIPS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`metrics-seg-btn${statusSet.has(key) ? ' is-active' : ''}`}
              aria-pressed={statusSet.has(key)}
              onClick={() => toggleStatus(key)}
            >
              {label}
            </button>
          ))}
        </div>

        <select
          className="input"
          style={{ maxWidth: 200 }}
          aria-label="Event type"
          value={listState.event_type}
          onChange={(e) => setFilters({ event_type: e.target.value })}
        >
          <option value="">All event types</option>
          {EVENT_TYPES.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>

        <div className="metrics-seg" role="group" aria-label="Balance">
          <button
            type="button"
            className={`metrics-seg-btn${listState.balance === 'open' ? ' is-active' : ''}`}
            aria-pressed={listState.balance === 'open'}
            onClick={() => setFilters({ balance: listState.balance === 'open' ? '' : 'open' })}
          >
            Open balance
          </button>
        </div>
      </div>

      {cohort && (
        <div className="ov-cohort-note">
          <span>{COHORT_LABELS[cohort]} cohort{cohortRange}</span>
          <button type="button" aria-label="Clear cohort" onClick={() => setFilters({ cohort: '' })}>
            &times;
          </button>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <SortableTh label="Client" sortKey="client" sort={sort} onSort={onSort} />
                <SortableTh label="Event" sortKey="event" sort={sort} onSort={onSort} />
                <SortableTh label="Event date" sortKey="event_date" sort={sort} onSort={onSort} />
                <SortableTh label="Package" sortKey="package" sort={sort} onSort={onSort} />
                <SortableTh label="Status" sortKey="status" sort={sort} onSort={onSort} />
                <SortableTh label="Sent" sortKey="sent" sort={sort} onSort={onSort} />
                <SortableTh label="Last viewed" sortKey="last_viewed" sort={sort} onSort={onSort} />
                <SortableTh label="Total" sortKey="total" sort={sort} onSort={onSort} className="num" />
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="muted">Loading…</td></tr>
              )}
              {!loading && loadError && (
                <tr>
                  <td colSpan={9} className="muted">
                    Could not load proposals
                    {' · '}
                    <button type="button" className="btn-ghost" onClick={fetchProposals}>Try again</button>
                  </td>
                </tr>
              )}
              {!loading && !loadError && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="muted">
                    No proposals match these filters
                    {anyFilterActive && (
                      <>
                        {' · '}
                        <button type="button" className="btn-ghost" onClick={clearFilters}>Clear filters</button>
                      </>
                    )}
                  </td>
                </tr>
              )}
              {!loading && rows.map(p => {
                const st = proposalStatusMeta(p.status);
                const viewTitle = p.last_viewed_at
                  ? `Last viewed ${new Date(p.last_viewed_at).toLocaleString('en-US', { hour12: false })}${p.view_count ? ` · ${p.view_count} view${Number(p.view_count) === 1 ? '' : 's'}` : ''}`
                  : undefined;
                return (
                  <ClickableRow key={p.id} to={`/proposals/${p.id}`}>
                    <td>
                      <EntityLink to={p.client_id ? `/clients/${p.client_id}` : null}><strong>{p.client_name || '—'}</strong></EntityLink>
                      <SourceBadge source={p.source} />
                      {p.client_email && <div className="sub">{p.client_email}</div>}
                    </td>
                    <td>
                      {getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}
                      {p._optionCount > 1 && <div className="sub">{p._optionCount} options to compare</div>}
                    </td>
                    <td>
                      {p.event_date ? (
                        <>
                          <div>{fmtDate(String(p.event_date).slice(0, 10))}</div>
                          <div className="sub">{relDay(String(p.event_date).slice(0, 10))}</div>
                        </>
                      ) : '—'}
                    </td>
                    <td className="muted">{p.package_name || '—'}</td>
                    <td>
                      <StatusChip kind={st.kind}>{st.label}</StatusChip>
                      {p.status === 'archived' && p.archive_reason && (
                        <div className="sub">{ARCHIVE_REASON_LABELS[p.archive_reason] || p.archive_reason}</div>
                      )}
                    </td>
                    <td className="muted">{p.sent_at ? relDay(String(p.sent_at).slice(0, 10)) : '—'}</td>
                    <td className="muted" title={viewTitle}>{p.last_viewed_at ? relDay(String(p.last_viewed_at).slice(0, 10)) : '—'}</td>
                    <td className="num"><strong>{fmt$(p.total_price)}</strong></td>
                    <td className="shrink">
                      <div className="hstack" onMouseUp={(e) => e.stopPropagation()}>
                        {isPaidStatus(p.status) && (
                          <EntityLink to={`/events/${p.id}`} className="icon-btn" title="View event">
                            <Icon name="calendar" size={13} />
                          </EntityLink>
                        )}
                        <button
                          type="button"
                          className="icon-btn"
                          title={copyMessage === p.token ? 'Copied!' : 'Copy link'}
                          onClick={(e) => copyLink(e, p.token)}
                          disabled={!p.token}
                        >
                          <Icon name={copyMessage === p.token ? 'check' : 'copy'} size={13} />
                        </button>
                      </div>
                    </td>
                  </ClickableRow>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Page counter, not a "51-100 of 219" row range: the option-group rollup
          above collapses siblings in the browser, so a 50-row fetch can render
          fewer than 50 rows and a row range would contradict the table. A page
          counter cannot be wrong that way. Hidden entirely at one page, so every
          view that already fit on one screen reads exactly as it did before. */}
      {/* Rendered once total is known, NOT gated on !loading alone: the pager is
          interactive, and unmounting it mid-fetch drops keyboard focus to the
          body on every page change. Staying mounted across the fetch keeps the
          node identity, so focus survives paging. Still hidden on a cold load
          (total 0 while loading), which is how it read before. */}
      {!loadError && (!loading || total > 0) && (
        <div className="hstack tiny muted" style={{ padding: '8px 2px' }}>
          <span aria-live="polite">
            {pageCount > 1 ? `Page ${safePage} of ${pageCount} · ` : ''}
            {`${total} ${total === 1 ? 'proposal' : 'proposals'} · Click a row to open`}
          </span>
          {pageCount > 1 && (
            <>
              <div className="spacer" />
              <nav className="hstack" aria-label="Proposal pages">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={safePage <= 1}
                  onClick={() => goToPage(safePage - 1)}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={safePage >= pageCount}
                  onClick={() => goToPage(safePage + 1)}
                >
                  Next
                </button>
              </nav>
            </>
          )}
        </div>
      )}
    </div>
  );
}
