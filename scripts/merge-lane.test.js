'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SCRIPT = path.resolve(__dirname, 'merge-lane.sh');

// Run a command, return { code, stdout, stderr }. Never throws on non-zero exit
// so tests can assert on the exit code directly.
function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

// Build a throwaway primary repo on main with one initial commit. Returns the
// repo path; caller is responsible for cleanup.
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-lane-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Create a lane branch in its own linked worktree with N commits, so a real
// squash-merge has multiple commits to collapse.
function addLaneWorktree(repo, branch, files) {
  const wt = path.join(repo, '..', `wt-${path.basename(repo)}-${branch}`);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  let i = 0;
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(wt, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    git(wt, 'add', rel);
    git(wt, 'commit', '-q', '-m', `lane step ${++i}`);
  }
  return wt;
}

test('dirty tree -> refuses with a clear message and non-zero exit', () => {
  const repo = makeRepo();
  try {
    addLaneWorktree(repo, 'lane-a', { 'feature.txt': 'hi\n' });
    // Make the primary tree dirty.
    fs.writeFileSync(path.join(repo, 'quickfix.txt'), 'wip\n');

    const res = run('bash', [SCRIPT, 'lane-a', 'docs/plan.md', 'alpha'], { cwd: repo });
    assert.notStrictEqual(res.code, 0, 'should exit non-zero on a dirty tree');
    assert.match(res.stderr, /dirty/i);
    assert.match(res.stderr, /commit or stash/i);
    // It must not have merged anything.
    const log = git(repo, 'log', '--oneline');
    assert.doesNotMatch(log, /merge\(lane/);
  } finally {
    rmrf(repo);
    rmrf(path.join(repo, '..', `wt-${path.basename(repo)}-lane-a`));
  }
});

test('clean case -> squash-merges as ONE commit carrying lane name + plan link', () => {
  const repo = makeRepo();
  try {
    addLaneWorktree(repo, 'lane-b', {
      'a.txt': 'one\n',
      'b.txt': 'two\n',
      'c.txt': 'three\n',
    });

    const before = git(repo, 'rev-list', '--count', 'HEAD').trim();
    const res = run('bash', [SCRIPT, 'lane-b', 'docs/superpowers/plans/p.md', 'bravo'], {
      cwd: repo,
    });
    assert.strictEqual(res.code, 0, `expected success, got: ${res.stderr}`);

    // Exactly ONE new commit on main (the 3 lane commits collapsed into 1).
    const after = git(repo, 'rev-list', '--count', 'HEAD').trim();
    assert.strictEqual(Number(after), Number(before) + 1, 'should add exactly one commit');

    const subject = git(repo, 'log', '-1', '--pretty=%s').trim();
    assert.strictEqual(subject, 'merge(lane bravo): docs/superpowers/plans/p.md');
    assert.match(subject, /bravo/, 'message carries the lane name');
    assert.match(subject, /docs\/superpowers\/plans\/p\.md/, 'message carries the plan link');

    // The squashed files actually landed.
    for (const f of ['a.txt', 'b.txt', 'c.txt']) {
      assert.ok(fs.existsSync(path.join(repo, f)), `${f} should be merged`);
    }

    // Notice tells Claude to re-run the per-lane review before worktree removal.
    assert.match(res.stdout, /per-lane review/i);
    assert.match(res.stdout, /HEAD/);
  } finally {
    rmrf(repo);
    rmrf(path.join(repo, '..', `wt-${path.basename(repo)}-lane-b`));
  }
});

// Spawn merge-lane.sh non-blocking so we can observe serialization.
function spawnMerge(repo, args) {
  return spawn('bash', [SCRIPT, ...args], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('serialization -> the second concurrent invocation waits for the lock', async () => {
  const repo = makeRepo();
  const wtA = addLaneWorktree(repo, 'lane-c', { 'c1.txt': 'x\n' });
  const wtB = addLaneWorktree(repo, 'lane-d', { 'd1.txt': 'y\n' });
  try {
    // First holder grabs the lock and holds it ~600ms via a slow pre-commit hook.
    const hookDir = path.join(repo, '.git', 'hooks');
    const hook = path.join(hookDir, 'pre-commit');
    fs.writeFileSync(hook, '#!/usr/bin/env bash\nsleep 0.6\nexit 0\n');
    fs.chmodSync(hook, 0o755);

    const events = [];
    const p1 = spawnMerge(repo, ['lane-c', 'plan-c.md', 'charlie']);
    p1.on('exit', () => events.push('p1'));

    // Give p1 a moment to acquire the lock and enter the slow commit.
    await new Promise((r) => setTimeout(r, 150));

    const start = Date.now();
    const p2 = spawnMerge(repo, ['lane-d', 'plan-d.md', 'delta']);
    p2.on('exit', () => events.push('p2'));

    const codes = await Promise.all([
      new Promise((res) => p1.on('exit', (c) => res(c))),
      new Promise((res) => p2.on('exit', (c) => res(c))),
    ]);
    const elapsed = Date.now() - start;

    assert.deepStrictEqual(events, ['p1', 'p2'], 'p1 must finish before p2');
    assert.strictEqual(codes[0], 0, 'first merge should succeed');
    assert.strictEqual(codes[1], 0, 'second merge should succeed after waiting');
    // p2 started ~150ms in; it had to wait out the rest of p1's ~600ms hold.
    assert.ok(elapsed >= 250, `second invocation should have waited (waited ${elapsed}ms)`);

    // Both lanes landed as two separate squash commits, no interleave/clobber.
    const subjects = git(repo, 'log', '--pretty=%s').trim().split('\n');
    assert.ok(subjects.includes('merge(lane charlie): plan-c.md'));
    assert.ok(subjects.includes('merge(lane delta): plan-d.md'));
    assert.ok(fs.existsSync(path.join(repo, 'c1.txt')));
    assert.ok(fs.existsSync(path.join(repo, 'd1.txt')));
  } finally {
    rmrf(repo);
    rmrf(wtA);
    rmrf(wtB);
  }
});

test('killed lock holder -> flock auto-releases so a later run proceeds', async () => {
  const repo = makeRepo();
  const wtKill = addLaneWorktree(repo, 'lane-kill', { 'k1.txt': 'k\n' });
  const wtNext = addLaneWorktree(repo, 'lane-next', { 'n1.txt': 'n\n' });
  try {
    // Make the FIRST real merge hold the lock a while: a slow pre-commit hook
    // blocks the script after it has acquired the flock and started committing.
    const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/usr/bin/env bash\nsleep 30\nexit 0\n');
    fs.chmodSync(hook, 0o755);

    // Launch the actual script in its own process group, let it acquire the
    // lock and enter the slow commit, then SIGKILL the whole group (simulating
    // a crash mid-merge). flock releases when the holding fd closes on death.
    const holder = spawn('bash', [SCRIPT, 'lane-kill', 'plan-kill.md', 'kilo'], {
      cwd: repo,
      stdio: 'ignore',
      detached: true, // new process group so we can kill the whole tree
    });
    await new Promise((r) => setTimeout(r, 800)); // let it lock + reach the hook
    try {
      process.kill(-holder.pid, 'SIGKILL'); // kill the group (script + flock + hook)
    } catch {
      holder.kill('SIGKILL');
    }
    await new Promise((res) => holder.on('exit', () => res()));

    // Remove the slow hook so the next merge can commit normally.
    fs.rmSync(hook, { force: true });

    // A crashed merge leaves its half-staged squash in the index; clean that
    // residue (as a human would post-crash) so this test isolates ONE claim:
    // the flock auto-released. The dirty-tree refusal is covered by its own test.
    git(repo, 'reset', '--hard', 'main');

    // A subsequent merge must acquire the (auto-released) lock and complete.
    // If the lock had leaked on the kill, this would block until the timeout.
    const res = run('bash', [SCRIPT, 'lane-next', 'plan-next.md', 'november'], {
      cwd: repo,
      timeout: 8000,
    });
    assert.strictEqual(res.code, 0, `expected success after auto-release, got: ${res.stderr}`);
    const subject = git(repo, 'log', '-1', '--pretty=%s').trim();
    assert.strictEqual(subject, 'merge(lane november): plan-next.md');
    assert.ok(fs.existsSync(path.join(repo, 'n1.txt')), 'next lane should have merged');
  } finally {
    rmrf(repo);
    rmrf(wtKill);
    rmrf(wtNext);
  }
});
