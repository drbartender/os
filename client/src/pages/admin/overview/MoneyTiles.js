import React, { useState } from 'react';
import Icon from '../../../components/adminos/Icon';
import EntityLink from '../../../components/EntityLink';
import { fmt$, fmt$wholeFromCents } from '../../../components/adminos/format';
import { eraOverlaps } from './OverviewPage';

// Five money tiles (spec §2 / §5). Aggregates render as whole dollars.
// Interaction law: a tile either LINKS OUT (Outstanding), SCROLLS to its detail
// card (Lead spend), or EXPANDS IN PLACE (Close rate, Collected, Avg event).
// Expandable tiles carry a chevron + aria-expanded, one open at a time; every
// sub-line inside a panel is non-affording (default cursor, no hover) except the
// single native cohort link, which is a real EntityLink.
//
// Money units (server metadata.js response, fleet cross-confirmed):
//   dashboard-stats money.outstanding / funnel.*   → DOLLARS
//   financials summary.collected / booked / avgEvent → DOLLARS (server toDollars)
//   financials summary.unlinkedRefundsCents / leadSpend.totalCents → CENTS
// so cents fields use fmt$wholeFromCents and dollar fields use fmt$; never a
// shared divide.
export default function MoneyTiles({ money, funnel, summary, from, to, onScrollTo }) {
  const [open, setOpen] = useState(null);

  const wr = funnel.winRate || {};
  const median = funnel.timeToAcceptMedianDays;
  const collected = Number(summary.collected || 0);
  const outstanding = Number(money.outstanding || 0);
  const outstandingDeltaPct = money.outstandingDeltaPct;
  const booked = Number(summary.booked || 0);
  const avgEvent = Number(summary.avgEvent || 0);
  const wonCount = funnel.accepted?.count || 0;
  const unlinkedRefundsCents = Number(summary.unlinkedRefundsCents || 0);
  const leadTotalCents = Number(summary.leadSpend?.totalCents || 0);
  const overlaps = eraOverlaps(from);

  // Drill-out ranges carry the current from/to (omitted when All time).
  const rq = (from && to) ? `&from=${from}&to=${to}` : '';
  const quotedHref = `/proposals?cohort=quoted${rq}`;
  const wonHref = `/proposals?cohort=won${rq}`;

  const toggle = (key) => setOpen((cur) => (cur === key ? null : key));

  return (
    <div className="money-tiles-wrap" style={{ marginBottom: 'var(--gap)' }}>
      <div className="money-tiles">
        {/* Close rate — expands */}
        <button type="button" className={`mtile${open === 'close' ? ' is-open' : ''}`}
          aria-expanded={open === 'close'} onClick={() => toggle('close')}>
          <div className="mtile-label">Close rate <Icon name="down" className="mtile-chev" /></div>
          <div className="mtile-value">{wr.pct == null ? '—' : `${wr.pct}%`}</div>
          <div className="mtile-sub">{wr.acceptedFromCohort || 0} of {wr.sentCohort || 0} quoted</div>
        </button>

        {/* Collected — expands */}
        <button type="button" className={`mtile${open === 'collected' ? ' is-open' : ''}`}
          aria-expanded={open === 'collected'} onClick={() => toggle('collected')}>
          <div className="mtile-label">Collected <Icon name="down" className="mtile-chev" /></div>
          <div className="mtile-value" style={{ color: 'hsl(var(--ok-h) var(--ok-s) 52%)' }}>{fmt$(collected)}</div>
          <div className="mtile-sub">{booked > 0 ? `${Math.round((collected / booked) * 100)}% of booked` : 'net of refunds'}</div>
        </button>

        {/* Outstanding — links out (point in time, no date params). tab=all is
            load-bearing: the default active bucket hides deposit_paid rows, which
            carry most open balances; view=all matches qOutstanding's status scope. */}
        <EntityLink to="/proposals?tab=all&balance=open" className="mtile mtile-link">
          <div className="mtile-label">Outstanding <Icon name="right" className="mtile-out" /></div>
          <div className="mtile-value" style={{ color: outstanding > 0 ? 'hsl(var(--warn-h) var(--warn-s) 58%)' : '' }}>{fmt$(outstanding)}</div>
          <div className="mtile-sub">
            {outstandingDeltaPct == null ? 'open balances' : `${outstandingDeltaPct >= 0 ? '▲' : '▼'} ${Math.abs(outstandingDeltaPct)}% vs prior`}
          </div>
        </EntityLink>

        {/* Avg event — expands */}
        <button type="button" className={`mtile${open === 'avg' ? ' is-open' : ''}`}
          aria-expanded={open === 'avg'} onClick={() => toggle('avg')}>
          <div className="mtile-label">Avg event <Icon name="down" className="mtile-chev" /></div>
          <div className="mtile-value">{fmt$(avgEvent)}</div>
          <div className="mtile-sub">{wonCount} {wonCount === 1 ? 'event' : 'events'} won</div>
        </button>

        {/* Lead spend — scrolls to the Lead-spend card (its detail) */}
        <button type="button" className="mtile mtile-link" onClick={() => onScrollTo && onScrollTo('ov-leadspend')}>
          <div className="mtile-label">Lead spend <Icon name="down" className="mtile-out" /></div>
          <div className="mtile-value">{fmt$wholeFromCents(leadTotalCents)}</div>
          <div className="mtile-sub">Thumbtack · see below</div>
        </button>
      </div>

      {open === 'close' && (
        <div className="mtile-panel">
          <div className="mtile-line">{wr.acceptedFromCohort || 0} of {wr.sentCohort || 0} quoted accepted · {wr.pending || 0} still pending</div>
          <div className="mtile-line">{median == null ? 'No median accept time yet' : `Median ${median}d to accept`}</div>
          <div className="mtile-line">
            <EntityLink to={quotedHref} className="mtile-cohort">View the quoted cohort</EntityLink>
          </div>
          {overlaps && (
            <>
              <div className="mtile-line mtile-cc">This rate blends the frozen ledger (before May '26). Use History to isolate Since May '26 vs Before May '26.</div>
              <div className="mtile-line mtile-cc">Before May '26 · frozen ledger keeps no row-level records</div>
            </>
          )}
        </div>
      )}

      {open === 'collected' && (
        <div className="mtile-panel">
          <div className="mtile-line">{fmt$(collected)} collected, net of every refund</div>
          {unlinkedRefundsCents > 0 && (
            <div className="mtile-line">{fmt$wholeFromCents(unlinkedRefundsCents)} of that is refunds not tied to a payment row below</div>
          )}
          <div className="mtile-line">
            <button type="button" className="mtile-cohort mtile-jump" onClick={() => onScrollTo && onScrollTo('ov-payments')}>
              Jump to payments in range
            </button>
          </div>
          {overlaps && (
            <div className="mtile-line mtile-cc">Includes the frozen ledger (before May '26); the payments list shows native rows only.</div>
          )}
        </div>
      )}

      {open === 'avg' && (
        <div className="mtile-panel">
          <div className="mtile-line">{fmt$(booked)} booked ÷ {wonCount} {wonCount === 1 ? 'event' : 'events'} = {fmt$(avgEvent)}</div>
          <div className="mtile-line">
            <EntityLink to={wonHref} className="mtile-cohort">View the {wonCount} won {wonCount === 1 ? 'event' : 'events'}</EntityLink>
          </div>
          {overlaps && (
            <div className="mtile-line mtile-cc">Booked blends the frozen ledger (before May '26); the won list shows native rows only.</div>
          )}
        </div>
      )}
    </div>
  );
}
