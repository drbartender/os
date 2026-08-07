'use strict';

/**
 * Public terms acceptance for a service extension (spec section 5.3).
 *
 * PUBLIC, gated by the invoice's UUID token. No auth, so requireUuidToken is
 * mandatory: a non-UUID :token would otherwise reach Postgres as a uuid
 * comparison and raise 22P02 -> 500 (the standing UUID token-guard rule).
 *
 * Acceptance is recorded HERE, server-side, and create-intent-for-invoice
 * refuses an extension invoice until it is stamped (Task 9). A client-side-only
 * gate would let a client who routes around the page pay with no artifact,
 * which is the one thing this feature exists to prevent.
 *
 * Idempotent: re-accepting is a no-op that returns the original timestamp, so a
 * double-tap on a phone cannot rewrite the audit record.
 */

const express = require('express');
const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');
const { publicLimiter } = require('../../middleware/rateLimiters');
const { requireUuidToken } = require('../../utils/tokens');
const { NotFoundError, ConflictError } = require('../../utils/errors');
const { settleExtension } = require('../../utils/serviceExtensionSettle');
const { applyExtensionHours, maybeAlertPayroll, finalizeExtension } = require('../../utils/serviceExtensionPayroll');
const notify = require('../../utils/serviceExtensionNotify');

const router = express.Router();

/** POST /api/service-extensions/t/:token/accept */
router.post(
  '/t/:token/accept',
  requireUuidToken('token', 'This request is no longer available'),
  publicLimiter,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT se.id, se.status, se.amount_cents, se.client_accepted_at,
              se.contracted_end_time, se.requested_end_time, se.expires_at,
              se.proposal_id, p.status AS proposal_status
         FROM service_extensions se
         JOIN invoices i ON i.id = se.invoice_id
         JOIN proposals p ON p.id = se.proposal_id
        WHERE i.token = $1 AND i.status <> 'void'`,
      [req.params.token]
    );
    const ext = rows[0];
    if (!ext) throw new NotFoundError('This request is no longer available');

    if (ext.status !== 'pending') {
      // Already settled: report the terminal state rather than pretending
      // acceptance is still meaningful. `settled` derives from STATUS, never
      // from the acceptance stamp alone: a cancelled/expired row can carry a
      // stamp from a lost race, and reporting settled:true would tell the
      // client their extension went through while the bartender was declined.
      if ((ext.status === 'paid' || ext.status === 'overridden') && ext.client_accepted_at) {
        return res.json({
          accepted: true,
          requiresPayment: false,
          acceptedAt: ext.client_accepted_at,
          settled: true,
        });
      }
      throw new ConflictError('This request has expired.', 'EXTENSION_NOT_PENDING');
    }
    if (new Date(ext.expires_at).getTime() < Date.now()) {
      throw new ConflictError('This request has expired.', 'EXTENSION_EXPIRED');
    }

    // req.ip is the proxy-validated client address (trust proxy is set in
    // index.js) and is bounded; the leftmost X-Forwarded-For entry is client-
    // forgeable and can overflow the VARCHAR(64) column into a 22001 500.
    const ip = (req.ip || '').slice(0, 64) || null;
    const ua = (req.headers['user-agent'] || '').slice(0, 500) || null;

    // Stamp only once. COALESCE keeps the FIRST acceptance as the record, and
    // the status guard keeps a lost race (cancel/expire landing between the
    // read above and this write) from stamping acceptance onto a closed row.
    const upd = await pool.query(
      `UPDATE service_extensions
          SET client_accepted_at = COALESCE(client_accepted_at, NOW()),
              client_accept_ip   = COALESCE(client_accept_ip, $2),
              client_accept_ua   = COALESCE(client_accept_ua, $3),
              updated_at = NOW()
        WHERE id = $1 AND status = 'pending'
        RETURNING client_accepted_at`,
      [ext.id, ip, ua]
    );
    if (!upd.rowCount) {
      throw new ConflictError('This request is no longer pending.', 'EXTENSION_NOT_PENDING');
    }
    const acceptedAt = upd.rows[0].client_accepted_at;

    const amountCents = Number(ext.amount_cents) || 0;
    if (amountCents > 0) {
      // Payment is the settle trigger; the webhook takes it from here.
      return res.json({ accepted: true, requiresPayment: true, acceptedAt });
    }

    // Zero-delta: acceptance itself settles (spec decision 13). Stripe cannot
    // charge $0, and the coverage artifact matters regardless of price.
    const settled = await settleExtension({ extensionId: ext.id, outcome: 'paid' });
    if (!settled.ok && settled.reason === 'past_curfew') {
      // The event's times moved under this pending request and the under-lock
      // re-check refused it on the 2:00 AM insurance curfew. The row stays
      // pending for the sweep; a human must fix the times. Do NOT fall
      // through to the generic response — its settled:false still reads as
      // "confirmed" on InvoicePage, which keys off requiresPayment alone.
      await notify.alertAdminsProblem({
        proposalId: ext.proposal_id,
        kind: 'past_curfew',
        detail: `A no-charge extension was accepted by the client but refused at settle: the new end time is past our 2:00 AM service curfew (the event's times likely moved after the request). ${settled.message || ''} Fix the event times and re-run, or decline it.`,
      });
      throw new ConflictError(
        settled.message || 'That end time is outside our service hours. We will follow up shortly.',
        'EXTENSION_PAST_CURFEW'
      );
    }
    if (settled.ok) {
      // Payroll runs on EVERY settle path, not just the webhook: a zero-delta
      // extension is still time the staffer worked (spec section 9).
      const payroll = await applyExtensionHours({
        proposalId: settled.proposalId,
        newDurationHours: settled.newDurationHours,
      });
      await maybeAlertPayroll(notify, settled.proposalId, payroll);
      await notify.notifyStaffOfOutcome({
        staffUserIds: settled.staffUserIds,
        outcome: 'approved',
        newEndDisplay: settled.newEndDisplay,
        contractedEndDisplay: ext.contracted_end_time,
        proposalId: settled.proposalId,
      });
      if (settled.multiShift) {
        await notify.alertAdminsProblem({
          proposalId: settled.proposalId,
          kind: 'multi_shift',
          detail: `Duration moved to ${settled.newDurationHours}h but the event has multiple shift rows, so no shift end_time was rewritten. Edit the right shift by hand.`,
        });
      }
      // LAST, after payroll and the staff greenlight have both returned: an
      // unstamped settled row is the Task 13 crash-recovery signal, and every
      // settle path (zero-delta accept, admin override, webhook tail) must end
      // here (plan Global Constraints, "Every settle path ends with
      // finalizeExtension").
      await finalizeExtension(ext.id);
    }
    return res.json({ accepted: true, requiresPayment: false, acceptedAt, settled: settled.ok });
  })
);

module.exports = router;
