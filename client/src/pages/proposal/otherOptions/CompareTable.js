import React from 'react';
import { fmt, DEPOSIT_DOLLARS } from '../proposalView/helpers';
import { SECTION_ORDER } from '../catalogBuckets';

// The side-by-side table. Three fixed slots: pinning fewer leaves an invitation
// to add another rather than a collapsed layout, so the comparison always reads
// as a comparison.
//
// The point of this table is DIFFERENCE. Bucketed contents alone still make a
// reader diff two lists by eye, so each item is marked: carried by every pinned
// option, or only by this one. That marking is the whole reason the surface
// exists — "the list is run together and hard to compare" was the complaint.
//
// ARIA: the layout is one CSS grid with cells as direct children, so rows are
// wrapped in `display: contents` elements that exist purely to carry role="row".
// Without them a screen reader reads "Price for your event, $3,410, $2,210,
// $2,690" with nothing tying a number to an option.
const SLOTS = 3;

function markItems(perColumn) {
  const counts = new Map();
  const filled = perColumn.filter((items) => items !== null).length;
  perColumn.forEach((items) => {
    // Dedupe within a column first: bucketFor deliberately merges several
    // catalog sections into one bucket, so the same item can land twice and
    // would otherwise inflate the count into a false "on all of them".
    new Set(items || []).forEach((it) => counts.set(it, (counts.get(it) || 0) + 1));
  });
  return { counts, filled };
}

export default function CompareTable({
  columns, event, onBack, onAddMore, onChoose, currentPackageId, extrasCount,
}) {
  const slots = [...columns];
  while (slots.length < SLOTS) slots.push(null);
  const cols = slots.slice(0, SLOTS);

  // null means "we don't know what's in this one" (no catalog entry), which is
  // NOT the same as "this one has none of that". An uncatalogued package must
  // not claim "No liquor on this one" about a bar we have no contents list for.
  const itemsIn = (col, heading) => {
    if (!col || !col.buckets) return null;
    return col.buckets[heading] || [];
  };
  const uncatalogued = (col) => !!col && !col.buckets;

  const activeSections = SECTION_ORDER.filter((heading) => {
    const per = cols.map((c) => itemsIn(c, heading));
    return per.some((items) => items && items.length > 0);
  });

  const extrasNote = extrasCount > 0
    ? `incl. up to ${extrasCount} extra${extrasCount > 1 ? 's' : ''}`
    : '';

  const Row = ({ label, children, header }) => (
    <div className="oo-row" role="row">
      <div className="oo-cell oo-rowlabel" role={header ? 'presentation' : 'rowheader'}>{label}</div>
      {children}
    </div>
  );

  return (
    <div className="oo-compare">
      <button type="button" className="oo-back" onClick={onBack}>
        &larr; Change what&apos;s compared
      </button>

      <div className="oo-compare-head">
        <h2 className="oo-h2">Held up against each other.</h2>
        <div className="oo-fixed">
          <div className="oo-fixed-k">Fixed for every option</div>
          <div className="oo-fixed-v">{event.line}</div>
        </div>
      </div>

      {/* Focusable so a keyboard-only user can actually reach columns 2 and 3,
          which are off-screen on a phone by design. */}
      <div className="oo-table-scroll" tabIndex={0} role="region" aria-label="Comparison of your options">
        <div className="oo-table" role="table" style={{ '--oo-cols': SLOTS }}>
          <Row label="" header>
            {cols.map((c, i) => (
              <div className="oo-cell oo-colhead" role="columnheader" key={`h${i}`}>
                {c ? (
                  <>
                    <span className="oo-badge">{c.badge}</span>
                    <div className="oo-colname">{c.name}</div>
                    {c.package_id === currentPackageId && <span className="oo-yours">Yours</span>}
                  </>
                ) : (
                  <button type="button" className="oo-addmore" onClick={onAddMore}>+ Add one more</button>
                )}
              </div>
            ))}
          </Row>

          <Row label="Price for your event">
            {cols.map((c, i) => (
              <div className="oo-cell" role="cell" key={`p${i}`}>
                {c && (
                  <>
                    <span className="oo-price">{c.total === null ? '—' : fmt(c.total)}</span>
                    {(extrasNote || c.isByob) && (
                      <div className="oo-note">
                        {[extrasNote, c.isByob ? '+ the alcohol you buy' : ''].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </>
                )}
              </div>
            ))}
          </Row>

          <Row label="Deposit today">
            {cols.map((c, i) => (
              <div className="oo-cell" role="cell" key={`d${i}`}>{c ? fmt(DEPOSIT_DOLLARS) : ''}</div>
            ))}
          </Row>

          {activeSections.map((heading) => {
            const per = cols.map((c) => itemsIn(c, heading));
            const { counts, filled } = markItems(per);
            return (
              <Row label={heading} key={heading}>
                {per.map((items, i) => {
                  if (items === null) {
                    return (
                      <div className="oo-cell" role="cell" key={`${heading}${i}`}>
                        {uncatalogued(cols[i]) && (
                          <span className="oo-gap">Confirmed with your planner</span>
                        )}
                      </div>
                    );
                  }
                  if (!items.length) {
                    return (
                      <div className="oo-cell" role="cell" key={`${heading}${i}`}>
                        <span className="oo-gap">
                          {heading === 'Spirits' ? 'No liquor on this one' : 'Not part of this one'}
                        </span>
                      </div>
                    );
                  }
                  return (
                    <div className="oo-cell" role="cell" key={`${heading}${i}`}>
                      <ul className="oo-items">
                        {[...new Set(items)].map((text) => {
                          // Three states, only two earn a label. "Only on this
                          // one" must mean literally one column, not merely
                          // "not in all of them" — an item shared by two of
                          // three is neither, and labelling it "only on this
                          // one" twice on one screen is just false.
                          const n = counts.get(text);
                          const everywhere = filled > 1 && n === filled;
                          const alone = filled > 1 && n === 1;
                          return (
                            <li key={text} className={alone ? 'oo-item oo-item-unique' : 'oo-item'}>
                              {text}
                              {alone && <span className="oo-tag">only on this one</span>}
                              {everywhere && <span className="oo-tag oo-tag-quiet">on all of them</span>}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                })}
              </Row>
            );
          })}

          <Row label="Who buys the alcohol">
            {cols.map((c, i) => (
              <div className="oo-cell oo-quiet" role="cell" key={`w${i}`}>
                {c && (c.isByob
                  ? `You do, from a shopping list we build${event.guest_count ? ` for ${event.guest_count} guests` : ''}.`
                  : 'We do. Nothing to shop for, nothing left over.')}
              </div>
            ))}
          </Row>

          <Row label="" header>
            {cols.map((c, i) => (
              <div className="oo-cell" role="cell" key={`c${i}`}>
                {c && (c.package_id === currentPackageId
                  ? <span className="oo-current-note">What we prescribed</span>
                  : (
                    <button type="button" className="oo-choose" onClick={() => onChoose(c)}>
                      I want this one
                    </button>
                  ))}
              </div>
            ))}
          </Row>
        </div>
      </div>
    </div>
  );
}
