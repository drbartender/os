# Lab Rat Tune-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Lab Rat mission stats to Postgres, drop unused `testerEmail`/`screenshotUrl` fields, add pre-hire onboarding missions, sweep mission-catalog drift, and backfill test coverage on `shortlist` + `bugLog`.

**Architecture:** Four logical commits on `main`, one push at the end, one agent-review pass. Each commit carries its own doc updates so `npm test` stays green at every commit boundary.

**Tech Stack:** Node.js 18, Express 4.18, PostgreSQL via raw `pool.query`, `bcryptjs` (already a dep), Jest.

**Spec:** `docs/superpowers/specs/2026-05-14-labrat-tune-up-design.md`

**Refinements from spec:**
- `missionStats.test.js` rewrite lives in commit 1 (paired with the impl rewrite for TDD discipline + green tests at every commit boundary), not commit 4 as the spec originally listed.
- `shortlist.test.js` already exists with 8 tests; commit 4 EXTENDS it rather than creating new.

---

## Commit 1 — `mission_completions` Postgres migration

### Task 1.1: Add `mission_completions` table to schema

**Files:**
- Modify: `server/db/schema.sql` (append at the very bottom)

- [ ] **Step 1: Append the table block**

Open `server/db/schema.sql` and append at the very end:

```sql
-- ─── Lab Rat mission completion log (Postgres-persistent, 2026-05-14) ──
-- Replaces the prior filesystem JSONL store at
-- server/data/mission-completions.jsonl which was wiped on every Render
-- deploy. Same fix as tester_bugs (2026-05-10). The shortlist algorithm
-- in server/utils/shortlist.js reads from here to detect p0 saturation
-- and to favor least-completed missions when sorting within a tier.
CREATE TABLE IF NOT EXISTS mission_completions (
  id BIGSERIAL PRIMARY KEY,
  mission_id TEXT NOT NULL,
  tester_name TEXT,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mission_completions_mission_id
  ON mission_completions(mission_id);
```

- [ ] **Step 2: Apply the schema locally**

Run: `node -e "require('./server/db').initDb().then(() => process.exit(0))"`
Expected: Process exits 0 with no errors.

- [ ] **Step 3: Verify the table exists**

Run: `node -e "require('./server/db').pool.query(\"SELECT to_regclass('mission_completions')\").then(r => { console.log(r.rows[0]); process.exit(0) })"`
Expected: `{ to_regclass: 'mission_completions' }`

### Task 1.2: Rewrite `missionStats.test.js` to expect Postgres behavior (failing first)

**Files:**
- Modify: `server/utils/missionStats.test.js` (replace entire file)

- [ ] **Step 1: Replace the file content**

```js
const { pool } = require('../db');
const { logCompletion, getCompletionCounts } = require('./missionStats');

describe('missionStats (Postgres)', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM mission_completions WHERE mission_id LIKE 'test-%'");
  });
  afterAll(async () => {
    await pool.query("DELETE FROM mission_completions WHERE mission_id LIKE 'test-%'");
    await pool.end();
  });

  test('counts completions per mission id', async () => {
    await logCompletion('test-a', 'tester1');
    await logCompletion('test-a', 'tester2');
    await logCompletion('test-b', 'tester1');
    const counts = await getCompletionCounts();
    expect(counts['test-a']).toBe(2);
    expect(counts['test-b']).toBe(1);
  });

  test('returns empty object (modulo test- rows) when no rows', async () => {
    const counts = await getCompletionCounts();
    const filtered = Object.fromEntries(
      Object.entries(counts).filter(([k]) => k.startsWith('test-'))
    );
    expect(filtered).toEqual({});
  });

  test('stores tester_name as null when omitted', async () => {
    await logCompletion('test-c');
    const { rows } = await pool.query(
      "SELECT tester_name FROM mission_completions WHERE mission_id = 'test-c'"
    );
    expect(rows[0].tester_name).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it FAILS**

Run: `npx jest server/utils/missionStats.test.js`
Expected: FAIL — the current `missionStats.js` still writes JSONL; assertions on `counts['test-a']` will fail or the test will reference `fs` errors.

### Task 1.3: Rewrite `missionStats.js` to use Postgres

**Files:**
- Modify: `server/utils/missionStats.js` (replace entire file)

- [ ] **Step 1: Replace the file content**

```js
const { pool } = require('../db');

async function logCompletion(missionId, testerName) {
  await pool.query(
    'INSERT INTO mission_completions (mission_id, tester_name) VALUES ($1, $2)',
    [missionId, testerName || null],
  );
}

async function getCompletionCounts() {
  const { rows } = await pool.query(
    'SELECT mission_id, COUNT(*)::int AS count FROM mission_completions GROUP BY mission_id',
  );
  const counts = {};
  for (const r of rows) counts[r.mission_id] = r.count;
  return counts;
}

module.exports = { logCompletion, getCompletionCounts };
```

- [ ] **Step 2: Run the test to verify it PASSES**

Run: `npx jest server/utils/missionStats.test.js`
Expected: PASS — 3/3 tests green.

### Task 1.4: Remove `.gitignore` entry and delete the local JSONL

**Files:**
- Modify: `.gitignore`
- Delete (filesystem only — file is gitignored, untracked): `server/data/mission-completions.jsonl`

- [ ] **Step 1: Open `.gitignore` and delete these three lines**

Around line 25:

```
# Lab Rat runtime data — mission completions are still filesystem-based
# (tester bugs moved to the `tester_bugs` Postgres table 2026-05-10).
server/data/mission-completions.jsonl
```

- [ ] **Step 2: Delete the local JSONL file**

Run: `rm server/data/mission-completions.jsonl`
Expected: File removed; no errors (or "no such file" if already absent — that's fine).

### Task 1.5: Update `ARCHITECTURE.md`

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Find the `tester_bugs` section**

Search for `**tester_bugs**` (around line 699). Locate the end of that block (just before the `**admin_audit_log**` section, around line 713).

- [ ] **Step 2: Insert a new `mission_completions` block immediately after the `tester_bugs` block, before `admin_audit_log`**

```markdown
**mission_completions** — Lab Rat mission completion log (replaces the prior filesystem JSONL store, which was wiped on every Render deploy — same fix pattern as `tester_bugs` from 2026-05-10)
- `id` BIGSERIAL PK
- `mission_id` TEXT NOT NULL
- `tester_name` TEXT — optional
- `completed_at` TIMESTAMPTZ DEFAULT NOW()
- Index `idx_mission_completions_mission_id` supports the shortlist's `GROUP BY mission_id COUNT(*)` aggregation
- Insert path: `POST /api/qa/complete` → `missionStats.logCompletion` → INSERT
- Read path: `POST /api/qa/shortlist` → `missionStats.getCompletionCounts`

```

### Task 1.6: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add server/db/schema.sql server/utils/missionStats.js server/utils/missionStats.test.js .gitignore ARCHITECTURE.md
git commit -m "feat(labrat): mission_completions Postgres table + Postgres-backed stats"
```

Expected: Commit lands. Pre-commit hooks pass (file-size, lint-staged).

---

## Commit 2 — Drop unused `tester_email` + `screenshot_url`

### Task 2.1: Verify the columns are empty in dev DB

**Files:** none (read-only DB query)

- [ ] **Step 1: Run the count query**

Run: `node -e "require('./server/db').pool.query('SELECT COUNT(*) AS n FROM tester_bugs WHERE tester_email IS NOT NULL OR screenshot_url IS NOT NULL').then(r => { console.log(r.rows[0]); process.exit(0) })"`
Expected: `{ n: '0' }`

If `n > 0`: STOP. Run `SELECT id, tester_email, screenshot_url FROM tester_bugs WHERE tester_email IS NOT NULL OR screenshot_url IS NOT NULL LIMIT 5` to inspect, then consult before proceeding. Production may have legacy rows that need preserving.

### Task 2.2: Add `DROP COLUMN` statements to `schema.sql`

**Files:**
- Modify: `server/db/schema.sql` (append at the very bottom, below the `mission_completions` block)

- [ ] **Step 1: Append**

```sql
-- ─── Lab Rat tester_bugs: drop unused contact fields (2026-05-14) ──
-- The BugDialog UI never collected tester_email or screenshot_url; the
-- backend validation and admin-viewer rendering were defending an unused
-- attack surface. Confirmed empty before drop. Triage workflow is admin
-- UI + Claude session, not email reply.
ALTER TABLE tester_bugs DROP COLUMN IF EXISTS tester_email;
ALTER TABLE tester_bugs DROP COLUMN IF EXISTS screenshot_url;
```

- [ ] **Step 2: Apply locally**

Run: `node -e "require('./server/db').initDb().then(() => process.exit(0))"`
Expected: Process exits 0.

- [ ] **Step 3: Verify columns are gone**

Run: `node -e "require('./server/db').pool.query(\"SELECT column_name FROM information_schema.columns WHERE table_name = 'tester_bugs'\").then(r => { console.log(r.rows.map(x => x.column_name)); process.exit(0) })"`
Expected: list does NOT contain `tester_email` or `screenshot_url`.

### Task 2.3: Drop fields from `bugLog.js`

**Files:**
- Modify: `server/utils/bugLog.js`

- [ ] **Step 1: Update the `appendBug` INSERT**

Find the current INSERT:

```js
await pool.query(
    `INSERT INTO tester_bugs (
      id, kind, mission_id, step_index, tester_name, tester_email,
      where_at, did_what, happened, expected, browser, screenshot_url
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      input.kind,
      input.missionId || null,
      stepIndex,
      clip(input.testerName, 120),
      clip(input.testerEmail, 200),
      clip(input.where, 1000),
      clip(input.didWhat, 5000),
      clip(input.happened, 5000),
      clip(input.expected, 5000),
      clip(input.browser, 500),
      clip(input.screenshotUrl, 1000),
    ],
  );
```

Replace with:

```js
await pool.query(
    `INSERT INTO tester_bugs (
      id, kind, mission_id, step_index, tester_name,
      where_at, did_what, happened, expected, browser
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      input.kind,
      input.missionId || null,
      stepIndex,
      clip(input.testerName, 120),
      clip(input.where, 1000),
      clip(input.didWhat, 5000),
      clip(input.happened, 5000),
      clip(input.expected, 5000),
      clip(input.browser, 500),
    ],
  );
```

- [ ] **Step 2: Update `rowToBug` — drop two lines**

Find:

```js
function rowToBug(row) {
  return {
    id: row.id,
    kind: row.kind,
    missionId: row.mission_id,
    stepIndex: row.step_index,
    testerName: row.tester_name,
    testerEmail: row.tester_email,
    where: row.where_at,
    didWhat: row.did_what,
    happened: row.happened,
    expected: row.expected,
    browser: row.browser,
    screenshotUrl: row.screenshot_url,
    reportedAt: row.reported_at instanceof Date ? row.reported_at.toISOString() : row.reported_at,
    ...
```

Delete the `testerEmail` line and the `screenshotUrl` line. Resulting block:

```js
function rowToBug(row) {
  return {
    id: row.id,
    kind: row.kind,
    missionId: row.mission_id,
    stepIndex: row.step_index,
    testerName: row.tester_name,
    where: row.where_at,
    didWhat: row.did_what,
    happened: row.happened,
    expected: row.expected,
    browser: row.browser,
    reportedAt: row.reported_at instanceof Date ? row.reported_at.toISOString() : row.reported_at,
    ...
```

### Task 2.4: Drop validation from `testFeedback.js`

**Files:**
- Modify: `server/routes/testFeedback.js` (entire file rewrite for clarity)

- [ ] **Step 1: Replace the entire file**

```js
// server/routes/testFeedback.js
const express = require('express');
const Sentry = require('@sentry/node');
const asyncHandler = require('../middleware/asyncHandler');
const { labratFeedbackLimiter } = require('../middleware/rateLimiters');
const { ValidationError } = require('../utils/errors');
const { appendBug } = require('../utils/bugLog');
const { sendEmail } = require('../utils/email');
const { labratBugReportAdmin } = require('../utils/emailTemplates');

const router = express.Router();
const ALLOWED_KINDS = ['bug', 'confusion', 'mission-stale'];

router.post('/', labratFeedbackLimiter, asyncHandler(async (req, res) => {
  const body = req.body || {};
  const { missionId, stepIndex, testerName, expected, browser } = body;
  let { kind, where, didWhat, happened } = body;

  // Back-compat shim for the legacy /testing-guide.html which posts the old
  // shape: { testerName, progressSummary, bugCount, reportText }.
  if (!kind && req.body && typeof req.body.reportText === 'string') {
    kind = 'bug';
    happened = req.body.reportText;
    didWhat = req.body.progressSummary || '';
    where = 'Legacy /testing-guide.html submission';
  }

  const errs = {};
  if (!ALLOWED_KINDS.includes(kind)) errs.kind = `must be one of ${ALLOWED_KINDS.join(', ')}`;
  if (kind === 'bug' && (!happened || !happened.trim())) errs.happened = 'Tell us what happened';
  if (Object.keys(errs).length) throw new ValidationError(errs, 'Invalid feedback');

  const { id } = await appendBug({
    kind, missionId: missionId || null, stepIndex,
    testerName, where, didWhat, happened, expected, browser,
  });

  // Best-effort admin email — fire-and-forget so we don't block the tester's
  // "Sent ✓" toast on Resend's 200-1000ms round-trip. Bug is already in
  // tester_bugs; the email is a notification redundancy.
  const tpl = labratBugReportAdmin({
    bugId: id, kind, missionId: missionId || null, stepIndex,
    testerName, where, didWhat, happened, expected,
    browser, reportedAt: new Date().toISOString(),
  });
  sendEmail({
    to: process.env.ADMIN_FEEDBACK_NOTIFICATION_EMAIL || 'contact@drbartender.com',
    subject: tpl.subject,
    html: tpl.html,
    text: tpl.text,
  }).catch((err) => {
    console.error('[labrat] bug-report admin email failed', err.message);
    Sentry.captureException(err, {
      tags: { route: 'testFeedback.post', op: 'admin_email' },
      extra: { bugId: id, kind, missionId: missionId || null },
    });
  });

  res.json({ ok: true, id });
}));

module.exports = router;
```

### Task 2.5: Drop fields from `labratBugReportAdmin` email template

**Files:**
- Modify: `server/utils/emailTemplates.js`

- [ ] **Step 1: Read the current `labratBugReportAdmin` function**

Run: `grep -n -A 60 'function labratBugReportAdmin' server/utils/emailTemplates.js`

Identify every reference to `testerEmail` and `screenshotUrl` in the function body and parameter destructure.

- [ ] **Step 2: Remove `testerEmail` and `screenshotUrl` from the destructured parameter list**

The current signature (around line 558):

```js
function labratBugReportAdmin({ bugId, kind, missionId, stepIndex, testerName, testerEmail, where, didWhat, happened, expected, browser, screenshotUrl, reportedAt }) {
```

Becomes:

```js
function labratBugReportAdmin({ bugId, kind, missionId, stepIndex, testerName, where, didWhat, happened, expected, browser, reportedAt }) {
```

- [ ] **Step 3: Remove every occurrence of `testerEmail` and `screenshotUrl` in the HTML body string and text body string inside the function**

Search the function body for these tokens and delete the rows/lines that render them. Each occurrence likely sits inside template-literal blocks. After this step, neither identifier appears anywhere in the function.

### Task 2.6: Drop render blocks from `LabRatBugsPage.js`

**Files:**
- Modify: `client/src/pages/admin/LabRatBugsPage.js`

- [ ] **Step 1: Delete the screenshot URL render block**

Find lines 182-187 (the `{b.screenshotUrl && ...}` JSX block) and delete them entirely:

```jsx
{b.screenshotUrl && /^https?:\/\//i.test(b.screenshotUrl) && (
  <p style={{ margin: '0 0 8px' }}>
    <strong className="muted tiny">Screenshot</strong><br />
    <a href={b.screenshotUrl} target="_blank" rel="noopener noreferrer">{b.screenshotUrl}</a>
  </p>
)}
```

- [ ] **Step 2: Delete the tester-email mailto block**

Find lines 188-192 (the `{b.testerEmail && ...}` JSX block) and delete:

```jsx
{b.testerEmail && (
  <p className="muted tiny" style={{ margin: '8px 0 0' }}>
    Tester contact: <a href={`mailto:${encodeURIComponent(b.testerEmail)}`}>{b.testerEmail}</a>
  </p>
)}
```

### Task 2.7: Remove env-var row from CLAUDE.md

**Files:**
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Find the row for `LABRAT_SCREENSHOT_ALLOWED_HOSTS`**

Search the Environment Variables table for `LABRAT_SCREENSHOT_ALLOWED_HOSTS`. It's a single row.

- [ ] **Step 2: Delete that row**

Delete the entire line. No other lines need touching.

### Task 2.8: Update `ARCHITECTURE.md` tester_bugs bullets

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Find the `tester_bugs` section (around line 699)**

- [ ] **Step 2: Remove the `tester_email` reference and `screenshot_url` reference**

Current bullet around line 703:
```
- `tester_name`, `tester_email` — optional contact (testers are unauthenticated)
```
Becomes:
```
- `tester_name` — optional contact (testers are unauthenticated)
```

Current bullet around line 704:
```
- `where_at`, `did_what`, `happened`, `expected`, `browser`, `screenshot_url` — captured form fields (server-side length caps in `bugLog.appendBug`)
```
Becomes:
```
- `where_at`, `did_what`, `happened`, `expected`, `browser` — captured form fields (server-side length caps in `bugLog.appendBug`)
```

### Task 2.9: Manual smoke test

**Files:** none (manual browser verification)

- [ ] **Step 1: Restart dev server**

Run: `npm run dev`

- [ ] **Step 2: Submit a bug via the Lab Rat flow**

In a browser:
1. Navigate to `http://localhost:3000/labrat`
2. Click "Show me the missions"
3. Open any mission
4. Click "report bug" on any step
5. Fill in "What happened" and submit
6. Expect: "Sent ✓" feedback, no console errors

- [ ] **Step 3: View the bug in the admin viewer**

1. Log in as admin in another tab
2. Navigate to `http://localhost:3000/labrat-bugs`
3. Verify the bug appears with kind, where, happened
4. Verify NO "Screenshot" or "Tester contact" blocks render
5. Click "Mark fixed" — verify it transitions cleanly

- [ ] **Step 4: Run `npm test` to confirm nothing broke**

Run: `npm test`
Expected: all tests pass.

### Task 2.10: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add server/db/schema.sql server/utils/bugLog.js server/routes/testFeedback.js server/utils/emailTemplates.js client/src/pages/admin/LabRatBugsPage.js .claude/CLAUDE.md ARCHITECTURE.md
git commit -m "refactor(labrat): drop unused tester_email + screenshot_url end-to-end"
```

---

## Commit 3 — Pre-hire onboarding missions + catalog drift sweep

### Task 3.1: Research the pre-hire claim flow

**Files:** read-only

- [ ] **Step 1: Read the pre-hire onboarding page**

Run: `head -120 client/src/pages/PreHireOnboarding.js`

Determine:
- Does the page call `/api/auth/claim-pre-hire` on mount or via a button click?
- Where does the user land after a successful claim?

- [ ] **Step 2: Read the claim-pre-hire route**

Run: `grep -n -A 80 "router.post..claim-pre-hire" server/routes/auth.js`

Confirm:
- Role gate is `staff` (already known).
- The transition that promotes the user to `'hired'` reads which `onboarding_status` value (likely `'applied'`).

- [ ] **Step 3: Check the `onboarding_status` valid values**

Run: `grep -n -A 5 "onboarding_status" server/db/schema.sql | head -30`

Identify the CHECK constraint or column definition. If `'applied'` is in the list, the seed in Task 3.2 stays as drafted. If a different pre-claim value applies (e.g., `'pre_hired'`), note it and use that in Task 3.2.

### Task 3.2: Add `pre-hire-invitation` seed recipe

**Files:**
- Modify: `server/utils/qaSeed.js`

- [ ] **Step 1: Add `bcryptjs` import at the top of the file**

Add after the existing `const crypto = require('node:crypto');`:

```js
const bcrypt = require('bcryptjs');
```

- [ ] **Step 2: Add the new recipe function**

Insert after the existing `recipeProposalInSent` function:

```js
async function recipePreHireInvitation(client) {
  const email = fakeEmail();
  const plaintext = 'LabRat-' + crypto.randomBytes(4).toString('hex');
  const passwordHash = await bcrypt.hash(plaintext, 10);
  // NOTE: 'applied' is the pre-claim onboarding_status — confirmed by Task 3.1
  // research against the schema CHECK constraint + claim-pre-hire promotion
  // logic. If the project uses a different value, update both this INSERT
  // and the mission step copy accordingly.
  const u = await client.query(
    `INSERT INTO users (email, password, name, role, onboarding_status)
     VALUES ($1, $2, $3, 'staff', 'applied')
     RETURNING id`,
    [email, passwordHash, fakeName()],
  );
  return {
    userId: u.rows[0].id,
    testerEmail: email,
    testerPassword: plaintext,
    onboardingUrl: '/onboarding',
  };
}
```

- [ ] **Step 3: Register the recipe in the `RECIPES` map**

Find:

```js
const RECIPES = {
  'proposal-in-sent': recipeProposalInSent,
};
```

Replace with:

```js
const RECIPES = {
  'proposal-in-sent': recipeProposalInSent,
  'pre-hire-invitation': recipePreHireInvitation,
};
```

### Task 3.3: Whitelist the new recipe in the mission shape validator

**Files:**
- Modify: `server/data/missions/_shape.js`

- [ ] **Step 1: Find the `VALID_SEED_RECIPES` set**

Current (line 5):

```js
const VALID_SEED_RECIPES = new Set([null, 'proposal-in-sent']);
```

- [ ] **Step 2: Add the new value**

Replace with:

```js
const VALID_SEED_RECIPES = new Set([null, 'proposal-in-sent', 'pre-hire-invitation']);
```

### Task 3.4: Smoke-test the seed recipe

**Files:** none (manual smoke test against running server)

- [ ] **Step 1: Restart the dev server**

Run: `npm run dev`

- [ ] **Step 2: Call the seed endpoint**

Run: `curl -X POST http://localhost:5000/api/qa/seed -H 'Content-Type: application/json' -d '{"recipe":"pre-hire-invitation"}'`
Expected: 200 with JSON body containing `ok: true`, `userId`, `testerEmail`, `testerPassword`, `onboardingUrl`.

If 500: read the response error. Most likely `onboarding_status` value mismatch — re-do Task 3.1 with current schema and update Task 3.2's INSERT.

- [ ] **Step 3: Verify the seeded user is in the DB**

Run: `node -e "require('./server/db').pool.query(\"SELECT email, role, onboarding_status FROM users WHERE email LIKE '%@labrat.test' ORDER BY id DESC LIMIT 1\").then(r => { console.log(r.rows[0]); process.exit(0) })"`
Expected: row with `role: 'staff'`, the pre-claim onboarding_status value.

### Task 3.5: Extend `LabRatMission.js` setup renderer for credential output

**Files:**
- Modify: `client/src/pages/labrat/LabRatMission.js`

- [ ] **Step 1: Find the existing setup section**

Around lines 85-100, the `<section className="labrat-setup">` block currently only renders `seedResult.proposalUrl`.

- [ ] **Step 2: Add a conditional render for credential-shaped seed results**

Current block:

```jsx
{mission.seedRecipe && (
  <section className="labrat-setup">
    <h2>Setup (auto)</h2>
    {!seedResult && !seedError && <p>Setting up your test data…</p>}
    {seedError && <p className="labrat-dialog-error">{seedError}</p>}
    {seedResult && seedResult.proposalUrl && (
      <>
        <p>✓ We made you a fake proposal in Sent state.</p>
        <a className="labrat-primary labrat-button"
           href={seedResult.proposalUrl} target="_blank" rel="noopener noreferrer">
          Open the test proposal →
        </a>
      </>
    )}
  </section>
)}
```

Replace with:

```jsx
{mission.seedRecipe && (
  <section className="labrat-setup">
    <h2>Setup (auto)</h2>
    {!seedResult && !seedError && <p>Setting up your test data…</p>}
    {seedError && <p className="labrat-dialog-error">{seedError}</p>}
    {seedResult && seedResult.proposalUrl && (
      <>
        <p>✓ We made you a fake proposal in Sent state.</p>
        <a className="labrat-primary labrat-button"
           href={seedResult.proposalUrl} target="_blank" rel="noopener noreferrer">
          Open the test proposal →
        </a>
      </>
    )}
    {seedResult && seedResult.testerEmail && seedResult.testerPassword && (
      <>
        <p>✓ We made you a fake invited-staff account.</p>
        <p>
          Email: <code>{seedResult.testerEmail}</code><br />
          Password: <code>{seedResult.testerPassword}</code>
        </p>
        {seedResult.onboardingUrl && (
          <p>
            After logging in, visit{' '}
            <a href={`https://hiring.drbartender.com${seedResult.onboardingUrl}`}
               target="_blank" rel="noopener noreferrer">
              hiring.drbartender.com{seedResult.onboardingUrl}
            </a>
          </p>
        )}
      </>
    )}
  </section>
)}
```

### Task 3.6: Add new missions to `applicant.js`

**Files:**
- Modify: `server/data/missions/applicant.js` (append to the end of the exported array)

- [ ] **Step 1: Append both missions inside the array, after the existing `reset-bartender-password` mission**

```js
  {
    id: 'claim-pre-hire-invitation',
    title: 'Claim a pre-hire invitation',
    blurb: 'You\'re a new hire who got an admin invite. Log in with the seeded account, claim the invitation, and confirm you land on the onboarding flow.',
    area: 'applicant',
    estMinutes: 6,
    difficulty: 'easy',
    device: ['desktop', 'mobile'],
    needsAdminComfort: false,
    priority: 'p1',
    seedRecipe: 'pre-hire-invitation',
    steps: [
      { text: 'The Setup section above shows your seeded email + password.', expect: 'Both values display.' },
      { text: 'Open hiring.drbartender.com in a private/incognito window.', expect: 'Hiring landing page loads.' },
      { text: 'Click Sign In. Log in with the seeded credentials.', expect: 'Login succeeds.' },
      { text: 'Visit hiring.drbartender.com/onboarding.', expect: 'Page loads. Invitation claim happens automatically — you should land on Welcome (the first onboarding step) without an error.' },
      { text: 'If you got an error or a blank page, flag this as a bug.', expect: 'You should be on the Welcome page.' },
    ],
    successMessage: 'Pre-hire onboarding is brand new — first lab rat coverage. Thank you.',
  },

  {
    id: 'complete-onboarding-paperwork',
    title: 'Complete the new-hire onboarding paperwork',
    blurb: 'After claiming a pre-hire invitation, walk through every step of the onboarding flow: Welcome → Field Guide → Agreement → Contractor Profile → Payday Protocols → Complete.',
    area: 'applicant',
    estMinutes: 15,
    difficulty: 'medium',
    device: ['desktop'],
    needsAdminComfort: false,
    priority: 'p1',
    seedRecipe: 'pre-hire-invitation',
    steps: [
      { text: 'The Setup section above shows your seeded email + password.', expect: 'Both values display.' },
      { text: 'Open hiring.drbartender.com in a private/incognito window. Log in. Visit /onboarding.', expect: 'You land on the Welcome step.' },
      { text: 'Click through Welcome.', expect: 'Continue advances to Field Guide.' },
      { text: 'Read at least one page of Field Guide. Click Next/Continue.', expect: 'Advances to Agreement.' },
      { text: 'Read the contractor agreement. Type your full name. Sign the signature pad with your mouse/finger. Submit.', expect: 'Agreement saves; advances to Contractor Profile.' },
      { text: 'Fill in Contractor Profile (DOB if missing, any fake bank/routing, any fake SSN-shaped string).', expect: 'Profile saves; advances to Payday Protocols.' },
      { text: 'Read Payday Protocols. Click Continue.', expect: 'Advances to Complete.' },
      { text: 'See the "Onboarding Complete" final state.', expect: 'Friendly completion message; links to staff portal.' },
      { text: 'At any step you remember, click Back and confirm Back navigation works without losing data.', expect: 'Back returns to the prior step; previously entered values are still there.' },
    ],
    successMessage: 'Full onboarding paperwork test — never been tested before. Major help.',
  },
```

- [ ] **Step 2: Verify the catalog loads (shape validation runs at module load)**

Run: `node -e "console.log(require('./server/data/missions').all.length + ' missions loaded')"`
Expected: `22 missions loaded`. If `Invalid mission catalog` error: fix the validation error reported.

### Task 3.7: Drift sweep — URL prefix grep

**Files:** read all `server/data/missions/*.js`

- [ ] **Step 1: Grep for stale `/admin/` URL prefix**

Run: `grep -n "/admin/" server/data/missions/*.js`
Expected: NO matches. The URL cleanup (commit `f13ef5c`, 2026-04-27) removed `/admin/*` prefixes from frontend routes.

If matches: open each file, fix the URL in the mission step (drop `/admin/` from the path).

### Task 3.8: Drift sweep — Quote wizard step numbering

**Files:**
- Read: `client/src/pages/website/QuotePage.js`
- Modify (conditional): `server/data/missions/customer.js`

- [ ] **Step 1: Read the current quote wizard step structure**

Run: `grep -n "step ===\|currentStep\|setStep" client/src/pages/website/QuotePage.js | head -20`

Identify:
- How many steps total?
- Is "Extras" step 4 or step 3?
- Is step 3 hosted-only (skipped for BYOB)?

- [ ] **Step 2: Compare against `submit-byob-quote` step 6**

Open `server/data/missions/customer.js`. The mission `submit-byob-quote` step 6 currently says:

```
{ text: 'Enter your name, your real email, and your real phone. Click Next.', expect: 'Step 4 (Extras) loads (Step 3 is hosted-only).' },
```

- [ ] **Step 3: Apply fix if numbering drifted**

If QuotePage's current structure differs from "Step 4 (Extras) loads (Step 3 is hosted-only)": edit the `expect:` string to match current numbering.

If unchanged: no edit.

### Task 3.9: Drift sweep — Admin demo creds

**Files:**
- Modify (conditional): `server/data/missions/staff.js`, `server/data/missions/admin.js`

- [ ] **Step 1: Verify the hardcoded creds**

Run: `node -e "require('./server/db').pool.query(\"SELECT email, role FROM users WHERE email = 'admin@drbartender.com'\").then(r => { console.log(r.rows[0] || 'NOT FOUND'); process.exit(0) })"`
Expected: row with `role: 'admin'`. If NOT FOUND: continue to step 2.

- [ ] **Step 2: If creds don't work, soften the missions**

In `server/data/missions/staff.js`, mission `staff-portal-tour` step 1, replace:

```
'Open admin.drbartender.com in a private/incognito window. Log in as admin@drbartender.com / DrBartender2024!.'
```

With:

```
'Open admin.drbartender.com in a private/incognito window. Log in as any admin you have credentials for (ask Dallas if you don\'t).'
```

In `server/data/missions/admin.js`, do the same for the `ADMIN_LOGIN_STEP` constant at the top of the file.

### Task 3.10: Drift sweep — Legacy event_name references

**Files:**
- Read: `server/data/missions/*.js`

- [ ] **Step 1: Grep for the legacy field name**

Run: `grep -ni "event_name\|eventName" server/data/missions/*.js`
Expected: NO matches. Per CLAUDE.md's "Event identity" rule, the canonical field is `event_type` (+ `event_type_custom`).

If matches: open each file and replace with `event_type` semantics. Fix in place.

### Task 3.11: Drift sweep — Per-file spot-check

**Files:** read all `server/data/missions/*.js`

This task is interactive — for each mission file, walk every mission and check the bullet list below. Fix anything found IN-PLACE.

- [ ] **Step 1: `server/data/missions/customer.js` (7 missions)**

Per mission, verify:
- URL paths in steps point to current routes in `client/src/App.js`.
- Quoted UI strings (e.g., "Sent", "Paid in Full", "Sign / Save Signature") match what `client/src/pages/proposal/proposalView/ProposalView.js` or related pages render.
- Stripe test card details (4242 4242 4242 4242) are still the standard test card (yes — unchanged).
- Feature names ("Potion Planning Lab", "Lab Notes", "Quote Wizard") match current product naming.

- [ ] **Step 2: `server/data/missions/applicant.js` (3 existing + 2 new = 5 missions)**

Per mission, verify:
- `hiring.drbartender.com` URL paths match `HiringRoutes` in `client/src/App.js`.
- State allowlist in step 4 of `apply-as-bartender` (IL/IN/MI/MN/WI) still matches `Application.js` form.
- Required document types in step 7 ("Resume", "BASSET", "Headshot optional") match current form.

- [ ] **Step 3: `server/data/missions/staff.js` (2 missions)**

Per mission, verify:
- `staff.drbartender.com` paths match `StaffSiteRoutes`.
- Sidebar item list ("Dashboard, Shifts, Schedule, Events, Resources, Profile") matches current staff portal nav (`client/src/components/StaffLayout.js` if it exists).

- [ ] **Step 4: `server/data/missions/admin.js` (4 missions)**

Per mission, verify:
- Sidebar item names in `ADMIN_LOGIN_STEP`-derived flow ("Proposals", "Events", "Financials") match current admin nav at `client/src/components/adminos/nav.js`.
- UI string quotes ("Send", "Record Payment", "Charge Balance", "Approve") match current button labels.

- [ ] **Step 5: `server/data/missions/mobile.js` (2 missions)**

Per mission, verify:
- `drbartender.com` paths still work.
- Touch-test instructions don't reference UI that no longer exists.

- [ ] **Step 6: `server/data/missions/edge.js` (2 missions)**

Per mission, verify:
- Each bad-token URL pattern still maps to a public route that renders a friendly error (not a stack trace). Spot-check by running e.g. `curl -s http://localhost:3000/proposal/not-a-real-token | head -50` against the dev server.

Apply fixes in place as discovered. If no drift found, no edits.

### Task 3.12: Verify catalog still loads after sweep

- [ ] **Step 1: Catalog validation**

Run: `node -e "console.log(require('./server/data/missions').all.length + ' missions loaded')"`
Expected: `22 missions loaded`.

- [ ] **Step 2: Existing tests still pass**

Run: `npx jest server/data/missions`
Expected: 3/3 in `missions.test.js`.

### Task 3.13: Commit

- [ ] **Step 1: Stage**

Stage the always-modified files:

```bash
git add server/utils/qaSeed.js server/data/missions/_shape.js server/data/missions/applicant.js client/src/pages/labrat/LabRatMission.js
```

Then stage any drift-sweep edits (one or more of `customer.js`, `staff.js`, `admin.js`, `mobile.js`, `edge.js`) — list them explicitly:

```bash
# Example, only if drift was found in customer.js + admin.js:
git add server/data/missions/customer.js server/data/missions/admin.js
```

- [ ] **Step 2: Commit**

```bash
git commit -m "feat(labrat): pre-hire onboarding missions + catalog drift sweep"
```

---

## Commit 4 — Shortlist gap-filling + bugLog tests

### Task 4.1: Extend `shortlist.test.js` with missing cases

**Files:**
- Modify: `server/utils/shortlist.test.js` (append new tests inside the existing `describe` block)

- [ ] **Step 1: Find the closing `})` of the `describe('buildShortlist', ...)` block**

It's around line 89 in the current file.

- [ ] **Step 2: Insert five new tests immediately before that closing `})`**

```js
  test('hard filter — wrong area excluded', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['edge'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions.map(m => m.id)).toEqual(['f']);
  });

  test('hard filter — mission exceeding timeBudget excluded', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 6,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    // `a` is 5 min (in), `b` is 30 min (out), `d` is 10 min (out).
    expect(out.missions.map(m => m.id)).toEqual(['a']);
  });

  test('hard filter — completed mission excluded by id', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: ['a'],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions.map(m => m.id)).not.toContain('a');
  });

  test('time-budget relaxation fires when widening surfaces new in-tier candidates', () => {
    // Two p0 missions are both just over the tester's 10-min budget.
    // Relaxation should widen to 15 min (ceil(10 * 1.5)) and surface them.
    const missions = [
      M('x1', 'customer', 12, { priority: 'p0' }),
      M('x2', 'customer', 14, { priority: 'p0' }),
    ];
    const out = buildShortlist({
      missions, areas: ['customer'], timeBudget: 10,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    expect(out.relaxed).toBe(true);
    expect(out.missions.map(m => m.id).sort()).toEqual(['x1', 'x2']);
  });

  test('time-budget relaxation does NOT abandon chosen tier even if widening would add out-of-tier missions', () => {
    // Two in-budget p0 missions exist → shortlist already has p0 candidates.
    // A p1 mission is just over budget; relaxation should NOT surface it
    // because the chosen tier (p0) is not abandoned.
    const missions = [
      M('p0a', 'customer', 5,  { priority: 'p0' }),
      M('p0b', 'customer', 8,  { priority: 'p0' }),
      M('p1a', 'customer', 12, { priority: 'p1' }),
    ];
    const out = buildShortlist({
      missions, areas: ['customer'], timeBudget: 10,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions.map(m => m.priority)).toEqual(['p0', 'p0']);
    expect(out.relaxed).toBe(false);
  });
```

- [ ] **Step 3: Run the extended test file**

Run: `npx jest server/utils/shortlist.test.js`
Expected: PASS — 13 tests (8 existing + 5 new) all green.

### Task 4.2: Create `bugLog.test.js`

**Files:**
- Create: `server/utils/bugLog.test.js`

- [ ] **Step 1: Write the file**

```js
const { pool } = require('../db');
const {
  appendBug, readAllBugs, setBugStatus, openBugCountByMission,
} = require('./bugLog');

describe('bugLog (Postgres)', () => {
  beforeEach(async () => {
    await pool.query("DELETE FROM tester_bugs WHERE mission_id LIKE 'test-%'");
  });
  afterAll(async () => {
    await pool.query("DELETE FROM tester_bugs WHERE mission_id LIKE 'test-%'");
    await pool.end();
  });

  test('appendBug inserts and readAllBugs returns it', async () => {
    const { id } = await appendBug({
      kind: 'bug', missionId: 'test-m1', stepIndex: 2,
      testerName: 'Anon', where: 'step 3', didWhat: 'clicked',
      happened: 'nothing', expected: 'something', browser: 'Chrome',
    });
    expect(id).toMatch(/^bug_/);
    const bugs = await readAllBugs({ status: 'open', missionId: 'test-m1' });
    expect(bugs).toHaveLength(1);
    expect(bugs[0].id).toBe(id);
    expect(bugs[0].kind).toBe('bug');
    expect(bugs[0].missionId).toBe('test-m1');
    expect(bugs[0].stepIndex).toBe(2);
    expect(bugs[0].happened).toBe('nothing');
  });

  test('setBugStatus flips open to fixed and bumps status_updated_at', async () => {
    const { id } = await appendBug({
      kind: 'bug', missionId: 'test-m2', happened: 'x',
    });
    const before = await readAllBugs({ status: 'open', missionId: 'test-m2' });
    expect(before[0].statusUpdatedAt).toBeNull();

    const updated = await setBugStatus(id, { status: 'fixed', fixCommitSha: 'abc1234', notes: 'fix note' });
    expect(updated.status).toBe('fixed');
    expect(updated.fixCommitSha).toBe('abc1234');
    expect(updated.notes).toBe('fix note');
    expect(updated.statusUpdatedAt).not.toBeNull();
  });

  test('readAllBugs filters by missionId', async () => {
    await appendBug({ kind: 'bug', missionId: 'test-m3', happened: 'a' });
    await appendBug({ kind: 'bug', missionId: 'test-m4', happened: 'b' });
    const m3 = await readAllBugs({ missionId: 'test-m3' });
    const m4 = await readAllBugs({ missionId: 'test-m4' });
    expect(m3).toHaveLength(1);
    expect(m4).toHaveLength(1);
    expect(m3[0].missionId).toBe('test-m3');
    expect(m4[0].missionId).toBe('test-m4');
  });

  test('openBugCountByMission returns counts for open bugs only', async () => {
    await appendBug({ kind: 'bug', missionId: 'test-m5', happened: 'x' });
    await appendBug({ kind: 'bug', missionId: 'test-m5', happened: 'y' });
    const { id } = await appendBug({ kind: 'bug', missionId: 'test-m5', happened: 'z' });
    await setBugStatus(id, { status: 'fixed' });
    const counts = await openBugCountByMission();
    expect(counts['test-m5']).toBe(2);
  });

  test('appendBug throws on invalid kind', async () => {
    await expect(appendBug({ kind: 'invalid', happened: 'x' }))
      .rejects.toThrow(/invalid kind/);
  });

  test('setBugStatus throws on invalid status', async () => {
    const { id } = await appendBug({ kind: 'bug', missionId: 'test-m6', happened: 'x' });
    await expect(setBugStatus(id, { status: 'maybe' }))
      .rejects.toThrow(/invalid status/);
  });
});
```

- [ ] **Step 2: Run the new test file**

Run: `npx jest server/utils/bugLog.test.js`
Expected: PASS — 6 tests green.

### Task 4.3: Run full test suite

- [ ] **Step 1: Run `npm test`**

Run: `npm test`
Expected: ALL tests pass — including `missions.test.js`, `missionStats.test.js` (rewritten in commit 1), extended `shortlist.test.js`, and new `bugLog.test.js`.

### Task 4.4: Commit

- [ ] **Step 1: Stage and commit**

```bash
git add server/utils/shortlist.test.js server/utils/bugLog.test.js
git commit -m "test(labrat): shortlist gap-filling + bugLog coverage"
```

---

## After all commits

### Task 5.1: Verify pending-push state

- [ ] **Step 1: Confirm commit count and order**

Run: `git log origin/main..HEAD --oneline`
Expected: exactly 4 commits in this order (newest first):

```
test(labrat): shortlist gap-filling + bugLog coverage
feat(labrat): pre-hire onboarding missions + catalog drift sweep
refactor(labrat): drop unused tester_email + screenshot_url end-to-end
feat(labrat): mission_completions Postgres table + Postgres-backed stats
```

- [ ] **Step 2: Confirm working tree is clean**

Run: `git status`
Expected: `nothing to commit, working tree clean`.

If untracked files appear from the drift sweep: review whether they belong in commit 3 (re-stage and amend per CLAUDE.md amend rules — only on unpushed) or are stray dev artifacts.

### Task 5.2: Full Lab Rat smoke test

**Files:** none (manual browser verification)

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Walk the tester flow**

In a browser at `http://localhost:3000`:
1. Visit `/labrat` — landing renders with name input.
2. Click "Take a quick quiz" → quiz step 1.
3. Pick areas + time budget → submit → `/labrat/missions` shows shortlist.
4. Pick `claim-pre-hire-invitation` (one of the new missions).
5. Verify the Setup section shows the seeded email + password + onboarding link.
6. Click "report bug" on any step, fill, send → "Sent ✓".
7. Log in as admin in another tab, navigate to `/labrat-bugs`. Verify the new bug appears with NO screenshot or tester-email blocks. Mark fixed.
8. Back on the labrat mission, click "Done — next mission" → completes mission, returns to picker.

- [ ] **Step 3: Verify completion persistence across server restart**

1. Stop the dev server (Ctrl+C).
2. Run `npm run dev` again.
3. Visit `/labrat/missions` — the previously-completed mission shows the ✓ done chip (proves Postgres-backed completion log survives restart).

### Task 5.3: Hand off to user for push

- [ ] **Step 1: Report status**

Report to Dallas:
- 4 commits pending push to origin/main.
- `npm test` passes.
- Smoke test passes; completion log survives server restart.

Wait for explicit push cue per CLAUDE.md ("push" / "deploy" / "ship it"). On cue, follow the Pre-Push Procedure (5-agent fleet in parallel → only push if all clean).

### Task 5.4: After successful push — operational SQL cleanup (Dallas runs)

- [ ] **Step 1: Discover FKs that must be cascaded**

Run: `grep -nE 'REFERENCES (clients|users)' server/db/schema.sql`

This produces the table list to DELETE from in order (children before parents).

- [ ] **Step 2: Run inspection queries against prod**

```sql
SELECT COUNT(*) FROM clients WHERE email LIKE '%@labrat.test';
SELECT COUNT(*) FROM users   WHERE email LIKE '%@labrat.test';
```

- [ ] **Step 3: Run cascaded cleanup in a transaction**

```sql
BEGIN;

-- Delete in dependency order — DELETE children first, then clients/users.
-- Use the FK list from Step 1 to populate this section exhaustively.
-- At minimum, proposals references clients(id):
DELETE FROM proposals WHERE client_id IN
  (SELECT id FROM clients WHERE email LIKE '%@labrat.test');

-- Then any other tables with FKs to clients or users discovered in Step 1.

DELETE FROM clients WHERE email LIKE '%@labrat.test';
DELETE FROM users   WHERE email LIKE '%@labrat.test';

COMMIT;
```

If a FK constraint fires mid-transaction: ROLLBACK, add the missed dependent table to the cascade, retry.
