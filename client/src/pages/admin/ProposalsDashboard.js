import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel, EVENT_TYPES } from '../../utils/eventTypes';
import { presetRange } from '../../hooks/useMetricsFilter';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import Toolbar from '../../components/adminos/Toolbar';
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
  other: 'Other',
};
// View state lives in the URL (admin cross-nav): every control writes through
// setListState so drill-outs are plain links and Back restores the filters.
const LIST_DEFAULTS = { tab: 'active', q: '', source: '', from: '', to: '', axis: 'event', status: '', event_type: '', balance: '', cohort: '' };

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
  const [listState, setListState] = useUrlListState(LIST_DEFAULTS);
  const tab = TAB_IDS.includes(listState.tab) ? listState.tab : 'active';
  const sourceFilter = SOURCE_IDS.includes(listState.source) ? listState.source : '';
  const axis = AXIS_IDS.includes(listState.axis) ? listState.axis : 'event';
  const cohort = COHORT_IDS.includes(listState.cohort) ? listState.cohort : '';
  const [copyMessage, setCopyMessage] = useState('');
  // Custom-range date inputs reveal on the Custom chip (or off-preset URL dates).
  const [showCustom, setShowCustom] = useState(false);

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
    return p.toString();
  }, [cohort, listState.status, listState.q, listState.from, listState.to,
    listState.event_type, listState.balance, axis, sourceFilter, tab]);

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

  const fetchProposals = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.get(`/proposals?${queryString}`);
      const rows = list.data || [];
      setProposals(rows);
      // X-Total-Count is the unpaginated total for this filtered set. Fall back to
      // the number of rows we actually got if the header is missing (older server).
      const headerTotal = Number(list.headers?.['x-total-count']);
      setTotal(Number.isFinite(headerTotal) ? headerTotal : rows.length);
    } catch (err) {
      console.error('Failed to fetch proposals:', err);
      toast.error('Failed to load proposals. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast, queryString]);

  useEffect(() => { fetchProposals(); }, [fetchProposals]);

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
    if (key === 'all') { setShowCustom(false); setListState({ from: '', to: '' }); return; }
    if (key === 'custom') {
      setShowCustom(true);
      if (!listState.from || !listState.to) {
        const seed = presetRange('last-12');
        setListState({ from: seed.from, to: seed.to });
      }
      return;
    }
    setShowCustom(false);
    const r = presetRange(key);
    setListState({ from: r.from, to: r.to });
  };
  const presetActive = (key) => (showCustom
    ? key === 'custom'
    : (key === 'custom' ? activePreset === 'custom' : activePreset === key));

  const toggleStatus = (s) => {
    const next = new Set(statusSet);
    if (next.has(s)) next.delete(s); else next.add(s);
    setListState({ status: [...next].join(',') });
  };

  const clearFilters = () => { setShowCustom(false); setListState(LIST_DEFAULTS); };

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

      <Toolbar tabs={tabs} tab={tab} setTab={(t) => setListState({ tab: t })} />

      <div className="hstack" style={{ gap: 8, marginBottom: 12 }}>
        <label className="tiny muted" htmlFor="source-filter">Source</label>
        <select
          id="source-filter"
          className="input"
          style={{ maxWidth: 200 }}
          value={sourceFilter}
          onChange={(e) => setListState({ source: e.target.value })}
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
              onChange={(e) => setListState({ from: e.target.value })}
            />
            <span className="muted tiny">to</span>
            <input
              type="date"
              className="input"
              aria-label="To date"
              value={listState.to || ''}
              min={listState.from || undefined}
              onChange={(e) => setListState({ to: e.target.value })}
            />
          </>
        )}

        <div className="metrics-seg" role="group" aria-label="Date axis">
          <button
            type="button"
            className={`metrics-seg-btn${axis === 'event' ? ' is-active' : ''}`}
            aria-pressed={axis === 'event'}
            onClick={() => setListState({ axis: 'event' })}
          >
            Event date
          </button>
          <button
            type="button"
            className={`metrics-seg-btn${axis === 'sent' ? ' is-active' : ''}`}
            aria-pressed={axis === 'sent'}
            onClick={() => setListState({ axis: 'sent' })}
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
          onChange={(e) => setListState({ event_type: e.target.value })}
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
            onClick={() => setListState({ balance: listState.balance === 'open' ? '' : 'open' })}
          >
            Open balance
          </button>
        </div>
      </div>

      {cohort && (
        <div className="ov-cohort-note">
          <span>{COHORT_LABELS[cohort]} cohort{cohortRange}</span>
          <button type="button" aria-label="Clear cohort" onClick={() => setListState({ cohort: '' })}>
            &times;
          </button>
        </div>
      )}

      <div className="card" style={{ overflow: 'hidden' }}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Client</th>
                <th>Event</th>
                <th>Event date</th>
                <th>Package</th>
                <th>Status</th>
                <th>Sent</th>
                <th>Last viewed</th>
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={9} className="muted">Loading…</td></tr>
              )}
              {!loading && rows.length === 0 && (
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

      {!loading && (
        <div className="tiny muted" style={{ padding: '8px 2px' }}>
          {`${total} ${total === 1 ? 'proposal' : 'proposals'}${proposals.length < total ? ` · showing first ${proposals.length}` : ''}`}
          {' · Click a row to open'}
        </div>
      )}
    </div>
  );
}
