import React, { useEffect, useMemo, useState } from 'react';
import api from '../../../utils/api';
import EntityLink from '../../../components/EntityLink';
import Icon from '../../../components/adminos/Icon';
import { fmt$wholeFromCents, fmtDate } from '../../../components/adminos/format';
import { chicagoYmdParts } from '../../../hooks/useMetricsFilter';

// Band 1 payroll card (spec §8). Admin-only: OverviewPage mounts this ONLY for
// admins, so a manager fires zero /admin/payroll/* requests (§1 role gating).
// Read-only surfacing; no process/mark-paid actions, no accrual code paths.

const PAYROLL_HREF = '/financials/payroll';

// pg DATE columns arrive as full ISO strings (Date -> toISOString via res.json); ymd10 slices the calendar date back out; keep
// only the calendar date so the weekday math and string compares stay stable.
const ymd10 = (v) => (v ? String(v).slice(0, 10) : null);

const weekday = (v, opt = 'long') => {
  const s = ymd10(v);
  if (!s) return '';
  const d = new Date(s + 'T12:00:00');
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { weekday: opt });
};

// Today in the business timezone (America/Chicago) as YYYY-MM-DD, so the payday
// comparison flips at Chicago midnight like every other range computation (§4).
function chicagoTodayYmd() {
  const { y, mo, d } = chicagoYmdParts();
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const periodRange = (p) => `${fmtDate(ymd10(p.start_date))} – ${fmtDate(ymd10(p.end_date))}`;

export default function PayrollCard({ onOverdue }) {
  const [periods, setPeriods] = useState(null);   // array | null
  const [current, setCurrent] = useState(null);   // { period, payouts } | null
  const [periodsErr, setPeriodsErr] = useState(false);
  const [currentErr, setCurrentErr] = useState(false);
  const [deferred, setDeferred] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Two core fetches decide the card body; either failing degrades to link-only.
    Promise.allSettled([
      api.get('/admin/payroll/periods'),
      api.get('/admin/payroll/periods/current'),
    ]).then(([pRes, cRes]) => {
      if (cancelled) return;
      if (pRes.status === 'fulfilled') setPeriods(pRes.value.data?.periods || []);
      else setPeriodsErr(true);
      if (cRes.status === 'fulfilled') setCurrent(cRes.value.data || { period: null, payouts: [] });
      else setCurrentErr(true);
      setLoading(false);
    });
    // Deferred-tips count is a non-blocking extra (same source DeferredTipsPanel
    // renders): its failure only hides the sub-line, never the card.
    api.get('/admin/payroll/deferred-tips')
      .then(r => { if (!cancelled) setDeferred((r.data?.tips || []).length); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const view = useMemo(() => {
    if (loading) return { kind: 'loading', href: PAYROLL_HREF };
    if (periodsErr || currentErr) return { kind: 'error', href: PAYROLL_HREF };

    // Most recent closed-but-unpaid period = the next check to cut. Periods come
    // ordered start_date DESC, so find() returns the most recent. 'processing' is
    // the frozen/being-paid state; a pending payout remains -> still due.
    const due = (periods || []).find(
      p => p.status === 'processing' && Number(p.pending_count || 0) > 0
    );
    if (due) {
      const total = Number(due.total_cents || 0);
      const staff = Number(due.paid_count || 0) + Number(due.pending_count || 0);
      const overdue = chicagoTodayYmd() > ymd10(due.payday);
      return {
        kind: 'due',
        headline: `Due ${weekday(due.payday) || 'soon'}`,
        total, staff, overdue,
        href: `/financials/payroll?tab=history&period=${due.id}`,
        overdueItem: overdue ? {
          id: 'payroll-overdue', type: 'payroll', priority: 'danger',
          title: 'Payroll overdue',
          sub: `${periodRange(due)} · due ${fmtDate(ymd10(due.payday))}`,
          meta: fmt$wholeFromCents(total), target: 'payroll', ref: null,
        } : null,
      };
    }

    const openPeriod = current && current.period;
    if (openPeriod) {
      const payouts = current.payouts || [];
      const total = payouts.reduce((acc, p) => acc + Number(p.total_cents || 0), 0);
      const wd = weekday(openPeriod.payday, 'short');
      return {
        kind: 'accruing',
        headline: 'Accruing this week',
        total, staff: payouts.length,
        sub: `pays ${wd ? wd + ' ' : ''}${fmtDate(ymd10(openPeriod.payday))}`,
        href: PAYROLL_HREF,
      };
    }

    return { kind: 'empty', href: PAYROLL_HREF };
  }, [loading, periodsErr, currentErr, periods, current]);

  // Report the overdue Needs-you item up to OverviewPage. Admin-only by
  // construction: this card only mounts for admins. `view` is memoized on the raw
  // inputs, so `view.overdueItem` is referentially stable and this cannot loop.
  useEffect(() => {
    if (onOverdue) onOverdue(view.overdueItem || null);
  }, [onOverdue, view]);

  const deferredLine = deferred > 0 && (
    <span className="tiny muted">{deferred} deferred tip{deferred === 1 ? '' : 's'}</span>
  );

  let body;
  if (view.kind === 'loading') {
    body = <div className="muted tiny">Loading&hellip;</div>;
  } else if (view.kind === 'error') {
    body = <div className="muted tiny">Couldn't load payroll.</div>;
  } else if (view.kind === 'empty') {
    body = (
      <div className="ov-payroll-subs">
        <span className="tiny muted">No open period.</span>
        {deferredLine}
      </div>
    );
  } else {
    // due | accruing
    body = (
      <>
        <div className="ov-payroll-headline">
          {view.headline}
          {view.overdue && <span className="chip warn ov-payroll-tag">Overdue</span>}
        </div>
        <div className="stat-value ov-payroll-total">{fmt$wholeFromCents(view.total)}</div>
        <div className="ov-payroll-subs">
          <span className="tiny muted">{view.staff} staff</span>
          {view.sub && <span className="tiny muted">{view.sub}</span>}
          {deferredLine}
        </div>
      </>
    );
  }

  return (
    <EntityLink to={view.href} className="ov-payroll-link">
      <div className={`card ov-payroll-card${view.overdue ? ' is-warn' : ''}`}>
        <div className="card-head">
          <h3><Icon name="dollar" size={12} /> Payroll</h3>
          <Icon name="right" size={14} className="ov-payroll-arrow" />
        </div>
        <div className="card-body">{body}</div>
      </div>
    </EntityLink>
  );
}
