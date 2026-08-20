import React from 'react';
import { Link } from 'react-router-dom';
import StatusChip from '../../../components/adminos/StatusChip';
import { fmt$fromCents } from '../../../components/adminos/format';
import { ymdLabel, windowLabel } from '../staffHub/hubSubtitle';

/**
 * The open week with nothing accrued is the honest common case Tue..Fri
 * (pay_periods rows are created lazily on the first accrual, usually
 * Saturday). PayRunView renders only the rows the periods feed returns and has
 * no notion of "this week", so this card is keyed on the DERIVED window from
 * the hub summary and sits above the queue. It hides as soon as the period has
 * payouts (the queue shows it) or is no longer open, which is how "no row yet
 * this week" and "every period is paid" stay distinguishable.
 *
 * Head shape matches PeriodCard below it deliberately (benchmark artboards
 * 1e/1f): same window, chip, payday and owed slots, minus the actions a period
 * with no row cannot offer.
 */
// ONLY when no pay_periods row exists yet. Corrected 2026-08-20 after a browser
// pass against the live hub: the earlier rule also fired when a row existed,
// was open and had accrued nothing, but GET /admin/payroll/periods returns that
// row too, so PayRunView drew the SAME week directly beneath this card, in a
// different date format, with the Process action this card cannot offer. One
// week, two cards, one of them crippled. Once a row exists the queue owns the
// week; this card exists for the Tuesday-to-Friday gap before accrual mints it.
export function currentWeekCardVisible(openPeriod) {
  if (!openPeriod) return false;
  return !openPeriod.exists;
}

export default function CurrentWeekCard({ openPeriod, pendingReviews = 0, bountyCents = 0 }) {
  const p = openPeriod;
  if (!currentWeekCardVisible(p)) return null;
  const n = Number(pendingReviews) || 0;
  // Never a literal: the figure is the server's REVIEW_BOUNTY_CENTS. When the
  // envelope did not arrive, the sentence drops the amount rather than
  // promising $0.00.
  const bounty = Number(bountyCents) > 0 ? fmt$fromCents(bountyCents) : null;

  return (
    <div className="card" style={{ marginBottom: 8 }}>
      <div className="card-head">
        <div className="hstack" style={{ gap: 12, flex: 1, minWidth: 0, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600 }}>{windowLabel(p.start_date, p.end_date)}</span>
          <StatusChip kind="info">open</StatusChip>
          <span className="tiny muted">payday {ymdLabel(p.payday, { weekday: true })}</span>
        </div>
        <div className="hstack" style={{ gap: 12 }}>
          <span className="num"><strong>{fmt$fromCents(0)}</strong> <span className="tiny muted">owed</span></span>
        </div>
      </div>
      <div className="card-body">
        <div className="muted tiny" style={{ marginBottom: n > 0 ? 10 : 0 }}>
          Nothing accrued yet. Shift pay, tips and review bounties land here on their own as events close out.
        </div>
        {n > 0 && (
          <div
            className="hstack"
            style={{
              gap: 10,
              padding: '9px 12px',
              background: 'var(--accent-soft)',
              border: '1px solid var(--line-1)',
              borderRadius: 4,
            }}
          >
            <span className="hub-tab-badge">{n}</span>
            <span style={{ fontSize: 12, flex: 1 }}>
              {n} pending {n === 1 ? 'review' : 'reviews'}. A confirmed five-star review with a name adds{' '}
              {bounty ? <strong className="num">{bounty}</strong> : 'the review bounty'} to the next open run.{' '}
              <Link to="/staffing/reviews">Confirm under Reviews</Link>.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
