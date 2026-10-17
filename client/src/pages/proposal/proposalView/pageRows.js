// The pricing rows the proposal page draws (spec 2026-10-16 section 4.2).
//
// The service rows come from the server (`price_rows` in the public payload,
// server/utils/clientPriceLines.js), hidden lines already folded, so no hidden
// line's label reaches the browser. A hidden amount arrives only inside those
// rows: folded into the package row, or, when it is larger than the package
// row, as one visible "Pricing adjustment" row (spec D3, the invoice rule).
// The page adds only the gratuity row, built from snapshot.gratuity exactly as
// its old memo did, because a create-intent quote re-prices the gratuity in
// client state (intentQuote.js): server rows plus this row keep adding up to
// the Total the page shows. Like the old memo, nothing is drawn for a snapshot
// without a package (spec 4.1: the Total only). No server rows (a new bundle
// against a server mid-deploy) leaves the gratuity row alone beside the Total
// (plan decision 11).
import { GRATUITY_LABEL } from '../../../utils/gratuityLabels';

export function pageRows(priceRows, snapshot) {
  if (!snapshot || !snapshot.package) return [];
  const rows = Array.isArray(priceRows) ? [...priceRows] : [];
  if (snapshot.gratuity && snapshot.gratuity.total > 0) {
    // Flagged: the one line the payment webhook rewrites (election at
    // payment recomputes snapshot.gratuity), so the breakdown hides it
    // while the redirect is still settling.
    rows.push({ key: 'gratuity', label: GRATUITY_LABEL, amount: snapshot.gratuity.total, gratuity: true });
  }
  return rows;
}
