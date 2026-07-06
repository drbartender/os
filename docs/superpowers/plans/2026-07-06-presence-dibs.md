---
spec: docs/superpowers/specs/2026-07-06-presence-dibs-design.md
lanes:
  - id: presence-dibs
    footprint:
      - server/utils/presence.js
      - server/utils/presence.test.js
      - server/utils/presenceStore.js
      - server/utils/presenceNotify.js
      - server/utils/presenceNotify.test.js
      - server/utils/presenceScheduler.js
      - server/utils/presenceScheduler.test.js
      - server/routes/admin/presence.js
      - server/routes/admin/presence.test.js
      - client/src/components/adminos/PresenceStrip.js
      - client/src/index.css
      - README.md
      - ARCHITECTURE.md
    blockedBy: []
    review: full-fleet   # presenceScheduler.js matches server/utils/*Scheduler.js in sensitive-paths.txt; push adds sensitive re-review + /second-opinion
---

# Presence Dibs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the fallback owner (Dallas, max `presence_lead_rank`) a working leads pill: toggling it on ("dibs") moves the lead pointer to him even while Zul is online-and-taking, and Zul gets a Telegram ping on both edges (grab and release) whenever the pointer actually moves for her.

**Architecture:** One derivation change in the pure helper (`derivePointer`: fallback owner eligible beats the chain), one rank-aware cell in `leadsAfterTransition` (owner's online default is OFF), a new fire-and-forget notifier `presenceNotify.js` (compares before/after strip payloads, looks up the recipient's nudge channel itself), hooked at the three pointer-moving writers: the two mutation routes and the scheduler auto-flip. The pill un-hides on the owner's strip row. No schema change.

**Tech Stack:** Express (raw SQL via `pool.query`), `node:test` suites against the shared dev DB, React 18 admin shell, existing `sendTelegramMessage`/`sendSMS` utils.

## Global Constraints

- Ping copy, verbatim (NO em dashes anywhere): grab = `"<First name> called dibs on leads."`, release = `"<First name> released leads. You're up."`
- Sentry posture: **gated skip** (`{ok:false, skipped:true}` telegram / `dev-skipped*` sid SMS) is silent, NO Sentry; **genuine failure** logs console.warn + Sentry (gated on `SENTRY_DSN_SERVER`); **confirmed send** logs one console line `[presence] dibs <grab|release> ping -> <name>`.
- All three before/after captures are failure-isolated: `.catch(() => null)` on capture, null capture = notifier no-op; a capture failure must never 500 a toggle, abort the sweep loop, or affect a committed flip.
- `notifyDibsEdge` never rejects (internal try/catch) AND every call site attaches `.catch(() => {})`; it is never awaited on a response path.
- Strip payloads exclude `presence_nudge_channel`/`presence_nudge_phone` by design; the notifier looks them up by recipient id itself. NULL channel = silent no-op.
- All SQL parameterized. Client-visible errors stay AppError subclasses. API JSON keys snake_case.
- Server suites run ALONE, one at a time (shared dev DB): `node --test <file>`. Route tests must tolerate the two real backfilled dev rows (ranks 1 and 2): test ranks live at 901/902 (so test user `b` at 902 IS the global fallback owner), unique `presence-test-` emails, never assert array lengths, and release assertions check `lead_owner_id !== ids.b` (never a specific id, because real dev rows' live state can vary).
- Lane worktrees do not carry `.env`: after cutting the lane run `ln -sf ../../os/.env <worktree>/.env` or every DB-backed suite fails ECONNREFUSED 127.0.0.1:5432.
- In-lane commits are checkpoints (squashed at merge): explicit pathspec always, never `git add .`.
- Client gate: `cd client && CI=true npx react-scripts build` must pass (Vercel parity; local lint skips client/).
- Cross-cutting (deliberate no-op): the badge-counts embed (`server/routes/admin/settings.js`, `counts.presence`) is the only other `getStripPayload` consumer; the payload shape is unchanged, so it needs NO edit and shifts to dibs semantics in lockstep. Do not touch settings.js.

---

### Task 1: Pure helpers: dibs derivation + asymmetric online default

**Files:**
- Modify: `server/utils/presence.js:10-36` (derivePointer + leadsAfterTransition)
- Test: `server/utils/presence.test.js`

**Interfaces:**
- Produces: `derivePointer(users)` unchanged signature, new rule: fallback owner (max rank) online-and-taking wins; else lowest-rank eligible; else fallback owner. `leadsAfterTransition(prevState, nextState, currentTaking, isFallbackOwner)` gains a 4th arg; omitted/falsy preserves old behavior (chain users reset ON coming online), truthy resets the owner to OFF coming online.

- [ ] **Step 1: Revise the two existing pointer tests that encode old semantics, and add the new matrix (failing tests first)**

In `server/utils/presence.test.js`, the fixtures are `zul(state, taking)` (id 2, rank 1) and `dal(state, taking)` (id 1, rank 2). Two existing tests set `dal(..., true)` and asserted Zul wins by lowest rank; under dibs the owner-taking case now wins, so revise them to owner-not-taking and add the dibs cases:

```js
// REPLACE the first two pointer tests with:
test('pointer: Zul desk-and-taking wins when the owner is not taking', () => {
  assert.equal(derivePointer([zul('desk', true), dal('desk', false)]), 2);
});
test('pointer: Zul available + taking wins when the owner is not taking', () => {
  assert.equal(derivePointer([zul('available', true), dal('desk', false)]), 2);
});

// ADD after the existing pointer tests:
test('pointer: dibs. owner online-and-taking beats the chain', () => {
  assert.equal(derivePointer([zul('desk', true), dal('desk', true)]), 1);
  assert.equal(derivePointer([zul('desk', true), dal('available', true)]), 1);
});
test('pointer: owner away with toggle stuck true still falls back normally', () => {
  // away is never eligible; stale taking_leads on an away owner must not grab
  assert.equal(derivePointer([zul('desk', true), dal('away', true)]), 2);
});
// The spec's "both away unchanged" case stays covered by the EXISTING test
// 'pointer: both away -> Dallas (fallback = max rank)'; leave it untouched.
test('leads transition: owner online default is OFF, chain user stays ON', () => {
  assert.equal(leadsAfterTransition('away', 'desk', false, true), false);      // owner sits down: no dibs
  assert.equal(leadsAfterTransition('away', 'available', false, true), false);
  assert.equal(leadsAfterTransition('away', 'desk', false, false), true);      // chain user unchanged
  assert.equal(leadsAfterTransition('desk', 'available', true, true), true);   // dibs survives desk<->available
  assert.equal(leadsAfterTransition('available', 'desk', true, true), true);
  assert.equal(leadsAfterTransition('desk', 'away', true, true), false);       // away wipes dibs
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd /home/drbartender/projects/os && node --test server/utils/presence.test.js`
Expected: FAIL — dibs cases return 2 (old lowest-rank rule), owner online default returns true.

- [ ] **Step 3: Implement**

In `server/utils/presence.js`, replace `derivePointer` and `leadsAfterTransition`:

```js
/**
 * Who answers the next lead. Rows are users (any mix of tracked/untracked).
 * eligible = tracked, not away, taking leads. The fallback owner (highest
 * rank, Dallas) eligible = dibs and wins outright; otherwise lowest eligible
 * rank wins (the chain); otherwise the fallback owner owns leads
 * unconditionally. Returns a user id or null when nobody is tracked.
 * Spec: docs/superpowers/specs/2026-07-06-presence-dibs-design.md
 */
function derivePointer(users) {
  const tracked = (users || []).filter(
    (u) => u.presence_lead_rank !== null && u.presence_lead_rank !== undefined
  );
  if (!tracked.length) return null;
  const fallback = tracked.reduce((a, b) => (b.presence_lead_rank > a.presence_lead_rank ? b : a));
  const eligible = tracked
    .filter((u) => u.presence_state !== 'away' && u.presence_taking_leads)
    .sort((a, b) => a.presence_lead_rank - b.presence_lead_rank);
  if (eligible.some((u) => u.id === fallback.id)) return fallback.id; // dibs
  if (eligible.length) return eligible[0].id;
  return fallback.id;
}

/**
 * Taking-leads value after a state transition: away wipes it; coming online
 * from away resets it on for chain users but OFF for the fallback owner (he
 * never takes dibs just by sitting down); desk<->available preserves the
 * explicit choice (dibs survives).
 */
function leadsAfterTransition(prevState, nextState, currentTaking, isFallbackOwner) {
  if (nextState === 'away') return false;
  if (prevState === 'away') return !isFallbackOwner;
  return !!currentTaking;
}
```

- [ ] **Step 4: Run the suite, all green**

Run: `node --test server/utils/presence.test.js`
Expected: PASS (all pointer + transition + bucketing tests).

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/utils/presence.js server/utils/presence.test.js
git commit -m "feat(presence): dibs derivation + owner online default off"
```

---

### Task 2: presenceNotify util (edge detection + channel dispatch)

**Files:**
- Create: `server/utils/presenceNotify.js`
- Test: `server/utils/presenceNotify.test.js`

**Interfaces:**
- Consumes: strip payload shape from `presenceStore.getStripPayload()`: `{ users: [{id, name, state, since, taking_leads, rank}], lead_owner_id }`.
- Produces: `notifyDibsEdge({ actorId, before, after })` async, never rejects, returns nothing. `__setPresenceNotifyDeps({ pool, sendTelegramMessage, sendSMS })` for tests.

- [ ] **Step 1: Write the failing test**

Create `server/utils/presenceNotify.test.js`:

```js
// Deps-injected tests for the dibs-edge notifier: no DB, no network.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { notifyDibsEdge, __setPresenceNotifyDeps } = require('./presenceNotify');

const OWNER = { id: 1, name: 'Dallas', rank: 2 };
const CHAIN = { id: 2, name: 'Zul', rank: 1 };
const payload = (leadOwnerId) => ({
  users: [
    { ...CHAIN, state: 'desk', since: null, taking_leads: true },
    { ...OWNER, state: 'desk', since: null, taking_leads: true },
  ],
  lead_owner_id: leadOwnerId,
});

function makeDeps(overrides = {}) {
  const calls = { tg: [], sms: [], queries: [] };
  __setPresenceNotifyDeps({
    pool: {
      query: async (sql, params) => {
        calls.queries.push(params);
        return { rows: [{ presence_nudge_channel: 'telegram', presence_nudge_phone: null }] };
      },
    },
    sendTelegramMessage: async (chat, text) => { calls.tg.push(text); return { ok: true }; },
    sendSMS: async ({ to, body }) => { calls.sms.push({ to, body }); return { sid: 'SM1' }; },
    ...overrides,
  });
  return calls;
}

beforeEach(() => {
  process.env.TELEGRAM_ALLOWED_USER_ID = '777';
  delete process.env.SENTRY_DSN_SERVER; // Sentry capture must never fire in tests
});

test('grab: owner takes pointer from chain user, chain user pinged with dibs copy', async () => {
  const calls = makeDeps();
  await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) });
  assert.equal(calls.tg.length, 1);
  assert.equal(calls.tg[0], 'Dallas called dibs on leads.');
  assert.deepEqual(calls.queries[0], [2]); // recipient lookup is the before-owner
});

test('release: pointer returns to chain user with release copy', async () => {
  const calls = makeDeps();
  await notifyDibsEdge({ actorId: 1, before: payload(1), after: payload(2) });
  assert.equal(calls.tg.length, 1);
  assert.equal(calls.tg[0], "Dallas released leads. You're up.");
});

test('silent: no pointer change; non-owner actor; null captures; NULL channel', async () => {
  let calls = makeDeps();
  await notifyDibsEdge({ actorId: 1, before: payload(1), after: payload(1) });
  assert.equal(calls.tg.length, 0);

  calls = makeDeps();
  await notifyDibsEdge({ actorId: 2, before: payload(2), after: payload(1) }); // Zul going away is silent
  assert.equal(calls.tg.length, 0);

  calls = makeDeps();
  await notifyDibsEdge({ actorId: 1, before: null, after: payload(1) });
  await notifyDibsEdge({ actorId: 1, before: payload(2), after: null });
  assert.equal(calls.tg.length, 0);

  calls = makeDeps({
    pool: { query: async () => ({ rows: [{ presence_nudge_channel: null, presence_nudge_phone: null }] }) },
  });
  await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) });
  assert.equal(calls.tg.length, 0);
});

test('sms channel dispatches to presence_nudge_phone', async () => {
  const calls = makeDeps({
    pool: { query: async () => ({ rows: [{ presence_nudge_channel: 'sms', presence_nudge_phone: '+15551234567' }] }) },
  });
  await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) });
  assert.equal(calls.sms.length, 1);
  assert.equal(calls.sms[0].to, '+15551234567');
  assert.match(calls.sms[0].body, /called dibs on leads/);
});

test('never rejects, and warns only on genuine failure (gated skip is silent)', async () => {
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    let calls = makeDeps({ sendTelegramMessage: async () => { throw new Error('boom'); } });
    await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) }); // must not throw
    assert.equal(warns.length, 1); // genuine failure reported
    assert.match(warns[0], /dibs grab ping failed/);

    calls = makeDeps({ pool: { query: async () => { throw new Error('db down'); } } });
    await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) }); // must not throw
    assert.equal(warns.length, 2); // lookup failure reported too

    calls = makeDeps({
      sendTelegramMessage: async (chat, text) => { calls.tg.push(text); return { ok: false, skipped: true }; },
    });
    await notifyDibsEdge({ actorId: 1, before: payload(2), after: payload(1) });
    assert.equal(calls.tg.length, 1); // send attempted, result skipped, no crash
    assert.equal(warns.length, 2);   // gated skip: NO new warn, no Sentry
  } finally {
    console.warn = realWarn;
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test server/utils/presenceNotify.test.js`
Expected: FAIL, `Cannot find module './presenceNotify'`.

- [ ] **Step 3: Implement**

Create `server/utils/presenceNotify.js`:

```js
// Dibs-edge notifier (spec 2026-07-06-presence-dibs-design.md): when a
// mutation BY the fallback owner moves the lead pointer, ping the user it
// moved off/onto via their nudge channel. Fire-and-forget: never rejects,
// never blocks the mutation. Gated skips are silent; only genuine send
// failures warn + Sentry; confirmed sends log one audit line.
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const telegram = require('./telegram');
const sms = require('./sms');

let _deps = { pool, sendTelegramMessage: telegram.sendTelegramMessage, sendSMS: sms.sendSMS };
function __setPresenceNotifyDeps(d) { _deps = { ..._deps, ...d }; }

function reportFailure(recipientId, edge, why) {
  console.warn(`[presence] dibs ${edge} ping failed for user ${recipientId} (${why}); not retried`);
  if (process.env.SENTRY_DSN_SERVER) {
    Sentry.captureMessage('presence dibs ping undelivered', {
      level: 'warning',
      tags: { feature: 'presence-dibs' },
      extra: { recipient_id: recipientId, edge, why },
    });
  }
}

async function notifyDibsEdge({ actorId, before, after }) {
  let edge = 'unknown';
  let recipientId = null;
  try {
    if (!before || !after) return;
    if (before.lead_owner_id === after.lead_owner_id) return;
    const users = after.users || [];
    if (!users.length) return;
    const maxRank = Math.max(...users.map((u) => u.rank));
    const actor = users.find((u) => u.id === actorId);
    if (!actor || actor.rank !== maxRank) return; // only the fallback owner's edges ping
    if (after.lead_owner_id === actorId) { edge = 'grab'; recipientId = before.lead_owner_id; }
    else if (before.lead_owner_id === actorId) { edge = 'release'; recipientId = after.lead_owner_id; }
    else return;
    if (recipientId === null || recipientId === undefined || recipientId === actorId) return;

    const first = String(actor.name || '').split(' ')[0] || 'The owner';
    const text = edge === 'grab'
      ? `${first} called dibs on leads.`
      : `${first} released leads. You're up.`;

    // Strip payloads exclude channel/phone by design (they go to the client).
    const r = await _deps.pool.query(
      'SELECT presence_nudge_channel, presence_nudge_phone FROM users WHERE id = $1',
      [recipientId]
    );
    const row = r.rows[0];
    if (!row || !row.presence_nudge_channel) return; // never-nudged user: silent

    let confirmed = false;
    let skipped = false;
    let why = 'unknown';
    if (row.presence_nudge_channel === 'telegram') {
      if (!process.env.TELEGRAM_ALLOWED_USER_ID) {
        why = 'TELEGRAM_ALLOWED_USER_ID unset';
      } else {
        const res = await _deps.sendTelegramMessage(process.env.TELEGRAM_ALLOWED_USER_ID, text);
        confirmed = !!(res && res.ok === true);
        skipped = !!(res && res.skipped);
        if (!confirmed && !skipped) why = 'telegram send failed';
      }
    } else if (row.presence_nudge_channel === 'sms') {
      if (!row.presence_nudge_phone) {
        why = 'presence_nudge_phone unset';
      } else {
        const m = await _deps.sendSMS({
          to: row.presence_nudge_phone,
          body: text,
          meta: { type: 'presence_dibs', user_id: recipientId },
        });
        if (m && m.sid && !String(m.sid).startsWith('dev-skipped')) confirmed = true;
        else if (m && m.sid) skipped = true; // dev-skipped: gated off
        else why = 'sms send failed';
      }
    } else {
      return; // unknown channel value: silent (CHECK constraint should prevent)
    }

    if (confirmed) {
      const recipient = users.find((u) => u.id === recipientId);
      console.log(`[presence] dibs ${edge} ping -> ${recipient ? recipient.name : `user ${recipientId}`}`);
    } else if (!skipped) reportFailure(recipientId, edge, why);
  } catch (err) {
    reportFailure(recipientId, edge, err.message);
  }
}

module.exports = { notifyDibsEdge, __setPresenceNotifyDeps };
```

- [ ] **Step 4: Run the suite, all green**

Run: `node --test server/utils/presenceNotify.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/utils/presenceNotify.js server/utils/presenceNotify.test.js
git commit -m "feat(presence): dibs-edge notifier with skip-vs-failure posture"
```

---

### Task 3: Store fallback-owner awareness + route hooks

**Files:**
- Modify: `server/utils/presenceStore.js:43-50` (transitionState SELECT + leadsAfterTransition call)
- Modify: `server/routes/admin/presence.js:23-39` (before-capture + notify hook on both POSTs)
- Test: `server/routes/admin/presence.test.js`

**Interfaces:**
- Consumes: `leadsAfterTransition(prev, next, taking, isFallbackOwner)` from Task 1; `notifyDibsEdge` from Task 2.
- Produces: `POST /api/admin/presence/state` and `POST /api/admin/presence/leads` behave as today plus: owner's away->online transition resets `taking_leads` to false; both POSTs fire `notifyDibsEdge` fire-and-forget.

- [ ] **Step 1: Write the failing route tests**

Add to `server/routes/admin/presence.test.js` (harness as-is: `a` = rank 901 chain user, `b` = rank 902 = the global fallback owner; real dev rows sit at ranks 1/2 so never assert exact ids on release, only `!== ids.b`). The suite needs the notifier observable: at the top, add

```js
const { __setPresenceNotifyDeps } = require('../../utils/presenceNotify');
```

and in `before()` (after `makeUser` calls), inject fakes recording sends:

```js
notifySends = [];
process.env.TELEGRAM_ALLOWED_USER_ID = process.env.TELEGRAM_ALLOWED_USER_ID || '777';
__setPresenceNotifyDeps({
  // Fake pool: the recipient can resolve to a REAL dev row (ranks 1/2 sit
  // below the 901/902 test rows), and a real row's channel may be NULL.
  // Pin the lookup so ping assertions never depend on live dev-row state.
  pool: { query: async () => ({ rows: [{ presence_nudge_channel: 'telegram', presence_nudge_phone: null }] }) },
  sendTelegramMessage: async (chat, text) => { notifySends.push(text); return { ok: true }; },
  sendSMS: async ({ body }) => { notifySends.push(body); return { sid: 'SM-test' }; },
});
```

(declare `let notifySends = [];` at module scope). New tests:

```js
test('dibs: owner coming online defaults taking_leads OFF; chain user defaults ON', async () => {
  let r = await post('/api/admin/presence/state', tokens.a, { state: 'desk' });
  assert.equal(r.status, 200);
  assert.equal(findUser(r.body, 'a').taking_leads, true);
  r = await post('/api/admin/presence/state', tokens.b, { state: 'desk' });
  assert.equal(r.status, 200);
  assert.equal(findUser(r.body, 'b').taking_leads, false); // asymmetric default
  assert.notEqual(r.body.lead_owner_id, ids.b); // sitting down never grabs
});

test('dibs: owner toggle grabs the pointer, pings the displaced user, release returns it', async () => {
  notifySends = [];
  let r = await post('/api/admin/presence/leads', tokens.b, { taking: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.lead_owner_id, ids.b); // dibs beats every chain user
  r = await post('/api/admin/presence/leads', tokens.b, { taking: false });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.lead_owner_id, ids.b); // release: someone eligible exists (user a is desk+taking)
  // fire-and-forget: give the un-awaited hook a tick to run
  await new Promise((res) => setTimeout(res, 50));
  assert.equal(notifySends.some((t) => /called dibs on leads/.test(t)), true);
  assert.equal(notifySends.some((t) => /released leads/.test(t)), true);
});

test('dibs: owner going away releases (pointer leaves him)', async () => {
  await post('/api/admin/presence/leads', tokens.b, { taking: true });
  const r = await post('/api/admin/presence/state', tokens.b, { state: 'away' });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.lead_owner_id, ids.b);
  assert.equal(findUser(r.body, 'b').taking_leads, false); // away wiped dibs
});

test('dibs: failing before-capture does not fail the mutation', async () => {
  const real = store.getStripPayload;
  let first = true;
  store.getStripPayload = async () => {
    if (first) { first = false; throw new Error('capture hiccup'); }
    return real();
  };
  try {
    const r = await post('/api/admin/presence/state', tokens.b, { state: 'desk' });
    assert.equal(r.status, 200); // mutation unharmed
  } finally {
    store.getStripPayload = real;
  }
});
```

Ordering note: these tests run in file order and share DB state; keep them after the existing transition tests and leave `b` at `desk` when a test needs a follow-on state (each test above sets what it needs explicitly).

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test server/routes/admin/presence.test.js` (the harness self-loads dotenv at line 1)
Expected: FAIL — owner default is still ON (asymmetry unimplemented), grab does not move `lead_owner_id`, no notify sends recorded.

- [ ] **Step 3: Implement the store change**

In `server/utils/presenceStore.js` `transitionState`, replace the FOR UPDATE select and the `leadsAfterTransition` call:

```js
    const cur = await client.query(
      `SELECT presence_state, presence_taking_leads,
              presence_lead_rank = (SELECT MAX(presence_lead_rank) FROM users
                                    WHERE presence_lead_rank IS NOT NULL) AS is_fallback_owner
       FROM users WHERE id = $1 AND presence_lead_rank IS NOT NULL FOR UPDATE`,
      [userId]
    );
    if (!cur.rows[0]) throw new ValidationError(null, 'Not a presence-tracked user');
    const { presence_state: prev, presence_taking_leads: taking, is_fallback_owner: isOwner } = cur.rows[0];
    if (prev === nextState) { await client.query('ROLLBACK'); return; }
    const nextTaking = leadsAfterTransition(prev, nextState, taking, isOwner);
```

(The scalar subquery in the SELECT list is legal alongside `FOR UPDATE`; the row lock applies to the outer `users` row as before. `setTakingLeads` needs no change: explicit toggles carry the caller's intent for both users.)

- [ ] **Step 4: Implement the route hooks**

In `server/routes/admin/presence.js`: add the import and hook both POSTs.

```js
const { notifyDibsEdge } = require('../../utils/presenceNotify');
```

```js
router.post('/presence/state', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  requireTracked(req);
  const { state } = req.body || {};
  if (!PRESENCE_STATES.includes(state)) {
    throw new ValidationError(null, 'state must be one of desk, available, away');
  }
  // Failure-isolated pre-capture for the dibs-edge ping; never blocks the mutation.
  const before = await store.getStripPayload().catch(() => null);
  await store.transitionState(req.user.id, state);
  const payload = await store.getStripPayload();
  notifyDibsEdge({ actorId: req.user.id, before, after: payload }).catch(() => {});
  res.json(payload);
}));

router.post('/presence/leads', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  requireTracked(req);
  const { taking } = req.body || {};
  if (typeof taking !== 'boolean') throw new ValidationError(null, 'taking must be a boolean');
  const before = await store.getStripPayload().catch(() => null);
  await store.setTakingLeads(req.user.id, taking);
  const payload = await store.getStripPayload();
  notifyDibsEdge({ actorId: req.user.id, before, after: payload }).catch(() => {});
  res.json(payload);
}));
```

- [ ] **Step 5: Run the suite, all green (alone, shared dev DB)**

Run: `node --test server/routes/admin/presence.test.js`
Expected: PASS, all existing + 4 new tests.

- [ ] **Step 6: Run the store's other consumer suite for regressions**

Run: `node --test server/utils/presence.test.js`
Expected: PASS (unchanged).

- [ ] **Step 7: Checkpoint commit**

```bash
git add server/utils/presenceStore.js server/routes/admin/presence.js server/routes/admin/presence.test.js
git commit -m "feat(presence): owner-aware transitions + dibs notify hooks on mutation routes"
```

---

### Task 4: Scheduler auto-flip hook

**Files:**
- Modify: `server/utils/presenceScheduler.js:11-19` (deps) and `:82-87` (flip branch)
- Test: `server/utils/presenceScheduler.test.js`

**Interfaces:**
- Consumes: `notifyDibsEdge` (Task 2), `store.getStripPayload`.
- Produces: an auto-flip that moved the pointer emits the release ping (via `notifyDibsEdge`; rule 2 filters non-owner flips). Sensitive path: `server/utils/*Scheduler.js` — keep the diff minimal and behavior-inert for the nudge pass.

- [ ] **Step 1: Write the failing tests**

In `server/utils/presenceScheduler.test.js`, extend `makeDeps` with the two new deps (defaults keep every existing test valid):

```js
function makeDeps(rows, overrides = {}) {
  const calls = { stamped: [], flipped: [], tg: [], sms: [], notified: [], captures: 0 };
  __setPresenceSchedulerDeps({
    now: () => NOW,
    findSweepRows: async () => rows,
    stampNudged: async (id) => calls.stamped.push(id),
    applyAutoFlip: async (args) => { calls.flipped.push(args); return true; },
    lastActivityMs: () => null,
    sendTelegramMessage: async (chat, text) => { calls.tg.push(text); return { ok: true }; },
    sendSMS: async ({ to, body }) => { calls.sms.push(to); return { sid: 'SM123' }; },
    getStripPayload: async () => { calls.captures += 1; return { users: [], lead_owner_id: null }; },
    notifyDibsEdge: async (args) => calls.notified.push(args),
    ...overrides,
  });
  return calls;
}
```

New tests (place after the existing flip tests; `dueDesk` + `iso` helpers as-is):

```js
test('flip: successful flip captures before/after and calls notifyDibsEdge with the flipped user as actor', async () => {
  const row = dueDesk({ nudged_at: iso(FLIP_GRACE_MS + 60000) });
  const calls = makeDeps([row]);
  await sweepPresence();
  assert.equal(calls.flipped.length, 1);
  assert.equal(calls.captures, 2); // before + after
  assert.equal(calls.notified.length, 1);
  assert.equal(calls.notified[0].actorId, row.user_id);
  assert.ok('before' in calls.notified[0] && 'after' in calls.notified[0]);
});

test('flip: race-aborted flip (applyAutoFlip false) does not notify', async () => {
  const row = dueDesk({ nudged_at: iso(FLIP_GRACE_MS + 60000) });
  const calls = makeDeps([row], { applyAutoFlip: async () => false });
  await sweepPresence();
  assert.equal(calls.notified.length, 0);
});

test('flip: composed with the REAL notifier, owner flip with chain user online sends the release ping; chain user away sends nothing', async () => {
  // Integration of sweep -> notifyDibsEdge semantics (spec: Scheduler test
  // addition). Real notifier, fake senders + fake recipient lookup.
  const { notifyDibsEdge, __setPresenceNotifyDeps } = require('./presenceNotify');
  const sent = [];
  __setPresenceNotifyDeps({
    pool: { query: async () => ({ rows: [{ presence_nudge_channel: 'telegram', presence_nudge_phone: null }] }) },
    sendTelegramMessage: async (chat, text) => { sent.push(text); return { ok: true }; },
    sendSMS: async () => ({ sid: 'SM-x' }),
  });
  const OWNER = { id: 1, name: 'Dallas', rank: 2, state: 'desk', since: null, taking_leads: true };
  const CHAIN = { id: 2, name: 'Zul', rank: 1, state: 'desk', since: null, taking_leads: true };
  const row = dueDesk({ id: 20, user_id: 1, nudged_at: iso(FLIP_GRACE_MS + 60000) });

  // Chain user online: pointer moves 1 -> 2 on the owner's flip => release ping.
  let payloads = [
    { users: [CHAIN, OWNER], lead_owner_id: 1 },                                        // before
    { users: [CHAIN, { ...OWNER, state: 'away', taking_leads: false }], lead_owner_id: 2 }, // after
  ];
  makeDeps([row], {
    getStripPayload: async () => payloads.shift(),
    notifyDibsEdge, // the real one
  });
  await sweepPresence();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], "Dallas released leads. You're up.");

  // Chain user away: pointer stays with the owner (fallback) => nothing fires.
  const awayChain = { ...CHAIN, state: 'away', taking_leads: false };
  payloads = [
    { users: [awayChain, OWNER], lead_owner_id: 1 },
    { users: [awayChain, { ...OWNER, state: 'away', taking_leads: false }], lead_owner_id: 1 },
  ];
  makeDeps([row], { getStripPayload: async () => payloads.shift(), notifyDibsEdge });
  await sweepPresence();
  assert.equal(sent.length, 1); // no new send
});

test('flip: throwing capture is isolated; flip still applies and sweep continues to next row', async () => {
  const rows = [
    dueDesk({ nudged_at: iso(FLIP_GRACE_MS + 60000) }),
    dueDesk({ id: 12, user_id: 3, nudged_at: iso(FLIP_GRACE_MS + 60000) }),
  ];
  const calls = makeDeps(rows, { getStripPayload: async () => { throw new Error('db down'); } });
  await sweepPresence(); // must not throw
  assert.equal(calls.flipped.length, 2); // both rows still flipped
  // notifier still invoked with null captures (it no-ops internally)
  assert.equal(calls.notified.every((n) => n.before === null && n.after === null), true);
});
```

(The dibs-edge SEMANTICS under auto-flip — chain user online gets "You're up", chain user away gets nothing — are covered by `presenceNotify.test.js` payload fixtures in Task 2; the scheduler tests only pin the wiring: capture, actor identity, isolation, and race-abort.)

- [ ] **Step 2: Run to verify the new tests fail**

Run: `node --test server/utils/presenceScheduler.test.js`
Expected: new tests FAIL (`calls.captures` 0, `notified` empty); existing tests PASS.

- [ ] **Step 3: Implement**

In `server/utils/presenceScheduler.js`: add to imports `const presenceNotify = require('./presenceNotify');`, extend `_deps`:

```js
  getStripPayload: store.getStripPayload,
  notifyDibsEdge: presenceNotify.notifyDibsEdge,
```

Replace the flip branch inside `sweepPresence` (nudge pass untouched):

```js
    if (isFlipDue(row, lastSeenMs, now)) {
      // Failure-isolated dibs-edge captures: a capture error must never abort
      // the sweep or the flip. Unconditional (findSweepRows has no rank);
      // notifyDibsEdge rule 2 filters non-owner flips. Spec 2026-07-06.
      const before = await _deps.getStripPayload().catch(() => null);
      const flipped = await _deps.applyAutoFlip({ intervalId: row.id, userId: row.user_id });
      if (flipped) {
        console.log(`[presence] auto-flipped ${row.name} to away (nudged ${new Date(row.nudged_at).toISOString()}, no sign of life)`);
        const after = await _deps.getStripPayload().catch(() => null);
        await _deps.notifyDibsEdge({ actorId: row.user_id, before, after }).catch(() => {});
      }
    }
```

- [ ] **Step 4: Run the suite, all green**

Run: `node --test server/utils/presenceScheduler.test.js`
Expected: PASS (existing 8 + 4 new).

- [ ] **Step 5: Checkpoint commit**

```bash
git add server/utils/presenceScheduler.js server/utils/presenceScheduler.test.js
git commit -m "feat(presence): release ping on owner auto-flip"
```

---

### Task 5: Strip UI: pill on the owner's row

**Files:**
- Modify: `client/src/components/adminos/PresenceStrip.js:93-101`
- Modify (only if needed): `client/src/index.css` (pill width; likely no change)

**Interfaces:**
- Consumes: strip payload as today (`u.rank`, `maxRank` already computed at line 71).
- Produces: leads pill on every tracked row; owner's lit pill reads "dibs".

- [ ] **Step 1: Implement**

Replace the pill block (drop the `u.rank < maxRank &&` wrapper):

```jsx
            <button
              type="button"
              className={`presence-leads-pill${u.taking_leads ? ' on' : ''}`}
              disabled={!own || u.state === 'away' || busy}
              onClick={() => own && mutate('/admin/presence/leads', { taking: !u.taking_leads })}
              title={
                u.rank === maxRank
                  ? (u.taking_leads ? 'Dibs on leads' : 'Not taking leads')
                  : (u.taking_leads ? 'Taking leads' : 'Not taking leads')
              }
            >{u.rank === maxRank && u.taking_leads ? 'dibs' : 'leads'}</button>
```

(Self-only + not-away + busy rules identical to the chain row; the owner's unlit pill reads "leads" like today, lit reads "dibs". No em dashes in any label.)

- [ ] **Step 2: Client build gate (Vercel parity)**

Run: `cd client && CI=true npx react-scripts build`
Expected: compiles with no ESLint warnings-as-errors.

- [ ] **Step 3: Eyeball in the running dev shell**

The dev server is Claude-managed and does NOT auto-reload server code, but this task is client-only; CRA dev server hot-reloads. Verify in both skins + rail mode: pill renders on both rows, owner row toggles, pointer line follows.

- [ ] **Step 4: Checkpoint commit**

```bash
git add client/src/components/adminos/PresenceStrip.js
git commit -m "feat(presence): dibs pill on the fallback owner's strip row"
```

(add `client/src/index.css` to the pathspec only if it was touched)

---

### Task 6: Docs + full verification sweep

**Files:**
- Modify: `README.md` (folder tree: `presenceNotify.js` beside `presenceScheduler.js`)
- Modify: `ARCHITECTURE.md` (presence section: dibs override + two-edge ping)

**Interfaces:** none (docs + verification only).

- [ ] **Step 1: README tree**

Find the presence utils in the folder tree (`grep -n presenceScheduler README.md`) and add the sibling line:

```
│   │   ├── presenceNotify.js        # Dibs-edge Telegram/SMS ping (fire-and-forget)
```

(match the tree's existing indentation/comment style at that spot).

- [ ] **Step 2: ARCHITECTURE presence section**

Find the presence tracker paragraph (`grep -n "presence" ARCHITECTURE.md`) and append:

```
Dibs (2026-07-06): the fallback owner (max presence_lead_rank) online-and-taking
beats the chain in derivePointer; his online default for taking_leads is false.
When his toggle/transition/auto-flip moves the pointer, presenceNotify.js pings
the displaced/receiving user via their nudge channel (grab: "called dibs on
leads", release: "released leads. You're up"); gated skips are silent, genuine
send failures warn + Sentry.
```

- [ ] **Step 3: Full presence-suite verification, one suite at a time**

```bash
node --test server/utils/presence.test.js
node --test server/utils/presenceNotify.test.js
node --test server/utils/presenceScheduler.test.js
node --test server/routes/admin/presence.test.js
node --test server/utils/presenceActivity.test.js
node --test server/routes/telegram.test.js
```

Expected: every suite PASS (the last two are untouched but share the presence seam; run them to prove it).

- [ ] **Step 4: Checkpoint commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(presence): dibs override + notifier"
```

---

## Post-lane (not tasks; the standing workflow)

- Full-fleet per-lane review before merge (sensitive path: `presenceScheduler.js`).
- Squash-merge via `scripts/merge-lane.sh`; lane cleanup after the three branch-D checks.
- Live smoke on the restarted dev server (managed backend does NOT auto-reload): login as both tracked users, grab/release, watch `[presence] dibs ... ping` lines (dev sends are gated: expect the `[DEV] Telegram message skipped` line instead of a real send).
- At deploy: run the one-time prod UPDATE from the spec's Rollout section (owner `taking_leads` reset; NOT in schema.sql), then the smoke from Rollout step 3.
