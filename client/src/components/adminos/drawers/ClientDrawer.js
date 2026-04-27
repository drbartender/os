import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { formatPhone } from '../../../utils/formatPhone';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import Drawer from '../Drawer';
import Icon from '../Icon';
import StatusChip from '../StatusChip';
import { fmt$, fmt$2dp, fmtDate } from '../format';

const SOURCE = {
  direct:    { label: 'Direct',    kind: 'neutral' },
  thumbtack: { label: 'Thumbtack', kind: 'info' },
  referral:  { label: 'Referral',  kind: 'ok' },
  website:   { label: 'Website',   kind: 'accent' },
  instagram: { label: 'Instagram', kind: 'violet' },
};

const PROP_STATUS = {
  draft: 'neutral', sent: 'info', viewed: 'accent', modified: 'violet',
  accepted: 'ok', deposit_paid: 'ok', balance_paid: 'ok', completed: 'ok',
  declined: 'danger',
};

function initialsOf(name) {
  if (!name) return '?';
  return name.split(/\s+/).map(s => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export default function ClientDrawer({ id, open, onClose }) {
  const navigate = useNavigate();
  const [client, setClient] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    if (!open || !id) { setClient(null); setErr(null); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.get(`/clients/${id}`)
      .then(r => !cancelled && setClient(r.data))
      .catch(e => !cancelled && setErr(e?.message || 'Failed to load client'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, open]);

  const goPage = () => { onClose(); if (client?.id) navigate(`/admin/clients/${client.id}`); };

  const crumb = (
    <div className="crumb" style={{ flex: 1 }}>
      <Icon name="users" />
      <span>Clients</span>
      <span style={{ color: 'var(--ink-4)' }}>/</span>
      <span style={{ color: 'var(--ink-1)' }}>{client?.name || 'Client'}</span>
    </div>
  );

  return (
    <Drawer open={open} onClose={onClose} crumb={crumb} onOpenPage={client ? goPage : undefined}>
      {loading && <div className="muted">Loading…</div>}
      {err && <div className="chip danger">{err}</div>}
      {!loading && !err && !client && open && <div className="muted">Client not found.</div>}
      {client && <ClientDrawerBody client={client} navigate={navigate} onClose={onClose} />}
    </Drawer>
  );
}

function ClientDrawerBody({ client, navigate, onClose }) {
  const proposals = client.proposals || [];
  const eventCount = proposals.length;
  const ltv = proposals.reduce((s, p) => s + Number(p.amount_paid || 0), 0);
  const src = SOURCE[client.source] || { label: client.source || '—', kind: 'neutral' };

  const goNewProposal = () => {
    onClose();
    navigate(`/admin/proposals/new?client_id=${client.id}`);
  };

  return (
    <>
      <div className="drawer-hero">
        <div className="hstack" style={{ gap: 10, marginBottom: 10 }}>
          <div className="avatar" style={{ width: 40, height: 40, fontSize: 14 }}>{initialsOf(client.name)}</div>
          <div>
            <h2>{client.name}</h2>
            <div className="sub">
              {client.email || '—'}
              {client.phone && ` · ${formatPhone(client.phone)}`}
            </div>
          </div>
        </div>

        <div className="hstack" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <StatusChip kind={src.kind}>{src.label}</StatusChip>
        </div>

        <div className="meta">
          <div className="meta-item">
            <div className="meta-k">Events</div>
            <div className="meta-v num">{eventCount}</div>
          </div>
          <div className="meta-item">
            <div className="meta-k">Lifetime value</div>
            <div className="meta-v num">{fmt$2dp(ltv)}</div>
          </div>
          <div className="meta-item">
            <div className="meta-k">Added</div>
            <div className="meta-v">{fmtDate(client.created_at && String(client.created_at).slice(0, 10), { year: 'numeric' })}</div>
          </div>
        </div>

        <div className="hstack" style={{ marginTop: 14, gap: 6 }}>
          <button type="button" className="btn btn-primary" onClick={goNewProposal}>
            <Icon name="plus" size={12} />New proposal
          </button>
          {client.email && (
            <a className="btn btn-secondary" href={`mailto:${client.email}`} onClick={(e) => e.stopPropagation()}>
              <Icon name="mail" size={12} />Email
            </a>
          )}
          {client.phone && (
            <a className="btn btn-secondary" href={`tel:${client.phone}`} onClick={(e) => e.stopPropagation()}>
              <Icon name="phone" size={12} />Call
            </a>
          )}
        </div>
      </div>

      <div className="section-title">Proposals & events ({proposals.length})</div>
      {proposals.length === 0 ? (
        <div className="muted tiny">No proposals yet.</div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Event</th>
                <th>Date</th>
                <th>Status</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {proposals.map(p => (
                <tr key={p.id} onClick={() => { onClose(); navigate(`/admin/proposals/${p.id}`); }}>
                  <td>
                    <strong>{getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom })}</strong>
                    {p.package_name && <div className="sub">{p.package_name}</div>}
                  </td>
                  <td>{p.event_date ? fmtDate(String(p.event_date).slice(0, 10)) : '—'}</td>
                  <td>
                    <StatusChip kind={PROP_STATUS[p.status] || 'neutral'}>{p.status || '—'}</StatusChip>
                  </td>
                  <td className="num">{fmt$(p.total_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {client.notes && (
        <>
          <div className="section-title">Notes</div>
          <div style={{ color: 'var(--ink-2)', fontSize: 13, whiteSpace: 'pre-wrap' }}>{client.notes}</div>
        </>
      )}

      <div style={{ height: 24 }} />
    </>
  );
}
