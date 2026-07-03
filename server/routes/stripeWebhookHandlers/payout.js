// stripeWebhook concern: payout.paid / payout.failed. Extracted verbatim from
// stripeWebhook.js — the read-side payout mirror sync (live-only), using the
// event-verified Stripe client (stripeForEvent) passed in from the dispatcher.
// Always returns via res (early ack).
const Sentry = require('@sentry/node');

module.exports = async function handlePayout(event, res, stripeForEvent) {
    if (event.livemode === false) return res.json({ received: true, skipped: 'test_mode' });
    const payout = event.data.object;
    try {
      const payoutSync = require('../../utils/stripePayoutSync');
      // M10: pass the event-verified client so a LIVE payout's line-sync uses the
      // LIVE keypair. Without it, syncPayout resolves getStripe(), which returns the
      // TEST client during a STRIPE_TEST_MODE_UNTIL window and errors the line fetch
      // for a live payout (healed only by a later sweep). stripeForEvent is the client
      // whose secret verified this event, so its mode matches the payout's.
      await payoutSync.syncPayout(payout, { stripe: stripeForEvent });
      if (event.type === 'payout.failed') {
        await payoutSync.alertFailedPayout(payout.id);
      }
    } catch (err) {
      // Catch-and-ack (file convention, cf. funds_reinstated): the nightly sweep
      // heals a failed sync; a 500 here would retry-storm without adding safety.
      Sentry.captureException(err, { tags: { webhook: 'stripe_payout' } });
    }
    return res.json({ received: true });
};
