// Per-proposal admin actions: notes, create-shift, balance-due-date,
// send-reminder, record-payment. Carved out of crud.js to keep that file
// under the file-size cap. These routes own sub-paths under /:id and never
// collide with the core CRUD verbs (which match only the bare /:id segment),
// so mount order with crud.js does not matter.

const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { createEventShifts } = require('../../utils/eventCreation');
const { sendEmail } = require('../../utils/email');
const emailTemplates = require('../../utils/emailTemplates');
const { notifyAdminCategory } = require('../../utils/adminNotifications');
const { linkPaymentToInvoice, createInvoiceOnSend } = require('../../utils/invoiceHelpers');
const { commitGroupChoice, sweepClientAlternatives } = require('../../utils/proposalGroupCommit');
const { voidUnpaidProposalInvoice, cancelOpenInvoiceIntents } = require('../../utils/invoiceVoid');
const { reapShiftsForProposal } = require('../../utils/shiftReap');
const { notifyStaffOfCancellation } = require('../../utils/staffShiftHandlers');
const { cancelMarketingForProposal } = require('../../utils/marketingHandlers');
const { cancelPendingChangeRequestsForProposal } = require('../../utils/changeRequests');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, ExternalServiceError } = require('../../utils/errors');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('../../utils/urls');

const router = express.Router();

/** PATCH /api/proposals/:id/notes — update admin notes */
router.patch('/:id/notes', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { admin_notes } = req.body;
  // Length-cap (audit 6): admin_notes is a free-form TEXT field; bound it so a
  // pathological payload can't bloat the row. 10k chars is far above any real note.
  if (typeof admin_notes === 'string' && admin_notes.length > 10000) {
    throw new ValidationError({ admin_notes: 'Admin notes must be 10,000 characters or fewer' });
  }
  const result = await pool.query(
    'UPDATE proposals SET admin_notes = $1 WHERE id = $2 RETURNING id, admin_notes',
    [admin_notes || '', req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');
  res.json(result.rows[0]);
}));

/** POST /api/proposals/:id/create-shift — manually create event shift from a proposal */
router.post('/:id/create-shift', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const proposal = await pool.query('SELECT id, status FROM proposals WHERE id = $1', [req.params.id]);
  if (!proposal.rows[0]) throw new NotFoundError('Proposal not found');
  if (!['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.rows[0].status)) {
    throw new ConflictError('Proposal must have deposit paid before creating a shift.', 'DEPOSIT_REQUIRED');
  }
  const shift = await createEventShifts(req.params.id);
  if (!shift) throw new ConflictError('Shift already exists for this proposal.', 'SHIFT_EXISTS');
  res.status(201).json(shift);
}));

/** PATCH /api/proposals/:id/balance-due-date — override balance due date */
router.patch('/:id/balance-due-date', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { balance_due_date } = req.body;
  if (!balance_due_date) {
    throw new ValidationError({ balance_due_date: 'Balance due date is required' });
  }
  // ISO/calendar-date guard (audit 6): balance_due_date lands in a DATE column.
  // Without this, garbage ("tomorrow", "13/45/26") or an impossible-but-parseable
  // date ("2026-02-30") reaches Postgres and 500s with a 22007/22008 instead of a
  // clean 400. The round-trip (toISOString slice === input) rejects rolled-over
  // dates that the format regex alone would let through.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(balance_due_date)) {
    throw new ValidationError({ balance_due_date: 'Balance due date must be in YYYY-MM-DD format' });
  }
  const parsedDueDate = new Date(`${balance_due_date}T00:00:00Z`);
  if (Number.isNaN(parsedDueDate.getTime()) || parsedDueDate.toISOString().slice(0, 10) !== balance_due_date) {
    throw new ValidationError({ balance_due_date: 'Balance due date is not a valid calendar date' });
  }
  const result = await pool.query(
    'UPDATE proposals SET balance_due_date = $1 WHERE id = $2 RETURNING id, balance_due_date',
    [balance_due_date, req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, 'balance_due_date_changed', 'admin', $2, $3)`,
    [req.params.id, req.user.id, JSON.stringify({ balance_due_date })]
  );

  res.json(result.rows[0]);
}));

/** POST /api/proposals/:id/send-reminder — admin sends a balance reminder email to the client */
router.post('/:id/send-reminder', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const proposalId = req.params.id;
  const { rows } = await pool.query(`
    SELECT p.id, p.token, p.total_price, p.amount_paid, p.balance_due_date,
           p.event_type, p.event_type_custom,
           c.email AS client_email, c.name AS client_name
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1
  `, [proposalId]);

  if (!rows[0]) throw new NotFoundError('Proposal not found');
  const proposal = rows[0];

  if (!proposal.client_email) {
    throw new ValidationError({ client: 'Client has no email on file.' });
  }

  const total = Number(proposal.total_price || 0);
  const paid = Number(proposal.amount_paid || 0);
  const balanceDue = total - paid;
  if (balanceDue <= 0) {
    throw new ConflictError('Proposal has no outstanding balance.', 'NO_BALANCE_DUE');
  }

  const eventTypeLabel = getEventTypeLabel({
    event_type: proposal.event_type,
    event_type_custom: proposal.event_type_custom,
  });
  const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${proposal.token}`;
  const tpl = emailTemplates.paymentReminderClient({
    clientName: proposal.client_name,
    eventTypeLabel,
    balanceDue: balanceDue.toFixed(2),
    balanceDueDate: proposal.balance_due_date,
    proposalUrl,
  });

  try {
    await sendEmail({ to: proposal.client_email, ...tpl });
  } catch (emailErr) {
    Sentry.captureException(emailErr, { tags: { route: 'proposals/send-reminder' }, extra: { proposalId } });
    throw new ExternalServiceError('email', emailErr, 'Failed to send reminder email.');
  }

  // Activity log is best-effort — the email already went out, so a transient
  // INSERT failure must not surface as a 5xx to the admin (which would prompt
  // a retry and double-send the reminder).
  try {
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'reminder_sent', 'admin', $2, $3)`,
      [proposalId, req.user.id, JSON.stringify({ to: proposal.client_email, balance_due: balanceDue })]
    );
  } catch (logErr) {
    Sentry.captureException(logErr, {
      tags: { route: 'proposals/send-reminder', step: 'activity-log' },
      extra: { proposalId },
    });
  }

  res.json({ ok: true });
}));

/** POST /api/proposals/:id/record-payment — manually record an outside payment (cash, Venmo, etc.) */
router.post('/:id/record-payment', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { amount, paid_in_full, method } = req.body;

  // Fast-fail + lock-gating snapshot ONLY (non-transactional). The authoritative
  // money math is re-derived from a locked re-read INSIDE the tx below (M7), so a
  // concurrent duplicate submit can never act on a stale amount_paid. This read
  // still drives the 404 / already-paid / bad-amount fast fails and the
  // currentPaid === 0 gating of the client-lock hoist + same-client sweep (both
  // safe on a slightly stale value: locking the client is harmless and a redundant
  // sweep is a no-op).
  const result = await pool.query(
    'SELECT id, total_price, amount_paid, deposit_amount, status FROM proposals WHERE id = $1',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  const proposal = result.rows[0];
  // A manual payment may only land on a proposal that is still collecting money.
  // 'balance_paid'/'confirmed' are already fully paid; 'completed'/'archived' are
  // terminal — recording against them would wrongly downgrade status back to
  // deposit_paid/balance_paid (and re-open a closed booking). Reject all four.
  if (['balance_paid', 'confirmed', 'completed', 'archived'].includes(proposal.status)) {
    throw new ConflictError('Proposal is already fully paid.', 'ALREADY_PAID_IN_FULL');
  }

  const totalPrice = Number(proposal.total_price);
  const currentPaid = Number(proposal.amount_paid || 0);
  const paymentAmount = paid_in_full ? totalPrice - currentPaid : Number(amount);

  if (!paymentAmount || paymentAmount <= 0) {
    throw new ValidationError({ amount: 'Enter a valid payment amount' });
  }

  // Derived under the proposals row lock inside the tx (see the locked re-read
  // below), never from the stale snapshot above; declared here so the post-commit
  // receipt/response can read the values that were actually committed.
  let newAmountPaid, isFullyPaid, newStatus, appliedAmount;

  let groupChoice = { committed: false, conflict: false, archivedLoserIds: [] };
  let sweptAlternativeIds = [];
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // LOCK ORDER: on an initial payment (the only case that can archive other
    // proposals via commitGroupChoice/the sweep), take the client-row lock
    // FIRST so every archiver obeys clients -> proposal_groups -> proposals
    // and can never deadlock the admin archive endpoint or a concurrent settle.
    if (currentPaid === 0) {
      await dbClient.query(
        `SELECT c.id FROM clients c JOIN proposals p ON p.client_id = c.id
          WHERE p.id = $1 FOR UPDATE OF c`, [proposal.id]);
    }

    // Option-group choice-commit — first-writer-wins marks this option chosen +
    // archives losers in THIS tx. A conflict (recording a payment on an option the
    // client did not book) aborts the whole handler with a 409 (nothing was captured).
    groupChoice = await commitGroupChoice(proposal.id, dbClient);
    if (groupChoice.conflict) {
      throw new ConflictError('This option was not the one the client booked; it cannot take a payment.', 'OPTION_NOT_CHOSEN');
    }

    // Same-client sweep of ungrouped alternatives — only on the client's FIRST
    // recorded payment (currentPaid 0). A later installment must never sweep:
    // by then a new draft for the client's NEXT event is legitimate.
    if (currentPaid === 0) {
      const sweep = await sweepClientAlternatives(proposal.id, dbClient);
      sweptAlternativeIds = sweep.sweptIds;
    }

    // M7: authoritative money read UNDER the proposals row lock. The prior code
    // derived currentPaid/newAmountPaid/appliedAmount from the non-transactional
    // pre-tx read above and then wrote a blind absolute amount_paid, so two
    // concurrent duplicate submits (a double-click, or owner + VA) each read the
    // same stale value and each wrote it, self-correcting the proposal column but
    // leaving two payment rows + a double-linked invoice (ledger divergence).
    // Locking the row serializes them: the second submit blocks here until the
    // first commits, then derives its capped delta from the first's committed
    // amount_paid. Placed AFTER commitGroupChoice/the sweep so the winner-row lock
    // is taken with proposal_groups + the client already held (global lock order
    // clients -> proposal_groups -> proposals); locking the winner earlier would
    // invert against a concurrent same-group settle and could deadlock.
    const locked = await dbClient.query(
      'SELECT total_price, amount_paid, status FROM proposals WHERE id = $1 FOR UPDATE',
      [proposal.id]
    );
    if (!locked.rows[0]) throw new NotFoundError('Proposal not found');
    const lockedRow = locked.rows[0];
    // A concurrent settle can have fully paid the proposal since the pre-tx read;
    // re-apply the fully-paid guard under the lock so a duplicate rejects with
    // ALREADY_PAID_IN_FULL (the existing response shape) instead of recording a
    // zero-applied payment.
    if (['balance_paid', 'confirmed', 'completed', 'archived'].includes(lockedRow.status)) {
      throw new ConflictError('Proposal is already fully paid.', 'ALREADY_PAID_IN_FULL');
    }
    const lockedTotal = Number(lockedRow.total_price);
    const lockedCurrentPaid = Number(lockedRow.amount_paid || 0);
    const lockedPaymentAmount = paid_in_full ? lockedTotal - lockedCurrentPaid : Number(amount);
    if (!lockedPaymentAmount || lockedPaymentAmount <= 0) {
      throw new ValidationError({ amount: 'Enter a valid payment amount' });
    }
    // Same Math.min cap semantics as before, now computed from the locked values.
    newAmountPaid = Math.min(lockedCurrentPaid + lockedPaymentAmount, lockedTotal);
    isFullyPaid = newAmountPaid >= lockedTotal;
    newStatus = isFullyPaid ? 'balance_paid' : 'deposit_paid';
    // The capped delta actually applied to EVERY consumer (proposal ledger,
    // invoice, activity log, and the client/admin receipt email), never the raw
    // admin-supplied amount, so an over-payment reports the $Y applied, not $X entered.
    appliedAmount = newAmountPaid - lockedCurrentPaid;

    // accepted_at: an admin-recorded outside payment is an acceptance source
    // (the client paid), so stamp it — otherwise the financial dashboard
    // (metricsQueries filters accepted_at IS NOT NULL) never counts these
    // bookings. COALESCE so re-recording a payment never moves the original.
    await dbClient.query(
      'UPDATE proposals SET amount_paid = $1, status = $2, accepted_at = COALESCE(accepted_at, NOW()) WHERE id = $3',
      [newAmountPaid, newStatus, proposal.id]
    );

    // Grouped winner: its invoice was deferred at send. Stamp payment_type + create
    // the Deposit/Full invoice now so the link step below finds it (webhook parity).
    if (groupChoice.committed) {
      await dbClient.query('UPDATE proposals SET payment_type = $1 WHERE id = $2', [isFullyPaid ? 'full' : 'deposit', proposal.id]);
      await createInvoiceOnSend(proposal.id, dbClient);
    }

    // Record in proposal_payments. Use the capped applied delta (appliedAmount,
    // derived from the locked read) so an over-payment request doesn't inflate the
    // ledger beyond the proposal total, and a concurrent duplicate records only the
    // delta on top of the first submit's committed amount_paid.
    await dbClient.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
       VALUES ($1, $2, $3, 'succeeded')`,
      [proposal.id, isFullyPaid ? 'full' : 'deposit', Math.round(appliedAmount * 100)]
    );

    // Log activity with the capped applied amount (appliedAmount, hoisted above),
    // not the raw admin-supplied paymentAmount, so an over-payment entry does not
    // show "$X paid" when only $Y was actually applied.
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, $2, 'admin', $3, $4)`,
      [proposal.id, isFullyPaid ? 'paid_in_full' : 'deposit_paid', req.user.id,
        JSON.stringify({ amount: appliedAmount, method: method || 'manual', new_total_paid: newAmountPaid })]
    );

    // Link payment to the oldest open invoice
    const openInvoice = await dbClient.query(
      "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
      [proposal.id]
    );
    if (openInvoice.rows[0]) {
      const paymentRow = await dbClient.query(
        'SELECT id FROM proposal_payments WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 1',
        [proposal.id]
      );
      if (paymentRow.rows[0]) {
        // Use the capped applied delta (appliedAmount), never the raw admin-supplied
        // paymentAmount — otherwise an over-payment inflates invoices.amount_paid past
        // amount_due, wrongly flips the invoice to 'paid', and locks it, diverging the
        // invoice ledger from the (correctly capped) proposal ledger.
        const payAmountCents = Math.round(appliedAmount * 100);
        await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRow.rows[0].id, payAmountCents, dbClient);
      }
    }

    await dbClient.query('COMMIT');
  } catch (txErr) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    dbClient.release();
  }

  // Email notifications for payment (non-blocking)
  try {
    const payData = await pool.query(`
      SELECT p.event_type, p.event_type_custom, c.name AS client_name, c.email AS client_email
      FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1
    `, [proposal.id]);
    const pd = payData.rows[0];
    const amountFormatted = appliedAmount.toFixed(2);
    const payType = isFullyPaid ? 'full payment' : 'deposit';
    const eventTypeLabel = getEventTypeLabel({ event_type: pd?.event_type, event_type_custom: pd?.event_type_custom });

    if (pd?.client_email) {
      const tpl = emailTemplates.paymentReceivedClient({ clientName: pd.client_name, eventTypeLabel, amount: amountFormatted, paymentType: payType });
      await sendEmail({ to: pd.client_email, ...tpl });
    }
    const tpl2 = emailTemplates.paymentReceivedAdmin({ clientName: pd?.client_name, eventTypeLabel, amount: amountFormatted, paymentType: payType, proposalId: proposal.id, adminUrl: `${ADMIN_URL}/proposals/${proposal.id}` });
    await notifyAdminCategory({ category: 'routine_finance', subject: tpl2.subject, emailHtml: tpl2.html, emailText: tpl2.text });
  } catch (emailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(emailErr, { tags: { route: 'proposals/payment', issue: 'email' } });
    }
    console.error('Payment email failed (non-blocking):', emailErr);
  }

  // Plan 2d: an admin-recorded outside payment moves the proposal to a paid
  // state, so schedule the long-lead marketing touches and suppress the
  // now-moot drip, same as a Stripe sign+pay.
  try {
    const { onProposalSignedAndPaid } = require('../../utils/marketingHandlers');
    await onProposalSignedAndPaid(proposal.id);
  } catch (marketingErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(marketingErr, { tags: { route: 'proposals/payment', issue: 'marketing-signpay' } });
    }
    console.error('Marketing enroll on record-payment failed (non-blocking):', marketingErr);
  }

  // Auto-create event shift
  try {
    const shift = await createEventShifts(proposal.id);
    if (shift) console.log(`Shift #${shift.id} created for proposal ${proposal.id} (manual payment)`);
  } catch (shiftErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(shiftErr, { tags: { route: 'proposals/payment', issue: 'shift-auto-create' } });
    }
    console.error('Shift auto-creation failed (non-blocking):', shiftErr);
  }

  // Best-effort reaps for archived losing options (marketing + change-request cancels).
  for (const loserId of [...groupChoice.archivedLoserIds, ...sweptAlternativeIds]) {
    try {
      await cancelMarketingForProposal(loserId);
      await cancelPendingChangeRequestsForProposal(loserId);
    } catch (reapErr) {
      if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(reapErr, { tags: { route: 'proposals/payment', reap: 'option_loser' } });
    }
  }

  res.json({ success: true, status: newStatus, amount_paid: newAmountPaid });
}));

// Statuses an admin may archive from; mirrors the lifecycle state machine's
// ->archived transitions exactly (paid/completed proposals never archive here).
const ARCHIVABLE_STATUSES = ['draft', 'sent', 'viewed', 'modified', 'accepted'];

// Reasons an admin may pick for a MANUAL archive — a semantic subset of the
// archive_reason DB CHECK. 'event_completed' and 'option_not_chosen' are
// deliberately excluded (they are auto/derived-path-only markers), so this route
// can never mislabel an abandoned or cancelled lead; the DB CHECK is the backstop.
const ARCHIVE_REASONS = ['no_hire', 'client_cancelled', 'we_cancelled', 'other'];

/** POST /api/proposals/:id/archive — archive this proposal, or (scope 'set') this
 *  plus every other open, unpaid proposal for the same client (covers formal
 *  option groups and loose multi-proposal sets with one rule). Archives in one
 *  transaction with unpaid-invoice voids; best-effort marketing/change-request
 *  reaps run post-commit, matching the ->archived lifecycle semantics. */
router.post('/:id/archive', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const scope = req.body?.scope === 'set' ? 'set' : 'one';
  // archive_reason: default 'no_hire' (never NULL), validated against the route
  // allowlist. The same admin reason applies to the whole scope 'set'.
  const archiveReason = req.body?.archive_reason ?? 'no_hire';
  if (!ARCHIVE_REASONS.includes(archiveReason)) {
    throw new ValidationError({ archive_reason: 'Invalid archive reason' });
  }

  let archivedIds = [];
  const voidedInvoicePairs = [];
  const reapedStaff = []; // [{ shiftId, userIds }] for the post-commit notify tail
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // LOCK ORDER (global hierarchy: clients -> proposal_groups -> proposals).
    // The client row is locked BEFORE any proposal row, matching the settle
    // paths (which hoist the same client lock ahead of commitGroupChoice/the
    // sweep). Locking the target proposal first inverted the order against a
    // concurrent settle and could deadlock AB-BA. The plain read below only
    // discovers client_id; the authoritative status check happens on the
    // re-read under the row lock.
    const { rows: [peek] } = await dbClient.query(
      'SELECT id, client_id FROM proposals WHERE id = $1', [req.params.id]);
    if (!peek) throw new NotFoundError('Proposal not found');
    if (peek.client_id !== null) {
      await dbClient.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [peek.client_id]);
    }

    const { rows: [target] } = await dbClient.query(
      'SELECT id, client_id, status FROM proposals WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!target) throw new NotFoundError('Proposal not found');
    if (!ARCHIVABLE_STATUSES.includes(target.status)) {
      throw new ConflictError('Only unpaid, unconverted proposals can be archived.', 'NOT_ARCHIVABLE');
    }

    let targetIds = [target.id];
    if (scope === 'set' && target.client_id !== null) {
      const { rows: siblings } = await dbClient.query(
        `SELECT id FROM proposals
          WHERE client_id = $1 AND id <> $2
            AND status = ANY($3) AND COALESCE(amount_paid, 0) = 0
          ORDER BY id
          FOR UPDATE`,
        [target.client_id, target.id, ARCHIVABLE_STATUSES]);
      targetIds = targetIds.concat(siblings.map((s) => s.id));
    }

    for (const pid of targetIds) {
      await dbClient.query(
        `UPDATE proposals SET status = 'archived', archive_reason = $2, updated_at = NOW() WHERE id = $1`,
        [pid, archiveReason]);
      const voidRes = await voidUnpaidProposalInvoice(pid, dbClient);
      for (const invId of voidRes.invoiceIds) voidedInvoicePairs.push({ proposalId: pid, invoiceId: invId });
      // Reap staffing exactly like the P6 cancel flow (shared helper) so a
      // fully-refunded-then-demoted booking doesn't leave its shift live on the
      // staff feed. No-op for the common unpaid-draft archive (no shifts).
      const reaped = await reapShiftsForProposal(pid, dbClient, 'proposal archived');
      for (const { shiftId, userIds } of reaped) {
        if (userIds.length) reapedStaff.push({ shiftId, userIds });
      }
      // Delete pending proposal-level comms, mirroring cancel.js exactly so the
      // two kill switches cannot drift.
      await dbClient.query(
        `DELETE FROM scheduled_messages
          WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
        [pid]);
      await dbClient.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
         VALUES ($1, 'archived', 'admin', $2, $3)`,
        [pid, req.user.id, JSON.stringify({ scope, archive_reason: archiveReason, via: 'archive_endpoint', batch_root: target.id })]);
    }
    archivedIds = targetIds;

    await dbClient.query('COMMIT');
  } catch (txErr) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw txErr;
  } finally {
    dbClient.release();
  }

  // Best-effort reaps, post-commit (a reap failure never rolls back the archive).
  for (const pid of archivedIds) {
    try {
      await cancelMarketingForProposal(pid);
      await cancelPendingChangeRequestsForProposal(pid);
    } catch (reapErr) {
      if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(reapErr, { tags: { route: 'proposals/archive', reap: 'admin_archive' } });
    }
  }
  // Post-commit, best-effort: cancel open checkout PaymentIntents for every
  // invoice this archive voided (seam-sweep M2); never throws, never blocks.
  for (const pair of voidedInvoicePairs) {
    await cancelOpenInvoiceIntents(pair.proposalId, pair.invoiceId);
  }

  // Notify approved staff of the reaped shifts (email only; SMS costs). Post-commit,
  // best-effort — notifyStaffOfCancellation takes its own connections, so it must
  // run after the tx client is released (one-connection rule).
  for (const { shiftId, userIds } of reapedStaff) {
    try {
      await notifyStaffOfCancellation({ shiftId, staffUserIds: userIds, kind: 'cancelled', sms: false, email: true });
    } catch (notifyErr) {
      Sentry.captureException(notifyErr, { tags: { route: 'proposals/archive', step: 'staff-notify' } });
    }
  }

  res.json({ archived_ids: archivedIds });
}));

module.exports = router;
