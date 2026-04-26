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
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('active');
  const [copyMessage, setCopyMessage] = useState('');

  const fetchProposals = useCallback(async () => {
    try {
      const res = await api.get('/proposals');
      setProposals(res.data || []);
    } catch (err) {
      console.error('Failed to fetch proposals:', err);
      toast.error('Failed to load proposals. Try refreshing.');
    } finally {
      setLoading(false);
    }
  }, [toast]);

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

  const filtered = useMemo(() => proposals.filter(p => {
    if (tab === 'active' && !['sent', 'viewed', 'modified'].includes(p.status)) return false;
    if (tab === 'draft' && p.status !== 'draft') return false;
    if (tab === 'won' && p.status !== 'accepted') return false;
    if (search) {
      const q = search.toLowerCase();
      const fields = [p.client_name, p.client_email, p.event_type, p.event_type_custom].filter(Boolean).join(' ').toLowerCase();
      if (!fields.includes(q)) return false;
    }
    return true;
  }), [proposals, tab, search]);

  const tabs = useMemo(() => ([
    { id: 'active', label: 'Active', count: proposals.filter(p => ['sent', 'viewed', 'modified'].includes(p.status)).length },
    { id: 'draft',  label: 'Draft',  count: proposals.filter(p => p.status === 'draft').length },
    { id: 'won',    label: 'Accepted', count: proposals.filter(p => p.status === 'accepted').length },
    { id: 'all',    label: 'All' },
  ]), [proposals]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="page-title">Proposals</div>
          <div className="page-subtitle">Quotes out the door — track which are sent, viewed, and accepted.</div>
        </div>
        <div className="page-actions">
          <button type="button" className="btn btn-primary" onClick={() => navigate('/admin/proposals/new')}>
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
