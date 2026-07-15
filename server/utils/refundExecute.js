'use strict';

/**
 * refundExecute — execute ONE Stripe refund against a single succeeded charge
 * and reconcile it idempotently. Extracted verbatim from the inline
 * orchestration that lived in routes/stripe.js POST /refund/:id, so BOTH the
 * admin partial-refund route AND the cancel-event refund endpoint issue refunds
 * through one code path. There is never a raw stripe.refunds.create outside this
 * util (P6.4).
 *
 * Steps (identical to the prior inline flow, so the existing refund tests pin it):
 *   1. INSERT a 'pending' proposal_refunds row BEFORE Stripe, so a Stripe success
 *      we then fail to record stays discoverable + adoptable by the webhook backstop.
 *   2. stripe.refunds.create({ payment_intent, amount }, { idempotencyKey }).
 *   3. applyRefundReconciliation inside its own transaction (idempotent by refund id).
 *   4. Delete the now-redundant pending row when reconciliation no-op'd (applied=false).
 *
 * Stripe is dependency-injected (never getStripe() here) so callers and tests
 * supply the client. One pooled connection per checkout, sequential — the pending
 * insert and the tx never overlap.
 *
 * @param {object} a
 * @param {object} a.stripe                 DI Stripe client
 * @param {number} a.proposalId
 * @param {number} a.paymentId              proposal_payments.id (the target charge)
 * @param {string} a.paymentIntentId        stripe_payment_intent_id of that charge
 * @param {number} a.amountCents            cents to refund on this charge
 * @param {string} a.reason
 * @param {number|null} a.issuedBy          users.id, or null (out-of-band)
 * @param {string} a.idempotencyKey         Stripe idempotency key
 * @param {number} a.totalPriceBeforeDollars proposals.total_price snapshot (dollars)
 * @param {number} a.totalPriceAfterDollars  worst-case preview (dollars); recon overwrites
 * @param {number|null} [a.gratuityCents]   gratuity portion attributed to this refund (cents)
 * @returns {Promise<{refund:object, recon:{applied:boolean}, refundRowId:number}>}
 */
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { PaymentError, ExternalServiceError } = require('./errors');
const { applyRefundReconciliation } = require('./refundHelpers');

async function refundExecute({
  stripe, proposalId, paymentId, paymentIntentId, amountCents, reason,
  issuedBy, idempotencyKey, totalPriceBeforeDollars, totalPriceAfterDollars,
  gratuityCents = null,
}) {
  // 1. Pending row BEFORE Stripe. gratuity_cents (nullable) records the gratuity
  //    portion of THIS refund for audit; the existing admin route passes null,
  //    so its behavior is unchanged (column stays NULL).
  const pendRes = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status, gratuity_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9)
     RETURNING id`,
    [proposalId, paymentId, paymentIntentId, amountCents, reason,
     totalPriceBeforeDollars, totalPriceAfterDollars, issuedBy, gratuityCents]
  );
  const pendingRowId = pendRes.rows[0].id;

  // 2. Stripe. metadata carries the pending row id + proposal id so the
  //    stranded-pending sweeper (refundSweepScheduler.js) can match a refund
  //    Stripe processed back to this exact row, and so the refund is traceable
  //    in the Stripe dashboard.
  let refund;
  try {
    refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: amountCents,
        metadata: {
          proposal_refund_row_id: String(pendingRowId),
          proposal_id: String(proposalId),
        },
      },
      { idempotencyKey }
    );
  } catch (err) {
    console.error('Stripe refund error:', err);
    // Split by certainty. ONLY a definitive rejection (Stripe refused the
    // request; no money moved) may fail the row. StripeCardError and
    // StripeInvalidRequestError are the two definitive families.
    if (err.type === 'StripeInvalidRequestError' || err.type === 'StripeCardError') {
      await pool.query(`UPDATE proposal_refunds SET status = 'failed' WHERE id = $1`, [pendingRowId]);
      throw new PaymentError(`Refund rejected: ${err.message}`, 'REFUND_REJECTED');
    }
    // Ambiguous (StripeConnectionError socket timeout, StripeAPIError 5xx,
    // unknown): the refund MAY have reached Stripe. Marking 'failed' here would
    // re-open refund headroom and let a retry issue a SECOND real refund.
    // Leave the row 'pending' — it blocks headroom conservatively (e97dfec) and
    // the sweeper reconciles it against Stripe within the hour.
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { util: 'refundExecute', outcome: 'ambiguous_pending' } });
    }
    throw new ExternalServiceError(
      'Stripe',
      err,
      'The refund status is unconfirmed. It will auto-resolve within the hour. Do not re-issue it.'
    );
  }

  // 3. Reconcile in its own tx. applyRefundReconciliation adopts the pending row
  //    (preserving the gratuity_cents we stamped) or no-ops if this refund id was
  //    already applied by a concurrent winner.
  const dbClient = await pool.connect();
  let recon;
  try {
    await dbClient.query('BEGIN');
    recon = await applyRefundReconciliation(
      {
        proposalId: Number(proposalId),
        stripeRefundId: refund.id,
        paymentIntentId,
        paymentId,
        amountCents,
        reason,
        issuedBy,
      },
      dbClient
    );
    await dbClient.query('COMMIT');
  } catch (dbErr) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(dbErr, { tags: { util: 'refundExecute', proposalId } });
    }
    // Money already left via Stripe; the charge.refunded webhook backstop adopts
    // our pending row and reconciles. Surface (not a silent success).
    console.error('Refund reconciliation failed (webhook will backstop):', dbErr);
    throw new ExternalServiceError(
      'Database',
      dbErr,
      'Refund was processed by Stripe; the records will finish syncing momentarily.'
    );
  } finally {
    dbClient.release();
  }

  // 4. applied===false → reconciliation no-op'd because this refund id was
  //    already applied (idempotent winner). Our pending row is redundant — delete
  //    it so it can't strand as a ghost 'pending' history entry.
  if (recon && recon.applied === false) {
    await pool.query(
      `DELETE FROM proposal_refunds
        WHERE id = $1 AND status = 'pending' AND stripe_refund_id IS NULL`,
      [pendingRowId]
    );
  }

  return { refund, recon, refundRowId: pendingRowId };
}

module.exports = { refundExecute };
