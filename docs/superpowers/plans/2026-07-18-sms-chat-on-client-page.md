---
plan: sms-chat-on-client-page
spec: docs/superpowers/specs/2026-07-18-sms-chat-on-client-page-design.md
lanes:
  - id: sms-order
    summary: Inbox conversation list sorts by most recent received message.
    footprint:
      - server/routes/sms.js
      - server/routes/sms.test.js
    depends_on: []
    # server/routes/sms.js is on scripts/sensitive-paths.txt, so this lane gets
    # the full fleet + /second-opinion at push regardless of size.
    review: [code-review, database-review, security-review, consistency-check]
  - id: sms-client-panel
    summary: Extract a shared ClientConversation component and embed the SMS thread on the client page.
    footprint:
      - client/src/components/ClientConversation.js
      - client/src/pages/admin/Messages.js
      - client/src/pages/admin/ClientDetail.js
      - README.md
    depends_on: []
    review: [code-review, ui-ux-review]
parallelism: sms-order and sms-client-panel are independent (disjoint files, server vs client) and run in parallel.
---

# SMS chat on the client page + inbox received-ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read and answer a client's SMS thread on that client's detail page, and sort the inbox by newest received message.

**Architecture:** Two independent lanes. Lane `sms-order` changes one SQL query so the inbox orders conversations by each client's most recent inbound message. Lane `sms-client-panel` extracts the inbox's inline thread-plus-reply UI into a shared `ClientConversation` React component, embeds it on the client detail page, and refactors the inbox to render the same component so the two surfaces cannot drift.

**Tech Stack:** Node 26 / Express 4, raw SQL via `pool.query`, `node:test`; React 18 (CRA), vanilla CSS in `index.css`, API via `client/src/utils/api.js`.

## Global Constraints

- No ORM. Raw parameterized SQL via `pool.query` only.
- No new SMS endpoints. Reuse `GET /sms/conversations`, `GET /sms/conversations/:clientId`, `POST /sms/conversations/:clientId/reply`, `PUT /sms/conversations/:clientId/read`.
- No schema change. `sms_messages` stays a flat table.
- Frontend API calls go through `client/src/utils/api.js`. Never raw fetch/axios.
- CSS is vanilla in `client/src/index.css`. Reuse the existing `sms-messages`, `sms-bubble*`, `sms-reply`, `form-input` classes. No new styling system.
- No em dashes in any client-visible copy (commas, periods, colons, parentheticals).
- Client verification is `CI=true react-scripts build` (warnings fail the build). Write hooks lint-clean.
- Server tests run one suite at a time against the shared dev DB: `node -r dotenv/config --test server/routes/sms.test.js`. Seed with unique markers and clean up in `after`.
- Both lanes commit inside their own worktree (never on `os`/main). The squash merge is the gate.

---

## Lane sms-order

One SQL query change plus a DB-backed ordering test. Server only. No client change (the inbox already renders server order and displays `last_message_at`; the added `last_inbound_at` field is ignored by the client).

**Precondition:** the new ordering test makes this suite DB-backed (the existing tests were DB-free). Running it requires `JWT_SECRET` and `DATABASE_URL` in the local `.env` (both are standard and loaded via `node -r dotenv/config`). A missing `JWT_SECRET` makes `jwt.sign` throw in `before` and errors the whole suite.

### Task 1: Sort the inbox by most recent received message

**Files:**
- Modify: `server/routes/sms.js:112-131` (the `GET /conversations` handler)
- Test: `server/routes/sms.test.js` (extend the existing suite)

**Interfaces:**
- Consumes: existing `sms_messages` columns `client_id`, `direction`, `created_at`, `metadata`.
- Produces: `GET /api/sms/conversations` returns one row per client ordered by `last_inbound_at DESC NULLS LAST, last_message_at DESC`. Row shape gains `last_inbound_at` (TIMESTAMPTZ, nullable) alongside the existing `client_id, name, phone, unread_count, last_message_at`.

- [ ] **Step 1: Write the failing test**

Add this to the END of `server/routes/sms.test.js` (after the last existing test). It also needs seeding in `before` and cleanup in `after` (Steps 1a, 1b below). First, the assertions:

```js
// ── /conversations ordering (spec 2026-07-18) ────────────────────────────────
// The inbox orders by each client's most recent INBOUND message, newest first,
// with outbound-only threads sinking to the bottom (NULLS LAST). A fresh
// outbound reply must NOT bump a handled thread above one with a more recent
// inbound message.
test('GET /conversations orders by newest received; outbound-only sinks last', async () => {
  const r = await request('GET', '/api/sms/conversations', {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(r.status, 200, r.body);
  const rows = JSON.parse(r.body);
  const mine = rows.filter(x => [orderClientA, orderClientB, orderClientC].includes(x.client_id));
  const order = mine.map(x => x.client_id);
  // B (inbound 5m ago) outranks A (inbound 10m ago) even though A has a newer
  // OUTBOUND reply (1m ago). C is outbound-only → last.
  assert.deepEqual(order, [orderClientB, orderClientA, orderClientC], r.body);
});
```

- [ ] **Step 1a: Seed the ordering fixtures in `before`**

Add these requires near the top of the file (after the existing requires):

```js
const jwt = require('jsonwebtoken');
```

Add module-level fixture ids near `let server, baseUrl;`:

```js
let adminToken, orderAdminUserId, orderClientA, orderClientB, orderClientC;
```

At the END of the existing `before(async () => { ... })` block (after `baseUrl` is set), append:

```js
  // Admin user + JWT for the authorized /conversations request (beo.test.js shape).
  const admin = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status, token_version)
     VALUES ('sms-order-admin@example.test', 'x', 'admin', 'approved', 0)
     RETURNING id, token_version`
  );
  orderAdminUserId = admin.rows[0].id;
  adminToken = jwt.sign(
    { userId: orderAdminUserId, tokenVersion: admin.rows[0].token_version },
    process.env.JWT_SECRET, { expiresIn: '1h' }
  );

  // Three clients with controlled message timelines.
  const ca = await pool.query("INSERT INTO clients (name, phone) VALUES ('SMS Order A', '3125550301') RETURNING id");
  const cb = await pool.query("INSERT INTO clients (name, phone) VALUES ('SMS Order B', '3125550302') RETURNING id");
  const cc = await pool.query("INSERT INTO clients (name, phone) VALUES ('SMS Order C', '3125550303') RETURNING id");
  orderClientA = ca.rows[0].id;
  orderClientB = cb.rows[0].id;
  orderClientC = cc.rows[0].id;

  // A: inbound 10m ago, then an outbound reply 1m ago (most recent ACTIVITY is outbound).
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, created_at) VALUES
       ('inbound',  $1, '3125550301', 'A first', 'general', 'received', NOW() - INTERVAL '10 minutes'),
       ('outbound', $1, '3125550301', 'A reply', 'general', 'sent',     NOW() - INTERVAL '1 minute')`,
    [orderClientA]
  );
  // B: inbound 5m ago, no later outbound (most recent inbound overall among A/B).
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, created_at) VALUES
       ('inbound', $1, '3125550302', 'B waiting', 'general', 'received', NOW() - INTERVAL '5 minutes')`,
    [orderClientB]
  );
  // C: outbound only 2m ago (no inbound → last_inbound_at NULL → sinks).
  await pool.query(
    `INSERT INTO sms_messages (direction, client_id, recipient_phone, body, message_type, status, created_at) VALUES
       ('outbound', $1, '3125550303', 'C outreach', 'general', 'sent', NOW() - INTERVAL '2 minutes')`,
    [orderClientC]
  );
```

- [ ] **Step 1b: Clean up in `after`**

At the START of the existing `after(async () => { ... })` block (before `pool.end`), prepend:

```js
  await pool.query('DELETE FROM sms_messages WHERE client_id = ANY($1)', [[orderClientA, orderClientB, orderClientC]]);
  await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[orderClientA, orderClientB, orderClientC]]);
  await pool.query('DELETE FROM users WHERE id = $1', [orderAdminUserId]);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node -r dotenv/config --test server/routes/sms.test.js`
Expected: the new ordering test FAILS. Under the current `ORDER BY last_message_at DESC`, the returned order is `[A, C, B]` (A's 1m-ago outbound wins), so `assert.deepEqual(order, [B, A, C])` fails. The existing signature/auth tests still pass.

- [ ] **Step 3: Change the query**

In `server/routes/sms.js`, replace the SELECT/ORDER inside the `GET /conversations` handler (lines 117-129) with:

```js
  const result = await pool.query(`
    SELECT c.id AS client_id, c.name, c.phone,
      (SELECT COUNT(*) FROM sms_messages m
        WHERE m.client_id = c.id AND m.direction = 'inbound' AND m.read_at IS NULL
          AND (m.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true')::int AS unread_count,
      (SELECT MAX(m2.created_at) FROM sms_messages m2 WHERE m2.client_id = c.id
          AND (m2.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true') AS last_message_at,
      (SELECT MAX(m4.created_at) FROM sms_messages m4 WHERE m4.client_id = c.id
          AND m4.direction = 'inbound'
          AND (m4.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true') AS last_inbound_at
    FROM clients c
    WHERE EXISTS (SELECT 1 FROM sms_messages m3 WHERE m3.client_id = c.id
          AND (m3.metadata->>'thumbtack_relay') IS DISTINCT FROM 'true')
    ORDER BY last_inbound_at DESC NULLS LAST, last_message_at DESC
    LIMIT 200
  `);
```

Also update the handler's doc comment (lines 108-111) so it reads "newest received first" instead of "newest activity first":

```js
/**
 * GET /api/sms/conversations — one row per client that has any SMS, ordered by
 * the client's most recent inbound (received) message, newest first. Threads a
 * client never replied to (no inbound) sort last. Includes an unread inbound count.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node -r dotenv/config --test server/routes/sms.test.js`
Expected: ALL tests PASS, including the new ordering test (order is now `[B, A, C]`).

- [ ] **Step 5: Commit**

```bash
git add server/routes/sms.js server/routes/sms.test.js
git commit -m "feat(sms): order inbox by most recent received message"
```

---

## Lane sms-client-panel

Extract the inbox thread-plus-reply UI into a shared component, embed it on the client page, refactor the inbox to reuse it. Client only.

### Task 2: Create the shared `ClientConversation` component

**Files:**
- Create: `client/src/components/ClientConversation.js`

**Interfaces:**
- Consumes: `GET /sms/conversations/:clientId`, `POST /sms/conversations/:clientId/reply`, `PUT /sms/conversations/:clientId/read` via `client/src/utils/api.js`; `useToast` from `../context/ToastContext`.
- Produces: default-exported React component `ClientConversation`, props:
  - `clientId` (number, required)
  - `phone` (string | null) — when falsy, the reply box is disabled with an inline hint
  - `markReadOnOpen` (bool, default `true`) — when true, marks inbound read after the thread loads
  - `onActivity` (function, optional) — called after a mark-read and after a successful send, so a host can refresh its own list/badges
  Renders a React Fragment of exactly two siblings: `.sms-messages` (scroll region, `ref` auto-scrolled to bottom) and `.sms-reply` (textarea + Send button). No wrapper element, so it slots into both the inbox `.sms-thread` and a client-page `.card` without changing their flex layout.

- [ ] **Step 1: Write the component**

Create `client/src/components/ClientConversation.js` with exactly:

```jsx
import React, { useState, useEffect, useRef } from 'react';
import api from '../utils/api';
import { useToast } from '../context/ToastContext';

// Shared SMS thread + reply pane, keyed on a clientId. Used by the admin inbox
// (Messages.js) and the client detail page (ClientDetail.js) so both surfaces
// render and behave identically. Renders two siblings (.sms-messages, .sms-reply)
// with no wrapper so it inherits the flex layout of whatever contains it.
export default function ClientConversation({ clientId, phone, markReadOnOpen = true, onActivity }) {
  const toast = useToast();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const messagesRef = useRef(null);

  // Load the thread when the client changes. Marking read is a deliberate view
  // action, so it is gated on markReadOnOpen (the inbox passes false when it
  // merely auto-opens the newest thread on a bare page visit). onActivity lets a
  // host refresh its unread badges after the read clears. Deps intentionally
  // [clientId] only: markReadOnOpen/onActivity/toast are stable per mount here
  // (the inbox remounts this via key on each open), and listing onActivity would
  // refire the load on every parent render.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await api.get(`/sms/conversations/${clientId}`);
        if (!alive) return;
        setMessages(res.data);
        if (markReadOnOpen) {
          await api.put(`/sms/conversations/${clientId}/read`);
          if (onActivity) onActivity();
        }
      } catch (err) {
        if (alive) toast.error('Failed to load conversation. Try again.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // Keep the newest message in view whenever the thread loads or grows.
  useEffect(() => {
    const el = messagesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleReply = async () => {
    if (!replyText.trim() || !clientId) return;
    setReplying(true);
    try {
      await api.post(`/sms/conversations/${clientId}/reply`, { body: replyText });
      setReplyText('');
      toast.success('Reply sent.');
      const res = await api.get(`/sms/conversations/${clientId}`);
      setMessages(res.data);
      // Replying is engagement: clear any lingering unread badge.
      await api.put(`/sms/conversations/${clientId}/read`);
      if (onActivity) onActivity();
    } catch (err) {
      toast.error(err.message || 'Failed to send reply.');
      // The reply endpoint saves a failed send as a row; re-fetch to show it.
      try {
        const res = await api.get(`/sms/conversations/${clientId}`);
        setMessages(res.data);
      } catch (_) { /* ignore secondary failure */ }
    } finally {
      setReplying(false);
    }
  };

  return (
    <>
      <div className="sms-messages" ref={messagesRef}>
        {loading ? (
          <div className="muted tiny">Loading messages...</div>
        ) : messages.length === 0 ? (
          <div className="muted tiny">No texts yet.</div>
        ) : (
          messages.map(msg => (
            <div key={msg.id} className={`sms-bubble sms-bubble-${msg.direction}`}>
              <div className="sms-bubble-body">{msg.body || '(no text)'}</div>
              <div className="sms-bubble-meta">
                {msg.direction === 'outbound' ? 'You' : 'Client'}
                {' . '}
                {new Date(msg.created_at).toLocaleString('en-US', { hour12: false })}
                {msg.status === 'failed' && ' . failed to send'}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="sms-reply">
        <textarea
          className="form-input"
          value={replyText}
          onChange={e => setReplyText(e.target.value)}
          placeholder="Type your reply..."
          rows={3}
          disabled={!phone}
        />
        <button
          className="btn btn-primary"
          onClick={handleReply}
          disabled={replying || !replyText.trim() || !phone}
        >
          {replying ? 'Sending...' : 'Send SMS'}
        </button>
        {!phone && <div className="tiny muted">No phone number on file.</div>}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd client && CI=true npx react-scripts build`
Expected: build SUCCEEDS with no ESLint errors (the component is unused so far; it must still lint clean, including the intentional `react-hooks/exhaustive-deps` disable comment).

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ClientConversation.js
git commit -m "feat(sms): shared ClientConversation thread+reply component"
```

### Task 3: Refactor the inbox to reuse `ClientConversation`

**Files:**
- Modify: `client/src/pages/admin/Messages.js`

**Interfaces:**
- Consumes: `ClientConversation` from `../../components/ClientConversation` (Task 2).
- Produces: the inbox right pane renders `ClientConversation`. `Messages.js` keeps the conversation list, URL state, selection, and the auto-open-newest behavior. It drives per-open mark-read policy through a remount `key` (nonce) plus the `markReadOnOpen` prop, and refreshes the list via `onActivity`.

- [ ] **Step 1: Replace the thread state and handlers**

In `client/src/pages/admin/Messages.js`, first fix the React import on line 1: change

```jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
```

to

```jsx
import React, { useState, useEffect, useCallback } from 'react';
```

(drop `useRef` — its only consumer, `messagesRef`, is deleted below; `useCallback` stays because `fetchThreads` still uses it. Leaving `useRef` imported would fail `CI=true react-scripts build` on `no-unused-vars`.) Then add the component import (after the `EntityLink` import on line 5):

```jsx
import ClientConversation from '../../components/ClientConversation';
```

Replace the state block (lines 9-18) with:

```jsx
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);
  // The open thread is a {clientId, nonce, markRead} triple. `nonce` is the
  // remount key for ClientConversation: bumping it on every open (auto or click)
  // re-runs the component's load+markRead, so re-clicking an already-open thread
  // still clears its badge. `markRead` is false only for the bare-visit auto-open
  // of the newest thread, which must not silently clear an unread count.
  const [open, setOpen] = useState({ clientId: null, nonce: 0, markRead: false });
  // Selected thread lives in the URL (?client=<id>) so Back from a client
  // profile reopens the same conversation. Empty = the newest-thread default.
  const [listState, setListState] = useUrlListState({ client: '' });
```

Delete `messagesRef` (was line 15), `replyText`, `replying` (were 13-14), and `selectedClientId`/`messages` (were 10-11) — they are all replaced by `open` and the component.

- [ ] **Step 2: Replace openThread/selectThread/auto-open/scroll/handleReply**

Replace the `openThread` callback (lines 37-49), `selectThread` (51-54), the auto-open effect (63-70), the scroll effect (73-76), and `handleReply` (78-100) with just this selection logic:

```jsx
  const selectThread = (clientId) => {
    setListState({ client: String(clientId) });
    setOpen(o => ({ clientId, nonce: o.nonce + 1, markRead: true }));
  };

  // On first load with nothing selected, open the URL-named thread (a deliberate
  // open → mark read) or fall back to the newest thread (a convenience → do NOT
  // mark read). threads are newest-received-first from the server.
  useEffect(() => {
    if (open.clientId || threads.length === 0) return;
    const fromUrl = listState.client
      ? threads.find(t => String(t.client_id) === listState.client)
      : null;
    if (fromUrl) setOpen(o => ({ clientId: fromUrl.client_id, nonce: o.nonce + 1, markRead: true }));
    else setOpen(o => ({ clientId: threads[0].client_id, nonce: o.nonce + 1, markRead: false }));
  }, [threads, open.clientId, listState.client]);
```

Keep `fetchThreads` (lines 20-30) and its `useEffect` (line 32) unchanged.

- [ ] **Step 3: Update the render to use the component**

Replace `const selectedThread = threads.find(t => t.client_id === selectedClientId);` (line 102) with:

```jsx
  const selectedThread = threads.find(t => t.client_id === open.clientId);
```

In the list item (lines 116-143), replace every `selectedClientId === thread.client_id` comparison with `open.clientId === thread.client_id`.

Replace the entire `.sms-thread` block (lines 146-192) with:

```jsx
          <div className="sms-thread">
            {!open.clientId ? (
              <div className="sms-placeholder">Select a conversation to view messages.</div>
            ) : (
              <>
                <div className="sms-thread-head">
                  <h3>
                    <EntityLink to={selectedThread?.client_id ? '/clients/' + selectedThread.client_id : null}>
                      {selectedThread?.name || 'Unknown client'}
                    </EntityLink>
                  </h3>
                  <span className="muted">{selectedThread?.phone}</span>
                </div>
                <ClientConversation
                  key={open.nonce}
                  clientId={open.clientId}
                  phone={selectedThread?.phone}
                  markReadOnOpen={open.markRead}
                  onActivity={() => fetchThreads(true)}
                />
              </>
            )}
          </div>
```

- [ ] **Step 4: Verify the inbox builds clean**

Run: `cd client && CI=true npx react-scripts build`
Expected: build SUCCEEDS, no unused-variable or exhaustive-deps errors (confirm `messages`, `replyText`, `replying`, `messagesRef`, `openThread` are all gone, AND that `useRef` was dropped from the line-1 React import).

- [ ] **Step 5: Manual check in local review**

Start the dev server (Claude-managed background process; restart if server files changed). In the admin app open `/messages`: confirm clicking a thread shows its bubbles and marks it read (badge clears + list refreshes), sending a reply appends the outbound bubble, and a bare visit auto-opens the newest thread WITHOUT clearing its unread badge until clicked. (List ordering is Lane sms-order's deliverable and is verified there, not in this lane.)

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/Messages.js
git commit -m "refactor(sms): inbox reuses ClientConversation"
```

### Task 4: Embed the conversation on the client detail page

**Files:**
- Modify: `client/src/pages/admin/ClientDetail.js`
- Modify: `README.md` (folder structure tree: new component)

**Interfaces:**
- Consumes: `ClientConversation` from `../../components/ClientConversation` (Task 2). `client.id` (number) and `client.phone` (string | null) are already in scope on the page.
- Produces: a "Messages" card in the left column of the client detail page rendering the thread + reply for `client.id`.

- [ ] **Step 1: Add the import**

In `client/src/pages/admin/ClientDetail.js`, add after the `RowLink` import (line 14):

```jsx
import ClientConversation from '../../components/ClientConversation';
```

- [ ] **Step 2: Add the Messages card**

In the left-column `vstack` (opens line 219), insert this card immediately AFTER the "Proposals & events" card closes (line 267, the `</div>` ending that `card`) and BEFORE the Notes card (line 269):

```jsx
          <div className="card">
            <div className="card-head"><h3>Messages</h3></div>
            <ClientConversation clientId={client.id} phone={client.phone} />
          </div>
```

(Rendering `.sms-messages` / `.sms-reply` directly under `.card`, like the Proposals card renders `.tbl-wrap` directly. `.sms-messages` self-bounds at `max-height: 55vh` with its own scroll, so it needs no extra wrapper. `markReadOnOpen` defaults true: landing on a client's page is a deliberate view, so it clears their unread. `client.phone` falsy disables the reply box with the built-in hint.)

- [ ] **Step 3: Update README component list**

In `README.md`, the `client/src/components/` node (around lines 398-409) is a single tree entry whose trailing `#` comment is a running prose enumeration of component names (AdminLayout, Layout, ... EntityLink, ...), NOT one box-drawing line per file. Append `ClientConversation` to that enumeration where the shared components are named (do not add a new tree line). Keep the mention short, e.g. `..., EntityLink, ClientConversation (shared SMS thread + reply), ...`.

- [ ] **Step 4: Verify it builds clean**

Run: `cd client && CI=true npx react-scripts build`
Expected: build SUCCEEDS, no errors.

- [ ] **Step 5: Manual check in local review**

In the admin app open a client who has an SMS history (e.g. `/clients/<id>` reached from a thread in `/messages`): confirm the Messages card shows the thread and a working reply box, opening the page clears that client's unread badge in the inbox, a client with messages but no phone shows the thread with the reply box disabled and "No phone number on file.", and a client with a phone but no history shows "No texts yet." with an active reply box (so you can start a text).

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/admin/ClientDetail.js README.md
git commit -m "feat(sms): show client SMS thread on the client detail page"
```

---

## Self-review notes

- **Spec coverage:** ordering change (Lane sms-order, Task 1); shared component (Task 2); client-page embed with empty/no-phone states and start-a-text (Task 4); inbox refactor to one code path (Task 3). All spec sections mapped.
- **Non-goals honored:** no schema change, no new endpoints, no unread-pinning, staff-blast paths untouched.
- **Type consistency:** `ClientConversation` prop names (`clientId`, `phone`, `markReadOnOpen`, `onActivity`) are identical in Tasks 2, 3, 4. The inbox `open` triple (`clientId`, `nonce`, `markRead`) is defined and consumed only within Task 3.
- **Cross-cutting:** the added `last_inbound_at` field is server-computed and unused by the client; `last_message_at` is still returned and still drives the list timestamp, so no consumer breaks.
