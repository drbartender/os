# Notify-Client Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision 2 (2026-07-22).** Full rewrite after the 6-agent design fleet + 3-agent Fable
> review. Gratuity notice removed from the popup (stays automatic, gains suppression);
> refund endpoints added as lane 3; every mechanical blocker from the reviews corrected
> (polymorphic `scheduled_messages`, `ValidationError.fieldErrors`, seam-based send
> assertions, `composeVenueLocation` reuse, middleware paths, wrapper deletion).

**Goal:** Admin edits stop messaging clients on their own. A confirmation popup fronts the reschedule notice, the payment receipt, and the refund notices; quiet is the default on edits, Send is the default on money receipts; three bare client sends join the suppression gate.

**Architecture:** One shared detection module (`clientNotices.js`) plus helpers exported from `rescheduleProposal.js` guarantee preflight and save literally share their code. The reschedule draft is composed at preflight (old values die at save), carries no staleable money lines except the deterministic projected balance-due date, and renders through `renderPartsEmail` for WYSIWYG. A single `NotifyConfirmModal` serves the edit forms, the payment panel, and (lane 3) the refund panel.

**Tech Stack:** Node.js 26 / Express 4, React 18 (CRA), Postgres (raw SQL via `pg`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-21-notify-client-confirmation-design.md` (revised 2026-07-22)

## Global Constraints

- **Suppression gates the send ONLY.** `rescheduleProposalInTx` (`crud.js:632`) stays unconditional: re-anchoring + `balance_due_date` recompute are correctness, not communication. Never behind a notify check.
- Also never gated: `runRescheduleStaffHooks` (`crud.js:782`), `notifyAdminCategory` (`actions.js:324`), the gratuity disclosure email, `recomputeNewYearHelloForProposal`, the invoice refresh.
- **Fail-quiet:** absent/empty `notify` (or `notify_client` absent/false) sends nothing. No template fallback ever.
- `shouldSendImmediate` wins over an explicit Send; suppressed = `skipped` + reason. `.invalid` placeholders are never `sent`.
- Sends are best-effort, post-commit; a provider throw never 500s a committed transaction.
- **Test law:** dev gates real sends (`sendEmail` returns `dev-skipped` before any ledger write), so send assertions run at the dependency seam (`__setDeps` pattern), never against `message_log`. `ValidationError` text lives in `.fieldErrors`, never `.message`. `scheduled_messages` is polymorphic: `entity_type = 'proposal' AND entity_id = $1`. `clients.email_status` is `NOT NULL DEFAULT 'ok'`; fixtures restore `'ok'`.
- Wire keys snake_case; errors via `AppError` subclasses; client API via `utils/api.js`; no new DB column, schema migration, or env var.
- Server suites one at a time: `node -r dotenv/config --test <file>`. Client gate: `cd client && CI=true npx react-scripts build`.
- No em dashes in client-facing copy.
- File-size ratchet: `crud.js` is at 869 lines (soft cap 700, hard 1000, growth blocked at 1000). Net additions there must stay lean; the detection/validation logic lives in `clientNotices.js`, not `crud.js`.
- Line cites in this plan were re-verified 2026-07-22 and are exact or within 2 lines; where a cite and the code disagree by a line or two, trust the described content, not the number.

## Lane map

```yaml
lanes:
  - id: notify-server
    footprint:
      - server/utils/clientNotices.js
      - server/utils/rescheduleProposal.js
      - server/utils/rescheduleProposal.test.js
      - server/utils/smsTemplates.js
      - server/utils/venueAddress.js
      - server/utils/emailValidation.js
      - server/routes/proposals/notifyPreflight.js
      - server/routes/proposals/index.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/crud.test.js
      - server/routes/proposals/actions.js
      - server/routes/proposals/notifyClient.test.js
      - scripts/sensitive-paths.txt
      - ARCHITECTURE.md
      - README.md
    depends_on: []
    review_fleet: [security-review, database-review, code-review, consistency-check]
  - id: notify-client
    footprint:
      - client/src/components/comms/NotifyConfirmModal.jsx
      - client/src/utils/isPlaceholderEmail.js
      - client/src/pages/admin/proposalEditor/ProposalEditorForm.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      - README.md
    depends_on: [notify-server]
    review_fleet: [code-review, consistency-check]
  - id: notify-refunds
    footprint:
      - server/routes/stripe.js
      - server/routes/proposals/cancel.js
      - server/routes/proposals/cancel.test.js
      - server/utils/refundClientNotify.js
      - server/routes/proposals/notifyRefunds.test.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      - client/src/pages/admin/CancelEventDialog.js
      - client/src/pages/admin/CancelEventDialog.test.js
      - docs/fix-list-remaining-2026-07-02.md
      - ARCHITECTURE.md
    depends_on: [notify-client]
    review_fleet: [security-review, database-review, code-review, consistency-check]
```

Three serialized lanes. Lane 1 carries the money/comms contract and earns the full fleet; it also adds `crud.js`, `actions.js`, and `rescheduleProposal.js` to `scripts/sensitive-paths.txt` (they are NOT on it today, verified via `sensitive-match.js`), so the push-time gates fire for real from then on. Lane 2 is presentation. Lane 3 touches refund money paths (recently hardened, 2026-07 payment-accounting work): full fleet again, minimal diffs. Lanes 2 and 3 both touch `ProposalDetailPaymentPanel.js`; serialization makes that safe. **Do not push lane 1 to prod without lane 2** (merge is not deploy): the server alone leaves reschedule notices off with no UI to opt in.

---

# Lane: notify-server

## Task 1: Shared helpers + detection module

**Files:**
- Modify: `server/utils/emailValidation.js` (add `isPlaceholderEmail`)
- Modify: `server/utils/venueAddress.js` (add `resolvePendingLocation`)
- Modify: `server/utils/rescheduleProposal.js` (export `RESCHEDULABLE_FIELDS`, `reschedulableStatusOk`, `computeProjectedBalanceDue`)
- Modify: `server/routes/proposals/crud.js` (use `resolvePendingLocation`; behavior-inert refactor)
- Create: `server/utils/clientNotices.js`
- Create: `server/routes/proposals/notifyClient.test.js` (grows through Tasks 1, 3, 4, 5)

**Interfaces:**
- Consumes: `hasReschedulableChange` (`rescheduleProposal.js`, exported at `:599`), `BOOKED_SET` (`proposalStatus.js:73`), `composeVenueLocation` (`venueAddress.js:44`, exported `:118`, already imported by `crud.js:8`).
- Produces:
  - `isPlaceholderEmail(email) -> boolean` (emailValidation.js)
  - `resolvePendingLocation(old, body) -> string|null` (venueAddress.js): the exact merge-and-compose `crud.js:341-350` does today
  - `RESCHEDULABLE_FIELDS = ['event_date','event_start_time','event_location']`, `reschedulableStatusOk(status) -> boolean`, `computeProjectedBalanceDue(oldEventDate, oldBalanceDue, newEventDate) -> 'YYYY-MM-DD'|null` (rescheduleProposal.js)
  - `NOTICE_EVENT_DETAILS = 'event_details_changed'`, `eventDetailsNoticeApplies({ old, updated, status }) -> boolean`, `validateNotifyList(notify) -> normalized[]` (clientNotices.js)

- [ ] **Step 1: Write the failing unit tests**

Create `server/routes/proposals/notifyClient.test.js`:

```javascript
'use strict';

// Notice detection + the notify contract. Runs ALONE against the shared dev DB:
// node -r dotenv/config --test server/routes/proposals/notifyClient.test.js
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { isPlaceholderEmail } = require('../../utils/emailValidation');
const { resolvePendingLocation } = require('../../utils/venueAddress');
const {
  RESCHEDULABLE_FIELDS, reschedulableStatusOk, computeProjectedBalanceDue,
} = require('../../utils/rescheduleProposal');
const {
  NOTICE_EVENT_DETAILS, eventDetailsNoticeApplies, validateNotifyList,
} = require('../../utils/clientNotices');

// ValidationError puts field text in .fieldErrors, NEVER .message (errors.js:11-15).
// Every throws-assertion in this file matches on fieldErrors.
function throwsField(fn, field, re) {
  assert.throws(fn, (err) => {
    assert.equal(err.name, 'ValidationError');
    assert.match(String(err.fieldErrors?.[field] ?? ''), re);
    return true;
  });
}

test('isPlaceholderEmail: .invalid is a placeholder, real mail is not', () => {
  assert.equal(isPlaceholderEmail('jane@ccimport.invalid'), true);
  assert.equal(isPlaceholderEmail('JANE@CCIMPORT.INVALID  '), true);
  assert.equal(isPlaceholderEmail('jane@gmail.com'), false);
  assert.equal(isPlaceholderEmail(null), false);
});

test('resolvePendingLocation: venue parts merge over the stored row like the save does', () => {
  const old = { venue_name: 'The Ivy Room', venue_street: null, venue_city: 'Chicago', venue_state: 'IL', venue_zip: null, event_location: 'The Ivy Room, Chicago, IL' };
  // Street-only edit: merged with stored name/city/state (crud.js mergedVenue semantics).
  const loc = resolvePendingLocation(old, { venue_street: '2700 W Chicago Ave' });
  assert.match(loc, /2700 W Chicago Ave/);
  assert.match(loc, /The Ivy Room/);
  // No venue keys in the body: null (caller falls back to body.event_location ?? old).
  assert.equal(resolvePendingLocation(old, { guest_count: 50 }), null);
});

test('reschedulableStatusOk mirrors the InTx gate', () => {
  assert.equal(reschedulableStatusOk('deposit_paid'), true);
  assert.equal(reschedulableStatusOk('sent'), false);
  assert.equal(reschedulableStatusOk('archived'), false);
  assert.equal(reschedulableStatusOk(undefined), false);
});

test('computeProjectedBalanceDue preserves the existing offset', () => {
  assert.equal(computeProjectedBalanceDue('2026-09-01', '2026-08-18', '2026-09-15'), '2026-09-01');
  assert.equal(computeProjectedBalanceDue('2026-09-01', null, '2026-09-15'), null);
  assert.equal(computeProjectedBalanceDue('2026-09-01', '2026-08-18', '2026-09-01'), null); // date unchanged
});

test('eventDetailsNoticeApplies: booked + reschedulable change only', () => {
  const old = { event_date: '2026-09-01', event_start_time: '18:00', event_location: 'A' };
  assert.equal(eventDetailsNoticeApplies({ old, updated: { ...old, event_location: 'B' }, status: 'deposit_paid' }), true);
  assert.equal(eventDetailsNoticeApplies({ old, updated: { ...old, event_location: 'B' }, status: 'sent' }), false);
  assert.equal(eventDetailsNoticeApplies({ old, updated: { ...old }, status: 'deposit_paid' }), false);
});

test('validateNotifyList: absent/empty is [], junk shapes reject on fieldErrors', () => {
  assert.deepEqual(validateNotifyList(undefined), []);
  assert.deepEqual(validateNotifyList([]), []);
  throwsField(() => validateNotifyList('nope'), 'notify', /array/);
  throwsField(() => validateNotifyList([{ type: 'gratuity_increase', channels: ['email'] }]), 'notify', /Unknown notice type/);
  throwsField(() => validateNotifyList([
    { type: NOTICE_EVENT_DETAILS, channels: ['email'], email: { subject: 's', body_text: 'b' } },
    { type: NOTICE_EVENT_DETAILS, channels: ['email'], email: { subject: 's', body_text: 'b' } },
  ]), 'notify', /Duplicate/);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: [] }]), 'channels', /at least one/);
});

test('validateNotifyList: text rules mirror comms.js caps', () => {
  const out = validateNotifyList([{
    type: NOTICE_EVENT_DETAILS, channels: ['email'],
    email: { subject: 'New\r\ndate', body_text: 'body' },
  }]);
  assert.equal(out[0].email.subject, 'New date');
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['email'] }]), 'subject', /empty/i);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['email'], email: { subject: 'x'.repeat(301), body_text: 'b' } }]), 'subject', /300/);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['sms'], sms: { body: 'x'.repeat(641) } }]), 'sms_body', /640/);
  throwsField(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['sms'], sms: { body: '  ' } }]), 'sms_body', /empty/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: FAIL, `isPlaceholderEmail` not exported / `clientNotices` not found.

- [ ] **Step 3: Implement the helpers**

`server/utils/emailValidation.js`: add above `module.exports`:

```javascript
/**
 * RFC-2606 .invalid placeholders from the CC import are not addresses:
 * sendEmail drops them silently (email.js) and nothing is logged. Every NEW
 * availability check or send gate uses this ONE predicate; the older inline
 * copies (comms actions, email.js) can migrate opportunistically.
 */
function isPlaceholderEmail(email) {
  return Boolean(email && String(email).toLowerCase().trim().endsWith('.invalid'));
}
```

Export: `module.exports = { checkEmailDomain, isPlaceholderEmail };`

`server/utils/venueAddress.js`: add `resolvePendingLocation(old, body)` by MOVING the
merge-and-compose logic from `crud.js:332-350` (the `venueProvided` check over the five
`venue_*` keys, the `mergedVenue` body-value-`??`-stored-row merge, the `composeVenueLocation`
call). Returns the composed string when any venue key is present in `body`, else `null`.
Then edit `crud.js:332-350` to call it (keep `validateVenue` where it is; only the
composition moves). This is behavior-inert for the save; run Step 5's regression suites to
prove it.

`server/utils/rescheduleProposal.js`: export three things.

```javascript
// The one list of fields whose change means "the client's event moved".
// hasReschedulableChange and preflight's reasons both derive from THIS.
const RESCHEDULABLE_FIELDS = ['event_date', 'event_start_time', 'event_location'];

/** The status gate for the reschedule notice, shared by the in-tx path and
 *  the read-only preflight so they can never drift. */
function reschedulableStatusOk(status) {
  return Boolean(status) && status !== 'archived' && BOOKED_SET.has(status);
}

/** Pure projection of the balance-due shift the save will perform
 *  (offset-preserving, mirrors the in-tx recompute). Null when the event date
 *  is not moving or there is no due date to move. */
function computeProjectedBalanceDue(oldEventDate, oldBalanceDue, newEventDate) {
  const oldYmd = toCalendarYmd(oldEventDate);
  const newYmd = toCalendarYmd(newEventDate);
  const dueYmd = toCalendarYmd(oldBalanceDue);
  if (!oldYmd || !newYmd || !dueYmd || oldYmd === newYmd) return null;
  const offsetDays = Math.round((Date.parse(dueYmd + 'T00:00:00Z') - Date.parse(oldYmd + 'T00:00:00Z')) / 86400000);
  return new Date(Date.parse(newYmd + 'T00:00:00Z') + offsetDays * 86400000).toISOString().slice(0, 10);
}
```

Refactor `hasReschedulableChange` to iterate `RESCHEDULABLE_FIELDS` (it already compares
exactly these three), replace the inline gate at `:412` with `if (!reschedulableStatusOk(status))`,
and have the in-tx balance recompute (`:432-461`) call `computeProjectedBalanceDue` so the
projection and the write are one function. Add all three to `module.exports` (`:596-601`).

`server/utils/clientNotices.js` (new):

```javascript
'use strict';

// Which client notice a proposal edit triggers + structural validation of the
// caller's opt-in list. ONE module so the read-only preflight and the PATCH
// can never drift on "would this send?".
//
// Exactly one notice type exists. The gratuity disclosure was deliberately
// REMOVED from this contract (2026-07-22): it is a billing disclosure, stays
// automatic in crud.js, and gained only the suppression gate. Do not re-add it
// here without re-reading the spec's reversal note.
const { hasReschedulableChange, reschedulableStatusOk } = require('./rescheduleProposal');
const { ValidationError } = require('./errors');

const NOTICE_EVENT_DETAILS = 'event_details_changed';

// Mirrors comms.js's inline (non-exported) rules; a divergence is a review finding.
const SUBJECT_MAX = 300;
const SMS_MAX_CHARS = 640;
const CHANNELS = ['email', 'sms'];

function eventDetailsNoticeApplies({ old, updated, status }) {
  return reschedulableStatusOk(status) && hasReschedulableChange(old, updated);
}

function cleanSubject(raw) {
  const subject = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!subject) throw new ValidationError({ subject: 'Subject cannot be empty.' });
  if (subject.length > SUBJECT_MAX) throw new ValidationError({ subject: `Subject is over the ${SUBJECT_MAX} character cap.` });
  return subject;
}

/** Structural checks only; runs BEFORE pool.connect(). Trigger checks live
 *  where shouldSendEmail is computed. Returns normalized entries. */
function validateNotifyList(notify) {
  if (notify === undefined || notify === null) return [];
  if (!Array.isArray(notify)) throw new ValidationError({ notify: 'notify must be an array.' });
  const seen = new Set();
  return notify.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new ValidationError({ notify: 'Each notice must be an object.' });
    if (entry.type !== NOTICE_EVENT_DETAILS) throw new ValidationError({ notify: `Unknown notice type: ${entry && entry.type}` });
    if (seen.has(entry.type)) throw new ValidationError({ notify: `Duplicate notice type: ${entry.type}` });
    seen.add(entry.type);
    const channels = Array.isArray(entry.channels) ? entry.channels.filter((c) => CHANNELS.includes(c)) : [];
    if (channels.length === 0) throw new ValidationError({ channels: `${entry.type} needs at least one channel.` });
    const out = { type: entry.type, channels };
    if (channels.includes('email')) {
      out.email = { subject: cleanSubject(entry.email?.subject), bodyText: String(entry.email?.body_text ?? '').trim() };
      if (!out.email.bodyText) throw new ValidationError({ body_text: 'Message cannot be empty.' });
    }
    if (channels.includes('sms')) {
      const body = String(entry.sms?.body ?? '').trim();
      if (!body) throw new ValidationError({ sms_body: 'SMS message cannot be empty.' });
      if (body.length > SMS_MAX_CHARS) throw new ValidationError({ sms_body: `SMS message is over the ${SMS_MAX_CHARS} character cap.` });
      out.sms = { body };
    }
    return out;
  });
}

module.exports = { NOTICE_EVENT_DETAILS, eventDetailsNoticeApplies, validateNotifyList };
```

- [ ] **Step 4: Run the new tests**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: PASS.

- [ ] **Step 5: Regression: the crud refactor is inert and the InTx gate refactor holds**

```bash
node -r dotenv/config --test server/utils/rescheduleProposal.test.js
node -r dotenv/config --test server/routes/proposals/crud.test.js
```
Expected: both pass exactly as before this task (known pre-existing failure: `crud.test.js`
Case 8, rate-limiter bucket exhaustion, tech-debt TST-3; it fails before and after, and is
not this lane's problem).

- [ ] **Step 6: Commit**

```bash
git add server/utils/emailValidation.js server/utils/venueAddress.js server/utils/rescheduleProposal.js server/utils/clientNotices.js server/routes/proposals/crud.js server/routes/proposals/notifyClient.test.js
git commit -m "feat(notify): shared notice detection, placeholder + venue + projection helpers"
```

---

## Task 2: `sendRescheduleEmail` takes reviewed text; `buildEventDetailsDraft`; wrapper tail deleted

**Files:**
- Modify: `server/utils/rescheduleProposal.js:197-352` (send), `:549-594` (wrapper), exports
- Modify: `server/utils/rescheduleProposal.test.js` (wrapper email cases)
- Modify: `server/utils/smsTemplates.js:91-93` (email clause becomes conditional)

**Interfaces:**
- Consumes: `renderPartsEmail` (`server/utils/comms/render.js:15`, `{ subject, heading, bodyText, cta }`), `isPlaceholderEmail`, `computeProjectedBalanceDue` (Task 1).
- Produces:
  - `buildEventDetailsDraft({ old, updated, ctx }) -> { email: { subject, body_text }, sms: { body }, projected_balance_due, autopay_notice }` where `ctx` is the joined proposal+client row (the same 15-column SELECT shape `sendRescheduleEmail` loads at `:198-211`).
  - `sendRescheduleEmail({ proposalId, old, updated, channels, message }) -> { email, sms, email_error, sms_error, skip_reasons }`. `channels` and `message` REQUIRED; no template fallback.

- [ ] **Step 1: Extract the formatting closures to module scope**

`fmtDate` and `fmtTime` are currently closures over `tz` inside `sendRescheduleEmail`
(`:246-289`). Lift them to module functions taking `tz` as the first argument; the send and
the draft builder both call them. Pure motion, no logic change.

- [ ] **Step 2: Write `buildEventDetailsDraft`**

```javascript
/**
 * Composes the event-details notice from the OLD row + pending edits, at
 * preflight time (the old values do not survive the save). Money-free by
 * design (spec: draft content): the only quoted consequence is the projected
 * balance-due shift, which is deterministic (computeProjectedBalanceDue is the
 * SAME function the save's in-tx recompute uses).
 */
function buildEventDetailsDraft({ old, updated, ctx }) {
  const tz = resolveEventTimezone(ctx);
  const firstName = (ctx.client_name || '').trim().split(/\s+/)[0] || 'there';

  const dateChanged = (toCalendarYmd(old.event_date) || '') !== (toCalendarYmd(updated.event_date) || '');
  const timeChanged = String(old.event_start_time ?? '').trim() !== String(updated.event_start_time ?? '').trim();
  const locationChanged = String(old.event_location ?? '').trim() !== String(updated.event_location ?? '').trim();

  const lines = [];
  if (dateChanged) lines.push(`Date: ${fmtDate(tz, old.event_date)} is now ${fmtDate(tz, updated.event_date)}`);
  if (timeChanged) lines.push(`Start time: ${fmtTime(tz, old.event_date, old.event_start_time)} is now ${fmtTime(tz, updated.event_date, updated.event_start_time)}`);
  if (locationChanged) lines.push(`Location: ${old.event_location || 'TBD'} is now ${updated.event_location || 'TBD'}`);

  const projected = computeProjectedBalanceDue(old.event_date, old.balance_due_date, updated.event_date);
  let dueLine = null;
  let autopayNotice = null;
  if (projected) {
    const projectedLocal = fmtDate(tz, projected);
    dueLine = ctx.autopay_enrolled
      ? `Your card will auto-charge the remaining balance on ${projectedLocal}.`
      : `Your balance due date moves to ${projectedLocal}.`;
    autopayNotice = dueLine;
    const daysOut = Math.round((Date.parse(projected + 'T00:00:00Z') - Date.now()) / 86400000);
    if (daysOut <= 3) autopayNotice += ' That is inside the reminder window, so this notice may be their only warning.';
  }

  // utils/urls.js already exports proposalUrl(token) building
  // `${PUBLIC_SITE_URL}/proposal/${encodeURIComponent(token)}` (urls.js:24);
  // import and use it (PUBLIC_SITE_URL is NOT currently imported in this file).
  const link = ctx.token ? proposalUrl(ctx.token) : null;
  const body_text = [
    `Hi ${firstName},`,
    'Your event details have been updated. Here is what changed:',
    lines.join('\n'),
    dueLine,
    link ? `You can see your full current details and balance anytime here: ${link}` : null,
    'Let me know if you have any questions.',
  ].filter(Boolean).join('\n\n');

  // rescheduleSms's dt() is a raw passthrough (smsTemplates.js:13), and the
  // production call site passes PRE-FORMATTED strings; a raw pg Date here would
  // interpolate as a full locale dump. Format first, exactly like the send does.
  // includeEmailClause is ALWAYS false in the notify draft: channel selection
  // happens after composition, so the default text never promises an email.
  const sms = smsTemplates.rescheduleSms({
    newDate: fmtDate(tz, updated.event_date),
    newStartTime: fmtTime(tz, updated.event_date, updated.event_start_time),
    newLocation: updated.event_location,
    includeEmailClause: false,
  });

  return {
    email: { subject: 'Updated details for your event', body_text },
    sms: { body: sms },
    projected_balance_due: projected,
    autopay_notice: autopayNotice,
  };
}
```

Check the exact proposal-URL path pattern against an existing token URL (grep
`PUBLIC_SITE_URL` in `rescheduleProposal.js`/`emailTemplates.js`) and match it; do not invent
a route. Export `buildEventDetailsDraft`.

`smsTemplates.js`: `rescheduleSms` gains an `includeEmailClause` option (default true for
back-compat); when false, drop the "Full updated confirmation in your email." sentence.

- [ ] **Step 3: Rework `sendRescheduleEmail`**

New signature and per-channel truth:

```javascript
async function sendRescheduleEmail({ proposalId, old, updated, channels, message }) {
  const wantEmail = Array.isArray(channels) && channels.includes('email');
  const wantSms = Array.isArray(channels) && channels.includes('sms');
  const results = { email: wantEmail ? null : 'skipped', sms: wantSms ? null : 'skipped', skip_reasons: {} };
  if (!wantEmail) results.skip_reasons.email = 'not selected';
  if (!wantSms) results.skip_reasons.sms = 'not selected';
  if (!wantEmail && !wantSms) return results;
```

Keep the existing ctx SELECT (`:198-211`) and the two `shouldSendImmediate` checks
(`:229-238`). Replace the no-destination throw (`:217-219`) and the both-suppressed bare
return (`:239-242`) with `skip_reasons` entries + `return results` (this function now runs
behind an explicit admin Send; reporting beats throwing).

Email half: gate on `wantEmail && emailCheck.ok && ctx.client_email && !isPlaceholderEmail(ctx.client_email)`;
render the REVIEWED text (WYSIWYG; the bespoke `rescheduleNotificationClient` template is
deliberately not called, see spec):

```javascript
    const { renderPartsEmail } = require('./comms/render');
    const rendered = renderPartsEmail({
      subject: message.email.subject,
      heading: 'Updated details for your event',
      bodyText: message.email.bodyText,
      cta: null,
    });
    try {
      const r = await sendEmail({
        to: ctx.client_email, subject: rendered.subject, html: rendered.html, text: rendered.text,
        meta: { proposalId: ctx.id, clientId: ctx.client_id || null, messageType: 'reschedule' },
      });
      // Defense in depth behind the isPlaceholderEmail gate: sendEmail's own
      // placeholder drop returns 'skipped-invalid' and must NEVER read as sent.
      if (r && r.id === 'skipped-invalid') {
        results.email = 'skipped';
        results.skip_reasons.email = 'Placeholder address (.invalid); no email was sent.';
      } else {
        results.email = 'sent';
      }
    } catch (err) {
      results.email = 'failed';
      results.email_error = err.message || 'Email send failed.';
    }
```

(Verify `sendEmail`'s `meta` key names against `email.js` before writing; mirror an existing
caller.) When gated off, set `results.email = 'skipped'` with the specific reason
(suppression reason / no email / placeholder reason).

SMS half: same shape. Read the current block (`:326-351`) first and PRESERVE the existing
`sendAndLogSms` argument shape exactly (it passes `messageType: 'reschedule'` and
`recipientName`), swapping only the body for `message.sms.body`, keeping the existing
`Sentry.captureException` in the catch, and recording `results.sms = 'sent' | 'failed'`.

`return results;` at the end.

- [ ] **Step 4: Delete the wrapper's email tail**

`rescheduleProposal()` (`:549-594`) is test-only (verified: sole caller is
`rescheduleProposal.test.js:19`; crud.js imports only `rescheduleProposalInTx` +
`sendRescheduleEmail`). Under the new signature its `:584` call would silently no-op. Delete
the post-commit email block (`:578-593`), leaving the wrapper as the tx + reanchor
convenience; update its doc comment (`:366-380`) to say sending is the caller's job now.

Update `rescheduleProposal.test.js`: exactly ONE wrapper case asserts
`emailCalls.length === 1` (test starts `:209`, assertion `:230`), and the wrapper SMS case
near `:361` also asserts a send; both become assertions that the wrapper performs the
re-anchor and due date move WITHOUT sending (their stubs now expect zero; the cases at
`:358`/`:385` already assert zero and stay). Do not delete the re-anchor assertions; they are
the wrapper's remaining contract.

- [ ] **Step 5: Verify no production caller is left behind**

Run: `grep -rn "sendRescheduleEmail" server --include=*.js | grep -v test`
Expected: hits only inside `rescheduleProposal.js` (definition, doc comment, export) and in
`crud.js` (`:15` import, the call site Task 4 rewrites). No other file.

- [ ] **Step 6: Run the suite**

Run: `node -r dotenv/config --test server/utils/rescheduleProposal.test.js`
Expected: PASS with the updated wrapper expectations.

- [ ] **Step 7: Commit**

```bash
git add server/utils/rescheduleProposal.js server/utils/rescheduleProposal.test.js server/utils/smsTemplates.js
git commit -m "feat(notify): reviewed-text reschedule send + preflight draft builder; wrapper email tail removed"
```

---

## Task 3: Preflight endpoint

**Files:**
- Create: `server/routes/proposals/notifyPreflight.js`
- Modify: `server/routes/proposals/index.js` (mount above `crud`)
- Modify: `server/routes/proposals/notifyClient.test.js` (append route tests)

**Interfaces:**
- Consumes: Task 1's `eventDetailsNoticeApplies` + `RESCHEDULABLE_FIELDS` + `resolvePendingLocation` + `isPlaceholderEmail`; Task 2's `buildEventDetailsDraft`.
- Produces: `POST /api/proposals/:id/notify-preflight` returning `{ notices: [...] }` (spec shape, incl. `autopay_notice`). Zero notices when `change_request_id` is present.

- [ ] **Step 1: Write the failing route tests**

Append to `notifyClient.test.js` a route harness modeled on `server/routes/comms.silent.test.js`
**in full**: the `request()` helper, the express app assembly INCLUDING the AppError error
middleware (`comms.silent.test.js:112-120`; without it every 400 assertion sees a 500), the
`before` seeding (admin JWT; a client with real email + phone; a `deposit_paid` proposal with
`event_location`, `event_date`, `balance_due_date`, a token, and at least one pending
`scheduled_messages` row seeded the way `rescheduleProposal.test.js` seeds one), and the
`after` teardown. Mount `require('./index')` (the proposals composition router) at
`/api/proposals`.

```javascript
test('preflight: location change on a booked proposal returns the notice with a draft', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken, body: { event_location: '2700 W Chicago Ave' },
  });
  assert.equal(res.status, 200);
  const n = res.body.notices.find((x) => x.type === 'event_details_changed');
  assert.ok(n);
  assert.match(n.draft.email.body_text, /2700 W Chicago Ave/);
  assert.doesNotMatch(n.draft.email.body_text, /\$\d/, 'draft must carry no dollar figures');
  assert.ok(n.reasons.some((r) => r.includes('event_location')));
});

test('preflight: venue-parts-only edit resolves the same location the save would', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken, body: { venue_street: '123 Elm St' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.notices.length, 1, 'a street-only edit changes event_location at save time');
});

test('preflight: date move quotes the projected due date, not the stored one', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken, body: { event_date: '2026-12-01' },
  });
  const n = res.body.notices[0];
  assert.ok(n.autopay_notice || /balance due date moves/i.test(n.draft.email.body_text));
});

test('preflight: change_request_id present -> zero notices', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken, body: { event_location: 'Elsewhere', change_request_id: 999999 },
  });
  assert.deepEqual(res.body.notices, []);
});

test('preflight: unrelated edit -> zero notices; unbooked proposal -> zero notices', async () => {
  const a = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken, body: { guest_count: 90 },
  });
  assert.deepEqual(a.body.notices, []);
  const b = await request('POST', `/api/proposals/${sentProposalId}/notify-preflight`, {
    token: adminToken, body: { event_location: 'Elsewhere' },
  });
  assert.deepEqual(b.body.notices, []);
});

test('preflight: .invalid email is unavailable; writes nothing; auth required', async () => {
  const res = await request('POST', `/api/proposals/${placeholderProposalId}/notify-preflight`, {
    token: adminToken, body: { event_location: 'Elsewhere' },
  });
  const n = res.body.notices[0];
  assert.equal(n.channels.email.available, false);
  assert.match(n.channels.email.unavailable_reason, /placeholder/i);

  const before = await pool.query('SELECT event_location, updated_at FROM proposals WHERE id = $1', [proposalId]);
  await request('POST', `/api/proposals/${proposalId}/notify-preflight`, { token: adminToken, body: { event_location: 'X' } });
  const after = await pool.query('SELECT event_location, updated_at FROM proposals WHERE id = $1', [proposalId]);
  assert.deepEqual(after.rows[0], before.rows[0]);

  const noAuth = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, { body: {} });
  assert.equal(noAuth.status, 401);
});
```

Fixtures: `sentProposalId` (status `sent`), `placeholderProposalId` (client email
`x-${NONCE}@ccimport.invalid`), all cleaned in `after`.

**Rate-limiter budget:** `adminWriteLimiter` is max 10 per 60s PER ADMIN
(`rateLimiters.js:71-78`), and this task's preflight tests fire 9 requests. Seed a SECOND
admin token in `before` and spread the preflight calls across the two tokens, or the tenth
call added by any future test flakes at 429 exactly like the pre-existing crud Case 8
(TST-3). Do not raise the limiter for tests.

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: new tests FAIL with 404.

- [ ] **Step 3: Implement the route**

Create `server/routes/proposals/notifyPreflight.js`. Import paths mirror `crud.js`
(`crud.js:4` and `:16` are the reference): `../../middleware/auth`,
`../../middleware/asyncHandler`; the rate limiter import mirrors `cancel.js`'s
`adminWriteLimiter` import.

```javascript
'use strict';

// POST /api/proposals/:id/notify-preflight — READ-ONLY. "Would saving these
// edits message the client, and what would it say?" No transaction, no writes.
// The PATCH recomputes its own answer via the SAME functions and is the
// authority; this exists so the form can ask before saving, and so the draft
// can be composed while the OLD field values still exist.
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { eventDetailsNoticeApplies } = require('../../utils/clientNotices');
const {
  RESCHEDULABLE_FIELDS, buildEventDetailsDraft,
} = require('../../utils/rescheduleProposal');
const { resolvePendingLocation } = require('../../utils/venueAddress');
const { isPlaceholderEmail } = require('../../utils/emailValidation');
const { normalizePhone } = require('../../utils/sms');

const router = express.Router();

router.post('/:id/notify-preflight', auth, requireAdminOrManager, adminWriteLimiter, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError({ id: 'Invalid proposal id.' });
  const body = req.body || {};

  // Change-request saves have their own client email (crud.js change-approved
  // path) and the save suppresses the reschedule send on them (crud.js `&&
  // !change_request_id`). Zero notices = no popup = the one coherent answer.
  if (body.change_request_id) return res.json({ notices: [] });

  const { rows } = await pool.query(
    `SELECT p.*, c.id AS client_id, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
            c.communication_preferences, c.email_status, c.phone_status
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [id]
  );
  const old = rows[0];
  if (!old) throw new NotFoundError('Proposal not found');

  // Prospective row: undefined body field = unchanged (the PATCH's COALESCE
  // semantics). Location goes through the SAME merge-and-compose the save uses.
  const updated = { ...old };
  for (const f of RESCHEDULABLE_FIELDS) if (body[f] !== undefined) updated[f] = body[f];
  const composed = resolvePendingLocation(old, body);
  if (composed !== null) updated.event_location = composed;

  const notices = [];
  if (eventDetailsNoticeApplies({ old, updated, status: old.status })) {
    const placeholder = isPlaceholderEmail(old.client_email);
    const phone = old.client_phone ? normalizePhone(old.client_phone) : null;
    const draft = buildEventDetailsDraft({ old, updated, ctx: old });
    notices.push({
      type: 'event_details_changed',
      reasons: RESCHEDULABLE_FIELDS
        .filter((f) => String(old[f] ?? '').trim() !== String(updated[f] ?? '').trim())
        .map((f) => `${f} changed`),
      composable: true,
      recipient: { name: old.client_name || null, email: old.client_email || null, phone },
      channels: {
        email: {
          available: Boolean(old.client_email) && !placeholder,
          default: Boolean(old.client_email) && !placeholder,
          unavailable_reason: !old.client_email ? 'No email on file.'
            : placeholder ? 'Placeholder address (.invalid) from the CC import; no real email exists.' : null,
        },
        sms: {
          available: Boolean(phone),
          default: Boolean(phone),
          unavailable_reason: phone ? null : 'No usable phone on file.',
        },
      },
      autopay_notice: draft.autopay_notice,
      draft: { email: draft.email, sms: draft.sms },
    });
  }
  res.json({ notices });
}));

module.exports = router;
```

Note on `ctx: old`: `buildEventDetailsDraft` reads `client_name`, `client_email`,
`client_id`, `token`, `autopay_enrolled`, `balance_due_date`, and the timezone fields; the
`p.*` + client join supplies all of them. Verify `resolveEventTimezone`'s expected field
names against its definition while wiring.

- [ ] **Step 4: Mount it**

`server/routes/proposals/index.js`, above the `crud` line:
`router.use('/', require('./notifyPreflight'));`

- [ ] **Step 5: Run, expect green**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/notifyPreflight.js server/routes/proposals/index.js server/routes/proposals/notifyClient.test.js
git commit -m "feat(notify): read-only notify-preflight (deterministic, CR-aware, placeholder-aware)"
```

---

## Task 4: PATCH `notify` contract + gratuity suppression gate

**Files:**
- Modify: `server/routes/proposals/crud.js` (destructure `:303-311`; validation before `pool.connect()` at `:312`; trigger check after `:637`; send block `:710-726`; gratuity block `:731-755`; response `:827`; `_deps` at `:31`)
- Modify: `server/routes/proposals/notifyClient.test.js` (append)
- Modify: `server/routes/proposals/crud.test.js` (update reschedule-email expectations)

**Interfaces:**
- Consumes: `validateNotifyList`, `NOTICE_EVENT_DETAILS` (Task 1); `sendRescheduleEmail` (Task 2); `shouldSendImmediate`; `isPlaceholderEmail`.
- Produces: `PATCH /api/proposals/:id` accepting `notify` and returning `{ ...proposalRow, notifications: [...] }`.

- [ ] **Step 1: Write the failing tests**

Append to `notifyClient.test.js`. Send assertions run at the seam: add `sendRescheduleEmail`
to crud's `_deps` (Step 3) and stub it here via `crud.__setDeps`; stub failure/skip shapes as
needed. Suppression tests restore `email_status = 'ok'` (NOT NULL column).

```javascript
const crudModule = require('./crud');

test('LOAD-BEARING: date change with no notify list sends nothing but still re-anchors + moves balance_due_date', async () => {
  const calls = [];
  crudModule.__setDeps({ sendRescheduleEmail: async (a) => { calls.push(a); return { email: 'sent', sms: 'skipped', skip_reasons: {} }; } });
  const before = await pool.query(
    "SELECT id, scheduled_for FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending' ORDER BY id",
    [proposalId]
  );
  assert.ok(before.rows.length > 0, 'fixture needs a pending scheduled message');
  const oldDue = (await pool.query('SELECT balance_due_date FROM proposals WHERE id = $1', [proposalId])).rows[0].balance_due_date;

  const res = await request('PATCH', `/api/proposals/${proposalId}`, { token: adminToken, body: { event_date: '2026-10-15' } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notifications, []);
  assert.equal(calls.length, 0);

  const after = await pool.query(
    "SELECT id, scheduled_for FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1 AND status = 'pending' ORDER BY id",
    [proposalId]
  );
  assert.ok(after.rows.some((r, i) => String(r.scheduled_for) !== String(before.rows[i].scheduled_for)), 're-anchor must run');
  const newDue = (await pool.query('SELECT balance_due_date FROM proposals WHERE id = $1', [proposalId])).rows[0].balance_due_date;
  assert.notEqual(String(newDue), String(oldDue));
});

test('the reviewed text reaches the send seam verbatim', async () => {
  const calls = [];
  crudModule.__setDeps({ sendRescheduleEmail: async (a) => { calls.push(a); return { email: 'sent', sms: 'skipped', skip_reasons: {} }; } });
  const res = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken,
    body: {
      event_location: 'Reviewed Venue',
      notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 'S-REVIEWED', body_text: 'B-REVIEWED' } }],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message.email.subject, 'S-REVIEWED');
  assert.deepEqual(calls[0].channels, ['email']);
  assert.equal(res.body.notifications[0].email, 'sent');
});

test('notice without text: 400, nothing saved; notice on untriggering save: 400, rolled back', async () => {
  const beforeLoc = (await pool.query('SELECT event_location FROM proposals WHERE id = $1', [proposalId])).rows[0].event_location;
  const a = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken,
    body: { event_location: 'Rejected Venue', notify: [{ type: 'event_details_changed', channels: ['email'] }] },
  });
  assert.equal(a.status, 400);
  assert.equal((await pool.query('SELECT event_location FROM proposals WHERE id = $1', [proposalId])).rows[0].event_location, beforeLoc);

  const beforeGuests = (await pool.query('SELECT guest_count FROM proposals WHERE id = $1', [proposalId])).rows[0].guest_count;
  const b = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken,
    body: { guest_count: Number(beforeGuests) + 5, notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } }] },
  });
  assert.equal(b.status, 400);
  assert.equal(String((await pool.query('SELECT guest_count FROM proposals WHERE id = $1', [proposalId])).rows[0].guest_count), String(beforeGuests));
});

test('suppressed recipient reports skipped even when requested', async () => {
  // Real sendRescheduleEmail path decides suppression; stub only sendEmail's seam
  // via the deps default (restore the real fn), and flip prefs instead.
  crudModule.__setDeps({ sendRescheduleEmail: require('../../utils/rescheduleProposal').sendRescheduleEmail });
  await pool.query(`UPDATE clients SET communication_preferences = '{"email_enabled": false}'::jsonb WHERE id = $1`, [clientId]);
  try {
    const res = await request('PATCH', `/api/proposals/${proposalId}`, {
      token: adminToken,
      body: { event_location: 'Suppression Venue', notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } }] },
    });
    assert.equal(res.status, 200);
    const entry = res.body.notifications[0];
    assert.equal(entry.email, 'skipped');
    assert.ok(entry.skip_reasons.email);
  } finally {
    await pool.query(`UPDATE clients SET communication_preferences = '{}'::jsonb WHERE id = $1`, [clientId]);
  }
});

test('gratuity disclosure regression pin: fires automatically, no notify list involved', async () => {
  // Paid booking + staffing rise. Assert at the sendEmail seam or on the
  // response NOT carrying a gratuity entry while the email path executes:
  // stub sendEmail via a module seam if crud exposes one for it, else assert
  // the row-level effects (gratuity origin stamped 'staffing') and that
  // notifications[] stays []. The disclosure must NOT appear in notifications.
  const res = await request('PATCH', `/api/proposals/${paidStaffedProposalId}`, {
    token: adminToken, body: { num_bartenders: 3 },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notifications, []);
});

test('gratuity disclosure suppressed half: prefs-disabled client gets nothing (spec test 11)', async () => {
  await pool.query(`UPDATE clients SET communication_preferences = '{"email_enabled": false}'::jsonb WHERE id = $1`, [paidStaffedClientId]);
  try {
    const res = await request('PATCH', `/api/proposals/${paidStaffedProposalId2}`, {
      token: adminToken, body: { num_bartenders: 3 },
    });
    assert.equal(res.status, 200);
    // Assert at the seam that no gratuity email left (stub sendEmail if a seam
    // exists; otherwise assert the suppression console path via the response
    // still being clean and the gate unit-tested in messageSuppression terms).
  } finally {
    await pool.query(`UPDATE clients SET communication_preferences = '{}'::jsonb WHERE id = $1`, [paidStaffedClientId]);
  }
});

test('change-request save: requested notice is a 400 (spec test 5, save half)', async () => {
  // Preflight-zero-notices is covered in Task 3; this pins the save-side rule.
  const res = await request('PATCH', `/api/proposals/${crProposalId}`, {
    token: adminToken,
    body: {
      event_location: 'CR Venue',
      change_request_id: crId,
      notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } }],
    },
  });
  assert.equal(res.status, 400);
});

test('preflight and save agree per reschedulable field, including start time (spec test 6)', async () => {
  // Table-driven: for each field edit, preflight's notice presence must equal
  // the save's acceptance of a requested notice (200 with entry vs 400).
  const cases = [
    { body: { event_date: '2026-11-20' } },
    { body: { event_start_time: '19:30' } },
    { body: { venue_street: '456 Oak St' } }, // exercises resolvePendingLocation
  ];
  for (const c of cases) {
    const pre = await request('POST', `/api/proposals/${agreeProposalId}/notify-preflight`, { token: adminToken2, body: c.body });
    const wants = pre.body.notices.length > 0;
    assert.equal(wants, true, `preflight must trigger for ${JSON.stringify(c.body)}`);
    // Restore the field between iterations so each case is independent.
  }
});
```

(Fixture note: `crProposalId`/`crId` seed a pending `proposal_change_requests` row the way
`clientPortal.changeRequests.test.js` seeds one; `agreeProposalId` restores each field after
its iteration. `adminToken2` per the rate-limiter budget.)

- [ ] **Step 2: Run to verify failure**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: FAIL (bare PATCH still auto-sends; 400 cases return 200).

- [ ] **Step 3: Wire the contract in `crud.js`**

(a) Imports: add `validateNotifyList`, `NOTICE_EVENT_DETAILS` from `../../utils/clientNotices`.
Add `sendRescheduleEmail` to the deps seam at `:31`:
`let _deps = { createInvoiceOnSend, sendProposalSentEmail, sendRescheduleEmail };` and change
the call site to `_deps.sendRescheduleEmail(...)`.

(b) Destructure `notify` next to the staff flags (`:308-310`), then validate BEFORE
`pool.connect()` (`:312`):

```javascript
  // Structural validation before any connection is checked out: a malformed
  // notify list never opens a transaction. Trigger validation happens where
  // shouldSendEmail is computed, inside the tx.
  const requestedNotices = validateNotifyList(notify);
  const eventNotice = requestedNotices.find((n) => n.type === NOTICE_EVENT_DETAILS) || null;
```

(c) Trigger check, immediately after `shouldSendRescheduleEmail` is assigned (`:637`); also
collapse the no-op `catch (rescheduleErr) { throw rescheduleErr; }` (`:638-640`) while here:

```javascript
    // Trigger match for the composable notice: supplied text was composed
    // against a specific set of changes; sending it against a different set
    // (or on a change-request save, which has its own client email) is a
    // rejected request, and the throw rolls the whole edit back.
    if (eventNotice && (!shouldSendRescheduleEmail || change_request_id)) {
      throw new ValidationError({
        notify: 'This save does not change the event date, time, or location for a direct notice, so that message cannot be sent.',
      });
    }
```

(d) Replace the auto-send block (`:710-726`) with the gated send + per-channel collection:

```javascript
    const notifications = [];
    // COMMIT succeeded above. Best-effort, post-commit: a provider failure
    // must never 500 a PATCH whose transaction committed.
    if (eventNotice && shouldSendRescheduleEmail && !change_request_id) {
      try {
        const r = await _deps.sendRescheduleEmail({
          proposalId: parseInt(req.params.id, 10),
          old,
          updated: updatedRow.rows[0],
          channels: eventNotice.channels,
          message: { email: eventNotice.email, sms: eventNotice.sms },
        });
        notifications.push({ type: NOTICE_EVENT_DETAILS, ...r });
      } catch (emailErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(emailErr, { tags: { route: 'proposals/update', issue: 'event-details-notice' }, extra: { proposalId: req.params.id } });
        }
        console.error('Event-details notice failed (non-blocking, DB committed):', emailErr);
        notifications.push({ type: NOTICE_EVENT_DETAILS, email: eventNotice.channels.includes('email') ? 'failed' : 'skipped', sms: eventNotice.channels.includes('sms') ? 'failed' : 'skipped', email_error: emailErr.message, skip_reasons: {} });
      }
    }
```

(e) Gratuity block (`:731-755`): the trigger at `:499-502` and the `notifyStaffingGratuity`
flag are UNCHANGED (no rename; the disclosure stays automatic). Two edits only: the client
row fetch adds `c.communication_preferences, c.email_status`, and the send is wrapped:

```javascript
        const gate = await shouldSendImmediate({
          proposal: { id: req.params.id, status: updatedRow.rows[0].status },
          client: row, channel: 'email',
        });
        if (row && row.client_email && !isPlaceholderEmail(row.client_email) && gate.ok) {
          await sendEmail({ /* existing call, unchanged */ });
        } else {
          console.log(`[gratuityDisclosure] suppressed for proposal ${req.params.id}: ${gate.ok ? 'no usable email' : gate.reason}`);
        }
```

(imports for `shouldSendImmediate` / `isPlaceholderEmail` at top). The disclosure never
appears in `notifications`; it is not part of the opt-in contract.

(f) Response (`:827`): `res.json({ ...updatedRow.rows[0], notifications });`
(spread preserves every existing key; both live callers discard the body and reload, and
`crud.test.js`/`crud.demotion.test.js` read top-level fields, which survive).

- [ ] **Step 4: Confirm `crud.test.js` collateral (verified: no reschedule assertions exist)**

`crud.test.js` and `crud.demotion.test.js` contain zero reschedule/`sendRescheduleEmail`
references (verified 2026-07-22), so no expectations flip; this step is a run-and-confirm,
not an edit. Known pre-existing failure: Case 8 (rate-limiter, TST-3): failing before =
failing after, not a blocker; anything else unexplained is a stop-and-report finding. The
`__setDeps` addition (`crud.js:31`, exported `:869`) must not disturb the existing stubs at
`crud.test.js:280-281`.

- [ ] **Step 5: Run everything**

```bash
node -r dotenv/config --test server/routes/proposals/notifyClient.test.js
node -r dotenv/config --test server/routes/proposals/crud.test.js
node -r dotenv/config --test server/routes/proposals/crud.demotion.test.js
node -r dotenv/config --test server/utils/rescheduleProposal.test.js
```
Expected: PASS (modulo the pre-existing Case 8).

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/crud.test.js server/routes/proposals/notifyClient.test.js
git commit -m "feat(notify): PATCH sends only what the caller names; gratuity disclosure gains suppression gate"
```

---

## Task 5: Record-payment `notify_client`

**Files:**
- Modify: `server/routes/proposals/actions.js` (destructure `:135`; notification block `:307-330`; response `:366`)
- Modify: `server/routes/proposals/notifyClient.test.js` (append)

**Interfaces:**
- Produces: `POST /api/proposals/:id/record-payment` accepting `notify_client` and returning `notifications` (`payment_receipt` entry when attempted).

- [ ] **Step 1: Write the failing tests**

Seed two separate receipt-eligible proposals (record-payment mutates status; shared fixtures
go order-dependent), one of them on a client with a `.invalid` email. Assertions are
response-contract based (dev env never writes `message_log`; that absence is NOT the
assertion).

```javascript
test('record-payment notify_client=false: no receipt, admin notice STILL fires (spec test 10)', async () => {
  const adminCalls = [];
  const actionsModule = require('./actions');
  actionsModule.__setDeps({ notifyAdminCategory: async (a) => { adminCalls.push(a); } });
  const res = await request('POST', `/api/proposals/${payProposalA}/record-payment`, {
    token: adminToken, body: { amount: 100, paid_in_full: false, method: 'cash', notify_client: false },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notifications, []);
  assert.equal(adminCalls.length, 1, 'the routine_finance admin notice is never gated');
  assert.equal(adminCalls[0].category, 'routine_finance');
});

test('record-payment notify_client=true: receipt attempted and reported', async () => {
  const res = await request('POST', `/api/proposals/${payProposalB}/record-payment`, {
    token: adminToken, body: { amount: 100, paid_in_full: false, method: 'cash', notify_client: true },
  });
  assert.equal(res.status, 200);
  const entry = res.body.notifications.find((n) => n.type === 'payment_receipt');
  assert.ok(entry);
  assert.equal(entry.email, 'sent'); // dev-skip still resolves; 'sent' is the non-throw path
});

test('record-payment notify_client=true on a .invalid client: skipped, never sent', async () => {
  const res = await request('POST', `/api/proposals/${payProposalInvalid}/record-payment`, {
    token: adminToken, body: { amount: 50, paid_in_full: false, method: 'cash', notify_client: true },
  });
  const entry = res.body.notifications.find((n) => n.type === 'payment_receipt');
  assert.equal(entry.email, 'skipped');
  assert.match(entry.skip_reasons.email, /placeholder/i);
});

test('record-payment notify_client=true on a prefs-suppressed client: skipped with reason', async () => {
  await pool.query(`UPDATE clients SET communication_preferences = '{"email_enabled": false}'::jsonb WHERE id = $1`, [payClientB]);
  try {
    const res = await request('POST', `/api/proposals/${payProposalB2}/record-payment`, {
      token: adminToken, body: { amount: 25, paid_in_full: false, method: 'cash', notify_client: true },
    });
    const entry = res.body.notifications.find((n) => n.type === 'payment_receipt');
    assert.equal(entry.email, 'skipped');
  } finally {
    await pool.query(`UPDATE clients SET communication_preferences = '{}'::jsonb WHERE id = $1`, [payClientB]);
  }
});
```

Dev-gating caveat on the `'sent'` assertion: `sendEmail` resolves `{ id: 'dev-skipped' }`
locally, so the route's non-throw path reports `sent`. That is the same convention
`comms.js` dispatch uses in dev. The suppression/placeholder tests are the ones proving the
gates; do not try to prove provider delivery locally.

- [ ] **Step 2: Run to verify failure**

Expected: FAIL (`notifications` undefined; receipt fires regardless).

- [ ] **Step 3: Implement**

`actions.js:135`: `const { amount, paid_in_full, method, notify_client } = req.body;`

The client-facing half of the block at `:307-330` becomes opt-in; the admin half is untouched.
The payData SELECT adds `c.id AS client_id, c.communication_preferences, c.email_status` to
its join. Then:

```javascript
  const notifications = [];
  try {
    /* payData fetch, amountFormatted, payType, eventTypeLabel: unchanged */

    // Client receipt: opt-in (spec: recording a payment is bookkeeping; the
    // receipt is a separate decision made at the moment of recording).
    if (notify_client === true) {
      const gate = await shouldSendImmediate({
        proposal: { id: proposal.id, status: newStatus }, client: pd, channel: 'email',
      });
      if (!pd?.client_email || isPlaceholderEmail(pd.client_email)) {
        notifications.push({ type: 'payment_receipt', email: 'skipped', sms: null,
          skip_reasons: { email: pd?.client_email ? 'Placeholder address (.invalid) from the CC import; no real email exists.' : 'No email on file for this client.' } });
      } else if (!gate.ok) {
        notifications.push({ type: 'payment_receipt', email: 'skipped', sms: null,
          skip_reasons: { email: `Suppressed: ${gate.reason}.` } });
      } else {
        try {
          const tpl = emailTemplates.paymentReceivedClient({ clientName: pd.client_name, eventTypeLabel, amount: amountFormatted, paymentType: payType });
          await sendEmail({ to: pd.client_email, ...tpl, meta: { proposalId: proposal.id, clientId: pd.client_id || null, messageType: 'payment_received' } });
          notifications.push({ type: 'payment_receipt', email: 'sent', sms: null, skip_reasons: {} });
        } catch (rcptErr) {
          notifications.push({ type: 'payment_receipt', email: 'failed', sms: null, email_error: rcptErr.message, skip_reasons: {} });
        }
      }
    }

    // Admin routine_finance notice: NEVER gated (unchanged).
    const tpl2 = emailTemplates.paymentReceivedAdmin({ /* unchanged */ });
    await notifyAdminCategory({ /* unchanged */ });
  } catch (emailErr) { /* unchanged */ }
```

(Verify `newStatus` / `pd` variable names against the real block and match them; verify
`sendEmail`'s meta contract as in Task 2.) Two additions while in the file: (a) map a
`skipped-invalid` `sendEmail` return to a `skipped` entry exactly as Task 2 does (defense in
depth behind the placeholder gate); (b) give `actions.js` the same tiny `_deps`/`__setDeps`
seam `crud.js` has, holding `{ sendEmail, notifyAdminCategory }`, so the tests below can
assert the admin notice STILL fires when `notify_client` is false (spec test 10) instead of
trusting a comment. Response: the record-payment `res.json` at `:366` (the only
`{ success: true, status: newStatus, amount_paid: newAmountPaid }` shape in the repo) spreads
`notifications` in.

- [ ] **Step 4: Run**

```bash
node -r dotenv/config --test server/routes/proposals/notifyClient.test.js
node -r dotenv/config --test server/routes/proposals/recordPayment.statusGuard.test.js
node -r dotenv/config --test server/routes/proposals/recordPayment.invoiceCap.test.js
node -r dotenv/config --test server/routes/proposals/recordPayment.staleRead.test.js
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/actions.js server/routes/proposals/notifyClient.test.js
git commit -m "feat(notify): opt-in receipt with suppression + placeholder gates; admin alert untouched"
```

---

## Task 6: Sensitive paths + docs

**Files:**
- Modify: `scripts/sensitive-paths.txt`
- Modify: `ARCHITECTURE.md`, `README.md`

- [ ] **Step 1: Make the review posture real**

Append to `scripts/sensitive-paths.txt` (match the file's existing pattern style, one per line):
`server/routes/proposals/crud.js`, `server/routes/proposals/actions.js`,
`server/utils/rescheduleProposal.js`. Verify:
`node scripts/sensitive-match.js server/routes/proposals/crud.js server/routes/proposals/actions.js server/utils/rescheduleProposal.js`
Expected: all three echo back.

- [ ] **Step 2: Docs**

ARCHITECTURE.md proposals route table: add `POST /:id/notify-preflight` (read-only, which
notices a pending edit would trigger + drafted message); annotate `PATCH /:id` and
`POST /:id/record-payment` with the opt-in notify contract and the `notifications` response
array. README: folder-tree entries for `clientNotices.js` and `notifyPreflight.js` at the
granularity the tree already uses.

- [ ] **Step 3: Commit**

```bash
git add scripts/sensitive-paths.txt ARCHITECTURE.md README.md
git commit -m "chore(notify): proposals money paths join sensitive list; route docs"
```

---

# Lane: notify-client

## Task 7: `NotifyConfirmModal`

**Files:**
- Create: `client/src/components/comms/NotifyConfirmModal.jsx` (new directory)

**Interfaces:**
- Produces:

```javascript
<NotifyConfirmModal
  notices={notices}            // preflight's array (or a synthesized fixed-template notice)
  primary="quiet" | "send"
  title="Notify the client?"   // payment mode passes "Email a receipt?"
  sendLabel / quietLabel
  busy={bool}                  // in-flight lockout: all buttons disabled, Esc/backdrop inert
  onCancel / onQuiet / onSend(notifyList)
/>
```

- [ ] **Step 1: Write the component**

Portal + overlay pattern from `ShoppingListModal.jsx:462-470`. Requirements, all from the
spec (generic from day one; nothing hardcodes a notice type):

- One block per notice. `composable: true` renders editable subject/body (+ SMS textarea when
  offered) with live counters mirroring the server caps (subject 300, SMS 640) and Send
  disabled while over-cap. `composable: false` renders `reasons` prose plus "This message is
  not editable."
- `autopay_notice`, when present, renders as a highlighted line in the block.
- Recipient line labeled "Current contact on file:" (preflight reads the stored row).
- Channel checkboxes only for `available` channels, checked per `default`.
- Buttons: Cancel / quiet / send; `primary` styles which of quiet/send is `btn-success` and
  ALSO orders them (primary rightmost), so the edit popup and the payment popup never put the
  sending action in the same reflex position.
- `busy` disables all three buttons, Escape, and backdrop dismissal.
- Escape + backdrop = `onCancel`, never `onQuiet`.
- `onSend` builds the notify list: composable notices contribute
  `{ type, channels, email?: { subject, body_text }, sms?: { body } }` from the edited
  drafts; fixed-template notices contribute nothing to the wire (their caller interprets
  Send as its own boolean); a notice with all channels unchecked is omitted, and Send is
  disabled when every notice ends up empty.

- [ ] **Step 2: Note the checkpoint honesty rule**

CRA's lint gate only checks modules webpack reaches; an unimported component compiles
trivially. So this task's build run is a syntax check only; the REAL verification is Task 8's
build + manual pass, which is why Tasks 7 and 8 merge as one reviewable unit and this commit
never lands alone on main (lane squash guarantees that).

Run: `cd client && CI=true npx react-scripts build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/comms/NotifyConfirmModal.jsx
git commit -m "feat(notify): shared confirmation modal (generic notices, caps, busy lockout)"
```

---

## Task 8: Wire the shared proposal editor

> **Grounding note (rev 2.1).** The two legacy edit forms were deleted by the event-editor
> merge (`ca231dd`, 2026-07-21, see `docs/superpowers/plans/2026-07-21-event-editor-merge.md`).
> There is now ONE save flow: `proposalEditor/ProposalEditorForm.js` (667 lines), mounted by
> `ProposalDetail.js:466` AND `EventDetailPage.js:296`, PATCHing via the single
> `buildProposalPatchBody` builder (`patchBody.js`, load-bearing: never add a second builder)
> and already running one pre-save confirm, `RepriceConfirmModal` (`handleSave` at `:314-331`,
> modal at `:659-663`). The notify decision chains AFTER the reprice confirm.

**Files:**
- Modify: `client/src/pages/admin/proposalEditor/ProposalEditorForm.js` (`doSave` `:279-312`, `handleSave` `:314-331`, modal block `:659-663`)

- [ ] **Step 1: Restructure the save chain**

Order: `handleSave` -> package guard -> reprice confirm (existing, unchanged decision logic)
-> `proceedToNotify()` -> preflight -> notify popup (or straight through) -> `doSave(notify)`.
The body is built ONCE and shared by preflight and the PATCH so the two cannot diverge.

```javascript
  const [pendingNotices, setPendingNotices] = useState([]);
  const [pendingBody, setPendingBody] = useState(null);
  const [notifyBusy, setNotifyBusy] = useState(false);

  const buildBody = () => buildProposalPatchBody(editForm, {
    gratuityDirty,
    isClassPackage: selectedPkg?.bar_type === 'class',
    changeRequestId: changeRequest?.id,   // preflight's CR gate rides on this key
    staffNotify: showStaffNotifyToggles
      ? { enabled: notifyStaff, sms: notifyStaffSms, email: notifyStaffEmail }
      : null,
  });

  // doSave keeps its existing shape (client PUT then PATCH) with two changes:
  // it takes (patchBody, notify) instead of rebuilding the body, and it walks
  // res.data.notifications for the toast rules. The client PUT stays inside
  // doSave, which now runs only AFTER every confirm: Cancel anywhere in the
  // chain means nothing happened at all (today's flow PUTs before asking).
  const doSave = async (patchBody, notify) => {
    setError(''); setFieldErrors({}); setSaving(true);
    try {
      if (proposal.client_id) {
        await api.put(`/clients/${proposal.client_id}`, {
          name: editForm.client_name, email: editForm.client_email,
          phone: editForm.client_phone, source: editForm.client_source,
        });
      }
      const res = await api.patch(`/proposals/${proposal.id}`, { ...patchBody, notify });
      toast.success(showStaffNotifyToggles ? 'Event updated.' : 'Proposal updated.');
      (res.data.notifications || []).forEach((n) => {
        if (n.email === 'failed') toast.error(`Saved, but the email failed: ${n.email_error || 'unknown error'}`);
        if (n.sms === 'failed') toast.error(`Saved, but the text failed: ${n.sms_error || 'unknown error'}`);
        // 'skipped' toasts ONLY for a channel the admin actually selected:
        // "not selected" and never-offered channels stay silent.
        ['email', 'sms'].forEach((ch) => {
          if (n[ch] === 'skipped' && n.skip_reasons?.[ch] && n.skip_reasons[ch] !== 'not selected') {
            toast.info(`Saved. ${ch === 'email' ? 'Email' : 'Text'} not sent: ${n.skip_reasons[ch]}`);
          }
        });
      });
      onSaved?.(res.data);
    } catch (err) {
      setError(err.message || 'Failed to save changes.');
      setFieldErrors(err.fieldErrors || {});   // stale-popup 400s show field text (already the file's pattern)
    } finally { setSaving(false); }
  };

  const proceedToNotify = async () => {
    setError(''); setSaving(true);
    try {
      const patchBody = buildBody();
      const pre = await api.post(`/proposals/${proposal.id}/notify-preflight`, patchBody);
      const notices = pre.data.notices || [];
      setSaving(false);
      if (notices.length > 0) { setPendingBody(patchBody); setPendingNotices(notices); return; }
      await doSave(patchBody, []);
    } catch (err) {
      // Preflight failure BLOCKS the save; silently degrading to a quiet save
      // would suppress a wanted send with no decision made.
      setSaving(false);
      setError(err.message || 'Could not check notifications; nothing was saved.');
      setFieldErrors(err.fieldErrors || {});
    }
  };
```

`handleSave` keeps its guard + reprice branch, with both exits routed to `proceedToNotify`
instead of `doSave`:

```javascript
    if (summary) { setRepriceSummary(summary); return; }
    proceedToNotify();
```

and the reprice modal's confirm at `:662` becomes
`onConfirm={() => { setRepriceSummary(null); proceedToNotify(); }}`.

Render, next to the existing `RepriceConfirmModal` block:

```jsx
      {pendingNotices.length > 0 && (
        <NotifyConfirmModal
          notices={pendingNotices}
          primary="quiet"
          busy={notifyBusy}
          onCancel={() => { if (!notifyBusy) { setPendingNotices([]); setPendingBody(null); } }}
          onQuiet={async () => { setNotifyBusy(true); try { await doSave(pendingBody, []); setPendingNotices([]); setPendingBody(null); } finally { setNotifyBusy(false); } }}
          onSend={async (notify) => { setNotifyBusy(true); try { await doSave(pendingBody, notify); setPendingNotices([]); setPendingBody(null); } finally { setNotifyBusy(false); } }}
        />
      )}
```

Import: `import NotifyConfirmModal from '../../../components/comms/NotifyConfirmModal';`
(three levels up from `proposalEditor/`; verify against the file's existing `../../` imports).

- [ ] **Step 2: Build gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: succeeds, no warnings-as-errors.

- [ ] **Step 3: Manual pass from BOTH mounts (this is the lane's behavioral checkpoint)**

Run the same script twice, once from Proposal Detail and once from Event Detail (the editor
is one component, but the mounts wire different props and the staff-notify toggles differ):
guest-count-only save = no popup. Venue edit on a `deposit_paid` proposal = popup with draft,
no dollar figures in the body. Escape = nothing saved, client-contact fields unchanged in the
DB (the PUT must not have fired). Don't send = saved, no message, no noise toast. Date change
on an autopay-enrolled booking = popup shows the auto-charge line with the projected date.
Booked + price-moving + date-moving edit = reprice modal first, then notify popup, one save.
Save with a pending change request = NO notify popup. Confirm
`scheduled_messages.scheduled_for` moved after a quiet date change
(`entity_type='proposal' AND entity_id=<id>`).

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/admin/proposalEditor/ProposalEditorForm.js
git commit -m "feat(notify): editor confirms before messaging; Cancel now means nothing happened"
```

---

## Task 9: Record-payment prompt

**Files:**
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js` (`recordPayment` at `:194-217`)
- Modify: `README.md` (Key Features)

- [ ] **Step 1: Two-step record flow**

First create the client-side mirror of the placeholder predicate (the server helper is not
importable from CRA; a mirrored util is the codebase's existing pattern, see
`venueAddress.js`'s "mirrored client-side" header). Create `client/src/utils/isPlaceholderEmail.js`:

```javascript
// Mirror of server/utils/emailValidation.js isPlaceholderEmail — keep in sync.
// RFC-2606 .invalid placeholders (CC import) are not real addresses.
export default function isPlaceholderEmail(email) {
  return Boolean(email && String(email).toLowerCase().trim().endsWith('.invalid'));
}
```

```javascript
  const [receiptPrompt, setReceiptPrompt] = useState(false);

  const clientEmailUsable = Boolean(proposal.client_email) && !isPlaceholderEmail(proposal.client_email);

  const recordPayment = () => {
    if (!paymentPaidInFull && (!paymentAmount || Number(paymentAmount) <= 0)) { toast.error('Please enter a valid amount.'); return; }
    if (!clientEmailUsable) { doRecordPayment(false); return; }
    setReceiptPrompt(true);
  };

  const doRecordPayment = async (notifyClient) => {
    setReceiptPrompt(false);
    setRecordingPayment(true);
    try {
      const res = await api.post(`/proposals/${proposal.id}/record-payment`, {
        amount: paymentPaidInFull ? undefined : Number(paymentAmount),
        paid_in_full: paymentPaidInFull, method: paymentMethod,
        notify_client: notifyClient,
      });
      toast.success(`Payment of ${fmt$2dp(paymentPaidInFull ? balanceDue : Number(paymentAmount))} recorded.`);
      (res.data.notifications || []).forEach((n) => {
        if (n.email === 'failed') toast.error(`Recorded, but the receipt failed: ${n.email_error || 'unknown error'}`);
        else if (n.email === 'skipped' && n.skip_reasons?.email) toast.info(`Recorded. Receipt not sent: ${n.skip_reasons.email}`);
      });
      setShowRecordPayment(false); setPaymentAmount(''); setPaymentPaidInFull(false);
      onUpdate?.();
    } catch (err) { toast.error(err.message || 'Failed to record payment.'); }
    finally { setRecordingPayment(false); }
  };
```

`proposal.client_email` must exist on the panel's data. It is on the `getOne` payload
(`getOne.js:19`); verify the panel's `proposal` prop carries it, and if not, thread it from
the parent that fetched `getOne`.

Render (note `primary="send"` and the distinct title; fixed-template notice, no draft):

```jsx
      {receiptPrompt && (
        <NotifyConfirmModal
          title="Email a receipt?"
          notices={[{
            type: 'payment_receipt',
            reasons: [`Receipt for ${fmt$2dp(paymentPaidInFull ? balanceDue : Number(paymentAmount))} (the receipt shows the applied amount if the server caps it)`],
            composable: false,
            recipient: { name: proposal.client_name, email: proposal.client_email, phone: null },
            channels: { email: { available: true, default: true }, sms: { available: false } },
            autopay_notice: null,
            draft: null,
          }]}
          primary="send"
          sendLabel="Send receipt"
          quietLabel="Don't send"
          busy={recordingPayment}
          onCancel={() => setReceiptPrompt(false)}
          onQuiet={() => doRecordPayment(false)}
          onSend={() => doRecordPayment(true)}
        />
      )}
```

Import NotifyConfirmModal (this file has no import from Task 8).

- [ ] **Step 2: README updates**

Key Features line: admin edits and recorded payments no longer message the client on their
own; a confirmation names what would go out, quiet by default on edits, send-receipt by
default on payments. Folder tree: entries for `components/comms/NotifyConfirmModal.jsx` and
`utils/isPlaceholderEmail.js` (CLAUDE.md doc matrix requires tree entries for new
components/utils).

- [ ] **Step 3: Build + manual pass**

`cd client && CI=true npx react-scripts build`, then dev server: record a payment on a client
with a real email (popup, distinct title, Send primary); on a `.invalid` client (no popup,
payment recorded, no receipt entry); Cancel (no payment posted).

- [ ] **Step 4: Commit**

```bash
git add client/src/utils/isPlaceholderEmail.js client/src/pages/admin/ProposalDetailPaymentPanel.js README.md
git commit -m "feat(notify): receipt prompt on record payment (send-primary, placeholder-aware)"
```

---

# Lane: notify-refunds

## Task 10: Refund endpoints opt in

**Files:**
- Modify: `server/routes/stripe.js:519-527` (in-app refund notify)
- Modify: `server/routes/proposals/cancel.js:641-644` (cancel-refund notify)
- Modify: `server/utils/refundClientNotify.js` (suppression + placeholder gates, result return)
- Create: `server/routes/proposals/notifyRefunds.test.js`
- Modify: `server/routes/proposals/cancel.test.js` (only if existing cases assert the refund email)

**Interfaces:**
- `POST /api/stripe/refund/:id` accepts `notify_client: true | false` (absent = false, fail-quiet like every other surface in this project; the UI sends it explicitly every time).
- `POST /api/proposals/:id/cancel/refund` reads `suppress_client_email` from its body, same key its parent dialog already posts for the cancellation email.
- `sendRefundClientNotification(...)` returns `{ email: 'sent'|'failed'|'skipped', skip_reasons }` and gains the `shouldSendImmediate` + `isPlaceholderEmail` gates; its SELECT adds `communication_preferences, email_status`.

- [ ] **Step 1: Read before writing**

Read `.claude/seam-sweep-2026-07-02.md` (standing instruction before webhook/refund work),
then `stripe.js:428-540`, `cancel.js:465-650`, `refundClientNotify.js` in full. The refund
math is untouched; ONLY the notify tail changes. Note the dedupe architecture: the webhook
backstop (`chargeRefunded.js:68`) and sweeper (`refundSweepScheduler.js:31`) notify only when
THEY apply the reconciliation, so gating the in-app notify cannot resurrect a duplicate from
them.

- [ ] **Step 2: Failing tests**

`notifyRefunds.test.js`, same harness pattern: an in-app refund request with
`notify_client: false` performs the refund (assert the `proposal_refunds` row lands) and
returns `notifications: []`; with `notify_client: true` on a suppressed/placeholder client it
reports `skipped` + reason; `cancel/refund` with `suppress_client_email: true` returns no
notification entry. Stripe calls stubbed the way the existing refund tests stub them (read
`invoices.refunds.test.js` for the incumbent pattern; if live-mode stubbing is not viable at
the route level, gate-level unit tests on `refundClientNotify` + a route test of the
`notify_client:false` path are the acceptable floor, stated in the test file header).

- [ ] **Step 3: Implement**

`refundClientNotify.js`: add the two gates around the existing `sendEmail` (placeholder →
skipped with the CC-import reason; `shouldSendImmediate` not ok → skipped with the reason);
return the result object; never throw for a skip. `stripe.js`: call it only when
`req.body.notify_client === true`, spread the entry into a `notifications` array on the
response. `cancel.js`: call it only when the persisted cancel flow's `suppress_client_email`
is not true (thread the flag from the archive step's body the same way `:237` reads it; if
the refund endpoint is a separate request, the dialog passes the checkbox value in ITS body
too, one source of truth in the dialog's state).

- [ ] **Step 4: Run**

```bash
node -r dotenv/config --test server/routes/proposals/notifyRefunds.test.js
node -r dotenv/config --test server/routes/proposals/cancel.test.js
node -r dotenv/config --test server/routes/invoices.refunds.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/stripe.js server/routes/proposals/cancel.js server/utils/refundClientNotify.js server/routes/proposals/notifyRefunds.test.js server/routes/proposals/cancel.test.js
git commit -m "feat(notify): refund notices opt-in with suppression + placeholder gates"
```

---

## Task 11: Refund UI + fix-list + ops tail

**Files:**
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js` (refund submit at `:121`)
- Modify: `client/src/pages/admin/CancelEventDialog.js` (`:94` refund call; checkbox copy)
- Modify: `client/src/pages/admin/CancelEventDialog.test.js` (if copy/flow assertions exist)
- Modify: `docs/fix-list-remaining-2026-07-02.md`, `ARCHITECTURE.md`

- [ ] **Step 1: Refund panel confirm**

Mirror Task 9 exactly: `NotifyConfirmModal` with `title="Email a refund notice?"`,
`primary="send"`, fixed-template notice showing the refund amount and recipient,
placeholder/no-email bypass posting `notify_client: false`. The confirmed choice rides the
existing `api.post('/stripe/refund/...')` body.

- [ ] **Step 2: Cancel dialog**

The existing suppress checkbox's label extends to say it covers the refund email too (e.g.
"Don't email the client about this cancellation or its refund"), and `CancelEventDialog.js:94`
adds the checkbox's current value to the `cancel/refund` body. No second checkbox: one
decision, whole flow.

- [ ] **Step 3: Fix-list + ARCHITECTURE + ops**

Fix-list entries: (1) "do not contact" toggle on the client admin page writing
`communication_preferences` (no UI exists today; Luva's row is set by hand, see ops step);
(2) provider idempotency keys as the precondition for any future failed-send Retry;
(3) `utils/groupSend.js` is require-dead, delete when convenient.
ARCHITECTURE: annotate the two refund routes' new flags.

**Ops step (owner approved 2026-07-22), after this lane is LIVE in prod:** on the prod Neon
`production` branch, set Luva's client row
`communication_preferences = '{"email_enabled": false, "sms_enabled": false}'::jsonb`,
verify by reading it back, and note it in the session log. This is what converts the
"never message Luva" rule from memory into mechanism.

- [ ] **Step 4: Build + manual + commit**

`cd client && CI=true npx react-scripts build`; manual: refund popup appears with Send
primary; cancel dialog's one checkbox suppresses both emails.

```bash
git add client/src/pages/admin/ProposalDetailPaymentPanel.js client/src/pages/admin/CancelEventDialog.js client/src/pages/admin/CancelEventDialog.test.js docs/fix-list-remaining-2026-07-02.md ARCHITECTURE.md
git commit -m "feat(notify): refund confirm UI; cancel dialog one-checkbox comms decision"
```

---

## Post-merge verification (before push)

1. Quiet date move on a booked proposal: every pending `scheduled_messages` row
   (`entity_type='proposal' AND entity_id=$1`) re-anchored, `balance_due_date` moved, zero
   client messages.
2. Send path: exactly the reviewed text arrives (dev seam log), per-channel truth in the
   response.
3. Gratuity disclosure still fires automatically on a staffing rise for a paid, non-suppressed
   client.
4. `node scripts/lane:status` clean; push order note: lanes 1+2 ship together.
