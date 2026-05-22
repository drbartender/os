# Comms Phase 3 — Client-Facing SMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add every client-facing automated SMS touch in the Dr. Bartender lifecycle — initial proposal, sign+pay confirmation, drip touches 1/3/5, drink-plan nudge (email + SMS), balance due-today / late SMS, payment-failure SMS, event-eve SMS, and reschedule SMS — built on a shared SMS send+log primitive and SMS template module.

**Architecture:** Build the SMS rails first: `sendAndLogSms` (a send-and-log-to-`sms_messages` primitive in `server/utils/sms.js`) and `server/utils/smsTemplates.js` (one function per SMS body, mirrors `emailTemplates.js`). Scheduled SMS touches register a new `message_type` handler with the existing dispatcher (`registerHandler`) and render via `smsTemplates` / send via `sendAndLogSms`. Immediate SMS sends (initial proposal, sign+pay, payment-failure, reschedule) are best-effort hooks added beside the existing email send, gated by `shouldSendImmediate({ channel: 'sms' })`. The drink-plan nudge and event-eve touches are full new builds. New scheduled handlers register a `priority` option (inert until Phase 4b) per the contract priority ladder; handlers that are one half of an email+SMS pair additionally register `multiChannel: true` (also Phase-4b-defined and inert until then) so Phase 4b's delivery-failure logic does not channel-substitute them (spec 7.3).

**Tech Stack:** Node.js 18 / Express 4.18, Neon PostgreSQL via `pg` (raw SQL), Twilio SMS, Resend email, `@sentry/node`, `node:test` for tests.

---

## Reference: ground truth

- **Contract:** `.comms-sms-contract.md` (repo root). Section 4 pins the SMS rails; section 5 pins the priority ladder; section 9 lists Phase 3 scope. PINNED items are fixed.
- **Spec:** `docs/superpowers/specs/2026-05-20-automated-communication-design.md`. SMS/email copy is verbatim from spec section 5 (touches 1.2, 1.3, 2.1, 3.3, 3.5, 3.6, 3.7, 3.12, 3.13).
- **Dispatcher API (already built):**
  - `registerHandler(messageType, handlerFn, options)` — `options`: `offsetFromEventDate` (seconds, negative = before anchor, `null` = anchor-independent), `anchor` (`event_date | balance_due_date | created_at | completed_at`, default `event_date`), `category` (`operational | marketing`, default `operational`). Unknown option keys (e.g. `priority`, `cooldownExempt`, `multiChannel`) are silently ignored today — Phase 4b activates them. (Verified against `server/utils/scheduledMessageDispatcher.js` on branch `comms`: `registerHandler` builds `meta` from only `offsetFromEventDate` / `anchor` / `category`; `getHandlerMeta` returns only those three. The Phase 3 handler-metadata tests therefore assert only those three fields and need no `priority` / `multiChannel` assertions — Phase 4b adds both the option handling and its tests.)
  - Handler signature: `async ({ entity, recipient, scheduledMessage }) => void`. Normal return → row `sent`; throw → row `failed`.
  - `scheduleMessage({ entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor })` — inserts one pending `scheduled_messages` row; idempotent on the pending tuple; returns the row or `null` on conflict. `entityId`/`recipientId` must be integers.
  - `shouldSendImmediate({ proposal, client, channel })` — pure; returns `{ ok: true }` or `{ ok: false, reason }`. Already handles `channel: 'sms'`.
  - `computeScheduledFor(messageType, proposal)` — applies a handler's offset to its anchor, forces 10:00 event-local. Throws on a `null`-offset or unregistered type. Do NOT use for wall-clock-anchored touches (event-eve).
- **SMS today:** `server/utils/sms.js` exports `sendSMS({ to, body })` (bare Twilio send; dev returns `{ sid: 'dev-skipped' }`) and `normalizePhone(phone)` (E.164, `null` on unparseable). Neither logs nor checks preferences.
- **Naming (PINNED, contract §4.4):** SMS variant of an email touch → `<email_type>_sms`. Drip SMS → `drip_touch_1`, `drip_touch_3`, `drip_touch_5_sms`. SMS-only new touch → `event_eve`. Email+SMS new touch → `drink_plan_nudge` (email) + `drink_plan_nudge_sms` (SMS).

## Reference: priority ladder (contract §5)

Register each NEW scheduled handler with a `priority` option (and `cooldownExempt` / `multiChannel` where noted). All three are inert until Phase 4b. Immediate sends are not handlers — no priority. `multiChannel: true` marks a handler that is one half of an email+SMS pair; per spec 7.3 Phase 4b's delivery-failure logic must not channel-substitute such a row (each channel's row is independent — a dead channel suppresses while the other fires). Single-channel touches (`drip_touch_1`, `drip_touch_3`, `event_eve`) omit it.

| message_type | priority | cooldownExempt | multiChannel | category | anchor / offset |
|---|---|---|---|---|---|
| `drip_touch_1` | 4 | — | — | marketing | `created_at` / `null` |
| `drip_touch_3` | 4 | — | — | marketing | `created_at` / `null` |
| `drip_touch_5_sms` | 4 | — | **true** | marketing | `created_at` / `null` |
| `drink_plan_nudge` | 2 | — | **true** | operational | `event_date` / `-21d` |
| `drink_plan_nudge_sms` | 2 | — | **true** | operational | `event_date` / `-21d` |
| `balance_due_today_sms` | 1 | **true** | **true** | operational | `balance_due_date` / `0` |
| `balance_late_t1_sms` | 2 | — | **true** | operational | `balance_due_date` / `+1d` |
| `balance_late_t3_sms` | 2 | — | **true** | operational | `balance_due_date` / `+3d` |
| `event_eve` | 1 | **true** | — | operational | `event_date` / `null` (bespoke wall-clock timing) |

## Reference: copy rules (CLAUDE.md)

- **NO em dashes** in any client-facing copy (SMS bodies, email subjects/bodies). Use commas, periods, colons, parentheticals.
- Client SMS pattern (spec §3): `Hi, Dallas here. [content]. Let me know if you have any questions or need any changes.`
- Money is integer cents internally; display formatted by the caller. Balance amounts come from `total_price - amount_paid` (both `NUMERIC` dollar values on `proposals` — keep them in dollars for display, do not re-scale).
- SQL parameterized (`$1`, `$2`). Schema changes idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`).
- Best-effort hooks (immediate SMS sends) own a try/catch + Sentry and never rethrow into a request path.
- Commit steps: plain one-line `git commit -m "..."`, no co-author footer, no heredoc.

## File Structure

**New files:**
- `server/utils/smsTemplates.js` — one exported function per client SMS body. Returns a plain string. ~140 lines after Phase 3.
- `server/utils/smsTemplates.test.js` — unit tests for the template strings.
- `server/utils/dripSmsHandlers.js` — the three drip SMS handlers + a `registerDripSmsHandlers()` bootstrap. Kept separate from `marketingHandlers.js` (519 lines, near the 700 soft cap).
- `server/utils/drinkPlanNudge.js` — drink-plan nudge email + SMS handlers, the `drink_plan_nudge` email template builder is co-located, plus a `registerDrinkPlanNudgeHandlers()` bootstrap and a `scheduleDrinkPlanNudge(proposalId, executor)` scheduling helper.
- `server/utils/drinkPlanNudge.test.js` — tests for nudge scheduling + suppression.
- `server/utils/eventEveSms.js` — event-eve SMS handler, bespoke `computeEventEveSendAt` timing helper, `registerEventEveHandler()` bootstrap, `scheduleEventEve(proposalId, executor)` scheduling helper.
- `server/utils/eventEveSms.test.js` — tests for event-eve timing + handler.
- `server/utils/balanceSmsHandlers.js` — the three balance SMS handlers (`balance_due_today_sms`, `balance_late_t1_sms`, `balance_late_t3_sms`) + `registerBalanceSmsHandlers()` bootstrap.

**Modified files:**
- `server/db/schema.sql` — widen `sms_messages.message_type` to `TEXT`, drop its restrictive CHECK; add `event_eve` / `drink_plan_nudge` row plumbing needs nothing schema-side beyond that.
- `server/utils/sms.js` — add `sendAndLogSms`.
- `server/routes/stripe.js` — sign+pay SMS in `sendPaymentNotifications`; add a `channel:'sms'` row to `scheduleBalanceReminders`; payment-failure SMS is in its own util (see below).
- `server/utils/sendProposalSentEmail.js` — add the immediate initial-proposal SMS beside the email.
- `server/utils/paymentFailedClientNotify.js` — add the payment-failure SMS under the same 24h claim.
- `server/utils/rescheduleProposal.js` — add the reschedule SMS in `sendRescheduleEmail`.
- `server/utils/marketingHandlers.js` — add three `scheduleMessage` calls for the drip SMS rows in `scheduleDripForProposal`; update the drip-suppression `message_type` list in `onProposalSignedAndPaid`.
- `server/utils/preEventScheduling.js` — call `scheduleDrinkPlanNudge` and `scheduleEventEve` from `schedulePreEventReminders`.
- `server/index.js` — register the four new handler bootstraps at boot.
- `ARCHITECTURE.md` / `README.md` — document the new util files and the SMS touches.

---

## Task 1: Widen `sms_messages.message_type` and add `sendAndLogSms`

**Why first:** Every automated SMS in Phases 3/4a/4b logs through `sendAndLogSms`, which INSERTs into `sms_messages.message_type`. That column is today `VARCHAR(20)` with `CHECK (message_type IN ('general','invitation','reminder','announcement'))`. Phase 3 `message_type` values (`initial_proposal`, `drink_plan_nudge_sms`, `balance_due_today_sms`, ...) exceed 20 chars and are outside the enum, so the INSERT would fail. Widen the column and drop the CHECK before anything calls `sendAndLogSms`.

**Files:**
- Modify: `server/db/schema.sql` (sms_messages additions block, after line 2265)
- Modify: `server/utils/sms.js`
- Test: `server/utils/sms.test.js` (create)

- [ ] **Step 1: Add the idempotent schema migration**

In `server/db/schema.sql`, find this block (around line 2259-2265):

```sql
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS direction TEXT NOT NULL DEFAULT 'outbound';

DO $$ BEGIN
  ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_direction_check;
  ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_direction_check
    CHECK (direction IN ('inbound','outbound'));
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

Immediately AFTER that block (before the `-- ─── Automated Communication: scheduled_messages table ──────────` comment), insert:

```sql
-- ─── Comms Phase 3: widen sms_messages.message_type ─────────────
-- The column was VARCHAR(20) with a 4-value CHECK ('general','invitation',
-- 'reminder','announcement') sized for the old manual-blast UI. Phase 3's
-- automated SMS touches use descriptive identifiers ('initial_proposal',
-- 'drink_plan_nudge_sms', 'balance_due_today_sms', etc.) that are both longer
-- than 20 chars and outside that enum. Widen to TEXT and drop the CHECK so
-- sendAndLogSms can log any touch's message_type. Existing rows are unaffected
-- ('general' is still valid free text). idempotent: ALTER TYPE to TEXT is a
-- no-op once applied; DROP CONSTRAINT IF EXISTS is safe to re-run.
ALTER TABLE sms_messages ALTER COLUMN message_type TYPE TEXT;
ALTER TABLE sms_messages ALTER COLUMN message_type SET DEFAULT 'general';
DO $$ BEGIN
  ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_message_type_check;
EXCEPTION WHEN OTHERS THEN NULL; END $$;
```

- [ ] **Step 2: Apply the migration to the dev database**

Run: `node -e "require('dotenv').config(); require('./server/db').initDb().then(()=>{console.log('schema applied');process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `schema applied` and exits 0. (If `initDb` is not exported under that name, run the project's normal schema-apply path: `npm run db:init` or equivalent — check `package.json` scripts. The dev server also applies `schema.sql` on boot.)

Verify the column type changed:

Run: `node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"SELECT data_type FROM information_schema.columns WHERE table_name='sms_messages' AND column_name='message_type'\").then(r=>{console.log(r.rows[0]);return pool.end()})"`
Expected: prints `{ data_type: 'text' }`

- [ ] **Step 3: Write the failing test for `sendAndLogSms`**

Create `server/utils/sms.test.js`:

```javascript
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { sendAndLogSms } = require('./sms');

after(async () => {
  await pool.query("DELETE FROM sms_messages WHERE message_type LIKE 'smstest_%'");
  await pool.end();
});

test('sendAndLogSms > returns skipped and logs nothing when the phone is unparseable', async () => {
  const result = await sendAndLogSms({
    to: 'not-a-phone',
    body: 'hello',
    messageType: 'smstest_skip',
  });
  assert.strictEqual(result.status, 'skipped');
  assert.strictEqual(result.sid, null);
  const { rows } = await pool.query(
    "SELECT count(*) FROM sms_messages WHERE message_type = 'smstest_skip'"
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('sendAndLogSms > sends and inserts an outbound row with status sent', async () => {
  // Twilio creds are absent in dev → sendSMS returns { sid: 'dev-skipped' }.
  const result = await sendAndLogSms({
    to: '3125550199',
    body: 'Hi there',
    clientId: null,
    messageType: 'smstest_send',
    recipientName: 'Test Person',
  });
  assert.strictEqual(result.status, 'sent');
  assert.ok(result.sid, 'expected a sid');
  const { rows } = await pool.query(
    `SELECT direction, recipient_phone, recipient_name, body, message_type, status, twilio_sid
       FROM sms_messages WHERE message_type = 'smstest_send'`
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].direction, 'outbound');
  assert.strictEqual(rows[0].recipient_phone, '+13125550199');
  assert.strictEqual(rows[0].recipient_name, 'Test Person');
  assert.strictEqual(rows[0].body, 'Hi there');
  assert.strictEqual(rows[0].status, 'sent');
});

test('sendAndLogSms > on Twilio failure logs a failed row and throws', async () => {
  // Inject a failing sender via the _deps seam.
  const { __setSmsDeps } = require('./sms');
  __setSmsDeps({ sendSMS: async () => { throw new Error('twilio boom'); } });
  await assert.rejects(
    () => sendAndLogSms({ to: '3125550188', body: 'x', messageType: 'smstest_fail' }),
    /twilio boom/
  );
  const { rows } = await pool.query(
    "SELECT status, error_message FROM sms_messages WHERE message_type = 'smstest_fail'"
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].status, 'failed');
  assert.match(rows[0].error_message, /twilio boom/);
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test server/utils/sms.test.js`
Expected: FAIL — `sendAndLogSms is not a function` (and `__setSmsDeps` undefined).

- [ ] **Step 5: Implement `sendAndLogSms` with a `_deps` test seam**

Replace the entire contents of `server/utils/sms.js` with:

```javascript
const twilio = require('twilio');
const { pool } = require('../db');

const client = process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

if (!client) console.warn('⚠️  Twilio credentials not set — SMS will be logged but not sent');

/**
 * Send an SMS via Twilio
 * @param {Object} options
 * @param {string} options.to - Recipient phone number (E.164 format, e.g. +13125551234)
 * @param {string} options.body - Message text
 * @returns {Promise}
 */
async function sendSMS({ to, body }) {
  if (!to) throw new Error('SMS recipient phone number is required');
  if (!client) {
    console.log(`[DEV] SMS skipped → ${to} | Body: ${body}`);
    return { sid: 'dev-skipped' };
  }
  const message = await client.messages.create({
    from: process.env.TWILIO_PHONE_NUMBER,
    to,
    body,
  });
  console.log(`SMS sent: ${message.sid} → ${to}`);
  return message;
}

/**
 * Normalize a phone number to E.164 format (+1XXXXXXXXXX)
 * Accepts formats like (312)555-1234, 312-555-1234, 3125551234, +13125551234
 * @param {string} phone
 * @returns {string|null} E.164 formatted number or null if invalid
 */
function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (phone.startsWith('+') && digits.length >= 11) return `+${digits}`;
  return null;
}

// Dependency seam for tests. `_realSendSMS` lets a test restore the real
// sender after injecting a stub.
const _realSendSMS = sendSMS;
let _deps = { sendSMS };
function __setSmsDeps(d) { _deps = { ..._deps, ...d }; }

/**
 * Send an automated SMS and log it to sms_messages. The single send+log
 * primitive for ALL automated SMS in Phases 3/4a/4b — scheduled handlers and
 * immediate hooks alike. Existing manual SMS paths (routes/messages.js,
 * routes/sms.js reply) are NOT refactored onto it.
 *
 * Behavior:
 *  - normalize `to`; if it is unparseable, log NOTHING and return
 *    { sid: null, status: 'skipped' } (a missing/garbage phone is not a
 *    Twilio failure — there is nothing to record).
 *  - send via sendSMS; on success INSERT an outbound row with status 'sent'.
 *  - on Twilio failure INSERT an outbound row with status 'failed' +
 *    error_message, then THROW. A scheduled handler's row then goes 'failed';
 *    an immediate caller catches it in its own try/catch.
 *
 * @param {Object} args
 * @param {string} args.to - raw phone (any format normalizePhone accepts)
 * @param {string} args.body - the SMS text
 * @param {number|null} [args.clientId=null] - clients.id for thread grouping
 * @param {string} args.messageType - touch identifier, e.g. 'initial_proposal'
 * @param {string|null} [args.recipientName=null] - display name
 * @returns {Promise<{sid: string|null, status: 'sent'|'skipped'}>}
 */
async function sendAndLogSms({ to, body, clientId = null, messageType, recipientName = null }) {
  if (!messageType || typeof messageType !== 'string') {
    throw new Error('sendAndLogSms: messageType is required');
  }
  const normalized = normalizePhone(to);
  if (!normalized) {
    console.warn(`[sendAndLogSms] unparseable phone for messageType=${messageType} — skipped, nothing logged`);
    return { sid: null, status: 'skipped' };
  }

  let sid = null;
  try {
    const msg = await _deps.sendSMS({ to: normalized, body });
    sid = msg && msg.sid ? msg.sid : null;
  } catch (sendErr) {
    await pool.query(
      `INSERT INTO sms_messages
         (direction, client_id, recipient_phone, recipient_name, body, message_type, twilio_sid, status, error_message)
       VALUES ('outbound', $1, $2, $3, $4, $5, NULL, 'failed', $6)`,
      [clientId, normalized, recipientName, body, messageType, String(sendErr.message || sendErr).slice(0, 500)]
    ).catch((logErr) => {
      console.error('[sendAndLogSms] failed to log the failed-send row:', logErr.message);
    });
    throw sendErr;
  }

  await pool.query(
    `INSERT INTO sms_messages
       (direction, client_id, recipient_phone, recipient_name, body, message_type, twilio_sid, status)
     VALUES ('outbound', $1, $2, $3, $4, $5, $6, 'sent')`,
    [clientId, normalized, recipientName, body, messageType, sid]
  );
  return { sid, status: 'sent' };
}

module.exports = { sendSMS, normalizePhone, sendAndLogSms, __setSmsDeps, _realSendSMS };
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test server/utils/sms.test.js`
Expected: PASS — all 3 tests pass.

- [ ] **Step 7: Commit**

```bash
git add server/db/schema.sql server/utils/sms.js server/utils/sms.test.js
git commit -m "feat(comms): sendAndLogSms primitive and widen sms_messages.message_type"
```

---

## Task 2: Create `smsTemplates.js` with all client SMS copy

**Files:**
- Create: `server/utils/smsTemplates.js`
- Test: `server/utils/smsTemplates.test.js`

Copy is verbatim from spec section 5 (touches 1.2, 1.3, 2.1, 3.3, 3.5, 3.6, 3.7, 3.12, 3.13). No em dashes. Each function takes a params object and returns a plain string.

- [ ] **Step 1: Write the failing test**

Create `server/utils/smsTemplates.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('./smsTemplates');

// No SMS body may contain an em dash (the AI tell, per CLAUDE.md).
function assertNoEmDash(str, label) {
  assert.ok(!str.includes('—'), `${label} must not contain an em dash`);
}

test('initialProposalSms > greets, names the event, includes the link', () => {
  const s = t.initialProposalSms({ eventTypeLabel: 'birthday party', eventDate: 'August 15', link: 'https://x/p/abc' });
  assert.match(s, /^Hi, Dallas here\./);
  assert.match(s, /birthday party/);
  assert.match(s, /August 15/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'initialProposalSms');
});

test('signPayConfirmationSms > confirms the booking and the date', () => {
  const s = t.signPayConfirmationSms({ eventDate: 'August 15' });
  assert.match(s, /You're booked for August 15/);
  assertNoEmDash(s, 'signPayConfirmationSms');
});

test('dripTouch1Sms > asks if they got the proposal', () => {
  const s = t.dripTouch1Sms({ eventTypeLabel: 'wedding', eventDate: 'June 1' });
  assert.match(s, /Did you get the proposal/);
  assert.match(s, /wedding/);
  assertNoEmDash(s, 'dripTouch1Sms');
});

test('dripTouch3Sms > offers a tweak before it books up', () => {
  const s = t.dripTouch3Sms({ eventTypeLabel: 'wedding', eventDate: 'June 1', link: 'https://x/p/abc' });
  assert.match(s, /tweak/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'dripTouch3Sms');
});

test('dripTouch5Sms > last check, includes link', () => {
  const s = t.dripTouch5Sms({ eventDate: 'June 1', link: 'https://x/p/abc' });
  assert.match(s, /Last check/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'dripTouch5Sms');
});

test('drinkPlanNudgeSms > points at planner and consult', () => {
  const s = t.drinkPlanNudgeSms({ eventDate: 'June 1', plannerUrl: 'https://x/plan/abc', consultUrl: 'https://cal/x' });
  assert.match(s, /lock in drinks/);
  assert.match(s, /https:\/\/x\/plan\/abc/);
  assertNoEmDash(s, 'drinkPlanNudgeSms');
});

test('drinkPlanNudgeSms > omits the consult clause when consultUrl is null', () => {
  const s = t.drinkPlanNudgeSms({ eventDate: 'June 1', plannerUrl: 'https://x/plan/abc', consultUrl: null });
  assert.ok(!s.includes('book a consult'), 'consult clause should be omitted');
  assert.match(s, /https:\/\/x\/plan\/abc/);
});

test('balanceDueTodaySms > says due today and includes the link', () => {
  const s = t.balanceDueTodaySms({ eventDate: 'June 1', link: 'https://x/p/abc' });
  assert.match(s, /due today/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'balanceDueTodaySms');
});

test('balanceLateSms > t1 is gentle, t3 is firmer', () => {
  const s1 = t.balanceLateSms({ eventDate: 'June 1', link: 'https://x/p/abc', daysLate: 1 });
  const s3 = t.balanceLateSms({ eventDate: 'June 1', link: 'https://x/p/abc', daysLate: 3 });
  assert.match(s1, /1 day past due/);
  assert.match(s3, /3 days past due/);
  assert.match(s3, /ASAP/);
  assertNoEmDash(s1, 'balanceLateSms t1');
  assertNoEmDash(s3, 'balanceLateSms t3');
});

test('paymentFailureSms > says it did not go through, includes link', () => {
  const s = t.paymentFailureSms({ eventDate: 'June 1', link: 'https://x/p/abc' });
  assert.match(s, /didn't go through/);
  assert.match(s, /https:\/\/x\/p\/abc/);
  assertNoEmDash(s, 'paymentFailureSms');
});

test('eventEveSms > names bartender, time, location, phone, setup minutes', () => {
  const s = t.eventEveSms({
    startTime: '6:00 PM CDT',
    location: '123 Main St',
    bartenderName: 'Sam',
    bartenderPhone: '+13125550000',
    setupMinutes: 60,
  });
  assert.match(s, /Sam/);
  assert.match(s, /6:00 PM CDT/);
  assert.match(s, /123 Main St/);
  assert.match(s, /\+13125550000/);
  assert.match(s, /60 minutes/);
  assertNoEmDash(s, 'eventEveSms');
});

test('eventEveSms > omits the bartender clause when no bartender assigned', () => {
  const s = t.eventEveSms({
    startTime: '6:00 PM CDT',
    location: '123 Main St',
    bartenderName: null,
    bartenderPhone: null,
    setupMinutes: 60,
  });
  assert.ok(!s.includes('direct number'), 'phone clause should be omitted');
  assert.match(s, /6:00 PM CDT/);
});

test('rescheduleSms > gives the new details', () => {
  const s = t.rescheduleSms({ newDate: 'July 4', newStartTime: '7:00 PM', newLocation: '5 Oak Ave' });
  assert.match(s, /has been updated/);
  assert.match(s, /July 4/);
  assert.match(s, /5 Oak Ave/);
  assertNoEmDash(s, 'rescheduleSms');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/smsTemplates.test.js`
Expected: FAIL — `Cannot find module './smsTemplates'`.

- [ ] **Step 3: Create `smsTemplates.js`**

Create `server/utils/smsTemplates.js`:

```javascript
/**
 * SMS body templates for Dr. Bartender — client-facing automated SMS.
 * One exported function per touch; each returns a plain string (the SMS body).
 * Mirrors emailTemplates.js. Copy is verbatim from the automated-communication
 * spec section 5. NO em dashes (per CLAUDE.md) — commas, periods, parentheticals.
 *
 * Phase 3 creates this file with the client SMS copy. Phase 4a appends staff
 * SMS copy below.
 */

/** Defensive fallbacks so a missing merge field never renders 'undefined'. */
function ev(label) { return label || 'event'; }
function dt(date) { return date || 'your event'; }

// ─── 1.2 Initial proposal SMS ────────────────────────────────────
function initialProposalSms({ eventTypeLabel, eventDate, link }) {
  return `Hi, Dallas here. Just sent your proposal for the ${ev(eventTypeLabel)} on ${dt(eventDate)}. View and book here: ${link}. Let me know if you have any questions or need any changes.`;
}

// ─── 2.1 Sign+pay confirmation SMS ───────────────────────────────
function signPayConfirmationSms({ eventDate }) {
  return `Hi, Dallas here. You're booked for ${dt(eventDate)}! Confirmation email and Potion Planner link are coming your way. Reply here anytime if you have questions.`;
}

// ─── 1.3 Drip touch 1 (+1d) ──────────────────────────────────────
function dripTouch1Sms({ eventTypeLabel, eventDate }) {
  return `Hi, Dallas here. Did you get the proposal I sent for the ${ev(eventTypeLabel)} on ${dt(eventDate)}? Let me know if you have any questions.`;
}

// ─── 1.3 Drip touch 3 (+10d) ─────────────────────────────────────
function dripTouch3Sms({ eventTypeLabel, eventDate, link }) {
  return `Hi, Dallas here. Quick thought on the ${ev(eventTypeLabel)} on ${dt(eventDate)}. Want to tweak anything before it books up? Easy to adjust: ${link}.`;
}

// ─── 1.3 Drip touch 5 (+21d), SMS half ───────────────────────────
function dripTouch5Sms({ eventDate, link }) {
  return `Hi, Dallas here. Last check on your ${dt(eventDate)} event. Want to lock it in before someone else grabs the date? ${link}`;
}

// ─── 3.7 Drink plan nudge SMS ────────────────────────────────────
function drinkPlanNudgeSms({ eventDate, plannerUrl, consultUrl }) {
  const consultClause = consultUrl ? `, or book a consult: ${consultUrl}` : '';
  return `Hi, Dallas here. Time to lock in drinks for ${dt(eventDate)}. Use the Potion Planner: ${plannerUrl}${consultClause}. Or just call us.`;
}

// ─── 3.5 Balance due today SMS ───────────────────────────────────
function balanceDueTodaySms({ eventDate, link }) {
  return `Hi, Dallas here. Your balance for ${dt(eventDate)} is due today. Pay here: ${link}. Let me know if you need anything.`;
}

// ─── 3.6 Late balance SMS (t1 gentle, t3 firmer) ─────────────────
function balanceLateSms({ eventDate, link, daysLate }) {
  if (Number(daysLate) >= 3) {
    return `Hi, Dallas here. Your balance for ${dt(eventDate)} is 3 days past due. Please pay here ASAP: ${link}. Or call me so we can sort it out.`;
  }
  return `Hi, Dallas here. Just a reminder, your balance for ${dt(eventDate)} is now 1 day past due. Pay here: ${link}.`;
}

// ─── 3.3 Payment failure SMS ─────────────────────────────────────
function paymentFailureSms({ eventDate, link }) {
  return `Hi, Dallas here. Your payment for ${dt(eventDate)} didn't go through. Tap here to update your card: ${link}. Reach out if you need help.`;
}

// ─── 3.12 Event-eve SMS ──────────────────────────────────────────
function eventEveSms({ startTime, location, bartenderName, bartenderPhone, setupMinutes }) {
  // Spec 3.12: name the bartender, time, location, their phone, and the
  // actual scheduled setup minutes. When no bartender is assigned yet, omit
  // the bartender name + phone clauses gracefully.
  const time = startTime || 'your start time';
  const loc = location || 'your venue';
  const setup = Number.isFinite(Number(setupMinutes)) ? Number(setupMinutes) : 60;
  if (bartenderName) {
    const phoneClause = bartenderPhone
      ? ` Their direct number is ${bartenderPhone} if you need them.`
      : '';
    return `Hi, Dallas here. Your bartender tomorrow at ${time}, ${loc} is ${bartenderName}.${phoneClause} They'll arrive ${setup} minutes before your start time to set up. Let me know if you have any questions or need any changes.`;
  }
  return `Hi, Dallas here. Your event is tomorrow at ${time}, ${loc}. Your bartender will arrive ${setup} minutes before your start time to set up. Let me know if you have any questions or need any changes.`;
}

// ─── 3.13 Reschedule SMS ─────────────────────────────────────────
function rescheduleSms({ newDate, newStartTime, newLocation }) {
  return `Hi, Dallas here. Your event has been updated. New details: ${dt(newDate)} at ${newStartTime || 'a new time'}, ${newLocation || 'the same location'}. Full updated confirmation in your email. Let me know if you have any questions.`;
}

module.exports = {
  initialProposalSms,
  signPayConfirmationSms,
  dripTouch1Sms,
  dripTouch3Sms,
  dripTouch5Sms,
  drinkPlanNudgeSms,
  balanceDueTodaySms,
  balanceLateSms,
  paymentFailureSms,
  eventEveSms,
  rescheduleSms,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/smsTemplates.test.js`
Expected: PASS — all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsTemplates.js server/utils/smsTemplates.test.js
git commit -m "feat(comms): smsTemplates module with client SMS copy"
```

---

## Task 3: Initial-proposal immediate SMS

Spec 1.2. Attaches in `server/utils/sendProposalSentEmail.js` (one helper, covers all three callers: `lifecycle.js`, `crud.js`, `public.js`). Best-effort SMS beside the email, gated by `shouldSendImmediate({ channel: 'sms' })`.

`sendProposalSentEmail` is passed a `proposal` object. It already reads `proposal.client_email`, `proposal.token`, `proposal.event_type`. For the SMS it also needs `proposal.client_phone`, `proposal.event_date`, `proposal.status`, `proposal.client_id`, and the suppression fields (`communication_preferences`, `email_status`, `phone_status`). The three callers build the object handed to the helper differently — Step 1 covers each:
- **`lifecycle.js`** and **`crud.js`** re-fetch the proposal joined to `clients` and pass that row. Their SELECTs need the missing client columns added.
- **`public.js`** does NOT re-fetch — it passes the bare `INSERT ... RETURNING` proposal row with `client_name` / `client_email` merged on from the request body. That row has no `client_phone` / `client_id` / suppression fields, so the website-origin SMS would be a silent no-op (`sendAndLogSms({ to: undefined })` skips). Step 1 wires `public.js` so the SMS actually fires.

On graceful degradation: `shouldSendImmediate` for `channel: 'sms'` checks ONLY `communication_preferences.sms_enabled` and `phone_status === 'bad'` — it does NOT inspect whether a phone string is present. A missing phone with `phone_status: 'ok'` still returns `{ ok: true }`. The real safety net for a phoneless client is `sendAndLogSms`: `normalizePhone` returns `null`, the primitive logs nothing and returns `{ status: 'skipped' }`. Net behavior is safe; the gate is comm-prefs, not phone presence.

**Files:**
- Modify: `server/utils/sendProposalSentEmail.js`
- Modify: `server/routes/proposals/lifecycle.js` (the post-commit `pd` SELECT in `PATCH :id/status`, at lines 124-128)
- Modify: `server/routes/proposals/crud.js` (the post-commit `enriched` SELECT in `POST /`, at lines 327-330)
- Modify: `server/routes/proposals/public.js` (the `clientResult` upsert at lines 274-279 and the `sendProposalSentEmail` call at line 459)
- Test: `server/utils/sendProposalSentEmail.test.js` (extend)

- [ ] **Step 1: Wire the three callers so the helper receives the client fields the SMS needs**

The SMS hook reads `proposal.client_phone`, `proposal.client_id`, `proposal.event_date`, `proposal.status`, `proposal.communication_preferences`, `proposal.email_status`, `proposal.phone_status`. Make these edits:

**`lifecycle.js`** — the post-commit `pd` SELECT (lines 124-128) is currently:

```javascript
      const pd = await pool.query(`
        SELECT p.token, p.event_type, p.event_type_custom,
               c.name AS client_name, c.email AS client_email
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1`, [req.params.id]);
```

Replace with (adds `p.event_date`, `p.status`, and the client columns):

```javascript
      const pd = await pool.query(`
        SELECT p.token, p.event_type, p.event_type_custom, p.event_date, p.status,
               c.id AS client_id, c.name AS client_name, c.email AS client_email,
               c.phone AS client_phone, c.communication_preferences,
               c.email_status, c.phone_status
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1`, [req.params.id]);
```

(`lifecycle.js` already spreads `pd.rows[0]` with `id: Number(req.params.id)` into the helper call — no change needed at the call site.)

**`crud.js`** — the post-commit `enriched` SELECT (lines 327-330) is currently:

```javascript
        const enriched = await pool.query(
          `SELECT p.*, c.name AS client_name, c.email AS client_email
             FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1`, [proposal.id]);
```

`p.*` already supplies `event_date`, `status`, `token`, `event_type*`. Add the four missing `clients` columns:

```javascript
        const enriched = await pool.query(
          `SELECT p.*, c.id AS client_id, c.name AS client_name, c.email AS client_email,
                  c.phone AS client_phone, c.communication_preferences,
                  c.email_status, c.phone_status
             FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1`, [proposal.id]);
```

(`crud.js` passes `enriched.rows[0]` directly — no change needed at the call site.)

**`public.js`** — there is no proposal re-fetch SELECT here; the fix is two small edits.

First, widen the `clientResult` upsert (lines 274-279) so it returns the client's suppression fields. The upsert's `DO UPDATE SET name = clients.name` always yields a row (new or existing), so `RETURNING` carries the current `communication_preferences` / `email_status` / `phone_status` — for a brand-new client these are the column defaults (`sms_enabled: true`, `'ok'`, `'ok'`); for a matched existing client they are that client's real values, so a previously-opted-out client is correctly suppressed. Current:

```javascript
    const clientResult = await dbClient.query(
      `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) WHERE email IS NOT NULL
       DO UPDATE SET name = clients.name
       RETURNING id`,
      [client_name.trim(), client_email.trim().toLowerCase(), client_phone || null, 'website']
    );
    const finalClientId = clientResult.rows[0].id;
```

Replace with (widens `RETURNING`):

```javascript
    const clientResult = await dbClient.query(
      `INSERT INTO clients (name, email, phone, source) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) WHERE email IS NOT NULL
       DO UPDATE SET name = clients.name
       RETURNING id, communication_preferences, email_status, phone_status`,
      [client_name.trim(), client_email.trim().toLowerCase(), client_phone || null, 'website']
    );
    const finalClientId = clientResult.rows[0].id;
```

Second, the `sendProposalSentEmail` call (around line 459) currently is:

```javascript
        await sendProposalSentEmail(
          { ...proposal, client_name: client_name.trim(), client_email: client_email.trim().toLowerCase() },
          { actorType: 'client' },
        );
```

Replace with (merges the client phone, id, and suppression fields onto the passed object so the SMS half fires; `proposal` is the `INSERT ... RETURNING *` row so it already carries `event_date`, `status`, `token`, `event_type*`):

```javascript
        await sendProposalSentEmail(
          {
            ...proposal,
            client_name: client_name.trim(),
            client_email: client_email.trim().toLowerCase(),
            client_id: finalClientId,
            client_phone: client_phone || null,
            communication_preferences: clientResult.rows[0].communication_preferences,
            email_status: clientResult.rows[0].email_status,
            phone_status: clientResult.rows[0].phone_status,
          },
          { actorType: 'client' },
        );
```

- [ ] **Step 2: Write the failing test**

Append to `server/utils/sendProposalSentEmail.test.js`:

```javascript
const assert2 = require('node:assert/strict');
const { test: test2 } = require('node:test');

test2('sendProposalSentEmail > fires the initial-proposal SMS when the client has a phone', async () => {
  const mod2 = require('./sendProposalSentEmail');
  let smsCalls = 0;
  let smsArgs = null;
  mod2.__setDeps({
    sendEmail: async () => {},
    sendAndLogSms: async (args) => { smsCalls += 1; smsArgs = args; return { sid: 'x', status: 'sent' }; },
  });
  await mod2.sendProposalSentEmail({
    id: 1, token: 'tok-1', event_type: 'birthday-party', event_type_custom: null,
    client_name: 'Pat', client_email: 'pat@example.com',
    client_id: 7, client_phone: '3125550111',
    communication_preferences: { sms_enabled: true, email_enabled: true },
    email_status: 'ok', phone_status: 'ok',
  }, { actorType: 'admin' });
  assert2.strictEqual(smsCalls, 1, 'SMS should fire once');
  assert2.strictEqual(smsArgs.messageType, 'initial_proposal');
  assert2.strictEqual(smsArgs.clientId, 7);
  assert2.match(smsArgs.body, /Dallas here/);
});

test2('sendProposalSentEmail > skips the SMS when sms_enabled is false', async () => {
  const mod2 = require('./sendProposalSentEmail');
  let smsCalls = 0;
  mod2.__setDeps({
    sendEmail: async () => {},
    sendAndLogSms: async () => { smsCalls += 1; return { sid: 'x', status: 'sent' }; },
  });
  await mod2.sendProposalSentEmail({
    id: 2, token: 'tok-2', event_type: 'birthday-party', event_type_custom: null,
    client_name: 'Pat', client_email: 'pat@example.com',
    client_id: 8, client_phone: '3125550111',
    communication_preferences: { sms_enabled: false, email_enabled: true },
    email_status: 'ok', phone_status: 'ok',
  }, { actorType: 'admin' });
  assert2.strictEqual(smsCalls, 0, 'SMS should be suppressed');
});

test2('sendProposalSentEmail > an SMS failure does not throw', async () => {
  const mod2 = require('./sendProposalSentEmail');
  mod2.__setDeps({
    sendEmail: async () => {},
    sendAndLogSms: async () => { throw new Error('sms boom'); },
  });
  await assert2.doesNotReject(() => mod2.sendProposalSentEmail({
    id: 3, token: 'tok-3', event_type: 'birthday-party', event_type_custom: null,
    client_name: 'Pat', client_email: 'pat@example.com',
    client_id: 9, client_phone: '3125550111',
    communication_preferences: { sms_enabled: true, email_enabled: true },
    email_status: 'ok', phone_status: 'ok',
  }, { actorType: 'admin' }));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test server/utils/sendProposalSentEmail.test.js`
Expected: FAIL — `__setDeps` does not accept `sendAndLogSms`, so `smsCalls` stays 0.

- [ ] **Step 4: Add the SMS hook to `sendProposalSentEmail`**

Replace the entire contents of `server/utils/sendProposalSentEmail.js` with:

```javascript
// Post-commit, best-effort client email + SMS for a proposal that just entered
// the 'sent' state. NEVER throws — the proposal + invoice are already
// committed, so a notification failure is recoverable (admin resends from the
// detail page). Invoice creation is NOT here — it runs inside the caller's DB
// transaction via createInvoiceOnSend. See the 2026-05-20 manual-proposal-
// overhaul spec and the 2026-05-22 comms Phase 3 plan (initial-proposal SMS).
const realSentry = require('@sentry/node');
const realSendEmail = require('./email').sendEmail;
const realEmailTemplates = require('./emailTemplates');
const realSendAndLogSms = require('./sms').sendAndLogSms;
const smsTemplates = require('./smsTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { shouldSendImmediate } = require('./messageSuppression');

const { PUBLIC_SITE_URL } = require('./urls');

// Dependency seam for tests.
let _deps = {
  sendEmail: realSendEmail,
  emailTemplates: realEmailTemplates,
  sendAndLogSms: realSendAndLogSms,
  Sentry: realSentry,
};
function __setDeps(d) { _deps = { ..._deps, ...d }; }

/** Format a YYYY-MM-DD / Date event_date as "August 15" for SMS copy. */
function formatSmsDate(eventDate) {
  if (!eventDate) return 'your event';
  const ymd = String(eventDate).slice(0, 10);
  const parsed = new Date(ymd + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return 'your event';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

async function sendProposalSentEmail(proposal, { actorType = 'admin' } = {}) {
  // ── Email half (existing behavior) ──
  try {
    if (!proposal || !proposal.client_email) {
      // No email — fall through to the SMS attempt below anyway.
    } else {
      const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${proposal.token}`;
      const eventTypeLabel = getEventTypeLabel({
        event_type: proposal.event_type,
        event_type_custom: proposal.event_type_custom,
      });
      const tpl = _deps.emailTemplates.proposalSent({
        clientName: proposal.client_name,
        eventTypeLabel,
        proposalUrl,
        planUrl: null,
      });
      await _deps.sendEmail({ to: proposal.client_email, ...tpl });
    }
  } catch (emailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.Sentry.captureException(new Error('proposalSent email failed'), {
        tags: { route: 'proposals/sent', issue: 'email' },
        extra: {
          proposalId: proposal && proposal.id,
          actorType,
          cause: (emailErr && (emailErr.code || emailErr.name)) || 'unknown',
        },
      });
    }
    console.error('Proposal sent email failed (non-blocking) for proposal',
      proposal && proposal.id);
  }

  // ── SMS half (Phase 3, spec 1.2) — separate try/catch so an SMS failure
  // never masks a successful email and never throws into the request path. ──
  try {
    if (!proposal) return;
    const sendCheck = await shouldSendImmediate({
      proposal: { id: proposal.id, status: proposal.status },
      client: {
        communication_preferences: proposal.communication_preferences,
        email_status: proposal.email_status,
        phone_status: proposal.phone_status,
      },
      channel: 'sms',
    });
    if (!sendCheck.ok) {
      console.log(`[initialProposalSms] suppressed for proposal ${proposal.id}: ${sendCheck.reason}`);
      return;
    }
    const eventTypeLabel = getEventTypeLabel({
      event_type: proposal.event_type,
      event_type_custom: proposal.event_type_custom,
    });
    const body = smsTemplates.initialProposalSms({
      eventTypeLabel,
      eventDate: formatSmsDate(proposal.event_date),
      link: `${PUBLIC_SITE_URL}/proposal/${proposal.token}`,
    });
    await _deps.sendAndLogSms({
      to: proposal.client_phone,
      body,
      clientId: proposal.client_id || null,
      messageType: 'initial_proposal',
      recipientName: proposal.client_name || null,
    });
  } catch (smsErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      _deps.Sentry.captureException(new Error('initialProposalSms failed'), {
        tags: { route: 'proposals/sent', issue: 'sms' },
        extra: {
          proposalId: proposal && proposal.id,
          actorType,
          cause: (smsErr && (smsErr.code || smsErr.name)) || 'unknown',
        },
      });
    }
    console.error('Initial-proposal SMS failed (non-blocking) for proposal',
      proposal && proposal.id);
  }
}

module.exports = { sendProposalSentEmail, __setDeps };
```

Note: the SMS hook reads `proposal.event_date`, `proposal.status`, `proposal.client_phone`, `proposal.client_id`, and the three suppression fields. Step 1 already wired all three callers to supply every one of these (`lifecycle.js` and `crud.js` SELECTs widened; `public.js` upsert `RETURNING` widened and the merged object extended) — no further caller edits are needed here.

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test server/utils/sendProposalSentEmail.test.js`
Expected: PASS — including the existing email-only tests (the email path is unchanged).

- [ ] **Step 6: Run the proposal route tests to confirm nothing regressed**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS — `sendProposalSentEmail should fire exactly once` still holds. That test stubs `sendProposalSentEmail` entirely through the `__setDeps` seam (it never runs the real helper for the count assertions), so the new SMS half inside the helper is bypassed and cannot affect the email-fire count. The widened `pd` / `enriched` SELECTs are pure column additions — they do not change row count or the `pd.rows[0]` truthiness gate.

- [ ] **Step 7: Commit**

```bash
git add server/utils/sendProposalSentEmail.js server/utils/sendProposalSentEmail.test.js server/routes/proposals/lifecycle.js server/routes/proposals/crud.js server/routes/proposals/public.js
git commit -m "feat(comms): initial-proposal SMS beside the proposal-sent email"
```

---

## Task 4: Sign+pay confirmation immediate SMS

Spec 2.1. Attaches in `server/routes/stripe.js` `sendPaymentNotifications`, the `isCoupledSigning` branch (the branch that sends the orientation email). Best-effort SMS beside the orientation email, gated by `shouldSendImmediate({ channel: 'sms' })`. Inherits the orientation email's coverage (rides wherever the orientation email rides — do NOT try to fix the Payment-Link webhook gap).

`sendPaymentNotifications` already loads `pi` with `client_id`, `communication_preferences`, `email_status`, `phone_status`, `event_type`, `event_type_custom`. It does NOT load `client_phone` or `event_date`. Add them to that SELECT.

**Files:**
- Modify: `server/routes/stripe.js` (the SELECT in `sendPaymentNotifications` at line 934-941; the `isCoupledSigning` branch ends at line 1059)

- [ ] **Step 1: Add `c.phone` and `p.event_date` to the `sendPaymentNotifications` SELECT**

In `server/routes/stripe.js`, find (around line 934-941):

```javascript
      const payInfo = await pool.query(`
        SELECT p.event_type, p.event_type_custom, p.client_signed_at, p.last_minute_hold,
               p.autopay_enrolled, p.status, p.client_id,
               c.name AS client_name, c.email AS client_email,
               c.communication_preferences, c.email_status, c.phone_status
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
      `, [proposalId]);
```

Replace with:

```javascript
      const payInfo = await pool.query(`
        SELECT p.event_type, p.event_type_custom, p.client_signed_at, p.last_minute_hold,
               p.autopay_enrolled, p.status, p.client_id, p.event_date,
               c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
               c.communication_preferences, c.email_status, c.phone_status
        FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.id = $1
      `, [proposalId]);
```

- [ ] **Step 2: Add the sign+pay SMS at the end of the `isCoupledSigning` branch**

In `server/routes/stripe.js`, find the close of the `isCoupledSigning` branch. It looks like this (around line 1053-1060):

```javascript
            // Fall back to the old short-form path so the client at least hears back.
            const tpl = emailTemplates.signedAndPaidClient({
              clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute,
            });
            await sendEmail({ to: pi.client_email, ...tpl });
          }
        } else {
```

Insert the SMS hook between the closing `}` of the `catch (orientationErr)` block and the `} else {` — i.e. after `await sendEmail(...)` and the line `}` that closes the `if (isCoupledSigning)` block.

The exact edit: the bare 2-line `}` (10-space) + `} else {` (8-space) sequence is NOT unique in `stripe.js` — it also matches the close of the `if (paymentType === 'deposit')` block around line 1331. Anchor on the THREE-line sequence that includes the preceding `await sendEmail`, which is unique to the orientation-fallback site. Find:

```javascript
            await sendEmail({ to: pi.client_email, ...tpl });
          }
        } else {
```

and replace it with:

```javascript
            await sendEmail({ to: pi.client_email, ...tpl });
          }

          // Phase 3 (spec 2.1): sign+pay confirmation SMS, sent alongside the
          // orientation email. Best-effort — own try/catch, never rethrown into
          // the webhook handler. Gated by the same SMS suppression rule the
          // dispatcher applies to scheduled rows.
          try {
            const smsCheck = await shouldSendImmediate({
              proposal: proposalForCheck,
              client: clientForCheck,
              channel: 'sms',
            });
            if (smsCheck.ok) {
              const { sendAndLogSms } = require('../utils/sms');
              const smsTemplates = require('../utils/smsTemplates');
              const eventDateSms = pi.event_date
                ? new Date(String(pi.event_date).slice(0, 10) + 'T12:00:00Z')
                    .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' })
                : 'your event';
              await sendAndLogSms({
                to: pi.client_phone,
                body: smsTemplates.signPayConfirmationSms({ eventDate: eventDateSms }),
                clientId: pi.client_id || null,
                messageType: 'sign_pay_confirmation',
                recipientName: pi.client_name || null,
              });
            } else {
              console.log(`[signPaySms] suppressed for proposal ${proposalId}: ${smsCheck.reason}`);
            }
          } catch (smsErr) {
            if (process.env.SENTRY_DSN_SERVER) {
              Sentry.captureException(smsErr, {
                tags: { webhook: 'stripe', route: '/webhook', step: 'sign_pay_sms' },
              });
            }
            console.error('Sign+pay confirmation SMS failed (non-blocking):', smsErr);
          }
        } else {
```

Note: `proposalForCheck` and `clientForCheck` are already in scope (built earlier in `sendPaymentNotifications` at lines 964-970, before the `shouldSendImmediate` email check). `Sentry` and `shouldSendImmediate` are already imported at the top of `stripe.js`.

- [ ] **Step 3: Confirm the file compiles**

Run: `node -e "require('./server/routes/stripe.js'); console.log('stripe.js loads ok')"`
Expected: prints `stripe.js loads ok` (no syntax error).

- [ ] **Step 4: Manual verification note**

There is no unit-test harness for the Stripe webhook handler (it is a large route). Verification is manual at execution time: in dev, complete a sign+pay on a test proposal whose client has a phone and `sms_enabled: true`, then confirm an `sms_messages` row with `message_type = 'sign_pay_confirmation'` and `direction = 'outbound'` exists. The execution agent should report this as a manual-test item to the user.

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(comms): sign+pay confirmation SMS beside the orientation email"
```

---

## Task 5: Drip SMS touches 1, 3, 5

Spec 1.3. Three scheduled SMS-only touches. `drip_touch_1` (+1d), `drip_touch_3` (+10d), `drip_touch_5_sms` (+21d, the SMS half of the touch whose email half is `drip_touch_5_email`). Scheduling rows are added to `scheduleDripForProposal` in `marketingHandlers.js` beside the existing three email rows. Handlers live in a new `dripSmsHandlers.js` (marketingHandlers.js is at 519 lines, near the 700 soft cap). All anchored on `created_at` with `offsetFromEventDate: null` (the reschedule cascade leaves them alone). Category `marketing`, priority `4`.

`drip_touch_5_sms` additionally registers `multiChannel: true` — it is the SMS half of an email+SMS pair (its email half is `drip_touch_5_email`), and per spec 7.3 the Phase 4b delivery-failure logic must NOT channel-substitute a multi-channel touch (each channel's row is independent; a dead channel suppresses while the other fires). `drip_touch_1` and `drip_touch_3` are single-channel SMS-only and do NOT get `multiChannel`. `multiChannel` is a Phase-4b-defined `registerHandler` option — inert until Phase 4b lands, because today's `registerHandler` silently ignores unknown option keys exactly as it does for `priority`.

**Files:**
- Create: `server/utils/dripSmsHandlers.js`
- Modify: `server/utils/marketingHandlers.js` (`scheduleDripForProposal` ~line 87-129; the drip-suppression query in `onProposalSignedAndPaid` ~line 496-505)
- Modify: `server/index.js` (handler bootstrap)
- Test: `server/utils/dripSmsHandlers.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/utils/dripSmsHandlers.test.js`:

```javascript
require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerDripSmsHandlers } = require('./dripSmsHandlers');
const { getHandlerMeta, _clearHandlersForTest } = require('./scheduledMessageDispatcher');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Drip SMS Test', 'dripsms-test@example.com', '3125550140') RETURNING id"
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '120 days', 'sent', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('registerDripSmsHandlers > registers the three drip SMS types with marketing category and null offset', () => {
  _clearHandlersForTest();
  registerDripSmsHandlers();
  for (const mt of ['drip_touch_1', 'drip_touch_3', 'drip_touch_5_sms']) {
    const meta = getHandlerMeta(mt);
    assert.ok(meta, `expected meta for ${mt}`);
    assert.strictEqual(meta.category, 'marketing', `${mt} should be marketing`);
    assert.strictEqual(meta.anchor, 'created_at', `${mt} should anchor on created_at`);
    assert.strictEqual(meta.offsetFromEventDate, null, `${mt} should have a null offset`);
  }
});

test('dripSmsHandler > sends an SMS and the dispatcher marks the row sent', async () => {
  _clearHandlersForTest();
  registerDripSmsHandlers();
  // Inject a stub sender so we do not hit Twilio.
  const { __setSmsDeps } = require('./sms');
  let smsCalls = 0;
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: 'stub' }; } });

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'drip_touch_1', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();

  assert.strictEqual(smsCalls, 1, 'the SMS sender should have been called once');
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='drip_touch_1'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/dripSmsHandlers.test.js`
Expected: FAIL — `Cannot find module './dripSmsHandlers'`.

- [ ] **Step 3: Create `dripSmsHandlers.js`**

Create `server/utils/dripSmsHandlers.js`:

```javascript
/**
 * Drip SMS handlers — the SMS-only touches of the unsigned-proposal drip
 * (spec 1.3): touch 1 (+1d), touch 3 (+10d), touch 5 SMS half (+21d). The drip
 * email halves (touches 2/4/5-email) live in marketingHandlers.js. Kept in a
 * separate file because marketingHandlers.js is near the file-size soft cap.
 *
 * Scheduling: scheduleDripForProposal (marketingHandlers.js) inserts the
 * scheduled_messages rows. These handlers only render + send at dispatch time.
 *
 * Each registers with anchor 'created_at' + offsetFromEventDate: null so the
 * reschedule cascade leaves them alone (a moved event_date does not change the
 * "you haven't signed yet" timeline) and category 'marketing' so the dispatcher
 * gates them on communication_preferences.marketing_enabled. priority 4 is
 * inert until Phase 4b.
 *
 * drip_touch_5_sms additionally registers multiChannel: true — it is the SMS
 * half of the +21d touch whose email half is drip_touch_5_email, and spec 7.3
 * forbids the Phase 4b delivery-failure logic from channel-substituting a
 * multi-channel touch. drip_touch_1 and drip_touch_3 are single-channel
 * SMS-only and omit it. multiChannel is also inert until Phase 4b.
 */
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

/**
 * Load the proposal + client fields a drip SMS handler needs. Throws when the
 * proposal is gone, archived, the client has no phone, or SMS is opted out —
 * the dispatcher then marks the row 'failed' (archived is normally already
 * caught by the dispatcher's own suppression, but we re-check defensively).
 */
async function loadDripSmsContext(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.event_type, p.event_type_custom,
            c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
            c.communication_preferences AS comm_prefs, c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const proposal = rows[0];
  if (!proposal) throw new Error(`drip SMS: proposal ${proposalId} not found`);
  if (proposal.status === 'archived') throw new Error('drip SMS: proposal archived');
  if (!proposal.client_phone) throw new Error('drip SMS: client has no phone');
  if (proposal.phone_status === 'bad') throw new Error('drip SMS: client phone_status is bad');
  const prefs = proposal.comm_prefs || {};
  if (prefs.sms_enabled === false) throw new Error('drip SMS: sms_enabled is false');
  return proposal;
}

function eventDateSms(eventDate) {
  if (!eventDate) return 'your event';
  const parsed = new Date(String(eventDate).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return 'your event';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

function proposalUrl(token) {
  return `${PUBLIC_SITE_URL}/proposal/${token}`;
}

async function sendDripSms(proposalId, messageType, bodyFn) {
  const p = await loadDripSmsContext(proposalId);
  const body = bodyFn(p);
  await sendAndLogSms({
    to: p.client_phone,
    body,
    clientId: p.client_id,
    messageType,
    recipientName: p.client_name || null,
  });
}

const DRIP_SMS_PRIORITY = 4;

function registerDripSmsHandlers() {
  registerHandler(
    'drip_touch_1',
    ({ entity }) => sendDripSms(entity.id, 'drip_touch_1', (p) => smsTemplates.dripTouch1Sms({
      eventTypeLabel: getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom }),
      eventDate: eventDateSms(p.event_date),
    })),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing', priority: DRIP_SMS_PRIORITY }
  );
  registerHandler(
    'drip_touch_3',
    ({ entity }) => sendDripSms(entity.id, 'drip_touch_3', (p) => smsTemplates.dripTouch3Sms({
      eventTypeLabel: getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom }),
      eventDate: eventDateSms(p.event_date),
      link: proposalUrl(p.token),
    })),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing', priority: DRIP_SMS_PRIORITY }
  );
  registerHandler(
    'drip_touch_5_sms',
    ({ entity }) => sendDripSms(entity.id, 'drip_touch_5_sms', (p) => smsTemplates.dripTouch5Sms({
      eventDate: eventDateSms(p.event_date),
      link: proposalUrl(p.token),
    })),
    // drip_touch_5_sms is the SMS half of the +21d drip touch — its email half
    // is the separate drip_touch_5_email row. multiChannel: true (a Phase-4b
    // registerHandler option, inert until Phase 4b — today's registerHandler
    // ignores unknown option keys, exactly as it does for priority) tells the
    // Phase 4b delivery-failure logic NOT to channel-substitute this row: each
    // half of a multi-channel touch is independent (spec 7.3). drip_touch_1 and
    // drip_touch_3 are single-channel SMS-only and deliberately omit it.
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing', priority: DRIP_SMS_PRIORITY, multiChannel: true }
  );
}

module.exports = { registerDripSmsHandlers, loadDripSmsContext };
```

- [ ] **Step 4: Add the three drip SMS scheduling rows to `scheduleDripForProposal`**

In `server/utils/marketingHandlers.js`, find the `Promise.all([...])` inside `scheduleDripForProposal` (lines 100-128). It currently schedules three email rows (`drip_touch_2`, `drip_touch_4`, `drip_touch_5_email`). Replace the whole `await Promise.all([ ... ]);` block with one that also schedules the three SMS rows:

```javascript
  // Six independent idempotent INSERTs — run concurrently (each
  // scheduleMessage takes its own pooled connection). Email halves: touches
  // 2 (+7d), 4 (+14d), 5-email (+21d). SMS halves (Phase 3): touch 1 (+1d),
  // touch 3 (+10d), touch 5-sms (+21d).
  await Promise.all([
    scheduleMessage({
      entityType: 'proposal',
      entityId: proposalId,
      messageType: 'drip_touch_2',
      recipientType: 'client',
      recipientId: proposal.client_id,
      channel: 'email',
      scheduledFor: new Date(anchor.getTime() + 7 * day),
    }),
    scheduleMessage({
      entityType: 'proposal',
      entityId: proposalId,
      messageType: 'drip_touch_4',
      recipientType: 'client',
      recipientId: proposal.client_id,
      channel: 'email',
      scheduledFor: new Date(anchor.getTime() + 14 * day),
    }),
    scheduleMessage({
      entityType: 'proposal',
      entityId: proposalId,
      messageType: 'drip_touch_5_email',
      recipientType: 'client',
      recipientId: proposal.client_id,
      channel: 'email',
      scheduledFor: new Date(anchor.getTime() + 21 * day),
    }),
    scheduleMessage({
      entityType: 'proposal',
      entityId: proposalId,
      messageType: 'drip_touch_1',
      recipientType: 'client',
      recipientId: proposal.client_id,
      channel: 'sms',
      scheduledFor: new Date(anchor.getTime() + 1 * day),
    }),
    scheduleMessage({
      entityType: 'proposal',
      entityId: proposalId,
      messageType: 'drip_touch_3',
      recipientType: 'client',
      recipientId: proposal.client_id,
      channel: 'sms',
      scheduledFor: new Date(anchor.getTime() + 10 * day),
    }),
    scheduleMessage({
      entityType: 'proposal',
      entityId: proposalId,
      messageType: 'drip_touch_5_sms',
      recipientType: 'client',
      recipientId: proposal.client_id,
      channel: 'sms',
      scheduledFor: new Date(anchor.getTime() + 21 * day),
    }),
  ]);
```

- [ ] **Step 5: Update the drip-suppression `message_type` list (contract §6)**

In `server/utils/marketingHandlers.js`, find the drip-suppression query in `onProposalSignedAndPaid` (lines 496-505):

```javascript
  await pool.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed',
            error_message = 'proposal signed and paid'
      WHERE entity_type = 'proposal'
        AND entity_id = $1
        AND status = 'pending'
        AND message_type IN ('drip_touch_2', 'drip_touch_4', 'drip_touch_5_email')`,
    [proposalId]
  );
```

Replace the `message_type IN (...)` list to include the three new drip SMS types:

```javascript
  await pool.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed',
            error_message = 'proposal signed and paid'
      WHERE entity_type = 'proposal'
        AND entity_id = $1
        AND status = 'pending'
        AND message_type IN (
          'drip_touch_1', 'drip_touch_2', 'drip_touch_3',
          'drip_touch_4', 'drip_touch_5_email', 'drip_touch_5_sms'
        )`,
    [proposalId]
  );
```

- [ ] **Step 6: Register the drip SMS handlers at boot**

In `server/index.js`, find the handler-registration block (around line 321-327):

```javascript
      require('./utils/preEventHandlers').registerAll();
```
and (a few lines later)
```javascript
      require('./utils/marketingHandlers').registerMarketingHandlers();
```

Immediately AFTER the `registerMarketingHandlers()` line, add:

```javascript
      // Comms Phase 3: client-facing scheduled SMS handlers.
      require('./utils/dripSmsHandlers').registerDripSmsHandlers();
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `node --test server/utils/dripSmsHandlers.test.js`
Expected: PASS — both tests pass.

- [ ] **Step 8: Run the marketing handler tests to confirm no regression**

Run: `node --test server/utils/marketingHandlers.test.js`
Expected: FAIL on exactly two tests — `scheduleDripForProposal > inserts touch_2, touch_4, touch_5_email pending rows on the proposal` (asserts an exact 3-element `message_type` list — now 6 rows) and `scheduleDripForProposal > is idempotent — second call does not duplicate rows` (asserts `count === 3` — now 6). These two existing tests must be updated to the new 6-row reality in Step 9. The third drip test, `scheduleDripForProposal > uses the proposal status moment as the +7/+14/+21 anchor`, is UNAFFECTED — it locates rows by `rows.find((r) => r.message_type === 'drip_touch_2')` etc., so the three extra SMS rows do not disturb it; no edit there. The drip test `scheduleDripForProposal > does not enroll an already-advanced proposal` also still holds. Confirm only those two fail.

- [ ] **Step 9: Update the two stale `scheduleDripForProposal` tests**

In `server/utils/marketingHandlers.test.js`, find the test `scheduleDripForProposal > inserts touch_2, touch_4, touch_5_email pending rows on the proposal` and replace its body:

```javascript
test('scheduleDripForProposal > inserts the 6 drip rows (3 email, 3 sms) on the proposal', async () => {
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel, status FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1
     ORDER BY message_type`,
    [proposalId]
  );
  const types = rows.map(r => r.message_type);
  assert.deepStrictEqual(types, [
    'drip_touch_1', 'drip_touch_2', 'drip_touch_3',
    'drip_touch_4', 'drip_touch_5_email', 'drip_touch_5_sms',
  ]);
  const byType = Object.fromEntries(rows.map(r => [r.message_type, r.channel]));
  assert.strictEqual(byType['drip_touch_1'], 'sms');
  assert.strictEqual(byType['drip_touch_2'], 'email');
  assert.strictEqual(byType['drip_touch_3'], 'sms');
  assert.strictEqual(byType['drip_touch_4'], 'email');
  assert.strictEqual(byType['drip_touch_5_email'], 'email');
  assert.strictEqual(byType['drip_touch_5_sms'], 'sms');
  assert.ok(rows.every(r => r.status === 'pending'));
});
```

Find the test `scheduleDripForProposal > is idempotent — second call does not duplicate rows` and change its assertion from `3` to `6`:

```javascript
  assert.strictEqual(Number(rows[0].count), 6);
```

- [ ] **Step 10: Re-run the marketing handler tests**

Run: `node --test server/utils/marketingHandlers.test.js`
Expected: PASS — all tests pass. Note: `onProposalSignedAndPaid > suppresses the pending drip` already filters `r.message_type.startsWith('drip_')` so it still passes with 6 drip rows.

- [ ] **Step 11: Commit**

```bash
git add server/utils/dripSmsHandlers.js server/utils/dripSmsHandlers.test.js server/utils/marketingHandlers.js server/utils/marketingHandlers.test.js server/index.js
git commit -m "feat(comms): drip SMS touches 1, 3, 5 and suppression on sign+pay"
```

---

## Task 6: Drink-plan nudge — full email + SMS build

Spec 3.7. A full new touch — no email side exists today. Two `message_type`s: `drink_plan_nudge` (email) and `drink_plan_nudge_sms` (SMS). Scheduled T-21 days from event, 10:00 event-local (email and SMS both ride `computeScheduledFor`). Suppressed at send time when the drink plan is submitted or a consult is recorded, or the proposal is archived. Category `operational`, priority `2`. Both rows are scheduled from `schedulePreEventReminders`.

Both handlers register `multiChannel: true`: the nudge is an email+SMS pair, and per spec 7.3 the Phase 4b delivery-failure logic must NOT channel-substitute a multi-channel touch (each channel's row is independent — the dead channel suppresses, the other fires). `multiChannel` is a Phase-4b-defined `registerHandler` option, inert until Phase 4b lands (today's `registerHandler` ignores unknown option keys, exactly as it does for `priority`).

**The empty-`{}` schema trap (load-bearing).** `drink_plans.selections` is `JSONB DEFAULT '{}'` (schema.sql:346), and `createDrinkPlan` in `eventCreation.js` INSERTs a `drink_plans` row at sign+pay / conversion *without* a `selections` value — so that row's `selections` is the empty object `'{}'`, never SQL `NULL`. A naive "`selections IS NOT NULL` means submitted" check is therefore inverted: it treats every converted proposal (which all have a default-empty `drink_plans` row well before T-21) as already-submitted and suppresses the nudge for exactly the clients who still need it. **"Submitted" must be defined as `selections IS NOT NULL AND selections::text <> '{}'`** — a populated selections object. The consult check stays `consult_filled_at IS NOT NULL` (a timestamp column with no `'{}'` default). `loadNudgeContext` below applies this; the handler tests below cover the empty-`{}`-row production case explicitly.

The email template is co-located in `drinkPlanNudge.js` (it is a single small template; `emailTemplates.js` is at 976 lines, near the 1000-line hard cap, so do NOT add it there; `lifecycleEmailTemplates.js` at 331 lines could host it, but co-locating with the handler keeps the touch self-contained).

**Files:**
- Create: `server/utils/drinkPlanNudge.js`
- Create: `server/utils/drinkPlanNudge.test.js`
- Modify: `server/utils/preEventScheduling.js` (call `scheduleDrinkPlanNudge` from `schedulePreEventReminders`)
- Modify: `server/index.js` (handler bootstrap)

- [ ] **Step 1: Write the failing test**

Create `server/utils/drinkPlanNudge.test.js`:

```javascript
require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerDrinkPlanNudgeHandlers, scheduleDrinkPlanNudge } = require('./drinkPlanNudge');
const { getHandlerMeta, _clearHandlersForTest } = require('./scheduledMessageDispatcher');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Nudge Test', 'nudge-test@example.com', '3125550150') RETURNING id"
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, status, event_type, event_timezone)
     VALUES ($1, CURRENT_DATE + INTERVAL '60 days', '18:00', 'deposit_paid', 'birthday-party', 'America/Chicago')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('registerDrinkPlanNudgeHandlers > registers email + sms types, operational, T-21 offset', () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  for (const mt of ['drink_plan_nudge', 'drink_plan_nudge_sms']) {
    const meta = getHandlerMeta(mt);
    assert.ok(meta, `expected meta for ${mt}`);
    assert.strictEqual(meta.category, 'operational');
    assert.strictEqual(meta.anchor, 'event_date');
    assert.strictEqual(meta.offsetFromEventDate, -21 * 86400);
  }
});

test('scheduleDrinkPlanNudge > inserts an email row and an sms row', async () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  await scheduleDrinkPlanNudge(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1 ORDER BY channel`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 2);
  const m = Object.fromEntries(rows.map(r => [r.channel, r.message_type]));
  assert.strictEqual(m.email, 'drink_plan_nudge');
  assert.strictEqual(m.sms, 'drink_plan_nudge_sms');
});

test('scheduleDrinkPlanNudge > is idempotent', async () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  await scheduleDrinkPlanNudge(proposalId);
  await scheduleDrinkPlanNudge(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 2);
});

test('drink_plan_nudge handler > throws SUPPRESS when the drink plan has populated selections', async () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  // A drink_plans row with a NON-EMPTY selections object means the client
  // already submitted via the Potion Planner.
  await pool.query(
    `INSERT INTO drink_plans (proposal_id, selections) VALUES ($1, '{"beer":["lager"]}'::jsonb)`,
    [proposalId]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'drink_plan_nudge', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_id=$1 AND message_type='drink_plan_nudge'",
    [proposalId]
  );
  // The handler throws on suppression → the dispatcher marks the row 'failed'
  // with the suppression reason in error_message.
  assert.strictEqual(rows[0].status, 'failed');
  assert.match(rows[0].error_message, /SUPPRESS/);
});

test('drink_plan_nudge handler > is NOT suppressed by a default-empty drink_plans row', async () => {
  // The production case: createDrinkPlan inserts a drink_plans row at
  // conversion with NO selections value, so selections is the empty object
  // '{}' (DEFAULT '{}'), not NULL. The nudge MUST still fire for this row —
  // an empty '{}' is "not submitted". This is the regression Blocker 1 caught.
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  const { __setSmsDeps } = require('./sms');
  __setSmsDeps({ sendSMS: async () => ({ sid: 'stub' }) });
  // Row created exactly as createDrinkPlan would: no selections column → '{}'.
  await pool.query(`INSERT INTO drink_plans (proposal_id) VALUES ($1)`, [proposalId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'drink_plan_nudge', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='drink_plan_nudge'",
    [proposalId]
  );
  // sent (the email send succeeds in dev) — NOT 'failed' with a SUPPRESS reason.
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});

test('drink_plan_nudge_sms handler > sends an SMS when the drink plan is empty', async () => {
  _clearHandlersForTest();
  registerDrinkPlanNudgeHandlers();
  const { __setSmsDeps } = require('./sms');
  let smsCalls = 0;
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: 'stub' }; } });
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'drink_plan_nudge_sms', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();
  assert.strictEqual(smsCalls, 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='drink_plan_nudge_sms'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/drinkPlanNudge.test.js`
Expected: FAIL — `Cannot find module './drinkPlanNudge'`.

- [ ] **Step 3: Create `drinkPlanNudge.js`**

Create `server/utils/drinkPlanNudge.js`:

```javascript
/**
 * Drink-plan / Potion Planner nudge — a full email + SMS touch (spec 3.7).
 * No email side existed before Phase 3, so this file owns the email template,
 * both dispatcher handlers, and the scheduling helper.
 *
 * Two message_types:
 *   - drink_plan_nudge      (channel email)
 *   - drink_plan_nudge_sms  (channel sms)
 * Both scheduled T-21 days from event, 10:00 event-local via computeScheduledFor.
 * Category 'operational' (drink plan completion is transactional). priority 2
 * and multiChannel: true (both inert until Phase 4b). multiChannel marks this
 * as an email+SMS pair so the Phase 4b delivery-failure logic does NOT
 * channel-substitute either row — per spec 7.3 each channel's row is
 * independent (the dead channel suppresses, the other fires).
 *
 * Send-time suppression: throw 'SUPPRESS: ...' when the drink plan is already
 * filled or the proposal is archived. The dispatcher records the throw as
 * 'failed' with the reason in error_message — that is the chosen signal for
 * "no longer needed" (mirrors marketingHandlers.js retention_nudge, which also
 * throws 'SUPPRESS:' for a last-mile skip).
 *
 * "Filled" is NOT "a drink_plans row exists". drink_plans.selections is
 * JSONB DEFAULT '{}', and createDrinkPlan (eventCreation.js) inserts a row at
 * conversion with no selections value — so a converted proposal has a
 * default-empty '{}' row long before T-21. "Submitted" therefore means a
 * POPULATED selections object: selections IS NOT NULL AND selections::text
 * <> '{}'. The consult signal stays consult_filled_at IS NOT NULL (a timestamp
 * column, no '{}' default).
 */
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { scheduleMessage } = require('./messageScheduling');
const { computeScheduledFor } = require('./preEventScheduling');
const { sendEmail } = require('./email');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { wrapEmail } = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

const BRAND = { primary: '#3b2314', secondary: '#6b4226' };
const DAY_SECONDS = 86400;
const NUDGE_OFFSET = -21 * DAY_SECONDS;
const NUDGE_PRIORITY = 2;

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function eventDateSms(eventDate) {
  if (!eventDate) return 'your event';
  const parsed = new Date(String(eventDate).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return 'your event';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

/**
 * Drink-plan nudge email body. Spec 3.7: three ways to lock in drinks.
 * NO em dashes. ctaButton inlined to avoid the emailTemplates.js require cycle.
 */
function drinkPlanNudgeEmail({ clientFirstName, eventTypeLabel, eventDateDisplay, plannerUrl, consultUrl, phone }) {
  const name = clientFirstName || 'there';
  const consultLine = consultUrl
    ? `<li>Book a 15-minute phone consult: <a href="${esc(consultUrl)}">${esc(consultUrl)}</a></li>`
    : '';
  const phoneLine = phone
    ? `<li>Call or text us at ${esc(phone)} and we'll walk through it together</li>`
    : `<li>Call or text us and we'll walk through it together</li>`;
  return {
    subject: `Time to lock in drinks for your ${eventTypeLabel} event`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Time to lock in drinks</h2>
      <p>Hi ${esc(name)},</p>
      <p>Time to lock in drinks for your <strong>${esc(eventTypeLabel)}</strong> on ${esc(eventDateDisplay)}. Three ways to do it:</p>
      <ol style="line-height:1.7;color:${BRAND.primary};padding-left:1.25rem;">
        <li>Potion Planner: <a href="${esc(plannerUrl)}">${esc(plannerUrl)}</a> (about 5 minutes, easiest)</li>
        ${consultLine}
        ${phoneLine}
      </ol>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers, Dallas</p>
    `),
    text: [
      `Hi ${name}, time to lock in drinks for your ${eventTypeLabel} on ${eventDateDisplay}. Three ways to do it:`,
      `1. Potion Planner: ${plannerUrl} (about 5 minutes, easiest)`,
      consultUrl ? `2. Book a 15-minute phone consult: ${consultUrl}` : null,
      `${consultUrl ? '3' : '2'}. Call or text us${phone ? ` at ${phone}` : ''} and we'll walk through it together`,
      'Cheers, Dallas',
    ].filter(Boolean).join('\n'),
  };
}

/**
 * Load the proposal + client + drink_plan fields the nudge handlers need.
 * Throws 'SUPPRESS: ...' for the no-longer-needed cases so the dispatcher
 * records a clear reason.
 */
async function loadNudgeContext(proposalId) {
  // dp_submitted is computed in SQL: TRUE only when selections is a populated
  // object. A drink_plans row created at conversion has selections = '{}'
  // (JSONB DEFAULT '{}'), which is NOT a submission — see the file header.
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.event_type, p.event_type_custom,
            c.id AS client_id, c.name AS client_name, c.email AS client_email,
            c.phone AS client_phone,
            (dp.selections IS NOT NULL AND dp.selections::text <> '{}') AS dp_submitted,
            dp.consult_filled_at AS dp_consult_filled_at
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN drink_plans dp ON dp.proposal_id = p.id
      WHERE p.id = $1
      LIMIT 1`,
    [proposalId]
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`drink_plan_nudge: proposal ${proposalId} not found`);
  if (ctx.status === 'archived') throw new Error('SUPPRESS: proposal archived');
  // Spec 3.7 suppression: the drink plan is already filled. dp_submitted is
  // the SQL-computed "populated selections" flag — a default-empty '{}' row
  // does NOT count, so the nudge still fires for a freshly-converted proposal.
  if (ctx.dp_submitted === true) {
    throw new Error('SUPPRESS: drink plan already has selections');
  }
  if (ctx.dp_consult_filled_at !== null && ctx.dp_consult_filled_at !== undefined) {
    throw new Error('SUPPRESS: drink plan consult already recorded');
  }
  return ctx;
}

function firstNameOf(fullName) {
  if (!fullName) return 'there';
  return String(fullName).trim().split(/\s+/)[0] || 'there';
}

function eventLabel(ctx) {
  return getEventTypeLabel({ event_type: ctx.event_type, event_type_custom: ctx.event_type_custom });
}

async function handleDrinkPlanNudgeEmail({ entity }) {
  const ctx = await loadNudgeContext(entity.id);
  if (!ctx.client_email) throw new Error('drink_plan_nudge: client has no email');
  const tpl = drinkPlanNudgeEmail({
    clientFirstName: firstNameOf(ctx.client_name),
    eventTypeLabel: eventLabel(ctx),
    eventDateDisplay: eventDateSms(ctx.event_date),
    plannerUrl: ctx.token ? `${PUBLIC_SITE_URL}/plan/${ctx.token}` : `${PUBLIC_SITE_URL}/plan`,
    consultUrl: null, // wired to Cal.com once the integration plan lands
    phone: process.env.ADMIN_PHONE || null,
  });
  await sendEmail({ to: ctx.client_email, ...tpl });
}

async function handleDrinkPlanNudgeSms({ entity }) {
  const ctx = await loadNudgeContext(entity.id);
  if (!ctx.client_phone) throw new Error('drink_plan_nudge_sms: client has no phone');
  const body = smsTemplates.drinkPlanNudgeSms({
    eventDate: eventDateSms(ctx.event_date),
    plannerUrl: ctx.token ? `${PUBLIC_SITE_URL}/plan/${ctx.token}` : `${PUBLIC_SITE_URL}/plan`,
    consultUrl: null, // wired to Cal.com once the integration plan lands
  });
  await sendAndLogSms({
    to: ctx.client_phone,
    body,
    clientId: ctx.client_id,
    messageType: 'drink_plan_nudge_sms',
    recipientName: ctx.client_name || null,
  });
}

function registerDrinkPlanNudgeHandlers() {
  // multiChannel: true — drink_plan_nudge (email) and drink_plan_nudge_sms are
  // the two halves of one email+SMS touch. Per spec 7.3 the Phase 4b
  // delivery-failure logic must NOT channel-substitute a multi-channel touch:
  // each channel's row is independent, and the dead channel's row simply
  // suppresses while the other fires (substituting would, e.g., add an SMS on
  // top of the real drink_plan_nudge_sms row → two SMS). multiChannel is a
  // Phase-4b-defined registerHandler option, inert until Phase 4b lands —
  // today's registerHandler ignores unknown option keys, exactly as for priority.
  registerHandler('drink_plan_nudge', handleDrinkPlanNudgeEmail, {
    offsetFromEventDate: NUDGE_OFFSET, anchor: 'event_date', category: 'operational',
    priority: NUDGE_PRIORITY, multiChannel: true,
  });
  registerHandler('drink_plan_nudge_sms', handleDrinkPlanNudgeSms, {
    offsetFromEventDate: NUDGE_OFFSET, anchor: 'event_date', category: 'operational',
    priority: NUDGE_PRIORITY, multiChannel: true,
  });
}

/**
 * Insert the drink_plan_nudge email + SMS scheduled_messages rows (T-21 days,
 * 10:00 event-local). Idempotent — scheduleMessage no-ops on a pending dup.
 * Called from schedulePreEventReminders. Skips archived proposals and proposals
 * with no client / no event_date.
 *
 * @param {number|string} proposalId
 * @param {{ query: Function }} [executor] - pg client or pool; defaults to pool
 *   when omitted. Passed through so a reschedule-cascade caller's transaction is
 *   joined (mirrors schedulePreEventReminders' executor param).
 */
async function scheduleDrinkPlanNudge(proposalId, executor) {
  const { pool: realPool } = require('../db');
  const exec = executor || realPool;
  const { rows } = await exec.query(
    `SELECT id, client_id, status, event_date, event_timezone
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = rows[0];
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  const scheduledFor = computeScheduledFor('drink_plan_nudge', proposal);
  // Both rows share the same send instant; scheduleMessage is idempotent.
  await scheduleMessage({
    entityType: 'proposal', entityId: Number(proposalId),
    messageType: 'drink_plan_nudge', recipientType: 'client', recipientId: proposal.client_id,
    channel: 'email', scheduledFor,
  });
  await scheduleMessage({
    entityType: 'proposal', entityId: Number(proposalId),
    messageType: 'drink_plan_nudge_sms', recipientType: 'client', recipientId: proposal.client_id,
    channel: 'sms', scheduledFor,
  });
}

module.exports = {
  registerDrinkPlanNudgeHandlers,
  scheduleDrinkPlanNudge,
  drinkPlanNudgeEmail,
  loadNudgeContext,
};
```

Note on the `executor` parameter: `scheduleDrinkPlanNudge` uses `scheduleMessage` (which always runs on the module-level `pool`), so the `executor` argument is currently only used for the proposal SELECT. This matches the contract's note that `event_eve` / nudge "decide whether to ride this helper." `scheduleMessage`'s `ON CONFLICT DO NOTHING` keeps it idempotent even outside a transaction; the reschedule cascade re-anchors existing rows via `reanchorPendingMessages`, so a nudge row scheduled here on `pool` is still correctly re-anchored later. Accepting `executor` keeps the signature uniform with `schedulePreEventReminders` for the caller in Step 4.

- [ ] **Step 4: Schedule the nudge from `schedulePreEventReminders`**

In `server/utils/preEventScheduling.js`, find the end of `schedulePreEventReminders` — the conditional T-30 block (lines 181-192). Immediately AFTER the closing `}` of the `if (shouldScheduleLongLeadRecap(proposal)) { ... }` block and BEFORE the function's final `}`, add:

```javascript
  // Comms Phase 3: drink-plan nudge (email + SMS), T-21 days, 10:00 event-local.
  // Delegated to drinkPlanNudge.js so this file does not grow. require() is
  // inline to avoid a load-order cycle (drinkPlanNudge.js requires
  // computeScheduledFor from this file).
  try {
    const { scheduleDrinkPlanNudge } = require('./drinkPlanNudge');
    await scheduleDrinkPlanNudge(proposalId, exec);
  } catch (nudgeErr) {
    // Best-effort relative to the always-on event_week_reminder above.
    console.warn('[schedulePreEventReminders] drink-plan nudge scheduling failed (non-fatal):', nudgeErr.message);
  }
```

`exec` is the `executor || pool` variable already defined at the top of `schedulePreEventReminders` (line 156).

- [ ] **Step 5: Register the nudge handlers at boot**

In `server/index.js`, immediately AFTER the `require('./utils/dripSmsHandlers').registerDripSmsHandlers();` line you added in Task 5 Step 6, add:

```javascript
      require('./utils/drinkPlanNudge').registerDrinkPlanNudgeHandlers();
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test server/utils/drinkPlanNudge.test.js`
Expected: PASS — all 6 tests pass (including the empty-`{}`-row not-suppressed regression test).

- [ ] **Step 7: Run the pre-event scheduling tests — they WILL fail; this step records exactly which assertions break**

Run: `node --test server/utils/preEventScheduling.test.js`
Expected: FAIL on three tests. `schedulePreEventReminders` now inserts `drink_plan_nudge` + `drink_plan_nudge_sms` alongside `event_week_reminder` (and `long_lead_t30_recap` for a 90+-day-lead proposal). The three breakages — verified against the current test file:

1. **`schedulePreEventReminders > schedules event_week_reminder (T-7) ...`** — the test SELECTs `ORDER BY message_type` and asserts `rows.length === 1` (now 4: alphabetically `drink_plan_nudge`, `drink_plan_nudge_sms`, `event_week_reminder` — note Task 10 adds `event_eve` later; after Task 6 alone it is 3 rows). The follow-on `rows[0].message_type === 'event_week_reminder'` and the `rows[0]` channel / recipient assertions also break because `ORDER BY message_type` now puts `drink_plan_nudge` at `rows[0]`.
2. **`schedulePreEventReminders > also schedules long_lead_t30_recap ...`** — asserts `rows.map(...).sort()` deep-equals the exact 2-element list `['event_week_reminder', 'long_lead_t30_recap']`. Now 4 elements (adds the two nudge types).
3. **`schedulePreEventReminders > is idempotent ...`** — asserts `rows[0].n === 1` (an absolute count). Now 3 (short-lead).

The `skips entirely when proposal is archived` test still passes (archived → 0 rows, `scheduleDrinkPlanNudge` early-returns on archived).

- [ ] **Step 8: Fix the three broken `preEventScheduling.test.js` assertions**

In `server/utils/preEventScheduling.test.js`:

(a) In `schedulePreEventReminders > schedules event_week_reminder (T-7) when proposal moves to deposit_paid`, replace the assertion block. The current block asserts `rows.length === 1` then asserts `rows[0]` fields. Rewrite it to find the `event_week_reminder` row by `message_type` instead of assuming it is `rows[0]`:

```javascript
  // Lead time = 2026-08-15 - 2026-07-01 = 45 days. < 90, so no long_lead_t30_recap.
  // schedulePreEventReminders now also schedules the drink-plan nudge (email + SMS).
  assert.strictEqual(rows.length, 3);
  const ewr = rows.find((r) => r.message_type === 'event_week_reminder');
  assert.ok(ewr, 'event_week_reminder row should exist');
  assert.strictEqual(ewr.channel, 'email');
  assert.strictEqual(ewr.status, 'pending');
  assert.strictEqual(ewr.recipient_type, 'client');
  assert.strictEqual(ewr.recipient_id, TEST_CLIENT_ID);
  assert.deepStrictEqual(
    rows.map((r) => r.message_type).sort(),
    ['drink_plan_nudge', 'drink_plan_nudge_sms', 'event_week_reminder']
  );
```

(b) In `schedulePreEventReminders > also schedules long_lead_t30_recap when booking lead time >= 90 days`, update the exact-list assertion to the new 4-element reality:

```javascript
  assert.deepStrictEqual(rows.map((r) => r.message_type).sort(), [
    'drink_plan_nudge', 'drink_plan_nudge_sms', 'event_week_reminder', 'long_lead_t30_recap',
  ]);
```

(c) In `schedulePreEventReminders > is idempotent — calling twice does not duplicate rows`, change the absolute count from `1` to `3`:

```javascript
  assert.strictEqual(rows[0].n, 3);
```

Re-run `node --test server/utils/preEventScheduling.test.js` and confirm PASS. Note for Task 10: that task adds `event_eve` to the same helper, so it bumps these same three numbers again (3→4 short-lead, 4→5 long-lead) — Task 10 Step 7 owns that follow-up edit.

- [ ] **Step 9: Commit**

```bash
git add server/utils/drinkPlanNudge.js server/utils/drinkPlanNudge.test.js server/utils/preEventScheduling.js server/utils/preEventScheduling.test.js server/index.js
git commit -m "feat(comms): drink-plan nudge email and SMS touch, scheduled T-21"
```

---

## Task 7: Balance SMS — due-today, late t1, late t3

Spec 3.5 and 3.6. Three scheduled SMS touches paralleling the existing email balance reminders: `balance_due_today_sms`, `balance_late_t1_sms`, `balance_late_t3_sms`. Anchored on `balance_due_date` (offsets `0`, `+1d`, `+3d`) so the reschedule cascade re-anchors them. Category `operational`. `balance_due_today_sms` is priority `1` + `cooldownExempt: true`; the two late types are priority `2`. The scheduling rows are added to `scheduleBalanceReminders` in `stripe.js` (the non-autopay branch only — autopay clients get no SMS, matching the email side). Handlers live in a new `balanceSmsHandlers.js`.

All three handlers also register `multiChannel: true`: each is the SMS half of an email+SMS balance-reminder pair (email halves `balance_due_today` / `balance_late_t1` / `balance_late_t3`), and per spec 7.3 the Phase 4b delivery-failure logic must NOT channel-substitute a multi-channel touch (each channel's row is independent — the dead channel suppresses, the other fires). `multiChannel` is a Phase-4b-defined `registerHandler` option, inert until Phase 4b lands (today's `registerHandler` ignores unknown option keys, exactly as it does for `priority` / `cooldownExempt`).

These fire only for non-autopay proposals (spec 3.5/3.6 are explicitly non-autopay).

**Files:**
- Create: `server/utils/balanceSmsHandlers.js`
- Create: `server/utils/balanceSmsHandlers.test.js`
- Modify: `server/routes/stripe.js` (`scheduleBalanceReminders` non-autopay branch, lines 98-103)
- Modify: `server/index.js` (handler bootstrap)

- [ ] **Step 1: Write the failing test**

Create `server/utils/balanceSmsHandlers.test.js`:

```javascript
require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerBalanceSmsHandlers } = require('./balanceSmsHandlers');
const { getHandlerMeta, _clearHandlersForTest, dispatchPending } = require('./scheduledMessageDispatcher');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('Balance SMS Test', 'balsms-test@example.com', '3125550160') RETURNING id"
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party', 100000, 10000, CURRENT_DATE + INTERVAL '14 days', false)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('registerBalanceSmsHandlers > registers three types on balance_due_date with the right offsets', () => {
  _clearHandlersForTest();
  registerBalanceSmsHandlers();
  const today = getHandlerMeta('balance_due_today_sms');
  const t1 = getHandlerMeta('balance_late_t1_sms');
  const t3 = getHandlerMeta('balance_late_t3_sms');
  assert.ok(today && t1 && t3);
  assert.strictEqual(today.anchor, 'balance_due_date');
  assert.strictEqual(today.offsetFromEventDate, 0);
  assert.strictEqual(t1.offsetFromEventDate, 86400);
  assert.strictEqual(t3.offsetFromEventDate, 3 * 86400);
  assert.ok([today, t1, t3].every(m => m.category === 'operational'));
});

test('balance_due_today_sms handler > sends an SMS and marks the row sent', async () => {
  _clearHandlersForTest();
  registerBalanceSmsHandlers();
  const { __setSmsDeps } = require('./sms');
  let body = null;
  __setSmsDeps({ sendSMS: async (args) => { body = args.body; return { sid: 'stub' }; } });
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'balance_due_today_sms', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  await dispatchPending();
  assert.match(body, /due today/);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='balance_due_today_sms'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});

test('balance_late_t3_sms handler > throws when balance is already zero', async () => {
  _clearHandlersForTest();
  registerBalanceSmsHandlers();
  // Pay the balance in full so the handler's balance>0 guard fails.
  await pool.query('UPDATE proposals SET amount_paid = total_price WHERE id = $1', [proposalId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'balance_late_t3_sms', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_id=$1 AND message_type='balance_late_t3_sms'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'failed');
  assert.match(rows[0].error_message, /balance/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/balanceSmsHandlers.test.js`
Expected: FAIL — `Cannot find module './balanceSmsHandlers'`.

- [ ] **Step 3: Create `balanceSmsHandlers.js`**

Create `server/utils/balanceSmsHandlers.js`:

```javascript
/**
 * Balance SMS handlers — the SMS halves of the non-autopay balance reminder
 * ladder (spec 3.5 due-today, 3.6 late t1 / t3). The email halves
 * (balance_due_today, balance_late_t1, balance_late_t3) live in
 * scheduledMessageDispatcher.js. Kept separate so the dispatcher core stays
 * lean.
 *
 * Three message_types, all anchored on balance_due_date (NOT event_date) so the
 * reschedule cascade re-anchors them when admin moves the balance due date:
 *   - balance_due_today_sms  (offset 0,  priority 1, cooldownExempt)
 *   - balance_late_t1_sms    (offset +1d, priority 2)
 *   - balance_late_t3_sms    (offset +3d, priority 2)
 * priority / cooldownExempt / multiChannel are inert until Phase 4b. All three
 * register multiChannel: true — each is the SMS half of an email+SMS balance
 * reminder pair, and spec 7.3 forbids the Phase 4b delivery-failure logic from
 * channel-substituting a multi-channel touch (each channel's row is
 * independent; the dead channel suppresses while the other fires).
 *
 * These are scheduled only for NON-autopay proposals (scheduleBalanceReminders
 * in stripe.js gates on autopay_enrolled), matching the email side.
 */
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { PUBLIC_SITE_URL } = require('./urls');

const DAY_SECONDS = 86400;

/**
 * Load proposal + client fields a balance SMS handler needs. Throws when the
 * proposal is gone / archived, the client has no phone / opted out of SMS, or
 * the balance is already cleared (the reminder is moot — admin or autopay
 * resolved it).
 */
async function loadBalanceSmsContext(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.total_price, p.amount_paid,
            c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
            c.communication_preferences AS comm_prefs, c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`balance SMS: proposal ${proposalId} not found`);
  if (ctx.status === 'archived') throw new Error('balance SMS: proposal archived');
  if (!ctx.client_phone) throw new Error('balance SMS: client has no phone');
  if (ctx.phone_status === 'bad') throw new Error('balance SMS: client phone_status is bad');
  const prefs = ctx.comm_prefs || {};
  if (prefs.sms_enabled === false) throw new Error('balance SMS: sms_enabled is false');
  const balanceDue = Number(ctx.total_price) - Number(ctx.amount_paid);
  if (!(balanceDue > 0)) throw new Error('balance SMS: balance is zero or negative, reminder moot');
  return ctx;
}

function eventDateSms(eventDate) {
  if (!eventDate) return 'your event';
  const parsed = new Date(String(eventDate).slice(0, 10) + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return 'your event';
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

function proposalUrl(token) {
  return `${PUBLIC_SITE_URL}/proposal/${token}`;
}

async function sendBalanceSms(proposalId, messageType, bodyFn) {
  const ctx = await loadBalanceSmsContext(proposalId);
  await sendAndLogSms({
    to: ctx.client_phone,
    body: bodyFn(ctx),
    clientId: ctx.client_id,
    messageType,
    recipientName: ctx.client_name || null,
  });
}

function registerBalanceSmsHandlers() {
  // multiChannel: true on all three — each is the SMS half of an email+SMS
  // balance-reminder pair (email halves: balance_due_today, balance_late_t1,
  // balance_late_t3). Per spec 7.3 the Phase 4b delivery-failure logic must NOT
  // channel-substitute a multi-channel touch: each channel's row is
  // independent, the dead channel suppresses while the other fires.
  // multiChannel is a Phase-4b-defined registerHandler option, inert until
  // Phase 4b lands — today's registerHandler ignores unknown option keys,
  // exactly as it does for priority / cooldownExempt.
  registerHandler(
    'balance_due_today_sms',
    ({ entity }) => sendBalanceSms(entity.id, 'balance_due_today_sms', (ctx) => smsTemplates.balanceDueTodaySms({
      eventDate: eventDateSms(ctx.event_date),
      link: proposalUrl(ctx.token),
    })),
    { offsetFromEventDate: 0, anchor: 'balance_due_date', category: 'operational', priority: 1, cooldownExempt: true, multiChannel: true }
  );
  registerHandler(
    'balance_late_t1_sms',
    ({ entity }) => sendBalanceSms(entity.id, 'balance_late_t1_sms', (ctx) => smsTemplates.balanceLateSms({
      eventDate: eventDateSms(ctx.event_date),
      link: proposalUrl(ctx.token),
      daysLate: 1,
    })),
    { offsetFromEventDate: 1 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
  );
  registerHandler(
    'balance_late_t3_sms',
    ({ entity }) => sendBalanceSms(entity.id, 'balance_late_t3_sms', (ctx) => smsTemplates.balanceLateSms({
      eventDate: eventDateSms(ctx.event_date),
      link: proposalUrl(ctx.token),
      daysLate: 3,
    })),
    { offsetFromEventDate: 3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
  );
}

module.exports = { registerBalanceSmsHandlers, loadBalanceSmsContext };
```

- [ ] **Step 4: Add the three SMS rows to `scheduleBalanceReminders` (non-autopay branch)**

In `server/routes/stripe.js`, find the non-autopay `else` branch of `scheduleBalanceReminders` (lines 98-103):

```javascript
    } else {
      await scheduleMessage({ ...base, messageType: 'balance_reminder_non_autopay_t3', scheduledFor: t3Before });
      await scheduleMessage({ ...base, messageType: 'balance_due_today', scheduledFor: dueDay });
      await scheduleMessage({ ...base, messageType: 'balance_late_t1', scheduledFor: t1After });
      await scheduleMessage({ ...base, messageType: 'balance_late_t3', scheduledFor: t3After });
    }
```

Replace with:

```javascript
    } else {
      // Email halves.
      await scheduleMessage({ ...base, messageType: 'balance_reminder_non_autopay_t3', scheduledFor: t3Before });
      await scheduleMessage({ ...base, messageType: 'balance_due_today', scheduledFor: dueDay });
      await scheduleMessage({ ...base, messageType: 'balance_late_t1', scheduledFor: t1After });
      await scheduleMessage({ ...base, messageType: 'balance_late_t3', scheduledFor: t3After });
      // SMS halves (Phase 3, spec 3.5 / 3.6). Non-autopay only — autopay
      // clients get no balance SMS, matching the email side. `base` has
      // channel:'email'; override per row to 'sms'.
      const smsBase = { ...base, channel: 'sms' };
      await scheduleMessage({ ...smsBase, messageType: 'balance_due_today_sms', scheduledFor: dueDay });
      await scheduleMessage({ ...smsBase, messageType: 'balance_late_t1_sms', scheduledFor: t1After });
      await scheduleMessage({ ...smsBase, messageType: 'balance_late_t3_sms', scheduledFor: t3After });
    }
```

Note: there is intentionally no `balance_reminder_..._t3` SMS. Spec 3.5/3.6 define SMS for due-today, t1, and t3 only; the T-3 reminder is email-only (spec 3.4). This matches the contract §9 row "Balance due-today + late SMS."

- [ ] **Step 5: Register the balance SMS handlers at boot**

In `server/index.js`, immediately AFTER the `require('./utils/drinkPlanNudge').registerDrinkPlanNudgeHandlers();` line you added in Task 6 Step 5, add:

```javascript
      require('./utils/balanceSmsHandlers').registerBalanceSmsHandlers();
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test server/utils/balanceSmsHandlers.test.js`
Expected: PASS — all 3 tests pass.

- [ ] **Step 7: Confirm `stripe.js` compiles**

Run: `node -e "require('./server/routes/stripe.js'); console.log('stripe.js loads ok')"`
Expected: prints `stripe.js loads ok`.

- [ ] **Step 8: Commit**

```bash
git add server/utils/balanceSmsHandlers.js server/utils/balanceSmsHandlers.test.js server/routes/stripe.js server/index.js
git commit -m "feat(comms): balance due-today and late-balance SMS for non-autopay"
```

---

## Task 8: Payment-failure immediate SMS

Spec 3.3. Attaches in `server/utils/paymentFailedClientNotify.js`, beside the existing client email, under the same 24h throttle. The throttle is a per-proposal claim row (`proposal_activity_log` action `payment_failed_email_client`, partial unique index). The email and SMS are one client-facing payment-failure touch — keep them under the single existing claim so the client gets at most one of each per proposal. Send the SMS only after the email path has done its work, gated by `shouldSendImmediate({ channel: 'sms' })`, best-effort.

The existing function does not load the client phone or comm-prefs. Add them to the proposal SELECT.

**Files:**
- Modify: `server/utils/paymentFailedClientNotify.js`
- Test: `server/utils/paymentFailedClientNotify.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `server/utils/paymentFailedClientNotify.test.js`:

```javascript
require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { notifyClientPaymentFailed } = require('./paymentFailedClientNotify');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('PayFail Test', 'payfail-test@example.com', '3125550170') RETURNING id"
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'deposit_paid', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM sms_messages WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('notifyClientPaymentFailed > sends the failure SMS once and never throws', async () => {
  const { __setSmsDeps } = require('./sms');
  let smsCalls = 0;
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: 'stub' }; } });
  await assert.doesNotReject(() => notifyClientPaymentFailed({ proposalId, paymentIntentId: 'pi_test_1' }));
  // The email send hits Resend; in dev with no key it logs and is best-effort.
  // We only assert the SMS half here.
  const { rows } = await pool.query(
    "SELECT message_type, status FROM sms_messages WHERE client_id = $1",
    [clientId]
  );
  assert.strictEqual(rows.length, 1, 'exactly one payment-failure SMS row');
  assert.strictEqual(rows[0].message_type, 'payment_failure');
  assert.strictEqual(smsCalls, 1);
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});

test('notifyClientPaymentFailed > the 24h claim makes a second call a no-op', async () => {
  const { __setSmsDeps } = require('./sms');
  let smsCalls = 0;
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: 'stub' }; } });
  await notifyClientPaymentFailed({ proposalId, paymentIntentId: 'pi_test_1' });
  await notifyClientPaymentFailed({ proposalId, paymentIntentId: 'pi_test_2' });
  assert.strictEqual(smsCalls, 1, 'second call must not re-send (claim already held)');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/paymentFailedClientNotify.test.js`
Expected: FAIL — no `sms_messages` row is written (`rows.length` is 0).

- [ ] **Step 3: Add the SMS hook to `notifyClientPaymentFailed`**

Replace the entire contents of `server/utils/paymentFailedClientNotify.js` with:

```javascript
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { shouldSendImmediate } = require('./messageSuppression');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

// Client-facing "your card failed" email + SMS for a failed Stripe payment,
// sent once per proposal (spec 3.3, email + SMS together, urgent). Extracted
// from routes/stripe.js (over the file-size cap). Best-effort — owns its
// try/catch, never throws into the webhook handler.
//
// The slot is CLAIMED first with an atomic INSERT ... ON CONFLICT DO NOTHING
// against the partial unique index idx_proposal_activity_payment_failed_client,
// so concurrent Stripe retries can't both win — the proposal fetch and the
// sends only run for the winner. The email AND the SMS are the single
// client-facing payment-failure touch, so they share this one claim: a client
// gets at most one email and one SMS per proposal. If the EMAIL send fails the
// claim is released so a later retry can still notify (an SMS failure does not
// release — the email is the load-bearing channel for the release decision,
// and sendAndLogSms already logs the failed SMS row).
async function notifyClientPaymentFailed({ proposalId, paymentIntentId }) {
  try {
    const claim = await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'payment_failed_email_client', 'system', $2)
       ON CONFLICT (proposal_id) WHERE action = 'payment_failed_email_client'
       DO NOTHING
       RETURNING id`,
      [proposalId, JSON.stringify({ payment_intent_id: paymentIntentId })]
    );
    if (claim.rowCount !== 1) return; // already notified for this proposal

    const propRow = await pool.query(
      `SELECT p.token, p.status, p.event_type, p.event_type_custom, p.event_date,
              c.id AS client_id, c.name AS client_name, c.email AS client_email,
              c.phone AS client_phone, c.communication_preferences,
              c.email_status, c.phone_status
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1`,
      [proposalId]
    );
    const pc = propRow.rows[0];
    if (!pc?.client_email && !pc?.client_phone) {
      // No recipient on either channel — release the claim so a later retry
      // (or a corrected client record) can still notify.
      await pool.query('DELETE FROM proposal_activity_log WHERE id = $1', [claim.rows[0].id])
        .catch(() => {});
      return;
    }

    const eventTypeLabel = getEventTypeLabel({
      event_type: pc.event_type,
      event_type_custom: pc.event_type_custom,
    });
    const proposalUrl = `${PUBLIC_SITE_URL}/proposal/${pc.token}`;

    // ── Email half ──
    if (pc.client_email) {
      const tpl = emailTemplates.paymentFailedClient({
        clientName: pc.client_name,
        eventTypeLabel,
        last4: null, // not stored today — future task
        proposalUrl,
      });
      try {
        await sendEmail({ to: pc.client_email, ...tpl });
      } catch (sendErr) {
        // Release the claim so a later retry can still notify the client.
        await pool.query('DELETE FROM proposal_activity_log WHERE id = $1', [claim.rows[0].id])
          .catch(() => {});
        throw sendErr;
      }
    }

    // ── SMS half (Phase 3, spec 3.3) — separate try/catch so an SMS failure
    // does not release the claim or mask the email's success. ──
    try {
      const smsCheck = await shouldSendImmediate({
        proposal: { status: pc.status },
        client: {
          communication_preferences: pc.communication_preferences,
          email_status: pc.email_status,
          phone_status: pc.phone_status,
        },
        channel: 'sms',
      });
      if (smsCheck.ok && pc.client_phone) {
        const eventDateSms = pc.event_date
          ? new Date(String(pc.event_date).slice(0, 10) + 'T12:00:00Z')
              .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' })
          : 'your event';
        await sendAndLogSms({
          to: pc.client_phone,
          body: smsTemplates.paymentFailureSms({ eventDate: eventDateSms, link: proposalUrl }),
          clientId: pc.client_id || null,
          messageType: 'payment_failure',
          recipientName: pc.client_name || null,
        });
      } else if (!smsCheck.ok) {
        console.log(`[paymentFailureSms] suppressed for proposal ${proposalId}: ${smsCheck.reason}`);
      }
    } catch (smsErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(smsErr, {
          tags: { webhook: 'stripe', component: 'paymentFailedClient', issue: 'sms' },
        });
      }
      console.error('Client payment-failure SMS failed (non-blocking):', smsErr.message);
    }
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { webhook: 'stripe', component: 'paymentFailedClient' },
      });
    }
    console.error('Client payment-failure email failed (non-blocking):', err);
  }
}

module.exports = { notifyClientPaymentFailed };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/paymentFailedClientNotify.test.js`
Expected: PASS — both tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/paymentFailedClientNotify.js server/utils/paymentFailedClientNotify.test.js
git commit -m "feat(comms): payment-failure SMS beside the client failure email"
```

---

## Task 9: Reschedule immediate SMS

Spec 3.13. Attaches in `server/utils/rescheduleProposal.js` `sendRescheduleEmail`, beside the existing email send. `sendRescheduleEmail` already loads the client comm-prefs and runs `shouldSendImmediate` for the email; add a parallel SMS send gated by `shouldSendImmediate({ channel: 'sms' })`, best-effort.

`sendRescheduleEmail` loads `ctx` with `client_email`, `communication_preferences`, `email_status`, `phone_status`, `client_id`. It does NOT load the client phone. Add `c.phone AS client_phone` to its SELECT. It already computes `fmtDate`, `fmtTime`, and has `updated`/`ctx` for the new date/time/location.

The function throws when `client_email` is missing today. For the SMS-only fallback path to still work (client opted out of email but has a phone), soften that to: if there is no email AND no phone, return; otherwise proceed and let each channel's `shouldSendImmediate` decide.

**Files:**
- Modify: `server/utils/rescheduleProposal.js` (`sendRescheduleEmail`, lines 173-280)

- [ ] **Step 1: Add `c.phone AS client_phone` to the `sendRescheduleEmail` SELECT**

In `server/utils/rescheduleProposal.js`, find the SELECT in `sendRescheduleEmail` (lines 174-186):

```javascript
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.event_start_time, p.event_location,
            p.event_timezone, p.guest_count, p.total_price, p.balance_due_date,
            p.autopay_enrolled,
            c.id AS client_id, c.name AS client_name, c.email AS client_email,
            c.communication_preferences, c.email_status, c.phone_status,
            sp.name AS package_name
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );
```

Replace with (adds `c.phone AS client_phone`):

```javascript
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.event_start_time, p.event_location,
            p.event_timezone, p.guest_count, p.total_price, p.balance_due_date,
            p.autopay_enrolled,
            c.id AS client_id, c.name AS client_name, c.email AS client_email,
            c.phone AS client_phone,
            c.communication_preferences, c.email_status, c.phone_status,
            sp.name AS package_name
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );
```

- [ ] **Step 2: Soften the no-email throw**

In the same function, find (lines 187-189):

```javascript
  const ctx = rows[0];
  if (!ctx) throw new Error(`rescheduleProposal: proposal ${proposalId} not found`);
  if (!ctx.client_email) throw new Error(`rescheduleProposal: proposal ${proposalId} client has no email`);
```

Replace with:

```javascript
  const ctx = rows[0];
  if (!ctx) throw new Error(`rescheduleProposal: proposal ${proposalId} not found`);
  // Phase 3: the reschedule touch is email + SMS. Only bail when BOTH channels
  // have no destination; otherwise proceed and let each channel's
  // shouldSendImmediate gate decide.
  if (!ctx.client_email && !ctx.client_phone) {
    throw new Error(`rescheduleProposal: proposal ${proposalId} client has no email and no phone`);
  }
```

- [ ] **Step 3: Guard the email send on `client_email` and add the SMS send**

In the same function, find the email-suppression check and send (lines 191-204 and the final `await sendEmail` at line 279):

The current end of the function (lines 263-280):

```javascript
  const tpl = emailTemplates.rescheduleNotificationClient({
    clientName: ctx.client_name,
    clientFirstName: firstName,
    oldDateLocal: fmtDate(old.event_date),
    oldStartTimeLocal: fmtTime(old.event_date, old.event_start_time),
    oldLocation: old.event_location || '',
    newDateLocal: fmtDate(updated.event_date || ctx.event_date),
    newStartTimeLocal: fmtTime(updated.event_date || ctx.event_date, updated.event_start_time || ctx.event_start_time),
    newLocation: updated.event_location || ctx.event_location || '',
    packageName: ctx.package_name || '',
    guestCount: ctx.guest_count,
    totalFormatted,
    balanceDueDateLocal,
    autopayEnrolled: !!ctx.autopay_enrolled,
  });

  await sendEmail({ to: ctx.client_email, ...tpl });
}
```

Now, the existing email-suppression block at lines 191-204 runs `shouldSendImmediate({ channel: 'email' })` and `return`s early when `!sendCheck.ok`. That early return would skip the SMS too. Restructure so the email check gates only the email send. Find this block (lines 191-204):

```javascript
  // Gemini Finding 3: respect suppression rules on this immediate send.
  const sendCheck = await shouldSendImmediate({
    proposal: { id: ctx.id, status: ctx.status },
    client: {
      communication_preferences: ctx.communication_preferences,
      email_status: ctx.email_status,
      phone_status: ctx.phone_status,
    },
    channel: 'email',
  });
  if (!sendCheck.ok) {
    console.log(`[rescheduleNotification] suppressed for proposal ${proposalId}: ${sendCheck.reason}`);
    return;
  }
```

Replace it with (compute the email gate but do not early-return):

```javascript
  // Gemini Finding 3: respect suppression rules on this immediate send.
  // Phase 3: the touch is email + SMS — check each channel independently and
  // gate each send, instead of an early return that would also skip the SMS.
  const clientForCheck = {
    communication_preferences: ctx.communication_preferences,
    email_status: ctx.email_status,
    phone_status: ctx.phone_status,
  };
  const emailCheck = await shouldSendImmediate({
    proposal: { id: ctx.id, status: ctx.status },
    client: clientForCheck,
    channel: 'email',
  });
  const smsCheck = await shouldSendImmediate({
    proposal: { id: ctx.id, status: ctx.status },
    client: clientForCheck,
    channel: 'sms',
  });
  if (!emailCheck.ok && !smsCheck.ok) {
    console.log(`[rescheduleNotification] both channels suppressed for proposal ${proposalId}: email=${emailCheck.reason} sms=${smsCheck.reason}`);
    return;
  }
```

Then replace the end of the function (the `const tpl = ...` block through the final `await sendEmail`) with:

```javascript
  // ── Email half ──
  if (emailCheck.ok && ctx.client_email) {
    const tpl = emailTemplates.rescheduleNotificationClient({
      clientName: ctx.client_name,
      clientFirstName: firstName,
      oldDateLocal: fmtDate(old.event_date),
      oldStartTimeLocal: fmtTime(old.event_date, old.event_start_time),
      oldLocation: old.event_location || '',
      newDateLocal: fmtDate(updated.event_date || ctx.event_date),
      newStartTimeLocal: fmtTime(updated.event_date || ctx.event_date, updated.event_start_time || ctx.event_start_time),
      newLocation: updated.event_location || ctx.event_location || '',
      packageName: ctx.package_name || '',
      guestCount: ctx.guest_count,
      totalFormatted,
      balanceDueDateLocal,
      autopayEnrolled: !!ctx.autopay_enrolled,
    });
    await sendEmail({ to: ctx.client_email, ...tpl });
  } else if (!emailCheck.ok) {
    console.log(`[rescheduleNotification] email suppressed for proposal ${proposalId}: ${emailCheck.reason}`);
  }

  // ── SMS half (Phase 3, spec 3.13) — own try/catch so an SMS failure does
  // not throw into the caller (rescheduleProposal already wraps the email
  // send best-effort post-commit; the SMS gets the same posture). ──
  if (smsCheck.ok && ctx.client_phone) {
    try {
      const { sendAndLogSms } = require('./sms');
      const smsTemplates = require('./smsTemplates');
      const body = smsTemplates.rescheduleSms({
        newDate: fmtDate(updated.event_date || ctx.event_date),
        newStartTime: fmtTime(updated.event_date || ctx.event_date, updated.event_start_time || ctx.event_start_time),
        newLocation: updated.event_location || ctx.event_location || '',
      });
      await sendAndLogSms({
        to: ctx.client_phone,
        body,
        clientId: ctx.client_id || null,
        messageType: 'reschedule',
        recipientName: ctx.client_name || null,
      });
    } catch (smsErr) {
      Sentry.captureException(smsErr, {
        tags: { component: 'rescheduleProposal', step: 'reschedule_sms' },
        extra: { proposalId },
      });
      console.error('[rescheduleNotification] SMS failed (non-blocking):', smsErr.message);
    }
  } else if (!smsCheck.ok) {
    console.log(`[rescheduleNotification] SMS suppressed for proposal ${proposalId}: ${smsCheck.reason}`);
  }
}
```

`Sentry` is already imported at the top of `rescheduleProposal.js` (line 1).

- [ ] **Step 4: Confirm the file compiles**

Run: `node -e "require('./server/utils/rescheduleProposal.js'); console.log('rescheduleProposal.js loads ok')"`
Expected: prints `rescheduleProposal.js loads ok`.

- [ ] **Step 5: Run the existing reschedule tests and fix the one that the softened guard changes**

`server/utils/rescheduleProposal.test.js` exists. Run it:

Run: `node --test server/utils/rescheduleProposal.test.js`

Most tests are unaffected — they use the test client `TEST_CLIENT_ID` (`-2`), which has both an email (`rs@example.com`) and a phone (`+15553334444`), and they assert on `emailCalls` (the test mocks `./email`). The SMS half is additive: it runs `sendAndLogSms` against the REAL `./sms` module (the test does not mock `./sms`), which in dev with no Twilio creds calls `sendSMS` → `{ sid: 'dev-skipped' }` then INSERTs an `sms_messages` row. Those tests' `emailCalls` assertions still hold.

The ONE test whose behavior the Task 9 change alters is **`rescheduleProposal > commits DB changes and swallows post-commit email failure when client has no email`** (it creates client id `-3` with `email = NULL`, `phone = '+15555555555'`). Before this task: `sendRescheduleEmail` hit the hard `no email` throw, the outer try/catch swallowed it, and no SMS was attempted. After this task: the softened guard (Step 2) does NOT throw (the client has a phone), the email half is skipped (`emailCheck.ok && ctx.client_email` is false — `client_email` is null), and the SMS half now fires for that phone. The test's two assertions (`emailCalls.length === 0`, the reanchor moved) both still pass — but the test now also writes an `sms_messages` row it never cleans up, and its name no longer describes its behavior. Update it so it remains accurate and self-cleaning. In `server/utils/rescheduleProposal.test.js`, replace that test with:

```javascript
test('rescheduleProposal > commits DB changes and sends only SMS when client has email=NULL but a phone', async () => {
  // Pre-execution Finding B4 + comms Phase 3: the email send runs in a
  // post-commit try/catch that never rethrows, so DB state always commits.
  // With email=NULL but a phone present, the Phase 3 reschedule touch sends
  // the SMS half only (the email half is skipped on the missing address).
  await pool.query(
    `INSERT INTO clients (id, name, email, phone) VALUES (-3, 'No Email', NULL, '+15555555555')
     ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_location, event_timezone, created_at, total_price)
     VALUES ($1, -3, 'deposit_paid', '2026-09-15', '18:00', 'Venue', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID]
  );
  await pool.query(
    `INSERT INTO scheduled_messages
     (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', -3, 'email', '2026-08-08T15:00:00.000Z', 'pending')`,
    [TEST_PROPOSAL_ID]
  );
  // Stub the SMS sender so the test does not depend on Twilio and so we can
  // assert the SMS half fired.
  const { __setSmsDeps, _realSendSMS } = require('./sms');
  let smsCalls = 0;
  __setSmsDeps({ sendSMS: async () => { smsCalls += 1; return { sid: 'stub' }; } });

  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'X' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'Y' };
  // Resolves, never rejects.
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  // Email half skipped (no address) — the email mock must not have been hit.
  assert.strictEqual(emailCalls.length, 0);
  // SMS half fired exactly once.
  assert.strictEqual(smsCalls, 1, 'the reschedule SMS should fire when only a phone is present');

  // The DB-side reanchor still ran: pending row → T-7 of the new event_date.
  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type = 'event_week_reminder'`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(new Date(rows[0].scheduled_for).toISOString(), '2026-09-08T15:00:00.000Z');

  __setSmsDeps({ sendSMS: _realSendSMS });
  await pool.query('DELETE FROM sms_messages WHERE client_id = -3');
  await pool.query('DELETE FROM clients WHERE id = -3');
});
```

Re-run `node --test server/utils/rescheduleProposal.test.js` and confirm PASS. (The other tests use client `-2`, which has both an email and a phone; after this task each `rescheduleProposal` call also sends a `dev-skipped` SMS and writes one `sms_messages` row. `sms_messages.client_id` is `REFERENCES clients(id) ON DELETE SET NULL`, so `afterEach`'s `DELETE FROM clients WHERE id = -2` still succeeds — the leftover rows just have `client_id` nulled. That residue is cosmetic and does not fail any assertion; leaving it is acceptable. Do NOT add SMS mocking to those tests purely to suppress it — the change would be churn for no behavior gain.)

- [ ] **Step 6: Commit**

```bash
git add server/utils/rescheduleProposal.js server/utils/rescheduleProposal.test.js
git commit -m "feat(comms): reschedule SMS beside the reschedule email"
```

---

## Task 10: Event-eve SMS — full SMS-only build

Spec 3.12. A full new touch — SMS only. `message_type` `event_eve`. Timing is bespoke: T-24h from the event START time in event TZ, NOT the 10:00-local convention of `computeScheduledFor`. Cooldown-exempt (priority `1`, `cooldownExempt: true`). The row is registered with `offsetFromEventDate: null` so the generic reschedule cascade leaves it alone — but a reschedule MUST re-anchor it, so the touch follows the `new_year_hello` precedent: a per-type recompute helper. For Phase 3 scope the recompute hook is NOT wired into `reanchorPendingMessages` (that is dispatcher-core territory the contract assigns away from Phase 3); instead `scheduleEventEve` is idempotent and re-runnable, and `schedulePreEventReminders` is already re-invoked by the reschedule cascade (`rescheduleProposalInTx` calls `schedulePreEventReminders` post-reanchor). To make a reschedule actually move the event-eve row, `scheduleEventEve` deletes any stale pending `event_eve` row and re-inserts at the freshly computed instant.

The handler resolves the assigned bartender (name + phone) from `shift_requests` joined to `contractor_profiles`, the setup minutes from `proposals.setup_minutes_before` / the package default, and the event-local start time.

**Files:**
- Create: `server/utils/eventEveSms.js`
- Create: `server/utils/eventEveSms.test.js`
- Modify: `server/utils/preEventScheduling.js` (call `scheduleEventEve` from `schedulePreEventReminders`)
- Modify: `server/index.js` (handler bootstrap)

- [ ] **Step 1: Write the failing test**

Create `server/utils/eventEveSms.test.js`:

```javascript
require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { registerEventEveHandler, scheduleEventEve, computeEventEveSendAt } = require('./eventEveSms');
const { getHandlerMeta, _clearHandlersForTest, dispatchPending } = require('./scheduledMessageDispatcher');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ('EventEve Test', 'eventeve-test@example.com', '3125550180') RETURNING id"
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, event_location, status, event_type, event_timezone, setup_minutes_before)
     VALUES ($1, CURRENT_DATE + INTERVAL '40 days', '18:00', '123 Main St', 'deposit_paid', 'birthday-party', 'America/Chicago', 60)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type=$1 AND entity_id=$2', ['proposal', proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('registerEventEveHandler > registers event_eve operational with a null offset', () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  const meta = getHandlerMeta('event_eve');
  assert.ok(meta);
  assert.strictEqual(meta.category, 'operational');
  // null offset so the generic reschedule cascade leaves the bespoke timing alone.
  assert.strictEqual(meta.offsetFromEventDate, null);
});

test('computeEventEveSendAt > returns the event start instant minus 24h in event TZ', () => {
  // Chicago is UTC-5 in summer (CDT). Event date + 18:00 local.
  const sendAt = computeEventEveSendAt({
    event_date: '2026-08-15',
    event_start_time: '18:00',
    event_timezone: 'America/Chicago',
  });
  // 2026-08-15 18:00 CDT == 2026-08-15 23:00 UTC. Minus 24h == 2026-08-14 23:00 UTC.
  assert.strictEqual(sendAt.toISOString(), '2026-08-14T23:00:00.000Z');
});

test('scheduleEventEve > inserts one event_eve sms row', async () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  await scheduleEventEve(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].message_type, 'event_eve');
  assert.strictEqual(rows[0].channel, 'sms');
});

test('scheduleEventEve > re-run deletes the stale pending row and re-inserts (reschedule path)', async () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  await scheduleEventEve(proposalId);
  const before = await pool.query(
    "SELECT scheduled_for FROM scheduled_messages WHERE entity_id=$1 AND message_type='event_eve'",
    [proposalId]
  );
  // Move the event a week later, then re-run.
  await pool.query(
    "UPDATE proposals SET event_date = event_date + INTERVAL '7 days' WHERE id = $1",
    [proposalId]
  );
  await scheduleEventEve(proposalId);
  const after = await pool.query(
    "SELECT scheduled_for FROM scheduled_messages WHERE entity_id=$1 AND message_type='event_eve' AND status='pending'",
    [proposalId]
  );
  assert.strictEqual(after.rows.length, 1, 'still exactly one pending row');
  assert.notStrictEqual(
    new Date(before.rows[0].scheduled_for).getTime(),
    new Date(after.rows[0].scheduled_for).getTime(),
    'scheduled_for should have moved'
  );
});

test('event_eve handler > sends an SMS even with no bartender assigned', async () => {
  _clearHandlersForTest();
  registerEventEveHandler();
  const { __setSmsDeps } = require('./sms');
  let body = null;
  __setSmsDeps({ sendSMS: async (args) => { body = args.body; return { sid: 'stub' }; } });
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'event_eve', 'client', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [proposalId, clientId]
  );
  await dispatchPending();
  assert.ok(body, 'an SMS body should have been produced');
  assert.match(body, /tomorrow/);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id=$1 AND message_type='event_eve'",
    [proposalId]
  );
  assert.strictEqual(rows[0].status, 'sent');
  __setSmsDeps({ sendSMS: require('./sms')._realSendSMS });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/eventEveSms.test.js`
Expected: FAIL — `Cannot find module './eventEveSms'`.

- [ ] **Step 3: Create `eventEveSms.js`**

Create `server/utils/eventEveSms.js`:

```javascript
/**
 * Event-eve SMS — a full SMS-only touch (spec 3.12). T-24h from the event
 * START time, in the event timezone. This timing is NOT the 10:00-event-local
 * convention of computeScheduledFor, so the touch registers with
 * offsetFromEventDate: null (the generic reschedule cascade skips it) and
 * computes its own send instant via computeEventEveSendAt.
 *
 * Cooldown-exempt: priority 1, cooldownExempt true (inert until Phase 4b — the
 * event-eve SMS must fire on its exact day regardless of the daily-cooldown
 * rule, per spec 7.4).
 *
 * Reschedule: because the row has a null offset, reanchorPendingMessages leaves
 * it alone. scheduleEventEve is therefore written to DELETE any stale pending
 * event_eve row and re-INSERT at the recomputed instant; rescheduleProposalInTx
 * already re-invokes schedulePreEventReminders after its reanchor pass, and
 * schedulePreEventReminders calls scheduleEventEve — so a reschedule does move
 * this row.
 */
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
const { resolveEventTimezone } = require('./eventTimezone');
const { effectiveSetupMinutes } = require('./setupTime');

/**
 * Parse an event-local wall-clock start time string ('18:00' or '6:00 PM')
 * into { hour, minute } 24-hour numbers. Returns { hour: 12, minute: 0 } as a
 * tame fallback when unparseable (noon — never a midnight day-shift surprise).
 */
function parseStartTime(timeStr) {
  if (timeStr === null || timeStr === undefined) return { hour: 12, minute: 0 };
  const cleaned = String(timeStr).trim().toUpperCase();
  const m = cleaned.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/);
  if (!m) return { hour: 12, minute: 0 };
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3];
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return { hour: 12, minute: 0 };
  if (ampm) {
    if (h < 1 || h > 12) return { hour: 12, minute: 0 };
    if (ampm === 'PM' && h < 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
  } else if (h > 23) {
    return { hour: 12, minute: 0 };
  }
  return { hour: h, minute: min };
}

/**
 * The UTC instant the event-eve SMS should send: the event start moment in the
 * event timezone, minus 24 hours.
 *
 * event_start_time is wall-clock event-local time; we resolve "that local time
 * on the event date" to UTC by reading the zone's actual offset for that date
 * (DST-correct because we ask Intl about the specific day, not today).
 *
 * @param {{ event_date: string|Date, event_start_time: string, event_timezone?: string }} proposal
 * @returns {Date} UTC instant
 */
function computeEventEveSendAt(proposal) {
  const tz = resolveEventTimezone(proposal);
  const ymd = (proposal.event_date instanceof Date)
    ? `${proposal.event_date.getFullYear()}-${String(proposal.event_date.getMonth() + 1).padStart(2, '0')}-${String(proposal.event_date.getDate()).padStart(2, '0')}`
    : String(proposal.event_date).slice(0, 10);
  const [y, mo, d] = ymd.split('-').map(Number);
  const { hour, minute } = parseStartTime(proposal.event_start_time);

  // Determine the tz offset (in minutes) for noon UTC on the event date.
  const noonUtc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, timeZoneName: 'shortOffset', hour: '2-digit', hour12: false,
  });
  const offsetPart = fmt.formatToParts(noonUtc).find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-5"
  const match = /GMT([+-]?\d{1,2})(?::(\d{2}))?/.exec(offsetPart);
  const tzHours = match ? Number(match[1]) : 0;
  const tzMinutes = match && match[2] ? Number(match[2]) * (tzHours >= 0 ? 1 : -1) : 0;

  // event-local start → UTC: subtract the zone offset.
  const startUtcMs = Date.UTC(y, mo - 1, d, hour - tzHours, minute - tzMinutes, 0);
  // T-24h.
  return new Date(startUtcMs - 24 * 3600 * 1000);
}

/**
 * Format the event-local start time as "6:00 PM CDT" for the SMS body.
 */
function formatStartTimeLocal(proposal) {
  const tz = resolveEventTimezone(proposal);
  const { hour, minute } = parseStartTime(proposal.event_start_time);
  const hour12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const time12 = `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`;
  let tzAbbrev = '';
  try {
    const ymd = String(proposal.event_date).slice(0, 10);
    const refMs = Date.parse(`${ymd}T12:00:00Z`);
    if (Number.isFinite(refMs)) {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(new Date(refMs));
      const tzPart = parts.find((p) => p.type === 'timeZoneName');
      if (tzPart && tzPart.value) tzAbbrev = ` ${tzPart.value}`;
    }
  } catch (_e) { /* leave empty */ }
  return `${time12}${tzAbbrev}`;
}

/**
 * Resolve the assigned bartender for the proposal's event: the first approved
 * shift_requests row joined to contractor_profiles. Returns
 * { name, phone } or { name: null, phone: null } when none is assigned.
 *
 * Schema (verified): no shift_assignments table — an approved shift_requests
 * row IS the assignment. shifts.proposal_id links a shift to its proposal.
 * Staff phone lives on contractor_profiles.phone (users has no phone column).
 */
async function resolveBartender(proposalId) {
  const { rows } = await pool.query(
    `SELECT cp.preferred_name AS name, cp.phone AS phone
       FROM shift_requests sr
       JOIN shifts s ON s.id = sr.shift_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE s.proposal_id = $1
        AND sr.status = 'approved'
      ORDER BY sr.updated_at ASC
      LIMIT 1`,
    [proposalId]
  );
  if (rows.length === 0) return { name: null, phone: null };
  return { name: rows[0].name || null, phone: rows[0].phone || null };
}

/**
 * Handler: event_eve. Renders the event-eve SMS and sends via sendAndLogSms.
 * Throws on a hard problem (no client / no phone / archived / SMS opted out)
 * so the dispatcher records 'failed'.
 */
async function handleEventEve({ entity }) {
  const proposalId = entity.id;
  const { rows } = await pool.query(
    `SELECT p.id, p.status, p.event_date, p.event_start_time, p.event_location,
            p.event_timezone, p.setup_minutes_before, p.pricing_snapshot,
            c.id AS client_id, c.name AS client_name, c.phone AS client_phone,
            c.communication_preferences AS comm_prefs, c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`event_eve: proposal ${proposalId} not found`);
  if (ctx.status === 'archived') throw new Error('event_eve: proposal archived');
  if (!ctx.client_phone) throw new Error('event_eve: client has no phone');
  if (ctx.phone_status === 'bad') throw new Error('event_eve: client phone_status is bad');
  const prefs = ctx.comm_prefs || {};
  if (prefs.sms_enabled === false) throw new Error('event_eve: sms_enabled is false');

  const bartender = await resolveBartender(proposalId);
  const setupMinutes = effectiveSetupMinutes(
    { setup_minutes_before: ctx.setup_minutes_before, pricing_snapshot: ctx.pricing_snapshot },
    null
  );
  const body = smsTemplates.eventEveSms({
    startTime: formatStartTimeLocal(ctx),
    location: ctx.event_location,
    bartenderName: bartender.name,
    bartenderPhone: bartender.phone,
    setupMinutes,
  });
  await sendAndLogSms({
    to: ctx.client_phone,
    body,
    clientId: ctx.client_id,
    messageType: 'event_eve',
    recipientName: ctx.client_name || null,
  });
}

function registerEventEveHandler() {
  registerHandler('event_eve', handleEventEve, {
    // null offset: bespoke T-24h-from-start timing, not the 10:00-local
    // convention. The generic reschedule cascade skips null-offset rows;
    // scheduleEventEve handles re-anchoring on reschedule itself.
    offsetFromEventDate: null,
    anchor: 'event_date',
    category: 'operational',
    priority: 1,
    cooldownExempt: true,
  });
}

/**
 * Insert (or, on reschedule, re-insert) the event_eve scheduled_messages row.
 * Idempotent for the steady-state case via scheduleMessage's ON CONFLICT, and
 * reschedule-correct because it first DELETEs any stale pending event_eve row
 * then inserts at the freshly computed instant.
 *
 * Skips archived proposals, proposals with no client / event_date / start time,
 * and proposals whose computed send instant is already in the past (a
 * <24h-out reschedule — the event-eve window has closed; admin handles it).
 *
 * @param {number|string} proposalId
 * @param {{ query: Function }} [executor] - pg client or pool; defaults to pool.
 *   Passed through so a reschedule-cascade caller's transaction is joined.
 */
async function scheduleEventEve(proposalId, executor) {
  const exec = executor || pool;
  const { rows } = await exec.query(
    `SELECT id, client_id, status, event_date, event_start_time, event_timezone
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = rows[0];
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date || !proposal.event_start_time) return;

  const sendAt = computeEventEveSendAt(proposal);
  if (!(sendAt instanceof Date) || Number.isNaN(sendAt.getTime())) return;
  if (sendAt.getTime() <= Date.now()) {
    // Event is <24h out (e.g. a last-minute reschedule). The event-eve window
    // has closed; do not schedule a row that would fire immediately/late.
    // Clear any stale pending row so it does not fire at the wrong time.
    await exec.query(
      `DELETE FROM scheduled_messages
        WHERE entity_type = 'proposal' AND entity_id = $1
          AND message_type = 'event_eve' AND status = 'pending'`,
      [proposalId]
    );
    return;
  }

  // Reschedule-correctness: drop any stale pending row, then insert fresh.
  // event_eve has a null offset so reanchorPendingMessages cannot move it.
  await exec.query(
    `DELETE FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type = 'event_eve' AND status = 'pending'`,
    [proposalId]
  );
  await exec.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'event_eve', 'client', $2, 'sms', $3)
     ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
       WHERE status = 'pending'
     DO NOTHING`,
    [Number(proposalId), proposal.client_id, sendAt]
  );
}

module.exports = {
  registerEventEveHandler,
  scheduleEventEve,
  computeEventEveSendAt,
  formatStartTimeLocal,
  resolveBartender,
};
```

- [ ] **Step 4: Schedule event-eve from `schedulePreEventReminders`**

In `server/utils/preEventScheduling.js`, immediately AFTER the drink-plan-nudge `try/catch` block you added in Task 6 Step 4 (and before the function's final `}`), add:

```javascript
  // Comms Phase 3: event-eve SMS, T-24h from event start (bespoke timing).
  // Delegated to eventEveSms.js. scheduleEventEve is reschedule-correct (it
  // deletes any stale pending row and re-inserts), so re-invoking it from the
  // reschedule cascade moves the touch even though its null offset means
  // reanchorPendingMessages skips it.
  try {
    const { scheduleEventEve } = require('./eventEveSms');
    await scheduleEventEve(proposalId, exec);
  } catch (eveErr) {
    console.warn('[schedulePreEventReminders] event-eve scheduling failed (non-fatal):', eveErr.message);
  }
```

- [ ] **Step 5: Register the event-eve handler at boot**

In `server/index.js`, immediately AFTER the `require('./utils/balanceSmsHandlers').registerBalanceSmsHandlers();` line you added in Task 7 Step 5, add:

```javascript
      require('./utils/eventEveSms').registerEventEveHandler();
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test server/utils/eventEveSms.test.js`
Expected: PASS — all 6 tests pass.

- [ ] **Step 7: Re-run the pre-event scheduling tests and bump the three assertions Task 6 Step 8 already touched**

Run: `node --test server/utils/preEventScheduling.test.js`
Expected: FAIL on the same three tests Task 6 Step 8 edited — `schedulePreEventReminders` now also inserts an `event_eve` row, so each row count Task 6 set goes up by one. In `server/utils/preEventScheduling.test.js`, update those three assertions again:

(a) `schedulePreEventReminders > schedules event_week_reminder (T-7) ...` — change `assert.strictEqual(rows.length, 3)` to `4`, and extend the `message_type` list assertion to include `event_eve`:

```javascript
  assert.strictEqual(rows.length, 4);
```
```javascript
  assert.deepStrictEqual(
    rows.map((r) => r.message_type).sort(),
    ['drink_plan_nudge', 'drink_plan_nudge_sms', 'event_eve', 'event_week_reminder']
  );
```

(b) `schedulePreEventReminders > also schedules long_lead_t30_recap ...` — extend the exact list to 5 elements:

```javascript
  assert.deepStrictEqual(rows.map((r) => r.message_type).sort(), [
    'drink_plan_nudge', 'drink_plan_nudge_sms', 'event_eve',
    'event_week_reminder', 'long_lead_t30_recap',
  ]);
```

(c) `schedulePreEventReminders > is idempotent ...` — change `assert.strictEqual(rows[0].n, 3)` to `4`.

The `is idempotent` test still holds across two calls — `scheduleEventEve` deletes any stale pending `event_eve` row then re-inserts, and `scheduleDrinkPlanNudge` / the event-week insert are `ON CONFLICT DO NOTHING` idempotent, so the count is stable at 4. The `skips entirely when proposal is archived` test still asserts 0 (all three helpers early-return on archived). Re-run `node --test server/utils/preEventScheduling.test.js` and confirm PASS.

Note: the `preEventScheduling.test.js` fixtures insert proposals with `event_date` well in the future (`2026-08-15` short-lead, `2026-12-01` long-lead) and `event_start_time = '18:00'`, so `computeEventEveSendAt` yields a future instant and `scheduleEventEve` inserts the `event_eve` row. (`scheduleEventEve` early-returns without a row only when the computed send instant is already past — not the case for these fixtures.) If real wall-clock time ever advances past those fixture dates, refresh them to keep the events in the future; that is a pre-existing property of the file, not introduced here.

- [ ] **Step 8: Commit**

```bash
git add server/utils/eventEveSms.js server/utils/eventEveSms.test.js server/utils/preEventScheduling.js server/utils/preEventScheduling.test.js server/index.js
git commit -m "feat(comms): event-eve SMS, scheduled T-24h from event start"
```

---

## Task 11: Documentation updates

Per CLAUDE.md "Mandatory Documentation Updates": new util files go in the `README.md` folder tree and get a mention in `ARCHITECTURE.md`; the new feature goes in `README.md` Key Features and the relevant `ARCHITECTURE.md` section. No new env var, no new npm script, no new route file.

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Add the new util files to the `README.md` folder tree**

Open `README.md`, find the `server/utils/` listing in the folder-structure tree. Add entries (alphabetically, matching the existing style) for the five new files:

```
balanceSmsHandlers.js  — non-autopay balance reminder SMS handlers (due-today, late t1/t3)
drinkPlanNudge.js      — drink-plan / Potion Planner nudge: email + SMS touch and scheduling
dripSmsHandlers.js     — unsigned-proposal drip SMS handlers (touches 1, 3, 5-sms)
eventEveSms.js         — event-eve SMS touch (T-24h from event start) and timing helper
smsTemplates.js        — client-facing automated SMS body templates
```

- [ ] **Step 2: Add the SMS touches to `README.md` Key Features**

In the `README.md` Key Features section, find the communications / automation entry. Add a line:

```
- Client-facing automated SMS: initial-proposal, sign+pay confirmation, unsigned-proposal drip (touches 1/3/5), drink-plan nudge, balance due-today and late-balance reminders, payment-failure alert, event-eve reminder, and reschedule notification — sent via Twilio and logged to sms_messages.
```

- [ ] **Step 3: Mention the new utils and SMS touches in `ARCHITECTURE.md`**

Open `ARCHITECTURE.md`. In the section that describes the scheduled-message / communication system (the same section that covers `scheduledMessageDispatcher.js`, `marketingHandlers.js`, `preEventHandlers.js`), add a paragraph:

```
Comms Phase 3 adds the client-facing SMS layer. `sms.js` gains `sendAndLogSms`,
the single send-and-log primitive for all automated SMS. `smsTemplates.js`
holds the SMS body copy (mirrors `emailTemplates.js`). Scheduled SMS touches
register dispatcher handlers like their email siblings: `dripSmsHandlers.js`
(drip touches 1/3/5-sms), `drinkPlanNudge.js` (the drink-plan nudge, email + SMS,
T-21), `balanceSmsHandlers.js` (non-autopay balance due-today / late t1 / late
t3 SMS), and `eventEveSms.js` (the event-eve SMS, T-24h from event start, with
bespoke wall-clock timing). Immediate SMS sends (initial proposal, sign+pay
confirmation, payment failure, reschedule) are best-effort hooks beside the
existing email send, gated by `shouldSendImmediate({ channel: 'sms' })`.
```

If `ARCHITECTURE.md` has a Database Schema section that lists `sms_messages` columns, note that `message_type` is now `TEXT` (was `VARCHAR(20)` with a 4-value CHECK).

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(comms): document Phase 3 client SMS utils and touches"
```

---

## Task 12: Full-suite verification

- [ ] **Step 1: Run the full server test suite**

Run: `node --test server/`
Expected: PASS — all test files green. Pay attention to: `sms.test.js`, `smsTemplates.test.js`, `dripSmsHandlers.test.js`, `drinkPlanNudge.test.js`, `balanceSmsHandlers.test.js`, `eventEveSms.test.js`, `paymentFailedClientNotify.test.js`, `sendProposalSentEmail.test.js`, `marketingHandlers.test.js`, `preEventScheduling.test.js`, `scheduledMessageDispatcher.test.js`, `crud.test.js`. If any test fails, fix the cause before proceeding (do not skip).

- [ ] **Step 2: Run the file-size check**

Run: `npm run check:filesize`
Expected: no RED (over the 1000-line hard cap) for any file this plan touched. `stripe.js` was already over the cap before this plan — confirm the check does not BLOCK because the plan's `stripe.js` edits are small additions inside an already-over-cap file. CLAUDE.md's ratchet only blocks a commit that makes an over-cap file *longer than it is at HEAD*; the Task 4 and Task 7 `stripe.js` edits add roughly 35 lines. If `check:filesize` reports `stripe.js` as a blocker, the commit in those tasks would have failed the pre-commit hook — in that case the over-cap addition must be extracted: move `scheduleBalanceReminders` and/or `sendPaymentNotifications` to a new `server/utils/` file so `stripe.js` stays flat or shrinks. Note this as a risk; the `stripe.js` additions are small and `stripe.js` is large, so plan to extract `scheduleBalanceReminders` into `server/utils/balanceReminderScheduling.js` if the hook blocks. (The new util files created by this plan are all well under the 700-line soft cap.)

- [ ] **Step 3: Confirm the server boots with all handlers registered**

Run: `node -e "require('dotenv').config(); ['./server/utils/preEventHandlers','./server/utils/marketingHandlers','./server/utils/dripSmsHandlers','./server/utils/drinkPlanNudge','./server/utils/balanceSmsHandlers','./server/utils/eventEveSms'].forEach(m=>require(m)); const d=require('./server/utils/scheduledMessageDispatcher'); require('./server/utils/preEventHandlers').registerAll(); require('./server/utils/marketingHandlers').registerMarketingHandlers(); require('./server/utils/dripSmsHandlers').registerDripSmsHandlers(); require('./server/utils/drinkPlanNudge').registerDrinkPlanNudgeHandlers(); require('./server/utils/balanceSmsHandlers').registerBalanceSmsHandlers(); require('./server/utils/eventEveSms').registerEventEveHandler(); ['drip_touch_1','drip_touch_3','drip_touch_5_sms','drink_plan_nudge','drink_plan_nudge_sms','balance_due_today_sms','balance_late_t1_sms','balance_late_t3_sms','event_eve'].forEach(t=>{ if(!d.getHandlerMeta(t)) throw new Error('missing handler: '+t); }); console.log('all Phase 3 handlers registered'); process.exit(0)"`
Expected: prints `all Phase 3 handlers registered`. (This proves every new `message_type` has a registered handler — a `scheduled_messages` row with no handler would otherwise dispatch to `failed`.)

- [ ] **Step 4: Final commit (only if Step 2 forced a file-size extraction or Step 1 forced a fix)**

If Steps 1-3 required a code change, commit it:

```bash
git add <changed files>
git commit -m "fix(comms): Phase 3 verification fixes"
```

If no change was needed, skip this step. Phase 3 is complete.

---

## Manual verification checklist (report to the user)

These touches have no automated webhook/route harness; the execution agent should report them to the user as manual dev-test items:

1. **Sign+pay SMS (Task 4):** complete a test sign+pay on a proposal whose client has a phone and `sms_enabled: true` → expect an `sms_messages` row, `message_type = 'sign_pay_confirmation'`, `direction = 'outbound'`.
2. **Reschedule SMS (Task 9):** PATCH a post-sign+pay proposal's `event_date` for a client with a phone → expect an `sms_messages` row, `message_type = 'reschedule'`.
3. **Initial-proposal SMS (Task 3):** move a proposal to `sent` for a client with a phone → expect `message_type = 'initial_proposal'`.

The scheduled touches (drip SMS, drink-plan nudge, balance SMS, event-eve) are fully covered by the dispatcher integration tests in Tasks 5-7 and 10.

---

## Self-review notes (completed by plan author)

**Spec coverage** — every contract §9 Phase 3 row maps to a task: initial proposal → Task 3; sign+pay → Task 4; drip 1/3/5 → Task 5; drink-plan nudge → Task 6; balance due-today + late → Task 7; payment-failure → Task 8; reschedule → Task 9; event-eve → Task 10; SMS rails (`sendAndLogSms`, `smsTemplates.js`, the scheduled-handler pattern) → Tasks 1-2; drip-suppression query update → Task 5 Step 5. `priority` / `cooldownExempt` registered on every new scheduled handler per §5; the rule itself is left for Phase 4b. `multiChannel: true` is registered on every new handler that is one half of an email+SMS pair (`drip_touch_5_sms`, `drink_plan_nudge`, `drink_plan_nudge_sms`, `balance_due_today_sms`, `balance_late_t1_sms`, `balance_late_t3_sms`) so Phase 4b's delivery-failure logic does not channel-substitute it (spec 7.3); single-channel scheduled touches (`drip_touch_1`, `drip_touch_3`, `event_eve`) omit it. Like `priority`, `multiChannel` is inert until Phase 4b defines it.

**Placeholder scan** — every code step contains complete code; every command has an expected output. No "TBD"/"add validation"/"similar to Task N".

**Type consistency** — `sendAndLogSms({ to, body, clientId, messageType, recipientName })` is the signature in Task 1 and is called with exactly those keys in Tasks 3-10. `smsTemplates` function names match between Task 2's module and every caller. `scheduleDrinkPlanNudge(proposalId, executor)` and `scheduleEventEve(proposalId, executor)` share the `executor`-defaulting shape of `schedulePreEventReminders`. `registerHandler` options use the existing `offsetFromEventDate` / `anchor` / `category` keys plus the inert `priority` / `cooldownExempt` / `multiChannel` (all three ignored by today's `registerHandler`, activated by Phase 4b).

**Post-review revisions (applied after the Phase 3 plan review).** The reviewer's blockers/warnings are folded in:
- Task 6 — drink-plan nudge suppression no longer treats a `drink_plans` row as "submitted" merely because it exists. `drink_plans.selections` is `JSONB DEFAULT '{}'` and `createDrinkPlan` inserts an empty-`{}` row at conversion, so "submitted" is now `selections IS NOT NULL AND selections::text <> '{}'` (computed in `loadNudgeContext`'s SQL as `dp_submitted`). A new handler test inserts a default-empty `drink_plans` row and asserts the nudge is NOT suppressed.
- Task 4 Step 2 — the `stripe.js` insertion anchor now includes the preceding `await sendEmail(...)` line, making the 3-line sequence unique (the bare `}` + `} else {` pair also matched the `if (paymentType === 'deposit')` close).
- Task 3 — `public.js` is now actually wired: the `clientResult` upsert `RETURNING` is widened and the object handed to `sendProposalSentEmail` carries `client_phone` / `client_id` / suppression fields, so the website-origin SMS fires instead of silently no-op'ing. `lifecycle.js` / `crud.js` SELECTs gain the same columns (`lifecycle.js` also gains `p.status`). The wrong "no phone → `bad_contact`" rationale is corrected: `shouldSendImmediate` gates on comm-prefs only; the phoneless safety net is `sendAndLogSms`'s skip.
- Tasks 6 & 10 — the `preEventScheduling.test.js` breakage is now spelled out assertion-by-assertion (the `rows.length` count, the `ORDER BY message_type` `rows[0]` shift, the exact `message_type` lists, the idempotency absolute count); Task 6 sets the numbers to 3/4 and Task 10 bumps them to 4/5.
- Task 9 — the existing `rescheduleProposal.test.js` is analyzed, not assumed additive: the `email=NULL`-with-a-phone test changes behavior under the softened guard (it now sends the SMS half) and is rewritten to assert that and self-clean.
- Line-number citations tightened against live code on branch `comms`.

**Post-review revisions (applied after the Gemini second-opinion review).** One cross-plan blocker — the Phase 3 side:
- Tasks 5/6/7 — every new dispatcher handler that is one half of an email+SMS pair now registers `multiChannel: true` in its `registerHandler` options object (alongside the `priority` already there): `drip_touch_5_sms` (Task 5), `drink_plan_nudge` + `drink_plan_nudge_sms` (Task 6), `balance_due_today_sms` + `balance_late_t1_sms` + `balance_late_t3_sms` (Task 7). Phase 4b's delivery-failure channel-substitution logic reads this flag and skips substitution for any multi-channel row — per spec 7.3 each channel's row is independent, so a dead channel suppresses its own row while the other channel still fires. Without the flag, e.g. a `drink_plan_nudge` email row for a bad-email client would be substituted to SMS on top of the real `drink_plan_nudge_sms` row and the client would get two SMS. `multiChannel` is a Phase-4b-defined `registerHandler` option, inert until Phase 4b lands (today's `registerHandler` silently ignores unknown option keys, exactly as for `priority`); the email handlers `balance_due_today` / `balance_late_t1` / `balance_late_t3` / `drip_touch_5_email` get `multiChannel` during Phase 4b's own retrofit task, out of Phase 3 scope. Single-channel touches (`drip_touch_1`, `drip_touch_3`, `event_eve`, and the email-only autopay/non-autopay T-3 reminders) deliberately omit it — they remain substitutable. The priority-ladder reference table gained a `multiChannel` column; the Phase 3 handler-metadata tests are unchanged (verified against `scheduledMessageDispatcher.js` on branch `comms`: `getHandlerMeta` returns only `offsetFromEventDate` / `anchor` / `category` today, so those tests assert no `priority` and need no `multiChannel` assertion — Phase 4b adds both the metadata field and its tests).
