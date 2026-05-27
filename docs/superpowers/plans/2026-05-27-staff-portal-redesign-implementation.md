# Staff Portal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full staff portal redesign per `docs/superpowers/specs/2026-05-27-staff-portal-redesign-design.md`. Ship a 4-tab portal (Home / Shifts / Pay / Tip Card) with an AccountPage overlay, the embedded BEO viewer on ShiftDetail, the drop / cover marketplace, light / dark theme, the calendar feed extension, and the channel-routed notifications surface (push gated to Phase B).

**Architecture:** Schema adds three JSONB columns on `users` (`ui_preferences`, `staff_notification_preferences`, `last_ics_fetch_at`), one column on `payment_profiles` (`zelle_handle`), one column on `contractor_profiles` (`alcohol_certification_expires_on`), five columns on `shift_requests` (cover / drop marketplace), one new table (`staff_document_history`), and widens two CHECK constraints (`users.onboarding_status` adds `'suspended'`; `scheduled_messages.channel` adds `'push'`). New server router `server/routes/staffPortal.js` mounts all `/api/me/*` endpoints. Three new server utils (`notificationChannelResolver`, `pushSender`, `staffCalendarFeedExt`). Existing `server/routes/calendar.js` extended in-place with BEO-confirm all-day VEVENTs. Existing `server/utils/scheduledMessageDispatcher.js` extended for multi-row enqueue + push channel. New React shell `client/src/components/StaffShell.js` + `StaffUserPillMenu.js` replaces `StaffLayout.js`. Eight new pages (HomePage, ShiftsPage with 3 sub-tabs, ShiftDetail, PayPage, PayoutDetail, TipCardPage, AccountPage with 5 sub-sections). Both `App.js` `HiringRoutes()` and `StaffSiteRoutes()` blocks swap `StaffLayout` → `StaffShell`. Eight old fragment files deleted after the 30-day redirect grace period begins.

**Tech Stack:** Node 18 / Express 4.18, raw SQL via `pg`, React 18 (CRA), `node:test`, Sentry, Twilio (via existing `sendAndLogSms`), `web-push` (new npm in Phase 10).

**Spec section anchors:** Every task references the relevant spec section. Read the spec section before starting the task.

**Inheritance:** The BEO implementation plan (`docs/superpowers/plans/2026-05-26-beo-implementation.md`) Phases 1-5 must be merged to `main` BEFORE Task 26 of this plan (which extends `GET /api/beo/:proposalId`). Phase 6 of the BEO plan is replaced wholesale by this plan: Task 29 of BEO (standalone `StaffBeo.js`) is dropped, the BEO content moves into Task 28 here (`ShiftDetail.js`). BEO Task 31 (badges on `StaffShifts`/`StaffEvents`) is dropped because those pages no longer exist after this plan ships.

**Phasing alignment:**
- Phase A (spec section 9): Tasks 1-41. Portal shell + drop / cover + theme + AccountPage + SMS-and-email notifications only. Push column in NotificationsSection is rendered but disabled with a "Coming in v1.5" banner.
- Phase B (spec section 9): Tasks 42-46. Push notifications + iOS coachmark + dispatcher push activation + NotificationsSection Push column unlock.

**Scope guard:** This plan implements the spec verbatim. Any deviation must be flagged and discussed before commit. No design changes during implementation.

---

## Phase 1: Foundation (schema + util skeletons)

### Task 1: Schema additions

**Spec ref:** Section 7 (Schema additions).

**Files:**
- Modify: `server/db/schema.sql`

- [ ] **Step 1: Read the current schema sections this task touches**

  - `users` table CHECK constraint around line 25 (`onboarding_status`)
  - `users` table columns around line 269 (`calendar_token`) and 2232+ (`notification_preferences`, `communication_preferences`)
  - `payment_profiles` table around line 129 + ALTERs around line 2000
  - `contractor_profiles` table (search for `CREATE TABLE.*contractor_profiles`)
  - `shift_requests` table
  - `scheduled_messages` table CHECK around line 2309
  - `pay_periods` CHECK around line 2531 (no change, just verify the values for downstream tasks)

  Get oriented before adding ALTERs.

- [ ] **Step 2: Add the new JSONB columns and tracking column on `users`**

  Append to the `users`-related migration section:

  ```sql
  -- ─── Staff portal: theme / tip-card order / calendar app detection ───
  ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_preferences JSONB
    NOT NULL DEFAULT '{}'::jsonb;

  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ics_fetch_at TIMESTAMPTZ;

  -- ─── Staff portal: per-category × per-channel notification routing ───
  ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_notification_preferences JSONB
    NOT NULL DEFAULT jsonb_build_object(
      'channels', jsonb_build_object(
        'shift_offered',   '["push","sms","email"]'::jsonb,
        'shift_decided',   '["push","sms"]'::jsonb,
        'cover_needed',    '["push"]'::jsonb,
        'beo_finalized',   '["push","sms","email"]'::jsonb,
        'beo_reminder_t3', '["push","sms"]'::jsonb,
        'schedule_change', '["push","sms","email"]'::jsonb,
        'payday',          '["sms","email"]'::jsonb,
        'tip_received',    '["push"]'::jsonb
      ),
      'push_subscriptions', '[]'::jsonb,
      'quiet_hours', 'null'::jsonb
    );
  ```

- [ ] **Step 3: Widen the two CHECK constraints**

  Use the existing `DO $$ ... EXCEPTION WHEN OTHERS THEN NULL` pattern (matching `pay_periods` around line 2528):

  ```sql
  DO $$ BEGIN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_onboarding_status_check;
    ALTER TABLE users ADD CONSTRAINT users_onboarding_status_check
      CHECK (onboarding_status IN (
        'in_progress','applied','interviewing','hired','rejected',
        'submitted','reviewed','approved','suspended','deactivated'
      ));
  EXCEPTION WHEN OTHERS THEN NULL; END $$;

  DO $$ BEGIN
    ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_channel_check;
    ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_channel_check
      CHECK (channel IN ('email','sms','push'));
  EXCEPTION WHEN OTHERS THEN NULL; END $$;
  ```

- [ ] **Step 4: Add `shift_requests` cover / drop columns + indexes**

  ```sql
  -- ─── Staff portal: drop / cover marketplace ───
  ALTER TABLE shift_requests
    ADD COLUMN IF NOT EXISTS cover_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cover_reason TEXT,
    ADD COLUMN IF NOT EXISTS dropped_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS drop_reason TEXT,
    ADD COLUMN IF NOT EXISTS drop_emergency BOOLEAN DEFAULT false,
    ADD COLUMN IF NOT EXISTS replaced_by_request_id INTEGER
      REFERENCES shift_requests(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_shift_requests_cover_requested
    ON shift_requests(cover_requested_at) WHERE cover_requested_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_shift_requests_dropped
    ON shift_requests(dropped_at) WHERE dropped_at IS NOT NULL;
  ```

- [ ] **Step 5: Add `payment_profiles.zelle_handle` + `contractor_profiles.alcohol_certification_expires_on`**

  ```sql
  ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS zelle_handle TEXT;

  ALTER TABLE contractor_profiles
    ADD COLUMN IF NOT EXISTS alcohol_certification_expires_on DATE;
  ```

- [ ] **Step 6: Add the `staff_document_history` table**

  ```sql
  CREATE TABLE IF NOT EXISTS staff_document_history (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_type VARCHAR(50) NOT NULL CHECK (doc_type IN ('w9', 'alcohol_certification')),
    previous_url VARCHAR(500),
    previous_filename VARCHAR(255),
    replaced_at TIMESTAMPTZ DEFAULT NOW(),
    replaced_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sdh_user ON staff_document_history(user_id);
  ```

- [ ] **Step 7: Apply the schema to the dev DB**

  ```bash
  npm run db:schema
  ```
  Expected: clean output. Idempotent ALTERs do nothing on re-run.

- [ ] **Step 8: Verify the additions**

  ```bash
  psql "$DATABASE_URL" -c "\d users" | grep -E 'ui_preferences|staff_notification_preferences|last_ics_fetch_at'
  psql "$DATABASE_URL" -c "\d users" | grep onboarding_status   # CHECK should list 'suspended'
  psql "$DATABASE_URL" -c "\d shift_requests" | grep -E 'cover_requested_at|dropped_at|drop_emergency|replaced_by_request_id'
  psql "$DATABASE_URL" -c "\d payment_profiles" | grep zelle_handle
  psql "$DATABASE_URL" -c "\d contractor_profiles" | grep alcohol_certification_expires_on
  psql "$DATABASE_URL" -c "\d scheduled_messages" | grep channel   # CHECK should list 'push'
  psql "$DATABASE_URL" -c "\d staff_document_history"
  ```

  Expected: every grep returns at least one row.

- [ ] **Step 9: Commit**

  ```bash
  git add server/db/schema.sql
  git commit -m "feat(staff-portal): schema additions for portal redesign"
  ```

---

### Task 2: notificationChannelResolver util

**Spec ref:** Section 6.13 (critical-path override + kill-switch interaction).

**Files:**
- Create: `server/utils/notificationChannelResolver.js`
- Create: `server/utils/notificationChannelResolver.test.js`

- [ ] **Step 1: Implement `pickChannelsForUserAndCategory`**

  Exports a single async function. Reads `users.staff_notification_preferences` and `users.communication_preferences` in one query. Returns a deduped channel array filtered by both the per-category opt-in and the top-level kill switch, with critical-path override applied if the user has muted ALL channels for `beo_finalized` / `schedule_change` / `payday`.

  ```javascript
  const { pool } = require('../db');

  const CRITICAL_CATEGORIES = new Set(['beo_finalized', 'schedule_change', 'payday']);
  const CRITICAL_FALLBACK_ORDER = ['sms', 'email', 'push']; // try SMS first, then email, then push

  /**
   * Resolve the effective channel set for a categorized message.
   * @returns {Promise<string[]>} subset of ['email','sms','push']
   */
  async function pickChannelsForUserAndCategory(userId, category) {
    const { rows } = await pool.query(
      `SELECT staff_notification_preferences AS prefs, communication_preferences AS comms
         FROM users WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) return [];
    const { prefs, comms } = rows[0];
    const requested = Array.isArray(prefs?.channels?.[category]) ? prefs.channels[category] : [];
    const filtered = requested.filter(ch => {
      if (ch === 'sms' && comms?.sms_enabled === false) return false;
      if (ch === 'email' && comms?.email_enabled === false) return false;
      return true;
    });
    if (filtered.length > 0) return Array.from(new Set(filtered));
    if (CRITICAL_CATEGORIES.has(category)) {
      for (const ch of CRITICAL_FALLBACK_ORDER) {
        if (ch === 'sms' && comms?.sms_enabled === false) continue;
        if (ch === 'email' && comms?.email_enabled === false) continue;
        return [ch];
      }
    }
    return [];
  }

  module.exports = { pickChannelsForUserAndCategory, CRITICAL_CATEGORIES };
  ```

- [ ] **Step 2: Write tests**

  In `notificationChannelResolver.test.js`:
  - Returns the user's opted-in channels, deduped
  - `comms.sms_enabled=false` filters SMS from every result
  - `comms.email_enabled=false` filters email
  - Critical-path override fires when all channels for `beo_finalized` are off, prefers SMS
  - Critical-path override degrades to email if SMS is off, then to push if both off
  - Returns empty for unknown user
  - Returns empty for category not in prefs (defensive)

  Use the dev DB with a freshly-inserted test user; clean up in `after()`.

- [ ] **Step 3: Run the tests**

  ```bash
  node --test server/utils/notificationChannelResolver.test.js
  ```
  Expected: all pass.

- [ ] **Step 4: Commit**

  ```bash
  git add server/utils/notificationChannelResolver.js server/utils/notificationChannelResolver.test.js
  git commit -m "feat(staff-portal): notification channel resolver with critical-path override"
  ```

---

### Task 3: pushSender util (skeleton)

**Spec ref:** Section 6.17 (push infrastructure). This task creates the file with a stub `sendPush` that returns `{ ok: false, gone: false }` for now. Phase 10 (Task 45) replaces the stub body with real `web-push` calls. Doing it this way keeps the dispatcher's call sites stable from Phase 3 onward.

**Files:**
- Create: `server/utils/pushSender.js`
- Create: `server/utils/pushSender.test.js`

- [ ] **Step 1: Implement the stub**

  ```javascript
  /**
   * Send a Web Push notification. Phase A stub: returns ok:false without sending.
   * Phase B (Task 45) replaces the body with real web-push calls.
   *
   * @returns {Promise<{ok: boolean, gone?: boolean, error?: string}>}
   *   ok:true → delivered. gone:true → subscription is 410/404, caller should prune.
   */
  async function sendPush({ subscription, title, body, url, tag, icon }) {
    return { ok: false, error: 'push_phase_b' };
  }

  module.exports = { sendPush };
  ```

- [ ] **Step 2: Write tests for the stub**

  Single test confirming the stub returns `ok:false` with `error:'push_phase_b'`. Phase B replaces these tests with real send-path coverage.

- [ ] **Step 3: Run + commit**

  ```bash
  node --test server/utils/pushSender.test.js
  git add server/utils/pushSender.js server/utils/pushSender.test.js
  git commit -m "feat(staff-portal): pushSender stub (Phase B activates real send)"
  ```

---

### Task 4: enqueueCategorizedMessage helper

**Spec ref:** Section 6.13 ("Dispatcher integration" subsection).

**Files:**
- Modify: `server/utils/scheduledMessages.js` (the existing scheduler-side helper file)
- Create: `server/utils/scheduledMessages.test.js` (if it doesn't exist; otherwise extend)

- [ ] **Step 1: Read the existing scheduledMessages.js to find the `scheduleMessage` insert helper**

  Locate where rows are inserted into `scheduled_messages`. The new `enqueueCategorizedMessage` calls `pickChannelsForUserAndCategory` and inserts one row per resolved channel.

- [ ] **Step 2: Add the helper**

  ```javascript
  const { pickChannelsForUserAndCategory } = require('./notificationChannelResolver');

  /**
   * Enqueue a categorized message, fanning out to all opted-in channels.
   * Returns the array of inserted scheduled_messages.id values.
   */
  async function enqueueCategorizedMessage({
    userId,
    category,
    payload,
    sendAt,           // Date | ISO string
    anchorEntityType, // e.g. 'shift_request', 'drink_plan'
    anchorEntityId,
    suppressionKey,   // optional dedupe key for the cascade
  }, client = pool) {
    const channels = await pickChannelsForUserAndCategory(userId, category);
    if (channels.length === 0) return [];
    const insertedIds = [];
    for (const channel of channels) {
      const { rows } = await client.query(
        `INSERT INTO scheduled_messages
           (user_id, category, channel, payload, send_at,
            anchor_entity_type, anchor_entity_id, suppression_key, status)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, 'pending')
         RETURNING id`,
        [userId, category, channel, JSON.stringify(payload), sendAt,
         anchorEntityType, anchorEntityId, suppressionKey]
      );
      insertedIds.push(rows[0].id);
    }
    return insertedIds;
  }

  module.exports.enqueueCategorizedMessage = enqueueCategorizedMessage;
  ```

  Adjust column names to match the actual `scheduled_messages` schema (verify against `server/db/schema.sql` before writing).

- [ ] **Step 3: Tests**

  - Inserts N rows for an N-channel resolved set
  - Inserts zero rows when the user has muted all channels (non-critical category)
  - Inserts one row for a critical category that fell back to a critical-path channel
  - Accepts a transaction client (passes the second arg through)
  - Stores the `suppression_key` for the cascade to use

- [ ] **Step 4: Run + commit**

  ```bash
  node --test server/utils/scheduledMessages.test.js
  git add server/utils/scheduledMessages.js server/utils/scheduledMessages.test.js
  git commit -m "feat(staff-portal): enqueueCategorizedMessage fan-out helper"
  ```

---

## Phase 2: Dispatcher integration + calendar feed extension

### Task 5: Dispatcher kill-switch re-check + push channel send

**Spec ref:** Section 6.13 (Dispatcher integration). Push send path lands here behind a feature flag so Phase B can activate it by flipping the flag without re-touching this code.

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.js`

- [ ] **Step 1: Read the existing dispatcher loop**

  Find where each `scheduled_messages` row is read and sent. Identify the branches that handle `channel='sms'` and `channel='email'`. The new `channel='push'` branch slots in beside them.

- [ ] **Step 2: Add the kill-switch re-check**

  Before any channel-specific send, read the user's `communication_preferences`. Skip + mark the row `suppressed` (existing terminal status) if the channel kill switch has flipped to false since enqueue.

  ```javascript
  const { rows: userRows } = await client.query(
    `SELECT communication_preferences AS comms,
            staff_notification_preferences AS staff_prefs
       FROM users WHERE id = $1`,
    [row.user_id]
  );
  const { comms, staff_prefs } = userRows[0] || {};

  if (row.channel === 'sms' && comms?.sms_enabled === false) {
    await markSuppressed(row.id, 'sms_kill_switch');
    continue;
  }
  if (row.channel === 'email' && comms?.email_enabled === false) {
    await markSuppressed(row.id, 'email_kill_switch');
    continue;
  }
  ```

- [ ] **Step 3: Add the push channel branch**

  ```javascript
  if (row.channel === 'push') {
    const subs = Array.isArray(staff_prefs?.push_subscriptions) ? staff_prefs.push_subscriptions : [];
    if (subs.length === 0) {
      await markSuppressed(row.id, 'no_push_subscriptions');
      continue;
    }
    let anyOk = false;
    const survivors = [];
    for (const sub of subs) {
      const result = await pushSender.sendPush({
        subscription: { endpoint: sub.endpoint, keys: sub.keys },
        title: row.payload.title,
        body:  row.payload.body,
        url:   row.payload.url,
        tag:   row.payload.tag || row.category,
        icon:  row.payload.icon,
      });
      if (result.ok) { anyOk = true; survivors.push(sub); }
      else if (result.gone) { /* prune */ }
      else { survivors.push(sub); }
    }
    if (survivors.length !== subs.length) {
      await client.query(
        `UPDATE users
            SET staff_notification_preferences =
                jsonb_set(staff_notification_preferences, '{push_subscriptions}', $2::jsonb, true)
          WHERE id = $1`,
        [row.user_id, JSON.stringify(survivors)]
      );
    }
    await markSent(row.id, anyOk ? 'sent' : 'failed');
    continue;
  }
  ```

  In Phase A, every push row resolves to `failed` (because `pushSender` is the stub). The dispatcher does not retry failed rows by default, so this is safe to ship early. Phase 10 / Task 45 swaps the stub.

- [ ] **Step 4: Suppression-key cascade**

  When a row sends successfully, also mark any sibling rows (same `suppression_key`, different `channel`) as `suppressed` IF the category's payload includes `single_delivery: true`. Default category payload omits the flag, so multi-channel delivery (push + SMS) still goes out for the same event.

- [ ] **Step 5: Tests**

  Extend `scheduledMessageDispatcher.test.js` with:
  - `sms_enabled=false` at send time skips the row even though it was enqueued
  - `push` row iterates subscriptions; in Phase A stub mode, every row ends `failed`
  - `payload.single_delivery=true` cascades to suppress siblings on success
  - Critical-path messages still send via remaining channel when kill switches force re-routing

- [ ] **Step 6: Commit**

  ```bash
  git add server/utils/scheduledMessageDispatcher.js \
          server/utils/scheduledMessageDispatcher.test.js
  git commit -m "feat(staff-portal): dispatcher kill-switch re-check + push branch (stub send)"
  ```

---

### Task 6: Calendar feed extension (BEO-confirm all-day VEVENTs)

**Spec ref:** Section 6.12 (Calendar sync).

**Files:**
- Create: `server/utils/staffCalendarFeedExt.js`
- Create: `server/utils/staffCalendarFeedExt.test.js`
- Modify: `server/routes/calendar.js`

- [ ] **Step 1: Read the existing `buildCalendarFeed` in `server/routes/calendar.js`**

  Locate the VEVENT composition loop. Identify the shape of the per-shift row data (date, start, end, location, etc.). The extension reuses the same row data plus a LEFT JOIN to `drink_plans` and `shift_requests` to determine `unconfirmed BEO` shifts.

- [ ] **Step 2: Implement the extension util**

  ```javascript
  /**
   * Compose all-day VEVENT entries for unconfirmed-BEO shifts.
   * @param {Array<{shift_id, event_date, client_name, finalized_at, beo_acknowledged_at}>} rows
   * @param {string} portalBaseUrl  e.g. 'https://staff.drbartender.com'
   * @returns {string[]} array of VEVENT block strings
   */
  function buildBeoConfirmVEvents(rows, portalBaseUrl) {
    const out = [];
    for (const row of rows) {
      if (!row.finalized_at) continue;
      if (row.beo_acknowledged_at) continue;
      const eventDate = new Date(row.event_date);
      const reminderDate = new Date(eventDate);
      reminderDate.setUTCDate(reminderDate.getUTCDate() - 3);
      const yyyymmdd = reminderDate.toISOString().slice(0, 10).replace(/-/g, '');
      const safeClient = escapeIcs(row.client_name || 'client');
      const url = `${portalBaseUrl}/shifts/${row.shift_id}`;
      out.push([
        'BEGIN:VEVENT',
        `UID:beo-confirm-${row.shift_id}@drbartender.com`,
        `DTSTAMP:${nowIcs()}`,
        `DTSTART;VALUE=DATE:${yyyymmdd}`,
        `DTEND;VALUE=DATE:${addDayIcs(yyyymmdd)}`,
        `SUMMARY:Confirm BEO: ${safeClient}`,
        `DESCRIPTION:Open the staff portal to confirm: ${url}`,
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      ].join('\r\n'));
    }
    return out;
  }

  function escapeIcs(s) { return String(s).replace(/[\\,;]/g, x => '\\' + x).replace(/\n/g, '\\n'); }
  function nowIcs() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
  function addDayIcs(yyyymmdd) {
    const d = new Date(`${yyyymmdd.slice(0,4)}-${yyyymmdd.slice(4,6)}-${yyyymmdd.slice(6,8)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }

  module.exports = { buildBeoConfirmVEvents };
  ```

- [ ] **Step 3: Wire into `calendar.js`**

  Locate the staff projection in `buildCalendarFeed`. Extend the SQL to LEFT JOIN `drink_plans` (for `finalized_at`) and re-project `beo_acknowledged_at` from the staffer's own `shift_request`. Call `buildBeoConfirmVEvents(rows, portalBaseUrl)` and append the strings to the existing VEVENT array before serializing.

  `portalBaseUrl` resolves to `process.env.STAFF_URL || 'https://staff.drbartender.com'`.

- [ ] **Step 4: Tests**

  In `staffCalendarFeedExt.test.js`:
  - Emits a VEVENT for each row with `finalized_at IS NOT NULL AND beo_acknowledged_at IS NULL`
  - Skips already-acknowledged BEOs
  - Skips un-finalized drink plans
  - DTSTART is exactly 3 days before `event_date` (test boundary cases)
  - SUMMARY escapes commas, semicolons, backslashes in client name
  - UID is stable per shift_id (idempotent across feed fetches)

- [ ] **Step 5: Manual verification**

  ```bash
  curl -s "http://localhost:5000/api/calendar/feed/<a-test-token>" | grep -E 'Confirm BEO|TRANSP:TRANSPARENT'
  ```
  Expected: at least one block when a test shift has an unconfirmed finalized BEO 3+ days out.

- [ ] **Step 6: Commit**

  ```bash
  git add server/utils/staffCalendarFeedExt.js \
          server/utils/staffCalendarFeedExt.test.js \
          server/routes/calendar.js
  git commit -m "feat(staff-portal): extend calendar feed with BEO-confirm all-day VEVENTs"
  ```

---

## Phase 3: Staff portal API (`/api/me/*`)

### Task 7: staffPortal.js skeleton + GET /api/me/staff-home

**Spec ref:** Section 6.2 (HomePage data sources), Section 8.1 (Server new).

**Files:**
- Create: `server/routes/staffPortal.js`
- Create: `server/routes/staffPortal.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Skeleton with auth + asyncHandler**

  ```javascript
  const express = require('express');
  const Sentry = require('@sentry/node');
  const { pool } = require('../db');
  const { auth } = require('../middleware/auth');
  const asyncHandler = require('../middleware/asyncHandler');
  const { ValidationError, NotFoundError } = require('../utils/errors');

  const router = express.Router();
  router.use(auth);

  // GET /api/me/staff-home
  router.get('/staff-home', asyncHandler(async (req, res) => {
    // ... see step 2
  }));

  module.exports = router;
  ```

- [ ] **Step 2: Implement `/staff-home` composite**

  Single Promise.all of 4 queries:
  - Next upcoming approved shift (LEFT JOIN drink_plans for `finalized_at`, project `beo_acknowledged_at`)
  - Pending shift requests for this user
  - Cover-needed broadcasts (other users' shift_requests where `cover_requested_at IS NOT NULL`), with a derived `you_are_on_team` from the same proposal's shift_requests
  - Current pay period summary (latest `payouts` row joined to `pay_periods`)

  Return the composite shape the HomePage expects:

  ```javascript
  res.json({
    next_shift: ..., // ShiftCard payload or null
    pending_requests: [...],
    cover_broadcasts: [...],
    current_period: { projected_cents, payday, event_count, period_id } | null,
    open_shifts_teaser: [...] // top 2 open shifts
  });
  ```

- [ ] **Step 3: Mount in `server/index.js`**

  Add `app.use('/api/me', require('./routes/staffPortal'));` near the other route mounts.

  Verify `/api/me/notification-preferences` (admin) and `/api/me/tip-page` (existing in `server/routes/me.js`) do NOT collide. The existing `/api/me` mount points to `server/routes/me.js`; the new mount needs to coexist. Two options:
  - Move the new endpoints to `/api/me-staff/*` (cleaner, no risk of order-dependent middleware bugs)
  - Mount staffPortal AFTER me.js so the existing routes match first

  Use option 1 (`/api/me-staff/*`) ONLY IF the existing me.js already owns `/api/me`. Otherwise option 2. Decide based on the actual mount order in `server/index.js`. Update the client to match.

  **Decision committed at plan time:** keep the URL space `/api/me/*` and merge by routing BOTH `server/routes/me.js` and `server/routes/staffPortal.js` under the same `/api/me` mount point, with `staffPortal` mounted second. Express resolves by registration order; the existing `me.js` paths win on collision, but there are no collisions (verify via `git grep "router.\(get\|post\|put\|patch\|delete\)" server/routes/me.js`).

- [ ] **Step 4: Test**

  In `staffPortal.test.js`:
  - Insert a test user with one upcoming approved shift, one pending request, one teammate-cover request
  - Hit `GET /api/me/staff-home` with a JWT for that user
  - Assert all 5 keys present and shaped correctly
  - Assert IDOR: a different user's JWT gets a different payload (no leakage)

- [ ] **Step 5: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js server/index.js
  git commit -m "feat(staff-portal): GET /api/me/staff-home composite endpoint"
  ```

---

### Task 8: Payment methods endpoints

**Spec ref:** Section 6.11 (AccountPage / Payment methods).

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: GET /api/me/payment-methods**

  Project all handle columns from `payment_profiles` + `preferred_payment_method`. Render the conceptual Card row server-side with a stable shape. Read `users.ui_preferences.tip_card_order` to determine the rendered order.

  ```javascript
  router.get('/payment-methods', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT venmo_handle, cashapp_handle, paypal_url, zelle_handle,
              routing_number, account_number, payment_username,
              preferred_payment_method
         FROM payment_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    const pp = rows[0] || {};
    const { rows: uiRows } = await pool.query(
      `SELECT ui_preferences FROM users WHERE id = $1`, [req.user.id]
    );
    const order = uiRows[0]?.ui_preferences?.tip_card_order || ['card', 'venmo', 'cashapp', 'paypal', 'zelle'];
    res.json({
      preferred: pp.preferred_payment_method,
      tip_card_order: order,
      methods: {
        card:           { kind: 'card', label: 'Card payments', always_on: true, tip_eligible: true, payroll_eligible: false },
        venmo:          { kind: 'venmo', handle: pp.venmo_handle, tip_eligible: true, payroll_eligible: true },
        cashapp:        { kind: 'cashapp', handle: pp.cashapp_handle, tip_eligible: true, payroll_eligible: true },
        paypal:         { kind: 'paypal', handle: pp.paypal_url, tip_eligible: true, payroll_eligible: true },
        zelle:          { kind: 'zelle', handle: pp.zelle_handle, tip_eligible: true, payroll_eligible: true },
        direct_deposit: { kind: 'direct_deposit', routing: pp.routing_number, account_last4: pp.account_number ? pp.account_number.slice(-4) : null, tip_eligible: false, payroll_eligible: true },
        check:          { kind: 'check', tip_eligible: false, payroll_eligible: true },
      },
    });
  }));
  ```

  Never project full `account_number` in any response; only the last 4. This is the bank-PII guard (see spec §10, §12).

- [ ] **Step 2: PATCH /api/me/payment-methods**

  Accepts a partial body. Validates each handle via `server/utils/tipHandleValidation.js` (existing). Writes only present keys. Null clears.

  Critical: if the PATCH clears the handle for the currently-preferred method, auto-NULL `preferred_payment_method` in the same UPDATE. Use a transaction.

  ```javascript
  const ALLOWED = ['venmo_handle','cashapp_handle','paypal_url','zelle_handle','routing_number','account_number','payment_username'];
  const HANDLE_TO_METHOD = {
    venmo_handle: 'venmo', cashapp_handle: 'cashapp', paypal_url: 'paypal',
    zelle_handle: 'zelle', routing_number: 'direct_deposit', account_number: 'direct_deposit',
  };

  router.patch('/payment-methods', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const keys = Object.keys(body).filter(k => ALLOWED.includes(k));
    if (keys.length === 0) throw new ValidationError({ _form: 'No editable fields in body.' });
    // Format validation
    const { normalizeTipHandlesInPlace } = require('../utils/tipHandleValidation');
    normalizeTipHandlesInPlace(body); // throws ValidationError on bad format
    // Direct-deposit pair guard: if one of routing/account is being cleared and the other is non-null, error
    // (or auto-clear both, pick one; spec says reject 400 in the test list)
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
      const values = keys.map(k => body[k]);
      await client.query(
        `UPDATE payment_profiles SET ${setClause}, updated_at = NOW() WHERE user_id = $1`,
        [req.user.id, ...values]
      );
      // Auto-NULL preferred if its handle was cleared
      const { rows } = await client.query(
        `SELECT preferred_payment_method,
                venmo_handle, cashapp_handle, paypal_url, zelle_handle,
                routing_number, account_number
           FROM payment_profiles WHERE user_id = $1`,
        [req.user.id]
      );
      const pp = rows[0];
      const handleByMethod = { venmo: pp.venmo_handle, cashapp: pp.cashapp_handle, paypal: pp.paypal_url, zelle: pp.zelle_handle, direct_deposit: pp.routing_number && pp.account_number };
      if (pp.preferred_payment_method && pp.preferred_payment_method !== 'check' && !handleByMethod[pp.preferred_payment_method]) {
        await client.query(
          `UPDATE payment_profiles SET preferred_payment_method = NULL WHERE user_id = $1`,
          [req.user.id]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }));
  ```

- [ ] **Step 3: PUT /api/me/preferred-payment-method**

  ```javascript
  const VALID_METHODS = ['venmo','cashapp','paypal','zelle','direct_deposit','check'];

  router.put('/preferred-payment-method', asyncHandler(async (req, res) => {
    const { method } = req.body || {};
    if (!VALID_METHODS.includes(method)) {
      throw new ValidationError({ method: 'Invalid method.' });
    }
    const { rows } = await pool.query(
      `SELECT venmo_handle, cashapp_handle, paypal_url, zelle_handle,
              routing_number, account_number
         FROM payment_profiles WHERE user_id = $1`,
      [req.user.id]
    );
    const pp = rows[0] || {};
    const handleByMethod = {
      venmo: pp.venmo_handle, cashapp: pp.cashapp_handle, paypal: pp.paypal_url, zelle: pp.zelle_handle,
      direct_deposit: pp.routing_number && pp.account_number,
      check: true, // check has no handle, always eligible
    };
    if (!handleByMethod[method]) {
      const field = { venmo: 'venmo_handle', cashapp: 'cashapp_handle', paypal: 'paypal_url',
                      zelle: 'zelle_handle', direct_deposit: 'routing_number' }[method];
      throw new ValidationError({ [field]: `Add a ${method} handle before setting it as preferred.` });
    }
    await pool.query(
      `UPDATE payment_profiles SET preferred_payment_method = $2 WHERE user_id = $1`,
      [req.user.id, method]
    );
    res.json({ ok: true });
  }));
  ```

- [ ] **Step 4: Tests** for the three endpoints. Cover: GET shape; PATCH null-clears + auto-NULL of preferred; PUT rejects when handle absent; IDOR.

- [ ] **Step 5: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js
  git commit -m "feat(staff-portal): payment-methods GET/PATCH + preferred-method PUT"
  ```

---

### Task 9: tip-card-order, profile, ui-preferences endpoints

**Spec ref:** Section 6.8 (tip card order), 6.10 (Profile), 6.16 (Theme).

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: PUT /api/me/tip-card-order**

  ```javascript
  const ORDER_TOKENS = new Set(['card', 'venmo', 'cashapp', 'paypal', 'zelle']);

  router.put('/tip-card-order', asyncHandler(async (req, res) => {
    const { order } = req.body || {};
    if (!Array.isArray(order)) throw new ValidationError({ order: 'Must be an array.' });
    for (const tok of order) {
      if (!ORDER_TOKENS.has(tok)) throw new ValidationError({ order: `Unknown method: ${tok}` });
    }
    await pool.query(
      `UPDATE users
          SET ui_preferences = jsonb_set(ui_preferences, '{tip_card_order}', $2::jsonb, true)
        WHERE id = $1`,
      [req.user.id, JSON.stringify(order)]
    );
    res.json({ ok: true });
  }));
  ```

- [ ] **Step 2: PATCH /api/me/profile**

  Writes to `contractor_profiles`. Allowed fields: `preferred_name`, `phone`, `email`, `street_address`, `city`, `state`, `zip_code`, `emergency_contact_name`, `emergency_contact_phone`, `emergency_contact_relationship`. Validate phone format (E.164 via existing util), email format. Reject any other key.

- [ ] **Step 3: PATCH /api/me/ui-preferences**

  Merges into the JSONB:

  ```javascript
  const UI_KEYS = new Set(['theme', 'calendar_subscribed_app']);
  const VALID_THEMES = new Set(['light', 'dark']);

  router.patch('/ui-preferences', asyncHandler(async (req, res) => {
    const body = req.body || {};
    const keys = Object.keys(body).filter(k => UI_KEYS.has(k));
    if (keys.length === 0) throw new ValidationError({ _form: 'Provide at least one key.' });
    if ('theme' in body && !VALID_THEMES.has(body.theme)) {
      throw new ValidationError({ theme: 'theme must be light or dark' });
    }
    // Build a partial-merge update
    const updates = keys.map((k, i) => `jsonb_set(ui_preferences, ARRAY['${k}'], $${i + 2}::jsonb, true)`);
    // Chained jsonb_set
    let expr = 'ui_preferences';
    keys.forEach((k, i) => {
      expr = `jsonb_set(${expr}, ARRAY['${k}'], $${i + 2}::jsonb, true)`;
    });
    await pool.query(
      `UPDATE users SET ui_preferences = ${expr} WHERE id = $1`,
      [req.user.id, ...keys.map(k => JSON.stringify(body[k]))]
    );
    res.json({ ok: true });
  }));
  ```

  Note: `tip_card_order` goes via the dedicated PUT route, not through this PATCH. `ui-preferences` PATCH is for `theme` + `calendar_subscribed_app` only.

- [ ] **Step 4: Tests** for the three endpoints. Tip-card-order rejects unknown tokens. Profile rejects unknown keys. UI-preferences merges atomically (concurrent PATCH theme + calendar_subscribed_app from two requests both land).

- [ ] **Step 5: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js
  git commit -m "feat(staff-portal): tip-card-order PUT, profile + ui-preferences PATCH"
  ```

---

### Task 10: staff-notifications + push-subscriptions endpoints

**Spec ref:** Section 6.13 (Notifications), 6.17 (Push infrastructure).

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: GET /api/me/staff-notifications**

  ```javascript
  router.get('/staff-notifications', asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT staff_notification_preferences AS prefs,
              communication_preferences AS comms
         FROM users WHERE id = $1`,
      [req.user.id]
    );
    res.json({
      prefs: rows[0]?.prefs || {},
      comms: rows[0]?.comms || {},
    });
  }));
  ```

- [ ] **Step 2: PATCH /api/me/staff-notifications**

  Body shape: `{ channels: { [category]: ['push','sms',...] } }` OR `{ quiet_hours: {...} }`. Partial merge via `jsonb_set` per category key.

  ```javascript
  const VALID_CATEGORIES = new Set([
    'shift_offered','shift_decided','cover_needed','beo_finalized',
    'beo_reminder_t3','schedule_change','payday','tip_received'
  ]);
  const VALID_CHANNELS = new Set(['push','sms','email']);

  router.patch('/staff-notifications', asyncHandler(async (req, res) => {
    const { channels, quiet_hours } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (channels && typeof channels === 'object') {
        for (const [cat, chs] of Object.entries(channels)) {
          if (!VALID_CATEGORIES.has(cat)) throw new ValidationError({ [cat]: 'Unknown category.' });
          if (!Array.isArray(chs)) throw new ValidationError({ [cat]: 'Must be an array.' });
          const cleaned = [...new Set(chs.filter(c => VALID_CHANNELS.has(c)))];
          await client.query(
            `UPDATE users
                SET staff_notification_preferences =
                    jsonb_set(staff_notification_preferences, ARRAY['channels',$2], $3::jsonb, true)
              WHERE id = $1`,
            [req.user.id, cat, JSON.stringify(cleaned)]
          );
        }
      }
      if (quiet_hours !== undefined) {
        await client.query(
          `UPDATE users
              SET staff_notification_preferences =
                  jsonb_set(staff_notification_preferences, '{quiet_hours}', $2::jsonb, true)
            WHERE id = $1`,
          [req.user.id, JSON.stringify(quiet_hours)]
        );
      }
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }));
  ```

- [ ] **Step 3: POST /api/me/push-subscriptions**

  Body: `{ endpoint, keys: { p256dh, auth }, user_agent }`. Validates fields. Appends to the JSONB array, replacing any existing entry with the same `endpoint`.

  ```javascript
  router.post('/push-subscriptions', asyncHandler(async (req, res) => {
    const { endpoint, keys, user_agent } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      throw new ValidationError({ _form: 'endpoint + keys.p256dh + keys.auth required.' });
    }
    const entry = { endpoint, keys, user_agent: user_agent || req.get('user-agent') || '', subscribed_at: new Date().toISOString() };
    await pool.query(
      `UPDATE users
          SET staff_notification_preferences = jsonb_set(
            staff_notification_preferences,
            '{push_subscriptions}',
            COALESCE(
              (SELECT jsonb_agg(s) FROM jsonb_array_elements(
                COALESCE(staff_notification_preferences->'push_subscriptions','[]'::jsonb)
              ) AS s WHERE s->>'endpoint' <> $2) || $3::jsonb,
              $3::jsonb
            ),
            true
          )
        WHERE id = $1`,
      [req.user.id, endpoint, JSON.stringify([entry])]
    );
    res.json({ ok: true });
  }));
  ```

- [ ] **Step 4: DELETE /api/me/push-subscriptions**

  Body: `{ endpoint }`. Filters the array.

- [ ] **Step 5: Tests**: partial PATCH preserves untouched categories, push-subscription POST deduplicates on endpoint, DELETE prunes.

- [ ] **Step 6: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js
  git commit -m "feat(staff-portal): staff-notifications + push-subscriptions endpoints"
  ```

---

### Task 11: Documents replace endpoint

**Spec ref:** Section 6.14 (Documents).

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: POST /api/me/documents/:doc_type/replace**

  Multipart upload via `express-fileupload` (already in stack). Validates magic bytes via `server/utils/fileValidation.js`. Uploads to R2. Writes the previous URL into `staff_document_history` BEFORE updating the active record (so a partial failure preserves the audit trail).

  ```javascript
  const { validateUploadedFile } = require('../utils/fileValidation');
  const { uploadToR2 } = require('../utils/storage');

  const DOC_TYPES = {
    w9: {
      table: 'payment_profiles',
      urlCol: 'w9_file_url',
      nameCol: 'w9_filename',
      r2Prefix: 'staff/w9',
      mimeAllow: ['application/pdf', 'image/png', 'image/jpeg'],
    },
    alcohol_certification: {
      table: 'contractor_profiles',
      urlCol: 'alcohol_certification_file_url',
      nameCol: 'alcohol_certification_filename',
      r2Prefix: 'staff/alcohol-cert',
      mimeAllow: ['application/pdf', 'image/png', 'image/jpeg'],
    },
  };

  router.post('/documents/:doc_type/replace', asyncHandler(async (req, res) => {
    const cfg = DOC_TYPES[req.params.doc_type];
    if (!cfg) throw new NotFoundError('Unknown document type.');
    const file = req.files?.file;
    if (!file) throw new ValidationError({ file: 'No file uploaded.' });
    await validateUploadedFile(file, { allowedMimes: cfg.mimeAllow });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: priorRows } = await client.query(
        `SELECT ${cfg.urlCol} AS url, ${cfg.nameCol} AS filename FROM ${cfg.table} WHERE user_id = $1`,
        [req.user.id]
      );
      const prior = priorRows[0] || {};
      // Snapshot BEFORE upload to avoid losing history on R2 failure
      await client.query(
        `INSERT INTO staff_document_history (user_id, doc_type, previous_url, previous_filename, replaced_by_user_id)
         VALUES ($1, $2, $3, $4, $1)`,
        [req.user.id, req.params.doc_type, prior.url, prior.filename]
      );
      // Upload outside the txn? No: R2 is the slow part; keep the txn open or upload first.
      // Decision: upload first, then write the active record + history together. Reorder:
      //   1. Upload to R2 (returns new URL)
      //   2. Open txn, INSERT history, UPDATE active record, COMMIT
      // If R2 upload fails, nothing changes in the DB. If txn fails after upload, the R2 object is orphaned (acceptable).
      await client.query('ROLLBACK'); // discard the speculative history insert
      const newKey = `${cfg.r2Prefix}/${req.user.id}/${Date.now()}_${file.name}`;
      const newUrl = await uploadToR2(file.data, newKey, file.mimetype);

      await client.query('BEGIN');
      await client.query(
        `INSERT INTO staff_document_history (user_id, doc_type, previous_url, previous_filename, replaced_by_user_id)
         VALUES ($1, $2, $3, $4, $1)`,
        [req.user.id, req.params.doc_type, prior.url, prior.filename]
      );
      await client.query(
        `UPDATE ${cfg.table} SET ${cfg.urlCol} = $2, ${cfg.nameCol} = $3 WHERE user_id = $1`,
        [req.user.id, newUrl, file.name]
      );
      await client.query('COMMIT');
      res.json({ ok: true, url: newUrl, filename: file.name });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch {}
      throw err;
    } finally {
      client.release();
    }
  }));
  ```

  The history-then-active-record order inside the same txn ensures both succeed or neither does.

- [ ] **Step 2: Tests**

  - W-9 replace writes to `payment_profiles.w9_file_url`, snapshots prior into history
  - Alcohol cert replace writes to `contractor_profiles.alcohol_certification_file_url`
  - Invalid mime returns 400, no history row, no active-record change
  - R2 upload failure returns 5xx, no history row, no active-record change

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js
  git commit -m "feat(staff-portal): document replace endpoint with history snapshot"
  ```

---

### Task 12: staffPortal.test.js round-out

**Spec ref:** §11 Testing approach, "staffPortal.test.js" sub-list.

**Files:**
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: IDOR test pass**

  For every PATCH / PUT / POST / DELETE endpoint added in Tasks 7-11, add a paired test that authenticates as user B and tries to mutate user A's data. Assert 403 (or 404, depending on the existing error pattern) and verify user A's row is unchanged.

- [ ] **Step 2: Auth gate pass**

  For every endpoint, hit it without a JWT. Assert 401.

- [ ] **Step 3: Run the whole file**

  ```bash
  node --test server/routes/staffPortal.test.js
  ```

- [ ] **Step 4: Commit**

  ```bash
  git add server/routes/staffPortal.test.js
  git commit -m "test(staff-portal): IDOR + auth-gate coverage across staffPortal endpoints"
  ```

---

## Phase 4: Drop / Cover marketplace

### Task 13: SMS templates

**Spec ref:** §3.3 (Drop / Cover marketplace), §6.5 (Drop / Cover flow).

**Files:**
- Modify: `server/utils/smsTemplates.js`
- Modify: `server/utils/smsTemplates.test.js` (if exists; otherwise create)

- [ ] **Step 1: Add `cover_broadcast_sms` and `staff_drop_to_management_sms`**

  ```javascript
  // Sent to qualified opted-in teammates when a staffer requests a cover
  function cover_broadcast_sms({ first_initial_last_initial, client_name, event_date_short, shift_role, shift_url }) {
    return `Dr Bartender: ${first_initial_last_initial} needs a cover on ${event_date_short} (${client_name}, ${shift_role}). Grab it: ${shift_url}`;
  }

  // Sent to management when an emergency drop fires
  function staff_drop_to_management_sms({ staff_name, client_name, event_date_short, hours_to_event, reason }) {
    return `Dr Bartender ALERT: ${staff_name} dropped ${client_name} ${event_date_short} (${hours_to_event}h out). Reason: ${reason}`;
  }
  ```

  Keep within 160 chars where possible. Long reasons get truncated to fit.

- [ ] **Step 2: Test that compiled output fits within the SMS character budget** (existing tests already do this for other templates).

- [ ] **Step 3: Commit**

  ```bash
  git add server/utils/smsTemplates.js server/utils/smsTemplates.test.js
  git commit -m "feat(staff-portal): cover-broadcast + drop-to-management SMS templates"
  ```

---

### Task 14: staffShiftHandlers cover-broadcast scheduling helper

**Spec ref:** §6.5 (Drop / Cover flow), §6.13 (multi-row enqueue).

**Files:**
- Modify: `server/utils/staffShiftHandlers.js`
- Modify: `server/utils/staffShiftHandlers.test.js`

- [ ] **Step 1: Add `broadcastCoverRequest(shiftId, requestingUserId)` helper**

  Steps inside:
  1. Look up the shift's role + event_date, client_name, proposal_id.
  2. Query qualified teammates: users with matching role + `onboarding_status='approved'`, NOT the requesting user, who have `cover_needed` in their `staff_notification_preferences.channels` for at least one channel.
  3. Chunk teammates into batches of 50 (Twilio rate-limit guard).
  4. For each teammate, call `enqueueCategorizedMessage` with category `'cover_needed'`, payload containing the SMS template fields + push title/body/url.
  5. Wrap the per-chunk loop in `await sleep(1000)` between chunks for additional backoff.

  ```javascript
  const { enqueueCategorizedMessage } = require('./scheduledMessages');

  async function broadcastCoverRequest(shiftId, requestingUserId, client = pool) {
    const { rows: shiftRows } = await client.query(`
      SELECT s.id AS shift_id, s.position, s.event_date,
             p.client_name, p.id AS proposal_id
        FROM shifts s
        LEFT JOIN proposals p ON p.id = s.proposal_id
       WHERE s.id = $1
    `, [shiftId]);
    if (shiftRows.length === 0) return [];
    const shift = shiftRows[0];

    const { rows: requesterRows } = await client.query(
      `SELECT preferred_name FROM contractor_profiles WHERE user_id = $1`, [requestingUserId]
    );
    const requesterFirstInitial = (requesterRows[0]?.preferred_name || '').trim()[0]?.toUpperCase() || '?';

    const { rows: teammates } = await client.query(`
      SELECT u.id
        FROM users u
        WHERE u.onboarding_status = 'approved'
          AND u.id <> $1
          AND (u.staff_notification_preferences->'channels'->'cover_needed') @> '["push"]'::jsonb
          AND EXISTS (
            SELECT 1 FROM contractor_profiles cp
             WHERE cp.user_id = u.id
               AND COALESCE(cp.role_filter, 'bartender') = $2
          )
    `, [requestingUserId, shift.position || 'bartender']);

    const ids = teammates.map(r => r.id);
    const CHUNK = 50;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      await Promise.all(chunk.map(uid => enqueueCategorizedMessage({
        userId: uid,
        category: 'cover_needed',
        payload: {
          title: 'Cover needed',
          body:  `${requesterFirstInitial}. needs a cover on ${formatShortDate(shift.event_date)}`,
          url:   `https://staff.drbartender.com/shifts/${shift.shift_id}`,
          sms_template: 'cover_broadcast_sms',
          sms_args: { first_initial_last_initial: requesterFirstInitial + '.', client_name: shift.client_name, event_date_short: formatShortDate(shift.event_date), shift_role: shift.position || 'bartender', shift_url: `https://staff.drbartender.com/shifts/${shift.shift_id}` },
        },
        sendAt: new Date(),
        anchorEntityType: 'shift_request',
        anchorEntityId: shift.shift_id,
        suppressionKey: `cover_broadcast:${shift.shift_id}:${uid}`,
      }, client)));
      if (i + CHUNK < ids.length) await new Promise(r => setTimeout(r, 1000));
    }
    return ids;
  }

  module.exports.broadcastCoverRequest = broadcastCoverRequest;
  ```

  Verify the role-filter column name against `contractor_profiles` actual schema; adjust the WHERE clause to match.

- [ ] **Step 2: Tests**: broadcasts to qualified teammates only, excludes requester, chunks at 50, skips opt-out teammates.

- [ ] **Step 3: Commit**

  ```bash
  git add server/utils/staffShiftHandlers.js server/utils/staffShiftHandlers.test.js
  git commit -m "feat(staff-portal): cover-broadcast scheduling helper with rate-limit chunking"
  ```

---

### Task 15: POST /api/shifts/requests/:id/drop (clean drop)

**Spec ref:** §3.3 (clean drop ≥14d, 336h).

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/routes/shifts.test.js`

- [ ] **Step 1: Read the existing shift_request mutation routes**

  Find existing patterns for shift-request lifecycle (deny, withdraw, etc.). The drop route mirrors them.

- [ ] **Step 2: Implement the route**

  ```javascript
  router.post('/requests/:id/drop', asyncHandler(async (req, res) => {
    const requestId = parseInt(req.params.id, 10);
    if (!requestId) throw new ValidationError({ id: 'Invalid request id.' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        SELECT sr.id, sr.user_id, sr.shift_id, sr.status,
               s.event_date, s.event_start_time,
               p.id AS proposal_id, p.client_name,
               pp.id AS pay_period_id, pp.status AS pay_period_status
          FROM shift_requests sr
          JOIN shifts s ON s.id = sr.shift_id
          LEFT JOIN proposals p ON p.id = s.proposal_id
          LEFT JOIN payout_events pe ON pe.shift_id = s.id
          LEFT JOIN payouts po ON po.id = pe.payout_id
          LEFT JOIN pay_periods pp ON pp.id = po.pay_period_id
         WHERE sr.id = $1 FOR UPDATE
      `, [requestId]);
      if (rows.length === 0) throw new NotFoundError('Request not found.');
      const sr = rows[0];
      if (sr.user_id !== req.user.id) throw new PermissionError('Not your request.');
      if (sr.status !== 'approved') throw new ConflictError('Only approved shifts can be dropped.');

      // 14-day boundary (336 hours)
      const eventDateTime = new Date(`${sr.event_date}T${sr.event_start_time || '00:00:00'}`);
      const hoursToEvent = (eventDateTime - Date.now()) / 3_600_000;
      if (hoursToEvent < 336) {
        throw new ConflictError('Use request-cover (<14d) or emergency-drop (<72h) instead.');
      }
      if (sr.pay_period_status === 'processing') {
        throw new ConflictError('Pay period is processing; cannot drop now. Contact management.');
      }

      // Mark the request as dropped
      await client.query(
        `UPDATE shift_requests
            SET status = 'denied', dropped_at = NOW(), drop_emergency = false
          WHERE id = $1`,
        [requestId]
      );

      // Email management
      // (use existing notifyAdminCategory or sendEmail helper; defer the SMS branch here since clean drops are email-only)
      await notifyManagementOfDrop({ kind: 'clean', requestId, userId: req.user.id, shiftId: sr.shift_id, clientName: sr.client_name });

      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }));
  ```

  `notifyManagementOfDrop` is a small private helper that calls `notifyAdminCategory('urgent_staffing', ...)` with kind-specific copy.

- [ ] **Step 3: Tests**: 14d+1h succeeds; 13d 23h returns 409; pay_period 'processing' returns 409; non-approved status returns 409; IDOR returns 403.

- [ ] **Step 4: Commit**

  ```bash
  git add server/routes/shifts.js server/routes/shifts.test.js
  git commit -m "feat(staff-portal): POST /api/shifts/requests/:id/drop (clean drop ≥14d)"
  ```

---

### Task 16: POST /api/shifts/requests/:id/request-cover

**Spec ref:** §3.3 (72h to <14d cover broadcast), §6.5.

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/routes/shifts.test.js`

- [ ] **Step 1: Implement the route**

  Same pre-checks as drop (request ownership, status='approved', pay_period not 'processing'). Boundary: `72 <= hoursToEvent < 336`. Sets `cover_requested_at = NOW()`, `cover_reason = body.reason` (optional, defaults to null). Calls `broadcastCoverRequest(shift_id, user_id)`. Original `status` stays `'approved'`. Email management always; SMS management if `hoursToEvent <= 168` (7d).

- [ ] **Step 2: Tests**: 72h+1h triggers broadcast, 13d 23h triggers, 14d+1h returns 409 (use drop), <72h returns 409 (use emergency), 7d-1h SMS to management, 7d+1h email-only.

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/shifts.js server/routes/shifts.test.js
  git commit -m "feat(staff-portal): POST /api/shifts/requests/:id/request-cover with broadcast"
  ```

---

### Task 17: POST /api/shifts/requests/:shiftId/claim-cover

**Spec ref:** §6.3 (Available sub-tab cover claim), §6.5.

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/routes/shifts.test.js`

- [ ] **Step 1: Implement the route**

  Pre-checks: shift exists, `cover_requested_at IS NOT NULL` on at least one of its `shift_requests`, the claiming user is NOT the cover-requesting user, doesn't already have an approved request on the same shift. Creates a new `shift_requests` row with `status='pending'`, `replaced_by_request_id` set to the original requester's request id (so management's one-click approve can flip both states atomically).

- [ ] **Step 2: Tests**: successful claim creates pending row; double-claim is rejected; claiming your own cover is rejected.

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/shifts.js server/routes/shifts.test.js
  git commit -m "feat(staff-portal): POST /api/shifts/requests/:shiftId/claim-cover"
  ```

---

### Task 18: POST /api/shifts/requests/:id/emergency-drop

**Spec ref:** §3.3 (<72h emergency), §6.5.

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/routes/shifts.test.js`

- [ ] **Step 1: Implement the route**

  Pre-checks: ownership, status='approved'. Boundary: `hoursToEvent < 72`. Requires `body.reason` (min 10 chars). Sets `dropped_at = NOW()`, `drop_emergency = true`, `drop_reason = body.reason`. Status stays `'approved'` (the staffer remains on the roster; management resolves manually). Notifies management by email AND SMS (uses `staff_drop_to_management_sms` template + `ADMIN_PHONE`).

  Critical: this endpoint does NOT broadcast to teammates. Emergency drops are management-handled, not crowd-sourced.

- [ ] **Step 2: Tests**: reason <10 chars returns 400; 72h+1h returns 409; 71h 59m succeeds and sends SMS+email; ADMIN_PHONE unset skips SMS but does NOT fail.

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/shifts.js server/routes/shifts.test.js
  git commit -m "feat(staff-portal): POST /api/shifts/requests/:id/emergency-drop"
  ```

---

### Task 19: Existing shifts endpoint projections + tests

**Spec ref:** §6.3 (Available / Mine / Past).

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/routes/shifts.test.js`

- [ ] **Step 1: Extend `GET /api/shifts` (staff path) projection**

  Add: `drink_plan_finalized_at`, `my_beo_acknowledged_at` (LEFT JOIN on the requesting user's own `shift_request`), `cover_requested_at`, `cover_for_first_initial` (computed via JOIN to `contractor_profiles` for the cover-requesting user's first name).

- [ ] **Step 2: Extend `GET /api/shifts/user/:userId/events`**

  Add `payout_id` per past shift_request (computed via LEFT JOIN to `payout_events.shift_id` then `payouts.id`). Verify `req.user.id === userId` (IDOR guard).

- [ ] **Step 3: Tests**: verify the new projections appear in the response shape.

- [ ] **Step 4: Commit**

  ```bash
  git add server/routes/shifts.js server/routes/shifts.test.js
  git commit -m "feat(staff-portal): extend shifts endpoint projections for new portal pages"
  ```

---

## Phase 5: Client shell + theme

### Task 20: Port skin-aware CSS tokens to index.css

**Spec ref:** §6.16 (Theme persistence).

**Files:**
- Modify: `client/src/index.css`

- [ ] **Step 1: Read `Downloads/Dr Bartender (6)/staff/styles.css`**

  This is the design source. Extract the `:root`, `[data-skin="light"]`, `[data-skin="dark"]` token blocks. Look for variable names like `--ink-1`, `--surface-1`, `--accent`, `--accent-h`, etc.

- [ ] **Step 2: Append the tokens to `client/src/index.css`**

  Namespace under a comment block:

  ```css
  /* ─── Staff portal: skin-aware tokens ─── */
  :root { /* defaults */ }
  [data-skin="light"] { /* light variant */ }
  [data-skin="dark"]  { /* dark variant */ }
  ```

  Avoid overwriting any existing `:root` variables. If a name collision exists, prefix the new ones with `--sp-` (staff portal) to scope cleanly.

- [ ] **Step 3: Visual check**

  Start the dev server (already running per CLAUDE.md). Add `<html data-skin="dark">` manually in the browser dev tools on any existing staff page. Confirm the new tokens resolve (use Computed pane on a CSS variable like `--sp-surface-1`).

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/index.css
  git commit -m "feat(staff-portal): port skin-aware design tokens into index.css"
  ```

---

### Task 21: StaffShell.js + StaffUserPillMenu.js

**Spec ref:** §6.1 (New shell + routes).

**Files:**
- Create: `client/src/components/StaffShell.js`
- Create: `client/src/components/StaffUserPillMenu.js`

- [ ] **Step 1: Implement `StaffShell`**

  Props: `tabs`, `active`, `onTabChange`, `badges`, `user`, `userMenu`, `skin`, `onSkinChange`, `children`.

  Layout:
  - `<header>` with brand mark left, user pill right (clicking opens StaffUserPillMenu)
  - `<nav>` tab bar (4 tabs from `tabs` prop, with badge dots from `badges`)
  - `<main>` children
  - Sets `document.documentElement.dataset.skin = skin` on every render (or via useEffect on skin change)

  Use vanilla CSS classes; no styled-components.

- [ ] **Step 2: Implement `StaffUserPillMenu`**

  Modal with scrim. Contents per spec §6.1: avatar + name + email card, "Lighting" segmented control (House lights / After hours), 5 menu items (Edit profile, Calendar sync, Notification preferences, Get support, Sign out).

  Lighting control wires to the `onSkinChange` callback. The 5 menu items dispatch `onClick` per item provided in the `userMenu` prop.

- [ ] **Step 3: Test render in isolation**

  Add a temporary mount in `client/src/pages/staff/StaffDashboard.js` (still extant in Phase 5) just to visually verify the new shell renders + the menu opens/closes. Revert that change before committing (or leave a `// TEMP-DEV` comment and remove in Task 39).

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/components/StaffShell.js client/src/components/StaffUserPillMenu.js
  git commit -m "feat(staff-portal): StaffShell + UserPillMenu (no theme persistence yet)"
  ```

---

### Task 22: Theme persistence wire-up

**Spec ref:** §6.16 (Theme persistence).

**Files:**
- Modify: `client/src/components/StaffShell.js`
- Modify: `client/src/utils/api.js` (if a new helper is needed)

- [ ] **Step 1: Hydrate the skin from `users.ui_preferences.theme`**

  On mount, fetch `GET /api/me` (already returns `ui_preferences` per spec §8.2). Extract `ui_preferences.theme`. If null, fall back to `window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'`. Set `data-skin` on `documentElement` immediately.

- [ ] **Step 2: Persist on toggle**

  The Lighting segmented control's `onChange` calls `api.patch('/me/ui-preferences', { theme: nextSkin })` AND updates `document.documentElement.dataset.skin` immediately (optimistic). On API error, revert.

- [ ] **Step 3: Cross-device sync verification**

  - Sign in on browser A, set theme to dark
  - Sign in on browser B, confirm the page loads in dark
  - Toggle to light on browser B
  - Reload browser A, confirm it loads in light

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/components/StaffShell.js
  git commit -m "feat(staff-portal): theme persistence via PATCH /api/me/ui-preferences"
  ```

---

## Phase 6: Shifts surface

### Task 23: ShiftCard.js (shared)

**Spec ref:** §6.2 (HomePage), §6.3 (ShiftsPage).

**Files:**
- Create: `client/src/components/staff/ShiftCard.js`

- [ ] **Step 1: Implement the card**

  Props: `shift`, `showConfirmFlag`, `onClick`, `variant` ('default' | 'pending' | 'past' | 'cover-needed').

  Renders: date, relative day, client name, event type, location, time range, position chips, pay estimate chip, conflict warning, cover-needed banner (when applicable), confirm-needed flag.

  Uses the `getEventTypeLabel(...)` util from `client/src/utils/eventTypes.js` (CLAUDE.md requires this).

- [ ] **Step 2: Smoke render**

  Mount in a Storybook-like ad-hoc file or directly in a test page (revert before commit). Confirm all 4 variants render.

- [ ] **Step 3: Commit**

  ```bash
  git add client/src/components/staff/ShiftCard.js
  git commit -m "feat(staff-portal): shared ShiftCard component"
  ```

---

### Task 24: HomePage.js

**Spec ref:** §6.2.

**Files:**
- Create: `client/src/pages/staff/HomePage.js`

- [ ] **Step 1: Implement the page**

  Calls `api.get('/me/staff-home')` on mount. Renders sections in order: Hero, "Needs you" tray (conditional), Next shift card (ShiftCard), This pay period tile, Open shifts teaser.

  Re-fetches on tab focus (`document.addEventListener('visibilitychange', ...)`).

- [ ] **Step 2: Loading + empty + error states**

  Standard pattern from CLAUDE.md ("Async ops have loading, error, and empty states").

- [ ] **Step 3: Verify in-browser** (dev server)

  Sign in as a test staffer with one upcoming shift, one pending request, one teammate cover broadcast. Confirm all 4 sections render.

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/pages/staff/HomePage.js
  git commit -m "feat(staff-portal): HomePage with staff-home composite data"
  ```

---

### Task 25: ShiftsPage.js with Available / Mine / Past sub-tabs

**Spec ref:** §6.3.

**Files:**
- Create: `client/src/pages/staff/ShiftsPage.js`

- [ ] **Step 1: Sub-tab routing**

  URL-driven via `/shifts/available`, `/shifts/mine`, `/shifts/past`. Default `/shifts` redirects to `/shifts/available`. Use React Router's `useParams` or `useLocation`.

- [ ] **Step 2: Available sub-tab**

  Fetches `GET /api/shifts` (staff path, which excludes shifts the user is already approved on). Sorts chronologically. Renders ShiftCard per row. Cover-needed rows get the accent border + "Cover needed" chip + banner.

  Request button calls `POST /api/shifts/requests` (existing endpoint) OR `POST /api/shifts/requests/:shiftId/claim-cover` if the shift has `cover_requested_at`.

- [ ] **Step 3: Mine sub-tab**

  Fetches `GET /api/shifts/user/:userId/events`. Renders pending requests first (faded), then approved chronologically.

- [ ] **Step 4: Past sub-tab**

  Same endpoint, filtered to completed shifts in reverse-chronological order. Click on card navigates to `/pay/:periodId?shift=:shiftId`.

- [ ] **Step 5: Commit**

  ```bash
  git add client/src/pages/staff/ShiftsPage.js
  git commit -m "feat(staff-portal): ShiftsPage with Available/Mine/Past sub-tabs"
  ```

---

### Task 26: Extended GET /api/beo/:proposalId projection (team_roster)

**Spec ref:** §6.18 (Team roster on GET BEO).

**Files:**
- Modify: `server/routes/beo.js`
- Modify: `server/routes/beo.test.js`

- [ ] **Step 1: Add the team_roster array to the response**

  After the BEO core projection, add a query for every approved shift_request on the proposal's shifts. LEFT JOIN to `contractor_profiles` (for `preferred_name`, `phone`) and to `applications` via `users.id = applications.user_id` (for `full_name` fallback).

  Compose per spec §6.18: `user_id`, `display_name` (server-side computed), `initials`, `is_me`, `role` (default 'Bartender'), `phone`, `needs_cover`.

  ```javascript
  const { rows: rosterRows } = await pool.query(`
    SELECT sr.user_id,
           sr.position AS role,
           sr.cover_requested_at,
           cp.preferred_name,
           cp.phone,
           a.full_name AS legal_name,
           u.email
      FROM shift_requests sr
      JOIN shifts s ON s.id = sr.shift_id
      LEFT JOIN users u ON u.id = sr.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      LEFT JOIN applications a ON a.user_id = sr.user_id
     WHERE s.proposal_id = $1
       AND sr.status = 'approved'
       AND s.canceled_at IS NULL
     ORDER BY sr.id
  `, [proposalId]);

  function computeName(row) {
    const fromPreferred = (row.preferred_name || '').trim();
    if (fromPreferred) {
      const lastInitial = (row.legal_name || '').trim().split(' ').pop()?.[0]?.toUpperCase() || '';
      return lastInitial ? `${fromPreferred} ${lastInitial}.` : fromPreferred;
    }
    const legal = (row.legal_name || '').trim();
    if (legal) {
      const parts = legal.split(/\s+/);
      const first = parts[0];
      const last = parts[parts.length - 1];
      return parts.length >= 2 ? `${first} ${last[0].toUpperCase()}.` : first;
    }
    return (row.email || 'staff').split('@')[0];
  }
  function computeInitials(displayName) {
    const m = displayName.match(/(\S)\S*\s+(\S)/);
    if (m) return (m[1] + m[2]).toUpperCase();
    return displayName.slice(0, 2).toUpperCase();
  }

  const team_roster = rosterRows.map(row => {
    const display_name = computeName(row);
    return {
      user_id: row.user_id,
      display_name,
      initials: computeInitials(display_name),
      is_me: row.user_id === req.user.id,
      role: row.role || 'Bartender',
      phone: row.phone || null,
      needs_cover: row.cover_requested_at != null,
    };
  });

  // Add team_roster to the existing response object
  ```

- [ ] **Step 2: Tests**

  - Renders display_name from preferred_name + legal last-initial
  - Falls back to legal full_name first-token + last-initial when preferred is empty
  - Falls back to email-local-part when both are empty
  - `is_me` flips for the requesting user's row only
  - Sorted by shift_request.id (stable)

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/beo.js server/routes/beo.test.js
  git commit -m "feat(staff-portal): add team_roster to GET /api/beo response"
  ```

---

### Task 27: TeamRosterCard.js

**Spec ref:** §6.4 (ShiftDetail page, "Team roster card" bullet).

**Files:**
- Create: `client/src/components/staff/TeamRosterCard.js`

- [ ] **Step 1: Render the roster**

  Props: `team_roster` array, `viewerUserId`. Renders only when length > 0.

  Per row: avatar (initials), display_name, role label (when set), needs-cover indicator, "You" pill on own row (no role/contact actions), call/text icon buttons on others' rows that open `tel:` / `sms:` deep links.

- [ ] **Step 2: Commit**

  ```bash
  git add client/src/components/staff/TeamRosterCard.js
  git commit -m "feat(staff-portal): TeamRosterCard component"
  ```

---

### Task 28: ShiftDetail.js

**Spec ref:** §6.4 (ShiftDetail page).

**Files:**
- Create: `client/src/pages/staff/ShiftDetail.js`

- [ ] **Step 1: Implement the page**

  Calls `api.get('/beo/:proposalId')` to fetch the BEO + team_roster. The proposalId comes from the shift (`shifts.proposal_id`), so this page first fetches the shift, then the BEO.

  Sections per spec §6.4: back button, title, quick-status chips, key info grid, action row, "Banquet Event Order" heading, TeamRosterCard, drinks card, addons, logistics, custom menu, notes, consult input, shopping list link, Drop/Cover card, sticky Confirm action bar.

  Confirm action bar calls `POST /api/beo/:proposalId/acknowledge` (existing per BEO plan Task 17).

- [ ] **Step 2: Drop/Cover card placeholder**

  In this task, just render a stub card "Drop or request cover →" that opens DropCoverModal (built in Task 29). The card's mode (clean drop / cover broadcast / emergency) is computed from time-to-event in hours.

- [ ] **Step 3: Verify in browser**: the BEO content from the existing BEO endpoint renders correctly; team roster renders with the viewer's "You" pill.

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/pages/staff/ShiftDetail.js
  git commit -m "feat(staff-portal): ShiftDetail page (BEO viewer + team roster)"
  ```

---

### Task 29: DropCoverModal.js + 3 mode variants

**Spec ref:** §6.5 (Drop / Cover flow).

**Files:**
- Create: `client/src/components/staff/DropCoverModal.js`

- [ ] **Step 1: Mode resolution**

  Single component accepting `shift`, `onClose`, `onSuccess`. Computes `hoursToEvent = (eventStart - Date.now()) / 3_600_000`.

  Three modes:
  - `>= 336`: Clean drop. Modal copy: "Drop this shift?" + sub: "It returns to the open pool. Management is notified."
  - `72 <= h < 336`: Cover request. Modal copy: "Request a cover" + sub explaining the broadcast.
  - `< 72`: Emergency. Modal copy: "Emergency drop" + reason textarea (min 10 chars). Footer: "Management is alerted immediately."

  All three modes use "management" terminology, NOT "lead".

- [ ] **Step 2: Submit handlers**

  - Clean: `POST /api/shifts/requests/:id/drop`
  - Cover: `POST /api/shifts/requests/:id/request-cover`
  - Emergency: `POST /api/shifts/requests/:id/emergency-drop` with `{ reason }`

  Each on success calls `onSuccess()` which closes the modal and re-fetches the parent ShiftDetail page (or navigates back to Shifts/Mine for clean drop).

- [ ] **Step 3: Verify all three modes** in browser:
  - Clean drop on a shift 20 days out
  - Cover request on a shift 10 days out
  - Emergency drop on a shift 48 hours out (with reason)

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/components/staff/DropCoverModal.js
  git commit -m "feat(staff-portal): DropCoverModal with 3 time-based modes"
  ```

---

## Phase 7: Pay + Tip Card surfaces

### Task 30: PayoutEventRow.js + PayoutDetail.js

**Spec ref:** §6.7 (PayoutDetail page).

**Files:**
- Create: `client/src/components/staff/PayoutEventRow.js`
- Create: `client/src/pages/staff/PayoutDetail.js`

- [ ] **Step 1: PayoutEventRow**

  Renders one row per `payout_event` (one shift = one line). Shows: date, client, role, hours, base cents, gratuity cents, card-tip-net cents, late-tip-roll cents (if any), total cents in mono. Highlight border when the row's `shift_id` matches the `?shift=` URL query param.

- [ ] **Step 2: PayoutDetail**

  Fetches `GET /api/payouts/:periodId` (existing staff-payments endpoint). Sections: header (period dates, payday, total, status chip), event-rows list, adjustments (refunds / clawbacks if any), mark-paid action (admin only, hidden for staff).

  Reads `?shift=` from URL; auto-scrolls to the matching row on mount.

- [ ] **Step 3: Verify**: open `/pay/:periodId?shift=X` and confirm the matching row is highlighted + scrolled into view.

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/components/staff/PayoutEventRow.js client/src/pages/staff/PayoutDetail.js
  git commit -m "feat(staff-portal): PayoutDetail page with cross-link highlight"
  ```

---

### Task 31: PayPage.js

**Spec ref:** §6.6.

**Files:**
- Create: `client/src/pages/staff/PayPage.js`

- [ ] **Step 1: Implement the page**

  Fetches the list of payouts for the user (existing endpoint). Renders: hero "Pay" + sub-line, current period tile at top (large), past payouts list (one card per period: dates, total, status chip).

  Click on a card navigates to `/pay/:periodId`.

- [ ] **Step 2: Commit**

  ```bash
  git add client/src/pages/staff/PayPage.js
  git commit -m "feat(staff-portal): PayPage with current-period highlight + history"
  ```

---

### Task 32: TipCardPage.js

**Spec ref:** §6.8 (TipCardPage).

**Files:**
- Create: `client/src/pages/staff/TipCardPage.js`

- [ ] **Step 1: Layout**

  Hero "Tip Card" + sub-line. QR card preview (reuse existing FakeQR-style component from MyTipPage if practical; otherwise re-implement). Action buttons: Open print page, Share link, Copy URL.

  "Tips received this week" card from existing endpoint data.

  "How it's shown on your card" reorder card with drag-grip + up/down arrows.

- [ ] **Step 2: Drag-to-reorder**

  Use `react-dnd` if already in stack; otherwise a minimal HTML5 drag-and-drop wrapper. On every reorder (drag-end OR arrow-tap), PUT `/api/me/tip-card-order` with the new order array. Optimistic update with rollback on error.

- [ ] **Step 3: "Manage methods →" link**

  Routes to `/account/payments`.

- [ ] **Step 4: Verify**: drag to reorder, reload page, confirm new order persists. Open public `/tip/:token` page, confirm chooser order matches.

- [ ] **Step 5: Commit**

  ```bash
  git add client/src/pages/staff/TipCardPage.js
  git commit -m "feat(staff-portal): TipCardPage with drag-to-reorder"
  ```

---

## Phase 8: AccountPage

### Task 33: AccountPage shell + nav

**Spec ref:** §6.9 (AccountPage shell).

**Files:**
- Create: `client/src/pages/staff/account/AccountPage.js`

- [ ] **Step 1: Implement the shell**

  Horizontal scrolling tab bar (`sp-acc-nav` class from design) with 5 tabs: Profile, Payments, Calendar, Notifications, Documents. URL-driven (`/account/profile`, etc.).

  Mounts the corresponding sub-section component below.

- [ ] **Step 2: Back button**

  Top-left back arrow returns to the previously-active main tab (Home / Shifts / Pay / Tip Card), per the `view.section` state from the design's app.jsx pattern.

- [ ] **Step 3: Commit**

  ```bash
  git add client/src/pages/staff/account/AccountPage.js
  git commit -m "feat(staff-portal): AccountPage shell with horizontal sub-nav"
  ```

---

### Task 34: ProfileSection.js

**Spec ref:** §6.10 (AccountPage / Profile).

**Files:**
- Create: `client/src/pages/staff/account/ProfileSection.js`

- [ ] **Step 1: Implement the section**

  Form fields: preferred_name, phone, email, mailing address (4 sub-fields: street, city, state, zip), emergency contact (name, phone, relationship).

  Loads via `GET /api/me` (the existing route returns `contractor_profiles` already).

  Saves via `PATCH /api/me/profile` (Task 9).

  Submit is debounced 600ms after edit, or explicit Save button. Pick whichever feels right per the design (likely Save button to match other admin patterns).

- [ ] **Step 2: Validation**

  Phone: E.164 format (existing util). Email: standard regex. ZIP: 5 or 5+4 digits.

- [ ] **Step 3: Commit**

  ```bash
  git add client/src/pages/staff/account/ProfileSection.js
  git commit -m "feat(staff-portal): ProfileSection with composite address + emergency contact"
  ```

---

### Task 35: PaymentMethodsSection.js + AddMethodModal.js

**Spec ref:** §6.11.

**Files:**
- Create: `client/src/pages/staff/account/PaymentMethodsSection.js`
- Create: `client/src/pages/staff/account/AddMethodModal.js`

- [ ] **Step 1: PaymentMethodsSection top pill**

  "Payroll routes to: [icon] [label] · [identifier]" pulled from `GET /api/me/payment-methods` (`preferred` + the corresponding method's handle).

- [ ] **Step 2: Methods on file list**

  One row per method. Card row always rendered, "Always on" chip, non-editable. Each editable row: pencil edit (inline → PATCH on save), X remove (sets handle to null via PATCH), Set as preferred (PUT /preferred-payment-method, button hidden on payroll-ineligible Card row).

- [ ] **Step 3: AddMethodModal**

  Picker for a method category (Tip-eligible / Payroll-only) → method (Venmo, Cash App, PayPal, Zelle, Direct deposit, Check) → input form.

  For Venmo / Cash App / PayPal / Zelle: single handle input. For Direct deposit: routing + account inputs (masked on display after save; never re-shown in plaintext). For Check: no input, just confirm.

  On save, PATCH the corresponding column. The modal closes; the row appears with the new handle (or, for Check, just renders).

- [ ] **Step 4: Footer disclaimer** (italic, per spec).

- [ ] **Step 5: Verify**: add Venmo, set as preferred for payroll, clear it, confirm `preferred_payment_method` auto-flips to NULL (the top pill should now read "No payroll method set").

- [ ] **Step 6: Commit**

  ```bash
  git add client/src/pages/staff/account/PaymentMethodsSection.js \
          client/src/pages/staff/account/AddMethodModal.js
  git commit -m "feat(staff-portal): PaymentMethodsSection + AddMethodModal"
  ```

---

### Task 36: CalendarSyncSection.js

**Spec ref:** §6.12.

**Files:**
- Create: `client/src/pages/staff/account/CalendarSyncSection.js`

- [ ] **Step 1: Subscribe buttons**

  Three buttons composing deep links against the existing feed URL: `${API_URL}/api/calendar/feed/${calendarToken}`.

  Read `users.calendar_token` via `GET /api/me` (extend that response if needed; Task 41 wraps the contract update).

- [ ] **Step 2: Subscription URL block + Copy button**

  Read-only URL display + Copy button. Copied state toggle (1.8s).

- [ ] **Step 3: Last sync sub-section**

  Reads `users.last_ics_fetch_at` and `users.ui_preferences.calendar_subscribed_app` from `GET /api/me`. Renders "Last synced from [App], [X minutes/hours ago]" + Disconnect button (clears `calendar_subscribed_app` via PATCH /api/me/ui-preferences).

- [ ] **Step 4: Regenerate URL action**

  Calls `POST /api/calendar/regenerate-token` (existing). Shows confirm dialog before firing: "Previously-subscribed apps will stop syncing. Proceed?"

- [ ] **Step 5: Verify**: subscribe to the feed in Apple Calendar, confirm shifts appear; toggle an unconfirmed BEO and confirm the all-day VEVENT appears 3 days before.

- [ ] **Step 6: Commit**

  ```bash
  git add client/src/pages/staff/account/CalendarSyncSection.js
  git commit -m "feat(staff-portal): CalendarSyncSection (subscribe/copy/last-sync/regenerate)"
  ```

---

### Task 37: NotificationsSection.js (Phase A: Push gated off)

**Spec ref:** §6.13.

**Files:**
- Create: `client/src/pages/staff/account/NotificationsSection.js`
- Create: `client/src/pages/staff/account/IOSCoachmark.js` (stub for Phase A; full implementation in Task 44)

- [ ] **Step 1: 8×3 matrix render**

  Rows per the spec §6.13 table (shift_offered, shift_decided, cover_needed, beo_finalized, beo_reminder_t3, schedule_change, payday, tip_received). Columns: SMS, Email, Push.

  Each cell is a toggle. Pulls state from `GET /api/me/staff-notifications`.

- [ ] **Step 2: Push column gated off in Phase A**

  Render the Push column toggles as disabled with a tooltip / banner: "Push notifications launch in v1.5". This makes the matrix UI ship in Phase A but the cells don't write to the API.

- [ ] **Step 3: SMS + Email toggles work**

  Toggling a cell PATCHes `/api/me/staff-notifications` with `{ channels: { [category]: [...new channel set] } }`. Optimistic update.

- [ ] **Step 4: Critical-path footer**

  Static text per §6.13: "Critical-path messages. BEO finalized, schedule changes, payday, can't be fully muted..."

- [ ] **Step 5: Verify**: toggle SMS off for `shift_offered`, confirm the next test shift_offered SMS does NOT send.

- [ ] **Step 6: Commit**

  ```bash
  git add client/src/pages/staff/account/NotificationsSection.js \
          client/src/pages/staff/account/IOSCoachmark.js
  git commit -m "feat(staff-portal): NotificationsSection (Phase A: Push column gated)"
  ```

---

### Task 38: DocumentsSection.js + ReplaceConfirmModal.js

**Spec ref:** §6.14.

**Files:**
- Create: `client/src/pages/staff/account/DocumentsSection.js`
- Create: `client/src/pages/staff/account/ReplaceConfirmModal.js`

- [ ] **Step 1: Reference section**

  Field Guide row linking to `/field-guide` (existing route).

- [ ] **Step 2: My documents section**

  W-9 row, Independent Contractor Agreement row (no replace), Alcohol certification row (with expiry treatment).

  Expiry treatment for alcohol cert: read `contractor_profiles.alcohol_certification_expires_on`. Within 60 days → amber "Expires soon" tag + nudge sub-line. Past date → red "Expired" tag.

- [ ] **Step 3: Replace flow**

  Pencil icon opens ReplaceConfirmModal. Modal: title, sub, file picker, Cancel / Replace buttons. On Replace, multipart POST to `/api/me/documents/:doc_type/replace`. Show success state with "Replaced" chip on the row.

- [ ] **Step 4: Other archives section**

  "Paystubs (N)" row that navigates to `/pay`.

- [ ] **Step 5: Verify**: replace W-9 with a PDF, confirm the active record updates AND `staff_document_history` has the snapshot. Repeat for alcohol cert.

- [ ] **Step 6: Commit**

  ```bash
  git add client/src/pages/staff/account/DocumentsSection.js \
          client/src/pages/staff/account/ReplaceConfirmModal.js
  git commit -m "feat(staff-portal): DocumentsSection with W-9 and alcohol-cert replace"
  ```

---

## Phase 9: Wire-up + cleanup + docs

### Task 39: App.js mount swap (HiringRoutes + StaffSiteRoutes) + redirects

**Spec ref:** §6.1, §8.4.

**Files:**
- Modify: `client/src/App.js`

- [ ] **Step 1: Replace `<StaffLayout/>` with `<StaffShell/>` in both blocks**

  - `HiringRoutes()` around line 271: `<Route element={<RequirePortal><StaffShell/></RequirePortal>}>`
  - `StaffSiteRoutes()` around line 314: same swap.

  StaffShell needs the `tabs`, `user`, `userMenu`, `skin`, `onSkinChange`, `badges` props it expects. Wrap in an outer component that hydrates from `GET /api/me`.

- [ ] **Step 2: Replace the per-page Routes**

  Inside each block, replace the existing child Routes with the new mount table from spec §6.1:

  ```jsx
  <Route path="/" element={<HomePage/>} />
  <Route path="/shifts" element={<Navigate to="/shifts/available" replace/>} />
  <Route path="/shifts/available" element={<ShiftsPage subTab="available"/>} />
  <Route path="/shifts/mine"      element={<ShiftsPage subTab="mine"/>} />
  <Route path="/shifts/past"      element={<ShiftsPage subTab="past"/>} />
  <Route path="/shifts/:shiftId"  element={<ShiftDetail/>} />
  <Route path="/pay"              element={<PayPage/>} />
  <Route path="/pay/:periodId"    element={<PayoutDetail/>} />
  <Route path="/tip-card"         element={<TipCardPage/>} />
  <Route path="/account/:section" element={<AccountPage/>} />
  ```

- [ ] **Step 3: Add 30-day redirect Navigates**

  ```jsx
  <Route path="/dashboard" element={<Navigate to="/" replace/>} />
  <Route path="/events"    element={<Navigate to="/shifts/mine" replace/>} />
  <Route path="/schedule"  element={<Navigate to="/shifts/mine" replace/>} />
  <Route path="/profile"   element={<Navigate to="/account/profile" replace/>} />
  <Route path="/resources" element={<Navigate to="/account/documents" replace/>} />
  <Route path="/my-tip-page" element={<Navigate to="/tip-card" replace/>} />
  ```

  Add to BOTH `HiringRoutes()` and `StaffSiteRoutes()`.

- [ ] **Step 4: Imports**

  Add lazy imports for the new components at the top of `App.js`:

  ```javascript
  const StaffShell  = lazy(() => import('./components/StaffShell'));
  const HomePage    = lazy(() => import('./pages/staff/HomePage'));
  const ShiftsPage  = lazy(() => import('./pages/staff/ShiftsPage'));
  const ShiftDetail = lazy(() => import('./pages/staff/ShiftDetail'));
  const PayPage     = lazy(() => import('./pages/staff/PayPage'));
  const PayoutDetail = lazy(() => import('./pages/staff/PayoutDetail'));
  const TipCardPage = lazy(() => import('./pages/staff/TipCardPage'));
  const AccountPage = lazy(() => import('./pages/staff/account/AccountPage'));
  ```

  Keep the existing `StaffLayout` import in place; the next task removes it.

- [ ] **Step 5: Verify the build**

  ```bash
  CI=true npm --prefix client run build
  ```
  Expected: clean build. Any unresolved import = a missing component.

- [ ] **Step 6: Commit**

  ```bash
  git add client/src/App.js
  git commit -m "feat(staff-portal): mount new portal routes in App.js (both subdomain blocks)"
  ```

---

### Task 40: Delete old fragments

**Spec ref:** §6.15.

**Files:**
- Delete: `client/src/pages/staff/StaffDashboard.js`
- Delete: `client/src/pages/staff/StaffEvents.js`
- Delete: `client/src/pages/staff/StaffShifts.js`
- Delete: `client/src/pages/staff/StaffSchedule.js`
- Delete: `client/src/pages/staff/StaffProfile.js`
- Delete: `client/src/pages/staff/StaffResources.js`
- Delete: `client/src/pages/staff/MyTipPage.js`
- Delete: `client/src/pages/staff/MyTipPage.css` (if unused after MyTipPage removal)
- Delete: `client/src/components/StaffLayout.js`
- Modify: `client/src/App.js` (remove the lazy imports for the deleted files)

- [ ] **Step 1: Search for any remaining imports of these files**

  ```bash
  grep -rn "StaffDashboard\|StaffEvents\|StaffShifts\|StaffSchedule\|StaffProfile\|StaffResources\|MyTipPage\|StaffLayout" client/src
  ```

  Expected after this task: only references inside `App.js` (the lazy imports being removed) and no other references.

- [ ] **Step 2: Delete the files**

- [ ] **Step 3: Remove the lazy imports**

  From the top of `App.js`, delete the `const StaffDashboard = lazy(...)` etc. lines for every deleted file.

- [ ] **Step 4: Verify build still passes**

  ```bash
  CI=true npm --prefix client run build
  ```

- [ ] **Step 5: Verify PrintTipCard files remain**

  `PrintTipCard.jsx`, `PrintTipCard.layouts.jsx`, `PrintTipCard.css` are kept; the print flow continues to use them via the TipCardPage's "Open print page" action.

- [ ] **Step 6: Commit**

  ```bash
  git rm client/src/pages/staff/StaffDashboard.js \
         client/src/pages/staff/StaffEvents.js \
         client/src/pages/staff/StaffShifts.js \
         client/src/pages/staff/StaffSchedule.js \
         client/src/pages/staff/StaffProfile.js \
         client/src/pages/staff/StaffResources.js \
         client/src/pages/staff/MyTipPage.js \
         client/src/pages/staff/MyTipPage.css \
         client/src/components/StaffLayout.js
  git add client/src/App.js
  git commit -m "chore(staff-portal): delete old staff portal fragments"
  ```

---

### Task 41: Documentation updates

**Spec ref:** §14 Documentation updates.

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`
- Modify: `CLIENT_FACING_SURFACES.md`

- [ ] **Step 1: README.md folder tree**

  Update the `client/src/pages/staff/` listing: remove the deleted files, add the new ones (HomePage, ShiftsPage, ShiftDetail, PayPage, PayoutDetail, TipCardPage, account/AccountPage, account/*Section files). Update `client/src/components/` and `client/src/components/staff/` sub-trees.

- [ ] **Step 2: README.md Key Features**

  Replace the staff-portal bullet with the new feature description (4 tabs, embedded BEO, drop/cover marketplace, light/dark theme, channel-routed notifications).

- [ ] **Step 3: ARCHITECTURE.md API route table**

  Add rows for every `/api/me/*` endpoint added in Tasks 7-11 and every `/api/shifts/requests/:id/*` endpoint added in Tasks 15-18. Mark the extended `/api/calendar/feed/:token` with the BEO-VEVENT extension. Mark the extended `/api/beo/:proposalId` with the `team_roster` addition.

- [ ] **Step 4: ARCHITECTURE.md Database Schema**

  Add the new columns + table from Task 1. Note the constraint widenings.

- [ ] **Step 5: ARCHITECTURE.md notifications section**

  New sub-section on channel routing: `staff_notification_preferences` shape, kill switch via `communication_preferences`, critical-path override, multi-row enqueue pattern.

- [ ] **Step 6: CLIENT_FACING_SURFACES.md**

  Replace the staff portal section with the new tab structure + AccountPage breakdown.

- [ ] **Step 7: Commit**

  ```bash
  git add README.md ARCHITECTURE.md CLIENT_FACING_SURFACES.md
  git commit -m "docs(staff-portal): folder tree + route table + schema + notifications model"
  ```

---

## Phase 10: Push notifications (Phase B per spec)

### Task 42: VAPID setup + env vars

**Spec ref:** §6.17.

**Files:**
- Modify: `package.json` (server-side, root)
- Modify: `.env.example`
- Modify: `.claude/CLAUDE.md` (Environment Variables table)
- Modify: `README.md` (Environment Variables table)

- [ ] **Step 1: Install web-push**

  ```bash
  npm install web-push
  ```

- [ ] **Step 2: Generate VAPID keys**

  ```bash
  npx web-push generate-vapid-keys
  ```

  Save the public + private keys.

- [ ] **Step 3: Add the three env vars**

  - `VAPID_PUBLIC_KEY` (server-side, also injected into client at build time)
  - `VAPID_PRIVATE_KEY` (server-side only)
  - `REACT_APP_VAPID_PUBLIC_KEY` (client-side, set to the same value as VAPID_PUBLIC_KEY)
  - `VAPID_CONTACT_EMAIL` (server-side, set to `contact@drbartender.com` per CLAUDE.md ADMIN_EMAIL convention)

  Add to `.env.example`, README env table, CLAUDE.md env table.

- [ ] **Step 4: Add the production-side instruction**

  Note in the env table: "Set on Render (server) AND Vercel (client) before merging Phase 10."

- [ ] **Step 5: Commit**

  ```bash
  git add package.json package-lock.json .env.example .claude/CLAUDE.md README.md
  git commit -m "chore(staff-portal): web-push + VAPID env vars for Phase B"
  ```

---

### Task 43: Service worker + pushSubscribe util

**Spec ref:** §6.17.

**Files:**
- Create: `client/public/staff-sw.js`
- Create: `client/src/utils/pushSubscribe.js`

- [ ] **Step 1: Service worker**

  ```javascript
  // client/public/staff-sw.js
  self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    const { title, body, url, tag, icon } = data;
    event.waitUntil(
      self.registration.showNotification(title || 'Dr Bartender', {
        body: body || '',
        tag: tag || 'default',
        icon: icon || '/logo192.png',
        data: { url: url || '/' },
      })
    );
  });
  self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || '/';
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then((clients) => {
        for (const c of clients) {
          if (c.url.includes(url) && 'focus' in c) return c.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
      })
    );
  });
  ```

- [ ] **Step 2: pushSubscribe util**

  ```javascript
  // client/src/utils/pushSubscribe.js
  import api from './api';

  export function permissionState() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission; // 'default' | 'granted' | 'denied'
  }

  export async function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { ok: false, reason: 'unsupported' };
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: perm };

    const reg = await navigator.serviceWorker.register('/staff-sw.js');
    await navigator.serviceWorker.ready;

    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(process.env.REACT_APP_VAPID_PUBLIC_KEY),
    });
    await api.post('/me/push-subscriptions', {
      endpoint: sub.endpoint,
      keys: sub.toJSON().keys,
      user_agent: navigator.userAgent,
    });
    return { ok: true, subscription: sub };
  }

  export async function unsubscribePush() {
    const reg = await navigator.serviceWorker.getRegistration('/staff-sw.js');
    if (!reg) return { ok: true };
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return { ok: true };
    await api.delete('/me/push-subscriptions', { data: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
    return { ok: true };
  }

  function urlBase64ToUint8Array(base64) { /* standard helper */ }
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add client/public/staff-sw.js client/src/utils/pushSubscribe.js
  git commit -m "feat(staff-portal): service worker + pushSubscribe util"
  ```

---

### Task 44: iOS coachmark UX

**Spec ref:** §6.13 (Push column behavior), §6.17.

**Files:**
- Modify: `client/src/pages/staff/account/IOSCoachmark.js` (the stub from Task 37)
- Modify: `client/src/pages/staff/account/NotificationsSection.js`

- [ ] **Step 1: Detect iOS Safari without home-screen install**

  ```javascript
  function isIosNeedsInstall() {
    const ua = navigator.userAgent;
    const isIos = /iPad|iPhone|iPod/.test(ua);
    const isStandalone = window.navigator.standalone === true;
    return isIos && !isStandalone;
  }
  ```

- [ ] **Step 2: IOSCoachmark modal**

  3-step list with icons: Share button → Add to Home Screen → Open from home screen → return here to toggle push. Single "Got it" button. Trigger from a "Show me how" link in the Push column banner when `isIosNeedsInstall()` is true.

- [ ] **Step 3: NotificationsSection banner states**

  Replace the Phase A "Coming in v1.5" disabled state with:
  - `granted`: green banner "Push notifications on"
  - `denied`: red banner with re-enable instructions
  - `default`: neutral banner with "Enable push" CTA that calls `subscribePush()`
  - `unsupported`: amber banner "Your browser doesn't support push"
  - `iosNeedsInstall`: amber banner + "Show me how" link → IOSCoachmark

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/pages/staff/account/IOSCoachmark.js \
          client/src/pages/staff/account/NotificationsSection.js
  git commit -m "feat(staff-portal): iOS coachmark + Push column permission states"
  ```

---

### Task 45: Activate push send path in dispatcher

**Spec ref:** §6.17.

**Files:**
- Modify: `server/utils/pushSender.js`
- Modify: `server/utils/pushSender.test.js`

- [ ] **Step 1: Replace the stub with real `web-push` calls**

  ```javascript
  const webpush = require('web-push');

  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_CONTACT_EMAIL || 'contact@drbartender.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  async function sendPush({ subscription, title, body, url, tag, icon }) {
    try {
      const payload = JSON.stringify({ title, body, url, tag, icon });
      await webpush.sendNotification(subscription, payload);
      return { ok: true };
    } catch (err) {
      const code = err?.statusCode;
      if (code === 410 || code === 404) return { ok: false, gone: true };
      return { ok: false, error: err?.message || 'send_failed' };
    }
  }

  module.exports = { sendPush };
  ```

- [ ] **Step 2: Replace the stub test with real coverage**

  - Successful send returns `{ ok: true }`
  - 410 / 404 returns `{ ok: false, gone: true }`
  - Other errors return `{ ok: false, error: ... }`

  Use a mock for `web-push` (the simplest pattern: replace the module on the require cache for the test).

- [ ] **Step 3: End-to-end verify**

  1. Open the staff portal in Chrome.
  2. AccountPage / Notifications → toggle a Push cell on for `shift_offered`.
  3. Grant browser permission.
  4. From a server console (or admin tool), enqueue a test `shift_offered` push for that user.
  5. Confirm the notification appears on the desktop.

- [ ] **Step 4: Commit**

  ```bash
  git add server/utils/pushSender.js server/utils/pushSender.test.js
  git commit -m "feat(staff-portal): activate web-push send path"
  ```

---

### Task 46: NotificationsSection Push column unlock + Phase B verification

**Spec ref:** §6.13.

**Files:**
- Modify: `client/src/pages/staff/account/NotificationsSection.js`

- [ ] **Step 1: Unlock the Push column**

  Remove the Phase A "Coming in v1.5" disabled state. Push toggles now write to `/api/me/staff-notifications`.

- [ ] **Step 2: First-toggle subscribe flow**

  When a user toggles a Push cell ON for the first time AND `permissionState() === 'default'`, call `subscribePush()` first; if that succeeds, then PATCH the staff-notifications channels. If permission denied, leave the toggle off + update the banner state.

- [ ] **Step 3: Manual verification matrix (per spec §11 Phase B)**

  - Push permission grant on Chrome desktop → subscribes successfully
  - Push permission grant on Android Chrome → subscribes successfully
  - iOS Safari without home-screen install → coachmark appears, toggles disabled
  - iOS Safari with home-screen install → permission flow works, toggles enable
  - Test BEO nudge with push-only preference → push fires, no SMS sent (assuming non-critical category)
  - Test BEO finalized notification with all channels off → critical-path override sends SMS anyway
  - Subscription expires (simulate 410) → server removes the subscription on next attempt

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/pages/staff/account/NotificationsSection.js
  git commit -m "feat(staff-portal): unlock Push column + first-toggle subscribe flow"
  ```

---

## Done.

All 46 tasks across 10 phases. Phase A (Tasks 1-41) ships the new portal with SMS + email notifications and the drop / cover marketplace; Phase B (Tasks 42-46) adds push.

**Cross-phase test gates:**

- Before merging Phase A: run the full server test suite (`node --test server/`), the client build (`CI=true npm --prefix client run build`), and the spec §11 Phase A manual verification matrix.
- Before merging Phase B: re-run the suite + the spec §11 Phase B manual verification matrix.
- A pre-deploy `code-review`, `security-review`, `database-review`, `performance-review`, `consistency-check` agent fleet run (per CLAUDE.md Rule 6) catches integration drift across the layers.

**Common pitfalls to call out during execution:**

1. **Forgetting to update BOTH `App.js` route blocks** (Task 39): the new portal must work on both `staff.drbartender.com` (StaffSiteRoutes) AND the hiring subdomain (HiringRoutes), because newly-hired staff land on the hiring subdomain before the staff subdomain.
2. **`payment_profiles.account_number` leaking in API responses** (Task 8): only project the last 4 digits. Search every new SELECT for the column name and confirm the projection.
3. **`/api/me` mount-order collisions** (Task 7): verify the existing `server/routes/me.js` routes and the new `server/routes/staffPortal.js` routes have no path collisions before mounting both under `/api/me`.
4. **Push subscription pruning race** (Task 45): when multiple dispatcher workers process the same user's rows concurrently, the `jsonb_set` for prune must be transaction-safe. Use `SELECT ... FOR UPDATE` on the user row inside the txn.
5. **Calendar feed deep links breaking on token rotation** (Task 36): when a user rotates their `calendar_token`, every previously-subscribed app stops syncing. The Regenerate confirm dialog must warn before firing.
