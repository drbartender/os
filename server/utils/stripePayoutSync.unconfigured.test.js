require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ExternalServiceError } = require('./errors');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

// getStripe() genuinely returns null in two live situations: no STRIPE_SECRET_KEY
// at all, and test mode active with no STRIPE_SECRET_KEY_TEST (its own refusal to
// fall through to live credentials — see getStripe in stripeClient.js, cited by
// name because line numbers drift). stripeClient captures both clients at REQUIRE
// time, so reproducing that means clearing the env and re-requiring the module
// graph rather than poking a setter.
//
// THE POOL IS STUBBED TO THROW, and that is load-bearing, not tidiness. Assertions
// below claim the guard fires BEFORE any database write — syncPayout used to
// resolve the null client, WRITE a payout row, and only then crash on the deref,
// stranding a row with no lines. Without the stub that ordering claim is pinned
// only by this file's fixture being incomplete enough to trip a NOT NULL:
// "completing" the fixture would let the stranded-row regression pass every test
// here AND write junk into the SHARED dev database on every run. (Fleet finding,
// code-review, demonstrated by mutation.) With the stub, any query is an immediate
// self-describing failure.
//
// ./errors is deliberately NOT purged from the require cache — the re-required
// module and this file must share one ExternalServiceError class or instanceof
// stops holding. ../db is not purged either, so there is only ever one pool.
function loadWithStripeUnconfigured(env) {
  const saved = {
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_SECRET_KEY_TEST: process.env.STRIPE_SECRET_KEY_TEST,
    STRIPE_TEST_MODE_UNTIL: process.env.STRIPE_TEST_MODE_UNTIL,
  };
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY_TEST;
  delete process.env.STRIPE_TEST_MODE_UNTIL;
  Object.assign(process.env, env || {});
  const realQuery = pool.query;
  pool.query = () => {
    throw new Error('DB touched: the Stripe guard must fire before any query on these paths');
  };
  for (const m of ['./stripeClient', './stripePayoutSync']) delete require.cache[require.resolve(m)];
  const mod = require('./stripePayoutSync');
  const restore = () => {
    pool.query = realQuery;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const m of ['./stripeClient', './stripePayoutSync']) delete require.cache[require.resolve(m)];
  };
  return { mod, restore };
}

const isTypedStripeError = (err) => {
  assert.ok(!(err instanceof TypeError), `expected a typed error, got a bare TypeError: ${err.message}`);
  assert.ok(err instanceof ExternalServiceError, `expected ExternalServiceError, got ${err.constructor.name}`);
  assert.equal(err.service, 'stripe');
  assert.equal(err.statusCode, 502);
  return true;
};

test('sweep() throws a typed error, not a bare TypeError, when Stripe is unconfigured', async () => {
  const { mod, restore } = loadWithStripeUnconfigured();
  try {
    // force:true defeats the staleness gate so we reach client() on every run.
    await assert.rejects(() => mod.sweep({ force: true }), isTypedStripeError);
  } finally { restore(); }
});

test('sweep() leaves no wedged in-flight promise after the guard throws', async () => {
  const { mod, restore } = loadWithStripeUnconfigured();
  try {
    // Capture the actual error OBJECTS, not just "it rejected". Asserting
    // rejection twice would pass in a wedged world too: the `if (inFlight) return
    // inFlight` gate in sweep() hands back the cached REJECTED promise,
    // which rejects with the very same typed error. Only distinct instances prove
    // the .finally cleared inFlight and the second call genuinely re-entered.
    const grab = async () => {
      try { await mod.sweep({ force: true }); return null; } catch (e) { return e; }
    };
    const first = await grab();
    const second = await grab();
    isTypedStripeError(first);
    isTypedStripeError(second);
    assert.notEqual(first, second,
      'same error instance twice — inFlight was not cleared and the sweep is wedged');
  } finally { restore(); }
});

test('syncPayout() throws the same typed error before it writes any row', async () => {
  const { mod, restore } = loadWithStripeUnconfigured();
  try {
    const payout = { id: 'po_guard_test', status: 'paid', livemode: true, amount: 1000, currency: 'usd' };
    await assert.rejects(() => mod.syncPayout(payout), isTypedStripeError);
  } finally { restore(); }
});

test('syncPendingTransactions() throws the same typed error', async () => {
  const { mod, restore } = loadWithStripeUnconfigured();
  try {
    await assert.rejects(() => mod.syncPendingTransactions(), isTypedStripeError);
  } finally { restore(); }
});

test('test mode without a test key is the OTHER null path and is guarded too', async () => {
  // STRIPE_TEST_MODE_UNTIL in the future, no STRIPE_SECRET_KEY_TEST: getStripe()
  // logs its refusal and returns null. sweep() and syncPendingTransactions() both
  // short-circuit on isTestMode() BEFORE resolving a client, which is existing
  // deliberate behavior — assert that, so this test documents the seam instead of
  // pretending the guard is what stops them.
  const future = new Date(Date.now() + 86400000).toISOString();
  const { mod, restore } = loadWithStripeUnconfigured({ STRIPE_TEST_MODE_UNTIL: future });
  try {
    assert.deepEqual(await mod.sweep({ force: true }), { skipped: 'test_mode' });
    assert.deepEqual(await mod.syncPendingTransactions(), { skipped: 'test_mode' });
    // syncPayout has NO test-mode short-circuit for a livemode:true object, so it
    // is the one that actually reaches the guard on this path.
    const payout = { id: 'po_guard_test2', status: 'paid', livemode: true, amount: 1000, currency: 'usd' };
    await assert.rejects(() => mod.syncPayout(payout), isTypedStripeError);
  } finally { restore(); }
});
