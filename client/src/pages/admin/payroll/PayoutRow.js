import React from 'react';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents } from '../../../components/adminos/format';
import { paymentMethodLabel } from '../userDetail/helpers';

export default function PayoutRow({ payout, expanded, onToggle, onMarkPaid }) {
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
          {/* Task 12 fills in the expanded view (per-event lines + mark-paid action). */}
          <div className="muted tiny">Expanded line items render here (Task 12).</div>
        </div>
      )}
    </div>
  );
}
