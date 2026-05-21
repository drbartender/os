# File-Size Ratchet Design

**Date:** 2026-05-21
**Status:** Draft (design stage, pre-implementation). Gemini 2.5 Pro design review folded in 2026-05-21.
**Topic:** Make the recurring "file crossed the 1000-line cap" problem stop happening.

## Problem

The codebase enforces line-count limits via a pre-commit hook (`.husky/check-file-size.sh`):
soft warn at 700 lines, hard fail at 1000, with a `// claude-allow-large-file` opt-out
marker (placed in the first 5 lines) that fully exempts a file.

The 2026-04-27 cleanup pass split five 1000+ line mega-files. Roughly a month later the
danger zone has refilled and three files are already over the 1000-line hard cap. The
problem is not a one-time backlog; it recurs. This spec fixes the mechanism so it stops
recurring.

### Root cause: why it keeps happening

1. **The opt-out marker is a permanent, unbounded exemption.** All three current over-cap
   files carry `// claude-allow-large-file`. Once a file has the marker there is no ceiling
   ever again. `server/routes/stripe.js` drifted to 1736 lines with the marker silently
   absorbing every addition. The hook is not failing to catch these files; it is actively
   exempting them.

2. **The marker is the path of least resistance.** The hard fail fires at commit time,
   mid-feature, exactly when the developer is trying to ship. Adding the marker is one line;
   splitting the file is an hour of careful work. So the hook trains the very behavior it
   exists to prevent: when the cliff is hit, slap on the marker.

3. **The hook only sees staged files at commit time.** There is no full-tree view. The
   roughly 11-file creep in the 700-1000 zone is invisible between commits. Nobody sees a
   file approaching the cap until it breaches.

## Current state (measured 2026-05-21)

Pre-commit hook: `WARN_LIMIT=700`, `FAIL_LIMIT=1000`. Scopes to
`^(server|client/src)/.+\.(js|jsx)$`, excludes `*.test.(js|jsx)`. Opt-out marker must be in
the first 5 lines. There is no CI (`.github/workflows/` does not exist); all gating is local
husky hooks. There is no full-tree size scan anywhere.

**Files carrying `// claude-allow-large-file`:**

| File | Lines | Marker reason |
|---|---|---|
| `server/routes/stripe.js` | 1736 | "single Stripe surface, splitting deferred" |
| `server/routes/drinkPlans.js` | 1191 | "single-resource router, splitting would scatter shared helpers" |
| `client/src/pages/admin/ProposalCreate.js` | 1339 | "splitting belongs in a separate refactor" |
| `client/src/pages/staff/PrintTipCard.layouts.jsx` | 658 | "verbatim port of the print-tip-card design system" |

`PrintTipCard.layouts.jsx` is under the cap; its marker is moot.

**Files in the 700-1000 warn zone** (no marker, pass today, will breach on growth):
`server/routes/proposals/crud.js` (990), `server/utils/emailTemplates.js` (976),
`server/routes/emailMarketing.js` (856), `server/routes/admin/users.js` (814),
`server/routes/shifts.js` (727), `server/utils/invoiceHelpers.js` (719),
`client/src/pages/plan/PotionPlanningLab.js` (977),
`client/src/pages/admin/CocktailMenuDashboard.js` (932),
`client/src/pages/website/quoteWizard/QuoteWizard.js` (804),
`client/src/pages/plan/steps/ConfirmationStep.js` (782),
`client/src/pages/AdminDashboard.js` (748).

`crud.js` (990) is the most imminent: the next feature touching it (the deferred comms
wiring) will breach 1000.

## Goals / Non-goals

**Goals**
- A file cannot grow past the hard cap. The mechanism is durable: it does not depend on
  anyone remembering to split proactively.
- The cliff disappears: touching a large file for a non-growing change (bugfix, refactor) is
  never blocked.
- The whole-repo size picture is visible on demand and surfaced automatically.
- Clear `crud.js` (the one imminent file, and the prerequisite for the next session's comms
  wiring).

**Non-goals**
- Splitting the three existing over-cap files (`stripe.js`, `drinkPlans.js`,
  `ProposalCreate.js`) or the other warn-zone files. The ratchet freezes them; they become a
  tracked, frozen backlog split opportunistically when a future feature must touch one.
- Adding CI. Out of scope; husky stays the enforcement layer.

## Approach: a ratchet, not a cliff

Replace the binary rule ("fail if over 1000") with a direction-aware rule: **fail if over
1000 and this commit makes the file longer.** The file's line count at `HEAD` is the
baseline. Git history is the baseline, so no new tracked state file is needed.

- Over 1000 and growing vs HEAD: blocked ("split before you add").
- Over 1000 but flat or shrinking vs HEAD: allowed. Bugfixes and refactors inside a big file
  are never blocked.
- A new file, or a file crossing 1000 for the first time: blocked.
- 700-1000: warn, non-blocking (unchanged).

The three over-cap files become frozen at their current size rather than exempt. To add to
`stripe.js` you must first extract enough to keep it flat or shrink it. The ratchet forces
the split at the right time, with the context of the feature that needs it.

Because the cliff is gone, the marker reflex is gone: there is nothing to escape from when a
non-growing commit just works. The `// claude-allow-large-file` marker is therefore retired.
The ratchet's "cannot grow past cap" is a strictly better, bounded version of what the
marker tried to be. The sanctioned emergency escape becomes `git commit --no-verify`:
per-commit, deliberate, and not a permanent per-file exemption buried in the first 5 lines
forever.

### Why not the alternatives

- **Split all 14 files now, keep the cliff hook.** Huge and risky (`stripe.js` is the money
  path). And it does not stop recurrence: files creep again, someone re-adds a marker,
  repeat. Treats the symptom.
- **Baseline-file ratchet on every file** (a checked-in `.filesizes.json` that ratchets
  every file's size down). Maximally strict, since even a 200-line file cannot grow without
  a baseline edit. Far too much friction, and the baseline file churns and merge-conflicts
  on every commit. Over-engineered.

The HEAD-comparison ratchet bites only at the cap, needs no new tracked file, and is the
minimum mechanism that durably stops recurrence.

## Detailed design

### 1. `scripts/check-file-size.js` (new)

Node CJS script, repo root `scripts/` dir, matching the style of `scripts/build-testing-guide.js`
(`'use strict'`, `node:`-prefixed core modules, `ROOT = path.resolve(__dirname, '..')`,
`main()` entry). One script, two modes selected by argv:

- `--staged`: the ratchet check. Default mode when invoked by the hook.
- `--all`: full-tree report.

Thresholds (`WARN_LIMIT = 700`, `FAIL_LIMIT = 1000`), the path scope regex
(`^(server|client/src)/.+\.(js|jsx)$` minus `*.test.*`), and the line-count function are
defined once and shared by both modes: a single source of truth.

Line counting matches `wc -l` semantics: count `\n` occurrences in the blob. It is applied
to the staged blob (`git show :<path>`), not the working tree. This also fixes a latent bug
in the current shell hook, which counts the working-tree file and so can mis-measure when a
file has unstaged edits.

The scope regex is always matched against forward-slash paths. `git` reports paths with
forward slashes on every OS, so `--staged` mode matches correctly as written. In `--all`
mode the filesystem walk yields OS-native separators (backslashes on Windows), so the script
normalizes walked paths to forward slashes before applying the regex. Without that
normalization a Windows run would silently skip every file.

### 2. Ratchet logic (`--staged`)

```
staged = `git diff --cached --name-status --diff-filter=ACMR -M`
for each entry:
    # entry: "<status>\t<path>", or for a rename "R<score>\t<oldPath>\t<newPath>"
    P        = the path being committed (newPath for a rename, otherwise the path)
    headPath = oldPath for a rename ("R..."), otherwise P
    skip unless P matches the source-file scope regex   # run on git's
                                                        # forward-slash output
    new = lineCount(`git show :P`)                      # staged blob
    old = lineCountOrZero(`git show HEAD:headPath`)     # see "Old count" below
    if new > FAIL_LIMIT and new > old:
        FAIL  "P is N lines (was M at HEAD): over the 1000-line cap and growing.
               Split it, or extract the new code to a sibling module, before committing."
    elif new > FAIL_LIMIT:                              # over cap, flat or shrinking
        NOTE  "P is N lines (over cap, frozen, not growing): allowed."
    elif new > WARN_LIMIT:
        WARN  "P is N lines (soft cap 700): plan a split."  # non-blocking
exit 1 if any FAIL, else 0
```

**Old count.** `git show HEAD:headPath` reads the file as it stands in the last commit. For
a renamed file `headPath` is the old path, so the pre-rename size is read correctly and a
pure rename of an over-cap file is not mistaken for growth. For an added (`A`) or copied
(`C`) file there is no blob at `HEAD`, and the command exits non-zero (it does not return
empty output). `lineCountOrZero` must catch that non-zero exit and return `0`. An uncaught
error would abort the entire pre-commit hook on every commit that adds a new file. With
`old = 0`, a new file over 1000 lines fails the ratchet (correct: do not birth a mega-file),
and a normal-size new file passes.

The ratchet ceiling only ever moves down: each commit's `new` becomes the next commit's
`old`, so a file that sheds lines locks in the lower count.

### 3. Full-tree report (`--all`)

Walks `server/` and `client/src/`, applies the scope regex, buckets every file by absolute
line count (no HEAD comparison, since a snapshot has no "old"):

```
RED    > 1000   (must split: the frozen backlog)
YELLOW 700-1000 (plan a split)
```

Prints a grouped, sorted report with counts. Exits 0 always: `--all` is a pure report, not a
gate. The `--staged` ratchet is the only enforcement path.

### 4. Hook wiring

`.husky/pre-commit` currently runs, in order: `bash scripts/check-docs-drift.sh`,
`sh .husky/check-file-size.sh`, `npx lint-staged`. Replace the middle line with
`node scripts/check-file-size.js --staged`. Delete `.husky/check-file-size.sh`. The
docs-drift and lint-staged steps are unchanged.

Add an npm script: `"check:filesize": "node scripts/check-file-size.js --all"` (the
`colon:subcommand` namespacing matches `audit:check`, `build:testing-guide`).

### 5. Retire the opt-out marker

Remove the `// claude-allow-large-file` marker (and its reason line) from the four files
that carry it. The script no longer recognizes the marker. The three over-cap files are then
frozen by the ratchet; `PrintTipCard.layouts.jsx` (under cap) is unaffected.

### 6. overnight-review integration

`.claude/commands/overnight-review.md` defines an autonomous nightly run. Add a report-only
preflight step: run `npm run check:filesize` and include the RED/YELLOW list in the morning
summary log. This keeps the frozen backlog visible every night without anyone remembering to
look. overnight-review's existing rules forbid it from modifying `.husky/*` or `package.json`
unattended; the size scan is report-only and does not violate that.

### 7. Split `crud.js` into `lifecycle.js`

`server/routes/proposals/crud.js` (990 lines) is a grab-bag of 11 route handlers. Extract
the status-lifecycle handler so the file drops well under the cap and the next session's
comms wiring has a home.

- **New `server/routes/proposals/lifecycle.js`:** the `PATCH /:id/status` handler
  (`crud.js:630-730`) and the `STATUS_TRANSITIONS` table (`crud.js:50-61`, used only by that
  handler). It needs its own imports (`express`, `pool`, `{ auth, requireAdminOrManager }`,
  `asyncHandler`, `{ ValidationError, NotFoundError }`, `adminWriteLimiter`) and its own
  `_deps` / `__setDeps` test seam for `createInvoiceOnSend`
  and `sendProposalSentEmail` (the status handler calls both).
- **`server/routes/proposals/index.js`:** add `router.use('/', require('./lifecycle'))`,
  mounted after `metadata` and with `crud`. `lifecycle`'s only route is `/:id/status`, which
  does not collide with `crud`'s `/:id` (different segment count) or with `metadata`'s static
  paths.
- **The money-critical handlers are not touched.** `POST /` (create), `PATCH /:id` (update),
  and `POST /:id/record-payment` stay byte-for-byte in `crud.js`, including `crud.js`'s own
  `_deps` seam. `crud.js` drops to roughly 870 lines.
- **`crud.test.js`:** the harness mounts only `crudRouter` today. Add `require('./lifecycle')`,
  mount `lifecycleRouter` on the same test app, and call `lifecycleRouter.__setDeps(...)` with
  the same stubs at the two existing stub points. The status-route tests (cases 10/11/12:
  send, re-send, invoice-failure rollback) stay in `crud.test.js` and must stay green. That
  is the proof the money path survived the move.

### 8. CLAUDE.md update

Update the "File Size Discipline" section: document the ratchet, remove the
`// claude-allow-large-file` marker instructions, name `git commit --no-verify` as the
emergency escape, and add the splitting patterns the codebase already uses: per-concern
route files behind a composition router (the `proposals/` pattern), per-domain template
files (the `lifecycleEmailTemplates.js` and `marketingEmailTemplates.js` pattern), and
per-section page components.

## Edge cases

- **New file born over 1000:** `old = 0`, fails. Correct.
- **Pure rename of an over-cap file:** `-M` supplies the old path; `headPath` reads the
  correct pre-rename count; not flagged as growth.
- **Copied file (`C`) over 1000:** no `HEAD:` blob, `old = 0`, fails. Correct.
- **`git show HEAD:<path>` for a file absent at HEAD:** the command exits non-zero (it does
  not succeed with empty output). `lineCountOrZero` catches the non-zero exit and returns 0.
  An uncaught error here would crash the whole pre-commit hook on every new-file commit.
- **Windows path separators:** `git` reports forward slashes on every OS, so `--staged` scope
  matching is correct as written. `--all` mode normalizes the OS-native paths from the
  filesystem walk to forward slashes before matching.
- **Deleted files:** excluded by `--diff-filter=ACMR`.
- **Unstaged edits present:** the ratchet measures the staged blob, so the count reflects
  exactly what is being committed.
- **CRLF line endings (Windows):** counting `\n` occurrences matches `wc -l` regardless of
  `\r`.
- **Genuine emergency one-line fix on a frozen file:** `git commit --no-verify` is the
  sanctioned escape; it is per-commit and visible, unlike the retired marker.
- **`--all` over `server/scripts/` and root `scripts/`:** out of scope by the path regex;
  only `server/` and `client/src/` source is scanned.

## Verification

- Unit-test `scripts/check-file-size.js` line counting and ratchet decision against fixtures
  (over-cap-growing, over-cap-flat, over-cap-shrinking, new-file-over-cap, warn-zone).
- `node scripts/check-file-size.js --all` prints the expected RED (3) and YELLOW (roughly 11)
  report.
- Stage a synthetic +1-line change to `stripe.js`: hook fails. Stage a -1-line change: hook
  passes. Stage a change to a 500-line file: hook silent.
- Stage a brand-new small source file: hook passes silently (this exercises the `git show
  HEAD:<path>` non-zero-exit path without crashing). Stage a brand-new 1000+-line file: hook
  fails cleanly.
- Stage a pure rename of an over-cap file (for example `stripe.js`): hook passes, not flagged
  as growth (confirms `headPath` uses the old path).
- After the `crud.js` split: `node --test server/routes/proposals/crud.test.js`, all cases
  green, especially the status-route cases. Boot the server; `PATCH /api/proposals/:id/status`
  still works end-to-end.
- The whole pre-commit hook runs clean on a representative staged change.

## What this does NOT do

- Does not split `stripe.js`, `drinkPlans.js`, `ProposalCreate.js`, `emailTemplates.js`, or
  the other warn-zone files. They are frozen by the ratchet and tracked by
  `npm run check:filesize`.
- Does not add CI or a pre-push size gate.
- Does not change the 700 / 1000 thresholds.
