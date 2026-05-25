import React from 'react';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents } from '../../../components/adminos/format';
import { paymentMethodLabel } from '../userDetail/helpers';
import EventLineItem from './EventLineItem';
import MarkPaidAction from './MarkPaidAction';

export default function PayoutRow({ payout, expanded, onToggle, onLineSaved, onPaid, editable }) {
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
        <div className="hstack" style={{ gap: 12, flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{payout.contractor_name}</span>
          <span className="tiny muted">{paymentMethodLabel(payout.preferred_payment_method) || 'No method'}</span>
        </div>
        <div className="hstack" style={{ gap: 12 }}>
          <span className="num"><strong>{fmt$fromCents(payout.total_cents)}</strong></span>
          {payout.status === 'paid'
            ? <StatusChip kind="ok">Paid</StatusChip>
            : <StatusChip kind="info">Pending</StatusChip>}
          <span className="tiny muted">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded && (
        <div className="card-body">
          {(payout.events || []).length === 0 && (
            <div className="muted tiny">No event lines on this payout.</div>
          )}
          {(payout.events || []).map(ev => (
            <EventLineItem
              key={ev.id}
              event={ev}
              editable={editable && payout.status === 'pending'}
              onSaved={({ event, payout_total_cents }) => onLineSaved?.(event, payout_total_cents)}
            />
          ))}
          {payout.status === 'pending' && (
            <div className="hstack" style={{ marginTop: 12 }}>
              <MarkPaidAction payout={payout} onPaid={onPaid} />
              <span className="tiny muted" style={{ marginLeft: 8 }}>
                Records the method and timestamp; the period closes automatically when the last payout is paid.
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
