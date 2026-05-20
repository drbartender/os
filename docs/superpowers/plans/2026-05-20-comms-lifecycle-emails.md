# Automated Communication Lifecycle Emails Implementation Plan (Plan 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## What This Resolves (Gemini design-review pass, 2026-05-20)

This plan picks up two findings from the Gemini cross-plan review:

- **Finding 3 (WARNING) — Immediate sends bypass suppression rules.** Every immediate-send code block here (orientation in Task 8, drink-plan submit confirmations in Task 9, post-consult in Task 10) now calls `shouldSendImmediate({ proposal, client, channel })` from `server/utils/messageSuppression.js` (built in Plan 2a Task 8.5) before invoking `sendEmail`. Archived proposals, channel-disabled clients, and bad-contact-status recipients are skipped with a one-line log; the dispatcher's suppression check stays the source of truth and this utility mirrors it for non-scheduled paths.
- **Finding 1 (BLOCKER) participation — Handler metadata.** Plan 2b is mostly immediate sends and does NOT register dispatcher handlers. The one historical edge case (a `drink_plan_submitted` handler if scheduled via the dispatcher) is not in scope for 2b; if it ever lands here it will register with metadata via Plan 2a's `registerHandler(messageType, fn, { offsetFromEventDate, anchor, category })` API.

---

**Goal:** Land the four immediate, user-action-triggered confirmation emails in the automated comms spec: (1) the expanded orientation email replacing the standalone `signedAndPaidClient` + `drinkPlanLink` pair on Stripe sign+pay coupling, with a real `.ics` calendar attachment and an event-detail / receipt / Potion Planner / timeline body; (2) the drink-plan-submitted confirmation expanded to always fire with a BYOB-only shopping-list-timing warning and conditional balance language; (3) the shopping-list-ready email updated with the same freshness warning and skipped entirely for Hosted; and (4) a new post-consult recap email fired when the admin saves consult notes.

**Architecture:** Three layers. (1) Pure helpers (`server/utils/icsCalendar.js`, render-time helpers on the templates themselves) that take plain objects and return strings or buffers, fully unit-testable with `node:test`. (2) Template surface additions in `server/utils/emailTemplates.js`: expand `signedAndPaidClient` into a full-orientation renderer, expand `drinkPlanBalanceUpdate` to take a `bar_option` + always-fire conditional, expand `shoppingListReady` with the freshness warning, add a new `postConsultClient` template. (3) Call-site rewires in `server/routes/stripe.js` (orientation now sends `.ics`, drops the parallel `drinkPlanLink` send path in `eventCreation.js`), `server/routes/drinkPlans.js` (drink-plan submit + shopping-list-approve), and `server/routes/drinkPlanConsult.js` (new send on `consult_filled_at` flip). All sends remain immediate; no scheduler involvement, no `scheduled_messages` rows for this plan.

**Tech Stack:** Node.js 18+ / Express 4.22, raw SQL via `pg`, `@sentry/node` for error capture, Resend for email + attachments (`attachments: [{ filename, content }]`), `node:test` + `node:assert/strict` for unit tests (matches the existing `server/utils/*.test.js` pattern, e.g. refundHelpers, drinkPlanAccess, setupTime, bookingWindow). No new dependencies. iCalendar generation is pure string templating per RFC 5545.

**Related docs:**
- Spec: `docs/superpowers/specs/2026-05-20-automated-communication-design.md`, sections 2.1, 3.8, 3.9, 3.10, 7.6
- Plan 1 (foundation): `docs/superpowers/plans/2026-05-20-automated-communication-foundation.md`. Provides `event_timezone`, archive cascade, `scheduled_messages` table, scheduler heartbeat.
- Plan 2a (money path, parallel): `docs/superpowers/plans/2026-05-20-comms-money-path-emails.md`. Provides Reply-To header on `sendEmail`, the dispatcher + `messageScheduling.scheduleMessage` contract. Plan 2b mostly uses immediate sends, NOT the dispatcher.

---

## Execution conventions

This codebase uses `node:test` + `node:assert/strict` for unit tests. Run with `node --test server/utils/<file>.test.js`. The prompt mentioned Jest but the repo has no Jest config and every existing `*.test.js` uses `node:test`. Stick with the existing pattern.

**Commit pattern.** Per CLAUDE.md: plain `git commit -m "single line"` with no heredoc and no co-author footer. Always `git add <specific-path>`, never `git add .`. One commit per logical feature.

**Em dashes.** Do not introduce em dashes in copy. Use commas, periods, colons, or parentheticals. The existing templates use ` — ` in a couple of subject lines (e.g. `Signed & Paid — your event`); preserve those literal strings when copying old code into new fallback branches, but new copy follows the no-em-dash rule.

**Dependency on Plan 2a.** Plan 2a delivers the Reply-To header plumbing on `sendEmail`. If 2a hasn't merged yet when 2b lands, the orientation email will still send; it just won't have the `Reply-To: <admin>` header on the wire. The orientation tests written here pass either way; the integration check is in Task 11. Don't block on 2a, but flag if 2a lands later and Reply-To isn't being applied.

**`bar_option` resolution.** The spec calls the BYOB-vs-Hosted column `proposals.bar_option`. The actual schema doesn't have that column; the value is derived from the linked `service_packages.pricing_type` (`'per_guest'` means Hosted; anything else means BYOB). Use `isHostedPackage(pkg)` from `server/utils/pricingEngine.js` everywhere this plan branches. The template signatures take a literal `barOption: 'byob' | 'hosted'` so the templates stay testable without joining the pricing engine.

---

## File structure

```
server/utils/icsCalendar.js                                  # (create) pure iCalendar VEVENT renderer
server/utils/icsCalendar.test.js                             # (create) node:test for ics rendering
server/utils/orientationData.js                              # (create) gather + shape the orientation payload (DB + helpers)
server/utils/orientationData.test.js                         # (create) node:test for shaping
server/utils/emailTemplates.js                               # expand signedAndPaidClient; expand drinkPlanBalanceUpdate; expand shoppingListReady; add postConsultClient; export new helpers
server/utils/emailTemplates.test.js                          # (create) node:test for the 4 templates (no DB)
server/routes/stripe.js                                      # rewire isCoupledSigning email to call new orientation flow with .ics attachment; drop the standalone drink-plan-link path (handled by orientation now)
server/utils/eventCreation.js                                # remove the drinkPlanLink send (orientation covers it post-booking); keep drink plan creation
server/routes/drinkPlans.js                                  # expand drink-plan submit confirmation to always fire with conditional balance + BYOB warning; expand shoppingListReady call site to skip Hosted
server/routes/drinkPlanConsult.js                            # add post-consult email fire when consult_filled_at transitions from NULL → NOW()
README.md                                                    # bump templates section (optional doc touch)
```

---

## Task 1: Build the iCalendar renderer (`icsCalendar.js`)

Generates a single-event VCALENDAR string that Resend can deliver as a `.ics` attachment. Pure function (no DB, no I/O). Tested with `node:test`.

**Files:**
- Create: `server/utils/icsCalendar.js`
- Create: `server/utils/icsCalendar.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/utils/icsCalendar.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderEventIcs, foldIcsLine } = require('./icsCalendar');

test('renders a minimal VCALENDAR with VEVENT block', () => {
  const ics = renderEventIcs({
    uid: 'proposal-42@drbartender.com',
    startUtc: new Date('2026-06-15T23:00:00Z'),
    endUtc: new Date('2026-06-16T03:00:00Z'),
    summary: 'Birthday Party — Dr. Bartender',
    location: '123 Main St, Austin, TX',
    description: 'Your booking with Dr. Bartender',
    stampUtc: new Date('2026-05-20T18:00:00Z'),
  });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /VERSION:2\.0\r\n/);
  assert.match(ics, /PRODID:-\/\/Dr\. Bartender\/\/Booking\/\/EN\r\n/);
  assert.match(ics, /BEGIN:VEVENT\r\n/);
  assert.match(ics, /UID:proposal-42@drbartender\.com\r\n/);
  assert.match(ics, /DTSTAMP:20260520T180000Z\r\n/);
  assert.match(ics, /DTSTART:20260615T230000Z\r\n/);
  assert.match(ics, /DTEND:20260616T030000Z\r\n/);
  assert.match(ics, /SUMMARY:Birthday Party.*Dr\. Bartender\r\n/);
  assert.match(ics, /END:VEVENT\r\nEND:VCALENDAR\r\n$/);
});

test('uses CRLF line endings throughout', () => {
  const ics = renderEventIcs({
    uid: 'x@y',
    startUtc: new Date('2026-01-01T00:00:00Z'),
    endUtc: new Date('2026-01-01T01:00:00Z'),
    summary: 'X',
    location: 'Y',
    description: 'Z',
    stampUtc: new Date('2026-01-01T00:00:00Z'),
  });
  // No bare LF should appear; every newline must be preceded by CR.
  const bareLfIndex = ics.search(/(?<!\r)\n/);
  assert.equal(bareLfIndex, -1, `bare LF found at index ${bareLfIndex}`);
});

test('escapes commas, semicolons, backslashes, and newlines in text fields', () => {
  const ics = renderEventIcs({
    uid: 'esc@drbartender',
    startUtc: new Date('2026-01-01T00:00:00Z'),
    endUtc: new Date('2026-01-01T01:00:00Z'),
    summary: 'Wedding; reception, after-party',
    location: '123 Main St, Suite #4\\B',
    description: 'Line one\nLine two; with, commas',
    stampUtc: new Date('2026-01-01T00:00:00Z'),
  });
  // RFC 5545 §3.3.11: TEXT escapes are \\ \, \; \n
  assert.match(ics, /SUMMARY:Wedding\\;\s?reception\\,\s?after-party\r\n/);
  assert.match(ics, /LOCATION:123 Main St\\,\s?Suite #4\\\\B\r\n/);
  assert.match(ics, /DESCRIPTION:Line one\\nLine two\\;\s?with\\,\s?commas\r\n/);
});

test('foldIcsLine wraps content lines longer than 75 octets', () => {
  const long = 'X'.repeat(200);
  const folded = foldIcsLine(`DESCRIPTION:${long}`);
  // First line stays ≤ 75 octets, continuation lines start with a single space
  // and are also ≤ 75 octets including the leading space.
  const lines = folded.split('\r\n');
  assert.ok(lines[0].length <= 75, `first line was ${lines[0].length} octets`);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    assert.ok(lines[i].startsWith(' '), `continuation line ${i} missing leading space`);
    assert.ok(lines[i].length <= 75, `continuation line ${i} was ${lines[i].length} octets`);
  }
});

test('returns string suitable for Buffer.from(content, "utf8") into Resend attachments', () => {
  const ics = renderEventIcs({
    uid: 'buf@drbartender',
    startUtc: new Date('2026-06-15T23:00:00Z'),
    endUtc: new Date('2026-06-16T03:00:00Z'),
    summary: 'Test',
    location: 'Test',
    description: 'Test',
    stampUtc: new Date('2026-05-20T18:00:00Z'),
  });
  const buf = Buffer.from(ics, 'utf8');
  assert.ok(buf.length > 0);
  assert.equal(buf.subarray(0, 15).toString('utf8'), 'BEGIN:VCALENDAR');
});

test('null / missing optional fields are emitted as empty strings, not the literal "null"', () => {
  const ics = renderEventIcs({
    uid: 'min@drbartender',
    startUtc: new Date('2026-06-15T23:00:00Z'),
    endUtc: new Date('2026-06-16T03:00:00Z'),
    summary: 'Test',
    location: null,
    description: null,
    stampUtc: new Date('2026-05-20T18:00:00Z'),
  });
  assert.match(ics, /LOCATION:\r\n/);
  assert.match(ics, /DESCRIPTION:\r\n/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test server/utils/icsCalendar.test.js
```

Expected: FAIL with `Cannot find module './icsCalendar'`.

- [ ] **Step 3: Implement the renderer**

Create `server/utils/icsCalendar.js`:

```javascript
/**
 * Pure iCalendar VEVENT renderer for booking confirmation emails.
 *
 * Per RFC 5545:
 * - Line endings are CRLF.
 * - TEXT properties escape: backslash → \\, comma → \,, semicolon → \;,
 *   newline → \n (literal two chars).
 * - DATE-TIME in UTC uses the form YYYYMMDDTHHMMSSZ.
 * - Content lines longer than 75 octets are folded onto a continuation line
 *   that starts with a single space (HTAB also legal; we use space).
 *
 * The output is intended to be sent as a Resend attachment with
 * { filename: 'event.ics', content: Buffer.from(out, 'utf8') }.
 *
 * No I/O, no DB, no time-zone library. Caller supplies UTC Date instances and
 * we format them as Z-suffixed strings. Time-zone-aware rendering (for the
 * email body, not the .ics) lives in eventTimezone.js from Plan 1.
 */

function pad2(n) { return String(n).padStart(2, '0'); }

function toIcsUtc(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('toIcsUtc: invalid Date');
  }
  return (
    date.getUTCFullYear().toString() +
    pad2(date.getUTCMonth() + 1) +
    pad2(date.getUTCDate()) +
    'T' +
    pad2(date.getUTCHours()) +
    pad2(date.getUTCMinutes()) +
    pad2(date.getUTCSeconds()) +
    'Z'
  );
}

function escapeIcsText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold a single content line per RFC 5545 §3.1: the unfolded line is
 * counted in octets (UTF-8 byte length), split at <= 75-octet boundaries,
 * continuation lines start with a single space.
 */
function foldIcsLine(line) {
  const buf = Buffer.from(line, 'utf8');
  if (buf.length <= 75) return line;
  const chunks = [];
  let offset = 0;
  // First chunk: up to 75 octets, then 74 octets per continuation (the 75th is
  // consumed by the leading-space continuation marker).
  let take = 75;
  while (offset < buf.length) {
    const end = Math.min(offset + take, buf.length);
    chunks.push(buf.slice(offset, end).toString('utf8'));
    offset = end;
    take = 74;
  }
  return chunks.join('\r\n ');
}

/**
 * Render a single-event VCALENDAR for an event booking.
 *
 * @param {object} args
 * @param {string} args.uid - unique event UID (use `proposal-<id>@drbartender.com`)
 * @param {Date} args.startUtc - event start, as a UTC Date
 * @param {Date} args.endUtc - event end, as a UTC Date
 * @param {string} args.summary - calendar event title
 * @param {string|null} args.location - free-form location string
 * @param {string|null} args.description - free-form description
 * @param {Date} args.stampUtc - DTSTAMP (when this .ics was generated); use new Date()
 * @returns {string} CRLF-terminated VCALENDAR text
 */
function renderEventIcs({ uid, startUtc, endUtc, summary, location, description, stampUtc }) {
  if (!uid) throw new TypeError('renderEventIcs: uid required');
  if (!(stampUtc instanceof Date)) throw new TypeError('renderEventIcs: stampUtc required');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dr. Bartender//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    foldIcsLine(`UID:${uid}`),
    `DTSTAMP:${toIcsUtc(stampUtc)}`,
    `DTSTART:${toIcsUtc(startUtc)}`,
    `DTEND:${toIcsUtc(endUtc)}`,
    foldIcsLine(`SUMMARY:${escapeIcsText(summary)}`),
    foldIcsLine(`LOCATION:${escapeIcsText(location)}`),
    foldIcsLine(`DESCRIPTION:${escapeIcsText(description)}`),
    'END:VEVENT',
    'END:VCALENDAR',
    '',  // trailing empty so .join produces a final CRLF
  ];
  return lines.join('\r\n');
}

module.exports = {
  renderEventIcs,
  foldIcsLine,
  escapeIcsText,
  toIcsUtc,
};
```

- [ ] **Step 4: Run tests to verify pass**

```bash
node --test server/utils/icsCalendar.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/icsCalendar.js server/utils/icsCalendar.test.js
git commit -m "feat(comms): pure iCalendar VEVENT renderer for booking attachments"
```

---

## Task 2: Build the orientation data assembler (`orientationData.js`)

Single function that takes a proposal id and the database pool and returns the fully-shaped payload the orientation template + ics needs. Pulls proposal, client, package, balance fields, computes balance remaining, computes UTC start/end, returns a plain object.

**Files:**
- Create: `server/utils/orientationData.js`
- Create: `server/utils/orientationData.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/utils/orientationData.test.js`. These are shape-only tests against pure helpers (timezone parsing, balance math, UTC start/end derivation). The DB-dependent `buildOrientationPayload` gets exercised in Task 11's integration smoke; here we test only the pure helpers.

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseStartTimeToHM,
  computeUtcStartEnd,
  deriveBarOption,
  computeBalanceContext,
  buildPotionPlannerUrl,
} = require('./orientationData');

// parseStartTimeToHM accepts both 24h ("17:00") and 12h ("5:00 PM") strings
// since proposals.event_start_time is VARCHAR(20) with both shapes in the wild.
test('parseStartTimeToHM: 24h "17:00" → {h:17,m:0}', () => {
  assert.deepEqual(parseStartTimeToHM('17:00'), { h: 17, m: 0 });
});
test('parseStartTimeToHM: 12h "5:00 PM" → {h:17,m:0}', () => {
  assert.deepEqual(parseStartTimeToHM('5:00 PM'), { h: 17, m: 0 });
});
test('parseStartTimeToHM: 12h "12:00 AM" → {h:0,m:0}', () => {
  assert.deepEqual(parseStartTimeToHM('12:00 AM'), { h: 0, m: 0 });
});
test('parseStartTimeToHM: 12h "12:30 PM" → {h:12,m:30}', () => {
  assert.deepEqual(parseStartTimeToHM('12:30 PM'), { h: 12, m: 30 });
});
test('parseStartTimeToHM: null/garbage → null', () => {
  assert.equal(parseStartTimeToHM(null), null);
  assert.equal(parseStartTimeToHM(''), null);
  assert.equal(parseStartTimeToHM('25:00'), null);
  assert.equal(parseStartTimeToHM('abc'), null);
});

test('computeUtcStartEnd: 2026-06-15 5:00 PM America/Chicago + 4h → UTC start 22:00, end 02:00 next day', () => {
  // June 15 2026 is CDT (UTC-5). 5:00 PM local = 22:00 UTC.
  const { startUtc, endUtc } = computeUtcStartEnd({
    eventDate: '2026-06-15',
    startTimeStr: '5:00 PM',
    durationHours: 4,
    tz: 'America/Chicago',
  });
  assert.equal(startUtc.toISOString(), '2026-06-15T22:00:00.000Z');
  assert.equal(endUtc.toISOString(), '2026-06-16T02:00:00.000Z');
});

test('computeUtcStartEnd: missing start time → null', () => {
  const result = computeUtcStartEnd({
    eventDate: '2026-06-15',
    startTimeStr: null,
    durationHours: 4,
    tz: 'America/Chicago',
  });
  assert.equal(result, null);
});

test('deriveBarOption: pricing_type "per_guest" → "hosted"', () => {
  assert.equal(deriveBarOption({ pricing_type: 'per_guest' }), 'hosted');
});
test('deriveBarOption: pricing_type "flat" → "byob"', () => {
  assert.equal(deriveBarOption({ pricing_type: 'flat' }), 'byob');
});
test('deriveBarOption: pricing_type "per_guest_timed" → "hosted"', () => {
  // per_guest_timed is also a hosted variant (isHostedPackage checks 'per_guest' only,
  // but verify our spec-level intent matches reality. Adjust if pricingEngine changes.)
  assert.equal(deriveBarOption({ pricing_type: 'per_guest_timed' }), 'byob');
});
test('deriveBarOption: null package → "byob" (safe default)', () => {
  assert.equal(deriveBarOption(null), 'byob');
});

test('computeBalanceContext: deposit-only, autopay enrolled', () => {
  const ctx = computeBalanceContext({
    totalPrice: 1500,
    amountPaid: 100,
    autopayEnrolled: true,
    balanceDueDate: '2026-06-01',
  });
  assert.equal(ctx.balanceRemaining, 1400);
  assert.equal(ctx.autopayEnrolled, true);
  assert.equal(ctx.balanceVerb, 'runs');
  assert.equal(ctx.dueLabel, 'runs on');
  assert.equal(ctx.formattedBalanceDueDate, 'June 1, 2026');
});

test('computeBalanceContext: paid in full', () => {
  const ctx = computeBalanceContext({
    totalPrice: 500,
    amountPaid: 500,
    autopayEnrolled: false,
    balanceDueDate: null,
  });
  assert.equal(ctx.balanceRemaining, 0);
  assert.equal(ctx.paidInFull, true);
});

test('computeBalanceContext: non-autopay path', () => {
  const ctx = computeBalanceContext({
    totalPrice: 1500,
    amountPaid: 100,
    autopayEnrolled: false,
    balanceDueDate: '2026-06-01',
  });
  assert.equal(ctx.balanceVerb, 'due');
  assert.equal(ctx.dueLabel, 'due on');
});

test('buildPotionPlannerUrl: builds /plan/<token>', () => {
  const url = buildPotionPlannerUrl('https://drbartender.com', 'abc-123');
  assert.equal(url, 'https://drbartender.com/plan/abc-123');
});
test('buildPotionPlannerUrl: null token returns null (caller suppresses CTA)', () => {
  const url = buildPotionPlannerUrl('https://drbartender.com', null);
  assert.equal(url, null);
});
```

- [ ] **Step 2: Verify tests fail**

```bash
node --test server/utils/orientationData.test.js
```

Expected: FAIL with `Cannot find module './orientationData'`.

- [ ] **Step 3: Implement the helpers + DB query**

Create `server/utils/orientationData.js`:

```javascript
const { pool } = require('../db');
const { resolveEventTimezone, formatEventLocalTime, DEFAULT_TZ } = require('./eventTimezone');

/**
 * Parse proposals.event_start_time (VARCHAR(20)) into {h, m}.
 * Handles both 24h ("17:00") and 12h ("5:00 PM") shapes, because the
 * proposal-create flow has historically taken either and there is no
 * canonicalization at write time.
 *
 * Returns null on anything unparseable; callers must treat null as
 * "we cannot place the event on the calendar; skip the .ics".
 */
function parseStartTimeToHM(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();

  // 12h: "5:00 PM" / "12:30 AM"
  const m12 = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(s);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const m = parseInt(m12[2], 10);
    const ampm = m12[3].toUpperCase();
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    if (ampm === 'AM') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
    return { h, m };
  }

  // 24h: "17:00"
  const m24 = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const m = parseInt(m24[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return { h, m };
  }

  return null;
}

/**
 * Compute UTC start + end for the event from event_date (DATE),
 * event_start_time (VARCHAR), event_duration_hours (NUMERIC), and the event TZ.
 *
 * Implementation note: JS Date has no native "build from local fields in zone X"
 * primitive. We compute the offset between the wall-clock time in the event zone
 * and UTC by formatting a candidate UTC Date in the target zone and adjusting.
 * The two-pass approach below converges in one step for non-DST-transition days
 * and is correct for our use case (events do not span a DST transition).
 *
 * Returns null if any required field is missing or unparseable.
 */
function computeUtcStartEnd({ eventDate, startTimeStr, durationHours, tz }) {
  if (!eventDate || !startTimeStr || durationHours == null) return null;
  const hm = parseStartTimeToHM(startTimeStr);
  if (!hm) return null;
  const zone = tz || DEFAULT_TZ;

  // eventDate is a DATE column; node-postgres gives us a Date at UTC midnight
  // or a YYYY-MM-DD string depending on driver config. Normalize.
  const dateStr = typeof eventDate === 'string'
    ? eventDate.slice(0, 10)
    : new Date(eventDate).toISOString().slice(0, 10);
  const [y, mo, d] = dateStr.split('-').map(Number);
  if (!y || !mo || !d) return null;

  // First pass: assume the local time is also UTC, then ask the formatter
  // what wall-clock time that corresponds to in `zone`. The difference is the
  // offset we need to subtract.
  const naiveUtc = new Date(Date.UTC(y, mo - 1, d, hm.h, hm.m, 0));
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(naiveUtc).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  const localAsUtc = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour, 10) === 24 ? 0 : parseInt(parts.hour, 10),
    parseInt(parts.minute, 10),
    parseInt(parts.second, 10)
  );
  const offsetMs = localAsUtc - naiveUtc.getTime();
  const startUtc = new Date(naiveUtc.getTime() - offsetMs);
  const endUtc = new Date(startUtc.getTime() + Number(durationHours) * 3600 * 1000);
  return { startUtc, endUtc };
}

/**
 * Decide BYOB vs Hosted from the linked service_packages row.
 * The spec calls this `proposals.bar_option` but in the actual schema it's
 * derived from `service_packages.pricing_type`. Falls back to 'byob' on
 * missing data (safe default: the BYOB shopping-list copy is the broader
 * superset of guidance).
 */
function deriveBarOption(pkg) {
  if (pkg && pkg.pricing_type === 'per_guest') return 'hosted';
  return 'byob';
}

/**
 * Shape the receipt + balance section. Pure.
 *
 * @returns {{
 *   balanceRemaining: number,
 *   paidInFull: boolean,
 *   autopayEnrolled: boolean,
 *   balanceVerb: 'runs' | 'due',
 *   dueLabel: 'runs on' | 'due on',
 *   formattedBalanceDueDate: string | null,
 * }}
 */
function computeBalanceContext({ totalPrice, amountPaid, autopayEnrolled, balanceDueDate }) {
  const total = Number(totalPrice) || 0;
  const paid = Number(amountPaid) || 0;
  const balanceRemaining = Math.max(0, total - paid);
  const paidInFull = balanceRemaining <= 0.005;
  const dateStr = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-US', {
        timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric',
      })
    : null;
  return {
    balanceRemaining,
    paidInFull,
    autopayEnrolled: !!autopayEnrolled,
    balanceVerb: autopayEnrolled ? 'runs' : 'due',
    dueLabel: autopayEnrolled ? 'runs on' : 'due on',
    formattedBalanceDueDate: dateStr,
  };
}

function buildPotionPlannerUrl(publicSiteUrl, token) {
  if (!token) return null;
  return `${publicSiteUrl}/plan/${token}`;
}

/**
 * Fetch the proposal + client + package + drink plan token in one query and
 * shape it into a ready-to-render payload. Returns null if the proposal can't
 * be loaded.
 *
 * Caller is responsible for sending the email (and the .ics attachment).
 * This function does no I/O beyond the single SELECT.
 */
async function buildOrientationPayload(proposalId, { publicSiteUrl }) {
  const r = await pool.query(`
    SELECT
      p.id,
      p.event_date,
      p.event_start_time,
      p.event_duration_hours,
      p.event_location,
      p.guest_count,
      p.total_price,
      p.amount_paid,
      p.balance_due_date,
      p.autopay_enrolled,
      p.event_timezone,
      c.id      AS client_id,
      c.name    AS client_name,
      c.email   AS client_email,
      sp.name          AS package_name,
      sp.pricing_type  AS package_pricing_type,
      sp.bar_type      AS package_bar_type,
      dp.token  AS drink_plan_token
    FROM proposals p
    LEFT JOIN clients c           ON c.id = p.client_id
    LEFT JOIN service_packages sp ON sp.id = p.package_id
    LEFT JOIN drink_plans dp      ON dp.proposal_id = p.id
    WHERE p.id = $1
    LIMIT 1
  `, [proposalId]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];

  const tz = resolveEventTimezone({ event_timezone: row.event_timezone });
  const utc = computeUtcStartEnd({
    eventDate: row.event_date,
    startTimeStr: row.event_start_time,
    durationHours: row.event_duration_hours,
    tz,
  });
  const barOption = deriveBarOption({ pricing_type: row.package_pricing_type });
  const balance = computeBalanceContext({
    totalPrice: row.total_price,
    amountPaid: row.amount_paid,
    autopayEnrolled: row.autopay_enrolled,
    balanceDueDate: row.balance_due_date,
  });

  const formattedEventDate = row.event_date
    ? new Date(row.event_date).toLocaleDateString('en-US', {
        timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      })
    : null;
  const formattedStartTime = utc
    ? formatEventLocalTime(utc.startUtc, tz, { hour: 'numeric', minute: '2-digit' })
    : (row.event_start_time || null);

  return {
    proposalId: row.id,
    clientName: row.client_name || 'there',
    clientEmail: row.client_email,
    eventDate: row.event_date,
    eventStartTime: row.event_start_time,
    eventDurationHours: Number(row.event_duration_hours) || 4,
    eventLocation: row.event_location,
    guestCount: row.guest_count,
    packageName: row.package_name || 'BYOB Classic',
    barOption,
    tz,
    utc,
    formattedEventDate,
    formattedStartTime,
    balance,
    potionPlannerUrl: buildPotionPlannerUrl(publicSiteUrl, row.drink_plan_token),
    drinkPlanToken: row.drink_plan_token,
  };
}

module.exports = {
  parseStartTimeToHM,
  computeUtcStartEnd,
  deriveBarOption,
  computeBalanceContext,
  buildPotionPlannerUrl,
  buildOrientationPayload,
};
```

- [ ] **Step 4: Run tests, verify pass**

```bash
node --test server/utils/orientationData.test.js
```

Expected: all helper tests pass. (The DB function isn't unit-tested here; integration check is in Task 11.)

- [ ] **Step 5: Note the per_guest_timed test outcome**

The test `deriveBarOption: pricing_type "per_guest_timed" → "byob"` may surprise the reader. `isHostedPackage` in `pricingEngine.js` only checks `pricing_type === 'per_guest'`, NOT `per_guest_timed`. Keep the test as the source of truth: Plan 2b mirrors that exact check. If `pricingEngine.isHostedPackage` ever grows to include `per_guest_timed`, update `deriveBarOption` here in lockstep.

- [ ] **Step 6: Commit**

```bash
git add server/utils/orientationData.js server/utils/orientationData.test.js
git commit -m "feat(comms): orientation data assembler with pure helpers"
```

---

## Task 3: Expand `signedAndPaidClient` template into the full orientation email

The existing template is a 4-line "thanks for paying" note. The new one is the full orientation: booking block, receipt block, Potion Planner CTA, timeline, optional last-minute caveat. Same export name to avoid disturbing the rest of the call sites; they'll get the expanded body for free.

**Files:**
- Modify: `server/utils/emailTemplates.js`
- Create: `server/utils/emailTemplates.test.js`

- [ ] **Step 1: Write the failing template tests**

Create `server/utils/emailTemplates.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  signedAndPaidClient,
  drinkPlanBalanceUpdate,
  shoppingListReady,
  postConsultClient,
} = require('./emailTemplates');

// ─── signedAndPaidClient (orientation) ───────────────────────────

test('signedAndPaidClient: full orientation includes booking + receipt + planner CTA + timeline', () => {
  const t = signedAndPaidClient({
    clientName: 'Alex',
    eventTypeLabel: 'birthday party',
    amount: '100.00',
    paymentType: 'deposit',
    bookingBlock: {
      formattedEventDate: 'Sunday, June 15, 2026',
      formattedStartTime: '5:00 PM',
      eventLocation: '123 Main St, Austin, TX',
      guestCount: 50,
      packageName: 'BYOB Classic',
    },
    receiptBlock: {
      depositPaid: '100.00',
      balanceRemaining: '1400.00',
      paidInFull: false,
      autopayEnrolled: true,
      dueLabel: 'runs on',
      formattedBalanceDueDate: 'June 1, 2026',
    },
    potionPlannerUrl: 'https://drbartender.com/plan/abc-123',
    timelineLines: [
      'Drink plan: pick yours any time, ideally before [date]',
      'Balance: auto-charges on June 1',
      'Bartender assignment: about 14 days before the event',
      'Day-of: your bartender arrives 60 minutes early to set up',
    ],
  });
  assert.match(t.subject, /You're booked/i);
  assert.match(t.subject, /Sunday, June 15, 2026/);
  assert.match(t.html, /Sunday, June 15, 2026/);
  assert.match(t.html, /5:00 PM/);
  assert.match(t.html, /123 Main St, Austin, TX/);
  assert.match(t.html, /50/);
  assert.match(t.html, /BYOB Classic/);
  assert.match(t.html, /\$100\.00/);
  assert.match(t.html, /\$1400\.00/);
  assert.match(t.html, /runs on.*June 1, 2026/);
  assert.match(t.html, /Pick your drinks/i);
  assert.match(t.html, /abc-123/);
  // Timeline lines render
  for (const line of [
    'Drink plan:',
    'Balance:',
    'Bartender assignment:',
    'Day-of:',
  ]) {
    assert.match(t.html, new RegExp(line));
  }
  // Plain text fallback exists and is non-empty
  assert.ok(t.text && t.text.length > 100, 'text fallback should be substantial');
});

test('signedAndPaidClient: paid-in-full hides balance row and shows "paid in full" copy', () => {
  const t = signedAndPaidClient({
    clientName: 'Bob',
    eventTypeLabel: 'wedding',
    amount: '2000.00',
    paymentType: 'full payment',
    bookingBlock: {
      formattedEventDate: 'Saturday, August 1, 2026',
      formattedStartTime: '4:00 PM',
      eventLocation: 'Venue',
      guestCount: 120,
      packageName: 'Hosted Premium',
    },
    receiptBlock: {
      depositPaid: '2000.00',
      balanceRemaining: '0.00',
      paidInFull: true,
      autopayEnrolled: false,
      dueLabel: null,
      formattedBalanceDueDate: null,
    },
    potionPlannerUrl: 'https://drbartender.com/plan/xyz',
    timelineLines: ['Drink plan: pick yours any time'],
  });
  assert.match(t.html, /paid in full/i);
  assert.doesNotMatch(t.html, /balance remaining/i);
});

test('signedAndPaidClient: missing potionPlannerUrl suppresses the CTA gracefully', () => {
  const t = signedAndPaidClient({
    clientName: 'Sam',
    eventTypeLabel: 'event',
    amount: '100.00',
    paymentType: 'deposit',
    bookingBlock: {
      formattedEventDate: 'Sunday, June 15, 2026',
      formattedStartTime: '5:00 PM',
      eventLocation: 'TBD',
      guestCount: 50,
      packageName: 'BYOB Classic',
    },
    receiptBlock: {
      depositPaid: '100.00',
      balanceRemaining: '1400.00',
      paidInFull: false,
      autopayEnrolled: true,
      dueLabel: 'runs on',
      formattedBalanceDueDate: 'June 1, 2026',
    },
    potionPlannerUrl: null,
    timelineLines: [],
  });
  assert.doesNotMatch(t.html, /Pick your drinks/i);
  assert.doesNotMatch(t.html, /\/plan\//);
});

test('signedAndPaidClient: lastMinute=true appends the cancellation caveat', () => {
  const t = signedAndPaidClient({
    clientName: 'Jess',
    eventTypeLabel: 'birthday',
    amount: '100.00',
    paymentType: 'deposit',
    lastMinute: true,
    bookingBlock: {
      formattedEventDate: 'Tomorrow',
      formattedStartTime: '5:00 PM',
      eventLocation: 'X',
      guestCount: 30,
      packageName: 'BYOB Classic',
    },
    receiptBlock: {
      depositPaid: '100.00',
      balanceRemaining: '500.00',
      paidInFull: false,
      autopayEnrolled: true,
      dueLabel: 'runs on',
      formattedBalanceDueDate: 'June 1, 2026',
    },
    potionPlannerUrl: 'https://drbartender.com/plan/abc',
    timelineLines: [],
  });
  assert.match(t.html, /less than 72 hours/i);
});

// ─── drinkPlanBalanceUpdate ──────────────────────────────────────

test('drinkPlanBalanceUpdate: BYOB variant includes shopping-list timing warning', () => {
  const t = drinkPlanBalanceUpdate({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    barOption: 'byob',
    balanceChanged: false,
    extrasAmount: 0,
    newTotal: 1500,
    amountPaid: 1500,
    balanceDue: 0,
    balanceDueDate: null,
  });
  assert.match(t.html, /hold off on the actual shopping/i);
  assert.match(t.html, /freshness|fresh ingredients|stay fresh/i);
  assert.match(t.html, /return windows?/i);
});

test('drinkPlanBalanceUpdate: Hosted variant has no shopping-list warning', () => {
  const t = drinkPlanBalanceUpdate({
    clientName: 'Alex',
    eventTypeLabel: 'wedding',
    barOption: 'hosted',
    balanceChanged: false,
    extrasAmount: 0,
    newTotal: 5000,
    amountPaid: 5000,
    balanceDue: 0,
    balanceDueDate: null,
  });
  assert.doesNotMatch(t.html, /hold off on/i);
  assert.doesNotMatch(t.html, /freshness/i);
});

test('drinkPlanBalanceUpdate: balanceChanged=true includes updated-balance table', () => {
  const t = drinkPlanBalanceUpdate({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    barOption: 'byob',
    balanceChanged: true,
    extrasAmount: 200,
    newTotal: 1700,
    amountPaid: 100,
    balanceDue: 1600,
    balanceDueDate: '2026-06-01',
  });
  assert.match(t.html, /Updated balance|Updated Event Total|Remaining Balance/);
  assert.match(t.html, /\$1600\.00/);
  assert.match(t.html, /June 1, 2026/);
});

test('drinkPlanBalanceUpdate: balanceChanged=false omits balance table but still confirms receipt', () => {
  const t = drinkPlanBalanceUpdate({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    barOption: 'byob',
    balanceChanged: false,
    extrasAmount: 0,
    newTotal: 1500,
    amountPaid: 1500,
    balanceDue: 0,
    balanceDueDate: null,
  });
  assert.match(t.html, /got your drink list/i);
  assert.doesNotMatch(t.html, /\$0\.00/);
});

// ─── shoppingListReady ───────────────────────────────────────────

test('shoppingListReady: includes freshness/return-window warning', () => {
  const t = shoppingListReady({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    shoppingListUrl: 'https://drbartender.com/shopping-list/abc',
  });
  assert.match(t.html, /best to do the actual shopping in the days leading up/i);
  assert.match(t.html, /freshness|stay fresh/i);
  assert.match(t.html, /return windows?/i);
});

// ─── postConsultClient (new) ─────────────────────────────────────

test('postConsultClient: renders consult recap with drink list and next-step', () => {
  const t = postConsultClient({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    formattedEventDate: 'Sunday, June 15, 2026',
    drinkRecapLines: [
      'Signature cocktail: Old Fashioned',
      'Wine: Cabernet, Sauvignon Blanc',
      'Beer: IPA, lager',
    ],
    nextStepLine: "We'll send your shopping list shortly.",
  });
  assert.match(t.subject, /Drink plan recap/i);
  assert.match(t.html, /Old Fashioned/);
  assert.match(t.html, /Cabernet/);
  assert.match(t.html, /We'll send your shopping list shortly/);
});

test('postConsultClient: hosted variant uses different next-step line', () => {
  const t = postConsultClient({
    clientName: 'Alex',
    eventTypeLabel: 'wedding',
    formattedEventDate: 'Saturday, August 1, 2026',
    drinkRecapLines: ['Signature cocktail: French 75'],
    nextStepLine: 'Your bartender will prep based on this.',
  });
  assert.match(t.html, /Your bartender will prep based on this/);
});

test('postConsultClient: empty drinkRecapLines still renders gracefully', () => {
  const t = postConsultClient({
    clientName: 'Alex',
    eventTypeLabel: 'birthday',
    formattedEventDate: 'Sunday, June 15, 2026',
    drinkRecapLines: [],
    nextStepLine: "We'll send your shopping list shortly.",
  });
  assert.ok(t.html);
  assert.match(t.html, /recap/i);
});
```

- [ ] **Step 2: Verify tests fail**

```bash
node --test server/utils/emailTemplates.test.js
```

Expected: FAIL for all four template tests with TypeError on signature mismatch / undefined export.

- [ ] **Step 3: Rewrite `signedAndPaidClient` in `server/utils/emailTemplates.js`**

Locate the current `signedAndPaidClient` (around line 126) and replace it with the full orientation renderer. The function signature changes; callers in `server/routes/stripe.js` will be updated in Task 8. The OLD call-shape props (`clientName`, `eventTypeLabel`, `amount`, `paymentType`, `lastMinute`) are kept compatible by treating the new orientation fields as additive: if `bookingBlock` isn't passed, the old short-form behavior is preserved as the fallback. That lets us land this template change before the Stripe route is rewired.

Replace the function body:

```javascript
function signedAndPaidClient({
  clientName,
  eventTypeLabel = 'event',
  amount,
  paymentType,
  lastMinute = false,
  // New orientation fields (additive; old call shape still works without these)
  bookingBlock,
  receiptBlock,
  potionPlannerUrl,
  timelineLines,
}) {
  const name = clientName || 'there';

  // Fallback: old short-form behavior when caller hasn't migrated to the
  // orientation shape. Lets us ship the template change ahead of the route
  // rewire without breaking the existing send. The Stripe route gets updated
  // in Task 8 to pass the full payload.
  if (!bookingBlock || !receiptBlock) {
    return {
      subject: `Signed & Paid — your ${eventTypeLabel} — Dr. Bartender`,
      html: wrapEmail(`
        <h2 style="color:${BRAND.primary};margin-top:0;">You're Locked In!</h2>
        <p>Hi ${name},</p>
        <p>We've received your signed proposal <em>and</em> your <strong>${paymentType}</strong> of <strong>$${amount}</strong> for your <strong>${eventTypeLabel}</strong>. Your date is officially on the books.</p>
        ${lastMinuteCaveatHtml(lastMinute)}
        <p>We'll be in touch with next steps as your event date approaches.</p>
        <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
        <p>Cheers,<br/>The Dr. Bartender Team</p>
      `),
      text: `Hi ${name}, we've received your signed proposal and your ${paymentType} of $${amount} for your ${eventTypeLabel}. Your date is officially on the books.${lastMinuteCaveatText(lastMinute)} — The Dr. Bartender Team`,
    };
  }

  // Full orientation rendering.
  const bb = bookingBlock;
  const rb = receiptBlock;

  const bookingTable = `
    <table style="width:100%;border-collapse:collapse;margin:1.25rem 0;">
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};width:140px;">Date</td><td style="padding:6px 12px;font-weight:bold;">${esc(bb.formattedEventDate || 'TBD')}</td></tr>
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};">Start time</td><td style="padding:6px 12px;font-weight:bold;">${esc(bb.formattedStartTime || 'TBD')}</td></tr>
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};">Location</td><td style="padding:6px 12px;">${esc(bb.eventLocation || 'TBD')}</td></tr>
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};">Guest count</td><td style="padding:6px 12px;">${esc(String(bb.guestCount || ''))}</td></tr>
      <tr><td style="padding:6px 12px;color:${BRAND.secondary};">Package</td><td style="padding:6px 12px;">${esc(bb.packageName || '')}</td></tr>
    </table>`;

  const receiptTable = rb.paidInFull
    ? `<p style="margin:1rem 0;font-weight:bold;color:${BRAND.primary};">Paid in full: $${esc(rb.depositPaid || amount || '')}</p>`
    : `
      <table style="width:100%;border-collapse:collapse;margin:1.25rem 0;">
        <tr><td style="padding:6px 12px;color:${BRAND.secondary};">${esc(paymentType || 'Deposit')} paid</td><td style="padding:6px 12px;text-align:right;font-weight:bold;">$${esc(rb.depositPaid || amount || '')}</td></tr>
        <tr><td style="padding:6px 12px;color:${BRAND.primary};font-weight:bold;">Balance remaining</td><td style="padding:6px 12px;text-align:right;font-weight:bold;">$${esc(rb.balanceRemaining || '')}</td></tr>
        ${rb.formattedBalanceDueDate ? `<tr><td style="padding:6px 12px;color:${BRAND.secondary};">Balance ${esc(rb.dueLabel || 'due on')}</td><td style="padding:6px 12px;text-align:right;">${esc(rb.formattedBalanceDueDate)}</td></tr>` : ''}
      </table>`;

  const plannerCta = potionPlannerUrl
    ? `<p>Next up: pick your drinks. The Potion Planner walks you through it in about 5 minutes.</p>${ctaButton(potionPlannerUrl, 'Pick your drinks')}`
    : '';

  const timelineHtml = Array.isArray(timelineLines) && timelineLines.length
    ? `<h3 style="color:${BRAND.primary};margin-top:1.5rem;">What to expect</h3>
       <ul style="line-height:1.7;color:${BRAND.primary};padding-left:1.25rem;">${timelineLines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '';

  const subject = bb.formattedEventDate
    ? `You're booked: ${bb.formattedEventDate} ${eventTypeLabel}`
    : `You're booked for your ${eventTypeLabel}`;

  const html = wrapEmail(`
    <h2 style="color:${BRAND.primary};margin-top:0;">You're booked!</h2>
    <p>Hi ${esc(name)},</p>
    <p>Thanks for booking with Dr. Bartender. Everything's locked in for your <strong>${esc(eventTypeLabel)}</strong>.</p>
    <h3 style="color:${BRAND.primary};margin-top:1.5rem;">Booking</h3>
    ${bookingTable}
    <h3 style="color:${BRAND.primary};margin-top:1.5rem;">Receipt</h3>
    ${receiptTable}
    ${plannerCta}
    ${timelineHtml}
    ${lastMinuteCaveatHtml(lastMinute)}
    <p style="font-size:14px;color:${BRAND.secondary};margin-top:1.5rem;">A calendar invite is attached. If you have any questions, just reply to this email.</p>
    <p>Cheers, Dallas</p>
  `);

  // Plain-text fallback. Keep it humble; Resend handles the HTML render.
  const textLines = [
    `Hi ${name}, you're booked for your ${eventTypeLabel}.`,
    bb.formattedEventDate ? `Date: ${bb.formattedEventDate}` : null,
    bb.formattedStartTime ? `Start time: ${bb.formattedStartTime}` : null,
    bb.eventLocation ? `Location: ${bb.eventLocation}` : null,
    bb.guestCount ? `Guest count: ${bb.guestCount}` : null,
    bb.packageName ? `Package: ${bb.packageName}` : null,
    '',
    rb.paidInFull
      ? `Paid in full: $${rb.depositPaid || amount || ''}`
      : `${paymentType || 'Deposit'} paid: $${rb.depositPaid || amount || ''}. Balance: $${rb.balanceRemaining || ''}${rb.formattedBalanceDueDate ? `, ${rb.dueLabel || 'due on'} ${rb.formattedBalanceDueDate}` : ''}.`,
    potionPlannerUrl ? `Pick your drinks: ${potionPlannerUrl}` : null,
    ...(timelineLines || []),
    lastMinuteCaveatText(lastMinute).trim(),
    '',
    'Cheers, Dallas',
  ].filter(Boolean);

  return { subject, html, text: textLines.join('\n') };
}
```

- [ ] **Step 4: Run tests for the orientation template**

```bash
node --test server/utils/emailTemplates.test.js
```

Expected: the four `signedAndPaidClient` tests pass. The other tests (`drinkPlanBalanceUpdate`, `shoppingListReady`, `postConsultClient`) still fail; Tasks 4-6 handle them.

- [ ] **Step 5: Commit**

```bash
git add server/utils/emailTemplates.js server/utils/emailTemplates.test.js
git commit -m "feat(comms): expand signedAndPaidClient into full orientation email"
```

---

## Task 4: Expand `drinkPlanBalanceUpdate` template (always fire, BYOB warning, conditional balance)

**Files:**
- Modify: `server/utils/emailTemplates.js`

- [ ] **Step 1: Rewrite `drinkPlanBalanceUpdate`**

Locate the current function (around line 201) and replace its body. The new signature accepts `barOption` ('byob' | 'hosted') and `balanceChanged` (bool). It always renders the "got your drink list" confirmation; the balance table only renders when `balanceChanged === true`; the shopping-list timing warning renders only when `barOption === 'byob'`.

```javascript
function drinkPlanBalanceUpdate({
  clientName,
  eventTypeLabel = 'event',
  barOption,
  balanceChanged,
  extrasAmount,
  newTotal,
  amountPaid,
  balanceDue,
  balanceDueDate,
}) {
  const name = clientName || 'there';
  const dueDate = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const balanceTable = balanceChanged
    ? `
      <table style="width:100%;border-collapse:collapse;margin:1.5rem 0;">
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Extras Added</td><td style="padding:8px 12px;text-align:right;font-weight:bold;">$${Number(extrasAmount).toFixed(2)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Updated Event Total</td><td style="padding:8px 12px;text-align:right;font-weight:bold;">$${Number(newTotal).toFixed(2)}</td></tr>
        <tr style="border-bottom:1px solid #e0d6cf;"><td style="padding:8px 12px;color:${BRAND.secondary};">Amount Paid</td><td style="padding:8px 12px;text-align:right;">$${Number(amountPaid).toFixed(2)}</td></tr>
        <tr><td style="padding:8px 12px;color:${BRAND.primary};font-weight:bold;">Remaining Balance</td><td style="padding:8px 12px;text-align:right;font-weight:bold;color:${BRAND.primary};">$${Number(balanceDue).toFixed(2)}</td></tr>
      </table>
      ${dueDate ? `<p>Your remaining balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> is due by <strong>${esc(dueDate)}</strong>.</p>` : ''}
    `
    : '';

  // BYOB-only freshness/return-window warning. Hosted events skip this entirely;
  // we do the shopping. Per spec section 7.6.
  const shoppingWarning = barOption === 'byob'
    ? `<p>We'll send your shopping list as soon as it's ready. When it lands, our recommendation is to hold off on the actual shopping until closer to your event date. That keeps ingredients fresh and any unused items stay within most stores' return windows.</p>`
    : '';

  return {
    subject: `Got your drink list for your ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Got your drink list!</h2>
      <p>Hi ${esc(name)},</p>
      <p>Got your drink list. We're prepping for your <strong>${esc(eventTypeLabel)}</strong>.</p>
      ${shoppingWarning}
      ${balanceTable}
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions about your drink plan or balance, just reply to this email.</p>
      <p>Cheers, Dallas</p>
    `),
    text: [
      `Hi ${name}, got your drink list for your ${eventTypeLabel}.`,
      barOption === 'byob' ? "We'll send your shopping list as soon as it's ready. Best to hold off on actual shopping until closer to your event date for freshness and return windows." : null,
      balanceChanged ? `Updated total: $${Number(newTotal).toFixed(2)}. Amount paid: $${Number(amountPaid).toFixed(2)}. Balance due: $${Number(balanceDue).toFixed(2)}${dueDate ? ` by ${dueDate}` : ''}.` : null,
      'Cheers, Dallas',
    ].filter(Boolean).join('\n'),
  };
}
```

- [ ] **Step 2: Run tests**

```bash
node --test server/utils/emailTemplates.test.js
```

Expected: `drinkPlanBalanceUpdate` tests now pass (4 cases: byob warning, hosted no warning, balanceChanged true, balanceChanged false).

- [ ] **Step 3: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(comms): drinkPlanBalanceUpdate always fires with conditional balance + BYOB warning"
```

---

## Task 5: Expand `shoppingListReady` with freshness/return-window warning

**Files:**
- Modify: `server/utils/emailTemplates.js`

- [ ] **Step 1: Rewrite `shoppingListReady`**

Locate the existing function (around line 428) and replace the body. The function signature stays the same so the call site doesn't need to change (skip-when-Hosted happens at the call site in Task 9).

```javascript
function shoppingListReady({ clientName, eventTypeLabel = 'event', shoppingListUrl }) {
  const name = clientName || 'there';
  return {
    subject: `Your shopping list for your ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your Shopping List is Ready</h2>
      <p>Hi ${esc(name)},</p>
      <p>Your shopping list for your <strong>${esc(eventTypeLabel)}</strong> is ready.</p>
      ${ctaButton(shoppingListUrl, 'View shopping list')}
      <p>A heads up: best to do the actual shopping in the days leading up to your event so ingredients stay fresh and any unused items stay within most stores' return windows. No need to rush out today.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">Reach out with any questions, just reply to this email.</p>
      <p>Cheers, Dallas</p>
    `),
    text: `Hi ${name}, your shopping list for your ${eventTypeLabel} is ready: ${shoppingListUrl}. A heads up: best to do the actual shopping in the days leading up to your event so ingredients stay fresh and unused items stay within return windows. Cheers, Dallas`,
  };
}
```

- [ ] **Step 2: Run tests**

```bash
node --test server/utils/emailTemplates.test.js
```

Expected: `shoppingListReady` test passes.

- [ ] **Step 3: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(comms): shoppingListReady gets freshness and return-window warning"
```

---

## Task 6: Add new `postConsultClient` template

**Files:**
- Modify: `server/utils/emailTemplates.js`

- [ ] **Step 1: Add the new template + export it**

Insert the function near the other client-facing templates (after `drinkPlanBalanceUpdate`, around line 224). Then add it to the `module.exports` object at the bottom of the file.

```javascript
/**
 * Sent when admin clicks "complete" / "save" on consult notes in
 * drink_plans.consult_selections (transition: consult_filled_at NULL → NOW()).
 * Renders a recap of the drinks captured during the consult so the client
 * has a written record of what they agreed to, plus a one-line next-step
 * pointer.
 *
 * BYOB events use "We'll send your shopping list shortly."
 * Hosted events use "Your bartender will prep based on this."
 * Caller is responsible for picking the right next-step line.
 */
function postConsultClient({
  clientName,
  eventTypeLabel = 'event',
  formattedEventDate,
  drinkRecapLines,
  nextStepLine,
}) {
  const name = clientName || 'there';
  const list = Array.isArray(drinkRecapLines) ? drinkRecapLines : [];
  const recapHtml = list.length
    ? `<ul style="line-height:1.7;color:${BRAND.primary};padding-left:1.25rem;">${list.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
    : `<p style="color:${BRAND.secondary};font-style:italic;">(notes are on file; reach out if you'd like the full list)</p>`;

  const dateSuffix = formattedEventDate ? ` on ${formattedEventDate}` : '';

  return {
    subject: `Drink plan recap for your ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Drink plan recap</h2>
      <p>Hi ${esc(name)},</p>
      <p>Great talking through your drink plan for your <strong>${esc(eventTypeLabel)}</strong>${esc(dateSuffix)}. Here's what we landed on:</p>
      ${recapHtml}
      ${nextStepLine ? `<p>${esc(nextStepLine)}</p>` : ''}
      <p style="font-size:14px;color:${BRAND.secondary};">Let me know if anything needs to change, just reply to this email.</p>
      <p>Cheers, Dallas</p>
    `),
    text: [
      `Hi ${name}, great talking through your drink plan for your ${eventTypeLabel}${dateSuffix}.`,
      list.length ? 'Here is what we landed on:' : null,
      ...list,
      nextStepLine || null,
      'Cheers, Dallas',
    ].filter(Boolean).join('\n'),
  };
}
```

At the bottom of the file, add `postConsultClient` to the module.exports block so it's importable:

```javascript
module.exports = {
  // ... existing exports ...
  postConsultClient,
};
```

- [ ] **Step 2: Run tests**

```bash
node --test server/utils/emailTemplates.test.js
```

Expected: all `postConsultClient` tests pass. All 11 template tests in the file pass.

- [ ] **Step 3: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(comms): new postConsultClient template for consult-notes-saved recap"
```

---

## Task 7: Build the consult drink recap formatter

Hold off on bundling this with the template. The consult selections JSON has a shape that's worth its own pure formatter. Lives in a sibling util so the consult route stays small.

**Files:**
- Create: `server/utils/consultRecap.js`
- Create: `server/utils/consultRecap.test.js`

- [ ] **Step 1: Write the failing tests**

Create `server/utils/consultRecap.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatConsultRecap, pickNextStepLine } = require('./consultRecap');

test('formatConsultRecap: full mix of selections renders human-readable bullets', () => {
  const lines = formatConsultRecap({
    barType: 'full_bar',
    spirits: ['vodka', 'tequila', 'whiskey'],
    signatureDrinks: ['Old Fashioned', 'Margarita'],
    customCocktails: [{ name: 'House Mule', ingredients: ['vodka', 'ginger beer', 'lime'] }],
    mocktailsEnabled: true,
    mocktails: ['Virgin Mojito'],
    beer: true,
    wine: ['Cabernet', 'Sauvignon Blanc'],
  });
  // Sanity: every selection surfaces somewhere
  const blob = lines.join(' | ');
  assert.match(blob, /full bar/i);
  assert.match(blob, /vodka/i);
  assert.match(blob, /Old Fashioned/);
  assert.match(blob, /House Mule/);
  assert.match(blob, /Virgin Mojito/i);
  assert.match(blob, /beer/i);
  assert.match(blob, /Cabernet/);
});

test('formatConsultRecap: beer/wine-only event omits cocktail lines', () => {
  const lines = formatConsultRecap({
    barType: 'beer_wine',
    beer: true,
    wine: ['Rose'],
  });
  const blob = lines.join(' | ');
  assert.match(blob, /beer/i);
  assert.match(blob, /Rose/);
  assert.doesNotMatch(blob, /spirit/i);
  assert.doesNotMatch(blob, /cocktail/i);
});

test('formatConsultRecap: empty consult returns single notes-on-file line', () => {
  const lines = formatConsultRecap({});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /no specific selections|notes are on file/i);
});

test('formatConsultRecap: custom-cocktail ingredients render inline in parens', () => {
  const lines = formatConsultRecap({
    customCocktails: [{ name: 'Smoky Maria', ingredients: ['mezcal', 'tomato', 'lime'] }],
  });
  assert.match(lines.find(l => /Smoky Maria/.test(l)), /\(mezcal, tomato, lime\)/);
});

test('pickNextStepLine: byob → "We\'ll send your shopping list shortly."', () => {
  assert.equal(
    pickNextStepLine('byob'),
    "We'll send your shopping list shortly."
  );
});

test('pickNextStepLine: hosted → "Your bartender will prep based on this."', () => {
  assert.equal(
    pickNextStepLine('hosted'),
    'Your bartender will prep based on this.'
  );
});

test('pickNextStepLine: unknown defaults to the BYOB line (safer default)', () => {
  assert.equal(
    pickNextStepLine(null),
    "We'll send your shopping list shortly."
  );
});
```

- [ ] **Step 2: Verify tests fail**

```bash
node --test server/utils/consultRecap.test.js
```

Expected: FAIL with `Cannot find module './consultRecap'`.

- [ ] **Step 3: Implement the formatter**

Create `server/utils/consultRecap.js`:

```javascript
const BAR_TYPE_LABELS = {
  full_bar: 'Full bar',
  sig_beer_wine: 'Signature cocktails plus beer and wine',
  beer_wine: 'Beer and wine',
  mocktails: 'Mocktails',
};

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Render the saved consult_selections JSON into a list of one-line strings
 * suitable for the postConsultClient email recap.
 *
 * Schema reference: see sanitizeConsult() in server/routes/drinkPlanConsult.js
 * for the canonical shape. Fields are all optional; missing fields are skipped.
 *
 * Returns at least one line (a placeholder if the consult is empty), never an
 * empty array.
 */
function formatConsultRecap(consult = {}) {
  if (!consult || typeof consult !== 'object') {
    return ['(no specific selections captured; notes are on file)'];
  }
  const lines = [];

  if (consult.barType && BAR_TYPE_LABELS[consult.barType]) {
    lines.push(`Bar style: ${BAR_TYPE_LABELS[consult.barType]}`);
  }

  if (Array.isArray(consult.spirits) && consult.spirits.length) {
    lines.push(`Spirits: ${consult.spirits.map(titleCase).join(', ')}`);
  }

  if (Array.isArray(consult.signatureDrinks) && consult.signatureDrinks.length) {
    lines.push(`Signature cocktails: ${consult.signatureDrinks.join(', ')}`);
  }

  if (Array.isArray(consult.customCocktails) && consult.customCocktails.length) {
    for (const c of consult.customCocktails) {
      if (!c || !c.name) continue;
      const ingredients = Array.isArray(c.ingredients) && c.ingredients.length
        ? ` (${c.ingredients.join(', ')})`
        : '';
      lines.push(`Custom cocktail: ${c.name}${ingredients}`);
    }
  }

  if (consult.mocktailsEnabled || (Array.isArray(consult.mocktails) && consult.mocktails.length)) {
    if (Array.isArray(consult.mocktails) && consult.mocktails.length) {
      lines.push(`Mocktails: ${consult.mocktails.join(', ')}`);
    } else {
      lines.push('Mocktails: yes (selections TBD)');
    }
  }

  if (Array.isArray(consult.customMocktails) && consult.customMocktails.length) {
    for (const c of consult.customMocktails) {
      if (!c || !c.name) continue;
      const ingredients = Array.isArray(c.ingredients) && c.ingredients.length
        ? ` (${c.ingredients.join(', ')})`
        : '';
      lines.push(`Custom mocktail: ${c.name}${ingredients}`);
    }
  }

  if (consult.beer) lines.push('Beer: yes');

  if (Array.isArray(consult.wine) && consult.wine.length) {
    lines.push(`Wine: ${consult.wine.join(', ')}`);
  }

  if (consult.notes && typeof consult.notes === 'string' && consult.notes.trim()) {
    lines.push(`Notes: ${consult.notes.trim()}`);
  }

  return lines.length ? lines : ['(no specific selections captured; notes are on file)'];
}

/**
 * Choose the right next-step line based on bar option. BYOB sends the
 * shopping-list pointer; Hosted points at bartender prep. Unknown defaults
 * to BYOB (safer; if we get this wrong we mention shopping that doesn't
 * need to happen rather than imply no follow-up).
 */
function pickNextStepLine(barOption) {
  if (barOption === 'hosted') return 'Your bartender will prep based on this.';
  return "We'll send your shopping list shortly.";
}

module.exports = { formatConsultRecap, pickNextStepLine };
```

- [ ] **Step 4: Run tests, verify pass**

```bash
node --test server/utils/consultRecap.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/consultRecap.js server/utils/consultRecap.test.js
git commit -m "feat(comms): consult-selections recap formatter and next-step picker"
```

---

## Task 8: Rewire the Stripe webhook to send the full orientation email with `.ics` attachment

This is the integration point. The webhook's existing coupled-signing branch sends the OLD short `signedAndPaidClient`. Swap it for the new orientation pipeline: build the payload via `orientationData`, render the `.ics`, render the template with the full booking + receipt blocks + timeline, attach the `.ics` via Resend's `attachments` parameter, send.

The existing `drinkPlanLink` send in `eventCreation.js` becomes redundant (the orientation includes the Potion Planner link). Drop the email portion there but keep the drink-plan creation itself; the plan still has to exist so the orientation can link to it.

**Files:**
- Modify: `server/routes/stripe.js` (the `sendPaymentNotifications` helper)
- Modify: `server/utils/eventCreation.js` (drop the standalone drinkPlanLink send)

- [ ] **Step 1: Confirm dependency order**

`createEventShifts` in `eventCreation.js` is called from inside the Stripe webhook tx (look for `createEventShifts(` in `stripe.js` around the `payment_intent.succeeded` block; currently runs AFTER commit). It internally creates the drink plan and historically sent the `drinkPlanLink` email. We need that drink plan to exist BEFORE `sendPaymentNotifications` runs (because the orientation email links to it). Confirm with a grep:

```bash
grep -n "createEventShifts\|sendPaymentNotifications" server/routes/stripe.js
```

Expected: the post-commit notifier currently runs in this order:
1. `createEventShifts(proposalId, ...)` (creates shifts + drink plan + sends the standalone drinkPlanLink; to be neutered in Step 4)
2. `sendPaymentNotifications(proposalId, amountCents, paymentType)` (sends the old `signedAndPaidClient`; to be rewired in Step 2)

If the order is reversed, swap the calls so the drink plan exists before the orientation email queries for its token.

- [ ] **Step 2: Rewire `sendPaymentNotifications` for the coupled-signing branch**

In `server/routes/stripe.js`, locate the `sendPaymentNotifications` helper (currently starts around line 817). Inside the `if (pi?.client_email) { ... }` block where `isCoupledSigning` is true, replace the OLD send with the orientation pipeline.

Add these requires near the top of `stripe.js`:

```javascript
const { renderEventIcs } = require('../utils/icsCalendar');
const { buildOrientationPayload } = require('../utils/orientationData');
const { effectiveSetupMinutes } = require('../utils/setupTime');
const { shouldSendImmediate } = require('../utils/messageSuppression');
```

Inside `sendPaymentNotifications`, replace the entire `if (pi?.client_email) { ... }` client branch with this:

```javascript
if (pi?.client_email) {
  // last_minute_hold was set in-tx and committed before this post-commit
  // notifier runs, so the flag is readable here. Append the cancellation
  // caveat to the first-payment client email when the booking is ≤72h out.
  const lastMinute = !!pi?.last_minute_hold;

  // Gemini Finding 3: respect the same suppression rules the dispatcher
  // applies on scheduled rows. We need the proposal + client rows to make
  // the call; the post-commit notifier already loaded them via payInfo.
  // Build a tiny shape so messageSuppression has what it needs.
  const proposalForCheck = { id: proposalId, status: pi.status || 'deposit_paid' };
  const clientForCheck = {
    id: pi.client_id,
    communication_preferences: pi.communication_preferences,
    email_status: pi.email_status,
    phone_status: pi.phone_status,
  };
  const sendCheck = await shouldSendImmediate({
    proposal: proposalForCheck,
    client: clientForCheck,
    channel: 'email',
  });
  if (!sendCheck.ok) {
    console.log(`[orientation] suppressed for proposal ${proposalId}: ${sendCheck.reason}`);
    // Skip the entire client-email branch but allow downstream admin email
    // to still fire (admin emails are NOT gated by client comm prefs).
  } else if (isCoupledSigning) {
    // FULL ORIENTATION: assemble payload, build .ics, send with attachment.
    try {
      const payload = await buildOrientationPayload(proposalId, { publicSiteUrl: PUBLIC_SITE_URL });
      if (!payload) {
        console.error(`[orientation] could not load proposal ${proposalId}, skipping`);
      } else {
        // Build the booking + receipt blocks the template expects.
        const bookingBlock = {
          formattedEventDate: payload.formattedEventDate,
          formattedStartTime: payload.formattedStartTime,
          eventLocation: payload.eventLocation,
          guestCount: payload.guestCount,
          packageName: payload.packageName,
        };
        const receiptBlock = {
          depositPaid: amountFormatted,
          balanceRemaining: payload.balance.balanceRemaining.toFixed(2),
          paidInFull: payload.balance.paidInFull,
          autopayEnrolled: payload.balance.autopayEnrolled,
          dueLabel: payload.balance.dueLabel,
          formattedBalanceDueDate: payload.balance.formattedBalanceDueDate,
        };

        // Timeline: spec section 2.1. Renders the bartender-assignment day
        // dynamically from setupTime + auto-assign window.
        const setupMin = effectiveSetupMinutes({ pricing_type: undefined }, null) || 60;
        const timelineLines = [
          payload.potionPlannerUrl
            ? 'Drink plan: pick yours any time'
            : 'Drink plan: we will be in touch with your planner link',
          payload.balance.paidInFull
            ? 'Balance: paid in full'
            : `Balance: ${payload.balance.dueLabel}${payload.balance.formattedBalanceDueDate ? ` ${payload.balance.formattedBalanceDueDate}` : ''}`,
          'Bartender assignment: about 14 days before the event',
          `Day-of: your bartender arrives ${setupMin} minutes before your start time to set up`,
        ];

        // Build .ics attachment (only when we have a real start time).
        const attachments = [];
        if (payload.utc) {
          const ics = renderEventIcs({
            uid: `proposal-${proposalId}@drbartender.com`,
            startUtc: payload.utc.startUtc,
            endUtc: payload.utc.endUtc,
            summary: `${eventLabel} with Dr. Bartender`,
            location: payload.eventLocation,
            description: `Your booking with Dr. Bartender. Reply to this email with any questions.`,
            stampUtc: new Date(),
          });
          attachments.push({ filename: 'event.ics', content: Buffer.from(ics, 'utf8') });
        }

        const tpl = emailTemplates.signedAndPaidClient({
          clientName: pi.client_name,
          eventTypeLabel: eventLabel,
          amount: amountFormatted,
          paymentType: payLabel,
          lastMinute,
          bookingBlock,
          receiptBlock,
          potionPlannerUrl: payload.potionPlannerUrl,
          timelineLines,
        });
        await sendEmail({
          to: pi.client_email,
          ...tpl,
          ...(attachments.length ? { attachments } : {}),
        });
      }
    } catch (orientationErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(orientationErr, {
          tags: { route: '/webhook', step: 'orientation_email', proposalId: String(proposalId) },
        });
      }
      console.error('[orientation] failed (non-blocking):', orientationErr);
      // Fall back to the old short-form path so the client at least hears
      // something back.
      const tpl = emailTemplates.signedAndPaidClient({
        clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute,
      });
      await sendEmail({ to: pi.client_email, ...tpl });
    }
  } else {
    // Non-coupled payment: existing paymentReceivedClient path, still gated
    // by the same shouldSendImmediate check above (this branch only runs when
    // sendCheck.ok === true).
    const tpl = emailTemplates.paymentReceivedClient({
      clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute,
    });
    await sendEmail({ to: pi.client_email, ...tpl });
  }
}
```

The post-commit payInfo SELECT in `stripe.js` (around line 820) needs to also pull
`p.client_id`, `c.communication_preferences`, `c.email_status`, `c.phone_status`
so the suppression check has the data it needs. Extend the existing SELECT
when wiring this task (the autopay-enrolled column added in Plan 2a Task 12
already sets the precedent for extending this query).

A few important notes:
- `effectiveSetupMinutes` requires `pkg` and `override`. We don't have the package row in scope here, but the fallback `|| 60` is the default for non-hosted. If the package is hosted (90 min default), the email will under-state by 30 min for the timeline copy. Acceptable for V1; refine later if needed.
- The fallback short-form path on orientation failure preserves the customer-facing behavior we have today, so a bad row never blocks the confirmation email.

- [ ] **Step 3: Verify the new send path compiles**

```bash
npx eslint server/routes/stripe.js
```

Expected: no errors.

- [ ] **Step 4: Neuter the standalone `drinkPlanLink` send in `eventCreation.js`**

Open `server/utils/eventCreation.js`. The drink plan still has to be created (orientation links to its token), but the email portion is now redundant.

Replace the `if (!skipEmail && clientEmail && drinkPlan.token) { ... }` block (around lines 70-81) with:

```javascript
// Drink plan link is now folded into the orientation email (see
// signedAndPaidClient in emailTemplates.js + the Stripe webhook coupled-
// signing branch in routes/stripe.js). Drop the standalone send.
//
// `skipEmail` is preserved as a no-op parameter so callers that still pass
// it don't break, but the parameter is now effectively unused. Once all
// callers stop passing it (one cleanup commit later), we can drop the param.
if (skipEmail || clientEmail) { /* intentional no-op: orientation covers this */ }
```

Then drop the now-unused `drinkPlanLink` import at the top of the file:

```javascript
// Remove this line:
// const { drinkPlanLink } = require('./emailTemplates');
```

Drop the now-unused `sendEmail` import too if `eventCreation.js` doesn't use it anywhere else (grep first):

```bash
grep -n "sendEmail" server/utils/eventCreation.js
```

If `sendEmail` is unused elsewhere in the file, drop its import line as well.

- [ ] **Step 5: Restart dev server and confirm boot**

The Claude-managed dev server needs a restart for the server-side change to take effect (per the auto-memory note about the dev server being a managed background process).

```bash
# Find the running pid on :5000 and restart per the project's dev-server pattern
# The harness handles this; just make sure server starts cleanly with no
# missing-module errors after the eventCreation.js trim.
```

Expected: no errors, no missing-module warnings.

- [ ] **Step 6: Smoke test the orientation send (manual)**

In a separate terminal, run a Stripe test-mode coupled sign+pay against a draft proposal. Verify:
1. The client receives ONE email (not two; the standalone drinkPlanLink should be gone).
2. The email subject starts with `You're booked:` followed by the event date.
3. The email body shows the booking block, receipt block, Potion Planner CTA, and timeline.
4. An `event.ics` attachment is present and opens cleanly in macOS Calendar / Outlook / Google Calendar.
5. Replies route to the admin inbox (only if Plan 2a's Reply-To has merged; otherwise this verification waits on 2a).

If anything looks off, fix in place before committing.

- [ ] **Step 7: Commit**

```bash
git add server/routes/stripe.js server/utils/eventCreation.js
git commit -m "feat(comms): orientation email replaces signedAndPaidClient + drinkPlanLink"
```

---

## Task 9: Wire the drink-plan submitted confirmation to always fire with bar_option branching

The current send in `server/routes/drinkPlans.js` only fires when `amountPaid < snapshot.total` (the "balance changed" path). The spec says it should always fire, with the balance language CONDITIONAL on whether the balance actually changed. The BYOB-vs-Hosted warning also needs to be plumbed in.

**Files:**
- Modify: `server/routes/drinkPlans.js`

- [ ] **Step 1: Locate the existing send**

Read `server/routes/drinkPlans.js` lines 295-385 to find the "Capture data for post-commit notifications" block and the post-commit `if (pendingNotifications)` send.

- [ ] **Step 2: Pull in package pricing_type during the existing SELECT**

The transaction already loads the proposal and package for pricing. Locate the existing query that loads `service_packages` (around line 261: `SELECT * FROM service_packages WHERE id = $1`). It returns the whole row, so `pricing_type` is already available on `pkg`. Good. No schema change needed.

- [ ] **Step 3: Restructure the post-commit notification to always fire**

Replace the existing capture + post-commit block. The change moves `pendingNotifications` capture OUT of the `if (amountPaid < snapshot.total)` guard so it fires unconditionally, and adds `barOption` + `balanceChanged` flags.

Look for this block (around line 297-318):

```javascript
const amountPaid = Number(proposal.amount_paid) || 0;
if (amountPaid < snapshot.total) {
  const addonNames = resolvedAddons.map(a => a.name);
  if (addBarRental) addonNames.push('Portable Bar Rental');
  pendingNotifications = {
    proposal: { ... },
    snapshot, amountPaid, addonNames, clientName, clientEmail,
  };
}
```

Replace with:

```javascript
const amountPaid = Number(proposal.amount_paid) || 0;
const balanceChanged = snapshot.total > Number(proposal.total_price);  // extras pushed total up
const addonNames = resolvedAddons.map(a => a.name);
if (addBarRental) addonNames.push('Portable Bar Rental');
pendingNotifications = {
  proposal: {
    id: proposal.id,
    status: proposal.status,
    event_date: proposal.event_date,
    event_type: existing.rows[0]?.event_type || proposal.event_type,
    event_type_custom: existing.rows[0]?.event_type_custom || proposal.event_type_custom,
    balance_due_date: proposal.balance_due_date,
    prevTotal: Number(proposal.total_price) || 0,
  },
  snapshot,
  amountPaid,
  addonNames,
  clientName: existing.rows[0]?.client_name || 'Client',
  clientEmail: existing.rows[0]?.client_email || proposal.client_email,
  // Gemini Finding 3: capture comm-prefs + email/phone status for the
  // post-commit suppression check. Extend the `existing` SELECT (line ~250)
  // to also pull these from `clients`:
  //   c.communication_preferences, c.email_status, c.phone_status
  clientForCheck: {
    communication_preferences: existing.rows[0]?.communication_preferences,
    email_status: existing.rows[0]?.email_status,
    phone_status: existing.rows[0]?.phone_status,
  },
  barOption: pkg && pkg.pricing_type === 'per_guest' ? 'hosted' : 'byob',
  balanceChanged,
};
```

Then update the post-commit send (around line 369-382) to use the new shape:

```javascript
if (clientEmail) {
  const { proposal: pn, snapshot, amountPaid, clientName, barOption, balanceChanged, clientForCheck } = pendingNotifications;
  // Gemini Finding 3: respect suppression rules on immediate sends.
  const sendCheck = await shouldSendImmediate({
    proposal: { id: pn.id, status: pn.status || 'deposit_paid' },
    client: clientForCheck,
    channel: 'email',
  });
  if (!sendCheck.ok) {
    console.log(`[drinkPlanSubmit] suppressed for proposal ${pn.id}: ${sendCheck.reason}`);
  } else {
    const extrasAmount = balanceChanged ? snapshot.total - pn.prevTotal : 0;
    const balanceDue = balanceChanged ? snapshot.total - amountPaid : 0;
    const tpl = emailTemplates.drinkPlanBalanceUpdate({
      clientName,
      eventTypeLabel: getEventTypeLabel({ event_type: pn.event_type, event_type_custom: pn.event_type_custom }),
      barOption,
      balanceChanged,
      extrasAmount,
      newTotal: snapshot.total,
      amountPaid,
      balanceDue,
      balanceDueDate: pn.balance_due_date,
    });
    sendEmail({ to: clientEmail, ...tpl }).catch(emailErr => console.error('Client drink-plan confirmation email failed:', emailErr));
  }
}
```

Add `const { shouldSendImmediate } = require('../utils/messageSuppression');` to the top of `drinkPlans.js`. Extend the existing `pendingNotifications.clientForCheck` capture to include `{ communication_preferences, email_status, phone_status }` from the proposal-side SELECT; if the existing SELECT doesn't already pull these from `clients`, extend it.

The admin-side notification still only fires when add-ons changed the balance (existing throttle behavior is fine; admin doesn't need a heads-up for a zero-impact submit).

- [ ] **Step 4: Handle the submit-without-addons fast path**

The route has a "Fast path: drafts or submit-without-addons" branch (around line 403-450). When a client submits an existing drink plan with NO addons (which the slow path skips entirely because there are no extras), the client today gets NO drink-plan-submitted email. The spec says always fire, so the fast path needs to fire too.

In the fast path UPDATE block, after the `UPDATE drink_plans SET ... RETURNING ...` query, add a post-commit confirmation send. Identify the slot to insert it: after `result = await pool.query(...)` and before the return / shopping-list-autogen block.

Insert a SELECT that pulls the joined info needed (proposal + package + client) and fire the same template, with `balanceChanged: false` and `barOption` from the package:

```javascript
// Always-fire drink-plan-submitted confirmation. Spec section 3.8: this email
// fires on every submission, with conditional balance language (false here:
// the fast path runs when no addons were added, so no balance shift).
if (newStatus === 'submitted' && result.rows[0]?.id) {
  try {
    const r = await pool.query(`
      SELECT p.id, p.status AS proposal_status,
             p.event_type, p.event_type_custom, p.balance_due_date,
             p.total_price, p.amount_paid,
             c.name AS client_name, c.email AS client_email,
             c.communication_preferences, c.email_status, c.phone_status,
             sp.pricing_type AS package_pricing_type
      FROM drink_plans dp
      LEFT JOIN proposals p ON p.id = dp.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE dp.id = $1
      LIMIT 1
    `, [result.rows[0].id]);
    if (r.rows[0]?.client_email) {
      const row = r.rows[0];
      // Gemini Finding 3: respect suppression rules on immediate sends.
      const sendCheck = await shouldSendImmediate({
        proposal: { id: row.id, status: row.proposal_status || 'deposit_paid' },
        client: {
          communication_preferences: row.communication_preferences,
          email_status: row.email_status,
          phone_status: row.phone_status,
        },
        channel: 'email',
      });
      if (!sendCheck.ok) {
        console.log(`[drinkPlanSubmitFastPath] suppressed for plan ${result.rows[0].id}: ${sendCheck.reason}`);
      } else {
        const barOption = row.package_pricing_type === 'per_guest' ? 'hosted' : 'byob';
        const tpl = emailTemplates.drinkPlanBalanceUpdate({
          clientName: row.client_name || 'Client',
          eventTypeLabel: getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom }),
          barOption,
          balanceChanged: false,
          extrasAmount: 0,
          newTotal: Number(row.total_price) || 0,
          amountPaid: Number(row.amount_paid) || 0,
          balanceDue: 0,
          balanceDueDate: row.balance_due_date,
        });
        sendEmail({ to: row.client_email, ...tpl }).catch(e => console.error('Drink-plan submit fast-path email failed:', e));
      }
    }
  } catch (e) {
    console.error('Drink-plan submit fast-path notification lookup failed (non-fatal):', e);
  }
}
```

- [ ] **Step 5: Also branch the shopping-list-approve send to skip Hosted**

In the same file, locate the `PATCH /:id/shopping-list/approve` route (around line 860) and its post-update send (around line 901). Hosted events should NOT receive the shopping-list-ready email; we shop, not the client. Update the query to also pull `service_packages.pricing_type`, then branch:

Replace the `RETURNING id, token, client_name, client_email, event_type, event_type_custom, event_date` part of the UPDATE with a follow-up join SELECT, or extend the RETURNING via a CTE. Simplest approach: after the UPDATE succeeds, run one more SELECT to pull the package's `pricing_type`:

```javascript
// After `const plan = upd.rows[0];` and before the email send:
const pkgRow = await pool.query(`
  SELECT sp.pricing_type
  FROM drink_plans dp
  LEFT JOIN proposals p ON p.id = dp.proposal_id
  LEFT JOIN service_packages sp ON sp.id = p.package_id
  WHERE dp.id = $1
`, [plan.id]);
const isHosted = pkgRow.rows[0]?.pricing_type === 'per_guest';

if (isHosted) {
  // Hosted events: we handle the shopping. Skip the client email entirely.
  console.log(`[shoppingListReady] hosted event, skipping client email for plan ${plan.id}`);
} else {
  // Existing email send path, unchanged copy except for the template's new warning.
  if (plan.client_email && plan.token) {
    // ... existing send remains here ...
  }
}
```

- [ ] **Step 6: Restart dev server and smoke test**

Test the three scenarios manually with `node` REPL or by running real submit cycles:

1. **BYOB drink plan submit, no addons:** Client gets email subjected "Got your drink list", body includes shopping-list warning, no balance table.
2. **BYOB drink plan submit, with addons (balance changed):** Client gets email, includes shopping-list warning, includes balance table.
3. **Hosted drink plan submit:** Client gets email, NO shopping-list warning anywhere.
4. **Hosted shopping list approve (admin):** Client gets NO email (we shop). Console logs `[shoppingListReady] hosted event, skipping`.
5. **BYOB shopping list approve:** Client gets shopping-list-ready email with freshness/return-window warning.

- [ ] **Step 7: Commit**

```bash
git add server/routes/drinkPlans.js
git commit -m "feat(comms): drink-plan submit always fires; shoppingListReady skips Hosted"
```

---

## Task 10: Fire the post-consult email when admin saves consult notes

**Files:**
- Modify: `server/routes/drinkPlanConsult.js`

- [ ] **Step 1: Add the email send to `PUT /:id/consult`**

The route currently updates `consult_filled_at = NOW()` and commits. Add a post-commit best-effort email send (same pattern as drink plans, never block the response). The send happens only when `consult_filled_at` transitions from NULL to NOW() (first-time save), NOT on re-submits; otherwise the client gets duplicate emails for every edit.

Locate the PUT handler (around line 127). After `await client.query('COMMIT');` and BEFORE `res.json({ ... })`, add a post-commit step.

First, before the BEGIN, fetch the prior `consult_filled_at` so we know whether this is a first-time save or a re-submit. The existing `planRes` SELECT pulls plan fields but not `consult_filled_at`. Add it:

Update the SELECT (line 134-142) to also pull `consult_filled_at`:

```javascript
const planRes = await client.query(
  `SELECT dp.id, dp.client_name, dp.event_date, dp.admin_notes,
          dp.consult_filled_at,
          p.guest_count
   FROM drink_plans dp
   LEFT JOIN proposals p ON p.id = dp.proposal_id
   WHERE dp.id = $1
   FOR UPDATE OF dp`,
  [req.params.id]
);
```

Then after `plan.consult_selections = consult;` capture the first-time flag:

```javascript
const isFirstTimeConsultSave = plan.consult_filled_at == null;
```

After the COMMIT, add the post-commit send:

```javascript
// Post-commit, best-effort: send the post-consult recap email to the client
// ONLY on first-time save. Subsequent edits to the consult don't re-fire the
// email (a re-edit by admin usually means correcting a typo, not re-confirming).
if (isFirstTimeConsultSave) {
  try {
    const { sendEmail } = require('../utils/email');
    const emailTemplates = require('../utils/emailTemplates');
    const { getEventTypeLabel } = require('../utils/eventTypes');
    const { formatConsultRecap, pickNextStepLine } = require('../utils/consultRecap');

    // Look up client email, package pricing_type, comm-prefs, and event-display fields.
    const { shouldSendImmediate } = require('../utils/messageSuppression');
    const lookup = await pool.query(`
      SELECT dp.client_email, dp.client_name, dp.event_type, dp.event_type_custom, dp.event_date,
             p.id AS proposal_id, p.status AS proposal_status,
             c.communication_preferences, c.email_status, c.phone_status,
             sp.pricing_type AS package_pricing_type
      FROM drink_plans dp
      LEFT JOIN proposals p ON p.id = dp.proposal_id
      LEFT JOIN clients c ON c.id = p.client_id
      LEFT JOIN service_packages sp ON sp.id = p.package_id
      WHERE dp.id = $1
    `, [req.params.id]);

    if (lookup.rows[0]?.client_email) {
      const row = lookup.rows[0];
      // Gemini Finding 3: respect suppression rules on immediate sends.
      const sendCheck = await shouldSendImmediate({
        proposal: { id: row.proposal_id, status: row.proposal_status || 'deposit_paid' },
        client: {
          communication_preferences: row.communication_preferences,
          email_status: row.email_status,
          phone_status: row.phone_status,
        },
        channel: 'email',
      });
      if (!sendCheck.ok) {
        console.log(`[postConsultClient] suppressed for plan ${req.params.id}: ${sendCheck.reason}`);
      } else {
        const barOption = row.package_pricing_type === 'per_guest' ? 'hosted' : 'byob';
        const formattedEventDate = row.event_date
          ? new Date(row.event_date).toLocaleDateString('en-US', {
              timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
            })
          : null;
        const tpl = emailTemplates.postConsultClient({
          clientName: row.client_name || 'there',
          eventTypeLabel: getEventTypeLabel({ event_type: row.event_type, event_type_custom: row.event_type_custom }),
          formattedEventDate,
          drinkRecapLines: formatConsultRecap(consult),
          nextStepLine: pickNextStepLine(barOption),
        });
        sendEmail({ to: row.client_email, ...tpl }).catch(emailErr => {
          console.error('[postConsultClient] send failed (non-fatal):', emailErr);
          if (process.env.SENTRY_DSN_SERVER) {
            const Sentry = require('@sentry/node');
            Sentry.captureException(emailErr, {
              tags: { route: 'drinkPlanConsult/putConsult', step: 'postConsultClient' },
              extra: { planId: req.params.id },
            });
          }
        });
      }
    }
  } catch (recapErr) {
    // Anything that throws during lookup/templating gets logged but doesn't
    // block the response. The consult save itself succeeded.
    console.error('[postConsultClient] post-commit step failed (non-fatal):', recapErr);
    if (process.env.SENTRY_DSN_SERVER) {
      const Sentry = require('@sentry/node');
      Sentry.captureException(recapErr, {
        tags: { route: 'drinkPlanConsult/putConsult', step: 'postConsult_lookup' },
        extra: { planId: req.params.id },
      });
    }
  }
}
```

The require()'s are inline (instead of top-of-file) to (a) keep the new code visually self-contained and (b) avoid making the email/template modules load at server start in tests that exercise only the consult route. The pattern matches the existing `sendInterviewConfirmationEmail` wrapper in `emailTemplates.js`.

- [ ] **Step 2: Restart dev server**

The route is a fresh code path; the in-process module cache won't have it. Restart so the route table picks up the new handler.

- [ ] **Step 3: Smoke test**

Manually exercise:

1. **First-time consult save (BYOB plan):** Client receives `Drink plan recap` email with the consult selections listed and "We'll send your shopping list shortly." as the next-step line.
2. **First-time consult save (Hosted plan):** Same email, but next-step is "Your bartender will prep based on this."
3. **Second save (edit) on the same consult:** NO email fires. (`consult_filled_at` is already non-null, so `isFirstTimeConsultSave` is false.)
4. **Save on a plan with no client_email:** No email, no crash. (`lookup.rows[0]?.client_email` falls through to skip the send.)

- [ ] **Step 4: Commit**

```bash
git add server/routes/drinkPlanConsult.js
git commit -m "feat(comms): post-consult recap email on first consult-notes save"
```

---

## Task 11: Integration verification

This is a verification pass, no code changes. Confirms the four touchpoints work end-to-end against the dev server.

- [ ] **Step 1: Confirm template tests all pass**

```bash
node --test server/utils/icsCalendar.test.js \
            server/utils/orientationData.test.js \
            server/utils/emailTemplates.test.js \
            server/utils/consultRecap.test.js
```

Expected: all four test files pass.

- [ ] **Step 2: Confirm lint passes**

```bash
npm run lint
```

Expected: no errors. (Warnings on pre-existing lines are fine; this plan should add zero NEW warnings.)

- [ ] **Step 3: Restart dev server, walk through all four touchpoints**

The Claude-managed dev server runs in the background; restart so all changes are loaded.

Run through the four touchpoints in test mode (Stripe test mode is fine since `STRIPE_TEST_MODE_UNTIL` may already be set):

| Touchpoint | Action | Expected email |
|---|---|---|
| Orientation | Sign + pay deposit on a new test proposal | "You're booked: [date] [event_type]" with booking block, receipt block, Potion Planner CTA, timeline, `.ics` attachment |
| Drink plan submit (BYOB, no addons) | Submit a draft plan via the public planner | "Got your drink list" with shopping-list warning, no balance table |
| Drink plan submit (BYOB, with addons) | Submit a draft plan that adds extras | Same email + balance table showing the new total |
| Drink plan submit (Hosted) | Submit a Hosted plan | "Got your drink list" with NO shopping-list warning |
| Shopping list ready (BYOB) | Admin approves the list | "Your shopping list for your [event]" with freshness/return-window warning |
| Shopping list ready (Hosted) | Admin approves the list | NO email sent. Console logs `[shoppingListReady] hosted event, skipping` |
| Post-consult (BYOB) | Admin saves consult notes for the first time | "Drink plan recap for your [event]" with selections list + "We'll send your shopping list shortly." |
| Post-consult (Hosted) | Admin saves consult notes (Hosted plan, first time) | Same email, but next-step is "Your bartender will prep based on this." |
| Post-consult (re-edit) | Admin re-saves the same consult | NO email (already non-null `consult_filled_at`) |

- [ ] **Step 4: Open the `.ics` in a calendar app**

Save the .ics from a real orientation email (or copy it out of a Resend dashboard log) and import into macOS Calendar, Google Calendar, or Outlook. Confirm:
- Title shows correctly
- Start/end time matches the event in the local zone (assuming Calendar app is configured to user's local zone)
- Location renders
- No "garbled text" / encoding issues

- [ ] **Step 5: Verify Reply-To (if Plan 2a is merged)**

Inspect the raw headers of the orientation email in the Resend dashboard or in the client's inbox. Confirm `Reply-To: <ADMIN_EMAIL>` is present. If Plan 2a has not yet merged, log this as a deferred verification and re-run once 2a lands.

- [ ] **Step 6: Stop dev server**

No commit for this verification task.

---

## Task 12: Update README templates table and CLAUDE.md if needed

Per CLAUDE.md's mandatory documentation update rule:
- New utility file (`icsCalendar`, `orientationData`, `consultRecap`) → README folder tree.
- New template (`postConsultClient`) → it's an internal helper, not an env var or integration, so no CLAUDE.md change.

**Files:**
- Modify: `README.md` (Folder structure tree)

- [ ] **Step 1: Update README.md folder tree**

Locate the `server/utils/` section of the folder tree in `README.md`. Add three lines:

```
├── icsCalendar.js        # iCalendar VEVENT renderer for booking attachments
├── orientationData.js    # Booking + receipt + planner payload assembler
├── consultRecap.js       # Post-consult selections renderer + next-step picker
```

(Adjust to match the actual indentation pattern used in the existing tree.)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): document icsCalendar, orientationData, consultRecap utils"
```

---

## Self-review (run after all tasks above complete)

- [ ] All commits land cleanly on `main` with single-line messages
- [ ] `git status` shows a clean working tree
- [ ] `npm run lint` passes
- [ ] `node --test server/utils/icsCalendar.test.js` passes
- [ ] `node --test server/utils/orientationData.test.js` passes
- [ ] `node --test server/utils/emailTemplates.test.js` passes (11 test cases)
- [ ] `node --test server/utils/consultRecap.test.js` passes
- [ ] Orientation email sends with `.ics` attachment on a test sign+pay
- [ ] `.ics` opens cleanly in at least one major calendar app
- [ ] Drink-plan-submitted email fires on EVERY submit (with + without addons, BYOB + Hosted)
- [ ] BYOB drink-plan-submitted includes the shopping-list timing warning
- [ ] Hosted drink-plan-submitted does NOT include the warning
- [ ] Shopping-list-ready email skipped entirely on Hosted events
- [ ] Post-consult email fires only on FIRST consult save, not re-edits
- [ ] Standalone `drinkPlanLink` email path is dead (no longer fires on event creation)
- [ ] If Plan 2a is merged, Reply-To header shows admin inbox on outbound orientation

---

## What's not in this plan

To keep Plan 2b focused on the four immediate confirmation emails, the following are intentionally deferred to other plans:

- **Scheduled touches** (balance reminders T-3, event-week, event-eve, drip enrollment, last-minute staffing, retention nudge): Plan 2a (money path) handles the scheduled balance emails; downstream plans handle the rest.
- **Reply-To header plumbing**: Plan 2a delivers this once. 2b assumes the header is being applied transparently by `sendEmail`.
- **Reschedule handling**: when admin changes event_date / start_time / location, the spec wants all future scheduled touches re-anchored AND a reschedule notification fired. That whole flow is its own plan (depends on Plan 1's scheduled_messages table + the admin reschedule action).
- **`scheduled_messages` row insertion**: Plan 2b touches are all immediate user-action sends, so no rows go into `scheduled_messages`. The dispatcher contract from Plan 2a is referenced for completeness but not used here.
- **Drink-plan-submitted ADMIN email rewrite**: the existing admin notification for drink-plan-with-addons stays as-is. Spec section 6 lists admin notification consolidation as a separate phase.
- **SMS variants of any touch**: Plan 3 (Stage 2 / two-way SMS) covers the SMS pairs the spec lists for orientation + drink plan nudge + post-consult.

---

## Open questions to flag during execution

These can be answered inline if they come up; not blockers but worth noting:

1. **`per_guest_timed` packages.** `isHostedPackage` checks only `per_guest`. If the pricing engine ever extends "hosted" to include `per_guest_timed`, update `deriveBarOption` in `orientationData.js` in lockstep. The current test pins behavior to the current check.
2. **Setup-minutes in the orientation timeline.** Currently hard-coded to 60. If we want event-aware setup minutes (90 for Hosted), thread the package row into `buildOrientationPayload` and compute via `effectiveSetupMinutes`. Low priority; V1 is "good enough."
3. **Orientation email Reply-To resilience.** If Plan 2a hasn't merged when 2b lands, the orientation goes out without Reply-To. Replies bounce to the no-reply alias instead of admin. Verify the order of merges before pushing.
