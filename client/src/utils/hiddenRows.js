// Which rows of an admin pricing breakdown are hidden from the client (spec
// 2026-10-16 section 4.5). The admin views (components/PricingBreakdown.js on
// the desktop, financialsOf in utils/eventDetailView.js on the phone) draw
// snapshot.breakdown, which lists every adjustment, shown or hidden, so each
// hidden line gets a "hidden from client" tag.
//
// Since 2026-10-17 the engine writes the line's coerced `visible` on each
// adjustment row (pricingEngine.js calculateProposal). A row that carries the
// key is read from it. A row without it (every older snapshot, or a row a
// server writer placed without the key) falls back to its line: adjustment
// rows are matched to snapshot.adjustments by label and signed cents, the
// engine's coercions (adjustmentRules.js), and read from the line, where a
// missing visible means hidden, so every existing hidden line stays tagged
// with no backfill. Any other row is never hidden.
//
// The match runs from the bottom. The engine writes the adjustment rows after
// every service row, the client Gratuity row after them and only while
// snapshot.gratuity.total is above 0 (the server's insertAdjustmentBreakdownRow
// keeps that order), so the bottom-most alignment is the true one. Read top
// down, a line that copies a service row's label and amount (a surcharge
// called "Shared Gratuity") would tag the service row instead of its own. A
// line may also have no row (a gratuity re-quote drops every row labeled
// Gratuity, an admin's own line included), so the walk skips such a line
// rather than stopping.
import { adjVisible, adjLabel, adjSignedCents } from './adjustmentRules';
import { GRATUITY_LABEL } from './gratuityLabels';

const hasOwn = (o, k) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

// A row's signed amount in cents, read the way adjSignedCents reads a line:
// the magnitude rounded half away from zero, then the sign. The engine's row
// holds the line's own signed dollars, so this equals adjSignedCents(line) for
// every row it wrote, whole cents or not.
function rowSignedCents(amount) {
  const n = Number(amount) || 0;
  const cents = Math.round(Math.abs(n) * 100);
  if (cents === 0) return 0;
  return n < 0 ? -cents : cents;
}

const rowIsLine = (row, adj) => row.label === adjLabel(adj) && rowSignedCents(row.amount) === adjSignedCents(adj);

// -> boolean[] aligned with snapshot.breakdown: true where the row is hidden.
export function hiddenRowFlags(snapshot) {
  const rows = snapshot && Array.isArray(snapshot.breakdown) ? snapshot.breakdown : [];
  const adjs = snapshot && Array.isArray(snapshot.adjustments) ? snapshot.adjustments : [];
  const flags = rows.map((row) => (hasOwn(row, 'visible') ? !row.visible : false));

  // The client Gratuity row is never a line: the same rule the server uses
  // to place a written line (adjustmentRules.insertAdjustmentBreakdownRow).
  let end = rows.length;
  const last = rows[end - 1];
  if (hasOwn(last, 'label') && last.label === GRATUITY_LABEL
    && Number(snapshot.gratuity && snapshot.gratuity.total) > 0) end -= 1;

  let k = adjs.length - 1;
  for (let i = end - 1; i >= 0 && k >= 0; i -= 1) {
    const row = rows[i];
    if (!row || typeof row !== 'object') continue;
    let j = k;
    while (j >= 0 && !rowIsLine(row, adjs[j])) j -= 1;
    if (j < 0) continue; // not a line's row
    flags[i] = hasOwn(row, 'visible') ? !row.visible : !adjVisible(adjs[j]);
    k = j - 1;
  }
  return flags;
}
