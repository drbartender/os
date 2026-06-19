'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Absolute path to the guard under test. The guard resolves the primary
// worktree via `git rev-parse --git-common-dir`, so it must be invoked from
// the worktree whose behavior we are asserting (cwd carries that meaning).
const GUARD = path.resolve(__dirname, 'guard-os-main.sh');

// Run a git command in a given directory, returning trimmed stdout.
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Build a fresh primary repo under /tmp with an initial commit on `main`.
// Returns the absolute path to the repo root.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-os-main-'));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  // An initial commit is required before `git worktree add` / branches work.
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

// Add a linked worktree on a new branch off main. The linked worktree shares
// the primary's common git dir, so toplevel != primary there. git config is
// inherited from the common dir, so commits/staging work.
function addLinkedWorktree(primary, name, branch) {
  const wt = path.join(primary, '..', `${path.basename(primary)}-${name}`);
  const abs = path.resolve(wt);
  git(primary, ['worktree', 'add', '-q', '-b', branch, abs, 'main']);
  return abs;
}

// Stage a file (with content) at a repo-relative path inside `cwd`.
function stageFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  git(cwd, ['add', '--', relPath]);
}

// Run the guard from `cwd` and return its exit code (number).
function runGuard(cwd) {
  const res = spawnSync('bash', [GUARD], { cwd, encoding: 'utf8' });
  return res.status;
}

test('case 1: primary worktree on feature, any staged file -> exit 1', () => {
  const repo = makeRepo();
  // Switch the primary worktree itself off main. This is the os-leaves-main case.
  git(repo, ['checkout', '-q', '-b', 'feature']);
  stageFile(repo, 'server/anything.js', 'console.log(1);\n');
  assert.strictEqual(runGuard(repo), 1);
});

test('case 2: linked worktree on feature, staged spec doc -> exit 1', () => {
  const repo = makeRepo();
  const wt = addLinkedWorktree(repo, 'spec', 'feature');
  stageFile(wt, 'docs/superpowers/specs/x.md', '# spec\n');
  assert.strictEqual(runGuard(wt), 1);
});

test('case 3: linked worktree on feature, staged code file -> exit 0', () => {
  const repo = makeRepo();
  const wt = addLinkedWorktree(repo, 'code', 'feature');
  stageFile(wt, 'server/anything.js', 'console.log(1);\n');
  assert.strictEqual(runGuard(wt), 0);
});

test('case 4: primary worktree on main, any staged file -> exit 0', () => {
  const repo = makeRepo();
  stageFile(repo, 'server/anything.js', 'console.log(1);\n');
  assert.strictEqual(runGuard(repo), 0);
});

test('case 5: linked worktree on main, staged doc -> exit 0', () => {
  const repo = makeRepo();
  // A worktree on `main` cannot be created (git refuses a second main checkout
  // by default), so use --force to put a linked worktree on main for this case.
  const wt = path.resolve(path.join(repo, '..', `${path.basename(repo)}-mainwt`));
  git(repo, ['worktree', 'add', '-q', '--force', wt, 'main']);
  stageFile(wt, 'docs/superpowers/specs/x.md', '# spec\n');
  assert.strictEqual(runGuard(wt), 0);
});
