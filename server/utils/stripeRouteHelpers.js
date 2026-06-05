'use strict';
/**
 * Stripe route helpers extracted from server/routes/stripe.js so the
 * create-intent sub-router (server/routes/stripeCreateIntent.js) can share them
 * without growing the over-cap stripe.js. Pure move — no behavior change.
 */
const { pool } = require('../db');
const { getStripe } = require('./stripeClient');
const { getEventTypeLabel } = require('./eventTypes');

const DEPOSIT_AMOUNT = parseInt(process.env.STRIPE_DEPOSIT_AMOUNT, 10) || 10000; // $100.00

function eventLabelFor(row) {
  return getEventTypeLabel({ event_type: row?.event_type, event_type_custom: row?.event_type_custom });
}

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

module.exports = { DEPOSIT_AMOUNT, eventLabelFor, getOrCreateCustomer };
