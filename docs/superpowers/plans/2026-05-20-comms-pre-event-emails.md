# Pre-event Reminder Emails Implementation Plan (Plan 2c)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## What This Resolves (Gemini design-review pass, 2026-05-20)

Four Gemini findings land here:

- **Finding 1 (BLOCKER) — Reschedule cascade incomplete.** Task 6's `reanchorPendingMessages` no longer relies on a local `messageOffsets` constant; it calls `getHandlerMeta(messageType)` exported by Plan 2a's `scheduledMessageDispatcher.js`. Every registered handler (Plan 2a balance reminders, Plan 2c event-week / T-30, Plan 2d marketing touches) carries its own metadata so the cascade re-anchors the full set of pending rows when admin updates event_date OR balance_due_date.
- **Finding 2 (BLOCKER) — `rescheduleProposal` must be atomic.** Task 6 wraps the proposal UPDATE + scheduled_messages re-anchor inside a single `BEGIN/COMMIT` transaction. The reschedule email fires AFTER the commit (email send is not idempotent-safe; the inverse ordering would leave the DB out of sync if the commit failed after the send).
- **Finding 3 (WARNING) — Immediate sends respect suppression.** `sendRescheduleEmail` calls `shouldSendImmediate({ proposal, client, channel: 'email' })` from `server/utils/messageSuppression.js` (Plan 2a Task 8.5) before invoking sendEmail.
- **Finding 4 (SUGGESTION) — Reschedule must also update `balance_due_date`.** Task 6's `rescheduleProposalInTx` now recomputes `proposals.balance_due_date` inside the same transaction whenever `event_date` shifts. The codebase rule (set in `server/routes/stripe.js`) is `balance_due_date = event_date - INTERVAL '14 days'`, applied via `COALESCE` so admin-edited custom dates aren't clobbered. The helper preserves the **existing offset** between event_date and balance_due_date (so a manually adjusted 21-day lead survives the move) and applies the recomputation BEFORE the `reanchorPendingMessages` pass so balance-anchored re-anchors use the NEW balance_due_date as their source of truth.

## What This Resolves (Pre-execution review, 2026-05-20)

A second cross-LLM review pass surfaced 10 additional findings that land in this plan. All fixed before any code ships.

### BLOCKERs

- **B1 — Reanchor lost "10am event-local" precision.** Previous `computeReanchoredScheduledFor` did `event_date_midnight_UTC + offset_seconds`, which produces e.g. `2026-09-08T00:00:00Z` for T-7 of a Chicago event — but the initial scheduler lands on `2026-09-08T15:00:00Z` (10am CDT). Reschedule would have shifted the send 10+ hours. Fix: a SINGLE shared helper `computeScheduledFor(messageType, proposal)` lives in `preEventScheduling.js` and is used by BOTH the initial scheduler AND `computeReanchoredScheduledFor`. The helper reads offset/anchor from `getHandlerMeta(messageType)` and applies "10am in event TZ" via `Intl.DateTimeFormat` shortOffset parsing. No drift possible.
- **B2 — Test files missed `before()` to register handlers.** `getHandlerMeta('event_week_reminder')` returns null until `preEventHandlers.registerAll()` runs. Both `preEventScheduling.test.js` and `rescheduleProposal.test.js` now have a `before()` block that calls `registerAll()` once per file, so handler metadata is in place for every test.
- **B3 — `balance_due_date` recompute read post-UPDATE proposal as baseline.** Previous code did `UPDATE proposals SET event_date = ...` (run earlier in the PATCH transaction), then SELECTed the row to compute the offset. After the UPDATE, `event_date` was NEW but `balance_due_date` was OLD → bogus offset → no-op balance update. Fix: capture the ORIGINAL `balance_due_date` from the `old` row that the caller passed in (the PATCH handler reads it BEFORE any UPDATE). The convenience-path `rescheduleProposal` hydrates `old.balance_due_date` from the DB when the caller omits it (safe in the convenience path because the DB is still in the original state at that point).
- **B4 — "throws when no email" test contradicted the implementation.** The post-commit email error is swallowed (Sentry + console, no rethrow) so DB stays consistent. Test was asserting `rejects.toThrow('no email')` which never happens. Fix: rewrote the test to verify the NON-rejecting behavior — DB-side reanchor still ran (assertion on `scheduled_messages.scheduled_for`), no email was sent (assertion on the mock), and the function resolved normally.
- **B5 — `formatStartTimeShort` / `fmtTime` parsed `event_start_time` as UTC.** `event_start_time` is a string like `'18:00'` or `'6:00 PM'` — wall-clock event-local time, NOT a UTC timestamp. `new Date('2026-08-15T18:00:00Z')` followed by formatting in Chicago TZ would display `1:00 PM CDT` (off by 5 hours). Fix: literal pass-through with string-based 12-hour conversion (mirrors `formatTime12` in `eventCreation.js`), then append the TZ abbreviation (e.g., "CDT") derived from `event_date` in the resolved zone. No UTC round-trip.

### WARNINGs

- **W1 — Wrong stripe.js line numbers.** Task 5 pointed at lines 818-866; the actual post-commit first-delivery block is 1107-1146 (inside `payment_intent.succeeded`). Updated to point at the correct range and described the exact location (after the shift-creation try/catch, inside the existing `if (isFirstDelivery)` block). Removed the redundant `isFirstDelivery` from the new code's `if` clause since we're now inside the existing guard.
- **W2 — PATCH hook placement ambiguous for reschedule email.** "Outside the try/catch around the tx" was unclear — the outer try wraps everything including `res.json`. Clarified: AFTER COMMIT, INSIDE the outer try, BEFORE `res.json`, with its OWN inner try/catch that NEVER rethrows. Added an annotated placement diagram.
- **W3 — PATCH atomicity coupling concern.** Running `rescheduleProposalInTx` inside the PATCH transaction means a reanchor failure rolls back the user's date change (diverges from the invoice-refresh separate-tx pattern). Documented this as a DELIBERATE choice (state divergence from a half-applied reschedule would silently misroute T-7 reminders) plus the migration path if isolation is needed later (per-row savepoints, not a separate transaction).
- **W4 — Reschedule cascade didn't insert NEW long-lead rows.** Reanchor only updates existing pending rows. Spec section 7.8 says rescheduling INTO a 90+ day window should add `long_lead_t30_recap` eligibility. Fix: `rescheduleProposalInTx` now calls `schedulePreEventReminders(proposalId, client)` after the reanchor pass — the helper is idempotent (won't double-insert) and now accepts an optional `executor` so the new inserts join the open transaction.
- **W5 — Local `messageOffsets` constant still existed in `preEventScheduling.js`.** Plan 2a's `getHandlerMeta` is the canonical source. Fix: removed the local map entirely; `computeScheduledFor` reads offset/anchor directly from dispatcher metadata. Single source of truth, no possibility of the two drifting.

---

**Goal:** Wire up the three pre-event client-email touches: the T-7 event-week reminder, the T-30 long-lead recap (only for proposals booked 90+ days out), and the immediate reschedule notification email that also re-anchors every other pending scheduled message on the proposal to the new event date.

**Architecture:** Three pieces. (1) Two new email templates in `server/utils/emailTemplates.js` rendered with event-local times via the Plan 1 `eventTimezone` utility. (2) Two new dispatcher handlers (`event_week_reminder`, `long_lead_t30_recap`) registered against the Plan 2a `registerHandler` API, plus a scheduling helper that inserts pending `scheduled_messages` rows from the Stripe `payment_intent.succeeded` first-deposit branch. (3) A new `rescheduleProposal` helper invoked from the proposal PATCH handler when `event_date`, `event_start_time`, or `event_location` changes post-sign+pay — fires the reschedule email immediately, recomputes `balance_due_date` in the same transaction when event_date shifts (preserving the original offset), and re-anchors every pending row in `scheduled_messages` for the proposal using a per-message-type offset mapping.

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
- `server/utils/rescheduleProposal.js` — orchestrates the immediate reschedule email + cascade re-anchor of pending `scheduled_messages` rows, all inside a single transaction
- `server/utils/rescheduleProposal.test.js` — unit tests for re-anchor offset math, atomicity, skip-on-archived
- `server/utils/preEventScheduling.js` — pure scheduler helpers: `schedulePreEventReminders(proposalId)` inserts the event-week + (conditional) T-30 recap rows.
- `server/utils/preEventScheduling.test.js` — unit tests for offset math, long-lead gating, idempotency
- `server/utils/preEventHandlers.js` — `registerHandler(...)` calls for `event_week_reminder` and `long_lead_t30_recap` (with offset metadata so Plan 2c's reschedule cascade can re-anchor them), plus a one-line `registerAll()` export wired from `server/index.js`

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
  shouldScheduleLongLeadRecap,
  schedulePreEventReminders,
} = require('./preEventScheduling');
const preEventHandlers = require('./preEventHandlers');

const TEST_CLIENT_ID = -1;
const TEST_PROPOSAL_ID = -101;

// Register dispatcher handlers (and their offset metadata) ONCE so
// getHandlerMeta('event_week_reminder') / 'long_lead_t30_recap' return the
// canonical offset values that computeScheduledFor reads.
before(() => {
  preEventHandlers.registerAll();
});

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

// ── computeScheduledFor ──
// Signature: computeScheduledFor(messageType, proposal). Reads offset/anchor
// from dispatcher metadata, not a local map — single source of truth.
test('computeScheduledFor > returns a UTC instant for T-7 at 10am event-local', () => {
  const proposal = {
    event_date: '2026-06-20',         // Saturday
    event_start_time: '18:00',
    event_timezone: 'America/Chicago',
  };
  const result = computeScheduledFor('event_week_reminder', proposal);
  // T-7 of 2026-06-20 = 2026-06-13. At 10:00 Chicago = 15:00 UTC (CDT).
  assert.strictEqual(result.toISOString(), '2026-06-13T15:00:00.000Z');
});

test('computeScheduledFor > honors event_timezone when computing the local hour', () => {
  const proposal = {
    event_date: '2026-06-20',
    event_start_time: '18:00',
    event_timezone: 'America/New_York',
  };
  const result = computeScheduledFor('event_week_reminder', proposal);
  // 10:00 EDT = 14:00 UTC
  assert.strictEqual(result.toISOString(), '2026-06-13T14:00:00.000Z');
});

test('computeScheduledFor > falls back to America/Chicago for invalid event_timezone', () => {
  const proposal = {
    event_date: '2026-06-20',
    event_start_time: '18:00',
    event_timezone: 'Bogus/Zone',
  };
  const result = computeScheduledFor('event_week_reminder', proposal);
  assert.strictEqual(result.toISOString(), '2026-06-13T15:00:00.000Z');
});

test('computeScheduledFor > throws on unknown messageType', () => {
  const proposal = { event_date: '2026-06-20', event_timezone: 'America/Chicago' };
  assert.throws(() => computeScheduledFor('not_a_real_type', proposal), /Unknown messageType/);
});

test('computeScheduledFor > T-30 long-lead lands at 10am event-local', () => {
  const proposal = {
    event_date: '2026-12-01',
    event_start_time: '18:00',
    event_timezone: 'America/Chicago',
  };
  const result = computeScheduledFor('long_lead_t30_recap', proposal);
  // T-30 of 2026-12-01 = 2026-11-01. At 10:00 Chicago in November = 16:00 UTC (CST).
  assert.strictEqual(result.toISOString(), '2026-11-01T16:00:00.000Z');
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
const { getHandlerMeta } = require('./scheduledMessageDispatcher');

/**
 * Constant for "10am event-local" used as the morning send hour for the
 * pre-event reminder ladder. The dispatcher metadata for each pre-event
 * message_type carries the offset in SECONDS from event_date midnight UTC
 * (e.g., event_week_reminder = -604800 = T-7 days). To land at 10am in the
 * EVENT'S timezone (not 10am UTC), we override the hour-of-day after the
 * raw offset math.
 *
 * Anchored on event date — NOT on shift start time — because these are
 * client-facing reminders that should land in the morning regardless of
 * the actual event start time.
 */
const SEND_HOUR_LOCAL = 10;

/**
 * Compute the UTC instant a pre-event (or any event-anchored) reminder should
 * send. SINGLE SOURCE OF TRUTH used by BOTH the initial scheduler
 * (`schedulePreEventReminders`) AND the reschedule cascade
 * (`reanchorPendingMessages`) so the two paths can never disagree.
 *
 * The dispatcher metadata (registered in `preEventHandlers.registerAll()` and
 * looked up via `getHandlerMeta(messageType)`) is the canonical source for
 * the offset and anchor. We read the offset in SECONDS, derive the calendar
 * day of the send, and then override the time-of-day with 10:00 IN THE
 * EVENT'S TIMEZONE so the send always lands at a tame morning hour for the
 * client (not 10am UTC, not 10am admin-local).
 *
 * @param {string} messageType - registered handler name, e.g. 'event_week_reminder'
 * @param {{ event_date: string|Date, event_timezone?: string }} proposal
 *        - or any object with the anchor field referenced by the handler meta
 * @returns {Date} UTC instant
 * @throws when the message_type has no registered handler metadata
 */
function computeScheduledFor(messageType, proposal) {
  const meta = getHandlerMeta(messageType);
  if (!meta) {
    throw new Error(`Unknown messageType: ${messageType} (no handler metadata registered — did you call registerAll() at boot?)`);
  }
  if (meta.offsetFromEventDate == null) {
    throw new Error(`computeScheduledFor: ${messageType} is anchor-independent (null offset) — caller must compute its own send time`);
  }
  const tz = resolveEventTimezone(proposal);

  // Pick the anchor field per handler meta (event_date | balance_due_date | created_at | completed_at)
  let anchorVal = null;
  switch (meta.anchor) {
    case 'balance_due_date': anchorVal = proposal.balance_due_date; break;
    case 'created_at':       anchorVal = proposal.created_at; break;
    case 'completed_at':     anchorVal = proposal.completed_at; break;
    case 'event_date':
    default:                 anchorVal = proposal.event_date; break;
  }
  if (!anchorVal) {
    throw new Error(`computeScheduledFor: ${messageType} requires anchor=${meta.anchor} but proposal lacks that field`);
  }

  // Parse anchor as a calendar date (treat as midnight UTC for the day-math)
  // and apply the offset in seconds.
  const anchorStr = String(anchorVal).slice(0, 10);
  const [y, m, d] = anchorStr.split('-').map(Number);
  const shiftedUtcMs = Date.UTC(y, m - 1, d) + meta.offsetFromEventDate * 1000;
  const shiftedDate = new Date(shiftedUtcMs);
  const shiftedYear = shiftedDate.getUTCFullYear();
  const shiftedMonth = shiftedDate.getUTCMonth() + 1;
  const shiftedDay = shiftedDate.getUTCDate();

  // Now compute "10:00 in tz on the shifted calendar date" → UTC.
  // Read the actual TZ offset Intl reports for noon UTC on the shifted day —
  // this handles DST transitions correctly because we ask about the specific
  // date, not the current date.
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
  const utcHour = SEND_HOUR_LOCAL - tzHours;
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
 * Called from two anchor points:
 *   1. The Stripe `payment_intent.succeeded` post-commit notifier when the
 *      deposit / full / coupled-sign+pay branch fires (initial schedule).
 *      Plan 2a also calls sibling `scheduleBalanceReminders` from the same
 *      anchor point.
 *   2. The reschedule cascade in `rescheduleProposalInTx` AFTER the reanchor
 *      pass, to add NEW long-lead rows when a reschedule moves the event
 *      into a 90+ day window (Pre-execution Finding W4).
 *
 * The optional `executor` parameter lets callers pass in a pg client that
 * already holds an open transaction (case #2). When omitted (case #1), the
 * function uses `pool` and each query runs in its own implicit transaction.
 *
 * @param {number|string} proposalId
 * @param {{ query: (text: string, params?: any[]) => Promise<any> }} [executor]
 *        - pg PoolClient or pool; defaults to `pool` if not supplied
 */
async function schedulePreEventReminders(proposalId, executor) {
  const exec = executor || pool;
  const { rows } = await exec.query(
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
  await insertIfMissing(exec, {
    entityType: 'proposal',
    entityId: proposal.id,
    messageType: 'event_week_reminder',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeScheduledFor('event_week_reminder', proposal),
  });

  // Conditionally schedule the T-30 long-lead recap
  if (shouldScheduleLongLeadRecap(proposal)) {
    await insertIfMissing(exec, {
      entityType: 'proposal',
      entityId: proposal.id,
      messageType: 'long_lead_t30_recap',
      recipientType: 'client',
      recipientId: proposal.client_id,
      channel: 'email',
      scheduledFor: computeScheduledFor('long_lead_t30_recap', proposal),
    });
  }
}

/**
 * Idempotent insert helper. Wraps `scheduleMessage` but first checks for an
 * existing pending row with the same (entity, message_type, recipient, channel).
 * Returns without inserting if one already exists.
 *
 * @param {{ query: Function }} executor - pg client or pool
 * @param {object} args - insert args
 */
async function insertIfMissing(executor, {
  entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor,
}) {
  const existing = await executor.query(
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
  // `scheduleMessage` (Plan 2a) accepts an optional executor too — if it
  // doesn't yet, fall through to the pool-based path. When it does (Plan 2a
  // ships with the contract), pass the executor through so the insert lands
  // in the caller's transaction.
  if (scheduleMessage.length >= 2) {
    await scheduleMessage({
      entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor,
    }, executor);
  } else {
    await scheduleMessage({
      entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor,
    });
  }
}

module.exports = {
  computeScheduledFor,
  shouldScheduleLongLeadRecap,
  schedulePreEventReminders,
  SEND_HOUR_LOCAL,
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

/**
 * Format start_time as "6:00 PM Central" — short 12-hour time + TZ abbreviation.
 *
 * IMPORTANT: `event_start_time` is wall-clock event-local time stored as a
 * string (e.g., '18:00' or '6:00 PM') — NOT a UTC ISO timestamp. We MUST NOT
 * parse it as UTC (e.g., `new Date('2026-08-15T18:00:00Z')`) and then format
 * in the event TZ — that would shift Chicago 18:00 to 13:00 ("1:00 PM CDT").
 *
 * Instead we format the literal string with `formatTime12` (string-based
 * 12-hour conversion that lives in `server/utils/eventCreation.js`) and
 * append the TZ abbreviation derived from the proposal's event_date in the
 * resolved TZ. The TZ abbreviation comes from `Intl.DateTimeFormat` with
 * `timeZoneName: 'short'` (e.g., "CDT", "EST", "PT").
 */
function formatStartTimeShort(proposal) {
  if (!proposal.event_start_time) return 'TBD';
  const tz = resolveEventTimezone(proposal);
  // Reuse the existing string-based 12-hour formatter so we never round-trip
  // through UTC. Accepts '18:00' or '6:00 PM' or '6:00 pm'.
  const raw = String(proposal.event_start_time).trim();
  let time12 = raw;
  // If it's a 24-hour HH:MM, convert. Otherwise pass through (already 12-hour).
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (Number.isFinite(h) && Number.isFinite(m)) {
      const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      const ampm = h >= 12 ? 'PM' : 'AM';
      time12 = `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
    }
  }
  // Derive the TZ abbreviation for the event date in the resolved zone.
  // Use the event_date at noon UTC as the reference instant — we just need a
  // moment near the event so DST is correct; the abbreviation is what we
  // pull out of formatToParts.
  let tzAbbrev = '';
  try {
    const dateStr = String(proposal.event_date || '').slice(0, 10);
    const refMs = Date.parse(`${dateStr}T12:00:00Z`);
    if (Number.isFinite(refMs)) {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'short',
      }).formatToParts(new Date(refMs));
      const tzPart = parts.find((p) => p.type === 'timeZoneName');
      if (tzPart && tzPart.value) tzAbbrev = ` ${tzPart.value}`;
    }
  } catch (_e) { /* leave tzAbbrev empty */ }
  return `${time12}${tzAbbrev}`;
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
 *
 * Both handlers register with metadata so Plan 2c's reschedule cascade can
 * recompute scheduled_for via `getHandlerMeta(messageType)` (Plan 2a Task 9).
 * Offset is in SECONDS (negative = before anchor). Anchor is `event_date`
 * because these are the pre-event reminder ladder; balance reminders use
 * `balance_due_date` (registered in Plan 2a).
 */
const DAY_SECONDS = 86400;
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

Read `server/routes/stripe.js` around lines 1107-1146 (the post-commit / first-delivery block that begins right after `await dbClient.query('COMMIT')` and the `if (isFirstDelivery)` guard, around line 1107, and ends with the shift-creation catch around line 1146). The block sequence is:

1. `if (isLastMinuteHold) notifyLastMinuteBooking(proposalId);`
2. `sendPaymentNotifications(proposalId, intent.amount, paymentType);`
3. `try { const shift = await createEventShifts(proposalId); ... } catch { ... }`

This is the post-commit "first-delivery notifier" — it fires AFTER the proposal transaction has committed and is gated on `isFirstDelivery`. The `paymentType` variable is in scope (set earlier from `intent.metadata?.payment_type`).

Plan 2a inserts `scheduleBalanceReminders(proposalId)` near the end of this same block. Plan 2c adds a sibling call.

- [ ] **Step 2: Add `schedulePreEventReminders` import at the top of the file**

Find the existing `require` block at the top of `server/routes/stripe.js`. Add:

```javascript
const { schedulePreEventReminders } = require('../utils/preEventScheduling');
```

- [ ] **Step 3: Call the helper at the end of the first-delivery post-commit block**

Find the post-commit block around lines 1107-1146 — the structure ends with the shift-creation try/catch:

```javascript
      if (isFirstDelivery) {
        if (isLastMinuteHold) notifyLastMinuteBooking(proposalId);
        sendPaymentNotifications(proposalId, intent.amount, paymentType);
        try {
          const shift = await createEventShifts(proposalId);
          if (shift) console.log(`Shift #${shift.id} created for proposal ${proposalId}`);
        } catch (shiftErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(shiftErr, {
              tags: { webhook: 'stripe', route: '/webhook' },
            });
          }
          console.error('Shift auto-creation failed (non-blocking):', shiftErr);
        }
      }
```

Immediately AFTER the shift-creation try/catch but STILL INSIDE the `if (isFirstDelivery)` block (so it's gated on first delivery — Stripe retries must not re-schedule), add:

```javascript
        // Schedule pre-event reminder emails (T-7 event-week, conditional
        // T-30 long-lead recap). Mirrors Plan 2a's balance-reminder
        // scheduling — both fire from this single anchor point. Inserts are
        // idempotent (insertIfMissing) so even if Stripe retries somehow
        // bypassed isFirstDelivery, we wouldn't double-schedule.
        //
        // Gate on deposit/full payment types — never on balance or
        // drink-plan-extras payments (those happen post-conversion when
        // reminders already exist).
        if (paymentType === 'deposit' || paymentType === 'full') {
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

Important: `isFirstDelivery` is the in-scope flag set earlier in the same handler when the `proposal_payments` insert succeeded with rowCount === 1. Because we're placing the new block INSIDE the existing `if (isFirstDelivery)` block, we only need to gate on `paymentType` here. The gate matches Plan 2a's pattern. Adjust the surrounding code to match the existing variables in `server/routes/stripe.js` if Plan 2a has already changed the shape.

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
const preEventHandlers = require('./preEventHandlers');

const TEST_CLIENT_ID = -2;
const TEST_PROPOSAL_ID = -202;

// Register handlers so `getHandlerMeta('event_week_reminder')` returns
// metadata for reanchor / rescheduleProposal. Without this, every reanchor
// would log "no handler metadata" and leave scheduled_for unchanged — the
// tests below assert it DOES update, so registration is mandatory.
before(() => {
  preEventHandlers.registerAll();
});

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
// Note: signature now takes (client, proposalId) — Gemini Finding 2. The
// test acquires a client and runs the call inside a transaction since the
// production code does.
test('reanchorPendingMessages > updates scheduled_for on pending event_week_reminder rows', async () => {
  // Register handler metadata so getHandlerMeta returns it.
  // In test setup, call preEventHandlers.registerAll() once in before().
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

  const client = await pool.connect();
  let updated = 0;
  try {
    await client.query('BEGIN');
    updated = await reanchorPendingMessages(client, TEST_PROPOSAL_ID);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
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

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await reanchorPendingMessages(client, TEST_PROPOSAL_ID);
    await client.query('COMMIT');
  } finally {
    client.release();
  }

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

// ── balance_due_date recomputation (Gemini Finding 4 — SUGGESTION) ──
test('rescheduleProposal > shifts balance_due_date by the same delta as event_date, preserving offset', async () => {
  // Original: event_date 2026-08-15, balance_due_date 2026-08-01 (14d before event).
  // Reschedule to event_date 2026-09-15 (30 days later).
  // Expect: balance_due_date 2026-09-01 (still 14d before new event).
  await pool.query(
    `INSERT INTO proposals
       (id, client_id, status, event_date, event_start_time, event_timezone,
        balance_due_date, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-08-15', '18:00', 'America/Chicago',
        '2026-08-01', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );

  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'A' };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  const { rows } = await pool.query(
    'SELECT balance_due_date FROM proposals WHERE id = $1',
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(String(rows[0].balance_due_date).slice(0, 10), '2026-09-01');
});

test('rescheduleProposal > preserves a custom (non-14-day) balance offset on reschedule', async () => {
  // Admin set a custom 21-day lead: event 2026-08-15, balance due 2026-07-25.
  // Reschedule event to 2026-09-15. Expect balance due 2026-08-25 (still 21d).
  await pool.query(
    `INSERT INTO proposals
       (id, client_id, status, event_date, event_start_time, event_timezone,
        balance_due_date, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-08-15', '18:00', 'America/Chicago',
        '2026-07-25', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );

  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'A' };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  const { rows } = await pool.query(
    'SELECT balance_due_date FROM proposals WHERE id = $1',
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(String(rows[0].balance_due_date).slice(0, 10), '2026-08-25');
});

test('rescheduleProposal > re-anchors balance-anchored pending rows against the NEW balance_due_date', async () => {
  // Event 2026-08-15, balance_due 2026-08-01 (14d before). T-3 balance reminder
  // pending for 2026-07-29 (3d before balance_due). Reschedule event to
  // 2026-09-15 → balance_due moves to 2026-09-01 → T-3 reminder should
  // re-anchor to 2026-08-29.
  await pool.query(
    `INSERT INTO proposals
       (id, client_id, status, event_date, event_start_time, event_timezone,
        balance_due_date, created_at, total_price)
     VALUES ($1, $2, 'deposit_paid', '2026-08-15', '18:00', 'America/Chicago',
        '2026-08-01', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  // NOTE: this test depends on Plan 2a having registered a handler for
  // `balance_reminder_t3` with metadata `{ anchor: 'balance_due_date',
  // offsetFromEventDate: -3 * 86400 }` (or equivalent — value is in seconds
  // relative to anchor). If Plan 2a hasn't shipped, this assertion is
  // deferred. Without that registration, `getHandlerMeta(...)` returns
  // null and the row is left alone.
  await pool.query(
    `INSERT INTO scheduled_messages
       (entity_type, entity_id, message_type, recipient_type, recipient_id,
        channel, scheduled_for, status)
     VALUES ('proposal', $1, 'balance_reminder_t3', 'client', $2, 'email',
        '2026-07-29T15:00:00.000Z', 'pending')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );

  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'A' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'A' };
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  // Confirm balance_due_date moved to 2026-09-01
  const { rows: propRows } = await pool.query(
    'SELECT balance_due_date FROM proposals WHERE id = $1',
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(String(propRows[0].balance_due_date).slice(0, 10), '2026-09-01');

  // If Plan 2a's handler is registered, the T-3 row should now anchor to
  // 2026-08-29 (3d before new balance_due_date 2026-09-01). If unregistered,
  // the row is unchanged at 2026-07-29 — that's the deferred-on-Plan-2a path.
  const { rows: smRows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
       WHERE entity_type = 'proposal' AND entity_id = $1
         AND message_type = 'balance_reminder_t3'`,
    [TEST_PROPOSAL_ID]
  );
  const scheduledIso = new Date(smRows[0].scheduled_for).toISOString().slice(0, 10);
  // Accept either 2026-08-29 (Plan 2a registered) OR 2026-07-29 (unregistered).
  assert.ok(
    scheduledIso === '2026-08-29' || scheduledIso === '2026-07-29',
    `expected balance reminder to be re-anchored to 2026-08-29 (or left at 2026-07-29 if Plan 2a handler not registered), got ${scheduledIso}`
  );
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

test('rescheduleProposal > commits DB changes and swallows post-commit email failure when client has no email', async () => {
  // Pre-execution Finding B4: the implementation runs the email send in a
  // post-commit try/catch that reports to Sentry and console-errors, but
  // NEVER rethrows. DB state must always commit even when the email surface
  // is broken. The test asserts the non-rejecting behavior + side effects
  // (DB updated, no email actually sent).
  await pool.query(
    `INSERT INTO clients (id, name, email, phone) VALUES (-3, 'No Email', NULL, '+15555555555')
     ON CONFLICT (id) DO NOTHING`
  );
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_location, event_timezone, created_at, total_price)
     VALUES ($1, -3, 'deposit_paid', '2026-09-15', '18:00', 'Venue', 'America/Chicago', '2026-07-01T12:00:00Z', 1000)`,
    [TEST_PROPOSAL_ID]
  );
  // Seed a pending row so we can verify the DB-side reanchor still ran.
  await pool.query(
    `INSERT INTO scheduled_messages
     (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for, status)
     VALUES ('proposal', $1, 'event_week_reminder', 'client', -3, 'email', '2026-08-08T15:00:00.000Z', 'pending')`,
    [TEST_PROPOSAL_ID]
  );
  const old = { event_date: '2026-08-15', event_start_time: '18:00', event_location: 'X' };
  const updated = { event_date: '2026-09-15', event_start_time: '18:00', event_location: 'Y' };

  // Should resolve, NOT reject — even though the email send will throw
  // internally (sendRescheduleEmail's `no email` guard), the outer try/catch
  // around the post-commit email call swallows it.
  await rescheduleProposal({ proposalId: TEST_PROPOSAL_ID, old, updated });

  // Email mock should not have been invoked (the guard threw before reaching sendEmail)
  assert.strictEqual(emailCalls.length, 0);

  // The DB-side reanchor must have run: pending row's scheduled_for should
  // now be T-7 of the new event_date (2026-09-15 → 2026-09-08 at 10am CDT).
  const { rows } = await pool.query(
    `SELECT scheduled_for FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND message_type = 'event_week_reminder'`,
    [TEST_PROPOSAL_ID]
  );
  assert.strictEqual(new Date(rows[0].scheduled_for).toISOString(), '2026-09-08T15:00:00.000Z');

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
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { resolveEventTimezone, formatEventLocalTime } = require('./eventTimezone');
const { getHandlerMeta } = require('./scheduledMessageDispatcher');
const { shouldSendImmediate } = require('./messageSuppression');
const { computeScheduledFor, schedulePreEventReminders } = require('./preEventScheduling');

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
 * Compute the new scheduled_for for a pending row given the proposal's NEW
 * event_date / balance_due_date and the handler's registered offset metadata.
 *
 * Delegates to `computeScheduledFor(messageType, proposal)` — the SAME helper
 * the initial scheduler uses (`preEventScheduling.js`) — so reanchor and
 * initial-schedule paths can NEVER drift apart. In particular, the helper
 * preserves the "10am in event-local TZ" hour (e.g., 15:00 UTC for Chicago
 * CDT), which a raw `event_date_midnight + offset_seconds` calc would lose.
 *
 * Returns null when the handler isn't registered, has a null offset (e.g.,
 * drip touches anchored to the proposal-sent moment rather than event_date),
 * or the required anchor field is missing on the proposal.
 *
 * @param {object} proposal - includes event_date, balance_due_date, event_timezone, etc.
 * @param {string} messageType - the row's message_type
 * @returns {Date|null}
 */
function computeReanchoredScheduledFor(proposal, messageType) {
  const meta = getHandlerMeta(messageType);
  if (!meta) return null;
  if (meta.offsetFromEventDate == null) return null; // anchor-independent
  // Verify the required anchor field is present BEFORE delegating, so we can
  // distinguish "no anchor" (return null) from "computeScheduledFor throws".
  const anchorVal = meta.anchor === 'balance_due_date'
    ? proposal.balance_due_date
    : meta.anchor === 'completed_at'
      ? proposal.completed_at
      : meta.anchor === 'created_at'
        ? proposal.created_at
        : proposal.event_date;
  if (!anchorVal) return null;
  try {
    return computeScheduledFor(messageType, proposal);
  } catch (_e) {
    return null;
  }
}

/**
 * Re-anchor all pending scheduled_messages rows for the proposal. Each row's
 * scheduled_for is recomputed from the NEW proposal anchor field (event_date
 * or balance_due_date) plus the handler's offset (looked up via
 * `getHandlerMeta` from Plan 2a's dispatcher registry).
 *
 * Only touches rows where status = 'pending'. Sent / failed / suppressed rows
 * are left alone.
 *
 * Unknown / no-offset message_types are skipped (anchor-independent touches
 * like drip stay where they are).
 *
 * REQUIRES a `pg` client (pool client checked out by the caller) — the caller
 * MUST run this inside its own transaction so the reschedule is atomic with
 * the proposal UPDATE (Gemini Finding 2).
 *
 * @param {import('pg').PoolClient} client
 * @param {number|string} proposalId
 * @returns {Promise<number>} count of rows updated
 */
async function reanchorPendingMessages(client, proposalId) {
  const propRes = await client.query(
    `SELECT id, event_date, event_start_time, event_timezone, balance_due_date,
            created_at, completed_at
       FROM proposals WHERE id = $1`,
    [proposalId]
  );
  const proposal = propRes.rows[0];
  if (!proposal || !proposal.event_date) return 0;

  const pendingRes = await client.query(
    `SELECT id, message_type
       FROM scheduled_messages
      WHERE entity_type = 'proposal' AND entity_id = $1
        AND status = 'pending'`,
    [proposalId]
  );

  let updated = 0;
  for (const row of pendingRes.rows) {
    const meta = getHandlerMeta(row.message_type);
    if (!meta) {
      console.warn(`[rescheduleProposal] no handler metadata for message_type=${row.message_type} (row id=${row.id}); leaving scheduled_for unchanged`);
      continue;
    }
    const newScheduledFor = computeReanchoredScheduledFor(proposal, row.message_type);
    if (!newScheduledFor) {
      // Anchor-independent (offsetFromEventDate === null) or missing anchor
      // field — leave the row alone.
      continue;
    }
    await client.query(
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
 * Runs AFTER the DB transaction commits (Gemini Finding 2). The DB-side
 * reschedule is atomic; the email is fired non-blockingly afterwards because
 * an email failure should not roll back the proposal UPDATE.
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
            c.id AS client_id, c.name AS client_name, c.email AS client_email,
            c.communication_preferences, c.email_status, c.phone_status,
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

  const tz = resolveEventTimezone(ctx);

  const fmtDate = (d) => {
    if (!d) return 'TBD';
    const iso = String(d).slice(0, 10) + 'T12:00:00Z';
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) return 'TBD';
    return formatEventLocalTime(parsed, tz, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };
  // IMPORTANT: event_start_time is wall-clock event-local time stored as a
  // string (e.g., '18:00' or '6:00 PM'). We must NOT parse it as UTC and then
  // format in event TZ — that round-trip shifts the displayed time by the TZ
  // offset (e.g., Chicago 18:00 → displays as 1:00 PM CDT). Instead we
  // string-format the literal time and append the TZ abbreviation pulled
  // from the event_date in the resolved zone.
  const fmtTime = (date, time) => {
    if (!time || !date) return 'TBD';
    const raw = String(time).trim();
    let time12 = raw;
    const hhmm = /^(\d{1,2}):(\d{2})$/.exec(raw);
    if (hhmm) {
      const h = Number(hhmm[1]);
      const m = Number(hhmm[2]);
      if (Number.isFinite(h) && Number.isFinite(m)) {
        const hour12 = h > 12 ? h - 12 : (h === 0 ? 12 : h);
        const ampm = h >= 12 ? 'PM' : 'AM';
        time12 = `${hour12}:${String(m).padStart(2, '0')} ${ampm}`;
      }
    }
    let tzAbbrev = '';
    try {
      const dateStr = String(date).slice(0, 10);
      const refMs = Date.parse(`${dateStr}T12:00:00Z`);
      if (Number.isFinite(refMs)) {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          timeZoneName: 'short',
        }).formatToParts(new Date(refMs));
        const tzPart = parts.find((p) => p.type === 'timeZoneName');
        if (tzPart && tzPart.value) tzAbbrev = ` ${tzPart.value}`;
      }
    } catch (_e) { /* leave empty */ }
    return `${time12}${tzAbbrev}`;
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
 * In-transaction reschedule (Gemini Finding 2): re-anchor all pending
 * scheduled_messages rows for the proposal in the same DB transaction as
 * the proposal UPDATE. The CALLER manages the transaction (BEGIN/COMMIT)
 * because the caller is also updating the proposal row.
 *
 * Caller pattern (see Task 7):
 *
 *   const client = await pool.connect();
 *   try {
 *     await client.query('BEGIN');
 *     await client.query('UPDATE proposals SET event_date=$1 ... WHERE id=$2', [...]);
 *     await rescheduleProposalInTx(client, { proposalId, old, updated });
 *     await client.query('COMMIT');
 *   } catch (err) {
 *     await client.query('ROLLBACK');
 *     throw err;
 *   } finally {
 *     client.release();
 *   }
 *   // Post-commit, fire the email non-blockingly:
 *   sendRescheduleEmail({ proposalId, old, updated }).catch(/* sentry + log */);
 *
 * This split keeps the DB state consistent under all failure modes:
 *   - If anything before COMMIT throws → ROLLBACK; no email, no DB change
 *   - If COMMIT succeeds → DB is updated; email fires best-effort
 *   - If email send fails after COMMIT → admin can manually re-send; DB is
 *     already consistent
 *
 * @param {import('pg').PoolClient} client - pg client already inside a tx
 * @param {object} args
 * @param {number|string} args.proposalId
 * @param {object} args.old - proposal row BEFORE the UPDATE
 * @param {object} args.updated - proposal row AFTER the UPDATE
 * @returns {Promise<{shouldSendEmail: boolean}>} caller uses shouldSendEmail
 *   to decide whether to dispatch the email after COMMIT
 */
async function rescheduleProposalInTx(client, { proposalId, old, updated }) {
  if (!hasReschedulableChange(old, updated)) return { shouldSendEmail: false };

  // Read status + ORIGINAL event_date / balance_due_date as they exist BEFORE
  // this function's UPDATE. CRITICAL: when the PATCH handler is the caller,
  // it has ALREADY run `UPDATE proposals SET event_date = $newDate ...`
  // earlier in the same transaction. So a naive `SELECT event_date,
  // balance_due_date` here returns NEW event_date + OLD balance_due_date,
  // which would yield a junk offset. Instead, we rely on `old` (the pre-PATCH
  // row passed in by the caller) as the source of truth for the original
  // event_date and balance_due_date. The caller MUST include `balance_due_date`
  // on the `old` row — the PATCH handler captures it via `SELECT * FROM
  // proposals WHERE id = $1` before issuing the UPDATE.
  const statusRow = await client.query('SELECT status FROM proposals WHERE id = $1', [proposalId]);
  const status = statusRow.rows[0]?.status;
  if (!status) return { shouldSendEmail: false };

  // Gate post-sign+pay: only meaningful for proposals at or past deposit_paid.
  // Pre-sign+pay date/time edits don't need a reschedule email — the proposal
  // hasn't been sent yet (or has been sent but not signed, in which case the
  // next status-driven email replaces it).
  const POST_SIGNPAY = new Set(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
  if (status === 'archived' || !POST_SIGNPAY.has(status)) return { shouldSendEmail: false };

  // Gemini Finding 4 (SUGGESTION) + Pre-execution Finding B3: when event_date
  // shifts, recompute balance_due_date by preserving the ORIGINAL offset
  // between event_date and balance_due_date.
  //
  // Use the `old` row (captured by the caller BEFORE the proposal UPDATE) for
  // both event_date and balance_due_date. Reading from the DB here would
  // return mixed-era data (new event_date + old balance_due_date) because the
  // PATCH handler updates event_date earlier in the same transaction. The
  // mixed read would produce a wrong offset and a no-op balance update.
  //
  // The codebase rule (see server/routes/stripe.js) is
  // `balance_due_date = event_date - INTERVAL '14 days'` (via COALESCE so
  // admin-edited custom dates aren't clobbered on first deposit). We preserve
  // the EXISTING offset so an admin-adjusted 21-day lead survives the
  // reschedule.
  //
  // Runs BEFORE reanchorPendingMessages so the dispatcher metadata lookup
  // for balance-anchored handlers sees the new balance_due_date.
  const oldEventDateStr = old.event_date ? String(old.event_date).slice(0, 10) : null;
  const newEventDateStr = updated.event_date ? String(updated.event_date).slice(0, 10) : null;
  if (oldEventDateStr && newEventDateStr && oldEventDateStr !== newEventDateStr) {
    const oldBalanceDueStr = old.balance_due_date ? String(old.balance_due_date).slice(0, 10) : null;
    if (oldBalanceDueStr) {
      // Preserve the existing offset (in days) between OLD event_date and
      // OLD balance_due_date. Default codebase rule is event_date - 14, but
      // an admin may have set a different lead via PATCH
      // /proposals/:id/balance-due.
      const oldEventMs = new Date(oldEventDateStr + 'T00:00:00Z').getTime();
      const oldBalanceMs = new Date(oldBalanceDueStr + 'T00:00:00Z').getTime();
      const offsetDays = Math.round((oldBalanceMs - oldEventMs) / 86400000); // typically -14
      const newEventMs = new Date(newEventDateStr + 'T00:00:00Z').getTime();
      const newBalanceMs = newEventMs + offsetDays * 86400000;
      const newBalanceIso = new Date(newBalanceMs).toISOString().slice(0, 10);
      await client.query(
        'UPDATE proposals SET balance_due_date = $1 WHERE id = $2',
        [newBalanceIso, proposalId]
      );
    } else {
      // No balance_due_date set on the old row (rare — pre-deposit reschedule
      // that somehow reached this code path, or a custom flow). Apply the
      // codebase default rule: event_date - 14 days.
      const newEventMs = new Date(newEventDateStr + 'T00:00:00Z').getTime();
      const newBalanceIso = new Date(newEventMs - 14 * 86400000).toISOString().slice(0, 10);
      await client.query(
        'UPDATE proposals SET balance_due_date = $1 WHERE id = $2',
        [newBalanceIso, proposalId]
      );
    }
  }

  await reanchorPendingMessages(client, proposalId);

  // Pre-execution Finding W4: spec section 7.8 says a reschedule that moves
  // the event INTO a 90+ day window must add the T-30 long-lead recap (and
  // any other future eligibility-gated touches). The reanchor pass only
  // updates EXISTING pending rows; it can't insert net-new ones for a
  // recap that was never originally scheduled (because the proposal booked
  // <90 days out the first time around).
  //
  // We re-run the eligibility evaluation via `schedulePreEventReminders`,
  // which is idempotent (its `insertIfMissing` helper SELECTs first and
  // skips duplicates). It will:
  //   - Re-confirm the always-on event_week_reminder is in place
  //     (no-op since the row already exists and was just reanchored)
  //   - Insert a long_lead_t30_recap row IF the proposal's lead time
  //     (event_date - created_at) is now >= 90 days AND no recap row
  //     exists yet
  //
  // This runs inside the same transaction so atomicity is preserved — we
  // pass the in-tx `client` so the eligibility-driven inserts join the
  // open transaction.
  try {
    await schedulePreEventReminders(proposalId, client);
  } catch (evalErr) {
    // Eligibility re-evaluation is best-effort relative to the reanchor
    // (which is the load-bearing piece). Log + swallow so a missing
    // long_lead row doesn't roll back the date change.
    console.warn('[rescheduleProposal] post-reanchor eligibility re-evaluation failed (non-fatal):', evalErr.message);
  }
  return { shouldSendEmail: true };
}

/**
 * Convenience orchestrator used by tests and any caller that doesn't already
 * hold a transaction. Acquires its own client, runs the UPDATE re-anchor
 * inside BEGIN/COMMIT, then fires the email. The PATCH handler in
 * routes/proposals/crud.js uses the in-tx helpers directly because it has
 * its own transaction; this function is the simple-path version.
 *
 * Errors are thrown — the caller is responsible for catching and logging
 * non-blockingly.
 */
async function rescheduleProposal({ proposalId, old, updated }) {
  const client = await pool.connect();
  let shouldSendEmail = false;
  let hydratedOld = old;
  try {
    await client.query('BEGIN');
    // Hydrate `old` with balance_due_date if the caller didn't supply it.
    // Pre-execution Finding B3: rescheduleProposalInTx needs the ORIGINAL
    // balance_due_date to preserve the existing offset between event_date
    // and balance_due_date. In the convenience-path (this function), the DB
    // is still in the original state at this point because no UPDATE has
    // run yet, so reading balance_due_date here is safe and correct.
    if (old && old.balance_due_date == null) {
      const r = await client.query(
        'SELECT balance_due_date FROM proposals WHERE id = $1',
        [proposalId]
      );
      hydratedOld = { ...old, balance_due_date: r.rows[0]?.balance_due_date || null };
    }
    const result = await rescheduleProposalInTx(client, { proposalId, old: hydratedOld, updated });
    shouldSendEmail = result.shouldSendEmail;
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Email runs OUTSIDE the transaction so a Resend failure can't roll back
  // the DB changes. Email send is not idempotent-safe — better ordering is
  // DB commits first, then email; on email failure the DB is still consistent
  // and admin can re-send manually.
  if (shouldSendEmail) {
    try {
      await sendRescheduleEmail({ proposalId, old: hydratedOld, updated });
    } catch (emailErr) {
      Sentry.captureException(emailErr, {
        tags: { component: 'rescheduleProposal', step: 'post_commit_email' },
        extra: { proposalId },
      });
      console.error('[rescheduleProposal] post-commit email failed (non-fatal):', emailErr.message);
      // Don't rethrow — DB is consistent, admin can manually resend.
    }
  }
}

module.exports = {
  rescheduleProposal,
  rescheduleProposalInTx,
  hasReschedulableChange,
  reanchorPendingMessages,
  computeReanchoredScheduledFor,
  sendRescheduleEmail,
};
```

- [ ] **Step 4: Run tests to verify pass**

```bash
node --test server/utils/rescheduleProposal.test.js
```

Expected: all tests pass. Notes:
- The `archived` test inserts a proposal with `status='archived'`. The current `rescheduleProposal` returns silently because `POST_SIGNPAY` does NOT include 'archived'.
- The `no-email` test verifies the post-commit email failure is SWALLOWED (Sentry + console only) so the DB stays consistent. The DB-side reanchor still runs because it executes inside the transaction BEFORE the email attempt.

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

- [ ] **Step 2: Add the imports**

At the top of `server/routes/proposals/crud.js`, alongside other utility imports:

```javascript
const { rescheduleProposalInTx, sendRescheduleEmail } = require('../../utils/rescheduleProposal');
```

- [ ] **Step 3: Run reanchor inside the existing PATCH transaction (Gemini Finding 2)**

The PATCH handler already runs the UPDATE inside its own transaction (via the `dbClient` checked out from the pool). Gemini Finding 2 says the reschedule re-anchor MUST happen in the SAME transaction so the proposal row and the scheduled_messages rows commit together. The email goes AFTER the commit.

**Atomicity coupling — design note (Pre-execution Finding W3).** Running
`rescheduleProposalInTx` INSIDE the existing PATCH transaction means a
scheduled-messages reanchor failure will ROLL BACK the user's date change.
This is a deliberate trade-off vs. the established invoice-refresh pattern
(separate transaction, allow user edit to land even if downstream work
fails). We chose tx-coupled here because:

- The state divergence from a half-applied reschedule (event_date moved but
  pending reminders still anchored to the OLD date) would silently send
  T-7 reminders aimed at a date that's no longer the event. That's worse
  than failing the PATCH loudly and letting the admin retry.
- The reanchor itself is a small set of UPDATE statements on a single
  table; failure modes are limited to lock contention, which is rare and
  best surfaced via the PATCH error response.

If a future evolution wants per-message-type failure isolation, the right
move is to wrap each scheduled_messages UPDATE in its own savepoint, not
to extract the reanchor into a separate transaction.

In the PATCH handler, find the block that runs the UPDATE inside `dbClient.query('BEGIN')` / `COMMIT`. After the UPDATE succeeds and BEFORE `dbClient.query('COMMIT')`, add:

```javascript
      // Gemini Finding 2: reschedule re-anchor runs INSIDE the same tx as
      // the proposal UPDATE so DB state is atomic. The email fires after
      // COMMIT (best-effort, non-blocking).
      let shouldSendRescheduleEmail = false;
      try {
        const result = await rescheduleProposalInTx(dbClient, {
          proposalId: parseInt(req.params.id, 10),
          old,                          // pre-UPDATE row
          updated: updatedRow.rows[0],  // post-UPDATE row
        });
        shouldSendRescheduleEmail = result.shouldSendEmail;
      } catch (rescheduleErr) {
        // A failure here ROLLs BACK the whole PATCH so DB state stays
        // consistent. Re-throw to land in the existing catch block.
        throw rescheduleErr;
      }
```

Then immediately AFTER `await dbClient.query('COMMIT')` succeeds, but BEFORE `res.json(...)` returns the response (still inside the outer try block surrounding the transaction), fire the email best-effort with its OWN inner try/catch that NEVER rethrows. The email send must NOT propagate into the outer catch — a Resend failure happens after the DB is already consistent, so the PATCH response should still report success.

```javascript
    // COMMIT just succeeded. The reschedule email is best-effort, post-commit.
    // Inner try/catch is mandatory — we must NEVER rethrow into the outer
    // catch (which would 500 the PATCH response even though the DB committed
    // successfully).
    if (shouldSendRescheduleEmail) {
      try {
        await sendRescheduleEmail({
          proposalId: parseInt(req.params.id, 10),
          old,
          updated: updatedRow.rows[0],
        });
      } catch (emailErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(emailErr, {
            tags: { route: 'proposals/update', issue: 'reschedule-email' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('Reschedule email failed (non-blocking, DB already committed):', emailErr);
        // Do NOT rethrow — DB is consistent; admin can manually re-send.
      }
    }
    // …then res.json(updatedRow.rows[0]); proceeds as before.
```

Hoist `shouldSendRescheduleEmail` to the outer scope (declare with `let shouldSendRescheduleEmail = false;` near where `old` is captured) so the post-commit block can read it.

Placement summary (for clarity — the outer try wraps everything including the DB tx, the email send, AND res.json):

```
try {                                     // outer try (existing handler)
  dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    // … existing UPDATE proposals SET event_date = ... ;
    const result = await rescheduleProposalInTx(dbClient, { ... });
    shouldSendRescheduleEmail = result.shouldSendEmail;
    await dbClient.query('COMMIT');       // <— DB is now consistent
  } catch (txErr) {
    await dbClient.query('ROLLBACK');
    throw txErr;
  } finally {
    dbClient.release();
  }
  if (shouldSendRescheduleEmail) {
    try { await sendRescheduleEmail(...); }
    catch (emailErr) { /* sentry + log; never rethrow */ }
  }
  res.json(updatedRow.rows[0]);            // <— response goes out
} catch (err) { /* existing outer catch */ }
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

Also confirm `balance_due_date` shifted by the same delta (Gemini Finding 4):

```bash
psql "$DATABASE_URL" -c "
SELECT event_date, balance_due_date FROM proposals WHERE id = <test_proposal_id>;
"
```

Expected: `balance_due_date` is now `<new event_date> - <original offset>` (typically `event_date - 14 days`). Balance-anchored scheduled_messages rows should re-anchor against this new date in the same transaction.

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
- `server/utils/rescheduleProposal.js` — sends the immediate reschedule notification email, recomputes `proposals.balance_due_date` (preserving the original offset from event_date) when event_date shifts, and re-anchors all pending `scheduled_messages` rows when admin edits event_date/start_time/location on a post-sign+pay proposal (Plan 2c)
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
- [ ] Smoke test confirms `proposals.balance_due_date` shifts by the same delta as `event_date` on reschedule (Gemini Finding 4)
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
| 7.8 Reschedule handling | Task 6 (re-anchor logic + balance_due_date recompute), Task 7 (PATCH hook) | `scheduled_for` recomputed via `computeScheduledFor` for every pending row whose `message_type` has a registered offset; `balance_due_date` recomputed in the same transaction when event_date shifts, preserving the existing offset |

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
