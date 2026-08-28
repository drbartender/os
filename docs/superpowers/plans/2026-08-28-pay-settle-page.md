# Post-Payment Settle State Implementation Plan (lane 1: pay-settle-page)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a Stripe checkout redirect, the proposal page shows a dollar figure only once the proposal row is confirmed settled, and never renders "paid" from the URL flag alone.

**Architecture:** Three pure client modules (`paidState.js`, `settlePoll.js`, two presentational components) carry all the logic and all the tests; `ProposalView.js` shrinks to wiring. One new non-mutating server endpoint, `GET /api/proposals/t/:token/payment-state`, is the poll target, because the existing full GET bumps `view_count` and logs a view on every call. The URL's `paid=true` only opens a settling state; the paid card and the Payment Terms box derive from the row through `paidState()`.

**Tech Stack:** React 18 (CRA, jest + @testing-library/react 13), Express + node:test on the server, axios, Stripe Elements redirect params.

**Spec:** `docs/superpowers/specs/2026-08-28-post-payment-settle-and-full-pay-invoice-design.md`, sections 1a, 2 (decisions 1 and 5), 3, 6 (lane 1), 7.

## Global Constraints

- `proposals.*` money is DOLLARS (numeric strings from pg). Invoices and Stripe are cents. Never cross them.
- No em dashes in any client-facing copy. Use a period, a comma, or a colon.
- Client tests: from `client/`, `CI=true npx react-scripts test --testPathPattern=<pattern> --watchAll=false`. `toHaveTextContent` and other jest-dom matchers are NOT available; assert on `.textContent`.
- Server tests: from the repo root, one file at a time, `node --test <path>`. Every server test file starts with `require('dotenv').config();`. Read the pass count in the output; a suite that "passes" with 0 tests did not run.
- Commit with explicit pathspecs (`git add <files>`), never `git add -A`. Commit messages via `git commit -F - <<'MSG'` and never contain backticks.
- Work happens in worktree lane `pay-settle-page` off `main`. Do not run `npm install` inside the lane (it clobbers the node_modules symlink).
- This lane ships alone. It does not depend on lane 2.

---

### Task 1: `paidState.js`, the row-truth helper

**Files:**
- Create: `client/src/pages/proposal/proposalView/paidState.js`
- Test: `client/src/pages/proposal/proposalView/paidState.test.js`

**Interfaces:**
- Produces:
  - `PAID_STATES: string[]` = `['deposit_paid', 'balance_paid', 'confirmed', 'completed']`
  - `isPaidState(status: string): boolean`
  - `paidState(proposal): { kind: 'none' | 'deposit' | 'full', amountPaid: number, total: number, remaining: number, paidOn: string | null }`
  - `readRedirect(search: string): { redirected: boolean, succeeded: boolean }`

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/proposal/proposalView/paidState.test.js
import { PAID_STATES, isPaidState, paidState, readRedirect } from './paidState';

// The exact row Mike Boswell's browser received at 17:04:11 on 2026-08-28:
// the webhook had not committed, so the row still said unpaid and pre-tip.
const mikePreCommit = {
  status: 'accepted', amount_paid: '0', total_price: '350.00',
  accepted_at: null, pricing_snapshot: { total: 350 },
};

test('PAID_STATES is the four money-bearing lifecycle states', () => {
  expect(PAID_STATES).toEqual(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
  expect(isPaidState('balance_paid')).toBe(true);
  expect(isPaidState('accepted')).toBe(false);
  expect(isPaidState(undefined)).toBe(false);
});

test('the pre-commit row is NOT paid, whatever the URL says', () => {
  expect(paidState(mikePreCommit)).toEqual({
    kind: 'none', amountPaid: 0, total: 350, remaining: 350, paidOn: null,
  });
});

test('balance_paid is full regardless of the arithmetic', () => {
  const s = paidState({ status: 'balance_paid', amount_paid: '550.00', total_price: '550.00', accepted_at: '2026-08-28T17:04:06.588Z' });
  expect(s.kind).toBe('full');
  expect(s.remaining).toBe(0);
  expect(s.paidOn).toBe('2026-08-28T17:04:06.588Z');
});

test('confirmed with amount_paid covering the total is full', () => {
  expect(paidState({ status: 'confirmed', amount_paid: '550', total_price: '550' }).kind).toBe('full');
  // within a cent still counts
  expect(paidState({ status: 'confirmed', amount_paid: '549.995', total_price: '550' }).kind).toBe('full');
});

test('deposit_paid with money still owed is deposit, with the true remainder', () => {
  const s = paidState({ status: 'deposit_paid', amount_paid: '100', total_price: '550' });
  expect(s.kind).toBe('deposit');
  expect(s.amountPaid).toBe(100);
  expect(s.remaining).toBe(450);
});

test('remaining never goes negative on an overpaid row', () => {
  expect(paidState({ status: 'balance_paid', amount_paid: '600', total_price: '550' }).remaining).toBe(0);
});

test('a null or missing proposal is none', () => {
  expect(paidState(null).kind).toBe('none');
  expect(paidState(undefined).kind).toBe('none');
});

test('readRedirect: paid=true alone is a succeeded redirect', () => {
  expect(readRedirect('?paid=true')).toEqual({ redirected: true, succeeded: true });
});

test('readRedirect: Stripe redirect_status=succeeded is a succeeded redirect', () => {
  expect(readRedirect('?paid=true&payment_intent=pi_1&redirect_status=succeeded')).toEqual({ redirected: true, succeeded: true });
});

test('readRedirect: a failed 3DS redirect is redirected but NOT succeeded', () => {
  expect(readRedirect('?paid=true&redirect_status=failed')).toEqual({ redirected: true, succeeded: false });
});

test('readRedirect: no paid flag is not a redirect at all', () => {
  expect(readRedirect('')).toEqual({ redirected: false, succeeded: false });
  expect(readRedirect('?choose=1')).toEqual({ redirected: false, succeeded: false });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=paidState --watchAll=false`
Expected: FAIL, "Cannot find module './paidState'".

- [ ] **Step 3: Write the implementation**

```js
// client/src/pages/proposal/proposalView/paidState.js
//
// Row truth for the post-payment surfaces. Every dollar figure the paid card
// and the Payment Terms box render comes through here, from the proposal ROW,
// never from the URL. The ?paid=true flag proves a checkout redirect happened;
// it proves nothing about the row, which the webhook may not have written yet
// (measured 2026-08-28: the redirect lands ~1s after the webhook transaction
// starts and before it commits, on every full-payment conversion checked).

export const PAID_STATES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];

export function isPaidState(status) {
  return PAID_STATES.includes(status);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export function paidState(proposal) {
  if (!proposal) return { kind: 'none', amountPaid: 0, total: 0, remaining: 0, paidOn: null };
  const amountPaid = num(proposal.amount_paid);
  const total = num(proposal.total_price);
  const remaining = Math.max(0, total - amountPaid);
  const paidOn = proposal.accepted_at || null;
  if (!isPaidState(proposal.status)) {
    return { kind: 'none', amountPaid, total, remaining, paidOn };
  }
  const full = proposal.status === 'balance_paid' || amountPaid >= total - 0.01;
  return { kind: full ? 'full' : 'deposit', amountPaid, total, remaining, paidOn };
}

// Stripe appends payment_intent, payment_intent_client_secret and
// redirect_status to return_url. Our return_url already carries paid=true.
// A redirect whose status is anything but succeeded (a failed 3DS challenge)
// must render as an unpaid visit, not as "Booking confirmed".
export function readRedirect(search) {
  const params = new URLSearchParams(search || '');
  const redirected = params.get('paid') === 'true';
  const rs = params.get('redirect_status');
  const succeeded = redirected && (rs === null || rs === 'succeeded');
  return { redirected, succeeded };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=paidState --watchAll=false`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/paidState.js client/src/pages/proposal/proposalView/paidState.test.js
git commit -F - <<'MSG'
feat(proposal-pay): paidState, the row-truth helper for post-payment surfaces

The paid card and the Payment Terms box will derive every dollar figure from
the proposal row through this one function. The URL's paid flag is read by
readRedirect and tells the page only that a checkout redirect happened, and
whether Stripe reported it succeeded.

Pinned on the exact pre-commit row a real client received on 2026-08-28.
MSG
```

---

### Task 2: `settlePoll.js`, the bounded poll

**Files:**
- Create: `client/src/pages/proposal/proposalView/settlePoll.js`
- Test: `client/src/pages/proposal/proposalView/settlePoll.test.js`

**Interfaces:**
- Consumes: `isPaidState` from Task 1.
- Produces: `pollPaymentState({ fetchState, attempts = 13, intervalMs = 1500, sleep, isCancelled }): Promise<state | null>` where `state` is whatever `fetchState` resolved with once its `.status` is a paid state.

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/proposal/proposalView/settlePoll.test.js
import { pollPaymentState } from './settlePoll';

const noSleep = () => Promise.resolve();

test('resolves with the first paid state and sleeps only between attempts', async () => {
  const seq = [
    { status: 'accepted', amount_paid: 0, total_price: 350 },
    { status: 'accepted', amount_paid: 0, total_price: 350 },
    { status: 'balance_paid', amount_paid: 550, total_price: 550 },
  ];
  let calls = 0;
  const sleeps = [];
  const out = await pollPaymentState({
    fetchState: async () => seq[calls++],
    sleep: async (ms) => { sleeps.push(ms); },
  });
  expect(out).toEqual(seq[2]);
  expect(calls).toBe(3);
  expect(sleeps).toEqual([1500, 1500]);
});

test('returns null after the attempt budget, with one fewer sleep than attempts', async () => {
  let calls = 0;
  let sleeps = 0;
  const out = await pollPaymentState({
    fetchState: async () => { calls++; return { status: 'accepted' }; },
    sleep: async () => { sleeps++; },
  });
  expect(out).toBeNull();
  expect(calls).toBe(13);
  expect(sleeps).toBe(12);
});

test('a throwing fetch is a transient miss, not an abort', async () => {
  let calls = 0;
  const out = await pollPaymentState({
    fetchState: async () => {
      calls++;
      if (calls === 1) throw new Error('network');
      return { status: 'deposit_paid' };
    },
    sleep: noSleep,
  });
  expect(out).toEqual({ status: 'deposit_paid' });
  expect(calls).toBe(2);
});

test('stops early when cancelled', async () => {
  let calls = 0;
  let cancelled = false;
  const out = await pollPaymentState({
    fetchState: async () => { calls++; cancelled = true; return { status: 'accepted' }; },
    sleep: noSleep,
    isCancelled: () => cancelled,
  });
  expect(out).toBeNull();
  expect(calls).toBe(1);
});

test('attempts and interval are configurable', async () => {
  let calls = 0;
  const sleeps = [];
  await pollPaymentState({
    fetchState: async () => { calls++; return { status: 'viewed' }; },
    attempts: 3, intervalMs: 10,
    sleep: async (ms) => { sleeps.push(ms); },
  });
  expect(calls).toBe(3);
  expect(sleeps).toEqual([10, 10]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=settlePoll --watchAll=false`
Expected: FAIL, "Cannot find module './settlePoll'".

- [ ] **Step 3: Write the implementation**

```js
// client/src/pages/proposal/proposalView/settlePoll.js
import { isPaidState } from './paidState';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounded poll for the proposal's payment state after a checkout redirect.
// 13 attempts at 1.5s is about 20 seconds, the budget spec 3b gives the
// webhook before the page gives up and shows the no-numbers fallback.
// A fetch error is a transient miss: the webhook is the thing we are waiting
// on, and a flaky network read must not end the wait early.
export async function pollPaymentState({
  fetchState,
  attempts = 13,
  intervalMs = 1500,
  sleep = defaultSleep,
  isCancelled = () => false,
}) {
  for (let i = 0; i < attempts; i += 1) {
    if (isCancelled()) return null;
    try {
      const state = await fetchState();
      if (state && isPaidState(state.status)) return state;
    } catch {
      // transient; keep waiting
    }
    if (isCancelled()) return null;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=settlePoll --watchAll=false`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/settlePoll.js client/src/pages/proposal/proposalView/settlePoll.test.js
git commit -F - <<'MSG'
feat(proposal-pay): bounded poll for the post-redirect payment state

Thirteen attempts at 1.5 seconds, about twenty seconds, then null. A fetch
error is a miss, not an abort, because the thing being waited on is the
webhook, not the network.
MSG
```

---

### Task 3: `GET /api/proposals/t/:token/payment-state`

**Files:**
- Modify: `server/routes/proposals/publicToken.js` (add the route directly below the `/t/:token/resolve` route, which ends around line 56)
- Test: `server/routes/proposals/publicToken.paymentState.test.js`

**Interfaces:**
- Produces: `GET /api/proposals/t/:token/payment-state` returning `{ status, amount_paid, total_price, payment_type }` (dollars as numbers), 404 on unknown or archived token. Non-mutating.

- [ ] **Step 1: Write the failing test**

```js
// server/routes/proposals/publicToken.paymentState.test.js
// The poll target for the post-checkout settle state (spec 3c). Its whole
// contract is "tell me the row's payment state and touch NOTHING": the full
// GET bumps view_count and logs a view on every call, and thirteen polls
// recording thirteen views would fake engagement.
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicTokenRouter = require('./publicToken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('publicToken.paymentState.test.js refuses to run against production');
}

let server;
let baseUrl;
const createdProposalIds = new Set();
const createdClientIds = new Set();

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function insertProposal({ status = 'viewed', amountPaid = 0, totalPrice = 350, paymentType = 'deposit' } = {}) {
  const client = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    ['Payment State Test', `paystate+${Date.now()}-${crypto.randomBytes(4).toString('hex')}@example.test`]
  );
  createdClientIds.add(client.rows[0].id);
  const token = crypto.randomUUID();
  const prop = await pool.query(
    `INSERT INTO proposals
       (client_id, token, guest_count, event_duration_hours, num_bars, pricing_snapshot,
        total_price, amount_paid, payment_type, status, event_type)
     VALUES ($1, $2, 50, 4, 0, '{"total": 350}'::jsonb, $3, $4, $5, $6, 'Cocktail Party')
     RETURNING id, token`,
    [client.rows[0].id, token, totalPrice, amountPaid, paymentType, status]
  );
  createdProposalIds.add(prop.rows[0].id);
  return prop.rows[0];
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicTokenRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (createdProposalIds.size > 0) {
    const ids = [...createdProposalIds];
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test('returns the four fields as numbers, in dollars', async () => {
  const p = await insertProposal({ status: 'balance_paid', amountPaid: 550, totalPrice: 550, paymentType: 'full' });
  const r = await get(`/api/proposals/t/${p.token}/payment-state`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: 'balance_paid', amount_paid: 550, total_price: 550, payment_type: 'full' });
});

test('five calls bump nothing: view_count, last_viewed_at, status, activity log all untouched', async () => {
  const p = await insertProposal({ status: 'sent' });
  for (let i = 0; i < 5; i += 1) {
    const r = await get(`/api/proposals/t/${p.token}/payment-state`);
    assert.equal(r.status, 200);
  }
  const row = (await pool.query(
    'SELECT status, view_count, last_viewed_at FROM proposals WHERE id = $1', [p.id]
  )).rows[0];
  assert.equal(row.status, 'sent', 'the sent->viewed flip belongs to the full GET, not this one');
  assert.equal(Number(row.view_count || 0), 0);
  assert.equal(row.last_viewed_at, null);
  const views = (await pool.query(
    "SELECT count(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'viewed'", [p.id]
  )).rows[0].n;
  assert.equal(views, 0);
});

test('404 on an archived proposal and on an unknown token', async () => {
  const p = await insertProposal({ status: 'archived' });
  const r = await get(`/api/proposals/t/${p.token}/payment-state`);
  assert.equal(r.status, 404);
  const r2 = await get(`/api/proposals/t/${crypto.randomUUID()}/payment-state`);
  assert.equal(r2.status, 404);
});

test('a malformed token is rejected, not looked up', async () => {
  const r = await get('/api/proposals/t/not-a-uuid/payment-state');
  assert.ok(r.status === 400 || r.status === 404, `got ${r.status}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/routes/proposals/publicToken.paymentState.test.js`
Expected: the first three tests FAIL with status 404 or a route-not-found body (the route does not exist yet). Read the summary: `fail 3` or `fail 4`.

- [ ] **Step 3: Add the route**

Insert directly after the closing `}));` of the `/t/:token/resolve` route in `server/routes/proposals/publicToken.js`:

```js
/** GET /api/proposals/t/:token/payment-state — NON-mutating. The poll target
 *  for the post-checkout settle state (spec 2026-08-28 §3c). Returns only the
 *  row's payment state, in dollars, and touches NOTHING: no view_count bump,
 *  no last_viewed_at, no sent->viewed flip, no activity row. The full GET does
 *  all four on every call, and a thirteen-attempt poll against it would record
 *  thirteen views of a page the client is staring at once. */
router.get('/t/:token/payment-state', publicLimiter, requireUuidToken, asyncHandler(async (req, res) => {
  const { rows: [row] } = await pool.query(
    `SELECT status, amount_paid, total_price, payment_type
       FROM proposals
      WHERE token = $1 AND status <> 'archived'`,
    [req.params.token]
  );
  if (!row) throw new NotFoundError('This proposal is no longer available');
  res.json({
    status: row.status,
    amount_paid: Number(row.amount_paid || 0),
    total_price: Number(row.total_price || 0),
    payment_type: row.payment_type || null,
  });
}));
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/routes/proposals/publicToken.paymentState.test.js`
Expected: `pass 4`, `fail 0`.

- [ ] **Step 5: Run the neighbouring public-token suites, one at a time**

Run: `node --test server/routes/proposals/publicToken.test.js` then `node --test server/routes/proposals/publicToken.signTotal.test.js`
Expected: `pass 12` and `pass 4`, `fail 0` on each.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/publicToken.js server/routes/proposals/publicToken.paymentState.test.js
git commit -F - <<'MSG'
feat(proposals): a non-mutating payment-state read for the post-checkout poll

Status, amount_paid, total_price and payment_type, in dollars, and nothing
else. The full GET bumps view_count, stamps last_viewed_at, flips sent to
viewed and logs a view on every call, so a bounded poll against it would
record thirteen views of one page load. Pinned: five calls leave all four
untouched.
MSG
```

---

### Task 4: `PaidCard.js`, the card with a settling and a fallback phase

**Files:**
- Create: `client/src/pages/proposal/proposalView/PaidCard.js`
- Test: `client/src/pages/proposal/proposalView/PaidCard.test.js`

**Interfaces:**
- Consumes: `paidState()` shape from Task 1 (`{ kind, amountPaid, total, remaining, paidOn }`); `fmt` and `formatDateShort` from `./helpers`.
- Produces: `<PaidCard phase state autopayEnrolled balanceDueDate openInvoiceToken drinkPlanToken onRefresh />` where `phase` is `'settling' | 'fallback' | 'paid'`.

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/proposal/proposalView/PaidCard.test.js
import React from 'react';
import { render, screen } from '@testing-library/react';
import PaidCard from './PaidCard';

const full = { kind: 'full', amountPaid: 550, total: 550, remaining: 0, paidOn: '2026-08-28T17:04:06.588Z' };
const deposit = { kind: 'deposit', amountPaid: 100, total: 550, remaining: 450, paidOn: '2026-08-28T17:04:06.588Z' };
const none = { kind: 'none', amountPaid: 0, total: 350, remaining: 350, paidOn: null };

test('settling shows no dollar figure and no pay link', () => {
  const { container } = render(
    <PaidCard phase="settling" state={none} autopayEnrolled={false} balanceDueDate="2026-08-29" openInvoiceToken="tok" drinkPlanToken={null} onRefresh={() => {}} />
  );
  expect(container.textContent).toMatch(/Confirming your payment/);
  expect(container.textContent).not.toMatch(/\$/);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
});

test('fallback shows no dollar figure, no pay link, and a refresh control', () => {
  const onRefresh = jest.fn();
  const { container } = render(
    <PaidCard phase="fallback" state={none} autopayEnrolled={false} balanceDueDate="2026-08-29" openInvoiceToken="tok" drinkPlanToken={null} onRefresh={onRefresh} />
  );
  expect(container.textContent).toMatch(/Your payment went through/);
  expect(container.textContent).not.toMatch(/\$/);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
  screen.getByRole('button', { name: /Refresh/ }).click();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('paid + full renders Fully paid and no balance line', () => {
  const { container } = render(
    <PaidCard phase="paid" state={full} autopayEnrolled={false} balanceDueDate="2026-08-29" openInvoiceToken={null} drinkPlanToken="dp" onRefresh={() => {}} />
  );
  expect(container.textContent).toMatch(/Fully paid\./);
  expect(container.textContent).not.toMatch(/remaining balance/i);
  expect(screen.getByText(/Open the Potion Planner/)).toBeTruthy();
});

test('paid + deposit renders the row remainder and the due date, and the pay link when an invoice is open', () => {
  const { container } = render(
    <PaidCard phase="paid" state={deposit} autopayEnrolled={false} balanceDueDate="2026-09-12" openInvoiceToken="inv-tok" drinkPlanToken={null} onRefresh={() => {}} />
  );
  expect(container.textContent).toMatch(/Deposit received\./);
  expect(container.textContent).toMatch(/\$450\.00/);
  expect(screen.getByText(/Pay balance/).getAttribute('href')).toBe('/invoice/inv-tok');
});

test('paid + deposit + autopay names the automatic charge instead of a due-by', () => {
  const { container } = render(
    <PaidCard phase="paid" state={deposit} autopayEnrolled balanceDueDate="2026-09-12" openInvoiceToken={null} drinkPlanToken={null} onRefresh={() => {}} />
  );
  expect(container.textContent).toMatch(/automatically charged/);
  expect(container.textContent).toMatch(/\$450\.00/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=PaidCard --watchAll=false`
Expected: FAIL, "Cannot find module './PaidCard'".

- [ ] **Step 3: Write the component**

The `paid` branch is the existing card block from `ProposalView.js` (the `{isPaid && (...)}` block, currently lines 801 to 848), moved here verbatim except that `isFullyPaid` becomes `state.kind === 'full'`, `amount_paid > 0` becomes `state.amountPaid > 0`, and `balanceAmount` becomes `state.remaining`.

```js
// client/src/pages/proposal/proposalView/PaidCard.js
import React from 'react';
import { fmt, formatDateShort } from './helpers';

// The card that replaces sign-and-pay once money is involved. Three phases:
//   settling  : a checkout redirect just landed and the row is not yet in a
//               paid state. NO dollar figure, no pay link. The webhook is
//               still writing (spec 2026-08-28 §1a).
//   fallback  : the poll budget ran out. Still no numbers; the payment went
//               through at Stripe and the email will carry the figures.
//   paid      : the row is settled; every figure below comes from `state`,
//               which paidState() derived from the row.
export default function PaidCard({
  phase, state, autopayEnrolled, balanceDueDate, openInvoiceToken, drinkPlanToken, onRefresh,
}) {
  if (phase === 'settling') {
    return (
      <div className="proposal-paid-card" role="status" aria-live="polite">
        <div className="spinner" aria-hidden="true" />
        <h3 className="proposal-paid-title">Confirming your payment</h3>
        <p className="proposal-paid-sub">This usually takes a few seconds.</p>
      </div>
    );
  }

  if (phase === 'fallback') {
    return (
      <div className="proposal-paid-card" role="status" aria-live="polite">
        <div className="proposal-paid-check" aria-hidden="true">✓</div>
        <h3 className="proposal-paid-title">Your payment went through.</h3>
        <p className="proposal-paid-sub">
          We are finishing up on our side and your confirmation email is on its way.
        </p>
        <button type="button" className="btn" onClick={onRefresh} style={{ marginTop: '4px' }}>
          Refresh
        </button>
      </div>
    );
  }

  const isFullyPaid = state.kind === 'full';
  return (
    <div className="proposal-paid-card">
      <div className="proposal-paid-check" aria-hidden="true">✓</div>
      {isFullyPaid ? (
        <>
          <h3 className="proposal-paid-title">Fully paid.</h3>
          <p className="proposal-paid-sub">
            Your booking is confirmed. We'll be in touch with event details closer to the date.
          </p>
        </>
      ) : autopayEnrolled ? (
        <>
          <h3 className="proposal-paid-title">{state.amountPaid > 0 ? 'Deposit received.' : 'Booking confirmed.'}</h3>
          <p className="proposal-paid-sub">
            Your remaining balance of {fmt(state.remaining)} will be automatically charged on {formatDateShort(balanceDueDate)}.
          </p>
        </>
      ) : (
        <>
          <h3 className="proposal-paid-title">{state.amountPaid > 0 ? 'Deposit received.' : 'Booking confirmed.'}</h3>
          <p className="proposal-paid-sub">
            Your remaining balance of {fmt(state.remaining)} is due by {formatDateShort(balanceDueDate)}.
          </p>
        </>
      )}
      {!isFullyPaid && openInvoiceToken && (
        <a href={`/invoice/${openInvoiceToken}`} className="btn btn-primary" style={{ marginTop: '4px' }}>
          Pay balance
        </a>
      )}
      {drinkPlanToken && (
        <a href={`/plan/${drinkPlanToken}`} className="proposal-paid-link">
          Open the Potion Planner →
        </a>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=PaidCard --watchAll=false`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/PaidCard.js client/src/pages/proposal/proposalView/PaidCard.test.js
git commit -F - <<'MSG'
feat(proposal-pay): PaidCard with settling and fallback phases

The paid-state card leaves ProposalView as its own component so the two new
phases can be pinned: settling and fallback render no dollar figure and no
pay link. The paid phase is the existing card, now reading every figure from
paidState() instead of from the row directly.
MSG
```

---

### Task 5: `PaymentTermsBox.js`, the terms box that respects the row

**Files:**
- Create: `client/src/pages/proposal/proposalView/PaymentTermsBox.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js` (replace the Payment Summary block, currently lines 132 to 164, and add two props)
- Test: `client/src/pages/proposal/proposalView/PaymentTermsBox.test.js`

**Interfaces:**
- Consumes: `paidState()` shape from Task 1.
- Produces: `<PaymentTermsBox state settling fullPaymentRequired snapshotTotal balanceAmount balanceDueDate />`. `ProposalPricingBreakdown` gains props `paid` (the state object) and `settling` (boolean) and passes them through.

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/proposal/proposalView/PaymentTermsBox.test.js
import React from 'react';
import { render } from '@testing-library/react';
import PaymentTermsBox from './PaymentTermsBox';

const none = { kind: 'none', amountPaid: 0, total: 350, remaining: 350, paidOn: null };
const full = { kind: 'full', amountPaid: 550, total: 550, remaining: 0, paidOn: '2026-08-28T17:04:06.588Z' };
const deposit = { kind: 'deposit', amountPaid: 100, total: 550, remaining: 450, paidOn: '2026-08-28T17:04:06.588Z' };

test('settling renders the heading and no money rows at all', () => {
  const { container } = render(
    <PaymentTermsBox state={none} settling fullPaymentRequired={false} snapshotTotal={350} balanceAmount={250} balanceDueDate="2026-08-29" />
  );
  expect(container.textContent).toMatch(/Payment Terms/);
  expect(container.textContent).not.toMatch(/\$/);
  expect(container.textContent).not.toMatch(/Deposit Due at Signing/);
});

test('unpaid deposit terms render the pre-payment rows exactly as before', () => {
  const { container } = render(
    <PaymentTermsBox state={none} settling={false} fullPaymentRequired={false} snapshotTotal={350} balanceAmount={250} balanceDueDate="2026-08-29" />
  );
  expect(container.textContent).toMatch(/Deposit Due at Signing/);
  expect(container.textContent).toMatch(/\$100\.00/);
  expect(container.textContent).toMatch(/Remaining Balance/);
  expect(container.textContent).toMatch(/\$250\.00/);
});

test('unpaid full-payment-required renders the single full row', () => {
  const { container } = render(
    <PaymentTermsBox state={none} settling={false} fullPaymentRequired snapshotTotal={350} balanceAmount={250} balanceDueDate="2026-08-29" />
  );
  expect(container.textContent).toMatch(/Full Payment Due/);
  expect(container.textContent).toMatch(/\$350\.00/);
  expect(container.textContent).not.toMatch(/Deposit Due at Signing/);
});

test('a paid-in-full row never shows Deposit Due at Signing', () => {
  const { container } = render(
    <PaymentTermsBox state={full} settling={false} fullPaymentRequired={false} snapshotTotal={550} balanceAmount={0} balanceDueDate="2026-08-29" />
  );
  expect(container.textContent).toMatch(/Paid in full/);
  expect(container.textContent).toMatch(/\$550\.00/);
  expect(container.textContent).not.toMatch(/Deposit Due at Signing/);
  expect(container.textContent).not.toMatch(/Remaining Balance/);
});

test('a deposit-paid row shows what was paid, the true remainder, and the due date', () => {
  const { container } = render(
    <PaymentTermsBox state={deposit} settling={false} fullPaymentRequired={false} snapshotTotal={550} balanceAmount={450} balanceDueDate="2026-09-12" />
  );
  expect(container.textContent).toMatch(/Deposit paid/);
  expect(container.textContent).toMatch(/\$100\.00/);
  expect(container.textContent).toMatch(/Remaining balance/);
  expect(container.textContent).toMatch(/\$450\.00/);
  expect(container.textContent).toMatch(/Balance due by/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=PaymentTermsBox --watchAll=false`
Expected: FAIL, "Cannot find module './PaymentTermsBox'".

- [ ] **Step 3: Write the component**

```js
// client/src/pages/proposal/proposalView/PaymentTermsBox.js
import React from 'react';
import { fmt, formatDateShort, DEPOSIT_DOLLARS } from './helpers';
import styles from './styles';

// The "Payment Terms" box under the pricing breakdown. Before payment it
// states the terms (deposit at signing, remainder by the due date). Once the
// ROW is in a paid state it states what happened, from paidState(): never
// "Deposit Due at Signing" on a booking that is paid in full. While a
// checkout redirect is settling it states nothing numeric at all.
export default function PaymentTermsBox({
  state, settling, fullPaymentRequired, snapshotTotal, balanceAmount, balanceDueDate,
}) {
  let rows;
  if (settling) {
    rows = (
      <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Confirming your payment.
      </p>
    );
  } else if (state.kind === 'full') {
    rows = (
      <>
        <div style={{ ...styles.paymentRow, borderBottom: state.paidOn ? undefined : 'none' }}>
          <span style={styles.paymentLabel}>Paid in full</span>
          <span style={styles.paymentValue}>{fmt(state.amountPaid)}</span>
        </div>
        {state.paidOn && (
          <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
            <span style={styles.paymentLabel}>Paid on</span>
            <span style={styles.paymentValue}>{formatDateShort(state.paidOn)}</span>
          </div>
        )}
      </>
    );
  } else if (state.kind === 'deposit') {
    rows = (
      <>
        <div style={styles.paymentRow}>
          <span style={styles.paymentLabel}>Deposit paid</span>
          <span style={styles.paymentValue}>{fmt(state.amountPaid)}</span>
        </div>
        <div style={styles.paymentRow}>
          <span style={styles.paymentLabel}>Remaining balance</span>
          <span style={styles.paymentValue}>{fmt(state.remaining)}</span>
        </div>
        <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
          <span style={styles.paymentLabel}>Balance due by</span>
          <span style={styles.paymentValue}>{formatDateShort(balanceDueDate)}</span>
        </div>
      </>
    );
  } else if (fullPaymentRequired) {
    rows = (
      <>
        <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
          <span style={styles.paymentLabel}>Full Payment Due</span>
          <span style={styles.paymentValue}>{snapshotTotal != null ? fmt(snapshotTotal) : '—'}</span>
        </div>
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>
          This is the complete cost for your event. No separate deposit, no balance due later.
        </p>
      </>
    );
  } else {
    rows = (
      <>
        <div style={styles.paymentRow}>
          <span style={styles.paymentLabel}>Deposit Due at Signing</span>
          <span style={styles.paymentValue}>{fmt(DEPOSIT_DOLLARS)}</span>
        </div>
        <div style={styles.paymentRow}>
          <span style={styles.paymentLabel}>Remaining Balance</span>
          <span style={styles.paymentValue}>{fmt(balanceAmount)}</span>
        </div>
        <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
          <span style={styles.paymentLabel}>Balance Due By</span>
          <span style={styles.paymentValue}>{formatDateShort(balanceDueDate)}</span>
        </div>
      </>
    );
  }

  return (
    <div style={styles.section}>
      <h2 style={styles.sectionTitle}>Payment Terms</h2>
      <div style={styles.paymentSummary}>{rows}</div>
    </div>
  );
}
```

Note the `'—'` in the full-payment-required row is the existing placeholder glyph for a missing snapshot, carried over unchanged; it is not prose.

- [ ] **Step 4: Run the test to verify it passes**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=PaymentTermsBox --watchAll=false`
Expected: PASS, 5 tests.

- [ ] **Step 5: Wire it into `ProposalPricingBreakdown.js`**

Add the import at the top:

```js
import PaymentTermsBox from './PaymentTermsBox';
```

Add two props to the component signature, after `fullPaymentRequired`:

```js
  paid,
  settling,
```

Replace the whole block from the comment `{/* ── Payment Summary (always visible) ── */}` through the closing `</div>` of that `styles.section` block, up to but NOT including the `{/* Potion Planner Link */}` comment, with:

```jsx
      {/* ── Payment Summary (always visible) ── */}
      <PaymentTermsBox
        state={paid}
        settling={settling}
        fullPaymentRequired={fullPaymentRequired}
        snapshotTotal={snapshot ? snapshot.total : null}
        balanceAmount={balanceAmount}
        balanceDueDate={balanceDueDate}
      />
```

Then check what is left inside that `styles.section` div: the Potion Planner link that followed the terms box must still render. Confirm by reading the file after the edit that the JSX is balanced and the Potion Planner block is intact. If `DEPOSIT_DOLLARS` is now unused in `ProposalPricingBreakdown.js`, remove it from the `./helpers` import (CI builds with warnings as errors for the client via Vercel, and an unused import is a lint warning).

- [ ] **Step 6: Run the proposal client suites**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=proposal --watchAll=false`
Expected: all suites PASS (the count grows by the three new files; no failures).

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/proposal/proposalView/PaymentTermsBox.js client/src/pages/proposal/proposalView/PaymentTermsBox.test.js client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
git commit -F - <<'MSG'
feat(proposal-pay): the Payment Terms box states what happened once the row is paid

Before payment it states the terms. Once the row is in a paid state it states
what was paid and what remains, from paidState(). Never "Deposit Due at
Signing" on a booking that is paid in full, and nothing numeric while a
checkout redirect is still settling.
MSG
```

---

### Task 6: Wire `ProposalView.js`: redirect, settling poll, row-truth card

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js`

**Interfaces:**
- Consumes: `paidState`, `isPaidState`, `readRedirect` (Task 1); `pollPaymentState` (Task 2); `PaidCard` (Task 4); `ProposalPricingBreakdown`'s new `paid` and `settling` props (Task 5); the `payment-state` endpoint (Task 3).

This task has no new unit test of its own; its behaviour is the composition of Tasks 1 to 5, and the acceptance check is Step 6 (full client suite) plus Step 7 (build) plus the walkthrough owed in Task 7.

- [ ] **Step 1: Imports**

Below the existing `import { applyIntentQuote } from './intentQuote';` line add:

```js
import { paidState, isPaidState, readRedirect } from './paidState';
import { pollPaymentState } from './settlePoll';
import PaidCard from './PaidCard';
```

- [ ] **Step 2: Replace the `paid` flag with the redirect reading**

Replace:

```js
  // Check if returning from Stripe redirect
  const paid = new URLSearchParams(window.location.search).get('paid') === 'true';
```

with:

```js
  // A checkout redirect landed here. `paid` (kept under its old name because
  // isPayableStatus and the intent effect key on it) now means "Stripe sent
  // the client back and reported success"; it does NOT mean the row is paid.
  // The row may not be written yet (spec 2026-08-28 §1a). redirectFailed is a
  // 3DS/redirect failure: render as an unpaid visit with a plain note.
  const { redirected, succeeded: paid } = useMemo(() => readRedirect(window.location.search), []);
  const redirectFailed = redirected && !paid;
  // 'idle' until the first proposal load; then 'settling' | 'paid' | 'fallback'.
  const [settle, setSettle] = useState('idle');
```

Confirm `useMemo` is already imported from React at the top of the file (it is used by `elementsOptions` in `SignAndPaySection`, not necessarily here). If `ProposalView.js`'s React import lacks `useMemo`, add it.

- [ ] **Step 3: Replace the redirect toast with the settle effect**

Replace:

```js
  // Show a success toast when returning from Stripe redirect (?paid=true)
  useEffect(() => {
    if (paid) toast.success('Payment received!');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paid]);
```

with:

```js
  // Settle after a successful checkout redirect. The first proposal load may
  // have read the row BEFORE the webhook committed; never render its numbers
  // as "paid". Poll the non-mutating payment-state read until the row is in a
  // paid state, refetch the full proposal once, then render from it. If the
  // budget runs out, the fallback card renders with no numbers at all.
  useEffect(() => {
    if (!paid || !proposal || settle !== 'idle') return undefined;
    if (isPaidState(proposal.status)) {
      setSettle('paid');
      toast.success('Payment received!');
      return undefined;
    }
    setSettle('settling');
    let cancelled = false;
    pollPaymentState({
      fetchState: () => axios.get(`${BASE_URL}/proposals/t/${token}/payment-state`).then((r) => r.data),
      isCancelled: () => cancelled,
    }).then(async (state) => {
      if (cancelled) return;
      if (!state) { setSettle('fallback'); return; }
      try {
        const fresh = await axios.get(`${BASE_URL}/proposals/t/${token}`);
        if (cancelled) return;
        setProposal(fresh.data);
        setSettle('paid');
        toast.success('Payment received!');
      } catch {
        // The row is paid (the poll said so) but this page could not reload
        // it. Say so without numbers rather than render the stale row.
        if (!cancelled) setSettle('fallback');
      }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paid, proposal?.id, settle, token]);
```

- [ ] **Step 4: Derive the card state from the row, not the URL**

Find the block (currently around lines 611 to 618):

```js
  const inPaidState = ['confirmed', 'deposit_paid', 'balance_paid', 'completed'].includes(proposal.status);
  const balanceAmount = inPaidState
    ? Math.max(0, totalPrice - Number(proposal.amount_paid || 0))
    : totalPrice - DEPOSIT_DOLLARS;
```

Replace with:

```js
  const paidInfo = paidState(proposal);
  const balanceAmount = paidInfo.kind !== 'none'
    ? paidInfo.remaining
    : totalPrice - DEPOSIT_DOLLARS;
```

Find:

```js
  const isAlreadySigned = !!proposal.client_signed_at;
  const isPaid = ['deposit_paid', 'balance_paid', 'confirmed'].includes(proposal.status) || paid;
```

Replace with:

```js
  const isAlreadySigned = !!proposal.client_signed_at;
  // ROW truth only. The URL flag opens the settling state above; it never
  // renders the paid card by itself.
  const isPaid = paidInfo.kind !== 'none';
  const settling = settle === 'settling' || settle === 'fallback';
```

Find:

```js
  const showSignAndPay = !isPaid && !isAlreadySigned && ['sent', 'viewed'].includes(proposal.status);
```

Replace with:

```js
  const showSignAndPay = !isPaid && !settling && !isAlreadySigned && ['sent', 'viewed'].includes(proposal.status);
```

Find:

```js
  const showPayOnly = !isPaid && isAlreadySigned && proposal.status === 'accepted';
```

Replace with:

```js
  const showPayOnly = !isPaid && !settling && isAlreadySigned && proposal.status === 'accepted';
```

Find and delete the two lines:

```js
  const isFullyPaid = proposal.status === 'balance_paid' ||
    Number(proposal.amount_paid || 0) >= Number(proposal.total_price || 0) - 0.01;
```

(`isFullyPaid` was consumed only by the paid card, which now lives in `PaidCard`.)

- [ ] **Step 5: Pass the new props to the breakdown and swap in the card**

In the `<ProposalPricingBreakdown ... />` element, add after `fullPaymentRequired={fullPaymentRequired}`:

```jsx
              paid={paidInfo}
              settling={settling}
```

In the `<aside className="proposal-pay-rail">`, directly above `{showSignAndPay && (`, add:

```jsx
            {redirectFailed && (
              <p className="payment-policy-warn" role="status">
                That payment did not go through. Nothing was charged. You can try again below.
              </p>
            )}
```

Replace the entire block from the comment `{/* ── Paid state success card (replaces sign-and-pay) ── */}` through the closing `)}` of `{isPaid && (` (the block ends just before `</aside>`) with:

```jsx
            {/* ── Paid state card (replaces sign-and-pay). Settling and fallback
                phases render no dollar figure; paid renders from the row. ── */}
            {(settling || isPaid) && (
              <PaidCard
                phase={settle === 'settling' ? 'settling' : settle === 'fallback' ? 'fallback' : 'paid'}
                state={paidInfo}
                autopayEnrolled={!!proposal.autopay_enrolled}
                balanceDueDate={balanceDueDate}
                openInvoiceToken={proposal.open_invoice_token || null}
                drinkPlanToken={proposal.drink_plan_token || null}
                onRefresh={() => window.location.assign(window.location.pathname)}
              />
            )}
```

- [ ] **Step 6: Run the full client suite**

Run (from `client/`): `CI=true npx react-scripts test --watchAll=false`
Expected: every suite PASS. The count before this lane was 95 suites / 824 tests; expect 99 suites and 824 + 26 tests. Zero failures.

- [ ] **Step 7: Build with warnings as errors**

Run (from `client/`): `CI=true npx react-scripts build 2>&1 | grep -iE "error|warning|Compiled" | head`
Expected: `Compiled with warnings.` is acceptable ONLY if the sole warning is the pre-existing `html2pdf.js ... SVGPathData.module.js.map` source-map line. Any `no-unused-vars` or other lint warning on files in this lane must be fixed before commit.

- [ ] **Step 8: Commit**

```bash
git add client/src/pages/proposal/proposalView/ProposalView.js
git commit -F - <<'MSG'
fix(proposal-pay): the paid flag opens a settling state; the card renders from the row

After a checkout redirect the page no longer combines the URL's paid flag
with whatever row it happened to read. It polls the payment-state read until
the row is in a paid state, refetches once, and renders from that. Until
then: "Confirming your payment" and no numbers. Past the budget: the
fallback, still no numbers. A redirect Stripe reports as failed renders as an
unpaid visit with a plain note instead of "Booking confirmed".

Mike Boswell's page load on 2026-08-28 read the row 0.4 seconds before the
webhook committed and told him he had paid 100 dollars and owed 250 by the
next day. This is the fix for that.
MSG
```

---

### Task 7: Lane docs and finish

**Files:**
- Modify: `docs/walkthroughs-owed.md` (the Tier 1 entry that begins `- [ ] **Sign-and-pay WITH a gratuity, end to end. Fix shipped 2026-08-28, \`e8101a9d\`.**`)

- [ ] **Step 1: Update the walkthrough entry**

Inside that entry, after the paragraph beginning `**What to watch:**`, add a new paragraph:

```
      **Added 2026-08-28 (lane pay-settle-page):** the page after checkout must show
      "Confirming your payment" with NO dollar figure, then settle to "Fully paid." with
      the with-tip amount, within a few seconds. The Payment Terms box must read "Paid in
      full" and never "Deposit Due at Signing". Watch it on the real redirect, not a
      reload: a reload was always right, the redirect was the broken load.
```

- [ ] **Step 2: Commit**

```bash
git add docs/walkthroughs-owed.md
git commit -F - <<'MSG'
docs(walkthroughs): the settle state is part of the gratuity sign-and-pay walk

Watch the redirect, not a reload. A reload was always right.
MSG
```

- [ ] **Step 3: Gate and hand back**

Run (from the lane root): `npm run gate`
Expected: `gate PASSED (client)`.

Then stop. Review is one reviewer plus the client suite (spec §7). The push cue gates the push, never the review. Report the lane tip sha.

---

## Self-review against the spec

- §3a redirect handling: Task 1 (`readRedirect`), Task 6 Steps 2 and 5 (failed-redirect note, `isPaid` from row only, `isPayableStatus` keeps `!paid`).
- §3b settling state and poll: Task 2 (poll), Task 4 (settling and fallback cards), Task 6 Step 3 (effect), Step 5 (refresh link). 13 attempts × 1.5s.
- §3c endpoint: Task 3, pinned non-mutating.
- §3d row-truth rendering: Task 1 (`paidState`), Task 4 (card), Task 5 (terms box). "Deposit Due at Signing" never on a paid row: pinned in Task 5.
- §3e out of scope: nothing touches `InvoicePage.js` or `ConfirmationStep.js`.
- §6 lane 1 tests: `paidState.test.js` (pre-commit row), `PaidCard.test.js` (settling and fallback render no `$`, no Pay balance), `PaymentTermsBox.test.js`, `publicToken.paymentState.test.js` (five calls bump nothing). The spec's "redirect_status=failed renders the sign-and-pay form" is covered at the helper level (`readRedirect`) and by construction in Task 6 Step 4 (`showSignAndPay` needs `!isPaid && !settling`, both false on a failed redirect); no ProposalView-level render test exists because that component needs router, axios, Stripe and canvas mocks the codebase has no harness for.
- §7 review and rollout: Task 7 Step 3.
- Copy: no em dashes in any new string. The single `'—'` glyph in `PaymentTermsBox` is the pre-existing missing-value placeholder, unchanged.
