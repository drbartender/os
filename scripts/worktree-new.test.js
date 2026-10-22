'use strict';

// node:test suite for scripts/worktree-new.js and scripts/worktree-rm.js, the
// lane lifecycle's two scripts, run as child processes.
//
// Every case runs in one throwaway repo under the OS temp dir: a main checkout
// at <root>/repo holding the five link sources, its lanes at
// <root>/worktrees/<name>, and a fake home at <root>/home (HOME is overridden,
// so the memory link lands there, and DRB_MAIN_MEMORY points the main memory
// into it too). The lane's own script paths are run with the cwd inside the
// throwaway: the scripts find the main checkout from the cwd's git common dir
// and require scripts/lib/worktreeLinks.js beside themselves, so nothing is
// copied. Nothing here touches the real repo, the real home or the real memory.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { LINKS, memoryRoot } = require('./lib/worktreeLinks');

const NEW = path.resolve(__dirname, 'worktree-new.js');
const RM = path.resolve(__dirname, 'worktree-rm.js');

// A git variable from a calling hook would point every git call here at the
// real repo, so the children and the helpers run without them.
const env = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX']) delete env[k];

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-new-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const repo = path.join(root, 'repo');
const home = path.join(root, 'home');
const mainMemory = path.join(home, 'main-memory');
const childEnv = { ...env, HOME: home, DRB_MAIN_MEMORY: mainMemory };

function git(cwd, args) {
  return execFileSync('git', args, { cwd, env: childEnv, encoding: 'utf8' }).trim();
}

const IDENT = ['-c', 'user.name=Lane Test', '-c', 'user.email=lane-test@example.com'];

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repo, env: childEnv, encoding: 'utf8' });
}

function laneDir(name) {
  return path.join(root, 'worktrees', name);
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function absent(p) {
  try {
    fs.lstatSync(p);
    return false;
  } catch (e) {
    return e.code === 'ENOENT';
  }
}

function worktrees() {
  return git(repo, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice(9));
}

function branchExists(name) {
  return git(repo, ['branch', '--list', name]) !== '';
}

// The seed: a .gitignore matching the links (no trailing slash, as the real
// one, so a symlink is ignored too), one commit on main, then the five sources.
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(mainMemory, { recursive: true });
fs.writeFileSync(path.join(mainMemory, 'MEMORY.md'), 'index\n');
git(repo, ['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n.env\nclient/node_modules\nclient/.env\n.husky/_\n');
fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
git(repo, ['add', '--', '.gitignore', 'README.md']);
git(repo, [...IDENT, 'commit', '-q', '-m', 'seed']);
for (const { rel, shared } of LINKS) {
  const p = path.join(repo, rel);
  if (shared) {
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'keep.txt'), 'shared\n');
  } else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'NODE_ENV=development\n');
  }
}

const NAME = 'scratch-lane';

test('a new name makes the worktree, the five links and the memory link', () => {
  const res = run(NEW, [NAME]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Created worktree "scratch-lane" on a new branch from main\./);
  assert.match(res.stdout, /Ready\. Open a Claude window in:/);
  assert.match(res.stderr, /DRB_MAIN_MEMORY is set, linking the lane memory to /);
  const target = laneDir(NAME);
  assert.ok(worktrees().includes(target), 'the worktree is registered');
  assert.ok(branchExists(NAME), 'the branch exists');
  for (const { rel } of LINKS) {
    assert.ok(isLink(path.join(target, rel)), `${rel} is a link`);
    assert.equal(fs.readlinkSync(path.join(target, rel)), path.join(repo, rel));
    assert.match(res.stdout, new RegExp(`^  linked ${rel.replace(/[.]/g, '\\.')}$`, 'm'));
  }
  const mem = memoryRoot(target, { home });
  assert.ok(isLink(mem), 'the memory root is a link');
  assert.equal(fs.readlinkSync(mem), mainMemory);
  assert.equal(git(target, ['status', '--porcelain']), '', 'the lane is born clean');
});

test('a second run reports the links present and makes nothing', () => {
  const res = run(NEW, [NAME]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Worktree "scratch-lane" already exists/);
  for (const { rel } of LINKS) {
    assert.ok(res.stdout.includes(`  ${rel} already linked\n`), `${rel} reported present`);
  }
  assert.ok(res.stdout.includes('  memory already linked\n'));
  assert.doesNotMatch(res.stdout, /^ {2}linked /m);
  assert.equal(worktrees().length, 2);
});

test('a name differing only in case is a new worktree, and worktree-rm removes only that one', () => {
  const upper = 'Scratch-Lane';
  const res = run(NEW, [upper]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Created worktree "Scratch-Lane" on a new branch from main\./);
  assert.doesNotMatch(res.stdout, /already exists/);
  assert.ok(worktrees().includes(laneDir(upper)), 'git registers the new one');
  assert.ok(worktrees().includes(laneDir(NAME)), 'the lowercase one is still registered');
  assert.ok(branchExists(upper) && branchExists(NAME));
  assert.equal(fs.readlinkSync(memoryRoot(laneDir(upper), { home })), mainMemory);
  const rm = run(RM, [upper]);
  assert.equal(rm.status, 0, rm.stderr);
  assert.ok(absent(laneDir(upper)));
  assert.ok(absent(memoryRoot(laneDir(upper), { home })));
  assert.ok(!branchExists(upper));
  assert.ok(worktrees().includes(laneDir(NAME)), 'the lowercase one survives');
  assert.ok(branchExists(NAME));
  for (const { rel } of LINKS) assert.ok(isLink(path.join(laneDir(NAME), rel)), `${rel} still linked in ${NAME}`);
  assert.ok(isLink(memoryRoot(laneDir(NAME), { home })));
});

test('main is refused and nothing is made', () => {
  const before = worktrees();
  const res = run(NEW, ['main']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /"main" is reserved/);
  assert.deepEqual(worktrees(), before);
  assert.ok(absent(laneDir('main')));
});

test('a dotted name is refused and nothing is made', () => {
  const before = worktrees();
  const res = run(NEW, ['scratch.dotted']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /invalid name "scratch\.dotted" \(use letters, digits and dashes/);
  assert.deepEqual(worktrees(), before);
  assert.ok(absent(laneDir('scratch.dotted')));
});

test('a 101-character name is refused and nothing is made', () => {
  const before = worktrees();
  const long = `a${'b'.repeat(100)}`;
  assert.equal(long.length, 101);
  const res = run(NEW, [long]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /at most 100 characters/);
  assert.deepEqual(worktrees(), before);
  assert.ok(absent(laneDir(long)));
});

test('worktree-rm removes the links, the memory link, the worktree and the branch', () => {
  const target = laneDir(NAME);
  const mem = memoryRoot(target, { home });
  const res = run(RM, [NAME]);
  assert.equal(res.status, 0, res.stderr);
  for (const { rel } of LINKS) assert.ok(res.stdout.includes(`  unlinked ${rel}\n`), `${rel} unlinked`);
  assert.ok(res.stdout.includes('  unlinked memory\n'));
  assert.match(res.stdout, /Removed worktree "scratch-lane"\./);
  assert.match(res.stdout, /Deleted branch "scratch-lane"\. Done\./);
  assert.ok(absent(target), 'the worktree folder is gone');
  assert.ok(absent(mem), 'the memory link is gone');
  assert.ok(!worktrees().includes(target));
  assert.ok(!branchExists(NAME));
  // The shared copies and the main memory survive the teardown.
  for (const { rel, shared } of LINKS) {
    assert.ok(fs.existsSync(shared ? path.join(repo, rel, 'keep.txt') : path.join(repo, rel)), `${rel} kept in main`);
  }
  assert.equal(fs.readFileSync(path.join(mainMemory, 'MEMORY.md'), 'utf8'), 'index\n');
});

test('worktree-rm stops at a real directory in a shared link\'s place and removes nothing', () => {
  const name = 'scratch-real';
  assert.equal(run(NEW, [name]).status, 0);
  const target = laneDir(name);
  fs.unlinkSync(path.join(target, 'node_modules'));
  fs.mkdirSync(path.join(target, 'node_modules'));
  fs.writeFileSync(path.join(target, 'node_modules', 'own.txt'), 'lane copy\n');
  const res = run(RM, [name]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /node_modules is a real path, not a symlink, stopping so the shared copy is not deleted/);
  assert.ok(worktrees().includes(target), 'the worktree stays');
  assert.ok(branchExists(name), 'the branch stays');
  assert.ok(isLink(path.join(target, '.env')), 'the other links stay');
  assert.ok(isLink(memoryRoot(target, { home })), 'the memory link stays');
  assert.ok(fs.existsSync(path.join(target, 'node_modules', 'own.txt')));
});

test('worktree-rm keeps an unmerged branch without --force and deletes it with --force', () => {
  for (const name of ['scratch-kept', 'scratch-forced']) {
    assert.equal(run(NEW, [name]).status, 0);
    const target = laneDir(name);
    fs.writeFileSync(path.join(target, 'work.txt'), 'lane work\n');
    git(target, ['add', '--', 'work.txt']);
    git(target, [...IDENT, 'commit', '-q', '-m', 'lane work']);
  }
  const kept = run(RM, ['scratch-kept']);
  assert.equal(kept.status, 1);
  assert.match(kept.stderr, /branch "scratch-kept" was kept/);
  assert.ok(absent(laneDir('scratch-kept')));
  assert.ok(branchExists('scratch-kept'));
  const forced = run(RM, ['scratch-forced', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(absent(laneDir('scratch-forced')));
  assert.ok(!branchExists('scratch-forced'));
});

test('a missing .env source is summarized on stderr and the run still exits 0', () => {
  const name = 'scratch-no-env';
  const envFile = path.join(repo, '.env');
  const saved = fs.readFileSync(envFile);
  fs.unlinkSync(envFile);
  try {
    const res = run(NEW, [name]);
    assert.equal(res.status, 0, res.stderr);
    assert.ok(res.stderr.includes(`  skipped .env: ${envFile} is missing\n`), res.stderr);
    assert.match(res.stderr, /^worktree-new: 1 link\(s\) not made, see the header: \.env: a lane without \.env fails every server test with ECONNREFUSED$/m);
    assert.match(res.stdout, /Ready\. Open a Claude window in:/);
    assert.ok(absent(path.join(laneDir(name), '.env')));
    assert.ok(isLink(path.join(laneDir(name), 'client', '.env')), 'the others are still made');
  } finally {
    fs.writeFileSync(envFile, saved);
  }
});

test('a missing .husky/_ source is summarized with the hook consequence, not the .env one', () => {
  const name = 'scratch-no-hook';
  const hookDir = path.join(repo, '.husky', '_');
  const aside = path.join(root, 'husky-aside');
  fs.renameSync(hookDir, aside);
  try {
    const res = run(NEW, [name]);
    assert.equal(res.status, 0, res.stderr);
    const summary = res.stderr.split('\n').filter((l) => l.includes('not made'));
    assert.deepEqual(summary, ['worktree-new: 1 link(s) not made, see the header: .husky/_: commits in this lane silently skip the pre-commit hook']);
    assert.ok(!summary[0].includes('.env'));
    assert.ok(absent(path.join(laneDir(name), '.husky', '_')));
    assert.ok(isLink(path.join(laneDir(name), '.env')), 'the others are still made');
  } finally {
    fs.renameSync(aside, hookDir);
  }
});

test('a missing client/.env source names the API base, not ECONNREFUSED', () => {
  const name = 'scratch-no-client-env';
  const envFile = path.join(repo, 'client', '.env');
  const saved = fs.readFileSync(envFile);
  fs.unlinkSync(envFile);
  try {
    const res = run(NEW, [name]);
    assert.equal(res.status, 0, res.stderr);
    const summary = res.stderr.split('\n').filter((l) => l.includes('not made'));
    assert.equal(summary.length, 1, res.stderr);
    assert.ok(summary[0].includes('client/.env: '), summary[0]);
    assert.match(summary[0], /empty API base/);
    assert.doesNotMatch(summary[0], /ECONNREFUSED/);
    assert.ok(isLink(path.join(laneDir(name), '.env')), 'the others are still made');
  } finally {
    fs.writeFileSync(envFile, saved);
  }
});
