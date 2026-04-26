const Sentry = require('@sentry/node');
const { getStripe } = require('./stripeClient');
const { pool } = require('../db');
const { getEventTypeLabel } = require('./eventTypes');
const { sendEmail } = require('./email');

// Rate-limit the no-stripe-client alert so Sentry isn't spammed every cycle.
let stripeUnavailableLastLog = 0;
const STRIPE_ALERT_INTERVAL_MS = 60 * 60 * 1000; // once per hour

/**
 * Process autopay charges for proposals with balance due today or earlier.
 * Runs hourly via setInterval in server/index.js.
 */
async function processAutopayCharges() {
  const stripe = getStripe();
  if (!stripe) {
    const now = Date.now();
    if (now - stripeUnavailableLastLog > STRIPE_ALERT_INTERVAL_MS) {
      Sentry.captureMessage('Autopay disabled — no Stripe client', {
        level: 'warning',
        tags: { scheduler: 'autopay', reason: 'no_stripe_client' },
      });
      stripeUnavailableLastLog = now;
    }
    return;
  }
  try {
    // Atomic claim: a single UPDATE...RETURNING acts as both selection and
    // row-lock so concurrent scheduler runs (or a manual admin charge race)
    // can't grab the same proposal. autopay_status='in_progress' blocks
    // re-selection until the webhook moves status='balance_paid' OR the
    // 24h TTL elapses for stuck claims (webhook never landed).
    const result = await pool.query(`
      UPDATE proposals
      SET autopay_status = 'in_progress', autopay_attempted_at = NOW()
      WHERE status = 'deposit_paid'
        AND autopay_enrolled = true
        AND balance_due_date <= CURRENT_DATE
        AND stripe_customer_id IS NOT NULL
        AND stripe_payment_method_id IS NOT NULL
        AND (
          autopay_status IS NULL
          OR autopay_status = 'failed'
          OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '24 hours')
        )
      RETURNING id, total_price, amount_paid, stripe_customer_id, stripe_payment_method_id,
                event_type, event_type_custom, balance_due_date
    `);

    if (result.rows.length === 0) return;

    console.log(`[BalanceScheduler] Found ${result.rows.length} autopay charge(s) to process`);

    // Bound concurrency to 5 — Stripe allows 100 req/s but we avoid burst-noisy neighbors.
    const CONCURRENCY = 5;
    const chargeOne = async (proposal) => {
      const balanceCents = Math.round((Number(proposal.total_price) - Number(proposal.amount_paid)) * 100);
      if (balanceCents <= 0) {
        // Nothing to charge; clear claim so future runs can re-evaluate.
        await pool.query(
          `UPDATE proposals SET autopay_status = NULL WHERE id = $1`,
          [proposal.id]
        );
        return;
      }

      // Stripe idempotency key: scoped per (proposal, balance_due_date) so a
      // retried call against the same balance returns the original PaymentIntent
      // instead of charging again. balance_due_date is part of the key so a
      // genuinely new balance (rescheduled event) gets a fresh charge.
      const balanceDueIso = proposal.balance_due_date
        ? new Date(proposal.balance_due_date).toISOString().slice(0, 10)
        : 'no-date';
      const idempotencyKey = `autopay-balance-${proposal.id}-${balanceDueIso}`;

      try {
        const intent = await stripe.paymentIntents.create({
          amount: balanceCents,
          currency: 'usd',
          customer: proposal.stripe_customer_id,
          payment_method: proposal.stripe_payment_method_id,
          off_session: true,
          confirm: true,
          description: `Balance Payment — ${getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom })}`,
          metadata: {
            proposal_id: String(proposal.id),
            payment_type: 'balance',
          },
        }, { idempotencyKey });

        console.log(`[BalanceScheduler] Charged $${(balanceCents / 100).toFixed(2)} for proposal ${proposal.id} (intent: ${intent.id})`);
        // Webhook will handle status update and logging
      } catch (err) {
        console.error(`[BalanceScheduler] Failed to charge proposal ${proposal.id}:`, err.message);
        Sentry.captureException(err, {
          tags: { scheduler: 'autopay', proposalId: proposal.id },
          extra: { amount_cents: balanceCents },
        });

        // Release the claim into a 'failed' state — admin gets a one-time
        // email (throttled below); future cycles won't auto-retry until the
        // claim is reset (e.g. admin re-enrolls or fixes the card).
        try {
          await pool.query(
            `UPDATE proposals SET autopay_status = 'failed' WHERE id = $1`,
            [proposal.id]
          );
        } catch (claimErr) {
          console.error('[BalanceScheduler] Failed to mark autopay_status=failed:', claimErr);
        }

        // Log the failure for admin visibility and capture the inserted row's id
        // so the throttle UPDATE below can target THIS row (not a stale older one
        // if the INSERT silently failed, which would cause re-email every cycle).
        let logRowId = null;
        try {
          const logRes = await pool.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'autopay_failed', 'system', $2) RETURNING id`,
            [proposal.id, JSON.stringify({ error: err.message, amount: balanceCents })]
          );
          logRowId = logRes.rows[0]?.id ?? null;
        } catch (logErr) {
          console.error('[BalanceScheduler] activity-log insert failed:', logErr);
        }

        // Notify admin out-of-band — but throttle to once per 24h per proposal,
        // otherwise a permanently-dead card emails the admin every hour forever.
        // Only proceed if we successfully wrote a log row (otherwise we can't
        // reliably mark it as notified and would re-email next cycle).
        if (logRowId !== null) {
          try {
            const recent = await pool.query(
              `SELECT 1 FROM proposal_activity_log
               WHERE proposal_id = $1 AND action = 'autopay_failed'
                 AND id <> $2
                 AND created_at > NOW() - INTERVAL '24 hours'
                 AND details->>'admin_notified' = 'true'
               LIMIT 1`,
              [proposal.id, logRowId]
            );
            if (recent.rowCount === 0) {
              await sendEmail({
                to: process.env.ADMIN_EMAIL || 'contact@drbartender.com',
                subject: `Autopay failed: proposal #${proposal.id} ($${(balanceCents / 100).toFixed(2)})`,
                html: `<p>Autopay attempt failed for proposal #${proposal.id}.</p><p>Error: ${err.message}</p>`,
              });
              // Mark THIS log row (not the most-recent via ORDER BY) as notified
              await pool.query(
                `UPDATE proposal_activity_log
                 SET details = details || jsonb_build_object('admin_notified', true)
                 WHERE id = $1`,
                [logRowId]
              );
            }
          } catch (mailErr) {
            console.error('[BalanceScheduler] admin email / notify-throttle failed:', mailErr);
          }
        }
      }
    };

    // Chunked parallel execution
    for (let i = 0; i < result.rows.length; i += CONCURRENCY) {
      const chunk = result.rows.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(chargeOne));
    }
  } catch (err) {
    console.error('[BalanceScheduler] Error:', err);
  }
}

/**
 * Auto-complete events that have ended and are fully paid.
 * Transitions proposals from balance_paid/confirmed → completed
 * when event_date + duration has passed and no outstanding balance remains.
 */
async function processEventCompletions() {
  try {
    const result = await pool.query(`
      UPDATE proposals
      SET status = 'completed', updated_at = NOW()
      WHERE status IN ('balance_paid', 'confirmed')
        AND event_date IS NOT NULL
        AND (event_date + (event_duration_hours || ' hours')::interval + (event_start_time || ':00')::interval) < NOW()
        AND (COALESCE(total_price, 0) - COALESCE(amount_paid, 0)) <= 0
      RETURNING id, event_type, event_type_custom
    `);

    if (result.rows.length > 0) {
      console.log(`[BalanceScheduler] Auto-completed ${result.rows.length} event(s): ${result.rows.map(r => `#${r.id}`).join(', ')}`);

      for (const proposal of result.rows) {
        try {
          await pool.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'status_changed', 'system', $2)`,
            [proposal.id, JSON.stringify({ from: 'confirmed/balance_paid', to: 'completed', reason: 'auto_complete' })]
          );
        } catch (logErr) {
          console.error(`[BalanceScheduler] activity-log insert failed for #${proposal.id}:`, logErr);
          Sentry.captureException(logErr, { tags: { scheduler: 'auto-complete', proposalId: proposal.id } });
        }
      }
    }
  } catch (err) {
    console.error('[BalanceScheduler] Auto-completion error:', err);
  }
}

module.exports = { processAutopayCharges, processEventCompletions };
