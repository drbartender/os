'use strict';

/**
 * One-off, idempotent backfill for ABANDONED pay-now drink-plan extras.
 *
 * Before this fix, a "pay now" extras selection whose card was abandoned at
 * Stripe status `requires_payment_method` fired no webhook, so the extras landed
 * nowhere: no invoice, no payment row, yet the selections (incl. syrups) still
 * rode onto the shopping list. This script creates the unpaid "Drink Plan
 * Extras" invoice for such a proposal from the abandoned PaymentIntent's amount
 * (authoritative for what the client attempted to pay), then cancels the stale
 * PIs so they can't surprise-charge later.
 *
 * Scope is one proposal per run (passed as an argument). Post-deploy this is run
 * for the live/future affected client (Shiralee, proposal 527). The past event
 * (Julia) and the owner-handled one (Anna) are left to manual judgment.
 *
 * Idempotent:
 *   - creates NOTHING if a non-void extras invoice already exists (findExtrasInvoice);
 *   - a re-run after cancel finds the PIs no longer `requires_payment_method` and skips them.
 *
 *   node server/scripts/backfillExtrasInvoices.js <proposalId> [--dry-run]
 */

require('dotenv').config();
const { pool } = require('../db');
const { getStripe } = require('../utils/stripeClient');
const { findExtrasInvoice, createDrinkPlanExtrasInvoice } = require('../utils/invoiceHelpers');

const DRINK_PLAN_TYPES = new Set(['drink_plan_extras', 'drink_plan_with_balance']);

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const proposalId = Number(args.find((a) => /^\d+$/.test(a)));
  if (!proposalId) {
    console.error('Usage: node server/scripts/backfillExtrasInvoices.js <proposalId> [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const stripe = getStripe();
  if (!stripe) {
    console.error('Stripe is not configured (check STRIPE_SECRET_KEY / test creds).');
    process.exitCode = 1;
    return;
  }

  console.log(`[backfill-extras] proposal ${proposalId}${dryRun ? '  (DRY RUN — no writes, no cancels)' : ''}`);

  // Candidate PaymentIntents: pending stripe_sessions rows for this proposal.
  const sess = await pool.query(
    `SELECT DISTINCT stripe_payment_intent_id AS pi
       FROM stripe_sessions
      WHERE proposal_id = $1 AND stripe_payment_intent_id IS NOT NULL AND status = 'pending'`,
    [proposalId]
  );
  if (sess.rows.length === 0) {
    console.log('No pending stripe_sessions PaymentIntents for this proposal — nothing to backfill.');
    return;
  }

  // Keep only abandoned (requires_payment_method) drink-plan extras PIs.
  const abandoned = [];
  for (const { pi: piId } of sess.rows) {
    let pi;
    try {
      pi = await stripe.paymentIntents.retrieve(piId);
    } catch (e) {
      console.warn(`  could not retrieve ${piId}: ${e.message}`);
      continue;
    }
    const type = pi.metadata?.payment_type;
    if (!DRINK_PLAN_TYPES.has(type)) continue;
    if (pi.status !== 'requires_payment_method') {
      console.log(`  skip ${piId}: status=${pi.status} (only requires_payment_method is treated as abandoned)`);
      continue;
    }
    // Prefer the extras portion from metadata; fall back to the full PI amount.
    // For a with_balance PI, pi.amount INCLUDES the balance portion, so a missing
    // extras_amount_cents would overstate the extras invoice — warn loudly so the
    // operator catches it in the --dry-run before a live run.
    const metaExtras = Number(pi.metadata?.extras_amount_cents) || 0;
    if (!metaExtras && type === 'drink_plan_with_balance') {
      console.warn(`  WARNING ${piId}: with_balance PI missing extras_amount_cents; falling back to pi.amount ($${(pi.amount / 100).toFixed(2)}) which INCLUDES the balance portion — the extras invoice would be OVERSTATED. Review before a live run.`);
    }
    const extrasCents = metaExtras || pi.amount;
    const drinkPlanId = Number(pi.metadata?.drink_plan_id) || null;
    abandoned.push({ piId, type, extrasCents, drinkPlanId, amount: pi.amount });
  }

  if (abandoned.length === 0) {
    console.log('No abandoned drink-plan extras PaymentIntents found — nothing to backfill.');
    return;
  }
  console.log(`Found ${abandoned.length} abandoned extras PaymentIntent(s):`);
  abandoned.forEach((a) =>
    console.log(`  ${a.piId}  type=${a.type}  extras=$${(a.extrasCents / 100).toFixed(2)}  amount=$${(a.amount / 100).toFixed(2)}  drinkPlan=${a.drinkPlanId}`)
  );

  // ── Create the unpaid extras invoice (guarded against duplicates) ──────────
  const existing = await findExtrasInvoice(proposalId, pool);
  const primary = abandoned.find((a) => a.drinkPlanId && a.extrasCents > 0) || abandoned[0];

  if (existing) {
    console.log(`A non-void extras invoice already exists (id ${existing.id}, status ${existing.status}) — NOT creating a duplicate.`);
  } else if (!primary.drinkPlanId) {
    console.warn('No drink_plan_id in the PI metadata — cannot create the extras invoice. Proceeding to cancel-only.');
  } else if (dryRun) {
    console.log(`[dry-run] would create "Drink Plan Extras" invoice: proposal=${proposalId} drinkPlan=${primary.drinkPlanId} amount_due=${primary.extrasCents}c ($${(primary.extrasCents / 100).toFixed(2)})`);
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Re-check under the transaction so a live webhook that just created it
      // between the guard above and now cannot cause a duplicate.
      const race = await findExtrasInvoice(proposalId, client);
      if (race) {
        console.log(`Extras invoice appeared concurrently (id ${race.id}) — skipping create.`);
      } else {
        const inv = await createDrinkPlanExtrasInvoice(
          { proposalId, drinkPlanId: primary.drinkPlanId, extrasAmountCents: primary.extrasCents },
          client
        );
        console.log(`Created extras invoice id ${inv.id} (${inv.invoice_number}), amount_due ${primary.extrasCents}c.`);
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (rb) { console.error('ROLLBACK failed:', rb); }
      throw e;
    } finally {
      client.release();
    }
  }

  // ── Cancel the stale PIs so they can never surprise-charge the client ──────
  for (const a of abandoned) {
    if (dryRun) {
      console.log(`[dry-run] would cancel PaymentIntent ${a.piId}`);
      continue;
    }
    try {
      await stripe.paymentIntents.cancel(a.piId);
      console.log(`Canceled PaymentIntent ${a.piId}.`);
    } catch (e) {
      console.warn(`  could not cancel ${a.piId}: ${e.message}`);
    }
  }

  console.log('[backfill-extras] done.');
}

main()
  .catch((err) => { console.error('Backfill failed:', err); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
