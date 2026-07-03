// Seam-injected tests for the activity map (no real DB). Distinct user ids
// per test because the module-level maps persist across tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { touch, lastActivityMs, __setPresenceActivityDeps } = require('./presenceActivity');

function makePool() {
  const calls = [];
  return { calls, query: (sql, params) => { calls.push(params[0]); return Promise.resolve(); } };
}

test('throttle: repeat touches inside 60s flush once; immediate bypasses; window elapse flushes again', () => {
  const pool = makePool();
  let now = 1000000;
  __setPresenceActivityDeps({ pool, now: () => now });
  touch(101);
  now += 10000;
  touch(101); // inside throttle window: no second flush
  assert.equal(pool.calls.filter(id => id === 101).length, 1);
  touch(101, { immediate: true }); // immediate bypasses the throttle
  assert.equal(pool.calls.filter(id => id === 101).length, 2);
  now += 61000;
  touch(101); // window elapsed: flushes again
  assert.equal(pool.calls.filter(id => id === 101).length, 3);
  assert.equal(lastActivityMs(101), now);
  assert.equal(lastActivityMs(999), null);
});

test('flush rejection is swallowed (no unhandled rejection, warn-once)', async () => {
  __setPresenceActivityDeps({
    pool: { query: () => Promise.reject(new Error('db down')) },
    now: () => 5000000,
  });
  touch(202, { immediate: true });
  touch(203, { immediate: true });
  await new Promise((r) => setTimeout(r, 20)); // let the rejections settle; test fails on unhandledRejection
});
