# Post-Payment Settle State Implementation Plan (lane 1: pay-settle-page)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a Stripe checkout redirect, the proposal page shows a dollar figure only once the proposal row is confirmed settled, never renders "paid" from the URL flag alone, and never asserts a fact about the payment that only the row can prove.

**Architecture:** Pure client modules carry the logic and the tests: `paidState.js` (row truth + redirect reading), `settlePoll.js` (the bounded poll), `useSettle.js` (the ref-latched hook that owns the phase), and two presentational components (`PaidCard`, `PaymentTermsBox`). `ProposalView.js` becomes wiring. On the server: one non-mutating read endpoint as the poll target, two token-keyed limiters so the checkout stops sharing the 20-per-15-minutes IP bucket, and telemetry on the sign route so a blocked signature is never silent again.

**Tech Stack:** React 18 (CRA, jest + @testing-library/react 13.4, which has `renderHook`), Express + node:test, express-rate-limit, @sentry/react on the client, @sentry/node on the server.

**Spec:** `docs/superpowers/specs/2026-08-28-post-payment-settle-and-full-pay-invoice-design.md`, sections 1a, 2 (decisions 1, 5, 6), 3, 6 (lane 1), 7.

**Revised 2026-08-28** after the design fleet: the settle effect is now a ref-latched hook with its own test (three reviewers found the first draft cancelled its own poll); the poll target and the whole checkout leave `publicLimiter` (five reviewers); Task 5's JSX edit keeps the outer section div; `PaymentTermsBox` defaults its `state` so it never crashes between tasks; the sign route gets telemetry; and this lane is full-fleet because `publicToken.js` is a sensitive path.

## Global Constraints

- `proposals.*` money is DOLLARS (numeric strings from pg). Invoices and Stripe are cents. Never cross them.
- No em dashes in any client-facing copy. Use a period, a comma, or a colon.
- Client tests: from `client/`, `CI=true npx react-scripts test --testPathPattern=<pattern> --watchAll=false`. jest-dom matchers (`toHaveTextContent`, `toBeInTheDocument`) are NOT available (no `setupTests.js`); assert on `.textContent` and `.getAttribute`.
- Server tests: from the repo root, one file at a time, `node --test <path>`. Every server test file starts with `require('dotenv').config();`. Read the pass count; a suite that reports 0 tests did not run.
- Commit with explicit pathspecs (`git add <files>`), never `git add -A`. Commit messages via `git commit -F - <<'MSG'` and never contain backticks.
- Work happens in worktree lane `pay-settle-page` off `main`. Do not run `npm install` inside the lane.
- This lane ships alone and FIRST. Lane 2 lengthens the webhook transaction this lane tolerates.
- Review: FULL pre-prod fleet plus `/second-opinion`. `server/routes/proposals/publicToken.js` is on `scripts/sensitive-paths.txt`. The gate line will read `money + client`, and the money smoke needs `NEON_API_KEY`.
- `ProposalView.js` is 873 lines (over the 700 soft cap, under the 1000 hard cap). This lane nets roughly +10 to it; the ratchet allows growth under 1000. Do not add anything to it that can live in a module instead.
- Files both lanes touch: `docs/walkthroughs-owed.md` (same Tier 1 entry; Task 10 Step 3 and lane 2's docs task both append to it), `README.md` (this lane around line 623, lane 2 around 513) and `ARCHITECTURE.md` (this lane around 352 to 374, lane 2 around 1212). Different regions; a rebase should merge clean, but read the conflict if one appears rather than taking either side blindly.

---

### Task 1: `paidState.js`, row truth and the redirect reading

**Files:**
- Create: `client/src/pages/proposal/proposalView/paidState.js`
- Test: `client/src/pages/proposal/proposalView/paidState.test.js`

**Interfaces:**
- Produces:
  - `PAID_STATES: string[]` = `['deposit_paid', 'balance_paid', 'confirmed', 'completed']`
  - `isPaidState(status: string): boolean`
  - `paidState(proposal, renderedTotal?: number): { kind: 'none' | 'deposit' | 'full', amountPaid: number, total: number, remaining: number, completed: boolean }` where `total` is the row's `total_price` and `remaining` is computed against `renderedTotal` when given (the snapshot total the page renders), else against `total`.
  - `readRedirect(search: string): { redirected: boolean, failed: boolean }`

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/proposal/proposalView/paidState.test.js
import { PAID_STATES, isPaidState, paidState, readRedirect } from './paidState';

// The exact row Mike Boswell's browser received at 17:04:11 on 2026-08-28:
// the webhook had not committed, so the row still said unpaid and pre-tip.
const mikePreCommit = { status: 'accepted', amount_paid: '0', total_price: '350.00' };

test('PAID_STATES matches the set balanceAmount already used (inPaidState), completed included', () => {
  expect(PAID_STATES).toEqual(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
  expect(isPaidState('completed')).toBe(true);
  expect(isPaidState('accepted')).toBe(false);
  expect(isPaidState(undefined)).toBe(false);
});

test('the pre-commit row is NOT paid, whatever the URL says', () => {
  expect(paidState(mikePreCommit)).toEqual({ kind: 'none', amountPaid: 0, total: 350, remaining: 350, completed: false });
});

test('balance_paid is full regardless of the arithmetic', () => {
  const s = paidState({ status: 'balance_paid', amount_paid: '550.00', total_price: '550.00' });
  expect(s.kind).toBe('full');
  expect(s.remaining).toBe(0);
});

test('completed is full, and says so', () => {
  const s = paidState({ status: 'completed', amount_paid: '550', total_price: '550' });
  expect(s.kind).toBe('full');
  expect(s.completed).toBe(true);
});

test('confirmed with amount_paid covering the row total is full, within a cent', () => {
  expect(paidState({ status: 'confirmed', amount_paid: '550', total_price: '550' }).kind).toBe('full');
  expect(paidState({ status: 'confirmed', amount_paid: '549.995', total_price: '550' }).kind).toBe('full');
});

test('deposit_paid with money still owed is deposit; the remainder uses the RENDERED total when given', () => {
  const s = paidState({ status: 'deposit_paid', amount_paid: '100', total_price: '550' }, 560);
  expect(s.kind).toBe('deposit');
  expect(s.amountPaid).toBe(100);
  expect(s.total).toBe(550);
  expect(s.remaining).toBe(460);
});

test('the remainder falls back to the row total when no rendered total is given', () => {
  expect(paidState({ status: 'deposit_paid', amount_paid: '100', total_price: '550' }).remaining).toBe(450);
});

test('remaining never goes negative on an overpaid row', () => {
  expect(paidState({ status: 'balance_paid', amount_paid: '600', total_price: '550' }).remaining).toBe(0);
});

test('a null or missing proposal is none', () => {
  expect(paidState(null).kind).toBe('none');
  expect(paidState(undefined).kind).toBe('none');
});

test('readRedirect: paid=true alone is a redirect that did not fail', () => {
  expect(readRedirect('?paid=true')).toEqual({ redirected: true, failed: false });
});

test('readRedirect: redirect_status=succeeded and =pending are both redirects that did not fail', () => {
  expect(readRedirect('?paid=true&payment_intent=pi_1&redirect_status=succeeded')).toEqual({ redirected: true, failed: false });
  expect(readRedirect('?paid=true&redirect_status=pending')).toEqual({ redirected: true, failed: false });
});

test('readRedirect: only redirect_status=failed is a failure', () => {
  expect(readRedirect('?paid=true&redirect_status=failed')).toEqual({ redirected: true, failed: true });
});

test('readRedirect: no paid flag is not a redirect at all', () => {
  expect(readRedirect('')).toEqual({ redirected: false, failed: false });
  expect(readRedirect('?choose=1')).toEqual({ redirected: false, failed: false });
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

// The same set balanceAmount's inPaidState already used. `completed` is paid.
export const PAID_STATES = ['deposit_paid', 'balance_paid', 'confirmed', 'completed'];

export function isPaidState(status) {
  return PAID_STATES.includes(status);
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// `renderedTotal` is the snapshot total the page renders (what balanceAmount
// reads today); `total` is the row's total_price (what isFullyPaid reads
// today). Keeping the two sources keeps the card and the breakdown above it
// printing the same remainder on an override'd proposal.
export function paidState(proposal, renderedTotal) {
  if (!proposal) return { kind: 'none', amountPaid: 0, total: 0, remaining: 0, completed: false };
  const amountPaid = num(proposal.amount_paid);
  const total = num(proposal.total_price);
  const basis = renderedTotal == null ? total : num(renderedTotal);
  const remaining = Math.max(0, basis - amountPaid);
  const completed = proposal.status === 'completed';
  if (!isPaidState(proposal.status)) {
    return { kind: 'none', amountPaid, total, remaining, completed };
  }
  const full = proposal.status === 'balance_paid' || completed || amountPaid >= total - 0.01;
  return { kind: full ? 'full' : 'deposit', amountPaid, total, remaining, completed };
}

// Stripe appends redirect_status to return_url (our return_url already carries
// paid=true). Only `failed` is a failure. `pending` and `processing` are real
// values for bank debits and wallets, and mean "not yet", which the settling
// state handles. Never assert "nothing was charged" on anything but `failed`.
export function readRedirect(search) {
  const params = new URLSearchParams(search || '');
  const redirected = params.get('paid') === 'true';
  const failed = redirected && params.get('redirect_status') === 'failed';
  return { redirected, failed };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=paidState --watchAll=false`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/paidState.js client/src/pages/proposal/proposalView/paidState.test.js
git commit -F - <<'MSG'
feat(proposal-pay): paidState, the row-truth helper for post-payment surfaces

The paid card and the Payment Terms box derive every dollar figure from the
proposal row through this one function. readRedirect tells the page only that
a checkout redirect happened and whether Stripe reported it failed; pending
and processing are not failures.

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
- Produces: `pollPaymentState({ fetchState, attempts = 13, intervalMs = 1500, sleep, isCancelled }): Promise<{ state: object | null, reason: 'settled' | 'exhausted' | 'blocked' | 'cancelled' }>`. `fetchState` may reject with an error carrying `response.status`; any 4xx is `blocked` and stops the poll at once.

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/proposal/proposalView/settlePoll.test.js
import { pollPaymentState } from './settlePoll';

const noSleep = () => Promise.resolve();
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

test('settles on the first paid state and sleeps only between attempts', async () => {
  const seq = [
    { status: 'accepted', amount_paid: 0, total_price: 350 },
    { status: 'accepted', amount_paid: 0, total_price: 350 },
    { status: 'balance_paid', amount_paid: 550, total_price: 550 },
  ];
  let calls = 0;
  const sleeps = [];
  const out = await pollPaymentState({ fetchState: async () => seq[calls++], sleep: async (ms) => { sleeps.push(ms); } });
  expect(out).toEqual({ state: seq[2], reason: 'settled' });
  expect(calls).toBe(3);
  expect(sleeps).toEqual([1500, 1500]);
});

test('exhausts after the attempt budget, with one fewer sleep than attempts', async () => {
  let calls = 0;
  let sleeps = 0;
  const out = await pollPaymentState({
    fetchState: async () => { calls++; return { status: 'accepted' }; },
    sleep: async () => { sleeps++; },
  });
  expect(out).toEqual({ state: null, reason: 'exhausted' });
  expect(calls).toBe(13);
  expect(sleeps).toBe(12);
});

test('a 5xx or a network error is a transient miss, not an abort', async () => {
  let calls = 0;
  const out = await pollPaymentState({
    fetchState: async () => {
      calls++;
      if (calls === 1) throw httpError(502);
      if (calls === 2) throw new Error('network');
      return { status: 'deposit_paid' };
    },
    sleep: noSleep,
  });
  expect(out.reason).toBe('settled');
  expect(calls).toBe(3);
});

test('any 4xx stops the poll at once as blocked', async () => {
  for (const status of [404, 410, 429]) {
    let calls = 0;
    const out = await pollPaymentState({ fetchState: async () => { calls++; throw httpError(status); }, sleep: noSleep });
    expect(out).toEqual({ state: null, reason: 'blocked' });
    expect(calls).toBe(1);
  }
});

test('stops early when cancelled', async () => {
  let calls = 0;
  let cancelled = false;
  const out = await pollPaymentState({
    fetchState: async () => { calls++; cancelled = true; return { status: 'accepted' }; },
    sleep: noSleep,
    isCancelled: () => cancelled,
  });
  expect(out.reason).toBe('cancelled');
  expect(calls).toBe(1);
});

test('attempts and interval are configurable', async () => {
  let calls = 0;
  const sleeps = [];
  await pollPaymentState({ fetchState: async () => { calls++; return { status: 'viewed' }; }, attempts: 3, intervalMs: 10, sleep: async (ms) => { sleeps.push(ms); } });
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
// 13 attempts at 1.5s is about 20 seconds, the budget spec §3b gives the
// webhook before the page gives up. A 5xx or a network error is a miss (the
// thing being waited on is the webhook, not the network). Any 4xx stops the
// poll at once: 404 means the proposal was swept, 429 means the limiter, and
// neither will change by asking again.
export async function pollPaymentState({
  fetchState,
  attempts = 13,
  intervalMs = 1500,
  sleep = defaultSleep,
  isCancelled = () => false,
}) {
  for (let i = 0; i < attempts; i += 1) {
    if (isCancelled()) return { state: null, reason: 'cancelled' };
    try {
      const state = await fetchState();
      if (state && isPaidState(state.status)) return { state, reason: 'settled' };
    } catch (err) {
      const status = err && err.response && err.response.status;
      if (status >= 400 && status < 500) return { state: null, reason: 'blocked' };
    }
    if (isCancelled()) return { state: null, reason: 'cancelled' };
    if (i < attempts - 1) await sleep(intervalMs);
  }
  return { state: null, reason: 'exhausted' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=settlePoll --watchAll=false`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/settlePoll.js client/src/pages/proposal/proposalView/settlePoll.test.js
git commit -F - <<'MSG'
feat(proposal-pay): bounded poll for the post-redirect payment state

Thirteen attempts at 1.5 seconds, then exhausted. A 5xx is a miss because
the thing being waited on is the webhook. Any 4xx stops at once: a swept
proposal or the limiter will not change by asking again.
MSG
```

---

### Task 3: `useSettle.js`, the ref-latched hook that owns the phase

**Files:**
- Create: `client/src/pages/proposal/proposalView/useSettle.js`
- Test: `client/src/pages/proposal/proposalView/useSettle.test.js`

**Interfaces:**
- Consumes: `isPaidState` (Task 1), `pollPaymentState` (Task 2).
- Produces: `useSettle({ active, proposal, fetchState, fetchProposal, onSettled, onFallback }): 'idle' | 'settling' | 'paid' | 'fallback'`.
  - `active`: boolean, the page is on a redirect that did not fail.
  - `proposal`: the loaded proposal or null.
  - `fetchState(): Promise<state>`; `fetchProposal(): Promise<proposal>`.
  - `onSettled(freshProposal)` is called once with the refetched proposal; `onFallback(reason)` once with `'exhausted' | 'blocked' | 'refetch_failed'`.

The first draft of this lane put the phase in the effect's own dependency array and called `setPhase` inside it; React then ran the cleanup, set the cancel flag, and the poll it had just started returned early, pinning the page on the spinner forever. This hook latches on a ref keyed by the proposal id and cancels only on unmount. The test below pins that.

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/proposal/proposalView/useSettle.test.js
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSettle } from './useSettle';

const paidRow = { id: 774, status: 'balance_paid', amount_paid: '550', total_price: '550' };
const staleRow = { id: 774, status: 'accepted', amount_paid: '0', total_price: '350' };
const flush = () => new Promise((r) => setTimeout(r, 0));

// settlePoll sleeps 1.5s between attempts; the hook must accept an injected
// poll interval so these tests stay fast. 0ms is enough to yield the event loop.
const fast = { intervalMs: 0 };

test('a row already in a paid state goes straight to paid without polling or refetching', async () => {
  const fetchState = jest.fn();
  const fetchProposal = jest.fn();
  const onSettled = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: paidRow, fetchState, fetchProposal, onSettled, onFallback: jest.fn(), ...fast }));
  await waitFor(() => expect(result.current).toBe('paid'));
  expect(fetchState).not.toHaveBeenCalled();
  expect(fetchProposal).not.toHaveBeenCalled();
  expect(onSettled).not.toHaveBeenCalled();
});

test('inactive (no redirect) stays idle', async () => {
  const { result } = renderHook(() => useSettle({ active: false, proposal: staleRow, fetchState: jest.fn(), fetchProposal: jest.fn(), onSettled: jest.fn(), onFallback: jest.fn(), ...fast }));
  await flush();
  expect(result.current).toBe('idle');
});

test('a stale row settles on the third poll, refetches once, and survives its own state changes', async () => {
  const states = [{ status: 'accepted' }, { status: 'accepted' }, { status: 'balance_paid' }];
  let i = 0;
  const fetchState = jest.fn(async () => states[i++]);
  const fetchProposal = jest.fn(async () => paidRow);
  const onSettled = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal, onSettled, onFallback: jest.fn(), ...fast }));
  await waitFor(() => expect(result.current).toBe('settling'));
  await waitFor(() => expect(result.current).toBe('paid'));
  expect(fetchState).toHaveBeenCalledTimes(3);
  expect(fetchProposal).toHaveBeenCalledTimes(1);
  expect(onSettled).toHaveBeenCalledWith(paidRow);
});

test('an exhausted poll reaches fallback with the reason', async () => {
  const fetchState = jest.fn(async () => ({ status: 'accepted' }));
  const onFallback = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal: jest.fn(), onSettled: jest.fn(), onFallback, attempts: 3, ...fast }));
  await waitFor(() => expect(result.current).toBe('fallback'));
  expect(fetchState).toHaveBeenCalledTimes(3);
  expect(onFallback).toHaveBeenCalledWith('exhausted');
});

test('a blocked poll (4xx) reaches fallback at once', async () => {
  const fetchState = jest.fn(async () => { throw Object.assign(new Error('429'), { response: { status: 429 } }); });
  const onFallback = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal: jest.fn(), onSettled: jest.fn(), onFallback, ...fast }));
  await waitFor(() => expect(result.current).toBe('fallback'));
  expect(fetchState).toHaveBeenCalledTimes(1);
  expect(onFallback).toHaveBeenCalledWith('blocked');
});

test('a settled poll whose refetch fails reaches fallback, never renders the stale row as paid', async () => {
  const fetchState = jest.fn(async () => ({ status: 'balance_paid' }));
  const fetchProposal = jest.fn(async () => { throw new Error('network'); });
  const onFallback = jest.fn();
  const onSettled = jest.fn();
  const { result } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal, onSettled, onFallback, ...fast }));
  await waitFor(() => expect(result.current).toBe('fallback'));
  expect(onSettled).not.toHaveBeenCalled();
  expect(onFallback).toHaveBeenCalledWith('refetch_failed');
});

test('the parent re-rendering with a fresh proposal object does not restart the settle', async () => {
  const fetchState = jest.fn(async () => ({ status: 'balance_paid' }));
  const fetchProposal = jest.fn(async () => paidRow);
  const { result, rerender } = renderHook((props) => useSettle(props), {
    initialProps: { active: true, proposal: staleRow, fetchState, fetchProposal, onSettled: jest.fn(), onFallback: jest.fn(), ...fast },
  });
  await waitFor(() => expect(result.current).toBe('paid'));
  await act(async () => { rerender({ active: true, proposal: { ...paidRow }, fetchState, fetchProposal, onSettled: jest.fn(), onFallback: jest.fn(), ...fast }); });
  await flush();
  expect(fetchState).toHaveBeenCalledTimes(1);
  expect(fetchProposal).toHaveBeenCalledTimes(1);
  expect(result.current).toBe('paid');
});

test('unmount cancels an in-flight poll', async () => {
  let resolveFirst;
  const fetchState = jest.fn(() => new Promise((r) => { resolveFirst = r; }));
  const onFallback = jest.fn();
  const onSettled = jest.fn();
  const { result, unmount } = renderHook(() => useSettle({ active: true, proposal: staleRow, fetchState, fetchProposal: jest.fn(), onSettled, onFallback, ...fast }));
  await waitFor(() => expect(result.current).toBe('settling'));
  unmount();
  await act(async () => { resolveFirst({ status: 'balance_paid' }); await flush(); });
  expect(onSettled).not.toHaveBeenCalled();
  expect(onFallback).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=useSettle --watchAll=false`
Expected: FAIL, "Cannot find module './useSettle'".

- [ ] **Step 3: Write the hook**

```js
// client/src/pages/proposal/proposalView/useSettle.js
import { useEffect, useRef, useState } from 'react';
import { isPaidState } from './paidState';
import { pollPaymentState } from './settlePoll';

// Owns the post-redirect phase: 'idle' | 'settling' | 'paid' | 'fallback'.
//
// Latched on a ref keyed by proposal id so the settle runs ONCE per loaded
// proposal, and cancelled ONLY on unmount. An earlier draft kept the phase in
// the effect's dependency array and set it inside the effect; React then ran
// the cleanup on the resulting re-render, flipped the cancel flag, and the
// poll it had just started returned early, pinning the page on the spinner
// forever. useSettle.test.js pins that this cannot recur.
export function useSettle({
  active, proposal, fetchState, fetchProposal, onSettled, onFallback,
  attempts = 13, intervalMs = 1500,
}) {
  const [phase, setPhase] = useState('idle');
  const startedFor = useRef(null);
  const mounted = useRef(true);
  const latest = useRef({ fetchState, fetchProposal, onSettled, onFallback });
  latest.current = { fetchState, fetchProposal, onSettled, onFallback };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const proposalId = proposal ? proposal.id : null;
  const status = proposal ? proposal.status : null;

  useEffect(() => {
    if (!active || proposalId == null) return;
    if (startedFor.current === proposalId) return;
    startedFor.current = proposalId;

    if (isPaidState(status)) {
      setPhase('paid');
      return;
    }
    setPhase('settling');
    (async () => {
      const { state, reason } = await pollPaymentState({
        fetchState: () => latest.current.fetchState(),
        attempts, intervalMs,
        isCancelled: () => !mounted.current,
      });
      if (!mounted.current) return;
      if (!state) {
        if (reason !== 'cancelled') {
          setPhase('fallback');
          latest.current.onFallback(reason);
        }
        return;
      }
      try {
        const fresh = await latest.current.fetchProposal();
        if (!mounted.current) return;
        latest.current.onSettled(fresh);
        setPhase('paid');
      } catch {
        if (!mounted.current) return;
        setPhase('fallback');
        latest.current.onFallback('refetch_failed');
      }
    })();
  }, [active, proposalId, status, attempts, intervalMs]);

  return phase;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=useSettle --watchAll=false`
Expected: PASS, 8 tests. If the "goes straight to paid" test sees `'idle'`, the hook is setting state before the first effect; the `waitFor` covers the effect tick.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/useSettle.js client/src/pages/proposal/proposalView/useSettle.test.js
git commit -F - <<'MSG'
feat(proposal-pay): useSettle, the ref-latched hook that owns the post-redirect phase

Runs once per loaded proposal, cancels only on unmount. The first draft of
this lane kept the phase in its own effect's dependency array and cancelled
the poll it had just started; the test here pins that a parent re-render or
the hook's own state change cannot restart or kill the settle.
MSG
```

---

### Task 4: The read endpoint and the token-keyed limiters

**Files:**
- Modify: `server/middleware/rateLimiters.js` (two new limiters, exported)
- Modify: `server/routes/proposals/publicToken.js` (new route below `/t/:token/resolve`; `publicLimiter` swapped on `/t/:token/resolve` and `/t/:token`)
- Modify: `server/routes/stripeCreateIntent.js` (`publicLimiter` swapped on `/create-intent/:token`)
- Test: `server/routes/proposals/publicToken.paymentState.test.js`

**Interfaces:**
- Produces: `GET /api/proposals/t/:token/payment-state` returning `{ status, amount_paid, total_price, payment_type }` (dollars as numbers), 404 on unknown or archived. Non-mutating. `proposalPollLimiter` (40 per 15 min per token) and `proposalCheckoutLimiter` (60 per 15 min per token) exported from `rateLimiters.js`.

- [ ] **Step 1: Write the failing test**

```js
// server/routes/proposals/publicToken.paymentState.test.js
// The poll target for the post-checkout settle state (spec §3c). Its contract
// is "tell me the row's payment state and touch NOTHING": the full GET bumps
// view_count and logs a view on every call, and thirteen polls recording
// thirteen views would fake engagement. And it must live on a token-keyed
// limiter: publicLimiter is 20 per 15 minutes per IP, and a settle spends 13.
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

test('twenty-one calls on one token from one IP all succeed and bump nothing', async () => {
  const p = await insertProposal({ status: 'sent' });
  for (let i = 0; i < 21; i += 1) {
    const r = await get(`/api/proposals/t/${p.token}/payment-state`);
    assert.equal(r.status, 200, `call ${i + 1} returned ${r.status}: publicLimiter would have 429d at 21`);
  }
  const row = (await pool.query('SELECT status, view_count, last_viewed_at FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(row.status, 'sent', 'the sent->viewed flip belongs to the full GET, not this one');
  assert.equal(Number(row.view_count || 0), 0);
  assert.equal(row.last_viewed_at, null);
  const views = (await pool.query(
    "SELECT count(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'viewed'", [p.id]
  )).rows[0].n;
  assert.equal(views, 0);
});

test('404 on an archived proposal and on an unknown token, from OUR handler, not Express', async () => {
  // Assert the body too: with no route at all Express also 404s, with no
  // JSON body, and this test would pass by accident.
  const p = await insertProposal({ status: 'archived' });
  const a = await get(`/api/proposals/t/${p.token}/payment-state`);
  assert.equal(a.status, 404);
  assert.equal(a.body && a.body.error, 'This proposal is no longer available');
  const u = await get(`/api/proposals/t/${crypto.randomUUID()}/payment-state`);
  assert.equal(u.status, 404);
  assert.equal(u.body && u.body.error, 'This proposal is no longer available');
});

test('a malformed token is rejected, not looked up', async () => {
  const r = await get('/api/proposals/t/not-a-uuid/payment-state');
  assert.ok(r.status === 400 || r.status === 404, `got ${r.status}`);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/routes/proposals/publicToken.paymentState.test.js`
Expected: `pass 1`, `fail 3`. The first test 404s (no route), the 21-call loop fails at call 1, and the archived/unknown test fails on the body assertion (Express's own 404 has no JSON body). Only the malformed-token test passes at this point.

- [ ] **Step 3: Add the two limiters**

In `server/middleware/rateLimiters.js`, directly below the `switchLimiter` definition, add:

```js
// The proposal checkout (spec 2026-08-28 §3c). GET /t/:token, its /resolve,
// and POST /stripe/create-intent/:token all drew on publicLimiter, 20 per 15
// minutes PER IP: a page load spends three, every option/autopay/gratuity
// change spends one, a failed sign's recovery spends two. One real client
// retrying a blocked checkout (2026-08-28, proposal 774) spent about eighteen.
// Keyed by token, same law as optionsQuoteLimiter: browsing must never be able
// to spend the budget that paying depends on.
const proposalCheckoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many requests. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// The post-checkout settle poll: thirteen reads at 1.5s while the webhook
// commits. Its own bucket so a settle can never spend the checkout's budget.
const proposalPollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  keyGenerator: (req) => req.params?.token || req.ip,
  message: { error: 'Too many requests. Please try again in a moment.' },
  standardHeaders: true,
  legacyHeaders: false,
});
```

Add `proposalCheckoutLimiter,` and `proposalPollLimiter,` to `module.exports` in that file (after `switchLimiter,`).

- [ ] **Step 4: Add the route and swap the limiters in `publicToken.js`**

The `require('../../middleware/rateLimiters')` line at the top of `server/routes/proposals/publicToken.js` (line 4) destructures `publicLimiter` and `signLimiter`. After the two swaps below `publicLimiter` has no remaining use in this file (its only uses were lines 40 and 245), so the line becomes:

```js
const { signLimiter, proposalCheckoutLimiter, proposalPollLimiter } = require('../../middleware/rateLimiters');
```

(`publicLimiter` stays exported from `rateLimiters.js`; eight other server files still use it.)

Change the resolve route's middleware from `publicLimiter` to `proposalCheckoutLimiter`:

```js
router.get('/t/:token/resolve', proposalCheckoutLimiter, requireUuidToken, asyncHandler(async (req, res) => {
```

Change the full GET's middleware the same way (find `router.get('/t/:token', publicLimiter, requireUuidToken,` and replace `publicLimiter` with `proposalCheckoutLimiter`).

Insert directly after the closing `}));` of the `/t/:token/resolve` route:

```js
/** GET /api/proposals/t/:token/payment-state — NON-mutating. The poll target
 *  for the post-checkout settle state (spec 2026-08-28 §3c). Returns only the
 *  row's payment state, in dollars, and touches NOTHING: no view_count bump,
 *  no last_viewed_at, no sent->viewed flip, no activity row. The full GET does
 *  all four on every call, and a thirteen-attempt poll against it would record
 *  thirteen views of a page the client is staring at once. 404 on archived is
 *  stated here on its own; /resolve above is deliberately status-blind. */
router.get('/t/:token/payment-state', proposalPollLimiter, requireUuidToken, asyncHandler(async (req, res) => {
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

- [ ] **Step 5: Swap the limiter on create-intent**

In `server/routes/stripeCreateIntent.js`, change the require on line 14, `const { publicLimiter } = require('../middleware/rateLimiters');`, to `const { proposalCheckoutLimiter } = require('../middleware/rateLimiters');` and the route line's (line 28) `publicLimiter` to `proposalCheckoutLimiter`. Those are its only two uses in the file. Note the invoice rails (`POST /api/stripe/create-intent-for-invoice/:token` in `stripe.js` and `GET /api/invoices/t/:token`) stay on `publicLimiter`; the invoice page is out of scope for this lane (spec §3f).

- [ ] **Step 6: Run the test to verify it passes**

Run (from repo root): `node --test server/routes/proposals/publicToken.paymentState.test.js`
Expected: `pass 4`, `fail 0`.

- [ ] **Step 7: Run the neighbouring suites, one at a time**

Run: `node --test server/routes/proposals/publicToken.test.js`, then `node --test server/routes/proposals/publicToken.signTotal.test.js`, then `node --test server/routes/stripe.invoiceIntentArchived.test.js`
Expected: `pass 12`, `pass 4`, and the third file's full count, all `fail 0`.

- [ ] **Step 8: Commit**

```bash
git add server/middleware/rateLimiters.js server/routes/proposals/publicToken.js server/routes/stripeCreateIntent.js server/routes/proposals/publicToken.paymentState.test.js
git commit -F - <<'MSG'
feat(proposals): a non-mutating payment-state read, and the checkout leaves the shared IP bucket

payment-state returns status, amount_paid, total_price and payment_type in
dollars and nothing else: the full GET bumps view_count, stamps last_viewed_at,
flips sent to viewed and logs a view on every call, so a bounded poll against
it would record thirteen views of one page load. Pinned: twenty-one calls on
one token leave all four untouched and none 429.

The proposal GET, its resolve, and create-intent move from publicLimiter (20
per 15 minutes per IP) to a token-keyed checkout limiter. One real client
retrying a blocked checkout on 2026-08-28 spent about eighteen of that
twenty. Browsing must never be able to spend the budget that paying depends on.
MSG
```

---

### Task 5: The sign route stops failing silently

**Files:**
- Modify: `server/routes/proposals/publicToken.js` (the `POST /t/:token/sign` handler: the `!upd.rows[0]` branch and the `signed` activity insert)
- Test: `server/routes/proposals/publicToken.signTotal.test.js` (extend)

**Interfaces:**
- Produces: on a 409 (`TOTAL_CHANGED` or `ALREADY_ACCEPTED`) a `proposal_activity_log` row `sign_failed` with details `{ code, acknowledged_total }` and, when `SENTRY_DSN_SERVER` is set, a `Sentry.captureMessage('proposal_sign_failed', ...)`. On success the `signed` row's details gain `acknowledged_total`.

- [ ] **Step 1: Write the failing tests**

Append to `server/routes/proposals/publicToken.signTotal.test.js`, before the existing `after(...)` block if the file orders it last, otherwise at the end (node:test registers `after` regardless of position):

```js
test('a TOTAL_CHANGED 409 writes a sign_failed activity row carrying the code and the acknowledged total', async () => {
  const p = await insertSignableProposal();
  const r = await request('POST', `/api/proposals/t/${p.token}/sign`, { body: signBody({ acknowledged_total: 999 }) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'TOTAL_CHANGED');
  const rows = (await pool.query(
    "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'sign_failed'", [p.id]
  )).rows;
  assert.equal(rows.length, 1, 'exactly one sign_failed row');
  assert.equal(rows[0].details.code, 'TOTAL_CHANGED');
  assert.equal(Number(rows[0].details.acknowledged_total), 999);
  const views = (await pool.query(
    "SELECT count(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'viewed'", [p.id]
  )).rows[0].n;
  assert.equal(views, 0, 'a failed sign is not a view');
});

test('a successful sign records the acknowledged total in the signed row', async () => {
  const p = await insertSignableProposal();
  const r = await request('POST', `/api/proposals/t/${p.token}/sign`, { body: signBody({ acknowledged_total: 500 }) });
  assert.equal(r.status, 200);
  const row = (await pool.query(
    "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'signed'", [p.id]
  )).rows[0];
  assert.equal(Number(row.details.acknowledged_total), 500);
});
```

Note: the sign limiter allows 10 per hour per IP. The file's header comment says it makes 4 sign POSTs; it actually makes 5 (the last test posts twice). These two make 7. Under the cap, with a margin of 3; do not add a third sign POST to this file.

- [ ] **Step 2: Run the test to verify it fails**

Run (from repo root): `node --test server/routes/proposals/publicToken.signTotal.test.js`
Expected: `pass 4`, `fail 2` (no `sign_failed` row; `acknowledged_total` undefined in details).

- [ ] **Step 3: Write the telemetry**

In the sign handler's `if (!upd.rows[0]) {` branch, the code currently throws `ConflictError` in two places. Replace that whole `if (!upd.rows[0]) { ... }` block with:

```js
  if (!upd.rows[0]) {
    // Disambiguate: a still-signable row can only have failed the total
    // assertion, so tell the client to re-review rather than lying that it
    // was already accepted.
    let code = 'ALREADY_ACCEPTED';
    let message = 'This proposal has already been accepted';
    if (ackGiven) {
      const re = await pool.query(
        'SELECT client_signed_at, status FROM proposals WHERE id = $1',
        [lookup.rows[0].id]
      );
      const r = re.rows[0];
      const stillSignable = r && !r.client_signed_at
        && !['accepted', 'deposit_paid', 'balance_paid', 'confirmed', 'completed', 'archived'].includes(r.status);
      if (stillSignable) {
        code = 'TOTAL_CHANGED';
        message = 'The total for this proposal has changed. Please review the updated price and sign again.';
      }
    }
    // A blocked signature must never be silent (spec 2026-08-28 §3e). For a
    // week in August every gratuity-electing client 409'd here and the only
    // trace was a run of 'viewed' rows from the recovery refetch, which read
    // as engagement. Breadcrumb it as what it is, and page Sentry.
    await pool.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'sign_failed', 'client', $2)`,
      [lookup.rows[0].id, JSON.stringify({ code, acknowledged_total: ackGiven ? ackTotal : null })]
    ).catch((err) => console.error('sign_failed activity log failed (non-blocking):', err.message));
    if (process.env.SENTRY_DSN_SERVER) {
      Sentry.captureMessage('proposal_sign_failed', {
        level: 'warning',
        tags: { route: 'proposals/sign', code, proposal_id: String(lookup.rows[0].id) },
        extra: { acknowledged_total: ackGiven ? ackTotal : null },
      });
    }
    throw new ConflictError(message, code);
  }
```

Then find the `signed` activity insert (the line `VALUES ($1, 'signed', 'client', $2)`) and add `acknowledged_total: ackGiven ? ackTotal : null` to the JSON object it stringifies (alongside `signed_name`, `signature_method`, `phone_updated`).

- [ ] **Step 4: Run the test to verify it passes**

Run (from repo root): `node --test server/routes/proposals/publicToken.signTotal.test.js`
Expected: `pass 6`, `fail 0`. Then `node --test server/routes/proposals/publicToken.test.js`: `pass 12`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/publicToken.js server/routes/proposals/publicToken.signTotal.test.js
git commit -F - <<'MSG'
feat(proposals): a blocked signature writes sign_failed and pages Sentry

For a week in August every gratuity-electing client 409d at the sign-time
total assertion and the only trace was a run of viewed rows from the
recovery refetch, which read as engagement. The 409 now breadcrumbs itself
with its code and the acknowledged total, and the signed row records the
dollar figure the signature bound.
MSG
```

---

### Task 6: `PaidCard.js`, the card with settling and fallback phases

**Files:**
- Create: `client/src/pages/proposal/proposalView/PaidCard.js`
- Test: `client/src/pages/proposal/proposalView/PaidCard.test.js`

**Interfaces:**
- Consumes: `paidState()` shape from Task 1; `fmt`, `formatDateShort` from `./helpers`.
- Produces: `<PaidCard phase state autopayEnrolled balanceDueDate openInvoiceToken drinkPlanToken onRefresh />`, `phase` in `'settling' | 'fallback' | 'paid'`.

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/proposal/proposalView/PaidCard.test.js
import React from 'react';
import { render, screen } from '@testing-library/react';
import PaidCard from './PaidCard';

const full = { kind: 'full', amountPaid: 550, total: 550, remaining: 0, completed: false };
const done = { kind: 'full', amountPaid: 550, total: 550, remaining: 0, completed: true };
const deposit = { kind: 'deposit', amountPaid: 100, total: 550, remaining: 450, completed: false };
const none = { kind: 'none', amountPaid: 0, total: 350, remaining: 350, completed: false };
const base = { autopayEnrolled: false, balanceDueDate: '2026-09-12', openInvoiceToken: 'tok', drinkPlanToken: null, onRefresh: () => {} };

test('settling shows no dollar figure, no pay link, and no claim about the payment', () => {
  const { container } = render(<PaidCard phase="settling" state={none} {...base} />);
  expect(container.textContent).toMatch(/Confirming your payment/);
  expect(container.textContent).not.toMatch(/\$/);
  expect(container.textContent).not.toMatch(/went through|received|confirmed/i);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
});

test('fallback asserts nothing, shows no dollar figure or pay link, and offers refresh', () => {
  const onRefresh = jest.fn();
  const { container } = render(<PaidCard phase="fallback" state={none} {...base} onRefresh={onRefresh} />);
  expect(container.textContent).toMatch(/still confirming your payment/i);
  expect(container.textContent).not.toMatch(/\$/);
  expect(container.textContent).not.toMatch(/went through|on its way/i);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
  screen.getByRole('button', { name: /Refresh/ }).click();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('paid + full renders Fully paid, the closer-to-the-date line, and no balance', () => {
  const { container } = render(<PaidCard phase="paid" state={full} {...base} openInvoiceToken={null} drinkPlanToken="dp" />);
  expect(container.textContent).toMatch(/Fully paid\./);
  expect(container.textContent).toMatch(/closer to the date/);
  expect(container.textContent).not.toMatch(/remaining balance/i);
  expect(screen.getByText(/Open the Potion Planner/)).toBeTruthy();
});

test('paid + completed renders Fully paid with a past-tense line, never closer-to-the-date', () => {
  const { container } = render(<PaidCard phase="paid" state={done} {...base} openInvoiceToken={null} />);
  expect(container.textContent).toMatch(/Fully paid\./);
  expect(container.textContent).toMatch(/Thanks for having us/);
  expect(container.textContent).not.toMatch(/closer to the date/);
});

test('paid + deposit renders the remainder, the due date, and the pay link when an invoice is open', () => {
  const { container } = render(<PaidCard phase="paid" state={deposit} {...base} openInvoiceToken="inv-tok" />);
  expect(container.textContent).toMatch(/Deposit received\./);
  expect(container.textContent).toMatch(/\$450\.00/);
  expect(screen.getByText(/Pay balance/).getAttribute('href')).toBe('/invoice/inv-tok');
});

test('paid + deposit + autopay names the automatic charge instead of a due-by', () => {
  const { container } = render(<PaidCard phase="paid" state={deposit} {...base} autopayEnrolled openInvoiceToken={null} />);
  expect(container.textContent).toMatch(/automatically charged/);
  expect(container.textContent).toMatch(/\$450\.00/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=PaidCard --watchAll=false`
Expected: FAIL, "Cannot find module './PaidCard'".

- [ ] **Step 3: Write the component**

The `paid` branch is the existing card block from `ProposalView.js` (the `{isPaid && (...)}` block), moved here with `isFullyPaid` becoming `state.kind === 'full'`, `amount_paid > 0` becoming `state.amountPaid > 0`, `balanceAmount` becoming `state.remaining`, and a `completed` variant.

```js
// client/src/pages/proposal/proposalView/PaidCard.js
import React from 'react';
import { fmt, formatDateShort } from './helpers';

// The card that replaces sign-and-pay once money is involved. Three phases:
//   settling  : a checkout redirect just landed and the row is not yet in a
//               paid state. NO dollar figure, no pay link, no claim.
//   fallback  : the poll budget ran out or was blocked. Still no numbers and
//               still no claim: a webhook that rolled back produces exactly
//               this state, so "your payment went through" would be a lie.
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
        <h3 className="proposal-paid-title">We are still confirming your payment.</h3>
        <p className="proposal-paid-sub">
          You will get a confirmation email as soon as it clears. If nothing arrives within the hour,
          reply to any of our emails and we will sort it out.
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
            {state.completed
              ? 'This event has wrapped. Thanks for having us.'
              : "Your booking is confirmed. We'll be in touch with event details closer to the date."}
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
      {drinkPlanToken && !state.completed && (
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
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/PaidCard.js client/src/pages/proposal/proposalView/PaidCard.test.js
git commit -F - <<'MSG'
feat(proposal-pay): PaidCard with settling and fallback phases

Settling and fallback render no dollar figure, no pay link, and no claim
about the payment: the fallback is exactly the state a rolled-back webhook
produces. The paid phase is the existing card reading from paidState(), with
a past-tense line for a completed event.
MSG
```

---

### Task 7: `PaymentTermsBox.js`, the terms box that respects the row

**Files:**
- Create: `client/src/pages/proposal/proposalView/PaymentTermsBox.js`
- Modify: `client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js` (replace ONLY the inner Payment Summary markup; keep the outer section div, which also wraps the Potion Planner link and the mobile CTA)
- Test: `client/src/pages/proposal/proposalView/PaymentTermsBox.test.js`

**Interfaces:**
- Consumes: `paidState()` shape from Task 1.
- Produces: `<PaymentTermsBox state settling fullPaymentRequired snapshotTotal balanceAmount balanceDueDate />`, rendering a FRAGMENT (the heading plus the summary div), never its own section wrapper. `state` defaults to the `none` shape so the component is safe before Task 9 wires the prop. `ProposalPricingBreakdown` gains props `paid` and `settling`.

- [ ] **Step 1: Write the failing tests**

```js
// client/src/pages/proposal/proposalView/PaymentTermsBox.test.js
import React from 'react';
import { render } from '@testing-library/react';
import PaymentTermsBox from './PaymentTermsBox';

const none = { kind: 'none', amountPaid: 0, total: 350, remaining: 350, completed: false };
const full = { kind: 'full', amountPaid: 550, total: 550, remaining: 0, completed: false };
const deposit = { kind: 'deposit', amountPaid: 100, total: 550, remaining: 450, completed: false };
const base = { settling: false, fullPaymentRequired: false, snapshotTotal: 350, balanceAmount: 250, balanceDueDate: '2026-08-29' };

test('settling renders the heading and no money rows at all', () => {
  const { container } = render(<PaymentTermsBox state={none} {...base} settling />);
  expect(container.textContent).toMatch(/Payment Terms/);
  expect(container.textContent).not.toMatch(/\$/);
  expect(container.textContent).not.toMatch(/Deposit Due at Signing/);
});

test('with no state prop at all it renders the pre-payment rows (safe before the parent passes it)', () => {
  const { container } = render(<PaymentTermsBox {...base} />);
  expect(container.textContent).toMatch(/Deposit Due at Signing/);
});

test('unpaid deposit terms render the pre-payment rows exactly as before', () => {
  const { container } = render(<PaymentTermsBox state={none} {...base} />);
  expect(container.textContent).toMatch(/Deposit Due at Signing/);
  expect(container.textContent).toMatch(/\$100\.00/);
  expect(container.textContent).toMatch(/Remaining Balance/);
  expect(container.textContent).toMatch(/\$250\.00/);
});

test('unpaid full-payment-required renders the single full row', () => {
  const { container } = render(<PaymentTermsBox state={none} {...base} fullPaymentRequired />);
  expect(container.textContent).toMatch(/Full Payment Due/);
  expect(container.textContent).toMatch(/\$350\.00/);
  expect(container.textContent).not.toMatch(/Deposit Due at Signing/);
});

test('a paid-in-full row never shows Deposit Due at Signing, even when full payment was required', () => {
  for (const fpr of [false, true]) {
    const { container } = render(<PaymentTermsBox state={full} {...base} fullPaymentRequired={fpr} snapshotTotal={550} balanceAmount={0} />);
    expect(container.textContent).toMatch(/Paid in full/);
    expect(container.textContent).toMatch(/\$550\.00/);
    expect(container.textContent).not.toMatch(/Deposit Due at Signing/);
    expect(container.textContent).not.toMatch(/Remaining Balance/);
    expect(container.textContent).not.toMatch(/Full Payment Due/);
  }
});

test('a deposit-paid row shows what was paid, the true remainder, and the due date', () => {
  const { container } = render(<PaymentTermsBox state={deposit} {...base} snapshotTotal={550} balanceAmount={450} balanceDueDate="2026-09-12" />);
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

const NONE = { kind: 'none', amountPaid: 0, total: 0, remaining: 0, completed: false };

// The "Payment Terms" box under the pricing breakdown. Before payment it
// states the terms (deposit at signing, remainder by the due date). Once the
// ROW is in a paid state it states what happened, from paidState(): never
// "Deposit Due at Signing" on a booking that is paid. While a checkout
// redirect is settling it states nothing numeric at all.
//
// Renders a fragment: the caller's section div wraps this AND the Potion
// Planner link AND the mobile CTA, so this component must not bring its own.
// `state` defaults to the none shape so the component is safe on its own.
export default function PaymentTermsBox({
  state = NONE, settling = false, fullPaymentRequired, snapshotTotal, balanceAmount, balanceDueDate,
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
      <div style={{ ...styles.paymentRow, borderBottom: 'none' }}>
        <span style={styles.paymentLabel}>Paid in full</span>
        <span style={styles.paymentValue}>{fmt(state.amountPaid)}</span>
      </div>
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
    <>
      <h2 style={styles.sectionTitle}>Payment Terms</h2>
      <div style={styles.paymentSummary}>{rows}</div>
    </>
  );
}
```

The `'—'` glyph in the full-payment-required row is the existing placeholder for a missing snapshot, carried over unchanged; it is not prose.

- [ ] **Step 4: Run the test to verify it passes**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=PaymentTermsBox --watchAll=false`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into `ProposalPricingBreakdown.js`, keeping the outer div**

Add the import at the top:

```js
import PaymentTermsBox from './PaymentTermsBox';
```

Add two props to the component signature after `fullPaymentRequired,`:

```js
  paid,
  settling,
```

Inside the JSX, the block begins with the comment `{/* ── Payment Summary (always visible) ── */}` followed by `<div style={styles.section}>`. That section div ALSO contains, further down, the `{/* Potion Planner Link */}` block and the `{/* CTA button — mobile-only ... */}` block, and closes just before `</>`. Do NOT touch the div or those two blocks. Replace only what sits between the opening `<div style={styles.section}>` and the `{/* Potion Planner Link */}` comment, which is exactly: the `<h2 style={styles.sectionTitle}>Payment Terms</h2>` line and the entire `<div style={styles.paymentSummary}> ... </div>` element (the one holding the `fullPaymentRequired ? (...) : (...)` ternary). Put in their place:

```jsx
        <PaymentTermsBox
          state={paid}
          settling={settling}
          fullPaymentRequired={fullPaymentRequired}
          snapshotTotal={snapshot ? snapshot.total : null}
          balanceAmount={balanceAmount}
          balanceDueDate={balanceDueDate}
        />
```

After the edit, the section reads: opening div, `<PaymentTermsBox .../>`, Potion Planner block, CTA block, closing div. Then in the `./helpers` import at the top of `ProposalPricingBreakdown.js`, remove BOTH `formatDateShort` and `DEPOSIT_DOLLARS` (their only uses were inside the replaced markup; `fmt` stays, it is used by the line items). Confirm with `grep -n "formatDateShort\|DEPOSIT_DOLLARS" client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js` returning nothing.

- [ ] **Step 6: Run the proposal client suites and a build**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=proposal --watchAll=false`
Expected: all suites PASS.

Run (from `client/`): `CI=true npx react-scripts build 2>&1 | grep -iE "error|warning|Compiled" | head`
Expected: `Compiled with warnings.` with ONLY the pre-existing `html2pdf.js ... SVGPathData.module.js.map` source-map line. Any `no-unused-vars` on this lane's files must be fixed before commit. The page renders at this commit because `PaymentTermsBox` defaults `state`.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/proposal/proposalView/PaymentTermsBox.js client/src/pages/proposal/proposalView/PaymentTermsBox.test.js client/src/pages/proposal/proposalView/ProposalPricingBreakdown.js
git commit -F - <<'MSG'
feat(proposal-pay): the Payment Terms box states what happened once the row is paid

Before payment it states the terms. Once the row is in a paid state it states
what was paid and what remains, from paidState(). Never "Deposit Due at
Signing" on a paid booking, including one that was sent as full-payment
terms, and nothing numeric while a checkout redirect is still settling.
Defaults its state so the page renders before the parent passes it.
MSG
```

---

### Task 8: `intentQuote` keeps the gratuity basis on a null quote

**Files:**
- Modify: `client/src/pages/proposal/proposalView/intentQuote.js`
- Test: `client/src/pages/proposal/proposalView/intentQuote.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `intentQuote.test.js`:

```js
test('a null gratuity in the quote keeps the prior gratuity block (staff_count, hours, floor_rate drive the floor gate)', () => {
  const prior = { ...row, pricing_snapshot: { ...row.pricing_snapshot, gratuity: { rate: 0, total: 0, tip_jar: true, staff_count: 2, hours: 4, floor_rate: null } } };
  const next = applyIntentQuote(prior, { total_price: 350, gratuity: null });
  expect(next.pricing_snapshot.gratuity).toEqual(prior.pricing_snapshot.gratuity);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=intentQuote --watchAll=false`
Expected: FAIL on the new test (`gratuity` is `null`).

- [ ] **Step 3: Fix the merge**

In `intentQuote.js`, change the `gratuity: quote.gratuity,` line inside the returned `pricing_snapshot` to:

```js
      gratuity: quote.gratuity == null ? (proposal.pricing_snapshot || {}).gratuity : quote.gratuity,
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=intentQuote --watchAll=false`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/proposal/proposalView/intentQuote.js client/src/pages/proposal/proposalView/intentQuote.test.js
git commit -F - <<'MSG'
fix(proposal-pay): a null gratuity quote keeps the snapshot's gratuity basis

The block carries staff_count, hours and floor_rate, which drive the
sign-blocking floor gate. Unreachable today; pinned anyway.
MSG
```

---

### Task 9: Wire `ProposalView.js`: redirect, settle hook, row-truth card, and the shipped fix's follow-ups

**Files:**
- Modify: `client/src/pages/proposal/proposalView/ProposalView.js`
- Modify: `client/src/pages/proposal/proposalView/SignAndPaySection.js` (the two `FormBanner` lines and the two fallback-paragraph conditions)

**Interfaces:**
- Consumes: `paidState`, `isPaidState`, `readRedirect` (Task 1); `useSettle` (Task 3); `PaidCard` (Task 6); `ProposalPricingBreakdown`'s `paid` and `settling` props (Task 7); `payment-state` (Task 4).

This task's behaviour is the composition of Tasks 1 through 7, each of which carries its own tests; Step 8 (full suite), Step 9 (build) and Task 10's manual walk are the checkpoint.

- [ ] **Step 1: Imports**

Below `import { applyIntentQuote } from './intentQuote';` add:

```js
import * as Sentry from '@sentry/react';
import { paidState, readRedirect } from './paidState';
import { useSettle } from './useSettle';
import PaidCard from './PaidCard';
```

Confirm `useMemo` and `useCallback` are in the React import at the top of the file; add whichever is missing.

- [ ] **Step 2: Replace the `paid` flag with the redirect reading**

Replace:

```js
  // Check if returning from Stripe redirect
  const paid = new URLSearchParams(window.location.search).get('paid') === 'true';
```

with:

```js
  // A checkout redirect landed here. `paid` keeps its old name because
  // isPayableStatus and the intent effect key on it, and now means "Stripe
  // sent the client back and did NOT report failure". It does NOT mean the
  // row is paid; the row may not be written yet (spec 2026-08-28 §1a).
  // `pending`/`processing` count as not-failed and settle like a success.
  const { redirected, failed: redirectFailed } = useMemo(() => readRedirect(window.location.search), []);
  const paid = redirected && !redirectFailed;
```

- [ ] **Step 3: Replace the redirect toast with the settle hook**

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
  // Settle after a checkout redirect (spec 2026-08-28 §3b). The first proposal
  // load may have read the row BEFORE the webhook committed; never render its
  // numbers as "paid". useSettle polls the non-mutating payment-state read
  // until the row is in a paid state, refetches the full proposal once, and
  // hands it back; or lands in the fallback, which asserts nothing.
  const fetchPaymentState = useCallback(
    () => axios.get(`${BASE_URL}/proposals/t/${token}/payment-state`).then((r) => r.data),
    [token]
  );
  const fetchFreshProposal = useCallback(
    () => axios.get(`${BASE_URL}/proposals/t/${token}`).then((r) => r.data),
    [token]
  );
  const onSettled = useCallback((fresh) => {
    setProposal(fresh);
    toast.success('Payment received!');
  }, [toast]);
  const onFallback = useCallback((reason) => {
    // A client who sat through the whole poll with no settled row is the one
    // event worth paging on: it is either a slow webhook or a rolled-back one.
    Sentry.captureMessage('proposal_settle_fallback', {
      level: 'warning',
      tags: { proposal_id: String(proposal?.id ?? ''), reason },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal?.id]);
  const settle = useSettle({
    active: paid, proposal, fetchState: fetchPaymentState, fetchProposal: fetchFreshProposal, onSettled, onFallback,
  });
```

- [ ] **Step 4: Derive the card state from the row, not the URL**

Find:

```js
  const inPaidState = ['confirmed', 'deposit_paid', 'balance_paid', 'completed'].includes(proposal.status);
  const balanceAmount = inPaidState
    ? Math.max(0, totalPrice - Number(proposal.amount_paid || 0))
    : totalPrice - DEPOSIT_DOLLARS;
```

Replace with:

```js
  // ROW truth (spec 2026-08-28 §3d). The rendered total (snapshot) is the
  // basis for the remainder, as balanceAmount always was; the row's
  // total_price decides full-vs-deposit, as isFullyPaid always did.
  const paidInfo = paidState(proposal, totalPrice);
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
  // ROW truth only. The URL opens the settling state; it never renders the
  // paid card by itself.
  const isPaid = paidInfo.kind !== 'none';
  const settling = settle === 'settling' || settle === 'fallback';
```

Find and replace the two show flags:

```js
  const showSignAndPay = !isPaid && !settling && !isAlreadySigned && ['sent', 'viewed'].includes(proposal.status);
```

```js
  const showPayOnly = !isPaid && !settling && isAlreadySigned && proposal.status === 'accepted';
```

(Without `!settling` on `showPayOnly`, a signed-but-unsettled row, which is exactly Mike's `accepted` row, renders the pay-only section beside the settling card with no client secret and the red "Unable to load payment form" line.)

Delete the two lines:

```js
  const isFullyPaid = proposal.status === 'balance_paid' ||
    Number(proposal.amount_paid || 0) >= Number(proposal.total_price || 0) - 0.01;
```

- [ ] **Step 5: Pass the new props and swap in the card**

In `<ProposalPricingBreakdown ... />`, after `fullPaymentRequired={fullPaymentRequired}` add:

```jsx
              paid={paidInfo}
              settling={settling}
```

In `<aside className="proposal-pay-rail">`, directly above `{showSignAndPay && (`, add:

```jsx
            {redirectFailed && (
              <p className="payment-policy-warn" role="status">
                That payment did not go through. Nothing was charged. You can try again below.
              </p>
            )}
```

Replace the whole block from `{/* ── Paid state success card (replaces sign-and-pay) ── */}` through the closing `)}` of `{isPaid && (` (the block ends just before `</aside>`) with:

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

- [ ] **Step 6: The shipped fix's follow-ups (spec §3e)**

(a) In `adoptSwitch`, in BOTH the `if (unknown) { ... }` branch and the normal branch, add `setFormError('');` beside the existing `setDepositSecret(''); setFullSecret('');` lines. In `handleUndo`, add `setFormError('');` beside the same pair in its `r.ok` branch.

(b) In the intent effect, move the line `setIntentError('');` (with its comment) to ABOVE the `if (gratuityBelowFloor) { setLoadingIntent(false); return; }` guard.

(c) In `handleSign`, replace the comment block above `acknowledged_total: Number(proposal.total_price),` (the one beginning `// ARMS the server's sign-time total assertion.`) with:

```js
        // The ROW total the server last returned, which is what the sign
        // UPDATE re-asserts (publicToken.js: ABS(total_price - $14) < 0.005).
        // NOT the rendered total: the page renders pricing_snapshot.total,
        // which may exceed this by the in-memory gratuity election that
        // create-intent projects and never persists (see intentQuote.js).
        // Only a real row rewrite (the options switch, which reseeds from
        // the server payload) moves this value. Sending the projection here
        // 409'd every gratuity-electing signature for a week in August.
```

(d) In `SignAndPaySection.js`, change both `<FormBanner error={formError || intentError} fieldErrors={fieldErrors} />` lines to:

```jsx
<FormBanner error={[formError, intentError].filter(Boolean).join(' ')} fieldErrors={fieldErrors} />
```

Leave both fallback-paragraph conditions (`!activeSecret && !loadingIntent && !formError && !intentError`) exactly as they are: `SignAndPaySection.errors.test.js` pins that the "contact us" paragraph stays suppressed while EITHER banner is up, so the client never gets two competing explanations, and the joined banner already carries the intent message (with its own "Please refresh the page" instruction) whenever both errors exist, so a failed sign followed by a failed load is no longer a dead end. Then in `SignAndPaySection.errors.test.js`, the test `'a sign error wins over a stale intent error, and never doubles up'` now expects one alert whose text contains BOTH messages: change its last assertion to `expect(alerts[0].textContent).toBe(`${SIGN_MSG} ${LOAD_MSG}`);` and rename it `'a sign error and an intent error both show, in one banner'`. Every other test in that file passes unchanged.

- [ ] **Step 7: Run the proposal suites**

Run (from `client/`): `CI=true npx react-scripts test --testPathPattern=proposal --watchAll=false`
Expected: all PASS.

- [ ] **Step 8: Run the full client suite**

Run (from `client/`): `CI=true npx react-scripts test --watchAll=false`
Expected: every suite PASS. Baseline on main before this lane: `Test Suites: 95 passed, 95 total; Tests: 824 passed, 824 total` (one of the 95 is a `.test.jsx`). Expect **100 suites** (paidState, settlePoll, useSettle, PaidCard, PaymentTermsBox) and **864 tests** (824 + 39 in the new files + 1 appended to intentQuote in Task 8). Zero failures.

- [ ] **Step 9: Build with warnings as errors**

Run (from `client/`): `CI=true npx react-scripts build 2>&1 | grep -iE "error|warning|Compiled" | head`
Expected: `Compiled with warnings.` with only the pre-existing `html2pdf.js` source-map line, plus a node `[DEP0176] DeprecationWarning: fs.F_OK` line that is node's, not this lane's. The build exits 0. Any `react-hooks/exhaustive-deps` or `no-unused-vars` warning on this lane's files fails the Vercel gate; fix it before commit.

- [ ] **Step 10: Commit**

```bash
git add client/src/pages/proposal/proposalView/ProposalView.js client/src/pages/proposal/proposalView/SignAndPaySection.js client/src/pages/proposal/proposalView/SignAndPaySection.errors.test.js
git commit -F - <<'MSG'
fix(proposal-pay): the paid flag opens a settling state; the card renders from the row

After a checkout redirect the page no longer combines the URL's paid flag
with whatever row it happened to read. useSettle polls the payment-state
read until the row is in a paid state, refetches once, and renders from
that. Until then: "Confirming your payment" and no numbers. Past the budget:
a fallback that asserts nothing and pages Sentry. A redirect Stripe reports
as failed renders as an unpaid visit with a plain note; pending and
processing settle like a success.

Also from the fleet on the shipped fix: a stale sign error no longer
survives an options switch, the acknowledged_total comment says what the
field carries, a stale intent error no longer survives the below-floor
state, and both error messages show when both exist.

Mike Boswell's page load on 2026-08-28 read the row 0.4 seconds before the
webhook committed and told him he had paid 100 dollars and owed 250 by the
next day. This is the fix for that.
MSG
```

---

### Task 10: Docs, gate, and hand back

**Files:**
- Modify: `README.md` (the `proposalView/` enumeration on the `proposal/` tree line, around line 623)
- Modify: `ARCHITECTURE.md` (the proposal public-route table, around line 352 to 374)
- Modify: `docs/walkthroughs-owed.md` (the Tier 1 entry beginning `- [ ] **Sign-and-pay WITH a gratuity, end to end.`)

- [ ] **Step 1: README**

On the `proposal/` tree line that enumerates `proposalView/` modules, add after `helpers + styles`: ` + paidState.js (row truth for the paid card and terms box; readRedirect) + settlePoll.js (bounded post-redirect poll) + useSettle.js (ref-latched settle phase) + PaidCard.js + PaymentTermsBox.js + intentQuote.js (merges a create-intent quote into the SNAPSHOT only; the projection never touches proposal.total_price) + gratuityFloor.js`.

- [ ] **Step 2: ARCHITECTURE**

In the proposal public-route table, directly under the `/t/:token/resolve` row (around line 370), add a row for `GET /api/proposals/t/:token/payment-state`: non-mutating, `proposalPollLimiter` (40/15min/token), returns `{ status, amount_paid, total_price, payment_type }` in dollars, 404 on unknown or archived; the poll target for the post-checkout settle state. The existing `/t/:token` (around 352), `/t/:token/resolve` (around 370) and `POST /create-intent/:token` (around 403) rows do not name a limiter today; ADD a note to each that it sits on `proposalCheckoutLimiter` (60/15min/token), moved off `publicLimiter` 2026-08-28.

- [ ] **Step 3: Walkthrough**

Inside the Tier 1 entry, after the paragraph beginning `**What to watch:**`, add:

```
      **Added 2026-08-28 (lane pay-settle-page):** watch the REDIRECT, not a reload (a reload
      was always right). The page after checkout must show "Confirming your payment" with NO
      dollar figure, then settle to "Fully paid." with the with-tip amount within a few
      seconds. The Payment Terms box must read "Paid in full" and never "Deposit Due at
      Signing". Then, on a dev proposal: force a 409 (edit the row total in another window
      between render and sign-click) and confirm the client SEES "Your total changed while
      this page was open", and that a sign_failed row lands in proposal_activity_log.
```

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md docs/walkthroughs-owed.md
git commit -F - <<'MSG'
docs: the settle state, its endpoint and limiters, and the walk that watches the redirect

Watch the redirect, not a reload. A reload was always right.
MSG
```

- [ ] **Step 5: Gate and hand back**

Run (from the lane root): `npm run gate`
Expected: `gate PASSED (client + money)`. The money smoke needs `NEON_API_KEY` in the environment; if it is missing the gate says so rather than passing.

Then stop. Review is the FULL pre-prod fleet plus `/second-opinion` (spec §7; `publicToken.js` is a sensitive path). The push cue gates the push, never the review. Report the lane tip sha.

---

## Self-review against the spec

- §3a: Task 1 (`readRedirect`, `failed` only on `redirect_status=failed`), Task 9 Steps 2, 4, 5 (`paid` = not-failed, `isPaid` from row, `showSignAndPay`/`showPayOnly` gated on `!settling`, failed note only on `redirectFailed`, `PAID_STATES` with `completed`).
- §3b: Task 2 (4xx stops, 5xx misses), Task 3 (ref latch, once per proposal, cancel on unmount only; pinned), Task 6 (settling and fallback copy assert nothing), Task 9 Step 3 (Sentry on fallback).
- §3c: Task 4 (endpoint, both limiters, checkout off `publicLimiter`, 21-call pin).
- §3d: Task 1 (two sources), Task 6 (completed copy), Task 7 (full beats `fullPaymentRequired`; no Paid on).
- §3e: Task 5 (sign telemetry), Task 8 (gratuity basis), Task 9 Step 6 (formError clears, comment, intentError order, joined banner).
- §3f: nothing touches `InvoicePage.js` or `ConfirmationStep.js`.
- §6 lane 1: every bullet has a test above; the "redirect_status=failed renders the form" case is pinned at the helper (`readRedirect`) and by construction (Task 9 Step 4), and walked in Task 10.
- §7: Task 10 (README, ARCHITECTURE, walkthrough, full fleet, `money + client`).
- Copy: no em dashes in any new string; the `'—'` glyph is the pre-existing missing-value placeholder.
