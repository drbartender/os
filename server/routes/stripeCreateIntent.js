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
const { AppError, NotFoundError, ConflictError, ExternalServiceError, ValidationError } = require('../utils/errors');
const { getStripe } = require('../utils/stripeClient');
const { getBookingWindow } = require('../utils/bookingWindow');
const { deriveGratuityRate, gratuityBasisFromSnapshot, recomputeSnapshotGratuity } = require('../utils/pricingEngine');
const { DEPOSIT_AMOUNT, eventLabelFor, getOrCreateCustomer } = require('../utils/stripeRouteHelpers');
const { requireUuidToken } = require('../utils/tokens');

const router = express.Router();

// ─── Public: create a Payment Intent for a proposal ──────────────

/** POST /api/stripe/create-intent/:token — public, token-gated */
router.post('/create-intent/:token', requireUuidToken('token', 'This proposal is no longer available'), publicLimiter, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
  }

  const { payment_option = 'deposit', autopay = false, tip_jar, gratuity_total } = req.body;
  const gratuityProvided = tip_jar !== undefined || gratuity_total !== undefined;

  const result = await pool.query(`
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.total_price,
           p.event_date, p.event_start_time, p.event_duration_hours,
           p.stripe_customer_id, p.deposit_amount,
           p.pricing_snapshot, p.gratuity_rate, p.tip_jar,
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

  // §6: persist the client's gratuity choice + recompute total_price in one
  // transaction so the PaymentIntent amount is built from the JUST-WRITTEN total
  // (removes the old TOCTOU). Skipped on the initial intent fetch (no gratuity in
  // body) — that path charges the already-stored total.
  //
  // No reconcileProposalPaymentStatus call here BY DESIGN: this route is gated to
  // status sent/viewed/accepted (the guards above), all of which have
  // amount_paid = 0, so a gratuity change can never make amount_paid > total_price.
  if (gratuityProvided) {
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      const lockRes = await dbClient.query(
        `SELECT status, pricing_snapshot, event_duration_hours, gratuity_rate, tip_jar, total_price
           FROM proposals WHERE id = $1 FOR UPDATE`,
        [proposal.id]
      );
      const row = lockRes.rows[0];
      // Re-check status UNDER the row lock: a webhook could have flipped the
      // proposal to paid between the unlocked status check above and this lock.
      // Never rewrite total_price on an already-paid proposal.
      if (!row || ['deposit_paid', 'balance_paid', 'confirmed'].includes(row.status)) {
        await dbClient.query('ROLLBACK');
        throw new ConflictError('Payment has already been made for this proposal', 'ALREADY_PAID');
      }
      const snap = row.pricing_snapshot || {};
      const { staffCount, hours } = gratuityBasisFromSnapshot(snap, row.event_duration_hours);
      // Can't skip the jar with no crew/hours — force it on so the DB CHECK passes.
      const effTipJar = (staffCount * hours) <= 0 ? true : (tip_jar !== false);
      const g = deriveGratuityRate({
        enteredTotal: gratuity_total !== undefined ? gratuity_total : 0,
        staffCount, hours, tipJar: effTipJar,
      });
      if (!g.ok) { await dbClient.query('ROLLBACK'); throw new ValidationError({ gratuity: g.message }); }
      const newSnap = recomputeSnapshotGratuity(snap, {
        gratuityRate: g.rate, tipJar: effTipJar,
        staffNoun: snap.staff_noun, durationHours: row.event_duration_hours,
      });
      await dbClient.query(
        `UPDATE proposals SET tip_jar = $1, gratuity_rate = $2,
                pricing_snapshot = $3, total_price = $4, updated_at = NOW()
           WHERE id = $5`,
        [effTipJar, g.rate, JSON.stringify(newSnap), newSnap.total, proposal.id]
      );
      await dbClient.query('COMMIT');
      proposal.total_price = newSnap.total;     // use the just-written total below
      proposal.pricing_snapshot = newSnap;
    } catch (e) {
      try { await dbClient.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
      throw e;
    } finally {
      dbClient.release();
    }
  }

  const isFullPay = payment_option === 'full';
  const wantsAutopay = !isFullPay && autopay === true;
  const amount = isFullPay
    ? Math.round(Number(proposal.total_price) * 100)
    : DEPOSIT_AMOUNT;

  // Reuse an existing pending intent only when the amount matches AND the client
  // did not just change the gratuity this request.
  const existing = await pool.query(
    "SELECT stripe_payment_intent_id, amount FROM stripe_sessions WHERE proposal_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [proposal.id]
  );
  if (existing.rows[0] && existing.rows[0].amount === amount && !gratuityProvided) {
    try {
      const intent = await stripe.paymentIntents.retrieve(existing.rows[0].stripe_payment_intent_id);
      if (intent.status === 'requires_payment_method' || intent.status === 'requires_confirmation') {
        return res.json({
          clientSecret: intent.client_secret,
          total_price: Number(proposal.total_price),
          gratuity: (proposal.pricing_snapshot && proposal.pricing_snapshot.gratuity) || null,
        });
      }
    } catch (e) {
      // Intent no longer valid, create a new one
    }
  }
  // Stale-intent safety (§6): a prior pending intent whose amount no longer
  // matches must be cancelled so a stale browser tab can't confirm the old total.
  if (existing.rows[0] && existing.rows[0].amount !== amount) {
    const oldIntentId = existing.rows[0].stripe_payment_intent_id;
    try {
      const oldIntent = await stripe.paymentIntents.retrieve(oldIntentId);
      // Only cancel + mark canceled when the old intent is still cancelable. If
      // the client already confirmed it in another tab (succeeded/processing),
      // leave it for the webhook to reconcile — the additive amount_paid credit
      // records what was actually charged, so a stale confirm can't desync.
      if (!['succeeded', 'processing', 'canceled'].includes(oldIntent.status)) {
        await stripe.paymentIntents.cancel(oldIntentId);
        await pool.query(
          "UPDATE stripe_sessions SET status = 'canceled' WHERE stripe_payment_intent_id = $1",
          [oldIntentId]
        );
      }
    } catch (e) { /* intent gone/unretrievable — nothing to cancel */ }
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

  res.json({
    clientSecret: paymentIntent.client_secret,
    total_price: Number(proposal.total_price),
    gratuity: (proposal.pricing_snapshot && proposal.pricing_snapshot.gratuity) || null,
  });
}));

module.exports = router;
