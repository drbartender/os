import React, { useEffect, useMemo, useState } from 'react';
import api from '../../../utils/api';
import EntityLink from '../../../components/EntityLink';
import { fmt$wholeFromCents, fmtDate } from '../../../components/adminos/format';
import { chicagoYmdParts } from '../../../hooks/useMetricsFilter';

// Money-tab payroll status block (spec 2026-07-14 §2 Money): the retired
// PayrollCard's logic with the card chrome dropped. Admin-only: NeedsYouStrip
// mounts this ONLY for admins, so a manager fires zero /admin/payroll/*
// requests (2026-07-09 spec §1 role gating). Read-only surfacing; no
// process/mark-paid actions, no accrual code paths. Not a queue item: overdue
// is reported up as a boolean and feeds the Money tab's danger dot.

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
// comparison flips at Chicago midnight like every other range computation.
function chicagoTodayYmd() {
  const { y, mo, d } = chicagoYmdParts();
  return `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export default function PayrollStatus({ onOverdue }) {
  const [periods, setPeriods] = useState(null);   // array | null
  const [current, setCurrent] = useState(null);   // { period, payouts } | null
  const [periodsErr, setPeriodsErr] = useState(false);
  const [currentErr, setCurrentErr] = useState(false);
  const [deferred, setDeferred] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Two core fetches decide the block body; either failing degrades to link-only.
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
    // renders): its failure only hides the sub-line, never the block.
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

  // Report overdue up so the Money tab's dot (and the default-tab pick) can
  // fire without this block's tab being active. `view` is memoized on the raw
  // inputs, so this cannot loop.
  useEffect(() => {
    if (onOverdue) onOverdue(view.kind === 'due' && Boolean(view.overdue));
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
      <div className={`nat-payroll${view.overdue ? ' is-warn' : ''}`}>{body}</div>
    </EntityLink>
  );
}
