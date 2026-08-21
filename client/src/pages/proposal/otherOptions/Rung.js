import React from 'react';
import { fmt } from '../proposalView/helpers';
import { bucketsForSlug, SECTION_ORDER } from '../catalogBuckets';
import { sublineFor } from './ladder';

// One rung of the ladder, plus the two cards that can interrupt committing it.
//
// Extracted from OtherOptionsPanel, which was carrying ladder assembly, drawer
// chrome, the extras strip AND this; the panel is the stateful shell, this is
// the presentation of a single row and its commit states.

// One rung. A flat row, not a card: the ladder reads top to bottom as one
// spectrum, and cards would break it into unrelated choices.
export function Rung({
  entry, anchorTotal, sideways, contentsOpen, onToggleContents, tier, event,
  commit, casualties, onCommit, onProceed, onCancel,
}) {
  const isTier = entry.kind === 'tier';
  const diff = entry.total === null || anchorTotal === null ? null : entry.total - anchorTotal;
  const delta = sideways || diff === null
    ? ''
    : diff === 0
      ? 'same as yours'
      : `${fmt(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than yours`;
  // Always the RUNG's own covers. Falling back to the selected tier meant the
  // bare "Bar service only" row listed the mixers and ice of whatever tier the
  // client happened to be on, promising things bare service does not include.
  // The null-addon row already carries covers: [], which is the truth.
  const buckets = isTier ? byobBuckets(entry, event) : bucketsForSlug(entry.slug);
  const subline = sublineFor(entry, entry.kind);

  return (
    <div className={sideways ? 'oo-rung oo-rung-sideways' : 'oo-rung'}>
      {sideways && <div className="oo-rung-kicker">Sideways, not up · zero proof</div>}
      <div className="oo-rung-top">
        <div className="oo-rung-name">{entry.name}</div>
        <div className="oo-rung-total">
          {entry.total === null ? '—' : fmt(entry.total)}
        </div>
      </div>
      {entry.description && <p className="oo-rung-puts">{entry.description}</p>}
      {!entry.available && entry.reason && <p className="oo-rung-why">{entry.reason}</p>}
      {delta && <div className="oo-rung-delta">{delta}</div>}
      <div className="oo-rung-foot">
        {subline && <span className="oo-rung-sub">{subline}</span>}
        {buckets && (
          <button
            type="button"
            className="oo-contents-toggle"
            onClick={onToggleContents}
            aria-expanded={contentsOpen}
          >
            {contentsOpen ? 'hide what’s included ↑' : 'what’s included? ↓'}
          </button>
        )}
      </div>
      {/* Commit states swap IN PLACE on this row, so the client's eye never
          leaves the rung they acted on. */}
      {entry.available && (!commit || commit.phase === 'refused') && (
        <div className="oo-rung-act">
          {/* Ghost, not solid: the artifact reserves solid amber for the
              anchor's commit, so making every rung solid flattened the
              hierarchy into eight identical primaries AND put cream on amber
              at 3.33:1, under the 4.5 AA needs. Brass-bright on the drawer
              ground measures 9:1. */}
          <button type="button" className="oo-commit oo-commit-ghost" onClick={onCommit}>
            Make this my proposal
          </button>
        </div>
      )}
      {commit && commit.phase === 'inflight' && (
        <span className="oo-commit-busy">Rewriting…</span>
      )}
      {commit && commit.phase === 'refused' && <p className="oo-rung-why">{commit.error}</p>}
      {commit && commit.phase === 'repriced' && (
        <RepriceCard newTotal={entry.total} oldTotal={commit.oldTotal} onConfirm={onProceed} />
      )}
      {commit && commit.phase === 'confirm' && (
        <ConfirmCard {...casualties} onProceed={onProceed} onCancel={onCancel} />
      )}
      {contentsOpen && buckets && (
        <div className="oo-contents">
          {SECTION_ORDER.map((k) => (
            buckets[k] && buckets[k].length ? (
              <div className="oo-contents-group" key={k}>
                <div className="oo-contents-k">{k}</div>
                {buckets[k].map((it, i) => <div className="oo-item" key={i}>· {it}</div>)}
              </div>
            ) : null
          ))}
        </div>
      )}
    </div>
  );
}

// The switch endpoint re-prices under a row lock and refuses if the total moved
// since we quoted it. That is not an error to apologise for: it is the guard
// working, so the card shows the new number and asks for a fresh tap rather
// than committing a price the client never saw.
export function RepriceCard({ newTotal, oldTotal, onConfirm }) {
  return (
    <div className="oo-reprice">
      <div className="oo-reprice-k">Prices moved</div>
      <p className="oo-reprice-body">
        This now totals <strong>{fmt(newTotal)}</strong>, it was {fmt(oldTotal)} a
        moment ago. Nothing has been committed yet.
      </p>
      <button type="button" className="oo-commit" onClick={onConfirm}>
        Confirm at {fmt(newTotal)}
      </button>
    </div>
  );
}

// Never let something disappear off a proposal silently. Two different reasons,
// said differently: not offered on the new rung, versus folded into the bundle
// it comes with.
export function ConfirmCard({ droppedNames, absorbedNames, targetBundleName, onProceed, onCancel }) {
  return (
    <div className="oo-confirm">
      <div className="oo-confirm-k">Before we switch</div>
      {droppedNames.length > 0 && (
        <p className="oo-confirm-body">
          {droppedNames.length > 1
            ? `Your ${droppedNames.join(' and ')} are not offered on this rung, so they come off with this switch.`
            : `Your ${droppedNames[0]} is not offered on this rung, so it comes off with this switch.`}
          {' '}Everything else comes along.
        </p>
      )}
      {absorbedNames.map((n) => (
        <p className="oo-confirm-body" key={n}>
          {n} is included in {targetBundleName}, so it comes off as its own line.
        </p>
      ))}
      <div className="oo-confirm-actions">
        <button type="button" className="oo-commit" onClick={onProceed}>Switch &amp; drop it</button>
        <button type="button" className="oo-back" onClick={onCancel}>Keep what I have</button>
      </div>
    </div>
  );
}

// BYOB has no catalog entry: what lands on the bar is the client's own bottles
// plus whatever the chosen support tier covers, which the server derives from
// the bundle config so this can never drift from what was actually priced.
function byobBuckets(tier, event) {
  const covers = (tier && tier.covers) || [];
  return {
    Spirits: ['Your bottles, poured by us', `Shopping list built for ${event.guest_count || 'your'} guests`],
    'Beer & Wine': ['Your beer and wine, chilled and served'],
    'Mixers & Extras': covers,
    'Non-Alcoholic': covers.length ? ['Bottled water service'] : [],
  };
}

export default Rung;
