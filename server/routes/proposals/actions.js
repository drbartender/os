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
const { commitGroupChoice } = require('../../utils/proposalGroupCommit');
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

  const result = await pool.query(
    'SELECT id, total_price, amount_paid, deposit_amount, status FROM proposals WHERE id = $1',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  const proposal = result.rows[0];
  if (['balance_paid', 'confirmed'].includes(proposal.status)) {
    throw new ConflictError('Proposal is already fully paid.', 'ALREADY_PAID_IN_FULL');
  }

  const totalPrice = Number(proposal.total_price);
  const currentPaid = Number(proposal.amount_paid || 0);
  const paymentAmount = paid_in_full ? totalPrice - currentPaid : Number(amount);

  if (!paymentAmount || paymentAmount <= 0) {
    throw new ValidationError({ amount: 'Enter a valid payment amount' });
  }

  const newAmountPaid = Math.min(currentPaid + paymentAmount, totalPrice);
  const isFullyPaid = newAmountPaid >= totalPrice;
  const newStatus = isFullyPaid ? 'balance_paid' : 'deposit_paid';
  // The capped delta actually applied to EVERY consumer — proposal ledger,
  // invoice, activity log, and the client/admin receipt email — never the raw
  // admin-supplied amount, so an over-payment reports the $Y applied, not $X entered.
  const appliedAmount = newAmountPaid - currentPaid;

  let groupChoice = { committed: false, conflict: false, archivedLoserIds: [] };
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    // Option-group choice-commit — first-writer-wins marks this option chosen +
    // archives losers in THIS tx. A conflict (recording a payment on an option the
    // client did not book) aborts the whole handler with a 409 (nothing was captured).
    groupChoice = await commitGroupChoice(proposal.id, dbClient);
    if (groupChoice.conflict) {
      throw new ConflictError('This option was not the one the client booked; it cannot take a payment.', 'OPTION_NOT_CHOSEN');
    }

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

    // Record in proposal_payments. Use the capped delta (newAmountPaid - currentPaid)
    // so an over-payment request doesn't inflate the ledger beyond the proposal total.
    await dbClient.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
       VALUES ($1, $2, $3, 'succeeded')`,
      [proposal.id, isFullyPaid ? 'full' : 'deposit', Math.round((newAmountPaid - currentPaid) * 100)]
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
  for (const loserId of groupChoice.archivedLoserIds) {
    try {
      await cancelMarketingForProposal(loserId);
      await cancelPendingChangeRequestsForProposal(loserId);
    } catch (reapErr) {
      if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(reapErr, { tags: { route: 'proposals/payment', reap: 'option_loser' } });
    }
  }

  res.json({ success: true, status: newStatus, amount_paid: newAmountPaid });
}));

module.exports = router;
