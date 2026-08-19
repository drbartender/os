// The live-vs-test Stripe client factory. It had no test of its own until
// 2026-08-19, which is part of how the null-dereference below survived.
//
// A NODE_ENV gate refusing the live client off-prod was built here and then
// REMOVED, and the reason is worth keeping: real operator work happens from the
// dev box against the live Stripe account — payment links, refunds, customer
// writes — so the gate would have broken the daily workflow to prevent something
// nobody was doing by accident. With no keys configured `stripeLive` is already
// null, so the gate's only effect was on the configuration that is intended.
// The last test in this file pins that decision so it is not silently reversed.

// Deliberately NO dotenv: the real .env on this box carries a live sk_live_ key, and
// every case here builds its own env from scratch. Loading it would put a live
// credential in process.env for a suite that has no business seeing one.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE = path.join(__dirname, 'stripeClient.js');
const SAVED = {};
const KEYS = ['NODE_ENV', 'STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY_TEST',
  'STRIPE_TEST_MODE_UNTIL', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET_TEST',
  'STRIPE_PUBLISHABLE_KEY', 'STRIPE_PUBLISHABLE_KEY_TEST'];

// The clients are module-level consts built from env at require time, so each
// scenario needs a fresh module.
function loadWith(env) {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

const LIVE = 'sk_live_fake_for_tests';
const TEST = 'sk_test_fake_for_tests';
const FUTURE = new Date(Date.now() + 86400e3).toISOString();
const PAST = new Date(Date.now() - 86400e3).toISOString();

beforeEach(() => { for (const k of KEYS) SAVED[k] = process.env[k]; });
afterEach(() => {
  for (const k of KEYS) {
    if (SAVED[k] === undefined) delete process.env[k]; else process.env[k] = SAVED[k];
  }
  delete require.cache[require.resolve(MODULE)];
});

test('no test mode → the live client', () => {
  const c = loadWith({ NODE_ENV: 'production', STRIPE_SECRET_KEY: LIVE });
  assert.equal(c.isTestMode(), false);
  assert.equal(c.getStripe(), c.getLiveClient());
});

test('test mode with a test key → the test client', () => {
  const c = loadWith({
    NODE_ENV: 'production', STRIPE_SECRET_KEY: LIVE,
    STRIPE_SECRET_KEY_TEST: TEST, STRIPE_TEST_MODE_UNTIL: FUTURE,
  });
  assert.equal(c.isTestMode(), true);
  assert.equal(c.getStripe(), c.getTestClient());
  assert.notEqual(c.getStripe(), c.getLiveClient());
});

test('FAIL CLOSED: test mode without a test key returns null, never live', () => {
  // The misconfigured-test-mode → silent live-charge failure mode. Believing you
  // are in test mode while charging real cards is the worst outcome available.
  const c = loadWith({
    NODE_ENV: 'production', STRIPE_SECRET_KEY: LIVE, STRIPE_TEST_MODE_UNTIL: FUTURE,
  });
  assert.equal(c.isTestMode(), true);
  assert.equal(c.getStripe(), null);
});

test('an EXPIRED cutoff means live, and that is a real foot-gun', () => {
  // Worth pinning because it bit for real: a cutoff was set to a date already 3
  // months past (copied from a stale .env.example sample), which reads as
  // "configured for test" and silently means live.
  const c = loadWith({
    NODE_ENV: 'production', STRIPE_SECRET_KEY: LIVE,
    STRIPE_SECRET_KEY_TEST: TEST, STRIPE_TEST_MODE_UNTIL: PAST,
  });
  assert.equal(c.isTestMode(), false, 'a past cutoff is expired, not active');
  assert.equal(c.getStripe(), c.getLiveClient());
});

test('the webhook secret and publishable key follow the SAME mode as the client', () => {
  // A mismatch here verifies a live-signed event against a test secret (or the
  // reverse), which fails every signature and looks like an attack.
  const live = loadWith({
    NODE_ENV: 'production', STRIPE_SECRET_KEY: LIVE,
    STRIPE_WEBHOOK_SECRET: 'whsec_live', STRIPE_PUBLISHABLE_KEY: 'pk_live',
    STRIPE_WEBHOOK_SECRET_TEST: 'whsec_test', STRIPE_PUBLISHABLE_KEY_TEST: 'pk_test',
  });
  assert.equal(live.getWebhookSecret(), 'whsec_live');
  assert.equal(live.getPublishableKey(), 'pk_live');

  const testMode = loadWith({
    NODE_ENV: 'production', STRIPE_SECRET_KEY: LIVE, STRIPE_SECRET_KEY_TEST: TEST,
    STRIPE_TEST_MODE_UNTIL: FUTURE,
    STRIPE_WEBHOOK_SECRET: 'whsec_live', STRIPE_PUBLISHABLE_KEY: 'pk_live',
    STRIPE_WEBHOOK_SECRET_TEST: 'whsec_test', STRIPE_PUBLISHABLE_KEY_TEST: 'pk_test',
  });
  assert.equal(testMode.getWebhookSecret(), 'whsec_test');
  assert.equal(testMode.getPublishableKey(), 'pk_test');
});

test('DECISION 2026-08-19: NODE_ENV does NOT gate the client — dev works against live', () => {
  // Dallas: "I need to be able to do stuff from this box. We do stuff from this
  // box all the time." Operator work runs from the dev box against the live
  // account, so a gate refusing the live client off-prod breaks the daily
  // workflow. One was written and removed. If this test starts failing, someone
  // has re-added it — that is a product decision, not a cleanup.
  for (const env of ['development', 'test', undefined]) {
    const c = loadWith({ ...(env ? { NODE_ENV: env } : {}), STRIPE_SECRET_KEY: LIVE });
    assert.equal(c.getStripe(), c.getLiveClient(),
      `NODE_ENV=${env || 'unset'} must still reach live Stripe`);
  }
});
