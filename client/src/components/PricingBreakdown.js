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
  // Pass 1: GLOBAL exact matches first, so a bare-label row always claims its
  // own target before any prefix logic runs.
  rows.forEach((item, i) => {
    const label = String(item.label || '');
    const t = targets.findIndex((e, idx) => !used.has(idx) && e && e.label === label);
    if (t !== -1) { used.add(t); byRow.set(i, targets[t]); }
  });
  // Pass 2: prefix for parameterized labels ("Bar Rental (2 bars)",
  // "Wine Service (100 guests)"), LONGEST target label winning so
  // "Wine Service" beats "Wine" on a Wine Service row. Greedy shortest-first
  // matching here once bound a row's remove button to the wrong (cheaper)
  // target when one addon name prefixed another (merge fleet, 2026-07-24).
  rows.forEach((item, i) => {
    if (byRow.has(i)) return;
    const label = String(item.label || '');
    let best = -1;
    targets.forEach((e, idx) => {
      if (used.has(idx) || !e || !e.label) return;
      if (!label.startsWith(e.label)) return;
      if (best === -1 || String(e.label).length > String(targets[best].label).length) best = idx;
    });
    if (best !== -1) { used.add(best); byRow.set(i, targets[best]); }
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
