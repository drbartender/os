const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicLimiter } = require('../middleware/rateLimiters');
const { createEventShifts } = require('../utils/eventCreation');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { calculateSyrupCost } = require('../utils/pricingEngine');
const {
  createBalanceInvoice,
  linkPaymentToInvoice,
  createDrinkPlanExtrasInvoice,
  findOpenInvoiceForBalance,
} = require('../utils/invoiceHelpers');
const { getEventTypeLabel } = require('../utils/eventTypes');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, ValidationError, ConflictError, NotFoundError, ExternalServiceError, PaymentError } = require('../utils/errors');
const { PUBLIC_SITE_URL, ADMIN_URL } = require('../utils/urls');

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
  if (proposal.stripe_customer_id) {
    return proposal.stripe_customer_id;
  }
  const stripe = getStripe();
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
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.total_price, p.event_date,
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
    d.setDate(d.getDate() - 14);
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

  // Store link reference
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_link_id, amount, status)
     VALUES ($1, $2, $3, 'pending')`,
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

  const result = await pool.query(`
    SELECT id, total_price, amount_paid, stripe_customer_id, stripe_payment_method_id,
           autopay_enrolled, status, event_type, event_type_custom
    FROM proposals WHERE id = $1
  `, [req.params.id]);

  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  const proposal = result.rows[0];

  if (proposal.status !== 'deposit_paid') {
    throw new ConflictError('Proposal must be in deposit_paid status to charge balance', 'INVALID_STATUS');
  }
  if (!proposal.stripe_customer_id || !proposal.stripe_payment_method_id) {
    throw new ConflictError('No saved payment method for this proposal', 'NO_PAYMENT_METHOD');
  }

  const balanceCents = Math.round((Number(proposal.total_price) - Number(proposal.amount_paid)) * 100);
  if (balanceCents <= 0) {
    throw new ConflictError('No remaining balance to charge', 'NO_BALANCE');
  }

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
    });
  } catch (err) {
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
        SELECT p.event_type, p.event_type_custom, p.client_signed_at,
               c.name AS client_name, c.email AS client_email
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
      `, [proposalId]);
      const pi = payInfo.rows[0];
      const amountFormatted = (amountCents / 100).toFixed(2);
      const payLabel = paymentType === 'full' ? 'full payment' : paymentType === 'balance' ? 'balance payment' : 'deposit';
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
        const tpl = isCoupledSigning
          ? emailTemplates.signedAndPaidClient({ clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel })
          : emailTemplates.paymentReceivedClient({ clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel });
        await sendEmail({ to: pi.client_email, ...tpl });
      }
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const adminUrl = `${ADMIN_URL}/admin/proposals/${proposalId}`;
        const tpl = isCoupledSigning
          ? emailTemplates.signedAndPaidAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl })
          : emailTemplates.paymentReceivedAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl });
        await sendEmail({ to: adminEmail, ...tpl });
      }
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
      try {
        await dbClient.query('BEGIN');

        // Idempotency guard: Stripe retries `payment_intent.succeeded` on
        // transient delivery failures. Insert the payment row FIRST with an
        // ON CONFLICT DO NOTHING; if rowCount === 0, this is a duplicate
        // delivery — skip all state mutations and post-commit side effects
        // (emails, shift creation) so we never double-charge amount_paid
        // or spam notifications.
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
              WHERE id = $1 AND status NOT IN ('balance_paid', 'confirmed')
            `, [proposalId]);
          } else if (paymentType === 'balance') {
            await dbClient.query(`
              UPDATE proposals
              SET status = 'balance_paid',
                  amount_paid = total_price
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
                  "UPDATE proposals SET status = 'balance_paid' WHERE id = $1 AND status NOT IN ('confirmed', 'completed')",
                  [proposalId]
                );
              }
            }
          } else {
            // deposit
            await dbClient.query(`
              UPDATE proposals
              SET status = 'deposit_paid',
                  amount_paid = deposit_amount,
                  payment_type = 'deposit'
              WHERE id = $1 AND status NOT IN ('deposit_paid', 'balance_paid', 'confirmed')
            `, [proposalId]);
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
              // Idempotency: this whole block is inside `if (isFirstDelivery)`
              // above, so Stripe retries of the same intent won't re-create
              // the "Drink Plan Extras" invoice. If this block is ever lifted
              // out of that guard, add `ON CONFLICT` handling to
              // createDrinkPlanExtrasInvoice first or you'll duplicate invoices.
              //
              // Clamp metadata against the authoritative charged amount so a
              // mismatched or corrupted extras/balance split can't apportion
              // more money than was actually captured. extras takes priority
              // (it's what the client explicitly paid for); balance is what's
              // left over after extras.
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
            tags: { webhook: 'stripe', route: '/webhook' },
          });
        }
        console.error('Webhook DB error:', dbErr);
      } finally {
        dbClient.release();
      }

      // Non-blocking post-commit work — only on first delivery. Retries must
      // not re-send receipts or re-create shifts.
      if (isFirstDelivery) {
        sendPaymentNotifications(proposalId, intent.amount, paymentType);
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
      }
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    const proposalId = intent.metadata?.proposal_id;
    const paymentType = intent.metadata?.payment_type || 'deposit';

    if (proposalId) {
      try {
        await pool.query(
          "UPDATE stripe_sessions SET status = 'failed' WHERE stripe_payment_intent_id = $1",
          [intent.id]
        );
        await pool.query(
          `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
           VALUES ($1, $2, $3, $4, 'failed')`,
          [proposalId, intent.id, paymentType, intent.amount]
        );
        await pool.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'payment_failed', 'system', $2)`,
          [proposalId, JSON.stringify({ amount: intent.amount, payment_intent_id: intent.id, payment_type: paymentType, failure_message: intent.last_payment_error?.message || null })]
        );
        console.warn(`Payment FAILED (${paymentType}) for proposal ${proposalId}: ${intent.last_payment_error?.message || 'unknown'}`);

        // Notify admin of failed payment
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) {
          const payInfo = await pool.query(`
            SELECT p.event_type, p.event_type_custom, c.name AS client_name
            FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1
          `, [proposalId]);
          const pi = payInfo.rows[0];
          await sendEmail({
            to: adminEmail,
            subject: `Payment Failed — ${pi?.client_name || 'Unknown'} (${eventLabelFor(pi)})`,
            html: `<p>A ${paymentType} payment of $${(intent.amount / 100).toFixed(2)} failed for <strong>${pi?.client_name || 'Unknown'}</strong>.</p>
                   <p><strong>Reason:</strong> ${intent.last_payment_error?.message || 'Unknown error'}</p>
                   <p><a href="${ADMIN_URL}/admin/proposals/${proposalId}">View Proposal</a></p>`,
          }).catch(e => console.error('Failed payment notification email error:', e));
        }
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

        if (isFirstDelivery) {
          await dbClient.query(
            "UPDATE proposals SET status = 'deposit_paid', amount_paid = deposit_amount WHERE id = $1 AND status NOT IN ('deposit_paid', 'balance_paid', 'confirmed')",
            [proposalId]
          );
          await dbClient.query(
            "UPDATE stripe_sessions SET status = 'succeeded' WHERE stripe_payment_link_id = $1",
            [session.payment_link]
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
            tags: { webhook: 'stripe', route: '/webhook' },
          });
        }
        console.error('Webhook DB error:', dbErr);
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
      }
    }
  }

  res.json({ received: true });
}));

module.exports = router;
