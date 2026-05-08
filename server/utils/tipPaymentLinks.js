// server/utils/tipPaymentLinks.js
const { getStripe } = require('./stripeClient');
const { PUBLIC_SITE_URL } = require('./urls');

const MIN_TIP_CENTS = 100; // $1 minimum

/**
 * Create a Stripe Payment Link tagged to a specific bartender.
 * Returns { url, id }.
 *
 * Stripe Payment Links do not support `price_data.custom_unit_amount` inline —
 * a Price object must be created first with `custom_unit_amount`, then referenced
 * by ID in the Payment Link's line_items.
 *
 * `payment_intent_data.metadata` is mirrored because Payment Link
 * metadata does NOT propagate to the resulting PaymentIntent automatically.
 */
async function createTipPaymentLink({ userId, displayName, token }) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe client unavailable (test-mode misconfig?)');
  if (!token) throw new Error('tip_page_token required');

  const safeName = String(displayName || 'your bartender').slice(0, 80);

  // Step 1: create a one-off Price with customer-entered amount
  const price = await stripe.prices.create({
    currency: 'usd',
    custom_unit_amount: { enabled: true, minimum: MIN_TIP_CENTS },
    product_data: { name: `Tip for ${safeName}` },
  });

  // Step 2: create the Payment Link referencing that Price
  const link = await stripe.paymentLinks.create({
    line_items: [{ price: price.id, quantity: 1 }],
    // Pin synchronous methods only. The tips webhook records on
    // checkout.session.completed and assumes the funds are settled — async
    // methods (ACH, Klarna, etc.) can complete the session before settlement
    // and would create a tip row that isn't real money yet, with no rollback
    // path on a downstream failure. Card covers the apothecary-tip-card use
    // case (which silently includes Apple Pay + Google Pay via Stripe).
    payment_method_types: ['card'],
    metadata: {
      kind: 'tip',
      bartender_user_id: String(userId),
      tip_page_token: token,
    },
    payment_intent_data: {
      metadata: {
        kind: 'tip',
        bartender_user_id: String(userId),
        tip_page_token: token,
      },
      description: `Tip for ${safeName} via DRB tip page`,
    },
    after_completion: {
      type: 'redirect',
      redirect: {
        // Stripe Payment Links only support {CHECKOUT_SESSION_ID} as a substitution
        // variable in `after_completion.redirect.url`. {CHECKOUT_SESSION_AMOUNT_TOTAL}
        // is NOT a recognized placeholder and ships to the customer literally — so
        // we don't put it here. The thanks page reads tip details from the DB by
        // session_id once the webhook has landed.
        url: `${PUBLIC_SITE_URL}/tip/${token}/thanks`,
      },
    },
  });

  return { url: link.url, id: link.id };
}

async function deactivateTipPaymentLink(linkId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe client unavailable');
  if (!linkId) return null;
  return stripe.paymentLinks.update(linkId, { active: false });
}

async function activateTipPaymentLink(linkId) {
  const stripe = getStripe();
  if (!stripe) throw new Error('Stripe client unavailable');
  if (!linkId) return null;
  return stripe.paymentLinks.update(linkId, { active: true });
}

module.exports = {
  createTipPaymentLink,
  deactivateTipPaymentLink,
  activateTipPaymentLink,
};
