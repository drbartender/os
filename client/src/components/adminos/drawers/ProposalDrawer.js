import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { getEventTypeLabel } from '../../../utils/eventTypes';
import { PUBLIC_SITE_URL } from '../../../utils/constants';
import Drawer from '../Drawer';
import Icon from '../Icon';
import StatusChip from '../StatusChip';
import { fmt$2dp, fmtDate, fmtDateFull, relDay } from '../format';

const STATUS_KIND = {
  draft: 'neutral', sent: 'info', viewed: 'accent', modified: 'violet',
  accepted: 'ok', declined: 'danger',
};

export default function ProposalDrawer({ id, open, onClose }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open || !id) { setProposal(null); setErr(null); return; }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    api.get(`/proposals/${id}`)
      .then(r => !cancelled && setProposal(r.data))
      .catch(e => !cancelled && setErr(e?.message || 'Failed to load proposal'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [id, open]);

  const goPage = () => { onClose(); if (proposal?.id) navigate(`/proposals/${proposal.id}`); };

  const copyLink = () => {
    if (!proposal?.token) return;
    const url = `${PUBLIC_SITE_URL}/proposal/${proposal.token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      toast.success('Proposal link copied.');
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const crumb = (
    <div className="crumb" style={{ flex: 1 }}>
      <Icon name="clipboard" />
      <span>Proposals</span>
      <span style={{ color: 'var(--ink-4)' }}>/</span>
      <span style={{ color: 'var(--ink-1)' }}>{proposal?.client_name || 'Proposal'}</span>
    </div>
  );

  return (
    <Drawer open={open} onClose={onClose} crumb={crumb} onOpenPage={proposal ? goPage : undefined}>
      {loading && <div className="muted">Loading…</div>}
      {err && <div className="chip danger">{err}</div>}
      {!loading && !err && !proposal && open && <div className="muted">Proposal not found.</div>}
      {proposal && (
        <ProposalDrawerBody
          proposal={proposal}
          onCopyLink={copyLink}
          copied={copied}
        />
      )}
    </Drawer>
  );
}

function ProposalDrawerBody({ proposal, onCopyLink, copied }) {
  const total = Number(proposal.total_price || 0);
  const paid = Number(proposal.amount_paid || 0);
  const balance = total - paid;
  const eventTypeLabel = getEventTypeLabel({
    event_type: proposal.event_type,
    event_type_custom: proposal.event_type_custom,
  });
  const statusKind = STATUS_KIND[proposal.status] || 'neutral';

  return (
    <>
      <div className="drawer-hero">
        <div className="hstack" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <StatusChip kind={statusKind}>{proposal.status || 'draft'}</StatusChip>
          {proposal.package_name && <span className="tag">{proposal.package_name}</span>}
        </div>
        <h2>{proposal.client_name || 'Proposal'}</h2>
        <div className="sub">
          {eventTypeLabel}
          {proposal.event_date && ` · ${fmtDateFull(String(proposal.event_date).slice(0, 10))}`}
        </div>

        <div className="meta">
          <div className="meta-item">
            <div className="meta-k">Sent</div>
            <div className="meta-v">{proposal.sent_at ? relDay(String(proposal.sent_at).slice(0, 10)) : '—'}</div>
          </div>
          <div className="meta-item">
            <div className="meta-k">Last viewed</div>
            <div className="meta-v">{proposal.last_viewed_at ? relDay(String(proposal.last_viewed_at).slice(0, 10)) : '—'}</div>
          </div>
          <div className="meta-item">
            <div className="meta-k">Total</div>
            <div className="meta-v num">{fmt$2dp(total)}</div>
          </div>
          {paid > 0 && (
            <div className="meta-item">
              <div className="meta-k">Balance</div>
              <div className="meta-v num" style={{ color: balance > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : 'hsl(var(--ok-h) var(--ok-s) 55%)' }}>
                {balance > 0 ? fmt$2dp(balance) : 'Paid in full'}
              </div>
            </div>
          )}
        </div>

        <div className="hstack" style={{ marginTop: 14, gap: 6 }}>
          <button type="button" className="btn btn-secondary" onClick={onCopyLink} disabled={!proposal.token}>
            <Icon name={copied ? 'check' : 'copy'} size={12} />{copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      </div>

      <div className="section-title">Event</div>
      <dl className="dl">
        <dt>Date</dt>
        <dd>{proposal.event_date ? fmtDate(String(proposal.event_date).slice(0, 10), { year: 'numeric' }) : '—'}</dd>
        {proposal.event_start_time && <><dt>Start</dt><dd>{proposal.event_start_time}</dd></>}
        {proposal.event_duration_hours && <><dt>Duration</dt><dd>{proposal.event_duration_hours} hours</dd></>}
        {proposal.event_location && <><dt>Location</dt><dd>{proposal.event_location}</dd></>}
        {proposal.guest_count != null && <><dt>Guests</dt><dd className="num">{proposal.guest_count}</dd></>}
        <dt>Type</dt><dd>{eventTypeLabel}</dd>
      </dl>

      <div className="section-title">Pricing</div>
      <dl className="dl">
        {proposal.package_name && <><dt>Package</dt><dd>{proposal.package_name}</dd></>}
        {proposal.num_bartenders != null && <><dt>Bartenders</dt><dd className="num">{proposal.num_bartenders}</dd></>}
        {proposal.num_bars != null && <><dt>Bars</dt><dd className="num">{proposal.num_bars}</dd></>}
        <dt>Total</dt><dd className="num">{fmt$2dp(total)}</dd>
        <dt>Paid</dt><dd className="num">{fmt$2dp(paid)}</dd>
        <dt>Balance</dt>
        <dd className="num" style={{ color: balance > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>
          {fmt$2dp(balance)}
        </dd>
      </dl>

      {(proposal.client_email || proposal.client_phone) && (
        <>
          <div className="section-title">Client</div>
          <dl className="dl">
            <dt>Name</dt><dd>{proposal.client_name || '—'}</dd>
            {proposal.client_email && <><dt>Email</dt><dd>{proposal.client_email}</dd></>}
            {proposal.client_phone && <><dt>Phone</dt><dd>{proposal.client_phone}</dd></>}
            {proposal.client_source && <><dt>Source</dt><dd className="muted">{proposal.client_source}</dd></>}
          </dl>
        </>
      )}

      {Array.isArray(proposal.activity) && proposal.activity.length > 0 && (
        <>
          <div className="section-title">Activity</div>
          <div className="vstack" style={{ gap: 10, fontSize: 12.5 }}>
            {proposal.activity.slice(0, 8).map((a, i) => (
              <div key={i} className="hstack" style={{ alignItems: 'flex-start' }}>
                <div className="queue-icon info" style={{ flexShrink: 0 }}>
                  <Icon name={
                    a.action === 'payment' ? 'dollar' :
                    a.action === 'sent' ? 'send' :
                    a.action === 'viewed' ? 'eye' :
                    a.action === 'signed' ? 'check' :
                    'pen'
                  } size={12} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{a.action || 'Update'}</div>
                  {a.metadata && typeof a.metadata === 'object' && (a.metadata.note || a.metadata.message) && (
                    <div className="tiny muted">{a.metadata.note || a.metadata.message}</div>
                  )}
                </div>
                <div className="tiny muted">{a.created_at ? relDay(String(a.created_at).slice(0, 10)) : ''}</div>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{ height: 24 }} />
    </>
  );
}
