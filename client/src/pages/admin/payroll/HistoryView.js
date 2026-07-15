import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import PayoutRow from './PayoutRow';

// pg DATE columns arrive as full ISO strings; keep the calendar date.
const ymd10 = (v) => (v ? String(v).slice(0, 10) : null);

// Paid-periods archive: the full periods list filtered to paid, with a
// read-only drill-in (no line edits, no pay panel, payment references shown).
// Non-paid periods live in the Pay run tab; deep links to one are handed over.
export default function HistoryView({ periodParam }) {
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [periods, setPeriods] = useState(null); // all periods (rollups) | null while loading
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState(null); // { period, payouts } | null
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [expanded, setExpanded] = useState(new Set());
  const routedRef = useRef(false);

  const load = useCallback(() => {
    setError(false);
    api.get('/admin/payroll/periods')
      .then(r => setPeriods(r.data.periods || []))
      .catch(() => setError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const open = useCallback((id) => {
    setSelectedLoading(true);
    api.get(`/admin/payroll/periods/${id}`)
      .then(r => setSelected(r.data))
      .catch(err => toast.error(err.response?.data?.error || err.message))
      .finally(() => setSelectedLoading(false));
  }, [toast]);

  // Deep-link receiver: a paid period opens its drill-in here; a non-paid
  // period belongs to the pay-run queue, so redirect (keeping other params);
  // a missing or unknown id just shows the plain list.
  useEffect(() => {
    if (routedRef.current || !periodParam || !periods) return;
    const p = periods.find(x => String(x.id) === String(periodParam));
    if (!p) return;
    routedRef.current = true;
    if (p.status !== 'paid') {
      const sp = new URLSearchParams(location.search);
      sp.set('tab', 'payrun');
      sp.set('period', String(p.id));
      navigate({ pathname: location.pathname, search: `?${sp.toString()}` }, { replace: true });
      return;
    }
    open(p.id);
    document.getElementById(`history-period-${p.id}`)?.scrollIntoView({ block: 'start' });
  }, [periodParam, periods, location, navigate, open]);

  const toggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  if (error) {
    return (
      <div className="card">
        <div className="card-body vstack" style={{ gap: 8 }}>
          <div className="muted">Couldn't load pay periods.</div>
          <div><button type="button" className="btn btn-ghost btn-sm" onClick={load}>Retry</button></div>
        </div>
      </div>
    );
  }
  if (periods === null) return <div className="muted">Loading…</div>;

  if (selected) {
    const payouts = selected.payouts || [];
    const totalPaid = payouts.reduce((s, po) => s + Number(po.total_cents || 0), 0);
    return (
      <>
        <div className="hstack" style={{ marginBottom: 8 }}>
          <button
            type="button" className="btn btn-ghost btn-sm"
            onClick={() => { setSelected(null); setExpanded(new Set()); }}
          >
            ← Back to history
          </button>
        </div>
        <div className="card" style={{ marginBottom: 'var(--gap)' }}>
          <div className="card-head">
            <h3>{fmtDate(ymd10(selected.period.start_date))} – {fmtDate(ymd10(selected.period.end_date))}</h3>
            <StatusChip kind="ok">{selected.period.status}</StatusChip>
          </div>
          <div className="card-body">
            <div className="stat-row">
              <div className="stat">
                <div className="stat-label">Payday</div>
                <div className="stat-value">{fmtDate(ymd10(selected.period.payday))}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Total paid</div>
                <div className="stat-value">{fmt$fromCents(totalPaid)}</div>
              </div>
              <div className="stat">
                <div className="stat-label">Payouts</div>
                <div className="stat-value">{payouts.length}</div>
              </div>
            </div>
          </div>
        </div>
        {payouts.map(po => (
          <PayoutRow
            key={po.id}
            payout={po}
            period={selected.period}
            expanded={expanded.has(po.id)}
            onToggle={() => toggle(po.id)}
            editable={false}
            payable={false}
          />
        ))}
      </>
    );
  }

  const paidPeriods = periods.filter(p => p.status === 'paid');
  return (
    <div className="card">
      <div className="card-head"><h3>Paid periods</h3></div>
      <div className="card-body">
        {selectedLoading && <div className="muted tiny">Loading period…</div>}
        {paidPeriods.length === 0 && <div className="muted tiny">No paid periods yet.</div>}
        {paidPeriods.map(p => (
          <div
            key={p.id}
            id={`history-period-${p.id}`}
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
              <div style={{ fontWeight: 600 }}>
                {fmtDate(ymd10(p.start_date))} – {fmtDate(ymd10(p.end_date))}
              </div>
              <div className="tiny muted">Payday {fmtDate(ymd10(p.payday))}</div>
            </div>
            <div className="num"><strong>{fmt$fromCents(p.total_cents)}</strong></div>
            <StatusChip kind="ok">{p.status}</StatusChip>
            <span className="tiny muted">{Number(p.paid_count)} paid</span>
          </div>
        ))}
      </div>
    </div>
  );
}
