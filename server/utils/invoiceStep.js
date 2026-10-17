// The step from the contract to a contract invoice's total, PURE (spec
// 2026-10-16 section 7). A Deposit invoice lists the whole contract but bills
// only the deposit; this names the difference so the page adds up: Contract
// Total, one step row, then the Invoice Total.
//
// Display only (D5): this computes and never writes. balanceInvoiceMonitor
// still reads only amount_due and amount_paid; the lifecycle refresh and the
// deposit-to-full upgrade still write the stored lines from the proposal (the
// upgrade's line-sum guard checks the lines it generates, not stored ones).
//
// Two gates keep the step honest; an invoice that fails either renders exactly
// as before.
// 1. The stored lines sum to the current contract (proposals.total_price) to
//    the cent. That leaves out lines minted before the fold (lane
//    invoice-lines, 2026-10-09), an invoice locked before a later price edit,
//    and a Full Payment that kept the Deposit's old lines.
// 2. The invoice lists no refund. A refund lowers amount_due and total_price
//    but never the lines, so the old line sum can meet the new total by
//    coincidence: a Check Cherry Balance whose lines carry a less-deposit line
//    as large as a later refund would subtract the deposit twice, once as a
//    line and again as the step. Any refund the page lists keeps the step off.

'use strict';

// Exact labels, as invoiceLifecycle.js writes them (CONTRACT_LABELS in
// proposalMoneyShared.js is the same set). A Map, not an object literal:
// manual invoices take free-text labels, and a plain-object lookup would
// answer 'constructor' or 'toString' with a function.
const STEP_LABELS = new Map([
  ['Deposit', 'Balance, billed later'],
  ['Balance', 'Less deposit and earlier payments'],
  ['Full Payment', 'Less payments already received'],
]);

/**
 * @param {object} args
 * @param {string} args.label               the invoice label
 * @param {number[]} args.lineTotalsCents   invoice_line_items.line_total values (cents)
 * @param {number} args.amountDueCents      invoices.amount_due (cents)
 * @param {number|null} args.contractTotalCents  proposals.total_price in cents, null when NULL
 * @param {boolean} [args.refunded]         true when the invoice lists a refund (gate 2)
 * @returns {null | { contract_total_cents: number, step_cents: number, step_label: string }}
 *   null unless the invoice lists no refund, the label is a contract label,
 *   every amount is whole cents (a number, never a string; null, NaN or a
 *   fraction refuses), the lines sum to the contract exactly, and the contract
 *   exceeds the amount due.
 */
function contractStep({ label, lineTotalsCents, amountDueCents, contractTotalCents, refunded } = {}) {
  if (refunded) return null;
  if (!STEP_LABELS.has(label)) return null;
  if (!Number.isInteger(contractTotalCents) || !Number.isInteger(amountDueCents)) return null;
  if (!Array.isArray(lineTotalsCents) || !lineTotalsCents.every(Number.isInteger)) return null;

  const sumCents = lineTotalsCents.reduce((sum, cents) => sum + cents, 0);
  if (sumCents !== contractTotalCents) return null;

  const stepCents = sumCents - amountDueCents;
  if (stepCents <= 0) return null;

  return {
    contract_total_cents: sumCents,
    step_cents: stepCents,
    step_label: STEP_LABELS.get(label),
  };
}

module.exports = { contractStep };
