// stripeWebhook concern: charge.dispute.created / funds_withdrawn / funds_reinstated.
// A TIP dispute runs the payroll clawback on withdrawal and the dispute-won rewind
// and notification on reinstatement (extracted verbatim from stripeWebhook.js); a
// PROPOSAL dispute (audit PAY-04) is told to the admin when it opens, recorded on the
// refund ledger when the funds are withdrawn and reversed when they are reinstated.
// funds_reinstated returns via res (early ack); the other two fall through to the
// dispatcher's ack.
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { clawbackTip, rewindDisputeClawbackByPaymentIntent } = require('../../utils/payrollClawback');
const { findDisputedPayment, recordDisputeWithdrawal, reverseDisputeWithdrawal } = require('../../utils/disputeLedger');
const { notifyAdminCategory } = require('../../utils/adminNotifications');

const usd = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

// Email-first admin alert on the money-anomaly lane, fire-and-forget from the
// post-commit tail (notifyAdminCategory takes its own pooled connection).
function notifyAdmin(subject, line) {
  return notifyAdminCategory({
    category: 'payment_failure', subject, emailText: line, emailHtml: `<p>${line}</p>`,
  }).catch((err) => {
    console.error('dispute admin notify failed (non-blocking):', err && err.message);
  });
}

async function findTip(paymentIntentId) {
  if (!paymentIntentId) return null;
  const { rows } = await pool.query(
    'SELECT id, amount_cents, refunded_amount_cents FROM tips WHERE stripe_payment_intent_id = $1',
    [paymentIntentId]
  );
  return rows[0] || null;
}

/**
 * charge.dispute.created (audit PAY-04): a proposal charge is being disputed.
 * No money moves yet (funds_withdrawn does that), so this only records the
 * fact and tells the admin, who has days to respond to Stripe. Idempotent on
 * the dispute id through the activity log. Tips are left to their own flow.
 */
async function handleDisputeCreated(event) {
  const dispute = event.data.object;
  const piId = dispute.payment_intent;
  if (await findTip(piId)) return;
  const pay = await findDisputedPayment(piId);
  if (!pay) return;
  const seen = await pool.query(
    `SELECT 1 FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = 'dispute_opened' AND details->>'dispute_id' = $2 LIMIT 1`,
    [pay.proposalId, dispute.id]
  );
  if (seen.rowCount > 0) return;
  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
     VALUES ($1, 'dispute_opened', 'system', $2)`,
    [pay.proposalId, JSON.stringify({
      dispute_id: dispute.id, amount: Number(dispute.amount || 0), reason: dispute.reason || null,
      payment_intent_id: piId, payment_id: pay.id, evidence_due_by: dispute.evidence_details?.due_by || null,
    })]
  );
  notifyAdmin(
    `Chargeback opened on proposal #${pay.proposalId} (${usd(dispute.amount)})`,
    `The client's bank opened a dispute for ${usd(dispute.amount)} on a payment for proposal #${pay.proposalId} (Stripe dispute ${dispute.id}, reason: ${dispute.reason || 'not given'}). Respond with evidence in the Stripe dashboard before the deadline. When Stripe withdraws the funds the payment panel will show the chargeback in the refund history and the balance will read as owed again; if the dispute is won the money is restored automatically.`
  );
}

/**
 * charge.dispute.funds_withdrawn. A tip: the payroll clawback, with the
 * cumulative refunded figure the helper expects (audit POUT-06: dispute.amount
 * is the DISPUTED amount, not a running total, so a tip partly refunded 3,000
 * and then disputed for the remaining 7,000 must claw to 10,000, not 7,000;
 * capped at the tip's own amount; the dispute-won rewind subtracts the same
 * slice back out, and a deferred clawback stores this same cumulative as its
 * target). A proposal payment: the withdrawal is recorded on the refund ledger
 * as a 'dispute'-scope row (disputeLedger.js), capped at what is still on the
 * charge, and the admin is told. Errors propagate so Stripe retries; both
 * writers are idempotent on the dispute id.
 */
async function handleDisputeFundsWithdrawn(event) {
  const dispute = event.data.object;
  const piId = dispute.payment_intent;
  const disputedCents = Number(dispute.amount || 0);
  if (!piId || !Number.isInteger(disputedCents) || disputedCents <= 0) return;

  const tip = await findTip(piId);
  if (tip) {
    const cumulative = Math.min(Number(tip.refunded_amount_cents || 0) + disputedCents, Number(tip.amount_cents));
    await clawbackTip(tip.id, cumulative);
    return;
  }

  const pay = await findDisputedPayment(piId);
  if (!pay) return; // not a proposal charge of ours
  const amountCents = Math.min(disputedCents, pay.remainingCents);
  if (amountCents <= 0) {
    Sentry.captureMessage('dispute_withdrawal_exceeds_charge_remainder', {
      level: 'warning',
      tags: { webhook: 'stripe', event: 'charge.dispute.funds_withdrawn' },
      extra: { proposalId: pay.proposalId, paymentId: pay.id, disputeId: dispute.id, disputedCents, remainingCents: pay.remainingCents },
    });
    notifyAdmin(
      `Chargeback withdrew funds already refunded (proposal #${pay.proposalId})`,
      `Stripe withdrew ${usd(disputedCents)} for dispute ${dispute.id} on a payment for proposal #${pay.proposalId} that the ledger shows as already refunded in full. Nothing was recorded; reconcile this by hand against the Stripe dashboard.`
    );
    return;
  }

  const dbClient = await pool.connect();
  let recon;
  try {
    await dbClient.query('BEGIN');
    recon = await recordDisputeWithdrawal({
      proposalId: pay.proposalId, paymentId: pay.id, paymentIntentId: piId,
      disputeId: dispute.id, amountCents, disputeReason: dispute.reason,
    }, dbClient);
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    Sentry.captureException(err, { tags: { webhook: 'stripe', event: 'charge.dispute.funds_withdrawn' } });
    throw err; // 5xx: Stripe retries, and the ledger anchor makes the retry a no-op once applied
  } finally {
    dbClient.release();
  }
  if (recon && recon.applied) {
    notifyAdmin(
      `Chargeback withdrew ${usd(amountCents)} from proposal #${pay.proposalId}`,
      `Stripe withdrew ${usd(amountCents)} for dispute ${dispute.id} on a payment for proposal #${pay.proposalId}. The ledger now shows the money gone: the balance reads as owed again, the invoice it paid is payable again, and the refund history carries the chargeback. Autopay, if it was armed, is off for this booking. If the dispute is won the funds are restored automatically; a later refund or cancellation will not return money the bank already took.`
    );
  }
}

/**
 * charge.dispute.funds_reinstated. A tip: the F5 rewind and the dispute-won
 * notification (unchanged). A proposal payment (audit PAY-04): the recorded
 * withdrawal is reversed and the admin told. Idempotent on the row's status.
 */
async function handleDisputeFundsReinstated(event, res) {
    const dispute = event.data.object;
    const piId = dispute.payment_intent;
    if (piId) {
      // F5: roll the clawback counter back FIRST, decoupled from the admin email.
      // Not gated on dispute_won_at (the ledger must not wait on email delivery)
      // — it carries its own idempotency column, tips.dispute_reinstated_at.
      // Errors propagate so Stripe retries the delivery; the rewind is a no-op
      // on redelivery, and notifyDisputeWon below is idempotent via dispute_won_at.
      await rewindDisputeClawbackByPaymentIntent(piId, Number(dispute.amount || 0));

      const { rows } = await pool.query('SELECT id FROM tips WHERE stripe_payment_intent_id = $1', [piId]);
      if (rows[0]) {
        try {
          const { notifyDisputeWon } = require('../../utils/payrollDisputeNotify');
          await notifyDisputeWon(rows[0].id, {
            reinstatedAmountCents: Number(dispute.amount || 0),
            disputeOpenedAt: dispute.created ? new Date(dispute.created * 1000) : null,
            disputeWonAt: new Date(),
          });
        } catch (err) { Sentry.captureException(err, { tags: { webhook: 'tip_dispute_won' } }); }
      } else {
        const pay = await findDisputedPayment(piId);
        if (pay) {
          const dbClient = await pool.connect();
          let result;
          try {
            await dbClient.query('BEGIN');
            result = await reverseDisputeWithdrawal({ proposalId: pay.proposalId, disputeId: dispute.id }, dbClient);
            await dbClient.query('COMMIT');
          } catch (err) {
            try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
            Sentry.captureException(err, { tags: { webhook: 'stripe', event: 'charge.dispute.funds_reinstated' } });
            throw err;
          } finally {
            dbClient.release();
          }
          if (result && result.reversed) {
            notifyAdmin(
              `Chargeback won: ${usd(result.amountCents)} restored to proposal #${pay.proposalId}`,
              `Stripe reinstated ${usd(result.amountCents)} for dispute ${dispute.id} on proposal #${pay.proposalId}. The ledger is restored: the payment counts again, the invoice it paid is paid again and the status is back. Autopay was not re-armed; re-enrol the client by hand if you want it.`
            );
          }
        }
      }
    }
    return res.json({ received: true });
}

module.exports = { handleDisputeCreated, handleDisputeFundsWithdrawn, handleDisputeFundsReinstated };
