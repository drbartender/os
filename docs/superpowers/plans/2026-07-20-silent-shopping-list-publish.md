# Silent Shopping List Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin re-publish an edited shopping list to the client's live link without emailing them, so editing while on the phone stops pinging the client.

**Architecture:** Add an opt-in `silent: true` flag to `POST /api/comms/send` that applies the approve side effects with zero channels and sends nothing. Only the `shopping_list_approve` action opts in. The client gets a second footer button that reuses the existing `approveStatus='approved'` state (so the repeat-edit loop keeps working) plus a `lastPublishSilent` flag so the label never falsely claims an email was sent.

**Tech Stack:** Node.js 26 / Express 4, React 18 (CRA), Postgres (raw SQL via `pg`), `node:test` for server tests.

**Spec:** `docs/superpowers/specs/2026-07-20-silent-shopping-list-publish-design.md`

## Global Constraints

- Money/side-effect ordering is load-bearing: **all `silent` validation must run BEFORE `action.ensureSideEffects`** (`server/routes/comms.js:97`). A `silent` rejection that ran after it would flip `invoices.status` draft→sent then 400.
- Parse `silent` strictly: `body.silent === true` (identity, never truthiness).
- Wire keys are snake_case: the request body uses `entity_id`, not `entityId`.
- Client API calls go through `client/src/utils/api.js` (never raw fetch/axios).
- Client-visible server errors throw `ValidationError`/`AppError` subclasses, never `res.status(400).json(...)`.
- No new DB column, no schema migration, no new comms action, no new env var.
- Server test suites run one at a time against the shared dev DB: `node -r dotenv/config --test <file>`.
- Verify client changes with `CI=true npx react-scripts build` from `client/` (the Vercel CI lint gate); there is no client unit-test runner in this repo.

## Lane map

```yaml
lanes:
  - id: silent-shopping-list-publish
    footprint:
      - server/routes/comms.js
      - server/utils/comms/registry.js
      - server/utils/comms/actions/shoppingListApprove.js
      - server/routes/comms.silent.test.js
      - server/routes/drinkPlans/shoppingList.js
      - client/src/components/ShoppingList/ShoppingListButton.jsx
      - client/src/components/ShoppingList/ShoppingListModal.jsx
      - ARCHITECTURE.md
    depends_on: []
    review_fleet: [security-review, database-review, code-review, consistency-check]
```

Single lane. `comms.js` / the send path is money-adjacent (the invoice-flip guard lives on the same endpoint), so it draws the full fleet at review.

---

## Task 1: Server — `silent` flag on `POST /api/comms/send` + `allowSilent` opt-in

**Files:**
- Modify: `server/utils/comms/actions/shoppingListApprove.js` (export `allowSilent: true`)
- Modify: `server/utils/comms/registry.js:1-21` (document `allowSilent` in the contract comment)
- Modify: `server/routes/comms.js:59-97` (the `silent` block, before `ensureSideEffects`)
- Test: `server/routes/comms.silent.test.js` (new, route-level HTTP harness)

**Interfaces:**
- Consumes: existing `getAction(key)`, `action.ensureSideEffects(entityId)`, `action.dispatch(...)`, `action.resolveRecipient(entityId)`.
- Produces: request contract `POST /api/comms/send { action, entity_id, channels: [], silent: true }` → applies side effects, sends nothing, returns the normal `{ ok, results }` send response. New action property `allowSilent: boolean` (absent = falsy on every other action).

- [ ] **Step 1: Write the failing test file**

Create `server/routes/comms.silent.test.js`. This mirrors the hand-rolled route harness in `server/routes/beo.test.js` (no supertest in this repo), extended with a JSON request body:

```javascript
'use strict';

// Route-level tests for the `silent` publish flag on POST /api/comms/send.
// Mirrors the express()+node:http harness in server/routes/beo.test.js.
// Runs ALONE against the shared dev DB: node -r dotenv/config --test.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const commsRouter = require('./comms');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const CLIENT_EMAIL = `silent-pub-${NONCE}@example.test`;
let server, baseUrl, adminToken;
let clientId, proposalId, planId, invoiceId;

function request(method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  const passwordHash = await bcrypt.hash('x', 4);
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ($1, $2, 'admin', 'approved', 0) RETURNING id, token_version`,
    [`silent-pub-admin-${NONCE}@example.com`, passwordHash]
  );
  adminToken = jwt.sign(
    { userId: admin.rows[0].id, tokenVersion: admin.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  const c = await pool.query(
    `INSERT INTO clients (name, email, phone) VALUES ('Silent Pub', $1, '3125550188') RETURNING id`,
    [CLIENT_EMAIL]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO proposals (client_id, event_date, status, event_type, total_price, amount_paid, balance_due_date, autopay_enrolled)
     VALUES ($1, CURRENT_DATE + INTERVAL '21 days', 'balance_paid', 'wedding-reception', 200000, 200000, CURRENT_DATE + INTERVAL '7 days', false)
     RETURNING id`,
    [clientId]
  );
  proposalId = p.rows[0].id;
  // Plan in pending_review with a real list AND a valid client email, so the
  // email channel is genuinely "available" (needed by the guard test).
  const dp = await pool.query(
    `INSERT INTO drink_plans (client_name, client_email, event_type, event_date, proposal_id, shopping_list, shopping_list_status)
     VALUES ('Silent Pub', $1, 'wedding-reception', CURRENT_DATE + INTERVAL '21 days', $2,
             '{"guestCount": 50, "liquorBeerWine": [], "everythingElse": []}'::jsonb, 'pending_review')
     RETURNING id`,
    [CLIENT_EMAIL, proposalId]
  );
  planId = dp.rows[0].id;
  // A DRAFT invoice for the ordering guard (invoice_send does NOT opt into silent).
  const inv = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status)
     VALUES ($1, $2, 'Balance', 6000, 0, 'draft') RETURNING id`,
    [proposalId, `SILENT-${NONCE}`]
  );
  invoiceId = inv.rows[0].id;

  const app = express();
  app.use(express.json());
  app.use('/api/comms', commsRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  await pool.query('DELETE FROM message_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]);
  await pool.query('DELETE FROM drink_plans WHERE id = $1', [planId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.query('DELETE FROM users WHERE email = $1', [`silent-pub-admin-${NONCE}@example.com`]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('silent publish flips pending_review -> approved and sends nothing', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'shopping_list_approve', entity_id: planId, channels: [], silent: true },
  });
  assert.strictEqual(res.status, 200);
  const row = (await pool.query(
    'SELECT shopping_list_status, shopping_list_approved_at FROM drink_plans WHERE id = $1', [planId]
  )).rows[0];
  assert.strictEqual(row.shopping_list_status, 'approved');
  assert.notStrictEqual(row.shopping_list_approved_at, null);
  const logged = (await pool.query(
    'SELECT COUNT(*)::int AS n FROM message_log WHERE proposal_id = $1', [proposalId]
  )).rows[0].n;
  assert.strictEqual(logged, 0); // nothing sent, nothing ledgered
});

test('silent rejected for an action without allowSilent, and the invoice stays draft', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'invoice_send', entity_id: invoiceId, channels: [], silent: true },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.silent);
  const status = (await pool.query('SELECT status FROM invoices WHERE id = $1', [invoiceId])).rows[0].status;
  assert.strictEqual(status, 'draft'); // ensureSideEffects never ran
});

test('silent + non-empty channels is rejected', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'shopping_list_approve', entity_id: planId, channels: ['email'], silent: true },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.channels);
});

test('silent + retry is rejected', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'shopping_list_approve', entity_id: planId, channels: [], silent: true, retry: true },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.retry);
});

test('non-silent empty channels still rejected when a channel is available', async () => {
  const res = await request('POST', '/api/comms/send', {
    token: adminToken,
    body: { action: 'shopping_list_approve', entity_id: planId, channels: [] },
  });
  assert.strictEqual(res.status, 400);
  assert.ok(res.body.fieldErrors && res.body.fieldErrors.channels);
});
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `cd server && node -r dotenv/config --test routes/comms.silent.test.js`
Expected: FAIL. Test 1 gets a 400 ("Select at least one channel.") instead of 200 because `silent` is not yet handled; the rejection tests may pass or fail for the wrong reason. This confirms the harness runs and the feature is absent.

- [ ] **Step 3: Add `allowSilent: true` to the shopping-list approve action**

In `server/utils/comms/actions/shoppingListApprove.js`, the export block (currently `shoppingListApprove.js:250-253`):

```javascript
module.exports = {
  key, messageType, defaultChannels, allowSilent: true,
  resolveRecipient, buildMessages, ensureSideEffects, dispatch,
};
```

- [ ] **Step 4: Document `allowSilent` in the registry contract comment**

In `server/utils/comms/registry.js`, inside the action-contract comment (after the `dispatchWithoutSideEffects` line, around `registry.js:19-21`), add:

```javascript
//   allowSilent   optional boolean: true lets POST /api/comms/send accept
//                 { silent: true, channels: [] } for this action — apply side
//                 effects, send nothing. Absent/false: silent is rejected.
```

- [ ] **Step 5: Add the `silent` block in the route, before `ensureSideEffects`**

In `server/routes/comms.js`, insert immediately after the channel parse at line 63 (`const channels = ...`) and BEFORE the existing empty-channel guard at line 64. The block both validates `silent` and, when valid, skips the empty-channel availability guard:

```javascript
  const channels = Array.isArray(body.channels) ? body.channels.filter((c) => ['email', 'sms'].includes(c)) : [];
  const silent = body.silent === true;
  if (silent) {
    // Silent publish: apply side effects, send nothing. Validated HERE, before
    // ensureSideEffects (below), so a rejected silent request can never flip a
    // money side effect (e.g. invoice draft->sent) and then 400.
    if (!action.allowSilent) {
      throw new ValidationError({ silent: 'This action cannot be published without sending.' });
    }
    if (channels.length > 0) {
      throw new ValidationError({ channels: 'A silent publish cannot select channels.' });
    }
    if (body.retry === true) {
      throw new ValidationError({ retry: 'A silent publish cannot be a retry.' });
    }
  } else if (channels.length === 0) {
    // Side-effects-only confirm (spec 4.6, hosted approve): an empty channel
    // list is legal ONLY when the action genuinely has no channel to offer.
    // When a channel IS available, an empty selection is an accidental no-op
    // and gets rejected.
    const availability = await action.resolveRecipient(entityId);
    if (availability.channels.email.available || availability.channels.sms.available) {
      throw new ValidationError({ channels: 'Select at least one channel.' });
    }
  }
```

Note: this replaces the old `if (channels.length === 0) {` line with `} else if (channels.length === 0) {` chained onto the new `if (silent)`. The email/sms channel-content validation below it (lines 74-94) is unchanged and is naturally skipped because `channels` is empty on a silent publish.

- [ ] **Step 6: Run the test file to verify it passes**

Run: `cd server && node -r dotenv/config --test routes/comms.silent.test.js`
Expected: PASS, all 5 tests. (Notifications are gated off in dev, so no real email fires regardless.)

- [ ] **Step 7: Commit**

```bash
git add server/routes/comms.js server/utils/comms/registry.js server/utils/comms/actions/shoppingListApprove.js server/routes/comms.silent.test.js
git commit -m "feat(comms): silent publish flag on /send, opt-in per action

Shopping-list approve can now run side effects with zero channels and
send nothing. Validated before ensureSideEffects so a rejected silent
request never flips a money side effect."
```

---

## Task 2: Server — expose `ever_approved` on the admin shopping-list GET

**Files:**
- Modify: `server/routes/drinkPlans/shoppingList.js:80-91` (GET handler)
- Test: `server/routes/comms.silent.test.js` (add one case; the harness already loads a plan)

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/drink-plans/:id/shopping-list` response gains `ever_approved: boolean` (`shopping_list_approved_snapshot IS NOT NULL`). This is the durable "has the client ever seen this list" signal (the PUT nulls `approved_at` on edit but never clears the snapshot). Task 3's `ShoppingListButton` reads it.

- [ ] **Step 1: Write the failing test**

Add to `server/routes/comms.silent.test.js`. Because Task 1's first test approves `planId`, its snapshot is now set — assert the GET reports it. Mount the drink-plans router in the harness. At the top with the other requires, add:

```javascript
const drinkPlansRouter = require('./drinkPlans');
```

In the `before()` app setup, add the mount alongside the comms mount:

```javascript
  app.use('/api/drink-plans', drinkPlansRouter);
```

Add this test AFTER the "silent publish flips ... approved" test (order matters — it relies on `planId` being approved, which sets the snapshot):

```javascript
test('GET shopping-list reports ever_approved once a snapshot exists', async () => {
  const res = await request('GET', `/api/drink-plans/${planId}/shopping-list`, { token: adminToken });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.ever_approved, true);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && node -r dotenv/config --test routes/comms.silent.test.js`
Expected: FAIL — `res.body.ever_approved` is `undefined` (field not yet returned).

- [ ] **Step 3: Add the field to the GET**

In `server/routes/drinkPlans/shoppingList.js`, the GET handler (lines 80-91). Update the SELECT and the response:

```javascript
  router.get('/:id/shopping-list', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT shopping_list, shopping_list_status, shopping_list_approved_at,
              shopping_list_approved_snapshot IS NOT NULL AS ever_approved
         FROM drink_plans WHERE id = $1`,
      [req.params.id]
    );
    if (!result.rows[0]) throw new NotFoundError('Plan not found.');
    res.json({
      shopping_list: result.rows[0].shopping_list || null,
      shopping_list_status: result.rows[0].shopping_list_status || null,
      shopping_list_approved_at: result.rows[0].shopping_list_approved_at || null,
      ever_approved: result.rows[0].ever_approved === true,
    });
  }));
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && node -r dotenv/config --test routes/comms.silent.test.js`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/routes/drinkPlans/shoppingList.js server/routes/comms.silent.test.js
git commit -m "feat(drink-plans): expose ever_approved on admin shopping-list GET

Durable 'client has seen this list' signal from the approved snapshot,
which survives the edit-reverts-to-pending PUT. Drives the client-side
quiet-publish confirmation."
```

---

## Task 3: Client — quiet-publish footer button + honest state

**Files:**
- Modify: `client/src/components/ShoppingList/ShoppingListButton.jsx:34-40, 138-145` (read + pass `ever_approved`)
- Modify: `client/src/components/ShoppingList/ShoppingListModal.jsx` (prop, state, handler, button, label, footer note)

**Interfaces:**
- Consumes: `GET /api/drink-plans/:id/shopping-list` `ever_approved` (Task 2); `POST /api/comms/send { action:'shopping_list_approve', entity_id, channels:[], silent:true }` (Task 1).
- Produces: no downstream consumer (leaf UI).

- [ ] **Step 1: Pass `initialEverApproved` from the button**

In `client/src/components/ShoppingList/ShoppingListButton.jsx`, add state near `initialApproveStatus` (line 28):

```javascript
  const [initialEverApproved, setInitialEverApproved] = useState(false);
```

In `handleClick`, right after the `setInitialApproveStatus(...)` line (40):

```javascript
      setInitialEverApproved(savedRes.data.ever_approved === true);
```

In the `<ShoppingListModal .../>` render (lines 138-145), add the prop:

```javascript
          <ShoppingListModal
            listData={modalData}
            onClose={() => setModalData(null)}
            planId={planId}
            planToken={planToken}
            initialApproveStatus={initialApproveStatus}
            initialEverApproved={initialEverApproved}
          />
```

- [ ] **Step 2: Add the prop, state, and derived flag to the modal**

In `client/src/components/ShoppingList/ShoppingListModal.jsx`, extend the signature (line 43):

```javascript
export default function ShoppingListModal({ listData, onClose, planId, planToken, initialApproveStatus = 'idle', initialEverApproved = false }) {
```

Add state next to `lastSend` (after line 69):

```javascript
  // True after a successful silent publish; cleared whenever a normal send
  // records a lastSend. Keeps the approve button from ever claiming a silent
  // publish was emailed.
  const [lastPublishSilent, setLastPublishSilent] = useState(false);
```

Add the derived flag near the other label derivations (just before `approvedLabel`, around line 384):

```javascript
  // Has the client ever seen this list? Durable prior-approval (snapshot) OR
  // approved-then-edited this session OR a silent publish this session.
  const hasBeenPublished = initialEverApproved || wasApproved || lastPublishSilent;
```

- [ ] **Step 3: Make the approve label tell the truth after a silent publish**

Replace the `approvedLabel` definition (currently lines 384-388) so a silent publish reads honestly instead of "& Sent":

```javascript
  const approvedLabel = lastPublishSilent ? '✓ Updated, not sent'
    : !lastSend ? '✓ Approved & Sent'
    : lastSend.email === 'sent' ? '✓ Approved & Sent'
    : lastSend.email === 'failed' ? '✓ Approved, email FAILED'
    : '✓ Approved (no email)';
```

- [ ] **Step 4: Clear `lastPublishSilent` when a normal send completes**

In `handleSendComplete` (lines 359-364), add the clear inside the `results.ok` branch:

```javascript
  const handleSendComplete = (results) => {
    if (results && results.ok) {
      setLastSend(results);
      setLastPublishSilent(false);
      setApproveStatus('approved');
    }
  };
```

- [ ] **Step 5: Add the `handleSilentPublish` handler**

Add after `handleOpenSend` (which ends at line 354). It mirrors `handleOpenSend`'s pre-save flush but holds `approveStatus='saving'` across BOTH requests (no double-submit window), and never opens the SendModal:

```javascript
  // Silent publish (spec: "Update Client's Copy" / "Publish Quietly"): flush the
  // on-screen edits, then approve with zero channels so the client's live link
  // updates without an email. Reuses approveStatus='approved' on success so the
  // next edit re-arms the buttons via the existing auto-save branch.
  const handleSilentPublish = async () => {
    if (!planId) return;
    if (!hasBeenPublished) {
      // First-ever publish with no notification also closes the client's Lab.
      const ok = window.confirm(
        'Publish this list to the client without notifying them? They will not get a link, and their Enhancement Lab will close.'
      );
      if (!ok) return;
    }
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const publishPayload = { edited, guestCount };
    pendingSaveRef.current = null;
    setApproveStatus('saving');
    setApproveError('');
    try {
      await api.put(`/drink-plans/${planId}/shopping-list`, {
        shopping_list: {
          ...stripGenerationKeys(edited),
          guestCount: parseInt(guestCount, 10) || edited.guestCount,
        },
      });
      setSaveStatus('saved');
      await api.post('/comms/send', {
        action: 'shopping_list_approve',
        entity_id: planId,
        channels: [],
        silent: true,
      });
      setLastSend(null);
      setLastPublishSilent(true);
      setApproveStatus('approved');
    } catch (err) {
      console.error('Silent publish failed:', err);
      // The PUT above already reverted the list to pending_review (any edit
      // does), so on failure the client's page is showing the pending screen.
      // Re-enable the button (idle) and say so; clicking again retries.
      if (!pendingSaveRef.current) pendingSaveRef.current = publishPayload;
      setApproveStatus('idle');
      setApproveError(err?.message || 'Publish failed. The list is not live for the client right now. Click to retry.');
    }
  };
```

- [ ] **Step 6: Add the button to the footer**

In `ShoppingListModal.jsx`, insert immediately before the existing approve button (before line 624, `{planId && (`):

```javascript
          {planId && (
            <button
              className="btn btn-secondary"
              onClick={handleSilentPublish}
              disabled={approveStatus !== 'idle' || sendOpen}
              title="Update the client's live shopping-list link without emailing them."
            >
              {approveStatus === 'saving' ? 'Publishing…'
                : (approveStatus === 'approved' && lastPublishSilent) ? '✓ Updated'
                : hasBeenPublished ? "Update Client's Copy"
                : 'Publish Quietly'}
            </button>
          )}
```

Note: when `approveStatus === 'saving'` BOTH this button and the approve button show a busy label and are disabled (both gate on `approveStatus !== 'idle'`), so there is no double-submit path.

- [ ] **Step 7: Add the silent case to the footer note**

In the footer note ternary (lines 601-604), extend it to cover a silent publish:

```javascript
          <div style={{ marginRight: 'auto', maxWidth: 440, fontSize: '0.75rem', color: 'var(--ink-3)', lineHeight: 1.45 }}>
            {lastPublishSilent
              ? 'Updated quietly. The client link is live with the new version and their Enhancement Lab window is closed. They were not notified.'
              : approveStatus === 'approved'
              ? 'Published. The client link is live and their Enhancement Lab window is closed. Any edit returns this list to Needs review and hides it from the client.'
              : 'Approving publishes this list to the client and closes their Enhancement Lab window.'}
          </div>
```

- [ ] **Step 8: Verify the client build (CI lint gate)**

Run: `cd client && CI=true npx react-scripts build`
Expected: build succeeds with no ESLint errors (unused vars / missing deps fail CI). If it fails, fix the reported line before continuing.

- [ ] **Step 9: Manual verification**

Start the Claude-managed dev server if not running. In the admin UI:
1. Open a drink plan, approve+send a shopping list once (client gets the email).
2. Edit a line item; wait for "Saved". The button row now shows "Update Client's Copy" + "Re-approve & Send".
3. Click "Update Client's Copy". Confirm: no email is sent (dev gates sends anyway; check the network tab shows `POST /comms/send` with `silent:true, channels:[]` returning 200), the button shows "✓ Updated", and the footer note reads the quiet-publish copy.
4. Open the public link `/shopping-list/<token>` in another tab — it shows the edited version.
5. Edit again — the button re-arms to "Update Client's Copy" (loop works more than once).
6. On a brand-new never-approved list, the button reads "Publish Quietly" and clicking it shows the confirm dialog.

- [ ] **Step 10: Commit**

```bash
git add client/src/components/ShoppingList/ShoppingListButton.jsx client/src/components/ShoppingList/ShoppingListModal.jsx
git commit -m "feat(shopping-list): quiet-publish button in the editor

Re-publish an edited list to the client's live link without emailing.
Reuses approveStatus='approved' so the edit->republish loop works
repeatedly; lastPublishSilent keeps the approve button from claiming an
email went out; first-ever publish gets a confirm (no link, Lab closes)."
```

---

## Task 4: Docs — ARCHITECTURE.md

**Files:**
- Modify: `ARCHITECTURE.md` (the `POST /send` contract section ~:237 and the action-contract section ~:1113-1120)

- [ ] **Step 1: Document the `silent` flag and `allowSilent`**

In the `POST /api/comms/send` contract description, add a sentence: that the body accepts an optional `silent: true` (with `channels: []`) which applies the action's side effects and sends nothing, and is only honored for actions that declare `allowSilent`. In the action-contract list, add `allowSilent` alongside `minRole` / `dispatchWithoutSideEffects` with a one-line description. Match the surrounding prose style; no em dashes.

- [ ] **Step 2: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs: document silent-publish flag on /api/comms/send"
```

---

## Self-Review

**Spec coverage:**
- Server request contract (strict `=== true`, order before `ensureSideEffects`, 3 rejections, skip guard) → Task 1, Step 5. ✔
- Opt-in flag on shopping-list action + registry comment → Task 1, Steps 3-4. ✔
- Downstream behavior unchanged (dispatch no-op, side effects, Lab close, queue clear) → relies on existing code; asserted by Task 1 Step 1 test 1. ✔
- Audit trail (no actor, accepted) → no code; documented as non-goal, nothing to build. ✔
- `ever_approved` durable signal → Task 2. ✔
- Client: reuse `approveStatus='approved'` + `lastPublishSilent`; button label truth; confirm on first publish; `entity_id` wire key; `api.post`; error copy names the hidden-list consequence; no double-submit → Task 3. ✔
- Tests: 4 route tests + guard-still-rejects + ordering pin (invoice stays draft) → Task 1 Step 1. Note: the spec tentatively placed the guard-still-rejects test in `comms.test.js`, but that file is action-level and the guard is route-level, so all five live in the new route file `comms.silent.test.js`. ✔
- Docs (ARCHITECTURE.md) → Task 4. ✔

**Placeholder scan:** none — every step carries real code or an exact command.

**Type consistency:** `initialEverApproved` (prop), `lastPublishSilent` (state), `hasBeenPublished` (derived), `ever_approved` (wire key), `entity_id` (wire key), `allowSilent` (action prop) are used identically everywhere they appear across Tasks 1-3.
