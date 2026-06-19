'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseWorktrees,
  evaluateLane,
  safeScrapCheck,
  STALE_MAIN_ADVANCE,
} = require('./lane-status');

// Run git in `cwd`, returning trimmed stdout.
function git(cwd, args, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

// Commit a file with a fixed author/committer date so age-based assertions are
// deterministic. `date` is an ISO-ish git date string.
function commitAt(cwd, relPath, content, message, date) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  git(cwd, ['add', '--', relPath]);
  const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : null;
  git(cwd, ['commit', '-q', '-m', message], env);
}

// Build a fresh repo under /tmp with one seed commit on main. Returns its root.
function makeRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lane-status-${label}-`));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-q', '-m', 'seed']);
  return dir;
}

// Create a branch `lane` off main HEAD. We model a lane as a branch in the same
// repo (evaluateLane / safeScrapCheck take a {branch, path} record and an
// explicit cwd, so we do not need a separate worktree checkout to test the
// staleness + scrap logic).
function cutLane(repo, branch) {
  git(repo, ['branch', branch, 'main']);
  return { branch, path: repo };
}

test('parseWorktrees parses path + branch and detached', () => {
  const porcelain = [
    'worktree /a/os',
    'HEAD aaa',
    'branch refs/heads/main',
    '',
    'worktree /a/lane',
    'HEAD bbb',
    'branch refs/heads/feature',
    '',
    'worktree /a/det',
    'HEAD ccc',
    'detached',
    '',
  ].join('\n');
  const parsed = parseWorktrees(porcelain);
  assert.strictEqual(parsed.length, 3);
  assert.deepStrictEqual(parsed[0], { path: '/a/os', branch: 'main' });
  assert.deepStrictEqual(parsed[1], { path: '/a/lane', branch: 'feature' });
  assert.strictEqual(parsed[2].branch, null);
});

test('a lane is flagged stale when main advances 15+ commits since cut', () => {
  const repo = makeRepo('advance');
  const lane = cutLane(repo, 'lane');
  // Advance main by STALE_MAIN_ADVANCE commits AFTER the lane was cut.
  for (let i = 0; i < STALE_MAIN_ADVANCE; i++) {
    commitAt(repo, `main-file-${i}.txt`, `m${i}\n`, `main ${i}`);
  }
  const evald = evaluateLane(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(evald.stale, true, 'lane should be stale');
  assert.strictEqual(evald.mainAdvance, STALE_MAIN_ADVANCE);
  assert.ok(
    evald.reasons.some((r) => r.includes('main advanced')),
    'reason should cite main advance'
  );
});

test('a lane is flagged stale by age (no commit in over 48h)', () => {
  const repo = makeRepo('age');
  // Commit on the lane branch with an old date, so its newest commit is stale.
  git(repo, ['checkout', '-q', '-b', 'lane']);
  commitAt(repo, 'lane.txt', 'old\n', 'old lane commit', '2020-01-01T00:00:00');
  git(repo, ['checkout', '-q', 'main']);
  const lane = { branch: 'lane', path: repo };
  const evald = evaluateLane(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(evald.stale, true);
  assert.ok(evald.reasons.some((r) => r.includes('over 48h')));
});

test('a fresh lane (recent commit, main barely moved) is NOT stale', () => {
  const repo = makeRepo('fresh');
  git(repo, ['checkout', '-q', '-b', 'lane']);
  commitAt(repo, 'lane.txt', 'new\n', 'recent lane commit');
  git(repo, ['checkout', '-q', 'main']);
  // Main advances only a couple of cosmetic commits, no sensitive path.
  commitAt(repo, 'docs/notes-1.md', 'a\n', 'main note 1');
  commitAt(repo, 'docs/notes-2.md', 'b\n', 'main note 2');
  const lane = { branch: 'lane', path: repo };
  const evald = evaluateLane(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(evald.stale, false, `unexpected reasons: ${evald.reasons.join('; ')}`);
});

test('a lane is flagged stale when a sensitive path lands on main since cut', () => {
  const repo = makeRepo('sensitive');
  const lane = cutLane(repo, 'lane');
  // A sensitive file (matches the repo sensitive-paths.txt) lands on main.
  commitAt(
    repo,
    'server/utils/pricingEngine.js',
    'module.exports = {};\n',
    'pricing change on main'
  );
  const evald = evaluateLane(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(evald.sensitiveLanded, true);
  assert.strictEqual(evald.stale, true);
  assert.ok(evald.reasons.some((r) => r.includes('sensitive')));
});

test('safe-scrap REFUSES a lane with unmerged commits (git log main..lane non-empty)', () => {
  const repo = makeRepo('unmerged');
  git(repo, ['checkout', '-q', '-b', 'lane']);
  commitAt(repo, 'lane-work.txt', 'wip\n', 'distinct lane work');
  git(repo, ['checkout', '-q', 'main']);
  const lane = { branch: 'lane', path: repo };
  const res = safeScrapCheck(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(res.safe, false);
  assert.strictEqual(res.unmergedCount, 1);
  assert.strictEqual(res.command, null, 'must not emit a branch-delete command');
  assert.ok(res.message.includes('Dallas must approve'));
});

test('safe-scrap PASSES a fully-merged lane (git log main..lane empty) and uses -d not -D', () => {
  const repo = makeRepo('merged');
  // Lane points at main HEAD with no distinct commits: fully merged.
  const lane = cutLane(repo, 'lane');
  const res = safeScrapCheck(lane, { cwd: repo, mainRef: 'main' });
  assert.strictEqual(res.safe, true);
  assert.strictEqual(res.unmergedCount, 0);
  assert.strictEqual(res.command, 'git branch -d lane');
  assert.ok(!/-D/.test(res.command), 'must never use the force -D delete');
});
