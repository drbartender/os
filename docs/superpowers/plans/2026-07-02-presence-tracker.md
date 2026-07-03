---
spec: docs/superpowers/specs/2026-07-02-presence-tracker-design.md
lanes:
  - id: presence-tracker
    footprint:
      - server/db/schema.sql
      - server/utils/presence.js
      - server/utils/presence.test.js
      - server/utils/presenceActivity.js
      - server/utils/presenceStore.js
      - server/utils/presenceScheduler.js
      - server/utils/presenceScheduler.test.js
      - server/middleware/auth.js
      - server/routes/admin/presence.js
      - server/routes/admin/presence.test.js
      - server/routes/admin/index.js
      - server/routes/admin/settings.js
      - server/routes/telegram.js
      - server/routes/telegram.test.js
      - server/routes/sms.js
      - server/index.js
      - client/src/components/AdminLayout.js
      - client/src/components/adminos/Sidebar.js
      - client/src/components/adminos/PresenceStrip.js
      - client/src/components/adminos/drawers/PresenceDrawer.js
      - client/src/index.css
      - .env.example
      - README.md
      - ARCHITECTURE.md
      - .claude/CLAUDE.md
    blockedBy: []
    review: full-fleet   # schema.sql (DDL), routes/telegram.js + routes/sms.js (verified webhooks), middleware/auth.js (auth seam); max effort
---

# Presence Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-person time clock in the admin sidebar: desk/available/away states, a derived "who answers the next lead" pointer, an interval log with weekly/monthly totals in a drawer, and a stale-desk nudge (Telegram for Zul, SMS for Dallas) that auto-flips ignored desks to away.

**Architecture:** Presence columns on `users` plus a `presence_log` interval table (one open row per user, enforced by a partial unique index). Pure derivation/predicate helpers in `server/utils/presence.js` (pricingEngine-style, no DB), DB operations in `server/utils/presenceStore.js`, an in-memory activity map with a throttled DB flush in `server/utils/presenceActivity.js`, a 15-minute sweep in `server/utils/presenceScheduler.js`. The strip payload rides the existing badge-counts poll; POSTs return server truth. Two verified webhooks (telegram, sms inbound) gain fire-and-forget sign-of-life stamps that never alter their existing behavior.

**Tech Stack:** Express (raw SQL via `pool.query`), `node:test` suites against the shared dev DB, React 18 admin shell, vanilla CSS in `index.css`.

## Global Constraints

- Display-only: presence never routes or suppresses notifications; no client-facing or staff-portal surface.
- States enum is exactly `desk`, `available`, `away`; default `away`. API JSON keys snake_case.
- Thresholds are named constants: `NUDGE_AFTER_MS` = 6h, `FLIP_GRACE_MS` = 30min, `ACTIVITY_FLUSH_MS` = 60s. No per-user tuning (YAGNI).
- Totals bucket in **America/Chicago**: weeks start Monday 00:00 Central; boundary-spanning intervals are split by overlap.
- `nudged_at` stamps ONLY on a confirmed send: telegram `result.ok === true`; SMS no-throw AND `sid` not starting with `dev-skipped`.
- The auto-flip closes the interval at `nudged_at` (never NOW()) and is scoped by observed interval id + conditional users UPDATE; no path may produce `ended_at < started_at`.
- All SQL parameterized. DDL idempotent (`ADD COLUMN IF NOT EXISTS`; CHECKs via `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`, mirroring schema.sql:269-270). Multi-statement writes in BEGIN/COMMIT/ROLLBACK.
- Client-visible errors throw AppError subclasses (`ValidationError`), never `res.status().json()`.
- No em dashes in any copy (nudge SMS/Telegram text, strip labels, drawer copy).
- The dev DB does NOT auto-apply `schema.sql`: Task 1 applies the new statements by hand. Prod gets them via initDb on deploy.
- Server suites run ALONE, one at a time (shared dev DB): `node --test <file>`. Test rows use unique email prefixes and are deleted in teardown. Route tests must tolerate the two real backfilled dev rows (assert on test rows' presence in payloads, never on exact array length).
- Test lead ranks use 900+ values so they never collide with the real dev rows (rank 1 and 2) under the partial UNIQUE index.
- Commits are in-lane checkpoints (squashed at merge): explicit pathspec always, never `git add .`.
- `server/index.js` has known uncommitted quick-fix edits in the `os` checkout from a parallel window; the lane cuts from committed main, so expect a trivial adjacent-block merge conflict there and resolve by keeping both scheduler blocks.
- Backfill emails verified against prod Neon (`production` branch) 2026-07-02: Dallas = `admin@drbartender.com` (id 1), Zul = `zul@drbartender.com` (id 2). Both rows also exist on dev.
- Dallas's cell is NOT committed to the repo: `presence_nudge_phone` is set by a manual rollout UPDATE (Task 9 checklist). The scheduler must treat a NULL phone on an sms-channel user as "send unconfirmed" (log + Sentry, no stamp, no flip).

---

### Task 1: Schema + dev apply

**Files:**
- Modify: `server/db/schema.sql` (append at end of file)
- Apply by hand to the dev DB (Neon `dev` branch) after writing.

**Interfaces:**
- Produces: `users.presence_state / presence_since / presence_taking_leads / presence_lead_rank / presence_last_seen_at / presence_nudge_channel / presence_nudge_phone`; table `presence_log(id, user_id, state, taking_leads, started_at, ended_at, ended_reason, nudged_at)`; partial unique index `idx_presence_log_one_open`; backfilled ranks/channels + seeded open away intervals for the two admins.

- [ ] **Step 1: Append the DDL to `server/db/schema.sql`**

```sql
-- ─── Presence tracker (spec docs/superpowers/specs/2026-07-02-presence-tracker-design.md) ───
-- Two-person time clock: state machine columns on users + interval log.
-- presence_lead_rank NULL = not tracked. Lowest online-and-taking rank owns
-- leads; highest rank is the unconditional fallback (Dallas).
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_state VARCHAR(20) NOT NULL DEFAULT 'away';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_presence_state_check;
ALTER TABLE users ADD CONSTRAINT users_presence_state_check
  CHECK (presence_state IN ('desk', 'available', 'away'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_since TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_taking_leads BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_lead_rank INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_last_seen_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_nudge_channel VARCHAR(10);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_presence_nudge_channel_check;
ALTER TABLE users ADD CONSTRAINT users_presence_nudge_channel_check
  CHECK (presence_nudge_channel IS NULL OR presence_nudge_channel IN ('sms', 'telegram'));
-- E.164 destination for sms-channel nudges AND the inbound sign-of-life match
-- key. This is deliberately NOT contractor_profiles.phone and NEVER the shared
-- 312 Google Voice line. Set by hand at rollout (personal cell, not committed).
ALTER TABLE users ADD COLUMN IF NOT EXISTS presence_nudge_phone VARCHAR(20);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_presence_lead_rank
  ON users (presence_lead_rank) WHERE presence_lead_rank IS NOT NULL;

CREATE TABLE IF NOT EXISTS presence_log (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state VARCHAR(20) NOT NULL CHECK (state IN ('desk', 'available', 'away')),
  taking_leads BOOLEAN NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  ended_reason VARCHAR(20) CHECK (ended_reason IN ('switch', 'auto_flip')),
  nudged_at TIMESTAMPTZ
);
-- Exactly one open interval per user; doubles as the concurrency guard for
-- interval INSERTs (the flip pass guards its close by observed id, see
-- presenceStore.applyAutoFlip).
CREATE UNIQUE INDEX IF NOT EXISTS idx_presence_log_one_open
  ON presence_log (user_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_presence_log_user_started
  ON presence_log (user_id, started_at DESC);

-- Backfill: rank the two tracked admins. Idempotent (WHERE ... IS NULL);
-- no-op where the account is absent. Emails verified against the prod users
-- table 2026-07-02 (admin@drbartender.com id 1, zul@drbartender.com id 2).
UPDATE users SET presence_lead_rank = 1, presence_nudge_channel = 'telegram'
  WHERE email = 'zul@drbartender.com' AND presence_lead_rank IS NULL;
UPDATE users SET presence_lead_rank = 2, presence_nudge_channel = 'sms'
  WHERE email = 'admin@drbartender.com' AND presence_lead_rank IS NULL;

-- Seed the clock so no consumer ever sees a half-initialized tracked user:
-- presence_since set, and exactly one open away interval. Guarded, so the
-- boot-time re-run is a no-op.
UPDATE users SET presence_since = NOW()
  WHERE presence_lead_rank IS NOT NULL AND presence_since IS NULL;
INSERT INTO presence_log (user_id, state, taking_leads, started_at)
SELECT u.id, u.presence_state, u.presence_taking_leads, u.presence_since
FROM users u
WHERE u.presence_lead_rank IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM presence_log pl WHERE pl.user_id = u.id AND pl.ended_at IS NULL
  );
```

- [ ] **Step 2: Apply to the dev DB by hand**

Run the block above against the dev branch (Neon MCP `run_sql` on project `round-tooth-34649976`, branch `br-delicate-union-adt2hvor`, one statement at a time, or psql with the `.env` `DATABASE_URL`).

Verify:

```sql
SELECT id, email, presence_state, presence_lead_rank, presence_nudge_channel, presence_since
FROM users WHERE presence_lead_rank IS NOT NULL ORDER BY presence_lead_rank;
SELECT user_id, state, taking_leads, started_at, ended_at FROM presence_log WHERE ended_at IS NULL;
```

Expected: 2 users (zul rank 1 telegram, admin rank 2 sms), both `away` with `presence_since` set; 2 open away intervals.

- [ ] **Step 3: Run the block a second time (idempotency proof)**

Expected: no errors, still exactly 2 open intervals.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "presence: schema (users columns, presence_log, backfill)"
```

---

### Task 2: Pure helpers `server/utils/presence.js`

**Files:**
- Create: `server/utils/presence.js`
- Test: `server/utils/presence.test.js`

**Interfaces:**
- Produces (consumed by Tasks 3-6):
  - `PRESENCE_STATES` = `['desk','available','away']`
  - `NUDGE_AFTER_MS`, `FLIP_GRACE_MS`, `ACTIVITY_FLUSH_MS` (numbers)
  - `derivePointer(users)` -> user id | null; `users` rows carry `{ id, presence_state, presence_taking_leads, presence_lead_rank }`
  - `leadsAfterTransition(prevState, nextState, currentTaking)` -> boolean
  - `isNudgeDue(interval, now)` -> boolean; interval carries `{ state, started_at, ended_at, nudged_at }`
  - `isFlipDue(interval, lastSeenMs, now)` -> boolean (`lastSeenMs` number | null)
  - `sumOverlapMs(intervals, winStart, winEnd, now)` -> `{ desk, available, away }` in ms
  - `centralWindows(now)` -> `{ weekStart: Date, monthStart: Date }` (UTC instants of Central boundaries)

- [ ] **Step 1: Write the failing tests**

Create `server/utils/presence.test.js`:

```js
// Pure-function tests for the presence helpers (no DB, no env).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  derivePointer, leadsAfterTransition, isNudgeDue, isFlipDue,
  sumOverlapMs, centralWindows, NUDGE_AFTER_MS, FLIP_GRACE_MS,
} = require('./presence');

const zul = (state, taking) => ({ id: 2, presence_state: state, presence_taking_leads: taking, presence_lead_rank: 1 });
const dal = (state, taking) => ({ id: 1, presence_state: state, presence_taking_leads: taking, presence_lead_rank: 2 });

test('pointer: Zul desk-and-taking wins', () => {
  assert.equal(derivePointer([zul('desk', true), dal('desk', true)]), 2);
});
test('pointer: Zul available + taking wins', () => {
  assert.equal(derivePointer([zul('available', true), dal('desk', true)]), 2);
});
test('pointer: Zul opted out -> Dallas', () => {
  assert.equal(derivePointer([zul('desk', false), dal('away', false)]), 1);
});
test('pointer: Zul away -> Dallas', () => {
  assert.equal(derivePointer([zul('away', false), dal('available', true)]), 1);
});
test('pointer: both away -> Dallas (fallback = max rank)', () => {
  assert.equal(derivePointer([zul('away', false), dal('away', false)]), 1);
});
test('pointer: untracked rows ignored; empty -> null', () => {
  assert.equal(derivePointer([{ id: 9, presence_state: 'desk', presence_taking_leads: true, presence_lead_rank: null }]), null);
  assert.equal(derivePointer([]), null);
});

test('leads transition matrix', () => {
  assert.equal(leadsAfterTransition('away', 'desk', false), true);       // coming online resets on
  assert.equal(leadsAfterTransition('away', 'available', false), true);
  assert.equal(leadsAfterTransition('desk', 'available', false), false); // opt-out survives
  assert.equal(leadsAfterTransition('available', 'desk', true), true);   // preserved
  assert.equal(leadsAfterTransition('desk', 'away', true), false);       // away wipes
});

test('nudge due only for open, un-nudged desk past threshold', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const base = { state: 'desk', ended_at: null, nudged_at: null };
  const started = (msAgo) => new Date(now.getTime() - msAgo).toISOString();
  assert.equal(isNudgeDue({ ...base, started_at: started(NUDGE_AFTER_MS + 1000) }, now), true);
  assert.equal(isNudgeDue({ ...base, started_at: started(NUDGE_AFTER_MS - 1000) }, now), false);
  assert.equal(isNudgeDue({ ...base, state: 'available', started_at: started(NUDGE_AFTER_MS * 2) }, now), false);
  assert.equal(isNudgeDue({ ...base, nudged_at: started(1000), started_at: started(NUDGE_AFTER_MS * 2) }, now), false);
});

test('flip due after grace with no sign of life since nudge', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const nudged = new Date(now.getTime() - FLIP_GRACE_MS - 1000);
  const iv = { state: 'desk', ended_at: null, started_at: new Date(now.getTime() - 8 * 3600e3).toISOString(), nudged_at: nudged.toISOString() };
  assert.equal(isFlipDue(iv, null, now), true);
  assert.equal(isFlipDue(iv, nudged.getTime() - 5000, now), true);   // last seen BEFORE nudge
  assert.equal(isFlipDue(iv, nudged.getTime() + 5000, now), false);  // touch after nudge cancels
  assert.equal(isFlipDue({ ...iv, nudged_at: new Date(now.getTime() - FLIP_GRACE_MS + 60000).toISOString() }, null, now), false); // inside grace
});

test('sumOverlapMs splits at window boundaries and clips open intervals to now', () => {
  const now = new Date('2026-07-02T12:00:00Z');
  const winStart = new Date('2026-07-01T00:00:00Z');
  const intervals = [
    // 22:00 Jun 30 -> 02:00 Jul 1: only 2h inside the window
    { state: 'desk', started_at: '2026-06-30T22:00:00Z', ended_at: '2026-07-01T02:00:00Z' },
    // open available interval since 10:00 -> clips to now (2h)
    { state: 'available', started_at: '2026-07-02T10:00:00Z', ended_at: null },
    // entirely before window: ignored
    { state: 'desk', started_at: '2026-06-29T00:00:00Z', ended_at: '2026-06-29T04:00:00Z' },
  ];
  const t = sumOverlapMs(intervals, winStart, now, now);
  assert.equal(t.desk, 2 * 3600e3);
  assert.equal(t.available, 2 * 3600e3);
});

test('centralWindows: Thu Jul 2 2026 -> week starts Mon Jun 29 05:00Z (CDT), month Jul 1 05:00Z', () => {
  const { weekStart, monthStart } = centralWindows(new Date('2026-07-02T15:00:00Z'));
  assert.equal(weekStart.toISOString(), '2026-06-29T05:00:00.000Z');
  assert.equal(monthStart.toISOString(), '2026-07-01T05:00:00.000Z');
});

test('centralWindows: winter (CST, UTC-6) and week crossing a month edge', () => {
  // Thu Jan 1 2026: week starts Mon Dec 29 2025 06:00Z (CST).
  const { weekStart, monthStart } = centralWindows(new Date('2026-01-01T18:00:00Z'));
  assert.equal(weekStart.toISOString(), '2025-12-29T06:00:00.000Z');
  assert.equal(monthStart.toISOString(), '2026-01-01T06:00:00.000Z');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/utils/presence.test.js`
Expected: FAIL (cannot find module './presence').

- [ ] **Step 3: Implement `server/utils/presence.js`**

```js
// Pure presence helpers: derivation, predicates, and time bucketing.
// No DB calls (mirror pricingEngine.js) so every rule is unit-testable.
// Spec: docs/superpowers/specs/2026-07-02-presence-tracker-design.md

const PRESENCE_STATES = ['desk', 'available', 'away'];
const NUDGE_AFTER_MS = 6 * 60 * 60 * 1000;  // continuous desk before the nudge
const FLIP_GRACE_MS = 30 * 60 * 1000;       // silence after the nudge before auto-flip
const ACTIVITY_FLUSH_MS = 60 * 1000;        // max cadence of last-seen DB writes

/**
 * Who answers the next lead. Rows are users (any mix of tracked/untracked);
 * eligible = tracked, not away, taking leads; lowest rank wins. When nobody
 * is eligible the highest-ranked tracked user (Dallas) owns leads
 * unconditionally. Returns a user id or null when nobody is tracked.
 */
function derivePointer(users) {
  const tracked = (users || []).filter(
    (u) => u.presence_lead_rank !== null && u.presence_lead_rank !== undefined
  );
  if (!tracked.length) return null;
  const eligible = tracked
    .filter((u) => u.presence_state !== 'away' && u.presence_taking_leads)
    .sort((a, b) => a.presence_lead_rank - b.presence_lead_rank);
  if (eligible.length) return eligible[0].id;
  return tracked.sort((a, b) => b.presence_lead_rank - a.presence_lead_rank)[0].id;
}

/**
 * Taking-leads value after a state transition: away wipes it, coming online
 * from away resets it on, desk<->available preserves the explicit choice.
 */
function leadsAfterTransition(prevState, nextState, currentTaking) {
  if (nextState === 'away') return false;
  if (prevState === 'away') return true;
  return !!currentTaking;
}

function isNudgeDue(interval, now) {
  return interval.state === 'desk'
    && !interval.ended_at
    && !interval.nudged_at
    && now.getTime() - new Date(interval.started_at).getTime() >= NUDGE_AFTER_MS;
}

function isFlipDue(interval, lastSeenMs, now) {
  if (interval.state !== 'desk' || interval.ended_at || !interval.nudged_at) return false;
  const nudgedMs = new Date(interval.nudged_at).getTime();
  if (now.getTime() - nudgedMs < FLIP_GRACE_MS) return false;
  return lastSeenMs === null || lastSeenMs === undefined || lastSeenMs < nudgedMs;
}

/**
 * Per-state milliseconds of overlap between each interval and [winStart,
 * winEnd]. Open intervals (ended_at null) clip to `now`. Boundary-spanning
 * intervals contribute only their in-window slice, so totals always sum to
 * wall-clock time (spec: Totals bucketing).
 */
function sumOverlapMs(intervals, winStart, winEnd, now) {
  const totals = { desk: 0, available: 0, away: 0 };
  const ws = winStart.getTime();
  const we = winEnd.getTime();
  for (const iv of intervals || []) {
    const s = new Date(iv.started_at).getTime();
    const e = iv.ended_at ? new Date(iv.ended_at).getTime() : now.getTime();
    const overlap = Math.min(e, we) - Math.max(s, ws);
    if (overlap > 0 && totals[iv.state] !== undefined) totals[iv.state] += overlap;
  }
  return totals;
}

// ─── Central-time window math (no deps; Chicago is always UTC-5 or UTC-6,
// and DST shifts at 2am so midnight always exists) ─────────────────────────
const CT = 'America/Chicago';

function centralParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CT, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', weekday: 'short', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    hour: Number(get('hour')), weekday: get('weekday'),
  };
}

/** UTC instant of midnight Central on calendar day y-m-d. */
function centralMidnightUtc(y, m, d) {
  for (const off of [5, 6]) {
    const t = new Date(Date.UTC(y, m - 1, d, off, 0, 0));
    const p = centralParts(t);
    if (p.y === y && p.m === m && p.d === d && p.hour === 0) return t;
  }
  return new Date(Date.UTC(y, m - 1, d, 6, 0, 0)); // unreachable safety net
}

const DOW = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Week (Monday 00:00 Central) and month (1st 00:00 Central) starts for `now`. */
function centralWindows(now) {
  const p = centralParts(now);
  const back = DOW[p.weekday] ?? 0;
  // Date.UTC normalizes negative day-of-month, so month/year rollovers are free.
  const wk = new Date(Date.UTC(p.y, p.m - 1, p.d - back, 12));
  const weekStart = centralMidnightUtc(wk.getUTCFullYear(), wk.getUTCMonth() + 1, wk.getUTCDate());
  const monthStart = centralMidnightUtc(p.y, p.m, 1);
  return { weekStart, monthStart };
}

module.exports = {
  PRESENCE_STATES, NUDGE_AFTER_MS, FLIP_GRACE_MS, ACTIVITY_FLUSH_MS,
  derivePointer, leadsAfterTransition, isNudgeDue, isFlipDue,
  sumOverlapMs, centralWindows,
};
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test server/utils/presence.test.js`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/presence.js server/utils/presence.test.js
git commit -m "presence: pure helpers (pointer, transitions, predicates, CT bucketing)"
```

---

### Task 3: Activity map + auth-middleware stamp

**Files:**
- Create: `server/utils/presenceActivity.js`
- Modify: `server/middleware/auth.js` (the `auth` SELECT at ~line 39 and the `req.user` assignment ~line 66)

**Interfaces:**
- Consumes: `ACTIVITY_FLUSH_MS` from Task 2.
- Produces (consumed by Tasks 4-6):
  - `touch(userId, { immediate = false } = {})` -> void. Records in-memory now; flushes `users.presence_last_seen_at` fire-and-forget when `immediate` or the 60s throttle has elapsed. Never throws.
  - `lastActivityMs(userId)` -> number | null (this process's in-memory value).
  - `__setPresenceActivityDeps({ pool, now })` test seam.
- `req.user` now carries `presence_lead_rank` (null for untracked users).

- [ ] **Step 1: Implement `server/utils/presenceActivity.js`**

```js
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
```

- [ ] **Step 2: Wire into `server/middleware/auth.js`**

Add the import at the top (after the errors import):

```js
const presenceActivity = require('../utils/presenceActivity');
```

Extend the SELECT (line ~39) with `presence_lead_rank`:

```js
'SELECT id, email, role, onboarding_status, can_hire, can_staff, token_version, pre_hired, presence_lead_rank FROM users WHERE id = $1',
```

Directly before `req.user = userForReq; next();` add:

```js
// Presence sign of life: tracked users only (spec). In-memory always, DB at
// most once per 60s. Fire-and-forget by construction; see presenceActivity.
if (userForReq.presence_lead_rank !== null && userForReq.presence_lead_rank !== undefined) {
  presenceActivity.touch(userForReq.id);
}
```

- [ ] **Step 3: Sanity-run an existing auth-dependent suite**

Run: `node --test server/routes/admin/settings.badgeCounts.test.js`
Expected: PASS (auth changes are additive).

- [ ] **Step 4: Commit**

```bash
git add server/utils/presenceActivity.js server/middleware/auth.js
git commit -m "presence: activity map + throttled last-seen stamp in auth middleware"
```

---

### Task 4: Store, routes, badge-counts block

**Files:**
- Create: `server/utils/presenceStore.js`
- Create: `server/routes/admin/presence.js`
- Modify: `server/routes/admin/index.js` (add one `router.use`)
- Modify: `server/routes/admin/settings.js` (badge-counts handler, ~line 125)
- Test: `server/routes/admin/presence.test.js`

**Interfaces:**
- Consumes: Task 2 helpers; Task 3 `touch`.
- Produces (consumed by Tasks 5-8):
  - Strip payload (GET `/api/admin/presence`, both POSTs, and `badge-counts.presence`):
    `{ "users": [{ "id", "name", "state", "since", "taking_leads", "rank" }], "lead_owner_id" }`
  - Log payload (GET `/api/admin/presence/log`, admin-only):
    `{ "users": [{ "id", "name", "week": { "desk_ms", "available_ms" }, "month": { "desk_ms", "available_ms" } }], "intervals": [{ "id", "user_id", "user_name", "state", "taking_leads", "started_at", "ended_at", "ended_reason" }] }`
  - `presenceStore` exports: `getStripPayload()`, `transitionState(userId, nextState)`, `setTakingLeads(userId, taking)`, `getLogSummary(now?)`, `findSweepRows()`, `stampNudged(intervalId)`, `applyAutoFlip({ intervalId, userId, startedAt, nudgedAt })` -> boolean, `hasPendingNudge(userId)` -> boolean, `getTelegramTrackedUserId()` -> id | null, `stampByNudgePhone(fromE164)` -> id | null, `__setPresenceStoreDeps({ pool, now })`.

- [ ] **Step 1: Implement `server/utils/presenceStore.js`**

```js
// DB layer for the presence tracker. Every multi-statement write is a
// transaction; the one-open-interval invariant is enforced by the partial
// unique index (INSERT side) and by id-scoped guarded UPDATEs (close side).
const { pool } = require('../db');
const { ValidationError } = require('./errors');
const { derivePointer, leadsAfterTransition, sumOverlapMs, centralWindows } = require('./presence');
const presenceActivity = require('./presenceActivity');

let _deps = { pool, now: () => new Date() };
function __setPresenceStoreDeps(d) { _deps = { ..._deps, ...d }; }

const NAME_SQL = "COALESCE(cp.preferred_name, INITCAP(SPLIT_PART(u.email, '@', 1)))";

async function getStripPayload() {
  const r = await _deps.pool.query(`
    SELECT u.id, u.presence_state, u.presence_since, u.presence_taking_leads,
           u.presence_lead_rank, ${NAME_SQL} AS name
    FROM users u
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE u.presence_lead_rank IS NOT NULL
    ORDER BY u.presence_lead_rank
  `);
  return {
    users: r.rows.map((u) => ({
      id: u.id,
      name: u.name,
      state: u.presence_state,
      since: u.presence_since,
      taking_leads: u.presence_taking_leads,
      rank: u.presence_lead_rank,
    })),
    lead_owner_id: derivePointer(r.rows),
  };
}

// Close the open interval, update users, open the new interval. NOW() is
// transaction-stable so the close/open timestamps match exactly. FOR UPDATE
// on the users row serializes concurrent transitions per user.
async function transitionState(userId, nextState) {
  const client = await _deps.pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT presence_state, presence_taking_leads FROM users WHERE id = $1 AND presence_lead_rank IS NOT NULL FOR UPDATE',
      [userId]
    );
    if (!cur.rows[0]) throw new ValidationError('Not a presence-tracked user');
    const { presence_state: prev, presence_taking_leads: taking } = cur.rows[0];
    if (prev === nextState) { await client.query('ROLLBACK'); return; }
    const nextTaking = leadsAfterTransition(prev, nextState, taking);
    await client.query(
      "UPDATE presence_log SET ended_at = NOW(), ended_reason = 'switch' WHERE user_id = $1 AND ended_at IS NULL",
      [userId]
    );
    await client.query(
      'UPDATE users SET presence_state = $2, presence_since = NOW(), presence_taking_leads = $3 WHERE id = $1',
      [userId, nextState, nextTaking]
    );
    await client.query(
      'INSERT INTO presence_log (user_id, state, taking_leads, started_at) VALUES ($1, $2, $3, NOW())',
      [userId, nextState, nextTaking]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function setTakingLeads(userId, taking) {
  const client = await _deps.pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      'SELECT presence_state, presence_taking_leads FROM users WHERE id = $1 AND presence_lead_rank IS NOT NULL FOR UPDATE',
      [userId]
    );
    if (!cur.rows[0]) throw new ValidationError('Not a presence-tracked user');
    const { presence_state: state, presence_taking_leads: current } = cur.rows[0];
    if (state === 'away') throw new ValidationError('Leads toggle is unavailable while away');
    if (current === taking) { await client.query('ROLLBACK'); return; }
    await client.query(
      "UPDATE presence_log SET ended_at = NOW(), ended_reason = 'switch' WHERE user_id = $1 AND ended_at IS NULL",
      [userId]
    );
    await client.query('UPDATE users SET presence_taking_leads = $2 WHERE id = $1', [userId, taking]);
    await client.query(
      'INSERT INTO presence_log (user_id, state, taking_leads, started_at) VALUES ($1, $2, $3, NOW())',
      [userId, state, taking]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getLogSummary(now = _deps.now()) {
  const { weekStart, monthStart } = centralWindows(now);
  const fetchFrom = new Date(Math.min(weekStart.getTime(), monthStart.getTime()));
  const [users, rows, recent] = await Promise.all([
    _deps.pool.query(`
      SELECT u.id, ${NAME_SQL} AS name
      FROM users u LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.presence_lead_rank IS NOT NULL ORDER BY u.presence_lead_rank
    `),
    _deps.pool.query(
      'SELECT user_id, state, started_at, ended_at FROM presence_log WHERE ended_at IS NULL OR ended_at > $1',
      [fetchFrom]
    ),
    _deps.pool.query(`
      SELECT pl.id, pl.user_id, pl.state, pl.taking_leads, pl.started_at, pl.ended_at,
             pl.ended_reason, ${NAME_SQL} AS user_name
      FROM presence_log pl
      JOIN users u ON u.id = pl.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.presence_lead_rank IS NOT NULL
      ORDER BY pl.started_at DESC LIMIT 50
    `),
  ]);
  const byUser = new Map(users.rows.map((u) => [u.id, []]));
  for (const iv of rows.rows) {
    if (byUser.has(iv.user_id)) byUser.get(iv.user_id).push(iv);
  }
  return {
    users: users.rows.map((u) => {
      const ivs = byUser.get(u.id) || [];
      const week = sumOverlapMs(ivs, weekStart, now, now);
      const month = sumOverlapMs(ivs, monthStart, now, now);
      return {
        id: u.id,
        name: u.name,
        week: { desk_ms: week.desk, available_ms: week.available },
        month: { desk_ms: month.desk, available_ms: month.available },
      };
    }),
    intervals: recent.rows,
  };
}

// Open desk intervals + everything the sweep needs to decide nudge/flip.
async function findSweepRows() {
  const r = await _deps.pool.query(`
    SELECT pl.id, pl.user_id, pl.state, pl.started_at, pl.ended_at, pl.nudged_at,
           u.presence_nudge_channel, u.presence_nudge_phone, u.presence_last_seen_at,
           ${NAME_SQL} AS name
    FROM presence_log pl
    JOIN users u ON u.id = pl.user_id
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    WHERE pl.ended_at IS NULL AND pl.state = 'desk' AND u.presence_lead_rank IS NOT NULL
  `);
  return r.rows;
}

async function stampNudged(intervalId) {
  await _deps.pool.query(
    'UPDATE presence_log SET nudged_at = NOW() WHERE id = $1 AND ended_at IS NULL',
    [intervalId]
  );
}

/**
 * Auto-flip an ignored desk to away, scoped to the exact interval the sweep
 * observed (spec: Flip pass). Both UPDATEs are guarded; rowCount 0 on either
 * means a manual transition won the race, so ROLLBACK and report false.
 * The interval closes AT nudged_at, and the away interval starts there, so
 * an ignored tail never counts as work and ended_at < started_at is
 * impossible by construction.
 */
async function applyAutoFlip({ intervalId, userId, startedAt, nudgedAt }) {
  const client = await _deps.pool.connect();
  try {
    await client.query('BEGIN');
    const closed = await client.query(
      "UPDATE presence_log SET ended_at = $2, ended_reason = 'auto_flip' WHERE id = $1 AND ended_at IS NULL",
      [intervalId, nudgedAt]
    );
    if (closed.rowCount === 0) { await client.query('ROLLBACK'); return false; }
    const flipped = await client.query(
      "UPDATE users SET presence_state = 'away', presence_since = $2, presence_taking_leads = false WHERE id = $1 AND presence_state = 'desk' AND presence_since = $3",
      [userId, nudgedAt, startedAt]
    );
    if (flipped.rowCount === 0) { await client.query('ROLLBACK'); return false; }
    await client.query(
      "INSERT INTO presence_log (user_id, state, taking_leads, started_at) VALUES ($1, 'away', false, $2)",
      [userId, nudgedAt]
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function hasPendingNudge(userId) {
  const r = await _deps.pool.query(
    "SELECT 1 FROM presence_log WHERE user_id = $1 AND ended_at IS NULL AND state = 'desk' AND nudged_at IS NOT NULL",
    [userId]
  );
  return r.rowCount > 0;
}

async function getTelegramTrackedUserId() {
  const r = await _deps.pool.query(
    "SELECT id FROM users WHERE presence_nudge_channel = 'telegram' AND presence_lead_rank IS NOT NULL LIMIT 1"
  );
  return r.rows[0] ? r.rows[0].id : null;
}

/**
 * Inbound-SMS sign of life: match From (Twilio sends E.164) against tracked
 * users' presence_nudge_phone. Returns the matched user id or null. Also
 * updates the in-memory activity map so the same-process sweep sees it
 * instantly. NOTE: staff CONFIRM/CANT matching keys on
 * contractor_profiles.phone, a different column; no interference.
 */
async function stampByNudgePhone(fromE164) {
  if (!fromE164) return null;
  const r = await _deps.pool.query(
    'UPDATE users SET presence_last_seen_at = NOW() WHERE presence_nudge_phone = $1 AND presence_lead_rank IS NOT NULL RETURNING id',
    [String(fromE164).trim()]
  );
  const id = r.rows[0] ? r.rows[0].id : null;
  if (id) presenceActivity.touch(id, { immediate: true });
  return id;
}

module.exports = {
  getStripPayload, transitionState, setTakingLeads, getLogSummary,
  findSweepRows, stampNudged, applyAutoFlip, hasPendingNudge,
  getTelegramTrackedUserId, stampByNudgePhone, __setPresenceStoreDeps,
};
```

- [ ] **Step 2: Implement `server/routes/admin/presence.js`**

```js
// Presence tracker endpoints (spec: API section). Strip reads/mutations are
// admin+manager; the interval history is a timesheet, so it is admin-only.
// Mutations only ever write the caller's own row (IDOR-safe by construction).
const express = require('express');
const { auth, adminOnly, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError } = require('../../utils/errors');
const { PRESENCE_STATES } = require('../../utils/presence');
const store = require('../../utils/presenceStore');

const router = express.Router();

function requireTracked(req) {
  if (req.user.presence_lead_rank === null || req.user.presence_lead_rank === undefined) {
    throw new ValidationError('Not a presence-tracked user');
  }
}

router.get('/presence', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  res.json(await store.getStripPayload());
}));

router.post('/presence/state', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  requireTracked(req);
  const { state } = req.body || {};
  if (!PRESENCE_STATES.includes(state)) {
    throw new ValidationError('state must be one of desk, available, away');
  }
  await store.transitionState(req.user.id, state);
  res.json(await store.getStripPayload());
}));

router.post('/presence/leads', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  requireTracked(req);
  const { taking } = req.body || {};
  if (typeof taking !== 'boolean') throw new ValidationError('taking must be a boolean');
  await store.setTakingLeads(req.user.id, taking);
  res.json(await store.getStripPayload());
}));

router.get('/presence/log', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json(await store.getLogSummary());
}));

module.exports = router;
```

- [ ] **Step 3: Mount in `server/routes/admin/index.js`**

After `router.use('/', require('./payroll'));` add:

```js
router.use('/', require('./presence'));
```

- [ ] **Step 4: Extend badge-counts in `server/routes/admin/settings.js`**

At the top add:

```js
const { getStripPayload } = require('../../utils/presenceStore');
```

In the badge-counts handler, after `if (req.user.role !== 'admin') counts.new_applications = 0;` and before `res.json(counts);`:

```js
// Presence strip block rides the existing 60s poll (spec: Fetch and display).
// Non-fatal by design: a presence failure must never break badge counts.
try {
  counts.presence = await getStripPayload();
} catch (err) {
  console.warn('[badge-counts] presence block failed:', err.message);
  counts.presence = null;
}
```

- [ ] **Step 5: Write the route tests**

Create `server/routes/admin/presence.test.js`. Copy the hand-rolled harness from `server/routes/admin/settings.badgeCounts.test.js` verbatim (express app + real routers + real auth middleware + the same error middleware and http helpers, with a `post()` helper added alongside `get()`), then:

- Setup (`before`): create four users with unique emails `presence-test-<NONCE>-{a,b,m,s}@test.local` and bcrypt-hashed passwords: `a` = admin with `presence_lead_rank` 901, `presence_nudge_channel` 'sms', `presence_nudge_phone` `'+1555000<4 random digits>'`; `b` = admin with rank 902 channel 'telegram'; `m` = manager, untracked; `s` = staff, untracked. Sign JWTs `{ userId, tokenVersion: 0 }` like the badgeCounts suite. Mount BOTH `./presence` and `./settings` routers.
- Teardown (`after`): `DELETE FROM users WHERE email LIKE 'presence-test-<NONCE>-%'` (presence_log cascades), close server + pool.
- Tests (assert on the test users inside payloads; NEVER on exact array lengths, the shared dev DB has 2 real tracked rows):
  1. `GET /presence` as staff -> 403; as anon -> 401; as manager -> 200.
  2. `GET /presence` as admin: payload contains users a and b with `state: 'away'`, `taking_leads: false`, correct `rank`. Test rows are inserted raw (no backfill seed), so `since` is null and no open interval exists yet; that is fine, the first transition's close UPDATE simply matches zero rows. Assert the `since` KEY exists, value null.
  3. `POST /presence/state` as manager (untracked) -> 400 with `Not a presence-tracked user`.
  4. `POST /presence/state` bad enum (`{state:'busy'}`) as a -> 400.
  5. `POST /presence/state {state:'desk'}` as a -> 200; payload row a shows `state 'desk'`, `taking_leads true` (away->desk resets on); a presence_log open desk row exists for a.
  6. `POST /presence/leads {taking:false}` as a -> 200, row a `taking_leads false`; then `POST /presence/state {state:'available'}` -> `taking_leads` STAYS false (opt-out survives desk->available); then `{state:'away'}` then `{state:'available'}` -> `taking_leads` back to true (away wipes, re-entry resets).
  7. `POST /presence/leads` while away -> 400 `Leads toggle is unavailable while away`.
  8. Interval bookkeeping: after the sequence in (5)-(6), query presence_log for user a: exactly one open row; every closed row has `ended_reason 'switch'` and `ended_at` equal to the next row's `started_at`.
  9. `GET /presence/log` as manager -> 403; as admin -> 200 with `users` and `intervals` arrays; user a's entry has numeric `week.desk_ms >= 0`.
  10. `GET /badge-counts` as admin -> body has a `presence` object with `users` and `lead_owner_id` keys.

- [ ] **Step 6: Run**

Run: `node --test server/routes/admin/presence.test.js`
Expected: PASS. Then re-run `node --test server/routes/admin/settings.badgeCounts.test.js` alone; expected PASS.

- [ ] **Step 7: Commit**

```bash
git add server/utils/presenceStore.js server/routes/admin/presence.js server/routes/admin/index.js server/routes/admin/settings.js server/routes/admin/presence.test.js
git commit -m "presence: store, admin endpoints, badge-counts block"
```

---

### Task 5: Nudge/auto-flip scheduler

**Files:**
- Create: `server/utils/presenceScheduler.js`
- Modify: `server/index.js` (scheduler block; add after the VA-calling scheduler registration, ~line 445)
- Test: `server/utils/presenceScheduler.test.js`

**Interfaces:**
- Consumes: Task 2 predicates, Task 4 store functions, `sendSMS` (`server/utils/sms.js`, throws on Twilio failure, returns `{sid:'dev-skipped-...'}` when gated), `sendTelegramMessage` (`server/utils/telegram.js`, returns `{ok:false,skipped:true}` when gated, `{ok:true,...}` on success, never throws), Task 3 `lastActivityMs`.
- Produces: `sweepPresence()` (registered in index.js), `__setPresenceSchedulerDeps(d)` test seam, env flag `RUN_PRESENCE_SCHEDULER`.

- [ ] **Step 1: Write the failing tests**

Create `server/utils/presenceScheduler.test.js`:

```js
// Deps-injected sweep tests (mirror the __setTelegramDeps pattern): no DB,
// no network. Verifies confirmed-send-only stamping and race-safe flipping.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { sweepPresence, __setPresenceSchedulerDeps } = require('./presenceScheduler');
const { NUDGE_AFTER_MS, FLIP_GRACE_MS } = require('./presence');

const NOW = new Date('2026-07-02T12:00:00Z');
const iso = (msAgo) => new Date(NOW.getTime() - msAgo).toISOString();

function makeDeps(rows, overrides = {}) {
  const calls = { stamped: [], flipped: [], tg: [], sms: [] };
  __setPresenceSchedulerDeps({
    now: () => NOW,
    findSweepRows: async () => rows,
    stampNudged: async (id) => calls.stamped.push(id),
    applyAutoFlip: async (args) => { calls.flipped.push(args); return true; },
    lastActivityMs: () => null,
    sendTelegramMessage: async (chat, text) => { calls.tg.push(text); return { ok: true }; },
    sendSMS: async ({ to, body }) => { calls.sms.push(to); return { sid: 'SM123' }; },
    ...overrides,
  });
  return calls;
}

beforeEach(() => { process.env.TELEGRAM_ALLOWED_USER_ID = '777'; });

const dueDesk = (extra = {}) => ({
  id: 10, user_id: 2, state: 'desk', ended_at: null, nudged_at: null,
  started_at: iso(NUDGE_AFTER_MS + 60000), presence_nudge_channel: 'telegram',
  presence_nudge_phone: null, presence_last_seen_at: null, name: 'Zul', ...extra,
});

test('nudge: confirmed telegram send stamps nudged_at', async () => {
  const calls = makeDeps([dueDesk()]);
  await sweepPresence();
  assert.deepEqual(calls.stamped, [10]);
  assert.equal(calls.tg.length, 1);
  assert.match(calls.tg[0], /Reply "yes" or touch the app/);
});

test('nudge: gated/skipped telegram send does NOT stamp', async () => {
  const calls = makeDeps([dueDesk()], {
    sendTelegramMessage: async () => ({ ok: false, skipped: true }),
  });
  await sweepPresence();
  assert.deepEqual(calls.stamped, []);
});

test('nudge: dev-skipped SMS sid does NOT stamp; real sid does', async () => {
  const row = dueDesk({ presence_nudge_channel: 'sms', presence_nudge_phone: '+15551234567' });
  let calls = makeDeps([row], { sendSMS: async () => ({ sid: 'dev-skipped-x' }) });
  await sweepPresence();
  assert.deepEqual(calls.stamped, []);
  calls = makeDeps([row]);
  await sweepPresence();
  assert.deepEqual(calls.stamped, [10]);
});

test('nudge: sms channel with NULL phone sends nothing and does not stamp', async () => {
  const calls = makeDeps([dueDesk({ presence_nudge_channel: 'sms', presence_nudge_phone: null })]);
  await sweepPresence();
  assert.deepEqual(calls.stamped, []);
  assert.equal(calls.sms.length, 0);
});

test('nudge: throwing sendSMS is caught, no stamp, sweep continues', async () => {
  const calls = makeDeps(
    [dueDesk({ presence_nudge_channel: 'sms', presence_nudge_phone: '+15551234567' }), dueDesk({ id: 11 })],
    { sendSMS: async () => { throw new Error('twilio 500'); } }
  );
  await sweepPresence();
  assert.deepEqual(calls.stamped, [11]); // the telegram row still nudges
});

test('flip: fires after grace with no sign of life, passes observed interval fields', async () => {
  const nudgedAt = iso(FLIP_GRACE_MS + 60000);
  const row = dueDesk({ nudged_at: nudgedAt });
  const calls = makeDeps([row]);
  await sweepPresence();
  assert.equal(calls.flipped.length, 1);
  assert.deepEqual(calls.flipped[0], {
    intervalId: 10, userId: 2, startedAt: row.started_at, nudgedAt: row.nudged_at,
  });
});

test('flip: in-memory activity after the nudge suppresses it', async () => {
  const nudgedAt = iso(FLIP_GRACE_MS + 60000);
  const calls = makeDeps([dueDesk({ nudged_at: nudgedAt })], {
    lastActivityMs: () => NOW.getTime() - FLIP_GRACE_MS, // after the nudge
  });
  await sweepPresence();
  assert.equal(calls.flipped.length, 0);
});

test('flip: DB last_seen after the nudge suppresses it', async () => {
  const nudgedAt = iso(FLIP_GRACE_MS + 60000);
  const calls = makeDeps([dueDesk({ nudged_at: nudgedAt, presence_last_seen_at: iso(FLIP_GRACE_MS) })]);
  await sweepPresence();
  assert.equal(calls.flipped.length, 0);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test server/utils/presenceScheduler.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `server/utils/presenceScheduler.js`**

```js
// Stale-desk nudge + auto-flip sweep, every 15 min (spec: Nudge and auto-flip
// scheduler). nudged_at stamps ONLY on a confirmed send; an ignored nudge
// flips the user to away with the interval closed AT the nudge time.
const Sentry = require('@sentry/node');
const sms = require('./sms');
const telegram = require('./telegram');
const store = require('./presenceStore');
const presenceActivity = require('./presenceActivity');
const { isNudgeDue, isFlipDue } = require('./presence');

let _deps = {
  now: () => new Date(),
  findSweepRows: store.findSweepRows,
  stampNudged: store.stampNudged,
  applyAutoFlip: store.applyAutoFlip,
  lastActivityMs: presenceActivity.lastActivityMs,
  sendTelegramMessage: telegram.sendTelegramMessage,
  sendSMS: sms.sendSMS,
};
function __setPresenceSchedulerDeps(d) { _deps = { ..._deps, ...d }; }

const NUDGE_COPY =
  'You\'ve been on desk for 6+ hours. Still working? Reply "yes" or touch the app ' +
  'within 30 minutes and I\'ll keep you clocked in. Otherwise I\'ll flip you to away.';

function reportUndelivered(row, why) {
  console.warn(`[presence] nudge not delivered for ${row.name} (${why}); will retry next sweep`);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('presence nudge undelivered', {
      level: 'warning',
      tags: { scheduler: 'presence' },
      extra: { user_id: row.user_id, channel: row.presence_nudge_channel, why },
    });
  }
}

async function nudge(row) {
  let confirmed = false;
  let why = 'unknown';
  if (row.presence_nudge_channel === 'telegram') {
    if (!process.env.TELEGRAM_ALLOWED_USER_ID) {
      why = 'TELEGRAM_ALLOWED_USER_ID unset';
    } else {
      const r = await _deps.sendTelegramMessage(process.env.TELEGRAM_ALLOWED_USER_ID, NUDGE_COPY);
      confirmed = !!(r && r.ok === true);
      if (!confirmed) why = r && r.skipped ? 'gated off' : 'telegram send failed';
    }
  } else if (row.presence_nudge_channel === 'sms') {
    if (!row.presence_nudge_phone) {
      why = 'presence_nudge_phone unset';
    } else {
      try {
        const m = await _deps.sendSMS({
          to: row.presence_nudge_phone,
          body: NUDGE_COPY,
          meta: { type: 'presence_nudge', user_id: row.user_id },
        });
        confirmed = !!(m && m.sid && !String(m.sid).startsWith('dev-skipped'));
        if (!confirmed) why = 'gated off';
      } catch (err) {
        why = `sms send failed: ${err.message}`;
      }
    }
  } else {
    why = 'no nudge channel';
  }
  if (confirmed) await _deps.stampNudged(row.id);
  else reportUndelivered(row, why);
}

async function sweepPresence() {
  const now = _deps.now();
  const rows = await _deps.findSweepRows();
  for (const row of rows) {
    if (isNudgeDue(row, now)) {
      await nudge(row);
      continue; // never nudge and flip in the same sweep
    }
    const mem = _deps.lastActivityMs(row.user_id);
    const db = row.presence_last_seen_at ? new Date(row.presence_last_seen_at).getTime() : null;
    const lastSeenMs = mem === null && db === null ? null : Math.max(mem || 0, db || 0);
    if (isFlipDue(row, lastSeenMs, now)) {
      const flipped = await _deps.applyAutoFlip({
        intervalId: row.id,
        userId: row.user_id,
        startedAt: row.started_at,
        nudgedAt: row.nudged_at,
      });
      if (flipped) {
        console.log(`[presence] auto-flipped ${row.name} to away (nudged ${new Date(row.nudged_at).toISOString()}, no sign of life)`);
      }
    }
  }
}

module.exports = { sweepPresence, __setPresenceSchedulerDeps };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test server/utils/presenceScheduler.test.js`
Expected: PASS.

- [ ] **Step 5: Register in `server/index.js`**

After the VA-calling scheduler block (after its `clearHealthRow('va_calling_webhook_health');` line) add:

```js
      // Presence tracker: stale-desk nudge + auto-flip sweep (spec 2026-07-02).
      if (enabled('RUN_PRESENCE_SCHEDULER')) {
        const { sweepPresence } = require('./utils/presenceScheduler');
        const wrapped = wrapScheduler('presence', 900, sweepPresence);
        setTimeout(wrapped, 270000); // stagger off the other jobs
        setInterval(wrapped, 15 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('presence');
      }
```

- [ ] **Step 6: Boot check**

Restart the managed dev server (kill the :5000 listener, relaunch, confirm boot lines; schedulers stay off in dev by default, which is correct).

- [ ] **Step 7: Commit**

```bash
git add server/utils/presenceScheduler.js server/utils/presenceScheduler.test.js server/index.js
git commit -m "presence: nudge/auto-flip scheduler (RUN_PRESENCE_SCHEDULER)"
```

---

### Task 6: Webhook sign-of-life splices (telegram + sms)

**Files:**
- Modify: `server/routes/telegram.js` (deps object ~line 15, handler after Guard 2 ~line 110, `!claimed` branch ~line 129, `!targetE164` branch ~line 176)
- Modify: `server/routes/sms.js` (inbound handler, after the signature gate ~line 67, before `processInboundSms`)
- Test: `server/routes/telegram.test.js` (additions)

**Interfaces:**
- Consumes: `getTelegramTrackedUserId`, `hasPendingNudge`, `stampByNudgePhone` from Task 4; `touch` from Task 3.
- Produces: no new exports; behavior additions only. Existing VA-calling and staff CONFIRM/CANT flows are byte-identical when no nudge is pending.

- [ ] **Step 1: Extend the telegram deps object**

In `server/routes/telegram.js` add imports:

```js
const presenceStore = require('../utils/presenceStore');
const presenceActivity = require('../utils/presenceActivity');
```

Add to the `deps` object:

```js
  getTelegramTrackedUserId: presenceStore.getTelegramTrackedUserId,
  hasPendingNudge: presenceStore.hasPendingNudge,
  presenceTouch: (userId) => presenceActivity.touch(userId, { immediate: true }),
```

- [ ] **Step 2: Stamp sign of life after Guard 2**

Directly after the allowlist check (`if (String(fromId) !== String(ALLOWED)) return res.sendStatus(200);`) and before `const userId = fromId;`... insert:

```js
    // Presence sign of life (spec 2026-07-02): any message from Zul proves
    // she is alive. Best-effort; must never block or fail call handling.
    let presenceUserId = null;
    try {
      presenceUserId = await deps.getTelegramTrackedUserId();
      if (presenceUserId) deps.presenceTouch(presenceUserId);
    } catch (err) {
      console.warn('[telegram] presence touch failed:', err.message);
    }
```

- [ ] **Step 3: Nudge-ack precedence in the two fallback branches**

In the YES branch, replace the `!claimed` reply block with:

```js
      if (!claimed) {
        // A bare "yes" with no pending call is the natural nudge ack
        // (spec: Sign of life, precedence rule c).
        let ack = false;
        try { ack = presenceUserId ? await deps.hasPendingNudge(presenceUserId) : false; }
        catch (err) { console.warn('[telegram] nudge check failed:', err.message); }
        await reply(chatId, ack
          ? 'Got it, keeping you on desk.'
          : 'That request expired or there is nothing to confirm. Send the number again.');
        return res.sendStatus(200);
      }
```

In the number branch, replace the `!targetE164` block with:

```js
    if (!targetE164) {
      // Unparseable text while a nudge is pending is a nudge ack, not a bad
      // call attempt: ack it and skip the rejected_validation audit.
      let ack = false;
      try { ack = presenceUserId ? await deps.hasPendingNudge(presenceUserId) : false; }
      catch (err) { console.warn('[telegram] nudge check failed:', err.message); }
      if (ack) {
        await reply(chatId, 'Got it, keeping you on desk.');
        return res.sendStatus(200);
      }
      await deps.recordAudit({ triggeredBy: userId, targetE164: null, callSid: null, status: 'rejected_validation' });
      await reply(chatId, 'That does not look like a US number. Send a 10-digit US number (no 900 or 976).');
      return res.sendStatus(200);
    }
```

- [ ] **Step 4: Add telegram tests**

In `server/routes/telegram.test.js`, stub the three new deps in the existing `__setDeps` setup (defaults for all existing tests: `getTelegramTrackedUserId: async () => 42`, `hasPendingNudge: async () => false`, `presenceTouch: () => {}`), then add four tests following the file's existing request-helper pattern:

1. Nudge pending + "yes" + no pending call (`claimForDial` returns null): reply is `Got it, keeping you on desk.`; no call placed.
2. Nudge pending + "yes" + live pending call (`claimForDial` returns a row): call places exactly as before (existing placed-call assertions), proving call-confirm wins.
3. Nudge pending + unparseable text ("still here"): ack reply, and `recordAudit` NOT called with `rejected_validation`.
4. No nudge pending + unparseable text: existing "does not look like a US number" reply and `rejected_validation` audit unchanged.

Also assert in one existing happy-path test that `presenceTouch` was called with 42 (sign of life stamps on every allowed message).

- [ ] **Step 5: Run**

Run: `node --test server/routes/telegram.test.js`
Expected: all (old + new) PASS.

- [ ] **Step 6: SMS inbound stamp**

In `server/routes/sms.js` add the import:

```js
const presenceStore = require('../utils/presenceStore');
```

In the `POST /inbound` handler, after the signature gate and before the `processInboundSms` call, insert:

```js
  // Presence sign of life (spec 2026-07-02): an inbound text from a tracked
  // admin's nudge phone proves they are alive. Best-effort; never affects
  // message routing below (staff CONFIRM/CANT keys on contractor_profiles
  // .phone, a different column).
  try {
    await presenceStore.stampByNudgePhone(req.body.From);
  } catch (err) {
    console.warn('[sms/inbound] presence stamp failed:', err.message);
  }
```

- [ ] **Step 7: Run the neighboring suite to prove no interference**

Run: `node --test server/utils/smsInbound.test.js`
Expected: PASS (untouched file, sanity only).

- [ ] **Step 8: Commit**

```bash
git add server/routes/telegram.js server/routes/telegram.test.js server/routes/sms.js
git commit -m "presence: sign-of-life stamps in telegram + sms webhooks, nudge-ack precedence"
```

---

### Task 7: Presence strip (client)

**Files:**
- Modify: `client/src/components/AdminLayout.js` (badge fetch effect ~line 55, Sidebar props ~line 109)
- Modify: `client/src/components/adminos/Sidebar.js` (props, render after the brand div ~line 58)
- Create: `client/src/components/adminos/PresenceStrip.js`
- Modify: `client/src/index.css` (append presence styles to the admin-os section)

**Interfaces:**
- Consumes: strip payload shape from Task 4; `api` (`client/src/utils/api.js`); `Icon` (`clock` and `right` glyphs exist in `adminos/Icon.js`).
- Produces: `<PresenceStrip presence={...} onPresenceChange={fn} rail={bool} currentUser={user} />`; AdminLayout owns presence state and the stale-poll guard. Task 8 adds the drawer import into PresenceStrip.

- [ ] **Step 1: AdminLayout presence state + stale-poll guard**

In `client/src/components/AdminLayout.js`:

Add `useRef` to the React import. Add state after `badges`:

```js
  const [presence, setPresence] = useState(null);
  const lastPresenceMutationRef = useRef(0);

  // POST responses are server truth and must not be overwritten by a poll
  // that started earlier (spec: Fetch and display, stale-poll guard).
  const applyPresence = useCallback((data) => {
    lastPresenceMutationRef.current = Date.now();
    setPresence(data);
  }, []);
```

Replace the body of `fetchBadges` with:

```js
    const fetchBadges = () => {
      if (document.visibilityState !== 'visible') return;
      const startedAt = Date.now();
      api.get('/admin/badge-counts').then(r => {
        const { presence: p, ...counts } = r.data || {};
        setBadges(counts);
        if (p && startedAt > lastPresenceMutationRef.current) setPresence(p);
      }).catch(() => {});
    };
```

Pass down: `<Sidebar badges={badges} presence={presence} onPresenceChange={applyPresence} onCloseMobileNav={closeMobileNav} />`

- [ ] **Step 2: Sidebar wiring**

In `client/src/components/adminos/Sidebar.js`: add `import PresenceStrip from './PresenceStrip';`, change the signature to `({ badges = {}, presence, onPresenceChange, onCloseMobileNav })`, and render directly after the closing `</div>` of `sidebar-brand`:

```jsx
      <PresenceStrip presence={presence} onPresenceChange={onPresenceChange} rail={rail} currentUser={user} />
```

- [ ] **Step 3: Create `client/src/components/adminos/PresenceStrip.js`**

```jsx
import React, { useEffect, useState } from 'react';
import api from '../../utils/api';
import Icon from './Icon';
import PresenceDrawer from './drawers/PresenceDrawer';

const STATES = [
  { key: 'desk', label: 'Desk' },
  { key: 'available', label: 'Available' },
  { key: 'away', label: 'Away' },
];

function fmtDur(sinceIso, nowMs) {
  if (!sinceIso) return '';
  const m = Math.max(0, Math.floor((nowMs - new Date(sinceIso).getTime()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export default function PresenceStrip({ presence, onPresenceChange, rail, currentUser }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [nowMs, setNowMs] = useState(Date.now());

  // Re-render the "time in state" labels each minute.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(t);
  }, []);

  const users = presence?.users;
  const isAdmin = currentUser?.role === 'admin';

  const refetch = async () => {
    try { const r = await api.get('/admin/presence'); onPresenceChange(r.data); }
    catch { /* keep last known state */ }
  };
  // Never blind-optimistic: disable while in flight, apply the response
  // payload (server truth), and on failure re-fetch + show an error line.
  const mutate = async (path, body) => {
    setBusy(true); setError(null);
    try { const r = await api.post(path, body); onPresenceChange(r.data); }
    catch { setError('Update failed'); refetch(); }
    finally { setBusy(false); setMenuOpen(false); }
  };

  // First-paint / failed-block placeholder: fixed height, no invented state.
  if (!users || !users.length) {
    return (
      <div className={`presence-strip presence-strip--placeholder${rail ? ' presence-strip--rail' : ''}`} aria-hidden="true">
        <span className="presence-dot presence-dot--away" />
        <span className="presence-dot presence-dot--away" />
      </div>
    );
  }

  const maxRank = Math.max(...users.map(u => u.rank));
  const owner = users.find(u => u.id === presence.lead_owner_id);

  return (
    <div className={`presence-strip${rail ? ' presence-strip--rail' : ''}`}>
      {users.map(u => {
        const own = u.id === currentUser?.id;
        return (
          <div key={u.id} className={`presence-row${own ? ' own' : ''}`} title={rail ? `${u.name}: ${u.state}` : undefined}>
            <button
              type="button"
              className="presence-row-main"
              disabled={!own || busy}
              onClick={() => own && setMenuOpen(v => !v)}
              aria-haspopup={own ? 'menu' : undefined}
              aria-expanded={own ? menuOpen : undefined}
            >
              <span className={`presence-dot presence-dot--${u.state}`} />
              <span className="presence-name">{u.name}</span>
              <span className="presence-state">{u.state}</span>
              <span className="presence-dur">{fmtDur(u.since, nowMs)}</span>
            </button>
            {u.rank < maxRank && (
              <button
                type="button"
                className={`presence-leads-pill${u.taking_leads ? ' on' : ''}`}
                disabled={!own || u.state === 'away' || busy}
                onClick={() => own && mutate('/admin/presence/leads', { taking: !u.taking_leads })}
                title={u.taking_leads ? 'Taking leads' : 'Not taking leads'}
              >leads</button>
            )}
            {own && menuOpen && (
              <div className="presence-menu" role="menu">
                {STATES.map(s => (
                  <button
                    key={s.key}
                    type="button"
                    role="menuitem"
                    className={`presence-menu-opt${u.state === s.key ? ' active' : ''}`}
                    onClick={() => mutate('/admin/presence/state', { state: s.key })}
                  >
                    <span className={`presence-dot presence-dot--${s.key}`} />{s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div className="presence-pointer">
        <span className="presence-pointer-label">Leads</span>
        <Icon name="right" size={10} />
        <span className="presence-pointer-name">{owner?.name || ''}</span>
        {isAdmin && (
          <button type="button" className="presence-history-btn" title="Time clock" onClick={() => setDrawerOpen(true)}>
            <Icon name="clock" size={11} />
          </button>
        )}
      </div>
      {error && <div className="presence-error">{error}</div>}
      {isAdmin && <PresenceDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
    </div>
  );
}
```

Note: the `PresenceDrawer` import lands in Task 8. To keep this task independently buildable, create the Task 8 file as a stub FIRST if building strictly in order, or build Tasks 7 and 8 together in one pass (preferred; they are one reviewable UI unit).

- [ ] **Step 4: CSS**

Append to the admin-os section of `client/src/index.css` (near the `.sidebar-brand` rules, ~line 11475):

```css
/* ─── Presence strip (spec 2026-07-02) ─────────────────────────── */
html[data-app="admin-os"] .presence-strip {
  padding: 8px 12px;
  border-bottom: 1px solid var(--line-1);
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: relative;
}
html[data-app="admin-os"] .presence-strip--placeholder {
  min-height: 66px;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  opacity: 0.5;
}
html[data-app="admin-os"] .presence-row { display: flex; align-items: center; gap: 6px; position: relative; }
html[data-app="admin-os"] .presence-row-main {
  display: flex; align-items: center; gap: 7px;
  background: none; border: 0; padding: 3px 2px; cursor: pointer;
  color: inherit; font: inherit; flex: 1; min-width: 0; text-align: left;
}
html[data-app="admin-os"] .presence-row-main:disabled { cursor: default; }
html[data-app="admin-os"] .presence-dot {
  width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto;
  background: var(--line-2);
}
html[data-app="admin-os"] .presence-dot--desk { background: hsl(var(--ok-h) var(--ok-s) 45%); }
html[data-app="admin-os"] .presence-dot--available { background: #d9a441; }
html[data-app="admin-os"] .presence-dot--away { background: var(--line-2); }
html[data-app="admin-os"] .presence-name { font-weight: 600; font-size: 12px; }
html[data-app="admin-os"] .presence-state { font-size: 11px; color: var(--text-muted); }
html[data-app="admin-os"] .presence-dur { font-size: 11px; color: var(--text-muted); margin-left: auto; }
html[data-app="admin-os"] .presence-leads-pill {
  font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
  border: 1px solid var(--line-2); border-radius: 8px; padding: 1px 6px;
  background: none; color: var(--text-muted); cursor: pointer;
}
html[data-app="admin-os"] .presence-leads-pill.on {
  border-color: hsl(var(--ok-h) var(--ok-s) 45%);
  color: hsl(var(--ok-h) var(--ok-s) 50%);
}
html[data-app="admin-os"] .presence-leads-pill:disabled { cursor: default; opacity: 0.65; }
html[data-app="admin-os"] .presence-menu {
  position: absolute; top: 100%; left: 8px; z-index: 40;
  background: var(--bg-1, var(--bg-0)); border: 1px solid var(--line-1);
  border-radius: 6px; padding: 4px; display: flex; flex-direction: column; gap: 2px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.25);
}
html[data-app="admin-os"] .presence-menu-opt {
  display: flex; align-items: center; gap: 7px; padding: 5px 10px;
  background: none; border: 0; color: inherit; font: inherit; font-size: 12px;
  cursor: pointer; border-radius: 4px; text-align: left;
}
html[data-app="admin-os"] .presence-menu-opt:hover { background: var(--line-1); }
html[data-app="admin-os"] .presence-menu-opt.active { font-weight: 600; }
html[data-app="admin-os"] .presence-pointer {
  display: flex; align-items: center; gap: 5px; margin-top: 3px;
  font-size: 11px; color: var(--text-muted);
}
html[data-app="admin-os"] .presence-pointer-name { font-weight: 600; color: inherit; }
html[data-app="admin-os"] .presence-history-btn {
  margin-left: auto; background: none; border: 0; cursor: pointer;
  color: var(--text-muted); padding: 2px; display: flex;
}
html[data-app="admin-os"] .presence-history-btn:hover { color: inherit; }
html[data-app="admin-os"] .presence-error { font-size: 10px; color: var(--danger, #c0392b); }
/* Rail mode: dots only */
html[data-app="admin-os"] .presence-strip--rail .presence-name,
html[data-app="admin-os"] .presence-strip--rail .presence-state,
html[data-app="admin-os"] .presence-strip--rail .presence-dur,
html[data-app="admin-os"] .presence-strip--rail .presence-leads-pill,
html[data-app="admin-os"] .presence-strip--rail .presence-pointer-label,
html[data-app="admin-os"] .presence-strip--rail .presence-error { display: none; }
```

If any variable above (`--bg-1`, `--danger`) is absent from the admin-os token set, check the surrounding rules at ~line 11475 and substitute the token the sidebar itself uses; the fallbacks in `var()` cover the rest.

- [ ] **Step 5: Manual verify (with Task 8's drawer stubbed or built)**

Start the dev servers, log in as admin, and check: strip renders under the brand row; your row opens the three-state menu; switching states updates dot + pointer immediately; leads pill only on Zul's row; rail mode shows dots only; both skins look sane; placeholder shows briefly on a hard reload.

- [ ] **Step 6: Commit**

```bash
git add client/src/components/AdminLayout.js client/src/components/adminos/Sidebar.js client/src/components/adminos/PresenceStrip.js client/src/index.css
git commit -m "presence: sidebar strip (states, leads pill, pointer)"
```

---

### Task 8: History drawer (client)

**Files:**
- Create: `client/src/components/adminos/drawers/PresenceDrawer.js`
- Modify: `client/src/index.css` (append drawer styles)

**Interfaces:**
- Consumes: log payload from Task 4 (`users[].week.desk_ms` etc., `intervals[]`); `Drawer` (`components/adminos/Drawer.js`, props `{ open, onClose, crumb, children }`); loading/error pattern mirrors `drawers/ShiftDrawer.js`.
- Produces: `<PresenceDrawer open={bool} onClose={fn} />` consumed by Task 7.

- [ ] **Step 1: Create `client/src/components/adminos/drawers/PresenceDrawer.js`**

```jsx
import React, { useCallback, useEffect, useState } from 'react';
import api from '../../../utils/api';
import Drawer from '../Drawer';

const CT = { timeZone: 'America/Chicago' };
function fmtMs(ms) {
  const m = Math.round((ms || 0) / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m`;
}
function fmtTs(iso) {
  return iso ? new Date(iso).toLocaleString('en-US', { ...CT, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
}
function fmtSpan(iv, nowMs) {
  const end = iv.ended_at ? new Date(iv.ended_at).getTime() : nowMs;
  return fmtMs(end - new Date(iv.started_at).getTime());
}

export default function PresenceDrawer({ open, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    setLoading(true); setErr(null);
    api.get('/admin/presence/log')
      .then(r => setData(r.data))
      .catch(() => setErr('Could not load history'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  return (
    <Drawer open={open} onClose={onClose} crumb={<span className="drawer-crumb">Time clock</span>}>
      {loading && <div className="presence-drawer-status">Loading…</div>}
      {err && !loading && (
        <div className="presence-drawer-status">
          {err}{' '}
          <button type="button" className="btn btn-ghost btn-sm" onClick={load}>Retry</button>
        </div>
      )}
      {!loading && !err && data && (
        <div className="presence-drawer-body">
          <div className="presence-totals">
            {data.users.map(u => (
              <div key={u.id} className="presence-totals-card">
                <div className="presence-totals-name">{u.name}</div>
                <div className="presence-totals-row">
                  <span>This week</span>
                  <span>{fmtMs(u.week.desk_ms)} desk · {fmtMs(u.week.available_ms)} avail</span>
                </div>
                <div className="presence-totals-row">
                  <span>This month</span>
                  <span>{fmtMs(u.month.desk_ms)} desk · {fmtMs(u.month.available_ms)} avail</span>
                </div>
              </div>
            ))}
          </div>
          {data.intervals.length === 0 ? (
            <div className="presence-drawer-status">No history yet</div>
          ) : (
            <table className="presence-log-table">
              <thead>
                <tr><th>Who</th><th>State</th><th>Started</th><th>Ended</th><th>For</th><th>Leads</th></tr>
              </thead>
              <tbody>
                {data.intervals.map(iv => (
                  <tr key={iv.id}>
                    <td>{iv.user_name}</td>
                    <td>
                      <span className={`presence-dot presence-dot--${iv.state}`} /> {iv.state}
                      {iv.ended_reason === 'auto_flip' && <span className="presence-auto-badge">auto</span>}
                    </td>
                    <td>{fmtTs(iv.started_at)}</td>
                    <td>{iv.ended_at ? fmtTs(iv.ended_at) : 'now'}</td>
                    <td>{fmtSpan(iv, Date.now())}</td>
                    <td>{iv.taking_leads ? 'on' : 'off'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Drawer>
  );
}
```

- [ ] **Step 2: CSS**

Append after the strip styles in `client/src/index.css`:

```css
/* ─── Presence history drawer ──────────────────────────────────── */
html[data-app="admin-os"] .presence-drawer-status { padding: 16px; color: var(--text-muted); font-size: 13px; }
html[data-app="admin-os"] .presence-drawer-body { padding: 12px 16px; }
html[data-app="admin-os"] .presence-totals { display: flex; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
html[data-app="admin-os"] .presence-totals-card {
  border: 1px solid var(--line-1); border-radius: 8px; padding: 10px 12px; min-width: 200px; flex: 1;
}
html[data-app="admin-os"] .presence-totals-name { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
html[data-app="admin-os"] .presence-totals-row {
  display: flex; justify-content: space-between; gap: 12px; font-size: 12px; color: var(--text-muted);
}
html[data-app="admin-os"] .presence-log-table { width: 100%; border-collapse: collapse; font-size: 12px; }
html[data-app="admin-os"] .presence-log-table th {
  text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line-1);
  color: var(--text-muted); font-weight: 600;
}
html[data-app="admin-os"] .presence-log-table td { padding: 6px 8px; border-bottom: 1px solid var(--line-1); }
html[data-app="admin-os"] .presence-auto-badge {
  margin-left: 6px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.04em;
  border: 1px solid var(--line-2); border-radius: 6px; padding: 0 5px; color: var(--text-muted);
}
```

- [ ] **Step 3: CI-grade client build (the Vercel gate)**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds with zero ESLint warnings (warnings are CI-fatal).

- [ ] **Step 4: Manual verify**

Open the drawer from the strip clock icon: loading state, totals cards for both users, interval table with an `auto` badge only on auto_flip rows, Central timestamps, empty state visible on a fresh DB, error+Retry by temporarily pointing the fetch at a bad path (then restore).

- [ ] **Step 5: Commit**

```bash
git add client/src/components/adminos/drawers/PresenceDrawer.js client/src/index.css
git commit -m "presence: history drawer (totals + interval log)"
```

---

### Task 9: Docs, env, rollout notes

**Files:**
- Modify: `.env.example` (scheduler flags section, near `RUN_VA_CALLING_SCHEDULER` ~line 160)
- Modify: `README.md` (folder tree + env table)
- Modify: `ARCHITECTURE.md` (route table + schema + schedulers)
- Modify: `.claude/CLAUDE.md` (env table)

**Interfaces:** none; documentation of everything above.

- [ ] **Step 1: `.env.example`**

Add next to the other scheduler flags:

```bash
RUN_PRESENCE_SCHEDULER=
```

- [ ] **Step 2: `README.md`**

Folder tree: add `presence.js` under `server/routes/admin/`, `presence.js` / `presenceActivity.js` / `presenceStore.js` / `presenceScheduler.js` under `server/utils/`, `PresenceStrip.js` under `components/adminos/`, `PresenceDrawer.js` under `components/adminos/drawers/`. Env table row:

```markdown
| `RUN_PRESENCE_SCHEDULER` | Optional. Set to `false` to disable the presence stale-desk nudge / auto-flip sweep (15 min). Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
```

Key features: one line under the admin section: "Presence tracker: desk/available/away strip in the admin sidebar with a derived lead-responder pointer, interval history with weekly/monthly totals, and a stale-desk nudge (Telegram/SMS) that auto-flips ignored desks to away."

- [ ] **Step 3: `ARCHITECTURE.md`**

Route table additions:

```markdown
| GET  /api/admin/presence        | admin+manager | Presence strip payload (states + lead pointer) |
| POST /api/admin/presence/state  | admin+manager (tracked, self only) | Set own presence state |
| POST /api/admin/presence/leads  | admin+manager (tracked, self only) | Set own taking-leads toggle |
| GET  /api/admin/presence/log    | admin only | Interval history + weekly/monthly totals |
```

Schema section: describe the seven `users` presence columns and `presence_log` (one open interval per user via partial unique index; `ended_reason` switch/auto_flip; `nudged_at`). Schedulers section: add the presence sweep (15 min, `RUN_PRESENCE_SCHEDULER`). Note the badge-counts response now carries a `presence` block.

- [ ] **Step 4: `.claude/CLAUDE.md`**

Env table row:

```markdown
| `RUN_PRESENCE_SCHEDULER` | Optional. Set to `false` to disable the presence stale-desk nudge / auto-flip sweep. Default on. Honored only when `RUN_SCHEDULERS` is not `false`. |
```

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md ARCHITECTURE.md .claude/CLAUDE.md
git commit -m "presence: docs + env flag"
```

---

## Lane-level verification (before merge)

1. Server suites, one at a time, each PASS:
   `node --test server/utils/presence.test.js`
   `node --test server/utils/presenceScheduler.test.js`
   `node --test server/routes/admin/presence.test.js`
   `node --test server/routes/telegram.test.js`
   `node --test server/routes/admin/settings.badgeCounts.test.js`
2. `cd client && CI=true npx react-scripts build` clean.
3. Manual smoke on dev: strip in both skins + rail + compact density; state menu; leads pill rules (forced off when away, resets on after away->online); pointer follows the derivation table in the spec; drawer totals/log; badge poll does not clobber a fresh mutation (flip a state, wait 60s, confirm it sticks).
4. Full fleet review (sensitive paths: schema.sql, telegram.js, sms.js, middleware/auth.js) + `/second-opinion` at push time per convention.

## Rollout checklist (after deploy, from the spec)

1. Prod schema applies via initDb on boot; verify:
   `SELECT id, email, presence_lead_rank, presence_nudge_channel, presence_nudge_phone, presence_since FROM users WHERE presence_lead_rank IS NOT NULL;`
   Expected: exactly zul@ (rank 1, telegram) and admin@ (rank 2, sms), both with `presence_since`, plus one open away interval each in presence_log.
2. Dallas supplies his cell; run by hand on prod (NEVER the shared 312 GV line):
   `UPDATE users SET presence_nudge_phone = '+1XXXXXXXXXX' WHERE email = 'admin@drbartender.com';`
   Until then, SMS nudges log + Sentry-warn and never stamp, so Dallas cannot be auto-flipped by an undelivered warning.
3. Smoke in prod: flip states in the strip, open the drawer, confirm the pointer.
4. First real 6h desk stint: confirm the nudge arrives (Zul: Telegram; Dallas: SMS) and that replying "yes" (Zul) keeps the state, and silence flips to away 30 min later with the interval closed at the nudge time.
