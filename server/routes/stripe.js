const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');
const { auth } = require('../middleware/auth');

const router = express.Router();

const DEPOSIT_AMOUNT = parseInt(process.env.STRIPE_DEPOSIT_AMOUNT) || 10000; // $100.00

function requireAdmin(req, res, next) {
  if (req.user.role === 'admin' || req.user.role === 'manager') return next();
  return res.status(403).json({ error: 'Admin access required.' });
}

// ─── Public: create a Payment Intent for a proposal deposit ──────

/** POST /api/stripe/create-intent/:token — public, token-gated */
router.post('/create-intent/:token', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.status, p.event_name, c.email AS client_email, c.name AS client_name
      FROM proposals p
      LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.token = $1
    `, [req.params.token]);

    if (!result.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });

    const proposal = result.rows[0];
    if (proposal.status === 'deposit_paid' || proposal.status === 'confirmed') {
      return res.status(400).json({ error: 'Deposit has already been paid.' });
    }
    if (proposal.status !== 'accepted') {
      return res.status(400).json({ error: 'Proposal must be accepted before payment.' });
    }

    // Reuse existing pending intent if one exists
    const existing = await pool.query(
      "SELECT stripe_payment_intent_id FROM stripe_sessions WHERE proposal_id = $1 AND status = 'pending'",
      [proposal.id]
    );
    if (existing.rows[0]) {
      const intent = await stripe.paymentIntents.retrieve(existing.rows[0].stripe_payment_intent_id);
      if (intent.status === 'requires_payment_method' || intent.status === 'requires_confirmation') {
        return res.json({ clientSecret: intent.client_secret });
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: DEPOSIT_AMOUNT,
      currency: 'usd',
      description: `Event Deposit — ${proposal.event_name || 'Dr. Bartender Event'}`,
      receipt_email: proposal.client_email || undefined,
      metadata: { proposal_id: String(proposal.id) },
    });

    await pool.query(
      `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
      [proposal.id, paymentIntent.id, DEPOSIT_AMOUNT]
    );

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
    if (proposalId) {
      try {
        await pool.query(
          "UPDATE proposals SET status = 'deposit_paid' WHERE id = $1 AND status NOT IN ('deposit_paid', 'confirmed')",
          [proposalId]
        );
        await pool.query(
          "UPDATE stripe_sessions SET status = 'succeeded' WHERE stripe_payment_intent_id = $1",
          [intent.id]
        );
        await pool.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'deposit_paid', 'system', $2)`,
          [proposalId, JSON.stringify({ amount: intent.amount, payment_intent_id: intent.id })]
        );
        console.log(`Deposit paid for proposal ${proposalId}`);
      } catch (dbErr) {
        console.error('Webhook DB error:', dbErr);
      }
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const proposalId = session.metadata?.proposal_id;
    if (proposalId) {
      try {
        await pool.query(
          "UPDATE proposals SET status = 'deposit_paid' WHERE id = $1 AND status NOT IN ('deposit_paid', 'confirmed')",
          [proposalId]
        );
        await pool.query(
          "UPDATE stripe_sessions SET status = 'succeeded' WHERE stripe_payment_link_id = $1",
          [session.payment_link]
        );
        await pool.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'deposit_paid', 'system', $2)`,
          [proposalId, JSON.stringify({ amount: session.amount_total, payment_link: session.payment_link })]
        );
        console.log(`Deposit paid (payment link) for proposal ${proposalId}`);
      } catch (dbErr) {
        console.error('Webhook DB error:', dbErr);
      }
    }
  }

  res.json({ received: true });
});

module.exports = router;
