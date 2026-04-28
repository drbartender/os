# Lab Rat Tester Program — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the lean Lab Rat tester site (`/labrat`) before the Stripe live cutover so friends-and-family testing actually starts hitting payment paths with real eyeballs.

**Architecture:** React routes under `client/src/pages/labrat/` powered by an Express `/api/qa` router. Mission catalog as JS data files under `server/data/missions/`. Bug log as append-only JSONL files at `server/data/tester-bugs/`. Single seed recipe (`proposal-in-sent`) for customer money flows; other test data tagged via `@labrat.test` email pattern (cleanup is one manual SQL command pre-Stripe-live, no schema migration). Adaptive shortlist routes testers between p0/p1/p2 missions based on their personal completion history, global coverage thresholds (3 completions = "covered"), and per-mission open-bug counts (2+ open = paused).

**Tech Stack:** Node.js 18 / Express 4.18, React 18 (CRA), PostgreSQL via raw SQL, Jest for utility tests.

**Spec:** `docs/superpowers/specs/2026-04-27-tester-program-v2-design.md` (read the "Phase split" section first)

**Path notes (post-refactor):**
- `server/routes/proposals.js` is now `server/routes/proposals/{index,crud,metadata,public,publicToken}.js` — quote wizard submit lives in `public.js`, admin CRUD in `crud.js`
- `server/routes/admin.js` is now `server/routes/admin/{index,users,applications,blog,managers,settings}.js`
- `client/src/pages/proposal/ProposalView.js` is now `client/src/pages/proposal/proposalView/ProposalView.js`
- `client/src/pages/website/QuoteWizard.js` is now `client/src/pages/website/quoteWizard/QuoteWizard.js`
- `client/src/utils/formatCurrency.js` is gone — currency formatting lives in `client/src/components/adminos/format.js`

**Deferred to Phase 2** (not in this plan):
- `is_test_data` schema column + admin LIST filtering
- Auto-advance flag on `/api/proposals/public/submit`
- Drift detection scripts (`missions:check`, `missions:verify`, `missions:scan-routes`)
- `/labrat-fix` skill
- Cleanup scheduler
- Remaining ~18 missions (Phase 1 ships 12)
- Additional seed recipes (Phase 1 ships ONE: `proposal-in-sent`)

---

## File structure

### New files

```
server/data/missions/
├── _shape.js                     # Pure validator
├── index.js                      # Aggregates + freezes catalog
├── customer.js                   # 4 missions
├── applicant.js                  # 1 mission
├── staff.js                      # 1 mission
├── admin.js                      # 4 missions
├── mobile.js                     # 1 mission
├── edge.js                       # 1 mission
└── __tests__/missions.test.js

server/data/tester-bugs/
└── .gitkeep                      # Directory tracked, contents gitignored

server/routes/
└── labrat.js                     # /api/qa/* endpoints

server/utils/
├── bugLog.js
├── bugLog.test.js
├── missionStats.js
├── missionStats.test.js
├── shortlist.js
├── shortlist.test.js
└── qaSeed.js                     # Just the proposal-in-sent recipe

server/scripts/
└── bugsList.js                   # `npm run bugs:list`

client/src/pages/labrat/
├── LabRatLanding.js
├── LabRatQuiz.js
├── LabRatMissions.js
├── LabRatMission.js
├── BugDialog.js
└── labrat.css
```

### Modified files

```
server/index.js                   # Mount /api/qa router
server/routes/testFeedback.js     # Rewrite to write JSONL instead of email
client/src/App.js                 # Add /labrat/* routes to PublicWebsiteRoutes
package.json                      # +bugs:list npm script
.gitignore                        # Ignore runtime JSONL + status.json
```

---

## Phase 1A — Bug log foundations

### Task 1: Bug log utility

**Files:**
- Create: `server/utils/bugLog.js`
- Create: `server/utils/bugLog.test.js`

- [ ] **Step 1: Write the failing test**

```js
// server/utils/bugLog.test.js
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { appendBug, listOpenBugs, setBugStatus, openBugCountByMission } = require('./bugLog');

describe('bugLog', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buglog-'));
    process.env.LABRAT_BUG_DIR = tmp;
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('appendBug writes a JSON line and returns id', async () => {
    const { id } = await appendBug({
      kind: 'bug',
      missionId: 'submit-byob-quote',
      stepIndex: 2,
      testerName: 'Jordan',
      where: 'Step 3 of quote wizard',
      didWhat: 'Filled date and clicked Next',
      happened: 'Page froze',
      expected: 'Should advance to Step 4',
      browser: 'Chrome 142',
    });
    expect(id).toMatch(/^bug_/);
    const month = new Date().toISOString().slice(0, 7);
    const lines = fs.readFileSync(path.join(tmp, `${month}.jsonl`), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).missionId).toBe('submit-byob-quote');
  });

  test('listOpenBugs returns bugs without status', async () => {
    const { id: a } = await appendBug({ kind: 'bug', happened: 'A' });
    const { id: b } = await appendBug({ kind: 'bug', happened: 'B' });
    await setBugStatus(a, { status: 'fixed', fixCommitSha: 'abc1234' });
    const open = await listOpenBugs();
    expect(open.map(x => x.id)).toEqual([b]);
  });

  test('openBugCountByMission counts only open bugs per mission', async () => {
    await appendBug({ kind: 'bug', missionId: 'm1', happened: 'a' });
    await appendBug({ kind: 'bug', missionId: 'm1', happened: 'b' });
    const { id: c } = await appendBug({ kind: 'bug', missionId: 'm1', happened: 'c' });
    await appendBug({ kind: 'bug', missionId: 'm2', happened: 'd' });
    await setBugStatus(c, { status: 'fixed' });
    const counts = await openBugCountByMission();
    expect(counts).toEqual({ m1: 2, m2: 1 });
  });

  test('rejects unknown kind', async () => {
    await expect(appendBug({ kind: 'rant', happened: 'x' })).rejects.toThrow(/kind/);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx jest server/utils/bugLog.test.js`
Expected: FAIL — module not found

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
function statusFile() { return path.join(getBugDir(), 'status.json'); }
function monthFile(date = new Date()) {
  return path.join(getBugDir(), `${date.toISOString().slice(0, 7)}.jsonl`);
}

async function ensureDir() {
  await fs.mkdir(getBugDir(), { recursive: true });
}

function newBugId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `bug_${ts}_${crypto.randomBytes(3).toString('hex')}`;
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
    return JSON.parse(await fs.readFile(statusFile(), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function setBugStatus(bugId, patch) {
  await ensureDir();
  const all = await readStatus();
  all[bugId] = { ...(all[bugId] || {}), ...patch, updatedAt: new Date().toISOString() };
  await fs.writeFile(statusFile(), JSON.stringify(all, null, 2));
  return all[bugId];
}

async function readAllBugs() {
  await ensureDir();
  const entries = await fs.readdir(getBugDir());
  const out = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const raw = await fs.readFile(path.join(getBugDir(), name), 'utf8');
    for (const line of raw.trim().split('\n')) {
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

async function openBugCountByMission() {
  const open = await listOpenBugs();
  const counts = {};
  for (const b of open) {
    if (!b.missionId) continue;
    counts[b.missionId] = (counts[b.missionId] || 0) + 1;
  }
  return counts;
}

module.exports = { appendBug, listOpenBugs, setBugStatus, readAllBugs, readStatus, openBugCountByMission };
```

- [ ] **Step 4: Run, see pass**

Run: `npx jest server/utils/bugLog.test.js`
Expected: 4 passing

- [ ] **Step 5: Commit**

```bash
git add server/utils/bugLog.js server/utils/bugLog.test.js
git commit -m "feat(labrat): bug-log utility with JSONL append + status sidecar + per-mission open count"
```

---

### Task 2: Refactor `/api/test-feedback` to write JSONL

**Files:**
- Modify: `server/routes/testFeedback.js`

- [ ] **Step 1: Replace file contents**

```js
// server/routes/testFeedback.js
const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const { publicLimiter } = require('../middleware/rateLimiters');
const { ValidationError } = require('../utils/errors');
const { appendBug } = require('../utils/bugLog');

const router = express.Router();
const ALLOWED_KINDS = ['bug', 'confusion', 'mission-stale'];

router.post('/', publicLimiter, asyncHandler(async (req, res) => {
  const { kind, missionId, stepIndex, testerName, testerEmail,
          where, didWhat, happened, expected, browser, screenshotUrl } = req.body || {};

  const errs = {};
  if (!ALLOWED_KINDS.includes(kind)) errs.kind = `must be one of ${ALLOWED_KINDS.join(', ')}`;
  if (kind === 'bug' && (!happened || !happened.trim())) errs.happened = 'Tell us what happened';
  if (testerEmail && typeof testerEmail === 'string' && testerEmail.trim()) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testerEmail.trim())) {
      errs.testerEmail = 'Invalid email format';
    }
  }
  if (Object.keys(errs).length) throw new ValidationError(errs, 'Invalid feedback');

  const { id } = await appendBug({
    kind, missionId: missionId || null, stepIndex,
    testerName, testerEmail, where, didWhat, happened, expected, browser, screenshotUrl,
  });
  res.json({ ok: true, id });
}));

module.exports = router;
```

- [ ] **Step 2: Smoke-test**

```bash
npm run dev   # in another terminal
curl -X POST http://localhost:5000/api/test-feedback \
  -H "Content-Type: application/json" \
  -d '{"kind":"bug","happened":"smoke","testerName":"Dallas"}'
```
Expected: `{"ok":true,"id":"bug_..."}`. File appears at `server/data/tester-bugs/YYYY-MM.jsonl`.

- [ ] **Step 3: Commit**

```bash
git add server/routes/testFeedback.js
git commit -m "feat(labrat): /api/test-feedback writes JSONL bug log instead of email"
```

---

### Task 3: `bugs:list` script + dir + .gitignore

**Files:**
- Create: `server/scripts/bugsList.js`
- Create: `server/data/tester-bugs/.gitkeep`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Append to `.gitignore`**

```
# Lab Rat runtime data — never committed
server/data/tester-bugs/*.jsonl
server/data/tester-bugs/status.json
server/data/mission-completions.jsonl
```

- [ ] **Step 2: Track the directory**

```bash
mkdir -p server/data/tester-bugs
touch server/data/tester-bugs/.gitkeep
```

- [ ] **Step 3: Implement `bugsList.js`**

```js
// server/scripts/bugsList.js
const { listOpenBugs, readAllBugs, readStatus } = require('../utils/bugLog');

async function main() {
  const args = process.argv.slice(2);
  const flag = (k) => {
    const f = args.find(a => a.startsWith(`--${k}=`));
    return f ? f.split('=').slice(1).join('=') : null;
  };
  const missionFilter = flag('mission');
  const statusFilter = flag('status') || 'open';

  let bugs;
  if (statusFilter === 'open') {
    bugs = await listOpenBugs();
  } else {
    const [all, status] = await Promise.all([readAllBugs(), readStatus()]);
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
      if (b.where)    console.log(`    where:    ${b.where}`);
      if (b.didWhat)  console.log(`    did:      ${b.didWhat}`);
      if (b.happened) console.log(`    happened: ${b.happened}`);
      if (b.expected) console.log(`    expected: ${b.expected}`);
    }
  }
  console.log(`\n${bugs.length} bug${bugs.length === 1 ? '' : 's'} total.`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 4: Add npm script**

In root `package.json`, in the `"scripts"` block, add:
```json
"bugs:list": "node server/scripts/bugsList.js"
```

- [ ] **Step 5: Smoke-test**

```bash
npm run bugs:list
# Expected: prints the bug from Task 2's smoke under "(no mission)"
```

- [ ] **Step 6: Commit**

```bash
git add server/scripts/bugsList.js server/data/tester-bugs/.gitkeep package.json .gitignore
git commit -m "feat(labrat): bugs:list npm script + ignore runtime data files"
```

---

## Phase 1B — Mission catalog

### Task 4: Catalog scaffold + shape validator

**Files:**
- Create: `server/data/missions/_shape.js`
- Create: `server/data/missions/index.js`
- Create: `server/data/missions/{customer,applicant,staff,admin,mobile,edge}.js` (empty arrays)
- Create: `server/data/missions/__tests__/missions.test.js`

- [ ] **Step 1: Create the shape validator**

```js
// server/data/missions/_shape.js
const VALID_AREAS = new Set(['customer', 'applicant', 'staff', 'admin', 'mobile', 'edge']);
const VALID_DIFFICULTY = new Set(['easy', 'medium', 'hard']);
const VALID_DEVICES = new Set(['desktop', 'mobile']);
const VALID_PRIORITY = new Set(['p0', 'p1', 'p2']);
const VALID_SEED_RECIPES = new Set([null, 'proposal-in-sent']);

function validateMission(m, fileLabel) {
  const errs = [];
  const fail = (msg) => errs.push(`${fileLabel}[${m.id || '?'}]: ${msg}`);
  if (!m.id || typeof m.id !== 'string' || !/^[a-z0-9-]+$/.test(m.id)) fail('id must be kebab-case string');
  if (!m.title) fail('title required');
  if (!m.blurb) fail('blurb required');
  if (!VALID_AREAS.has(m.area)) fail(`area must be one of ${[...VALID_AREAS].join(',')}`);
  if (!Number.isInteger(m.estMinutes) || m.estMinutes < 1 || m.estMinutes > 120) fail('estMinutes must be 1-120');
  if (!VALID_DIFFICULTY.has(m.difficulty)) fail('difficulty must be easy|medium|hard');
  if (!Array.isArray(m.device) || !m.device.length || !m.device.every(d => VALID_DEVICES.has(d))) fail('device must be non-empty subset');
  if (typeof m.needsAdminComfort !== 'boolean') fail('needsAdminComfort must be boolean');
  if (!VALID_PRIORITY.has(m.priority)) fail('priority must be p0|p1|p2');
  if (!VALID_SEED_RECIPES.has(m.seedRecipe)) fail('seedRecipe must be null or known recipe id');
  if (!Array.isArray(m.steps) || m.steps.length < 1) fail('steps must be non-empty array');
  for (const [i, s] of (m.steps || []).entries()) {
    if (!s.text) fail(`steps[${i}].text required`);
    if (!s.expect) fail(`steps[${i}].expect required`);
  }
  if (!m.successMessage) fail('successMessage required');
  return errs;
}

module.exports = { validateMission };
```

- [ ] **Step 2: Empty area files**

For each of `customer.js`, `applicant.js`, `staff.js`, `admin.js`, `mobile.js`, `edge.js`:
```js
module.exports = [];
```

- [ ] **Step 3: Index aggregator**

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
if (errors.length) throw new Error('Invalid mission catalog:\n  ' + errors.join('\n  '));

const byId = Object.freeze(Object.fromEntries(allMissions.map(m => [m.id, Object.freeze(m)])));
module.exports = { all: Object.freeze(allMissions), byId };
```

- [ ] **Step 4: Validation test**

```js
// server/data/missions/__tests__/missions.test.js
const catalog = require('..');

describe('mission catalog', () => {
  test('loads without throwing', () => expect(catalog.all).toBeDefined());
  test('all ids are unique', () => {
    const ids = catalog.all.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('catalog is frozen', () => expect(Object.isFrozen(catalog.all)).toBe(true));
});
```

- [ ] **Step 5: Run, commit**

```bash
npx jest server/data/missions/
git add server/data/missions/
git commit -m "feat(labrat): mission catalog scaffold + shape validator"
```

---

### Task 5: Customer + applicant + staff missions (6 missions)

**Files:**
- Modify: `server/data/missions/customer.js` (4 missions)
- Modify: `server/data/missions/applicant.js` (1 mission)
- Modify: `server/data/missions/staff.js` (1 mission)

- [ ] **Step 1: Replace `customer.js`**

```js
// server/data/missions/customer.js
module.exports = [
  {
    id: 'submit-byob-quote',
    title: 'Submit a fake event quote',
    blurb: 'Pretend you\'re hiring us for a wedding. Fill out the quote wizard end-to-end and check that pricing adds up.',
    area: 'customer',
    estMinutes: 10,
    difficulty: 'easy',
    device: ['desktop', 'mobile'],
    needsAdminComfort: false,
    priority: 'p0',
    seedRecipe: null,
    steps: [
      { text: 'Go to drbartender.com/quote in a normal browser window.', expect: 'Wizard loads on Step 1 (Event Details).' },
      { text: 'Enter Guest count 50 and Duration 4 hours.', expect: 'Both fields accept the values.' },
      { text: 'Pick an Event date 2+ weeks in the future and any Start time.', expect: 'Pickers work.' },
      { text: 'Pick Event type "Wedding", City "Chicago", State "IL".', expect: 'Fields accept input.' },
      { text: 'Pick Alcohol provider "BYOB" and Bar type "Full Bar". Click Next.', expect: 'Step 2 loads.' },
      { text: 'Enter your name, your real email, and your real phone. Click Next.', expect: 'Step 4 (Extras) loads (Step 3 is hosted-only).' },
      { text: 'Check 1-2 add-ons and 1-2 syrups. Click Next.', expect: 'Total updates as you click. Step 5 loads with the full breakdown.' },
      { text: 'Verify the totals look reasonable. Click Submit.', expect: 'Success message appears, then redirects to a proposal page.' },
      { text: 'Wait up to 60 seconds and check your real email inbox.', expect: 'A proposal email arrives with a link.' },
    ],
    successMessage: 'Quote → proposal is one of our highest-volume flows. Thank you.',
  },

  {
    id: 'sign-and-pay-deposit',
    title: 'Sign and pay deposit on a proposal',
    blurb: 'We\'ll set you up with a fake proposal already in Sent state. Open it, sign it, pay the deposit with a Stripe test card.',
    area: 'customer',
    estMinutes: 12,
    difficulty: 'easy',
    device: ['desktop', 'mobile'],
    needsAdminComfort: false,
    priority: 'p0',
    seedRecipe: 'proposal-in-sent',
    steps: [
      { text: 'Open the test proposal link from the Setup section above.', expect: 'Proposal page loads with event details, pricing, and totals.' },
      { text: 'Scroll to the signature section. Type your full name in the signature name field.', expect: 'Field accepts input.' },
      { text: 'Click "Draw" and sign with your mouse or finger.', expect: 'Signature appears in the box.' },
      { text: 'Check any required agreement checkbox(es). Click Sign / Save Signature.', expect: 'Confirmation appears; the proposal is now signed.' },
      { text: 'Scroll to the payment section. Select "Pay Deposit Now".', expect: 'Card form appears.' },
      { text: 'Optional: check "Automatically charge my saved card for the balance" so the autopay test in the next mission has data.', expect: 'Checkbox toggles.' },
      { text: 'Enter test card 4242 4242 4242 4242, expiry 12/34, CVC 123, ZIP 12345.', expect: 'Card form accepts.' },
      { text: 'Click Pay.', expect: 'Loading spinner, then a success message. (Watch for any error.)' },
      { text: 'Refresh the proposal page.', expect: 'Status now shows "Deposit Paid". The deposit amount appears in any payment list.' },
    ],
    successMessage: 'Signed + paid is the most important flow we have. Big help.',
  },

  {
    id: 'pay-balance-and-paid-in-full',
    title: 'Pay the remaining balance',
    blurb: 'A test proposal already has a deposit paid. Pay the rest and confirm the status flips to "Paid in Full."',
    area: 'customer',
    estMinutes: 6,
    difficulty: 'easy',
    device: ['desktop', 'mobile'],
    needsAdminComfort: false,
    priority: 'p0',
    seedRecipe: 'proposal-in-sent',
    steps: [
      { text: 'Open the test proposal link from the Setup section above.', expect: 'Proposal page loads. Note: this seeded proposal starts in Sent state — you may need to sign + pay deposit first.' },
      { text: 'After deposit is paid, refresh and scroll to the payment section.', expect: '"Pay Remaining Balance" option appears.' },
      { text: 'Select "Pay Remaining Balance" and enter test card 4242 4242 4242 4242.', expect: 'Card form accepts.' },
      { text: 'Click Pay.', expect: 'Success message.' },
      { text: 'Refresh.', expect: 'Status now shows "Paid in Full" or "Balance Paid".' },
    ],
    successMessage: 'Money in. Best feeling.',
  },

  {
    id: 'drink-plan-exploration',
    title: 'Walk through the drink-plan questionnaire',
    blurb: 'A test drink plan exists for you. Click through every step of the Potion Planning Lab — pick favorites, set vibes, write a dream drink.',
    area: 'customer',
    estMinutes: 12,
    difficulty: 'easy',
    device: ['desktop', 'mobile'],
    needsAdminComfort: false,
    priority: 'p0',
    seedRecipe: 'proposal-in-sent',
    steps: [
      { text: 'Open the test proposal link from the Setup section. Look for a "drink plan" link.', expect: 'Drink plan page loads at /plan/<token>.' },
      { text: 'Welcome step.', expect: 'Greets you with the proposal name.' },
      { text: 'Click through every step: Quick Pick → Vibe → Flavor Direction → Browse Cocktails → Mocktails → Save Draft.', expect: 'Each step loads, accepts input, advances.' },
      { text: 'Add a couple of cocktails to favorites and write a "dream drink" note.', expect: 'Selections persist.' },
      { text: 'Click Save Draft on the last step.', expect: 'Confirmation message.' },
    ],
    successMessage: 'Drink plan is what we deliver. Helping us make sure it works = appreciated.',
  },
];
```

- [ ] **Step 2: Replace `applicant.js`**

```js
// server/data/missions/applicant.js
module.exports = [
  {
    id: 'apply-as-bartender',
    title: 'Apply to work as a bartender',
    blurb: 'Pretend you\'re looking for bartending work. Submit a full application with fake info.',
    area: 'applicant',
    estMinutes: 12,
    difficulty: 'medium',
    device: ['desktop'],
    needsAdminComfort: false,
    priority: 'p1',
    seedRecipe: null,
    steps: [
      { text: 'Go to hiring.drbartender.com.', expect: 'Hiring landing page loads with the 4-step explainer.' },
      { text: 'Click Create Account, enter a fresh email (use yours+labrat@... if needed) and a password (8+ chars, upper, lower, digit). Submit.', expect: 'Redirects to the Application form.' },
      { text: 'Fill Basic Info: name, phone, favorite color, DOB (must be 21+).', expect: 'All fields accept input.' },
      { text: 'Location & Travel: street address, city, pick state IL/IN/MI/MN/WI (others are blocked).', expect: 'State dropdown only allows the 5.' },
      { text: 'Experience: check Bartender, prior experience Yes, fill the follow-up fields.', expect: 'Conditional fields appear.' },
      { text: 'Availability + Tools/Equipment + Skills sections — fill each.', expect: 'No validation errors.' },
      { text: 'Upload any PDF/image as Resume (required) and BASSET (required). Headshot optional.', expect: 'Files upload.' },
      { text: 'Emergency contact: name, phone, relationship.', expect: 'Fields accept.' },
      { text: 'Submit.', expect: 'Redirects to the Application Status page showing "Application Received".' },
    ],
    successMessage: 'Hiring pipeline tested. Cheers.',
  },
];
```

- [ ] **Step 3: Replace `staff.js`**

```js
// server/data/missions/staff.js
module.exports = [
  {
    id: 'staff-portal-tour',
    title: 'Tour the staff portal',
    blurb: 'You\'re a fake staff member already onboarded. Log in to staff.drbartender.com and check that every section loads.',
    area: 'staff',
    estMinutes: 8,
    difficulty: 'medium',
    device: ['desktop', 'mobile'],
    needsAdminComfort: true,
    priority: 'p2',
    seedRecipe: null,
    steps: [
      { text: 'Open admin.drbartender.com in a private/incognito window. Log in as admin@drbartender.com / DrBartender2024!.', expect: 'Admin dashboard loads.' },
      { text: 'Find any approved staff user in the Staff list. Note their email.', expect: 'Staff list loads with rows.' },
      { text: 'Open staff.drbartender.com in a different browser. Log in with that staff email and any test password (or use Forgot Password to set one).', expect: 'Staff dashboard loads (not the welcome/onboarding page).' },
      { text: 'Click each sidebar section: Dashboard, Shifts, Schedule, Events, Resources, Profile.', expect: 'Every section loads without error.' },
      { text: 'Pick any open shift, select a position, click "Request This Shift".', expect: 'Pending status chip appears on that shift.' },
      { text: 'Click "Cancel Request" on the same shift.', expect: 'Goes back to unrequested.' },
    ],
    successMessage: 'Staff portal exercised — thanks.',
  },
];
```

- [ ] **Step 4: Validate + commit**

```bash
npx jest server/data/missions/
git add server/data/missions/customer.js server/data/missions/applicant.js server/data/missions/staff.js
git commit -m "feat(labrat): customer (4), applicant (1), staff (1) missions"
```

---

### Task 6: Admin + mobile + edge missions (6 missions)

**Files:**
- Modify: `server/data/missions/admin.js` (4)
- Modify: `server/data/missions/mobile.js` (1)
- Modify: `server/data/missions/edge.js` (1)

- [ ] **Step 1: Replace `admin.js`**

```js
// server/data/missions/admin.js
const ADMIN_LOGIN_STEP = {
  text: 'Open admin.drbartender.com in a private/incognito window. Log in as admin@drbartender.com / DrBartender2024!.',
  expect: 'Admin dashboard loads.',
};

module.exports = [
  {
    id: 'send-a-proposal',
    title: 'Send a draft proposal',
    blurb: 'Find a Draft proposal in the admin Proposals list and send it. The fake client should receive the email.',
    area: 'admin',
    estMinutes: 4,
    difficulty: 'easy',
    device: ['desktop'],
    needsAdminComfort: true,
    priority: 'p0',
    seedRecipe: null,
    steps: [
      ADMIN_LOGIN_STEP,
      { text: 'In the left sidebar, click Proposals.', expect: 'Proposals list loads.' },
      { text: 'Filter by status Draft. Pick any draft proposal (or create a new one via "New Proposal" if none exist).', expect: 'A draft proposal opens.' },
      { text: 'Click the Send button (or whatever moves status from Draft → Sent).', expect: 'Status badge flips to "Sent".' },
      { text: 'Check the client email address on the proposal — if it\'s a real test address you control, look in that inbox.', expect: 'Proposal email arrives within 60 seconds.' },
    ],
    successMessage: 'Proposal-send is the chokepoint customer testers always hit. Helping us validate it = huge.',
  },

  {
    id: 'record-cash-payment',
    title: 'Record a cash/check payment on a proposal',
    blurb: 'Manually log a cash payment for a proposal. Verify it shows up in the financials and updates status.',
    area: 'admin',
    estMinutes: 5,
    difficulty: 'easy',
    device: ['desktop'],
    needsAdminComfort: true,
    priority: 'p0',
    seedRecipe: null,
    steps: [
      ADMIN_LOGIN_STEP,
      { text: 'Open any proposal that has an unpaid balance.', expect: 'Proposal detail page loads.' },
      { text: 'Click "Record Payment".', expect: 'Modal opens with amount + method + paid-in-full checkbox.' },
      { text: 'Enter an amount, method = Cash, optionally check "Paid in Full". Save.', expect: 'Modal closes.' },
      { text: 'Refresh the proposal page.', expect: 'Status updates; amount paid increments; new payment appears in any payment list.' },
      { text: 'Click Financials in the sidebar. Verify the payment appears in Recent Payments.', expect: 'Payment is listed with correct amount and method.' },
    ],
    successMessage: 'Manual payment tracking is touchy money math. Thanks.',
  },

  {
    id: 'charge-balance-via-autopay',
    title: 'Trigger an autopay balance charge',
    blurb: 'Find a proposal where the client enrolled in autopay during deposit. Trigger the balance charge and confirm Stripe runs it.',
    area: 'admin',
    estMinutes: 5,
    difficulty: 'medium',
    device: ['desktop'],
    needsAdminComfort: true,
    priority: 'p0',
    seedRecipe: null,
    steps: [
      ADMIN_LOGIN_STEP,
      { text: 'Find a proposal where the client paid the deposit AND checked the autopay box. (You may need to set this up first via the customer-side missions.)', expect: 'Proposal detail loads showing autopay enabled and a saved card.' },
      { text: 'Click "Charge Balance".', expect: 'Confirmation modal appears.' },
      { text: 'Confirm.', expect: 'Charge succeeds (test card always succeeds). Status flips to "Paid in Full".' },
      { text: 'Verify the new charge in the payment list and in Financials → Recent Payments.', expect: 'Charge appears with the right amount.' },
    ],
    successMessage: 'Autopay touches real Stripe charges — testing this before live mode is critical.',
  },

  {
    id: 'approve-shift-request',
    title: 'Approve a staff shift request',
    blurb: 'A staff member has requested a shift. Approve it and confirm the SMS goes out.',
    area: 'admin',
    estMinutes: 4,
    difficulty: 'easy',
    device: ['desktop'],
    needsAdminComfort: true,
    priority: 'p0',
    seedRecipe: null,
    steps: [
      ADMIN_LOGIN_STEP,
      { text: 'Click Events in the sidebar. Find an event with pending shift requests.', expect: 'Event opens with shift list and request indicators.' },
      { text: 'Open the event detail. Find the pending shift request.', expect: 'Request shows the staff name and requested position.' },
      { text: 'Click Approve.', expect: 'Request status changes to Approved/Confirmed.' },
      { text: 'If the staff member has a phone number on file, ask them (or check your own if testing with your number) for an SMS.', expect: 'SMS arrives within 60 seconds.' },
    ],
    successMessage: 'Staffing notifications are how we move fast. Thanks for testing.',
  },
];
```

- [ ] **Step 2: Replace `mobile.js`**

```js
// server/data/missions/mobile.js
module.exports = [
  {
    id: 'mobile-quote-and-signature',
    title: 'On your phone: get a quote and sign a proposal',
    blurb: 'Submit a quote from your phone, then sign the resulting proposal with your finger. Look for cramped layouts, missing buttons, anything ugly.',
    area: 'mobile',
    estMinutes: 10,
    difficulty: 'easy',
    device: ['mobile'],
    needsAdminComfort: false,
    priority: 'p1',
    seedRecipe: null,
    steps: [
      { text: 'Open Chrome or Safari on your phone. Go to drbartender.com.', expect: 'Homepage loads, no horizontal scroll, text readable.' },
      { text: 'Tap Get a Quote.', expect: 'Quote wizard loads.' },
      { text: 'Walk through every step. Pay attention to inputs being usable on a touch screen.', expect: 'Everything works; no field is hidden under the keyboard.' },
      { text: 'Submit. Open the proposal email on your phone.', expect: 'Email arrives, link opens proposal.' },
      { text: 'On the signature pad, sign with your finger.', expect: 'Signature captures cleanly.' },
      { text: 'Save the signature.', expect: 'Confirmation appears.' },
    ],
    successMessage: 'Mobile is where most real visitors land. Thanks for the touch test.',
  },
];
```

- [ ] **Step 3: Replace `edge.js`**

```js
// server/data/missions/edge.js
module.exports = [
  {
    id: 'expired-or-bad-tokens',
    title: 'Try broken/expired URLs',
    blurb: 'Visit a few URLs that should fail gracefully. We want a friendly error, not a stack trace.',
    area: 'edge',
    estMinutes: 3,
    difficulty: 'easy',
    device: ['desktop', 'mobile'],
    needsAdminComfort: false,
    priority: 'p2',
    seedRecipe: null,
    steps: [
      { text: 'Visit drbartender.com/proposal/not-a-real-token.', expect: 'Friendly error page (no white screen, no stack trace).' },
      { text: 'Visit drbartender.com/labnotes/not-a-real-slug.', expect: '"Post Not Found" page.' },
      { text: 'Visit drbartender.com/invoice/not-a-real-token.', expect: 'Friendly error.' },
      { text: 'Visit drbartender.com/shopping-list/not-a-real-token.', expect: 'Friendly error.' },
      { text: 'Visit drbartender.com/plan/not-a-real-token.', expect: 'Friendly error.' },
    ],
    successMessage: 'Edge cases catch bugs nobody else looks for. Thanks for going hunting.',
  },
];
```

- [ ] **Step 4: Validate + commit**

```bash
npx jest server/data/missions/
# Expected: 12 missions valid

git add server/data/missions/admin.js server/data/missions/mobile.js server/data/missions/edge.js
git commit -m "feat(labrat): admin (4), mobile (1), edge (1) missions; catalog at 12"
```

---

## Phase 1C — Backend APIs

### Task 7: Mission stats utility

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
    expect(await getCompletionCounts()).toEqual({ a: 2, b: 1 });
  });
  test('returns empty object when no file', async () => {
    expect(await getCompletionCounts()).toEqual({});
  });
});
```

- [ ] **Step 2: Implement**

```js
// server/utils/missionStats.js
const fs = require('node:fs/promises');
const path = require('node:path');

function getFile() {
  return process.env.LABRAT_COMPLETIONS_FILE
    || path.join(__dirname, '..', 'data', 'mission-completions.jsonl');
}

async function logCompletion(missionId, testerName) {
  await fs.mkdir(path.dirname(getFile()), { recursive: true });
  const line = JSON.stringify({
    missionId,
    testerName: testerName || null,
    at: new Date().toISOString(),
  }) + '\n';
  await fs.appendFile(getFile(), line);
}

async function getCompletionCounts() {
  let raw;
  try { raw = await fs.readFile(getFile(), 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  const counts = {};
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try { counts[JSON.parse(line).missionId] = (counts[JSON.parse(line).missionId] || 0) + 1; }
    catch { /* skip */ }
  }
  return counts;
}

module.exports = { logCompletion, getCompletionCounts };
```

- [ ] **Step 3: Run, commit**

```bash
npx jest server/utils/missionStats.test.js
git add server/utils/missionStats.js server/utils/missionStats.test.js
git commit -m "feat(labrat): missionStats utility"
```

---

### Task 8: Adaptive shortlist pure function

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
  M('a', 'customer', 5,  { priority: 'p0' }),
  M('b', 'customer', 30, { priority: 'p0' }),
  M('c', 'admin',    8,  { priority: 'p0', needsAdminComfort: true }),
  M('d', 'customer', 10, { priority: 'p1' }),
  M('e', 'admin',    5,  { priority: 'p2', needsAdminComfort: true }),
  M('f', 'edge',     3,  { priority: 'p2' }),
];

describe('buildShortlist', () => {
  test('new tester sees only p0 when p0 not saturated', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions.map(m => m.priority)).toEqual(['p0', 'p0']);
  });
  test('returning tester graduates after personally completing all p0', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop',
      completedIds: ['a', 'b'],     // tester finished both p0 in customer area
      counts: {}, openBugCounts: {},
    });
    expect(out.missions.map(m => m.id)).toContain('d');  // p1
  });
  test('crowd graduation: when all p0 are saturated globally, p1 surfaces too', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: { a: 5, b: 5, c: 5 },   // every p0 has 3+ completions
      openBugCounts: {},
    });
    expect(out.missions.map(m => m.priority)).toEqual(expect.arrayContaining(['p0', 'p1']));
  });
  test('bug-saturated missions are excluded', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: { a: 2 },   // a has 2 open bugs
    });
    expect(out.missions.map(m => m.id)).not.toContain('a');
  });
  test('mission with 1 open bug is still shown', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: { a: 1 },
    });
    expect(out.missions.map(m => m.id)).toContain('a');
  });
  test('admin-skip drops needsAdminComfort missions', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['admin'], timeBudget: 60,
      adminComfort: 'skip', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions).toEqual([]);
  });
  test('respects device filter', () => {
    const desktopOnly = M('z', 'customer', 5, { device: ['desktop'], priority: 'p0' });
    const out = buildShortlist({
      missions: [desktopOnly], areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'mobile', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions).toEqual([]);
  });
  test('within tier, sorts by completion count ascending', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: { a: 5, b: 0 },   // a over-tested, b fresh
      openBugCounts: {},
    });
    // both p0; b should come first because 0 < 5
    expect(out.missions[0].id).toBe('b');
  });
});
```

- [ ] **Step 2: Implement**

```js
// server/utils/shortlist.js
const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2 };
const COVERAGE_THRESHOLD = 3;
const BUG_SATURATION_THRESHOLD = 2;

function applyHardFilters(missions, { areas, timeBudget, adminComfort, device, completedIds, openBugCounts }) {
  return missions.filter(m => {
    if (!areas.includes(m.area)) return false;
    if (m.estMinutes > timeBudget) return false;
    if (!m.device.includes(device)) return false;
    if (m.needsAdminComfort && adminComfort === 'skip') return false;
    if (completedIds.includes(m.id)) return false;
    if ((openBugCounts[m.id] || 0) >= BUG_SATURATION_THRESHOLD) return false;
    return true;
  });
}

function chooseTiers(allMissions, candidates, counts) {
  const allP0 = allMissions.filter(m => m.priority === 'p0');
  const allP0Saturated = allP0.length > 0 && allP0.every(m => (counts[m.id] || 0) >= COVERAGE_THRESHOLD);
  const testerHasUncompletedP0 = candidates.some(m => m.priority === 'p0');

  if (testerHasUncompletedP0 && !allP0Saturated)     return ['p0'];
  if (testerHasUncompletedP0 && allP0Saturated)      return ['p0', 'p1'];
  if (candidates.some(m => m.priority === 'p1'))     return ['p1', 'p2'];
  return ['p2'];
}

function sortMissions(arr, counts) {
  return [...arr].sort((a, b) => {
    const pa = PRIORITY_RANK[a.priority];
    const pb = PRIORITY_RANK[b.priority];
    if (pa !== pb) return pa - pb;
    const ca = counts[a.id] || 0;
    const cb = counts[b.id] || 0;
    if (ca !== cb) return ca - cb;
    return Math.random() - 0.5;
  });
}

function buildShortlist({ missions, areas, timeBudget, adminComfort, device, completedIds, counts, openBugCounts, limit = 6 }) {
  const candidates = applyHardFilters(missions, { areas, timeBudget, adminComfort, device, completedIds, openBugCounts });
  if (candidates.length === 0) return { missions: [], relaxed: false };

  const tiers = chooseTiers(missions, candidates, counts);
  const inTier = candidates.filter(m => tiers.includes(m.priority));
  const result = sortMissions(inTier, counts).slice(0, limit);

  if (result.length >= 3) return { missions: result, relaxed: false };

  // Widen the time budget and see if it adds in-tier missions. Only relax if
  // widening actually surfaces new options — never abandon the chosen tier
  // (that would surface p1/p2 to a tester who should be focused on p0).
  const widenedInTier = applyHardFilters(missions, {
    areas, timeBudget: Math.ceil(timeBudget * 1.5),
    adminComfort, device, completedIds, openBugCounts,
  }).filter(m => tiers.includes(m.priority));
  if (widenedInTier.length > inTier.length) {
    return { missions: sortMissions(widenedInTier, counts).slice(0, limit), relaxed: true };
  }
  return { missions: result, relaxed: false };
}

module.exports = { buildShortlist, COVERAGE_THRESHOLD, BUG_SATURATION_THRESHOLD };
```

- [ ] **Step 3: Run, commit**

```bash
npx jest server/utils/shortlist.test.js
# Expected: 8 passing

git add server/utils/shortlist.js server/utils/shortlist.test.js
git commit -m "feat(labrat): adaptive shortlist (priority + per-tester history + global coverage + bug saturation)"
```

---

### Task 9: Single seed recipe (`proposal-in-sent`)

**Files:**
- Create: `server/utils/qaSeed.js`

- [ ] **Step 1: Inspect existing proposal/client schemas**

Read `server/db/schema.sql` to identify the required NOT NULL columns on `clients` and `proposals`. Also read `server/routes/proposals/public.js` to see the canonical INSERT pattern used by the live wizard — replicate the same column set so seeded rows behave like real ones.

- [ ] **Step 2: Implement the recipe**

```js
// server/utils/qaSeed.js
const crypto = require('node:crypto');
const pool = require('../db');

function fakeName() {
  const f = ['Lab', 'Test', 'QA', 'Demo', 'Mock'][crypto.randomInt(0, 5)];
  const l = ['Rat', 'Pilot', 'Subject', 'Friend', 'Cousin'][crypto.randomInt(0, 5)];
  return `${f} ${l}-${crypto.randomBytes(2).toString('hex')}`;
}

function fakeEmail() {
  return `labrat-${crypto.randomBytes(4).toString('hex')}@labrat.test`;
}

async function recipeProposalInSent(client) {
  // 1. Test client (email pattern @labrat.test for cleanup heuristic)
  const cli = await client.query(`
    INSERT INTO clients (name, email, phone)
    VALUES ($1, $2, '5555550100')
    RETURNING id
  `, [fakeName(), fakeEmail()]);

  // 2. Test proposal already in Sent state
  const eventDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  // NOTE: column list MUST match what the live quote submit handler in
  // server/routes/proposals/public.js inserts. If schema requires more
  // NOT NULL columns, add them here using sensible defaults.
  const prop = await client.query(`
    INSERT INTO proposals (
      client_id, status, event_type, event_date, event_start_time,
      event_duration_hours, guest_count, location_city, location_state,
      alcohol_provider, bar_type, total_cents, public_token
    )
    VALUES ($1, 'Sent', 'Wedding', $2, '17:00', 4, 50,
            'Chicago', 'IL', 'BYOB', 'Full Bar', 50000,
            gen_random_uuid()::text)
    RETURNING id, public_token
  `, [cli.rows[0].id, eventDate]);

  return {
    clientId: cli.rows[0].id,
    proposalId: prop.rows[0].id,
    token: prop.rows[0].public_token,
    proposalUrl: `/proposal/${prop.rows[0].public_token}`,
  };
}

const RECIPES = {
  'proposal-in-sent': recipeProposalInSent,
};

async function runSeedRecipe(recipeId) {
  if (!RECIPES[recipeId]) throw new Error(`Unknown seed recipe: ${recipeId}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await RECIPES[recipeId](client);
    await client.query('COMMIT');
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

- [ ] **Step 3: Smoke**

```bash
node -e "require('./server/utils/qaSeed').runSeedRecipe('proposal-in-sent').then(r => console.log(r), e => console.error(e.message))"
```
Expected: prints `{ clientId: ..., proposalId: ..., token: '...', proposalUrl: '/proposal/...' }`. Open `http://localhost:5000/api/proposals/t/<token>` — proposal loads.

If the INSERT fails on a NOT NULL column not listed here, edit the recipe to include sensible defaults for the missing column(s). Do not loosen the schema.

- [ ] **Step 4: Commit**

```bash
git add server/utils/qaSeed.js
git commit -m "feat(labrat): proposal-in-sent seed recipe (email pattern @labrat.test)"
```

---

### Task 10: Lab Rat router

**Files:**
- Create: `server/routes/labrat.js`
- Modify: `server/index.js`

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
const { openBugCountByMission } = require('../utils/bugLog');
const { runSeedRecipe } = require('../utils/qaSeed');

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
  if (!['desktop', 'mobile'].includes(device)) errs.device = 'device must be desktop or mobile';
  if (Object.keys(errs).length) throw new ValidationError(errs, 'Invalid shortlist input');

  const [counts, openBugCounts] = await Promise.all([
    getCompletionCounts(),
    openBugCountByMission(),
  ]);
  const result = buildShortlist({
    missions: catalog.all,
    areas, timeBudget,
    adminComfort: adminComfort || 'skip',
    device,
    completedIds: Array.isArray(completedIds) ? completedIds : [],
    counts, openBugCounts,
  });
  res.json(result);
}));

router.post('/seed', publicLimiter, asyncHandler(async (req, res) => {
  const { recipe } = req.body || {};
  if (!recipe || typeof recipe !== 'string') {
    throw new ValidationError({ recipe: 'required' }, 'recipe required');
  }
  const result = await runSeedRecipe(recipe);
  res.json({ ok: true, ...result });
}));

router.post('/complete', publicLimiter, asyncHandler(async (req, res) => {
  const { missionId, testerName } = req.body || {};
  if (!missionId || !catalog.byId[missionId]) {
    throw new ValidationError({ missionId: 'unknown' }, 'Unknown mission');
  }
  await logCompletion(missionId, testerName || null);
  res.json({ ok: true });
}));

module.exports = router;
```

- [ ] **Step 2: Mount in `server/index.js`**

Add alongside existing route mounts (search for `app.use('/api/test-feedback'`):
```js
app.use('/api/qa', require('./routes/labrat'));
```

- [ ] **Step 3: Smoke-test all endpoints**

```bash
curl http://localhost:5000/api/qa/missions | head -c 200

curl -X POST http://localhost:5000/api/qa/shortlist \
  -H "Content-Type: application/json" \
  -d '{"areas":["customer"],"timeBudget":15,"device":"desktop","completedIds":[]}'

curl -X POST http://localhost:5000/api/qa/seed \
  -H "Content-Type: application/json" \
  -d '{"recipe":"proposal-in-sent"}'

curl -X POST http://localhost:5000/api/qa/complete \
  -H "Content-Type: application/json" \
  -d '{"missionId":"submit-byob-quote","testerName":"Dallas"}'
```
Expected: each returns OK-shaped JSON. After running `complete`, re-run `shortlist` and verify `submit-byob-quote` no longer appears (since count incremented and... wait, the picker only filters by completedIds from localStorage, not server-side counts. So it WILL still appear, just with a higher count, sorted lower. That's correct behavior.)

- [ ] **Step 4: Commit**

```bash
git add server/routes/labrat.js server/index.js
git commit -m "feat(labrat): /api/qa router (missions, shortlist, seed, complete)"
```

---

## Phase 1D — Frontend

### Task 11: BugDialog component + skeleton CSS

**Files:**
- Create: `client/src/pages/labrat/BugDialog.js`
- Create: `client/src/pages/labrat/labrat.css`

- [ ] **Step 1: Implement the dialog component**

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
    if (open) { setForm({ happened: '', expected: '' }); setError(null); }
  }, [open, missionId, stepIndex]);

  async function onSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/test-feedback', {
        kind, missionId, stepIndex, testerName, where, didWhat,
        happened: form.happened, expected: form.expected,
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
        <label>{kind === 'mission-stale' ? 'What seems wrong with this mission?' : 'What happened?'}
          <textarea
            required
            value={form.happened}
            onChange={e => setForm(f => ({ ...f, happened: e.target.value }))}
            rows={4}
          />
        </label>
        {kind === 'bug' && (
          <label>What did you expect? (optional)
            <textarea
              value={form.expected}
              onChange={e => setForm(f => ({ ...f, expected: e.target.value }))}
              rows={2}
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

- [ ] **Step 2: Create `labrat.css` with all Lab Rat styles**

```css
/* client/src/pages/labrat/labrat.css */
[data-app="labrat"] {
  --labrat-fg: #1f2328;
  --labrat-bg: #ffffff;
  --labrat-muted: #656d76;
  --labrat-accent: #6b46c1;
  --labrat-border: #d0d7de;
  --labrat-radius: 8px;
}

dialog.labrat-dialog {
  border: 1px solid var(--labrat-border);
  border-radius: var(--labrat-radius);
  padding: 0; max-width: 560px; width: calc(100% - 2rem);
}
dialog.labrat-dialog::backdrop { background: rgba(0,0,0,0.4); }
dialog.labrat-dialog form { padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
dialog.labrat-dialog h2 { margin: 0 0 0.5rem; font-size: 1.1rem; }
dialog.labrat-dialog label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; font-weight: 500; }
dialog.labrat-dialog textarea {
  font: inherit; padding: 0.45em 0.6em;
  border: 1px solid var(--labrat-border); border-radius: 4px; resize: vertical;
}
.labrat-dialog-context { font-size: 0.85rem; color: var(--labrat-muted); margin: 0; }
.labrat-dialog-error { color: #b42318; font-size: 0.9rem; margin: 0; }
.labrat-dialog-actions { display: flex; gap: 0.5rem; justify-content: flex-end; }
.labrat-dialog-actions button {
  font: inherit; padding: 0.4rem 1rem;
  border: 1px solid var(--labrat-border); background: var(--labrat-bg);
  border-radius: 4px; cursor: pointer;
}
.labrat-primary { background: var(--labrat-accent) !important; color: white !important; border-color: var(--labrat-accent) !important; }

/* Landing */
.labrat-landing main { max-width: 640px; margin: 4rem auto; padding: 2rem; text-align: center; }
.labrat-landing h1 { font-size: 2.5rem; margin: 0 0 1rem; color: var(--labrat-accent); }
.labrat-landing p { font-size: 1.1rem; line-height: 1.6; color: var(--labrat-muted); }
.labrat-name { margin: 2rem auto; max-width: 320px; text-align: left; }
.labrat-name label { display: flex; flex-direction: column; gap: 0.4rem; font-weight: 500; }
.labrat-name input {
  font: inherit; padding: 0.6em 0.8em;
  border: 1px solid var(--labrat-border); border-radius: var(--labrat-radius);
}
.labrat-cta { display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap; }
.labrat-cta button {
  font: inherit; padding: 0.7rem 1.4rem;
  border-radius: var(--labrat-radius); cursor: pointer;
  border: 1px solid var(--labrat-border); background: var(--labrat-bg);
}
.labrat-ghost { color: var(--labrat-fg); }

/* Quiz */
.labrat-quiz main { max-width: 640px; margin: 3rem auto; padding: 2rem; }
.labrat-quiz h2 { font-size: 1.6rem; margin: 0 0 0.5rem; }
.labrat-quiz-hint { color: var(--labrat-muted); margin: 0 0 1.5rem; }
.labrat-chip-grid { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.labrat-chip {
  font: inherit; padding: 0.6rem 1rem;
  border: 1.5px solid var(--labrat-border); border-radius: 999px;
  background: var(--labrat-bg); cursor: pointer; color: var(--labrat-fg);
}
.labrat-chip.on { background: var(--labrat-accent); color: white; border-color: var(--labrat-accent); }
.labrat-radio-list { display: flex; flex-direction: column; gap: 0.5rem; margin: 1.5rem 0; }
.labrat-radio-list label {
  padding: 0.75rem 1rem; border: 1px solid var(--labrat-border);
  border-radius: var(--labrat-radius); cursor: pointer;
  display: flex; align-items: center; gap: 0.75rem;
}
.labrat-radio-list label:hover { background: #f6f8fa; }
.labrat-quiz-nav { display: flex; justify-content: space-between; margin-top: 2rem; }
.labrat-quiz-nav button {
  font: inherit; padding: 0.5rem 1rem;
  border: 1px solid var(--labrat-border); background: var(--labrat-bg);
  border-radius: var(--labrat-radius); cursor: pointer;
}

/* Picker */
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
  display: block; padding: 1.25rem;
  border: 1px solid var(--labrat-border); border-radius: var(--labrat-radius);
  text-decoration: none; color: var(--labrat-fg);
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
.labrat-error { padding: 3rem; text-align: center; color: #b42318; }

/* Mission page */
.labrat-mission main { max-width: 760px; margin: 2rem auto; padding: 0 1.5rem; }
.labrat-mission h1 { margin: 0.5rem 0; }
.labrat-mission-meta { display: flex; gap: 1rem; color: var(--labrat-muted); margin-bottom: 1rem; }
.labrat-mission-blurb { font-size: 1.1rem; line-height: 1.5; }
.labrat-setup {
  background: #f6f8fa; padding: 1rem 1.25rem; border-radius: var(--labrat-radius);
  border: 1px solid var(--labrat-border); margin: 1.5rem 0;
}
.labrat-setup h2 { margin: 0 0 0.5rem; font-size: 1rem; }
.labrat-button {
  display: inline-block; padding: 0.6rem 1rem;
  border-radius: var(--labrat-radius); text-decoration: none;
}
.labrat-step-list { list-style: none; padding: 0; }
.labrat-step-list li {
  display: flex; align-items: flex-start; gap: 0.5rem;
  padding: 0.6rem 0; border-bottom: 1px solid var(--labrat-border);
}
.labrat-step-list li.done strong { text-decoration: line-through; color: var(--labrat-muted); }
.labrat-step-list label { display: flex; align-items: flex-start; gap: 0.6rem; flex: 1; cursor: pointer; }
.labrat-step-list input[type=checkbox] { margin-top: 0.3em; width: 18px; height: 18px; accent-color: var(--labrat-accent); }
.labrat-step-list em { font-style: italic; color: var(--labrat-muted); font-weight: normal; }
.labrat-bug-btn {
  font: inherit; font-size: 0.8rem; padding: 0.2em 0.6em;
  border: 1px solid #ffcdd2; background: #fff1f0; color: #86181d;
  border-radius: 4px; cursor: pointer; white-space: nowrap;
}
.labrat-mission-actions { display: flex; justify-content: space-between; margin: 2rem 0 1rem; }
.labrat-mission-actions button {
  font: inherit; padding: 0.7rem 1.4rem;
  border: 1px solid var(--labrat-border); background: var(--labrat-bg);
  border-radius: var(--labrat-radius); cursor: pointer;
}
.labrat-mission-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.labrat-stale-link { text-align: center; margin: 2rem 0 4rem; color: var(--labrat-muted); font-size: 0.9rem; }
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/labrat/BugDialog.js client/src/pages/labrat/labrat.css
git commit -m "feat(labrat): BugDialog component + full styles"
```

---

### Task 12: Landing + Quiz components

**Files:**
- Create: `client/src/pages/labrat/LabRatLanding.js`
- Create: `client/src/pages/labrat/LabRatQuiz.js`

- [ ] **Step 1: Landing**

```js
// client/src/pages/labrat/LabRatLanding.js
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './labrat.css';

const NAME_KEY = 'labrat-tester-name';

export default function LabRatLanding() {
  const navigate = useNavigate();
  const [name, setName] = useState('');

  useEffect(() => { setName(localStorage.getItem(NAME_KEY) || ''); }, []);

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
              type="text" value={name} maxLength={60}
              placeholder="So we know who broke what"
              onChange={e => setName(e.target.value)}
            />
          </label>
        </div>
        <div className="labrat-cta">
          <button className="labrat-primary"
            onClick={() => { persistName(); navigate('/labrat/quiz'); }}>
            Take a quick quiz →
          </button>
          <button className="labrat-ghost"
            onClick={() => { persistName(); navigate('/labrat/missions'); }}>
            Show me the missions
          </button>
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Quiz**

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
  { value: 5,   label: 'Just a few minutes' },
  { value: 20,  label: '15–20 minutes' },
  { value: 60,  label: '30–60 minutes' },
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

  const surfacesAdmin = areas.includes('admin') || areas.includes('surprise');

  function toggleArea(id) {
    setAreas(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function submit() {
    const params = new URLSearchParams();
    const expandSurprise = areas.includes('surprise')
      ? ['customer', 'applicant', 'staff', 'admin', 'mobile', 'edge']
      : areas;
    params.set('areas', expandSurprise.filter(a => a !== 'surprise').join(','));
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
                <button key={o.id} type="button"
                  className={`labrat-chip ${areas.includes(o.id) ? 'on' : ''}`}
                  onClick={() => toggleArea(o.id)}>{o.label}</button>
              ))}
            </div>
            <div className="labrat-quiz-nav">
              <button onClick={() => navigate('/labrat')}>← Back</button>
              <button className="labrat-primary" disabled={!areas.length}
                onClick={() => setStep(2)}>Next →</button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h2>How much time do you have?</h2>
            <div className="labrat-radio-list">
              {TIME_OPTIONS.map(o => (
                <label key={o.value}>
                  <input type="radio" name="time" checked={timeBudget === o.value}
                    onChange={() => setTimeBudget(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
            <div className="labrat-quiz-nav">
              <button onClick={() => setStep(1)}>← Back</button>
              <button className="labrat-primary" disabled={timeBudget == null}
                onClick={() => surfacesAdmin ? setStep(3) : submit()}>
                {surfacesAdmin ? 'Next →' : 'Show missions →'}
              </button>
            </div>
          </>
        )}
        {step === 3 && surfacesAdmin && (
          <>
            <h2>Comfortable with admin / back-office tools?</h2>
            <div className="labrat-radio-list">
              {COMFORT_OPTIONS.map(o => (
                <label key={o.value}>
                  <input type="radio" name="comfort" checked={adminComfort === o.value}
                    onChange={() => setAdminComfort(o.value)} />
                  {o.label}
                </label>
              ))}
            </div>
            <div className="labrat-quiz-nav">
              <button onClick={() => setStep(2)}>← Back</button>
              <button className="labrat-primary" disabled={!adminComfort}
                onClick={submit}>Show missions →</button>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add client/src/pages/labrat/LabRatLanding.js client/src/pages/labrat/LabRatQuiz.js
git commit -m "feat(labrat): landing + 3-question quiz components"
```

---

### Task 13: Picker + Mission page + wire routes

**Files:**
- Create: `client/src/pages/labrat/LabRatMissions.js`
- Create: `client/src/pages/labrat/LabRatMission.js`
- Modify: `client/src/App.js`

- [ ] **Step 1: Picker**

```js
// client/src/pages/labrat/LabRatMissions.js
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../../utils/api';
import './labrat.css';

const COMPLETED_KEY = 'labrat-completed-ids';

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
  { label: 'Half Hour',            test: m => m.estMinutes > 10 && m.estMinutes <= 30 },
  { label: 'Long Haul',            test: m => m.estMinutes > 30 },
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
      const areas = (params.get('areas') || '').split(',').filter(Boolean);
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
        label, items: missions.filter(m => m.area === key),
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
        {missions.length === 0 && (
          <p className="labrat-loading">No missions match those filters. <button className="labrat-link" onClick={() => setShowAll(true)}>Show all</button></p>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Mission page**

```js
// client/src/pages/labrat/LabRatMission.js
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import api from '../../utils/api';
import BugDialog from './BugDialog';
import './labrat.css';

const COMPLETED_KEY = 'labrat-completed-ids';
const NAME_KEY = 'labrat-tester-name';

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
    setChecked({}); setSeedResult(null); setSeedError(null);
    api.get(`/qa/missions/${id}`).then(r => {
      setMission(r.data.mission);
      if (r.data.mission.seedRecipe) {
        api.post('/qa/seed', { recipe: r.data.mission.seedRecipe })
          .then(s => setSeedResult(s.data))
          .catch(e => setSeedError(e?.response?.data?.error || 'Could not set up the test data — flag this as a bug.'));
      }
    }).catch(e => setError(e?.response?.data?.error || 'Mission not found'));
  }, [id]);

  const toggle = useCallback((i) => {
    setChecked(prev => ({ ...prev, [i]: !prev[i] }));
  }, []);

  function openBug(stepIndex, stepText) {
    setDialog({ kind: 'bug', stepIndex, where: `${mission.title} — Step ${stepIndex + 1}`, didWhat: stepText });
  }
  function openConfusion() {
    setDialog({ kind: 'confusion', stepIndex: null, where: mission.title, didWhat: '' });
  }
  function openStale() {
    setDialog({ kind: 'mission-stale', stepIndex: null, where: mission.title, didWhat: '' });
  }

  async function done() {
    await api.post('/qa/complete', { missionId: id, testerName });
    let list = [];
    try { list = JSON.parse(localStorage.getItem(COMPLETED_KEY) || '[]'); } catch { /* ignore */ }
    if (!list.includes(id)) {
      list.push(id);
      localStorage.setItem(COMPLETED_KEY, JSON.stringify(list));
    }
    navigate('/labrat/missions');
  }

  if (error) return <div data-app="labrat" className="labrat-error">{error}</div>;
  if (!mission) return <div data-app="labrat" className="labrat-loading">Loading…</div>;

  const allChecked = mission.steps.every((_, i) => checked[i]);

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
            {seedResult && seedResult.proposalUrl && (
              <>
                <p>✓ We made you a fake proposal in Sent state.</p>
                <a className="labrat-primary labrat-button"
                   href={seedResult.proposalUrl} target="_blank" rel="noopener">
                  Open the test proposal →
                </a>
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
          <button className="labrat-primary" disabled={!allChecked} onClick={done}>
            Done — next mission →
          </button>
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

- [ ] **Step 3: Wire routes in `client/src/App.js`**

Add imports near other public-website imports:
```js
import LabRatLanding from './pages/labrat/LabRatLanding';
import LabRatQuiz from './pages/labrat/LabRatQuiz';
import LabRatMissions from './pages/labrat/LabRatMissions';
import LabRatMission from './pages/labrat/LabRatMission';
```

In `function PublicWebsiteRoutes()` (around line 213), inside `<Routes>`, add BEFORE the catch-all `<Route path="*" ...>`:
```jsx
<Route path="/labrat" element={<LabRatLanding />} />
<Route path="/labrat/quiz" element={<LabRatQuiz />} />
<Route path="/labrat/missions" element={<LabRatMissions />} />
<Route path="/labrat/m/:id" element={<LabRatMission />} />
```

- [ ] **Step 4: Commit**

```bash
git add client/src/pages/labrat/LabRatMissions.js client/src/pages/labrat/LabRatMission.js client/src/App.js
git commit -m "feat(labrat): mission picker + mission page + /labrat/* routes wired"
```

---

## Phase 1E — Smoke test

### Task 14: End-to-end smoke test

**Files:** none modified.

- [ ] **Step 1: Start fresh**

```bash
npm run dev
```

- [ ] **Step 2: Walk every flow**

**As a brand-new tester (private window 1):**
1. Visit `http://localhost:3000/labrat` → landing renders with the Be a Lab Rat headline
2. Enter "Smoke 1" as name → click Take a quick quiz
3. Q1: pick "Booking an event as a customer" only → Next
4. Q2: pick "15-20 minutes" → Show missions
5. Verify the picker shows ONLY p0 customer missions (sign-and-pay-deposit, pay-balance, drink-plan-exploration, submit-byob-quote — depending on filters)
6. Click `submit-byob-quote` (no seed) → mission page renders, no Setup section
7. Check off all steps → "Done — next mission" enables → click → returns to picker with the mission marked ✓

**As a new tester wanting admin work (private window 2):**
1. Visit `http://localhost:3000/labrat` → enter "Smoke 2" → Take quiz
2. Q1: "Poking around the admin tools" + "Surprise me"
3. Q2: 30-60 minutes
4. Q3: "Yes, throw me in"
5. Verify p0 admin missions surface (send-a-proposal, etc.) and p0 customer missions also (since "surprise" expanded)
6. Click `sign-and-pay-deposit` → mission page renders, Setup section runs the seed and shows a proposal URL
7. Click the test proposal URL → real proposal page opens in new tab with seeded test data
8. Walk through the steps in that tab; check off each one in the mission tab
9. Click Done → returns to picker

**As Dallas verifying the bug pipeline:**
1. On any mission page, click "report bug" on a step → dialog opens prefilled with where/did
2. Enter "smoke test bug" in What happened → Send → success
3. In a terminal: `npm run bugs:list` → your bug appears under the mission, formatted, readable
4. Click "I'm stuck" on a mission → submit a confusion report → verify it appears via `npm run bugs:list`
5. Click "This mission seems wrong" footer link → submit → verify it appears with `kind=mission-stale`

**Validate the adaptive shortlist:**
1. Hit `/api/qa/complete` for `submit-byob-quote` ten times via curl (simulating crowd graduation):
   ```bash
   for i in 1 2 3 4 5 6 7 8 9 10; do
     curl -X POST http://localhost:5000/api/qa/complete \
       -H "Content-Type: application/json" \
       -d "{\"missionId\":\"submit-byob-quote\",\"testerName\":\"smoke-$i\"}"
   done
   ```
2. Take the quiz again as a fresh tester (clear localStorage first). Pick customer, 30-60 min.
3. Verify `submit-byob-quote` is sorted lower (it has 10+ completions vs 0 for sign-and-pay).

**Validate bug saturation:**
1. Submit 2 bugs against `submit-byob-quote` via the dialog
2. Take the quiz fresh → verify `submit-byob-quote` is NOT in the picker
3. Mark one bug fixed: edit `server/data/tester-bugs/status.json` manually — set `{"<bug-id>": {"status":"fixed"}}`
4. Take the quiz fresh → verify `submit-byob-quote` reappears (open count is now 1, below threshold of 2)

- [ ] **Step 3: Fix any defects discovered**

If anything broke, fix it inline before declaring v1 ready.

- [ ] **Step 4: No commit unless fixes were applied**

---

## Self-review checklist

After execution, verify spec coverage:

- [x] Goal 1 — "<60s start": landing → quiz → picker → mission, no auth (Tasks 12-13)
- [x] Goal 2 — independently startable for customer money flows: `proposal-in-sent` seed (Task 9). Other missions are self-contained or wear-both-hats.
- [x] Goal 3 — coverage spreads: adaptive shortlist with priority + per-tester history + global coverage (Task 8)
- [x] Goal 4 — Claude-readable bug log: JSONL + `bugs:list` (Tasks 1-3)
- [x] Goal 5 — admin path first-class: 4 admin p0 missions (Task 6), gated by Q3 (Task 12)
- [x] Hybrid behavior: bug-saturation pause at N=2, crowd graduation when p0 saturated, per-tester graduation when their p0 exhausted

**Type consistency:** All routes/components use `kind` from `{bug, confusion, mission-stale}`, `area` from `{customer, applicant, staff, admin, mobile, edge}`, `priority` from `{p0, p1, p2}`, `device` from `{desktop, mobile}`. Seed recipe is a single value `'proposal-in-sent'` (the `_shape.js` validator's `VALID_SEED_RECIPES` set has `[null, 'proposal-in-sent']` in Phase 1; Phase 2 will expand this set).

**Phase 2 reminder:** When this Phase 1 ships and proves valuable, the full plan at `docs/superpowers/plans/2026-04-27-tester-program-v2.md` describes the additional 18 missions, more seed recipes, drift detection, the `/labrat-fix` skill, the cleanup scheduler, and the optional auto-advance hack. Do not attempt those in Phase 1.

**Phase 1 cleanup ritual (run before Stripe live cutover):** From a psql session connected to prod:
```sql
-- One-time wipe of all Lab Rat test data right before live mode
DELETE FROM clients WHERE email LIKE '%@labrat.test';
-- Cascading FKs should remove related proposals/drink plans/etc.
-- If not, manually delete from those tables first; verify with:
-- SELECT count(*) FROM proposals WHERE client_id NOT IN (SELECT id FROM clients);
```

---
