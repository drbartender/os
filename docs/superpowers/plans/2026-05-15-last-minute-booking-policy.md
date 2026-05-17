# Last-Minute Booking Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Force pay-in-full for bookings ≤14 days out, and add a refundable "staffing hold" (client warning + admin/staff SMS blast) for bookings ≤72h out.

**Architecture:** A single pure helper (`bookingWindow.js`) is the source of truth for the lead-time tier. The server enforces it at the payment-intent gate (reject deposit, never coerce). The Stripe webhook sets a `last_minute_hold` flag in-transaction and fires an SMS blast post-commit via a new single-responsibility util. The client UI hides the deposit option and shows a pre-payment cancellation warning, driven by a server-computed `payment_policy` block (never client-side date math).

**Tech Stack:** Node 18+/Express, raw SQL via `pg`, React 18 (CRA), Twilio (`server/utils/sms.js`), Stripe webhook. Tests: Node built-in runner (`node --test`) — the repo has no jest runner wired.

---

## Critical Correctness Notes (read before starting)

1. **Two different "last minute" signals — do not conflate them:**
   - `payment_policy` (computed live from the event date on every proposal fetch) drives the **pre-payment** UI. Before payment the stored flag is always false.
   - `proposals.last_minute_hold` (stored column, set by the webhook **after** payment) drives the **admin badge** and the auto-clear.
2. **The server gate REJECTS** a deposit attempt inside 14 days with a clear error. It must **never** silently upgrade a $100 deposit to a full charge.
3. **`server/routes/stripe.js` is 1113 lines and carries the `claude-allow-large-file` opt-out.** Keep additions there to a few lines — all blast logic lives in the new `server/utils/lastMinuteAlert.js`.
4. **Idempotency:** the webhook flag-set and blast run only inside the existing `if (isFirstDelivery)` guard so Stripe retries don't double-fire.

## File Structure

| File | Responsibility |
|---|---|
| `server/utils/bookingWindow.js` | **New.** Pure tier computation. Source of truth. |
| `server/utils/bookingWindow.test.js` | **New.** Built-in-runner unit tests. |
| `server/utils/lastMinuteAlert.js` | **New.** Resolve recipients + send admin/staff SMS blast. One responsibility. |
| `server/db/schema.sql` | `+ last_minute_hold` column (idempotent). |
| `server/routes/stripe.js` | Gate in `create-intent`; set flag in-tx + call blast post-commit (≤3 lines added). |
| `server/routes/proposals/publicToken.js` | Add `payment_policy` to `GET /t/:token`. |
| `server/routes/proposals/crud.js` | Add `p.last_minute_hold` to the admin GET select. |
| `server/utils/emailTemplates.js` | Conditional warning block in two client templates. |
| `server/routes/shifts.js` | Clear `last_minute_hold` when linked shift fully staffed. |
| `client/src/pages/proposal/proposalView/ProposalView.js` | Derive policy from `proposal.payment_policy`, pass props. |
| `client/src/pages/proposal/proposalView/SignAndPaySection.js` | Hide deposit/autopay when full required; render warning. |
| `client/src/pages/admin/ProposalDetail.js` | "Last-minute — verify staffing" badge. |
| `CLAUDE.md`, `.env.example`, `ARCHITECTURE.md` | Document `ADMIN_PHONE` + `bookingWindow`. |

---

### Task 1: `bookingWindow.js` pure helper (TDD)

**Files:**
- Create: `server/utils/bookingWindow.js`
- Test: `server/utils/bookingWindow.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/bookingWindow.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { getBookingWindow } = require('./bookingWindow');

// Fixed reference "now": 2026-05-15T12:00:00Z
const NOW = new Date('2026-05-15T12:00:00Z');
const H = 3600000;

test('event 30 days out → no constraints', () => {
  const w = getBookingWindow({ eventDate: '2026-06-14', eventStartTime: '17:00', now: NOW });
  assert.equal(w.fullPaymentRequired, false);
  assert.equal(w.lastMinuteHold, false);
});

test('event exactly 14 days out (336h) → full required, no hold', () => {
  // 2026-05-29T12:00:00Z is exactly 336h after NOW
  const w = getBookingWindow({ eventDate: '2026-05-29', eventStartTime: '12:00', now: NOW });
  assert.equal(w.fullPaymentRequired, true);
  assert.equal(w.lastMinuteHold, false);
});

test('event 10 days out → full required, no hold', () => {
  const w = getBookingWindow({ eventDate: '2026-05-25', eventStartTime: '17:00', now: NOW });
  assert.equal(w.fullPaymentRequired, true);
  assert.equal(w.lastMinuteHold, false);
});

test('event exactly 72h out → full required AND hold', () => {
  const w = getBookingWindow({ eventDate: '2026-05-18', eventStartTime: '12:00', now: NOW });
  assert.equal(w.fullPaymentRequired, true);
  assert.equal(w.lastMinuteHold, true);
});

test('event 24h out → full required AND hold', () => {
  const w = getBookingWindow({ eventDate: '2026-05-16', eventStartTime: '12:00', now: NOW });
  assert.equal(w.lastMinuteHold, true);
});

test('event in the past → full required AND hold (negative hours)', () => {
  const w = getBookingWindow({ eventDate: '2026-05-14', eventStartTime: '12:00', now: NOW });
  assert.ok(w.hoursUntilEvent < 0);
  assert.equal(w.lastMinuteHold, true);
});

test('null start time → treated as 00:00 UTC of event date', () => {
  // 2026-05-18T00:00:00Z is 60h after NOW → inside 72h
  const w = getBookingWindow({ eventDate: '2026-05-18', eventStartTime: null, now: NOW });
  assert.equal(w.lastMinuteHold, true);
});

test('accepts a Date object for eventDate', () => {
  const w = getBookingWindow({ eventDate: new Date('2026-06-14'), eventStartTime: '17:00', now: NOW });
  assert.equal(w.fullPaymentRequired, false);
});

test('hoursUntilEvent is a finite number', () => {
  const w = getBookingWindow({ eventDate: '2026-05-25', eventStartTime: '17:00', now: NOW });
  assert.equal(typeof w.hoursUntilEvent, 'number');
  assert.ok(Number.isFinite(w.hoursUntilEvent));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/bookingWindow.test.js`
Expected: FAIL — `Cannot find module './bookingWindow'`.

- [ ] **Step 3: Write minimal implementation**

Create `server/utils/bookingWindow.js`:

```js
/**
 * Pure lead-time tier computation. No DB, no side effects — the single source
 * of truth for booking-window policy. Mirrors the pricingEngine.js style.
 *
 * UTC math intentionally (consistent with the rest of the date code in this
 * codebase). No per-venue timezone — near-midnight edges may be off by a few
 * hours; accepted tradeoff.
 */

const FULL_PAYMENT_HOURS = 14 * 24; // 336 — reuses the existing balance_due_date window
const LAST_MINUTE_HOURS = 72;

function toUtcMs(eventDate, eventStartTime) {
  let y, m, d;
  if (eventDate instanceof Date) {
    y = eventDate.getUTCFullYear();
    m = eventDate.getUTCMonth();
    d = eventDate.getUTCDate();
  } else {
    const parts = String(eventDate).slice(0, 10).split('-').map(Number);
    y = parts[0]; m = parts[1] - 1; d = parts[2];
  }
  let hh = 0, mm = 0;
  if (eventStartTime) {
    const t = String(eventStartTime).split(':').map(Number);
    if (Number.isFinite(t[0])) hh = t[0];
    if (Number.isFinite(t[1])) mm = t[1];
  }
  return Date.UTC(y, m, d, hh, mm);
}

/**
 * @param {object} args
 * @param {string|Date} args.eventDate - 'YYYY-MM-DD' or a Date
 * @param {string|null} args.eventStartTime - 'HH:MM' (24h) or null
 * @param {Date} [args.now] - defaults to new Date()
 * @returns {{ hoursUntilEvent:number, fullPaymentRequired:boolean, lastMinuteHold:boolean }}
 */
function getBookingWindow({ eventDate, eventStartTime, now = new Date() }) {
  const eventMs = toUtcMs(eventDate, eventStartTime);
  const hoursUntilEvent = (eventMs - now.getTime()) / 3600000;
  return {
    hoursUntilEvent,
    fullPaymentRequired: hoursUntilEvent <= FULL_PAYMENT_HOURS,
    lastMinuteHold: hoursUntilEvent <= LAST_MINUTE_HOURS,
  };
}

module.exports = { getBookingWindow, FULL_PAYMENT_HOURS, LAST_MINUTE_HOURS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/bookingWindow.test.js`
Expected: PASS — `# pass 9`, `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git add server/utils/bookingWindow.js server/utils/bookingWindow.test.js
git commit -m "feat(booking): pure lead-time window helper (14d full / 72h hold)"
```

---

### Task 2: Schema — `last_minute_hold` column

**Files:**
- Modify: `server/db/schema.sql` (proposals payment block, immediately after the `balance_due_date` add ~line 890)

- [ ] **Step 1: Add the idempotent column**

In `server/db/schema.sql`, directly after `ALTER TABLE proposals ADD COLUMN IF NOT EXISTS balance_due_date DATE;`, add:

```sql
-- Set TRUE by the Stripe webhook when a paid booking is ≤72h out — drives the
-- admin "verify staffing" badge and clears when the linked shift is fully
-- staffed. Operational flag only; NOT a status enum value.
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS last_minute_hold BOOLEAN DEFAULT false;
```

- [ ] **Step 2: Apply to the dev database**

Run: `node server/db/seed.js`
Expected: completes without error (seed runs `schema.sql`; idempotent so safe to re-run).

- [ ] **Step 3: Verify the column exists**

Run:
```bash
node -e "require('dotenv').config();const{pool}=require('./server/db');pool.query(\"SELECT column_name,data_type,column_default FROM information_schema.columns WHERE table_name='proposals' AND column_name='last_minute_hold'\").then(r=>{console.log(r.rows);process.exit(0)})"
```
Expected: one row — `last_minute_hold | boolean | false`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(db): add proposals.last_minute_hold flag"
```

---

### Task 3: Server gate — reject deposit inside 14 days

**Files:**
- Modify: `server/routes/stripe.js` — the `create-intent/:token` handler (proposal SELECT ~line 101; gate inserted after the status checks ~line 118)

- [ ] **Step 1: Add `event_start_time` to the proposal SELECT**

In the `create-intent/:token` handler, the query currently selects:
`SELECT p.id, p.status, p.event_type, p.event_type_custom, p.total_price, p.event_date,`
Change that line to also select `p.event_start_time`:

```js
    SELECT p.id, p.status, p.event_type, p.event_type_custom, p.total_price,
           p.event_date, p.event_start_time,
           p.stripe_customer_id, p.deposit_amount,
```

- [ ] **Step 2: Add the require at the top of the file**

Near the other util requires at the top of `server/routes/stripe.js` (e.g. just after `const { createEventShifts } = require('../utils/eventCreation');`), add:

```js
const { getBookingWindow } = require('../utils/bookingWindow');
```

- [ ] **Step 3: Insert the gate**

Immediately after the existing block:
```js
  if (!['sent', 'viewed', 'accepted'].includes(proposal.status)) {
    throw new ConflictError('This proposal is not available for payment', 'NOT_PAYABLE');
  }
```
add:

```js
  // Inside 14 days, full payment is the only option. Reject a deposit attempt
  // outright — never silently upgrade the charge (the client expects $100).
  const bookingWindow = getBookingWindow({
    eventDate: proposal.event_date,
    eventStartTime: proposal.event_start_time,
  });
  if (bookingWindow.fullPaymentRequired && payment_option !== 'full') {
    throw new ConflictError(
      'This event is within 2 weeks — full payment is required to book.',
      'FULL_PAYMENT_REQUIRED'
    );
  }
```

(`ConflictError` is already imported in this file — confirm the import line `const { ... ConflictError ... } = require('../utils/errors');` near the top includes it; it does.)

- [ ] **Step 4: Manual verification**

Pick a proposal in `sent`/`viewed`/`accepted` status and temporarily set its date inside 14 days:
```bash
node -e "require('dotenv').config();const{pool}=require('./server/db');pool.query(\"UPDATE proposals SET event_date=CURRENT_DATE+5 WHERE id=(SELECT id FROM proposals WHERE status IN ('sent','viewed','accepted') ORDER BY id DESC LIMIT 1) RETURNING id,token,event_date\").then(r=>{console.log(r.rows);process.exit(0)})"
```
Start the server (`npm start` in another shell), then:
```bash
curl -s -X POST http://localhost:5000/api/stripe/create-intent/<TOKEN> -H "Content-Type: application/json" -d "{\"payment_option\":\"deposit\"}"
```
Expected: JSON error, code `FULL_PAYMENT_REQUIRED`, message "This event is within 2 weeks — full payment is required to book."

Then confirm full still works:
```bash
curl -s -X POST http://localhost:5000/api/stripe/create-intent/<TOKEN> -H "Content-Type: application/json" -d "{\"payment_option\":\"full\"}"
```
Expected: JSON `{ "clientSecret": "pi_..._secret_..." }`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(payments): require full payment for bookings within 14 days"
```

---

### Task 4: Expose `payment_policy` on the public proposal fetch

**Files:**
- Modify: `server/routes/proposals/publicToken.js` — `GET /t/:token` handler (response object ~line 83)

- [ ] **Step 1: Require the helper**

At the top of `server/routes/proposals/publicToken.js`, after the other requires (e.g. after `const { getEventTypeLabel } = require('../../utils/eventTypes');`), add:

```js
const { getBookingWindow } = require('../../utils/bookingWindow');
```

- [ ] **Step 2: Compute and attach `payment_policy`**

The handler ends with:
```js
  res.json({
    ...proposal,
    addons: addonsRes.rows,
    drink_plan_token: drinkPlanToken,
    status: proposal.status === 'sent' ? 'viewed' : proposal.status,
  });
```
Replace with:

```js
  const win = getBookingWindow({
    eventDate: proposal.event_date,
    eventStartTime: proposal.event_start_time,
  });

  res.json({
    ...proposal,
    addons: addonsRes.rows,
    drink_plan_token: drinkPlanToken,
    status: proposal.status === 'sent' ? 'viewed' : proposal.status,
    payment_policy: {
      full_payment_required: win.fullPaymentRequired,
      last_minute_hold: win.lastMinuteHold,
      hours_until_event: win.hoursUntilEvent,
    },
  });
```

- [ ] **Step 3: Add `event_start_time` to the public SELECT if absent**

Confirm the `SELECT` in this handler includes `p.event_start_time` — it does (`p.event_date, p.event_start_time, p.event_duration_hours,`). No change needed; if missing, add it to the allowlist.

- [ ] **Step 4: Manual verification**

```bash
curl -s http://localhost:5000/api/proposals/t/<TOKEN> | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).payment_policy))"
```
Expected: `{ full_payment_required: <bool>, last_minute_hold: <bool>, hours_until_event: <number> }` matching the proposal's date.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/publicToken.js
git commit -m "feat(proposals): expose computed payment_policy on public fetch"
```

---

### Task 5: Webhook — set `last_minute_hold` in-tx + SMS blast post-commit

**Files:**
- Create: `server/utils/lastMinuteAlert.js`
- Modify: `server/routes/stripe.js` — `payment_intent.succeeded` handler (in-tx block ~line 694–745; post-commit block ~line 870–885)

- [ ] **Step 1: Create the alert util**

Create `server/utils/lastMinuteAlert.js`:

```js
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendSMS, normalizePhone } = require('./sms');
const { getEventTypeLabel } = require('./eventTypes');
const { ADMIN_URL } = require('./urls');

/**
 * SMS blast for a ≤72h "staffing hold" booking. Admin gets a verify-staffing
 * alert; every active staffer with a phone gets a "grab it" broadcast.
 * Fully non-blocking — callers wrap in try/catch but this also self-guards.
 * Volume is bounded: ≤72h bookings are exception-only.
 */
async function notifyLastMinuteBooking(proposalId) {
  try {
    const { rows } = await pool.query(`
      SELECT p.id, p.event_date, p.event_start_time, p.event_location,
             p.event_type, p.event_type_custom, c.name AS client_name
      FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1
    `, [proposalId]);
    const p = rows[0];
    if (!p) return;

    const label = getEventTypeLabel({ event_type: p.event_type, event_type_custom: p.event_type_custom });
    const date = p.event_date
      ? new Date(p.event_date).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
      : 'TBD';
    const time = p.event_start_time || 'TBD';
    const loc = p.event_location || 'location TBD';

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

    // Staff broad net — every approved contractor with a phone. Sequential
    // send (Twilio throttle), same pattern as autoAssign.
    const staff = await pool.query(`
      SELECT cp.phone, cp.preferred_name
      FROM users u
      JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE u.onboarding_status = 'approved' AND cp.phone IS NOT NULL
    `);
    for (const s of staff.rows) {
      const phone = normalizePhone(s.phone);
      if (!phone) continue;
      try {
        await sendSMS({
          to: phone,
          body: `Last-minute gig ${date} ${time}, ${loc} (${label}). Open the app to grab it ASAP — Dr. Bartender`,
        });
      } catch (e) {
        console.error(`[lastMinuteAlert] staff SMS failed (${phone}):`, e.message);
      }
    }
  } catch (err) {
    console.error('[lastMinuteAlert] failed:', err.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, { tags: { feature: 'last-minute-alert', proposalId } });
    }
  }
}

module.exports = { notifyLastMinuteBooking };
```

- [ ] **Step 2: Require helpers in stripe.js**

At the top of `server/routes/stripe.js`, alongside the Task 3 require, add:

```js
const { notifyLastMinuteBooking } = require('../utils/lastMinuteAlert');
```

(`getBookingWindow` is already required from Task 3.)

- [ ] **Step 3: Set the flag in-transaction + capture intent**

In the `payment_intent.succeeded` handler, the handler scope already declares `let isFirstDelivery = false;`. Directly below that declaration add:

```js
      let isLastMinuteHold = false;
```

Inside the `if (isFirstDelivery) { ... }` block, after the payment-type status updates and before `await dbClient.query('COMMIT');`, add:

```js
          // Last-minute staffing hold: flag the proposal atomically with the
          // status change so the admin badge is consistent on commit.
          const lmRes = await dbClient.query(
            'SELECT event_date, event_start_time FROM proposals WHERE id = $1',
            [proposalId]
          );
          if (lmRes.rows[0]) {
            const w = getBookingWindow({
              eventDate: lmRes.rows[0].event_date,
              eventStartTime: lmRes.rows[0].event_start_time,
            });
            if (w.lastMinuteHold) {
              isLastMinuteHold = true;
              await dbClient.query(
                'UPDATE proposals SET last_minute_hold = true WHERE id = $1',
                [proposalId]
              );
            }
          }
```

- [ ] **Step 4: Fire the blast post-commit (idempotent)**

In the existing post-commit block:
```js
      if (isFirstDelivery) {
        sendPaymentNotifications(proposalId, intent.amount, paymentType);
        try {
          const shift = await createEventShifts(proposalId);
```
add the blast as the first line inside `if (isFirstDelivery) {`:

```js
      if (isFirstDelivery) {
        if (isLastMinuteHold) notifyLastMinuteBooking(proposalId);
        sendPaymentNotifications(proposalId, intent.amount, paymentType);
        try {
          const shift = await createEventShifts(proposalId);
```

(`notifyLastMinuteBooking` self-guards and is fire-and-forget; `isFirstDelivery` ensures Stripe retries don't re-blast.)

- [ ] **Step 5: Manual verification (DB-level, no real charge)**

Simulate: set a paid proposal's date ≤72h out, call the util directly with Twilio in dev-skip mode (no creds → logs instead of sends):
```bash
node -e "require('dotenv').config();const{notifyLastMinuteBooking}=require('./server/utils/lastMinuteAlert');const{pool}=require('./server/db');pool.query(\"SELECT id FROM proposals ORDER BY id DESC LIMIT 1\").then(async r=>{await notifyLastMinuteBooking(r.rows[0].id);process.exit(0)})"
```
Expected: console shows `[DEV] SMS skipped → ...` lines for admin (if `ADMIN_PHONE` set) and each approved staffer, or `ADMIN_PHONE unset — admin SMS skipped`. No throw.

- [ ] **Step 6: Commit**

```bash
git add server/utils/lastMinuteAlert.js server/routes/stripe.js
git commit -m "feat(booking): flag last-minute holds + admin/staff SMS blast on payment"
```

---

### Task 6: Client email warning block

**Files:**
- Modify: `server/utils/emailTemplates.js` — `paymentReceivedClient` (~line 91) and `signedAndPaidClient` (~line 107)

- [ ] **Step 1: Add a `lastMinute` param + warning to `paymentReceivedClient`**

Replace the `paymentReceivedClient` function with:

```js
function paymentReceivedClient({ clientName, eventTypeLabel = 'event', amount, paymentType, lastMinute = false }) {
  const name = clientName || 'there';
  const warn = lastMinute
    ? `<p style="background:#fff4e5;border-left:4px solid #d9822b;padding:12px 16px;font-size:14px;">
         <strong>One quick note:</strong> because your event is less than 72 hours away, your booking is
         confirmed subject to staff availability. In the rare case we can't staff it in time, we'll
         cancel and fully refund you right away.
       </p>`
    : '';
  return {
    subject: `Payment Received — your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Payment Received!</h2>
      <p>Hi ${name},</p>
      <p>We've received your <strong>${paymentType}</strong> of <strong>$${amount}</strong> for your <strong>${eventTypeLabel}</strong>.</p>
      ${warn}
      <p>Thank you! We'll be in touch with next steps as your event date approaches.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we've received your ${paymentType} of $${amount} for your ${eventTypeLabel}.${lastMinute ? ' Note: because your event is <72h away, your booking is confirmed subject to staff availability — in the rare case we cannot staff it we will cancel and fully refund you.' : ''} Thank you! — The Dr. Bartender Team`,
  };
}
```

- [ ] **Step 2: Add the same to `signedAndPaidClient`**

Replace the `signedAndPaidClient` function with:

```js
function signedAndPaidClient({ clientName, eventTypeLabel = 'event', amount, paymentType, lastMinute = false }) {
  const name = clientName || 'there';
  const warn = lastMinute
    ? `<p style="background:#fff4e5;border-left:4px solid #d9822b;padding:12px 16px;font-size:14px;">
         <strong>One quick note:</strong> because your event is less than 72 hours away, your booking is
         confirmed subject to staff availability. In the rare case we can't staff it in time, we'll
         cancel and fully refund you right away.
       </p>`
    : '';
  return {
    subject: `Signed & Paid — your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">You're Locked In!</h2>
      <p>Hi ${name},</p>
      <p>We've received your signed proposal <em>and</em> your <strong>${paymentType}</strong> of <strong>$${amount}</strong> for your <strong>${eventTypeLabel}</strong>. Your date is officially on the books.</p>
      ${warn}
      <p>We'll be in touch with next steps as your event date approaches.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we've received your signed proposal and your ${paymentType} of $${amount} for your ${eventTypeLabel}. Your date is officially on the books.${lastMinute ? ' Note: because your event is <72h away, your booking is confirmed subject to staff availability — in the rare case we cannot staff it we will cancel and fully refund you.' : ''} — The Dr. Bartender Team`,
  };
}
```

- [ ] **Step 3: Pass `lastMinute` from the webhook notifier**

In `server/routes/stripe.js`, inside `sendPaymentNotifications(proposalId, amountCents, paymentType)`, the `payInfo` query selects proposal fields. Add `p.last_minute_hold` to that SELECT:

```js
        SELECT p.event_type, p.event_type_custom, p.client_signed_at, p.last_minute_hold,
               c.name AS client_name, c.email AS client_email
```
Then in the two client-template calls in that function, pass `lastMinute: !!pi?.last_minute_hold`:

```js
        const tpl = isCoupledSigning
          ? emailTemplates.signedAndPaidClient({ clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute: !!pi?.last_minute_hold })
          : emailTemplates.paymentReceivedClient({ clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute: !!pi?.last_minute_hold });
```

(Ordering note: Task 5 sets `last_minute_hold` in-tx and commits before the post-commit `sendPaymentNotifications` call, so the flag is readable here.)

- [ ] **Step 4: Manual verification**

```bash
node -e "const t=require('./server/utils/emailTemplates');console.log(t.signedAndPaidClient({clientName:'Test',eventTypeLabel:'wedding',amount:'500.00',paymentType:'full payment',lastMinute:true}).text)"
```
Expected: text includes the "<72h away ... cancel and fully refund you" sentence. Re-run with `lastMinute:false` → sentence absent.

- [ ] **Step 5: Commit**

```bash
git add server/utils/emailTemplates.js server/routes/stripe.js
git commit -m "feat(email): last-minute cancellation caveat in client payment emails"
```

---

### Task 7: Client UI — hide deposit + show warning

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js` (props derivation ~line 35, render ~line 316–359)
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js` (both modes)

- [ ] **Step 1: Derive policy in ProposalView**

In `ProposalView.js`, after `const [paymentOption, setPaymentOption] = useState('deposit');`, the component reads `proposal` from state. Where `proposal` is known non-null (the render section near line 259, alongside `const isAlreadySigned = ...`), add:

```js
  const policy = proposal.payment_policy || {};
  const fullPaymentRequired = !!policy.full_payment_required;
  const lastMinuteHold = !!policy.last_minute_hold;
```

- [ ] **Step 2: Force `full` when required**

In `ProposalView.js`, add an effect after the existing payment-intent effect (after the `}, [isPayableStatus, paymentOption, ...]);` block ~line 135):

```js
  // When the server says full payment is required, lock the option to 'full'
  // so the intent effect requests the correct amount.
  React.useEffect(() => {
    if (fullPaymentRequired && paymentOption !== 'full') {
      setPaymentOption('full');
      setAutopayChecked(false);
    }
  }, [fullPaymentRequired, paymentOption]);
```

(`React` is imported in this file as the default import — if it uses named hooks, use `useEffect` consistently with the existing code style in this file.)

- [ ] **Step 3: Pass the two flags into both SignAndPaySection usages**

In both `<SignAndPaySection ... />` blocks (the `mode="signAndPay"` and `mode="payOnly"` instances), add these props:

```js
                fullPaymentRequired={fullPaymentRequired}
                lastMinuteHold={lastMinuteHold}
```

- [ ] **Step 4: Consume the flags in SignAndPaySection**

In `client/src/pages/proposal/proposalView/SignAndPaySection.js`, add `fullPaymentRequired` and `lastMinuteHold` to the destructured props (after `setAutopayChecked,`):

```js
  fullPaymentRequired,
  lastMinuteHold,
```

Then create a shared warning element near the top of the component body (after `const autopayLabel = ...;`):

```js
  const fullRequiredNotice = fullPaymentRequired ? (
    <p className="payment-policy-note">
      Because your event is within 2 weeks, full payment is required to confirm your booking.
    </p>
  ) : null;

  const lastMinuteWarning = lastMinuteHold ? (
    <p className="payment-policy-warn">
      Heads up — because this event is less than 72 hours away, your booking is confirmed
      subject to staff availability. In the rare case we can't staff it in time, we'll cancel
      and fully refund you.
    </p>
  ) : null;
```

- [ ] **Step 5: Render conditionally — `signAndPay` mode**

In the `signAndPay` block, replace the payment-options group:

```jsx
        {/* Payment Options */}
        <div>
          <label className="sign-pay-eyebrow">How would you like to pay?</label>

          <PaymentTablet
            selected={depositSelected}
            onSelect={() => setPaymentOption('deposit')}
            value="deposit"
            label={`Pay ${fmt(DEPOSIT_DOLLARS)} Deposit`}
            amount={fmt(DEPOSIT_DOLLARS)}
            desc={`Remaining ${fmt(balanceAmount)} due before your event`}
            showAutopay={depositSelected && balanceAmount > 0}
            autopayChecked={autopayChecked}
            setAutopayChecked={setAutopayChecked}
            autopayLabel={autopayLabel}
          />
          <PaymentTablet
            selected={fullSelected}
            onSelect={() => { setPaymentOption('full'); setAutopayChecked(false); }}
            value="full"
            label="Pay in Full"
            amount={fmt(totalPrice)}
            desc="No remaining balance"
          />
        </div>
```

with:

```jsx
        {/* Payment Options */}
        <div>
          <label className="sign-pay-eyebrow">How would you like to pay?</label>

          {!fullPaymentRequired && (
            <PaymentTablet
              selected={depositSelected}
              onSelect={() => setPaymentOption('deposit')}
              value="deposit"
              label={`Pay ${fmt(DEPOSIT_DOLLARS)} Deposit`}
              amount={fmt(DEPOSIT_DOLLARS)}
              desc={`Remaining ${fmt(balanceAmount)} due before your event`}
              showAutopay={depositSelected && balanceAmount > 0}
              autopayChecked={autopayChecked}
              setAutopayChecked={setAutopayChecked}
              autopayLabel={autopayLabel}
            />
          )}
          <PaymentTablet
            selected={fullSelected || fullPaymentRequired}
            onSelect={() => { setPaymentOption('full'); setAutopayChecked(false); }}
            value="full"
            label="Pay in Full"
            amount={fmt(totalPrice)}
            desc="No remaining balance"
          />
          {fullRequiredNotice}
          {lastMinuteWarning}
        </div>
```

- [ ] **Step 6: Render conditionally — `payOnly` mode**

Apply the identical transformation to the `payOnly` block's payment-options `<div>` (same two changes: wrap the deposit `PaymentTablet` in `{!fullPaymentRequired && (...)}`, set the full tablet `selected={fullSelected || fullPaymentRequired}`, and add `{fullRequiredNotice}{lastMinuteWarning}` after the full tablet).

- [ ] **Step 7: Add styles**

In `client/src/index.css`, add:

```css
.payment-policy-note { font-size: 0.85rem; color: var(--ink, #333); margin-top: 0.75rem; }
.payment-policy-warn {
  font-size: 0.85rem;
  margin-top: 0.75rem;
  padding: 0.6rem 0.8rem;
  background: #fff4e5;
  border-left: 3px solid #d9822b;
  border-radius: 4px;
}
```

- [ ] **Step 8: Manual verification**

Run `npm run dev`. Open a proposal link whose event is >14 days out → both Deposit and Pay-in-Full show. Update that proposal's `event_date` to 5 days out, reload → Deposit tablet gone, notice shown. Update to 2 days out, reload → notice + amber cancellation warning both shown above the pay button.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/proposal/proposalView/ProposalView.js client/src/pages/proposal/proposalView/SignAndPaySection.js client/src/index.css
git commit -m "feat(proposal-ui): hide deposit + show last-minute warning inside policy windows"
```

---

### Task 8: Admin badge + crud GET select

**Files:**
- Modify: `server/routes/proposals/crud.js` (admin GET select ~line 51)
- Modify: `client/src/pages/admin/ProposalDetail.js`

- [ ] **Step 1: Add `last_minute_hold` to the admin proposal GET**

In `server/routes/proposals/crud.js`, the admin GET select currently includes:
`p.deposit_amount, p.balance_due_date, p.payment_type, p.autopay_enrolled,`
Add the column:

```js
           p.deposit_amount, p.balance_due_date, p.payment_type, p.autopay_enrolled,
           p.last_minute_hold,
```

- [ ] **Step 2: Render the badge**

In `client/src/pages/admin/ProposalDetail.js`, locate where the proposal status is displayed (search the file for `status` rendering near the proposal header). Add, adjacent to the status:

```jsx
{proposal.last_minute_hold && (
  <span className="lm-hold-badge" title="Booked ≤72h out — verify staff availability">
    ⚠ Last-minute — verify staffing
  </span>
)}
```

- [ ] **Step 3: Add the badge style**

In `client/src/index.css`, add:

```css
.lm-hold-badge {
  display: inline-block;
  margin-left: 0.5rem;
  padding: 0.15rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  color: #8a4b00;
  background: #ffe9cc;
  border: 1px solid #d9822b;
  border-radius: 999px;
  vertical-align: middle;
}
```

- [ ] **Step 4: Manual verification**

Set a recent proposal's flag and load its admin detail page:
```bash
node -e "require('dotenv').config();const{pool}=require('./server/db');pool.query(\"UPDATE proposals SET last_minute_hold=true WHERE id=(SELECT id FROM proposals ORDER BY id DESC LIMIT 1) RETURNING id\").then(r=>{console.log(r.rows);process.exit(0)})"
```
Open `/proposals/<id>` in the admin app → amber "Last-minute — verify staffing" badge visible by the status. Reset the flag to `false` afterward.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/crud.js client/src/pages/admin/ProposalDetail.js client/src/index.css
git commit -m "feat(admin): last-minute hold badge on proposal detail"
```

---

### Task 9: Auto-clear `last_minute_hold` when the shift is fully staffed

**Files:**
- Modify: `server/routes/shifts.js` — the `POST /:id/assign` handler (~line 478) and the `PUT /requests/:requestId` handler (~line 569), both of which produce an `approved` request.

- [ ] **Step 1: Add a shared clear helper at the bottom of shifts.js (before `module.exports`)**

```js
/**
 * If every position on this shift's linked proposal is now filled, clear the
 * proposal's last-minute hold. "Fully staffed" = approved shift_requests count
 * >= positions_needed length (same definition autoAssign uses).
 */
async function clearHoldIfFullyStaffed(shiftId) {
  try {
    const s = await pool.query(
      'SELECT proposal_id, positions_needed FROM shifts WHERE id = $1',
      [shiftId]
    );
    const row = s.rows[0];
    if (!row || !row.proposal_id) return;
    const needed = JSON.parse(row.positions_needed || '[]').length;
    if (needed <= 0) return;
    const a = await pool.query(
      "SELECT COUNT(*)::int AS n FROM shift_requests WHERE shift_id = $1 AND status = 'approved'",
      [shiftId]
    );
    if (a.rows[0].n >= needed) {
      await pool.query(
        'UPDATE proposals SET last_minute_hold = false WHERE id = $1 AND last_minute_hold = true',
        [row.proposal_id]
      );
    }
  } catch (e) {
    console.error('[shifts] clearHoldIfFullyStaffed failed (non-blocking):', e.message);
  }
}
```

- [ ] **Step 2: Call it from `POST /:id/assign`**

In the `POST /:id/assign` handler, after the SMS/email notification blocks and before `res.status(201).json(request);`, add:

```js
  await clearHoldIfFullyStaffed(req.params.id);
```

- [ ] **Step 3: Call it from `PUT /requests/:requestId` on approval**

In the `PUT /requests/:requestId` handler, inside the `if (status === 'approved') { ... }` branch, after the SMS block, add (the handler has the request row; resolve its shift id):

```js
    try {
      const sidRes = await pool.query('SELECT shift_id FROM shift_requests WHERE id = $1', [req.params.requestId]);
      if (sidRes.rows[0]) await clearHoldIfFullyStaffed(sidRes.rows[0].shift_id);
    } catch (e) {
      console.error('[shifts] hold-clear lookup failed (non-blocking):', e.message);
    }
```

- [ ] **Step 4: Manual verification**

Pick a shift linked to a proposal flagged `last_minute_hold=true` with one position. Approve a staffer for it via the admin UI (or `PUT /api/shifts/requests/:id` with `{"status":"approved"}`). Then:
```bash
node -e "require('dotenv').config();const{pool}=require('./server/db');pool.query('SELECT id,last_minute_hold FROM proposals WHERE id=$1',[<PROPOSAL_ID>]).then(r=>{console.log(r.rows);process.exit(0)})"
```
Expected: `last_minute_hold` is now `false`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/shifts.js
git commit -m "feat(shifts): clear last-minute hold when linked shift fully staffed"
```

---

### Task 10: Documentation

**Files:**
- Modify: `.env.example`, `CLAUDE.md`, `ARCHITECTURE.md`

- [ ] **Step 1: `.env.example`**

After the `ADMIN_EMAIL=admin@example.com` line, add:

```
# Optional. E.164 phone for last-minute (<72h) booking SMS alerts to the owner.
# If unset, the admin SMS leg is skipped (staff blast still fires).
ADMIN_PHONE=+1xxxxxxxxxx
```

- [ ] **Step 2: `CLAUDE.md` Environment Variables table**

Add a row after the `ADMIN_FEEDBACK_NOTIFICATION_EMAIL` row:

```
| `ADMIN_PHONE` | Optional. E.164 number for last-minute (<72h) booking SMS alerts. Unset → admin SMS skipped; staff blast still fires. |
```

- [ ] **Step 3: `ARCHITECTURE.md`**

In the server utilities section, add a line:

```
- `utils/bookingWindow.js` — pure lead-time tier (14-day full-payment / 72-hour staffing-hold) computation; source of truth for booking-window policy.
- `utils/lastMinuteAlert.js` — admin + broad-net staff SMS blast for ≤72h "staffing hold" bookings.
```

Add a short subsection under the payments/proposals architecture area:

```
**Booking-window policy.** Bookings ≤14 days out require full payment (deposit
rejected at the payment-intent gate). Bookings ≤72h out additionally set
`proposals.last_minute_hold`, warn the client (pre-payment + email) that the
booking is subject to staff availability with full refund if unstaffable, and
trigger an admin + staff SMS blast. The hold clears automatically when the
linked shift is fully staffed. Refunds on the rare unstaffable case are manual
(Stripe dashboard) by deliberate scope choice.
```

- [ ] **Step 4: Commit**

```bash
git add .env.example CLAUDE.md ARCHITECTURE.md
git commit -m "docs: document ADMIN_PHONE + booking-window policy"
```

---

## Self-Review

**Spec coverage:**
- Tier model / boundaries → Task 1 (helper), Task 3 (gate), Task 4 (policy exposure). ✓
- Charge unchanged / full sidesteps autopay → no change to charge path; gate only rejects deposit. ✓
- `last_minute_hold` schema → Task 2. ✓
- Webhook flag in-tx + SMS blast post-commit, idempotent, correct `sendSMS` signature, broad-net staff, `ADMIN_PHONE` → Task 5. ✓
- Client warning pre-payment + email → Task 6 (email), Task 7 (UI). ✓
- Hide deposit/autopay inside windows → Task 7. ✓
- Admin badge → Task 8. ✓
- Auto-clear on full staffing (autoAssign's definition) → Task 9. ✓
- Manual refund (no code) → explicitly documented, no task — correct. ✓
- Docs (`ADMIN_PHONE`, `bookingWindow`) → Task 10. ✓
- Out-of-scope `autoAssign.js:317` bug → not touched by any task (correct; flagged in spec only). ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code; every verification step has an exact command + expected output. ✓

**Type consistency:** `getBookingWindow({ eventDate, eventStartTime, now })` → `{ hoursUntilEvent, fullPaymentRequired, lastMinuteHold }` used identically in Tasks 1, 3, 4, 5. `payment_policy` keys (`full_payment_required`, `last_minute_hold`, `hours_until_event`) produced in Task 4, consumed in Task 7. `notifyLastMinuteBooking(proposalId)` defined Task 5, called Task 5. `clearHoldIfFullyStaffed(shiftId)` defined and called in Task 9. `lastMinute` email param defined and passed in Task 6. ✓
