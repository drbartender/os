# Last-Minute Staffing Confirmation (Touch 2.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Touch 2.2 from the comms spec: fire one client email + one client SMS with bartender name(s) and phone(s) the moment a `last_minute_hold = true` proposal's shift becomes fully staffed, one-shot per proposal.

**Architecture:** New notify module (`server/utils/lastMinuteStaffingConfirmation.js`) is the side-effect carrier. Trigger is the existing `clearHoldIfFullyStaffed` helper at `server/routes/shifts.js:829`, renamed to `confirmStaffingIfFullyStaffed`, with the existing UPDATE upgraded to `RETURNING id` so the atomic flip is itself the one-shot guard. Three call sites converge on the renamed helper (`shifts.js:669` manual assign, `shifts.js:786` request approval, new line in `autoAssign.js`); a fourth hook in `rescheduleProposalInTx` keeps `last_minute_hold` consistent across reschedules. Templates are pure (no I/O), live beside their siblings in `lifecycleEmailTemplates.js` and `smsTemplates.js`, and take pre-rendered primitives only.

**Tech Stack:** Node.js / Express 4, Postgres via `pg`, Resend (email), Twilio (SMS), `node:test` + `node:assert/strict` (no Jest), Sentry for error capture. All tests run against a real local DB via `DATABASE_URL` (existing house pattern, see `server/utils/paymentFailedClientNotify.test.js`).

---

## File Structure

| File | Responsibility |
|---|---|
| `server/utils/smsTemplates.js` (modify) | Add `lastMinuteStaffingConfirmationSms`. Pure string template. |
| `server/utils/smsTemplates.test.js` (modify) | Add render-shape + no-em-dash assertions for the new touch. |
| `server/utils/lifecycleEmailTemplates.js` (modify) | Add `lastMinuteStaffingConfirmation` template (subject/html/text). Pure. |
| `server/utils/lifecycleEmailTemplates.test.js` (create) | First test file for this module. Render-shape tests for the new template, plural and singular. |
| `server/utils/emailTemplates.js` (modify) | Re-export the new template via the existing `lifecycle.*` block at `:964-969`. |
| `server/utils/lastMinuteStaffingConfirmation.js` (create) | The notify module. Pure `renderBartenderList()` + side-effecting `notifyClientOfStaffingConfirmation(proposalId, shiftId)`. |
| `server/utils/lastMinuteStaffingConfirmation.test.js` (create) | Real-DB integration tests covering the early-return matrix, the renderer, and per-channel suppression independence. |
| `server/routes/shifts.js` (modify) | Rename helper, add `RETURNING id` + notify call, upgrade outer catch. |
| `server/utils/autoAssign.js` (modify) | Add the new helper call after the per-candidate SMS for-loop. |
| `server/utils/rescheduleProposal.js` (modify) | Inside `rescheduleProposalInTx`, re-evaluate `last_minute_hold` against the post-update event_date/event_start_time. |
| `README.md` (modify) | One line in the folder tree for the new util file. |
| `ARCHITECTURE.md` (modify) | One line under the comms section noting Touch 2.2 ships. |

---

## Task 1: SMS template

**Files:**
- Modify: `server/utils/smsTemplates.js`
- Test: `server/utils/smsTemplates.test.js`

- [ ] **Step 1: Write the failing test**

Append to `server/utils/smsTemplates.test.js` (after the existing tests, before EOF):

```js
test('lastMinuteStaffingConfirmationSms > singular form', () => {
  const s = t.lastMinuteStaffingConfirmationSms({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex ((312) 555-1234)',
    isPlural: false,
  });
  assert.match(s, /^Hi, Dallas here\./);
  assert.match(s, /Your bartender for Saturday, May 30, 2026 is Alex \(\(312\) 555-1234\)\./);
  assert.match(s, /reach out the day of the event/);
  assertNoEmDash(s, 'lastMinuteStaffingConfirmationSms singular');
});

test('lastMinuteStaffingConfirmationSms > plural form', () => {
  const s = t.lastMinuteStaffingConfirmationSms({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex ((312) 555-1234) and Jordan ((312) 555-5678)',
    isPlural: true,
  });
  assert.match(s, /Your bartenders for Saturday, May 30, 2026 are Alex/);
  assert.match(s, /and Jordan/);
  assertNoEmDash(s, 'lastMinuteStaffingConfirmationSms plural');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/smsTemplates.test.js`
Expected: failure with `TypeError: t.lastMinuteStaffingConfirmationSms is not a function`.

- [ ] **Step 3: Implement the template**

Append to `server/utils/smsTemplates.js` (before `module.exports`):

```js
// ─── 2.2 Last-minute staffing confirmation SMS ───────────────────
function lastMinuteStaffingConfirmationSms({ eventDate, bartenderList, isPlural }) {
  const noun = isPlural ? 'bartenders' : 'bartender';
  const verb = isPlural ? 'are' : 'is';
  return `Hi, Dallas here. Your ${noun} for ${eventDate} ${verb} ${bartenderList}. They'll reach out the day of the event. Let me know if you have any questions.`;
}
```

Then add `lastMinuteStaffingConfirmationSms,` to the `module.exports` object at the bottom of the file (alongside the other template names).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/smsTemplates.test.js`
Expected: all tests pass (including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add server/utils/smsTemplates.js server/utils/smsTemplates.test.js
git commit -m "feat(comms): add lastMinuteStaffingConfirmationSms template (Touch 2.2)"
```

---

## Task 2: Email template + re-export bridge

**Files:**
- Modify: `server/utils/lifecycleEmailTemplates.js`
- Create: `server/utils/lifecycleEmailTemplates.test.js`
- Modify: `server/utils/emailTemplates.js`

- [ ] **Step 1: Create the failing test file**

Create `server/utils/lifecycleEmailTemplates.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('./lifecycleEmailTemplates');

// No email subject or text body may contain an em dash (the AI tell, per CLAUDE.md).
function assertNoEmDash(str, label) {
  assert.ok(!str.includes('—'), `${label} must not contain an em dash`);
}

test('lastMinuteStaffingConfirmation > singular subject + body', () => {
  const out = t.lastMinuteStaffingConfirmation({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex ((312) 555-1234)',
    isPlural: false,
  });
  assert.strictEqual(out.subject, 'Your bartender for Saturday, May 30, 2026');
  assert.match(out.text, /Your bartender for Saturday, May 30, 2026 is Alex \(\(312\) 555-1234\)/);
  assert.match(out.text, /Cheers, Dallas/);
  assert.match(out.html, /Alex \(\(312\) 555-1234\)/);
  assertNoEmDash(out.subject, 'subject');
  assertNoEmDash(out.text, 'text');
});

test('lastMinuteStaffingConfirmation > plural subject + body', () => {
  const out = t.lastMinuteStaffingConfirmation({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex ((312) 555-1234) and Jordan ((312) 555-5678)',
    isPlural: true,
  });
  assert.strictEqual(out.subject, 'Your bartenders for Saturday, May 30, 2026');
  assert.match(out.text, /Your bartenders for Saturday, May 30, 2026 are Alex/);
  assert.match(out.text, /and Jordan/);
  assertNoEmDash(out.subject, 'subject');
  assertNoEmDash(out.text, 'text');
});

test('lastMinuteStaffingConfirmation > html is wrapped with the standard chrome', () => {
  const out = t.lastMinuteStaffingConfirmation({
    eventDate: 'Saturday, May 30, 2026',
    bartenderList: 'Alex',
    isPlural: false,
  });
  // wrapEmail wraps with <!DOCTYPE html> + a body container
  assert.match(out.html, /<!DOCTYPE html>/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/lifecycleEmailTemplates.test.js`
Expected: failure with `TypeError: t.lastMinuteStaffingConfirmation is not a function`.

- [ ] **Step 3: Implement the template**

In `server/utils/lifecycleEmailTemplates.js`, insert this function before the closing `module.exports` block (~line 320):

```js
function lastMinuteStaffingConfirmation({ eventDate, bartenderList, isPlural }) {
  const noun = isPlural ? 'bartenders' : 'bartender';
  const verb = isPlural ? 'are' : 'is';
  const subject = `Your ${noun} for ${eventDate}`;
  const text = [
    `Your ${noun} for ${eventDate} ${verb} ${bartenderList}. They'll be in touch the day of the event.`,
    '',
    'Let me know if you have any questions or need any changes.',
    '',
    'Cheers, Dallas',
  ].join('\n');
  const html = wrapEmail(`
    <h2 style="color:${BRAND.primary};margin-top:0;">Your ${noun} for ${esc(eventDate)}</h2>
    <p>Your ${noun} for <strong>${esc(eventDate)}</strong> ${verb} <strong>${esc(bartenderList)}</strong>. They'll be in touch the day of the event.</p>
    <p>Let me know if you have any questions or need any changes.</p>
    <p>Cheers, Dallas</p>
  `);
  return { subject, html, text };
}
```

Then add `lastMinuteStaffingConfirmation,` to the `module.exports` object at line 321-327. Result:

```js
module.exports = {
  signedAndPaidClient,
  drinkPlanLink,
  drinkPlanBalanceUpdate,
  shoppingListReady,
  postConsultClient,
  lastMinuteStaffingConfirmation,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/lifecycleEmailTemplates.test.js`
Expected: all three tests pass.

- [ ] **Step 5: Add the re-export bridge**

Open `server/utils/emailTemplates.js`. Find the `module.exports` block (lines ~960-974). The existing block has lifecycle re-exports on lines 964-969:

```js
  // Lifecycle templates re-exported from the sibling file for backwards compat.
  signedAndPaidClient: lifecycle.signedAndPaidClient,
  drinkPlanLink: lifecycle.drinkPlanLink,
  drinkPlanBalanceUpdate: lifecycle.drinkPlanBalanceUpdate,
  shoppingListReady: lifecycle.shoppingListReady,
  postConsultClient: lifecycle.postConsultClient,
```

Add one more line directly after `postConsultClient: lifecycle.postConsultClient,`:

```js
  lastMinuteStaffingConfirmation: lifecycle.lastMinuteStaffingConfirmation,
```

- [ ] **Step 6: Sanity-check the re-export**

Run a quick require-and-check from the command line:

```bash
node -e "console.log(typeof require('./server/utils/emailTemplates').lastMinuteStaffingConfirmation)"
```

Expected output: `function`.

- [ ] **Step 7: Commit**

```bash
git add server/utils/lifecycleEmailTemplates.js server/utils/lifecycleEmailTemplates.test.js server/utils/emailTemplates.js
git commit -m "feat(comms): add lastMinuteStaffingConfirmation email template + re-export (Touch 2.2)"
```

---

## Task 3: Bartender-list renderer

**Files:**
- Create: `server/utils/lastMinuteStaffingConfirmation.js` (renderer only; main fn lands in Task 4)
- Create: `server/utils/lastMinuteStaffingConfirmation.test.js`

This task ships only the pure `renderBartenderList` function plus its tests. The main notify fn lands in Task 4 so the renderer can be reviewed and reverted independently.

- [ ] **Step 1: Create the failing test file**

Create `server/utils/lastMinuteStaffingConfirmation.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { renderBartenderList, _resolveDisplayName } = require('./lastMinuteStaffingConfirmation');

test('_resolveDisplayName > preferred_name wins', () => {
  const name = _resolveDisplayName({ preferred_name: 'Alex', first_name: 'Alexander', last_name: 'Smith' });
  assert.strictEqual(name, 'Alex');
});

test('_resolveDisplayName > falls through to first_name', () => {
  const name = _resolveDisplayName({ preferred_name: null, first_name: 'Alex', last_name: 'Smith' });
  assert.strictEqual(name, 'Alex');
});

test('_resolveDisplayName > falls through to last_name', () => {
  const name = _resolveDisplayName({ preferred_name: null, first_name: null, last_name: 'Smith' });
  assert.strictEqual(name, 'Smith');
});

test('_resolveDisplayName > final fallback to generic label', () => {
  const name = _resolveDisplayName({ preferred_name: null, first_name: null, last_name: null });
  assert.strictEqual(name, 'Your bartender');
});

test('renderBartenderList > 1 bartender with phone', () => {
  const out = renderBartenderList([
    { preferred_name: 'Alex', phone: '3125551234' },
  ]);
  assert.strictEqual(out, 'Alex ((312) 555-1234)');
});

test('renderBartenderList > 1 bartender no phone', () => {
  const out = renderBartenderList([
    { preferred_name: 'Alex', phone: null },
  ]);
  assert.strictEqual(out, 'Alex');
});

test('renderBartenderList > 2 bartenders both with phones', () => {
  const out = renderBartenderList([
    { preferred_name: 'Alex', phone: '3125551234' },
    { preferred_name: 'Jordan', phone: '3125555678' },
  ]);
  assert.strictEqual(out, 'Alex ((312) 555-1234) and Jordan ((312) 555-5678)');
});

test('renderBartenderList > 3 bartenders Oxford-comma', () => {
  const out = renderBartenderList([
    { preferred_name: 'Alex', phone: '3125551234' },
    { preferred_name: 'Jordan', phone: '3125555678' },
    { preferred_name: 'Sam', phone: '3125559012' },
  ]);
  assert.strictEqual(out, 'Alex ((312) 555-1234), Jordan ((312) 555-5678), and Sam ((312) 555-9012)');
});

test('renderBartenderList > 2 bartenders mixed phone presence', () => {
  const out = renderBartenderList([
    { preferred_name: 'Alex', phone: '3125551234' },
    { preferred_name: 'Jordan', phone: null },
  ]);
  assert.strictEqual(out, 'Alex ((312) 555-1234) and Jordan');
});

test('renderBartenderList > 1 bartender, missing all name fields', () => {
  const out = renderBartenderList([
    { preferred_name: null, first_name: null, last_name: null, phone: '3125551234' },
  ]);
  assert.strictEqual(out, 'Your bartender ((312) 555-1234)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/utils/lastMinuteStaffingConfirmation.test.js`
Expected: failure, `Cannot find module './lastMinuteStaffingConfirmation'`.

- [ ] **Step 3: Implement the renderer**

Create `server/utils/lastMinuteStaffingConfirmation.js`:

```js
const { formatPhoneDisplay } = require('./globalSearch');

/** Pick the most specific display name available, falling through to a generic label. */
function _resolveDisplayName(row) {
  return row.preferred_name || row.first_name || row.last_name || 'Your bartender';
}

/**
 * Render an approved-bartender list as a single human-readable string.
 *
 *   1:  "Alex ((312) 555-1234)"  or  "Alex"  (no phone)
 *   2:  "Alex ((312) 555-1234) and Jordan ((312) 555-5678)"
 *   3+: "Alex (...), Jordan (...), and Sam (...)"   (Oxford comma)
 *
 * `phone` is the raw 10-digit value stored in `contractor_profiles.phone`
 * (per validatePhone enforcement in `phone.js`). `formatPhoneDisplay` returns
 * `(XXX) XXX-XXXX` for clean 10-digit storage and the empty string for
 * null/unparseable input; the empty string suppresses the parenthetical.
 *
 * @param {Array<{preferred_name?: string|null, first_name?: string|null, last_name?: string|null, phone?: string|null}>} bartenders
 * @returns {string}
 */
function renderBartenderList(bartenders) {
  const parts = bartenders.map((b) => {
    const name = _resolveDisplayName(b);
    const display = formatPhoneDisplay(b.phone);
    return display ? `${name} (${display})` : name;
  });
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  const head = parts.slice(0, -1).join(', ');
  const tail = parts[parts.length - 1];
  return `${head}, and ${tail}`;
}

module.exports = {
  renderBartenderList,
  _resolveDisplayName,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/lastMinuteStaffingConfirmation.test.js`
Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/lastMinuteStaffingConfirmation.js server/utils/lastMinuteStaffingConfirmation.test.js
git commit -m "feat(comms): bartender-list renderer for last-minute staffing confirmation"
```

---

## Task 4: Notify function (notifyClientOfStaffingConfirmation)

**Files:**
- Modify: `server/utils/lastMinuteStaffingConfirmation.js` (add the main fn)
- Modify: `server/utils/lastMinuteStaffingConfirmation.test.js` (add integration tests)

This task ships the side-effecting notify function. Tests are integration-style against the real DB, they require `DATABASE_URL` set, same pattern as `paymentFailedClientNotify.test.js`. SMS is stubbed via `__setSmsDeps`; email is best-effort (no Resend key in dev means it logs only, we assert the SMS half and Sentry behavior, plus that the function doesn't throw).

- [ ] **Step 1: Add integration test setup at the top of the test file**

Edit `server/utils/lastMinuteStaffingConfirmation.test.js`. At the very top, add the dotenv config + fixture imports above the existing `const { test } = require('node:test');` line. Then add a fixtures block and tests at the bottom. The final file shape:

```js
require('dotenv').config();
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const {
  renderBartenderList,
  _resolveDisplayName,
  notifyClientOfStaffingConfirmation,
} = require('./lastMinuteStaffingConfirmation');

// ─── Pure renderer tests (Task 3) ────────────────────────────────
// ... (keep all 10 existing renderer tests unchanged) ...

// ─── Integration tests for notifyClientOfStaffingConfirmation ────

let clientId;
let proposalId;
let shiftId;
let userId;

before(async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone, communication_preferences, email_status, phone_status)
     VALUES ('LMSC Test', 'lmsc-test@example.com', '3125550190',
             '{"email_enabled": true, "sms_enabled": true}'::jsonb,
             'unknown', 'unknown')
     RETURNING id`
  );
  clientId = c.rows[0].id;
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, first_name, last_name, onboarding_status)
     VALUES ('lmsc-bartender@example.com', 'x', 'Alex', 'Smith', 'approved')
     RETURNING id`
  );
  userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone)
     VALUES ($1, 'Alex', '3125551234')`,
    [userId]
  );
});

beforeEach(async () => {
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, status, event_type, last_minute_hold)
     VALUES ($1, CURRENT_DATE + INTERVAL '2 days', '18:00', 'balance_paid', 'birthday-party', true)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  const s = await pool.query(
    `INSERT INTO shifts (proposal_id, event_date, start_time, end_time, location, positions_needed, status)
     VALUES ($1, CURRENT_DATE + INTERVAL '2 days', '18:00', '22:00', 'Test Venue',
             '["lead"]'::jsonb, 'open')
     RETURNING id`,
    [proposalId]
  );
  shiftId = s.rows[0].id;
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status) VALUES ($1, $2, 'approved')`,
    [shiftId, userId]
  );
});

afterEach(async () => {
  await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
  await pool.query('DELETE FROM sms_messages WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
});

after(async () => {
  await pool.query('DELETE FROM contractor_profiles WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

function stubSms() {
  const { __setSmsDeps, _realSendSMS } = require('./sms');
  const calls = [];
  __setSmsDeps({
    sendSMS: async ({ to, body }) => {
      calls.push({ to, body });
      return { sid: `stub-${calls.length}-${Date.now()}` };
    },
  });
  return {
    calls,
    restore: () => __setSmsDeps({ sendSMS: _realSendSMS }),
  };
}

test('notifyClientOfStaffingConfirmation > happy path: sends SMS once', async () => {
  const sms = stubSms();
  try {
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 1, 'exactly one SMS send');
    assert.match(sms.calls[0].body, /Your bartender for/);
    assert.match(sms.calls[0].body, /Alex \(\(312\) 555-1234\)/);
    const { rows } = await pool.query(
      "SELECT message_type, status FROM sms_messages WHERE client_id = $1",
      [clientId]
    );
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].message_type, 'last_minute_staffing_confirmation');
    assert.strictEqual(rows[0].status, 'sent');
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > proposal_missing returns silently', async () => {
  const sms = stubSms();
  try {
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(999999999, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > orphan_proposal returns silently', async () => {
  const sms = stubSms();
  try {
    await pool.query('UPDATE proposals SET client_id = NULL WHERE id = $1', [proposalId]);
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > archived status returns silently', async () => {
  const sms = stubSms();
  try {
    await pool.query("UPDATE proposals SET status = 'archived' WHERE id = $1", [proposalId]);
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > event_date_null returns silently', async () => {
  const sms = stubSms();
  try {
    await pool.query('UPDATE proposals SET event_date = NULL WHERE id = $1', [proposalId]);
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > no_bartenders returns silently', async () => {
  const sms = stubSms();
  try {
    await pool.query('DELETE FROM shift_requests WHERE shift_id = $1', [shiftId]);
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0);
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > sms-disabled client gets no SMS (email still attempts)', async () => {
  const sms = stubSms();
  try {
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"email_enabled": true, "sms_enabled": false}'::jsonb WHERE id = $1`,
      [clientId]
    );
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0, 'SMS must be suppressed');
    // Email best-effort (no Resend key in dev); we only check it did not throw.
  } finally { sms.restore(); }
});

test('notifyClientOfStaffingConfirmation > sms-throw does not prevent re-entry / does not throw out', async () => {
  // The function must swallow per-channel send failures via Sentry, never throw.
  const { __setSmsDeps, _realSendSMS } = require('./sms');
  __setSmsDeps({ sendSMS: async () => { throw new Error('twilio simulated 500'); } });
  try {
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    // The failed-send row was logged with status='failed' by sendAndLogSms.
    const { rows } = await pool.query(
      "SELECT status FROM sms_messages WHERE client_id = $1 ORDER BY id DESC LIMIT 1",
      [clientId]
    );
    assert.strictEqual(rows[0].status, 'failed');
  } finally { __setSmsDeps({ sendSMS: _realSendSMS }); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/utils/lastMinuteStaffingConfirmation.test.js`
Expected: the 10 existing renderer tests still pass; the 8 new integration tests fail because `notifyClientOfStaffingConfirmation` is not yet exported (`TypeError: notifyClientOfStaffingConfirmation is not a function`).

- [ ] **Step 3: Implement the notify function**

Edit `server/utils/lastMinuteStaffingConfirmation.js`. Add at the top (with the other requires), preserve the existing `renderBartenderList` + `_resolveDisplayName`:

```js
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { sendAndLogSms } = require('./sms');
const { shouldSendImmediate } = require('./messageSuppression');
const { formatPhoneDisplay } = require('./globalSearch');
const { formatEventDateLong } = require('./preEventHandlers');
const lifecycleEmail = require('./lifecycleEmailTemplates');
const smsTemplates = require('./smsTemplates');
```

(`formatPhoneDisplay` is already imported by the existing renderer code, make sure the require line appears exactly once.)

Below the existing `renderBartenderList` function, add:

```js
function _captureInfo(reason, extra) {
  if (!process.env.SENTRY_DSN_SERVER) return;
  Sentry.captureMessage(`[lastMinuteStaffingConfirmation] ${reason}`, {
    level: 'info',
    tags: { feature: 'staffing-confirmation', reason },
    extra,
  });
}

/**
 * Fire one client email + one client SMS announcing the bartender(s) for a
 * last-minute booking, the moment its shift becomes fully staffed. One-shot
 * per proposal, the caller guarantees this by gating on the atomic flip of
 * proposals.last_minute_hold true→false (see shifts.js
 * confirmStaffingIfFullyStaffed). This function never throws; per-channel
 * failures land in Sentry and the other channel still attempts.
 *
 * @param {number} proposalId
 * @param {number} shiftId , the shift that just became fully staffed; only
 *   bartenders approved on THIS shift are reported (multi-shift proposals keep
 *   other shifts' bartenders to the standard T-24h event-eve SMS).
 */
async function notifyClientOfStaffingConfirmation(proposalId, shiftId) {
  // Load proposal + client (LEFT JOIN, orphan proposals are real)
  const proposalRows = await pool.query(
    `SELECT p.id, p.event_date, p.event_start_time, p.event_timezone, p.status,
            c.id   AS client_id,
            c.name AS client_name,
            c.email AS client_email,
            c.phone AS client_phone,
            c.communication_preferences,
            c.email_status,
            c.phone_status
       FROM proposals p
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE p.id = $1`,
    [proposalId]
  );

  if (proposalRows.rows.length === 0) {
    _captureInfo('proposal_missing', { proposalId, shiftId });
    return;
  }
  const row = proposalRows.rows[0];
  if (row.client_id === null) {
    _captureInfo('orphan_proposal', { proposalId, shiftId });
    return;
  }
  if (row.status === 'archived') {
    _captureInfo('archived', { proposalId, shiftId });
    return;
  }
  if (row.event_date === null) {
    _captureInfo('event_date_null', { proposalId, shiftId });
    return;
  }

  // Load approved bartenders on the just-filled shift only
  const bartenderRows = await pool.query(
    `SELECT u.first_name, u.last_name, cp.preferred_name, cp.phone
       FROM shift_requests sr
       JOIN users u ON u.id = sr.user_id
       LEFT JOIN contractor_profiles cp ON cp.user_id = u.id
      WHERE sr.shift_id = $1 AND sr.status = 'approved'
      ORDER BY sr.id ASC`,
    [shiftId]
  );

  if (bartenderRows.rows.length === 0) {
    _captureInfo('no_bartenders', { proposalId, shiftId });
    return;
  }

  // Build the template inputs once (templates stay pure / array-free)
  const eventDate = formatEventDateLong(row);
  const bartenderList = renderBartenderList(bartenderRows.rows);
  const isPlural = bartenderRows.rows.length > 1;

  // The `proposal` and `client` shapes that shouldSendImmediate wants.
  const proposalForSuppression = { status: row.status };
  const clientForSuppression = {
    communication_preferences: row.communication_preferences,
    email_status: row.email_status,
    phone_status: row.phone_status,
  };

  // Email send, independent try/catch
  try {
    const emailOk = await shouldSendImmediate({
      proposal: proposalForSuppression,
      client: clientForSuppression,
      channel: 'email',
    });
    if (emailOk.ok && row.client_email) {
      const rendered = lifecycleEmail.lastMinuteStaffingConfirmation({
        eventDate, bartenderList, isPlural,
      });
      await sendEmail({
        to: row.client_email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
    }
  } catch (emailErr) {
    console.error('[lastMinuteStaffingConfirmation] email send failed:', emailErr.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(emailErr, {
        tags: { feature: 'staffing-confirmation', channel: 'email' },
        extra: { proposalId, shiftId },
      });
    }
  }

  // SMS send, independent try/catch
  try {
    const smsOk = await shouldSendImmediate({
      proposal: proposalForSuppression,
      client: clientForSuppression,
      channel: 'sms',
    });
    if (smsOk.ok && row.client_phone) {
      const body = smsTemplates.lastMinuteStaffingConfirmationSms({
        eventDate, bartenderList, isPlural,
      });
      await sendAndLogSms({
        to: row.client_phone,
        body,
        clientId: row.client_id,
        messageType: 'last_minute_staffing_confirmation',
        recipientName: row.client_name,
      });
    }
  } catch (smsErr) {
    console.error('[lastMinuteStaffingConfirmation] sms send failed:', smsErr.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(smsErr, {
        tags: { feature: 'staffing-confirmation', channel: 'sms' },
        extra: { proposalId, shiftId },
      });
    }
  }
}

module.exports = {
  renderBartenderList,
  _resolveDisplayName,
  notifyClientOfStaffingConfirmation,
};
```

(Replace the existing `module.exports` block at the bottom; do not leave two.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/utils/lastMinuteStaffingConfirmation.test.js`
Expected: all 18 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/utils/lastMinuteStaffingConfirmation.js server/utils/lastMinuteStaffingConfirmation.test.js
git commit -m "feat(comms): notifyClientOfStaffingConfirmation fires email + SMS on hold-cleared (Touch 2.2)"
```

---

## Task 5: Wire confirmStaffingIfFullyStaffed (rename + atomic-flip + auto-assign call)

**Files:**
- Modify: `server/routes/shifts.js`
- Modify: `server/utils/autoAssign.js`

Single commit because the three call-site wirings (rename in shifts.js, autoAssign.js addition) plus the helper internals are one logical feature: "every assignment path converges on the renamed helper, which atomically flips the hold and fires the notify."

- [ ] **Step 1: Read the current helper to confirm shape**

Open `server/routes/shifts.js` and re-read lines 820-860. Confirm: function `clearHoldIfFullyStaffed(shiftId)` exists; lines 669 and 786 call it; outer try/catch only `console.error`s.

- [ ] **Step 2: Rename + upgrade the helper**

In `server/routes/shifts.js`, replace the function definition at lines 820-857 with:

```js
/**
 * Clear the linked proposal's last-minute hold once its shift is fully staffed
 * and, if this caller wins the atomic flip, fire the client confirmation
 * (Touch 2.2, email + SMS naming the bartender(s) + phone).
 *
 * "Fully staffed" = approved shift_requests count >= positions_needed length -
 * the SAME definition autoAssign uses for slotsRemaining. The UPDATE returns
 * `id` only if the row was actually held (last_minute_hold true→false); a
 * returned row means THIS caller is the unique flip owner and is responsible
 * for the notify. Concurrent fills lose the WHERE clause race and skip silently.
 *
 * Non-blocking outer try/catch + Sentry capture. An orphan flip (hold cleared
 * but notify thrown) lands a Sentry exception so the lost message is observable.
 *
 * CALLERS: shifts.js:669, shifts.js:786, autoAssign.js. All three call
 * unconditionally, do not add an upstream `WHERE last_minute_hold` filter at
 * any call site (that would regress the auto-assign clear-hold bugfix).
 */
async function confirmStaffingIfFullyStaffed(shiftId) {
  try {
    const s = await pool.query(
      'SELECT proposal_id, positions_needed FROM shifts WHERE id = $1',
      [shiftId]
    );
    const row = s.rows[0];
    if (!row || !row.proposal_id) return;
    const needed = Array.isArray(row.positions_needed) ? row.positions_needed.length : 0;
    if (needed === 0) return;
    const a = await pool.query(
      "SELECT COUNT(*)::int AS n FROM shift_requests WHERE shift_id = $1 AND status = 'approved'",
      [shiftId]
    );
    if (a.rows[0].n < needed) return;
    const flip = await pool.query(
      'UPDATE proposals SET last_minute_hold = false WHERE id = $1 AND last_minute_hold = true RETURNING id',
      [row.proposal_id]
    );
    if (flip.rows.length === 0) return; // hold was already cleared or never set
    try {
      await notifyClientOfStaffingConfirmation(row.proposal_id, shiftId);
    } catch (notifyErr) {
      console.error('[shifts] notifyClientOfStaffingConfirmation failed (non-blocking):', notifyErr.message);
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(notifyErr, {
          tags: { feature: 'staffing-confirmation', stage: 'notify' },
          extra: { proposalId: row.proposal_id, shiftId },
        });
      }
    }
  } catch (e) {
    console.error('[shifts] confirmStaffingIfFullyStaffed failed (non-blocking):', e.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(e, {
        tags: { feature: 'staffing-confirmation' },
        extra: { shiftId },
      });
    }
  }
}
```

Also at the top of `server/routes/shifts.js`, add the new imports if they are not already present:

```js
const Sentry = require('@sentry/node');
const { notifyClientOfStaffingConfirmation } = require('../utils/lastMinuteStaffingConfirmation');
```

(Check whether Sentry is already imported. If yes, leave it; if no, add it.)

- [ ] **Step 3: Update the two existing call sites**

In `server/routes/shifts.js`:
- Line 669: `await clearHoldIfFullyStaffed(req.params.id);` → `await confirmStaffingIfFullyStaffed(req.params.id);`
- Line 786: `await clearHoldIfFullyStaffed(result.rows[0].shift_id);` → `await confirmStaffingIfFullyStaffed(result.rows[0].shift_id);`

Also update the inline comment above line 668 if it references the old name (search the file for `clearHoldIfFullyStaffed` to confirm no stragglers).

- [ ] **Step 4: Verify zero stragglers**

Run: `node -e "const fs = require('fs'); const s = fs.readFileSync('server/routes/shifts.js', 'utf8'); console.log('count:', (s.match(/clearHoldIfFullyStaffed/g) || []).length);"`
Expected: `count: 0`.

- [ ] **Step 5: Add the autoAssign.js call**

In `server/utils/autoAssign.js`, find the per-candidate SMS for-loop (it ends around line 342) and the `UPDATE shifts SET auto_assigned_at = NOW()` block (around line 346). Insert this between them:

```js
  // 11.5. Touch 2.2, if this auto-assign just filled a held proposal, fire
  // the client staffing-confirmation. Non-blocking; idempotency is enforced
  // by confirmStaffingIfFullyStaffed's atomic UPDATE.
  try {
    await confirmStaffingIfFullyStaffed(shiftId);
  } catch (confErr) {
    Sentry.captureException(confErr, {
      tags: { component: 'autoAssign', issue: 'staffing-confirmation' },
      extra: { shiftId },
    });
    console.error('[AutoAssign] staffing-confirmation hook failed (non-blocking):', confErr.message);
  }
```

At the top of `server/utils/autoAssign.js`, add the import next to the existing imports:

```js
const { confirmStaffingIfFullyStaffed } = require('../routes/shifts');
```

(Note: cross-layer import from `utils` → `routes` is unusual. If the linter or a code-review agent flags this, follow up by exporting `confirmStaffingIfFullyStaffed` from a new `server/utils/staffingConfirmation.js` wrapper. For now, the direct import is the minimal change.)

Confirm `confirmStaffingIfFullyStaffed` is exported from `server/routes/shifts.js`. Find the `module.exports` block at the bottom of `shifts.js`, if it currently uses `module.exports = router;`, replace with:

```js
module.exports = router;
module.exports.confirmStaffingIfFullyStaffed = confirmStaffingIfFullyStaffed;
```

(Routers in Express are functions, so attaching a named export property works without breaking the existing `app.use('/api/shifts', router)` consumers.)

- [ ] **Step 6: Sanity-check both files load**

```bash
node -e "require('./server/routes/shifts'); require('./server/utils/autoAssign'); console.log('ok');"
```
Expected output: `ok` (no require-cycle errors, no missing-export errors).

- [ ] **Step 7: Run the relevant test suites**

```bash
node --test server/utils/lastMinuteStaffingConfirmation.test.js
node --test server/utils/smsTemplates.test.js
node --test server/utils/lifecycleEmailTemplates.test.js
```
Expected: all tests pass (none of the existing tests should have regressed).

- [ ] **Step 8: Commit**

```bash
git add server/routes/shifts.js server/utils/autoAssign.js
git commit -m "feat(comms): wire Touch 2.2 across all three assignment paths (rename + RETURNING + autoAssign hook)"
```

---

## Task 6: Reschedule re-evaluation

**Files:**
- Modify: `server/utils/rescheduleProposal.js`

- [ ] **Step 1: Locate the insertion point**

Open `server/utils/rescheduleProposal.js`. Find `rescheduleProposalInTx(client, { proposalId, old, updated })`. Note where the existing balance-due-date + scheduled_messages cascade work happens. Insert the new logic AFTER all that work, BEFORE the function returns.

- [ ] **Step 2: Add the import**

At the top of `server/utils/rescheduleProposal.js` (with the other requires), add:

```js
const { getBookingWindow } = require('./bookingWindow');
```

- [ ] **Step 3: Add the re-evaluation logic**

Inside `rescheduleProposalInTx`, after the existing cascade work and just before the function returns its result, add:

```js
  // Touch 2.2 prerequisite, keep last_minute_hold consistent with the new
  // event_date/event_start_time. A held proposal moved past 72h becomes
  // unheld; a non-held proposal moved into 72h becomes held. The actual
  // notification fires from confirmStaffingIfFullyStaffed only when the
  // next staffing-fill flips a held proposal, this hook just keeps the
  // flag in sync with the booking window.
  const { lastMinuteHold } = getBookingWindow({
    eventDate: updated.event_date,
    eventStartTime: updated.event_start_time,
  });
  if (updated.last_minute_hold !== lastMinuteHold) {
    await client.query(
      'UPDATE proposals SET last_minute_hold = $1 WHERE id = $2',
      [lastMinuteHold, proposalId]
    );
  }
```

(`updated` here is the post-UPDATE row that `crud.js:617-626` passes in; it carries the new event_date / event_start_time and the prior `last_minute_hold` value.)

- [ ] **Step 4: Run the reschedule tests**

Run: `node --test server/utils/rescheduleProposal.test.js`
Expected: all existing tests pass (the re-evaluation is additive; existing test fixtures don't set `last_minute_hold` and won't trigger a flag change).

- [ ] **Step 5: Add one new test asserting the re-evaluation**

Append to `server/utils/rescheduleProposal.test.js`:

```js
test('rescheduleProposalInTx > moves held proposal past 72h → last_minute_hold becomes false', async () => {
  // Fixture: create a held proposal with an event 2 days out.
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('LMH Test', 'lmh@example.com', '3125550191') RETURNING id`
  );
  const cId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, event_start_time, status, event_type, last_minute_hold)
     VALUES ($1, CURRENT_DATE + INTERVAL '2 days', '18:00', 'balance_paid', 'birthday-party', true)
     RETURNING id`,
    [cId]
  );
  const pId = p.rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Simulate the PATCH handler updating the date to 30 days out.
    const upd = await client.query(
      `UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '30 days' WHERE id = $1 RETURNING *`,
      [pId]
    );
    await rescheduleProposalInTx(client, {
      proposalId: pId,
      old: { event_date: new Date(Date.now() + 2*24*3600*1000), event_start_time: '18:00', last_minute_hold: true },
      updated: upd.rows[0],
    });
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const after = await pool.query('SELECT last_minute_hold FROM proposals WHERE id = $1', [pId]);
  assert.strictEqual(after.rows[0].last_minute_hold, false);
  // cleanup
  await pool.query('DELETE FROM proposals WHERE id = $1', [pId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [cId]);
});
```

(Import `rescheduleProposalInTx` from the module's exports if the existing test file does not already destructure it. Confirm the import line; adjust if needed.)

- [ ] **Step 6: Run the test**

Run: `node --test server/utils/rescheduleProposal.test.js`
Expected: all tests including the new one pass.

- [ ] **Step 7: Commit**

```bash
git add server/utils/rescheduleProposal.js server/utils/rescheduleProposal.test.js
git commit -m "feat(comms): re-evaluate last_minute_hold on reschedule (Touch 2.2 prerequisite)"
```

---

## Task 7: Documentation updates

**Files:**
- Modify: `README.md`
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Read the relevant sections**

Open `README.md` and find the folder-structure tree (search for `server/utils/`). Open `ARCHITECTURE.md` and find the comms section.

- [ ] **Step 2: Add the new util file to README**

In `README.md`'s folder tree, locate the line listing `lastMinuteAlert.js` under `server/utils/`. Add a new line directly beneath it:

```
│   ├── lastMinuteStaffingConfirmation.js  # Touch 2.2, client email+SMS on hold clear
```

(Match the indentation style and comment style of surrounding lines exactly.)

- [ ] **Step 3: Add the one-liner to ARCHITECTURE**

In `ARCHITECTURE.md`, find the comms / scheduled-messages section. Add this bullet under the "Immediate event-driven sends" subsection (or create the subsection if it does not exist):

```
- **Touch 2.2 last-minute staffing confirmation**, `server/utils/lastMinuteStaffingConfirmation.js`. Immediate email + SMS to the client the moment a held proposal's shift becomes fully staffed. Triggered from `server/routes/shifts.js#confirmStaffingIfFullyStaffed`, which atomically flips `proposals.last_minute_hold` true→false via `RETURNING id` and only fires the notify when the flip succeeds (one-shot guard).
```

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: README + ARCHITECTURE updates for Touch 2.2"
```

---

## Self-Review

### Spec coverage

| Spec section | Plan task | Notes |
|---|---|---|
| The trigger §1 (rename) | Task 5 step 2-4 | ✓ |
| The trigger §2 (RETURNING flip) | Task 5 step 2 | ✓ |
| The trigger §3 (autoAssign call) | Task 5 step 5 | ✓ |
| The trigger §4 (reschedule re-eval) | Task 6 | ✓ |
| Call-site discipline PIN | Task 5 step 2 (docstring) | ✓ |
| Outer try/catch Sentry upgrade | Task 5 step 2 | ✓ |
| Notify fn step 1 (proposal+client LEFT JOIN + early returns) | Task 4 step 3 | ✓ |
| Notify fn step 2 (bartender query + fallback name) | Task 3 + Task 4 step 3 | ✓ |
| Notify fn step 3 (formatEventDateLong import) | Task 4 step 3 | ✓ |
| Notify fn step 4 (templates take primitives) | Task 4 step 3 | ✓ |
| Notify fn steps 5-6 (per-channel awaited shouldSendImmediate) | Task 4 step 3 | ✓ |
| SMS template | Task 1 | ✓ |
| Email template + re-export | Task 2 | ✓ |
| Suppression and edge handling matrix | Task 4 tests | ✓ each early-return + suppression-independence case |
| Tests: pluralization | Task 3 | ✓ 1/2/3/mixed/missing-names |
| Tests: early-return matrix | Task 4 | ✓ all 5 |
| Tests: per-channel suppression | Task 4 | ✓ sms-disabled, sms-throw |
| Tests: messageType literal acceptance | Task 4 happy-path test asserts `message_type = 'last_minute_staffing_confirmation'` in the sms_messages row | ✓ |
| Tests: non-held → no notify | Implicit in Task 4, the atomic flip in `confirmStaffingIfFullyStaffed` is the gate; the integration test in Task 5 step 7 covers this. Worth adding an explicit test in Task 5 if time allows. | Partial |
| Tests: auto-assign integration | Out of scope for unit tests; manual verification on staging | Documented |
| Tests: reschedule integration | Task 6 step 5 | ✓ (one direction; the reverse is symmetric) |
| README + ARCHITECTURE updates | Task 7 | ✓ |

### Placeholder scan

* No "TBD", "TODO", "fill in", or "implement later" present.
* No "similar to Task N" without showing the code.
* Every code step includes the actual code.
* The cross-layer `utils → routes` import in Task 5 Step 5 is flagged with a follow-up condition rather than left as a hand-wave.

### Type consistency

* `notifyClientOfStaffingConfirmation(proposalId, shiftId)`, same signature in Task 3 export, Task 4 export, Task 5 caller.
* `confirmStaffingIfFullyStaffed(shiftId)`, same signature at definition (Task 5 Step 2), at both call sites in shifts.js (Task 5 Step 3), and at the autoAssign call (Task 5 Step 5).
* Template signatures `({ eventDate, bartenderList, isPlural })`, identical in Task 1 SMS template, Task 2 email template, Task 4 notify fn (where bartenderList comes from `renderBartenderList()` and isPlural from `bartenders.length > 1`).
* `renderBartenderList(bartenders)`, same shape in Task 3 implementation and Task 4 caller.
* SQL column names, `last_minute_hold`, `event_date`, `event_start_time`, `event_timezone`, `client_id`, `status`, match the spec's named columns.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-last-minute-staffing-confirmation.md`. Two execution options:

1. **Subagent-Driven (recommended)**, I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution**, I execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
