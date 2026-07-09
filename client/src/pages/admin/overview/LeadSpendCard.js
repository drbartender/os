import React from 'react';
import EntityLink from '../../../components/EntityLink';
import { fmt$wholeFromCents } from '../../../components/adminos/format';

// Thumbtack lead-spend detail (spec §5: the Lead-spend tile scrolls here, this
// card IS the detail). All lead-spend figures arrive as CENTS
// (financials summary.leadSpend.*Cents) → fmt$wholeFromCents. Total and Charged
// are non-links, styled non-interactive; only "Attributed" links out to the won
// cohort that carries a Thumbtack source. The attribution bar visualises how much
// spend is tied to a booking; the note explains the unattributed remainder.
export default function LeadSpendCard({ leadSpend, from, to }) {
  const ls = leadSpend || {};
  const totalCents = Number(ls.totalCents || 0);
  const attributedCents = Number(ls.attributedCents || 0);
  const unattributedCents = Number(ls.unattributedCents || 0);
  const chargedLeads = Number(ls.chargedLeads || 0);
  const attributedLeads = Number(ls.attributedLeads || 0);
  const rq = (from && to) ? `&from=${from}&to=${to}` : '';
  const pct = totalCents > 0 ? Math.round((attributedCents / totalCents) * 100) : 0;

  return (
    <div className="card" id="ov-leadspend">
      <div className="card-head"><h3>Lead spend</h3><span className="k">Thumbtack</span></div>
      <div className="card-body vstack" style={{ gap: '0.6rem' }}>
        <div className="ls-rows">
          <div className="ls-row">
            <span className="ls-label">Total</span>
            <span className="ls-num">{fmt$wholeFromCents(totalCents)}</span>
          </div>
          <div className="ls-row">
            <EntityLink to={`/proposals?source=thumbtack&cohort=won${rq}`} className="ls-label ls-attr-link">Attributed</EntityLink>
            <span className="ls-num">{fmt$wholeFromCents(attributedCents)}</span>
          </div>
          <div className="ls-row">
            <span className="ls-label">Charged leads</span>
            <span className="ls-num">{chargedLeads}</span>
          </div>
        </div>

        <div className="attr-bar" role="img"
          aria-label={`${pct}% of lead spend attributed to booked events`}>
          <div className="attr-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="tiny muted">
          {fmt$wholeFromCents(attributedCents)} tied to {attributedLeads} booked {attributedLeads === 1 ? 'event' : 'events'} ({pct}%).
          {unattributedCents > 0 && ` ${fmt$wholeFromCents(unattributedCents)} not tied to a booking.`}
        </div>
      </div>
    </div>
  );
}
