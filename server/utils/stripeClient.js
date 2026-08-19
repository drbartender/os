/**
 * Central Stripe client factory with test-mode toggle.
 *
 * When STRIPE_TEST_MODE_UNTIL (ISO date) is in the future, every call
 * uses the *_TEST credentials. Once the cutoff passes, the next call
 * flips back to live — no redeploy required (isTestMode() is evaluated
 * per invocation, not cached at boot).
 *
 * Fail-closed semantics: if test mode is active but STRIPE_SECRET_KEY_TEST is
 * missing, getStripe() returns null rather than falling through to the live
 * client, which prevents the misconfigured-test-mode → silent live-charge
 * failure mode.
 *
 * DELIBERATELY NOT GATED ON NODE_ENV (decided 2026-08-19). A gate refusing the
 * live client off-prod was written and then removed: real operator work is done
 * from the dev box against the live account — payment links, refunds, customer
 * writes — so the gate would have broken the daily workflow to prevent something
 * nobody was doing by accident. With no keys configured `stripeLive` is already
 * null, so the gate's only effect was on the configuration that is intended.
 * Do not re-add it without asking; the fix-list entry calling this a defect is
 * closed as decided-keep.
 *
 * TREAT null AS A REAL RETURN VALUE. An earlier version of this comment said
 * "callers already handle the null case" flatly, and that was not true. Two were
 * fixed here — payrollTips.stripeFeeFor and stripeRouteHelpers.getOrCreateCustomer
 * both dereferenced the result immediately and would have thrown a bare
 * TypeError; both now throw a typed ExternalServiceError. Do NOT read that as
 * "and now they all do": stripePayoutSync.js still has unguarded dereferences,
 * one of them reachable from the nightly sweep. It is on the fix list. This
 * comment has now overclaimed twice, so keep it narrow.
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
