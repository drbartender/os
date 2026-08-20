# Stale Proposal Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-archive past-dated, never-booked proposals with a new `archive_reason` of `event_passed`, reaping their invoices, shifts, and queued messages the same way the manual Archive button does.

**Architecture:** One new hourly scheduler (`server/utils/staleProposalSweep.js`) modeled on the auto-complete job next door. It selects candidates with a timezone-correct date expression, archives each in its own transaction using the shared reap helpers, then runs a post-commit tail outside the held connection. Safety comes from five mechanisms added after the design-stage review: a dry-run mode, a runaway bound, a re-entrancy guard, a run-level failure rethrow, and a bounded Stripe heal pass. It ships opt-in so deploy time is not execution time.

**Tech Stack:** Node.js, Express, PostgreSQL (`pg`), `node:test`, Sentry, Stripe, Resend via `notifyAdminCategory`.

**Spec:** `docs/superpowers/specs/2026-08-20-stale-proposal-sweep-design.md`

## Global Constraints

- Money columns `proposals.total_price` / `amount_paid` are **NUMERIC dollars**, not integer cents. Never do cents math on them.
- All SQL parameterized (`$1`, `$2`). No string concatenation of values.
- No em dashes in any admin email subject or body (`notifyAdminCategory` contract).
- API JSON keys snake_case; JavaScript variables camelCase.
- Lock order is global: `clients`, then `proposal_groups`, then `proposals`. Inverting deadlocks AB-BA against a concurrent settle.
- The sweep's pooled connection MUST be released before any post-commit helper runs. Every tail helper acquires its own pooled connection; holding across them is a deadlock CLAUDE.md records as twice-bitten.
- `accepted` is NEVER added to the swept status list. The demote ladder parks refunded-to-zero bookings there (`server/utils/proposalStatus.js:26-28`); sweeping it would mislabel a refunded booking as a lead that never booked.
- Tests run against the shared dev DB, one suite at a time, from the repo root. No test may assert a global COUNT; assert on your own fixture rows.
- Test command form: `node -r dotenv/config --test server/utils/<file>.test.js`

---

### Task 1: Plumb the `event_passed` reason end to end (no writer yet)

Adds the value to both CHECK definitions, the boot-time constraint guard, and the admin label map. Nothing writes it yet, so this task is independently safe to ship.

**Files:**
- Modify: `server/db/schema.sql` (two sites, about lines 2860 and 4146)
- Modify: `server/db/index.js:220`
- Modify: `client/src/pages/admin/ProposalsDashboard.js:43`

**Interfaces:**
- Consumes: nothing
- Produces: the DB accepts `proposals.archive_reason = 'event_passed'`; the admin archived list renders it as "Event passed".

- [ ] **Step 1: Add the value to BOTH schema.sql CHECK sites**

Both definitions must match. The file's own comment warns that they run as separate autocommit transactions, so a partial boot with disagreeing lists leaves the narrower one live, or no constraint at all.

At the first site (about line 2860, inside the `DO $$` block):

```sql
    CHECK (archive_reason IS NULL OR archive_reason IN ('no_hire','client_cancelled','we_cancelled','event_completed','other','option_not_chosen','event_passed'));
```

At the second site (about line 4146, the bare `ALTER`):

```sql
  CHECK (archive_reason IS NULL OR archive_reason IN
    ('no_hire','client_cancelled','we_cancelled','event_completed','other','option_not_chosen','event_passed'));
```

- [ ] **Step 2: Add the value to the boot-time constraint guard**

In `server/db/index.js`, the `CONSTRAINT_CONTRACT` entry currently reads:

```js
  { constraint: 'proposals_archive_reason_check', mustContain: ['option_not_chosen'] },
```

Change it to:

```js
  // 'event_passed' has a live writer (staleProposalSweep.js). A narrowed
  // constraint would raise 23514 on every swept row, so boot must fail loudly.
  { constraint: 'proposals_archive_reason_check',
    mustContain: ['option_not_chosen', 'event_passed'] },
```

- [ ] **Step 3: Add the admin label**

In `client/src/pages/admin/ProposalsDashboard.js`, the reason label map starting at line 43 gains one entry:

```js
  event_passed: 'Event passed',
```

Do NOT add it to the manual picker in `client/src/pages/admin/ProposalDetail.js:889`, and do NOT add it to `ARCHIVE_REASONS` in `server/routes/proposals/actions.js:434`. It is an auto-path-only marker, exactly like `event_completed` and `option_not_chosen`.

- [ ] **Step 4: Verify the constraint applies and accepts the new value**

Run:

```bash
node -r dotenv/config -e "
const { pool } = require('./server/db');
(async () => {
  const { rows } = await pool.query(\"SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'proposals_archive_reason_check'\");
  console.log(rows[0] ? rows[0].def : 'MISSING');
  await pool.end();
})();
"
```

Expected: the printed definition contains `event_passed`. If it prints `MISSING`, the boot-time apply has not run; start the server once to apply `schema.sql`, then re-check.

- [ ] **Step 5: Verify the boot guard passes**

`server/db/index.js` exports `findViolatedConstraintContracts`, which returns
human-readable violations of `CONSTRAINT_CONTRACT`. Run it directly:

```bash
node -r dotenv/config -e "
const { findViolatedConstraintContracts, pool } = require('./server/db');
(async () => {
  const violations = await findViolatedConstraintContracts();
  console.log(violations.length ? violations : 'no violations');
  await pool.end();
})();
"
```

Expected: `no violations`. A violation naming `proposals_archive_reason_check`
means the live constraint does not contain `event_passed`, so `schema.sql` has
not been re-applied; start the server once (`npm start`) to apply it, stop it,
then re-run this check.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.sql server/db/index.js client/src/pages/admin/ProposalsDashboard.js
git commit -F - <<'MSG'
feat(proposals): add event_passed archive reason

Plumbs the value through both schema.sql CHECK sites, the boot-time
CONSTRAINT_CONTRACT guard, and the admin archived-list label map. No
writer yet; the sweep that uses it lands in a later task.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 2: Report cancellation failures from `cancelOpenInvoiceIntents`

The sweep needs a bounded Stripe heal pass, and that is impossible today: `cancelOpenInvoiceIntents` never marks the `stripe_sessions` row, and it swallows its own errors, so a genuine Stripe failure is indistinguishable from a legitimate skip (a `processing` intent, or one whose metadata points at a different invoice). Without a failure signal, a heal pass would re-retrieve every PaymentIntent every hour forever.

This is a purely additive change. Existing callers destructure `{ canceled, checked }` and are unaffected by a third field.

**Files:**
- Modify: `server/utils/invoiceVoid.js:59-96`
- Test: `server/utils/invoiceVoid.failed.test.js` (create)

**Interfaces:**
- Consumes: nothing
- Produces: `cancelOpenInvoiceIntents(proposalId, invoiceId)` now resolves to `{ canceled: number, checked: number, failed: number }`, where `failed` counts intents whose retrieve or cancel threw.

- [ ] **Step 1: Write the failing test**

Create `server/utils/invoiceVoid.failed.test.js`:

```js
// cancelOpenInvoiceIntents must distinguish a Stripe FAILURE from a legitimate
// skip, so the stale-proposal sweep's heal pass can be bounded instead of
// retrying every intent forever. Run alone:
//   node -r dotenv/config --test server/utils/invoiceVoid.failed.test.js
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { cancelOpenInvoiceIntents, _setStripeForTests } = require('./invoiceVoid');

let seq = 0;
const madeProposals = [];

async function fixtureWithPendingSession(piId) {
  if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');
  const tag = `${process.pid}-${++seq}`;
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'other') RETURNING id`,
    [`VoidFail Fixture ${tag}`, `voidfail-${tag}@example.com`]
  );
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, guest_count, total_price, amount_paid, status)
     VALUES ($1, '2026-12-01', 50, 500, 0, 'viewed') RETURNING id`,
    [c.rows[0].id]
  );
  const proposalId = p.rows[0].id;
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, status, stripe_payment_intent_id)
     VALUES ($1, 'pending', $2)`,
    [proposalId, piId]
  );
  madeProposals.push(proposalId);
  return proposalId;
}

test.after(async () => {
  _setStripeForTests(null);
  for (const id of madeProposals) {
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [id]);
    const { rows } = await pool.query('SELECT client_id FROM proposals WHERE id = $1', [id]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
    if (rows[0]) await pool.query('DELETE FROM clients WHERE id = $1', [rows[0].client_id]);
  }
  await pool.end();
});

test('a Stripe retrieve failure is counted in failed, not silently dropped', async () => {
  const proposalId = await fixtureWithPendingSession(`pi_fail_${process.pid}_${seq}`);
  _setStripeForTests({
    paymentIntents: {
      retrieve: async () => { throw new Error('stripe is down'); },
      cancel: async () => { throw new Error('unreachable'); },
    },
  });
  const res = await cancelOpenInvoiceIntents(proposalId, 999);
  assert.equal(res.checked, 1);
  assert.equal(res.canceled, 0);
  assert.equal(res.failed, 1, 'a thrown retrieve must be reported as failed');
});

test('a legitimate skip is NOT counted as failed', async () => {
  const proposalId = await fixtureWithPendingSession(`pi_skip_${process.pid}_${seq}`);
  _setStripeForTests({
    paymentIntents: {
      // Not cancelable, and metadata points at a different invoice: both are
      // legitimate skips, and a heal pass must never retry them.
      retrieve: async (id) => ({ id, status: 'processing', metadata: { invoice_id: '12345' } }),
      cancel: async () => { throw new Error('should not be called'); },
    },
  });
  const res = await cancelOpenInvoiceIntents(proposalId, 999);
  assert.equal(res.checked, 1);
  assert.equal(res.canceled, 0);
  assert.equal(res.failed, 0, 'a skip is not a failure');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node -r dotenv/config --test server/utils/invoiceVoid.failed.test.js`
Expected: FAIL on the first test with `res.failed` being `undefined` rather than `1`.

- [ ] **Step 3: Add the counter**

In `server/utils/invoiceVoid.js`, inside `cancelOpenInvoiceIntents`:

Declare the counter next to `canceled` (about line 63):

```js
  let canceled = 0;
  // `failed` counts intents whose retrieve or cancel THREW. A non-cancelable
  // state or a metadata mismatch is a legitimate skip and is deliberately not
  // counted: staleProposalSweep's heal pass keys on this field, and counting
  // skips would make it retry the same intents on every tick forever.
  let failed = 0;
```

In the existing `catch (err)` block inside the loop, add the increment as the first line:

```js
    } catch (err) {
      failed += 1;
      console.warn(`cancelOpenInvoiceIntents: best-effort failure for ${piId}:`, err.message);
```

Change the return:

```js
  return { canceled, checked: rows.length, failed };
```

Also change the two early returns so the shape is consistent:

```js
  if (!stripe) return { canceled: 0, checked: 0, failed: 0 };
```

```js
    console.warn('cancelOpenInvoiceIntents: session lookup failed:', err.message);
    return { canceled: 0, checked: 0, failed: 0 };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node -r dotenv/config --test server/utils/invoiceVoid.failed.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the suites this reaches**

`cancelOpenInvoiceIntents` is called by the archive endpoint and the cancel flow.

Run, one at a time:

```bash
node -r dotenv/config --test server/routes/proposals/archive.test.js
node -r dotenv/config --test server/routes/stripeWebhook.archivedSettle.test.js
```

Expected: both PASS. If a file name differs, locate it with `ls server/routes/proposals/ | grep -i archive`.

- [ ] **Step 6: Commit**

```bash
git add server/utils/invoiceVoid.js server/utils/invoiceVoid.failed.test.js
git commit -F - <<'MSG'
feat(invoices): report Stripe cancellation failures from cancelOpenInvoiceIntents

Adds a `failed` count to the return shape, incremented only when a
retrieve or cancel THROWS. A non-cancelable state or a metadata
mismatch stays a legitimate skip.

The stale-proposal sweep needs this to bound its heal pass: the helper
never marks the stripe_sessions row, so without a failure signal a heal
would re-retrieve every intent on every hourly tick forever.

Purely additive; existing callers destructure canceled/checked only.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 3: The sweep core, plus dry-run mode

Selection query and the per-proposal transaction. No scheduler registration yet, no skip notice, no post-commit tail: those land in Tasks 4 through 7. This task's deliverable is a function you can call by hand that correctly archives the right rows and refuses the wrong ones.

**Files:**
- Create: `server/utils/staleProposalSweep.js`
- Test: `server/utils/staleProposalSweep.test.js` (create)

**Interfaces:**
- Consumes: `voidUnpaidProposalInvoice(proposalId, dbClient)` from `./invoiceVoid`; `reapShiftsForProposal(proposalId, dbClient, errorMessage)` from `./shiftReap`, which resolves to an array of `{ shiftId, userIds }`.
- Produces:
  - `SWEEP_STATUSES: string[]`
  - `LEGAL_HOLD_PROPOSAL_IDS: number[]`
  - `selectCandidates(db = pool): Promise<Array<{id, client_id, status, event_date, total_price}>>`
  - `archiveOne(proposalId): Promise<{proposalId, invoiceIds: number[], reaped: Array<{shiftId, userIds}>} | null>` — resolves `null` when the row vanished or left a swept status under the lock
  - `processStaleProposals(): Promise<{archived: number[], skippedIds: number[], failed: number, dryRun: boolean}>`

- [ ] **Step 1: Write the failing tests**

Create `server/utils/staleProposalSweep.test.js`:

```js
// Stale-proposal sweep. Run alone:
//   node -r dotenv/config --test server/utils/staleProposalSweep.test.js
//
// SHARED DEV DB NOTE: the sweep scans every proposal in the database and will
// legitimately archive unrelated stale rows. No test asserts a global count.
// Each asserts on ITS OWN fixture proposal by id.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  selectCandidates,
  archiveOne,
  SWEEP_STATUSES,
} = require('./staleProposalSweep');

let seq = 0;
const made = [];

// daysAgo(3) => a date string 3 days before today, so fixtures are relative to
// the run and never rot. Chicago is the fixture timezone throughout.
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

async function fixture({
  status = 'viewed', eventDate, amountPaid = 0, timezone = 'America/Chicago',
  clientless = false, invoice = null, pendingMessage = false,
}) {
  if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');
  const tag = `${process.pid}-${++seq}`;
  let clientId = null;
  if (!clientless) {
    const c = await pool.query(
      `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'other') RETURNING id`,
      [`Sweep Fixture ${tag}`, `sweep-${tag}@example.com`]
    );
    clientId = c.rows[0].id;
  }
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_timezone, guest_count,
                            total_price, amount_paid, status, sent_at)
     VALUES ($1, $2, $3, 50, 500, $4, $5, NOW()) RETURNING id`,
    [clientId, eventDate, timezone, amountPaid, status]
  );
  const proposalId = p.rows[0].id;
  let invoiceId = null;
  if (invoice) {
    const r = await pool.query(
      `INSERT INTO invoices (proposal_id, label, amount_due, amount_paid, status, invoice_number)
       VALUES ($1, 'Deposit', 10000, 0, $2, $3) RETURNING id`,
      [proposalId, invoice, `SW${tag}`]
    );
    invoiceId = r.rows[0].id;
  }
  if (pendingMessage) {
    await pool.query(
      `INSERT INTO scheduled_messages (entity_type, entity_id, status, channel, send_at, message_type)
       VALUES ('proposal', $1, 'pending', 'email', NOW() + INTERVAL '1 day', 'test_fixture')`,
      [proposalId]
    );
  }
  made.push({ proposalId, clientId });
  return { proposalId, clientId, invoiceId };
}

async function statusOf(proposalId) {
  const { rows } = await pool.query(
    'SELECT status, archive_reason FROM proposals WHERE id = $1', [proposalId]);
  return rows[0];
}

test.after(async () => {
  for (const { proposalId, clientId } of made) {
    await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = $2', ['proposal', proposalId]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [proposalId]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
    if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  }
  await pool.end();
});

test('SWEEP_STATUSES never contains accepted (the refunded-to-zero guard)', () => {
  assert.ok(!SWEEP_STATUSES.includes('accepted'),
    'accepted must stay exempt: the demote ladder parks refunded-to-zero bookings there');
});

test('archives a viewed proposal 3 days past its event date', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(3) });
  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(ids.includes(f.proposalId), 'should be a candidate');
  await archiveOne(f.proposalId);
  assert.deepEqual(await statusOf(f.proposalId),
    { status: 'archived', archive_reason: 'event_passed' });
});

test('does NOT archive a proposal only 1 day past its event date', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(1) });
  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(!ids.includes(f.proposalId), 'inside the 48-hour window');
});

test('does NOT archive an accepted proposal', async () => {
  const f = await fixture({ status: 'accepted', eventDate: daysAgo(10) });
  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(!ids.includes(f.proposalId));
});

test('does NOT archive a proposal carrying money', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(10), amountPaid: 250 });
  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(!ids.includes(f.proposalId));
});

test('voids the unpaid invoice and deletes pending scheduled messages', async () => {
  const f = await fixture({
    status: 'sent', eventDate: daysAgo(5), invoice: 'sent', pendingMessage: true });
  await archiveOne(f.proposalId);
  const inv = await pool.query('SELECT status FROM invoices WHERE id = $1', [f.invoiceId]);
  assert.equal(inv.rows[0].status, 'void');
  const msgs = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
    [f.proposalId]);
  assert.equal(msgs.rows[0].n, 0);
});

test('writes an activity-log row carrying the reap detail', async () => {
  const f = await fixture({
    status: 'viewed', eventDate: daysAgo(5), invoice: 'sent', pendingMessage: true });
  await archiveOne(f.proposalId);
  const { rows } = await pool.query(
    `SELECT action, actor_type, details FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = 'archived'`, [f.proposalId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_type, 'system');
  const d = typeof rows[0].details === 'string' ? JSON.parse(rows[0].details) : rows[0].details;
  assert.equal(d.archive_reason, 'event_passed');
  assert.equal(d.via, 'stale_proposal_sweep');
  assert.equal(d.deleted_pending_messages, 1);
  assert.equal(d.voided_invoice_ids.length, 1);
});

test('archiveOne returns null when the status changed under the lock', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5) });
  await pool.query(`UPDATE proposals SET status = 'deposit_paid' WHERE id = $1`, [f.proposalId]);
  assert.equal(await archiveOne(f.proposalId), null);
  assert.equal((await statusOf(f.proposalId)).status, 'deposit_paid');
});

test('archives a client-less proposal (the conditional client-lock branch)', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5), clientless: true });
  await archiveOne(f.proposalId);
  assert.equal((await statusOf(f.proposalId)).status, 'archived');
});

test('an option-group member sweeps like any other row', async () => {
  // 8 prod rows are group members and hit this on the first tick. No special
  // handling is intended: every member shares the event date, so a group whose
  // event passed with nothing chosen archives whole, one row at a time.
  const a = await fixture({ status: 'viewed', eventDate: daysAgo(4) });
  const b = await fixture({ status: 'viewed', eventDate: daysAgo(4) });
  const g = await pool.query(
    'INSERT INTO proposal_groups (client_id) VALUES ($1) RETURNING id', [a.clientId]);
  const groupId = g.rows[0].id;
  await pool.query('UPDATE proposals SET group_id = $1 WHERE id = ANY($2)',
    [groupId, [a.proposalId, b.proposalId]]);

  const ids = (await selectCandidates()).map((r) => r.id);
  assert.ok(ids.includes(a.proposalId) && ids.includes(b.proposalId));
  await archiveOne(a.proposalId);
  await archiveOne(b.proposalId);
  assert.equal((await statusOf(a.proposalId)).status, 'archived');
  assert.equal((await statusOf(b.proposalId)).status, 'archived');

  await pool.query('UPDATE proposals SET group_id = NULL WHERE group_id = $1', [groupId]);
  await pool.query('DELETE FROM proposal_groups WHERE id = $1', [groupId]);
});

test('a legal-hold id is never a candidate', async () => {
  const { LEGAL_HOLD_PROPOSAL_IDS } = require('./staleProposalSweep');
  assert.ok(LEGAL_HOLD_PROPOSAL_IDS.includes(600));
  const ids = (await selectCandidates()).map((r) => r.id);
  for (const held of LEGAL_HOLD_PROPOSAL_IDS) assert.ok(!ids.includes(held));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node -r dotenv/config --test server/utils/staleProposalSweep.test.js`
Expected: FAIL with `Cannot find module './staleProposalSweep'`.

- [ ] **Step 3: Write the module**

Create `server/utils/staleProposalSweep.js`:

```js
'use strict';

// staleProposalSweep — archive past-dated proposals that were never booked.
//
// Spec: docs/superpowers/specs/2026-08-20-stale-proposal-sweep-design.md
//
// The mirror of processEventCompletions (balanceScheduler.js), which completes
// past events that WERE paid. This one closes out the losing side: a quote that
// went out, the event date came and went, and nobody ever paid a deposit.
//
// ─── WHY 'accepted' IS EXEMPT ───────────────────────────────────────────────
//
// It reads like a courtesy ("a signed agreement deserves admin eyes") and it is
// also the money guard. reconcileProposalPaymentStatus (proposalStatus.js:26-28)
// demotes a fully refunded proposal to 'accepted': amount_paid is 0 but there is
// a real payment history. Sweeping 'accepted' would stamp a refunded booking
// 'event_passed' — "a lead that never booked" — which is false and destroys the
// distinction the archive_reason exists to carry.
//
// DO NOT add 'accepted' to SWEEP_STATUSES without solving that first.
//
// ─── THE DATE EXPRESSION ────────────────────────────────────────────────────
//
// AT TIME ZONE event_timezone, not CURRENT_DATE. The prod session runs in GMT,
// which rolls the date at 19:00 Chicago, so a naive comparison archives a
// Saturday-night event's quote while the party is still running.
//
// It deliberately does NOT read event_start_time. That column is free-text
// VARCHAR with mixed legacy formats, and depending on it is exactly what
// silently blocked every auto-completion until a regex guard was added. Anchored
// to midnight of event_date + 2, the sweep fires 24 to 48 hours after the event
// ends, which is the intended band.

const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { voidUnpaidProposalInvoice } = require('./invoiceVoid');
const { reapShiftsForProposal } = require('./shiftReap');

const SWEEP_STATUSES = Object.freeze(['draft', 'sent', 'viewed', 'modified']);

// Proposal 600 is on indefinite legal hold: never archive, reap, void, chase or
// sweep it. It is already excluded twice over (it is 'confirmed', and it carries
// a payment), but the rule must not depend on a status filter that a future edit
// could widen. Applied to BOTH the sweep query and the accepted-skip query.
const LEGAL_HOLD_PROPOSAL_IDS = Object.freeze([600]);

const ARCHIVE_REASON = 'event_passed';

const CANDIDATE_SQL = `
  SELECT id, client_id, status, event_date, total_price
    FROM proposals
   WHERE status = ANY($1)
     AND event_date IS NOT NULL
     AND ((event_date + INTERVAL '2 days') AT TIME ZONE event_timezone) < NOW()
     AND COALESCE(amount_paid, 0) = 0
     AND id <> ALL($2)
   ORDER BY id`;

/** Rows the sweep would archive right now. Pure read. */
async function selectCandidates(db = pool) {
  const { rows } = await db.query(CANDIDATE_SQL, [SWEEP_STATUSES, LEGAL_HOLD_PROPOSAL_IDS]);
  return rows;
}

/**
 * Archive ONE proposal in its own transaction, mirroring POST /proposals/:id/archive
 * (routes/proposals/actions.js) step for step so the two archive doors cannot drift.
 *
 * @returns {Promise<null|{proposalId:number, invoiceIds:number[], reaped:Array}>}
 *          null when the row vanished or left a swept status under the lock.
 */
async function archiveOne(proposalId) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');

    // LOCK ORDER (global: clients -> proposal_groups -> proposals). The client
    // row is locked BEFORE the proposal row, matching the settle paths. Locking
    // the proposal first inverts the order against a concurrent settle and can
    // deadlock AB-BA. No proposal_groups lock is needed: every group-archiving
    // path hoists the client lock first, which is what serializes them.
    const { rows: [peek] } = await db.query(
      'SELECT id, client_id FROM proposals WHERE id = $1', [proposalId]);
    if (!peek) { await db.query('ROLLBACK'); return null; }
    if (peek.client_id !== null) {
      await db.query('SELECT id FROM clients WHERE id = $1 FOR UPDATE', [peek.client_id]);
    }

    const { rows: [target] } = await db.query(
      'SELECT id, status FROM proposals WHERE id = $1 FOR UPDATE', [proposalId]);
    // Re-read under the lock: a proposal booked between selection and lock must
    // not be archived out from under the payment.
    if (!target || !SWEEP_STATUSES.includes(target.status)) {
      await db.query('ROLLBACK');
      return null;
    }

    await db.query(
      `UPDATE proposals SET status = 'archived', archive_reason = $2, updated_at = NOW()
        WHERE id = $1`,
      [proposalId, ARCHIVE_REASON]);

    const voidRes = await voidUnpaidProposalInvoice(proposalId, db);
    const reaped = await reapShiftsForProposal(proposalId, db, 'event passed, never booked');
    const delRes = await db.query(
      `DELETE FROM scheduled_messages
        WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending'`,
      [proposalId]);

    // DELETE rather than the 'suppressed' status is deliberate: it matches the
    // archive endpoint and cancel.js exactly. It is also unrecoverable — see the
    // Recovery section of the spec.
    await db.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'archived', 'system', $2)`,
      [proposalId, JSON.stringify({
        archive_reason: ARCHIVE_REASON,
        via: 'stale_proposal_sweep',
        voided_invoice_ids: voidRes.invoiceIds,
        deleted_pending_messages: delRes.rowCount,
        reaped_shift_ids: reaped.map((r) => r.shiftId),
      })]);

    await db.query('COMMIT');
    return { proposalId, invoiceIds: voidRes.invoiceIds, reaped };
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch (rbErr) {
      console.error(`[stale_proposal_sweep] ROLLBACK failed for #${proposalId}:`, rbErr.message);
    }
    throw err;
  } finally {
    // RELEASE BEFORE THE POST-COMMIT TAIL. Every tail helper acquires its own
    // pooled connection; holding this one across them is a deadlock CLAUDE.md
    // records as twice-bitten. The archive route does the same (actions.js:527).
    db.release();
  }
}

/** Scheduler entry point. Expanded in later tasks. */
async function processStaleProposals() {
  const dryRun = process.env.STALE_PROPOSAL_SWEEP_DRY_RUN === 'true';
  const candidates = await selectCandidates();

  if (dryRun) {
    console.log(`[stale_proposal_sweep] DRY RUN: ${candidates.length} candidate(s)`);
    for (const c of candidates) {
      console.log(`  #${c.id} ${c.status} event_date=${c.event_date && c.event_date.toISOString().slice(0, 10)} total=$${c.total_price}`);
    }
    return { archived: [], skippedIds: [], failed: 0, dryRun: true };
  }

  const archived = [];
  let failed = 0;
  for (const c of candidates) {
    try {
      const res = await archiveOne(c.id);
      if (res) archived.push(res.proposalId);
    } catch (err) {
      failed += 1;
      console.error(`[stale_proposal_sweep] archive failed for #${c.id}:`, err.message);
      Sentry.captureException(err, {
        tags: { scheduler: 'stale_proposal_sweep', step: 'archive' },
        extra: { proposalId: c.id },
      });
    }
  }
  return { archived, skippedIds: [], failed, dryRun: false };
}

module.exports = {
  SWEEP_STATUSES,
  LEGAL_HOLD_PROPOSAL_IDS,
  ARCHIVE_REASON,
  selectCandidates,
  archiveOne,
  processStaleProposals,
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node -r dotenv/config --test server/utils/staleProposalSweep.test.js`
Expected: PASS, 11 tests.

If the `voids the unpaid invoice` test fails on the `invoices` insert, check the real column set with `grep -n "CREATE TABLE invoices" -A 25 server/db/schema.sql` and adjust the fixture insert. Do not change the assertion.

- [ ] **Step 5: Commit**

```bash
git add server/utils/staleProposalSweep.js server/utils/staleProposalSweep.test.js
git commit -F - <<'MSG'
feat(proposals): stale-proposal sweep core

Selection query and the per-proposal archive transaction, mirroring
POST /proposals/:id/archive step for step so the two archive doors
cannot drift. Includes dry-run mode.

The date expression uses AT TIME ZONE event_timezone rather than
CURRENT_DATE (the prod session is GMT and rolls at 19:00 Chicago) and
deliberately does not read the free-text event_start_time column.

Not registered as a scheduler yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 4: Run-level safety — failure rethrow, runaway bound, re-entrancy guard

Three guards that only matter at run level, plus the summary log.

**Files:**
- Modify: `server/utils/staleProposalSweep.js`
- Modify: `server/utils/staleProposalSweep.test.js`

**Interfaces:**
- Consumes: `processStaleProposals` and `selectCandidates` from Task 3
- Produces: `MAX_ARCHIVES_PER_RUN: number`; `processStaleProposals` now throws when any row failed, returns `{ archived, skippedIds, failed, dryRun, abortedRunaway: boolean }`, and is safe against overlapping ticks.

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/staleProposalSweep.test.js`:

```js
const {
  processStaleProposals,
  MAX_ARCHIVES_PER_RUN,
  _setSelectCandidatesForTests,
} = require('./staleProposalSweep');

test('rethrows when any row failed, so wrapScheduler can record failed', async () => {
  // wrapScheduler (schedulerHealth.js) records 'failed' ONLY when the fn throws.
  // Without this rethrow, a systemic break (e.g. a narrowed CHECK raising 23514
  // on every row) fails every row every hour while scheduler_health reads green.
  _setSelectCandidatesForTests(async () => ([{ id: -1, status: 'viewed' }]));
  await assert.rejects(() => processStaleProposals(), /1 row\(s\) failed/);
  _setSelectCandidatesForTests(null);
});

test('runaway bound archives nothing when the candidate count is implausible', async () => {
  const fake = Array.from({ length: MAX_ARCHIVES_PER_RUN + 1 }, (_, i) => ({ id: -(i + 1), status: 'viewed' }));
  _setSelectCandidatesForTests(async () => fake);
  const res = await processStaleProposals();
  assert.equal(res.abortedRunaway, true);
  assert.equal(res.archived.length, 0, 'must archive NOTHING when the bound trips');
  _setSelectCandidatesForTests(null);
});

test('a second overlapping run is a no-op while the first is in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  _setSelectCandidatesForTests(async () => { await gate; return []; });
  const first = processStaleProposals();
  const second = await processStaleProposals();
  assert.equal(second.skippedReentrant, true);
  release();
  await first;
  _setSelectCandidatesForTests(null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node -r dotenv/config --test server/utils/staleProposalSweep.test.js`
Expected: FAIL — `_setSelectCandidatesForTests is not a function`.

- [ ] **Step 3: Add the guards**

In `server/utils/staleProposalSweep.js`, add below the existing constants:

```js
// A runaway bound, NOT a batch cap. The first production run is about 115 rows
// and steady state after that is 0 to 3 a day, so this never fires in normal
// operation. It exists so a future edit that widens the date expression or the
// status list cannot burn the live pipeline in one unattended tick.
const MAX_ARCHIVES_PER_RUN = 200;
```

Add the test seam and the re-entrancy flag above `processStaleProposals`:

```js
// Test seam, mirroring stripePayoutSync's _setStripeClientForTests pattern.
let _selectCandidates = null;
function _setSelectCandidatesForTests(fn) { _selectCandidates = fn; }

// wrapScheduler does not serialize ticks, and the first run makes roughly 220
// live Stripe calls, which can plausibly outlast an hourly interval. Two
// overlapping runs could both pass the accepted-skip marker check before either
// inserts, and double-send the skip email. scheduledMessageDispatcher.js:661
// rolls the same guard for the same reason.
let inFlight = false;
```

Replace `processStaleProposals` with:

```js
async function processStaleProposals() {
  if (inFlight) {
    console.warn('[stale_proposal_sweep] previous run still in flight; skipping this tick');
    return { archived: [], skippedIds: [], failed: 0, dryRun: false, skippedReentrant: true };
  }
  inFlight = true;
  try {
    const dryRun = process.env.STALE_PROPOSAL_SWEEP_DRY_RUN === 'true';
    const candidates = await (_selectCandidates || selectCandidates)();

    if (candidates.length > MAX_ARCHIVES_PER_RUN) {
      const msg = `[stale_proposal_sweep] RUNAWAY GUARD: ${candidates.length} candidates exceeds MAX_ARCHIVES_PER_RUN=${MAX_ARCHIVES_PER_RUN}; archiving nothing`;
      console.error(msg);
      Sentry.captureMessage('stale_proposal_sweep_runaway_guard', {
        level: 'error',
        tags: { scheduler: 'stale_proposal_sweep' },
        extra: { candidateCount: candidates.length, bound: MAX_ARCHIVES_PER_RUN },
      });
      return { archived: [], skippedIds: [], failed: 0, dryRun, abortedRunaway: true };
    }

    if (dryRun) {
      console.log(`[stale_proposal_sweep] DRY RUN: ${candidates.length} candidate(s)`);
      for (const c of candidates) {
        const d = c.event_date && new Date(c.event_date).toISOString().slice(0, 10);
        console.log(`  #${c.id} ${c.status} event_date=${d} total=$${c.total_price}`);
      }
      return { archived: [], skippedIds: [], failed: 0, dryRun: true, abortedRunaway: false };
    }

    const archived = [];
    let voidedInvoices = 0;
    let failed = 0;
    for (const c of candidates) {
      try {
        const res = await archiveOne(c.id);
        if (res) { archived.push(res.proposalId); voidedInvoices += res.invoiceIds.length; }
      } catch (err) {
        failed += 1;
        console.error(`[stale_proposal_sweep] archive failed for #${c.id}:`, err.message);
        Sentry.captureException(err, {
          tags: { scheduler: 'stale_proposal_sweep', step: 'archive' },
          extra: { proposalId: c.id },
        });
      }
    }

    if (archived.length > 0 || failed > 0) {
      console.log(
        `[stale_proposal_sweep] archived ${archived.length} (${archived.map((i) => `#${i}`).join(', ')}), ` +
        `voided ${voidedInvoices} invoice(s), ${failed} failed`
      );
    }

    // Rethrow so wrapScheduler records 'failed'. It records failure ONLY when
    // the fn throws (schedulerHealth.js), which is why balanceScheduler rethrows
    // too. Catching every row and returning quietly would let a systemic break
    // fail all 115 rows every hour while scheduler_health reads green forever.
    if (failed > 0) {
      throw new Error(`[stale_proposal_sweep] ${failed} row(s) failed of ${candidates.length} candidate(s)`);
    }

    return { archived, skippedIds: [], failed, dryRun: false, abortedRunaway: false };
  } finally {
    inFlight = false;
  }
}
```

Add `MAX_ARCHIVES_PER_RUN` and `_setSelectCandidatesForTests` to `module.exports`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node -r dotenv/config --test server/utils/staleProposalSweep.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/staleProposalSweep.js server/utils/staleProposalSweep.test.js
git commit -F - <<'MSG'
feat(proposals): run-level safety for the stale-proposal sweep

Three guards that only matter at run level:

- rethrow when any row failed, so wrapScheduler records 'failed'
  (it records failure only when the fn throws; without this a systemic
  break fails every row hourly while scheduler_health reads green)
- runaway bound at 200 candidates: archive nothing and alert, so a
  future edit widening the date expression cannot burn the live
  pipeline in one unattended tick
- re-entrancy guard, since the first run's Stripe calls can outlast an
  hourly interval and wrapScheduler does not serialize ticks

Plus a one-line run summary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 5: The `accepted` skip notice

Emails the admin when the sweep refuses a past-dated `accepted` proposal. Send BEFORE marking.

**Files:**
- Modify: `server/utils/staleProposalSweep.js`
- Modify: `server/utils/staleProposalSweep.test.js`

**Interfaces:**
- Consumes: `notifyAdminCategory({category, subject, emailHtml, emailText, smsBody})` from `./adminNotifications`, resolving to `{emailed: number, texted: number}`. `'routine_admin'` is a valid category.
- Produces: `SKIP_ACTION = 'auto_archive_skipped'`; `selectSkipCandidates(db = pool)`; `notifySkipped(): Promise<{notified: number[]}>`; `_setNotifierForTests(fn)`.

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/staleProposalSweep.test.js`:

```js
const { notifySkipped, SKIP_ACTION, _setNotifierForTests } = require('./staleProposalSweep');

async function skipMarkersFor(proposalId) {
  const { rows } = await pool.query(
    'SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = $2',
    [proposalId, SKIP_ACTION]);
  return rows.length;
}

test('emails once for a past-dated accepted proposal, and not again', async () => {
  const f = await fixture({ status: 'accepted', eventDate: daysAgo(6) });
  let calls = 0;
  _setNotifierForTests(async () => { calls += 1; return { emailed: 1, texted: 0 }; });

  const first = await notifySkipped();
  assert.ok(first.notified.includes(f.proposalId));
  assert.equal(calls, 1);
  assert.equal(await skipMarkersFor(f.proposalId), 1);

  const second = await notifySkipped();
  assert.ok(!second.notified.includes(f.proposalId), 'must not re-notify');
  assert.equal(await skipMarkersFor(f.proposalId), 1);
  _setNotifierForTests(null);
});

test('a failed send writes NO marker, so the next run retries', async () => {
  // notifyAdminCategory NEVER throws: it swallows per-recipient failures and a
  // Resend quota error, returning {emailed: 0}. Marking first would write the
  // marker, send nothing, and suppress every future attempt — the one case that
  // explicitly wants admin eyes would go permanently silent.
  const f = await fixture({ status: 'accepted', eventDate: daysAgo(6) });
  _setNotifierForTests(async () => ({ emailed: 0, texted: 0 }));
  const res = await notifySkipped();
  assert.ok(!res.notified.includes(f.proposalId));
  assert.equal(await skipMarkersFor(f.proposalId), 0, 'no marker on a failed send');

  let calls = 0;
  _setNotifierForTests(async () => { calls += 1; return { emailed: 1, texted: 0 }; });
  const retry = await notifySkipped();
  assert.ok(retry.notified.includes(f.proposalId), 'next run must retry');
  assert.equal(calls, 1);
  _setNotifierForTests(null);
});

test('the skip email carries no em dashes', async () => {
  const f = await fixture({ status: 'accepted', eventDate: daysAgo(6) });
  let captured = null;
  _setNotifierForTests(async (args) => { captured = args; return { emailed: 1, texted: 0 }; });
  await notifySkipped();
  assert.ok(captured, 'notifier was called');
  assert.ok(!captured.subject.includes('—'), 'no em dash in subject');
  assert.ok(!captured.emailText.includes('—'), 'no em dash in body');
  assert.equal(captured.category, 'routine_admin');
  assert.equal(captured.smsBody, undefined, 'email only, never SMS');
  assert.ok(String(captured.emailText).includes(String(f.proposalId)));
  _setNotifierForTests(null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node -r dotenv/config --test server/utils/staleProposalSweep.test.js`
Expected: FAIL — `notifySkipped is not a function`.

- [ ] **Step 3: Implement the notice**

Add to the requires in `server/utils/staleProposalSweep.js`:

```js
const { notifyAdminCategory } = require('./adminNotifications');
```

Add the constants and the query:

```js
const SKIP_ACTION = 'auto_archive_skipped';

// 'accepted' proposals past the same threshold. Exempt from the sweep by design,
// so they need a signal or they rot silently the way the original 116 did.
const SKIP_CANDIDATE_SQL = `
  SELECT p.id, p.event_date, p.total_price
    FROM proposals p
   WHERE p.status = 'accepted'
     AND p.event_date IS NOT NULL
     AND ((p.event_date + INTERVAL '2 days') AT TIME ZONE p.event_timezone) < NOW()
     AND p.id <> ALL($1)
     AND NOT EXISTS (
       SELECT 1 FROM proposal_activity_log l
        WHERE l.proposal_id = p.id AND l.action = $2)
   ORDER BY p.id`;

let _notifier = null;
function _setNotifierForTests(fn) { _notifier = fn; }

async function selectSkipCandidates(db = pool) {
  const { rows } = await db.query(SKIP_CANDIDATE_SQL, [LEGAL_HOLD_PROPOSAL_IDS, SKIP_ACTION]);
  return rows;
}
```

Add the notifier:

```js
/**
 * One batched email per run naming the past-dated 'accepted' proposals the sweep
 * refused to touch.
 *
 * SEND FIRST, THEN MARK. notifyAdminCategory NEVER throws: it swallows
 * per-recipient failures and a Resend QuotaExceededError (free tier is 100/day)
 * into a Sentry breadcrumb and returns {emailed: 0}. Marking first would write
 * the marker, send nothing, and then suppress every future attempt, so the one
 * case that explicitly wants admin eyes would go permanently silent. The
 * autopay-failure path in balanceScheduler.js orders it the same way.
 *
 * The check-then-insert is not atomic across processes. That is acceptable only
 * because prod is single-instance; the re-entrancy guard covers same-process
 * overlap.
 */
async function notifySkipped() {
  const rows = await selectSkipCandidates();
  if (rows.length === 0) return { notified: [] };

  // Copy stays NEUTRAL. A refunded-then-demoted booking also lands in 'accepted'
  // (proposalStatus.js:26-28), so this must not assert "signed, never paid".
  const lines = rows.map((r) => {
    const d = r.event_date && new Date(r.event_date).toISOString().slice(0, 10);
    return `Proposal #${r.id}, event date ${d}, total $${r.total_price}`;
  });
  const subject = `${rows.length} past-dated proposal(s) in accepted need a look`;
  const intro = 'These proposals are past their event date and still sit in "accepted", '
    + 'so the auto-archive sweep left them alone on purpose. Each one needs a decision: '
    + 'archive it, record a payment, or complete it.';
  const emailText = `${intro}\n\n${lines.join('\n')}\n`;
  const emailHtml = `<p>${intro}</p><ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;

  const send = _notifier || notifyAdminCategory;
  // smsBody omitted on purpose: email only.
  const res = await send({ category: 'routine_admin', subject, emailHtml, emailText });

  if (!res || !res.emailed) {
    console.warn(`[stale_proposal_sweep] skip notice reached 0 recipients; NOT marking, will retry next run`);
    Sentry.captureMessage('stale_proposal_sweep_skip_notice_undelivered', {
      level: 'warning',
      tags: { scheduler: 'stale_proposal_sweep' },
      extra: { proposalIds: rows.map((r) => r.id) },
    });
    return { notified: [] };
  }

  for (const r of rows) {
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, $2, 'system', $3)`,
      [r.id, SKIP_ACTION, JSON.stringify({ via: 'stale_proposal_sweep', emailed: res.emailed })]);
  }
  return { notified: rows.map((r) => r.id) };
}
```

Call it from `processStaleProposals`, after the archive loop and before the failure rethrow, isolated so it can never abort the run:

```js
    let skippedIds = [];
    try {
      ({ notified: skippedIds } = await notifySkipped());
    } catch (err) {
      console.error('[stale_proposal_sweep] skip notice failed:', err.message);
      Sentry.captureException(err, {
        tags: { scheduler: 'stale_proposal_sweep', step: 'skip_notice' },
      });
    }
```

Return `skippedIds` instead of the `[]` placeholder, and skip the whole block when `dryRun` is true (the dry-run branch returns early already, so no change is needed there beyond leaving it alone).

Export `SKIP_ACTION`, `selectSkipCandidates`, `notifySkipped`, and `_setNotifierForTests`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node -r dotenv/config --test server/utils/staleProposalSweep.test.js`
Expected: PASS, 17 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/staleProposalSweep.js server/utils/staleProposalSweep.test.js
git commit -F - <<'MSG'
feat(proposals): email the admin when the sweep skips an accepted proposal

One batched email per run naming past-dated proposals sitting in
'accepted', which the sweep exempts by design.

Sends BEFORE marking, and marks only on emailed > 0. notifyAdminCategory
never throws: it swallows per-recipient failures and a Resend quota
error into a breadcrumb and returns emailed: 0. Marking first would
write the marker, send nothing, and suppress every future attempt, so
the one case that explicitly wants admin eyes would go permanently
silent.

Copy stays neutral because a refunded-then-demoted booking also lands
in 'accepted'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 6: Post-commit tail and the bounded Stripe heal pass

**Files:**
- Modify: `server/utils/staleProposalSweep.js`
- Modify: `server/utils/staleProposalSweep.test.js`

**Interfaces:**
- Consumes: `cancelOpenInvoiceIntents(proposalId, invoiceId)` returning `{canceled, checked, failed}` (Task 2); `cancelMarketingForProposal(proposalId)` from `./marketingHandlers`; `cancelPendingChangeRequestsForProposal(proposalId, db = pool)` from `./changeRequests`.
- Produces: `HEAL_ACTION = 'pi_cancel_incomplete'`; `runPostCommitTail(result)`; `healStrandedIntents()`.

- [ ] **Step 1: Write the failing test**

Append to `server/utils/staleProposalSweep.test.js`:

```js
const { runPostCommitTail, healStrandedIntents, HEAL_ACTION } = require('./staleProposalSweep');
const invoiceVoid = require('./invoiceVoid');

test('a failed intent cancellation is recorded so the heal pass can retry it', async () => {
  const f = await fixture({ status: 'viewed', eventDate: daysAgo(5), invoice: 'sent' });
  const res = await archiveOne(f.proposalId);
  invoiceVoid._setStripeForTests({
    paymentIntents: {
      retrieve: async () => { throw new Error('stripe is down'); },
      cancel: async () => { throw new Error('unreachable'); },
    },
  });
  await pool.query(
    `INSERT INTO stripe_sessions (proposal_id, status, stripe_payment_intent_id)
     VALUES ($1, 'pending', $2)`, [f.proposalId, `pi_heal_${process.pid}`]);

  await runPostCommitTail(res);
  const { rows } = await pool.query(
    'SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = $2',
    [f.proposalId, HEAL_ACTION]);
  assert.equal(rows.length, 1, 'a thrown cancel must leave a heal marker');

  // The heal pass retries it, and a success clears the marker.
  invoiceVoid._setStripeForTests({
    paymentIntents: {
      retrieve: async (id) => ({ id, status: 'requires_payment_method', metadata: { invoice_id: String(res.invoiceIds[0]) } }),
      cancel: async () => ({}),
    },
  });
  await healStrandedIntents();
  const after = await pool.query(
    'SELECT id FROM proposal_activity_log WHERE proposal_id = $1 AND action = $2',
    [f.proposalId, HEAL_ACTION]);
  assert.equal(after.rows.length, 0, 'a clean retry clears the marker');
  invoiceVoid._setStripeForTests(null);
  await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = $1', [f.proposalId]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node -r dotenv/config --test server/utils/staleProposalSweep.test.js`
Expected: FAIL — `runPostCommitTail is not a function`.

- [ ] **Step 3: Implement the tail and the heal**

Add the requires:

```js
const { cancelOpenInvoiceIntents } = require('./invoiceVoid');
```

(extend the existing `./invoiceVoid` destructure rather than adding a second require)

Add:

```js
const HEAL_ACTION = 'pi_cancel_incomplete';

/**
 * Post-commit side effects. Runs AFTER the sweep's pooled connection is released,
 * because every helper here takes its own. Each step is isolated: a failure must
 * never abort the batch.
 *
 * cancelOpenInvoiceIntents is a ONE-SHOT effect on an already-committed row, and
 * the helper never marks the stripe_sessions row, so a Stripe outage would strand
 * the remainder forever (an archived proposal is never re-selected). When it
 * reports failures we drop a HEAL_ACTION marker for healStrandedIntents to pick
 * up. A non-cancelable state or a metadata mismatch is a legitimate skip and
 * leaves no marker, which is why invoiceVoid distinguishes them.
 */
async function runPostCommitTail(result) {
  if (!result) return;
  const { proposalId, invoiceIds, reaped } = result;

  let failedCancels = 0;
  for (const invoiceId of invoiceIds) {
    try {
      const r = await cancelOpenInvoiceIntents(proposalId, invoiceId);
      failedCancels += (r && r.failed) || 0;
    } catch (err) {
      failedCancels += 1;
      console.warn(`[stale_proposal_sweep] intent cancel threw for #${proposalId}/inv${invoiceId}:`, err.message);
    }
  }
  if (failedCancels > 0) {
    try {
      await pool.query(
        `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
         VALUES ($1, $2, 'system', $3)`,
        [proposalId, HEAL_ACTION, JSON.stringify({ via: 'stale_proposal_sweep', failed: failedCancels, invoice_ids: invoiceIds })]);
    } catch (logErr) {
      console.error(`[stale_proposal_sweep] heal marker insert failed for #${proposalId}:`, logErr.message);
    }
  }

  // Near no-op after the in-transaction DELETE, kept so this door matches the
  // archive endpoint exactly.
  try {
    const { cancelMarketingForProposal } = require('./marketingHandlers');
    await cancelMarketingForProposal(proposalId);
  } catch (err) {
    console.error(`[stale_proposal_sweep] marketing reap failed for #${proposalId}:`, err.message);
  }
  try {
    const { cancelPendingChangeRequestsForProposal } = require('./changeRequests');
    await cancelPendingChangeRequestsForProposal(proposalId);
  } catch (err) {
    console.error(`[stale_proposal_sweep] change-request reap failed for #${proposalId}:`, err.message);
  }
  if (reaped && reaped.length) {
    console.log(`[stale_proposal_sweep] #${proposalId} reaped ${reaped.length} shift(s)`);
  }
}

/**
 * Retry intent cancellations that a previous tick could not complete. Bounded by
 * the HEAL_ACTION marker: only proposals with a recorded failure are retried, and
 * a clean pass deletes the marker. Empty and free in steady state.
 */
async function healStrandedIntents() {
  const { rows } = await pool.query(
    `SELECT l.id AS log_id, l.proposal_id, l.details
       FROM proposal_activity_log l
       JOIN proposals p ON p.id = l.proposal_id
      WHERE l.action = $1 AND p.status = 'archived'
      ORDER BY l.id
      LIMIT $2`,
    [HEAL_ACTION, MAX_ARCHIVES_PER_RUN]);
  let healed = 0;
  for (const row of rows) {
    const details = typeof row.details === 'string' ? JSON.parse(row.details) : (row.details || {});
    const invoiceIds = details.invoice_ids || [];
    let stillFailing = 0;
    for (const invoiceId of invoiceIds) {
      try {
        const r = await cancelOpenInvoiceIntents(row.proposal_id, invoiceId);
        stillFailing += (r && r.failed) || 0;
      } catch (err) {
        stillFailing += 1;
      }
    }
    if (stillFailing === 0) {
      await pool.query('DELETE FROM proposal_activity_log WHERE id = $1', [row.log_id]);
      healed += 1;
    }
  }
  if (healed > 0) console.log(`[stale_proposal_sweep] healed ${healed} stranded intent set(s)`);
  return { healed, attempted: rows.length };
}
```

Wire both into `processStaleProposals`: collect each successful `archiveOne` result into a `tails` array during the loop, then after the loop (and before the skip notice) run:

```js
    for (const t of tails) await runPostCommitTail(t);
    try {
      await healStrandedIntents();
    } catch (err) {
      console.error('[stale_proposal_sweep] heal pass failed:', err.message);
      Sentry.captureException(err, { tags: { scheduler: 'stale_proposal_sweep', step: 'heal' } });
    }
```

Export `HEAL_ACTION`, `runPostCommitTail`, and `healStrandedIntents`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node -r dotenv/config --test server/utils/staleProposalSweep.test.js`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/staleProposalSweep.js server/utils/staleProposalSweep.test.js
git commit -F - <<'MSG'
feat(proposals): post-commit tail and bounded Stripe heal for the sweep

Runs the intent cancellation, marketing reap, and change-request reap
after the pooled connection is released, matching the archive endpoint.

cancelOpenInvoiceIntents is one-shot on an already-committed row and
never marks the stripe_sessions row, so a Stripe outage would strand
the remainder forever. Failures now leave a pi_cancel_incomplete
marker, and the heal pass retries only those, clearing the marker on a
clean run. Empty and free in steady state.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

### Task 7: Register the scheduler, opt-in, and land the documentation

**Files:**
- Modify: `server/index.js` (scheduler block, after the shift-closure registration)
- Modify: `.env.example`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `docs/fix-list-remaining-2026-07-02.md`

**Interfaces:**
- Consumes: `processStaleProposals` from `./utils/staleProposalSweep`
- Produces: the scheduler runs hourly when `RUN_STALE_PROPOSAL_SWEEP_SCHEDULER === 'true'`.

- [ ] **Step 1: Register the scheduler**

In `server/index.js`, after the shift-closure sweep block, add:

```js
      // Stale-proposal sweep — hourly. Archives past-dated proposals that were
      // never booked (spec 2026-08-20).
      //
      // OPT-IN, unlike its default-on siblings: it deliberately does NOT use
      // enabled(), which returns true unless the var is literally 'false'.
      // Deploying default-on would make deploy time execution time — about 115
      // archives, 104 invoice voids and 220 live Stripe calls, unattended, 150
      // seconds after the deploy lands. It also closes the dev path:
      // RUN_SCHEDULERS=true is a documented local pattern for exercising other
      // handlers, and this box talks to LIVE Stripe, so a default-on sweep would
      // ride along and cancel real live-mode PaymentIntents.
      //
      // Rollout: deploy dark, set STALE_PROPOSAL_SWEEP_DRY_RUN=true and read the
      // candidate list, then clear the dry-run flag and watch the backlog tick.
      if (process.env.RUN_STALE_PROPOSAL_SWEEP_SCHEDULER === 'true' && !globalScheduleDisabled) {
        const { processStaleProposals } = require('./utils/staleProposalSweep');
        const wrapped = wrapScheduler('stale_proposal_sweep', 3600, processStaleProposals);
        setTimeout(wrapped, 150000);
        setInterval(wrapped, 60 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('stale_proposal_sweep');
      }
```

150000ms is an unused boot offset (existing offsets include 15, 25, 30, 45, 60, 75, 90, 120, 180, 200, 210, 240, 270 and 300 seconds).

- [ ] **Step 2: Add both env vars to `.env.example`**

Add near the other `RUN_*_SCHEDULER` entries:

```
# Stale-proposal sweep: archives past-dated proposals that were never booked.
# OPT-IN. Unlike the other RUN_*_SCHEDULER flags this must be exactly 'true';
# unset or anything else keeps it dark. See the rollout note in server/index.js.
RUN_STALE_PROPOSAL_SWEEP_SCHEDULER=
# Set to 'true' to log the candidate list and write nothing. Use this before the
# first real run.
STALE_PROPOSAL_SWEEP_DRY_RUN=
```

- [ ] **Step 3: Add the env vars to the CLAUDE.md and README.md tables**

Add a row to each Environment Variables table:

| `RUN_STALE_PROPOSAL_SWEEP_SCHEDULER` | Opt-in (`'true'` exactly). Hourly sweep archiving past-dated, never-booked proposals. |
| `STALE_PROPOSAL_SWEEP_DRY_RUN` | `'true'` logs the sweep's candidate list and writes nothing. |

Also add `staleProposalSweep.js` to the README server/utils folder tree listing.

- [ ] **Step 4: Add the ARCHITECTURE.md entries**

In the schedulers section, add a line describing the hourly `stale_proposal_sweep` and its opt-in flag. In the Database Schema section, note that `proposals.archive_reason` now includes `event_passed`, written only by the sweep.

- [ ] **Step 5: Log the accepted-as-is items to the backlog**

Append to `docs/fix-list-remaining-2026-07-02.md`, in the open-items section:

```markdown
- **Stale proposal-token links render live CTAs after an archive.** `server/routes/proposals/publicToken.js:59`
  has no status filter and the client proposal view has no `archived` branch, so a client holding an
  emailed link to an archived proposal still sees a full page with working CTAs; signing returns a
  misleading "This proposal has already been accepted" 409. Pre-existing and identical for a manual
  archive, but the 2026-08-20 stale-proposal sweep makes it reachable for about 103 clients at once.
  Voided invoice links already fail gracefully (404 with "may have been voided" copy). Fix direction:
  an `archived` branch in the proposal view, and reason-aware copy on the sign 409.
- **`GET /api/client-portal/proposals/:token` has no status filter**, so archived proposals are unlisted
  rather than unreachable in the client portal. Pre-existing; noted during the stale-proposal sweep design.
- **`payment_on_archived` alert copy asserts a cancellation refund already ran** (`paymentIntentSucceeded.js:26`),
  which is false for an `event_passed` archive where nothing was ever paid. The refund instruction stays
  correct. Wants reason-aware copy.
```

- [ ] **Step 6: Verify the scheduler stays dark by default**

Run:

```bash
RUN_SCHEDULERS=true node -r dotenv/config -e "
const has = process.env.RUN_STALE_PROPOSAL_SWEEP_SCHEDULER === 'true';
console.log('would register:', has);
"
```

Expected: `would register: false` with the var unset. Then confirm the opposite:

```bash
RUN_STALE_PROPOSAL_SWEEP_SCHEDULER=true node -r dotenv/config -e "
console.log('would register:', process.env.RUN_STALE_PROPOSAL_SWEEP_SCHEDULER === 'true');
"
```

Expected: `would register: true`.

- [ ] **Step 7: Run the full reached-suite set**

One at a time, from the repo root:

```bash
node -r dotenv/config --test server/utils/staleProposalSweep.test.js
node -r dotenv/config --test server/utils/invoiceVoid.failed.test.js
node -r dotenv/config --test server/routes/proposals/archive.test.js
node -r dotenv/config --test server/routes/stripeWebhook.archivedSettle.test.js
node -r dotenv/config --test server/routes/proposals/crud.filters.test.js
node -r dotenv/config --test server/routes/proposals/metadata.shapes.test.js
```

Expected: all PASS. `crud.filters.test.js` matters because its `cohort=lost` predicate mirror asserts directly against `qLostValue`, which this change feeds.

- [ ] **Step 8: Lint**

Run: `npm run lint`
Expected: clean. Client-side lint is gated by Vercel CI, not locally.

- [ ] **Step 9: Commit**

```bash
git add server/index.js .env.example CLAUDE.md README.md ARCHITECTURE.md docs/fix-list-remaining-2026-07-02.md
git commit -F - <<'MSG'
feat(proposals): register the stale-proposal sweep, opt-in

Hourly, gated on RUN_STALE_PROPOSAL_SWEEP_SCHEDULER === 'true' rather
than the default-on enabled() helper, so deploy time is not execution
time and RUN_SCHEDULERS=true on a dev box cannot pull it into live
Stripe intent cancellations.

Documents both env vars in .env.example, CLAUDE.md and README, adds the
scheduler and the event_passed reason to ARCHITECTURE, and logs the
three accepted-as-is findings from the design review to the backlog.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## Rollout (after the plan is complete and pushed)

1. Deploy with `RUN_STALE_PROPOSAL_SWEEP_SCHEDULER` unset. Nothing runs.
2. Set `STALE_PROPOSAL_SWEEP_DRY_RUN=true` and `RUN_STALE_PROPOSAL_SWEEP_SCHEDULER=true`. Wait one tick, read the candidate list in the logs, confirm it is about 115 rows and that every one looks right.
3. Clear `STALE_PROPOSAL_SWEEP_DRY_RUN`. Watch the backlog tick.
4. Confirm the admin funnel moved by the amounts in the spec's blast-radius table: Lost up about $58,190, pipeline down about 115 rows and $58k, archived count up about 115.
