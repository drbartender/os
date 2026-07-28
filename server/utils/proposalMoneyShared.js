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

// Labels whose invoice amounts live entirely OUTSIDE proposals.total_price
// (additive upsells; "invoice-only, never touches the contract"). Their
// payments must never roll into proposals.amount_paid, and their locked
// invoices never join the Balance lockedTotal — otherwise paying one forgives
// the contract by its amount. CURRENTLY EMPTY: 'Enhancement Lab' left this
// set on 2026-07-20 when lab additions switched to folding into total_price
// (owner decision — additions join the balance and the final invoice), which
// makes lab invoices ordinary contract money. The consumer machinery
// (webhook roll-up skip, refund skip, lockedTotal exclusion) is kept wired
// and degrades to a no-op on the empty list — add a label here ONLY for a
// future genuinely-additive invoice type. Distinct from "non-contract scope"
// in refundHelpers, which is merely ∉ CONTRACT_LABELS.
const OFF_LEDGER_INVOICE_LABELS = Object.freeze([]);

// Labels that deliberately bill a SUBSET of what the proposal still owes.
// refreshUnlockedInvoices never RAISES one of these; it only CAPS it at what
// is still owed, so a partial bill can never become an over-bill.
//
//   'Deposit'           — intended amount is proposals.deposit_amount. 154 of
//                         these sit open in prod at any time (a sent, unsigned
//                         proposal), and any rule handing every open invoice
//                         the full `owed` would rewrite all of them to the
//                         full contract price.
//   'Drink Plan Extras' — intended amount is its own amount_due, owned by
//                         findOrRefreshExtrasInvoice (invoiceExtras.js), which
//                         writes that same column. Capping is the ONLY safe
//                         interaction between the two writers: a cap can
//                         reduce an over-bill but can never contradict the
//                         extras owner's figure.
const PARTIAL_BILL_LABELS = Object.freeze(['Deposit', 'Drink Plan Extras']);

// Labels whose invoice amount_due is rebuilt from the NEW total by the
// refreshUnlockedInvoices call that runs inside the CANCEL transaction, i.e.
// BEFORE the refund reconciliation that follows in its own transaction
// (lineItemCancel.js step 6 -> refundExecute.js step 3). For exactly this
// population, an overpayment-scope refund must drop amount_paid ONLY: the
// demand was already corrected, and dropping it again would mint phantom
// credit. Every other invoice has nobody correcting its demand, so paid-only
// would leave due > paid and flip a settled invoice to a client-visible
// partially_paid phantom balance on a live pay link (push review 2026-07-26).
//
// DO NOT widen this to match PARTIAL_BILL_LABELS' complement. It is tempting
// once refreshUnlockedInvoices manages every label (2026-07-28), but the
// question here is NOT "does the refresh touch this label". It is "was this
// invoice's demand already corrected for the money about to be refunded". A
// fully-paid 'Additional Services' invoice fails that test no matter what the
// reprice path does, because the refresh runs before the refund and the
// derivation floors amount_due at amount_paid on a paid invoice (so it is a
// no-op there by design). Widening this list re-opens the exact phantom
// balance RC1 closed; the refundHelpers.scope suite catches it.
const TOTAL_TRACKING_INVOICE_LABELS = Object.freeze(['Balance', 'Full Payment']);

module.exports = {
  MAX_ADDON_QTY,
  safeAddonQty,
  CONTRACT_LABELS,
  OFF_LEDGER_INVOICE_LABELS,
  PARTIAL_BILL_LABELS,
  TOTAL_TRACKING_INVOICE_LABELS,
};
