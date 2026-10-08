const { test } = require('node:test');
const assert = require('node:assert/strict');
const cache = require('./cache');
const { CACHE_MS, BADGE_MAX_AGE_MS } = require('./constants');

test('a value is reused inside 30 seconds and computed again after', async () => {
  cache.invalidate();
  let calls = 0;
  const compute = () => { calls += 1; return Promise.resolve(calls); };
  assert.equal(await cache.getOrCompute(compute), 1);
  assert.equal(await cache.getOrCompute(compute, { nowMs: Date.now() + 1000 }), 1);
  assert.equal(await cache.getOrCompute(compute, { nowMs: Date.now() + CACHE_MS + 1000 }), 2);
});

test('invalidate forces a fresh computation, and a stale in-flight result is never stored', async () => {
  cache.invalidate();
  let release;
  const p1 = cache.getOrCompute(() => new Promise((resolve) => { release = resolve; }));
  cache.invalidate();
  const p2 = cache.getOrCompute(() => Promise.resolve('fresh'));
  release('stale');
  assert.equal(await p1, 'stale');
  assert.equal(await p2, 'fresh');
  assert.equal(await cache.getOrCompute(() => Promise.resolve('unused')), 'fresh');
});

test('concurrent callers share one computation, and a failure is never cached', async () => {
  cache.invalidate();
  let calls = 0;
  const compute = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return 'v'; };
  const [a, b] = await Promise.all([cache.getOrCompute(compute), cache.getOrCompute(compute)]);
  assert.deepEqual([a, b, calls], ['v', 'v', 1]);
  cache.invalidate();
  await assert.rejects(cache.getOrCompute(() => Promise.reject(new Error('db down'))), /db down/);
  await assert.rejects(cache.getOrCompute(() => { throw new Error('thrown before any await'); }), /before any await/);
  assert.equal(await cache.getOrCompute(() => Promise.resolve('after')), 'after');
});

test('maxAgeMs replaces CACHE_MS in the freshness check, so the badge can read an older entry', async () => {
  assert.ok(BADGE_MAX_AGE_MS > CACHE_MS, 'the badge reads further back than the page');
  cache.invalidate();
  let calls = 0;
  const compute = () => { calls += 1; return Promise.resolve(calls); };
  assert.equal(await cache.getOrCompute(compute), 1);
  const older = Date.now() + CACHE_MS + 1000;
  assert.equal(await cache.getOrCompute(compute, { nowMs: older, maxAgeMs: BADGE_MAX_AGE_MS }), 1,
    'older than CACHE_MS, younger than maxAgeMs: served with no compute');
  assert.equal(calls, 1);
  const tooOld = Date.now() + BADGE_MAX_AGE_MS + 1000;
  assert.equal(await cache.getOrCompute(compute, { nowMs: tooOld, maxAgeMs: BADGE_MAX_AGE_MS }), 2,
    'older than maxAgeMs: computed again');
  assert.equal(calls, 2);
});
