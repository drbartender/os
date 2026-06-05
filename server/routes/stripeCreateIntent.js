'use strict';
/**
 * POST /api/stripe/create-intent/:token — extracted from stripe.js (gratuity
 * split) so the gratuity persist/recompute logic doesn't grow the over-cap
 * stripe.js. Mounted by stripe.js via router.use(require('./stripeCreateIntent')).
 */
const express = require('express');
const { pool } = require('../db');
const { publicLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, NotFoundError, ConflictError, ExternalServiceError } = require('../utils/errors');
const { getStripe } = require('../utils/stripeClient');
const { getBookingWindow } = require('../utils/bookingWindow');
const { DEPOSIT_AMOUNT, eventLabelFor, getOrCreateCustomer } = require('../utils/stripeRouteHelpers');

const router = express.Router();

// ─── Public: create a Payment Intent for a proposal ──────────────

/** POST /api/stripe/create-intent/:token — public, token-gated */
router.post('/create-intent/:token', publicLimiter, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
  }

  const { payment_option = 'deposit', autopay = false } = req.body;

  const result = await pool.query(`
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.total_price,
           p.event_date, p.event_start_time,
           p.stripe_customer_id, p.deposit_amount,
           c.email AS client_email, c.name AS client_name
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.token = $1
  `, [req.params.token]);

  if (!result.rows[0]) throw new NotFoundError('This proposal is no longer available');

  const proposal = result.rows[0];
  if (['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status)) {
    throw new ConflictError('Payment has already been made for this proposal', 'ALREADY_PAID');
  }
  if (!['sent', 'viewed', 'accepted'].includes(proposal.status)) {
    throw new ConflictError('This proposal is not available for payment', 'NOT_PAYABLE');
  }

  // Last-minute booking gate: inside 14 days, full payment is the ONLY option.
  // Reject a deposit attempt outright — NEVER silently upgrade the charge (the
  // client expects a $100 deposit; charging the full total without consent is a
  // money-integrity violation). The UI already hides the deposit tablet inside
  // this window; this is the server-side backstop against a stale client or a
  // direct API hit. Full payment naturally drives status='balance_paid', which
  // the autopay scheduler never claims — so this also sidesteps the past-due
  // balance problem without touching the charge path or balance_due_date.
  const bookingWindow = getBookingWindow({
    eventDate: proposal.event_date,
    eventStartTime: proposal.event_start_time,
  });
  if (bookingWindow.fullPaymentRequired && payment_option !== 'full') {
    throw new ConflictError(
      'This event is within 2 weeks — full payment is required to book.',
      'FULL_PAYMENT_REQUIRED'
    );
  }

  const isFullPay = payment_option === 'full';
  const wantsAutopay = !isFullPay && autopay === true;
  const amount = isFullPay
    ? Math.round(Number(proposal.total_price) * 100)
    : DEPOSIT_AMOUNT;

  // Reuse existing pending intent if amount matches
  const existing = await pool.query(
    "SELECT stripe_payment_intent_id, amount FROM stripe_sessions WHERE proposal_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [proposal.id]
  );
  if (existing.rows[0] && existing.rows[0].amount === amount) {
    try {
      const intent = await stripe.paymentIntents.retrieve(existing.rows[0].stripe_payment_intent_id);
      if (intent.status === 'requires_payment_method' || intent.status === 'requires_confirmation') {
        return res.json({ clientSecret: intent.client_secret });
      }
    } catch (e) {
      // Intent no longer valid, create a new one
    }
  }

  // Create or retrieve Stripe Customer (needed for autopay card saving)
  const customerId = await getOrCreateCustomer(proposal);

  const intentParams = {
    amount,
    currency: 'usd',
    customer: customerId,
    description: isFullPay
      ? `Full Payment — ${eventLabelFor(proposal)}`
      : `Event Deposit — ${eventLabelFor(proposal)}`,
    receipt_email: proposal.client_email || undefined,
    metadata: {
      proposal_id: String(proposal.id),
      payment_type: isFullPay ? 'full' : 'deposit',
    },
  };

  // Save payment method for future off-session charges (autopay)
  if (wantsAutopay) {
    intentParams.setup_future_usage = 'off_session';
  }

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create(intentParams);
  } catch (err) {
    console.error('Stripe create-intent error:', err);
    throw new ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.');
  }

  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
    [proposal.id, paymentIntent.id, amount]
  );

  // Update proposal with payment preferences and default balance_due_date
  await pool.query(`
    UPDATE proposals
    SET payment_type = $1,
        autopay_enrolled = $2,
        balance_due_date = COALESCE(balance_due_date, event_date - INTERVAL '14 days')
    WHERE id = $3
  `, [isFullPay ? 'full' : 'deposit', wantsAutopay, proposal.id]);

  res.json({ clientSecret: paymentIntent.client_secret });
}));

module.exports = router;
