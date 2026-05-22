# Comms Phase 4a — Staff-Facing SMS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add automated staff-facing SMS to drb-os: a day-before shift reminder, a post-event thank-you, and admin-toggled schedule-change and cancellation/unassignment notices, plus the `notify_assigned_staff` editor UI and the cancel/unassign code paths those notices need.

**Architecture:** Two scheduled SMS touches (`shift_reminder`, `staff_thank_you`) ride the existing `scheduled_messages` dispatcher as new `message_type`s with handlers in a new `server/utils/staffShiftHandlers.js`. A single shared helper `scheduleStaffShiftMessages(shiftId, executor)` is called from all four staff-assignment code paths so a reminder is scheduled no matter how a staffer lands on a shift. Two immediate (non-scheduled) SMS touches — schedule-change and cancel/unassign — are best-effort hooks gated by transient per-edit toggles plumbed through `PATCH /api/proposals/:id` and a net-new `POST /api/shifts/:id/cancel-or-unassign` route. Staff SMS copy lives in `server/utils/smsTemplates.js` (created by Phase 3; this plan appends to it). The dispatcher's `checkSuppression` gains two things: `recipient_type IN ('staff','admin')` per-channel branches, and an archived-proposal cascade for `entity_type='shift'` rows (the existing archived branch only covers `entity_type='proposal'`, so staff shift rows on an archived proposal would otherwise dispatch and fail rather than suppress).

**Tech Stack:** Node.js 18 / Express 4.18, raw SQL via `pg`, Twilio SMS, React 18 (admin UI). Tests use Node's built-in test runner (`node --test`) against the shared dev database.

---

## Dependencies and ground rules (read before starting)

**This plan CONSUMES the SMS rails built by Phase 3.** Do not build or re-specify them. The rails are:

- **`sendAndLogSms({ to, body, clientId = null, messageType, recipientName = null }) => { sid, status }`** — added to `server/utils/sms.js` by Phase 3. Normalizes `to`, sends via Twilio, INSERTs an outbound `sms_messages` row, and **throws** on Twilio failure (after logging a `failed` row). This plan calls it for every staff SMS. Staff SMS pass `clientId: null` (staff rows are not client-threaded).
- **`server/utils/smsTemplates.js`** — created by Phase 3 with client SMS copy. This plan **appends** four staff copy functions to it (Task 1). If executing this plan before Phase 3 has created the file, Task 1 creates the file instead; the `require` and append logic in Task 1 handles both cases.

**If `sendAndLogSms` does not yet exist when this plan executes** (Phase 3 not merged): the executing agent must stop and surface this. Phase 3 is the prerequisite per the cross-plan contract. Do not stub `sendAndLogSms` — that would diverge from the pinned rails.

**Priority option is inert until Phase 4b.** Every scheduled handler this plan registers passes a `priority` integer in its `registerHandler` options. `registerHandler` ignores unknown option keys today (verified: `server/utils/scheduledMessageDispatcher.js` `registerHandler` only reads `offsetFromEventDate`, `anchor`, `category`). The value sits inert until Phase 4b activates it. Do NOT build the priority/cooldown rule here — that is Phase 4b's scope. Per the contract priority ladder: `shift_reminder` is priority `1`, `staff_thank_you` is priority `3`.

**Project rules baked into this plan:**
- SQL is parameterized (`$1`, `$2`). Async route handlers wrap with `asyncHandler` and throw `AppError` subclasses (`ValidationError`, `NotFoundError`, `PermissionError`).
- Multi-table writes wrap in `BEGIN`/`COMMIT`/`ROLLBACK`.
- Best-effort notification hooks get their own `try`/`catch` + `Sentry.captureException`, and never rethrow into a request path.
- No em dashes in any staff-facing copy (SMS bodies). Use commas, periods, colons.
- Schema changes are idempotent. **This plan adds no schema columns** — the `notify_assigned_staff` toggles are transient per-request flags, and `scheduled_messages` / `shift_requests` already have every column needed.
- Commit steps use plain one-line `git commit -m "..."` — no co-author footer, no heredoc.
- Frontend API calls go through `client/src/utils/api.js`. Async UI has loading and error states.

**File-size watch.** `server/routes/proposals/crud.js` is 971 lines (1000-line hard cap). Task 9 adds code there; to stay net-flat-or-shrinking it FIRST extracts the schedule-change staff-notify hook into a helper module, so the crud.js delta is near zero. `server/routes/shifts.js` is 727 lines (soft cap 700, hard cap 1000) — Task 7 keeps shift-side additions thin and routes shared logic through `staffShiftHandlers.js`.

**Running tests.** There is no `npm test` script. Run a single test file with:
```
node --test server/utils/<file>.test.js
```
Test files run in parallel against the shared dev DB; scope every fixture delete to that file's own IDs (negative IDs or a unique email), exactly as the existing `*.test.js` files do.

**Staff-assignment code paths (the four that must schedule a reminder), verified in current code:**
1. `POST /api/shifts/:id/assign` — `server/routes/shifts.js` ~line 481. Upserts a `shift_requests` row to `status='approved'`.
2. `PUT /api/shifts/requests/:requestId` — `server/routes/shifts.js` ~line 579, the `status === 'approved'` branch. Flips a request to `approved`.
3. `POST /api/shifts/:id/auto-assign` — `server/routes/shifts.js` ~line 671 → `autoAssignShift()` in `server/utils/autoAssign.js`. The batch approval UPDATE is `autoAssign.js` ~line 304.
4. `autoAssignScheduler.processScheduledAutoAssigns()` — `server/utils/autoAssignScheduler.js`, also calls `autoAssignShift()`.

Paths 3 and 4 both funnel through `autoAssignShift()`, so wiring the shared helper into `autoAssignShift()` covers both. Paths 1 and 2 are wired directly in `shifts.js`.

---

## File Structure

**New files:**
- `server/utils/staffShiftHandlers.js` — staff scheduled-SMS handlers (`shift_reminder`, `staff_thank_you`), their `registerStaffShiftHandlers()` entry point, the shared `scheduleStaffShiftMessages(shiftId, executor)` scheduler, the bespoke timing helpers, and the immediate `notifyStaffOfScheduleChange` / `notifyStaffOfCancellation` hooks. One concern: all staff-shift comms.
- `server/utils/staffShiftHandlers.test.js` — tests for the above.
- `server/routes/shifts.cancelUnassign.test.js` — tests for the new cancel/unassign route (kept in a sibling file so `shifts.js` test surface stays focused; mirrors the per-file test layout).

**Modified files:**
- `server/utils/smsTemplates.js` — append four staff SMS copy functions (or create the file if Phase 3 has not yet).
- `server/utils/scheduledMessageDispatcher.js` — two `checkSuppression` edits: add `recipient_type IN ('staff','admin')` per-channel branches, and extend the archived-proposal cascade to `entity_type='shift'` rows (join `shifts → proposals`). Export `_dispatchRowForTest` is NOT needed (tests drive via `dispatchPending`).
- `server/index.js` — call `registerStaffShiftHandlers()` at boot, beside the existing `registerAll()` / `registerMarketingHandlers()` calls.
- `server/routes/shifts.js` — call `scheduleStaffShiftMessages()` from the manual-assign and approve paths; add the `POST /api/shifts/:id/cancel-or-unassign` route.
- `server/utils/autoAssign.js` — call `scheduleStaffShiftMessages()` after the batch approval UPDATE (covers auto-assign route + scheduler).
- `server/routes/proposals/crud.js` — destructure the `notify_assigned_staff` / `notify_staff_sms` / `notify_staff_email` toggles from the request body, and in the reschedule block call `runRescheduleStaffHooks()` after commit (best-effort: re-anchors pending staff SMS rows, and sends the schedule-change SMS/email when the admin opted in).
- `client/src/pages/admin/EventEditForm.js` — add the `notify_assigned_staff` checkbox + email/SMS sub-checkboxes; plumb them through the `PATCH /proposals/:id` body.
- `README.md` / `ARCHITECTURE.md` — folder tree + route table updates (Task 12).

---

## Task 1: Staff SMS copy in `smsTemplates.js`

Append four staff SMS copy functions. Each returns a plain string (the SMS body). Copy is verbatim from spec sections 3.15, 3.17, 3.18, 3.19. No em dashes.

**Files:**
- Modify or create: `server/utils/smsTemplates.js`
- Test: `server/utils/staffShiftHandlers.test.js` (created in Task 4; copy is exercised there)

- [ ] **Step 1: Inspect whether `smsTemplates.js` exists**

Run: `node -e "console.log(require('fs').existsSync('server/utils/smsTemplates.js'))"`
Expected: `true` if Phase 3 has merged, `false` otherwise. Both cases are handled below.

- [ ] **Step 2: Add the four staff copy functions**

If the file exists, append the four functions below before its `module.exports` line and add the four names to the existing `module.exports` object.

If the file does NOT exist, create `server/utils/smsTemplates.js` with exactly this content (Phase 3 will append its own client functions to the same file later; the structure matches `emailTemplates.js` — one exported function per touch):

```javascript
/**
 * SMS copy functions. One exported function per SMS touch; each returns a
 * plain string (the SMS body). Mirrors emailTemplates.js. No em dashes in any
 * body string (project copy rule). Render [bracketed placeholders] from the
 * caller-supplied context.
 *
 * Phase 3 owns the client-facing copy functions in this file; Phase 4a owns
 * the staff-facing copy functions below.
 */

/**
 * Staff day-before shift reminder (spec 3.15). Branded prefix style so staff
 * recognize the automation. Includes CONFIRM / CANT response codes.
 *
 * @param {Object} ctx
 * @param {string} ctx.eventTypeLabel - e.g. "Birthday Party"
 * @param {string} ctx.clientName - host/client name
 * @param {string} ctx.startTimeLocal - e.g. "6:00 PM CDT"
 * @param {string} ctx.location - venue location string
 * @param {string} ctx.setupArrivalTime - clock time crew should arrive, e.g. "5:00 PM"
 * @param {string} ctx.link - drink plan / shopping list URL
 * @returns {string}
 */
function staffShiftReminderSms(ctx) {
  return `Shift Reminder from Dr. Bartender: working ${ctx.eventTypeLabel} at ${ctx.clientName} tomorrow at ${ctx.startTimeLocal}, ${ctx.location}. Setup: ${ctx.setupArrivalTime}. Drink plan and shopping list: ${ctx.link}. Reply CONFIRM to acknowledge or CANT if you have a conflict.`;
}

/**
 * Staff post-event thank-you (spec 3.19).
 *
 * @param {Object} ctx
 * @param {string} ctx.eventTypeLabel - e.g. "Birthday Party"
 * @returns {string}
 */
function staffThankYouSms(ctx) {
  return `Thanks from Dr. Bartender for working ${ctx.eventTypeLabel} tonight. Let me know if anything came up. Cheers`;
}

/**
 * Staff schedule-change notice (spec 3.17). Admin-toggled.
 *
 * @param {Object} ctx
 * @param {string} ctx.eventTypeLabel - e.g. "Birthday Party"
 * @param {string} ctx.eventDateLocal - e.g. "Saturday, August 15"
 * @param {string} ctx.newDetails - one-line summary of the new date/time/location
 * @returns {string}
 */
function staffScheduleChangeSms(ctx) {
  return `Update from Dr. Bartender: ${ctx.eventTypeLabel} on ${ctx.eventDateLocal} has been changed. New: ${ctx.newDetails}. Reply CONFIRM to stay on the shift or call if there is a conflict.`;
}

/**
 * Staff cancellation / unassignment notice (spec 3.18). Admin-toggled.
 * `kind` selects the sentence: 'cancelled' for a cancelled event,
 * 'unassigned' for a staffer removed from a still-running event. Each branch
 * is a complete, grammatical standalone sentence — the verb is NOT shared
 * across the two, because "has [cancelled / your shift is no longer needed]"
 * is ungrammatical for the unassigned case.
 *
 * @param {Object} ctx
 * @param {string} ctx.eventTypeLabel - e.g. "Birthday Party"
 * @param {string} ctx.eventDateLocal - e.g. "Saturday, August 15"
 * @param {'cancelled'|'unassigned'} ctx.kind
 * @returns {string}
 */
function staffCancellationSms(ctx) {
  const sentence = ctx.kind === 'unassigned'
    ? `your shift for the ${ctx.eventTypeLabel} on ${ctx.eventDateLocal} is no longer needed`
    : `the ${ctx.eventTypeLabel} on ${ctx.eventDateLocal} has been cancelled`;
  return `Update from Dr. Bartender: ${sentence}. Sorry for the disruption. Reach out with questions.`;
}

module.exports = {
  staffShiftReminderSms,
  staffThankYouSms,
  staffScheduleChangeSms,
  staffCancellationSms,
};
```

- [ ] **Step 3: Verify the module loads and exports the four functions**

Run: `node -e "const t=require('./server/utils/smsTemplates'); console.log(typeof t.staffShiftReminderSms, typeof t.staffThankYouSms, typeof t.staffScheduleChangeSms, typeof t.staffCancellationSms)"`
Expected: `function function function function`

- [ ] **Step 4: Verify no em dashes in the staff copy**

Run: `node -e "const s=require('fs').readFileSync('server/utils/smsTemplates.js','utf8'); console.log(s.includes(String.fromCharCode(8212)) ? 'EM DASH FOUND' : 'clean')"`
Expected: `clean`

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsTemplates.js
git commit -m "feat(comms): staff SMS copy functions"
```

---

## Task 2: Bespoke timing helpers in `staffShiftHandlers.js`

The day-before reminder fires at the event start instant minus 24 hours, in event TZ. The post-event thank-you fires at the event end instant plus 30 minutes. Neither uses the 10:00-local convention of `computeScheduledFor` (verified: `preEventScheduling.computeScheduledFor` forces `SEND_HOUR_LOCAL = 10`). Both need bespoke timing.

`shifts` has no timezone of its own. The event TZ, `event_date`, `event_start_time`, and `event_duration_hours` come from the linked `proposals` row via `shifts.proposal_id`. `event_start_time` is wall-clock event-local text (`"18:00"` or `"6:00 PM"`); it must NOT be parsed as UTC.

**Files:**
- Create: `server/utils/staffShiftHandlers.js`
- Test: `server/utils/staffShiftHandlers.test.js` (created in Task 4)

- [ ] **Step 1: Create `staffShiftHandlers.js` with the timing helpers**

Create `server/utils/staffShiftHandlers.js` with exactly this content:

```javascript
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { resolveEventTimezone } = require('./eventTimezone');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

// ─── Timing helpers ──────────────────────────────────────────────
// shift_reminder fires at event start minus 24h; staff_thank_you fires at
// event end plus 30 min. Both compute in the EVENT timezone. event_start_time
// is wall-clock event-local text, never a UTC ISO string.

const DAY_MS = 24 * 60 * 60 * 1000;
const THANK_YOU_OFFSET_MS = 30 * 60 * 1000;

/**
 * Normalize a bare-DATE value (a pg `Date` at local midnight, or a string) to
 * a 'YYYY-MM-DD' calendar string. Mirrors toCalendarYmd in preEventScheduling.js.
 *
 * @param {string|Date|null|undefined} value
 * @returns {string|null}
 */
function toCalendarYmd(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

/**
 * Parse a wall-clock time string ("18:00" or "6:00 PM") into { hour, minute }
 * in 24-hour terms. Returns null when unparseable.
 *
 * @param {string} raw
 * @returns {{hour: number, minute: number}|null}
 */
function parseClockTime(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // 24-hour HH:MM
  let m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { hour: h, minute: min };
    return null;
  }
  // 12-hour H:MM AM/PM
  m = /^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const pm = /p/i.test(m[3]);
    if (h < 1 || h > 12 || min < 0 || min > 59) return null;
    if (h === 12) h = 0;
    if (pm) h += 12;
    return { hour: h, minute: min };
  }
  return null;
}

/**
 * Resolve the UTC instant of a wall-clock time on a calendar date in a TZ.
 *
 * Reads the actual TZ offset Intl reports for noon UTC on that calendar date,
 * so DST is handled by asking about the specific date (same technique as
 * preEventScheduling.computeScheduledFor).
 *
 * @param {string} ymd - 'YYYY-MM-DD'
 * @param {number} hour - 0-23 event-local
 * @param {number} minute - 0-59 event-local
 * @param {string} tz - IANA zone
 * @returns {Date} UTC instant
 */
function eventLocalToUtc(ymd, hour, minute, tz) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const noonUtc = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    timeZoneName: 'shortOffset',
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(noonUtc);
  const offsetPart = parts.find((p) => p.type === 'timeZoneName').value; // "GMT-5"
  const match = /GMT([+-]?\d{1,2})(?::(\d{2}))?/.exec(offsetPart);
  const tzHours = match ? Number(match[1]) : 0;
  const tzMinutes = match && match[2] ? Number(match[2]) * (tzHours >= 0 ? 1 : -1) : 0;
  // event-local HH:MM -> UTC: subtract the zone offset.
  return new Date(Date.UTC(y, mo - 1, d, hour - tzHours, minute - tzMinutes, 0));
}

/**
 * Compute the event start instant (UTC) for a proposal-shaped object that
 * carries event_date, event_start_time, event_timezone. Returns null when the
 * date or time is missing/unparseable.
 *
 * @param {{event_date: string|Date, event_start_time: string, event_timezone?: string}} ev
 * @returns {Date|null}
 */
function computeEventStartUtc(ev) {
  const ymd = toCalendarYmd(ev.event_date);
  if (!ymd) return null;
  const clock = parseClockTime(ev.event_start_time);
  if (!clock) return null;
  const tz = resolveEventTimezone(ev);
  return eventLocalToUtc(ymd, clock.hour, clock.minute, tz);
}

/**
 * shift_reminder send instant: event start minus 24h.
 * @returns {Date|null}
 */
function computeShiftReminderScheduledFor(ev) {
  const start = computeEventStartUtc(ev);
  if (!start) return null;
  return new Date(start.getTime() - DAY_MS);
}

/**
 * staff_thank_you send instant: event end plus 30 min, where
 * event end = event start + event_duration_hours.
 * @returns {Date|null}
 */
function computeStaffThankYouScheduledFor(ev) {
  const start = computeEventStartUtc(ev);
  if (!start) return null;
  const durationHours = Number(ev.event_duration_hours);
  if (!Number.isFinite(durationHours) || durationHours <= 0) return null;
  const end = start.getTime() + durationHours * 60 * 60 * 1000;
  return new Date(end + THANK_YOU_OFFSET_MS);
}

module.exports = {
  toCalendarYmd,
  parseClockTime,
  eventLocalToUtc,
  computeEventStartUtc,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
};
```

- [ ] **Step 2: Verify the module loads**

Run: `node -e "const h=require('./server/utils/staffShiftHandlers'); console.log(h.computeShiftReminderScheduledFor({event_date:'2026-08-15',event_start_time:'18:00',event_timezone:'America/Chicago'}).toISOString())"`
Expected: `2026-08-14T23:00:00.000Z`
(Reasoning: 2026-08-15 18:00 Chicago CDT = 23:00 UTC; minus 24h = 2026-08-14 23:00 UTC.)

- [ ] **Step 3: Verify the thank-you offset**

Run: `node -e "const h=require('./server/utils/staffShiftHandlers'); console.log(h.computeStaffThankYouScheduledFor({event_date:'2026-08-15',event_start_time:'18:00',event_duration_hours:4,event_timezone:'America/Chicago'}).toISOString())"`
Expected: `2026-08-16T03:30:00.000Z`
(Reasoning: start 2026-08-15 23:00 UTC + 4h = 2026-08-16 03:00 UTC + 30min = 03:30 UTC.)

- [ ] **Step 4: Commit**

```bash
git add server/utils/staffShiftHandlers.js
git commit -m "feat(comms): staff-shift SMS timing helpers"
```

---

## Task 3: Shared assignment-scheduling helper `scheduleStaffShiftMessages`

One helper, called from all four assignment paths, that inserts the `shift_reminder` and `staff_thank_you` `scheduled_messages` rows for a shift's currently-approved staff. Idempotent on the natural key. The reminder/thank-you rows use `entity_type='shift'`, `entity_id = shiftId`, `recipient_type='staff'`, `recipient_id = users.id`, `channel='sms'`.

`scheduled_messages` already accepts `entity_type='shift'` and `recipient_type='staff'` (verified: `messageScheduling.js` `VALID_ENTITY_TYPES` / `VALID_RECIPIENT_TYPES`). `scheduleMessage` uses the module-level `pool` and cannot join a caller's transaction; the shared helper therefore follows the structural shape of `preEventScheduling.insertIfMissing` — a SELECT-then-INSERT idempotency helper that INSERTs directly on a passed `executor` (pool or pg client) so it can run inside `autoAssign.js`'s flow or a route transaction without escaping it. It diverges from `insertIfMissing` in ONE deliberate way: the existence check is **status-agnostic** (any existing row for the natural key blocks the insert, including a terminal `failed`/`suppressed` row), whereas `insertIfMissing` skips only on `pending`/`sent`/`deferred`. The reason is in Step 1's docstring: a staff message that hard-failed on Twilio or was suppressed must not be silently resurrected as a fresh `pending` row on the next assignment or schedule-change.

**Files:**
- Modify: `server/utils/staffShiftHandlers.js`
- Test: `server/utils/staffShiftHandlers.test.js` (created in Task 4)

- [ ] **Step 1: Add the shared scheduler to `staffShiftHandlers.js`**

In `server/utils/staffShiftHandlers.js`, add these two functions before the `module.exports` block:

```javascript
// ─── Shared assignment scheduler ─────────────────────────────────

/**
 * Idempotent insert helper. SELECTs for ANY existing row on the natural key
 * (entity, message_type, recipient, channel) first, then INSERTs only when
 * none exists. The INSERT runs DIRECTLY on the passed `executor` (pg client
 * OR pool) so it joins the caller's open transaction when one is supplied.
 * ON CONFLICT mirrors scheduleMessage's partial-unique guard.
 *
 * The existence check intentionally has NO status filter — unlike
 * preEventScheduling.insertIfMissing, which only skips on
 * pending/sent/deferred. A staff message that hit a terminal `failed` (hard
 * Twilio failure) or `suppressed` state must NOT be recreated as a fresh
 * `pending` row on the next assignment or schedule-change: that would
 * endlessly resurrect terminal rows. So ANY row for the natural key — any
 * status, including failed and suppressed — counts as "already exists" and
 * the insert is skipped. (This is also why reanchorStaffShiftMessages in
 * Task 11 inserts directly via this helper: it adds a row only when NONE
 * exists at all, and this skip leaves a terminal row untouched.)
 *
 * @param {{query: Function}} executor
 * @param {{entityType: string, entityId: number, messageType: string,
 *          recipientType: string, recipientId: number, channel: string,
 *          scheduledFor: Date}} args
 */
async function insertShiftMessageIfMissing(executor, {
  entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor,
}) {
  const existing = await executor.query(
    `SELECT id FROM scheduled_messages
      WHERE entity_type = $1 AND entity_id = $2
        AND message_type = $3
        AND recipient_type = $4 AND recipient_id = $5
        AND channel = $6
      LIMIT 1`,
    [entityType, entityId, messageType, recipientType, recipientId, channel]
  );
  if (existing.rows.length > 0) return;
  await executor.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
       WHERE status = 'pending'
     DO NOTHING`,
    [entityId, entityType, messageType, recipientType, recipientId, channel, scheduledFor]
  );
}

/**
 * Schedule the day-before reminder and post-event thank-you SMS for every
 * currently-approved staffer on a shift. Called from all four staff-assignment
 * paths (manual assign, manual approve, auto-assign route, auto-assign
 * scheduler) so a reminder is always scheduled regardless of how a staffer
 * landed on the shift.
 *
 * Idempotent: re-running on an already-scheduled shift is a no-op (the natural
 * key SELECT skips existing rows). Safe to call after every assignment event.
 *
 * Best-effort by contract: the CALLER wraps this in try/catch + Sentry. This
 * function still guards its own body so a malformed shift can never throw past
 * the caller's hook, but the caller is the authoritative non-blocking boundary.
 *
 * Skips silently when:
 *   - the shift has no linked proposal (legacy hand-built shift), or
 *   - the linked proposal is archived, or
 *   - the event start/end instant cannot be computed (missing date/time).
 *
 * @param {number|string} shiftId
 * @param {{query: Function}} [executor] - pg client or pool; defaults to pool
 * @returns {Promise<{reminder: number, thankYou: number}>} count of rows inserted
 */
async function scheduleStaffShiftMessages(shiftId, executor) {
  const exec = executor || pool;
  let inserted = { reminder: 0, thankYou: 0 };
  try {
    // Pull the shift joined to its proposal for the event date/time/tz/status.
    const { rows } = await exec.query(
      `SELECT s.id AS shift_id, s.proposal_id,
              p.status AS proposal_status,
              p.event_date, p.event_start_time, p.event_duration_hours,
              p.event_timezone
         FROM shifts s
         LEFT JOIN proposals p ON p.id = s.proposal_id
        WHERE s.id = $1`,
      [shiftId]
    );
    const shift = rows[0];
    if (!shift || !shift.proposal_id) return inserted;
    if (shift.proposal_status === 'archived') return inserted;

    const reminderAt = computeShiftReminderScheduledFor(shift);
    const thankYouAt = computeStaffThankYouScheduledFor(shift);
    if (!reminderAt && !thankYouAt) return inserted;

    // Currently-approved staffers on this shift.
    const staffRes = await exec.query(
      `SELECT user_id FROM shift_requests
        WHERE shift_id = $1 AND status = 'approved'`,
      [shiftId]
    );

    for (const row of staffRes.rows) {
      if (reminderAt) {
        await insertShiftMessageIfMissing(exec, {
          entityType: 'shift',
          entityId: Number(shiftId),
          messageType: 'shift_reminder',
          recipientType: 'staff',
          recipientId: row.user_id,
          channel: 'sms',
          scheduledFor: reminderAt,
        });
        inserted.reminder += 1;
      }
      if (thankYouAt) {
        await insertShiftMessageIfMissing(exec, {
          entityType: 'shift',
          entityId: Number(shiftId),
          messageType: 'staff_thank_you',
          recipientType: 'staff',
          recipientId: row.user_id,
          channel: 'sms',
          scheduledFor: thankYouAt,
        });
        inserted.thankYou += 1;
      }
    }
  } catch (err) {
    // Defensive inner guard. The caller is the real non-blocking boundary, but
    // this keeps a malformed-shift error from ever surfacing through a hook.
    Sentry.captureException(err, {
      tags: { component: 'staffShiftHandlers', step: 'scheduleStaffShiftMessages' },
      extra: { shiftId },
    });
    console.error('[staffShiftHandlers] scheduleStaffShiftMessages failed (non-blocking):', err.message);
  }
  return inserted;
}
```

- [ ] **Step 2: Add the two functions to `module.exports`**

Replace the existing `module.exports` block in `server/utils/staffShiftHandlers.js` with:

```javascript
module.exports = {
  toCalendarYmd,
  parseClockTime,
  eventLocalToUtc,
  computeEventStartUtc,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  insertShiftMessageIfMissing,
  scheduleStaffShiftMessages,
};
```

- [ ] **Step 3: Verify the module still loads**

Run: `node -e "const h=require('./server/utils/staffShiftHandlers'); console.log(typeof h.scheduleStaffShiftMessages)"`
Expected: `function`

- [ ] **Step 4: Commit**

```bash
git add server/utils/staffShiftHandlers.js
git commit -m "feat(comms): shared staff-shift message scheduler"
```

---

## Task 4: Test the timing helpers and shared scheduler

Cover the timing math (DST, unparseable inputs) and `scheduleStaffShiftMessages` (idempotency, archived skip, no-proposal skip).

**Files:**
- Create: `server/utils/staffShiftHandlers.test.js`

- [ ] **Step 1: Write the failing test file**

Create `server/utils/staffShiftHandlers.test.js` with exactly this content:

```javascript
require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  parseClockTime,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  scheduleStaffShiftMessages,
} = require('./staffShiftHandlers');

// Negative fixture IDs so parallel test files don't collide. This file owns
// these IDs exclusively (see the preEventScheduling.test.js note on parallel
// `node --test` runs sharing one dev DB).
const TEST_CLIENT_ID = -7401;
const TEST_USER_ID_A = -7402;
const TEST_USER_ID_B = -7403;
const TEST_PROPOSAL_ID = -7404;
const TEST_SHIFT_ID = -7405;

async function cleanup() {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [TEST_USER_ID_A, TEST_USER_ID_B]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
}

before(async () => {
  await cleanup();
  await pool.query(
    "INSERT INTO clients (id, name, email) VALUES ($1, 'StaffSMS Client', 'staffsms-client@example.com')",
    [TEST_CLIENT_ID]
  );
  // Two staff users. `users` requires email + password_hash; role 'staff'
  // (the users_role_check constraint allows only 'staff'|'admin'|'manager').
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'staffsms-a@example.com', 'x', 'staff'),
            ($2, 'staffsms-b@example.com', 'x', 'staff')`,
    [TEST_USER_ID_A, TEST_USER_ID_B]
  );
});

beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
});

after(async () => {
  await cleanup();
  await pool.end();
});

// Insert a proposal + shift + an approved request for one staffer.
async function seedShift({ status = 'confirmed', startTime = '18:00', durationHours = 4, eventDateExpr = "CURRENT_DATE + INTERVAL '60 days'" } = {}) {
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_duration_hours, event_timezone, event_type)
     VALUES ($1, $2, $3, ${eventDateExpr}, $4, $5, 'America/Chicago', 'birthday-party')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID, status, startTime, durationHours]
  );
  await pool.query(
    `INSERT INTO shifts (id, proposal_id, event_date, start_time, positions_needed, status)
     VALUES ($1, $2, ${eventDateExpr}, $3, '["Bartender"]', 'open')`,
    [TEST_SHIFT_ID, TEST_PROPOSAL_ID, startTime]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );
}

test('parseClockTime > parses 24-hour and 12-hour formats, rejects junk', () => {
  assert.deepStrictEqual(parseClockTime('18:00'), { hour: 18, minute: 0 });
  assert.deepStrictEqual(parseClockTime('6:00 PM'), { hour: 18, minute: 0 });
  assert.deepStrictEqual(parseClockTime('12:30 AM'), { hour: 0, minute: 30 });
  assert.strictEqual(parseClockTime('not a time'), null);
  assert.strictEqual(parseClockTime(''), null);
});

test('computeShiftReminderScheduledFor > T-24h from event start in event TZ', () => {
  const at = computeShiftReminderScheduledFor({
    event_date: '2026-08-15', event_start_time: '18:00', event_timezone: 'America/Chicago',
  });
  // 2026-08-15 18:00 CDT = 23:00 UTC; minus 24h.
  assert.strictEqual(at.toISOString(), '2026-08-14T23:00:00.000Z');
});

test('computeStaffThankYouScheduledFor > event end + 30 min', () => {
  const at = computeStaffThankYouScheduledFor({
    event_date: '2026-08-15', event_start_time: '18:00', event_duration_hours: 4, event_timezone: 'America/Chicago',
  });
  // start 23:00 UTC + 4h + 30min.
  assert.strictEqual(at.toISOString(), '2026-08-16T03:30:00.000Z');
});

test('computeShiftReminderScheduledFor > returns null on unparseable time', () => {
  assert.strictEqual(
    computeShiftReminderScheduledFor({ event_date: '2026-08-15', event_start_time: 'TBD' }),
    null
  );
});

test('scheduleStaffShiftMessages > inserts one shift_reminder and one staff_thank_you for an approved staffer', async () => {
  await seedShift();
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    `SELECT message_type, recipient_type, channel, recipient_id
       FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1
      ORDER BY message_type`,
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].message_type, 'shift_reminder');
  assert.strictEqual(rows[1].message_type, 'staff_thank_you');
  for (const r of rows) {
    assert.strictEqual(r.recipient_type, 'staff');
    assert.strictEqual(r.channel, 'sms');
    assert.strictEqual(Number(r.recipient_id), TEST_USER_ID_A);
  }
});

test('scheduleStaffShiftMessages > is idempotent (second call inserts nothing)', async () => {
  await seedShift();
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(rows[0].count), 2);
});

test('scheduleStaffShiftMessages > does NOT recreate a terminal failed/suppressed row', async () => {
  // A staff message that already hit a terminal state must never get a fresh
  // pending row on a later assignment / schedule-change pass — the existence
  // check in insertShiftMessageIfMissing is status-agnostic.
  await seedShift();
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  // Drive the shift_reminder row to 'failed' and the staff_thank_you row to
  // 'suppressed' — both terminal.
  await pool.query(
    "UPDATE scheduled_messages SET status = 'failed' WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  await pool.query(
    "UPDATE scheduled_messages SET status = 'suppressed' WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'staff_thank_you'",
    [TEST_SHIFT_ID]
  );
  // Re-running must not add new pending rows on top of the terminal ones.
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    `SELECT message_type, status FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1
      ORDER BY message_type, status`,
    [TEST_SHIFT_ID]
  );
  // Still exactly two rows, still terminal — nothing was recreated.
  assert.strictEqual(rows.length, 2);
  const byType = Object.fromEntries(rows.map((r) => [r.message_type, r.status]));
  assert.strictEqual(byType.shift_reminder, 'failed');
  assert.strictEqual(byType.staff_thank_you, 'suppressed');
});

test('scheduleStaffShiftMessages > skips an archived proposal', async () => {
  await seedShift({ status: 'archived' });
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('scheduleStaffShiftMessages > schedules for a second staffer added later', async () => {
  await seedShift();
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  // A second staffer is approved after the first scheduling pass.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')`,
    [TEST_SHIFT_ID, TEST_USER_ID_B]
  );
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const { rows } = await pool.query(
    `SELECT recipient_id, count(*) AS n
       FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1
      GROUP BY recipient_id`,
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows.length, 2); // two distinct staffers
  for (const r of rows) assert.strictEqual(Number(r.n), 2); // 2 rows each
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `node --test server/utils/staffShiftHandlers.test.js`
Expected: all 9 tests pass (`# pass 9`, `# fail 0`).

If `users` has a `NOT NULL` column beyond `email` / `password_hash` / `role` that the seed misses, add it to the seed INSERT in the test's `before` block. The three columns named are the minimum verified set.

- [ ] **Step 3: Commit**

```bash
git add server/utils/staffShiftHandlers.test.js
git commit -m "test(comms): staff-shift timing and scheduler tests"
```

---

## Task 5: The `shift_reminder` and `staff_thank_you` dispatcher handlers

Add the two scheduled-SMS handlers and a `registerStaffShiftHandlers()` entry point. Each handler loads the shift + proposal + staff contact, renders via `smsTemplates`, and sends via `sendAndLogSms`. A scheduled SMS handler cannot reuse an email handler (the handler, not the row, picks the send mechanism — per the contract).

The dispatcher passes `{ entity, recipient, scheduledMessage }`. For these rows `entity` is the shift row (`lookupEntity` does `SELECT * FROM shifts`) and `recipient` is the `users` row (`lookupRecipient` for staff returns `id, email, role, communication_preferences` — no phone, because `users` has no phone column). Staff phone lives on `contractor_profiles.phone`; the handler joins it itself.

A handler that returns normally marks the row `sent`; throwing marks it `failed`. When a staffer has no phone on file, the handler throws so the row records the gap (matches `preEventHandlers` behavior for a missing email).

**Files:**
- Modify: `server/utils/staffShiftHandlers.js`
- Test: `server/utils/staffShiftHandlers.test.js`

- [ ] **Step 1: Add the handlers and registration to `staffShiftHandlers.js`**

In `server/utils/staffShiftHandlers.js`, update the top `require` block to add the dependencies the handlers need. Replace:

```javascript
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { resolveEventTimezone } = require('./eventTimezone');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');
```

with:

```javascript
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { resolveEventTimezone, formatEventLocalTime } = require('./eventTimezone');
const { getEventTypeLabel } = require('./eventTypes');
const { subtractMinutesFromTime } = require('./setupTime');
const { PUBLIC_SITE_URL } = require('./urls');
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
```

- [ ] **Step 2: Add the handler context loader and handlers**

In `server/utils/staffShiftHandlers.js`, add these functions before the `module.exports` block:

```javascript
// ─── Dispatcher handlers ─────────────────────────────────────────

/**
 * Load everything a staff shift-SMS handler needs: the shift, its linked
 * proposal (for event date/time/tz/type), and the recipient staffer's name +
 * phone from contractor_profiles. `users` has no phone column, so staff phone
 * is joined from contractor_profiles here.
 *
 * @param {number} shiftId
 * @param {number} staffUserId
 * @returns {Promise<object|null>}
 */
async function loadStaffShiftContext(shiftId, staffUserId) {
  const { rows } = await pool.query(
    `SELECT s.id AS shift_id, s.proposal_id, s.location AS shift_location,
            s.start_time AS shift_start_time, s.setup_minutes_before,
            p.status AS proposal_status, p.token AS proposal_token,
            p.event_date, p.event_start_time, p.event_duration_hours,
            p.event_timezone, p.event_location,
            p.event_type, p.event_type_custom,
            COALESCE(c.name, s.client_name) AS client_name,
            cp.preferred_name AS staff_name, cp.phone AS staff_phone
       FROM shifts s
       LEFT JOIN proposals p ON p.id = s.proposal_id
       LEFT JOIN clients c ON c.id = p.client_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = $2
      WHERE s.id = $1`,
    [shiftId, staffUserId]
  );
  return rows[0] || null;
}

/**
 * Format the event start time as "6:00 PM CDT" for a shift's linked proposal.
 * event_start_time is wall-clock event-local text, never parsed as UTC.
 */
function formatStartTimeShort(ctx) {
  const raw = ctx.event_start_time || ctx.shift_start_time;
  const clock = parseClockTime(raw);
  if (!clock) return 'TBD';
  const hour12 = clock.hour % 12 === 0 ? 12 : clock.hour % 12;
  const ampm = clock.hour >= 12 ? 'PM' : 'AM';
  const time12 = `${hour12}:${String(clock.minute).padStart(2, '0')} ${ampm}`;
  let tzAbbrev = '';
  try {
    const ymd = toCalendarYmd(ctx.event_date);
    if (ymd) {
      const refMs = Date.parse(`${ymd}T12:00:00Z`);
      if (Number.isFinite(refMs)) {
        const tz = resolveEventTimezone(ctx);
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: tz, timeZoneName: 'short',
        }).formatToParts(new Date(refMs));
        const tzPart = parts.find((p) => p.type === 'timeZoneName');
        if (tzPart && tzPart.value) tzAbbrev = ` ${tzPart.value}`;
      }
    }
  } catch (_e) { /* leave empty */ }
  return `${time12}${tzAbbrev}`;
}

/** Format event_date as "Saturday, August 15" in the event TZ. */
function formatEventDateLong(ctx) {
  const ymd = toCalendarYmd(ctx.event_date);
  if (!ymd) return 'your event';
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return 'your event';
  const tz = resolveEventTimezone(ctx);
  return formatEventLocalTime(d, tz, { weekday: 'long', month: 'long', day: 'numeric' });
}

/**
 * Handler: shift_reminder (day-before staff SMS, spec 3.15).
 * The dispatcher passes entity = the shift row, recipient = the staff users row.
 *
 * The proposal-archived check below is defense-in-depth: Task 10 Change B
 * suppresses an archived-proposal shift row in checkSuppression BEFORE this
 * handler runs, so this throw is normally unreachable. It stays as a safety
 * net in case a row is dispatched outside the suppression path.
 */
async function handleShiftReminder({ entity, recipient }) {
  const ctx = await loadStaffShiftContext(entity.id, recipient.id);
  if (!ctx) throw new Error(`shift_reminder: shift ${entity.id} not found`);
  if (!ctx.proposal_id) throw new Error(`shift_reminder: shift ${entity.id} has no linked proposal`);
  if (ctx.proposal_status === 'archived') {
    throw new Error(`shift_reminder: proposal archived for shift ${entity.id} — should have been suppressed`);
  }
  if (!ctx.staff_phone) {
    throw new Error(`shift_reminder: staff ${recipient.id} has no phone on contractor_profiles`);
  }

  // Setup arrival clock time: event start minus the effective setup minutes
  // (shift override, else 60). subtractMinutesFromTime accepts the wall-clock
  // string and returns a clock string; null start time -> 'TBD'.
  const setupArrival = subtractMinutesFromTime(
    ctx.event_start_time || ctx.shift_start_time,
    ctx.setup_minutes_before ?? 60
  ) || 'TBD';

  const link = ctx.proposal_token
    ? `${PUBLIC_SITE_URL}/shopping-list/${ctx.proposal_token}`
    : `${PUBLIC_SITE_URL}`;

  const body = smsTemplates.staffShiftReminderSms({
    eventTypeLabel: getEventTypeLabel({ event_type: ctx.event_type, event_type_custom: ctx.event_type_custom }),
    clientName: ctx.client_name || 'the host',
    startTimeLocal: formatStartTimeShort(ctx),
    location: ctx.event_location || ctx.shift_location || 'TBD',
    setupArrivalTime: setupArrival,
    link,
  });

  await sendAndLogSms({
    to: ctx.staff_phone,
    body,
    clientId: null,
    messageType: 'shift_reminder',
    recipientName: ctx.staff_name || null,
  });
}

/**
 * Handler: staff_thank_you (post-event staff SMS, spec 3.19).
 *
 * As with handleShiftReminder, the proposal-archived check is defense-in-depth:
 * Task 10 Change B suppresses archived-proposal shift rows before dispatch.
 */
async function handleStaffThankYou({ entity, recipient }) {
  const ctx = await loadStaffShiftContext(entity.id, recipient.id);
  if (!ctx) throw new Error(`staff_thank_you: shift ${entity.id} not found`);
  if (!ctx.proposal_id) throw new Error(`staff_thank_you: shift ${entity.id} has no linked proposal`);
  if (ctx.proposal_status === 'archived') {
    throw new Error(`staff_thank_you: proposal archived for shift ${entity.id} — should have been suppressed`);
  }
  if (!ctx.staff_phone) {
    throw new Error(`staff_thank_you: staff ${recipient.id} has no phone on contractor_profiles`);
  }

  const body = smsTemplates.staffThankYouSms({
    eventTypeLabel: getEventTypeLabel({ event_type: ctx.event_type, event_type_custom: ctx.event_type_custom }),
  });

  await sendAndLogSms({
    to: ctx.staff_phone,
    body,
    clientId: null,
    messageType: 'staff_thank_you',
    recipientName: ctx.staff_name || null,
  });
}

/**
 * Idempotent registration entry point. Call once from server bootstrap,
 * beside preEventHandlers.registerAll() and registerMarketingHandlers().
 *
 * Both touches are SMS, recipient_type 'staff', entity_type 'shift'. They use
 * BESPOKE timing (shift_reminder = T-24h from event start, staff_thank_you =
 * event end + 30 min), NOT a fixed offset from event_date, so they register
 * with offsetFromEventDate: null. That makes the reschedule cascade's generic
 * offset-based reanchor skip them; Task 11 handles their reschedule re-anchor
 * explicitly.
 *
 * The `priority` option (shift_reminder = 1, staff_thank_you = 3) is per the
 * cross-plan priority ladder. registerHandler ignores unknown option keys
 * today; the value is inert until Phase 4b activates the overlap rule.
 */
function registerStaffShiftHandlers() {
  registerHandler('shift_reminder', handleShiftReminder, {
    offsetFromEventDate: null,
    anchor: 'event_date',
    category: 'operational',
    priority: 1,
  });
  registerHandler('staff_thank_you', handleStaffThankYou, {
    offsetFromEventDate: null,
    anchor: 'event_date',
    category: 'operational',
    priority: 3,
  });
}
```

- [ ] **Step 3: Update `module.exports`**

Replace the `module.exports` block in `server/utils/staffShiftHandlers.js` with:

```javascript
module.exports = {
  toCalendarYmd,
  parseClockTime,
  eventLocalToUtc,
  computeEventStartUtc,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  insertShiftMessageIfMissing,
  scheduleStaffShiftMessages,
  loadStaffShiftContext,
  handleShiftReminder,
  handleStaffThankYou,
  registerStaffShiftHandlers,
};
```

- [ ] **Step 4: Verify the module loads and registration runs**

Run: `node -e "const h=require('./server/utils/staffShiftHandlers'); h.registerStaffShiftHandlers(); const {getHandlerMeta}=require('./server/utils/scheduledMessageDispatcher'); console.log(JSON.stringify(getHandlerMeta('shift_reminder')), JSON.stringify(getHandlerMeta('staff_thank_you')))"`
Expected: both print metadata objects with `"offsetFromEventDate":null`, `"anchor":"event_date"`, `"category":"operational"`. (`priority` is not echoed by `getHandlerMeta` — it is ignored by the current registry. That is expected and correct until Phase 4b.)

- [ ] **Step 5: Commit**

```bash
git add server/utils/staffShiftHandlers.js
git commit -m "feat(comms): shift_reminder and staff_thank_you SMS handlers"
```

---

## Task 6: Test the dispatcher handlers end-to-end

Drive `shift_reminder` and `staff_thank_you` through `dispatchPending` and confirm the rows mark `sent`. In dev the Twilio client is null, so `sendAndLogSms` resolves with a skipped sid and INSERTs the `sms_messages` row without a real send (this matches how other comms handler tests run against the dev DB).

**Files:**
- Modify: `server/utils/staffShiftHandlers.test.js`

- [ ] **Step 1: Append dispatcher-integration tests**

Append these tests to `server/utils/staffShiftHandlers.test.js` (after the existing tests, before they are run). First add the needed imports to the top of the file by replacing the existing import block:

```javascript
const {
  parseClockTime,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  scheduleStaffShiftMessages,
} = require('./staffShiftHandlers');
```

with:

```javascript
const {
  parseClockTime,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  scheduleStaffShiftMessages,
  registerStaffShiftHandlers,
} = require('./staffShiftHandlers');
const { dispatchPending } = require('./scheduledMessageDispatcher');
```

Then append these tests at the end of the file (before nothing — they are last):

```javascript
test('dispatcher > shift_reminder marks sent for a staffer with a phone', async () => {
  registerStaffShiftHandlers();
  await seedShift();
  // Give staffer A a contractor_profiles row with a phone.
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
     VALUES ($1, 'Sam', '5555550111')
     ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, preferred_name = EXCLUDED.preferred_name`,
    [TEST_USER_ID_A]
  );
  // A due shift_reminder row.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'shift', 'shift_reminder', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );

  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows[0].status, 'sent');

  // cleanup the contractor_profiles fixture row
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [TEST_USER_ID_A]);
});

test('dispatcher > shift_reminder marks failed when the staffer has no phone', async () => {
  registerStaffShiftHandlers();
  await seedShift();
  // No contractor_profiles row for staffer A -> no phone.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'shift', 'shift_reminder', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );

  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows[0].status, 'failed');
  assert.ok(rows[0].error_message.includes('no phone'));
});

test('dispatcher > staff_thank_you marks sent for a staffer with a phone', async () => {
  registerStaffShiftHandlers();
  await seedShift();
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
     VALUES ($1, 'Sam', '5555550111')
     ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, preferred_name = EXCLUDED.preferred_name`,
    [TEST_USER_ID_A]
  );
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'shift', 'staff_thank_you', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );

  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'staff_thank_you'",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(rows[0].status, 'sent');

  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [TEST_USER_ID_A]);
});
```

Note: `dispatchPending` drains ALL due `pending` rows in the dev DB, so these tests must not assert on row counts beyond their own `entity_id`. They scope every query to `TEST_SHIFT_ID`, which is correct. The `contractor_profiles` cleanup is inline because `seedShift` does not create that row.

- [ ] **Step 2: Run the full test file**

Run: `node --test server/utils/staffShiftHandlers.test.js`
Expected: all 12 tests pass (9 from Task 4 + 3 here). `# fail 0`.

If a test fails because `contractor_profiles` requires a `NOT NULL` column beyond `user_id` / `preferred_name` / `phone`, add it to the INSERT. Those three are the minimum verified set used elsewhere in the codebase.

- [ ] **Step 3: Commit**

```bash
git add server/utils/staffShiftHandlers.test.js
git commit -m "test(comms): staff-shift dispatcher handler tests"
```

---

## Task 7: Wire the shared scheduler into all four assignment paths

Call `scheduleStaffShiftMessages` from the manual-assign route, the approve route, and `autoAssignShift` (which serves both the auto-assign route and the scheduler). Each call is best-effort: its own `try`/`catch` + `Sentry`, never rethrown.

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/utils/autoAssign.js`
- Test: covered by `server/utils/staffShiftHandlers.test.js` (the helper) and exercised manually; the route wiring is verified by the dev-server smoke check in Step 6.

- [ ] **Step 1: Import the helper into `shifts.js`**

In `server/routes/shifts.js`, the import block ends at line 13 (`const { ADMIN_URL } = require('../utils/urls');`). Add this line immediately after it:

```javascript
const { scheduleStaffShiftMessages } = require('../utils/staffShiftHandlers');
```

- [ ] **Step 2: Wire the manual-assign route**

In `server/routes/shifts.js`, in `POST /:id/assign`, find the existing line near the end of the handler:

```javascript
  // If this assignment fills the shift, clear the proposal's last-minute hold.
  await clearHoldIfFullyStaffed(req.params.id);

  res.status(201).json(request);
```

Replace it with:

```javascript
  // If this assignment fills the shift, clear the proposal's last-minute hold.
  await clearHoldIfFullyStaffed(req.params.id);

  // Schedule the day-before reminder + post-event thank-you SMS for everyone
  // approved on this shift (idempotent). Best-effort: a scheduling failure
  // must never break the assignment response.
  try {
    await scheduleStaffShiftMessages(req.params.id);
  } catch (schedErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(schedErr, { tags: { route: 'shifts/assign', issue: 'staff-sms-schedule' } });
    }
    console.error('[shifts] staff SMS scheduling failed (non-blocking):', schedErr.message);
  }

  res.status(201).json(request);
```

- [ ] **Step 3: Add the `Sentry` import to `shifts.js`**

`shifts.js` does not currently import Sentry. Add to the top of the import block, immediately after line 1 (`const express = require('express');`):

```javascript
const Sentry = require('@sentry/node');
```

- [ ] **Step 4: Wire the approve route**

In `server/routes/shifts.js`, in `PUT /requests/:requestId`, find the existing block at the end of the `if (status === 'approved')` branch:

```javascript
    // Approving this request may have fully staffed the shift — clear the
    // linked proposal's last-minute hold if so. result.rows[0] is the updated
    // shift_request, so its shift_id is in hand (no extra lookup needed).
    await clearHoldIfFullyStaffed(result.rows[0].shift_id);
  }

  res.json(result.rows[0]);
```

Replace it with:

```javascript
    // Approving this request may have fully staffed the shift — clear the
    // linked proposal's last-minute hold if so. result.rows[0] is the updated
    // shift_request, so its shift_id is in hand (no extra lookup needed).
    await clearHoldIfFullyStaffed(result.rows[0].shift_id);

    // Schedule staff reminder + thank-you SMS (idempotent, best-effort).
    try {
      await scheduleStaffShiftMessages(result.rows[0].shift_id);
    } catch (schedErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(schedErr, { tags: { route: 'shifts/approve', issue: 'staff-sms-schedule' } });
      }
      console.error('[shifts] staff SMS scheduling failed (non-blocking):', schedErr.message);
    }
  }

  res.json(result.rows[0]);
```

- [ ] **Step 5: Wire `autoAssignShift` (covers the auto-assign route AND the scheduler)**

In `server/utils/autoAssign.js`, add the import at the top of the file. The current top imports are:

```javascript
const { pool } = require('../db');
const { sendSMS, normalizePhone } = require('./sms');
const { getEventTypeLabel } = require('./eventTypes');
```

Replace with:

```javascript
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendSMS, normalizePhone } = require('./sms');
const { getEventTypeLabel } = require('./eventTypes');
const { scheduleStaffShiftMessages } = require('./staffShiftHandlers');
```

Then in `autoAssignShift`, find the existing step 11 near the end:

```javascript
  // 11. Mark shift as auto-assigned
  await pool.query(
    `UPDATE shifts SET auto_assigned_at = NOW() WHERE id = $1`,
    [shiftId]
  );

  return {
    approved,
    scores: scored,
    slots_remaining: slotsRemaining,
  };
```

Replace it with:

```javascript
  // 11. Mark shift as auto-assigned
  await pool.query(
    `UPDATE shifts SET auto_assigned_at = NOW() WHERE id = $1`,
    [shiftId]
  );

  // 12. Schedule the day-before reminder + post-event thank-you SMS for every
  // approved staffer on this shift (idempotent). Best-effort: covers both the
  // POST /shifts/:id/auto-assign route and the hourly auto-assign scheduler.
  // A scheduling failure must never abort the auto-assign result.
  try {
    await scheduleStaffShiftMessages(shiftId);
  } catch (schedErr) {
    Sentry.captureException(schedErr, {
      tags: { component: 'autoAssign', issue: 'staff-sms-schedule' },
      extra: { shiftId },
    });
    console.error('[AutoAssign] staff SMS scheduling failed (non-blocking):', schedErr.message);
  }

  return {
    approved,
    scores: scored,
    slots_remaining: slotsRemaining,
  };
```

- [ ] **Step 6: Verify both modules still load and lint passes**

Run: `node -e "require('./server/routes/shifts'); require('./server/utils/autoAssign'); console.log('both load OK')"`
Expected: `both load OK`

Run: `npx eslint server/routes/shifts.js server/utils/autoAssign.js`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/routes/shifts.js server/utils/autoAssign.js
git commit -m "feat(comms): schedule staff shift SMS from all four assignment paths"
```

---

## Task 8: First-class cancel / unassign route + the immediate cancel SMS

Today there is no first-class shift-cancel or staff-unassign action. `DELETE /api/shifts/requests/:requestId` just deletes the `shift_requests` row silently (verified: `server/routes/shifts.js` ~line 311), and `DELETE /api/shifts/:id` just deletes the shift. The spec-3.18 cancellation/unassignment SMS needs a deliberate action that knows WHO was affected and HOW (event cancelled vs. one staffer removed).

This task builds `POST /api/shifts/:id/cancel-or-unassign` and the immediate `notifyStaffOfCancellation` hook. The route does the mutation in a transaction, then fires the SMS best-effort after commit. The toggle gate (`notify_assigned_staff` + sub-channels) is part of the request body; both sub-checkboxes default off.

`notifyStaffOfCancellation` also handles the EMAIL channel when the admin selected it, sending a plain admin-style email via `sendEmail`. The spec defines explicit SMS copy for 3.18; the email body is a plain breakdown (spec 3.18 says "Email and/or SMS depending on admin's checkbox selection" without separate email copy, so a concise system-style body is used).

**On the `sms_messages.message_type` log tags.** The immediate cancel/unassign sends pass `messageType: 'staff_cancellation_notice'` / `'staff_unassignment_notice'` to `sendAndLogSms`. These are free-text log tags on the outbound `sms_messages` row, not registered dispatcher message types — there is no handler and no `scheduled_messages` row, so they are intentionally OUTSIDE the contract's section-4 PINNED `message_type` naming (which pins only scheduled/registered touches). They are valid because Phase 3's rails task widens `sms_messages.message_type` from the old narrow `CHECK` to `TEXT`. Same applies to `'staff_schedule_change'` in Task 9.

**Files:**
- Modify: `server/utils/staffShiftHandlers.js` (add `notifyStaffOfCancellation`)
- Modify: `server/routes/shifts.js` (add the route)
- Test: `server/routes/shifts.cancelUnassign.test.js`

- [ ] **Step 1: Add `notifyStaffOfCancellation` to `staffShiftHandlers.js`**

In `server/utils/staffShiftHandlers.js`, add the `sendEmail` dependency. The require block currently ends with:

```javascript
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const smsTemplates = require('./smsTemplates');
```

Replace with:

```javascript
const { registerHandler } = require('./scheduledMessageDispatcher');
const { sendAndLogSms } = require('./sms');
const { sendEmail } = require('./email');
const smsTemplates = require('./smsTemplates');
```

Then add this function before the `module.exports` block:

```javascript
// ─── Immediate staff notification hooks ──────────────────────────
// These are immediate (non-scheduled) best-effort sends, gated by the admin's
// notify_assigned_staff toggle + per-channel sub-checkboxes. The CALLER decides
// whether to invoke them at all (toggle off -> never called) and wraps them in
// its own try/catch. Each hook still guards its own body so a malformed input
// can never surface through the request path.

/**
 * Notify a set of staffers that a shift was cancelled or a staffer was
 * unassigned (spec 3.18). Sends SMS and/or email per the channel flags.
 *
 * @param {Object} args
 * @param {number} args.shiftId
 * @param {number[]} args.staffUserIds - users.id of affected staffers
 * @param {'cancelled'|'unassigned'} args.kind
 * @param {boolean} args.sms - send the SMS channel
 * @param {boolean} args.email - send the email channel
 * @returns {Promise<{smsSent: number, emailSent: number}>}
 */
async function notifyStaffOfCancellation({ shiftId, staffUserIds, kind, sms, email }) {
  const result = { smsSent: 0, emailSent: 0 };
  if ((!sms && !email) || !Array.isArray(staffUserIds) || staffUserIds.length === 0) {
    return result;
  }
  try {
    for (const userId of staffUserIds) {
      const ctx = await loadStaffShiftContext(shiftId, userId);
      if (!ctx) continue;
      const eventTypeLabel = getEventTypeLabel({
        event_type: ctx.event_type, event_type_custom: ctx.event_type_custom,
      });
      const eventDateLocal = formatEventDateLong(ctx);

      if (sms && ctx.staff_phone) {
        try {
          await sendAndLogSms({
            to: ctx.staff_phone,
            body: smsTemplates.staffCancellationSms({ eventTypeLabel, eventDateLocal, kind }),
            clientId: null,
            messageType: kind === 'unassigned' ? 'staff_unassignment_notice' : 'staff_cancellation_notice',
            recipientName: ctx.staff_name || null,
          });
          result.smsSent += 1;
        } catch (smsErr) {
          Sentry.captureException(smsErr, {
            tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfCancellation', channel: 'sms' },
            extra: { shiftId, userId },
          });
          console.error('[staffShiftHandlers] cancellation SMS failed (non-blocking):', smsErr.message);
        }
      }

      if (email) {
        // Staff email lives on users.email; loadStaffShiftContext does not
        // select it, so fetch it here.
        const u = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
        const staffEmail = u.rows[0]?.email;
        if (staffEmail) {
          const verb = kind === 'unassigned'
            ? 'your shift is no longer needed'
            : 'has been cancelled';
          try {
            await sendEmail({
              to: staffEmail,
              subject: `Update from Dr. Bartender: ${eventTypeLabel} on ${eventDateLocal}`,
              html: `<p>Update from Dr. Bartender: the ${eventTypeLabel} on ${eventDateLocal}, ${verb}.</p>`
                + `<p>Sorry for the disruption. Reach out with any questions.</p>`,
              text: `Update from Dr. Bartender: the ${eventTypeLabel} on ${eventDateLocal}, ${verb}. `
                + `Sorry for the disruption. Reach out with any questions.`,
            });
            result.emailSent += 1;
          } catch (emailErr) {
            Sentry.captureException(emailErr, {
              tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfCancellation', channel: 'email' },
              extra: { shiftId, userId },
            });
            console.error('[staffShiftHandlers] cancellation email failed (non-blocking):', emailErr.message);
          }
        }
      }
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfCancellation' },
      extra: { shiftId },
    });
    console.error('[staffShiftHandlers] notifyStaffOfCancellation failed (non-blocking):', err.message);
  }
  return result;
}
```

- [ ] **Step 2: Add `notifyStaffOfCancellation` to `module.exports`**

Replace the `module.exports` block in `server/utils/staffShiftHandlers.js` with:

```javascript
module.exports = {
  toCalendarYmd,
  parseClockTime,
  eventLocalToUtc,
  computeEventStartUtc,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  insertShiftMessageIfMissing,
  scheduleStaffShiftMessages,
  loadStaffShiftContext,
  handleShiftReminder,
  handleStaffThankYou,
  registerStaffShiftHandlers,
  notifyStaffOfCancellation,
};
```

- [ ] **Step 3: Add the `POST /:id/cancel-or-unassign` route to `shifts.js`**

In `server/routes/shifts.js`, import `notifyStaffOfCancellation`. The import you added in Task 7 Step 1 is:

```javascript
const { scheduleStaffShiftMessages } = require('../utils/staffShiftHandlers');
```

Replace it with:

```javascript
const { scheduleStaffShiftMessages, notifyStaffOfCancellation } = require('../utils/staffShiftHandlers');
```

Then add this route immediately AFTER the existing `DELETE /:id` route (which ends with `}));` near line 478) and BEFORE the `POST /:id/assign` route:

```javascript
/**
 * POST /shifts/:id/cancel-or-unassign — first-class cancel / unassign action.
 *
 * Two modes, selected by `mode` in the body:
 *   - mode='cancel'   — cancel the whole shift. Sets shifts.status='cancelled'
 *                       and denies every non-denied shift_requests row. All
 *                       currently-approved staffers are the affected set.
 *   - mode='unassign' — remove ONE staffer. Requires `user_id`. Flips that
 *                       staffer's approved request to 'denied'. The affected
 *                       set is just that one staffer.
 *
 * On either mode, pending shift_reminder / staff_thank_you scheduled_messages
 * rows for the affected staffer(s) on this shift are suppressed so the
 * dispatcher never fires a reminder for a shift/staffer that no longer applies.
 *
 * Staff notification (spec 3.18) is admin-toggled and best-effort: when
 * `notify_assigned_staff` is true, fires SMS/email per `notify_sms` /
 * `notify_email` AFTER commit. Both sub-flags default false.
 */
router.post('/:id/cancel-or-unassign', auth, requireStaffing, asyncHandler(async (req, res) => {
  const { mode, user_id, notify_assigned_staff, notify_sms, notify_email } = req.body;
  if (mode !== 'cancel' && mode !== 'unassign') {
    throw new ValidationError({ mode: "mode must be 'cancel' or 'unassign'." });
  }
  const shiftId = parseInt(req.params.id, 10);
  if (Number.isNaN(shiftId)) throw new ValidationError({ id: 'Invalid shift id.' });

  let unassignUserId = null;
  if (mode === 'unassign') {
    unassignUserId = parseInt(user_id, 10);
    if (Number.isNaN(unassignUserId)) {
      throw new ValidationError({ user_id: 'user_id is required to unassign a staffer.' });
    }
  }

  const dbClient = await pool.connect();
  let affectedUserIds = [];
  const kind = mode === 'cancel' ? 'cancelled' : 'unassigned';
  try {
    await dbClient.query('BEGIN');

    const shiftRes = await dbClient.query('SELECT id FROM shifts WHERE id = $1', [shiftId]);
    if (!shiftRes.rows[0]) throw new NotFoundError('Shift not found.');

    if (mode === 'cancel') {
      // Affected = every currently-approved staffer.
      const approved = await dbClient.query(
        "SELECT user_id FROM shift_requests WHERE shift_id = $1 AND status = 'approved'",
        [shiftId]
      );
      affectedUserIds = approved.rows.map((r) => r.user_id);
      await dbClient.query("UPDATE shifts SET status = 'cancelled' WHERE id = $1", [shiftId]);
      await dbClient.query(
        "UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND status != 'denied'",
        [shiftId]
      );
      // Suppress pending staff reminder/thank-you rows for the whole shift.
      await dbClient.query(
        `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'shift cancelled'
          WHERE entity_type = 'shift' AND entity_id = $1
            AND message_type IN ('shift_reminder', 'staff_thank_you')
            AND status = 'pending'`,
        [shiftId]
      );
    } else {
      // unassign — flip the one staffer's approved request to denied.
      const upd = await dbClient.query(
        "UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND user_id = $2 AND status = 'approved' RETURNING id",
        [shiftId, unassignUserId]
      );
      if (!upd.rows[0]) {
        throw new NotFoundError('No approved assignment found for that staffer on this shift.');
      }
      affectedUserIds = [unassignUserId];
      // Suppress pending staff reminder/thank-you rows for THIS staffer only.
      await dbClient.query(
        `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'staff unassigned'
          WHERE entity_type = 'shift' AND entity_id = $1
            AND recipient_type = 'staff' AND recipient_id = $2
            AND message_type IN ('shift_reminder', 'staff_thank_you')
            AND status = 'pending'`,
        [shiftId, unassignUserId]
      );
    }

    await dbClient.query('COMMIT');
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (rbErr) { console.error('ROLLBACK failed:', rbErr); }
    throw err;
  } finally {
    dbClient.release();
  }

  // Staff notification — admin-toggled, best-effort, post-commit. Never 500s
  // the request: the mutation already committed.
  if (notify_assigned_staff === true && (notify_sms === true || notify_email === true)) {
    try {
      await notifyStaffOfCancellation({
        shiftId,
        staffUserIds: affectedUserIds,
        kind,
        sms: notify_sms === true,
        email: notify_email === true,
      });
    } catch (notifyErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(notifyErr, { tags: { route: 'shifts/cancel-or-unassign', issue: 'staff-notify' } });
      }
      console.error('[shifts] cancel/unassign staff notify failed (non-blocking):', notifyErr.message);
    }
  }

  res.json({ success: true, mode, affected_staff: affectedUserIds.length });
}));
```

- [ ] **Step 4: Verify the module loads and lint passes**

Run: `node -e "require('./server/routes/shifts'); require('./server/utils/staffShiftHandlers'); console.log('load OK')"`
Expected: `load OK`

Run: `npx eslint server/routes/shifts.js server/utils/staffShiftHandlers.js`
Expected: no errors.

- [ ] **Step 5: Write the route test**

Create `server/routes/shifts.cancelUnassign.test.js` with exactly this content:

```javascript
require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { notifyStaffOfCancellation } = require('../utils/staffShiftHandlers');

// This file tests the cancel/unassign data effects directly against the DB
// (the route's transaction logic) plus notifyStaffOfCancellation. It does not
// boot Express; it exercises the same SQL the route runs, then asserts state.
// Negative fixture IDs owned exclusively by this file.
const TEST_CLIENT_ID = -7501;
const TEST_USER_ID_A = -7502;
const TEST_USER_ID_B = -7503;
const TEST_PROPOSAL_ID = -7504;
const TEST_SHIFT_ID = -7505;

async function cleanup() {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id IN ($1, $2)', [TEST_USER_ID_A, TEST_USER_ID_B]);
  await pool.query('DELETE FROM users WHERE id IN ($1, $2)', [TEST_USER_ID_A, TEST_USER_ID_B]);
  await pool.query('DELETE FROM clients WHERE id = $1', [TEST_CLIENT_ID]);
}

before(async () => {
  await cleanup();
  await pool.query(
    "INSERT INTO clients (id, name, email) VALUES ($1, 'Cancel Test', 'cancel-test@example.com')",
    [TEST_CLIENT_ID]
  );
  await pool.query(
    `INSERT INTO users (id, email, password_hash, role)
     VALUES ($1, 'cancel-a@example.com', 'x', 'staff'),
            ($2, 'cancel-b@example.com', 'x', 'staff')`,
    [TEST_USER_ID_A, TEST_USER_ID_B]
  );
});

beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
  // proposal + shift + two approved staffers
  await pool.query(
    `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_duration_hours, event_timezone, event_type)
     VALUES ($1, $2, 'confirmed', CURRENT_DATE + INTERVAL '40 days', '18:00', 4, 'America/Chicago', 'birthday-party')`,
    [TEST_PROPOSAL_ID, TEST_CLIENT_ID]
  );
  await pool.query(
    `INSERT INTO shifts (id, proposal_id, event_date, start_time, positions_needed, status)
     VALUES ($1, $2, CURRENT_DATE + INTERVAL '40 days', '18:00', '["Bartender","Bartender"]', 'open')`,
    [TEST_SHIFT_ID, TEST_PROPOSAL_ID]
  );
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status)
     VALUES ($1, $2, 'approved'), ($1, $3, 'approved')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A, TEST_USER_ID_B]
  );
  // Pending reminder rows for both staffers.
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'shift', 'shift_reminder', 'staff', $2, 'sms', NOW() + INTERVAL '10 days'),
            ($1, 'shift', 'shift_reminder', 'staff', $3, 'sms', NOW() + INTERVAL '10 days')`,
    [TEST_SHIFT_ID, TEST_USER_ID_A, TEST_USER_ID_B]
  );
});

afterEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [TEST_PROPOSAL_ID]);
});

after(async () => {
  await cleanup();
  await pool.end();
});

// Mirror the route's cancel transaction.
async function runCancel() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("UPDATE shifts SET status = 'cancelled' WHERE id = $1", [TEST_SHIFT_ID]);
    await c.query("UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND status != 'denied'", [TEST_SHIFT_ID]);
    await c.query(
      `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'shift cancelled'
        WHERE entity_type = 'shift' AND entity_id = $1
          AND message_type IN ('shift_reminder', 'staff_thank_you') AND status = 'pending'`,
      [TEST_SHIFT_ID]
    );
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

// Mirror the route's unassign transaction for one staffer.
async function runUnassign(userId) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      "UPDATE shift_requests SET status = 'denied' WHERE shift_id = $1 AND user_id = $2 AND status = 'approved'",
      [TEST_SHIFT_ID, userId]
    );
    await c.query(
      `UPDATE scheduled_messages SET status = 'suppressed', error_message = 'staff unassigned'
        WHERE entity_type = 'shift' AND entity_id = $1
          AND recipient_type = 'staff' AND recipient_id = $2
          AND message_type IN ('shift_reminder', 'staff_thank_you') AND status = 'pending'`,
      [TEST_SHIFT_ID, userId]
    );
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

test('cancel > denies all requests and suppresses all pending reminder rows', async () => {
  await runCancel();
  const reqs = await pool.query(
    "SELECT count(*) FROM shift_requests WHERE shift_id = $1 AND status = 'denied'", [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(reqs.rows[0].count), 2);
  const shift = await pool.query('SELECT status FROM shifts WHERE id = $1', [TEST_SHIFT_ID]);
  assert.strictEqual(shift.rows[0].status, 'cancelled');
  const sm = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND status = 'suppressed'",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(sm.rows[0].count), 2);
});

test('unassign > denies only the one staffer and suppresses only their pending rows', async () => {
  await runUnassign(TEST_USER_ID_A);
  const denied = await pool.query(
    "SELECT user_id, status FROM shift_requests WHERE shift_id = $1 ORDER BY user_id", [TEST_SHIFT_ID]
  );
  const byUser = Object.fromEntries(denied.rows.map((r) => [Number(r.user_id), r.status]));
  assert.strictEqual(byUser[TEST_USER_ID_A], 'denied');
  assert.strictEqual(byUser[TEST_USER_ID_B], 'approved');
  // Only staffer A's reminder is suppressed.
  const aSuppressed = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND recipient_id = $2",
    [TEST_SHIFT_ID, TEST_USER_ID_A]
  );
  assert.strictEqual(aSuppressed.rows[0].status, 'suppressed');
  const bRow = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND recipient_id = $2",
    [TEST_SHIFT_ID, TEST_USER_ID_B]
  );
  assert.strictEqual(bRow.rows[0].status, 'pending');
});

test('notifyStaffOfCancellation > sends nothing when both channels are off', async () => {
  const r = await notifyStaffOfCancellation({
    shiftId: TEST_SHIFT_ID, staffUserIds: [TEST_USER_ID_A], kind: 'cancelled', sms: false, email: false,
  });
  assert.deepStrictEqual(r, { smsSent: 0, emailSent: 0 });
});

test('notifyStaffOfCancellation > sends SMS to a staffer with a phone', async () => {
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
     VALUES ($1, 'Alex', '5555550133')
     ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone`,
    [TEST_USER_ID_A]
  );
  const r = await notifyStaffOfCancellation({
    shiftId: TEST_SHIFT_ID, staffUserIds: [TEST_USER_ID_A], kind: 'unassigned', sms: true, email: false,
  });
  assert.strictEqual(r.smsSent, 1);
});
```

- [ ] **Step 6: Run the route test**

Run: `node --test server/routes/shifts.cancelUnassign.test.js`
Expected: all 4 tests pass. `# fail 0`.

`shifts.status` carries a `CHECK` constraint: `server/db/schema.sql` (the "CHECK Constraints on Status Columns" block) declares `shifts_status_check CHECK (status IN ('open', 'filled', 'completed', 'cancelled'))`. `'cancelled'` is already in the allowed set (verified against live `schema.sql`), so `mode='cancel'` setting `shifts.status='cancelled'` is accepted with no schema change. Likewise `shift_requests.status` is constrained to `('pending', 'approved', 'denied')`, and the cancel/unassign route only ever writes `'denied'` — also valid. No schema edit is needed for this task.

- [ ] **Step 7: Commit**

```bash
git add server/utils/staffShiftHandlers.js server/routes/shifts.js server/routes/shifts.cancelUnassign.test.js
git commit -m "feat(comms): first-class shift cancel/unassign route with staff notification"
```

---

## Task 9: Schedule-change staff SMS from the proposal reschedule block

When an admin reschedules an event via `PATCH /api/proposals/:id` and checks `notify_assigned_staff`, send the spec-3.17 schedule-change SMS/email to the proposal's assigned staffers. The reschedule logic already exists in crud.js: `rescheduleProposalInTx` runs in-transaction and the PATCH handler hoists `shouldSendRescheduleEmail` (verified: `server/routes/proposals/crud.js` ~line 426). The new hook fires AFTER commit, gated by both `shouldSendRescheduleEmail` (a real reschedule happened) AND the request body's `notify_assigned_staff` toggle.

`crud.js` is 971 lines against a 1000-line hard cap. To keep the crud.js delta near zero, the staff-notify logic lives in `staffShiftHandlers.js` as `notifyStaffOfScheduleChange(proposalId, { old, updated, sms, email })`; crud.js only adds a small gated call.

**Files:**
- Modify: `server/utils/staffShiftHandlers.js` (add `notifyStaffOfScheduleChange`)
- Modify: `server/routes/proposals/crud.js` (destructure toggles, add the gated call)
- Test: `server/utils/staffShiftHandlers.test.js`

- [ ] **Step 1: Add `notifyStaffOfScheduleChange` to `staffShiftHandlers.js`**

In `server/utils/staffShiftHandlers.js`, add this function before the `module.exports` block:

```javascript
/**
 * Notify a proposal's assigned staffers that the event was rescheduled
 * (spec 3.17). Sends SMS and/or email per the channel flags. Looks up every
 * approved staffer across every shift linked to the proposal.
 *
 * Best-effort: the caller (the proposals PATCH handler) wraps this in
 * try/catch + Sentry; this function also guards its own body.
 *
 * @param {Object} args
 * @param {number} args.proposalId
 * @param {object} args.updated - the post-PATCH proposal row (event_date, etc.)
 * @param {boolean} args.sms
 * @param {boolean} args.email
 * @returns {Promise<{smsSent: number, emailSent: number}>}
 */
async function notifyStaffOfScheduleChange({ proposalId, updated, sms, email }) {
  const result = { smsSent: 0, emailSent: 0 };
  if (!sms && !email) return result;
  try {
    // Every approved staffer across every shift on this proposal, with phone
    // + email. Distinct on user so a multi-shift event does not double-text.
    const { rows } = await pool.query(
      `SELECT DISTINCT sr.user_id, u.email AS staff_email,
              cp.preferred_name AS staff_name, cp.phone AS staff_phone,
              p.event_type, p.event_type_custom, p.event_date,
              p.event_start_time, p.event_timezone, p.event_location
         FROM shifts s
         JOIN shift_requests sr ON sr.shift_id = s.id AND sr.status = 'approved'
         JOIN users u ON u.id = sr.user_id
         LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
         LEFT JOIN proposals p ON p.id = s.proposal_id
        WHERE s.proposal_id = $1`,
      [proposalId]
    );
    if (rows.length === 0) return result;

    for (const row of rows) {
      const eventTypeLabel = getEventTypeLabel({
        event_type: row.event_type, event_type_custom: row.event_type_custom,
      });
      const eventDateLocal = formatEventDateLong(row);
      // One-line "new details" summary from the post-PATCH proposal row.
      const newDateLocal = formatEventDateLong({
        event_date: updated.event_date || row.event_date,
        event_timezone: row.event_timezone,
      });
      const newTime = updated.event_start_time || row.event_start_time || 'TBD';
      const newLocation = updated.event_location || row.event_location || 'same location';
      const newDetails = `${newDateLocal}, ${newTime}, ${newLocation}`;

      if (sms && row.staff_phone) {
        try {
          await sendAndLogSms({
            to: row.staff_phone,
            body: smsTemplates.staffScheduleChangeSms({ eventTypeLabel, eventDateLocal, newDetails }),
            clientId: null,
            messageType: 'staff_schedule_change',
            recipientName: row.staff_name || null,
          });
          result.smsSent += 1;
        } catch (smsErr) {
          Sentry.captureException(smsErr, {
            tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfScheduleChange', channel: 'sms' },
            extra: { proposalId, userId: row.user_id },
          });
          console.error('[staffShiftHandlers] schedule-change SMS failed (non-blocking):', smsErr.message);
        }
      }

      if (email && row.staff_email) {
        try {
          await sendEmail({
            to: row.staff_email,
            subject: `Update from Dr. Bartender: ${eventTypeLabel} on ${eventDateLocal}`,
            html: `<p>Update from Dr. Bartender: the ${eventTypeLabel} on ${eventDateLocal} has been changed.</p>`
              + `<p>New details: ${newDetails}.</p>`
              + `<p>Reply CONFIRM to stay on the shift, or call if there is a conflict.</p>`,
            text: `Update from Dr. Bartender: the ${eventTypeLabel} on ${eventDateLocal} has been changed. `
              + `New details: ${newDetails}. Reply CONFIRM to stay on the shift, or call if there is a conflict.`,
          });
          result.emailSent += 1;
        } catch (emailErr) {
          Sentry.captureException(emailErr, {
            tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfScheduleChange', channel: 'email' },
            extra: { proposalId, userId: row.user_id },
          });
          console.error('[staffShiftHandlers] schedule-change email failed (non-blocking):', emailErr.message);
        }
      }
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'staffShiftHandlers', step: 'notifyStaffOfScheduleChange' },
      extra: { proposalId },
    });
    console.error('[staffShiftHandlers] notifyStaffOfScheduleChange failed (non-blocking):', err.message);
  }
  return result;
}
```

- [ ] **Step 2: Destructure the toggle flags in the crud.js PATCH handler**

In `server/routes/proposals/crud.js`, the `PATCH /:id` handler destructures the request body at the top (lines 405-412). The current block is:

```javascript
  const {
    event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids,
    addon_variants, addon_quantities, syrup_selections, event_type, event_type_category, event_type_custom,
    venue_name, venue_street, venue_city, venue_state, venue_zip,
    adjustments, total_price_override, setup_minutes_before,
    class_options, client_provides_glassware
  } = req.body;
```

Replace it with:

```javascript
  const {
    event_date, event_start_time, event_duration_hours,
    event_location, guest_count, package_id, num_bars, num_bartenders, addon_ids,
    addon_variants, addon_quantities, syrup_selections, event_type, event_type_category, event_type_custom,
    venue_name, venue_street, venue_city, venue_state, venue_zip,
    adjustments, total_price_override, setup_minutes_before,
    class_options, client_provides_glassware,
    // Transient per-edit toggles (no schema column) — Phase 4a. When
    // notify_assigned_staff is true AND a real reschedule happened, the
    // proposal's assigned staffers get a schedule-change SMS/email.
    notify_assigned_staff, notify_staff_sms, notify_staff_email,
  } = req.body;
```

- [ ] **Step 3: Add the combined reschedule-staff-hooks helper to `staffShiftHandlers.js`**

`crud.js` is 971 lines against a 1000-line hard cap. Adding a multi-line gated block directly would risk breaching it (this task plus Task 11 together would add ~45 lines). Instead, ALL reschedule-driven staff logic goes into ONE helper, `runRescheduleStaffHooks`, so the crud.js delta is a single small call. Task 11 extends this same helper rather than adding a second crud.js block.

In `server/utils/staffShiftHandlers.js`, add this function before the `module.exports` block. (`notifyStaffOfScheduleChange` is defined in Step 1 above; `reanchorStaffShiftMessages` is added by Task 11 — until Task 11 lands, the `reanchorStaffShiftMessages` call here is a forward reference. Implement Task 11 immediately after this task so the reference resolves; the boot wiring and re-anchor in Task 11 are part of the same logical reschedule feature.):

```javascript
/**
 * Single post-commit entry point for the proposals PATCH reschedule path.
 * Keeps crud.js thin: the route makes one gated call instead of inlining two
 * multi-line hook blocks.
 *
 * Runs two things, both best-effort and each self-guarded:
 *   1. reanchorStaffShiftMessages — recompute pending staff SMS rows for the
 *      new event date. UNCONDITIONAL of the notify toggle: reminder timing
 *      must follow the event regardless of whether the admin notifies staff.
 *   2. notifyStaffOfScheduleChange — schedule-change SMS/email, only when the
 *      admin checked notify_assigned_staff and at least one channel.
 *
 * The CALLER gates on `shouldSendRescheduleEmail` (a real reschedule) before
 * calling this, and wraps it in its own try/catch; this function also guards
 * each step internally so one failing hook never blocks the other.
 *
 * @param {Object} args
 * @param {number} args.proposalId
 * @param {object} args.updated - the post-PATCH proposal row
 * @param {boolean} args.notifyStaff - admin's notify_assigned_staff toggle
 * @param {boolean} args.notifyStaffSms
 * @param {boolean} args.notifyStaffEmail
 * @returns {Promise<void>}
 */
async function runRescheduleStaffHooks({ proposalId, updated, notifyStaff, notifyStaffSms, notifyStaffEmail }) {
  // 1. Always re-anchor pending staff SMS rows to the new event timing.
  try {
    await reanchorStaffShiftMessages(proposalId);
  } catch (reanchorErr) {
    Sentry.captureException(reanchorErr, {
      tags: { component: 'staffShiftHandlers', step: 'runRescheduleStaffHooks.reanchor' },
      extra: { proposalId },
    });
    console.error('[staffShiftHandlers] reschedule re-anchor failed (non-blocking):', reanchorErr.message);
  }
  // 2. Notify staff of the change only when the admin opted in.
  if (notifyStaff === true && (notifyStaffSms === true || notifyStaffEmail === true)) {
    try {
      await notifyStaffOfScheduleChange({
        proposalId,
        updated,
        sms: notifyStaffSms === true,
        email: notifyStaffEmail === true,
      });
    } catch (notifyErr) {
      Sentry.captureException(notifyErr, {
        tags: { component: 'staffShiftHandlers', step: 'runRescheduleStaffHooks.notify' },
        extra: { proposalId },
      });
      console.error('[staffShiftHandlers] schedule-change notify failed (non-blocking):', notifyErr.message);
    }
  }
}
```

- [ ] **Step 4: Add `notifyStaffOfScheduleChange` and `runRescheduleStaffHooks` to `module.exports`**

Replace the `module.exports` block in `server/utils/staffShiftHandlers.js` with:

```javascript
module.exports = {
  toCalendarYmd,
  parseClockTime,
  eventLocalToUtc,
  computeEventStartUtc,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  insertShiftMessageIfMissing,
  scheduleStaffShiftMessages,
  loadStaffShiftContext,
  handleShiftReminder,
  handleStaffThankYou,
  registerStaffShiftHandlers,
  notifyStaffOfCancellation,
  notifyStaffOfScheduleChange,
  runRescheduleStaffHooks,
};
```

- [ ] **Step 5: Add the single gated call to the crud.js reschedule block**

In `server/routes/proposals/crud.js`, find the `new_year_hello` recompute block inside `PATCH /:id`. It ends with:

```javascript
    if (shouldSendRescheduleEmail) {
      try {
        const { recomputeNewYearHelloForProposal } = require('../../utils/marketingHandlers');
        await recomputeNewYearHelloForProposal(parseInt(req.params.id, 10));
      } catch (recomputeErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(recomputeErr, {
            tags: { route: 'proposals/update', issue: 'new-year-recompute' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('new_year_hello recompute failed (non-blocking):', recomputeErr);
      }
    }

    // Return updated proposal (from the UPDATE ... RETURNING * above)
    res.json(updatedRow.rows[0]);
```

Insert the new block between the `new_year_hello` block's closing `}` and the `// Return updated proposal` comment, so it becomes:

```javascript
    if (shouldSendRescheduleEmail) {
      try {
        const { recomputeNewYearHelloForProposal } = require('../../utils/marketingHandlers');
        await recomputeNewYearHelloForProposal(parseInt(req.params.id, 10));
      } catch (recomputeErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(recomputeErr, {
            tags: { route: 'proposals/update', issue: 'new-year-recompute' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('new_year_hello recompute failed (non-blocking):', recomputeErr);
      }
    }

    // Phase 4a: post-commit staff reschedule hooks. Gated on a real reschedule
    // having happened (shouldSendRescheduleEmail). The helper re-anchors
    // pending staff SMS rows AND, when notify_assigned_staff is set, sends the
    // schedule-change SMS/email. Best-effort: the helper self-guards each
    // step, and this catch is the outer non-blocking boundary so a notify
    // failure can never 500 a PATCH whose DB writes already committed.
    if (shouldSendRescheduleEmail) {
      try {
        const { runRescheduleStaffHooks } = require('../../utils/staffShiftHandlers');
        await runRescheduleStaffHooks({
          proposalId: parseInt(req.params.id, 10),
          updated: updatedRow.rows[0],
          notifyStaff: notify_assigned_staff === true,
          notifyStaffSms: notify_staff_sms === true,
          notifyStaffEmail: notify_staff_email === true,
        });
      } catch (staffHookErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(staffHookErr, {
            tags: { route: 'proposals/update', issue: 'staff-reschedule-hooks' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('Staff reschedule hooks failed (non-blocking):', staffHookErr);
      }
    }

    // Return updated proposal (from the UPDATE ... RETURNING * above)
    res.json(updatedRow.rows[0]);
```

- [ ] **Step 6: Verify crud.js still loads, lints, and stays under cap**

Run: `node -e "require('./server/routes/proposals/crud'); console.log('crud loads OK')"`
Expected: `crud loads OK`

Run: `npx eslint server/routes/proposals/crud.js server/utils/staffShiftHandlers.js`
Expected: no errors.

Run: `node scripts/check-file-size.js --all`
Expected: the report lists `server/routes/proposals/crud.js`. It grows by ~21 lines (the destructure +3, the single gated block ~18) to roughly 992 lines, under the 1000 hard cap. If the report shows crud.js RED (at or over 1000), the destructure block in Step 3 can be trimmed by pulling the three toggle fields with a single follow-up line `const { notify_assigned_staff, notify_staff_sms, notify_staff_email } = req.body;` placed just before the gated block instead of in the main destructure — but the primary path keeps it under cap.

- [ ] **Step 7: Test the reschedule staff hooks**

Append these tests to `server/utils/staffShiftHandlers.test.js` (at the end):

```javascript
test('notifyStaffOfScheduleChange > sends SMS to an assigned staffer with a phone', async () => {
  await seedShift();
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
     VALUES ($1, 'Sam', '5555550144')
     ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, preferred_name = EXCLUDED.preferred_name`,
    [TEST_USER_ID_A]
  );
  const { notifyStaffOfScheduleChange } = require('./staffShiftHandlers');
  const r = await notifyStaffOfScheduleChange({
    proposalId: TEST_PROPOSAL_ID,
    updated: { event_date: '2026-09-01', event_start_time: '19:00', event_location: 'New Venue' },
    sms: true,
    email: false,
  });
  assert.strictEqual(r.smsSent, 1);
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [TEST_USER_ID_A]);
});

test('notifyStaffOfScheduleChange > sends nothing when both channels are off', async () => {
  await seedShift();
  const { notifyStaffOfScheduleChange } = require('./staffShiftHandlers');
  const r = await notifyStaffOfScheduleChange({
    proposalId: TEST_PROPOSAL_ID,
    updated: { event_date: '2026-09-01' },
    sms: false,
    email: false,
  });
  assert.deepStrictEqual(r, { smsSent: 0, emailSent: 0 });
});
```

- [ ] **Step 8: Run the full staff-handlers test file**

Run: `node --test server/utils/staffShiftHandlers.test.js`
Expected: all 14 tests pass (12 prior + 2 here). `# fail 0`.

- [ ] **Step 9: Commit**

```bash
git add server/utils/staffShiftHandlers.js server/routes/proposals/crud.js server/utils/staffShiftHandlers.test.js
git commit -m "feat(comms): schedule-change staff SMS from proposal reschedule"
```

---

## Task 10: Staff/admin suppression + archived-shift suppression in the dispatcher

Two `checkSuppression` changes, both in `server/utils/scheduledMessageDispatcher.js`.

**Change A — staff/admin per-channel comm-prefs.** `checkSuppression` currently handles only `recipient_type === 'client'` comm-prefs (verified: `server/utils/scheduledMessageDispatcher.js` lines 100-120; staff/admin explicitly deferred to "later plans"). Phase 4a adds the staff/admin branch so a staffer who texted STOP (which flips `users.communication_preferences.sms_enabled`) does not get scheduled SMS, and the same for admins. `users.communication_preferences` exists (verified: `schema.sql` `ALTER TABLE users ADD COLUMN IF NOT EXISTS communication_preferences JSONB`). The `lookupRecipient` staff/admin branch already SELECTs `communication_preferences` (verified: dispatcher lines 164-169). `users` has no `email_status` / `phone_status` columns, so the staff/admin branch checks only the comm-prefs flags, not bad-contact status.

**Change B — archived-proposal cascade for staff `shift` rows.** The existing archived branch fires only for `row.entity_type === 'proposal'` (verified: `scheduledMessageDispatcher.js` line 97 — `if (row.entity_type === 'proposal' && entity && entity.status === 'archived')`). Phase 4a's `shift_reminder` / `staff_thank_you` rows use `entity_type='shift'`, so that branch never catches them: a staff reminder for a shift on an archived proposal would currently dispatch and the handler would *throw*, marking the row `failed`. Spec 3.15/3.19 list "proposal archived" as a suppression condition — the correct outcome is `suppressed`, not `failed`. For an `entity_type='shift'` row, `lookupEntity` returns `SELECT * FROM shifts` (verified: dispatcher line 141), which carries `shifts.proposal_id` (`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS proposal_id INTEGER REFERENCES proposals(id) ON DELETE SET NULL` — verified in `schema.sql`) but NOT the linked proposal's `status`. So this change joins the shift to its proposal via `shifts.proposal_id` and checks `proposals.status='archived'`. `checkSuppression` is already `async` and `pool` is already imported at the top of the file, so the extra query is in-bounds. This does not depend on the handlers' own archived guard — the suppression happens before the handler is ever invoked.

**Files:**
- Modify: `server/utils/scheduledMessageDispatcher.js`
- Test: `server/utils/scheduledMessageDispatcher.test.js`

- [ ] **Step 1: Extend the archived branch to cover staff `shift` rows (Change B)**

In `server/utils/scheduledMessageDispatcher.js`, the `checkSuppression` function currently begins like this:

```javascript
async function checkSuppression({ row, entity, recipient }) {
  // Archived-proposal cascade — universal rule per spec section 7.1.
  if (row.entity_type === 'proposal' && entity && entity.status === 'archived') {
    return 'archived: proposal is archived, cascade rule applies';
  }
```

Replace that opening with:

```javascript
async function checkSuppression({ row, entity, recipient }) {
  // Archived-proposal cascade — universal rule per spec section 7.1.
  if (row.entity_type === 'proposal' && entity && entity.status === 'archived') {
    return 'archived: proposal is archived, cascade rule applies';
  }
  // Same cascade for staff shift rows (Phase 4a): a shift_reminder /
  // staff_thank_you row carries entity_type='shift'. lookupEntity returns the
  // shifts row, which has proposal_id but not the linked proposal's status,
  // so join to proposals here. Archived linked proposal -> suppressed (not
  // failed). Runs before the handler, so it does not rely on the handler's
  // own archived guard.
  if (row.entity_type === 'shift' && entity && entity.proposal_id) {
    const pr = await pool.query(
      'SELECT status FROM proposals WHERE id = $1',
      [entity.proposal_id]
    );
    if (pr.rows[0] && pr.rows[0].status === 'archived') {
      return 'archived: linked proposal is archived, cascade rule applies';
    }
  }
```

- [ ] **Step 2: Add the staff/admin branch to `checkSuppression` (Change A)**

In `server/utils/scheduledMessageDispatcher.js`, the `checkSuppression` function currently ends like this:

```javascript
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
  return null;
}
```

Replace it with:

```javascript
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
  // Per-channel comm-prefs for staff and admin recipients (Phase 4a). Staff
  // SMS opt-out is set by the STOP keyword flipping
  // users.communication_preferences.sms_enabled. `users` has no
  // email_status / phone_status columns, so only the prefs flags are checked
  // here — there is no bad-contact branch for staff/admin.
  if ((row.recipient_type === 'staff' || row.recipient_type === 'admin') && recipient) {
    const prefs = recipient.communication_preferences || {};
    if (row.channel === 'sms' && prefs.sms_enabled === false) {
      return `suppressed: ${row.recipient_type}.communication_preferences.sms_enabled is false`;
    }
    if (row.channel === 'email' && prefs.email_enabled === false) {
      return `suppressed: ${row.recipient_type}.communication_preferences.email_enabled is false`;
    }
  }
  return null;
}
```

- [ ] **Step 3: Verify the module still loads**

Run: `node -e "require('./server/utils/scheduledMessageDispatcher'); console.log('dispatcher loads OK')"`
Expected: `dispatcher loads OK`

- [ ] **Step 4: Add the suppression tests**

Append these two tests to `server/utils/scheduledMessageDispatcher.test.js` (at the end of the file). They need a staff `users` row and (for the archived-shift test) a `shifts` row linked to an archived proposal.

The first test uses the file's existing `testProposalId` fixture as the `entity_id` of a `proposal`-entity row and creates its own dedicated staff `users` row. The second test creates dedicated negative-id `proposals` + `shifts` fixtures (it must NOT reuse `testProposalId`, since it needs an archived proposal) and uses the file's `testClientId`. Both clean up their own rows. Verify the fixture variable names `testClientId` / `testProposalId` against the top of `scheduledMessageDispatcher.test.js` before running. Add the tests:

```javascript
test('dispatcher > suppresses a staff SMS row when staff sms_enabled is false', async () => {
  registerHandler('disp_test_staff_sms', async () => { throw new Error('should not send'); });

  // A staff user that has opted out of SMS.
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, communication_preferences)
     VALUES ('disp-staff-optout@example.com', 'x', 'staff',
             '{"sms_enabled":false,"email_enabled":true,"marketing_enabled":true}'::jsonb)
     RETURNING id`
  );
  const staffUserId = u.rows[0].id;

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_staff_sms', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
    [testProposalId, staffUserId]
  );

  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_staff_sms'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.ok(rows[0].error_message.includes('sms_enabled is false'));

  await pool.query('DELETE FROM users WHERE id = $1', [staffUserId]);
});

test('dispatcher > suppresses a staff shift row when its linked proposal is archived', async () => {
  registerHandler('disp_test_shift_archived', async () => { throw new Error('should not send'); });

  // Dedicated negative-id fixtures owned by this test only.
  const ARCH_PROPOSAL_ID = -7601;
  const ARCH_SHIFT_ID = -7602;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role)
     VALUES ('disp-shift-arch-staff@example.com', 'x', 'staff')
     RETURNING id`
  );
  const staffUserId = u.rows[0].id;
  try {
    // An ARCHIVED proposal, and a shift linked to it.
    await pool.query(
      `INSERT INTO proposals (id, client_id, status, event_date, event_start_time, event_duration_hours, event_timezone, event_type)
       VALUES ($1, $2, 'archived', CURRENT_DATE + INTERVAL '30 days', '18:00', 4, 'America/Chicago', 'birthday-party')`,
      [ARCH_PROPOSAL_ID, testClientId]
    );
    await pool.query(
      `INSERT INTO shifts (id, proposal_id, event_date, start_time, positions_needed, status)
       VALUES ($1, $2, CURRENT_DATE + INTERVAL '30 days', '18:00', '["Bartender"]', 'open')`,
      [ARCH_SHIFT_ID, ARCH_PROPOSAL_ID]
    );
    // A due shift_reminder row on that shift.
    await pool.query(
      `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
       VALUES ($1, 'shift', 'disp_test_shift_archived', 'staff', $2, 'sms', NOW() - INTERVAL '1 minute')`,
      [ARCH_SHIFT_ID, staffUserId]
    );

    await dispatchPending();

    const { rows } = await pool.query(
      "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_shift_archived'"
    );
    // Archived linked proposal -> suppressed, NOT failed (the handler throws,
    // so a 'suppressed' status proves suppression fired before dispatch).
    assert.strictEqual(rows[0].status, 'suppressed');
    assert.ok(rows[0].error_message.includes('archived'));
  } finally {
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1", [ARCH_SHIFT_ID]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [ARCH_SHIFT_ID]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [ARCH_PROPOSAL_ID]);
    await pool.query('DELETE FROM users WHERE id = $1', [staffUserId]);
  }
});
```

Note: the dispatcher loads `entity` for the entity row and `recipient` for the recipient row, then calls `checkSuppression` BEFORE the handler. Both tests register a handler that throws if reached, so a `suppressed` status proves the suppression branch fired first. The archived-shift test exercises Change B's `shifts → proposals` join. The fixture variable `testClientId` is the file's existing client fixture; if `scheduledMessageDispatcher.test.js` names its client/proposal fixtures differently, adjust `testClientId` / `testProposalId` to match — verify against the top of that file.

- [ ] **Step 5: Run the dispatcher test file**

Run: `node --test server/utils/scheduledMessageDispatcher.test.js`
Expected: all existing tests plus the two new ones pass. `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(comms): staff/admin SMS suppression and archived-shift cascade in the dispatcher"
```

---

## Task 11: Register staff handlers at boot and re-anchor staff rows on reschedule

Two wiring tasks. First, `registerStaffShiftHandlers()` must run at server boot so the dispatcher can resolve `shift_reminder` / `staff_thank_you`. Second, the reschedule cascade must re-anchor pending staff rows: those handlers register with `offsetFromEventDate: null`, so the generic offset-based reanchor in `reanchorPendingMessages` skips them (verified: `rescheduleProposal.js` `computeReanchoredScheduledFor` returns null when `offsetFromEventDate === null`). Without an explicit re-anchor, a rescheduled event leaves the staff reminder pinned to the old date.

The fix: when a proposal is rescheduled, the net-new helper `reanchorStaffShiftMessages(proposalId)` does two things per linked shift — (1) **INSERT any missing staff-message rows** for currently-approved staff by re-running `scheduleStaffShiftMessages`, and (2) **UPDATE** the `scheduled_for` of rows that already existed. Step 1 is not cosmetic: it is the recovery path for the **assign-while-event-time-was-TBD** case. If a staffer is assigned to a shift while `event_start_time` is still unknown, `computeShiftReminderScheduledFor` returns null and `scheduleStaffShiftMessages` inserts NOTHING at assignment time — the day-before reminder and the post-event thank-you are never created. A re-anchor that only UPDATEd existing pending rows would never fire that reminder, because there is no row to update. Re-running `scheduleStaffShiftMessages` here (after the admin sets the start time, so the timing helpers now resolve) is what finally inserts the missing rows. `scheduleStaffShiftMessages` routes through the status-agnostic `insertShiftMessageIfMissing` (Task 3), so it inserts only genuinely-absent rows and leaves any terminal `failed`/`suppressed` row alone. crud.js calls `reanchorStaffShiftMessages` post-commit via `runRescheduleStaffHooks` (wired in Task 9).

**Files:**
- Modify: `server/index.js` (boot registration)
- Modify: `server/utils/staffShiftHandlers.js` (add `reanchorStaffShiftMessages`)
- Modify: `server/routes/proposals/crud.js` (call it post-commit)
- Test: `server/utils/staffShiftHandlers.test.js`

- [ ] **Step 1: Register the staff handlers at boot**

In `server/index.js`, find the existing handler-registration block inside `start()`:

```javascript
      // Pre-event reminder handlers (event_week_reminder, long_lead_t30_recap).
      // Must register before the dispatcher's first tick so it can resolve them.
      require('./utils/preEventHandlers').registerAll();

      // Plan 2d: register the marketing/retention dispatcher handlers (drip,
      // new_year_hello, six_months_out, retention_nudge, review_request).
      // Synchronous, like registerAll() above; must run before the dispatcher's
      // first tick so it can resolve these message types.
      require('./utils/marketingHandlers').registerMarketingHandlers();
```

Replace it with:

```javascript
      // Pre-event reminder handlers (event_week_reminder, long_lead_t30_recap).
      // Must register before the dispatcher's first tick so it can resolve them.
      require('./utils/preEventHandlers').registerAll();

      // Plan 2d: register the marketing/retention dispatcher handlers (drip,
      // new_year_hello, six_months_out, retention_nudge, review_request).
      // Synchronous, like registerAll() above; must run before the dispatcher's
      // first tick so it can resolve these message types.
      require('./utils/marketingHandlers').registerMarketingHandlers();

      // Phase 4a: register the staff-shift SMS handlers (shift_reminder,
      // staff_thank_you). Synchronous; must run before the dispatcher's first
      // tick so it can resolve these staff message types.
      require('./utils/staffShiftHandlers').registerStaffShiftHandlers();
```

- [ ] **Step 2: Add `reanchorStaffShiftMessages` to `staffShiftHandlers.js`**

In `server/utils/staffShiftHandlers.js`, add this function before the `module.exports` block:

```javascript
/**
 * Re-anchor pending staff-shift scheduled_messages after a proposal is
 * rescheduled. shift_reminder / staff_thank_you register with
 * offsetFromEventDate: null, so the generic offset-based reschedule cascade
 * (reanchorPendingMessages) skips them. This recomputes their scheduled_for
 * from the proposal's NEW event date/time/duration.
 *
 * It does TWO things, in this order, per linked shift:
 *
 *   1. INSERT any MISSING staff-message rows for currently-approved staff,
 *      by re-running scheduleStaffShiftMessages (which routes through the
 *      status-agnostic insertShiftMessageIfMissing). This is not just a
 *      "newly-approved staffer" path — it is the recovery path for the
 *      assign-while-TBD case: if a staffer was assigned while
 *      event_start_time was still unknown, scheduleStaffShiftMessages
 *      computed a null reminder instant at assignment time and inserted
 *      NOTHING, so the day-before reminder (and the post-event thank-you)
 *      were never created. Once the admin sets the start time, this
 *      reschedule path re-runs scheduleStaffShiftMessages, the timing helpers
 *      now return real instants, and the missing rows finally get inserted.
 *      A re-anchor that only UPDATEd existing rows would never fire the
 *      reminder for such a shift. insertShiftMessageIfMissing's status-
 *      agnostic existence check (Task 3) means a terminal failed/suppressed
 *      row is left untouched — only a genuinely absent row is created.
 *   2. UPDATE the scheduled_for of any still-pending shift_reminder /
 *      staff_thank_you rows to the new event timing, for rows that already
 *      existed (the ordinary "event moved" case).
 *
 * Best-effort: the caller wraps this in try/catch + Sentry; it also guards
 * its own body. Skips archived proposals.
 *
 * @param {number|string} proposalId
 * @returns {Promise<{reanchored: number}>}
 */
async function reanchorStaffShiftMessages(proposalId) {
  let reanchored = 0;
  try {
    // All shifts on the proposal, with the proposal's current event fields.
    const shiftRes = await pool.query(
      `SELECT s.id AS shift_id,
              p.status AS proposal_status,
              p.event_date, p.event_start_time, p.event_duration_hours,
              p.event_timezone
         FROM shifts s
         LEFT JOIN proposals p ON p.id = s.proposal_id
        WHERE s.proposal_id = $1`,
      [proposalId]
    );
    for (const shift of shiftRes.rows) {
      if (shift.proposal_status === 'archived') continue;
      // Step 1: INSERT any missing rows for currently-approved staff. Covers
      // both a staffer approved after the original scheduling pass AND the
      // assign-while-event-time-was-TBD case (no reminder/thank-you row was
      // ever created because the timing helpers returned null at assignment
      // time; now that the start time is set they resolve and the rows are
      // inserted). Idempotent + status-agnostic via insertShiftMessageIfMissing.
      await scheduleStaffShiftMessages(shift.shift_id);

      const reminderAt = computeShiftReminderScheduledFor(shift);
      const thankYouAt = computeStaffThankYouScheduledFor(shift);

      // Step 2: UPDATE the scheduled_for of rows that already existed.
      if (reminderAt) {
        const u = await pool.query(
          `UPDATE scheduled_messages SET scheduled_for = $1
            WHERE entity_type = 'shift' AND entity_id = $2
              AND message_type = 'shift_reminder' AND status = 'pending'`,
          [reminderAt, shift.shift_id]
        );
        reanchored += u.rowCount;
      }
      if (thankYouAt) {
        const u = await pool.query(
          `UPDATE scheduled_messages SET scheduled_for = $1
            WHERE entity_type = 'shift' AND entity_id = $2
              AND message_type = 'staff_thank_you' AND status = 'pending'`,
          [thankYouAt, shift.shift_id]
        );
        reanchored += u.rowCount;
      }
    }
  } catch (err) {
    Sentry.captureException(err, {
      tags: { component: 'staffShiftHandlers', step: 'reanchorStaffShiftMessages' },
      extra: { proposalId },
    });
    console.error('[staffShiftHandlers] reanchorStaffShiftMessages failed (non-blocking):', err.message);
  }
  return { reanchored };
}
```

- [ ] **Step 3: Add `reanchorStaffShiftMessages` to `module.exports`**

Replace the `module.exports` block in `server/utils/staffShiftHandlers.js` with the full set below. This keeps `runRescheduleStaffHooks` (defined in Task 9 Step 3, exported in Task 9 Step 4) and adds `reanchorStaffShiftMessages` — do NOT drop `runRescheduleStaffHooks`:

```javascript
module.exports = {
  toCalendarYmd,
  parseClockTime,
  eventLocalToUtc,
  computeEventStartUtc,
  computeShiftReminderScheduledFor,
  computeStaffThankYouScheduledFor,
  insertShiftMessageIfMissing,
  scheduleStaffShiftMessages,
  loadStaffShiftContext,
  handleShiftReminder,
  handleStaffThankYou,
  registerStaffShiftHandlers,
  notifyStaffOfCancellation,
  notifyStaffOfScheduleChange,
  runRescheduleStaffHooks,
  reanchorStaffShiftMessages,
};
```

No crud.js change is needed for the re-anchor. Task 9 Step 3 added `runRescheduleStaffHooks`, which calls `reanchorStaffShiftMessages` as its first step, and Task 9 Step 5 already added the single gated `runRescheduleStaffHooks` call to the crud.js reschedule block. With `reanchorStaffShiftMessages` now defined (Step 2 above), that forward reference resolves. The reschedule path is complete: `runRescheduleStaffHooks` re-anchors unconditionally and notifies only when the admin opted in.

- [ ] **Step 4: Verify modules load, lint, and crud.js size**

Run: `node -e "require('./server/utils/staffShiftHandlers'); require('./server/routes/proposals/crud'); console.log('load OK')"`
Expected: `load OK`
(Note: `server/index.js` is NOT load-checked by `require` here because requiring it starts a server. Its single added line is verified by lint below and by the dev-server smoke check the executing agent runs after the task.)

Run: `npx eslint server/index.js server/routes/proposals/crud.js server/utils/staffShiftHandlers.js`
Expected: no errors.

Run: `node scripts/check-file-size.js --all`
Expected: `server/routes/proposals/crud.js` is under the 1000-line hard cap. crud.js grew only by Task 9's destructure (+3) and single gated block (~18) to roughly 992 lines — this task adds NOTHING to crud.js, so the count is unchanged from Task 9. If the report shows crud.js RED, apply the Task 9 Step 6 destructure-trim note.

- [ ] **Step 5: Test the re-anchor**

Append these tests to `server/utils/staffShiftHandlers.test.js` (at the end):

```javascript
test('reanchorStaffShiftMessages > moves a pending shift_reminder to the new event date', async () => {
  await seedShift({ eventDateExpr: "CURRENT_DATE + INTERVAL '60 days'" });
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const before = await pool.query(
    "SELECT scheduled_for FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  const beforeAt = new Date(before.rows[0].scheduled_for).getTime();

  // Move the event 10 days later on both the proposal and the shift.
  await pool.query(
    "UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '70 days' WHERE id = $1",
    [TEST_PROPOSAL_ID]
  );
  await pool.query(
    "UPDATE shifts SET event_date = CURRENT_DATE + INTERVAL '70 days' WHERE id = $1",
    [TEST_SHIFT_ID]
  );

  const { reanchorStaffShiftMessages } = require('./staffShiftHandlers');
  await reanchorStaffShiftMessages(TEST_PROPOSAL_ID);

  const after = await pool.query(
    "SELECT scheduled_for FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1 AND message_type = 'shift_reminder'",
    [TEST_SHIFT_ID]
  );
  const afterAt = new Date(after.rows[0].scheduled_for).getTime();
  // 10 days later -> reminder moves ~10 days later (864000000 ms).
  assert.ok(afterAt - beforeAt > 9 * 86400000 && afterAt - beforeAt < 11 * 86400000,
    `expected ~10-day shift, got ${(afterAt - beforeAt) / 86400000} days`);
});

test('reanchorStaffShiftMessages > schedules a reminder that was skipped because the event time was TBD at assignment', async () => {
  // Finding 2: a staffer assigned while event_start_time is unknown gets NO
  // reminder/thank-you row at assignment time (the timing helpers return
  // null). When the admin later sets the start time, the reschedule path must
  // INSERT the missing rows, not just re-anchor existing ones.
  await seedShift({ startTime: '' }); // '' event_start_time -> TBD

  // Assignment-time scheduling: time is TBD, so nothing is inserted.
  await scheduleStaffShiftMessages(TEST_SHIFT_ID);
  const atAssign = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type = 'shift' AND entity_id = $1",
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(Number(atAssign.rows[0].count), 0); // no rows yet

  // Admin sets the start time on the proposal AND the shift.
  await pool.query(
    "UPDATE proposals SET event_start_time = '18:00' WHERE id = $1",
    [TEST_PROPOSAL_ID]
  );
  await pool.query(
    "UPDATE shifts SET start_time = '18:00' WHERE id = $1",
    [TEST_SHIFT_ID]
  );

  // The reschedule path runs.
  const { reanchorStaffShiftMessages } = require('./staffShiftHandlers');
  await reanchorStaffShiftMessages(TEST_PROPOSAL_ID);

  // The previously-skipped reminder and thank-you rows now exist and are pending.
  const after = await pool.query(
    `SELECT message_type, status FROM scheduled_messages
      WHERE entity_type = 'shift' AND entity_id = $1
      ORDER BY message_type`,
    [TEST_SHIFT_ID]
  );
  assert.strictEqual(after.rows.length, 2);
  const byType = Object.fromEntries(after.rows.map((r) => [r.message_type, r.status]));
  assert.strictEqual(byType.shift_reminder, 'pending');
  assert.strictEqual(byType.staff_thank_you, 'pending');
});
```

- [ ] **Step 6: Run the full staff-handlers test file**

Run: `node --test server/utils/staffShiftHandlers.test.js`
Expected: all 16 tests pass (14 prior + 2 here). `# fail 0`.

- [ ] **Step 7: Commit**

```bash
git add server/index.js server/routes/proposals/crud.js server/utils/staffShiftHandlers.js server/utils/staffShiftHandlers.test.js
git commit -m "feat(comms): register staff handlers at boot, re-anchor staff SMS on reschedule"
```

---

## Task 12: `notify_assigned_staff` UI in `EventEditForm.js`

Add a `notify_assigned_staff` checkbox with two sub-checkboxes (SMS, email) to the event editor, and plumb the three flags through the `PATCH /proposals/:id` request body. Transient per-edit toggles only — no schema column, no persisted state. Both sub-checkboxes default unchecked. The sub-checkboxes are disabled and visually muted until the parent checkbox is on.

`EventEditForm.js` is 233 lines (verified) — comfortably under cap. The `form` state is seeded by `initialFormFromProposal(proposal)`; the three toggle fields are added to local state separately so they never round-trip through the pricing payload.

**Files:**
- Modify: `client/src/pages/admin/EventEditForm.js`

- [ ] **Step 1: Add toggle state**

In `client/src/pages/admin/EventEditForm.js`, the component's state declarations start at line 27. The current block is:

```javascript
  const toast = useToast();
  const [form, setForm] = useState(() => initialFormFromProposal(proposal));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const initialRef = useRef(JSON.stringify(initialFormFromProposal(proposal)));
```

Replace it with:

```javascript
  const toast = useToast();
  const [form, setForm] = useState(() => initialFormFromProposal(proposal));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const initialRef = useRef(JSON.stringify(initialFormFromProposal(proposal)));

  // Transient per-edit staff-notification toggles (Phase 4a). Not part of
  // `form` (which round-trips the pricing payload) and not persisted — they
  // only ride this one PATCH. All default off. The two channel sub-toggles
  // are gated by notifyStaff.
  const [notifyStaff, setNotifyStaff] = useState(false);
  const [notifyStaffSms, setNotifyStaffSms] = useState(false);
  const [notifyStaffEmail, setNotifyStaffEmail] = useState(false);
```

- [ ] **Step 2: Send the three flags in the PATCH body**

In `client/src/pages/admin/EventEditForm.js`, the `handleSave` function builds the PATCH body. It currently ends the body object with:

```javascript
        // Blank → explicit null (reset to package default); else a number.
        // Single-shift events re-sync shifts.setup_minutes_before in the same
        // PATCH transaction; multi-shift events are edited per shift instead.
        setup_minutes_before: form.setup_minutes_before === '' || form.setup_minutes_before == null
          ? null
          : Number(form.setup_minutes_before),
      });
```

Replace it with:

```javascript
        // Blank → explicit null (reset to package default); else a number.
        // Single-shift events re-sync shifts.setup_minutes_before in the same
        // PATCH transaction; multi-shift events are edited per shift instead.
        setup_minutes_before: form.setup_minutes_before === '' || form.setup_minutes_before == null
          ? null
          : Number(form.setup_minutes_before),
        // Phase 4a transient toggles — only honored server-side when a real
        // reschedule (date/time/location change) is detected. Send the
        // sub-flags only when the parent is on, so an unchecked parent never
        // leaks a stale sub-flag.
        notify_assigned_staff: notifyStaff,
        notify_staff_sms: notifyStaff && notifyStaffSms,
        notify_staff_email: notifyStaff && notifyStaffEmail,
      });
```

- [ ] **Step 3: Render the toggle UI**

In `client/src/pages/admin/EventEditForm.js`, find the `FormBanner` line near the end of the JSX:

```javascript
        <FormBanner error={error} fieldErrors={fieldErrors} />
        <div className="hstack" style={{ gap: 8, marginTop: 12 }}>
```

Insert the toggle block immediately before `<FormBanner ...>`, so it becomes:

```javascript
        {/* Staff notification — transient per-edit toggle (Phase 4a). Only
            takes effect when this save is a reschedule (date/time/location
            change). Both channel sub-toggles default off. */}
        <div className="meta-k" style={{ marginBottom: 8, marginTop: 8 }}>Notify assigned staff</div>
        <div style={{ marginBottom: 16 }}>
          <label className="hstack" style={{ gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={notifyStaff}
              onChange={(e) => {
                const on = e.target.checked;
                setNotifyStaff(on);
                if (!on) { setNotifyStaffSms(false); setNotifyStaffEmail(false); }
              }}
            />
            <span>Notify assigned staff if this save reschedules the event</span>
          </label>
          <div
            style={{
              display: 'flex', gap: 16, marginTop: 6, marginLeft: 22,
              opacity: notifyStaff ? 1 : 0.5,
            }}
          >
            <label className="hstack" style={{ gap: 6, cursor: notifyStaff ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                disabled={!notifyStaff}
                checked={notifyStaffSms}
                onChange={(e) => setNotifyStaffSms(e.target.checked)}
              />
              <span>Text (SMS)</span>
            </label>
            <label className="hstack" style={{ gap: 6, cursor: notifyStaff ? 'pointer' : 'default' }}>
              <input
                type="checkbox"
                disabled={!notifyStaff}
                checked={notifyStaffEmail}
                onChange={(e) => setNotifyStaffEmail(e.target.checked)}
              />
              <span>Email</span>
            </label>
          </div>
          <div className="tiny muted" style={{ marginTop: 4, marginLeft: 22 }}>
            Staff are notified only when the date, time, or location actually changes.
          </div>
        </div>

        <FormBanner error={error} fieldErrors={fieldErrors} />
        <div className="hstack" style={{ gap: 8, marginTop: 12 }}>
```

- [ ] **Step 4: Verify the client builds**

Per CLAUDE.md, client lint is enforced only by Vercel CI; verify locally with a CI build. From the repo root:

Run: `cd client && set CI=true&& npx react-scripts build`
(On a POSIX shell: `cd client && CI=true npx react-scripts build`.)
Expected: the build completes with no errors. Warnings-as-errors under `CI=true` would fail the build, so an unused-variable slip surfaces here.

Note: do not run this while a client build or dev server is running in the `os` folder (shared `client/node_modules` junction — see CLAUDE.md).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/EventEditForm.js
git commit -m "feat(comms): notify-assigned-staff toggle in the event editor"
```

---

## Task 13: Documentation updates

Per CLAUDE.md's mandatory-docs rule: a new route file is not added (the route lives in the existing `shifts.js`), but a new util file (`staffShiftHandlers.js`) and a new API route (`POST /api/shifts/:id/cancel-or-unassign`) are. Update `README.md` (folder tree) and `ARCHITECTURE.md` (route table + relevant section). No new env vars, no new npm scripts, no schema columns.

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Add `staffShiftHandlers.js` to the README folder tree**

Open `README.md`, find the `server/utils/` listing in the folder-structure tree. Add an entry alphabetically near the other comms utils (beside `scheduledMessageDispatcher.js`, `messageScheduling.js`, etc.):

```
│       ├── staffShiftHandlers.js   # Staff-shift SMS: day-before reminder, post-event thank-you, schedule-change/cancel notices
```

Match the exact indentation and comment style of the surrounding entries in that file (the tree's box-drawing characters and column alignment vary by file — copy the neighboring lines' format precisely).

- [ ] **Step 2: Add the new route to the ARCHITECTURE.md route table**

Open `ARCHITECTURE.md`, find the API route table section for shifts (rows for `/api/shifts/*`). Add a row for the new route, matching the table's existing column format:

```
| POST   | `/api/shifts/:id/cancel-or-unassign` | Admin/Staffing | Cancel a shift or unassign one staffer; optionally notify affected staff |
```

- [ ] **Step 3: Mention the staff-SMS touches in the relevant ARCHITECTURE.md section**

In `ARCHITECTURE.md`, find the section that describes the comms / scheduled-messages system (where `preEventHandlers` and `marketingHandlers` are described). Add a sentence:

```
Staff-facing SMS (Phase 4a) is handled by `server/utils/staffShiftHandlers.js`: scheduled `shift_reminder` (day before the event) and `staff_thank_you` (after the event) message types, plus immediate schedule-change and cancellation/unassignment notices gated by an admin toggle on the event editor.
```

Place it after the existing description of the scheduled-message handlers, matching the surrounding prose style.

- [ ] **Step 4: Verify the docs reference real paths**

Run: `node -e "console.log(require('fs').existsSync('server/utils/staffShiftHandlers.js') ? 'util exists' : 'MISSING')"`
Expected: `util exists`

- [ ] **Step 5: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs(comms): document staff SMS handlers and cancel/unassign route"
```

---

## Task 14: Full-suite regression check

Run every comms-related test file plus lint to confirm the plan introduced no regressions across the touched modules.

**Files:** none modified.

- [ ] **Step 1: Run all touched / related test files**

Run each and confirm `# fail 0`:

```
node --test server/utils/staffShiftHandlers.test.js
node --test server/routes/shifts.cancelUnassign.test.js
node --test server/utils/scheduledMessageDispatcher.test.js
node --test server/utils/messageScheduling.test.js
node --test server/utils/preEventScheduling.test.js
node --test server/utils/rescheduleProposal.test.js
node --test server/utils/marketingHandlers.test.js
node --test server/routes/proposals/crud.test.js
```

Expected: every file reports `# fail 0`. The four pre-existing comms files (`scheduledMessageDispatcher`, `messageScheduling`, `preEventScheduling`, `rescheduleProposal`, `marketingHandlers`, `crud`) must still pass — they share the dispatcher and the dev DB, so a regression there would surface here.

- [ ] **Step 2: Lint the whole server tree**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Confirm no em dashes in the staff-facing SMS copy**

The no-em-dash rule applies to staff-facing copy (SMS bodies). It does NOT apply to code comments — the existing comms codebase uses em dashes in comments freely, so a whole-file scan of `staffShiftHandlers.js` would false-positive on its comments. `smsTemplates.js` contains only copy functions, so a whole-file scan there is the right check.

Run: `node -e "const s=require('fs').readFileSync('server/utils/smsTemplates.js','utf8'); if (s.includes(String.fromCharCode(8212))) { console.error('EM DASH in smsTemplates.js'); process.exit(1); } console.log('copy clean')"`
Expected: `copy clean`

- [ ] **Step 4: File-size check on the largest touched files**

Run: `node scripts/check-file-size.js --all`
Expected: no RED (over-1000) entry for `server/routes/proposals/crud.js`, `server/routes/shifts.js`, or `server/utils/staffShiftHandlers.js`. `crud.js` and `shifts.js` may show YELLOW (over 700) — acceptable per the ratchet as long as neither crossed 1000. crud.js lands at ~992 lines (the `runRescheduleStaffHooks` extraction in Task 9 keeps the crud.js delta to ~21 lines), so no RED is expected. If `crud.js` is unexpectedly RED, apply the Task 9 Step 6 destructure-trim note and re-commit the trimmed crud.js.

This task ends at Step 4. No commit unless Step 4 forced the destructure trim.

---

## Self-Review

**Spec coverage** — every Phase 4a requirement maps to a task:

| Spec / contract item | Task |
|---|---|
| Day-before shift reminder SMS (spec 3.15) — scheduled, `recipient_type='staff'`, `shift_reminder`, T-24h bespoke timing | Tasks 2, 3, 5 |
| Scheduled from all four assignment paths via one shared helper | Task 3 (helper), Task 7 (wiring all four) |
| Post-event thank-you SMS (spec 3.19) — scheduled, `staff_thank_you`, event end + 30 min | Tasks 2, 3, 5 |
| Schedule-change SMS to staff (spec 3.17) — gated by `notify_assigned_staff`, fires from `PATCH /proposals/:id` reschedule block | Task 9 |
| Cancellation / unassignment SMS to staff (spec 3.18) — gated by toggle; first-class cancel/unassign code path built | Task 8 |
| `notify_assigned_staff` checkbox + email/SMS sub-checkboxes, net-new UI in `EventEditForm.js`, plumbed through `PATCH /proposals/:id` body, transient (no schema column), both sub-checkboxes default off | Task 12 |
| `recipient_type IN ('staff','admin')` per-channel suppression branches in dispatcher `checkSuppression` | Task 10 (Change A) |
| Archived-proposal cascade for staff `shift` rows — `shift_reminder` / `staff_thank_you` rows on an archived proposal are `suppressed`, not `failed` (spec 3.15/3.18/3.19 list "proposal archived" as a suppression condition) | Task 10 (Change B) |
| Staff SMS copy added to `smsTemplates.js` (verbatim from spec 3.15/3.17/3.18/3.19) | Task 1 |
| Scheduled handlers registered with `priority` per contract section 5 (`shift_reminder`=1, `staff_thank_you`=3) | Task 5 |
| Consumes Phase 3 rails (`sendAndLogSms`, `smsTemplates.js`), does not re-specify them | Stated in Dependencies; Tasks 1, 5, 8, 9 |
| Staff handlers registered at boot | Task 11 |
| Reschedule re-anchors staff SMS rows (handlers have null offset, so generic cascade skips them) AND inserts any missing rows — including the assign-while-event-time-was-TBD recovery case, where no reminder/thank-you row was created at assignment time | Task 11 |
| Terminal `failed`/`suppressed` staff-message rows are never silently recreated on a later assignment or schedule-change (`insertShiftMessageIfMissing` existence check is status-agnostic) | Task 3 |
| Docs updated for new util + new route | Task 13 |

The spec lists 3.16 (BEO finalized) in the Stage-3-staff section, but the contract explicitly scopes Phase 4a to 3.15 / 3.17 / 3.18 / 3.19 and marks BEO as a deferred workstream — correctly excluded. Multi-admin model, overlap prevention, and delivery fallback are Phase 4b — correctly excluded.

**Placeholder scan** — no `TODO` / `TBD` (the `'TBD'` string literals in code are fallback display values, not plan placeholders) / "implement later" / "add error handling" / vague "similar to Task N" entries. Every code step shows complete code; every command step shows the exact command and expected output. Task 8 Step 6 states definitively (verified against live `schema.sql`) that `shifts_status_check` already allows `'cancelled'` and `shift_requests_status_check` already allows `'denied'`, so the cancel/unassign route needs no schema change — not a conditional, a confirmed fact. The `runRescheduleStaffHooks` extraction in Task 9 keeps `crud.js` under the 1000-line cap deterministically, so there is no file-size fallback branch.

**Type consistency** — verified across tasks:
- `scheduleStaffShiftMessages(shiftId, executor)` — defined Task 3, called Task 7 (three sites: `shifts.js` assign + approve, `autoAssign.js`) and inside `reanchorStaffShiftMessages` (Task 11); same signature throughout.
- `insertShiftMessageIfMissing(executor, args)` — defined and used only inside `staffShiftHandlers.js` (Task 3). Its existence check is status-agnostic (any existing row for the natural key blocks the insert, including a terminal `failed`/`suppressed` row) — a deliberate divergence from `preEventScheduling.insertIfMissing`, which skips only `pending`/`sent`/`deferred`. Used by `scheduleStaffShiftMessages` (Task 3); reached transitively by `reanchorStaffShiftMessages` (Task 11), which is what makes the re-anchor's missing-row insert leave terminal rows untouched.
- `loadStaffShiftContext(shiftId, staffUserId)` — defined Task 5, reused by `notifyStaffOfCancellation` (Task 8); same two-arg signature.
- `notifyStaffOfCancellation({ shiftId, staffUserIds, kind, sms, email })` — defined Task 8, called from the cancel/unassign route in Task 8; field names match.
- `notifyStaffOfScheduleChange({ proposalId, updated, sms, email })` — defined Task 9 Step 1, called only from `runRescheduleStaffHooks` (Task 9 Step 3); field names match.
- `runRescheduleStaffHooks({ proposalId, updated, notifyStaff, notifyStaffSms, notifyStaffEmail })` — defined Task 9 Step 3, called once from the crud.js reschedule block (Task 9 Step 5); the crud.js call site passes exactly these five fields.
- `reanchorStaffShiftMessages(proposalId)` — defined Task 11 Step 2, called only from `runRescheduleStaffHooks` (Task 9 Step 3 — a forward reference until Task 11 lands, which is why Task 11 must follow Task 9 immediately, as Task 9 Step 3 and Task 11 Step 2 both note). Per linked shift it both INSERTs missing rows (by re-running `scheduleStaffShiftMessages`, which covers the assign-while-TBD recovery case) and UPDATEs the `scheduled_for` of rows that already existed — not an update-only re-anchor.
- `registerStaffShiftHandlers()` — defined Task 5, called at boot in Task 11 Step 1.
- Message types `shift_reminder` / `staff_thank_you` — consistent across the scheduler (Task 3), handlers + registration (Task 5), suppression of cancelled/unassigned rows (Task 8), archived-proposal-cascade suppression (Task 10 Change B suppresses these `entity_type='shift'` rows at the dispatcher), and re-anchor (Task 11).
- `checkSuppression` in `scheduledMessageDispatcher.js` — Task 10 makes two edits to this one function: Change B extends the archived branch at the function's top (joins `shifts → proposals` for `entity_type='shift'` rows), Change A adds the staff/admin per-channel branch before the final `return null`. Both edits land in the same commit. Staff/admin per-channel suppression stays in `checkSuppression` (not moved to Phase 4b's client-only `resolveDelivery`) — consistent with the cross-plan seam.
- `module.exports` of `staffShiftHandlers.js` is restated in full each time it grows (Tasks 2, 3, 5, 8, 9, 11) so a fresh agent reading any single task sees the complete current export list — no drift. The final export set after Task 11 is: `toCalendarYmd`, `parseClockTime`, `eventLocalToUtc`, `computeEventStartUtc`, `computeShiftReminderScheduledFor`, `computeStaffThankYouScheduledFor`, `insertShiftMessageIfMissing`, `scheduleStaffShiftMessages`, `loadStaffShiftContext`, `handleShiftReminder`, `handleStaffThankYou`, `registerStaffShiftHandlers`, `notifyStaffOfCancellation`, `notifyStaffOfScheduleChange`, `runRescheduleStaffHooks`, `reanchorStaffShiftMessages`.
- The `smsTemplates.js` copy function names (`staffShiftReminderSms`, `staffThankYouSms`, `staffScheduleChangeSms`, `staffCancellationSms`) are defined in Task 1 and called with matching context-object keys in Tasks 5, 8, 9.

All consistent. The plan is ready to execute.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-comms-phase4a-staff-sms.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**

**If Subagent-Driven chosen:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development — fresh subagent per task + two-stage review.

**If Inline Execution chosen:** REQUIRED SUB-SKILL: Use superpowers:executing-plans — batch execution with checkpoints for review.
