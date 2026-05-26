# Last-Minute Staffing Confirmation (Touch 2.2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire Touch 2.2 from the comms spec: fire one client email + one client SMS with bartender name(s) and phone(s) the moment a `last_minute_hold = true` proposal's shift becomes fully staffed, one-shot per proposal.

**Architecture:** One new module, `server/utils/lastMinuteStaffingConfirmation.js`, hosts the whole feature: the pure `renderBartenderList` helper, the side-effecting `notifyClientOfStaffingConfirmation(proposalId, shiftId)`, and the extracted/renamed `confirmStaffingIfFullyStaffed(shiftId)` trigger (formerly inline in `shifts.js` as `clearHoldIfFullyStaffed`). Three call sites converge on the helper (the two existing `shifts.js` paths at lines 669 and 786, plus a new line in `autoAssign.js`); a fourth hook in `rescheduleProposalInTx` keeps `last_minute_hold` consistent across reschedules. The atomic `UPDATE ... RETURNING id` inside `confirmStaffingIfFullyStaffed` is the one-shot guard. Templates are pure (no I/O), live beside their siblings in `lifecycleEmailTemplates.js` and `smsTemplates.js`, and take pre-rendered primitives only. Putting both side-effect carriers in the same module avoids a circular require that would arise if the trigger stayed in `routes/shifts.js` (since `shifts.js` already requires `../utils/autoAssign` at load).

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
| `server/utils/lastMinuteStaffingConfirmation.js` (create) | The whole-feature module: pure `renderBartenderList` + `_resolveDisplayName`, side-effecting `notifyClientOfStaffingConfirmation`, and the trigger `confirmStaffingIfFullyStaffed` extracted from `shifts.js`. |
| `server/utils/lastMinuteStaffingConfirmation.test.js` (create) | Real-DB integration tests: renderer unit tests, early-return matrix, per-channel suppression independence, atomic-flip race, non-held-no-notify regression. |
| `server/routes/shifts.js` (modify) | DELETE the inline `clearHoldIfFullyStaffed`. At lines 669 and 786, call the imported `confirmStaffingIfFullyStaffed` from `../utils/lastMinuteStaffingConfirmation`. |
| `server/utils/autoAssign.js` (modify) | Add `await confirmStaffingIfFullyStaffed(shiftId)` between the per-candidate SMS for-loop and the `auto_assigned_at` UPDATE. Import from `./lastMinuteStaffingConfirmation` (sibling util, no cycle). |
| `server/utils/rescheduleProposal.js` (modify) | Inside `rescheduleProposalInTx`, re-evaluate `last_minute_hold` against the post-update `event_date`/`event_start_time`. |
| `server/utils/rescheduleProposal.test.js` (modify) | One new test: held proposal moved past 72h → flag becomes false. |
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

Append to `server/utils/smsTemplates.js` (before the `module.exports` block):

```js
// ─── 2.2 Last-minute staffing confirmation SMS ───────────────────
function lastMinuteStaffingConfirmationSms({ eventDate, bartenderList, isPlural }) {
  const noun = isPlural ? 'bartenders' : 'bartender';
  const verb = isPlural ? 'are' : 'is';
  return `Hi, Dallas here. Your ${noun} for ${eventDate} ${verb} ${bartenderList}. They'll reach out the day of the event. Let me know if you have any questions.`;
}
```

Add `lastMinuteStaffingConfirmationSms,` to the `module.exports` object at the bottom of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/utils/smsTemplates.test.js`
Expected: all tests pass.

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

Then add `lastMinuteStaffingConfirmation,` to the `module.exports` object at lines 321-327. Result:

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

Open `server/utils/emailTemplates.js`. Find the `module.exports` block (~lines 960-974). The existing block has lifecycle re-exports on lines 964-969:

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

- [ ] **Step 6: Sanity-check the re-export with typeof**

```bash
node -e "console.log(typeof require('./server/utils/emailTemplates').lastMinuteStaffingConfirmation)"
```

Expected output: `function`. (`typeof` is the right shape, not just `require`, see Task 4 Step 9 for why this matters with circular-require risks elsewhere.)

- [ ] **Step 7: Commit**

```bash
git add server/utils/lifecycleEmailTemplates.js server/utils/lifecycleEmailTemplates.test.js server/utils/emailTemplates.js
git commit -m "feat(comms): add lastMinuteStaffingConfirmation email template + re-export (Touch 2.2)"
```

---

## Task 3: Notify module (renderer + notify fn + README line)

**Files:**
- Create: `server/utils/lastMinuteStaffingConfirmation.js`
- Create: `server/utils/lastMinuteStaffingConfirmation.test.js`
- Modify: `README.md`

This task ships the whole notify-side module in one commit. The renderer and the notify fn co-locate because the notify fn is the renderer's only caller; shipping just the renderer would commit dead code. `confirmStaffingIfFullyStaffed` lands in Task 4 (it requires the notify fn that this task creates, so a forward dependency is impossible). Tests are real-DB integration tests, same pattern as `paymentFailedClientNotify.test.js`.

- [ ] **Step 1: Create the test file with renderer tests**

Create `server/utils/lastMinuteStaffingConfirmation.test.js`:

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

// ─── Pure renderer tests ─────────────────────────────────────────

test('_resolveDisplayName > preferred_name wins', () => {
  assert.strictEqual(_resolveDisplayName({ preferred_name: 'Alex' }), 'Alex');
});

test('_resolveDisplayName > falls through to generic when preferred_name is null', () => {
  assert.strictEqual(_resolveDisplayName({ preferred_name: null }), 'Your bartender');
});

test('_resolveDisplayName > falls through to generic on missing contractor_profiles row', () => {
  // LEFT JOIN with no contractor_profiles → the full row is null-shaped from
  // the renderer's perspective: { preferred_name: null, phone: null }.
  assert.strictEqual(_resolveDisplayName({ preferred_name: null, phone: null }), 'Your bartender');
});

test('renderBartenderList > 1 bartender with phone', () => {
  assert.strictEqual(
    renderBartenderList([{ preferred_name: 'Alex', phone: '3125551234' }]),
    'Alex ((312) 555-1234)'
  );
});

test('renderBartenderList > 1 bartender no phone', () => {
  assert.strictEqual(
    renderBartenderList([{ preferred_name: 'Alex', phone: null }]),
    'Alex'
  );
});

test('renderBartenderList > 2 bartenders both with phones', () => {
  assert.strictEqual(
    renderBartenderList([
      { preferred_name: 'Alex', phone: '3125551234' },
      { preferred_name: 'Jordan', phone: '3125555678' },
    ]),
    'Alex ((312) 555-1234) and Jordan ((312) 555-5678)'
  );
});

test('renderBartenderList > 3 bartenders Oxford-comma', () => {
  assert.strictEqual(
    renderBartenderList([
      { preferred_name: 'Alex', phone: '3125551234' },
      { preferred_name: 'Jordan', phone: '3125555678' },
      { preferred_name: 'Sam', phone: '3125559012' },
    ]),
    'Alex ((312) 555-1234), Jordan ((312) 555-5678), and Sam ((312) 555-9012)'
  );
});

test('renderBartenderList > 2 bartenders mixed phone presence', () => {
  assert.strictEqual(
    renderBartenderList([
      { preferred_name: 'Alex', phone: '3125551234' },
      { preferred_name: 'Jordan', phone: null },
    ]),
    'Alex ((312) 555-1234) and Jordan'
  );
});

test('renderBartenderList > 1 bartender with phone but null preferred_name', () => {
  assert.strictEqual(
    renderBartenderList([{ preferred_name: null, phone: '3125551234' }]),
    'Your bartender ((312) 555-1234)'
  );
});
```

- [ ] **Step 2: Run renderer tests to verify they fail**

Run: `node --test server/utils/lastMinuteStaffingConfirmation.test.js`
Expected: failure, `Cannot find module './lastMinuteStaffingConfirmation'`.

- [ ] **Step 3: Implement the renderer and notify fn (one file)**

Create `server/utils/lastMinuteStaffingConfirmation.js`:

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

// ─── Pure renderer ───────────────────────────────────────────────

/** Pick the most specific display name available, falling through to a generic label. */
function _resolveDisplayName(row) {
  return row.preferred_name || 'Your bartender';
}

/**
 * Render an approved-bartender list as a single human-readable string.
 *   1:  "Alex ((312) 555-1234)"   or   "Alex"  (no phone)
 *   2:  "Alex ((312) 555-1234) and Jordan ((312) 555-5678)"
 *   3+: "Alex (...), Jordan (...), and Sam (...)"   (Oxford comma)
 *
 * `phone` is the raw 10-digit value stored in `contractor_profiles.phone`
 * (per validatePhone in `phone.js`). `formatPhoneDisplay` returns
 * `(XXX) XXX-XXXX` for clean 10-digit storage and the empty string for
 * null/unparseable input; an empty display suppresses the parenthetical.
 *
 * `users` has no `first_name`/`last_name`; `contractor_profiles.preferred_name`
 * is the only name source, with `'Your bartender'` as the fallback for both
 * a null preferred_name AND a missing contractor_profiles row (LEFT JOIN null).
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

// ─── Notify fn ───────────────────────────────────────────────────

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
 * per proposal: the caller guarantees this by gating on the atomic flip of
 * proposals.last_minute_hold true→false (see confirmStaffingIfFullyStaffed).
 * This function never throws; per-channel failures land in Sentry and the
 * other channel still attempts.
 *
 * @param {number} proposalId
 * @param {number} shiftId  the shift that just became fully staffed; only
 *   bartenders approved on THIS shift are reported (multi-shift proposals
 *   keep other shifts' bartenders to the standard T-24h event-eve SMS).
 */
async function notifyClientOfStaffingConfirmation(proposalId, shiftId) {
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

  const bartenderRows = await pool.query(
    `SELECT cp.preferred_name, cp.phone
       FROM shift_requests sr
       LEFT JOIN contractor_profiles cp ON cp.user_id = sr.user_id
      WHERE sr.shift_id = $1 AND sr.status = 'approved'
      ORDER BY sr.id ASC`,
    [shiftId]
  );

  if (bartenderRows.rows.length === 0) {
    _captureInfo('no_bartenders', { proposalId, shiftId });
    return;
  }

  const eventDate = formatEventDateLong(row);
  const bartenderList = renderBartenderList(bartenderRows.rows);
  const isPlural = bartenderRows.rows.length > 1;

  const proposalForSuppression = { status: row.status };
  const clientForSuppression = {
    communication_preferences: row.communication_preferences,
    email_status: row.email_status,
    phone_status: row.phone_status,
  };

  // Email send, independent try/catch. shouldSendImmediate is async; the
  // await is load-bearing (the Promise's .ok is undefined without it).
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

  // SMS send, independent try/catch, same await requirement.
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

- [ ] **Step 4: Run renderer tests**

Run: `node --test server/utils/lastMinuteStaffingConfirmation.test.js`
Expected: the 9 renderer tests pass. The notify fn export exists but is untested yet.

- [ ] **Step 5: Add integration tests for the notify fn**

Append to `server/utils/lastMinuteStaffingConfirmation.test.js`:

```js
// ─── Integration tests for notifyClientOfStaffingConfirmation ────

let clientId;
let proposalId;
let shiftId;
let userId;
let savedRealSendSMS;  // captured once at the start so per-test stubs cannot
                       // be re-captured as "real" by a downstream test.

before(async () => {
  const sms = require('./sms');
  savedRealSendSMS = sms._realSendSMS;
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('LMSC Test', 'lmsc-test@example.com', '3125550190') RETURNING id`
  );
  clientId = c.rows[0].id;
  // Set communication_preferences explicitly (clients table doesn't have a default).
  await pool.query(
    `UPDATE clients SET communication_preferences = '{"email_enabled": true, "sms_enabled": true}'::jsonb,
                         email_status = 'unknown', phone_status = 'unknown'
       WHERE id = $1`,
    [clientId]
  );
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, onboarding_status) VALUES ('lmsc-bartender@example.com', 'x', 'approved') RETURNING id`
  );
  userId = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, phone) VALUES ($1, 'Alex', '3125551234')`,
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
     VALUES ($1, CURRENT_DATE + INTERVAL '2 days', '18:00', '22:00', 'Test Venue', '["lead"]', 'open')
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
  const { __setSmsDeps } = require('./sms');
  const calls = [];
  __setSmsDeps({
    sendSMS: async ({ to, body }) => {
      calls.push({ to, body });
      return { sid: `stub-${calls.length}-${Date.now()}` };
    },
  });
  return {
    calls,
    restore: () => __setSmsDeps({ sendSMS: savedRealSendSMS }),
  };
}

test('notifyClientOfStaffingConfirmation > happy path: sends SMS with rendered name + phone', async () => {
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
    // Set status via the original valid value set; if your local DB has the
    // post-migration constraint with 'archived', this UPDATE will succeed.
    // If not, use UPDATE WHERE id with a status the local CHECK accepts and
    // skip this case, the spec's notify fn check is correct against current
    // production schema.
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

test('notifyClientOfStaffingConfirmation > sms-disabled client gets no SMS (email path still attempts)', async () => {
  const sms = stubSms();
  try {
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"email_enabled": true, "sms_enabled": false}'::jsonb WHERE id = $1`,
      [clientId]
    );
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    assert.strictEqual(sms.calls.length, 0, 'SMS must be suppressed');
  } finally {
    sms.restore();
    await pool.query(
      `UPDATE clients SET communication_preferences = '{"email_enabled": true, "sms_enabled": true}'::jsonb WHERE id = $1`,
      [clientId]
    );
  }
});

test('notifyClientOfStaffingConfirmation > Twilio throw is swallowed (function does not reject)', async () => {
  const { __setSmsDeps } = require('./sms');
  __setSmsDeps({ sendSMS: async () => { throw new Error('twilio simulated 500'); } });
  try {
    await assert.doesNotReject(() => notifyClientOfStaffingConfirmation(proposalId, shiftId));
    // sendAndLogSms wrote the failed row before re-throwing; the outer
    // try/catch in notifyClientOfStaffingConfirmation swallowed the throw.
    const { rows } = await pool.query(
      "SELECT status FROM sms_messages WHERE client_id = $1 ORDER BY id DESC LIMIT 1",
      [clientId]
    );
    assert.strictEqual(rows[0].status, 'failed');
  } finally {
    __setSmsDeps({ sendSMS: savedRealSendSMS });
  }
});
```

- [ ] **Step 6: Run all tests**

Run: `node --test server/utils/lastMinuteStaffingConfirmation.test.js`
Expected: all 9 renderer tests + 8 integration tests pass (17 total).

- [ ] **Step 7: Add the README line**

Open `README.md`. Find the folder-tree section that lists `server/utils/` contents (search for `lastMinuteAlert.js`). Add a new line directly beneath it, matching the surrounding indent/comment style:

```
│   ├── lastMinuteStaffingConfirmation.js  # Touch 2.2: bartender-list renderer + notify fn + atomic-flip trigger
```

- [ ] **Step 8: Commit**

```bash
git add server/utils/lastMinuteStaffingConfirmation.js server/utils/lastMinuteStaffingConfirmation.test.js README.md
git commit -m "feat(comms): notify module for last-minute staffing confirmation (Touch 2.2)"
```

---

## Task 4: Extract trigger, delete from shifts.js, wire all three call sites, add docs

**Files:**
- Modify: `server/utils/lastMinuteStaffingConfirmation.js` (add `confirmStaffingIfFullyStaffed`)
- Modify: `server/utils/lastMinuteStaffingConfirmation.test.js` (add atomic-flip + non-held tests)
- Modify: `server/routes/shifts.js` (delete the inline helper, replace two call sites)
- Modify: `server/utils/autoAssign.js` (new third call site)
- Modify: `ARCHITECTURE.md`

This task lands the trigger function and wires it everywhere. Single commit because the three call-site updates plus the helper extraction are one logical feature ("every assignment path converges on the renamed helper"). The bundled fixes are explicit: the rename, the atomic-flip RETURNING upgrade, the auto-assign clear-hold bugfix (spec §The Trigger §3), and the Touch 2.2 notify wiring.

- [ ] **Step 1: Write the failing tests for the new trigger**

Append to `server/utils/lastMinuteStaffingConfirmation.test.js`:

```js
// ─── confirmStaffingIfFullyStaffed integration tests ─────────────

const { confirmStaffingIfFullyStaffed } = require('./lastMinuteStaffingConfirmation');

test('confirmStaffingIfFullyStaffed > held + fully-staffed → flips hold and sends', async () => {
  const sms = stubSms();
  try {
    await confirmStaffingIfFullyStaffed(shiftId);
    assert.strictEqual(sms.calls.length, 1);
    const { rows } = await pool.query('SELECT last_minute_hold FROM proposals WHERE id = $1', [proposalId]);
    assert.strictEqual(rows[0].last_minute_hold, false);
  } finally { sms.restore(); }
});

test('confirmStaffingIfFullyStaffed > non-held + fully-staffed → no notify (regression pin)', async () => {
  const sms = stubSms();
  try {
    await pool.query('UPDATE proposals SET last_minute_hold = false WHERE id = $1', [proposalId]);
    await confirmStaffingIfFullyStaffed(shiftId);
    assert.strictEqual(sms.calls.length, 0, 'normal-lead-time proposal must not fire notify');
  } finally { sms.restore(); }
});

test('confirmStaffingIfFullyStaffed > held but understaffed → no flip, no notify', async () => {
  // Make the shift need 2 positions; only 1 approved → not fully staffed.
  await pool.query(`UPDATE shifts SET positions_needed = '["lead","support"]' WHERE id = $1`, [shiftId]);
  const sms = stubSms();
  try {
    await confirmStaffingIfFullyStaffed(shiftId);
    assert.strictEqual(sms.calls.length, 0);
    const { rows } = await pool.query('SELECT last_minute_hold FROM proposals WHERE id = $1', [proposalId]);
    assert.strictEqual(rows[0].last_minute_hold, true, 'hold should still be true');
  } finally { sms.restore(); }
});

test('confirmStaffingIfFullyStaffed > concurrent calls flip exactly once (atomic-flip race)', async () => {
  const sms = stubSms();
  try {
    await Promise.all([
      confirmStaffingIfFullyStaffed(shiftId),
      confirmStaffingIfFullyStaffed(shiftId),
      confirmStaffingIfFullyStaffed(shiftId),
    ]);
    assert.strictEqual(sms.calls.length, 1, 'WHERE last_minute_hold=true is the one-shot guarantee');
  } finally { sms.restore(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/utils/lastMinuteStaffingConfirmation.test.js`
Expected: the 4 new tests fail with `TypeError: confirmStaffingIfFullyStaffed is not a function`.

- [ ] **Step 3: Add `confirmStaffingIfFullyStaffed` to the module**

In `server/utils/lastMinuteStaffingConfirmation.js`, append the new function below `notifyClientOfStaffingConfirmation`:

```js
/**
 * Clear the linked proposal's last-minute hold once its shift is fully staffed
 * and, if this caller wins the atomic flip, fire the client confirmation
 * (Touch 2.2: email + SMS naming the bartender(s) + phone).
 *
 * "Fully staffed" = approved shift_requests count >= positions_needed length,
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
 *
 * `positions_needed` is `TEXT DEFAULT '[]'` (JSON-encoded string per
 * schema.sql:280), so the length check uses `JSON.parse` with a fallback,
 * NOT `Array.isArray` (which is always false on strings).
 */
async function confirmStaffingIfFullyStaffed(shiftId) {
  try {
    const s = await pool.query(
      'SELECT proposal_id, positions_needed FROM shifts WHERE id = $1',
      [shiftId]
    );
    const row = s.rows[0];
    if (!row || !row.proposal_id) return;
    let needed = 0;
    try {
      const parsed = JSON.parse(row.positions_needed || '[]');
      needed = Array.isArray(parsed) ? parsed.length : 0;
    } catch (_) {
      needed = 0;
    }
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
      console.error('[confirmStaffingIfFullyStaffed] notify failed (non-blocking):', notifyErr.message);
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(notifyErr, {
          tags: { feature: 'staffing-confirmation', stage: 'notify' },
          extra: { proposalId: row.proposal_id, shiftId },
        });
      }
    }
  } catch (e) {
    console.error('[confirmStaffingIfFullyStaffed] failed (non-blocking):', e.message);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(e, {
        tags: { feature: 'staffing-confirmation' },
        extra: { shiftId },
      });
    }
  }
}
```

Update the `module.exports` block to add `confirmStaffingIfFullyStaffed`:

```js
module.exports = {
  renderBartenderList,
  _resolveDisplayName,
  notifyClientOfStaffingConfirmation,
  confirmStaffingIfFullyStaffed,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/utils/lastMinuteStaffingConfirmation.test.js`
Expected: all 21 tests pass (9 renderer + 8 notify + 4 trigger).

- [ ] **Step 5: Delete the old helper from shifts.js**

Open `server/routes/shifts.js`. Delete the entire `clearHoldIfFullyStaffed` function definition (lines 821-857, including the docblock above it). The file should end with the `module.exports = router;` line (which becomes the new last line of the file, with the function removed above it).

- [ ] **Step 6: Update the two call sites in shifts.js**

At the top of `server/routes/shifts.js`, with the other utils imports, add:

```js
const { confirmStaffingIfFullyStaffed } = require('../utils/lastMinuteStaffingConfirmation');
```

At line 669, change:

```js
  await clearHoldIfFullyStaffed(req.params.id);
```

to:

```js
  await confirmStaffingIfFullyStaffed(req.params.id);
```

At line 786, change:

```js
  await clearHoldIfFullyStaffed(result.rows[0].shift_id);
```

to:

```js
  await confirmStaffingIfFullyStaffed(result.rows[0].shift_id);
```

Also update the comment above each call site to reference the new name if it mentions the old one. Search the file for any remaining `clearHoldIfFullyStaffed` occurrences (should be none after these edits).

- [ ] **Step 7: Verify zero stragglers in shifts.js**

```bash
node -e "const fs=require('fs'); const s=fs.readFileSync('server/routes/shifts.js','utf8'); console.log('clear count:', (s.match(/clearHoldIfFullyStaffed/g) || []).length, '/ confirm count:', (s.match(/confirmStaffingIfFullyStaffed/g) || []).length);"
```

Expected: `clear count: 0 / confirm count: 3` (one import + two call sites).

- [ ] **Step 8: Add the autoAssign.js call**

In `server/utils/autoAssign.js`, at the top with the other imports, add:

```js
const { confirmStaffingIfFullyStaffed } = require('./lastMinuteStaffingConfirmation');
```

Find the per-candidate SMS for-loop (it ends around line 342) and the `UPDATE shifts SET auto_assigned_at = NOW()` block (around line 346). Insert this between them, before line 346:

```js
  // 11.5. Touch 2.2: if this auto-assign just filled a held proposal, fire
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

(`Sentry` is already imported in `autoAssign.js`. Confirm with a quick grep before assuming.)

- [ ] **Step 9: Sanity-check both files load without circular-require failures**

Use `typeof` (not just `require`) so a circular-require mask is exposed:

```bash
node -e "console.log('shifts:', typeof require('./server/routes/shifts')); console.log('confirm via utils:', typeof require('./server/utils/lastMinuteStaffingConfirmation').confirmStaffingIfFullyStaffed); console.log('autoAssign:', typeof require('./server/utils/autoAssign').autoAssignShift);"
```

Expected:
```
shifts: function
confirm via utils: function
autoAssign: function
```

Any `undefined` in the second line means the circular-require concern bit; investigate before proceeding.

- [ ] **Step 10: Add the ARCHITECTURE one-liner**

In `ARCHITECTURE.md`, find the comms / scheduled-messages section. Add this bullet (or a similar entry under an "Immediate event-driven sends" sub-section, creating that sub-section if it does not yet exist):

```
- **Touch 2.2 last-minute staffing confirmation**, `server/utils/lastMinuteStaffingConfirmation.js`. Immediate email + SMS to the client the moment a held proposal's shift becomes fully staffed. Triggered from `confirmStaffingIfFullyStaffed`, which atomically flips `proposals.last_minute_hold` true→false via `RETURNING id` and only fires the notify when the flip succeeds (one-shot guard). Called from `server/routes/shifts.js` (manual assign + request approval) and `server/utils/autoAssign.js`.
```

- [ ] **Step 11: Re-run the test suite to confirm nothing regressed**

```bash
node --test server/utils/lastMinuteStaffingConfirmation.test.js
node --test server/utils/smsTemplates.test.js
node --test server/utils/lifecycleEmailTemplates.test.js
```

Expected: all tests pass.

- [ ] **Step 12: Commit**

```bash
git add server/utils/lastMinuteStaffingConfirmation.js server/utils/lastMinuteStaffingConfirmation.test.js server/routes/shifts.js server/utils/autoAssign.js ARCHITECTURE.md
git commit -m "feat(comms,shifts): extract confirmStaffingIfFullyStaffed, wire all assign paths (Touch 2.2 + closes auto-assign clear-hold gap)"
```

---

## Task 5: Reschedule re-evaluation

**Files:**
- Modify: `server/utils/rescheduleProposal.js`
- Modify: `server/utils/rescheduleProposal.test.js`

This task can ship independently of Task 4. Without it, a held proposal rescheduled past 72h keeps a stale `last_minute_hold` flag (harmless, the next staffing-fill would correctly fire a "your bartender is X" notify, just on a booking that's no longer last-minute). With it, the flag stays consistent with the booking window.

- [ ] **Step 1: Grep the existing test file for shape**

```bash
node -e "const s=require('fs').readFileSync('server/utils/rescheduleProposal.test.js','utf8'); console.log('imports:', s.split('\n').slice(0,15).join('\n'));"
```

Confirm: the test file already imports from `node:test`, `node:assert/strict`, `../db`, and `./rescheduleProposal`. Note which of `rescheduleProposal` / `rescheduleProposalInTx` is already destructured in the imports block (you may need to add `rescheduleProposalInTx` to the import line).

- [ ] **Step 2: Add the import in `rescheduleProposal.js`**

Open `server/utils/rescheduleProposal.js`. At the top with the existing requires, add:

```js
const { getBookingWindow } = require('./bookingWindow');
```

- [ ] **Step 3: Add the re-evaluation logic inside `rescheduleProposalInTx`**

Inside `rescheduleProposalInTx`, after the existing balance-due / scheduled_messages cascade work and just before the function returns, add:

```js
  // Touch 2.2 prerequisite: keep last_minute_hold consistent with the new
  // event_date/event_start_time. A held proposal moved past 72h becomes
  // unheld; a non-held proposal moved into 72h becomes held. The actual
  // notification fires from confirmStaffingIfFullyStaffed only when the
  // next staffing-fill flips a held proposal; this hook just keeps the
  // flag in sync with the booking window.
  //
  // getBookingWindow returns { hoursUntilEvent, fullPaymentRequired,
  // lastMinuteHold } and takes an options object (NOT a row); see
  // bookingWindow.js:39 + :42-46 for the signature.
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

(`updated` is the post-UPDATE row that `crud.js:617-626` passes in; it carries the new event_date/event_start_time and the prior `last_minute_hold` value. The PATCH UPDATE includes `RETURNING *`, so `updated.last_minute_hold` reflects pre-hook state. If you can't confirm `updated` carries this column, do a fresh `SELECT last_minute_hold FROM proposals WHERE id = $1` via the same `client` instead.)

- [ ] **Step 4: Add a test asserting held-becomes-unheld on reschedule past 72h**

Append to `server/utils/rescheduleProposal.test.js` (adjust the imports if `rescheduleProposalInTx` is not already imported):

```js
test('rescheduleProposalInTx > moves held proposal past 72h → last_minute_hold becomes false', async () => {
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('LMH Test', 'lmh-test@example.com', '3125550191') RETURNING id`
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
    const oldRow = { event_date: new Date(Date.now() + 2*24*3600*1000), event_start_time: '18:00', last_minute_hold: true };
    const upd = await client.query(
      `UPDATE proposals SET event_date = CURRENT_DATE + INTERVAL '30 days' WHERE id = $1 RETURNING *`,
      [pId]
    );
    await rescheduleProposalInTx(client, {
      proposalId: pId,
      old: oldRow,
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
  await pool.query('DELETE FROM proposals WHERE id = $1', [pId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [cId]);
});
```

- [ ] **Step 5: Run reschedule tests**

```bash
node --test server/utils/rescheduleProposal.test.js
```

Expected: all existing tests pass, and the new test passes.

- [ ] **Step 6: Commit**

```bash
git add server/utils/rescheduleProposal.js server/utils/rescheduleProposal.test.js
git commit -m "feat(reschedule): re-evaluate last_minute_hold on reschedule (Touch 2.2 prerequisite)"
```

---

## Execution-Review Cadence

Per the user's standing review preference (see memory: "Plan-execution review cadence"), run a focused review at each major checkpoint. Skip on Tasks 1-2 (mechanical template work, low blast radius). Specialized agents fire after the following:

| After | Agents | Why |
|---|---|---|
| Task 3 (notify module + tests) | `code-review` + `consistency-check` | Cross-cutting integration of `messageSuppression`, templates, sendEmail, sendAndLogSms; new shape of integration tests. |
| Task 4 (extract + wire all paths) | `consistency-check` + `database-review` | Verify the rename caught every site and that the atomic-flip race semantics are correct under concurrency. |
| Task 5 (reschedule hook) | `database-review` | Cross-transaction consistency check in `rescheduleProposalInTx`. |

No `security-review` is required for this feature (no auth/payment surface). `performance-review` not required either (the notify fn is one event-driven query pair, no batching, no scheduler).

---

## Self-Review

### Spec coverage

| Spec section | Plan task | Notes |
|---|---|---|
| The trigger §1 (extract + rename, NOT cross-layer import) | Task 4 Steps 3, 5, 6 | ✓ Extracted to utils, both shifts.js call sites and autoAssign import from the same module. |
| The trigger §2 (RETURNING flip) + positions_needed PIN | Task 4 Step 3 | ✓ JSON.parse preserved. |
| The trigger §3 (autoAssign call) | Task 4 Step 8 | ✓ |
| The trigger §4 (reschedule re-eval inside `rescheduleProposalInTx`) | Task 5 Steps 2-3 | ✓ Uses `updated` arg as spec mandates. |
| Call-site discipline PIN | Task 4 Step 3 (docstring) | ✓ |
| Outer try/catch Sentry upgrade | Task 4 Step 3 | ✓ |
| Notify fn step 1 (proposal+client LEFT JOIN + early returns) | Task 3 Step 3 | ✓ All 4 early-return reasons captured. |
| Notify fn step 2 (bartender query, no users JOIN, fallback `'Your bartender'`) | Task 3 Step 3 | ✓ `users.first_name`/`last_name` removed everywhere. |
| Notify fn step 3 (formatEventDateLong import) | Task 3 Step 3 | ✓ Imported from `./preEventHandlers`. |
| Notify fn step 4 (templates take primitives) | Task 3 Step 3 | ✓ |
| Notify fn steps 5-6 (per-channel awaited shouldSendImmediate) | Task 3 Step 3 | ✓ `await` is load-bearing per the inline comment. |
| SMS template | Task 1 | ✓ |
| Email template + re-export | Task 2 | ✓ |
| Suppression and edge handling matrix | Task 3 Step 5 tests | ✓ All early-return cases plus SMS-disabled + Twilio-throw. |
| Tests: pluralization | Task 3 Step 1 | ✓ 1/2/3/mixed + null preferred_name. |
| Tests: early-return matrix | Task 3 Step 5 | ✓ All 5 reasons. |
| Tests: per-channel suppression | Task 3 Step 5 | ✓ sms-disabled, sms-throw. |
| Tests: messageType literal acceptance | Task 3 Step 5 happy-path asserts `message_type = 'last_minute_staffing_confirmation'`. | ✓ |
| Tests: non-held → no notify | Task 4 Step 1 | ✓ Explicit regression pin. |
| Tests: atomic-flip race | Task 4 Step 1 | ✓ Three concurrent calls → exactly one send. |
| Tests: auto-assign integration | Documented as manual verification on staging; out of scope for unit tests. | Documented |
| Tests: reschedule integration | Task 5 Step 4 (one direction; the reverse is symmetric). | ✓ |
| README + ARCHITECTURE updates | Tasks 3 Step 7 + 4 Step 10 (folded into feature commits, not a separate docs task). | ✓ |

### Placeholder scan

* No "TBD", "TODO", "fill in", or "implement later" present.
* No "similar to Task N" without showing the code.
* Every code step includes the actual code.
* The previous draft's cross-layer `utils → routes` import is gone; the helper now lives in `utils/lastMinuteStaffingConfirmation.js` and both `routes/shifts.js` and `utils/autoAssign.js` import from it.

### Type consistency

* `notifyClientOfStaffingConfirmation(proposalId, shiftId)`, same signature in Task 3 export and Task 4 internal caller.
* `confirmStaffingIfFullyStaffed(shiftId)`, same signature at definition (Task 4 Step 3), at both shifts.js call sites (Task 4 Step 6), and at the autoAssign call (Task 4 Step 8).
* Template signatures `({ eventDate, bartenderList, isPlural })`, identical in Task 1, Task 2, and Task 3's notify-fn callers.
* `renderBartenderList(bartenders)`, same shape in Task 3 implementation and Task 3 notify-fn caller.
* SQL columns referenced (`last_minute_hold`, `event_date`, `event_start_time`, `event_timezone`, `client_id`, `status`, `contractor_profiles.preferred_name`, `contractor_profiles.phone`) all verified against `schema.sql`.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-last-minute-staffing-confirmation.md`. Two execution options:

1. **Subagent-Driven (recommended)**, fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution**, execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
