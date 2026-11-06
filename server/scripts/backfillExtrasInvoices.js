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
 * for the live/future affected client (proposal 527). A past event and an
 * owner-handled one are left to manual judgment.
 *
 * Idempotent:
 *   - creates NOTHING if a non-void extras invoice already exists (findExtrasInvoice);
 *   - a re-run after cancel finds the PIs no longer `requires_payment_method` and skips them.
 *
 * Money law 15: a legal-hold proposal is left out before anything is read
 * (isLegalHold; a missing list throws there), and every run prints the held
 * count it left out (1 when the given proposal is held, else 0). A write run
 * (no --dry-run) refuses unless --held-excluded <n> gives that count from a
 * dry run, so a write always follows a dry run that confirmed it.
 *
 *   node server/scripts/backfillExtrasInvoices.js <proposalId> --dry-run
 *   node server/scripts/backfillExtrasInvoices.js <proposalId> --held-excluded <n>
 *
 * Exit codes: 0 clean; 1 bad arguments, a write run with no held count, or a
 * failure; 2 the held count did not match and nothing was read or written.
 */

require('dotenv').config();
const { pool } = require('../db');
const { getStripe } = require('../utils/stripeClient');
const { findExtrasInvoice, createDrinkPlanExtrasInvoice } = require('../utils/invoiceHelpers');
const { isLegalHold } = require('../utils/legalHold');

const DRINK_PLAN_TYPES = new Set(['drink_plan_extras', 'drink_plan_with_balance']);
const HELD_FLAG = '--held-excluded';
const USAGE = 'Usage: node server/scripts/backfillExtrasInvoices.js <proposalId> (--dry-run | --held-excluded <n>)';

// The proposal id (the first bare number that is not the flag's value),
// --dry-run, and the count after --held-excluded (null when absent). Throws on
// a missing or malformed count, so a typo never reads as one.
function parseArgs(args) {
  let proposalId = null;
  let heldFlag = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === HELD_FLAG) {
      const raw = args[i + 1];
      if (raw === undefined || !/^\d+$/.test(raw)) {
        throw new Error(`${HELD_FLAG} needs the legal-hold count a dry run printed (a whole number)`);
      }
      heldFlag = Number(raw);
      i += 1;
    } else if (proposalId === null && /^\d+$/.test(a)) {
      proposalId = Number(a);
    }
  }
  return { proposalId, heldFlag, dryRun };
}

async function main(args = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(`REFUSING: ${err.message}. Nothing was read or written.`);
    process.exitCode = 1;
    return;
  }
  const { proposalId, heldFlag, dryRun } = parsed;
  if (!proposalId) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!dryRun && heldFlag === null) {
    console.error(`REFUSING: a write run needs ${HELD_FLAG} <n>, the legal-hold count a --dry-run printed. Nothing was read or written.`);
    process.exitCode = 1;
    return;
  }

  const heldCount = isLegalHold(proposalId) ? 1 : 0;
  console.log(`[backfill-extras] legal hold: ${heldCount} held proposal(s) left out (money law 15). A write run needs ${HELD_FLAG} ${heldCount}.`);
  if (!dryRun && heldFlag !== heldCount) {
    console.error(`REFUSING: ${HELD_FLAG} ${heldFlag} does not match the ${heldCount} held proposal(s) this run leaves out. Re-run the dry run first. Nothing was read or written.`);
    process.exitCode = 2;
    return;
  }
  if (heldCount) {
    console.log(`[backfill-extras] proposal ${proposalId} is on legal hold: nothing is read, written or cancelled.`);
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
      process.exitCode = 1; // a failure, per the header; the loop still finishes
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
      process.exitCode = 1; // a failure, per the header; the loop still finishes
    }
  }

  console.log('[backfill-extras] done.');
}

module.exports = { main, parseArgs };

if (require.main === module) {
  main()
    .catch((err) => { console.error('Backfill failed:', err); process.exitCode = 1; })
    .finally(async () => { await pool.end(); });
}
