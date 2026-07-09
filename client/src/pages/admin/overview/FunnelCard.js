import React from 'react';
import EntityLink from '../../../components/EntityLink';
import Icon from '../../../components/adminos/Icon';
import { fmt$ } from '../../../components/adminos/format';

// Quoted / Won / Lost / Open-now funnel. Each row is a real link carrying the
// exact cohort semantics of the number (spec §5 click map): quoted/won/lost drill
// to the mirrored cohort on the current range; "Open now" is the live pipeline and
// drills to the active proposals with NO date params. All values are DOLLARS
// (dashboard-stats funnel.*, server toDollars). The footer notes are plain text,
// non-interactive by declaration (spec §5).
export default function FunnelCard({ funnel, from, to }) {
  const rq = (from && to) ? `&from=${from}&to=${to}` : '';
  const sent = funnel.sent || { count: 0, value: 0 };
  const accepted = funnel.accepted || { count: 0, value: 0 };
  const lostValue = Number(funnel.lostValue || 0);
  const pipe = funnel.pipelineOutstanding || { count: 0, value: 0 };
  const median = funnel.timeToAcceptMedianDays;

  const rows = [
    { key: 'quoted', label: 'Quoted', count: sent.count, value: sent.value, href: `/proposals?cohort=quoted${rq}` },
    { key: 'won', label: 'Won', count: accepted.count, value: accepted.value, href: `/proposals?cohort=won${rq}`, tone: 'ok' },
    { key: 'lost', label: 'Lost', count: null, value: lostValue, href: `/proposals?cohort=lost${rq}`, tone: 'danger' },
    { key: 'open', label: 'Open now', count: pipe.count, value: pipe.value, href: '/proposals?tab=active&status=sent,viewed,modified', live: true },
  ];

  return (
    <div className="card">
      <div className="card-head"><h3>Funnel</h3><span className="k">By cohort</span></div>
      <div className="card-body" style={{ padding: '0.4rem 0.5rem' }}>
        {rows.map(r => (
          <EntityLink key={r.key} to={r.href} className="funnel-row">
            <span className="funnel-name">
              {r.label}
              {r.live && <span className="k" style={{ marginLeft: 6 }}>Live</span>}
            </span>
            <span className="funnel-count">{r.count == null ? '' : r.count}</span>
            <span className={`funnel-value${r.tone ? ` ${r.tone}` : ''}`}>{fmt$(r.value)}</span>
            <Icon name="right" className="funnel-arrow" />
          </EntityLink>
        ))}
      </div>
      <div className="funnel-foot">
        {median == null ? 'No median accept time yet' : `Median ${median}d from sent to accepted`}
        {' · '}Open now is live and ignores the date range
      </div>
    </div>
  );
}
