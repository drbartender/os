import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import PayrollHeader from './PayrollHeader';
import PayoutRow from './PayoutRow';

export default function HistoryView({ initialPeriodId }) {
  const toast = useToast();
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);  // { period, payouts }
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [expanded, setExpanded] = useState(new Set());

  useEffect(() => {
    api.get('/admin/payroll/periods')
      .then(r => setPeriods(r.data.periods || []))
      .catch(err => toast.error(err.message || 'Failed to load periods'))
      .finally(() => setLoading(false));
  }, [toast]);

  const open = (id) => {
    setSelectedLoading(true);
    api.get(`/admin/payroll/periods/${id}`)
      .then(r => setSelected(r.data))
      .catch(err => toast.error(err.message || 'Failed to load period'))
      .finally(() => setSelectedLoading(false));
  };

  // Pay-period deep-link receiver (/financials/payroll?tab=history&period=<id>).
  // Once the periods list loads, open the requested period and scroll its list
  // row into view. Graceful no-op when the id is absent from the loaded list.
  useEffect(() => {
    if (!initialPeriodId || !periods.length) return;
    if (periods.some((p) => String(p.id) === String(initialPeriodId))) {
      open(initialPeriodId);
      document.getElementById('period-' + initialPeriodId)?.scrollIntoView({ block: 'start' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPeriodId, periods.length]);

  const toggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (loading) return <div className="muted">Loading…</div>;

  if (selected) {
    return (
      <>
        <div className="hstack" style={{ marginBottom: 8 }}>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setSelected(null); setExpanded(new Set()); }}>
            ← Back to history
          </button>
        </div>
        <PayrollHeader period={selected.period} payouts={selected.payouts} onProcess={() => {}} processing={false} />
        {(selected.payouts || []).map(po => (
          <PayoutRow
            key={po.id}
            payout={po}
            expanded={expanded.has(po.id)}
            onToggle={() => toggle(po.id)}
            // Same freeze rule as the Current tab (the server 409-guards this
            // too): still-open periods stay editable even from History — the
            // June backfill era needs line corrections before mark-paid.
            // Paid payouts stay locked individually.
            editable={!!(selected.period
              && selected.period.status !== 'paid'
              && selected.period.status !== 'processing'
              && po.status !== 'paid')}
          />
        ))}
      </>
    );
  }

  return (
    <div className="card">
      <div className="card-head"><h3>All pay periods</h3></div>
      <div className="card-body">
        {selectedLoading && <div className="muted tiny">Loading period…</div>}
        {periods.length === 0 && <div className="muted tiny">No periods yet.</div>}
        {periods.map(p => (
          <div
            key={p.id}
            id={'period-' + p.id}
            className="hstack"
            style={{
              padding: '10px 0', borderTop: '1px solid var(--line-1)', gap: 12,
              alignItems: 'center', cursor: 'pointer',
            }}
            onClick={() => open(p.id)}
            role="button" tabIndex={0}
            onKeyDown={(e) => { if (e.key === 'Enter') open(p.id); }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{fmtDate(p.start_date)} – {fmtDate(p.end_date)}</div>
              <div className="tiny muted">Payday {fmtDate(p.payday)}</div>
            </div>
            <div className="num"><strong>{fmt$fromCents(p.total_cents)}</strong></div>
            <StatusChip kind={p.status === 'paid' ? 'ok' : p.status === 'processing' ? 'warn' : 'info'}>
              {p.status}
            </StatusChip>
            <span className="tiny muted">{Number(p.paid_count)}/{Number(p.paid_count) + Number(p.pending_count)} paid</span>
          </div>
        ))}
      </div>
    </div>
  );
}
