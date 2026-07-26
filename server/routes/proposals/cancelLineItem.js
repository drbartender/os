// Cancel line item (spec 2026-07-22): one admin act that removes a
// client-visible priced line and settles the money. Three endpoints:
//   GET  /api/proposals/:id/cancel-line/targets  — cancellable-line enumeration
//   POST /api/proposals/:id/cancel-line/preview  — server-computed consequence preview
//   POST /api/proposals/:id/cancel-line          — execute + post-commit refunds
//
// Mounted from proposals/index.js BEFORE the catch-all getOne; every path is a
// sub-path under /:id/cancel-line*, so it never collides with the bare /:id.
//
// One computation, two callers: preview runs applyLineItemCancel inside
// BEGIN..ROLLBACK; execute runs the SAME core and COMMITs, so the confirm
// button restates exactly what execute will do. The removal commits FIRST;
// refunds fire post-commit sequentially per split (totalScope='overpayment'
// so reconciliation never re-lowers the already-folded total). A Stripe
// failure leaves the removal standing with the overpaid flag; the payment
// panel + pending-refund sweeper are the retry path.

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, adminOnly, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { AppError } = require('../../utils/errors');
const { getStripe } = require('../../utils/stripeClient');
const { refundExecute } = require('../../utils/refundExecute');
const { loadPaymentsWithRemaining, planOverpaymentSplits } = require('../../utils/refundHelpers');
const { computeCancelTargets, applyLineItemCancel } = require('../../utils/lineItemCancel');
const { sendRefundClientNotification } = require('../../utils/refundClientNotify');
const { refreshListAfterLabChange } = require('../drinkPlans/labListRefresh');
const { sendGratuityRemovedStaffNotice } = require('../../utils/gratuityStaffNotice');
const { sendLineItemRemovedNotice } = require('../../utils/lineItemRemovedNotify');

const router = express.Router();

router.get('/:id/cancel-line/targets', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  res.json(await computeCancelTargets(pool, req.params.id));
}));

// Run the shared core + refund planning inside a fresh transaction. On
// success the CALLER owns the held client: preview ROLLBACKs + releases,
// execute COMMITs + releases BEFORE the refund/notice tail (one-pooled-
// connection rule). On error this rolls back, releases, and rethrows.
async function runCore(req, { expectFingerprint = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyLineItemCancel(client, {
      proposalId: req.params.id,
      target: req.body.target,
      quantity: req.body.quantity ?? null,
      newRate: req.body.new_rate ?? null,
      actorId: req.user.id,
      expectFingerprint,
    });
    const payments = await loadPaymentsWithRemaining(req.params.id, client);
    const plan = planOverpaymentSplits({
      paymentsWithRemaining: payments,
      overpaymentCents: result.overpaymentCents,
    });
    return { client, result, plan, commit: () => client.query('COMMIT') };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;

function previewBody(req, result, plan) {
  return {
    target: req.body.target,
    removed_label: result.removedLabel,
    old_total: result.oldTotal,
    new_total: result.newTotal,
    delta: round2(result.newTotal - result.oldTotal),
    amount_paid: result.fingerprint.amount_paid,
    external_paid: result.externalPaid,
    new_balance_due: round2(Math.max(0, result.newTotal - result.fingerprint.amount_paid)),
    overpayment_cents: result.overpaymentCents,
    refund: {
      splits: plan.splits.length,
      stripe_cents: plan.stripeRefundableCents,
      manual_return_cents: plan.manualReturnCents,
    },
    status_will_change: result.statusChanged,
    new_status: result.newStatus,
    locked_invoices: result.lockedInvoices.map((i) => ({
      id: i.id, label: i.label, amount_due_cents: i.amount_due,
    })),
    delta_invoices_adjusted: result.deltaInvoicesAdjusted.map((i) => ({
      id: i.id, label: i.label, from_cents: i.fromCents, to_cents: i.toCents,
    })),
    staffing_warning: result.staffingWarning,
    gratuity: result.gratuity
      ? {
          new_rate: result.gratuity.newRate,
          tip_jar_after: result.gratuity.tipJarAfter,
          staff_notice: result.gratuity.staffNotice,
        }
      : null,
    lab_cleanup: result.labCleaned,
    fingerprint: result.fingerprint,
  };
}

router.post('/:id/cancel-line/preview', auth, adminOnly, adminWriteLimiter, asyncHandler(async (req, res) => {
  const { client, result, plan } = await runCore(req);
  try {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  res.json(previewBody(req, result, plan));
}));

router.post('/:id/cancel-line', auth, adminOnly, adminWriteLimiter, asyncHandler(async (req, res) => {
  const proposalId = req.params.id;
  const { reason, idempotency_key, notify_client, fingerprint } = req.body;
  if (!reason || !String(reason).trim()) {
    throw new AppError('A reason is required.', 400, 'REASON_REQUIRED');
  }
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    throw new AppError('Missing idempotency key. Reopen the dialog and retry.', 400, 'MISSING_IDEMPOTENCY_KEY');
  }
  if (!fingerprint || typeof fingerprint !== 'object') {
    throw new AppError('Missing preview fingerprint. Reopen the dialog and retry.', 400, 'MISSING_FINGERPRINT');
  }

  const { client, result, plan, commit } = await runCore(req, { expectFingerprint: fingerprint });
  try {
    await commit();
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release(); // BEFORE the tail: refundExecute + notices take their own connections.

  // Refunds, sequential per split. Stop on the first failure: the removal
  // stands (committed), the proposal reads overpaid, and the payment panel +
  // stranded-pending sweeper are the retry path. Idempotency keys are
  // per-split so a client retry of the whole act can never double-refund.
  const refunds = [];
  let refundIncomplete = false;
  const stripe = getStripe();
  for (let i = 0; i < plan.splits.length; i++) {
    const s = plan.splits[i];
    try {
      const r = await refundExecute({
        stripe,
        proposalId: Number(proposalId),
        paymentId: s.paymentId,
        paymentIntentId: s.paymentIntentId,
        amountCents: s.amountCents,
        reason: String(reason).trim(),
        issuedBy: req.user.id,
        idempotencyKey: `cancel-line-${proposalId}-${idempotency_key}-${i}`,
        totalPriceBeforeDollars: result.newTotal,
        totalPriceAfterDollars: result.newTotal,
        totalScope: 'overpayment',
      });
      refunds.push({
        payment_id: s.paymentId, amount_cents: s.amountCents,
        status: 'succeeded', refund_row_id: r.refundRowId,
      });
    } catch (err) {
      refunds.push({
        payment_id: s.paymentId, amount_cents: s.amountCents,
        status: err.code === 'REFUND_REJECTED' ? 'failed' : 'unconfirmed',
      });
      refundIncomplete = true;
      break;
    }
  }

  // Follow-up audit row carrying the refund ids (spec: "refund IDs when money
  // moved"); the in-tx 'line_item_cancelled' row could not have them.
  if (plan.splits.length > 0) {
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'line_item_cancel_refunded', 'admin', $2, $3)`,
      [proposalId, req.user.id, JSON.stringify({
        refund_row_ids: refunds.filter((r) => r.refund_row_id).map((r) => r.refund_row_id),
        amount_cents: refunds.filter((r) => r.status === 'succeeded').reduce((sum, r) => sum + r.amount_cents, 0),
        manual_return_cents: plan.manualReturnCents,
        incomplete: refundIncomplete,
      })]
    ).catch((e) => {
      if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(e, { tags: { route: 'cancelLineItem', step: 'refund_audit' } });
      console.error('[cancelLineItem] refund audit row failed (non-blocking):', e.message);
    });
  }

  // Notices, all best-effort. Staff tip-jar notice is MANDATORY on a
  // jar-relevant gratuity change, independent of notify_client.
  const notifications = [];
  try {
    if (result.gratuity?.staffNotice) {
      const n = await sendGratuityRemovedStaffNotice({ proposalId, newRate: result.gratuity.newRate });
      notifications.push({ type: 'gratuity_staff_notice', ...n });
    }
    const refundedCents = refunds.filter((r) => r.status === 'succeeded').reduce((sum, r) => sum + r.amount_cents, 0);
    if (notify_client === true && refundedCents > 0) {
      const n = await sendRefundClientNotification({ proposalId, amountCents: refundedCents, source: 'cancel_line' });
      notifications.push({ type: 'refund_notice', ...n });
    } else if (notify_client === true && plan.splits.length === 0) {
      // No Stripe splits: either nothing is owed back, or the overpayment is
      // all external/CC money returned by hand — the notice says so.
      const n = await sendLineItemRemovedNotice({
        proposalId, removedLabel: result.removedLabel, newTotal: result.newTotal,
        manualReturnCents: plan.manualReturnCents,
      });
      notifications.push({ type: 'line_item_removed_notice', ...n });
    } else if (notify_client === true) {
      // Splits were planned but none succeeded: the item is gone and money is
      // still owed. Emailing either story would be wrong (the refund notice
      // names money that never moved; the removal notice implies nothing is
      // owed), so tell the ADMIN no notice went out and let them resolve the
      // refund first (push review, 2026-07-26).
      notifications.push({
        type: 'client_notice',
        email: 'skipped',
        skip_reasons: { email: 'Refund did not complete, so no client notice was sent. Finish the refund, then tell the client.' },
      });
    }
  } catch (e) {
    if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(e, { tags: { route: 'cancelLineItem', step: 'notices' } });
    console.error('[cancelLineItem] notice failed (non-blocking):', e.message);
  }
  if (result.labCleaned && result.labPlanId) {
    setImmediate(() => refreshListAfterLabChange(result.labPlanId));
  }

  res.json({
    removed: true,
    removed_label: result.removedLabel,
    new_total: result.newTotal,
    new_status: result.newStatus,
    refunds: refunds.map(({ payment_id, amount_cents, status }) => ({ payment_id, amount_cents, status })),
    refund_incomplete: refundIncomplete,
    manual_return_cents: plan.manualReturnCents,
    notifications,
  });
}));

module.exports = router;
