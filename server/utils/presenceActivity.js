// In-memory sign-of-life map + throttled DB flush (spec: Sign of life).
// The map is exact per-request truth within this process; the DB column is
// the durable shadow (max 60s stale), for cross-instance visibility. The
// sweep reads GREATEST(map, DB). Fire-and-forget: nothing here may ever
// block or fail a request.
const { pool } = require('../db');
const { ACTIVITY_FLUSH_MS } = require('./presence');

let _deps = { pool, now: () => Date.now() };
function __setPresenceActivityDeps(d) { _deps = { ..._deps, ...d }; }

const lastSeen = new Map();   // userId -> ms of last authenticated request
const lastFlush = new Map();  // userId -> ms of last DB write
let warnedOnce = false;

function touch(userId, { immediate = false } = {}) {
  const now = _deps.now();
  lastSeen.set(userId, now);
  const flushed = lastFlush.get(userId) || 0;
  if (!immediate && now - flushed < ACTIVITY_FLUSH_MS) return;
  lastFlush.set(userId, now);
  _deps.pool
    .query('UPDATE users SET presence_last_seen_at = NOW() WHERE id = $1', [userId])
    .catch((err) => {
      if (!warnedOnce) {
        warnedOnce = true;
        console.warn('[presence] last-seen flush failed (logged once):', err.message);
      }
    });
}

function lastActivityMs(userId) {
  return lastSeen.has(userId) ? lastSeen.get(userId) : null;
}

module.exports = { touch, lastActivityMs, __setPresenceActivityDeps };
