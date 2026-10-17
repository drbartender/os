// server/utils/foldDecision.js
'use strict';
// Where a gap between itemized lines and a total goes (spec 2026-10-16 D3).
// Shared by invoiceLineItems.foldToContract and clientPriceLines.
//   'none'      no gap
//   'skipped'   a gap but no package line to carry it (the invoice rule: no fold)
//   'package'   the package line absorbs the gap and stays at or above $0
//   'fallback'  the package line would go below $0, so it keeps its price and
//               one "Pricing adjustment" line carries the whole gap
function decideFold({ hasPackage, packageCents, gapCents }) {
  if (gapCents === 0) return 'none';
  if (!hasPackage) return 'skipped';
  return packageCents + gapCents >= 0 ? 'package' : 'fallback';
}

// The one name of the fallback line, on the invoice and on the page alike, so
// a client never sees the same fold called two things.
const PRICING_ADJUSTMENT_LABEL = 'Pricing adjustment';

module.exports = { decideFold, PRICING_ADJUSTMENT_LABEL };
