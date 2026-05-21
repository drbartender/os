# File-Size Ratchet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the binary file-size hook with a ratchet so files cannot grow past the 1000-line cap, and clear the one imminent file (`crud.js`).

**Architecture:** One Node script (`scripts/check-file-size.js`) drives both modes. In `--staged` mode (the pre-commit hook) it compares each staged file's line count against its count at `HEAD` and fails only when an over-cap file *grows* (the ratchet). In `--all` mode it prints a full-tree RED/YELLOW report. The permanent `// claude-allow-large-file` opt-out marker is retired. Separately, the proposal status-transition handler is extracted from `crud.js` into `lifecycle.js`.

**Tech Stack:** Node.js 18 (CommonJS), git plumbing (`git diff`, `git show`), husky 9 pre-commit hook, `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-05-21-file-size-ratchet-design.md`

**Task order is load-bearing:** Task 1 (script) before Task 2 (hook calls the script) before Task 3 (marker removal: under the old hook, removing a marker from an over-cap file would hard-fail; under the new ratchet it is an allowed shrink).

---

## Task 1: The `check-file-size.js` script

**Files:**
- Create: `scripts/check-file-size.js`
- Create: `scripts/check-file-size.test.js`
- Modify: `README.md` (folder-structure tree)

The pure logic (line counting, scope matching, the ratchet decision) is unit-tested. The git plumbing and the filesystem walk are exercised by smoke tests in this task and Task 2, because they depend on real git state and cannot be meaningfully unit-tested without a throwaway repo fixture.

- [ ] **Step 1: Write the failing test**

Create `scripts/check-file-size.test.js`:

```javascript
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inScope, countLines, classify, bucket } = require('./check-file-size');

// ── countLines ──
test('countLines counts newline characters like wc -l', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one line, no trailing newline'), 0);
  assert.equal(countLines('a\nb'), 1);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('a\r\nb\r\n'), 2); // CRLF: the \n still counts
  assert.equal(countLines('\n\n\n'), 3);
});

// ── inScope ──
test('inScope matches server/ and client/src/ js + jsx', () => {
  assert.equal(inScope('server/routes/stripe.js'), true);
  assert.equal(inScope('client/src/pages/Foo.jsx'), true);
  assert.equal(inScope('client/src/App.js'), true);
});

test('inScope rejects test files, other dirs, and non-js', () => {
  assert.equal(inScope('server/routes/stripe.test.js'), false);
  assert.equal(inScope('server/routes/crud.test.jsx'), false);
  assert.equal(inScope('scripts/check-file-size.js'), false);
  assert.equal(inScope('server/db/schema.sql'), false);
  assert.equal(inScope('client/public/index.html'), false);
  assert.equal(inScope('docs/foo.js'), false);
  assert.equal(inScope('server\\routes\\stripe.js'), false); // backslash paths never match; callers pass forward slashes
});

// ── classify (the ratchet decision) ──
test('classify fails an over-cap file that grows', () => {
  assert.equal(classify(1001, 1000), 'fail');
  assert.equal(classify(1736, 1735), 'fail');
});

test('classify allows an over-cap file that is flat or shrinking', () => {
  assert.equal(classify(1736, 1736), 'note'); // flat
  assert.equal(classify(1734, 1736), 'note'); // shrinking
});

test('classify fails a brand-new file born over the cap (old = 0)', () => {
  assert.equal(classify(1100, 0), 'fail');
});

test('classify warns in the soft-cap zone regardless of direction', () => {
  assert.equal(classify(800, 0), 'warn');
  assert.equal(classify(800, 750), 'warn');
  assert.equal(classify(1000, 999), 'warn'); // exactly 1000 is NOT over the hard cap
});

test('classify is silent under the soft cap', () => {
  assert.equal(classify(699, 0), 'ok');
  assert.equal(classify(700, 0), 'ok'); // exactly 700 is NOT over the soft cap
});

// ── bucket (the --all report) ──
test('bucket sorts a snapshot count into red / yellow / green', () => {
  assert.equal(bucket(1736), 'red');
  assert.equal(bucket(1001), 'red');
  assert.equal(bucket(1000), 'yellow');
  assert.equal(bucket(701), 'yellow');
  assert.equal(bucket(700), 'green');
  assert.equal(bucket(120), 'green');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/check-file-size.test.js`
Expected: FAIL with `Cannot find module './check-file-size'`.

- [ ] **Step 3: Write the script**

Create `scripts/check-file-size.js`:

```javascript
'use strict';

// File-size guard. Two modes:
//   --staged : ratchet check for the pre-commit hook. A file over the hard cap
//              fails ONLY if this commit makes it longer than it is at HEAD.
//   --all    : full-tree RED / YELLOW report. Always exits 0.
// Thresholds, scope, and line counting are defined once and shared by both.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WARN_LIMIT = 700;
const FAIL_LIMIT = 1000;

// Source files the guard governs: server/ and client/src/ .js/.jsx, never tests.
// Matched against forward-slash paths: git emits them on every OS, and --all
// normalizes the filesystem walk to them before matching.
const SCOPE_RE = /^(server|client\/src)\/.+\.(js|jsx)$/;
const TEST_RE = /\.test\.(js|jsx)$/;

function inScope(relPath) {
  return SCOPE_RE.test(relPath) && !TEST_RE.test(relPath);
}

// Count lines the way `wc -l` does: the number of newline characters.
function countLines(content) {
  if (!content) return 0;
  let n = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') n += 1;
  }
  return n;
}

// Ratchet verdict for a staged file, from its new (staged) and old (HEAD) counts.
//   'fail' : over the hard cap AND this commit grows it
//   'note' : over the hard cap but flat or shrinking, so allowed
//   'warn' : in the soft-cap zone, non-blocking
//   'ok'   : under the soft cap
function classify(newCount, oldCount) {
  if (newCount > FAIL_LIMIT) {
    return newCount > oldCount ? 'fail' : 'note';
  }
  if (newCount > WARN_LIMIT) return 'warn';
  return 'ok';
}

// Absolute bucket for the --all report: a snapshot has no "old" to compare.
function bucket(count) {
  if (count > FAIL_LIMIT) return 'red';
  if (count > WARN_LIMIT) return 'yellow';
  return 'green';
}

module.exports = { inScope, countLines, classify, bucket, WARN_LIMIT, FAIL_LIMIT };

// ─── git helpers (used only when run as a script) ───────────────────────────

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

// Line count of a file in the index (the staged blob).
function countStaged(relPath) {
  return countLines(git(['show', `:${relPath}`]));
}

// Line count of a file at HEAD. Returns 0 when the path is absent at HEAD (a
// newly added file, or the new name of a rename): `git show` exits non-zero in
// that case, and an uncaught throw would abort the whole pre-commit hook.
function countHeadOrZero(headPath) {
  try {
    return countLines(git(['show', `HEAD:${headPath}`]));
  } catch {
    return 0;
  }
}

// Staged source files, as { path, headPath }. `git diff --name-status -M`
// prints "R<score>\t<old>\t<new>" for renames and "<status>\t<path>" otherwise.
// For a rename, headPath is the OLD path so the HEAD lookup reads the
// pre-rename size and the rename is not misread as growth.
function stagedSourceFiles() {
  const out = git(['diff', '--cached', '--name-status', '--diff-filter=ACMR', '-M']);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    let p;
    let headPath;
    if (status[0] === 'R' || status[0] === 'C') {
      p = parts[2];
      headPath = parts[1];
    } else {
      p = parts[1];
      headPath = parts[1];
    }
    if (inScope(p)) files.push({ path: p, headPath });
  }
  return files;
}

// ─── modes ──────────────────────────────────────────────────────────────────

function runStaged() {
  const fails = [];
  const infos = [];
  for (const { path: p, headPath } of stagedSourceFiles()) {
    const newCount = countStaged(p);
    const oldCount = countHeadOrZero(headPath);
    const verdict = classify(newCount, oldCount);
    if (verdict === 'fail') {
      fails.push(`FAIL  ${p}: ${newCount} lines (was ${oldCount} at HEAD); over the ${FAIL_LIMIT}-line hard cap and growing.`);
    } else if (verdict === 'note') {
      infos.push(`note  ${p}: ${newCount} lines (over the cap but not growing; allowed).`);
    } else if (verdict === 'warn') {
      infos.push(`WARN  ${p}: ${newCount} lines (soft cap ${WARN_LIMIT}); plan a split.`);
    }
  }
  for (const line of infos) console.log(line);
  for (const line of fails) console.error(line);
  if (fails.length > 0) {
    console.error('');
    console.error(`${fails.length} file(s) over the ${FAIL_LIMIT}-line hard cap and growing.`);
    console.error('Split the file, or extract the new code to a sibling module, so this');
    console.error('commit does not make it longer. Genuine emergency: git commit --no-verify.');
    process.exitCode = 1;
  }
}

function walkSource(dirRel, acc) {
  const abs = path.join(ROOT, dirRel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const childRel = `${dirRel}/${entry.name}`; // forward slash, always
    if (entry.isDirectory()) {
      walkSource(childRel, acc);
    } else if (inScope(childRel)) {
      acc.push(childRel);
    }
  }
}

function runAll() {
  const files = [];
  walkSource('server', files);
  walkSource('client/src', files);
  const red = [];
  const yellow = [];
  for (const relPath of files) {
    const count = countLines(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
    const b = bucket(count);
    if (b === 'red') red.push({ relPath, count });
    else if (b === 'yellow') yellow.push({ relPath, count });
  }
  red.sort((a, b2) => b2.count - a.count);
  yellow.sort((a, b2) => b2.count - a.count);
  console.log(`File-size report: ${files.length} source files scanned`);
  console.log('');
  console.log(`RED (over ${FAIL_LIMIT}, must split): ${red.length}`);
  for (const r of red) console.log(`  ${String(r.count).padStart(5)}  ${r.relPath}`);
  console.log('');
  console.log(`YELLOW (${WARN_LIMIT} to ${FAIL_LIMIT}, plan a split): ${yellow.length}`);
  for (const y of yellow) console.log(`  ${String(y.count).padStart(5)}  ${y.relPath}`);
}

if (require.main === module) {
  try {
    if (process.argv.includes('--all')) runAll();
    else runStaged();
  } catch (err) {
    // Fail closed: if the guard itself errors, block the commit with a clear
    // message rather than crashing the hook with a raw stack trace or, worse,
    // letting the commit through. Catches any unexpected throw, including one
    // from countStaged (whose git call, unlike countHeadOrZero, has no
    // expected failure mode and so is intentionally left unwrapped).
    console.error(`check-file-size: unexpected error: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/check-file-size.test.js`
Expected: PASS, all tests green.

- [ ] **Step 5: Smoke-test the `--all` report**

Run: `node scripts/check-file-size.js --all`
Expected: a report listing `RED (over 1000, must split): 3` with `stripe.js`, `drinkPlans.js`, `ProposalCreate.js`, and `YELLOW (...)` with roughly 11 files including `crud.js` and `emailTemplates.js`. Exit code 0.

- [ ] **Step 6: Add the script to the README folder tree**

In `README.md`, find the `scripts/` line in the folder-structure tree. It is a single line with a parenthetical list of scripts:

`├── scripts/                    # Build scripts (build-testing-guide.js, testing-guide-template.html)`

Add `check-file-size.js` to that parenthetical so it reads:

`├── scripts/                    # Build scripts (build-testing-guide.js, check-file-size.js, testing-guide-template.html)`

- [ ] **Step 7: Commit**

```bash
git add scripts/check-file-size.js scripts/check-file-size.test.js README.md
git commit -m "feat(tooling): ratcheting file-size guard script"
```

---

## Task 2: Wire the ratchet into the pre-commit hook

**Files:**
- Modify: `.husky/pre-commit`
- Delete: `.husky/check-file-size.sh`
- Modify: `package.json` (scripts)
- Modify: `README.md` (NPM Scripts table)

- [ ] **Step 1: Replace the size check in `.husky/pre-commit`**

The current `.husky/pre-commit` is:

```sh
#!/usr/bin/env sh
bash scripts/check-docs-drift.sh
sh .husky/check-file-size.sh
npx lint-staged
```

Replace the middle line so the file becomes exactly:

```sh
#!/usr/bin/env sh
bash scripts/check-docs-drift.sh
node scripts/check-file-size.js --staged || exit 1
npx lint-staged
```

The `|| exit 1` makes the abort explicit: the hook is a plain `sh` script with no `set -e`, so without it a non-zero size check would not reliably stop the commit (the hook's exit code would be `lint-staged`'s).

- [ ] **Step 2: Delete the old shell guard**

`.husky/check-file-size.sh` is now unreferenced. Removing it is a tracked-file deletion: per CLAUDE.md Rule 11, get explicit approval before running this.

```bash
git rm .husky/check-file-size.sh
```

- [ ] **Step 3: Add the `check:filesize` npm script**

In `package.json`, in the `scripts` block, add a line immediately after `"audit:check": "npm audit --omit=dev || true",`:

```json
    "check:filesize": "node scripts/check-file-size.js --all",
```

- [ ] **Step 4: Update README — NPM Scripts table and the `.husky` folder tree**

In `README.md`, find the NPM Scripts table and add a row matching the existing column layout:

```
| `npm run check:filesize` | Report every source file by line-count zone (RED over 1000, YELLOW 700-1000) |
```

Then, in the folder-structure tree, the `.husky` block has these two lines:

`├── .husky/pre-commit           # Pre-commit hook (docs-drift check + file-size guard + lint-staged)`
`├── .husky/check-file-size.sh   # Pre-commit guard — warns at 700 lines, blocks at 1000`

`.husky/check-file-size.sh` is deleted in Step 2. Delete its tree line entirely, and update the `pre-commit` line so the block becomes the single line:

`├── .husky/pre-commit           # Pre-commit hook (docs-drift check + file-size ratchet + lint-staged)`

- [ ] **Step 5: Smoke-test the gate blocks a growing over-cap file**

Append one line to an over-cap file, stage it, and confirm a commit attempt is rejected:

```bash
echo "// size-ratchet smoke test" >> server/routes/stripe.js
git add server/routes/stripe.js
git commit -m "TEMP: ratchet smoke test"
```

Expected: the commit is rejected. The hook prints `FAIL  server/routes/stripe.js: <N> lines (was <N-1> at HEAD); over the 1000-line hard cap and growing.`

Now revert the scratch change completely:

```bash
git restore --staged server/routes/stripe.js
git restore server/routes/stripe.js
git status --short
```

Expected: `git status --short` shows `stripe.js` is clean (no staged or unstaged change).

- [ ] **Step 6: Smoke-test the gate allows an in-scope, in-bounds change**

```bash
node scripts/check-file-size.js --staged
```

with nothing staged: Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

The new hook runs on this very commit. The staged files (`.husky/pre-commit`, `package.json`, `README.md`, and the `.husky/check-file-size.sh` deletion) are all outside the `server/` `client/src/` scope, so the ratchet finds nothing to check and exits 0.

```bash
git add .husky/pre-commit .husky/check-file-size.sh package.json README.md
git commit -m "feat(tooling): replace file-size hook with the ratchet, add check:filesize"
```

---

## Task 3: Retire the `claude-allow-large-file` markers

**Files:**
- Modify: `server/routes/stripe.js`
- Modify: `server/routes/drinkPlans.js`
- Modify: `client/src/pages/admin/ProposalCreate.js`
- Modify: `client/src/pages/staff/PrintTipCard.layouts.jsx`

The new script does not recognize the marker. Removing it only shortens each file, so the ratchet classifies every one of these commits as `note` (over the cap, not growing) and allows it. This commit is itself the live proof that "over-cap shrinking is allowed."

- [ ] **Step 1: Remove the marker from `server/routes/stripe.js`**

Edit `server/routes/stripe.js`. Replace:

```javascript
// claude-allow-large-file
// Reason: single Stripe surface — customer/intent helpers, deposit/full-pay, drink-plan extras, invoice payments, webhook handler. Splitting deferred; not justified by a 2-line bugfix.
const express = require('express');
```

with:

```javascript
const express = require('express');
```

- [ ] **Step 2: Remove the marker from `server/routes/drinkPlans.js`**

Edit `server/routes/drinkPlans.js`. Replace:

```javascript
// claude-allow-large-file
// Reason: single-resource router for drink_plans. Splitting by sub-resource (token/admin/logo)
// would scatter shared rate limiters, error types, and JSONB merge patterns across files.
const express = require('express');
```

with:

```javascript
const express = require('express');
```

- [ ] **Step 3: Remove the marker from `client/src/pages/admin/ProposalCreate.js`**

Edit `client/src/pages/admin/ProposalCreate.js`. Replace:

```javascript
// claude-allow-large-file
// Reason: admin proposal-create page bundles the create form, section helpers (Client/Event/Package/Staffing/Send), pricing dock, and field-status logic. Splitting belongs in a separate refactor — not money-math commits.
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
```

with:

```javascript
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
```

- [ ] **Step 4: Remove the marker from `client/src/pages/staff/PrintTipCard.layouts.jsx`**

Edit `client/src/pages/staff/PrintTipCard.layouts.jsx`. Replace:

```javascript
// claude-allow-large-file
// Reason: verbatim port of the print-tip-card design system (qr-print.jsx) — single concern is the design
//
// PrintTipCard.layouts.jsx — print-ready frames for the bartender's QR display.
```

with:

```javascript
// PrintTipCard.layouts.jsx — print-ready frames for the bartender's QR display.
```

- [ ] **Step 5: Verify the ratchet allows the shrink**

Stage all four files and dry-run the staged check:

```bash
git add server/routes/stripe.js server/routes/drinkPlans.js client/src/pages/admin/ProposalCreate.js client/src/pages/staff/PrintTipCard.layouts.jsx
node scripts/check-file-size.js --staged
```

Expected: `note` lines for `stripe.js`, `drinkPlans.js`, `ProposalCreate.js` (over cap, not growing); no `FAIL`; exit code 0. `PrintTipCard.layouts.jsx` is now under 700 and prints nothing.

- [ ] **Step 6: Commit**

```bash
git commit -m "chore(tooling): retire claude-allow-large-file markers, superseded by the ratchet"
```

---

## Task 4: Surface the size report in overnight-review

**Files:**
- Modify: `.claude/commands/overnight-review.md`

The nightly review should report the frozen backlog so it stays visible. The scan is report-only: it runs `npm run check:filesize`, which only reads files and exits 0.

- [ ] **Step 1: Add a scan step after Step 1**

In `.claude/commands/overnight-review.md`, immediately after the `## Step 1 — Run 5 agents in parallel` section and before `## Step 2 — Triage every finding`, insert:

```markdown
## Step 1.5 — File-size scan (report-only)

Run `npm run check:filesize` and capture its output. This is informational
only: it never fails the run and produces no fixes. The RED / YELLOW lists go
verbatim into the `## File-size report` section of the log (Step 4). Do not
attempt to split any file: that is human-judgment work, never an overnight
auto-fix.
```

- [ ] **Step 2: Add the log section to the Step 4 template**

In the Step 4 log structure (the fenced block), add a new section immediately after the `## Sentry — top unresolved (at start of run)` block and before `## Auto-fixed (committed)`:

```markdown
## File-size report
RED (over 1000): <count>
- <lines>  <path>
YELLOW (700-1000): <count>
- <lines>  <path>
(verbatim from `npm run check:filesize`)
```

- [ ] **Step 3: Commit**

```bash
git add .claude/commands/overnight-review.md
git commit -m "docs(tooling): report file-size zones in overnight-review"
```

---

## Task 5: Split `crud.js` into `crud.js` + `lifecycle.js`

**Files:**
- Create: `server/routes/proposals/lifecycle.js`
- Modify: `server/routes/proposals/crud.js`
- Modify: `server/routes/proposals/index.js`
- Modify: `server/routes/proposals/crud.test.js`
- Modify: `README.md` (folder-structure tree)

`crud.js` (990 lines) is a grab-bag of 11 route handlers. Extract the `PATCH /:id/status` handler and its `STATUS_TRANSITIONS` table into `lifecycle.js`. The money-critical handlers (`POST /`, `PATCH /:id`, `POST /:id/record-payment`) are not touched. This is a behavior-preserving move; `crud.test.js` cases 10/11/12 are the safety net.

ARCHITECTURE.md needs no change: its proposals section is a route-keyed table (Method / Path / Auth / Description) with no source-file column, and `PATCH /api/proposals/:id/status` is itself unchanged. Verified during plan review.

- [ ] **Step 1: Confirm the test baseline is green before touching anything**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: all 12 cases pass. (This suite runs against the dev database via `DATABASE_URL`; the dev server does not need to be running.) If anything is red here, stop: the move must start from green.

- [ ] **Step 2: Create `server/routes/proposals/lifecycle.js`**

Create the file with this exact scaffolding. The handler body is a verbatim move performed in Step 3, marked below.

```javascript
const express = require('express');
const { pool } = require('../../db');
const { auth, requireAdminOrManager } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { ValidationError, NotFoundError } = require('../../utils/errors');
const { adminWriteLimiter } = require('../../middleware/rateLimiters');
const { createInvoiceOnSend } = require('../../utils/invoiceHelpers');
const { sendProposalSentEmail } = require('../../utils/sendProposalSentEmail');

const router = express.Router();

// Dependency seam for tests — see crud.js for the rationale. lifecycle.js
// carries its own copy because the PATCH /:id/status handler lives here.
// createInvoiceOnSend runs INSIDE the status transaction; sendProposalSentEmail
// runs AFTER commit. crud.test.js stubs both to count emails and to force an
// invoice failure that must roll the status change back.
let _deps = { createInvoiceOnSend, sendProposalSentEmail };
function __setDeps(d) { _deps = { ..._deps, ...d }; }

// Status state machine — enforced on PATCH /:id/status unless ?force=true (admin only).
// Transitions are one-way except for admin-backed corrections via force.
// `archived` is the soft-terminal bucket: shelf for duplicates/abandoned/client-cancelled
// proposals before payment. Recoverable — `archived → draft` brings it back into the active
// pipeline. Not reachable from paid statuses (deposit_paid/balance_paid/confirmed/completed) —
// those reflect real money and archiving them via a state transition would desync the ledger.
// Admins can ?force=true to bypass for ledger-corrected refunds.
const STATUS_TRANSITIONS = {
  draft:        ['sent', 'archived'],
  sent:         ['viewed', 'accepted', 'modified', 'draft', 'archived'],
  viewed:       ['accepted', 'modified', 'sent', 'archived'],
  modified:     ['sent', 'accepted', 'archived'],
  accepted:     ['deposit_paid', 'confirmed', 'archived'],
  deposit_paid: ['balance_paid', 'confirmed', 'completed'],
  balance_paid: ['completed'],
  confirmed:    ['completed', 'deposit_paid', 'balance_paid'],
  completed:    [],
  archived:     ['draft'],
};

// >>> Step 3 pastes the PATCH /:id/status handler here. <<<

module.exports = router;
// Dependency seam for tests — attached to the router export so the proposals
// composition router still mounts cleanly (Express ignores extra properties).
module.exports.__setDeps = __setDeps;
```

- [ ] **Step 3: Move the handler from `crud.js` into `lifecycle.js`**

In `crud.js`, the status route is the block from the comment `/** PATCH /api/proposals/:id/status — update status. Enforce state machine unless ?force=true (admin-only) */` through the handler's closing `}));` (currently `crud.js` lines 630-730).

Cut that block verbatim from `crud.js` and paste it into `lifecycle.js` at the `>>> Step 3 <<<` marker line, replacing the marker. Do not modify a single character of the handler: it is a pure move. The handler references `express`/`pool`/`auth`/`requireAdminOrManager`/`adminWriteLimiter`/`asyncHandler`/`ValidationError`/`NotFoundError`/`STATUS_TRANSITIONS`/`_deps` — all are provided by the Step 2 scaffolding.

- [ ] **Step 4: Remove `STATUS_TRANSITIONS` from `crud.js`**

In `crud.js`, replace this block (the `// Status state machine` comment through the const, plus the line that follows it):

```javascript
// Status state machine — enforced on PATCH /:id/status unless ?force=true (admin only).
// Transitions are one-way except for admin-backed corrections via force.
// `archived` is the soft-terminal bucket: shelf for duplicates/abandoned/client-cancelled
// proposals before payment. Recoverable — `archived → draft` brings it back into the active
// pipeline. Not reachable from paid statuses (deposit_paid/balance_paid/confirmed/completed) —
// those reflect real money and archiving them via a state transition would desync the ledger.
// Admins can ?force=true to bypass for ledger-corrected refunds.
const STATUS_TRANSITIONS = {
  draft:        ['sent', 'archived'],
  sent:         ['viewed', 'accepted', 'modified', 'draft', 'archived'],
  viewed:       ['accepted', 'modified', 'sent', 'archived'],
  modified:     ['sent', 'accepted', 'archived'],
  accepted:     ['deposit_paid', 'confirmed', 'archived'],
  deposit_paid: ['balance_paid', 'confirmed', 'completed'],
  balance_paid: ['completed'],
  confirmed:    ['completed', 'deposit_paid', 'balance_paid'],
  completed:    [],
  archived:     ['draft'],
};

const TOTAL_PRICE_OVERRIDE_MAX = 1_000_000;
```

with:

```javascript
const TOTAL_PRICE_OVERRIDE_MAX = 1_000_000;
```

After Steps 3 and 4, `crud.js` is roughly 870 lines. Its imports are unchanged: `ValidationError`, `ConflictError`, `NotFoundError`, `ExternalServiceError`, and `adminWriteLimiter` are all still used by the handlers that remain (`POST /`, `PATCH /:id`, `record-payment`, `send-reminder`, `create-shift`).

- [ ] **Step 5: Mount `lifecycle.js` in the composition router**

In `server/routes/proposals/index.js`, the current mount block is:

```javascript
router.use('/', require('./publicToken'));
router.use('/', require('./public'));
router.use('/', require('./metadata'));
router.use('/', require('./crud'));
```

Change it to:

```javascript
router.use('/', require('./publicToken'));
router.use('/', require('./public'));
router.use('/', require('./metadata'));
router.use('/', require('./lifecycle'));
router.use('/', require('./crud'));
```

`lifecycle`'s only route is `PATCH /:id/status`. It does not collide with `crud`'s `/:id` (different segment count) or with `metadata`'s static paths, so mount order relative to `crud` is not load-bearing; placing it after `metadata` keeps the dynamic-route files grouped.

- [ ] **Step 6: Update `crud.test.js` to mount and stub the lifecycle router**

Four edits to `server/routes/proposals/crud.test.js`:

**6a.** After the line `const crudRouter = require('./crud');`, add:

```javascript
const lifecycleRouter = require('./lifecycle');
```

**6b.** Replace the `before()` stub block. Find:

```javascript
  // Stub the dependency seam: count emails; optionally fail invoice creation.
  crudRouter.__setDeps({
    // Capture-and-inspect stub — does NOT delegate to the real
    // sendProposalSentEmail. The real function early-returns when client_email
    // is missing, so delegating would let a false-green slip through (counter
    // ticks, zero emails produced). Instead we capture the proposal the handler
    // passed so Case 1 can assert it was enriched (has a real recipient).
    sendProposalSentEmail: (proposal) => {
      emailCalls += 1;
      lastEmailProposal = proposal;
      return Promise.resolve();
    },
    createInvoiceOnSend: (...args) => {
      if (invoiceThrowsRemaining > 0) {
        invoiceThrowsRemaining -= 1;
        return Promise.reject(new Error('simulated invoice failure'));
      }
      return realCreateInvoiceOnSend(...args);
    },
  });
```

Replace it with (extract the stub object, apply it to both routers):

```javascript
  // Stub the dependency seam: count emails; optionally fail invoice creation.
  // Applied to BOTH routers — POST / lives in crud, PATCH /:id/status in
  // lifecycle, and each carries its own _deps seam.
  const stubDeps = {
    // Capture-and-inspect stub — does NOT delegate to the real
    // sendProposalSentEmail. The real function early-returns when client_email
    // is missing, so delegating would let a false-green slip through (counter
    // ticks, zero emails produced). Instead we capture the proposal the handler
    // passed so Case 1 can assert it was enriched (has a real recipient).
    sendProposalSentEmail: (proposal) => {
      emailCalls += 1;
      lastEmailProposal = proposal;
      return Promise.resolve();
    },
    createInvoiceOnSend: (...args) => {
      if (invoiceThrowsRemaining > 0) {
        invoiceThrowsRemaining -= 1;
        return Promise.reject(new Error('simulated invoice failure'));
      }
      return realCreateInvoiceOnSend(...args);
    },
  };
  crudRouter.__setDeps(stubDeps);
  lifecycleRouter.__setDeps(stubDeps);
```

**6c.** After the line `app.use('/api/proposals', crudRouter);`, add:

```javascript
  app.use('/api/proposals', lifecycleRouter);
```

**6d.** Replace the `after()` teardown restore block. Find:

```javascript
  // Restore real deps and close the server / pool.
  crudRouter.__setDeps({
    sendProposalSentEmail: realSendProposalSentEmail,
    createInvoiceOnSend: realCreateInvoiceOnSend,
  });
```

Replace it with:

```javascript
  // Restore real deps and close the server / pool.
  const realDeps = {
    sendProposalSentEmail: realSendProposalSentEmail,
    createInvoiceOnSend: realCreateInvoiceOnSend,
  };
  crudRouter.__setDeps(realDeps);
  lifecycleRouter.__setDeps(realDeps);
```

- [ ] **Step 7: Update the harness-notes comment in `crud.test.js`**

In the `HARNESS NOTES` comment block near the top, find the sentence `it mounts the real \`crud\` router on a fresh express() app with the` and change `the real \`crud\` router` to `the real \`crud\` and \`lifecycle\` routers`.

- [ ] **Step 8: Run the test to verify the move is behavior-preserving**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: all 12 cases pass. Cases 10, 11, 12 (`PATCH /:id/status`: send, re-send, invoice-failure rollback) are the proof the money path survived the move.

- [ ] **Step 9: Update the README folder tree**

In `README.md`, the `proposals/` folder-tree block has these lines:

```
│   │   ├── proposals/          # Service proposals (publicToken/public/metadata/crud sub-routers)
│   │   │   ├── index.js        # Composition router
│   │   │   ├── publicToken.js  # /t/:token view + sign
│   │   │   ├── public.js       # /public/* — packages, addons, calculate, capture-lead, quote-draft, submit
│   │   │   ├── metadata.js     # /packages, /addons, /calculate, /financials, /dashboard-stats
│   │   │   └── crud.js         # admin CRUD + status/notes/create-shift/balance-due-date/send-reminder/record-payment
```

Make three changes: (a) add `lifecycle` to the `proposals/` parenthetical, (b) insert a `lifecycle.js` entry before `crud.js` (it mounts before `crud` in `index.js`), (c) drop `status` from the `crud.js` description, since that route moved. The block becomes:

```
│   │   ├── proposals/          # Service proposals (publicToken/public/metadata/lifecycle/crud sub-routers)
│   │   │   ├── index.js        # Composition router
│   │   │   ├── publicToken.js  # /t/:token view + sign
│   │   │   ├── public.js       # /public/* — packages, addons, calculate, capture-lead, quote-draft, submit
│   │   │   ├── metadata.js     # /packages, /addons, /calculate, /financials, /dashboard-stats
│   │   │   ├── lifecycle.js    # Proposal status state machine (PATCH /:id/status)
│   │   │   └── crud.js         # admin CRUD + notes/create-shift/balance-due-date/send-reminder/record-payment
```

- [ ] **Step 10: Commit**

```bash
git add server/routes/proposals/lifecycle.js server/routes/proposals/crud.js server/routes/proposals/index.js server/routes/proposals/crud.test.js README.md
git commit -m "refactor(proposals): extract status-transition route into lifecycle.js"
```

---

## Task 6: Document the ratchet in CLAUDE.md

**Files:**
- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Rewrite the "File Size Discipline" section**

In `.claude/CLAUDE.md`, replace the entire `## File Size Discipline` section (from that heading through the end of its content, stopping before the next `## ` heading) with:

```markdown
## File Size Discipline

The codebase enforces line-count limits to prevent mega-files. A pre-commit hook
runs `node scripts/check-file-size.js --staged` on staged source files
(`server/**/*.js`, `client/src/**/*.{js,jsx}`, excluding tests). It is a
**ratchet**, not a flat cap:

- **Soft cap, 700 lines** — warns ("plan a split"). Never blocks.
- **Hard cap, 1000 lines** — a file over 1000 lines blocks the commit **only if
  this commit makes it longer than it is at `HEAD`.** A non-growing change
  (bugfix, refactor, or anything flat or shrinking) to an over-cap file is
  always allowed. The only way to *add* to an over-cap file is to first extract
  enough that the file stays flat or shrinks.

There is no per-file opt-out marker. A file over the cap is frozen at its
current size, and the ratchet tightens: once a file sheds lines, the lower count
becomes its new ceiling. For a genuine emergency where a growing commit to an
over-cap file cannot wait, `git commit --no-verify` is the escape: it is
per-commit, deliberate, and visible, not a permanent exemption.

Run `npm run check:filesize` any time for a full-tree RED / YELLOW report.

**When you write a new file or add to one, aim for the sweet spot:**
- **under 300 lines** — comfortable; holds in your head, easy to review.
- **300 to 600 lines** — fine for a focused page or route file with one concern.
- **600 to 700 lines** — yellow zone. Ask: is this one concern, or two?
- **over 700 lines** — actively plan a split.

**How to split, by the patterns already in the codebase:**
- **Route files** — per-concern files behind a composition router. See
  `server/routes/proposals/` (`index.js` mounts `crud`, `lifecycle`, `metadata`,
  `public`, `publicToken`).
- **Template files** — per-domain sibling files. See
  `server/utils/lifecycleEmailTemplates.js` and `marketingEmailTemplates.js`
  alongside `emailTemplates.js`.
- **Page components** — extract self-contained sections into their own files.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs(tooling): document the file-size ratchet in CLAUDE.md"
```

---

## Task 7: Final verification

No code changes. Confirm the whole change landed cleanly before declaring done.

- [ ] **Step 1: Working tree clean**

Run: `git status --short`
Expected: empty (only the untracked `.claude/` files that predate this work, if any, remain).

- [ ] **Step 2: Unit tests pass**

Run: `node --test scripts/check-file-size.test.js`
Expected: all green.

- [ ] **Step 3: Route tests pass**

Run: `node --test server/routes/proposals/crud.test.js`
Expected: all 12 cases green.

- [ ] **Step 4: Full-tree report is sane**

Run: `node scripts/check-file-size.js --all`
Expected: `RED` count 3 (`stripe.js`, `drinkPlans.js`, `ProposalCreate.js`, each a few lines shorter than before Task 3). `YELLOW` includes `crud.js` at roughly 870 and a new entry is absent for `lifecycle.js` (it is well under 700). Exit code 0.

- [ ] **Step 5: The ratchet blocks growth and allows non-growth**

Append a line to an over-cap file, stage it, dry-run the staged check, then revert:

```bash
echo "// verify" >> server/routes/drinkPlans.js
git add server/routes/drinkPlans.js
node scripts/check-file-size.js --staged
git restore --staged server/routes/drinkPlans.js
git restore server/routes/drinkPlans.js
```

Expected: the staged check prints a `FAIL` line for `drinkPlans.js` and exits non-zero. After the `git restore` pair, `git status --short` shows `drinkPlans.js` clean.

- [ ] **Step 6: The server boots and the moved route works**

Start the dev server, confirm a clean boot, then exercise the moved route end-to-end (an admin `PATCH /api/proposals/:id/status` against a draft proposal, via the admin UI or curl with an admin JWT). Confirm the status changes and, on a `draft -> sent` transition, the first invoice is created. Stop the dev server.

- [ ] **Step 7: Lint clean**

Run: `npm run lint`
Expected: zero errors (the new route file `lifecycle.js` is under `server/` and is linted).

---

## Self-review

- **Spec coverage:** §1 script (Task 1), §2 ratchet logic (Task 1, `classify` + `runStaged`), §3 `--all` report (Task 1, `runAll`), §4 hook wiring (Task 2), §5 retire the marker (Task 3), §6 overnight-review (Task 4), §7 crud.js split (Task 5), §8 CLAUDE.md (Task 6). All eight design sections map to a task.
- **Edge cases:** rename `headPath` handling and the `git show HEAD:` non-zero-exit catch are both in the Task 1 script (`stagedSourceFiles`, `countHeadOrZero`); a top-level fail-closed `try/catch` in the `require.main` block blocks the commit on any unexpected error instead of crashing the hook; forward-slash matching is enforced by `SCOPE_RE` plus the forward-slash `childRel` in `walkSource`.
- **Type consistency:** `classify` returns `'fail' | 'note' | 'warn' | 'ok'` and `runStaged` branches on exactly those; `bucket` returns `'red' | 'yellow' | 'green'` and `runAll` branches on exactly those. `__setDeps` has the same shape (`{ sendProposalSentEmail, createInvoiceOnSend }`) in `crud.js`, `lifecycle.js`, and both `crud.test.js` call sites.
- **Order safety:** verified each task's own commit passes the hook state in effect at that point (Task 1/2 stage only out-of-scope files; Task 3 only shrinks; Task 5 shrinks `crud.js` and adds a small `lifecycle.js`).
```
