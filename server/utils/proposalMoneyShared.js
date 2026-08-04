// Shared money-shaping constants + helpers for the proposal/invoice paths.
// Centralizes values that must stay identical everywhere pricing money math
// runs; drift here silently shifts dollars (audit FIX-1 + MS-1).

// Coerce a client-supplied addon quantity into a bounded positive integer.
// Untrusted public/admin input — negative/fractional/NaN values would silently
// flow into pricing calculations and (post 2026-05-14 hosted bartender rule)
// could shift money. Cap at 20 to bound any single addon line. Reject
// non-scalar inputs explicitly so future readers don't have to trust that
// `parseInt([5,...])` happens to coerce safely via Array.toString().
const MAX_ADDON_QTY = 20;
function safeAddonQty(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_ADDON_QTY, n);
}

// Invoice labels whose dollars are part of the contract total_price. Frozen so
// the classification cannot drift at runtime. Consumed by the fee-netting
// numerator (payrollAccrual) and the refund contract-vs-extra-scope split
// (refundHelpers). The labels ORIGINATE in invoiceLifecycle.js (invoice
// creation) — keep this list in sync with the labels written there.
const CONTRACT_LABELS = Object.freeze(['Deposit', 'Balance', 'Full Payment']);

// The service-extension invoice label. Off-ledger by design (spec
// 2026-07-25 D12): its money is never in total_price, so the webhook must
// skip the amount_paid roll-up, refreshUnlockedInvoices must not count it,
// and refund reconciliation must leave the contract alone. All three read
// OFF_LEDGER_INVOICE_LABELS, so joining that set is the whole wiring.
// Deliberately NOT in CONTRACT_LABELS and NOT in TOTAL_TRACKING_INVOICE_LABELS.
const SERVICE_EXTENSION_INVOICE_LABEL = 'Service Extension';

// Labels whose invoice amounts live entirely OUTSIDE proposals.total_price
// (additive upsells; "invoice-only, never touches the contract"). Their
// payments must never roll into proposals.amount_paid, and their locked
// invoices never join the Balance lockedTotal — otherwise paying one forgives
// the contract by its amount. Holds exactly one label since 2026-07-26:
// 'Service Extension' (see above). History: 'Enhancement Lab' left this set
// on 2026-07-20 when lab additions switched to folding into total_price
// (owner decision — additions join the balance and the final invoice), which
// makes lab invoices ordinary contract money; the set then sat empty with the
// consumer machinery (webhook roll-up skip, refund skip, lockedTotal
// exclusion) kept wired as a no-op until the extension label joined. Add a
// label here ONLY for a genuinely-additive invoice type. Distinct from
// "non-contract scope" in refundHelpers, which is merely ∉ CONTRACT_LABELS.
const OFF_LEDGER_INVOICE_LABELS = Object.freeze([SERVICE_EXTENSION_INVOICE_LABEL]);

// Labels whose invoice amount_due TRACKS proposals.total_price, i.e. the ones
// refreshUnlockedInvoices recomputes from the total on every reprice
// (invoiceLifecycle.js: 'Full Payment' = total - external, 'Balance' = total -
// external - lockedTotal). Everything else is NOT total-tracking: 'Deposit' is
// refreshed but from deposit_amount, so a reprice never moves it, and every
// other label ('Additional Services', 'Enhancement Lab', 'Drink Plan Extras',
// manual) is skipped by the refresh entirely.
//
// This is the difference between "an unlocked invoice" and "an invoice whose
// demand something else already corrected". A refund that lowers what a client
// paid must correct that invoice's demand ITSELF unless this list (plus
// unlocked) says the refresh will. Keying that decision on `locked` alone
// stranded a client-visible phantom balance on unlocked non-total-tracking
// invoices, on an invoice whose pay link is still live (push review,
// 2026-07-26). Consumed by refundHelpers.applyRefundReconciliation.
const TOTAL_TRACKING_INVOICE_LABELS = Object.freeze(['Balance', 'Full Payment']);

module.exports = {
  MAX_ADDON_QTY,
  safeAddonQty,
  CONTRACT_LABELS,
  OFF_LEDGER_INVOICE_LABELS,
  SERVICE_EXTENSION_INVOICE_LABEL,
  TOTAL_TRACKING_INVOICE_LABELS,
};
