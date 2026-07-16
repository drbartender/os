import React from 'react';
import StatusChip from '../../../components/adminos/StatusChip';
import EntityLink from '../../../components/EntityLink';
import { fmt$fromCents } from '../../../components/adminos/format';
import { paymentMethodLabel } from '../userDetail/helpers';
import EventLineItem from './EventLineItem';
import PayPanel from './PayPanel';

function preferredHandle(payout) {
  switch (payout.preferred_payment_method) {
    case 'venmo': return payout.venmo_handle || null;
    case 'cashapp': return payout.cashapp_handle || null;
    case 'paypal': return payout.paypal_url || null;
    case 'zelle': return payout.zelle_handle || null;
    default: return null; // direct_deposit/check identifiers are bank PII and never surface
  }
}

// Queue row: name, method+handle tag, events/hours sub, amount, status chip,
// Pay button toggling the expansion. The expansion pairs the line editor
// (left) with the pay panel (right); History renders it with payable={false}
// for a read-only drill-in.
export default function PayoutRow({
  payout, period, expanded, onToggle, onLineSaved, onPaid, onRefetch, editable, payable,
}) {
  const events = payout.events || [];
  const hours = events.reduce((s, e) => s + (Number(e.hours) || 0), 0);
  const isPaid = payout.status === 'paid';
  // Paid rows show what was actually recorded; pending rows show the preference.
  const tagMethod = isPaid && payout.payment_method ? payout.payment_method : payout.preferred_payment_method;
  const tagHandle = isPaid && payout.payment_method ? payout.payment_handle : preferredHandle(payout);

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div
        className="card-head"
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <div className="hstack" style={{ gap: 12, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <EntityLink
            to={payout.contractor_id ? `/staffing/users/${payout.contractor_id}` : null}
            onClick={(e) => e.stopPropagation()}
          >
            <span style={{ fontWeight: 600 }}>{payout.contractor_name}</span>
          </EntityLink>
          <span className="tiny muted">
            {paymentMethodLabel(tagMethod) || 'No method'}{tagHandle ? ` · ${tagHandle}` : ''}
          </span>
          <span className="tiny muted">
            {events.length} {events.length === 1 ? 'event' : 'events'} · {Number(hours.toFixed(2))} h
          </span>
        </div>
        <div className="hstack" style={{ gap: 12 }}>
          <span className="num"><strong>{fmt$fromCents(payout.total_cents)}</strong></span>
          {isPaid
            ? <StatusChip kind="ok">Paid</StatusChip>
            : <StatusChip kind="info">Pending</StatusChip>}
          {payable && !isPaid && (
            <button
              type="button" className="btn btn-primary btn-sm"
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
            >
              Pay
            </button>
          )}
          <span className="tiny muted">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded && (
        <div className="card-body payrun-expansion">
          <div className="payrun-lines vstack" style={{ gap: 6 }}>
            {events.length === 0 && (
              <div className="muted tiny">No event lines on this payout.</div>
            )}
            {events.map(ev => (
              <EventLineItem
                key={ev.id}
                event={ev}
                editable={editable && !isPaid}
                onSaved={({ event, payout_total_cents }) => onLineSaved?.(event, payout_total_cents)}
              />
            ))}
            <div
              className="hstack"
              style={{ justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid var(--line-1)' }}
            >
              <span className="tiny muted">Payout total</span>
              <span className="num"><strong>{fmt$fromCents(payout.total_cents)}</strong></span>
            </div>
            {isPaid && payout.payment_reference && (
              <div className="tiny muted">Reference: {payout.payment_reference}</div>
            )}
          </div>
          {payable && !isPaid && (
            <PayPanel payout={payout} period={period} onPaid={onPaid} onDrift={onRefetch} />
          )}
        </div>
      )}
    </div>
  );
}
