'use strict';

// node:test suite for scripts/board-write.sh.
//
// Every case runs entirely in /tmp throwaway repos with a LOCAL BARE REMOTE
// standing in for origin. Nothing here touches the real os repo or origin.
//
// The helper operates on its cwd repo, so each test points it at a clone.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, 'board-write.sh');

// Minimal board fixture mirroring docs/build-board.md's stable anchors.
const BOARD_FIXTURE = [
  '# Build Board',
  '',
  'Titles and paths only.',
  '',
  '## Ready to build',
  '',
  '## In flight',
  '',
  '## Recently shipped',
  '',
  ''
].join('\n');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// Build a bare remote + one working clone seeded with the board fixture on
// `main`. Returns { remote, work }.
function makeRepoWithRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-write-'));
  const remote = path.join(root, 'origin.git');
  const work = path.join(root, 'work');

  git(root, ['init', '--bare', '-q', '-b', 'main', remote]);

  git(root, ['init', '-q', '-b', 'main', work]);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test User']);
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(work, 'docs', 'build-board.md'), BOARD_FIXTURE);
  git(work, ['add', '--', 'docs/build-board.md']);
  git(work, ['commit', '-q', '-m', 'seed board']);
  git(work, ['remote', 'add', 'origin', remote]);
  git(work, ['push', '-q', '-u', 'origin', 'main']);

  return { root, remote, work };
}

// A second clone of the same remote, to model a concurrent window.
function cloneOf(remote, root, name) {
  const dir = path.join(root, name);
  git(root, ['clone', '-q', remote, dir]);
  git(dir, ['config', 'user.email', `${name}@example.com`]);
  git(dir, ['config', 'user.name', `${name}`]);
  return dir;
}

function run(cwd, args) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

function boardText(cwd) {
  return fs.readFileSync(path.join(cwd, 'docs', 'build-board.md'), 'utf8');
}

test('denylist blocks a seeded email (non-zero, no write)', () => {
  const { work } = makeRepoWithRemote();
  const before = boardText(work);
  const res = run(work, ['Ready to build', 'New lane for dallas@drbartender.com']);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /BLOCKED/);
  assert.strictEqual(boardText(work), before, 'board must be untouched on a blocked write');
});

test('denylist blocks a phone number (non-zero, no write)', () => {
  const { work } = makeRepoWithRemote();
  const before = boardText(work);
  const res = run(work, ['Ready to build', 'Call client at 312-555-0142 about lane']);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /BLOCKED/);
  assert.strictEqual(boardText(work), before, 'board must be untouched on a blocked write');
});

test('denylist blocks a Stripe pi_ id (non-zero, no write)', () => {
  const { work } = makeRepoWithRemote();
  const before = boardText(work);
  const res = run(work, ['In flight', 'refund lane pi_3Abc123XyZ pending']);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /BLOCKED/);
  assert.strictEqual(boardText(work), before, 'board must be untouched on a blocked write');
});

test('denylist --check is a discrete step', () => {
  const clean = run(process.cwd(), ['--check', 'Workflow redesign L3 board (spec, plan)']);
  assert.strictEqual(clean.status, 0);
  const dirty = run(process.cwd(), ['--check', 'contact us at a@b.co']);
  assert.notStrictEqual(dirty.status, 0);
});

test('a clean board line is accepted and written', () => {
  const { work } = makeRepoWithRemote();
  const line = 'Workflow redesign L3 (docs/.../spec.md, docs/.../plan.md)';
  const res = run(work, ['Ready to build', line]);
  assert.strictEqual(res.status, 0, res.stderr);
  const text = boardText(work);
  assert.ok(text.includes(line), 'new line must appear in the board');
  // It must land under the right heading, before the next section.
  const readyIdx = text.indexOf('## Ready to build');
  const inFlightIdx = text.indexOf('## In flight');
  const lineIdx = text.indexOf(line);
  assert.ok(lineIdx > readyIdx && lineIdx < inFlightIdx, 'line must sit under Ready to build');
});

test('atomic write replaces content without corruption', () => {
  const { work } = makeRepoWithRemote();
  const line = 'L7 pre-push reconcile (spec, plan)';
  const res = run(work, ['In flight', line]);
  assert.strictEqual(res.status, 0, res.stderr);
  const text = boardText(work);
  // All three stable anchors survive, each exactly once.
  for (const anchor of ['## Ready to build', '## In flight', '## Recently shipped']) {
    const count = text.split(anchor).length - 1;
    assert.strictEqual(count, 1, `anchor ${anchor} must appear exactly once`);
  }
  assert.ok(text.includes(line));
  // No leftover temp files in the docs dir.
  const leftovers = fs.readdirSync(path.join(work, 'docs')).filter((f) => f.startsWith('.board-write.'));
  assert.deepStrictEqual(leftovers, [], 'no temp file may be left behind');
});

test('concurrent writes do not lost-update (second rebases over the first)', () => {
  const { root, remote, work } = makeRepoWithRemote();
  const other = cloneOf(remote, root, 'window2');

  const lineA = 'L5 sensitive-paths (spec, plan)';
  const lineB = 'L6 lane-lifecycle (spec, plan)';

  // Window 1 writes and pushes first.
  const resA = run(work, ['Ready to build', lineA]);
  assert.strictEqual(resA.status, 0, resA.stderr);

  // Window 2 is now behind origin. Its write must pull --rebase, replay over
  // window 1's commit, and push --ff-only, keeping BOTH lines.
  const resB = run(other, ['Ready to build', lineB]);
  assert.strictEqual(resB.status, 0, resB.stderr);

  // Pull the final state from origin into a fresh clone and assert both lines.
  const verify = cloneOf(remote, root, 'verify');
  const text = boardText(verify);
  assert.ok(text.includes(lineA), 'first window line must survive');
  assert.ok(text.includes(lineB), 'second window line must survive');
  // Each anchor still appears exactly once (no merge duplication).
  for (const anchor of ['## Ready to build', '## In flight', '## Recently shipped']) {
    const count = text.split(anchor).length - 1;
    assert.strictEqual(count, 1, `anchor ${anchor} must appear exactly once after concurrent writes`);
  }
});
