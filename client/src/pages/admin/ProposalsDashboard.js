import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { PUBLIC_SITE_URL } from '../../utils/constants';
import { useToast } from '../../context/ToastContext';
import Icon from '../../components/adminos/Icon';
import StatusChip from '../../components/adminos/StatusChip';
import Toolbar from '../../components/adminos/Toolbar';
import useDrawerParam from '../../hooks/useDrawerParam';
import ProposalDrawer from '../../components/adminos/drawers/ProposalDrawer';
import { fmt$, fmtDate, relDay } from '../../components/adminos/format';

// Mirrors `proposals_status_check` in server/db/schema.sql. Keep in sync —
// the constraint allows draft/sent/viewed/modified/accepted/deposit_paid/
// balance_paid/confirmed/completed/cancelled. ('declined' is not in the
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
  cancelled:    { label: 'Cancelled',    kind: 'danger' },
  declined:     { label: 'Declined',     kind: 'danger' },
};

export default function ProposalsDashboard() {
  const navigate = useNavigate();
  const toast = useToast();
  const drawer = useDrawerParam();

  const [proposals, setProposals] = useState([]);
  const [counts, setCounts] = useState({ active: 0, draft: 0, accepted: 0, paid: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('active');
  const [copyMessage, setCopyMessage] = useState('');

  // Map UI tab → server query string. Each tab fetches a server-side bucket so
  // paid proposals (which migrate to Events) stay reachable via the Paid tab
  // without client-side post-filtering of a giant payload.
  const tabToQuery = useMemo(() => ({
    active: '?view=active',
    draft:  '?status=draft',
    won:    '?status=accepted',
    paid:   '?view=paid',
    all:    '?view=all',
  }), []);

  // Tab counts come from /dashboard-stats. Fetched once on mount because the
  // pipeline aggregates don't change between tab switches — only mutations
  // (create/sign/pay) move proposals between buckets, and those force a page
  // reload anyway. Failing the stats request leaves counts at zero (graceful
  // degradation — tabs still work, just without the count badge).
  useEffect(() => {
    api.get('/proposals/dashboard-stats')
      .then(r => {
        const pipeByKey = Object.fromEntries((r.data?.pipeline || []).map(p => [p.key, p.count]));
        setCounts({
          active:   (pipeByKey.sent || 0) + (pipeByKey.viewed || 0) + (pipeByKey.modified || 0),
          draft:    pipeByKey.draft || 0,
          accepted: pipeByKey.accepted || 0,
          paid:     r.data?.totals?.events_count || 0,
        });
      })
      .catch(() => { /* leave counts at zero — graceful degradation */ });
  }, []);

  const fetchProposals = useCallback(async (currentTab) => {
    setLoading(true);
    try {
      const qs = tabToQuery[currentTab] || tabToQuery.active;
      const list = await api.get(`/proposals${qs}`);
      setProposals(list.data || []);
    } catch (err) {
      console.error('Failed to fetch proposals:', err);
      toast.error('Failed to load proposals. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast, tabToQuery]);

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
    { id: 'active', label: 'Active',   count: counts.active },
    { id: 'draft',  label: 'Draft',    count: counts.draft },
    { id: 'won',    label: 'Accepted', count: counts.accepted },
    { id: 'paid',   label: 'Paid',     count: counts.paid },
    { id: 'all',    label: 'All' },
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
                  <tr key={p.id} onClick={() => drawer.open('proposal', p.id)}>
                    <td>
                      <strong>{p.client_name || '—'}</strong>
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
                      <div className="hstack" onClick={(e) => e.stopPropagation()}>
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {!loading && (
        <div className="tiny muted" style={{ padding: '8px 2px' }}>
          {filtered.length} {filtered.length === 1 ? 'proposal' : 'proposals'} · Click a row to peek
        </div>
      )}

      <ProposalDrawer
        id={drawer.kind === 'proposal' ? drawer.id : null}
        open={drawer.kind === 'proposal'}
        onClose={drawer.close}
      />
    </div>
  );
}
