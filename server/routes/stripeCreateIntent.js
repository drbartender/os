'use strict';
/**
 * POST /api/stripe/create-intent/:token — extracted from stripe.js (gratuity
 * split) so the gratuity computation doesn't grow the over-cap stripe.js.
 * Mounted by stripe.js via router.use(require('./stripeCreateIntent')).
 *
 * Election-at-payment (spec 2026-08-03): this route computes the client's
 * tip-jar election IN MEMORY and stamps it into PaymentIntent metadata. It
 * writes NO gratuity to the proposal — the payment_intent.succeeded webhook
 * applies the election when the money actually lands.
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
           p.pricing_snapshot,
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

  // Election-at-payment (spec 2026-08-03): compute the gratuity IN MEMORY only.
  // Nothing is written to the proposal here; the election rides the
  // PaymentIntent metadata and is applied by the webhook when payment succeeds.
  // An abandoned checkout leaves the proposal untouched — no Gratuity line can
  // ever appear on an unpaid quote.
  //
  // NAMED REMOVAL: the old persist transaction's under-lock ALREADY_PAID re-check
  // went with the write. Bounded (spec §3): this route no longer writes anything,
  // so a proposal paid mid-request can at worst mint a fresh chargeable intent,
  // and the webhook's additive credit records whatever is actually charged — the
  // same exposure the metadata-less path already has.
  let effSnap = proposal.pricing_snapshot || {};
  let election = null; // { tipJar, rate } when the client sent one this request
  if (gratuityProvided) {
    const { staffCount, hours } = gratuityBasisFromSnapshot(effSnap, proposal.event_duration_hours);
    // Can't skip the jar with no crew/hours — force it on (mirrors the old path).
    const effTipJar = (staffCount * hours) <= 0 ? true : (tip_jar !== false);
    const g = deriveGratuityRate({
      enteredTotal: gratuity_total !== undefined ? gratuity_total : 0,
      staffCount, hours, tipJar: effTipJar,
    });
    if (!g.ok) throw new ValidationError({ gratuity: g.message });
    effSnap = recomputeSnapshotGratuity(effSnap, {
      gratuityRate: g.rate, tipJar: effTipJar,
      staffNoun: effSnap.staff_noun, durationHours: proposal.event_duration_hours,
    });
    election = { tipJar: effTipJar, rate: g.rate };
  }
  const effTotal = gratuityProvided ? effSnap.total : Number(proposal.total_price);

  const isFullPay = payment_option === 'full';
  const wantsAutopay = !isFullPay && autopay === true;
  const amount = isFullPay
    ? Math.round(Number(effTotal) * 100)   // the ONE dollars->cents seam in this flow
    : DEPOSIT_AMOUNT;

  // Intent identity = (amount, election metadata). A deposit is $100 regardless
  // of election, so amount alone can no longer identify an intent (spec §3).
  //
  // ACCEPTED HOLE (deliberate, do not "fix"): when the request carries an
  // election and a pending intent exists with the SAME amount and the SAME
  // metadata, the intent is neither reused nor cancelled — a second identical
  // intent is minted alongside it. Harmless (both charge the same amount and
  // carry the same election) and it matches today's behavior.
  const reqMeta = election
    ? { tip_jar: String(election.tipJar), gratuity_rate: String(election.rate) }
    : null;
  const existing = await pool.query(
    "SELECT stripe_payment_intent_id, amount FROM stripe_sessions WHERE proposal_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [proposal.id]
  );
  if (existing.rows[0]) {
    try {
      const intent = await stripe.paymentIntents.retrieve(existing.rows[0].stripe_payment_intent_id);
      const intentMeta = (intent.metadata && intent.metadata.tip_jar !== undefined)
        ? { tip_jar: intent.metadata.tip_jar, gratuity_rate: intent.metadata.gratuity_rate }
        : null;
      const amountMatch = existing.rows[0].amount === amount;
      const metaMatch = (reqMeta === null && intentMeta === null)
        || (reqMeta !== null && intentMeta !== null
            && reqMeta.tip_jar === intentMeta.tip_jar
            && reqMeta.gratuity_rate === intentMeta.gratuity_rate);
      // Reuse ONLY a metadata-less intent for a metadata-less request: an
      // election-bearing intent is never reused (a reload resets the client's
      // UI state; confirming a stale election the client can no longer see is
      // exactly the harm this redesign removes).
      if (amountMatch && reqMeta === null && intentMeta === null
          && (intent.status === 'requires_payment_method' || intent.status === 'requires_confirmation')) {
        return res.json({
          clientSecret: intent.client_secret,
          total_price: effTotal,
          gratuity: (effSnap && effSnap.gratuity) || null,
        });
      }
      // Stale-intent safety: cancel when the identity (amount OR election)
      // no longer matches, so a stale tab can't confirm an old total/election.
      // Only when still cancelable — if the client already confirmed it in
      // another tab (succeeded/processing), leave it for the webhook to
      // reconcile; the additive amount_paid credit records what was charged.
      if ((!amountMatch || !metaMatch)
          && !['succeeded', 'processing', 'canceled'].includes(intent.status)) {
        await stripe.paymentIntents.cancel(intent.id);
        await pool.query(
          "UPDATE stripe_sessions SET status = 'canceled' WHERE stripe_payment_intent_id = $1",
          [intent.id]
        );
      }
    } catch (e) {
      // Intent gone/unretrievable, OR the cancel itself failed. Either way we
      // fall through and mint a fresh intent — but a FAILED CANCEL leaves a
      // chargeable stale intent alive out at Stripe, which is worth knowing
      // about, so never swallow it silently.
      console.warn(
        `create-intent: could not retrieve/cancel pending intent ${existing.rows[0].stripe_payment_intent_id} `
        + `for proposal ${proposal.id} (minting fresh): ${e && e.message}`
      );
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
      // Election metadata rides ONLY when the client sent one this request.
      // Its absence is the webhook's "do not touch the gratuity" signal.
      ...(reqMeta || {}),
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

  // Built from the IN-MEMORY values so the client's "new total" display keeps
  // working untouched even though nothing was persisted.
  res.json({
    clientSecret: paymentIntent.client_secret,
    total_price: effTotal,
    gratuity: (effSnap && effSnap.gratuity) || null,
  });
}));

module.exports = router;
