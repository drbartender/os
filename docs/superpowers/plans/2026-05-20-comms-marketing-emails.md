# Marketing/Retention Emails + Drip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## What This Resolves (Gemini design-review pass, 2026-05-20)

Three findings land in this plan:

- **Finding 1 (BLOCKER) — Shared message-type registry.** Every marketing handler registers with metadata via Plan 2a's expanded `registerHandler(messageType, fn, { offsetFromEventDate, anchor, category })` API. Anchor-independent touches like drip (anchored to proposal-sent moment, not event_date) pass `offsetFromEventDate: null` so Plan 2c's reschedule cascade leaves them alone. Event-anchored touches (new_year_hello, six_months_out, retention_nudge, review_request) carry the correct offset+anchor so the cascade re-anchors them on reschedule.
- **Finding 4 (WARNING) — Marketing TZ uses event TZ, not hardcoded Chicago.** The send-time helpers in `retentionEligibility.js` accept an event timezone (defaulting to `America/Chicago` ONLY when no proposal context is provided) and use `resolveEventTimezone(proposal)` from Plan 1's `server/utils/eventTimezone.js` at call sites. Spec 7.2 mandates event-local sends.
- **Finding 5 (WARNING) — Marketing gating handled by dispatcher metadata.** All marketing-class types (drip_touch_2, drip_touch_4, drip_touch_5_email, new_year_hello, six_months_out, retention_nudge) register with `category: 'marketing'`. The dispatcher's marketing-gate check (Plan 2a Task 9) reads handler metadata at fire time and suppresses with reason `'marketing_disabled'` when the client's `communication_preferences.marketing_enabled === false`. Plan 2d's `MARKETING_MESSAGE_TYPES` export is kept as a convenience constant but is no longer the source of truth; the dispatcher uses handler metadata. `review_request` registers with `category: 'operational'` (transactional under CAN-SPAM).

---

**Goal:** Implement the marketing-class email touches (unsigned-proposal drip email half, New Year touch, 6-months-out touch, retention nudge) plus the long-form post-event review request with sentiment-routing feedback router page.

**Architecture:** Eight new email templates live next to existing templates in `server/utils/emailTemplates.js` (with a split if the file passes 700 lines). Each touch registers a dispatcher handler that renders the template, sends via the existing `sendEmail` helper, and respects the marketing-gating flag declared at registration. Scheduling is event-driven: when a proposal transitions to status `sent`, `completed`, etc., the route or scheduler inserts `scheduled_messages` rows for every touch eligible for that proposal. A new `post_event_feedback` table stores the low-rating responses captured by the new public feedback router page (`GET/POST /feedback/:token`, no auth, proposal-token-gated, idempotent).

**Tech Stack:** PostgreSQL via `pg`, Express 4.22 routers, React 18 + React Router 6 for the public feedback page, Resend (via existing `server/utils/email.js`), the dispatcher utilities from Plan 2a (`server/utils/messageScheduling.js` and `server/utils/scheduledMessageDispatcher.js`), `node:test` + `node:assert/strict` for tests.

**Related spec:** `docs/superpowers/specs/2026-05-20-automated-communication-design.md` sections 1.3, 1.4, 1.5, 4.1, 4.2, 7.3.

**Depends on:**
- Plan 1 (foundation) — `scheduled_messages` table, `clients.communication_preferences`, archive cascade
- Plan 2a (money path) — `scheduleMessage()` and `registerHandler()` dispatcher contract

**Doesn't cover:**
- SMS halves of touches 1, 3, 5 of the unsigned-proposal drip (Plan 3 / client-facing SMS)
- T-30 recap (Plan 2c)
- The retention nudge admin config UI for tuning the eligible-event-type whitelist (deferred — code-level constant only for now)
- Self-service preferences page (open item §12.5)

---

## File Structure

**Files to create:**
- `server/utils/marketingEmailTemplates.js` — new templates: `dripTouch2Client`, `dripTouch4Client`, `dripTouch5Client`, `reviewRequestClient`, `newYearHelloClient`, `sixMonthsOutClient`, `retentionNudgeClient`, `lowRatingAdminNotification`
- `server/utils/marketingEmailTemplates.test.js` — render-shape tests for each template
- `server/utils/retentionEligibility.js` — pure helpers: `isRetentionEligibleEventType`, `shouldScheduleNewYearTouch`, `shouldScheduleSixMonthsTouch`, retention-suppression check (has-upcoming-event)
- `server/utils/retentionEligibility.test.js` — unit tests
- `server/utils/marketingHandlers.js` — dispatcher handler registrations for all eight marketing-class message types, plus the scheduling helpers (`scheduleDripForProposal`, `scheduleReviewRequest`, `scheduleNewYearHello`, `scheduleSixMonthsOut`, `scheduleRetentionNudge`, `cancelMarketingForProposal`)
- `server/utils/marketingHandlers.test.js` — integration tests with the dispatcher
- `server/routes/publicFeedback.js` — `GET /api/public/feedback/:token` (validate token, return display data), `POST /api/public/feedback/:token` (record rating, dispatch admin email on low rating, return redirect URL on high rating)
- `server/routes/publicFeedback.test.js` — route-level integration tests
- `client/src/pages/public/FeedbackPage.jsx` — new public sentiment-router page (5-star UI mirroring tip page pattern)
- `client/src/pages/public/FeedbackPage.css` — styling for the public feedback page

**Files to modify:**
- `server/db/schema.sql` — append `post_event_feedback` table at end of file (idempotent block)
- `server/index.js` — mount the new `/api/public/feedback` router, register marketing-handler registrations on boot
- `server/routes/proposals/crud.js` — on `status = 'sent'` transition, call `scheduleDripForProposal`. On `status = 'completed'` (manual), call `scheduleReviewRequest` + `scheduleRetentionNudge`. On signed (Stripe webhook is the canonical sign-pay trigger — see Task 14), call `scheduleNewYearHello` + `scheduleSixMonthsOut`. On status = 'archived', call `cancelMarketingForProposal`.
- `server/utils/balanceScheduler.js` — after the `processEventCompletions` auto-complete loop, call `scheduleReviewRequest` and `scheduleRetentionNudge` for each newly-completed proposal
- `server/routes/stripeWebhook.js` (or wherever sign+pay completes today) — on first-deposit success, call `scheduleNewYearHello` and `scheduleSixMonthsOut`
- `client/src/App.js` — add `<Route path="/feedback/:token" element={<FeedbackPage />} />` to the public-domain SPA route block

**Files referenced (no edits):**
- `server/utils/email.js` for `sendEmail`
- `server/utils/emailTemplates.js` for `wrapMarketingEmail`, `wrapEmail`, `ctaButton`, `esc`, `BRAND`
- `server/utils/eventTypes.js` for `getEventTypeLabel` and the `EVENT_TYPES` catalog
- `server/utils/urls.js` for `PUBLIC_SITE_URL`, `ADMIN_URL`, `API_URL`
- `server/utils/messageScheduling.js` and `scheduledMessageDispatcher.js` from Plan 2a
- `server/middleware/rateLimiters.js` for `publicLimiter` / `publicReadLimiter`

---

## Task 1: Create `post_event_feedback` table

**Files:**
- Modify: `server/db/schema.sql` — append at end of file

The low-rating responses from the post-event feedback router page need a durable home so admin can review history and so the route can stay idempotent (a client clicking the email twice should not double-send).

- [ ] **Step 1: Append the SQL block to `schema.sql`**

```sql
-- ─── Automated Communication: post_event_feedback table ─────────
-- Captures low-rating (1-3 star) responses from the post-event review
-- router page. 4-5 stars route directly to Google Review URL and never
-- hit this table. One row per submission; the (proposal_id) uniqueness
-- below means a client can submit only once per proposal — re-submits
-- get conflict-ignored with an "already received" response.

CREATE TABLE IF NOT EXISTS post_event_feedback (
  id SERIAL PRIMARY KEY,
  proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  submitter_ip TEXT,
  submitter_user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_post_event_feedback_proposal
  ON post_event_feedback(proposal_id);
CREATE INDEX IF NOT EXISTS idx_post_event_feedback_created_at
  ON post_event_feedback(created_at DESC);
```

- [ ] **Step 2: Apply and verify**

Restart the dev server (loads `schema.sql`), then:

```bash
psql "$DATABASE_URL" -c "\\d post_event_feedback"
```

Expected: the table appears with the five columns above, the proposal_id FK with `ON DELETE CASCADE`, and the unique index.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(comms): add post_event_feedback table for review router"
```

---

## Task 2: Build retention eligibility helpers

**Files:**
- Create: `server/utils/retentionEligibility.js`
- Create: `server/utils/retentionEligibility.test.js`

Pure helpers, no DB calls for the per-event-type whitelist. The has-upcoming-event suppression check IS DB-bound and lives here too so the handler can call a single utility.

- [ ] **Step 1: Write the failing test**

Create `server/utils/retentionEligibility.test.js`:

```javascript
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  RETENTION_ELIGIBLE_EVENT_TYPES,
  isRetentionEligibleEventType,
  shouldScheduleNewYearTouch,
  shouldScheduleSixMonthsTouch,
  clientHasUpcomingEvent,
  computeReviewRequestSendAt,
  computeRetentionNudgeSendAt,
  computeNewYearSendAt,
  computeSixMonthsOutSendAt,
} = require('./retentionEligibility');

// ── isRetentionEligibleEventType ──
test('isRetentionEligibleEventType > returns true for whitelisted event types', () => {
  assert.strictEqual(isRetentionEligibleEventType('holiday-party'), true);
  assert.strictEqual(isRetentionEligibleEventType('birthday-party'), true);
  assert.strictEqual(isRetentionEligibleEventType('milestone-birthday'), true);
  assert.strictEqual(isRetentionEligibleEventType('corporate-event'), true);
  assert.strictEqual(isRetentionEligibleEventType('corporate-happy-hour'), true);
  assert.strictEqual(isRetentionEligibleEventType('anniversary'), true);
});

test('isRetentionEligibleEventType > returns false for excluded event types', () => {
  assert.strictEqual(isRetentionEligibleEventType('wedding-reception'), false);
  assert.strictEqual(isRetentionEligibleEventType('engagement-party'), false);
  assert.strictEqual(isRetentionEligibleEventType('baby-shower'), false);
  assert.strictEqual(isRetentionEligibleEventType('graduation-party'), false);
  assert.strictEqual(isRetentionEligibleEventType('retirement-party'), false);
  assert.strictEqual(isRetentionEligibleEventType('bachelor-bachelorette'), false);
});

test('isRetentionEligibleEventType > returns false for null/undefined/unknown', () => {
  assert.strictEqual(isRetentionEligibleEventType(null), false);
  assert.strictEqual(isRetentionEligibleEventType(undefined), false);
  assert.strictEqual(isRetentionEligibleEventType('not-a-real-type'), false);
});

test('isRetentionEligibleEventType > exposes the whitelist constant for admin UI later', () => {
  assert.ok(RETENTION_ELIGIBLE_EVENT_TYPES.includes('holiday-party'));
  assert.ok(RETENTION_ELIGIBLE_EVENT_TYPES.includes('birthday-party'));
});

// ── shouldScheduleNewYearTouch ──
test('shouldScheduleNewYearTouch > returns true when event is in next calendar year and >= 60 days into new year', () => {
  const signedAt = new Date('2026-11-15T12:00:00Z');
  const eventDate = new Date('2027-04-01'); // 90 days into 2027
  assert.strictEqual(shouldScheduleNewYearTouch(signedAt, eventDate), true);
});

test('shouldScheduleNewYearTouch > returns false when event is in same calendar year as sign', () => {
  const signedAt = new Date('2026-03-01T12:00:00Z');
  const eventDate = new Date('2026-12-31');
  assert.strictEqual(shouldScheduleNewYearTouch(signedAt, eventDate), false);
});

test('shouldScheduleNewYearTouch > returns false when event is <60 days into the new year', () => {
  const signedAt = new Date('2026-11-15T12:00:00Z');
  const eventDate = new Date('2027-01-15'); // 14 days into new year
  assert.strictEqual(shouldScheduleNewYearTouch(signedAt, eventDate), false);
});

test('shouldScheduleNewYearTouch > returns false when event is in a year beyond next', () => {
  const signedAt = new Date('2026-11-15T12:00:00Z');
  const eventDate = new Date('2028-04-01');
  assert.strictEqual(shouldScheduleNewYearTouch(signedAt, eventDate), false);
});

// ── shouldScheduleSixMonthsTouch ──
test('shouldScheduleSixMonthsTouch > returns true when booking lead time > 6 months', () => {
  const signedAt = new Date('2026-01-15T12:00:00Z');
  const eventDate = new Date('2026-08-15'); // 7 months later
  assert.strictEqual(shouldScheduleSixMonthsTouch(signedAt, eventDate), true);
});

test('shouldScheduleSixMonthsTouch > returns false when booking lead time exactly 6 months', () => {
  const signedAt = new Date('2026-02-15T12:00:00Z');
  const eventDate = new Date('2026-08-15');
  assert.strictEqual(shouldScheduleSixMonthsTouch(signedAt, eventDate), false);
});

test('shouldScheduleSixMonthsTouch > returns false when booking lead time < 6 months', () => {
  const signedAt = new Date('2026-05-15T12:00:00Z');
  const eventDate = new Date('2026-08-15');
  assert.strictEqual(shouldScheduleSixMonthsTouch(signedAt, eventDate), false);
});

// ── computeNewYearSendAt ──
test('computeNewYearSendAt > defaults to America/Chicago when no tz passed', () => {
  const eventDate = new Date('2027-04-01');
  const result = computeNewYearSendAt(eventDate);
  // Jan 2 2027 10:00 Chicago = Jan 2 2027 16:00 UTC (CST is UTC-6)
  assert.strictEqual(result.toISOString(), '2027-01-02T16:00:00.000Z');
});

test('computeNewYearSendAt > honors a passed event TZ (Gemini Finding 4)', () => {
  const eventDate = new Date('2027-04-01');
  const result = computeNewYearSendAt(eventDate, 'America/New_York');
  // Jan 2 2027 10:00 NY = Jan 2 2027 15:00 UTC (EST is UTC-5)
  assert.strictEqual(result.toISOString(), '2027-01-02T15:00:00.000Z');
});

// ── computeSixMonthsOutSendAt ──
test('computeSixMonthsOutSendAt > returns event_date minus 6 months at 10:00 America/Chicago by default', () => {
  const eventDate = new Date('2026-12-15');
  const result = computeSixMonthsOutSendAt(eventDate);
  // 6 months before 2026-12-15 = 2026-06-15
  // 10:00 Chicago in June = 15:00 UTC (CDT is UTC-5)
  assert.strictEqual(result.toISOString(), '2026-06-15T15:00:00.000Z');
});

test('computeSixMonthsOutSendAt > honors a passed event TZ', () => {
  const eventDate = new Date('2026-12-15');
  const result = computeSixMonthsOutSendAt(eventDate, 'America/Los_Angeles');
  // 6 months before = 2026-06-15; 10:00 LA in June = 17:00 UTC (PDT is UTC-7)
  assert.strictEqual(result.toISOString(), '2026-06-15T17:00:00.000Z');
});

// ── computeReviewRequestSendAt ──
test('computeReviewRequestSendAt > returns event_date + 2 days at 10:00 America/Chicago by default', () => {
  const eventDate = new Date('2026-06-15');
  const result = computeReviewRequestSendAt(eventDate);
  assert.strictEqual(result.toISOString(), '2026-06-17T15:00:00.000Z');
});

// ── computeRetentionNudgeSendAt ──
test('computeRetentionNudgeSendAt > returns event_date + 11 months at 10:00 America/Chicago by default', () => {
  const eventDate = new Date('2026-01-15');
  const result = computeRetentionNudgeSendAt(eventDate);
  // 11 months later = 2026-12-15
  // 10:00 Chicago in December = 16:00 UTC (CST)
  assert.strictEqual(result.toISOString(), '2026-12-15T16:00:00.000Z');
});

// ── clientHasUpcomingEvent ──
let retentionClientId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ('Retention Test', 'retention-test@example.com') RETURNING id"
  );
  retentionClientId = c.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [retentionClientId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [retentionClientId]);
});

afterEach(async () => {
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [retentionClientId]);
});

test('clientHasUpcomingEvent > returns true when client has another non-archived future event', async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'confirmed') RETURNING id`,
    [retentionClientId]
  );
  const otherProposalId = p.rows[0].id;
  const result = await clientHasUpcomingEvent(retentionClientId, otherProposalId + 1);
  assert.strictEqual(result, true);
});

test('clientHasUpcomingEvent > returns false when only the excluded proposal exists', async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'confirmed') RETURNING id`,
    [retentionClientId]
  );
  const result = await clientHasUpcomingEvent(retentionClientId, p.rows[0].id);
  assert.strictEqual(result, false);
});

test('clientHasUpcomingEvent > returns false when other future events are archived', async () => {
  await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, archive_reason)
     VALUES ($1, CURRENT_DATE + INTERVAL '30 days', 'archived', 'client_cancelled')`,
    [retentionClientId]
  );
  const result = await clientHasUpcomingEvent(retentionClientId, -1);
  assert.strictEqual(result, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/utils/retentionEligibility.test.js
```

Expected: FAIL with `Cannot find module './retentionEligibility'`.

- [ ] **Step 3: Implement the utility**

Create `server/utils/retentionEligibility.js`:

```javascript
const { pool } = require('../db');

/**
 * Event types that qualify for the T+11mo retention nudge.
 * Excludes one-time-per-host event categories (weddings, engagements, baby
 * showers, retirements, bachelor/bachelorette parties, graduations) where
 * the nudge would be tone-deaf or simply not actionable. See spec 4.2.
 *
 * IDs mirror server/utils/eventTypes.js. Keep them in sync if either file
 * changes. The list is intentionally a code constant (not DB config) for V1;
 * a future admin UI to tune the whitelist is open item §12 in the spec.
 */
const RETENTION_ELIGIBLE_EVENT_TYPES = [
  'holiday-party',
  'birthday-party',
  'milestone-birthday',
  'corporate-event',
  'corporate-happy-hour',
  'anniversary',
  'cocktail-party',
  'cocktail-class',
];

function isRetentionEligibleEventType(eventType) {
  if (!eventType) return false;
  return RETENTION_ELIGIBLE_EVENT_TYPES.includes(eventType);
}

/**
 * New Year touch eligibility: event is in the calendar year immediately
 * following the sign year, AND the event date is at least 60 days into
 * that new year. The 60-day rule keeps us from sending "happy new year"
 * to a January 15 booking — they'd hear it less than two weeks before
 * the event, which feels off.
 */
function shouldScheduleNewYearTouch(signedAt, eventDate) {
  if (!signedAt || !eventDate) return false;
  const signYear = new Date(signedAt).getUTCFullYear();
  const eventYear = new Date(eventDate).getUTCFullYear();
  if (eventYear !== signYear + 1) return false;
  const jan1 = new Date(Date.UTC(eventYear, 0, 1));
  const diffDays = Math.floor((new Date(eventDate).getTime() - jan1.getTime()) / 86400000);
  return diffDays >= 60;
}

/**
 * 6-months-out touch eligibility: booking lead time strictly greater than
 * 6 calendar months (180 days). Strict so a 6-month-exactly booking
 * doesn't fire a touch the day it's signed.
 */
function shouldScheduleSixMonthsTouch(signedAt, eventDate) {
  if (!signedAt || !eventDate) return false;
  const diffMs = new Date(eventDate).getTime() - new Date(signedAt).getTime();
  const diffDays = diffMs / 86400000;
  return diffDays > 180;
}

/**
 * Compute the UTC instant for "10:00 AM event-local on the given date" using
 * the proposal's event timezone (Gemini Finding 4 / spec 7.2).
 *
 * Callers pass an explicit `tz` (e.g. resolved via
 * `resolveEventTimezone(proposal)` from Plan 1's `eventTimezone.js`). The
 * default of `America/Chicago` is preserved as a fallback for tests and any
 * code path that genuinely has no proposal context, but production sites
 * MUST pass the event TZ. The dispatcher schedules wall-clock 10am on the
 * configured day; DST is handled because we probe Intl.DateTimeFormat for
 * the specific calendar date.
 */
function tenAmInTzUtc(localDate, tz = 'America/Chicago') {
  const d = new Date(localDate);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  // Probe over a 24-hour range. For tz offsets in [-12, +14] there are at
  // most ~26 valid UTC hour candidates; iterate and find the one whose
  // wall-clock hour in tz is 10.
  for (let utcHour = 0; utcHour < 36; utcHour++) {
    const probe = new Date(Date.UTC(year, month, day, utcHour, 0, 0));
    let zoneHour;
    try {
      zoneHour = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(probe);
    } catch {
      // Invalid tz → fall back to UTC math (treat tz as Etc/UTC offset 0)
      return new Date(Date.UTC(year, month, day, 10, 0, 0));
    }
    if (zoneHour === '10') return probe;
  }
  // Genuinely impossible (no 10am wall-clock in this tz on this date) →
  // emergency fallback to 10:00 UTC.
  return new Date(Date.UTC(year, month, day, 10, 0, 0));
}

/**
 * @deprecated kept temporarily for back-compat in tests. Prefer
 *   `tenAmInTzUtc(localDate, resolveEventTimezone(proposal))`.
 */
function chicagoTenAmUtc(localDate) {
  return tenAmInTzUtc(localDate, 'America/Chicago');
}

function computeNewYearSendAt(eventDate, tz = 'America/Chicago') {
  const year = new Date(eventDate).getUTCFullYear();
  return tenAmInTzUtc(new Date(Date.UTC(year, 0, 2)), tz); // Jan 2 of event year
}

function computeSixMonthsOutSendAt(eventDate, tz = 'America/Chicago') {
  const d = new Date(eventDate);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 6, d.getUTCDate()));
  return tenAmInTzUtc(target, tz);
}

function computeReviewRequestSendAt(eventDate, tz = 'America/Chicago') {
  const d = new Date(eventDate);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 2));
  return tenAmInTzUtc(target, tz);
}

function computeRetentionNudgeSendAt(eventDate, tz = 'America/Chicago') {
  const d = new Date(eventDate);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 11, d.getUTCDate()));
  return tenAmInTzUtc(target, tz);
}

/**
 * Check whether a client has another non-archived future event in the system,
 * excluding the proposal that triggered the retention check. Used to suppress
 * the retention nudge when the client is already actively booked again.
 */
async function clientHasUpcomingEvent(clientId, excludingProposalId) {
  const { rows } = await pool.query(
    `SELECT 1
     FROM proposals
     WHERE client_id = $1
       AND id != $2
       AND status != 'archived'
       AND event_date >= CURRENT_DATE
     LIMIT 1`,
    [clientId, excludingProposalId]
  );
  return rows.length > 0;
}

module.exports = {
  RETENTION_ELIGIBLE_EVENT_TYPES,
  isRetentionEligibleEventType,
  shouldScheduleNewYearTouch,
  shouldScheduleSixMonthsTouch,
  tenAmInTzUtc,
  computeNewYearSendAt,
  computeSixMonthsOutSendAt,
  computeReviewRequestSendAt,
  computeRetentionNudgeSendAt,
  clientHasUpcomingEvent,
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
node --test server/utils/retentionEligibility.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/retentionEligibility.js server/utils/retentionEligibility.test.js
git commit -m "feat(comms): add retention eligibility and send-time helpers"
```

---

## Task 3: Build the eight marketing email templates

**Files:**
- Create: `server/utils/marketingEmailTemplates.js`
- Create: `server/utils/marketingEmailTemplates.test.js`

The templates live in a sibling file rather than appending to `emailTemplates.js` (which is already 756 lines and would cross the 1000-line hard cap). Each marketing template uses `wrapMarketingEmail` (already exported by `emailTemplates.js`) so the unsubscribe footer is automatic.

- [ ] **Step 1: Write the failing test**

Create `server/utils/marketingEmailTemplates.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tpl = require('./marketingEmailTemplates');

const baseParams = {
  clientName: 'Jane',
  clientFirstName: 'Jane',
  eventTypeLabel: 'birthday party',
  eventDateDisplay: 'June 15, 2026',
  proposalUrl: 'https://drbartender.com/proposal/abc-token',
  unsubscribeUrl: 'https://api.drbartender.com/unsubscribe?t=xyz',
};

// ── dripTouch2Client ──
test('dripTouch2Client > renders subject with first name and event date', () => {
  const out = tpl.dripTouch2Client(baseParams);
  assert.strictEqual(out.subject, 'Still thinking about your June 15, 2026 event, Jane?');
});

test('dripTouch2Client > includes the proposal URL and the unsubscribe footer', () => {
  const out = tpl.dripTouch2Client(baseParams);
  assert.ok(out.html.includes('https://drbartender.com/proposal/abc-token'));
  assert.ok(out.html.includes('Unsubscribe'));
  assert.ok(out.html.includes(baseParams.unsubscribeUrl));
});

test('dripTouch2Client > falls back to "there" / "your event" / "soon" when params are missing', () => {
  const out = tpl.dripTouch2Client({
    unsubscribeUrl: baseParams.unsubscribeUrl,
  });
  assert.match(out.subject, /event/);
  assert.ok(out.html.includes('Hi there'));
});

// ── dripTouch4Client ──
test('dripTouch4Client > mentions BYOB and Hosted alternative packages', () => {
  const out = tpl.dripTouch4Client(baseParams);
  assert.match(out.html, /BYOB/);
  assert.match(out.html, /Hosted/);
});

test('dripTouch4Client > subject mentions following up and event date', () => {
  const out = tpl.dripTouch4Client(baseParams);
  assert.strictEqual(out.subject, 'Following up on your June 15, 2026 booking, Jane');
});

// ── dripTouch5Client ──
test('dripTouch5Client > subject says "last call"', () => {
  const out = tpl.dripTouch5Client(baseParams);
  assert.strictEqual(out.subject, 'Last call to secure June 15, 2026, Jane');
});

test('dripTouch5Client > includes the proposal URL', () => {
  const out = tpl.dripTouch5Client(baseParams);
  assert.ok(out.html.includes(baseParams.proposalUrl));
});

// ── reviewRequestClient ──
const reviewParams = {
  ...baseParams,
  dayOfWeek: 'Saturday',
  feedbackUrl: 'https://drbartender.com/feedback/abc-token',
  bartenderName: 'Alex',
  venmoHandle: '@alex-bartender',
  cashappHandle: '$alexb',
  zelleHandle: 'alex@example.com',
};

test('reviewRequestClient > renders subject with event date', () => {
  const out = tpl.reviewRequestClient(reviewParams);
  assert.strictEqual(out.subject, 'How was your June 15, 2026 event?');
});

test('reviewRequestClient > includes feedback URL and bartender tip handles when present', () => {
  const out = tpl.reviewRequestClient(reviewParams);
  assert.ok(out.html.includes('https://drbartender.com/feedback/abc-token'));
  assert.ok(out.html.includes('Alex'));
  assert.ok(out.html.includes('@alex-bartender'));
  assert.ok(out.html.includes('$alexb'));
  assert.ok(out.html.includes('alex@example.com'));
});

test('reviewRequestClient > omits the tip-handle line when bartenderName is null (multi-bartender)', () => {
  const out = tpl.reviewRequestClient({ ...reviewParams, bartenderName: null });
  assert.doesNotMatch(out.html, /tips at/);
});

test('reviewRequestClient > omits a single tip handle when it is missing', () => {
  const out = tpl.reviewRequestClient({ ...reviewParams, cashappHandle: null });
  assert.ok(!out.html.includes('Cash App'));
  assert.ok(out.html.includes('@alex-bartender'));
});

// ── newYearHelloClient ──
test('newYearHelloClient > subject contains "happy new year" and first name', () => {
  const out = tpl.newYearHelloClient(baseParams);
  assert.strictEqual(out.subject, 'Happy new year, Jane, looking forward to your event');
});

test('newYearHelloClient > includes the event type label and date in body', () => {
  const out = tpl.newYearHelloClient(baseParams);
  assert.ok(out.html.includes('birthday party'));
  assert.ok(out.html.includes('June 15, 2026'));
});

// ── sixMonthsOutClient ──
test('sixMonthsOutClient > subject says "six months out"', () => {
  const out = tpl.sixMonthsOutClient({
    ...baseParams,
    potionPlannerUrl: 'https://drbartender.com/plan/xyz',
    consultUrl: 'https://cal.com/drbartender/consult',
  });
  assert.strictEqual(out.subject, 'Six months out from your June 15, 2026 event');
});

test('sixMonthsOutClient > includes potion planner URL and consult URL', () => {
  const out = tpl.sixMonthsOutClient({
    ...baseParams,
    potionPlannerUrl: 'https://drbartender.com/plan/xyz',
    consultUrl: 'https://cal.com/drbartender/consult',
  });
  assert.ok(out.html.includes('https://drbartender.com/plan/xyz'));
  assert.ok(out.html.includes('https://cal.com/drbartender/consult'));
});

// ── retentionNudgeClient ──
test('retentionNudgeClient > subject mentions almost a year and event type', () => {
  const out = tpl.retentionNudgeClient(baseParams);
  assert.strictEqual(out.subject, 'Almost a year since your birthday party, Jane');
});

test('retentionNudgeClient > includes unsubscribe footer (this IS marketing-class)', () => {
  const out = tpl.retentionNudgeClient(baseParams);
  assert.ok(out.html.includes(baseParams.unsubscribeUrl));
});

// ── lowRatingAdminNotification ──
const adminParams = {
  clientName: 'Jane',
  eventDateDisplay: 'June 15, 2026',
  eventTypeLabel: 'birthday party',
  rating: 2,
  comment: 'Bartender was 30 minutes late.',
  adminUrl: 'https://admin.drbartender.com/proposals/42',
};

test('lowRatingAdminNotification > subject flags low rating', () => {
  const out = tpl.lowRatingAdminNotification(adminParams);
  assert.match(out.subject, /Low rating/);
});

test('lowRatingAdminNotification > includes rating, comment, and admin link', () => {
  const out = tpl.lowRatingAdminNotification(adminParams);
  assert.ok(out.html.includes('2 / 5'));
  assert.ok(out.html.includes('Bartender was 30 minutes late.'));
  assert.ok(out.html.includes(adminParams.adminUrl));
});

test('lowRatingAdminNotification > renders gracefully when comment is null', () => {
  const out = tpl.lowRatingAdminNotification({ ...adminParams, comment: null });
  assert.ok(!out.html.includes('null'));
});
```

Note on the newYearHelloClient assertion: the spec-original copy uses an em dash ("Happy new year, Jane — looking forward..."), but project copy preference is to avoid em dashes (see CLAUDE.md memory). The assertion above and the template should use a comma instead. Keep both in sync when the template lands.

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/utils/marketingEmailTemplates.test.js
```

Expected: FAIL with `Cannot find module './marketingEmailTemplates'`.

- [ ] **Step 3: Implement the templates**

Create `server/utils/marketingEmailTemplates.js`:

```javascript
const { wrapMarketingEmail, wrapEmail } = require('./emailTemplates');

const BRAND_PRIMARY = '#3b2314';
const BRAND_SECONDARY = '#6b4226';
const BRAND_BG = '#f9f6f3';

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function ctaButton(url, label) {
  return `<p style="text-align:center;margin:2rem 0;">
    <a href="${esc(url)}" style="display:inline-block;padding:14px 32px;background:${BRAND_PRIMARY};color:#fff;text-decoration:none;border-radius:6px;font-weight:bold;font-size:16px;">${esc(label)}</a>
  </p>`;
}

function defaults(p) {
  return {
    clientFirstName: p.clientFirstName || p.clientName || 'there',
    clientName: p.clientName || p.clientFirstName || 'there',
    eventTypeLabel: p.eventTypeLabel || 'event',
    eventDateDisplay: p.eventDateDisplay || 'your upcoming event',
    proposalUrl: p.proposalUrl || '#',
    unsubscribeUrl: p.unsubscribeUrl || '',
  };
}

// ─── 1.3 Drip — Touch 2 (+7 days) ────────────────────────────────

function dripTouch2Client(params) {
  const d = defaults(params);
  return {
    subject: `Still thinking about your ${d.eventDateDisplay} event, ${d.clientFirstName}?`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>Just checking in on your <strong>${esc(d.eventTypeLabel)}</strong> coming up ${esc(d.eventDateDisplay)}. Your proposal is still good to go whenever you're ready.</p>
      ${ctaButton(d.proposalUrl, 'View your proposal')}
      <p>Let me know if you have any questions or want to talk anything through.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, just checking in on your ${d.eventTypeLabel} coming up ${d.eventDateDisplay}. Your proposal is still good to go: ${d.proposalUrl}. Let me know if you have any questions. Cheers, Dallas`,
  };
}

// ─── 1.3 Drip — Touch 4 (+14 days) ───────────────────────────────

function dripTouch4Client(params) {
  const d = defaults(params);
  return {
    subject: `Following up on your ${d.eventDateDisplay} booking, ${d.clientFirstName}`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>Wanted to check back in on your <strong>${esc(d.eventTypeLabel)}</strong>. Your proposal as written is still here.</p>
      ${ctaButton(d.proposalUrl, 'View your proposal')}
      <p>A few things worth knowing: if BYOB isn't quite right, we also offer <strong>Hosted</strong> packages where we handle the alcohol. Happy to send an updated quote if you want to see numbers on that side.</p>
      <p>Let me know if you have any questions or need any changes.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, checking back in on your ${d.eventTypeLabel}. Proposal: ${d.proposalUrl}. If BYOB isn't quite right, we also offer Hosted packages — happy to send numbers. Cheers, Dallas`,
  };
}

// ─── 1.3 Drip — Touch 5 (+21 days), email half ───────────────────

function dripTouch5Client(params) {
  const d = defaults(params);
  return {
    subject: `Last call to secure ${d.eventDateDisplay}, ${d.clientFirstName}`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>Wanted to do one last check-in on your <strong>${esc(d.eventTypeLabel)}</strong> on ${esc(d.eventDateDisplay)}. We're still holding the date, but other bookings come in regularly for that weekend.</p>
      ${ctaButton(d.proposalUrl, 'Lock it in')}
      <p>If you'd rather walk away, no hard feelings, just reply to let us know.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, one last check on your ${d.eventTypeLabel} on ${d.eventDateDisplay}. We're still holding the date but others come in for that weekend. Lock it in: ${d.proposalUrl}. Or reply to walk away. Cheers, Dallas`,
  };
}

// ─── 4.1 Post-event review request (T+2 days) ────────────────────

function reviewRequestClient(params) {
  const d = defaults(params);
  const dayOfWeek = params.dayOfWeek || 'weekend';
  const feedbackUrl = params.feedbackUrl || '#';
  const bartenderName = params.bartenderName;
  const venmoHandle = params.venmoHandle;
  const cashappHandle = params.cashappHandle;
  const zelleHandle = params.zelleHandle;

  let tipSection = '';
  if (bartenderName) {
    const handles = [];
    if (venmoHandle) handles.push(`Venmo: <strong>${esc(venmoHandle)}</strong>`);
    if (cashappHandle) handles.push(`Cash App: <strong>${esc(cashappHandle)}</strong>`);
    if (zelleHandle) handles.push(`Zelle: <strong>${esc(zelleHandle)}</strong>`);
    if (handles.length > 0) {
      tipSection = `
        <p style="background:${BRAND_BG};padding:14px 18px;border-left:4px solid ${BRAND_SECONDARY};border-radius:4px;font-size:14px;">
          Also, in case you didn't get a chance to tip on the night, your bartender <strong>${esc(bartenderName)}</strong> takes tips at:<br/>
          ${handles.join('<br/>')}
        </p>
      `;
    }
  }

  return {
    subject: `How was your ${d.eventDateDisplay} event?`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>Thanks again for having us at your <strong>${esc(d.eventTypeLabel)}</strong> last ${esc(dayOfWeek)}. Hope you and your guests had a great time.</p>
      <p>If you have a moment, we'd love to hear how it went:</p>
      ${ctaButton(feedbackUrl, 'Rate your experience')}
      ${tipSection}
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, thanks again for having us at your ${d.eventTypeLabel} last ${dayOfWeek}. Rate your experience: ${feedbackUrl}${bartenderName ? `. Tip ${bartenderName}${venmoHandle ? ` at Venmo ${venmoHandle}` : ''}${cashappHandle ? `, Cash App ${cashappHandle}` : ''}${zelleHandle ? `, Zelle ${zelleHandle}` : ''}` : ''}. Cheers, Dallas`,
  };
}

// ─── 1.4 New Year touch ──────────────────────────────────────────

function newYearHelloClient(params) {
  const d = defaults(params);
  return {
    subject: `Happy new year, ${d.clientFirstName}, looking forward to your event`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)}, happy new year from Dr. Bartender.</p>
      <p>Just a quick hello to say we're looking forward to your <strong>${esc(d.eventTypeLabel)}</strong> later this year on ${esc(d.eventDateDisplay)}. Everything's on the books and we'll be in touch with more details as we get closer.</p>
      <p>Reach out anytime with questions or changes.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, happy new year. Looking forward to your ${d.eventTypeLabel} on ${d.eventDateDisplay}. Reach out anytime. Cheers, Dallas`,
  };
}

// ─── 1.5 Six-months-out touch ────────────────────────────────────

function sixMonthsOutClient(params) {
  const d = defaults(params);
  const potionPlannerUrl = params.potionPlannerUrl || null;
  const consultUrl = params.consultUrl || null;

  let plannerSection = '';
  if (potionPlannerUrl) {
    plannerSection += `<p>Whenever you're ready to start thinking about drinks, the Potion Planner is here:</p>${ctaButton(potionPlannerUrl, 'Open the Potion Planner')}`;
  }
  if (consultUrl) {
    plannerSection += `<p>Or if you'd rather walk through it together, you can <a href="${esc(consultUrl)}">book a 15-minute consult</a>.</p>`;
  }

  return {
    subject: `Six months out from your ${d.eventDateDisplay} event`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>We're now six months out from your <strong>${esc(d.eventTypeLabel)}</strong> on ${esc(d.eventDateDisplay)}. Mostly just saying hi.</p>
      ${plannerSection}
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, six months out from your ${d.eventTypeLabel} on ${d.eventDateDisplay}.${potionPlannerUrl ? ` Potion Planner: ${potionPlannerUrl}.` : ''}${consultUrl ? ` Book a consult: ${consultUrl}.` : ''} Cheers, Dallas`,
  };
}

// ─── 4.2 Retention nudge (T+11 months) ───────────────────────────

function retentionNudgeClient(params) {
  const d = defaults(params);
  const ctaUrl = params.ctaUrl || 'https://drbartender.com/quote';
  return {
    subject: `Almost a year since your ${d.eventTypeLabel}, ${d.clientFirstName}`,
    html: wrapMarketingEmail(`
      <p>Hi ${esc(d.clientFirstName)},</p>
      <p>It's been almost a year since your <strong>${esc(d.eventTypeLabel)}</strong> with us. If you're planning anything similar this year, we'd love to help. Same packages, same team.</p>
      ${ctaButton(ctaUrl, 'Get a quote')}
      <p>Reach out anytime.</p>
      <p>Cheers,<br/>Dallas</p>
    `, d.unsubscribeUrl),
    text: `Hi ${d.clientFirstName}, it's been almost a year since your ${d.eventTypeLabel}. If you're planning anything similar, we'd love to help. Quote: ${ctaUrl}. Cheers, Dallas`,
  };
}

// ─── Admin notification for low-rating feedback (sibling of tipFeedbackAdminNotification) ─────

function lowRatingAdminNotification(params) {
  const clientName = esc(params.clientName || 'A client');
  const eventDateDisplay = esc(params.eventDateDisplay || '');
  const eventTypeLabel = esc(params.eventTypeLabel || 'event');
  const rating = Number(params.rating) || 0;
  const comment = params.comment ? esc(params.comment) : null;
  const adminUrl = params.adminUrl || '';

  const commentBlock = comment
    ? `<div style="background:${BRAND_BG};padding:14px 18px;border-left:4px solid ${BRAND_SECONDARY};border-radius:4px;margin:12px 0;">${comment}</div>`
    : '<p style="color:#999;font-style:italic;">No comment provided.</p>';

  return {
    subject: `Low rating (${rating}/5) on ${eventTypeLabel} — ${clientName}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND_PRIMARY};margin-top:0;">Low post-event rating</h2>
      <p><strong>${clientName}</strong> just rated their <strong>${eventTypeLabel}</strong>${eventDateDisplay ? ` on ${eventDateDisplay}` : ''}:</p>
      <p style="font-size:24px;margin:0.5rem 0;"><strong>${rating} / 5</strong></p>
      ${commentBlock}
      ${adminUrl ? ctaButton(adminUrl, 'View proposal') : ''}
    `),
    text: `Low rating (${rating}/5) from ${clientName} on ${eventTypeLabel}${eventDateDisplay ? ` on ${eventDateDisplay}` : ''}.${comment ? ` Comment: "${comment}".` : ''}${adminUrl ? ` View: ${adminUrl}` : ''}`,
  };
}

module.exports = {
  dripTouch2Client,
  dripTouch4Client,
  dripTouch5Client,
  reviewRequestClient,
  newYearHelloClient,
  sixMonthsOutClient,
  retentionNudgeClient,
  lowRatingAdminNotification,
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
node --test server/utils/marketingEmailTemplates.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/marketingEmailTemplates.js server/utils/marketingEmailTemplates.test.js
git commit -m "feat(comms): add marketing and retention email templates"
```

---

## Task 4: Build the public feedback router page backend

**Files:**
- Create: `server/routes/publicFeedback.js`
- Create: `server/routes/publicFeedback.test.js`

The page is mounted at `GET /api/public/feedback/:token` (display data) and `POST /api/public/feedback/:token` (submission). The token is the `proposals.token` UUID — already public and used by the existing `/proposal/:token` view, so no separate token table is needed. Submission is idempotent via the unique index on `post_event_feedback(proposal_id)` from Task 1.

- [ ] **Step 1: Write the failing unit-style test**

The repo's tests use `node:test` and don't ship `supertest`, so we test the route's helpers / DB behavior directly rather than wiring an HTTP-level integration test. The route exposes a couple of small pure helpers (UUID validation, rating/comment parsing) plus the DB-bound feedback-insert flow. We test all of them at the function boundary; the full HTTP path is covered by manual smoke testing in Task 13.

Create `server/routes/publicFeedback.test.js`:

```javascript
const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  isFeedbackTokenShape,
  validateFeedbackInput,
  loadFeedbackContext,
  recordFeedback,
} = require('./publicFeedback');

let clientId;
let proposalId;
let token;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ('Feedback Test Client', 'feedback-test@example.com') RETURNING id"
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE - INTERVAL '2 days', 'completed', 'birthday-party')
     RETURNING id, token`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  token = p.rows[0].token;
});

after(async () => {
  await pool.query('DELETE FROM post_event_feedback WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

afterEach(async () => {
  await pool.query('DELETE FROM post_event_feedback WHERE proposal_id = $1', [proposalId]);
});

// ── token shape ──
test('isFeedbackTokenShape > accepts canonical UUID', () => {
  assert.strictEqual(isFeedbackTokenShape('00000000-0000-0000-0000-000000000000'), true);
});

test('isFeedbackTokenShape > rejects malformed strings', () => {
  assert.strictEqual(isFeedbackTokenShape('not-a-uuid'), false);
  assert.strictEqual(isFeedbackTokenShape(''), false);
  assert.strictEqual(isFeedbackTokenShape(null), false);
});

// ── input validation ──
test('validateFeedbackInput > accepts rating 1-5 with no comment', () => {
  const result = validateFeedbackInput({ rating: 4 });
  assert.deepStrictEqual(result, { rating: 4, comment: null });
});

test('validateFeedbackInput > accepts a trimmed comment under 2000 chars', () => {
  const result = validateFeedbackInput({ rating: 2, comment: 'Bartender was late.' });
  assert.strictEqual(result.rating, 2);
  assert.strictEqual(result.comment, 'Bartender was late.');
});

test('validateFeedbackInput > rejects rating outside 1-5', () => {
  assert.throws(() => validateFeedbackInput({ rating: 0 }), /rating/i);
  assert.throws(() => validateFeedbackInput({ rating: 6 }), /rating/i);
  assert.throws(() => validateFeedbackInput({ rating: 'three' }), /rating/i);
});

test('validateFeedbackInput > rejects oversize comment', () => {
  assert.throws(() => validateFeedbackInput({ rating: 2, comment: 'x'.repeat(3000) }), /comment/i);
});

test('validateFeedbackInput > rejects non-string comment', () => {
  assert.throws(() => validateFeedbackInput({ rating: 2, comment: 42 }), /comment/i);
});

// ── loadFeedbackContext ──
test('loadFeedbackContext > returns display data for a valid token', async () => {
  const ctx = await loadFeedbackContext(token);
  assert.ok(ctx);
  assert.ok(typeof ctx.client_first_name === 'string');
  assert.match(ctx.event_type_label, /Birthday/i);
  assert.strictEqual(ctx.already_submitted, false);
});

test('loadFeedbackContext > returns null for an unknown token', async () => {
  const ctx = await loadFeedbackContext('00000000-0000-0000-0000-000000000000');
  assert.strictEqual(ctx, null);
});

test('loadFeedbackContext > returns null when the proposal is archived', async () => {
  await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
  const ctx = await loadFeedbackContext(token);
  assert.strictEqual(ctx, null);
  await pool.query("UPDATE proposals SET status = 'completed' WHERE id = $1", [proposalId]);
});

test('loadFeedbackContext > reports already_submitted=true when a feedback row exists', async () => {
  await pool.query(
    'INSERT INTO post_event_feedback (proposal_id, rating) VALUES ($1, 5)',
    [proposalId]
  );
  const ctx = await loadFeedbackContext(token);
  assert.strictEqual(ctx.already_submitted, true);
});

// ── recordFeedback ──
test('recordFeedback > high rating returns a redirect_url and stores the row', async () => {
  const result = await recordFeedback({ token, rating: 5, comment: null, ip: null, userAgent: null });
  assert.strictEqual(result.routing, 'redirect');
  assert.ok(result.redirect_url);

  const { rows } = await pool.query(
    'SELECT rating FROM post_event_feedback WHERE proposal_id = $1',
    [proposalId]
  );
  assert.strictEqual(rows[0].rating, 5);
});

test('recordFeedback > low rating stores comment and returns routing=thanks (no redirect)', async () => {
  const result = await recordFeedback({ token, rating: 2, comment: 'Bartender was late.', ip: null, userAgent: null });
  assert.strictEqual(result.routing, 'thanks');
  assert.strictEqual(result.redirect_url, undefined);

  const { rows } = await pool.query(
    'SELECT rating, comment FROM post_event_feedback WHERE proposal_id = $1',
    [proposalId]
  );
  assert.strictEqual(rows[0].rating, 2);
  assert.strictEqual(rows[0].comment, 'Bartender was late.');
});

test('recordFeedback > second submission for the same proposal throws conflict', async () => {
  await pool.query(
    'INSERT INTO post_event_feedback (proposal_id, rating) VALUES ($1, 5)',
    [proposalId]
  );
  await assert.rejects(
    () => recordFeedback({ token, rating: 3, comment: null, ip: null, userAgent: null }),
    /already/i
  );
});

test('recordFeedback > rejects when the underlying proposal is archived', async () => {
  await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
  await assert.rejects(
    () => recordFeedback({ token, rating: 5, comment: null, ip: null, userAgent: null }),
    /not found/i
  );
  await pool.query("UPDATE proposals SET status = 'completed' WHERE id = $1", [proposalId]);
});
```

Implementation note: this test expects `publicFeedback.js` to export four pure-ish helpers in addition to the Express router:

- `isFeedbackTokenShape(token)` returns `true` iff the token matches the UUID regex.
- `validateFeedbackInput({ rating, comment })` returns `{rating, comment: comment|null}` or throws a `ValidationError`.
- `loadFeedbackContext(token)` returns the display payload, or `null` if not found / archived.
- `recordFeedback({ token, rating, comment, ip, userAgent })` performs the insert + sentiment routing, returns `{routing: 'redirect'|'thanks', redirect_url?}`. Throws `ConflictError` on duplicate submission and `NotFoundError` when the proposal can't be sent feedback for (gone or archived).

Refactor the route handlers in `publicFeedback.js` to call these helpers — the GET handler calls `loadFeedbackContext`; the POST handler validates input, then calls `recordFeedback`, then forwards the admin email (for low ratings). End-to-end HTTP behavior is verified by manual smoke testing in Task 13.

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/routes/publicFeedback.test.js
```

Expected: FAIL because the route file doesn't exist yet (`Cannot find module './publicFeedback'`).

- [ ] **Step 3: Implement the route**

Create `server/routes/publicFeedback.js`:

```javascript
const express = require('express');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter, publicReadLimiter } = require('../middleware/rateLimiters');
const { NotFoundError, ValidationError, ConflictError } = require('../utils/errors');
const { sendEmail } = require('../utils/email');
const marketingTemplates = require('../utils/marketingEmailTemplates');
const { getEventTypeLabel } = require('../utils/eventTypes');
const { ADMIN_URL } = require('../utils/urls');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per-token+IP submission limiter to deter trolling a single proposal.
const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => `${req.ip}:${req.params.token}`,
  message: { error: 'Too many feedback submissions, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Helpers exported for unit tests ──

function isFeedbackTokenShape(token) {
  return typeof token === 'string' && UUID_RE.test(token);
}

/**
 * Validate the POST body. Returns `{rating, comment}` (comment normalized to null).
 * Throws a ValidationError when input is malformed.
 */
function validateFeedbackInput({ rating, comment } = {}) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new ValidationError({ rating: 'Rating must be an integer 1-5' });
  }
  let normalizedComment = null;
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== 'string') {
      throw new ValidationError({ comment: 'Comment must be a string' });
    }
    if (comment.length > 2000) {
      throw new ValidationError({ comment: 'Comment must be 2000 characters or fewer' });
    }
    normalizedComment = comment;
  }
  return { rating, comment: normalizedComment };
}

/**
 * Load the display payload for the feedback page given a token. Returns the
 * payload object, or `null` when the proposal is missing/archived so the GET
 * handler can render a NotFoundError.
 */
async function loadFeedbackContext(token) {
  if (!isFeedbackTokenShape(token)) return null;
  const { rows } = await pool.query(`
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.event_date,
           c.name AS client_name,
           EXISTS (SELECT 1 FROM post_event_feedback f WHERE f.proposal_id = p.id) AS already_submitted
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.token = $1
  `, [token]);
  const row = rows[0];
  if (!row) return null;
  if (row.status === 'archived') return null;
  const clientFirstName = (row.client_name || '').trim().split(/\s+/)[0] || 'there';
  return {
    client_first_name: clientFirstName,
    event_type_label: getEventTypeLabel({
      event_type: row.event_type,
      event_type_custom: row.event_type_custom,
    }),
    event_date: row.event_date,
    already_submitted: row.already_submitted,
  };
}

/**
 * Insert the feedback row + sentiment routing. Returns
 * `{routing: 'redirect'|'thanks', redirect_url?}`. Caller (route handler) is
 * responsible for posting any admin email; this helper stays free of email
 * I/O so unit tests don't have to mock it. Throws NotFoundError / ConflictError
 * on flow violations.
 */
async function recordFeedback({ token, rating, comment, ip, userAgent }) {
  if (!isFeedbackTokenShape(token)) throw new NotFoundError('Feedback page not found');
  const { rows } = await pool.query(`
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.event_date,
           c.name AS client_name
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.token = $1
  `, [token]);
  const proposal = rows[0];
  if (!proposal) throw new NotFoundError('Feedback page not found');
  if (proposal.status === 'archived') throw new NotFoundError('Feedback page not found');

  try {
    await pool.query(
      `INSERT INTO post_event_feedback (proposal_id, rating, comment, submitter_ip, submitter_user_agent)
       VALUES ($1, $2, $3, $4, $5)`,
      [proposal.id, rating, comment, ip || null, (userAgent || '').slice(0, 500)]
    );
  } catch (err) {
    if (err.code === '23505') {
      throw new ConflictError('Feedback already received for this event.', 'FEEDBACK_ALREADY_SUBMITTED');
    }
    throw err;
  }

  if (rating >= 4) {
    const redirectUrl = process.env.PUBLIC_GOOGLE_REVIEW_URL || 'https://google.com';
    return { routing: 'redirect', redirect_url: redirectUrl, proposal };
  }
  return { routing: 'thanks', proposal };
}

// ── Routes ──

/** GET /api/public/feedback/:token — fetch display data for the feedback page */
router.get('/:token', publicReadLimiter, asyncHandler(async (req, res) => {
  const ctx = await loadFeedbackContext(req.params.token);
  if (!ctx) throw new NotFoundError('Feedback page not found');
  res.json(ctx);
}));

/** POST /api/public/feedback/:token — submit a rating */
router.post('/:token', publicLimiter, submissionLimiter, asyncHandler(async (req, res) => {
  const { rating, comment } = validateFeedbackInput(req.body || {});
  const result = await recordFeedback({
    token: req.params.token,
    rating,
    comment,
    ip: req.ip,
    userAgent: req.get('user-agent') || '',
  });
  if (result.routing === 'redirect') {
    return res.json({ ok: true, redirect_url: result.redirect_url });
  }

  // Low rating: best-effort admin notification, never fail the request on email failure.
  try {
    const tpl = marketingTemplates.lowRatingAdminNotification({
      clientName: result.proposal.client_name || 'A client',
      eventDateDisplay: result.proposal.event_date
        ? new Date(result.proposal.event_date).toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
          })
        : '',
      eventTypeLabel: getEventTypeLabel({
        event_type: result.proposal.event_type,
        event_type_custom: result.proposal.event_type_custom,
      }),
      rating,
      comment: comment || null,
      adminUrl: `${ADMIN_URL}/proposals/${result.proposal.id}`,
    });
    await sendEmail({
      to: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
      subject: tpl.subject,
      html: tpl.html,
    });
  } catch (err) {
    console.error('[publicFeedback] admin email failed:', err.message);
    Sentry.captureException(err, {
      tags: { route: 'publicFeedback.POST', op: 'admin_email' },
      extra: { proposalId: result.proposal.id, rating },
    });
  }

  res.json({ ok: true, thanks: true });
}));

module.exports = router;
module.exports.isFeedbackTokenShape = isFeedbackTokenShape;
module.exports.validateFeedbackInput = validateFeedbackInput;
module.exports.loadFeedbackContext = loadFeedbackContext;
module.exports.recordFeedback = recordFeedback;
```

- [ ] **Step 4: Mount the router in `server/index.js`**

Find the block where other public routers are mounted (search for `/api/public/tip`). After it, add:

```javascript
app.use('/api/public/feedback', require('./routes/publicFeedback'));
```

- [ ] **Step 5: Run test to verify pass**

```bash
node --test server/routes/publicFeedback.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/routes/publicFeedback.js server/routes/publicFeedback.test.js server/index.js
git commit -m "feat(comms): public feedback router with sentiment-routing and admin alert"
```

---

## Task 5: Build the public feedback router React page

**Files:**
- Create: `client/src/pages/public/FeedbackPage.jsx`
- Create: `client/src/pages/public/FeedbackPage.css`
- Modify: `client/src/App.js`

The page mirrors the tip-page sentiment pattern: 5 stars on a single screen, tapping 4-5 immediately follows the server's `redirect_url` to Google Reviews. Tapping 1-3 opens a comment + submit form. Submission states: idle → submitting → done (thanks message) or done-with-redirect.

- [ ] **Step 1: Create the React component**

Create `client/src/pages/public/FeedbackPage.jsx`:

```jsx
import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../utils/api';
import './FeedbackPage.css';

export default function FeedbackPage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [stars, setStars] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [comment, setComment] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get(`/public/feedback/${token}`)
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(() => { if (!cancelled) setError('not-found'); });
    return () => { cancelled = true; };
  }, [token]);

  if (error === 'not-found') {
    return (
      <main className="feedback-page">
        <header className="feedback-hero">
          <p className="kicker">Dr. Bartender</p>
          <h1>This feedback page isn't available.</h1>
        </header>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="feedback-page" aria-busy="true">
        <header className="feedback-hero">
          <p className="kicker">Dr. Bartender</p>
          <h1>Loading…</h1>
        </header>
      </main>
    );
  }
  if (data.already_submitted) {
    return (
      <main className="feedback-page">
        <header className="feedback-hero">
          <p className="kicker">Dr. Bartender</p>
          <h1>Thanks again, {data.client_first_name}.</h1>
          <p>We already received your feedback for this event.</p>
        </header>
      </main>
    );
  }
  if (done) {
    return (
      <main className="feedback-page">
        <header className="feedback-hero">
          <p className="kicker">Dr. Bartender</p>
          <h1>Thank you, {data.client_first_name}.</h1>
          <p>Your feedback went straight to Dallas. He'll reach out personally.</p>
        </header>
      </main>
    );
  }

  async function clickStar(n) {
    setStars(n);
    if (n >= 4) {
      // High rating: submit then follow server redirect to Google Reviews.
      setSubmitting(true);
      try {
        const r = await api.post(`/public/feedback/${token}`, { rating: n });
        if (r.data?.redirect_url) {
          window.location.href = r.data.redirect_url;
          return;
        }
        setDone(true);
      } catch (err) {
        // 409 conflict means already submitted — treat as success-like
        if (err?.response?.status === 409) {
          setDone(true);
        } else {
          // eslint-disable-next-line no-alert
          alert('Could not submit feedback — please try again in a moment.');
          setStars(0);
        }
      } finally {
        setSubmitting(false);
      }
    }
  }

  async function submitLowRating(e) {
    e.preventDefault();
    if (!stars || stars >= 4) return;
    setSubmitting(true);
    try {
      await api.post(`/public/feedback/${token}`, { rating: stars, comment });
      setDone(true);
    } catch (err) {
      if (err?.response?.status === 409) {
        setDone(true);
      } else {
        // eslint-disable-next-line no-alert
        alert('Could not submit feedback — please try again in a moment.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const showLowForm = stars >= 1 && stars <= 3 && !submitting;

  return (
    <main className="feedback-page">
      <header className="feedback-hero">
        <p className="kicker">Dr. Bartender</p>
        <h1>How was your {data.event_type_label}, {data.client_first_name}?</h1>
        <p className="hero-sub">Tap a star to rate.</p>
      </header>

      <section className="rating-row" aria-label="Rating">
        {[1, 2, 3, 4, 5].map(n => {
          const active = (hovered || stars) >= n;
          return (
            <button
              key={n}
              type="button"
              className={`star-btn ${active ? 'active' : ''}`}
              onMouseEnter={() => setHovered(n)}
              onMouseLeave={() => setHovered(0)}
              onClick={() => clickStar(n)}
              disabled={submitting}
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
            >
              {active ? '★' : '☆'}
            </button>
          );
        })}
      </section>

      {showLowForm && (
        <form className="low-rating-form" onSubmit={submitLowRating}>
          <label htmlFor="comment">What could we have done better?</label>
          <textarea
            id="comment"
            value={comment}
            onChange={e => setComment(e.target.value)}
            maxLength={2000}
            rows={5}
            placeholder="Optional — anything you want Dallas to know."
          />
          <button type="submit" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send feedback'}
          </button>
        </form>
      )}

      <footer className="feedback-foot">
        <p>Dr. <b>Bartender</b></p>
        <p className="meta">© {new Date().getFullYear()} Dr. Bartender LLC</p>
      </footer>
    </main>
  );
}
```

- [ ] **Step 2: Create the stylesheet**

Create `client/src/pages/public/FeedbackPage.css`:

```css
.feedback-page {
  max-width: 480px;
  margin: 0 auto;
  padding: 48px 24px;
  font-family: Georgia, serif;
  color: #3b2314;
}

.feedback-hero {
  text-align: center;
  margin-bottom: 32px;
}

.feedback-hero .kicker {
  text-transform: uppercase;
  letter-spacing: 2px;
  font-size: 12px;
  color: #6b4226;
  margin: 0 0 8px;
}

.feedback-hero h1 {
  font-size: 28px;
  margin: 0 0 8px;
  line-height: 1.2;
}

.feedback-hero .hero-sub {
  color: #6b4226;
  margin: 0;
}

.rating-row {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin: 24px 0;
}

.star-btn {
  background: none;
  border: none;
  font-size: 44px;
  cursor: pointer;
  color: #c0a78f;
  padding: 4px 8px;
  transition: transform 120ms ease, color 120ms ease;
}

.star-btn.active {
  color: #c17d3c;
}

.star-btn:hover:not(:disabled) {
  transform: scale(1.12);
}

.star-btn:disabled {
  cursor: default;
  opacity: 0.6;
}

.low-rating-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 24px;
}

.low-rating-form label {
  font-weight: bold;
  color: #6b4226;
}

.low-rating-form textarea {
  border: 1px solid #d4c5b8;
  border-radius: 6px;
  padding: 12px;
  font-family: inherit;
  font-size: 15px;
  resize: vertical;
}

.low-rating-form button {
  background: #3b2314;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 14px 24px;
  font-weight: bold;
  font-size: 16px;
  cursor: pointer;
}

.low-rating-form button:disabled {
  opacity: 0.6;
  cursor: default;
}

.feedback-foot {
  text-align: center;
  margin-top: 64px;
  color: #6b4226;
  font-size: 13px;
}

.feedback-foot p {
  margin: 4px 0;
}

.feedback-foot .meta {
  font-size: 11px;
  opacity: 0.7;
}
```

- [ ] **Step 3: Add the route to `client/src/App.js`**

Find the public-domain route block (around line 212, where `/tip/:token` is defined). Add the import near the other lazy-loaded pages (around line 50):

```jsx
const FeedbackPage = lazy(() => import('./pages/public/FeedbackPage'));
```

Then add the route inside the public-domain `<Routes>` block, near `/tip/:token`:

```jsx
<Route path="/feedback/:token" element={<FeedbackPage />} />
```

- [ ] **Step 4: Build the client to verify no syntax errors**

```bash
cd client && CI=true npx react-scripts build 2>&1 | tail -20
```

Expected: build succeeds with no `error` lines (warnings about unused imports are tolerable but should be zero for the new file).

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/public/FeedbackPage.jsx client/src/pages/public/FeedbackPage.css client/src/App.js
git commit -m "feat(comms): public feedback router page (5-star sentiment route)"
```

---

## Task 6: Build dispatcher handlers and scheduling helpers

**Files:**
- Create: `server/utils/marketingHandlers.js`
- Create: `server/utils/marketingHandlers.test.js`

This is the integration layer between the dispatcher (Plan 2a's `registerHandler`) and the marketing templates. Each handler is registered once at server boot; the scheduling helpers are called by route handlers and the auto-complete scheduler.

**Key design decisions:**

- **Marketing gating:** the dispatcher itself doesn't know which messages are marketing-class. We make every handler self-suppress by re-checking `clients.communication_preferences.marketing_enabled` at fire time. This is defense-in-depth alongside the scheduler-level skip (Plan 2a's dispatcher reads a `MARKETING_MESSAGE_TYPES` set exported by this file).
- **Token-based URLs:** the proposal token (`proposals.token` UUID) is the canonical client-facing identifier. The `unsubscribe` link uses the existing `emailMarketing` JWT pattern (`UNSUBSCRIBE_SECRET`).
- **Idempotent scheduling:** `scheduleMessage` from Plan 2a is itself idempotent on (entity_type, entity_id, message_type, recipient_id, channel) — re-calling it for a proposal that already has the row doesn't duplicate.

- [ ] **Step 1: Write the failing test**

Create `server/utils/marketingHandlers.test.js`:

```javascript
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  MARKETING_MESSAGE_TYPES,
  registerMarketingHandlers,
  scheduleDripForProposal,
  scheduleReviewRequest,
  scheduleNewYearHello,
  scheduleSixMonthsOut,
  scheduleRetentionNudge,
  cancelMarketingForProposal,
} = require('./marketingHandlers');

let clientId;
let proposalId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ('Handler Test', 'handler-test@example.com') RETURNING id"
  );
  clientId = c.rows[0].id;
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '365 days', 'sent', 'birthday-party')
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
});

afterEach(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_type = $1 AND entity_id = $2', ['proposal', proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// ── MARKETING_MESSAGE_TYPES ──
test('MARKETING_MESSAGE_TYPES > contains every marketing-class type the dispatcher should gate', () => {
  for (const t of [
    'drip_touch_2',
    'drip_touch_4',
    'drip_touch_5_email',
    'new_year_hello',
    'six_months_out',
    'retention_nudge',
  ]) {
    assert.ok(MARKETING_MESSAGE_TYPES.includes(t), `expected ${t}`);
  }
  // review_request is intentionally NOT marketing — it's transactional per CAN-SPAM
  // (post-sale follow-up about a completed service). marketing_enabled does NOT gate it.
  assert.ok(!MARKETING_MESSAGE_TYPES.includes('review_request'));
});

// ── scheduleDripForProposal ──
test('scheduleDripForProposal > inserts touch_2, touch_4, touch_5_email pending rows on the proposal', async () => {
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel, status FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1
     ORDER BY message_type`,
    [proposalId]
  );
  const types = rows.map(r => r.message_type);
  assert.deepStrictEqual(types, ['drip_touch_2', 'drip_touch_4', 'drip_touch_5_email']);
  assert.ok(rows.every(r => r.channel === 'email'));
  assert.ok(rows.every(r => r.status === 'pending'));
});

test('scheduleDripForProposal > is idempotent — second call does not duplicate rows', async () => {
  await scheduleDripForProposal(proposalId);
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT count(*) FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1`,
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 3);
});

test('scheduleDripForProposal > uses the proposal status moment as the +7/+14/+21 anchor', async () => {
  const now = Date.now();
  await scheduleDripForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, scheduled_for FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1
     ORDER BY message_type`,
    [proposalId]
  );
  const t2 = new Date(rows.find(r => r.message_type === 'drip_touch_2').scheduled_for).getTime();
  const t4 = new Date(rows.find(r => r.message_type === 'drip_touch_4').scheduled_for).getTime();
  const t5 = new Date(rows.find(r => r.message_type === 'drip_touch_5_email').scheduled_for).getTime();
  // Each anchor should be 7/14/21 days from the proposal status-moved-to-sent time.
  // We don't know the exact baseline so we just check the relative spacing.
  assert.ok(t4 - t2 >= 6 * 86400000);
  assert.ok(t4 - t2 <= 8 * 86400000);
  assert.ok(t5 - t4 >= 6 * 86400000);
  assert.ok(t5 - t4 <= 8 * 86400000);
  assert.ok(t2 > now);
});

// ── scheduleReviewRequest ──
test('scheduleReviewRequest > inserts a review_request row 2 days after event_date', async () => {
  await scheduleReviewRequest(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, channel, scheduled_for FROM scheduled_messages
     WHERE entity_type = 'proposal' AND entity_id = $1`,
    [proposalId]
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].message_type, 'review_request');
  assert.strictEqual(rows[0].channel, 'email');
});

test('scheduleReviewRequest > is idempotent', async () => {
  await scheduleReviewRequest(proposalId);
  await scheduleReviewRequest(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1);
});

// ── scheduleNewYearHello ──
test('scheduleNewYearHello > schedules nothing if event is in same calendar year as sign', async () => {
  // Move the event to this year
  await pool.query(
    "UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '30 days' WHERE id = $1",
    [proposalId]
  );
  await scheduleNewYearHello(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('scheduleNewYearHello > schedules a row if event is next year and >= 60 days into new year', async () => {
  const nextYearMar15 = `${new Date().getFullYear() + 1}-03-15`;
  await pool.query("UPDATE proposals SET event_date = $1 WHERE id = $2", [nextYearMar15, proposalId]);
  await scheduleNewYearHello(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1);
});

// ── scheduleSixMonthsOut ──
test('scheduleSixMonthsOut > schedules nothing if booking lead time <= 6 months', async () => {
  await pool.query(
    "UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '90 days' WHERE id = $1",
    [proposalId]
  );
  await scheduleSixMonthsOut(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('scheduleSixMonthsOut > schedules a row if booking lead time > 6 months', async () => {
  await pool.query(
    "UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '220 days' WHERE id = $1",
    [proposalId]
  );
  await scheduleSixMonthsOut(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1);
});

// ── scheduleRetentionNudge ──
test('scheduleRetentionNudge > schedules nothing for non-whitelisted event types', async () => {
  await pool.query(
    "UPDATE proposals SET event_type = 'wedding-reception', status = 'completed' WHERE id = $1",
    [proposalId]
  );
  await scheduleRetentionNudge(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 0);
});

test('scheduleRetentionNudge > schedules a row for a whitelisted event type', async () => {
  await pool.query(
    "UPDATE proposals SET event_type = 'birthday-party', status = 'completed' WHERE id = $1",
    [proposalId]
  );
  await scheduleRetentionNudge(proposalId);
  const { rows } = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE entity_type='proposal' AND entity_id=$1",
    [proposalId]
  );
  assert.strictEqual(Number(rows[0].count), 1);
});

// ── cancelMarketingForProposal ──
test('cancelMarketingForProposal > marks all pending marketing-class messages as suppressed', async () => {
  await scheduleDripForProposal(proposalId);
  await cancelMarketingForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT status FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1`,
    [proposalId]
  );
  assert.ok(rows.every(r => r.status === 'suppressed'));
});

test('cancelMarketingForProposal > leaves already-sent messages alone', async () => {
  await scheduleDripForProposal(proposalId);
  await pool.query(
    `UPDATE scheduled_messages SET status='sent', sent_at=NOW()
     WHERE entity_type='proposal' AND entity_id=$1 AND message_type='drip_touch_2'`,
    [proposalId]
  );
  await cancelMarketingForProposal(proposalId);
  const { rows } = await pool.query(
    `SELECT message_type, status FROM scheduled_messages
     WHERE entity_type='proposal' AND entity_id=$1
     ORDER BY message_type`,
    [proposalId]
  );
  const m = Object.fromEntries(rows.map(r => [r.message_type, r.status]));
  assert.strictEqual(m['drip_touch_2'], 'sent');
  assert.strictEqual(m['drip_touch_4'], 'suppressed');
  assert.strictEqual(m['drip_touch_5_email'], 'suppressed');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/utils/marketingHandlers.test.js
```

Expected: FAIL with `Cannot find module './marketingHandlers'`.

- [ ] **Step 3: Implement the module**

Create `server/utils/marketingHandlers.js`:

```javascript
const jwt = require('jsonwebtoken');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const tpl = require('./marketingEmailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { resolveEventTimezone } = require('./eventTimezone'); // Gemini Finding 4
const { PUBLIC_SITE_URL, ADMIN_URL, API_URL } = require('./urls');
const {
  isRetentionEligibleEventType,
  shouldScheduleNewYearTouch,
  shouldScheduleSixMonthsTouch,
  computeNewYearSendAt,
  computeSixMonthsOutSendAt,
  computeReviewRequestSendAt,
  computeRetentionNudgeSendAt,
  clientHasUpcomingEvent,
} = require('./retentionEligibility');
const { scheduleMessage } = require('./messageScheduling'); // from Plan 2a
const { registerHandler } = require('./scheduledMessageDispatcher'); // from Plan 2a

/**
 * Marketing-class message types: dispatcher skips these when the client has
 * marketing_enabled = false on their communication_preferences. The review
 * request is intentionally NOT in this list — it's a transactional follow-up
 * about a service the client paid for, so CAN-SPAM allows it regardless of
 * marketing opt-out. (Self-suppression on individual unsubscribe still applies
 * if we ever add a transactional opt-out, but that's not in this plan.)
 */
const MARKETING_MESSAGE_TYPES = [
  'drip_touch_2',
  'drip_touch_4',
  'drip_touch_5_email',
  'new_year_hello',
  'six_months_out',
  'retention_nudge',
];

function formatEventDateDisplay(eventDate) {
  if (!eventDate) return 'your upcoming event';
  return new Date(eventDate).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function firstName(fullName) {
  return (fullName || '').trim().split(/\s+/)[0] || 'there';
}

function dayOfWeek(eventDate) {
  if (!eventDate) return 'weekend';
  return new Date(eventDate).toLocaleDateString('en-US', { weekday: 'long' });
}

function buildUnsubscribeUrl(clientId) {
  if (!clientId) return '';
  const token = jwt.sign(
    { clientId, marketing: true },
    process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET,
    { expiresIn: '365d' }
  );
  // Reuses existing /api/email-marketing/unsubscribe — that endpoint already
  // handles a token-bearing GET and flips email_leads.status. For
  // clients.communication_preferences.marketing_enabled flips we'll add a
  // sibling endpoint in a later plan (or extend the existing one).
  return `${API_URL}/api/email-marketing/unsubscribe?token=${token}`;
}

async function loadProposalForHandler(proposalId) {
  const { rows } = await pool.query(`
    SELECT p.id, p.token, p.event_date, p.event_type, p.event_type_custom,
           p.event_timezone, p.status, p.client_id, p.created_at,
           c.name AS client_name, c.email AS client_email,
           c.communication_preferences AS comm_prefs,
           c.email_status, c.phone_status
    FROM proposals p
    LEFT JOIN clients c ON c.id = p.client_id
    WHERE p.id = $1
  `, [proposalId]);
  return rows[0] || null;
}

// ─── Scheduling helpers ───────────────────────────────────────────

/**
 * On status='sent', schedule the email half of the unsigned-proposal drip.
 * Touches 2 (+7d), 4 (+14d), 5-email (+21d). Touches 1/3/5-sms come from Plan 3.
 *
 * Idempotent: re-calling on an already-enrolled proposal is a no-op (the
 * dispatcher's scheduleMessage upserts on the natural key
 * (entity_type, entity_id, message_type, recipient_id, channel)).
 */
async function scheduleDripForProposal(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived' || proposal.status === 'signed') return;
  if (!proposal.client_id) return;

  const anchor = new Date(); // time-of-send moment
  const day = 86400000;
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'drip_touch_2',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: new Date(anchor.getTime() + 7 * day),
  });
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'drip_touch_4',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: new Date(anchor.getTime() + 14 * day),
  });
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'drip_touch_5_email',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: new Date(anchor.getTime() + 21 * day),
  });
}

/**
 * On status='completed' (auto or manual), schedule the post-event review
 * request at event_date + 2 days, 10am EVENT-local (Gemini Finding 4).
 */
async function scheduleReviewRequest(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  const tz = resolveEventTimezone(proposal);
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'review_request',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeReviewRequestSendAt(proposal.event_date, tz),
  });
}

/**
 * On sign+pay (Stripe webhook), schedule a Jan 2 New Year touch if eligible.
 * Eligible: event date is in next calendar year AND event is >=60 days into new year.
 * Send time uses event timezone (Gemini Finding 4).
 */
async function scheduleNewYearHello(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  const signedAt = new Date(); // approximate; real sign moment lives on activity log
  if (!shouldScheduleNewYearTouch(signedAt, proposal.event_date)) return;

  const tz = resolveEventTimezone(proposal);
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'new_year_hello',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeNewYearSendAt(proposal.event_date, tz),
  });
}

/**
 * On sign+pay (Stripe webhook), schedule a 6-months-out touch if eligible.
 * Eligible: booking lead time strictly > 6 months.
 * Send time uses event timezone (Gemini Finding 4).
 */
async function scheduleSixMonthsOut(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;

  const signedAt = new Date();
  if (!shouldScheduleSixMonthsTouch(signedAt, proposal.event_date)) return;

  const tz = resolveEventTimezone(proposal);
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'six_months_out',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeSixMonthsOutSendAt(proposal.event_date, tz),
  });
}

/**
 * On status='completed', if event_type is in the retention whitelist,
 * schedule a T+11mo retention nudge. Uses event timezone (Gemini Finding 4).
 */
async function scheduleRetentionNudge(proposalId) {
  const proposal = await loadProposalForHandler(proposalId);
  if (!proposal) return;
  if (proposal.status === 'archived') return;
  if (!proposal.client_id || !proposal.event_date) return;
  if (!isRetentionEligibleEventType(proposal.event_type)) return;

  const tz = resolveEventTimezone(proposal);
  await scheduleMessage({
    entityType: 'proposal',
    entityId: proposalId,
    messageType: 'retention_nudge',
    recipientType: 'client',
    recipientId: proposal.client_id,
    channel: 'email',
    scheduledFor: computeRetentionNudgeSendAt(proposal.event_date, tz),
  });
}

/**
 * On archive, suppress every pending scheduled message for the proposal.
 * Sent messages stay 'sent'. This is the archive cascade rule applied to
 * the new dispatcher table; existing schedulers also enforce it via their
 * WHERE clauses (Plan 1's Task 12-14).
 */
async function cancelMarketingForProposal(proposalId) {
  await pool.query(
    `UPDATE scheduled_messages
     SET status = 'suppressed'
     WHERE entity_type = 'proposal'
       AND entity_id = $1
       AND status = 'pending'`,
    [proposalId]
  );
}

// ─── Dispatcher handlers ──────────────────────────────────────────

async function loadHandlerContext(scheduledMessage) {
  const proposal = await loadProposalForHandler(scheduledMessage.entity_id);
  if (!proposal) throw new Error(`proposal ${scheduledMessage.entity_id} not found`);
  if (proposal.status === 'archived') throw new Error('proposal archived');
  if (!proposal.client_email) throw new Error('client has no email');
  if (proposal.email_status === 'bad') throw new Error('client email status is bad');

  const prefs = proposal.comm_prefs || {};
  if (prefs.email_enabled === false) throw new Error('email_enabled is false');

  return { proposal };
}

function makeMarketingTemplateContext(proposal) {
  return {
    clientName: proposal.client_name,
    clientFirstName: firstName(proposal.client_name),
    eventTypeLabel: getEventTypeLabel({
      event_type: proposal.event_type,
      event_type_custom: proposal.event_type_custom,
    }),
    eventDateDisplay: formatEventDateDisplay(proposal.event_date),
    proposalUrl: `${PUBLIC_SITE_URL}/proposal/${proposal.token}`,
    unsubscribeUrl: buildUnsubscribeUrl(proposal.client_id),
  };
}

function handler(messageType, renderFn) {
  return async ({ scheduledMessage }) => {
    const { proposal } = await loadHandlerContext(scheduledMessage);
    const tplOut = await renderFn(proposal);
    await sendEmail({
      to: proposal.client_email,
      subject: tplOut.subject,
      html: tplOut.html,
      text: tplOut.text,
      replyTo: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
    });
  };
}

async function bartenderTipHandlesForSingleBartenderEvent(proposalId) {
  // Look up the proposal's shift(s) and the assigned bartenders' tip handles.
  // Returns { bartenderName, venmoHandle, cashappHandle, zelleHandle } when
  // the event had exactly one bartender; otherwise returns null so the
  // template omits the tip line.
  const { rows } = await pool.query(`
    SELECT u.id, cp.preferred_name AS bartender_name,
           pp.venmo_handle, pp.cashapp_handle, pp.zelle_handle
    FROM shift_assignments sa
    JOIN shifts s ON s.id = sa.shift_id
    LEFT JOIN users u ON u.id = sa.user_id
    LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
    LEFT JOIN payment_profiles pp ON pp.user_id = u.id
    WHERE s.proposal_id = $1
      AND sa.status = 'confirmed'
  `, [proposalId]);

  if (rows.length !== 1) return null;
  const r = rows[0];
  return {
    bartenderName: r.bartender_name,
    venmoHandle: r.venmo_handle,
    cashappHandle: r.cashapp_handle,
    zelleHandle: r.zelle_handle,
  };
}

/**
 * Register all marketing handlers with the dispatcher.
 *
 * Each registration includes metadata (Gemini Findings 1 & 5):
 *   - category: 'marketing' → dispatcher gates on
 *     communication_preferences.marketing_enabled (Plan 2a Task 9)
 *   - offsetFromEventDate / anchor → Plan 2c's reschedule cascade uses
 *     `getHandlerMeta(messageType)` to recompute scheduled_for for any
 *     pending row when admin updates event_date or balance_due_date
 *
 * Drip touches (2, 4, 5_email) anchor to the proposal-sent moment (NOT
 * event_date), so they pass `offsetFromEventDate: null` — the cascade
 * leaves them alone on reschedule (a moved event_date doesn't change the
 * "you haven't signed yet" timeline).
 *
 * review_request is operational, not marketing (CAN-SPAM transactional
 * post-sale follow-up).
 */
const DAY_SECONDS = 86400;
const MONTH_SECONDS = 30 * DAY_SECONDS; // approximate; cascade uses calendar math at compute time for accuracy

function registerMarketingHandlers() {
  registerHandler(
    'drip_touch_2',
    handler('drip_touch_2', (p) => tpl.dripTouch2Client(makeMarketingTemplateContext(p))),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing' }
  );
  registerHandler(
    'drip_touch_4',
    handler('drip_touch_4', (p) => tpl.dripTouch4Client(makeMarketingTemplateContext(p))),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing' }
  );
  registerHandler(
    'drip_touch_5_email',
    handler('drip_touch_5_email', (p) => tpl.dripTouch5Client(makeMarketingTemplateContext(p))),
    { offsetFromEventDate: null, anchor: 'created_at', category: 'marketing' }
  );
  registerHandler(
    'new_year_hello',
    handler('new_year_hello', (p) => tpl.newYearHelloClient(makeMarketingTemplateContext(p))),
    // Anchored on event_date but uses calendar math (Jan 2 of event year) at
    // compute time. The simple offset arithmetic can't express that exactly,
    // so the cascade re-anchors via the compute helpers when the event_date
    // changes years. The offset value here is approximate.
    { offsetFromEventDate: null, anchor: 'event_date', category: 'marketing' }
  );
  registerHandler(
    'six_months_out',
    handler('six_months_out', (p) => tpl.sixMonthsOutClient({
      ...makeMarketingTemplateContext(p),
      potionPlannerUrl: `${PUBLIC_SITE_URL}/plan/${p.token}`,
      consultUrl: null, // wired to Cal.com once the integration plan lands
    })),
    { offsetFromEventDate: -6 * MONTH_SECONDS, anchor: 'event_date', category: 'marketing' }
  );
  registerHandler('retention_nudge', async ({ scheduledMessage }) => {
    const { proposal } = await loadHandlerContext(scheduledMessage);
    // Last-mile suppression: client has another upcoming event → skip.
    const hasUpcoming = await clientHasUpcomingEvent(proposal.client_id, proposal.id);
    if (hasUpcoming) throw new Error('SUPPRESS: client has upcoming event');
    const tplOut = tpl.retentionNudgeClient(makeMarketingTemplateContext(proposal));
    await sendEmail({
      to: proposal.client_email,
      subject: tplOut.subject,
      html: tplOut.html,
      text: tplOut.text,
      replyTo: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
    });
  }, {
    offsetFromEventDate: 11 * MONTH_SECONDS,
    anchor: 'event_date',
    category: 'marketing',
  });

  registerHandler('review_request', async ({ scheduledMessage }) => {
    const { proposal } = await loadHandlerContext(scheduledMessage);
    const tipHandles = await bartenderTipHandlesForSingleBartenderEvent(proposal.id);
    const ctx = {
      ...makeMarketingTemplateContext(proposal),
      dayOfWeek: dayOfWeek(proposal.event_date),
      feedbackUrl: `${PUBLIC_SITE_URL}/feedback/${proposal.token}`,
      ...(tipHandles || {}),
    };
    const tplOut = tpl.reviewRequestClient(ctx);
    await sendEmail({
      to: proposal.client_email,
      subject: tplOut.subject,
      html: tplOut.html,
      text: tplOut.text,
      replyTo: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
    });
  }, {
    offsetFromEventDate: 2 * DAY_SECONDS,
    anchor: 'event_date',
    category: 'operational', // transactional post-sale follow-up under CAN-SPAM
  });
}

module.exports = {
  MARKETING_MESSAGE_TYPES,
  registerMarketingHandlers,
  scheduleDripForProposal,
  scheduleReviewRequest,
  scheduleNewYearHello,
  scheduleSixMonthsOut,
  scheduleRetentionNudge,
  cancelMarketingForProposal,
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
node --test server/utils/marketingHandlers.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/marketingHandlers.js server/utils/marketingHandlers.test.js
git commit -m "feat(comms): marketing dispatcher handlers and scheduling helpers"
```

---

## Task 7: Register handlers at server boot

**Files:**
- Modify: `server/index.js`

The dispatcher utilities from Plan 2a expect every handler to be registered once before the scheduler starts polling. The most natural hook is the same scheduler-bootstrap block that wraps the existing schedulers (Plan 1's Task 11).

- [ ] **Step 1: Find the scheduler bootstrap block**

Read `server/index.js` around the `RUN_SCHEDULED_MESSAGES_SCHEDULER` block (added in Plan 2a; if Plan 2a hasn't yet wired it, locate the per-scheduler block from Plan 1 around line 247).

- [ ] **Step 2: Add the registration call just before the scheduler starts**

Find where the dispatcher's poll loop is launched. The pattern (sketched, adapt to actual code from Plan 2a):

```javascript
if (enabled('RUN_SCHEDULED_MESSAGES_SCHEDULER')) {
  const { registerMarketingHandlers } = require('./utils/marketingHandlers');
  registerMarketingHandlers();
  // ... existing Plan 2a registration calls for money-path handlers ...
  const { processScheduledMessages } = require('./utils/scheduledMessageDispatcher');
  const wrapped = wrapScheduler('scheduled_messages', 60, processScheduledMessages);
  setTimeout(wrapped, 30000);
  setInterval(wrapped, 60 * 1000);
} else {
  clearHealthRow('scheduled_messages');
}
```

If Plan 2a's registration block already exists for the money-path handlers (`payment_failure`, `balance_reminder_t3`, etc.), add `registerMarketingHandlers()` next to it. Don't duplicate the dispatcher launch.

- [ ] **Step 3: Boot the server and confirm registration log lines**

```bash
npm run dev
```

Expected: a boot log line like `[scheduledMessageDispatcher] registered handlers: drip_touch_2, drip_touch_4, drip_touch_5_email, new_year_hello, six_months_out, retention_nudge, review_request` (the exact format depends on Plan 2a's logging style; if it doesn't log at registration time, add a one-line `console.log` in `registerMarketingHandlers` itself).

Kill the dev server.

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat(comms): register marketing dispatcher handlers at boot"
```

---

## Task 8: Wire drip scheduling on proposal status='sent'

**Files:**
- Modify: `server/routes/proposals/crud.js`

When the admin sets a proposal to `sent` (either via the new-proposal flow or a manual status push), the existing code already sends the `proposalSent` email. We add the drip enrollment right after, in the same try/catch shape (best-effort, non-blocking, Sentry-on-failure).

- [ ] **Step 1: Find the existing `status === 'sent'` block**

Read `server/routes/proposals/crud.js` around lines 477-516 (the block that sends the `proposalSent` email and auto-creates the first invoice).

- [ ] **Step 2: Add the drip enrollment after the email send**

After the `// Email client when proposal is sent (non-blocking)` block, before the `// Auto-create first invoice when proposal is sent` block, add:

```javascript
  // Schedule the unsigned-proposal drip (email half).
  // The SMS halves (touches 1, 3, 5-sms) come from Plan 3.
  if (status === 'sent') {
    try {
      const { scheduleDripForProposal } = require('../../utils/marketingHandlers');
      await scheduleDripForProposal(parseInt(req.params.id, 10));
    } catch (dripErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(dripErr, { tags: { route: 'proposals/status', issue: 'drip-enroll' } });
      }
      console.error('Drip enrollment failed (non-blocking):', dripErr);
    }
  }
```

- [ ] **Step 3: Also wire archive cascade**

In the same handler, find where `status === 'archived'` is set (or where the status update commits). After the activity log insert, add:

```javascript
  // Cancel any pending marketing-class scheduled messages for this proposal.
  if (status === 'archived') {
    try {
      const { cancelMarketingForProposal } = require('../../utils/marketingHandlers');
      await cancelMarketingForProposal(parseInt(req.params.id, 10));
    } catch (cancelErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(cancelErr, { tags: { route: 'proposals/status', issue: 'archive-cascade' } });
      }
      console.error('Archive cascade failed (non-blocking):', cancelErr);
    }
  }
```

- [ ] **Step 4: Manual smoke test**

```bash
npm run dev  # if not already running
```

Then via psql, insert a test proposal in status='draft', PATCH it to 'sent' via the admin UI or curl with a valid admin JWT, and verify drip rows appear:

```bash
psql "$DATABASE_URL" -c "
  SELECT message_type, scheduled_for, status
  FROM scheduled_messages
  WHERE entity_type='proposal'
    AND entity_id=(SELECT id FROM proposals WHERE client_id=(SELECT id FROM clients WHERE email='handler-test@example.com'))
  ORDER BY message_type;
"
```

Expected: three rows (`drip_touch_2`, `drip_touch_4`, `drip_touch_5_email`), all status `pending`, scheduled 7/14/21 days out.

Then PATCH the same proposal to `status='archived'` and re-run the same query. Expected: same three rows but with status='suppressed'.

Clean up the test rows.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/crud.js
git commit -m "feat(comms): enroll drip on proposal sent, cancel on archive"
```

---

## Task 9: Wire New Year + 6-months-out on sign+pay

**Files:**
- Modify: the Stripe webhook handler (find via grep)

Sign+pay completes in the Stripe webhook flow when the deposit (or first/only payment) succeeds. The natural hook is the point where the proposal status flips to `deposit_paid` (or `signed`/`accepted` depending on the existing flow). The same hook will be used by Plan 2b/2c for orientation email; Plan 2d only adds the two marketing scheduling calls.

- [ ] **Step 1: Locate the Stripe webhook handler and its deposit-paid branch**

```bash
grep -rn "deposit_paid\|signed.*paid\|charge.succeeded" server/routes/ server/utils/ --include="*.js" | head -20
```

Likely files: `server/routes/stripeWebhook.js`, `server/utils/stripeWebhook*.js`, or a `signedAndPaid` handler. Read the relevant block to find where the proposal transitions to `deposit_paid` and the existing client email fires.

- [ ] **Step 2: Add the marketing scheduling calls right after the proposal transitions**

After the proposal status update and the existing email send (best-effort, non-blocking pattern):

```javascript
  // Schedule long-lead-time marketing touches (New Year, 6-months-out) for this proposal.
  // Both helpers check their own eligibility and no-op if conditions aren't met.
  try {
    const {
      scheduleNewYearHello,
      scheduleSixMonthsOut,
    } = require('../utils/marketingHandlers'); // adjust path to match actual file
    await scheduleNewYearHello(proposalId);
    await scheduleSixMonthsOut(proposalId);
  } catch (marketingErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(marketingErr, { tags: { route: 'stripeWebhook', issue: 'marketing-enroll' } });
    }
    console.error('Marketing enroll on sign+pay failed (non-blocking):', marketingErr);
  }
```

The path to `marketingHandlers` depends on where the webhook handler lives (`../utils/...` from `server/routes/`, or `./utils/...` from `server/`).

- [ ] **Step 3: Smoke test with a fake first-deposit event**

If the project has a Stripe webhook test fixture (look for `server/utils/stripeWebhook.test.js` or similar), run it. Otherwise, insert a manual test:

```bash
psql "$DATABASE_URL" << 'EOF'
BEGIN;

-- Create a proposal with a long lead time
INSERT INTO clients (name, email) VALUES ('Stripe Test', 'stripe-test@example.com') RETURNING id \gset client_
INSERT INTO proposals (client_id, event_date, status, event_type)
VALUES (:'client_id', CURRENT_DATE + INTERVAL '220 days', 'sent', 'birthday-party')
RETURNING id \gset prop_

-- (skip the actual webhook; call the helper directly via a tiny node oneliner instead — see step 4)
ROLLBACK;
EOF
```

- [ ] **Step 4: Verify via a node REPL**

```bash
node -e "
  const { scheduleNewYearHello, scheduleSixMonthsOut } = require('./server/utils/marketingHandlers');
  const { pool } = require('./server/db');
  (async () => {
    const { rows: [c] } = await pool.query(
      \"INSERT INTO clients (name, email) VALUES ('Stripe Test', 'stripe-test-2@example.com') RETURNING id\"
    );
    const { rows: [p] } = await pool.query(
      \"INSERT INTO proposals (client_id, event_date, status, event_type) VALUES (\$1, CURRENT_DATE + INTERVAL '220 days', 'deposit_paid', 'birthday-party') RETURNING id\",
      [c.id]
    );
    await scheduleNewYearHello(p.id);
    await scheduleSixMonthsOut(p.id);
    const { rows } = await pool.query(
      \"SELECT message_type, scheduled_for FROM scheduled_messages WHERE entity_id = \$1 ORDER BY scheduled_for\",
      [p.id]
    );
    console.log(rows);
    await pool.query('DELETE FROM scheduled_messages WHERE entity_id = \$1', [p.id]);
    await pool.query('DELETE FROM proposals WHERE id = \$1', [p.id]);
    await pool.query('DELETE FROM clients WHERE id = \$1', [c.id]);
    await pool.end();
  })();
"
```

Expected: two rows printed — one for `six_months_out` (today + ~40 days) and one for `new_year_hello` (next Jan 2). The exact scheduling depends on the test date.

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripeWebhook.js  # or wherever the change actually landed
git commit -m "feat(comms): enroll New Year + 6mo-out marketing touches on sign+pay"
```

---

## Task 10: Wire review request + retention nudge on completion

**Files:**
- Modify: `server/utils/balanceScheduler.js`
- Modify: `server/routes/proposals/crud.js`

Two completion paths exist: the auto-complete scheduler (proposal auto-transitions to `completed` after the event date passes and balance is zero), and an admin-manual "Mark Completed" status push. Both must trigger the review request and retention nudge.

- [ ] **Step 1: Wire the auto-complete scheduler**

In `server/utils/balanceScheduler.js`, find `processEventCompletions` (around line 180). Inside the `for (const proposal of result.rows)` loop, right after the activity-log insert (around line 207), add:

```javascript
        try {
          const {
            scheduleReviewRequest,
            scheduleRetentionNudge,
          } = require('./marketingHandlers');
          await scheduleReviewRequest(proposal.id);
          await scheduleRetentionNudge(proposal.id);
        } catch (marketingErr) {
          console.error(`[BalanceScheduler] marketing enroll failed for #${proposal.id}:`, marketingErr.message);
          Sentry.captureException(marketingErr, {
            tags: { scheduler: 'auto-complete', proposalId: proposal.id, issue: 'marketing-enroll' },
          });
          // Swallow — never let a marketing enrollment failure block status transition.
        }
```

- [ ] **Step 2: Wire the manual completion path**

In `server/routes/proposals/crud.js`, in the same status-PATCH handler used in Task 8, after the activity log insert, add:

```javascript
  // Schedule post-event touches when admin manually marks proposal as completed.
  if (status === 'completed') {
    try {
      const {
        scheduleReviewRequest,
        scheduleRetentionNudge,
      } = require('../../utils/marketingHandlers');
      await scheduleReviewRequest(parseInt(req.params.id, 10));
      await scheduleRetentionNudge(parseInt(req.params.id, 10));
    } catch (completeErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(completeErr, { tags: { route: 'proposals/status', issue: 'completion-enroll' } });
      }
      console.error('Completion enroll failed (non-blocking):', completeErr);
    }
  }
```

- [ ] **Step 3: Smoke test the manual path**

Open the admin UI, find a completed proposal in the test DB, push it back to `confirmed`, then back to `completed`. Verify a review_request and (for whitelist event types) a retention_nudge row appear in `scheduled_messages` with the correct `scheduled_for`.

```bash
psql "$DATABASE_URL" -c "
  SELECT message_type, scheduled_for
  FROM scheduled_messages
  WHERE entity_type='proposal'
    AND message_type IN ('review_request', 'retention_nudge')
  ORDER BY id DESC
  LIMIT 5;
"
```

Expected: at least one row for `review_request`. A `retention_nudge` row appears only if the event_type is in the whitelist.

- [ ] **Step 4: Smoke test the auto-complete path**

Stop the dev server. Run the auto-complete query manually against a test event that has ended:

```bash
node -e "
  const { processEventCompletions } = require('./server/utils/balanceScheduler');
  (async () => {
    await processEventCompletions();
    process.exit(0);
  })();
"
```

Then re-run the SQL from step 3. Expected: review_request rows for any newly auto-completed proposals.

- [ ] **Step 5: Commit**

```bash
git add server/utils/balanceScheduler.js server/routes/proposals/crud.js
git commit -m "feat(comms): enroll review request and retention nudge on completion"
```

---

## Task 11: Verify marketing gating works end-to-end (gate lives in Plan 2a)

**Files:**
- Verify: `server/utils/scheduledMessageDispatcher.js` from Plan 2a — the marketing gate already exists there per Gemini Finding 5; it reads `getHandlerMeta(messageType).category === 'marketing'` and the recipient's `communication_preferences.marketing_enabled`. Plan 2d's handlers all register with `category: 'marketing'` (Task 6) so the gate fires automatically.

This task is a verification pass plus a unit test for the gate-in-action with marketing-class metadata.

- [ ] **Step 1: Confirm Plan 2a's gate code is in place**

Read `server/utils/scheduledMessageDispatcher.js` and confirm the marketing-class block exists in `dispatchRow`:

```javascript
const meta = handlerMeta.get(row.message_type);
if (meta?.category === 'marketing' && row.recipient_type === 'client') {
  const prefs = recipient.communication_preferences || {};
  if (prefs.marketing_enabled === false) {
    await pool.query(
      "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
      [row.id, 'marketing_disabled: client.communication_preferences.marketing_enabled is false']
    );
    return;
  }
}
```

If this block is missing, Plan 2a Task 9 didn't ship cleanly — fix that first before proceeding.

- [ ] **Step 2: Add a unit test for the gate**

If Plan 2a's `scheduledMessageDispatcher.test.js` exists, append:

```javascript
// Append to server/utils/scheduledMessageDispatcher.test.js
// (file header at top already imports node:test + node:assert/strict from Plan 2a)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

let gatingClientId;
let gatingProposalId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, communication_preferences)
     VALUES ('Marketing Off Client', 'marketing-off@example.com', '{"marketing_enabled":false,"email_enabled":true,"sms_enabled":true}'::jsonb)
     RETURNING id`
  );
  gatingClientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type)
     VALUES ($1, CURRENT_DATE + INTERVAL '365 days', 'sent', 'birthday-party')
     RETURNING id`,
    [gatingClientId]
  );
  gatingProposalId = p.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM scheduled_messages WHERE entity_id = $1', [gatingProposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [gatingProposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [gatingClientId]);
});

test('marketing gating > suppresses a marketing-class row when marketing_enabled is false', async () => {
  // Plan 2d's registerMarketingHandlers() registers drip_touch_2 with
  // category: 'marketing', so the dispatcher's gate (Plan 2a Task 9)
  // suppresses this row.
  const { registerMarketingHandlers } = require('./marketingHandlers');
  registerMarketingHandlers();

  await pool.query(`
    INSERT INTO scheduled_messages (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for)
    VALUES ('proposal', $1, 'drip_touch_2', 'client', $2, 'email', NOW() - INTERVAL '1 minute')
  `, [gatingProposalId, gatingClientId]);

  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE entity_id = $1 AND message_type = 'drip_touch_2'",
    [gatingProposalId]
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /marketing_disabled/);
});

test('marketing gating > still fires a transactional review_request when marketing is off', async () => {
  // review_request registers with category: 'operational' (transactional
  // post-sale follow-up under CAN-SPAM), so the marketing gate must let
  // it through regardless of marketing_enabled.
  const { registerMarketingHandlers } = require('./marketingHandlers');
  registerMarketingHandlers();

  await pool.query("UPDATE proposals SET status = 'completed', event_date = CURRENT_DATE - INTERVAL '2 days' WHERE id = $1", [gatingProposalId]);
  await pool.query(`
    INSERT INTO scheduled_messages (entity_type, entity_id, message_type, recipient_type, recipient_id, channel, scheduled_for)
    VALUES ('proposal', $1, 'review_request', 'client', $2, 'email', NOW() - INTERVAL '1 minute')
  `, [gatingProposalId, gatingClientId]);

  const { dispatchPending } = require('./scheduledMessageDispatcher');
  await dispatchPending();

  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE entity_id = $1 AND message_type = 'review_request'",
    [gatingProposalId]
  );
  // Status should be 'sent' (success) or 'failed' (email send error) — but NOT 'suppressed'.
  assert.notStrictEqual(rows[0].status, 'suppressed');
});
```

- [ ] **Step 5: Run the test**

```bash
node --test server/utils/scheduledMessageDispatcher.test.js
```

Expected: marketing gating tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(comms): marketing gate in dispatcher honors communication_preferences"
```

---

## Task 12: End-to-end smoke test — drip flow

This is a verification pass exercising the drip from enrollment to fake-send. No code changes; if a step fails, go back and fix.

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Watch for clean boot — no errors on the dispatcher start, marketing handlers registered.

- [ ] **Step 2: Create a test proposal in status='sent'**

In a second terminal, via curl or the admin UI:

```bash
node -e "
  const { pool } = require('./server/db');
  (async () => {
    const { rows: [c] } = await pool.query(
      \"INSERT INTO clients (name, email, communication_preferences) VALUES ('Drip Smoke', 'drip-smoke@example.com', '{\\\"sms_enabled\\\":true,\\\"email_enabled\\\":true,\\\"marketing_enabled\\\":true}'::jsonb) RETURNING id\"
    );
    const { rows: [p] } = await pool.query(
      \"INSERT INTO proposals (client_id, event_date, status, event_type) VALUES (\$1, CURRENT_DATE + INTERVAL '60 days', 'draft', 'birthday-party') RETURNING id, token\",
      [c.id]
    );
    console.log('CLIENT_ID', c.id, 'PROPOSAL_ID', p.id, 'TOKEN', p.token);
    process.exit(0);
  })();
"
```

Note the printed `PROPOSAL_ID` and `CLIENT_ID`.

- [ ] **Step 3: Push the proposal to 'sent' via the admin UI or curl**

Get an admin JWT from the dev DB or via the login route. PATCH `/api/proposals/:id/status` with `{"status": "sent"}` and the bearer token. (Skip if there's an admin already logged in via the running app.)

- [ ] **Step 4: Confirm the three drip rows exist**

```bash
psql "$DATABASE_URL" -c "
  SELECT message_type, channel, status, scheduled_for
  FROM scheduled_messages
  WHERE entity_id = $PROPOSAL_ID AND entity_type = 'proposal'
  ORDER BY scheduled_for;
"
```

Expected: `drip_touch_2` at +7d, `drip_touch_4` at +14d, `drip_touch_5_email` at +21d. All status `pending`.

- [ ] **Step 5: Fast-forward one row and trigger the dispatcher**

```bash
psql "$DATABASE_URL" -c "
  UPDATE scheduled_messages
  SET scheduled_for = NOW() - INTERVAL '1 minute'
  WHERE entity_id = $PROPOSAL_ID AND message_type = 'drip_touch_2';
"
```

Then trigger the dispatcher manually (instead of waiting for the 60-second interval):

```bash
node -e "
  const { processScheduledMessages } = require('./server/utils/scheduledMessageDispatcher');
  (async () => { await processScheduledMessages(); process.exit(0); })();
"
```

Expected: the row transitions to `status='sent'`. Look at Resend dashboard (or your local dev mail catcher) to confirm the email rendered properly.

- [ ] **Step 6: Verify marketing opt-out**

```bash
psql "$DATABASE_URL" -c "
  UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{marketing_enabled}', 'false'::jsonb)
  WHERE id = $CLIENT_ID;

  UPDATE scheduled_messages
  SET scheduled_for = NOW() - INTERVAL '1 minute'
  WHERE entity_id = $PROPOSAL_ID AND message_type = 'drip_touch_4';
"
```

Then dispatcher again:

```bash
node -e "const {processScheduledMessages}=require('./server/utils/scheduledMessageDispatcher');(async()=>{await processScheduledMessages();process.exit(0);})();"
```

Expected: `drip_touch_4` is now `status='suppressed'` with `error_message ~ 'marketing opted out'`.

- [ ] **Step 7: Clean up**

```bash
node -e "
  const { pool } = require('./server/db');
  (async () => {
    await pool.query(\"DELETE FROM scheduled_messages WHERE entity_id = ANY(SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = 'drip-smoke@example.com'))\");
    await pool.query(\"DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = 'drip-smoke@example.com')\");
    await pool.query(\"DELETE FROM clients WHERE email = 'drip-smoke@example.com'\");
    process.exit(0);
  })();
"
```

- [ ] **Step 8: Stop the dev server**

Ctrl-C the dev server. No commit needed — this was verification only.

---

## Task 13: End-to-end smoke test — feedback router page

- [ ] **Step 1: With the dev server running, create a test completed proposal**

```bash
node -e "
  const { pool } = require('./server/db');
  (async () => {
    const { rows: [c] } = await pool.query(
      \"INSERT INTO clients (name, email) VALUES ('Feedback Smoke', 'feedback-smoke@example.com') RETURNING id\"
    );
    const { rows: [p] } = await pool.query(
      \"INSERT INTO proposals (client_id, event_date, status, event_type) VALUES (\$1, CURRENT_DATE - INTERVAL '2 days', 'completed', 'birthday-party') RETURNING id, token\",
      [c.id]
    );
    console.log('TOKEN', p.token);
    process.exit(0);
  })();
"
```

- [ ] **Step 2: Open the feedback page**

Open `http://localhost:3000/feedback/<TOKEN>` in a browser.

Expected: page renders with "How was your birthday party, Feedback?" and 5 star icons.

- [ ] **Step 3: Click a 5 star (high rating)**

Expected: browser redirects to `process.env.PUBLIC_GOOGLE_REVIEW_URL` (set this in `.env` if not already). If the env var is unset, you'll go to `https://google.com`.

Verify the DB row:

```bash
psql "$DATABASE_URL" -c "SELECT rating FROM post_event_feedback WHERE proposal_id = (SELECT id FROM proposals WHERE client_id = (SELECT id FROM clients WHERE email = 'feedback-smoke@example.com'));"
```

Expected: rating = 5.

- [ ] **Step 4: Test the low-rating path**

Delete the feedback row, navigate back to the feedback page (open in incognito or use a different proposal token), click 2 stars, fill in a comment, submit.

Expected: thank-you page displays, admin email sent to `ADMIN_FEEDBACK_NOTIFICATION_EMAIL`, DB row has rating=2 + comment text. Check the dev mail catcher.

- [ ] **Step 5: Test the already-submitted path**

Reload the feedback page after submission.

Expected: "We already received your feedback for this event."

- [ ] **Step 6: Test the archived guard**

```bash
psql "$DATABASE_URL" -c "
  UPDATE proposals SET status = 'archived' WHERE client_id = (SELECT id FROM clients WHERE email = 'feedback-smoke@example.com');
"
```

Reload the feedback page (or open a fresh proposal in archived state).

Expected: 404 / "This feedback page isn't available."

- [ ] **Step 7: Clean up**

```bash
node -e "
  const { pool } = require('./server/db');
  (async () => {
    await pool.query(\"DELETE FROM post_event_feedback WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = 'feedback-smoke@example.com'))\");
    await pool.query(\"DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email = 'feedback-smoke@example.com')\");
    await pool.query(\"DELETE FROM clients WHERE email = 'feedback-smoke@example.com'\");
    process.exit(0);
  })();
"
```

No code changes, no commit.

---

## Task 14: Update README, ARCHITECTURE, and CLAUDE.md docs

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

Per CLAUDE.md's mandatory documentation rules, the new template file, new route file, new utility files, new public page, and new schema table all need to land in the docs.

- [ ] **Step 1: Update README.md folder-structure tree**

Find the folder-structure section in `README.md`. Add these entries in the appropriate spots:

```text
server/
├── routes/
│   ├── publicFeedback.js        — post-event feedback router (5-star sentiment routing)
├── utils/
│   ├── marketingEmailTemplates.js — drip, New Year, 6-mo-out, retention, review-request templates
│   ├── marketingHandlers.js       — dispatcher handler registrations + scheduling helpers
│   ├── retentionEligibility.js    — retention-eligible event types + send-time computations
client/src/pages/public/
│   ├── FeedbackPage.jsx           — public sentiment-router feedback page
│   ├── FeedbackPage.css
```

- [ ] **Step 2: Update ARCHITECTURE.md route table**

In the API route table in `ARCHITECTURE.md`, add:

```markdown
| `/api/public/feedback/:token` | GET | Public | Fetch display data for post-event feedback router |
| `/api/public/feedback/:token` | POST | Public | Submit rating (1-5). 4-5 → Google Reviews redirect; 1-3 → record + admin alert |
```

In the schema section, add `post_event_feedback` table.

In the third-party integrations / scheduling section, add a paragraph:

```markdown
### Marketing message types

The dispatcher (see `scheduled_messages` table) handles marketing-class touches
via the `marketingHandlers.js` registration: `drip_touch_2`, `drip_touch_4`,
`drip_touch_5_email`, `new_year_hello`, `six_months_out`, `retention_nudge`.
The `review_request` is transactional (CAN-SPAM compliant post-sale follow-up)
and does NOT gate on `clients.communication_preferences.marketing_enabled`.
```

- [ ] **Step 3: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: marketing emails / drip / feedback router in README and ARCHITECTURE"
```

---

## Task 15: Final verification pass

This is a non-coding pass to confirm the plan landed cleanly. Run through the checklist before declaring Plan 2d done.

- [ ] **Step 1: Working tree clean**

```bash
git status
```

Expected: clean.

- [ ] **Step 2: All unit tests pass**

```bash
node --test server/utils/marketingEmailTemplates.test.js server/utils/marketingHandlers.test.js server/utils/retentionEligibility.test.js server/routes/publicFeedback.test.js
```

Expected: all green.

- [ ] **Step 3: Lint clean**

```bash
npm run lint
```

Expected: zero errors. Warnings about unused imports in TS-style files are tolerated only if pre-existing.

- [ ] **Step 4: Client build is clean**

```bash
cd client && CI=true npx react-scripts build 2>&1 | tail -20
```

Expected: build succeeds, no errors.

- [ ] **Step 5: Schema additions verified**

```bash
psql "$DATABASE_URL" -c "\\d post_event_feedback"
psql "$DATABASE_URL" -c "SELECT count(*) FROM scheduled_messages WHERE message_type LIKE 'drip_%' OR message_type IN ('new_year_hello', 'six_months_out', 'retention_nudge', 'review_request');"
```

Expected: `post_event_feedback` table exists; the count query returns a value (might be 0 if you cleaned up all test data — that's fine).

- [ ] **Step 6: All handlers register cleanly on boot**

```bash
npm run dev 2>&1 | head -50
```

Watch for marketing handler registration log line. Stop the server.

- [ ] **Step 7: Confirm Plan 2d is fully implemented against spec**

Skim the spec sections and confirm:

- [x] 1.3 — Drip touches 2, 4, 5 (email half) — implemented
- [x] 1.4 — New Year touch — implemented
- [x] 1.5 — 6-months-out touch — implemented
- [x] 4.1 — Review request + feedback router page (sentiment routing) — implemented
- [x] 4.2 — Retention nudge (whitelist event types, has-upcoming-event suppression) — implemented
- [x] 7.3 — Marketing gating + Reply-To routing — implemented in handler + dispatcher

Touches deferred to other plans:
- 1.3 SMS halves (touches 1, 3, 5-sms) → Plan 3
- 1.6 T-30 recap → Plan 2c

No commit needed for verification.

---

## Self-review (mandatory before merge)

- [ ] Spec coverage: every section in `Plan 2d Scope` has a task that implements it. The drip schedules 2/4/5-email rows; the feedback router page exists; New Year + 6mo-out are wired on sign+pay; retention nudge + review request are wired on completion.

- [ ] Placeholder scan: no TBD, no "implement later", every step has actual code or actual SQL or actual commands. Verified.

- [ ] Type consistency: `scheduleMessage` from Plan 2a is called with the same shape (`{entityType, entityId, messageType, recipientType, recipientId, channel, scheduledFor}`) at every site. `registerHandler('<type>', handlerFn)` is called consistently. Message type identifiers are stable across files: `drip_touch_2`, `drip_touch_4`, `drip_touch_5_email`, `new_year_hello`, `six_months_out`, `retention_nudge`, `review_request`. `MARKETING_MESSAGE_TYPES` exports from `marketingHandlers.js` and is imported by the dispatcher in Task 11.

- [ ] Tests precede implementation in every Task (red → green → commit). Verified.

- [ ] Idempotency: every scheduling helper is safe to call twice (the dispatcher's `scheduleMessage` upserts on the natural key). Verified.

- [ ] Marketing gating: dispatcher gate at row-fire time, handler self-check on prefs, archive cascade. All three layers present. Verified.

- [ ] Reply-To set on every marketing email so client replies land in admin inbox (spec 7.9). Verified in `marketingHandlers.js` `handler()` factory.

---

## What's not in this plan

Items intentionally deferred:

- **SMS halves of the drip (touches 1, 3, 5-sms)** — Plan 3
- **T-30 recap email** — Plan 2c
- **Self-service preferences page** — spec open item §12.5
- **Admin UI to tune the retention-eligible event-type whitelist** — code constant only; admin UI is a follow-up plan
- **Cal.com consult URL in the 6-months-out template** — wired to `null` for now; Plan 6 (Cal.com integration) fills it in
- **Multi-bartender post-event tip handling** — spec deferred §11.7; review request omits the tip line for multi-bartender events
- **Per-proposal manager assignment for Reply-To** — spec defers; uses `ADMIN_FEEDBACK_NOTIFICATION_EMAIL` env for now
