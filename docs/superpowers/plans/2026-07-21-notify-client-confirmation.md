# Notify-Client Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop admin edits from messaging the client on their own. Put a confirmation in front of the reschedule notice, the gratuity-increase notice, and the payment receipt, and default the quiet path on edits.

**Architecture:** Notice detection moves out of `crud.js` into one shared module, `server/utils/clientNotices.js`, which both a new read-only preflight endpoint and the PATCH itself call. Nothing sends unless the request names the notice. The reschedule message is composed at preflight (it renders old-vs-new, and the old values do not survive the save) and the reviewed text rides along on the PATCH. A single React modal serves both edit forms and the payment panel.

**Tech Stack:** Node.js 26 / Express 4, React 18 (CRA), Postgres (raw SQL via `pg`), `node:test` for server tests.

**Spec:** `docs/superpowers/specs/2026-07-21-notify-client-confirmation-design.md`

## Global Constraints

- **Suppression gates the send ONLY.** `rescheduleProposalInTx` (`crud.js:632`) re-anchors pending scheduled messages and recomputes `balance_due_date`. That call stays unconditional. Never put it behind a notify check.
- Also never gated by `notify`: `runRescheduleStaffHooks` (`crud.js:782`), `notifyAdminCategory` on a recorded payment (`actions.js:323`), the invoice refresh, `recomputeNewYearHelloForProposal`.
- **Fail-quiet.** Absent or empty `notify` sends nothing. Never fall back to the built-in template.
- Strictness differs by notice type: a requested-but-untriggered `event_details_changed` is a `ValidationError`; a requested-but-untriggered `gratuity_increase` is a silent skip reported in the response.
- The send stays best-effort and post-commit. A Resend or Twilio throw must never 500 a PATCH whose transaction already committed (`crud.js:706-709` says why).
- `shouldSendImmediate` still wins. An explicit Send does not override an unsubscribe or a hard bounce.
- Wire keys are snake_case (`notify_client`, `body_text`, `entity_id`).
- Client-visible server errors throw `ValidationError`/`AppError` subclasses, never `res.status(400).json(...)`.
- Client API calls go through `client/src/utils/api.js`, never raw fetch/axios.
- No new DB column, no schema migration, no new env var.
- Server test suites run one at a time against the shared dev DB: `node -r dotenv/config --test <file>`.
- Verify client changes with `CI=true npx react-scripts build` from `client/`.
- No em dashes in any client-facing copy.

## Lane map

```yaml
lanes:
  - id: notify-server
    footprint:
      - server/utils/clientNotices.js
      - server/utils/rescheduleProposal.js
      - server/routes/proposals/notifyPreflight.js
      - server/routes/proposals/index.js
      - server/routes/proposals/crud.js
      - server/routes/proposals/actions.js
      - server/routes/proposals/notifyClient.test.js
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [security-review, database-review, code-review, consistency-check]
  - id: notify-client
    footprint:
      - client/src/components/comms/NotifyConfirmModal.jsx
      - client/src/pages/admin/EventEditForm.js
      - client/src/pages/admin/ProposalDetailEditForm.js
      - client/src/pages/admin/ProposalDetailPaymentPanel.js
      - README.md
    depends_on: [notify-server]
    review_fleet: [code-review, consistency-check]
```

Two lanes, serialized. `notify-server` touches `proposals/crud.js` and `proposals/actions.js`, both on `scripts/sensitive-paths.txt`, so it earns the full fleet plus `/second-opinion` at push. Keeping it separate means the money-path change is reviewed and merged before any UI is built on top of it. `notify-client` is presentation only and gets the lighter pair.

---

# Lane: notify-server

## Task 1: Shared notice detection module

**Files:**
- Create: `server/utils/clientNotices.js`
- Create: `server/routes/proposals/notifyClient.test.js` (grows through Tasks 1, 3, 4, 5)

**Interfaces:**
- Consumes: `hasReschedulableChange` from `server/utils/rescheduleProposal.js` (already exported, `:598`), `BOOKED_SET` from `server/utils/proposalStatus.js`.
- Produces:
  - `NOTICE_EVENT_DETAILS = 'event_details_changed'`, `NOTICE_GRATUITY = 'gratuity_increase'`
  - `eventDetailsNoticeApplies({ old, updated, status }) -> boolean`
  - `gratuityNoticeApplies({ oldGratuityTotal, newGratuityTotal, isPaidForGratuity, gratuityOrigin }) -> boolean`
  - `gratuityNoticePossible({ old, body, status }) -> boolean` (preflight's conservative prediction)
  - `validateNotifyList(notify) -> [{ type, channels, email, sms }]` (structural only; throws `ValidationError`)

- [ ] **Step 1: Write the failing test**

Create `server/routes/proposals/notifyClient.test.js`:

```javascript
'use strict';

// Notice detection + the notify contract on PATCH /api/proposals/:id and
// POST /api/proposals/:id/record-payment.
// Runs ALONE against the shared dev DB: node -r dotenv/config --test.
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  NOTICE_EVENT_DETAILS,
  NOTICE_GRATUITY,
  eventDetailsNoticeApplies,
  gratuityNoticeApplies,
  validateNotifyList,
} = require('../../utils/clientNotices');

test('eventDetailsNoticeApplies: booked + location change fires', () => {
  assert.equal(eventDetailsNoticeApplies({
    old: { event_date: '2026-09-01', event_start_time: '18:00', event_location: 'The Ivy Room' },
    updated: { event_date: '2026-09-01', event_start_time: '18:00', event_location: '2700 W Chicago Ave' },
    status: 'deposit_paid',
  }), true);
});

test('eventDetailsNoticeApplies: unbooked status never fires', () => {
  assert.equal(eventDetailsNoticeApplies({
    old: { event_date: '2026-09-01', event_start_time: '18:00', event_location: 'A' },
    updated: { event_date: '2026-10-01', event_start_time: '18:00', event_location: 'A' },
    status: 'sent',
  }), false);
});

test('eventDetailsNoticeApplies: archived never fires', () => {
  assert.equal(eventDetailsNoticeApplies({
    old: { event_date: '2026-09-01', event_start_time: '18:00', event_location: 'A' },
    updated: { event_date: '2026-10-01', event_start_time: '18:00', event_location: 'A' },
    status: 'archived',
  }), false);
});

test('eventDetailsNoticeApplies: a non-reschedulable edit does not fire', () => {
  assert.equal(eventDetailsNoticeApplies({
    old: { event_date: '2026-09-01', event_start_time: '18:00', event_location: 'A' },
    updated: { event_date: '2026-09-01', event_start_time: '18:00', event_location: 'A' },
    status: 'deposit_paid',
  }), false);
});

test('gratuityNoticeApplies: only on a staffing-driven increase', () => {
  const base = { isPaidForGratuity: true, gratuityOrigin: 'package' };
  assert.equal(gratuityNoticeApplies({ ...base, oldGratuityTotal: 450, newGratuityTotal: 600 }), true);
  assert.equal(gratuityNoticeApplies({ ...base, oldGratuityTotal: 600, newGratuityTotal: 450 }), false);
  assert.equal(gratuityNoticeApplies({ ...base, oldGratuityTotal: 450, newGratuityTotal: 450 }), false);
  assert.equal(gratuityNoticeApplies({ ...base, gratuityOrigin: 'admin', oldGratuityTotal: 450, newGratuityTotal: 600 }), false);
  assert.equal(gratuityNoticeApplies({ ...base, isPaidForGratuity: false, oldGratuityTotal: 450, newGratuityTotal: 600 }), false);
});

test('validateNotifyList: absent or empty is an empty list, not an error', () => {
  assert.deepEqual(validateNotifyList(undefined), []);
  assert.deepEqual(validateNotifyList([]), []);
});

test('validateNotifyList: unknown type rejects', () => {
  assert.throws(() => validateNotifyList([{ type: 'nope', channels: ['email'] }]), /Unknown notice type/);
});

test('validateNotifyList: duplicate type rejects', () => {
  assert.throws(() => validateNotifyList([
    { type: NOTICE_EVENT_DETAILS, channels: ['email'], email: { subject: 's', body_text: 'b' } },
    { type: NOTICE_EVENT_DETAILS, channels: ['email'], email: { subject: 's', body_text: 'b' } },
  ]), /Duplicate notice type/);
});

test('validateNotifyList: event_details_changed with an email channel needs text', () => {
  assert.throws(() => validateNotifyList([{ type: NOTICE_EVENT_DETAILS, channels: ['email'] }]), /Subject cannot be empty/);
});

test('validateNotifyList: subject CR/LF stripped and capped like comms.js', () => {
  const out = validateNotifyList([{
    type: NOTICE_EVENT_DETAILS,
    channels: ['email'],
    email: { subject: 'New\r\ndate', body_text: 'body' },
  }]);
  assert.equal(out[0].email.subject, 'New date');
  assert.throws(() => validateNotifyList([{
    type: NOTICE_EVENT_DETAILS, channels: ['email'],
    email: { subject: 'x'.repeat(301), body_text: 'b' },
  }]), /over the 300 character cap/);
});

test('validateNotifyList: SMS over 640 chars rejects', () => {
  assert.throws(() => validateNotifyList([{
    type: NOTICE_EVENT_DETAILS, channels: ['sms'], sms: { body: 'x'.repeat(641) },
  }]), /over the 640 character cap/);
});

test('validateNotifyList: gratuity_increase rejects supplied text', () => {
  assert.throws(() => validateNotifyList([{
    type: NOTICE_GRATUITY, channels: ['email'], email: { subject: 's', body_text: 'b' },
  }]), /does not accept a custom message/);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: FAIL, `Cannot find module '../../utils/clientNotices'`.

- [ ] **Step 3: Write the module**

Create `server/utils/clientNotices.js`:

```javascript
'use strict';

// Which client notices a proposal edit triggers, and structural validation of
// the caller's opt-in list. ONE module so the read-only preflight endpoint and
// the PATCH itself can never drift on the question "would this send?".
//
// Suppression gates the SEND only. Nothing here decides whether pending
// messages get re-anchored or whether balance_due_date moves; those are
// correctness, not communication, and stay unconditional in crud.js.
const { hasReschedulableChange } = require('./rescheduleProposal');
const { BOOKED_SET } = require('./proposalStatus');
const { ValidationError } = require('./errors');

const NOTICE_EVENT_DETAILS = 'event_details_changed';
const NOTICE_GRATUITY = 'gratuity_increase';

// Mirrors the caps enforced on the shared comms path (server/routes/comms.js:18,
// :94). Duplicated as constants, not as logic: both paths must reject the same
// inputs, and a divergence here is a review finding.
const SUBJECT_MAX = 300;
const SMS_MAX_CHARS = 640;

// Composable = the caller supplies the text, because the template renders
// old-vs-new and those values do not survive the save. Non-composable notices
// use their built-in template and reject supplied text outright.
const NOTICE_META = {
  [NOTICE_EVENT_DETAILS]: { composable: true, allowedChannels: ['email', 'sms'] },
  [NOTICE_GRATUITY]: { composable: false, allowedChannels: ['email'] },
};

/**
 * Does this edit trigger the event-details notice? Delegates the field list and
 * the status gate to the same helpers the send path uses
 * (rescheduleProposal.js:64, :412) so a new reschedulable field lands in both
 * places or neither.
 */
function eventDetailsNoticeApplies({ old, updated, status }) {
  if (!status || status === 'archived' || !BOOKED_SET.has(status)) return false;
  return hasReschedulableChange(old, updated);
}

/**
 * Does this edit trigger the gratuity notice? Same condition as crud.js:498-501:
 * a staffing-driven move (not an admin override) that raised the amount on a
 * proposal already paid for gratuity purposes.
 */
function gratuityNoticeApplies({ oldGratuityTotal, newGratuityTotal, isPaidForGratuity, gratuityOrigin }) {
  if (!isPaidForGratuity) return false;
  if (gratuityOrigin === 'admin') return false;
  return Number(newGratuityTotal) > Number(oldGratuityTotal);
}

/**
 * Preflight's conservative prediction for the gratuity notice.
 *
 * The real answer needs the post-pricing-engine snapshot, which only exists
 * mid-transaction. Re-marshalling every pricing input in a read-only endpoint
 * would duplicate most of the PATCH on a money path, so preflight instead asks
 * the cheap question: could this edit move staffing on a proposal that is paid?
 * The save recomputes and silently skips the notice if it did not actually fire.
 *
 * False positives are acceptable (a popup that sends nothing). False negatives
 * are not, so err toward true.
 */
function gratuityNoticePossible({ old, body, status }) {
  if (!status || status === 'archived' || !BOOKED_SET.has(status)) return false;
  if (!(Number(old.amount_paid) > 0)) return false;
  const staffingInputs = ['num_bartenders', 'num_bars', 'guest_count', 'addon_ids', 'addon_quantities', 'event_duration_hours'];
  return staffingInputs.some((k) => body[k] !== undefined);
}

function cleanSubject(raw) {
  const subject = String(raw ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (!subject) throw new ValidationError({ subject: 'Subject cannot be empty.' });
  if (subject.length > SUBJECT_MAX) {
    throw new ValidationError({ subject: `Subject is over the ${SUBJECT_MAX} character cap.` });
  }
  return subject;
}

/**
 * Structural validation of the caller's notify list. Runs BEFORE any
 * transaction opens, so a malformed request never reaches BEGIN. Does NOT check
 * whether the save actually triggers these notices; that is a trigger check and
 * happens where the notice set is computed (mid-transaction for gratuity).
 *
 * Returns a normalized list. Throws ValidationError on anything malformed.
 */
function validateNotifyList(notify) {
  if (notify === undefined || notify === null) return [];
  if (!Array.isArray(notify)) throw new ValidationError({ notify: 'notify must be an array.' });

  const seen = new Set();
  return notify.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new ValidationError({ notify: 'Each notice must be an object.' });
    const meta = NOTICE_META[entry.type];
    if (!meta) throw new ValidationError({ notify: `Unknown notice type: ${entry.type}` });
    if (seen.has(entry.type)) throw new ValidationError({ notify: `Duplicate notice type: ${entry.type}` });
    seen.add(entry.type);

    const channels = Array.isArray(entry.channels)
      ? entry.channels.filter((c) => meta.allowedChannels.includes(c))
      : [];
    if (channels.length === 0) {
      throw new ValidationError({ channels: `${entry.type} needs at least one channel.` });
    }

    const out = { type: entry.type, channels };

    if (!meta.composable) {
      if (entry.email || entry.sms) {
        throw new ValidationError({ notify: `${entry.type} does not accept a custom message.` });
      }
      return out;
    }

    if (channels.includes('email')) {
      out.email = {
        subject: cleanSubject(entry.email?.subject),
        bodyText: String(entry.email?.body_text ?? '').trim(),
      };
      if (!out.email.bodyText) throw new ValidationError({ body_text: 'Message cannot be empty.' });
    }
    if (channels.includes('sms')) {
      const body = String(entry.sms?.body ?? '').trim();
      if (!body) throw new ValidationError({ sms_body: 'SMS message cannot be empty.' });
      if (body.length > SMS_MAX_CHARS) {
        throw new ValidationError({ sms_body: `SMS message is over the ${SMS_MAX_CHARS} character cap.` });
      }
      out.sms = { body };
    }
    return out;
  });
}

module.exports = {
  NOTICE_EVENT_DETAILS,
  NOTICE_GRATUITY,
  NOTICE_META,
  eventDetailsNoticeApplies,
  gratuityNoticeApplies,
  gratuityNoticePossible,
  validateNotifyList,
};
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add server/utils/clientNotices.js server/routes/proposals/notifyClient.test.js
git commit -m "feat(notify): shared client-notice detection + notify-list validation"
```

---

## Task 2: `sendRescheduleEmail` accepts supplied text

**Files:**
- Modify: `server/utils/rescheduleProposal.js:197` (signature), `:301-320` (email half), `:324-350` (SMS half)

**Interfaces:**
- Consumes: nothing new.
- Produces: `sendRescheduleEmail({ proposalId, old, updated, channels, message })` where `channels` is `['email'|'sms']` (required, no default) and `message` is `{ email: {subject, bodyText}, sms: {body} }` (required for each selected channel). Returns `{ email, sms, email_error, sms_error, skip_reasons }`, the same per-channel shape `comms.js` returns.

The old no-argument behavior (build from template, send both channels) is removed, not kept as a fallback. There is exactly one composition path, and it is the caller's.

- [ ] **Step 1: Change the signature and gate each channel on the caller's selection**

In `server/utils/rescheduleProposal.js`, change line 197 from:

```javascript
async function sendRescheduleEmail({ proposalId, old, updated }) {
```

to:

```javascript
/**
 * Sends the event-details notice on the caller's selected channels using the
 * caller's reviewed text. Composition happens upstream (notify-preflight)
 * because this template renders old-vs-new and the old values do not survive
 * the save; see the spec's "Why the draft is built at preflight".
 *
 * `channels` and `message` are REQUIRED. There is no template fallback: a
 * caller that did not compose did not intend to send.
 */
async function sendRescheduleEmail({ proposalId, old, updated, channels, message }) {
  const wantEmail = Array.isArray(channels) && channels.includes('email');
  const wantSms = Array.isArray(channels) && channels.includes('sms');
  const results = { email: 'skipped', sms: 'skipped', skip_reasons: {} };
  if (!wantEmail) results.skip_reasons.email = 'not selected';
  if (!wantSms) results.skip_reasons.sms = 'not selected';
```

- [ ] **Step 2: Replace the "both channels have no destination" throw with a skip**

Immediately after, replace the block at the old `:217-219`:

```javascript
  if (!ctx.client_email && !ctx.client_phone) {
    throw new Error(`rescheduleProposal: proposal ${proposalId} client has no email and no phone`);
  }
```

with:

```javascript
  if (!ctx.client_email && !ctx.client_phone) {
    // No destination at all. Report it rather than throwing: this now runs
    // behind an explicit admin Send, and the response carries per-channel truth.
    if (wantEmail) results.skip_reasons.email = 'No email on file for this client.';
    if (wantSms) results.skip_reasons.sms = 'No usable phone on file.';
    return results;
  }
```

- [ ] **Step 3: Gate the suppression early-return the same way**

Replace the old `:239-242`:

```javascript
  if (!emailCheck.ok && !smsCheck.ok) {
    console.log(`[rescheduleNotification] both channels suppressed for proposal ${proposalId}: email=${emailCheck.reason} sms=${smsCheck.reason}`);
    return;
  }
```

with:

```javascript
  if (!emailCheck.ok && !smsCheck.ok) {
    console.log(`[rescheduleNotification] both channels suppressed for proposal ${proposalId}: email=${emailCheck.reason} sms=${smsCheck.reason}`);
    if (wantEmail) results.skip_reasons.email = emailCheck.reason;
    if (wantSms) results.skip_reasons.sms = smsCheck.reason;
    return results;
  }
```

- [ ] **Step 4: Send the supplied text, and record per-channel truth**

Replace the email half (old `:301-320`, the `if (emailCheck.ok && ctx.client_email) {` block) with:

```javascript
  if (wantEmail && emailCheck.ok && ctx.client_email) {
    // WYSIWYG: the admin's reviewed text IS the email body. renderPartsEmail is
    // the same editable-body renderer shoppingListApprove.js:194 uses.
    //
    // We deliberately do NOT call emailTemplates.rescheduleNotificationClient
    // here. It returns pre-rendered { subject, html, text } with the old-vs-new
    // details baked into a styled <ul>, so an edited body would reach only the
    // plaintext while every real mail client rendered the untouched HTML. The
    // admin would approve one message and the client would get another. The
    // old-vs-new facts now live in the drafted prose (buildEventDetailsDraft).
    const { renderPartsEmail } = require('./comms/render');
    const rendered = renderPartsEmail({
      subject: message.email.subject,
      heading: 'Updated details for your event',
      bodyText: message.email.bodyText,
      cta: null,
    });
    try {
      await sendEmail({
        to: ctx.client_email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      results.email = 'sent';
    } catch (err) {
      results.email = 'failed';
      results.email_error = err.message || 'Email send failed.';
    }
  } else if (wantEmail) {
    results.skip_reasons.email = emailCheck.ok ? 'No email on file for this client.' : emailCheck.reason;
  }
```

**Note for the implementer:** `emailTemplates.rescheduleNotificationClient` becomes unused by this path. Leave it in place, do not delete it, and check `grep -rn "rescheduleNotificationClient" server` for other callers before assuming it is dead.

Replace the SMS half's send with the supplied body:

```javascript
  if (wantSms && smsCheck.ok && ctx.client_phone) {
    try {
      const { sendAndLogSms } = require('./sms');
      await sendAndLogSms({ to: ctx.client_phone, body: message.sms.body, clientId: ctx.client_id, proposalId: ctx.id });
      results.sms = 'sent';
    } catch (err) {
      results.sms = 'failed';
      results.sms_error = err.message || 'SMS send failed.';
    }
  } else if (wantSms) {
    results.skip_reasons.sms = smsCheck.ok ? 'No usable phone on file.' : smsCheck.reason;
  }

  return results;
```

**Note for the implementer:** read the existing SMS half at `:324-350` first and preserve its exact `sendAndLogSms` argument shape and its message-type logging. Only the body source and the result recording change.

- [ ] **Step 5: Verify nothing else calls the old signature**

Run: `grep -rn "sendRescheduleEmail" server --include=*.js | grep -v "\.test\."`
Expected: exactly two hits, the definition/export in `rescheduleProposal.js` and the import in `crud.js:15`. The `crud.js` call site is updated in Task 4.

- [ ] **Step 6: Commit**

```bash
git add server/utils/rescheduleProposal.js
git commit -m "feat(notify): sendRescheduleEmail takes explicit channels + reviewed text"
```

---

## Task 3: Preflight endpoint

**Files:**
- Create: `server/routes/proposals/notifyPreflight.js`
- Modify: `server/routes/proposals/index.js` (mount before `crud`)
- Modify: `server/routes/proposals/notifyClient.test.js` (append)

**Interfaces:**
- Consumes: `eventDetailsNoticeApplies`, `gratuityNoticePossible`, `NOTICE_*` from Task 1.
- Produces: `POST /api/proposals/:id/notify-preflight` returning `{ notices: [...] }` per the spec's shape.

- [ ] **Step 1: Write the failing test**

Append to `server/routes/proposals/notifyClient.test.js`. Copy the `request()` helper, `before`, and `after` blocks verbatim from `server/routes/comms.silent.test.js:22-60` (the express + node:http harness; there is no supertest in this repo), seeding a client, a `deposit_paid` proposal with `event_location = 'The Ivy Room'`, and an admin JWT.

```javascript
test('preflight: location change on a booked proposal returns the event-details notice with a draft', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken,
    body: { event_location: '2700 W Chicago Ave' },
  });
  assert.equal(res.status, 200);
  const notice = res.body.notices.find(n => n.type === 'event_details_changed');
  assert.ok(notice, 'expected an event_details_changed notice');
  assert.equal(notice.composable, true);
  assert.ok(notice.draft.email.subject.length > 0);
  assert.ok(notice.draft.sms.body.length > 0);
  assert.ok(notice.reasons.some(r => r.includes('event_location')));
});

test('preflight: an unrelated edit returns no notices', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken,
    body: { guest_count: 90 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.notices.filter(n => n.type === 'event_details_changed').length, 0);
});

test('preflight writes nothing', async () => {
  const before = await pool.query('SELECT event_location, updated_at FROM proposals WHERE id = $1', [proposalId]);
  await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    token: adminToken, body: { event_location: 'Somewhere Else' },
  });
  const after = await pool.query('SELECT event_location, updated_at FROM proposals WHERE id = $1', [proposalId]);
  assert.deepEqual(before.rows[0], after.rows[0]);
});

test('preflight requires admin or manager', async () => {
  const res = await request('POST', `/api/proposals/${proposalId}/notify-preflight`, {
    body: { event_location: 'X' },
  });
  assert.equal(res.status, 401);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: FAIL with 404 on the preflight path.

- [ ] **Step 3: Write the route**

Create `server/routes/proposals/notifyPreflight.js`:

```javascript
'use strict';

// POST /api/proposals/:id/notify-preflight — read-only. Answers "would saving
// these edits message the client, and what would it say?" so the admin form can
// put a confirmation in front of the save.
//
// READ ONLY. It opens no transaction and writes nothing. The save recomputes
// its own notice set and is the authority; this endpoint exists so the UI can
// ask without guessing, and so the reschedule draft can be composed while the
// OLD field values still exist.
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const {
  NOTICE_EVENT_DETAILS,
  NOTICE_GRATUITY,
  eventDetailsNoticeApplies,
  gratuityNoticePossible,
} = require('../../utils/clientNotices');
const { buildEventDetailsDraft } = require('../../utils/rescheduleProposal');
const { normalizePhone } = require('../../utils/sms');

const router = express.Router();

const RESCHEDULABLE = ['event_date', 'event_start_time', 'event_location'];

router.post('/:id/notify-preflight', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError({ id: 'Invalid proposal id.' });

  const { rows } = await pool.query(
    `SELECT p.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone
       FROM proposals p LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [id]
  );
  const old = rows[0];
  if (!old) throw new NotFoundError('Proposal not found');

  const body = req.body || {};
  // Merge the pending edits over the stored row so the comparison sees exactly
  // what the save will see. COALESCE semantics: an undefined field is unchanged.
  const updated = { ...old };
  for (const f of RESCHEDULABLE) {
    if (body[f] !== undefined) updated[f] = body[f];
  }
  // The venue fields compose into event_location the same way crud.js does; when
  // the form sends venue parts instead of event_location, reuse that composition
  // rather than reimplementing it. See crud.js's $17 location argument.
  if (body.event_location === undefined && body.venue_name !== undefined) {
    const { composeEventLocation } = require('../../utils/venue');
    updated.event_location = composeEventLocation(body);
  }

  const phone = old.client_phone ? normalizePhone(old.client_phone) : null;
  const recipient = { name: old.client_name || null, email: old.client_email || null, phone };
  const channels = {
    email: {
      available: Boolean(old.client_email),
      default: Boolean(old.client_email),
      unavailable_reason: old.client_email ? null : 'No email on file.',
    },
    sms: {
      available: Boolean(phone),
      default: Boolean(phone),
      unavailable_reason: phone ? null : 'No usable phone on file.',
    },
  };

  const notices = [];

  if (eventDetailsNoticeApplies({ old, updated, status: old.status })) {
    const reasons = RESCHEDULABLE
      .filter((f) => String(old[f] ?? '').trim() !== String(updated[f] ?? '').trim())
      .map((f) => `${f} changed`);
    notices.push({
      type: NOTICE_EVENT_DETAILS,
      reasons,
      composable: true,
      recipient,
      channels,
      draft: await buildEventDetailsDraft({ proposalId: id, old, updated }),
    });
  }

  if (gratuityNoticePossible({ old, body, status: old.status })) {
    notices.push({
      type: NOTICE_GRATUITY,
      reasons: ['staffing may raise the gratuity total'],
      composable: false,
      recipient,
      channels: { email: channels.email, sms: { available: false, default: false, unavailable_reason: 'This notice is email only.' } },
      draft: null,
    });
  }

  res.json({ notices });
}));

module.exports = router;
```

**Note for the implementer:** two helpers are referenced that may not exist yet.

1. `buildEventDetailsDraft({ proposalId, old, updated })` in `rescheduleProposal.js`. Reuse the timezone resolution and the `fmtDate` / `fmtTime` helpers already inside `sendRescheduleEmail` (extract them to module scope), and compose prose rather than calling `rescheduleNotificationClient` (see Task 2 for why). It must return `{ email: { subject, body_text }, sms: { body } }`. The SMS half keeps using `smsTemplates.rescheduleSms({ newDate, newStartTime, newLocation })`. Suggested body, with only the lines whose field actually changed:

```javascript
const lines = [];
if (dateChanged) lines.push(`Date: ${fmtDate(old.event_date)} is now ${fmtDate(updated.event_date)}`);
if (timeChanged) lines.push(`Start time: ${fmtTime(old.event_date, old.event_start_time)} is now ${fmtTime(updated.event_date, updated.event_start_time)}`);
if (locationChanged) lines.push(`Location: ${old.event_location || 'TBD'} is now ${updated.event_location || 'TBD'}`);

const body_text = [
  `Hi ${firstName || 'there'},`,
  'Your event details have been updated. Here is what changed:',
  lines.join('\n'),
  `Everything else stays the same: ${ctx.package_name || 'your package'} for ${ctx.guest_count} guests, total $${totalFormatted}.`,
  balanceDueDateLocal ? `${ctx.autopay_enrolled ? 'Your balance auto-charges' : 'Your balance is due'} on ${balanceDueDateLocal}.` : null,
  'Let me know if you have any questions.',
].filter(Boolean).join('\n\n');
```

`renderPartsEmail` splits on blank lines into paragraphs, which is why the joins above use `\n\n` between blocks and `\n` within the changed-field list. Subject stays `'Updated details for your event'`.
2. `composeEventLocation` in a venue util. Check `server/utils/venue.js` (or wherever `validateVenue` lives, imported by `crud.js`) for the existing composition. If `crud.js` composes the location inline for its `$17` argument, extract that expression into the shared util and have `crud.js` call it, so the two paths cannot drift. Do not reimplement the concatenation.

- [ ] **Step 4: Mount it**

In `server/routes/proposals/index.js`, add above the `crud` line:

```javascript
router.use('/', require('./notifyPreflight'));
```

It is a POST on a specific suffix path, so it does not collide with `getOne`'s greedy `GET /:id`, but keep it above `crud` for readability.

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: PASS, all tests including the four new ones.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/notifyPreflight.js server/routes/proposals/index.js server/utils/rescheduleProposal.js server/routes/proposals/notifyClient.test.js
git commit -m "feat(notify): read-only notify-preflight endpoint + shared draft builder"
```

---

## Task 4: PATCH `notify` contract

**Files:**
- Modify: `server/routes/proposals/crud.js:299-312` (body), `:328` (hoist), `:490-501` (gratuity trigger), `:625-640` (re-anchor, unchanged), `:710-760` (both sends), `:826` (response)
- Modify: `server/routes/proposals/notifyClient.test.js` (append)

**Interfaces:**
- Consumes: `validateNotifyList`, `gratuityNoticeApplies`, `NOTICE_*` from Task 1; `sendRescheduleEmail` from Task 2.
- Produces: `PATCH /api/proposals/:id` accepting `notify: [...]` and returning `notifications: [...]` alongside the proposal.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/proposals/notifyClient.test.js`:

```javascript
test('LOAD-BEARING: a date change with no notify list sends nothing but still re-anchors', async () => {
  const before = await pool.query(
    "SELECT id, scheduled_for FROM scheduled_messages WHERE proposal_id = $1 AND status = 'pending' ORDER BY id",
    [proposalId]
  );
  assert.ok(before.rows.length > 0, 'fixture needs at least one pending scheduled message');
  const oldBalanceDue = (await pool.query('SELECT balance_due_date FROM proposals WHERE id = $1', [proposalId])).rows[0].balance_due_date;

  const res = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken,
    body: { event_date: '2026-10-15' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notifications, []);

  const after = await pool.query(
    "SELECT id, scheduled_for FROM scheduled_messages WHERE proposal_id = $1 AND status = 'pending' ORDER BY id",
    [proposalId]
  );
  const moved = after.rows.some((r, i) => String(r.scheduled_for) !== String(before.rows[i].scheduled_for));
  assert.ok(moved, 're-anchoring must run even when nothing is sent');

  const newBalanceDue = (await pool.query('SELECT balance_due_date FROM proposals WHERE id = $1', [proposalId])).rows[0].balance_due_date;
  assert.notEqual(String(newBalanceDue), String(oldBalanceDue), 'balance_due_date must move with the event date');
});

test('event_details_changed with no supplied text is a 400 and saves nothing', async () => {
  const before = (await pool.query('SELECT event_location FROM proposals WHERE id = $1', [proposalId])).rows[0].event_location;
  const res = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken,
    body: { event_location: 'Rejected Venue', notify: [{ type: 'event_details_changed', channels: ['email'] }] },
  });
  assert.equal(res.status, 400);
  const after = (await pool.query('SELECT event_location FROM proposals WHERE id = $1', [proposalId])).rows[0].event_location;
  assert.equal(after, before, 'a rejected notify list must not commit the edit');
});

test('event_details_changed on a save that changed nothing reschedulable is a 400 and rolls back', async () => {
  const before = (await pool.query('SELECT guest_count FROM proposals WHERE id = $1', [proposalId])).rows[0].guest_count;
  const res = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken,
    body: {
      guest_count: Number(before) + 5,
      notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } }],
    },
  });
  assert.equal(res.status, 400);
  const after = (await pool.query('SELECT guest_count FROM proposals WHERE id = $1', [proposalId])).rows[0].guest_count;
  assert.equal(String(after), String(before), 'trigger mismatch must roll the transaction back');
});

test('gratuity_increase that did not fire saves normally and reports skipped', async () => {
  const res = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken,
    body: { guest_count: 77, notify: [{ type: 'gratuity_increase', channels: ['email'] }] },
  });
  assert.equal(res.status, 200);
  const entry = res.body.notifications.find(n => n.type === 'gratuity_increase');
  assert.ok(entry, 'the notice must be reported, not dropped');
  assert.equal(entry.email, 'skipped');
  assert.ok(entry.skip_reasons.email);
});

// Spec test 2: what the admin reviewed is what the client receives.
test('the reviewed text is what sends, not the template default', async () => {
  const marker = `REVIEWED-${Date.now()}`;
  const res = await request('PATCH', `/api/proposals/${proposalId}`, {
    token: adminToken,
    body: {
      event_location: 'Reviewed Text Venue',
      notify: [{
        type: 'event_details_changed', channels: ['email'],
        email: { subject: `Subject ${marker}`, body_text: `Body ${marker}` },
      }],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.notifications.find(n => n.type === 'event_details_changed').email, 'sent');
  const logged = await pool.query(
    'SELECT subject FROM message_log WHERE proposal_id = $1 ORDER BY id DESC LIMIT 1',
    [proposalId]
  );
  assert.match(logged.rows[0].subject, new RegExp(marker), 'the ledger must record the reviewed subject');
});

// Spec test 8: an explicit Send never overrides a suppression rule.
test('a suppressed recipient reports skipped even when the notice was requested', async () => {
  await pool.query("UPDATE clients SET email_status = 'bad' WHERE id = $1", [clientId]);
  try {
    const res = await request('PATCH', `/api/proposals/${proposalId}`, {
      token: adminToken,
      body: {
        event_location: 'Suppression Test Venue',
        notify: [{ type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } }],
      },
    });
    assert.equal(res.status, 200);
    const entry = res.body.notifications.find(n => n.type === 'event_details_changed');
    assert.equal(entry.email, 'skipped');
    assert.ok(entry.skip_reasons.email, 'the reason must be reported, not silent');
  } finally {
    await pool.query("UPDATE clients SET email_status = NULL WHERE id = $1", [clientId]);
  }
});

// Spec test 10: one save, both notices.
test('a save that triggers both notices sends both and reports each', async () => {
  const res = await request('PATCH', `/api/proposals/${bothNoticesProposalId}`, {
    token: adminToken,
    body: {
      event_location: 'Both Notices Venue',
      num_bartenders: 3,
      notify: [
        { type: 'event_details_changed', channels: ['email'], email: { subject: 's', body_text: 'b' } },
        { type: 'gratuity_increase', channels: ['email'] },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.ok(res.body.notifications.find(n => n.type === 'event_details_changed'));
  assert.ok(res.body.notifications.find(n => n.type === 'gratuity_increase'));
});
```

**Note for the implementer:** `bothNoticesProposalId` needs a fixture that is paid enough for `isPaidForGratuity` and whose bartender count genuinely raises the gratuity total. Read the `isPaidForGratuity` derivation in `crud.js` before seeding, and if the fixture cannot be made to fire both notices reliably, say so rather than loosening the assertion to `>= 1`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: FAIL. The load-bearing test fails because a bare PATCH still sends; the 400 tests fail with 200.

- [ ] **Step 3: Accept and validate the list before `BEGIN`**

Add `notify` to the body destructure at `crud.js:308-310`, next to the existing staff flags:

```javascript
    notify_assigned_staff, notify_staff_sms, notify_staff_email,
    notify,
    change_request_id
  } = req.body;

  // Structural validation BEFORE pool.connect()/BEGIN: a malformed notify list
  // must never open a transaction. Trigger validation (does this save actually
  // fire these notices?) happens below, where the notice set is computed.
  const requestedNotices = validateNotifyList(notify);
  const requestedByType = new Map(requestedNotices.map((n) => [n.type, n]));
```

Add the import at the top of the file, next to the `rescheduleProposal` import at `:15`:

```javascript
const {
  NOTICE_EVENT_DETAILS, NOTICE_GRATUITY,
  validateNotifyList, gratuityNoticeApplies,
} = require('../../utils/clientNotices');
```

- [ ] **Step 4: Replace the automatic gratuity flag with a requested-and-triggered check**

At `crud.js:498-501`, keep the `gratuityOrigin` stamp exactly as it is and change only the notify decision:

```javascript
    if (isPaidForGratuity && gratuityOrigin !== 'admin' && newGratuityTotal !== oldGratuityTotal) {
      gratuityOrigin = 'staffing';
      // The stamp above is bookkeeping and always runs. The notice is opt-in:
      // it fires only when the caller asked AND the rise actually happened.
      gratuityNoticeTriggered = gratuityNoticeApplies({
        oldGratuityTotal, newGratuityTotal, isPaidForGratuity, gratuityOrigin,
      });
    }
```

Rename the hoisted flag at `:330` from `let notifyStaffingGratuity = false;` to `let gratuityNoticeTriggered = false;`.

- [ ] **Step 5: Enforce the event-details trigger match inside the transaction**

`crud.js:632` stays **exactly as it is**. Do not touch the `rescheduleProposalInTx` call. Immediately after it, add the trigger check:

```javascript
      shouldSendRescheduleEmail = rescheduleResult.shouldSendEmail;
    } catch (rescheduleErr) {
      throw rescheduleErr;
    }

    // Trigger match for the composable notice. Supplied text was composed
    // against a specific set of changes; sending it against a different set
    // would tell the client something untrue. Throwing here rolls back.
    if (requestedByType.has(NOTICE_EVENT_DETAILS) && !shouldSendRescheduleEmail) {
      throw new ValidationError({
        notify: 'This save does not change the event date, time, or location, so that notice cannot be sent.',
      });
    }
```

- [ ] **Step 6: Gate both sends on the request and collect per-channel truth**

Replace the send block at `:710-725` with:

```javascript
    const notifications = [];

    // COMMIT already succeeded above. Both sends are best-effort and
    // post-commit: a provider failure must NEVER 500 a PATCH whose transaction
    // already committed. The response reports what actually happened per
    // channel instead of swallowing it.
    const eventNotice = requestedByType.get(NOTICE_EVENT_DETAILS);
    if (eventNotice && shouldSendRescheduleEmail && !change_request_id) {
      try {
        const r = await sendRescheduleEmail({
          proposalId: parseInt(req.params.id, 10),
          old,
          updated: updatedRow.rows[0],
          channels: eventNotice.channels,
          message: { email: eventNotice.email, sms: eventNotice.sms },
        });
        notifications.push({ type: NOTICE_EVENT_DETAILS, ...r });
      } catch (emailErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(emailErr, {
            tags: { route: 'proposals/update', issue: 'event-details-notice' },
            extra: { proposalId: req.params.id },
          });
        }
        console.error('Event-details notice failed (non-blocking, DB already committed):', emailErr);
        notifications.push({
          type: NOTICE_EVENT_DETAILS, email: 'failed', sms: 'failed',
          email_error: emailErr.message, skip_reasons: {},
        });
      }
    }
```

Replace the gratuity send at `:731` with the same shape. The requested-but-untriggered case is a skip, not an error:

```javascript
    const gratuityNotice = requestedByType.get(NOTICE_GRATUITY);
    if (gratuityNotice && !gratuityNoticeTriggered) {
      notifications.push({
        type: NOTICE_GRATUITY, email: 'skipped', sms: null,
        skip_reasons: { email: 'The gratuity total did not increase on this save.' },
      });
    } else if (gratuityNotice && gratuityNoticeTriggered) {
      try {
        const full = await pool.query(
          `SELECT p.total_price, p.pricing_snapshot, c.email AS client_email, c.name AS client_name
             FROM proposals p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`,
          [req.params.id]
        );
        const row = full.rows[0];
        if (row && row.client_email) {
          await sendEmail({
            to: row.client_email,
            ...emailTemplates.gratuityStaffingChange({
              name: row.client_name,
              newTotal: Number(row.total_price),
              gratuity: (row.pricing_snapshot && row.pricing_snapshot.gratuity) || null,
            }),
          });
          notifications.push({ type: NOTICE_GRATUITY, email: 'sent', sms: null, skip_reasons: {} });
        } else {
          notifications.push({
            type: NOTICE_GRATUITY, email: 'skipped', sms: null,
            skip_reasons: { email: 'No email on file for this client.' },
          });
        }
      } catch (mailErr) {
        if (process.env.SENTRY_DSN_SERVER) {
          Sentry.captureException(mailErr, { tags: { route: 'proposals/update', issue: 'gratuity-staffing-email' } });
        }
        console.error('Gratuity staffing-change email failed (non-blocking):', mailErr);
        notifications.push({
          type: NOTICE_GRATUITY, email: 'failed', sms: null,
          email_error: mailErr.message || 'Email send failed.', skip_reasons: {},
        });
      }
    }
```

This is the existing block from `crud.js:731-754` with the `if (notifyStaffingGratuity)` wrapper replaced and result recording added. The query, the template call, and the Sentry tag are unchanged.

- [ ] **Step 7: Return the notifications**

Change the response at `:826` from:

```javascript
    res.json(updatedRow.rows[0]);
```

to:

```javascript
    res.json({ ...updatedRow.rows[0], notifications });
```

**Note for the implementer:** this widens the PATCH response. Check both client callers (`EventEditForm.js:83`, `ProposalDetailEditForm.js:246`) still read the proposal fields off the top level. They do, because the spread keeps every existing key. Do not nest the proposal under a new key.

- [ ] **Step 8: Fix the tests this breaks**

Run: `node -r dotenv/config --test server/routes/proposals/crud.test.js`

Any assertion that a bare PATCH sends the reschedule email now fails by design. Update those cases to pass a `notify` list. Do not weaken an assertion to make it pass; if a failure is not explained by the new contract, stop and report it.

- [ ] **Step 9: Run everything and make sure it passes**

```bash
node -r dotenv/config --test server/routes/proposals/notifyClient.test.js
node -r dotenv/config --test server/routes/proposals/crud.test.js
node -r dotenv/config --test server/routes/proposals/crud.demotion.test.js
```
Expected: PASS on all three.

- [ ] **Step 10: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/notifyClient.test.js server/routes/proposals/crud.test.js
git commit -m "feat(notify): PATCH /proposals/:id sends only what the caller names"
```

---

## Task 5: Record payment `notify_client`

**Files:**
- Modify: `server/routes/proposals/actions.js:134` (body), `:307-330` (the notification block)
- Modify: `server/routes/proposals/notifyClient.test.js` (append)

**Interfaces:**
- Produces: `POST /api/proposals/:id/record-payment` accepting `notify_client: true|false` and returning `notifications: [...]`.

- [ ] **Step 1: Write the failing test**

```javascript
test('record-payment with notify_client false sends no receipt but still alerts the admin', async () => {
  const calls = [];
  // Capture rather than mock the module: assert on the response contract and on
  // the message_log, which is the durable record of what actually went out.
  const res = await request('POST', `/api/proposals/${payProposalId}/record-payment`, {
    token: adminToken,
    body: { amount: 100, paid_in_full: false, method: 'cash', notify_client: false },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.notifications, []);
  const logged = await pool.query(
    "SELECT COUNT(*)::int AS c FROM message_log WHERE proposal_id = $1 AND message_type LIKE 'payment%'",
    [payProposalId]
  );
  assert.equal(logged.rows[0].c, 0, 'no client receipt may be logged');
  assert.equal(calls.length, 0);
});

test('record-payment with notify_client true sends the receipt', async () => {
  const res = await request('POST', `/api/proposals/${payProposalId2}/record-payment`, {
    token: adminToken,
    body: { amount: 100, paid_in_full: false, method: 'cash', notify_client: true },
  });
  assert.equal(res.status, 200);
  const entry = res.body.notifications.find(n => n.type === 'payment_receipt');
  assert.ok(entry);
  assert.ok(['sent', 'skipped'].includes(entry.email));
});
```

**Note for the implementer:** seed `payProposalId` and `payProposalId2` as separate `deposit_paid`-eligible proposals in `before`, because record-payment mutates status and a shared fixture would make the second test order-dependent. Confirm the message-type prefix by reading what `emailTemplates.paymentReceivedClient` logs through `sendEmail`; adjust the `LIKE` if it differs.

- [ ] **Step 2: Run it to make sure it fails**

Run: `node -r dotenv/config --test server/routes/proposals/notifyClient.test.js`
Expected: FAIL, a receipt is logged even with `notify_client: false`.

- [ ] **Step 3: Gate the client half only**

At `actions.js:134` add `notify_client` to the destructure:

```javascript
  const { amount, paid_in_full, method, notify_client } = req.body;
```

At `:307-330`, split the block so the admin notice is never gated:

```javascript
  // Email notifications for payment (non-blocking)
  const notifications = [];
  try {
    const payData = await pool.query(/* unchanged */);
    const pd = payData.rows[0];
    const amountFormatted = appliedAmount.toFixed(2);
    const payType = isFullyPaid ? 'full payment' : 'deposit';
    const eventTypeLabel = getEventTypeLabel({ event_type: pd?.event_type, event_type_custom: pd?.event_type_custom });

    // Client receipt: opt-in. Recording a payment is a bookkeeping act; the
    // client-facing receipt is a separate decision the admin makes at the
    // moment of recording (spec: no later-send path).
    if (notify_client === true) {
      if (pd?.client_email) {
        try {
          const tpl = emailTemplates.paymentReceivedClient({ clientName: pd.client_name, eventTypeLabel, amount: amountFormatted, paymentType: payType });
          await sendEmail({ to: pd.client_email, ...tpl });
          notifications.push({ type: 'payment_receipt', email: 'sent', sms: null, skip_reasons: {} });
        } catch (rcptErr) {
          notifications.push({ type: 'payment_receipt', email: 'failed', sms: null, email_error: rcptErr.message, skip_reasons: {} });
        }
      } else {
        notifications.push({
          type: 'payment_receipt', email: 'skipped', sms: null,
          skip_reasons: { email: 'No email on file for this client.' },
        });
      }
    }

    // Admin notice: NEVER gated. This is internal routine_finance reporting,
    // not a client touch.
    const tpl2 = emailTemplates.paymentReceivedAdmin({ /* unchanged */ });
    await notifyAdminCategory({ category: 'routine_finance', subject: tpl2.subject, emailHtml: tpl2.html, emailText: tpl2.text });
  } catch (emailErr) {
    /* unchanged */
  }
```

- [ ] **Step 4: Return the notifications**

Find the `res.json(...)` at the end of the handler and spread `notifications` into it the same way Task 4 did, keeping every existing key at the top level.

- [ ] **Step 5: Run the tests and make sure they pass**

```bash
node -r dotenv/config --test server/routes/proposals/notifyClient.test.js
node -r dotenv/config --test server/routes/proposals/recordPayment.statusGuard.test.js
node -r dotenv/config --test server/routes/proposals/recordPayment.invoiceCap.test.js
node -r dotenv/config --test server/routes/proposals/recordPayment.staleRead.test.js
```
Expected: PASS on all four.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/actions.js server/routes/proposals/notifyClient.test.js
git commit -m "feat(notify): record-payment receipt is opt-in; admin alert never gated"
```

---

## Task 6: Docs

**Files:**
- Modify: `ARCHITECTURE.md` (API route table)

- [ ] **Step 1: Add the new route**

Add `POST /api/proposals/:id/notify-preflight` to the proposals section of the route table, described as "read-only; which client notices a pending edit would trigger, plus the drafted event-details message".

- [ ] **Step 2: Note the contract change**

In the same section, note that `PATCH /api/proposals/:id` and `POST /api/proposals/:id/record-payment` send client notifications only when the request names them (`notify` list / `notify_client`), and that both return a `notifications` array of per-channel results.

- [ ] **Step 3: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs: notify-preflight route + opt-in client notification contract"
```

---

# Lane: notify-client

## Task 7: The confirmation modal

**Files:**
- Create: `client/src/components/comms/NotifyConfirmModal.jsx`

**Interfaces:**
- Produces:

```javascript
<NotifyConfirmModal
  notices={notices}          // preflight's array; [] never renders
  primary="quiet"            // 'quiet' on edits, 'send' on payments
  sendLabel="Send the update"
  quietLabel="Don't send"
  onCancel={() => {}}
  onQuiet={() => {}}         // caller saves with an empty notify list
  onSend={(notify) => {}}    // notify: the array to put on the request
/>
```

- [ ] **Step 1: Write the component**

Create `client/src/components/comms/NotifyConfirmModal.jsx`. Follow the portal + overlay pattern in `client/src/components/ShoppingList/ShoppingListModal.jsx:462-470`.

```jsx
import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';

// Confirmation shown when a save would message the client. One block per
// notice; composable notices are editable, fixed-template ones are described.
//
// Escape and backdrop are CANCEL, never quiet-save. Dismissing must not
// silently commit an edit the admin was still deciding about.
export default function NotifyConfirmModal({
  notices, primary = 'quiet',
  sendLabel = 'Send the update', quietLabel = "Don't send",
  onCancel, onQuiet, onSend,
}) {
  const [drafts, setDrafts] = useState(() => notices.map((n) => ({
    type: n.type,
    channels: Object.entries(n.channels || {})
      .filter(([, c]) => c.available && c.default)
      .map(([k]) => k),
    subject: n.draft?.email?.subject || '',
    bodyText: n.draft?.email?.body_text || '',
    smsBody: n.draft?.sms?.body || '',
  })));

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  if (!notices || notices.length === 0) return null;

  const update = (i, patch) => setDrafts((d) => d.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const toggleChannel = (i, ch) => update(i, {
    channels: drafts[i].channels.includes(ch)
      ? drafts[i].channels.filter((c) => c !== ch)
      : [...drafts[i].channels, ch],
  });

  const anyChannel = drafts.some((d) => d.channels.length > 0);

  const buildNotify = () => drafts
    .filter((d) => d.channels.length > 0)
    .map((d) => {
      const notice = notices.find((n) => n.type === d.type);
      if (!notice.composable) return { type: d.type, channels: d.channels };
      const out = { type: d.type, channels: d.channels };
      if (d.channels.includes('email')) out.email = { subject: d.subject, body_text: d.bodyText };
      if (d.channels.includes('sms')) out.sms = { body: d.smsBody };
      return out;
    });

  return createPortal(
    <div
      style={{ position: 'fixed', inset: 0, zIndex: 1000, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', overflowY: 'auto', paddingTop: 'calc(60px + 1.5rem)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div style={{ backgroundColor: 'var(--bg-elev)', width: '100%', maxWidth: 640, borderRadius: 8, padding: '1.25rem', margin: '0 auto 1.5rem' }}>
        <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: '0.75rem' }}>
          Notify the client?
        </h3>

        {notices.map((n, i) => (
          <div key={n.type} style={{ borderTop: i > 0 ? '1px solid var(--line-2)' : 'none', paddingTop: i > 0 ? '1rem' : 0, marginBottom: '1rem' }}>
            <div className="text-small text-muted" style={{ marginBottom: '0.5rem' }}>
              {n.reasons.join(', ')}. Goes to {n.recipient.name || 'the client'}
              {n.recipient.email ? ` (${n.recipient.email})` : ''}.
            </div>

            <div style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem' }}>
              {['email', 'sms'].map((ch) => n.channels[ch]?.available && (
                <label key={ch} className="text-small" style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                  <input type="checkbox" checked={drafts[i].channels.includes(ch)} onChange={() => toggleChannel(i, ch)} />
                  {ch === 'email' ? 'Email' : 'Text'}
                </label>
              ))}
            </div>

            {n.composable ? (
              <>
                {drafts[i].channels.includes('email') && (
                  <>
                    <input className="form-input mb-1" value={drafts[i].subject}
                      onChange={(e) => update(i, { subject: e.target.value })} placeholder="Subject" />
                    <textarea className="form-input mb-1" rows={6} value={drafts[i].bodyText}
                      onChange={(e) => update(i, { bodyText: e.target.value })} />
                  </>
                )}
                {drafts[i].channels.includes('sms') && (
                  <>
                    <textarea className="form-input" rows={3} value={drafts[i].smsBody}
                      onChange={(e) => update(i, { smsBody: e.target.value })} />
                    <div className="text-small text-muted">{drafts[i].smsBody.length} / 640</div>
                  </>
                )}
              </>
            ) : (
              <div className="text-small">
                The client will be emailed that their gratuity total went up. This message is not editable.
              </div>
            )}
          </div>
        ))}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1rem' }}>
          <button className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          <button
            className={primary === 'quiet' ? 'btn btn-success' : 'btn btn-secondary'}
            onClick={onQuiet}
          >{quietLabel}</button>
          <button
            className={primary === 'send' ? 'btn btn-success' : 'btn'}
            disabled={!anyChannel}
            onClick={() => onSend(buildNotify())}
          >{sendLabel}</button>
        </div>
      </div>
    </div>,
    document.body
  );
}
```

- [ ] **Step 2: Verify it compiles under the CI lint gate**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds with no warnings-as-errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/comms/NotifyConfirmModal.jsx
git commit -m "feat(notify): shared client-notification confirmation modal"
```

---

## Task 8: Wire both edit forms

**Files:**
- Modify: `client/src/pages/admin/EventEditForm.js:70-110`
- Modify: `client/src/pages/admin/ProposalDetailEditForm.js:235-275`

- [ ] **Step 1: Extract the PATCH body, then preflight before saving**

Both forms build their PATCH body inline. In each, hoist it into a variable, then run preflight first. `EventEditForm.js`:

```javascript
  const [pendingNotices, setPendingNotices] = useState([]);
  const [pendingBody, setPendingBody] = useState(null);

  const buildPatchBody = () => ({
    event_date: form.event_date,
    /* ... every existing key, unchanged ... */
    notify_assigned_staff: notifyStaff,
    /* ... */
  });

  const doSave = async (patchBody, notify) => {
    if (proposal.client_id) {
      await api.put(`/clients/${proposal.client_id}`, {
        name: form.client_name, email: form.client_email,
        phone: form.client_phone, source: form.client_source,
      });
    }
    const res = await api.patch(`/proposals/${proposal.id}`, { ...patchBody, notify });
    (res.data.notifications || []).forEach((n) => {
      if (n.email === 'failed') toast.error(`Saved, but the email failed: ${n.email_error || 'unknown error'}`);
      else if (n.sms === 'failed') toast.error(`Saved, but the text failed: ${n.sms_error || 'unknown error'}`);
      else if (n.email === 'skipped' && n.skip_reasons?.email) toast.info(`Saved. Email not sent: ${n.skip_reasons.email}`);
    });
    return res;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setFieldErrors({}); setSaving(true);
    try {
      const patchBody = buildPatchBody();
      const pre = await api.post(`/proposals/${proposal.id}/notify-preflight`, patchBody);
      const notices = pre.data.notices || [];
      if (notices.length > 0) {
        setPendingBody(patchBody);
        setPendingNotices(notices);
        setSaving(false);
        return;                       // the modal drives the rest
      }
      const res = await doSave(patchBody, []);
      onSaved?.(res.data);
    } catch (err) {
      /* existing error handling, unchanged */
    } finally {
      setSaving(false);
    }
  };
```

- [ ] **Step 2: Render the modal**

At the end of each form's JSX:

```jsx
      {pendingNotices.length > 0 && (
        <NotifyConfirmModal
          notices={pendingNotices}
          primary="quiet"
          onCancel={() => { setPendingNotices([]); setPendingBody(null); }}
          onQuiet={async () => {
            setSaving(true);
            try {
              const res = await doSave(pendingBody, []);
              setPendingNotices([]); setPendingBody(null);
              onSaved?.(res.data);
            } catch (err) { setError(err.message || 'Save failed.'); }
            finally { setSaving(false); }
          }}
          onSend={async (notify) => {
            setSaving(true);
            try {
              const res = await doSave(pendingBody, notify);
              setPendingNotices([]); setPendingBody(null);
              onSaved?.(res.data);
            } catch (err) { setError(err.message || 'Save failed.'); }
            finally { setSaving(false); }
          }}
        />
      )}
```

Import it at the top: `import NotifyConfirmModal from '../../components/comms/NotifyConfirmModal';`

**Note for the implementer:** `ProposalDetailEditForm.js` uses `editForm` where `EventEditForm.js` uses `form`, and its own `onSaved`/state names. Read each file and match its existing names. Do not rename anything.

- [ ] **Step 3: Verify the build**

Run: `cd client && CI=true npx react-scripts build`
Expected: succeeds.

- [ ] **Step 4: Manual check**

Start the dev server. On a `deposit_paid` proposal, change only the guest count and save: no popup. Change the venue and save: popup appears with the drafted message. Press Escape: nothing saved, the venue is unchanged. Reopen, change the venue, click Don't send: saved, no message. Confirm in the DB that `scheduled_messages.scheduled_for` still moved if you also changed the date.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/EventEditForm.js client/src/pages/admin/ProposalDetailEditForm.js
git commit -m "feat(notify): confirm before an edit messages the client"
```

---

## Task 9: Wire record payment

**Files:**
- Modify: `client/src/pages/admin/ProposalDetailPaymentPanel.js:194-217`
- Modify: `README.md` (Key Features)

- [ ] **Step 1: Ask before posting**

Replace `recordPayment` with a two-step flow. There is no preflight call here: the receipt fires whenever the client has an email, which the panel already knows from `proposal`.

```javascript
  const [receiptPrompt, setReceiptPrompt] = useState(false);

  const recordPayment = () => {
    if (!paymentPaidInFull && (!paymentAmount || Number(paymentAmount) <= 0)) {
      toast.error('Please enter a valid amount.');
      return;
    }
    if (!proposal.client_email) { doRecordPayment(false); return; }
    setReceiptPrompt(true);
  };

  const doRecordPayment = async (notifyClient) => {
    setReceiptPrompt(false);
    setRecordingPayment(true);
    try {
      const res = await api.post(`/proposals/${proposal.id}/record-payment`, {
        amount: paymentPaidInFull ? undefined : Number(paymentAmount),
        paid_in_full: paymentPaidInFull,
        method: paymentMethod,
        notify_client: notifyClient,
      });
      const amountStr = fmt$2dp(paymentPaidInFull ? balanceDue : Number(paymentAmount));
      toast.success(`Payment of ${amountStr} recorded.`);
      (res.data.notifications || []).forEach((n) => {
        if (n.email === 'failed') toast.error(`Recorded, but the receipt failed to send: ${n.email_error || 'unknown error'}`);
        else if (n.email === 'skipped' && n.skip_reasons?.email) toast.info(`Recorded. Receipt not sent: ${n.skip_reasons.email}`);
      });
      setShowRecordPayment(false);
      setPaymentAmount('');
      setPaymentPaidInFull(false);
      onUpdate?.();
    } catch (err) {
      toast.error(err.message || 'Failed to record payment.');
    } finally {
      setRecordingPayment(false);
    }
  };
```

- [ ] **Step 2: Render the prompt with Send as primary**

```jsx
      {receiptPrompt && (
        <NotifyConfirmModal
          notices={[{
            type: 'payment_receipt',
            reasons: [`Receipt for ${fmt$2dp(paymentPaidInFull ? balanceDue : Number(paymentAmount))}`],
            composable: false,
            recipient: { name: proposal.client_name, email: proposal.client_email, phone: null },
            channels: { email: { available: true, default: true }, sms: { available: false } },
            draft: null,
          }]}
          primary="send"
          sendLabel="Send receipt"
          quietLabel="Don't send"
          onCancel={() => setReceiptPrompt(false)}
          onQuiet={() => doRecordPayment(false)}
          onSend={() => doRecordPayment(true)}
        />
      )}
```

**Note for the implementer:** the modal's fixed-template branch hardcodes gratuity copy. Change that branch to render `notices[i].reasons` plus a generic "This message is not editable." line so it serves both notice types honestly, and update Task 7's component accordingly.

- [ ] **Step 3: Update README**

Add to Key Features: admin edits and recorded payments no longer message the client on their own; a confirmation names what would go out and defaults to quiet on edits, to sending on receipts.

- [ ] **Step 4: Verify the build**

Run: `cd client && CI=true npx react-scripts build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/admin/ProposalDetailPaymentPanel.js client/src/components/comms/NotifyConfirmModal.jsx README.md
git commit -m "feat(notify): confirm before a recorded payment emails a receipt"
```

---

## Post-merge verification

Before either lane merges, confirm by hand against the dev DB, because the load-bearing property is a negative and negatives are easy to fake in a test:

1. Move an event date on a booked proposal with Don't send. Then query
   `SELECT message_type, scheduled_for FROM scheduled_messages WHERE proposal_id = $1 AND status = 'pending'`
   and confirm every row re-anchored to the new date, and that `balance_due_date` moved with it.
2. Confirm `message_log` has no new client row for that save.
3. Repeat with Send and confirm exactly one row per selected channel, carrying the edited text.
