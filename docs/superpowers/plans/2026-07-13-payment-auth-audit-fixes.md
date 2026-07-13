# Payment + Auth Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six remaining findings from the 2026-07-11 payment/auth audit (F4 already fixed in `46e969b`) with surgical, minimal-first fixes that protect the working money paths — no rewrite.

**Architecture:** Five independent lanes (A–E) over disjoint files. Lane A introduces one small shared helper (`autopayDurableCharge`); every other lane mirrors an existing proven pattern (`crud.js` reconcile, the clawback ledger, the codebase's own positive-link discriminator). The webhook credit math is never touched.

**Tech Stack:** Node/Express 4, Postgres (raw parameterized SQL via `pg`), Stripe (Payment Intents + off-session autopay), JWT (HS256), `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-13-payment-auth-audit-fixes-design.md`

## Global Constraints

- **os never leaves main.** Each lane is a throwaway worktree cut at execution time, squash-merged back through the os lock. (CLAUDE.md git-safety.)
- **Money units:** `proposals.total_price`/`amount_paid` are DOLLARS; `invoices`/`tips`/Stripe/`stripe_sessions` amounts are CENTS.
- **One-connection-per-request:** a handler holding a `pool.connect()` client routes every query through that client until `release()`; release before any post-COMMIT helper that takes its own pooled connection. (2026-07-13 rule; each lane states whether it applies.)
- **Idempotency:** every Stripe-event-driven or retryable write is a no-op on redelivery (`ON CONFLICT` / marker-gated `UPDATE`).
- **Do NOT touch the webhook credit math** (`paymentIntentSucceeded.js` / `checkoutSessionCompleted.js` money branches).
- **Tests:** `node:test`; run ONE suite at a time (`node -r dotenv/config --test <file>`); each suite refuses to run under `NODE_ENV=production`; Stripe stubbed via DI, never real; `SEND_NOTIFICATIONS`/`RUN_SCHEDULERS` default OFF in non-prod.
- **Review:** every money/auth lane is a sensitive path → full review fleet + `/second-opinion` at push. In-lane commits are checkpoints; the squash merge is the unit of intent.
- **Commit trailer:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Lane map (front-matter)

```yaml
lanes:
  - id: A
    title: Autopay durable charge record (F1)
    footprint:
      - server/utils/autopayDurableCharge.js
      - server/utils/balanceScheduler.js
      - server/routes/stripe.js
      - server/utils/autopayDurableCharge.test.js
      - server/utils/balanceScheduler.autopayDurable.test.js
      - server/routes/stripe.chargeBalanceDurable.test.js
    deps: []
    review: [money-fleet, second-opinion]
  - id: B
    title: Drink-plan submit payment-status reconcile (F2)
    footprint:
      - server/routes/drinkPlans/submit.js
      - server/routes/drinkPlans/submitReconcile.test.js
    deps: []
    review: [money-fleet, second-opinion]
  - id: C
    title: Dispute-won ledger rewind (F5)
    footprint:
      - server/db/schema.sql
      - server/utils/payrollClawback.js
      - server/routes/stripeWebhookHandlers/disputes.js
      - server/utils/payrollDisputeRewind.test.js
      - ARCHITECTURE.md
    deps: []
    review: [money-fleet, second-opinion]
  - id: D
    title: Auth hardening — qa-seed gate + OTP neutral (F3, F6)
    footprint:
      - server/index.js
      - server/utils/qaMount.js
      - server/utils/qaMount.test.js
      - server/routes/clientAuth.js
      - server/routes/clientAuth.otpNeutral.test.js
      - README.md
    deps: []
    review: [auth-fleet, second-opinion]
  - id: E
    title: invoice_payments uniqueness (F7)
    footprint:
      - server/db/schema.sql
      - server/utils/invoicePaymentsUniqueLink.test.js
    deps: []
    review: [full-fleet, second-opinion]
```

**Parallelism & sequencing.** A, B, D are fully independent and parallel. C and E both append to `server/db/schema.sql` — build in parallel, but serialize their *merges* through the os lock (the merge model already enforces this). Their edits append distinct statements to different regions (C: a `tips` column after line 2808; E: an `invoice_payments` index after line 1889), so no textual conflict is expected; if one lands first, the other rebases trivially. No lane blocks another.

**Prod-deploy gates (carry into the push checklist).**
- **E (F7):** before shipping, run the duplicate-positive-link probe against prod (read-only) and confirm zero rows — `initDb` runs `CREATE UNIQUE INDEX` on boot, so a pre-existing double-link would block boot. (Query in Lane E → Task E1 → prod note.)
- **C (F5):** `disputes.js` is server code; the Claude-managed dev backend does not auto-reload — restart to exercise the wired handler locally; prod picks it up on deploy.

---
## Lane A — Autopay durable charge record (F1)

**Footprint:** `server/utils/autopayDurableCharge.js`, `server/utils/autopayDurableCharge.test.js`, `server/utils/balanceScheduler.js`, `server/utils/balanceScheduler.autopayDurable.test.js`, `server/routes/stripe.js`, `server/routes/stripe.chargeBalanceDurable.test.js` — **Deps:** none (foundational; no lane blocks it) — **Review:** full money/payments fleet + `/second-opinion` (sensitive paths: Stripe charge path + autopay scheduler).

**Shared test conventions (apply to every task in this lane):**
- `const { test, before, after } = require('node:test'); const assert = require('node:assert/strict');`
- Run ONE suite at a time (shared dev DB FK-collides on parallel teardown): `node -r dotenv/config --test server/<path>/<name>.test.js`
- Every suite `require('dotenv').config()` at the top and refuses to run when `NODE_ENV === 'production'`.
- `SEND_NOTIFICATIONS`/`RUN_SCHEDULERS` are OFF outside prod, so no real email/SMS/scheduler side effects fire. Stripe is stubbed via a local fake object — **never** hit real Stripe.
- **One-connection rule N/A here:** both the scheduler and the charge-balance route use bare `pool.query()` throughout (neither holds a `pool.connect()` client). The new helper defaults `db = pool`. This lane adds no transaction boundary, so there is no held-client hazard.
- **Money units:** `proposals.total_price`/`amount_paid` are DOLLARS; `stripe_sessions.amount` and Stripe amounts are CENTS. `balanceCents = Math.round((total_price − amount_paid) * 100)`.
- **Idempotency:** the durable insert uses `ON CONFLICT (stripe_payment_intent_id) DO NOTHING` (no-op on Stripe retry/redelivery); the shared idempotency key `autopay-balance-<id>-<dueIso>` is unchanged; the stale-reclaim guard makes a >24h-outage re-fire a no-op.

---

### Task A1 — Shared durable-charge helper (the (a) insert + (b) guard, pure-DI, unit-tested)

**Files**
- **Create** `server/utils/autopayDurableCharge.js` (new, ~55 lines)
- **Test** `server/utils/autopayDurableCharge.test.js` (new)

**Interfaces**
- **Produces** `recordBalanceIntent({ proposalId, intentId, amountCents }, db = pool) → Promise<void>` — durable `stripe_sessions` insert, `ON CONFLICT (stripe_payment_intent_id) DO NOTHING`.
- **Produces** `priorBalanceChargeSettling({ proposalId, amountCents, stripe }, db = pool) → Promise<{ skip, reason, priorIntentId?, priorStatus? }>` — `skip:true` when the prior balance intent for this proposal+amount is `succeeded`/`processing` at Stripe (or unretrievable → lean money-safe), else `skip:false`.
- **Consumes** `stripe.paymentIntents.retrieve(id)` (injected — the caller passes its own `getStripe()` client); `pool.query` from `../db`.
- **Consumes** `stripe_sessions(proposal_id, stripe_payment_intent_id, amount, status)` — schema at `server/db/schema.sql:907`; unique index on `stripe_payment_intent_id` at `:910`. Note: `stripe_sessions` has **no** `payment_type`/`due_date` column, so `amount` (a fixed dollar figure per balance-due-date) plus the retrieved `metadata.payment_type === 'balance'` check is the money-scoping proxy for "this balance."

**Steps**

1. **Write the failing test** `server/utils/autopayDurableCharge.test.js`:

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { recordBalanceIntent, priorBalanceChargeSettling } = require('./autopayDurableCharge');

if (process.env.NODE_ENV === 'production') {
  throw new Error('autopayDurableCharge.test.js refuses to run against production');
}

const MARK = `adc-${Date.now()}`;
let propId;

// Fake Stripe — retrieve answers from a canned map; a missing id throws like Stripe.
function fakeStripe(intentsById) {
  return { paymentIntents: { retrieve: async (id) => {
    if (!intentsById[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
    return intentsById[id];
  } } };
}

before(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_type, total_price, amount_paid, balance_due_date)
     VALUES (NULL, 'deposit_paid', $1, 1000, 900, CURRENT_DATE) RETURNING id`,
    [`${MARK}-type`]
  );
  propId = p.rows[0].id;
});

after(async () => {
  if (propId) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [propId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [propId]);
  }
  await pool.end();
});

test('recordBalanceIntent > inserts one durable pending row; redelivery is a no-op', async () => {
  const intentId = `pi_${MARK}_dur`;
  await recordBalanceIntent({ proposalId: propId, intentId, amountCents: 10000 });
  await recordBalanceIntent({ proposalId: propId, intentId, amountCents: 10000 }); // ON CONFLICT DO NOTHING
  const { rows } = await pool.query(
    `SELECT amount, status FROM stripe_sessions WHERE stripe_payment_intent_id = $1`, [intentId]
  );
  assert.equal(rows.length, 1, 'exactly one durable row (idempotent on redelivery)');
  assert.equal(Number(rows[0].amount), 10000);
  assert.equal(rows[0].status, 'pending');
});

test('priorBalanceChargeSettling > SKIP when the prior balance intent is succeeded (webhook down)', async () => {
  const priorId = `pi_${MARK}_succ`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 25000, 'pending')`, [propId, priorId]
  );
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'succeeded', metadata: { payment_type: 'balance' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 25000, stripe });
  assert.equal(r.skip, true);
  assert.equal(r.priorStatus, 'succeeded');
});

test('priorBalanceChargeSettling > CHARGE when the prior balance intent is terminal (requires_payment_method)', async () => {
  const priorId = `pi_${MARK}_reqpm`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 26000, 'pending')`, [propId, priorId]
  );
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'requires_payment_method', metadata: { payment_type: 'balance' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 26000, stripe });
  assert.equal(r.skip, false, 'a canceled/requires_payment_method prior intent must NOT block a re-charge');
});

test('priorBalanceChargeSettling > CHARGE when no prior balance row exists (absent = fresh charge)', async () => {
  const stripe = fakeStripe({});
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 99999, stripe });
  assert.equal(r.skip, false);
  assert.equal(r.reason, 'absent');
});

test('priorBalanceChargeSettling > CHARGE when the amount-matching row is NOT a balance intent', async () => {
  const priorId = `pi_${MARK}_dep`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 27000, 'pending')`, [propId, priorId]
  );
  const stripe = fakeStripe({ [priorId]: { id: priorId, status: 'succeeded', metadata: { payment_type: 'deposit' } } });
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 27000, stripe });
  assert.equal(r.skip, false, 'an amount-collision with a non-balance intent must not skip the balance charge');
  assert.equal(r.reason, 'not_balance');
});

test('priorBalanceChargeSettling > SKIP (money-safe) when the prior intent cannot be retrieved', async () => {
  const priorId = `pi_${MARK}_gone`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 28000, 'pending')`, [propId, priorId]
  );
  const stripe = fakeStripe({}); // retrieve throws → can't confirm safe
  const r = await priorBalanceChargeSettling({ proposalId: propId, amountCents: 28000, stripe });
  assert.equal(r.skip, true, 'unconfirmable prior intent leans money-safe: do not fire a second charge');
  assert.equal(r.reason, 'retrieve_failed');
});
```

2. **Run it, expect FAIL:** `node -r dotenv/config --test server/utils/autopayDurableCharge.test.js` → fails to load with `Cannot find module './autopayDurableCharge'` (helper not created yet).

3. **Minimal implementation** — create `server/utils/autopayDurableCharge.js`:

```js
'use strict';
/**
 * F1 (autopay durable charge record). Two primitives shared by the autopay
 * scheduler (balanceScheduler.js) and the manual charge-balance route
 * (routes/stripe.js) so a >24h webhook outage can't drive a SECOND real
 * off-session charge for the same balance.
 */
const { pool } = require('../db');

/**
 * (a) Durable charge record. Persist a freshly-created balance PaymentIntent
 * into stripe_sessions immediately at charge time, independent of the webhook.
 * Mirrors stripeCreateIntent.js's insert (server/routes/stripeCreateIntent.js:203);
 * ON CONFLICT DO NOTHING makes a Stripe retry / webhook redelivery a no-op.
 */
async function recordBalanceIntent({ proposalId, intentId, amountCents }, db = pool) {
  await db.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (stripe_payment_intent_id) DO NOTHING`,
    [proposalId, intentId, amountCents]
  );
}

/**
 * (b) Double-charge guard for the stale-TTL re-claim. Before creating a NEW
 * balance intent, find the prior balance intent for this proposal+amount and
 * ask Stripe for its TRUE status — the local stripe_sessions.status is
 * unreliable during the very webhook outage this guards against (it stays
 * 'pending'). Returns { skip:true } when the prior balance intent is already
 * succeeded/processing (leave the claim for the webhook/reconcile) or cannot be
 * retrieved (lean money-safe); { skip:false } when absent, canceled, or
 * requires_payment_method (safe to re-charge).
 *
 * `amount` is the money-scoping proxy for "this balance due date": stripe_sessions
 * carries no payment_type/due_date column, and the balance for a given due date is
 * a fixed dollar amount, so amount + the retrieved metadata.payment_type==='balance'
 * check uniquely identifies the prior balance charge. On a genuine first charge no
 * amount-matching balance row exists, so this no-ops (charges) — which is why running
 * it every cycle is behaviorally identical to "stale re-claim only".
 */
async function priorBalanceChargeSettling({ proposalId, amountCents, stripe }, db = pool) {
  const prior = await db.query(
    `SELECT stripe_payment_intent_id
       FROM stripe_sessions
      WHERE proposal_id = $1
        AND amount = $2
        AND stripe_payment_intent_id IS NOT NULL
        AND status <> 'canceled'
      ORDER BY created_at DESC
      LIMIT 1`,
    [proposalId, amountCents]
  );
  const priorIntentId = prior.rows[0]?.stripe_payment_intent_id;
  if (!priorIntentId) return { skip: false, reason: 'absent' };

  let intent;
  try {
    intent = await stripe.paymentIntents.retrieve(priorIntentId);
  } catch (e) {
    // Can't confirm it's safe to re-charge → SKIP. The claim stays for the
    // webhook/reconcile; an admin can force it once Stripe is reachable. Not
    // double-charging beats a possible miss.
    return { skip: true, reason: 'retrieve_failed', priorIntentId };
  }
  if (intent?.metadata?.payment_type !== 'balance') {
    return { skip: false, reason: 'not_balance', priorIntentId, priorStatus: intent?.status };
  }
  const settling = intent.status === 'succeeded' || intent.status === 'processing';
  return { skip: settling, reason: settling ? 'settling' : 'terminal', priorIntentId, priorStatus: intent.status };
}

module.exports = { recordBalanceIntent, priorBalanceChargeSettling };
```

4. **Run test, expect PASS:** `node -r dotenv/config --test server/utils/autopayDurableCharge.test.js` → all 7 cases pass.

5. **Commit:** `git add server/utils/autopayDurableCharge.js server/utils/autopayDurableCharge.test.js && git commit -m "A1: durable-charge helper (recordBalanceIntent + priorBalanceChargeSettling) for autopay F1"`

---

### Task A2 — Wire the scheduler: durable insert (a), stale-reclaim guard (b), 72h TTL (c)

**Files**
- **Modify** `server/utils/balanceScheduler.js` — add require after line 6; edit claim-TTL comment (lines 33-34) + interval (line 46, `24 hours`→`72 hours`); insert guard + durable-record inside `chargeOne`'s `try` (around lines 78-93)
- **Test** `server/utils/balanceScheduler.autopayDurable.test.js` (new)

**Interfaces**
- **Consumes** `recordBalanceIntent`, `priorBalanceChargeSettling` (from Task A1); `getStripe()` (`server/utils/stripeClient.js:30`, destructured at module load — test stubs it before `require`); `Sentry.captureMessage(msg, { level, tags })` (already used at `balanceScheduler.js:21`).
- **Produces** unchanged external behavior on the happy path; adds a durable `stripe_sessions` row per charge and a no-op skip on stale re-claim.

**Steps**

1. **Write the failing test** `server/utils/balanceScheduler.autopayDurable.test.js`:

```js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('balanceScheduler.autopayDurable.test.js refuses to run against production');
}

// Fake Stripe injected via the stripeClient.getStripe seam. balanceScheduler
// destructures getStripe at module load, so the stub MUST be installed before
// requiring balanceScheduler (mirrors the payrollAccrual stub in the sibling
// suite). create() records the proposal ids it charged and returns a prefixed
// fake intent id; retrieve() answers from a canned map.
const createdFor = new Set();
const retrieveMap = {};
const fakeStripe = {
  paymentIntents: {
    create: async (params) => {
      const pid = String(params.metadata.proposal_id);
      createdFor.add(pid);
      return { id: `pi_faketest_${pid}_${Date.now()}`, status: 'succeeded' };
    },
    retrieve: async (id) => {
      if (!retrieveMap[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
      return retrieveMap[id];
    },
  },
};
require('./stripeClient').getStripe = () => fakeStripe;

const { processAutopayCharges } = require('./balanceScheduler');

const MARK = `apdur-${Date.now()}`;
let freshId, skipId, ttlId;
let claimSnapshot = [];

async function seed(mark, { autopayStatus, attemptedInterval }) {
  const attempted = attemptedInterval ? `NOW() - INTERVAL '${attemptedInterval}'` : 'NULL';
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, status, event_type, autopay_enrolled, balance_due_date,
        stripe_customer_id, stripe_payment_method_id, total_price, amount_paid,
        autopay_status, autopay_attempted_at)
     VALUES (NULL, 'deposit_paid', $1, true, CURRENT_DATE,
             'cus_faketest', 'pm_faketest', 1000, 900, $2, ${attempted})
     RETURNING id`,
    [mark, autopayStatus]
  );
  return r.rows[0].id;
}

before(async () => {
  // Snapshot every OTHER proposal the DB-wide claim could grab so after() can
  // restore its claim state — the fake charge moves no real money but must not
  // strand a stranger's autopay claim on the shared dev DB.
  const claim = await pool.query(`
    SELECT id, autopay_status, autopay_attempted_at FROM proposals
     WHERE status = 'deposit_paid' AND autopay_enrolled = true
       AND balance_due_date <= CURRENT_DATE
       AND stripe_customer_id IS NOT NULL AND stripe_payment_method_id IS NOT NULL
       AND (autopay_status IS NULL OR autopay_status = 'failed'
            OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '72 hours'))
  `);
  claimSnapshot = claim.rows;

  freshId = await seed(`${MARK}-fresh`, { autopayStatus: null });                                   // (a) durable insert
  skipId  = await seed(`${MARK}-skip`,  { autopayStatus: 'in_progress', attemptedInterval: '80 hours' }); // (b) skip
  ttlId   = await seed(`${MARK}-ttl`,   { autopayStatus: 'in_progress', attemptedInterval: '48 hours' }); // (c) 72h TTL

  // Prior balance intent for the skip proposal: durable row exists (amount =
  // balanceCents = (1000-900)*100 = 10000) and Stripe reports it succeeded —
  // the webhook that would have cleared the claim is 'down'.
  const priorId = `pi_prior_${skipId}`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 10000, 'pending')`, [skipId, priorId]
  );
  retrieveMap[priorId] = { id: priorId, status: 'succeeded', metadata: { payment_type: 'balance' } };

  await processAutopayCharges(); // single DB-wide run; the tests assert on resulting state
});

after(async () => {
  for (const id of [freshId, skipId, ttlId]) {
    if (!id) continue;
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  // Purge durable rows the fake charge wrote for OTHER claimable proposals and
  // restore their claim state.
  await pool.query(`DELETE FROM stripe_sessions WHERE stripe_payment_intent_id LIKE 'pi_faketest_%'`);
  for (const row of claimSnapshot) {
    await pool.query(
      `UPDATE proposals SET autopay_status = $2, autopay_attempted_at = $3 WHERE id = $1`,
      [row.id, row.autopay_status, row.autopay_attempted_at]
    );
  }
  await pool.end();
});

test('(a) writes a durable stripe_sessions row for a fresh balance charge', async () => {
  assert.ok(createdFor.has(String(freshId)), 'the fresh proposal must be charged');
  const { rows } = await pool.query(
    `SELECT amount, status FROM stripe_sessions
      WHERE proposal_id = $1 AND stripe_payment_intent_id LIKE 'pi_faketest_%'`, [freshId]
  );
  assert.equal(rows.length, 1, 'exactly one durable balance row persisted at charge time');
  assert.equal(Number(rows[0].amount), 10000);
  assert.equal(rows[0].status, 'pending');
});

test('(b) SKIPS the re-charge when the prior balance intent is already succeeded', async () => {
  assert.equal(createdFor.has(String(skipId)), false,
    'must NOT fire a second charge for a stale in_progress claim whose prior balance intent succeeded');
  const { rows } = await pool.query(
    `SELECT 1 FROM stripe_sessions
      WHERE proposal_id = $1 AND stripe_payment_intent_id LIKE 'pi_faketest_%'`, [skipId]
  );
  assert.equal(rows.length, 0, 'no new durable row — the re-charge was skipped');
  const st = await pool.query('SELECT autopay_status FROM proposals WHERE id = $1', [skipId]);
  assert.equal(st.rows[0].autopay_status, 'in_progress', 'claim left in_progress for the webhook/reconcile');
});

test('(c) 72h TTL: a 48h-stale in_progress claim is NOT re-claimed', async () => {
  assert.equal(createdFor.has(String(ttlId)), false,
    'a 48h-old in_progress claim is inside the 72h TTL and must not be re-charged');
  const st = await pool.query('SELECT autopay_status FROM proposals WHERE id = $1', [ttlId]);
  assert.equal(st.rows[0].autopay_status, 'in_progress', 'untouched claim stays in_progress');
});
```

2. **Run it, expect FAIL:** `node -r dotenv/config --test server/utils/balanceScheduler.autopayDurable.test.js` → fails. Before wiring, `freshId` is charged but no durable row is written → `(a)` fails with `exactly one durable balance row persisted at charge time` (`rows.length` is 0); `skipId` (80h stale) is reclaimed and charged with no guard → `(b)` fails (`createdFor.has(skipId)` is true); `ttlId` (48h stale) is reclaimed under the old 24h TTL → `(c)` fails (`createdFor.has(ttlId)` is true).

3. **Minimal implementation** — three edits in `server/utils/balanceScheduler.js`:

   **3a. Add the require** after line 6 (`const { accruePayoutsForProposal } = require('./payrollAccrual');`):
```js
const { recordBalanceIntent, priorBalanceChargeSettling } = require('./autopayDurableCharge');
```

   **3b. Bump the TTL (c)** — update the claim comment (lines 33-34) and the interval (line 46). Change:
```js
    // re-selection until the webhook moves status='balance_paid' OR the
    // 24h TTL elapses for stuck claims (webhook never landed).
```
   to:
```js
    // re-selection until the webhook moves status='balance_paid' OR the
    // 72h TTL elapses for stuck claims (webhook never landed). TTL bumped
    // 24h->72h (F1): a 24h TTL equalled Stripe's idempotency-key lifetime, so a
    // >24h webhook outage re-fired with an expired key -> a SECOND real charge.
```
   and change line 46:
```js
          OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '24 hours')
```
   to:
```js
          OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '72 hours')
```

   **3c. Guard (b) + durable insert (a)** — inside `chargeOne`'s `try` block. Change (lines 78-93):
```js
      try {
        const intent = await stripe.paymentIntents.create({
          amount: balanceCents,
          currency: 'usd',
          customer: proposal.stripe_customer_id,
          payment_method: proposal.stripe_payment_method_id,
          off_session: true,
          confirm: true,
          description: `Balance Payment — ${getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom })}`,
          metadata: {
            proposal_id: String(proposal.id),
            payment_type: 'balance',
          },
        }, { idempotencyKey });

        console.log(`[BalanceScheduler] Charged $${(balanceCents / 100).toFixed(2)} for proposal ${proposal.id} (intent: ${intent.id})`);
```
   to:
```js
      try {
        // F1(b): on a stale (>72h) re-claim a prior balance intent may already be
        // settling at Stripe with the webhook still down (the local session status
        // is stale). Ask Stripe for the truth and SKIP a second real charge if so;
        // leave the claim in_progress for the webhook/reconcile. On a genuine first
        // charge no prior balance row exists, so this no-ops.
        const guard = await priorBalanceChargeSettling({ proposalId: proposal.id, amountCents: balanceCents, stripe });
        if (guard.skip) {
          console.log(`[BalanceScheduler] Skipping re-charge for proposal ${proposal.id}: prior balance intent ${guard.priorIntentId} ${guard.reason}${guard.priorStatus ? ` (${guard.priorStatus})` : ''}`);
          Sentry.captureMessage('Autopay re-claim skipped — prior balance intent still settling', {
            level: 'warning',
            tags: { scheduler: 'autopay', proposalId: proposal.id, reason: guard.reason },
          });
          return; // leave autopay_status='in_progress'
        }

        const intent = await stripe.paymentIntents.create({
          amount: balanceCents,
          currency: 'usd',
          customer: proposal.stripe_customer_id,
          payment_method: proposal.stripe_payment_method_id,
          off_session: true,
          confirm: true,
          description: `Balance Payment — ${getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom })}`,
          metadata: {
            proposal_id: String(proposal.id),
            payment_type: 'balance',
          },
        }, { idempotencyKey });

        // F1(a): durable charge record — persist immediately, independent of the
        // webhook, so a later >24h outage can never erase our knowledge of this
        // charge. ON CONFLICT DO NOTHING = idempotent on any Stripe retry.
        await recordBalanceIntent({ proposalId: proposal.id, intentId: intent.id, amountCents: balanceCents });

        console.log(`[BalanceScheduler] Charged $${(balanceCents / 100).toFixed(2)} for proposal ${proposal.id} (intent: ${intent.id})`);
```
   (Guard is placed *inside* the existing `try` for per-proposal isolation: a guard DB/Stripe hiccup is caught by the existing `catch` and marks the claim `failed`, never aborting the whole chunk. On `skip` the early `return` leaves `autopay_status='in_progress'` untouched.)

4. **Run test, expect PASS:** `node -r dotenv/config --test server/utils/balanceScheduler.autopayDurable.test.js` → all 3 cases pass.

5. **Commit:** `git add server/utils/balanceScheduler.js server/utils/balanceScheduler.autopayDurable.test.js && git commit -m "A2: autopay scheduler — durable charge record + stale-reclaim double-charge guard + 72h TTL (F1)"`

---

### Task A3 — Wire the manual charge-balance route: durable insert (a), guard (b), 72h TTL (c)

**Files**
- **Modify** `server/routes/stripe.js` — add require after line 22; interval `24 hours`→`72 hours` at line 288; insert guard after line 329 (before `let intent;`); insert durable-record after the create `try`/`catch` (after line 356, before line 358)
- **Test** `server/routes/stripe.chargeBalanceDurable.test.js` (new)

**Interfaces**
- **Consumes** `recordBalanceIntent`, `priorBalanceChargeSettling` (Task A1); `ConflictError` (already imported at `stripe.js:9`); `getStripe()` (destructured at `stripe.js:16`, stubbed before `require`); `auth`, `requireAdminOrManager` (`server/middleware/auth.js` — `auth` looks up the JWT's `decoded.userId` in `users`; role gate needs `role IN ('admin','manager')`).
- **Produces** `POST /api/stripe/charge-balance/:id` → `200 { status, amount }` on a fresh charge (now also writing a durable `stripe_sessions` row); `409 CHARGE_SETTLING` when a prior balance intent is already settling.

**Steps**

1. **Write the failing test** `server/routes/stripe.chargeBalanceDurable.test.js`:

```js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');

if (process.env.NODE_ENV === 'production') {
  throw new Error('stripe.chargeBalanceDurable.test.js refuses to run against production');
}

// Fake Stripe via the getStripe seam — stripe.js destructures getStripe at load,
// so stub BEFORE requiring the router.
const createdFor = new Set();
const retrieveMap = {};
const fakeStripe = {
  paymentIntents: {
    create: async (params) => {
      const pid = String(params.metadata.proposal_id);
      createdFor.add(pid);
      return { id: `pi_faketest_${pid}_${Date.now()}`, status: 'succeeded' };
    },
    retrieve: async (id) => {
      if (!retrieveMap[id]) { const e = new Error('No such payment_intent'); e.code = 'resource_missing'; throw e; }
      return retrieveMap[id];
    },
  },
};
require('../utils/stripeClient').getStripe = () => fakeStripe;

const stripeRouter = require('./stripe');

const MARK = `cbdur-${Date.now()}`;
let server, baseUrl, adminToken, freshId, skipId;

async function seed(mark, { autopayStatus, attemptedInterval }) {
  const attempted = attemptedInterval ? `NOW() - INTERVAL '${attemptedInterval}'` : 'NULL';
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, status, event_type, autopay_enrolled, balance_due_date,
        stripe_customer_id, stripe_payment_method_id, total_price, amount_paid,
        autopay_status, autopay_attempted_at)
     VALUES (NULL, 'deposit_paid', $1, true, CURRENT_DATE,
             'cus_faketest', 'pm_faketest', 1000, 900, $2, ${attempted})
     RETURNING id`,
    [mark, autopayStatus]
  );
  return r.rows[0].id;
}

function post(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': 0 } },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); }); }
    );
    r.on('error', reject); r.end();
  });
}

before(async () => {
  const email = `cbdur-admin+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version)
     VALUES ($1, 'x', 'admin', 0) RETURNING id, token_version`, [email]
  );
  adminToken = jwt.sign({ userId: u.rows[0].id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET);

  freshId = await seed(`${MARK}-fresh`, { autopayStatus: null });                                     // (a) durable insert
  skipId  = await seed(`${MARK}-skip`,  { autopayStatus: 'in_progress', attemptedInterval: '80 hours' }); // (b) guard

  const priorId = `pi_prior_${skipId}`;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, stripe_payment_intent_id, amount, status)
     VALUES ($1, $2, 10000, 'pending')`, [skipId, priorId]
  );
  retrieveMap[priorId] = { id: priorId, status: 'succeeded', metadata: { payment_type: 'balance' } };

  const app = express();
  app.use(express.json());
  app.use('/api/stripe', stripeRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // seed the admin id so after() can purge it
  before._adminEmail = email;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  for (const id of [freshId, skipId]) {
    if (!id) continue;
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
  await pool.query('DELETE FROM users WHERE email = $1', [before._adminEmail]);
  await pool.end();
});

test('(a) charge-balance writes a durable stripe_sessions row and returns 200', async () => {
  const res = await post(`/api/stripe/charge-balance/${freshId}`, adminToken);
  assert.equal(res.status, 200, `expected 200, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.ok(createdFor.has(String(freshId)), 'the fresh proposal must be charged');
  const { rows } = await pool.query(
    `SELECT amount, status FROM stripe_sessions
      WHERE proposal_id = $1 AND stripe_payment_intent_id LIKE 'pi_faketest_%'`, [freshId]
  );
  assert.equal(rows.length, 1, 'exactly one durable balance row persisted at charge time');
  assert.equal(Number(rows[0].amount), 10000);
  assert.equal(rows[0].status, 'pending');
});

test('(b) charge-balance SKIPS (409 CHARGE_SETTLING) when the prior balance intent is already succeeded', async () => {
  const res = await post(`/api/stripe/charge-balance/${skipId}`, adminToken);
  assert.equal(res.status, 409, `expected 409, got ${res.status} ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, 'CHARGE_SETTLING');
  assert.equal(createdFor.has(String(skipId)), false, 'must NOT fire a second charge when a prior balance intent is settling');
  const { rows } = await pool.query(
    `SELECT 1 FROM stripe_sessions
      WHERE proposal_id = $1 AND stripe_payment_intent_id LIKE 'pi_faketest_%'`, [skipId]
  );
  assert.equal(rows.length, 0, 'no new durable row — the re-charge was skipped');
});
```

2. **Run it, expect FAIL:** `node -r dotenv/config --test server/routes/stripe.chargeBalanceDurable.test.js` → fails. Before wiring, `(a)` gets a 200 but writes no durable row → `exactly one durable balance row persisted at charge time` fails (0 rows); `(b)` charges the stale-in_progress proposal and returns 200 → `expected 409, got 200` fails.

3. **Minimal implementation** — three edits in `server/routes/stripe.js`:

   **3a. Add the require** after line 22 (`const { DEPOSIT_AMOUNT, eventLabelFor, getOrCreateCustomer } = require('../utils/stripeRouteHelpers');`):
```js
const { recordBalanceIntent, priorBalanceChargeSettling } = require('../utils/autopayDurableCharge');
```

   **3b. Bump the TTL (c)** at line 288. Change:
```js
        OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '24 hours')
```
   to:
```js
        OR (autopay_status = 'in_progress' AND autopay_attempted_at < NOW() - INTERVAL '72 hours')
```

   **3c. Guard (b) before create + durable insert (a) after create.** Change (lines 326-359):
```js
  const balanceDueIso = proposal.balance_due_date
    ? new Date(proposal.balance_due_date).toISOString().slice(0, 10)
    : 'no-date';
  const idempotencyKey = `autopay-balance-${proposal.id}-${balanceDueIso}`;

  let intent;
  try {
    intent = await stripe.paymentIntents.create({
      amount: balanceCents,
      currency: 'usd',
      customer: proposal.stripe_customer_id,
      payment_method: proposal.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      description: `Balance Payment — ${eventLabelFor(proposal)}`,
      metadata: {
        proposal_id: String(proposal.id),
        payment_type: 'balance',
      },
    }, { idempotencyKey });
  } catch (err) {
    // Release the claim so the admin can retry after fixing the card.
    await pool.query(`UPDATE proposals SET autopay_status = 'failed' WHERE id = $1`, [proposal.id]);
    console.error('Stripe charge-balance error:', err);
    // Preserve Stripe's specific decline message for card errors so admins
    // see the exact reason (e.g. "Your card has insufficient funds.").
    if (err.type === 'StripeCardError') {
      throw new PaymentError(`Card declined: ${err.message}`, 'CARD_DECLINED');
    }
    throw new ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.');
  }

  // Webhook will handle status update on success
  res.json({ status: intent.status, amount: balanceCents });
```
   to:
```js
  const balanceDueIso = proposal.balance_due_date
    ? new Date(proposal.balance_due_date).toISOString().slice(0, 10)
    : 'no-date';
  const idempotencyKey = `autopay-balance-${proposal.id}-${balanceDueIso}`;

  // F1(b): stale re-claim double-charge guard (mirrors the scheduler). If a prior
  // balance intent for this proposal+amount is already succeeded/processing at
  // Stripe (webhook still down), do NOT fire a second charge — surface 409 and
  // leave the claim in_progress for the webhook/reconcile. On a first charge no
  // prior balance row exists, so this no-ops.
  const guard = await priorBalanceChargeSettling({ proposalId: proposal.id, amountCents: balanceCents, stripe });
  if (guard.skip) {
    throw new ConflictError('A prior balance charge is already settling for this proposal', 'CHARGE_SETTLING');
  }

  let intent;
  try {
    intent = await stripe.paymentIntents.create({
      amount: balanceCents,
      currency: 'usd',
      customer: proposal.stripe_customer_id,
      payment_method: proposal.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      description: `Balance Payment — ${eventLabelFor(proposal)}`,
      metadata: {
        proposal_id: String(proposal.id),
        payment_type: 'balance',
      },
    }, { idempotencyKey });
  } catch (err) {
    // Release the claim so the admin can retry after fixing the card.
    await pool.query(`UPDATE proposals SET autopay_status = 'failed' WHERE id = $1`, [proposal.id]);
    console.error('Stripe charge-balance error:', err);
    // Preserve Stripe's specific decline message for card errors so admins
    // see the exact reason (e.g. "Your card has insufficient funds.").
    if (err.type === 'StripeCardError') {
      throw new PaymentError(`Card declined: ${err.message}`, 'CARD_DECLINED');
    }
    throw new ExternalServiceError('Stripe', err, 'Payment temporarily unavailable. Please try again.');
  }

  // F1(a): durable charge record — persist immediately, independent of the
  // webhook (mirrors the scheduler). Idempotent via ON CONFLICT DO NOTHING.
  await recordBalanceIntent({ proposalId: proposal.id, intentId: intent.id, amountCents: balanceCents });

  // Webhook will handle status update on success
  res.json({ status: intent.status, amount: balanceCents });
```

4. **Run test, expect PASS:** `node -r dotenv/config --test server/routes/stripe.chargeBalanceDurable.test.js` → both cases pass.

5. **Commit:** `git add server/routes/stripe.js server/routes/stripe.chargeBalanceDurable.test.js && git commit -m "A3: manual charge-balance route — durable charge record + stale-reclaim guard + 72h TTL (F1)"`

---

**Lane A regression gate (run before requesting review):** run the pre-existing scheduler suite to confirm the TTL/wiring edits didn't regress the auto-complete path — `node -r dotenv/config --test server/utils/balanceScheduler.test.js` (must stay green), then the three new suites one at a time (shared-DB teardown constraint).


---

## Lane B — Drink-plan submit payment-status reconcile (F2)

**Footprint** `server/routes/drinkPlans/submit.js`, `server/routes/drinkPlans/submitReconcile.test.js` / **Deps** none — independent; reads `server/utils/proposalStatus.js` and `server/utils/invoiceHelpers.js` unchanged / **Review** full money-seam fleet (payment-status integrity + cross-cutting consistency), sensitive path (payment status + invoices).

### Background verified against current code (do not re-derive)

- `server/utils/proposalStatus.js` line 18: `reconcileProposalPaymentStatus({ status, amountPaid, totalPrice })` is **pure, no DB**, and returns `{ status, changed, autopayDisarmed, overpaid, overpaidCents }`. It only moves `balance_paid`/`deposit_paid` (lifecycle states untouched); `autopayDisarmed` is true **only** on the `balance_paid → deposit_paid` transition. `amountPaid`/`totalPrice` are DOLLARS (it multiplies by 100 internally).
- `server/utils/invoiceLifecycle.js` line 275: `createAdditionalInvoiceIfNeeded(proposalId, oldTotalCents, dbClient)` returns `null` unless a **locked, non-void** invoice exists AND `newTotalCents - oldTotalCents > 0`; otherwise it mints an `'Additional Services'` invoice for the delta. `oldTotalCents` is CENTS. Re-exported from `server/utils/invoiceHelpers.js` (facade, line 66).
- `server/routes/proposals/crud.js` lines 568-589 / 699-704 is the exact pattern to mirror: `reconcileProposalPaymentStatus({ status: old.status, amountPaid: old.amount_paid, totalPrice: snapshot.total })`, then a conditional `UPDATE proposals SET status = $1[, autopay_enrolled = false, autopay_status = NULL]`, and post-work `oldTotalCents = Math.round(Number(old.total_price || 0) * 100)` fed to `createAdditionalInvoiceIfNeeded`.
- In `submit.js`, the `hasFinancialSideEffects` branch holds a single pooled `client` (line 120 `await pool.connect()`) across `BEGIN`…`COMMIT` (line 360). Every query in this lane's fix uses that **same `client`** (reconcile helper is pure; both DB writes go through `client`) — one-connection rule satisfied. Nothing new runs post-`client.release()`.
- The `proposal` row is loaded via `SELECT * FROM proposals WHERE id = $1 FOR UPDATE` (line 145), so `proposal.status`, `proposal.amount_paid`, `proposal.total_price` are all present. The JS object `proposal.total_price` is **not** mutated by the line 263 DB UPDATE, so capturing `oldTotalCents` any time before COMMIT is equivalent — we capture it at transaction scope so both separate `if (proposal)` blocks (pricing block 154-318, invoice block 327-358) can see it.

---

### Task B1 — Reconcile payment status + bill the delta on a submit that raises total_price

**Files**
- Modify: `server/routes/drinkPlans/submit.js` — imports (lines 11-12); capture `oldTotalCents` at tx scope (after line 152); reconcile after the `total_price` UPDATE (after line 266); `createAdditionalInvoiceIfNeeded` in the add-to-balance branch (after line 356).
- Create (Test): `server/routes/drinkPlans/submitReconcile.test.js`

**Interfaces**
- Consumes: `reconcileProposalPaymentStatus({ status, amountPaid /*dollars*/, totalPrice /*dollars*/ }) → { status, changed, autopayDisarmed, overpaid, overpaidCents }` (pure). `createAdditionalInvoiceIfNeeded(proposalId:number, oldTotalCents:number, dbClient) → Promise<invoice|null>`.
- Produces: on a submit that raises `total_price` past `amount_paid`, `proposals.status` demotes `balance_paid → deposit_paid` (autopay disarmed on that transition) and — in the add-to-balance branch, when a locked invoice exists — one `'Additional Services'` invoice for the cents delta. No behavior change when total does not rise past `amount_paid` (`rec.changed === false`) or no locked invoice exists (`createAdditionalInvoiceIfNeeded` returns `null`).

**Test conventions (DRB):** `node:test` + `node:assert/strict`; hand-rolled express harness over HTTP driving the public token route (mirrors `submitExtras.test.js`); runs against the shared dev DB; nonce-suffixed rows torn down in `after()`; run this suite **alone**. `SEND_NOTIFICATIONS`/`RUN_SCHEDULERS` are OFF (non-prod) so the post-COMMIT email/shopping-list side effects log-and-skip.

---

#### Step 1 — Write the failing test (FULL code)

Create `server/routes/drinkPlans/submitReconcile.test.js`:

```js
require('dotenv').config();

// F2 integration test. A drink-plan submit that adds a financial side effect
// (here: a portable-bar rental) recomputes proposals.total_price from the
// package. When that new total outruns amount_paid on a FULLY-PAID proposal,
// the handler must (a) demote balance_paid -> deposit_paid and disarm autopay
// (reconcileProposalPaymentStatus), and (b) bill the delta on a fresh
// "Additional Services" invoice (createAdditionalInvoiceIfNeeded), because the
// existing Balance invoice is locked and refreshUnlockedInvoices can't re-bill
// it. Before the fix, status stayed balance_paid ("Paid in Full" while owing)
// and the delta was billed nowhere.
//
// Hand-rolled harness in the style of submitExtras.test.js: real express app +
// real drinkPlans router, driven over HTTP (public token route, no auth).
// Runs against the dev DB; every seeded row is torn down in after(). Rows are
// nonce-suffixed so a crashed prior run can't collide.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const drinkPlansRouter = require('../drinkPlans');

let server;
let baseUrl;
let clientId;
let proposalId;
let planToken;

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

before(async () => {
  // Pick a per_guest, non-class package so the recomputed total is guest-driven
  // and comfortably exceeds our deliberately-low seeded total (mirrors
  // crud.demotion.test.js package selection).
  const pk = await pool.query(
    "SELECT id FROM service_packages WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class' ORDER BY id LIMIT 1"
  );
  assert.ok(pk.rows[0], 'need an active per_guest, non-class package seeded');
  const pkgId = pk.rows[0].id;

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`Reconcile Test ${NONCE}`, `reconcile-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  // Fully paid at a deliberately LOW old total ($100 = amount_paid), status
  // balance_paid, autopay armed. The submit's package recompute will push
  // total_price well above $100, so amount_paid can no longer cover it.
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, package_id, event_type, guest_count, num_bars,
        total_price, amount_paid, autopay_enrolled, pricing_snapshot)
     VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'balance_paid', $2, 'birthday-party', 75, 1,
             100, 100, true, '{}'::jsonb)
     RETURNING id`,
    [clientId, pkgId]
  );
  proposalId = p.rows[0].id;

  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3) RETURNING id, token`,
    [proposalId, `Reconcile Test ${NONCE}`, `reconcile-${NONCE}@example.com`]
  );
  planToken = dp.rows[0].token;

  // A LOCKED, fully-paid Balance invoice — the "Paid in Full" state whose
  // presence makes createAdditionalInvoiceIfNeeded fire on the delta.
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Balance', 10000, 10000, 'paid', true)`,
    [proposalId, `INV-${crypto.randomBytes(4).toString('hex')}`]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  // Let fire-and-forget submit side-effects (shopping-list gen, email lookup)
  // settle before we tear down the pool.
  await new Promise((r) => setTimeout(r, 300));
  await pool.query("DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
  await pool.query("DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)", [proposalId]);
  await pool.query("DELETE FROM invoices WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposal_addons WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id=$1", [proposalId]);
  await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('fully-paid submit with a bar rental demotes status, disarms autopay, and bills the delta on an Additional Services invoice', async () => {
  const res = await request('PUT', `/api/drink-plans/t/${planToken}`, {
    body: {
      status: 'submitted',
      paid_separately: false, // add-to-balance branch
      selections: { logistics: { addBarRental: true } },
    },
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.status, 'submitted');

  const prop = await pool.query(
    'SELECT status, total_price, amount_paid, autopay_enrolled FROM proposals WHERE id = $1',
    [proposalId]
  );
  const row = prop.rows[0];
  assert.ok(Number(row.total_price) > 100, 'package recompute pushed total_price above the fully-paid old total');
  assert.strictEqual(row.status, 'deposit_paid', 'status must demote balance_paid -> deposit_paid when the new total outruns amount_paid');
  assert.strictEqual(row.autopay_enrolled, false, 'autopay must be disarmed on the was-fully-paid transition');

  // The delta (newTotal - $100) must land on exactly one non-void
  // "Additional Services" invoice (the Balance invoice is locked).
  const expectedDeltaCents = Math.round((Number(row.total_price) - 100) * 100);
  const addl = await pool.query(
    `SELECT amount_due FROM invoices
      WHERE proposal_id = $1 AND label = 'Additional Services' AND status <> 'void'`,
    [proposalId]
  );
  assert.strictEqual(addl.rows.length, 1, 'exactly one Additional Services invoice for the delta');
  assert.strictEqual(addl.rows[0].amount_due, expectedDeltaCents);
});
```

#### Step 2 — Run the test, expect FAIL

```
node -r dotenv/config --test server/routes/drinkPlans/submitReconcile.test.js
```

Expected failure (pre-fix): the submit still returns 200 and `total_price` still rises (that UPDATE already exists), but no reconcile runs, so the status assertion trips:

```
AssertionError [ERR_ASSERTION]: status must demote balance_paid -> deposit_paid when the new total outruns amount_paid
+ actual - expected
+ 'balance_paid'
- 'deposit_paid'
```

(If execution somehow continued, the `Additional Services` count assertion `1 !== 0` would fail next — both prove the F2 gap.)

#### Step 3 — Minimal implementation (four exact edits to `server/routes/drinkPlans/submit.js`)

**3a — Imports.** Add `createAdditionalInvoiceIfNeeded` to the invoiceHelpers destructure and require the reconcile helper.

Replace:
```js
const { refreshUnlockedInvoices, findOrRefreshExtrasInvoice, findExtrasInvoice, voidExtrasInvoiceWithReconcile } = require('../../utils/invoiceHelpers');
const { computeExtrasBreakdown } = require('../../utils/drinkPlanExtras');
```
with:
```js
const { refreshUnlockedInvoices, findOrRefreshExtrasInvoice, findExtrasInvoice, voidExtrasInvoiceWithReconcile, createAdditionalInvoiceIfNeeded } = require('../../utils/invoiceHelpers');
const { reconcileProposalPaymentStatus } = require('../../utils/proposalStatus');
const { computeExtrasBreakdown } = require('../../utils/drinkPlanExtras');
```

**3b — Capture `oldTotalCents` at transaction scope** (visible to both the pricing block and the later invoice block).

Replace:
```js
      const numBarsAtIntent = proposal ? (proposal.num_bars || 0) : 0;

      if (proposal) {
```
with:
```js
      const numBarsAtIntent = proposal ? (proposal.num_bars || 0) : 0;
      // F2: snapshot the pre-extras total (cents) BEFORE the total_price UPDATE
      // below, so the add-to-balance branch bills only the delta via
      // createAdditionalInvoiceIfNeeded (mirrors crud.js oldTotalCents). Declared
      // at transaction scope because the pricing block and the invoice block are
      // separate `if (proposal)` scopes. proposal.total_price is the pre-UPDATE
      // dollar value (the DB UPDATE never mutates this JS object).
      const oldTotalCents = Math.round(Number(proposal?.total_price || 0) * 100);

      if (proposal) {
```

**3c — Reconcile payment status immediately after the `total_price` UPDATE**, on the same tx `client` (CLAUDE.md cross-cutting: a price rise must never leave a proposal marked "Paid in Full").

Replace:
```js
          await client.query(
            'UPDATE proposals SET total_price = $1, pricing_snapshot = $2, updated_at = NOW() WHERE id = $3',
            [snapshot.total, JSON.stringify(snapshot), proposal.id]
          );

          await client.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
             VALUES ($1, 'drink_plan_addons_added', 'client', $2)`,
```
with:
```js
          await client.query(
            'UPDATE proposals SET total_price = $1, pricing_snapshot = $2, updated_at = NOW() WHERE id = $3',
            [snapshot.total, JSON.stringify(snapshot), proposal.id]
          );

          // F2 (CLAUDE.md cross-cutting: price up -> re-evaluate payment status).
          // The extras just raised total_price; a fully-paid proposal that now
          // owes must not keep showing "Paid in Full". Mirror crud.js: demote
          // balance_paid -> deposit_paid and disarm autopay only on the
          // was-fully-paid transition. reconcile is pure; the UPDATE uses the
          // SAME tx client (one-connection rule). Keep proposal.status honest in
          // memory so the post-commit notification below reports the real state.
          const rec = reconcileProposalPaymentStatus({
            status: proposal.status, amountPaid: proposal.amount_paid, totalPrice: snapshot.total,
          });
          if (rec.changed) {
            const priorStatus = proposal.status;
            await client.query(
              rec.autopayDisarmed
                ? 'UPDATE proposals SET status = $1, autopay_enrolled = false, autopay_status = NULL WHERE id = $2'
                : 'UPDATE proposals SET status = $1 WHERE id = $2',
              [rec.status, proposal.id]
            );
            proposal.status = rec.status;
            await client.query(
              `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
               VALUES ($1, 'status_changed', 'client', $2)`,
              [proposal.id, JSON.stringify({
                from: priorStatus, to: rec.status,
                reason: 'drink_plan_extras_reconciled', new_total: snapshot.total,
              })]
            );
          }

          await client.query(
            `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
             VALUES ($1, 'drink_plan_addons_added', 'client', $2)`,
```

**3d — Bill the delta in the add-to-balance branch**, on the same tx `client`, after the Balance refresh.

Replace:
```js
          await refreshUnlockedInvoices(proposal.id, client);
        }
      }

      await client.query('COMMIT');
```
with:
```js
          await refreshUnlockedInvoices(proposal.id, client);
          // F2: a fully-paid proposal's invoices are LOCKED, so the refresh above
          // can't re-bill the extras delta. Mirror crud.js: raise a separate
          // "Additional Services" invoice for (newTotal - oldTotal). No-op when no
          // locked invoice exists or the delta is <= 0 (idempotent on any
          // admin-reset re-submit: oldTotalCents == newTotalCents -> null).
          await createAdditionalInvoiceIfNeeded(proposal.id, oldTotalCents, client);
        }
      }

      await client.query('COMMIT');
```

#### Step 4 — Run the test, expect PASS

```
node -r dotenv/config --test server/routes/drinkPlans/submitReconcile.test.js
```

Expect `pass 1  fail 0`. (Status demotes to `deposit_paid`, `autopay_enrolled` is `false`, and exactly one `Additional Services` invoice carries `amount_due == round((total_price - 100) * 100)`.)

#### Step 5 — Commit

```
git add server/routes/drinkPlans/submit.js server/routes/drinkPlans/submitReconcile.test.js
git commit -m "fix(F2): reconcile payment status + bill delta on drink-plan submit that raises total_price

drinkPlans/submit.js raised proposals.total_price but never called
reconcileProposalPaymentStatus/createAdditionalInvoiceIfNeeded, so a fully-paid
proposal stayed balance_paid (\"Paid in Full\") while newly owing and the
add-to-balance delta was billed nowhere. Mirror crud.js: capture oldTotalCents
before the UPDATE, demote balance_paid->deposit_paid (disarm autopay on that
transition) on the same tx client, and raise an Additional Services invoice for
the delta in the add-to-balance branch. Adds submitReconcile.test.js."
```


---

## Lane C — Dispute-won ledger rewind (F5)

**Footprint / Deps / Review**: touches `server/db/schema.sql`, `server/utils/payrollClawback.js`, `server/utils/payrollDisputeRewind.test.js`, `server/routes/stripeWebhookHandlers/disputes.js`, `ARCHITECTURE.md` · Deps: none (independent lane) · Review: FULL fleet (money-seam + webhook-idempotency + data-integrity — `payrollClawback.js` and `disputes.js` are sensitive paths) + `/second-opinion` on the same commits.

**Test conventions (state them, they are DRB-specific):**
- `node:test` via `const { test, before, beforeEach, afterEach, after } = require('node:test'); const assert = require('node:assert/strict');`
- Run ONE suite at a time (shared dev DB FK-collides on parallel teardown): `node -r dotenv/config --test server/<path>/<name>.test.js`.
- Non-prod defaults: `SEND_NOTIFICATIONS` / `RUN_SCHEDULERS` OFF unless `NODE_ENV=production`, so `notifyDisputeWon`'s email path log-and-skips in the handler test — no real send.
- The suite hits the shared dev Neon DB directly; it never touches Stripe. No Stripe stub is needed because the rewind is pure SQL and the handler test constructs the event object by hand.

**One-connection-per-request note:** neither the new helper nor the reinstate handler holds a pooled client. `rewindDisputeClawbackByPaymentIntent` is a single autonomous `pool.query` (auto-checkout/auto-release). In the handler the rewind runs and fully settles **before** `notifyDisputeWon` (which takes its *own* `pool.connect()` + `FOR UPDATE OF t`), so the two never overlap on a connection — no second-connection-while-holding-one deadlock.

---

### Task C1 — schema column + `rewindDisputeClawbackByPaymentIntent` helper

**Files**
- Modify `server/db/schema.sql` — insert one `ALTER TABLE tips` after line 2808 (`dispute_won_at`).
- Modify `server/utils/payrollClawback.js` — add helper after `clawbackTipByPaymentIntent` (currently ends line 259) and extend `module.exports` (line 261).
- Modify `ARCHITECTURE.md` — add one bullet after line 1050 (Database Schema, `tips` section).
- Create `server/utils/payrollDisputeRewind.test.js` (new suite).

**Interfaces**
- Produces: `rewindDisputeClawbackByPaymentIntent(paymentIntentId: string, reinstatedCents: number) => Promise<{ rewound: number }>` — `rewound` = rows updated (1 first delivery, 0 on redelivery).
- Consumes (verified): `pool` from `../db`; `payPeriodForDate(ymd)`, `computePayday(endDate)` from `./payrollPeriods` (both exported, confirmed). Existing `clawbackTip` idempotency contract: it only moves `tips.refunded_amount_cents` FORWARD (`delta = newAmt - oldAmt; if (delta <= 0) return {delta:0}`), which is exactly why a rewind path is required.

**Steps**

**1. Write the failing test.** Create `server/utils/payrollDisputeRewind.test.js` with the FULL contents below.

```js
require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  clawbackTipByPaymentIntent,
  rewindDisputeClawbackByPaymentIntent,
} = require('./payrollClawback');
const { payPeriodForDate, computePayday } = require('./payrollPeriods');

if (process.env.NODE_ENV === 'production') {
  throw new Error('payrollDisputeRewind.test.js refuses to run against production');
}

const PI = 'pi_rewind_test';

// clawbackTip lands its synthetic negative line in TODAY's OPEN period. Force
// today's Tue-Mon period open the same way production payroll would create it,
// so the clawback places (not defers) on a shared dev DB whose period may be paid.
async function ensureTodayPeriodOpen() {
  const todayYmd = new Date().toISOString().slice(0, 10);
  const { startDate, endDate } = payPeriodForDate(todayYmd);
  const payday = computePayday(endDate);
  await pool.query(
    `INSERT INTO pay_periods (start_date, end_date, payday, status)
     VALUES ($1, $2, $3, 'open')
     ON CONFLICT (start_date) DO UPDATE SET status = 'open'`,
    [startDate, endDate, payday]
  );
}

let bartenderA, bartenderB, proposalId, shiftId, tipId;

before(async () => {
  // Pre-clean stranded fixtures from prior failed runs (FK chain:
  // payout_events -> payouts -> tips/shift_requests/contractor_profiles -> users).
  const f = `email LIKE 'rw-%@example.com'`;
  await pool.query(`DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${f}))`);
  await pool.query(`DELETE FROM payouts WHERE contractor_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM tips WHERE target_user_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM shift_requests WHERE user_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id IN (SELECT id FROM users WHERE ${f})`);
  await pool.query(`DELETE FROM users WHERE ${f}`);

  const a = await pool.query("INSERT INTO users (email, password_hash, role) VALUES ('rw-a@example.com','x','staff') RETURNING id");
  bartenderA = a.rows[0].id;
  const b = await pool.query("INSERT INTO users (email, password_hash, role) VALUES ('rw-b@example.com','x','staff') RETURNING id");
  bartenderB = b.rows[0].id;
  for (const id of [bartenderA, bartenderB]) {
    await pool.query(
      `INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1, 20.00)
       ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20.00`,
      [id]
    );
  }
});

beforeEach(async () => {
  await ensureTodayPeriodOpen();
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, event_start_time, event_duration_hours, total_price)
     VALUES (NULL, '2026-05-15', 'completed', 'wedding', '6:00 PM', 4, 2000)
     RETURNING id`
  );
  proposalId = pr.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, proposal_id)
     VALUES ('2026-05-15','6:00 PM','open',$1) RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  for (const id of [bartenderA, bartenderB]) {
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status)
       VALUES ($1,$2,'Bartender','approved')
       ON CONFLICT (shift_id, user_id) DO UPDATE SET status='approved'`,
      [shiftId, id]
    );
  }
  // Paid-out card tip, $40.00 / $1.28 fee, keyed by PI. refunded_amount_cents=0,
  // dispute_reinstated_at NULL (default) so the rewind is eligible to fire.
  const t = await pool.query(
    `INSERT INTO tips (tip_page_token, target_user_id, amount_cents, fee_cents,
                       stripe_payment_intent_id, tipped_at, shift_id, refunded_amount_cents)
     VALUES (gen_random_uuid(), $1, 4000, 128, $2, '2026-05-15 23:30:00+00', $3, 0)
     RETURNING id`,
    [bartenderA, PI, shiftId]
  );
  tipId = t.rows[0].id;
});

afterEach(async () => {
  await pool.query(
    `DELETE FROM payout_events WHERE shift_id = $1 OR payout_id IN
       (SELECT id FROM payouts WHERE contractor_id IN ($2,$3))`,
    [shiftId, bartenderA, bartenderB]
  );
  await pool.query('DELETE FROM payouts WHERE contractor_id IN ($1,$2)', [bartenderA, bartenderB]);
  await pool.query('DELETE FROM tips WHERE id = $1', [tipId]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  // Leave today's open period in place: it is shared dev state, the upsert is
  // idempotent, and no payouts reference it after the deletes above.
});

after(async () => {
  for (const id of [bartenderA, bartenderB]) {
    await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
  }
  await pool.end();
});

test('rewind > rolls the counter back by the reinstated amount and stamps dispute_reinstated_at', async () => {
  await pool.query('UPDATE tips SET refunded_amount_cents = 4000 WHERE id = $1', [tipId]);
  const r = await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  assert.equal(r.rewound, 1);
  const { rows } = await pool.query(
    'SELECT refunded_amount_cents, dispute_reinstated_at FROM tips WHERE id = $1', [tipId]);
  assert.equal(Number(rows[0].refunded_amount_cents), 0);
  assert.notEqual(rows[0].dispute_reinstated_at, null);
});

test('rewind > partial reinstate rolls back only that slice', async () => {
  await pool.query('UPDATE tips SET refunded_amount_cents = 4000 WHERE id = $1', [tipId]);
  const r = await rewindDisputeClawbackByPaymentIntent(PI, 2500);
  assert.equal(r.rewound, 1);
  const { rows } = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [tipId]);
  // GREATEST(4000 - LEAST(2500,4000), 0) = 1500
  assert.equal(Number(rows[0].refunded_amount_cents), 1500);
});

test('rewind > reinstated greater than clawed floors at 0, never negative', async () => {
  await pool.query('UPDATE tips SET refunded_amount_cents = 1000 WHERE id = $1', [tipId]);
  await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  const { rows } = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [tipId]);
  // GREATEST(1000 - LEAST(4000,1000), 0) = 0
  assert.equal(Number(rows[0].refunded_amount_cents), 0);
});

test('rewind > redelivery is a no-op (dispute_reinstated_at guard)', async () => {
  await pool.query('UPDATE tips SET refunded_amount_cents = 4000 WHERE id = $1', [tipId]);
  await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  const replay = await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  assert.equal(replay.rewound, 0);
  const { rows } = await pool.query('SELECT refunded_amount_cents FROM tips WHERE id = $1', [tipId]);
  assert.equal(Number(rows[0].refunded_amount_cents), 0, 'counter not double-rewound on redelivery');
});

test('F5 sequence: withdraw -> reinstate -> redeliver reinstate (no-op) -> genuine refund re-claws', async () => {
  // 1. charge.dispute.funds_withdrawn: auto-clawback pulls the tip back.
  //    net = 4000 - round(128*4000/4000) = 3872; split 2 ways = [-1936, -1936].
  await clawbackTipByPaymentIntent(PI, 4000);
  let tip = (await pool.query('SELECT refunded_amount_cents FROM tips WHERE id=$1', [tipId])).rows[0];
  assert.equal(Number(tip.refunded_amount_cents), 4000);
  let adj = await pool.query(
    `SELECT COALESCE(SUM(pe.adjustment_cents),0) AS total FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE pe.shift_id = $1`, [shiftId]);
  assert.equal(Number(adj.rows[0].total), -3872);

  // 2. charge.dispute.funds_reinstated (we WON): rewind the counter. Manual
  //    re-pay of the bartenders is Phase-2 and intentionally NOT asserted here.
  const rw = await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  assert.equal(rw.rewound, 1);
  tip = (await pool.query('SELECT refunded_amount_cents, dispute_reinstated_at FROM tips WHERE id=$1', [tipId])).rows[0];
  assert.equal(Number(tip.refunded_amount_cents), 0);
  assert.notEqual(tip.dispute_reinstated_at, null);

  // 3. Redelivered reinstate: idempotent no-op, counter stays 0.
  const rwReplay = await rewindDisputeClawbackByPaymentIntent(PI, 4000);
  assert.equal(rwReplay.rewound, 0);
  tip = (await pool.query('SELECT refunded_amount_cents FROM tips WHERE id=$1', [tipId])).rows[0];
  assert.equal(Number(tip.refunded_amount_cents), 0);

  // 4. A later GENUINE refund now computes delta = 4000 - 0 and re-claws,
  //    instead of the F5 bug (refunded still 4000 -> delta=0 -> under-claw).
  await clawbackTipByPaymentIntent(PI, 4000);
  tip = (await pool.query('SELECT refunded_amount_cents FROM tips WHERE id=$1', [tipId])).rows[0];
  assert.equal(Number(tip.refunded_amount_cents), 4000);
  adj = await pool.query(
    `SELECT COALESCE(SUM(pe.adjustment_cents),0) AS total FROM payout_events pe
       JOIN payouts po ON po.id = pe.payout_id WHERE pe.shift_id = $1`, [shiftId]);
  // The genuine refund adds a SECOND -3872 slice onto the same aggregated lines:
  // total auto-clawback is now -7744, proving the refund was collected, not lost.
  assert.equal(Number(adj.rows[0].total), -7744, 'genuine refund re-claws after reinstate rewind (F5 fix)');
});
```

**2. Run it, expect FAIL.**
```
node -r dotenv/config --test server/utils/payrollDisputeRewind.test.js
```
Expected: every test errors before its assertions — `rewindDisputeClawbackByPaymentIntent` is `undefined` in the destructure, so the first call throws `TypeError: rewindDisputeClawbackByPaymentIntent is not a function`. (If a path reaches a `dispute_reinstated_at` reference first, the DB errors with `column "dispute_reinstated_at" does not exist` / code `42703`.) Suite exits non-zero — a failing/erroring run is a real fail, not a pass.

**3a. Minimal implementation — schema column.** In `server/db/schema.sql`, immediately after line 2808:

```sql
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_won_at TIMESTAMPTZ;
```
add:
```sql
-- F5 dispute-won ledger rewind (2026-07-13): on charge.dispute.funds_reinstated
-- roll the clawback counter back so a LATER genuine refund re-claws correctly.
-- Own idempotency column, deliberately NOT dispute_won_at (that gates the email).
ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_reinstated_at TIMESTAMPTZ;
```

**3b. Apply the idempotent DDL to the shared dev DB** (schema.sql is applied by `initDb()` only at server boot; the test hits the DB directly, so apply the one column now):
```
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query('ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_reinstated_at TIMESTAMPTZ').then(()=>{console.log('applied');return pool.end();}).catch(e=>{console.error(e);process.exit(1);})"
```
Run from the lane worktree root. Expect `applied`.

**3c. Minimal implementation — helper.** In `server/utils/payrollClawback.js`, replace the current export tail (lines 251-261):

```js
async function clawbackTipByPaymentIntent(paymentIntentId, newCumulativeCents) {
  if (!paymentIntentId || !Number.isInteger(newCumulativeCents) || newCumulativeCents <= 0) return;
  const { rows } = await pool.query(
    'SELECT id FROM tips WHERE stripe_payment_intent_id = $1',
    [paymentIntentId]
  );
  if (!rows[0]) return;
  await clawbackTip(rows[0].id, newCumulativeCents);
}

module.exports = { clawbackTip, clawbackTipByPaymentIntent };
```

with:

```js
async function clawbackTipByPaymentIntent(paymentIntentId, newCumulativeCents) {
  if (!paymentIntentId || !Number.isInteger(newCumulativeCents) || newCumulativeCents <= 0) return;
  const { rows } = await pool.query(
    'SELECT id FROM tips WHERE stripe_payment_intent_id = $1',
    [paymentIntentId]
  );
  if (!rows[0]) return;
  await clawbackTip(rows[0].id, newCumulativeCents);
}

/**
 * F5 dispute-won ledger rewind. When Stripe reinstates the funds on a disputed
 * card tip (charge.dispute.funds_reinstated — we WON), roll the cumulative
 * refunded counter back down by the reinstated amount so a LATER genuine refund
 * computes a real delta and re-claws, instead of seeing refunded_amount_cents
 * already at the tip total and no-opping (delta=0 — the F5 under-claw bug).
 *
 * clawbackTip only ever moves refunded_amount_cents FORWARD, so this is the one
 * place the counter is reduced. It does NOT auto re-pay the bartender: the
 * positive adjustment stays a manual Phase-2 step (see payrollDisputeNotify).
 *
 * Idempotent via tips.dispute_reinstated_at: a Stripe redelivery of the same
 * reinstatement finds the column already stamped and updates 0 rows (no-op), so
 * the counter is never rewound twice. One bare pool.query, no held client.
 *
 * @param {string} paymentIntentId  Stripe payment_intent on the disputed charge
 * @param {number} reinstatedCents  dispute.amount reinstated, in cents
 * @returns {Promise<{rewound: number}>}  rows updated (1 first time, 0 on redelivery)
 */
async function rewindDisputeClawbackByPaymentIntent(paymentIntentId, reinstatedCents) {
  if (!paymentIntentId || !Number.isInteger(reinstatedCents) || reinstatedCents <= 0) {
    return { rewound: 0 };
  }
  const { rowCount } = await pool.query(
    `UPDATE tips
        SET refunded_amount_cents = GREATEST(refunded_amount_cents - LEAST($2, refunded_amount_cents), 0),
            dispute_reinstated_at = NOW()
      WHERE stripe_payment_intent_id = $1
        AND dispute_reinstated_at IS NULL`,
    [paymentIntentId, reinstatedCents]
  );
  return { rewound: rowCount };
}

module.exports = { clawbackTip, clawbackTipByPaymentIntent, rewindDisputeClawbackByPaymentIntent };
```

**3d. Doc update.** In `ARCHITECTURE.md`, after line 1050 (`dispute_won_at` bullet) add:

```
- `dispute_reinstated_at` TIMESTAMPTZ — set by `rewindDisputeClawbackByPaymentIntent` on `charge.dispute.funds_reinstated`; idempotency marker for the F5 ledger rewind (rolls `refunded_amount_cents` back down by the reinstated amount so a later genuine refund re-claws instead of no-opping at delta=0). Deliberately separate from `dispute_won_at` (which gates the admin email) so the ledger rewind never waits on email delivery.
```

**4. Run test, expect PASS.**
```
node -r dotenv/config --test server/utils/payrollDisputeRewind.test.js
```
Expected: `# pass 5  # fail 0`.

**5. Commit.**
```
git add server/db/schema.sql server/utils/payrollClawback.js server/utils/payrollDisputeRewind.test.js ARCHITECTURE.md
git commit -m "F5: rewind dispute clawback counter on funds_reinstated so later genuine refunds re-claw"
```

---

### Task C2 — wire the rewind into `handleDisputeFundsReinstated`

**Files**
- Modify `server/routes/stripeWebhookHandlers/disputes.js` — line 7 import; add rewind call inside `handleDisputeFundsReinstated` (lines 14-31).
- Modify `server/utils/payrollDisputeRewind.test.js` — append one handler-level test.

**Interfaces**
- Consumes: `rewindDisputeClawbackByPaymentIntent` (from Task C1). `handleDisputeFundsReinstated(event, res)` — verified: reads `event.data.object.payment_intent` and `.amount`, then `res.json({ received: true })`. It runs inside the `asyncHandler`-wrapped dispatcher (`stripeWebhook.js:123-126`), so a throw funnels to the global error middleware → 5xx → Stripe retries. The rewind is placed to propagate on failure (retry-safe, since it no-ops on redelivery), matching the withdrawal path's propagate-for-retry contract.
- Produces: no signature change; `handleDisputeFundsReinstated` gains the ledger-rewind side effect before the (unchanged) `notifyDisputeWon` email path.

**Steps**

**1. Write the failing test.** Append to `server/utils/payrollDisputeRewind.test.js`:

```js
test('handleDisputeFundsReinstated > rewinds the clawback counter (decoupled from the email path)', async () => {
  // Simulate the post-withdrawal state: counter already at the tip total.
  await pool.query('UPDATE tips SET refunded_amount_cents = 4000 WHERE id = $1', [tipId]);

  const { handleDisputeFundsReinstated } = require('../routes/stripeWebhookHandlers/disputes');
  const event = { data: { object: { payment_intent: PI, amount: 4000, created: 1700000000 } } };
  let acked = null;
  const res = { json: (body) => { acked = body; return body; } };

  // notifyDisputeWon runs but log-and-skips its email (SEND_NOTIFICATIONS off in
  // dev); it never touches refunded_amount_cents / dispute_reinstated_at.
  await handleDisputeFundsReinstated(event, res);

  assert.deepEqual(acked, { received: true });
  const { rows } = await pool.query(
    'SELECT refunded_amount_cents, dispute_reinstated_at FROM tips WHERE id = $1', [tipId]);
  assert.equal(Number(rows[0].refunded_amount_cents), 0, 'handler rewound the counter');
  assert.notEqual(rows[0].dispute_reinstated_at, null);
});
```

**2. Run it, expect FAIL.**
```
node -r dotenv/config --test server/utils/payrollDisputeRewind.test.js
```
Expected: the new test fails with `AssertionError [ERR_ASSERTION]: handler rewound the counter` (`4000 !== 0`) — the handler does not rewind yet. The five Task-C1 tests still pass.

**3. Minimal implementation.** In `server/routes/stripeWebhookHandlers/disputes.js`, change the import (line 7):

```js
const { clawbackTipByPaymentIntent } = require('../../utils/payrollClawback');
```
to:
```js
const { clawbackTipByPaymentIntent, rewindDisputeClawbackByPaymentIntent } = require('../../utils/payrollClawback');
```

Then change the head of `handleDisputeFundsReinstated` (lines 14-18):

```js
async function handleDisputeFundsReinstated(event, res) {
    const dispute = event.data.object;
    const piId = dispute.payment_intent;
    if (piId) {
      const { rows } = await pool.query('SELECT id FROM tips WHERE stripe_payment_intent_id = $1', [piId]);
```
to:
```js
async function handleDisputeFundsReinstated(event, res) {
    const dispute = event.data.object;
    const piId = dispute.payment_intent;
    if (piId) {
      // F5: roll the clawback counter back FIRST, decoupled from the admin email.
      // Not gated on dispute_won_at (the ledger must not wait on email delivery)
      // — it carries its own idempotency column, tips.dispute_reinstated_at.
      // Errors propagate so Stripe retries the delivery; the rewind is a no-op
      // on redelivery, and notifyDisputeWon below is idempotent via dispute_won_at.
      await rewindDisputeClawbackByPaymentIntent(piId, Number(dispute.amount || 0));

      const { rows } = await pool.query('SELECT id FROM tips WHERE stripe_payment_intent_id = $1', [piId]);
```

(Everything from the `SELECT id` onward — the `notifyDisputeWon` block and `return res.json({ received: true })` — is unchanged.)

**4. Run test, expect PASS.**
```
node -r dotenv/config --test server/utils/payrollDisputeRewind.test.js
```
Expected: `# pass 6  # fail 0`.

**5. Commit.**
```
git add server/routes/stripeWebhookHandlers/disputes.js server/utils/payrollDisputeRewind.test.js
git commit -m "F5: call rewindDisputeClawbackByPaymentIntent from funds_reinstated handler before notifyDisputeWon"
```

> Operational note (not a build step): `disputes.js` is server code and the Claude-managed dev backend does not auto-reload — a local restart is needed to exercise the wired handler against a live webhook; production picks it up on deploy.


---

## Lane D — Auth hardening: qa-seed prod gate + OTP neutral response (F3, F6)

**Footprint:** `server/index.js`, `server/utils/qaMount.js`, `server/utils/qaMount.test.js`, `server/routes/clientAuth.js`, `server/routes/clientAuth.otpNeutral.test.js` · **Deps:** none (independent of all other lanes) · **Review:** full fleet — auth/security-sensitive (`server/routes/clientAuth.js` + a production route-exposure gate); run `/second-opinion` at push per the sensitive-path rule.

Two independent Tasks. Both handlers use bare `pool.query()` only (no `pool.connect()`, no transaction, no Stripe write) — the one-connection-per-request and Stripe-idempotency invariants are trivially satisfied and unchanged by this lane. State that in review.

DRB test conventions used below: `const { test } = require('node:test')` (+ `before`/`after`, `node:assert/strict`); run ONE suite at a time (shared dev DB); non-prod defaults keep `SEND_NOTIFICATIONS`/`RUN_SCHEDULERS` OFF (each test also forces `SEND_NOTIFICATIONS='false'` and refuses to run when `NODE_ENV==='production'`); no real Stripe/email/SMS is touched.

---

### Task F3 — Gate the `/api/qa` mount behind `NODE_ENV !== 'production'`

`/api/qa` is mounted unconditionally at `server/index.js:265` (`app.use('/api/qa', require('./routes/labrat'));`). `routes/labrat.js` `POST /seed` calls `runSeedRecipe()` which mints DB rows (loginable, self-escalating accounts). In production this is a live account-minting + privilege-escalation endpoint. Fix: gate the mount so the entire `/api/qa/*` tree 404s in prod. The gate lives in a tiny helper (`server/utils/qaMount.js`) so it is unit-testable without booting the full server — `index.js` calls `start()` → `initDb()` → `app.listen()` at module load (line 525) and does not export `app`, so it cannot be required in a unit test.

**Files**
- Create: `server/utils/qaMount.js` (~14 lines)
- Modify: `server/index.js` (line 265 — the `/api/qa` mount)
- Test: `server/utils/qaMount.test.js` (new)

**Interfaces**
- Produces: `mountQa(app)` — `(app: express.Express) => void`. When `process.env.NODE_ENV === 'production'` it is a no-op (labrat is never even `require`d); otherwise it mounts `require('../routes/labrat')` at `/api/qa`. Reads `NODE_ENV` at call time (not module load) so both branches are exercisable in one process.
- Consumes: the Express app instance (from `index.js`); the labrat router (`server/routes/labrat.js`, exports `express.Router()` — verified).

**Steps**

1. Write the failing test. Create `server/utils/qaMount.test.js` with the FULL contents:

```js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { mountQa } = require('./qaMount');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('qaMount.test.js refuses to run against production');
}

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function buildApp() {
  const app = express();
  app.use(express.json());
  mountQa(app);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function get(baseUrl, path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

let prod, dev;

before(async () => {
  // Build the PROD app while NODE_ENV=production so mountQa sees prod and
  // never even require()s labrat.
  process.env.NODE_ENV = 'production';
  prod = await listen(buildApp());

  // Then a non-production app (mountQa mounts labrat here).
  process.env.NODE_ENV = 'test';
  dev = await listen(buildApp());

  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

after(async () => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (prod) await new Promise((r) => prod.server.close(r));
  if (dev) await new Promise((r) => dev.server.close(r));
  // labrat's require chain instantiates the pg Pool singleton; close it so the
  // test process exits cleanly even though we never issued a query.
  try { await pool.end(); } catch { /* pool never checked out a client */ }
});

test('F3: /api/qa is NOT mounted when NODE_ENV=production (endpoint 404s)', async () => {
  const r = await get(prod.baseUrl, '/api/qa/missions');
  assert.equal(r.status, 404, `expected 404 in prod, got ${r.status}`);
});

test('F3: /api/qa IS mounted outside production', async () => {
  const r = await get(dev.baseUrl, '/api/qa/missions');
  assert.equal(r.status, 200, `expected 200 outside prod, got ${r.status}`);
});
```

`/api/qa/missions` (labrat `GET /missions`) returns `res.json({ missions: catalog.all })` from the static `server/data/missions` catalog — no DB round-trip — so the dev-branch 200 needs no seeding.

2. Run it, expect FAIL (module does not exist yet):

```
node -r dotenv/config --test server/utils/qaMount.test.js
```

Expected: load-time failure `Error: Cannot find module './qaMount'` (both tests error).

3. Minimal implementation. Create `server/utils/qaMount.js`:

```js
/**
 * Mount the QA / labrat harness — but ONLY outside production.
 *
 * routes/labrat.js `POST /seed` mints loginable, self-escalating accounts via
 * runSeedRecipe(). The mount in index.js was unconditional, so in production
 * this was a live account-minting + privilege-escalation endpoint (F3). Gating
 * the mount makes the entire /api/qa/* tree 404 in prod. NODE_ENV is read at
 * call time so both branches are unit-testable in a single process.
 *
 * @param {import('express').Express} app
 */
function mountQa(app) {
  if (process.env.NODE_ENV === 'production') return;
  app.use('/api/qa', require('../routes/labrat'));
}

module.exports = { mountQa };
```

Then in `server/index.js`, replace the mount line:

```js
app.use('/api/qa', require('./routes/labrat'));
```

with:

```js
// QA / labrat harness. /api/qa/seed mints loginable, self-escalating accounts,
// so the whole /api/qa tree MUST 404 in production. The gate lives in a helper
// (server/utils/qaMount.js) so it is unit-testable without booting the server.
require('./utils/qaMount').mountQa(app);
```

4. Run the test, expect PASS:

```
node -r dotenv/config --test server/utils/qaMount.test.js
```

Expected: `# pass 2` / `# fail 0`.

5. Commit. Also add `qaMount.js` under the `server/utils/` folder tree in `README.md` (new util file — the pre-commit doc hook warns otherwise; this is a one-line tree entry, no behavior). Then:

```
git add server/utils/qaMount.js server/utils/qaMount.test.js server/index.js README.md
git commit -m "fix(F3): gate /api/qa mount to non-production so labrat /seed 404s in prod"
```

---

### Task F6 — OTP verify attempt-ceiling returns the neutral 400 (close the membership oracle)

In `server/routes/clientAuth.js` `POST /verify`, the per-account attempt-ceiling branch (lines 102–108) throws `ConflictError('Too many attempts. Please request a new code.', 'RATE_LIMITED')` → HTTP **409**, while every wrong/unknown/expired case throws `ValidationError({ otp: 'This code is invalid or has expired' })` → HTTP **400**. That 409-vs-400 divergence is a membership oracle: it reveals the email exists AND had a live OTP at the ceiling. Fix: on the ceiling branch, STILL invalidate the OTP server-side (unchanged), but throw the SAME neutral 400 `ValidationError`.

`ValidationError(fieldErrors, message = 'Please fix the errors below')` → `statusCode 400`, `code 'VALIDATION_ERROR'`, `fieldErrors` (verified in `server/utils/errors.js:11-15`). After removing the ceiling branch's `ConflictError`, that symbol is no longer referenced anywhere in `clientAuth.js` (verified — sole use is line 107), so its import must be dropped to avoid an unused-var lint failure.

**Files**
- Modify: `server/routes/clientAuth.js` (line 11 — the errors import; lines 102–108 — the ceiling branch)
- Test: `server/routes/clientAuth.otpNeutral.test.js` (new)

**Interfaces**
- Consumes: `ValidationError(fieldErrors, message?)` from `server/utils/errors.js` (verified). `ConflictError` no longer consumed by this file after the change.
- Produces: no new interface. Behavior change on `POST /api/client-auth/verify`: the ceiling case now returns 400 `VALIDATION_ERROR` `{ fieldErrors: { otp: 'This code is invalid or has expired' } }` — byte-identical to the unknown/wrong/expired responses — while continuing to null `auth_token`/`auth_token_expires_at` and reset `auth_token_attempts` to 0.

**Steps**

1. Write the failing test. Create `server/routes/clientAuth.otpNeutral.test.js` with the FULL contents (harness mirrors the existing `server/routes/clientAuth.revocation.test.js`: fresh Express app, mount the real router, mirror the global `AppError → { error, code, fieldErrors }` middleware, raw `http.request`):

```js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const clientAuthRouter = require('./clientAuth');

if (process.env.NODE_ENV === 'production') {
  throw new Error('clientAuth.otpNeutral.test.js refuses to run against production');
}

// F6: the /verify per-account attempt ceiling used to throw 409 RATE_LIMITED —
// a distinct status/code from the neutral 400 VALIDATION_ERROR returned for
// wrong/unknown/expired codes. That difference is a membership oracle (reveals
// the email exists AND had a live OTP). The fix returns the SAME neutral 400
// while STILL invalidating the OTP server-side.

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const emailFor = (tag) => `otpneutral-${tag}-${NONCE}@example.com`;

const seedAtCeiling = async (email) => {
  const hash = await bcrypt.hash('654321', 12);
  const expires = new Date(Date.now() + 10 * 60 * 1000);
  const c = await pool.query(
    `INSERT INTO clients (name, email, auth_token, auth_token_expires_at, auth_token_attempts)
     VALUES ($1, $2, $3, $4, 5) RETURNING id`,
    ['OTP Ceiling', email, hash, expires]
  );
  return c.rows[0].id;
};

let server, baseUrl, ceilingEmail;

before(async () => {
  ceilingEmail = emailFor('ceiling');
  await seedAtCeiling(ceilingEmail);

  const app = express();
  app.use(express.json());
  app.use('/api/client-auth', clientAuthRouter);
  // Mirror the real global error middleware (server/index.js).
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [`otpneutral-%-${NONCE}@example.com`]);
  await pool.end();
});

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-JSON */ } resolve({ status: res.statusCode, body: j }); });
      }
    );
    r.on('error', reject);
    r.write(payload);
    r.end();
  });
}

test('F6: attempt-ceiling /verify returns the neutral 400 (not 409 RATE_LIMITED)', async () => {
  const r = await post('/api/client-auth/verify', { email: ceilingEmail, otp: '000000' });
  assert.equal(r.status, 400, `expected neutral 400, got ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.code, 'VALIDATION_ERROR');
  assert.deepEqual(r.body.fieldErrors, { otp: 'This code is invalid or has expired' });
});

test('F6: the ceiling branch STILL invalidates the OTP server-side', async () => {
  const email = emailFor('invalidate');
  const id = await seedAtCeiling(email);
  await post('/api/client-auth/verify', { email, otp: '000000' });
  const row = await pool.query(
    'SELECT auth_token, auth_token_expires_at, auth_token_attempts FROM clients WHERE id = $1',
    [id]
  );
  assert.equal(row.rows[0].auth_token, null, 'OTP hash must be cleared');
  assert.equal(row.rows[0].auth_token_expires_at, null, 'OTP expiry must be cleared');
  assert.equal(row.rows[0].auth_token_attempts, 0, 'attempt counter must be reset');
});

test('F6: ceiling response is byte-identical to the unknown-email response (oracle closed)', async () => {
  const email = emailFor('parity');
  await seedAtCeiling(email);
  const ceiling = await post('/api/client-auth/verify', { email, otp: '000000' });
  const unknown = await post('/api/client-auth/verify', { email: emailFor('does-not-exist'), otp: '000000' });
  assert.equal(ceiling.status, unknown.status, `status mismatch: ceiling ${ceiling.status} vs unknown ${unknown.status}`);
  assert.deepEqual(ceiling.body, unknown.body, 'response bodies must be identical');
});
```

(Total `/verify` POSTs across the suite = 4, well under the `otpLimiter` cap of 10 per 15 min from a single IP, so the rate limiter does not interfere.)

2. Run it, expect FAIL (current ceiling branch returns 409/RATE_LIMITED):

```
node -r dotenv/config --test server/routes/clientAuth.otpNeutral.test.js
```

Expected: test 1 fails `expected neutral 400, got 409 {"error":"Too many attempts. Please request a new code.","code":"RATE_LIMITED"}`; test 3 fails on status mismatch (`ceiling 409 vs unknown 400`). (Test 2 already passes — the current code also nulls the token before throwing 409 — and stays green as a regression guard.)

3. Minimal implementation, `server/routes/clientAuth.js`. First drop the now-unused `ConflictError` import — change line 11 from:

```js
const { ValidationError, ConflictError } = require('../utils/errors');
```

to:

```js
const { ValidationError } = require('../utils/errors');
```

Then replace the ceiling branch (lines 102–108):

```js
  if ((client.auth_token_attempts ?? 0) >= 5) {
    await pool.query(
      'UPDATE clients SET auth_token = NULL, auth_token_expires_at = NULL, auth_token_attempts = 0 WHERE id = $1',
      [client.id]
    );
    throw new ConflictError('Too many attempts. Please request a new code.', 'RATE_LIMITED');
  }
```

with:

```js
  if ((client.auth_token_attempts ?? 0) >= 5) {
    // Invalidate the OTP entirely (the user must request a new code), but return
    // the SAME neutral 400 as the wrong/unknown/expired cases (F6). A distinct 409
    // RATE_LIMITED was a membership oracle — it revealed the email existed AND had
    // a live OTP. The invalidation above still enforces the ceiling.
    await pool.query(
      'UPDATE clients SET auth_token = NULL, auth_token_expires_at = NULL, auth_token_attempts = 0 WHERE id = $1',
      [client.id]
    );
    throw new ValidationError({ otp: 'This code is invalid or has expired' });
  }
```

4. Run the test, expect PASS:

```
node -r dotenv/config --test server/routes/clientAuth.otpNeutral.test.js
```

Expected: `# pass 3` / `# fail 0`.

Regression guard — run the sibling suite once (single suite at a time, shared DB) to confirm the import/branch change didn't disturb the revocation behavior:

```
node -r dotenv/config --test server/routes/clientAuth.revocation.test.js
```

Expected: still all-pass.

5. Commit:

```
git add server/routes/clientAuth.js server/routes/clientAuth.otpNeutral.test.js
git commit -m "fix(F6): OTP verify ceiling returns neutral 400, closing the membership oracle"
```


---

## Lane E — invoice_payments uniqueness (F7)

**Footprint:** `server/db/schema.sql`, `server/utils/invoicePaymentsUniqueLink.test.js` · **Deps:** none (independent; touches only the `invoice_payments` DDL tail + a new test) · **Review:** full fleet (schema migration on a LIVE money table + money seam) + `/second-opinion` at push

### Context established by reading the code (do not re-derive; this is the gating fact, resolved)

Three row shapes land in `invoice_payments`:

| Writer | file:line | `amount` | `refund_id` |
|---|---|---|---|
| Positive credit link | `server/utils/invoiceLinking.js:69-72` — `INSERT ... (invoice_id, payment_id, amount)` with `creditCents` (guaranteed `> 0`, no `refund_id` in column list) | **> 0** | **NULL** |
| New reversal | `server/utils/refundHelpers.js:207-210` — `INSERT ... (invoice_id, payment_id, amount, refund_id)` with `-take` and `refundRowId` | **< 0** | **set** |
| Legacy / pre-upgrade reversal | schema comment `schema.sql:1884-1885`; live fixture `invoices.refunds.test.js:71-74` (`INSERT ... amount = -5000`, no `refund_id`) | **< 0** | **NULL** |

A reversal row (new or legacy) **shares `(invoice_id, payment_id)` with its positive link**. Therefore:

- A plain `UNIQUE(invoice_id, payment_id)` collides on any refunded pair. Rejected.
- **The spec's suggested `WHERE refund_id IS NULL` is ALSO wrong** — it still catches the *legacy* reversal rows (amount<0, refund_id NULL) that share the pair with the positive link. It would (a) make `CREATE UNIQUE INDEX` fail on any prod proposal refunded before the refund_id upgrade, and (b) break the `before()` hook of the existing `invoices.refunds.test.js` (line 71-74 inserts exactly a NULL-refund_id negative row on top of the +50000 positive at line 63-66).
- **Correct predicate: `WHERE amount > 0`.** The true invariant is "at most one positive credit row per `(invoice_id, payment_id)`". This is already the codebase's own discriminator for a positive link (`invoices.js:108` `FILTER (WHERE ip.amount > 0)`; `payrollAccrual.js:219` `WHERE ... AND ip.amount > 0`). Every reversal row (amount<0) is excluded regardless of refund_id, so no legacy or new refunded data collides. Combined-payment positives never collide (they carry distinct `invoice_id`s). This is the adjustment the plan invited; the reason is legacy-reversal + existing-fixture safety.

Mirror the file's existing partial-unique-index convention verbatim (see `schema.sql:1046-1049`, `idx_proposal_refunds_stripe_refund_id`): a `CREATE UNIQUE INDEX IF NOT EXISTS … WHERE …` with a leading comment — natively idempotent, no DO-block needed (DO-blocks in this file guard `ALTER`/constraint swaps, not `CREATE INDEX`).

---

### Task E1 — partial unique index blocking a duplicate positive link

**Files**
- **Modify** `server/db/schema.sql` — insert after line 1889 (`CREATE INDEX IF NOT EXISTS idx_invoice_payments_refund_id …`), inside the `invoice_payments` DDL block, before the line-1891 comment.
- **Create (Test)** `server/utils/invoicePaymentsUniqueLink.test.js`

**Interfaces**
- **Consumes:** `pool` from `require('../db')` (`server/db/index.js` exports `{ pool, initDb, splitStatements }`, confirmed line 223). Table FKs: `invoice_payments.invoice_id → invoices(id)`, `.payment_id → proposal_payments(id)`, `.refund_id → proposal_refunds(id)`.
- **Produces:** DB object `uq_invoice_payments_positive_link` — a partial unique index on `invoice_payments(invoice_id, payment_id) WHERE amount > 0`. No JS signature; the deliverable is the constraint. On violation, `pg` raises SQLSTATE `23505` with `err.constraint = 'uq_invoice_payments_positive_link'`.

**Test conventions restated (DRB-specific):** `const { test, before, after } = require('node:test'); const assert = require('node:assert/strict');`. Run this suite alone (shared dev DB FK-collides on parallel teardown). `SEND_NOTIFICATIONS`/`RUN_SCHEDULERS` default OFF outside `NODE_ENV=production`, so no real sends fire. No Stripe in this suite. Tests never run `initDb`, so the migration is applied to the shared dev DB by hand in Step 4 via the real boot path.

---

#### Step 1 — write the failing test (full real code)

Create `server/utils/invoicePaymentsUniqueLink.test.js`:

```js
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// F7 (defense-in-depth): invoice_payments must reject a SECOND positive credit
// link for the same (invoice_id, payment_id) — a double-linked payment would
// break the sum(invoice_payments.amount) == invoices.amount_paid invariant and
// double-credit an invoice on a webhook redelivery. The guard is a PARTIAL
// unique index WHERE amount > 0 (positive links only): every refund reversal
// row is amount < 0 and MUST still be insertable even though it shares
// (invoice_id, payment_id) with its positive link — including LEGACY reversal
// rows that carry refund_id NULL (which a WHERE refund_id IS NULL predicate
// would wrongly reject). See invoiceLinking.js:69, refundHelpers.js:207.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoicePaymentsUniqueLink.test.js refuses to run against production');
}

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId, proposalId, invoiceId, paymentId, refundId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email) VALUES ('F7 Uniqueness Test', $1) RETURNING id`,
    [`f7-uniq-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, total_price, amount_paid)
     VALUES ($1, 'deposit_paid', 100, 100) RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;

  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Deposit', 10000, 10000, 'paid') RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`]
  );
  invoiceId = inv.rows[0].id;

  const pay = await pool.query(
    `INSERT INTO proposal_payments (proposal_id, payment_type, amount, status)
     VALUES ($1, 'deposit', 10000, 'succeeded') RETURNING id`,
    [proposalId]
  );
  paymentId = pay.rows[0].id;

  // A proposal_refunds row so the "new reversal" shape (refund_id set) is FK-valid.
  const ref = await pool.query(
    `INSERT INTO proposal_refunds
       (proposal_id, payment_id, amount, reason, total_price_before, total_price_after, status)
     VALUES ($1, $2, 5000, 'F7 test reversal', 100.00, 50.00, 'succeeded') RETURNING id`,
    [proposalId, paymentId]
  );
  refundId = ref.rows[0].id;

  // The ONE legitimate positive credit link (mirrors invoiceLinking.js:69-72).
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 10000)`,
    [invoiceId, paymentId]
  );
});

after(async () => {
  if (proposalId) {
    // proposal_refunds RESTRICTs proposal_payments + proposals — delete it first.
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [proposalId]);
    await pool.query(
      'DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)',
      [proposalId]
    );
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  }
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('a second positive credit link to the same (invoice, payment) is rejected', async () => {
  await assert.rejects(
    () => pool.query(
      `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, 10000)`,
      [invoiceId, paymentId]
    ),
    (err) => {
      assert.equal(err.code, '23505', `expected unique_violation 23505, got ${err.code}`);
      assert.equal(err.constraint, 'uq_invoice_payments_positive_link',
        `expected the partial-unique index, got ${err.constraint}`);
      return true;
    }
  );
});

test('reversal rows sharing (invoice, payment) with the positive link are still allowed (legacy NULL + stamped)', async () => {
  // Legacy reversal shape: amount < 0, refund_id NULL, shares (invoice, payment).
  // This is the row a WHERE refund_id IS NULL predicate would WRONGLY reject.
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount) VALUES ($1, $2, -5000)`,
    [invoiceId, paymentId]
  );
  // New reversal shape: amount < 0, refund_id set (mirrors refundHelpers.js:207-210).
  await pool.query(
    `INSERT INTO invoice_payments (invoice_id, payment_id, amount, refund_id) VALUES ($1, $2, -5000, $3)`,
    [invoiceId, paymentId, refundId]
  );
  const n = await pool.query(
    `SELECT COUNT(*)::int AS c FROM invoice_payments WHERE invoice_id = $1 AND payment_id = $2 AND amount < 0`,
    [invoiceId, paymentId]
  );
  assert.equal(n.rows[0].c, 2, 'both reversal rows must persist alongside the single positive link');
});
```

#### Step 2 — run it, expect FAIL

The index does not exist yet in `schema.sql`. Guarantee a clean RED by first dropping any copy a prior boot may have left in the shared dev DB, then run:

```bash
node -r dotenv/config -e "require('./server/db').pool.query('DROP INDEX IF EXISTS uq_invoice_payments_positive_link').then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)})"
node -r dotenv/config --test server/utils/invoicePaymentsUniqueLink.test.js
```

Expected: the first test FAILS. Without the index the second positive INSERT resolves, so `assert.rejects` reports **`Missing expected rejection`**. (The second test passes trivially — no constraint to violate.)

#### Step 3 — minimal implementation (exact schema.sql change)

In `server/db/schema.sql`, the current invoice_payments tail reads (lines 1888-1889):

```sql
ALTER TABLE invoice_payments ADD COLUMN IF NOT EXISTS refund_id INTEGER REFERENCES proposal_refunds(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_payments_refund_id ON invoice_payments(refund_id) WHERE refund_id IS NOT NULL;
```

Insert immediately after line 1889:

```sql
-- F7 (defense-in-depth): one payment must never double-link to one invoice.
-- PARTIAL unique on POSITIVE credit links only (amount > 0), which is the
-- codebase's own discriminator for a positive link (invoices.js FILTER
-- WHERE ip.amount > 0; payrollAccrual.js WHERE ip.amount > 0). Every refund
-- reversal row is amount < 0 and shares (invoice_id, payment_id) with its
-- positive link, so it is excluded — including LEGACY reversals with
-- refund_id NULL (a WHERE refund_id IS NULL predicate would collide on those,
-- both on pre-upgrade prod data and on the invoices.refunds.test fixture).
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_payments_positive_link
  ON invoice_payments(invoice_id, payment_id) WHERE amount > 0;
```

#### Step 4 — pre-flight dedupe check, then apply the migration to the dev DB

Tests do not run `initDb`, so apply the schema to the shared dev DB via the real boot path. **First** run the duplicate-positive-link probe (same query the prod pre-deploy step uses, below) so `CREATE UNIQUE INDEX` cannot fail mid-apply:

```bash
node -r dotenv/config -e "require('./server/db').pool.query(\"SELECT invoice_id, payment_id, COUNT(*) AS positive_links FROM invoice_payments WHERE amount > 0 GROUP BY invoice_id, payment_id HAVING COUNT(*) > 1\").then(r=>{console.log('dup positive links:', r.rowCount); console.log(r.rows); process.exit(r.rowCount>0?2:0)}).catch(e=>{console.error(e);process.exit(1)})"
```

Expected: `dup positive links: 0`. (If nonzero, STOP — the dev DB holds a pre-existing double-link; resolve it before the index can be created, and treat it as a real data finding.) Then apply schema idempotently:

```bash
node -r dotenv/config -e "require('./server/db').initDb().then(()=>{console.log('initDb ok'); process.exit(0)}).catch(e=>{console.error(e); process.exit(1)})"
```

`splitStatements` handles the new statement cleanly (single statement, terminated by `;`, no dollar-quoting or nested `;`). This is also the proof the schema.sql edit applies through production's boot codepath.

#### Step 5 — run test, expect PASS

```bash
node -r dotenv/config --test server/utils/invoicePaymentsUniqueLink.test.js
```

Expected: both tests PASS — `# pass 2`, `# fail 0`. Test 1: the duplicate positive INSERT rejects with `23505` / `constraint = uq_invoice_payments_positive_link`. Test 2: both negative reversal rows (legacy NULL + stamped) insert successfully alongside the single positive link.

#### Step 6 — commit

```bash
git add server/db/schema.sql server/utils/invoicePaymentsUniqueLink.test.js
git commit -m "F7: partial unique index on invoice_payments positive links

Add uq_invoice_payments_positive_link — UNIQUE(invoice_id, payment_id)
WHERE amount > 0 — so one payment can't double-link (double-credit) one
invoice on a webhook redelivery. Predicate is amount > 0, not refund_id
IS NULL: every reversal row (amount < 0) shares the pair with its
positive link, and legacy reversals carry refund_id NULL, so a
refund_id-based predicate would collide on pre-upgrade prod data. Matches
the existing positive-link discriminator (invoices.js / payrollAccrual.js).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Prod deploy note (run BEFORE this migration ships; carry into the push checklist)

`initDb` runs `CREATE UNIQUE INDEX` on boot against the LIVE `invoice_payments` table. If prod already holds two positive rows for one `(invoice_id, payment_id)`, index creation **fails and blocks boot**. Run this read-only probe against the prod DB first and confirm zero rows:

```sql
SELECT invoice_id, payment_id, COUNT(*) AS positive_links
FROM invoice_payments
WHERE amount > 0
GROUP BY invoice_id, payment_id
HAVING COUNT(*) > 1;
```

Zero rows → safe to deploy. Any rows → a real pre-existing double-link exists; do NOT ship the constraint until it is reconciled (that pair also violates `sum(invoice_payments.amount) == invoices.amount_paid`, so it is a money-integrity finding in its own right). Report the result of this query in the push announcement.


---

