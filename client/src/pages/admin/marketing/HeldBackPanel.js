import React from 'react';
import { HELD_BACK_LABELS } from './marketingFormat';

/**
 * Who in the current view cannot be emailed, and why. Renders as the
 * "Always held back" region inside the selected-audience card (spec §10).
 *
 * The buckets are exclusive by construction (the server classifies each row
 * with a single CASE, not four independent counts) and they are computed over
 * the whole filtered base rather than the current page, so mailable plus the
 * four reasons equals the total. That identity is the point: it lets an
 * operator trust the emailable number on an audience.
 *
 * The design showed three reasons. `no_address` is the fourth the resolver can
 * produce and it is shown rather than hidden, because a contact held back with
 * no visible reason is the one thing an operator cannot act on.
 */
export default function HeldBackPanel({ heldBack, total }) {
  if (!heldBack) return null;

  const rows = Object.keys(HELD_BACK_LABELS)
    .map(key => ({ key, label: HELD_BACK_LABELS[key], count: heldBack[key] || 0 }))
    .filter(r => r.count > 0);

  const sum = rows.reduce((a, r) => a + r.count, 0) + (heldBack.mailable || 0);

  return (
    <div>
      <div className="mkt-eyebrow">Always held back</div>
      {rows.length === 0 ? (
        <p className="muted tiny" style={{ margin: 0 }}>Nobody in this view is held back.</p>
      ) : (
        <ul className="mkt-heldback-list">
          {rows.map(r => (
            <li key={r.key}>
              <span>{r.label}</span>
              <span>{r.count}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mkt-heldback-total">
        {sum} in this view, {heldBack.mailable || 0} emailable
        {/* If this ever disagrees with `total`, the buckets have stopped being
            exclusive and the emailable number can no longer be trusted. Say so
            rather than rendering a quietly wrong total. */}
        {Number.isFinite(total) && sum !== total && (
          <strong className="mkt-warn"> (does not match the list total of {total})</strong>
        )}
      </div>
    </div>
  );
}
