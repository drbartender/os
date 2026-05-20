# Pre-event Reminder Emails Implementation Plan (Plan 2c)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the three pre-event client-email touches: the T-7 event-week reminder, the T-30 long-lead recap (only for proposals booked 90+ days out), and the immediate reschedule notification email that also re-anchors every other pending scheduled message on the proposal to the new event date.

**Architecture:** Three pieces. (1) Two new email templates in `server/utils/emailTemplates.js` rendered with event-local times via the Plan 1 `eventTimezone` utility. (2) Two new dispatcher handlers (`event_week_reminder`, `long_lead_t30_recap`) registered against the Plan 2a `registerHandler` API, plus a scheduling helper that inserts pending `scheduled_messages` rows from the Stripe `payment_intent.succeeded` first-deposit branch. (3) A new `rescheduleProposal` helper invoked from the proposal PATCH handler when `event_date`, `event_start_time`, or `event_location` changes post-sign+pay — fires the reschedule email immediately and re-anchors every pending row in `scheduled_messages` for the proposal using a per-message-type offset mapping.

**Tech Stack:** PostgreSQL (raw SQL via `pg`), Node.js 18+ / Express 4.22, existing `node:test` + `node:assert/strict` pattern from `server/utils/*.test.js`, `@sentry/node` for non-blocking error reporting.

**Related docs:**
- Spec: `docs/superpowers/specs/2026-05-20-automated-communication-design.md` — sections 3.11 (event-week), 1.6 (long-lead T-30 recap), 3.13 (reschedule), 7.2 (time zones), 7.8 (reschedule handling)
- Plan 1 (foundation): `docs/superpowers/plans/2026-05-20-automated-communication-foundation.md` — provides `scheduled_messages` table, `eventTimezone.js` helpers, archive cascade
- Plan 2a (money-path emails): `docs/superpowers/plans/2026-05-20-comms-money-path-emails.md` — provides `scheduleMessage()` helper and `registerHandler()` dispatcher contract. Plan 2c is layered on top.
- Plan 2d (drink-plan nudges): the regular drink-plan nudge in Plan 2d handles the "drink plan or shopping list not yet ready" path. The T-30 recap in this plan defers to that nudge by suppressing on missing artifacts.

**Dispatcher contract (from Plan 2a):**

```js
// Insert a pending row:
const { scheduleMessage } = require('../utils/messageScheduling');
await scheduleMessage({ entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor });

// Register a handler:
const { registerHandler } = require('../utils/scheduledMessageDispatcher');
registerHandler('event_week_reminder', async ({ entity, recipient, scheduledMessage }) => {
  // render template, sendEmail, throw on failure (dispatcher catches and marks 'failed')
});
```

---

## File Structure

**Files to create:**
- `server/utils/rescheduleProposal.js` — orchestrates the immediate reschedule email + cascade re-anchor of pending `scheduled_messages` rows
- `server/utils/rescheduleProposal.test.js` — unit tests for re-anchor offset math and skip-on-archived
- `server/utils/preEventScheduling.js` — pure scheduler helpers: `schedulePreEventReminders(proposalId)` inserts the event-week + (conditional) T-30 recap rows. Also exposes the `messageOffsets` mapping consumed by the reschedule re-anchor.
- `server/utils/preEventScheduling.test.js` — unit tests for offset math, long-lead gating, idempotency
- `server/utils/preEventHandlers.js` — `registerHandler(...)` calls for `event_week_reminder` and `long_lead_t30_recap`, plus a one-line `registerAll()` export wired from `server/index.js`

**Files to modify:**
- `server/utils/emailTemplates.js` — add `eventWeekReminderClient`, `rescheduleNotificationClient`, `longLeadT30RecapClient` template functions
- `server/routes/stripe.js` — in the `payment_intent.succeeded` post-commit notifier (deposit / full / coupled sign+pay branch), invoke `schedulePreEventReminders(proposalId)` after the existing notification logic. Same anchor point as Plan 2a's balance reminder scheduling.
- `server/routes/proposals/crud.js` — in `router.patch('/:id', ...)` after the `UPDATE proposals` row is committed, detect post-sign+pay changes to `event_date` / `event_start_time` / `event_location` and call `rescheduleProposal({ proposalId, old, updated })`. Non-blocking on failure (Sentry + log, never break the PATCH).
- `server/index.js` — call `require('./utils/preEventHandlers').registerAll()` once at boot after the dispatcher is wired (the wiring is set up in Plan 2a; Plan 2c just adds a handler registration call).

**Files referenced (no edits):**
- `server/utils/eventTimezone.js` — `resolveEventTimezone(proposal)` + `formatEventLocalTime(date, tz, options)` from Plan 1
- `server/utils/urls.js` — `PUBLIC_SITE_URL` for the proposal/shopping-list links
- `server/utils/email.js` — existing `sendEmail({ to, subject, html, text })` wrapper around Resend
- `server/utils/messageScheduling.js` — `scheduleMessage()` helper from Plan 2a
- `server/utils/scheduledMessageDispatcher.js` — `registerHandler()` API from Plan 2a
- `server/utils/eventTypes.js` — `getEventTypeLabel({ event_type, event_type_custom })`

---

## Task 1: Add `eventWeekReminderClient` and `rescheduleNotificationClient` email templates

**Files:**
- Modify: `server/utils/emailTemplates.js` — append two new templates at the end of the file before `module.exports`
- Modify: the `module.exports` block at the bottom of the same file — add both new names

- [ ] **Step 1: Open `emailTemplates.js` and locate the export block**

Read `server/utils/emailTemplates.js` and find the existing `module.exports = { ... }` block near the end (around line 700+). The existing `wrapEmail()`, `ctaButton()`, and `esc()` helpers live near the top of the file. Confirm `esc()` exists at line 7-10. The pattern is: every template function returns `{ subject, html, text }`.

- [ ] **Step 2: Append `eventWeekReminderClient` template above `module.exports`**

Add this function just before the existing `module.exports = { ... }` block:

```javascript
/**
 * Event-week reminder (T-7 days). Email-only touch, fires from the
 * scheduled-message dispatcher. Renders event date / start time / location /
 * guest count / package using the proposal's event_timezone.
 *
 * @param {object} args
 * @param {string} args.clientName
 * @param {string} args.clientFirstName - separately computed for greeting
 * @param {string} args.eventDateLocal  - pre-formatted in event TZ, e.g. "Saturday, June 13, 2026"
 * @param {string} args.startTimeLocal  - pre-formatted in event TZ, e.g. "6:00 PM Central"
 * @param {string} args.location        - free-form location string
 * @param {number|string} args.guestCount
 * @param {string} args.packageName
 * @param {string} args.proposalUrl     - public proposal URL (used as fallback CTA)
 */
function eventWeekReminderClient({
  clientName, clientFirstName, eventDateLocal, startTimeLocal,
  location, guestCount, packageName, proposalUrl,
}) {
  const first = clientFirstName || clientName || 'there';
  return {
    subject: `One week until your ${eventDateLocal} event`,
    html: wrapEmail(`
      <p>Hi ${esc(first)}, can't wait for next week. Here's what we have on file:</p>
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Date</td><td style="padding:8px 12px;text-align:right;">${esc(eventDateLocal)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Time</td><td style="padding:8px 12px;text-align:right;">${esc(startTimeLocal)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Location</td><td style="padding:8px 12px;text-align:right;">${esc(location || 'TBD')}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Guest count</td><td style="padding:8px 12px;text-align:right;">${esc(String(guestCount ?? ''))}</td></tr>
        <tr><td style="padding:8px 12px;color:${BRAND.secondary};">Package</td><td style="padding:8px 12px;text-align:right;">${esc(packageName || '')}</td></tr>
      </table>
      <p>Anything changed? Reply here or call.</p>
      ${proposalUrl ? ctaButton(proposalUrl, 'View your proposal') : ''}
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${first}, can't wait for next week. Here's what we have on file:\n\nDate: ${eventDateLocal}\nTime: ${startTimeLocal}\nLocation: ${location || 'TBD'}\nGuest count: ${guestCount ?? ''}\nPackage: ${packageName || ''}\n\nAnything changed? Reply here or call.\n\n${proposalUrl ? `View your proposal: ${proposalUrl}\n\n` : ''}Cheers, Dallas`,
  };
}
```

- [ ] **Step 3: Append `rescheduleNotificationClient` template**

Add this function below the previous one, still above `module.exports`:

```javascript
/**
 * Reschedule notification — fires immediately when admin updates event_date,
 * event_start_time, or event_location on a post-sign+pay proposal.
 *
 * @param {object} args
 * @param {string} args.clientName
 * @param {string} args.clientFirstName
 * @param {string} args.oldDateLocal - pre-formatted in event TZ
 * @param {string} args.oldStartTimeLocal
 * @param {string} args.oldLocation
 * @param {string} args.newDateLocal
 * @param {string} args.newStartTimeLocal
 * @param {string} args.newLocation
 * @param {string} args.packageName
 * @param {number|string} args.guestCount
 * @param {string} args.totalFormatted        - already $-formatted, e.g. "1,250.00"
 * @param {string} args.balanceDueDateLocal   - pre-formatted in event TZ; may be ''
 * @param {boolean} args.autopayEnrolled
 */
function rescheduleNotificationClient({
  clientName, clientFirstName,
  oldDateLocal, oldStartTimeLocal, oldLocation,
  newDateLocal, newStartTimeLocal, newLocation,
  packageName, guestCount, totalFormatted,
  balanceDueDateLocal, autopayEnrolled,
}) {
  const first = clientFirstName || clientName || 'there';
  const balanceLine = balanceDueDateLocal
    ? `<li><strong>${autopayEnrolled ? 'Balance auto-charges' : 'Balance due'}</strong> on ${esc(balanceDueDateLocal)}</li>`
    : '';
  const balanceLineText = balanceDueDateLocal
    ? `${autopayEnrolled ? 'Balance auto-charges' : 'Balance due'} on ${balanceDueDateLocal}\n`
    : '';
  return {
    subject: 'Updated details for your event',
    html: wrapEmail(`
      <p>Hi ${esc(first)}, your event has been moved.</p>
      <p style="margin:1.5rem 0;"><strong>Old details:</strong> ${esc(oldDateLocal)} at ${esc(oldStartTimeLocal)}, ${esc(oldLocation || 'TBD')}<br/>
         <strong>New details:</strong> ${esc(newDateLocal)} at ${esc(newStartTimeLocal)}, ${esc(newLocation || 'TBD')}</p>
      <p>Everything else stays the same:</p>
      <ul>
        <li>Package: ${esc(packageName || '')}</li>
        <li>Guest count: ${esc(String(guestCount ?? ''))}</li>
        <li>Total: $${esc(String(totalFormatted))}</li>
        ${balanceLine}
      </ul>
      <p>Let me know if you have any questions or need to discuss anything.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${first}, your event has been moved.\n\nOld details: ${oldDateLocal} at ${oldStartTimeLocal}, ${oldLocation || 'TBD'}\nNew details: ${newDateLocal} at ${newStartTimeLocal}, ${newLocation || 'TBD'}\n\nEverything else stays the same:\nPackage: ${packageName || ''}\nGuest count: ${guestCount ?? ''}\nTotal: $${totalFormatted}\n${balanceLineText}\nLet me know if you have any questions or need to discuss anything.\n\nCheers, Dallas`,
  };
}
```

- [ ] **Step 4: Append `longLeadT30RecapClient` template**

Add this function below, still above `module.exports`:

```javascript
/**
 * Long-lead T-30 recap — fires at T-30 days for proposals whose booking lead
 * time was 90+ days. BYOB variant includes the shopping-list reminder; Hosted
 * variant omits it (caller passes barOption).
 *
 * @param {object} args
 * @param {string} args.clientName
 * @param {string} args.clientFirstName
 * @param {string} args.eventDateLocal     - pre-formatted in event TZ
 * @param {string} args.drinksSummary      - human-readable drink summary text, e.g. "2 cocktails, beer, wine"
 * @param {string} args.shoppingListUrl    - public link to the shopping list (BYOB only); empty for hosted
 * @param {'byob'|'hosted'} args.barOption
 */
function longLeadT30RecapClient({
  clientName, clientFirstName, eventDateLocal, drinksSummary,
  shoppingListUrl, barOption,
}) {
  const first = clientFirstName || clientName || 'there';
  const shoppingBlockHtml = barOption === 'byob'
    ? `<p><strong>Shopping list:</strong> <a href="${esc(shoppingListUrl)}">${esc(shoppingListUrl)}</a></p>
       <p>Reminder: best to do the actual shopping in the days leading up to the event so things stay fresh and unused items are still returnable.</p>`
    : '';
  const shoppingBlockText = barOption === 'byob'
    ? `\nShopping list: ${shoppingListUrl}\n\nReminder: best to do the actual shopping in the days leading up to the event so things stay fresh and unused items are still returnable.\n`
    : '';
  return {
    subject: `Three weeks out from your ${eventDateLocal} event`,
    html: wrapEmail(`
      <p>Hi ${esc(first)}, your event is in about 3 weeks. Quick recap of what you've got teed up:</p>
      <p><strong>Drinks:</strong> ${esc(drinksSummary || 'Drink plan submitted')}</p>
      ${shoppingBlockHtml}
      <p>Anything change? Reply here.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${first}, your event is in about 3 weeks. Quick recap of what you've got teed up:\n\nDrinks: ${drinksSummary || 'Drink plan submitted'}\n${shoppingBlockText}\nAnything change? Reply here.\n\nCheers, Dallas`,
  };
}
```

- [ ] **Step 5: Add the new names to `module.exports`**

Find the existing `module.exports = { ... }` block at the bottom of `emailTemplates.js`. Append `eventWeekReminderClient`, `rescheduleNotificationClient`, `longLeadT30RecapClient` to the exported names:

Before (existing block, names omitted for brevity):
```javascript
module.exports = {
  proposalSent,
  proposalSignedConfirmation,
  // ... existing names ...
};
```

After:
```javascript
module.exports = {
  proposalSent,
  proposalSignedConfirmation,
  // ... existing names ...
  eventWeekReminderClient,
  rescheduleNotificationClient,
  longLeadT30RecapClient,
};
```

Keep the existing names in place; only append.

- [ ] **Step 6: Sanity check the templates render**

Smoke-test the templates render without throwing. From the repo root:

```bash
node -e "const t = require('./server/utils/emailTemplates'); console.log(t.eventWeekReminderClient({ clientName:'Alex Doe', clientFirstName:'Alex', eventDateLocal:'Saturday, June 13, 2026', startTimeLocal:'6:00 PM Central', location:'Test Hall', guestCount:75, packageName:'BYOB Classic', proposalUrl:'https://example.com/p/abc' }).subject);"
```

Expected output: `One week until your Saturday, June 13, 2026 event`.

Repeat for `rescheduleNotificationClient` and `longLeadT30RecapClient` with minimal args.

- [ ] **Step 7: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(comms): add event-week, reschedule, and long-lead T-30 email templates"
```

---

## Task 2: Build `preEventScheduling.js` with offset mapping and scheduler helpers

**Files:**
- Create: `server/utils/preEventScheduling.js`
- Create: `server/utils/preEventScheduling.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/preEventScheduling.test.js`:

```javascript
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  computeScheduledFor,
  messageOffsets,
  shouldScheduleLongLeadRecap,
  schedulePreEventReminders,
} = require('./preEventScheduling');

const TEST_CLIENT_ID = -1;
const TEST_PROPOSAL_ID = -101;

beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id < 0");
  await pool.query("DELETE FROM proposals WHERE id < 0");
  await pool.query(
    `INSERT INTO clients (id, name, email, phone) VALUES ($1, 'Test Client', 't@example.com', '+15551112222')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_CLIENT_ID]
  );
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id < 0");
  await pool.query("DELETE FROM proposals WHERE id < 0");
  await pool.end();
});

// ── messageOffsets ──
test('messageOffsets > exposes T-7 for event_week_reminder', () => {
  assert.deepStrictEqual(messageOffsets.event_week_reminder, { daysBeforeEvent: 7, atHourLocal: 10 });
});

test('messageOffsets > exposes T-30 for long_lead_t30_recap', () => {
  assert.deepStrictEqual(messageOffsets.long_lead_t30_recap, { daysBeforeEvent: 30, atHourLocal: 10 });
});

// ── computeScheduledFor ──
test('computeScheduledFor > returns a UTC instant for T-7 at 10am event-local', () => {
  const proposal = {
    event_date: '2026-06-20',         // Saturday
    event_start_time: '18:00',
    event_timezone: 'America/Chicago',
  };
  const result = computeScheduledFor(proposal, 'event_week_reminder');
  // T-7 of 2026-06-20 = 2026-06-13. At 10:00 Chicago = 15:00 UTC (CDT).
  assert.strictEqual(result.toISOString(), '2026-06-13T15:00:00.000Z');
});

test('computeScheduledFor > honors event_timezone when computing the local hour', () => {
  const proposal = {
    event_date: '2026-06-20',
    event_start_time: '18:00',
    event_timezone: 'America/New_York',
  };
  const result = computeScheduledFor(proposal, 'event_week_reminder');
  // 10:00 EDT = 14:00 UTC
  assert.strictEqual(result.toISOString(), '2026-06-13T14:00:00.000Z');
});

test('computeScheduledFor > falls back to America/Chicago for invalid event_timezone', () => {
  const proposal = {
    event_date: '2026-06-20',
    event_start_time: '18:00',
    event_timezone: 'Bogus/Zone',
  };
  const result = computeScheduledFor(proposal, 'event_week_reminder');
  assert.strictEqual(result.toISOString(), '2026-06-13T15:00:00.000Z');
});

test('computeScheduledFor > throws on unknown messageType', () => {
  const proposal = { event_date: '2026-06-20', event_timezone: 'America/Chicago' };
  assert.throws(() => computeScheduledFor(proposal, 'not_a_real_type'), /Unknown messageType/);
});

// ── shouldScheduleLongLeadRecap ──
test('shouldScheduleLongLeadRecap > returns true when booking lead time is >= 90 days', () => {
  const proposal = { event_date: '2026-10-01', created_at: '2026-05-01T12:00:00Z' };
  // 2026-10-01 - 2026-05-01 = 153 days
  assert.strictEqual(shouldScheduleLongLeadRecap(proposal), true);
});

test('shouldScheduleLongLeadRecap > returns false when booking lead time is < 90 days', () => {
  const proposal = { event_date: '2026-07-15', created_at: '2026-05-01T12:00:00Z' };
  // 2026-07-15 - 2026-05-01 = 75 days
  assert.strictEqual(shouldScheduleLongLeadRecap(proposal), false);
});

test('shouldScheduleLongLeadRecap > returns false when event_date is missing', () => {
  const proposal = { event_date: null, created_at: '2026-05-01T12:00:00Z' };
  assert.strictEqual(shouldScheduleLongLeadRecap(proposal), false);
});

test('shouldScheduleLongLeadRecap > returns false when created_at is missing', () => {
  const proposal = { event_date: '2026-10-01', created_at: null };
  assert.strictEqual(shouldScheduleLongLeadRecap(proposal), false);
});

// ── schedulePreEventReminders ──
test('schedulePreEventReminders > schedules event_week_reminder (T-7) when proposal moves to deposit_paid', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-08-15', '18:00', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  const { rows } = await pool.query(
    `SELECT message_type, channel, recipient_type, recipient_id, status, scheduled_for
     FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 ORDER BY message_type`,
    [TEST_PROPOSAL_ID]
  );
  // Lead time = 2026-08-15 - 2026-07-01 = 45 days. < 90, so only event_week_reminder.
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].message_type, 'event_week_reminder');
  assert.strictEqual(rows[0].channel, 'email');
  assert.strictEqual(rows[0].status, 'pending');
  assert.strictEqual(rows[0].recipient_type, 'client');
  assert.strictEqual(rows[0].recipient_id, TEST_CLIENT_ID);
});

test('schedulePreEventReminders > also schedules long_lead_t30_recap when booking lead time >= 90 days', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-12-01', '18:00', 'America/Chicago', '2026-05-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  const { rows } = await pool.query(
    `SELECT message_type FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 ORDER BY message_type`,
    [TEST_PROPOSAL_ID]
  );
  assert.deepStrictEqual(rows.map((r) => r.message_type).sort(), ['event_week_reminder', 'long_lead_t30_recap']);
});

test('schedulePreEventReminders > is idempotent — calling twice does not duplicate rows', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-08-15', '18:00', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(rows[0].n, 1);
});

test('schedulePreEventReminders > skips entirely when proposal is archived', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, archive_reason, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'archived', 'client_cancelled', '2026-08-15', '18:00', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  await schedulePreEventReminders(TEST_PROPOSAL_ID);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(rows[0].n, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/utils/preEventScheduling.test.js
```

Expected: FAIL with `Cannot find module './preEventScheduling'`.

- [ ] **Step 3: Implement `preEventScheduling.js`**

Create `server/utils/preEventScheduling.js`:

```javascript
const { pool } = require('../db');
const { scheduleMessage } = require('./messageScheduling');
const { resolveEventTimezone } = require('./eventTimezone');

/**
 * Per-message-type schedule offset from event_date. All times are computed at
 * 10:00 in the proposal's event timezone (a tame morning hour that won't wake
 * anyone overseas and lands well before lunch in CT/ET).
 *
 * Consumed by:
 * - `schedulePreEventReminders` to insert new rows on deposit_paid
 * - `rescheduleProposal` to recompute `scheduled_for` on every pending row
 *
 * The keys are the canonical `message_type` strings used in `scheduled_messages`.
 * Anchored on event date — NOT on shift start time — because these are
 * client-facing reminders that should land in the morning regardless of the
 * actual event start time.
 */
const messageOffsets = {
  event_week_reminder: { daysBeforeEvent: 7, atHourLocal: 10 },
  long_lead_t30_recap: { daysBeforeEvent: 30, atHourLocal: 10 },
};

/**
 * Compute the UTC instant a pre-event reminder should send.
 *
 * Algorithm: take the event_date (YYYY-MM-DD), subtract the offset days, and
 * combine with the configured "at hour local" interpreted in the event TZ.
 * Returns a JS Date in UTC.
 *
 * @param {{ event_date: string|Date, event_timezone?: string }} proposal
 * @param {string} messageType - must be a key of `messageOffsets`
 * @returns {Date}
 */
function computeScheduledFor(proposal, messageType) {
  const offset = messageOffsets[messageType];
  if (!offset) {
    throw new Error(`Unknown messageType: ${messageType}`);
  }
  const tz = resolveEventTimezone(proposal);

  // Parse event_date as a calendar date (no time component, no TZ math yet)
  const eventDateStr = String(proposal.event_date).slice(0, 10);
  const [y, m, d] = eventDateStr.split('-').map(Number);

  // Subtract the offset days from the calendar date (UTC math is safe here —
  // we're only treating event_date as a calendar marker, not a moment)
  const shiftedUtcMs = Date.UTC(y, m - 1, d) - offset.daysBeforeEvent * 24 * 3600 * 1000;
  const shiftedDate = new Date(shiftedUtcMs);
  const shiftedYear = shiftedDate.getUTCFullYear();
  const shiftedMonth = shiftedDate.getUTCMonth() + 1;
  const shiftedDay = shiftedDate.getUTCDate();

  // Now compute "10:00 in tz on the shifted calendar date" → UTC.
  // We do this by formatting the shifted day in the target TZ and reading back
  // the UTC offset from Intl.DateTimeFormat for that instant.
  //
  // Strategy: form an ISO string for "shifted date at 10:00 in UTC", then
  // measure the timezone offset Intl reports for that instant, and subtract.
  // This handles DST transitions correctly because we ask Intl about the
  // specific date.
  const noonUtc = new Date(Date.UTC(shiftedYear, shiftedMonth - 1, shiftedDay, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(noonUtc);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-5"
  const match = /GMT([+-]?\d{1,2})(?::(\d{2}))?/.exec(offsetPart);
  const tzHours = match ? Number(match[1]) : 0;
  const tzMinutes = match && match[2] ? Number(match[2]) * (tzHours >= 0 ? 1 : -1) : 0;
  // 10:00 local → (10 - tzHours) UTC, with minute adjustment if any
  const utcHour = offset.atHourLocal - tzHours;
  const utcMinute = -tzMinutes;
  return new Date(Date.UTC(shiftedYear, shiftedMonth - 1, shiftedDay, utcHour, utcMinute, 0));
}

/**
 * @param {{ event_date: string|Date|null, created_at: string|Date|null }} proposal
 * @returns {boolean}
 */
function shouldScheduleLongLeadRecap(proposal) {
  if (!proposal.event_date || !proposal.created_at) return false;
  const eventMs = new Date(String(proposal.event_date).slice(0, 10) + 'T00:00:00Z').getTime();
  const bookedMs = new Date(proposal.created_at).getTime();
  if (!Number.isFinite(eventMs) || !Number.isFinite(bookedMs)) return false;
  const leadDays = (eventMs - bookedMs) / (24 * 3600 * 1000);
  return leadDays >= 90;
}

/**
 * Insert pending `scheduled_messages` rows for every pre-event reminder
 * applicable to this proposal. Idempotent: if a row for the same (entity,
 * message_type, recipient, channel) already exists, the insert is skipped.
 *
 * Skips entirely for archived proposals.
 *
 * Called from the Stripe `payment_intent.succeeded` post-commit notifier when
 * the deposit / full / coupled-sign+pay branch fires. Plan 2a also calls
 * sibling `scheduleBalanceReminders` from the same anchor point.
 *
 * @param {number|string} proposalId
 */
async function schedulePreEventReminders(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.client_id, p.status, p.event_date, p.event_start_time,
            p.event_timezone, p.created_at
       FROM proposals p
      WHERE p.id = $1`,
    [proposalId]
  );
  const proposal = rows[0];
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  // Always schedule the event-week reminder
  await insertIfMissing({
    entityType: 'proposal',
    entityId: proposal.id,
    messageType: 'event_week_reminder',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeScheduledFor(proposal, 'event_week_reminder'),
  });

  // Conditionally schedule the T-30 long-lead recap
  if (shouldScheduleLongLeadRecap(proposal)) {
    await insertIfMissing({
      entityType: 'proposal',
      entityId: proposal.id,
      messageType: 'long_lead_t30_recap',
      recipientType: 'client',
      recipientId: proposal.client_id,
      channel: 'email',
      scheduledFor: computeScheduledFor(proposal, 'long_lead_t30_recap'),
    });
  }
}

/**
 * Idempotent insert helper. Wraps `scheduleMessage` but first checks for an
 * existing pending row with the same (entity, message_type, recipient, channel).
 * Returns without inserting if one already exists.
 */
async function insertIfMissing({
  entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor,
}) {
  const existing = await pool.query(
    `SELECT id FROM scheduled_messages
      WHERE entity_type = $1 AND entity_id = $2
        AND message_type = $3
        AND recipient_type = $4 AND recipient_id = $5
        AND channel = $6
        AND status IN ('pending', 'sent', 'deferred')
      LIMIT 1`,
    [entityType, entityId, messageType, recipientType, recipientId, channel]
  );
  if (existing.rows.length > 0) return;
  await scheduleMessage({
    entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor,
  });
}

module.exports = {
  messageOffsets,
  computeScheduledFor,
  shouldScheduleLongLeadRecap,
  schedulePreEventReminders,
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
node --test server/utils/preEventScheduling.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/preEventScheduling.js server/utils/preEventScheduling.test.js
git commit -m "feat(comms): preEventScheduling helper with T-7 and conditional T-30 inserts"
```

---

## Task 3: Register handlers for `event_week_reminder` and `long_lead_t30_recap`

**Files:**
- Create: `server/utils/preEventHandlers.js`

- [ ] **Step 1: Implement the handlers file**

Create `server/utils/preEventHandlers.js`:

```javascript
const { pool } = require('../db');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { resolveEventTimezone, formatEventLocalTime } = require('./eventTimezone');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

/**
 * Look up the proposal + client + package data needed to render any pre-event
 * client email. Centralized here so both handlers below get the same shape.
 *
 * @param {number} proposalId
 * @returns {object|null} composite row, or null if proposal/client gone
 */
async function loadProposalContext(proposalId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.event_start_time,
            p.event_timezone, p.event_location, p.event_type, p.event_type_custom,
            p.guest_count, p.total_price, p.amount_paid, p.balance_due_date,
            p.autopay_enrolled, p.pricing_snapshot,
            c.id AS client_id, c.name AS client_name, c.email AS client_email,
            sp.name AS package_name, sp.slug AS package_slug, sp.category AS package_category
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );
  return rows[0] || null;
}

/** Extract first name from a "First Last" string. Returns null if input is blank. */
function firstNameOf(fullName) {
  if (!fullName) return null;
  const first = String(fullName).trim().split(/\s+/)[0];
  return first || null;
}

/** Format event_date as a friendly day-of-week + month + day + year in event TZ. */
function formatEventDateLong(proposal) {
  const tz = resolveEventTimezone(proposal);
  // event_date is YYYY-MM-DD; combine with noon so we don't accidentally fall
  // back a day under negative-offset TZs.
  const d = new Date(String(proposal.event_date).slice(0, 10) + 'T12:00:00Z');
  return formatEventLocalTime(d, tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

/** Format start_time as "6:00 PM Central" — short time + TZ name in event TZ. */
function formatStartTimeShort(proposal) {
  if (!proposal.event_start_time) return 'TBD';
  const tz = resolveEventTimezone(proposal);
  const dateStr = String(proposal.event_date).slice(0, 10);
  const timeStr = String(proposal.event_start_time).slice(0, 5);
  // Compose an instant interpretable in tz. Treat the YYYY-MM-DDTHH:MM as
  // already a moment in event TZ; converting via Intl works for any zone.
  // We construct a UTC date at the local time, then re-render in tz so DST
  // is respected.
  const localUtcMs = Date.parse(`${dateStr}T${timeStr}:00Z`);
  if (!Number.isFinite(localUtcMs)) return timeStr;
  return formatEventLocalTime(new Date(localUtcMs), tz, { timeStyle: 'short', timeZoneName: 'short' });
}

/** Format balance_due_date in event TZ as "June 8, 2026". Returns '' if null. */
function formatBalanceDueDate(proposal) {
  if (!proposal.balance_due_date) return '';
  const tz = resolveEventTimezone(proposal);
  const d = new Date(String(proposal.balance_due_date).slice(0, 10) + 'T12:00:00Z');
  return formatEventLocalTime(d, tz, { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * Render a one-line drinks summary from the pricing snapshot or drink_plan.
 *
 * MVP fallback when no detailed selection data is available: return
 * 'Drink plan submitted'. Plan 2d's drink-plan touches will refine this.
 */
function buildDrinksSummary(proposal) {
  const snap = proposal.pricing_snapshot || {};
  if (snap && snap.package && snap.package.name) {
    return `${snap.package.name} — selections in your portal`;
  }
  return 'Drink plan submitted';
}

/** Map package category to bar_option for the T-30 BYOB/Hosted branch. */
function barOptionFor(proposal) {
  // Hosted packages have category 'hosted' in service_packages; default to byob otherwise.
  return proposal.package_category === 'hosted' ? 'hosted' : 'byob';
}

/**
 * Handler: event_week_reminder
 * Renders eventWeekReminderClient + sends via sendEmail. Throws on failure so
 * the dispatcher marks the row 'failed' and surfaces to Sentry.
 */
async function handleEventWeekReminder({ entity, recipient, scheduledMessage: _sm }) {
  const proposalId = entity.entity_id;
  const ctx = await loadProposalContext(proposalId);
  if (!ctx) throw new Error(`event_week_reminder: proposal ${proposalId} not found`);
  if (!ctx.client_email) {
    // No address to send to — let the dispatcher mark this 'failed' so the
    // delivery-failure fallback logic in Plan 2a's dispatcher kicks in if
    // configured. If that fallback isn't yet implemented, the row just records
    // the error for admin review.
    throw new Error(`event_week_reminder: client ${recipient.recipient_id} has no email`);
  }
  if (ctx.status === 'archived') {
    // Defensive — dispatcher should already have suppressed via the archive
    // cascade. If we get here, throw rather than send.
    throw new Error(`event_week_reminder: proposal ${proposalId} is archived — should have been suppressed`);
  }

  const tpl = emailTemplates.eventWeekReminderClient({
    clientName: ctx.client_name,
    clientFirstName: firstNameOf(ctx.client_name),
    eventDateLocal: formatEventDateLong(ctx),
    startTimeLocal: formatStartTimeShort(ctx),
    location: ctx.event_location,
    guestCount: ctx.guest_count,
    packageName: ctx.package_name || getEventTypeLabel({ event_type: ctx.event_type, event_type_custom: ctx.event_type_custom }),
    proposalUrl: ctx.token ? `${PUBLIC_SITE_URL}/proposal/${ctx.token}` : null,
  });

  await sendEmail({ to: ctx.client_email, ...tpl });
}

/**
 * Handler: long_lead_t30_recap
 * BYOB-conditional shopping-list block. Skips (throws) if drink_plan or
 * shopping_list are not yet ready — the regular drink-plan nudge in Plan 2d
 * handles that case. The check is performed at send time, not schedule time,
 * because the artifacts may land any time between deposit and T-30.
 */
async function handleLongLeadT30Recap({ entity, recipient, scheduledMessage: _sm }) {
  const proposalId = entity.entity_id;
  const ctx = await loadProposalContext(proposalId);
  if (!ctx) throw new Error(`long_lead_t30_recap: proposal ${proposalId} not found`);
  if (!ctx.client_email) {
    throw new Error(`long_lead_t30_recap: client ${recipient.recipient_id} has no email`);
  }
  if (ctx.status === 'archived') {
    throw new Error(`long_lead_t30_recap: proposal ${proposalId} archived — should have been suppressed`);
  }

  // Per spec section 1.6: suppress (don't send) if drink plan or shopping list
  // not yet ready. The regular drink-plan nudge (Plan 2d) covers that path.
  // We check by looking up the drink_plans row for this proposal and its
  // shopping_list_status, which exist today in the schema.
  const drinkRes = await pool.query(
    `SELECT dp.selections, dp.consult_filled_at, dp.shopping_list_status
       FROM drink_plans dp
      WHERE dp.proposal_id = $1
      LIMIT 1`,
    [proposalId]
  );
  const drink = drinkRes.rows[0];
  const planReady = drink && (drink.selections !== null || drink.consult_filled_at !== null);
  const shoppingReady = drink && drink.shopping_list_status === 'ready';
  const isHosted = barOptionFor(ctx) === 'hosted';

  // Hosted events don't need a shopping list — only the drink plan must be ready.
  // BYOB needs both.
  if (!planReady) {
    throw new Error(`long_lead_t30_recap: drink plan not ready for proposal ${proposalId} — drink-plan nudge handles this case`);
  }
  if (!isHosted && !shoppingReady) {
    throw new Error(`long_lead_t30_recap: shopping list not ready for BYOB proposal ${proposalId} — drink-plan nudge handles this case`);
  }

  const shoppingListUrl = !isHosted && ctx.token
    ? `${PUBLIC_SITE_URL}/shopping-list/${ctx.token}`
    : '';

  const tpl = emailTemplates.longLeadT30RecapClient({
    clientName: ctx.client_name,
    clientFirstName: firstNameOf(ctx.client_name),
    eventDateLocal: formatEventDateLong(ctx),
    drinksSummary: buildDrinksSummary(ctx),
    shoppingListUrl,
    barOption: isHosted ? 'hosted' : 'byob',
  });

  await sendEmail({ to: ctx.client_email, ...tpl });
}

/**
 * Idempotent registration entry point. Call once from server bootstrap.
 */
function registerAll() {
  registerHandler('event_week_reminder', handleEventWeekReminder);
  registerHandler('long_lead_t30_recap', handleLongLeadT30Recap);
}

module.exports = {
  registerAll,
  handleEventWeekReminder,
  handleLongLeadT30Recap,
  // Exported for test seams:
  loadProposalContext,
  firstNameOf,
  formatEventDateLong,
  formatStartTimeShort,
  formatBalanceDueDate,
};
```

- [ ] **Step 2: Verify handler file loads without errors**

```bash
node -e "require('./server/utils/preEventHandlers');"
```

Expected: no output, exit code 0. (A failure here is usually a typo or a missing require.)

- [ ] **Step 3: Commit**

```bash
git add server/utils/preEventHandlers.js
git commit -m "feat(comms): pre-event email handlers for event-week and T-30 recap"
```

---

## Task 4: Wire `registerAll()` into `server/index.js` boot

**Files:**
- Modify: `server/index.js` — add a single `require(...).registerAll()` call near where Plan 2a wires the dispatcher

- [ ] **Step 1: Locate the dispatcher wiring**

Plan 2a wires the `scheduledMessageDispatcher` in `server/index.js`. Find the block where `require('./utils/scheduledMessageDispatcher')` is set up (it should be near the other scheduler bootstraps refactored in Plan 1 Task 11, around line 247+). The relevant pattern from Plan 2a will look something like:

```javascript
const dispatcher = require('./utils/scheduledMessageDispatcher');
require('./utils/moneyPathHandlers').registerAll();
```

If Plan 2a's exact location is not yet visible, add the new line right after any other `registerAll()` calls. If no other handlers exist yet, place it directly above the dispatcher's `setInterval` / scheduler start call so handlers are registered BEFORE the dispatcher fires.

- [ ] **Step 2: Add the registration call**

Insert this line in the bootstrap block:

```javascript
      require('./utils/preEventHandlers').registerAll();
```

Place it next to (immediately after) the `require('./utils/moneyPathHandlers').registerAll()` line from Plan 2a if present. If Plan 2a hasn't shipped yet, insert it inline with whatever block currently wires the dispatcher and add a TODO note:

```javascript
      // Pre-event reminder handlers (event_week_reminder, long_lead_t30_recap)
      require('./utils/preEventHandlers').registerAll();
```

- [ ] **Step 3: Boot the dev server and check logs**

```bash
npm run dev
```

Expected: server boots without errors. The boot log should NOT show "no handler registered for message_type=event_week_reminder" when the dispatcher ticks.

Stop the dev server (Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat(comms): wire pre-event handler registration into boot"
```

---

## Task 5: Schedule pre-event reminders from the Stripe webhook deposit branch

**Files:**
- Modify: `server/routes/stripe.js` — in the post-commit notification block of `payment_intent.succeeded` for deposit / full / coupled sign+pay, call `schedulePreEventReminders(proposalId)`

- [ ] **Step 1: Locate the post-commit notification block**

Read `server/routes/stripe.js` around lines 818-866 (the block that begins with `const payInfo = await pool.query(...)` and ends just after the admin email send, around line 866). This is the post-commit "first-payment notifier" — it fires AFTER the proposal transaction has committed and is gated on `isFirstDelivery` and `paymentType IN ('deposit','full')` (the coupled sign+pay path).

Plan 2a inserts `scheduleBalanceReminders(proposalId)` near the end of this same block. Plan 2c adds a sibling call.

- [ ] **Step 2: Add `schedulePreEventReminders` import at the top of the file**

Find the existing `require` block at the top of `server/routes/stripe.js`. Add:

```javascript
const { schedulePreEventReminders } = require('../utils/preEventScheduling');
```

- [ ] **Step 3: Call the helper at the end of the first-payment notifier block**

Find the block ending around line 866 with:

```javascript
    } catch (emailErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(emailErr, {
          tags: { webhook: 'stripe', route: '/webhook' },
        });
      }
      console.error('Payment notification email failed (non-blocking):', emailErr);
    }
  }
```

Immediately AFTER the closing `}` of the entire post-commit notifier block (so it runs even if email send failed — scheduling reminders is independent of the immediate notification), add:

```javascript
  // Schedule pre-event reminder emails (T-7 event-week, conditional T-30
  // long-lead recap). Mirrors Plan 2a's balance-reminder scheduling — both
  // fire from this single anchor point so a Stripe retry never double-schedules
  // (the helper itself is idempotent via insertIfMissing).
  //
  // Gate on deposit/full/coupled sign+pay branches — never on balance or
  // drink-plan-extras payments (those happen post-conversion when reminders
  // already exist).
  if (isFirstDelivery && (paymentType === 'deposit' || paymentType === 'full')) {
    try {
      await schedulePreEventReminders(proposalId);
    } catch (schedErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(schedErr, {
          tags: { webhook: 'stripe', route: '/webhook', step: 'schedulePreEventReminders' },
        });
      }
      console.error('schedulePreEventReminders failed (non-blocking):', schedErr);
    }
  }
```

Important: `isFirstDelivery` is the in-scope flag set earlier in the same handler when the `proposal_payments` insert succeeded with rowCount === 1. The gate matches Plan 2a's pattern. Adjust the surrounding `if` conditions to match the existing variables in `server/routes/stripe.js` if Plan 2a has already changed the shape.

- [ ] **Step 4: Lint and smoke test**

```bash
npx eslint server/routes/stripe.js
```

Expected: no errors. Then start dev:

```bash
npm run dev
```

Boot should succeed. (Direct webhook testing of this code path requires triggering a Stripe deposit, which is out of scope for this task — verified instead by Task 8's end-to-end smoke test.)

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(comms): schedule pre-event reminders from Stripe deposit webhook"
```

---

## Task 6: Build `rescheduleProposal.js` (immediate email + cascade re-anchor)

**Files:**
- Create: `server/utils/rescheduleProposal.js`
- Create: `server/utils/rescheduleProposal.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/rescheduleProposal.test.js`:

```javascript
const { test, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { pool } = require('../db');

// Intercept require('./email') so the test doesn't actually call Resend.
// We track calls via a simple array; assertions read it directly.
const emailCalls = [];
const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;
const emailModule = { sendEmail: async (args) => { emailCalls.push(args); return { id: 'mock-msg' }; } };
const emailPath = require.resolve('./email');
Module._load = function patched(request, parent, ...rest) {
  if (request === './email' || request === emailPath) return emailModule;
  return originalLoad.call(this, request, parent, ...rest);
};

const { rescheduleProposal, hasReschedulableChange, reanchorPendingMessages } = require('./rescheduleProposal');

const TEST_CLIENT_ID = -2;
const TEST_PROPOSAL_ID = -202;

beforeEach(async () => {
  emailCalls.length = 0;
  await pool.query(
    `INSERT INTO clients (id, name, email, phone) VALUES ($1, 'Reschedule Test', 'rs@example.com', '+15553334444')
     ON CONFLICT (id) DO NOTHING`,
    [TEST_CLIENT_ID]
  );
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
});

after(async () => {
  Module._load = originalLoad;
  await pool.end();
});

// ── hasReschedulableChange ──
test('hasReschedulableChange > returns true when event_date changed', () => {
  const result = hasReschedulableChange(
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' },
    { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'A' }
  );
  assert.strictEqual(result, true);
});

test('hasReschedulableChange > returns true when event_start_time changed', () => {
  const result = hasReschedulableChange(
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' },
    { event_date: '2026-08-15', event_start_time: '19:00', event_location: 'A' }
  );
  assert.strictEqual(result, true);
});

test('hasReschedulableChange > returns true when event_location changed', () => {
  const result = hasReschedulableChange(
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' },
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'B' }
  );
  assert.strictEqual(result, true);
});

test('hasReschedulableChange > returns false when none of the three fields changed', () => {
  const result = hasReschedulableChange(
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A', total_price: 100 },
    { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A', total_price: 200 }
  );
  assert.strictEqual(result, false);
});

// ── reanchorPendingMessages ──
test('reanchorPendingMessages > updates scheduled_for on pending event_week_reminder rows', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-09-15', '18:00', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  // Pretend a stale row was inserted when the event was 2026-08-15
  const oldScheduledFor = new Date(Date.UTC(2026, 7, 8, 15, 0, 0)); // T-7 of 8/15 at 10am CDT
  await pool.query(
    `INSERT INTO scheduled_messages
     (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', $2, 'email', $3, 'pending')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, oldScheduledFor]
  );

  const updated = await reanchorPendingMessages(TEST_PROPOSAL_ID);
  assert.ok(updated > 0);

  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type = 'event_week_reminder'`,
    [TEST_PROPOSAL_ID]
  );
  // New event_date 2026-09-15, T-7 = 2026-09-08, 10am CDT = 15:00 UTC
  assert.strictEqual(new Date(rows[0].scheduled_for).toISOString(), '2026-09-08T15:00:00.000Z');
});

test('reanchorPendingMessages > skips sent rows — only pending re-anchored', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-09-15', '18:00', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  const stableSent = new Date('2026-08-08T15:00:00.000Z');
  await pool.query(
    `INSERT INTO scheduled_messages
     (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, sent_at, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', $2, 'email', $3, $3, 'sent')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, stableSent]
  );

  await reanchorPendingMessages(TEST_PROPOSAL_ID);

  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'sent'`,
    [TEST_PROPOSAL_ID]
  );
  // Sent row should NOT have been updated
  assert.strictEqual(new Date(rows[0].scheduled_for).toISOString(), '2026-08-08T15:00:00.000Z');
});

// ── rescheduleProposal ──
test('rescheduleProposal > sends the reschedule email and re-anchors pending rows', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_location, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-09-15', '18:00', 'New Venue', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  await pool.query(
    `INSERT INTO scheduled_messages
     (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', $2, 'email', '2026-08-08T15:00:00.000Z', 'pending')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );

  const old = {
    event_date: '2026-08-15', event_start_time: '18:00', event_location: 'Old Venue',
  };
  const updated = {
    event_date: '2026-09-15', event_start_time: '18:00', event_location: 'New Venue',
  };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  assert.strictEqual(emailCalls.length, 1);
  const callArg = emailCalls[0];
  assert.strictEqual(callArg.to, 'rs@example.com');
  assert.strictEqual(callArg.subject, 'Updated details for your event');

  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1 AND message_type = 'event_week_reminder'`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(new Date(rows[0].scheduled_for).toISOString(), '2026-09-08T15:00:00.000Z');
});

test('rescheduleProposal > skips entirely when proposal is archived', async () => {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, archive_reason, event_date, event_start_time, event_location, event_timezone, created_at, total_price)
     VALUES ($1, $2, 'archived', 'client_cancelled', '2026-09-15', '18:00', 'Venue', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'X' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'Y' };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });
  assert.strictEqual(emailCalls.length, 0);
});

test('rescheduleProposal > throws when proposal has no client_email (caller decides how to surface)', async () => {
  await pool.query(
    `INSERT INTO clients (id, name, email, phone) VALUES (-3, 'No Email', NULL, '+15555555555')
     ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_location, event_timezone, created_at, total_price)
     VALUES ($1, -3, 'deposit_paid', '2026-09-15', '18:00', 'Venue', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID]
  );
  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'X' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'Y' };
  await assert.rejects(
    () => rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated }),
    /no email/
  );
  await pool.query('DELETE FROM clients WHERE id = -3');
});
```

Note: the email-mock approach above patches `Module._load` to substitute `./email`. node:test does not yet ship a stable module-mock API equivalent to `jest.mock`, so this hand-rolled interception keeps the test self-contained. Run `node --experimental-test-module-mocks` if you prefer the experimental `mock.module()` API instead — both work.

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/utils/rescheduleProposal.test.js
```

Expected: FAIL with `Cannot find module './rescheduleProposal'`.

- [ ] **Step 3: Implement `rescheduleProposal.js`**

Create `server/utils/rescheduleProposal.js`:

```javascript
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { resolveEventTimezone, formatEventLocalTime } = require('./eventTimezone');
const { messageOffsets, computeScheduledFor } = require('./preEventScheduling');

/**
 * Returns true when any of the three reschedule-triggering fields changed.
 * Compares string-coerced values so '2026-08-15' === Date(2026-08-15) works.
 */
function hasReschedulableChange(oldRow, newRow) {
  const fields = ['event_date', 'event_start_time', 'event_location'];
  return fields.some((f) => {
    const oldVal = oldRow[f] == null ? '' : String(oldRow[f]).slice(0, 19);
    const newVal = newRow[f] == null ? '' : String(newRow[f]).slice(0, 19);
    return oldVal !== newVal;
  });
}

/**
 * Re-anchor all pending scheduled_messages rows for the proposal so each row's
 * scheduled_for matches the proposal's NEW event_date + the message_type's
 * offset (from preEventScheduling.messageOffsets).
 *
 * Only touches rows where status = 'pending'. Sent / failed / suppressed rows
 * are left alone (history is preserved).
 *
 * Unknown message_types are skipped silently with a console.warn so a future
 * touch type (added by Plan 2b/2d) doesn't break a reschedule before this map
 * is updated. Add new offsets to `preEventScheduling.messageOffsets` to bring
 * them into the cascade.
 *
 * @param {number|string} proposalId
 * @returns {number} count of rows updated
 */
async function reanchorPendingMessages(proposalId) {
  const propRes = await pool.query(
    `SELECT id, event_date, event_start_time, event_timezone
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || !proposal.event_date) return 0;

  const pendingRes = await pool.query(
    `SELECT id, message_type
       FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND status = 'pending'`,
    [proposalId]
  );

  let updated = 0;
  for (const row of pendingRes.rows) {
    if (!messageOffsets[row.message_type]) {
      console.warn(`[rescheduleProposal] no offset registered for message_type=${row.message_type} (row id=${row.id}); leaving scheduled_for unchanged`);
      continue;
    }
    let newScheduledFor;
    try {
      newScheduledFor = computeScheduledFor(proposal, row.message_type);
    } catch (err) {
      console.warn(`[rescheduleProposal] computeScheduledFor failed for row ${row.id}: ${err.message}`);
      continue;
    }
    await pool.query(
      `UPDATE scheduled_messages SET scheduled_for = $1 WHERE id = $2`,
      [newScheduledFor, row.id]
    );
    updated += 1;
  }
  return updated;
}

/**
 * Send the reschedule notification email immediately. SMS deferred to Phase 3
 * per spec section 10.
 *
 * Inputs:
 *   - `old`: the proposal row BEFORE the PATCH (must include event_date,
 *     event_start_time, event_location)
 *   - `updated`: the proposal row AFTER the PATCH (same shape; new values)
 *
 * Both rows should be the full proposal row from the PATCH handler — the
 * function only reads the three reschedulable fields plus client linkage.
 */
async function sendRescheduleEmail({ proposalId, old, updated }) {
  const { rows } = await pool.query(
    `SELECT p.id, p.token, p.status, p.event_date, p.event_start_time, p.event_location,
            p.event_timezone, p.guest_count, p.total_price, p.balance_due_date,
            p.autopay_enrolled,
            c.name AS client_name, c.email AS client_email,
            sp.name AS package_name
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE p.id = $1`,
    [proposalId]
  );
  const ctx = rows[0];
  if (!ctx) throw new Error(`rescheduleProposal: proposal ${proposalId} not found`);
  if (!ctx.client_email) throw new Error(`rescheduleProposal: proposal ${proposalId} client has no email`);

  const tz = resolveEventTimezone(ctx);

  const fmtDate = (d) => {
    if (!d) return 'TBD';
    const iso = String(d).slice(0, 10) + 'T12:00:00Z';
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return 'TBD';
    return formatEventLocalTime(parsed, tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };
  const fmtTime = (date, time) => {
    if (!time || !date) return 'TBD';
    const iso = String(date).slice(0, 10) + 'T' + String(time).slice(0, 5) + ':00Z';
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return String(time).slice(0, 5);
    return formatEventLocalTime(parsed, tz, { timeStyle: 'short', timeZoneName: 'short' });
  };

  const totalNumber = Number(ctx.total_price ?? 0);
  const totalFormatted = totalNumber.toFixed(2);

  const balanceDueDateLocal = ctx.balance_due_date
    ? formatEventLocalTime(new Date(String(ctx.balance_due_date).slice(0, 10) + 'T12:00:00Z'), tz, { month: 'long', day: 'numeric', year: 'numeric' })
    : '';

  const firstName = (ctx.client_name || '').trim().split(/\s+/)[0] || null;

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

/**
 * Top-level orchestrator. Called from `server/routes/proposals/crud.js`
 * PATCH handler after a successful UPDATE.
 *
 * Steps:
 *   1. Verify a reschedulable field actually changed (no-op otherwise)
 *   2. Bail if proposal is archived
 *   3. Send the reschedule email
 *   4. Re-anchor all pending scheduled_messages rows for this proposal
 *
 * Errors are thrown — the caller (PATCH handler) is responsible for catching
 * and logging non-blockingly so the HTTP response still succeeds.
 *
 * @param {object} args
 * @param {number|string} args.proposalId
 * @param {object} args.old - proposal row BEFORE the PATCH
 * @param {object} args.updated - proposal row AFTER the PATCH
 */
async function rescheduleProposal({ proposalId, old, updated }) {
  if (!hasReschedulableChange(old, updated)) return;

  const statusRow = await pool.query('SELECT status FROM proposals WHERE id = $1', [proposalId]);
  const status = statusRow.rows[0]?.status;
  if (!status) return;

  // Gate post-sign+pay: only meaningful for proposals at or past deposit_paid.
  // Pre-sign+pay date/time edits don't need a reschedule email — the proposal
  // hasn't been sent yet (or has been sent but not signed, in which case the
  // next status-driven email replaces it).
  const POST_SIGNPAY = new Set(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
  if (status === 'archived' || !POST_SIGNPAY.has(status)) return;

  await sendRescheduleEmail({ proposalId, old, updated });
  await reanchorPendingMessages(proposalId);
}

module.exports = {
  rescheduleProposal,
  hasReschedulableChange,
  reanchorPendingMessages,
  sendRescheduleEmail,
};
```

- [ ] **Step 4: Run tests to verify pass**

```bash
node --test server/utils/rescheduleProposal.test.js
```

Expected: all tests pass. Notes:
- The `archived` test inserts a proposal with `status='archived'`. The current `rescheduleProposal` returns silently because `POST_SIGNPAY` does NOT include 'archived'.
- The `no email` test expects `rescheduleProposal` to throw — which it does (in `sendRescheduleEmail`) via the `client_email` guard. Caller is responsible for non-blocking the error.

- [ ] **Step 5: Commit**

```bash
git add server/utils/rescheduleProposal.js server/utils/rescheduleProposal.test.js
git commit -m "feat(comms): reschedule proposal helper with email and cascade re-anchor"
```

---

## Task 7: Hook `rescheduleProposal` into the proposal PATCH handler

**Files:**
- Modify: `server/routes/proposals/crud.js` — invoke `rescheduleProposal` after the UPDATE in `router.patch('/:id', ...)`

- [ ] **Step 1: Read the PATCH handler**

Read `server/routes/proposals/crud.js` lines 249-435 (the `router.patch('/:id', ...)` block). Note:
- Line 263-267 fetches `old` (the proposal row BEFORE the update)
- Lines 349-378 do the UPDATE, returning `updatedRow.rows[0]`
- Line 405 calls `syncShiftsFromProposal` AFTER the UPDATE
- Line 407 commits the transaction
- Line 428 returns the updated row to the client

The reschedule logic must run AFTER the COMMIT (so the new event_date is persisted), and non-blockingly (so a comms failure doesn't break the PATCH response).

- [ ] **Step 2: Add the import**

At the top of `server/routes/proposals/crud.js`, alongside other utility imports:

```javascript
const { rescheduleProposal } = require('../../utils/rescheduleProposal');
```

- [ ] **Step 3: Invoke `rescheduleProposal` after the invoice-refresh block**

Find the invoice-refresh block in `server/routes/proposals/crud.js` (lines 410-425, the block beginning with `// Refresh unlocked invoices with new pricing` and ending in its `finally { invClient.release(); }`).

Immediately AFTER that block's closing brace, BEFORE `res.json(updatedRow.rows[0]);`, add:

```javascript
    // Reschedule comms — fire client email + re-anchor pending scheduled_messages
    // when event_date / event_start_time / event_location changed on a
    // post-sign+pay proposal. Non-blocking on failure — the PATCH response still
    // succeeds, but the comms failure surfaces to Sentry for follow-up.
    try {
      await rescheduleProposal({
        proposalId: parseInt(req.params.id, 10),
        old,                          // pre-UPDATE row from line 267
        updated: updatedRow.rows[0],  // post-UPDATE row from line 378
      });
    } catch (rescheduleErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(rescheduleErr, {
          tags: { route: 'proposals/update', issue: 'reschedule-comms' },
          extra: { proposalId: req.params.id },
        });
      }
      console.error('Reschedule comms failed (non-blocking):', rescheduleErr);
    }
```

- [ ] **Step 4: Lint**

```bash
npx eslint server/routes/proposals/crud.js
```

Expected: no errors.

- [ ] **Step 5: Smoke test in dev server**

Start the dev server, log in as admin, find a deposit_paid proposal, PATCH `event_date` to a different date via the admin UI or curl, and confirm:
- The PATCH response is the updated proposal (no 5xx)
- Server logs do NOT show "Reschedule comms failed"
- A row appears in `proposal_activity_log` (existing — added by the PATCH handler at line 396-399)
- `scheduled_messages.scheduled_for` for that proposal's `event_week_reminder` row now reflects the NEW event_date − 7 days

```bash
psql "$DATABASE_URL" -c "
SELECT id, message_type, scheduled_for, status FROM scheduled_messages
WHERE entity_type='proposal' AND entity_id = <test_proposal_id>
ORDER BY message_type;
"
```

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/crud.js
git commit -m "feat(comms): fire reschedule email + re-anchor pending messages on proposal edit"
```

---

## Task 8: End-to-end smoke test

This is a verification pass, no code changes.

- [ ] **Step 1: Restart dev server, confirm clean boot**

```bash
npm run dev
```

Expected logs:
- `[schedulerHealth] stale-scheduler monitor started` (Plan 1)
- `[schedulers] started with per-scheduler controls` (Plan 1)
- (If Plan 2a wires dispatcher startup) a line indicating dispatcher started
- No errors from `preEventHandlers` registration

- [ ] **Step 2: Simulate a deposit_paid promotion**

In a SQL shell, manually insert a test proposal in `accepted` status and flip it to `deposit_paid` via the activity-log + UPDATE flow that the Stripe webhook would normally take. Then directly call `schedulePreEventReminders` from a one-shot node script:

```bash
node -e "
(async () => {
  const { schedulePreEventReminders } = require('./server/utils/preEventScheduling');
  await schedulePreEventReminders(<test_proposal_id>);
  console.log('done');
  process.exit(0);
})();
"
```

Verify rows landed:

```bash
psql "$DATABASE_URL" -c "
SELECT message_type, channel, recipient_type, recipient_id, status, scheduled_for
FROM scheduled_messages
WHERE entity_type='proposal' AND entity_id = <test_proposal_id>
ORDER BY message_type;
"
```

Expected:
- `event_week_reminder | email | client | <client_id> | pending | <T-7 timestamp>`
- For a 90+ day lead-time proposal: also `long_lead_t30_recap | email | client | ...`

- [ ] **Step 3: Simulate a reschedule**

PATCH the test proposal's `event_date` to a date 30 days later (via the admin UI or curl). Confirm:

```bash
psql "$DATABASE_URL" -c "
SELECT message_type, scheduled_for FROM scheduled_messages
WHERE entity_type='proposal' AND entity_id = <test_proposal_id>
  AND status = 'pending'
ORDER BY message_type;
"
```

Expected: every pending row's `scheduled_for` has shifted forward by 30 days (offset by the per-message-type pre-event window).

- [ ] **Step 4: Confirm the dispatcher would fire the right handler**

```bash
psql "$DATABASE_URL" -c "
UPDATE scheduled_messages SET scheduled_for = NOW()
WHERE entity_type='proposal' AND entity_id = <test_proposal_id>
  AND message_type = 'event_week_reminder';
"
```

Wait for the dispatcher tick (per Plan 2a's setInterval, default 60s). Then:

```bash
psql "$DATABASE_URL" -c "
SELECT message_type, status, sent_at, error_message FROM scheduled_messages
WHERE entity_type='proposal' AND entity_id = <test_proposal_id>
  AND message_type = 'event_week_reminder';
"
```

Expected: `status = 'sent'` and `sent_at` populated. If `status = 'failed'`, inspect `error_message` and Resend dashboard. If Plan 2a hasn't shipped the dispatcher yet, this step is deferred to the integration moment.

- [ ] **Step 5: Clean up test data**

```bash
psql "$DATABASE_URL" -c "
DELETE FROM scheduled_messages WHERE entity_type='proposal' AND entity_id = <test_proposal_id>;
DELETE FROM proposals WHERE id = <test_proposal_id>;
"
```

No commit for verification.

---

## Task 9: Update CLAUDE.md / README docs (if structural changes)

This task only fires if Plan 2c added a new file structure that needs documenting in `ARCHITECTURE.md`. Templates added to existing files do NOT need ARCHITECTURE.md updates.

- [ ] **Step 1: Check what to document**

New util files added in this plan:
- `server/utils/preEventScheduling.js`
- `server/utils/preEventHandlers.js`
- `server/utils/rescheduleProposal.js`

Per `.claude/CLAUDE.md`'s "Mandatory Documentation Updates" table: new util files trigger an ARCHITECTURE.md mention.

- [ ] **Step 2: Read the existing utils section in ARCHITECTURE.md**

Find the section of `ARCHITECTURE.md` that lists `server/utils/*.js` files (typically under a "Server Utilities" or similar heading). Add brief one-liners for the three new files in the same style as existing entries. Example pattern:

```markdown
- `server/utils/preEventScheduling.js` — inserts `scheduled_messages` rows for the T-7 event-week reminder and conditional T-30 long-lead recap when a proposal moves to deposit_paid (Plan 2c)
- `server/utils/preEventHandlers.js` — dispatcher handlers for `event_week_reminder` and `long_lead_t30_recap` message types (Plan 2c)
- `server/utils/rescheduleProposal.js` — sends the immediate reschedule notification email and re-anchors all pending `scheduled_messages` rows when admin edits event_date/start_time/location on a post-sign+pay proposal (Plan 2c)
```

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs: document pre-event reminder utils in ARCHITECTURE"
```

---

## Self-review (run after all tasks above complete)

Run through the following checks before declaring Plan 2c done:

- [ ] All commits land cleanly on `main` with single-line messages
- [ ] `git status` shows a clean working tree
- [ ] `npm run lint` passes
- [ ] All unit tests pass: `node --test server/utils/preEventScheduling.test.js server/utils/rescheduleProposal.test.js`
- [ ] Three new templates exported from `emailTemplates.js`: `eventWeekReminderClient`, `rescheduleNotificationClient`, `longLeadT30RecapClient`
- [ ] `preEventHandlers.registerAll()` is invoked in `server/index.js`
- [ ] `schedulePreEventReminders` is called from the Stripe webhook deposit/full first-delivery branch
- [ ] `rescheduleProposal` is called from `server/routes/proposals/crud.js` PATCH handler after commit
- [ ] Smoke test (Task 8) shows pending rows landing on deposit_paid and re-anchoring on reschedule
- [ ] No SMS code touched (deferred to Phase 3)
- [ ] No drink-plan-nudge code touched (Plan 2d)

---

## Spec coverage check

| Spec section | Covered by | Notes |
|---|---|---|
| 3.11 Event-week reminder | Task 1 (template), Task 2 (scheduler), Task 3 (handler), Task 5 (Stripe hook) | T-7, email-only, in event TZ |
| 1.6 Long-lead T-30 recap | Task 1 (template), Task 2 (gating + scheduler), Task 3 (handler) | 90+ day lead-time gate; BYOB/Hosted conditional shopping block; defers to drink-plan-nudge when artifacts missing |
| 3.13 Reschedule notification (email) | Task 1 (template), Task 6 (helper), Task 7 (PATCH hook) | Email only — SMS deferred per Phase 3; includes cascade re-anchor |
| 7.2 Time zones | Task 1 (templates use pre-formatted local times), Task 2 (`computeScheduledFor`), Task 3 (`formatEventDateLong`/`formatStartTimeShort`) | All event-time rendering uses `formatEventLocalTime` from Plan 1 |
| 7.8 Reschedule handling | Task 6 (re-anchor logic), Task 7 (PATCH hook) | `scheduled_for` recomputed via `computeScheduledFor` for every pending row whose `message_type` has a registered offset |

---

## What's not in this plan

To keep Plan 2c focused, the following are intentionally deferred:

- Reschedule SMS — Phase 3 (Plan 2c is Phase 1 only per spec section 10)
- Drink-plan submission nudge (3.7) — Plan 2d
- Drink plan submitted confirmation (3.8) — Plan 2d
- Shopping list ready (3.9) — Plan 2d
- Balance reminders T-3 / T-day / T+1 / T+3 (3.1, 3.4-3.6) — Plan 2a
- Orientation expansion (2.1) — Plan 2a
- New Year touch (1.4) — Plan 2b
- 6-months-out touch (1.5) — Plan 2b
- Post-event review (4.1) — Plan 2b
- Retention nudge (4.2) — Plan 2b
- Refund notification (3.14) — Plan 2b
- Post-consult email (3.10) — Plan 2b
- Two-way SMS infrastructure — Plan 3
- Notification overlap prevention / channel fallback at dispatch time — Plan 2a / Plan 3
