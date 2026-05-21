# Two-Way SMS Infrastructure (Comms Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up two-way SMS — a Twilio inbound webhook that receives client and staff texts, parses STOP/START opt-out and staff CONFIRM/CANT response codes, alerts the admin, and surfaces every client conversation in a new admin Messages page with an unread badge.

**Architecture:** Three layers. (1) A new `server/utils/smsInbound.js` holds all inbound-processing logic — keyword detection, phone-to-sender lookup, opt-out/opt-in, the CONFIRM/CANT response-code handlers, admin-alert dispatch, and a `processInboundSms` orchestrator — each piece independently unit-tested. (2) A new `server/routes/sms.js` exposes the Twilio-signature-verified `POST /api/sms/inbound` webhook plus admin thread endpoints (conversation list, per-client thread, reply, mark-read) modeled on the existing email-conversations feature. (3) A new admin `/messages` React page mirrors `EmailConversations.js`, with an `unread_sms` count wired into the existing sidebar badge system. Inbound messages are stored in the existing `sms_messages` table (`direction='inbound'`, a column Comms Phase 1 already added) extended with `client_id`, `read_at`, and `metadata`.

**Tech Stack:** Node.js 18+ / Express 4.18, PostgreSQL (raw SQL via `pg`), the `twilio` npm package (already a dependency — `sendSMS` wrapper at `server/utils/sms.js`; inbound verification via `twilio.validateRequest`), Resend for admin email alerts, React 18 (CRA) / React Router 6, `node:test` + `node:assert/strict` against the live dev DB, Sentry for failure capture.

**Related:** Spec `docs/superpowers/specs/2026-05-20-automated-communication-design.md` sections 3 (response codes + voice), 6 (admin notifications), 8.1 (two-way SMS), 8.5 (STOP keyword), 10 Phase 2. Builds on Comms Phase 1 (foundation — provided `sms_messages.direction`, `clients.communication_preferences`, `clients.phone_status`, `users.communication_preferences`) and is independent of the Phase 1 email plans (2a-d).

---

## Design decisions (locked before this plan was written)

1. **Inbound storage uses the existing `sms_messages` table**, not a new table — the spec (8.1) explicitly says store inbound with `direction='inbound'`, and Phase 1 already added that column. This plan adds `client_id`, `read_at`, `metadata` to it.
2. **Admin alert on an inbound client text → SMS to `ADMIN_PHONE`** (not email). Client texts are urgent and need a fast reply.
3. **CANT is flag-and-alert, not auto-restaff.** A staff `CANT` un-assigns the staffer from their nearest upcoming shift and alerts the admin; the admin re-staffs manually. CANT is rare — an automatic re-staffing pipeline is not worth the risk of acting on a weakly-authenticated inbound text.
4. **CANT alert channel keys on event lead time:** event under 7 days away → SMS to `ADMIN_PHONE` (urgent); event 7+ days away → email to `ADMIN_EMAIL`.
5. **The admin UI is a standalone `/messages` page**, not a tab on the client detail page — the unread badge implies a global triage view, and the existing `EmailConversations` feature is a near-exact, working template for the whole stack.
6. **STOP/START opt-out replies are left to Twilio.** US A2P carrier rules make Twilio handle STOP/HELP at the carrier level and send the legally-mandated compliance reply itself. The webhook records the `sms_enabled` preference internally as a mirror and tags the message row's `metadata` for audit (spec 8.5 step 3), but does NOT send its own reply — that would duplicate Twilio's. This is how spec 8.5 step 2 ("send a Twilio-compliant confirmation reply") is satisfied. This assumes Twilio's Advanced Opt-Out is enabled on the Messaging Service / number; enabling it is an operational precondition for this plan.
7. **Staff response codes get an SMS reply; client inbound texts do not.** A staffer who texts CONFIRM/CANT gets an SMS back so they know the code registered (acknowledged, released, a "no shift found" notice, or an "automated line" redirect for free-form text). A client who texts in gets NO auto-reply — the admin replies personally from the Messages page.
8. **Commit granularity: this plan commits once per task.** That is intentional — it matches the subagent-driven-development execution model and the prior comms plans (Plan 1, 2a), and gives clean per-task revertability. CLAUDE.md Git Workflow Rule 3's "group by logical feature" is satisfied at push time: all of this plan's commits ship together as one logical push.

## Spec defects corrected in this plan

- Spec 8.5 step 1 says match a STOP keyword against `users.phone`. **There is no `users.phone` column.** Staff phone lives on `contractor_profiles.phone`. STOP/START from a staff number resolves via `contractor_profiles` → `users`; a STOP from a number with no DB match (e.g. the admin's own `ADMIN_PHONE`, since admins have no `contractor_profiles` row) is logged and given a courtesy reply but updates no preference row.
- Spec 6 envisions a multi-admin notification fan-out querying `users.phone` — also non-existent and out of scope here (it is Comms Phase 4). This plan uses the single `ADMIN_PHONE` / `ADMIN_EMAIL` env vars, matching `server/utils/lastMinuteAlert.js`.

---

## File Structure

**Files to create:**
- `server/utils/smsInbound.js` — all inbound-SMS processing: `detectOptKeyword`, `detectResponseCode` (pure); `lookupSender`, `recordInboundMessage`, `applyOptOut`, `applyOptIn`, `handleConfirm`, `handleCant` (DB); the admin-alert functions; and the `processInboundSms` orchestrator.
- `server/utils/smsInbound.test.js` — `node:test` unit/integration tests for the above.
- `server/routes/sms.js` — Express router: the Twilio webhook `POST /inbound` (signature-verified, no JWT) and the admin thread endpoints (`GET /conversations`, `GET /conversations/:clientId`, `POST /conversations/:clientId/reply`, `PUT /conversations/:clientId/read`).
- `client/src/pages/admin/Messages.js` — the admin SMS thread page.

**Files to modify:**
- `server/db/schema.sql` — `sms_messages` gains `client_id`, `read_at`, `metadata` + extended `status` CHECK + indexes; `shift_requests` gains `acknowledged_at`; `contractor_profiles` gains a normalized-phone index.
- `server/index.js` — register `app.use('/api/sms', require('./routes/sms'))`.
- `server/routes/admin/settings.js` — add an `unread_sms` count to `GET /api/admin/badge-counts`.
- `client/src/App.js` — lazy-import `Messages` and add the `/messages` admin route.
- `client/src/components/adminos/nav.js` — add the Messages nav item with `badgeKey: 'unread_sms'`.
- `client/src/index.css` — styles for the SMS thread UI.
- `.env.example`, `.claude/CLAUDE.md`, `README.md`, `ARCHITECTURE.md` — docs.

**Files referenced (no edits):**
- `server/utils/sms.js` — `sendSMS({ to, body })`, `normalizePhone(phone)`.
- `server/utils/email.js` — `sendEmail({ to, subject, html, text })`.
- `server/utils/lastMinuteAlert.js` — the `ADMIN_PHONE` admin-SMS pattern to mirror.
- `server/routes/emailMarketing.js` lines 742-823 — the conversation endpoints template.
- `client/src/pages/admin/EmailConversations.js` — the thread-UI template.
- `server/db/index.js` — `pool`.
- `server/middleware/asyncHandler.js`, `server/utils/errors.js` — `asyncHandler`, `AppError` subclasses.

---

## Task 1: Schema — extend `sms_messages`, add `shift_requests.acknowledged_at`, add the staff-phone index

**Files:**
- Modify: `server/db/schema.sql`

Two-way SMS needs: inbound messages linked to a `clients` row (`sms_messages` today only FKs `users`); an unread marker; a `metadata` JSONB for the STOP-keyword audit trail and the raw Twilio `From`/`To`; a `received` status value; a place to record staff shift acknowledgement; and a fast normalized-phone lookup on `contractor_profiles`.

- [ ] **Step 1: Append the schema block to `schema.sql`**

Add at the end of `server/db/schema.sql`:

```sql
-- ─── Comms Phase 2: Two-way SMS ─────────────────────────────────
-- sms_messages gains inbound-message support. The table predates inbound
-- SMS: its FKs (sender_id/recipient_id) point only at users. client_id
-- links an inbound text to its clients row so the admin thread UI can group
-- by client. read_at marks an inbound message as seen (drives the unread
-- badge). metadata holds the raw Twilio From/To/MessageSid and the
-- STOP/START opt-out audit record.
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

-- 'received' is the status for an inbound message (sent/failed/queued only
-- describe an outbound send attempt).
DO $$ BEGIN
  ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_status_check;
  ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_status_check
    CHECK (status IN ('sent','failed','queued','received'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_sms_messages_client_id ON sms_messages(client_id);
-- Partial index keyed on client_id: serves the per-client unread subquery
-- directly, and the global badge count via a partial-index scan (the unread
-- set is tiny in steady state).
CREATE INDEX IF NOT EXISTS idx_sms_messages_unread
  ON sms_messages(client_id)
  WHERE direction = 'inbound' AND read_at IS NULL;

-- Inbound-webhook idempotency: dedupe a repeated Twilio delivery by MessageSid.
CREATE INDEX IF NOT EXISTS idx_sms_messages_twilio_sid ON sms_messages(twilio_sid);

-- shift_requests.acknowledged_at records that the assigned staff member
-- texted CONFIRM for the shift. shift_requests is the per-(shift,staff) row,
-- so acknowledgement belongs here, not on shifts (a shift has many staff).
ALTER TABLE shift_requests ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ;

-- findNearestApprovedShift filters shift_requests by user_id (the texting
-- staffer). The table's indexes lead with shift_id; add a user_id index.
CREATE INDEX IF NOT EXISTS idx_shift_requests_user_id ON shift_requests(user_id);

-- Inbound SMS identifies the sender only by phone number. contractor_profiles
-- has no phone index; this functional index matches the last 10 digits
-- (mirrors idx_clients_phone_normalized).
CREATE INDEX IF NOT EXISTS idx_contractor_profiles_phone_normalized
  ON contractor_profiles (RIGHT(REGEXP_REPLACE(phone, '\D', '', 'g'), 10));
```

- [ ] **Step 2: Apply to the dev DB and verify**

`DATABASE_URL` lives in the gitignored `.env` at the repo root; `server/db/index.js` reads `process.env.DATABASE_URL` directly (it does NOT load dotenv). To run psql, extract it: `psql "$(grep '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')" -c "..."`. Apply the block directly (it is all idempotent), then verify:

```bash
psql "$DATABASE_URL" -c "\d sms_messages"
psql "$DATABASE_URL" -c "\d shift_requests"
```

Expected: `sms_messages` shows `client_id`, `read_at`, `metadata` columns, the `idx_sms_messages_client_id` and `idx_sms_messages_unread` indexes, and the `sms_messages_status_check` constraint listing `received`; `shift_requests` shows `acknowledged_at`.

- [ ] **Step 3: Smoke-test the new status value**

```bash
psql "$DATABASE_URL" << 'EOF'
BEGIN;
INSERT INTO sms_messages (recipient_phone, body, direction, status)
VALUES ('+15555550000', 'schema smoke test', 'inbound', 'received');
ROLLBACK;
EOF
```

Expected: the insert succeeds (proves `status='received'` passes the CHECK and the NOT NULL columns `recipient_phone`/`body` are satisfied).

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(sms): schema for inbound two-way SMS — sms_messages client_id/read_at/metadata, shift_requests.acknowledged_at"
```

---

## Task 2: `smsInbound.js` — pure keyword + response-code detection (TDD)

**Files:**
- Create: `server/utils/smsInbound.js`
- Create: `server/utils/smsInbound.test.js`

Two pure functions classify an inbound message body. `detectOptKeyword` recognizes Twilio-standard opt-out/opt-in words; `detectResponseCode` recognizes the staff shift codes from spec section 3.

- [ ] **Step 1: Write the failing test**

Create `server/utils/smsInbound.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectOptKeyword, detectResponseCode } = require('./smsInbound');

test('detectOptKeyword > recognizes STOP and equivalents, case-insensitive', () => {
  for (const word of ['STOP', 'stop', '  Stop ', 'UNSUBSCRIBE', 'end', 'CANCEL', 'quit']) {
    assert.strictEqual(detectOptKeyword(word), 'stop', `expected stop for "${word}"`);
  }
});

test('detectOptKeyword > recognizes START and equivalents', () => {
  for (const word of ['START', 'start', ' Start', 'UNSTOP', 'yes']) {
    assert.strictEqual(detectOptKeyword(word), 'start', `expected start for "${word}"`);
  }
});

test('detectOptKeyword > returns null for non-keyword text', () => {
  assert.strictEqual(detectOptKeyword('stop by the store later'), null);
  assert.strictEqual(detectOptKeyword('thanks!'), null);
  assert.strictEqual(detectOptKeyword(''), null);
  assert.strictEqual(detectOptKeyword(null), null);
});

test('detectResponseCode > recognizes CONFIRM, case-insensitive, whole-word', () => {
  for (const word of ['CONFIRM', 'confirm', ' Confirm ']) {
    assert.strictEqual(detectResponseCode(word), 'confirm');
  }
});

test('detectResponseCode > recognizes CANT and common spellings', () => {
  for (const word of ['CANT', 'cant', "CAN'T", "can't", ' Cant']) {
    assert.strictEqual(detectResponseCode(word), 'cant');
  }
});

test('detectResponseCode > returns null for free-form text', () => {
  assert.strictEqual(detectResponseCode('I confirm I will be there'), null);
  assert.strictEqual(detectResponseCode('running late sorry'), null);
  assert.strictEqual(detectResponseCode(''), null);
  assert.strictEqual(detectResponseCode(null), null);
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: FAIL with `Cannot find module './smsInbound'`.

- [ ] **Step 3: Create `smsInbound.js` with the pure helpers**

Create `server/utils/smsInbound.js`:

```javascript
// Inbound-SMS processing for the Twilio webhook (POST /api/sms/inbound).
// Pure helpers here; DB-touching helpers and the orchestrator are appended
// in later tasks.

const STOP_WORDS = new Set(['stop', 'unsubscribe', 'end', 'cancel', 'quit']);
const START_WORDS = new Set(['start', 'unstop', 'yes']);

/**
 * Classify a message body as an opt-out / opt-in keyword.
 * Matches only when the ENTIRE trimmed body is a single keyword (Twilio's
 * own STOP handling works the same way — "stop by later" is not an opt-out).
 *
 * @param {string} body
 * @returns {'stop'|'start'|null}
 */
function detectOptKeyword(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase();
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/**
 * Classify a message body as a staff shift response code (spec section 3).
 * Whole-body match only — a code buried in a sentence is treated as
 * free-form text and routed to the admin instead.
 *
 * @param {string} body
 * @returns {'confirm'|'cant'|null}
 */
function detectResponseCode(body) {
  if (!body || typeof body !== 'string') return null;
  const word = body.trim().toLowerCase().replace(/['’]/g, '');
  if (word === 'confirm') return 'confirm';
  if (word === 'cant') return 'cant';
  return null;
}

module.exports = { detectOptKeyword, detectResponseCode };
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsInbound.js server/utils/smsInbound.test.js
git commit -m "feat(sms): inbound keyword + response-code detection helpers"
```

---

## Task 3: `smsInbound.js` — `lookupSender` (TDD, live DB)

**Files:**
- Modify: `server/utils/smsInbound.js`
- Modify: `server/utils/smsInbound.test.js`

`lookupSender` resolves an inbound E.164 phone number to a client, a staff member, or "unknown". Client match is checked first (clients are the higher-volume inbound source). Phone columns are free-text `VARCHAR(50)`; matching compares the last 10 digits on both sides, using `idx_clients_phone_normalized` / `idx_contractor_profiles_phone_normalized`.

- [ ] **Step 1: Append failing tests**

Add to `server/utils/smsInbound.test.js`. First, change the top of the file so it can hit the DB — the test file currently has no DB imports. Replace the three import lines at the top of the file (the `node:test`, `assert`, and `./smsInbound` requires from Task 2) with:

```javascript
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  detectOptKeyword,
  detectResponseCode,
  lookupSender,
} = require('./smsInbound');
```

Then append these tests at the end of the file. The `before()` hook first deletes any pre-existing fixture rows by their fixed email/phone, so the suite is re-runnable even if a prior run threw mid-suite and left fixtures behind (the `after()` cleanup would not have run):

```javascript
let lsClientId;
let lsStaffUserId;

before(async () => {
  // Idempotent cleanup — if a prior run threw mid-suite, fixed-email/phone
  // fixture rows may be left behind; delete them so this run is re-runnable.
  await pool.query("DELETE FROM contractor_profiles WHERE phone = '(312) 555-0149'");
  await pool.query("DELETE FROM users WHERE email = 'sms-lookup-staff@example.com'");
  await pool.query("DELETE FROM clients WHERE email = 'sms-lookup-client@example.com'");

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('SMS Lookup Client', 'sms-lookup-client@example.com', '3125550148')
     RETURNING id`
  );
  lsClientId = c.rows[0].id;

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ('sms-lookup-staff@example.com', 'x', 'staff')
     RETURNING id`
  );
  lsStaffUserId = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, phone) VALUES ($1, '(312) 555-0149')`,
    [lsStaffUserId]
  );
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [lsStaffUserId]);
  await pool.query('DELETE FROM users WHERE id = $1', [lsStaffUserId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [lsClientId]);
  await pool.end();
});

test('lookupSender > matches a client by last-10-digits regardless of stored format', async () => {
  const r = await lookupSender('+13125550148');
  assert.strictEqual(r.type, 'client');
  assert.strictEqual(r.client.id, lsClientId);
});

test('lookupSender > matches a staff member via contractor_profiles', async () => {
  const r = await lookupSender('+13125550149');
  assert.strictEqual(r.type, 'staff');
  assert.strictEqual(r.staffUserId, lsStaffUserId);
});

test('lookupSender > returns unknown for an unmatched number', async () => {
  const r = await lookupSender('+19998887777');
  assert.strictEqual(r.type, 'unknown');
});

test('lookupSender > returns unknown for a null/garbage number', async () => {
  assert.strictEqual((await lookupSender(null)).type, 'unknown');
  assert.strictEqual((await lookupSender('not-a-phone')).type, 'unknown');
});
```

- [ ] **Step 2: Run the test, verify the new tests fail**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: the `lookupSender` tests FAIL (`lookupSender is not a function`); the Task 2 tests still pass.

- [ ] **Step 3: Implement `lookupSender`**

In `server/utils/smsInbound.js`, add `const { pool } = require('../db');` as the first line, and add this function before `module.exports`:

```javascript
/**
 * Extract the last 10 digits of a phone number for matching. Inbound numbers
 * arrive E.164 (+1XXXXXXXXXX); stored numbers are free-text. Returns null when
 * fewer than 10 digits are present.
 *
 * @param {string} phone
 * @returns {string|null}
 */
function last10(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Resolve an inbound phone number to its sender. Clients are checked first.
 *
 * @param {string} fromPhone - the inbound E.164 number (Twilio `From`)
 * @returns {Promise<
 *   {type:'client', client:{id:number,name:string,phone:string,communication_preferences:object,phone_status:string}} |
 *   {type:'staff', staffUserId:number, staff:{id:number,communication_preferences:object}} |
 *   {type:'unknown'}
 * >}
 */
async function lookupSender(fromPhone) {
  const key = last10(fromPhone);
  if (!key) return { type: 'unknown' };

  const c = await pool.query(
    `SELECT id, name, phone, communication_preferences, phone_status
     FROM clients
     WHERE RIGHT(REGEXP_REPLACE(phone, '\\D', '', 'g'), 10) = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [key]
  );
  if (c.rows[0]) return { type: 'client', client: c.rows[0] };

  const s = await pool.query(
    `SELECT u.id, u.communication_preferences
     FROM contractor_profiles cp
     JOIN users u ON u.id = cp.user_id
     WHERE RIGHT(REGEXP_REPLACE(cp.phone, '\\D', '', 'g'), 10) = $1
     ORDER BY cp.updated_at DESC
     LIMIT 1`,
    [key]
  );
  if (s.rows[0]) return { type: 'staff', staffUserId: s.rows[0].id, staff: s.rows[0] };

  return { type: 'unknown' };
}
```

Update `module.exports` to:

```javascript
module.exports = { detectOptKeyword, detectResponseCode, lookupSender };
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: all tests pass (10 total).

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsInbound.js server/utils/smsInbound.test.js
git commit -m "feat(sms): lookupSender resolves an inbound number to client/staff/unknown"
```

---

## Task 4: `smsInbound.js` — record inbound message + STOP/START opt handlers (TDD)

**Files:**
- Modify: `server/utils/smsInbound.js`
- Modify: `server/utils/smsInbound.test.js`

`recordInboundMessage` inserts the inbound row into `sms_messages`. `applyOptOut` / `applyOptIn` set the `sms_enabled` preference on the matched client or staff user and append a STOP/START audit entry. For an inbound row, `recipient_phone` holds the EXTERNAL party's number (the sender) so the column means "the other party's phone" consistently across both directions; `client_id` is the canonical thread link.

- [ ] **Step 1: Append failing tests**

Add `recordInboundMessage`, `applyOptOut`, `applyOptIn` to the destructured import at the top of `server/utils/smsInbound.test.js`. Append these tests:

```javascript
test('recordInboundMessage > inserts an inbound row linked to a client', async () => {
  const row = await recordInboundMessage({
    fromPhone: '+13125550148',
    body: 'hello from the test',
    clientId: lsClientId,
    twilioSid: 'SMtest_record_1',
  });
  assert.ok(row.id > 0);
  assert.strictEqual(row.direction, 'inbound');
  assert.strictEqual(row.client_id, lsClientId);
  assert.strictEqual(row.status, 'received');
  assert.strictEqual(row.read_at, null);
  await pool.query('DELETE FROM sms_messages WHERE id = $1', [row.id]);
});

test('recordInboundMessage > tolerates an empty body and a null client', async () => {
  const row = await recordInboundMessage({
    fromPhone: '+19998887777',
    body: '',
    clientId: null,
    twilioSid: 'SMtest_record_2',
  });
  assert.strictEqual(row.body, '');
  assert.strictEqual(row.client_id, null);
  await pool.query('DELETE FROM sms_messages WHERE id = $1', [row.id]);
});

test('applyOptOut > sets sms_enabled false on a client and records the audit', async () => {
  await applyOptOut({ type: 'client', client: { id: lsClientId } });
  const r = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [lsClientId]);
  assert.strictEqual(r.rows[0].communication_preferences.sms_enabled, false);
  // restore
  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{sms_enabled}', 'true') WHERE id = $1`,
    [lsClientId]
  );
});

test('applyOptIn > sets sms_enabled true on a staff user', async () => {
  await pool.query(
    `UPDATE users SET communication_preferences = jsonb_set(communication_preferences, '{sms_enabled}', 'false') WHERE id = $1`,
    [lsStaffUserId]
  );
  await applyOptIn({ type: 'staff', staffUserId: lsStaffUserId });
  const r = await pool.query('SELECT communication_preferences FROM users WHERE id = $1', [lsStaffUserId]);
  assert.strictEqual(r.rows[0].communication_preferences.sms_enabled, true);
});

test('applyOptOut > is a no-op for an unknown sender', async () => {
  await applyOptOut({ type: 'unknown' }); // must not throw
});
```

- [ ] **Step 2: Run the test, verify the new tests fail**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: the new tests FAIL (functions not exported).

- [ ] **Step 3: Implement the three functions**

In `server/utils/smsInbound.js`, add before `module.exports`:

```javascript
/**
 * Insert an inbound message into sms_messages. For an inbound row,
 * recipient_phone holds the SENDER's number (the external party) so the
 * column reads as "the other party's phone" for both directions; client_id
 * is the canonical link for the thread UI. The body is truncated and the
 * sender phone is defaulted so a malformed Twilio payload cannot violate the
 * NOT NULL / length constraints.
 *
 * @param {Object} args
 * @param {string} args.fromPhone - inbound E.164 sender number
 * @param {string} args.body - message text (may be empty)
 * @param {number|null} args.clientId - matched clients.id, or null
 * @param {string} [args.twilioSid] - Twilio MessageSid
 * @param {Object} [args.metadata] - extra metadata to merge
 * @returns {Promise<Object>} the inserted row
 */
async function recordInboundMessage({ fromPhone, body, clientId, twilioSid, metadata }) {
  const phone = (fromPhone || 'unknown').slice(0, 50);
  const text = (body || '').slice(0, 2000);
  const meta = { from: fromPhone || null, to: process.env.TWILIO_PHONE_NUMBER || null, ...(metadata || {}) };
  const result = await pool.query(
    `INSERT INTO sms_messages
       (direction, client_id, recipient_phone, body, message_type, status, twilio_sid, metadata)
     VALUES ('inbound', $1, $2, $3, 'general', 'received', $4, $5)
     RETURNING *`,
    [clientId || null, phone, text, twilioSid || null, JSON.stringify(meta)]
  );
  return result.rows[0];
}

/**
 * Set communication_preferences.sms_enabled = <value> for the matched sender
 * and append a STOP/START audit timestamp. No-op for an unknown sender (a
 * number with no client/staff row — e.g. the admin's own phone). The audit
 * path is a static literal (auditPath is a controlled internal constant, not
 * user input) because jsonb_set requires a text[] path.
 *
 * @param {Object} sender - a lookupSender(...) result
 * @param {boolean} enabled
 */
async function setSmsEnabled(sender, enabled) {
  // Static-literal jsonb path — '{sms_opt_in_at}' or '{sms_opt_out_at}'.
  const auditPath = enabled ? "'{sms_opt_in_at}'" : "'{sms_opt_out_at}'";
  // COALESCE guards a NULL communication_preferences column: jsonb_set(NULL, ...)
  // returns NULL and would wipe the column. The column is NOT NULL today, so
  // this is purely defensive.
  if (sender.type === 'client') {
    await pool.query(
      `UPDATE clients
       SET communication_preferences = jsonb_set(
             jsonb_set(COALESCE(communication_preferences, '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb), '{sms_enabled}', $2::jsonb),
             ${auditPath}, to_jsonb(NOW()::text))
       WHERE id = $1`,
      [sender.client.id, JSON.stringify(enabled)]
    );
  } else if (sender.type === 'staff') {
    await pool.query(
      `UPDATE users
       SET communication_preferences = jsonb_set(
             jsonb_set(COALESCE(communication_preferences, '{"sms_enabled":true,"email_enabled":true,"marketing_enabled":true}'::jsonb), '{sms_enabled}', $2::jsonb),
             ${auditPath}, to_jsonb(NOW()::text))
       WHERE id = $1`,
      [sender.staffUserId, JSON.stringify(enabled)]
    );
  }
  // sender.type === 'unknown' → nothing to update
}

/** Opt the sender OUT of SMS (STOP keyword). */
async function applyOptOut(sender) {
  await setSmsEnabled(sender, false);
}

/** Opt the sender back IN to SMS (START keyword). */
async function applyOptIn(sender) {
  await setSmsEnabled(sender, true);
}
```

Update `module.exports` to add `recordInboundMessage, applyOptOut, applyOptIn`.

- [ ] **Step 4: Run the test, verify it passes**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: all tests pass (15 total).

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsInbound.js server/utils/smsInbound.test.js
git commit -m "feat(sms): recordInboundMessage + STOP/START opt-out/opt-in handlers"
```

---

## Task 5: `smsInbound.js` — `handleConfirm` (TDD)

**Files:**
- Modify: `server/utils/smsInbound.js`
- Modify: `server/utils/smsInbound.test.js`

A staff `CONFIRM` marks their nearest upcoming approved shift acknowledged by stamping `shift_requests.acknowledged_at`. Staff↔shift is `shift_requests` with `status='approved'` (there is no `shifts.assigned_user_id`). A staffer can be approved on several future shifts; the soonest by `event_date` is the target. Because a staffer may have multiple upcoming shifts and this handler always acts on the SOONEST, `handleConfirm` returns the client name so the webhook reply can name the shift — letting the staffer immediately flag a wrong target to the admin.

- [ ] **Step 1: Append failing tests**

Add `handleConfirm` to the destructured import. Append to `smsInbound.test.js`:

```javascript
let hcShiftId;
let hcRequestId;

test('handleConfirm > stamps acknowledged_at on the nearest approved shift', async () => {
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status) VALUES (CURRENT_DATE + INTERVAL '10 days', '18:00', 'filled')
     RETURNING id`
  );
  hcShiftId = sh.rows[0].id;
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [hcShiftId, lsStaffUserId]
  );
  hcRequestId = sr.rows[0].id;

  const result = await handleConfirm(lsStaffUserId);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.shiftId, hcShiftId);

  const check = await pool.query('SELECT acknowledged_at FROM shift_requests WHERE id = $1', [hcRequestId]);
  assert.ok(check.rows[0].acknowledged_at instanceof Date);

  await pool.query('DELETE FROM shift_requests WHERE id = $1', [hcRequestId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [hcShiftId]);
});

test('handleConfirm > returns ok:false reason no_shift when staff has no approved upcoming shift', async () => {
  const result = await handleConfirm(lsStaffUserId);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no_shift');
});
```

- [ ] **Step 2: Run the test, verify the new tests fail**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: the `handleConfirm` tests FAIL.

- [ ] **Step 3: Implement `handleConfirm`**

Add to `server/utils/smsInbound.js` before `module.exports`:

```javascript
/**
 * Find the texting staff member's nearest upcoming approved shift and return
 * it. `event_date >= CURRENT_DATE` and a non-terminal shift status. start_time
 * is free-text so the same-day tiebreak is best-effort.
 *
 * @param {number} staffUserId
 * @returns {Promise<Object|null>} the shift_requests+shifts row, or null
 */
async function findNearestApprovedShift(staffUserId) {
  const r = await pool.query(
    `SELECT sr.id AS request_id, s.id AS shift_id, s.event_date, s.start_time,
            s.status AS shift_status, s.client_name, s.event_type, s.event_type_custom
     FROM shift_requests sr
     JOIN shifts s ON s.id = sr.shift_id
     WHERE sr.user_id = $1
       AND sr.status = 'approved'
       AND s.event_date >= CURRENT_DATE
       AND s.status NOT IN ('completed', 'cancelled')
     ORDER BY s.event_date ASC, s.start_time ASC
     LIMIT 1`,
    [staffUserId]
  );
  return r.rows[0] || null;
}

/**
 * Handle a staff CONFIRM response code: stamp acknowledged_at on the nearest
 * upcoming approved shift_request.
 *
 * @param {number} staffUserId
 * @returns {Promise<{ok:true, shiftId:number, eventDate:string, clientName:string|null} | {ok:false, reason:'no_shift'}>}
 */
async function handleConfirm(staffUserId) {
  const shift = await findNearestApprovedShift(staffUserId);
  if (!shift) return { ok: false, reason: 'no_shift' };
  await pool.query(
    'UPDATE shift_requests SET acknowledged_at = NOW() WHERE id = $1',
    [shift.request_id]
  );
  return { ok: true, shiftId: shift.shift_id, eventDate: shift.event_date, clientName: shift.client_name || null };
}
```

Add `handleConfirm, findNearestApprovedShift` to `module.exports`.

- [ ] **Step 4: Run the test, verify it passes**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: all tests pass (17 total).

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsInbound.js server/utils/smsInbound.test.js
git commit -m "feat(sms): handleConfirm stamps shift acknowledgement on staff CONFIRM"
```

---

## Task 6: `smsInbound.js` — `handleCant` (TDD)

**Files:**
- Modify: `server/utils/smsInbound.js`
- Modify: `server/utils/smsInbound.test.js`

A staff `CANT` un-assigns the staffer from their nearest upcoming approved shift and re-opens the shift so it shows as unstaffed. Mechanism (per locked decision 3): in one transaction, set the staffer's `shift_requests.status='denied'` with a `notes` annotation, and set `shifts.status='open'`. It deliberately does NOT clear `shifts.auto_assigned_at` — so the hourly auto-assign scheduler will NOT silently re-staff; the admin re-staffs manually. The shift surfaces in the existing `unstaffed_events` badge query (which counts shifts where approved-requests < positions). Like `handleConfirm`, this handler targets the SOONEST upcoming shift (a staffer may have several); the return includes the client name so the webhook reply can name the released shift, letting the staffer flag a wrong target to the admin.

- [ ] **Step 1: Append failing tests**

Add `handleCant` to the destructured import. Append:

```javascript
test('handleCant > un-assigns the staffer and re-opens the shift', async () => {
  const sh = await pool.query(
    `INSERT INTO shifts (event_date, start_time, status, auto_assigned_at)
     VALUES (CURRENT_DATE + INTERVAL '12 days', '17:00', 'filled', NOW())
     RETURNING id`
  );
  const shiftId = sh.rows[0].id;
  const sr = await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved') RETURNING id`,
    [shiftId, lsStaffUserId]
  );
  const requestId = sr.rows[0].id;

  const result = await handleCant(lsStaffUserId);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.shiftId, shiftId);

  const reqAfter = await pool.query('SELECT status, notes FROM shift_requests WHERE id = $1', [requestId]);
  assert.strictEqual(reqAfter.rows[0].status, 'denied');
  assert.match(reqAfter.rows[0].notes || '', /CANT/i);

  const shiftAfter = await pool.query('SELECT status, auto_assigned_at FROM shifts WHERE id = $1', [shiftId]);
  assert.strictEqual(shiftAfter.rows[0].status, 'open');
  // auto_assigned_at is deliberately left set so the scheduler does NOT re-staff
  assert.ok(shiftAfter.rows[0].auto_assigned_at instanceof Date);

  await pool.query('DELETE FROM shift_requests WHERE id = $1', [requestId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
});

test('handleCant > returns ok:false reason no_shift when staff has no approved upcoming shift', async () => {
  const result = await handleCant(lsStaffUserId);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no_shift');
});
```

- [ ] **Step 2: Run the test, verify the new tests fail**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: the `handleCant` tests FAIL.

- [ ] **Step 3: Implement `handleCant`**

Add to `server/utils/smsInbound.js` before `module.exports`:

```javascript
/**
 * Handle a staff CANT response code: un-assign the staffer from their nearest
 * upcoming approved shift and re-open that shift. Does NOT clear
 * shifts.auto_assigned_at — re-staffing is left to the admin (decision: CANT
 * is flag-and-alert, not auto-restaff). Returns shift info for the alert.
 *
 * @param {number} staffUserId
 * @returns {Promise<
 *   {ok:true, shiftId:number, requestId:number, eventDate:string, clientName:string|null, eventType:string|null, eventTypeCustom:string|null} |
 *   {ok:false, reason:'no_shift'}
 * >}
 */
async function handleCant(staffUserId) {
  const shift = await findNearestApprovedShift(staffUserId);
  if (!shift) return { ok: false, reason: 'no_shift' };

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    await dbClient.query(
      `UPDATE shift_requests
       SET status = 'denied',
           notes = TRIM(COALESCE(notes, '') || ' [Staff texted CANT ' || NOW()::date || ']')
       WHERE id = $1`,
      [shift.request_id]
    );
    // Re-open the shift so it shows as unstaffed. auto_assigned_at is left as-is
    // on purpose so processScheduledAutoAssigns does not auto-re-staff it.
    await dbClient.query(
      "UPDATE shifts SET status = 'open' WHERE id = $1 AND status <> 'cancelled'",
      [shift.shift_id]
    );
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }

  return {
    ok: true,
    shiftId: shift.shift_id,
    requestId: shift.request_id,
    eventDate: shift.event_date,
    clientName: shift.client_name || null,
    eventType: shift.event_type || null,
    eventTypeCustom: shift.event_type_custom || null,
  };
}
```

Add `handleCant` to `module.exports`.

- [ ] **Step 4: Run the test, verify it passes**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: all tests pass (19 total).

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsInbound.js server/utils/smsInbound.test.js
git commit -m "feat(sms): handleCant un-assigns staffer and re-opens the shift"
```

---

## Task 7: `smsInbound.js` — admin alert dispatch

**Files:**
- Modify: `server/utils/smsInbound.js`

Admin alerts on inbound events. Per the locked decisions: an inbound client text → SMS to `ADMIN_PHONE`; a staff CANT → SMS if the event is under 7 days out else email to `ADMIN_EMAIL`; an unknown sender or staff free-form text → email to `ADMIN_EMAIL` (low urgency, cost-conscious). Every alert is wrapped non-blocking — an alert failure must never break the webhook 200. Inbound text (and any client/staff free-text field interpolated into an alert) is attacker-controlled, so it MUST be HTML-escaped before it enters any email HTML body — never interpolate it raw into an `html:` string. This is admin-facing copy; keep it em-dash-free for house-style consistency.

- [ ] **Step 1: Add the alert functions**

Add to `server/utils/smsInbound.js`. First add these requires near the top (after the existing `const { pool } = require('../db');`):

```javascript
const Sentry = require('@sentry/node');
const { sendSMS, normalizePhone } = require('./sms');
const { sendEmail } = require('./email');
const { getEventTypeLabel } = require('./eventTypes');
```

Then add before `module.exports`:

```javascript
/** Escape HTML metacharacters so untrusted inbound text is safe in email HTML. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Run an alert send without letting a failure escape. */
async function safeAlert(label, fn) {
  try {
    await fn();
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { feature: 'sms-inbound-alert', alert: label } });
    }
    console.error(`[smsInbound] admin alert "${label}" failed (non-blocking):`, err.message);
  }
}

/** SMS the admin that a client texted in. ADMIN_PHONE unset → skipped. */
async function alertInboundClient(client, body) {
  await safeAlert('inbound_client', async () => {
    const adminPhone = normalizePhone(process.env.ADMIN_PHONE || '');
    if (!adminPhone) {
      console.log('[smsInbound] ADMIN_PHONE unset — inbound-client alert skipped');
      return;
    }
    const name = client.name || 'A client';
    // Truncate the inbound text so the outbound alert SMS cannot exceed
    // Twilio's 1600-char limit and fail to send.
    const snippet = (body || '').slice(0, 600);
    await sendSMS({
      to: adminPhone,
      body: `${name} texted Dr. Bartender: "${snippet}". Reply in the admin Messages page.`,
    });
  });
}

/**
 * Alert the admin that a staffer texted CANT. Channel by lead time: event
 * under 7 days out and ADMIN_PHONE configured -> SMS (urgent); otherwise
 * (7+ days out, OR under 7 days but no ADMIN_PHONE) -> email. The alert is
 * dropped only if BOTH ADMIN_PHONE and ADMIN_EMAIL are unset.
 *
 * @param {Object} cant - a successful handleCant(...) result
 */
async function alertStaffCant(cant) {
  await safeAlert('staff_cant', async () => {
    const eventDate = new Date(cant.eventDate);
    const dayMs = 24 * 60 * 60 * 1000;
    const daysOut = Math.floor((eventDate.getTime() - Date.now()) / dayMs);
    const eventLabel = getEventTypeLabel({ event_type: cant.eventType, event_type_custom: cant.eventTypeCustom });
    const who = cant.clientName ? `${eventLabel} for ${cant.clientName}` : `shift #${cant.shiftId}`;
    const dateStr = eventDate.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
    const adminPhone = normalizePhone(process.env.ADMIN_PHONE || '');

    // Event under 7 days out -> urgent SMS, but ONLY if ADMIN_PHONE is set.
    // If it is not set, fall through to email rather than dropping the alert.
    if (daysOut < 7 && adminPhone) {
      await sendSMS({
        to: adminPhone,
        body: `Staffing alert: a bartender dropped the ${who} on ${dateStr} (${daysOut < 0 ? 'past due' : daysOut + ' days out'}). The shift is re-opened and needs restaffing.`,
      });
      return;
    }
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
      console.log('[smsInbound] ADMIN_PHONE and ADMIN_EMAIL both unset — staff-CANT alert skipped');
      return;
    }
    await sendEmail({
      to: adminEmail,
      subject: `Bartender dropped the ${dateStr} shift`,
      html: `<p>A bartender texted CANT for the <strong>${escapeHtml(who)}</strong> on <strong>${escapeHtml(dateStr)}</strong> (${daysOut} days out).</p><p>The shift has been re-opened and needs restaffing. It will show as unstaffed on the Events dashboard.</p>`,
      text: `A bartender texted CANT for the ${who} on ${dateStr} (${daysOut} days out). The shift has been re-opened and needs restaffing.`,
    });
  });
}

/** Email the admin about an inbound text the system took no action on. */
async function alertAdminEmail(subject, body) {
  await safeAlert('admin_email', async () => {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (!adminEmail) {
      console.log('[smsInbound] ADMIN_EMAIL unset — admin email skipped');
      return;
    }
    await sendEmail({
      to: adminEmail,
      subject,
      html: `<p>${escapeHtml(body)}</p>`,
      text: body,
    });
  });
}
```

- [ ] **Step 2: Update exports**

Add `alertInboundClient, alertStaffCant, alertAdminEmail` to `module.exports`.

- [ ] **Step 3: Verify lint**

```bash
npx eslint server/utils/smsInbound.js
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/utils/smsInbound.js
git commit -m "feat(sms): admin alert dispatch for inbound texts and staff CANT"
```

---

## Task 8: `smsInbound.js` orchestrator + `routes/sms.js` webhook + mount

**Files:**
- Modify: `server/utils/smsInbound.js`
- Create: `server/routes/sms.js`
- Modify: `server/index.js`

`processInboundSms` is the orchestrator that ties Tasks 2-7 together. `server/routes/sms.js` exposes `POST /inbound` — a Twilio-signature-verified webhook with no JWT. Twilio posts `application/x-www-form-urlencoded`, which the global `express.urlencoded()` in `server/index.js` already parses, so no raw-body carve-out is needed; `twilio.validateRequest` is computed over the public URL + parsed params. The public webhook is rate-limited (the `inboundLimiter` below mirrors the limiter on `server/routes/thumbtack.js`), and the Twilio Console webhook URL must be configured to exactly match `${protocol}://${host}/api/sms/inbound` with no query string, since `validateRequest` hashes the exact URL.

**Webhook response contract.** The webhook returns exactly one of three responses: **403** on a bad or missing Twilio signature (rejected before any processing); **500** on an unexpected processing error — Twilio then retries with backoff, which is safe because `processInboundSms` dedupes on the Twilio `MessageSid` (FIX A) so a retried delivery is a no-op rather than a lost message or a double-applied action; **200 with TwiML** on every handled outcome, including a deduped duplicate (an empty `<Response>`, or a `<Response><Message>` when a staff reply is due). Returning 500 (rather than swallowing the error into a 200) is what makes Twilio retry a transient DB failure instead of silently dropping the inbound message.

- [ ] **Step 1: Add `processInboundSms` to `smsInbound.js`**

Add to `server/utils/smsInbound.js` before `module.exports`:

```javascript
/** Format a date for staff-facing reply copy, e.g. "June 15". */
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

/**
 * Orchestrate one inbound SMS: classify, look up the sender, store the row,
 * run keyword/response-code actions, dispatch admin alerts. Returns a short
 * `outcome` for logging plus an optional `reply` — a string the webhook
 * renders into a TwiML <Message> so the texter gets an SMS back. Never throws
 * for an expected condition; a thrown error is left for the route to catch.
 * Dedupes on `twilioSid`: if the MessageSid was already recorded as an inbound
 * row, the delivery is a Twilio retry and is a no-op (`outcome: 'duplicate'`).
 *
 * @param {Object} args
 * @param {string} args.from - inbound E.164 number
 * @param {string} args.body - message text
 * @param {string} [args.twilioSid]
 * @returns {Promise<{outcome:string, reply:string|null}>}
 */
async function processInboundSms({ from, body, twilioSid }) {
  const text = (body || '').trim();

  // Idempotency: Twilio retries an inbound webhook on timeout. If this
  // MessageSid was already recorded as an inbound row, this delivery is a
  // retry — do nothing. Re-running handleCant/handleConfirm would act on the
  // wrong shift (the nearest-approved shift changes once the first run fires).
  if (twilioSid) {
    const dup = await pool.query(
      "SELECT 1 FROM sms_messages WHERE twilio_sid = $1 AND direction = 'inbound' LIMIT 1",
      [twilioSid]
    );
    if (dup.rowCount > 0) return { outcome: 'duplicate', reply: null };
  }

  const sender = await lookupSender(from);

  // STOP/START — handled before sender-type branching, for any sender. We
  // record the preference internally and tag the message row's metadata for
  // audit (spec 8.5 step 3). We do NOT send our own reply: US carrier rules
  // make Twilio send the mandated STOP/START compliance reply itself, so a
  // reply from us would duplicate it.
  const optKeyword = detectOptKeyword(text);
  if (optKeyword) {
    const clientId = sender.type === 'client' ? sender.client.id : null;
    await recordInboundMessage({ fromPhone: from, body: text, clientId, twilioSid, metadata: { opt_keyword: optKeyword } });
    if (optKeyword === 'stop') await applyOptOut(sender);
    else await applyOptIn(sender);
    return { outcome: `opt_${optKeyword}`, reply: null };
  }

  // Record the message (client_id set only for a client sender).
  const clientId = sender.type === 'client' ? sender.client.id : null;
  await recordInboundMessage({ fromPhone: from, body: text, clientId, twilioSid });

  if (sender.type === 'client') {
    // No auto-reply to clients — the admin replies personally from the
    // Messages page. We just alert the admin a client texted in.
    await alertInboundClient(sender.client, text);
    return { outcome: 'client_message', reply: null };
  }

  if (sender.type === 'staff') {
    const code = detectResponseCode(text);
    if (code === 'confirm') {
      const r = await handleConfirm(sender.staffUserId);
      const reply = r.ok
        ? `Confirmed from Dr. Bartender: you're acknowledged for the ${fmtDate(r.eventDate)} shift${r.clientName ? ' (' + r.clientName + ')' : ''}. See you there.`
        : 'Dr. Bartender: we did not find an upcoming shift to confirm for you. Reach out if that seems wrong.';
      return { outcome: r.ok ? 'staff_confirm' : 'staff_confirm_no_shift', reply };
    }
    if (code === 'cant') {
      const cant = await handleCant(sender.staffUserId);
      if (cant.ok) {
        await alertStaffCant(cant);
        return {
          outcome: 'staff_cant',
          reply: `Got it from Dr. Bartender: you are off the ${fmtDate(cant.eventDate)} shift${cant.clientName ? ' (' + cant.clientName + ')' : ''}. We will take it from here.`,
        };
      }
      await alertAdminEmail('Staff texted CANT but has no upcoming shift',
        `A staff member texted CANT but the system found no approved upcoming shift for them. Inbound text: "${text}"`);
      return {
        outcome: 'staff_cant_no_shift',
        reply: 'Dr. Bartender: we did not find an upcoming shift to release for you. Reach out if that seems wrong.',
      };
    }
    // Free-form staff text — route to admin, and redirect the texter. Spec
    // section 3 deliberately keeps staff off this number for chat.
    await alertAdminEmail('Staff texted Dr. Bartender',
      `A staff member texted: "${text}". No response code matched, so no system action was taken.`);
    return {
      outcome: 'staff_freeform',
      reply: 'Dr. Bartender: this number is automated. For anything else, call or text Dallas directly.',
    };
  }

  // Unknown sender.
  await alertAdminEmail('Text from an unknown number',
    `An unrecognized number (${from}) texted Dr. Bartender: "${text}".`);
  return { outcome: 'unknown_sender', reply: null };
}
```

Add `processInboundSms` to `module.exports`. (`fmtDate` stays module-internal — no need to export it.)

- [ ] **Step 2: Create `server/routes/sms.js` with the webhook**

```javascript
const express = require('express');
const twilio = require('twilio');
const Sentry = require('@sentry/node');
const { processInboundSms } = require('../utils/smsInbound');

const router = express.Router();

const rateLimit = require('express-rate-limit');

// Rate-limit the public inbound webhook (mirrors the Thumbtack webhook
// limiter). Caps abuse / signature-computation CPU / DB-write amplification.
// Twilio's real inbound volume is far below this.
const inboundLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
});

/**
 * Verify an inbound request is genuinely from Twilio. validateRequest hashes
 * the public URL + the sorted POST params with the account auth token.
 * `trust proxy` is set in server/index.js, so req.protocol / req.get('host')
 * already resolve the forwarded values. Any throw is treated as "invalid".
 */
function isValidTwilioRequest(req) {
  try {
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!authToken) return false;
    const signature = req.headers['x-twilio-signature'];
    if (!signature) return false;
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    return twilio.validateRequest(authToken, signature, url, req.body || {});
  } catch (err) {
    console.warn('[sms/inbound] signature verification threw:', err.message);
    return false;
  }
}

/**
 * POST /api/sms/inbound — Twilio inbound-message webhook. No JWT (it is a
 * provider webhook; authenticity comes from the Twilio signature). Response
 * contract: 403 on a bad/missing signature; 500 on an unexpected processing
 * error (Twilio retries with backoff — safe because processInboundSms dedupes
 * on MessageSid); 200 with TwiML on every handled outcome, including a deduped
 * duplicate.
 */
router.post('/inbound', inboundLimiter, async (req, res) => {
  const inProd = process.env.NODE_ENV === 'production';

  // Signature gate. In production a bad/missing signature is rejected. In dev,
  // Twilio creds may be absent — allow through so the webhook is testable.
  if (!isValidTwilioRequest(req)) {
    if (inProd) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureMessage('Twilio inbound webhook signature failure', {
          level: 'warning', tags: { webhook: 'twilio', reason: 'invalid_signature' },
        });
      }
      return res.status(403).send('Invalid signature');
    }
    console.warn('[sms/inbound] signature not validated (dev mode — allowing)');
  }

  let reply = null;
  try {
    const result = await processInboundSms({
      from: req.body.From,
      body: req.body.Body,
      twilioSid: req.body.MessageSid,
    });
    reply = result.reply;
    console.log(`[sms/inbound] processed: ${result.outcome}`);
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { webhook: 'twilio' }, extra: { from: req.body && req.body.From } });
    }
    console.error('[sms/inbound] processing failed:', err.message);
    // Return 500 so Twilio retries with backoff. processInboundSms dedupes on
    // MessageSid (FIX A), so a retry of an already-recorded message is a safe
    // no-op — the message is not lost and the action is not double-applied.
    return res.status(500).send('Processing error');
  }

  // Render the optional reply into TwiML. `reply` is system-generated copy;
  // escape XML metacharacters defensively regardless.
  const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const twiml = reply
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(reply)}</Message></Response>`
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  res.set('Content-Type', 'text/xml').send(twiml);
});

module.exports = router;
```

- [ ] **Step 3: Mount the route in `server/index.js`**

In `server/index.js`, find the route-registration block (the `app.use('/api/...', require('./routes/...'))` lines, around line 165-194). Add, grouped with the other routes:

```javascript
app.use('/api/sms', require('./routes/sms'));
```

No body-parser carve-out is required — Twilio posts `application/x-www-form-urlencoded`, consumed by the existing global `express.urlencoded({ extended: true })`.

- [ ] **Step 4: Verify lint and that the route module loads**

```bash
npx eslint server/utils/smsInbound.js server/routes/sms.js server/index.js
node -e "require('./server/routes/sms.js'); console.log('sms route loads OK')"
```

Expected: no lint errors; the `node -e` prints `sms route loads OK` (env-var info logs are fine).

Also confirm `express-rate-limit` is in `package.json` (it is — `server/routes/thumbtack.js` already uses it); if it is not present, that is a blocker to report.

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsInbound.js server/routes/sms.js server/index.js
git commit -m "feat(sms): Twilio inbound webhook + processInboundSms orchestrator"
```

---

## Task 9: `routes/sms.js` — admin thread API endpoints

**Files:**
- Modify: `server/routes/sms.js`

Four admin endpoints back the Messages page, mirroring the email-conversations endpoints in `server/routes/emailMarketing.js` (lines 744-823): a conversation list, a per-client thread, a reply (sends an outbound SMS and logs it), and a mark-read. All require `auth` plus an admin/manager guard.

- [ ] **Step 1: Read the auth pattern to mirror**

Open `server/routes/emailMarketing.js` and read its top-of-file imports and the conversation routes (lines ~742-823). Note the exact names it imports for the auth middleware and the admin/manager guard (used as `router.get('/conversations', auth, requireAdminOrManager, asyncHandler(...))`). Use the SAME imports in `sms.js`.

- [ ] **Step 2: Add the imports and endpoints to `server/routes/sms.js`**

At the top of `server/routes/sms.js`, add (matching what `emailMarketing.js` imports — adjust names if that file differs):

```javascript
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../utils/errors');
const { sendSMS, normalizePhone } = require('../utils/sms');
// Auth: import `auth` and the admin/manager guard in a single destructured
// require, exactly as server/routes/emailMarketing.js does — adjust the names
// if that file differs. A single require avoids the no-duplicate-imports lint
// failure that two separate requires of the same module would cause.
const { auth, requireAdminOrManager } = require('../middleware/auth');
```

If `emailMarketing.js` imports the guard from a different path or under a different name, use that instead — the requirement is "the same admin/manager guard the email conversations endpoints use."

Then add these routes before `module.exports`:

```javascript
/**
 * GET /api/sms/conversations — one row per client that has any SMS, newest
 * activity first, with an unread inbound count.
 */
router.get('/conversations', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT c.id AS client_id, c.name, c.phone,
      (SELECT COUNT(*) FROM sms_messages m
        WHERE m.client_id = c.id AND m.direction = 'inbound' AND m.read_at IS NULL)::int AS unread_count,
      (SELECT MAX(m2.created_at) FROM sms_messages m2 WHERE m2.client_id = c.id) AS last_message_at
    FROM clients c
    WHERE EXISTS (SELECT 1 FROM sms_messages m3 WHERE m3.client_id = c.id)
    ORDER BY last_message_at DESC
    LIMIT 200
  `);
  res.json(result.rows);
}));

/** GET /api/sms/conversations/:clientId — full message thread, oldest first. */
router.get('/conversations/:clientId', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isInteger(clientId)) throw new ValidationError({ clientId: 'Invalid client id.' });
  const result = await pool.query(
    `SELECT id, direction, body, status, twilio_sid, read_at, created_at
     FROM sms_messages WHERE client_id = $1 ORDER BY created_at ASC LIMIT 500`,
    [clientId]
  );
  res.json(result.rows);
}));

/**
 * POST /api/sms/conversations/:clientId/reply — send an outbound SMS to the
 * client and log it. Body: { body }.
 */
router.post('/conversations/:clientId/reply', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isInteger(clientId)) throw new ValidationError({ clientId: 'Invalid client id.' });
  const body = (req.body.body || '').trim();
  if (!body) throw new ValidationError({ body: 'Message body is required.' });

  const c = await pool.query('SELECT id, name, phone FROM clients WHERE id = $1', [clientId]);
  const client = c.rows[0];
  if (!client) throw new NotFoundError('Client not found.');
  const to = normalizePhone(client.phone || '');
  if (!to) throw new ValidationError({ phone: 'This client has no valid phone number on file.' });

  let twilioSid = null;
  let status = 'sent';
  let errorMessage = null;
  try {
    const sent = await sendSMS({ to, body });
    twilioSid = sent && sent.sid ? sent.sid : null;
  } catch (err) {
    status = 'failed';
    errorMessage = String(err.message || err).slice(0, 500);
  }

  const row = await pool.query(
    `INSERT INTO sms_messages
       (direction, client_id, recipient_phone, recipient_name, body, message_type, status, twilio_sid, error_message, sender_id)
     VALUES ('outbound', $1, $2, $3, $4, 'general', $5, $6, $7, $8)
     RETURNING id, direction, body, status, twilio_sid, read_at, created_at`,
    [clientId, to, client.name || null, body, status, twilioSid, errorMessage, req.user.id]
  );

  if (status === 'failed') {
    throw new ValidationError({ body: 'The SMS could not be sent. It is saved in the thread as failed.' });
  }
  res.status(201).json(row.rows[0]);
}));

/**
 * PUT /api/sms/conversations/:clientId/read — mark every unread inbound
 * message for this client as read (clears the unread badge contribution).
 */
router.put('/conversations/:clientId/read', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const clientId = Number(req.params.clientId);
  if (!Number.isInteger(clientId)) throw new ValidationError({ clientId: 'Invalid client id.' });
  const result = await pool.query(
    `UPDATE sms_messages SET read_at = NOW()
     WHERE client_id = $1 AND direction = 'inbound' AND read_at IS NULL`,
    [clientId]
  );
  res.json({ marked_read: result.rowCount });
}));
```

Note: the webhook route from Task 8 uses no `asyncHandler` (it is a `provider` webhook that catches its own errors and always returns 200). These admin routes DO use `asyncHandler` — they are normal authenticated API routes and should funnel errors to the global handler.

- [ ] **Step 3: Verify lint and module load**

```bash
npx eslint server/routes/sms.js
node -e "require('./server/routes/sms.js'); console.log('sms route loads OK')"
```

Expected: no errors; prints `sms route loads OK`. If the `node -e` throws `Cannot find module` for an auth import, the import path/name did not match `emailMarketing.js` — fix it to match that file.

- [ ] **Step 4: Commit**

```bash
git add server/routes/sms.js
git commit -m "feat(sms): admin thread API — conversations list, thread, reply, mark-read"
```

---

## Task 10: Add the `unread_sms` count to the sidebar badge endpoint

**Files:**
- Modify: `server/routes/admin/settings.js`

The admin sidebar badge system fetches `GET /api/admin/badge-counts` every 60s. Add an `unread_sms` count so the Messages nav item (Task 11) shows unread inbound texts. The count filters on `client_id IS NOT NULL` — staff and unknown-sender inbound rows never appear in any thread, so excluding them keeps the badge in sync with what the Messages page can actually triage and clear.

- [ ] **Step 1: Add the subquery**

In `server/routes/admin/settings.js`, find the `GET /badge-counts` handler (around line 123). Add one subquery to the `SELECT` (after the `open_tester_bugs` line, before the closing backtick):

```javascript
      (SELECT COUNT(*) FROM sms_messages
         WHERE direction = 'inbound' AND read_at IS NULL AND client_id IS NOT NULL)::int AS unread_sms
```

The full `SELECT` list becomes the existing five counts plus `unread_sms`. Make sure the line before it ends with a comma.

- [ ] **Step 2: Verify**

```bash
npx eslint server/routes/admin/settings.js
```

Expected: no errors. (The endpoint is verified live in Task 13.)

- [ ] **Step 3: Commit**

```bash
git add server/routes/admin/settings.js
git commit -m "feat(sms): unread_sms count in admin badge-counts endpoint"
```

---

## Task 11: Admin Messages page — component, styles, route, nav item

**Files:**
- Create: `client/src/pages/admin/Messages.js`
- Modify: `client/src/index.css`
- Modify: `client/src/App.js`
- Modify: `client/src/components/adminos/nav.js`

A standalone admin page modeled on `client/src/pages/admin/EmailConversations.js`: a two-pane layout (client thread list + message thread), inbound/outbound bubbles, a reply box. Selecting a thread marks it read. Built with its own `sms-*` classes using Admin OS design tokens.

- [ ] **Step 1: Create `client/src/pages/admin/Messages.js`**

```javascript
import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

export default function Messages() {
  const toast = useToast();
  const [threads, setThreads] = useState([]);
  const [selectedClientId, setSelectedClientId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);

  const fetchThreads = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await api.get('/sms/conversations');
      setThreads(res.data);
    } catch (err) {
      toast.error('Failed to load conversations. Try refreshing.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { fetchThreads(); }, [fetchThreads]);

  const selectThread = async (clientId) => {
    setSelectedClientId(clientId);
    try {
      const res = await api.get(`/sms/conversations/${clientId}`);
      setMessages(res.data);
      // Mark inbound messages read, then refresh the list so the badge clears.
      await api.put(`/sms/conversations/${clientId}/read`);
      fetchThreads(true);
    } catch (err) {
      toast.error('Failed to load conversation. Try again.');
    }
  };

  const handleReply = async () => {
    if (!replyText.trim() || !selectedClientId) return;
    setReplying(true);
    try {
      await api.post(`/sms/conversations/${selectedClientId}/reply`, { body: replyText });
      setReplyText('');
      toast.success('Reply sent.');
      const res = await api.get(`/sms/conversations/${selectedClientId}`);
      setMessages(res.data);
    } catch (err) {
      toast.error(err.message || 'Failed to send reply.');
      // The failed send is still persisted as a 'failed' row — refetch so it shows.
      try {
        const res = await api.get(`/sms/conversations/${selectedClientId}`);
        setMessages(res.data);
      } catch (_) { /* ignore secondary failure */ }
    } finally {
      setReplying(false);
    }
  };

  const selectedThread = threads.find(t => t.client_id === selectedClientId);

  if (loading) return <div className="loading"><div className="spinner" />Loading...</div>;

  return (
    <div className="sms-page">
      <h1 className="sms-page-title">Messages</h1>
      {threads.length === 0 ? (
        <div className="sms-empty">
          No SMS conversations yet. Client and staff texts to the business number appear here.
        </div>
      ) : (
        <div className="sms-layout">
          <div className="sms-list">
            {threads.map(thread => (
              <div
                key={thread.client_id}
                className={`sms-list-item ${selectedClientId === thread.client_id ? 'sms-list-item-active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => selectThread(thread.client_id)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectThread(thread.client_id); } }}
              >
                <div className="sms-list-item-head">
                  <strong>{thread.name || 'Unknown client'}</strong>
                  {thread.unread_count > 0 && (
                    <span className="sms-unread-badge">{thread.unread_count}</span>
                  )}
                </div>
                <div className="sms-list-item-sub">{thread.phone || 'No phone on file'}</div>
                <div className="sms-list-item-time">
                  {thread.last_message_at && new Date(thread.last_message_at).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>

          <div className="sms-thread">
            {!selectedClientId ? (
              <div className="sms-placeholder">Select a conversation to view messages.</div>
            ) : (
              <>
                <div className="sms-thread-head">
                  <h3>{selectedThread?.name || 'Unknown client'}</h3>
                  <span className="muted">{selectedThread?.phone}</span>
                </div>

                <div className="sms-messages">
                  {messages.map(msg => (
                    <div key={msg.id} className={`sms-bubble sms-bubble-${msg.direction}`}>
                      <div className="sms-bubble-body">{msg.body || '(no text)'}</div>
                      <div className="sms-bubble-meta">
                        {msg.direction === 'outbound' ? 'You' : 'Client'}
                        {' · '}
                        {new Date(msg.created_at).toLocaleString()}
                        {msg.status === 'failed' && ' · failed to send'}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="sms-reply">
                  <textarea
                    className="form-input"
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    placeholder="Type your reply..."
                    rows={3}
                  />
                  <button
                    className="btn btn-primary"
                    onClick={handleReply}
                    disabled={replying || !replyText.trim() || !selectedThread?.phone}
                  >
                    {replying ? 'Sending...' : 'Send SMS'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Add styles to `client/src/index.css`**

Append to `client/src/index.css`:

```css
/* ─── Admin SMS Messages page ─────────────────────────────── */
.sms-page { padding: var(--gap, 16px); }
.sms-page-title { margin: 0 0 var(--gap, 16px); }
.sms-empty,
.sms-placeholder { color: var(--ink-2, #667); padding: 2rem; text-align: center; }
.sms-layout {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: var(--gap, 16px);
  min-height: 60vh;
}
.sms-list {
  border: 1px solid var(--line-1, #e3e3e8);
  border-radius: 8px;
  overflow-y: auto;
  max-height: 70vh;
}
.sms-list-item {
  padding: 10px 12px;
  border-bottom: 1px solid var(--line-1, #e3e3e8);
  cursor: pointer;
}
.sms-list-item:hover { background: var(--bg-2, #f5f5f7); }
.sms-list-item-active { background: var(--bg-2, #f5f5f7); }
.sms-list-item-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.sms-list-item-sub { font-size: 13px; color: var(--ink-2, #667); }
.sms-list-item-time { font-size: 12px; color: var(--ink-2, #667); }
.sms-unread-badge {
  background: hsl(var(--danger-h, 0) 70% 50%);
  color: #fff;
  border-radius: 999px;
  font-size: 12px;
  padding: 1px 7px;
  min-width: 18px;
  text-align: center;
}
.sms-thread {
  border: 1px solid var(--line-1, #e3e3e8);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
}
.sms-thread-head {
  padding: 10px 14px;
  border-bottom: 1px solid var(--line-1, #e3e3e8);
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.sms-thread-head h3 { margin: 0; }
.sms-messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 55vh;
}
.sms-bubble { max-width: 75%; padding: 8px 12px; border-radius: 12px; }
.sms-bubble-inbound { align-self: flex-start; background: var(--bg-2, #f0f0f3); }
.sms-bubble-outbound { align-self: flex-end; background: var(--accent-soft, #e8f0fe); }
.sms-bubble-body { white-space: pre-wrap; word-break: break-word; }
.sms-bubble-meta { font-size: 11px; color: var(--ink-2, #667); margin-top: 3px; }
.sms-reply {
  border-top: 1px solid var(--line-1, #e3e3e8);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
@media (max-width: 720px) {
  .sms-layout { grid-template-columns: 1fr; }
}
```

If any `var(--*)` token does not exist in `client/src/styles/drb-tokens.css`, the fallback after the comma renders — leave the fallbacks in. If the dark skin needs different bubble colors, that can be a follow-up; the fallbacks keep it legible.

- [ ] **Step 3: Add the route to `client/src/App.js`**

Near the other admin-page lazy imports (around lines 70-98), add:

```javascript
const Messages = lazy(() => import('./pages/admin/Messages'));
```

Inside the admin shell route block (the `<Route element={<ProtectedRoute adminOnly><AdminLayout /></ProtectedRoute>}>` block), add:

```javascript
<Route path="/messages" element={<Messages />} />
```

- [ ] **Step 4: Add the nav item to `client/src/components/adminos/nav.js`**

In the `Workspace` section's `items` array, add a Messages entry after `clients`:

```javascript
    { id: 'messages',    label: 'Messages',  icon: 'chat',      path: '/messages',  badgeKey: 'unread_sms' },
```

(Use the `chat` icon from `client/src/components/adminos/Icon.js` — it exists, and `mail` is already taken by the Marketing nav item.)

- [ ] **Step 5: Verify the client build**

Per project memory, client lint is only enforced by Vercel CI; verify locally with a production build:

```bash
cd client && CI=true npx react-scripts build
```

Expected: build succeeds with no errors. Then `cd ..`.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/Messages.js client/src/index.css client/src/App.js client/src/components/adminos/nav.js
git commit -m "feat(sms): admin Messages page with two-pane SMS thread UI and unread badge"
```

---

## Task 12: Documentation

**Files:**
- Modify: `.env.example`
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: `.env.example`**

The Twilio vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`) already exist. Confirm they are present; if a comment block describes them, add a note that `TWILIO_AUTH_TOKEN` is now also used to verify the inbound webhook signature. No new variable is introduced by this plan.

- [ ] **Step 2: `.claude/CLAUDE.md`**

In the Environment Variables table, update the `TWILIO_*` description to note inbound use. Find the `TWILIO_*` row and change its description to:

```markdown
| `TWILIO_*` | Twilio SMS — account SID, auth token, from-number. `TWILIO_AUTH_TOKEN` also verifies the inbound-SMS webhook signature (`POST /api/sms/inbound`). |
```

- [ ] **Step 3: `README.md`**

Add `server/routes/sms.js` and `server/utils/smsInbound.js` to the folder-structure tree (with short descriptions matching the surrounding style), and add `client/src/pages/admin/Messages.js`. Add a one-line entry to the Key Features section: two-way SMS (inbound webhook, STOP/CONFIRM/CANT handling, admin Messages thread).

- [ ] **Step 4: `ARCHITECTURE.md`**

Add `POST /api/sms/inbound` and the four `GET/POST/PUT /api/sms/conversations*` endpoints to the API route table. In the schema section, note the `sms_messages` additions (`client_id`, `read_at`, `metadata`) and `shift_requests.acknowledged_at`. Add a short Third-Party Integrations / messaging note describing the Twilio inbound webhook (signature-verified, STOP/START opt-out, CONFIRM/CANT staff response codes).

- [ ] **Step 5: Commit**

```bash
git add .env.example .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs(sms): document the inbound SMS webhook, routes, and schema additions"
```

---

## Task 13: End-to-end smoke test

This is a verification pass — no code changes.

- [ ] **Step 1: Run all `smsInbound` tests**

```bash
node --test server/utils/smsInbound.test.js
```

Expected: all tests pass (19).

- [ ] **Step 2: Lint**

```bash
npx eslint server/utils/smsInbound.js server/routes/sms.js server/index.js server/routes/admin/settings.js
```

Expected: no errors.

- [ ] **Step 3: Restart the dev server, confirm a clean boot**

Restart the Claude-managed dev server (kill the PID on port 5000, relaunch `npm run dev`). Watch the logs: the server boots with no error referencing `sms.js` or `smsInbound.js`.

- [ ] **Step 4: Simulate an inbound client text**

With the dev server running, POST a Twilio-shaped form body to the webhook (in dev the signature check is skipped). Use a phone number that matches an existing dev client:

```bash
curl -s -X POST http://localhost:5000/api/sms/inbound \
  -d "From=+1<existing_client_10_digit_number>" \
  -d "Body=hello this is a test" \
  -d "MessageSid=SMdevtest1"
```

Expected: HTTP 200 with an empty `<Response>`. Then:

```bash
psql "$DATABASE_URL" -c "SELECT direction, client_id, body, status FROM sms_messages WHERE twilio_sid = 'SMdevtest1';"
```

Expected: one row, `direction=inbound`, `client_id` set to that client, `status=received`. The dev console shows `[sms/inbound] processed: client_message` and a `[DEV] SMS skipped` line for the admin alert (no Twilio creds in dev).

- [ ] **Step 5: Verify inbound-webhook idempotency (duplicate MessageSid)**

Twilio retries a webhook on timeout; the dedup guard (FIX A) must make a retry a no-op. POST the SAME `MessageSid` twice. Use a fresh staff CONFIRM so a side effect (the shift acknowledgement) is observable — pick a dev staff member with a `contractor_profiles.phone` and an approved upcoming shift, and clear `acknowledged_at` first:

```bash
psql "$DATABASE_URL" -c "UPDATE shift_requests sr SET acknowledged_at = NULL FROM shifts s WHERE sr.shift_id = s.id AND sr.user_id = <staff_user_id> AND sr.status = 'approved' AND s.event_date >= CURRENT_DATE;"

curl -s -X POST http://localhost:5000/api/sms/inbound \
  -d "From=+1<staff_10_digit_number>" -d "Body=CONFIRM" -d "MessageSid=SMdupe1"
curl -s -X POST http://localhost:5000/api/sms/inbound \
  -d "From=+1<staff_10_digit_number>" -d "Body=CONFIRM" -d "MessageSid=SMdupe1"
```

Expected: the first call logs `[sms/inbound] processed: staff_confirm`; the second logs `[sms/inbound] processed: duplicate`. Verify only ONE row and that the side effect did not double-fire:

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM sms_messages WHERE twilio_sid = 'SMdupe1';"
```

Expected: count is exactly `1` — the retry recorded no second row, and `handleConfirm` ran only once (the duplicate POST returned before any handler executed, so the acknowledgement was not re-applied to a different shift).

- [ ] **Step 6: Simulate a STOP keyword**

```bash
curl -s -X POST http://localhost:5000/api/sms/inbound \
  -d "From=+1<same_client_number>" -d "Body=STOP" -d "MessageSid=SMdevtest2"
psql "$DATABASE_URL" -c "SELECT communication_preferences FROM clients WHERE id = <that_client_id>;"
```

Expected: `communication_preferences.sms_enabled` is now `false` and an `sms_opt_out_at` timestamp is present. Re-send with `Body=START` and confirm `sms_enabled` returns to `true`.

- [ ] **Step 7: Simulate a staff CONFIRM and CANT**

Pick a dev staff member with a `contractor_profiles.phone` and an approved upcoming shift (create one via psql if needed). POST `Body=CONFIRM` from their number; confirm `shift_requests.acknowledged_at` is stamped. POST `Body=CANT` from their number; confirm their `shift_requests.status` is `denied` with a `CANT` note and the shift's `status` is `open`.

- [ ] **Step 8: Verify the admin Messages page**

Start the client dev server if not running. Log in as an admin, open `/messages`. Expected: the test client's conversation appears in the list with an unread badge; clicking it shows the inbound message and clears the unread badge; the sidebar `Messages` nav item shows the unread count and it decrements after the thread is opened. Type a reply and send — in dev the SMS is skipped but an outbound row is added to the thread.

- [ ] **Step 9: Production signature verification (note — cannot be done in dev)**

The dev curl tests in Steps 4-7 only exercise the signature-BYPASS dev path (`isValidTwilioRequest` returns false in dev, but the route lets the request through with a warning). They do NOT prove the production signature gate works. Before production use, a real Twilio-signed inbound message must be verified end-to-end: configure the Twilio Console webhook URL to exactly `https://<api-host>/api/sms/inbound` (no query string), send a real text to the business number, and confirm the webhook is NOT rejected with 403 and the message lands in `sms_messages`. This is a verification note for the deploy/operator — it is not a dev-environment step.

- [ ] **Step 10: Stop the dev server**

No commit — this task is verification only.

---

## Self-review checklist (run after all tasks complete)

- [ ] All commits land on `main` with single-line messages.
- [ ] `git status` shows a clean working tree.
- [ ] `node --test server/utils/smsInbound.test.js` passes.
- [ ] `npx eslint` clean on all touched server files; `CI=true react-scripts build` succeeds for the client.
- [ ] `\d sms_messages` shows `client_id`, `read_at`, `metadata`; `\d shift_requests` shows `acknowledged_at`.
- [ ] The inbound webhook stores a client text, links it to the client, and fires the admin alert.
- [ ] STOP sets `sms_enabled=false`; START restores it.
- [ ] CONFIRM stamps `acknowledged_at`; CANT denies the request and re-opens the shift.
- [ ] The Messages page lists conversations, threads, replies, and clears the unread badge on open.
- [ ] `unread_sms` appears in `/api/admin/badge-counts` and drives the sidebar badge.
- [ ] No em dashes in any new client-facing or admin-facing copy.

---

## What's not in this plan (deferred)

- **Client-facing outbound SMS touches** (initial proposal SMS, sign+pay SMS, drip SMS, balance/event-eve SMS) — Comms Phase 3. Those handlers should write their outbound `sms_messages` rows with `client_id` set so they appear in the Messages thread; this plan's reply endpoint already establishes that pattern.
- **Staff-facing outbound SMS** (day-before shift reminder, post-event thank-you) and **multi-admin notification subscriptions** — Comms Phase 4. This plan uses the single `ADMIN_PHONE`/`ADMIN_EMAIL` env vars.
- **Retrofitting outbound logging** onto existing un-logged senders (`lastMinuteAlert.js`, `autoAssign.js`) — out of scope; those are not client-thread messages.
- **AI responder for staff free-form SMS** — deferred workstream; free-form staff texts route to the admin via email for now.
- **Inbound MMS / media** — only the text `Body` is processed; media URLs in the Twilio payload are ignored.
- **A per-client Messages tab on the client detail page** — the standalone `/messages` page is the v1 surface; a secondary entry point from `ClientDetail.js` can come later.
- **Phone-number collisions** — a known limitation. `lookupSender` resolves to a single best-match row (clients before staff, newest first), so if two people share a phone number, or one person is both a client and a staff member, an inbound STOP/CONFIRM/CANT resolves to only one identity. A person who is both a client and a staffer will always resolve as a client, so their staff response codes (CONFIRM/CANT) will not be processed. Acceptable for v1; revisit if it occurs.
