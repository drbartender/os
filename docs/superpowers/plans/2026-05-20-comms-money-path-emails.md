# Automated Communication — Money-Path Emails + Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## What This Resolves (Gemini design-review pass, 2026-05-20)

Coordinated revisions across Plans 2a/b/c/d apply five Gemini design-stage findings. Plan 2a is the load-bearing piece that owns the cross-cutting fixes:

- **Finding 1 (BLOCKER) — Shared message-type registry.** `registerHandler(messageType, handlerFn, options)` now accepts `{ offsetFromEventDate, category, anchor }` metadata so Plan 2c's reschedule cascade can look up the offset for ANY message type (including Plan 2d marketing rows) via a new `getHandlerMeta(messageType)` lookup.
- **Finding 3 (WARNING) — Shared suppression check.** Plan 2a exports `shouldSendImmediate({ proposal, client, channel })` so every immediate-send code path (orientation, post-consult, reschedule-notification, etc.) honors archive cascade + per-channel comm prefs + bad-contact status before it sends.
- **Finding 5 (WARNING) — Dispatcher marketing gate.** The dispatcher checks handler metadata at fire-time and suppresses with `'marketing_disabled'` when `category === 'marketing'` and `client.communication_preferences.marketing_enabled === false`.

The remaining two findings (Finding 2 atomic reschedule, Finding 4 retention TZ) live in Plans 2c and 2d respectively.

## What This Resolves (Pre-execution review, 2026-05-20)

A second-pass pre-execution review against the shared-contract ground truth surfaced eight additional findings (three BLOCKERs that would fail at runtime / test time, and five WARNINGs spanning coverage gaps, edge-case data loss, and docs drift). All eight are addressed in this revision:

- **BLOCKER B1 — `ON CONFLICT ON CONSTRAINT idx_scheduled_messages_pending_uniq` rejected by PostgreSQL.** Postgres only accepts named CONSTRAINTS in `ON CONFLICT ON CONSTRAINT`, not named partial unique INDEXES. Task 8's `scheduleMessage` helper now uses the column-list inference form (`ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel) WHERE status = 'pending' DO NOTHING`) which matches the partial unique index declared in Task 1.
- **BLOCKER B2 — Dispatcher test INSERTs non-existent `proposals.client_name` / `proposals.client_email` columns.** Those columns live on `clients`, not `proposals`. Task 9's test setup now inserts a `clients` row first (with an existence check since `clients` has no UNIQUE on email), then inserts a `proposals` row with `client_id` set.
- **BLOCKER B3 — Dispatcher test passes a string for `proposals.token` (UUID column).** Task 9's test setup omits `token` from the INSERT so the column default (`gen_random_uuid()`) fires.
- **WARNING W1 — `users.phone` column does not exist in `lookupRecipient` SELECT.** Staff phone numbers live on `contractor_profiles`. The dispatcher's `lookupRecipient` now selects `id, email, role, communication_preferences` only — Plan 2b/2d staff handlers fetch phone separately when they need it.
- **WARNING W2 — `messageSuppression.test.js` was missing from the self-review test-file checklist.** Added.
- **WARNING W3 — No test coverage for the marketing-gate suppression path.** Task 9 now includes a dedicated test that registers a marketing-category handler, flips `marketing_enabled` to false, and asserts the row is suppressed with `marketing_disabled`.
- **WARNING W4 — `scheduleBalanceReminders` past-date cutoff dropped today-due reminders.** The original `dueDate.getTime() < Date.now()` would silently skip the `balance_due_today` row for last-minute bookings that deposit on the same day the balance is due. Now uses a start-of-today UTC cutoff so only strictly past dates are skipped.
- **WARNING W5 — `ADMIN_EMAIL` runtime dependency not reflected in env docs.** Task 2 makes `ADMIN_EMAIL` a runtime requirement for the default `Reply-To` on every client-facing email; Task 14 now updates CLAUDE.md (new row) and README.md (refines existing row) to document the elevated role.

Em dashes in NEW client-facing copy (subject lines and text sign-offs in the new templates) were also swept and replaced with commas / colons / periods per project preference (`feedback_no_em_dashes`). Existing baselined em dashes in templates not authored here (e.g., the default branch of `paymentReceivedClient`) are preserved.

---

**Goal:** Ship the money-path client emails (balance reminders, autopay success, payment failure, refund notification) and the dispatcher infrastructure that all other Plan 2 chunks (drink-plan touches, event-week/eve, post-event) will build on. Plan 2a is the load-bearing piece of Phase 1 from the spec — it introduces the scheduling helper, the dispatcher loop, handler registration, suppression checks, and the first batch of registered handlers (balance reminders).

**Architecture:** Three concentric layers. (1) Template surface — new `refundNotificationClient`, new `paymentFailedClient`, variant-aware `paymentReminderClient` (autopay vs manual) plus new `paymentReminderLate` (T+1 / T+3), tightened autopay-specific copy on `paymentReceivedClient`. (2) Scheduling helper `messageScheduling.scheduleMessage(...)` that inserts idempotent rows into the existing `scheduled_messages` table (Plan 1). (3) Dispatcher utility `scheduledMessageDispatcher` that runs every 5 min, picks pending rows, joins entity + recipient, runs suppression checks (archive cascade, comm-prefs, email_status), and calls a handler registered by message_type. Stripe webhook on `payment_intent.succeeded` (deposit-paid transition) schedules the appropriate balance reminders; refund and payment-failure paths fire client emails immediately.

**Tech Stack:** Node.js 18+ / Express 4.18, PostgreSQL (raw SQL via `pg`), Resend (server-side email), `node:test` + `node:assert/strict` against the live dev DB, Sentry for failure capture.

**Related:** Spec `docs/superpowers/specs/2026-05-20-automated-communication-design.md` (commit 6d86c0b) sections 3.1–3.6, 3.14, 7.3, 7.5, 8.2. Plan 1 (foundation) `docs/superpowers/plans/2026-05-20-automated-communication-foundation.md` (already shipped — provides `scheduled_messages`, `scheduler_health`, `schedulerHealth.wrapScheduler/clearHealthRow`, `eventTimezone`, archive cascade).

---

## File Structure

**Files to create:**
- `server/utils/messageScheduling.js` — `scheduleMessage(...)` helper, idempotent insert into `scheduled_messages`
- `server/utils/messageScheduling.test.js` — unit tests against live DB (insert / duplicate / no-op pattern)
- `server/utils/messageSuppression.js` — `shouldSendImmediate({ proposal, client, channel })` shared check used by every immediate-send path across Plans 2b / 2c (archive cascade, per-channel comm prefs, bad-contact status). Single source of truth so Plans 2b's orientation/postConsult and 2c's rescheduleNotificationClient honor the same rules the dispatcher applies on scheduled rows.
- `server/utils/messageSuppression.test.js` — unit tests for each suppression branch
- `server/utils/scheduledMessageDispatcher.js` — pending-row loop, suppression checks, handler registry with metadata, marketing-class gate, built-in money-path handlers
- `server/utils/scheduledMessageDispatcher.test.js` — unit tests for handler registry + metadata + suppression + marketing gate + dispatch

**Files to modify:**
- `server/utils/email.js` — default `replyTo` to `process.env.ADMIN_EMAIL` for client-facing emails
- `server/utils/emailTemplates.js` — add `refundNotificationClient`, add `paymentFailedClient`, modify `paymentReminderClient` to accept `paymentMode`, add `paymentReminderLate`, tighten autopay-mode copy on `paymentReceivedClient`
- `server/routes/stripe.js` — (a) collapse coupled-sign+pay admin emails to `signedAndPaidAdmin` only (already partial; tighten), (b) on deposit-paid transition, call `messageScheduling.scheduleMessage(...)` to enroll balance reminders, (c) fire `paymentFailedClient` on `payment_intent.payment_failed`, (d) call autopay-specific `paymentReceivedClient` variant when paymentType === 'balance' on the deposit-paid → balance-paid transition
- `server/routes/stripe.js` — refund route (`POST /api/stripe/refund/:id`) fires `refundNotificationClient` after successful reconciliation
- `server/index.js` — register dispatcher under new `RUN_MESSAGE_DISPATCHER_SCHEDULER` env var following the Plan 1 pattern (5-min cadence, `wrapScheduler('message_dispatcher', 300, ...)`, `clearHealthRow` in the else-branch)
- `.env.example` — add `RUN_MESSAGE_DISPATCHER_SCHEDULER`
- `.claude/CLAUDE.md` — env table: add `RUN_MESSAGE_DISPATCHER_SCHEDULER`
- `README.md` — env table: add `RUN_MESSAGE_DISPATCHER_SCHEDULER`
- `server/db/schema.sql` — append a partial unique index for the `scheduled_messages` idempotency key (only required if not already present from Plan 1)

**Files referenced (no edits):**
- `server/utils/schedulerHealth.js` — provides `wrapScheduler`, `clearHealthRow`
- `server/utils/eventTimezone.js` — provides `resolveEventTimezone`, `formatEventLocalTime`
- `server/utils/email.js` — `sendEmail({ to, subject, html, text, replyTo, attachments })`
- `server/utils/urls.js` — `PUBLIC_SITE_URL`, `ADMIN_URL`
- `server/utils/eventTypes.js` — `getEventTypeLabel({ event_type, event_type_custom })`
- `server/db/index.js` — `pool`

---

## Task 1: Add partial unique index to `scheduled_messages` for idempotency

**Files:**
- Modify: `server/db/schema.sql`

The `messageScheduling.scheduleMessage` helper is idempotent by `(entity_id, entity_type, message_type, recipient_id, recipient_type, channel)`. We rely on a partial unique index restricted to status='pending' so duplicate enrollments while a row is pending are a constraint violation, while "send a fresh reminder for the next cycle" stays legal after the prior row flips to 'sent'.

- [ ] **Step 1: Append the index block to `schema.sql`**

```sql
-- ─── Automated Communication Plan 2a: scheduled_messages idempotency ────
-- Partial unique index: only enforce uniqueness while the row is still pending.
-- Once a row flips to 'sent' / 'failed' / 'suppressed', a new pending row for the
-- same (entity, message_type, recipient, channel) tuple is legal again (e.g.,
-- a late T+1 reminder after the T-3 reminder already fired).
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_messages_pending_uniq
  ON scheduled_messages (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
  WHERE status = 'pending';
```

- [ ] **Step 2: Apply and verify**

Restart the dev server (Claude-managed background process — kill the existing PID on port 5000 and relaunch per `reference_dev_server_process` memory) so `schema.sql` reapplies. Then:

```bash
psql "$DATABASE_URL" -c "\\d scheduled_messages"
```

Expected: the new partial unique index appears in the index list.

- [ ] **Step 3: Smoke-test the constraint**

```bash
psql "$DATABASE_URL" << 'EOF'
BEGIN;
INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
VALUES (999999, 'proposal', 'idem_test', 'client', 999999, 'email', NOW() + INTERVAL '1 hour');
-- Same tuple again should fail
INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
VALUES (999999, 'proposal', 'idem_test', 'client', 999999, 'email', NOW() + INTERVAL '2 hours');
ROLLBACK;
EOF
```

Expected: first insert succeeds, second errors with `duplicate key value violates unique constraint "idx_scheduled_messages_pending_uniq"`.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(comms): partial unique index on scheduled_messages for idempotent enrollment"
```

---

## Task 2: Add default `replyTo` on `sendEmail`

**Files:**
- Modify: `server/utils/email.js`

The spec rule (7.9): every client-facing email gets `Reply-To: <admin_email>` so client replies land in the admin inbox. Today `sendEmail` only sets `reply_to` when the caller passes it. Default it to `process.env.ADMIN_EMAIL` so the dozens of existing callers gain the behavior with zero per-callsite change. Callers that pass an explicit `replyTo` still win.

- [ ] **Step 1: Patch `sendEmail`**

In `server/utils/email.js`, locate the `sendEmail` function. Change the destructuring + the spread line so `replyTo` falls back to `process.env.ADMIN_EMAIL`:

Before:
```javascript
async function sendEmail({ to, subject, html, text, from, replyTo, attachments }) {
  // ...
  const { data, error } = await resend.emails.send({
    from: from || FROM_EMAIL,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(text && { text }),
    ...(replyTo && { reply_to: replyTo }),
    ...(attachments && attachments.length && { attachments }),
  });
```

After:
```javascript
async function sendEmail({ to, subject, html, text, from, replyTo, attachments }) {
  // ...
  const effectiveReplyTo = replyTo || process.env.ADMIN_EMAIL || null;
  const { data, error } = await resend.emails.send({
    from: from || FROM_EMAIL,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(text && { text }),
    ...(effectiveReplyTo && { reply_to: effectiveReplyTo }),
    ...(attachments && attachments.length && { attachments }),
  });
```

Apply the same change to `sendBatchEmails` so each formatted email picks up the default:

Before (inside `.map`):
```javascript
...(e.reply_to && { reply_to: e.reply_to }),
```

After:
```javascript
reply_to: e.reply_to || process.env.ADMIN_EMAIL || undefined,
```

(Use `undefined` in the spread-less form so Resend's SDK skips the field when not set — Resend rejects an empty string.)

- [ ] **Step 2: Verify lint passes**

```bash
npx eslint server/utils/email.js
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/utils/email.js
git commit -m "feat(email): default replyTo to ADMIN_EMAIL on sendEmail and sendBatchEmails"
```

---

## Task 3: Modify `paymentReminderClient` to accept `paymentMode`

**Files:**
- Modify: `server/utils/emailTemplates.js`

Spec sections 3.1 (autopay path) and 3.4 (non-autopay path) call for the same touch at T-3 days but with different framing: autopay version reassures the client "no action needed, card on file runs automatically"; manual version asks the client to log in and pay. Single template with a `paymentMode` arg keeps the surface small.

- [ ] **Step 1: Read the current `paymentReminderClient`**

Read `server/utils/emailTemplates.js` lines 178-199 to see the current implementation.

- [ ] **Step 2: Replace with the variant-aware version**

Replace the existing `paymentReminderClient` function (lines 178-199) with:

```javascript
/**
 * Balance reminder T-3 days.
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} opts.eventTypeLabel
 * @param {number} opts.balanceDue - dollars (number)
 * @param {string|Date} opts.balanceDueDate
 * @param {string} opts.proposalUrl
 * @param {'autopay'|'manual'} [opts.paymentMode='manual'] - autopay → "no action needed" copy; manual → "log in and pay"
 * @param {string} [opts.last4] - last 4 digits of saved card; only rendered in autopay mode when provided
 */
function paymentReminderClient({ clientName, eventTypeLabel = 'event', balanceDue, balanceDueDate, proposalUrl, paymentMode = 'manual', last4 }) {
  const name = clientName || 'there';
  const dueDate = balanceDueDate
    ? new Date(balanceDueDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' })
    : 'before your event';
  const isAutopay = paymentMode === 'autopay';
  const subject = isAutopay
    ? `Heads up: balance for your ${eventTypeLabel} runs in 3 days`
    : `Balance due in 3 days for your ${eventTypeLabel}`;
  const cardLine = isAutopay && last4
    ? `<p>Your card ending in <strong>${esc(String(last4))}</strong> will be charged automatically. No action needed.</p>`
    : isAutopay
      ? `<p>Your card on file will be charged automatically. No action needed.</p>`
      : '';
  const cta = isAutopay
    ? ctaButton(proposalUrl, 'Use a different card or pay early')
    : ctaButton(proposalUrl, 'View &amp; Pay Balance');
  const intro = isAutopay
    ? `Your remaining balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> for your <strong>${esc(eventTypeLabel)}</strong> runs on <strong>${dueDate}</strong>.`
    : `A heads up that your balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> for your <strong>${esc(eventTypeLabel)}</strong> is due on <strong>${dueDate}</strong>.`;
  const footer = isAutopay
    ? `<p style="font-size:14px;color:${BRAND.secondary};">We'll send a receipt once it's charged. Reply with any questions.</p>`
    : `<p style="font-size:14px;color:${BRAND.secondary};">If you've already taken care of this or have any questions, just reply to this email.</p>`;
  const textIntro = isAutopay
    ? `Your remaining balance of $${Number(balanceDue).toFixed(2)} for your ${eventTypeLabel} runs on ${dueDate}${last4 ? ` on the card ending in ${last4}` : ' on your card on file'}.`
    : `A heads up that your balance of $${Number(balanceDue).toFixed(2)} for your ${eventTypeLabel} is due on ${dueDate}.`;
  return {
    subject,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Balance Reminder</h2>
      <p>Hi ${esc(name)},</p>
      <p>${intro}</p>
      ${cardLine}
      ${cta}
      ${footer}
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, ${textIntro} ${isAutopay ? 'No action needed. Pay early or change card: ' : 'View and pay: '}${proposalUrl}. Cheers, The Dr. Bartender Team`,
  };
}
```

The existing callsite (admin manual-send route) passes no `paymentMode`, so it defaults to `'manual'` — that path keeps working unchanged.

- [ ] **Step 3: Verify default-arg back-compat**

```bash
grep -rn "paymentReminderClient(" server/
```

Inspect each existing call — confirm none rely on the old signature breaking. The only existing callsite is the manual-send admin route; it passes `{clientName, eventTypeLabel, balanceDue, balanceDueDate, proposalUrl}` — matches the new signature (paymentMode falls through to 'manual').

- [ ] **Step 4: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(comms): paymentReminderClient supports autopay vs manual variants"
```

---

## Task 4: Add `paymentReminderLate` template for T+1 / T+3 tier

**Files:**
- Modify: `server/utils/emailTemplates.js`

Spec section 3.6 — non-autopay clients who haven't paid by their due date get a gentler T+1 reminder and a firmer T+3 reminder. Same template, `daysLate` parameter switches tone.

- [ ] **Step 1: Append the new function**

Insert the following function right after `paymentReminderClient` in `server/utils/emailTemplates.js`:

```javascript
/**
 * Late balance reminder (T+1 gentle, T+3 firmer). Only for non-autopay path —
 * autopay clients have the charge run automatically on the due date, so a "late"
 * touch doesn't apply.
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} opts.eventTypeLabel
 * @param {number} opts.balanceDue - dollars
 * @param {string} opts.proposalUrl
 * @param {1|3} opts.daysLate - 1 → gentle, 3 → firmer
 */
function paymentReminderLate({ clientName, eventTypeLabel = 'event', balanceDue, proposalUrl, daysLate }) {
  const name = clientName || 'there';
  const firm = daysLate >= 3;
  const subject = firm
    ? `Balance ${daysLate} days past due for your ${eventTypeLabel}, please reach out`
    : `Balance now ${daysLate} day past due for your ${eventTypeLabel}`;
  const bodyOpen = firm
    ? `Your balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> for your <strong>${esc(eventTypeLabel)}</strong> is now <strong>${daysLate} days past due</strong>.`
    : `Your balance of <strong>$${Number(balanceDue).toFixed(2)}</strong> for your <strong>${esc(eventTypeLabel)}</strong> is <strong>${daysLate} day past due</strong>.`;
  const closeLine = firm
    ? `<p>If something has changed or you need to talk through options, please reach out directly so we can sort this out together.</p>`
    : `<p>Reach out if you need help or want to talk this through.</p>`;
  return {
    subject,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">${firm ? 'Balance Past Due' : 'Balance Reminder'}</h2>
      <p>Hi ${esc(name)},</p>
      <p>${bodyOpen}</p>
      ${ctaButton(proposalUrl, 'View &amp; Pay Balance')}
      ${closeLine}
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your balance of $${Number(balanceDue).toFixed(2)} for your ${eventTypeLabel} is ${daysLate} ${daysLate === 1 ? 'day' : 'days'} past due. Pay here: ${proposalUrl}. ${firm ? 'Please reach out so we can sort this out together.' : 'Reach out if you need help.'} Cheers, The Dr. Bartender Team`,
  };
}
```

- [ ] **Step 2: Export it**

In the `module.exports = { ... }` block at the bottom of `server/utils/emailTemplates.js`, add `paymentReminderLate,` near `paymentReminderClient,`.

- [ ] **Step 3: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(comms): paymentReminderLate template for T+1 and T+3 tier"
```

---

## Task 5: Add `refundNotificationClient` template

**Files:**
- Modify: `server/utils/emailTemplates.js`

Spec section 3.14. Fires from the refund admin route after Stripe + reconciliation succeed.

- [ ] **Step 1: Append the new function**

Insert right after `paymentReminderLate`:

```javascript
/**
 * Refund issued — client confirmation. Always fires when admin issues a refund
 * (full or partial), no suppression (rare touch, money out, never want it skipped).
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {number} opts.refundAmount - dollars
 * @param {string} [opts.last4] - last 4 of card refunded to (omit line if not available)
 * @param {number|null} opts.newBalance - dollars; if null or <= 0, render "no balance remaining" line
 */
function refundNotificationClient({ clientName, refundAmount, last4, newBalance }) {
  const name = clientName || 'there';
  const cardLine = last4
    ? ` to your card ending in <strong>${esc(String(last4))}</strong>`
    : '';
  const cardLineText = last4 ? ` to your card ending in ${last4}` : '';
  const balanceLine = (newBalance == null || Number(newBalance) <= 0)
    ? `<p>This refund covers the full amount; no balance remaining.</p>`
    : `<p>New balance: <strong>$${Number(newBalance).toFixed(2)}</strong>.</p>`;
  const balanceLineText = (newBalance == null || Number(newBalance) <= 0)
    ? 'This refund covers the full amount; no balance remaining.'
    : `New balance: $${Number(newBalance).toFixed(2)}.`;
  return {
    subject: `Refund issued for your account`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Refund Issued</h2>
      <p>Hi ${esc(name)},</p>
      <p>We've refunded <strong>$${Number(refundAmount).toFixed(2)}</strong>${cardLine}. It should arrive in 5-10 business days depending on your bank.</p>
      ${balanceLine}
      <p style="font-size:14px;color:${BRAND.secondary};">Let me know if you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we've refunded $${Number(refundAmount).toFixed(2)}${cardLineText}. It should arrive in 5-10 business days. ${balanceLineText} Cheers, The Dr. Bartender Team`,
  };
}
```

- [ ] **Step 2: Export it**

Add `refundNotificationClient,` to `module.exports`.

- [ ] **Step 3: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(comms): refundNotificationClient template for admin refund flow"
```

---

## Task 6: Add `paymentFailedClient` template

**Files:**
- Modify: `server/utils/emailTemplates.js`

Spec section 3.3. Fires immediately when Stripe webhook reports a failed charge (autopay attempt or one-off). Separate from the existing admin throttled email.

- [ ] **Step 1: Append the new function**

Insert right after `refundNotificationClient`:

```javascript
/**
 * Payment failure — client notification. Fires immediately on Stripe
 * `payment_intent.payment_failed`. Separate from the existing admin throttled
 * email. Throttle (one per 24h per proposal) is enforced by the caller, not
 * the template.
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} opts.eventTypeLabel
 * @param {string} [opts.last4] - last 4 of card that failed (omit if unavailable)
 * @param {string} opts.proposalUrl - link for the client to update payment method
 */
function paymentFailedClient({ clientName, eventTypeLabel = 'event', last4, proposalUrl }) {
  const name = clientName || 'there';
  const cardClause = last4
    ? ` on the card ending in <strong>${esc(String(last4))}</strong>`
    : '';
  const cardClauseText = last4 ? ` on the card ending in ${last4}` : '';
  return {
    subject: `Payment didn't go through for your ${eventTypeLabel}`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Payment Didn't Go Through</h2>
      <p>Hi ${esc(name)},</p>
      <p>Your payment for the <strong>${esc(eventTypeLabel)}</strong> didn't go through${cardClause}.</p>
      ${ctaButton(proposalUrl, 'Update Payment Method')}
      <p>If you have any questions or need help, reply to this email or call me.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, your payment for the ${eventTypeLabel} didn't go through${cardClauseText}. Update payment method: ${proposalUrl}. Reach out if you need help. Cheers, The Dr. Bartender Team`,
  };
}
```

- [ ] **Step 2: Export it**

Add `paymentFailedClient,` to `module.exports`.

- [ ] **Step 3: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(comms): paymentFailedClient template for Stripe failure path"
```

---

## Task 7: Tighten `paymentReceivedClient` for autopay-success framing

**Files:**
- Modify: `server/utils/emailTemplates.js`

Spec section 3.2 — when autopay successfully charges the balance, the client message reads differently than when a one-off payment is taken (focus on "you're paid in full" and confirmation that the autopay ran). Parameterize the existing function rather than create a new one.

- [ ] **Step 1: Patch `paymentReceivedClient`**

Replace the existing function (lines 109-124) with:

```javascript
/**
 * Payment received — client confirmation.
 *
 * @param {Object} opts
 * @param {string} opts.clientName
 * @param {string} opts.eventTypeLabel
 * @param {string|number} opts.amount - dollar amount paid (string OK, formatted by caller)
 * @param {string} opts.paymentType - e.g. 'deposit', 'balance payment', 'autopay balance'
 * @param {boolean} [opts.lastMinute=false] - append the <72h cancellation caveat
 * @param {string} [opts.eventDateLabel] - optional formatted event date (e.g. "June 12")
 * @param {string} [opts.last4] - last 4 of card charged; rendered in autopay mode
 * @param {boolean} [opts.autopay=false] - autopay-success framing (tighter copy, you're-paid-in-full focus)
 */
function paymentReceivedClient({ clientName, eventTypeLabel = 'event', amount, paymentType, lastMinute = false, eventDateLabel, last4, autopay = false }) {
  const name = clientName || 'there';
  if (autopay) {
    const eventBit = eventDateLabel ? ` on ${esc(eventDateLabel)}` : '';
    const cardBit = last4 ? ` on the card ending in ${esc(String(last4))}` : ' on your card on file';
    return {
      subject: `Balance charged: you're paid in full${eventDateLabel ? ` for ${esc(eventDateLabel)}` : ''}`,
      html: wrapEmail(`
        <h2 style="color:${BRAND.primary};margin-top:0;">You're Paid in Full</h2>
        <p>Hi ${esc(name)},</p>
        <p>Your remaining balance of <strong>$${amount}</strong> for your <strong>${esc(eventTypeLabel)}</strong>${eventBit} just ran${cardBit}. You're paid in full.</p>
        <p>Looking forward to the event.</p>
        <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
        <p>Cheers,<br/>The Dr. Bartender Team</p>
      `),
      text: `Hi ${name}, your remaining balance of $${amount} for your ${eventTypeLabel}${eventBit} just ran${last4 ? ` on the card ending in ${last4}` : ' on your card on file'}. You're paid in full. Cheers, The Dr. Bartender Team`,
    };
  }
  // Default (non-autopay) flow — preserves the existing copy
  return {
    subject: `Payment Received — your ${eventTypeLabel} — Dr. Bartender`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Payment Received!</h2>
      <p>Hi ${name},</p>
      <p>We've received your <strong>${paymentType}</strong> of <strong>$${amount}</strong> for your <strong>${eventTypeLabel}</strong>.</p>
      ${lastMinuteCaveatHtml(lastMinute)}
      <p>Thank you! We'll be in touch with next steps as your event date approaches.</p>
      <p style="font-size:14px;color:${BRAND.secondary};">If you have any questions, just reply to this email.</p>
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${name}, we've received your ${paymentType} of $${amount} for your ${eventTypeLabel}.${lastMinuteCaveatText(lastMinute)} Thank you! — The Dr. Bartender Team`,
  };
}
```

The default branch is byte-identical to the existing template. Only the autopay branch is new behavior.

- [ ] **Step 2: Verify no existing callers break**

```bash
grep -rn "paymentReceivedClient(" server/
```

Existing callers in `server/routes/stripe.js` pass only the original args (clientName/eventTypeLabel/amount/paymentType/lastMinute) and don't set `autopay: true`. They'll hit the default branch unchanged. Task 8 below modifies the balance-paid path to set `autopay: true` when appropriate.

- [ ] **Step 3: Commit**

```bash
git add server/utils/emailTemplates.js
git commit -m "feat(comms): paymentReceivedClient supports autopay-specific framing"
```

---

## Task 8: Build `messageScheduling.scheduleMessage` helper (TDD)

**Files:**
- Create: `server/utils/messageScheduling.js`
- Create: `server/utils/messageScheduling.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/utils/messageScheduling.test.js`:

```javascript
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { scheduleMessage } = require('./messageScheduling');

beforeEach(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'test_%'");
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'test_%'");
  await pool.end();
});

test('messageScheduling > inserts a new pending row', async () => {
  const row = await scheduleMessage({
    entityType: 'proposal',
    entityId: 12345,
    messageType: 'test_balance_t3',
    recipientType: 'client',
    recipientId: 999,
    channel: 'email',
    scheduledFor: new Date(Date.now() + 24 * 3600 * 1000),
  });
  assert.ok(row);
  assert.ok(row.id > 0);
  assert.strictEqual(row.status, 'pending');

  const check = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE message_type = 'test_balance_t3' AND entity_id = 12345 AND status = 'pending'"
  );
  assert.strictEqual(Number(check.rows[0].count), 1);
});

test('messageScheduling > returns null on duplicate enrollment for the same pending tuple', async () => {
  const args = {
    entityType: 'proposal',
    entityId: 12346,
    messageType: 'test_dup',
    recipientType: 'client',
    recipientId: 888,
    channel: 'email',
    scheduledFor: new Date(Date.now() + 24 * 3600 * 1000),
  };
  const first = await scheduleMessage(args);
  assert.ok(first);
  const second = await scheduleMessage(args);
  assert.strictEqual(second, null);

  const check = await pool.query(
    "SELECT count(*) FROM scheduled_messages WHERE message_type = 'test_dup' AND entity_id = 12346 AND status = 'pending'"
  );
  assert.strictEqual(Number(check.rows[0].count), 1);
});

test('messageScheduling > allows re-scheduling after the prior row moves out of pending', async () => {
  const args = {
    entityType: 'proposal',
    entityId: 12347,
    messageType: 'test_reschedule',
    recipientType: 'client',
    recipientId: 777,
    channel: 'email',
    scheduledFor: new Date(Date.now() + 24 * 3600 * 1000),
  };
  const first = await scheduleMessage(args);
  await pool.query("UPDATE scheduled_messages SET status = 'sent', sent_at = NOW() WHERE id = $1", [first.id]);

  const second = await scheduleMessage(args);
  assert.ok(second);
  assert.notStrictEqual(second.id, first.id);
});

test('messageScheduling > rejects an invalid channel before hitting the constraint', async () => {
  await assert.rejects(
    () => scheduleMessage({
      entityType: 'proposal',
      entityId: 12348,
      messageType: 'test_bad_channel',
      recipientType: 'client',
      recipientId: 555,
      channel: 'fax',
      scheduledFor: new Date(),
    }),
    /channel/i
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/utils/messageScheduling.test.js
```

Expected: FAIL with `Cannot find module './messageScheduling'`.

- [ ] **Step 3: Implement the helper**

Create `server/utils/messageScheduling.js`:

```javascript
const { pool } = require('../db');

const VALID_ENTITY_TYPES = new Set(['proposal', 'shift', 'client', 'consult']);
const VALID_RECIPIENT_TYPES = new Set(['client', 'staff', 'admin']);
const VALID_CHANNELS = new Set(['email', 'sms']);

/**
 * Schedule a future message delivery. Idempotent on the tuple
 * (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
 * for rows still in 'pending' status — uses the partial unique index added in
 * Plan 2a Task 1.
 *
 * Returns the inserted row on success, or `null` when the tuple already has a
 * pending row (the caller can treat that as "already scheduled — no-op").
 *
 * @param {Object} args
 * @param {'proposal'|'shift'|'client'|'consult'} args.entityType
 * @param {number} args.entityId
 * @param {string} args.messageType - free-form identifier (e.g. 'balance_reminder_autopay_t3')
 * @param {'client'|'staff'|'admin'} args.recipientType
 * @param {number} args.recipientId
 * @param {'email'|'sms'} args.channel
 * @param {Date|string} args.scheduledFor
 * @returns {Promise<{id: number, status: string} | null>}
 */
async function scheduleMessage({
  entityType,
  entityId,
  messageType,
  recipientType,
  recipientId,
  channel,
  scheduledFor,
}) {
  if (!VALID_ENTITY_TYPES.has(entityType)) {
    throw new Error(`scheduleMessage: invalid entityType '${entityType}'`);
  }
  if (!VALID_RECIPIENT_TYPES.has(recipientType)) {
    throw new Error(`scheduleMessage: invalid recipientType '${recipientType}'`);
  }
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`scheduleMessage: invalid channel '${channel}'`);
  }
  if (!messageType || typeof messageType !== 'string') {
    throw new Error('scheduleMessage: messageType is required');
  }
  if (!Number.isInteger(entityId) || !Number.isInteger(recipientId)) {
    throw new Error('scheduleMessage: entityId and recipientId must be integers');
  }

  const result = await pool.query(
    `INSERT INTO scheduled_messages
       (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (entity_id, entity_type, message_type, recipient_id, recipient_type, channel)
       WHERE status = 'pending'
     DO NOTHING
     RETURNING id, status`,
    [entityId, entityType, messageType, recipientType, recipientId, channel, scheduledFor]
  );

  if (result.rowCount === 0) return null;
  return result.rows[0];
}

module.exports = { scheduleMessage };
```

Note on the ON CONFLICT clause: PostgreSQL only accepts named CONSTRAINTS in `ON CONFLICT ON CONSTRAINT`, not named partial unique INDEXES. So we use the column-list inference form with the `WHERE status = 'pending'` predicate to match the partial unique index. The column order matches the index definition in Task 1.

- [ ] **Step 4: Run test to verify pass**

```bash
node --test server/utils/messageScheduling.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/messageScheduling.js server/utils/messageScheduling.test.js
git commit -m "feat(comms): messageScheduling helper for idempotent scheduled_messages enrollment"
```

---

## Task 8.5: Build `messageSuppression.js` — shared immediate-send check (Gemini Finding 3)

**Files:**
- Create: `server/utils/messageSuppression.js`
- Create: `server/utils/messageSuppression.test.js`

Plans 2b and 2c each have immediate-send code paths (orientation email, post-consult, rescheduleNotificationClient, drink-plan-submitted confirmations) that today bypass the suppression rules the dispatcher enforces on scheduled rows. That's a hole — an archived proposal could still receive an orientation email, and a client with `email_enabled: false` could still receive a reschedule notification.

This task adds a single source-of-truth function those immediate-send paths must call before invoking `sendEmail`. The dispatcher's own suppression check (the `checkSuppression` function inside `scheduledMessageDispatcher.js`) is kept in sync with this utility.

- [ ] **Step 1: Write the failing test**

Create `server/utils/messageSuppression.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shouldSendImmediate } = require('./messageSuppression');

const okProposal = { id: 1, status: 'deposit_paid' };
const okClient = {
  id: 99,
  email: 'ok@example.com',
  phone: '+15551234567',
  communication_preferences: { email_enabled: true, sms_enabled: true, marketing_enabled: true },
  email_status: 'ok',
  phone_status: 'ok',
};

test('shouldSendImmediate > returns ok when everything is fine (email)', async () => {
  const result = await shouldSendImmediate({ proposal: okProposal, client: okClient, channel: 'email' });
  assert.deepStrictEqual(result, { ok: true });
});

test('shouldSendImmediate > returns ok when everything is fine (sms)', async () => {
  const result = await shouldSendImmediate({ proposal: okProposal, client: okClient, channel: 'sms' });
  assert.deepStrictEqual(result, { ok: true });
});

test('shouldSendImmediate > archived proposal blocks everything', async () => {
  const result = await shouldSendImmediate({
    proposal: { ...okProposal, status: 'archived' },
    client: okClient,
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'archived' });
});

test('shouldSendImmediate > email_enabled=false blocks email', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, communication_preferences: { ...okClient.communication_preferences, email_enabled: false } },
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'channel_disabled' });
});

test('shouldSendImmediate > email_enabled=false does NOT block sms', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, communication_preferences: { ...okClient.communication_preferences, email_enabled: false } },
    channel: 'sms',
  });
  assert.deepStrictEqual(result, { ok: true });
});

test('shouldSendImmediate > sms_enabled=false blocks sms', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, communication_preferences: { ...okClient.communication_preferences, sms_enabled: false } },
    channel: 'sms',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'channel_disabled' });
});

test('shouldSendImmediate > email_status=bad blocks email', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, email_status: 'bad' },
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'bad_contact' });
});

test('shouldSendImmediate > phone_status=bad blocks sms', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, phone_status: 'bad' },
    channel: 'sms',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'bad_contact' });
});

test('shouldSendImmediate > null client.communication_preferences treated as all-enabled', async () => {
  // Defensive default — if prefs JSON is null (legacy clients pre-Plan 1
  // migration), assume opt-in. Plan 1 backfilled defaults but the check
  // stays for safety.
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: { ...okClient, communication_preferences: null },
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: true });
});

test('shouldSendImmediate > missing client returns ok:false with bad_contact', async () => {
  const result = await shouldSendImmediate({
    proposal: okProposal,
    client: null,
    channel: 'email',
  });
  assert.deepStrictEqual(result, { ok: false, reason: 'bad_contact' });
});

test('shouldSendImmediate > unknown channel throws', async () => {
  await assert.rejects(
    () => shouldSendImmediate({ proposal: okProposal, client: okClient, channel: 'fax' }),
    /channel/i
  );
});
```

- [ ] **Step 2: Verify failing**

```bash
node --test server/utils/messageSuppression.test.js
```

Expected: FAIL with `Cannot find module './messageSuppression'`.

- [ ] **Step 3: Implement the utility**

Create `server/utils/messageSuppression.js`:

```javascript
const VALID_CHANNELS = new Set(['email', 'sms']);

/**
 * Decide whether an immediate-send code path should proceed.
 *
 * Single source of truth for archive cascade + comm-prefs + bad-contact
 * checks. Plans 2b and 2c immediate sends MUST call this before invoking
 * sendEmail / sendSMS. The dispatcher's own suppression check (in
 * scheduledMessageDispatcher.checkSuppression) enforces the same rules
 * on scheduled rows — keep the two in sync if a rule changes.
 *
 * @param {Object} args
 * @param {Object} args.proposal - must include `.status` (one of the
 *   proposal_status enum values). Pass the row you already loaded; this
 *   function does no I/O.
 * @param {Object|null} args.client - clients row, must include
 *   `.communication_preferences`, `.email_status`, `.phone_status`.
 *   Missing client → bad_contact (no one to send to).
 * @param {'email'|'sms'} args.channel
 * @returns {Promise<{ok: true} | {ok: false, reason: 'archived' | 'channel_disabled' | 'bad_contact'}>}
 */
async function shouldSendImmediate({ proposal, client, channel }) {
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`shouldSendImmediate: invalid channel '${channel}'`);
  }
  if (proposal && proposal.status === 'archived') {
    return { ok: false, reason: 'archived' };
  }
  if (!client) {
    return { ok: false, reason: 'bad_contact' };
  }
  const prefs = client.communication_preferences || {};
  if (channel === 'email') {
    if (prefs.email_enabled === false) return { ok: false, reason: 'channel_disabled' };
    if (client.email_status === 'bad') return { ok: false, reason: 'bad_contact' };
  } else if (channel === 'sms') {
    if (prefs.sms_enabled === false) return { ok: false, reason: 'channel_disabled' };
    if (client.phone_status === 'bad') return { ok: false, reason: 'bad_contact' };
  }
  return { ok: true };
}

module.exports = { shouldSendImmediate };
```

- [ ] **Step 4: Run tests, verify pass**

```bash
node --test server/utils/messageSuppression.test.js
```

Expected: all 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/messageSuppression.js server/utils/messageSuppression.test.js
git commit -m "feat(comms): shared shouldSendImmediate suppression check for immediate-send paths"
```

---

## Task 9: Build `scheduledMessageDispatcher` (TDD)

**Files:**
- Create: `server/utils/scheduledMessageDispatcher.js`
- Create: `server/utils/scheduledMessageDispatcher.test.js`

The dispatcher runs every 5 min. Each tick:
1. Pull pending rows where `scheduled_for <= NOW()` ordered by `scheduled_for` (oldest first).
2. For each row, look up the entity (proposal/shift/client/consult) and recipient (clients or users).
3. Run suppression: archived-proposal cascade, communication_preferences.email_enabled (for email channel), clients.email_status='bad' (for email channel). Suppression flips status to 'suppressed' with a reason in `error_message`.
4. Look up the handler registered for the row's `message_type`. If no handler, flip to 'failed' with `error_message='no handler registered'`.
5. Call the handler. Mark 'sent' on success, 'failed' (with error.message) on throw.

Built-in handlers registered at module load: `balance_reminder_autopay_t3`, `balance_reminder_non_autopay_t3`, `balance_due_today`, `balance_late_t1`, `balance_late_t3`.

- [ ] **Step 1: Write the failing test**

Create `server/utils/scheduledMessageDispatcher.test.js`:

```javascript
const { test, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  registerHandler,
  _clearHandlersForTest,
  dispatchPending,
  _handlersForTest,
} = require('./scheduledMessageDispatcher');

// Use unique-per-test client/proposal IDs so we don't collide with real data.
// Setup: create a throwaway client + proposal once, reuse across tests.
let testClientId;
let testProposalId;

before(async () => {
  // proposals has NO client_name / client_email columns — those live on `clients`
  // and are joined via proposals.client_id. We create the clients row first, then
  // the proposals row. `clients` has no UNIQUE constraint on email, so we look up
  // any existing test row before inserting to avoid orphaning rows across runs.
  const existing = await pool.query(
    "SELECT id FROM clients WHERE email = 'dispatcher-test@example.com' LIMIT 1"
  );
  if (existing.rowCount > 0) {
    testClientId = existing.rows[0].id;
  } else {
    const c = await pool.query(
      `INSERT INTO clients (name, email, phone) VALUES ('Dispatcher Test', 'dispatcher-test@example.com', '5555550100')
       RETURNING id`
    );
    testClientId = c.rows[0].id;
  }
  // proposals.token is UUID with default gen_random_uuid() — omit it so the
  // default fires (a string literal would error with `invalid input syntax for
  // type uuid`).
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_type, total_price, amount_paid, balance_due_date)
     VALUES ($1, 'deposit_paid', CURRENT_DATE + INTERVAL '30 days', 'birthday-party', 100000, 10000, CURRENT_DATE + INTERVAL '14 days')
     RETURNING id`,
    [testClientId]
  );
  testProposalId = p.rows[0].id;
});

after(async () => {
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'disp_test_%'");
  await pool.query('DELETE FROM proposals WHERE id = $1', [testProposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [testClientId]);
  await pool.end();
});

beforeEach(async () => {
  _clearHandlersForTest();
  await pool.query("DELETE FROM scheduled_messages WHERE message_type LIKE 'disp_test_%'");
});

test('dispatcher > calls the registered handler and marks status sent', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_simple', handler);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_simple', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 1);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_simple'"
  );
  assert.strictEqual(rows[0].status, 'sent');
});

test('dispatcher > marks status failed when handler throws and stores the error', async () => {
  registerHandler('disp_test_throws', async () => { throw new Error('handler boom'); });

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_throws', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_throws'"
  );
  assert.strictEqual(rows[0].status, 'failed');
  assert.ok(rows[0].error_message.includes('handler boom'));
});

test('dispatcher > marks status suppressed when proposal is archived', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_archived', handler);

  // archive the proposal
  await pool.query("UPDATE proposals SET status = 'archived', archive_reason = 'client_cancelled' WHERE id = $1", [testProposalId]);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_archived', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_archived'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /archived/i);

  // restore for the next tests
  await pool.query("UPDATE proposals SET status = 'deposit_paid', archive_reason = NULL WHERE id = $1", [testProposalId]);
});

test('dispatcher > marks status suppressed when client has email_enabled=false', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_optout', handler);

  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{email_enabled}', 'false'::jsonb) WHERE id = $1`,
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
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_optout'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /email_enabled/);

  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{email_enabled}', 'true'::jsonb) WHERE id = $1`,
    [testClientId]
  );
});

test('dispatcher > marks status suppressed when client.email_status is bad', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_bademail', handler);

  await pool.query("UPDATE clients SET email_status = 'bad' WHERE id = $1", [testClientId]);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_bademail', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_bademail'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /email_status/);

  await pool.query("UPDATE clients SET email_status = 'ok' WHERE id = $1", [testClientId]);
});

test('dispatcher > skips rows whose scheduled_for is in the future', async () => {
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_future', handler);

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_future', 'client', $2, 'email', NOW() + INTERVAL '1 hour')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status FROM scheduled_messages WHERE message_type = 'disp_test_future'"
  );
  assert.strictEqual(rows[0].status, 'pending');
});

test('dispatcher > marks failed with "no handler registered" when handler is missing', async () => {
  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_nohandler', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_nohandler'"
  );
  assert.strictEqual(rows[0].status, 'failed');
  assert.match(rows[0].error_message, /no handler/i);
});

test('dispatcher > suppresses marketing-category handler when marketing_enabled=false', async () => {
  // Gemini Finding 5: marketing-category messages are gated on
  // communication_preferences.marketing_enabled. Operational messages bypass
  // this gate; marketing messages flip to 'suppressed' with reason
  // 'marketing_disabled'. Plan 2d's drip touches register with
  // category='marketing'; we simulate that here.
  const handler = mock.fn(async () => undefined);
  registerHandler('disp_test_marketing', handler, { category: 'marketing', anchor: 'created_at', offsetFromEventDate: null });

  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{marketing_enabled}', 'false'::jsonb) WHERE id = $1`,
    [testClientId]
  );

  await pool.query(
    `INSERT INTO scheduled_messages (entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for)
     VALUES ($1, 'proposal', 'disp_test_marketing', 'client', $2, 'email', NOW() - INTERVAL '1 minute')`,
    [testProposalId, testClientId]
  );

  await dispatchPending();
  assert.strictEqual(handler.mock.callCount(), 0);
  const { rows } = await pool.query(
    "SELECT status, error_message FROM scheduled_messages WHERE message_type = 'disp_test_marketing'"
  );
  assert.strictEqual(rows[0].status, 'suppressed');
  assert.match(rows[0].error_message, /marketing_disabled/);

  // restore
  await pool.query(
    `UPDATE clients SET communication_preferences = jsonb_set(communication_preferences, '{marketing_enabled}', 'true'::jsonb) WHERE id = $1`,
    [testClientId]
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/utils/scheduledMessageDispatcher.test.js
```

Expected: FAIL with `Cannot find module './scheduledMessageDispatcher'`.

- [ ] **Step 3: Implement the dispatcher (core + built-in handlers)**

Create `server/utils/scheduledMessageDispatcher.js`:

```javascript
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const emailTemplates = require('./emailTemplates');
const { getEventTypeLabel } = require('./eventTypes');
const { PUBLIC_SITE_URL } = require('./urls');

// ─── Handler registry ──────────────────────────────────────────
// Keyed by message_type. Handler signature:
//   async ({ entity, recipient, scheduledMessage }) => void
// Throwing flips the row to 'failed'.
//
// Each registered handler carries metadata used by:
//   - Plan 2c rescheduleProposal to look up the offset and recompute
//     scheduled_for when an event date / balance due date changes
//   - The dispatcher itself to gate marketing-class messages on the
//     client's communication_preferences.marketing_enabled flag

const handlers = new Map();
const handlerMeta = new Map();

const VALID_ANCHORS = new Set(['event_date', 'balance_due_date', 'created_at', 'completed_at']);
const VALID_CATEGORIES = new Set(['operational', 'marketing']);

/**
 * Register a handler with optional metadata.
 *
 * @param {string} messageType
 * @param {Function} handlerFn  async ({ entity, recipient, scheduledMessage }) => void
 * @param {Object} [options]
 * @param {number|null} [options.offsetFromEventDate]
 *   Seconds offset from the anchor (negative = before, positive = after).
 *   null means the message is anchor-independent (e.g., drip touches anchored
 *   to proposal-sent timestamp, not event date) and is NOT re-anchored on
 *   reschedule.
 * @param {'event_date'|'balance_due_date'|'created_at'|'completed_at'} [options.anchor='event_date']
 *   Which field on the entity the offset is measured from. Plan 2c's
 *   reschedule cascade uses this to know whether to recompute from
 *   the new event_date, the new balance_due_date, etc.
 * @param {'operational'|'marketing'} [options.category='operational']
 *   Operational messages bypass the marketing-enabled gate (transactional
 *   under CAN-SPAM). Marketing messages are suppressed when the recipient
 *   has marketing_enabled = false.
 */
function registerHandler(messageType, handlerFn, options = {}) {
  if (typeof handlerFn !== 'function') {
    throw new Error(`registerHandler: handlerFn for '${messageType}' must be a function`);
  }
  const meta = {
    offsetFromEventDate: options.offsetFromEventDate == null ? null : Number(options.offsetFromEventDate),
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

/**
 * Look up the metadata for a registered message_type. Returns null when no
 * handler is registered (caller should treat that as "leave the row alone").
 *
 * Consumed primarily by Plan 2c's `reanchorPendingMessages` so the reschedule
 * cascade can recompute scheduled_for for every pending row regardless of
 * which plan registered it (2a balance reminders, 2c event-week / T-30, 2d
 * marketing). This replaces Plan 2c's local `messageOffsets` constant per
 * Gemini Finding 1.
 *
 * @param {string} messageType
 * @returns {{offsetFromEventDate: number|null, anchor: string, category: string} | null}
 */
function getHandlerMeta(messageType) {
  return handlerMeta.get(messageType) || null;
}

function _clearHandlersForTest() {
  handlers.clear();
  handlerMeta.clear();
}

function _handlersForTest() {
  return handlers;
}

// ─── Built-in suppression checks ──────────────────────────────

async function checkSuppression({ row, entity, recipient }) {
  // Archived-proposal cascade — universal rule per spec section 7.1.
  if (row.entity_type === 'proposal' && entity && entity.status === 'archived') {
    return 'archived: proposal is archived, cascade rule applies';
  }
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
  return null;
}

// ─── Entity / recipient lookups ──────────────────────────────

async function lookupEntity(entityType, entityId) {
  if (entityType === 'proposal') {
    const r = await pool.query(
      `SELECT id, status, event_date, event_type, event_type_custom, total_price, amount_paid, balance_due_date,
              autopay_enrolled, client_id, token, event_timezone
       FROM proposals WHERE id = $1`,
      [entityId]
    );
    return r.rows[0] || null;
  }
  if (entityType === 'client') {
    const r = await pool.query('SELECT id, name, email, phone FROM clients WHERE id = $1', [entityId]);
    return r.rows[0] || null;
  }
  if (entityType === 'shift') {
    const r = await pool.query('SELECT * FROM shifts WHERE id = $1', [entityId]);
    return r.rows[0] || null;
  }
  if (entityType === 'consult') {
    const r = await pool.query('SELECT * FROM consults WHERE id = $1', [entityId]);
    return r.rows[0] || null;
  }
  return null;
}

async function lookupRecipient(recipientType, recipientId) {
  if (recipientType === 'client') {
    const r = await pool.query(
      `SELECT id, name, email, phone, communication_preferences, email_status, phone_status
       FROM clients WHERE id = $1`,
      [recipientId]
    );
    return r.rows[0] || null;
  }
  // staff / admin live in users table. NOTE: `users` has no `phone` column —
  // staff phone numbers live on `contractor_profiles`. Plan 2b/2d handlers
  // that need staff phone numbers must join contractor_profiles themselves;
  // the dispatcher only loads the minimal recipient row here.
  const r = await pool.query(
    `SELECT id, email, role, communication_preferences
     FROM users WHERE id = $1`,
    [recipientId]
  );
  return r.rows[0] || null;
}

// ─── Dispatch one row ────────────────────────────────────────

async function dispatchRow(row) {
  let entity, recipient;
  try {
    [entity, recipient] = await Promise.all([
      lookupEntity(row.entity_type, row.entity_id),
      lookupRecipient(row.recipient_type, row.recipient_id),
    ]);

    if (!entity || !recipient) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, `lookup failed: entity=${!!entity} recipient=${!!recipient}`]
      );
      return;
    }

    const suppressionReason = await checkSuppression({ row, entity, recipient });
    if (suppressionReason) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'suppressed', error_message = $2 WHERE id = $1",
        [row.id, suppressionReason]
      );
      return;
    }

    // Marketing-class gate (Gemini Finding 5). The handler registry carries a
    // `category` metadata field; marketing-class messages are suppressed when
    // the client opted out of marketing comms. Operational messages bypass
    // this gate (CAN-SPAM allows transactional follow-ups regardless of
    // marketing preference). Plan 2d's marketing handlers all register with
    // category='marketing'; review_request stays operational because it's a
    // post-sale transactional follow-up.
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

    const handler = handlers.get(row.message_type);
    if (!handler) {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, `no handler registered for message_type '${row.message_type}'`]
      );
      return;
    }

    await handler({ entity, recipient, scheduledMessage: row });

    await pool.query(
      "UPDATE scheduled_messages SET status = 'sent', sent_at = NOW(), error_message = NULL WHERE id = $1",
      [row.id]
    );
  } catch (err) {
    Sentry.captureException(err, {
      tags: { dispatcher: 'scheduled_messages', message_type: row.message_type },
      extra: { row_id: row.id, entity_type: row.entity_type, entity_id: row.entity_id },
    });
    console.error(`[scheduledMessageDispatcher] row ${row.id} (${row.message_type}) failed:`, err.message);
    try {
      await pool.query(
        "UPDATE scheduled_messages SET status = 'failed', error_message = $2 WHERE id = $1",
        [row.id, String(err.message || err).slice(0, 500)]
      );
    } catch (markErr) {
      console.error('[scheduledMessageDispatcher] failed to mark row failed:', markErr.message);
    }
  }
}

// ─── Pull pending rows and dispatch ──────────────────────────

const BATCH_LIMIT = 100;

async function dispatchPending() {
  const { rows } = await pool.query(
    `SELECT id, entity_id, entity_type, message_type, recipient_type, recipient_id, channel, scheduled_for
     FROM scheduled_messages
     WHERE status = 'pending' AND scheduled_for <= NOW()
     ORDER BY scheduled_for ASC
     LIMIT $1`,
    [BATCH_LIMIT]
  );

  for (const row of rows) {
    // Sequential dispatch — keeps a single SMTP burst from blowing past Resend's
    // rate limit. If volume grows, swap to a concurrency-limited Promise queue.
    await dispatchRow(row);
  }
}

// ─── Built-in money-path handlers ────────────────────────────

function proposalUrl(token) {
  return `${PUBLIC_SITE_URL}/proposal/${token}`;
}

function lastFour(_proposal) {
  // last4 is not stored on proposals today (only stripe_payment_method_id).
  // Return null so templates skip the line. Future task: store last4 alongside
  // the payment method id at deposit time so we can render it here.
  return null;
}

async function sendBalanceReminder({ entity, recipient, paymentMode }) {
  const balanceDue = Number(entity.total_price) - Number(entity.amount_paid);
  if (balanceDue <= 0) {
    throw new Error('balance reminder fired but balance is zero or negative');
  }
  const tpl = emailTemplates.paymentReminderClient({
    clientName: recipient.name,
    eventTypeLabel: getEventTypeLabel({ event_type: entity.event_type, event_type_custom: entity.event_type_custom }),
    balanceDue,
    balanceDueDate: entity.balance_due_date,
    proposalUrl: proposalUrl(entity.token),
    paymentMode,
    last4: lastFour(entity),
  });
  await sendEmail({ to: recipient.email, ...tpl });
}

async function sendBalanceDueToday({ entity, recipient }) {
  // T+0 — "balance due today" non-autopay email. Reuses paymentReminderClient
  // in manual mode but with a more urgent subject. Could be a separate template
  // later; for now, the manual variant covers the body.
  await sendBalanceReminder({ entity, recipient, paymentMode: 'manual' });
}

async function sendBalanceLate({ entity, recipient, daysLate }) {
  const balanceDue = Number(entity.total_price) - Number(entity.amount_paid);
  if (balanceDue <= 0) {
    throw new Error('late reminder fired but balance is zero or negative');
  }
  const tpl = emailTemplates.paymentReminderLate({
    clientName: recipient.name,
    eventTypeLabel: getEventTypeLabel({ event_type: entity.event_type, event_type_custom: entity.event_type_custom }),
    balanceDue,
    proposalUrl: proposalUrl(entity.token),
    daysLate,
  });
  await sendEmail({ to: recipient.email, ...tpl });
}

// All money-path handlers are anchored on balance_due_date (NOT event_date)
// so Plan 2c's reschedule cascade re-anchors them correctly when admin updates
// the balance due date (Gemini Finding 1 + 6 — balance-due-date updates on
// reschedule are tracked as a follow-up in Plan 2c).
const DAY_SECONDS = 86400;

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

module.exports = {
  registerHandler,
  getHandlerMeta,
  dispatchPending,
  _clearHandlersForTest,
  _handlersForTest,
};
```

- [ ] **Step 4: Run test to verify pass**

```bash
node --test server/utils/scheduledMessageDispatcher.test.js
```

Expected: all 8 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/scheduledMessageDispatcher.js server/utils/scheduledMessageDispatcher.test.js
git commit -m "feat(comms): scheduledMessageDispatcher with handler registry and money-path handlers"
```

---

## Task 10: Wire dispatcher into `server/index.js` with per-scheduler env var

**Files:**
- Modify: `server/index.js`

Follow the Plan 1 pattern exactly: gate on `RUN_MESSAGE_DISPATCHER_SCHEDULER`, wrap with `wrapScheduler('message_dispatcher', 300, dispatchPending)`, `setTimeout` initial fire, `setInterval` every 5 min, and `clearHealthRow('message_dispatcher')` in the else-branch (preserving the c12d772 fix that skips clearHealthRow on global-disable).

- [ ] **Step 1: Read current scheduler bootstrap block**

Read `server/index.js` lines 245-322 to confirm the current pattern.

- [ ] **Step 2: Add the require near the existing requires**

Find the top of `server/index.js` where other utility modules are required (around the existing `processAutopayCharges`, `processSequenceSteps`, etc. imports). Add:

```javascript
const { dispatchPending } = require('./utils/scheduledMessageDispatcher');
```

If the require pattern in `server/index.js` puts module imports inside the start() function around lines 255-259, place the new require alongside `wrapScheduler` instead.

- [ ] **Step 3: Insert the new scheduler block**

Inside the `start()` function inside `app.listen(...)`, right after the existing `RUN_LABRAT_PURGE_SCHEDULER` block (around line 313) and before the `startStaleSchedulerMonitor` block, insert:

```javascript
      // Scheduled-messages dispatcher — every 5 min, picks up pending rows
      if (enabled('RUN_MESSAGE_DISPATCHER_SCHEDULER')) {
        const wrapped = wrapScheduler('message_dispatcher', 300, dispatchPending);
        setTimeout(wrapped, 180000); // initial fire 3 min after boot — stagger from other schedulers
        setInterval(wrapped, 5 * 60 * 1000);
      } else if (!globalScheduleDisabled) {
        clearHealthRow('message_dispatcher');
      }
```

The `expectedIntervalSeconds = 300` matches a 5-min cadence. `setTimeout(wrapped, 180000)` staggers the first fire 3 min after server boot — comfortably after the existing schedulers' staggered starts (30s/45s/60s/90s/120s/150s) so we don't hammer the DB on cold start.

- [ ] **Step 4: Restart dev server and watch logs**

Restart the dev server. Watch for both:
- `[schedulerHealth] stale-scheduler monitor started`
- `[schedulers] started with per-scheduler controls`

No errors related to `scheduledMessageDispatcher`.

After ~3.5 minutes, verify the dispatcher's heartbeat appears:

```bash
psql "$DATABASE_URL" -c "SELECT scheduler_name, last_status, last_run_at FROM scheduler_health WHERE scheduler_name = 'message_dispatcher';"
```

Expected: one row, `last_status = 'ok'`.

- [ ] **Step 5: Toggle the env var to verify the else-branch**

Set `RUN_MESSAGE_DISPATCHER_SCHEDULER=false` in your local `.env`, restart, confirm the `message_dispatcher` row is removed from `scheduler_health`. Unset it and verify it reappears after the next tick.

Clean up the test value before committing.

- [ ] **Step 6: Commit**

```bash
git add server/index.js
git commit -m "feat(comms): register scheduledMessageDispatcher in server bootstrap (5-min cadence)"
```

---

## Task 11: Schedule balance reminders on Stripe deposit-paid webhook

**Files:**
- Modify: `server/routes/stripe.js`

Spec section 8.2 row-creation pattern: on the proposal's `deposit_paid` transition (which happens inside the `payment_intent.succeeded` handler in stripe.js around line 868+), insert pending rows into `scheduled_messages` for the appropriate balance reminders.

- [ ] **Step 1: Read the deposit-paid branch of the webhook**

Re-read `server/routes/stripe.js` lines 960-1020 to confirm where the `'deposit_paid'` status assignment happens, and the post-commit notifier block (lines 816-866) where post-commit side effects fire.

The scheduling MUST happen post-commit (not inside the BEGIN/COMMIT) to avoid scheduling rows for a payment that ultimately rolls back. Post-commit also matches the existing pattern for the payment notification emails.

- [ ] **Step 2: Add a post-commit scheduling helper**

Near the top of `server/routes/stripe.js` (after the existing requires, around line 30), add:

```javascript
const { scheduleMessage } = require('../utils/messageScheduling');
```

Then add a new helper function in the same area as `eventLabelFor`:

```javascript
/**
 * Schedule the balance-reminder ladder for a freshly-deposit-paid proposal.
 *
 * Autopay enrolled:
 *   1 row at balance_due_date - 3 days (message_type: balance_reminder_autopay_t3)
 *
 * Non-autopay:
 *   4 rows: t-3, due-date, t+1, t+3
 *   (balance_reminder_non_autopay_t3, balance_due_today, balance_late_t1, balance_late_t3)
 *
 * Skips entirely if balance <= 0, balance_due_date not set, or balance_due_date in the past.
 *
 * Idempotent — scheduleMessage no-ops on duplicate pending rows.
 */
async function scheduleBalanceReminders(proposalId) {
  try {
    const r = await pool.query(
      `SELECT id, client_id, total_price, amount_paid, balance_due_date, autopay_enrolled
       FROM proposals WHERE id = $1`,
      [proposalId]
    );
    const p = r.rows[0];
    if (!p) return;
    if (!p.client_id) return;
    if (!p.balance_due_date) return;
    const balanceDue = Number(p.total_price) - Number(p.amount_paid);
    if (balanceDue <= 0) return;

    const dueDate = new Date(p.balance_due_date);
    if (Number.isNaN(dueDate.getTime())) return;
    // Only skip when the due date is strictly BEFORE today (UTC). Using
    // `dueDate.getTime() < Date.now()` would silently drop the
    // balance_due_today reminder for last-minute bookings that deposit on
    // the same day the balance is due — because by the time the post-commit
    // notifier runs, `Date.now()` is already past midnight of the due date.
    const now = new Date();
    const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (dueDate.getTime() < startOfTodayUtc) return; // balance due strictly in the past — admin handles manually

    const dayMs = 24 * 60 * 60 * 1000;
    const t3Before = new Date(dueDate.getTime() - 3 * dayMs);
    const dueDay = dueDate;
    const t1After = new Date(dueDate.getTime() + 1 * dayMs);
    const t3After = new Date(dueDate.getTime() + 3 * dayMs);

    const base = {
      entityType: 'proposal',
      entityId: proposalId,
      recipientType: 'client',
      recipientId: p.client_id,
      channel: 'email',
    };

    if (p.autopay_enrolled === true) {
      await scheduleMessage({
        ...base,
        messageType: 'balance_reminder_autopay_t3',
        scheduledFor: t3Before,
      });
    } else {
      await scheduleMessage({ ...base, messageType: 'balance_reminder_non_autopay_t3', scheduledFor: t3Before });
      await scheduleMessage({ ...base, messageType: 'balance_due_today', scheduledFor: dueDay });
      await scheduleMessage({ ...base, messageType: 'balance_late_t1', scheduledFor: t1After });
      await scheduleMessage({ ...base, messageType: 'balance_late_t3', scheduledFor: t3After });
    }
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(err, {
        tags: { webhook: 'stripe', component: 'scheduleBalanceReminders' },
        extra: { proposalId },
      });
    }
    console.error('scheduleBalanceReminders failed (non-blocking):', err);
  }
}
```

- [ ] **Step 3: Call it from the deposit-paid post-commit block**

Find the post-commit `try { ... } catch (emailErr) { ... }` block that fires the existing notification emails (around lines 816-865). Inside the `if (isFirstDelivery)` branch (which gates all post-commit side effects), add the call AFTER the existing email-send block, BEFORE the catch.

Use the existing `paymentType` variable to gate: only fire when `paymentType === 'deposit'` (initial booking) or `paymentType === 'full'` (deposit + balance paid in one go — though full payment means there's no balance left, so it will skip via the `balanceDue <= 0` guard inside the helper).

Insertion site (sketch — adapt to the actual code at the time of implementation):

```javascript
      // Existing email sends...
      if (pi?.client_email) { /* ... */ }
      if (adminEmail) { /* ... */ }

      // Schedule balance-reminder ladder for the deposit-paid → balance-due window.
      // Fires for both 'deposit' and 'full' payments; the helper skips when balance <= 0.
      // Idempotent — Stripe retries that re-enter this block won't double-schedule.
      if (paymentType === 'deposit' || paymentType === 'full') {
        await scheduleBalanceReminders(proposalId);
      }
```

- [ ] **Step 4: Smoke test**

Restart the dev server. Use the existing dev test flow (Lab Rat seed or the dev-only test card 4242 4242 4242 4242) to take a deposit on a fresh proposal with `autopay_enrolled = true` and a future `balance_due_date`. After the webhook fires, check the table:

```bash
psql "$DATABASE_URL" -c "SELECT message_type, scheduled_for, status FROM scheduled_messages WHERE entity_id = <new_proposal_id> ORDER BY scheduled_for;"
```

Expected: one row for autopay, `message_type = balance_reminder_autopay_t3`, scheduled 3 days before the balance_due_date.

Do the same with `autopay_enrolled = false`. Expected: four rows.

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(comms): schedule balance reminders on Stripe deposit-paid webhook"
```

---

## Task 12: Send autopay-specific receipt and fire client payment-failure email

**Files:**
- Modify: `server/routes/stripe.js`

Two webhook touches:
1. When `payment_intent.succeeded` fires with `paymentType === 'balance'` AND the proposal was `autopay_enrolled = true` (i.e., the autopay scheduler-driven balance charge succeeded), send the autopay-specific variant of `paymentReceivedClient` (with `autopay: true`, `last4` if available, `eventDateLabel` formatted in event TZ).
2. On `payment_intent.payment_failed`, send `paymentFailedClient` to the client (in addition to the existing admin email). Throttle at one email per 24h per proposal — quick check against `proposal_activity_log` rows of type `payment_failed_email_client`.

- [ ] **Step 1: Patch the existing post-commit email block for autopay-success copy**

Find the payment-notification block (around lines 816-865). Locate the line:

```javascript
const tpl = isCoupledSigning
  ? emailTemplates.signedAndPaidClient({ clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute })
  : emailTemplates.paymentReceivedClient({ clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute });
```

Replace the `paymentReceivedClient` branch so `autopay: true` is set when `paymentType === 'balance'` and the proposal was autopay-enrolled:

```javascript
let tpl;
if (isCoupledSigning) {
  tpl = emailTemplates.signedAndPaidClient({ clientName: pi.client_name, eventTypeLabel: eventLabel, amount: amountFormatted, paymentType: payLabel, lastMinute });
} else {
  // Detect autopay-driven balance charge: paymentType='balance' AND the proposal
  // had autopay enrolled. Fetch the autopay flag — it was already read in the
  // post-commit query above (extend the SELECT to include `autopay_enrolled`).
  const isAutopaySuccess = paymentType === 'balance' && pi?.autopay_enrolled === true;
  tpl = emailTemplates.paymentReceivedClient({
    clientName: pi.client_name,
    eventTypeLabel: eventLabel,
    amount: amountFormatted,
    paymentType: payLabel,
    lastMinute,
    autopay: isAutopaySuccess,
  });
}
```

You'll need to add `p.autopay_enrolled` to the existing post-commit SELECT around line 820:

```javascript
const payInfo = await pool.query(`
  SELECT p.event_type, p.event_type_custom, p.client_signed_at, p.last_minute_hold,
         p.autopay_enrolled,
         c.name AS client_name, c.email AS client_email
  FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
  WHERE p.id = $1
`, [proposalId]);
```

- [ ] **Step 2: Tighten admin-side consolidation (signedAndPaid only on coupled flow)**

Verify the existing admin branch already routes through `signedAndPaidAdmin` when coupled — it does (line 854). Spec section 6 also says the standalone `clientSignedAdmin` and `paymentReceivedAdmin` should NOT fire for the coupled flow.

Read the proposal-signing route (likely `server/routes/proposals/publicToken.js` or `crud.js`) to check whether it fires `clientSignedAdmin` standalone before the Stripe payment arrives. If yes, gate that fire on `client_signed_at` only being set without a paid deposit happening shortly after — but for THIS plan, leave the signing email alone. The consolidation already happens via the 6-hour `isCoupledSigning` check at the post-commit fire. Adding a second guard before signing would change the signing-only path, which is out of scope.

Document this in a comment near the post-commit email block:

```javascript
      // Admin notification consolidation: the standalone clientSignedAdmin fires
      // from the public-token signing route. In the canonical sign+pay coupled
      // flow, the payment arrives within ~6 hours of the signature, and the
      // post-commit notifier here suppresses the standalone paymentReceivedAdmin
      // in favor of signedAndPaidAdmin. Spec section 6.
```

- [ ] **Step 3: Add client payment-failure email**

In the `payment_intent.payment_failed` handler (around lines 1150-1200), AFTER the admin email and BEFORE the catch, add a throttled client-side email:

```javascript
        // Client-side payment-failure email — throttle one per 24h per proposal
        // to avoid spamming when Stripe retries multiple times against a bad card.
        try {
          const propRow = await pool.query(
            `SELECT p.token, p.event_type, p.event_type_custom, c.name AS client_name, c.email AS client_email
             FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
             WHERE p.id = $1`,
            [proposalId]
          );
          const pc = propRow.rows[0];
          if (pc?.client_email) {
            const throttle = await pool.query(
              `SELECT 1 FROM proposal_activity_log
               WHERE proposal_id = $1 AND action = 'payment_failed_email_client'
                 AND created_at > NOW() - INTERVAL '24 hours'
               LIMIT 1`,
              [proposalId]
            );
            if (throttle.rowCount === 0) {
              const tpl = emailTemplates.paymentFailedClient({
                clientName: pc.client_name,
                eventTypeLabel: eventLabelFor(pc),
                last4: null, // not stored today — future task
                proposalUrl: `${PUBLIC_SITE_URL}/proposal/${pc.token}`,
              });
              await sendEmail({ to: pc.client_email, ...tpl });
              await pool.query(
                `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'payment_failed_email_client', 'system', $2)`,
                [proposalId, JSON.stringify({ payment_intent_id: intent.id })]
              );
            }
          }
        } catch (clientEmailErr) {
          if (process.env.SENTRY_DSN_SERVER) {
            Sentry.captureException(clientEmailErr, {
              tags: { webhook: 'stripe', component: 'paymentFailedClient' },
            });
          }
          console.error('Client payment-failure email failed (non-blocking):', clientEmailErr);
        }
```

If `PUBLIC_SITE_URL` isn't already required at the top of stripe.js, add it. Quick check:

```bash
grep -n "PUBLIC_SITE_URL" server/routes/stripe.js | head -3
```

If only used inside specific functions, it's already imported via the existing `require('../utils/urls')` (line ~424). Add it to the top-level requires for cleanliness:

```javascript
const { PUBLIC_SITE_URL } = require('../utils/urls');
```

- [ ] **Step 4: Smoke test the failure path**

Restart dev server. Trigger a failed payment via Stripe test card `4000000000000002` (declined). Watch logs and confirm both the admin email (existing) and the client `paymentFailedClient` email fire (in dev they log; in prod they'd send via Resend). Run the same flow twice within a few minutes — confirm the second client email is suppressed via the throttle.

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(comms): autopay receipt variant and throttled client payment-failure email"
```

---

## Task 13: Send refund notification to client from refund route

**Files:**
- Modify: `server/routes/stripe.js`

Spec section 3.14. After the refund admin route's reconciliation `COMMIT` (around line 671), fire `refundNotificationClient` to the client. Like other money-path emails, this is non-blocking — failures get logged but don't break the response.

- [ ] **Step 1: Patch the refund route**

In `POST /api/stripe/refund/:id` (around lines 566-712), after the `dbClient.query('COMMIT')` succeeds and the `applied===false` guard runs, BEFORE the final `res.json(...)`:

```javascript
  // Fire refund notification to client — non-blocking. Always fires regardless
  // of the recon `applied` value because the customer's card was charged
  // regardless of the idempotent winner.
  try {
    const after = await pool.query(
      `SELECT p.total_price, p.amount_paid, p.event_type, p.event_type_custom,
              c.name AS client_name, c.email AS client_email
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
       WHERE p.id = $1`,
      [proposalId]
    );
    const a = after.rows[0];
    if (a?.client_email) {
      const newBalance = Number(a.total_price) - Number(a.amount_paid);
      const tpl = emailTemplates.refundNotificationClient({
        clientName: a.client_name,
        refundAmount: plan.amountCents / 100,
        last4: null, // not stored on payments today
        newBalance,
      });
      await sendEmail({ to: a.client_email, ...tpl });
    }
  } catch (refundEmailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(refundEmailErr, {
        tags: { route: '/stripe/refund', component: 'refundNotificationClient' },
        extra: { proposalId },
      });
    }
    console.error('Refund client notification email failed (non-blocking):', refundEmailErr);
  }
```

Place this block AFTER the existing `const after = await pool.query(...)` query (line ~703) and refactor to merge the two SELECTs into one — fetch client info + new total/paid in a single query rather than two.

Final pattern around line 703:

```javascript
  const after = await pool.query(
    `SELECT p.total_price, p.amount_paid, p.event_type, p.event_type_custom,
            c.name AS client_name, c.email AS client_email
     FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
     WHERE p.id = $1`,
    [proposalId]
  );

  // Refund client notification — non-blocking.
  try {
    const a = after.rows[0];
    if (a?.client_email) {
      const newBalance = Number(a.total_price) - Number(a.amount_paid);
      const tpl = emailTemplates.refundNotificationClient({
        clientName: a.client_name,
        refundAmount: plan.amountCents / 100,
        last4: null,
        newBalance,
      });
      await sendEmail({ to: a.client_email, ...tpl });
    }
  } catch (refundEmailErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(refundEmailErr, {
        tags: { route: '/stripe/refund', component: 'refundNotificationClient' },
        extra: { proposalId },
      });
    }
    console.error('Refund client notification email failed (non-blocking):', refundEmailErr);
  }

  res.json({
    refunded: plan.amountCents,
    total_price: Number(after.rows[0].total_price),
    amount_paid: Number(after.rows[0].amount_paid),
  });
```

- [ ] **Step 2: Smoke test**

Restart dev server. Issue a refund against a test proposal via the admin UI. Check dev logs — confirm `refundNotificationClient` template renders and `sendEmail` is invoked (dev mode logs the skip; prod sends via Resend).

- [ ] **Step 3: Commit**

```bash
git add server/routes/stripe.js
git commit -m "feat(comms): fire refundNotificationClient after admin refund succeeds"
```

---

## Task 14: Update `.env.example`, CLAUDE.md, README

**Files:**
- Modify: `.env.example`
- Modify: `.claude/CLAUDE.md`
- Modify: `README.md`

Plan 2a introduces two env-var concerns:

1. **`RUN_MESSAGE_DISPATCHER_SCHEDULER`** — new per-scheduler control toggle for the dispatcher registered in Task 10.
2. **`ADMIN_EMAIL`** — already present in `.env.example` (seed-account email) and the README seed table, but Task 2 now reads it inside `sendEmail` to default `replyTo` for every client-facing email. That elevates it from a one-time seed value to a runtime dependency. CLAUDE.md's env table currently has no row for it.

- [ ] **Step 1: Append to `.env.example`**

Add at the end of `.env.example` (near the other per-scheduler entries added by Plan 1):

```ini
# RUN_MESSAGE_DISPATCHER_SCHEDULER=true
```

Within the existing scheduler-controls block, so the var sits alongside the others. `ADMIN_EMAIL` is already present in `.env.example` — no change needed there.

- [ ] **Step 2: Update `.claude/CLAUDE.md` env table**

Find the Environment Variables table (after the `## Environment Variables` header). Add a row for the new dispatcher env var — group it with the per-scheduler controls Plan 1 added:

```markdown
| `RUN_MESSAGE_DISPATCHER_SCHEDULER` | Optional. Set to `false` to disable the scheduled-message dispatcher (balance reminders, future drip / event-week / etc. handlers). Defaults on. Subject to `RUN_SCHEDULERS=false` global override. |
```

Also add a row for `ADMIN_EMAIL` — it isn't in the CLAUDE.md env table today, and Task 2 makes it a runtime requirement for client-facing reply-routing:

```markdown
| `ADMIN_EMAIL` | Admin inbox address. Used as the seed account email AND as the default `Reply-To` on every client-facing email sent via `sendEmail` (Plan 2a). Falls through to no `Reply-To` header when unset. Set to a monitored inbox in prod so client replies don't bounce. |
```

- [ ] **Step 3: Update README.md env table**

Add the `RUN_MESSAGE_DISPATCHER_SCHEDULER` row in `README.md`'s environment variable table. `ADMIN_EMAIL` is already in the README table (line ~92, "For seed | Admin account email") — update that row's description to reflect the new runtime use:

```markdown
| `ADMIN_EMAIL` | Required | Admin account email — used for seed and as the default `Reply-To` on client-facing emails (Plan 2a). |
```

- [ ] **Step 4: Commit**

```bash
git add .env.example .claude/CLAUDE.md README.md
git commit -m "docs(env): document RUN_MESSAGE_DISPATCHER_SCHEDULER and ADMIN_EMAIL runtime use"
```

---

## Task 15: End-to-end smoke test

This is a verification pass — no code changes.

- [ ] **Step 1: Restart dev server**

```bash
npm run dev
```

Expected log lines:
- `[schedulerHealth] stale-scheduler monitor started`
- `[schedulers] started with per-scheduler controls`

No errors related to the new module.

- [ ] **Step 2: Wait 4 minutes for the dispatcher to do its first tick**

The dispatcher has a 3-min startup stagger plus a 5-min cadence. After ~4 minutes, the first heartbeat should land:

```bash
psql "$DATABASE_URL" -c "SELECT scheduler_name, last_status, last_run_at FROM scheduler_health WHERE scheduler_name = 'message_dispatcher';"
```

Expected: one row, `last_status = 'ok'`.

- [ ] **Step 3: Verify all unit tests pass**

```bash
node --test server/utils/messageScheduling.test.js server/utils/messageSuppression.test.js server/utils/scheduledMessageDispatcher.test.js
```

Expected: all pass.

- [ ] **Step 4: Run lint**

```bash
npm run lint
```

Expected: no errors in any of the touched files.

- [ ] **Step 5: Manual end-to-end on a deposit-paid proposal**

Use the Lab Rat seed (or `4242 4242 4242 4242` against a manually-created proposal) to take a deposit on a fresh test proposal:
- Set `balance_due_date` to 4 days in the future
- `autopay_enrolled = false`

After the webhook fires:

```bash
psql "$DATABASE_URL" -c "SELECT message_type, scheduled_for, status FROM scheduled_messages WHERE entity_id = <new_proposal_id> ORDER BY scheduled_for;"
```

Expected: 4 pending rows (non_autopay_t3, balance_due_today, late_t1, late_t3).

Move the t-3 row's `scheduled_for` to the past:

```bash
psql "$DATABASE_URL" -c "UPDATE scheduled_messages SET scheduled_for = NOW() - INTERVAL '1 minute' WHERE entity_id = <new_proposal_id> AND message_type = 'balance_reminder_non_autopay_t3';"
```

Wait up to 5 minutes for the dispatcher tick, then verify:

```bash
psql "$DATABASE_URL" -c "SELECT message_type, status, sent_at, error_message FROM scheduled_messages WHERE entity_id = <new_proposal_id>;"
```

Expected: the t-3 row is `status = 'sent'`, the other three remain `pending`.

In dev (no Resend key), the dev console log shows `[DEV] Email skipped → ... | Subject: Balance due in 3 days for your birthday party`. The sent_at is set regardless.

- [ ] **Step 6: Stop dev server**

Ctrl-C. No commit needed for verification.

---

## Self-review (run after all tasks above complete)

- [ ] All commits land cleanly on `main` with single-line messages (Rule 4)
- [ ] `git status` shows a clean working tree
- [ ] `npm run lint` passes
- [ ] All three new test files pass (`messageScheduling.test.js`, `messageSuppression.test.js`, `scheduledMessageDispatcher.test.js`)
- [ ] `psql "$DATABASE_URL" -c "\\d scheduled_messages"` shows the new partial unique index
- [ ] `scheduler_health` has a `message_dispatcher` row populated within ~4 min of boot
- [ ] A test deposit-paid proposal correctly enrolls balance-reminder rows
- [ ] A test refund fires `refundNotificationClient` (dev log shows the template)
- [ ] A test failed payment fires `paymentFailedClient` once (and the second attempt within 24h is throttled)
- [ ] `paymentReminderClient({ paymentMode: 'autopay' })` and `paymentReminderClient({ paymentMode: 'manual' })` both render cleanly (manual sanity-check via Node REPL or `node --test` if a unit test is added)
- [ ] No `m-dash` characters introduced in any new copy (project preference — commas / periods only)
- [ ] All client-facing emails inherit the default `replyTo = process.env.ADMIN_EMAIL`

---

## What's not in this plan

To keep Plan 2a focused on money-path emails + dispatcher infrastructure, the following Plan 2 work is intentionally deferred:

- **Orientation email expansion** (2.1 — `signedAndPaidClient` becomes the full booking confirmation with .ics, timeline, Potion Planner CTA) — Plan 2b
- **Drink plan touches** (3.7 nudge, 3.8 submitted confirmation BYOB/Hosted variants, 3.10 post-consult) — Plan 2c
- **Event-week / event-eve / reschedule / shopping-list / post-event review** — Plan 2d
- **Long-lead-time touches** (1.4 New Year, 1.5 6-mo-out, 1.6 T-30 recap) — Plan 2d
- **Retention nudge** (4.2) — Plan 2d
- **Manual lead entry parity wiring** (7.7) — touched when drip integration lands (Plan 3 / 2c)
- **Channel fallback rule** (7.3) — requires SMS infrastructure, defer to Plan 3
- **`balance_due_today` standalone template** — Task 9 reuses `paymentReminderClient` in manual mode for now; can split into a dedicated template in 2b if the copy diverges
- **Storing `last4` on proposal payments** — `lastFour(proposal)` returns null today; future task adds the column + write site

Plan 2b is the natural next step. It builds on the dispatcher and helper here, registering more handlers for orientation and drink-plan-related touches.
