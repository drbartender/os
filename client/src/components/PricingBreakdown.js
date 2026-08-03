import React from 'react';
import { resolveGratuityDisplayLabel } from '../utils/gratuityLabels';

// Match cancel targets (GET /:id/cancel-line/targets entries) to breakdown
// rows by label: exact first, then prefix for parameterized labels like
// "Bar Rental (2 bars)". Each target is consumed at most once. Per-syrup
// targets never match the single aggregate Syrups row and surface via
// `unmatched`, which the page renders under the table so no target is ever
// unreachable (label matching is the codebase's line-identity convention;
// breakdown rows carry no ids). Exported for the pages' unmatched row.
export function matchCancelTargets(snapshot, cancelTargets) {
  const rows = snapshot?.breakdown || [];
  const targets = cancelTargets || [];
  const byRow = new Map();
  const used = new Set();

  // Money must corroborate the label. Labels alone are NOT unique: the engine
  // emits the num_bartenders override row and the additional-bartender add-on
  // row with the same shape ("Additional Bartender(s) (N)", pricingEngine
  // :471 and :498), so a label-only match wired the override row's remove
  // button to the add-on and the confirm step could not tell them apart
  // (both read "Additional Bartender"). Push review, 2026-07-26.
  const cents = (n) => Math.round(Number(n) * 100);
  const amountAgrees = (row, entry) => entry.amount !== null
    && entry.amount !== undefined
    && cents(row.amount) === cents(entry.amount);

  const claim = (i, idx) => { used.add(idx); byRow.set(i, targets[idx]); };

  // Pass 1: exact label AND amount, globally, so an unambiguous row always
  // claims its own target before any prefix logic runs. Same refusal rule as
  // pass 2: TWO exact-matching targets means the binding would be arbitrary —
  // a num_bartenders override and an additional-bartender add-on both emit an
  // identical "Additional Bartender (1)" row, and findIndex silently handed
  // the override row the ADD-ON's cancel target (same dollars, wrong line).
  // An ambiguous row falls to the "other removable items" strip, which names
  // targets explicitly and cannot mis-fire.
  rows.forEach((item, i) => {
    const label = String(item.label || '');
    const candidates = [];
    targets.forEach((e, k) => {
      if (used.has(k) || !e) return;
      if (e.label === label && amountAgrees(item, e)) candidates.push(k);
    });
    if (candidates.length === 1) claim(i, candidates[0]);
  });

  // Pass 2: prefix for parameterized labels ("Bar Rental (2 bars)"), still
  // requiring the amount to agree, and REFUSING to bind when two targets
  // remain plausible. A control that cannot prove which money line it owns
  // must not render on that line; it falls to the "other removable items"
  // strip below the table, which is functional and cannot mis-target.
  rows.forEach((item, i) => {
    if (byRow.has(i)) return;
    const label = String(item.label || '');
    const candidates = [];
    targets.forEach((e, k) => {
      if (used.has(k) || !e || !e.label) return;
      if (label.startsWith(e.label) && amountAgrees(item, e)) candidates.push(k);
    });
    if (candidates.length === 1) claim(i, candidates[0]);
  });

  const unmatched = targets.filter((e, t) => !used.has(t) && e.cancellable && e.target);
  return { byRow, unmatched };
}

export default function PricingBreakdown({ snapshot, compact = false, cancelTargets = null, onCancelLine = null }) {
  if (!snapshot || !snapshot.breakdown) return null;

  const formatCurrency = (amount) => {
    const num = Number(amount);
    const abs = Math.abs(num);
    const formatted = `$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    return num < 0 ? `-${formatted}` : formatted;
  };

  // The action column exists only when the page wired up cancellation; every
  // other mount renders exactly as before.
  const actions = Boolean(cancelTargets && onCancelLine);
  const { byRow } = actions ? matchCancelTargets(snapshot, cancelTargets) : { byRow: new Map() };

  const renderAction = (entry) => {
    if (!entry) return null;
    if (!entry.cancellable && entry.reason === 'orphaned_addon') {
      return (
        <button type="button" className="btn btn-ghost btn-sm" disabled
          title="Edit this in the proposal editor" aria-label={`Cannot remove ${entry.label} here`}>
          ✕
        </button>
      );
    }
    // The package row routes to the cancel-event flow; everything else opens
    // the cancel-line dialog. The page decides via entry.target.
    return (
      <button type="button" className="btn btn-ghost btn-sm"
        aria-label={`Remove ${entry.label}`} title={`Remove ${entry.label}`}
        onClick={() => onCancelLine(entry)}>
        ✕
      </button>
    );
  };

  return (
    <div style={{ width: '100%' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {snapshot.breakdown.map((item, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--line-1)' }}>
              <td style={{ padding: compact ? '0.4rem 0' : '0.6rem 0', color: 'var(--ink-1)' }}>
                {resolveGratuityDisplayLabel(item.label, snapshot)}
              </td>
              <td style={{
                padding: compact ? '0.4rem 0' : '0.6rem 0',
                textAlign: 'right',
                fontWeight: 500,
                whiteSpace: 'nowrap',
                color: Number(item.amount) < 0 ? 'hsl(var(--ok-h) var(--ok-s) 38%)' : 'var(--ink-1)'
              }}>
                {formatCurrency(item.amount)}
              </td>
              {actions && (
                <td style={{ padding: 0, textAlign: 'right', width: 34 }}>
                  {renderAction(byRow.get(i))}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: '2px solid var(--line-3)' }}>
            <td style={{
              padding: compact ? '0.6rem 0' : '0.8rem 0',
              fontWeight: 700,
              fontSize: compact ? '1rem' : '1.1rem',
              color: 'var(--ink-1)'
            }}>
              Total
            </td>
            <td style={{
              padding: compact ? '0.6rem 0' : '0.8rem 0',
              textAlign: 'right',
              fontWeight: 700,
              fontSize: compact ? '1rem' : '1.1rem',
              color: 'var(--ink-1)'
            }}>
              {formatCurrency(snapshot.total)}
            </td>
            {actions && <td style={{ padding: 0, width: 34 }} />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
