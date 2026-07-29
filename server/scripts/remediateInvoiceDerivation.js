// One-time remediation for the 2026-07-28 over-billing incident.
//
// Runs the FIXED derivation over the affected proposals, so this doubles as
// live validation of the fix on the four cases that motivated it. Idempotent:
// a second run finds everything already correct and writes nothing new.
//
// Incident, for whoever finds this later: refreshUnlockedInvoices derived a
// Balance as `total - external - Σ(locked invoice amount_due)`, using locked
// invoices as a proxy for money already collected (broke David Luebke, who
// paid a deposit with no Deposit invoice backing it), and `continue`d past
// every label outside Deposit/Balance/Full Payment, so a price DECREASE never
// reached a bespoke invoice (stranded Brandon Martin, Cathy Murphy, and Eve
// Thornton at their pre-decrease amounts).
//
// Usage:
//   node -r dotenv/config server/scripts/remediateInvoiceDerivation.js
//   node -r dotenv/config server/scripts/remediateInvoiceDerivation.js --apply
//
// Without --apply it prints current state and writes nothing.
require('dotenv').config();
const { pool } = require('../db');
const { refreshUnlockedInvoices } = require('../utils/invoiceLifecycle');
const { voidExtrasInvoiceWithReconcile } = require('../utils/invoiceExtras');

// 51 David Luebke, 491 Cathy Murphy, 527 (stale $20 extras, same shape as Eve,
// found by the 2026-07-28 push review), 556 Eve Thornton, 557 Brandon Martin.
const PROPOSALS = [51, 491, 527, 556, 557];
const APPLY = process.argv.includes('--apply');

const usd = (cents) => '$' + (Number(cents) / 100).toFixed(2);

async function snapshot(proposalId) {
  const { rows } = await pool.query(
    `SELECT i.id, i.invoice_number, i.label, i.amount_due, i.amount_paid,
            i.status, i.locked, p.total_price, p.amount_paid AS prop_paid, c.name
       FROM invoices i
       JOIN proposals p ON p.id = i.proposal_id
       JOIN clients c ON c.id = p.client_id
      WHERE i.proposal_id = $1
      ORDER BY i.id`,
    [proposalId]
  );
  return rows;
}

function report(tag, rows) {
  for (const r of rows) {
    console.log(
      `  ${tag} ${r.invoice_number} ${r.label} due=${usd(r.amount_due)} ` +
      `paid=${usd(r.amount_paid)} ${r.status}${r.locked ? ' LOCKED' : ''}`
    );
  }
}

(async () => {
  console.log(APPLY ? 'APPLY mode: writing changes.' : 'DRY RUN: nothing will be written. Pass --apply to write.');

  for (const id of PROPOSALS) {
    const before = await snapshot(id);
    if (before.length === 0) {
      console.log(`\nprop ${id}: no invoices found, skipped`);
      continue;
    }
    const owed = Math.round(Number(before[0].total_price) * 100) - Math.round(Number(before[0].prop_paid) * 100);
    console.log(`\nprop ${id} ${before[0].name}  total=${usd(Math.round(Number(before[0].total_price) * 100))} ` +
      `paid=${usd(Math.round(Number(before[0].prop_paid) * 100))} owed=${usd(owed)}`);
    report('BEFORE', before);

    if (!APPLY) continue;

    await refreshUnlockedInvoices(id);

    // The derivation deliberately will not void a Drink Plan Extras invoice:
    // voiding one carries a comp-reconcile side effect owned by
    // voidExtrasInvoiceWithReconcile, and calling that from invoiceLifecycle
    // would be a require cycle. Finish those here (this is Eve Thornton).
    // The derivation deliberately does NOT touch 'Drink Plan Extras' (its money
    // may live outside total_price), so a stale extras invoice is still open
    // here at its ORIGINAL amount, not zeroed. Select it by the fact that the
    // proposal owes nothing, which is what makes the demand stale.
    for (const r of await snapshot(id)) {
      const stillOwed = Math.round(Number(r.total_price) * 100) - Math.round(Number(r.prop_paid) * 100);
      if (r.label === 'Drink Plan Extras' && stillOwed <= 0
          && Number(r.amount_paid) === 0 && r.status !== 'void' && !r.locked) {
        console.log(`  voiding extras invoice ${r.invoice_number} via reconcile helper`);
        // reconcileTotalPrice MUST be false. Its default (true) is the COMP
        // semantic: the add-on is being waived, so subtract it from
        // total_price. That is not what happened here. Eve Thornton's extras
        // were folded into total_price and she PAID the full 550; subtracting
        // them now would drop her total below what she paid and invent a $155
        // overpayment. This invoice is a stale duplicate demand, not a waiver.
        const tx = await pool.connect();
        try {
          await tx.query('BEGIN');
          await voidExtrasInvoiceWithReconcile(r.id, null, tx, {
            reconcileTotalPrice: false,
            reason: 'derivation remediation 2026-07-28',
          });
          await tx.query('COMMIT');
        } catch (err) {
          await tx.query('ROLLBACK');
          throw err;
        } finally {
          tx.release();
        }
      }
    }

    report('AFTER ', await snapshot(id));
  }

  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
