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
- **Server tests:** `node:test`, one suite at a time, shared dev DB, `require('dotenv').config()`, set `process.env.SEND_NOTIFICATIONS='false'`, refuse to run under `NODE_ENV=production`, clean up fixtures by a unique PREFIX in `after`.
- **Client verification:** `cd client && CI=true npx react-scripts build` (the `.husky/pre-push` gate). `AdminUserDetail.js` is 674 lines, keep additions minimal (soft cap 700).
- **Docs:** update `README.md` (folder tree / scripts) and `ARCHITECTURE.md` (Database Schema section) in the same lane as the code.
- **Git:** explicit path staging only; `os` never leaves `main`; lanes squash-merge.

---

## Lane 1: seniority-baseline-core

### Task 1.1: Add the `historical_events_worked` column

**Files:**
- Modify: `server/db/schema.sql` (line 1171, immediately after the `hire_date` ALTER; match on the exact anchor string below, not the line number)

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

- [ ] **Step 2: Apply the schema to the dev DB and verify the column exists**

Run:
```bash
node -e "require('dotenv').config(); const {pool}=require('./server/db'); (async()=>{const sql=require('fs').readFileSync('./server/db/schema.sql','utf8'); await pool.query(sql); const r=await pool.query(\"SELECT column_name,data_type,column_default FROM information_schema.columns WHERE table_name='contractor_profiles' AND column_name='historical_events_worked'\"); console.log(r.rows); await pool.end();})()"
```
Expected: one row → `historical_events_worked | integer | 0`.

- [ ] **Step 3: Update ARCHITECTURE.md schema section**

In `ARCHITECTURE.md`, in the `contractor_profiles` description within the Database Schema section, add `historical_events_worked` (integer, default 0) next to `hire_date` / `seniority_adjustment`, described as "pre-migration event credit added to the live event count for seniority."

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

Run: `node --test server/utils/autoAssign.seniority.test.js`
Expected: FAIL, `events_worked` is `0` (baseline not yet summed), assertion `12 === 0` fails.

- [ ] **Step 2b: Confirm the events-count reader set (guard against a third site)**

Spec §3.2 requires that every reader of the live events count receives the live+baseline change. Confirm the set before editing:
```bash
grep -rnE "event_date < CURRENT_DATE|events_worked|computeSeniorityScore" server --include=*.js | grep -v "\.test\.js" | grep -viE "staffPaymentImport|clientPortal"
```
Expected: hits ONLY in `server/utils/autoAssign.js` and `server/routes/admin/users.js` (the `clientPortal.js` past-date query is over proposals, not shifts, and is correctly excluded). If a third file appears, it is in scope for the same change before proceeding.

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

Run: `node --test server/utils/autoAssign.seniority.test.js`
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test server/routes/admin/users.seniority.test.js`
Expected: FAIL, `historical_events_worked` is `undefined` in the response and PUT ignores it.

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

Replace the **entire** PUT handler (line 563 `router.put(` through the closing `}));` on line 577; the block below is the complete handler, so match on content, not the line numbers, or the stale `}));` on 577 becomes a duplicate close):
```javascript
router.put('/users/:id/seniority', auth, adminOnly, asyncHandler(async (req, res) => {
  const { seniority_adjustment, hire_date, historical_events_worked } = req.body;
  await pool.query(`
    UPDATE contractor_profiles
    SET seniority_adjustment = COALESCE($1, seniority_adjustment),
        hire_date = COALESCE($2, hire_date),
        historical_events_worked = COALESCE($3, historical_events_worked)
    WHERE user_id = $4
  `, [
    seniority_adjustment !== null && seniority_adjustment !== undefined ? seniority_adjustment : null,
    hire_date || null,
    historical_events_worked !== null && historical_events_worked !== undefined ? historical_events_worked : null,
    req.params.id
  ]);

  res.json({ success: true });
}));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test server/routes/admin/users.seniority.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/admin/users.js server/routes/admin/users.seniority.test.js
git commit -m "feat(seniority): GET/PUT seniority carry the historical baseline"
```

---

## Lane 2: seniority-panel-ui  *(depends on Lane 1)*

### Task 2.1: Show the split and edit the baseline on the seniority panel

**Files:**
- Modify: `client/src/pages/admin/userDetail/AdminUserDetail.js` (state at ~76-130, save at ~289-305)
- Modify: `client/src/pages/admin/userDetail/tabs/PayoutsTab.js` (seniority card at ~160-201)

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

In `PayoutsTab.js`, replace the "Events worked" stat (lines ~166-169) so the total shows the breakdown:
```javascript
                  <div className="stat">
                    <div className="stat-label">Events worked</div>
                    <div className="stat-value">{seniority.events_worked ?? 0}</div>
                    <div className="tiny muted">{seniority.events_worked_live ?? 0} live + {seniority.historical_events_worked ?? 0} historical</div>
                  </div>
```

- [ ] **Step 4: Add the editable baseline input**

In `PayoutsTab.js`, inside the inputs grid (after the "Manual adjustment" block, before the closing `</div>` at line ~194), add:
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

First restart the Claude-managed dev server (it does not auto-reload) so Lane 1's merged `/seniority` route is live. Then load an admin user-detail → Payouts tab for a staffer, confirm the seniority card shows "N live + M historical", edit the historical field, Save, confirm the toast and that the Score/Events values update on reload. Note the result in the commit or lane notes.

- [ ] **Step 7: Commit**

```bash
git add client/src/pages/admin/userDetail/AdminUserDetail.js client/src/pages/admin/userDetail/tabs/PayoutsTab.js
git commit -m "feat(seniority): admin panel shows live/historical split and edits the baseline"
```

---

## Lane 3: cc-seniority-import  *(depends on Lane 1 column)*

Reuses the existing CC-matching machinery in `server/scripts/staffPaymentImport/`: `ccReports.js` (CSV loaders), `dictionary.js` (`buildDictionary` / alias-cluster `resolve`), and the `exportKnownPeople.js` DB-export conventions. New files sit at the same directory level so the `../../db` / `../../../.env` require paths match `exportKnownPeople.js` exactly.

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
const STAFF_ROLE = /bartender|barback|server|staff|manager|captain/i;
const ACTIVE_STATUS = new Set(['approved', 'hired']);
const MAPPING_COLUMNS = ['cc_name', 'cc_created_date', 'cc_events', 'matched_user_id', 'os_preferred_name', 'onboarding_status', 'current_hire_date', 'proposed_hire_date', 'current_live_events', 'proposed_historical', 'include', 'flags'];

// Pure: given a CC contact and its matched OS current-state, produce the review
// row (include default + flags). Exported for unit testing.
function shapeMappingRow({ name, created, events, matchedUserId, onboardingStatus, current = {}, dupCount = 1 }) {
  const curHire = current.hire_date ? String(current.hire_date).slice(0, 10) : '';
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

module.exports = { shapeMappingRow, MAPPING_COLUMNS };
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
const { shapeMappingRow } = require('./generateSeniorityMapping');

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

- [ ] **Step 2: Run the flag-logic test**

Run: `node --test server/scripts/staffPaymentImport/generateSeniorityMapping.test.js`
Expected: PASS (4 tests). This relies on the `require.main === module` guard in the generator, so importing it does not run `main()`.

- [ ] **Step 3: Dry-run the generator against the dev DB and eyeball the output**

Run:
```bash
node server/scripts/staffPaymentImport/exportKnownPeople.js --review-dir "$HOME/win-share/payments/review"
node server/scripts/staffPaymentImport/generateSeniorityMapping.js --review-dir "$HOME/win-share/payments/review"
```
Expected: writes `seniority-mapping.csv`; console prints row/matched/default-include counts. Open the CSV and confirm columns + flags look sane (Kaitlyn Freyer → a real `matched_user_id`, `proposed_historical=32`, etc.).

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
const { parseMappingRows, planWrites, applyWrites } = require('./applySeniorityBackfill');

if (process.env.NODE_ENV === 'production') {
  throw new Error('seniorityBackfill.test.js refuses to run against production');
}

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
  assert.equal(String(r.rows[0].hire_date).slice(0, 10), '2025-06-10');   // unchanged
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
  assert.equal(String(r.rows[0].hire_date).slice(0, 10), '2025-05-22');
  assert.equal(r.rows[0].historical_events_worked, 32);
  // The other profile was never in the write set, so it is untouched.
  const o = await pool.query('SELECT hire_date, historical_events_worked FROM contractor_profiles WHERE user_id = $1', [otherUid]);
  assert.equal(String(o.rows[0].hire_date).slice(0, 10), '2025-07-01');
  assert.equal(o.rows[0].historical_events_worked, 1);
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
    const priorHire = b.hire_date ? String(b.hire_date).slice(0, 10) : '';
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

module.exports = { parseMappingRows, planWrites, applyWrites };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test server/scripts/staffPaymentImport/seniorityBackfill.test.js`
Expected: PASS (all tests: 2 pure + 2 DB-backed).

- [ ] **Step 5: Dry-run against the dev DB (writes nothing)**

Run: `node server/scripts/staffPaymentImport/applySeniorityBackfill.js --file "$HOME/win-share/payments/review/seniority-mapping.csv"`
Expected: prints per-row before→after and "dry-run only"; a follow-up `SELECT` shows no rows changed.

- [ ] **Step 6: Update README**

In `README.md`, add the two new scripts to the `server/scripts/staffPaymentImport/` entry in the folder-structure tree (generator + apply), one line each.

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
6. `node .../applySeniorityBackfill.js --file DIR/seniority-mapping.csv --apply` (also writes a `...backup-<ts>.csv` snapshot of the prior hire_date / historical values beside the mapping file, for rollback).
7. Spot-check a couple of profiles on the admin seniority panel (live + historical shows the expected total).

## Self-Review

- **Spec coverage:** column (§3.1 → 1.1); events = live+baseline at both sites (§3.2 → 1.2 autoAssign, 1.3 route; a grep-readers guard added at 1.2 Step 2b); hire_date direct-set (§3.3 → applied in 3.2 write); admin panel split + edit (§3.4 → 2.1); mapping generator + review + apply (§4 → 3.1, 3.2, runbook); DATE truncation + face-value counts + flags (§5 → generator flags, `ccDateToIso`); cap left unchanged (§6 → Global Constraints); tests (§7 → 1.2, 1.3; 3.1 pure flag-logic test; 3.2 DB-backed `applyWrites` idempotency/exactness test plus the pure filter); out-of-scope respected (§8, no phones, no synthetic shifts, weights/cap untouched).
- **Design-fleet review folded (2026-07-26):** footprints corrected (ARCHITECTURE.md → L1; ccReports.js + README + generator test → L3); autoAssign suites run one at a time; apply script snapshots prior state before writing; spec §4 flag set reconciled to `duplicate-match` + `unmatched` (true `ambiguous` is not derivable without resolver scope creep) and §3.1 DDL carries the `CHECK (>= 0)`.
- **Placeholder scan:** none, every code step carries full code; the one "follow the existing harness" note (1.3 Step 1) points at a concrete file (`users.activeStaff.test.js`) to copy verbatim rather than inventing a signature.
- **Type consistency:** `historical_events_worked` (DB/route/form), `events_worked_live` + `events_worked` (total) used identically in 1.3 and 2.1; `parseMappingRows`/`planWrites` shapes match between 3.2 impl and its test.
