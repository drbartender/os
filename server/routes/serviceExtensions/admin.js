'use strict';

/**
 * Admin surfaces for service extensions (spec sections 5.6, 8).
 *
 * Override grants the time and VOIDS the invoice (decision 14). It does NOT
 * leave an open invoice to collect: per decision 12 an unpaid extension is not
 * a receivable DRB carries, so there is deliberately no aging view, no
 * reminder, and no collect action anywhere in this feature.
 *
 * Because extension money is side money, an unpaid override cannot demote
 * payment status, block auto-completion, or disturb the funded-gratuity gate.
 * That is the entire reason the override is safe now.
 */

const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError, ConflictError } = require('../../utils/errors');
const { settleExtension, closeExtension } = require('../../utils/serviceExtensionSettle');
const { applyExtensionHours, maybeAlertPayroll, finalizeExtension } = require('../../utils/serviceExtensionPayroll');
const { cancelOpenInvoiceIntents } = require('../../utils/invoiceVoid');
const { logAdminAction } = require('../../utils/adminAuditLog');
const notify = require('../../utils/serviceExtensionNotify');

const router = express.Router();

/** Void the extension's invoice and cancel any open intent against it. */
async function voidExtensionInvoice(proposalId, invoiceId) {
  if (!invoiceId) return;
  // Best-effort intent cancel first, so a client mid-checkout cannot complete
  // against an invoice we are about to void.
  await cancelOpenInvoiceIntents(proposalId, invoiceId);
  await pool.query(
    "UPDATE invoices SET status = 'void', updated_at = NOW() WHERE id = $1 AND status <> 'paid'",
    [invoiceId]
  );
}

/**
 * Payroll warning text when the event's hours are already accrued and
 * admin-edited, so the automatic re-seed will refuse to touch them.
 * Mirrors the rule in serviceExtensionPayroll (Task 12a).
 */
async function payrollWarningFor(proposalId) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS locked
       FROM payout_events pe
       JOIN shifts s ON s.id = pe.shift_id
      WHERE s.proposal_id = $1
        AND pe.hours IS DISTINCT FROM pe.contracted_hours`,
    [proposalId]
  );
  return rows[0] && rows[0].locked > 0
    ? 'Payroll hours for this event were edited by hand, so the extra time was NOT added automatically. Update the payout line yourself.'
    : null;
}

/** GET /api/service-extensions/proposal/:proposalId */
router.get('/proposal/:proposalId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const proposalId = Number(req.params.proposalId);
  if (!Number.isInteger(proposalId) || proposalId <= 0 || proposalId > 2147483647) throw new ValidationError({ proposalId: 'Invalid event.' });
  const { rows } = await pool.query(
    `SELECT se.id, se.status, se.amount_cents, se.gratuity_cents,
            se.contracted_end_time, se.requested_end_time,
            se.contracted_duration_hours, se.requested_duration_hours,
            se.client_accepted_at, se.expires_at, se.created_at,
            se.override_reason, se.hosted_product_confirmed,
            se.requested_by_user_id, se.invoice_id,
            i.status AS invoice_status, i.token AS invoice_token,
            -- users has NO \`name\` column; human names live on
            -- contractor_profiles.preferred_name. Fall back to the email.
            COALESCE(cp.preferred_name, u.email) AS requested_by_name,
            COALESCE(ovcp.preferred_name, ov.email) AS override_by_name
       FROM service_extensions se
       LEFT JOIN invoices i ON i.id = se.invoice_id
       LEFT JOIN users u ON u.id = se.requested_by_user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = se.requested_by_user_id
       LEFT JOIN users ov ON ov.id = se.override_by_user_id
       LEFT JOIN contractor_profiles ovcp ON ovcp.user_id = se.override_by_user_id
      WHERE se.proposal_id = $1
      ORDER BY se.id DESC`,
    [proposalId]
  );
  res.json({ extensions: rows, payrollWarning: await payrollWarningFor(proposalId) });
}));

/** POST /api/service-extensions/:id/override */
router.post('/:id/override', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new ValidationError({ id: 'Invalid request.' });
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 3) throw new ValidationError({ reason: 'Give a short reason for the override.' });
  if (reason.length > 500) throw new ValidationError({ reason: 'Keep the reason under 500 characters.' });

  const probe = await pool.query(
    'SELECT status, contracted_end_time FROM service_extensions WHERE id = $1',
    [id]
  );
  if (!probe.rows[0]) throw new NotFoundError('Request not found');

  const settled = await settleExtension({
    extensionId: id, outcome: 'overridden',
    actorUserId: req.user.id, overrideReason: reason,
  });
  if (!settled.ok) {
    throw new ConflictError(
      `This request is already ${probe.rows[0].status}.`,
      'EXTENSION_NOT_PENDING'
    );
  }

  // Decision 14: no receivable survives an override.
  await voidExtensionInvoice(settled.proposalId, settled.invoiceId);

  // The staffer worked the time regardless of who paid for it, so payroll runs
  // on this path too (spec section 9: "wage hours still accrue" for an override).
  const payroll = await applyExtensionHours({
    proposalId: settled.proposalId,
    newDurationHours: settled.newDurationHours,
  });
  await maybeAlertPayroll(notify, settled.proposalId, payroll);

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'service_extension_override',
    metadata: {
      extension_id: id,
      proposal_id: settled.proposalId,
      reason,
      new_duration_hours: settled.newDurationHours,
      amount_cents_waived: settled.amountCents,
    },
  });

  await notify.notifyStaffOfOutcome({
    staffUserIds: settled.staffUserIds,
    outcome: 'approved',
    newEndDisplay: settled.newEndDisplay,
    contractedEndDisplay: probe.rows[0].contracted_end_time,
    proposalId: settled.proposalId,
  });
  if (settled.multiShift) {
    await notify.alertAdminsProblem({
      proposalId: settled.proposalId,
      kind: 'multi_shift',
      detail: `Duration moved to ${settled.newDurationHours}h but this event has multiple shift rows, so no shift end_time was rewritten. Edit the right shift by hand.`,
    });
  }

  // Every settle path ends with finalizeExtension, LAST, after payroll and the
  // staff greenlight have both returned (plan Global Constraints). A settled row
  // with finalized_at NULL is the Task 13 crash-recovery signal; stamping it
  // early or skipping it breaks the heal in opposite directions.
  await finalizeExtension(id);

  res.json({
    status: 'overridden',
    newEndTime: settled.newEndDisplay,
    newDurationHours: settled.newDurationHours,
    payrollWarning: await payrollWarningFor(settled.proposalId),
  });
}));

/** POST /api/service-extensions/:id/cancel */
router.post('/:id/cancel', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new ValidationError({ id: 'Invalid request.' });

  const probe = await pool.query(
    'SELECT status, contracted_end_time FROM service_extensions WHERE id = $1',
    [id]
  );
  if (!probe.rows[0]) throw new NotFoundError('Request not found');

  const closed = await closeExtension({
    extensionId: id, outcome: 'cancelled', actorUserId: req.user.id,
  });
  if (!closed.ok) {
    throw new ConflictError(`This request is already ${probe.rows[0].status}.`, 'EXTENSION_NOT_PENDING');
  }

  await voidExtensionInvoice(closed.proposalId, closed.invoiceId);

  await logAdminAction({
    actorUserId: req.user.id,
    targetUserId: null,
    action: 'service_extension_cancel',
    metadata: { extension_id: id, proposal_id: closed.proposalId },
  });

  await notify.notifyStaffOfOutcome({
    staffUserIds: closed.staffUserIds,
    outcome: 'declined',
    newEndDisplay: null,
    contractedEndDisplay: probe.rows[0].contracted_end_time,
    proposalId: closed.proposalId,
  });

  res.json({ status: 'cancelled' });
}));

module.exports = router;
