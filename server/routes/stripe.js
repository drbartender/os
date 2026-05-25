const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth, adminOnly, requireAdminOrManager } = require('../middleware/auth');
const { publicLimiter } = require('../middleware/rateLimiters');
const { createEventShifts } = require('../utils/eventCreation');
const { getBookingWindow } = require('../utils/bookingWindow');
const { notifyLastMinuteBooking } = require('../utils/lastMinuteAlert');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { notifyAdminCategory } = require('../utils/adminNotifications');
const { calculateSyrupCost } = require('../utils/pricingEngine');
const { createBalanceInvoice, linkPaymentToInvoice, createDrinkPlanExtrasInvoice, findOpenInvoiceForBalance } = require('../utils/invoiceHelpers');
const { getEventTypeLabel } = require('../utils/eventTypes');
const { renderEventIcs } = require('../utils/icsCalendar');
const { buildOrientationPayload } = require('../utils/orientationData');
const { shouldSendImmediate } = require('../utils/messageSuppression');
const { notifyClientPaymentFailed } = require('../utils/paymentFailedClientNotify');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, ValidationError, ConflictError, NotFoundError, ExternalServiceError, PaymentError } = require('../utils/errors');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('../utils/urls');
const { matchTipToEvent } = require('../utils/payrollTips');
const { clawbackTipByPaymentIntent } = require('../utils/payrollClawback');

const router = express.Router();

function eventLabelFor(row) {
  return getEventTypeLabel({ event_type: row?.event_type, event_type_custom: row?.event_type_custom });
}

const {
  getStripe,
  getPublishableKey,
  getLiveClient,
  getTestClient,
} = require('../utils/stripeClient');

const DEPOSIT_AMOUNT = parseInt(process.env.STRIPE_DEPOSIT_AMOUNT, 10) || 10000; // $100.00

/** GET /api/stripe/publishable-key — returns the active publishable key */
router.get('/publishable-key', (_req, res) => {
  res.json({ key: getPublishableKey() || null });
});

// ─── Helper: get or create Stripe Customer for a proposal ────────

async function getOrCreateCustomer(proposal) {
  const stripe = getStripe();
  // Validate the cached id against the active Stripe mode (live vs test).
  // STRIPE_TEST_MODE_UNTIL toggles modes; a customer from one mode is not
  // retrievable from the other. Verify before reuse.
  if (proposal.stripe_customer_id) {
    try {
      const existing = await stripe.customers.retrieve(proposal.stripe_customer_id);
      if (existing && !existing.deleted) return proposal.stripe_customer_id;
    } catch (err) {
      // resource_missing → safe to create new. Anything else (transient API
      // failure) → re-throw so we don't overwrite a valid id with a fresh
      // customer and break a future off-session autopay charge.
      if (err && err.code === 'resource_missing') {
        // Self-healing during STRIPE_TEST_MODE_UNTIL cutovers.
        console.warn(`[Stripe] Cached customer ${proposal.stripe_customer_id} not retrievable in current mode for proposal ${proposal.id}; creating new`);
      } else { throw err; }
    }
  }
  const customer = await stripe.customers.create({
    email: proposal.client_email || undefined,
    name: proposal.client_name || undefined,
    metadata: { proposal_id: String(proposal.id) },
  });
  try {
    await pool.query(
      'UPDATE proposals SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, proposal.id]
    );
  } catch (dbErr) {
    console.error(`Failed to save Stripe customer ${customer.id} to proposal ${proposal.id} (non-fatal):`, dbErr);
  }
  return customer.id;
}

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

// ─── Public: create a Payment Intent for drink plan extras ──────

/** POST /api/stripe/create-drink-plan-intent/:token — public, token-gated (drink plan token) */
router.post('/create-drink-plan-intent/:token', publicLimiter, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
  }

  const { selections, paymentChoice: rawChoice } = req.body;
  if (!selections) throw new ValidationError({ selections: 'Selections required' });
  const paymentChoice = rawChoice === 'with_balance' ? 'with_balance' : 'extras_only';

  const planRes = await pool.query(`
    SELECT dp.id AS plan_id, dp.token AS plan_token, dp.status AS plan_status,
           p.id AS proposal_id, p.total_price, p.amount_paid, p.event_date,
           p.balance_due_date, p.guest_count, p.num_bars, p.stripe_customer_id,
           p.event_type, p.event_type_custom, p.pricing_snapshot,
           c.email AS client_email, c.name AS client_name
    FROM drink_plans dp
    JOIN proposals p ON p.id = dp.proposal_id
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE dp.token = $1
  `, [req.params.token]);

  if (!planRes.rows[0]) throw new NotFoundError('This drink plan link is no longer valid');
  const data = planRes.rows[0];

  if (!data.proposal_id) throw new ConflictError('No linked proposal for this plan');

  const addOns = selections.addOns || {};
  const addonSlugs = Object.keys(addOns).filter(slug => addOns[slug]?.enabled);
  const addBarRental = selections.logistics?.addBarRental === true;

  let addonTotal = 0;
  if (addonSlugs.length > 0) {
    const addonRes = await pool.query(
      'SELECT slug, rate, billing_type FROM service_addons WHERE slug = ANY($1) AND is_active = true',
      [addonSlugs]
    );
    for (const addon of addonRes.rows) {
      const rate = Number(addon.rate);
      if (addon.billing_type === 'per_guest') {
        addonTotal += rate * (data.guest_count || 1);
      } else {
        addonTotal += rate;
      }
    }
  }

  let barRentalCost = 0;
  if (addBarRental) {
    const snapshot = data.pricing_snapshot || {};
    const barRental = snapshot.bar_rental || {};
    if ((data.num_bars || 0) >= 1) {
      barRentalCost = barRental.additional_bar_fee || 100;
    } else {
      barRentalCost = barRental.first_bar_fee || 50;
    }
  }

  const rawSyrups = selections.syrupSelections || {};
  const allSyrupIds = Array.isArray(rawSyrups)
    ? rawSyrups
    : [...new Set(Object.values(rawSyrups).flat())];
  const selfProvided = selections.syrupSelfProvided || [];
  const proposalSyrups = data.pricing_snapshot?.syrups?.selections || [];
  const newSyrupIds = allSyrupIds
    .filter(id => !selfProvided.includes(id))
    .filter(id => !proposalSyrups.includes(id));
  const syrupCost = calculateSyrupCost(newSyrupIds, data.guest_count);

  const extrasAmount = addonTotal + barRentalCost + syrupCost.total;

  const now = new Date();
  let balanceDueDate = data.balance_due_date;
  if (!balanceDueDate && data.event_date) {
    const d = new Date(data.event_date);
    d.setUTCDate(d.getUTCDate() - 14);
    balanceDueDate = d;
  }
  const isPastDue = balanceDueDate ? now > new Date(balanceDueDate) : false;
  const currentBalance = Math.max(0, Number(data.total_price || 0) - Number(data.amount_paid || 0));
  const balanceOptionAvailable = !isPastDue && currentBalance > 0 && extrasAmount > 0;

  if (extrasAmount <= 0 && !(isPastDue && currentBalance > 0)) {
    return res.json({ noPaymentNeeded: true, extrasAmount: 0, balanceOptionAvailable: false });
  }

  let paymentScenario;
  let totalCharge;
  let pastDueAmount = 0;
  let balancePortion = 0;

  if (isPastDue && currentBalance > 0) {
    paymentScenario = 'extras_plus_balance';
    pastDueAmount = currentBalance;
    balancePortion = currentBalance;
    totalCharge = extrasAmount + currentBalance;
  } else if (isPastDue) {
    paymentScenario = 'extras_required';
    totalCharge = extrasAmount;
  } else if (paymentChoice === 'with_balance' && currentBalance > 0 && extrasAmount > 0) {
    paymentScenario = 'extras_optional';
    balancePortion = currentBalance;
    totalCharge = extrasAmount + currentBalance;
  } else {
    paymentScenario = 'extras_optional';
    totalCharge = extrasAmount;
  }

  const customerId = await getOrCreateCustomer({
    id: data.proposal_id,
    stripe_customer_id: data.stripe_customer_id,
    client_email: data.client_email,
    client_name: data.client_name,
  });

  const amountCents = Math.round(totalCharge * 100);
  const extrasCents = Math.round(extrasAmount * 100);
  const balanceCents = Math.round(balancePortion * 100);
  const paymentType = balancePortion > 0 ? 'drink_plan_with_balance' : 'drink_plan_extras';

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customerId,
      description: `Drink Plan Extras — ${eventLabelFor(data)}`,
      receipt_email: data.client_email || undefined,
      metadata: {
        proposal_id: String(data.proposal_id),
        drink_plan_id: String(data.plan_id),
        payment_type: paymentType,
        extras_amount_cents: String(extrasCents),
        balance_amount_cents: String(balanceCents),
      },
    });
  } catch (err) {
    console.error('Drink plan payment intent error:', err);
    throw new ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.');
  }

  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
    [data.proposal_id, paymentIntent.id, amountCents]
  );

  res.json({
    clientSecret: paymentIntent.client_secret,
    extrasAmount,
    pastDueAmount,
    totalCharge,
    paymentScenario,
    balanceOptionAvailable,
    currentBalance,
  });
}));

// ─── Admin: generate a reusable Stripe Payment Link ──────────────

/** POST /api/stripe/payment-link/:id — admin only */
router.post('/payment-link/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
  }

  const result = await pool.query(
    'SELECT id, token, event_type, event_type_custom FROM proposals WHERE id = $1',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  const proposal = result.rows[0];
  const eventLabel = eventLabelFor(proposal);

  // Idempotency: if a pending payment-link already exists for this proposal+amount, reuse it
  // instead of creating a second Stripe price+link. Avoids duplicate charges when the admin
  // clicks Generate twice.
  const existingLink = await pool.query(
    `SELECT stripe_payment_link_id FROM stripe_sessions
     WHERE proposal_id = $1 AND stripe_payment_link_id IS NOT NULL
       AND amount = $2 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [proposal.id, DEPOSIT_AMOUNT]
  );
  if (existingLink.rows[0]) {
    try {
      const existing = await stripe.paymentLinks.retrieve(existingLink.rows[0].stripe_payment_link_id);
      if (existing && existing.active) {
        return res.json({ url: existing.url });
      }
    } catch (_) { /* fall through and create a new link */ }
  }

  let price, paymentLink;
  try {
    // Create a one-time price
    price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: DEPOSIT_AMOUNT,
      product_data: { name: `Event Deposit — ${eventLabel}` },
    });

    paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { proposal_id: String(proposal.id) },
      after_completion: { type: 'redirect', redirect: { url: `${PUBLIC_SITE_URL}/proposal/${encodeURIComponent(proposal.token)}?paid=true` } },
    });
  } catch (err) {
    console.error('Stripe payment-link error:', err);
    throw new ExternalServiceError('Stripe', err, 'Payment link unavailable. Please try again.');
  }

  // Store link reference. The ON CONFLICT target must include the partial-index
  // WHERE predicate (Postgres requires this for inference against partial unique
  // indexes — see idx_stripe_sessions_payment_link at schema.sql:812).
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_link_id, amount, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (stripe_payment_link_id) WHERE stripe_payment_link_id IS NOT NULL DO NOTHING`,
    [proposal.id, paymentLink.id, DEPOSIT_AMOUNT]
  );

  res.json({ url: paymentLink.url });
}));

// ─── Admin: manually charge autopay balance ──────────────────────

/** POST /api/stripe/charge-balance/:id — admin only */
router.post('/charge-balance/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
  }

  // Atomic claim: same gate as the scheduler so a manual click can't race a
  // scheduler tick (or a double-click) and double-charge. Returns the proposal
  // row only if no charge is already in flight.
  const result = await pool.query(`
    UPDATE proposals
    SET autopay_status = 'in_progress', autopay_attempted_at = NOW()
    WHERE id = $1
      AND status = 'deposit_paid'
      AND stripe_customer_id IS NOT NULL
      AND stripe_payment_method_id IS NOT NULL
      AND (
        autopay_status IS NULL
        OR autopay_status = 'failed'
        OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '24 hours')
      )
    RETURNING id, total_price, amount_paid, stripe_customer_id, stripe_payment_method_id,
              autopay_enrolled, status, event_type, event_type_custom, balance_due_date
  `, [req.params.id]);

  if (!result.rows[0]) {
    // Distinguish "not found" from "already charging" with a follow-up read so
    // admins see why the click was rejected.
    const probe = await pool.query(
      `SELECT status, autopay_status, stripe_customer_id, stripe_payment_method_id FROM proposals WHERE id = $1`,
      [req.params.id]
    );
    if (!probe.rows[0]) throw new NotFoundError('Proposal not found');
    const p = probe.rows[0];
    if (p.status !== 'deposit_paid') {
      throw new ConflictError('Proposal must be in deposit_paid status to charge balance', 'INVALID_STATUS');
    }
    if (!p.stripe_customer_id || !p.stripe_payment_method_id) {
      throw new ConflictError('No saved payment method for this proposal', 'NO_PAYMENT_METHOD');
    }
    if (p.autopay_status === 'in_progress') {
      throw new ConflictError('A balance charge is already in progress for this proposal', 'CHARGE_IN_PROGRESS');
    }
    throw new ConflictError('Unable to charge balance', 'INVALID_STATUS');
  }

  const proposal = result.rows[0];

  const balanceCents = Math.round((Number(proposal.total_price) - Number(proposal.amount_paid)) * 100);
  if (balanceCents <= 0) {
    // Release the claim before bailing out so a real balance charge can run later.
    await pool.query(`UPDATE proposals SET autopay_status = NULL WHERE id = $1`, [proposal.id]);
    throw new ConflictError('No remaining balance to charge', 'NO_BALANCE');
  }

  // Stripe idempotency key shared with the scheduler — a manual click +
  // scheduler tick that race against the same balance return the SAME intent.
  const balanceDueIso = proposal.balance_due_date
    ? new Date(proposal.balance_due_date).toISOString().slice(0, 10)
    : 'no-date';
  const idempotencyKey = `autopay-balance-${proposal.id}-${balanceDueIso}`;

  let intent;
  try {
    intent = await stripe.paymentIntents.create({
      amount: balanceCents,
      currency: 'usd',
      customer: proposal.stripe_customer_id,
      payment_method: proposal.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      description: `Balance Payment — ${eventLabelFor(proposal)}`,
      metadata: {
        proposal_id: String(proposal.id),
        payment_type: 'balance',
      },
    }, { idempotencyKey });
  } catch (err) {
    // Release the claim so the admin can retry after fixing the card.
    await pool.query(`UPDATE proposals SET autopay_status = 'failed' WHERE id = $1`, [proposal.id]);
    console.error('Stripe charge-balance error:', err);
    // Preserve Stripe's specific decline message for card errors so admins
    // see the exact reason (e.g. "Your card has insufficient funds.").
    if (err.type === 'StripeCardError') {
      throw new PaymentError(`Card declined: ${err.message}`, 'CARD_DECLINED');
    }
    throw new ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.');
  }

  // Webhook will handle status update on success
  res.json({ status: intent.status, amount: balanceCents });
}));

// ─── Admin: refund history for a proposal ────────────────────────

/** GET /api/stripe/refunds/:id — admin/manager (read-only refund history) */
router.get('/refunds/:id', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  // Exclude 'pending': a transient/stranded pre-Stripe row must never render
  // in history as if a refund actually happened. Only resolved rows show.
  const { rows } = await pool.query(
    `SELECT id, amount, reason, total_price_before, total_price_after,
            stripe_refund_id, status, created_at
       FROM proposal_refunds
      WHERE proposal_id = $1 AND status <> 'pending'
      ORDER BY created_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

// ─── Admin: issue a partial refund ───────────────────────────────

/**
 * POST /api/stripe/refund/:id — admin ONLY (money OUT, stricter than the
 * money-IN charge-balance which allows managers). Body: { amount, reason,
 * idempotency_key }. All refund rejections throw AppError so the precise
 * planner message reaches the admin toast (ValidationError would bury it
 * in fieldErrors behind the generic "Please fix the errors below").
 */
router.post('/refund/:id', auth, adminOnly, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');

  const proposalId = req.params.id;
  const { amount, reason, idempotency_key } = req.body;
  const cleanReason = String(reason || '').trim();
  if (!cleanReason) throw new AppError('A refund reason is required.', 400, 'REASON_REQUIRED');
  if (!idempotency_key || typeof idempotency_key !== 'string') {
    throw new AppError('Missing idempotency key — reopen the refund form and retry.', 400, 'MISSING_IDEMPOTENCY_KEY');
  }

  const propRes = await pool.query(
    'SELECT id, total_price, amount_paid FROM proposals WHERE id = $1',
    [proposalId]
  );
  if (!propRes.rows[0]) throw new NotFoundError('Proposal not found');
  const proposal = propRes.rows[0];

  // Refundable charges: deposit/balance/full AND invoice. `invoice` is the
  // STANDARD balance path post the invoice-rollup fix (balance paid via the
  // public invoice page → payment_type='invoice' linked to a 'Balance'
  // invoice — exactly where a no-show-bartender refund lives). Excluding it
  // would defeat the headline use case. Whether total_price also drops is
  // decided downstream by the linked invoice LABEL (applyRefundReconciliation),
  // not here. Only the drink_plan_* rails are excluded. Stripe's own
  // per-charge refund cap is the final over-refund backstop on top of the
  // remainingCents math (which nets prior succeeded refunds per charge).
  const payRes = await pool.query(
    `SELECT pp.id,
            pp.stripe_payment_intent_id,
            pp.amount
              - COALESCE((SELECT SUM(pr.amount) FROM proposal_refunds pr
                           WHERE pr.payment_id = pp.id AND pr.status = 'succeeded'), 0)
              AS "remainingCents"
       FROM proposal_payments pp
      WHERE pp.proposal_id = $1
        AND pp.status = 'succeeded'
        AND pp.stripe_payment_intent_id IS NOT NULL
        AND pp.payment_type IN ('deposit', 'balance', 'full', 'invoice')`,
    [proposalId]
  );

  const { planRefund, applyRefundReconciliation } = require('../utils/refundHelpers');
  const plan = planRefund({
    paymentsWithRemaining: payRes.rows.map(r => ({
      id: r.id,
      stripe_payment_intent_id: r.stripe_payment_intent_id,
      remainingCents: Number(r.remainingCents),
    })),
    requestedDollars: amount,
    amountPaidDollars: Number(proposal.amount_paid),
    totalPriceDollars: Number(proposal.total_price),
  });
  if (!plan.ok) {
    // AppError → `.message` surfaces as response `error` → admin toast.
    // (ValidationError would hide plan.message in fieldErrors behind the
    // generic banner, defeating the precise no-spanning guidance.)
    throw new AppError(plan.message, 400, plan.code);
  }

  // Pending row BEFORE Stripe, so a Stripe success we then fail to record
  // is still discoverable (and adoptable by the webhook backstop).
  const pendRes = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, stripe_payment_intent_id, amount, reason,
        total_price_before, total_price_after, issued_by, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')
     RETURNING id`,
    [proposalId, plan.targetPaymentId, plan.targetIntentId, plan.amountCents,
     cleanReason, Number(proposal.total_price), plan.totalPriceAfterDollars, req.user.id]
  );
  const pendingRowId = pendRes.rows[0].id;

  let refund;
  try {
    refund = await stripe.refunds.create(
      { payment_intent: plan.targetIntentId, amount: plan.amountCents },
      { idempotencyKey: `refund-${proposalId}-${idempotency_key}` }
    );
  } catch (err) {
    await pool.query(`UPDATE proposal_refunds SET status = 'failed' WHERE id = $1`, [pendingRowId]);
    console.error('Stripe refund error:', err);
    if (err.type === 'StripeInvalidRequestError') {
      throw new PaymentError(`Refund rejected: ${err.message}`, 'REFUND_REJECTED');
    }
    throw new ExternalServiceError('Stripe', err, 'Refund temporarily unavailable. Please try again.');
  }

  const dbClient = await pool.connect();
  let recon;
  try {
    await dbClient.query('BEGIN');
    recon = await applyRefundReconciliation(
      {
        proposalId: Number(proposalId),
        stripeRefundId: refund.id,
        paymentIntentId: plan.targetIntentId,
        paymentId: plan.targetPaymentId,
        amountCents: plan.amountCents,
        reason: cleanReason,
        issuedBy: req.user.id,
      },
      dbClient
    );
    await dbClient.query('COMMIT');
  } catch (dbErr) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(dbErr, { tags: { route: '/stripe/refund', proposalId } });
    }
    // Money already left via Stripe; the charge.refunded webhook backstop
    // adopts our pending row and reconciles. Surface 502 (not a silent 200),
    // correct ExternalServiceError signature: (service, originalError, userMsg).
    console.error('Refund reconciliation failed (webhook will backstop):', dbErr);
    throw new ExternalServiceError(
      'Database',
      dbErr,
      'Refund was processed by Stripe; the records will finish syncing momentarily.'
    );
  } finally {
    dbClient.release();
  }

  // applied===false → reconciliation no-op'd because this refund id was
  // already applied (idempotent winner, e.g. a double-submit whose Stripe
  // idempotency key returned the same refund). The pending row we inserted
  // above is now redundant — delete it so it can't strand as a ghost
  // 'pending' history entry. Money/books are already correct.
  if (recon && recon.applied === false) {
    await pool.query(
      `DELETE FROM proposal_refunds
        WHERE id = $1 AND status = 'pending' AND stripe_refund_id IS NULL`,
      [pendingRowId]
    );
  }

  const after = await pool.query(
    `SELECT p.total_price, p.amount_paid,
            c.name AS client_name, c.email AS client_email
     FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
     WHERE p.id = $1`,
    [proposalId]
  );

  // Refund client notification: non-blocking, gated on recon.applied to avoid
  // a double-send between this in-app route and the charge.refunded webhook.
  if (recon?.applied) {
    const { sendRefundClientNotification } = require('../utils/refundClientNotify');
    await sendRefundClientNotification({
      proposalId,
      amountCents: plan.amountCents,
      source: 'in_app_route',
    });
  }

  res.json({
    refunded: plan.amountCents,
    total_price: Number(after.rows[0].total_price),
    amount_paid: Number(after.rows[0].amount_paid),
  });
}));

// ─── Public: create a Payment Intent for an invoice ─────────────

/** POST /api/stripe/create-intent-for-invoice/:token — public, token-gated */
router.post('/create-intent-for-invoice/:token', publicLimiter, asyncHandler(async (req, res) => {
  const stripe = getStripe();
  if (!stripe) {
    throw new AppError('Payments are not configured.', 503, 'PAYMENTS_NOT_CONFIGURED');
  }

  const invRes = await pool.query(`
    SELECT i.id AS invoice_id, i.invoice_number, i.amount_due, i.amount_paid, i.status AS invoice_status,
           p.id AS proposal_id, p.event_type, p.event_type_custom, p.stripe_customer_id,
           c.email AS client_email, c.name AS client_name
    FROM invoices i
    JOIN proposals p ON p.id = i.proposal_id
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE i.token = $1 AND i.status IN ('sent', 'partially_paid')
  `, [req.params.token]);

  if (!invRes.rows[0]) throw new NotFoundError('This invoice is no longer available');

  const inv = invRes.rows[0];
  const balanceCents = inv.amount_due - inv.amount_paid;
  if (balanceCents <= 0) {
    throw new ConflictError('This invoice has already been paid in full', 'ALREADY_PAID');
  }

  const customerId = await getOrCreateCustomer({
    id: inv.proposal_id,
    stripe_customer_id: inv.stripe_customer_id,
    client_email: inv.client_email,
    client_name: inv.client_name,
  });

  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.create({
      amount: balanceCents,
      currency: 'usd',
      customer: customerId,
      description: `${inv.invoice_number} — ${inv.client_name || 'Dr. Bartender'}`,
      receipt_email: inv.client_email || undefined,
      metadata: {
        proposal_id: String(inv.proposal_id),
        invoice_id: String(inv.invoice_id),
        payment_type: 'invoice',
      },
    });
  } catch (err) {
    console.error('Stripe invoice payment intent error:', err);
    throw new ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.');
  }

  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
    [inv.proposal_id, paymentIntent.id, balanceCents]
  );

  res.json({ clientSecret: paymentIntent.client_secret });
}));

// ─── Stripe Webhook ───────────────────────────────────────────────

/** POST /api/stripe/webhook — raw body, Stripe signature verified */
router.post('/webhook', asyncHandler(async (req, res) => {
  // Try BOTH live and test secrets so events that span a test/live cutoff
  // (e.g., Stripe retrying a `payment_intent.succeeded` as the cutoff passes)
  // are still verified and processed. Whichever client verified the event is
  // the one whose API keypair matches the event's mode.
  const sig = req.headers['stripe-signature'];
  const verifiers = [
    { secret: process.env.STRIPE_WEBHOOK_SECRET, client: getLiveClient() },
    { secret: process.env.STRIPE_WEBHOOK_SECRET_TEST, client: getTestClient() },
  ].filter(v => v.secret && v.client);

  if (verifiers.length === 0) {
    return res.status(503).send('Payments not configured');
  }

  let event = null;
  let stripeForEvent = null;
  for (const { secret, client } of verifiers) {
    try {
      event = client.webhooks.constructEvent(req.body, sig, secret);
      stripeForEvent = client;
      break;
    } catch (_) { /* try next secret */ }
  }
  if (!event) {
    console.error('Webhook signature verification failed against all configured secrets');
    Sentry.captureMessage('Stripe webhook signature failure', {
      level: 'warning',
      tags: { webhook: 'stripe', reason: 'invalid_signature' },
    });
    return res.status(400).send('Webhook signature verification failed');
  }
  // `stripeForEvent` is intentionally available for any downstream Stripe API
  // calls inside this handler so we use the keypair matching the event's mode.
  void stripeForEvent;

  // ── Helper: send payment notification emails (non-blocking) ────
  async function sendPaymentNotifications(proposalId, amountCents, paymentType) {
    try {
      const payInfo = await pool.query(`
        SELECT p.event_type, p.event_type_custom, p.client_signed_at, p.last_minute_hold,
               p.autopay_enrolled, p.status, p.client_id, p.event_date,
               c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
               c.communication_preferences, c.email_status, c.phone_status
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
      `, [proposalId]);
      const pi = payInfo.rows[0];
      const amountFormatted = (amountCents / 100).toFixed(2);
      const payLabel = paymentType === 'full' ? 'full payment' : paymentType === 'balance' ? 'balance payment' : paymentType === 'invoice' ? 'invoice payment' : 'deposit';
      const eventLabel = eventLabelFor(pi);

      // Coupled sign+pay: if the client signed within the last 6 hours and this
      // is a first-time payment (deposit or full), send ONE combined email in
      // place of the separate sign + payment emails the sign route would
      // otherwise have already fired.
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      const isCoupledSigning =
        !!pi?.client_signed_at
        && (Date.now() - new Date(pi.client_signed_at).getTime()) < SIX_HOURS_MS
        && (paymentType === 'deposit' || paymentType === 'full');

      if (pi?.client_email) {
        // last_minute_hold was set in-tx and committed before this post-commit
        // notifier runs, so the flag is readable here. Append the cancellation
        // caveat to the first-payment client email when the booking is ≤72h out.
        const lastMinute = !!pi?.last_minute_hold;

        // Respect the same suppression rules the dispatcher applies on scheduled rows.
        const proposalForCheck = { id: proposalId, status: pi.status || 'deposit_paid' };
        const clientForCheck = {
          id: pi.client_id,
          communication_preferences: pi.communication_preferences,
          email_status: pi.email_status,
          phone_status: pi.phone_status,
        };
        const sendCheck = await shouldSendImmediate({
          proposal: proposalForCheck,
          client: clientForCheck,
          channel: 'email',
        });
        if (!sendCheck.ok) {
          console.log(`[orientation] suppressed for proposal ${proposalId}: ${sendCheck.reason}`);
          // Skip the client-email branch; downstream admin email still fires.
        } else if (isCoupledSigning) {
          // FULL ORIENTATION: assemble payload, build .ics, send with attachment.
          try {
            const payload = await buildOrientationPayload(proposalId, { publicSiteUrl: PUBLIC_SITE_URL });
            if (!payload) {
              console.error(`[orientation] could not load proposal ${proposalId}, skipping`);
            } else {
              const bookingBlock = {
                formattedEventDate: payload.formattedEventDate,
                formattedStartTime: payload.formattedStartTime,
                eventLocation: payload.eventLocation,
                guestCount: payload.guestCount,
                packageName: payload.packageName,
              };
              const receiptBlock = {
                depositPaid: amountFormatted,
                balanceRemaining: payload.balance.balanceRemaining.toFixed(2),
                paidInFull: payload.balance.paidInFull,
                autopayEnrolled: payload.balance.autopayEnrolled,
                dueLabel: payload.balance.dueLabel,
                formattedBalanceDueDate: payload.balance.formattedBalanceDueDate,
              };

              const setupMin = payload.setupMinutesBefore;
              const timelineLines = [
                payload.potionPlannerUrl
                  ? 'Drink plan: pick yours any time'
                  : 'Drink plan: we will be in touch with your planner link',
                payload.balance.paidInFull
                  ? 'Balance: paid in full'
                  : `Balance: ${payload.balance.dueLabel}${payload.balance.formattedBalanceDueDate ? ` ${payload.balance.formattedBalanceDueDate}` : ''}`,
                'Bartender assignment: about 14 days before the event',
                `Day-of: your bartender arrives ${setupMin} minutes before your start time to set up`,
              ];

              const attachments = [];
              if (payload.utc) {
                const ics = renderEventIcs({
                  uid: `proposal-${proposalId}@drbartender.com`,
                  startUtc: payload.utc.startUtc,
                  endUtc: payload.utc.endUtc,
                  summary: `${eventLabel} with Dr. Bartender`,
                  location: payload.eventLocation,
                  description: `Your booking with Dr. Bartender. Reply to this email with any questions.`,
                  stampUtc: new Date(),
                });
                attachments.push({ filename: 'event.ics', content: Buffer.from(ics, 'utf8') });
              }

              const tpl = emailTemplates.signedAndPaidClient({
                clientName: pi.client_name,
                eventTypeLabel: eventLabel,
                amount: amountFormatted,
                paymentType: payLabel,
                lastMinute,
                bookingBlock,
                receiptBlock,
                potionPlannerUrl: payload.potionPlannerUrl,
                timelineLines,
              });
              await sendEmail({
                to: pi.client_email,
                ...tpl,
                ...(attachments.length ? { attachments } : {}),
              });
            }
          } catch (orientationErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(orientationErr, {
                tags: { route: '/webhook', step: 'orientation_email', proposalId: String(proposalId) },
              });
            }
            console.error('[orientation] failed (non-blocking):', orientationErr);
            // Fall back to the old short-form path so the client at least hears back.
            const tpl = emailTemplates.signedAndPaidClient({
              clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute,
            });
            await sendEmail({ to: pi.client_email, ...tpl });
          }

          // Phase 3 (spec 2.1): sign+pay confirmation SMS, sent alongside the
          // orientation email. Best-effort — own try/catch, never rethrown into
          // the webhook handler. Gated by the same SMS suppression rule the
          // dispatcher applies to scheduled rows.
          try {
            const smsCheck = await shouldSendImmediate({
              proposal: proposalForCheck,
              client: clientForCheck,
              channel: 'sms',
            });
            if (smsCheck.ok) {
              const { sendAndLogSms } = require('../utils/sms');
              const smsTemplates = require('../utils/smsTemplates');
              const eventDateSms = pi.event_date
                ? new Date(String(pi.event_date).slice(0, 10) + 'T12:00:00Z')
                    .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' })
                : 'your event';
              await sendAndLogSms({
                to: pi.client_phone,
                body: smsTemplates.signPayConfirmationSms({ eventDate: eventDateSms }),
                clientId: pi.client_id || null,
                messageType: 'sign_pay_confirmation',
                recipientName: pi.client_name || null,
              });
            } else {
              console.log(`[signPaySms] suppressed for proposal ${proposalId}: ${smsCheck.reason}`);
            }
          } catch (smsErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(smsErr, {
                tags: { webhook: 'stripe', route: '/webhook', step: 'sign_pay_sms' },
              });
            }
            console.error('Sign+pay confirmation SMS failed (non-blocking):', smsErr);
          }
        } else {
          // Non-coupled payment. Detect autopay-driven balance charge so the
          // autopay-specific receipt copy variant fires.
          const isAutopaySuccess = paymentType === 'balance' && pi?.autopay_enrolled === true;
          const tpl = emailTemplates.paymentReceivedClient({
            clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute, autopay: isAutopaySuccess,
          });
          await sendEmail({ to: pi.client_email, ...tpl });
        }
      }
      // Admin notification consolidation: the standalone clientSignedAdmin fires
      // from the public-token signing route. In the canonical sign+pay coupled
      // flow, the payment arrives within ~6 hours of the signature, and the
      // post-commit notifier here suppresses the standalone paymentReceivedAdmin
      // in favor of signedAndPaidAdmin (urgent_booking); a standalone balance
      // payment routes to routine_finance. Spec section 6.
      const adminUrl = `${ADMIN_URL}/proposals/${proposalId}`;
      const adminTpl = isCoupledSigning
        ? emailTemplates.signedAndPaidAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl })
        : emailTemplates.paymentReceivedAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl });
      await notifyAdminCategory({ category: isCoupledSigning ? 'urgent_booking' : 'routine_finance', subject: adminTpl.subject, emailHtml: adminTpl.html, emailText: adminTpl.text });
    } catch (emailErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(emailErr, {
          tags: { webhook: 'stripe', route: '/webhook' },
        });
      }
      console.error('Payment notification email failed (non-blocking):', emailErr);
    }
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const proposalId = intent.metadata?.proposal_id;
    const paymentType = intent.metadata?.payment_type || 'deposit';

    if (proposalId) {
      const dbClient = await pool.connect();
      let isFirstDelivery = false;
      // Set true in-tx for an initial-booking ≤72h-out payment. Gates BOTH the flag
      // UPDATE (in-tx) and post-commit SMS so a Stripe retry never double-flags/blasts.
      let isLastMinuteHold = false;
      try {
        await dbClient.query('BEGIN');

        // Idempotency: Stripe retries on transient delivery failure. Insert the
        // payment row FIRST with ON CONFLICT DO NOTHING; rowCount === 0 = duplicate
        // delivery → skip all state mutations and post-commit side effects.
        const inserted = await dbClient.query(
          `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
           VALUES ($1, $2, $3, $4, 'succeeded')
           ON CONFLICT (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL AND status = 'succeeded' DO NOTHING
           RETURNING id`,
          [proposalId, intent.id, paymentType, intent.amount]
        );
        isFirstDelivery = inserted.rowCount === 1;

        if (isFirstDelivery) {
          // Determine new status and amount_paid based on payment type
          if (paymentType === 'full') {
            await dbClient.query(`
              UPDATE proposals
              SET status = 'balance_paid',
                  amount_paid = total_price,
                  payment_type = 'full'
              WHERE id = $1 AND status NOT IN ('balance_paid', 'confirmed', 'archived')
            `, [proposalId]);
          } else if (paymentType === 'balance') {
            // Guard archived too — an admin can archive a proposal between the
            // client opening Stripe and the webhook landing. Reviving it would
            // break the documented archived → only-draft state machine.
            await dbClient.query(`
              UPDATE proposals
              SET status = 'balance_paid',
                  amount_paid = total_price,
                  autopay_status = NULL
              WHERE id = $1 AND status = 'deposit_paid'
            `, [proposalId]);
          } else if (paymentType === 'drink_plan_extras' || paymentType === 'drink_plan_with_balance') {
            // Drink plan extras payment — increment amount_paid
            const paidDollars = intent.amount / 100;
            const updateRes = await dbClient.query(`
              UPDATE proposals
              SET amount_paid = COALESCE(amount_paid, 0) + $1
              WHERE id = $2
              RETURNING amount_paid, total_price
            `, [paidDollars, proposalId]);

            if (updateRes.rows[0]) {
              const newAmountPaid = Number(updateRes.rows[0].amount_paid);
              const totalPrice = Number(updateRes.rows[0].total_price);
              if (newAmountPaid >= totalPrice) {
                await dbClient.query(
                  "UPDATE proposals SET status = 'balance_paid' WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')",
                  [proposalId]
                );
              }
            }
          } else if (paymentType === 'invoice') {
            // Invoice payment (Balance / Additional Services / manual invoice paid
            // via the public invoice page). Roll the captured amount up into the
            // proposal and promote to balance_paid once fully paid. Increment —
            // never "set to total" — so partial invoice payments and Additional
            // Services (which push amount_paid ABOVE total_price) are correct.
            // Mirrors the drink_plan_extras branch. Idempotent: this whole block
            // is inside isFirstDelivery (gated by the proposal_payments ON CONFLICT
            // insert), so a Stripe retry never re-increments.
            const paidDollars = intent.amount / 100;
            const upd = await dbClient.query(`
              UPDATE proposals
              SET amount_paid = COALESCE(amount_paid, 0) + $1
              WHERE id = $2
              RETURNING amount_paid, total_price
            `, [paidDollars, proposalId]);
            if (upd.rows[0] && Number(upd.rows[0].amount_paid) >= Number(upd.rows[0].total_price)) {
              await dbClient.query(
                "UPDATE proposals SET status = 'balance_paid' WHERE id = $1 AND status NOT IN ('confirmed', 'completed', 'archived')",
                [proposalId]
              );
            }
          } else {
            // deposit
            await dbClient.query(`
              UPDATE proposals
              SET status = 'deposit_paid',
                  amount_paid = deposit_amount,
                  payment_type = 'deposit'
              WHERE id = $1 AND status NOT IN ('deposit_paid', 'balance_paid', 'confirmed', 'archived')
            `, [proposalId]);
          }

          // Last-minute staffing hold — only for INITIAL-booking branches (full;
          // deposit covered defensively even though create-intent rejects a ≤14d
          // deposit). balance / drink_plan_* / invoice are post-conversion and
          // must never flip the hold. The post-commit SMS blast is gated on this
          // flag AND isFirstDelivery, so a Stripe retry can't re-flag or re-blast.
          if (paymentType === 'full' || paymentType === 'deposit') {
            const lmRes = await dbClient.query(
              'SELECT event_date, event_start_time FROM proposals WHERE id = $1',
              [proposalId]
            );
            if (lmRes.rows[0]) {
              const w = getBookingWindow({
                eventDate: lmRes.rows[0].event_date,
                eventStartTime: lmRes.rows[0].event_start_time,
              });
              if (w.lastMinuteHold) {
                isLastMinuteHold = true;
                await dbClient.query(
                  'UPDATE proposals SET last_minute_hold = true WHERE id = $1',
                  [proposalId]
                );
              }
            }
          }

          // Save payment method ID if autopay was enrolled (card saved via setup_future_usage)
          if (intent.payment_method && paymentType === 'deposit') {
            await dbClient.query(`
              UPDATE proposals
              SET stripe_payment_method_id = $1
              WHERE id = $2 AND autopay_enrolled = true AND stripe_payment_method_id IS NULL
            `, [intent.payment_method, proposalId]);
          }

          await dbClient.query(
            "UPDATE stripe_sessions SET status = 'succeeded' WHERE stripe_payment_intent_id = $1",
            [intent.id]
          );

          const action = paymentType === 'balance' ? 'balance_paid'
            : paymentType === 'full' ? 'paid_in_full'
            : paymentType === 'drink_plan_extras' ? 'drink_plan_extras_paid'
            : paymentType === 'drink_plan_with_balance' ? 'drink_plan_balance_paid'
            : paymentType === 'invoice' ? 'invoice_paid'
            : 'deposit_paid';
          await dbClient.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, $2, 'system', $3)`,
            [proposalId, action, JSON.stringify({ amount: intent.amount, payment_intent_id: intent.id, payment_type: paymentType })]
          );

          // ── Invoice integration ──────────────────────────────────
          const invoiceId = intent.metadata?.invoice_id;
          const paymentRow = await dbClient.query(
            'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
            [intent.id, 'succeeded']
          );
          if (paymentRow.rows[0]) {
            const paymentRowId = paymentRow.rows[0].id;

            if (invoiceId) {
              await linkPaymentToInvoice(Number(invoiceId), paymentRowId, intent.amount, dbClient);
            } else if (paymentType === 'drink_plan_extras' || paymentType === 'drink_plan_with_balance') {
              // Idempotency: this block is inside `if (isFirstDelivery)` above, so
              // Stripe retries won't re-create the extras invoice. If lifted out,
              // add ON CONFLICT to createDrinkPlanExtrasInvoice first.
              //
              // Clamp metadata against the authoritative captured amount so a
              // corrupted extras/balance split can't apportion more than was
              // actually charged. extras takes priority; balance is the remainder.
              const rawExtrasCents = Number(intent.metadata?.extras_amount_cents || 0);
              const rawBalanceCents = Number(intent.metadata?.balance_amount_cents || 0);
              const extrasCents = Math.max(0, Math.min(rawExtrasCents, intent.amount));
              const balanceCents = Math.max(0, intent.amount - extrasCents);
              const drinkPlanId = Number(intent.metadata?.drink_plan_id);

              if ((rawExtrasCents + rawBalanceCents) !== intent.amount) {
                console.warn(
                  `Webhook: extras+balance metadata (${rawExtrasCents}+${rawBalanceCents}) != intent.amount (${intent.amount}) for intent ${intent.id}, proposal ${proposalId}`
                );
                if (process.env.SENTRY_DSN_SERVER) {
                  Sentry.captureMessage(
                    `Drink-plan extras/balance split mismatch (proposal ${proposalId}, intent ${intent.id}, rawExtras ${rawExtrasCents}, rawBalance ${rawBalanceCents}, intent.amount ${intent.amount})`,
                    'warning'
                  );
                }
              }

              if (extrasCents > 0 && drinkPlanId) {
                const extrasInvoice = await createDrinkPlanExtrasInvoice(
                  { proposalId, drinkPlanId, extrasAmountCents: extrasCents },
                  dbClient
                );
                await linkPaymentToInvoice(extrasInvoice.id, paymentRowId, extrasCents, dbClient);
              }

              if (balanceCents > 0) {
                const balanceInv = await findOpenInvoiceForBalance(proposalId, dbClient);
                if (balanceInv) {
                  await linkPaymentToInvoice(balanceInv.id, paymentRowId, balanceCents, dbClient);
                } else {
                  console.warn(
                    `Webhook: drink_plan_with_balance payment ${intent.id} for proposal ${proposalId} had no open invoice to absorb balance portion ($${(balanceCents / 100).toFixed(2)})`
                  );
                  if (process.env.SENTRY_DSN_SERVER) {
                    Sentry.captureMessage(
                      `Unapplied drink-plan balance portion (proposal ${proposalId}, intent ${intent.id}, cents ${balanceCents})`,
                      'warning'
                    );
                  }
                }
              }
            } else {
              const openInvoice = await dbClient.query(
                "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
                [proposalId]
              );
              if (openInvoice.rows[0]) {
                await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRowId, intent.amount, dbClient);
              }
            }
          }

          if (paymentType === 'deposit') {
            await createBalanceInvoice(proposalId, dbClient);
          }
        } else {
          console.log(`Webhook: duplicate delivery for intent ${intent.id} — skipping (already processed)`);
        }

        await dbClient.query('COMMIT');
        if (isFirstDelivery) {
          console.log(`Payment (${paymentType}) received for proposal ${proposalId}: $${(intent.amount / 100).toFixed(2)}`);
        }
      } catch (dbErr) {
        try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dbErr, {
            tags: { webhook: 'stripe', route: '/webhook', event: 'payment_intent.succeeded' },
          });
        }
        console.error('Webhook DB error:', dbErr);
        // Re-throw so asyncHandler returns 5xx and Stripe retries delivery.
        // A 200 would tell Stripe the event was processed and silently strand
        // the proposal in an inconsistent state.
        throw dbErr;
      } finally {
        dbClient.release();
      }

      // Non-blocking post-commit work — only on first delivery. Retries must
      // not re-send receipts or re-create shifts.
      if (isFirstDelivery) {
        // ≤72h booking: admin + broad-net staff SMS blast. Fire-and-forget;
        // notifyLastMinuteBooking self-guards (try/catch + Sentry, never
        // throws). Gated by isLastMinuteHold (set in-tx above) AND
        // isFirstDelivery so a Stripe webhook retry never re-blasts.
        if (isLastMinuteHold) notifyLastMinuteBooking(proposalId);

        // Schedule the balance-reminder ladder + pre-event reminders for the
        // deposit-paid window. Both helpers are idempotent so a Stripe retry
        // re-entering this block will not double-schedule. Gated on deposit/
        // full payments; balance/extras payments skip (they fire post-conversion
        // when reminders already exist). The pre-event call moved out of the
        // separate block below into this single helper invocation.
        let depositRemindersScheduled = false;
        if (paymentType === 'deposit' || paymentType === 'full') {
          const { scheduleDepositPaidReminders } = require('../utils/depositPaidSchedulers');
          await scheduleDepositPaidReminders(proposalId, { source: 'payment_intent.succeeded' });
          depositRemindersScheduled = true;
        }

        // Create the shift (and, via createEventShifts, the drink plan) BEFORE
        // sending the orientation email — the orientation payload reads
        // drink_plans.token, which only exists once createEventShifts has run.
        try {
          const shift = await createEventShifts(proposalId);
          if (shift) console.log(`Shift #${shift.id} created for proposal ${proposalId}`);
        } catch (shiftErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(shiftErr, {
              tags: { webhook: 'stripe', route: '/webhook' },
            });
          }
          console.error('Shift auto-creation failed (non-blocking):', shiftErr);
        }

        sendPaymentNotifications(proposalId, intent.amount, paymentType);

        // depositRemindersScheduled covers both balance + pre-event scheduling
        // above. This block remains as the deposit-only marketing/drip anchor.
        if (depositRemindersScheduled) {

          // Plan 2d: schedule long-lead marketing touches (New Year, 6-mo-out)
          // and suppress the now-moot unsigned-proposal drip. Separate
          // try/catch from the Plan 2c block above so a marketing failure
          // cannot mask a pre-event-reminder failure. The helper self-gates on
          // eligibility and is idempotent under Stripe webhook retries.
          try {
            const { onProposalSignedAndPaid } = require('../utils/marketingHandlers');
            await onProposalSignedAndPaid(Number(proposalId));
          } catch (marketingErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(marketingErr, {
                tags: { webhook: 'stripe', route: '/webhook', step: 'marketing-signpay' },
              });
            }
            console.error('Marketing enroll on sign+pay failed (non-blocking):', marketingErr);
          }
        }
      }
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    const proposalId = intent.metadata?.proposal_id;
    const paymentType = intent.metadata?.payment_type || 'deposit';

    if (proposalId) {
      try {
        // Three independent writes — parallelize via Promise.all.
        await Promise.all([
          pool.query(
            "UPDATE stripe_sessions SET status = 'failed' WHERE stripe_payment_intent_id = $1",
            [intent.id]
          ),
          pool.query(
            `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
             VALUES ($1, $2, $3, $4, 'failed')`,
            [proposalId, intent.id, paymentType, intent.amount]
          ),
          pool.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'payment_failed', 'system', $2)`,
            [proposalId, JSON.stringify({ amount: intent.amount, payment_intent_id: intent.id, payment_type: paymentType, failure_message: intent.last_payment_error?.message || null })]
          ),
        ]);
        console.warn(`Payment FAILED (${paymentType}) for proposal ${proposalId}: ${intent.last_payment_error?.message || 'unknown'}`);

        // Notify admins subscribed to payment_failure of a failed payment.
        const payInfo = await pool.query(`SELECT p.event_type, p.event_type_custom, c.name AS client_name FROM proposals p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`, [proposalId]);
        const failPi = payInfo.rows[0];
        const failReason = intent.last_payment_error?.message || 'Unknown error';
        const failAmount = `$${(intent.amount / 100).toFixed(2)}`;
        const failClient = failPi?.client_name || 'Unknown';
        await notifyAdminCategory({
          category: 'payment_failure',
          subject: `Payment failed: ${failClient} (${eventLabelFor(failPi)})`,
          emailHtml: `<p>A ${paymentType} payment of ${failAmount} failed for <strong>${failClient}</strong>.</p><p><strong>Reason:</strong> ${failReason}</p><p><a href="${ADMIN_URL}/proposals/${proposalId}">View Proposal</a></p>`,
          emailText: `A ${paymentType} payment of ${failAmount} failed for ${failClient}. Reason: ${failReason}. ${ADMIN_URL}/proposals/${proposalId}`,
        });

        // Client-facing payment-failure email (throttled one per 24h per
        // proposal). Extracted to a sibling util to keep this over-cap file
        // from growing; the helper owns its own error handling.
        await notifyClientPaymentFailed({ proposalId, paymentIntentId: intent.id });
      } catch (err) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(err, {
            tags: { webhook: 'stripe', route: '/webhook' },
          });
        }
        console.error('payment_intent.payment_failed handler error:', err);
      }
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // Tip page handler — only for sessions tagged kind=tip in metadata.
    // Non-tip sessions fall through to the proposal deposit logic below.
    if (session.metadata && session.metadata.kind === 'tip') {
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const targetUserId = parseInt(session.metadata.bartender_user_id, 10);
      const token = session.metadata.tip_page_token;
      const piId = session.payment_intent;

      if (!Number.isInteger(targetUserId) || !token || !UUID_RE.test(token) || !piId) {
        console.error('[tip-webhook] malformed tip session metadata', session.id);
        Sentry.captureMessage('Malformed tip session metadata', {
          level: 'warning',
          tags: { webhook: 'stripe', kind: 'tip' },
          extra: { sessionId: session.id, metadata: session.metadata },
        });
        return res.json({ received: true });
      }

      if (!session.amount_total || session.amount_total <= 0) {
        console.error('[tip-webhook] non-positive amount_total', session.id);
        Sentry.captureMessage('Non-positive tip amount_total', {
          level: 'warning',
          tags: { webhook: 'stripe', kind: 'tip' },
          extra: { sessionId: session.id, amount_total: session.amount_total },
        });
        return res.json({ received: true });
      }

      // Cross-validate metadata against the DB. The token is the source of truth —
      // if Stripe metadata's bartender_user_id disagrees with the user_id stored
      // against this token (e.g. a Payment Link was hand-edited in the Stripe
      // dashboard, or a backfill bug mis-mapped users), credit the DB user, not
      // the metadata user. Token not in DB at all = stale link from a since-rotated
      // token; ack and drop.
      const verify = await pool.query(
        'SELECT user_id FROM payment_profiles WHERE tip_page_token = $1',
        [token]
      );
      if (!verify.rows[0]) {
        console.error('[tip-webhook] tip_page_token not found in DB', session.id);
        Sentry.captureMessage('Tip session token not found in payment_profiles', {
          level: 'warning',
          tags: { webhook: 'stripe', kind: 'tip' },
          extra: { sessionId: session.id, tokenPrefix: token.slice(0, 8) },
        });
        return res.json({ received: true });
      }
      const dbUserId = verify.rows[0].user_id;
      if (dbUserId !== targetUserId) {
        console.warn('[tip-webhook] metadata bartender_user_id mismatch — using DB value', session.id);
        Sentry.captureMessage('Tip metadata bartender_user_id mismatch', {
          level: 'warning',
          tags: { webhook: 'stripe', kind: 'tip' },
          extra: { sessionId: session.id, metadataUserId: targetUserId, dbUserId },
        });
      }

      const inserted = await pool.query(`
        INSERT INTO tips (tip_page_token, target_user_id, amount_cents,
                          stripe_payment_intent_id, stripe_session_id,
                          customer_email, tipped_at)
        VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7))
        ON CONFLICT (stripe_payment_intent_id) DO NOTHING
        RETURNING id
      `, [
        token, dbUserId, session.amount_total, piId, session.id,
        session.customer_details?.email || null, session.created,
      ]);
      // Best-effort match the tip to its event; must not fail the webhook.
      // Tip session handled — do NOT fall through to proposal deposit logic.
      if (inserted.rows.length) {
        try { await matchTipToEvent(inserted.rows[0].id); }
        catch (err) { Sentry.captureException(err, { tags: { webhook: 'tip', step: 'tip_match' } }); }
      }
      return res.json({ received: true });
    }

    const proposalId = session.metadata?.proposal_id;
    if (proposalId) {
      const dbClient = await pool.connect();
      let isFirstDelivery = false;
      try {
        await dbClient.query('BEGIN');

        // Idempotency guard (see payment_intent.succeeded for rationale).
        // Insert payment row first; if it collides with a prior delivery of
        // the same session (same payment_intent), skip all state mutations
        // and post-commit side effects.
        const inserted = await dbClient.query(
          `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
           VALUES ($1, $2, 'deposit', $3, 'succeeded')
           ON CONFLICT (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL AND status = 'succeeded' DO NOTHING
           RETURNING id`,
          [proposalId, session.payment_intent, session.amount_total]
        );
        isFirstDelivery = inserted.rowCount === 1;

        // Unconditional: a payment_intent.succeeded that claimed isFirstDelivery first must not leave this link row 'pending' (would let it be reused).
        await dbClient.query("UPDATE stripe_sessions SET status = 'succeeded' WHERE stripe_payment_link_id = $1", [session.payment_link]);

        if (isFirstDelivery) {
          await dbClient.query(
            "UPDATE proposals SET status = 'deposit_paid', amount_paid = deposit_amount WHERE id = $1 AND status NOT IN ('deposit_paid', 'balance_paid', 'confirmed', 'archived')",
            [proposalId]
          );
          await dbClient.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'deposit_paid', 'system', $2)`,
            [proposalId, JSON.stringify({ amount: session.amount_total, payment_link: session.payment_link })]
          );

          // ── Invoice integration (parity with payment_intent.succeeded) ──
          const openInvoice = await dbClient.query(
            "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
            [proposalId]
          );
          if (openInvoice.rows[0]) {
            const paymentRow = await dbClient.query(
              'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
              [session.payment_intent, 'succeeded']
            );
            if (paymentRow.rows[0]) {
              await linkPaymentToInvoice(openInvoice.rows[0].id, paymentRow.rows[0].id, session.amount_total, dbClient);
            }
          }
          await createBalanceInvoice(proposalId, dbClient);
        } else {
          console.log(`Webhook: duplicate checkout.session.completed for intent ${session.payment_intent} — skipping`);
        }

        await dbClient.query('COMMIT');
        if (isFirstDelivery) {
          console.log(`Deposit paid (payment link) for proposal ${proposalId}`);
        }
      } catch (dbErr) {
        try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dbErr, {
            tags: { webhook: 'stripe', route: '/webhook', event: 'checkout.session.completed' },
          });
        }
        console.error('Webhook DB error:', dbErr);
        // Re-throw so asyncHandler returns 5xx and Stripe retries delivery.
        throw dbErr;
      } finally {
        dbClient.release();
      }

      // Non-blocking post-commit work — only on first delivery.
      if (isFirstDelivery) {
        sendPaymentNotifications(proposalId, session.amount_total || 0, 'deposit');
        try {
          const shift = await createEventShifts(proposalId);
          if (shift) console.log(`Shift #${shift.id} created for proposal ${proposalId}`);
        } catch (shiftErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(shiftErr, {
              tags: { webhook: 'stripe', route: '/webhook' },
            });
          }
          console.error('Shift auto-creation failed (non-blocking):', shiftErr);
        }

        // Schedule the balance-reminder ladder + pre-event reminders, same as
        // the payment_intent.succeeded deposit path. Payment-Link sessions are
        // always 'deposit', so no payment-type gate is needed here.
        const { scheduleDepositPaidReminders } = require('../utils/depositPaidSchedulers');
        await scheduleDepositPaidReminders(Number(proposalId), { source: 'checkout.session.completed' });

        // Plan 2d: a Payment-Link deposit is a genuine client sign+pay, so
        // schedule the long-lead marketing touches and suppress the drip,
        // same as the payment_intent.succeeded path.
        try {
          const { onProposalSignedAndPaid } = require('../utils/marketingHandlers');
          await onProposalSignedAndPaid(Number(proposalId));
        } catch (marketingErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(marketingErr, {
              tags: { webhook: 'stripe', route: '/webhook', event: 'checkout.session.completed', step: 'marketing-signpay' },
            });
          }
          console.error('Marketing enroll on Payment-Link deposit failed (non-blocking):', marketingErr);
        }
      }
    }
  }

  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const paymentIntentId = typeof charge.payment_intent === 'string'
      ? charge.payment_intent
      : charge.payment_intent?.id;
    // refunds.data is newest-first, so data[0] is the refund this event is about.
    // A mis-pick in a multi-refund race is harmless: unique stripe_refund_id makes
    // applyRefundReconciliation a no-op for an id already applied by the sync route.
    const refundObj = charge.refunds?.data?.[0];
    const proposalId = charge.metadata?.proposal_id
      || (paymentIntentId
            ? (await pool.query(
                'SELECT proposal_id FROM proposal_payments WHERE stripe_payment_intent_id = $1 LIMIT 1',
                [paymentIntentId]
              )).rows[0]?.proposal_id
            : null);

    if (proposalId && refundObj && paymentIntentId) {
      const dbClient = await pool.connect();
      let recon = null;
      try {
        await dbClient.query('BEGIN');
        const payRow = await dbClient.query(
          `SELECT id FROM proposal_payments
            WHERE stripe_payment_intent_id = $1 AND status = 'succeeded' LIMIT 1`,
          [paymentIntentId]
        );
        const { applyRefundReconciliation } = require('../utils/refundHelpers');
        recon = await applyRefundReconciliation(
          {
            proposalId: Number(proposalId),
            stripeRefundId: refundObj.id,
            paymentIntentId,
            paymentId: payRow.rows[0]?.id ?? null,
            amountCents: refundObj.amount,
            reason: 'Refunded via Stripe dashboard',
            issuedBy: null,
          },
          dbClient
        );
        await dbClient.query('COMMIT');
        console.log(`charge.refunded reconciled for proposal ${proposalId} (refund ${refundObj.id})`);
      } catch (dbErr) {
        try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(dbErr, { tags: { webhook: 'stripe', event: 'charge.refunded' } });
        }
        console.error('Webhook charge.refunded error:', dbErr);
        throw dbErr; // 5xx → Stripe retries (same posture as payment_intent.succeeded)
      } finally {
        dbClient.release();
      }

      // Notify the client only when THIS request actually applied the refund.
      // Dashboard-issued refunds land here first (recon.applied true) and the
      // client gets the same notification email the in-app route would send.
      // When the webhook fires after an in-app refund, recon.applied is false
      // (the in-app route already applied) and we skip to avoid double-send.
      if (recon?.applied) {
        const { sendRefundClientNotification } = require('../utils/refundClientNotify');
        await sendRefundClientNotification({
          proposalId,
          amountCents: refundObj.amount,
          source: 'webhook',
        });
      }
    }
    // Tip-clawback path: no-ops when paymentIntentId is not a tip.
    await clawbackTipByPaymentIntent(paymentIntentId, Number(charge.amount_refunded || 0));
  }

  if (event.type === 'charge.dispute.funds_withdrawn') {
    const dispute = event.data.object;
    await clawbackTipByPaymentIntent(dispute.payment_intent, Number(dispute.amount || 0));
  }

  if (event.type === 'charge.dispute.funds_reinstated') {
    const dispute = event.data.object;
    const piId = dispute.payment_intent;
    if (piId) {
      const { rows } = await pool.query('SELECT id FROM tips WHERE stripe_payment_intent_id = $1', [piId]);
      if (rows[0]) {
        try {
          const { notifyDisputeWon } = require('../utils/payrollDisputeNotify');
          await notifyDisputeWon(rows[0].id, {
            reinstatedAmountCents: Number(dispute.amount || 0),
            disputeOpenedAt: dispute.created ? new Date(dispute.created * 1000) : null,
            disputeWonAt: new Date(),
          });
        } catch (err) { Sentry.captureException(err, { tags: { webhook: 'tip_dispute_won' } }); }
      }
    }
    return res.json({ received: true });
  }

  res.json({ received: true });
}));

module.exports = router;
