# Phase 4b — Notification Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the three cross-cutting notification-infrastructure pieces of the automated-communication system: dispatch-time overlap prevention (one message per channel per client per day with a priority ladder), delivery-failure fallback (mark contacts bad on bounce/SMS-failure, substitute channels, suspend automation when both channels die), and a multi-admin notification model (per-category subscriptions read from `users.notification_preferences`, a central fan-out helper, and a settings UI).

**Architecture:** Three independently-committable task groups. Group 1 retrofits a `priority` integer and `cooldownExempt` flag onto the existing handler registry, then adds an overlap pass to `scheduledMessageDispatcher.dispatchPending` that defers (status `'deferred'`) the lower-priority loser when two touches collide on the same client+channel+day. Group 2 extends the existing Resend webhook (`/api/email-marketing/webhook/resend`) and a new Twilio-status writer to flip `clients.email_status`/`phone_status` to `'bad'`, adds a channel-substitution step to the dispatcher, and a "both channels bad" suspension. Group 3 adds a `server/utils/adminNotifications.js` helper with a category fan-out query (joining `contractor_profiles` for phone), a per-user notification-preferences API on `/api/me`, a settings-page tab to toggle them, and migrates every scattered `ADMIN_EMAIL`/`ADMIN_PHONE` call site onto the helper.

**Tech Stack:** Node 18 / Express 4, raw SQL via `pg`, React 18 (CRA) / React Router 6, `node:test` for server unit tests, Resend (email), Twilio (SMS), Sentry.

---

## Context for the implementing agent

You have **zero prior context**. Read this section before starting.

### What already exists (do not rebuild)

- **`scheduled_messages` table** — columns `id, entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status, error_message, created_at`. `status` accepts `pending | sent | failed | suppressed | deferred`. The `'deferred'` status is already a valid CHECK value but **nothing writes it yet** — Group 1's overlap rule is the first writer. Schema lives in `server/db/schema.sql` around line 2271.
- **`server/utils/scheduledMessageDispatcher.js`** — `registerHandler(messageType, handlerFn, options)`, `getHandlerMeta(messageType)`, `dispatchPending()`, `checkSuppression()`, `dispatchRow()`. `options` today handles `offsetFromEventDate`, `anchor`, `category`. **Unknown option keys are silently ignored** — Phase 3 and Phase 4a already register handlers with a `priority` key that is currently inert; Group 1 makes it live.
- **14 registered email handlers** across three files: 5 balance handlers in `scheduledMessageDispatcher.js` itself, `event_week_reminder` + `long_lead_t30_recap` in `preEventHandlers.js`, and 7 marketing/`review_request` handlers in `marketingHandlers.js`.
- **`server/utils/messageScheduling.js`** — `scheduleMessage(...)`, idempotent insert.
- **`server/utils/messageSuppression.js`** — `shouldSendImmediate({ proposal, client, channel })`, pure (no I/O).
- **`clients` table** — already has `communication_preferences` JSONB (`{sms_enabled, email_enabled, marketing_enabled}`), `email_status TEXT DEFAULT 'ok'` (CHECK `ok|bad`), `phone_status TEXT DEFAULT 'ok'` (CHECK `ok|bad`). Schema around line 2208.
- **`users` table** — already has `notification_preferences` JSONB with 11 category keys all defaulting `true` (schema around line 2239), and `communication_preferences` JSONB. `users` has **NO `phone` column**. `role` is one of `staff | admin | manager`.
- **`contractor_profiles` table** — `user_id` (UNIQUE FK to `users.id`), `phone VARCHAR(50)`, `preferred_name VARCHAR(255)`. An admin/manager may have **no `contractor_profiles` row at all** — treat that admin as email-only.
- **Resend webhook** — `POST /api/email-marketing/webhook/resend`, handler in `server/routes/emailMarketingWebhook.js`. Already verifies the svix signature, logs to `email_webhook_events`, and on `email.bounced`/`email.complained` suppresses the **marketing-side** `email_leads` row. It does **not** touch `clients.email_status`.
- **`email_webhook_events` table** — `id, resend_id, event_type, payload JSONB, processed, created_at`. Exists. Group 2 uses it as the bounce-event log.
- **`server/utils/sms.js`** — `sendSMS({ to, body })` (bare Twilio send, returns the Twilio message object). `normalizePhone(phone)` (E.164, `null` on unparseable). Phase 3 adds `sendAndLogSms(...)` to this file — see "Phase 3 dependency" below.
- **`server/utils/urls.js`** — exports `PUBLIC_SITE_URL`, `ADMIN_URL`, `STAFF_URL`, `API_URL`.
- **`server/utils/email.js`** — `sendEmail({ to, subject, html, text, replyTo, ... })`.
- **`server/middleware/auth.js`** — `auth`, `adminOnly`, `requireAdminOrManager`. `req.user` carries `{ id, email, role, onboarding_status, can_hire, can_staff, pre_hired }`.

### Phase 3 dependency (do NOT build, only consume)

Phase 3 adds **`sendAndLogSms({ to, body, clientId = null, messageType, recipientName = null }) => { sid, status }`** to `server/utils/sms.js`. It normalizes `to`, sends via Twilio, logs an outbound `sms_messages` row, and **throws** on Twilio failure (after logging a `status='failed'` row). Group 2's channel-substitution SMS path and Group 3's admin-SMS path call `sendAndLogSms`. If Phase 3 has not landed yet when Group 2/3 are implemented, `require('./sms')` will still succeed (the module exists) but `sendAndLogSms` will be `undefined` — the tasks below guard with a typeof check and fall back to `sendSMS` so they are not blocked. **Phase 3 is the intended primary; the fallback is a safety net only.**

### Cross-plan seam — `scheduledMessageDispatcher.js`

Phase 4a **also edits** `scheduledMessageDispatcher.js`, but only `checkSuppression` (it *adds* `recipient_type IN ('staff','admin')` branches). Group 1 of this plan edits **different functions**: `registerHandler`/`getHandlerMeta` (the option parsing) and `dispatchPending` (the new overlap pass). Those do not overlap with Phase 4a, so the edits cannot collide.

Group 2's Task 2.4 **also** edits `checkSuppression`, the one function Phase 4a touches. It does **not** rewrite the whole function. Step 8b is a **surgical fragment-replace** that removes only the two `if (row.channel === 'email')...` / `if (row.channel === 'sms')...` client per-channel blocks (channel-substitution moves to a new `resolveDelivery` step). It leaves the archived-proposal check and any staff/admin branch alone. So Phase 4a (adds staff/admin branches) and Phase 4b (removes the client per-channel blocks) edit **disjoint fragments** of `checkSuppression`; both leave the archived check; the two edits **compose** regardless of which lands first. Never quote-and-replace the entire `checkSuppression` body: that would silently delete the other plan's work. Land the two plans in separate commits; they merge cleanly because they touch non-overlapping lines.

### Project rules baked into this plan

- SQL is always parameterized (`$1`, `$2`). Never concatenate user input into SQL.
- Schema changes are idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DO $$ ... EXCEPTION WHEN OTHERS THEN NULL $$`).
- Async route handlers are wrapped in `asyncHandler`; throw `AppError` subclasses (`ValidationError`, etc. from `server/utils/errors.js`) instead of `res.status(400).json(...)`.
- Multi-table writes wrap in `BEGIN`/`COMMIT`/`ROLLBACK`.
- Frontend API calls go through `client/src/utils/api.js` — never raw `fetch`/`axios`. Loading and error states required.
- **No em dashes** in any client/staff/admin-facing copy (subjects, bodies, UI strings). Use commas, periods, colons, parentheses.
- Commit messages: plain one-line `git commit -m "..."`. No co-author footer, no heredoc.
- File-size discipline: 700-line soft cap, 1000-line hard cap. `scheduledMessageDispatcher.js` is ~400 lines — the Group 1 additions keep it well under cap.

### How to run server tests

There is no `npm test` script. Run a single server test file directly:

```
node --test server/utils/<file>.test.js
```

Tests use `node:test` + `node:assert/strict` and hit the real dev database via `server/db` (they `require('dotenv').config()`). The test DB must be reachable (`DATABASE_URL` in `.env`). Mirror the existing pattern in `server/utils/scheduledMessageDispatcher.test.js`: create a throwaway client + proposal in `before()`, clean up in `after()`, clear handlers in `beforeEach()`.

---

# GROUP 1 — Overlap Prevention

Adds `priority` + `cooldownExempt` to the handler registry, retrofits `priority` onto the 14 existing handlers, and implements the dispatch-time rule: at most 1 message per channel per client per day; when two collide the lower-priority one is deferred 24h by writing `status='deferred'`; `event_eve` and `balance_due_today`(+`_sms`) are hard exceptions and always fire.

### Priority ladder (PINNED — from the SMS contract section 5)

| Tier | priority | message types |
|---|---|---|
| Time-sensitive operational | **1** | `event_eve`, `balance_reminder_autopay_t3`, `balance_reminder_non_autopay_t3`, `balance_due_today`, `balance_due_today_sms` |
| Action-required | **2** | `balance_late_t1`, `balance_late_t1_sms`, `balance_late_t3`, `balance_late_t3_sms`, `drink_plan_nudge`, `drink_plan_nudge_sms` |
| Lifecycle | **3** | `event_week_reminder`, `long_lead_t30_recap`, `review_request` |
| Drip | **4** | `drip_touch_1`, `drip_touch_2`, `drip_touch_3`, `drip_touch_4`, `drip_touch_5_email`, `drip_touch_5_sms` |
| Marketing / retention | **5** | `new_year_hello`, `six_months_out`, `retention_nudge` |

`cooldownExempt: true` is set only on `event_eve`, `balance_due_today`, `balance_due_today_sms`. This plan retrofits `priority` (and `cooldownExempt` where applicable) onto the **14 handlers that exist on `main` today**. The Phase 3 / Phase 4a handlers (`event_eve`, `drip_touch_1`, the `_sms` variants, staff touches) register themselves with `priority`/`cooldownExempt` in their own plans — this plan does not create them, it only makes the option live.

---

## Task 1.1: Add `priority`, `cooldownExempt`, and `multiChannel` to `registerHandler` and `getHandlerMeta`

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.js:45-82`
- Test: `server/utils/scheduledMessageDispatcher.test.js`

This task adds three option keys to the handler registry. `priority` (integer 1-5, drives the overlap ladder) and `cooldownExempt` (boolean, exempts a handler from the daily deferral) feed the overlap rule in Task 1.3. `multiChannel` (boolean) marks a touch that is scheduled as **both** an email row and an SMS row — Task 2.4's channel substitution must NOT substitute a `multiChannel` row (spec 7.3: each channel of a multi-channel touch is independent, the dead channel simply suppresses while the paired row fires). All three are inert until the tasks that consume them land; this task only makes the registry store and validate them.

- [ ] **Step 1: Write the failing tests**

Add these four tests to the end of `server/utils/scheduledMessageDispatcher.test.js`, before the final newline. They need `getHandlerMeta` in the destructured import — update the `require` at the top of the file from:

```javascript
const {
  registerHandler,
  _clearHandlersForTest,
  dispatchPending,
} = require('./scheduledMessageDispatcher');
```

to:

```javascript
const {
  registerHandler,
  getHandlerMeta,
  _clearHandlersForTest,
  dispatchPending,
} = require('./scheduledMessageDispatcher');
```

Then append the tests:

```javascript
test('registerHandler > stores priority, cooldownExempt, and multiChannel in handler meta', () => {
  registerHandler('disp_test_meta_pri', async () => {}, {
    priority: 2,
    cooldownExempt: true,
    multiChannel: true,
    offsetFromEventDate: null,
  });
  const meta = getHandlerMeta('disp_test_meta_pri');
  assert.strictEqual(meta.priority, 2);
  assert.strictEqual(meta.cooldownExempt, true);
  assert.strictEqual(meta.multiChannel, true);
});

test('registerHandler > defaults priority to 3, cooldownExempt and multiChannel to false', () => {
  registerHandler('disp_test_meta_default', async () => {});
  const meta = getHandlerMeta('disp_test_meta_default');
  assert.strictEqual(meta.priority, 3);
  assert.strictEqual(meta.cooldownExempt, false);
  assert.strictEqual(meta.multiChannel, false);
});

test('registerHandler > rejects an out-of-range priority', () => {
  assert.throws(
    () => registerHandler('disp_test_meta_bad', async () => {}, { priority: 9 }),
    /priority/
  );
});

test('registerHandler > coerces a non-true multiChannel value to false', () => {
  registerHandler('disp_test_meta_mc', async () => {}, { multiChannel: 'yes' });
  const meta = getHandlerMeta('disp_test_meta_mc');
  assert.strictEqual(meta.multiChannel, false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: the four new tests FAIL — `meta.priority`, `meta.cooldownExempt`, and `meta.multiChannel` are all `undefined`, and `registerHandler` does not throw on `priority: 9`.

- [ ] **Step 3: Implement `priority` + `cooldownExempt` in the registry**

In `server/utils/scheduledMessageDispatcher.js`, the current `registerHandler` body (lines 45-65) builds `meta` from three options. Replace the whole function. Find:

```javascript
function registerHandler(messageType, handlerFn, options = {}) {
  if (typeof handlerFn !== 'function') {
    throw new Error(`registerHandler: handlerFn for '${messageType}' must be a function`);
  }
  const meta = {
    offsetFromEventDate: (options.offsetFromEventDate === null || options.offsetFromEventDate === undefined) ? null : Number(options.offsetFromEventDate),
    anchor: options.anchor || 'event_date',
    category: options.category || 'operational',
  };
  if (!VALID_ANCHORS.has(meta.anchor)) {
    throw new Error(`registerHandler: invalid anchor '${meta.anchor}' for '${messageType}'`);
  }
  if (!VALID_CATEGORIES.has(meta.category)) {
    throw new Error(`registerHandler: invalid category '${meta.category}' for '${messageType}'`);
  }
  if (meta.offsetFromEventDate !== null && !Number.isFinite(meta.offsetFromEventDate)) {
    throw new Error(`registerHandler: offsetFromEventDate must be a finite number or null for '${messageType}'`);
  }
  handlers.set(messageType, handlerFn);
  handlerMeta.set(messageType, meta);
}
```

Replace with:

```javascript
function registerHandler(messageType, handlerFn, options = {}) {
  if (typeof handlerFn !== 'function') {
    throw new Error(`registerHandler: handlerFn for '${messageType}' must be a function`);
  }
  // priority: integer 1-5, 1 = highest. Default 3 (Lifecycle tier) so a handler
  // registered without an explicit priority loses to operational touches but
  // beats drip/marketing. cooldownExempt: when true, the dispatcher's
  // overlap-prevention pass never defers this message_type (event_eve and
  // balance_due_today MUST fire on their exact day — see spec 7.4).
  // multiChannel: when true, this touch is scheduled as BOTH an email row and
  // an SMS row; the channel-substitution step (spec 7.3) never substitutes a
  // multiChannel row — if that row's own channel is dead it simply suppresses
  // and the paired row on the other channel handles delivery.
  const priority = (options.priority === undefined || options.priority === null)
    ? 3
    : Number(options.priority);
  const meta = {
    offsetFromEventDate: (options.offsetFromEventDate === null || options.offsetFromEventDate === undefined) ? null : Number(options.offsetFromEventDate),
    anchor: options.anchor || 'event_date',
    category: options.category || 'operational',
    priority,
    cooldownExempt: options.cooldownExempt === true,
    multiChannel: options.multiChannel === true,
  };
  if (!VALID_ANCHORS.has(meta.anchor)) {
    throw new Error(`registerHandler: invalid anchor '${meta.anchor}' for '${messageType}'`);
  }
  if (!VALID_CATEGORIES.has(meta.category)) {
    throw new Error(`registerHandler: invalid category '${meta.category}' for '${messageType}'`);
  }
  if (meta.offsetFromEventDate !== null && !Number.isFinite(meta.offsetFromEventDate)) {
    throw new Error(`registerHandler: offsetFromEventDate must be a finite number or null for '${messageType}'`);
  }
  if (!Number.isInteger(meta.priority) || meta.priority < 1 || meta.priority > 5) {
    throw new Error(`registerHandler: priority must be an integer 1-5 for '${messageType}'`);
  }
  handlers.set(messageType, handlerFn);
  handlerMeta.set(messageType, meta);
}
```

Also update the `getHandlerMeta` JSDoc return type. Find:

```javascript
 * @returns {{offsetFromEventDate: number|null, anchor: string, category: string} | null}
 */
```

Replace with:

```javascript
 * @returns {{offsetFromEventDate: number|null, anchor: string, category: string, priority: number, cooldownExempt: boolean, multiChannel: boolean} | null}
 */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: PASS — all tests including the existing ones (the prior tests register handlers without `priority`, which now default to `3`; no behavior change for them).

- [ ] **Step 5: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(comms): add priority, cooldownExempt, and multiChannel to scheduled-message handler registry"
```

---

## Task 1.2: Retrofit `priority` and `multiChannel` onto the 14 existing handler registrations

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.js:366-390` (5 balance handlers)
- Modify: `server/utils/preEventHandlers.js:241-250` (2 pre-event handlers)
- Modify: `server/utils/marketingHandlers.js:398-479` (7 marketing/review handlers)

This task is mechanical: add a `priority` key to each existing `registerHandler` options object, plus `cooldownExempt: true` on `balance_due_today`, plus `multiChannel: true` on the four existing email handlers that gain SMS siblings in Phase 3. No new behavior — `priority` is read by the dispatcher only after Task 1.3 lands, and `multiChannel` only after Task 2.4 lands; this task and 1.3 could be one commit, but keeping them separate isolates the mechanical retrofit.

**`multiChannel` retrofit — which handlers (cross-plan).** The full multi-channel set is **5 pairs / 10 message types**: `drink_plan_nudge`/`drink_plan_nudge_sms`, `balance_due_today`/`balance_due_today_sms`, `balance_late_t1`/`balance_late_t1_sms`, `balance_late_t3`/`balance_late_t3_sms`, `drip_touch_5_email`/`drip_touch_5_sms`. Phase 3 creates the six **new** handlers (`drink_plan_nudge` + the five `_sms` variants) and registers each with `multiChannel: true` in the Phase 3 plan. This task (Phase 4b) sets `multiChannel: true` on the **four existing email handlers** that gain an SMS sibling in Phase 3: `balance_due_today`, `balance_late_t1`, `balance_late_t3` (in `scheduledMessageDispatcher.js`, Step 1), and `drip_touch_5_email` (in `marketingHandlers.js`, Step 3). The split is unambiguous: Phase 4b flags the four pre-existing email rows; Phase 3 flags the six it newly creates. The other 10 existing handlers stay single-channel (`multiChannel` defaults `false`).

- [ ] **Step 1: Retrofit the 5 balance handlers in `scheduledMessageDispatcher.js`**

Find the registration block (lines 366-390):

```javascript
registerHandler(
  'balance_reminder_autopay_t3',
  ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'autopay' }),
  { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational' }
);
registerHandler(
  'balance_reminder_non_autopay_t3',
  ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'manual' }),
  { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational' }
);
registerHandler(
  'balance_due_today',
  ({ entity, recipient }) => sendBalanceDueToday({ entity, recipient }),
  { offsetFromEventDate: 0, anchor: 'balance_due_date', category: 'operational' }
);
registerHandler(
  'balance_late_t1',
  ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 1 }),
  { offsetFromEventDate: 1 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational' }
);
registerHandler(
  'balance_late_t3',
  ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 3 }),
  { offsetFromEventDate: 3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational' }
);
```

Replace with (priority 1 for the two T-3 reminders + due-today; priority 2 for the two late reminders; `cooldownExempt: true` on `balance_due_today`; `multiChannel: true` on `balance_due_today`, `balance_late_t1`, `balance_late_t3` — each gains an SMS sibling in Phase 3. The two T-3 reminders stay single-channel: they are email-only and have no `_sms` variant):

```javascript
registerHandler(
  'balance_reminder_autopay_t3',
  ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'autopay' }),
  { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 1 }
);
registerHandler(
  'balance_reminder_non_autopay_t3',
  ({ entity, recipient }) => sendBalanceReminder({ entity, recipient, paymentMode: 'manual' }),
  { offsetFromEventDate: -3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 1 }
);
registerHandler(
  'balance_due_today',
  ({ entity, recipient }) => sendBalanceDueToday({ entity, recipient }),
  { offsetFromEventDate: 0, anchor: 'balance_due_date', category: 'operational', priority: 1, cooldownExempt: true, multiChannel: true }
);
registerHandler(
  'balance_late_t1',
  ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 1 }),
  { offsetFromEventDate: 1 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
);
registerHandler(
  'balance_late_t3',
  ({ entity, recipient }) => sendBalanceLate({ entity, recipient, daysLate: 3 }),
  { offsetFromEventDate: 3 * DAY_SECONDS, anchor: 'balance_due_date', category: 'operational', priority: 2, multiChannel: true }
);
```

- [ ] **Step 2: Retrofit the 2 pre-event handlers in `preEventHandlers.js`**

Find the `registerAll` body (lines 241-250):

```javascript
function registerAll() {
  registerHandler('event_week_reminder', handleEventWeekReminder, {
    offsetFromEventDate: -7 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational',
  });
  registerHandler('long_lead_t30_recap', handleLongLeadT30Recap, {
    offsetFromEventDate: -30 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational',
  });
}
```

Replace with (both Lifecycle tier, priority 3):

```javascript
function registerAll() {
  registerHandler('event_week_reminder', handleEventWeekReminder, {
    offsetFromEventDate: -7 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational',
    priority: 3,
  });
  registerHandler('long_lead_t30_recap', handleLongLeadT30Recap, {
    offsetFromEventDate: -30 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational',
    priority: 3,
  });
}
```

- [ ] **Step 3: Retrofit the 7 marketing/review handlers in `marketingHandlers.js`**

In `marketingHandlers.js` `registerMarketingHandlers()` (lines 398-479), add `priority` to each of the 7 options objects. The drip touches and `new_year_hello`/`six_months_out`/`retention_nudge` keep their existing option objects; only the `priority` key is new.

Find each registration and add `priority`:

`drip_touch_2` — find `{ offsetFromEventDate: null, anchor: 'created_at', category: 'marketing' }` on the `drip_touch_2` registration, replace with `{ offsetFromEventDate: null, anchor: 'created_at', category: 'marketing', priority: 4 }`.

`drip_touch_4` — find `{ offsetFromEventDate: null, anchor: 'created_at', category: 'marketing' }` on the `drip_touch_4` registration, replace with `{ offsetFromEventDate: null, anchor: 'created_at', category: 'marketing', priority: 4 }`.

`drip_touch_5_email` — find `{ offsetFromEventDate: null, anchor: 'created_at', category: 'marketing' }` on the `drip_touch_5_email` registration, replace with `{ offsetFromEventDate: null, anchor: 'created_at', category: 'marketing', priority: 4, multiChannel: true }`. (This is the email half of the +21d drip pair; Phase 3 creates `drip_touch_5_sms` with `multiChannel: true`.)

`new_year_hello` — this registration's options object is the multi-line one ending with `{ offsetFromEventDate: null, anchor: 'event_date', category: 'marketing' }`. Replace that final line with `{ offsetFromEventDate: null, anchor: 'event_date', category: 'marketing', priority: 5 }`.

`six_months_out` — find `{ offsetFromEventDate: -6 * MONTH_SECONDS, anchor: 'event_date', category: 'marketing' }`, replace with `{ offsetFromEventDate: -6 * MONTH_SECONDS, anchor: 'event_date', category: 'marketing', priority: 5 }`.

`retention_nudge` — find its options object:

```javascript
  }, {
    offsetFromEventDate: 11 * MONTH_SECONDS,
    anchor: 'event_date',
    category: 'marketing',
  });
```

Replace with:

```javascript
  }, {
    offsetFromEventDate: 11 * MONTH_SECONDS,
    anchor: 'event_date',
    category: 'marketing',
    priority: 5,
  });
```

`review_request` — find its options object:

```javascript
  }, {
    offsetFromEventDate: 2 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational', // transactional post-sale follow-up under CAN-SPAM
  });
```

Replace with:

```javascript
  }, {
    offsetFromEventDate: 2 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational', // transactional post-sale follow-up under CAN-SPAM
    priority: 3,
  });
```

- [ ] **Step 4: Add a metadata-assertion test for the retrofitted handlers**

The module-load check (Step 5) confirms no `priority` is out of range, but it does **not** confirm the `priority` / `multiChannel` *values* landed correctly — a missing or wrong `multiChannel` does not throw. Add one test that asserts the retrofitted metadata against the **real source registrations**.

Two registration mechanisms, and the test handles each correctly. The suite's `beforeEach` (mirrored from the existing file) calls `_clearHandlersForTest()` before every test, emptying the registry on the module instance the test file imported at its top.

- The **two pre-event handlers** and the **seven marketing/review handlers** register via the exported functions `preEventHandlers.registerAll()` and `marketingHandlers.registerMarketingHandlers()`. Those modules captured the dispatcher's `registerHandler` at their own load time, so calling them re-registers into **that same imported instance's** registry — readable via the test file's top-level `getHandlerMeta`. So: call those two functions, then read `getHandlerMeta`.
- The **five balance handlers** register only at module-load of `scheduledMessageDispatcher.js` itself (bare top-level `registerHandler(...)` statements — same module, no wrapping function). Once `beforeEach` clears them they cannot be restored by any function call. But because they register **intra-module**, re-requiring `scheduledMessageDispatcher.js` with its `require.cache` entry deleted re-runs the module body, re-executing those five `registerHandler` calls against the fresh instance's own fresh registry. Read those five via the **fresh instance's own** `getHandlerMeta`. (This trick works only for the balance handlers: `registerAll` / `registerMarketingHandlers` would still write to the *original* instance because `preEventHandlers` / `marketingHandlers` hold the original `registerHandler` reference — so the test must NOT try to read the marketing/pre-event handlers off the fresh instance.)

Append to the end of `server/utils/scheduledMessageDispatcher.test.js`:

```javascript
test('retrofit > priority and multiChannel landed on the 14 existing handler registrations', async () => {
  // Marketing + pre-event handlers: re-register via their exported functions
  // (they write into the instance this file imported at its top).
  // eslint-disable-next-line global-require
  require('./preEventHandlers').registerAll();
  // eslint-disable-next-line global-require
  require('./marketingHandlers').registerMarketingHandlers();

  // Phase 4b flags exactly one marketing-side existing handler as multiChannel:
  // drip_touch_5_email (the +21d drip pair's email half). The other 8
  // marketing/pre-event handlers stay single-channel.
  assert.strictEqual(getHandlerMeta('drip_touch_5_email').multiChannel, true);
  for (const mt of [
    'event_week_reminder', 'long_lead_t30_recap', 'review_request',
    'drip_touch_2', 'drip_touch_4', 'new_year_hello', 'six_months_out', 'retention_nudge',
  ]) {
    const meta = getHandlerMeta(mt);
    assert.ok(meta, `${mt} is registered`);
    assert.strictEqual(meta.multiChannel, false, `${mt} stays single-channel`);
  }
  // Priority retrofit spot-check across the tiers, marketing/pre-event side.
  assert.strictEqual(getHandlerMeta('event_week_reminder').priority, 3);
  assert.strictEqual(getHandlerMeta('review_request').priority, 3);
  assert.strictEqual(getHandlerMeta('drip_touch_2').priority, 4);
  assert.strictEqual(getHandlerMeta('drip_touch_5_email').priority, 4);
  assert.strictEqual(getHandlerMeta('retention_nudge').priority, 5);

  // The five balance handlers register only at module-load of the dispatcher.
  // Re-require it with the cache cleared so the module body re-runs and those
  // five registerHandler calls re-execute against the fresh instance's own
  // registry. Read them via the fresh instance's getHandlerMeta.
  const dispatcherPath = require.resolve('./scheduledMessageDispatcher');
  delete require.cache[dispatcherPath];
  // eslint-disable-next-line global-require
  const fresh = require('./scheduledMessageDispatcher');
  // Of the five, three gain an SMS sibling in Phase 3 → multiChannel:true; the
  // two T-3 reminders are email-only and stay single-channel.
  for (const mt of ['balance_due_today', 'balance_late_t1', 'balance_late_t3']) {
    assert.strictEqual(fresh.getHandlerMeta(mt).multiChannel, true, `${mt} is multiChannel`);
  }
  for (const mt of ['balance_reminder_autopay_t3', 'balance_reminder_non_autopay_t3']) {
    assert.strictEqual(fresh.getHandlerMeta(mt).multiChannel, false, `${mt} stays single-channel`);
  }
  assert.strictEqual(fresh.getHandlerMeta('balance_due_today').priority, 1);
  assert.strictEqual(fresh.getHandlerMeta('balance_due_today').cooldownExempt, true);
  assert.strictEqual(fresh.getHandlerMeta('balance_reminder_autopay_t3').priority, 1);
  assert.strictEqual(fresh.getHandlerMeta('balance_late_t1').priority, 2);
  assert.strictEqual(fresh.getHandlerMeta('balance_late_t3').priority, 2);

  // Restore the original cached dispatcher instance so the rest of the suite —
  // whose top-of-file destructured imports point at the original — is
  // unaffected. (This is the last test in the file, but restoring keeps the
  // cache honest if tests are later appended.)
  delete require.cache[dispatcherPath];
  // eslint-disable-next-line global-require
  require('./scheduledMessageDispatcher');
});
```

Note: append this test at the current end of the file (later tasks append their own tests after it — that is fine, this test does not depend on physical position). The `global-require` eslint-disable lines are because these `require` calls are deliberately inside the function body (the cache-bust requires it), not at module top. The fresh-instance churn is fully self-contained: the test busts and restores the dispatcher cache entry within its own body, and every other test reads the registry through the file's top-level destructured `getHandlerMeta` / `dispatchPending`, which keep pointing at the original instance that the suite's `beforeEach` clears as always.

- [ ] **Step 5: Verify the registrations still load**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js server/utils/marketingHandlers.test.js server/utils/preEventScheduling.test.js`
Expected: PASS. (`registerHandler` would `throw` at module-load time if any `priority` were out of range, so a clean load means the retrofit is valid; the Step 4 test confirms the `multiChannel` / `priority` values.)

- [ ] **Step 6: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js server/utils/preEventHandlers.js server/utils/marketingHandlers.js
git commit -m "feat(comms): retrofit priority and multiChannel onto the 14 existing scheduled-message handlers"
```

---

## Task 1.3: Implement the dispatch-time overlap-prevention rule

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.js` — add a helper, an in-memory priority sort in `dispatchPending`, and a call inside `dispatchRow`
- Test: `server/utils/scheduledMessageDispatcher.test.js`

**The rule (spec 7.4):** before a row is handed to its handler, check whether another `scheduled_messages` row for the **same recipient and channel** was already `sent` (`sent_at` set) within the last 24 hours, OR is `pending`/about to fire today for the same recipient+channel. If a same-day collision exists and the current row is **lower priority** (higher `priority` number) than the colliding touch, defer the current row: set `status='deferred'` and bump `scheduled_for` forward 24 hours so the next tick re-evaluates it. `cooldownExempt` handlers skip the check entirely and always fire.

**Design decisions baked in:**
- The cooldown is a **per-client** rule. It applies only when `recipient_type = 'client'` (staff volume is low; this plan does not add a staff cap — staff touches always fire).
- "Collision" = another row, same `recipient_type`+`recipient_id`+`channel`, that was **`sent` within the trailing 24h**. This is the concrete, already-fired signal spec 7.4's deferral logic names ("any sent_at within the last 24h"). Comparing against still-pending future rows is intentionally out of scope: pending rows have not consumed the channel yet, and the next tick re-checks the deferred row anyway.
- Tie-break: if the colliding sent row had **equal or higher priority** (lower-or-equal `priority` number), the current row defers. If the current row is strictly higher priority (strictly lower number) it fires anyway — but note the already-sent row cannot be un-sent, so in practice the day's channel is already used; deferring the strictly-higher row would only delay it without benefit, so a strictly-higher-priority row is allowed through. The net effect: the first-fired touch wins the day for its priority-or-better; a later strictly-higher touch is rare (schedulers fire low-priority drip/marketing at 10:00 and operational reminders are date-anchored) and is permitted.
- Deferral writes `status='deferred'` and `scheduled_for = scheduled_for + INTERVAL '24 hours'`. A `deferred` row is **not** `pending`, so `dispatchPending`'s `WHERE status='pending'` SELECT skips it. Task 1.4 adds a re-activation step that flips due `deferred` rows back to `pending`.

**Within-tick processing order (critical for correctness).** `dispatchPending` SELECTs each batch ordered by `scheduled_for ASC`. With the overlap rule live, that order alone is **wrong**: if two touches for the same client+channel are due in the same tick, processing the lower-priority one first lets it send and claim the channel — then the later higher-priority touch, being strictly higher priority, *correctly* bypasses the cooldown deferral (per the tie-break above) and **also sends**, a double-send that violates the daily per-channel cap. The fix is to dispatch each batch **highest-priority-first**: after the batch SELECT, the fetched rows array is sorted **in memory** by handler `priority` ascending (1 = highest, dispatched first), then by `scheduled_for` ascending, before the dispatch loop. Then the higher-priority touch fires first and claims the channel, and the lower-priority touch — finding an equal-or-higher sent touch in its 24h window — defers. Priority lives in the in-memory handler registry (`handlerMeta`), not a `scheduled_messages` column, so this **must** be an in-memory `Array.prototype.sort`, not a SQL `ORDER BY`. A row whose `message_type` is unregistered (no `handlerMeta` entry) sorts **last** (treated as lowest priority).

The sort is **per batch** (`dispatchPending` drains in passes of `BATCH_LIMIT` = 100, each pass SELECTs then sorts then dispatches). A single client almost never has two touches due in one tick, and the only residual gap — two colliding touches for one client straddling a 100-row batch boundary — is negligible and is the same already-accepted out-of-scope edge as "comparing against still-pending future rows" above. Per-batch priority ordering is the fix the overlap rule needs; global cross-batch ordering is not in scope.

- [ ] **Step 1: Write the failing tests**

Append to `server/utils/scheduledMessageDispatcher.test.js`:

```javascript
test('overlap > defers a lower-priority touch when a higher-priority one already fired today', async () => {
  // A priority-1 balance reminder already sent 1 hour ago. A priority-4 drip
  // touch on the same client+channel today must be deferred, not sent.
  registerHandler('disp_test_hi', async () => {}, { priority: 1 });
  registerHandler('disp_test_lo', mock.fn(async () => {}), { priority: 4 });

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ($1, 'proposal', 'disp_test_hi', 'client', $2, 'email', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', 'sent')`,
    [testProposalId, testClientId]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_lo', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_lo'"
  );
  assert.strictEqual(rows[0].status, 'deferred');
});

test('overlap > a cooldownExempt touch fires even when another touch already fired today', async () => {
  const exemptHandler = mock.fn(async () => {});
  registerHandler('disp_test_exempt', exemptHandler, { priority: 1, cooldownExempt: true });

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ($1, 'proposal', 'disp_test_other', 'client', $2, 'email', NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours', 'sent')`,
    [testProposalId, testClientId]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_exempt', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(exemptHandler.mock.callCount(), 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_exempt'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});

test('overlap > does not defer when the prior touch is on a different channel', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_otherchan', handler, { priority: 4 });

  // Prior sent touch on SMS; current touch on email — different channel, no collision.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ($1, 'proposal', 'disp_test_smsprior', 'client', $2, 'sms', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '1 hour', 'sent')`,
    [testProposalId, testClientId]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_otherchan', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_otherchan'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});

test('overlap > within one tick, the higher-priority touch fires and the lower-priority one defers even when the lower-priority one has the earlier scheduled_for', async () => {
  // Two same-client same-channel rows due in the SAME tick. The lower-priority
  // (priority 4) row has the EARLIER scheduled_for, so a naive scheduled_for-ASC
  // dispatch would send it first; it would claim the channel; then the
  // priority-1 row, being strictly higher priority, would bypass the cooldown
  // and ALSO send — a double-send. The in-memory priority sort must dispatch the
  // priority-1 row first so the priority-4 row finds a sent collision and defers.
  const hiHandler = mock.fn(async () => {});
  const loHandler = mock.fn(async () => {});
  registerHandler('disp_test_tick_hi', hiHandler, { priority: 1 });
  registerHandler('disp_test_tick_lo', loHandler, { priority: 4 });

  // Lower-priority row: earlier scheduled_for (5 minutes ago).
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_tick_lo', 'client', $2, 'email', NOW() - INTERVAL '5 minutes')`,
    [testProposalId, testClientId]
  );
  // Higher-priority row: later scheduled_for (1 minute ago) but still due.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_tick_hi', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(hiHandler.mock.callCount(), 1, 'priority-1 touch sent');
  assert.strictEqual(loHandler.mock.callCount(), 0, 'priority-4 touch deferred, handler never ran');
  const hi = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_tick_hi'"
  );
  const lo = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_tick_lo'"
  );
  assert.strictEqual(hi.rows[0].status, 'sent');
  assert.strictEqual(lo.rows[0].status, 'deferred');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: the first and the last test FAIL — `disp_test_lo` is `'sent'` not `'deferred'` (no overlap logic yet), and in the within-tick test the earlier-`scheduled_for` priority-4 row dispatches first and both rows end `'sent'`. The exempt + different-channel tests PASS by accident today (no deferral happens at all), but keep them — they lock in that behavior once Step 3 lands.

- [ ] **Step 3: Add the in-memory priority sort, the overlap-prevention helper, and call the helper in `dispatchRow`**

In `server/utils/scheduledMessageDispatcher.js`, first add the in-memory priority sort to `dispatchPending`'s batch loop. The current loop SELECTs each batch ordered by `scheduled_for ASC` and immediately iterates it. Find:

```javascript
      const { rows } = await pool.query(
        `SELECT id, entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for
         FROM scheduled_messages
         WHERE status = 'pending' AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC
         LIMIT $1`,
        [BATCH_LIMIT]
      );
      batchSize = rows.length;

      for (const row of rows) {
```

Replace with:

```javascript
      const { rows } = await pool.query(
        `SELECT id, entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for
         FROM scheduled_messages
         WHERE status = 'pending' AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC
         LIMIT $1`,
        [BATCH_LIMIT]
      );
      batchSize = rows.length;

      // Dispatch the batch highest-priority-first (spec 7.4). The SQL ORDER BY
      // is scheduled_for ASC, but the overlap rule needs the higher-priority
      // touch of a same-client+channel+day collision to fire FIRST so it claims
      // the channel and the lower-priority touch defers. Priority lives in the
      // in-memory handler registry (handlerMeta), not a scheduled_messages
      // column, so this is an in-memory sort, not a SQL ORDER BY. An
      // unregistered message_type (no handlerMeta entry) sorts last.
      rows.sort((a, b) => {
        const metaA = handlerMeta.get(a.message_type);
        const metaB = handlerMeta.get(b.message_type);
        const prioA = (metaA && Number.isInteger(metaA.priority)) ? metaA.priority : Number.MAX_SAFE_INTEGER;
        const prioB = (metaB && Number.isInteger(metaB.priority)) ? metaB.priority : Number.MAX_SAFE_INTEGER;
        if (prioA !== prioB) return prioA - prioB;
        return new Date(a.scheduled_for) - new Date(b.scheduled_for);
      });

      for (const row of rows) {
```

Now add the overlap-prevention helper function. Place it directly **after** the `checkSuppression` function (after its closing `}` near line 122) and before the `// ─── Entity / recipient lookups ───` comment:

```javascript
// ─── Overlap prevention (spec 7.4) ───────────────────────────
// Max 1 scheduled message per channel per client per day. When a lower- or
// equal-priority touch collides with one that already fired in the trailing
// 24h on the same client+channel, the current row is deferred 24h. Handlers
// flagged cooldownExempt (event_eve, balance_due_today) skip this check.
//
// Returns true when the row should be deferred, false when it may proceed.
async function shouldDeferForOverlap(row) {
  // Cooldown is a client-only rule. Staff/admin touches always proceed.
  if (row.recipient_type !== 'client') return false;

  const meta = handlerMeta.get(row.message_type);
  // No metadata, or explicitly exempt → never defer.
  if (!meta || meta.cooldownExempt === true) return false;

  // Look for another row, same recipient + channel, that was SENT within the
  // trailing 24h. Pick the strongest (lowest priority number) colliding type
  // so the tie-break compares against the best touch that used the channel.
  const { rows } = await pool.query(
    `SELECT message_type
       FROM scheduled_messages
      WHERE recipient_type = 'client'
        AND recipient_id = $1
        AND channel = $2
        AND status = 'sent'
        AND sent_at IS NOT NULL
        AND sent_at > NOW() - INTERVAL '24 hours'
        AND id <> $3`,
    [row.recipient_id, row.channel, row.id]
  );
  if (rows.length === 0) return false;

  // Strongest colliding priority = lowest priority number among the sent rows.
  // A sent row whose message_type is no longer registered defaults to 3.
  let strongestColliding = 5;
  for (const r of rows) {
    const m = handlerMeta.get(r.message_type);
    const p = (m && Number.isInteger(m.priority)) ? m.priority : 3;
    if (p < strongestColliding) strongestColliding = p;
  }

  // Current row defers when it is NOT strictly higher priority than the
  // strongest touch that already used the channel today (i.e. its priority
  // number is >= the colliding one). A strictly-higher row (lower number)
  // proceeds — the channel is already spent, deferring would only delay it.
  return meta.priority >= strongestColliding;
}
```

Now wire it into `dispatchRow`. The current `dispatchRow` runs `checkSuppression`, then the marketing gate, then `handlers.get(...)`, then `await handler(...)`. Insert the overlap check **after the marketing gate and before `const handler = handlers.get(...)`**. Find this block in `dispatchRow`:

```javascript
    const handler = handlers.get(row.message_type);
    if (!handler) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, `no handler registered for message_type '${row.message_type}'`]
      );
      return;
    }
```

Replace with:

```javascript
    // Overlap prevention (spec 7.4): defer a colliding lower-priority touch by
    // 24h. The row goes 'deferred' and its scheduled_for moves forward a day;
    // the dispatcher's deferred-reactivation pass flips it back to 'pending'
    // when it next comes due.
    if (await shouldDeferForOverlap(row)) {
      await pool.query(
        `UPDATE scheduled_messages
            SET status = 'deferred',
                scheduled_for = scheduled_for + INTERVAL '24 hours',
                error_message = 'deferred: daily per-channel cooldown (spec 7.4)'
          WHERE id = $1`,
        [row.id]
      );
      return;
    }

    const handler = handlers.get(row.message_type);
    if (!handler) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, `no handler registered for message_type '${row.message_type}'`]
      );
      return;
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: PASS — all overlap tests plus all prior tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(comms): defer colliding lower-priority scheduled messages at dispatch time"
```

---

## Task 1.4: Re-activate deferred rows when they next come due

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.js` — add a reactivation query at the top of `dispatchPending`
- Test: `server/utils/scheduledMessageDispatcher.test.js`

A `deferred` row has its `scheduled_for` bumped 24h forward. When that new time arrives, the row must be re-evaluated. `dispatchPending` only SELECTs `status='pending'`, so deferred rows need to be flipped back to `pending` once they are due.

- [ ] **Step 1: Write the failing test**

Append to `server/utils/scheduledMessageDispatcher.test.js`:

```javascript
test('overlap > a deferred row whose new time is due is reactivated and dispatched', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_reactivate', handler, { priority: 4 });

  // A deferred row whose (already-bumped) scheduled_for is now in the past and
  // has no colliding sent touch — the next tick should reactivate and send it.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, status, error_message)
     VALUES ($1, 'proposal', 'disp_test_reactivate', 'client', $2, 'email', NOW() - INTERVAL '5 minutes', 'deferred', 'deferred: daily per-channel cooldown (spec 7.4)')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_reactivate'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: FAIL — `handler.mock.callCount()` is `0` and status stays `'deferred'` (the SELECT only picks up `pending`).

- [ ] **Step 3: Add the reactivation query to `dispatchPending`**

In `dispatchPending`, after the `_dispatchInFlight = true;` line and inside the `try {`, before the `let batchSize;` declaration, insert the reactivation step. Find:

```javascript
  _dispatchInFlight = true;
  try {
    // Drain fully: keep pulling batches while the last one was full, so a
```

Replace with:

```javascript
  _dispatchInFlight = true;
  try {
    // Reactivate deferred rows (spec 7.4): a row deferred by the overlap rule
    // had its scheduled_for bumped 24h. Flip any deferred row that is now due
    // back to 'pending' so the drain loop below re-evaluates it (it may defer
    // again if another touch fired in the new 24h window, or fire if clear).
    await pool.query(
      `UPDATE scheduled_messages
          SET status = 'pending'
        WHERE status = 'deferred'
          AND scheduled_for <= NOW()`
    );
    // Drain fully: keep pulling batches while the last one was full, so a
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(comms): reactivate deferred scheduled messages once they come due"
```

**GROUP 1 COMPLETE.** Overlap prevention is fully wired: priority ladder retrofitted, dispatch-time deferral active, deferred rows reactivate on their next due tick.

---

# GROUP 2 — Delivery-Failure Fallback

Flips `clients.email_status`/`phone_status` to `'bad'` on a Resend hard bounce / Twilio delivery failure, substitutes the alternate channel for scheduled single-channel operational touches when the primary channel is bad or opted out, and suspends a client's automation (plus fires an admin alert) when both channels are dead.

**Dependency note:** Group 2 Task 2.4's admin alerts call `notifyAdminCategory(...)` from Group 3's `server/utils/adminNotifications.js`. If you are executing groups in order (recommended), Group 3 is built after Group 2 — so Task 2.4 must guard the call with a typeof check and fall back to a direct `sendEmail` to `ADMIN_EMAIL`. The code below does exactly that, so Group 2 is committable before Group 3. If you instead build Group 3 first, the fallback branch is simply never taken.

---

## Task 2.1: Flip `clients.email_status='bad'` on a Resend hard bounce

**Files:**
- Modify: `server/routes/emailMarketingWebhook.js`

The Resend webhook already handles `email.bounced`. Today it only suppresses the **marketing** `email_leads` row. Client-facing emails (orientation, balance reminders, etc.) are sent via `sendEmail` and are **not** tracked in `email_sends` — so we cannot map a bounce `resend_id` back to a `clients` row through `email_sends`. Instead, the Resend `email.bounced` payload carries the recipient address in `data.to` (an array). We match that address against `clients.email` (case-insensitive) and flip `email_status`.

**Bounce-type guard:** Resend distinguishes hard bounces (`bounce_type: 'Permanent'` / `bounce.type` in newer payloads) from transient ones. A soft bounce (mailbox full, greylisting) must NOT mark the address bad. We only flip on a permanent bounce; if the payload does not specify a type, treat `email.bounced` as permanent (Resend's `email.bounced` event is permanent-only in current docs; `email.delivery_delayed` is the transient event and we ignore it).

- [ ] **Step 1: Add the client-status flip to the bounce branch**

In `server/routes/emailMarketingWebhook.js`, find the existing bounce/complaint block:

```javascript
    // For bounces/complaints, suppress the lead
    if (newStatus === 'bounced' || newStatus === 'complained') {
      const sendResult = await pool.query(
        'SELECT lead_id FROM email_sends WHERE resend_id = $1',
        [resendId]
      );
      if (sendResult.rows[0]) {
        await pool.query(
          `UPDATE email_leads SET status = $1 WHERE id = $2`,
          [newStatus, sendResult.rows[0].lead_id]
        );
        // Pause active enrollments
        await pool.query(
          `UPDATE email_sequence_enrollments SET status = 'unsubscribed' WHERE lead_id = $1 AND status = 'active'`,
          [sendResult.rows[0].lead_id]
        );
      }
    }
```

Replace with:

```javascript
    // For bounces/complaints, suppress the lead
    if (newStatus === 'bounced' || newStatus === 'complained') {
      const sendResult = await pool.query(
        'SELECT lead_id FROM email_sends WHERE resend_id = $1',
        [resendId]
      );
      if (sendResult.rows[0]) {
        await pool.query(
          `UPDATE email_leads SET status = $1 WHERE id = $2`,
          [newStatus, sendResult.rows[0].lead_id]
        );
        // Pause active enrollments
        await pool.query(
          `UPDATE email_sequence_enrollments SET status = 'unsubscribed' WHERE lead_id = $1 AND status = 'active'`,
          [sendResult.rows[0].lead_id]
        );
      }

      // Delivery-failure fallback (spec 7.5): a hard bounce on a client-facing
      // address flips clients.email_status to 'bad' so the dispatcher's channel
      // substitution falls future touches over to SMS. Client-facing emails are
      // not tracked in email_sends, so match the recipient address from the
      // Resend payload (data.to is an array) against clients.email.
      //
      // Only PERMANENT bounces mark an address bad. Resend's email.bounced is
      // permanent-only today; if a future payload carries an explicit transient
      // type, skip the flip. Complaints (spam reports) also flip email_status —
      // continuing to email someone who reported us as spam is harmful.
      const bounceTypeRaw = String(
        data?.bounce?.type || data?.bounce_type || data?.type || ''
      ).toLowerCase();
      const isTransient = bounceTypeRaw.includes('transient')
        || bounceTypeRaw.includes('temporary')
        || bounceTypeRaw.includes('soft');
      if (!isTransient) {
        const recipients = Array.isArray(data?.to)
          ? data.to
          : (data?.to ? [data.to] : []);
        for (const addr of recipients) {
          if (!addr || typeof addr !== 'string') continue;
          await pool.query(
            `UPDATE clients SET email_status = 'bad'
              WHERE LOWER(email) = LOWER($1) AND email_status <> 'bad'`,
            [addr.trim()]
          );
        }
      }
    }
```

- [ ] **Step 2: Manual verification (no automated test — webhook signature path)**

This route is signature-gated and exercised by Resend in production; an automated test would need to forge a signed svix payload. Verify by inspection: the `UPDATE clients` is parameterized, runs only on `bounced`/`complained`, skips transient bounces, and is a no-op when no `clients` row matches the address. Confirm `data` is in scope (it is destructured at `const { type, data } = event;` near the top of the handler).

Run the lint check to confirm no syntax error:

Run: `npx eslint server/routes/emailMarketingWebhook.js`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/routes/emailMarketingWebhook.js
git commit -m "feat(comms): flip clients.email_status to bad on a Resend hard bounce"
```

---

## Task 2.2: Add a Twilio delivery-failure status writer

**Files:**
- Create: `server/utils/smsDeliveryStatus.js`
- Test: `server/utils/smsDeliveryStatus.test.js`

Twilio reports final delivery state asynchronously. Two signals are available: (a) `sendAndLogSms` (Phase 3) logs a `status='failed'` `sms_messages` row when the Twilio API call itself rejects, and (b) a Twilio status-callback webhook reports `delivered`/`undelivered`/`failed` after the fact. This plan provides a **pure helper** `markPhoneStatusFromSmsResult` that any caller (a status-callback route, or `sendAndLogSms`'s failure path) can invoke to flip `clients.phone_status`. Wiring a Twilio status-callback webhook endpoint is a larger Twilio-config task out of this plan's scope; the helper is the reusable primitive, and Task 2.2's test exercises it directly.

**Wiring note (deliberate).** This task ships `markPhoneStatusFromSmsResult` as a tested-but-dormant writer: no production code path calls it yet. The Twilio status-callback webhook is scoped out (above), and `sendAndLogSms`'s failure path is a Phase 3 deliverable, so a follow-up wires one of those callers in. Group 2 is still coherent without it: the email-bounce half of the delivery-failure system (Task 2.1) is fully live, and the channel-substitution plus both-bad logic (Tasks 2.3 / 2.4) operates on whatever `phone_status` value exists, so a `phone_status` flipped by any future caller (or by an admin in the client page) immediately drives substitution. Do not block on the caller; ship the helper.

- [ ] **Step 1: Write the failing test**

Create `server/utils/smsDeliveryStatus.test.js`:

```javascript
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { markPhoneStatusFromSmsResult } = require('./smsDeliveryStatus');

let testClientId;

before(async () => {
  const existing = await pool.query(
    "SELECT id FROM clients WHERE email = 'sms-delivery-test@example.com' LIMIT 1"
  );
  if (existing.rowCount > 0) {
    testClientId = existing.rows[0].id;
  } else {
    const c = await pool.query(
      `INSERT INTO clients (name, email, phone) VALUES ('SMS Delivery Test', 'sms-delivery-test@example.com', '5555550199')
       RETURNING id`
    );
    testClientId = c.rows[0].id;
  }
  await pool.query("UPDATE clients SET phone_status = 'ok' WHERE id = $1", [testClientId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [testClientId]);
  await pool.end();
});

test('markPhoneStatusFromSmsResult > flips phone_status to bad on a failed delivery', async () => {
  const changed = await markPhoneStatusFromSmsResult({ clientId: testClientId, deliveryStatus: 'failed' });
  assert.strictEqual(changed, true);
  const { rows } = await pool.query('SELECT phone_status FROM clients WHERE id = $1', [testClientId]);
  assert.strictEqual(rows[0].phone_status, 'bad');
});

test('markPhoneStatusFromSmsResult > flips phone_status to bad on undelivered', async () => {
  await pool.query("UPDATE clients SET phone_status = 'ok' WHERE id = $1", [testClientId]);
  const changed = await markPhoneStatusFromSmsResult({ clientId: testClientId, deliveryStatus: 'undelivered' });
  assert.strictEqual(changed, true);
  const { rows } = await pool.query('SELECT phone_status FROM clients WHERE id = $1', [testClientId]);
  assert.strictEqual(rows[0].phone_status, 'bad');
});

test('markPhoneStatusFromSmsResult > leaves phone_status ok on a delivered status', async () => {
  await pool.query("UPDATE clients SET phone_status = 'ok' WHERE id = $1", [testClientId]);
  const changed = await markPhoneStatusFromSmsResult({ clientId: testClientId, deliveryStatus: 'delivered' });
  assert.strictEqual(changed, false);
  const { rows } = await pool.query('SELECT phone_status FROM clients WHERE id = $1', [testClientId]);
  assert.strictEqual(rows[0].phone_status, 'ok');
});

test('markPhoneStatusFromSmsResult > no-ops on a null clientId', async () => {
  const changed = await markPhoneStatusFromSmsResult({ clientId: null, deliveryStatus: 'failed' });
  assert.strictEqual(changed, false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/smsDeliveryStatus.test.js`
Expected: FAIL — `Cannot find module './smsDeliveryStatus'`.

- [ ] **Step 3: Create `server/utils/smsDeliveryStatus.js`**

```javascript
const { pool } = require('../db');

// Twilio final delivery states that mean the message did not reach the handset.
// 'failed' = Twilio could not send (carrier rejection, invalid number).
// 'undelivered' = carrier accepted then could not deliver.
const FAILED_DELIVERY_STATES = new Set(['failed', 'undelivered']);

/**
 * Flip clients.phone_status to 'bad' when an SMS delivery failed.
 *
 * Delivery-failure fallback, spec 7.5. Callers: a Twilio status-callback route,
 * or sendAndLogSms's failure path. Pure-ish — single parameterized UPDATE, no
 * external I/O beyond the DB.
 *
 * @param {Object} args
 * @param {number|null} args.clientId - clients.id the SMS was addressed to, or
 *   null when the SMS had no associated client (staff/admin SMS) — then no-op.
 * @param {string} args.deliveryStatus - the Twilio delivery status string.
 * @returns {Promise<boolean>} true when a row was flipped to 'bad'.
 */
async function markPhoneStatusFromSmsResult({ clientId, deliveryStatus }) {
  if (!clientId || !Number.isInteger(Number(clientId))) return false;
  const status = String(deliveryStatus || '').toLowerCase();
  if (!FAILED_DELIVERY_STATES.has(status)) return false;

  const result = await pool.query(
    `UPDATE clients SET phone_status = 'bad'
      WHERE id = $1 AND phone_status <> 'bad'`,
    [Number(clientId)]
  );
  return result.rowCount > 0;
}

module.exports = { markPhoneStatusFromSmsResult, FAILED_DELIVERY_STATES };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/smsDeliveryStatus.test.js`
Expected: PASS — all four tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsDeliveryStatus.js server/utils/smsDeliveryStatus.test.js
git commit -m "feat(comms): add markPhoneStatusFromSmsResult to flag bad phone numbers"
```

---

## Task 2.3: Add channel substitution for single-channel operational touches

**Files:**
- Create: `server/utils/channelFallback.js`
- Test: `server/utils/channelFallback.test.js`

**The rule (spec 7.3):** when a scheduled **single-channel operational** touch's primary channel is opted-out or `bad`, retry on the alternate channel (if that channel is available and not opted-out). Multi-channel touches (orientation, last-minute staffing) schedule each channel as its own row and need no substitution — one row suppresses, the other fires. Marketing touches governed by `marketing_enabled` get no fallback when marketing is off, but if marketing is on and the channel is opted-out they fall back too.

This task provides a **pure decision helper** `resolveChannelFallback` that, given a `scheduled_messages` row's channel + the loaded client row + the handler's category, returns one of: `proceed` (send on the row's channel), `substitute` (send on the other channel instead), or `suppress` (no working channel — Task 2.4 handles the both-bad admin alert). The dispatcher calls it; the actual substitution write is in Task 2.4.

**Channel availability** for a client row: email is usable when `communication_preferences.email_enabled !== false` AND `email_status !== 'bad'`. SMS is usable when `communication_preferences.sms_enabled !== false` AND `phone_status !== 'bad'` AND `phone` is non-empty.

- [ ] **Step 1: Write the failing test**

Create `server/utils/channelFallback.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveChannelFallback } = require('./channelFallback');

const okClient = {
  phone: '5125551234',
  communication_preferences: { email_enabled: true, sms_enabled: true, marketing_enabled: true },
  email_status: 'ok',
  phone_status: 'ok',
};

test('resolveChannelFallback > proceeds when the primary channel is fine', () => {
  const r = resolveChannelFallback({ channel: 'email', client: okClient, category: 'operational' });
  assert.deepStrictEqual(r, { action: 'proceed', channel: 'email' });
});

test('resolveChannelFallback > substitutes email to sms when email is bad', () => {
  const client = { ...okClient, email_status: 'bad' };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'operational' });
  assert.deepStrictEqual(r, { action: 'substitute', channel: 'sms' });
});

test('resolveChannelFallback > substitutes sms to email when sms is opted out', () => {
  const client = {
    ...okClient,
    communication_preferences: { email_enabled: true, sms_enabled: false, marketing_enabled: true },
  };
  const r = resolveChannelFallback({ channel: 'sms', client, category: 'operational' });
  assert.deepStrictEqual(r, { action: 'substitute', channel: 'email' });
});

test('resolveChannelFallback > suppresses when both channels are bad', () => {
  const client = { ...okClient, email_status: 'bad', phone_status: 'bad' };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'operational' });
  assert.strictEqual(r.action, 'suppress');
});

test('resolveChannelFallback > does not substitute a marketing touch when marketing is off', () => {
  const client = {
    ...okClient,
    email_status: 'bad',
    communication_preferences: { email_enabled: true, sms_enabled: true, marketing_enabled: false },
  };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'marketing' });
  assert.strictEqual(r.action, 'suppress');
});

test('resolveChannelFallback > substitutes a marketing touch when marketing is on but channel opted out', () => {
  const client = {
    ...okClient,
    communication_preferences: { email_enabled: false, sms_enabled: true, marketing_enabled: true },
  };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'marketing' });
  assert.deepStrictEqual(r, { action: 'substitute', channel: 'sms' });
});

test('resolveChannelFallback > suppresses sms substitution when client has no phone number', () => {
  const client = { ...okClient, email_status: 'bad', phone: '' };
  const r = resolveChannelFallback({ channel: 'email', client, category: 'operational' });
  assert.strictEqual(r.action, 'suppress');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/channelFallback.test.js`
Expected: FAIL — `Cannot find module './channelFallback'`.

- [ ] **Step 3: Create `server/utils/channelFallback.js`**

```javascript
/**
 * Channel substitution decision for a scheduled single-channel touch.
 *
 * Delivery-failure / opt-out fallback, spec 7.3. Pure — no I/O, the caller
 * passes the already-loaded client row.
 *
 * Channel availability for a client:
 *   - email usable: communication_preferences.email_enabled !== false
 *       AND email_status !== 'bad'
 *   - sms usable:   communication_preferences.sms_enabled !== false
 *       AND phone_status !== 'bad' AND a non-empty phone number on file
 *
 * Marketing touches (category === 'marketing'): if marketing_enabled is false
 * the touch is suppressed outright (no fallback). If marketing is on, an
 * opted-out / bad primary channel still falls back to the other channel.
 * Operational touches always attempt fallback.
 */

function emailUsable(client) {
  if (!client) return false;
  const prefs = client.communication_preferences || {};
  if (prefs.email_enabled === false) return false;
  if (client.email_status === 'bad') return false;
  return true;
}

function smsUsable(client) {
  if (!client) return false;
  const prefs = client.communication_preferences || {};
  if (prefs.sms_enabled === false) return false;
  if (client.phone_status === 'bad') return false;
  if (!client.phone || String(client.phone).trim() === '') return false;
  return true;
}

/**
 * @param {Object} args
 * @param {'email'|'sms'} args.channel - the scheduled row's channel.
 * @param {Object} args.client - clients row with communication_preferences,
 *   email_status, phone_status, phone.
 * @param {'operational'|'marketing'} args.category - the handler's category.
 * @returns {{action: 'proceed'|'substitute'|'suppress', channel?: 'email'|'sms'}}
 */
function resolveChannelFallback({ channel, client, category }) {
  const prefs = (client && client.communication_preferences) || {};

  // Marketing touch with marketing disabled → suppress, no fallback.
  if (category === 'marketing' && prefs.marketing_enabled === false) {
    return { action: 'suppress', reason: 'marketing_disabled' };
  }

  const primaryUsable = channel === 'email' ? emailUsable(client) : smsUsable(client);
  if (primaryUsable) {
    return { action: 'proceed', channel };
  }

  // Primary channel unusable — try the alternate.
  const altChannel = channel === 'email' ? 'sms' : 'email';
  const altUsable = altChannel === 'email' ? emailUsable(client) : smsUsable(client);
  if (altUsable) {
    return { action: 'substitute', channel: altChannel };
  }

  // Neither channel works.
  return { action: 'suppress', reason: 'no_working_channel' };
}

module.exports = { resolveChannelFallback, emailUsable, smsUsable };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/channelFallback.test.js`
Expected: PASS — all seven tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/channelFallback.js server/utils/channelFallback.test.js
git commit -m "feat(comms): add channel-substitution decision helper for single-channel touches"
```

---

## Task 2.4: Wire channel substitution + both-bad suspension into the dispatcher

**Files:**
- Create: `server/utils/clientAutomationSuspension.js`
- Modify: `server/utils/scheduledMessageDispatcher.js`
- Test: `server/utils/scheduledMessageDispatcher.test.js`, `server/utils/clientAutomationSuspension.test.js`

The dispatcher already has `checkSuppression` which flips a row to `'suppressed'` when the channel is opted-out / bad. That blunt suppression must now become smarter: instead of always suppressing, a single-channel operational touch should **substitute** the alternate channel. And when **both** channels are dead, the dispatcher must suspend the client's remaining automation (suppress every pending row for that client) and fire one admin alert.

**Strategy:** `checkSuppression` stays as the cheap pre-filter for the *non-fallback* cases (archived proposal). The per-channel opt-out/bad logic moves into a new `resolveDelivery` step in `dispatchRow` that calls `resolveChannelFallback`. When the result is `substitute`, the row's `channel` is rewritten in-place (UPDATE) and dispatch continues on the new channel. When `suppress` with reason `no_working_channel`, the row is suppressed AND `suspendClientAutomation` is invoked.

To keep `checkSuppression` from double-suppressing the substitution case, the per-channel client checks are **removed from `checkSuppression`** and fully owned by the new `resolveDelivery` step. The archived-proposal check and the staff/admin branches (added by Phase 4a) stay in `checkSuppression` untouched.

**Stale-row guard (mid-batch suppression).** `dispatchPending` loads a whole batch into memory, then dispatches the rows one at a time. When `resolveDelivery` hits a both-channels-bad client, `suspendClientAutomation` flips that client's *other* pending rows to `'suppressed'` **in the DB** — but rows already loaded into the current in-memory batch still get processed. If a second row for that same client is later in the batch, `dispatchRow` would re-enter `resolveDelivery`, see both channels still bad, and fire a **duplicate** "no working contact channel" admin alert (and call `suspendClientAutomation` again — a harmless no-op, but the alert is not harmless). The fix: `dispatchRow` re-verifies the row is still `status='pending'` in the DB immediately before processing it, and returns early if it is not. A row suppressed by a mid-batch `suspendClientAutomation` is then skipped silently. This guard is added in Step 8 below.

- [ ] **Step 1: Write the failing test for `suspendClientAutomation`**

Create `server/utils/clientAutomationSuspension.test.js`:

```javascript
require('dotenv').config();
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { suspendClientAutomation } = require('./clientAutomationSuspension');

let testClientId;
let testProposalId;

before(async () => {
  const existing = await pool.query(
    "SELECT id FROM clients WHERE email = 'suspend-test@example.com' LIMIT 1"
  );
  if (existing.rowCount > 0) {
    testClientId = existing.rows[0].id;
  } else {
    const c = await pool.query(
      `INSERT INTO clients (name, email, phone) VALUES ('Suspend Test', 'suspend-test@example.com', '5555550188')
       RETURNING id`
    );
    testClientId = c.rows[0].id;
  }
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, amount_paid, balance_due_date)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + INTERVAL '30 days', 'birthday-party', 100000, 10000, CURRENT_DATE + INTERVAL '14 days')
     RETURNING id`,
    [testClientId]
  );
  testProposalId = p.rows[0].id;
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'suspend_test_%'");
  await pool.query('DELETE FROM proposals WHERE id = $1', [testProposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [testClientId]);
  await pool.end();
});

beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'suspend_test_%'");
});

test('suspendClientAutomation > suppresses every pending row for the client', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'suspend_test_a', 'client', $2, 'email', NOW() + INTERVAL '1 day'),
            ($1, 'proposal', 'suspend_test_b', 'client', $2, 'sms', NOW() + INTERVAL '2 days')`,
    [testProposalId, testClientId]
  );

  const count = await suspendClientAutomation(testClientId);
  assert.strictEqual(count, 2);

  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type LIKE 'suspend_test_%' ORDER BY message_type"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.strictEqual(rows[1].status, 'suppressed');
});

test('suspendClientAutomation > leaves already-sent rows untouched', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ($1, 'proposal', 'suspend_test_sent', 'client', $2, 'email', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day', 'sent')`,
    [testProposalId, testClientId]
  );

  await suspendClientAutomation(testClientId);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'suspend_test_sent'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/clientAutomationSuspension.test.js`
Expected: FAIL — `Cannot find module './clientAutomationSuspension'`.

- [ ] **Step 3: Create `server/utils/clientAutomationSuspension.js`**

```javascript
const { pool } = require('../db');

/**
 * Suspend all remaining automation for a client whose every contact channel
 * has failed (spec 7.5 "both bad"). Flips every pending and deferred
 * scheduled_messages row for the client to 'suppressed'. Sent / failed rows
 * are left as-is. Idempotent — re-running on an already-suspended client
 * suppresses zero further rows.
 *
 * @param {number} clientId
 * @returns {Promise<number>} count of rows suppressed.
 */
async function suspendClientAutomation(clientId) {
  if (!clientId || !Number.isInteger(Number(clientId))) return 0;
  const result = await pool.query(
    `UPDATE scheduled_messages
        SET status = 'suppressed',
            error_message = 'suspended: no working contact channel for client (spec 7.5)'
      WHERE recipient_type = 'client'
        AND recipient_id = $1
        AND status IN ('pending', 'deferred')`,
    [Number(clientId)]
  );
  return result.rowCount;
}

module.exports = { suspendClientAutomation };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/clientAutomationSuspension.test.js`
Expected: PASS — both tests.

- [ ] **Step 5: Commit the suspension helper**

```bash
git add server/utils/clientAutomationSuspension.js server/utils/clientAutomationSuspension.test.js
git commit -m "feat(comms): add suspendClientAutomation for the both-channels-bad case"
```

- [ ] **Step 6: Write the failing dispatcher tests for substitution + suspension**

Append to `server/utils/scheduledMessageDispatcher.test.js`:

```javascript
test('delivery > substitutes the channel when the primary channel is bad', async () => {
  // email_status='bad', operational touch on email → row's channel is rewritten
  // to 'sms' and the handler runs (the handler sees scheduledMessage.channel = 'sms').
  let seenChannel = null;
  registerHandler('disp_test_subst', async ({ scheduledMessage }) => {
    seenChannel = scheduledMessage.channel;
  }, { priority: 1, category: 'operational' });

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'ok' WHERE id = $1", [testClientId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_subst', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, channel FROM scheduled_messages WHERE message_type = 'disp_test_subst'"
  );
  assert.strictEqual(rows[0].status, 'sent');
  assert.strictEqual(rows[0].channel, 'sms');
  assert.strictEqual(seenChannel, 'sms');

  await pool.query("UPDATE clients SET email_status = 'ok' WHERE id = $1", [testClientId]);
});

test('delivery > a multiChannel row whose own channel is bad is suppressed, never substituted', async () => {
  // A multiChannel touch is scheduled as both an email row and an SMS row.
  // Spec 7.3: no substitution. With email_status='bad' but SMS fine, a
  // SINGLE-channel email row would substitute to SMS; a multiChannel email row
  // must instead SUPPRESS (channel stays 'email', handler never runs) so it
  // does not duplicate the paired SMS row on the live channel.
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_multichan', handler, {
    priority: 2, category: 'operational', multiChannel: true,
  });

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'ok' WHERE id = $1", [testClientId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_multichan', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0, 'multiChannel row never reaches its handler');
  const { rows } = await pool.query(
    "SELECT status, channel FROM scheduled_messages WHERE message_type = 'disp_test_multichan'"
  );
  assert.strictEqual(rows[0].status, 'suppressed', 'suppressed, not sent');
  assert.strictEqual(rows[0].channel, 'email', 'channel was NOT rewritten to sms');

  await pool.query("UPDATE clients SET email_status = 'ok' WHERE id = $1", [testClientId]);
});

test('delivery > suspends client automation when both channels are bad', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_bothbad', handler, { priority: 1, category: 'operational' });

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'bad' WHERE id = $1", [testClientId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_bothbad', 'client', $2, 'email', NOW() - INTERVAL '1 minute'),
            ($1, 'proposal', 'disp_test_bothbad_future', 'client', $2, 'sms', NOW() + INTERVAL '5 days')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT message_type, status FROM scheduled_messages WHERE message_type LIKE 'disp_test_bothbad%' ORDER BY message_type"
  );
  // Both the due row and the future row are suppressed by the suspension cascade.
  assert.strictEqual(rows.find(r => r.message_type === 'disp_test_bothbad').status, 'suppressed');
  assert.strictEqual(rows.find(r => r.message_type === 'disp_test_bothbad_future').status, 'suppressed');

  await pool.query("UPDATE clients SET email_status = 'ok', phone_status = 'ok' WHERE id = $1", [testClientId]);
});
```

- [ ] **Step 7: Run the dispatcher tests to verify they fail**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected, against the pre-Step-8 code:
- The substitution test (`disp_test_subst`) FAILS — `checkSuppression` flips the `email_status='bad'` row straight to `'suppressed'`, channel stays `'email'`.
- The multiChannel test (`disp_test_multichan`) FAILS — `checkSuppression` suppresses it too, but for the wrong reason and before `resolveDelivery`/`multiChannel` exist; once `resolveDelivery` lands without the multiChannel branch it would *substitute* and the row would end `'sent'` on `'sms'`. This test is what locks in the no-substitution rule.
- The both-bad test (`disp_test_bothbad`) partly passes today (due row suppressed) but the future row stays `pending` — so it FAILS the future-row assertion.
- The mid-batch test (`disp_test_midbatch_*`, added in Step 8.5) FAILS until the 8e stale-row guard lands — row B is re-processed by `resolveDelivery`'s both-bad branch, which overwrites B's cascade `'suspended:'` message, so `cascadeSuppressed.length` is 0 (assertion expects 1) and `branchSuppressed.length` is 2 (assertion expects 1).

(Step 8.5's test is appended as part of Step 8.5, so on the first Step 7 run it is not yet in the file; run Step 7, then do Steps 8 and 8.5, then the final re-run after Step 9 covers every test. The bullet is listed here so the full failing set is documented in one place.)

- [ ] **Step 8: Move the per-channel checks out of `checkSuppression`, add the stale-row guard, and add `resolveDelivery` to `dispatchRow`**

In `server/utils/scheduledMessageDispatcher.js`:

**8a.** Add the new requires at the top of the file, after the existing `const { PUBLIC_SITE_URL } = require('./urls');` line:

```javascript
const { resolveChannelFallback } = require('./channelFallback');
const { suspendClientAutomation } = require('./clientAutomationSuspension');
```

**8b.** Strip the two per-channel client suppression blocks from `checkSuppression`, and **only** those two blocks. This is a **surgical edit**, not a whole-function replace. The `checkSuppression` function keeps its signature, its archived-proposal check, and (if Phase 4a executed first) any `recipient_type IN ('staff','admin')` branch Phase 4a added. Do **not** quote-and-replace the whole function body: a whole-function replace would silently delete a staff/admin branch Phase 4a may already have inserted.

> **Cross-plan note.** Phase 4a also edits `checkSuppression`: it *adds* `recipient_type IN ('staff','admin')` branches (staff/admin comm-prefs). Phase 4b *removes* the two client per-channel blocks. The two plans' edits to this one function must **compose**: whichever plan lands second must find its anchor still present. That is why this step's find/replace targets only the two `if (row.channel === ...)` blocks (which Phase 4a never touches) and leaves the archived check and any staff/admin branch alone. If you executed Phase 4a first, you will see its staff/admin branch in the function. Leave it in place; this edit only removes the client per-channel blocks below.

Find this exact fragment inside `checkSuppression` (the comment line plus the two `if (row.channel === ...)` blocks wrapped in the `recipient_type === 'client'` guard):

```javascript
  // Per-channel comm-prefs (clients only — staff/admin prefs handled by later plans).
  if (row.recipient_type === 'client' && recipient) {
    if (row.channel === 'email') {
      const prefs = recipient.communication_preferences || {};
      if (prefs.email_enabled === false) {
        return 'suppressed: client.communication_preferences.email_enabled is false';
      }
      if (recipient.email_status === 'bad') {
        return 'suppressed: client.email_status is bad';
      }
    }
    if (row.channel === 'sms') {
      const prefs = recipient.communication_preferences || {};
      if (prefs.sms_enabled === false) {
        return 'suppressed: client.communication_preferences.sms_enabled is false';
      }
      if (recipient.phone_status === 'bad') {
        return 'suppressed: client.phone_status is bad';
      }
    }
  }
```

Replace just that fragment with this comment block (no logic):

```javascript
  // Per-channel client comm-prefs / bad-contact handling moved to the
  // resolveDelivery step in dispatchRow (Phase 4b): instead of a blunt
  // suppress, a single-channel operational touch substitutes the alternate
  // channel, and a both-channels-bad client has its automation suspended.
  // Phase 4a's recipient_type IN ('staff','admin') branch (if present) stays.
```

Do **not** touch the function's `async function checkSuppression({ row, entity, recipient }) {` signature line, the archived-proposal `if` above the removed fragment, or the final `return null;`. Leave the `recipient` parameter named `recipient`. `resolveDelivery` does the per-channel client work now, but `checkSuppression` still receives `recipient` and a Phase 4a staff/admin branch reads it. After this edit `checkSuppression` is: the archived check, the comment block above, optionally a Phase 4a staff/admin branch, then `return null;`.

**8c.** Add the `resolveDelivery` helper. Place it immediately after `shouldDeferForOverlap` (added in Task 1.3) and before the `// ─── Entity / recipient lookups ───` comment:

```javascript
// ─── Delivery resolution: channel substitution + both-bad suspension ──
// Spec 7.3 / 7.5. For a client-recipient row, decide whether to send on the
// row's channel, substitute the alternate channel, or suppress. On a
// no-working-channel result the client's remaining automation is suspended.
//
// Multi-channel touches (handler meta multiChannel:true) are scheduled as BOTH
// an email row and an SMS row. Spec 7.3 is explicit: a multi-channel touch gets
// NO substitution — if a multiChannel row's own channel is dead, that row
// simply suppresses and the paired row on the other channel still fires.
// Substituting would put a second message on the live channel ON TOP OF the
// paired row (e.g. a drink_plan_nudge email row substituted to SMS alongside
// the real drink_plan_nudge_sms row → two SMS). Substitution applies only to
// single-channel touches.
//
// Returns { proceed: true } when dispatch should continue (the row's `channel`
// field may have been rewritten), or { proceed: false } when the row was
// terminal-marked (suppressed) and dispatch must stop.
async function resolveDelivery(row, recipient) {
  // Staff/admin rows: Phase 4a owns their suppression in checkSuppression.
  // Phase 4b's substitution rule is a client rule only.
  if (row.recipient_type !== 'client' || !recipient) return { proceed: true };

  const meta = handlerMeta.get(row.message_type);
  const category = (meta && meta.category) || 'operational';
  const isMultiChannel = !!(meta && meta.multiChannel);
  const decision = resolveChannelFallback({ channel: row.channel, client: recipient, category });

  if (decision.action === 'proceed') {
    return { proceed: true };
  }

  if (decision.action === 'substitute') {
    if (isMultiChannel) {
      // Multi-channel touch (spec 7.3): no substitution. This row's own channel
      // is dead, so suppress just this row — the paired row on the other
      // channel handles delivery independently. Do NOT rewrite the channel.
      await pool.query(
        "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
        [row.id, `suppressed: ${row.channel} unavailable for client; multi-channel touch, paired row handles the other channel (spec 7.3)`]
      );
      return { proceed: false };
    }
    // Single-channel touch: rewrite the row's channel in place so the handler
    // and the final status='sent' write both reflect the channel actually
    // used. Mutate the in-memory row too so the handler sees the substituted
    // channel.
    await pool.query(
      'UPDATE scheduled_messages SET channel = $2 WHERE id = $1',
      [row.id, decision.channel]
    );
    row.channel = decision.channel;
    return { proceed: true };
  }

  // decision.action === 'suppress'
  if (decision.reason === 'no_working_channel') {
    // Both channels dead — suppress this row, suspend the rest of the client's
    // automation, and fire one admin alert.
    await pool.query(
      "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
      [row.id, 'suppressed: no working contact channel for client (spec 7.5)']
    );
    try {
      await suspendClientAutomation(row.recipient_id);
      await alertNoWorkingChannel(row.recipient_id, recipient);
    } catch (suspendErr) {
      Sentry.captureException(suspendErr, {
        tags: { dispatcher: 'scheduled_messages', step: 'suspend_client' },
        extra: { client_id: row.recipient_id },
      });
    }
    return { proceed: false };
  }

  // marketing_disabled or any other suppress reason — just suppress this row.
  await pool.query(
    "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
    [row.id, `suppressed: ${decision.reason || 'channel unavailable'}`]
  );
  return { proceed: false };
}

// Fire an admin alert that a client has no working contact channel. Uses the
// Phase 4b admin-notification helper when available; falls back to a direct
// email to ADMIN_EMAIL when Group 3 has not landed yet.
async function alertNoWorkingChannel(clientId, recipient) {
  const clientName = (recipient && recipient.name) || `client #${clientId}`;
  const subject = 'No working contact channel for a client';
  const bodyLine = `Automated messaging is suspended for ${clientName} (client #${clientId}). Both email and SMS are unavailable (opted out or bouncing). Update their contact details in the admin client page to resume automation.`;
  let helper = null;
  try {
    helper = require('./adminNotifications');
  } catch (_e) {
    helper = null;
  }
  if (helper && typeof helper.notifyAdminCategory === 'function') {
    await helper.notifyAdminCategory({
      category: 'system_error',
      subject,
      emailHtml: `<p>${bodyLine}</p>`,
      emailText: bodyLine,
      smsBody: `Dr. Bartender: messaging suspended for ${clientName}. No working email or phone on file. Update their contact info.`,
    });
    return;
  }
  // Fallback: direct email to the single admin address.
  const { sendEmail } = require('./email');
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail) {
    await sendEmail({
      to: adminEmail,
      subject,
      html: `<p>${bodyLine}</p>`,
      text: bodyLine,
    });
  }
}
```

**8d.** Call `resolveDelivery` inside `dispatchRow`. The current flow after `checkSuppression` runs the marketing gate, then `shouldDeferForOverlap`, then `handlers.get(...)`. Insert the `resolveDelivery` call **after `checkSuppression`'s suppression block and before the marketing gate**. Find:

```javascript
    const suppressionReason = await checkSuppression({ row, entity, recipient });
    if (suppressionReason) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
        [row.id, suppressionReason]
      );
      return;
    }

    // Marketing-class gate (Gemini Finding 5). The handler registry carries a
```

Replace with:

```javascript
    const suppressionReason = await checkSuppression({ row, entity, recipient });
    if (suppressionReason) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
        [row.id, suppressionReason]
      );
      return;
    }

    // Delivery resolution (spec 7.3 / 7.5): channel substitution + both-bad
    // suspension. May rewrite row.channel, or terminal-mark the row and stop.
    const delivery = await resolveDelivery(row, recipient);
    if (!delivery.proceed) {
      return;
    }

    // Marketing-class gate (Gemini Finding 5). The handler registry carries a
```

Note: `resolveDelivery` runs **before** the existing marketing gate, and `resolveChannelFallback` already returns `suppress` with reason `marketing_disabled` for a marketing-off client. So for the suppress case the marketing gate below is now genuinely **unreachable**: a marketing row for an opted-out client is terminal-marked by `resolveDelivery`, and `dispatchRow` returns before the gate. The gate is left in place only to keep this task's diff minimal and avoid editing an unrelated block; it is dead code for the suppress path and is safe to delete in a later cleanup. Do not delete it in this task. Removing it here would widen the diff and is out of Task 2.4's scope.

**8e.** Add the stale-row guard at the top of `dispatchRow`. `dispatchPending` loads a whole batch into memory and dispatches rows one at a time; `resolveDelivery`'s both-bad path calls `suspendClientAutomation`, which flips that client's *other* pending rows to `'suppressed'` in the DB mid-batch. A later row in the same in-memory batch for that client must NOT be re-processed (it would fire a duplicate "no working contact channel" admin alert). The guard re-verifies the row is still `pending` immediately before processing. Find the start of the `dispatchRow` `try` block:

```javascript
async function dispatchRow(row) {
  let entity, recipient;
  try {
    [entity, recipient] = await Promise.all([
      lookupEntity(row.entity_type, row.entity_id),
      lookupRecipient(row.recipient_type, row.recipient_id),
    ]);
```

Replace with:

```javascript
async function dispatchRow(row) {
  let entity, recipient;
  try {
    // Stale-row guard. The batch was SELECTed into memory at the top of the
    // tick; a row processed earlier in the same batch may have flipped this
    // row's status via suspendClientAutomation (the both-channels-bad cascade
    // in resolveDelivery flips a client's other pending/deferred rows to
    // 'suppressed'). Re-verify the row is still 'pending' before doing any
    // work — if it is not, it was already handled this tick; skip it silently
    // so resolveDelivery does not re-fire a duplicate admin alert.
    const stillPending = await pool.query(
      "SELECT 1 FROM scheduled_messages WHERE id = $1 AND status = 'pending'",
      [row.id]
    );
    if (stillPending.rowCount === 0) {
      return;
    }

    [entity, recipient] = await Promise.all([
      lookupEntity(row.entity_type, row.entity_id),
      lookupRecipient(row.recipient_type, row.recipient_id),
    ]);
```

- [ ] **Step 8.5: Write the failing test for the mid-batch stale-row guard**

Append to `server/utils/scheduledMessageDispatcher.test.js`. This test proves `resolveDelivery`'s both-bad branch (which fires the admin alert) runs **exactly once** even when two same-client rows are in one batch.

The discriminating signal is the `error_message`. Two distinct strings are at play:
- `resolveDelivery`'s both-bad branch writes `'suppressed: no working contact channel for client (spec 7.5)'`.
- `suspendClientAutomation` (the cascade) writes `'suspended: no working contact channel for client (spec 7.5)'`.

WITH the 8e guard: row A runs the both-bad branch (`error_message` starts `'suppressed:'`); `suspendClientAutomation` flips row B (`error_message` starts `'suspended:'`); row B is then skipped by the guard, so its `'suspended:'` message survives. Exactly one row starts with `'suspended:'`. WITHOUT the guard: row B is re-processed by `resolveDelivery`'s both-bad branch, which **overwrites** B's `'suspended:'` message with `'suppressed:'` and fires a second admin alert; then **zero** rows start with `'suspended:'`. So "exactly one `'suspended:'`-prefixed row" cleanly distinguishes the two. (A plain substring match on `'no working contact channel'` would not — both strings contain it.)

```javascript
test('delivery > mid-batch suppression does not double-process a second row for the same client', async () => {
  // Two operational single-channel rows for the same both-bad client, due in
  // the same tick. The first to dispatch hits the both-bad path: it suppresses
  // itself and suspendClientAutomation flips the second row to 'suppressed'.
  // The stale-row guard must skip the second row so resolveDelivery's both-bad
  // branch (and its admin alert) runs only once.
  const handlerA = mock.fn(async () => {});
  const handlerB = mock.fn(async () => {});
  registerHandler('disp_test_midbatch_a', handlerA, { priority: 1, category: 'operational' });
  registerHandler('disp_test_midbatch_b', handlerB, { priority: 2, category: 'operational' });

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'bad' WHERE id = $1", [testClientId]);
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_midbatch_a', 'client', $2, 'email', NOW() - INTERVAL '2 minutes'),
            ($1, 'proposal', 'disp_test_midbatch_b', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();

  assert.strictEqual(handlerA.mock.callCount(), 0, 'both-bad row A never reaches its handler');
  assert.strictEqual(handlerB.mock.callCount(), 0, 'row B never reaches its handler');
  const { rows } = await pool.query(
    `SELECT message_type, status, error_message FROM scheduled_messages
      WHERE message_type LIKE 'disp_test_midbatch_%' ORDER BY message_type`
  );
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every(r => r.status === 'suppressed'), 'both rows suppressed');
  // Exactly one row was suppressed by the suspension CASCADE ('suspended:'
  // prefix) and never re-processed. If the guard were missing, resolveDelivery
  // would re-run on row B and overwrite that message with 'suppressed:',
  // dropping the count to zero.
  const cascadeSuppressed = rows.filter(
    r => r.error_message && r.error_message.startsWith('suspended:')
  );
  assert.strictEqual(cascadeSuppressed.length, 1, 'row B keeps its cascade message — never re-processed');
  // And exactly one row ran resolveDelivery's both-bad branch ('suppressed:'
  // prefix with the no-working-channel reason).
  const branchSuppressed = rows.filter(
    r => r.error_message && r.error_message.startsWith('suppressed: no working contact channel')
  );
  assert.strictEqual(branchSuppressed.length, 1, 'the both-bad branch ran exactly once');

  await pool.query("UPDATE clients SET email_status = 'ok', phone_status = 'ok' WHERE id = $1", [testClientId]);
});
```

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: WITHOUT the 8e guard this test FAILS — row B is re-processed, its `'suspended:'` message is overwritten, so `cascadeSuppressed.length` is 0 and `branchSuppressed.length` is 2. WITH the 8e guard it PASSES — row B is skipped and keeps its `'suspended:'` message. Apply 8e, then re-run to confirm PASS. (Sort order: row A is priority 1 and row B priority 2, so the in-memory priority sort from Task 1.3 dispatches A first; A runs the both-bad branch and suspends B.)

- [ ] **Step 9: Rewrite the two legacy tests whose semantics this task changes**

Two pre-existing tests, `disp_test_optout` and `disp_test_bademail`, were written against the old blunt-suppress behavior. `disp_test_optout` disables only `email_enabled` and `disp_test_bademail` sets only `email_status='bad'`; under the old `checkSuppression` both produced a `'suppressed'` row. With `resolveDelivery` in place, a single bad/opted-out channel now **substitutes** to the still-usable alternate channel, so each of those rows would end `'sent'`, not `'suppressed'`, and the old assertions would fail.

Do **not** try to patch the assertions. **Rewrite both tests** so each sets BOTH channels unusable. Then the outcome is still a clean suppression and the test exercises the new code path correctly. Replace the `disp_test_optout` test body and the `disp_test_bademail` test body with the versions below.

For `disp_test_optout`, replace the whole test with:

```javascript
test('dispatcher > suppresses when the client has opted out of both channels', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_optout', handler);

  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(jsonb_set(communication_preferences, '{email_enabled}', 'false'::jsonb), '{sms_enabled}', 'false'::jsonb)
     WHERE id = $1`,
    [testClientId]
  );

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_optout', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_optout'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');

  await pool.query(
    `UPDATE clients SET communication_preferences =
       jsonb_set(jsonb_set(communication_preferences, '{email_enabled}', 'true'::jsonb), '{sms_enabled}', 'true'::jsonb)
     WHERE id = $1`,
    [testClientId]
  );
});
```

For `disp_test_bademail`, replace the whole test with:

```javascript
test('dispatcher > suppresses when both email_status and phone_status are bad', async () => {
  const handler = mock.fn(async () => {});
  registerHandler('disp_test_bademail', handler);

  await pool.query("UPDATE clients SET email_status = 'bad', phone_status = 'bad' WHERE id = $1", [testClientId]);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_bademail', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_bademail'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');

  await pool.query("UPDATE clients SET email_status = 'ok', phone_status = 'ok' WHERE id = $1", [testClientId]);
});
```

After replacing those two tests, run again:

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: PASS — every test.

- [ ] **Step 10: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(comms): channel substitution and both-bad suspension in the dispatcher"
```

**GROUP 2 COMPLETE.** Bounce/SMS-failure writers flip contact status to `'bad'`; the dispatcher substitutes the alternate channel for single-channel operational touches; a both-channels-bad client has its automation suspended with one admin alert.

---

# GROUP 3 — Multi-Admin Notification Model

Builds the first reader of `users.notification_preferences`: a central `notifyAdminCategory` helper that fans a notification out to every admin/manager subscribed to a category (joining `contractor_profiles` for SMS), a per-user notification-preferences API on `/api/me`, a settings-page tab to toggle subscriptions, and migration of every scattered single-address admin notification onto the helper.

### Category mapping (spec 8.3)

The 11 `notification_preferences` keys: `urgent_booking`, `urgent_consult`, `urgent_staffing`, `urgent_client_reply`, `payment_failure`, `feedback`, `system_error`, `routine_admin`, `routine_thumbtack`, `routine_hiring`, `routine_finance`.

Migration mapping — which existing call site maps to which category:

| Call site | Category |
|---|---|
| `balanceScheduler.js` autopay-failure email | `payment_failure` |
| `stripe.js` failed-payment email | `payment_failure` |
| `stripe.js` new-booking / balance-payment email (`signedAndPaidAdmin` / `paymentReceivedAdmin`) | `urgent_booking` |
| `proposals/crud.js` manual-payment-received email | `routine_finance` |
| `proposals/public.js` new-website-quote email + top-shelf-class email | `urgent_booking` |
| `proposals/publicToken.js` client-signed email | `urgent_booking` |
| `shifts.js` new-shift-request email | `urgent_staffing` |
| `application.js` new-staff-application email | `routine_hiring` |
| `drinkPlans.js` drink-plan-with-addons email | `routine_admin` |
| `thumbtack.js` new-lead email | `routine_thumbtack` |
| `lastMinuteAlert.js` last-minute-booking admin SMS | `urgent_booking` |
| `smsInbound.js` inbound-client alert | `urgent_client_reply` |
| `smsInbound.js` staff-CANT alert | `urgent_staffing` |
| `smsInbound.js` unknown-sender / no-action email | `routine_admin` |

The two Thumbtack message/review notifications (`thumbtack.js` lines ~365 and ~438) are slated for **removal** per spec section 6 ("Thumbtack notifies directly"). Removing them is out of this plan's scope — leave them alone; this plan migrates only the Thumbtack **new-lead** notification.

---

## Task 3.1: Build the `notifyAdminCategory` fan-out helper

**Files:**
- Create: `server/utils/adminNotifications.js`
- Test: `server/utils/adminNotifications.test.js`

`notifyAdminCategory` queries every admin/manager whose `notification_preferences->><category>` is `'true'`, joins `contractor_profiles` for the phone number, and sends email (always) plus SMS (only when an `smsBody` is supplied and the user has a usable phone). It is the single entry point for admin notifications.

**Critical: the `users` table has no `phone` column.** The query MUST `LEFT JOIN contractor_profiles cp ON cp.user_id = u.id` and read `cp.phone`. An admin with no `contractor_profiles` row gets `cp.phone = NULL` → email only.

**Send semantics:**
- Email is sent to each subscribed user's `users.email`.
- SMS is sent only when (a) the caller passed a non-empty `smsBody`, (b) the user has a `cp.phone` that `normalizePhone` accepts, and (c) the user's `communication_preferences.sms_enabled !== false`.
- All sends are best-effort: a failure to one recipient is caught, logged to Sentry, and does not abort the others. The helper never throws into its caller.

- [ ] **Step 1: Write the failing test**

Create `server/utils/adminNotifications.test.js`:

```javascript
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { resolveCategoryRecipients } = require('./adminNotifications');

let adminA;
let adminB;
let staffC;

before(async () => {
  // adminA: subscribed to payment_failure, has a contractor_profiles phone.
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, notification_preferences)
     VALUES ('admin-notif-a@example.com', 'x', 'admin',
       '{"payment_failure":true,"urgent_booking":false,"system_error":true}'::jsonb)
     RETURNING id`
  );
  adminA = a.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone) VALUES ($1, 'Admin A', '5125550001')`,
    [adminA]
  );

  // adminB: NOT subscribed to payment_failure, no contractor_profiles row.
  const b = await pool.query(
    `INSERT INTO users (email, password_hash, role, notification_preferences)
     VALUES ('admin-notif-b@example.com', 'x', 'manager',
       '{"payment_failure":false,"urgent_booking":true,"system_error":true}'::jsonb)
     RETURNING id`
  );
  adminB = b.rows[0].id;

  // staffC: role 'staff' — must never appear regardless of preferences.
  const c = await pool.query(
    `INSERT INTO users (email, password_hash, role, notification_preferences)
     VALUES ('staff-notif-c@example.com', 'x', 'staff',
       '{"payment_failure":true,"urgent_booking":true,"system_error":true}'::jsonb)
     RETURNING id`
  );
  staffC = c.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [adminA]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[adminA, adminB, staffC]]);
  await pool.end();
});

test('resolveCategoryRecipients > returns only subscribed admins/managers', async () => {
  const recips = await resolveCategoryRecipients('payment_failure');
  const ids = recips.map(r => r.id);
  assert.ok(ids.includes(adminA), 'adminA is subscribed to payment_failure');
  assert.ok(!ids.includes(adminB), 'adminB opted out of payment_failure');
  assert.ok(!ids.includes(staffC), 'staffC is role staff, never included');
});

test('resolveCategoryRecipients > includes the contractor_profiles phone when present', async () => {
  const recips = await resolveCategoryRecipients('payment_failure');
  const a = recips.find(r => r.id === adminA);
  assert.strictEqual(a.phone, '5125550001');
});

test('resolveCategoryRecipients > yields a null phone for an admin with no contractor_profiles row', async () => {
  const recips = await resolveCategoryRecipients('urgent_booking');
  const b = recips.find(r => r.id === adminB);
  assert.ok(b, 'adminB is subscribed to urgent_booking');
  assert.strictEqual(b.phone, null);
});

test('resolveCategoryRecipients > throws on an unknown category', async () => {
  await assert.rejects(() => resolveCategoryRecipients('not_a_category'), /category/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/utils/adminNotifications.test.js`
Expected: FAIL — `Cannot find module './adminNotifications'`.

- [ ] **Step 3: Create `server/utils/adminNotifications.js`**

```javascript
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { normalizePhone } = require('./sms');

// The 11 notification categories (spec 8.3). A notification declares its
// category; the helper fans it out to every admin/manager subscribed to it.
const VALID_CATEGORIES = new Set([
  'urgent_booking',
  'urgent_consult',
  'urgent_staffing',
  'urgent_client_reply',
  'payment_failure',
  'feedback',
  'system_error',
  'routine_admin',
  'routine_thumbtack',
  'routine_hiring',
  'routine_finance',
]);

/**
 * Resolve the admin/manager users subscribed to a notification category.
 *
 * `users` has NO phone column — staff/admin phone lives on contractor_profiles.
 * This LEFT JOINs contractor_profiles so an admin with no profile row still
 * resolves (phone = null → email-only recipient).
 *
 * @param {string} category - one of VALID_CATEGORIES.
 * @returns {Promise<Array<{id:number, email:string, phone:string|null, communication_preferences:object}>>}
 */
async function resolveCategoryRecipients(category) {
  if (!VALID_CATEGORIES.has(category)) {
    throw new Error(`resolveCategoryRecipients: unknown category '${category}'`);
  }
  // notification_preferences->>'<category>' returns the JSON value as text;
  // the column default sets every category to boolean true, so '= true' as
  // text matches. The category name is validated above against an allowlist,
  // so interpolating it into the ->> path is safe (it is never user input).
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.communication_preferences, cp.phone
       FROM users u
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.role IN ('admin', 'manager')
        AND COALESCE(u.notification_preferences->>$1, 'true') = 'true'`,
    [category]
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    phone: r.phone || null,
    communication_preferences: r.communication_preferences || {},
  }));
}

/**
 * Fan a notification out to every admin/manager subscribed to `category`.
 *
 * Email is sent to each recipient. SMS is sent only when `smsBody` is provided
 * AND the recipient has a usable contractor_profiles phone AND has not opted
 * out of SMS. Best-effort: a per-recipient failure is captured to Sentry and
 * does not abort the rest. The helper never throws into its caller.
 *
 * @param {Object} args
 * @param {string} args.category
 * @param {string} args.subject - email subject (no em dashes).
 * @param {string} args.emailHtml - email HTML body.
 * @param {string} [args.emailText] - email plain-text body.
 * @param {string} [args.smsBody] - when set, also SMS subscribed admins.
 * @returns {Promise<{emailed:number, texted:number}>}
 */
async function notifyAdminCategory({ category, subject, emailHtml, emailText, smsBody }) {
  let recipients = [];
  try {
    recipients = await resolveCategoryRecipients(category);
  } catch (err) {
    Sentry.captureException(err, { tags: { feature: 'admin-notification', category } });
    console.error(`[adminNotifications] resolve failed for '${category}':`, err.message);
    return { emailed: 0, texted: 0 };
  }

  let emailed = 0;
  let texted = 0;

  // SMS sender resolved lazily so a Phase-3-not-yet-landed environment still
  // works (sendAndLogSms is added to sms.js by Phase 3). Falls back to the
  // bare sendSMS when sendAndLogSms is absent.
  let smsSend = null;
  if (smsBody) {
    const smsModule = require('./sms');
    if (typeof smsModule.sendAndLogSms === 'function') {
      smsSend = (to) => smsModule.sendAndLogSms({
        to, body: smsBody, clientId: null, messageType: `admin_${category}`,
      });
    } else if (typeof smsModule.sendSMS === 'function') {
      smsSend = (to) => smsModule.sendSMS({ to, body: smsBody });
    }
  }

  for (const r of recipients) {
    if (r.email) {
      try {
        await sendEmail({ to: r.email, subject, html: emailHtml, text: emailText });
        emailed += 1;
      } catch (err) {
        Sentry.captureException(err, {
          tags: { feature: 'admin-notification', category, channel: 'email' },
          extra: { recipient_id: r.id },
        });
        console.error(`[adminNotifications] email to user ${r.id} failed:`, err.message);
      }
    }
    if (smsSend) {
      const prefs = r.communication_preferences || {};
      const phone = normalizePhone(r.phone || '');
      if (phone && prefs.sms_enabled !== false) {
        try {
          await smsSend(phone);
          texted += 1;
        } catch (err) {
          Sentry.captureException(err, {
            tags: { feature: 'admin-notification', category, channel: 'sms' },
            extra: { recipient_id: r.id },
          });
          console.error(`[adminNotifications] SMS to user ${r.id} failed:`, err.message);
        }
      }
    }
  }

  return { emailed, texted };
}

module.exports = { notifyAdminCategory, resolveCategoryRecipients, VALID_CATEGORIES };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/utils/adminNotifications.test.js`
Expected: PASS — all four tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/adminNotifications.js server/utils/adminNotifications.test.js
git commit -m "feat(comms): add notifyAdminCategory multi-admin notification fan-out helper"
```

---

## Task 3.2: Add the per-user notification-preferences API

**Files:**
- Modify: `server/routes/me.js`
- Test: `server/routes/me.notificationPrefs.test.js`

A user reads their own `notification_preferences` and toggles individual categories. `/api/me` is the natural home (it is already `auth`-gated and serves the current user's own data). Add `GET /api/me/notification-preferences` and `PATCH /api/me/notification-preferences`.

Only admin/manager users have meaningful preferences (staff are never notification recipients). The GET returns the prefs for any authenticated user; the PATCH accepts only the 11 known category keys and only boolean values, and is allowed for admin/manager only (a staff user toggling them is harmless but pointless — restrict to keep the surface tight).

- [ ] **Step 1: Write the failing test**

Create `server/routes/me.notificationPrefs.test.js`:

```javascript
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { applyNotificationPrefPatch } = require('./me');

// applyNotificationPrefPatch is a pure helper exported from me.js for testing:
// given the current prefs object and a patch body, it returns the merged prefs
// or throws a ValidationError on a bad key / non-boolean value.

test('applyNotificationPrefPatch > merges a valid boolean toggle', () => {
  const current = { payment_failure: true, urgent_booking: true };
  const merged = applyNotificationPrefPatch(current, { payment_failure: false });
  assert.strictEqual(merged.payment_failure, false);
  assert.strictEqual(merged.urgent_booking, true);
});

test('applyNotificationPrefPatch > rejects an unknown category key', () => {
  assert.throws(
    () => applyNotificationPrefPatch({}, { not_a_category: true }),
    /category/
  );
});

test('applyNotificationPrefPatch > rejects a non-boolean value', () => {
  assert.throws(
    () => applyNotificationPrefPatch({}, { payment_failure: 'yes' }),
    /boolean/
  );
});

test('applyNotificationPrefPatch > rejects an empty patch', () => {
  assert.throws(
    () => applyNotificationPrefPatch({}, {}),
    /at least one/
  );
});

after(async () => {
  await pool.end();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/routes/me.notificationPrefs.test.js`
Expected: FAIL — `applyNotificationPrefPatch` is not exported from `me.js`.

- [ ] **Step 3: Add the helper, routes, and export to `me.js`**

In `server/routes/me.js`:

**3a.** The file currently requires `{ ValidationError }` from `../utils/errors` — confirm that line exists (it does, at line 7: `const { ValidationError } = require('../utils/errors');`). Also confirm `requireAdminOrManager` is available. The file imports `{ auth }` only — add `requireAdminOrManager`. Find:

```javascript
const { auth } = require('../middleware/auth');
```

Replace with:

```javascript
const { auth, requireAdminOrManager } = require('../middleware/auth');
```

**3b.** Add the category constant and pure helper near the top of the file, after the `const router = express.Router();` / `router.use(auth);` lines and before `router.get('/tip-page', ...)`:

```javascript
// Notification categories (spec 8.3). The single source of truth for valid
// keys is server/utils/adminNotifications.js VALID_CATEGORIES; mirrored here
// as an array for the PATCH allowlist so this route does not depend on the
// dispatcher module just for a constant.
const NOTIFICATION_CATEGORIES = [
  'urgent_booking',
  'urgent_consult',
  'urgent_staffing',
  'urgent_client_reply',
  'payment_failure',
  'feedback',
  'system_error',
  'routine_admin',
  'routine_thumbtack',
  'routine_hiring',
  'routine_finance',
];
const NOTIFICATION_CATEGORY_SET = new Set(NOTIFICATION_CATEGORIES);

/**
 * Merge a notification-preferences PATCH body into the current prefs object.
 * Pure — no I/O. Throws ValidationError on an unknown key, a non-boolean
 * value, or an empty patch. Exported for unit testing.
 *
 * @param {object} current - the user's current notification_preferences.
 * @param {object} patch - the request body: { <category>: boolean, ... }.
 * @returns {object} the merged preferences object.
 */
function applyNotificationPrefPatch(current, patch) {
  const keys = Object.keys(patch || {});
  if (keys.length === 0) {
    throw new ValidationError('Provide at least one category to update.');
  }
  const merged = { ...(current || {}) };
  for (const k of keys) {
    if (!NOTIFICATION_CATEGORY_SET.has(k)) {
      throw new ValidationError(`Unknown notification category: ${k}`);
    }
    if (typeof patch[k] !== 'boolean') {
      throw new ValidationError(`Notification category ${k} must be a boolean.`);
    }
    merged[k] = patch[k];
  }
  return merged;
}
```

**3c.** Add the two routes. Place them after the `router.get('/tips', ...)` handler, before `module.exports`:

```javascript
// GET /api/me/notification-preferences — the current user's category subscriptions.
router.get('/notification-preferences', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT notification_preferences FROM users WHERE id = $1',
    [req.user.id]
  );
  // Backfill any missing category to true so the UI always renders all 11
  // toggles even if a historical row predates a category being added.
  const stored = (rows[0] && rows[0].notification_preferences) || {};
  const prefs = {};
  for (const cat of NOTIFICATION_CATEGORIES) {
    prefs[cat] = stored[cat] !== false;
  }
  res.json({ notification_preferences: prefs, categories: NOTIFICATION_CATEGORIES });
}));

// PATCH /api/me/notification-preferences — toggle one or more categories.
// Admin/manager only: staff are never notification recipients.
router.patch('/notification-preferences', requireAdminOrManager, asyncHandler(async (req, res) => {
  const current = await pool.query(
    'SELECT notification_preferences FROM users WHERE id = $1',
    [req.user.id]
  );
  const merged = applyNotificationPrefPatch(
    (current.rows[0] && current.rows[0].notification_preferences) || {},
    req.body
  );
  const { rows } = await pool.query(
    `UPDATE users SET notification_preferences = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING notification_preferences`,
    [JSON.stringify(merged), req.user.id]
  );
  res.json({ notification_preferences: rows[0].notification_preferences });
}));
```

**3d.** Export the helper. Find the last line:

```javascript
module.exports = router;
```

Replace with:

```javascript
module.exports = router;
module.exports.applyNotificationPrefPatch = applyNotificationPrefPatch;
module.exports.NOTIFICATION_CATEGORIES = NOTIFICATION_CATEGORIES;
```

(Express routers are functions; attaching named exports to the function object is the pattern used elsewhere for test seams and does not break `app.use('/api/me', require('./routes/me'))`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/routes/me.notificationPrefs.test.js`
Expected: PASS — all four tests.

- [ ] **Step 5: Commit**

```bash
git add server/routes/me.js server/routes/me.notificationPrefs.test.js
git commit -m "feat(comms): add per-user notification-preferences API on /api/me"
```

---

## Task 3.3: Add the notification-preferences toggle UI

**Files:**
- Create: `client/src/pages/admin/NotificationSettings.js`
- Modify: `client/src/pages/admin/SettingsDashboard.js`

A new "Notifications" tab in the existing Settings dashboard. It loads the current user's preferences via `GET /api/me/notification-preferences`, renders a labelled checkbox per category, and saves changes via `PATCH /api/me/notification-preferences`. Uses `client/src/utils/api.js` (never raw fetch/axios) and the existing `useToast` for feedback. Loading and error states are explicit.

- [ ] **Step 1: Create `client/src/pages/admin/NotificationSettings.js`**

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

// Human-readable label + helper text for each notification category.
const CATEGORY_LABELS = {
  urgent_booking: {
    label: 'New bookings',
    help: 'A client signs and pays, or a last-minute booking comes in.',
  },
  urgent_consult: {
    label: 'Consults booked',
    help: 'A client books a phone consult.',
  },
  urgent_staffing: {
    label: 'Staffing alerts',
    help: 'A staff member requests a shift or drops one.',
  },
  urgent_client_reply: {
    label: 'Client text replies',
    help: 'A client texts back to one of our messages.',
  },
  payment_failure: {
    label: 'Payment failures',
    help: 'An autopay charge or a one-off payment fails.',
  },
  feedback: {
    label: 'Low-rating feedback',
    help: 'A client submits a low post-event rating.',
  },
  system_error: {
    label: 'System alerts',
    help: 'A scheduler or delivery problem needs attention.',
  },
  routine_admin: {
    label: 'Routine admin',
    help: 'General admin notices, such as an unrecognized inbound text.',
  },
  routine_thumbtack: {
    label: 'Thumbtack leads',
    help: 'A new lead arrives from Thumbtack.',
  },
  routine_hiring: {
    label: 'New applications',
    help: 'A new staff application is submitted.',
  },
  routine_finance: {
    label: 'Finance notices',
    help: 'Routine payment receipts and finance updates.',
  },
};

export default function NotificationSettings() {
  const toast = useToast();
  const [categories, setCategories] = useState([]);
  const [prefs, setPrefs] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await api.get('/me/notification-preferences');
      setCategories(res.data.categories || []);
      setPrefs(res.data.notification_preferences || {});
    } catch (err) {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (category) => {
    const next = !prefs[category];
    // Optimistic update; revert on failure.
    const prev = prefs;
    setPrefs({ ...prefs, [category]: next });
    setSaving(true);
    try {
      const res = await api.patch('/me/notification-preferences', { [category]: next });
      setPrefs(res.data.notification_preferences || { ...prev, [category]: next });
      toast.success('Notification preferences saved.');
    } catch (err) {
      setPrefs(prev);
      toast.error(err.message || 'Failed to save. Try again.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>
        Loading...
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card" style={{ padding: '1.5rem' }}>
        <div className="alert alert-error" style={{ marginBottom: '1rem' }}>
          Could not load your notification preferences.
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load}>Retry</button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', maxWidth: 560 }}>
      <div className="card" style={{ padding: '1.5rem' }}>
        <h3 style={{ marginBottom: '0.5rem', fontSize: '1rem' }}>Notification Subscriptions</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Choose which notifications you receive. These apply only to your account. Other admins
          and managers set their own.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          {categories.map((cat) => {
            const meta = CATEGORY_LABELS[cat] || { label: cat, help: '' };
            return (
              <label
                key={cat}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                  cursor: saving ? 'wait' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={prefs[cat] !== false}
                  disabled={saving}
                  onChange={() => toggle(cat)}
                  style={{ marginTop: '0.2rem' }}
                />
                <span>
                  <span style={{ fontWeight: 600, color: 'var(--deep-brown)' }}>{meta.label}</span>
                  {meta.help && (
                    <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                      {meta.help}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire the new tab into `SettingsDashboard.js`**

In `client/src/pages/admin/SettingsDashboard.js`:

**2a.** Add the import. Find:

```jsx
import CocktailMenuDashboard from './CocktailMenuDashboard';
import ConfirmModal from '../../components/ConfirmModal';
```

Replace with:

```jsx
import CocktailMenuDashboard from './CocktailMenuDashboard';
import NotificationSettings from './NotificationSettings';
import ConfirmModal from '../../components/ConfirmModal';
```

**2b.** Add the tab to the `TABS` array. Find:

```jsx
const TABS = [
  { key: 'drink-menu', label: 'Drink Menu' },
  { key: 'calendar', label: 'Calendar Sync' },
  { key: 'auto-assign', label: 'Auto-Assign' },
];
```

Replace with:

```jsx
const TABS = [
  { key: 'drink-menu', label: 'Drink Menu' },
  { key: 'calendar', label: 'Calendar Sync' },
  { key: 'auto-assign', label: 'Auto-Assign' },
  { key: 'notifications', label: 'Notifications' },
];
```

**2c.** Render the tab content. Find:

```jsx
      {activeTab === 'drink-menu' && <CocktailMenuDashboard embedded />}
      {activeTab === 'calendar' && <CalendarSyncSection />}
      {activeTab === 'auto-assign' && <AutoAssignSettings />}
```

Replace with:

```jsx
      {activeTab === 'drink-menu' && <CocktailMenuDashboard embedded />}
      {activeTab === 'calendar' && <CalendarSyncSection />}
      {activeTab === 'auto-assign' && <AutoAssignSettings />}
      {activeTab === 'notifications' && <NotificationSettings />}
```

**2d.** Update the page subtitle. Find:

```jsx
          <div className="page-subtitle">Drink menu, calendar sync, and auto-assign rules.</div>
```

Replace with:

```jsx
          <div className="page-subtitle">Drink menu, calendar sync, auto-assign rules, and notifications.</div>
```

- [ ] **Step 3: Verify the client build compiles**

The dev server / client build is shared with the `os` worktree — do **not** start a dev server here. Verify the change compiles with a production build (CI uses the same):

Run: `cd client && set CI=true&& npx react-scripts build`
(On a POSIX shell: `cd client && CI=true npx react-scripts build`.)
Expected: build succeeds with no errors. A successful build confirms the JSX and imports are valid. (Skip this step if a build is already running in `os`; instead inspect the diff for balanced JSX and confirm `api`, `useToast` are imported.)

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/NotificationSettings.js client/src/pages/admin/SettingsDashboard.js
git commit -m "feat(comms): add per-category notification-subscription toggle UI"
```

---

## Task 3.4: Migrate the scattered admin notifications onto `notifyAdminCategory` (Part 1 — utils)

**Files:**
- Modify: `server/utils/balanceScheduler.js`
- Modify: `server/utils/lastMinuteAlert.js`
- Modify: `server/utils/smsInbound.js`

This task migrates the three **util-file** admin-notification call sites. Each currently sends to `process.env.ADMIN_EMAIL` / `process.env.ADMIN_PHONE` directly. After migration each calls `notifyAdminCategory`, which fans out to every admin/manager subscribed to the category.

**Behavior-change note (deliberate, acceptable).** The old call sites fell back to `process.env.ADMIN_EMAIL || 'contact@drbartender.com'`, so they always had a recipient. `notifyAdminCategory` has **no env-var fallback**: if zero admin/manager rows are subscribed to the category, it sends nothing (it logs and returns `{ emailed: 0, texted: 0 }`). For most categories this is fine: the seed admin row always exists and its `users.notification_preferences` defaults every category to `true` (schema default), so it stays subscribed unless a human opts it out. One case is load-bearing. `balanceScheduler.js`'s autopay-failure alert is a **money-path** notification, and a silently-dropped autopay failure is a real operational miss. Treat the seed admin's default all-true `notification_preferences` as a load-bearing invariant: do not ship a state where no admin/manager subscribes to `payment_failure`. (The `notifyAdminCategory` `GET` route in Task 3.2 backfills any missing category to `true`, which protects historical rows; new admin rows inherit the schema default.)

No automated test — these are best-effort notification side-effects. Verify by inspection + lint.

- [ ] **Step 1: Migrate `balanceScheduler.js` (autopay-failure email → `payment_failure`)**

In `server/utils/balanceScheduler.js`, add the require near the top, after `const { sendEmail } = require('./email');`:

```javascript
const { notifyAdminCategory } = require('./adminNotifications');
```

Find the autopay-failure send (around line 143):

```javascript
            if (recent.rowCount === 0) {
              await sendEmail({
                to: process.env.ADMIN_EMAIL || 'contact@drbartender.com',
                subject: `Autopay failed: proposal #${proposal.id} ($${(balanceCents / 100).toFixed(2)})`,
                html: `<p>Autopay attempt failed for proposal #${proposal.id}.</p><p>Error: ${err.message}</p>`,
              });
```

Replace with:

```javascript
            if (recent.rowCount === 0) {
              const failSubject = `Autopay failed: proposal #${proposal.id} ($${(balanceCents / 100).toFixed(2)})`;
              const failHtml = `<p>Autopay attempt failed for proposal #${proposal.id}.</p><p>Error: ${err.message}</p>`;
              await notifyAdminCategory({
                category: 'payment_failure',
                subject: failSubject,
                emailHtml: failHtml,
                emailText: `Autopay attempt failed for proposal #${proposal.id}. Error: ${err.message}`,
              });
```

- [ ] **Step 2: Migrate `lastMinuteAlert.js` (admin SMS → `urgent_booking`)**

In `server/utils/lastMinuteAlert.js`, add the require after `const { ADMIN_URL } = require('./urls');`:

```javascript
const { notifyAdminCategory } = require('./adminNotifications');
```

Find the admin SMS leg:

```javascript
    // Admin leg — ADMIN_PHONE is optional; skip + log if unset.
    const adminPhone = normalizePhone(process.env.ADMIN_PHONE || '');
    if (adminPhone) {
      try {
        await sendSMS({
          to: adminPhone,
          body: `⚠️ Last-minute booking: ${label} ${date} ${time} — ${loc}. Verify staffing now. ${ADMIN_URL}/proposals/${p.id}`,
        });
      } catch (e) {
        console.error('[lastMinuteAlert] admin SMS failed:', e.message);
      }
    } else {
      console.log('[lastMinuteAlert] ADMIN_PHONE unset — admin SMS skipped');
    }
```

Replace with:

```javascript
    // Admin leg — fan out to every admin/manager subscribed to urgent_booking,
    // both email and SMS. No em dashes in the copy.
    try {
      const lmBody = `Last-minute booking: ${label} ${date} ${time}, ${loc}. Verify staffing now. ${ADMIN_URL}/proposals/${p.id}`;
      await notifyAdminCategory({
        category: 'urgent_booking',
        subject: `Last-minute booking: ${label} on ${date}`,
        emailHtml: `<p>${lmBody}</p>`,
        emailText: lmBody,
        smsBody: lmBody,
      });
    } catch (e) {
      console.error('[lastMinuteAlert] admin notification failed:', e.message);
    }
```

(Note: the em dash and the warning emoji in the old copy are removed — `notifyAdminCategory` copy follows the no-em-dash rule.)

- [ ] **Step 3: Migrate `smsInbound.js` (three alert sites)**

In `server/utils/smsInbound.js`, add the require after `const { sendEmail } = require('./email');`:

```javascript
const { notifyAdminCategory } = require('./adminNotifications');
```

**3a.** `alertInboundClient` → `urgent_client_reply`. Replace the whole function:

```javascript
/** SMS the admin that a client texted in. ADMIN_PHONE unset means skipped. */
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
```

with:

```javascript
/** Notify subscribed admins that a client texted in (urgent_client_reply). */
async function alertInboundClient(client, body) {
  await safeAlert('inbound_client', async () => {
    const name = client.name || 'A client';
    // Truncate the inbound text so the outbound alert SMS cannot exceed
    // Twilio's 1600-char limit and fail to send.
    const snippet = (body || '').slice(0, 600);
    const line = `${name} texted Dr. Bartender: "${snippet}". Reply in the admin Messages page.`;
    await notifyAdminCategory({
      category: 'urgent_client_reply',
      subject: `${name} replied by text`,
      emailHtml: `<p>${escapeHtml(line)}</p>`,
      emailText: line,
      smsBody: line,
    });
  });
}
```

**3b.** `alertStaffCant` → `urgent_staffing`. The current function branches on lead time (SMS if <7 days, else email). `notifyAdminCategory` sends email always and SMS when `smsBody` is set, so keep the lead-time branch only to decide whether to pass `smsBody`. Replace the whole function:

```javascript
async function alertStaffCant(cant) {
  await safeAlert('staff_cant', async () => {
    const eventDate = new Date(cant.eventDate);
    const dayMs = 24 * 60 * 60 * 1000;
    const daysOut = Math.floor((eventDate.getTime() - Date.now()) / dayMs);
    const eventLabel = getEventTypeLabel({ event_type: cant.eventType, event_type_custom: cant.eventTypeCustom });
    const who = cant.clientName ? `${eventLabel} for ${cant.clientName}` : `shift #${cant.shiftId}`;
    const dateStr = eventDate.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
    const adminPhone = normalizePhone(process.env.ADMIN_PHONE || '');

    // Event under 7 days out fires an urgent SMS, but ONLY if ADMIN_PHONE is set.
    // If not set, fall through to email rather than dropping the alert.
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
```

with:

```javascript
async function alertStaffCant(cant) {
  await safeAlert('staff_cant', async () => {
    const eventDate = new Date(cant.eventDate);
    const dayMs = 24 * 60 * 60 * 1000;
    const daysOut = Math.floor((eventDate.getTime() - Date.now()) / dayMs);
    const eventLabel = getEventTypeLabel({ event_type: cant.eventType, event_type_custom: cant.eventTypeCustom });
    const who = cant.clientName ? `${eventLabel} for ${cant.clientName}` : `shift #${cant.shiftId}`;
    const dateStr = eventDate.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
    const outLabel = daysOut < 0 ? 'past due' : `${daysOut} days out`;

    // Always email subscribed admins. An event under 7 days out is urgent
    // enough to also text them. notifyAdminCategory sends SMS only when
    // smsBody is provided, so the lead-time branch just gates that argument.
    const smsLine = `Staffing alert: a bartender dropped the ${who} on ${dateStr} (${outLabel}). The shift is re-opened and needs restaffing.`;
    await notifyAdminCategory({
      category: 'urgent_staffing',
      subject: `Bartender dropped the ${dateStr} shift`,
      emailHtml: `<p>A bartender texted CANT for the <strong>${escapeHtml(who)}</strong> on <strong>${escapeHtml(dateStr)}</strong> (${escapeHtml(outLabel)}).</p><p>The shift has been re-opened and needs restaffing. It will show as unstaffed on the Events dashboard.</p>`,
      emailText: `A bartender texted CANT for the ${who} on ${dateStr} (${outLabel}). The shift has been re-opened and needs restaffing.`,
      ...(daysOut < 7 ? { smsBody: smsLine } : {}),
    });
  });
}
```

**3c.** `alertAdminEmail` → `routine_admin`. Replace the whole function:

```javascript
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

with:

```javascript
/** Notify subscribed admins about an inbound text the system took no action on. */
async function alertAdminEmail(subject, body) {
  await safeAlert('admin_email', async () => {
    await notifyAdminCategory({
      category: 'routine_admin',
      subject,
      emailHtml: `<p>${escapeHtml(body)}</p>`,
      emailText: body,
    });
  });
}
```

- [ ] **Step 4: Verify the three files lint clean**

Run: `npx eslint server/utils/balanceScheduler.js server/utils/lastMinuteAlert.js server/utils/smsInbound.js`
Expected: no errors. (If eslint flags `sendSMS` as unused in `lastMinuteAlert.js` — it is still used for the staff broadcast leg — confirm by inspection that the staff `for` loop still calls `sendSMS`; it does, so `sendSMS` stays imported. In `smsInbound.js`, `sendSMS` and `sendEmail` are still used by other functions in the file, e.g. the STOP-keyword reply — confirm they are not flagged unused.)

- [ ] **Step 5: Run the smsInbound test suite to confirm nothing broke**

Run: `node --test server/utils/smsInbound.test.js`
Expected: PASS. (The inbound tests exercise STOP/CONFIRM/CANT parsing, not the alert fan-out; the alert functions are best-effort and wrapped in `safeAlert`. If a test mocks `sendEmail`/`sendSMS` and now the alert path calls `notifyAdminCategory` instead, the alert simply becomes a no-op in the test DB if no admin rows match — the inbound-action assertions still pass. If any test explicitly asserts an admin alert was sent, update it to assert via `notifyAdminCategory` or relax it to the inbound-action outcome.)

- [ ] **Step 6: Commit**

```bash
git add server/utils/balanceScheduler.js server/utils/lastMinuteAlert.js server/utils/smsInbound.js
git commit -m "feat(comms): migrate util-file admin alerts onto notifyAdminCategory"
```

---

## Task 3.5: Migrate the scattered admin notifications onto `notifyAdminCategory` (Part 2 — routes)

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/routes/proposals/crud.js`
- Modify: `server/routes/proposals/public.js`
- Modify: `server/routes/proposals/publicToken.js`
- Modify: `server/routes/stripe.js`
- Modify: `server/routes/thumbtack.js`
- Modify: `server/routes/application.js`
- Modify: `server/routes/drinkPlans.js`

Migrates the eight **route-file** admin-notification call sites. Each currently does `const adminEmail = process.env.ADMIN_EMAIL; if (adminEmail) { ... sendEmail({ to: adminEmail, ... }) }`. The migration replaces each with a `notifyAdminCategory` call using the category from the mapping table. The existing templates (`signedAndPaidAdmin`, `shiftRequestAdmin`, etc.) produce `{ subject, html, text }` — pass `tpl.subject`, `tpl.html`, and `tpl.text` through to `notifyAdminCategory`.

**Em-dash note (deliberate).** Several pre-existing admin email templates contain em dashes in their copy: `clientSignedAdmin`'s subject (`Proposal Signed: ${name} — ...`), `signedAndPaidAdmin`'s subject (`Signed & Paid ($${amount}): ${name} — ...`), `shiftRequestAdmin`'s subject (`Shift Request: ${staffName} — ...`), and `newThumbtackLeadAdmin`'s `.text` body (`${customerName} — ${customerPhone}`). This task routes those `tpl.subject` / `tpl.html` / `tpl.text` values through `notifyAdminCategory` **verbatim**; it does not de-em-dash existing template copy. That is intentional and in scope: the no-em-dash rule binds **newly-authored** copy, and the steps below that author new strings (the `stripe.js` failed-payment subject, the `drinkPlans.js` subject, and `lastMinuteAlert.js`'s body handled in Task 3.4) are written em-dash-free. Re-typesetting the shared admin templates is a separate copy pass, out of this plan's scope; leave their internal text alone.

No automated test — best-effort notification side-effects. Verify by inspection + lint per file.

- [ ] **Step 1: Migrate `shifts.js` (new shift request → `urgent_staffing`)**

In `server/routes/shifts.js`, add the require near the other requires at the top of the file:

```javascript
const { notifyAdminCategory } = require('../utils/adminNotifications');
```

Find the shift-request notification block (around line 280):

```javascript
  // Notify admin of new shift request (non-blocking)
  try {
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const shiftInfo = await pool.query(`
        SELECT s.event_type, s.event_type_custom, s.event_date, cp.preferred_name
        FROM shifts s LEFT JOIN contractor_profiles cp ON cp.user_id = $2
        WHERE s.id = $1
      `, [req.params.id, req.user.id]);
      const si = shiftInfo.rows[0];
      const staffName = si?.preferred_name || req.user.email || 'A staff member';
      const eventDate = si?.event_date
        ? new Date(si.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
        : 'TBD';
      const tpl = emailTemplates.shiftRequestAdmin({
        staffName,
        eventTypeLabel: getEventTypeLabel({ event_type: si?.event_type, event_type_custom: si?.event_type_custom }),
        eventDate,
        position: position || 'Bartender',
        adminUrl: `${ADMIN_URL}/staffing`,
      });
      await sendEmail({ to: adminEmail, ...tpl });
    }
  } catch (emailErr) {
    console.error('Shift request email failed (non-blocking):', emailErr);
  }
```

Replace with:

```javascript
  // Notify admins subscribed to urgent_staffing of a new shift request (non-blocking).
  try {
    const shiftInfo = await pool.query(`
      SELECT s.event_type, s.event_type_custom, s.event_date, cp.preferred_name
      FROM shifts s LEFT JOIN contractor_profiles cp ON cp.user_id = $2
      WHERE s.id = $1
    `, [req.params.id, req.user.id]);
    const si = shiftInfo.rows[0];
    const staffName = si?.preferred_name || req.user.email || 'A staff member';
    const eventDate = si?.event_date
      ? new Date(si.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' })
      : 'TBD';
    const tpl = emailTemplates.shiftRequestAdmin({
      staffName,
      eventTypeLabel: getEventTypeLabel({ event_type: si?.event_type, event_type_custom: si?.event_type_custom }),
      eventDate,
      position: position || 'Bartender',
      adminUrl: `${ADMIN_URL}/staffing`,
    });
    await notifyAdminCategory({
      category: 'urgent_staffing',
      subject: tpl.subject,
      emailHtml: tpl.html,
      emailText: tpl.text,
    });
  } catch (emailErr) {
    console.error('Shift request notification failed (non-blocking):', emailErr);
  }
```

- [ ] **Step 2: Migrate `proposals/crud.js` (manual payment received → `routine_finance`)**

In `server/routes/proposals/crud.js`, add the require near the top of the file with the other requires:

```javascript
const { notifyAdminCategory } = require('../../utils/adminNotifications');
```

Find the admin block (around line 899):

```javascript
    const adminEmail = process.env.ADMIN_EMAIL;
    if (adminEmail) {
      const adminUrl = `${ADMIN_URL}/proposals/${proposal.id}`;
      const tpl = emailTemplates.paymentReceivedAdmin({ clientName: pd?.client_name, eventTypeLabel, amount: amountFormatted, paymentType: payType, proposalId: proposal.id, adminUrl });
      await sendEmail({ to: adminEmail, ...tpl });
    }
```

Replace with:

```javascript
    {
      const adminUrl = `${ADMIN_URL}/proposals/${proposal.id}`;
      const tpl = emailTemplates.paymentReceivedAdmin({ clientName: pd?.client_name, eventTypeLabel, amount: amountFormatted, paymentType: payType, proposalId: proposal.id, adminUrl });
      await notifyAdminCategory({
        category: 'routine_finance',
        subject: tpl.subject,
        emailHtml: tpl.html,
        emailText: tpl.text,
      });
    }
```

- [ ] **Step 3: Migrate `proposals/public.js` (new website quote + top-shelf class → `urgent_booking`)**

In `server/routes/proposals/public.js`, add the require near the top with the other requires:

```javascript
const { notifyAdminCategory } = require('../../utils/adminNotifications');
```

Find the notification block (around line 431):

```javascript
    // Send email notifications (non-blocking)
    try {
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminUrl = `${ADMIN_URL}/proposals/${proposal.id}`;

      if (isTopShelfClass) {
        // Top Shelf: admin-only alert (pricing is TBD). Client already saw
        // "we'll follow up with custom pricing" on the wizard success screen.
        if (adminEmail) {
          const tpl = emailTemplates.topShelfClassRequestAdmin({
            clientName: client_name.trim(),
            clientEmail: client_email.trim().toLowerCase(),
            clientPhone: client_phone || null,
            spiritCategory: cleanClassOptions?.spirit_category || null,
            guestCount: gc,
            eventDate: event_date || null,
            eventLocation: composedLocation || null,
            proposalId: proposal.id,
            adminUrl,
          });
          await sendEmail({ to: adminEmail, ...tpl });
        }
      } else {
        // Client email via the shared helper. sendProposalSentEmail early-returns
        // unless the passed object has client_email — the INSERT ... RETURNING
        // proposal row has none (client_email / client_name live on `clients`),
        // so merge the request-body values onto it. token / event_type* come
        // from the proposal row.
        const eventTypeLabel = getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom });
        await sendProposalSentEmail(
          { ...proposal, client_name: client_name.trim(), client_email: client_email.trim().toLowerCase() },
          { actorType: 'client' },
        );

        if (adminEmail) {
          const tpl2 = emailTemplates.clientSignedAdmin({
            clientName: client_name.trim(),
            eventTypeLabel,
            proposalId: proposal.id,
            adminUrl
          });
          await sendEmail({ to: adminEmail, subject: `New Website Quote: ${eventTypeLabel}`, html: tpl2.html });
        }
      }
    } catch (emailErr) {
      Sentry.captureException(emailErr, { tags: { route: 'proposals/public/submit', phase: 'email' } });
      console.error('Public proposal emails failed (non-blocking):', emailErr);
    }
```

Replace with:

```javascript
    // Send email notifications (non-blocking)
    try {
      const adminUrl = `${ADMIN_URL}/proposals/${proposal.id}`;

      if (isTopShelfClass) {
        // Top Shelf: admin-only alert (pricing is TBD). Client already saw
        // "we'll follow up with custom pricing" on the wizard success screen.
        const tpl = emailTemplates.topShelfClassRequestAdmin({
          clientName: client_name.trim(),
          clientEmail: client_email.trim().toLowerCase(),
          clientPhone: client_phone || null,
          spiritCategory: cleanClassOptions?.spirit_category || null,
          guestCount: gc,
          eventDate: event_date || null,
          eventLocation: composedLocation || null,
          proposalId: proposal.id,
          adminUrl,
        });
        await notifyAdminCategory({
          category: 'urgent_booking',
          subject: tpl.subject,
          emailHtml: tpl.html,
          emailText: tpl.text,
        });
      } else {
        // Client email via the shared helper. sendProposalSentEmail early-returns
        // unless the passed object has client_email — the INSERT ... RETURNING
        // proposal row has none (client_email / client_name live on `clients`),
        // so merge the request-body values onto it. token / event_type* come
        // from the proposal row.
        const eventTypeLabel = getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom });
        await sendProposalSentEmail(
          { ...proposal, client_name: client_name.trim(), client_email: client_email.trim().toLowerCase() },
          { actorType: 'client' },
        );

        const tpl2 = emailTemplates.clientSignedAdmin({
          clientName: client_name.trim(),
          eventTypeLabel,
          proposalId: proposal.id,
          adminUrl,
        });
        await notifyAdminCategory({
          category: 'urgent_booking',
          subject: `New Website Quote: ${eventTypeLabel}`,
          emailHtml: tpl2.html,
          emailText: tpl2.text,
        });
      }
    } catch (emailErr) {
      Sentry.captureException(emailErr, { tags: { route: 'proposals/public/submit', phase: 'email' } });
      console.error('Public proposal emails failed (non-blocking):', emailErr);
    }
```

- [ ] **Step 4: Migrate `proposals/publicToken.js` (client signed → `urgent_booking`)**

In `server/routes/proposals/publicToken.js`, add the require near the top with the other requires:

```javascript
const { notifyAdminCategory } = require('../../utils/adminNotifications');
```

Find the admin block (around line 223):

```javascript
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail && pd) {
        const adminUrl = `${ADMIN_URL}/proposals/${pd.id}`;
        const tpl = emailTemplates.clientSignedAdmin({ clientName: pd.client_name, eventTypeLabel, proposalId: pd.id, adminUrl });
        await sendEmail({ to: adminEmail, ...tpl });
      }
```

Replace with:

```javascript
      if (pd) {
        const adminUrl = `${ADMIN_URL}/proposals/${pd.id}`;
        const tpl = emailTemplates.clientSignedAdmin({ clientName: pd.client_name, eventTypeLabel, proposalId: pd.id, adminUrl });
        await notifyAdminCategory({
          category: 'urgent_booking',
          subject: tpl.subject,
          emailHtml: tpl.html,
          emailText: tpl.text,
        });
      }
```

- [ ] **Step 5: Migrate `stripe.js` (new booking / balance payment + failed payment)**

In `server/routes/stripe.js`, add the require near the top with the other requires:

```javascript
const { notifyAdminCategory } = require('../utils/adminNotifications');
```

**5a.** New-booking / balance-payment block (around line 1072). Find:

```javascript
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const adminUrl = `${ADMIN_URL}/proposals/${proposalId}`;
        // Admin notification consolidation: the standalone clientSignedAdmin fires
        // from the public-token signing route. In the canonical sign+pay coupled
        // flow, the payment arrives within ~6 hours of the signature, and the
        // post-commit notifier here suppresses the standalone paymentReceivedAdmin
        // in favor of signedAndPaidAdmin. Spec section 6.
        const tpl = isCoupledSigning
          ? emailTemplates.signedAndPaidAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl })
          : emailTemplates.paymentReceivedAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl });
        await sendEmail({ to: adminEmail, ...tpl });
      }
```

Replace with:

```javascript
      {
        const adminUrl = `${ADMIN_URL}/proposals/${proposalId}`;
        // Admin notification consolidation: the standalone clientSignedAdmin fires
        // from the public-token signing route. In the canonical sign+pay coupled
        // flow, the payment arrives within ~6 hours of the signature, and the
        // post-commit notifier here suppresses the standalone paymentReceivedAdmin
        // in favor of signedAndPaidAdmin. Spec section 6.
        const tpl = isCoupledSigning
          ? emailTemplates.signedAndPaidAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl })
          : emailTemplates.paymentReceivedAdmin({ clientName: pi?.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, proposalId, adminUrl });
        // A coupled sign+pay is a new booking (urgent_booking); a standalone
        // balance payment is a routine finance receipt (routine_finance).
        await notifyAdminCategory({
          category: isCoupledSigning ? 'urgent_booking' : 'routine_finance',
          subject: tpl.subject,
          emailHtml: tpl.html,
          emailText: tpl.text,
        });
      }
```

**5b.** Failed-payment block (around line 1457). Find:

```javascript
        // Notify admin of failed payment
        const adminEmail = process.env.ADMIN_EMAIL;
        if (adminEmail) {
          const payInfo = await pool.query(`
            SELECT p.event_type, p.event_type_custom, c.name AS client_name
            FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1
          `, [proposalId]);
          const pi = payInfo.rows[0];
          await sendEmail({
            to: adminEmail,
            subject: `Payment Failed — ${pi?.client_name || 'Unknown'} (${eventLabelFor(pi)})`,
            html: `<p>A ${paymentType} payment of $${(intent.amount / 100).toFixed(2)} failed for <strong>${pi?.client_name || 'Unknown'}</strong>.</p>
                   <p><strong>Reason:</strong> ${intent.last_payment_error?.message || 'Unknown error'}</p>
                   <p><a href="${ADMIN_URL}/proposals/${proposalId}">View Proposal</a></p>`,
          }).catch(e => console.error('Failed payment notification email error:', e));
        }
```

Replace with:

```javascript
        // Notify admins subscribed to payment_failure of a failed payment.
        {
          const payInfo = await pool.query(`
            SELECT p.event_type, p.event_type_custom, c.name AS client_name
            FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
            WHERE p.id = $1
          `, [proposalId]);
          const pi = payInfo.rows[0];
          const failReason = intent.last_payment_error?.message || 'Unknown error';
          const failAmount = `$${(intent.amount / 100).toFixed(2)}`;
          await notifyAdminCategory({
            category: 'payment_failure',
            subject: `Payment failed: ${pi?.client_name || 'Unknown'} (${eventLabelFor(pi)})`,
            emailHtml: `<p>A ${paymentType} payment of ${failAmount} failed for <strong>${pi?.client_name || 'Unknown'}</strong>.</p>
                   <p><strong>Reason:</strong> ${failReason}</p>
                   <p><a href="${ADMIN_URL}/proposals/${proposalId}">View Proposal</a></p>`,
            emailText: `A ${paymentType} payment of ${failAmount} failed for ${pi?.client_name || 'Unknown'}. Reason: ${failReason}. ${ADMIN_URL}/proposals/${proposalId}`,
          });
        }
```

(The em dash in the old subject `Payment Failed — ...` is replaced with a colon.)

- [ ] **Step 6: Migrate `thumbtack.js` (new lead → `routine_thumbtack`)**

In `server/routes/thumbtack.js`, add the require near the top with the other requires:

```javascript
const { notifyAdminCategory } = require('../utils/adminNotifications');
```

Find the new-lead block (around line 287):

```javascript
    // Admin notification (non-blocking)
    try {
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail) {
        const adminUrl = clientId ? `${ADMIN_URL}/clients/${clientId}` : null;
        const tpl = newThumbtackLeadAdmin({
          customerName: lead.customerName,
          customerPhone: lead.customerPhone,
```

Read the rest of that block to find the matching `sendEmail({ to: adminEmail, ... })` and closing `}` (it follows the `newThumbtackLeadAdmin({...})` call). The block ends with a `sendEmail({ to: adminEmail, ...tpl })` inside the `if (adminEmail)`. Replace the whole block from `const adminEmail = process.env.ADMIN_EMAIL;` through the closing `}` of the `if (adminEmail)` with:

```javascript
    // Admin notification (non-blocking)
    try {
      const adminUrl = clientId ? `${ADMIN_URL}/clients/${clientId}` : null;
      const tpl = newThumbtackLeadAdmin({
        customerName: lead.customerName,
        customerPhone: lead.customerPhone,
```

then keep the existing `newThumbtackLeadAdmin({...})` argument list exactly as-is, and replace the trailing `await sendEmail({ to: adminEmail, ...tpl });` plus its closing `if`-brace with:

```javascript
      await notifyAdminCategory({
        category: 'routine_thumbtack',
        subject: tpl.subject,
        emailHtml: tpl.html,
        emailText: tpl.text,
      });
```

The implementing agent must Read `server/routes/thumbtack.js` lines 287-320 first to see the exact `newThumbtackLeadAdmin({...})` argument lines and the exact closing braces, then perform the edit so the `newThumbtackLeadAdmin(...)` call is preserved verbatim and only the `process.env.ADMIN_EMAIL` guard + `sendEmail` are swapped for `notifyAdminCategory`. Do **not** touch the message-notification (line ~365) or review-notification (line ~438) blocks.

- [ ] **Step 7: Migrate `application.js` (new staff application → `routine_hiring`)**

In `server/routes/application.js`, add the require near the top with the other requires:

```javascript
const { notifyAdminCategory } = require('../utils/adminNotifications');
```

Find the admin block (around line 254):

```javascript
    try {
      const adminEmail = process.env.ADMIN_EMAIL;
      const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
      if (adminEmail) {
        const tpl = emailTemplates.newApplicationAdmin({ applicantName: full_name, applicantEmail: req.user.email, adminUrl: `${clientUrl}/admin/staff` });
        await sendEmail({ to: adminEmail, ...tpl });
      }
```

Replace with:

```javascript
    try {
      const clientUrl = process.env.CLIENT_URL || 'https://admin.drbartender.com';
      {
        const tpl = emailTemplates.newApplicationAdmin({ applicantName: full_name, applicantEmail: req.user.email, adminUrl: `${clientUrl}/admin/staff` });
        await notifyAdminCategory({
          category: 'routine_hiring',
          subject: tpl.subject,
          emailHtml: tpl.html,
          emailText: tpl.text,
        });
      }
```

(The implementing agent: Read `application.js` lines 252-268 first to confirm the rest of the `try` block, e.g. the `if (req.user.email)` applicant-confirmation send below it, is left intact. Only the `adminEmail` guard + admin `sendEmail` are migrated; the applicant-facing confirmation email below stays unchanged.)

- [ ] **Step 8: Migrate `drinkPlans.js` (drink-plan-with-addons admin email → `routine_admin`)**

In `server/routes/drinkPlans.js`, add the require near the top with the other requires:

```javascript
const { notifyAdminCategory } = require('../utils/adminNotifications');
```

Find the admin block (around line 418):

```javascript
      const adminEmail = process.env.ADMIN_EMAIL;
      // Admin heads-up stays throttled to balance-changing submits — a
      // zero-impact addon submit (all package-covered) doesn't warrant a ping.
      if (adminEmail && pendingNotifications.balanceChanged) {
        const daysUntil = pn.event_date
          ? Math.ceil((new Date(pn.event_date) - new Date()) / (1000 * 60 * 60 * 24))
          : null;
        const isUrgent = daysUntil !== null && daysUntil <= 14;
        sendEmail({
          to: adminEmail,
          subject: `${isUrgent ? 'URGENT: ' : ''}Drink Plan Submitted with Add-Ons — ${clientName}`,
          html: `<p><strong>${clientName}</strong> submitted their drink plan.</p>
                 <p><strong>Add-ons selected:</strong> ${addonNames.join(', ')}</p>
                 <p><strong>New total:</strong> $${snapshot.total.toFixed(2)}</p>
                 <p><strong>Amount paid:</strong> $${amountPaid.toFixed(2)}</p>
                 <p><strong>Balance due:</strong> $${(snapshot.total - amountPaid).toFixed(2)}</p>
                 ${isUrgent ? `<p style="color: red;"><strong>Event is in ${daysUntil} days!</strong></p>` : ''}
                 <p><a href="${ADMIN_URL}/proposals/${pn.id}">View Proposal</a></p>`,
        }).catch(emailErr => console.error('Admin notification email failed:', emailErr));
      }
```

Replace with:

```javascript
      // Admin heads-up stays throttled to balance-changing submits — a
      // zero-impact addon submit (all package-covered) doesn't warrant a ping.
      if (pendingNotifications.balanceChanged) {
        const daysUntil = pn.event_date
          ? Math.ceil((new Date(pn.event_date) - new Date()) / (1000 * 60 * 60 * 24))
          : null;
        const isUrgent = daysUntil !== null && daysUntil <= 14;
        const dpSubject = `${isUrgent ? 'Urgent: ' : ''}Drink plan submitted with add-ons, ${clientName}`;
        const dpHtml = `<p><strong>${clientName}</strong> submitted their drink plan.</p>
                 <p><strong>Add-ons selected:</strong> ${addonNames.join(', ')}</p>
                 <p><strong>New total:</strong> $${snapshot.total.toFixed(2)}</p>
                 <p><strong>Amount paid:</strong> $${amountPaid.toFixed(2)}</p>
                 <p><strong>Balance due:</strong> $${(snapshot.total - amountPaid).toFixed(2)}</p>
                 ${isUrgent ? `<p style="color: red;"><strong>Event is in ${daysUntil} days.</strong></p>` : ''}
                 <p><a href="${ADMIN_URL}/proposals/${pn.id}">View Proposal</a></p>`;
        notifyAdminCategory({
          category: 'routine_admin',
          subject: dpSubject,
          emailHtml: dpHtml,
          emailText: `${clientName} submitted their drink plan with add-ons: ${addonNames.join(', ')}. New total $${snapshot.total.toFixed(2)}, balance due $${(snapshot.total - amountPaid).toFixed(2)}. ${ADMIN_URL}/proposals/${pn.id}`,
        }).catch(emailErr => console.error('Admin notification failed:', emailErr));
      }
```

(The em dash in the old subject and the `URGENT:`/`Event is in N days!` exclamation are softened: colon and period. `notifyAdminCategory` already swallows its own errors, but the `.catch` is harmless and kept for parity with the original fire-and-forget style.)

- [ ] **Step 9: Verify all eight route files lint clean**

Run: `npx eslint server/routes/shifts.js server/routes/proposals/crud.js server/routes/proposals/public.js server/routes/proposals/publicToken.js server/routes/stripe.js server/routes/thumbtack.js server/routes/application.js server/routes/drinkPlans.js`
Expected: no errors. If eslint flags `sendEmail` as now-unused in any file, confirm by inspection whether that file still uses `sendEmail` for a **client-facing** send (most do — e.g. `stripe.js` sends `paymentReceivedClient`, `public.js` uses `sendProposalSentEmail`, `drinkPlans.js` sends `drinkPlanBalanceUpdate`). Only remove a `sendEmail` import if eslint flags it AND a full-file search confirms zero remaining `sendEmail(` calls. Do not remove an import that is still used.

- [ ] **Step 10: Commit**

```bash
git add server/routes/shifts.js server/routes/proposals/crud.js server/routes/proposals/public.js server/routes/proposals/publicToken.js server/routes/stripe.js server/routes/thumbtack.js server/routes/application.js server/routes/drinkPlans.js
git commit -m "feat(comms): migrate route-file admin alerts onto notifyAdminCategory"
```

---

## Task 3.6: Update documentation

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

Per the project's mandatory-documentation rule: new util files and a new component must be reflected in `README.md`'s folder tree, and the new `/api/me/notification-preferences` endpoints + new infrastructure must be reflected in `ARCHITECTURE.md`.

- [ ] **Step 1: Update `README.md`**

Open `README.md`, locate the `server/utils/` listing in the folder-structure tree, and add entries for the new files. Add lines (matching the file's existing indentation and bullet style) for:
- `adminNotifications.js` — multi-admin notification fan-out by category
- `channelFallback.js` — channel-substitution decision for single-channel touches
- `clientAutomationSuspension.js` — suspend a client's automation when both channels fail
- `smsDeliveryStatus.js` — flag bad phone numbers on SMS delivery failure

Locate the `client/src/pages/admin/` listing and add:
- `NotificationSettings.js` — per-user notification-subscription toggles

If `README.md` has a "Key Features" section, add a one-line bullet: "Notification infrastructure: per-channel daily overlap prevention, delivery-failure channel fallback, multi-admin notification subscriptions."

- [ ] **Step 2: Update `ARCHITECTURE.md`**

Open `ARCHITECTURE.md`. In the API route table, add two rows for the `/api/me` resource:
- `GET /api/me/notification-preferences` — current user's notification category subscriptions (auth)
- `PATCH /api/me/notification-preferences` — toggle notification categories (admin/manager)

In the section that describes the automated-communication / scheduled-message system (or a "Notification infrastructure" subsection — create one if absent), add a short paragraph:

"Phase 4b adds three cross-cutting pieces. Overlap prevention: each handler carries a `priority` (1-5) and `cooldownExempt` flag; `dispatchPending` defers a colliding lower-priority touch 24h by writing `status='deferred'`, then reactivates deferred rows when they next come due. Delivery-failure fallback: a Resend hard bounce flips `clients.email_status='bad'` and a Twilio failure flips `phone_status='bad'`; the dispatcher substitutes the alternate channel for single-channel operational touches, and suspends a client's remaining automation when both channels are dead. Multi-admin notifications: `notifyAdminCategory` (in `server/utils/adminNotifications.js`) fans a notification out to every admin/manager whose `users.notification_preferences` subscribes them to the category, joining `contractor_profiles` for SMS."

- [ ] **Step 3: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(comms): document Phase 4b notification infrastructure"
```

**GROUP 3 COMPLETE.** The multi-admin notification model is live: `notifyAdminCategory` fans out by subscription, users toggle their own categories in Settings, and all 11 scattered admin-notification call sites route through the helper.

---

# Plan Self-Review

Run after all tasks are written. This is the author's own checklist.

### Spec coverage

| Spec / contract requirement | Task |
|---|---|
| `priority` (1-5) + `cooldownExempt` + `multiChannel` on `registerHandler`/`getHandlerMeta` (contract §5; spec 7.3) | 1.1 |
| Retrofit `priority` onto the 14 existing handlers + `multiChannel` onto the 4 email handlers that gain SMS siblings (contract §5 table) | 1.2 |
| Dispatch-time rule: max 1/channel/client/day, lower priority deferred 24h via `status='deferred'` (spec 7.4) | 1.3 |
| Each tick's batch dispatched highest-priority-first via in-memory sort, so a same-tick same-client+channel collision cannot double-send (spec 7.4) | 1.3 (in-memory `rows.sort` in `dispatchPending`) |
| Hard cooldown exceptions for `event_eve` + `balance_due_today`(+`_sms`) (spec 7.4) | 1.1 (the flag) + 1.2 (set on `balance_due_today`) + 1.3 (honored) |
| Deferred rows re-evaluated (spec 7.4 "re-evaluate the next day") | 1.4 |
| Resend hard-bounce → `clients.email_status='bad'` (spec 7.5) | 2.1 |
| Twilio delivery failure → `clients.phone_status='bad'` (spec 7.5) | 2.2 |
| Channel substitution for single-channel operational touches (spec 7.3) | 2.3 + 2.4 |
| Multi-channel touches get NO substitution: a `multiChannel` row whose own channel is dead suppresses, the paired row fires (spec 7.3) | 1.1 (`multiChannel` flag) + 1.2 (retrofit) + 2.4 (`resolveDelivery` skips substitution for `multiChannel` rows) |
| Mid-batch suppression does not double-fire the both-bad admin alert (correctness) | 2.4 (Step 8e stale-row guard in `dispatchRow`) |
| Both channels bad → suspend automation + admin alert (spec 7.5) | 2.4 |
| Read `users.notification_preferences` (spec 8.3, "first reader") | 3.1 |
| Central admin-notification helper with category fan-out, `JOIN contractor_profiles` (spec 8.3, contract §8) | 3.1 |
| Per-category subscription toggle UI (spec 8.3) | 3.2 (API) + 3.3 (UI) |
| Migrate scattered `ADMIN_EMAIL`/`ADMIN_PHONE` call sites (spec 6, contract §9) | 3.4 + 3.5 |
| `users` has no `phone` column → join `contractor_profiles`, handle missing row (contract §8) | 3.1 (query + test for missing-row case) |
| Phase 3 `sendAndLogSms` consumed, not re-specified (contract §4) | 2.4 (substitution SMS), 3.1 (admin SMS), both with typeof fallback |
| Phase 4a also edits `scheduledMessageDispatcher.js`; the two plans' edits must compose (contract §6) | Noted in "Cross-plan seam". Group 1 edits `registerHandler`/`getHandlerMeta`/`dispatchPending`, which are different functions, so no collision. Group 2 (Task 2.4 Step 8b) edits `checkSuppression` as a **surgical fragment-replace**: it removes only the two `if (row.channel === ...)` client per-channel blocks, never the whole function. Phase 4a adds `recipient_type IN ('staff','admin')` branches to the same function. The two edits target disjoint fragments and both leave the archived-proposal check, so they compose regardless of execution order. See the cross-plan note inside Task 2.4 Step 8b. |

All spec sections in scope (7.3, 7.4, 7.5, 6, 8.3, 8.6) are covered. Spec 8.6 (Reply-To routing) is already implemented on `main` (`sendEmail` defaults `reply_to` to `ADMIN_EMAIL`) — no task needed; noted here so it is not mistaken for a gap.

### Placeholder scan

No "TBD", "implement later", "add error handling", or "similar to Task N" left in the plan. Every code step shows complete code. Every command has an expected result.

Two steps deliberately scope an edit to a fragment rather than a whole block. Both are correctness safeguards, not placeholders:
- Task 3.5 steps 6 and 7 say "Read the file first": `thumbtack.js` and `application.js` have multi-line argument lists and adjacent unrelated sends whose exact current text the agent must see before a surgical edit. The surrounding before/after code is fully specified; only the verbatim `newThumbtackLeadAdmin({...})` / applicant-confirmation lines are left for the agent to preserve as-is.
- Task 2.4 Step 8b is a **surgical fragment-replace** of `checkSuppression`: it gives a complete, exact find-fragment (the two `if (row.channel === ...)` client blocks) and a complete replacement (a comment block), and explicitly forbids replacing the whole function. The scoping is intentional: `checkSuppression` is also edited by Phase 4a, and a whole-function replace would clobber Phase 4a's staff/admin branch. The find and replace text are both fully specified; nothing is left open.

### Type consistency

- `getHandlerMeta` return shape: `{ offsetFromEventDate, anchor, category, priority, cooldownExempt, multiChannel }` — defined in 1.1, consumed in 1.3 (`meta.priority` in `shouldDeferForOverlap` and the `dispatchPending` in-memory sort; `meta.cooldownExempt`) and 2.4 (`meta.category`, `meta.multiChannel`). Consistent.
- `resolveChannelFallback` return: `{ action: 'proceed'|'substitute'|'suppress', channel?, reason? }` — defined in 2.3, consumed in 2.4 (`decision.action`, `decision.channel`, `decision.reason`). Consistent.
- `resolveDelivery` return: `{ proceed: boolean }` — defined and consumed within 2.4. Consistent.
- `notifyAdminCategory({ category, subject, emailHtml, emailText, smsBody })` — defined in 3.1, called with exactly those keys in 2.4 (`alertNoWorkingChannel`), 3.4, 3.5. Consistent. (Note: 2.4's `alertNoWorkingChannel` was written before 3.1 in execution order but uses a `require('./adminNotifications')` typeof guard, so the signature is forward-referenced safely.)
- `resolveCategoryRecipients` returns `[{ id, email, phone, communication_preferences }]` — defined in 3.1, consumed by `notifyAdminCategory` in the same file. Consistent.
- `applyNotificationPrefPatch(current, patch)` — defined and exported in 3.2, tested in 3.2's test file. Consistent.
- `markPhoneStatusFromSmsResult({ clientId, deliveryStatus })` and `suspendClientAutomation(clientId)` — defined in 2.2 / 2.4, each tested in its own file. `suspendClientAutomation` is also called inside `resolveDelivery` (2.4). Consistent.
- `status='deferred'` — written by 1.3, reactivated by 1.4, suppressed-from by `suspendClientAutomation` (2.4 includes `'deferred'` in its `status IN (...)`). Consistent and complete.
- `meta.multiChannel` — added to the registry in 1.1, retrofitted onto the four pre-existing email handlers in 1.2 (`balance_due_today`, `balance_late_t1`, `balance_late_t3`, `drip_touch_5_email`), consumed in 2.4's `resolveDelivery` to skip substitution. **Cross-plan:** the full multi-channel set is 5 pairs / 10 message types — `drink_plan_nudge`/`drink_plan_nudge_sms`, `balance_due_today`/`balance_due_today_sms`, `balance_late_t1`/`balance_late_t1_sms`, `balance_late_t3`/`balance_late_t3_sms`, `drip_touch_5_email`/`drip_touch_5_sms`. Phase 4b flags the four existing email handlers; Phase 3 flags the six handlers it newly creates (`drink_plan_nudge` + the five `_sms` variants). The split is documented in Task 1.2's `multiChannel` retrofit note so neither plan double-flags or misses a handler.
- `dispatchPending` batch order — the SQL `ORDER BY scheduled_for ASC` is followed by an in-memory `rows.sort` keyed on `handlerMeta.get(message_type).priority` (1.3). Both the sort and `shouldDeferForOverlap` read `priority` from the same `handlerMeta` registry, so a row's sort position and its overlap tie-break agree. An unregistered `message_type` sorts last (priority treated as `Number.MAX_SAFE_INTEGER`) and `shouldDeferForOverlap` treats it as priority 3 for the collision test — the divergence is intentional and harmless: sort-last only means it dispatches after registered rows, and an unregistered row is `failed` by `dispatchRow`'s no-handler branch before any send. Consistent.

No naming drift found. The plan is internally consistent and ready to execute.
