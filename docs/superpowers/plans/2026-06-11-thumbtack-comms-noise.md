# Thumbtack Comms Noise Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop OS from re-alerting the admin about Thumbtack messages Thumbtack already delivers, capture the client's real phone number at sign-and-pay, and fix the broken event-date rendering in every automated client SMS.

**Architecture:** Five independent slices: (1) a shared SMS event-date formatter that replaces four buggy per-file copies and a template restructure for the no-date case; (2) Thumbtack proxy-relay detection in the inbound-SMS orchestrator (tag + record, zero alerts, fail open); (3) removal of the redundant Thumbtack message webhook email; (4) relay-row exclusion in the admin Messages endpoints; (5) an optional phone field on the public sign-and-pay form that overwrites a proxy number with a real one, gated on the signature write.

**Tech Stack:** Node/Express, raw SQL via `pg`, `node:test` + `assert/strict`, React 18 (CRA).

**Spec:** `docs/superpowers/specs/2026-06-11-thumbtack-comms-noise-design.md` (v3, fleet-reviewed twice).

**Working directory for every step:** `C:\Users\dalla\DRB_OS\worktrees\thumbtack-comms` (branch `thumbtack-comms`). All file paths below are relative to it. Commits land on `thumbtack-comms`, explicit pathspecs only, single-line messages.

**Test discipline:** the DB-backed suites share the dev Neon DB — run them ONE FILE AT A TIME (`node --test <file>`), never the whole tree at once. Pure suites (`smsTemplates.test.js`, `smsEventDate.test.js`) have no DB dependency.

---

### Task 0: Workspace setup

**Files:** none (environment only)

- [ ] **Step 0.1: Copy the env file into the worktree** (gitignored, required by DB-backed tests)

Run (PowerShell):
```powershell
Copy-Item C:\Users\dalla\DRB_OS\os\.env C:\Users\dalla\DRB_OS\worktrees\thumbtack-comms\.env
```

- [ ] **Step 0.2: Baseline — confirm the two suites this plan extends pass before any change**

Run (from the worktree root):
```powershell
node --test server/utils/smsTemplates.test.js
node --test server/utils/smsInbound.test.js
```
Expected: all tests pass. If `smsInbound.test.js` fails on leftover fixture rows, its `before()` cleanup is self-healing — run it once more.

---

### Task 1: Shared event-date formatter + no-date template restructure

The root cause of both production copy bugs: pg returns `DATE` columns as JS `Date` objects, and four near-identical helpers do `String(eventDate).slice(0, 10)`, which turns a Date into `"Thu Jun 12"`. Unguarded (2 inline call sites) that renders literal `"Invalid Date"`; guarded (3 helper copies + 1 in `sendProposalSentEmail`) it falls back to the `'your event'` sentinel, which reads wrong in "on ___" positions. One formatter, one contract: callers pass a formatted string or `null`; templates own all fallback copy.

**Files:**
- Create: `server/utils/smsEventDate.js`
- Create: `server/utils/smsEventDate.test.js`
- Modify: `server/utils/smsTemplates.js` (4 templates)
- Modify: `server/utils/smsTemplates.test.js` (no-date matrix)
- Modify: `server/utils/sendProposalSentEmail.js` (delete `formatSmsDate`, lines 26-33)
- Modify: `server/utils/dripSmsHandlers.js` (delete `eventDateSms`, lines 57-62)
- Modify: `server/utils/balanceSmsHandlers.js` (delete `eventDateSms`, lines 61-66)
- Modify: `server/utils/drinkPlanNudge.js` (delete `eventDateSms`, lines 52-57)
- Modify: `server/utils/stripePaymentNotifications.js` (inline ternary, lines 157-160)
- Modify: `server/utils/paymentFailedClientNotify.js` (inline ternary, lines 92-95)

- [ ] **Step 1.1: Write the failing formatter test**

Create `server/utils/smsEventDate.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatEventDateForSms } = require('./smsEventDate');

test('formats a YYYY-MM-DD string', () => {
  assert.strictEqual(formatEventDateForSms('2026-08-15'), 'August 15');
});

test('formats a long ISO timestamp string', () => {
  assert.strictEqual(formatEventDateForSms('2026-08-15T00:00:00.000Z'), 'August 15');
});

test('formats a pg Date object by its local calendar date', () => {
  // pg parses DATE columns to local midnight; the formatter must not shift the day.
  assert.strictEqual(formatEventDateForSms(new Date(2026, 7, 15)), 'August 15');
});

test('null, undefined, and empty string return null', () => {
  assert.strictEqual(formatEventDateForSms(null), null);
  assert.strictEqual(formatEventDateForSms(undefined), null);
  assert.strictEqual(formatEventDateForSms(''), null);
});

test('a garbage string returns null', () => {
  assert.strictEqual(formatEventDateForSms('not a date'), null);
});

test('an invalid Date object returns null', () => {
  assert.strictEqual(formatEventDateForSms(new Date('nope')), null);
});
```

- [ ] **Step 1.2: Run it to confirm it fails**

Run: `node --test server/utils/smsEventDate.test.js`
Expected: FAIL — `Cannot find module './smsEventDate'`

- [ ] **Step 1.3: Implement the formatter**

Create `server/utils/smsEventDate.js`:

```js
// Shared SMS event-date formatter. pg returns DATE columns as JS Date objects;
// the old per-file helpers did String(eventDate).slice(0, 10), which turns a
// Date into "Thu Jun 12" and rendered "Invalid Date" (unguarded call sites) or
// the 'your event' sentinel (guarded ones) in client-facing SMS. One formatter,
// one contract: returns "June 12" or null. Callers pass the result straight to
// the SMS templates, which own all fallback copy.

/**
 * @param {Date|string|null|undefined} eventDate proposals.event_date (a pg
 *   Date object) or an ISO-ish string.
 * @returns {string|null} e.g. "June 12", or null when missing/unparseable.
 */
function formatEventDateForSms(eventDate) {
  if (!eventDate) return null;
  let ymd;
  if (eventDate instanceof Date) {
    if (Number.isNaN(eventDate.getTime())) return null;
    // Local calendar parts: pg parses DATE columns to local midnight, so
    // toISOString() could shift the day in timezones east of UTC.
    ymd = `${eventDate.getFullYear()}-${String(eventDate.getMonth() + 1).padStart(2, '0')}-${String(eventDate.getDate()).padStart(2, '0')}`;
  } else {
    ymd = String(eventDate).slice(0, 10);
  }
  const parsed = new Date(ymd + 'T12:00:00Z');
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
}

module.exports = { formatEventDateForSms };
```

- [ ] **Step 1.4: Run the formatter test — passes**

Run: `node --test server/utils/smsEventDate.test.js`
Expected: PASS (6 tests)

- [ ] **Step 1.5: Add the failing no-date template tests**

Append to `server/utils/smsTemplates.test.js`:

```js
// ─── No-date contract: callers pass a formatted string or null; templates own
// the fallback. "on ___" templates drop the clause; "for ___" keep dt(). ───

test('initialProposalSms > drops the date clause when eventDate is null', () => {
  const s = t.initialProposalSms({ eventTypeLabel: 'birthday party', eventDate: null, link: 'https://x/p/abc' });
  assert.match(s, /proposal for the birthday party\. Review/);
  assert.ok(!s.includes('on your event'), 'no "on your event"');
});

test('dripTouch1Sms > drops the date clause when eventDate is null', () => {
  const s = t.dripTouch1Sms({ eventTypeLabel: 'wedding', eventDate: null });
  assert.match(s, /for the wedding\?/);
  assert.ok(!s.includes('your event'), 'no fallback text in an "on" slot');
});

test('dripTouch3Sms > drops the date clause when eventDate is null', () => {
  const s = t.dripTouch3Sms({ eventTypeLabel: 'wedding', eventDate: null, link: 'https://x/p/abc' });
  assert.match(s, /Quick thought on the wedding\./);
  assert.ok(!s.includes('on your event'), 'no "on your event"');
});

test('dripTouch5Sms > no doubled "your event" when eventDate is null', () => {
  const s = t.dripTouch5Sms({ eventDate: null, link: 'https://x/p/abc' });
  assert.match(s, /Last check on your event\./);
  assert.ok(!s.includes('your your'), 'no "your your event event"');
});

test('signPayConfirmationSms > falls back to "your event" when eventDate is null', () => {
  const s = t.signPayConfirmationSms({ eventDate: null });
  assert.match(s, /You're booked for your event!/);
});

test('paymentFailureSms > falls back to "your event" when eventDate is null', () => {
  const s = t.paymentFailureSms({ eventDate: null, link: 'https://x/p/abc' });
  assert.match(s, /payment for your event didn't go through/);
});
```

- [ ] **Step 1.6: Run template tests — the four "drops the date clause" cases fail**

Run: `node --test server/utils/smsTemplates.test.js`
Expected: FAIL on the four new drop-clause tests ("on your event" present today); the two fallback tests already pass.

- [ ] **Step 1.7: Restructure the four "on ___" templates**

In `server/utils/smsTemplates.js`, replace the four functions (keep `ev()` and `dt()` as they are — `dt()` still serves the "for ___" templates):

```js
// ─── 1.2 Initial proposal SMS ────────────────────────────────────
function initialProposalSms({ eventTypeLabel, eventDate, link }) {
  const dateClause = eventDate ? ` on ${eventDate}` : '';
  return `Hi, Dallas here. Just sent your proposal for the ${ev(eventTypeLabel)}${dateClause}. Review the details and check out here: ${link}. Let me know if you have any questions or need any changes.`;
}
```

```js
// ─── 1.3 Drip touch 1 (+1d) ──────────────────────────────────────
function dripTouch1Sms({ eventTypeLabel, eventDate }) {
  const dateClause = eventDate ? ` on ${eventDate}` : '';
  return `Hi, Dallas here. Did you get the proposal I sent for the ${ev(eventTypeLabel)}${dateClause}? Let me know if you have any questions.`;
}
```

```js
// ─── 1.3 Drip touch 3 (+10d) ─────────────────────────────────────
function dripTouch3Sms({ eventTypeLabel, eventDate, link }) {
  const dateClause = eventDate ? ` on ${eventDate}` : '';
  return `Hi, Dallas here. Quick thought on the ${ev(eventTypeLabel)}${dateClause}. Want to tweak anything before it books up? Easy to adjust: ${link}.`;
}
```

```js
// ─── 1.3 Drip touch 5 (+21d), SMS half ───────────────────────────
function dripTouch5Sms({ eventDate, link }) {
  const eventClause = eventDate ? `your ${eventDate} event` : 'your event';
  return `Hi, Dallas here. Last check on ${eventClause}. Want to lock it in before someone else grabs the date? ${link}`;
}
```

- [ ] **Step 1.8: Run template tests — all pass**

Run: `node --test server/utils/smsTemplates.test.js`
Expected: PASS (all, including the pre-existing happy-path tests — the with-date output is unchanged).

- [ ] **Step 1.9: Adopt the shared formatter in the three helper-copy files**

In `server/utils/dripSmsHandlers.js`: delete the local `eventDateSms` function (lines 57-62) and add to the requires block at the top:
```js
const { formatEventDateForSms: eventDateSms } = require('./smsEventDate');
```
(The alias keeps every call site in the file unchanged; the behavior change is that it now returns `null` instead of `'your event'`, and handles Date objects correctly.)

In `server/utils/balanceSmsHandlers.js`: same change — delete the local `eventDateSms` (lines 61-66), add the same aliased require.

In `server/utils/drinkPlanNudge.js`: same change — delete the local `eventDateSms` (lines 52-57), add the same aliased require. (Only the SMS path uses `eventDateSms`; the email's `eventDateDisplay` is separate and untouched.)

- [ ] **Step 1.10: Adopt it in `sendProposalSentEmail.js`**

Delete the local `formatSmsDate` function (lines 26-33 including its JSDoc line) and add to the requires:
```js
const { formatEventDateForSms } = require('./smsEventDate');
```
Change line 92 from `eventDate: formatSmsDate(proposal.event_date),` to:
```js
      eventDate: formatEventDateForSms(proposal.event_date),
```

- [ ] **Step 1.11: Fix the two unguarded inline call sites**

In `server/utils/stripePaymentNotifications.js`: add to the top-level requires:
```js
const { formatEventDateForSms } = require('./smsEventDate');
```
Replace lines 157-163 (the `const eventDateSms = ...` ternary and the `sendAndLogSms` call's body line) so the block reads:
```js
            const { sendAndLogSms } = require('./sms');
            const smsTemplates = require('./smsTemplates');
            await sendAndLogSms({
              to: pi.client_phone,
              body: smsTemplates.signPayConfirmationSms({ eventDate: formatEventDateForSms(pi.event_date) }),
```
(The rest of the `sendAndLogSms` argument object is unchanged.)

In `server/utils/paymentFailedClientNotify.js`: add to the requires:
```js
const { formatEventDateForSms } = require('./smsEventDate');
```
Delete lines 92-95 (the `const eventDateSms = ...` ternary) and change the `sendAndLogSms` call's body line to:
```js
          body: smsTemplates.paymentFailureSms({ eventDate: formatEventDateForSms(pc.event_date), link: proposalUrl }),
```

- [ ] **Step 1.12: Verify nothing else references the deleted helpers**

Run: `node -e "console.log('syntax ok')" && git -C . grep -n "formatSmsDate\|eventDateSms" -- server`
Expected: the only `eventDateSms` hits are the three aliased requires (and none for `formatSmsDate`). Then sanity-load every touched module:
```powershell
node -e "require('./server/utils/dripSmsHandlers'); require('./server/utils/balanceSmsHandlers'); require('./server/utils/drinkPlanNudge'); require('./server/utils/sendProposalSentEmail'); require('./server/utils/stripePaymentNotifications'); require('./server/utils/paymentFailedClientNotify'); console.log('modules load')"
```
Expected: `modules load`.

- [ ] **Step 1.13: Re-run both pure suites**

Run: `node --test server/utils/smsEventDate.test.js` then `node --test server/utils/smsTemplates.test.js`
Expected: PASS.

- [ ] **Step 1.14: Commit**

```powershell
git add server/utils/smsEventDate.js server/utils/smsEventDate.test.js server/utils/smsTemplates.js server/utils/smsTemplates.test.js server/utils/sendProposalSentEmail.js server/utils/dripSmsHandlers.js server/utils/balanceSmsHandlers.js server/utils/drinkPlanNudge.js server/utils/stripePaymentNotifications.js server/utils/paymentFailedClientNotify.js
git commit -m "fix(sms): shared event-date formatter; kill Invalid Date and 'on your event' in client SMS"
```

---

### Task 2: Thumbtack relay detection + suppression in the inbound webhook

**Files:**
- Modify: `server/utils/smsInbound.js`
- Modify: `server/utils/smsInbound.test.js`

- [ ] **Step 2.1: Add the failing detection + orchestrator tests**

In `server/utils/smsInbound.test.js`, first add this line directly after `require('dotenv').config();` (line 1), so the fail-open test's admin-alert path can never fire a real send even if the local `.env` forces notifications on:

```js
process.env.SEND_NOTIFICATIONS = 'false'; // never fire real email/SMS from this suite
```

Then extend the import list (line 5-16) to:

```js
const {
  detectOptKeyword,
  detectResponseCode,
  lookupSender,
  recordInboundMessage,
  applyOptOut,
  applyOptIn,
  handleConfirm,
  handleCant,
  findStaffCandidatesByPhone,
  resolveShiftResponder,
  findThumbtackProxyLead,
  processInboundSms,
  __setDeps,
} = require('./smsInbound');
```

Add a `ttClientId` declaration next to the existing `let lsClientId;` (line 56):
```js
let ttClientId;
```

In the existing `before()` (after the contractor_profiles insert, line 80), append:

```js
  // Thumbtack relay fixtures: a post-rollout lead whose proxy number is the
  // client's stored phone (mirrors prod), and a pre-rollout lead with a real
  // number that must NOT match.
  await pool.query("DELETE FROM thumbtack_leads WHERE negotiation_id IN ('tt-relay-proxy-test', 'tt-relay-legacy-test')");
  await pool.query("DELETE FROM clients WHERE email = 'tt-relay-client@example.com'");
  const tc = await pool.query(
    `INSERT INTO clients (name, email, phone, source) VALUES ('TT Relay Client', 'tt-relay-client@example.com', '8392750001', 'thumbtack') RETURNING id`
  );
  ttClientId = tc.rows[0].id;
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_phone, customer_name)
     VALUES ('tt-relay-proxy-test', $1, '8392750001', 'TT Relay Client')`,
    [ttClientId]
  );
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_phone, customer_name, created_at)
     VALUES ('tt-relay-legacy-test', $1, '3125550148', 'SMS Lookup Client', '2026-06-01T00:00:00Z')`,
    [lsClientId]
  );
```

In the existing `after()` (before `pool.end()`), prepend:

```js
  await pool.query("DELETE FROM thumbtack_leads WHERE negotiation_id IN ('tt-relay-proxy-test', 'tt-relay-legacy-test')");
  await pool.query('DELETE FROM clients WHERE id = $1', [ttClientId]);
```

Append these tests at the end of the file:

```js
// ---------------------------------------------------------------------------
// Thumbtack proxy-relay detection (spec 2026-06-11). Run ALONE (shared dev DB).
// ---------------------------------------------------------------------------

test('findThumbtackProxyLead > matches a post-rollout lead by last-10 digits', async () => {
  const r = await findThumbtackProxyLead('+18392750001');
  assert.ok(r, 'expected a match');
  assert.strictEqual(r.clientId, ttClientId);
});

test('findThumbtackProxyLead > ignores pre-rollout leads (real customer numbers)', async () => {
  assert.strictEqual(await findThumbtackProxyLead('+13125550148'), null);
});

test('findThumbtackProxyLead > null for unknown and garbage numbers', async () => {
  assert.strictEqual(await findThumbtackProxyLead('+19998887777'), null);
  assert.strictEqual(await findThumbtackProxyLead(null), null);
});

test('processInboundSms > tags thumbtack relay, links the client, no reply', async () => {
  const result = await processInboundSms({
    from: '+18392750001',
    body: 'Patricia Johnson replied to you on Thumbtack.',
    twilioSid: 'SMtest_relay_1',
  });
  assert.strictEqual(result.outcome, 'thumbtack_relay');
  assert.strictEqual(result.reply, null);
  const row = await pool.query("SELECT client_id, metadata FROM sms_messages WHERE twilio_sid = 'SMtest_relay_1'");
  assert.strictEqual(row.rows[0].client_id, ttClientId);
  assert.strictEqual(row.rows[0].metadata.thumbtack_relay, true);
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_1'");
});

test('processInboundSms > a relayed STOP does not opt the client out', async () => {
  const result = await processInboundSms({ from: '+18392750001', body: 'STOP', twilioSid: 'SMtest_relay_stop' });
  assert.strictEqual(result.outcome, 'thumbtack_relay');
  const r = await pool.query('SELECT communication_preferences FROM clients WHERE id = $1', [ttClientId]);
  assert.notStrictEqual(r.rows[0].communication_preferences?.sms_enabled, false, 'sms_enabled must not be flipped');
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_stop'");
});

test('processInboundSms > a retried relay MessageSid is a duplicate no-op', async () => {
  const first = await processInboundSms({ from: '+18392750001', body: 'echo', twilioSid: 'SMtest_relay_dup' });
  assert.strictEqual(first.outcome, 'thumbtack_relay');
  const second = await processInboundSms({ from: '+18392750001', body: 'echo', twilioSid: 'SMtest_relay_dup' });
  assert.strictEqual(second.outcome, 'duplicate');
  await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_dup'");
});

test('processInboundSms > relay keeps the client link after real-number capture', async () => {
  // Simulate Component 4: the proxy no longer matches clients.phone, so the
  // lead-row fallback must supply the client link.
  await pool.query("UPDATE clients SET phone = '7735550000' WHERE id = $1", [ttClientId]);
  try {
    const result = await processInboundSms({ from: '+18392750001', body: 'echo after capture', twilioSid: 'SMtest_relay_fb' });
    assert.strictEqual(result.outcome, 'thumbtack_relay');
    const row = await pool.query("SELECT client_id FROM sms_messages WHERE twilio_sid = 'SMtest_relay_fb'");
    assert.strictEqual(row.rows[0].client_id, ttClientId);
  } finally {
    await pool.query("UPDATE clients SET phone = '8392750001' WHERE id = $1", [ttClientId]);
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_fb'");
  }
});

test('processInboundSms > detection failure fails open to the normal path', async () => {
  __setDeps({ findThumbtackProxyLead: async () => { throw new Error('boom'); } });
  try {
    const result = await processInboundSms({ from: '+19998880000', body: 'hello?', twilioSid: 'SMtest_relay_open' });
    assert.strictEqual(result.outcome, 'unknown_sender', 'must fall through to todays path');
  } finally {
    __setDeps({ findThumbtackProxyLead });
    await pool.query("DELETE FROM sms_messages WHERE twilio_sid = 'SMtest_relay_open'");
  }
});
```

- [ ] **Step 2.2: Run to confirm the new tests fail**

Run: `node --test server/utils/smsInbound.test.js`
Expected: FAIL — `findThumbtackProxyLead is not a function` (and the rest of the new block). Pre-existing tests still pass.

- [ ] **Step 2.3: Implement detection + the relay branch**

In `server/utils/smsInbound.js`:

(a) After the `last10` function (ends line 65), add:

```js
// ─── Thumbtack proxy-relay detection (spec 2026-06-11) ─────────────────────
// Leads created on or after this date carry a per-lead Thumbtack proxy number
// as customer_phone (rollout completed 2026-06-08). Pre-rollout leads hold the
// customer's REAL number, so they must never match — a real client texting in
// has to keep alerting. Explicit UTC instant; created_at is TIMESTAMPTZ.
const THUMBTACK_PROXY_ROLLOUT = '2026-06-08T00:00:00Z';

/**
 * Match an inbound sender number against post-rollout Thumbtack proxy numbers.
 * Returns the newest matching lead's client link, or null when not relay
 * traffic. Exported for reuse by the public proposal route (phone prefill).
 *
 * @param {string} phone - inbound E.164 number
 * @returns {Promise<{clientId:number|null}|null>}
 */
async function findThumbtackProxyLead(phone) {
  const key = last10(phone);
  if (!key) return null;
  const r = await pool.query(
    `SELECT client_id FROM thumbtack_leads
      WHERE RIGHT(REGEXP_REPLACE(customer_phone, '\\D', '', 'g'), 10) = $1
        AND created_at >= $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [key, THUMBTACK_PROXY_ROLLOUT]
  );
  return r.rows[0] ? { clientId: r.rows[0].client_id } : null;
}

// Test seam (mirrors thumbtack.js): lets the suite prove detection failures
// fail OPEN (message still alerts) without monkeypatching the pool.
let _deps = { findThumbtackProxyLead };
function __setDeps(d) { _deps = { ..._deps, ...d }; }
```

(b) In `processInboundSms`, directly after `const sender = await lookupSender(from);` (line 448) and BEFORE the `detectOptKeyword` block, insert:

```js
  // Thumbtack relay traffic: Thumbtack pings our Twilio number from per-lead
  // proxy numbers ("X replied to you on Thumbtack...", access-code challenges,
  // conversation echoes). Record for audit, tagged, with NO alerts — Thumbtack
  // already notifies the admin directly (app push, SMS to the GV line, email).
  // Fail OPEN: a detection error must never silence a real client, so any
  // throw falls through to the normal alerting paths below.
  let proxyLead = null;
  try {
    proxyLead = await _deps.findThumbtackProxyLead(from);
  } catch (detectErr) {
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureException(detectErr, { tags: { feature: 'sms-inbound', step: 'thumbtack_relay_detect' } });
    }
    console.error('[smsInbound] thumbtack relay detection failed (failing open):', detectErr.message);
  }
  if (proxyLead) {
    // Client link: prefer the live clients.phone match; after real-number
    // capture the proxy no longer matches a client row, so fall back to the
    // lead's client_id. Skipped: STOP/START (opt semantics do not transfer
    // from a proxy), all alerts, all auto-replies.
    const relayClientId = sender.type === 'client' ? sender.client.id : (proxyLead.clientId || null);
    const recorded = await recordInboundMessage({
      fromPhone: from,
      body: text,
      clientId: relayClientId,
      twilioSid,
      metadata: { thumbtack_relay: true },
    });
    if (!recorded) return { outcome: 'duplicate', reply: null };
    console.log(`[smsInbound] thumbtack_relay suppressed (sender ...${(last10(from) || '').slice(-4)}, client ${relayClientId || 'none'})`);
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.addBreadcrumb({
        category: 'sms-inbound',
        message: 'thumbtack_relay suppressed',
        level: 'info',
        data: { clientId: relayClientId },
      });
    }
    return { outcome: 'thumbtack_relay', reply: null };
  }
```

(c) Extend `module.exports` (line 544-560) with the three new names:

```js
  findThumbtackProxyLead,
  __setDeps,
```
(`processInboundSms` is already exported.)

- [ ] **Step 2.4: Run the suite — all pass**

Run: `node --test server/utils/smsInbound.test.js`
Expected: PASS (pre-existing + 8 new). The fail-open test logs a `[smsInbound] thumbtack relay detection failed` line and an `unknown number` admin-email skip line — expected console noise, not failures.

- [ ] **Step 2.5: Commit**

```powershell
git add server/utils/smsInbound.js server/utils/smsInbound.test.js
git commit -m "feat(sms): tag and suppress Thumbtack proxy-relay traffic in the inbound webhook"
```

---

### Task 3: Drop the Thumbtack message webhook email

**Files:**
- Modify: `server/routes/thumbtack.js`
- Modify: `server/utils/emailTemplates.js`
- Modify: `server/routes/thumbtack.test.js`

- [ ] **Step 3.1: Add a failing webhook test (message persists, 200s — no email path left to break it)**

In `server/routes/thumbtack.test.js`, add after the `postLead` helper (line 68):

```js
function postMessage(messageId, negotiationId) {
  const body = JSON.stringify({
    event: { eventType: 'MessageCreatedV4' },
    data: {
      messageID: messageId,
      negotiationID: negotiationId,
      from: 'Customer',
      text: 'relay-removal harness message',
      sentAt: new Date().toISOString(),
      customer: { displayName: 'Harness Customer' },
    },
  });
  const headers = { 'Content-Type': 'application/json' };
  if (secret) headers['x-thumbtack-secret'] = secret;
  return httpReq('POST', '/api/thumbtack/messages', headers, body);
}
```

Add this test at the end of the file (before any final cleanup `after()` if present; otherwise at the end), plus cleanup of the message row:

```js
test('POST /messages persists the message and 200s with no admin email block', async () => {
  const msgId = `test-msg-${Date.now()}`;
  const res = await postMessage(msgId, 'test-msg-negotiation');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  const row = await pool.query('SELECT text, from_type FROM thumbtack_messages WHERE message_id = $1', [msgId]);
  assert.equal(row.rows.length, 1);
  assert.equal(row.rows[0].from_type, 'Customer');
  await pool.query('DELETE FROM thumbtack_messages WHERE message_id = $1', [msgId]);
});
```

- [ ] **Step 3.2: Run it — passes already (the email block is best-effort), establishing the safety net**

Run: `node --test server/routes/thumbtack.test.js`
Expected: PASS. This test pins the persist+200 contract through the removal.

- [ ] **Step 3.3: Remove the notification block and the dead template**

In `server/routes/thumbtack.js`:
- Line 6: change the destructured import to drop the middle name:
```js
const { newThumbtackLeadAdmin, newThumbtackReviewAdmin } = require('../utils/emailTemplates');
```
- In `POST /messages`, delete the entire customer-message notification block, lines 372-403: from the comment `// Notify admin of customer messages (non-blocking)` and `if (msg.fromType === 'Customer' || !msg.fromType) {` through its closing `}` (the block containing the `thumbtack_leads` lookup, `newThumbtackMessageAdmin`, `notifyAdminCategory`, and the `emailErr` catch). The webhook keeps: parse, upsert, duplicate return, `res.status(200).json({ status: 'ok' })`, and the outer error handling.

In `server/utils/emailTemplates.js`:
- Delete the `newThumbtackMessageAdmin` function (lines 643-658).
- Delete the `newThumbtackMessageAdmin,` line from `module.exports` (line 950).

- [ ] **Step 3.4: Verify no references remain and the suite passes**

Run: `git grep -n "newThumbtackMessageAdmin" -- server` → Expected: no matches.
Run: `node --test server/routes/thumbtack.test.js` → Expected: PASS (including the new message test).

- [ ] **Step 3.5: Commit**

```powershell
git add server/routes/thumbtack.js server/utils/emailTemplates.js server/routes/thumbtack.test.js
git commit -m "feat(thumbtack): stop emailing per customer message; webhook still persists every message"
```

---

### Task 4: Exclude relay rows from the admin Messages endpoints

**Files:**
- Modify: `server/routes/sms.js:99-123`

- [ ] **Step 4.1: Apply the exclusion predicate in all four places**

In `server/routes/sms.js`, replace the `GET /conversations` query (lines 100-109) with:

```js
  const result = await pool.query(`
    SELECT c.id AS client_id, c.name, c.phone,
      (SELECT COUNT(*) FROM sms_messages m
        WHERE m.client_id = c.id AND m.direction = 'inbound' AND m.read_at IS NULL
          AND (m.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true')::int AS unread_count,
      (SELECT MAX(m2.created_at) FROM sms_messages m2 WHERE m2.client_id = c.id
          AND (m2.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true') AS last_message_at
    FROM clients c
    WHERE EXISTS (SELECT 1 FROM sms_messages m3 WHERE m3.client_id = c.id
          AND (m3.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true')
    ORDER BY last_message_at DESC
    LIMIT 200
  `);
```

And the thread query (lines 117-121) with:

```js
  const result = await pool.query(
    `SELECT id, direction, body, status, twilio_sid, read_at, created_at
     FROM sms_messages
     WHERE client_id = $1
       AND (metadata->>'thumbtack_relay') IS DISTINCT FROM 'true'
     ORDER BY created_at ASC LIMIT 500`,
    [clientId]
  );
```

(`IS DISTINCT FROM 'true'` keeps legacy NULL-metadata rows visible. The `PUT /read` endpoint is left alone: marking an invisible relay row read is harmless, and the unread count already excludes them. No index — the table is a few hundred rows; a partial index is the deliberate future fix per the spec.)

- [ ] **Step 4.2: Verify against the dev DB**

Run with the Bash tool (bash quoting; from the worktree root):
```powershell
node -e "require('dotenv').config(); const {pool}=require('./server/db'); (async()=>{ const r=await pool.query(\"SELECT 1 FROM sms_messages WHERE (metadata->>'thumbtack_relay') IS DISTINCT FROM 'true' LIMIT 1\"); console.log('predicate ok, rows:', r.rowCount); await pool.end(); })()"
```
Expected: `predicate ok, rows: 1` (or `0` on an empty dev table) — proves the SQL parses against the real schema.

- [ ] **Step 4.3: Commit**

```powershell
git add server/routes/sms.js
git commit -m "feat(sms): exclude thumbtack relay rows from Messages list, unread counts, and threads"
```

---

### Task 5: Server side of optional phone capture at sign-and-pay

**Files:**
- Modify: `server/routes/proposals/publicToken.js`
- Create: `server/routes/proposals/publicToken.signPhone.test.js`

- [ ] **Step 5.1: Write the failing route tests**

Create `server/routes/proposals/publicToken.signPhone.test.js` (harness mirrors `thumbtack.test.js`; run ALONE — shared dev DB):

```js
// Route tests for the optional client_phone capture on the public sign POST and
// the client_phone_prefill field on the public GET (spec 2026-06-11 Component 4).
// Mounts the real router on a throwaway express app; runs against the dev DB;
// cleans every row it creates. Run ALONE (shared dev DB).
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const crypto = require('node:crypto');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicTokenRouter = require('./publicToken');
const { KNOWN_AGREEMENT_VERSIONS } = require('../../utils/agreementVersions');

let server, baseUrl, clientId, proposalId;
const token = crypto.randomUUID();
const DOC_VERSION = KNOWN_AGREEMENT_VERSIONS[KNOWN_AGREEMENT_VERSIONS.length - 1];
const NEG_ID = 'sign-phone-lead-test';

function httpReq(method, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + path, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function signBody(overrides = {}) {
  return JSON.stringify({
    client_signed_name: 'Sign Phone Client',
    client_signature_data: 'data:image/png;base64,AAAA',
    client_signature_method: 'type',
    document_version: DOC_VERSION,
    venue_street: '1 Test St', venue_city: 'Chicago', venue_state: 'IL',
    ...overrides,
  });
}

before(async () => {
  await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [NEG_ID]);
  await pool.query("DELETE FROM clients WHERE email = 'sign-phone-test@example.com'");
  // phone_status 'bad' on purpose: a successful capture must reset it to 'ok'.
  const c = await pool.query(
    `INSERT INTO clients (name, email, phone, phone_status, source)
     VALUES ('Sign Phone Client', 'sign-phone-test@example.com', '8392750009', 'bad', 'thumbtack') RETURNING id`
  );
  clientId = c.rows[0].id;
  await pool.query(
    `INSERT INTO thumbtack_leads (negotiation_id, client_id, customer_phone, customer_name)
     VALUES ($1, $2, '8392750009', 'Sign Phone Client')`,
    [NEG_ID, clientId]
  );
  const p = await pool.query(
    `INSERT INTO proposals (client_id, token, status, total_price) VALUES ($1, $2, 'sent', 500) RETURNING id`,
    [clientId, token]
  );
  proposalId = p.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicTokenRouter);
  app.use((err, req, res, _next) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ error: err.message });
  });
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(async () => {
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM thumbtack_leads WHERE negotiation_id = $1', [NEG_ID]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('GET /t/:token blanks a thumbtack proxy phone in client_phone_prefill, leaks no raw fields', async () => {
  const res = await httpReq('GET', `/api/proposals/t/${token}`);
  assert.equal(res.status, 200);
  assert.strictEqual(res.body.client_phone_prefill, '');
  assert.ok(!('client_phone_raw' in res.body), 'raw phone must not leak');
  assert.ok(!('client_source' in res.body), 'source must not leak');
});

test('invalid client_phone -> 400, signature NOT recorded, phone untouched', async () => {
  const res = await httpReq('POST', `/api/proposals/t/${token}/sign`, signBody({ client_phone: '123' }));
  assert.equal(res.status, 400);
  const p = await pool.query('SELECT client_signed_at FROM proposals WHERE id = $1', [proposalId]);
  assert.strictEqual(p.rows[0].client_signed_at, null);
  const c = await pool.query('SELECT phone FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(c.rows[0].phone, '8392750009');
});

test('valid client_phone on a successful sign updates phone, resets phone_status, logs phone_updated', async () => {
  const res = await httpReq('POST', `/api/proposals/t/${token}/sign`, signBody({ client_phone: '(773) 555-0042' }));
  assert.equal(res.status, 200);
  const c = await pool.query('SELECT phone, phone_status FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(c.rows[0].phone, '7735550042');
  assert.strictEqual(c.rows[0].phone_status, 'ok');
  const log = await pool.query(
    `SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'signed' ORDER BY id DESC LIMIT 1`,
    [proposalId]
  );
  assert.strictEqual(log.rows[0].details.phone_updated, true);
});

test('a replayed sign (ALREADY_ACCEPTED) performs no phone write', async () => {
  const res = await httpReq('POST', `/api/proposals/t/${token}/sign`, signBody({ client_phone: '(312) 555-9999' }));
  assert.equal(res.status, 409);
  const c = await pool.query('SELECT phone FROM clients WHERE id = $1', [clientId]);
  assert.strictEqual(c.rows[0].phone, '7735550042', 'replay must not mutate the phone');
});
```

- [ ] **Step 5.2: Run to confirm the new tests fail**

Run: `node --test server/routes/proposals/publicToken.signPhone.test.js`
Expected: the GET test fails (`client_phone_prefill` is `undefined`); the valid-phone test fails (phone still `8392750009`). The invalid-phone test fails too (400 expected, 200 returned — no validation yet; note the sign succeeds, so if you rerun, the suite's `before()` cleanup resets state).

- [ ] **Step 5.3: Implement the GET prefill**

In `server/routes/proposals/publicToken.js`:

(a) Add to the requires (after line 13):
```js
const { findThumbtackProxyLead } = require('../../utils/smsInbound');
const { validatePhone } = require('../../utils/phone');
```

(b) In the GET `/t/:token` SELECT (line 58), extend the client columns:
```sql
      c.name AS client_name, c.email AS client_email,
      c.phone AS client_phone_raw, c.source AS client_source
```

(c) Before the `res.json({...})` (line 111), compute the prefill and strip the internal fields:

```js
  // Optional-phone prefill (spec 2026-06-11 Component 4). A Thumbtack proxy
  // number must never show in the signing form: blank it so the client is
  // invited to provide a real one. The proxy lookup runs only for
  // thumbtack-sourced clients (a proxy can only live on a row clientDedup
  // created with source 'thumbtack'), keeping the extra query off the common
  // public-page path. Fail closed to blank: never show a proxy.
  let clientPhonePrefill = proposal.client_phone_raw || '';
  if (clientPhonePrefill && proposal.client_source === 'thumbtack') {
    try {
      if (await findThumbtackProxyLead(clientPhonePrefill)) clientPhonePrefill = '';
    } catch (err) {
      console.error('[proposals/public] proxy prefill check failed (blanking):', err.message);
      clientPhonePrefill = '';
    }
  }
  // Strip the internal lookup fields (delete-on-copy, not rest-destructure,
  // so eslint's no-unused-vars stays quiet).
  const publicProposal = { ...proposal };
  delete publicProposal.client_phone_raw;
  delete publicProposal.client_source;
```

(d) Change the response spread from `...proposal` to `...publicProposal` and add the field:

```js
  res.json({
    ...publicProposal,
    client_phone_prefill: clientPhonePrefill,
    addons: addonsRes.rows,
```
(rest of the response object unchanged; note `status:` is re-derived below the spread exactly as today).

- [ ] **Step 5.4: Implement the sign-POST capture**

Still in `publicToken.js`, inside `POST /t/:token/sign`:

(a) Validation, with the other field validations. After line 131 (`if (!client_signature_data) ...`), add:

```js
  // Optional real-number capture (spec 2026-06-11 Component 4). validatePhone
  // is the save-time helper (10-digit storage), NOT sms.js#normalizePhone
  // (send-time E.164). Empty input is valid and never overwrites.
  const phoneCheck = validatePhone(req.body.client_phone);
  if (phoneCheck.error) fieldErrors.client_phone = phoneCheck.error;
```

(b) The gated, best-effort write. After the activity-log INSERT's preceding sign UPDATE succeeds — concretely, replace the existing activity-log INSERT (lines 238-241) with:

```js
  // Phone write is gated on the sign UPDATE having returned a row (the
  // client_signed_at IS NULL TOCTOU gate above): a replayed sign POST that hit
  // ALREADY_ACCEPTED never reaches this point, so a leaked token cannot mutate
  // the phone after acceptance. Best-effort: a phone-write failure must never
  // 500 a successful signature. phone_status resets with the new number — a
  // 'bad' verdict earned by the old proxy must not mute the fresh real number
  // (channelFallback suppresses all automated SMS on phone_status = 'bad').
  let phoneUpdated = false;
  if (phoneCheck.value) {
    try {
      const pu = await pool.query(
        `UPDATE clients SET phone = $1, phone_status = 'ok'
          WHERE id = (SELECT client_id FROM proposals WHERE id = $2)
            AND phone IS DISTINCT FROM $1`,
        [phoneCheck.value, proposal.id]
      );
      phoneUpdated = pu.rowCount > 0;
    } catch (phoneErr) {
      if (process.env.SENTRY_DSN_SERVER) {
        Sentry.captureException(phoneErr, { tags: { route: 'proposals/sign', issue: 'phone_capture' } });
      }
      console.error('Sign-time phone capture failed (non-blocking):', phoneErr.message);
    }
  }

  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details) VALUES ($1, 'signed', 'client', $2)`,
    [proposal.id, JSON.stringify({ signed_name: client_signed_name, signature_method: client_signature_method, phone_updated: phoneUpdated })]
  );
```

- [ ] **Step 5.5: Run the suite — all pass**

Run: `node --test server/routes/proposals/publicToken.signPhone.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5.6: Regression-check the existing route harness**

Run: `node --test server/routes/thumbtack.test.js`
Expected: PASS — this suite also exercises `publicToken.js` (the admin_notes leak test hits GET `/t/:token`), so it proves the response-shape change didn't break the existing contract.

- [ ] **Step 5.7: Commit the server half** (held until Task 6 completes if you prefer one feature commit; otherwise commit now and amend nothing later — Task 6 is the same logical feature, so the default is: do NOT commit yet, proceed to Task 6.)

---

### Task 6: Client side of phone capture (signing form)

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js`
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js`

- [ ] **Step 6.1: Add state, seeding, and the POST field in `ProposalView.js`**

(a) Below the venue state (line 36), add:

```js
  const [clientPhone, setClientPhone] = useState('');
  const phoneSeeded = useRef(false);
```

(b) After the venue-seed effect (ends line 114), add:

```js
  // Seed the optional phone field from the server prefill (once). The server
  // sends '' for Thumbtack proxy numbers so a proxy is never shown.
  useEffect(() => {
    if (proposal && !phoneSeeded.current) {
      phoneSeeded.current = true;
      setClientPhone(proposal.client_phone_prefill || '');
    }
  }, [proposal]);
```

(c) In `handleSign`'s POST body (after `document_version:` line 290), add:

```js
        client_phone: clientPhone.trim() || null,
```

(d) In the `signAndPay`-mode `<SignAndPaySection ... />` props (after `setSigMethod={setSigMethod}` line 470), add:

```js
                clientPhone={clientPhone}
                setClientPhone={setClientPhone}
```

- [ ] **Step 6.2: Render the input in `SignAndPaySection.js`**

(a) Add the props to the destructure (after `setSigMethod,` line 64):

```js
  clientPhone = '',
  setClientPhone = () => {},
```

(b) Insert the field between the Full Legal Name block (ends line 172) and the Signature block (starts line 174):

```jsx
        {/* Optional contact number (real-number capture for Thumbtack leads) */}
        <div>
          <label className="sign-pay-eyebrow" htmlFor="sig-phone">
            Best phone number for event-day updates (optional)
          </label>
          <input
            id="sig-phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            className="sign-pay-input"
            value={clientPhone}
            onChange={(e) => {
              setClientPhone(e.target.value);
              setFieldErrors((fe) => {
                if (!fe.client_phone) return fe;
                const next = { ...fe };
                delete next.client_phone;
                return next;
              });
            }}
            placeholder="(312) 555-0148"
          />
          {fieldErrors?.client_phone && (
            <p style={{ color: 'var(--rust)', fontSize: '0.875rem' }} role="alert">
              {fieldErrors.client_phone}
            </p>
          )}
        </div>
```

(Server is the validator of record; a `fieldErrors.client_phone` from the sign POST renders under the input via the existing `setFieldErrors` plumbing in `handleSign`'s catch. The field is optional, so `payNeeds` is deliberately untouched.)

- [ ] **Step 6.3: Client build gate** (local eslint skips `client/`; Vercel CI is the enforcer — catch it here instead)

Stop any running dev server first (shared `node_modules` junction allows one build at a time). Then:

Run: `cd client` then `CI=true npm run build` (Bash tool syntax: `cd client && CI=true npm run build`)
Expected: `Compiled successfully.` — warnings are failures under CI=true.

- [ ] **Step 6.4: Commit the whole phone-capture feature (server + client)**

```powershell
git add server/routes/proposals/publicToken.js server/routes/proposals/publicToken.signPhone.test.js client/src/pages/proposal/proposalView/ProposalView.js client/src/pages/proposal/proposalView/SignAndPaySection.js
git commit -m "feat(proposals): optional real phone capture at sign-and-pay; proxy numbers never prefill"
```

---

### Task 7: Docs + final verification

**Files:**
- Modify: `README.md` (folder tree)
- Modify: `ARCHITECTURE.md` (Thumbtack integration / notification notes)

- [ ] **Step 7.1: README folder tree**

Locate the `server/utils/` block in README.md's folder structure (Grep: `smsTemplates.js` in `README.md`) and add, alphabetically:

```
│   ├── smsEventDate.js          # Shared SMS event-date formatter (Date|string -> "June 12" | null)
```

- [ ] **Step 7.2: ARCHITECTURE Thumbtack + notification notes**

Locate the Thumbtack integration section (Grep: `Thumbtack` in `ARCHITECTURE.md`) and update it to reflect:

- `POST /api/thumbtack/messages` persists every message but no longer emails admins (Thumbtack notifies directly; rollout of per-lead proxy numbers means Thumbtack pushes app + SMS + email itself).
- Inbound SMS from a post-rollout `thumbtack_leads.customer_phone` proxy is recorded in `sms_messages` tagged `metadata.thumbtack_relay = true`, fires no admin alerts, and is excluded from the admin Messages endpoints.
- The public sign-and-pay form captures an optional real phone number; a valid submission overwrites a Thumbtack proxy on `clients.phone` and resets `phone_status` to `'ok'`.

Wording is free-form to match the surrounding doc style; the three facts above must all land.

- [ ] **Step 7.3: Full per-suite verification run** (one at a time, shared dev DB)

```powershell
node --test server/utils/smsEventDate.test.js
node --test server/utils/smsTemplates.test.js
node --test server/utils/smsInbound.test.js
node --test server/routes/thumbtack.test.js
node --test server/routes/proposals/publicToken.signPhone.test.js
```
Expected: all PASS.

- [ ] **Step 7.4: Commit docs**

```powershell
git add README.md ARCHITECTURE.md
git commit -m "docs: thumbtack relay suppression, message-email removal, sign-time phone capture"
```

---

## Post-merge verification (manual, in prod after deploy)

Proxy traffic cannot be reproduced locally (only Thumbtack can text from a proxy number). After the merge ships:

1. Watch the next Thumbtack client reply: expect a `sms_messages` row with `metadata.thumbtack_relay = true`, NO `urgent_client_reply` email/SMS, NO `routine_thumbtack` message email, and the `[smsInbound] thumbtack_relay suppressed` log line in Render.
2. Admin Messages page: relay boilerplate ("X replied to you on Thumbtack...", access-code challenges) no longer appears in client threads; pre-2026-06-12 untagged rows still show (accepted).
3. Next Thumbtack booking that signs: if the client filled the phone field, their client record shows the real number with `phone_status = 'ok'`, and subsequent automated texts go direct.
4. Next `sign_pay_confirmation` / drip SMS: real dates render ("You're booked for June 12!"), no "Invalid Date", no "on your event".
