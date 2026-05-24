import React from 'react';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';

export default function PayrollHeader({ period, payouts, onProcess, processing }) {
  if (!period) {
    return (
      <div className="card">
        <div className="card-body muted">
          No open pay period yet. Once an event completes and accrues a payout, the period appears here.
        </div>
      </div>
    );
  }
  const total = (payouts || []).reduce((acc, p) => acc + Number(p.total_cents || 0), 0);
  const paid = (payouts || []).filter(p => p.status === 'paid').length;
  const pending = (payouts || []).filter(p => p.status === 'pending').length;

  return (
    <div className="card" style={{ marginBottom: 'var(--gap)' }}>
      <div className="card-head">
        <h3>
          {fmtDate(period.start_date)} – {fmtDate(period.end_date)}
        </h3>
        <span className={`chip ${period.status === 'open' ? 'info' : period.status === 'processing' ? 'warn' : 'ok'}`}>
          {period.status}
        </span>
      </div>
      <div className="card-body">
        <div className="stat-row">
          <div className="stat">
            <div className="stat-label">Payday</div>
            <div className="stat-value">{fmtDate(period.payday)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Total payroll</div>
            <div className="stat-value">{fmt$fromCents(total)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Paid</div>
            <div className="stat-value" style={{ color: 'hsl(var(--ok-h) var(--ok-s) 52%)' }}>{paid}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Pending</div>
            <div className="stat-value">{pending}</div>
          </div>
        </div>
        {period.status === 'open' && (
          <div className="hstack" style={{ marginTop: 12, gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={onProcess}
              disabled={processing || pending === 0}
              title={pending === 0 ? 'Nothing to process yet' : 'Freeze the period to begin paying'}
            >
              {processing ? 'Processing…' : 'Process Payroll'}
            </button>
            <span className="tiny muted">
              This freezes the period; auto-recompute stops, your edits and mark-paid actions still apply.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
