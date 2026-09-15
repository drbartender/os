// server/routes/stripeWebhookHandlers/paymentIntentProcessing.js
// stripeWebhook concern: payment_intent.processing (spec 2026-09-14 section
// 4.1). A bank debit confirms into `processing` and settles four to six
// business days later. This handler is the ONLY writer of
// stripe_sessions.status = 'processing'; the succeeded and payment_failed
// handlers release it. Every consumer reads it through
// utils/paymentInFlight.js.
//
// Idempotency is the row's own state: only a still-pending row moves, so a
// redelivery, or a processing event delivered after succeeded or
// payment_failed, matches nothing and changes nothing. One activity row per
// real transition. The client email runs post-commit, after release.
const { pool } = require('../../db');
const { notifyClientBankPaymentProcessing, notifyAdminBankPaymentProcessing } = require('../../utils/bankPaymentProcessingNotify');
const { STRIPE_RETRIEVE_OPTS } = require('../../utils/paymentInFlight');

module.exports = async function handlePaymentIntentProcessing(event, stripe) {
  const intent = event.data.object;
  const proposalId = Number(intent.metadata?.proposal_id);
  if (!Number.isInteger(proposalId) || proposalId <= 0) return;
  const paymentType = intent.metadata?.payment_type || 'deposit';
  const metaInvoiceId = Number(intent.metadata?.invoice_id);
  const amountCents = Number(intent.amount) || 0;

  // A 'failed' row is allowed to move (a declined card retried as a bank
  // debit on the same intent), but Stripe does not promise event order: a
  // payment_failed delivered BEFORE a delayed processing event would leave a
  // failed row that this event must not revive. So a failed row moves only
  // when Stripe itself reports the intent processing right now; unknown means
  // it stays released (fail closed). Read BEFORE the transaction so no pooled
  // connection waits on Stripe.
  let failedRowMayMove = false;
  const current = await pool.query(
    'SELECT status FROM stripe_sessions WHERE stripe_payment_intent_id = $1 AND proposal_id = $2',
    [intent.id, proposalId]
  );
  if (current.rows[0] && current.rows[0].status === 'failed') {
    if (stripe) {
      try {
        // No network retry here: this runs before the ack, and Stripe gives a
        // delivery 30 seconds. One attempt at ten keeps the headroom; a slow
        // Stripe fails the delivery below and Stripe retries it.
        const live = await stripe.paymentIntents.retrieve(intent.id, { ...STRIPE_RETRIEVE_OPTS, maxNetworkRetries: 0 });
        failedRowMayMove = live && live.status === 'processing';
      } catch (err) {
        // Unknown at Stripe is "stay released". Anything else (network, a
        // Stripe 5xx, the timeout) is a real unknown: throw here, before the
        // ledger insert, so the delivery 500s with no ledger row and Stripe
        // retries it. Swallowing it would acknowledge the event with the row
        // still failed and the real debit invisible for its whole window.
        if (err && err.code === 'resource_missing') {
          console.warn(`Webhook: intent ${intent.id} is unknown at Stripe; its failed row stays failed`);
        } else {
          throw err;
        }
      }
    }
  }

  const dbClient = await pool.connect();
  let transitioned = false;
  try {
    await dbClient.query('BEGIN');

    // Event-level idempotency, the same ledger payment_failed uses: Stripe
    // redelivers at least once, and a queued retry of THIS event can land
    // after payment_failed has already released the row for a bounced debit.
    // Inside the transaction on purpose: if anything below fails, the ledger
    // row rolls back with it and Stripe's retry is processed, not dropped.
    const firstSeen = await dbClient.query(
      `INSERT INTO webhook_events (provider, event_id) VALUES ('stripe', $1)
       ON CONFLICT (provider, event_id) DO NOTHING RETURNING event_id`,
      [event.id]
    );
    if (firstSeen.rowCount === 0) {
      await dbClient.query('ROLLBACK');
      console.log(`Webhook: duplicate payment_intent.processing delivery for event ${event.id} (proposal ${proposalId}), skipping`);
      return;
    }

    // Ownership check, the same rule as the succeeded handler's invoice link:
    // an invoice id that does not belong to this proposal is stored as NULL.
    let invoiceId = null;
    if (Number.isInteger(metaInvoiceId) && metaInvoiceId > 0) {
      const own = await dbClient.query(
        'SELECT id FROM invoices WHERE id = $1 AND proposal_id = $2',
        [metaInvoiceId, proposalId]
      );
      if (own.rows[0]) invoiceId = metaInvoiceId;
    }

    // Scoped by proposal as well as intent id, like every sibling writer, so a
    // row can never take another proposal's invoice. A 'failed' row moves only
    // when Stripe confirmed above that the intent is processing right now:
    // that covers a declined card retried as a bank debit, and a bounced
    // debit retried with another bank account on the same intent. A late or
    // out-of-order processing event finds Stripe saying otherwise and leaves
    // the row released; a true redelivery never gets past the ledger.
    // 'succeeded' and 'processing' never move.
    const upd = await dbClient.query(
      `UPDATE stripe_sessions
          SET status = 'processing', processing_at = NOW(), invoice_id = COALESCE($2, invoice_id)
        WHERE stripe_payment_intent_id = $1 AND proposal_id = $3
          AND (status = 'pending' OR (status = 'failed' AND $4::boolean))
        RETURNING id`,
      [intent.id, invoiceId, proposalId, failedRowMayMove]
    );
    transitioned = upd.rowCount === 1;

    if (!transitioned) {
      // No pending row. Either the intent was already released (redelivery,
      // or processing delivered after succeeded), in which case the unique
      // index makes this a no-op, or the intent was minted outside the app
      // and still carries our metadata, in which case the guard must see it.
      const ins = await dbClient.query(
        `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status, processing_at, invoice_id)
         VALUES ($1, $2, $3, 'processing', NOW(), $4)
         ON CONFLICT (stripe_payment_intent_id) DO NOTHING
         RETURNING id`,
        [proposalId, intent.id, amountCents, invoiceId]
      );
      transitioned = ins.rowCount === 1;
    }

    if (transitioned) {
      await dbClient.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'payment_processing', 'system', $2)`,
        [proposalId, JSON.stringify({ amount: amountCents, payment_intent_id: intent.id, payment_type: paymentType, invoice_id: invoiceId })]
      );
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (_) { /* connection already dead */ }
    throw err;
  } finally {
    dbClient.release();
  }

  // Post-commit, after release: the notifier takes its own pooled connection
  // (one pooled connection per request). Fire and forget, like the receipt.
  if (transitioned) {
    notifyClientBankPaymentProcessing({ proposalId, amountCents, paymentType })
      .catch((err) => console.error('bank payment processing notify failed (non-blocking):', err && err.message));
    notifyAdminBankPaymentProcessing({ proposalId, amountCents, paymentType })
      .catch((err) => console.error('bank payment processing admin notify failed (non-blocking):', err && err.message));
  }
};
