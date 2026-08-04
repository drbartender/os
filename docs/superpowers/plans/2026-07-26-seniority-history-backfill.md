---
plan: seniority-history-backfill
spec: docs/superpowers/specs/2026-07-26-seniority-history-backfill-design.md
lanes:
  - id: seniority-baseline-core
    footprint:
      - server/db/schema.sql
      - ARCHITECTURE.md
      - server/utils/autoAssign.js
      - server/routes/admin/users.js
      - server/utils/autoAssign.seniority.test.js
      - server/routes/admin/users.seniority.test.js
    depends_on: []
    sensitive: true          # schema.sql is on scripts/sensitive-paths.txt
    review_fleet: [code-review, security-review, database-review, consistency-check]
    second_opinion: true     # runs at push because a sensitive path is touched
  - id: seniority-panel-ui
    footprint:
      - client/src/pages/admin/userDetail/tabs/PayoutsTab.js
      - client/src/pages/admin/userDetail/AdminUserDetail.js
    depends_on: [seniority-baseline-core]
    sensitive: false
    review_fleet: [code-review, ui-ux-review]   # light look + client CI build gate
  - id: cc-seniority-import
    footprint:
      - server/scripts/staffPaymentImport/generateSeniorityMapping.js
      - server/scripts/staffPaymentImport/generateSeniorityMapping.test.js
      - server/scripts/staffPaymentImport/applySeniorityBackfill.js
      - server/scripts/staffPaymentImport/seniorityBackfill.test.js
      - server/scripts/staffPaymentImport/ccReports.js
      - README.md
    depends_on: [seniority-baseline-core]
    sensitive: false         # not on sensitive-paths.txt; writes seniority fields but human-gated + dry-run default. Fleet consciously scoped to code+database+consistency (no security-review/second-opinion): sign off at review.
    review_fleet: [code-review, database-review, consistency-check]
parallelism: "seniority-baseline-core first; seniority-panel-ui and cc-seniority-import run in parallel after it merges."
---

# Seniority History Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credit migrated staff with their true CheckCherry hire date and pre-migration event count so the seniority score reflects real tenure and experience.

**Architecture:** Add one column, `contractor_profiles.historical_events_worked`, that is added to the live OS event count at every site that computes `events_worked` (the auto-assign ranker and the admin seniority route). `hire_date` (an existing column) is set directly from the CheckCherry date. Both values are written only through a human-reviewed CheckCherry→OS mapping produced by a read-only generator and applied by a dry-run-default script.

**Tech Stack:** Node 26 / Express 4, raw parameterized SQL via `pg` (no ORM), React 18 (CRA), `node:test` against the shared dev DB.

## Global Constraints

- **`events_worked = live_OS_count + historical_events_worked` at EVERY compute site.** There are exactly two: `server/utils/autoAssign.js` and `server/routes/admin/users.js`. The ranker and every displayed number must always agree.
- **`historical_events_worked`**: `INTEGER NOT NULL DEFAULT 0 CHECK (>= 0)`. A zero baseline is a no-op for every non-migrated profile.
- **`hire_date` is set directly from the CheckCherry `Created At` date**, truncated to a DATE. No earliest-wins logic in code; the "proposed date lands later than current" case is only a *flag* in the review CSV.
- **Do not touch** `seniority_adjustment`, the seniority weights (`0.7`/`0.3`), or the auto-assign normalization cap (`maxSeniorityRaw = 50`).
- **Writes only via the human-approved mapping.** The generator is read-only; the apply script is dry-run by default and writes only on `--apply`, only `include=yes` rows, idempotently.
- **Raw SQL, parameterized (`$1`…), no ORM. Schema statements idempotent (`IF NOT EXISTS`).**
- **Server tests:** `node:test`, one suite at a time, shared dev DB, `require('dotenv').config()`, set `process.env.SEND_NOTIFICATIONS='false'`, refuse to run under `NODE_ENV=production`, clean up fixtures by a unique PREFIX in `after`. **Always invoke from the repo root** — every suite here self-loads dotenv, which resolves `.env` against `process.cwd()`, so a suite run from `server/` gets no `DATABASE_URL` and fails in a way that looks like a code fault. (`scripts/testdb-smoke.js` uses `node -r dotenv/config --test <file>` for the same reason; either form is fine from the root, and the `-r` form is required for any suite that does not self-load.)
- **Fixture dates are built in the local (Chicago) frame** — `new Date(y, monthIndex, d)`, or SQL like `CURRENT_DATE + 30`. Never key a fixture off `new Date('YYYY-MM-DD')` (that is UTC midnight, a different instant). Reading back is the mirror rule: a `pg` DATE column returns a Date at **local** midnight, so render it with `toYmd`/`toISOString().slice(0,10)` and never `String(d).slice(0,10)`, which yields `"Tue Jun 10"`.
- **A locally-green suite is not evidence about a CHECK constraint.** Dev is a weaker schema shape than prod. The prod-shaped check is `node scripts/testdb-smoke.js` (Task 1.3 Step 5b).
- **Client verification:** `cd client && CI=true npx react-scripts build` (the `.husky/pre-push` gate). `AdminUserDetail.js` is 674 lines, keep additions minimal (soft cap 700).
- **Docs:** update `README.md` (folder tree / scripts) and `ARCHITECTURE.md` (Database Schema section) in the same lane as the code.
- **Git:** explicit path staging only; `os` never leaves `main`; lanes squash-merge.

---

## Lane 1: seniority-baseline-core

### Task 1.1: Add the `historical_events_worked` column

**Files:**
- Modify: `server/db/schema.sql` (line 1190, immediately after the `hire_date` ALTER in the "Auto-Assign: contractor_profiles additions" block at 1186-1191; match on the exact anchor string below, not the line number)

- [ ] **Step 1: Add the idempotent column next to `seniority_adjustment` / `hire_date`**

In `server/db/schema.sql`, immediately after the existing line:
```sql
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS hire_date DATE;
```
add:
```sql
-- Pre-migration (CheckCherry) events worked, added to the live OS event count
-- wherever seniority is computed. Default 0 makes every non-migrated profile a
-- no-op. Seeded from the CheckCherry export via the human-reviewed mapping
-- (server/scripts/staffPaymentImport/applySeniorityBackfill.js).
ALTER TABLE contractor_profiles ADD COLUMN IF NOT EXISTS historical_events_worked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contractor_profiles DROP CONSTRAINT IF EXISTS contractor_profiles_historical_events_nonneg;
ALTER TABLE contractor_profiles ADD CONSTRAINT contractor_profiles_historical_events_nonneg CHECK (historical_events_worked >= 0);
```

- [ ] **Step 2: Apply the schema to the dev DB and verify the column AND the constraint exist**

Apply through `initDb()`, never a raw `pool.query(wholeFile)`. `server/db/index.js` splits `schema.sql` into statements (`splitStatements`) and runs them one at a time, swallowing only the `IDEMPOTENT_PG_CODES` set (42P07/42710/42701/…) per statement. A single simple-query call with the whole file is ONE implicit transaction, so the first statement that legitimately raises a duplicate-object error on a populated DB aborts the entire batch and the new column is never created — the verification below would then report an absent column with no explanation. `initDb()` is also exactly what boot and the pre-push gate run, so this step validates the real path.

Run from the repo root:
```bash
node -r dotenv/config -e "const {pool, initDb}=require('./server/db'); (async()=>{ await initDb(); const c=await pool.query(\"SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='contractor_profiles' AND column_name='historical_events_worked'\"); console.log(c.rows); const k=await pool.query(\"SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='contractor_profiles'::regclass AND conname='contractor_profiles_historical_events_nonneg'\"); console.log(k.rows); await pool.end();})()"
```
Expected: one column row → `historical_events_worked | integer | NO | 0`, and one constraint row → `CHECK ((historical_events_worked >= 0))`.

Check the constraint row explicitly, do not assume it. Per `[[reference-dev-db-missing-check-constraints]]` the dev DB is a WEAKER shape than prod and has silently lost CHECK constraints before. This column cannot lose it the same way (it is brand new, `NOT NULL DEFAULT 0`, so no pre-existing row can violate the ADD), but a green local suite is never evidence the constraint exists — only this query is. See Task 1.3 Step 5b for the prod-shaped gate.

- [ ] **Step 3: Update ARCHITECTURE.md schema section**

In `ARCHITECTURE.md`, in the `**contractor_profiles**` block of the Database Schema section (lines 742-752), add a bullet directly after the `seniority_adjustment` bullet (line 748, which follows `hire_date` on 747): `historical_events_worked` (integer, NOT NULL default 0) described as "pre-migration (CheckCherry) event credit added to the live event count at every seniority compute site."

- [ ] **Step 3b: Confirm no existing writer resets the new column**

A backfilled baseline that a routine re-hire silently zeroes would be worse than no baseline. `server/utils/contractorSeed.js` carries the header "KEEP IN SYNC WITH schema.sql contractor_profiles + PUT /api/admin/users/:id/profile", which is a standing instruction to consider it on every column addition. Confirm the three writers, do not assume:

```bash
grep -rn "INSERT INTO contractor_profiles\|UPDATE contractor_profiles" server --include=*.js | grep -v "\.test\.js"
```

Verified against main 2026-08-04 — all three are safe **because they name their columns explicitly**, and the answer here is deliberately "change nothing":
- `server/utils/contractorSeed.js:17-94` (the admin "Hire" button + the pre-hire application flow) — the INSERT column list and the `ON CONFLICT (user_id) DO UPDATE SET` list both omit `historical_events_worked`, so a re-hire leaves it alone.
- `server/routes/admin/users.js:302+` `PUT /users/:id/profile` — explicit column list, omits it.
- `server/routes/admin/users.js:187-195` — the skeleton-row upsert, only `user_id` + `hire_date`.

Do NOT "helpfully" add the column to any of them. If a future edit switches one of these to a wholesale column assignment, this baseline is what it destroys.

One adjacent writer worth knowing about, also unchanged: `server/routes/admin/settings.js:103-116` backfills `hire_date = u.created_at::date` for hired staff **whose hire_date IS NULL**. It cannot clobber a CheckCherry date (the CC apply writes a non-NULL value, so the `IS NULL` predicate excludes it afterward), and if it runs first it only means the mapping CSV shows an OS-onboarding `current_hire_date` for comparison. Either order is correct.

- [ ] **Step 4: Commit**

```bash
git add server/db/schema.sql ARCHITECTURE.md
git commit -m "feat(seniority): add contractor_profiles.historical_events_worked column"
```

---

### Task 1.2: Auto-assign ranker counts live + historical events

**Files:**
- Modify: `server/utils/autoAssign.js:169` (step-2 profile SELECT) and `:224-273` (step-5 scoring)
- Test: `server/utils/autoAssign.seniority.test.js` (create)

**Interfaces:**
- Consumes: `autoAssignShift(shiftId, { dryRun: true })` → `{ scores: [{ user_id, scores: { events_worked, seniority, … } }] }` (existing signature).
- Produces: for each scored candidate, `scores.events_worked` = live past-dated approved count **plus** `contractor_profiles.historical_events_worked`; the seniority sub-score is computed from that same total.

- [ ] **Step 1: Write the failing test**

Create `server/utils/autoAssign.seniority.test.js`:
```javascript
require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('autoAssign.seniority.test.js refuses to run against production');
}

// Post-approval hooks not under test → no-ops (mutate before requiring autoAssign).
require('./staffShiftHandlers').scheduleStaffShiftMessages = async () => {};
require('./lastMinuteStaffingConfirmation').confirmStaffingIfFullyStaffed = async () => {};
const { autoAssignShift } = require('./autoAssign');

const PREFIX = 'aa-seniority-test-';
let userId, shiftId;

before(async () => {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`${PREFIX}u@example.com`]
  );
  userId = u.rows[0].id;
  // Contractor profile: NO live OS events, but 12 historical (pre-migration).
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, historical_events_worked)
     VALUES ($1, $2, 12)`,
    [userId, `${PREFIX}Vet`]
  );
  // A future shift needing one bartender. positions_needed uses the
  // {position,count} shape, parsePositionsNeeded reads entry.position, NOT
  // entry.role. equipment_required is left unset (autoAssign coalesces it to '[]').
  const s = await pool.query(
    `INSERT INTO shifts (event_date, positions_needed, status)
     VALUES (CURRENT_DATE + 30, $1, 'open') RETURNING id`,
    [JSON.stringify([{ position: 'Bartender', count: 1 }])]
  );
  shiftId = s.rows[0].id;
  // One pending bartender request from our vet.
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, status, position)
     VALUES ($1, $2, 'pending', 'Bartender')`,
    [shiftId, userId]
  );
});

after(async () => {
  await pool.query(`DELETE FROM shift_requests WHERE shift_id = $1`, [shiftId]);
  await pool.query(`DELETE FROM shifts WHERE id = $1`, [shiftId]);
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  await pool.end();
});

test('historical_events_worked is added to the live event count in the ranker', async () => {
  const result = await autoAssignShift(shiftId, { dryRun: true });
  const mine = result.scores.find((s) => s.user_id === userId);
  assert.ok(mine, 'candidate scored');
  // 0 live + 12 historical = 12
  assert.equal(mine.scores.events_worked, 12);
  assert.ok(mine.scores.seniority > 0, 'seniority reflects the historical credit');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from the repo root: `node --test server/utils/autoAssign.seniority.test.js`
Expected: FAIL, `events_worked` is `0` (baseline not yet summed), assertion `12 === 0` fails.

- [ ] **Step 2b: Confirm the events-count reader set (guard against a third site)**

Spec §3.2 requires that every reader of the live events count receives the live+baseline change. Confirm the set before editing:
```bash
grep -rnE "event_date < CURRENT_DATE|events_worked|computeSeniorityScore" server --include=*.js | grep -v "\.test\.js" | grep -viE "staffPaymentImport|clientPortal"
```
Expected: hits ONLY in `server/utils/autoAssign.js` and `server/routes/admin/users.js` (the `clientPortal.js` past-date query is over proposals, not shifts, and is correctly excluded). If a third file appears, it is in scope for the same change before proceeding.

Re-run verbatim against main on 2026-08-04 (113 commits after this plan was written): still exactly those two files, at `admin/users.js:533,536,541,556` and `autoAssign.js:43,195,201,207,225,268,427`. Neither the staffing-roster/assign-position work (7/22) nor the staff event-details redesign (8/03) nor service-extension added a compute site. Widen the sweep once more before editing, because the flag word for a *display* site is different from a compute site:
```bash
grep -rnE "events_worked|tenure_months|seniority" client/src --include=*.js | grep -v "\.test\.js"
```
Expected THREE display sites, all fed by the GET seniority route, so all three inherit the new total automatically once Task 1.3 lands:
- `client/src/pages/admin/userDetail/tabs/PayoutsTab.js:164-172` — the Seniority card (Task 2.1 edits this one).
- `client/src/pages/admin/userDetail/AdminUserDetail.js:431` — the **identity-bar stat row**, `{tenure_months}mo tenure · {events_worked} events worked`. Task 2.1 deliberately does NOT edit it: it reads `seniority.events_worked`, which becomes the total, so it stays correct with zero changes. It is named here so a reviewer does not read its absence from the Lane 2 footprint as a miss, and so the Task 2.1 Step 6 smoke checks it.
- `client/src/pages/admin/SettingsDashboard.js:216-235` — the auto-assign *weights* editor. Reads no per-user count; out of scope (weights are untouched per Global Constraints).

No client surface renders the auto-assign dry-run `scores.events_worked`, so the ranker's copy of the number has no second display to keep in sync.

- [ ] **Step 3: Add the column to the step-2 profile SELECT**

In `server/utils/autoAssign.js`, in the pending-requests query (~line 162-173), add the column. Change:
```javascript
           cp.equipment_will_pickup, cp.seniority_adjustment,
           cp.hire_date, cp.city, cp.state
```
to:
```javascript
           cp.equipment_will_pickup, cp.seniority_adjustment,
           cp.hire_date, cp.city, cp.state, cp.historical_events_worked
```

- [ ] **Step 4: Sum live + historical in step-5 scoring**

In the `scored = pendingResult.rows.map(candidate => {` block (~line 224), at the top of the callback add a single total, then use it in both the seniority computation and the displayed field. Replace:
```javascript
  const scored = pendingResult.rows.map(candidate => {
    const seniority = computeSeniorityScore(
      eventsMap[candidate.user_id] || 0,
      candidate.hire_date,
      candidate.seniority_adjustment,
      seniorityWeights
    );
```
with:
```javascript
  const scored = pendingResult.rows.map(candidate => {
    // Seniority counts OS-native past events PLUS the pre-migration baseline.
    const totalEvents = (eventsMap[candidate.user_id] || 0) + (candidate.historical_events_worked || 0);
    const seniority = computeSeniorityScore(
      totalEvents,
      candidate.hire_date,
      candidate.seniority_adjustment,
      seniorityWeights
    );
```
and change the displayed field (~line 268) from:
```javascript
        events_worked: eventsMap[candidate.user_id] || 0,
```
to:
```javascript
        events_worked: totalEvents,
```

- [ ] **Step 5: Run the test to verify it passes**

Run from the repo root: `node --test server/utils/autoAssign.seniority.test.js`
Expected: PASS.

- [ ] **Step 6: Run the neighbouring auto-assign suites (no regression)**

Run each separately (both hit the shared dev DB; never combine them in one `node --test` invocation, which parallelizes files, see Global Constraints):
```bash
node --test server/utils/autoAssign.claim.test.js
node --test server/utils/autoAssign.bartenderScope.test.js
```
Expected: PASS for each.

- [ ] **Step 7: Commit**

```bash
git add server/utils/autoAssign.js server/utils/autoAssign.seniority.test.js
git commit -m "feat(seniority): count live + historical events in auto-assign ranker"
```

---

### Task 1.3: Admin seniority route returns and accepts the baseline

**Files:**
- Modify: `server/routes/admin/users.js:524-577` (GET + PUT `/users/:id/seniority`)
- Test: `server/routes/admin/users.seniority.test.js` (create)

**Interfaces:**
- Produces (GET response): existing `events_worked` becomes the **total** (live + baseline), plus two new fields `events_worked_live` and `historical_events_worked`; `computed_score` uses the total.
- Produces (PUT body): accepts `historical_events_worked` alongside `hire_date` and `seniority_adjustment`, `COALESCE`-to-keep semantics.

- [ ] **Step 1: Write the failing test**

Create `server/routes/admin/users.seniority.test.js`. This mirrors the exact harness of `server/routes/admin/users.activeStaff.test.js`, a real `node:http` server over `express` with the `usersRouter` mounted at `/api/admin`, a jwt admin token, and a small `req()` helper (extended here to send a JSON body):
```javascript
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const usersRouter = require('./users');

if (process.env.NODE_ENV === 'production') {
  throw new Error('users.seniority.test.js refuses to run against production');
}

const PREFIX = 'seniority-route-test-';
let server, baseUrl, userId, adminId, adminToken;

before(async () => {
  const a = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'admin', 'approved') RETURNING id`,
    [`${PREFIX}admin@example.com`]
  );
  adminId = a.rows[0].id;
  adminToken = jwt.sign({ userId: adminId, tokenVersion: 0 }, process.env.JWT_SECRET);

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status)
     VALUES ($1, 'x', 'staff', 'approved') RETURNING id`,
    [`${PREFIX}staff@example.com`]
  );
  userId = u.rows[0].id;
  // Contractor profile, NO shifts → 0 live events.
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name) VALUES ($1, $2)`,
    [userId, `${PREFIX}Vet`]
  );

  const app = express();
  app.use(express.json());
  app.use('/api/admin', usersRouter);
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  });
  server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[userId, adminId].filter(Boolean)]);
  await pool.end();
});

function req(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = { Authorization: `Bearer ${token}` };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const r = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname + (url.search || ''), headers },
      (res) => { let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null })); }
    );
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

test('GET seniority returns live + historical split; PUT persists the baseline', async () => {
  const put = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
    { historical_events_worked: 9, hire_date: '2025-03-01' });
  assert.equal(put.status, 200);

  const res = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(res.status, 200);
  assert.equal(res.body.historical_events_worked, 9);
  assert.equal(res.body.events_worked_live, 0);
  assert.equal(res.body.events_worked, 9);              // total = live + historical
  assert.ok(res.body.computed_score >= 6.3);            // 9*0.7 + tenure*0.3 (tenure ≥ 0)
});

// The DB CHECK is a backstop, NOT the validator. Dev and prod disagree about
// which CHECK constraints exist ([[reference-dev-db-missing-check-constraints]]),
// so the route must reject bad input itself and return a field error, not let
// Postgres raise 23514/22P02 into an opaque 500. Both cases assert the value on
// disk is untouched, which is what makes this a real guard rather than a
// status-code assertion.
test('PUT rejects a negative or non-numeric baseline with 400 and writes nothing', async () => {
  for (const bad of [-5, '-5', 'abc', 1.5]) {
    const r = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
      { historical_events_worked: bad });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}, got ${r.status}`);
    assert.ok(r.body.error, 'a client-visible message is returned');
  }
  const after = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(after.body.historical_events_worked, 9, 'rejected writes never landed');
});

// Omitting the field must KEEP the stored value (COALESCE-to-keep). This is the
// lane-ordering guard: Lane 1 merges before Lane 2, so for a window the deployed
// client PUTs a body with no historical_events_worked at all, and that must not
// zero a freshly backfilled baseline.
test('PUT without the field preserves the stored baseline', async () => {
  const r = await req('PUT', `/api/admin/users/${userId}/seniority`, adminToken,
    { seniority_adjustment: 2 });
  assert.equal(r.status, 200);
  const after = await req('GET', `/api/admin/users/${userId}/seniority`, adminToken);
  assert.equal(after.body.historical_events_worked, 9);
  assert.equal(after.body.seniority_adjustment, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run from the repo root: `node --test server/routes/admin/users.seniority.test.js`
Expected: FAIL, `historical_events_worked` is `undefined` in the response, PUT ignores it, and the negative-baseline PUT returns 200 instead of 400.

- [ ] **Step 3: Update the GET handler**

In `server/routes/admin/users.js`, replace the GET body (lines ~527-559) so the profile SELECT pulls the baseline and the total is live + baseline:
```javascript
  const [profileRes, eventsRes] = await Promise.all([
    pool.query(
      'SELECT hire_date, seniority_adjustment, historical_events_worked FROM contractor_profiles WHERE user_id = $1',
      [userId]
    ),
    pool.query(`
      SELECT COUNT(*) AS events_worked
      FROM shift_requests sr
      JOIN shifts s ON s.id = sr.shift_id
      WHERE sr.user_id = $1 AND sr.status = 'approved' AND sr.dropped_at IS NULL AND s.event_date < CURRENT_DATE
    `, [userId])
  ]);

  const profile = profileRes.rows[0] || {};
  const liveEvents = parseInt(eventsRes.rows[0]?.events_worked || 0, 10);
  const historicalEvents = parseInt(profile.historical_events_worked || 0, 10);
  const eventsWorked = liveEvents + historicalEvents;

  let tenureMonths = 0;
  if (profile.hire_date) {
    const hire = new Date(profile.hire_date);
    const now = new Date();
    tenureMonths = Math.max(0, (now.getUTCFullYear() - hire.getUTCFullYear()) * 12 + (now.getUTCMonth() - hire.getUTCMonth()));
  }

  const seniorityAdjustment = profile.seniority_adjustment || 0;
  const computedScore = eventsWorked * 0.7 + tenureMonths * 0.3 + seniorityAdjustment;

  res.json({
    hire_date: profile.hire_date,
    seniority_adjustment: seniorityAdjustment,
    historical_events_worked: historicalEvents,
    events_worked_live: liveEvents,
    events_worked: eventsWorked,
    tenure_months: tenureMonths,
    computed_score: Math.round(computedScore * 100) / 100,
  });
```

- [ ] **Step 4: Update the PUT handler**

Replace the **entire** PUT handler (line 563 `router.put(` through the closing `}));` on line 577 — re-verified against main 2026-08-04, the cites still land exactly; the block below is the complete handler, so match on content, not the line numbers, or the stale `}));` on 577 becomes a duplicate close):

`ValidationError` is already imported at `server/routes/admin/users.js:11`; no new import. The guard is deliberate and is NOT redundant with the DDL's `CHECK (>= 0)`:

- The route is the only validator that works on **every** database. Dev has silently lost CHECK constraints before (`[[reference-dev-db-missing-check-constraints]]`), so leaning on the constraint means a bad value writes cleanly on one DB and 500s on another.
- Without it the failure mode is an opaque 500: a negative raises `23514 check_violation`, a non-numeric string raises `22P02`, and both funnel through `asyncHandler` to the generic error middleware. An admin typing `-5` into the new Task 2.1 input (its HTML `min="0"` is advisory only; the client sends `parseInt(...) || 0`, which passes `-5` straight through) would get "something went wrong" and no field error.
- It also rejects non-integers, which the DB CHECK does not: `1.5` into an `INTEGER` column is silently ROUNDED by Postgres to `2`, so the constraint never fires and the admin's number is quietly changed.

```javascript
router.put('/users/:id/seniority', auth, adminOnly, asyncHandler(async (req, res) => {
  const { seniority_adjustment, hire_date, historical_events_worked } = req.body;

  // Validate at the route, not at the DB CHECK — see the note above. Bind the
  // COERCED number, never the raw body value: '' and '9' would otherwise reach
  // an INTEGER column as text (22P02 on the former, silently fine on the latter,
  // which is exactly the inconsistency the guard exists to remove).
  let historical = null;
  if (historical_events_worked !== null && historical_events_worked !== undefined && historical_events_worked !== '') {
    const n = Number(historical_events_worked);
    if (!Number.isInteger(n) || n < 0) {
      throw new ValidationError({ historical_events_worked: 'Historical events must be a whole number of 0 or more.' });
    }
    historical = n;
  }

  await pool.query(`
    UPDATE contractor_profiles
    SET seniority_adjustment = COALESCE($1, seniority_adjustment),
        hire_date = COALESCE($2, hire_date),
        historical_events_worked = COALESCE($3, historical_events_worked)
    WHERE user_id = $4
  `, [
    seniority_adjustment !== null && seniority_adjustment !== undefined ? seniority_adjustment : null,
    hire_date || null,
    historical,
    req.params.id
  ]);

  res.json({ success: true });
}));
```

- [ ] **Step 5: Run the test to verify it passes**

Run from the repo root: `node --test server/routes/admin/users.seniority.test.js`
Expected: PASS. Run it alone — it shares the dev DB with every other suite (Global Constraints).

- [ ] **Step 5b: Prove the DDL on a prod-shaped database (the only real check)**

A green local run does NOT establish that the new column and its CHECK survive against production's schema. Dev is a weaker shape than prod, and this lane's whole surface is one DDL statement. The prod-shaped gate is `scripts/testdb-smoke.js`: it resets the Neon `ci-smoke` branch **from the production branch**, then runs `initDb()` against it — which replays this lane's `schema.sql` change against real production structure and data before prod boot ever does. That is the step that would catch a constraint that cannot be created on prod.

Run it explicitly rather than waiting for `.husky/pre-push` to run it, so the DDL is proven before the lane merges:
```bash
node scripts/testdb-smoke.js > /tmp/seniority-smoke.log 2>&1; echo "EXIT=$?"
```
Expected: `EXIT=0`. **Never pipe this through `tail`/`head`** — the pipeline exit code becomes the pager's and a `pre-push BLOCKED` run reports success. Read the log file after.

If `NEON_API_KEY` is absent the script prints a loud SKIP banner and exits 0. A SKIP is NOT a pass: record it as unproven in the lane notes and say so at review, because in that case nothing has validated the DDL against prod shape.

Note the seniority suites are deliberately NOT added to `scripts/money-smoke-list.txt` — that list is money-path suites, and seniority is a ranking input, not a money seam. The gate still covers this lane, because it is `initDb()` (step 3 of the smoke flow), not the suite list, that exercises the DDL.

- [ ] **Step 6: Commit**

```bash
git add server/routes/admin/users.js server/routes/admin/users.seniority.test.js
git commit -m "feat(seniority): GET/PUT seniority carry the historical baseline"
```

---

## Lane 2: seniority-panel-ui  *(depends on Lane 1)*

### Task 2.1: Show the split and edit the baseline on the seniority panel

**Files:**
- Modify: `client/src/pages/admin/userDetail/AdminUserDetail.js` (state at 76-130, save at 289-305; file is 674 lines — all cites re-verified against main 2026-08-04)
- Modify: `client/src/pages/admin/userDetail/tabs/PayoutsTab.js` (seniority card at 153-205: stat row 161-174, inputs grid 175-195)

**Not modified, but must stay correct:** `AdminUserDetail.js:431` renders the same number in the identity-bar stat row (`{tenure_months}mo tenure · {events_worked} events worked`). It reads `seniority.events_worked` straight off the GET response, so Lane 1 makes it the live+historical total with no edit here. It is out of the footprint on purpose; Step 6 eyeballs it.

**Interfaces:**
- Consumes: GET `/admin/users/:id/seniority` now returns `events_worked` (total), `events_worked_live`, `historical_events_worked`.
- Produces: PUT `/admin/users/:id/seniority` body now includes `historical_events_worked`.

- [ ] **Step 1: Carry the baseline in the seniority form state**

In `AdminUserDetail.js`, extend the initial form (line ~79):
```javascript
  const [seniorityForm, setSeniorityForm] = useState({ seniority_adjustment: 0, hire_date: '', historical_events_worked: 0 });
```
and the load mapping (line ~124-127):
```javascript
        setSeniorityForm({
          seniority_adjustment: r.data.seniority_adjustment || 0,
          hire_date: r.data.hire_date ? String(r.data.hire_date).slice(0, 10) : '',
          historical_events_worked: r.data.historical_events_worked || 0,
        });
```

- [ ] **Step 2: Send the baseline on save**

In `AdminUserDetail.js` `saveSeniority` (line ~294-297):
```javascript
      await api.put(`/admin/users/${id}/seniority`, {
        seniority_adjustment: parseInt(seniorityForm.seniority_adjustment, 10) || 0,
        hire_date: seniorityForm.hire_date || null,
        historical_events_worked: parseInt(seniorityForm.historical_events_worked, 10) || 0,
      });
```

- [ ] **Step 3: Show the live/historical split in the stat row**

In `PayoutsTab.js`, replace the "Events worked" stat (lines 166-169, the middle `<div className="stat">` of the three in the stat row) so the total shows the breakdown:
```javascript
                  <div className="stat">
                    <div className="stat-label">Events worked</div>
                    <div className="stat-value">{seniority.events_worked ?? 0}</div>
                    <div className="tiny muted">{seniority.events_worked_live ?? 0} live + {seniority.historical_events_worked ?? 0} historical</div>
                  </div>
```

- [ ] **Step 4: Add the editable baseline input**

In `PayoutsTab.js`, inside the inputs grid, as a third cell after the "Manual adjustment" block — i.e. after that block's own closing `</div>` on line 194 and before the grid's closing `</div>` on line 195 (two adjacent closers; insert between them, not before both) — add:
```javascript
                  <div>
                    <div className="meta-k" style={{ marginBottom: 4 }}>Historical events (pre-migration)</div>
                    <input
                      className="input num"
                      type="number"
                      min="0"
                      value={seniorityForm.historical_events_worked}
                      onChange={(e) => setSeniorityForm(f => ({ ...f, historical_events_worked: e.target.value }))}
                    />
                    <div className="tiny muted" style={{ marginTop: 3 }}>Events worked before this system (CheckCherry)</div>
                  </div>
```

- [ ] **Step 5: Verify the client build passes (the pre-push gate)**

Run: `cd client && CI=true npx react-scripts build`
Expected: "Compiled successfully" (no ESLint-as-error failures). Return to repo root afterward.

- [ ] **Step 6: Manual smoke (record result)**

First restart the Claude-managed dev server (it does not auto-reload) so Lane 1's merged `/seniority` route is live. Then load an admin user-detail → Payouts tab for a staffer and confirm, in order:

1. The seniority card shows "N live + M historical" under the Events-worked total.
2. Edit the historical field, Save, confirm the toast, and confirm Score/Events update on reload.
3. **The identity-bar stat row at the top of the page** (`AdminUserDetail.js:431`) now reads the same total, not the live-only count. This is the un-footprinted third display site from Task 1.2 Step 2b; if it disagrees with the card, the two compute paths have diverged and that is a stop-and-fix, not a cosmetic bug.
4. Enter `-5` and Save: expect the inline field error from the Task 1.3 guard ("Historical events must be between 0 and 100000." — the fix-round guard bounds the range, so a negative now fails the range check, not the whole-number check), NOT a generic failure toast. `FormBanner` at `PayoutsTab.js:196` already renders `seniorityFieldErrors`, so the message surfaces on the field with no Lane 2 change; confirm it actually does.

Note the result in the commit or lane notes.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/userDetail/AdminUserDetail.js client/src/pages/admin/userDetail/tabs/PayoutsTab.js
git commit -m "feat(seniority): admin panel shows live/historical split and edits the baseline"
```

---

## Lane 3: cc-seniority-import  *(depends on Lane 1 column)*

Reuses the existing CC-matching machinery in `server/scripts/staffPaymentImport/`: `ccReports.js` (CSV loaders), `dictionary.js` (`buildDictionary` / alias-cluster `resolve`), and the `exportKnownPeople.js` DB-export conventions. New files sit at the same directory level so the `../../db` / `../../../.env` require paths match `exportKnownPeople.js` exactly.

Every dependency re-verified against main 2026-08-04 — the directory has not been touched since 2026-07-13 and all four hold in the cited shape:
- `ccReports.js:83` exports exactly `{ loadKnownPeople, loadContacts, loadExpenses, loadBookings }`; `ccDateToIso` is defined at `:51` and is still NOT exported, so Step 1a is still required, and its `/^(\d{2})-(\d{2})-(\d{4})/` prefix match still handles the `MM-DD-YYYY h:mm AM/PM` values in the contacts export.
- `dictionary.js:33` `buildDictionary({ knownPeopleCsv, ccContactsCsv, ccExpensesCsv })` returns `{ people, aliases, resolve, getCluster }`, and a cluster still carries `osUserId` + `onboardingStatus` (`:107-120`) — the two fields the generator reads.
- `exportKnownPeople.js` still writes `known-people.csv` with the `user_id,name,preferred_name,email,phone,onboarding_status` header under `--review-dir`, and still nests dotenv at `../../../.env` with the pool at `../../db`.
- `parsers/csvUtil.js:43` exports `parseCsv`.

### Task 3.1: Read-only mapping generator

**Files:**
- Create: `server/scripts/staffPaymentImport/generateSeniorityMapping.js`

**Interfaces:**
- Consumes: `<review-dir>/known-people.csv` (produced by `exportKnownPeople.js`) and the CheckCherry contacts CSV.
- Produces: `<review-dir>/seniority-mapping.csv` with columns `cc_name,cc_created_date,cc_events,matched_user_id,os_preferred_name,onboarding_status,current_hire_date,proposed_hire_date,current_live_events,proposed_historical,include,flags`. Writes NOTHING to the DB except read queries.

- [ ] **Step 1: Write the generator (read-only)**

Create `server/scripts/staffPaymentImport/generateSeniorityMapping.js`:
```javascript
// READ-ONLY generator: CheckCherry contacts × OS staff → a human-review CSV of
// proposed hire_date + historical_events_worked. Run exportKnownPeople.js first
// (it writes <review-dir>/known-people.csv). This script only READS the DB
// (current hire_date + live event count per matched user); it writes no rows.
//
// Usage:
//   DATABASE_URL=... node server/scripts/staffPaymentImport/exportKnownPeople.js --review-dir DIR
//   DATABASE_URL=... node server/scripts/staffPaymentImport/generateSeniorityMapping.js \
//     --review-dir DIR --contacts ~/win-share/payments/cc-report-contacts.csv
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const { pool } = require('../../db');
const { parseCsv } = require('./parsers/csvUtil');
const { buildDictionary } = require('./dictionary');
const { ccDateToIso } = require('./ccReports'); // see Step 1a, export it

function argVal(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
function expand(p) { return path.resolve(p.replace(/^~(?=$|\/)/, process.env.HOME || '~')); }
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
// A DATE column comes back from `pg` as a JS Date at LOCAL midnight, and
// `String(thatDate).slice(0,10)` is "Tue Jun 10", not "2025-06-10". Use the
// codebase's idiom (server/utils/paystubData.js:20, admin/payroll.js:129):
// branch on `instanceof Date` and go through toISOString. Chicago is behind
// UTC, so local midnight lands at 05:00/06:00Z on the SAME calendar day and
// the YMD round-trips exactly. Strings pass through untouched.
function toYmd(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}
const STAFF_ROLE = /bartender|barback|server|staff|manager|captain/i;
const ACTIVE_STATUS = new Set(['approved', 'hired']);
const MAPPING_COLUMNS = ['cc_name', 'cc_created_date', 'cc_events', 'matched_user_id', 'os_preferred_name', 'onboarding_status', 'current_hire_date', 'proposed_hire_date', 'current_live_events', 'proposed_historical', 'include', 'flags'];

// Pure: given a CC contact and its matched OS current-state, produce the review
// row (include default + flags). Exported for unit testing.
function shapeMappingRow({ name, created, events, matchedUserId, onboardingStatus, current = {}, dupCount = 1 }) {
  // toYmd, NOT String(...).slice(0,10): `current` is a raw pg row, so hire_date
  // is a Date object. Getting this wrong does not throw — it silently produces
  // "Tue Jun 10", which then loses every `date-moves-later` string comparison
  // below ('2' < 'T'), so the spec §4 tenure-shortening flag would never fire
  // for a single real row while the pure unit tests (which pass strings) stayed
  // green. See Step 1c for the regression test that pins this.
  const curHire = toYmd(current.hire_date);
  const flags = [];
  if (!matchedUserId) flags.push('unmatched');
  if (matchedUserId && dupCount > 1) flags.push('duplicate-match');
  if (events === 0) flags.push('zero-events');
  if (curHire && created && created > curHire) flags.push('date-moves-later');
  return {
    cc_name: name, cc_created_date: created, cc_events: events,
    matched_user_id: matchedUserId || '', os_preferred_name: current.preferred_name || '',
    onboarding_status: onboardingStatus, current_hire_date: curHire, proposed_hire_date: created,
    current_live_events: current.live_events || 0, proposed_historical: events,
    include: matchedUserId && ACTIVE_STATUS.has(onboardingStatus) ? 'yes' : 'no',
    flags: flags.join('|'),
  };
}

async function main() {
  const reviewDir = expand(argVal('--review-dir', path.join(process.env.HOME || '.', 'win-share/payments/review')));
  const contactsPath = expand(argVal('--contacts', path.join(process.env.HOME || '.', 'win-share/payments/cc-report-contacts.csv')));
  const knownPeopleCsv = path.join(reviewDir, 'known-people.csv');
  if (!fs.existsSync(knownPeopleCsv)) {
    throw new Error(`Missing ${knownPeopleCsv}. Run exportKnownPeople.js --review-dir first.`);
  }
  if (!fs.existsSync(contactsPath)) {
    throw new Error(`Missing CheckCherry contacts CSV: ${contactsPath} (pass --contacts).`);
  }

  // Name→OS matching via the shared cluster dictionary (carries osUserId + status).
  const dict = buildDictionary({ knownPeopleCsv, ccContactsCsv: contactsPath });

  // Read the CC contacts CSV directly for the seniority fields.
  const records = parseCsv(fs.readFileSync(contactsPath, 'utf8'));
  const header = records[0].map((c) => c.trim());
  const col = {}; header.forEach((n, i) => { col[n] = i; });
  const get = (r, name) => (col[name] !== undefined ? (r[col[name]] || '').trim() : '');

  const contacts = records.slice(1).filter((r) => r.length).map((r) => ({
    name: get(r, 'Name') || `${get(r, 'First Name')} ${get(r, 'Last Name')}`.trim(),
    created: ccDateToIso(get(r, 'Created At')),
    events: parseInt(get(r, 'Staff Events: Count') || '0', 10) || 0,
    roles: get(r, 'Roles'),
  })).filter((c) => c.name && (STAFF_ROLE.test(c.roles) || c.events > 0));

  // Resolve each contact → OS cluster → user id + onboarding status.
  const rows = contacts.map((c) => {
    const key = dict.resolve(c.name);
    const cluster = key ? dict.getCluster(key) : null;
    return {
      ...c,
      matched_user_id: cluster?.osUserId || null,
      onboarding_status: cluster?.onboardingStatus || '',
    };
  });

  // One DB read for current hire_date + live event count per matched user.
  const ids = [...new Set(rows.map((r) => r.matched_user_id).filter(Boolean))];
  const cur = new Map();
  if (ids.length) {
    const q = await pool.query(`
      SELECT cp.user_id, cp.preferred_name, cp.hire_date,
             (SELECT COUNT(*) FROM shift_requests sr JOIN shifts s ON s.id = sr.shift_id
               WHERE sr.user_id = cp.user_id AND sr.status = 'approved'
                 AND sr.dropped_at IS NULL AND s.event_date < CURRENT_DATE) AS live_events
      FROM contractor_profiles cp WHERE cp.user_id = ANY($1)
    `, [ids]);
    for (const row of q.rows) cur.set(row.user_id, row);
  }

  // Duplicate-match detection: two CC contacts resolve to one OS user.
  const idCounts = {};
  for (const r of rows) if (r.matched_user_id) idCounts[r.matched_user_id] = (idCounts[r.matched_user_id] || 0) + 1;

  const lines = rows.map((r) => {
    const shaped = shapeMappingRow({
      name: r.name, created: r.created, events: r.events,
      matchedUserId: r.matched_user_id, onboardingStatus: r.onboarding_status,
      current: cur.get(r.matched_user_id) || {}, dupCount: idCounts[r.matched_user_id] || 0,
    });
    return MAPPING_COLUMNS.map((k) => csvCell(shaped[k])).join(',');
  });

  fs.mkdirSync(reviewDir, { recursive: true });
  const outPath = path.join(reviewDir, 'seniority-mapping.csv');
  fs.writeFileSync(outPath, `${MAPPING_COLUMNS.join(',')}\n${lines.join('\n')}\n`);
  console.log(`[generateSeniorityMapping] wrote ${lines.length} rows -> ${outPath}`);
  console.log(`  matched: ${rows.filter((r) => r.matched_user_id).length}, default-include: ${lines.filter((l) => l.includes(',yes,')).length}`);
}

if (require.main === module) {
  main().then(() => pool.end()).then(() => process.exit(0))
    .catch((err) => { console.error('[generateSeniorityMapping] failed:', err.message); process.exit(1); });
}

module.exports = { shapeMappingRow, MAPPING_COLUMNS, toYmd };
```

- [ ] **Step 1a: Export `ccDateToIso` from `ccReports.js`**

`ccDateToIso` exists in `server/scripts/staffPaymentImport/ccReports.js` but is not exported. Add it to `module.exports` there:
```javascript
module.exports = { loadKnownPeople, loadContacts, loadExpenses, loadBookings, ccDateToIso };
```

- [ ] **Step 1b: Write the flag-logic test**

Create `server/scripts/staffPaymentImport/generateSeniorityMapping.test.js`:
```javascript
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { shapeMappingRow, toYmd } = require('./generateSeniorityMapping');

test('active matched contact defaults include=yes with no flags', () => {
  const row = shapeMappingRow({ name: 'Kaitlyn Freyer', created: '2025-05-22', events: 32,
    matchedUserId: 7, onboardingStatus: 'approved',
    current: { preferred_name: 'Kaitlyn', hire_date: '2025-06-10', live_events: 3 }, dupCount: 1 });
  assert.equal(row.include, 'yes');
  assert.equal(row.proposed_hire_date, '2025-05-22');
  assert.equal(row.proposed_historical, 32);
  assert.equal(row.flags, '');   // 2025-05-22 is earlier than the current 2025-06-10
});

test('unmatched contact is excluded and flagged', () => {
  const row = shapeMappingRow({ name: 'Ghost', created: '2025-05-01', events: 5,
    matchedUserId: null, onboardingStatus: '', current: {}, dupCount: 0 });
  assert.equal(row.include, 'no');
  assert.equal(row.flags, 'unmatched');
});

test('inactive status excluded; zero-events and date-moves-later flags fire', () => {
  const row = shapeMappingRow({ name: 'Old Vet', created: '2025-08-01', events: 0,
    matchedUserId: 9, onboardingStatus: 'deactivated',
    current: { hire_date: '2025-04-01', live_events: 0 }, dupCount: 1 });
  assert.equal(row.include, 'no');
  assert.ok(row.flags.includes('zero-events'));
  assert.ok(row.flags.includes('date-moves-later'));   // 2025-08-01 later than 2025-04-01
});

test('two contacts resolving to one user get duplicate-match', () => {
  const row = shapeMappingRow({ name: 'Dup', created: '2025-05-01', events: 2,
    matchedUserId: 5, onboardingStatus: 'approved', current: { hire_date: '', live_events: 0 }, dupCount: 2 });
  assert.ok(row.flags.includes('duplicate-match'));
});
```

- [ ] **Step 1c: Pin the pg-Date path (the case the other four tests cannot catch)**

Every test above hands `current.hire_date` a STRING, but at runtime it is a `Date` from a `pg` DATE column. Append to the same file:
```javascript
// Fixtures are built in the LOCAL (Chicago) frame with new Date(y, mIdx, d) —
// exactly how `pg` hands back a DATE column — never by parsing a 'YYYY-MM-DD'
// string, which JS reads as UTC midnight and would be a different instant.
test('toYmd renders a pg Date as YYYY-MM-DD, not a day name', () => {
  assert.equal(toYmd(new Date(2025, 5, 10)), '2025-06-10');   // month index 5 = June
  assert.equal(toYmd('2025-06-10'), '2025-06-10');            // string passes through
  assert.equal(toYmd(null), '');
});

test('date-moves-later fires when current hire_date arrives as a pg Date', () => {
  const row = shapeMappingRow({ name: 'Vet', created: '2025-08-01', events: 4,
    matchedUserId: 11, onboardingStatus: 'approved',
    current: { hire_date: new Date(2025, 3, 1), live_events: 2 }, dupCount: 1 });
  assert.equal(row.current_hire_date, '2025-04-01');
  assert.ok(row.flags.includes('date-moves-later'),
    'a Date-shaped current_hire_date must still lose the comparison to a later CC date');
});

test('date-moves-later does NOT fire when the CC date is earlier', () => {
  const row = shapeMappingRow({ name: 'Vet2', created: '2025-02-01', events: 4,
    matchedUserId: 12, onboardingStatus: 'approved',
    current: { hire_date: new Date(2025, 3, 1), live_events: 2 }, dupCount: 1 });
  assert.equal(row.flags, '');
});
```
Import `toYmd` alongside `shapeMappingRow` at the top of the file.

- [ ] **Step 2: Run the flag-logic test**

Run from the repo root: `node --test server/scripts/staffPaymentImport/generateSeniorityMapping.test.js`
Expected: PASS (7 tests). This relies on the `require.main === module` guard in the generator, so importing it does not run `main()`. The generator does `require('../../db')` at module load, but `new Pool()` opens no socket until a query runs, so the test process still exits cleanly without a `pool.end()`.

- [ ] **Step 3: Dry-run the generator against the dev DB and eyeball the output**

Run:
```bash
node server/scripts/staffPaymentImport/exportKnownPeople.js --review-dir "$HOME/win-share/payments/review"
node server/scripts/staffPaymentImport/generateSeniorityMapping.js --review-dir "$HOME/win-share/payments/review"
```
The second command relies on the default `--contacts` path, `$HOME/win-share/payments/cc-report-contacts.csv`. Confirmed present on this box 2026-08-04, alongside `cc-report-bookings.csv` / `cc-report-expenses.csv`; pass `--contacts` explicitly if it has moved.

Expected: writes `seniority-mapping.csv`; console prints row/matched/default-include counts. These targets were measured against the real export on 2026-08-04, so treat a mismatch as a bug in the generator, not as new data:
- The contacts CSV holds **1215** rows, of which the `STAFF_ROLE`-or-`events>0` filter keeps exactly **40** — the same forty the spec §1 counted.
- The header names the generator indexes by all exist verbatim: `Name`, `First Name`, `Last Name`, `Roles`, `Created At`, `Staff Events: Count`.
- `Created At` values look like `05-22-2025  9:24 PM` (note the DOUBLE space before the time). `ccDateToIso` prefix-matches `MM-DD-YYYY` and is unaffected.
- **Kaitlyn Freyer's `Name` cell is `"Kaitlyn  Freyer"`, also double-spaced.** She must still resolve: `normalizeName` (`staging.js:39-47`) collapses `\s+` to a single space before the dictionary lookup, verified. If she comes back `unmatched`, the cause is the resolver path, not the data.
- Her row should read `cc_created_date=2025-05-22`, `proposed_historical=32`.

Also open the CSV and confirm `date-moves-later` fires on at least the rows where it should. That flag reads a `hire_date` that arrives from `pg` as a Date, and the Step 1c tests exist precisely because a formatting slip there makes the flag silently never fire against real rows while every string-fed unit test stays green.

- [ ] **Step 4: Commit**

```bash
git add server/scripts/staffPaymentImport/generateSeniorityMapping.js server/scripts/staffPaymentImport/generateSeniorityMapping.test.js server/scripts/staffPaymentImport/ccReports.js
git commit -m "feat(seniority): read-only CC->OS seniority mapping generator"
```

---

### Task 3.2: Dry-run-default apply script

**Files:**
- Create: `server/scripts/staffPaymentImport/applySeniorityBackfill.js`
- Test: `server/scripts/staffPaymentImport/seniorityBackfill.test.js`

**Interfaces:**
- Consumes: the human-approved `seniority-mapping.csv`.
- Produces: pure helpers `parseMappingRows(csvText) → [{ userId, hireDate, historical, include, flags }]` and `planWrites(rows) → [{ userId, hireDate, historical }]` (include=yes AND matched only); the DB writer `applyWrites(client, writes, { apply }) → { changed, before }` (extracted so a test can drive it with an injected client); plus a `--apply` CLI path.

- [ ] **Step 1: Write the failing tests (pure core + DB-backed apply)**

Create `server/scripts/staffPaymentImport/seniorityBackfill.test.js`:
```javascript
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../db');
const { parseMappingRows, planWrites, applyWrites, toYmd } = require('./applySeniorityBackfill');

if (process.env.NODE_ENV === 'production') {
  throw new Error('seniorityBackfill.test.js refuses to run against production');
}

// hire_date comes back from `pg` as a Date at LOCAL midnight. Assert through
// toYmd, never String(row.hire_date).slice(0,10) — that yields "Tue Jun 10".

const CSV = [
  'cc_name,cc_created_date,cc_events,matched_user_id,os_preferred_name,onboarding_status,current_hire_date,proposed_hire_date,current_live_events,proposed_historical,include,flags',
  'Kaitlyn Freyer,2025-05-22,32,7,Kaitlyn,approved,2025-06-10,2025-05-22,3,32,yes,',
  'Someone Else,2025-05-01,5,,,,,2025-05-01,0,5,no,unmatched',
  'Inactive Vet,2025-04-01,4,9,Vet,deactivated,,2025-04-01,0,4,no,',
].join('\n');

// ── Pure core (no DB) ──────────────────────────────────────────────
test('parseMappingRows reads every row with typed fields', () => {
  const rows = parseMappingRows(CSV);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { userId: 7, hireDate: '2025-05-22', historical: 32, include: true, flags: '' });
});

test('planWrites keeps only include=yes rows with a matched user', () => {
  const writes = planWrites(parseMappingRows(CSV));
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], { userId: 7, hireDate: '2025-05-22', historical: 32 });
});

// ── DB-backed: applyWrites is exact, idempotent, and only touches its targets ──
const PREFIX = 'seniority-apply-test-';
let uid, otherUid;

before(async () => {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','staff','approved') RETURNING id`,
    [`${PREFIX}a@example.com`]);
  uid = u.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, hire_date, historical_events_worked) VALUES ($1,$2,'2025-06-10',0)`,
    [uid, `${PREFIX}A`]);
  const o = await pool.query(
    `INSERT INTO users (email, password_hash, role, onboarding_status) VALUES ($1,'x','staff','approved') RETURNING id`,
    [`${PREFIX}b@example.com`]);
  otherUid = o.rows[0].id;
  await pool.query(
    `INSERT INTO contractor_profiles (user_id, preferred_name, hire_date, historical_events_worked) VALUES ($1,$2,'2025-07-01',1)`,
    [otherUid, `${PREFIX}B`]);
});

after(async () => {
  await pool.query(`DELETE FROM contractor_profiles WHERE user_id = ANY($1::int[])`, [[uid, otherUid]]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [[uid, otherUid]]);
  await pool.end();
});

test('applyWrites apply=false writes nothing (dry-run)', async () => {
  const client = await pool.connect();
  try {
    await applyWrites(client, [{ userId: uid, hireDate: '2025-05-22', historical: 32 }], { apply: false });
  } finally { client.release(); }
  const r = await pool.query('SELECT hire_date, historical_events_worked FROM contractor_profiles WHERE user_id = $1', [uid]);
  assert.equal(toYmd(r.rows[0].hire_date), '2025-06-10');   // unchanged
  assert.equal(r.rows[0].historical_events_worked, 0);
});

test('applyWrites apply=true writes exactly, and a re-run leaves identical values (idempotent)', async () => {
  const w = [{ userId: uid, hireDate: '2025-05-22', historical: 32 }];
  const client = await pool.connect();
  try {
    await applyWrites(client, w, { apply: true });
    await applyWrites(client, w, { apply: true });   // second run: same values, no drift
  } finally { client.release(); }
  const r = await pool.query('SELECT hire_date, historical_events_worked FROM contractor_profiles WHERE user_id = $1', [uid]);
  assert.equal(toYmd(r.rows[0].hire_date), '2025-05-22');
  assert.equal(r.rows[0].historical_events_worked, 32);
  // The other profile was never in the write set, so it is untouched.
  const o = await pool.query('SELECT hire_date, historical_events_worked FROM contractor_profiles WHERE user_id = $1', [otherUid]);
  assert.equal(toYmd(o.rows[0].hire_date), '2025-07-01');
  assert.equal(o.rows[0].historical_events_worked, 1);
});

// The rollback snapshot is the ONLY thing that makes an --apply run reversible,
// and it is built from applyWrites' `before` array. Pin its shape here rather
// than trusting the console log: a Date leaking through unformatted would write
// a comma-bearing "Tue Jun 10 2025 00:00:00 GMT-0500 (...)" into the backup CSV
// and break both the column count and the restore.
test('applyWrites returns a before-snapshot with YYYY-MM-DD dates', async () => {
  const client = await pool.connect();
  let before;
  try {
    ({ before } = await applyWrites(client, [{ userId: otherUid, hireDate: '2025-09-09', historical: 4 }], { apply: false }));
  } finally { client.release(); }
  assert.equal(before.length, 1);
  assert.equal(before[0].userId, otherUid);
  assert.equal(before[0].hire_date, '2025-07-01');
  assert.equal(before[0].historical_events_worked, 1);
  assert.ok(!/,/.test(String(before[0].hire_date)), 'snapshot date must not contain a comma');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/scripts/staffPaymentImport/seniorityBackfill.test.js`
Expected: FAIL, module not found / functions undefined.

- [ ] **Step 3: Write the apply script**

Create `server/scripts/staffPaymentImport/applySeniorityBackfill.js`:
```javascript
// Apply the HUMAN-APPROVED seniority mapping. Dry-run by default (prints the
// before→after per row, writes nothing); --apply performs the writes inside a
// transaction. Idempotent: an explicit SET to the approved values, so a second
// --apply run is a no-op. Only include=yes rows with a matched user are written.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
const fs = require('fs');
const { parseCsv } = require('./parsers/csvUtil');

// Same helper as generateSeniorityMapping.js, duplicated rather than
// cross-imported so neither script depends on the other (the generator already
// duplicates csvCell from exportKnownPeople.js for the same reason). A pg DATE
// arrives as a Date at local midnight; String(...).slice(0,10) would write
// "Tue Jun 10" into the rollback snapshot below and quietly destroy the only
// artifact that makes an --apply run reversible.
function toYmd(v) {
  if (!v) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function parseMappingRows(csvText) {
  const records = parseCsv(csvText);
  const header = records[0].map((c) => c.trim());
  const col = {}; header.forEach((n, i) => { col[n] = i; });
  const get = (r, name) => (col[name] !== undefined ? (r[col[name]] || '').trim() : '');
  return records.slice(1).filter((r) => r.length).map((r) => ({
    userId: get(r, 'matched_user_id') ? Number(get(r, 'matched_user_id')) : null,
    hireDate: get(r, 'proposed_hire_date') || null,
    historical: parseInt(get(r, 'proposed_historical') || '0', 10) || 0,
    include: get(r, 'include').toLowerCase() === 'yes',
    flags: get(r, 'flags'),
  }));
}

function planWrites(rows) {
  return rows.filter((r) => r.include && r.userId)
    .map((r) => ({ userId: r.userId, hireDate: r.hireDate, historical: r.historical }));
}

// Read current state, print before->after for each row, and (when apply) UPDATE.
// Extracted + exported so a DB-backed test can drive it with an injected client.
// Returns { changed, before }; `before` snapshots prior values for the rollback file.
async function applyWrites(client, writes, { apply }) {
  const before = [];
  let changed = 0;
  for (const w of writes) {
    const b = (await client.query(
      'SELECT hire_date, historical_events_worked FROM contractor_profiles WHERE user_id = $1', [w.userId])).rows[0] || {};
    const priorHire = toYmd(b.hire_date);
    before.push({ userId: w.userId, hire_date: priorHire, historical_events_worked: b.historical_events_worked ?? '' });
    console.log(`  user ${w.userId}: hire_date ${priorHire || '(unset)'} -> ${w.hireDate}, historical ${b.historical_events_worked ?? '(unset)'} -> ${w.historical}`);
    if (apply) {
      const res = await client.query(
        'UPDATE contractor_profiles SET hire_date = $1, historical_events_worked = $2 WHERE user_id = $3',
        [w.hireDate, w.historical, w.userId]);
      changed += res.rowCount;
    }
  }
  return { changed, before };
}

async function main() {
  const i = process.argv.indexOf('--file');
  const file = i !== -1 && process.argv[i + 1]
    ? process.argv[i + 1]
    : path.join(process.env.HOME || '.', 'win-share/payments/review/seniority-mapping.csv');
  const apply = process.argv.includes('--apply');
  const rows = parseMappingRows(fs.readFileSync(path.resolve(file), 'utf8'));
  const writes = planWrites(rows);

  const { pool } = require('../../db');
  console.log(`[applySeniorityBackfill] ${writes.length} row(s) to write (${apply ? 'APPLY' : 'DRY-RUN'})`);
  const client = await pool.connect();
  try {
    if (apply) await client.query('BEGIN');
    const { changed, before } = await applyWrites(client, writes, { apply });
    if (apply) {
      // Snapshot prior state for rollback (written before COMMIT; harmless on rollback).
      const backup = `${path.resolve(file).replace(/\.csv$/i, '')}.backup-${Date.now()}.csv`;
      fs.writeFileSync(backup, ['user_id,hire_date,historical_events_worked',
        ...before.map((r) => `${r.userId},${r.hire_date},${r.historical_events_worked}`)].join('\n') + '\n');
      await client.query('COMMIT');
      console.log(`[applySeniorityBackfill] committed ${changed} update(s). Prior state saved to ${backup}`);
    } else {
      console.log('[applySeniorityBackfill] dry-run only; pass --apply to write.');
    }
  } catch (err) {
    if (apply) await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((err) => { console.error('[applySeniorityBackfill] failed:', err.message); process.exit(1); });
}

module.exports = { parseMappingRows, planWrites, applyWrites, toYmd };
```

- [ ] **Step 4: Run the test to verify it passes**

Run from the repo root (the suite's `require('dotenv').config()` resolves `.env` relative to `process.cwd()`, so a different cwd silently yields no `DATABASE_URL`): `node --test server/scripts/staffPaymentImport/seniorityBackfill.test.js`
Expected: PASS (all tests: 2 pure + 3 DB-backed). Run it alone — shared dev DB.

- [ ] **Step 5: Dry-run against the dev DB (writes nothing)**

Run: `node server/scripts/staffPaymentImport/applySeniorityBackfill.js --file "$HOME/win-share/payments/review/seniority-mapping.csv"`
Expected: prints per-row before→after and "dry-run only"; a follow-up `SELECT` shows no rows changed.

- [ ] **Step 6: Update README**

The folder-structure tree does NOT give this directory one line per file — `README.md:432` is a **single** `staffPaymentImport/` line whose description ends in a parenthetical, comma-separated file list (`… dictionary.js, classify.js, eventMatch.js, exportKnownPeople.js, ccReports.js, buildReviewSheet.js; importFromSheet.js/reconcile.js/verifyImport.js land with the import lane`). Extend that existing parenthetical in place — do not add new tree lines, which would leave the directory documented two different ways.

Append to it: `generateSeniorityMapping.js` (read-only CC→OS hire-date/event-count mapping for human review) and `applySeniorityBackfill.js` (dry-run-default apply of the approved mapping). Also widen the line's opening summary, which currently scopes the directory to payment-export parsing only; this lane makes it the CheckCherry→OS backfill pipeline generally.

- [ ] **Step 7: Commit**

```bash
git add server/scripts/staffPaymentImport/applySeniorityBackfill.js server/scripts/staffPaymentImport/seniorityBackfill.test.js README.md
git commit -m "feat(seniority): dry-run-default apply script for the CC seniority backfill"
```

---

## Operation runbook (after all lanes merge and deploy)

The code shipping does **not** change any data. The backfill is a deliberate, reviewed operation run once against production:

1. Deploy Lane 1 (the column must exist in prod).
2. `node server/scripts/staffPaymentImport/exportKnownPeople.js --review-dir DIR` (against prod DATABASE_URL).
3. `node server/scripts/staffPaymentImport/generateSeniorityMapping.js --review-dir DIR --contacts .../cc-report-contacts.csv`.
4. **Dallas reviews `seniority-mapping.csv`**, toggles `include`, fixes matches, eyeballs `date-moves-later` / `duplicate-match` / `unmatched` flags.
5. `node .../applySeniorityBackfill.js --file DIR/seniority-mapping.csv` (dry-run) → review the before→after.
6. `node .../applySeniorityBackfill.js --file DIR/seniority-mapping.csv --apply` (also writes a `...backup-<ts>.csv` snapshot of the prior hire_date / historical values beside the mapping file, for rollback). **Before doing anything else, open that backup file**: it must be three columns with dates as `YYYY-MM-DD`. If a date reads like `Tue Jun 10 2025 …` the snapshot is unusable as a rollback (its embedded commas break the column count), and the run must be reversed by hand from the mapping CSV's `current_hire_date` before continuing. **After any repeat `--apply`, the EARLIEST-timestamped backup is the rollback artifact** — later backups snapshot already-applied values. And never re-run the generator (step 3) over a reviewed mapping: it refuses without `--force`, and `--force` discards the hand review.
7. Spot-check a couple of profiles on the admin seniority panel: the Seniority card shows "N live + M historical" with the expected total, and the identity-bar stat at the top of the same page shows that same total.
8. Spot-check the ranker, not just the display. Open a future shift with pending bartender requests and run the auto-assign **dry run**; a backfilled veteran's `scores.events_worked` must equal live + baseline, matching what the panel shows. The two compute sites are independent code paths, and the panel agreeing proves nothing about the ranker.

## Self-Review

- **Spec coverage:** column (§3.1 → 1.1); events = live+baseline at both sites (§3.2 → 1.2 autoAssign, 1.3 route; a grep-readers guard added at 1.2 Step 2b); hire_date direct-set (§3.3 → applied in 3.2 write); admin panel split + edit (§3.4 → 2.1); mapping generator + review + apply (§4 → 3.1, 3.2, runbook); DATE truncation + face-value counts + flags (§5 → generator flags, `ccDateToIso`); cap left unchanged (§6 → Global Constraints); tests (§7 → 1.2, 1.3; 3.1 pure flag-logic test; 3.2 DB-backed `applyWrites` idempotency/exactness test plus the pure filter); out-of-scope respected (§8, no phones, no synthetic shifts, weights/cap untouched).
- **Design-fleet review folded (2026-07-26):** footprints corrected (ARCHITECTURE.md → L1; ccReports.js + README + generator test → L3); autoAssign suites run one at a time; apply script snapshots prior state before writing; spec §4 flag set reconciled to `duplicate-match` + `unmatched` (true `ambiguous` is not derivable without resolver scope creep) and §3.1 DDL carries the `CHECK (>= 0)`.
- **Placeholder scan:** none, every code step carries full code; the one "follow the existing harness" note (1.3 Step 1) points at a concrete file (`users.activeStaff.test.js`) to copy verbatim rather than inventing a signature. Re-verified 2026-08-04: that file still exists, still uses the `node:http` + `express` + jwt-admin-token + `AppError`-middleware shape the step describes, and is unchanged since 2026-06-05.
- **Type consistency:** `historical_events_worked` (DB/route/form), `events_worked_live` + `events_worked` (total) used identically in 1.3 and 2.1; `parseMappingRows`/`planWrites` shapes match between 3.2 impl and its test. Date types are now explicit end to end: a `pg` DATE is a Date object and is rendered only through `toYmd` (3.1, 3.2, and their tests); the GET route still returns the raw Date and lets `res.json` serialize it, which is why the client's existing `String(hire_date).slice(0,10)` at `AdminUserDetail.js:126` remains correct over JSON and must not be "fixed".

## Revision history

- **rev 1, 2026-07-26.** First draft from the approved spec. Passed its own inline self-review.
- **rev 2, 2026-07-26.** Design-fleet review folded (recorded in Self-Review above): footprints corrected, autoAssign suites serialized, apply-script prior-state snapshot added, spec §4 flag set reconciled, §3.1 DDL given the `CHECK (>= 0)`.
- **rev 3, 2026-08-04.** Freshness audit against main (HEAD `9141171a`, 113 commits after rev 2), applied as targeted amendments. Every file path, line cite, export, route, and schema claim was re-checked against the working tree; the plan's structural cites held up unusually well (the two compute sites, `admin/users.js:524-577`, `autoAssign.js:162-173`/`224`/`268`, the `staffPaymentImport` helpers, and `users.activeStaff.test.js` are all byte-for-byte where rev 2 said they were, because none of those files were touched since 7/25). What the audit did find were two latent defects that no line-cite check would have surfaced, plus one wrong procedure:

  1. **Task 1.1 Step 2 applied the schema with `pool.query(entireFile)`.** That is not this codebase's apply path. `server/db/index.js` `initDb()` splits `schema.sql` and swallows `IDEMPOTENT_PG_CODES` **per statement**; one simple-query call with the whole file is a single implicit transaction, so the first duplicate-object error against a populated DB aborts the batch and the new column is never created — presenting as "column missing" with no diagnosis. Step 2 now calls `initDb()`, and additionally asserts the CHECK constraint exists via `pg_constraint`, not just the column.
  2. **`String(pgDate).slice(0, 10)` yields `"Tue Jun 10"`, not `"2025-06-10"`** (verified empirically: no `setTypeParser` is registered, so a DATE returns a JS Date at local midnight and `String()` takes `toString()`). The plan used that pattern at three places, and the consequences were graded, not cosmetic: in the generator it fed the `date-moves-later` comparison, where `'2' < 'T'` always, so the spec §4 tenure-shortening flag would have **silently never fired for a single real row** while all four string-fed unit tests stayed green; in `applyWrites` it wrote a comma-bearing date string into the `--apply` rollback snapshot, destroying the only artifact that makes the production write reversible; and in the DB-backed suite it broke three assertions outright. All three now route through a `toYmd` helper following the codebase idiom (`paystubData.js:20`), exported from both scripts, with Step 1c added to pin the Date-object path (Chicago local-frame `new Date(y, mIdx, d)` fixtures, per house test law) and a new snapshot-shape test in 3.2.
  3. **The PUT accepted `historical_events_worked` unvalidated.** Combined with rev 2's new `CHECK (>= 0)`, an admin typing `-5` into the Task 2.1 input (whose HTML `min="0"` is advisory, and whose `parseInt(...) || 0` passes negatives straight through) got an opaque 500 from `23514`, and `1.5` was silently rounded to `2` by Postgres with no constraint violation at all. Task 1.3 Step 4 now validates at the route with `ValidationError` (already imported at `users.js:11`), binds the coerced number rather than the raw body value, and Step 1 gained a rejection test plus a COALESCE-to-keep test that doubles as the lane-ordering guard for the window where Lane 1 is deployed and Lane 2 is not.

  Answering the audit's standing question about postdating consumer sites: there are none. The rev-5-class hunt came back empty — the Step 2b grep still returns exactly `autoAssign.js` and `admin/users.js`, and neither staffing-roster/assign-position (7/22), the staff event-details redesign (8/03), nor service-extension introduced a count, a seniority read, or a `hire_date` consumer. Step 2b now records that result with its date and additionally enumerates the **display** side, which rev 2 never did: `AdminUserDetail.js:431`'s identity-bar stat is a third render of `events_worked` that Task 2.1 does not touch and does not need to, because it inherits the total from the route — it is named so its absence from the Lane 2 footprint reads as deliberate, and Task 2.1 Step 6 now eyeballs it.

  Also folded: Task 1.1 gained Step 3b, which pins the three existing `contractor_profiles` writers (`contractorSeed.js`, `PUT /users/:id/profile`, the skeleton upsert) as verified-safe **because they name columns explicitly**, with an instruction not to "helpfully" add the new column to any of them — `contractorSeed.js` carries a standing "KEEP IN SYNC WITH schema.sql contractor_profiles" header, so a re-hire zeroing a backfilled baseline was a live near-miss; the adjacent `settings.js:103-116` hire_date backfill is documented as order-independent. Task 1.3 gained Step 5b making the CHECK's verification story honest: a locally-green suite proves nothing about a constraint (`[[reference-dev-db-missing-check-constraints]]`), the prod-shaped gate is `scripts/testdb-smoke.js` running `initDb()` against `ci-smoke` reset from the production branch, it must not be piped through `tail`, and a `NEON_API_KEY`-absent SKIP is to be reported as unproven rather than counted as a pass; the seniority suites are deliberately kept out of `money-smoke-list.txt` with the reason stated. Global Constraints gained the run-from-repo-root rule (every suite here self-loads dotenv against `process.cwd()`), the Chicago local-frame fixture rule with its pg-DATE read-back mirror, and the constraint-evidence rule. Task 3.1 Step 3 was rewritten around numbers measured from the real export that day — 1215 contact rows filtering to exactly the spec's 40, every indexed header name present verbatim, `Created At` carrying a double space before the time, and Kaitlyn Freyer's `Name` cell itself double-spaced (`"Kaitlyn  Freyer"`), which resolves only because `normalizeName` collapses `\s+`; that is now called out so an `unmatched` Kaitlyn is read as a resolver bug rather than as data drift. The runbook gained a rollback-file integrity check at step 6 and a step 8 that dry-runs the ranker, on the grounds that the panel agreeing proves nothing about the second compute path. Stale cites corrected in place: `schema.sql` anchor 1171 → 1190, ARCHITECTURE.md given the real 742-752 block with `hire_date`/`seniority_adjustment` at 747/748, PayoutsTab card 160-201 → 153-205 with the insertion point disambiguated between two adjacent closing `</div>`s at 194/195, and the README step corrected from "one line each" to extending the single-line parenthetical file list at `README.md:432`, which is how that directory is actually documented.

- **rev 3.1, 2026-08-04.** Build-time amendment from the lane fix round: the Task 2.1 Step 6 manual smoke now expects the range message ("between 0 and 100000") on `-5`, since the hardened guard bounds the field; Lane 1 merged (25c38fde) with an authorized footprint widening to `server/routes/contractor.js` closing the sanitizer leak the fleet caught.

- **rev 3.2, 2026-08-04.** Lane-3 fleet fold (code + database + consistency FAILs, all in the apply script's input seam; the shipped code was plan-verbatim, so these are plan defects amended here as binding deltas): proposed_historical validates type-before-coercion per parseSeniorityInt discipline and ABORTS on a non-conforming cell; a missing consumed header ABORTS (round-trip pinned by MAPPING_COLUMNS in tests); a blank proposed_hire_date can never write NULL (generator flags no-proposed-date and forces include=no; apply skips-and-reports); duplicate matched_user_id aborts and the rollback snapshot moves to a single pre-pass SELECT before any UPDATE; rowCount=0 writes are named and fail the run; both scripts take config.getArg (--flag=value forms) and tilde expansion; runbook gains the earliest-backup-is-the-rollback clause and the generator overwrite guard.
