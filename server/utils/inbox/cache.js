'use strict';

// The engine's 30-second in-process cache (spec 8), shared by the list, the
// item and the badge. Every write clears it: seen, actions, Undo, an Inbox
// text, the Messages reply and the Twilio status callback. A computation that
// was in flight when a write landed still answers the callers who asked
// before the write, but is never stored.

const { CACHE_MS } = require('./constants');

let generation = 0;
let entry = null; // { generation, at, value }
let inflight = null; // { generation, promise }

function invalidate() {
  generation += 1;
  entry = null;
  inflight = null;
}

// Starts compute now, and turns a synchronous throw into a rejection, so a
// caller's .catch always sees the failure (the badge relies on that).
function start(compute) {
  try {
    return Promise.resolve(compute());
  } catch (err) {
    return Promise.reject(err);
  }
}

// maxAgeMs lets a caller accept an older entry than CACHE_MS (the badge reads
// with BADGE_MAX_AGE_MS); a write still clears the entry for every caller.
function getOrCompute(compute, { nowMs = Date.now(), maxAgeMs = CACHE_MS } = {}) {
  if (entry && entry.generation === generation && nowMs - entry.at < maxAgeMs) return Promise.resolve(entry.value);
  if (inflight && inflight.generation === generation) return inflight.promise;
  const gen = generation;
  const promise = start(compute).then((value) => {
    if (gen === generation) entry = { generation: gen, at: Date.now(), value };
    return value;
  });
  inflight = { generation: gen, promise };
  const clear = () => { if (inflight && inflight.promise === promise) inflight = null; };
  promise.then(clear, clear);
  return promise;
}

const generationNow = () => generation;

module.exports = { getOrCompute, invalidate, generationNow };
