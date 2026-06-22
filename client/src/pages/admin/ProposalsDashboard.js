import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import Toolbar from '../../components/adminos/Toolbar';
import { fmt$, fmtDate, relDay } from '../../components/adminos/format';
import ClickableRow from '../../components/ClickableRow';
import CcImportBadge from '../../components/admin/CcImportBadge';
import SourceBadge from '../../components/admin/SourceBadge';
import RowLink from '../../components/RowLink';

// Mirrors `proposals_status_check` in server/db/schema.sql. Keep in sync —
// the constraint allows draft/sent/viewed/modified/accepted/deposit_paid/
// balance_paid/confirmed/completed/archived. ('declined' is not in the
// constraint but appears here as a safety entry — the sign endpoint never
// writes it; remove if unused after one full deploy cycle.)
const STATUS = {
  draft:        { label: 'Draft',        kind: 'neutral' },
  sent:         { label: 'Sent',         kind: 'info' },
  viewed:       { label: 'Viewed',       kind: 'accent' },
  modified:     { label: 'Modified',     kind: 'violet' },
  accepted:     { label: 'Accepted',     kind: 'ok' },
  deposit_paid: { label: 'Deposit Paid', kind: 'ok' },
  balance_paid: { label: 'Paid in Full', kind: 'ok' },
  confirmed:    { label: 'Confirmed',    kind: 'ok' },
  completed:    { label: 'Completed',    kind: 'neutral' },
  archived:     { label: 'Archived',     kind: 'neutral' },
  declined:     { label: 'Declined',     kind: 'danger' },
};

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
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('active');
  const [sourceFilter, setSourceFilter] = useState('');  // '' | 'thumbtack' | 'manual'
  const [copyMessage, setCopyMessage] = useState('');

  // Map UI tab → server query string. Each tab fetches a server-side bucket so
  // paid proposals (which migrate to Events) stay reachable via the Paid tab
  // without client-side post-filtering of a giant payload.
  const tabToQuery = useMemo(() => ({
    active:  '?view=active',
    draft:   '?status=draft',
    won:     '?status=accepted',
    paid:    '?view=paid',
    archive: '?view=archive',
    all:     '?view=all',
  }), []);

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

  const fetchProposals = useCallback(async (currentTab) => {
    setLoading(true);
    try {
      const qs = tabToQuery[currentTab] || tabToQuery.active;
      const sourceQs = sourceFilter ? `&source=${sourceFilter}` : '';
      const list = await api.get(`/proposals${qs}${sourceQs}`);
      const rows = list.data || [];
      setProposals(rows);
      // X-Total-Count is the unpaginated total for this bucket. Fall back to the
      // number of rows we actually got if the header is missing (older server).
      const headerTotal = Number(list.headers?.['x-total-count']);
      setTotal(Number.isFinite(headerTotal) ? headerTotal : rows.length);
    } catch (err) {
      console.error('Failed to fetch proposals:', err);
      toast.error('Failed to load proposals. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast, tabToQuery, sourceFilter]);

  useEffect(() => { fetchProposals(tab); }, [fetchProposals, tab]);

  const copyLink = (e, token) => {
    e.stopPropagation();
    if (!token) return;
    const url = `${PUBLIC_SITE_URL}/proposal/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopyMessage(token);
      setTimeout(() => setCopyMessage(''), 2000);
    });
  };

  // Client-side filter is now only for the free-text search box — server already
  // returned the right status bucket based on the active tab.
  const filtered = useMemo(() => {
    if (!search) return proposals;
    const q = search.toLowerCase();
    return proposals.filter(p => {
      const fields = [p.client_name, p.client_email, p.event_type, p.event_type_custom].filter(Boolean).join(' ').toLowerCase();
      return fields.includes(q);
    });
  }, [proposals, search]);

  const tabs = useMemo(() => ([
    { id: 'active',  label: 'Active',   count: counts.active },
    { id: 'draft',   label: 'Draft',    count: counts.draft },
    { id: 'won',     label: 'Accepted', count: counts.accepted },
    { id: 'paid',    label: 'Paid',     count: counts.paid },
    { id: 'archive', label: 'Archived', count: counts.archived },
    { id: 'all',     label: 'All' },
  ]), [counts]);

  // Paid statuses surface a "View event" jump-link so admins can move from a
  // paid proposal straight into its EventDetailPage (where shifts/staffing live).
  const isPaidStatus = (status) => ['deposit_paid', 'balance_paid', 'confirmed', 'completed'].includes(status);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Proposals</div>
          <div className="page-subtitle">Quotes out the door — track which are sent, viewed, and accepted.</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => navigate('/proposals/new')}>
            <Icon name="plus" />New proposal
          </button>
        </div>
      </div>

      <Toolbar search={search} setSearch={setSearch} tabs={tabs} tab={tab} setTab={setTab} />

      <div className="hstack" style={{ gap: 8, marginBottom: 12 }}>
        <label className="tiny muted" htmlFor="source-filter">Source</label>
        <select
          id="source-filter"
          className="input"
          style={{ maxWidth: 200 }}
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
        >
          <option value="">All sources</option>
          <option value="thumbtack">Thumbtack</option>
          <option value="manual">Manual / Direct</option>
        </select>
      </div>

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
                <th className="num">Total</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={8} className="muted">Loading…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={8} className="muted">No proposals match these filters.</td></tr>
              )}
              {!loading && filtered.map(p => {
                const st = STATUS[p.status] || { label: p.status || '—', kind: 'neutral' };
                return (
                  <ClickableRow key={p.id} to={`/proposals/${p.id}`}>
                    <td>
                      <RowLink to={`/proposals/${p.id}`}><strong>{p.client_name || '—'}</strong></RowLink>
                      <CcImportBadge ccId={p.proposal_cc_id} />
                      <SourceBadge source={p.source} />
                      {p.client_email && <div className="sub">{p.client_email}</div>}
                    </td>
                    <td>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</td>
                    <td>
                      {p.event_date ? (
                        <>
                          <div>{fmtDate(String(p.event_date).slice(0, 10))}</div>
                          <div className="sub">{relDay(String(p.event_date).slice(0, 10))}</div>
                        </>
                      ) : '—'}
                    </td>
                    <td className="muted">{p.package_name || '—'}</td>
                    <td><StatusChip kind={st.kind}>{st.label}</StatusChip></td>
                    <td className="muted">{p.sent_at ? relDay(String(p.sent_at).slice(0, 10)) : '—'}</td>
                    <td className="num"><strong>{fmt$(p.total_price)}</strong></td>
                    <td className="shrink">
                      <div className="hstack" onMouseUp={(e) => e.stopPropagation()}>
                        {isPaidStatus(p.status) && (
                          <button
                            type="button"
                            className="icon-btn"
                            title="View event"
                            onClick={(e) => { e.stopPropagation(); navigate(`/events/${p.id}`); }}
                          >
                            <Icon name="calendar" size={13} />
                          </button>
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
          {search
            ? `${filtered.length} ${filtered.length === 1 ? 'proposal' : 'proposals'} match`
            : `${total} ${total === 1 ? 'proposal' : 'proposals'}${proposals.length < total ? ` · showing first ${proposals.length}` : ''}`}
          {' · Click a row to open'}
        </div>
      )}
    </div>
  );
}
