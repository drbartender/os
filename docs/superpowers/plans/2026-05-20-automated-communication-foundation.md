# Automated Communication Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the foundational infrastructure for the automated communication system: schema additions, the unified `scheduled_messages` table, per-scheduler controls and heartbeat, archive cascade, and supporting utilities. This is Plan 1 of a multi-plan series; downstream plans (email touches, two-way SMS, etc.) depend on this being shipped first.

**Architecture:** Three layers of change. (1) Schema additions to `proposals`, `clients`, `users`, `sms_messages` plus three new tables (`scheduled_messages`, `scheduler_health`, `consults`). All idempotent SQL appended to `schema.sql` per existing project convention. (2) Per-scheduler env var controls replacing the all-or-nothing `RUN_SCHEDULERS` flag, plus a `schedulerHealth` utility that wraps each scheduler and writes heartbeat rows. (3) Archive cascade rule applied to every existing scheduler's WHERE clause so a manually-archived proposal stops all automation.

**Tech Stack:** PostgreSQL (raw SQL via `pg` driver, no ORM), Node.js 18+ / Express 4.22, `@sentry/node` for alerting, existing Jest test pattern from `server/utils/*.test.js`.

**Related spec:** `docs/superpowers/specs/2026-05-20-automated-communication-design.md` (commit `6d86c0b`).

---

## File Structure

**Files to create:**
- `server/utils/schedulerHealth.js` — heartbeat helper + stale-check monitor
- `server/utils/eventTimezone.js` — TZ resolution and rendering helpers
- `server/utils/schedulerHealth.test.js` — unit tests for heartbeat utility
- `server/utils/eventTimezone.test.js` — unit tests for TZ helpers

**Files to modify:**
- `server/db/schema.sql` — append schema additions at end of file (existing pattern)
- `server/index.js` — replace single `RUN_SCHEDULERS` gate with per-scheduler env vars + heartbeat wrapping
- `server/utils/balanceScheduler.js` — add archive cascade to WHERE clauses, wrap scheduler calls with heartbeat
- `server/utils/autoAssignScheduler.js` — same
- `server/utils/emailSequenceScheduler.js` — same
- `server/utils/purgeLabrat.js` — wrap with heartbeat
- `.env.example` — document new per-scheduler env vars

**Files referenced (no edits):**
- Existing schedulers source (`processAutopayCharges` in `server/utils/balanceScheduler.js`, etc.)
- `server/db/index.js` for the `pool` export
- Existing `server/utils/*.test.js` files for testing pattern reference

---

## Task 1: Schema additions to `proposals` (event_timezone, archive_reason, status enum update)

**Files:**
- Modify: `server/db/schema.sql` — append at end of file (around line 2089+ depending on current length)

- [ ] **Step 1: Add the SQL block to `schema.sql`**

Append the following to `server/db/schema.sql`:

```sql
-- ─── Automated Communication: proposals additions ────────────────
-- See docs/superpowers/specs/2026-05-20-automated-communication-design.md

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS event_timezone TEXT NOT NULL DEFAULT 'America/Chicago';
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS archive_reason TEXT;

-- Status enum gets 'archived' added. Existing 'cancelled' values stay valid during migration;
-- Task 2 migrates them to 'archived' and Task 1 leaves both allowed transiently.
DO $$ BEGIN
  ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
  ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
    CHECK (status IN ('draft','sent','viewed','modified','accepted','deposit_paid','balance_paid','confirmed','completed','cancelled','archived'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- archive_reason is only meaningful when status = 'archived'
DO $$ BEGIN
  ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_archive_reason_check;
  ALTER TABLE proposals ADD CONSTRAINT proposals_archive_reason_check
    CHECK (archive_reason IS NULL OR archive_reason IN ('no_hire','client_cancelled','we_cancelled','event_completed','other'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

- [ ] **Step 2: Apply the schema and verify**

The project applies `schema.sql` on server start via the existing loader. Restart the dev server, then verify:

```bash
psql "$DATABASE_URL" -c "\\d proposals" | grep -E "event_timezone|archive_reason"
```

Expected: two rows showing the new columns with types `text` and proper defaults.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(comms): add event_timezone and archive_reason to proposals"
```

---

## Task 2: Migrate existing 'cancelled' proposals to 'archived'

**Files:**
- Modify: `server/db/schema.sql` — append after Task 1's block

- [ ] **Step 1: Add the migration SQL**

Append to `server/db/schema.sql`:

```sql
-- ─── Automated Communication: migrate cancelled → archived ───────
-- One-time migration. Idempotent because it filters on status = 'cancelled'.
-- After this runs, the 'cancelled' value should never appear in proposals.status.
DO $$
DECLARE
  migrated_count INTEGER;
BEGIN
  UPDATE proposals
  SET status = 'archived',
      archive_reason = 'client_cancelled'
  WHERE status = 'cancelled';

  GET DIAGNOSTICS migrated_count = ROW_COUNT;
  IF migrated_count > 0 THEN
    RAISE NOTICE 'Migrated % cancelled proposals to archived', migrated_count;
  END IF;
END $$;

-- Once migration runs, tighten the constraint to drop 'cancelled'
DO $$ BEGIN
  ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
  ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
    CHECK (status IN ('draft','sent','viewed','modified','accepted','deposit_paid','balance_paid','confirmed','completed','archived'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

- [ ] **Step 2: Apply and verify**

Restart dev server (loads schema.sql), then confirm no cancelled rows remain:

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM proposals WHERE status = 'cancelled';"
```

Expected: `0`.

- [ ] **Step 3: Verify constraint allows archived**

```bash
psql "$DATABASE_URL" -c "INSERT INTO proposals (status) VALUES ('archived');"
```

Expected: error about missing required columns (NOT about the status constraint). If you get a CHECK constraint violation, the migration didn't apply. Tidy up with `DELETE FROM proposals WHERE id = (last inserted)` if needed.

- [ ] **Step 4: Search code for 'cancelled' references and update**

Grep for `status.*cancelled|'cancelled'` in `server/` and update each to `'archived'`:

```bash
grep -rn "status.*=.*'cancelled'\|'cancelled'" server/
```

Update each to use `'archived'` instead. Common spots:
- `server/utils/balanceScheduler.js` WHERE clauses (Task 12 will revisit)
- `server/utils/refundHelpers.js` if it references cancelled status
- `server/routes/proposals/*.js` for status display logic
- `server/utils/metricsQueries.js` for reporting

Verify after edits:

```bash
grep -rn "'cancelled'" server/
```

Expected: no remaining matches in code (matches in `schema.sql` are OK as part of the migration history).

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.sql server/utils/balanceScheduler.js server/utils/refundHelpers.js server/routes/proposals/ server/utils/metricsQueries.js
git commit -m "refactor(comms): migrate cancelled status to archived with reason"
```

(Adjust the `git add` paths to match files you actually modified.)

---

## Task 3: Schema additions to `clients` (communication_preferences, status flags, harvest)

**Files:**
- Modify: `server/db/schema.sql` — append after Task 2's block

- [ ] **Step 1: Add the SQL block**

Append:

```sql
-- ─── Automated Communication: clients additions ──────────────────

ALTER TABLE clients ADD COLUMN IF NOT EXISTS communication_preferences JSONB
  NOT NULL DEFAULT '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS phone_status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_harvest_status TEXT NOT NULL DEFAULT 'not_needed';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_harvest_attempted_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_email_status_check;
  ALTER TABLE clients ADD CONSTRAINT clients_email_status_check
    CHECK (email_status IN ('ok','bad'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_phone_status_check;
  ALTER TABLE clients ADD CONSTRAINT clients_phone_status_check
    CHECK (phone_status IN ('ok','bad'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_email_harvest_status_check;
  ALTER TABLE clients ADD CONSTRAINT clients_email_harvest_status_check
    CHECK (email_harvest_status IN ('not_needed','pending','harvested','failed'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_clients_email_harvest_pending
  ON clients(email_harvest_attempted_at)
  WHERE email_harvest_status = 'pending';
```

- [ ] **Step 2: Apply and verify**

Restart dev server, then:

```bash
psql "$DATABASE_URL" -c "\\d clients" | grep -E "communication_preferences|email_status|phone_status|email_harvest"
```

Expected: five rows with the new columns.

- [ ] **Step 3: Verify default JSONB structure**

```bash
psql "$DATABASE_URL" -c "SELECT communication_preferences FROM clients LIMIT 1;"
```

Expected output looks like: `{"sms_enabled": true, "email_enabled": true, "marketing_enabled": true}`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(comms): add communication_preferences and status flags to clients"
```

---

## Task 4: Schema additions to `users` (notification + communication preferences)

**Files:**
- Modify: `server/db/schema.sql` — append after Task 3

- [ ] **Step 1: Add the SQL block**

Append:

```sql
-- ─── Automated Communication: users additions ────────────────────

ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_preferences JSONB
  NOT NULL DEFAULT '{
    "urgent_booking": true,
    "urgent_consult": true,
    "urgent_staffing": true,
    "urgent_client_reply": true,
    "payment_failure": true,
    "feedback": true,
    "system_error": true,
    "routine_admin": true,
    "routine_thumbtack": true,
    "routine_hiring": true,
    "routine_finance": true
  }'::jsonb;

ALTER TABLE users ADD COLUMN IF NOT EXISTS communication_preferences JSONB
  NOT NULL DEFAULT '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb;
```

- [ ] **Step 2: Apply and verify**

Restart dev server, then:

```bash
psql "$DATABASE_URL" -c "\\d users" | grep -E "notification_preferences|communication_preferences"
```

Expected: two rows showing the new JSONB columns.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(comms): add notification and communication preferences to users"
```

---

## Task 5: Schema addition to `sms_messages` (direction)

**Files:**
- Modify: `server/db/schema.sql` — append after Task 4

- [ ] **Step 1: Add the SQL block**

Append:

```sql
-- ─── Automated Communication: sms_messages additions ─────────────

ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound';

DO $$ BEGIN
  ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_direction_check;
  ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_direction_check
    CHECK (direction IN ('inbound','outbound'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

- [ ] **Step 2: Apply and verify**

```bash
psql "$DATABASE_URL" -c "\\d sms_messages" | grep direction
```

Expected: one row showing `direction | text | not null default 'outbound'::text`.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(comms): add direction column to sms_messages"
```

---

## Task 6: Create `scheduled_messages` table

**Files:**
- Modify: `server/db/schema.sql` — append after Task 5

- [ ] **Step 1: Add the SQL block**

Append:

```sql
-- ─── Automated Communication: scheduled_messages table ──────────
-- One row per (recipient, channel) for each scheduled touch.
-- Enables per-delivery idempotency, retry, and partial-failure tracking.

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id SERIAL PRIMARY KEY,
  entity_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  message_type TEXT NOT NULL,
  recipient_type TEXT NOT NULL,
  recipient_id INTEGER NOT NULL,
  channel TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_entity_type_check;
  ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_entity_type_check
    CHECK (entity_type IN ('proposal','shift','client','consult'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_recipient_type_check;
  ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_recipient_type_check
    CHECK (recipient_type IN ('client','staff','admin'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_channel_check;
  ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_channel_check
    CHECK (channel IN ('email','sms'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
  ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check
    CHECK (status IN ('pending','sent','failed','suppressed','deferred'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_pending
  ON scheduled_messages(scheduled_for)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_entity
  ON scheduled_messages(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_messages_recipient
  ON scheduled_messages(recipient_type, recipient_id);
```

- [ ] **Step 2: Apply and verify**

```bash
psql "$DATABASE_URL" -c "\\d scheduled_messages"
```

Expected: full table schema with the columns and constraints shown above.

- [ ] **Step 3: Verify a sample insert works**

```bash
psql "$DATABASE_URL" -c "
INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
VALUES (1, 'proposal', 'test', 'client', 1, 'email', NOW() + INTERVAL '1 hour');
SELECT id, message_type, status FROM scheduled_messages WHERE message_type = 'test';
DELETE FROM scheduled_messages WHERE message_type = 'test';
"
```

Expected: insert succeeds, select returns one row with status 'pending', delete cleans up.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(comms): add scheduled_messages table for per-delivery tracking"
```

---

## Task 7: Create `scheduler_health` table

**Files:**
- Modify: `server/db/schema.sql` — append after Task 6

- [ ] **Step 1: Add the SQL block**

Append:

```sql
-- ─── Automated Communication: scheduler_health table ────────────
-- Each scheduler writes its last_run_at on every tick. A monitoring loop
-- alerts via Sentry if any scheduler hasn't checked in within 2x its
-- expected interval.

CREATE TABLE IF NOT EXISTS scheduler_health (
  scheduler_name TEXT PRIMARY KEY,
  last_run_at TIMESTAMPTZ NOT NULL,
  last_status TEXT NOT NULL,
  expected_interval_seconds INTEGER NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE scheduler_health DROP CONSTRAINT IF EXISTS scheduler_health_status_check;
  ALTER TABLE scheduler_health ADD CONSTRAINT scheduler_health_status_check
    CHECK (last_status IN ('ok','failed'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

- [ ] **Step 2: Apply and verify**

```bash
psql "$DATABASE_URL" -c "\\d scheduler_health"
```

Expected: table created with the columns shown above.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(comms): add scheduler_health table for heartbeat tracking"
```

---

## Task 8: Create `consults` table (for future Cal.com integration)

**Files:**
- Modify: `server/db/schema.sql` — append after Task 7

- [ ] **Step 1: Add the SQL block**

Append:

```sql
-- ─── Automated Communication: consults table ────────────────────
-- Scheduled phone consults booked via Cal.com (deferred workstream).
-- This spec creates the empty table so downstream code can reference it
-- without waiting on Cal.com deployment. Notes themselves live on
-- drink_plans.consult_selections per existing schema, NOT here.

CREATE TABLE IF NOT EXISTS consults (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  calendly_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE consults DROP CONSTRAINT IF EXISTS consults_status_check;
  ALTER TABLE consults ADD CONSTRAINT consults_status_check
    CHECK (status IN ('scheduled','completed','cancelled','no_show'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_consults_proposal_id ON consults(proposal_id);
CREATE INDEX IF NOT EXISTS idx_consults_client_id ON consults(client_id);
CREATE INDEX IF NOT EXISTS idx_consults_scheduled_at ON consults(scheduled_at) WHERE status = 'scheduled';
```

- [ ] **Step 2: Apply and verify**

```bash
psql "$DATABASE_URL" -c "\\d consults"
```

Expected: table created with the columns shown above.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(comms): add consults table for future Cal.com integration"
```

---

## Task 9: Build `schedulerHealth` utility

**Files:**
- Create: `server/utils/schedulerHealth.js`
- Create: `server/utils/schedulerHealth.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/schedulerHealth.test.js`:

```javascript
const { pool } = require('../db');
const { wrapScheduler, checkStaleSchedulers, recordHeartbeat } = require('./schedulerHealth');

describe('schedulerHealth', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM scheduler_health WHERE scheduler_name LIKE 'test-%'");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM scheduler_health WHERE scheduler_name LIKE 'test-%'");
    await pool.end();
  });

  describe('recordHeartbeat', () => {
    it('inserts a new row when scheduler has never run', async () => {
      await recordHeartbeat('test-fresh', 3600, 'ok');
      const { rows } = await pool.query(
        "SELECT * FROM scheduler_health WHERE scheduler_name = 'test-fresh'"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].last_status).toBe('ok');
      expect(rows[0].consecutive_failures).toBe(0);
      expect(rows[0].expected_interval_seconds).toBe(3600);
    });

    it('updates existing row on subsequent runs', async () => {
      await recordHeartbeat('test-update', 60, 'ok');
      const before = await pool.query(
        "SELECT last_run_at FROM scheduler_health WHERE scheduler_name = 'test-update'"
      );
      await new Promise((r) => setTimeout(r, 50));
      await recordHeartbeat('test-update', 60, 'ok');
      const after = await pool.query(
        "SELECT last_run_at FROM scheduler_health WHERE scheduler_name = 'test-update'"
      );
      expect(new Date(after.rows[0].last_run_at).getTime()).toBeGreaterThan(
        new Date(before.rows[0].last_run_at).getTime()
      );
    });

    it('increments consecutive_failures on failed status, resets on ok', async () => {
      await recordHeartbeat('test-fail', 60, 'failed', 'boom');
      await recordHeartbeat('test-fail', 60, 'failed', 'still boom');
      let { rows } = await pool.query(
        "SELECT consecutive_failures FROM scheduler_health WHERE scheduler_name = 'test-fail'"
      );
      expect(rows[0].consecutive_failures).toBe(2);

      await recordHeartbeat('test-fail', 60, 'ok');
      ({ rows } = await pool.query(
        "SELECT consecutive_failures FROM scheduler_health WHERE scheduler_name = 'test-fail'"
      ));
      expect(rows[0].consecutive_failures).toBe(0);
    });
  });

  describe('wrapScheduler', () => {
    it('records ok heartbeat after successful run', async () => {
      const fn = jest.fn().mockResolvedValue(undefined);
      const wrapped = wrapScheduler('test-wrap-ok', 60, fn);
      await wrapped();
      expect(fn).toHaveBeenCalled();
      const { rows } = await pool.query(
        "SELECT last_status FROM scheduler_health WHERE scheduler_name = 'test-wrap-ok'"
      );
      expect(rows[0].last_status).toBe('ok');
    });

    it('records failed heartbeat and re-throws on error', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('kaboom'));
      const wrapped = wrapScheduler('test-wrap-fail', 60, fn);
      await expect(wrapped()).rejects.toThrow('kaboom');
      const { rows } = await pool.query(
        "SELECT last_status, last_error FROM scheduler_health WHERE scheduler_name = 'test-wrap-fail'"
      );
      expect(rows[0].last_status).toBe('failed');
      expect(rows[0].last_error).toBe('kaboom');
    });
  });

  describe('checkStaleSchedulers', () => {
    it('returns names of schedulers that haven\\'t reported within 2x expected interval', async () => {
      await pool.query(`
        INSERT INTO scheduler_health (scheduler_name, last_run_at, last_status, expected_interval_seconds, consecutive_failures)
        VALUES ('test-stale', NOW() - INTERVAL '10 minutes', 'ok', 60, 0)
      `);
      const stale = await checkStaleSchedulers();
      const names = stale.map((s) => s.scheduler_name);
      expect(names).toContain('test-stale');
    });

    it('does not flag schedulers within tolerance', async () => {
      await pool.query(`
        INSERT INTO scheduler_health (scheduler_name, last_run_at, last_status, expected_interval_seconds, consecutive_failures)
        VALUES ('test-fresh-stale', NOW() - INTERVAL '30 seconds', 'ok', 60, 0)
      `);
      const stale = await checkStaleSchedulers();
      const names = stale.map((s) => s.scheduler_name);
      expect(names).not.toContain('test-fresh-stale');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest server/utils/schedulerHealth.test.js
```

Expected: FAIL with `Cannot find module './schedulerHealth'`.

- [ ] **Step 3: Implement the utility**

Create `server/utils/schedulerHealth.js`:

```javascript
const Sentry = require('@sentry/node');
const { pool } = require('../db');

/**
 * Record a heartbeat for a scheduler.
 *
 * @param {string} schedulerName - unique identifier (e.g., 'autopay', 'auto_assign')
 * @param {number} expectedIntervalSeconds - how often this scheduler is expected to run
 * @param {'ok' | 'failed'} status - outcome of the latest run
 * @param {string} [errorMessage] - optional error message if status is 'failed'
 */
async function recordHeartbeat(schedulerName, expectedIntervalSeconds, status, errorMessage = null) {
  await pool.query(
    `INSERT INTO scheduler_health (scheduler_name, last_run_at, last_status, expected_interval_seconds, consecutive_failures, last_error, updated_at)
     VALUES ($1, NOW(), $2, $3, $4, $5, NOW())
     ON CONFLICT (scheduler_name) DO UPDATE SET
       last_run_at = EXCLUDED.last_run_at,
       last_status = EXCLUDED.last_status,
       expected_interval_seconds = EXCLUDED.expected_interval_seconds,
       consecutive_failures = CASE
         WHEN EXCLUDED.last_status = 'ok' THEN 0
         ELSE scheduler_health.consecutive_failures + 1
       END,
       last_error = CASE WHEN EXCLUDED.last_status = 'failed' THEN EXCLUDED.last_error ELSE NULL END,
       updated_at = NOW()`,
    [
      schedulerName,
      status,
      expectedIntervalSeconds,
      status === 'failed' ? 1 : 0,
      errorMessage,
    ]
  );
}

/**
 * Wrap a scheduler function so it records heartbeats automatically.
 * The wrapped function preserves the original signature (return value, throws).
 *
 * @param {string} schedulerName
 * @param {number} expectedIntervalSeconds
 * @param {() => Promise<any>} fn - the scheduler function to wrap
 * @returns {() => Promise<any>}
 */
function wrapScheduler(schedulerName, expectedIntervalSeconds, fn) {
  return async function wrappedScheduler(...args) {
    try {
      const result = await fn(...args);
      await recordHeartbeat(schedulerName, expectedIntervalSeconds, 'ok');
      return result;
    } catch (err) {
      try {
        await recordHeartbeat(schedulerName, expectedIntervalSeconds, 'failed', err.message);
      } catch (heartbeatErr) {
        console.error('[schedulerHealth] failed to record heartbeat:', heartbeatErr.message);
      }
      throw err;
    }
  };
}

/**
 * Find schedulers whose last_run_at is older than 2x their expected interval.
 * Returns an array of {scheduler_name, last_run_at, expected_interval_seconds, age_seconds}.
 */
async function checkStaleSchedulers() {
  const { rows } = await pool.query(`
    SELECT
      scheduler_name,
      last_run_at,
      expected_interval_seconds,
      EXTRACT(EPOCH FROM (NOW() - last_run_at))::INTEGER AS age_seconds
    FROM scheduler_health
    WHERE EXTRACT(EPOCH FROM (NOW() - last_run_at)) > (2 * expected_interval_seconds)
  `);
  return rows;
}

/**
 * Background monitor: every 15 minutes, check for stale schedulers and alert Sentry.
 * Called once from server bootstrap (server/index.js).
 */
function startStaleSchedulerMonitor() {
  const INTERVAL_MS = 15 * 60 * 1000;
  setInterval(async () => {
    try {
      const stale = await checkStaleSchedulers();
      if (stale.length > 0) {
        for (const s of stale) {
          Sentry.captureMessage(`Scheduler stale: ${s.scheduler_name}`, {
            level: 'warning',
            tags: { scheduler: s.scheduler_name, monitor: 'staleness' },
            extra: { age_seconds: s.age_seconds, expected_interval_seconds: s.expected_interval_seconds },
          });
          console.warn(
            `[schedulerHealth] STALE: ${s.scheduler_name} (last run ${s.age_seconds}s ago, expected every ${s.expected_interval_seconds}s)`
          );
        }
      }
    } catch (err) {
      console.error('[schedulerHealth] monitor error:', err.message);
    }
  }, INTERVAL_MS);
  console.log('[schedulerHealth] stale-scheduler monitor started');
}

module.exports = {
  recordHeartbeat,
  wrapScheduler,
  checkStaleSchedulers,
  startStaleSchedulerMonitor,
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
npx jest server/utils/schedulerHealth.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/schedulerHealth.js server/utils/schedulerHealth.test.js
git commit -m "feat(comms): add schedulerHealth utility with heartbeat and stale-check"
```

---

## Task 10: Build `eventTimezone` utility

**Files:**
- Create: `server/utils/eventTimezone.js`
- Create: `server/utils/eventTimezone.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/eventTimezone.test.js`:

```javascript
const {
  resolveEventTimezone,
  formatEventLocalTime,
  isValidTimezone,
} = require('./eventTimezone');

describe('eventTimezone', () => {
  describe('isValidTimezone', () => {
    it('returns true for valid IANA zones', () => {
      expect(isValidTimezone('America/Chicago')).toBe(true);
      expect(isValidTimezone('America/New_York')).toBe(true);
      expect(isValidTimezone('UTC')).toBe(true);
    });

    it('returns false for invalid zones', () => {
      expect(isValidTimezone('Mars/Olympus')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
      expect(isValidTimezone(null)).toBe(false);
    });
  });

  describe('resolveEventTimezone', () => {
    it('returns event_timezone if set on the proposal', () => {
      const p = { event_timezone: 'America/New_York' };
      expect(resolveEventTimezone(p)).toBe('America/New_York');
    });

    it('falls back to America/Chicago if event_timezone is null', () => {
      const p = { event_timezone: null };
      expect(resolveEventTimezone(p)).toBe('America/Chicago');
    });

    it('falls back to America/Chicago for invalid timezone', () => {
      const p = { event_timezone: 'Bogus/Zone' };
      expect(resolveEventTimezone(p)).toBe('America/Chicago');
    });
  });

  describe('formatEventLocalTime', () => {
    it('renders a UTC date in the specified zone', () => {
      const date = new Date('2026-06-15T23:00:00Z'); // 6pm CDT, 7pm EDT
      expect(formatEventLocalTime(date, 'America/Chicago', { timeStyle: 'short' })).toBe('6:00 PM');
      expect(formatEventLocalTime(date, 'America/New_York', { timeStyle: 'short' })).toBe('7:00 PM');
    });

    it('renders date format', () => {
      const date = new Date('2026-06-15T12:00:00Z');
      const out = formatEventLocalTime(date, 'America/Chicago', { dateStyle: 'long' });
      expect(out).toMatch(/June 15, 2026/);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx jest server/utils/eventTimezone.test.js
```

Expected: FAIL with `Cannot find module './eventTimezone'`.

- [ ] **Step 3: Implement the utility**

Create `server/utils/eventTimezone.js`:

```javascript
const DEFAULT_TZ = 'America/Chicago';

/**
 * Verify a string is a valid IANA timezone identifier.
 * @param {string} tz
 * @returns {boolean}
 */
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (_e) {
    return false;
  }
}

/**
 * Pull the event timezone from a proposal-like object, falling back to
 * the admin default if missing or invalid.
 *
 * @param {{ event_timezone?: string | null }} proposal
 * @returns {string} IANA zone
 */
function resolveEventTimezone(proposal) {
  const tz = proposal && proposal.event_timezone;
  return isValidTimezone(tz) ? tz : DEFAULT_TZ;
}

/**
 * Format a Date in the given timezone for display in messages.
 *
 * @param {Date} date
 * @param {string} tz - IANA zone (resolved via resolveEventTimezone)
 * @param {Intl.DateTimeFormatOptions} options
 * @returns {string}
 */
function formatEventLocalTime(date, tz, options = {}) {
  return new Intl.DateTimeFormat('en-US', {
    ...options,
    timeZone: tz,
  }).format(date);
}

module.exports = {
  DEFAULT_TZ,
  isValidTimezone,
  resolveEventTimezone,
  formatEventLocalTime,
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
npx jest server/utils/eventTimezone.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/eventTimezone.js server/utils/eventTimezone.test.js
git commit -m "feat(comms): add eventTimezone utility with zone resolution and formatting"
```

---

## Task 11: Refactor `server/index.js` to per-scheduler env vars + heartbeat wrapping

**Files:**
- Modify: `server/index.js` (lines 245-276, the scheduler bootstrap block)

- [ ] **Step 1: Read the current scheduler bootstrap block**

Read `server/index.js` lines 240-280 to confirm the current structure (you should see the `if (process.env.RUN_SCHEDULERS !== 'false') { ... }` block plus the six setInterval calls).

- [ ] **Step 2: Replace the bootstrap block**

Replace the entire `if (process.env.RUN_SCHEDULERS !== 'false') { ... } else { ... }` block (currently around lines 247-276) with:

```javascript
      // Schedulers run by default on the single primary instance. Set RUN_SCHEDULERS=false
      // on additional web instances to disable ALL schedulers, or use the per-scheduler
      // env vars (RUN_<SCHEDULER>_SCHEDULER=false) to disable individual ones.

      const globalScheduleDisabled = process.env.RUN_SCHEDULERS === 'false';
      function enabled(envVar) {
        if (globalScheduleDisabled) return false;
        return process.env[envVar] !== 'false';
      }

      const {
        wrapScheduler,
        startStaleSchedulerMonitor,
      } = require('./utils/schedulerHealth');

      // Autopay balance scheduler — check hourly for due balances
      if (enabled('RUN_AUTOPAY_SCHEDULER')) {
        const wrapped = wrapScheduler('autopay', 3600, processAutopayCharges);
        setTimeout(wrapped, 30000);
        setInterval(wrapped, 60 * 60 * 1000);
      }

      // Auto-complete events — check hourly for ended, fully-paid events
      if (enabled('RUN_AUTOCOMPLETE_SCHEDULER')) {
        const wrapped = wrapScheduler('autocomplete', 3600, processEventCompletions);
        setTimeout(wrapped, 45000);
        setInterval(wrapped, 60 * 60 * 1000);
      }

      // Auto-assign scheduler — check hourly for shifts needing auto-assignment
      if (enabled('RUN_AUTO_ASSIGN_SCHEDULER')) {
        const wrapped = wrapScheduler('auto_assign', 3600, processScheduledAutoAssigns);
        setTimeout(wrapped, 60000);
        setInterval(wrapped, 60 * 60 * 1000);
      }

      // Email sequence scheduler — check every 15 min for due drip steps
      if (enabled('RUN_SEQUENCE_SCHEDULER')) {
        const wrapped = wrapScheduler('email_sequence', 900, processSequenceSteps);
        setTimeout(wrapped, 90000);
        setInterval(wrapped, 15 * 60 * 1000);
      }

      // Quote draft cleanup — expire stale drafts daily
      if (enabled('RUN_QUOTE_DRAFT_CLEANUP_SCHEDULER')) {
        const wrapped = wrapScheduler('quote_draft_cleanup', 86400, expireStaleQuoteDrafts);
        setTimeout(wrapped, 120000);
        setInterval(wrapped, 24 * 60 * 60 * 1000);
      }

      // Lab rat test-data purge — every hour
      if (enabled('RUN_LABRAT_PURGE_SCHEDULER')) {
        const wrapped = wrapScheduler('labrat_purge', 3600, purgeLabratTestData);
        setTimeout(wrapped, 150000);
        setInterval(wrapped, 60 * 60 * 1000);
      }

      // Start the staleness monitor (runs every 15 min, no per-scheduler toggle)
      if (!globalScheduleDisabled) {
        startStaleSchedulerMonitor();
        console.log('[schedulers] started with per-scheduler controls');
      } else {
        console.log('[schedulers] disabled via RUN_SCHEDULERS=false');
      }
```

The intent: `RUN_SCHEDULERS=false` continues to disable everything (backward compat for Render env). New per-scheduler vars allow surgical disable. Heartbeat wraps every scheduler automatically.

- [ ] **Step 3: Start dev server and verify boot logs**

```bash
npm run dev
```

Expected log lines:
- `[schedulerHealth] stale-scheduler monitor started`
- `[schedulers] started with per-scheduler controls`

Kill the dev server (Ctrl-C).

- [ ] **Step 4: Verify per-scheduler env vars work**

Set `RUN_AUTOPAY_SCHEDULER=false` in your local `.env` and restart. Watch logs to confirm autopay is skipped while others still start.

Then unset it and verify everything starts again.

Clean up the test value before committing (don't leave RUN_AUTOPAY_SCHEDULER=false in your `.env`).

- [ ] **Step 5: Commit**

```bash
git add server/index.js
git commit -m "refactor(schedulers): per-scheduler env var controls and heartbeat wrapping"
```

---

## Task 12: Apply archive cascade to `balanceScheduler.js`

**Files:**
- Modify: `server/utils/balanceScheduler.js`

The archive cascade rule: every scheduler's WHERE clause must exclude `proposals.status = 'archived'`. The autopay charge query in `balanceScheduler.js` already filters by `status = 'deposit_paid'` so it's effectively safe today, but the auto-complete query is more permissive and needs an explicit guard.

- [ ] **Step 1: Read the current `processEventCompletions` function**

Read `server/utils/balanceScheduler.js` around lines 178-214 to find the `processEventCompletions` SQL query.

- [ ] **Step 2: Update the WHERE clause**

Locate the SQL in `processEventCompletions`. The current WHERE clause filters by `status IN ('balance_paid','confirmed')`, which is already restrictive enough that an archived proposal can't match. But the spec rule is to **explicitly** exclude archived for clarity and to guard against future enum changes. Update the query to add `AND status != 'archived'`:

Before:
```javascript
const result = await pool.query(`
  UPDATE proposals
  SET status = 'completed'
  WHERE status IN ('balance_paid', 'confirmed')
    AND event_date + event_start_time::time + (event_duration_hours || ' hours')::interval < NOW()
    AND (total_price - amount_paid) <= 0
  RETURNING id
`);
```

After:
```javascript
const result = await pool.query(`
  UPDATE proposals
  SET status = 'completed'
  WHERE status IN ('balance_paid', 'confirmed')
    AND status != 'archived'
    AND event_date + event_start_time::time + (event_duration_hours || ' hours')::interval < NOW()
    AND (total_price - amount_paid) <= 0
  RETURNING id
`);
```

(The `status IN (...)` already excludes 'archived', but the explicit guard makes the intent clear in code review and makes the pattern consistent across schedulers. Adapt the rewrite to match the actual SQL in your file if it differs from this sketch.)

Also update the autopay query in `processAutopayCharges` (around lines 34-49). Add `AND status != 'archived'` to the WHERE clause for the same reason.

- [ ] **Step 3: Verify both schedulers still pass linting**

```bash
npx eslint server/utils/balanceScheduler.js
```

Expected: no errors.

- [ ] **Step 4: Manual smoke test**

Insert an archived proposal in a transaction, run the auto-complete query, verify it isn't picked up:

```bash
psql "$DATABASE_URL" << 'EOF'
BEGIN;

-- Create a fake "ended" archived proposal
INSERT INTO proposals (
  client_email, client_name, status, archive_reason,
  event_date, event_start_time, event_duration_hours,
  total_price, amount_paid
)
VALUES (
  'test@archive.com', 'Test', 'archived', 'client_cancelled',
  CURRENT_DATE - INTERVAL '1 day', '18:00', 4,
  100000, 100000
)
RETURNING id;

-- Try the auto-complete query manually
SELECT id, status FROM proposals
WHERE status IN ('balance_paid', 'confirmed')
  AND status != 'archived'
  AND event_date + event_start_time::time + (event_duration_hours || ' hours')::interval < NOW()
  AND (total_price - amount_paid) <= 0
  AND client_email = 'test@archive.com';

ROLLBACK;
EOF
```

Expected: zero rows returned (the archived proposal is correctly excluded).

- [ ] **Step 5: Commit**

```bash
git add server/utils/balanceScheduler.js
git commit -m "fix(schedulers): explicit archive cascade in balance and auto-complete"
```

---

## Task 13: Apply archive cascade to `autoAssignScheduler.js`

**Files:**
- Modify: `server/utils/autoAssignScheduler.js`

- [ ] **Step 1: Read `processScheduledAutoAssigns`**

Read `server/utils/autoAssignScheduler.js` to find the main query (around lines 12-40, where it selects shifts ready for auto-assign).

- [ ] **Step 2: Update the query to join proposals and exclude archived**

The current query likely selects from `shifts` only. Shifts can outlive proposals, but a shift attached to an archived proposal shouldn't auto-assign. Update the WHERE clause to join the proposal and filter:

Before (sketch — adapt to actual code):
```javascript
const result = await pool.query(`
  SELECT id, event_date, auto_assign_days_before
  FROM shifts
  WHERE status = 'open'
    AND auto_assign_days_before IS NOT NULL
    AND auto_assigned_at IS NULL
    AND event_date - (auto_assign_days_before * INTERVAL '1 day') <= CURRENT_DATE
`);
```

After:
```javascript
const result = await pool.query(`
  SELECT s.id, s.event_date, s.auto_assign_days_before
  FROM shifts s
  LEFT JOIN proposals p ON p.id = s.proposal_id
  WHERE s.status = 'open'
    AND s.auto_assign_days_before IS NOT NULL
    AND s.auto_assigned_at IS NULL
    AND s.event_date - (s.auto_assign_days_before * INTERVAL '1 day') <= CURRENT_DATE
    AND (p.id IS NULL OR p.status != 'archived')
`);
```

The `p.id IS NULL` clause keeps the behavior for orphan shifts (shifts without a proposal). The `p.status != 'archived'` cuts out shifts whose proposal was archived.

If your shift schema uses a different column name for the proposal link (e.g., `event_id`), adapt the JOIN accordingly.

- [ ] **Step 3: Lint**

```bash
npx eslint server/utils/autoAssignScheduler.js
```

Expected: no errors.

- [ ] **Step 4: Smoke test**

```bash
psql "$DATABASE_URL" << 'EOF'
BEGIN;

-- Create archived proposal and an open shift attached to it
INSERT INTO proposals (client_email, client_name, status, archive_reason, event_date)
VALUES ('test@archive-auto.com', 'AA Test', 'archived', 'no_hire', CURRENT_DATE + INTERVAL '5 days')
RETURNING id \\gset

INSERT INTO shifts (proposal_id, status, event_date, auto_assign_days_before)
VALUES (:'id', 'open', CURRENT_DATE + INTERVAL '5 days', 14);

-- Run the auto-assign query manually
SELECT s.id
FROM shifts s
LEFT JOIN proposals p ON p.id = s.proposal_id
WHERE s.status = 'open'
  AND s.auto_assign_days_before IS NOT NULL
  AND s.auto_assigned_at IS NULL
  AND s.event_date - (s.auto_assign_days_before * INTERVAL '1 day') <= CURRENT_DATE
  AND (p.id IS NULL OR p.status != 'archived')
  AND p.client_email = 'test@archive-auto.com';

ROLLBACK;
EOF
```

Expected: zero rows. The archived proposal's shift is excluded.

- [ ] **Step 5: Commit**

```bash
git add server/utils/autoAssignScheduler.js
git commit -m "fix(schedulers): exclude shifts attached to archived proposals from auto-assign"
```

---

## Task 14: Apply archive cascade to `emailSequenceScheduler.js`

**Files:**
- Modify: `server/utils/emailSequenceScheduler.js`

The drip sequence engine pulls enrollments where the lead is active. We need to also exclude any enrollments tied to archived proposals via the `email_leads` linkage.

- [ ] **Step 1: Read `processSequenceSteps`**

Read `server/utils/emailSequenceScheduler.js` lines 17-50 to find the main `dueEnrollments` query.

- [ ] **Step 2: Add proposal status check**

The current query joins `email_leads` and `email_campaigns`. Add a left join to `proposals` via the email lead's proposal linkage (if `email_leads` has a `proposal_id` column) and exclude archived.

Inspect the `email_leads` schema first:

```bash
psql "$DATABASE_URL" -c "\\d email_leads"
```

If `email_leads.proposal_id` exists, update the query to:

```javascript
const dueEnrollments = await pool.query(`
  SELECT e.id, e.campaign_id, e.lead_id, e.current_step,
         l.email, l.name, l.status AS lead_status,
         c.status AS campaign_status, c.from_email, c.reply_to,
         qd.token AS quote_draft_token
  FROM email_sequence_enrollments e
  JOIN email_leads l ON l.id = e.lead_id
  JOIN email_campaigns c ON c.id = e.campaign_id
  LEFT JOIN quote_drafts qd ON qd.lead_id = l.id AND qd.status = 'draft'
  LEFT JOIN proposals p ON p.id = l.proposal_id
  WHERE e.status = 'active'
    AND e.next_step_due_at <= NOW()
    AND l.status = 'active'
    AND c.status = 'active'
    AND (p.id IS NULL OR p.status != 'archived')
`);
```

If `email_leads` does not have `proposal_id`, the linkage may be via `clients.id`. In that case, join `email_leads` → `clients` → `proposals`:

```javascript
LEFT JOIN proposals p ON p.client_email = l.email AND p.status = 'archived'
WHERE ...
  AND p.id IS NULL  -- no archived proposal exists for this lead's email
```

Choose the join path that matches your actual schema. If neither linkage exists, skip the archive guard here (drip already stops on sign+pay via existing logic, and there's no clean way to map a lead back to a proposal without one).

- [ ] **Step 3: Lint**

```bash
npx eslint server/utils/emailSequenceScheduler.js
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/utils/emailSequenceScheduler.js
git commit -m "fix(schedulers): exclude enrollments linked to archived proposals"
```

---

## Task 15: Update `.env.example` with new env vars

**Files:**
- Modify: `.env.example`

- [ ] **Step 1: Append the new env vars with comments**

Add at the end of `.env.example`:

```ini
# ─── Automated Communication: scheduler controls ─────────────────
# Set RUN_SCHEDULERS=false to disable ALL schedulers on this instance.
# Set individual RUN_<SCHEDULER>_SCHEDULER=false to disable specific ones.
# Defaults: all enabled when RUN_SCHEDULERS is unset.
# RUN_AUTOPAY_SCHEDULER=true
# RUN_AUTOCOMPLETE_SCHEDULER=true
# RUN_AUTO_ASSIGN_SCHEDULER=true
# RUN_SEQUENCE_SCHEDULER=true
# RUN_QUOTE_DRAFT_CLEANUP_SCHEDULER=true
# RUN_LABRAT_PURGE_SCHEDULER=true
```

- [ ] **Step 2: Commit**

```bash
git add .env.example
git commit -m "docs(env): document per-scheduler control env vars"
```

---

## Task 16: Update CLAUDE.md and README env tables

**Files:**
- Modify: `.claude/CLAUDE.md` (Environment Variables table)
- Modify: `README.md` (Environment Variables table)

Per CLAUDE.md's mandatory documentation update rule: new env vars get added to both the project rules doc and the README.

- [ ] **Step 1: Update CLAUDE.md env table**

Find the Environment Variables table in `.claude/CLAUDE.md` (after the "## Environment Variables" header) and add a note about per-scheduler controls. The existing `RUN_SCHEDULERS` entry mentions overall control; add the per-scheduler variants below it. Pattern:

```markdown
| `RUN_SCHEDULERS` | Set to `false` on additional web instances to prevent duplicate scheduler runs. Default (unset) runs schedulers — single-instance deploys unaffected. |
| `RUN_AUTOPAY_SCHEDULER` / `RUN_AUTOCOMPLETE_SCHEDULER` / `RUN_AUTO_ASSIGN_SCHEDULER` / `RUN_SEQUENCE_SCHEDULER` / `RUN_QUOTE_DRAFT_CLEANUP_SCHEDULER` / `RUN_LABRAT_PURGE_SCHEDULER` | Optional. Per-scheduler disable. Set to `false` to disable that specific scheduler. Honored only when `RUN_SCHEDULERS` is not `false` (global flag wins). |
```

- [ ] **Step 2: Update README.md env table**

Find the equivalent env table in `README.md` and add the same note.

- [ ] **Step 3: Commit**

```bash
git add .claude/CLAUDE.md README.md
git commit -m "docs: per-scheduler env vars in CLAUDE.md and README"
```

---

## Task 17: Smoke test and verification

This is a verification pass, no code changes.

- [ ] **Step 1: Restart dev server and confirm clean boot**

```bash
npm run dev
```

Expected log lines (in order):
- `[schedulerHealth] stale-scheduler monitor started`
- `[schedulers] started with per-scheduler controls`

No errors related to schema, scheduler bootstrap, or missing modules.

- [ ] **Step 2: Verify scheduler_health rows populate**

Wait at least 90 seconds (the longest initial delay is the email sequence scheduler at 90s). Then:

```bash
psql "$DATABASE_URL" -c "SELECT scheduler_name, last_status, last_run_at, consecutive_failures FROM scheduler_health ORDER BY scheduler_name;"
```

Expected: rows for at least these schedulers (some may not have run yet depending on timing):
- `autopay`
- `autocomplete`
- `auto_assign`
- `email_sequence`
- `quote_draft_cleanup` (only after ~2 min)
- `labrat_purge` (only after ~2.5 min)

All `last_status = 'ok'` and `consecutive_failures = 0` unless something actually failed.

- [ ] **Step 3: Verify schema additions are in place**

Spot-check each new column:

```bash
psql "$DATABASE_URL" -c "SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_name='proposals' AND column_name='event_timezone') AS proposals_event_timezone,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='proposals' AND column_name='archive_reason') AS proposals_archive_reason,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='clients' AND column_name='communication_preferences') AS clients_comm_prefs,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='notification_preferences') AS users_notif_prefs,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='users' AND column_name='communication_preferences') AS users_comm_prefs,
  (SELECT count(*) FROM information_schema.columns WHERE table_name='sms_messages' AND column_name='direction') AS sms_direction,
  (SELECT count(*) FROM information_schema.tables WHERE table_name='scheduled_messages') AS scheduled_messages_table,
  (SELECT count(*) FROM information_schema.tables WHERE table_name='scheduler_health') AS scheduler_health_table,
  (SELECT count(*) FROM information_schema.tables WHERE table_name='consults') AS consults_table;
"
```

Expected: every value is `1`.

- [ ] **Step 4: Verify no cancelled proposals remain**

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM proposals WHERE status = 'cancelled';"
```

Expected: `0`.

- [ ] **Step 5: Run all the unit tests**

```bash
npx jest server/utils/schedulerHealth.test.js server/utils/eventTimezone.test.js
```

Expected: all passing.

- [ ] **Step 6: Stop dev server**

Ctrl-C the dev server. No commit needed for verification.

---

## Self-review (run after all tasks above complete)

Run through the following checks before declaring Plan 1 done:

- [ ] All commits land cleanly on `main` with single-line messages
- [ ] `git status` shows a clean working tree
- [ ] `npm run lint` passes
- [ ] Both unit test files pass
- [ ] `psql "$DATABASE_URL" -c "\\d proposals"` shows `event_timezone` and `archive_reason`
- [ ] `psql "$DATABASE_URL" -c "\\d clients"` shows the new comm-prefs and status columns
- [ ] `psql "$DATABASE_URL" -c "\\d users"` shows `notification_preferences` and `communication_preferences`
- [ ] `psql "$DATABASE_URL" -c "\\d sms_messages"` shows `direction`
- [ ] `psql "$DATABASE_URL" -c "\\d scheduled_messages"` shows the full new table
- [ ] `psql "$DATABASE_URL" -c "\\d scheduler_health"` shows the heartbeat table
- [ ] `psql "$DATABASE_URL" -c "\\d consults"` shows the empty Cal.com table
- [ ] `scheduler_health` rows are populated for the live schedulers
- [ ] No `'cancelled'` status references remain in active code paths (grep cleanly)

---

## What's not in this plan

To keep Plan 1 focused, the following are intentionally deferred to subsequent plans:

- Any actual scheduled-message inserts (no touches yet wire into the new table)
- Email and SMS templates / Resend / Twilio wiring (Plans 2 and 3)
- Inbound SMS webhook and STOP-keyword handling (Plan 3)
- Cal.com integration (Plan 6)
- Thumbtack email harvester / auto-proposal flow (Plan 6)
- BEO, payment system, AI responder, etc. (later plans)

Plan 2 (Email-side touches) is the natural next step. It builds on the foundation here.
