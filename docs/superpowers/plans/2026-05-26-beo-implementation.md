# BEO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Banquet Event Order (BEO) staff portal page, admin Finalize/Unfinalize lifecycle, and the T-3 SMS nudge for unacknowledged staffers, per `docs/superpowers/specs/2026-05-25-beo-design.md`.

**Architecture:** Three idempotent schema columns (`drink_plans.finalized_at`, `drink_plans.finalized_by`, `shift_requests.beo_acknowledged_at`). New `server/utils/beoHandlers.js` module owning scheduling, the dispatcher handler, and the reanchor helper. New `SuppressMessageError` class extends the dispatcher contract so handler-side gates suppress rows cleanly instead of failing. New `server/routes/beo.js` mounting 3 routes (GET BEO, GET logo, POST acknowledge). Lock-when-finalized guards on every drink-plan mutation route (drinkPlans.js + drinkPlanConsult.js). Suppression hooks on every shift-mutation path (cancel-or-unassign, generic PUT cancel, DELETE shift, DELETE request, PUT request deny, plus autoAssign scheduler). New staff page `client/src/pages/staff/StaffBeo.js`. Admin EventDetailPage gets a "View BEO" link + per-staffer "Confirmed [time]" pill; DrinkPlanCard gets Finalize/Unfinalize buttons; staff portal list pages get "View BEO" badge.

**Tech Stack:** Node 18 / Express 4.18, raw SQL via `pg`, React 18 (CRA), `node:test`, Sentry, Twilio (via existing `sendAndLogSms`).

**Scope guard:** This plan implements the spec verbatim. Any deviation must be flagged and discussed before commit. No design changes during implementation.

---

## Phase 1: Foundation (schema, error class, rate limiter)

### Task 1: Schema additions

**Files:**
- Modify: `server/db/schema.sql`

- [ ] **Step 1: Read the current `drink_plans` table block around line 336 and `shift_requests` around line 295**

Get oriented. The ALTERs land near the existing per-table migration sections that already use `ADD COLUMN IF NOT EXISTS`.

- [ ] **Step 2: Add the BEO columns**

Append to the migrations section that follows the relevant CREATE TABLE blocks. Use the existing `ADD COLUMN IF NOT EXISTS` pattern:

```sql
-- ─── BEO (Banquet Event Order) columns ──────────────────────────
ALTER TABLE drink_plans
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finalized_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE shift_requests
  ADD COLUMN IF NOT EXISTS beo_acknowledged_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_drink_plans_finalized_at
  ON drink_plans(finalized_at) WHERE finalized_at IS NOT NULL;
```

`ON DELETE SET NULL` on `finalized_by` keeps the column from blocking deletion of an admin who ever finalized.

- [ ] **Step 3: Apply the schema to the dev DB**

Run: `npm run db:schema`
Expected: clean output (idempotent ALTERs do nothing on re-run; first run prints the column adds).

- [ ] **Step 4: Verify the columns exist**

Run: `psql "$DATABASE_URL" -c "\d drink_plans" | grep -E 'finalized_at|finalized_by'`
Expected: two rows listing `finalized_at | timestamp with time zone` and `finalized_by | integer`.

Run: `psql "$DATABASE_URL" -c "\d shift_requests" | grep beo_acknowledged_at`
Expected: one row.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(beo): add finalized_at/finalized_by on drink_plans, beo_acknowledged_at on shift_requests"
```

---

### Task 2: SuppressMessageError class

**Files:**
- Modify: `server/utils/errors.js`

- [ ] **Step 1: Read the current errors.js to see the AppError hierarchy and module.exports**

The existing file exports `AppError`, `ValidationError`, `NotFoundError`, etc. `SuppressMessageError` is deliberately NOT an `AppError` subclass.

- [ ] **Step 2: Add the class**

Add this above `module.exports`:

```javascript
/**
 * Dispatcher contract: handlers throw this to mark their scheduled_messages row
 * as `status='suppressed'` with the given reason, without alerting Sentry or
 * routing through the global error middleware. NOT an AppError subclass on
 * purpose: this error is internal to the dispatcher and must never surface to
 * a client. Only handlers may throw it; lookup helpers must NOT, or the
 * dispatcher's discriminator would silently mask real failures.
 */
class SuppressMessageError extends Error {
  constructor(reason) {
    super(`message suppressed: ${reason}`);
    this.name = 'SuppressMessageError';
    this.reason = reason;
  }
}
```

Add `SuppressMessageError` to the `module.exports` object.

- [ ] **Step 3: Verify the file lints clean**

Run: `npx eslint server/utils/errors.js`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/utils/errors.js
git commit -m "feat(beo): add SuppressMessageError class for dispatcher gate suppression"
```

---

### Task 3: Dispatcher integration for SuppressMessageError

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.js`
- Modify: `server/utils/scheduledMessageDispatcher.test.js`

- [ ] **Step 1: Write the failing test**

Append to `scheduledMessageDispatcher.test.js`:

```javascript
const { test: smeTest } = require('node:test');
const smeAssert = require('node:assert/strict');

smeTest('dispatchRow > SuppressMessageError marks row suppressed without Sentry', async () => {
  const { pool } = require('../db');
  const { SuppressMessageError } = require('./errors');
  const { registerHandler, dispatchPending } = require('./scheduledMessageDispatcher');

  // Register a one-off handler that always throws SuppressMessageError
  registerHandler('test_sup_msg_err', async () => {
    throw new SuppressMessageError('test_suppress_reason');
  }, { offsetFromEventDate: 0, anchor: 'event_date', category: 'operational', priority: 4 });

  // Insert a proposal + scheduled_messages row pointed at our test handler
  const c = await pool.query("INSERT INTO clients (name, email) VALUES ('SupErr Test', 'sup-err@example.com') RETURNING id");
  const p = await pool.query("INSERT INTO proposals (client_id, event_date, status, event_type) VALUES ($1, CURRENT_DATE + 7, 'deposit_paid', 'birthday-party') RETURNING id", [c.rows[0].id]);
  const cli = await pool.query(
    `INSERT INTO scheduled_messages (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ('proposal', $1, 'test_sup_msg_err', 'client', $2, 'email', NOW() - INTERVAL '1 minute')
     RETURNING id`,
    [p.rows[0].id, c.rows[0].id]
  );

  await dispatchPending();

  const row = await pool.query('SELECT status, error_message FROM scheduled_messages WHERE id = $1', [cli.rows[0].id]);
  smeAssert.strictEqual(row.rows[0].status, 'suppressed');
  smeAssert.strictEqual(row.rows[0].error_message, 'test_suppress_reason');

  // Cleanup
  await pool.query('DELETE FROM scheduled_messages WHERE id = $1', [cli.rows[0].id]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: the new test fails with the row marked `failed` (not `suppressed`) because the dispatcher's catch doesn't yet discriminate.

- [ ] **Step 3: Add the SuppressMessageError import + discriminator**

In `server/utils/scheduledMessageDispatcher.js`, add near the existing requires at the top:

```javascript
const { SuppressMessageError } = require('./errors');
```

Find the `dispatchRow` function's try/catch around `await handler(...)`. The current pattern is roughly:

```javascript
try {
  await handler({ entity, recipient, scheduledMessage: row });
  await pool.query(
    "UPDATE scheduled_messages SET status='sent', sent_at=NOW(), error_message=NULL WHERE id=$1",
    [row.id]
  );
} catch (err) {
  // existing Sentry.captureException + console.error + status='failed' update
  ...
}
```

Insert the discriminator BEFORE the existing failure body inside the catch. The `instanceof` check MUST come first so legitimate suppressions never call Sentry:

```javascript
} catch (err) {
  // SuppressMessageError must be handled FIRST, before any Sentry / console call.
  // Suppressions are expected dispatch outcomes, not failures. Cap on the full
  // message matches the existing 500-char cap pattern on error_message writes.
  if (err instanceof SuppressMessageError) {
    const cappedReason = String(err.reason || '').slice(0, 500);
    await pool.query(
      "UPDATE scheduled_messages SET status='suppressed', error_message=$2 WHERE id=$1",
      [row.id, cappedReason]
    );
    return;
  }
  // existing failure path unchanged below
  ...
}
```

- [ ] **Step 4: Run the test, verify it now passes**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: all tests pass including the new one.

- [ ] **Step 5: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(beo): dispatcher discriminator for SuppressMessageError"
```

---

### Task 4: beoReadLimiter rate limiter

**Files:**
- Modify: `server/middleware/rateLimiters.js`

- [ ] **Step 1: Read the existing user-keyed limiter pattern**

Look at `adminSearchLimiter` (around line 110) and `adminWriteLimiter` (around line 100). They key on `req.user.id` with a unique prefix.

- [ ] **Step 2: Add `beoReadLimiter`**

Add near the other user-keyed limiters:

```javascript
// User-keyed limiter for the BEO read + acknowledge endpoints. Bartenders on a
// shared venue wifi / office NAT / CGNAT must not share a bucket, so this
// keys per req.user.id. 60 requests / 15 minutes is generous for a staffer
// refreshing while standing in a parking lot.
const beoReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => `beo-${req.user?.id || req.ip}`,
  standardHeaders: true,
  legacyHeaders: false,
});
```

Add `beoReadLimiter` to the `module.exports` object.

- [ ] **Step 3: Verify lint**

Run: `npx eslint server/middleware/rateLimiters.js`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/middleware/rateLimiters.js
git commit -m "feat(beo): user-keyed beoReadLimiter for the BEO routes"
```

---

## Phase 2: Core utility module + SMS template

### Task 5: SMS template `staffBeoNudgeSms`

**Files:**
- Modify: `server/utils/smsTemplates.js`
- Modify: `server/utils/smsTemplates.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `smsTemplates.test.js`:

```javascript
const { test: beoSmsTest } = require('node:test');
const beoSmsAssert = require('node:assert/strict');

beoSmsTest('staffBeoNudgeSms > includes event type, date, and URL', () => {
  const t = require('./smsTemplates');
  const body = t.staffBeoNudgeSms({
    eventTypeLabel: 'birthday party',
    eventDateLocal: 'Saturday, August 15',
    beoUrl: 'https://staff.drbartender.com/events/42/beo',
  });
  beoSmsAssert.match(body, /BEO ready from Dr\. Bartender/);
  beoSmsAssert.match(body, /birthday party/);
  beoSmsAssert.match(body, /Saturday, August 15/);
  beoSmsAssert.match(body, /https:\/\/staff\.drbartender\.com\/events\/42\/beo/);
  beoSmsAssert.ok(!body.includes('—'), 'no em dashes');
});

beoSmsTest('staffBeoNudgeSms > truncates long event type to 40 chars + ellipsis', () => {
  const t = require('./smsTemplates');
  const longLabel = 'My Daughter Sweet Sixteen Quinceanera Co-Birthday Celebration';
  const body = t.staffBeoNudgeSms({
    eventTypeLabel: longLabel,
    eventDateLocal: 'Saturday, August 15',
    beoUrl: 'https://staff.drbartender.com/events/42/beo',
  });
  // Find the truncated label in the body
  const truncated = body.match(/BEO ready from Dr\. Bartender: (.+) on /)[1];
  beoSmsAssert.ok(truncated.length <= 41, `expected truncated label <= 41 chars, got ${truncated.length}: "${truncated}"`);
});

beoSmsTest('staffBeoNudgeSms > strips non-GSM-7 characters before length check', () => {
  const t = require('./smsTemplates');
  const body = t.staffBeoNudgeSms({
    eventTypeLabel: 'cafe quinceanera party',
    eventDateLocal: 'Saturday, August 15',
    beoUrl: 'https://staff.drbartender.com/events/42/beo',
  });
  // GSM-7 sanity: no curly quotes or other UCS-2-only chars
  beoSmsAssert.ok(!/[“”‘’]/.test(body), 'no curly quotes');
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `node --test server/utils/smsTemplates.test.js`
Expected: three new tests fail because `staffBeoNudgeSms` is not exported.

- [ ] **Step 3: Implement the template**

Add to `server/utils/smsTemplates.js`, near the other staff SMS templates:

```javascript
/**
 * BEO unack nudge SMS (spec section 6.3). The CTA drives staff to the portal
 * where the click is itself the read-receipt signal; we do NOT reuse the
 * existing CONFIRM keyword. Body length budgeted for 2 segments worst case;
 * eventTypeLabel is GSM-7-normalized then truncated to 40 chars to avoid an
 * unexpected UCS-2 segment-cap halving.
 */
function staffBeoNudgeSms({ eventTypeLabel, eventDateLocal, beoUrl }) {
  const normalized = String(eventTypeLabel || 'your event')
    // Replace curly quotes and accented chars with GSM-7-safe equivalents.
    // This is a pragmatic minimum; the spec accepts the larger UCS-2 cost
    // when normalization fails (e.g., emoji).
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  const truncated = normalized.length > 40
    ? normalized.slice(0, 40) + '…'
    : normalized;
  return `BEO ready from Dr. Bartender: ${truncated} on ${eventDateLocal}. Tap to review and confirm: ${beoUrl}`;
}
```

Add `staffBeoNudgeSms` to `module.exports`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test server/utils/smsTemplates.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsTemplates.js server/utils/smsTemplates.test.js
git commit -m "feat(beo): staffBeoNudgeSms template"
```

---

### Task 6: Export `formatEventDateLong` from `staffShiftHandlers.js`

**Files:**
- Modify: `server/utils/staffShiftHandlers.js`

- [ ] **Step 1: Open the file and find the module.exports block**

Around lines 725-742. `formatEventDateLong` is defined at line 349 but missing from the exports.

- [ ] **Step 2: Add `formatEventDateLong` to the exports**

```javascript
module.exports = {
  toCalendarYmd,
  parseClockTime,
  // ... existing entries ...
  formatEventDateLong,  // new: needed by beoHandlers for SMS body date formatting
  // ... rest of existing entries
};
```

- [ ] **Step 3: Verify importable**

Run: `node -e "const { formatEventDateLong } = require('./server/utils/staffShiftHandlers'); console.log(typeof formatEventDateLong);"`
Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
git add server/utils/staffShiftHandlers.js
git commit -m "feat(beo): export formatEventDateLong for cross-SMS date formatting"
```

---

### Task 7: `beoHandlers.js`: `insertBeoNudgeIfMissing` + tests

**Files:**
- Create: `server/utils/beoHandlers.js`
- Create: `server/utils/beoHandlers.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/beoHandlers.test.js`:

```javascript
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

let clientId, proposalId, userId, shiftId;

before(async () => {
  const c = await pool.query("INSERT INTO clients (name, email) VALUES ('BEO Test', 'beo-test@example.com') RETURNING id");
  clientId = c.rows[0].id;
  const p = await pool.query(
    "INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type) VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party') RETURNING id",
    [clientId]
  );
  proposalId = p.rows[0].id;
  const u = await pool.query(
    "INSERT INTO users (email, password, role, onboarding_status) VALUES ('beo-test-staff@example.com', 'x', 'staff', 'active') RETURNING id"
  );
  userId = u.rows[0].id;
  await pool.query(
    "INSERT INTO contractor_profiles (user_id, phone, preferred_name) VALUES ($1, '+15555550101', 'Test Staffer')",
    [userId]
  );
  const s = await pool.query(
    "INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id",
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    "INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')",
    [shiftId, userId]
  );
  await pool.query(
    "UPDATE drink_plans SET selections = '{\"signatureDrinks\":[\"sd_1\"]}'::jsonb WHERE proposal_id = $1",
    [proposalId]
  );
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id = $1 AND entity_type = 'proposal'", [proposalId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [shiftId]);
  await pool.query("DELETE FROM drink_plans WHERE proposal_id = $1", [proposalId]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [proposalId]);
  await pool.query("DELETE FROM contractor_profiles WHERE user_id = $1", [userId]);
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.query("DELETE FROM clients WHERE id = $1", [clientId]);
});

test('insertBeoNudgeIfMissing > inserts pending row', async () => {
  const { insertBeoNudgeIfMissing } = require('./beoHandlers');
  const scheduledFor = new Date(Date.now() + 60 * 1000);
  await insertBeoNudgeIfMissing(pool, { proposalId, userId, scheduledFor });
  const { rows } = await pool.query(
    "SELECT status, recipient_id FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND message_type='beo_unack_nudge_sms'",
    [proposalId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'pending');
  assert.strictEqual(rows[0].recipient_id, userId);
});

test('insertBeoNudgeIfMissing > skips when pending row already exists', async () => {
  const { insertBeoNudgeIfMissing } = require('./beoHandlers');
  const scheduledFor = new Date(Date.now() + 60 * 1000);
  await insertBeoNudgeIfMissing(pool, { proposalId, userId, scheduledFor });
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND message_type='beo_unack_nudge_sms'",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1, 'expected still 1 row, not 2');
});

test('insertBeoNudgeIfMissing > re-inserts when only suppressed rows exist', async () => {
  const { insertBeoNudgeIfMissing } = require('./beoHandlers');
  await pool.query(
    "UPDATE scheduled_messages SET status='suppressed', error_message='unfinalized' WHERE entity_type='proposal' AND entity_id=$1 AND message_type='beo_unack_nudge_sms'",
    [proposalId]
  );
  const scheduledFor = new Date(Date.now() + 60 * 1000);
  await insertBeoNudgeIfMissing(pool, { proposalId, userId, scheduledFor });
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND message_type='beo_unack_nudge_sms' ORDER BY id",
    [proposalId]
  );
  assert.strictEqual(rows.length, 2, 'expected one suppressed + one new pending');
  assert.deepStrictEqual(rows.map(r => r.status).sort(), ['pending', 'suppressed']);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: tests fail because `beoHandlers.js` does not exist.

- [ ] **Step 3: Create `server/utils/beoHandlers.js` with the helper**

```javascript
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { SuppressMessageError } = require('./errors');

const BEO_MESSAGE_TYPE = 'beo_unack_nudge_sms';

/**
 * Status-aware idempotent insert for a BEO nudge row. Skip if any 'pending'
 * or 'sent' row already exists on the natural key; insert otherwise (so a
 * prior 'suppressed' row from Unfinalize doesn't block re-insertion).
 * Belt-and-suspenders: also ON CONFLICT DO NOTHING via the existing partial
 * unique index on scheduled_messages.
 */
async function insertBeoNudgeIfMissing(executor, { proposalId, userId, scheduledFor }) {
  const existing = await executor.query(
    `SELECT id FROM scheduled_messages
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type=$2
        AND recipient_type='staff' AND recipient_id=$3
        AND channel='sms'
        AND status IN ('pending', 'sent')
      LIMIT 1`,
    [proposalId, BEO_MESSAGE_TYPE, userId]
  );
  if (existing.rows.length > 0) return;
  await executor.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', $2, 'staff', $3, 'sms', $4)
     ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
       WHERE status = 'pending'
     DO NOTHING`,
    [proposalId, BEO_MESSAGE_TYPE, userId, scheduledFor]
  );
}

module.exports = {
  BEO_MESSAGE_TYPE,
  insertBeoNudgeIfMissing,
};
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/beoHandlers.js server/utils/beoHandlers.test.js
git commit -m "feat(beo): insertBeoNudgeIfMissing with status-aware idempotency"
```

---

### Task 8: `scheduleBeoNudgesForProposal` + tests

**Files:**
- Modify: `server/utils/beoHandlers.js`
- Modify: `server/utils/beoHandlers.test.js`

- [ ] **Step 1: Append tests**

```javascript
test('scheduleBeoNudgesForProposal > inserts one row per approved staffer', async () => {
  const { scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT recipient_id, scheduled_for FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND message_type='beo_unack_nudge_sms'",
    [proposalId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].recipient_id, userId);
});

test('scheduleBeoNudgesForProposal > skips deactivated staffers', async () => {
  const { scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("UPDATE users SET onboarding_status='deactivated' WHERE id=$1", [userId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
  await pool.query("UPDATE users SET onboarding_status='active' WHERE id=$1", [userId]);
});

test('scheduleBeoNudgesForProposal > skips past-event proposals', async () => {
  const { scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE - 1 WHERE id = $1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE + 30 WHERE id = $1", [proposalId]);
});

test('scheduleBeoNudgesForProposal > skips TBD start time', async () => {
  const { scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("UPDATE proposals SET event_start_time = NULL WHERE id = $1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
  await pool.query("UPDATE proposals SET event_start_time = '18:00' WHERE id = $1", [proposalId]);
});

test('scheduleBeoNudgesForProposal > dedupes when a staffer is on two shifts', async () => {
  const { scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  const s2 = await pool.query(
    "INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id",
    [proposalId]
  );
  await pool.query("INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')", [s2.rows[0].id, userId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND recipient_id=$2",
    [proposalId, userId]
  );
  assert.strictEqual(Number(rows[0].count), 1, 'one row per staffer per proposal');
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [s2.rows[0].id]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [s2.rows[0].id]);
});
```

- [ ] **Step 2: Run, verify failures**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: 5 new tests fail because `scheduleBeoNudgesForProposal` does not exist.

- [ ] **Step 3: Implement the helper**

Add to `server/utils/beoHandlers.js`:

```javascript
const { computeEventStartUtc } = require('./staffShiftHandlers');

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Schedule BEO nudge rows for every approved+active staffer on every
 * non-cancelled shift linked to the proposal. All queries run on `executor`
 * (transaction client when called from Finalize). Idempotent: re-running
 * after a partial run inserts only the missing rows.
 *
 * Skips entirely when:
 *   - proposal has no event_start_time (TBD-time event)
 *   - computed eventStartUtc < NOW() (past event)
 *
 * scheduled_for = MAX(eventStartUtc - 3 days, NOW() + 5 minutes).
 */
async function scheduleBeoNudgesForProposal(proposalId, executor) {
  const propRes = await executor.query(
    `SELECT event_date, event_start_time, event_duration_hours, event_timezone
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || !proposal.event_start_time) return { inserted: 0, skipped: 'no_start_time' };
  const eventStartUtc = computeEventStartUtc(proposal);
  if (!eventStartUtc || eventStartUtc.getTime() < Date.now()) {
    return { inserted: 0, skipped: 'past_or_unparseable' };
  }
  const scheduledFor = new Date(Math.max(
    eventStartUtc.getTime() - THREE_DAYS_MS,
    Date.now() + FIVE_MINUTES_MS,
  ));

  const staffRes = await executor.query(
    `SELECT DISTINCT sr.user_id
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       JOIN users u ON u.id = sr.user_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
        AND s.status != 'cancelled'
        AND u.onboarding_status = 'active'`,
    [proposalId]
  );

  let inserted = 0;
  for (const row of staffRes.rows) {
    await insertBeoNudgeIfMissing(executor, { proposalId, userId: row.user_id, scheduledFor });
    inserted += 1;
  }
  return { inserted, scheduledFor };
}

module.exports = {
  BEO_MESSAGE_TYPE,
  insertBeoNudgeIfMissing,
  scheduleBeoNudgesForProposal,
};
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/beoHandlers.js server/utils/beoHandlers.test.js
git commit -m "feat(beo): scheduleBeoNudgesForProposal with active+past+TBD guards"
```

---

### Task 9: `suppressBeoNudgesForProposal` + `suppressBeoNudgesForStaffers` + tests

**Files:**
- Modify: `server/utils/beoHandlers.js`
- Modify: `server/utils/beoHandlers.test.js`

- [ ] **Step 1: Append tests**

```javascript
test('suppressBeoNudgesForProposal > marks pending suppressed, preserves sent', async () => {
  const { suppressBeoNudgesForProposal, scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  // Mark one row as already sent
  await pool.query(
    "INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, sent_at) VALUES ($1, 'proposal', 'beo_unack_nudge_sms', 'staff', $2, 'sms', NOW(), 'sent', NOW())",
    [proposalId, userId + 99999] // fake user to avoid conflict with the pending row
  );
  const result = await suppressBeoNudgesForProposal(proposalId, pool, 'unfinalized: BEO unfinalized by admin');
  assert.strictEqual(result.suppressed, 1);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 ORDER BY status",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  assert.strictEqual(rows[1].status, 'suppressed');
  assert.match(rows[1].error_message, /unfinalized/);
});

test('suppressBeoNudgesForStaffers > only suppresses when no surviving approved shift', async () => {
  const { suppressBeoNudgesForStaffers, scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  // Try to suppress while the staffer's shift_request is still approved on the surviving shift
  await suppressBeoNudgesForStaffers(proposalId, [userId], pool);
  const stillPending = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND recipient_id=$2",
    [proposalId, userId]
  );
  assert.strictEqual(stillPending.rows[0].status, 'pending', 'NOT_EXISTS guard preserves row');
  // Now deny the request, then re-run
  await pool.query("UPDATE shift_requests SET status='denied' WHERE shift_id=$1 AND user_id=$2", [shiftId, userId]);
  await suppressBeoNudgesForStaffers(proposalId, [userId], pool);
  const nowSuppressed = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND recipient_id=$2",
    [proposalId, userId]
  );
  assert.strictEqual(nowSuppressed.rows[0].status, 'suppressed');
  await pool.query("UPDATE shift_requests SET status='approved' WHERE shift_id=$1 AND user_id=$2", [shiftId, userId]);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: 2 new tests fail.

- [ ] **Step 3: Implement helpers**

Add to `server/utils/beoHandlers.js`:

```javascript
/**
 * UPDATE every pending BEO nudge row for this proposal to suppressed with
 * the given reason. Sent rows are preserved (audit trail).
 */
async function suppressBeoNudgesForProposal(proposalId, executor, reason) {
  const result = await executor.query(
    `UPDATE scheduled_messages
        SET status='suppressed', error_message=$2
      WHERE entity_type='proposal'
        AND entity_id=$1
        AND message_type=$3
        AND status='pending'`,
    [proposalId, reason, BEO_MESSAGE_TYPE]
  );
  return { suppressed: result.rowCount };
}

/**
 * UPDATE pending BEO rows for the given staffers on the given proposal to
 * suppressed, BUT only when the staffer has no remaining approved active
 * shift on the same proposal. Used by cancel-or-unassign, PUT request deny,
 * DELETE shift, DELETE request, generic PUT cancel.
 */
async function suppressBeoNudgesForStaffers(proposalId, userIds, executor, reason = 'staffer_unassigned: shift mutation') {
  if (!userIds || userIds.length === 0) return { suppressed: 0 };
  const result = await executor.query(
    `UPDATE scheduled_messages sm
        SET status='suppressed', error_message=$3
      WHERE sm.entity_type='proposal'
        AND sm.entity_id=$1
        AND sm.message_type=$4
        AND sm.recipient_id = ANY($2)
        AND sm.status='pending'
        AND NOT EXISTS (
          SELECT 1 FROM shift_requests sr
            JOIN shifts s ON s.id = sr.shift_id
           WHERE sr.user_id = sm.recipient_id
             AND sr.status = 'approved'
             AND s.proposal_id = $1
             AND s.status != 'cancelled'
        )`,
    [proposalId, userIds, reason, BEO_MESSAGE_TYPE]
  );
  return { suppressed: result.rowCount };
}
```

Update `module.exports` to include `suppressBeoNudgesForProposal` and `suppressBeoNudgesForStaffers`.

- [ ] **Step 4: Run, verify pass**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/beoHandlers.js server/utils/beoHandlers.test.js
git commit -m "feat(beo): suppress helpers with NOT EXISTS guard for multi-shift coverage"
```

---

### Task 10: `reanchorBeoForProposal` + tests

**Files:**
- Modify: `server/utils/beoHandlers.js`
- Modify: `server/utils/beoHandlers.test.js`

- [ ] **Step 1: Append tests**

```javascript
test('reanchorBeoForProposal > updates pending scheduled_for', async () => {
  const { reanchorBeoForProposal, scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  const before = await pool.query("SELECT scheduled_for FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE + 40 WHERE id = $1", [proposalId]);
  await reanchorBeoForProposal(proposalId, pool);
  const after = await pool.query("SELECT scheduled_for FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  assert.notStrictEqual(before.rows[0].scheduled_for.getTime(), after.rows[0].scheduled_for.getTime());
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE + 30 WHERE id = $1", [proposalId]);
});

test('reanchorBeoForProposal > past-event reschedule suppresses pending in-band', async () => {
  const { reanchorBeoForProposal, scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE - 5 WHERE id = $1", [proposalId]);
  await reanchorBeoForProposal(proposalId, pool);
  const { rows } = await pool.query("SELECT status, error_message FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /event_in_past/);
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE + 30 WHERE id = $1", [proposalId]);
});

test('reanchorBeoForProposal > skips archived proposals', async () => {
  const { reanchorBeoForProposal, scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  await pool.query("UPDATE proposals SET status='archived' WHERE id = $1", [proposalId]);
  const before = await pool.query("SELECT scheduled_for FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE + 40 WHERE id = $1", [proposalId]);
  await reanchorBeoForProposal(proposalId, pool);
  const after = await pool.query("SELECT scheduled_for, status FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  assert.strictEqual(before.rows[0].scheduled_for.getTime(), after.rows[0].scheduled_for.getTime(), 'archived: no UPDATE');
  await pool.query("UPDATE proposals SET status='deposit_paid', event_date = CURRENT_DATE + 30 WHERE id = $1", [proposalId]);
});
```

- [ ] **Step 2: Run, verify failures**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: 3 new tests fail.

- [ ] **Step 3: Implement**

Add to `server/utils/beoHandlers.js`:

```javascript
/**
 * Re-anchor pending BEO nudge rows after a proposal reschedule. Skipped when
 * the proposal is archived. Past-event reschedule SUPPRESSES pending rows
 * in-band (the row's existing scheduled_for may still be in the future, in
 * which case the dispatcher would never pick it up and the row would sit
 * pending forever).
 */
async function reanchorBeoForProposal(proposalId, executor) {
  const propRes = await executor.query(
    `SELECT event_date, event_start_time, event_timezone, status
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || proposal.status === 'archived') return { updated: 0 };
  if (!proposal.event_start_time) return { updated: 0 };
  const eventStartUtc = computeEventStartUtc(proposal);
  if (!eventStartUtc) return { updated: 0 };
  if (eventStartUtc.getTime() < Date.now()) {
    const sup = await executor.query(
      `UPDATE scheduled_messages
          SET status='suppressed', error_message='event_in_past: rescheduled'
        WHERE entity_type='proposal' AND entity_id=$1
          AND message_type=$2 AND status='pending'`,
      [proposalId, BEO_MESSAGE_TYPE]
    );
    return { suppressed: sup.rowCount };
  }
  const scheduledFor = new Date(Math.max(
    eventStartUtc.getTime() - THREE_DAYS_MS,
    Date.now() + FIVE_MINUTES_MS,
  ));
  const result = await executor.query(
    `UPDATE scheduled_messages
        SET scheduled_for=$2
      WHERE entity_type='proposal' AND entity_id=$1
        AND message_type=$3 AND status='pending'`,
    [proposalId, scheduledFor, BEO_MESSAGE_TYPE]
  );
  return { updated: result.rowCount };
}
```

Update `module.exports` to include `reanchorBeoForProposal`.

- [ ] **Step 4: Run, verify pass**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/beoHandlers.js server/utils/beoHandlers.test.js
git commit -m "feat(beo): reanchorBeoForProposal with past-event in-band suppression"
```

---

### Task 11: `loadBeoContext` + `handleBeoUnackNudge` + tests

**Files:**
- Modify: `server/utils/beoHandlers.js`
- Modify: `server/utils/beoHandlers.test.js`

- [ ] **Step 1: Append tests**

```javascript
test('handleBeoUnackNudge > sends SMS when all gates pass', async () => {
  const { handleBeoUnackNudge, scheduleBeoNudgesForProposal } = require('./beoHandlers');
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("UPDATE drink_plans SET finalized_at = NOW() WHERE proposal_id = $1", [proposalId]);
  await scheduleBeoNudgesForProposal(proposalId, pool);
  // call handler directly with the row + entity + recipient args
  await handleBeoUnackNudge({
    entity: { id: proposalId },
    recipient: { id: userId },
    scheduledMessage: { id: null }, // not actually used
  });
  // sendAndLogSms in dev mode returns dev-skipped; no exception means success
});

test('handleBeoUnackNudge > throws SuppressMessageError on already_acknowledged', async () => {
  const { handleBeoUnackNudge } = require('./beoHandlers');
  const { SuppressMessageError } = require('./errors');
  await pool.query("UPDATE shift_requests SET beo_acknowledged_at = NOW() WHERE shift_id = $1 AND user_id = $2", [shiftId, userId]);
  await assert.rejects(
    () => handleBeoUnackNudge({ entity: { id: proposalId }, recipient: { id: userId }, scheduledMessage: { id: null } }),
    (err) => err instanceof SuppressMessageError && err.reason === 'already_acknowledged'
  );
  await pool.query("UPDATE shift_requests SET beo_acknowledged_at = NULL WHERE shift_id = $1 AND user_id = $2", [shiftId, userId]);
});

test('handleBeoUnackNudge > throws SuppressMessageError on no_phone', async () => {
  const { handleBeoUnackNudge } = require('./beoHandlers');
  const { SuppressMessageError } = require('./errors');
  await pool.query("UPDATE contractor_profiles SET phone = NULL WHERE user_id = $1", [userId]);
  await assert.rejects(
    () => handleBeoUnackNudge({ entity: { id: proposalId }, recipient: { id: userId }, scheduledMessage: { id: null } }),
    (err) => err instanceof SuppressMessageError && err.reason === 'no_phone'
  );
  await pool.query("UPDATE contractor_profiles SET phone = '+15555550101' WHERE user_id = $1", [userId]);
});

test('handleBeoUnackNudge > throws on beo_not_finalized when plan is not finalized', async () => {
  const { handleBeoUnackNudge } = require('./beoHandlers');
  const { SuppressMessageError } = require('./errors');
  await pool.query("UPDATE drink_plans SET finalized_at = NULL WHERE proposal_id = $1", [proposalId]);
  await assert.rejects(
    () => handleBeoUnackNudge({ entity: { id: proposalId }, recipient: { id: userId }, scheduledMessage: { id: null } }),
    (err) => err instanceof SuppressMessageError && err.reason === 'beo_not_finalized'
  );
  await pool.query("UPDATE drink_plans SET finalized_at = NOW() WHERE proposal_id = $1", [proposalId]);
});

test('handleBeoUnackNudge > throws on staffer_unassigned when no approved shift', async () => {
  const { handleBeoUnackNudge } = require('./beoHandlers');
  const { SuppressMessageError } = require('./errors');
  await pool.query("UPDATE shift_requests SET status='denied' WHERE shift_id=$1 AND user_id=$2", [shiftId, userId]);
  await assert.rejects(
    () => handleBeoUnackNudge({ entity: { id: proposalId }, recipient: { id: userId }, scheduledMessage: { id: null } }),
    (err) => err instanceof SuppressMessageError && err.reason === 'staffer_unassigned'
  );
  await pool.query("UPDATE shift_requests SET status='approved' WHERE shift_id=$1 AND user_id=$2", [shiftId, userId]);
});

test('handleBeoUnackNudge > throws on event_in_past', async () => {
  const { handleBeoUnackNudge } = require('./beoHandlers');
  const { SuppressMessageError } = require('./errors');
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE - 1 WHERE id = $1", [proposalId]);
  await assert.rejects(
    () => handleBeoUnackNudge({ entity: { id: proposalId }, recipient: { id: userId }, scheduledMessage: { id: null } }),
    (err) => err instanceof SuppressMessageError && err.reason === 'event_in_past'
  );
  await pool.query("UPDATE proposals SET event_date = CURRENT_DATE + 30 WHERE id = $1", [proposalId]);
});
```

- [ ] **Step 2: Run, verify failures**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: 6 new tests fail.

- [ ] **Step 3: Implement**

Add to `server/utils/beoHandlers.js`:

```javascript
const { formatEventDateLong } = require('./staffShiftHandlers');
const { getEventTypeLabel } = require('./eventTypes');
const { STAFF_URL } = require('./urls');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');

/**
 * Per-handler context loader. lookupEntity('proposal') only projects
 * event_date/event_timezone; the BEO handler needs event_start_time and the
 * staffer's contact info too, so we do our own SELECT.
 */
async function loadBeoContext(proposalId, userId) {
  const { rows } = await pool.query(
    `SELECT p.id AS proposal_id, p.event_date, p.event_start_time,
            p.event_duration_hours, p.event_timezone, p.status AS proposal_status,
            p.event_type, p.event_type_custom,
            dp.finalized_at,
            cp.phone AS staff_phone, cp.preferred_name AS staff_name,
            u.id AS user_id, u.onboarding_status,
            (
              SELECT bool_or(sr.beo_acknowledged_at IS NOT NULL)
                FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
               WHERE s.proposal_id = p.id AND sr.user_id = u.id AND sr.status = 'approved'
            ) AS any_acked,
            (
              SELECT bool_or(true)
                FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
               WHERE s.proposal_id = p.id AND sr.user_id = u.id
                 AND sr.status = 'approved' AND s.status != 'cancelled'
            ) AS has_active_shift
       FROM proposals p
       LEFT JOIN drink_plans dp ON dp.proposal_id = p.id
       LEFT JOIN users u ON u.id = $2
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE p.id = $1`,
    [proposalId, userId]
  );
  return rows[0] || null;
}

/**
 * Dispatcher handler. Throws SuppressMessageError for every expected gate.
 * Sends SMS when all gates pass.
 */
async function handleBeoUnackNudge({ entity, recipient }) {
  const proposalId = entity.id;
  const userId = recipient.id;
  const ctx = await loadBeoContext(proposalId, userId);

  if (!ctx) throw new SuppressMessageError('user_deleted');
  if (!ctx.finalized_at) throw new SuppressMessageError('beo_not_finalized');
  if (ctx.any_acked) throw new SuppressMessageError('already_acknowledged');
  if (!ctx.has_active_shift) throw new SuppressMessageError('staffer_unassigned');
  if (ctx.onboarding_status !== 'active') throw new SuppressMessageError('user_inactive');
  if (!ctx.staff_phone) {
    console.warn(`[beoHandlers] no_phone suppression for staff ${userId} on proposal ${proposalId}`);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.addBreadcrumb({ category: 'beo', message: 'beo_no_phone', level: 'warning', data: { proposalId, userId } });
    }
    throw new SuppressMessageError('no_phone');
  }
  if (!ctx.event_start_time) throw new SuppressMessageError('no_start_time');
  const eventStartUtc = computeEventStartUtc({
    event_date: ctx.event_date,
    event_start_time: ctx.event_start_time,
    event_timezone: ctx.event_timezone,
  });
  if (!eventStartUtc || eventStartUtc.getTime() < Date.now()) {
    throw new SuppressMessageError('event_in_past');
  }

  const body = smsTemplates.staffBeoNudgeSms({
    eventTypeLabel: getEventTypeLabel({ event_type: ctx.event_type, event_type_custom: ctx.event_type_custom }),
    eventDateLocal: formatEventDateLong({ event_date: ctx.event_date, event_timezone: ctx.event_timezone }),
    beoUrl: `${STAFF_URL}/events/${proposalId}/beo`,
  });

  await sendAndLogSms({
    to: ctx.staff_phone,
    body,
    clientId: null,
    messageType: BEO_MESSAGE_TYPE,
    recipientName: ctx.staff_name || null,
  });
}
```

Update `module.exports` to include `loadBeoContext` and `handleBeoUnackNudge`.

- [ ] **Step 4: Run, verify pass**

Run: `node --test server/utils/beoHandlers.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/beoHandlers.js server/utils/beoHandlers.test.js
git commit -m "feat(beo): handleBeoUnackNudge with full SuppressMessageError gate matrix"
```

---

### Task 12: `registerBeoHandlers` + boot wiring

**Files:**
- Modify: `server/utils/beoHandlers.js`
- Modify: `server/index.js`

- [ ] **Step 1: Add `registerBeoHandlers`**

Append to `server/utils/beoHandlers.js`:

```javascript
const { registerHandler } = require('./scheduledMessageDispatcher');

function registerBeoHandlers() {
  registerHandler(BEO_MESSAGE_TYPE, handleBeoUnackNudge, {
    offsetFromEventDate: null,    // bespoke timing per 6.4; reanchor handled explicitly
    anchor: 'event_date',
    category: 'operational',      // not gated by communication_preferences.marketing_enabled
    priority: 2,                  // action-required ladder
  });
}
```

Add `registerBeoHandlers` to `module.exports`.

- [ ] **Step 2: Wire into the boot block in `server/index.js`**

Find the scheduler-bootstrap block where other handler registrations live (look for `registerAll`, `registerMarketingHandlers`, etc.). Add immediately after the existing registrations:

```javascript
require('./utils/beoHandlers').registerBeoHandlers();
```

- [ ] **Step 3: Verify boot**

Run: `node -e "require('./server/utils/beoHandlers').registerBeoHandlers(); console.log('beo handlers registered');"`
Expected: prints `beo handlers registered` with no throw.

- [ ] **Step 4: Commit**

```bash
git add server/utils/beoHandlers.js server/index.js
git commit -m "feat(beo): register beo_unack_nudge_sms handler at boot"
```

---

## Phase 3: BEO routes (new file)

### Task 13: `server/routes/beo.js` GET routes + tests

**Files:**
- Create: `server/routes/beo.js`
- Create: `server/routes/beo.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/routes/beo.test.js`:

```javascript
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../app'); // assumes server/app.js exports the Express app; if not, use server/index.js's app export
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

let adminToken, staffToken, otherStaffToken;
let proposalId, drinkPlanId, shiftId, staffUserId, otherStaffUserId, adminUserId;

before(async () => {
  // Admin user
  const admin = await pool.query("INSERT INTO users (email, password, role, onboarding_status) VALUES ('beo-admin@example.com', 'x', 'admin', 'active') RETURNING id");
  adminUserId = admin.rows[0].id;
  adminToken = jwt.sign({ id: adminUserId, role: 'admin' }, process.env.JWT_SECRET);
  // Staff user with approved shift
  const s = await pool.query("INSERT INTO users (email, password, role, onboarding_status) VALUES ('beo-staff@example.com', 'x', 'staff', 'active') RETURNING id");
  staffUserId = s.rows[0].id;
  staffToken = jwt.sign({ id: staffUserId, role: 'staff' }, process.env.JWT_SECRET);
  await pool.query("INSERT INTO contractor_profiles (user_id, phone, preferred_name) VALUES ($1, '+15555550102', 'Test Staff')", [staffUserId]);
  // Other staff user with no shift
  const o = await pool.query("INSERT INTO users (email, password, role, onboarding_status) VALUES ('beo-other@example.com', 'x', 'staff', 'active') RETURNING id");
  otherStaffUserId = o.rows[0].id;
  otherStaffToken = jwt.sign({ id: otherStaffUserId, role: 'staff' }, process.env.JWT_SECRET);
  // Client + proposal + drink_plan + shift + approved request
  const c = await pool.query("INSERT INTO clients (name, email, phone) VALUES ('BEO Route Test', 'beo-rt@example.com', '+15555551111') RETURNING id");
  const p = await pool.query(
    "INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type) VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party') RETURNING id",
    [c.rows[0].id]
  );
  proposalId = p.rows[0].id;
  const dp = await pool.query(
    "INSERT INTO drink_plans (proposal_id, status, selections) VALUES ($1, 'reviewed', '{\"signatureDrinks\":[\"sd_1\"]}'::jsonb) RETURNING id",
    [proposalId]
  );
  drinkPlanId = dp.rows[0].id;
  const sh = await pool.query("INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id", [proposalId]);
  shiftId = sh.rows[0].id;
  await pool.query("INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')", [shiftId, staffUserId]);
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id=$1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id=$1", [shiftId]);
  await pool.query("DELETE FROM drink_plans WHERE id=$1", [drinkPlanId]);
  await pool.query("DELETE FROM proposals WHERE id=$1", [proposalId]);
  await pool.query("DELETE FROM contractor_profiles WHERE user_id=$1", [staffUserId]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2, $3)", [adminUserId, staffUserId, otherStaffUserId]);
});

test('GET /api/beo/:proposalId > 404 for missing proposal', async () => {
  const res = await request(app).get('/api/beo/99999999').set('Authorization', `Bearer ${staffToken}`);
  assert.strictEqual(res.status, 404);
});

test('GET /api/beo/:proposalId > admin always allowed', async () => {
  const res = await request(app).get(`/api/beo/${proposalId}`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.proposal.id, proposalId);
  assert.strictEqual(res.body.drink_plan.id, drinkPlanId);
  assert.strictEqual(res.body.viewer.is_admin, true);
  // Token MUST NOT leak
  assert.ok(!('token' in (res.body.drink_plan || {})), 'drink_plan.token must not appear in response');
});

test('GET /api/beo/:proposalId > staff with approved shift allowed', async () => {
  const res = await request(app).get(`/api/beo/${proposalId}`).set('Authorization', `Bearer ${staffToken}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.viewer.is_admin, false);
});

test('GET /api/beo/:proposalId > staff without shift 403', async () => {
  const res = await request(app).get(`/api/beo/${proposalId}`).set('Authorization', `Bearer ${otherStaffToken}`);
  assert.strictEqual(res.status, 403);
});

test('GET /api/beo/:proposalId > staff on cancelled shift 403', async () => {
  await pool.query("UPDATE shifts SET status='cancelled' WHERE id=$1", [shiftId]);
  const res = await request(app).get(`/api/beo/${proposalId}`).set('Authorization', `Bearer ${staffToken}`);
  assert.strictEqual(res.status, 403);
  await pool.query("UPDATE shifts SET status='open' WHERE id=$1", [shiftId]);
});
```

- [ ] **Step 2: Run, verify failures**

Run: `node --test server/routes/beo.test.js`
Expected: tests fail because the route is not registered.

- [ ] **Step 3: Create `server/routes/beo.js` with the GET routes**

```javascript
const express = require('express');
const path = require('path');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { auth } = require('../middleware/auth');
const { beoReadLimiter } = require('../middleware/rateLimiters');
const asyncHandler = require('../middleware/asyncHandler');
const { NotFoundError, PermissionError, ExternalServiceError } = require('../utils/errors');
const { getSignedUrl } = require('../utils/storage');

const router = express.Router();

/**
 * Authorization for any staff/admin viewer on a proposal-keyed BEO route.
 * Admin/manager always allowed; staff allowed only if they have an approved
 * shift_request on a non-cancelled shift linked to the proposal.
 */
async function authorize(req, proposalId) {
  // 404 first to avoid leaking proposal existence
  const exists = await pool.query('SELECT 1 FROM proposals WHERE id = $1 LIMIT 1', [proposalId]);
  if (!exists.rowCount) throw new NotFoundError('Event not found.');
  if (req.user.role === 'admin' || req.user.role === 'manager') return;
  const r = await pool.query(
    `SELECT 1 FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1 AND sr.user_id = $2
        AND sr.status = 'approved' AND s.status != 'cancelled'
      LIMIT 1`,
    [proposalId, req.user.id]
  );
  if (!r.rowCount) throw new PermissionError('You are not assigned to this event.');
}

router.get('/:proposalId', auth, beoReadLimiter, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  await authorize(req, proposalId);

  const propRow = await pool.query(
    `SELECT p.id, p.event_type, p.event_type_custom, p.event_date, p.event_start_time,
            p.event_duration_hours, p.event_timezone, p.event_location, p.guest_count,
            p.num_bars, p.num_bartenders, p.setup_minutes_before, p.status,
            p.balance_due_date, p.client_id,
            COALESCE(c.name, NULL) AS client_name, c.phone AS client_phone,
            sp.id AS package_id, sp.name AS package_name, sp.pricing_type AS package_pricing_type,
            sp.guests_per_bartender, sp.extra_bartender_hourly
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const p = propRow.rows[0];

  const dpRow = await pool.query(
    `SELECT id, status, finalized_at, finalized_by, selections, consult_selections,
            admin_notes, shopping_list_status,
            (selections ? '_logoFilename') AS has_logo
       FROM drink_plans WHERE proposal_id = $1`,
    [proposalId]
  );
  const dp = dpRow.rows[0] || null;

  const addonsRow = await pool.query(
    `SELECT addon_id, addon_name, billing_type, rate, quantity, line_total
       FROM proposal_addons WHERE proposal_id = $1 ORDER BY addon_name`,
    [proposalId]
  );

  const shiftReqsRow = await pool.query(
    `SELECT sr.user_id, COALESCE(cp.preferred_name, u.email) AS name,
            sr.beo_acknowledged_at
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN users u ON u.id = sr.user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE s.proposal_id = $1 AND sr.status = 'approved' AND s.status != 'cancelled'
      ORDER BY name`,
    [proposalId]
  );

  const isAdmin = req.user.role === 'admin' || req.user.role === 'manager';
  const isAck = isAdmin ? false : shiftReqsRow.rows.some(r => r.user_id === req.user.id && r.beo_acknowledged_at != null);

  res.json({
    proposal: {
      id: p.id, event_type: p.event_type, event_type_custom: p.event_type_custom,
      event_date: p.event_date, event_start_time: p.event_start_time,
      event_duration_hours: p.event_duration_hours, event_timezone: p.event_timezone,
      event_location: p.event_location, guest_count: p.guest_count,
      num_bars: p.num_bars, num_bartenders: p.num_bartenders,
      setup_minutes_before: p.setup_minutes_before,
    },
    client: { name: p.client_name, phone: p.client_phone },
    package: p.package_id ? {
      id: p.package_id, name: p.package_name, pricing_type: p.package_pricing_type,
      guests_per_bartender: p.guests_per_bartender, extra_bartender_hourly: p.extra_bartender_hourly,
    } : null,
    drink_plan: dp ? {
      id: dp.id, status: dp.status, finalized_at: dp.finalized_at,
      finalized_by: dp.finalized_by, selections: dp.selections,
      consult_selections: dp.consult_selections, admin_notes: dp.admin_notes,
      has_logo: dp.has_logo === true,
    } : null,
    shopping_list_status: dp ? dp.shopping_list_status : null,
    addons: addonsRow.rows,
    shift_requests: shiftReqsRow.rows.map(r => ({ user_id: r.user_id, beo_acknowledged_at: r.beo_acknowledged_at })),
    viewer: { is_admin: isAdmin, is_acknowledged: isAck },
  });
}));

router.get('/:proposalId/logo', auth, beoReadLimiter, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  await authorize(req, proposalId);
  const r = await pool.query(
    `SELECT selections->>'_logoFilename' AS filename
       FROM drink_plans WHERE proposal_id = $1`,
    [proposalId]
  );
  const filename = r.rows[0] && r.rows[0].filename;
  if (!filename) throw new NotFoundError('No logo uploaded for this plan.');
  if (!filename.startsWith('drink-plan-logos/')) throw new NotFoundError('No logo uploaded for this plan.');
  const url = await getSignedUrl(filename);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  let upstream;
  try {
    upstream = await fetch(url, { signal: ac.signal });
  } catch (err) {
    throw new ExternalServiceError('r2', err, 'Logo is temporarily unavailable.');
  } finally {
    clearTimeout(timer);
  }
  if (!upstream.ok) {
    throw new ExternalServiceError('r2', new Error(`Upstream returned ${upstream.status}`), 'Logo is temporarily unavailable.');
  }
  res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=3600');
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

module.exports = router;
```

- [ ] **Step 4: Mount the route in `server/index.js`**

Near other route mounts:

```javascript
app.use('/api/beo', require('./routes/beo'));
```

- [ ] **Step 5: Run tests, verify pass**

Run: `node --test server/routes/beo.test.js`
Expected: all tests pass. If `supertest` is missing, install it as a dev dep (`npm i -D supertest`).

- [ ] **Step 6: Commit**

```bash
git add server/routes/beo.js server/routes/beo.test.js server/index.js
git commit -m "feat(beo): GET /api/beo/:proposalId + /logo routes with staff/admin auth"
```

---

### Task 14: `POST /api/beo/:proposalId/acknowledge` + tests

**Files:**
- Modify: `server/routes/beo.js`
- Modify: `server/routes/beo.test.js`

- [ ] **Step 1: Append tests**

```javascript
test('POST acknowledge > staff stamps beo_acknowledged_at when finalized', async () => {
  await pool.query("UPDATE drink_plans SET finalized_at = NOW() WHERE id = $1", [drinkPlanId]);
  const res = await request(app).post(`/api/beo/${proposalId}/acknowledge`).set('Authorization', `Bearer ${staffToken}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.acknowledged, true);
  assert.ok(res.body.beo_acknowledged_at);
  const { rows } = await pool.query("SELECT beo_acknowledged_at FROM shift_requests WHERE shift_id = $1 AND user_id = $2", [shiftId, staffUserId]);
  assert.ok(rows[0].beo_acknowledged_at);
  await pool.query("UPDATE shift_requests SET beo_acknowledged_at = NULL WHERE shift_id = $1 AND user_id = $2", [shiftId, staffUserId]);
});

test('POST acknowledge > admin returns 200 with acknowledged:false', async () => {
  const res = await request(app).post(`/api/beo/${proposalId}/acknowledge`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.acknowledged, false);
});

test('POST acknowledge > 409 when not finalized', async () => {
  await pool.query("UPDATE drink_plans SET finalized_at = NULL WHERE id = $1", [drinkPlanId]);
  const res = await request(app).post(`/api/beo/${proposalId}/acknowledge`).set('Authorization', `Bearer ${staffToken}`);
  assert.strictEqual(res.status, 409);
});
```

- [ ] **Step 2: Run, verify failures**

Run: `node --test server/routes/beo.test.js`
Expected: 3 new tests fail.

- [ ] **Step 3: Add the acknowledge route**

Append to `server/routes/beo.js` (before `module.exports = router`):

```javascript
const { drinkPlanWriteLimiter } = require('../middleware/rateLimiters');
const { ConflictError } = require('../utils/errors');

router.post('/:proposalId/acknowledge', auth, beoReadLimiter, asyncHandler(async (req, res) => {
  const proposalId = parseInt(req.params.proposalId, 10);
  if (!Number.isFinite(proposalId)) throw new NotFoundError('Event not found.');
  await authorize(req, proposalId);

  // Admin role check FIRST: admin/manager view is a no-op.
  if (req.user.role === 'admin' || req.user.role === 'manager') {
    return res.json({ acknowledged: false });
  }

  const result = await pool.query(
    `UPDATE shift_requests sr
        SET beo_acknowledged_at = NOW()
       FROM shifts s
       JOIN drink_plans dp ON dp.proposal_id = s.proposal_id
      WHERE sr.shift_id = s.id
        AND s.proposal_id = $1
        AND sr.user_id = $2
        AND sr.status = 'approved'
        AND s.status != 'cancelled'
        AND dp.finalized_at IS NOT NULL
      RETURNING sr.id, sr.shift_id, sr.beo_acknowledged_at`,
    [proposalId, req.user.id]
  );

  if (result.rowCount === 0) {
    // Discriminator: figure out why
    const dp = await pool.query("SELECT finalized_at FROM drink_plans WHERE proposal_id = $1", [proposalId]);
    if (!dp.rows[0] || !dp.rows[0].finalized_at) {
      throw new ConflictError('Plan is not finalized.');
    }
    throw new ConflictError('No approved active shift for you on this event.');
  }

  console.log(`[beo] acknowledge proposal=${proposalId} user=${req.user.id} rows=${result.rowCount}`);
  res.json({
    acknowledged: true,
    beo_acknowledged_at: result.rows[0].beo_acknowledged_at,
    request_ids: result.rows.map(r => r.id),
  });
}));
```

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test server/routes/beo.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/beo.js server/routes/beo.test.js
git commit -m "feat(beo): POST /api/beo/:proposalId/acknowledge with admin no-op"
```

---

## Phase 4: Finalize / Unfinalize + lock guards

### Task 15: `POST /:id/finalize` + tests

**Files:**
- Modify: `server/routes/drinkPlans.js`
- Modify: `server/routes/drinkPlans.js` test file (or create `server/routes/drinkPlans.beo.test.js` if a new file is cleaner)

- [ ] **Step 1: Write the failing tests**

Create `server/routes/drinkPlans.beo.test.js` (separate file to keep diff focused):

```javascript
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../app');
const { pool } = require('../db');
const jwt = require('jsonwebtoken');

let adminToken, adminUserId, clientId, proposalId, drinkPlanId, shiftId, staffUserId;

before(async () => {
  const a = await pool.query("INSERT INTO users (email, password, role, onboarding_status) VALUES ('fin-admin@example.com', 'x', 'admin', 'active') RETURNING id");
  adminUserId = a.rows[0].id;
  adminToken = jwt.sign({ id: adminUserId, role: 'admin' }, process.env.JWT_SECRET);
  const c = await pool.query("INSERT INTO clients (name, email) VALUES ('Fin Test', 'fin-test@example.com') RETURNING id");
  clientId = c.rows[0].id;
  const p = await pool.query(
    "INSERT INTO proposals (client_id, event_date, event_start_time, event_timezone, status, event_type) VALUES ($1, CURRENT_DATE + 30, '18:00', 'America/Chicago', 'deposit_paid', 'birthday-party') RETURNING id",
    [clientId]
  );
  proposalId = p.rows[0].id;
  const dp = await pool.query(
    "INSERT INTO drink_plans (proposal_id, status, selections) VALUES ($1, 'reviewed', '{\"signatureDrinks\":[\"sd_1\"]}'::jsonb) RETURNING id",
    [proposalId]
  );
  drinkPlanId = dp.rows[0].id;
  const s = await pool.query("INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id", [proposalId]);
  shiftId = s.rows[0].id;
  const u = await pool.query("INSERT INTO users (email, password, role, onboarding_status) VALUES ('fin-staff@example.com', 'x', 'staff', 'active') RETURNING id");
  staffUserId = u.rows[0].id;
  await pool.query("INSERT INTO contractor_profiles (user_id, phone) VALUES ($1, '+15555550199')", [staffUserId]);
  await pool.query("INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')", [shiftId, staffUserId]);
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  await pool.query("DELETE FROM proposal_activity_log WHERE proposal_id=$1", [proposalId]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id=$1", [shiftId]);
  await pool.query("DELETE FROM shifts WHERE id=$1", [shiftId]);
  await pool.query("DELETE FROM drink_plans WHERE id=$1", [drinkPlanId]);
  await pool.query("DELETE FROM proposals WHERE id=$1", [proposalId]);
  await pool.query("DELETE FROM contractor_profiles WHERE user_id=$1", [staffUserId]);
  await pool.query("DELETE FROM users WHERE id IN ($1, $2)", [adminUserId, staffUserId]);
  await pool.query("DELETE FROM clients WHERE id=$1", [clientId]);
});

test('POST /:id/finalize > succeeds when reviewed with selections', async () => {
  const res = await request(app).post(`/api/drink-plans/${drinkPlanId}/finalize`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.finalized_at);
  // Activity log entry
  const log = await pool.query("SELECT action, actor_id FROM proposal_activity_log WHERE proposal_id=$1 AND action='beo_finalized'", [proposalId]);
  assert.strictEqual(log.rows.length, 1);
  assert.strictEqual(log.rows[0].actor_id, adminUserId);
  // BEO nudge row scheduled
  const sm = await pool.query("SELECT count(*) FROM scheduled_messages WHERE entity_id=$1 AND message_type='beo_unack_nudge_sms'", [proposalId]);
  assert.strictEqual(Number(sm.rows[0].count), 1);
});

test('POST /:id/finalize > 409 already_finalized when finalized_at set', async () => {
  const res = await request(app).post(`/api/drink-plans/${drinkPlanId}/finalize`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 409);
});

test('POST /:id/finalize > 409 not_reviewed when status is submitted', async () => {
  await pool.query("UPDATE drink_plans SET finalized_at = NULL, status='submitted' WHERE id = $1", [drinkPlanId]);
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id=$1", [proposalId]);
  const res = await request(app).post(`/api/drink-plans/${drinkPlanId}/finalize`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 409);
  await pool.query("UPDATE drink_plans SET status='reviewed' WHERE id = $1", [drinkPlanId]);
});

test('POST /:id/finalize > 409 no_selections when empty', async () => {
  await pool.query("UPDATE drink_plans SET selections = '{}'::jsonb WHERE id = $1", [drinkPlanId]);
  const res = await request(app).post(`/api/drink-plans/${drinkPlanId}/finalize`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 409);
  await pool.query("UPDATE drink_plans SET selections = '{\"signatureDrinks\":[\"sd_1\"]}'::jsonb WHERE id = $1", [drinkPlanId]);
});

test('POST /:id/finalize > 409 archived when proposal archived', async () => {
  await pool.query("UPDATE proposals SET status='archived' WHERE id = $1", [proposalId]);
  const res = await request(app).post(`/api/drink-plans/${drinkPlanId}/finalize`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 409);
  await pool.query("UPDATE proposals SET status='deposit_paid' WHERE id = $1", [proposalId]);
});
```

- [ ] **Step 2: Run, verify failures**

Run: `node --test server/routes/drinkPlans.beo.test.js`
Expected: tests fail because the route doesn't exist.

- [ ] **Step 3: Add the finalize route**

In `server/routes/drinkPlans.js`, add near the existing `PATCH /:id/status` route:

```javascript
const { scheduleBeoNudgesForProposal } = require('../utils/beoHandlers');

/** POST /api/drink-plans/:id/finalize */
router.post('/:id/finalize', auth, requireAdminOrManager, drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
  const planId = parseInt(req.params.id, 10);
  if (!Number.isFinite(planId)) throw new NotFoundError('Plan not found.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE drink_plans dp
          SET finalized_at = NOW(), finalized_by = $2
         FROM proposals p
        WHERE dp.id = $1
          AND dp.proposal_id = p.id
          AND dp.proposal_id IS NOT NULL
          AND dp.status = 'reviewed'
          AND dp.finalized_at IS NULL
          AND p.status != 'archived'
          AND COALESCE(dp.selections, '{}'::jsonb) != '{}'::jsonb
        RETURNING dp.*, dp.proposal_id`,
      [planId, req.user.id]
    );
    if (upd.rowCount === 0) {
      // Discriminator: figure out why
      const check = await client.query(
        `SELECT dp.status, dp.finalized_at, dp.proposal_id,
                COALESCE(dp.selections, '{}'::jsonb) = '{}'::jsonb AS empty_selections,
                p.status AS proposal_status
           FROM drink_plans dp LEFT JOIN proposals p ON p.id = dp.proposal_id
          WHERE dp.id = $1`,
        [planId]
      );
      await client.query('ROLLBACK');
      const row = check.rows[0];
      if (!row) throw new NotFoundError('Plan not found.');
      if (!row.proposal_id) throw new ConflictError('Plan not linked to a proposal.');
      if (row.proposal_status === 'archived') throw new ConflictError('Proposal is archived.');
      if (row.empty_selections) throw new ConflictError('Plan has no selections.');
      if (row.finalized_at) throw new ConflictError('Plan is already finalized.');
      if (row.status !== 'reviewed') throw new ConflictError('Plan is not reviewed.');
      throw new ConflictError('Finalize refused.');
    }
    const plan = upd.rows[0];
    const sched = await scheduleBeoNudgesForProposal(plan.proposal_id, client);
    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'beo_finalized', 'admin', $2, $3)`,
      [plan.proposal_id, req.user.id, JSON.stringify({ finalized_at: plan.finalized_at, nudge_count: sched.inserted || 0 })]
    );
    await client.query('COMMIT');
    console.log(`[beo] finalize plan=${plan.id} proposal=${plan.proposal_id} nudges=${sched.inserted || 0}`);
    res.json(plan);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) {}
    throw err;
  } finally {
    client.release();
  }
}));
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test server/routes/drinkPlans.beo.test.js`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans.js server/routes/drinkPlans.beo.test.js
git commit -m "feat(beo): POST /:id/finalize with transactional UPDATE + nudge schedule + activity log"
```

---

### Task 16: `POST /:id/unfinalize` + tests

**Files:**
- Modify: `server/routes/drinkPlans.js`
- Modify: `server/routes/drinkPlans.beo.test.js`

- [ ] **Step 1: Append tests**

```javascript
test('POST /:id/unfinalize > clears finalized_at, acks, suppresses pending', async () => {
  // Finalize first
  await request(app).post(`/api/drink-plans/${drinkPlanId}/finalize`).set('Authorization', `Bearer ${adminToken}`);
  // Manually stamp an ack
  await pool.query("UPDATE shift_requests SET beo_acknowledged_at = NOW() WHERE shift_id = $1", [shiftId]);
  // Manually mark one row sent (for the audit-preserve assertion)
  await pool.query("UPDATE scheduled_messages SET status='sent', sent_at=NOW() WHERE entity_id=$1 AND message_type='beo_unack_nudge_sms'", [proposalId]);
  // Add a fresh pending row
  await pool.query("INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status) VALUES ($1, 'proposal', 'beo_unack_nudge_sms', 'staff', $2, 'sms', NOW() + INTERVAL '1 hour', 'pending')", [proposalId, staffUserId + 1000]);
  const res = await request(app).post(`/api/drink-plans/${drinkPlanId}/unfinalize`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.finalized_at, null);
  const dp = await pool.query("SELECT finalized_at, finalized_by FROM drink_plans WHERE id = $1", [drinkPlanId]);
  assert.strictEqual(dp.rows[0].finalized_at, null);
  assert.strictEqual(dp.rows[0].finalized_by, null);
  const sr = await pool.query("SELECT beo_acknowledged_at FROM shift_requests WHERE shift_id = $1", [shiftId]);
  assert.strictEqual(sr.rows[0].beo_acknowledged_at, null);
  const sm = await pool.query("SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='beo_unack_nudge_sms' ORDER BY status", [proposalId]);
  // sent stays sent; pending flipped to suppressed
  assert.deepStrictEqual(sm.rows.map(r => r.status).sort(), ['sent', 'suppressed']);
});

test('POST /:id/unfinalize > 409 when not finalized', async () => {
  const res = await request(app).post(`/api/drink-plans/${drinkPlanId}/unfinalize`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 409);
});
```

- [ ] **Step 2: Run, verify failures**

Run: `node --test server/routes/drinkPlans.beo.test.js`
Expected: 2 new tests fail.

- [ ] **Step 3: Add the route**

In `server/routes/drinkPlans.js`:

```javascript
const { suppressBeoNudgesForProposal } = require('../utils/beoHandlers');

/** POST /api/drink-plans/:id/unfinalize */
router.post('/:id/unfinalize', auth, requireAdminOrManager, drinkPlanWriteLimiter, asyncHandler(async (req, res) => {
  const planId = parseInt(req.params.id, 10);
  if (!Number.isFinite(planId)) throw new NotFoundError('Plan not found.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE drink_plans SET finalized_at = NULL, finalized_by = NULL
        WHERE id = $1 AND finalized_at IS NOT NULL
        RETURNING *, proposal_id`,
      [planId]
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new ConflictError('Plan is not finalized.');
    }
    const plan = upd.rows[0];

    // Clear acks on EVERY linked shift_request (not just approved) so the admin
    // pill is honest immediately after Unfinalize.
    const clearedAcks = await client.query(
      `UPDATE shift_requests sr
          SET beo_acknowledged_at = NULL
         FROM shifts s
        WHERE sr.shift_id = s.id AND s.proposal_id = $1
          AND sr.beo_acknowledged_at IS NOT NULL`,
      [plan.proposal_id]
    );

    const sup = await suppressBeoNudgesForProposal(plan.proposal_id, client, 'unfinalized: BEO unfinalized by admin');

    await client.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'beo_unfinalized', 'admin', $2, $3)`,
      [plan.proposal_id, req.user.id, JSON.stringify({ suppressed_count: sup.suppressed || 0, cleared_ack_count: clearedAcks.rowCount })]
    );
    await client.query('COMMIT');
    console.log(`[beo] unfinalize plan=${plan.id} proposal=${plan.proposal_id} suppressed=${sup.suppressed || 0} cleared_acks=${clearedAcks.rowCount}`);
    res.json(plan);
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) {}
    throw err;
  } finally {
    client.release();
  }
}));
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test server/routes/drinkPlans.beo.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans.js server/routes/drinkPlans.beo.test.js
git commit -m "feat(beo): POST /:id/unfinalize with full clear + audit-preserving suppress"
```

---

### Task 17: Lock-when-finalized guards on every drinkPlans mutation route

**Files:**
- Modify: `server/routes/drinkPlans.js`
- Modify: `server/routes/drinkPlans.beo.test.js`

- [ ] **Step 1: Write the failing tests (one assertion per locked route)**

Append:

```javascript
async function reFinalize() {
  await pool.query("UPDATE drink_plans SET finalized_at = NOW(), finalized_by = $2 WHERE id = $1", [drinkPlanId, adminUserId]);
}

test('PATCH /:id/status > 409 when finalized', async () => {
  await reFinalize();
  const res = await request(app).patch(`/api/drink-plans/${drinkPlanId}/status`).set('Authorization', `Bearer ${adminToken}`).send({ status: 'submitted' });
  assert.strictEqual(res.status, 409);
});

test('PATCH /:id/notes > 409 when finalized', async () => {
  await reFinalize();
  const res = await request(app).patch(`/api/drink-plans/${drinkPlanId}/notes`).set('Authorization', `Bearer ${adminToken}`).send({ admin_notes: 'updated' });
  assert.strictEqual(res.status, 409);
});

test('PUT /:id/shopping-list > 409 when finalized', async () => {
  await reFinalize();
  const res = await request(app).put(`/api/drink-plans/${drinkPlanId}/shopping-list`).set('Authorization', `Bearer ${adminToken}`).send({ shopping_list: { items: [] } });
  assert.strictEqual(res.status, 409);
});

test('PATCH /:id/shopping-list/approve > 409 when finalized', async () => {
  await reFinalize();
  const res = await request(app).patch(`/api/drink-plans/${drinkPlanId}/shopping-list/approve`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 409);
});

test('DELETE /:id > 409 when finalized', async () => {
  await reFinalize();
  const res = await request(app).delete(`/api/drink-plans/${drinkPlanId}`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 409);
});

test('DELETE /:id/logo > 409 when finalized', async () => {
  await reFinalize();
  const res = await request(app).delete(`/api/drink-plans/${drinkPlanId}/logo`).set('Authorization', `Bearer ${adminToken}`);
  assert.strictEqual(res.status, 409);
});
```

(POST /:id/logo, PUT /t/:token/selections, PUT /t/:token/logo are similar; same shape. Add the same kind of test for each route.)

- [ ] **Step 2: Run, verify failures**

Run: `node --test server/routes/drinkPlans.beo.test.js`
Expected: lock tests fail (no guard yet).

- [ ] **Step 3: Add the guard helper and wire to each route**

Near the top of `server/routes/drinkPlans.js`:

```javascript
async function ensureNotFinalized(planId) {
  const r = await pool.query('SELECT finalized_at FROM drink_plans WHERE id = $1', [planId]);
  if (r.rows[0] && r.rows[0].finalized_at) {
    throw new ConflictError('Plan is finalized. Unfinalize first to change.');
  }
}
```

Then in EACH of these routes, call `await ensureNotFinalized(parseInt(req.params.id, 10));` as the first line of the handler body (after the path-param validation):

- `PATCH /:id/status`
- `PATCH /:id/notes`
- `PUT /:id/shopping-list`
- `PATCH /:id/shopping-list/approve`
- `POST /:id/logo`
- `DELETE /:id/logo`
- `DELETE /:id`

For the token-gated public routes `PUT /t/:token/selections` and `PUT /t/:token/logo`, look up the plan by token and check `finalized_at` directly in the existing initial SELECT (the route's `existing` query). Throw `ConflictError('This plan has been finalized; reach out if you need a change.')`.

- [ ] **Step 4: Run tests, verify pass**

Run: `node --test server/routes/drinkPlans.beo.test.js`
Expected: all lock tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans.js server/routes/drinkPlans.beo.test.js
git commit -m "feat(beo): lock-when-finalized guards on every drink-plan mutation route"
```

---

### Task 18: Lock-when-finalized guards on `drinkPlanConsult.js`

**Files:**
- Modify: `server/routes/drinkPlanConsult.js`
- Modify: `server/routes/drinkPlans.beo.test.js`

- [ ] **Step 1: Append tests**

```javascript
test('PUT /:id/consult > 409 when finalized', async () => {
  await reFinalize();
  const res = await request(app).put(`/api/drink-plans/${drinkPlanId}/consult`).set('Authorization', `Bearer ${adminToken}`).send({ consult_selections: { foo: 'bar' } });
  assert.strictEqual(res.status, 409);
});

test('PATCH /:id/shopping-list-source > 409 when finalized', async () => {
  await reFinalize();
  const res = await request(app).patch(`/api/drink-plans/${drinkPlanId}/shopping-list-source`).set('Authorization', `Bearer ${adminToken}`).send({ source: 'manual' });
  assert.strictEqual(res.status, 409);
});
```

- [ ] **Step 2: Run, verify failures**

Run: `node --test server/routes/drinkPlans.beo.test.js`
Expected: 2 new tests fail.

- [ ] **Step 3: Add the guard to the consult routes**

In `server/routes/drinkPlanConsult.js`, near each route handler that mutates the plan, add a check (mirror the `ensureNotFinalized` helper from drinkPlans.js or import it):

```javascript
const { pool } = require('../db');
const { ConflictError } = require('../utils/errors');

async function ensureNotFinalized(planId) {
  const r = await pool.query('SELECT finalized_at FROM drink_plans WHERE id = $1', [planId]);
  if (r.rows[0] && r.rows[0].finalized_at) {
    throw new ConflictError('Plan is finalized. Unfinalize first to change.');
  }
}
```

Insert `await ensureNotFinalized(parseInt(req.params.id, 10));` as the first body line in:
- `PUT /:id/consult`
- `PATCH /:id/shopping-list-source`

- [ ] **Step 4: Run, verify pass**

Run: `node --test server/routes/drinkPlans.beo.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlanConsult.js server/routes/drinkPlans.beo.test.js
git commit -m "feat(beo): lock-when-finalized guards on drinkPlanConsult.js routes"
```

---

### Task 19: GET drink-plan routes project `finalized_at` / `finalized_by`

**Files:**
- Modify: `server/routes/drinkPlans.js`

- [ ] **Step 1: Locate the three GET routes**

`GET /` (list), `GET /:id`, `GET /by-proposal/:proposalId`. Each has an existing column list in its SQL.

- [ ] **Step 2: Add the new columns**

In the SELECT projection of each GET, add `finalized_at` to all three and `finalized_by` to the detail routes (`:id` and `by-proposal/:proposalId`).

- [ ] **Step 3: Spot-check**

```bash
node -e "
  const { pool } = require('./server/db');
  pool.query('SELECT finalized_at, finalized_by FROM drink_plans LIMIT 1').then(r => { console.log(r.rows); process.exit(0); });
"
```
Expected: no SQL error.

Then start the dev server (or run a quick request test) confirming the GET payloads include the new fields.

- [ ] **Step 4: Commit**

```bash
git add server/routes/drinkPlans.js
git commit -m "feat(beo): project finalized_at on drink-plan GET endpoints"
```

---

## Phase 5: Shift integration

### Task 20: Suppression on `POST /:id/cancel-or-unassign`

**Files:**
- Modify: `server/routes/shifts.js`

- [ ] **Step 1: Locate the handler**

Around `shifts.js:500`, the `cancel-or-unassign` handler. Note the existing UPDATE statements that suppress shift_reminder/staff_thank_you rows.

- [ ] **Step 2: Add the BEO suppression**

At handler entry, capture `proposal_id`:

```javascript
const propRow = await dbClient.query('SELECT proposal_id FROM shifts WHERE id = $1', [shiftId]);
const proposalIdForBeo = propRow.rows[0] && propRow.rows[0].proposal_id;
```

After the existing shift_reminder/staff_thank_you suppression UPDATEs (and within the same transaction):

```javascript
if (proposalIdForBeo && affectedUserIds.length > 0) {
  const { suppressBeoNudgesForStaffers } = require('../utils/beoHandlers');
  await suppressBeoNudgesForStaffers(proposalIdForBeo, affectedUserIds, dbClient, 'staffer_unassigned: cancel-or-unassign');
}
```

`affectedUserIds` already exists in the handler (the list of staffers losing this shift).

- [ ] **Step 3: Smoke-test**

```bash
node -e "
  const { pool } = require('./server/db');
  pool.query(\"SELECT count(*) FROM information_schema.routines WHERE routine_name='suppressBeoNudgesForStaffers'\").then(() => { console.log('ok'); process.exit(0); });
"
```
(Or run a manual route test.)

- [ ] **Step 4: Commit**

```bash
git add server/routes/shifts.js
git commit -m "feat(beo): suppress BEO nudges in cancel-or-unassign handler"
```

---

### Task 21: Ack-clear on `POST /:id/assign` and `POST /:id/request`

**Files:**
- Modify: `server/routes/shifts.js`

- [ ] **Step 1: Locate the two `ON CONFLICT DO UPDATE` clauses**

`POST /:id/assign` around line 603; `POST /:id/request` around line 279.

- [ ] **Step 2: Add `beo_acknowledged_at = NULL` to both**

For `assign`:

```javascript
ON CONFLICT (shift_id, user_id) DO UPDATE
  SET status = EXCLUDED.status,
      beo_acknowledged_at = NULL,  -- BEO: clear stale ack on re-approve
      ...
```

For `request` (gate the clear on transition; do NOT clear when prior status was already `approved`):

```javascript
ON CONFLICT (shift_id, user_id) DO UPDATE
  SET status = 'pending',
      beo_acknowledged_at = CASE WHEN shift_requests.status = 'denied' THEN NULL ELSE shift_requests.beo_acknowledged_at END,
      ...
```

- [ ] **Step 3: Verify lint**

Run: `npx eslint server/routes/shifts.js`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/routes/shifts.js
git commit -m "feat(beo): clear beo_acknowledged_at on assign / re-request transitions"
```

---

### Task 22: PUT `/shifts/requests/:requestId` deny / approve branches

**Files:**
- Modify: `server/routes/shifts.js`

- [ ] **Step 1: Locate the handler around line 701**

Note it does a bare `UPDATE shift_requests SET status = $1 WHERE id = $2 RETURNING *`.

- [ ] **Step 2: Refactor to SELECT-then-branch**

Replace the bare UPDATE with:

```javascript
// Capture prior state for BEO branching
const pre = await pool.query(
  `SELECT sr.status AS prior_status, sr.user_id, s.proposal_id
     FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
    WHERE sr.id = $1`,
  [req.params.requestId]
);
if (!pre.rows[0]) throw new NotFoundError('Request not found.');
const { prior_status, user_id: srUserId, proposal_id: srProposalId } = pre.rows[0];

let result;
if (status === 'approved') {
  result = await pool.query(
    `UPDATE shift_requests SET status='approved', beo_acknowledged_at = NULL
      WHERE id = $1 RETURNING *`,
    [req.params.requestId]
  );
} else if (status === 'denied') {
  result = await pool.query(
    `UPDATE shift_requests SET status='denied', beo_acknowledged_at = NULL
      WHERE id = $1 RETURNING *`,
    [req.params.requestId]
  );
  if (prior_status === 'approved' && srProposalId) {
    const { suppressBeoNudgesForStaffers } = require('../utils/beoHandlers');
    await suppressBeoNudgesForStaffers(srProposalId, [srUserId], pool, 'staffer_unassigned: PUT request denied');
  }
} else {
  result = await pool.query(
    `UPDATE shift_requests SET status=$1 WHERE id=$2 RETURNING *`,
    [status, req.params.requestId]
  );
}
```

(Keep the existing email and `scheduleStaffShiftMessages` side-effects intact.)

- [ ] **Step 3: Verify lint**

Run: `npx eslint server/routes/shifts.js`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/routes/shifts.js
git commit -m "feat(beo): PUT requests deny suppresses BEO (only on approved→denied); approve clears stale ack"
```

---

### Task 23: Generic `PUT /:id` cancel + `DELETE /:id` + `DELETE /requests/:requestId`

**Files:**
- Modify: `server/routes/shifts.js`

- [ ] **Step 1: `PUT /:id`**

In the generic shift update around line 419, when `status === 'cancelled'`, wrap the existing UPDATE and the new BEO suppression in a BEGIN/COMMIT:

```javascript
if (req.body.status === 'cancelled') {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    // ... existing UPDATE ...
    const affectedUsers = await dbClient.query(
      `SELECT user_id FROM shift_requests WHERE shift_id = $1 AND status = 'approved'`,
      [req.params.id]
    );
    const userIds = affectedUsers.rows.map(r => r.user_id);
    const propRow = await dbClient.query('SELECT proposal_id FROM shifts WHERE id = $1', [req.params.id]);
    if (propRow.rows[0] && propRow.rows[0].proposal_id && userIds.length > 0) {
      const { suppressBeoNudgesForStaffers } = require('../utils/beoHandlers');
      await suppressBeoNudgesForStaffers(propRow.rows[0].proposal_id, userIds, dbClient, 'staffer_unassigned: generic PUT shift cancelled');
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (_e) {}
    throw err;
  } finally {
    dbClient.release();
  }
}
```

- [ ] **Step 2: `DELETE /:id`**

Around line 479. Wrap in transaction. Capture user_ids + proposal_id first, then DELETE, then suppress. Skip suppression when `proposal_id IS NULL`:

```javascript
const dbClient = await pool.connect();
try {
  await dbClient.query('BEGIN');
  const propRow = await dbClient.query('SELECT proposal_id FROM shifts WHERE id = $1', [req.params.id]);
  const proposalIdForBeo = propRow.rows[0] && propRow.rows[0].proposal_id;
  let userIds = [];
  if (proposalIdForBeo) {
    const u = await dbClient.query('SELECT user_id FROM shift_requests WHERE shift_id = $1 AND status = $2', [req.params.id, 'approved']);
    userIds = u.rows.map(r => r.user_id);
  }
  await dbClient.query('DELETE FROM shifts WHERE id = $1', [req.params.id]);
  if (proposalIdForBeo && userIds.length > 0) {
    const { suppressBeoNudgesForStaffers } = require('../utils/beoHandlers');
    await suppressBeoNudgesForStaffers(proposalIdForBeo, userIds, dbClient, 'staffer_unassigned: shift deleted');
  }
  await dbClient.query('COMMIT');
} catch (err) {
  try { await dbClient.query('ROLLBACK'); } catch (_e) {}
  throw err;
} finally {
  dbClient.release();
}
res.json({ success: true });
```

- [ ] **Step 3: `DELETE /requests/:requestId`**

Around line 316. Capture user_id + shift.proposal_id first, skip if `proposal_id IS NULL`, then DELETE, then suppress for that single user:

```javascript
const pre = await pool.query(
  `SELECT sr.user_id, s.proposal_id FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id WHERE sr.id = $1`,
  [req.params.requestId]
);
const ctx = pre.rows[0];
await pool.query('DELETE FROM shift_requests WHERE id = $1', [req.params.requestId]);
if (ctx && ctx.proposal_id) {
  const { suppressBeoNudgesForStaffers } = require('../utils/beoHandlers');
  await suppressBeoNudgesForStaffers(ctx.proposal_id, [ctx.user_id], pool, 'staffer_unassigned: request deleted');
}
res.json({ success: true });
```

- [ ] **Step 4: Verify lint**

Run: `npx eslint server/routes/shifts.js`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add server/routes/shifts.js
git commit -m "feat(beo): suppress BEO on generic PUT cancel, DELETE shift, DELETE request"
```

---

### Task 24: `autoAssign.js` ack-clear

**Files:**
- Modify: `server/utils/autoAssign.js`

- [ ] **Step 1: Locate the bare UPDATE at line 307**

It looks like `UPDATE shift_requests SET status='approved' WHERE id = ANY($1)`.

- [ ] **Step 2: Add the ack-clear**

```javascript
UPDATE shift_requests SET status='approved', beo_acknowledged_at = NULL WHERE id = ANY($1)
```

- [ ] **Step 3: Verify lint**

Run: `npx eslint server/utils/autoAssign.js`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/utils/autoAssign.js
git commit -m "feat(beo): clear stale beo_acknowledged_at on auto-assign promotion"
```

---

### Task 25: `scheduleStaffShiftMessages` LEFT JOIN drink_plans + BEO branch

**Files:**
- Modify: `server/utils/staffShiftHandlers.js`
- Modify: `server/utils/staffShiftHandlers.test.js`

- [ ] **Step 1: Write the failing test**

Append to `staffShiftHandlers.test.js`:

```javascript
test('scheduleStaffShiftMessages > enqueues BEO nudge when linked drink plan is finalized', async () => {
  const { pool } = require('../db');
  const { scheduleStaffShiftMessages } = require('./staffShiftHandlers');
  const c = await pool.query("INSERT INTO clients (name, email) VALUES ('SSM-BEO', 'ssm-beo@example.com') RETURNING id");
  const p = await pool.query(
    "INSERT INTO proposals (client_id, event_date, event_start_time, event_duration_hours, event_timezone, status, event_type) VALUES ($1, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago', 'deposit_paid', 'birthday-party') RETURNING id",
    [c.rows[0].id]
  );
  const dp = await pool.query(
    "INSERT INTO drink_plans (proposal_id, status, selections, finalized_at) VALUES ($1, 'reviewed', '{\"signatureDrinks\":[\"x\"]}'::jsonb, NOW()) RETURNING id",
    [p.rows[0].id]
  );
  const s = await pool.query("INSERT INTO shifts (event_date, status, proposal_id) VALUES (CURRENT_DATE + 30, 'open', $1) RETURNING id", [p.rows[0].id]);
  const u = await pool.query("INSERT INTO users (email, password, role, onboarding_status) VALUES ('ssm-beo-staff@example.com', 'x', 'staff', 'active') RETURNING id");
  await pool.query("INSERT INTO contractor_profiles (user_id, phone) VALUES ($1, '+15555550111')", [u.rows[0].id]);
  await pool.query("INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')", [s.rows[0].id, u.rows[0].id]);
  await scheduleStaffShiftMessages(s.rows[0].id);
  const { rows } = await pool.query("SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1 AND message_type='beo_unack_nudge_sms'", [p.rows[0].id]);
  const assert3 = require('node:assert/strict');
  assert3.strictEqual(Number(rows[0].count), 1);
  await pool.query("DELETE FROM scheduled_messages WHERE entity_id IN ($1, $2)", [p.rows[0].id, s.rows[0].id]);
  await pool.query("DELETE FROM shift_requests WHERE shift_id = $1", [s.rows[0].id]);
  await pool.query("DELETE FROM shifts WHERE id = $1", [s.rows[0].id]);
  await pool.query("DELETE FROM drink_plans WHERE id = $1", [dp.rows[0].id]);
  await pool.query("DELETE FROM proposals WHERE id = $1", [p.rows[0].id]);
  await pool.query("DELETE FROM contractor_profiles WHERE user_id = $1", [u.rows[0].id]);
  await pool.query("DELETE FROM users WHERE id = $1", [u.rows[0].id]);
  await pool.query("DELETE FROM clients WHERE id = $1", [c.rows[0].id]);
});
```

- [ ] **Step 2: Run, verify failure**

Run: `node --test server/utils/staffShiftHandlers.test.js`
Expected: the new test fails (no BEO row inserted).

- [ ] **Step 3: Extend `scheduleStaffShiftMessages`**

In `server/utils/staffShiftHandlers.js`, find the existing SELECT inside `scheduleStaffShiftMessages` that joins shifts to proposals. Add a LEFT JOIN to drink_plans and project `finalized_at`:

```javascript
const { rows } = await exec.query(
  `SELECT s.id AS shift_id, s.proposal_id,
          p.status AS proposal_status,
          p.event_date, p.event_start_time, p.event_duration_hours,
          p.event_timezone,
          dp.finalized_at
     FROM shifts s
     LEFT JOIN proposals p ON p.id = s.proposal_id
     LEFT JOIN drink_plans dp ON dp.proposal_id = p.id
    WHERE s.id = $1`,
  [shiftId]
);
```

After the existing loop that inserts shift_reminder + staff_thank_you for each approved staffer, add a BEO branch (still inside the same loop):

```javascript
if (shift.finalized_at) {
  const { insertBeoNudgeIfMissing } = require('./beoHandlers');
  const { computeEventStartUtc } = require('./staffShiftHandlers'); // self-import is fine
  const eventStartUtc = computeEventStartUtc(shift);
  if (eventStartUtc && eventStartUtc.getTime() >= Date.now()) {
    const scheduledFor = new Date(Math.max(
      eventStartUtc.getTime() - 3 * 24 * 60 * 60 * 1000,
      Date.now() + 5 * 60 * 1000,
    ));
    await insertBeoNudgeIfMissing(exec, { proposalId: shift.proposal_id, userId: row.user_id, scheduledFor });
  }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `node --test server/utils/staffShiftHandlers.test.js`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/staffShiftHandlers.js server/utils/staffShiftHandlers.test.js
git commit -m "feat(beo): late-assignment BEO nudge when linked drink plan is finalized"
```

---

### Task 26: BEO reanchor inside `rescheduleProposalInTx`

**Files:**
- Modify: `server/utils/rescheduleProposal.js`

- [ ] **Step 1: Locate `rescheduleProposalInTx`**

Around `rescheduleProposal.js:367`. It already calls `reanchorPendingMessages(...)` on the dbClient.

- [ ] **Step 2: Add the BEO reanchor call**

After the existing per-shift reanchor loop (inside the same transaction, on the same `dbClient`), determine whether `event_date` or `event_start_time` changed and conditionally call the helper:

```javascript
const eventDateChanged = updated.event_date && String(updated.event_date) !== String(old.event_date);
const eventStartChanged = updated.event_start_time && updated.event_start_time !== old.event_start_time;
if (eventDateChanged || eventStartChanged) {
  const { reanchorBeoForProposal } = require('./beoHandlers');
  await reanchorBeoForProposal(proposalId, dbClient);
}
```

(`old` and `updated` are already in scope as `rescheduleProposalInTx`'s inputs.)

- [ ] **Step 3: Verify lint**

Run: `npx eslint server/utils/rescheduleProposal.js`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add server/utils/rescheduleProposal.js
git commit -m "feat(beo): reanchor BEO nudges inside rescheduleProposalInTx (atomic)"
```

---

### Task 27: GET shifts endpoints project BEO fields

**Files:**
- Modify: `server/routes/shifts.js`

- [ ] **Step 1: `GET /shifts/by-proposal/:proposalId`**

Find the existing `array_agg(...)` for `approved_staff`. Convert to `json_agg(json_build_object('user_id', sr.user_id, 'name', COALESCE(cp.preferred_name, u.email), 'beo_acknowledged_at', sr.beo_acknowledged_at) ORDER BY COALESCE(cp.preferred_name, u.email))`.

- [ ] **Step 2: `GET /shifts` (staff path)**

LEFT JOIN drink_plans on proposal_id; SELECT `dp.finalized_at`. Project the requester's `sr.beo_acknowledged_at` via the existing self-request join.

- [ ] **Step 3: `GET /shifts/user/:userId/events`**

Same extension.

- [ ] **Step 4: Quick spot-check**

```bash
node -e "const { pool } = require('./server/db'); pool.query('SELECT * FROM drink_plans LIMIT 1').then(r => console.log('ok')).finally(() => pool.end());"
```

- [ ] **Step 5: Commit**

```bash
git add server/routes/shifts.js
git commit -m "feat(beo): project finalized_at and beo_acknowledged_at on shifts GET endpoints"
```

---

## Phase 6: Frontend

### Task 28: `DrinkPlanCard.js` Finalize / Unfinalize buttons

**Files:**
- Modify: `client/src/components/DrinkPlanCard.js`

- [ ] **Step 1: Read the current JSX action block (lines ~133-166)**

The "Mark reviewed" button lives there. The `markReviewed` handler is at line 57.

- [ ] **Step 2: Add Finalize and Unfinalize handlers**

Near `markReviewed`:

```javascript
const finalize = async () => {
  try {
    const res = await api.post(`/drink-plans/${drinkPlan.id}/finalize`);
    setDrinkPlan(res.data);
    toast.success('BEO finalized. Staff will be nudged 3 days before the event.');
  } catch (err) {
    toast.error(err.response?.data?.error || err.message || 'Finalize failed.');
  }
};

const unfinalize = async () => {
  if (!window.confirm('Unfinalize the BEO? Pending staff nudges will be suppressed and all acknowledgments cleared.')) return;
  try {
    const res = await api.post(`/drink-plans/${drinkPlan.id}/unfinalize`);
    setDrinkPlan(res.data);
    toast.success('BEO unfinalized.');
  } catch (err) {
    toast.error(err.response?.data?.error || err.message || 'Unfinalize failed.');
  }
};
```

- [ ] **Step 3: Add the buttons + status pill in JSX**

In the action block, after `Mark reviewed`:

```jsx
{drinkPlan.status === 'reviewed' && !drinkPlan.finalized_at && (
  <button type="button" className="btn btn-primary btn-sm" style={{ justifyContent: 'center' }} onClick={finalize}>
    <Icon name="check" size={11} />Finalize BEO
  </button>
)}
{drinkPlan.finalized_at && (
  <>
    <div className="muted tiny" style={{ marginTop: 4 }}>
      Finalized {formatDateTime(drinkPlan.finalized_at)}
    </div>
    <button type="button" className="btn btn-secondary btn-sm" style={{ justifyContent: 'center' }} onClick={unfinalize}>
      Unfinalize
    </button>
  </>
)}
```

- [ ] **Step 4: Verify client build**

Run: `CI=true npm --prefix client run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/components/DrinkPlanCard.js
git commit -m "feat(beo): Finalize / Unfinalize buttons on DrinkPlanCard"
```

---

### Task 29: New page `client/src/pages/staff/StaffBeo.js`

**Files:**
- Create: `client/src/pages/staff/StaffBeo.js`
- Create: `client/src/pages/staff/StaffBeo.css` (optional, only if reused)
- Modify: `client/src/App.js` (route)

- [ ] **Step 1: Add the route**

In `client/src/App.js`, inside the `StaffSiteRoutes` block (around line 296), add:

```jsx
<Route path="/events/:proposalId/beo" element={<StaffBeo />} />
```

And import:

```jsx
const StaffBeo = lazy(() => import('./pages/staff/StaffBeo'));
```

- [ ] **Step 2: Write the page**

`client/src/pages/staff/StaffBeo.js`. The spec section 7 is the spec for this component. Bullets:

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import { getEventTypeLabel } from '../../utils/eventTypes';
import { setupTimeDisplay } from '../../utils/setupTime';

export default function StaffBeo() {
  const { proposalId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [acking, setAcking] = useState(false);

  const fetchBeo = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get(`/beo/${proposalId}`);
      setData(res.data);
    } catch (err) {
      if (err.response?.status === 401) {
        navigate(`/login?next=/events/${proposalId}/beo`);
        return;
      }
      setError(err.response?.data?.error || err.message || 'Failed to load BEO.');
    } finally {
      setLoading(false);
    }
  }, [proposalId, navigate]);

  useEffect(() => { fetchBeo(); }, [fetchBeo]);

  const acknowledge = async () => {
    setAcking(true);
    try {
      const res = await api.post(`/beo/${proposalId}/acknowledge`);
      // Refetch so the pill reflects the canonical timestamp returned by the server
      await fetchBeo();
    } catch (err) {
      const reason = err.response?.data?.reason;
      if (reason === 'already_acknowledged') {
        await fetchBeo(); // someone else's tab acked first; refresh state
        return;
      }
      alert(err.response?.data?.error || err.message || 'Acknowledge failed.');
    } finally {
      setAcking(false);
    }
  };

  if (loading) return <div className="page-container"><div className="spinner" />Loading BEO...</div>;
  if (error) return (
    <div className="page-container">
      <div className="card">
        <h3>Couldn't load BEO</h3>
        <p>{error}</p>
        <button className="btn btn-primary btn-sm" onClick={fetchBeo}>Retry</button>
      </div>
    </div>
  );
  if (!data) return null;

  const { proposal, client, package: pkg, drink_plan: dp, addons, shopping_list_status, shift_requests, viewer } = data;

  return (
    <div className="page-container" style={{ maxWidth: 720, paddingBottom: 96 /* room for sticky bar */ }}>
      <EventHeader proposal={proposal} client={client} pkg={pkg} />
      {dp ? (
        <>
          <ServicePlan proposal={proposal} pkg={pkg} dp={dp} />
          <DrinkMenu dp={dp} />
          <Addons addons={addons} dp={dp} />
          <Logistics dp={dp} />
          <CustomMenu dp={dp} proposalId={proposalId} />
          <SpecialNotes dp={dp} />
          {dp.consult_selections && Object.keys(dp.consult_selections).length > 0 && <ConsultInput dp={dp} />}
          {shopping_list_status === 'approved' && <ShoppingListLink dp={dp} />}
        </>
      ) : (
        <div className="card"><p>No drink plan yet for this event. The BEO will populate once the plan is created.</p></div>
      )}
      <ConfirmBar dp={dp} viewer={viewer} onAck={acknowledge} acking={acking} />
    </div>
  );
}

// Subcomponents: sketch each per spec sections 7.1-7.9. Truncated here for brevity;
// the implementer fills them in from the spec.
function EventHeader({ proposal, client, pkg }) { /* spec 7.1 */ return <div className="card">...</div>; }
function ServicePlan({ proposal, pkg, dp }) { /* spec 7.2 */ return <div className="card">...</div>; }
function DrinkMenu({ dp }) { /* spec 7.3: render signature, mocktails, beer, wine, mixers, syrups */ return <div className="card">...</div>; }
function Addons({ addons, dp }) { /* spec 7.4 */ return <div className="card">...</div>; }
function Logistics({ dp }) { /* spec 7.5 */ return <div className="card">...</div>; }
function CustomMenu({ dp, proposalId }) { /* spec 7.6: only when menuStyle is custom/house; logo via /api/beo/:proposalId/logo */ return <div className="card">...</div>; }
function SpecialNotes({ dp }) { /* spec 7.7: admin_notes + selections.additionalNotes, white-space: pre-line */ return <div className="card">...</div>; }
function ConsultInput({ dp }) { /* spec 7.7.1: labels from ConsultationForm or hand-rolled */ return <div className="card">...</div>; }
function ShoppingListLink({ dp }) { /* spec 7.8 */ return <div className="card">...</div>; }
function ConfirmBar({ dp, viewer, onAck, acking }) {
  // spec 7.9
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      padding: '1rem',
      paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))',
      background: 'white', borderTop: '1px solid #eee', zIndex: 100,
    }}>
      {!dp || !dp.finalized_at ? (
        <div className="muted">BEO still being prepped. Check back closer to the event.</div>
      ) : viewer.is_admin ? (
        <div className="muted">You are viewing this as admin.</div>
      ) : viewer.is_acknowledged ? (
        <div style={{ color: '#1A6B1A', fontWeight: 700 }}>Confirmed.</div>
      ) : (
        <button className="btn btn-primary" disabled={acking} onClick={onAck}>
          {acking ? 'Confirming...' : "Confirm I've read this BEO"}
        </button>
      )}
    </div>
  );
}
```

The implementer fills in the subcomponent bodies per the spec; the structure here is the harness.

- [ ] **Step 3: Verify build**

Run: `CI=true npm --prefix client run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/staff/StaffBeo.js client/src/App.js
git commit -m "feat(beo): StaffBeo page with sectioned content + sticky confirm bar"
```

---

### Task 30: `EventDetailPage.js`: "View BEO" link + per-staffer pills

**Files:**
- Modify: `client/src/pages/admin/EventDetailPage.js`

- [ ] **Step 1: Find the existing staff-assignment block + the `approved_staff.join(', ')` render**

Per the spec, line ~293.

- [ ] **Step 2: Add the View BEO link near the DrinkPlanCard area**

```jsx
<a
  href={`${STAFF_URL}/events/${proposal.id}/beo`}
  target="_blank" rel="noopener"
  className="btn btn-secondary btn-sm"
>
  View BEO
</a>
```

Import `STAFF_URL` from `client/src/utils/constants` (or `process.env.REACT_APP_STAFF_URL`).

- [ ] **Step 3: Replace `approved_staff.join(', ')` with object-array mapping**

```jsx
{shift.approved_staff && shift.approved_staff.length > 0 ? (
  <ul>
    {shift.approved_staff.map((s) => (
      <li key={s.user_id}>
        {s.name || s.email || 'Staff member'}
        {s.beo_acknowledged_at
          ? <span className="badge badge-ok" style={{ marginLeft: 8 }}>Confirmed {new Date(s.beo_acknowledged_at).toLocaleString()}</span>
          : <span className="badge badge-muted" style={{ marginLeft: 8 }}>Not opened</span>}
      </li>
    ))}
  </ul>
) : null}
```

- [ ] **Step 4: Verify build**

Run: `CI=true npm --prefix client run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/EventDetailPage.js
git commit -m "feat(beo): View BEO link + per-staffer Confirmed pill on EventDetailPage"
```

---

### Task 31: StaffShifts + StaffEvents badges

**Files:**
- Modify: `client/src/pages/staff/StaffShifts.js`
- Modify: `client/src/pages/staff/StaffEvents.js`

- [ ] **Step 1: Add the badge state + link on StaffShifts**

Per spec 6.7. Around the card render (line ~106):

```jsx
{shift.my_request_status === 'approved' && shift.status !== 'cancelled' && shift.drink_plan_finalized_at && !shift.my_beo_acknowledged_at && (
  <Link to={`/events/${shift.proposal_id}/beo`} className="badge badge-warning" style={{ marginLeft: 8 }}>
    BEO Ready
  </Link>
)}
{shift.my_request_status === 'approved' && shift.my_beo_acknowledged_at && (
  <span className="badge badge-ok" style={{ marginLeft: 8 }}>Confirmed</span>
)}
{shift.my_request_status === 'approved' && shift.drink_plan_status && !shift.drink_plan_finalized_at && (
  <span className="badge badge-muted" style={{ marginLeft: 8 }}>
    {shift.drink_plan_status === 'reviewed' ? 'Reviewed' : shift.drink_plan_status === 'submitted' ? 'Pending review' : 'In progress'}
  </span>
)}
```

(The field names `drink_plan_finalized_at` / `my_beo_acknowledged_at` / `drink_plan_status` must match what the GET /shifts endpoint added in Task 27.)

- [ ] **Step 2: Mirror on StaffEvents**

Same JSX pattern in `StaffEvents.js`.

- [ ] **Step 3: Verify build**

Run: `CI=true npm --prefix client run build`

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/staff/StaffShifts.js client/src/pages/staff/StaffEvents.js
git commit -m "feat(beo): View BEO badge + state on StaffShifts and StaffEvents"
```

---

## Phase 7: Documentation + verification

### Task 32: README + ARCHITECTURE updates

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: README folder tree**

Add `beo.js`, `beoHandlers.js`, `StaffBeo.js` to the folder tree under `server/routes/`, `server/utils/`, `client/src/pages/staff/`.

Add a "BEO surface" line to Key Features.

- [ ] **Step 2: ARCHITECTURE route table + schema**

Add 4 new rows to the API route table:
- `POST | /api/drink-plans/:id/finalize | Admin | Finalize BEO, schedule T-3 nudges`
- `POST | /api/drink-plans/:id/unfinalize | Admin | Clear finalized_at, suppress pending nudges, clear acks`
- `GET | /api/beo/:proposalId | Auth (staff or admin) | BEO content payload`
- `GET | /api/beo/:proposalId/logo | Auth (staff or admin) | Staff-authenticated logo proxy`
- `POST | /api/beo/:proposalId/acknowledge | Auth (staff) | Stamp beo_acknowledged_at on approved shift_requests`

Add to schema section: `drink_plans.finalized_at`, `drink_plans.finalized_by`, `shift_requests.beo_acknowledged_at`.

Add to scheduled-messages section: `beo_unack_nudge_sms`.

- [ ] **Step 3: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(beo): README folder tree + ARCHITECTURE route table and schema"
```

---

### Task 33: Final verification matrix

No code. Run every matrix item from spec section 11 (the 20-step manual verification list):

- [ ] Admin: DrinkPlanCard shows Mark reviewed → Finalize BEO → Unfinalize in that gated order
- [ ] Admin: Finalize on a proposal with two approved staffers schedules two pending nudge rows at the expected scheduled_for
- [ ] Admin: Finalize on a proposal with one staffer on two shifts schedules ONE nudge for that staffer
- [ ] Admin: Unfinalize suppresses pending, clears acks, preserves sent
- [ ] Staff: Open BEO pre-finalize → banner, no button. Post-finalize → button. Click → pill.
- [ ] Staff: SMS CONFIRM with finalized-unacked BEO runs existing shift-ack; BEO ack stays un-stamped
- [ ] Late finalize: event in 2 days → nudge fires within minutes
- [ ] Past-event finalize: NO nudge scheduled
- [ ] Late assignment: approve fresh shift_request on finalized proposal → nudge row appears within seconds
- [ ] Reschedule: change event date by 7 days → pending nudge scheduled_for updates
- [ ] Archive: archive proposal → next dispatcher tick suppresses
- [ ] Shift cancellation, staffer-multi-coverage: cancel one of two shifts → BEO stays PENDING
- [ ] Concurrent Finalize: two admin sessions → one succeeds, other 409
- [ ] Reverted finalized plan: PATCH `/:id/status` on finalized plan → 409
- [ ] Past-event reschedule with future scheduled_for: row suppressed in-band by reanchor
- [ ] Reassignment with stale ack: deny-then-reapprove → ack cleared, nudge fires
- [ ] Content-lock end-to-end: finalize, then PATCH notes / PUT shopping-list / POST logo / PUT t/:token/selections each 409
- [ ] Token leak: GET /api/beo/:proposalId response payload contains NO `drink_plan.token`
- [ ] Concurrent ack two tabs: second tab's 409 triggers refetch, not error
- [ ] CI=true react-scripts build passes

Mark each item as it's verified. Report any failure as a follow-up commit before closing.

- [ ] **Final commit:** none (verification is read-only).

---

## Self-review checklist (for the executor)

After running this plan, verify the following before closing:

1. **Spec coverage.** Skim `docs/superpowers/specs/2026-05-25-beo-design.md` sections 6.1 through 14. Every numbered subsection should map to one or more tasks above.
2. **No placeholder strings.** Search the implementation for `TODO`, `FIXME`, `XXX`, and resolve any that the plan introduced.
3. **Test green.** Run `node --test server/utils/beoHandlers.test.js server/routes/beo.test.js server/routes/drinkPlans.beo.test.js server/utils/staffShiftHandlers.test.js server/utils/smsTemplates.test.js server/utils/scheduledMessageDispatcher.test.js`. All pass.
4. **Client build green.** `CI=true npm --prefix client run build`.
5. **Lint green.** `npm run lint`.
6. **Schema applied.** `psql "$DATABASE_URL" -c "\d drink_plans" | grep finalized_at` returns a row.
