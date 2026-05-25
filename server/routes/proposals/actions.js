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
const { linkPaymentToInvoice } = require('../../utils/invoiceHelpers');
const { getEventTypeLabel } = require('../../utils/eventTypes');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, ConflictError, NotFoundError, ExternalServiceError } = require('../../utils/errors');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('../../utils/urls');

const router = express.Router();

/** PATCH /api/proposals/:id/notes — update admin notes */
router.patch('/:id/notes', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const { admin_notes } = req.body;
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

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    await dbClient.query(
      'UPDATE proposals SET amount_paid = $1, status = $2 WHERE id = $3',
      [newAmountPaid, newStatus, proposal.id]
    );

    // Record in proposal_payments. Use the capped delta (newAmountPaid - currentPaid)
    // so an over-payment request doesn't inflate the ledger beyond the proposal total.
    await dbClient.query(
      `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
       VALUES ($1, $2, $3, 'succeeded')`,
      [proposal.id, isFullyPaid ? 'full' : 'deposit', Math.round((newAmountPaid - currentPaid) * 100)]
    );

    // Log activity
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details) VALUES ($1, $2, 'admin', $3, $4)`,
      [proposal.id, isFullyPaid ? 'paid_in_full' : 'deposit_paid', req.user.id,
        JSON.stringify({ amount: paymentAmount, method: method || 'manual', new_total_paid: newAmountPaid })]
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
        const payAmountCents = Math.round(paymentAmount * 100);
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
    const amountFormatted = paymentAmount.toFixed(2);
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

  res.json({ success: true, status: newStatus, amount_paid: newAmountPaid });
}));

module.exports = router;
