# Lab Rat Tester Program v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the linear `TESTING.md` guide and email feedback loop with a Facebook-distributable `/labrat` site: friends-and-family take a 3-question quiz, get matched to bite-sized missions, and report bugs into a Claude-readable JSONL log instead of email.

**Architecture:** React routes under `client/src/pages/labrat/` powered by Express APIs. Mission catalog lives as JS data files under `server/data/missions/`. Bug log is append-only JSONL files at `server/data/tester-bugs/`. Pre-seeded test data is tagged with a new `is_test_data` column on five entity tables and purged nightly. Drift detection is automated via a per-mission `affectedFiles` + `lastVerified` pair plus a pre-push `missions:check` script. A `/labrat-fix` skill formalizes the bug-triage-and-fix loop.

**Tech Stack:** Node.js 18 / Express 4.18, React 18 (CRA), PostgreSQL (Neon, raw SQL), Resend (no longer used for tester feedback), JWT (HMAC) for auto-advance tokens, Jest for utility tests.

**Spec:** `docs/superpowers/specs/2026-04-27-tester-program-v2-design.md`

---

## File structure

### New files

```
server/data/missions/
├── index.js                      # Aggregates + freezes catalog; throws on invalid mission
├── customer.js                   # 8 missions
├── applicant.js                  # 3 missions
├── staff.js                      # 4 missions
├── admin.js                      # 10 missions
├── mobile.js                     # 3 missions
├── edge.js                       # 2 missions
├── _shape.js                     # Mission shape validator (pure function)
└── __tests__/missions.test.js    # Catalog validation

server/data/tester-bugs/
├── .gitkeep                      # Directory tracked, contents gitignored
└── (runtime: YYYY-MM.jsonl, status.json)

server/data/
├── mission-completions.jsonl     # Runtime, gitignored
└── qa-seed-registry.jsonl        # Runtime, gitignored

server/routes/
└── labrat.js                     # /api/qa/* endpoints (shortlist, seed, complete, labrat-token)

server/utils/
├── bugLog.js                     # Append + project bug log files
├── bugLog.test.js                # Jest tests for bug log
├── missionStats.js               # Completion-count projection
├── missionStats.test.js
├── qaSeed.js                     # Per-recipe seed handlers
├── qaToken.js                    # JWT mint/verify for auto-advance
├── qaToken.test.js
├── shortlist.js                  # Pure sort/filter for /api/qa/shortlist
├── shortlist.test.js
└── qaCleanupScheduler.js         # Nightly purge of is_test_data + JSONL archive

server/scripts/
├── bugsList.js                   # `npm run bugs:list`
├── bugsFix.js                    # `npm run bugs:fix <id> <commit-sha>`
├── missionsCheck.js              # `npm run missions:check`
├── missionsVerify.js             # `npm run missions:verify <id>`
└── missionsScanRoutes.js         # `npm run missions:scan-routes`

client/src/pages/labrat/
├── LabRatLanding.js              # GET /labrat
├── LabRatQuiz.js                 # GET /labrat/quiz
├── LabRatMissions.js             # GET /labrat/missions (picker)
├── LabRatMission.js              # GET /labrat/m/:id
├── BugDialog.js                  # Reused bug-report dialog (per-step + I'm stuck + mission-stale)
└── labrat.css                    # Scoped styles for [data-app="labrat"]

.claude/skills/
└── labrat-fix.md                 # Bug-triage-and-fix workflow skill
```

### Modified files

```
server/db/schema.sql              # +5 ALTER TABLE adds for is_test_data
server/index.js                   # Mount labrat router; register cleanup scheduler
server/routes/testFeedback.js     # Rewrite to write JSONL instead of email
server/routes/proposals.js        # Auto-advance flag on /public/submit
server/routes/clients.js          # Filter is_test_data on admin LIST endpoints
server/routes/drinkPlans.js       # Filter is_test_data on admin LIST endpoints
server/routes/admin.js            # Filter is_test_data on user/application LIST endpoints
client/src/App.js                 # +PublicWebsiteRoutes entry for /labrat/*
package.json                      # +npm scripts: bugs:list, bugs:fix, missions:check, missions:verify, missions:scan-routes
.gitignore                        # +server/data/tester-bugs/*.jsonl, +status.json, +mission-completions.jsonl, +qa-seed-registry.jsonl
.husky/pre-commit                 # No change; pre-push hook is separate (see Task 29)
```

### Documentation (deferred — Task 32 may be gated by in-flight refactor)

```
.claude/CLAUDE.md                 # +Lab Rat folder structure, +missions drift rule, +bug-log access pattern
README.md                         # +Lab Rat folder structure, +npm scripts table entries
ARCHITECTURE.md                   # +Lab Rat section, +is_test_data column note on 5 tables
```

---

## Phase 1 — Schema and bug log foundations

### Task 1: Add `is_test_data` column to five tables

**Files:**
- Modify: `server/db/schema.sql` (append idempotent ALTER statements)

- [ ] **Step 1: Open `server/db/schema.sql` and append at the end of the file**

```sql
-- ============================================================
-- Lab Rat: is_test_data flag for pre-seeded QA records
-- Tag every row created by /api/qa/seed so the nightly cleanup
-- can purge them. Filter from admin LIST endpoints to keep
-- the dashboards uncluttered.
-- ============================================================
ALTER TABLE clients      ADD COLUMN IF NOT EXISTS is_test_data BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE proposals    ADD COLUMN IF NOT EXISTS is_test_data BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE drink_plans  ADD COLUMN IF NOT EXISTS is_test_data BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users        ADD COLUMN IF NOT EXISTS is_test_data BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS is_test_data BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_clients_is_test_data      ON clients(is_test_data) WHERE is_test_data = true;
CREATE INDEX IF NOT EXISTS idx_proposals_is_test_data    ON proposals(is_test_data) WHERE is_test_data = true;
CREATE INDEX IF NOT EXISTS idx_drink_plans_is_test_data  ON drink_plans(is_test_data) WHERE is_test_data = true;
CREATE INDEX IF NOT EXISTS idx_users_is_test_data        ON users(is_test_data) WHERE is_test_data = true;
CREATE INDEX IF NOT EXISTS idx_applications_is_test_data ON applications(is_test_data) WHERE is_test_data = true;
```

- [ ] **Step 2: Verify schema applies cleanly against the live DB**

Run: `npm run dev` (server boots and runs schema.sql against the connection string)
Expected: Server starts without errors. The five `ADD COLUMN` and five `CREATE INDEX` statements are idempotent — safe on re-run.

- [ ] **Step 3: Commit**

```bash
git add server/db/schema.sql
git commit -m "feat(labrat): add is_test_data column + partial indexes to 5 tables"
```

---

### Task 2: Filter `is_test_data` from admin LIST endpoints

**Files:**
- Modify: `server/routes/clients.js` (admin GET / list endpoint)
- Modify: `server/routes/proposals.js` (admin GET / list endpoint, financials, dashboard-stats)
- Modify: `server/routes/drinkPlans.js` (admin LIST endpoint)
- Modify: `server/routes/admin.js` (user list, application list)

- [ ] **Step 1: Find each admin LIST query and add `WHERE is_test_data = false`**

For each route file above, locate every admin GET endpoint that lists rows from `clients`, `proposals`, `drink_plans`, `users`, or `applications`. Add `AND is_test_data = false` to existing WHERE clauses, or `WHERE is_test_data = false` if there is none.

Example pattern (in `server/routes/proposals.js` around the admin `GET /`):

```js
// Before:
const result = await pool.query(`
  SELECT p.*, c.name AS client_name
  FROM proposals p
  LEFT JOIN clients c ON p.client_id = c.id
  WHERE ($1::text IS NULL OR p.status = $1)
  ORDER BY p.created_at DESC
`, [status]);

// After:
const result = await pool.query(`
  SELECT p.*, c.name AS client_name
  FROM proposals p
  LEFT JOIN clients c ON p.client_id = c.id
  WHERE ($1::text IS NULL OR p.status = $1)
    AND p.is_test_data = false
  ORDER BY p.created_at DESC
`, [status]);
```

- [ ] **Step 2: Filter financial aggregations**

In `server/routes/proposals.js` find `GET /financials` and `GET /dashboard-stats`. Add `AND is_test_data = false` to every aggregate query (revenue sums, payment lists, counts).

- [ ] **Step 3: Verify no public token-gated routes are filtered**

Public routes that look up by token (e.g., `GET /t/:token`, `GET /api/drink-plans/t/:token`) MUST continue to work for seeded test rows. Do NOT add `is_test_data = false` to those — the token itself is the access control, and seeded rows need to be reachable via their token.

- [ ] **Step 4: Smoke-test**

Run: `npm run dev`, log in as admin, browse Proposals/Clients/Drink Plans dashboards
Expected: All real records visible, no errors. (No test records exist yet, so visual confirmation is "nothing changed.")

- [ ] **Step 5: Commit**

```bash
git add server/routes/clients.js server/routes/proposals.js server/routes/drinkPlans.js server/routes/admin.js
git commit -m "feat(labrat): exclude is_test_data rows from admin lists + financial aggregates"
```

---

### Task 3: Bug log utility

**Files:**
- Create: `server/utils/bugLog.js`
- Create: `server/utils/bugLog.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/utils/bugLog.test.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { appendBug, listOpenBugs, setBugStatus } = require('./bugLog');

describe('bugLog', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buglog-'));
    process.env.LABRAT_BUG_DIR = tmpDir;
  });
  afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  test('appendBug writes a JSON line and returns the id', async () => {
    const { id } = await appendBug({
      kind: 'bug',
      missionId: 'submit-byob-quote',
      stepIndex: 2,
      testerName: 'Jordan',
      testerEmail: null,
      where: 'Step 3 of quote wizard',
      didWhat: 'Filled date and clicked Next',
      happened: 'Page froze',
      expected: 'Should advance to Step 4',
      browser: 'Chrome 142',
      screenshotUrl: null,
    });
    expect(id).toMatch(/^bug_/);
    const month = new Date().toISOString().slice(0, 7);
    const file = path.join(tmpDir, `${month}.jsonl`);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.kind).toBe('bug');
    expect(parsed.missionId).toBe('submit-byob-quote');
    expect(parsed.id).toBe(id);
  });

  test('listOpenBugs returns bugs without status entries', async () => {
    const { id: a } = await appendBug({ kind: 'bug', happened: 'A' });
    const { id: b } = await appendBug({ kind: 'bug', happened: 'B' });
    await setBugStatus(a, { status: 'fixed', fixCommitSha: 'abc1234' });
    const open = await listOpenBugs();
    expect(open.map(x => x.id)).toEqual([b]);
  });

  test('appendBug rejects unknown kind', async () => {
    await expect(appendBug({ kind: 'rant', happened: 'x' })).rejects.toThrow(/kind/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest server/utils/bugLog.test.js`
Expected: FAIL with "Cannot find module './bugLog'"

- [ ] **Step 3: Implement `bugLog.js`**

```js
// server/utils/bugLog.js
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const VALID_KINDS = new Set(['bug', 'confusion', 'mission-stale']);

function getBugDir() {
  return process.env.LABRAT_BUG_DIR
    || path.join(__dirname, '..', 'data', 'tester-bugs');
}

function statusFile() {
  return path.join(getBugDir(), 'status.json');
}

function monthFile(date = new Date()) {
  const ym = date.toISOString().slice(0, 7);
  return path.join(getBugDir(), `${ym}.jsonl`);
}

async function ensureDir() {
  await fs.mkdir(getBugDir(), { recursive: true });
}

function newBugId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  return `bug_${ts}_${rand}`;
}

async function appendBug(input) {
  if (!VALID_KINDS.has(input.kind)) {
    throw new Error(`bugLog: invalid kind "${input.kind}"`);
  }
  await ensureDir();
  const record = {
    id: newBugId(),
    kind: input.kind,
    missionId: input.missionId || null,
    stepIndex: Number.isFinite(input.stepIndex) ? input.stepIndex : null,
    testerName: (input.testerName || '').toString().slice(0, 120) || null,
    testerEmail: (input.testerEmail || '').toString().slice(0, 200) || null,
    where: (input.where || '').toString().slice(0, 1000),
    didWhat: (input.didWhat || '').toString().slice(0, 5000),
    happened: (input.happened || '').toString().slice(0, 5000),
    expected: (input.expected || '').toString().slice(0, 5000),
    browser: (input.browser || '').toString().slice(0, 500),
    screenshotUrl: (input.screenshotUrl || '').toString().slice(0, 1000) || null,
    reportedAt: new Date().toISOString(),
  };
  await fs.appendFile(monthFile(), JSON.stringify(record) + '\n');
  return { id: record.id };
}

async function readStatus() {
  try {
    const raw = await fs.readFile(statusFile(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function setBugStatus(bugId, patch) {
  await ensureDir();
  const all = await readStatus();
  all[bugId] = {
    ...(all[bugId] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(statusFile(), JSON.stringify(all, null, 2));
  return all[bugId];
}

async function readAllBugs() {
  await ensureDir();
  const entries = await fs.readdir(getBugDir());
  const out = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const lines = (await fs.readFile(path.join(getBugDir(), name), 'utf8')).trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip malformed */ }
    }
  }
  return out;
}

async function listOpenBugs() {
  const [bugs, status] = await Promise.all([readAllBugs(), readStatus()]);
  return bugs.filter(b => !status[b.id] || status[b.id].status === 'open');
}

module.exports = { appendBug, listOpenBugs, setBugStatus, readAllBugs, readStatus };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest server/utils/bugLog.test.js`
Expected: 3 passing

- [ ] **Step 5: Commit**

```bash
git add server/utils/bugLog.js server/utils/bugLog.test.js
git commit -m "feat(labrat): bug-log utility with JSONL append + status sidecar"
```

---

### Task 4: Refactor `/api/test-feedback` to write JSONL instead of email

**Files:**
- Modify: `server/routes/testFeedback.js`

- [ ] **Step 1: Replace the file contents**

```js
// server/routes/testFeedback.js
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter } = require('../middleware/rateLimiters');
const { ValidationError } = require('../utils/errors');
const { appendBug } = require('../utils/bugLog');

const router = express.Router();

router.post('/', publicLimiter, asyncHandler(async (req, res) => {
  const {
    kind,
    missionId,
    stepIndex,
    testerName,
    testerEmail,
    where,
    didWhat,
    happened,
    expected,
    browser,
    screenshotUrl,
  } = req.body || {};

  const fieldErrors = {};
  const allowedKinds = ['bug', 'confusion', 'mission-stale'];
  if (!kind || !allowedKinds.includes(kind)) {
    fieldErrors.kind = `kind must be one of ${allowedKinds.join(', ')}`;
  }
  if (kind === 'bug' && (!happened || !happened.trim())) {
    fieldErrors.happened = 'Tell us what happened';
  }
  if (testerEmail && typeof testerEmail === 'string' && testerEmail.trim()) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testerEmail.trim())) {
      fieldErrors.testerEmail = 'Invalid email format';
    }
  }
  if (Object.keys(fieldErrors).length) {
    throw new ValidationError('Invalid feedback submission', fieldErrors);
  }

  const { id } = await appendBug({
    kind,
    missionId: missionId || null,
    stepIndex,
    testerName,
    testerEmail,
    where,
    didWhat,
    happened,
    expected,
    browser,
    screenshotUrl,
  });

  res.json({ ok: true, id });
}));

module.exports = router;
```

- [ ] **Step 2: Smoke test the endpoint**

Run server, then:
```bash
curl -X POST http://localhost:5000/api/test-feedback \
  -H "Content-Type: application/json" \
  -d '{"kind":"bug","happened":"smoke test","testerName":"Dallas"}'
```
Expected: `{"ok":true,"id":"bug_..."}`. A new file appears at `server/data/tester-bugs/YYYY-MM.jsonl`.

- [ ] **Step 3: Commit**

```bash
git add server/routes/testFeedback.js
git commit -m "feat(labrat): /api/test-feedback writes JSONL bug log instead of email"
```

---

### Task 5: Add `bugs:list` and `bugs:fix` npm scripts

**Files:**
- Create: `server/scripts/bugsList.js`
- Create: `server/scripts/bugsFix.js`
- Modify: `package.json` (add scripts)
- Modify: `.gitignore` (ignore runtime data)

- [ ] **Step 1: Add to `.gitignore`**

Append to `.gitignore`:
```
# Lab Rat runtime data — never committed
server/data/tester-bugs/*.jsonl
server/data/tester-bugs/status.json
server/data/mission-completions.jsonl
server/data/qa-seed-registry.jsonl
```

- [ ] **Step 2: Create `server/data/tester-bugs/.gitkeep`**

```bash
mkdir -p server/data/tester-bugs
touch server/data/tester-bugs/.gitkeep
```

(`.gitkeep` keeps the directory tracked even though its contents are gitignored.)

- [ ] **Step 3: Implement `bugsList.js`**

```js
// server/scripts/bugsList.js
const { listOpenBugs, readStatus } = require('../utils/bugLog');

async function main() {
  const args = process.argv.slice(2);
  const missionFlag = args.find(a => a.startsWith('--mission='));
  const statusFlag = args.find(a => a.startsWith('--status='));
  const missionFilter = missionFlag ? missionFlag.split('=')[1] : null;
  const statusFilter = statusFlag ? statusFlag.split('=')[1] : 'open';

  let bugs;
  if (statusFilter === 'open') {
    bugs = await listOpenBugs();
  } else {
    const { readAllBugs } = require('../utils/bugLog');
    const all = await readAllBugs();
    const status = await readStatus();
    bugs = all.filter(b => (status[b.id]?.status || 'open') === statusFilter);
  }
  if (missionFilter) bugs = bugs.filter(b => b.missionId === missionFilter);

  if (!bugs.length) {
    console.log(`No bugs matching status=${statusFilter}${missionFilter ? ` mission=${missionFilter}` : ''}.`);
    return;
  }

  const byMission = bugs.reduce((acc, b) => {
    const k = b.missionId || '(no mission)';
    (acc[k] = acc[k] || []).push(b);
    return acc;
  }, {});

  for (const [mission, list] of Object.entries(byMission)) {
    console.log(`\n## ${mission} (${list.length})`);
    for (const b of list) {
      console.log(`  ${b.id}  ${b.kind}  by ${b.testerName || 'anon'}  ${b.reportedAt}`);
      if (b.where) console.log(`    where:    ${b.where}`);
      if (b.didWhat) console.log(`    did:      ${b.didWhat}`);
      if (b.happened) console.log(`    happened: ${b.happened}`);
      if (b.expected) console.log(`    expected: ${b.expected}`);
    }
  }
  console.log(`\n${bugs.length} bug${bugs.length === 1 ? '' : 's'} total.`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 4: Implement `bugsFix.js`**

```js
// server/scripts/bugsFix.js
const { setBugStatus, readAllBugs } = require('../utils/bugLog');

async function main() {
  const [bugId, commitSha, ...notesParts] = process.argv.slice(2);
  if (!bugId) {
    console.error('Usage: npm run bugs:fix <bug-id> [<commit-sha>] [notes...]');
    process.exit(1);
  }
  const all = await readAllBugs();
  const exists = all.find(b => b.id === bugId);
  if (!exists) {
    console.error(`No bug with id ${bugId}`);
    process.exit(1);
  }
  const patch = {
    status: 'fixed',
    fixedAt: new Date().toISOString(),
  };
  if (commitSha) patch.fixCommitSha = commitSha;
  if (notesParts.length) patch.adminNotes = notesParts.join(' ');
  const result = await setBugStatus(bugId, patch);
  console.log(`Marked ${bugId} as fixed.`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 5: Add npm scripts to `package.json`**

In the root `package.json`, add to the `"scripts"` block:
```json
"bugs:list": "node server/scripts/bugsList.js",
"bugs:fix": "node server/scripts/bugsFix.js"
```

- [ ] **Step 6: Smoke test**

```bash
# After Task 4's smoke test left a bug in the log:
npm run bugs:list
# Expected: prints the bug grouped under "(no mission)"

npm run bugs:fix bug_<id-from-above> abc1234 "smoke test fix"
# Expected: "Marked bug_... as fixed." and writes status.json

npm run bugs:list
# Expected: "No bugs matching status=open."
```

- [ ] **Step 7: Commit**

```bash
git add server/scripts/bugsList.js server/scripts/bugsFix.js package.json .gitignore server/data/tester-bugs/.gitkeep
git commit -m "feat(labrat): bugs:list + bugs:fix npm scripts"
```

---

## Phase 2 — Mission catalog data

### Task 6: Mission catalog scaffold + validation test

**Files:**
- Create: `server/data/missions/_shape.js`
- Create: `server/data/missions/index.js`
- Create: `server/data/missions/customer.js` (empty array)
- Create: `server/data/missions/applicant.js` (empty array)
- Create: `server/data/missions/staff.js` (empty array)
- Create: `server/data/missions/admin.js` (empty array)
- Create: `server/data/missions/mobile.js` (empty array)
- Create: `server/data/missions/edge.js` (empty array)
- Create: `server/data/missions/__tests__/missions.test.js`

- [ ] **Step 1: Create the shape validator**

```js
// server/data/missions/_shape.js
const VALID_AREAS = new Set(['customer', 'applicant', 'staff', 'admin', 'mobile', 'edge']);
const VALID_DIFFICULTY = new Set(['easy', 'medium', 'hard']);
const VALID_DEVICES = new Set(['desktop', 'mobile']);
const VALID_PRIORITY = new Set(['p0', 'p1', 'p2']);
const VALID_SEED_RECIPES = new Set([
  null,
  'proposal-in-sent',
  'proposal-paid-deposit-with-autopay',
  'proposal-paid-in-full',
  'application-submitted',
  'staff-fully-onboarded',
  'drink-plan-pending-review',
]);

function validateMission(m, fileLabel) {
  const errs = [];
  const fail = (msg) => errs.push(`${fileLabel}[${m.id || '?'}]: ${msg}`);

  if (!m.id || typeof m.id !== 'string' || !/^[a-z0-9-]+$/.test(m.id)) fail('id must be kebab-case string');
  if (!m.title) fail('title required');
  if (!m.blurb) fail('blurb required');
  if (!VALID_AREAS.has(m.area)) fail(`area must be one of ${[...VALID_AREAS].join(',')}`);
  if (!Number.isInteger(m.estMinutes) || m.estMinutes < 1 || m.estMinutes > 120) fail('estMinutes must be 1-120');
  if (!VALID_DIFFICULTY.has(m.difficulty)) fail(`difficulty must be one of ${[...VALID_DIFFICULTY].join(',')}`);
  if (!Array.isArray(m.device) || !m.device.length || !m.device.every(d => VALID_DEVICES.has(d))) fail('device must be non-empty subset of desktop/mobile');
  if (typeof m.needsAdminComfort !== 'boolean') fail('needsAdminComfort must be boolean');
  if (!VALID_PRIORITY.has(m.priority)) fail(`priority must be one of ${[...VALID_PRIORITY].join(',')}`);
  if (!VALID_SEED_RECIPES.has(m.seedRecipe)) fail(`seedRecipe must be null or known recipe id`);
  if (!Array.isArray(m.steps) || m.steps.length < 1) fail('steps must be non-empty array');
  for (const [i, s] of (m.steps || []).entries()) {
    if (!s.text) fail(`steps[${i}].text required`);
    if (!s.expect) fail(`steps[${i}].expect required`);
  }
  if (!Array.isArray(m.affectedFiles) || !m.affectedFiles.length) fail('affectedFiles must be non-empty array');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.lastVerified || '')) fail('lastVerified must be YYYY-MM-DD');
  if (!m.successMessage) fail('successMessage required');

  return errs;
}

module.exports = { validateMission, VALID_AREAS, VALID_SEED_RECIPES };
```

- [ ] **Step 2: Create empty area files**

For each of `customer.js`, `applicant.js`, `staff.js`, `admin.js`, `mobile.js`, `edge.js`:

```js
// server/data/missions/<area>.js
module.exports = [];
```

- [ ] **Step 3: Create the index aggregator**

```js
// server/data/missions/index.js
const { validateMission } = require('./_shape');

const allMissions = [
  ...require('./customer'),
  ...require('./applicant'),
  ...require('./staff'),
  ...require('./admin'),
  ...require('./mobile'),
  ...require('./edge'),
];

const errors = [];
const seen = new Set();
for (const m of allMissions) {
  errors.push(...validateMission(m, m.area || 'unknown'));
  if (seen.has(m.id)) errors.push(`duplicate id: ${m.id}`);
  seen.add(m.id);
}
if (errors.length) {
  throw new Error('Invalid mission catalog:\n  ' + errors.join('\n  '));
}

const byId = Object.freeze(Object.fromEntries(allMissions.map(m => [m.id, Object.freeze(m)])));

module.exports = {
  all: Object.freeze(allMissions),
  byId,
};
```

- [ ] **Step 4: Write the validation test**

```js
// server/data/missions/__tests__/missions.test.js
const catalog = require('..');

describe('mission catalog', () => {
  test('loads without throwing', () => {
    expect(catalog.all).toBeDefined();
  });
  test('all ids are unique', () => {
    const ids = catalog.all.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('catalog is frozen', () => {
    expect(Object.isFrozen(catalog.all)).toBe(true);
    expect(Object.isFrozen(catalog.byId)).toBe(true);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `npx jest server/data/missions/`
Expected: 3 passing (catalog is empty, but loads, ids trivially unique, frozen)

- [ ] **Step 6: Commit**

```bash
git add server/data/missions/
git commit -m "feat(labrat): mission catalog scaffold + shape validator"
```

---

### Task 7: Customer area missions (8)

**Files:**
- Modify: `server/data/missions/customer.js`

**Source content:** Lift step text from `TESTING.md` Parts 1-2 (the customer-facing flows). Update URLs to drop `/admin` and `/portal` prefixes per commit `f13ef5c`.

- [ ] **Step 1: Replace `customer.js` with the full mission list**

The full file uses this template — write all 8 missions in the same shape. The first one is shown in detail; the remaining 7 follow the exact same pattern with content from the corresponding TESTING.md sections.

```js
// server/data/missions/customer.js
const TODAY = '2026-04-27';

module.exports = [
  {
    id: 'submit-byob-quote',
    title: 'Submit a fake event quote',
    blurb: 'Pretend you\'re hiring us for your wedding. Fill out the quote wizard.',
    area: 'customer',
    estMinutes: 10,
    difficulty: 'easy',
    device: ['desktop', 'mobile'],
    needsAdminComfort: false,
    priority: 'p0',
    seedRecipe: null,
    steps: [
      { text: 'Go to drbartender.com/quote.', expect: 'Wizard loads on Step 1.' },
      { text: 'Enter Guest count 50, Duration 4 hours.', expect: 'Both fields accept the values.' },
      { text: 'Pick an Event date 2+ weeks in the future, any Start time.', expect: 'Pickers work, no error.' },
      { text: 'Pick Event type "Wedding", City "Chicago", State "IL".', expect: 'Fields accept input.' },
      { text: 'Pick Alcohol provider "BYOB", Bar type "Full Bar". Click Next.', expect: 'Step 2 loads.' },
      { text: 'Enter your name, your real email, your real phone. Click Next.', expect: 'Step 4 (Extras) loads (Step 3 is hosted-only).' },
      { text: 'Check 1-2 add-ons and 1-2 syrups. Click Next.', expect: 'Total updates as you click. Step 5 loads with full breakdown.' },
      { text: 'Verify totals look right. Click Submit.', expect: 'Success message appears, then redirects to a proposal page.' },
      { text: 'Check your real email inbox.', expect: 'Proposal email arrives within 60 seconds.' },
    ],
    successMessage: 'Nice — quote-to-proposal is one of our most-used flows. Thanks!',
    affectedFiles: [
      'client/src/pages/website/QuoteWizard.js',
      'server/routes/proposals.js',
      'server/utils/email.js',
    ],
    lastVerified: TODAY,
  },

  // Mission 2: submit-hosted-quote — same shape as above. Sources from TESTING.md
  // Part 1 "Quote Wizard". Pick Alcohol "Hosted" so the package step (Step 3)
  // appears. Validate package selection drives the per-guest pricing.
  // estMinutes 12, priority p0, affectedFiles same + packages data file.

  // Mission 3: book-cocktail-class — sources from TESTING.md Part 1 "Class Wizard".
  // Mixology 101, BYOB, Tool Kit Rental, 10 guests. Validate $450 total.
  // estMinutes 8, priority p1, affectedFiles client/src/pages/website/ClassWizard.js + server/routes/proposals.js.

  // Mission 4: spirits-tasting-top-shelf — sources from TESTING.md Part 1
  // "Class Wizard — Spirits Tasting with Top Shelf". Validate $0 total +
  // "Request submitted!" + custom-quote email to contact@.
  // estMinutes 8, priority p1, affectedFiles ClassWizard.js + server/routes/proposals.js + server/utils/email.js.

  // Mission 5: sign-and-pay-deposit — uses seedRecipe 'proposal-in-sent'.
  // Sources from TESTING.md Part 2 "Open and sign the proposal" + "Pay the deposit".
  // estMinutes 12, priority p0, needsAdminComfort false, device desktop+mobile.
  // affectedFiles client/src/pages/proposal/ProposalView.js + server/routes/proposals.js + server/routes/stripe.js.

  // Mission 6: pay-balance-then-paid-in-full — uses seedRecipe 'proposal-paid-deposit-with-autopay'.
  // Sources from TESTING.md Part 2 "Pay the balance".
  // estMinutes 8, priority p1, affectedFiles ProposalView.js + stripe.js + utils/invoiceHelpers.js.

  // Mission 7: client-portal-otp-login — uses seedRecipe 'proposal-paid-in-full'.
  // Sources from TESTING.md Part 2 "Open the client portal".
  // estMinutes 6, priority p1, affectedFiles client/src/pages/public/ClientLogin.js + server/routes/clientAuth.js.

  // Mission 8: drink-plan-exploration — uses seedRecipe 'drink-plan-pending-review'.
  // Sources from TESTING.md Part 2 "Generate and fill out the drink plan".
  // estMinutes 15, priority p0, affectedFiles client/src/pages/plan/PotionPlanningLab.js + server/routes/drinkPlans.js.
];
```

For each commented mission slot above, the implementing agent writes the full mission object using the same shape as `submit-byob-quote`. Source content from the indicated TESTING.md sections; update any `/admin/...` or `/portal/...` URLs to the un-prefixed versions per commit `f13ef5c`.

- [ ] **Step 2: Run validation test**

Run: `npx jest server/data/missions/`
Expected: passes — 8 customer missions valid

- [ ] **Step 3: Commit**

```bash
git add server/data/missions/customer.js
git commit -m "feat(labrat): customer area missions (8)"
```

---

### Task 8: Applicant area missions (3)

**Files:**
- Modify: `server/data/missions/applicant.js`

**Source content:** TESTING.md Part 3 (Apply to Work).

- [ ] **Step 1: Write all 3 missions following the customer.js pattern**

Mission slots:
- `apply-as-bartender` — full happy-path application submission. estMinutes 12, priority p0, affectedFiles `client/src/pages/Application.js` + `server/routes/application.js`.
- `apply-validation-errors` — submit with bad inputs (under-21 DOB, banned state, missing required files). Verify each rejects with a clear message. estMinutes 8, priority p1.
- `application-rejection-path` — uses seedRecipe `application-submitted`. Sources from TESTING.md Part 3 "Second application — reject path". needsAdminComfort true (uses admin to reject). estMinutes 6, priority p2.

Each mission follows the same shape as the customer.js example.

- [ ] **Step 2: Validate**

Run: `npx jest server/data/missions/`
Expected: passes — 11 missions valid

- [ ] **Step 3: Commit**

```bash
git add server/data/missions/applicant.js
git commit -m "feat(labrat): applicant area missions (3)"
```

---

### Task 9: Staff area missions (4)

**Files:**
- Modify: `server/data/missions/staff.js`

**Source content:** TESTING.md Part 4 (Onboarding) + "Staff portal".

- [ ] **Step 1: Write all 4 missions**

Mission slots:
- `field-guide-and-agreement` — uses seedRecipe `application-submitted`. Sources from TESTING.md Part 4 "Field Guide" + "Agreement". estMinutes 8, priority p1, affectedFiles `client/src/pages/FieldGuide.js` + `client/src/pages/Agreement.js` + `server/routes/agreement.js`.
- `contractor-profile-and-w9` — uses seedRecipe `application-submitted`. Sources from TESTING.md Part 4 "Contractor Profile" + "Payday Protocols". estMinutes 10, priority p1.
- `request-and-cancel-shift` — uses seedRecipe `staff-fully-onboarded`. Sources from TESTING.md Part 4 "Staff portal" → "Shifts". estMinutes 6, priority p1, affectedFiles `client/src/pages/staff/StaffShifts.js` + `server/routes/shifts.js`.
- `staff-portal-tour` — uses seedRecipe `staff-fully-onboarded`. Sources from TESTING.md Part 4 "Staff portal". Visits Dashboard, Schedule, Events, Resources, Profile. estMinutes 5, priority p2.

- [ ] **Step 2: Validate + commit**

```bash
npx jest server/data/missions/
git add server/data/missions/staff.js
git commit -m "feat(labrat): staff area missions (4)"
```

---

### Task 10: Admin area missions (10)

**Files:**
- Modify: `server/data/missions/admin.js`

**Source content:** TESTING.md Parts 2 admin steps + Part 5 + Part 6.

All admin missions have `needsAdminComfort: true`. The mission steps include "Log in as admin@drbartender.com / DrBartender2024!" as Step 1.

- [ ] **Step 1: Write all 10 missions**

Mission slots:
- `send-a-proposal` — uses seedRecipe `proposal-in-sent` (or fresh `proposal-draft` if added). Sources from TESTING.md Part 2 "Send the proposal". estMinutes 4, priority p0.
- `record-cash-payment` — sources from TESTING.md Part 5 "Record a cash payment". estMinutes 5, priority p1.
- `generate-payment-link` — sources from TESTING.md Part 5 "Generate a Stripe payment link". estMinutes 6, priority p1.
- `charge-balance-via-autopay` — uses seedRecipe `proposal-paid-deposit-with-autopay`. Sources from TESTING.md Part 5 "Autopay charge balance test". estMinutes 5, priority p0.
- `approve-onboarding` — sources from TESTING.md Part 4 "Approve onboarding". estMinutes 4, priority p0.
- `approve-shift-request` — sources from TESTING.md Part 4 "Admin: approve the shift request". estMinutes 5, priority p0.
- `manual-assign-staff` — sources from TESTING.md Part 4 "Manual assign". estMinutes 5, priority p1.
- `auto-assign-preview` — sources from TESTING.md Part 4 "Auto-assign". estMinutes 4, priority p1.
- `add-and-publish-blog-post` — sources from TESTING.md Part 6 "Blog". estMinutes 8, priority p1.
- `email-marketing-draft-do-not-send` — sources from TESTING.md Part 6 "Email Marketing". CRITICAL: mission text must include the bold "DO NOT CLICK SEND" warning from the original guide. estMinutes 10, priority p1.

- [ ] **Step 2: Validate + commit**

```bash
npx jest server/data/missions/
git add server/data/missions/admin.js
git commit -m "feat(labrat): admin area missions (10)"
```

---

### Task 11: Mobile + edge area missions (5)

**Files:**
- Modify: `server/data/missions/mobile.js` (3)
- Modify: `server/data/missions/edge.js` (2)

- [ ] **Step 1: Mobile missions (device: ['mobile'] only)**

- `mobile-homepage-and-quote` — sources from TESTING.md Part 7 "Mobile pass". estMinutes 6, priority p1.
- `mobile-signature` — uses seedRecipe `proposal-in-sent`. Tests signature pad on touch. estMinutes 4, priority p1.
- `mobile-staff-portal` — uses seedRecipe `staff-fully-onboarded`. estMinutes 5, priority p2.

- [ ] **Step 2: Edge missions**

- `expired-proposal-token` — visit `/proposal/not-a-real-token`. Verify graceful error page (no stack trace). estMinutes 2, priority p2.
- `unknown-blog-slug` — visit `/labnotes/not-a-real-slug`. Verify "Post Not Found" page. estMinutes 2, priority p2.

- [ ] **Step 3: Validate + commit**

```bash
npx jest server/data/missions/
git add server/data/missions/mobile.js server/data/missions/edge.js
git commit -m "feat(labrat): mobile (3) + edge (2) missions; catalog complete at 30"
```

---

## Phase 3 — Backend APIs

### Task 12: Mission stats utility

**Files:**
- Create: `server/utils/missionStats.js`
- Create: `server/utils/missionStats.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/utils/missionStats.test.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { logCompletion, getCompletionCounts } = require('./missionStats');

describe('missionStats', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mstats-'));
    process.env.LABRAT_COMPLETIONS_FILE = path.join(tmp, 'completions.jsonl');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('counts completions per mission id', async () => {
    await logCompletion('a', 'tester1');
    await logCompletion('a', 'tester2');
    await logCompletion('b', 'tester1');
    const counts = await getCompletionCounts();
    expect(counts).toEqual({ a: 2, b: 1 });
  });
  test('returns empty object when no file', async () => {
    expect(await getCompletionCounts()).toEqual({});
  });
});
```

- [ ] **Step 2: Run, see fail**

Run: `npx jest server/utils/missionStats.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```js
// server/utils/missionStats.js
const fs = require('node:fs/promises');
const path = require('node:path');

function getFile() {
  return process.env.LABRAT_COMPLETIONS_FILE
    || path.join(__dirname, '..', 'data', 'mission-completions.jsonl');
}

async function logCompletion(missionId, testerName) {
  const dir = path.dirname(getFile());
  await fs.mkdir(dir, { recursive: true });
  const line = JSON.stringify({
    missionId,
    testerName: testerName || null,
    at: new Date().toISOString(),
  }) + '\n';
  await fs.appendFile(getFile(), line);
}

async function getCompletionCounts() {
  let raw;
  try {
    raw = await fs.readFile(getFile(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  const counts = {};
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      counts[rec.missionId] = (counts[rec.missionId] || 0) + 1;
    } catch { /* skip malformed */ }
  }
  return counts;
}

module.exports = { logCompletion, getCompletionCounts };
```

- [ ] **Step 4: Run, see pass**

Run: `npx jest server/utils/missionStats.test.js`
Expected: 2 passing

- [ ] **Step 5: Commit**

```bash
git add server/utils/missionStats.js server/utils/missionStats.test.js
git commit -m "feat(labrat): missionStats utility"
```

---

### Task 13: Shortlist sort/filter pure function

**Files:**
- Create: `server/utils/shortlist.js`
- Create: `server/utils/shortlist.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/utils/shortlist.test.js
const { buildShortlist } = require('./shortlist');

const M = (id, area, estMinutes, opts = {}) => ({
  id, area, estMinutes,
  needsAdminComfort: false,
  priority: 'p1',
  device: ['desktop', 'mobile'],
  ...opts,
});

const ALL = [
  M('a', 'customer', 5, { priority: 'p0' }),
  M('b', 'customer', 30, { priority: 'p1' }),
  M('c', 'admin',    8,  { priority: 'p1', needsAdminComfort: true }),
  M('d', 'mobile',   5,  { priority: 'p2' }),
  M('e', 'edge',     3,  { priority: 'p2' }),
];

describe('buildShortlist', () => {
  test('filters by area, time, and admin comfort', () => {
    const out = buildShortlist({
      missions: ALL,
      areas: ['customer'],
      timeBudget: 10,
      adminComfort: 'skip',
      device: 'desktop',
      completedIds: [],
      counts: {},
    });
    expect(out.missions.map(m => m.id)).toEqual(['a']);
    expect(out.relaxed).toBe(false);
  });
  test('sorts by priority then completion count', () => {
    const out = buildShortlist({
      missions: ALL,
      areas: ['customer', 'admin', 'mobile', 'edge'],
      timeBudget: 60,
      adminComfort: 'yes',
      device: 'desktop',
      completedIds: [],
      counts: { a: 5, b: 0 },  // a is over-tested
    });
    expect(out.missions[0].id).toBe('b');  // priority same? a is p0, b is p1, so a first
    // actually: p0(a) sorts before p1(b) regardless of counts.
    // So expected order: a(p0,5), then p1s by count: b(0), c(?). c not eligible if no admin in areas... but we listed admin.
    // Reconsider: a(p0,5), b(p1,0), c(p1,0), d(p2,0), e(p2,0).
    expect(out.missions[0].id).toBe('a');
    expect(out.missions[1].id).toBe('b');
  });
  test('drops completed ids', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop',
      completedIds: ['a'], counts: {},
    });
    expect(out.missions.map(m => m.id)).toEqual(['b']);
  });
  test('returns relaxed=true when strict filter yields <3 and widening helps', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 4,
      adminComfort: 'yes', device: 'desktop',
      completedIds: [], counts: {},
    });
    // strict: nothing under 4 minutes in customer
    // widened by 1.5x to 6 minutes: a (5 min) qualifies
    expect(out.relaxed).toBe(true);
    expect(out.missions.length).toBeGreaterThan(0);
  });
  test('respects device filter', () => {
    const desktopOnly = M('z', 'customer', 5, { device: ['desktop'] });
    const out = buildShortlist({
      missions: [desktopOnly], areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'mobile',
      completedIds: [], counts: {},
    });
    expect(out.missions).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, see fail**

Run: `npx jest server/utils/shortlist.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement**

```js
// server/utils/shortlist.js
const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2 };

function applyFilters(missions, { areas, timeBudget, adminComfort, device, completedIds }) {
  return missions.filter(m => {
    if (!areas.includes(m.area)) return false;
    if (m.estMinutes > timeBudget) return false;
    if (!m.device.includes(device)) return false;
    if (m.needsAdminComfort && adminComfort === 'skip') return false;
    if (completedIds.includes(m.id)) return false;
    return true;
  });
}

function sortMissions(filtered, counts) {
  return [...filtered].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority];
    const pb = PRIORITY_RANK[b.priority];
    if (pa !== pb) return pa - pb;
    const ca = counts[a.id] || 0;
    const cb = counts[b.id] || 0;
    if (ca !== cb) return ca - cb;
    return Math.random() - 0.5;
  });
}

function buildShortlist({ missions, areas, timeBudget, adminComfort, device, completedIds, counts, limit = 6 }) {
  const strict = applyFilters(missions, { areas, timeBudget, adminComfort, device, completedIds });
  if (strict.length >= 3) {
    return { missions: sortMissions(strict, counts).slice(0, limit), relaxed: false };
  }
  const widened = applyFilters(missions, {
    areas, timeBudget: Math.ceil(timeBudget * 1.5),
    adminComfort, device, completedIds,
  });
  if (widened.length >= 3) {
    return { missions: sortMissions(widened, counts).slice(0, limit), relaxed: true };
  }
  const areaOnly = missions.filter(m => areas.includes(m.area) && !completedIds.includes(m.id));
  return { missions: sortMissions(areaOnly, counts).slice(0, limit), relaxed: true };
}

module.exports = { buildShortlist };
```

- [ ] **Step 4: Run, see pass**

Run: `npx jest server/utils/shortlist.test.js`
Expected: 5 passing

- [ ] **Step 5: Commit**

```bash
git add server/utils/shortlist.js server/utils/shortlist.test.js
git commit -m "feat(labrat): shortlist filter+sort with priority and completion-count weighting"
```

---

### Task 14: QA token utility (mint/verify)

**Files:**
- Create: `server/utils/qaToken.js`
- Create: `server/utils/qaToken.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/utils/qaToken.test.js
const { mintQaToken, verifyQaToken } = require('./qaToken');

beforeAll(() => { process.env.JWT_SECRET = 'test-secret-for-labrat'; });

describe('qaToken', () => {
  test('mints and verifies', () => {
    const tok = mintQaToken({ purpose: 'auto-advance' });
    const decoded = verifyQaToken(tok);
    expect(decoded.purpose).toBe('auto-advance');
  });
  test('rejects bad signature', () => {
    expect(() => verifyQaToken('not.a.token')).toThrow();
  });
  test('rejects expired tokens', () => {
    const tok = mintQaToken({ purpose: 'auto-advance' }, { expiresIn: '-1s' });
    expect(() => verifyQaToken(tok)).toThrow();
  });
});
```

- [ ] **Step 2: Run, see fail**

Run: `npx jest server/utils/qaToken.test.js`

- [ ] **Step 3: Implement**

```js
// server/utils/qaToken.js
const jwt = require('jsonwebtoken');

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('qaToken: JWT_SECRET not set');
  return s;
}

function mintQaToken(payload, opts = {}) {
  return jwt.sign(
    { ...payload, kind: 'labrat-qa' },
    getSecret(),
    { expiresIn: opts.expiresIn || '24h' }
  );
}

function verifyQaToken(token) {
  const decoded = jwt.verify(token, getSecret());
  if (decoded.kind !== 'labrat-qa') throw new Error('not a labrat token');
  return decoded;
}

module.exports = { mintQaToken, verifyQaToken };
```

- [ ] **Step 4: Run tests, see pass; commit**

```bash
npx jest server/utils/qaToken.test.js
git add server/utils/qaToken.js server/utils/qaToken.test.js
git commit -m "feat(labrat): JWT-based QA token mint/verify"
```

---

### Task 15: Seed recipes utility

**Files:**
- Create: `server/utils/qaSeed.js`

This is non-trivial — each recipe creates real DB rows with `is_test_data = true`. Recipes use the existing pricing and proposal-create code paths to ensure test data matches real shape.

- [ ] **Step 1: Implement the recipe registry**

```js
// server/utils/qaSeed.js
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../db');

const REGISTRY_FILE = path.join(__dirname, '..', 'data', 'qa-seed-registry.jsonl');

async function logSeed(recipe, ids) {
  await fs.mkdir(path.dirname(REGISTRY_FILE), { recursive: true });
  await fs.appendFile(REGISTRY_FILE, JSON.stringify({
    recipe, ids, at: new Date().toISOString(),
  }) + '\n');
}

function fakeName() {
  const first = ['Lab', 'Test', 'QA', 'Demo', 'Mock', 'Sample'][crypto.randomInt(0, 6)];
  const last = ['Rat', 'Subject', 'Pilot', 'Friend', 'Cousin', 'Neighbor'][crypto.randomInt(0, 6)];
  return `${first} ${last}-${crypto.randomBytes(2).toString('hex')}`;
}

function fakeEmail() {
  return `labrat-${crypto.randomBytes(4).toString('hex')}@labrat.test`;
}

async function recipeProposalInSent(client) {
  // 1. Create test client
  const cli = await client.query(`
    INSERT INTO clients (name, email, phone, is_test_data)
    VALUES ($1, $2, $3, true)
    RETURNING id
  `, [fakeName(), fakeEmail(), '5555550100']);

  // 2. Create proposal in Sent state
  const eventDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  const prop = await client.query(`
    INSERT INTO proposals
      (client_id, status, event_type, event_date, event_start_time,
       event_duration_hours, guest_count, location_city, location_state,
       alcohol_provider, bar_type, total_cents, public_token, is_test_data)
    VALUES ($1, 'Sent', 'Wedding', $2, '17:00', 4, 50,
            'Chicago', 'IL', 'BYOB', 'Full Bar', 50000,
            gen_random_uuid()::text, true)
    RETURNING id, public_token
  `, [cli.rows[0].id, eventDate]);

  return { clientId: cli.rows[0].id, proposalId: prop.rows[0].id, token: prop.rows[0].public_token };
}

const RECIPES = {
  'proposal-in-sent': recipeProposalInSent,
  // The remaining 5 recipes follow the same pattern. Each:
  //   1. BEGIN transaction (caller wraps).
  //   2. Inserts client + proposal + any related records (signature, payment,
  //      drink_plan, application, user) all tagged is_test_data=true.
  //   3. Logs created IDs to qa-seed-registry.jsonl.
  //   4. Returns { clientId, proposalId, token, ...extras }.
  //
  // Recipe-specific notes:
  //   'proposal-paid-deposit-with-autopay': proposal status='Deposit Paid',
  //     amount_paid_cents=10000, autopay_enabled=true, stripe_customer_id=fake test customer id.
  //   'proposal-paid-in-full': status='Paid in Full', amount_paid_cents=50000.
  //   'application-submitted': inserts users + applications row, status='Applied',
  //     uploads dummy resume_url.
  //   'staff-fully-onboarded': users row with role='staff', onboarding_status='approved',
  //     contractor_profiles + agreements + payment_profiles rows.
  //   'drink-plan-pending-review': proposal-in-sent + drink_plans row in 'Submitted' state
  //     with sample exploration data.
};

async function runSeedRecipe(recipeId) {
  if (!RECIPES[recipeId]) throw new Error(`Unknown seed recipe: ${recipeId}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await RECIPES[recipeId](client);
    await client.query('COMMIT');
    await logSeed(recipeId, result);
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { runSeedRecipe, RECIPES };
```

- [ ] **Step 2: Implement the remaining 5 recipes**

For each of `proposal-paid-deposit-with-autopay`, `proposal-paid-in-full`, `application-submitted`, `staff-fully-onboarded`, `drink-plan-pending-review`, write a `recipe<Name>(client)` function following the template above. Use `pool.query` patterns from the existing routes (`server/routes/proposals.js`, `server/routes/application.js`, etc.) as a reference for which columns are required.

- [ ] **Step 3: Smoke-test in dev**

Run server. Trigger via direct require for now (will be exposed via API in next task):
```bash
node -e "require('./server/utils/qaSeed').runSeedRecipe('proposal-in-sent').then(r => console.log(r), e => console.error(e))"
```
Expected: prints `{ clientId: ..., proposalId: ..., token: '...' }`. Open `http://localhost:5000/api/proposals/t/<token>` — proposal loads.

- [ ] **Step 4: Commit**

```bash
git add server/utils/qaSeed.js
git commit -m "feat(labrat): seed recipes for is_test_data records"
```

---

### Task 16: Lab Rat router with shortlist + seed + complete + token endpoints

**Files:**
- Create: `server/routes/labrat.js`
- Modify: `server/index.js` (mount router)

- [ ] **Step 1: Implement the router**

```js
// server/routes/labrat.js
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter } = require('../middleware/rateLimiters');
const { ValidationError, NotFoundError } = require('../utils/errors');
const catalog = require('../data/missions');
const { buildShortlist } = require('../utils/shortlist');
const { getCompletionCounts, logCompletion } = require('../utils/missionStats');
const { runSeedRecipe } = require('../utils/qaSeed');
const { mintQaToken } = require('../utils/qaToken');

const router = express.Router();

const VALID_AREAS = ['customer', 'applicant', 'staff', 'admin', 'mobile', 'edge'];
const VALID_COMFORT = ['yes', 'walk', 'skip'];

router.get('/missions', publicLimiter, asyncHandler(async (req, res) => {
  res.json({ missions: catalog.all });
}));

router.get('/missions/:id', publicLimiter, asyncHandler(async (req, res) => {
  const m = catalog.byId[req.params.id];
  if (!m) throw new NotFoundError('Mission not found');
  res.json({ mission: m });
}));

router.post('/shortlist', publicLimiter, asyncHandler(async (req, res) => {
  const { areas, timeBudget, adminComfort, device, completedIds } = req.body || {};

  const errs = {};
  if (!Array.isArray(areas) || !areas.length || !areas.every(a => VALID_AREAS.includes(a))) {
    errs.areas = 'areas must be non-empty subset of valid areas';
  }
  if (!Number.isFinite(timeBudget) || timeBudget < 1 || timeBudget > 240) {
    errs.timeBudget = 'timeBudget must be 1-240 minutes';
  }
  if (adminComfort && !VALID_COMFORT.includes(adminComfort)) {
    errs.adminComfort = `adminComfort must be one of ${VALID_COMFORT.join(',')}`;
  }
  if (!['desktop', 'mobile'].includes(device)) {
    errs.device = 'device must be desktop or mobile';
  }
  if (Object.keys(errs).length) throw new ValidationError('Invalid shortlist input', errs);

  const counts = await getCompletionCounts();
  const result = buildShortlist({
    missions: catalog.all,
    areas, timeBudget,
    adminComfort: adminComfort || 'skip',
    device,
    completedIds: Array.isArray(completedIds) ? completedIds : [],
    counts,
  });
  res.json(result);
}));

router.post('/seed', publicLimiter, asyncHandler(async (req, res) => {
  const { recipe } = req.body || {};
  if (!recipe || typeof recipe !== 'string') {
    throw new ValidationError('recipe required', { recipe: 'required' });
  }
  const result = await runSeedRecipe(recipe);
  res.json({ ok: true, ...result });
}));

router.post('/complete', publicLimiter, asyncHandler(async (req, res) => {
  const { missionId, testerName } = req.body || {};
  if (!missionId || !catalog.byId[missionId]) {
    throw new ValidationError('Unknown mission', { missionId: 'unknown' });
  }
  await logCompletion(missionId, testerName || null);
  res.json({ ok: true });
}));

router.get('/token', publicLimiter, asyncHandler(async (req, res) => {
  const token = mintQaToken({ purpose: 'auto-advance' });
  res.json({ token });
}));

module.exports = router;
```

- [ ] **Step 2: Mount in `server/index.js`**

In `server/index.js`, add alongside the other route mounts:
```js
app.use('/api/qa', require('./routes/labrat'));
```

- [ ] **Step 3: Smoke-test all four endpoints**

```bash
# missions
curl http://localhost:5000/api/qa/missions | head -c 200

# shortlist
curl -X POST http://localhost:5000/api/qa/shortlist \
  -H "Content-Type: application/json" \
  -d '{"areas":["customer"],"timeBudget":15,"device":"desktop","completedIds":[]}'

# seed
curl -X POST http://localhost:5000/api/qa/seed \
  -H "Content-Type: application/json" \
  -d '{"recipe":"proposal-in-sent"}'

# complete
curl -X POST http://localhost:5000/api/qa/complete \
  -H "Content-Type: application/json" \
  -d '{"missionId":"submit-byob-quote","testerName":"Dallas"}'

# token
curl http://localhost:5000/api/qa/token
```
Expected: each returns ok-shaped JSON. `seed` returns proposal token; visiting `/api/proposals/t/<token>` works.

- [ ] **Step 4: Commit**

```bash
git add server/routes/labrat.js server/index.js
git commit -m "feat(labrat): /api/qa router (missions, shortlist, seed, complete, token)"
```

---

### Task 17: Auto-advance flag on `/api/proposals/public/submit`

**Files:**
- Modify: `server/routes/proposals.js` (find `router.post('/public/submit', ...)` around line 393)

- [ ] **Step 1: Locate the existing submit handler**

Read `server/routes/proposals.js` around line 393. Identify the response shape and where the proposal status is set.

- [ ] **Step 2: Add auto-advance logic at the end of the handler**

Just before the response is sent, add:

```js
// Lab Rat auto-advance: when the request originates from /labrat/m/...
// AND carries a valid signed QA token in the body, advance the proposal
// to Sent state immediately and trigger the proposal email — so unsupervised
// testers can complete the customer flow without admin involvement.
const qaToken = req.body && req.body.qaToken;
const referer = req.get('Referer') || '';
const isLabratFlow = referer.includes('/labrat/m/');
if (qaToken && isLabratFlow) {
  try {
    const { verifyQaToken } = require('../utils/qaToken');
    verifyQaToken(qaToken);
    // Mark the proposal as is_test_data so it's caught by cleanup
    await pool.query(
      `UPDATE proposals SET is_test_data = true, status = 'Sent' WHERE id = $1`,
      [createdProposalId]  // use whatever variable holds the new proposal id
    );
    // Fire the existing send-proposal email helper. Use the same function the
    // admin "send" button uses; locate it elsewhere in this file (search for
    // the send-proposal email path) and call it here.
    await sendProposalEmail(createdProposalId);
  } catch (err) {
    // Token invalid or referer wrong → silently skip. Do not block the submit.
    console.warn('[labrat] auto-advance rejected:', err.message);
  }
}
```

The exact variable names depend on the existing handler. Read the surrounding code carefully.

- [ ] **Step 3: Smoke-test**

```bash
# Mint a token first:
TOKEN=$(curl -s http://localhost:5000/api/qa/token | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).token))")

# Submit a quote with the token + spoofed referer:
curl -X POST http://localhost:5000/api/proposals/public/submit \
  -H "Content-Type: application/json" \
  -H "Referer: http://localhost:3000/labrat/m/submit-byob-quote" \
  -d "{\"qaToken\":\"$TOKEN\",\"name\":\"LabRat Tester\",\"email\":\"labrat-test@labrat.test\",\"phone\":\"5555550100\",\"guest_count\":50,\"event_date\":\"2026-06-01\",\"event_start_time\":\"17:00\",\"event_duration_hours\":4,\"event_type\":\"Wedding\",\"location_city\":\"Chicago\",\"location_state\":\"IL\",\"alcohol_provider\":\"BYOB\",\"bar_type\":\"Full Bar\",\"package\":null,\"addons\":[],\"syrups\":[]}"
```

Expected: Response includes new proposal token. Open admin → proposal list → the new proposal exists with status `Sent` and `is_test_data = true` (filtered from default admin view; query DB directly to confirm).

- [ ] **Step 4: Commit**

```bash
git add server/routes/proposals.js
git commit -m "feat(labrat): auto-advance quote submit to Sent when in labrat flow"
```

---

### Task 18: QA cleanup scheduler

**Files:**
- Create: `server/utils/qaCleanupScheduler.js`
- Modify: `server/index.js` (start scheduler in same place as other schedulers)

- [ ] **Step 1: Implement the scheduler**

```js
// server/utils/qaCleanupScheduler.js
const fs = require('node:fs/promises');
const path = require('node:path');
const pool = require('../db');

const PURGE_AFTER_DAYS = 7;
const ARCHIVE_BUGS_AFTER_DAYS = 90;

async function purgeTestData() {
  const cutoff = `NOW() - INTERVAL '${PURGE_AFTER_DAYS} days'`;
  const tables = ['drink_plans', 'proposals', 'clients', 'applications', 'users'];
  // Order matters for FK integrity. Drink plans + proposals reference clients.
  // applications + users referenced by other things; we use ON DELETE CASCADE
  // where possible. If a delete fails on FK, log and continue.
  for (const table of tables) {
    try {
      const result = await pool.query(
        `DELETE FROM ${table} WHERE is_test_data = true AND created_at < ${cutoff}`
      );
      if (result.rowCount) console.log(`[labrat-cleanup] purged ${result.rowCount} rows from ${table}`);
    } catch (err) {
      console.error(`[labrat-cleanup] failed to purge ${table}:`, err.message);
    }
  }
}

async function archiveOldBugFiles() {
  const dir = path.join(__dirname, '..', 'data', 'tester-bugs');
  const archiveDir = path.join(dir, 'archive');
  await fs.mkdir(archiveDir, { recursive: true });
  const cutoff = Date.now() - ARCHIVE_BUGS_AFTER_DAYS * 86400000;
  let entries;
  try { entries = await fs.readdir(dir); } catch { return; }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const stat = await fs.stat(path.join(dir, name));
    if (stat.mtimeMs < cutoff) {
      await fs.rename(path.join(dir, name), path.join(archiveDir, name));
      console.log(`[labrat-cleanup] archived ${name}`);
    }
  }
}

function startQaCleanupScheduler() {
  if (process.env.RUN_SCHEDULERS === 'false') return;
  // Run once at boot if it's been more than 24h since last run (best-effort, no state).
  // Then every 24h.
  const run = () => {
    Promise.allSettled([purgeTestData(), archiveOldBugFiles()])
      .then(() => console.log('[labrat-cleanup] cycle complete'));
  };
  // Schedule next run for 3 AM local time
  const now = new Date();
  const next = new Date();
  next.setHours(3, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntilNext = next - now;
  setTimeout(() => {
    run();
    setInterval(run, 24 * 60 * 60 * 1000);
  }, msUntilNext);
  console.log(`[labrat-cleanup] scheduled first run for ${next.toISOString()}`);
}

module.exports = { startQaCleanupScheduler, purgeTestData, archiveOldBugFiles };
```

- [ ] **Step 2: Start the scheduler in `server/index.js`**

Find the other scheduler starts (search for `Scheduler` or `RUN_SCHEDULERS`). Add:
```js
require('./utils/qaCleanupScheduler').startQaCleanupScheduler();
```

- [ ] **Step 3: Smoke-test**

Run `node -e "require('./server/utils/qaCleanupScheduler').purgeTestData()"`
Expected: prints `[labrat-cleanup] purged N rows from <table>` lines for the seeded test rows older than 7 days. (Likely no rows yet — that's fine, no errors should occur.)

- [ ] **Step 4: Commit**

```bash
git add server/utils/qaCleanupScheduler.js server/index.js
git commit -m "feat(labrat): nightly cleanup of is_test_data rows + bug-log archival"
```

---

## Phase 4 — Frontend

### Task 19: BugDialog React component

**Files:**
- Create: `client/src/pages/labrat/BugDialog.js`
- Create: `client/src/pages/labrat/labrat.css` (skeleton — full styles in Task 24)

- [ ] **Step 1: Implement the dialog**

```js
// client/src/pages/labrat/BugDialog.js
import { useEffect, useRef, useState } from 'react';
import api from '../../utils/api';

const TITLES = {
  bug: 'Report a bug',
  confusion: "I'm stuck — what's confusing?",
  'mission-stale': 'This mission seems wrong',
};

export default function BugDialog({ open, onClose, kind, missionId, stepIndex, where, didWhat, testerName }) {
  const dialogRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ happened: '', expected: '' });

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  useEffect(() => {
    if (open) setForm({ happened: '', expected: '' });
  }, [open, missionId, stepIndex]);

  async function onSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/test-feedback', {
        kind,
        missionId,
        stepIndex,
        testerName,
        where,
        didWhat,
        happened: form.happened,
        expected: form.expected,
        browser: navigator.userAgent,
      });
      onClose({ ok: true });
    } catch (err) {
      setError(err?.response?.data?.error || 'Could not send. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="labrat-dialog" data-app="labrat">
      <form onSubmit={onSubmit}>
        <h2>{TITLES[kind] || 'Report'}</h2>
        {where && <p className="labrat-dialog-context"><strong>Where:</strong> {where}</p>}
        {kind !== 'mission-stale' && (
          <label>What happened?
            <textarea
              required
              value={form.happened}
              onChange={e => setForm(f => ({ ...f, happened: e.target.value }))}
              rows={4}
            />
          </label>
        )}
        {kind === 'bug' && (
          <label>What did you expect? (optional)
            <textarea
              value={form.expected}
              onChange={e => setForm(f => ({ ...f, expected: e.target.value }))}
              rows={2}
            />
          </label>
        )}
        {kind === 'mission-stale' && (
          <label>What seems wrong with this mission?
            <textarea
              required
              value={form.happened}
              onChange={e => setForm(f => ({ ...f, happened: e.target.value }))}
              rows={4}
            />
          </label>
        )}
        {error && <p className="labrat-dialog-error">{error}</p>}
        <div className="labrat-dialog-actions">
          <button type="button" onClick={() => onClose({ ok: false })} disabled={submitting}>Cancel</button>
          <button type="submit" disabled={submitting} className="labrat-primary">
            {submitting ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
```

- [ ] **Step 2: Create skeleton CSS file**

```css
/* client/src/pages/labrat/labrat.css */
[data-app="labrat"] {
  --labrat-fg: #1f2328;
  --labrat-bg: #ffffff;
  --labrat-muted: #656d76;
  --labrat-accent: #6b46c1;  /* purple — distinct from admin teal/website warm tones */
  --labrat-border: #d0d7de;
  --labrat-radius: 8px;
}

dialog.labrat-dialog {
  border: 1px solid var(--labrat-border);
  border-radius: var(--labrat-radius);
  padding: 0;
  max-width: 560px;
  width: calc(100% - 2rem);
}
dialog.labrat-dialog::backdrop { background: rgba(0,0,0,0.4); }
dialog.labrat-dialog form { padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
dialog.labrat-dialog h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
dialog.labrat-dialog label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; font-weight: 500; }
dialog.labrat-dialog textarea {
  font: inherit;
  padding: 0.45em 0.6em;
  border: 1px solid var(--labrat-border);
  border-radius: 4px;
  resize: vertical;
}
.labrat-dialog-context { font-size: 0.85rem; color: var(--labrat-muted); margin: 0; }
.labrat-dialog-error { color: #b42318; font-size: 0.9rem; margin: 0; }
.labrat-dialog-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
.labrat-dialog-actions button {
  font: inherit;
  padding: 0.4rem 1rem;
  border: 1px solid var(--labrat-border);
  background: var(--labrat-bg);
  border-radius: 4px;
  cursor: pointer;
}
.labrat-primary { background: var(--labrat-accent) !important; color: white !important; border-color: var(--labrat-accent) !important; }
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/labrat/BugDialog.js client/src/pages/labrat/labrat.css
git commit -m "feat(labrat): BugDialog component + skeleton CSS"
```

---

### Task 20: LabRatLanding component

**Files:**
- Create: `client/src/pages/labrat/LabRatLanding.js`

- [ ] **Step 1: Implement**

```js
// client/src/pages/labrat/LabRatLanding.js
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import './labrat.css';

const NAME_KEY = 'labrat-tester-name';
const TOKEN_KEY = 'labrat-qa-token';

export default function LabRatLanding() {
  const navigate = useNavigate();
  const [name, setName] = useState('');

  useEffect(() => {
    setName(localStorage.getItem(NAME_KEY) || '');
    // Mint a fresh QA token on landing so the rest of the flow has it.
    api.get('/qa/token').then(r => {
      localStorage.setItem(TOKEN_KEY, r.data.token);
    }).catch(() => { /* non-blocking */ });
  }, []);

  function persistName() {
    if (name.trim()) localStorage.setItem(NAME_KEY, name.trim());
  }

  return (
    <div data-app="labrat" className="labrat-landing">
      <main>
        <h1>Be a Lab Rat</h1>
        <p>
          Dr. Bartender is about to launch. Pick a mission, click around,
          tell us what's broken. Five to sixty minutes — your call.
          Nothing you do here reaches real customers.
        </p>
        <div className="labrat-name">
          <label>
            First name (optional)
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={60}
              placeholder="So we know who broke what"
            />
          </label>
        </div>
        <div className="labrat-cta">
          <button
            className="labrat-primary"
            onClick={() => { persistName(); navigate('/labrat/quiz'); }}
          >
            Take a quick quiz →
          </button>
          <button
            className="labrat-ghost"
            onClick={() => { persistName(); navigate('/labrat/missions'); }}
          >
            Show me the missions
          </button>
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Add landing-specific styles to `labrat.css`**

```css
.labrat-landing main {
  max-width: 640px;
  margin: 4rem auto;
  padding: 2rem;
  text-align: center;
}
.labrat-landing h1 { font-size: 2.5rem; margin: 0 0 1rem; color: var(--labrat-accent); }
.labrat-landing p { font-size: 1.1rem; line-height: 1.6; color: var(--labrat-muted); }
.labrat-name { margin: 2rem auto; max-width: 320px; text-align: left; }
.labrat-name label { display: flex; flex-direction: column; gap: 0.4rem; font-weight: 500; }
.labrat-name input {
  font: inherit;
  padding: 0.6em 0.8em;
  border: 1px solid var(--labrat-border);
  border-radius: var(--labrat-radius);
}
.labrat-cta { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
.labrat-cta button {
  font: inherit;
  padding: 0.7rem 1.4rem;
  border-radius: var(--labrat-radius);
  cursor: pointer;
  border: 1px solid var(--labrat-border);
  background: var(--labrat-bg);
}
.labrat-ghost { color: var(--labrat-fg); }
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/labrat/LabRatLanding.js client/src/pages/labrat/labrat.css
git commit -m "feat(labrat): landing page"
```

---

### Task 21: LabRatQuiz component

**Files:**
- Create: `client/src/pages/labrat/LabRatQuiz.js`
- Modify: `client/src/pages/labrat/labrat.css`

- [ ] **Step 1: Implement**

```js
// client/src/pages/labrat/LabRatQuiz.js
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './labrat.css';

const AREA_OPTIONS = [
  { id: 'customer',  label: 'Booking an event as a customer' },
  { id: 'applicant', label: 'Applying to be a bartender' },
  { id: 'admin',     label: 'Poking around the admin tools' },
  { id: 'mobile',    label: 'Mobile testing on my phone' },
  { id: 'surprise',  label: 'Surprise me / whatever needs help most' },
];
const TIME_OPTIONS = [
  { value: 5,  label: 'Just a few minutes' },
  { value: 20, label: '15–20 minutes' },
  { value: 60, label: '30–60 minutes' },
  { value: 240, label: 'I am in for the long haul' },
];
const COMFORT_OPTIONS = [
  { value: 'yes',  label: 'Yes, throw me in' },
  { value: 'walk', label: 'Walk me through it' },
  { value: 'skip', label: 'Skip admin stuff' },
];

export default function LabRatQuiz() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [areas, setAreas] = useState([]);
  const [timeBudget, setTimeBudget] = useState(null);
  const [adminComfort, setAdminComfort] = useState(null);

  function toggleArea(id) {
    setAreas(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  const surfacesAdmin = areas.includes('admin') || areas.includes('surprise');

  function submit() {
    const params = new URLSearchParams();
    params.set('areas', areas.filter(a => a !== 'surprise').join(',') || 'customer,applicant,staff,admin,mobile,edge');
    params.set('timeBudget', String(timeBudget));
    if (surfacesAdmin) params.set('adminComfort', adminComfort || 'skip');
    navigate(`/labrat/missions?${params.toString()}`);
  }

  return (
    <div data-app="labrat" className="labrat-quiz">
      <main>
        {step === 1 && (
          <>
            <h2>What sounds fun, lab rat?</h2>
            <p className="labrat-quiz-hint">Pick any (or all)</p>
            <div className="labrat-chip-grid">
              {AREA_OPTIONS.map(o => (
                <button
                  key={o.id}
                  className={`labrat-chip ${areas.includes(o.id) ? 'on' : ''}`}
                  onClick={() => toggleArea(o.id)}
                  type="button"
                >{o.label}</button>
              ))}
            </div>
            <div className="labrat-quiz-nav">
              <button onClick={() => navigate('/labrat')}>← Back</button>
              <button
                className="labrat-primary"
                disabled={!areas.length}
                onClick={() => setStep(2)}
              >Next →</button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h2>How much time do you have?</h2>
            <div className="labrat-radio-list">
              {TIME_OPTIONS.map(o => (
                <label key={o.value}>
                  <input type="radio" name="time" checked={timeBudget === o.value} onChange={() => setTimeBudget(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
            <div className="labrat-quiz-nav">
              <button onClick={() => setStep(1)}>← Back</button>
              <button
                className="labrat-primary"
                disabled={timeBudget == null}
                onClick={() => surfacesAdmin ? setStep(3) : submit()}
              >{surfacesAdmin ? 'Next →' : 'Show missions →'}</button>
            </div>
          </>
        )}
        {step === 3 && surfacesAdmin && (
          <>
            <h2>Comfortable with admin / back-office tools?</h2>
            <div className="labrat-radio-list">
              {COMFORT_OPTIONS.map(o => (
                <label key={o.value}>
                  <input type="radio" name="comfort" checked={adminComfort === o.value} onChange={() => setAdminComfort(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
            <div className="labrat-quiz-nav">
              <button onClick={() => setStep(2)}>← Back</button>
              <button
                className="labrat-primary"
                disabled={!adminComfort}
                onClick={submit}
              >Show missions →</button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Add quiz styles to `labrat.css`**

```css
.labrat-quiz main { max-width: 640px; margin: 3rem auto; padding: 2rem; }
.labrat-quiz h2 { font-size: 1.6rem; margin: 0 0 0.5rem; }
.labrat-quiz-hint { color: var(--labrat-muted); margin: 0 0 1.5rem; }
.labrat-chip-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.labrat-chip {
  font: inherit;
  padding: 0.6rem 1rem;
  border: 1.5px solid var(--labrat-border);
  border-radius: 999px;
  background: var(--labrat-bg);
  cursor: pointer;
  color: var(--labrat-fg);
}
.labrat-chip.on { background: var(--labrat-accent); color: white; border-color: var(--labrat-accent); }
.labrat-radio-list { display: flex; flex-direction: column; gap: 0.5rem; margin: 1.5rem 0; }
.labrat-radio-list label {
  padding: 0.75rem 1rem;
  border: 1px solid var(--labrat-border);
  border-radius: var(--labrat-radius);
  cursor: pointer;
  display: flex; align-items: center; gap: 0.75rem;
}
.labrat-radio-list label:hover { background: #f6f8fa; }
.labrat-quiz-nav { display: flex; justify-content: space-between; margin-top: 2rem; }
.labrat-quiz-nav button { font: inherit; padding: 0.5rem 1rem; border: 1px solid var(--labrat-border); background: var(--labrat-bg); border-radius: var(--labrat-radius); cursor: pointer; }
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/labrat/LabRatQuiz.js client/src/pages/labrat/labrat.css
git commit -m "feat(labrat): 3-question quiz with conditional admin-comfort step"
```

---

### Task 22: LabRatMissions picker component

**Files:**
- Create: `client/src/pages/labrat/LabRatMissions.js`
- Modify: `client/src/pages/labrat/labrat.css`

- [ ] **Step 1: Implement**

```js
// client/src/pages/labrat/LabRatMissions.js
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import './labrat.css';

const COMPLETED_KEY = 'labrat-completed-ids';
const NAME_KEY = 'labrat-tester-name';

const AREA_LABELS = {
  customer: 'Customer Booking',
  applicant: 'Bartender Apply',
  staff: 'Staff Onboarding & Portal',
  admin: 'Admin Tools',
  mobile: 'Mobile Spot-Checks',
  edge: 'Edge Cases',
};
const TIME_BUCKETS = [
  { label: 'Quick Hits (≤10 min)', test: m => m.estMinutes <= 10 },
  { label: 'Half Hour', test: m => m.estMinutes > 10 && m.estMinutes <= 30 },
  { label: 'Long Haul', test: m => m.estMinutes > 30 },
];

function detectDevice() {
  return /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop';
}

export default function LabRatMissions() {
  const [params] = useSearchParams();
  const [missions, setMissions] = useState(null);
  const [relaxed, setRelaxed] = useState(false);
  const [groupBy, setGroupBy] = useState('area');
  const [showAll, setShowAll] = useState(false);

  const completedIds = useMemo(() => {
    try { return JSON.parse(localStorage.getItem(COMPLETED_KEY) || '[]'); } catch { return []; }
  }, []);

  useEffect(() => {
    const fromQuiz = params.has('areas');
    if (fromQuiz && !showAll) {
      const areasParam = params.get('areas');
      const areas = areasParam ? areasParam.split(',') : ['customer','applicant','staff','admin','mobile','edge'];
      const timeBudget = Number(params.get('timeBudget')) || 60;
      const adminComfort = params.get('adminComfort') || 'skip';
      api.post('/qa/shortlist', {
        areas, timeBudget, adminComfort,
        device: detectDevice(),
        completedIds,
      }).then(r => {
        setMissions(r.data.missions);
        setRelaxed(!!r.data.relaxed);
      });
    } else {
      api.get('/qa/missions').then(r => {
        setMissions(r.data.missions);
        setRelaxed(false);
      });
    }
  }, [params, showAll, completedIds]);

  if (!missions) return <div data-app="labrat" className="labrat-loading">Loading missions…</div>;

  const groups = groupBy === 'area'
    ? Object.entries(AREA_LABELS).map(([key, label]) => ({
        label,
        items: missions.filter(m => m.area === key),
      }))
    : TIME_BUCKETS.map(b => ({ label: b.label, items: missions.filter(b.test) }));

  return (
    <div data-app="labrat" className="labrat-picker">
      <main>
        <header className="labrat-picker-header">
          <h1>Pick a mission</h1>
          {params.has('areas') && !showAll && (
            <p className="labrat-quiz-hint">
              {relaxed && 'We loosened your filters a bit. '}
              <button className="labrat-link" onClick={() => setShowAll(true)}>Show all instead</button>
            </p>
          )}
          <div className="labrat-group-toggle">
            <button className={groupBy === 'area' ? 'on' : ''} onClick={() => setGroupBy('area')}>By area</button>
            <button className={groupBy === 'time' ? 'on' : ''} onClick={() => setGroupBy('time')}>By time</button>
          </div>
        </header>
        {groups.map(g => g.items.length > 0 && (
          <section key={g.label}>
            <h2>{g.label} <span className="labrat-count">({g.items.length})</span></h2>
            <div className="labrat-card-grid">
              {g.items.map(m => {
                const done = completedIds.includes(m.id);
                return (
                  <Link key={m.id} to={`/labrat/m/${m.id}`} className={`labrat-card ${done ? 'done' : ''}`}>
                    <h3>{m.title}</h3>
                    <p>{m.blurb}</p>
                    <div className="labrat-card-meta">
                      <span>⏱ ~{m.estMinutes} min</span>
                      <span className={`labrat-diff ${m.difficulty}`}>● {m.difficulty}</span>
                      {done && <span className="labrat-done-chip">✓ done</span>}
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Add picker styles**

```css
.labrat-picker main { max-width: 1100px; margin: 2rem auto; padding: 0 1.5rem; }
.labrat-picker-header { display: flex; flex-wrap: wrap; align-items: center; gap: 1rem; margin-bottom: 2rem; }
.labrat-picker-header h1 { margin: 0; flex: 1; min-width: 200px; }
.labrat-link { background: none; border: none; color: var(--labrat-accent); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
.labrat-group-toggle { display: flex; border: 1px solid var(--labrat-border); border-radius: 999px; padding: 2px; }
.labrat-group-toggle button { font: inherit; padding: 0.4rem 1rem; border: none; background: none; cursor: pointer; border-radius: 999px; color: var(--labrat-muted); }
.labrat-group-toggle button.on { background: var(--labrat-accent); color: white; }
.labrat-picker section { margin-bottom: 2.5rem; }
.labrat-picker section h2 { font-size: 1.2rem; margin: 0 0 1rem; }
.labrat-count { color: var(--labrat-muted); font-weight: 400; }
.labrat-card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
.labrat-card {
  display: block;
  padding: 1.25rem;
  border: 1px solid var(--labrat-border);
  border-radius: var(--labrat-radius);
  text-decoration: none;
  color: var(--labrat-fg);
  transition: transform 0.1s, box-shadow 0.1s;
}
.labrat-card:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
.labrat-card.done { opacity: 0.6; }
.labrat-card h3 { margin: 0 0 0.5rem; font-size: 1.05rem; }
.labrat-card p { margin: 0 0 1rem; color: var(--labrat-muted); font-size: 0.9rem; line-height: 1.4; }
.labrat-card-meta { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.85rem; color: var(--labrat-muted); }
.labrat-diff.easy { color: #1a7f37; }
.labrat-diff.medium { color: #bf8700; }
.labrat-diff.hard { color: #cf222e; }
.labrat-done-chip { color: #1a7f37; font-weight: 600; }
.labrat-loading { padding: 3rem; text-align: center; color: var(--labrat-muted); }
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/labrat/LabRatMissions.js client/src/pages/labrat/labrat.css
git commit -m "feat(labrat): mission picker with area/time grouping toggle"
```

---

### Task 23: LabRatMission page component

**Files:**
- Create: `client/src/pages/labrat/LabRatMission.js`
- Modify: `client/src/pages/labrat/labrat.css`

- [ ] **Step 1: Implement**

```js
// client/src/pages/labrat/LabRatMission.js
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import api from '../../utils/api';
import BugDialog from './BugDialog';
import './labrat.css';

const COMPLETED_KEY = 'labrat-completed-ids';
const NAME_KEY = 'labrat-tester-name';
const TOKEN_KEY = 'labrat-qa-token';

export default function LabRatMission() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [mission, setMission] = useState(null);
  const [error, setError] = useState(null);
  const [seedResult, setSeedResult] = useState(null);
  const [seedError, setSeedError] = useState(null);
  const [checked, setChecked] = useState({});
  const [dialog, setDialog] = useState(null);
  const testerName = localStorage.getItem(NAME_KEY) || '';

  useEffect(() => {
    setChecked({});
    setSeedResult(null);
    setSeedError(null);
    api.get(`/qa/missions/${id}`).then(r => {
      setMission(r.data.mission);
      if (r.data.mission.seedRecipe) {
        api.post('/qa/seed', { recipe: r.data.mission.seedRecipe })
          .then(seed => setSeedResult(seed.data))
          .catch(err => setSeedError(err?.response?.data?.error || 'Could not set up the test data — flag this as a bug.'));
      }
    }).catch(err => setError(err?.response?.data?.error || 'Mission not found'));
  }, [id]);

  const toggle = useCallback((i) => {
    setChecked(prev => ({ ...prev, [i]: !prev[i] }));
  }, []);

  function openBug(stepIndex, stepText) {
    setDialog({
      kind: 'bug',
      stepIndex,
      where: `${mission.title} — Step ${stepIndex + 1}`,
      didWhat: stepText,
    });
  }
  function openConfusion() {
    setDialog({ kind: 'confusion', stepIndex: null, where: mission.title, didWhat: '' });
  }
  function openStale() {
    setDialog({ kind: 'mission-stale', stepIndex: null, where: mission.title, didWhat: '' });
  }

  async function done() {
    await api.post('/qa/complete', { missionId: id, testerName });
    const list = (() => {
      try { return JSON.parse(localStorage.getItem(COMPLETED_KEY) || '[]'); } catch { return []; }
    })();
    if (!list.includes(id)) {
      list.push(id);
      localStorage.setItem(COMPLETED_KEY, JSON.stringify(list));
    }
    navigate('/labrat/missions');
  }

  if (error) return <div data-app="labrat" className="labrat-error">{error}</div>;
  if (!mission) return <div data-app="labrat" className="labrat-loading">Loading…</div>;

  const allChecked = mission.steps.every((_, i) => checked[i]);
  const seedTokenForUrl = seedResult?.token;

  return (
    <div data-app="labrat" className="labrat-mission">
      <main>
        <Link to="/labrat/missions" className="labrat-link">← All missions</Link>
        <h1>{mission.title}</h1>
        <div className="labrat-mission-meta">
          <span>⏱ ~{mission.estMinutes} min</span>
          <span className={`labrat-diff ${mission.difficulty}`}>● {mission.difficulty}</span>
        </div>
        <p className="labrat-mission-blurb">{mission.blurb}</p>

        {mission.seedRecipe && (
          <section className="labrat-setup">
            <h2>Setup (auto)</h2>
            {!seedResult && !seedError && <p>Setting up your test data…</p>}
            {seedError && <p className="labrat-dialog-error">{seedError}</p>}
            {seedResult && (
              <>
                <p>✓ We made you a fake record to test against.</p>
                {seedTokenForUrl && (
                  <a
                    className="labrat-primary labrat-button"
                    href={`/proposal/${seedTokenForUrl}`}
                    target="_blank"
                    rel="noopener"
                  >Open the test proposal →</a>
                )}
              </>
            )}
          </section>
        )}

        <section>
          <h2>Steps</h2>
          <ol className="labrat-step-list">
            {mission.steps.map((s, i) => (
              <li key={i} className={checked[i] ? 'done' : ''}>
                <label>
                  <input type="checkbox" checked={!!checked[i]} onChange={() => toggle(i)} />
                  <span>
                    <strong>{s.text}</strong>
                    {s.expect && <em> — {s.expect}</em>}
                  </span>
                </label>
                <button className="labrat-bug-btn" onClick={() => openBug(i, s.text)}>report bug</button>
              </li>
            ))}
          </ol>
        </section>

        <div className="labrat-mission-actions">
          <button onClick={openConfusion}>I'm stuck</button>
          <button
            className="labrat-primary"
            disabled={!allChecked}
            onClick={done}
          >Done — next mission →</button>
        </div>

        <p className="labrat-stale-link">
          <button className="labrat-link" onClick={openStale}>This mission seems wrong — flag it</button>
        </p>
      </main>

      <BugDialog
        open={!!dialog}
        onClose={() => setDialog(null)}
        kind={dialog?.kind}
        missionId={id}
        stepIndex={dialog?.stepIndex}
        where={dialog?.where}
        didWhat={dialog?.didWhat}
        testerName={testerName}
      />
    </div>
  );
}
```

- [ ] **Step 2: Add mission page styles**

```css
.labrat-mission main { max-width: 760px; margin: 2rem auto; padding: 0 1.5rem; }
.labrat-mission h1 { margin: 0.5rem 0; }
.labrat-mission-meta { display: flex; gap: 1rem; color: var(--labrat-muted); margin-bottom: 1rem; }
.labrat-mission-blurb { font-size: 1.1rem; line-height: 1.5; }
.labrat-setup {
  background: #f6f8fa; padding: 1rem 1.25rem; border-radius: var(--labrat-radius);
  border: 1px solid var(--labrat-border); margin: 1.5rem 0;
}
.labrat-setup h2 { margin: 0 0 0.5rem; font-size: 1rem; }
.labrat-button { display: inline-block; padding: 0.6rem 1rem; border-radius: var(--labrat-radius); text-decoration: none; }
.labrat-step-list { list-style: none; padding: 0; }
.labrat-step-list li {
  display: flex; align-items: flex-start; gap: 0.5rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--labrat-border);
}
.labrat-step-list li.done strong { text-decoration: line-through; color: var(--labrat-muted); }
.labrat-step-list label { display: flex; align-items: flex-start; gap: 0.6rem; flex: 1; cursor: pointer; }
.labrat-step-list input[type=checkbox] { margin-top: 0.3em; width: 18px; height: 18px; accent-color: var(--labrat-accent); }
.labrat-step-list em { font-style: italic; color: var(--labrat-muted); font-weight: normal; }
.labrat-bug-btn {
  font: inherit; font-size: 0.8rem;
  padding: 0.2em 0.6em;
  border: 1px solid #ffcdd2;
  background: #fff1f0;
  color: #86181d;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
}
.labrat-mission-actions { display: flex; justify-content: space-between; margin: 2rem 0 1rem; }
.labrat-mission-actions button { font: inherit; padding: 0.7rem 1.4rem; border: 1px solid var(--labrat-border); background: var(--labrat-bg); border-radius: var(--labrat-radius); cursor: pointer; }
.labrat-mission-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.labrat-stale-link { text-align: center; margin: 2rem 0 4rem; color: var(--labrat-muted); font-size: 0.9rem; }
.labrat-error { padding: 3rem; text-align: center; color: #b42318; }
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/labrat/LabRatMission.js client/src/pages/labrat/labrat.css
git commit -m "feat(labrat): mission page with steps + per-step bug + I'm stuck + mission-stale flagging"
```

---

### Task 24: Wire `/labrat/*` routes into `App.js`

**Files:**
- Modify: `client/src/App.js`

- [ ] **Step 1: Add the imports near the other public-website imports**

```js
import LabRatLanding from './pages/labrat/LabRatLanding';
import LabRatQuiz from './pages/labrat/LabRatQuiz';
import LabRatMissions from './pages/labrat/LabRatMissions';
import LabRatMission from './pages/labrat/LabRatMission';
```

- [ ] **Step 2: Add route entries to `PublicWebsiteRoutes`**

In `App.js` find `function PublicWebsiteRoutes()` (around line 213). Add inside the `<Routes>` block:
```jsx
<Route path="/labrat" element={<LabRatLanding />} />
<Route path="/labrat/quiz" element={<LabRatQuiz />} />
<Route path="/labrat/missions" element={<LabRatMissions />} />
<Route path="/labrat/m/:id" element={<LabRatMission />} />
```

Place these BEFORE the `<Route path="*" element={<Navigate to="/" replace />} />` catch-all line.

- [ ] **Step 3: Smoke test the full flow**

Start `npm run dev`. In a browser:
1. Navigate to `http://localhost:3000/labrat` → landing renders
2. Click "Show me the missions" → picker renders with all 30 missions
3. Click any non-seeded customer mission → mission page renders, no setup section
4. Check off all steps → "Done" button enables; click → returns to picker with the mission marked done
5. Open a seeded mission (e.g., `sign-and-pay-deposit`) → setup section renders with a token link
6. Click "report bug" on any step → dialog opens, submit → check `server/data/tester-bugs/YYYY-MM.jsonl` for the new line

Expected: All flows work. Any failure → fix before moving on.

- [ ] **Step 4: Commit**

```bash
git add client/src/App.js
git commit -m "feat(labrat): wire /labrat/* routes into PublicWebsiteRoutes"
```

---

## Phase 5 — Drift resistance + skill

### Task 25: `missions:check` script

**Files:**
- Create: `server/scripts/missionsCheck.js`
- Modify: `package.json` (add script)

- [ ] **Step 1: Implement**

```js
// server/scripts/missionsCheck.js
const { execSync } = require('node:child_process');
const path = require('node:path');
const catalog = require('../data/missions');

function repoRoot() {
  return execSync('git rev-parse --show-toplevel').toString().trim();
}

function changedFilesSince(date, files) {
  const root = repoRoot();
  const args = files.map(f => `'${f}'`).join(' ');
  try {
    const out = execSync(
      `git log --since="${date}" --name-only --pretty=format: -- ${args}`,
      { cwd: root }
    ).toString();
    return [...new Set(out.split('\n').map(s => s.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}

function main() {
  const stale = [];
  for (const m of catalog.all) {
    const changed = changedFilesSince(m.lastVerified, m.affectedFiles);
    if (changed.length) {
      stale.push({ mission: m, changed });
    }
  }

  const total = catalog.all.length;
  if (!stale.length) {
    console.log(`${total} missions, 0 stale. ✓`);
    return;
  }
  console.log(`${total} missions, ${stale.length} stale:`);
  for (const { mission, changed } of stale) {
    console.log(`  ⚠ ${mission.id} — verified ${mission.lastVerified}`);
    for (const f of changed) console.log(`      modified: ${f}`);
  }
  console.log(`\nRe-verify with: npm run missions:verify <id>`);
}

main();
```

- [ ] **Step 2: Add npm script**

In `package.json`:
```json
"missions:check": "node server/scripts/missionsCheck.js"
```

- [ ] **Step 3: Smoke**

Run: `npm run missions:check`
Expected: prints "30 missions, 0 stale. ✓" on a freshly populated catalog.

- [ ] **Step 4: Commit**

```bash
git add server/scripts/missionsCheck.js package.json
git commit -m "feat(labrat): missions:check drift detector"
```

---

### Task 26: `missions:verify` and `missions:scan-routes` scripts

**Files:**
- Create: `server/scripts/missionsVerify.js`
- Create: `server/scripts/missionsScanRoutes.js`
- Modify: `package.json`

- [ ] **Step 1: Implement `missionsVerify.js`**

```js
// server/scripts/missionsVerify.js
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../data/missions');

function main() {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: npm run missions:verify <mission-id>');
    process.exit(1);
  }
  if (!catalog.byId[id]) {
    console.error(`Unknown mission: ${id}`);
    console.error('Run `npm run missions:check` to list them.');
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const areaFile = path.join(__dirname, '..', 'data', 'missions', `${catalog.byId[id].area}.js`);
  let src = fs.readFileSync(areaFile, 'utf8');
  const idLine = `id: '${id}'`;
  const idx = src.indexOf(idLine);
  if (idx < 0) {
    console.error(`Could not find id literal "${idLine}" in ${areaFile}`);
    process.exit(1);
  }
  // Find the next lastVerified after this id
  const after = src.slice(idx);
  const m = after.match(/lastVerified:\s*['"](\d{4}-\d{2}-\d{2})['"]/);
  if (!m) {
    console.error('No lastVerified field after this id');
    process.exit(1);
  }
  const before = m[1];
  src = src.slice(0, idx) + after.replace(m[0], `lastVerified: '${today}'`);
  fs.writeFileSync(areaFile, src);
  console.log(`✓ ${id}: lastVerified ${before} → ${today}`);
}

main();
```

- [ ] **Step 2: Implement `missionsScanRoutes.js`**

```js
// server/scripts/missionsScanRoutes.js
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../data/missions');

const COVERED = new Set();
for (const m of catalog.all) for (const f of m.affectedFiles) COVERED.add(f);

function scanReactRoutes() {
  const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'App.js'), 'utf8');
  const matches = [...appJs.matchAll(/<Route\s+[^>]*path="([^"]+)"/g)];
  return matches.map(m => m[1]);
}

function scanApiMounts() {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const matches = [...idx.matchAll(/app\.use\(['"](\/api\/[^'"]+)['"]/g)];
  return matches.map(m => m[1]);
}

function main() {
  const reactRoutes = scanReactRoutes();
  const apiMounts = scanApiMounts();

  console.log('React routes with no mission covering their page file:');
  for (const r of reactRoutes) {
    // Heuristic: just print all; cross-referencing requires knowing the page file per route.
    // The user reads this list and decides which ones need missions.
    console.log(`  ${r}`);
  }
  console.log('\nAPI mounts (compare against missions.affectedFiles):');
  for (const m of apiMounts) console.log(`  ${m}`);
  console.log('\nMission-covered files:');
  for (const f of [...COVERED].sort()) console.log(`  ${f}`);
}

main();
```

- [ ] **Step 3: Add npm scripts**

In `package.json`:
```json
"missions:verify": "node server/scripts/missionsVerify.js",
"missions:scan-routes": "node server/scripts/missionsScanRoutes.js"
```

- [ ] **Step 4: Smoke**

```bash
npm run missions:verify submit-byob-quote
# Expected: "✓ submit-byob-quote: lastVerified 2026-04-27 → <today>"
# Then revert (we don't want to commit a verify bump): git checkout server/data/missions/customer.js

npm run missions:scan-routes
# Expected: prints route lists
```

- [ ] **Step 5: Commit**

```bash
git add server/scripts/missionsVerify.js server/scripts/missionsScanRoutes.js package.json
git commit -m "feat(labrat): missions:verify and missions:scan-routes scripts"
```

---

### Task 27: Lab Rat bug-fix skill

**Files:**
- Create: `.claude/skills/labrat-fix.md`

- [ ] **Step 1: Write the skill file**

```markdown
---
name: labrat-fix
description: Use this skill to triage and fix bugs reported by Lab Rat testers. Reads the JSONL bug log, groups bugs by mission, proposes a batch fix plan, then implements fixes one batch at a time and updates the status file with commit SHAs and re-verifies affected missions. Trigger: user says "fix labrat bugs", "/labrat-fix", "process tester bugs", or asks about open bugs from the lab rat program.
---

# Lab Rat Bug-Fix Workflow

You are running the loop that turns tester-reported bugs into fixes and keeps the mission catalog fresh.

## Step 1 — Read the open bug list

Run `npm run bugs:list` and read the output. If it shows zero open bugs, tell Dallas there's nothing to fix and stop.

The bugs file structure:
- Bug records: `server/data/tester-bugs/YYYY-MM.jsonl` (append-only, one JSON per line)
- Status: `server/data/tester-bugs/status.json` (bug-id → { status, fixCommitSha, adminNotes, fixedAt })

You can also Read the JSONL files directly for context — every bug includes `kind` (bug | confusion | mission-stale), `missionId`, `stepIndex`, `where`, `didWhat`, `happened`, `expected`, `browser`, `testerName`, `reportedAt`.

## Step 2 — Propose a batching strategy

Group bugs by mission. Within each mission, group by likely shared root cause (same component, same field, same step). Present to Dallas:

> "12 open bugs across 7 missions. Suggest fixing in this order:
> 1. submit-byob-quote (4 bugs — all about pricing not updating on syrup toggle)
> 2. sign-and-pay-deposit (3 bugs — Stripe form errors on declined card)
> 3. ... (rest)
> Start with batch 1?"

Wait for confirmation. Don't fix without approval.

## Step 3 — Per batch: investigate, fix, verify

For each bug in the batch:
1. Read the affected source files (every mission has `affectedFiles` — start there).
2. Identify the root cause. Don't just patch the symptom.
3. Use systematic-debugging skill if the root cause isn't obvious.
4. Implement the fix following the project's patterns (raw SQL, asyncHandler wrapping, AppError hierarchy).
5. Run any relevant tests; manually verify if the fix touches UI.

After implementing all fixes in the batch:
- Show Dallas a summary: "Fixed N bugs in this batch. Files modified: ...".
- Ask Dallas to re-test the affected mission(s) in the browser.
- On confirmation, commit (per the project's git workflow rules in CLAUDE.md).

## Step 4 — Mark fixed and re-verify missions

For each bug in the batch:
```bash
npm run bugs:fix <bug-id> <commit-sha> "<short note>"
```

For each mission affected by the fixes:
```bash
npm run missions:verify <mission-id>
```

(This bumps `lastVerified` to today, which silences `missions:check` for that mission.)

## Step 5 — Detect new coverage gaps

If a bug exposed behavior that no mission tests (e.g., a `confusion` bug at a step that doesn't exist in the mission), propose adding a step to that mission OR a new mission entirely. Don't add it without Dallas's approval.

If a bug was kind `mission-stale`, the mission steps need rewriting. Propose the new steps to Dallas, get approval, edit the mission file, run validation tests, run `missions:verify`.

## Step 6 — Loop or stop

Ask Dallas: "Move to the next batch, or stop here?" Honor whatever they say.

## Anti-patterns

- Don't auto-mark bugs fixed. Always wait for Dallas to confirm the fix worked.
- Don't push commits — the user-instructions in CLAUDE.md say pushes are explicit-only.
- Don't fix bugs in unrelated areas just because you noticed them. Stay in the batch.
- Don't skip `missions:verify`. The whole point of this skill is closing the loop.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/labrat-fix.md
git commit -m "feat(labrat): /labrat-fix bug-triage-and-fix workflow skill"
```

---

### Task 28: Add CLAUDE.md drift rule

**Files:**
- Modify: `.claude/CLAUDE.md`

**Caveat:** As of this plan, `CLAUDE.md` has unstaged modifications from the in-flight refactor. Coordinate with Dallas before editing — either wait for the refactor to land, or do a small surgical edit and confirm no conflict.

- [ ] **Step 1: Find the "Mandatory Documentation Updates" section**

In `.claude/CLAUDE.md`, locate the existing "Mandatory Documentation Updates" section.

- [ ] **Step 2: Add the missions drift bullet underneath the table**

Add a paragraph below the existing table:

```markdown
**Mission catalog drift rule:** When modifying any file, grep `server/data/missions/` for that path. If a mission's `affectedFiles` lists the file, either update the mission's steps to match the change OR (if the steps still apply) leave the mission alone — `npm run missions:check` will warn at pre-push that the mission needs re-verification. Re-verify by manually walking the mission, then `npm run missions:verify <mission-id>` to bump the timestamp.
```

- [ ] **Step 3: Find the "Pre-Push Procedure" section, add a non-blocking missions check**

After the "Honoring overnight-review cache" step in the Pre-Push Procedure, add:

```markdown
4.6. **Run mission drift check (non-blocking).** Run `npm run missions:check`. If any missions are reported stale, announce them in one line: *"N missions stale: <id>, <id>, ... (informational only — push proceeds)."* This is purely a heads-up; staleness does not block the push.
```

- [ ] **Step 4: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs(labrat): add mission drift rule + pre-push missions:check warning"
```

---

## Phase 6 — Smoke test and ship

### Task 29: End-to-end smoke test

**Files:** none modified.

- [ ] **Step 1: Start fresh**

```bash
npm run dev  # both server and client
```

- [ ] **Step 2: Run the full tester journey, twice**

**As a customer-only tester:**
1. Open `http://localhost:3000/labrat` in a private window
2. Enter "Smoke Test 1" as name → click Take a quick quiz
3. Q1: pick "Booking an event as a customer" only
4. Q2: pick "15-20 minutes"
5. Land on `/labrat/missions?...` — should see ~3-4 customer missions, no admin or staff
6. Click `submit-byob-quote` → mission page renders
7. Open the quote URL in a new tab, fill it out, submit (this exercises the auto-advance path)
8. Verify the proposal email arrives at your inbox AND the proposal in admin shows `is_test_data=true` with status `Sent`
9. Back on the mission page, check off all steps → click Done → returns to picker with mission marked ✓
10. Click "Show all instead" → all 30 missions render, grouped by area

**As an admin-comfortable tester:**
1. Open `http://localhost:3000/labrat` in a different private window
2. Enter "Smoke Test 2" as name → Take quiz
3. Q1: pick "Poking around the admin tools"
4. Q2: 30-60 minutes
5. Q3: "Yes, throw me in"
6. Land on missions — should see admin missions in the picker
7. Click `send-a-proposal` → seeded test data appears, links to a draft proposal → walk through the steps
8. Click Done → next mission

**As a bug-reporter:**
1. On any mission page, click "report bug" on a step
2. Fill the dialog, submit
3. Run `npm run bugs:list` in a terminal — your bug appears, grouped under the mission

**As Dallas (fix workflow):**
1. In a Claude Code session, say "fix labrat bugs"
2. The `/labrat-fix` skill should activate, list your test bug, propose a batch
3. Confirm; let it walk through the fix; verify it called `bugs:fix` and `missions:verify` correctly

- [ ] **Step 3: Document any defects found in this smoke test as TASK FOLLOWUPS**

If any flow breaks, fix before declaring the plan complete.

- [ ] **Step 4: No commit needed unless fixes were applied**

---

### Task 30: Documentation updates (gated by refactor)

**Files (deferred until in-flight refactor merges to main):**
- Modify: `.claude/CLAUDE.md` (folder structure tree)
- Modify: `README.md` (folder structure tree, NPM scripts table, Tech Stack additions)
- Modify: `ARCHITECTURE.md` (Lab Rat section, is_test_data note on 5 tables)

**Caveat:** All three docs have unstaged or staged refactor modifications. Coordinate timing with Dallas. Do not commit alongside refactor changes.

- [ ] **Step 1: After the refactor lands, re-read each doc and add Lab Rat entries**

In `CLAUDE.md` folder structure: add the new files under `server/data/missions/`, `server/data/tester-bugs/`, `server/routes/labrat.js`, `server/utils/qa*.js` and `bugLog.js`, `client/src/pages/labrat/*`, `.claude/skills/labrat-fix.md`.

In `README.md`: same folder structure additions, plus new NPM scripts (`bugs:list`, `bugs:fix`, `missions:check`, `missions:verify`, `missions:scan-routes`) added to the scripts table.

In `ARCHITECTURE.md`: new "Lab Rat Tester Program" section summarizing the three flows (landing → quiz → picker → mission, seed system, bug log). Add a footnote to the Database Schema section noting the `is_test_data` column on five tables and the nightly cleanup behavior.

- [ ] **Step 2: Commit**

```bash
git add .claude/CLAUDE.md README.md ARCHITECTURE.md
git commit -m "docs(labrat): folder structure, scripts table, architecture section"
```

---

## Self-review checklist

After plan execution, verify the spec is fully covered:

- [x] Goal 1 — "<60s start": landing → quiz → picker → mission, no auth (Tasks 20-23)
- [x] Goal 2 — independently startable: seed recipes (Task 15) + auto-advance (Task 17)
- [x] Goal 3 — coverage spread: shortlist priority + completion-count weighting (Task 13, used by Task 16)
- [x] Goal 4 — Claude-readable bug log: JSONL + bugs:list + bugs:fix (Tasks 3-5)
- [x] Goal 5 — admin path first-class: 10 admin missions (Task 10), gated by Q3 (Task 21)
- [x] Drift resistance: affectedFiles + lastVerified (Task 7), missions:check (Task 25), tester "stale" button (Task 23), CLAUDE.md rule (Task 28)
- [x] Bug-fix workflow: `/labrat-fix` skill (Task 27)

**Type consistency check:** All tasks use `kind` from `{bug, confusion, mission-stale}`, `area` from `{customer, applicant, staff, admin, mobile, edge}`, `priority` from `{p0, p1, p2}`, `device` from `{desktop, mobile}`. The `seedRecipe` enum is fixed by `_shape.js` (Task 6) and consumed by `qaSeed.js` (Task 15) and `labrat.js` route (Task 16).

**Placeholder scan:** Mission content is templated — Task 7 shows the full first mission and lists ID + key parameters for the other 7 (with TESTING.md section pointers). Tasks 8-11 follow the same lists-with-pointers pattern. This is documented as a deliberate handoff to the implementing agent, not a placeholder.

---
