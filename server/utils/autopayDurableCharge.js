'use strict';
/**
 * F1 (autopay durable charge record). Two primitives shared by the autopay
 * scheduler (balanceScheduler.js) and the manual charge-balance route
 * (routes/stripe.js) so a >24h webhook outage can't drive a SECOND real
 * off-session charge for the same balance.
 */
const { pool } = require('../db');

/**
 * (a) Durable charge record. Persist a freshly-created balance PaymentIntent
 * into stripe_sessions immediately at charge time, independent of the webhook.
 * Mirrors stripeCreateIntent.js's insert (server/routes/stripeCreateIntent.js:203);
 * ON CONFLICT DO NOTHING makes a Stripe retry / webhook redelivery a no-op.
 */
async function recordBalanceIntent({ proposalId, intentId, amountCents }, db = pool) {
  await db.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
    [proposalId, intentId, amountCents]
  );
}

/**
 * (b) Double-charge guard for the stale-TTL re-claim. Before creating a NEW
 * balance intent, find the prior balance intent for this proposal+amount and
 * ask Stripe for its TRUE status — the local stripe_sessions.status is
 * unreliable during the very webhook outage this guards against (it stays
 * 'pending'). Returns { skip:true } when the prior balance intent is already
 * succeeded/processing (leave the claim for the webhook/reconcile) or cannot be
 * retrieved (lean money-safe); { skip:false } when absent, canceled, or
 * requires_payment_method (safe to re-charge).
 *
 * `amount` is the money-scoping proxy for "this balance due date": stripe_sessions
 * carries no payment_type/due_date column, and the balance for a given due date is
 * a fixed dollar amount, so amount + the retrieved metadata.payment_type==='balance'
 * check uniquely identifies the prior balance charge. On a genuine first charge no
 * amount-matching balance row exists, so this no-ops (charges) — which makes running
 * it every cycle a SAFE SUPERSET of "stale re-claim only" (it also catches a settling
 * prior intent on a failed-status re-claim, which stale-only scoping would double-charge).
 */
async function priorBalanceChargeSettling({ proposalId, amountCents, stripe }, db = pool) {
  const prior = await db.query(
    `SELECT stripe_payment_intent_id
       FROM stripe_sessions
      WHERE proposal_id = $1
        AND amount = $2
        AND stripe_payment_intent_id IS NOT NULL
        AND status <> 'canceled'
      ORDER BY created_at DESC
      LIMIT 1`,
    [proposalId, amountCents]
  );
  const priorIntentId = prior.rows[0]?.stripe_payment_intent_id;
  if (!priorIntentId) return { skip: false, reason: 'absent' };

  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(priorIntentId);
  } catch (e) {
    // Can't confirm it's safe to re-charge → SKIP. The claim stays for the
    // webhook/reconcile; an admin can force it once Stripe is reachable. Not
    // double-charging beats a possible miss.
    return { skip: true, reason: 'retrieve_failed', priorIntentId };
  }
  if (intent?.metadata?.payment_type !== 'balance') {
    return { skip: false, reason: 'not_balance', priorIntentId, priorStatus: intent?.status };
  }
  const settling = intent.status === 'succeeded' || intent.status === 'processing';
  return { skip: settling, reason: settling ? 'settling' : 'terminal', priorIntentId, priorStatus: intent.status };
}

module.exports = { recordBalanceIntent, priorBalanceChargeSettling };
