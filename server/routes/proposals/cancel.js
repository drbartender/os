// Cancel booked events (P6, fix #7). Admin/manager only. Three endpoints:
//   POST /api/proposals/:id/cancel/preview  — server-computed consequence preview
//   POST /api/proposals/:id/cancel          — execute the cancellation (transactional)
//   POST /api/proposals/:id/cancel/refund   — issue the agreement refund (admin only)
//
// Mounted from proposals/index.js BEFORE the catch-all getOne. Every path here is
// a sub-path under /:id/cancel*, so it never collides with the bare /:id verb.
//
// MONEY SEAM: all cancellation math runs in CENTS assembled from invoice/payment
// rows (cancellationMath.js). proposals.total_price / amount_paid (DOLLARS) are
// used ONLY for the gratuity-funded gate (mirroring payrollAccrual), never in the
// refund arithmetic.

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, adminOnly, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { AppError, ValidationError, ConflictError, NotFoundError } = require('../../utils/errors');
const { getStripe } = require('../../utils/stripeClient');
const { computeCancellationRefund } = require('../../utils/cancellationMath');
const { extractGratuityCents } = require('../../utils/payrollMath');
const { refundExecute } = require('../../utils/refundExecute');
const { clawbackTipsForCancelledProposal } = require('../../utils/payrollClawback');
const { notifyStaffOfCancellation } = require('../../utils/staffShiftHandlers');
const { reapShiftsForProposal } = require('../../utils/shiftReap');
const { cancelOpenInvoiceIntents } = require('../../utils/invoiceVoid');
const { cancelMarketingForProposal } = require('../../utils/marketingHandlers');
const { cancelPendingChangeRequestsForProposal } = require('../../utils/changeRequests');
const { sendRefundClientNotification } = require('../../utils/refundClientNotify');
const { sendEmail } = require('../../utils/email');
const lifecycleTemplates = require('../../utils/lifecycleEmailTemplates');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const { chicagoTodayYmd, chicagoYmdOf } = require('../../utils/businessTime');

const router = express.Router();

const BOOKED_STATUSES = ['deposit_paid', 'balance_paid', 'confirmed'];

// Friendly labels for the comms-halt preview list.
const COMMS_LABELS = {
  balance_reminder_autopay_t3: 'Balance reminder (autopay)',
  balance_reminder_non_autopay_t3: 'Balance reminder',
  balance_due_today: 'Balance due reminder',
  balance_late_t1: 'Late balance reminder',
  balance_late_t3: 'Late balance reminder',
  balance_due_today_sms: 'Balance due SMS',
  balance_late_t1_sms: 'Late balance SMS',
  balance_late_t3_sms: 'Late balance SMS',
  event_eve: 'Event-eve reminder SMS',
  shift_reminder: 'Staff shift reminder',
  staff_thank_you: 'Staff thank-you',
};

function toCalendarYmd(value) {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

// Whole days from fromYmd to toYmd (calendar-only, DST-safe).
function wholeDaysBetween(fromYmd, toYmd) {
  if (!fromYmd || !toYmd) return 0;
  const [fy, fm, fd] = fromYmd.split('-').map(Number);
  const [ty, tm, td] = toYmd.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

function usd(cents) { return `$${(cents / 100).toFixed(2)}`; }

// The typed last name matches the client record if it equals the last
// whitespace-delimited token of the name (case-insensitive), or the full name.
function lastNameMatches(fullName, typed) {
  const t = String(typed || '').trim().toLowerCase();
  if (!t) return false;
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return false;
  return t === parts[parts.length - 1].toLowerCase() || t === parts.join(' ').toLowerCase();
}

/**
 * Assemble every cents value the cancellation math needs, from invoice/payment
 * rows. `noticeYmd` (default today, Chicago) is the notice date used for daysOut.
 */
async function assembleContext(executor, proposalId, noticeYmd) {
  const propRes = await executor.query(
    `SELECT p.id, p.status, p.total_price, p.amount_paid, p.event_date,
            p.pricing_snapshot, p.event_type, p.event_type_custom, p.client_id,
            p.autopay_status, p.autopay_enrolled, p.cancelled_at, p.cancelled_by,
            c.name AS client_name, c.email AS client_email
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal) return null;

  const paidRes = await executor.query(
    `SELECT COALESCE(SUM(amount), 0)::int AS cents
       FROM proposal_payments WHERE proposal_id = $1 AND status = 'succeeded'`,
    [proposalId]
  );
  const amountPaidCents = Number(paidRes.rows[0].cents);

  const retRes = await executor.query(
    `SELECT COALESCE(SUM(amount_paid), 0)::int AS cents
       FROM invoices WHERE proposal_id = $1 AND label = 'Deposit'`,
    [proposalId]
  );
  const retainerCents = Number(retRes.rows[0].cents);

  // Gratuity-funded gate: identical to payrollAccrual — the gratuity pool is
  // "paid" only when the proposal is paid in full (proposals dollars -> cents).
  const proposalTotalCents = Math.round(Number(proposal.total_price || 0) * 100);
  const proposalPaidCents = Math.round(Number(proposal.amount_paid || 0) * 100);
  const gratuityFunded = proposalPaidCents >= proposalTotalCents && proposalTotalCents > 0;
  const gratuityPaidCents = gratuityFunded ? extractGratuityCents(proposal.pricing_snapshot) : 0;

  const eventYmd = toCalendarYmd(proposal.event_date);
  const daysOut = wholeDaysBetween(noticeYmd || chicagoTodayYmd(), eventYmd);

  return { proposal, amountPaidCents, retainerCents, gratuityPaidCents, daysOut, eventYmd };
}

function outcomeCopy(mode, math) {
  if (mode === 'drb') {
    return 'Because we cancelled, everything you paid, including your retainer, is being refunded in full.';
  }
  const lines = [];
  if (math.excessCents > 0 || math.feeCents > 0) {
    lines.push('Your retainer is non-refundable per the event services agreement.');
  }
  if (math.gratuityCents > 0) {
    lines.push('The gratuity you paid comes back to you in full.');
  }
  if (math.refundCents === 0) {
    lines.push('No refund is due under the agreement for a cancellation at this point.');
  }
  return lines.join(' ') || 'The cancellation is confirmed.';
}

function refundLineCopy(refundCents) {
  return refundCents > 0 ? `You will be refunded ${usd(refundCents)}.` : null;
}

// ─── Preview ─────────────────────────────────────────────────────
router.post('/:id/cancel/preview', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const mode = req.body?.mode === 'drb' ? 'drb' : 'client';
  const ctx = await assembleContext(pool, req.params.id);
  if (!ctx) throw new NotFoundError('Proposal not found');
  const { proposal } = ctx;

  const math = computeCancellationRefund({
    mode,
    daysOut: ctx.daysOut,
    amountPaidCents: ctx.amountPaidCents,
    retainerCents: ctx.retainerCents,
    gratuityPaidCents: ctx.gratuityPaidCents,
  });

  const staffRes = await pool.query(
    `SELECT DISTINCT COALESCE(cp.preferred_name, u.email) AS name, sr.position
       FROM shifts s
       JOIN shift_requests sr ON sr.shift_id = s.id AND sr.status = 'approved' AND sr.dropped_at IS NULL
       JOIN users u ON u.id = sr.user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE s.proposal_id = $1 AND s.status <> 'cancelled'
      ORDER BY name`,
    [req.params.id]
  );

  const commsRes = await pool.query(
    `SELECT DISTINCT sm.message_type
       FROM scheduled_messages sm
      WHERE sm.status = 'pending'
        AND (
          (sm.entity_type = 'proposal' AND sm.entity_id = $1)
          OR (sm.entity_type = 'shift'
              AND sm.entity_id IN (SELECT id FROM shifts WHERE proposal_id = $1))
        )`,
    [req.params.id]
  );
  const commsHalted = commsRes.rows.map(r => COMMS_LABELS[r.message_type] || r.message_type);
  if (proposal.autopay_enrolled && proposal.status === 'deposit_paid') {
    commsHalted.push('Automatic balance charge (autopay)');
  }

  const eventTypeLabel = getEventTypeLabel({
    event_type: proposal.event_type, event_type_custom: proposal.event_type_custom,
  });
  const emailPreview = lifecycleTemplates.cancellationConfirmation({
    clientName: proposal.client_name,
    eventTypeLabel,
    outcomeLine: outcomeCopy(mode, math),
    refundLine: refundLineCopy(math.refundCents),
    cancelledBy: mode === 'drb' ? 'admin' : 'client',
  });

  const blocking = [];
  if (proposal.status === 'archived') blocking.push('already_archived');
  if (proposal.status === 'completed') blocking.push('completed');
  if (!BOOKED_STATUSES.includes(proposal.status) && proposal.status !== 'archived' && proposal.status !== 'completed') {
    blocking.push('not_booked');
  }
  if (proposal.autopay_status === 'in_progress') blocking.push('autopay_in_progress');

  res.json({
    days_out: ctx.daysOut,
    mode,
    refund_cents: math.refundCents,
    refund_breakdown: {
      gratuity_cents: math.gratuityCents,
      excess_cents: math.excessCents,
      fee_cents: math.feeCents,
    },
    amount_paid_cents: ctx.amountPaidCents,
    retainer_cents: ctx.retainerCents,
    staff: staffRes.rows.map(r => ({ name: r.name, position: r.position })),
    comms_halted: [...new Set(commsHalted)],
    email_preview: { subject: emailPreview.subject, text: emailPreview.text },
    blocking,
  });
}));

// ─── Cancel (execute) ────────────────────────────────────────────
router.post('/:id/cancel', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const mode = req.body?.mode === 'drb' ? 'drb' : (req.body?.mode === 'client' ? 'client' : null);
  if (!mode) throw new ValidationError({ mode: "mode must be 'client' or 'drb'." });
  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 5000) : '';
  const suppressClientEmail = req.body?.suppress_client_email === true;
  const suppressStaffNotifications = req.body?.suppress_staff_notifications === true;
  const confirmLastName = req.body?.confirm_last_name;

  const archiveReason = mode === 'drb' ? 'we_cancelled' : 'client_cancelled';
  const cancelledBy = mode === 'drb' ? 'admin' : 'client';
  const noticeYmd = chicagoTodayYmd();

  let math = null;
  let voidedInvoiceIds = [];
  let survivingInvoiceIds = []; // sent/partially_paid invoices left intact (B3 piece 3)
  let affectedShiftStaff = []; // [{ shiftId, userIds }]
  const bartendersByShift = new Map(); // shiftId -> [bartender user ids], captured pre-denial
  let clientEmail = null;
  let eventTypeLabel = 'event';

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Lock the client row first (global order clients -> proposals), then the
    // proposal — matches the archive/settle paths so cancel can never AB-BA
    // deadlock a concurrent settle.
    const peek = await dbClient.query('SELECT client_id FROM proposals WHERE id = $1', [req.params.id]);
    if (!peek.rows[0]) throw new NotFoundError('Proposal not found');
    if (peek.rows[0].client_id !== null) {
      await dbClient.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [peek.rows[0].client_id]);
    }

    const ctx = await assembleContext(dbClient, req.params.id, noticeYmd);
    if (!ctx) throw new NotFoundError('Proposal not found');
    // Re-read status under a row lock so a concurrent settle/archive serializes here.
    const locked = await dbClient.query(
      'SELECT status, autopay_status FROM proposals WHERE id = $1 FOR UPDATE', [req.params.id]);
    const status = locked.rows[0].status;
    const autopayStatus = locked.rows[0].autopay_status;

    // Idempotent guards, mirroring the archive-path rejections.
    if (status === 'archived') throw new ConflictError('This booking is already archived.', 'ALREADY_ARCHIVED');
    if (status === 'completed') throw new ConflictError('A completed event cannot be cancelled.', 'ALREADY_COMPLETED');
    if (!BOOKED_STATUSES.includes(status)) {
      throw new ConflictError('Only a booked event can be cancelled here.', 'NOT_CANCELLABLE');
    }
    // A mid-flight balance charge can settle AFTER we archive; block until it clears.
    if (autopayStatus === 'in_progress') {
      throw new ConflictError('A balance charge is in progress. Wait for it to settle before cancelling.', 'AUTOPAY_IN_PROGRESS');
    }

    // Server-side last-name guard (the UI gate is bypassable). 422 with a precise
    // message so the admin dialog can surface it inline.
    if (!lastNameMatches(ctx.proposal.client_name, confirmLastName)) {
      throw new AppError('The last name does not match our records.', 422, 'LAST_NAME_MISMATCH');
    }

    clientEmail = ctx.proposal.client_email;
    eventTypeLabel = getEventTypeLabel({
      event_type: ctx.proposal.event_type, event_type_custom: ctx.proposal.event_type_custom,
    });

    math = computeCancellationRefund({
      mode, daysOut: ctx.daysOut,
      amountPaidCents: ctx.amountPaidCents, retainerCents: ctx.retainerCents,
      gratuityPaidCents: ctx.gratuityPaidCents,
    });

    // 1. Archive the proposal with the cancellation metadata.
    await dbClient.query(
      `UPDATE proposals
          SET status = 'archived', archive_reason = $2,
              cancelled_at = NOW(), cancelled_by = $3, cancellation_note = $4,
              updated_at = NOW()
        WHERE id = $1`,
      [req.params.id, archiveReason, cancelledBy, note || null]
    );

    // 2. Cancel every non-cancelled linked shift + reap its staffing side effects
    //    via the shared reaper (also used by the archive endpoint, so the two
    //    kill switches can never drift). bartendersByShift feeds the post-commit
    //    tip clawback (approved bartenders captured PRE-denial); affectedShiftStaff
    //    feeds the cancellation notifications (any approved staffer).
    const reaped = await reapShiftsForProposal(req.params.id, dbClient, 'event cancelled');
    for (const { shiftId, userIds, bartenderUserIds } of reaped) {
      bartendersByShift.set(shiftId, bartenderUserIds);
      if (userIds.length) affectedShiftStaff.push({ shiftId, userIds });
    }

    // 3. Delete pending proposal-level scheduled comms (balance reminders, event-eve).
    await dbClient.query(
      `DELETE FROM scheduled_messages
        WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
      [req.params.id]
    );

    // 4. Void unpaid invoices (Balance/etc. with nothing paid). Same UPDATE the
    //    invoice-void util runs, minus its proposal-level amount_paid=0 guard,
    //    which is inappropriate for a paid-but-cancelled booking. Paid/partly-paid
    //    invoices (amount_paid > 0) are left intact.
    const voided = await dbClient.query(
      `UPDATE invoices SET status = 'void', updated_at = NOW()
        WHERE proposal_id = $1 AND amount_paid = 0 AND status IN ('draft', 'sent', 'partially_paid')
        RETURNING id`,
      [req.params.id]
    );
    voidedInvoiceIds = voided.rows.map(r => r.id);

    // B3 piece 3: partially/paid invoices (amount_paid > 0) survive the void as the
    // payment record, but their public pay page stays live. Capture the survivors so
    // the post-commit PI-cancel loop closes those open checkout windows too. Runs
    // AFTER the void so voided ids are excluded (the two sets stay disjoint).
    const survivors = await dbClient.query(
      `SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid')`,
      [req.params.id]
    );
    survivingInvoiceIds = survivors.rows.map(r => r.id);

    // 5. Audit: append the computed math + original contract total to admin_notes,
    //    and write a queryable activity-log row.
    const auditLine = `\n[${new Date().toISOString()}] Cancelled (${mode === 'drb' ? 'Dr. Bartender' : 'client'}). `
      + `Contract total ${usd(Math.round(Number(ctx.proposal.total_price || 0) * 100))}, paid ${usd(ctx.amountPaidCents)}, `
      + `retainer ${usd(ctx.retainerCents)}. Refund owed per agreement: ${usd(math.refundCents)} `
      + `(gratuity ${usd(math.gratuityCents)}, excess ${usd(math.excessCents)}, fee ${usd(math.feeCents)}).`
      + (note ? ` Note: ${note}` : '');
    await dbClient.query(
      `UPDATE proposals SET admin_notes = COALESCE(admin_notes, '') || $2 WHERE id = $1`,
      [req.params.id, auditLine]
    );
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'cancelled', 'admin', $2, $3)`,
      [req.params.id, req.user.id, JSON.stringify({
        mode, archive_reason: archiveReason, cancelled_by: cancelledBy,
        days_out: ctx.daysOut,
        amount_paid_cents: ctx.amountPaidCents, retainer_cents: ctx.retainerCents,
        contract_total_cents: Math.round(Number(ctx.proposal.total_price || 0) * 100),
        refund_owed_cents: math.refundCents,
        refund_breakdown: {
          gratuity_cents: math.gratuityCents, excess_cents: math.excessCents, fee_cents: math.feeCents,
        },
        suppress_client_email: suppressClientEmail,
        suppress_staff_notifications: suppressStaffNotifications,
      })]
    );

    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }

  // ── Post-commit tail (own connections; failures never unwind the archive) ──

  // Gratuity/tip clawback at cancel time so a cancel WITHOUT a refund still claws.
  // Idempotent (tips.refunded_amount_cents); the charge.refunded webhook no-ops
  // against the same marker on any later refund.
  try {
    await clawbackTipsForCancelledProposal(req.params.id, bartendersByShift);
  } catch (clawErr) {
    Sentry.captureException(clawErr, { tags: { route: 'proposals/cancel', step: 'clawback' }, extra: { proposalId: req.params.id } });
    console.error('[cancel] tip clawback failed (non-blocking):', clawErr.message);
  }

  // Reap marketing + pending change requests, matching the archive lifecycle.
  try {
    await cancelMarketingForProposal(req.params.id);
    await cancelPendingChangeRequestsForProposal(req.params.id);
  } catch (reapErr) {
    Sentry.captureException(reapErr, { tags: { route: 'proposals/cancel', step: 'reap' } });
  }

  // Cancel open checkout PaymentIntents for each voided AND surviving invoice
  // (B3 piece 3). cancelOpenInvoiceIntents never touches 'processing' intents, so
  // a settling charge is untouched; a client mid-checkout on a cancelled event
  // gets a card-declined-style error. Best-effort; never unwinds the archive.
  for (const invId of [...voidedInvoiceIds, ...survivingInvoiceIds]) {
    try { await cancelOpenInvoiceIntents(req.params.id, invId); } catch (_) { /* best-effort */ }
  }

  // Staff notifications (email by default; SMS costs). Respects the suppress toggle.
  let staffNotified = 0;
  if (!suppressStaffNotifications) {
    for (const { shiftId, userIds } of affectedShiftStaff) {
      try {
        const r = await notifyStaffOfCancellation({ shiftId, staffUserIds: userIds, kind: 'cancelled', sms: false, email: true });
        staffNotified += (r?.emailSent || 0);
      } catch (notifyErr) {
        Sentry.captureException(notifyErr, { tags: { route: 'proposals/cancel', step: 'staff-notify' } });
      }
    }
  }

  // Client cancellation email (email over SMS). Respects the suppress toggle.
  if (!suppressClientEmail && clientEmail) {
    try {
      const tpl = lifecycleTemplates.cancellationConfirmation({
        clientName: (await pool.query('SELECT c.name FROM proposals p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1', [req.params.id])).rows[0]?.name,
        eventTypeLabel,
        outcomeLine: outcomeCopy(mode, math),
        refundLine: refundLineCopy(math.refundCents),
        cancelledBy,
      });
      await sendEmail({ to: clientEmail, ...tpl });
    } catch (emailErr) {
      Sentry.captureException(emailErr, { tags: { route: 'proposals/cancel', step: 'client-email' } });
    }
  }

  res.json({
    status: 'archived',
    archive_reason: archiveReason,
    cancelled_by: cancelledBy,
    refund_cents: math.refundCents,
    refund_breakdown: {
      gratuity_cents: math.gratuityCents, excess_cents: math.excessCents, fee_cents: math.feeCents,
    },
    voided_invoice_ids: voidedInvoiceIds,
    staff_notified: staffNotified,
  });
}));

// ─── Refund (execute; admin only, money OUT) ─────────────────────

// App-level advisory-lock class for cancellation refunds. Two concurrent
// /cancel/refund submissions for the SAME proposal serialize on
// pg_advisory_xact_lock(CLASS, proposalId); different proposals never contend.
const CANCEL_REFUND_LOCK_CLASS = 74206;

router.post('/:id/cancel/refund', auth, adminOnly, adminWriteLimiter, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
  const { idempotency_key } = req.body || {};
  // One visible decision covers the whole cancel flow: the dialog's existing
  // suppress checkbox now governs this refund email too (notify-client
  // contract, 2026-07-22). Inherited polarity: absent/false = SEND, matching
  // the cancellation-email flag it extends (cancel.js:237), NOT the
  // notify_client family's fail-quiet default.
  const suppressClientEmail = req.body?.suppress_client_email === true;
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    throw new AppError('Missing idempotency key. Reopen the refund and retry.', 400, 'MISSING_IDEMPOTENCY_KEY');
  }
  const proposalIdNum = Number(req.params.id);
  if (!Number.isInteger(proposalIdNum)) throw new NotFoundError('Proposal not found');

  let alreadyRefunded = 0;
  let refundedCents = 0;
  let shortfallCents = 0;
  let anyApplied = false;
  const perCharge = [];

  // Serialize the read-compute-issue sequence per proposal: two overlapping
  // requests could otherwise both read the same alreadyRefunded/remaining set
  // and double-issue a PARTIAL amount (full refunds are already idempotent via
  // the remaining-target cap). Advisory xact lock, NOT a proposals-row FOR
  // UPDATE: refundExecute's applyRefundReconciliation takes that row lock on
  // its OWN pooled connection, so an outer row lock would self-deadlock. The
  // lock auto-releases at COMMIT/ROLLBACK. One client throughout; released
  // before the notification tail (CLAUDE.md one-connection rule).
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await dbClient.query('SELECT pg_advisory_xact_lock($1, $2)', [CANCEL_REFUND_LOCK_CLASS, proposalIdNum]);

    const ctx = await assembleContext(dbClient, req.params.id);
    if (!ctx) throw new NotFoundError('Proposal not found');
    const { proposal } = ctx;
    if (!proposal.cancelled_at) {
      throw new ConflictError('This proposal has not been cancelled, so no cancellation refund applies.', 'NOT_CANCELLED');
    }

    const mode = proposal.cancelled_by === 'admin' ? 'drb' : 'client';
    // daysOut is fixed at the notice (cancellation) date, not "now". The notice
    // date is the CHICAGO calendar day of cancelled_at — the execute path used
    // chicagoTodayYmd(), and toCalendarYmd on a TIMESTAMPTZ reads the GMT day
    // on prod, flipping the <=14d agreement branch for evening cancels.
    const daysOut = wholeDaysBetween(chicagoYmdOf(proposal.cancelled_at), ctx.eventYmd);
    const math = computeCancellationRefund({
      mode, daysOut,
      amountPaidCents: ctx.amountPaidCents, retainerCents: ctx.retainerCents,
      gratuityPaidCents: ctx.gratuityPaidCents,
    });

    // Lifetime cap on money-out (B5). Each refund's reconciliation reverses the
    // Deposit invoice (retainer) FIRST, so a retry re-reads a shrunken retainerCents
    // and computes a HIGHER live target — over-refunding ~0.95x the retainer. Cap at
    // the agreement figure recorded atomically at cancel time (refund_owed_cents in
    // the 'cancelled' activity-log row), plus post-cancel succeeded payments (B3
    // money is refundable cent-for-cent on top of the agreement). Cap only (min),
    // never target-replacement — under-refund beats double-refund. No snapshot
    // (legacy/manually-cancelled data) → live math + Sentry warn (status quo). All
    // reads on the held dbClient (one-connection rule; inside the advisory-lock tx).
    const snapRes = await dbClient.query(
      `SELECT (details->>'refund_owed_cents')::int AS owed
         FROM proposal_activity_log
        WHERE proposal_id = $1 AND action = 'cancelled'
          AND details->>'refund_owed_cents' IS NOT NULL
        ORDER BY id DESC LIMIT 1`,
      [req.params.id]
    );
    let effectiveTargetCents = math.refundCents;
    if (snapRes.rows[0]) {
      const owedCents = Number(snapRes.rows[0].owed);
      const postCancelRes = await dbClient.query(
        `SELECT COALESCE(SUM(amount), 0)::int AS cents FROM proposal_payments
          WHERE proposal_id = $1 AND status = 'succeeded' AND created_at > $2`,
        [req.params.id, proposal.cancelled_at]
      );
      const postCancelCents = Number(postCancelRes.rows[0].cents);
      effectiveTargetCents = Math.min(math.refundCents, owedCents + postCancelCents);
    } else {
      Sentry.captureMessage('cancel/refund: no cancel snapshot; refunding against live math', {
        level: 'warning',
        tags: { route: 'proposals/cancel', step: 'refund_no_snapshot' },
        extra: { proposalId: proposalIdNum },
      });
    }

    // Already-refunded caps how much of the target remains. 'pending' counts:
    // a pending row means refundExecute reached Stripe but reconciliation
    // hasn't landed (the charge.refunded webhook adopts it) — that money may
    // already be out, so a retry with a fresh idempotency key must NOT
    // re-issue it. A stranded pre-Stripe pending row blocks conservatively
    // (under-refund beats double-refund) until it resolves.
    const priorRes = await dbClient.query(
      `SELECT COALESCE(SUM(amount), 0)::int AS cents FROM proposal_refunds
        WHERE proposal_id = $1 AND status IN ('succeeded', 'pending')`,
      [req.params.id]
    );
    alreadyRefunded = Number(priorRes.rows[0].cents);
    let remainingTarget = Math.max(0, effectiveTargetCents - alreadyRefunded);

    // Refundable charges, largest-first, netting prior succeeded AND pending
    // (possibly in-flight) refunds per charge. Unlike the admin partial-refund
    // route, which deliberately excludes the drink_plan_* rails from MANUAL
    // refunds, a cancellation refund covers the client's full payment set —
    // assembleContext sums every succeeded payment into the target, so every
    // Stripe-reachable rail must be refundable or the gap silently strands.
    const payRes = await dbClient.query(
      `SELECT pp.id, pp.stripe_payment_intent_id,
              pp.amount
                - COALESCE((SELECT SUM(pr.amount) FROM proposal_refunds pr
                             WHERE pr.payment_id = pp.id AND pr.status IN ('succeeded', 'pending')), 0)
                AS "remainingCents"
         FROM proposal_payments pp
        WHERE pp.proposal_id = $1 AND pp.status = 'succeeded'
          AND pp.stripe_payment_intent_id IS NOT NULL
          AND pp.payment_type IN ('deposit', 'balance', 'full', 'invoice',
                                  'drink_plan_with_balance', 'drink_plan_extras')
        ORDER BY "remainingCents" DESC`,
      [req.params.id]
    );
    const charges = payRes.rows
      .map(r => ({ id: r.id, intentId: r.stripe_payment_intent_id, remaining: Number(r.remainingCents) }))
      .filter(c => c.remaining > 0);
    const refundableRemainder = charges.reduce((a, c) => a + c.remaining, 0);
    // Any target the Stripe-reachable charges can't cover (manual / legacy CC
    // payments) is surfaced, never silently clamped — the client email at
    // cancel time promised the full agreement amount.
    shortfallCents = Math.max(0, remainingTarget - refundableRemainder);
    remainingTarget = Math.min(remainingTarget, refundableRemainder);
    if (shortfallCents > 0) {
      Sentry.captureMessage('cancel/refund: agreement target exceeds Stripe-refundable remainder', {
        level: 'warning',
        tags: { route: 'proposals/cancel', step: 'refund_shortfall' },
        extra: { proposalId: proposalIdNum, shortfallCents, targetCents: math.refundCents, effectiveTargetCents, alreadyRefunded },
      });
    }

    if (remainingTarget > 0) {
      // Attribute the gratuity portion across charges, largest-first, until exhausted.
      let gratuityRemaining = Math.min(math.gratuityCents, remainingTarget);
      for (const c of charges) {
        if (remainingTarget <= 0) break;
        const amt = Math.min(remainingTarget, c.remaining);
        if (amt <= 0) continue;
        const gratuityForCharge = Math.min(gratuityRemaining, amt);
        // refundExecute uses its own pooled connections (pending row + reconcile
        // tx); the client held here carries ONLY the advisory lock, no row locks,
        // so those inner transactions can never wait on us.
        const { recon } = await refundExecute({
          stripe,
          proposalId: proposalIdNum,
          paymentId: c.id,
          paymentIntentId: c.intentId,
          amountCents: amt,
          reason: `Event cancellation refund (${mode === 'drb' ? 'Dr. Bartender' : 'client'})`,
          issuedBy: req.user.id,
          idempotencyKey: `cancel-refund-${req.params.id}-${c.id}-${idempotency_key}`,
          totalPriceBeforeDollars: Number(proposal.total_price),
          totalPriceAfterDollars: Number(proposal.total_price),
          gratuityCents: gratuityForCharge,
        });
        refundedCents += amt;
        remainingTarget -= amt;
        gratuityRemaining -= gratuityForCharge;
        if (recon?.applied) anyApplied = true;
        perCharge.push({ payment_id: c.id, amount_cents: amt, gratuity_cents: gratuityForCharge, applied: !!recon?.applied });
      }
    }

    await dbClient.query('COMMIT'); // releases the advisory lock
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }

  // Notification tail runs AFTER the client is released. One aggregate refund
  // notification (gated on any applied to avoid a duplicate with the
  // charge.refunded webhook backstop), now also honoring the dialog's
  // suppress checkbox.
  const notifications = [];
  if (anyApplied && refundedCents > 0 && !suppressClientEmail) {
    const r = await sendRefundClientNotification({ proposalId: req.params.id, amountCents: refundedCents, source: 'cancel_refund' });
    notifications.push({ type: 'refund_notice', sms: null, ...r });
  }

  res.json({ refunded_cents: refundedCents, already_refunded_cents: alreadyRefunded, shortfall_cents: shortfallCents, charges: perCharge, notifications });
}));

module.exports = router;
