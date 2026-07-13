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
 * balance intent, find the prior *unresolved* balance intent for this proposal
 * and ask Stripe for its TRUE status — the local stripe_sessions.status is
 * unreliable during the very webhook outage this guards against (a paid intent
 * stays 'pending' until the webhook lands). Returns { skip:true } when a prior
 * balance intent is already succeeded/processing (leave the claim for the
 * webhook/reconcile) or cannot be retrieved (lean money-safe); { skip:false }
 * when there is no still-settling balance intent (safe to re-charge).
 *
 * SELECTION — status='pending' only, no amount filter, newest-first up to 10:
 *   - `status = 'pending'` scopes to LOCALLY-UNRESOLVED rows. The webhook flips a
 *     paid intent to 'succeeded' (paymentIntentSucceeded.js:218), a decline to
 *     'failed' (paymentIntentFailed.js:57), and stripeCreateIntent cancels a
 *     superseded pending row to 'canceled'. Excluding everything but 'pending' is
 *     what keeps a historically paid-and-credited balance (now 'succeeded') from
 *     reading as "settling forever" and wedging every future legitimate charge.
 *     The prior comment claimed `status <> 'canceled'` was fine; it was not — it
 *     swept in webhook-confirmed 'succeeded' rows and caused a CHARGE_SETTLING loop.
 *   - NO amount filter. The old code matched `amount = $2` on the assumption that
 *     the balance for a due date is a fixed dollar figure. That is false: total_price
 *     can change mid-outage (drink-plan submit, admin edit), so the settling prior
 *     intent no longer matches the new balanceCents and the guard would miss it →
 *     double charge. Payment_type is the true discriminator, read from Stripe below.
 *   - Newest-first, LIMIT 25: other 'pending' rows (invoice checkout, drink-plan
 *     payment) also carry intent ids, so a single newest row could be a non-balance
 *     intent shadowing an older settling balance intent. We scan a bounded window
 *     and classify each by its retrieved metadata rather than trusting the first row.
 *     The bound sits far above any plausible per-proposal pending-row count (extras
 *     retries accumulate 2-4) so a settling balance intent cannot be evicted from
 *     the window by newer non-balance rows; it exists only to cap Stripe retrieves.
 *
 * ITERATION (newest-first): retrieve each candidate. A retrieve failure fails closed
 * (skip). A non-balance intent is skipped past (CONTINUE) — it is not our charge. A
 * balance intent that is succeeded/processing is the settling one → skip. A balance
 * intent that is terminal (canceled / requires_payment_method / other) does NOT
 * unblock: we CONTINUE to older candidates, because a newer FAILED balance retry must
 * not shadow an older ORIGINAL balance intent that is still settling. Only when the
 * whole window holds no still-settling balance intent do we allow the charge.
 */
async function priorBalanceChargeSettling({ proposalId, stripe }, db = pool) {
  const prior = await db.query(
    `SELECT stripe_payment_intent_id
       FROM stripe_sessions
      WHERE proposal_id = $1
        AND stripe_payment_intent_id IS NOT NULL
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 25`,
    [proposalId]
  );
  const rows = prior.rows;

  for (const row of rows) {
    const priorIntentId = row.stripe_payment_intent_id;
    let intent;
    try {
      intent = await stripe.paymentIntents.retrieve(priorIntentId);
    } catch (e) {
      // Can't confirm it's safe to re-charge → SKIP (fail closed). The claim
      // stays for the webhook/reconcile; an admin can force it once Stripe is
      // reachable. Not double-charging beats a possible miss.
      return { skip: true, reason: 'retrieve_failed', priorIntentId };
    }
    if (intent?.metadata?.payment_type !== 'balance') {
      // A deposit / invoice / drink-plan intent — not our charge. Keep scanning.
      continue;
    }
    if (intent.status === 'succeeded' || intent.status === 'processing') {
      return { skip: true, reason: 'settling', priorIntentId, priorStatus: intent.status };
    }
    // Balance-typed but terminal (canceled / requires_payment_method / other): a
    // newer failed retry must not unblock past an OLDER settling original — keep
    // scanning the remaining, older candidates before deciding it is safe.
  }

  return { skip: false, reason: rows.length ? 'no_settling_balance_intent' : 'absent' };
}

module.exports = { recordBalanceIntent, priorBalanceChargeSettling };
