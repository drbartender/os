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

// ── The derivation's label contract ─────────────────────────────────────────
//
// refreshUnlockedInvoices derives an invoice's demand from
// `owed = total_price − amount_paid`. That is only meaningful for an invoice
// whose money IS inside total_price. Deriving a label whose money lives
// OUTSIDE the contract either destroys it (owed = 0 zeroes the invoice) or
// makes it cannibalise contract money (its amount is deducted from the
// remainder). Both were reachable and both are money bugs, so the derivation
// is an ALLOW-LIST, never "everything unlocked".
//
// Money that is NOT in total_price, and therefore must never be derived:
//   'Drink Plan Extras' on the syrup-only fast path — routes/drinkPlans/
//     submit.js:571 states it outright ("syrups are additive money that never
//     fold into total_price"). The add-on path DOES fold, so the same label
//     means two different things and the label alone cannot tell them apart.
//     invoiceExtras.js remains its sole owner.
//   Manual/bespoke labels — POST /api/invoices/proposal/:id accepts free text
//     ('Damage Fee', 'Travel'), and nothing puts those dollars in total_price.
//
// PARTIAL bills deliberately ask for a SUBSET of what is owed, so they are
// CAPPED at what remains and never raised. Only 'Deposit' qualifies: its
// intended amount is proposals.deposit_amount, and ~154 sit open in prod at
// any time on sent-but-unsigned proposals, so any rule handing every open
// invoice the full `owed` would rewrite all of them to the full contract price.
const PARTIAL_BILL_LABELS = Object.freeze(['Deposit']);

// REMAINDER bills carry whatever is still owed after the partials. All three
// are contract money by construction: 'Balance' and 'Full Payment' are minted
// from total_price, and 'Additional Services' is minted by
// createAdditionalInvoiceIfNeeded from a total_price DELTA.
//
// Ordered by priority. When more than one is open, the earliest in this list
// takes the remainder and the others keep their current demand — see
// refreshUnlockedInvoices.
const REMAINDER_BILL_LABELS = Object.freeze(['Balance', 'Full Payment', 'Additional Services']);

// The full derivable set. Any label outside it is left strictly alone.
const DERIVABLE_INVOICE_LABELS = Object.freeze([
  ...PARTIAL_BILL_LABELS,
  ...REMAINDER_BILL_LABELS,
]);

// TOTAL_TRACKING_INVOICE_LABELS was REMOVED on 2026-07-28. It existed so an
// overpayment-scope refund could drop amount_paid ONLY on invoices whose demand
// refreshUnlockedInvoices had already rebuilt from the new total, since dropping
// such a demand twice would mint phantom credit.
//
// That premise died with the derivation rewrite. A remainder invoice's demand is
// now `amount_paid + allocation`, FLOORED at amount_paid. In overpayment scope
// `owed` is always 0 (the refund only fires when amount_paid exceeds the new
// total), so the allocation is 0 and the refresh writes amount_due = amount_paid
// exactly. It can no longer pre-absorb the refund for ANY label. Paid-only
// therefore strands a client-visible partially_paid phantom balance equal to the
// entire refund, on a live pay link, for the whole population the branch existed
// to serve.
//
// refundHelpers.applyRefundReconciliation now drops both figures unconditionally,
// which lands on due == paid in every case. Do not reintroduce a label list here
// without first re-checking whether the refresh can still lower a demand below
// what the invoice already collected. It cannot.

module.exports = {
  MAX_ADDON_QTY,
  safeAddonQty,
  CONTRACT_LABELS,
  OFF_LEDGER_INVOICE_LABELS,
  PARTIAL_BILL_LABELS,
  REMAINDER_BILL_LABELS,
  DERIVABLE_INVOICE_LABELS,
};
