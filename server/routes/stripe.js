const express = require('express');
const rateLimit = require('express-rate-limit');
const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { createEventShifts } = require('../utils/eventCreation');
const { sendEmail } = require('../utils/email');
const emailTemplates = require('../utils/emailTemplates');

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const DEPOSIT_AMOUNT = parseInt(process.env.STRIPE_DEPOSIT_AMOUNT) || 10000; // $100.00

function requireAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

// ─── Helper: get or create Stripe Customer for a proposal ────────

async function getOrCreateCustomer(proposal) {
  if (proposal.stripe_customer_id) {
    return proposal.stripe_customer_id;
  }
  const customer = await stripe.customers.create({
    email: proposal.client_email || undefined,
    name: proposal.client_name || undefined,
    metadata: { proposal_id: String(proposal.id) },
  });
  await pool.query(
    'UPDATE proposals SET stripe_customer_id = $1 WHERE id = $2',
    [customer.id, proposal.id]
  );
  return customer.id;
}

// ─── Public: create a Payment Intent for a proposal ──────────────

/** POST /api/stripe/create-intent/:token — public, token-gated */
router.post('/create-intent/:token', publicLimiter, async (req, res) => {
  try {
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

// ─── Admin: generate a reusable Stripe Payment Link ──────────────

/** POST /api/stripe/payment-link/:id — admin only */
router.post('/payment-link/:id', auth, requireAdmin, async (req, res) => {
  try {
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
router.post('/charge-balance/:id', auth, requireAdmin, async (req, res) => {
  try {
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

// ─── Stripe Webhook ───────────────────────────────────────────────

/** POST /api/stripe/webhook — raw body, Stripe signature verified */
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const intent = event.data.object;
    const proposalId = intent.metadata?.proposal_id;
    const paymentType = intent.metadata?.payment_type || 'deposit';

    if (proposalId) {
      try {
        await pool.query('BEGIN');

        // Determine new status and amount_paid based on payment type
        if (paymentType === 'full') {
          await pool.query(`
            UPDATE proposals
            SET status = 'balance_paid',
                amount_paid = total_price
            WHERE id = $1 AND status NOT IN ('balance_paid', 'confirmed')
          `, [proposalId]);
        } else if (paymentType === 'balance') {
          await pool.query(`
            UPDATE proposals
            SET status = 'balance_paid',
                amount_paid = total_price
            WHERE id = $1 AND status = 'deposit_paid'
          `, [proposalId]);
        } else {
          // deposit
          await pool.query(`
            UPDATE proposals
            SET status = 'deposit_paid',
                amount_paid = deposit_amount
            WHERE id = $1 AND status NOT IN ('deposit_paid', 'balance_paid', 'confirmed')
          `, [proposalId]);
        }

        // Save payment method ID if autopay was enrolled (card saved via setup_future_usage)
        if (intent.payment_method && paymentType === 'deposit') {
          await pool.query(`
            UPDATE proposals
            SET stripe_payment_method_id = $1
            WHERE id = $2 AND autopay_enrolled = true AND stripe_payment_method_id IS NULL
          `, [intent.payment_method, proposalId]);
        }

        await pool.query(
          "UPDATE stripe_sessions SET status = 'succeeded' WHERE stripe_payment_intent_id = $1",
          [intent.id]
        );

        // Record in proposal_payments
        await pool.query(
          `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
           VALUES ($1, $2, $3, $4, 'succeeded')`,
          [proposalId, intent.id, paymentType, intent.amount]
        );

        const action = paymentType === 'balance' ? 'balance_paid'
          : paymentType === 'full' ? 'paid_in_full'
          : 'deposit_paid';
        await pool.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, $2, 'system', $3)`,
          [proposalId, action, JSON.stringify({ amount: intent.amount, payment_intent_id: intent.id, payment_type: paymentType })]
        );

        await pool.query('COMMIT');
        console.log(`Payment (${paymentType}) received for proposal ${proposalId}: $${(intent.amount / 100).toFixed(2)}`);

        // Email notifications (non-blocking)
        try {
          const payInfo = await pool.query(`
            SELECT p.event_name, c.name AS client_name, c.email AS client_email
            FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1
          `, [proposalId]);
          const pi = payInfo.rows[0];
          const amountFormatted = (intent.amount / 100).toFixed(2);
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
          console.error('Stripe payment email failed (non-blocking):', emailErr);
        }

        // Auto-create event shift from the proposal
        try {
          const shift = await createEventShifts(proposalId);
          if (shift) console.log(`Shift #${shift.id} created for proposal ${proposalId}`);
        } catch (shiftErr) {
          console.error('Shift auto-creation failed (non-blocking):', shiftErr);
        }
      } catch (dbErr) {
        await pool.query('ROLLBACK');
        console.error('Webhook DB error:', dbErr);
      }
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const proposalId = session.metadata?.proposal_id;
    if (proposalId) {
      try {
        await pool.query('BEGIN');

        await pool.query(
          "UPDATE proposals SET status = 'deposit_paid', amount_paid = deposit_amount WHERE id = $1 AND status NOT IN ('deposit_paid', 'balance_paid', 'confirmed')",
          [proposalId]
        );
        await pool.query(
          "UPDATE stripe_sessions SET status = 'succeeded' WHERE stripe_payment_link_id = $1",
          [session.payment_link]
        );
        await pool.query(
          `INSERT INTO proposal_payments (proposal_id, stripe_payment_intent_id, payment_type, amount, status)
           VALUES ($1, $2, 'deposit', $3, 'succeeded')`,
          [proposalId, session.payment_intent, session.amount_total]
        );
        await pool.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'deposit_paid', 'system', $2)`,
          [proposalId, JSON.stringify({ amount: session.amount_total, payment_link: session.payment_link })]
        );

        await pool.query('COMMIT');
        console.log(`Deposit paid (payment link) for proposal ${proposalId}`);

        // Email notifications (non-blocking)
        try {
          const payInfo = await pool.query(`
            SELECT p.event_name, c.name AS client_name, c.email AS client_email
            FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1
          `, [proposalId]);
          const pi = payInfo.rows[0];
          const amountFormatted = ((session.amount_total || 0) / 100).toFixed(2);

          if (pi?.client_email) {
            const tpl = emailTemplates.paymentReceivedClient({ clientName: pi.client_name, eventName: pi.event_name, amount: amountFormatted, paymentType: 'deposit' });
            await sendEmail({ to: pi.client_email, ...tpl });
          }
          const adminEmail = process.env.ADMIN_EMAIL;
          if (adminEmail) {
            const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
            const adminUrl = `${clientUrl}/admin/proposals/${proposalId}`;
            const tpl = emailTemplates.paymentReceivedAdmin({ clientName: pi?.client_name, eventName: pi?.event_name, amount: amountFormatted, paymentType: 'deposit', proposalId, adminUrl });
            await sendEmail({ to: adminEmail, ...tpl });
          }
        } catch (emailErr) {
          console.error('Checkout payment email failed (non-blocking):', emailErr);
        }

        // Auto-create event shift from the proposal
        try {
          const shift = await createEventShifts(proposalId);
          if (shift) console.log(`Shift #${shift.id} created for proposal ${proposalId}`);
        } catch (shiftErr) {
          console.error('Shift auto-creation failed (non-blocking):', shiftErr);
        }
      } catch (dbErr) {
        await pool.query('ROLLBACK');
        console.error('Webhook DB error:', dbErr);
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
