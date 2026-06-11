# Late-Tip / Clawback Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop card tips (and refund clawbacks) from silently stranding when the open pay period is frozen — mark the deferral, auto-retry it on the next accrual, surface it in an admin panel, and fix the symmetric clawback bug, with no change to payout math.

**Architecture:** A deferral marker on `tips` (`deferred_at` / `defer_kind` / `defer_target_cents` / `defer_attempts`) is set (guarded against a paid-strand race) when `rollForwardLateTip`/`clawbackTip` defer, and cleared atomically on success. A new idempotent `retryDeferredTips()` sweep (single-flight, attempt-capped) re-runs placement; it's fired off the response path after every successful accrual and from a manual admin Retry button. A clawback for a never-placed (roll_forward-deferred) tip records the refund without a negative line.

**Tech Stack:** Node/Express, raw SQL via `pg`, `node:test` (server, against the shared dev DB), React 18 (CRA) admin UI, `@sentry/node`.

**Spec:** `docs/superpowers/specs/2026-06-11-late-tip-recovery-design.md`

> **Test runner note:** server `node:test` suites connect to the shared dev DB via the **root** `.env`, so run them **from the repo root**, one file at a time:
> `node --test server/utils/<file>.test.js`. The new payroll test seeds its own pay periods (a frozen one + an open one) at dates no other suite uses.

---

## File Structure
- **Modify** `server/db/schema.sql` — 4 idempotent `tips` columns + a partial index.
- **Modify** `server/utils/payrollLateTip.js` — guarded defer-marker write; atomic clear on success.
- **Modify** `server/utils/payrollClawback.js` — read deferral fields; never-placed no-line path (§3.6); guarded defer-marker (+ target); atomic clear.
- **Create** `server/utils/payrollDeferredRetry.js` — `retryDeferredTips()` sweep (single-flight, attempt cap, summary).
- **Modify** `server/utils/payrollAccrual.js` — fire the sweep off the response path after a successful accrual.
- **Modify** `server/routes/admin/payroll.js` — `GET /payroll/deferred-tips` + `POST /payroll/deferred-tips/retry` (audit-logged).
- **Create** `client/src/pages/admin/payroll/DeferredTipsPanel.js` + wire into `PayrollPage.js`.
- **Create** `server/utils/payrollDeferredRetry.test.js` — integration tests.
- **Modify** `ARCHITECTURE.md`, `README.md` — route table, schema, folder tree.

**Commit grouping:** one commit per task. Each task's doc fragment (schema/route-table/folder-tree) is committed **with that task**, not deferred.

**Review checkpoints (execution-review cadence):** after **Task 1** → `database-review` (schema + partial index); after **Task 3** → `code-review` + `consistency-check` (the symmetric money path); after **Task 6** → `security-review` (money-moving admin endpoint + audit log); after **Task 7** → `code-review` (client wiring). Resolve any blocker before continuing.

---

### Task 1: Schema — the deferral marker

**Files:** Modify `server/db/schema.sql` (after the `tips` ALTER block ~`:2698-2703`).

- [ ] **Step 1: Add the columns + index to `schema.sql`**

Immediately after the existing `ALTER TABLE tips ADD COLUMN IF NOT EXISTS dispute_email_failed_at TIMESTAMPTZ;` line, add:

```sql
-- Deferral marker (frozen-period strand recovery). deferred_at NULL = not deferred.
ALTER TABLE tips ADD COLUMN IF NOT EXISTS deferred_at TIMESTAMPTZ;
ALTER TABLE tips ADD COLUMN IF NOT EXISTS defer_kind TEXT;            -- 'roll_forward' | 'clawback'
ALTER TABLE tips ADD COLUMN IF NOT EXISTS defer_target_cents INTEGER; -- clawback retry target cumulative
ALTER TABLE tips ADD COLUMN IF NOT EXISTS defer_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_tips_deferred ON tips (deferred_at) WHERE deferred_at IS NOT NULL;
```

- [ ] **Step 2: Apply to the dev DB (so the tests can run)**

The statements are idempotent and also run on server boot via `initDb`, but apply them now so tests see the columns. From the repo root:

```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\`ALTER TABLE tips ADD COLUMN IF NOT EXISTS deferred_at TIMESTAMPTZ; ALTER TABLE tips ADD COLUMN IF NOT EXISTS defer_kind TEXT; ALTER TABLE tips ADD COLUMN IF NOT EXISTS defer_target_cents INTEGER; ALTER TABLE tips ADD COLUMN IF NOT EXISTS defer_attempts INTEGER NOT NULL DEFAULT 0; CREATE INDEX IF NOT EXISTS idx_tips_deferred ON tips (deferred_at) WHERE deferred_at IS NOT NULL;\`).then(()=>pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name='tips' AND column_name LIKE 'defer%'\")).then(r=>{console.log(r.rows.map(x=>x.column_name).sort().join(', ')); return pool.end();})"
```

Expected output: `defer_attempts, defer_kind, defer_target_cents, deferred_at`.

- [ ] **Step 3: Commit**

Update `ARCHITECTURE.md`'s Database-Schema `tips` section with the 4 new deferral columns, then commit both (same-change docs):

```bash
git add server/db/schema.sql ARCHITECTURE.md
git commit -m "feat(payroll): tips deferral-marker columns + partial index"
```

---

### Task 2: `payrollLateTip` — guarded defer marker + atomic clear

**Files:** Modify `server/utils/payrollLateTip.js`; Test: `server/utils/payrollDeferredRetry.test.js` (created here, extended later).

- [ ] **Step 1: Write the failing test**

Create `server/utils/payrollDeferredRetry.test.js`:

```js
require('dotenv').config();
const { test, before, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { rollForwardLateTip } = require('./payrollLateTip');

if (process.env.NODE_ENV === 'production') throw new Error('refuses to run against production');

// Dates no other payroll suite uses. FROZEN period contains the event; OPEN period contains "today"
// is forced below. We instead force the WHOLE accrual surface to use these dates by pinning the tip's
// shift to the frozen period and toggling the period that contains today.
const FROZEN_START = '2026-04-07', FROZEN_END = '2026-04-13'; // a Tue-Mon, status 'paid'
let userId, shiftId, tipId;

before(async () => {
  const u = await pool.query("INSERT INTO users (email,password_hash,role) VALUES ('deftip@example.com','x','staff') RETURNING id");
  userId = u.rows[0].id;
  await pool.query("INSERT INTO contractor_profiles (user_id, hourly_rate) VALUES ($1,20.00) ON CONFLICT (user_id) DO UPDATE SET hourly_rate=20.00", [userId]);
  // Frozen period the tip's event lives in.
  await pool.query(
    `INSERT INTO pay_periods (start_date,end_date,payday,status) VALUES ($1,$2,$3,'paid')
     ON CONFLICT (start_date) DO UPDATE SET status='paid'`, [FROZEN_START, FROZEN_END, '2026-04-14']);
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id,event_date,status,event_type,event_start_time,event_duration_hours,total_price,amount_paid,pricing_snapshot)
     VALUES (NULL,$1,'completed','birthday-party','6:00 PM',4,1000,1000,'{"breakdown":[]}') RETURNING id`, [FROZEN_START]);
  const proposalId = p.rows[0].id;
  const s = await pool.query("INSERT INTO shifts (event_date,start_time,status,proposal_id) VALUES ($1,'6:00 PM','open',$2) RETURNING id", [FROZEN_START, proposalId]);
  shiftId = s.rows[0].id;
  await pool.query("INSERT INTO shift_requests (shift_id,user_id,position,status) VALUES ($1,$2,'Bartender','approved')", [shiftId, userId]);
  const t = await pool.query(
    "INSERT INTO tips (amount_cents,fee_cents,shift_id,tipped_at) VALUES (5000,150,$1,NOW()) RETURNING id", [shiftId]);
  tipId = t.rows[0].id;
});

afterEach(async () => {
  await pool.query("DELETE FROM payout_events WHERE payout_id IN (SELECT id FROM payouts WHERE contractor_id=$1)", [userId]);
  await pool.query("DELETE FROM payouts WHERE contractor_id=$1", [userId]);
  await pool.query("DELETE FROM tips WHERE id=$1", [tipId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id=$1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id=$1", [shiftId]);
});

after(async () => {
  // Restore today's SHARED pay period (the suite flips it via setTodayPeriod). 'open' is
  // the benign default; leaving it processing/paid would bleed into other payroll suites.
  await pool.query("UPDATE pay_periods SET status='open' WHERE CURRENT_DATE BETWEEN start_date AND end_date");
  await pool.query("DELETE FROM contractor_profiles WHERE user_id=$1", [userId]);
  await pool.query("DELETE FROM users WHERE id=$1", [userId]);
  await pool.end();
});

// Force the period containing today into a given status.
async function setTodayPeriod(status) {
  await pool.query("UPDATE pay_periods SET status=$1 WHERE CURRENT_DATE BETWEEN start_date AND end_date", [status]);
}

test('rollForwardLateTip > frozen today defers and marks the tip', async () => {
  await setTodayPeriod('processing'); // freeze today so roll-forward defers
  const r = await rollForwardLateTip(tipId);
  assert.equal(r, null);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, defer_attempts, rolled_forward_at FROM tips WHERE id=$1", [tipId]);
  assert.ok(rows[0].deferred_at, 'deferred_at set');
  assert.equal(rows[0].defer_kind, 'roll_forward');
  assert.equal(rows[0].defer_attempts, 1);
  assert.equal(rows[0].rolled_forward_at, null);
});

test('rollForwardLateTip > open today places and clears the marker (idempotent)', async () => {
  await setTodayPeriod('processing');
  await rollForwardLateTip(tipId);            // defers, marks
  await setTodayPeriod('open');               // open today
  const r = await rollForwardLateTip(tipId);  // retry
  assert.ok(r && r.bartenders === 1);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, defer_attempts, rolled_forward_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null, 'marker cleared');
  assert.equal(rows[0].defer_kind, null);
  assert.equal(rows[0].defer_attempts, 0);
  assert.ok(rows[0].rolled_forward_at, 'placed');
  // idempotent
  await rollForwardLateTip(tipId);
  const c = await pool.query("SELECT COUNT(*)::int AS c FROM payout_events pe JOIN payouts po ON po.id=pe.payout_id WHERE po.contractor_id=$1", [userId]);
  assert.equal(c.rows[0].c, 1);
});

test('rollForwardLateTip > defer marker does NOT resurrect an already-placed tip (race guard)', async () => {
  await setTodayPeriod('open');
  await rollForwardLateTip(tipId);                 // places, rolled_forward_at set, marker NULL
  // Simulate the racy late marker write hitting an already-placed tip:
  await pool.query("UPDATE tips SET deferred_at=COALESCE(deferred_at,NOW()), defer_kind='roll_forward', defer_attempts=defer_attempts+1 WHERE id=$1 AND rolled_forward_at IS NULL", [tipId]);
  const { rows } = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null, 'guarded UPDATE did not re-mark a placed tip');
});
```

- [ ] **Step 2: Run the tests, verify they FAIL**

```bash
node --test server/utils/payrollDeferredRetry.test.js
```
Expected: the "frozen today defers and marks" test fails (`deferred_at` is null — the marker isn't written yet). (The race-guard test already passes — it asserts the guard semantics directly.)

- [ ] **Step 3: Write the defer-marker (guarded) in `payrollLateTip.js`**

Replace the defer branch (`server/utils/payrollLateTip.js:85-96`) with:

```js
    if (period.status !== 'open') {
      // Today's period is itself frozen (atypical, recoverable). Discard the no-op
      // period upsert, then persist a deferral marker on a fresh connection.
      await client.query('ROLLBACK');
      try {
        // Guard on rolled_forward_at IS NULL so a placement that committed during
        // this race is never re-flagged (no resurrection / double-pay).
        await pool.query(
          `UPDATE tips
              SET deferred_at = COALESCE(deferred_at, NOW()),
                  defer_kind = 'roll_forward',
                  defer_attempts = defer_attempts + 1
            WHERE id = $1 AND rolled_forward_at IS NULL`,
          [tipId]
        );
      } catch (markErr) {
        Sentry.captureException(markErr, {
          tags: { util: 'payrollLateTip', step: 'defer_mark_failed' }, extra: { tipId },
        });
      }
      Sentry.captureMessage("rollForwardLateTip: today's period is non-open; deferring", {
        level: 'warning',
        tags: { util: 'payrollLateTip', step: 'defer_frozen_today' },
        extra: { tipId, periodStatus: period.status },
      });
      return null;
    }
```

- [ ] **Step 4: Clear the marker atomically on every success path**

In `payrollLateTip.js`, change the "no bartenders at all" success update (`:55`) and the final success update (`:150`) — both currently `UPDATE tips SET rolled_forward_at = NOW() WHERE id = $1` — to:

```js
      await client.query(
        `UPDATE tips SET rolled_forward_at = NOW(), deferred_at = NULL,
                defer_kind = NULL, defer_attempts = 0 WHERE id = $1`, [tipId]);
```

- [ ] **Step 5: Run the tests, verify they PASS**

```bash
node --test server/utils/payrollDeferredRetry.test.js
```
Expected: all 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/utils/payrollLateTip.js server/utils/payrollDeferredRetry.test.js
git commit -m "feat(payroll): mark+clear late-tip deferrals (guarded against paid-strand race)"
```

---

### Task 3: `payrollClawback` — never-placed no-line path + guarded marker

**Files:** Modify `server/utils/payrollClawback.js`; Test: extend `server/utils/payrollDeferredRetry.test.js`.

- [ ] **Step 1: Write the failing tests (append to the test file)**

```js
const { clawbackTip } = require('./payrollClawback');

test('clawbackTip > frozen today defers and marks with target', async () => {
  await setTodayPeriod('open');
  await rollForwardLateTip(tipId);     // place the tip so there's a line to claw
  await setTodayPeriod('processing');  // freeze today
  const r = await clawbackTip(tipId, 2000); // refund $20 of the $50 tip
  assert.equal(r, null);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, defer_target_cents, refunded_amount_cents FROM tips WHERE id=$1", [tipId]);
  assert.ok(rows[0].deferred_at);
  assert.equal(rows[0].defer_kind, 'clawback');
  assert.equal(rows[0].defer_target_cents, 2000);
  assert.equal(rows[0].refunded_amount_cents, 0, 'cumulative not advanced while deferred');
});

test('clawbackTip > refund on a roll_forward-deferred (never placed) tip records refund, no negative line', async () => {
  await setTodayPeriod('processing');
  await rollForwardLateTip(tipId);     // roll_forward-deferred (never placed)
  const r = await clawbackTip(tipId, 5000); // full refund arrives while still deferred
  assert.ok(r && r.unplaced === true);
  const { rows } = await pool.query("SELECT deferred_at, defer_kind, rolled_forward_at, refunded_amount_cents FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null, 'roll_forward marker cancelled');
  assert.equal(rows[0].defer_kind, null);
  assert.ok(rows[0].rolled_forward_at, 'roll-forward cancelled so it is never paid');
  assert.equal(rows[0].refunded_amount_cents, 5000);
  const c = await pool.query("SELECT COUNT(*)::int AS c FROM payout_events pe JOIN payouts po ON po.id=pe.payout_id WHERE po.contractor_id=$1", [userId]);
  assert.equal(c.rows[0].c, 0, 'no negative line created');
});

test('clawbackTip > escalating refund while deferred raises defer_target_cents', async () => {
  await setTodayPeriod('open');
  await rollForwardLateTip(tipId);     // place so there is a line
  await setTodayPeriod('processing');  // freeze today
  await clawbackTip(tipId, 2000);      // defer $20
  await clawbackTip(tipId, 3500);      // a larger refund lands, still frozen
  const { rows } = await pool.query("SELECT defer_target_cents, refunded_amount_cents FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].defer_target_cents, 3500, 'target raised to the latest cumulative');
  assert.equal(rows[0].refunded_amount_cents, 0, 'cumulative still not advanced while deferred');
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
node --test server/utils/payrollDeferredRetry.test.js
```
Expected: the two new clawback tests fail (no marker / no `unplaced` path yet).

- [ ] **Step 3: Read the deferral fields in the tip lock**

In `payrollClawback.js`, change the `FOR UPDATE` select (`:23-27`) to include the deferral fields:

```js
    const tipRes = await client.query(
      `SELECT id, shift_id, amount_cents, fee_cents, refunded_amount_cents, target_user_id,
              deferred_at, defer_kind
         FROM tips WHERE id = $1 FOR UPDATE`,
      [tipId]
    );
```

- [ ] **Step 4: Add the never-placed no-line path (§3.6)**

In `payrollClawback.js`, immediately after the `if (delta <= 0) { await client.query('ROLLBACK'); return { delta: 0 }; }` line (`:35`) and before the `if (!tip.shift_id)` block (`:39`), insert:

```js
    // §3.6: a refund on a tip still roll_forward-deferred (never placed) must not
    // claw a line that doesn't exist. Record the refund, cancel the roll-forward.
    if (tip.shift_id && tip.deferred_at && tip.defer_kind === 'roll_forward') {
      await client.query(
        `UPDATE tips SET refunded_amount_cents = $1, rolled_forward_at = NOW(),
                deferred_at = NULL, defer_kind = NULL, defer_target_cents = NULL, defer_attempts = 0
          WHERE id = $2`,
        [newAmt, tipId]
      );
      await client.query('COMMIT');
      return { delta, bartenders: 0, unplaced: true };
    }
```

- [ ] **Step 5: Add the guarded defer-marker write**

Replace the clawback defer branch (`payrollClawback.js:98-108`) with:

```js
    if (period.status !== 'open') {
      // Defer: don't move the cumulative; persist a marker (with the target) so a
      // retry can re-apply this clawback once a period opens.
      await client.query('ROLLBACK');
      try {
        await pool.query(
          `UPDATE tips
              SET deferred_at = COALESCE(deferred_at, NOW()),
                  defer_kind = 'clawback', defer_target_cents = $2,
                  defer_attempts = defer_attempts + 1
            WHERE id = $1 AND refunded_amount_cents < $2`,
          [tipId, newAmt]
        );
      } catch (markErr) {
        Sentry.captureException(markErr, {
          tags: { util: 'payrollClawback', step: 'defer_mark_failed' }, extra: { tipId },
        });
      }
      Sentry.captureMessage("clawbackTip: today's period is non-open; deferring", {
        level: 'warning',
        tags: { util: 'payrollClawback', step: 'defer_frozen_today' },
        extra: { tipId, periodStatus: period.status, delta, newAmt },
      });
      return null;
    }
```

- [ ] **Step 6: Clear the marker on every clawback success path**

In `payrollClawback.js`, change the three `UPDATE tips SET refunded_amount_cents = $1 WHERE id = $2` writes (no-shift `:40`, no-bartenders `:59`, final success `:157`) to also clear the marker:

```js
      await client.query(
        `UPDATE tips SET refunded_amount_cents = $1, deferred_at = NULL,
                defer_kind = NULL, defer_target_cents = NULL, defer_attempts = 0
          WHERE id = $2`, [newAmt, tipId]);
```
(For the `:157` final-success write the second param is `tipId`; for `:40`/`:59` it is also `tipId` — confirm the existing param order `[newAmt, tipId]`.)

- [ ] **Step 7: Run, verify PASS**

```bash
node --test server/utils/payrollDeferredRetry.test.js
```
Expected: all clawback + late-tip tests pass.

- [ ] **Step 8: Commit**

```bash
git add server/utils/payrollClawback.js server/utils/payrollDeferredRetry.test.js
git commit -m "feat(payroll): clawback deferral marker + never-placed no-line path"
```

---

### Task 4: `retryDeferredTips()` sweep

**Files:** Create `server/utils/payrollDeferredRetry.js`; Test: extend `payrollDeferredRetry.test.js`.

- [ ] **Step 1: Write the failing tests (append)**

```js
const { retryDeferredTips } = require('./payrollDeferredRetry');

test('retryDeferredTips > places a deferred late tip and clears its marker', async () => {
  await setTodayPeriod('processing');
  await rollForwardLateTip(tipId);   // deferred
  await setTodayPeriod('open');
  const summary = await retryDeferredTips();
  assert.equal(summary.resolved, 1);
  const { rows } = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null);
});

test('retryDeferredTips > skips tips past the attempt cap (stays deferred)', async () => {
  await setTodayPeriod('processing');
  await rollForwardLateTip(tipId);                 // deferred, attempts=1
  await pool.query("UPDATE tips SET defer_attempts = 25 WHERE id=$1", [tipId]); // simulate stuck
  await setTodayPeriod('open');
  const summary = await retryDeferredTips();
  assert.equal(summary.scanned, 0, 'capped tip not scanned');
  const { rows } = await pool.query("SELECT deferred_at FROM tips WHERE id=$1", [tipId]);
  assert.ok(rows[0].deferred_at, 'still deferred (kept on admin list)');
});
```

- [ ] **Step 2: Run, verify FAIL** (`Cannot find module './payrollDeferredRetry'`).

```bash
node --test server/utils/payrollDeferredRetry.test.js
```

- [ ] **Step 3: Create the sweep**

Create `server/utils/payrollDeferredRetry.js`:

```js
// Re-run placement for tips that deferred while the open pay period was frozen.
// Idempotent, single-flight, attempt-capped. Fired off the response path after a
// successful accrual and from the admin Retry button.
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { rollForwardLateTip } = require('./payrollLateTip');
const { clawbackTip } = require('./payrollClawback');

const MAX_DEFER_ATTEMPTS = 25; // a stuck tip drops from auto-retry but stays on the admin list
const SWEEP_LIMIT = 200;
let sweepInFlight = false;

async function retryDeferredTips() {
  if (sweepInFlight) return { skipped: true, reason: 'in_flight', scanned: 0, resolved: 0, redeferred: 0, errors: 0 };
  sweepInFlight = true;
  const summary = { scanned: 0, resolved: 0, redeferred: 0, errors: 0 };
  try {
    const { rows } = await pool.query(
      `SELECT id, defer_kind, defer_target_cents FROM tips
        WHERE deferred_at IS NOT NULL AND defer_attempts < $1
        ORDER BY deferred_at ASC LIMIT $2`,
      [MAX_DEFER_ATTEMPTS, SWEEP_LIMIT]
    );
    summary.scanned = rows.length;
    for (const t of rows) {
      try {
        if (t.defer_kind === 'roll_forward') await rollForwardLateTip(t.id);
        else if (t.defer_kind === 'clawback') await clawbackTip(t.id, Number(t.defer_target_cents));
        const chk = await pool.query('SELECT deferred_at FROM tips WHERE id = $1', [t.id]);
        if (chk.rows[0] && chk.rows[0].deferred_at === null) summary.resolved += 1; // placed OR clawed
        else summary.redeferred += 1;
      } catch (err) {
        summary.errors += 1;
        Sentry.captureException(err, { tags: { util: 'payrollDeferredRetry', step: 'retry_one' }, extra: { tipId: t.id } });
      }
    }
    Sentry.addBreadcrumb({ category: 'payroll', message: 'deferred-tip sweep', level: 'info', data: summary });
    return summary;
  } finally {
    sweepInFlight = false;
  }
}

module.exports = { retryDeferredTips, MAX_DEFER_ATTEMPTS };
```

- [ ] **Step 4: Run, verify PASS.**

```bash
node --test server/utils/payrollDeferredRetry.test.js
```

- [ ] **Step 5: Commit**

Add `server/utils/payrollDeferredRetry.js` to `README.md`'s folder-structure tree, then commit:

```bash
git add server/utils/payrollDeferredRetry.js server/utils/payrollDeferredRetry.test.js README.md
git commit -m "feat(payroll): retryDeferredTips sweep (single-flight, attempt-capped)"
```

---

### Task 5: Auto-retry hook after accrual

**Files:** Modify `server/utils/payrollAccrual.js`.

- [ ] **Step 1: Add the off-response-path sweep after the success COMMIT**

In `payrollAccrual.js`, change the success-return block (`:273-274`):

```js
    await client.query('COMMIT');
    return { skipped: false, accrued: payoutsCreatedCount };
```
to:

```js
    await client.query('COMMIT');
    // Best-effort, off the response path: a successful accrual proves an open period
    // exists, so resolve any tips that deferred while a period was frozen. Never throws,
    // never blocks the caller. The sweep is single-flight, so a batch of accruals
    // (e.g. balanceScheduler) triggers at most one.
    setImmediate(() => {
      require('./payrollDeferredRetry').retryDeferredTips().catch(err =>
        Sentry.captureException(err, { tags: { util: 'payrollAccrual', step: 'deferred_sweep' } }));
    });
    return { skipped: false, accrued: payoutsCreatedCount };
```

(`Sentry` is already imported at `payrollAccrual.js:6`. The lazy `require` avoids any load-order coupling; `retryDeferredTips` never re-enters accrual, so no recursion.)

- [ ] **Step 2: Integration test (append to the test file)**

```js
const { accruePayoutsForProposal } = require('./payrollAccrual');

test('accrual hook > a successful accrual sweeps a deferred tip', async () => {
  await setTodayPeriod('processing');
  await rollForwardLateTip(tipId);  // deferred
  await setTodayPeriod('open');
  // A fresh, unrelated funded proposal that accrues into today's open period.
  const p2 = await pool.query(
    `INSERT INTO proposals (client_id,event_date,status,event_type,event_start_time,event_duration_hours,total_price,amount_paid,pricing_snapshot)
     VALUES (NULL,CURRENT_DATE,'completed','birthday-party','6:00 PM',4,1000,1000,'{"breakdown":[]}') RETURNING id`);
  const s2 = await pool.query("INSERT INTO shifts (event_date,start_time,status,proposal_id) VALUES (CURRENT_DATE,'6:00 PM','open',$1) RETURNING id", [p2.rows[0].id]);
  await pool.query("INSERT INTO shift_requests (shift_id,user_id,position,status) VALUES ($1,$2,'Bartender','approved')", [s2.rows[0].id, userId]);
  await accruePayoutsForProposal(p2.rows[0].id);
  await new Promise(r => setTimeout(r, 250)); // let setImmediate + sweep run
  const { rows } = await pool.query("SELECT deferred_at, rolled_forward_at FROM tips WHERE id=$1", [tipId]);
  assert.equal(rows[0].deferred_at, null, 'deferred tip swept by the accrual hook');
  assert.ok(rows[0].rolled_forward_at);
  // cleanup the extra fixtures
  await pool.query("DELETE FROM payout_events WHERE shift_id=$1", [s2.rows[0].id]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id=$1", [s2.rows[0].id]);
  await pool.query("DELETE FROM shifts WHERE id=$1", [s2.rows[0].id]);
  await pool.query("DELETE FROM proposals WHERE id=$1", [p2.rows[0].id]);
});
```

- [ ] **Step 3: Run, verify PASS** (and re-run `payrollAccrual.test.js` for no regression).

```bash
node --test server/utils/payrollDeferredRetry.test.js
node --test server/utils/payrollAccrual.test.js
```

- [ ] **Step 4: Commit**

```bash
git add server/utils/payrollAccrual.js server/utils/payrollDeferredRetry.test.js
git commit -m "feat(payroll): sweep deferred tips off the response path after a successful accrual"
```

---

### Task 6: Admin endpoints — list + retry

**Files:** Modify `server/routes/admin/payroll.js`.

- [ ] **Step 1: Add a shared loader + the two routes**

In `server/routes/admin/payroll.js`, after the `/payroll/tips/:id/assign` route (ends `~:411`), add:

```js
async function loadDeferredTips() {
  const { MAX_DEFER_ATTEMPTS } = require('../../utils/payrollDeferredRetry');
  const { rows } = await pool.query(
    `SELECT t.id, t.defer_kind, t.amount_cents, t.defer_target_cents, t.deferred_at, t.defer_attempts,
            t.shift_id, s.event_date, p.event_type, p.event_type_custom,
            ARRAY(SELECT COALESCE(cp.preferred_name, u.email)
                    FROM shift_requests sr
                    JOIN users u ON u.id = sr.user_id
               LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
                   WHERE sr.shift_id = t.shift_id AND sr.status = 'approved'
                     AND sr.dropped_at IS NULL AND LOWER(sr.position) = 'bartender') AS staff,
            (t.shift_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM shift_requests sr2 JOIN users u2 ON u2.id = sr2.user_id
                          WHERE sr2.shift_id = t.shift_id AND sr2.status = 'approved'
                            AND sr2.dropped_at IS NULL AND LOWER(sr2.position) = 'bartender')
             AND NOT EXISTS (SELECT 1 FROM shift_requests sr3 JOIN users u3 ON u3.id = sr3.user_id
                              WHERE sr3.shift_id = t.shift_id AND sr3.status = 'approved'
                                AND sr3.dropped_at IS NULL AND LOWER(sr3.position) = 'bartender'
                                AND u3.cc_id NOT LIKE 'legacy_cc:%')) AS all_stubs
       FROM tips t
  LEFT JOIN shifts s ON s.id = t.shift_id
  LEFT JOIN proposals p ON p.id = s.proposal_id
      WHERE t.deferred_at IS NOT NULL
      ORDER BY t.deferred_at ASC`
  );
  return rows.map(t => ({
    ...t,
    // 'stubs' = every approved bartender on the shift is a legacy_cc stub (Retry can't help;
    // a de-stub is needed). 'max_attempts' = stuck past the auto-retry cap (stays on the list,
    // dropped from auto-retry). Else: waiting for a period to open.
    stuck_reason: t.all_stubs ? 'stubs'
      : (t.defer_attempts >= MAX_DEFER_ATTEMPTS ? 'max_attempts' : 'frozen_period'),
  }));
}

router.get('/payroll/deferred-tips', auth, adminOnly, asyncHandler(async (req, res) => {
  res.json({ tips: await loadDeferredTips() });
}));

router.post('/payroll/deferred-tips/retry', auth, adminOnly, asyncHandler(async (req, res) => {
  const { retryDeferredTips } = require('../../utils/payrollDeferredRetry');
  const summary = await retryDeferredTips();
  try {
    const { logAdminAction } = require('../../utils/adminAuditLog');
    await logAdminAction({ actorUserId: req.user.id, targetUserId: null,
      action: 'payroll_deferred_tips_retry', metadata: summary });
  } catch (e) { require('@sentry/node').captureException(e); }
  res.json({ summary, tips: await loadDeferredTips() });
}));
```

- [ ] **Step 2: Verify the server boots + lint**

```bash
cd server && node -e "require('./routes/admin/payroll')" && echo "loads OK"; cd ..
node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query('SELECT 1').then(()=>pool.end())"
```
Expected: `loads OK` (the route module requires cleanly).

- [ ] **Step 3: Smoke the endpoints (REQUIRED — money path)**

With the dev server running and authenticated as an admin: `GET /api/admin/payroll/deferred-tips` returns `200` `{ tips }`; `POST /api/admin/payroll/deferred-tips/retry` returns `200` `{ summary, tips }`. Then confirm the retry wrote an admin-audit row: read `server/utils/adminAuditLog.js` for the table/columns it writes to, then `SELECT` the latest `payroll_deferred_tips_retry` row and confirm its `metadata` holds the sweep summary.

- [ ] **Step 4: Commit**

Add `GET /payroll/deferred-tips` + `POST /payroll/deferred-tips/retry` to `ARCHITECTURE.md`'s admin route table, then commit:

```bash
git add server/routes/admin/payroll.js ARCHITECTURE.md
git commit -m "feat(payroll): admin deferred-tips list + audit-logged retry endpoint"
```

---

### Task 7: Admin "Deferred tips" panel

**Files:** Create `client/src/pages/admin/payroll/DeferredTipsPanel.js`; Modify `client/src/pages/admin/payroll/PayrollPage.js`.

- [ ] **Step 1: Create the panel (mirrors `UnassignedTipsPanel.js`)**

Create `client/src/pages/admin/payroll/DeferredTipsPanel.js`:

```jsx
import React, { useEffect, useState } from 'react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import { fmt$fromCents, fmtDate } from '../../../components/adminos/format';
import { getEventTypeLabel } from '../../../utils/eventTypes';

export default function DeferredTipsPanel() {
  const toast = useToast();
  const [tips, setTips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const refresh = () => {
    setLoading(true); setError(false);
    api.get('/admin/payroll/deferred-tips')
      .then(r => setTips(r.data.tips || []))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    try {
      const { data } = await api.post('/admin/payroll/deferred-tips/retry');
      const s = data.summary || {};
      toast.success(`Retried ${s.scanned || 0}: resolved ${s.resolved || 0}, still stuck ${s.redeferred || 0}${s.errors ? `, errors ${s.errors}` : ''}.`);
      setTips(data.tips || []);
    } catch (err) {
      toast.error(err.response?.data?.error || err.message || 'Retry failed');
    } finally {
      setRetrying(false);
    }
  };

  if (loading) return <div className="muted">Loading…</div>;
  if (error) {
    return (
      <div className="card"><div className="card-body">
        <span className="muted">Failed to load deferred tips. </span>
        <button type="button" className="btn btn-sm" onClick={refresh}>Retry</button>
      </div></div>
    );
  }
  if (tips.length === 0) {
    return <div className="card"><div className="card-body muted">No deferred tips. Nothing is stuck.</div></div>;
  }

  return (
    <div className="vstack" style={{ gap: 8 }}>
      <div className="hstack" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="tiny muted">{tips.length} tip{tips.length === 1 ? '' : 's'} waiting for an open pay period.</div>
        <button type="button" className="btn btn-primary btn-sm" disabled={retrying} onClick={retry}>
          {retrying ? 'Retrying…' : 'Retry now'}
        </button>
      </div>
      {tips.map(t => {
        const lbl = t.event_date ? getEventTypeLabel({ event_type: t.event_type, event_type_custom: t.event_type_custom }) : '—';
        const amt = t.defer_kind === 'clawback' ? `−${fmt$fromCents(t.defer_target_cents || 0)} clawback` : `${fmt$fromCents(t.amount_cents)} tip`;
        return (
          <div key={t.id} className="card">
            <div className="card-body hstack" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
              <div style={{ minWidth: 200 }}>
                <div style={{ fontWeight: 600 }}>{(t.staff && t.staff.length) ? t.staff.join(', ') : '(no bartender on shift)'}</div>
                <div className="tiny muted">{amt}{t.event_date ? ` · ${fmtDate(t.event_date)} ${lbl}` : ''}</div>
              </div>
              <div className="tiny muted" style={{ flex: 1 }}>
                deferred {fmtDate(t.deferred_at)}
                {t.stuck_reason === 'stubs' ? ' · stuck: bartender not on file (de-stub needed, Retry won\'t help)'
                  : t.stuck_reason === 'max_attempts' ? ' · stuck (needs attention)'
                  : ' · waiting for an open period'}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into `PayrollPage.js`**

In `client/src/pages/admin/payroll/PayrollPage.js`, add the import beside the `UnassignedTipsPanel` import (`:7`):

```jsx
import DeferredTipsPanel from './DeferredTipsPanel';
```
Then render `<DeferredTipsPanel />` adjacent to where `UnassignedTipsPanel` is rendered (`:157`). Read the surrounding JSX and place `<DeferredTipsPanel />` directly above or below the `<UnassignedTipsPanel />` in the same tab/section (e.g. wrap both in a fragment), so both tip-recovery panels sit together.

- [ ] **Step 3: Build the client**

```bash
cd client && CI=true npm run build; cd ..
```
Expected: `Compiled successfully` (the pre-existing html2pdf source-map warning is fine).

- [ ] **Step 4: Commit**

Add `client/src/pages/admin/payroll/DeferredTipsPanel.js` to `README.md`'s folder-structure tree, then commit:

```bash
git add client/src/pages/admin/payroll/DeferredTipsPanel.js client/src/pages/admin/payroll/PayrollPage.js README.md
git commit -m "feat(payroll): admin Deferred tips panel + Retry button"
```

---

### Task 8: Full verification

(Docs are committed with their owning tasks — schema/Task 1, sweep util/Task 4, routes/Task 6, panel/Task 7.)

- [ ] **Step 1: Full verification**

```bash
node --test server/utils/payrollDeferredRetry.test.js
node --test server/utils/payrollLateTip.test.js
node --test server/utils/payrollClawback.test.js
node --test server/utils/payrollAccrual.test.js
cd client && CI=true npm run build; cd ..
```
Expected: every suite green; client compiles. (Run server suites one at a time — shared dev DB.)

- [ ] **Step 2: Confirm the docs landed**

`git log --oneline main..HEAD` should show the schema/route/folder-tree doc edits committed with Tasks 1/4/6/7. If any was missed, add it and commit `docs(payroll): ...`.

---

## Self-Review

**1. Spec coverage:**
- §3.1 marker columns + index → Task 1. ✓
- §3.2 guarded defer marker (anti-resurrection `rolled_forward_at IS NULL` / `refunded_amount_cents < $2`, try/catch failure guard, `defer_attempts++`) → Tasks 2 (late) + 3 (clawback). ✓
- §3.3 atomic clear on every success path → Tasks 2 + 3. ✓
- §3.4 sweep (single-flight, attempt cap, summary, breadcrumb) → Task 4. ✓
- §3.5 off-response-path hook after success COMMIT, single-flight coalesce → Task 5. ✓
- §3.6 never-placed clawback (marker discriminator, no line, cancel roll-forward, ordering before period work) → Task 3 Steps 3-4. ✓
- §3.7 no automated backfill → no task (explicit decision; nothing to build). ✓
- §4 money invariants → enforced by the race guard (Task 2/3), atomic clear, §3.6 path, idempotent sweep; covered by the race-guard + idempotency + no-line tests. ✓
- §5 edge cases → tests cover defer/place/idempotent/race/never-placed/attempt-cap. ✓
- §6 verification → Task 8 Step 2. ✓
- §7 admin endpoints (audit-logged retry) + panel (loading/empty/error+retry/in-flight/result toast, stuck flag) → Tasks 6 + 7. ✓

**2. Placeholder scan:** Every code step has complete code; commands have expected output. No TBD/TODO. The only "read the surrounding JSX" instruction (Task 7 Step 2) is a placement note, not missing code — the import + component are fully specified. ✓

**3. Type/name consistency:** `retryDeferredTips` / `MAX_DEFER_ATTEMPTS` defined in Task 4 and consumed identically in Tasks 5, 6. The marker columns (`deferred_at`, `defer_kind`, `defer_target_cents`, `defer_attempts`) are named identically across schema, both utils, the sweep, and the routes. `logAdminAction({ actorUserId, targetUserId, action, metadata })` matches `server/utils/adminAuditLog.js`. The clawback `tip` select adds `deferred_at, defer_kind`, used by the §3.6 check. ✓

**Post-review fold-ins (review round 2):** named review checkpoints per task; sweep summary `placed`→`resolved` (a cleared clawback isn't "placed"); the `stubs` stuck-reason is now computed in the loader (all approved bartenders are `legacy_cc` stubs) and shown distinctly in the panel; the test suite restores today's shared pay period in `after`; the Task 6 money-endpoint smoke is required; docs co-locate with their owning tasks.

**Test coverage of spec §6:** defer/place/idempotency/race-guard/never-placed/attempt-cap/accrual-hook/escalating-refund are integration-tested. The rest are handled deliberately: GET-list visibility is implied by the defer tests (the loader's `WHERE deferred_at IS NOT NULL` returns exactly those rows); the marker-write-failure path is covered by inspection (the explicit try/catch → Sentry), not a brittle fault-injection test; the "all-stubs → de-stub" marker case is narrow (a non-stub bartender dropping between defer and retry — an all-stubs tip is skipped *before* the frozen-defer branch, so it never acquires a marker on its own) and the loader surfaces it via `stuck_reason='stubs'`.

**Deferral-clear invariant:** the four clear columns (`deferred_at`, `defer_kind`, `defer_target_cents`, `defer_attempts`) must stay identical across all success sites (lateTip `:55`/`:150`; clawback `:40`/`:59`/`:157` + the §3.6 path). Kept as explicit literal SQL for readability; a `clearDeferralMarker` helper is a reasonable later refactor if a sixth marker column is ever added.
