# Client Portal v2 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the thin proposal-list portal with a read-only single-event command center (Overview + Prescription/Potion/Receipts tabs + archive + per-document share), backed by one new `/home` read, with every action linking out to the existing standalone token pages.

**Architecture:** One new lean `GET /api/client-portal/home` decides the landing (focus event summary + archive + flags); each tab lazy-loads detail from endpoints that already exist (one gets a small SELECT edit). A new `pages/public/portal/` tree replaces `ClientDashboard.js`. No money or interactive flow is rebuilt.

**Tech Stack:** Node/Express + raw SQL (`pg`), React 18 + React Router 6, vanilla CSS, `node:test` for server tests, `react-scripts build` as the client gate.

**Spec:** `docs/superpowers/specs/2026-06-04-client-portal-v2-foundation-design.md`. Read it first.

**Revised after `/review-plan`:** tasks are ordered so every component's imports already exist at its commit (no forward dependencies), and the `App.js` cutover (Task 12) lands after all render components, so `main` is never user-broken between commits. The old `ClientDashboard` keeps serving `/my-proposals` until Task 12.

**Worktree:** Execute in a worktree created with `npm run worktree:new -- client-portal-v2` (per CLAUDE.md; not the EnterWorktree tool). Run client builds from `os` after merge, not inside the worktree (shared `client/node_modules` junction).

**Load-bearing invariants:**
- **Money units (`schema.sql:538-547`):** `proposals.total_price/amount_paid/total_price_override` + `proposal_addons` = DOLLARS (`NUMERIC`). `invoices.*`, `proposal_payments.amount`, `stripe_sessions.amount` = CENTS (`INTEGER`). Two formatters, never crossed.
- **Status:** `cancelled` no longer exists (it is `archived` + `archive_reason`); `accepted` is valid.
- **IDOR:** every query scoped by `client_id = req.user.id`.
- **Read-only:** no writes, no side effects. Actions link out.

**Client unit tests:** the project has no client jest/RTL suite; the gate is `CI=true react-scripts build` + manual verification (per project practice). Server logic is `node:test` TDD. Client pure-logic modules (`money.js`, `nextUp.js`) are verified by their first consumer's build and the manual cents/dollars checkpoint (Task 16).

---

## Review cadence (run at these batch checkpoints)

- After **Task 3** (backend `/home` SQL + scoping): `database-review` + `security-review`.
- After **Task 12** (auth/routing cutover): `security-review` + `consistency-check`.
- After **Task 10** (cross-unit money rendering in tabs): `consistency-check` + `code-review`.
- After **Task 15** (migration + delete): `consistency-check`.

---

## File Structure

**Backend**
- `server/routes/clientPortal/summary.js` (new) — `PROPOSAL_SUMMARY_COLUMNS` + `shapeFocus(row)`.
- `server/routes/clientPortal.js` (modify) — add `GET /home`; edit `GET /proposals/:token`.
- `server/routes/clientPortal/summary.test.js`, `server/routes/clientPortal.home.test.js` (new).

**Frontend** (`client/src/pages/public/portal/`)
- `money.js`, `nextUp.js`, `constants.js` (BOOKED set + `mapDetailToFocus` + `mapArchiveRow`).
- `ShareButton.js`, `EmptyStates.js`, `ArchiveList.js`.
- `OverviewWidgets.js`, `tabs/OverviewTab.js`, `tabs/PrescriptionTab.js`, `tabs/PotionTab.js`, `tabs/ReceiptsTab.js`.
- `EventCommandCenter.js`, `PortalHome.js`.
- `client/src/App.js`, `client/src/components/PublicLayout.js`, `client/src/components/InvoiceDropdown.js` (modify).

**Styling:** port markup/CSS from `C:\Users\dalla\Downloads\Dr Bartender Marketing (8)\client-portal-v3.html` (+ `apothecary/portal-v2/*.jsx`) into `client/src/index.css`, reusing existing Apothecary tokens. The bundle is the authoritative visual source.

---

## Task 1: Shared proposal-summary contract

**Files:** Create `server/routes/clientPortal/summary.js`, `server/routes/clientPortal/summary.test.js`

- [ ] **Step 1: Failing test** (`summary.test.js`)

```js
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PROPOSAL_SUMMARY_COLUMNS, shapeFocus } = require('./summary');

test('PROPOSAL_SUMMARY_COLUMNS includes venue trio + override + archive_reason (parity guard)', () => {
  for (const c of ['venue_name', 'venue_city', 'venue_state', 'total_price_override', 'archive_reason'])
    assert.ok(PROPOSAL_SUMMARY_COLUMNS.includes(c), `missing ${c}`);
});
test('shapeFocus: override wins; balance = effective - paid; booked; venue city,state', () => {
  const f = shapeFocus({ token: 't', status: 'deposit_paid', event_date: '2026-10-03',
    total_price: '5000.00', total_price_override: '4800.00', amount_paid: '1000.00',
    venue_name: null, venue_city: 'Lake Forest', venue_state: 'IL', drink_plan_token: null, drink_plan_submitted_at: null });
  assert.equal(f.total_price, 4800); assert.equal(f.balance_due, 3800);
  assert.equal(f.booked, true); assert.equal(f.venue_label, 'Lake Forest, IL'); assert.equal(f.drink_plan_submitted, false);
});
test('shapeFocus: venue_name wins; submitted from submitted_at; not-booked', () => {
  const f = shapeFocus({ token: 't', status: 'sent', total_price: '5000.00', total_price_override: null,
    amount_paid: '0', venue_name: 'The Foundry', venue_city: 'Chicago', venue_state: 'IL',
    drink_plan_token: 'dp', drink_plan_submitted_at: '2026-01-01T00:00:00Z' });
  assert.equal(f.venue_label, 'The Foundry'); assert.equal(f.booked, false); assert.equal(f.drink_plan_submitted, true);
});
test('shapeFocus: no venue -> Location TBD; null money -> 0', () => {
  const f = shapeFocus({ token: 't', status: 'draft', total_price: null, total_price_override: null,
    amount_paid: null, venue_name: null, venue_city: null, venue_state: null, drink_plan_token: null, drink_plan_submitted_at: null });
  assert.equal(f.venue_label, 'Location TBD'); assert.equal(f.balance_due, 0);
});
```

- [ ] **Step 2: Run, confirm fail** — `node --test server/routes/clientPortal/summary.test.js` (FAIL: cannot find module).

- [ ] **Step 3: Implement `summary.js`**

```js
// Single source of truth for the proposal-summary fields /home and the detail
// endpoint both expose. NOTE: drink_plan_token / drink_plan_submitted_at are
// appended by the consuming query's drink_plans join, NOT part of this column list.
const BOOKED = new Set(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
const PROPOSAL_SUMMARY_COLUMNS = [
  'p.token', 'p.status', 'p.archive_reason', 'p.event_type', 'p.event_type_custom',
  'p.event_date', 'p.event_start_time', 'p.guest_count',
  'p.venue_name', 'p.venue_city', 'p.venue_state',
  'p.total_price', 'p.total_price_override', 'p.amount_paid', 'p.balance_due_date',
].join(', ');
function venueLabel(r) {
  if (r.venue_name) return String(r.venue_name);
  if (r.venue_city && r.venue_state) return `${r.venue_city}, ${r.venue_state}`;
  return 'Location TBD';
}
function shapeFocus(r) {
  const total = Number(r.total_price_override ?? r.total_price ?? 0);
  const paid = Number(r.amount_paid ?? 0);
  return {
    token: r.token, status: r.status, booked: BOOKED.has(r.status),
    event_type: r.event_type, event_type_custom: r.event_type_custom,
    event_date: r.event_date, event_start_time: r.event_start_time, guest_count: r.guest_count,
    venue_label: venueLabel(r), total_price: total, amount_paid: paid, balance_due: total - paid,
    balance_due_date: r.balance_due_date,
    drink_plan_token: r.drink_plan_token || null, drink_plan_submitted: r.drink_plan_submitted_at != null,
  };
}
module.exports = { BOOKED, PROPOSAL_SUMMARY_COLUMNS, shapeFocus };
```

- [ ] **Step 4: Run, confirm pass** — `node --test server/routes/clientPortal/summary.test.js` (PASS, 4 tests).
- [ ] **Step 5: Commit** — `git add server/routes/clientPortal/summary.js server/routes/clientPortal/summary.test.js && git commit -m "feat(client-portal): shared proposal-summary contract + shaper"`

---

## Task 2: `GET /api/client-portal/home`

**Files:** Modify `server/routes/clientPortal.js`; create `server/routes/clientPortal.home.test.js`

- [ ] **Step 1: Failing test** (`clientPortal.home.test.js`) — harness mirrors `emailChange.test.js`, INCLUDING the `AppError` error middleware.

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const clientPortalRouter = require('./clientPortal');

let server, baseUrl;
const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `cp-home-%-${NONCE}@example.com`;

function request(path, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => { let d = ''; res.on('data', c => d += c);
        res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch { /* HTML */ }
          resolve({ status: res.statusCode, body: j, raw: d }); }); });
    req.on('error', reject); req.end();
  });
}
const clientToken = (id, email) => jwt.sign({ id, email, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
async function mkClient(tag) {
  const email = `cp-home-${tag}-${NONCE}@example.com`;
  const r = await pool.query('INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', [`CP ${tag}`, email]);
  return { id: r.rows[0].id, email, token: clientToken(r.rows[0].id, email) };
}
async function mkProposal(clientId, { status = 'sent', date = null, start = null, total = '4800.00', paid = '0', reason = null }) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, status, event_date, event_start_time, total_price, amount_paid, event_type, archive_reason)
     VALUES ($1,$2,$3,$4,$5,$6,'wedding',$7) RETURNING id, token`,
    [clientId, status, date, start, total, paid, reason]);
  return r.rows[0];
}

before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/client-portal', clientPortalRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const body = { error: err.message, code: err.code };
      if (err.fieldErrors) body.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(body);
    }
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => {
  await pool.query("DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)", [EMAIL_LIKE]);
  await pool.query("DELETE FROM clients WHERE email LIKE $1", [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('no token -> 401', async () => { assert.equal((await request('/home', null)).status, 401); });

test('brand-new client: focus null, empty archive, no draft', async () => {
  const c = await mkClient('new');
  const res = await request('/home', c.token);
  assert.equal(res.status, 200); assert.equal(res.body.focus, null);
  assert.deepEqual(res.body.archive, []); assert.equal(res.body.has_quote_draft, false);
});

test('single upcoming booked -> focus, money in dollars, count 1', async () => {
  const c = await mkClient('one');
  await mkProposal(c.id, { status: 'deposit_paid', date: '2099-10-03', total: '4800.00', paid: '1000.00' });
  const res = await request('/home', c.token);
  assert.ok(res.body.focus); assert.equal(res.body.focus.booked, true);
  assert.equal(res.body.focus.total_price, 4800); assert.equal(res.body.focus.balance_due, 3800);
  assert.equal(res.body.upcoming_count, 1);
});

test('IDOR: B sees only B rows, never A', async () => {
  const a = await mkClient('idorA'); const b = await mkClient('idorB');
  const ap = await mkProposal(a.id, { status: 'deposit_paid', date: '2099-11-01' });
  const bp = await mkProposal(b.id, { status: 'deposit_paid', date: '2099-12-01' });
  const res = await request('/home', b.token);
  assert.equal(res.body.focus.token, bp.token);
  assert.notEqual(res.body.focus.token, ap.token);
});

test('two-plus upcoming -> soonest is focus, count 2', async () => {
  const c = await mkClient('two');
  await mkProposal(c.id, { status: 'deposit_paid', date: '2099-09-01' });
  const soon = await mkProposal(c.id, { status: 'sent', date: '2099-08-01' });
  const res = await request('/home', c.token);
  assert.equal(res.body.focus.token, soon.token); assert.equal(res.body.upcoming_count, 2);
});

test('same-date tie-break: earlier start_time wins', async () => {
  const c = await mkClient('tie');
  const late = await mkProposal(c.id, { status: 'sent', date: '2099-07-01', start: '18:00' });
  const early = await mkProposal(c.id, { status: 'sent', date: '2099-07-01', start: '12:00' });
  const res = await request('/home', c.token);
  assert.equal(res.body.focus.token, early.token);
});

test('null-date draft becomes focus only when no dated upcoming (no countdown)', async () => {
  const c = await mkClient('null');
  await mkProposal(c.id, { status: 'draft', date: null });
  const res = await request('/home', c.token);
  assert.ok(res.body.focus); assert.equal(res.body.focus.event_date, null);
});

test('hidden-rows-only (cancelled-archive) -> brand-new (focus null, archive empty)', async () => {
  const c = await mkClient('hidden');
  await mkProposal(c.id, { status: 'archived', date: '2099-06-01', reason: 'client_cancelled' });
  const res = await request('/home', c.token);
  assert.equal(res.body.focus, null); assert.deepEqual(res.body.archive, []);
});

test('expired unbooked-past -> not focus, not archive', async () => {
  const c = await mkClient('expired');
  await mkProposal(c.id, { status: 'sent', date: '2020-01-01' });
  const res = await request('/home', c.token);
  assert.equal(res.body.focus, null); assert.deepEqual(res.body.archive, []);
});

test('completed past -> archive, not focus', async () => {
  const c = await mkClient('done');
  await mkProposal(c.id, { status: 'completed', date: '2020-01-01', total: '2500.00', paid: '2500.00' });
  const res = await request('/home', c.token);
  assert.equal(res.body.focus, null); assert.equal(res.body.archive.length, 1);
  assert.equal(res.body.archive[0].status, 'completed');
});
```

- [ ] **Step 2: Run, confirm fail** — `node --test server/routes/clientPortal.home.test.js` (FAIL: 404 -> assertions fail).

- [ ] **Step 3: Implement `/home`** in `clientPortal.js`. Add at the top: `const Sentry = require('@sentry/node');` and `const { PROPOSAL_SUMMARY_COLUMNS, shapeFocus } = require('./clientPortal/summary');`. Add this route right after `router.use(clientAuth);`:

```js
router.get('/home', asyncHandler(async (req, res) => {
  const clientId = req.user.id;
  const email = req.user.email;
  try {
    const focusSelect = `
      SELECT ${PROPOSAL_SUMMARY_COLUMNS},
             dp.token AS drink_plan_token, dp.submitted_at AS drink_plan_submitted_at
      FROM proposals p
      LEFT JOIN drink_plans dp
        ON dp.proposal_id = p.id AND dp.proposal_id IN (SELECT id FROM proposals WHERE client_id = $1)
      WHERE p.client_id = $1 AND p.status <> 'archived' AND p.status <> 'completed'`;
    const [dated, nullDraft, countRes, archiveRes, draftRes] = await Promise.all([
      pool.query(`${focusSelect} AND p.event_date >= CURRENT_DATE
                  ORDER BY p.event_date ASC, p.event_start_time ASC NULLS LAST, p.created_at DESC LIMIT 1`, [clientId]),
      pool.query(`${focusSelect} AND p.event_date IS NULL ORDER BY p.created_at DESC LIMIT 1`, [clientId]),
      pool.query(`SELECT COUNT(*)::int AS n FROM proposals
                  WHERE client_id = $1 AND status NOT IN ('archived','completed') AND event_date >= CURRENT_DATE`, [clientId]),
      pool.query(`SELECT p.token, p.event_type, p.event_type_custom, p.event_date,
                         COALESCE(p.total_price_override, p.total_price) AS total_price, p.status
                  FROM proposals p WHERE p.client_id = $1 AND (
                    p.status = 'completed'
                    OR (p.status = 'archived' AND p.archive_reason = 'event_completed')
                    OR (p.status IN ('deposit_paid','balance_paid','confirmed') AND p.event_date < CURRENT_DATE))
                  ORDER BY p.event_date DESC NULLS LAST`, [clientId]),
      pool.query(`SELECT EXISTS(SELECT 1 FROM quote_drafts WHERE LOWER(email) = LOWER($1) AND status = 'draft') AS has`, [email]),
    ]);
    const focusRow = dated.rows[0] || nullDraft.rows[0] || null;
    res.json({
      focus: focusRow ? shapeFocus(focusRow) : null,
      upcoming_count: countRes.rows[0].n,
      archive: archiveRes.rows.map(r => ({ ...r, total_price: Number(r.total_price) })),
      has_quote_draft: draftRes.rows[0].has,
    });
  } catch (err) {
    if (process.env.SENTRY_DSN_SERVER) Sentry.captureException(err, { tags: { route: 'client-portal/home', client_id: clientId } });
    throw err;
  }
}));
```

- [ ] **Step 4: Run, confirm pass** — `node --test server/routes/clientPortal.home.test.js` (PASS; re-run alone if a shared-DB teardown collision appears).
- [ ] **Step 5: Commit** — `git add server/routes/clientPortal.js server/routes/clientPortal.home.test.js && git commit -m "feat(client-portal): GET /home landing read"`

---

## Task 3: detail endpoint parity (explicit SQL)

**Files:** Modify `server/routes/clientPortal.js` (`GET /proposals/:token`)

- [ ] **Step 1: Add a failing assertion** to `clientPortal.home.test.js`

```js
test('detail endpoint exposes drink_plan_token + venue trio (parity)', async () => {
  const c = await mkClient('detail');
  const p = await mkProposal(c.id, { status: 'deposit_paid', date: '2099-12-01' });
  await pool.query('UPDATE proposals SET venue_city = $2, venue_state = $3 WHERE id = $1', [p.id, 'Chicago', 'IL']);
  await pool.query('INSERT INTO drink_plans (proposal_id, submitted_at) VALUES ($1, NULL)', [p.id]);
  const res = await request(`/proposals/${p.token}`, c.token);
  assert.equal(res.status, 200);
  assert.ok('drink_plan_token' in res.body.proposal);
  assert.equal(res.body.proposal.venue_city, 'Chicago');
});
test('detail endpoint: unowned token -> 404 (JSON, not HTML)', async () => {
  const a = await mkClient('own'); const b = await mkClient('other');
  const p = await mkProposal(a.id, { status: 'sent', date: '2099-01-01' });
  const res = await request(`/proposals/${p.token}`, b.token);
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Run, confirm fail** — `node --test server/routes/clientPortal.home.test.js` (FAIL: `drink_plan_token` absent).

- [ ] **Step 3: Edit `GET /proposals/:token`** in `clientPortal.js`. In the main proposal query, add these to the SELECT list (after the existing columns) and add the join. The handler already binds `$1` = `req.params.token` and `$2` = `req.user.id`:

```sql
-- add to the SELECT list:
       p.venue_name, p.venue_city, p.venue_state, p.total_price_override,
       dp.token AS drink_plan_token, dp.submitted_at AS drink_plan_submitted_at
-- add the join (between FROM proposals p ... and WHERE):
  LEFT JOIN drink_plans dp
    ON dp.proposal_id = p.id AND dp.proposal_id IN (SELECT id FROM proposals WHERE client_id = $2)
```

(Leave the existing add-ons + payments parallel fetch unchanged. The `WHERE p.token = $1 AND p.client_id = $2` clause already returns `NotFoundError` for an unowned/missing token, satisfying the second assertion.)

- [ ] **Step 4: Run, confirm pass** — `node --test server/routes/clientPortal.home.test.js` (PASS).
- [ ] **Step 5: Commit** — `git add server/routes/clientPortal.js server/routes/clientPortal.home.test.js && git commit -m "feat(client-portal): detail endpoint summary + drink-plan parity"`

> **Checkpoint:** run `database-review` + `security-review` on the backend (Tasks 1-3) before continuing.

---

## Task 4: client money formatters

**Files:** Create `client/src/pages/public/portal/money.js`

- [ ] **Step 1: Implement** (verified by first consumer build in Task 7 + manual cents/dollars check in Task 16)

```js
// proposals.* = DOLLARS; invoices.* / proposal_payments.amount = CENTS. Never crossed.
const usd = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const formatDollars = (dollars) => usd(dollars);
export const formatCents = (cents) => usd(Number(cents || 0) / 100);
```

- [ ] **Step 2: Commit** — `git add client/src/pages/public/portal/money.js && git commit -m "feat(client-portal): dollars/cents formatters"`

---

## Task 5: next-up cascade + client constants

**Files:** Create `client/src/pages/public/portal/nextUp.js`, `client/src/pages/public/portal/constants.js`

- [ ] **Step 1: Implement `constants.js`** (client mirror of the server BOOKED set + the detail->focus mapper used by filed-mode in Task 13)

```js
export const BOOKED = new Set(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
function venueLabel(p) {
  if (p.venue_name) return p.venue_name;
  if (p.venue_city && p.venue_state) return `${p.venue_city}, ${p.venue_state}`;
  return 'Location TBD';
}
// Map a detail payload (res.body.proposal) into the focus contract the UI consumes.
export function mapDetailToFocus(p) {
  const total = Number(p.total_price_override ?? p.total_price ?? 0);
  const paid = Number(p.amount_paid ?? 0);
  return {
    token: p.token, status: p.status, booked: BOOKED.has(p.status),
    event_type: p.event_type, event_type_custom: p.event_type_custom,
    event_date: p.event_date, event_start_time: p.event_start_time, guest_count: p.guest_count,
    venue_label: venueLabel(p), total_price: total, amount_paid: paid, balance_due: total - paid,
    balance_due_date: p.balance_due_date,
    drink_plan_token: p.drink_plan_token || null, drink_plan_submitted: p.drink_plan_submitted_at != null,
  };
}
// Map a thin /home archive row into a minimal focus (details-unavailable fallback).
export function mapArchiveRow(r) {
  return {
    token: r.token, status: r.status, booked: BOOKED.has(r.status),
    event_type: r.event_type, event_type_custom: r.event_type_custom,
    event_date: r.event_date, event_start_time: null, guest_count: null,
    venue_label: 'Location TBD', total_price: Number(r.total_price ?? 0), amount_paid: 0,
    balance_due: 0, balance_due_date: null, drink_plan_token: null, drink_plan_submitted: false,
  };
}
```

- [ ] **Step 2: Implement `nextUp.js`** (action targets link OUT)

```js
export function deriveNextUp(focus) {
  if (!focus) return null;
  if (!focus.booked) return { key: 'book', label: 'Review & book your bar', cta: 'Review & book', href: `/proposal/${focus.token}` };
  if (focus.balance_due > 0) return { key: 'pay', label: 'Pay your balance', cta: 'Pay balance', href: `/proposal/${focus.token}` };
  if (focus.drink_plan_token && !focus.drink_plan_submitted) return { key: 'potion', label: 'Plan your potions', cta: 'Open the planner', href: `/plan/${focus.drink_plan_token}` };
  return null;
}
```

- [ ] **Step 3: Commit** — `git add client/src/pages/public/portal/nextUp.js client/src/pages/public/portal/constants.js && git commit -m "feat(client-portal): next-up cascade + detail->focus mapper"`

---

## Task 6: ShareButton

**Files:** Create `client/src/pages/public/portal/ShareButton.js`

- [ ] **Step 1: Implement**

```js
import React from 'react';
import { useToast } from '../../../context/ToastContext';
export default function ShareButton({ url, label }) {
  const toast = useToast();
  const absolute = `${window.location.origin}${url}`;
  const onShare = async () => {
    if (navigator.share) { try { await navigator.share({ url: absolute }); return; } catch { /* fall to copy */ } }
    try { await navigator.clipboard.writeText(absolute); toast.success('Link copied'); }
    catch { toast.error('Could not copy the link'); }
  };
  return (<div className="cp-share">
    <button type="button" className="btn client-btn-outline" onClick={onShare}>{label}</button>
    <span className="cp-share-hint">Anyone with this link can view it.</span>
  </div>);
}
```

- [ ] **Step 2: Commit** — `git add client/src/pages/public/portal/ShareButton.js && git commit -m "feat(client-portal): per-document share button"`

---

## Task 7: EmptyStates + ArchiveList (leaf components)

**Files:** Create `client/src/pages/public/portal/EmptyStates.js`, `client/src/pages/public/portal/ArchiveList.js`

- [ ] **Step 1: Implement `EmptyStates.js`** (port classes from the mock's empty/between states)

```js
import React from 'react';
export function BrandNewEmpty({ name }) {
  return (<div className="cp-empty"><h3>Welcome to the lab{name ? `, ${name}` : ''}.</h3>
    <p>You do not have any events on file yet.</p>
    <a className="btn client-btn-primary" href="/quote">Get an instant quote</a></div>);
}
export function NoEvent({ archiveCount }) {
  return (<div className="cp-empty"><h3>No event on the books yet.</h3>
    <p>{archiveCount > 0 ? 'Your past events are below.' : 'When we build your next event, it shows up here.'}</p>
    <a className="btn client-btn-primary" href="/quote">Start a new quote</a></div>);
}
```

- [ ] **Step 2: Implement `ArchiveList.js`** (money is DOLLARS -> `formatDollars`)

```js
import React from 'react';
import { Link } from 'react-router-dom';
import { formatDollars } from './money';
import { getEventTypeLabel } from '../../../utils/eventTypes';
export default function ArchiveList({ archive }) {
  if (!archive || archive.length === 0) return null;
  return (<div className="cp-archive-list">{archive.map(e => (
    <Link key={e.token} to={`/my-proposals/${e.token}/overview`} className="cp-archive-row">
      <span className="cp-archive-title">{getEventTypeLabel({ event_type: e.event_type, event_type_custom: e.event_type_custom })}</span>
      <span className="cp-archive-date">{e.event_date ? new Date(e.event_date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : ''}</span>
      <span className="cp-archive-total">{formatDollars(e.total_price)}</span>
    </Link>))}</div>);
}
```

- [ ] **Step 3: Verify build** — from `client/`: `$env:CI='true'; npx react-scripts build`. Expected: PASS (catches a `money.js` typo here, its first consumer).
- [ ] **Step 4: Commit** — `git add client/src/pages/public/portal/EmptyStates.js client/src/pages/public/portal/ArchiveList.js && git commit -m "feat(client-portal): empty states + archive list"`

---

## Task 8: Overview tab + widgets

**Files:** Create `client/src/pages/public/portal/OverviewWidgets.js`, `client/src/pages/public/portal/tabs/OverviewTab.js`

- [ ] **Step 1: Implement `OverviewWidgets.js`** — all read `focus` only. Timeline derives from `status`+dates (NOT `client_signed_at`) and includes the `wrap-up` step (spec §8). Pay step suppressed via `deriveNextUp` (returns null when `balance_due <= 0` and booked). Port card CSS from the mock.

```js
import React from 'react';
import { formatDollars } from './money';
import { deriveNextUp } from './nextUp';
const daysUntil = (d) => d ? Math.ceil((new Date(d + 'T12:00:00') - new Date()) / 86400000) : null;
const ORDER = ['draft','sent','viewed','modified','accepted','deposit_paid','balance_paid','confirmed','completed'];
const at = (s) => ORDER.indexOf(s);

export function Countdown({ focus }) {
  const d = daysUntil(focus.event_date);
  if (d == null) return <div className="cp-countdown-card"><div className="cp-countdown-foot">Date to be confirmed.</div></div>;
  return <div className="cp-countdown-card"><div className="cp-countdown-stamp-num">{Math.abs(d)}</div>
    <div className="cp-countdown-foot">{d < 0 ? 'took place' : 'days to go'}</div></div>;
}
export function SummaryAside({ focus }) {
  const pct = focus.total_price > 0 ? Math.min(100, Math.round((focus.amount_paid / focus.total_price) * 100)) : 0;
  return (<aside className="cp-summary-card">
    <div className="cp-summary-leader"><span>Total</span><span>{formatDollars(focus.total_price)}</span></div>
    <div className="cp-summary-leader"><span>Paid</span><span>{formatDollars(focus.amount_paid)} ({pct}%)</span></div>
    {focus.balance_due > 0 && <div className="cp-summary-leader"><span>Balance</span><span>{formatDollars(focus.balance_due)}</span></div>}
    <div className="cp-case-pay-bar"><div className="cp-case-pay-bar-fill" style={{ width: `${pct}%` }} /></div>
  </aside>);
}
export function NextUpCard({ focus }) {
  const n = deriveNextUp(focus); if (!n) return null;
  return <div className="cp-next-card"><div className="cp-next-title">{n.label}</div>
    <a className="btn client-btn-primary" href={n.href}>{n.cta}</a></div>;
}
export function ProcedureTimeline({ focus }) {
  const i = at(focus.status);
  const steps = [
    { k: 'quote', name: 'Quote prepared', done: i >= at('sent') },
    { k: 'deposit', name: 'Deposit paid', done: i >= at('deposit_paid') },
    { k: 'menu', name: 'Potion plan', done: focus.drink_plan_submitted },
    { k: 'balance', name: 'Balance paid', done: focus.booked && focus.balance_due <= 0 },
    { k: 'event', name: 'Event day', done: i >= at('completed') },
    { k: 'wrap', name: 'Wrap-up', done: i >= at('completed') },
  ];
  return <ol className="cp-procedure">{steps.map(s => <li key={s.k} className={`cp-proc-step ${s.done ? 'done' : ''}`}>{s.name}</li>)}</ol>;
}
```

- [ ] **Step 2: Implement `tabs/OverviewTab.js`** — composes widgets + reserved day-of slot; past-event "filed" mode adds a "book us again" CTA (spec §8).

```js
import React from 'react';
import { Countdown, SummaryAside, NextUpCard, ProcedureTimeline } from '../OverviewWidgets';
const isPast = (focus) => focus.event_date && new Date(focus.event_date + 'T12:00:00') < new Date();
export default function OverviewTab({ focus }) {
  const past = isPast(focus);
  return (<div className="cp-case-body"><div className="cp-case-main">
    <Countdown focus={focus} />
    {past ? <a className="btn client-btn-primary" href="/quote">Book us again</a> : <NextUpCard focus={focus} />}
    <ProcedureTimeline focus={focus} />
    <div className="cp-locked-card"><div className="cp-locked-title">Day-of details</div>
      <p>Day-of details unlock closer to the date.</p></div>
  </div><SummaryAside focus={focus} /></div>);
}
```

- [ ] **Step 3: Verify build** — `$env:CI='true'; npx react-scripts build` from `client/`. Expected: PASS.
- [ ] **Step 4: Commit** — `git add client/src/pages/public/portal/OverviewWidgets.js client/src/pages/public/portal/tabs/OverviewTab.js && git commit -m "feat(client-portal): Overview tab (countdown, summary, next-up, timeline, filed mode)"`

---

## Task 9: Prescription tab

**Files:** Create `client/src/pages/public/portal/tabs/PrescriptionTab.js`

> `ProposalPricingBreakdown` is NOT reused: it needs derived props (`includes`, `lineItems`, `snapshot`, ...) from `ProposalView`'s pricing-engine prep, not the portal detail payload (a `/review-plan` finding). The tab renders a lean read-only summary inline from the detail payload; the full/editable proposal links out to `/proposal/:token`. (A small, deliberate deviation from spec §5.)

- [ ] **Step 1: Implement `PrescriptionTab.js`** — fetch detail; render package + inclusions, add-ons, totals (dollars), payment terms, signature status, and payment history (cents) inline from the payload; link-outs + `ShareButton`.

```js
import React, { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../../utils/api';
import { formatDollars, formatCents } from '../money';
import ShareButton from '../ShareButton';

export default function PrescriptionTab({ focus }) {
  const [p, setP] = useState(null);
  const [state, setState] = useState('loading');
  useEffect(() => { let off = false; (async () => {
    try { const token = localStorage.getItem('db_client_token');
      const { data } = await api.get(`/client-portal/proposals/${focus.token}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!off) { setP(data.proposal); setState('ready'); }
    } catch (e) { if (!off) { Sentry.captureException(e, { tags: { area: 'client-portal', tab: 'prescription', token: focus.token } }); setState('error'); } }
  })(); return () => { off = true; }; }, [focus.token]);

  if (state === 'loading') return <div className="loading" role="status"><div className="spinner" />Loading...</div>;
  if (state === 'error') return <div className="client-alert client-alert-error">Could not load this proposal. <button onClick={() => window.location.reload()}>Retry</button></div>;
  const includes = Array.isArray(p.package_includes) ? p.package_includes : [];
  return (<div className="cp-rx">
    <div className="cp-rx-pkg"><h3>{p.package_name || 'Your package'}</h3>
      <ul className="cp-rx-includes">{includes.map((it, i) => <li key={i}>{it}</li>)}</ul></div>
    {p.addons?.length > 0 && (<div className="cp-rx-addons"><h4>Add-ons</h4>
      {p.addons.map(a => <div key={a.id} className="cp-leader"><span>{a.addon_name}</span><span>{formatDollars(a.line_total)}</span></div>)}</div>)}
    <div className="cp-rx-totals">
      <div className="cp-leader"><span>Total</span><span>{formatDollars(focus.total_price)}</span></div>
      <div className="cp-leader"><span>Paid</span><span>{formatDollars(focus.amount_paid)}</span></div>
      {focus.balance_due > 0 && <div className="cp-leader"><span>Balance due</span><span>{formatDollars(focus.balance_due)}</span></div>}
    </div>
    <div className="cp-rx-sig">{p.client_signed_at
      ? <>Signed by {p.client_signed_name} on {new Date(p.client_signed_at).toLocaleDateString('en-US')}</>
      : <>Not yet signed</>}</div>
    {p.payments?.length > 0 && (<div className="cp-rx-payments"><h4>Payment history</h4>
      {p.payments.map(pay => <div key={pay.id} className="cp-leader"><span>{pay.payment_type}</span><span>{formatCents(pay.amount)}</span></div>)}</div>)}
    <div className="cp-rx-actions">
      {!focus.booked && <a className="btn client-btn-primary" href={`/proposal/${focus.token}`}>Review & book</a>}
      {focus.balance_due > 0 && <a className="btn client-btn-primary" href={`/proposal/${focus.token}`}>Pay balance</a>}
      <ShareButton url={`/proposal/${focus.token}`} label="Share this proposal" />
    </div>
  </div>);
}
```

- [ ] **Step 2: Verify build** — `$env:CI='true'; npx react-scripts build`. Expected: PASS.
- [ ] **Step 3: Commit** — `git add client/src/pages/public/portal/tabs/PrescriptionTab.js && git commit -m "feat(client-portal): read-only Prescription tab"`

---

## Task 10: Receipts + Potion tabs

**Files:** Create `client/src/pages/public/portal/tabs/ReceiptsTab.js`, `client/src/pages/public/portal/tabs/PotionTab.js`

- [ ] **Step 1: `ReceiptsTab.js`** — invoices endpoint returns CENTS; per-invoice share; empty state.

```js
import React, { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../../utils/api';
import { formatCents } from '../money';
import ShareButton from '../ShareButton';
export default function ReceiptsTab({ focus }) {
  const [invoices, setInvoices] = useState(null); const [state, setState] = useState('loading');
  useEffect(() => { let off = false; (async () => {
    try { const token = localStorage.getItem('db_client_token');
      const { data } = await api.get(`/invoices/client/${focus.token}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!off) { setInvoices(data.invoices || []); setState('ready'); }
    } catch (e) { if (!off) { Sentry.captureException(e, { tags: { area: 'client-portal', tab: 'receipts', token: focus.token } }); setState('error'); } }
  })(); return () => { off = true; }; }, [focus.token]);
  if (state === 'loading') return <div className="loading" role="status"><div className="spinner" />Loading...</div>;
  if (state === 'error') return <div className="client-alert client-alert-error">Could not load invoices.</div>;
  if (invoices.length === 0) return <div className="cp-empty"><p>No invoices yet.</p></div>;
  return (<div className="cp-receipts">{invoices.map(inv => (<div key={inv.id} className="cp-receipt-row">
    <span>{inv.invoice_number} · {inv.label}</span>
    <span>{formatCents(inv.status === 'paid' ? inv.amount_paid : inv.amount_due)} — {inv.status}</span>
    <a className="btn" href={`/invoice/${inv.token}`} target="_blank" rel="noopener noreferrer">Open</a>
    <ShareButton url={`/invoice/${inv.token}`} label="Share" />
  </div>))}</div>);
}
```

- [ ] **Step 2: `PotionTab.js`** — null plan -> "opens after booking" + NO share; else read-only summary + link-out + share.

```js
import React, { useState, useEffect } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../../utils/api';
import ShareButton from '../ShareButton';
export default function PotionTab({ focus }) {
  const [plan, setPlan] = useState(null);
  const [state, setState] = useState(focus.drink_plan_token ? 'loading' : 'none');
  useEffect(() => { if (!focus.drink_plan_token) return; let off = false; (async () => {
    try { const { data } = await api.get(`/drink-plans/t/${focus.drink_plan_token}`);
      if (!off) { setPlan(data); setState('ready'); }
    } catch (e) { if (!off) { Sentry.captureException(e, { tags: { area: 'client-portal', tab: 'potion', token: focus.token } }); setState('error'); } }
  })(); return () => { off = true; }; }, [focus.drink_plan_token]);
  if (state === 'none') return <div className="cp-empty"><p>Your menu opens after booking.</p></div>;
  if (state === 'loading') return <div className="loading" role="status"><div className="spinner" />Loading...</div>;
  if (state === 'error') return <div className="client-alert client-alert-error">Could not load your menu.</div>;
  return (<div className="cp-potion-summary"><div className="cp-potion-serving">{plan.serving_type || 'Menu in progress'}</div>
    <div className="cp-potion-actions">
      <a className="btn client-btn-primary" href={`/plan/${focus.drink_plan_token}`}>Open the planner</a>
      <ShareButton url={`/plan/${focus.drink_plan_token}`} label="Share the menu" />
    </div></div>);
}
```

- [ ] **Step 3: Verify build** — `$env:CI='true'; npx react-scripts build`. Expected: PASS.
- [ ] **Step 4: Commit** — `git add client/src/pages/public/portal/tabs/ReceiptsTab.js client/src/pages/public/portal/tabs/PotionTab.js && git commit -m "feat(client-portal): Receipts + Potion read-only tabs"`

> **Checkpoint:** run `consistency-check` + `code-review` (cross-unit money rendering: dollars in Overview/Prescription totals, cents in payments/invoices).

---

## Task 11: EventCommandCenter (wires the real tabs)

**Files:** Create `client/src/pages/public/portal/EventCommandCenter.js`

- [ ] **Step 1: Implement** (all four tab imports now exist)

```js
import React from 'react';
import { Link, useParams } from 'react-router-dom';
import OverviewTab from './tabs/OverviewTab';
import PrescriptionTab from './tabs/PrescriptionTab';
import PotionTab from './tabs/PotionTab';
import ReceiptsTab from './tabs/ReceiptsTab';
import { getEventTypeLabel } from '../../../utils/eventTypes';
const TABS = [['overview','Overview'],['prescription','The Prescription'],['potion','The Potion Plan'],['receipts','Receipts']];
export default function EventCommandCenter({ focus, upcomingCount }) {
  const { tab = 'overview' } = useParams();
  const base = `/my-proposals/${focus.token}`;
  return (<div className="cp-command">
    <header className="cp-case-hero">
      <div className="drb-kicker">{getEventTypeLabel({ event_type: focus.event_type, event_type_custom: focus.event_type_custom })}</div>
      {upcomingCount > 1 && <div className="cp-multi-note">You also have another upcoming event.</div>}
    </header>
    <nav className="cp-tabs" role="tablist">{TABS.map(([k, label]) => (
      <Link key={k} role="tab" aria-selected={tab === k} className={`cp-tab${tab === k ? ' active' : ''}`} to={`${base}/${k}`}>{label}</Link>))}</nav>
    <section className="cp-tab-body">
      {tab === 'overview' && <OverviewTab focus={focus} />}
      {tab === 'prescription' && <PrescriptionTab focus={focus} />}
      {tab === 'potion' && <PotionTab focus={focus} />}
      {tab === 'receipts' && <ReceiptsTab focus={focus} />}
    </section>
  </div>);
}
```

- [ ] **Step 2: Verify build + commit** — `$env:CI='true'; npx react-scripts build` (PASS); `git add client/src/pages/public/portal/EventCommandCenter.js && git commit -m "feat(client-portal): event command center + tab bar"`

---

## Task 12: PortalHome + App.js cutover (the switch)

**Files:** Create `client/src/pages/public/portal/PortalHome.js`; modify `client/src/App.js`

- [ ] **Step 1: Implement `PortalHome.js`** (focus -> command center; no-event -> NoEvent + ArchiveList; brand-new -> BrandNewEmpty). Mirror `ClientDashboard.js` auth/loading; pick state from `/home` BEFORE painting so a brand-new login does not flash a focus shell.

```js
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import PublicLayout, { clientLoginPath } from '../../../components/PublicLayout';
import { useClientAuth } from '../../../context/ClientAuthContext';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';
import EventCommandCenter from './EventCommandCenter';
import ArchiveList from './ArchiveList';
import { BrandNewEmpty, NoEvent } from './EmptyStates';

export default function PortalHome() {
  const { clientUser, clientLoading, isClientAuthenticated } = useClientAuth();
  const navigate = useNavigate(); const toast = useToast();
  const [home, setHome] = useState(null); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  useEffect(() => { if (!clientLoading && !isClientAuthenticated) navigate(clientLoginPath(), { replace: true }); }, [clientLoading, isClientAuthenticated, navigate]);
  useEffect(() => {
    if (clientLoading || !isClientAuthenticated) { if (!clientLoading) setLoading(false); return; }
    let off = false; (async () => {
      try { const token = localStorage.getItem('db_client_token');
        const { data } = await api.get('/client-portal/home', { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!off) setHome(data);
      } catch { if (!off) { setError('Could not load your portal. Please try again.'); toast.error('Failed to load your portal.'); } }
      finally { if (!off) setLoading(false); }
    })(); return () => { off = true; };
  }, [clientLoading, isClientAuthenticated, toast]);
  if (clientLoading || loading) return <PublicLayout><div className="loading" role="status"><div className="spinner" />Loading...</div></PublicLayout>;
  if (!isClientAuthenticated) return null;
  if (error) return <PublicLayout><div className="client-alert client-alert-error">{error}</div></PublicLayout>;
  const firstName = (clientUser?.name || '').split(' ')[0];
  let body;
  if (home.focus) body = <EventCommandCenter focus={home.focus} upcomingCount={home.upcoming_count} />;
  else if (home.archive.length > 0 || home.has_quote_draft) body = <><NoEvent archiveCount={home.archive.length} /><ArchiveList archive={home.archive} /></>;
  else body = <BrandNewEmpty name={firstName} />;
  return <PublicLayout><section className="cp-portal">{body}</section></PublicLayout>;
}
```

- [ ] **Step 2: Cut over `App.js`** — replace the `ClientDashboard` lazy import with `const PortalHome = lazy(() => import('./pages/public/portal/PortalHome'));`. In BOTH public/client blocks (around lines 293 and 462), replace the single `/my-proposals` route with these THREE, **archive before the `:token` route** so Router 6 does not match `archive` as a token:

```jsx
<Route path="/my-proposals" element={<PortalHome />} />
<Route path="/my-proposals/archive" element={<PortalHome />} />
<Route path="/my-proposals/:token/:tab" element={<PortalHome />} />
```

Leave the staff/admin blocks untouched. (`PortalHome` ignores `:token`/`:tab` for now; Task 13 adds deep-link handling.)

- [ ] **Step 3: Verify build** — `$env:CI='true'; npx react-scripts build`. Expected: PASS.
- [ ] **Step 4: Manual mini-check** — from `os`, log in as a brand-new client (no proposals): confirm the empty state renders immediately with no focus-shell flash; as a client with a booked upcoming event: the command center + Overview render.
- [ ] **Step 5: Commit** — `git add client/src/pages/public/portal/PortalHome.js client/src/App.js && git commit -m "feat(client-portal): PortalHome + cut /my-proposals over to v2"`

> **Checkpoint:** run `security-review` (auth/routing surface swap).

---

## Task 13: archived deep-link (filed mode) + not-found

**Files:** Modify `client/src/pages/public/portal/PortalHome.js`

> Ship in the SAME push batch as Task 12: between the two commits an archived deep-link URL renders the no-event home instead of that event (graceful, but de-targeted until this lands).

- [ ] **Step 1: Add deep-link handling to `PortalHome.js`** — add the imports and a second effect that resolves a specific token, plus the two render branches.

```js
// add imports:
import { useNavigate, useParams } from 'react-router-dom';
import { mapDetailToFocus, mapArchiveRow } from './constants';

// inside the component, after the existing state declarations:
const { token: routeToken } = useParams();
const [specific, setSpecific] = useState(null);
const [stale, setStale] = useState(false);
const [notFound, setNotFound] = useState(false);

useEffect(() => {
  if (!home || !routeToken || routeToken === 'archive' || routeToken === home.focus?.token) {
    setSpecific(null); setNotFound(false); setStale(false); return;
  }
  let off = false;
  (async () => {
    try {
      const token = localStorage.getItem('db_client_token');
      const { data } = await api.get(`/client-portal/proposals/${routeToken}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!off) setSpecific(mapDetailToFocus(data.proposal));
    } catch (e) {
      if (off) return;
      if (e.status === 404) { setNotFound(true); return; }
      const row = home.archive.find(r => r.token === routeToken);
      if (row) { setSpecific(mapArchiveRow(row)); setStale(true); } else setNotFound(true);
    }
  })();
  return () => { off = true; };
}, [home, routeToken]);
```

Add these render branches BEFORE the existing focus/empty logic (`api`'s response interceptor rejects with `{ status }`, so `e.status` is the HTTP code):

```js
if (notFound) return <PublicLayout><section className="cp-portal"><div className="cp-empty">
  <h3>We could not find that event.</h3>
  <a className="btn client-btn-primary" href="/my-proposals">Back to your portal</a></div></section></PublicLayout>;
if (specific) return <PublicLayout><section className="cp-portal">
  {stale && <div className="client-alert">Some details are unavailable right now.</div>}
  <EventCommandCenter focus={specific} upcomingCount={0} /></section></PublicLayout>;
```

- [ ] **Step 2: Verify build** — `$env:CI='true'; npx react-scripts build`. Expected: PASS.
- [ ] **Step 3: Manual check** — open an archived event from the archive list (read-only Overview renders); hit `/my-proposals/<garbage-uuid>/overview` (not-found card renders).
- [ ] **Step 4: Commit** — `git add client/src/pages/public/portal/PortalHome.js && git commit -m "feat(client-portal): archived filed-mode + not-found deep link"`

---

## Task 14: InvoiceDropdown color fix (independent)

**Files:** Modify `client/src/components/InvoiceDropdown.js`

- [ ] **Step 1:** At `InvoiceDropdown.js:62`, replace the staff-v2-scoped `hsl(var(--ok-h) ...)` / `hsl(var(--danger-h) ...)` with tokens defined on the PUBLIC stylesheet: `var(--success)` (paid) and `var(--error)` (due/partial). Both are defined in the `:root` block of `client/src/index.css` (`index.css:65-66`).

- [ ] **Step 2: Verify build + commit** — `$env:CI='true'; npx react-scripts build` (PASS); `git add client/src/components/InvoiceDropdown.js && git commit -m "fix(client-portal): invoice status colors resolve on the public stylesheet"`

---

## Task 15: nav relabel, remove old dashboard, docs

**Files:** Modify `client/src/components/PublicLayout.js`, `README.md`, `ARCHITECTURE.md`; delete `client/src/pages/public/ClientDashboard.js`

- [ ] **Step 1:** Relabel "My Proposals" in all three `PublicLayout.js` spots (header link, mobile drawer, footer) to "My Event(s)".
- [ ] **Step 2:** Confirm no remaining importers of `ClientDashboard` using the Grep tool (pattern `ClientDashboard`, path `client/src`). Expect zero after the Task 12 swap. Then delete the file.
- [ ] **Step 3:** `README.md` folder tree: add `client/src/pages/public/portal/`. `ARCHITECTURE.md` route table: add `GET /api/client-portal/home`.
- [ ] **Step 4: Verify build + commit** — `$env:CI='true'; npx react-scripts build` (PASS); `git add client/src/components/PublicLayout.js README.md ARCHITECTURE.md && git rm client/src/pages/public/ClientDashboard.js && git commit -m "chore(client-portal): relabel nav, remove old dashboard, docs"`

> **Checkpoint:** run `consistency-check` (migration + delete).

---

## Task 16: full manual verification

- [ ] **Step 1:** From `os`, restart the dev server, log in via OTP, and walk each state against seeded rows: booked upcoming (command center, countdown, dollars summary, correct next-up, timeline step), Prescription (reuse renders; payment-history NOT 100x; link-outs to `/proposal/:token`), Receipts (amounts correct; Open -> `/invoice/:token`), Potion (summary + planner link; no-plan line), Share (copies the right absolute URL), no-event client (archive shows), brand-new client (empty), unowned `:token` (not-found), archived deep-link (read-only filed mode).
- [ ] **Step 2:** The load-bearing check: money never displays 100x off anywhere (dollars vs cents).

---

## Self-Review

**Spec coverage:** §3.1/3.2 buckets+focus+tie-break+null-date+hidden-only -> Task 2 SQL + tests; §3.3 payload/money/venue/next_up/effective-total -> Tasks 1,2,4,5; §3.4 reuse + detail edit -> Task 3; §3.5 shared columns + focus-vs-detail -> Tasks 1,9; §4 routing/precedence/not-found -> Tasks 12,13; §5 components (Prescription renders a lean inline summary; `ProposalPricingBreakdown` not reused) -> Tasks 6-13; §6 tabs -> Tasks 8-10; §7 share -> Task 6; §8 Overview incl wrap-up + filed-mode CTA -> Task 8; §9 states + observability/Sentry -> Tasks 2,9,10,12,13; §10 IDOR + defensive subquery -> Tasks 2,3; §11 backend -> Tasks 1-3; §12 migration (3 nav spots, color fix, docs) -> Tasks 14,15; §13 tests -> Tasks 1,2,3,16.

**Placeholder scan:** Task 13 is now literal code. The only by-reference content is styling (ported from the named mock); the Prescription tab renders a lean inline summary from the detail payload's documented fields (`package_name`, `package_includes`, `addons`, `payments`, signature fields) rather than reusing the coupled `ProposalPricingBreakdown`. No placeholders.

**Type consistency:** the `focus` shape from `shapeFocus` (server, Task 1) and `mapDetailToFocus` (client, Task 5) expose the same keys every consumer uses (`token`, `booked`, `balance_due`, `drink_plan_token`, `drink_plan_submitted`, `venue_label`, `total_price`, `amount_paid`). `formatDollars` (proposal totals) vs `formatCents` (invoices + `payments[].amount`) applied consistently. `BOOKED` defined once server-side (Task 1) and once client-side (Task 5), intentionally, since CJS cannot be imported into the client bundle.
