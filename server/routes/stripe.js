const express = require('express');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth, adminOnly, requireAdminOrManager } = require('../middleware/auth');
const { publicLimiter, publicReadLimiter } = require('../middleware/rateLimiters');
const { getBookingWindow } = require('../utils/bookingWindow');
const { computeExtrasBreakdown } = require('../utils/drinkPlanExtras');
const asyncHandler = require('../middleware/asyncHandler');
const { AppError, ValidationError, ConflictError, NotFoundError, ExternalServiceError, PaymentError } = require('../utils/errors');
const { PUBLIC_SITE_URL } = require('../utils/urls');
const { requireUuidToken } = require('../utils/tokens');

const router = express.Router();

const {
  getStripe,
  getPublishableKey,
} = require('../utils/stripeClient');

// Shared helpers extracted to a sibling module (also used by the create-intent
// sub-router) so create-intent's gratuity logic doesn't grow this over-cap file.
const { DEPOSIT_AMOUNT, eventLabelFor, getOrCreateCustomer } = require('../utils/stripeRouteHelpers');
const { recordBalanceIntent, priorBalanceChargeSettling } = require('../utils/autopayDurableCharge');

// create-intent lives in its own module (extracted in the gratuity split).
router.use(require('./stripeCreateIntent'));

/** GET /api/stripe/publishable-key — returns the active publishable key */
router.get('/publishable-key', publicReadLimiter, (_req, res) => {
  res.json({ key: getPublishableKey() || null });
});

// ─── Public: create a Payment Intent for drink plan extras ──────

/** POST /api/stripe/create-drink-plan-intent/:token — public, token-gated (drink plan token) */
router.post('/create-drink-plan-intent/:token', requireUuidToken('token', 'This drink plan is no longer available'), publicLimiter, asyncHandler(async (req, res) => {
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

  // Extras amount via the shared helper — the SAME math the submit handler uses
  // to build the "Drink Plan Extras" invoice, so the invoice amount_due can
  // never drift from what Stripe charges. numBars is the client's current count
  // (the first-vs-additional bar fee is priced pre-submit here, exactly as the
  // invoice prices it at submit).
  const bd = await computeExtrasBreakdown(
    { selections, guestCount: data.guest_count, pricingSnapshot: data.pricing_snapshot, numBars: data.num_bars },
    pool
  );
  const extrasAmount = bd.totalCents / 100;

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
  const extrasCents = bd.totalCents;
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
    'SELECT id, token, event_type, event_type_custom, event_date, event_start_time, total_price FROM proposals WHERE id = $1',
    [req.params.id]
  );
  if (!result.rows[0]) throw new NotFoundError('Proposal not found');

  const proposal = result.rows[0];
  const eventLabel = eventLabelFor(proposal);

  // Respect the same booking-window policy the client-facing flow enforces:
  // inside the 14-day window full payment is the only option (create-intent
  // rejects a deposit there), so the admin link must charge the FULL total. A
  // $100 deposit link would let a last-minute booking underpay and strand a
  // past-due balance with no card on file — the exact money-integrity hole the
  // full-payment gate exists to close.
  const bookingWindow = getBookingWindow({
    eventDate: proposal.event_date,
    eventStartTime: proposal.event_start_time,
  });
  const isFullPay = bookingWindow.fullPaymentRequired;
  const amount = isFullPay ? Math.round(Number(proposal.total_price) * 100) : DEPOSIT_AMOUNT;
  const linkPaymentType = isFullPay ? 'full' : 'deposit';
  const productName = isFullPay ? `Full Payment — ${eventLabel}` : `Event Deposit — ${eventLabel}`;

  // If the booking window shifted since a prior link was generated (e.g. a
  // deposit link created when the event was >14d out, now that we're inside the
  // full-payment window), any pending link for a DIFFERENT amount is stale.
  // Leaving it active in Stripe would let a client click it and underpay,
  // re-opening the money-integrity hole the full-payment gate exists to close.
  // Deactivate those before issuing the correct link. Best-effort: a Stripe
  // failure here must not block the new link.
  const staleLinks = await pool.query(
    `SELECT stripe_payment_link_id FROM stripe_sessions
     WHERE proposal_id = $1 AND stripe_payment_link_id IS NOT NULL
       AND amount <> $2 AND status = 'pending'`,
    [proposal.id, amount]
  );
  for (const row of staleLinks.rows) {
    try {
      await stripe.paymentLinks.update(row.stripe_payment_link_id, { active: false });
    } catch (e) {
      console.error('Failed to deactivate stale payment link', row.stripe_payment_link_id, e.message);
    }
  }

  // Idempotency: if a pending payment-link already exists for this proposal+amount, reuse it
  // instead of creating a second Stripe price+link. Avoids duplicate charges when the admin
  // clicks Generate twice.
  const existingLink = await pool.query(
    `SELECT stripe_payment_link_id FROM stripe_sessions
     WHERE proposal_id = $1 AND stripe_payment_link_id IS NOT NULL
       AND amount = $2 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [proposal.id, amount]
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
      unit_amount: amount,
      product_data: { name: productName },
    });

    paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { proposal_id: String(proposal.id), payment_type: linkPaymentType },
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
    [proposal.id, paymentLink.id, amount]
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
        OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '72 hours')
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

  // F1(b): stale re-claim double-charge guard (mirrors the scheduler). If a prior
  // balance intent for this proposal is already succeeded/processing at
  // Stripe (webhook still down), do NOT fire a second charge — surface 409 and
  // leave the claim in_progress for the webhook/reconcile. On a first charge no
  // prior balance row exists, so this no-ops.
  const guard = await priorBalanceChargeSettling({ proposalId: proposal.id, stripe });
  if (guard.skip) {
    if (guard.reason === 'retrieve_failed') {
      // Couldn't reach Stripe to confirm the prior intent's status (transient). Do
      // NOT report "settling" (misleading) and do NOT hold the claim for 72h — release
      // it so the admin can retry immediately. Still money-safe: the guard re-queries
      // Stripe on the next attempt before any charge, so a genuinely-settling prior
      // intent is caught then. (The scheduler path instead leaves the claim in_progress
      // and self-heals via the 72h TTL; the admin path releases so a click isn't
      // locked out for three days behind a network blip.)
      await pool.query(`UPDATE proposals SET autopay_status = NULL WHERE id = $1`, [proposal.id]);
      throw new ExternalServiceError('Stripe', new Error('prior-intent verify failed'), 'Could not verify the prior charge with Stripe. Please try again shortly.');
    }
    // A prior balance intent is genuinely succeeded/processing — leave the claim
    // in_progress for the webhook to reconcile, and tell the admin.
    throw new ConflictError('A prior balance charge is already settling for this proposal', 'CHARGE_SETTLING');
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

  // F1(a): durable charge record — persist immediately, independent of the
  // webhook (mirrors the scheduler). Idempotent via ON CONFLICT DO NOTHING.
  await recordBalanceIntent({ proposalId: proposal.id, intentId: intent.id, amountCents: balanceCents });

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
router.post('/create-intent-for-invoice/:token', requireUuidToken('token', 'This invoice is no longer available'), publicLimiter, asyncHandler(async (req, res) => {
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
// Webhook event handlers extracted to a sibling module (see stripeWebhook.js) so this
// file stays under the size cap.
router.use(require('./stripeWebhook'));

module.exports = router;
