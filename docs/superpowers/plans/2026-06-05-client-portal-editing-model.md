# Client Portal Editing Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in client request changes to their booking (guest count, add-ons, package, bars, duration, date, time, venue); an admin reviews each request and applies it through the existing proposal editor. No client action ever moves money directly.

**Architecture:** One new table `proposal_change_requests` holds an apply-ready sparse diff plus a server-computed price preview and consent record. A new authenticated client-portal route lets the client price and submit a request; a new admin route lists and declines requests; the existing `PATCH /api/proposals/:id` gains an optional `change_request_id` that stamps the request approved atomically when admin saves. Three pre-existing money/staffing bugs in the apply path are fixed first to de-risk it. A shared helper auto-cancels stale pending requests when a proposal is archived or completed.

**Tech Stack:** Node 18 / Express 4, raw SQL via `pg` (`pool.query`), React 18 (CRA), `node:test` for server tests. Money on `proposals.*` is in DOLLARS; invoices/payments are cents.

**Spec:** `docs/superpowers/specs/2026-06-05-client-portal-editing-model-design.md`. Section refs below (for example "spec 6.3") point there.

---

## Conventions for every task

- Tests are `node:test`. Run one suite with: `node --test server/path/to/file.test.js`. Run all server tests with `npm test`. There is NO client test harness; client tasks are verified with `cd client && set CI=true&& npx react-scripts build` (must compile clean) plus a manual browser check.
- Server test suites share the dev DB. Seed rows with a per-run NONCE-tagged email and delete by that tag in `after()` (see the `clientPortal.home.test.js` blueprint). Run new suites one at a time.
- Commit messages are a single line, no co-author footer (per CLAUDE.md). Stage explicit paths only, never `git add -A`.
- All money on the proposal/change-request side stays in DOLLARS (`NUMERIC`). Never convert to cents in this feature; the invoice layer (reached only through the admin PATCH) does that itself.
- No em dashes in any copy or comment (use commas, colons, periods, parentheses).

---

## File Structure

**Create:**
- `server/utils/changeRequests.js` — pure-ish helpers: `computeEditWindow`, `EDITABLE_FIELDS`, `filterToAllowlist`, `priceProposedState`, `buildPreview`, `buildDiff`, `cancelPendingChangeRequestsForProposal`. One responsibility: everything about turning a proposed end-state into a priced, validated, diffed change request, and reaping stale ones.
- `server/utils/changeRequests.test.js` — unit tests for the pure helpers.
- `server/routes/clientPortal/changeRequests.js` — the authenticated client router (calculate, create, list, cancel). Mounted by `clientPortal.js`, inherits `clientAuth`.
- `server/routes/clientPortal.changeRequests.test.js` — HTTP suite for the client router.
- `server/routes/proposals/changeRequests.js` — the admin router (queue, per-proposal list, decline). Mounted in `proposals/index.js` before `crud`.
- `server/routes/proposals/changeRequests.test.js` — HTTP suite for the admin router + the PATCH approve linkage.
- `client/src/pages/public/portal/ChangeRequestForm.js` — the client-facing request form (reuses wizard inputs, live preview).
- `client/src/pages/public/portal/tabs/ChangeRequestBanner.js` — pending/decided status banner shown on the event.
- `client/src/pages/admin/ChangeRequestsDashboard.js` — admin queue page.
- `client/src/pages/admin/ProposalChangeRequestCard.js` — the review card embedded on Proposal Detail.

**Modify:**
- `server/db/schema.sql` — append the `proposal_change_requests` table (idempotent, at the very bottom).
- `server/routes/proposals/crud.js` — Fix 6.2 (demotion covers `confirmed`), Fix 6.3 (`FOR UPDATE` on the proposal read), and the `change_request_id` approve linkage + reschedule-email suppression + non-linked reconciliation.
- `server/utils/eventCreation.js` — Fix 6.1 (`syncShiftsFromProposal` reconciles `positions_needed`).
- `server/routes/proposals/lifecycle.js` — call the reaper on `archived` / `completed` transitions.
- `server/utils/balanceScheduler.js` — call the reaper in `processEventCompletions` (the autocomplete path bypasses lifecycle).
- `server/routes/proposals/index.js` — mount the admin `changeRequests` router before `crud`.
- `server/routes/clientPortal.js` — mount the client `changeRequests` router.
- `server/middleware/rateLimiters.js` — add `clientPortalWriteLimiter`.
- `server/utils/lifecycleEmailTemplates.js` — add four templates (admin alert, admin SMS body, client approved, client declined).
- `client/src/pages/public/portal/tabs/PrescriptionTab.js` — add the "Request a change" entry point + banner.
- `client/src/pages/admin/ProposalDetail.js` — render the review card.
- `client/src/App.js` — register the admin queue route.
- `README.md` / `ARCHITECTURE.md` / `docs/client-portal-v2-project.md` — docs sweep.

---

## Group A: Harden the apply path (the three fixes)

These land first and independently. They touch only the existing money/staffing code and de-risk the handler everything else will drive through.

### Task A1: Fix 6.2 + 6.3 — demotion covers `confirmed`, apply read takes `FOR UPDATE`

**Files:**
- Modify: `server/routes/proposals/crud.js:430` and `:603-621`
- Test: `server/routes/proposals/crud.demotion.test.js` (Create)

- [ ] **Step 1: Write the failing test**

Create `server/routes/proposals/crud.demotion.test.js`. It seeds a `confirmed`, fully-deposit-paid proposal, PATCHes a higher guest count (raising the total above `amount_paid`), and asserts the status demoted to `deposit_paid`. Mirror the harness in `server/routes/proposals/crud.test.js` (mount `crud` + `lifecycle` routers, sign an admin JWT from an existing `users` row, stub deps).

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const crudRouter = require('./crud');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `cr-demote-%-${NONCE}@example.com`;
let server, baseUrl, adminToken, pkgId;

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

before(async () => {
  const u = await pool.query("SELECT id FROM users WHERE role IN ('admin','manager') LIMIT 1");
  assert.ok(u.rows[0], 'need an admin/manager user seeded');
  adminToken = jwt.sign({ userId: u.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const p = await pool.query('SELECT id FROM service_packages WHERE is_active = true ORDER BY id LIMIT 1');
  pkgId = p.rows[0].id;
  const app = express(); app.use(express.json());
  app.use('/api/proposals', crudRouter);
  app.use((err, rq, rs, nx) => { if (err instanceof AppError) return rs.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors }); console.error(err); return rs.status(500).json({ error: 'x' }); });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

after(async () => {
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposal_addons WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)', [EMAIL_LIKE]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('confirmed proposal demotes to deposit_paid when a guest bump outruns amount_paid', async () => {
  const c = await pool.query('INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', ['CR Demote', `cr-demote-a-${NONCE}@example.com`]);
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, event_duration_hours, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1,'confirmed',$2,100,4,1,4800,1000,'{}') RETURNING id`, [c.rows[0].id, pkgId]);
  const res = await req('PATCH', `/api/proposals/${pr.rows[0].id}`, adminToken, { guest_count: 300 });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'deposit_paid');
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test server/routes/proposals/crud.demotion.test.js`
Expected: FAIL. Today the demotion only fires for `balance_paid`, so a `confirmed` proposal stays `confirmed` and the assertion `deposit_paid` fails.

- [ ] **Step 3: Add `FOR UPDATE` to the apply read (Fix 6.3)**

In `server/routes/proposals/crud.js:430`, change:

```js
    const existing = await dbClient.query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
```
to:
```js
    // FOR UPDATE: the demotion below decides off old.status / old.amount_paid;
    // lock the row so a Stripe webhook promoting to balance_paid can't land
    // between this read and our UPDATE and get silently overwritten (spec 6.3).
    const existing = await dbClient.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [req.params.id]);
```

- [ ] **Step 4: Extend the demotion to `confirmed` and parameterize the log (Fix 6.2)**

In `server/routes/proposals/crud.js:605`, change the condition and the logged `from`:

```js
    if (old.status === 'balance_paid' && newTotalCents > paidCents) {
```
to:
```js
    if ((old.status === 'balance_paid' || old.status === 'confirmed') && newTotalCents > paidCents) {
```

And in the activity-log insert a few lines down, change `from: 'balance_paid'` to `from: old.status`:

```js
        [req.params.id, req.user.id, JSON.stringify({
          from: old.status, to: 'deposit_paid',
          reason: 'price increased above amount paid', new_total: snapshot.total,
        })]
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `node --test server/routes/proposals/crud.demotion.test.js`
Expected: PASS.

- [ ] **Step 6: Run the existing PATCH suite to confirm no regression**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS (the `FOR UPDATE` and widened demotion do not change behavior for the existing `balance_paid` and pre-paid cases).

- [ ] **Step 7: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/crud.demotion.test.js
git commit -m "fix(proposals): demote confirmed on over-paid edit + lock apply read (FOR UPDATE)"
```

### Task A2: Fix 6.1 — `syncShiftsFromProposal` reconciles `positions_needed`

**Files:**
- Modify: `server/utils/eventCreation.js:181-237`
- Test: `server/utils/eventCreation.syncShifts.test.js` (Create)

- [ ] **Step 1: Write the failing test**

Create `server/utils/eventCreation.syncShifts.test.js`:

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { pool } = require('../db');
const { syncShiftsFromProposal } = require('./eventCreation');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `sync-%-${NONCE}@example.com`;
let clientId, pkgId;

before(async () => {
  const c = await pool.query('INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id', ['Sync', `sync-a-${NONCE}@example.com`]);
  clientId = c.rows[0].id;
  pkgId = (await pool.query('SELECT id FROM service_packages ORDER BY id LIMIT 1')).rows[0].id;
});
after(async () => {
  await pool.query('DELETE FROM shifts WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id = $1)', [clientId]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id = $1)', [clientId]);
  await pool.query('DELETE FROM proposals WHERE client_id = $1', [clientId]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
});

test('growth: positions_needed grows to match num_bartenders', async () => {
  const pr = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, num_bartenders, event_date, event_start_time, event_duration_hours)
     VALUES ($1,'deposit_paid',$2,300,3,'2099-09-09','5:00 PM',4) RETURNING id`, [clientId, pkgId]);
  const proposalId = pr.rows[0].id;
  await pool.query(`INSERT INTO shifts (event_date, positions_needed, status, proposal_id) VALUES ('2099-09-09','["Bartender"]','open',$1)`, [proposalId]);
  await syncShiftsFromProposal(proposalId, pool);
  const s = await pool.query('SELECT positions_needed FROM shifts WHERE proposal_id = $1', [proposalId]);
  assert.deepEqual(JSON.parse(s.rows[0].positions_needed), ['Bartender', 'Bartender', 'Bartender']);
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test server/utils/eventCreation.syncShifts.test.js`
Expected: FAIL. `syncShiftsFromProposal` does not touch `positions_needed` today, so it stays `["Bartender"]`.

- [ ] **Step 3: Implement the reconciliation**

In `server/utils/eventCreation.js`, inside `syncShiftsFromProposal`, AFTER `const composedLocation = ...` and BEFORE the `const upd = await db.query(...)` UPDATE, insert:

```js
  // Reconcile staffing slots to the proposal's bartender count (spec 6.1). Grow
  // freely; on shrink never drop below already-approved (non-dropped) assignments,
  // capping there and logging staffing_shrink_capped so admin resolves by hand.
  const desiredSlots = Math.max(1, Number(proposal.num_bartenders) || 1);
  const approvedRes = await db.query(
    `SELECT COUNT(*)::int AS n FROM shift_requests
       WHERE shift_id = (SELECT id FROM shifts WHERE proposal_id = $1 LIMIT 1)
         AND status = 'approved' AND dropped_at IS NULL`,
    [proposalId]
  );
  const approvedCount = approvedRes.rows[0].n;
  const slots = Math.max(desiredSlots, approvedCount);
  if (approvedCount > desiredSlots) {
    await db.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'staffing_shrink_capped', 'system', $2)`,
      [proposalId, JSON.stringify({ desired: desiredSlots, approved: approvedCount, kept: slots })]
    );
  }
  const positionsNeeded = JSON.stringify(Array(slots).fill('Bartender'));
```

Then add `positions_needed = $10` to the UPDATE `SET` list (after `setup_minutes_before = $9`) and append `positionsNeeded` to the params array as the 10th element (after `effectiveSetupMinutes(proposal)`). The `WHERE proposal_id = $8` stays at `$8`, so positional mapping is preserved:

```js
      setup_minutes_before = $9,
      positions_needed = $10
    WHERE proposal_id = $8
    RETURNING *
  `, [
    proposal.event_date,
    startDisplay,
    endDisplay,
    composedLocation,
    proposal.client_name || null,
    proposal.event_type || null,
    proposal.event_type_custom || null,
    proposalId,
    effectiveSetupMinutes(proposal),
    positionsNeeded,
  ]);
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `node --test server/utils/eventCreation.syncShifts.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/utils/eventCreation.js server/utils/eventCreation.syncShifts.test.js
git commit -m "fix(shifts): syncShiftsFromProposal reconciles positions_needed to bartender count"
```

---

## Group B: Schema

### Task B1: Create the `proposal_change_requests` table

**Files:**
- Modify: `server/db/schema.sql` (append at the very bottom)

- [ ] **Step 1: Append the table**

Add at the END of `server/db/schema.sql` (after the final statement). Every statement is idempotent so `initDb()` re-runs it harmlessly on each boot:

```sql
-- ─── Client Portal Change Requests (editing model, spec §3) ───
-- A client-requested booking change. requested_changes is an apply-ready sparse
-- diff (admin-PATCH-shaped). Money is DOLLARS to match proposals.*. One open
-- (pending) request per proposal via the partial-unique index.
CREATE TABLE IF NOT EXISTS proposal_change_requests (
  id                 SERIAL PRIMARY KEY,
  proposal_id        INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  client_id          INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','declined','cancelled')),
  edit_window        VARCHAR(20) NOT NULL
                       CHECK (edit_window IN ('pre_booking','before_t14','inside_t14')),
  requested_changes  JSONB NOT NULL DEFAULT '{}',
  baseline           JSONB NOT NULL DEFAULT '{}',
  note               TEXT,
  price_preview      JSONB NOT NULL DEFAULT '{}',
  acknowledged_total NUMERIC(10,2),
  request_ip         VARCHAR(45),
  request_user_agent TEXT,
  decided_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_at         TIMESTAMPTZ,
  decision_note      TEXT,
  cancelled_by       VARCHAR(10) CHECK (cancelled_by IN ('client','admin','system')),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pcr_one_open
  ON proposal_change_requests(proposal_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pcr_status   ON proposal_change_requests(status);
CREATE INDEX IF NOT EXISTS idx_pcr_proposal ON proposal_change_requests(proposal_id);

DROP TRIGGER IF EXISTS update_pcr_updated_at ON proposal_change_requests;
CREATE TRIGGER update_pcr_updated_at BEFORE UPDATE ON proposal_change_requests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

- [ ] **Step 2: Apply the schema and verify the table exists**

Restart the dev server (it runs `initDb()` on boot) OR run a one-off check. Verify with:

Run: `node -e "require('dotenv').config(); const {pool}=require('./server/db'); pool.query(\"SELECT to_regclass('public.proposal_change_requests') AS t\").then(r=>{console.log(r.rows[0]);process.exit(0)})"`
Expected: prints `{ t: 'proposal_change_requests' }` (not null).

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(schema): proposal_change_requests table for client editing model"
```

---

## Group C: Shared helper + reaper

### Task C1: `server/utils/changeRequests.js` pure helpers

**Files:**
- Create: `server/utils/changeRequests.js`
- Test: `server/utils/changeRequests.test.js`

- [ ] **Step 1: Write the failing test for `computeEditWindow` and `filterToAllowlist`**

Create `server/utils/changeRequests.test.js`:

```js
require('dotenv').config();
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeEditWindow, filterToAllowlist } = require('./changeRequests');

test('computeEditWindow: not booked is pre_booking', () => {
  assert.equal(computeEditWindow({ status: 'sent', event_date: '2099-01-01' }), 'pre_booking');
});
test('computeEditWindow: booked, far out is before_t14', () => {
  assert.equal(computeEditWindow({ status: 'deposit_paid', event_date: '2099-01-01' }), 'before_t14');
});
test('computeEditWindow: booked, past date is inside_t14', () => {
  assert.equal(computeEditWindow({ status: 'confirmed', event_date: '2000-01-01' }), 'inside_t14');
});
test('filterToAllowlist drops note/acknowledged_total and rejects unknown keys', () => {
  const out = filterToAllowlist({ guest_count: 120, note: 'hi', acknowledged_total: 5000 });
  assert.deepEqual(out, { guest_count: 120 });
  assert.throws(() => filterToAllowlist({ total_price_override: 1 }), /not be changed/i);
  assert.throws(() => filterToAllowlist({ adjustments: [] }), /not be changed/i);
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test server/utils/changeRequests.test.js`
Expected: FAIL with "Cannot find module './changeRequests'".

- [ ] **Step 3: Implement the helper module**

Create `server/utils/changeRequests.js`:

```js
const { pool } = require('../db');
const { calculateProposal } = require('./pricingEngine');
const { validateProposalRules, stripIncludedAddons } = require('./proposalRules');
const { ValidationError } = require('./errors');

const BOOKED = new Set(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);

// The only fields a change request may carry. Server-enforced: anything outside
// this set is rejected (spec 3.2), which is what actually keeps discounts /
// total_price_override / setup_minutes_before out of the payload.
const EDITABLE_FIELDS = [
  'event_date', 'event_start_time', 'event_duration_hours',
  'venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip',
  'guest_count', 'package_id', 'num_bars', 'num_bartenders',
  'addon_ids', 'addon_variants', 'addon_quantities',
];
const SIMPLE_FIELDS = EDITABLE_FIELDS.filter(f => !f.startsWith('addon_'));

const MAX_ADDON_QTY = 20;
function safeAddonQty(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return 1;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(MAX_ADDON_QTY, n);
}

// 'pre_booking' when not booked; else inside_t14 within 14 days of the event,
// else before_t14. Approximate at the day boundary, which is fine because every
// window routes to admin anyway (spec 2.4 / 3.3).
function computeEditWindow(proposal) {
  if (!BOOKED.has(proposal.status)) return 'pre_booking';
  if (!proposal.event_date) return 'before_t14';
  const ev = new Date(proposal.event_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = Math.ceil((ev.getTime() - today.getTime()) / 86400000);
  return days <= 14 ? 'inside_t14' : 'before_t14';
}

// Reject any body key outside the allowlist; return the filtered proposed state.
function filterToAllowlist(body) {
  const ignore = new Set(['note', 'acknowledged_total']);
  const unknown = Object.keys(body).filter(k => !ignore.has(k) && !EDITABLE_FIELDS.includes(k));
  if (unknown.length) {
    throw new ValidationError(
      Object.fromEntries(unknown.map(k => [k, 'This field cannot be changed here.'])),
      'Some requested changes are not allowed.'
    );
  }
  const out = {};
  for (const f of EDITABLE_FIELDS) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

async function currentAddonIds(proposalId, db) {
  const r = await db.query('SELECT addon_id FROM proposal_addons WHERE proposal_id = $1', [proposalId]);
  return r.rows.map(x => x.addon_id);
}

// Price a full proposed end-state. Preserves admin-locked fields (adjustments,
// total_price_override, syrups) from the current proposal. Throws ValidationError
// on a rule violation. Returns the pricing snapshot. db is a pool or in-tx client.
async function priceProposedState(proposal, proposed, db = pool) {
  const packageId = proposed.package_id ?? proposal.package_id;
  const pkg = (await db.query('SELECT * FROM service_packages WHERE id = $1', [packageId])).rows[0];
  if (!pkg) throw new ValidationError({ package_id: 'Package not found' });

  const allActive = (await db.query('SELECT * FROM service_addons WHERE is_active = true')).rows;
  const rawIds = Array.isArray(proposed.addon_ids) ? proposed.addon_ids : await currentAddonIds(proposal.id, db);
  const strippedIds = stripIncludedAddons(rawIds, allActive);
  const variants = proposed.addon_variants || {};
  const quantities = proposed.addon_quantities || {};
  const addons = allActive
    .filter(a => strippedIds.includes(a.id))
    .map(a => ({ ...a, variant: variants[String(a.id)] || null, quantity: safeAddonQty(quantities[String(a.id)]) }));

  const guestCount = Number(proposed.guest_count ?? proposal.guest_count);
  validateProposalRules({
    pkg, guestCount, addonIds: strippedIds, addons: allActive,
    clientProvidesGlassware: proposal.client_provides_glassware,
  });

  return calculateProposal({
    pkg,
    guestCount,
    durationHours: Number(proposed.event_duration_hours ?? proposal.event_duration_hours),
    numBars: Number(proposed.num_bars ?? proposal.num_bars ?? 1),
    numBartenders: proposed.num_bartenders ?? null,
    addons,
    syrupSelections: proposal.pricing_snapshot?.syrups?.selections || [],
    adjustments: proposal.adjustments || [],
    totalPriceOverride: proposal.total_price_override ?? null,
  });
}

// Build the { current, estimated, delta, staffing } preview (DOLLARS).
async function buildPreview(proposal, proposed, db = pool) {
  const snapshot = await priceProposedState(proposal, proposed, db);
  const currentTotal = Number(proposal.total_price_override ?? proposal.total_price ?? 0);
  const estimatedTotal = Number(snapshot.total);
  const currentStaffing = Number(proposal.pricing_snapshot?.staffing?.actual ?? proposal.num_bartenders ?? 1);
  return {
    snapshot,
    price_preview: {
      current_total: currentTotal,
      estimated_total: estimatedTotal,
      delta: Math.round((estimatedTotal - currentTotal) * 100) / 100,
      staffing: { current: currentStaffing, estimated: snapshot.staffing.actual },
    },
  };
}

// Sparse diff (requested) + the from-values (baseline) for the audit row.
const NUMERIC_FIELDS = new Set(['event_duration_hours', 'guest_count', 'package_id', 'num_bars', 'num_bartenders']);
async function buildDiff(proposal, proposed, db = pool) {
  const requested = {};
  const baseline = {};
  for (const f of SIMPLE_FIELDS) {
    if (proposed[f] === undefined) continue;
    // Type-aware compare so 4 vs 4.0 (or '4' vs 4) does not log a spurious diff.
    const same = NUMERIC_FIELDS.has(f)
      ? Number(proposed[f]) === Number(proposal[f])
      : String(proposed[f] ?? '') === String(proposal[f] ?? '');
    if (!same) {
      requested[f] = proposed[f];
      baseline[f] = proposal[f] ?? null;
    }
  }
  if (proposed.addon_ids !== undefined) {
    const cur = (await db.query(
      'SELECT addon_id, variant, quantity FROM proposal_addons WHERE proposal_id = $1 ORDER BY addon_id', [proposal.id]
    )).rows;
    const curIds = cur.map(r => r.addon_id).sort((a, b) => a - b);
    const propIds = [...(proposed.addon_ids || [])].sort((a, b) => a - b);
    if (JSON.stringify(curIds) !== JSON.stringify(propIds)
        || JSON.stringify(proposed.addon_variants || {}) !== JSON.stringify(Object.fromEntries(cur.filter(r => r.variant).map(r => [String(r.addon_id), r.variant])))
        || JSON.stringify(proposed.addon_quantities || {}) !== JSON.stringify(Object.fromEntries(cur.map(r => [String(r.addon_id), r.quantity])))) {
      requested.addon_ids = proposed.addon_ids;
      requested.addon_variants = proposed.addon_variants || {};
      requested.addon_quantities = proposed.addon_quantities || {};
      baseline.addons = cur;
    }
  }
  return { requested, baseline };
}

// Reaper: auto-cancel any pending request for a proposal that is no longer
// changeable (archived / completed). Called from lifecycle.js AND
// balanceScheduler.js (the autocomplete path bypasses lifecycle). Best-effort:
// callers wrap in try/catch. db is a pool or in-tx client.
async function cancelPendingChangeRequestsForProposal(proposalId, db = pool) {
  const res = await db.query(
    `UPDATE proposal_change_requests
        SET status = 'cancelled', cancelled_by = 'system',
            decision_note = COALESCE(decision_note, 'auto-cancelled: proposal no longer editable'),
            updated_at = NOW()
      WHERE proposal_id = $1 AND status = 'pending'
      RETURNING id`,
    [proposalId]
  );
  for (const row of res.rows) {
    await db.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, details)
       VALUES ($1, 'change_cancelled', 'system', $2)`,
      [proposalId, JSON.stringify({ change_request_id: row.id, reason: 'proposal_no_longer_editable' })]
    );
  }
  return res.rows.length;
}

module.exports = {
  BOOKED, EDITABLE_FIELDS, SIMPLE_FIELDS, safeAddonQty,
  computeEditWindow, filterToAllowlist,
  priceProposedState, buildPreview, buildDiff,
  cancelPendingChangeRequestsForProposal,
};
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `node --test server/utils/changeRequests.test.js`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add server/utils/changeRequests.js server/utils/changeRequests.test.js
git commit -m "feat(change-requests): shared helper (window, allowlist, price, diff, reaper)"
```

### Task C2: Wire the reaper into the two completion/archive paths

**Files:**
- Modify: `server/routes/proposals/lifecycle.js` (the `archived` block ~157-167 and `completed` block ~168-184)
- Modify: `server/utils/balanceScheduler.js` (`processEventCompletions` per-row loop ~206-232)

- [ ] **Step 1: Add the reaper to the lifecycle status handler**

In `server/routes/proposals/lifecycle.js`, inside the existing `if (status === 'archived') { ... }` block, after the marketing-cancel try/catch, add a best-effort call:

```js
    try {
      const { cancelPendingChangeRequestsForProposal } = require('../../utils/changeRequests');
      await cancelPendingChangeRequestsForProposal(Number(req.params.id));
    } catch (crErr) {
      console.error('Change-request reap on archive failed (non-blocking):', crErr);
    }
```

Add the identical block inside the `if (status === 'completed') { ... }` block (after the existing completion hooks).

- [ ] **Step 2: Add the reaper to the autocomplete scheduler**

In `server/utils/balanceScheduler.js`, inside `processEventCompletions`, in the `for (const proposal of result.rows)` loop, after the existing marketing/payout hooks, add:

```js
        try {
          const { cancelPendingChangeRequestsForProposal } = require('./changeRequests');
          await cancelPendingChangeRequestsForProposal(proposal.id);
        } catch (crErr) {
          console.error(`[BalanceScheduler] change-request reap failed for #${proposal.id}:`, crErr.message);
        }
```

- [ ] **Step 3: Write a test for the reaper helper**

Append to `server/utils/changeRequests.test.js` a DB-backed test (needs the table from Group B):

```js
const { pool } = require('../db');
const { cancelPendingChangeRequestsForProposal } = require('./changeRequests');
const crypto = require('node:crypto');
const { test: dbTest, after: dbAfter } = require('node:test');
const RNONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

dbTest('cancelPendingChangeRequestsForProposal cancels pending rows', async () => {
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id', ['Reap', `reap-${RNONCE}@example.com`]);
  const p = await pool.query("INSERT INTO proposals (client_id, status) VALUES ($1,'completed') RETURNING id", [c.rows[0].id]);
  await pool.query(`INSERT INTO proposal_change_requests (proposal_id, client_id, status, edit_window) VALUES ($1,$2,'pending','before_t14')`, [p.rows[0].id, c.rows[0].id]);
  const n = await cancelPendingChangeRequestsForProposal(p.rows[0].id);
  assert.equal(n, 1);
  const after = await pool.query('SELECT status, cancelled_by FROM proposal_change_requests WHERE proposal_id = $1', [p.rows[0].id]);
  assert.equal(after.rows[0].status, 'cancelled');
  assert.equal(after.rows[0].cancelled_by, 'system');
  await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
});
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `node --test server/utils/changeRequests.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/proposals/lifecycle.js server/utils/balanceScheduler.js server/utils/changeRequests.test.js
git commit -m "feat(change-requests): reap pending requests on archive/complete (both paths)"
```

---

## Group D: Client API

### Task D1: Add the client-portal write limiter

**Files:**
- Modify: `server/middleware/rateLimiters.js`

- [ ] **Step 1: Define and export the limiter**

In `server/middleware/rateLimiters.js`, add near the other user-keyed limiters:

```js
const clientPortalWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => (req.user && req.user.id ? `cp-${req.user.id}` : req.ip),
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
```

Add `clientPortalWriteLimiter` to the `module.exports` object.

- [ ] **Step 2: Commit**

```bash
git add server/middleware/rateLimiters.js
git commit -m "feat(rate-limit): add clientPortalWriteLimiter"
```

### Task D2: The client change-request router (calculate, create, list, cancel)

**Files:**
- Create: `server/routes/clientPortal/changeRequests.js`
- Modify: `server/routes/clientPortal.js` (mount it)
- Test: `server/routes/clientPortal.changeRequests.test.js`

- [ ] **Step 1: Write the failing HTTP test**

Create `server/routes/clientPortal.changeRequests.test.js` (mirror the `clientPortal.home.test.js` harness). Cover: calculate returns a preview; create stores a pending row and returns 201; a second create returns 409; list returns the open request; cancel flips it to cancelled.

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

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `cp-cr-%-${NONCE}@example.com`;
let server, baseUrl, token, proposalToken, pkgId;

function rq(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

before(async () => {
  pkgId = (await pool.query('SELECT id FROM service_packages WHERE is_active = true ORDER BY id LIMIT 1')).rows[0].id;
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id, email', ['CP CR', `cp-cr-a-${NONCE}@example.com`]);
  token = jwt.sign({ id: c.rows[0].id, email: c.rows[0].email, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const p = await pool.query(
    `INSERT INTO proposals (client_id, status, package_id, guest_count, event_duration_hours, num_bars, total_price, amount_paid, event_date, pricing_snapshot)
     VALUES ($1,'deposit_paid',$2,100,4,1,4800,1000,'2099-09-09','{"staffing":{"actual":1}}') RETURNING token`,
    [c.rows[0].id, pkgId]);
  proposalToken = p.rows[0].token;
  const app = express(); app.use(express.json());
  app.use('/api/client-portal', clientPortalRouter);
  app.use((err, rq2, rs, nx) => { if (err instanceof AppError) return rs.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors }); console.error(err); return rs.status(500).json({ error: 'x' }); });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => {
  await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id IN (SELECT id FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1))', [EMAIL_LIKE]);
  await pool.query('DELETE FROM proposals WHERE client_id IN (SELECT id FROM clients WHERE email LIKE $1)', [EMAIL_LIKE]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('calculate returns a preview with current/estimated/delta', async () => {
  const res = await rq('POST', `/api/client-portal/proposals/${proposalToken}/calculate`, token, { guest_count: 300 });
  assert.equal(res.status, 200);
  assert.ok(res.body.price_preview);
  assert.equal(typeof res.body.price_preview.estimated_total, 'number');
});
test('create stores a pending request, second create is 409', async () => {
  const r1 = await rq('POST', `/api/client-portal/proposals/${proposalToken}/change-requests`, token, { guest_count: 300, acknowledged_total: 99999, note: 'more guests' });
  // 409 expected only if acknowledged_total diverges; send the right number:
  const preview = (await rq('POST', `/api/client-portal/proposals/${proposalToken}/calculate`, token, { guest_count: 300 })).body.price_preview;
  const ok = await rq('POST', `/api/client-portal/proposals/${proposalToken}/change-requests`, token, { guest_count: 300, acknowledged_total: preview.estimated_total, note: 'more guests' });
  assert.ok(ok.status === 201 || r1.status === 201);
  // same proposed state (300) + matching ack passes the consent check and hits
  // the partial-unique (a request is already open) -> 409 ALREADY_OPEN.
  const dup = await rq('POST', `/api/client-portal/proposals/${proposalToken}/change-requests`, token, { guest_count: 300, acknowledged_total: preview.estimated_total });
  assert.equal(dup.status, 409);
});
test('list returns the open request; cancel flips it', async () => {
  const list = await rq('GET', `/api/client-portal/proposals/${proposalToken}/change-requests`, token);
  assert.equal(list.status, 200);
  const open = list.body.requests.find(r => r.status === 'pending');
  assert.ok(open);
  const cancel = await rq('POST', `/api/client-portal/proposals/${proposalToken}/change-requests/${open.id}/cancel`, token);
  assert.equal(cancel.status, 200);
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test server/routes/clientPortal.changeRequests.test.js`
Expected: FAIL (routes 404, module not mounted).

- [ ] **Step 3: Implement the client router**

Create `server/routes/clientPortal/changeRequests.js`:

```js
const express = require('express');
const { pool } = require('../../db');
const asyncHandler = require('../../middleware/asyncHandler');
const { NotFoundError, ValidationError, ConflictError } = require('../../utils/errors');
const { clientPortalWriteLimiter } = require('../../middleware/rateLimiters');
const {
  computeEditWindow, filterToAllowlist, buildPreview, buildDiff,
} = require('../../utils/changeRequests');

const router = express.Router();

// Load a proposal by token scoped to the logged-in client. Throws 404 otherwise.
async function loadOwnedProposal(token, clientId, db = pool) {
  const r = await db.query('SELECT * FROM proposals WHERE token = $1 AND client_id = $2', [token, clientId]);
  if (!r.rows[0]) throw new NotFoundError('Proposal not found.');
  return r.rows[0];
}

// Eligibility (spec 3.3): non-archived, non-completed, priced baseline.
function assertEditable(proposal) {
  if (proposal.status === 'archived' || proposal.status === 'completed') {
    throw new ConflictError('This event can no longer be changed online.', 'NOT_EDITABLE');
  }
  // Priced baseline = pricing_snapshot non-empty (spec 3.3 exactly). NOT
  // `total_price > 0 OR snapshot`: priceProposedState later reads
  // pricing_snapshot.syrups / .staffing, so an empty snapshot must be excluded
  // even when total_price happens to be set.
  const snap = proposal.pricing_snapshot;
  const priced = snap && typeof snap === 'object' && Object.keys(snap).length > 0;
  if (!priced) throw new ConflictError('This quote is not finalized yet. Please contact us.', 'UNPRICED');
}

// POST /calculate — price an in-progress edit (no write).
router.post('/proposals/:token/calculate', clientPortalWriteLimiter, asyncHandler(async (req, res) => {
  const proposal = await loadOwnedProposal(req.params.token, req.user.id);
  assertEditable(proposal);
  const proposed = filterToAllowlist(req.body);
  const { price_preview } = await buildPreview(proposal, proposed);
  res.json({ price_preview });
}));

// POST /change-requests — create. Enforces the create-time consent contract.
router.post('/proposals/:token/change-requests', clientPortalWriteLimiter, asyncHandler(async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const pr = await dbClient.query('SELECT * FROM proposals WHERE token = $1 AND client_id = $2 FOR UPDATE', [req.params.token, req.user.id]);
    if (!pr.rows[0]) throw new NotFoundError('Proposal not found.');
    const proposal = pr.rows[0];
    assertEditable(proposal);

    const proposed = filterToAllowlist(req.body);
    if (Object.keys(proposed).length === 0) throw new ValidationError({ _: 'No changes requested.' }, 'Pick at least one change.');

    // Lenient venue revalidation (spec 3.3), matching the admin PATCH
    // (requireStreet:false, requireCityState:false), so a client can correct one
    // venue field without re-entering the whole address. Only runs when a venue
    // field is actually being changed.
    const venueTouched = ['venue_name', 'venue_street', 'venue_city', 'venue_state', 'venue_zip'].some(k => proposed[k] !== undefined);
    if (venueTouched) {
      const { validateVenue } = require('../../utils/venueAddress');
      const venueErrors = validateVenue(proposed, { requireStreet: false, requireCityState: false });
      if (Object.keys(venueErrors).length > 0) throw new ValidationError(venueErrors);
    }

    const { snapshot, price_preview } = await buildPreview(proposal, proposed, dbClient);

    // Create-time consent contract (spec 3.3): the stored acknowledged_total is
    // always a server number the client saw. If their number is stale, 409 with
    // the fresh preview so they re-confirm.
    const ackClient = Number(req.body.acknowledged_total);
    if (!Number.isFinite(ackClient) || Math.round(ackClient * 100) !== Math.round(price_preview.estimated_total * 100)) {
      await dbClient.query('ROLLBACK');
      return res.status(409).json({ code: 'PRICE_CHANGED', price_preview });
    }

    const { requested, baseline } = await buildDiff(proposal, proposed, dbClient);
    const editWindow = computeEditWindow(proposal);
    const ip = (req.headers['x-forwarded-for']?.split(',')[0]?.trim()) || req.socket?.remoteAddress || null;
    const ua = req.headers['user-agent'] || null;

    let inserted;
    try {
      inserted = await dbClient.query(
        `INSERT INTO proposal_change_requests
           (proposal_id, client_id, status, edit_window, requested_changes, baseline, note,
            price_preview, acknowledged_total, request_ip, request_user_agent)
         VALUES ($1,$2,'pending',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [proposal.id, req.user.id, editWindow, JSON.stringify(requested), JSON.stringify(baseline),
         (req.body.note || '').trim() || null, JSON.stringify(price_preview),
         price_preview.estimated_total, ip, ua]
      );
    } catch (e) {
      if (e.code === '23505') { // partial-unique: a request is already open
        await dbClient.query('ROLLBACK');
        const open = await pool.query("SELECT * FROM proposal_change_requests WHERE proposal_id = $1 AND status = 'pending'", [proposal.id]);
        throw new ConflictError('You already have a pending change request for this event.', 'ALREADY_OPEN');
      }
      throw e;
    }
    await dbClient.query(
      `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
       VALUES ($1, 'change_requested', 'client', $2, $3)`,
      [proposal.id, req.user.id, JSON.stringify({ change_request_id: inserted.rows[0].id, edit_window: editWindow, estimated_total: price_preview.estimated_total })]
    );
    await dbClient.query('COMMIT');

    // Best-effort admin notification (Group F wires the real send here).
    try {
      const { notifyAdminOfChangeRequest } = require('../../utils/changeRequestNotifications');
      await notifyAdminOfChangeRequest(inserted.rows[0], proposal);
    } catch (e) { console.error('change-request admin notify failed (non-blocking):', e.message); }

    res.status(201).json({ change_request: inserted.rows[0] });
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    dbClient.release();
  }
}));

// GET /change-requests — open request + bounded history.
router.get('/proposals/:token/change-requests', asyncHandler(async (req, res) => {
  const proposal = await loadOwnedProposal(req.params.token, req.user.id);
  const r = await pool.query(
    `SELECT id, status, edit_window, requested_changes, baseline, note, price_preview,
            acknowledged_total, decision_note, decided_at, cancelled_by, created_at
       FROM proposal_change_requests WHERE proposal_id = $1
      ORDER BY created_at DESC LIMIT 20`,
    [proposal.id]
  );
  res.json({ requests: r.rows });
}));

// POST /change-requests/:id/cancel — client withdraws a pending request.
router.post('/proposals/:token/change-requests/:id/cancel', clientPortalWriteLimiter, asyncHandler(async (req, res) => {
  const proposal = await loadOwnedProposal(req.params.token, req.user.id);
  const r = await pool.query(
    `UPDATE proposal_change_requests SET status = 'cancelled', cancelled_by = 'client', updated_at = NOW()
      WHERE id = $1 AND proposal_id = $2 AND status = 'pending' RETURNING id`,
    [req.params.id, proposal.id]
  );
  if (!r.rows[0]) throw new NotFoundError('No pending request to cancel.');
  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
     VALUES ($1, 'change_cancelled', 'client', $2, $3)`,
    [proposal.id, req.user.id, JSON.stringify({ change_request_id: Number(req.params.id) })]
  );
  res.json({ ok: true });
}));

module.exports = router;
```

- [ ] **Step 4: Stub the notification helper so the route loads**

Create `server/utils/changeRequestNotifications.js` with a no-op that Group F fills in:

```js
// Wired in Group F. No-op stub so the create route can require it now.
async function notifyAdminOfChangeRequest(/* changeRequest, proposal */) {}
async function notifyClientOfDecision(/* changeRequest, proposal, outcome */) {}
module.exports = { notifyAdminOfChangeRequest, notifyClientOfDecision };
```

- [ ] **Step 5: Mount the client router**

In `server/routes/clientPortal.js`, after the existing route definitions and before `module.exports = router;`, add:

```js
// Change-request endpoints (calculate / create / list / cancel). Inherits the
// router-level clientAuth applied above.
router.use('/', require('./clientPortal/changeRequests'));
```

- [ ] **Step 6: Run the test, confirm it passes**

Run: `node --test server/routes/clientPortal.changeRequests.test.js`
Expected: PASS (all three tests).

- [ ] **Step 7: Commit**

```bash
git add server/routes/clientPortal/changeRequests.js server/routes/clientPortal.js server/utils/changeRequestNotifications.js server/routes/clientPortal.changeRequests.test.js
git commit -m "feat(client-portal): change-request API (calculate, create, list, cancel)"
```

---

## Group E: Admin API + PATCH integration

### Task E1: Admin router (queue, per-proposal list, decline)

**Files:**
- Create: `server/routes/proposals/changeRequests.js`
- Modify: `server/routes/proposals/index.js` (mount before `crud`)
- Test: `server/routes/proposals/changeRequests.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/routes/proposals/changeRequests.test.js` (admin JWT from a `users` row, mount the admin router). Assert: the queue lists a pending row; decline flips it to `declined` with a reason and logs `change_declined`.

```js
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const adminRouter = require('./changeRequests');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const EMAIL_LIKE = `adm-cr-%-${NONCE}@example.com`;
let server, baseUrl, adminToken, crId, proposalId;

function rq(method, path, tok, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + (u.search || ''), method,
      headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { let j = null; try { j = d ? JSON.parse(d) : null; } catch {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

before(async () => {
  const u = await pool.query("SELECT id FROM users WHERE role IN ('admin','manager') LIMIT 1");
  adminToken = jwt.sign({ userId: u.rows[0].id, tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id', ['Adm CR', `adm-cr-a-${NONCE}@example.com`]);
  const p = await pool.query("INSERT INTO proposals (client_id, status, event_date) VALUES ($1,'deposit_paid','2099-09-09') RETURNING id", [c.rows[0].id]);
  proposalId = p.rows[0].id;
  const cr = await pool.query("INSERT INTO proposal_change_requests (proposal_id, client_id, status, edit_window, price_preview) VALUES ($1,$2,'pending','before_t14','{\"estimated_total\":5000}') RETURNING id", [proposalId, c.rows[0].id]);
  crId = cr.rows[0].id;
  const app = express(); app.use(express.json());
  app.use('/api/proposals', adminRouter);
  app.use((err, a, rs, n) => { if (err instanceof AppError) return rs.status(err.statusCode).json({ error: err.message, code: err.code }); console.error(err); return rs.status(500).json({ error: 'x' }); });
  await new Promise(r => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
after(async () => {
  await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  await pool.query('DELETE FROM clients WHERE email LIKE $1', [EMAIL_LIKE]);
  await new Promise(r => server.close(r));
});

test('queue lists the pending request', async () => {
  const res = await rq('GET', '/api/proposals/change-requests?status=pending', adminToken);
  assert.equal(res.status, 200);
  assert.ok(res.body.requests.some(r => r.id === crId));
});
test('decline flips to declined with a reason', async () => {
  const res = await rq('POST', `/api/proposals/change-requests/${crId}/decline`, adminToken, { decision_note: 'No availability that date.' });
  assert.equal(res.status, 200);
  const row = await pool.query('SELECT status, decision_note FROM proposal_change_requests WHERE id = $1', [crId]);
  assert.equal(row.rows[0].status, 'declined');
  assert.equal(row.rows[0].decision_note, 'No availability that date.');
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `node --test server/routes/proposals/changeRequests.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the admin router**

Create `server/routes/proposals/changeRequests.js`:

```js
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');

const router = express.Router();

// GET /api/proposals/change-requests?status=pending — the admin queue.
router.get('/change-requests', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const status = req.query.status || 'pending';
  const r = await pool.query(
    `SELECT cr.*, p.token AS proposal_token, p.event_date, p.event_type, p.event_type_custom,
            c.name AS client_name, c.email AS client_email
       FROM proposal_change_requests cr
       JOIN proposals p ON p.id = cr.proposal_id
       LEFT JOIN clients c ON c.id = cr.client_id
      WHERE cr.status = $1
      ORDER BY (cr.edit_window = 'inside_t14') DESC, cr.created_at ASC
      LIMIT 200`,
    [status]
  );
  res.json({ requests: r.rows });
}));

// GET /api/proposals/:id/change-requests — one proposal's requests.
router.get('/:id/change-requests', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const r = await pool.query(
    'SELECT * FROM proposal_change_requests WHERE proposal_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.params.id]
  );
  res.json({ requests: r.rows });
}));

// POST /api/proposals/change-requests/:id/decline — decline with a required reason.
router.post('/change-requests/:id/decline', auth, requireAdminOrManager, asyncHandler(async (req, res) => {
  const note = (req.body.decision_note || '').trim();
  if (!note) throw new ValidationError({ decision_note: 'A reason is required to decline.' });
  const r = await pool.query(
    `UPDATE proposal_change_requests
        SET status = 'declined', decided_by = $1, decided_at = NOW(), decision_note = $2, updated_at = NOW()
      WHERE id = $3 AND status = 'pending' RETURNING *`,
    [req.user.id, note, req.params.id]
  );
  if (!r.rows[0]) throw new NotFoundError('No pending request to decline.');
  const cr = r.rows[0];
  await pool.query(
    `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
     VALUES ($1, 'change_declined', 'admin', $2, $3)`,
    [cr.proposal_id, req.user.id, JSON.stringify({ change_request_id: cr.id })]
  );
  try {
    const { notifyClientOfDecision } = require('../../utils/changeRequestNotifications');
    const p = await pool.query('SELECT * FROM proposals WHERE id = $1', [cr.proposal_id]);
    await notifyClientOfDecision(cr, p.rows[0], 'declined');
  } catch (e) { console.error('decline notify failed (non-blocking):', e.message); }
  res.json({ change_request: cr });
}));

module.exports = router;
```

- [ ] **Step 4: Mount it before `crud`**

In `server/routes/proposals/index.js`, add the mount line BEFORE the `crud` line:

```js
router.use('/', require('./actions'));
router.use('/', require('./changeRequests'));
router.use('/', require('./crud'));
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `node --test server/routes/proposals/changeRequests.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/proposals/changeRequests.js server/routes/proposals/index.js server/routes/proposals/changeRequests.test.js
git commit -m "feat(proposals): admin change-request API (queue, list, decline)"
```

### Task E2: PATCH approve linkage, email suppression, non-linked reconciliation

**Files:**
- Modify: `server/routes/proposals/crud.js` (destructure ~416-424, near COMMIT ~666, reschedule email gate ~691)
- Test: extend `server/routes/proposals/changeRequests.test.js`

- [ ] **Step 1: Write the failing test (approve linkage)**

Append to `server/routes/proposals/changeRequests.test.js` a test that mounts the `crud` router too, PATCHes a proposal with `change_request_id`, and asserts the request flips to `approved`. (Add `const crudRouter = require('./crud');` and `app.use('/api/proposals', crudRouter);` in `before`, after the admin router mount.)

```js
test('PATCH with change_request_id stamps the request approved', async () => {
  const c = await pool.query('INSERT INTO clients (name,email) VALUES ($1,$2) RETURNING id', ['Adm CR2', `adm-cr-b-${NONCE}@example.com`]);
  const pkg = (await pool.query('SELECT id FROM service_packages WHERE is_active=true ORDER BY id LIMIT 1')).rows[0].id;
  const p = await pool.query("INSERT INTO proposals (client_id, status, package_id, guest_count, event_duration_hours, num_bars, total_price, amount_paid, event_date, pricing_snapshot) VALUES ($1,'deposit_paid',$2,100,4,1,4800,1000,'2099-09-09','{}') RETURNING id", [c.rows[0].id, pkg]);
  const cr = await pool.query("INSERT INTO proposal_change_requests (proposal_id, client_id, status, edit_window) VALUES ($1,$2,'pending','before_t14') RETURNING id", [p.rows[0].id, c.rows[0].id]);
  const res = await rq('PATCH', `/api/proposals/${p.rows[0].id}`, adminToken, { guest_count: 120, change_request_id: cr.rows[0].id });
  assert.equal(res.status, 200);
  const row = await pool.query('SELECT status, decided_by FROM proposal_change_requests WHERE id = $1', [cr.rows[0].id]);
  assert.equal(row.rows[0].status, 'approved');
  await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [p.rows[0].id]);
  await pool.query('DELETE FROM clients WHERE id = $1', [c.rows[0].id]);
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `node --test server/routes/proposals/changeRequests.test.js`
Expected: FAIL (the request stays `pending`; PATCH ignores `change_request_id` today).

- [ ] **Step 3: Add `change_request_id` to the PATCH destructure**

In `server/routes/proposals/crud.js:416-424`, add `change_request_id` to the destructured body:

```js
    notify_assigned_staff, notify_staff_sms, notify_staff_email,
    change_request_id
  } = req.body;
```

- [ ] **Step 4: Stamp the request approved inside the transaction (before COMMIT)**

In `server/routes/proposals/crud.js`, immediately BEFORE `await dbClient.query('COMMIT');` (around line 666), add:

```js
    // Change-request approve linkage (spec 5.2). Validate the request belongs to
    // this proposal and is pending; stamp approved atomically with the edit. A
    // bad id is logged and skipped, never failing the edit.
    if (change_request_id) {
      const crUpd = await dbClient.query(
        `UPDATE proposal_change_requests
            SET status = 'approved', decided_by = $1, decided_at = NOW(), updated_at = NOW()
          WHERE id = $2 AND proposal_id = $3 AND status = 'pending' RETURNING id`,
        [req.user.id, change_request_id, req.params.id]
      );
      if (crUpd.rows[0]) {
        await dbClient.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
           VALUES ($1, 'change_approved', 'admin', $2, $3)`,
          [req.params.id, req.user.id, JSON.stringify({ change_request_id })]
        );
      } else {
        console.warn(`PATCH change_request_id ${change_request_id} not pending/owned by proposal ${req.params.id}; skipping stamp`);
      }
    }
```

- [ ] **Step 5: Suppress the duplicate client reschedule email on a change-request apply**

In `server/routes/proposals/crud.js:691`, change the gate so the reschedule email does not fire when this PATCH is a change-request apply (the client gets the single approval email from Group F instead):

```js
    if (shouldSendRescheduleEmail && !change_request_id) {
```

- [ ] **Step 6: Add the non-linked reconciliation (auto-cancel a superseded pending request)**

Still in `crud.js`, inside the transaction, right after the `change_request_id` stamp block from Step 4 (and still before COMMIT), add the reconciliation for a direct edit with NO `change_request_id`:

```js
    // Non-linked reconciliation (spec 5.2 / 5.4): a direct admin edit (no
    // change_request_id) supersedes any pending request, so auto-cancel it.
    if (!change_request_id) {
      // Auto-cancel any pending request, marking it superseded for the audit detail.
      const sup = await dbClient.query(
        `UPDATE proposal_change_requests
            SET status = 'cancelled', cancelled_by = 'system',
                decision_note = 'superseded by direct admin edit', updated_at = NOW()
          WHERE proposal_id = $1 AND status = 'pending' RETURNING id`,
        [req.params.id]
      );
      for (const row of sup.rows) {
        await dbClient.query(
          `INSERT INTO proposal_activity_log (proposal_id, action, actor_type, actor_id, details)
           VALUES ($1, 'change_cancelled', 'admin', $2, $3)`,
          [req.params.id, req.user.id, JSON.stringify({ change_request_id: row.id, reason: 'superseded_by_direct_edit' })]
        );
      }
    }
```

This uses an inline UPDATE (not the shared reaper helper) so the audit `decision_note` reads "superseded by direct admin edit", distinct from the system reaper's reason.

- [ ] **Step 7: Run the test, confirm it passes**

Run: `node --test server/routes/proposals/changeRequests.test.js`
Expected: PASS.

- [ ] **Step 8: Run the existing PATCH suite for no regression**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/routes/proposals/crud.js server/routes/proposals/changeRequests.test.js
git commit -m "feat(proposals): PATCH approve-linkage + email suppression + non-linked reconciliation"
```

---

## Group F: Notifications

### Task F1: Templates + the notification helper

**Files:**
- Modify: `server/utils/lifecycleEmailTemplates.js` (add three email templates)
- Modify: `server/utils/changeRequestNotifications.js` (replace the stub with real sends)

- [ ] **Step 1: Add email templates**

In `server/utils/lifecycleEmailTemplates.js`, add three pure templates near the other client templates, each returning `{ subject, html, text }` using the existing `wrapEmail` / `ctaButton` / `BRAND` / `esc` helpers. Export them in the module's exports object.

```js
function changeRequestAdminAlert({ clientName, eventLabel, editWindow, estimatedTotal, currentTotal, note, adminUrl }) {
  const urgent = editWindow === 'inside_t14';
  return {
    subject: `${urgent ? '[Soon] ' : ''}Change request from ${clientName} (${eventLabel})`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">New change request</h2>
      <p><strong>${esc(clientName)}</strong> requested a change to their <strong>${esc(eventLabel)}</strong>.</p>
      <p>Current total: $${Number(currentTotal).toFixed(2)}<br/>Estimated new total: $${Number(estimatedTotal).toFixed(2)}</p>
      ${note ? `<p>Note: ${esc(note)}</p>` : ''}
      ${urgent ? `<p style="color:${BRAND.primary};"><strong>This event is within 2 weeks. Verify staffing before approving.</strong></p>` : ''}
      ${ctaButton(adminUrl, 'Review request')}
    `),
    text: `${clientName} requested a change to their ${eventLabel}. Current $${Number(currentTotal).toFixed(2)}, estimated $${Number(estimatedTotal).toFixed(2)}. ${note ? 'Note: ' + note + '. ' : ''}Review: ${adminUrl}`,
  };
}

function changeRequestApproved({ clientName, eventLabel, newTotal, balanceDue, portalUrl }) {
  return {
    subject: `Your changes are confirmed (${eventLabel})`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">Your changes are confirmed</h2>
      <p>Hi ${esc(clientName || 'there')},</p>
      <p>We have updated your <strong>${esc(eventLabel)}</strong>. Your new total is <strong>$${Number(newTotal).toFixed(2)}</strong>.</p>
      ${Number(balanceDue) > 0 ? `<p>Balance remaining: <strong>$${Number(balanceDue).toFixed(2)}</strong>. You can pay it from your portal.</p>` : ''}
      ${ctaButton(portalUrl, 'View your event')}
      <p>Cheers,<br/>The Dr. Bartender Team</p>
    `),
    text: `Hi ${clientName || 'there'}, your ${eventLabel} changes are confirmed. New total $${Number(newTotal).toFixed(2)}.${Number(balanceDue) > 0 ? ` Balance remaining $${Number(balanceDue).toFixed(2)}.` : ''} View: ${portalUrl}`,
  };
}

function changeRequestDeclined({ clientName, eventLabel, reason, portalUrl }) {
  return {
    subject: `About your requested change (${eventLabel})`,
    html: wrapEmail(`
      <h2 style="color:${BRAND.primary};margin-top:0;">About your requested change</h2>
      <p>Hi ${esc(clientName || 'there')},</p>
      <p>We were not able to make the change you requested to your <strong>${esc(eventLabel)}</strong>.</p>
      <p>${esc(reason)}</p>
      <p>Reply to this email and we will help find the right option.</p>
      ${ctaButton(portalUrl, 'View your event')}
    `),
    text: `Hi ${clientName || 'there'}, we could not make your requested change to your ${eventLabel}. ${reason} Reply to this email and we will help. ${portalUrl}`,
  };
}
```

- [ ] **Step 2: Implement the notification helper**

Replace `server/utils/changeRequestNotifications.js` with real sends:

```js
const { pool } = require('../db');
const { sendEmail } = require('./email');
const { sendSMS } = require('./sms');
const templates = require('./lifecycleEmailTemplates');
const { getEventTypeLabel } = require('./eventTypes');

const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL || 'https://drbartender.com';
const ADMIN_URL = process.env.CLIENT_URL || 'https://admin.drbartender.com';

function labelFor(proposal) {
  return getEventTypeLabel({ event_type: proposal.event_type, event_type_custom: proposal.event_type_custom });
}

// Admin alert on a new request. Email always; SMS only for inside_t14 when ADMIN_PHONE set.
async function notifyAdminOfChangeRequest(cr, proposal) {
  const c = (await pool.query('SELECT name FROM clients WHERE id = $1', [proposal.client_id])).rows[0] || {};
  const pv = cr.price_preview || {};
  const tpl = templates.changeRequestAdminAlert({
    clientName: c.name || 'A client', eventLabel: labelFor(proposal), editWindow: cr.edit_window,
    estimatedTotal: pv.estimated_total ?? 0, currentTotal: pv.current_total ?? 0,
    note: cr.note, adminUrl: `${ADMIN_URL}/proposals/${proposal.id}`,
  });
  if (process.env.ADMIN_EMAIL) await sendEmail({ to: process.env.ADMIN_EMAIL, ...tpl });
  if (cr.edit_window === 'inside_t14' && process.env.ADMIN_PHONE) {
    await sendSMS({ to: process.env.ADMIN_PHONE, body: tpl.text }).catch(e => console.error('admin CR sms failed:', e.message));
  }
}

// Client email on a decision (approved / declined). Re-reads the proposal for the
// fresh total/balance after an approve+apply.
async function notifyClientOfDecision(cr, proposal, outcome) {
  const c = (await pool.query('SELECT name, email FROM clients WHERE id = $1', [proposal.client_id])).rows[0] || {};
  if (!c.email) return;
  const portalUrl = `${PUBLIC_SITE_URL}/my-proposals/${proposal.token}`;
  let tpl;
  if (outcome === 'approved') {
    const total = Number(proposal.total_price_override ?? proposal.total_price ?? 0);
    const balance = total - Number(proposal.amount_paid ?? 0);
    tpl = templates.changeRequestApproved({ clientName: c.name, eventLabel: labelFor(proposal), newTotal: total, balanceDue: balance, portalUrl });
  } else {
    tpl = templates.changeRequestDeclined({ clientName: c.name, eventLabel: labelFor(proposal), reason: cr.decision_note || 'The change was not available.', portalUrl });
  }
  await sendEmail({ to: c.email, ...tpl });
}

module.exports = { notifyAdminOfChangeRequest, notifyClientOfDecision };
```

- [ ] **Step 3: Send the approved client email after a change-request apply**

The PATCH stamps the request approved (Task E2) but the client email should fire post-commit. In `server/routes/proposals/crud.js`, in the post-commit area (after the reschedule/staff hooks, near line 753), add:

```js
    if (change_request_id) {
      try {
        const { notifyClientOfDecision } = require('../../utils/changeRequestNotifications');
        const crRow = await pool.query('SELECT * FROM proposal_change_requests WHERE id = $1', [change_request_id]);
        if (crRow.rows[0] && crRow.rows[0].status === 'approved') {
          // Re-read the proposal fresh (not updatedRow) so the email's total and
          // balance reflect any post-commit cascade above (the demotion, the
          // additional-services invoice). This is the single client touch for the
          // change, so the new balance has to be right.
          const freshP = await pool.query('SELECT * FROM proposals WHERE id = $1', [req.params.id]);
          await notifyClientOfDecision(crRow.rows[0], freshP.rows[0], 'approved');
        }
      } catch (notifyErr) {
        console.error('change-request approved email failed (non-blocking):', notifyErr.message);
      }
    }
```

- [ ] **Step 4: Verify templates compile and the notify helper loads**

Run: `node -e "require('dotenv').config(); const t=require('./server/utils/lifecycleEmailTemplates'); console.log(typeof t.changeRequestAdminAlert, typeof t.changeRequestApproved, typeof t.changeRequestDeclined); require('./server/utils/changeRequestNotifications'); console.log('ok')"`
Expected: prints `function function function` then `ok`.

- [ ] **Step 5: Run the client + admin suites (notifications are gated off in dev, so sends are no-ops)**

Run: `node --test server/routes/clientPortal.changeRequests.test.js` then `node --test server/routes/proposals/changeRequests.test.js`
Expected: PASS for both (SEND_NOTIFICATIONS is off in dev, so `sendEmail`/`sendSMS` log-and-skip).

- [ ] **Step 6: Commit**

```bash
git add server/utils/lifecycleEmailTemplates.js server/utils/changeRequestNotifications.js server/routes/proposals/crud.js
git commit -m "feat(change-requests): admin alert + client decision notifications"
```

---

## Group G: Frontend

No client test harness exists. Each task ends by building the client (`cd client && set CI=true&& npx react-scripts build`) to confirm it compiles, plus a manual browser check against a local dev server.

### Task G1: The client change-request form + banner

**Files:**
- Create: `client/src/pages/public/portal/ChangeRequestForm.js`
- Create: `client/src/pages/public/portal/tabs/ChangeRequestBanner.js`
- Modify: `client/src/pages/public/portal/tabs/PrescriptionTab.js`

- [ ] **Step 1: Build the banner component**

Create `client/src/pages/public/portal/tabs/ChangeRequestBanner.js`. It shows the pending/decided state for the open request, with a "Withdraw" action.

```js
import React from 'react';
function fmt(n) { return `$${Number(n || 0).toFixed(2)}`; }
export default function ChangeRequestBanner({ request, onWithdraw }) {
  if (!request) return null;
  if (request.status === 'pending') {
    const pv = request.price_preview || {};
    return (
      <div className="client-alert" role="status">
        <strong>Change requested, pending review.</strong>{' '}
        Estimated new total {fmt(pv.estimated_total)}.{' '}
        <button type="button" className="btn-link" onClick={onWithdraw}>Withdraw request</button>
      </div>
    );
  }
  if (request.status === 'approved') return <div className="client-alert client-alert-success" role="status"><strong>Your changes are in.</strong> Check your updated total below.</div>;
  if (request.status === 'declined') return <div className="client-alert client-alert-error" role="status"><strong>We could not make that change.</strong> {request.decision_note} Reply to our email and we will help.</div>;
  return null;
}
```

- [ ] **Step 2: Build the form component**

Create `client/src/pages/public/portal/ChangeRequestForm.js`. It pre-fills from the loaded proposal detail, exposes guest count / duration / bars (plus a free-text note), debounces a live `calculate` call (passing the `db_client_token` header explicitly), shows current/estimated/delta, and submits with the consent contract (re-confirm on a `409`).

```js
import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as Sentry from '@sentry/react';
import api from '../../../utils/api';
import { useToast } from '../../../context/ToastContext';

const authHeader = () => { const t = localStorage.getItem('db_client_token'); return t ? { Authorization: `Bearer ${t}` } : {}; };
const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function ChangeRequestForm({ proposal, token, onSubmitted, onCancel }) {
  const toast = useToast();
  const [form, setForm] = useState({
    guest_count: proposal.guest_count, event_duration_hours: proposal.event_duration_hours,
    num_bars: proposal.num_bars || 1, event_date: proposal.event_date ? String(proposal.event_date).slice(0, 10) : '',
    note: '',
  });
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const seq = useRef(0);

  const proposed = useCallback(() => ({
    guest_count: Number(form.guest_count), event_duration_hours: Number(form.event_duration_hours),
    num_bars: Number(form.num_bars), ...(form.event_date ? { event_date: form.event_date } : {}),
  }), [form]);

  const fetchPreview = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const { data } = await api.post(`/client-portal/proposals/${token}/calculate`, proposed(), { headers: authHeader() });
      if (mine !== seq.current) return;
      setPreview(data.price_preview); setPreviewError(false);
    } catch (e) {
      if (mine !== seq.current) return;
      setPreview(null); setPreviewError(true);
      Sentry.captureException(e, { tags: { area: 'client-portal', surface: 'change-request-calculate' } });
    }
  }, [token, proposed]);

  useEffect(() => { const t = setTimeout(fetchPreview, 300); return () => clearTimeout(t); }, [fetchPreview]);

  const submit = async () => {
    if (!preview || previewError) { toast.error('We could not price this change. Please try again.'); return; }
    setSubmitting(true);
    try {
      await api.post(`/client-portal/proposals/${token}/change-requests`,
        { ...proposed(), note: form.note, acknowledged_total: preview.estimated_total },
        { headers: authHeader() });
      toast.success('Request sent. We will confirm shortly.');
      onSubmitted && onSubmitted();
    } catch (e) {
      if (e.status === 409 && e.code === 'PRICE_CHANGED') {
        toast.error('The price updated. Review the new estimate and submit again.');
        // re-price so the user sees the fresh number
        fetchPreview();
      } else if (e.status === 409) {
        toast.error('You already have a pending request for this event.');
      } else {
        toast.error(e.message || 'Could not send your request.');
      }
    } finally { setSubmitting(false); }
  };

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div className="cp-change-form">
      <h3>Request a change</h3>
      <label className="form-label">Guest count
        <input type="number" min="1" max="1000" value={form.guest_count} onChange={e => set('guest_count', e.target.value)} />
      </label>
      <label className="form-label">Duration (hours)
        <input type="number" min="1" max="12" step="0.5" value={form.event_duration_hours} onChange={e => set('event_duration_hours', e.target.value)} />
      </label>
      <label className="form-label">Number of bars
        <input type="number" min="1" max="10" value={form.num_bars} onChange={e => set('num_bars', e.target.value)} />
      </label>
      <label className="form-label">Event date (subject to availability)
        <input type="date" value={form.event_date} onChange={e => set('event_date', e.target.value)} />
      </label>
      <label className="form-label">Anything else
        <textarea value={form.note} onChange={e => set('note', e.target.value)} rows={3} />
      </label>

      <div className="cp-change-preview">
        {previewError && <div className="client-alert client-alert-error">We could not price this change. Adjust and try again.</div>}
        {preview && !previewError && (
          <>
            <div className="cp-leader"><span>Current total</span><span>{fmt(preview.current_total)}</span></div>
            <div className="cp-leader"><span>Estimated new total</span><span>{fmt(preview.estimated_total)}</span></div>
            <div className="cp-leader"><span>Change</span><span>{preview.delta >= 0 ? '+' : ''}{fmt(preview.delta)}</span></div>
            <p className="form-hint">Reductions are reviewed by our team; any refund is handled individually.</p>
          </>
        )}
      </div>

      <div className="cp-rx-actions">
        <button type="button" className="btn client-btn-primary" disabled={submitting || !preview || previewError} onClick={submit}>
          {submitting ? 'Sending...' : 'Send request'}
        </button>
        <button type="button" className="btn-link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire the entry point into `PrescriptionTab`**

In `client/src/pages/public/portal/tabs/PrescriptionTab.js`: import `ChangeRequestForm`, `ChangeRequestBanner`, and `api`; add state for the open request and a "show form" toggle; fetch `GET /client-portal/proposals/:token/change-requests` on load; render the banner above the totals and a "Request a change" button in the existing `.cp-rx-actions` block when there is no pending request (and the event is editable). On submit or withdraw, re-fetch the request list.

Add inside the component body (after the existing detail fetch effect):

```js
  const [requests, setRequests] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const loadRequests = useCallback(async () => {
    try { const { data } = await api.get(`/client-portal/proposals/${focus.token}/change-requests`, { headers: { Authorization: `Bearer ${localStorage.getItem('db_client_token')}` } });
      setRequests(data.requests || []); } catch { /* non-fatal */ }
  }, [focus.token]);
  useEffect(() => { loadRequests(); }, [loadRequests]);
  const openRequest = requests.find(r => r.status === 'pending');
  const lastDecided = requests.find(r => r.status === 'approved' || r.status === 'declined');
  const editable = focus.status !== 'archived' && focus.status !== 'completed';
  const withdraw = async () => {
    if (!openRequest) return;
    try { await api.post(`/client-portal/proposals/${focus.token}/change-requests/${openRequest.id}/cancel`, {}, { headers: { Authorization: `Bearer ${localStorage.getItem('db_client_token')}` } });
      loadRequests(); } catch (e) { /* toast handled upstream */ }
  };
```

In the JSX, render the banner near the top of the `cp-rx` block:

```jsx
<ChangeRequestBanner request={openRequest || lastDecided} onWithdraw={withdraw} />
```

And in the `.cp-rx-actions` block, add the entry point + inline form:

```jsx
{editable && !openRequest && !showForm && (
  <button type="button" className="btn client-btn-secondary" onClick={() => setShowForm(true)}>Request a change</button>
)}
{showForm && (
  <ChangeRequestForm proposal={p} token={focus.token}
    onSubmitted={() => { setShowForm(false); loadRequests(); }}
    onCancel={() => setShowForm(false)} />
)}
```

(Add the imports at the top: `import { useCallback } from 'react';` if not present, `import api from '../../../../utils/api';` if not present, `import ChangeRequestForm from '../ChangeRequestForm';`, `import ChangeRequestBanner from './ChangeRequestBanner';`.)

- [ ] **Step 4: Build the client to confirm it compiles**

Run: `cd client && set CI=true&& npx react-scripts build`
Expected: "Compiled successfully" (warnings ok, no errors).

- [ ] **Step 5: Manual browser check**

Start the dev server, log into the portal as a client with a booked event, open the Prescription tab, change the guest count, confirm the live estimate updates, submit, and confirm the pending banner appears. Withdraw and confirm it clears.

- [ ] **Step 6: Commit**

```bash
git add client/src/pages/public/portal/ChangeRequestForm.js client/src/pages/public/portal/tabs/ChangeRequestBanner.js client/src/pages/public/portal/tabs/PrescriptionTab.js
git commit -m "feat(client-portal): change-request form + status banner on Prescription tab"
```

### Task G2: Admin review card + queue page

The apply mechanic uses the codebase's existing inline editor: `ProposalDetail` swaps in `ProposalDetailEditForm` when the URL carries `?edit=1` (there is no `/proposals/:id/edit` route). "Apply in editor" deep-links to `/proposals/:id?edit=1&change_request_id=<id>`, which pre-fills the editor from the request and rides `change_request_id` through the editor's existing PATCH (wired by Tasks G2 Step 3 and Step 4 below + the PATCH linkage from Task E2). The review card shows the request-time `price_preview`; the live editor recomputes the fresh total when admin opens it, which is where spec 5.1's "freshly recomputed preview" actually lands for v1.

**Files:**
- Create: `client/src/pages/admin/ProposalChangeRequestCard.js`
- Create: `client/src/pages/admin/ChangeRequestsDashboard.js`
- Modify: `client/src/pages/admin/ProposalDetail.js`
- Modify: `client/src/pages/admin/ProposalDetailEditForm.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: Build the review card**

Create `client/src/pages/admin/ProposalChangeRequestCard.js`. It loads `GET /proposals/:id/change-requests`, shows the pending request's diff + price preview + note, an "Apply in editor" link that deep-links to the proposal edit screen carrying `?change_request_id=`, and a Decline action.

```js
import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../../utils/api';
import { useToast } from '../../context/ToastContext';

const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;

export default function ProposalChangeRequestCard({ proposalId, onChanged }) {
  const toast = useToast();
  const [requests, setRequests] = useState([]);
  const [reason, setReason] = useState('');
  const load = useCallback(() => api.get(`/proposals/${proposalId}/change-requests`).then(r => setRequests(r.data.requests || [])).catch(() => {}), [proposalId]);
  useEffect(() => { load(); }, [load]);
  const open = requests.find(r => r.status === 'pending');
  if (!open) return null;
  const pv = open.price_preview || {};
  const decline = async () => {
    if (!reason.trim()) { toast.error('Add a reason to decline.'); return; }
    try { await api.post(`/proposals/change-requests/${open.id}/decline`, { decision_note: reason });
      toast.success('Request declined.'); setReason(''); load(); onChanged && onChanged(); }
    catch (e) { toast.error(e.message || 'Failed to decline.'); }
  };
  return (
    <div className="card">
      <div className="card-head"><h3>Change request {open.edit_window === 'inside_t14' && <span className="badge badge-danger">Within 2 weeks: verify staffing</span>}</h3></div>
      <div className="card-body">
        <div className="dl"><dt>Current total</dt><dd>{fmt(pv.current_total)}</dd>
          <dt>Estimated new total</dt><dd>{fmt(pv.estimated_total)}</dd>
          <dt>Client acknowledged</dt><dd>{fmt(open.acknowledged_total)}</dd></div>
        <pre className="cr-diff">{JSON.stringify(open.requested_changes, null, 2)}</pre>
        {open.note && <p><strong>Note:</strong> {open.note}</p>}
        {Number(pv.delta) < 0 && (
          <div className="client-alert client-alert-warning">
            This is a reduction (change {fmt(pv.delta)}). Handle any refund or credit through the existing tools, then record what you did in the decision note below before you apply or decline. Nothing auto-refunds.
          </div>
        )}
        <div className="cr-actions">
          <Link className="btn btn-primary" to={`/proposals/${proposalId}?edit=1&change_request_id=${open.id}`}>Apply in editor</Link>
        </div>
        <div className="cr-decline">
          <textarea placeholder="Reason (required to decline)" value={reason} onChange={e => setReason(e.target.value)} rows={2} />
          <button type="button" className="btn btn-danger" onClick={decline}>Decline</button>
        </div>
      </div>
    </div>
  );
}
```

The `Link` reuses the existing `?edit=1` deep-link that `ProposalDetail` already honors. Steps 3 and 4 wire the pre-fill and the `change_request_id` pass-through.

- [ ] **Step 2: Render the card on Proposal Detail**

In `client/src/pages/admin/ProposalDetail.js`, import the card and render it in the left column (near the other cards, e.g. after the Event card), passing `onChanged={loadProposal}`:

```jsx
<ProposalChangeRequestCard proposalId={id} onChanged={loadProposal} />
```

- [ ] **Step 3: Pass the change request into the editor from `ProposalDetail`**

`ProposalDetail.js` already reads `?edit=1` (line ~56) and strips it after mount (lines ~93-99). Extend that to also read `change_request_id`, fetch the matching request, and pass it to the editor.

Near the `editing` state, add:

```js
const [pendingCr, setPendingCr] = useState(null); // the request being applied (from ?change_request_id)
const [openCr, setOpenCr] = useState(null);       // any pending request, for the direct-edit warning (W1)
const crId = searchParams.get('change_request_id');
useEffect(() => {
  api.get(`/proposals/${id}/change-requests`)
    .then(r => {
      const rows = r.data.requests || [];
      setOpenCr(rows.find(x => x.status === 'pending') || null);
      setPendingCr(crId ? (rows.find(x => String(x.id) === String(crId)) || null) : null);
    })
    .catch(() => {});
}, [crId, id]);
```

Render a warning banner in the `editing` branch when admin opens the editor on a proposal that has a pending request but is NOT applying it (spec §5.2), just before `<ProposalDetailEditForm .../>`:

```jsx
  {openCr && !crId && (
    <div className="client-alert client-alert-warning" role="status">
      Heads up: this proposal has a pending change request from the client. Saving a
      direct edit will supersede it (the request is auto-cancelled on save). To apply
      the client's request instead, cancel out and use "Apply in editor" on the
      change-request card.
    </div>
  )}

In the existing cleanup effect that deletes `edit` from the query string, also delete `change_request_id` so a reload does not re-inject it:

```js
    next.delete('edit');
    next.delete('change_request_id');
```

Pass the request to the editor in the `editing` branch (the `<ProposalDetailEditForm .../>` mount around line 298):

```jsx
  <ProposalDetailEditForm
    proposal={proposal}
    changeRequest={pendingCr}
    onSaved={() => { setEditing(false); setPendingCr(null); setLoading(true); loadProposal(); }}
    onCancel={() => setEditing(false)}
  />
```

- [ ] **Step 4: Overlay the request and pass `change_request_id` in `ProposalDetailEditForm`**

In `client/src/pages/admin/ProposalDetailEditForm.js`:

1. Add `changeRequest` to the prop destructure (line ~27): `export default function ProposalDetailEditForm({ proposal, changeRequest, onSaved, onCancel }) {`.

2. After the initial `useState(() => initialFormFromProposal(proposal))` and the existing addon-catalog re-baseline effect (lines ~40-65), add a one-shot overlay that applies `changeRequest.requested_changes` onto the form AND re-baselines `initialRef.current`, so the pre-fill does not trip the unsaved-changes guard:

```js
const crAppliedRef = useRef(false);
useEffect(() => {
  if (!changeRequest || crAppliedRef.current) return;
  crAppliedRef.current = true;
  const rc = changeRequest.requested_changes || {};
  setEditForm(prev => {
    const next = { ...prev };
    for (const k of Object.keys(rc)) {
      if (k === 'event_date' && rc[k]) next.event_date = String(rc[k]).slice(0, 10);
      else next[k] = rc[k];
    }
    // Re-baseline the dirty guard. initialRef holds a JSON STRING
    // (`useRef(JSON.stringify(initialFormFromProposal(proposal)))` at ~line 37), and
    // the guard compares `JSON.stringify(editForm) !== initialRef.current`, so the
    // baseline MUST be stringified or every later keystroke reads as dirty. The
    // assignment is idempotent (same `next` -> same string), so StrictMode's
    // double-invoke of the updater is harmless.
    initialRef.current = JSON.stringify(next);
    return next;
  });
}, [changeRequest]);
```

3. In `handleSave` (the `api.patch(`/proposals/${proposal.id}`, {...})` body at lines ~190-217), add `change_request_id` to the body object so the approve-linkage from Task E2 fires:

```js
    setup_minutes_before: editForm.setup_minutes_before === '' || editForm.setup_minutes_before == null
      ? null
      : Number(editForm.setup_minutes_before),
    change_request_id: changeRequest?.id,
  });
```

(`useRef` is already imported in this file; if not, add it to the React import.)

- [ ] **Step 5: Build the queue page**

Create `client/src/pages/admin/ChangeRequestsDashboard.js`:

```js
import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../../utils/api';
const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;
export default function ChangeRequestsDashboard() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/proposals/change-requests?status=pending').then(r => setRows(r.data.requests)).catch(() => setRows([])); }, []);
  if (rows === null) return <div className="loading" role="status"><div className="spinner" />Loading...</div>;
  if (rows.length === 0) return <div className="empty-state">No pending change requests.</div>;
  return (
    <div className="page">
      <h1>Change requests</h1>
      <table className="data-table">
        <thead><tr><th>Client</th><th>Event</th><th>Window</th><th>Est. total</th><th></th></tr></thead>
        <tbody>{rows.map(r => (
          <tr key={r.id} className={r.edit_window === 'inside_t14' ? 'row-urgent' : ''}>
            <td>{r.client_name}</td><td>{r.event_type_custom || r.event_type || 'event'}</td>
            <td>{r.edit_window.replace('_', ' ')}</td><td>{fmt(r.price_preview?.estimated_total)}</td>
            <td><Link to={`/proposals/${r.proposal_id}`}>Review</Link></td>
          </tr>))}</tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 6: Register the queue route**

In `client/src/App.js`, add the lazy import near the other admin pages:

```js
const ChangeRequestsDashboard = lazy(() => import('./pages/admin/ChangeRequestsDashboard'));
```

And add the route inside the admin shell block (the `ProtectedRoute adminOnly` + `AdminLayout` parent), alongside `/proposals`:

```jsx
<Route path="/change-requests" element={<ChangeRequestsDashboard />} />
```

- [ ] **Step 7: Build the client to confirm it compiles**

Run: `cd client && set CI=true&& npx react-scripts build`
Expected: "Compiled successfully".

- [ ] **Step 8: Manual browser check**

As admin, open a proposal that has a pending request and confirm the review card shows the diff and preview; visit `/change-requests` and confirm the queue lists it with inside-2-weeks rows highlighted; decline one and confirm it disappears.

- [ ] **Step 9: Commit**

```bash
git add client/src/pages/admin/ProposalChangeRequestCard.js client/src/pages/admin/ChangeRequestsDashboard.js client/src/pages/admin/ProposalDetail.js client/src/pages/admin/ProposalDetailEditForm.js client/src/App.js
git commit -m "feat(admin): change-request review card + queue page + apply-in-editor wiring"
```

---

## Group H: Docs

### Task H1: Documentation sweep

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `docs/client-portal-v2-project.md`

- [ ] **Step 1: README**

Add the new route files to the folder-structure tree (`server/routes/clientPortal/changeRequests.js`, `server/routes/proposals/changeRequests.js`, the client pages) and note the editing model under Key Features.

- [ ] **Step 2: ARCHITECTURE**

Add the new endpoints to the API route table (`POST/GET /api/client-portal/proposals/:token/change-requests` + `/calculate` + `/:id/cancel`; `GET /api/proposals/change-requests`, `GET /api/proposals/:id/change-requests`, `POST /api/proposals/change-requests/:id/decline`; the `change_request_id` param on `PATCH /api/proposals/:id`), and add `proposal_change_requests` to the Database Schema section.

- [ ] **Step 3: Tracker**

In `docs/client-portal-v2-project.md`, flip sub-project #5 status from "Design done, spec written" to "In build" (or "Done" when the build merges), and check off the editing-model checklist items now implemented.

- [ ] **Step 4: Commit**

```bash
git add README.md ARCHITECTURE.md docs/client-portal-v2-project.md
git commit -m "docs: client portal editing model (routes, schema, tracker)"
```

---

## Execution-review checkpoints

Run the specialized review agents at these group boundaries (foreground), matched to what each batch changed. Clean results proceed; any flag follows the root-cause fix discipline in CLAUDE.md.

- After **Group A** (money/concurrency fixes to `crud.js` + `eventCreation.js`): `code-review` + `database-review`.
- After **Group B** (schema): `database-review`.
- After **Group E** (admin PATCH linkage, the most sensitive money/auth surface): `security-review` + `code-review` + `consistency-check`.
- After **Group F** (notification copy + money units): `code-review`.
- After **Group G** (admin card / editor / PATCH consistency): `consistency-check`.

## Carried review notes (apply while you touch each file, not as separate tasks)

Small design-review findings folded in here rather than as standalone tasks:

- **(W3)** When adding the `!change_request_id` reschedule-email suppression (E2 Step 5), confirm it gates only client-facing emails (the reschedule email, and any invoice/balance-due client notice in the cascade) and never the staff hooks.
- **(W4)** Confirm `app.set('trust proxy', ...)` is set so `request_ip` is captured from `x-forwarded-for` consistently with the signature path; otherwise the consent IP will not match the signature's.
- **(W5)** `crud.js` is already ~797 lines (over the 700 soft cap); this plan adds ~48. It stays under the 1000 hard cap so the ratchet allows it, but open a follow-up to split the PATCH handler.
- **(W6)** Add a one-line smoke check after D1 that `require('../middleware/rateLimiters').clientPortalWriteLimiter` is a function before committing.
- **(W7)** Tighten the D2 create test: assert `r1.status === 409` and `ok.status === 201` explicitly instead of the weak OR.
- **(W8)** In the create handler, bound the `addon_quantities` map (reject if it carries more keys than the active add-on set) so a hostile client cannot send a giant map.
- **(W9)** Drop the orphaned `dbAfter` import in the C2 test (no `dbAfter` block is used).
- **(S2)** Optional: split G2 into read-only review (card + dashboard + route) vs apply-in-editor overlay, so the read path can land independently.
- **(S3 / §5.1)** Conscious deferral: the review card shows the request-time `price_preview`; the fresh recompute happens when admin opens the editor. Acceptable for v1.
- **(S7)** Add the shrink-cap test (A2), a suppression-fires test (E2), a template snapshot test (F1), a `pkgId` assert (A1), and a partial-unique-index existence check (B1) as you write each.
- **(S8)** Anchor F1 Step 3's notify block precisely: after the staff-hooks try/catch (`crud.js:~753`), before `res.json(updatedRow.rows[0])`.
- **(Declined, S4)** Gemini suggested clearing autopay only when `from === 'balance_paid'`. Declined: clearing it unconditionally on the demotion is the money-safer choice (it stops the balance scheduler from auto-charging a now-stale amount) and matches spec §6.2. Keep it unconditional.

## Final verification

- [ ] Run the full server test suite: `npm test`. Expected: all green (run new suites individually first if the shared DB causes cross-suite teardown collisions, per the project's test-DB note).
- [ ] Build the client: `cd client && set CI=true&& npx react-scripts build`. Expected: compiles clean.
- [ ] Confirm the file-size ratchet is satisfied: `npm run check:filesize`. Expected: no new RED files (the new route/util files are well under 700 lines; `crud.js` only grew by the small linkage block).
- [ ] Manual end-to-end: client submits a change, admin sees it in the queue and on the proposal, applies it in the editor with `change_request_id`, the request flips to approved, the client gets one confirmation email (dev: logged-and-skipped), and the proposal total/balance reflect the change.

This whole project runs in its own worktree (`npm run worktree:new -- client-portal-editing`) off `main`, merged back from the `os` window when verified.
