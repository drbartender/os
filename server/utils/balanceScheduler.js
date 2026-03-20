const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');

/**
 * Process autopay charges for proposals with balance due today or earlier.
 * Runs hourly via setInterval in server/index.js.
 */
async function processAutopayCharges() {
  try {
    const result = await pool.query(`
      SELECT id, total_price, amount_paid, stripe_customer_id, stripe_payment_method_id, event_name
      FROM proposals
      WHERE status = 'deposit_paid'
        AND autopay_enrolled = true
        AND balance_due_date <= CURRENT_DATE
        AND stripe_customer_id IS NOT NULL
        AND stripe_payment_method_id IS NOT NULL
    `);

    if (result.rows.length === 0) return;

    console.log(`[BalanceScheduler] Found ${result.rows.length} autopay charge(s) to process`);

    for (const proposal of result.rows) {
      const balanceCents = Math.round((Number(proposal.total_price) - Number(proposal.amount_paid)) * 100);
      if (balanceCents <= 0) continue;

      try {
        const intent = await stripe.paymentIntents.create({
          amount: balanceCents,
          currency: 'usd',
          customer: proposal.stripe_customer_id,
          payment_method: proposal.stripe_payment_method_id,
          off_session: true,
          confirm: true,
          description: `Balance Payment — ${proposal.event_name || 'Dr. Bartender Event'}`,
          metadata: {
            proposal_id: String(proposal.id),
            payment_type: 'balance',
          },
        });

        console.log(`[BalanceScheduler] Charged $${(balanceCents / 100).toFixed(2)} for proposal ${proposal.id} (intent: ${intent.id})`);
        // Webhook will handle status update and logging
      } catch (err) {
        console.error(`[BalanceScheduler] Failed to charge proposal ${proposal.id}:`, err.message);

        // Log the failure for admin visibility
        await pool.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'autopay_failed', 'system', $2)`,
          [proposal.id, JSON.stringify({ error: err.message, amount: balanceCents })]
        );
      }
    }
  } catch (err) {
    console.error('[BalanceScheduler] Error:', err);
  }
}

module.exports = { processAutopayCharges };
