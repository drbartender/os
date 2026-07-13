import React from 'react';
import EntityLink from '../../../components/EntityLink';
import Icon from '../../../components/adminos/Icon';
import { fmt$ } from '../../../components/adminos/format';
import { EVENT_TYPES } from '../../../utils/eventTypes';
import { eraOverlaps } from './OverviewPage';

// Quoted / Won / Lost / Open-now funnel. Each row is a real link carrying the
// exact cohort semantics of the number (spec §5 click map): quoted/won/lost drill
// to the mirrored cohort on the current range; "Open now" is the live pipeline and
// drills to the active proposals with NO date params. All values are DOLLARS
// (dashboard-stats funnel.*, server toDollars). The footer notes are plain text,
// non-interactive by declaration (spec §5).
//
// SPLIT-BY (split-by lane): the card head gains a small seg
// `Split: None | Source | Type`. None renders the funnel body byte-identically.
// A split renders the segment table over the lazy metrics-split fetch (owned by
// OverviewPage), reconciling exactly with the funnel numbers above.

const SPLIT_OPTS = [
  { id: '', label: 'None' },
  { id: 'source', label: 'Source' },
  { id: 'event_type', label: 'Type' },
];

// Era honesty (spec §9): shown only when the range overlaps the frozen ledger.
const ERA_SPLIT_NOTE = 'Splits cover DRB records only. The frozen ledger keeps no type or source detail.';

// event_type slug → label via the shared vocabulary; title-cased fallback for an
// unknown slug; the sentinel renders "No type set".
const TYPE_LABELS = Object.fromEntries(EVENT_TYPES.map(t => [t.id, t.label]));
function titleCase(slug) {
  return String(slug).split('-').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
function segLabel(by, key) {
  if (key === '__other') return 'Everything else';
  if (by === 'source') {
    if (key === 'thumbtack') return 'Thumbtack';
    if (key === 'direct') return 'Direct';
    return titleCase(key);
  }
  if (key === '__untyped') return 'No type set';
  return TYPE_LABELS[key] || titleCase(key);
}

// Drill-out href per the spec §7 click map (parameterized to the list route's
// own filters). __other has no honest single filter → null (non-affording). An
// unknown future source has no list filter either → null. Event-type rows carry
// the normalized key (incl. the __untyped sentinel), which the list route
// normalizes on both sides so the link lands on ALL of the segment's rows.
function segHref(by, key, rq) {
  if (key === '__other') return null;
  if (by === 'source') {
    if (key === 'thumbtack') return `/proposals?cohort=quoted&source=thumbtack${rq}`;
    if (key === 'direct') return `/proposals?cohort=quoted&source=manual${rq}`;
    return null;
  }
  return `/proposals?cohort=quoted&event_type=${encodeURIComponent(key)}${rq}`;
}

function SplitRows({ by, segments, rq }) {
  return (
    <div className="splitby-body">
      <div className="splitby-head">
        <span>{by === 'source' ? 'Source' : 'Type'}</span>
        <span className="splitby-num">Quoted</span>
        <span className="splitby-num">Won</span>
        <span className="splitby-close-h">Close</span>
      </div>
      {segments.map(s => {
        const href = segHref(by, s.key, rq);
        const pct = s.closeRatePct;
        const inner = (
          <>
            <span className="splitby-name">{segLabel(by, s.key)}</span>
            <span className="splitby-num splitby-quoted">{s.sent.count}</span>
            <span className="splitby-num splitby-won">{s.won.count} · {fmt$(s.won.value)}</span>
            <span className="splitby-close">
              <span className="splitby-pct">{pct == null ? '—' : `${pct}%`}</span>
              <span className="bar"><span className="bar-fill ok" style={{ width: `${pct == null ? 0 : pct}%` }} /></span>
            </span>
          </>
        );
        return href
          ? <EntityLink key={s.key} to={href} className="splitby-row">{inner}</EntityLink>
          : <div key={s.key} className="splitby-row is-other">{inner}</div>;
      })}
    </div>
  );
}

export default function FunnelCard({
  funnel, from, to,
  split = '', onSplitChange = () => {},
  splitData = null, splitLoading = false, splitError = false, onRetrySplit = () => {},
}) {
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

  const segments = Array.isArray(splitData?.segments) ? splitData.segments : [];
  // Gate on the response's own `by`: during a Source/Type toggle the previous
  // split's rows would otherwise paint under the new dimension for one network
  // round-trip, producing lying drill-out links (review finding). A by switch
  // forces the Loading state; a same-by range change keeps the old rows.
  const hasSplitData = splitData != null && Array.isArray(splitData.segments) && splitData.by === split;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Funnel</h3>
        <div className="seg splitby-seg">
          {SPLIT_OPTS.map(o => (
            <button
              key={o.id || 'none'}
              type="button"
              className={split === o.id ? 'active' : ''}
              onClick={() => onSplitChange(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {split === '' ? (
        <>
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
        </>
      ) : (
        <div className="card-body" style={{ padding: '0.4rem 0.5rem' }}>
          {splitError ? (
            <div className="splitby-state">
              Couldn't load the split.{' '}
              <button type="button" className="btn btn-secondary btn-sm" onClick={onRetrySplit}>Retry</button>
            </div>
          ) : (splitLoading && !hasSplitData) ? (
            <div className="splitby-state muted">Loading…</div>
          ) : segments.length === 0 ? (
            <div className="splitby-state muted">No quotes in this range</div>
          ) : (
            <>
              <SplitRows by={split} segments={segments} rq={rq} />
              {eraOverlaps(from) && <div className="splitby-note">{ERA_SPLIT_NOTE}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
