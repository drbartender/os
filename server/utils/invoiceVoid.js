// Void a proposal's unpaid invoice(s). Lives in its own file (not invoiceHelpers.js,
// which is near the 1000-line cap). Used by the option-group choice-commit to
// clean up a losing option's dangling Deposit invoice (the retroactive case where
// a solo proposal was sent-and-invoiced before being pulled into a comparison).
//
// Guarded exactly like the admin void route (invoices.js): never void when money
// has landed. The proposal-level amount_paid=0 guard plus the per-invoice
// amount_paid=0 filter make this a no-op on any paid proposal/invoice, and
// idempotent (already-void rows fall outside the status filter).

async function voidUnpaidProposalInvoice(proposalId, dbClient) {
  const { rows: [p] } = await dbClient.query(
    'SELECT amount_paid FROM proposals WHERE id = $1', [proposalId]);
  if (!p || Number(p.amount_paid || 0) > 0) return { voided: 0 };

  const res = await dbClient.query(
    `UPDATE invoices SET status = 'void', updated_at = NOW()
      WHERE proposal_id = $1 AND amount_paid = 0 AND status IN ('draft', 'sent', 'partially_paid')`,
    [proposalId]);
  return { voided: res.rowCount };
}

module.exports = { voidUnpaidProposalInvoice };
