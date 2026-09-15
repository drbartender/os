// stripeWebhook concern: refund.created (spec 2026-09-15). THE reconciler for a
// refund issued outside the app, and the backstop for one issued inside it.
//
// Why this event and not charge.refunded: the live endpoint runs API version
// 2025-01-27.acacia, and from that version the Charge object no longer carries a
// `refunds` list. The old chargeRefunded handler read `charge.refunds.data[0]`,
// which is `undefined` there, so it silently reconciled nothing — the reason a
// dashboard refund of a duplicate bank debit never reached the database (prod
// 784). Stripe's own guidance is the same: "Listen to refund.created for
// information about the refund." The payload here IS the Refund object, so this
// handler makes no Stripe API call and no API version can take it away again.
//
// Failure posture: rethrow. A dashboard refund has no pending proposal_refunds
// row, and refundSweepScheduler only selects pending rows, so NOTHING else
// backstops this path. A swallowed error would ack the event and lose the refund
// permanently, which is the exact defect this handler exists to close.
const Sentry = require('@sentry/node');
const { pool } = require('../../db');

function warn(message, extra) {
  console.warn(`Webhook refund.created: ${message}`);
  if (process.env.SENTRY_DSN_SERVER) {
    // Ids and cents only. Never a client name or address.
    Sentry.captureMessage(`refund_created: ${message}`, {
      level: 'warning',
      tags: { webhook: 'stripe', event: 'refund.created' },
      extra,
    });
  }
}

module.exports = async function handleRefundCreated(event) {
  const refund = event.data.object;

  // A refund with no PaymentIntent is a legacy Charges-API refund. Reconciling
  // it would write a NULL-intent refund row, precisely the class the stale-pending
  // sweeper flags as unadoptable (it cannot list refunds for a null intent
  // without going account-wide).
  const paymentIntentId = typeof refund.payment_intent === 'string'
    ? refund.payment_intent
    : refund.payment_intent?.id;
  if (!paymentIntentId) {
    warn('refund carries no payment_intent; not reconciled', { refundId: refund.id, amount: refund.amount });
    return;
  }

  // failed / canceled never moved money. pending and succeeded both reconcile:
  // a bank refund sits pending for days, and that is the same state the sweeper
  // already adopts, so the two paths cannot disagree about when a refund counts.
  if (refund.status === 'failed' || refund.status === 'canceled') return;
  // requires_action means Stripe is still collecting bank details from the
  // customer and no money has moved; it expires to `failed` if they never
  // answer. Not reachable with the pinned checkout methods (card, Link, bank
  // debit all refund to the original instrument), so reaching it means a
  // payment method we do not think we accept produced a refund. Say so rather
  // than record money that has not moved.
  if (refund.status === 'requires_action') {
    warn('refund is awaiting customer bank details (requires_action); not reconciled', {
      refundId: refund.id, paymentIntentId, amount: refund.amount,
    });
    return;
  }

  // DB is the source of truth for attribution; metadata only tells us whether an
  // unattributable refund is worth warning about. A refund we cannot tie to a
  // succeeded payment row must NOT be reconciled: applyRefundReconciliation
  // skips its whole invoice walk when paymentId is null, so a contract-scope
  // refund would drop total_price by the full amount with no non-contract and no
  // off-ledger netting — the most destructive branch available.
  const payRow = await pool.query(
    `SELECT id, proposal_id FROM proposal_payments
      WHERE stripe_payment_intent_id = $1 AND status = 'succeeded' LIMIT 1`,
    [paymentIntentId]
  );
  if (!payRow.rows[0]) {
    if (refund.metadata?.proposal_id) {
      warn('refund names a proposal but no succeeded payment row matches its intent; not reconciled', {
        refundId: refund.id, paymentIntentId, amount: refund.amount,
        metaProposalId: String(refund.metadata.proposal_id),
      });
    }
    return; // a tip refund or a charge that is not ours
  }
  const paymentId = payRow.rows[0].id;
  const proposalId = Number(payRow.rows[0].proposal_id);
  if (!Number.isInteger(proposalId) || proposalId <= 0) {
    // proposal_payments.proposal_id is nullable. Without this the reconciler is
    // handed proposal 0, throws, and the rethrow below turns into a permanent
    // 500 that Stripe retries for days.
    warn('payment row has no proposal; not reconciled', {
      refundId: refund.id, paymentIntentId, paymentId,
    });
    return;
  }

  // Adopt the exact row Stripe names (refundExecute stamps it on every in-app
  // refund), and let THAT row's total_scope decide the money rule. With no such
  // metadata this is a dashboard refund with no row of its own, so the
  // (intent, amount) heuristic is suppressed: a stranded pending row of the same
  // amount would otherwise rewrite this refund's money semantics.
  const rowIdMeta = Number(refund.metadata?.proposal_refund_row_id);
  const namedRowId = Number.isInteger(rowIdMeta) && rowIdMeta > 0 ? rowIdMeta : null;

  let reason = `Refunded via Stripe dashboard (${refund.reason || 'no reason given'})`;
  let issuedBy = null;
  let totalScope = null;
  let pendingRowId = null;
  let excessCents = 0;

  const dbClient = await pool.connect();
  let recon = null;
  try {
    await dbClient.query('BEGIN');
    // Take the proposals row lock BEFORE deciding anything, and hold it through
    // reconciliation. The scope decision reads amount_paid, so reading it on the
    // pool first was a read-then-act across a lock boundary on the value that
    // decides whether total_price moves: two dashboard refunds seconds apart
    // both saw the same pre-refund excess and both classified as overpayment,
    // leaving the contract un-corrected with no warning. Flagged by three
    // independent reviewers, 2026-09-15. applyRefundReconciliation re-locks the
    // same row inside this same transaction, which is free.
    await dbClient.query('SELECT id FROM proposals WHERE id = $1 FOR UPDATE', [proposalId]);

    if (namedRowId) {
      // Validate the id Stripe echoed back before letting it pick a row. It is
      // externally supplied, and the heuristic it replaced constrained intent
      // AND amount, so an unchecked lookup would have LESS validation than the
      // path it replaced. A row that does not match every predicate is not ours
      // to adopt: fall through to the derived scope instead.
      const own = await dbClient.query(
        `SELECT id, reason, issued_by FROM proposal_refunds
          WHERE id = $1 AND proposal_id = $2 AND stripe_payment_intent_id = $3
            AND amount = $4 AND status = 'pending' AND stripe_refund_id IS NULL`,
        [namedRowId, proposalId, paymentIntentId, refund.amount]
      );
      if (own.rows[0]) {
        pendingRowId = own.rows[0].id;
        // Keep the audit line the issuing path's, not this handler's.
        reason = own.rows[0].reason;
        issuedBy = own.rows[0].issued_by;
      } else {
        warn('refund names a pending row that does not match this proposal, charge and amount; deriving the scope instead', {
          refundId: refund.id, namedRowId, proposalId, paymentIntentId, amount: refund.amount,
        });
      }
    }

    if (!pendingRowId) {
      // Scope from the netted excess as well as Stripe's reason (spec D5), now
      // computed under the lock. The reason is an operator-chosen string and the
      // dashboard default is 'requested_by_customer', so deciding a contract-
      // LOWERING rule from it alone would silently reproduce the bug this spec
      // closes: a genuine overpayment refunded with the default reason would
      // shrink the contract.
      const { overpaymentCents } = require('../../utils/refundHelpers');
      excessCents = await overpaymentCents(proposalId, dbClient);
      totalScope = (refund.reason === 'duplicate' || excessCents >= refund.amount)
        ? 'overpayment'
        : 'contract';
    }

    const { applyRefundReconciliation } = require('../../utils/refundHelpers');
    recon = await applyRefundReconciliation(
      {
        proposalId,
        stripeRefundId: refund.id,
        paymentIntentId,
        paymentId,
        amountCents: refund.amount,
        reason,
        issuedBy,
        totalScope,
        pendingRowId,
        allowPendingHeuristic: false,
      },
      dbClient
    );
    await dbClient.query('COMMIT');
    console.log(`refund.created reconciled for proposal ${proposalId} (refund ${refund.id}, scope ${totalScope || 'from row'}, applied ${recon.applied})`);
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { webhook: 'stripe', event: 'refund.created' } });
    }
    console.error('Webhook refund.created error:', err);
    throw err; // 5xx → Stripe retries. Nothing else backstops a dashboard refund.
  } finally {
    dbClient.release();
  }

  // Post-release (sendRefundClientNotification takes its own pooled connection).
  // Only for a refund no in-app path issued: a panel or cancel-line refund's
  // client notice belongs to that path and the admin's notify-client answer,
  // which this handler cannot see. Staying silent risks a missed notice; sending
  // would risk an email the admin explicitly declined.
  // Keyed on namedRowId, NOT pendingRowId: a refund carrying a row id that
  // failed validation is still one an in-app path issued, so its notice is
  // still that path's to send or suppress. Gating on the validated id would
  // email a client whose admin answered "do not email".
  if (recon?.applied && !namedRowId) {
    const { sendRefundClientNotification } = require('../../utils/refundClientNotify');
    await sendRefundClientNotification({
      proposalId,
      amountCents: refund.amount,
      source: 'refund_created_webhook',
    });
  }

  // Money-rule warnings, ids and cents only. These stay on pendingRowId: they
  // are only meaningful when THIS handler derived the scope.
  if (recon?.applied && !pendingRowId) {
    if (totalScope === 'contract' && excessCents > 0) {
      warn('contract-scope dashboard refund landed on an overpaid proposal; total_price was lowered by the contract portion', {
        proposalId, refundId: refund.id, amount: refund.amount, nettedOverpaymentCents: excessCents,
      });
    }
    if (totalScope === 'overpayment' && excessCents < refund.amount) {
      warn('overpayment-scope dashboard refund exceeds the netted overpayment; the money has moved, so correct total_price in the editor', {
        proposalId, refundId: refund.id, amount: refund.amount, nettedOverpaymentCents: excessCents,
      });
    }
  }
};
