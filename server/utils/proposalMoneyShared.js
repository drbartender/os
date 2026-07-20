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
// (additive upsells; spec-mandated "invoice-only, never touches the
// contract"). Their payments must never roll into proposals.amount_paid, and
// their locked invoices never join the Balance lockedTotal — otherwise paying
// one forgives the contract by its amount: autopay charges total - paid, and
// the Balance refresh subtracts locked invoices (2026-07-20 push review,
// Enhancement Lab). Distinct from "non-contract scope" in refundHelpers,
// which is merely ∉ CONTRACT_LABELS — 'Additional Services' and 'Drink Plan
// Extras' amounts ARE inside total_price/amount_paid and do not belong here.
const OFF_LEDGER_INVOICE_LABELS = Object.freeze(['Enhancement Lab']);

module.exports = { MAX_ADDON_QTY, safeAddonQty, CONTRACT_LABELS, OFF_LEDGER_INVOICE_LABELS };
