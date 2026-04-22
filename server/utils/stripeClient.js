/**
 * Central Stripe client factory with test-mode toggle.
 *
 * When STRIPE_TEST_MODE_UNTIL (ISO date) is in the future, every call
 * uses the *_TEST credentials. Once the cutoff passes, the next call
 * flips back to live — no redeploy required (isTestMode() is evaluated
 * per invocation, not cached at boot).
 *
 * Fail-closed semantics: if test mode is active but STRIPE_SECRET_KEY_TEST
 * is missing, getStripe() returns null rather than falling through to the
 * live client. Callers already handle the null case (autopay no-ops,
 * public routes throw 503), so this prevents the misconfigured-test-mode
 * → silent live-charge failure mode.
 */

const stripeLive = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;
const stripeTest = process.env.STRIPE_SECRET_KEY_TEST
  ? require('stripe')(process.env.STRIPE_SECRET_KEY_TEST)
  : null;

function isTestMode() {
  const until = process.env.STRIPE_TEST_MODE_UNTIL;
  if (!until) return false;
  const t = new Date(until).getTime();
  return Number.isFinite(t) && Date.now() < t;
}

function getStripe() {
  if (isTestMode()) {
    if (!stripeTest) {
      console.error('[Stripe] STRIPE_TEST_MODE_UNTIL is active but STRIPE_SECRET_KEY_TEST is missing — refusing to fall through to live credentials');
      return null;
    }
    return stripeTest;
  }
  return stripeLive;
}

function getWebhookSecret() {
  if (isTestMode()) {
    return process.env.STRIPE_WEBHOOK_SECRET_TEST || null;
  }
  return process.env.STRIPE_WEBHOOK_SECRET || null;
}

function getPublishableKey() {
  if (isTestMode()) {
    return process.env.STRIPE_PUBLISHABLE_KEY_TEST || null;
  }
  return process.env.STRIPE_PUBLISHABLE_KEY || null;
}

// Exposed for the webhook handler, which must verify events against BOTH
// live and test secrets (events retried across a test/live cutoff could
// land in either pairing).
function getLiveClient() { return stripeLive; }
function getTestClient() { return stripeTest; }

module.exports = {
  getStripe,
  getWebhookSecret,
  getPublishableKey,
  isTestMode,
  getLiveClient,
  getTestClient,
};
