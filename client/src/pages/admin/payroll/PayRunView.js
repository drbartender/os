import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import PayoutRow from './PayoutRow';

// pg DATE columns arrive as full ISO strings (Date -> toISOString via
// res.json); slice the calendar date back out before formatting or comparing.
const ymd10 = (v) => (v ? String(v).slice(0, 10) : null);

// Today in the business timezone as YYYY-MM-DD (en-CA formats ISO-style).
const chicagoTodayYmd = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

const CHIP_KIND = { open: 'info', processing: 'warn', reopened: 'violet' };

// The pay-run queue: every non-paid period, current week first, then oldest
// payday first. Each card lazy-loads its payouts on expansion and hosts the
// line editor + pay panel per payout.
export default function PayRunView({ periodParam }) {
  const toast = useToast();
  const [periods, setPeriods] = useState(null); // all periods (rollups) | null while loading
  const [error, setError] = useState(false);
  const [expanded, setExpanded] = useState(null); // Set(period ids) | null until first load
  const loadedRef = useRef(false);
  const focusedRef = useRef(false);

  const load = useCallback(() => {
    api.get('/admin/payroll/periods')
      .then(r => { loadedRef.current = true; setError(false); setPeriods(r.data.periods || []); })
      .catch(() => {
        // A failed refetch keeps the last good queue on screen; only the very
        // first load degrades to the full error state.
        if (loadedRef.current) toast.error('Could not refresh the pay-run queue.');
        else setError(true);
      });
  }, [toast]);

  // Line edits change a pending payout's total; move the queue rollup by the
  // delta so the card's owed figure and the stat strip track the worksheet.
  const patchPeriodOwed = useCallback((periodId, deltaCents) => {
    setPeriods(prev => (prev ? prev.map(p => (p.id === periodId ? {
      ...p,
      owed_cents: Number(p.owed_cents || 0) + deltaCents,
      total_cents: Number(p.total_cents || 0) + deltaCents,
    } : p)) : prev));
  }, []);
  useEffect(() => { load(); }, [load]);

  const derived = useMemo(() => {
    const all = periods || [];
    const today = chicagoTodayYmd();
    const isCurrent = (p) => ymd10(p.start_date) <= today && today <= ymd10(p.end_date);
    const queue = all.filter(p => p.status !== 'paid').sort((a, b) => {
      const cur = Number(isCurrent(b)) - Number(isCurrent(a)); // current-week period leads
      if (cur !== 0) return cur;
      const pa = ymd10(a.payday) || '';
      const pb = ymd10(b.payday) || '';
      if (pa !== pb) return pa < pb ? -1 : 1; // then oldest payday first
      return Number(a.id) - Number(b.id);
    });
    const owedCents = queue.reduce((s, p) => s + Number(p.owed_cents || 0), 0);
    const unpaidCount = queue.reduce((s, p) => s + Number(p.pending_count || 0), 0);
    const month = today.slice(0, 7);
    const paidMonthCents = all
      .filter(p => (ymd10(p.payday) || '').startsWith(month))
      .reduce((s, p) => s + Number(p.paid_cents || 0), 0);
    let oldestWeeks = null;
    const oldestPayday = queue.map(p => ymd10(p.payday)).filter(Boolean).sort()[0];
    if (oldestPayday) {
      const ms = new Date(`${today}T12:00:00`) - new Date(`${oldestPayday}T12:00:00`);
      oldestWeeks = Math.max(0, Math.floor(ms / (7 * 86400000)));
    }
    return { queue, owedCents, unpaidCount, paidMonthCents, oldestWeeks };
  }, [periods]);

  // First load: expand the deep-linked period (scrolled into view) or the top card.
  useEffect(() => {
    if (periods === null || expanded !== null) return;
    const target = periodParam
      ? derived.queue.find(p => String(p.id) === String(periodParam))
      : null;
    const first = target || derived.queue[0];
    setExpanded(new Set(first ? [first.id] : []));
    if (target && !focusedRef.current) {
      focusedRef.current = true;
      setTimeout(() => {
        document.getElementById(`payrun-period-${target.id}`)
          ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 0);
    }
  }, [periods, expanded, periodParam, derived.queue]);

  const toggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev || []);
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

  return (
    <>
      <div className="stat-row" style={{ marginBottom: 'var(--gap)' }}>
        <div className="stat">
          <div className="stat-label">Still owed</div>
          <div className="stat-value">{fmt$fromCents(derived.owedCents)}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Unpaid payouts</div>
          <div className="stat-value">{derived.unpaidCount}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Oldest open</div>
          <div className="stat-value">{derived.oldestWeeks === null ? 'none' : `${derived.oldestWeeks} wk`}</div>
        </div>
        <div className="stat">
          <div className="stat-label">Paid this month</div>
          <div className="stat-value">{fmt$fromCents(derived.paidMonthCents)}</div>
        </div>
      </div>

      {derived.queue.length === 0 && (
        <div className="card"><div className="card-body muted">Nothing owed. Every period is paid.</div></div>
      )}
      {derived.queue.map(p => (
        <PeriodCard
          key={p.id}
          period={p}
          expanded={!!(expanded && expanded.has(p.id))}
          onToggle={() => toggle(p.id)}
          onQueueChanged={load}
          onOwedDelta={patchPeriodOwed}
        />
      ))}
    </>
  );
}

function PeriodCard({ period, expanded, onToggle, onQueueChanged, onOwedDelta }) {
  const toast = useToast();
  const [detail, setDetail] = useState(null); // { period, payouts } | null
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  // Mirror of the latest detail for callbacks that must not read a stale
  // render closure (overlapping PATCHes on two lines of one payout).
  const detailRef = useRef(null);
  useEffect(() => { detailRef.current = detail; }, [detail]);
  const [busy, setBusy] = useState(false);
  const [openRows, setOpenRows] = useState(() => new Set());

  const loadDetail = useCallback(() => {
    setDetailLoading(true);
    setDetailError(false);
    api.get(`/admin/payroll/periods/${period.id}`)
      .then(r => setDetail(r.data))
      .catch(() => setDetailError(true))
      .finally(() => setDetailLoading(false));
  }, [period.id]);

  useEffect(() => {
    if (expanded && detail === null && !detailLoading && !detailError) loadDetail();
  }, [expanded, detail, detailLoading, detailError, loadDetail]);

  // A queue refetch that changed this period's status (processed or reopened,
  // possibly from another tab) makes the cached detail stale. Drop it and let
  // the lazy-load effect above refetch while expanded (or on next expand).
  // Ref-guarded to fire exactly once per status TRANSITION: comparing against
  // the detail object identity here loops forever whenever the queue rollup
  // cannot catch up to a fresher detail.
  const prevStatusRef = useRef(period.status);
  useEffect(() => {
    if (prevStatusRef.current === period.status) return;
    prevStatusRef.current = period.status;
    setDetail(null);
    setDetailError(false);
  }, [period.status]);

  const runProcess = async () => {
    setBusy(true);
    try {
      let resp;
      try {
        resp = await api.post(`/admin/payroll/periods/${period.id}/process`, {});
      } catch (err) {
        const msg = String(err.response?.data?.error || '');
        // Early-process guard: the current week needs a hard confirm + force.
        if (err.response?.status === 409 && msg.includes('still in progress')) {
          const go = window.confirm('This period is still in progress. Events finishing this week will not be added. Process anyway?');
          if (!go) return;
          resp = await api.post(`/admin/payroll/periods/${period.id}/process`, { force: true });
        } else {
          throw err;
        }
      }
      const { data } = resp;
      const fr = data.fee_recapture || {};
      if (Number(fr.tips_null_after) > 0 || Number(fr.tips_line_unhealed) > 0) {
        toast.error('Some card tips are missing their Stripe fee and will pay gross this period. Details are in Sentry.');
      }
      if (data.period_status === 'paid') {
        toast.success('Nothing left to pay. Period closed.');
      } else {
        toast.success('Period frozen. Ready to pay.');
      }
      onQueueChanged(); // status-sync effect reloads the detail off the new prop
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
      if (err.response?.status === 409) onQueueChanged(); // raced: re-render the true state
    } finally {
      setBusy(false);
    }
  };

  const runReopen = async () => {
    if (!window.confirm('Reopen this period to edit lines? Paid payouts stay locked.')) return;
    setBusy(true);
    try {
      await api.post(`/admin/payroll/periods/${period.id}/reopen`);
      toast.success('Period reopened. Pending lines are editable again.');
      onQueueChanged();
    } catch (err) {
      toast.error(err.response?.data?.error || err.message);
      if (err.response?.status === 409) onQueueChanged();
    } finally {
      setBusy(false);
    }
  };

  const handleLineSaved = (updatedEvent, payoutTotal) => {
    // Keep the queue rollup (card "owed" + stat strip) in step with the edit.
    // PATCH only succeeds on pending payouts, so the delta always moves owed.
    // Read from the ref, not the render closure: two in-flight line PATCHes
    // on one payout would otherwise double-count the first delta.
    const current = detailRef.current;
    const before = current && current.payouts.find(po => po.id === updatedEvent.payout_id);
    if (before) onOwedDelta(period.id, payoutTotal - Number(before.total_cents || 0));
    setDetail(prev => (prev ? {
      ...prev,
      payouts: prev.payouts.map(po => (po.id !== updatedEvent.payout_id ? po : {
        ...po,
        total_cents: payoutTotal,
        // Merge instead of replace: the PATCH returns payout_events columns
        // only, without the proposal-join fields the row needs to render.
        events: po.events.map(e => (e.id === updatedEvent.id ? { ...e, ...updatedEvent } : e)),
      })),
    } : prev));
  };

  const handlePaid = ({ payout, period_status }) => {
    setDetail(prev => (prev ? {
      ...prev,
      period: { ...prev.period, status: period_status },
      payouts: prev.payouts.map(po => (po.id === payout.id ? { ...po, ...payout } : po)),
    } : prev));
    onQueueChanged(); // rollups changed; a finalized period leaves the queue
  };

  const toggleRow = (id) => {
    setOpenRows(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const paid = Number(period.paid_count || 0);
  const totalCount = paid + Number(period.pending_count || 0);
  const editable = period.status === 'open' || period.status === 'reopened';

  return (
    <div className="card" style={{ marginBottom: 8 }} id={`payrun-period-${period.id}`}>
      <div
        className="card-head"
        style={{ cursor: 'pointer' }}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <div className="hstack" style={{ gap: 12, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>
            {fmtDate(ymd10(period.start_date))} – {fmtDate(ymd10(period.end_date))}
          </span>
          <StatusChip kind={CHIP_KIND[period.status] || 'neutral'}>{period.status}</StatusChip>
          <span className="tiny muted">paid {paid} of {totalCount}</span>
          <span className="tiny muted">payday {fmtDate(ymd10(period.payday))}</span>
        </div>
        <div className="hstack" style={{ gap: 12 }}>
          <span className="num">
            <strong>{fmt$fromCents(period.owed_cents)}</strong> <span className="tiny muted">owed</span>
          </span>
          {editable && (
            <button
              type="button" className="btn btn-primary btn-sm" disabled={busy}
              onClick={(e) => { e.stopPropagation(); runProcess(); }}
            >
              {period.status === 'reopened' ? 'Re-process period' : 'Process period'}
            </button>
          )}
          {period.status === 'processing' && (
            <button
              type="button" className="btn btn-ghost btn-sm" disabled={busy}
              onClick={(e) => { e.stopPropagation(); runReopen(); }}
            >
              Reopen for corrections
            </button>
          )}
          <span className="tiny muted">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>
      {expanded && (
        <div className="card-body">
          {period.status === 'reopened' && (
            <div className="muted tiny" style={{ marginBottom: 8 }}>
              Reopened for corrections. Pending lines are editable; paid payouts stay locked. Re-process to resume paying.
            </div>
          )}
          {detailLoading && !detail && <div className="muted">Loading…</div>}
          {detailError && !detailLoading && (
            <div className="vstack" style={{ gap: 8 }}>
              <div className="muted">Couldn't load this period.</div>
              <div><button type="button" className="btn btn-ghost btn-sm" onClick={loadDetail}>Retry</button></div>
            </div>
          )}
          {detail && !detailError && (
            <>
              {detail.payouts.length === 0 && (
                <div className="muted tiny">No payouts in this period yet.</div>
              )}
              {detail.payouts.map(po => (
                <PayoutRow
                  key={po.id}
                  payout={po}
                  period={period}
                  expanded={openRows.has(po.id)}
                  onToggle={() => toggleRow(po.id)}
                  onLineSaved={handleLineSaved}
                  onPaid={handlePaid}
                  // Drift/state 409s mean another tab changed this period:
                  // refresh the queue too, so the status prop catches up and
                  // the card renders its true actions.
                  onRefetch={() => { loadDetail(); onQueueChanged(); }}
                  editable={editable}
                  payable
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
