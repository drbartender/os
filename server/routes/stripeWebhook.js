// Stripe webhook dispatcher, extracted verbatim from stripe.js to keep that file
// under the line-count cap. Mounted by stripe.js via router.use(require('./stripeWebhook')),
// so the final path stays /api/stripe/webhook and the raw-body middleware (server/index.js)
// still applies. The per-event handler BODIES were extracted verbatim into per-concern
// sibling modules under ./stripeWebhookHandlers/ (behind this thin dispatcher); this file
// now only does signature verification + routing. Each handler returns via res on an early
// ack; when it does not send, control falls through to the final `{ received: true }` ack
// (res.headersSent guards the difference). sendPaymentNotifications lives in
// utils/stripePaymentNotifications.js.
const express = require('express');
const Sentry = require('@sentry/node');
const asyncHandler = require('../middleware/asyncHandler');
const { getLiveClient, getTestClient, isTestMode } = require('../utils/stripeClient');

const handlePaymentIntentSucceeded = require('./stripeWebhookHandlers/paymentIntentSucceeded');
const handlePaymentIntentFailed = require('./stripeWebhookHandlers/paymentIntentFailed');
const handleCheckoutSessionCompleted = require('./stripeWebhookHandlers/checkoutSessionCompleted');
const handleChargeRefunded = require('./stripeWebhookHandlers/chargeRefunded');
const { handleDisputeFundsWithdrawn, handleDisputeFundsReinstated } = require('./stripeWebhookHandlers/disputes');
const handlePayout = require('./stripeWebhookHandlers/payout');

const router = express.Router();

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

  // Live-mode gate (audit 2026-07-13). The verifier list above deliberately tries
  // BOTH the live and test webhook secrets, so an event straddling a
  // STRIPE_TEST_MODE_UNTIL cutover still verifies. But that also means a
  // signature-verified *test-mode* event (livemode:false) reaches the credit/tip/
  // refund handlers whenever the test secret is configured — which it stays after a
  // cutover. OUTSIDE an active test window a zero-dollar test event must never move
  // real money state (credit a proposal, accrue a tip/payroll, reconcile a refund).
  // So: only ACT on a test-mode event while a test window is actually active
  // (isTestMode()); otherwise ack and drop. This is the single dispatch-level root
  // fix — it covers every current and future handler. payout.js additionally keeps
  // its own always-live-only guard (the payout mirror is live-only even in-window).
  // Guard on `=== false` (not `!livemode`) so a fixture/malformed event with no
  // livemode field is treated as live and processed, matching payout.js.
  if (event.livemode === false && !isTestMode()) {
    return res.json({ received: true, skipped: 'test_mode' });
  }

  if (event.type === 'payment_intent.succeeded') {
    await handlePaymentIntentSucceeded(event);
    if (res.headersSent) return;
  }

  // payment_failed is the one branch with no natural per-row idempotency key (a PI can
  // fail multiple distinct times), so its handler dedupes redeliveries on the Stripe
  // event id via the webhook_events ledger — the lone event-level gate in this file.
  if (event.type === 'payment_intent.payment_failed') {
    await handlePaymentIntentFailed(event, res);
    if (res.headersSent) return;
  }

  if (event.type === 'checkout.session.completed') {
    await handleCheckoutSessionCompleted(event, res);
    if (res.headersSent) return;
  }

  if (event.type === 'charge.refunded') {
    await handleChargeRefunded(event);
    if (res.headersSent) return;
  }

  // Dispute/refund idempotency lives in the helpers, not in an event-level webhook_events
  // gate (audit A08, confirmed). clawbackTipByPaymentIntent moves only the delta beyond
  // tips.refunded_amount_cents (a same-cumulative Stripe redelivery is delta=0 = no-op), and
  // notifyDisputeWon below gates on tips.dispute_won_at (redelivery returns early). So an
  // at-least-once redelivery of charge.refunded / dispute.* cannot double-clawback or
  // double-notify; no extra guard is needed here.
  if (event.type === 'charge.dispute.funds_withdrawn') {
    await handleDisputeFundsWithdrawn(event);
    if (res.headersSent) return;
  }

  if (event.type === 'charge.dispute.funds_reinstated') {
    await handleDisputeFundsReinstated(event, res);
    if (res.headersSent) return;
  }

  // Stripe payout tracking (read-side mirror; spec 2026-07-01). No event-level
  // dedupe here by design — idempotency is the syncPayout upsert on stripe_payout_id
  // plus the atomic alerted_at claim, matching this file's per-branch ON CONFLICT
  // convention. Test-mode events are skipped so the mirror stays live-only.
  if (event.type === 'payout.paid' || event.type === 'payout.failed') {
    await handlePayout(event, res, stripeForEvent);
    if (res.headersSent) return;
  }

  res.json({ received: true });
}));

module.exports = router;
