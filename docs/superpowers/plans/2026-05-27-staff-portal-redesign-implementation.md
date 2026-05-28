# Staff Portal Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the full staff portal redesign per `docs/superpowers/specs/2026-05-27-staff-portal-redesign-design.md` (commit `c57d99b`+). Ship a 4-tab portal (Home / Shifts / Pay / Tip Card) with an AccountPage overlay, the embedded BEO viewer on ShiftDetail, the drop / cover marketplace, light / dark theme, the calendar feed extension, and the channel-routed notifications surface (push gated to Phase B).

**Architecture:** Schema adds three JSONB columns on `users` (`ui_preferences`, `staff_notification_preferences`, `token_version`), one tracking column (`last_ics_fetch_at`), one column on `payment_profiles` (`zelle_handle`), one column on `contractor_profiles` (`alcohol_certification_expires_on`) plus a backfilled `position` column, five columns on `shift_requests` (cover / drop marketplace) plus `replaced_by_request_id` self-FK, three new tables (`staff_document_history`, `staff_audit_log`, `pending_email_changes`), and two `scheduled_messages` columns (`suppression_key` + an extended status enum). Two CHECK constraints widen: `users.onboarding_status` adds `'suspended'`; `scheduled_messages.channel` adds `'push'` and `.status` adds `'suppressed_by_sibling'` + `'dead_letter'`. New server router `server/routes/staffPortal.js` mounts all auth-gated `/api/me/*` endpoints. New `server/routes/emailChange.js` mounts the unauthenticated email-change confirm route. New `server/routes/adminCoverSwaps.js` mounts the JWT-verified admin cover-swap routes. Four new server utils (`notificationChannelResolver`, `pushSender`, `staffCalendarFeedExt`, `shiftTime`). Existing `server/routes/calendar.js`, `scheduledMessageDispatcher.js`, `messageScheduling.js`, `payrollAccrual.js`, `autoAssign.js`, `middleware/auth.js`, `routes/publicTip.js`, `routes/shifts.js`, `routes/me.js`, `utils/jwt.js`, `utils/tipHandleValidation.js`, `utils/smsTemplates.js`, `utils/lifecycleEmailTemplates.js`, `utils/staffShiftHandlers.js` all extended in-place. New React shell `client/src/components/StaffShell.js` + `StaffUserPillMenu.js` replaces `StaffLayout.js`. Eight new pages (HomePage, ShiftsPage with 3 sub-tabs, ShiftDetail, PayPage, PayoutDetail, TipCardPage, AccountPage with 6 sub-sections, EmailVerifyPage). Both `App.js` `HiringRoutes()` and `StaffSiteRoutes()` blocks swap `StaffLayout` → `StaffShell`. Nine old fragment files deleted after the 30-day redirect grace period begins.

**Tech Stack:** Node 18 / Express 4.18, raw SQL via `pg`, React 18 (CRA), `node:test`, Sentry, Twilio (via existing `sendAndLogSms`), `web-push` (new npm in Phase 11).

**Spec section anchors:** Every task references the relevant spec section. Read the spec section before starting the task.

**Inheritance:** The BEO implementation plan (`docs/superpowers/plans/2026-05-26-beo-implementation.md`) Phases 1-5 must be merged to `main` BEFORE Phase 2 of this plan. Task 8 (calendar feed) LEFT JOINs `drink_plans.finalized_at` + `shift_requests.beo_acknowledged_at` (BEO Phase 1 columns); Task 12 (staff-home), Task 25 (cascade), Task 28 (shifts projection), Task 33 (BEO extension), and Task 37 (ShiftDetail) all depend on those columns too. Phase 6 of the BEO plan is replaced wholesale by this plan: BEO Task 29 (standalone `StaffBeo.js`) is dropped, BEO Task 31 (badges on `StaffShifts`/`StaffEvents`) is dropped because those pages no longer exist after this plan ships. BEO Task 28 (DrinkPlanCard Finalize buttons) and BEO Task 30 (EventDetailPage View BEO link) are admin-side and survive untouched.

**Phasing alignment with spec §9:**
- Phase A (spec §9): Tasks 1-51. Portal shell + drop / cover + theme + AccountPage + SMS-and-email notifications only. Push column in NotificationsSection is rendered but disabled with a "Coming in v1.5" banner.
- Phase B (spec §9): Tasks 52-56. Push notifications + iOS coachmark + dispatcher push activation + NotificationsSection Push column unlock.

**Dead-code window fix:** The prior version of this plan mounted all the new client routes only at Task 39, leaving Tasks 24-38 unverifiable in-browser. This plan mounts a stub StaffShell + placeholder routes under `/staff-v2/*` at Task 29 (before the page implementation phase), so every subsequent client task can be verified end-to-end during implementation. The final cutover at Tasks 48-49 swaps the stub mount for the production mount.

**Per-phase review-agent checkpoints** (per `feedback_execution_review_cadence.md`):
- After Phase 1 (schema + utils): `database-review` (schema breadth, constraint widenings, partial indexes, new tables)
- After Phase 2 (dispatcher cascade + calendar feed): `code-review` + `security-review` (multi-row enqueue + sibling cascade + critical-path re-resolve is the riskiest single change in the plan; calendar feed surfaces client PII)
- After Phase 3 (auth + payroll companions): `security-review` (suspended-status auth deny-list) + `database-review` (payrollAccrual + autoAssign dropped_at filter touches money paths)
- After Phase 4 (staff portal API): `security-review` (new authenticated endpoints, bank PII guard, email-change auth model, allowlist enforcement)
- After Phase 5 (drop / cover marketplace): `code-review` + `consistency-check` (money-adjacent via pay_period processing guard + hybrid-state filter across payrollAccrual / autoAssign / team-roster)
- After Phase 8 (pay + tip card + publicTip extension): `code-review` (money display + the load-bearing publicTip extension)
- After Phase 11 (push): `security-review` (VAPID, service worker, subscription lifecycle)
- Before final cutover (Tasks 48-49): the full review-before-deploy fleet.

**Scope guard:** This plan implements the spec verbatim. Any deviation must be flagged and discussed before commit. No design changes during implementation.

---

## Phase 1: Foundation (schema + util skeletons)

### Task 1: Schema additions

**Spec ref:** Section 7 (Schema additions).

**Files:**
- Modify: `server/db/schema.sql`

- [ ] **Step 1: Read the schema sections this task touches**

  Get oriented:
  - `users` CHECK around schema.sql:24-25 (`onboarding_status`)
  - `users` columns around schema.sql:269 (`calendar_token`) and 2232+ (`notification_preferences`, `communication_preferences`)
  - `payment_profiles` table around schema.sql:129 + ALTERs around schema.sql:1990 (the encryption widening to VARCHAR(255))
  - `contractor_profiles` table at schema.sql:57
  - `shift_requests` table at schema.sql:295
  - `scheduled_messages` table at schema.sql:2279, CHECK constraints at 2297 (entity_type) / 2307 (channel) / 2313 (status) / 2331 (existing pending-uniqueness index)
  - `pay_periods.status` CHECK at schema.sql:2532
  - `applications.full_name` at schema.sql:146, `applications.positions_interested` at 166
  - `agreements.full_name` at schema.sql:99
  - `proposal_activity_log` at schema.sql:857
  - existing `password_reset_tokens` pattern at schema.sql:1204 (informs the `pending_email_changes` design)

- [ ] **Step 2: New JSONB and tracking columns on `users`**

  ```sql
  -- ─── Staff portal: theme / tip-card order / calendar app detection ───
  ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_preferences JSONB
    NOT NULL DEFAULT '{}'::jsonb;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ics_fetch_at TIMESTAMPTZ;

  -- ─── Staff portal: per-category × per-channel notification routing ───
  -- Default uses JSON literal (not jsonb_build_object) for deterministic key order
  -- matching the existing pattern at schema.sql:2233/2248.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_notification_preferences JSONB
    NOT NULL DEFAULT '{
      "channels": {
        "shift_offered":   ["push","sms","email"],
        "shift_decided":   ["push","sms"],
        "cover_needed":    ["push"],
        "beo_finalized":   ["push","sms","email"],
        "beo_reminder_t3": ["push","sms"],
        "schedule_change": ["push","sms","email"],
        "payday":          ["sms","email"],
        "tip_received":    ["push"]
      },
      "push_subscriptions": [],
      "quiet_hours": null
    }'::jsonb;

  -- ─── Session invalidation on email change (per spec §6.10) ───
  -- NOTE: users.token_version ALREADY exists at schema.sql:271 with DEFAULT 0.
  -- It's already enforced by middleware/auth.js:38 and signed in routes/auth.js:66/149/338
  -- with `?? 0` fallback. No new column needed. Email-change confirm at Task 18 just
  -- does `UPDATE users SET token_version = token_version + 1 WHERE id = $1`.
  ```

- [ ] **Step 3: Constraint widenings**

  Use the existing `DO $$ ... EXCEPTION WHEN OTHERS THEN NULL` pattern (matches `pay_periods` around schema.sql:2528):

  ```sql
  -- onboarding_status adds 'suspended'
  DO $$ BEGIN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_onboarding_status_check;
    ALTER TABLE users ADD CONSTRAINT users_onboarding_status_check
      CHECK (onboarding_status IN (
        'in_progress','applied','interviewing','hired','rejected',
        'submitted','reviewed','approved','suspended','deactivated'
      ));
  EXCEPTION WHEN OTHERS THEN NULL; END $$;

  -- scheduled_messages.channel adds 'push'
  DO $$ BEGIN
    ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_channel_check;
    ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_channel_check
      CHECK (channel IN ('email','sms','push'));
  EXCEPTION WHEN OTHERS THEN NULL; END $$;

  -- scheduled_messages.status adds 'suppressed_by_sibling' and 'dead_letter'
  -- for the §6.13 dispatcher cascade. Without this widening, the cascade's
  -- first UPDATE crashes on the existing CHECK.
  DO $$ BEGIN
    ALTER TABLE scheduled_messages DROP CONSTRAINT IF EXISTS scheduled_messages_status_check;
    ALTER TABLE scheduled_messages ADD CONSTRAINT scheduled_messages_status_check
      CHECK (status IN ('pending','sent','failed','suppressed','deferred','suppressed_by_sibling','dead_letter'));
  EXCEPTION WHEN OTHERS THEN NULL; END $$;
  ```

- [ ] **Step 4: `scheduled_messages.suppression_key` + `payload` columns + indexes**

  ```sql
  ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS suppression_key TEXT;
  CREATE INDEX IF NOT EXISTS idx_scheduled_messages_suppression_key
    ON scheduled_messages (suppression_key)
    WHERE suppression_key IS NOT NULL AND status = 'pending';

  -- Per-row payload for category-driven messages (cover_broadcast, beo_*, payday, etc.).
  -- The existing dispatcher uses registerHandler(message_type, handler) where handlers
  -- recompute content from entity/recipient lookups; the new staff-portal messages
  -- carry data that doesn't naturally derive from entity (truncated reasons, SMS
  -- template + args, re_resolve_count). This column is the payload-delivery vehicle
  -- enqueueCategorizedMessage uses (Task 4).
  ALTER TABLE scheduled_messages ADD COLUMN IF NOT EXISTS payload JSONB
    NOT NULL DEFAULT '{}'::jsonb;

  -- Cover-broadcast dedupe (per §6.5 runaway cap). Scoped via partial WHERE
  -- to avoid collision with idx_scheduled_messages_pending_uniq (schema.sql:2331).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_messages_cover_broadcast_dedupe
    ON scheduled_messages (entity_type, entity_id, recipient_type, recipient_id, channel)
    WHERE message_type = 'cover_broadcast' AND status IN ('pending','sent');
  ```

- [ ] **Step 5: `shift_requests` cover / drop columns + indexes**

  ```sql
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

  -- Hybrid-state filter index (per §6.5 / §6.18 / payrollAccrual / autoAssign update)
  CREATE INDEX IF NOT EXISTS idx_shift_requests_active_approved
    ON shift_requests(shift_id) WHERE status = 'approved' AND dropped_at IS NULL;
  ```

- [ ] **Step 6: payment_profiles + contractor_profiles new columns**

  ```sql
  ALTER TABLE payment_profiles ADD COLUMN IF NOT EXISTS zelle_handle TEXT;

  ALTER TABLE contractor_profiles
    ADD COLUMN IF NOT EXISTS alcohol_certification_expires_on DATE;

  -- Role attestation for cover-broadcast targeting (per §6.5).
  -- positions_interested is stored as a JSON-encoded string by Application.js,
  -- e.g. '["Bartender","Server"]'. Backfill JSON-decodes the first element.
  -- The CASE fallback handles any legacy CSV rows that may exist.
  ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS position TEXT;

  UPDATE contractor_profiles cp
     SET position = COALESCE(
       LOWER(TRIM((
         SELECT CASE
           WHEN a.positions_interested ~ '^\[' THEN (a.positions_interested::jsonb->>0)
           ELSE SPLIT_PART(a.positions_interested, ',', 1)
         END
         FROM applications a WHERE a.user_id = cp.user_id
       ))),
       'bartender'
     )
   WHERE cp.position IS NULL;

  CREATE INDEX IF NOT EXISTS idx_contractor_profiles_position
    ON contractor_profiles(position) WHERE position IS NOT NULL;
  ```

- [ ] **Step 7: New tables**

  ```sql
  -- Pending email change verification (per §6.10)
  CREATE TABLE IF NOT EXISTS pending_email_changes (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    new_email VARCHAR(255) NOT NULL,
    token_hash VARCHAR(64) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    consumed_at TIMESTAMPTZ
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_changes_token_hash
    ON pending_email_changes(token_hash) WHERE consumed_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_email_changes_new_email_pending
    ON pending_email_changes(LOWER(new_email)) WHERE consumed_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_pending_email_changes_user
    ON pending_email_changes(user_id) WHERE consumed_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_pending_email_changes_expires
    ON pending_email_changes(expires_at) WHERE consumed_at IS NULL;

  -- Document replace history (per §6.14)
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

  -- User-scoped audit log (per §6.10 + §6.11). `proposal_activity_log` is
  -- proposal-scoped; this table is for user-only events.
  CREATE TABLE IF NOT EXISTS staff_audit_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_type VARCHAR(20) NOT NULL DEFAULT 'staff' CHECK (actor_type IN ('staff','admin','system')),
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(50) NOT NULL,
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_staff_audit_log_user ON staff_audit_log(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_staff_audit_log_action ON staff_audit_log(action, created_at DESC);
  ```

- [ ] **Step 8: §6.13 migration guard, strip 'sms' for STOP-replied users**

  ```sql
  UPDATE users
     SET staff_notification_preferences = jsonb_set(
       staff_notification_preferences,
       '{channels}',
       (
         SELECT jsonb_object_agg(
           cat_key,
           COALESCE(
             (SELECT jsonb_agg(ch) FROM jsonb_array_elements_text(cat_val) AS ch WHERE ch <> 'sms'),
             '[]'::jsonb
           )
         )
         FROM jsonb_each(staff_notification_preferences->'channels') AS chans(cat_key, cat_val)
       ),
       false
     )
   WHERE (communication_preferences->>'sms_enabled')::boolean = false;
  ```

- [ ] **Step 9: Apply schema to dev DB**

  ```bash
  psql "$DATABASE_URL" -f server/db/schema.sql
  ```
  Expected: clean output. Idempotent ALTERs do nothing on re-run.

- [ ] **Step 10: Verify**

  ```bash
  psql "$DATABASE_URL" -c "\d users" | grep -E 'ui_preferences|staff_notification_preferences|last_ics_fetch_at|token_version'
  psql "$DATABASE_URL" -c "\d users" | grep onboarding_status
  psql "$DATABASE_URL" -c "\d shift_requests" | grep -E 'cover_requested_at|dropped_at|drop_emergency|replaced_by_request_id'
  psql "$DATABASE_URL" -c "\d payment_profiles" | grep zelle_handle
  psql "$DATABASE_URL" -c "\d contractor_profiles" | grep -E 'alcohol_certification_expires_on|position'
  psql "$DATABASE_URL" -c "\d scheduled_messages" | grep -E 'channel|status|suppression_key'
  psql "$DATABASE_URL" -c "\d staff_document_history"
  psql "$DATABASE_URL" -c "\d staff_audit_log"
  psql "$DATABASE_URL" -c "\d pending_email_changes"
  ```

  Every grep should return at least one row.

- [ ] **Step 11: Commit**

  ```bash
  git add server/db/schema.sql
  git commit -m "feat(staff-portal): schema additions for portal redesign"
  ```

---

### Task 2: notificationChannelResolver util

**Spec ref:** Section 6.13 (kill-switch + critical-path override + dead-letter resolution).

**Files:**
- Create: `server/utils/notificationChannelResolver.js`
- Create: `server/utils/notificationChannelResolver.test.js`

- [ ] **Step 1: Implement the resolver**

  ```javascript
  const { pool } = require('../db');

  const CRITICAL_CATEGORIES = new Set(['beo_finalized', 'schedule_change', 'payday']);
  const CRITICAL_FALLBACK_ORDER = ['sms', 'email', 'push'];

  // Single source of truth for missing-key default lookups. Future categories
  // added later inherit defaults without backfilling staff_notification_preferences.
  const DEFAULT_CHANNELS = {
    shift_offered:   ['push', 'sms', 'email'],
    shift_decided:   ['push', 'sms'],
    cover_needed:    ['push'],
    beo_finalized:   ['push', 'sms', 'email'],
    beo_reminder_t3: ['push', 'sms'],
    schedule_change: ['push', 'sms', 'email'],
    payday:          ['sms', 'email'],
    tip_received:    ['push'],
  };

  /**
   * Resolve the effective channel set for a categorized message.
   * @returns {Promise<{kind:'channels', channels:string[]} | {kind:'dead_letter', reason:string}>}
   */
  async function pickChannelsForUserAndCategory(userId, category) {
    const { rows } = await pool.query(
      `SELECT staff_notification_preferences AS prefs, communication_preferences AS comms
         FROM users WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) return { kind: 'channels', channels: [] };
    const { prefs, comms } = rows[0];
    const requested = Array.isArray(prefs?.channels?.[category])
      ? prefs.channels[category]
      : (DEFAULT_CHANNELS[category] || []);
    const filtered = requested.filter(ch => {
      if (ch === 'sms' && comms?.sms_enabled === false) return false;
      if (ch === 'email' && comms?.email_enabled === false) return false;
      return true;
    });
    if (filtered.length > 0) return { kind: 'channels', channels: Array.from(new Set(filtered)) };
    if (CRITICAL_CATEGORIES.has(category)) {
      const pushSubs = Array.isArray(prefs?.push_subscriptions) ? prefs.push_subscriptions : [];
      for (const ch of CRITICAL_FALLBACK_ORDER) {
        if (ch === 'sms' && comms?.sms_enabled === false) continue;
        if (ch === 'email' && comms?.email_enabled === false) continue;
        if (ch === 'push' && pushSubs.length === 0) continue;
        return { kind: 'channels', channels: [ch] };
      }
      return { kind: 'dead_letter', reason: 'all_channels_blocked' };
    }
    return { kind: 'channels', channels: [] };
  }

  module.exports = { pickChannelsForUserAndCategory, CRITICAL_CATEGORIES, DEFAULT_CHANNELS };
  ```

- [ ] **Step 2: Tests**

  - Returns opted-in channels, deduped
  - `comms.sms_enabled=false` filters SMS from every result
  - `comms.email_enabled=false` filters email
  - Missing category key in prefs falls back to `DEFAULT_CHANNELS`
  - Critical-path override fires when all channels for `beo_finalized` are off, prefers SMS
  - Override degrades to email if SMS globally off; to push if both off AND push subs exist
  - Override returns `dead_letter` when SMS+email+push all blocked
  - Returns empty `channels` array for unknown user

- [ ] **Step 3: Run + commit**

  ```bash
  node --test server/utils/notificationChannelResolver.test.js
  git add server/utils/notificationChannelResolver.js server/utils/notificationChannelResolver.test.js
  git commit -m "feat(staff-portal): notification channel resolver with critical-path override + dead-letter"
  ```

---

### Task 3: pushSender util (skeleton)

**Spec ref:** Section 6.17 (push infrastructure). Skeleton ships now so Phase 4 dispatcher code can import it; Phase 11 Task 55 replaces the body with real `web-push` calls.

**Files:**
- Create: `server/utils/pushSender.js`
- Create: `server/utils/pushSender.test.js`

- [ ] **Step 1: Implement the stub**

  ```javascript
  /**
   * Send a Web Push notification. Phase A stub: returns ok:false without sending.
   * Phase B (Task 55) replaces the body with real web-push calls.
   *
   * @returns {Promise<{ok: boolean, gone?: boolean, error?: string}>}
   */
  async function sendPush({ subscription, title, body, url, tag, icon }) {
    if (!process.env.VAPID_PRIVATE_KEY) {
      return { ok: false, error: 'vapid_unset' };
    }
    return { ok: false, error: 'push_phase_b' };
  }

  module.exports = { sendPush };
  ```

- [ ] **Step 2: Tests**, confirms stub returns `ok:false` with appropriate `error` and surfaces `vapid_unset` when env missing.

- [ ] **Step 3: Run + commit**

  ```bash
  node --test server/utils/pushSender.test.js
  git add server/utils/pushSender.js server/utils/pushSender.test.js
  git commit -m "feat(staff-portal): pushSender stub (Phase B activates real send)"
  ```

---

### Task 4: enqueueCategorizedMessage helper

**Spec ref:** Section 6.13 (Dispatcher integration, multi-row enqueue at scheduling time with shared `suppression_key`).

**Files:**
- Modify: `server/utils/messageScheduling.js` (existing, 66 lines)
- Modify: `server/utils/messageScheduling.test.js` (extend or create)

- [ ] **Step 1: Widen the `VALID_CHANNELS` Set**

  Line 5 currently: `const VALID_CHANNELS = new Set(['email', 'sms']);`
  Change to: `const VALID_CHANNELS = new Set(['email', 'sms', 'push']);`
  Required companion to the schema CHECK widening in Task 1, otherwise the existing `scheduleMessage` validator throws before any push INSERT lands.

- [ ] **Step 2: Add the helper**

  ```javascript
  const { pickChannelsForUserAndCategory } = require('./notificationChannelResolver');

  /**
   * Enqueue a categorized message, fanning out to all opted-in channels.
   * Each row carries a shared suppression_key so the dispatcher's sibling
   * cascade can collapse them on first send.
   *
   * @returns {Promise<{enqueued: string[], deadLetter: boolean}>}
   */
  async function enqueueCategorizedMessage({
    userId,
    category,
    payload,            // { title, body, url, tag, icon, sms_template, sms_args, email_template, email_args, ... }
    sendAt,             // Date | ISO string
    entityType,         // one of 'proposal','shift','client','consult' (per existing CHECK)
    entityId,
    messageType,        // application-defined string, used as part of suppression_key
  }, client = pool) {
    const resolved = await pickChannelsForUserAndCategory(userId, category);
    if (resolved.kind === 'dead_letter') {
      return { enqueued: [], deadLetter: true };
    }
    const channels = resolved.channels;
    if (channels.length === 0) return { enqueued: [], deadLetter: false };

    const suppressionKey = `${entityType}:${entityId}:${messageType}:${userId}`;
    const payloadWithCounter = { ...payload, re_resolve_count: 0 };

    const enqueued = [];
    for (const channel of channels) {
      const { rows } = await client.query(
        `INSERT INTO scheduled_messages
           (entity_id, entity_type, message_type, recipient_type, recipient_id,
            channel, scheduled_for, status, suppression_key, payload)
         VALUES ($1, $2, $3, 'staff', $4, $5, $6, 'pending', $7, $8::jsonb)
         RETURNING id`,
        [entityId, entityType, messageType, userId, channel, sendAt, suppressionKey, JSON.stringify(payloadWithCounter)]
      );
      enqueued.push(rows[0].id);
    }
    return { enqueued, deadLetter: false };
  }

  module.exports.enqueueCategorizedMessage = enqueueCategorizedMessage;
  ```

  The new `scheduled_messages.payload JSONB` column is added in Task 1 Step 4 specifically to carry per-row payload data for category-driven messages (cover_broadcast, beo_*, payday, etc.). The existing dispatcher pattern (`registerHandler(message_type, handlerFn)`) where handlers recompute content from entity/recipient lookups is unchanged, handlers for the new message_types either read from `payload` directly OR continue to derive from entity/recipient when applicable.

- [ ] **Step 3: Tests**, N-channel fan-out, zero on muted non-critical, dead-letter return, suppression_key shape correct, custom client (transaction) passed through.

- [ ] **Step 4: Commit**

  ```bash
  git add server/utils/messageScheduling.js server/utils/messageScheduling.test.js
  git commit -m "feat(staff-portal): enqueueCategorizedMessage fan-out + VALID_CHANNELS push widening"
  ```

---

### Task 5: shiftTime.js helper

**Spec ref:** Section 6.5 (hours-to-event computation).

**Files:**
- Create: `server/utils/shiftTime.js`
- Create: `server/utils/shiftTime.test.js`

- [ ] **Step 1: Implement parseShiftDateTime + hoursToEvent**

  ```javascript
  /**
   * Parse a shift's event_date + start_time into a Date in America/Chicago wall-clock.
   * Times in shifts are stored as VARCHAR(50); per CLAUDE.md the project uses no
   * global timezone normalization, so this helper does the conversion.
   *
   * @param {{event_date: string|Date, start_time: string}} shift
   * @returns {Date}
   */
  function parseShiftDateTime(shift) {
    const dateStr = typeof shift.event_date === 'string'
      ? shift.event_date
      : shift.event_date.toISOString().slice(0, 10);
    const timeStr = shift.start_time || '00:00';
    // Compose as local Chicago time, then convert. Cheapest approach using Intl.
    // Build an ISO local-time string and parse via Date assuming Chicago TZ.
    const [hh, mm] = timeStr.split(':');
    // Use a quick-and-dirty timezone-aware parse via Date.UTC plus offset lookup.
    // For mainland US, the offset is -5 or -6 depending on DST.
    const localIso = `${dateStr}T${hh.padStart(2, '0')}:${(mm || '00').padStart(2, '0')}:00`;
    const offset = getChicagoOffset(new Date(`${localIso}Z`));
    return new Date(`${localIso}${offset}`);
  }

  function getChicagoOffset(d) {
    // DST runs second Sunday of March to first Sunday of November
    const year = d.getUTCFullYear();
    const dstStart = nthSundayOf(year, 2, 2); // March, 2nd Sunday
    const dstEnd   = nthSundayOf(year, 10, 1); // November, 1st Sunday
    const ms = d.getTime();
    return (ms >= dstStart && ms < dstEnd) ? '-05:00' : '-06:00';
  }

  function nthSundayOf(year, monthZeroBased, n) {
    const first = new Date(Date.UTC(year, monthZeroBased, 1));
    const dow = first.getUTCDay(); // 0=Sun
    const firstSunday = 1 + ((7 - dow) % 7);
    const day = firstSunday + (n - 1) * 7;
    return Date.UTC(year, monthZeroBased, day, 2); // 2am local approximated
  }

  function hoursToEvent(shift) {
    const eventTime = parseShiftDateTime(shift);
    return (eventTime.getTime() - Date.now()) / 3_600_000;
  }

  module.exports = { parseShiftDateTime, hoursToEvent };
  ```

  This is a quick-and-correct-enough implementation. If `date-fns-tz` or `luxon` is already in package.json, prefer it; check first.

- [ ] **Step 2: Tests**

  - DST forward boundary (early March)
  - DST backward boundary (early November)
  - Exactly-336h returns 336 (clean-drop boundary)
  - Exactly-72h returns 72 (cover-broadcast boundary)
  - Past events return negative hours

- [ ] **Step 3: Commit**

  ```bash
  git add server/utils/shiftTime.js server/utils/shiftTime.test.js
  git commit -m "feat(staff-portal): shiftTime helper for parseShiftDateTime + hoursToEvent"
  ```

---

### Task 6: tipHandleValidation Zelle branch

**Spec ref:** Section 6.11 (Payment methods, Zelle validation).

**Files:**
- Modify: `server/utils/tipHandleValidation.js`
- Modify: `server/utils/tipHandleValidation.test.js`

- [ ] **Step 1: Add validateZelleHandle**

  ```javascript
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const E164_RE  = /^\+?[1-9]\d{1,14}$/;

  function validateZelleHandle(input) {
    if (!input || typeof input !== 'string') {
      return { valid: false, error: 'Zelle requires a phone number or email address.' };
    }
    const trimmed = input.trim();
    if (EMAIL_RE.test(trimmed)) return { valid: true, normalized: trimmed.toLowerCase() };
    if (E164_RE.test(trimmed.replace(/[\s\-()]/g, ''))) {
      return { valid: true, normalized: trimmed.replace(/[\s\-()]/g, '') };
    }
    return { valid: false, error: 'Zelle requires a phone number or email address.' };
  }

  // Wire into the existing normalizeTipHandlesInPlace switch
  // (find the switch on key name; add a `case 'zelle_handle'` branch
  //  that calls validateZelleHandle and writes the normalized value)
  ```

- [ ] **Step 2: Tests**, email valid, US E.164 valid, formatted US phone (with dashes/parens) valid + normalized, garbage rejected.

- [ ] **Step 3: Commit**

  ```bash
  git add server/utils/tipHandleValidation.js server/utils/tipHandleValidation.test.js
  git commit -m "feat(staff-portal): tipHandleValidation Zelle branch (phone or email)"
  ```

---

## Phase 2: Dispatcher integration + calendar feed extension

### Task 7: Dispatcher kill-switch + push branch + sibling cascade + re-resolve

**Spec ref:** Section 6.13 (Dispatcher integration, multi-row enqueue, sibling-suppression cascade, critical-path re-resolve with counter, dead-letter Sentry + ADMIN_PHONE).

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.js`
- Modify: `server/utils/scheduledMessageDispatcher.test.js`

- [ ] **Step 1: Read the dispatcher loop**

  Locate where each `scheduled_messages` row is read and sent. The dispatcher already exports `checkSuppression`; reuse it.

- [ ] **Step 2: Kill-switch re-check at send time**

  Before any channel-specific send, read the user's `communication_preferences`. Skip + mark `'suppressed'` (terminal) if the channel kill switch has flipped to false since enqueue. Reuse the existing `checkSuppression` helper rather than duplicating the SELECT.

- [ ] **Step 3: Push channel branch**

  When `row.channel === 'push'`:
  - Open a transaction. `SELECT users.staff_notification_preferences AS prefs FROM users WHERE id = $1 FOR UPDATE` (the FOR UPDATE is the race guard for concurrent prune).
  - Iterate `prefs.push_subscriptions[]`. For each, call `pushSender.sendPush(...)`. Survivors stay; entries returning `gone:true` are filtered.
  - If survivors.length !== subs.length, UPDATE the prefs JSONB with the filtered array.
  - Mark the row `sent` if any sub succeeded; `failed` otherwise.
  - COMMIT.

- [ ] **Step 4: Sibling-suppression cascade**

  When a row sends successfully, in the same transaction:

  ```sql
  UPDATE scheduled_messages
     SET status = 'suppressed_by_sibling'
   WHERE suppression_key = $1
     AND id <> $2
     AND status = 'pending';
  ```

- [ ] **Step 5: Critical-path re-resolve loop**

  When EVERY row in a `suppression_key` group reaches a terminal status (`'sent'` / `'failed'` / `'suppressed'` / `'suppressed_by_sibling'` / `'dead_letter'`) AND the group's category is in `CRITICAL_CATEGORIES` AND the group resolved with zero `'sent'` rows:
  - Read `payload.re_resolve_count` (default 0).
  - If `re_resolve_count >= 2`, mark all group rows `'dead_letter'`, fire `Sentry.captureMessage('critical_path_dead_letter', { user_id, category, suppression_key })`, and IF `process.env.ADMIN_PHONE` is set send a one-shot SMS to that number via `sendAndLogSms({ to: process.env.ADMIN_PHONE, body: "DR BARTENDER: critical message dead-lettered ..." })`. Done.
  - Else call `pickChannelsForUserAndCategory(user_id, category)` for a fresh resolution. If it returns `dead_letter`, same terminal as above. If it returns channels, enqueue ONE new `scheduled_messages` row at the first resolved channel with a NEW `suppression_key` and `payload.re_resolve_count = old + 1`.

- [ ] **Step 6: Audit existing readers of scheduled_messages.status**

  Grep for `scheduled_messages.status` and `s.status` across the codebase. Any reader that filters with `status NOT IN ('sent','failed')` to find live work must be updated to also exclude `'suppressed_by_sibling'` and `'dead_letter'` (treat both as terminal). Document the affected files in a comment block in this task's commit message.

- [ ] **Step 7: Tests**

  - Kill-switch re-check at send time suppresses an enqueued SMS when sms_enabled flipped false
  - Push branch iterates subs, prunes 410s, survives transient errors
  - Push prune uses `SELECT FOR UPDATE` (concurrent dispatch test)
  - Sibling-suppression cascade fires on first send
  - Re-resolve increments counter; second re-resolve at counter=2 dead-letters
  - Dead-letter triggers Sentry + ADMIN_PHONE SMS
  - **Degradation breadcrumb**: every time the critical-path override silently substitutes a channel (e.g., requested push → actually sent SMS because no subs), fire `Sentry.addBreadcrumb({ category: 'notifications', message: 'critical_path_degraded', data: { user_id, category, requested, delivered } })`. Spec §6.13 calls this out separately from the dead-letter capture so ops can detect silent channel substitution before staffers complain.

  **Note on Step 2 redundancy:** `checkSuppression` at `server/utils/scheduledMessageDispatcher.js:158-166` already does the staff/admin per-channel comm-prefs check, and is called immediately before send in `dispatchRow` at line 426. The "kill-switch re-check" this task adds is therefore extending that helper to handle the new `'push'` channel case, not introducing a new code path.

- [ ] **Step 8: Commit**

  ```bash
  git add server/utils/scheduledMessageDispatcher.js \
          server/utils/scheduledMessageDispatcher.test.js
  git commit -m "feat(staff-portal): dispatcher kill-switch + push + sibling cascade + re-resolve"
  ```

---

### Task 8: Calendar feed extension

**Spec ref:** Section 6.12 (Calendar sync, BEO-confirm all-day VEVENTs + 30-day backward cutoff + debounced last_ics_fetch_at).

**Files:**
- Create: `server/utils/staffCalendarFeedExt.js`
- Create: `server/utils/staffCalendarFeedExt.test.js`
- Modify: `server/routes/calendar.js`

- [ ] **Step 1: Read the existing builder**

  `buildICalFeed` at `calendar.js:211`. Identify how shift rows feed into VEVENT composition. The route also currently has only a forward `+ 365 days` window (`calendar.js:307,319`); this task adds the backward `- 30 days` cutoff.

- [ ] **Step 2: Implement the BEO-confirm extension util**

  ```javascript
  function buildBeoConfirmVEvents(rows, portalBaseUrl) {
    const out = [];
    for (const row of rows) {
      if (!row.finalized_at) continue;
      if (row.beo_acknowledged_at) continue;
      const eventDate = new Date(row.event_date);
      const reminderDate = new Date(eventDate);
      reminderDate.setUTCDate(reminderDate.getUTCDate() - 3);
      const yyyymmdd = reminderDate.toISOString().slice(0, 10).replace(/-/g, '');
      out.push([
        'BEGIN:VEVENT',
        `UID:beo-confirm-${row.shift_id}@drbartender.com`,
        `DTSTAMP:${nowIcs()}`,
        `DTSTART;VALUE=DATE:${yyyymmdd}`,
        `DTEND;VALUE=DATE:${addDayIcs(yyyymmdd)}`,
        `SUMMARY:Confirm BEO: ${escapeIcs(row.client_name || 'client')}`,
        `DESCRIPTION:Open the staff portal to confirm: ${portalBaseUrl}/shifts/${row.shift_id}`,
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      ].join('\r\n'));
    }
    return out;
  }
  // ...escapeIcs / nowIcs / addDayIcs helpers as before...
  module.exports = { buildBeoConfirmVEvents };
  ```

- [ ] **Step 3: Wire into `calendar.js` `buildICalFeed`**

  - LEFT JOIN `drink_plans` (for `finalized_at`) + `shift_requests` (for `beo_acknowledged_at`) in the staff-side SELECT.
  - Add backward cutoff: `AND s.event_date >= CURRENT_DATE - INTERVAL '30 days'`.
  - After existing VEVENTs are composed, call `buildBeoConfirmVEvents(rows, portalBaseUrl)` and append the strings.
  - `portalBaseUrl = process.env.STAFF_URL || 'https://staff.drbartender.com'`.

- [ ] **Step 4: Debounced last_ics_fetch_at + User-Agent detection**

  After successful 200 response (NOT 304), and bounded by a 10-minute debounce window:

  ```sql
  UPDATE users
     SET last_ics_fetch_at = NOW(),
         ui_preferences = jsonb_set(ui_preferences, '{calendar_subscribed_app}', $2::jsonb, true)
   WHERE id = $1
     AND (last_ics_fetch_at IS NULL OR last_ics_fetch_at < NOW() - INTERVAL '10 minutes');
  ```

  `$2` is the detected app from the User-Agent: `"google"` / `"apple"` / `"outlook"` / `"other"`. Detection is best-effort; check for `Calendar.google.com`, `Google-Calendar-Importer`, `iCal/`, `iOS/`, `Microsoft Office/Outlook` substrings.

- [ ] **Step 5: Tests**

  - Emits all-day VEVENT for unconfirmed-finalized BEO shifts
  - Skips already-acked BEOs
  - Skips un-finalized drink plans
  - DTSTART is exactly 3 days before event_date (test DST transitions)
  - 30-day backward cutoff filters out old shifts
  - last_ics_fetch_at write is debounced (second fetch within 10 min does nothing)

- [ ] **Step 6: Manual verification**

  ```bash
  curl -s "http://localhost:5000/api/calendar/feed/<test-token>" | grep -E 'Confirm BEO|TRANSP:TRANSPARENT'
  ```

- [ ] **Step 7: Commit**

  ```bash
  git add server/utils/staffCalendarFeedExt.js \
          server/utils/staffCalendarFeedExt.test.js \
          server/routes/calendar.js
  git commit -m "feat(staff-portal): extend calendar feed with BEO-confirm VEVENTs + last_ics_fetch_at"
  ```

---

## Phase 3: Auth + middleware companions

### Task 9: auth.js, suspended deny

**Spec ref:** Section 10 (Authorization, suspended blocks portal access).

**Files:**
- Modify: `server/middleware/auth.js`
- Modify: `server/middleware/auth.test.js` (extend or create)

**Pre-execution note:** The `token_version` mechanic is ALREADY shipped. `users.token_version INTEGER NOT NULL DEFAULT 0` exists at `schema.sql:271`. The middleware already does the compare at `server/middleware/auth.js:38` via `(u.token_version ?? 0) !== (decoded.tokenVersion ?? 0)`. JWT signing already embeds it inline in `server/routes/auth.js:66/149/338` with `tokenVersion: user.token_version ?? 0`. Password reset already bumps it at `routes/auth.js:444`. So this task collapses to JUST the suspended deny-list extension. The email-change confirm at Task 18 just adds `token_version = token_version + 1` to its UPDATE; that flows through the existing machinery automatically.

- [ ] **Step 1: Read the existing deny-list**

  Around `server/middleware/auth.js:41-49`: the `if` branch that denies `'deactivated'` and `'rejected'`. Extend to include `'suspended'`.

- [ ] **Step 2: Tests**

  - Suspended user gets the same response shape as deactivated/rejected (whichever the existing pattern is, 401 or 403)
  - Active-approved user still passes

- [ ] **Step 3: Commit**

  ```bash
  git add server/middleware/auth.js server/middleware/auth.test.js
  git commit -m "feat(staff-portal): auth middleware adds 'suspended' to deny-list"
  ```

---

### Task 10: ~~jwt.js embed token_version~~ (REMOVED, already shipped)

**Removed.** JWT signing is inline in `server/routes/auth.js` (lines 66, 149, 338) and already embeds `tokenVersion: user.token_version ?? 0`. Password reset at `routes/auth.js:444` already bumps the column. No file or task needed. Email-change confirm at Task 18 just does the same `UPDATE users SET token_version = token_version + 1` and the existing machinery picks it up. This tombstone preserves the original task numbering for downstream cross-references.

---

### Task 11: payrollAccrual.js + autoAssign.js dropped_at filter

**Spec ref:** Section 6.5 (Hybrid-state rule, every downstream consumer that reads `status='approved'` must also check `dropped_at IS NULL`).

**Files:**
- Modify: `server/utils/payrollAccrual.js`
- Modify: `server/utils/autoAssign.js`
- Modify: relevant test files

- [ ] **Step 1: payrollAccrual.js update**

  Around line 115: change `WHERE sr.status = 'approved'` → `WHERE sr.status = 'approved' AND sr.dropped_at IS NULL`. Without this update, emergency-dropped staffers accrue pay automatically when `accruePayoutsForProposal` fires on event completion.

- [ ] **Step 2: autoAssign.js update**

  Around line 142: same filter addition on the approved-seat count. Emergency-dropped seats should be treated as vacant for re-fill.

- [ ] **Step 3: Tests**

  - payrollAccrual: emergency-dropped staffer does NOT accrue
  - autoAssign: emergency-dropped seat IS counted as vacant
  - Normal-approved staffers still process normally

- [ ] **Step 4: Commit**

  ```bash
  git add server/utils/payrollAccrual.js server/utils/payrollAccrual.test.js \
          server/utils/autoAssign.js server/utils/autoAssign.test.js
  git commit -m "feat(staff-portal): hybrid-state filter on payrollAccrual + autoAssign (dropped_at IS NULL)"
  ```

---

## Phase 4: Staff portal API + admin cover-swap

### Task 12: staffPortal.js skeleton + GET /api/me/staff-home

**Spec ref:** Section 6.2 (HomePage), Section 8.1.

**Files:**
- Create: `server/routes/staffPortal.js`
- Create: `server/routes/staffPortal.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Skeleton with auth**

  ```javascript
  const express = require('express');
  const { pool } = require('../db');
  const { auth } = require('../middleware/auth');
  const asyncHandler = require('../middleware/asyncHandler');
  const { ValidationError, NotFoundError, PermissionError, ConflictError } = require('../utils/errors');

  const router = express.Router();
  router.use(auth);

  // GET /api/me/staff-home, composite payload
  router.get('/staff-home', asyncHandler(async (req, res) => { /* step 2 */ }));

  module.exports = router;
  ```

- [ ] **Step 2: Composite /staff-home**

  Promise.all of 4 queries:
  - Next upcoming approved shift (LEFT JOIN drink_plans for `finalized_at`, project `beo_acknowledged_at`, FILTER `dropped_at IS NULL`)
  - Pending shift_requests for this user
  - Cover broadcasts: shift_requests rows where `cover_requested_at IS NOT NULL` and the requester is NOT this user, with `you_are_on_team` derived from same-proposal shift_requests
  - Current pay period summary

  Returns: `{ next_shift, pending_requests, cover_broadcasts, current_period, open_shifts_teaser }`.

- [ ] **Step 3: Mount in `server/index.js`**

  ```javascript
  app.use('/api/me', require('./routes/staffPortal'));
  ```

  The existing `server/routes/me.js` already owns `/api/me/tip-page`, `/api/me/tips`, `/api/me/notification-preferences` and is mounted at `/api/me`. Verify no path collisions: grep both files for the new endpoints; mount `staffPortal` AFTER `me.js` so existing paths win on any collision. Document any decision in the commit message.

- [ ] **Step 4: Test**

  - Composite payload shape
  - IDOR: different user's JWT → different payload, no leakage
  - Auth gate: no JWT → 401

- [ ] **Step 5: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js server/index.js
  git commit -m "feat(staff-portal): GET /api/me/staff-home composite endpoint"
  ```

---

### Task 13: Payment methods endpoints

**Spec ref:** Section 6.11 (Payment methods, encrypt/decrypt, partial-update, allowlist, audit log).

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: GET /api/me/payment-methods**

  Decrypt routing/account on read; project ONLY `routing_number_last4` and `account_number_last4` (computed from decrypted plaintext) to the client. Never project full ciphertext. If decrypt fails (corrupt ciphertext, missing key), return the field as `null` with a Sentry-captured error rather than 500ing the whole GET. For users with no `payment_profiles` row yet (new applicants), return a synthetic empty shape with all handles `null`.

- [ ] **Step 2: PATCH /api/me/payment-methods**

  Strict allowlist as a hardcoded const:

  ```javascript
  const ALLOWED_KEYS = new Set([
    'venmo_handle','cashapp_handle','paypal_url','zelle_handle',
    'routing_number','account_number','payment_username'
  ]);
  ```

  Any payload key NOT in the set → reject 400 BEFORE any DB read. Then:
  1. Validate P2P handles via `tipHandleValidation` (Zelle branch from Task 6 included).
  2. Validate routing (9-digit ABA checksum) and account (4-17 digit length) BEFORE encryption.
  3. SELECT existing row `FOR UPDATE`.
  4. For changed bank fields, call `encrypt(plaintext)` via `server/utils/encryption.js` (env var: `ENCRYPTION_KEY`; module fails-closed if unset). If only routing is in the body, leave account ciphertext untouched (no decrypt+re-encrypt). Same for account-only PATCH.
  5. If decrypt of the UNCHANGED side fails (during the preferred-method-eligibility check), log Sentry with `{user_id, column}` but proceed with the PATCH on the changed field only. Do NOT block; admin tooling repairs corrupt ciphertext.
  6. Auto-NULL `preferred_payment_method` if the cleared field was the preferred target.
  7. COMMIT.
  8. After commit, INSERT into `staff_audit_log` with `(user_id=req.user.id, actor_type='staff', actor_id=req.user.id, action='payment_method_change', details={fields_changed: [...], cleared: [...]})`.

- [ ] **Step 3: PUT /api/me/preferred-payment-method**

  Validates handle column populated for the target method. For direct_deposit: BOTH routing AND account non-null. For check: no handle required. INSERT audit log `action='preferred_payment_method_change'`, `details={from, to}`.

- [ ] **Step 4: Tests**

  - GET projects last-4 only, never raw
  - PATCH unknown key rejected 400 pre-DB
  - PATCH only-routing leaves account ciphertext untouched
  - PATCH that clears preferred target auto-NULLs preferred_payment_method
  - Audit log row written on every mutation
  - Decrypt-fail on unchanged side: GET returns null + Sentry; PATCH proceeds on changed field

- [ ] **Step 5: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js
  git commit -m "feat(staff-portal): payment-methods endpoints with encryption + audit + allowlist"
  ```

---

### Task 14: tip-card-order, profile, ui-preferences endpoints

**Spec ref:** Sections 6.8, 6.10, 6.16.

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: PUT /api/me/tip-card-order**

  Body `{ order: ['venmo','card','cashapp','paypal','zelle'] }`. Validate every token against an allowed set. Write to `users.ui_preferences.tip_card_order` via `jsonb_set`.

- [ ] **Step 2: PATCH /api/me/profile**

  Allowlist: `preferred_name`, `phone`, `street_address`, `city`, `state`, `zip_code`, `emergency_contact_name`, `emergency_contact_phone`, `emergency_contact_relationship`. **Email is NOT here**, email changes go through the separate `request-email-change` flow.

  Server-side validation: phone format (E.164 via existing util), ZIP (5 or 5+4 digits), emergency contact fields each <= 100 chars. Writes to `contractor_profiles`.

  Phone change audit: if `phone` is in body and differs from current value, INSERT `staff_audit_log` with `action='profile_phone_change'`, `details={old_phone_last4, new_phone_last4}`.

- [ ] **Step 3: PATCH /api/me/ui-preferences**

  Allowlist: `theme` (must be `'light'` or `'dark'`), `calendar_subscribed_app`. Merge atomically via chained `jsonb_set`.

- [ ] **Step 4: Tests**, order rejects unknown tokens, profile rejects email key, phone change writes audit row.

- [ ] **Step 5: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js
  git commit -m "feat(staff-portal): tip-card-order, profile (no email), ui-preferences endpoints"
  ```

---

### Task 15: staff-notifications + push-subscriptions endpoints

**Spec ref:** Section 6.13 (Notifications), Section 6.17 (Push).

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: GET /api/me/staff-notifications**

  Returns `{ prefs: staff_notification_preferences, comms: communication_preferences }`.

- [ ] **Step 2: PATCH /api/me/staff-notifications**

  Body shape `{ channels: { [category]: ['push','sms',...] }, quiet_hours?: {...} }`. Validate categories + channels against allowed sets. Combined-state check: if the proposed save leaves EACH critical-path category (`beo_finalized`, `schedule_change`, `payday`) individually with no deliverable channel, reject 400 with `{field: '_form', error: 'Critical messages need at least one channel.'}`. Per-category, NOT aggregate. Partial merge via `jsonb_set`.

- [ ] **Step 3: POST /api/me/push-subscriptions**

  Body `{ endpoint, keys: { p256dh, auth }, user_agent }`. Server checks for existing entry with the same `endpoint`; if found, replace in place. Else append. **Cap at 10 active subscriptions per user**: if append would exceed 10, evict the OLDEST entry (by `subscribed_at`) in the same `jsonb_set` operation. Tie-breaker on identical timestamps: keep the entry with the lower array index.

- [ ] **Step 4: DELETE /api/me/push-subscriptions**

  Body `{ endpoint }`. Filter the array.

- [ ] **Step 5: Tests**

  - Combined-state validation rejects per-category bad state
  - **Per-category-not-aggregate**: a save that mutes ONLY `payday` (leaving `beo_finalized` + `schedule_change` with channels) is ACCEPTED. The check is per-category, not aggregate (spec §6.13 nuance).
  - A save that would leave any single critical-path category with no deliverable channel is rejected (test each of the three critical categories independently).
  - Push-subscription POST replaces existing endpoint
  - Push-subscription POST evicts oldest at cap=10
  - Push-subscription DELETE prunes

- [ ] **Step 6: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js
  git commit -m "feat(staff-portal): staff-notifications + push-subscriptions endpoints (cap+LRU)"
  ```

---

### Task 16: Documents replace endpoint

**Spec ref:** Section 6.14.

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`

- [ ] **Step 1: POST /api/me/documents/:doc_type/replace**

  Multipart. Steps in order:

  1. Validate `doc_type` is `'w9'` or `'alcohol_certification'`.
  2. For `alcohol_certification`, require body `expires_on` (date string, must be > CURRENT_DATE; reject 400 otherwise).
  3. Validate uploaded file via `isValidUpload(file)` from `server/utils/fileValidation.js` (magic-byte check, PDF/PNG/JPEG only). Cap 10 MB; reject 413.
  4. Slugify the original filename: `[A-Za-z0-9._-]` only, strip slashes / control chars / `..`.
  5. Compose R2 key: `staff/${doc_type}/${user_id}/${Date.now()}_${slugifiedFilename}`.
  6. Upload to R2 via `uploadFile(buffer, r2Key)` from `server/utils/storage.js`. If R2 fails, return 502.
  7. Open transaction:
     - SELECT current `payment_profiles` row (W-9) or `contractor_profiles` row (alcohol cert) `FOR UPDATE`.
     - INSERT into `staff_document_history` with `replaced_by_user_id=req.user.id`.
     - UPDATE the active record column(s) with the new R2 key:
       - W-9 → `payment_profiles.w9_file_url` + `w9_filename`
       - Alcohol cert → `contractor_profiles.alcohol_certification_file_url` + `_filename` + `alcohol_certification_expires_on=$expires_on`
     - COMMIT.

  On any failure between steps 7 sub-steps, ROLLBACK. R2 orphan object is acceptable (cleanup sweep is a §13 follow-up).

- [ ] **Step 2: Tests**

  - W-9 replace writes to `payment_profiles`
  - Alcohol cert replace requires expires_on, writes 3 fields
  - Invalid mime → 400, no history, no active-record change
  - File > 10 MB → 413
  - Path traversal in filename → sanitized
  - R2 failure → 502, no DB changes

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js
  git commit -m "feat(staff-portal): documents replace endpoint with R2-first ordering + slugify + cert expiry"
  ```

---

### Task 17: Email-change request + cancel endpoints (auth-gated)

**Spec ref:** Section 6.10.

**Files:**
- Modify: `server/routes/staffPortal.js`
- Modify: `server/routes/staffPortal.test.js`
- Modify: `server/middleware/rateLimiters.js` (new limiter)

- [ ] **Step 1: Rate-limiter**

  Add `emailChangeRequestLimiter`: 3 requests per user per 24h. Mount in `rateLimiters.js`.

- [ ] **Step 2: POST /api/me/request-email-change**

  Body `{ new_email }`. Auth-gated. Rate-limited.

  1. Validate format. Reject 409 if any other `users.email = new_email`.
  2. Mark any prior pending row for THIS user as `consumed_at=NOW()` (superseded).
  3. INSERT into `pending_email_changes` with `(user_id=req.user.id, new_email, token_hash=sha256(rawToken), expires_at=NOW()+'24 hours')`. Use `ON CONFLICT (LOWER(new_email)) DO NOTHING` per the partial unique index from Task 1. If 0 rows affected, return 409 `reason='already_pending'` (another user has a pending change to this email).
  4. Send two emails: `emailChangeVerification` to the NEW address (contains the raw token in a link to `/verify-email/:token`); `emailChangeWarning` to the OLD address (informs of the request with a "wasn't me, cancel via Profile" line).
  5. INSERT into `staff_audit_log` with `action='email_change_requested'`, `details={new_email}`.

- [ ] **Step 3: POST /api/me/cancel-pending-email-change**

  Auth-gated. Marks the requesting user's pending row(s) `consumed_at=NOW()`.

- [ ] **Step 4: Tests**

  - Format invalid → 400
  - Same email as current → 400
  - Email in use elsewhere → 409 email_in_use
  - Race: two POSTs in flight → one wins via UNIQUE index, the other gets 409 already_pending
  - Rate-limit fires on 4th request in 24h
  - Cancel marks pending row consumed_at

- [ ] **Step 5: Add the cleanup scheduler** (spec §6.10 step 10)

  Create `server/utils/pendingEmailChangeCleanup.js`. Exports `purgeExpiredPendingEmailChanges()` which does:

  ```sql
  DELETE FROM pending_email_changes
   WHERE consumed_at IS NOT NULL OR expires_at < NOW() - INTERVAL '7 days';
  ```

  (Consumed rows are kept for 7 days as a thin audit trail before purge, `staff_audit_log` carries the long-term record.)

  Wire into the existing scheduler pattern at `server/utils/schedulers.js` (or wherever the existing labrat/quote-draft cleanup schedulers live). Add a `RUN_PENDING_EMAIL_CLEANUP_SCHEDULER` env var (defaults on, set `false` to disable) matching the existing `RUN_*_SCHEDULER` pattern from CLAUDE.md. Tick interval: daily.

  Document the new env var in `.env.example` and CLAUDE.md.

- [ ] **Step 6: Commit**

  ```bash
  git add server/routes/staffPortal.js server/routes/staffPortal.test.js \
          server/middleware/rateLimiters.js \
          server/utils/pendingEmailChangeCleanup.js \
          server/utils/pendingEmailChangeCleanup.test.js \
          server/utils/schedulers.js \
          .env.example CLAUDE.md
  git commit -m "feat(staff-portal): email-change request + cancel + daily cleanup scheduler"
  ```

---

### Task 18: Email-change confirm endpoint (unauthenticated)

**Spec ref:** Section 6.10 (confirm-by-token-hash, not by req.user.id).

**Files:**
- Create: `server/routes/emailChange.js`
- Create: `server/routes/emailChange.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Skeleton (no auth middleware)**

  ```javascript
  const express = require('express');
  const crypto = require('crypto');
  const { pool } = require('../db');
  const asyncHandler = require('../middleware/asyncHandler');
  const { ValidationError, NotFoundError } = require('../utils/errors');

  const router = express.Router();
  // Note: NO router.use(auth), confirm is unauthenticated by design (§6.10)

  router.post('/confirm-email-change', asyncHandler(async (req, res) => { /* step 2 */ }));

  module.exports = router;
  ```

- [ ] **Step 2: Implement /confirm-email-change**

  1. Body `{ token }`.
  2. `token_hash = crypto.createHash('sha256').update(token).digest('hex')`.
  3. SELECT the matching row: `WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()`. If none, return 410 `reason='invalid_or_expired'`. Use `crypto.timingSafeEqual` to confirm the hash match after fetch (defense against edge timing attacks).
  4. Open transaction:
     - SELECT current `users.email` for the affected user.
     - UPDATE `users SET email = $new_email, token_version = token_version + 1 WHERE id = $user_id`.
     - UPDATE `pending_email_changes SET consumed_at = NOW() WHERE id = $row_id`.
     - INSERT into `staff_audit_log` with `action='email_change_confirmed'`, `details={old_email, new_email}`.
     - COMMIT.
  5. Send `emailChangeConfirmed` email to the OLD address.
  6. Return 200 with `{ ok: true }`.

- [ ] **Step 3: Mount in `server/index.js`**

  ```javascript
  app.use('/api/me', require('./routes/emailChange'));
  ```

  Mount this BEFORE the auth middleware applies to the catch-all `/api/me/*` paths. The router has no `auth` middleware so the order matters, confirm via curl that an unauthenticated POST reaches the handler.

- [ ] **Step 4: Tests**

  - Valid token confirms, bumps token_version
  - Expired token → 410
  - Consumed token → 410
  - Unknown token → 410
  - Lookup is by token_hash NOT by req.user.id (auth header ignored even if present)
  - Audit log row written
  - emailChangeConfirmed email sent to old address

- [ ] **Step 5: Commit**

  ```bash
  git add server/routes/emailChange.js server/routes/emailChange.test.js server/index.js
  git commit -m "feat(staff-portal): unauthenticated email-change confirm endpoint"
  ```

---

### Task 19: Admin cover-swap routes

**Spec ref:** Section 6.5 (admin one-click approve via JWT swapToken).

**Files:**
- Create: `server/routes/adminCoverSwaps.js`
- Create: `server/routes/adminCoverSwaps.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Skeleton with auth + admin guard + JWT verify**

  ```javascript
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const { pool } = require('../db');
  const { auth, requireAdminOrManager } = require('../middleware/auth');
  const asyncHandler = require('../middleware/asyncHandler');
  const { ValidationError, NotFoundError } = require('../utils/errors');

  const router = express.Router();
  router.use(auth);
  router.use(requireAdminOrManager);

  function verifySwapToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return null;
    }
  }

  router.get('/cover-swaps/:swapToken', asyncHandler(async (req, res) => { /* step 2 */ }));
  router.post('/cover-swaps/:swapToken', asyncHandler(async (req, res) => { /* step 3 */ }));

  module.exports = router;
  ```

- [ ] **Step 2: GET, render the confirm payload**

  1. `decoded = verifySwapToken(req.params.swapToken)`. If null, return 410 with `reason='expired_or_invalid'` (the client renders an "expired link" page).
  2. Look up `original_request` and `new_request` by IDs from the JWT.
  3. If `original_request.cover_requested_at IS NULL` (cascade already ran), return 200 with `{ status: 'already_resolved' }`.
  4. Else return 200 with `{ status: 'pending', original_request, new_request, shift, original_user, new_user }`.

- [ ] **Step 3: POST, trigger the cascade**

  1. Same JWT verification + already-resolved guard.
  2. Call into the existing `PUT /api/shifts/requests/:requestId` approval branch with the swap context. The cascade itself is built in Task 25 Step 2 of Phase 5.
  3. Return 200 on success.

- [ ] **Step 4: Mount in `server/index.js`**

  ```javascript
  app.use('/api/admin', require('./routes/adminCoverSwaps'));
  ```

- [ ] **Step 5: Tests**

  - Auth-gated: no JWT → 401
  - Non-admin → 403
  - Valid JWT but already resolved → 200 with `status='already_resolved'`
  - Invalid JWT → 410
  - Expired JWT (manually crafted) → 410
  - Replay after cascade → already_resolved (idempotency)

- [ ] **Step 6: Commit**

  ```bash
  git add server/routes/adminCoverSwaps.js server/routes/adminCoverSwaps.test.js server/index.js
  git commit -m "feat(staff-portal): admin cover-swap routes with JWT swapToken + auth guard"
  ```

---

### Task 20: staffPortal / emailChange / adminCoverSwaps test round-out

**Spec ref:** §11 Testing approach.

**Files:**
- Modify: `server/routes/staffPortal.test.js`
- Modify: `server/routes/emailChange.test.js`
- Modify: `server/routes/adminCoverSwaps.test.js`

- [ ] **Step 1: IDOR pass**

  Every PATCH / PUT / POST / DELETE on `/api/me/*`: authenticate as user B, try to mutate user A's data. Assert 403 / 404 (per existing error pattern) and verify user A's row is unchanged.

- [ ] **Step 2: Auth pass**

  Every endpoint that requires auth: hit without JWT, assert 401. Confirm endpoint that does NOT require auth: hit without JWT, ensure it reaches the handler.

- [ ] **Step 3: Run + commit**

  ```bash
  node --test server/routes/staffPortal.test.js \
              server/routes/emailChange.test.js \
              server/routes/adminCoverSwaps.test.js
  git add server/routes/staffPortal.test.js \
          server/routes/emailChange.test.js \
          server/routes/adminCoverSwaps.test.js
  git commit -m "test(staff-portal): IDOR + auth-gate coverage across new endpoints"
  ```

---

## Phase 5: Drop / Cover marketplace

### Task 21: SMS + email templates

**Spec ref:** §6.5 (cover_broadcast_sms, staff_drop_to_management_sms front-loaded), §6.10 (email-change templates).

**Files:**
- Modify: `server/utils/smsTemplates.js`
- Modify: `server/utils/smsTemplates.test.js`
- Modify: `server/utils/lifecycleEmailTemplates.js`
- Modify: `server/utils/lifecycleEmailTemplates.test.js`

- [ ] **Step 1: SMS templates**

  - `cover_broadcast_sms({ first_initial_last_initial, client_name, event_date_short, shift_role, shift_url })`
  - `staff_drop_to_management_sms({ staff_name, client_name, event_date_short, hours_to_event, reason })`, front-load: `"EMERGENCY DROP from ${staff_name}: ${reason_first_80}"` then append shift info.

- [ ] **Step 2: Email templates**

  - `emailChangeVerification({ new_email, token, expires_in_hours })`
  - `emailChangeWarning({ old_email, new_email, cancel_url })`
  - `emailChangeConfirmed({ old_email, new_email })`

- [ ] **Step 3: Tests**, char-budget checks for SMS, template-data-substitution checks for email.

- [ ] **Step 4: Commit**

  ```bash
  git add server/utils/smsTemplates.js server/utils/smsTemplates.test.js \
          server/utils/lifecycleEmailTemplates.js server/utils/lifecycleEmailTemplates.test.js
  git commit -m "feat(staff-portal): SMS + email templates for cover broadcast, emergency drop, email change"
  ```

---

### Task 22: broadcastCoverRequest helper + SKIP_REANCHOR_TYPES update

**Spec ref:** §6.5 (qualified-teammate filter, transaction-split pattern, 500-cap, positions_needed tolerance), §5.6 (SKIP_REANCHOR_TYPES).

**File-size guard.** `server/utils/staffShiftHandlers.js` is 742 lines today (over the 700 soft cap per CLAUDE.md). This task creates the helper in a NEW sibling file `server/utils/coverBroadcast.js` rather than appending to `staffShiftHandlers.js`. Keeps both files clean.

**Files:**
- Create: `server/utils/coverBroadcast.js`
- Create: `server/utils/coverBroadcast.test.js`
- Modify: `server/utils/rescheduleProposal.js` (SKIP_REANCHOR_TYPES update, see Step 4)

- [ ] **Step 1: Implement broadcastCoverRequest**

  ```javascript
  const { enqueueCategorizedMessage } = require('./messageScheduling');

  /**
   * Returns { broadcast_count, broadcast_truncated }.
   * NOT a transaction. Caller must have already committed the cover_requested_at flip.
   */
  async function broadcastCoverRequest(shiftId, requestingUserId) {
    // Step 1: read shift context (no row lock; the cover-request endpoint already committed)
    const { rows: shiftRows } = await pool.query(`
      SELECT s.id AS shift_id, s.positions_needed, s.event_date,
             p.client_name, p.id AS proposal_id
        FROM shifts s
        LEFT JOIN proposals p ON p.id = s.proposal_id
       WHERE s.id = $1
    `, [shiftId]);
    if (shiftRows.length === 0) return { broadcast_count: 0, broadcast_truncated: false };
    const shift = shiftRows[0];

    // Parse positions_needed tolerantly (heterogeneous shape; see §6.5)
    let positionsNeeded = [];
    try {
      const parsed = JSON.parse(shift.positions_needed || '[]');
      positionsNeeded = parsed.map(p => typeof p === 'string' ? p : p.position).filter(Boolean);
    } catch { positionsNeeded = ['bartender']; }

    // Step 2: resolve qualified teammates (500-cap, sorted by user_id ASC for determinism)
    const { rows: teammates } = await pool.query(`
      SELECT u.id, cp.preferred_name
        FROM users u
        JOIN contractor_profiles cp ON cp.user_id = u.id
       WHERE u.onboarding_status = 'approved'
         AND u.id <> $1
         AND cp.position = ANY($2::text[])
         AND (u.staff_notification_preferences->'channels'->'cover_needed') <> '[]'::jsonb
         AND NOT EXISTS (
           SELECT 1 FROM shift_requests sr
            WHERE sr.user_id = u.id
              AND sr.status = 'approved'
              AND sr.dropped_at IS NULL
              AND EXISTS (SELECT 1 FROM shifts s2 WHERE s2.id = sr.shift_id AND s2.event_date = $3)
         )
       ORDER BY u.id ASC
       LIMIT 501
    `, [requestingUserId, positionsNeeded, shift.event_date]);

    const truncated = teammates.length > 500;
    const targets = teammates.slice(0, 500);

    // Step 3: requester display
    const { rows: requesterRows } = await pool.query(
      `SELECT cp.preferred_name FROM contractor_profiles cp WHERE cp.user_id = $1`,
      [requestingUserId]
    );
    const requesterInitial = (requesterRows[0]?.preferred_name || '').trim()[0]?.toUpperCase() || '?';

    // Step 4: chunk enqueue (25 rows per batch, 250ms application-level delay between)
    const CHUNK = 25;
    let totalEnqueued = 0;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const chunk = targets.slice(i, i + CHUNK);
      await Promise.all(chunk.map(t => enqueueCategorizedMessage({
        userId: t.id,
        category: 'cover_needed',
        payload: {
          title: 'Cover needed',
          body:  `${requesterInitial}. needs a cover on ${formatShortDate(shift.event_date)}`,
          url:   `https://staff.drbartender.com/shifts/${shift.shift_id}`,
          sms_template: 'cover_broadcast_sms',
          sms_args: {
            first_initial_last_initial: `${requesterInitial}.`,
            client_name: shift.client_name,
            event_date_short: formatShortDate(shift.event_date),
            shift_role: positionsNeeded[0] || 'bartender',
            shift_url: `https://staff.drbartender.com/shifts/${shift.shift_id}`,
          },
        },
        sendAt: new Date(),
        entityType: 'shift',
        entityId: shift.shift_id,
        messageType: 'cover_broadcast',
      })));
      totalEnqueued += chunk.length;
      if (i + CHUNK < targets.length) await new Promise(r => setTimeout(r, 250));
    }

    return { broadcast_count: totalEnqueued, broadcast_truncated: truncated };
  }

  module.exports.broadcastCoverRequest = broadcastCoverRequest;
  ```

- [ ] **Step 2: Tests**

  - Broadcasts to qualified teammates only (position match)
  - Excludes requesting user
  - Excludes muted users (cover_needed channels empty)
  - Excludes teammates already on a same-date approved shift (`dropped_at IS NULL`)
  - Truncates at 500 with flag set
  - positions_needed JSON-object shape parsed correctly (`{position: 'bartender'}` style)
  - positions_needed string shape parsed correctly (`'bartender'` style)

- [ ] **Step 3: Update SKIP_REANCHOR_TYPES** (spec §5.6)

  In `server/utils/rescheduleProposal.js`, line 16 currently reads:
  ```javascript
  const SKIP_REANCHOR_TYPES = new Set(['post_event_wrap_up_email']);
  ```
  Add `'cover_broadcast'` (created by this task) and `'beo_unack_nudge_sms'` (from the BEO plan, if not already present):
  ```javascript
  const SKIP_REANCHOR_TYPES = new Set([
    'post_event_wrap_up_email',
    'cover_broadcast',
    'beo_unack_nudge_sms',
  ]);
  ```
  Reasoning: cover broadcasts target a SPECIFIC shift in a SPECIFIC time window (12h–14d out). If the proposal's event date moves, a stale broadcast referring to the old date would be misleading. The cover-request flow re-runs from scratch on the new date if the original requester still wants out.

- [ ] **Step 4: Commit**

  ```bash
  git add server/utils/coverBroadcast.js server/utils/coverBroadcast.test.js \
          server/utils/rescheduleProposal.js
  git commit -m "feat(staff-portal): coverBroadcast helper + SKIP_REANCHOR_TYPES update"
  ```

---

### Task 23: POST /api/shifts/requests/:requestId/drop (clean drop)

**Spec ref:** §6.5 (Clean drop endpoint).

**File-size guard.** `server/routes/shifts.js` is 839 lines today. Tasks 23-27 add 5 new endpoints (each ~50-100 lines with transactions / validation), landing them all in `shifts.js` would push it to ~1100 lines, breaching the 1000-line HARD cap; the pre-commit hook would BLOCK the commits. Tasks 23-27 therefore land the new endpoints in a NEW sibling file `server/routes/staffShiftActions.js`, mounted at the same `/api/shifts` prefix in `server/index.js`. Existing `shifts.js` routes (and Task 28's projection updates) stay where they are. Pattern: matches `server/routes/proposals/` per-concern split.

**Files:**
- Create: `server/routes/staffShiftActions.js` (this task creates the file with router skeleton + the drop endpoint)
- Create: `server/routes/staffShiftActions.test.js`
- Modify: `server/index.js` (mount the new router at `/api/shifts`)

- [ ] **Step 1: Implement the route**

  Inside one transaction:
  1. SELECT request + linked shift + proposal `FOR UPDATE` on the shift_requests row. Also LEFT JOIN `payout_events → payouts → pay_periods` to read `pay_period_status`.
  2. Verify ownership, pay-period not `'processing'` (NULL is fine, no payout yet), `hoursToEvent(shift) >= 336` (via the new `shiftTime.js` helper).
  3. UPDATE `shift_requests SET status='denied', dropped_at=NOW(), drop_reason='clean_drop'`.
  4. UPDATE the linked `shifts.status='open'` if no other `approved AND dropped_at IS NULL` staffer remains.
  5. Suppress all pending `scheduled_messages` rows targeting this user for this shift:

     ```sql
     UPDATE scheduled_messages
        SET status = 'suppressed'
      WHERE entity_type = 'shift' AND entity_id = $1
        AND recipient_id = $2 AND status = 'pending';
     ```

  6. Call existing `notifyAdminCategory({ category: 'urgent_staffing', subject, emailHtml, emailText, ...(daysOut <= 7 ? { smsBody } : {}) })`.
  7. COMMIT.

- [ ] **Step 2: Tests**

  - 14d+1h succeeds
  - 13d 23h returns 409 wrong_mode
  - pay_period 'processing' returns 409 pay_period_processing
  - NULL payout_events passes through (no processing period exists)
  - Other approved staffers still on shift: shifts.status not flipped
  - All staffers off shift: shifts.status flips to 'open'
  - Other scheduled_messages targeting this user+shift suppressed
  - IDOR: not your shift → 403

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/staffShiftActions.js server/routes/staffShiftActions.test.js \
          server/index.js
  git commit -m "feat(staff-portal): staffShiftActions router + POST /requests/:id/drop"
  ```

---

### Task 24: POST /api/shifts/requests/:requestId/request-cover

**Spec ref:** §6.5 (Transaction A + outside-batch broadcast).

**Files:** Modify `server/routes/staffShiftActions.js` (extend with the new endpoint; Tasks 25-27 also land here).

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/routes/shifts.test.js`

- [ ] **Step 1: Implement Transaction A + outside-batch broadcast**

  Transaction A (fast):
  1. SELECT request + shift `FOR UPDATE`. Verify ownership, pay-period not processing, `hoursToEvent ∈ [72, 336)`.
  2. UPDATE `shift_requests SET cover_requested_at=NOW(), cover_reason=$reason` (reason truncated to 500; 413 above).
  3. Notify management (urgent_staffing, email always, SMS if `daysOut <= 7`).
  4. COMMIT.

  Then OUTSIDE the transaction (no row lock held):

  5. Call `broadcastCoverRequest(shift.id, req.user.id)` from Task 22.
  6. Return 200 with `{ broadcast_count, broadcast_truncated }`.

- [ ] **Step 2: Tests**

  - 72h+1h triggers broadcast
  - 14d+1h returns 409 wrong_mode
  - <72h returns 409 wrong_mode
  - 7d-1h: SMS to management
  - 7d+1h: email-only to management
  - Broadcast count returned in response
  - Response time is fast (Transaction A commits quickly, broadcast runs after)

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/staffShiftActions.js server/routes/staffShiftActions.test.js
  git commit -m "feat(staff-portal): POST /requests/:id/request-cover (Transaction A + outside-batch)"
  ```

---

### Task 25: POST /api/shifts/requests/:shiftId/claim-cover + cascade

**Spec ref:** §6.5 (claim-cover with UPSERT + position eligibility + JWT swapToken; PUT approval branch extension for the cascade).

**Files:**
- Modify: `server/routes/staffShiftActions.js` (claim-cover endpoint)
- Modify: `server/routes/staffShiftActions.test.js`
- Modify: `server/routes/shifts.js` (the cascade extends the EXISTING `PUT /api/shifts/requests/:requestId` approval branch, that endpoint lives in `shifts.js` already)
- Modify: `server/routes/shifts.test.js`

- [ ] **Step 1: Implement claim-cover route**

  Inside one transaction:
  1. SELECT the original cover-requesting `shift_requests` row `FOR UPDATE` (`shift_id=:shiftId AND cover_requested_at IS NOT NULL AND status='approved' AND dropped_at IS NULL`). If none: return 409 `reason='no_active_cover_request'`.
  2. Verify `shifts.status` not `'cancelled'`, pay_period not `'processing'`.
  3. Verify `req.user.id !== original.user_id`.
  4. Verify position eligibility: claimer's `contractor_profiles.position` is in `shifts.positions_needed`.
  5. UPSERT new pending row (handles `UNIQUE(shift_id, user_id)`):

     ```sql
     INSERT INTO shift_requests (shift_id, user_id, status, replaced_by_request_id)
     VALUES ($1, $2, 'pending', $3)
     ON CONFLICT (shift_id, user_id) DO UPDATE
       SET status = 'pending',
           replaced_by_request_id = EXCLUDED.replaced_by_request_id,
           dropped_at = NULL,
           drop_reason = NULL,
           cover_requested_at = NULL
       WHERE shift_requests.status <> 'approved'
       RETURNING id;
     ```

     If `rows.length === 0`, the existing row was already approved, reject 409 `reason='already_approved'`.
  6. Sign a swap-token JWT: `{ original_request_id, new_request_id, exp: NOW+7d, jti: uuid() }`.
  7. Send the approve-link email to management with URL `${ADMIN_URL}/admin/shifts/cover-swaps/${swapToken}`.
  8. COMMIT.

  If the email send fails after COMMIT, log Sentry but don't roll back. Admin can still approve via the normal Shifts dashboard.

- [ ] **Step 2: Extend the existing PUT /api/shifts/requests/:requestId approval branch**

  When the approved request has `replaced_by_request_id` set:

  Inside the same approval transaction:
  1. UPDATE the original: `status='denied', dropped_at=NOW(), drop_reason='covered_by_request:<new_id>', cover_requested_at=NULL`.
  2. UPDATE remaining `cover_broadcast` rows for this shift to `status='suppressed'`.
  3. Fire `scheduleStaffShiftMessages` for the NEW staffer.
  4. If `drink_plans.finalized_at IS NOT NULL`, schedule the BEO acknowledge-nudge for the new staffer.
  5. COMMIT.

  All 5 steps in one transaction. Mid-cascade failure rolls back: original stays active, broadcast rows stay pending so another teammate can still claim.

- [ ] **Step 3: Tests**

  - claim-cover successful, swap-token JWT in email
  - Original requester cannot claim own cover
  - Position-ineligible claimer (barback for bartender slot) → 403
  - Concurrent claims: FOR UPDATE serializes; second sees already-covered
  - Prior-denied row gets UPSERTed back to pending
  - Existing approved row → 409 already_approved
  - PUT approval cascade: original flipped to denied, broadcast rows suppressed, BEO nudge inserted

- [ ] **Step 4: Commit**

  ```bash
  git add server/routes/staffShiftActions.js server/routes/staffShiftActions.test.js \
          server/routes/shifts.js server/routes/shifts.test.js
  git commit -m "feat(staff-portal): POST /claim-cover with UPSERT + cover-approval cascade in PUT branch"
  ```

---

### Task 26: POST /api/shifts/requests/:requestId/emergency-drop

**Spec ref:** §6.5 (emergency-drop with ADMIN_PHONE proper conflation + proposal_id derivation).

**Files:**
- Modify: `server/routes/staffShiftActions.js`
- Modify: `server/routes/staffShiftActions.test.js`

- [ ] **Step 1: Implement the route**

  UI shows PII warning under the textarea: *"Don't include sensitive medical or personal details. Admins can see this and it's retained in our records."* Body `{ reason: string (10..500 chars) }`.

  Inside one transaction:
  1. SELECT context `FOR UPDATE`. Verify ownership, `hoursToEvent < 72`. Pay-period guard does NOT apply.
  2. UPDATE with `dropped_at=NOW(), drop_reason=$reason (truncated 500), drop_emergency=true`. Status stays `'approved'`.
  3. Suppress all pending scheduled_messages for this user+shift (same UPDATE as Task 23 step 5).
  4. Notify management:
     - Email via `notifyAdminCategory('urgent_staffing', ...)`, resolves admin recipients from admin users' DB rows.
     - SMS via the same `notifyAdminCategory` (admin users' phones).
     - ADDITIONALLY: if `process.env.ADMIN_PHONE` is set, `sendAndLogSms({ to: process.env.ADMIN_PHONE, body: front_loaded_template })`. The env var is a separate emergency hotline (Dallas's personal phone), distinct from the admin-user-phone fan-out.
     - If `ADMIN_PHONE` unset, fire `Sentry.captureMessage('Emergency-drop hotline SMS skipped: ADMIN_PHONE not configured')`.
  5. INSERT into `proposal_activity_log` with `proposal_id=shift.proposal_id` (from the SELECT in step 1), `action='emergency_drop_requested'`, `actor_type='staff'`, `actor_id=req.user.id`, `details={reason, hours_out, shift_id, request_id}`. If `shift.proposal_id IS NULL`, skip with Sentry warning.
  6. COMMIT.

- [ ] **Step 2: Tests**

  - reason <10 chars → 400
  - reason >500 chars → 413
  - 72h+1h → 409 wrong_mode
  - 71h 59m → succeeds, status stays approved, dropped_at set
  - ADMIN_PHONE set → hotline SMS fires
  - ADMIN_PHONE unset → Sentry captureMessage fires, email + admin-user SMS still go
  - proposal_id derived from shift

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/staffShiftActions.js server/routes/staffShiftActions.test.js
  git commit -m "feat(staff-portal): POST /emergency-drop with ADMIN_PHONE hotline + audit log"
  ```

---

### Task 27: DELETE /api/shifts/requests/:requestId (Withdraw)

**Spec ref:** §6.3 (Mine sub-tab Withdraw button).

**Files:**
- Modify: `server/routes/staffShiftActions.js`
- Modify: `server/routes/staffShiftActions.test.js`

- [ ] **Step 1: Implement DELETE**

  Verify ownership, require `status='pending'`. DELETE the row. Return 200. If `status` is approved or denied → 409 with the specific reason.

- [ ] **Step 2: Tests**

  - Pending request DELETEs successfully
  - Approved request → 409 already_approved
  - IDOR: not your request → 403

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/staffShiftActions.js server/routes/staffShiftActions.test.js
  git commit -m "feat(staff-portal): DELETE /requests/:id Withdraw endpoint"
  ```

---

### Task 28: Existing shifts projection updates

**Spec ref:** §6.3.

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/routes/shifts.test.js`

- [ ] **Step 1: Extend `GET /api/shifts` (staff path)**

  Add to the SELECT: `drink_plan_finalized_at` (LEFT JOIN drink_plans), `my_beo_acknowledged_at` (LEFT JOIN shift_requests on requesting user), `cover_requested_at`, `cover_for_first_initial` (LEFT JOIN contractor_profiles for the cover-requesting user's preferred_name).

- [ ] **Step 2: Extend `GET /api/shifts/user/:userId/events`**

  Verify `req.user.id === userId` (IDOR guard). Add `payout_id` per past row via LEFT JOIN to `payout_events → payouts`.

- [ ] **Step 3: Tests**, new projections appear in response shape; IDOR enforced.

- [ ] **Step 4: Commit**

  ```bash
  git add server/routes/shifts.js server/routes/shifts.test.js
  git commit -m "feat(staff-portal): extend shifts endpoint projections for new portal pages"
  ```

---

## Phase 6: Client shell + theme + early route mount

### Task 29: Port skin-aware CSS tokens to index.css

**Spec ref:** §6.16 (Theme persistence).

**Files:**
- Modify: `client/src/index.css`

- [ ] **Step 1: Read the design source**

  `~/Downloads/Dr Bartender (6)/staff/styles.css` (personal-machine path; coordinate with user if running in a different environment). Extract `:root` + `[data-skin="light"]` + `[data-skin="dark"]` token blocks.

- [ ] **Step 2: Append to client/src/index.css**

  Namespace under a comment block. Avoid collisions with existing `:root` variables. If a name conflict exists, prefix the new ones with `--sp-` (staff portal).

- [ ] **Step 3: Visual check via dev tools**

  Open the app, manually set `<html data-skin="dark">` in DevTools, confirm computed `--sp-*` variables resolve.

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/index.css
  git commit -m "feat(staff-portal): port skin-aware design tokens to index.css"
  ```

---

### Task 30: StaffShell.js + StaffUserPillMenu.js

**Spec ref:** §6.1.

**Files:**
- Create: `client/src/components/StaffShell.js`
- Create: `client/src/components/StaffUserPillMenu.js`

- [ ] **Step 1: StaffShell**

  Props: `tabs`, `active`, `onTabChange`, `badges`, `user`, `userMenu`, `skin`, `onSkinChange`, `children`.

  - `<header>` with brand mark + user-pill button (opens menu).
  - `<nav>` 4-tab bar with badge dots.
  - `<main>` children.
  - useEffect on skin → `document.documentElement.dataset.skin = skin`.

- [ ] **Step 2: StaffUserPillMenu**

  Modal with scrim. Avatar + name + email card, Lighting segmented control, 5 menu items (Edit profile / Calendar sync / Notification preferences / Get support / Sign out).

- [ ] **Step 3: Commit**

  ```bash
  git add client/src/components/StaffShell.js client/src/components/StaffUserPillMenu.js
  git commit -m "feat(staff-portal): StaffShell + UserPillMenu (no mount yet)"
  ```

---

### Task 31: Early stub mount + theme persistence wire-up

**Spec ref:** §6.16 + the dead-code-window fix.

**Files:**
- Modify: `client/src/App.js`
- Create: `client/src/components/StaffShellWithThemeWiring.js` (small wrapper around StaffShell that fetches `/api/me` on mount, hydrates theme from `ui_preferences.theme`, falls back to `prefers-color-scheme`, persists toggles via `PATCH /api/me/ui-preferences`)
- Create: `client/src/components/staff/Placeholder.js` (trivial component rendering `<div className="sp-placeholder">{name} coming soon</div>`, replaced one-by-one as Tasks 32-47 land their real implementations)

- [ ] **Step 1: Add a temporary /staff-v2 stub mount**

  Inside `StaffSiteRoutes()`, ADD a parallel route block (do NOT remove the existing StaffLayout mount yet):

  ```jsx
  <Route path="/staff-v2/*" element={<RequirePortal><StaffShellWithThemeWiring /></RequirePortal>}>
    <Route index element={<Placeholder name="Home" />} />
    <Route path="shifts/*" element={<Placeholder name="Shifts" />} />
    <Route path="pay/*" element={<Placeholder name="Pay" />} />
    <Route path="tip-card" element={<Placeholder name="Tip Card" />} />
    <Route path="account/:section" element={<Placeholder name="Account" />} />
  </Route>
  ```

  `<Placeholder name="X">` is a trivial component rendering "X coming soon" so subsequent tasks (HomePage, ShiftsPage, etc.) can swap in their real implementations one at a time.

  `<StaffShellWithThemeWiring>` is a small wrapper that fetches `/api/me` on mount, hydrates skin from `ui_preferences.theme` (falls back to OS prefers-color-scheme), and wires `onSkinChange` to `PATCH /api/me/ui-preferences`.

- [ ] **Step 2: Verify cross-device theme persistence**

  Sign in on browser A at `/staff-v2/`, toggle theme to dark. Reload. Confirm dark persists. Sign in on browser B, confirm dark loads. Toggle to light on B. Reload A, confirm light loads.

- [ ] **Step 3: Commit**

  ```bash
  git add client/src/App.js
  git commit -m "feat(staff-portal): /staff-v2 stub mount + theme persistence wire-up"
  ```

  Note: this stub mount survives until Task 48 (the production cutover swap), at which point both blocks are unified.

---

## Phase 7: Shifts surface (now in-browser verifiable)

### Task 32: ShiftCard.js (shared)

**Spec ref:** §6.2 + §6.3.

**Files:**
- Create: `client/src/components/staff/ShiftCard.js`

- [ ] **Step 1: Implement the card**

  Props: `shift`, `showConfirmFlag`, `onClick`, `variant`. Uses `getEventTypeLabel({ event_type, event_type_custom })` from `client/src/utils/eventTypes.js`.

- [ ] **Step 2: Smoke-render in browser**

  Replace one of the `<Placeholder name="Shifts">` routes with a tiny test page that renders ShiftCard with mock data.

- [ ] **Step 3: Commit + revert the test mount**

  ```bash
  git add client/src/components/staff/ShiftCard.js
  git commit -m "feat(staff-portal): shared ShiftCard component"
  ```

---

### Task 33: Extended GET /api/beo/:proposalId projection (team_roster)

**Spec ref:** §6.18.

**Files:**
- Modify: `server/routes/beo.js`
- Modify: `server/routes/beo.test.js`

- [ ] **Step 1: Add team_roster array**

  ```javascript
  const { rows: rosterRows } = await pool.query(`
    SELECT sr.user_id,
           sr.position AS role,
           sr.cover_requested_at,
           cp.preferred_name,
           cp.phone,
           a.full_name AS applications_name,
           ag.full_name AS agreements_name,
           u.email
      FROM shift_requests sr
      JOIN shifts s ON s.id = sr.shift_id
      LEFT JOIN users u ON u.id = sr.user_id
      LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      LEFT JOIN applications a ON a.user_id = sr.user_id
      LEFT JOIN agreements ag ON ag.user_id = sr.user_id
     WHERE s.proposal_id = $1
       AND sr.status = 'approved'
       AND sr.dropped_at IS NULL  -- hybrid-state filter per §6.5
       AND s.canceled_at IS NULL
     ORDER BY sr.id
  `, [proposalId]);

  // Determine viewer's own approval status for this proposal
  const { rows: viewerRows } = await pool.query(
    `SELECT 1 FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
      WHERE s.proposal_id = $1 AND sr.user_id = $2 AND sr.status = 'approved' AND sr.dropped_at IS NULL
      LIMIT 1`,
    [proposalId, req.user.id]
  );
  const viewerApproved = viewerRows.length > 0;

  function computeName(row) {
    const preferred = (row.preferred_name || '').trim();
    if (preferred) {
      const legal = (row.applications_name || row.agreements_name || '').trim();
      const last = legal.split(/\s+/).pop()?.[0]?.toUpperCase();
      return last ? `${preferred} ${last}.` : preferred;
    }
    const legal = (row.applications_name || row.agreements_name || '').trim();
    if (legal) {
      const parts = legal.split(/\s+/);
      return parts.length >= 2 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
    }
    return (row.email || 'staff').split('@')[0];
  }

  const team_roster = rosterRows.map(r => {
    const name = computeName(r);
    return {
      user_id: r.user_id,
      display_name: name,
      initials: (name.match(/(\S)\S*\s+(\S)/)?.slice(1).join('') || name.slice(0, 2)).toUpperCase(),
      is_me: r.user_id === req.user.id,
      role: r.role || 'Bartender',
      // Phone gated by viewer's own approval status (§6.18)
      phone: viewerApproved ? (r.phone || null) : null,
      needs_cover: r.cover_requested_at != null,
    };
  });
  ```

- [ ] **Step 2: Tests**

  - Display name uses preferred + last initial chain
  - Falls back through applications → agreements → email-local-part
  - is_me flips for own row
  - Phone NULL when viewer not approved on the proposal
  - Phone surfaces when viewer is approved
  - dropped_at IS NULL filters out emergency-dropped staffers

- [ ] **Step 3: Commit**

  ```bash
  git add server/routes/beo.js server/routes/beo.test.js
  git commit -m "feat(staff-portal): add team_roster to GET /api/beo with dropped_at filter + phone gating"
  ```

---

### Task 34: TeamRosterCard.js

**Spec ref:** §6.4.

**Files:**
- Create: `client/src/components/staff/TeamRosterCard.js`

- [ ] **Step 1: Implement**

  Renders only when `team_roster.length > 0`. Avatar + display_name + role (when set). "You" pill on own row, no contact actions on self. Call / text icon buttons for others (only render when `phone` is non-null). "Needs cover" indicator when `needs_cover === true`.

- [ ] **Step 2: Commit**

  ```bash
  git add client/src/components/staff/TeamRosterCard.js
  git commit -m "feat(staff-portal): TeamRosterCard component"
  ```

---

### Task 35: HomePage.js

**Spec ref:** §6.2.

**Files:**
- Create: `client/src/pages/staff/HomePage.js`
- Modify: `client/src/App.js` (replace the `/staff-v2/` index `<Placeholder name="Home" />` with `<HomePage />`)

- [ ] **Step 1: Implement HomePage**

  Calls `api.get('/me/staff-home')` on mount + on tab focus. Renders Hero, "Needs you" tray (conditional), Next shift card, This pay period tile, Open shifts teaser. Loading / empty / error / disabled states per §6.1.5.

- [ ] **Step 2: Verify in-browser**

  Sign in as test staffer with one upcoming shift, one pending request, one teammate cover. Confirm all sections render at `/staff-v2/`.

- [ ] **Step 3: Commit**

  ```bash
  git add client/src/pages/staff/HomePage.js client/src/App.js
  git commit -m "feat(staff-portal): HomePage with staff-home composite data"
  ```

---

### Task 36: ShiftsPage.js with sub-tabs

**Spec ref:** §6.3.

**Files:**
- Create: `client/src/pages/staff/ShiftsPage.js`
- Modify: `client/src/App.js` (swap `/staff-v2/shifts/*` placeholder for ShiftsPage)

- [ ] **Step 1: Implement Available / Mine / Past sub-tabs**

  URL-driven: `/staff-v2/shifts/available`, `/mine`, `/past`. Default redirects to `/available`. Empty + loading + error states per §6.1.5.

- [ ] **Step 2: Wire endpoints**

  Available → `/api/shifts` (staff path). Mine → `/api/shifts/user/:userId/events`. Past → same with completed filter. Withdraw button on pending rows → `DELETE /api/shifts/requests/:id`.

- [ ] **Step 3: Cover-needed visual treatment + claim flow**

  When `cover_requested_at IS NOT NULL`, accent border + cover-needed banner + "Cover this" button → `POST /api/shifts/requests/:shiftId/claim-cover`.

- [ ] **Step 4: Verify in-browser** at `/staff-v2/shifts/`.

- [ ] **Step 5: Commit**

  ```bash
  git add client/src/pages/staff/ShiftsPage.js client/src/App.js
  git commit -m "feat(staff-portal): ShiftsPage with Available/Mine/Past sub-tabs"
  ```

---

### Task 37: ShiftDetail.js + DropCoverModal.js

**Spec ref:** §6.4, §6.5.

**Files:**
- Create: `client/src/pages/staff/ShiftDetail.js`
- Create: `client/src/components/staff/DropCoverModal.js`
- Modify: `client/src/App.js` (add `/staff-v2/shifts/:shiftId`)

- [ ] **Step 1: ShiftDetail page**

  Calls `api.get('/beo/:proposalId')` to fetch BEO + team_roster (proposalId from shift). Sections per §6.4: back, title, quick-status chips, key info grid, action row, "Banquet Event Order" heading, TeamRosterCard, drinks card, addons, logistics, custom menu, notes, consult input, shopping list link, Drop/Cover card, sticky Confirm action bar.

  Confirm action bar calls `POST /api/beo/:proposalId/acknowledge` (from BEO plan).

- [ ] **Step 2: DropCoverModal with 3 modes**

  Mode determined by `hoursToEvent`. Drop / Cover / Emergency. Each mode posts to its respective endpoint from Tasks 23-26. Emergency mode includes the PII warning under the textarea.

- [ ] **Step 3: Verify** all three modes in-browser at `/staff-v2/shifts/<id>`.

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/pages/staff/ShiftDetail.js client/src/components/staff/DropCoverModal.js client/src/App.js
  git commit -m "feat(staff-portal): ShiftDetail (BEO viewer + team roster) + DropCoverModal"
  ```

---

## Phase 8: Pay + Tip Card + publicTip extension

### Task 38: PayoutEventRow.js + PayoutDetail.js

**Spec ref:** §6.7.

**Files:**
- Create: `client/src/components/staff/PayoutEventRow.js`
- Create: `client/src/pages/staff/PayoutDetail.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: PayoutEventRow**, one row per `payout_event`. Highlights when `?shift=` query param matches.

- [ ] **Step 2: PayoutDetail**, fetches `GET /api/payouts/:periodId` (existing). Sections per §6.7: back, title, period range + event count, banner with total + status chip, Summary card, per-event detail cards, Download PDF if paid + Email a copy + italic 1099 reminder.

- [ ] **Step 3: Verify** auto-scroll-to-shift behavior with `?shift=` query.

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/components/staff/PayoutEventRow.js \
          client/src/pages/staff/PayoutDetail.js \
          client/src/App.js
  git commit -m "feat(staff-portal): PayoutDetail with shift cross-link highlight + 1099 reminder"
  ```

---

### Task 39: PayPage.js

**Spec ref:** §6.6.

**Files:**
- Create: `client/src/pages/staff/PayPage.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: Implement**

  Hero "My Pay", current pay period banner with status chip, line items expandable to wage/gratuity/card-tip/adjustment breakdown, Year-to-date roll-up card, Paystubs list.

- [ ] **Step 2: Commit**

  ```bash
  git add client/src/pages/staff/PayPage.js client/src/App.js
  git commit -m "feat(staff-portal): PayPage with YTD card"
  ```

---

### Task 40: TipCardPage.js

**Spec ref:** §6.8.

**Files:**
- Create: `client/src/pages/staff/TipCardPage.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: Implement**

  Hero "Tip Card" + QR card preview + a row of three action buttons per spec §6.8: **Open print page** (opens `/my-tip-page/print` in a new tab), **Share link** (system share sheet via `navigator.share()` falling back to copy), **Copy URL** (clipboard write with "Copied" toast). "Tips received this week" card from existing `GET /api/me/tips` (`server/routes/me.js:190`). "How it's shown on your card" reorder card with drag-grip + arrow buttons. PUTs to `/api/me/tip-card-order` on every reorder; PUTs are serialized client-side (queue subsequent drags until response).

- [ ] **Step 2: Commit**

  ```bash
  git add client/src/pages/staff/TipCardPage.js client/src/App.js
  git commit -m "feat(staff-portal): TipCardPage with drag-to-reorder"
  ```

---

### Task 41: publicTip.js consumer extension

**Spec ref:** §6.8 (load-bearing for money flow).

**Files:**
- Modify: `server/routes/publicTip.js`
- Modify: `server/routes/publicTip.test.js`

- [ ] **Step 1: Extend the route**

  1. JOIN `users u ON u.id = payment_profiles.user_id` to project `u.ui_preferences->'tip_card_order'`.
  2. Add `zelle_handle` to the chooser projection.
  3. Order the chooser methods by the staffer's saved order. Fallback: methods present on profile but absent from order array fall to end in natural order. Methods in order array but absent from profile are skipped.
  4. Response header: `Cache-Control: private, no-cache`.

- [ ] **Step 2: Tests**

  - Public response carries the new Zelle handle when set
  - Method order matches staffer's saved order
  - Methods not on staffer's profile are skipped even if in the order array
  - Cache-Control header set

- [ ] **Step 3: End-to-end verify**

  - On TipCardPage, reorder methods
  - In another browser, hit `/tip/:token` directly
  - Confirm order matches within seconds (no CDN staleness)

- [ ] **Step 4: Commit**

  ```bash
  git add server/routes/publicTip.js server/routes/publicTip.test.js
  git commit -m "feat(staff-portal): extend publicTip with tip_card_order + zelle_handle + no-cache"
  ```

---

## Phase 9: AccountPage

### Task 42: AccountPage shell + nav

**Spec ref:** §6.9.

**Files:**
- Create: `client/src/pages/staff/account/AccountPage.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: Shell with horizontal sub-nav**

  5 sub-sections: Profile / Payments / Calendar / Notifications / Documents. URL-driven via `/staff-v2/account/:section`.

- [ ] **Step 2: Back button** returns to the previously-active main tab.

- [ ] **Step 3: Commit**

  ```bash
  git add client/src/pages/staff/account/AccountPage.js client/src/App.js
  git commit -m "feat(staff-portal): AccountPage shell with horizontal sub-nav"
  ```

---

### Task 43: ProfileSection.js + EmailVerifyPage.js

**Spec ref:** §6.10 (Profile + email-change verification flow).

**Files:**
- Create: `client/src/pages/staff/account/ProfileSection.js`
- Create: `client/src/pages/staff/EmailVerifyPage.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: ProfileSection**

  Form fields: preferred_name, phone, email, mailing address (4 sub-fields), emergency contact (name/phone/relationship). Saves via `PATCH /api/me/profile` for non-email fields.

  Email row has its own Save: opens a confirmation modal, POSTs to `/api/me/request-email-change`. Banner appears after with "Pending verification, check [new email]" + Cancel button.

- [ ] **Step 2: EmailVerifyPage**

  UNAUTHENTICATED React route at `/verify-email/:token` (added to App.js OUTSIDE `<RequirePortal>` since the user may click from a logged-out browser). Renders a "Confirm email change" page with one Confirm button. On click, POSTs to `/api/me/confirm-email-change` with `{ token }`. Success → "Email updated. Sign in again" (sign-out the current session since `token_version` bumped). Failure → "Link expired or already used."

- [ ] **Step 3: Commit**

  ```bash
  git add client/src/pages/staff/account/ProfileSection.js \
          client/src/pages/staff/EmailVerifyPage.js \
          client/src/App.js
  git commit -m "feat(staff-portal): ProfileSection + EmailVerifyPage with verification flow"
  ```

---

### Task 44: PaymentMethodsSection.js + AddMethodModal.js

**Spec ref:** §6.11.

**Files:**
- Create: `client/src/pages/staff/account/PaymentMethodsSection.js`
- Create: `client/src/pages/staff/account/AddMethodModal.js`

- [ ] **Step 1: Top "Payroll routes to" pill** with [Change] action.

- [ ] **Step 2: Methods on file list**, Card always-on, P2P methods, payroll-only methods. Per-row Set as preferred (where eligible), edit, remove.

- [ ] **Step 3: AddMethodModal** with category picker → method picker → input form (handle for P2P, routing/account for direct deposit, no input for check).

- [ ] **Step 4: Footer disclaimer** rendered verbatim from spec §6.11 / §3.4: *"Card payments settle through Dr. Bartender and appear as card_tip_net_cents on your paystub. It's your responsibility to enter handles correctly. Payments sent to typos are not our liability."* Italic small text below the methods list.

- [ ] **Step 5: Verify**, add Venmo, set as preferred, clear it, confirm pill flips to "No payroll method set."

- [ ] **Step 6: Commit**

  ```bash
  git add client/src/pages/staff/account/PaymentMethodsSection.js \
          client/src/pages/staff/account/AddMethodModal.js
  git commit -m "feat(staff-portal): PaymentMethodsSection + AddMethodModal with disclaimer"
  ```

---

### Task 45: CalendarSyncSection.js

**Spec ref:** §6.12.

**Files:**
- Create: `client/src/pages/staff/account/CalendarSyncSection.js`

- [ ] **Step 1: Subscribe buttons** for Google / Apple / Outlook (deep links composed against the existing feed URL with `users.calendar_token`).

- [ ] **Step 2: Subscription URL block** with Copy button + Regenerate URL action calling `POST /api/calendar/token/regenerate`.

- [ ] **Step 3: Last sync sub-section** with empty-state handling for null `last_ics_fetch_at` and missing `calendar_subscribed_app` JSONB key. Tooltip on the app-name chip explaining the UA detection is best-effort.

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/pages/staff/account/CalendarSyncSection.js
  git commit -m "feat(staff-portal): CalendarSyncSection with empty states + token regen"
  ```

---

### Task 46: NotificationsSection.js (Phase A: Push gated off)

**Spec ref:** §6.13.

**Files:**
- Create: `client/src/pages/staff/account/NotificationsSection.js`
- Create: `client/src/pages/staff/account/IOSCoachmark.js` (stub for Phase A)

- [ ] **Step 1: 8×3 matrix render** with rows from §6.13 table. Pulls from `GET /api/me/staff-notifications`. Push column disabled with "Coming in v1.5" tooltip.

- [ ] **Step 2: Per-row override indicator** (§6.13 migration guard companion): when a category's SMS channel would be silently overridden by `communication_preferences.sms_enabled=false`, render a strikethrough on the SMS toggle + tooltip *"Global SMS is off (you replied STOP). Reply START to your last Dr Bartender text to re-enable."*

- [ ] **Step 3: Combined-state UI guard**, when proposing a save that would leave a critical category with no channel, show inline error and block the toggle.

- [ ] **Step 4: Critical-path footer copy** per §6.13.

- [ ] **Step 5: Commit**

  ```bash
  git add client/src/pages/staff/account/NotificationsSection.js \
          client/src/pages/staff/account/IOSCoachmark.js
  git commit -m "feat(staff-portal): NotificationsSection (Phase A: Push gated, kill-switch indicator)"
  ```

---

### Task 47: DocumentsSection.js + ReplaceConfirmModal.js

**Spec ref:** §6.14.

**Files:**
- Create: `client/src/pages/staff/account/DocumentsSection.js`
- Create: `client/src/pages/staff/account/ReplaceConfirmModal.js`

- [ ] **Step 1: Reference + My documents sections**

  Field Guide link, W-9 row (Replace button), Independent Contractor Agreement row (no Replace), Alcohol certification row with expiry treatment (within 60 days = "Expires soon" tag + nudge, past expiry = "Expired" red tag). Empty-state copy for legacy rows with no `alcohol_certification_expires_on`.

- [ ] **Step 2: ReplaceConfirmModal**

  W-9 variant: file picker. Alcohol cert variant: file picker + REQUIRED date input (must be future). Multipart POST to `/api/me/documents/:doc_type/replace`.

- [ ] **Step 3: Other archives**, Paystubs link to `/pay`.

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/pages/staff/account/DocumentsSection.js \
          client/src/pages/staff/account/ReplaceConfirmModal.js
  git commit -m "feat(staff-portal): DocumentsSection with replace + alcohol-cert expiry capture"
  ```

---

## Phase 10: Cutover + cleanup + docs

### Task 48: App.js StaffSiteRoutes block swap (commit 1)

**Spec ref:** §6.1.

**Files:**
- Modify: `client/src/App.js`

- [ ] **Step 1: Swap StaffSiteRoutes block only**

  Inside `StaffSiteRoutes()` (the function starts at line 298): the `<RequirePortal><StaffLayout/></RequirePortal>` wrapper is at line 316. Replace it with `<RequirePortal><StaffShell.../>...</RequirePortal>`. Mount the production routes:

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

  Plus the unauth `/verify-email/:token` route mounted at the App.js root (OUTSIDE RequirePortal).

  Resolve the HomePage import collision: the existing `import HomePage from './pages/website/HomePage'` at App.js:14 must be aliased: `import WebsiteHomePage from './pages/website/HomePage'` and the `/website` route element updated to `<WebsiteHomePage/>`. Then the new `import HomePage from './pages/staff/HomePage'` (lazy) goes in alongside.

  Keep `/my-tip-page/print` mounted (renders `<PrintTipCard/>`); the print route is shared with the public tip page and physical-card production.

  Remove the `/staff-v2/` stub mount in the same commit. Its purpose is served, production routes now live at `/`.

- [ ] **Step 2: Verify build**

  ```bash
  CI=true npm --prefix client run build
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add client/src/App.js
  git commit -m "feat(staff-portal): mount production routes in StaffSiteRoutes (cutover step 1)"
  ```

---

### Task 49: App.js HiringRoutes block swap + redirects (commit 2)

**Spec ref:** §6.1.

**Files:**
- Modify: `client/src/App.js`

- [ ] **Step 1: Swap HiringRoutes block**

  Same `StaffShell` wrapper + same production routes, but inside `HiringRoutes()` around line 273. The hiring subdomain hosts staff routes for new hires immediately post-onboarding, so the cutover must reach both blocks.

- [ ] **Step 2: Redirect routes for the 30-day grace period**

  Add to BOTH blocks:

  ```jsx
  <Route path="/dashboard"   element={<Navigate to="/" replace/>} />
  <Route path="/events"      element={<Navigate to="/shifts/mine" replace/>} />
  <Route path="/schedule"    element={<Navigate to="/shifts/mine" replace/>} />
  <Route path="/profile"     element={<Navigate to="/account/profile" replace/>} />
  <Route path="/resources"   element={<Navigate to="/account/documents" replace/>} />
  <Route path="/my-tip-page" element={<Navigate to="/tip-card" replace/>} />
  ```

  Also grep for any other staff-portal sub-routes in the existing App.js or in CLIENT_FACING_SURFACES.md and add redirects for them.

- [ ] **Step 3: Verify build**

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/App.js
  git commit -m "feat(staff-portal): mount production routes in HiringRoutes + add redirects (cutover step 2)"
  ```

---

### Task 50: Delete old fragments

**Spec ref:** §6.15.

**Files:**
- Delete: `client/src/pages/staff/StaffDashboard.js`
- Delete: `client/src/pages/staff/StaffEvents.js`
- Delete: `client/src/pages/staff/StaffShifts.js`
- Delete: `client/src/pages/staff/StaffSchedule.js`
- Delete: `client/src/pages/staff/StaffProfile.js`
- Delete: `client/src/pages/staff/StaffResources.js`
- Delete: `client/src/pages/staff/MyTipPage.js` + `MyTipPage.css` (if unused after MyTipPage removal)
- Delete: `client/src/components/StaffLayout.js`
- Modify: `client/src/App.js` (remove lazy imports for deleted files)

- [ ] **Step 1: Search for any remaining imports**

  ```bash
  grep -rn "StaffDashboard\|StaffEvents\|StaffShifts\|StaffSchedule\|StaffProfile\|StaffResources\|MyTipPage\|StaffLayout" client/src
  ```

  Expected: only references inside `App.js` (the lazy imports being removed) and no other references.

- [ ] **Step 2: Delete the files and remove lazy imports from App.js**

  Keep `PrintTipCard.jsx`, `PrintTipCard.layouts.jsx`, `PrintTipCard.css` (print flow lives on).

- [ ] **Step 3: Verify build**

  ```bash
  CI=true npm --prefix client run build
  ```

- [ ] **Step 4: Commit**

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

### Task 51: Documentation updates

**Spec ref:** §14.

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `CLIENT_FACING_SURFACES.md`

- [ ] **Step 1: README.md**, folder tree updates (new + deleted files), Key Features (new portal description).

- [ ] **Step 2: ARCHITECTURE.md**, API route table additions (every new `/api/me/*` + drop/cover endpoints + admin cover-swap + email-change endpoints), Database Schema additions (all new tables + columns + constraint widenings), Notifications model section (channel routing + critical-path override + dead-letter + suppression cascade).

- [ ] **Step 3: CLAUDE.md**, new env vars (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, REACT_APP_VAPID_PUBLIC_KEY, VAPID_CONTACT_EMAIL).

- [ ] **Step 4: CLIENT_FACING_SURFACES.md**, staff portal section overhaul.

- [ ] **Step 5: Commit**

  ```bash
  git add README.md ARCHITECTURE.md CLAUDE.md CLIENT_FACING_SURFACES.md
  git commit -m "docs(staff-portal): folder tree + route table + schema + notifications + env vars"
  ```

---

## Phase 11: Push notifications (Phase B per spec)

### Task 52: VAPID setup + env vars

**Spec ref:** §6.17.

**Files:**
- Modify: `package.json`, `.env.example`, `CLAUDE.md`, `README.md`

- [ ] **Step 1: Install web-push**

  ```bash
  npm install web-push
  ```

- [ ] **Step 2: Generate VAPID keys**

  ```bash
  npx web-push generate-vapid-keys
  ```

- [ ] **Step 3: Document env vars**

  - `VAPID_PUBLIC_KEY` (server-side)
  - `VAPID_PRIVATE_KEY` (server-side)
  - `REACT_APP_VAPID_PUBLIC_KEY` (client-side, same value as VAPID_PUBLIC_KEY)
  - `VAPID_CONTACT_EMAIL` (defaults to `contact@drbartender.com`)

  Add to `.env.example`, CLAUDE.md env table, README env table.

- [ ] **Step 4: Commit**

  ```bash
  git add package.json package-lock.json .env.example CLAUDE.md README.md
  git commit -m "chore(staff-portal): web-push + VAPID env vars for Phase B"
  ```

---

### Task 53: Service worker + pushSubscribe util

**Spec ref:** §6.17.

**Files:**
- Create: `client/public/staff-sw.js`
- Create: `client/src/utils/pushSubscribe.js`

- [ ] **Step 1: Service worker** with push + notificationclick handlers. Embed `SW_VERSION` constant at the top for cache-busting on every meaningful change.

- [ ] **Step 2: pushSubscribe util**, `permissionState()`, `subscribePush()`, `unsubscribePush()`. Wires to `/api/me/push-subscriptions`.

- [ ] **Step 3: Commit**

  ```bash
  git add client/public/staff-sw.js client/src/utils/pushSubscribe.js
  git commit -m "feat(staff-portal): service worker + pushSubscribe util"
  ```

---

### Task 54: iOS coachmark UX

**Spec ref:** §6.13 + §6.17.

**Files:**
- Modify: `client/src/pages/staff/account/IOSCoachmark.js` (the Phase A stub)
- Modify: `client/src/pages/staff/account/NotificationsSection.js`

- [ ] **Step 1: iOS detection helper**

  ```javascript
  function isIosNeedsInstall() {
    const ua = navigator.userAgent;
    return /iPad|iPhone|iPod/.test(ua) && !window.navigator.standalone;
  }
  ```

- [ ] **Step 2: IOSCoachmark modal** with 3-step "Add to Home Screen" walkthrough.

- [ ] **Step 3: Replace Push column gated state in NotificationsSection** with full banner state machine: granted / denied / default / unsupported / iosNeedsInstall.

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/pages/staff/account/IOSCoachmark.js \
          client/src/pages/staff/account/NotificationsSection.js
  git commit -m "feat(staff-portal): iOS coachmark + Push column permission states"
  ```

---

### Task 55: Activate push send path in dispatcher

**Spec ref:** §6.17.

**Files:**
- Modify: `server/utils/pushSender.js`
- Modify: `server/utils/pushSender.test.js`

- [ ] **Step 1: Replace stub with real web-push**

  ```javascript
  const webpush = require('web-push');

  webpush.setVapidDetails(
    `mailto:${process.env.VAPID_CONTACT_EMAIL || 'contact@drbartender.com'}`,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );

  async function sendPush({ subscription, title, body, url, tag, icon }) {
    if (!process.env.VAPID_PRIVATE_KEY) return { ok: false, error: 'vapid_unset' };
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
  ```

- [ ] **Step 2: Tests**, successful send, 410 returns gone:true, other errors return error string, VAPID-unset returns vapid_unset.

- [ ] **Step 3: End-to-end verify**

  Open staff portal in Chrome → AccountPage / Notifications → toggle Push cell on → grant permission → enqueue a test push from a server console → confirm notification appears.

- [ ] **Step 4: Commit**

  ```bash
  git add server/utils/pushSender.js server/utils/pushSender.test.js
  git commit -m "feat(staff-portal): activate web-push send path"
  ```

---

### Task 56: NotificationsSection Push column unlock + Phase B verification

**Spec ref:** §6.13.

**Files:**
- Modify: `client/src/pages/staff/account/NotificationsSection.js`

- [ ] **Step 1: Unlock Push column**, remove the "Coming in v1.5" disabled state. Push toggles now write to `/api/me/staff-notifications`.

- [ ] **Step 2: First-toggle subscribe flow**, when a user toggles a Push cell ON for the first time AND `permissionState() === 'default'`, call `subscribePush()` first. On success, PATCH the staff-notifications channels. If permission denied, leave toggle off + update banner state.

- [ ] **Step 3: Manual verification matrix per spec §11 Phase B**

  - Push permission grant on Chrome desktop → subscribes successfully
  - Push permission grant on Android Chrome → subscribes successfully
  - iOS Safari without home-screen install → coachmark appears, toggles disabled
  - iOS Safari with home-screen install → permission flow works
  - BEO nudge with push-only preference → push fires, no SMS
  - BEO finalized with all channels off → critical-path override sends SMS anyway
  - Subscription expires (simulate 410) → server removes the subscription on next attempt

- [ ] **Step 4: Commit**

  ```bash
  git add client/src/pages/staff/account/NotificationsSection.js
  git commit -m "feat(staff-portal): unlock Push column + first-toggle subscribe flow"
  ```

---

## Done.

All 56 tasks across 11 phases. Phase A (Tasks 1-51) ships the new portal with SMS + email notifications and the drop / cover marketplace; Phase B (Tasks 52-56) adds push.

**Cross-phase gates:**

- Before merging Phase A: run the full server test suite (`node --test server/`), the client build (`CI=true npm --prefix client run build`), and the spec §11 Phase A manual verification matrix.
- Before merging Phase B: re-run + the spec §11 Phase B manual verification matrix.
- A pre-deploy `code-review`, `security-review`, `database-review`, `performance-review`, `consistency-check` agent fleet run (per CLAUDE.md Rule 6) catches integration drift across the layers.

**Common pitfalls to call out during execution:**

1. **Forgetting to update BOTH `App.js` route blocks**, the new portal must work on both the staff subdomain AND the hiring subdomain; the cutover is two commits (Tasks 48 + 49) for review-revertability.
2. **`payment_profiles.account_number` leaking in API responses** (Task 13), only project the last 4 digits AFTER decrypt. Never project raw ciphertext.
3. **`/api/me/*` mount-order collisions** (Task 12), verify the existing `server/routes/me.js` and `server/routes/emailChange.js` (unauthenticated) and `server/routes/staffPortal.js` (auth-gated) mount orders carefully. The unauthenticated `confirm-email-change` route must reach its handler without `auth` middleware applying.
4. **Push subscription pruning race** (Task 7), `SELECT FOR UPDATE` on the user row inside the prune transaction is load-bearing.
5. **Calendar feed deep links breaking on token rotation** (Task 45), Regenerate URL action requires explicit confirm dialog.
6. **`shifts.positions_needed` heterogeneous shape** (Task 22), always `typeof p === 'string' ? p : p.position` tolerantly.
7. **Hybrid-state filter** (Tasks 11, 23, 26, 33), every consumer that reads `status='approved'` must also check `dropped_at IS NULL`. The partial index `idx_shift_requests_active_approved` makes this query fast.
8. **`scheduled_messages.status` new terminal values** (Task 7), `'suppressed_by_sibling'` and `'dead_letter'` are TERMINAL. Any existing reader that filters `status NOT IN ('sent','failed')` to find live work must be audited.
9. **Email-change confirm auth model** (Task 18), look up `user_id` from `pending_email_changes` via `token_hash` ONLY. NEVER from `req.user.id`. This is the load-bearing security property.
10. **`positions_interested` is JSON-encoded** (Task 1 backfill), not comma-separated. The backfill SQL uses `(positions_interested::jsonb->>0)` with a CASE fallback for any legacy CSV rows.
