const express = require('express');
const { pool } = require('../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const { publicLimiter } = require('../middleware/rateLimiters');
const { createEventShifts } = require('../utils/eventCreation');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');
const { calculateSyrupCost } = require('../utils/pricingEngine');
const { lockInvoice, createBalanceInvoice } = require('../utils/invoiceHelpers');

const router = express.Router();

const DEPOSIT_AMOUNT = parseInt(process.env.STRIPE_DEPOSIT_AMOUNT) || 10000; // $100.00

// ─── Stripe mode toggle ─────────────────────────────────────────────
// When STRIPE_TEST_MODE_UNTIL (ISO date) is in the future, every Stripe
// call uses the *_TEST credentials. Once the cutoff passes, the next
// request flips back to live — no redeploy required (isTestMode() is
// evaluated per request, not cached at boot).

const stripeLive = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const stripeTest = process.env.STRIPE_SECRET_KEY_TEST ? require('stripe')(process.env.STRIPE_SECRET_KEY_TEST) : null;

function isTestMode() {
  const until = process.env.STRIPE_TEST_MODE_UNTIL;
  if (!until) return false;
  const t = new Date(until).getTime();
  return Number.isFinite(t) && Date.now() < t;
}

function getStripe() {
  return isTestMode() && stripeTest ? stripeTest : stripeLive;
}

function getWebhookSecret() {
  return isTestMode()
    ? process.env.STRIPE_WEBHOOK_SECRET_TEST
    : process.env.STRIPE_WEBHOOK_SECRET;
}

function getPublishableKey() {
  return isTestMode()
    ? process.env.STRIPE_PUBLISHABLE_KEY_TEST
    : process.env.STRIPE_PUBLISHABLE_KEY;
}

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
router.post('/create-intent/:token', publicLimiter, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

    const { payment_option = 'deposit', autopay = false } = req.body;

    const result = await pool.query(`
      SELECT p.id, p.status, p.event_name, p.total_price, p.event_date,
             p.stripe_customer_id, p.deposit_amount,
             c.email AS client_email, c.name AS client_name
      FROM proposals p
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.token = $1
    `, [req.params.token]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const proposal = result.rows[0];
    if (['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status)) {
      return res.status(400).json({ error: 'Payment has already been made.' });
    }
    if (!['sent', 'viewed', 'accepted'].includes(proposal.status)) {
      return res.status(400).json({ error: 'Proposal is not available for payment.' });
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
        ? `Full Payment — ${proposal.event_name || 'Dr. Bartender Event'}`
        : `Event Deposit — ${proposal.event_name || 'Dr. Bartender Event'}`,
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

    const paymentIntent = await stripe.paymentIntents.create(intentParams);

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
  } catch (err) {
    console.error('Stripe create-intent error:', err);
    res.status(500).json({ error: 'Failed to create payment intent.' });
  }
});

// ─── Public: create a Payment Intent for drink plan extras ──────

/** POST /api/stripe/create-drink-plan-intent/:token — public, token-gated (drink plan token) */
router.post('/create-drink-plan-intent/:token', publicLimiter, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

    const { selections } = req.body;
    if (!selections) return res.status(400).json({ error: 'Selections required.' });

    // Look up drink plan + proposal
    const planRes = await pool.query(`
      SELECT dp.id AS plan_id, dp.token AS plan_token, dp.status AS plan_status,
             p.id AS proposal_id, p.total_price, p.amount_paid, p.event_date,
             p.balance_due_date, p.guest_count, p.num_bars, p.stripe_customer_id,
             p.event_name, p.pricing_snapshot,
             c.email AS client_email, c.name AS client_name
      FROM drink_plans dp
      JOIN proposals p ON p.id = dp.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE dp.token = $1
    `, [req.params.token]);

    if (!planRes.rows[0]) return res.status(404).json({ error: 'Plan not found.' });
    const data = planRes.rows[0];

    if (!data.proposal_id) return res.status(400).json({ error: 'No linked proposal.' });

    // Calculate extras server-side
    const addOns = selections.addOns || {};
    const addonSlugs = Object.keys(addOns).filter(slug => addOns[slug]?.enabled);
    const addBarRental = selections.logistics?.addBarRental === true;

    // Look up addon pricing
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

    // Bar rental cost
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

    // Syrup cost (new syrups only, excluding self-provided and proposal syrups)
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

    if (extrasAmount <= 0) {
      return res.json({ noPaymentNeeded: true, extrasAmount: 0 });
    }

    // Determine payment scenario based on balance_due_date
    const now = new Date();
    let balanceDueDate = data.balance_due_date;
    if (!balanceDueDate && data.event_date) {
      const d = new Date(data.event_date);
      d.setDate(d.getDate() - 14);
      balanceDueDate = d;
    }
    const isPastDue = balanceDueDate ? now > new Date(balanceDueDate) : false;
    const currentBalance = Number(data.total_price || 0) - Number(data.amount_paid || 0);

    let paymentScenario, totalCharge, pastDueAmount = 0;
    if (isPastDue && currentBalance > 0) {
      // Past due with outstanding balance — charge extras + balance
      paymentScenario = 'extras_plus_balance';
      pastDueAmount = currentBalance;
      totalCharge = extrasAmount + currentBalance;
    } else if (isPastDue) {
      // Past due but balance already paid — charge extras only, required
      paymentScenario = 'extras_required';
      totalCharge = extrasAmount;
    } else {
      // Not past due — client can choose
      paymentScenario = 'extras_optional';
      totalCharge = extrasAmount;
    }

    // Get or create Stripe customer
    const customerId = await getOrCreateCustomer({
      id: data.proposal_id,
      stripe_customer_id: data.stripe_customer_id,
      client_email: data.client_email,
      client_name: data.client_name,
    });

    const amountCents = Math.round(totalCharge * 100);
    const paymentType = paymentScenario === 'extras_plus_balance'
      ? 'drink_plan_with_balance'
      : 'drink_plan_extras';

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customerId,
      description: `Drink Plan Extras — ${data.event_name || 'Dr. Bartender Event'}`,
      receipt_email: data.client_email || undefined,
      metadata: {
        proposal_id: String(data.proposal_id),
        drink_plan_id: String(data.plan_id),
        payment_type: paymentType,
      },
    });

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
    });
  } catch (err) {
    console.error('Drink plan payment intent error:', err);
    res.status(500).json({ error: 'Failed to prepare payment.' });
  }
});

// ─── Admin: generate a reusable Stripe Payment Link ──────────────

/** POST /api/stripe/payment-link/:id — admin only */
router.post('/payment-link/:id', auth, requireAdminOrManager, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

    const result = await pool.query(
      'SELECT id, event_name FROM proposals WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const proposal = result.rows[0];
    const eventName = proposal.event_name || 'Dr. Bartender Event';

    // Create a one-time price
    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: DEPOSIT_AMOUNT,
      product_data: { name: `Event Deposit — ${eventName}` },
    });

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata: { proposal_id: String(proposal.id) },
      after_completion: { type: 'redirect', redirect: { url: `${process.env.CLIENT_URL}/proposal/${req.query.token || ''}?paid=true` } },
    });

    // Store link reference
    await pool.query(
      `INSERT INTO stripe_sessions (proposal_id, stripe_payment_link_id, amount, status)
       VALUES ($1, $2, $3, 'pending')`,
      [proposal.id, paymentLink.id, DEPOSIT_AMOUNT]
    );

    res.json({ url: paymentLink.url });
  } catch (err) {
    console.error('Stripe payment-link error:', err);
    res.status(500).json({ error: 'Failed to create payment link.' });
  }
});

// ─── Admin: manually charge autopay balance ──────────────────────

/** POST /api/stripe/charge-balance/:id — admin only */
router.post('/charge-balance/:id', auth, requireAdminOrManager, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

    const result = await pool.query(`
      SELECT id, total_price, amount_paid, stripe_customer_id, stripe_payment_method_id,
             autopay_enrolled, status, event_name
      FROM proposals WHERE id = $1
    `, [req.params.id]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const proposal = result.rows[0];

    if (proposal.status !== 'deposit_paid') {
      return res.status(400).json({ error: 'Proposal must be in deposit_paid status.' });
    }
    if (!proposal.stripe_customer_id || !proposal.stripe_payment_method_id) {
      return res.status(400).json({ error: 'No saved payment method for this proposal.' });
    }

    const balanceCents = Math.round((Number(proposal.total_price) - Number(proposal.amount_paid)) * 100);
    if (balanceCents <= 0) {
      return res.status(400).json({ error: 'No remaining balance to charge.' });
    }

    const intent = await stripe.paymentIntents.create({
      amount: balanceCents,
      currency: 'usd',
      customer: proposal.stripe_customer_id,
      payment_method: proposal.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      description: `Balance Payment — ${proposal.event_name || 'Dr. Bartender Event'}`,
      metadata: {
        proposal_id: String(proposal.id),
        payment_type: 'balance',
      },
    });

    // Webhook will handle status update on success
    res.json({ status: intent.status, amount: balanceCents });
  } catch (err) {
    console.error('Stripe charge-balance error:', err);
    const message = err.type === 'StripeCardError'
      ? `Card declined: ${err.message}`
      : 'Failed to charge balance.';
    res.status(400).json({ error: message });
  }
});

// ─── Public: create a Payment Intent for an invoice ─────────────

/** POST /api/stripe/create-intent-for-invoice/:token — public, token-gated */
router.post('/create-intent-for-invoice/:token', publicLimiter, async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Payments not configured.' });

    const invRes = await pool.query(`
      SELECT i.id AS invoice_id, i.amount_due, i.amount_paid, i.status AS invoice_status,
             p.id AS proposal_id, p.event_name, p.stripe_customer_id,
             c.email AS client_email, c.name AS client_name
      FROM invoices i
      JOIN proposals p ON p.id = i.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE i.token = $1 AND i.status IN ('sent', 'partially_paid')
    `, [req.params.token]);

    if (!invRes.rows[0]) return res.status(404).json({ error: 'Invoice not found or already paid.' });

    const inv = invRes.rows[0];
    const balanceCents = inv.amount_due - inv.amount_paid;
    if (balanceCents <= 0) {
      return res.status(400).json({ error: 'Invoice is already fully paid.' });
    }

    const customerId = await getOrCreateCustomer({
      id: inv.proposal_id,
      stripe_customer_id: inv.stripe_customer_id,
      client_email: inv.client_email,
      client_name: inv.client_name,
    });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: balanceCents,
      currency: 'usd',
      customer: customerId,
      description: `Invoice ${inv.invoice_id} — ${inv.client_name || 'Dr. Bartender'}`,
      receipt_email: inv.client_email || undefined,
      metadata: {
        proposal_id: String(inv.proposal_id),
        invoice_id: String(inv.invoice_id),
        payment_type: 'invoice',
      },
    });

    await pool.query(
      `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
      [inv.proposal_id, paymentIntent.id, balanceCents]
    );

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error('Stripe invoice payment intent error:', err);
    res.status(500).json({ error: 'Failed to create payment intent.' });
  }
});

// ─── Stripe Webhook ───────────────────────────────────────────────

/** POST /api/stripe/webhook — raw body, Stripe signature verified */
router.post('/webhook', async (req, res) => {
  // Try BOTH live and test secrets so events that span a test/live cutoff
  // (e.g., Stripe retrying a `payment_intent.succeeded` as the cutoff passes)
  // are still verified and processed. Whichever client verified the event is
  // the one whose API keypair matches the event's mode.
  const sig = req.headers['stripe-signature'];
  const verifiers = [
    { secret: process.env.STRIPE_WEBHOOK_SECRET, client: stripeLive },
    { secret: process.env.STRIPE_WEBHOOK_SECRET_TEST, client: stripeTest },
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
    return res.status(400).send('Webhook signature verification failed');
  }
  // `stripeForEvent` is intentionally available for any downstream Stripe API
  // calls inside this handler so we use the keypair matching the event's mode.
  void stripeForEvent;

  // ── Helper: send payment notification emails (non-blocking) ────
  async function sendPaymentNotifications(proposalId, amountCents, paymentType) {
    try {
      const payInfo = await pool.query(`
        SELECT p.event_name, c.name AS client_name, c.email AS client_email
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
      `, [proposalId]);
      const pi = payInfo.rows[0];
      const amountFormatted = (amountCents / 100).toFixed(2);
      const payLabel = paymentType === 'full' ? 'full payment' : paymentType === 'balance' ? 'balance payment' : 'deposit';

      if (pi?.client_email) {
        const tpl = emailTemplates.paymentReceivedClient({ clientName: pi.client_name, eventName: pi.event_name, amount: amountFormatted, paymentType: payLabel });
        await sendEmail({ to: pi.client_email, ...tpl });
      }
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
        const adminUrl = `${clientUrl}/admin/proposals/${proposalId}`;
        const tpl = emailTemplates.paymentReceivedAdmin({ clientName: pi?.client_name, eventName: pi?.event_name, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl });
        await sendEmail({ to: adminEmail, ...tpl });
      }
    } catch (emailErr) {
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
                  amount_paid = total_price
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
                  amount_paid = deposit_amount
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
          if (invoiceId) {
            // Payment was made through an invoice — link and lock
            const paymentRow = await dbClient.query(
              'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
              [intent.id, 'succeeded']
            );
            if (paymentRow.rows[0]) {
              await dbClient.query(
                'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
                [invoiceId, paymentRow.rows[0].id, intent.amount]
              );
              const invUpdate = await dbClient.query(
                'UPDATE invoices SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING amount_due, amount_paid',
                [intent.amount, invoiceId]
              );
              if (invUpdate.rows[0]) {
                const inv = invUpdate.rows[0];
                const newStatus = inv.amount_paid >= inv.amount_due ? 'paid' : 'partially_paid';
                await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [newStatus, invoiceId]);
              }
              await lockInvoice(invoiceId, dbClient);
            }
          } else {
            // Legacy payment (not through invoice) — try to find and link the right invoice
            const openInvoice = await dbClient.query(
              "SELECT id FROM invoices WHERE proposal_id = $1 AND status IN ('sent', 'partially_paid') ORDER BY created_at ASC LIMIT 1",
              [proposalId]
            );
            if (openInvoice.rows[0]) {
              const paymentRow = await dbClient.query(
                'SELECT id FROM proposal_payments WHERE stripe_payment_intent_id = $1 AND status = $2 LIMIT 1',
                [intent.id, 'succeeded']
              );
              if (paymentRow.rows[0]) {
                await dbClient.query(
                  'INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, $3)',
                  [openInvoice.rows[0].id, paymentRow.rows[0].id, intent.amount]
                );
                const invUpdate = await dbClient.query(
                  'UPDATE invoices SET amount_paid = amount_paid + $1 WHERE id = $2 RETURNING amount_due, amount_paid',
                  [intent.amount, openInvoice.rows[0].id]
                );
                if (invUpdate.rows[0]) {
                  const inv = invUpdate.rows[0];
                  const newStatus = inv.amount_paid >= inv.amount_due ? 'paid' : 'partially_paid';
                  await dbClient.query('UPDATE invoices SET status = $1 WHERE id = $2', [newStatus, openInvoice.rows[0].id]);
                }
                await lockInvoice(openInvoice.rows[0].id, dbClient);
              }
            }
          }

          // If a deposit was just paid, create the balance invoice
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
        await dbClient.query('ROLLBACK');
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
            SELECT p.event_name, c.name AS client_name
            FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1
          `, [proposalId]);
          const pi = payInfo.rows[0];
          const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
          await sendEmail({
            to: adminEmail,
            subject: `Payment Failed — ${pi?.client_name || 'Unknown'} (${pi?.event_name || 'Event'})`,
            html: `<p>A ${paymentType} payment of $${(intent.amount / 100).toFixed(2)} failed for <strong>${pi?.client_name || 'Unknown'}</strong>.</p>
                   <p><strong>Reason:</strong> ${intent.last_payment_error?.message || 'Unknown error'}</p>
                   <p><a href="${clientUrl}/admin/proposals/${proposalId}">View Proposal</a></p>`,
          }).catch(e => console.error('Failed payment notification email error:', e));
        }
      } catch (err) {
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
        } else {
          console.log(`Webhook: duplicate checkout.session.completed for intent ${session.payment_intent} — skipping`);
        }

        await dbClient.query('COMMIT');
        if (isFirstDelivery) {
          console.log(`Deposit paid (payment link) for proposal ${proposalId}`);
        }
      } catch (dbErr) {
        await dbClient.query('ROLLBACK');
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
          console.error('Shift auto-creation failed (non-blocking):', shiftErr);
        }
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
