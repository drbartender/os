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

test('denylist blocks a routing or tax id shape (the shared module adds it)', () => {
  const res = run(process.cwd(), ['--check', 'bank routing 123456789 on file']);
  assert.notStrictEqual(res.status, 0);
  assert.match(res.stderr, /BLOCKED/);
  const ein = run(process.cwd(), ['--check', 'EIN 12-3456789 for the 1099']);
  assert.notStrictEqual(ein.status, 0);
});

test('denylist blocks an SSN and a routing number beside its field name', () => {
  for (const line of ['W9 lane, SSN 123-45-6789 on the form', 'routing_number 123456789 in the payload']) {
    const res = run(process.cwd(), ['--check', line]);
    assert.notStrictEqual(res.status, 0, line.slice(0, 10));
    assert.match(res.stderr, /BLOCKED/);
  }
});

test('denylist does not block snake_case identifiers (the Stripe shape is anchored)', () => {
  for (const line of ['files_in_diff is a receipt field', 'min_total and share_cents in payroll', 'status in_progress']) {
    assert.strictEqual(run(process.cwd(), ['--check', line]).status, 0, line);
  }
});

test('denylist blocks a provider key and a UUID link token (the shared module adds them)', () => {
  // built from parts so no secret-shaped literal sits in the source
  const gh = 'gh' + 'p_' + 'Q7xZ'.repeat(9);
  for (const line of [`rotate ${gh} today`, 'link /proposal/3f2a1c9e-8b7d-4e6f-a5b4-c3d2e1f0a9b8']) {
    const res = run(process.cwd(), ['--check', line]);
    assert.notStrictEqual(res.status, 0, line.slice(0, 12));
    assert.match(res.stderr, /BLOCKED/);
  }
});

test('denylist does not block a deep repo path (a slash run is a path, not a token)', () => {
  const line = 'fix list (docs/superpowers/specs/lens-audit/checks/money2seam/alpha/beta/gamma/delta.md)';
  const res = run(process.cwd(), ['--check', line]);
  assert.strictEqual(res.status, 0, res.stderr);
});

test('denylist does not block identifiers that merely contain sk_', () => {
  for (const line of ['mask_diff lane (spec, plan)', 'task_list and risk_score fields']) {
    assert.strictEqual(run(process.cwd(), ['--check', line]).status, 0, line);
  }
});

test('denylist is strict: a business line is still noise on the board', () => {
  const { COMPANY_TEXT_PHONE } = require(path.resolve(__dirname, '../server/utils/companyPhone.js'));
  const res = run(process.cwd(), ['--check', `text the line ${COMPANY_TEXT_PHONE}`]);
  assert.notStrictEqual(res.status, 0);
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

// ── The push guard ──────────────────────────────────────────────────────────
// `git push origin main` is a BRANCH push: it ships every unpushed commit on
// main, not just the board commit. Twice in 2026-08 that nearly turned a board
// line into an uncued production deploy of unrelated work. These two tests are a
// PAIR and only mean something together: the guard must refuse when other work
// is riding, and must still push when it is not. Dropping either half lets the
// script regress in one direction while the other test stays green.

function remoteBoard(remote) {
  return execFileSync('git', ['show', 'main:docs/build-board.md'], { cwd: remote, encoding: 'utf8' });
}

test('the board IS pushed when its commit is the only thing unpushed', () => {
  const { remote, work } = makeRepoWithRemote();
  const line = 'Guard positive control (spec, plan)';
  const res = run(work, ['Ready to build', line]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(remoteBoard(remote).includes(line),
    'with nothing else riding, the board must still reach origin, otherwise the guard has simply disabled pushing');
});

test('an unrelated unpushed commit is NEVER deployed by a board write', () => {
  const { remote, work } = makeRepoWithRemote();
  // Somebody merged a lane and has not pushed it. This is the real situation:
  // on 2026-08-19 it was five code files from a merged marketing lane.
  fs.writeFileSync(path.join(work, 'shipped-code.js'), 'module.exports = 1;\n');
  git(work, ['add', '--', 'shipped-code.js']);
  git(work, ['commit', '-q', '-m', 'merge(lane something): unpushed code']);

  const line = 'Guard negative control (spec, plan)';
  const res = run(work, ['In flight', line]);

  // The board write itself SUCCEEDS: the work is done, only the push defers.
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(boardText(work).includes(line), 'the board is still written locally');
  assert.match(res.stderr, /not pushed/i, 'it must say plainly that it did not push');

  // The point of the whole exercise:
  const pushed = remoteBoard(remote);
  assert.ok(!pushed.includes(line), 'the board line must NOT have reached origin');
  const remoteFiles = execFileSync('git', ['ls-tree', '--name-only', 'main'], { cwd: remote, encoding: 'utf8' });
  assert.ok(!remoteFiles.includes('shipped-code.js'),
    'the unrelated commit must NOT have been deployed: this is the bug the guard exists for');
});

// ---- After the flip (instruction rewrite step 3, lane board-ship) ----------
// With the flip marker (drb-flip.json in the throwaway's common dir) the
// writer pushes through ship.js --foreground instead of its guarded push, and
// the only-unpushed-commit guard is retired. Each case below runs the
// throwaway's own copy of scripts/ (kept out of git through
// .git/info/exclude), invoked by the relative path a session uses from os, so
// ship, the gate, the pre-push hook, the markers and the ship records are all
// the throwaway's. Wherever the real ship.js runs, the gate is the real one
// too (a docs-only range is nothing_to_run) and the watch is a stub
// (DRB_SHIP_WATCH_CMD under DRB_SHIP_ALLOW_STUBS=1), so no real endpoint is
// read; the cases where the remote moves under a push wrap git's push through
// DRB_SHIP_GIT_CMD, and the cases that pin how the writer reads ship's
// endings replace ship.js in the copy with a stub. Nothing here touches the
// real repo, its common dir or origin.

// The environment of a flip case: no git config and no repo-locating variable
// from outside reaches the throwaway, and no ship or gate override leaks in
// from the shell that runs the suite.
function flipEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) continue;
    if (/^DRB_(SHIP|GATE)_/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

function fgit(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: flipEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const s7 = (sha) => sha.slice(0, 7);
const said = (r) => `exit ${r.status} signal ${r.signal}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
const occurrences = (text, s) => text.split(s).length - 1;
const originHead = (h) => fgit(h.origin, 'rev-parse', 'refs/heads/main');
const UNKNOWN_LINE = (section) => `Board updated under '${section}' and committed; the push outcome is unknown, run npm run ship again to complete it.`;
const LOCAL_LINE = (section, reason) => `Board updated under '${section}' and committed LOCALLY, not pushed: ${reason}. It rides the next ship.`;
const MOVED_LINE = (section) => `Board updated under '${section}' and committed LOCALLY, not pushed: origin/main moved since ship's fetch (a push from outside this checkout). Stop and ask: main has to be rebased onto origin/main by hand (git pull --rebase origin main while no other window is mid-edit; ship refuses a merge commit, since main holds squashes only), then run npm run ship.`;

function records(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// Every `ship: result <state> <text>` line on stdout, as [state, text].
function shipResults(stdout) {
  return [...stdout.matchAll(/^ship: result (\S+) ?(.*)$/gm)].map((m) => [m[1], m[2]]);
}

async function waitFor(what, fn, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// An executable node script at `file`, its config embedded.
function stubFile(file, cfg, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [`#!${process.execPath}`, "'use strict';", "const fs = require('fs');", "const path = require('path');",
    "const { execFileSync, spawnSync } = require('child_process');", `const cfg = ${JSON.stringify(cfg)};`, body, ''].join('\n'), { mode: 0o755 });
  return file;
}

// The watch: a start line through the copy's shipLog (so the claim reads
// started), then a record of the sha it was given, its last act.
const WATCH_STUB = `
const sha = process.argv[2];
require(path.join(cfg.scripts, 'lib', 'shipLog.js')).watchLine(sha, 'start', 'stub watch', { cwd: process.cwd() });
fs.appendFileSync(cfg.record, JSON.stringify({ sha }) + '\\n');
`;

// git for ship's push and fetches: real git, except that the first push
// first lets another clone move the remote (and, with cfg.fetch, fetches that
// move into this repo, so git names the rejection non-fast-forward rather
// than fetch first, and, with cfg.edit, appends a line to that tracked file,
// an edit another window has in progress in the checkout).
const GIT_STUB = `
const args = process.argv.slice(2);
fs.appendFileSync(cfg.record, JSON.stringify(args) + '\\n');
if (args[0] === 'push' && !fs.existsSync(cfg.flag)) {
  fs.writeFileSync(cfg.flag, '');
  execFileSync('git', ['-C', cfg.advance, 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { stdio: 'ignore' });
  if (cfg.fetch) execFileSync('git', ['fetch', '-q', 'origin', 'main'], { stdio: 'ignore' });
  if (cfg.edit) fs.appendFileSync(cfg.edit, 'an edit in progress\\n');
}
const r = spawnSync('git', args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
`;

// ship.js replaced: a record of its call and the HEAD it saw; with
// cfg.advance another clone moves the remote; then its lines on stdout and
// its exit code, or a death by cfg.signal.
const SHIP_STUB = `
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.appendFileSync(cfg.record, JSON.stringify({ argv: process.argv.slice(2), head }) + '\\n');
if (cfg.advance) execFileSync('git', ['-C', cfg.advance, 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { stdio: 'ignore' });
for (const line of cfg.lines) process.stdout.write(line + '\\n');
if (cfg.signal) process.kill(process.pid, cfg.signal);
process.exit(cfg.code);
`;

// A throwaway on main whose seed (the board fixture and one server file) is
// pushed to a local bare origin, carrying its own copy of scripts/ with its
// own sensitive list, the flip marker in its common dir, a pre-push hook that
// runs the copy's push-gate.js verify (installed after the seed push), and
// the watch stub.
function makeFlipped(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-write-flip-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fgit(root, 'init', '-q', '--bare', '-b', 'main', origin);
  fgit(root, 'init', '-q', '-b', 'main', work);
  fgit(work, 'config', 'user.email', ['board', 'example.com'].join('@'));
  fgit(work, 'config', 'user.name', 'Board Writer');
  fgit(work, 'config', 'commit.gpgsign', 'false');
  const scripts = path.join(work, 'scripts');
  fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  for (const f of ['board-write.sh', 'ship.js', 'push-gate.js', 'post-ship-watch.js', 'sensitive-match.js']) fs.copyFileSync(path.join(__dirname, f), path.join(scripts, f));
  for (const f of fs.readdirSync(path.join(__dirname, 'lib'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) fs.copyFileSync(path.join(__dirname, 'lib', f), path.join(scripts, 'lib', f));
  }
  fs.writeFileSync(path.join(scripts, 'sensitive-paths.txt'), ['# The throwaway list.', 'server/money.js', ''].join('\n'));
  fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '/scripts/\n');
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(work, 'server'), { recursive: true });
  fs.writeFileSync(path.join(work, 'docs', 'build-board.md'), BOARD_FIXTURE);
  fs.writeFileSync(path.join(work, 'server', 'a.js'), 'a v1\n');
  fgit(work, 'add', '--', 'docs/build-board.md', 'server/a.js');
  fgit(work, 'commit', '-q', '-m', 'seed board');
  fgit(work, 'remote', 'add', 'origin', origin);
  fgit(work, 'push', '-q', 'origin', 'main');
  fgit(work, 'fetch', '-q', 'origin');
  const common = path.join(work, '.git');
  const seed = fgit(work, 'rev-parse', 'HEAD');
  const flip = path.join(common, 'drb-flip.json');
  fs.writeFileSync(flip, JSON.stringify({ sha: seed, pushed_at: new Date().toISOString(), written_by: 'test' }));
  const hook = path.join(common, 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${path.join(scripts, 'push-gate.js')}" verify\n`, { mode: 0o755 });
  const h = { root, origin, work, common, seed, flip, scripts, rec: (name) => path.join(root, `${name}.jsonl`) };
  h.watch = stubFile(path.join(root, 'stubs', 'watch'), { scripts, record: h.rec('watch') }, WATCH_STUB);
  h.env = flipEnv({ DRB_SHIP_ALLOW_STUBS: '1', DRB_SHIP_WATCH_CMD: h.watch });
  return h;
}

// A second clone of the throwaway's origin with one unpushed commit adding
// docs/other.md; returns {dir, sha}.
function otherClone(h) {
  const dir = path.join(h.root, 'other');
  fgit(h.root, 'clone', '-q', h.origin, dir);
  fgit(dir, 'config', 'user.email', ['other', 'example.com'].join('@'));
  fgit(dir, 'config', 'user.name', 'Other Clone');
  fgit(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'docs', 'other.md'), 'another clone\n');
  fgit(dir, 'add', '--', 'docs/other.md');
  fgit(dir, 'commit', '-q', '-m', 'docs: another clone');
  return { dir, sha: fgit(dir, 'rev-parse', 'HEAD') };
}

// Replaces the copy's ship.js with SHIP_STUB.
function stubShip(h, { lines = [], code = 0, signal = null, advance = null } = {}) {
  stubFile(path.join(h.scripts, 'ship.js'), { record: h.rec('ship'), lines, code, signal, advance }, SHIP_STUB);
}

// The throwaway's copy of the writer, by the relative path a session uses.
function writeBoard(h, section, line, env = {}) {
  return spawnSync('bash', ['scripts/board-write.sh', section, line], { cwd: h.work, env: { ...h.env, ...env }, encoding: 'utf8', timeout: 120000 });
}

const noGateWorktree = (h) => !fs.existsSync(path.join(h.root, 'worktrees')) || fs.readdirSync(path.join(h.root, 'worktrees')).every((n) => !n.startsWith('.gate-'));

// The rebase directories git keeps under the checkout's git dir while a
// rebase is in progress, of those present.
function rebaseLeft(h) {
  return ['rebase-merge', 'rebase-apply'].filter((d) => fs.existsSync(path.join(h.common, d)));
}

// The board commit as the writer left it: HEAD on main, one board commit on
// the seed, the line once in the board.
function boardCommitLocal(h, section, line) {
  assert.strictEqual(fgit(h.work, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.strictEqual(fgit(h.work, 'rev-list', '--count', `${h.seed}..HEAD`), '1', 'one board commit on the seed');
  assert.strictEqual(fgit(h.work, 'log', '-1', '--format=%s'), `board: update ${section}`);
  assert.strictEqual(occurrences(boardText(h.work), line), 1);
}

test('after the flip a board line on a clean main ships through ship.js --foreground and the real gate (nothing to run), and the remote moves', async (t) => {
  const h = makeFlipped(t);
  const line = 'Board ship after the flip (spec, plan)';
  const res = writeBoard(h, 'Ready to build', line);
  assert.strictEqual(res.status, 0, said(res));
  const head = fgit(h.work, 'rev-parse', 'HEAD');
  assert.strictEqual(fgit(h.work, 'log', '-1', '--format=%s'), 'board: update Ready to build');
  assert.strictEqual(originHead(h), head, 'the remote moved to the board commit');
  assert.strictEqual(occurrences(fgit(h.origin, 'show', 'main:docs/build-board.md'), line), 1);
  assert.deepStrictEqual(shipResults(res.stdout), [['ok', `pushed ${s7(head)}, 1 commits`]]);
  assert.match(res.stdout, /^Board updated under 'Ready to build' \(attempt 1\)\.$/m);
  assert.doesNotMatch(res.stderr, /LOCALLY|outcome is unknown|unpushed here/);
  // The real gate, no stub: a docs-only range is nothing_to_run with no
  // stubs recorded and no gate worktree, and the hook took the push.
  const receipt = JSON.parse(fs.readFileSync(path.join(h.common, 'drb-gate', `${head}.json`), 'utf8'));
  assert.deepStrictEqual([receipt.nothing_to_run, receipt.gates_needed, receipt.stubbed], [true, [], []]);
  assert.ok(noGateWorktree(h));
  assert.match(res.stdout + res.stderr, new RegExp(`pre-push: ${s7(head)}: the sha receipt and the review receipts over origin/main are valid`));
  await waitFor('the watch stub', () => records(h.rec('watch')).some((r) => r.sha === head));
});

test('after the flip the only-unpushed-commit guard is retired: another window\'s unpushed docs commit rides the board\'s ship', async (t) => {
  const h = makeFlipped(t);
  fs.writeFileSync(path.join(h.work, 'docs', 'notes.md'), 'another window\n');
  fgit(h.work, 'add', '--', 'docs/notes.md');
  fgit(h.work, 'commit', '-q', '-m', 'docs: another window');
  const res = writeBoard(h, 'In flight', 'Guard retired after the flip (spec, plan)');
  assert.strictEqual(res.status, 0, said(res));
  const head = fgit(h.work, 'rev-parse', 'HEAD');
  assert.strictEqual(originHead(h), head);
  assert.deepStrictEqual(shipResults(res.stdout), [['ok', `pushed ${s7(head)}, 2 commits`]]);
  assert.ok(fgit(h.origin, 'ls-tree', '--name-only', 'main', 'docs/').split('\n').includes('docs/notes.md'));
  assert.doesNotMatch(res.stderr, /unpushed here/, 'the guard did not run');
  await waitFor('the watch stub', () => records(h.rec('watch')).some((r) => r.sha === head));
});

test('after the flip an unpushed server/ commit with no receipt keeps the board commit local with ship\'s reason, exit 0, the remote unchanged', (t) => {
  const h = makeFlipped(t);
  fs.writeFileSync(path.join(h.work, 'server', 'a.js'), 'a v2\n');
  fgit(h.work, 'add', '--', 'server/a.js');
  fgit(h.work, 'commit', '-q', '-m', 'server work with no review');
  const server = fgit(h.work, 'rev-parse', 'HEAD');
  const line = 'Board behind an unreviewed commit (spec, plan)';
  const res = writeBoard(h, 'In flight', line);
  assert.strictEqual(res.status, 0, said(res));
  const results = shipResults(res.stdout);
  assert.strictEqual(results.length, 1, said(res));
  const [state, text] = results[0];
  assert.strictEqual(state, 'refused');
  assert.match(text, new RegExp(`^${s7(server)}: no review receipt`));
  assert.ok(res.stderr.includes(LOCAL_LINE('In flight', text)), said(res));
  assert.strictEqual(originHead(h), h.seed, 'nothing reached the remote');
  const head = fgit(h.work, 'rev-parse', 'HEAD');
  assert.strictEqual(fgit(h.work, 'rev-parse', 'HEAD~1'), server, 'the board commit sits on the server commit, both local');
  assert.ok(boardText(h.work).includes(line));
  assert.strictEqual(fs.existsSync(path.join(h.common, 'drb-gate', `${head}.json`)), false, 'refused before the gate');
});

test('after the flip a standing gate marker keeps the board commit local with its BLOCKED line; the board\'s docs-only gate never clears it', (t) => {
  const h = makeFlipped(t);
  const marker = path.join(h.common, 'drb-markers', 'gate.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ sha: h.seed, at: new Date().toISOString(), reason: 'smoke failed on main', gates: ['money'], on_main: true }));
  const res = writeBoard(h, 'Ready to build', 'Board under a gate marker (spec, plan)');
  assert.strictEqual(res.status, 0, said(res));
  const results = shipResults(res.stdout);
  assert.strictEqual(results.length, 1, said(res));
  const [state, text] = results[0];
  assert.strictEqual(state, 'refused');
  assert.match(text, new RegExp(`^BLOCKED: gate marker stands on ${s7(h.seed)} \\(smoke failed on main\\)`));
  assert.ok(res.stderr.includes(LOCAL_LINE('Ready to build', text)), said(res));
  assert.strictEqual(originHead(h), h.seed);
  assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8')).sha, h.seed, 'the marker stands');
});

for (const reason of ['fetch first', 'non-fast-forward']) {
  test(`after the flip a push turned away because another clone moved the remote (${reason}) stops and reports: the moved-origin line, exit 0, one ship, no rebase, the board commit local, an edit in progress untouched`, (t) => {
    const h = makeFlipped(t);
    const other = otherClone(h);
    const edited = path.join(h.work, 'server', 'a.js');
    const gitStub = stubFile(path.join(h.root, 'stubs', 'git'), { record: h.rec('git'), flag: path.join(h.root, 'advanced'), advance: other.dir, fetch: reason === 'non-fast-forward', edit: edited }, GIT_STUB);
    const line = `Board after a moved remote, ${reason} (spec, plan)`;
    const res = writeBoard(h, 'Ready to build', line, { DRB_SHIP_GIT_CMD: gitStub });
    assert.strictEqual(res.status, 0, said(res));
    assert.ok(res.stderr.includes(MOVED_LINE('Ready to build')), said(res));
    assert.doesNotMatch(res.stderr, /rides the next ship|rebasing/);
    assert.deepStrictEqual(shipResults(res.stdout), [['failed', `push rejected (${reason}): origin/main moved since the fetch; nothing was pushed and nothing is retried`]], 'ship ran exactly once');
    assert.strictEqual(records(h.rec('git')).filter((a) => a[0] === 'push').length, 1, 'one push, from that one ship');
    assert.deepStrictEqual(rebaseLeft(h), [], 'no rebase is in progress');
    boardCommitLocal(h, 'Ready to build', line);
    assert.strictEqual(originHead(h), other.sha, 'the board commit is local, not on the remote');
    assert.strictEqual(fgit(h.origin, 'rev-parse', 'main~1'), h.seed);
    assert.strictEqual(fs.readFileSync(edited, 'utf8'), 'a v1\nan edit in progress\n', 'the edit made before ship\'s push is untouched');
    assert.deepStrictEqual(fgit(h.work, 'diff', '--name-only').split('\n'), ['server/a.js']);
  });
}

test('after the flip a ship that exits 2 prints the push outcome is unknown line and exits 0, with no rebase and no second ship', (t) => {
  const h = makeFlipped(t);
  const other = otherClone(h);
  // The stub moves the remote as it runs, so a rebase after it would show:
  // the board commit would land on the other clone's commit.
  stubShip(h, { code: 2, advance: other.dir, lines: ['ship: push git push origin HEAD:main', 'ship: result unknown the outcome of the push is unknown (killed by SIGTERM); run npm run ship again to complete it'] });
  const res = writeBoard(h, 'In flight', 'Board with an unknown push (spec, plan)');
  assert.strictEqual(res.status, 0, said(res));
  assert.ok(res.stderr.includes(UNKNOWN_LINE('In flight')), said(res));
  assert.doesNotMatch(res.stderr, /Push rejected|LOCALLY/);
  const calls = records(h.rec('ship'));
  assert.strictEqual(calls.length, 1, 'ship ran once: no retry');
  assert.deepStrictEqual(calls[0].argv, ['--foreground']);
  assert.strictEqual(fgit(h.work, 'rev-parse', 'HEAD'), calls[0].head, 'the board commit ship saw is HEAD still');
  assert.strictEqual(fgit(h.work, 'rev-parse', 'HEAD~1'), h.seed, 'no rebase onto the moved remote');
  assert.strictEqual(originHead(h), other.sha);
});

// How the writer reads ship's endings beyond the brief's four: an outcome
// ship cannot vouch for is never reported as not pushed, and a refusal before
// ship's flow (no result line, no push stage) keeps the board commit local
// with ship's own line.
const SHIP_ENDINGS = [
  { name: 'a rejection result with exit 2 is the unknown line, never a retry', code: 2, lines: ['ship: result failed push rejected (non-fast-forward): origin/main moved since the fetch; nothing was pushed and nothing is retried'], ending: 'unknown' },
  { name: 'exit 1 with no result line after the push stage began is the unknown line', code: 1, lines: ['ship: push git push origin HEAD:main'], ending: 'unknown' },
  { name: 'a ship killed by a signal is the unknown line', signal: 'SIGKILL', lines: ['ship: gate push-gate.js sha on HEAD'], ending: 'unknown' },
  { name: 'a result that disagrees with the exit code is the unknown line', code: 1, lines: ['ship: result ok pushed HEAD, 1 commits'], ending: 'unknown' },
  { name: 'a refusal before the flow (exit 1, no result line, no push stage) keeps it local with ship\'s line', code: 1, lines: ['ship: HEAD is detached, not on main; ship ships main only'], ending: 'local', reason: 'HEAD is detached, not on main; ship ships main only' },
  { name: 'a run that ended after opening its record, before any push stage (exit 1, no result line), keeps it local without quoting a child\'s line', code: 1, lines: ['ship: start ship HEAD on main', 'ship: gate push-gate.js sha on HEAD', 'gate: a line the gate printed'], ending: 'local', reason: 'ship\'s run ended without a result, before its push (exit 1)' },
  { name: 'a gate failure keeps it local with its text', code: 1, lines: ['ship: gate push-gate.js sha on HEAD', 'ship: result failed gate failed at HEAD (exit 1); not passed: money'], ending: 'local', reason: 'gate failed at HEAD (exit 1); not passed: money' },
  { name: 'pushed-elsewhere with exit 0 is success', code: 0, lines: ['ship: result pushed-elsewhere HEAD is already on origin/main; another push carried it'], ending: 'success' },
];

for (const e of SHIP_ENDINGS) {
  test(`after the flip the writer reads ship's ending: ${e.name}`, (t) => {
    const h = makeFlipped(t);
    stubShip(h, e);
    const res = writeBoard(h, 'In flight', 'Board ending case (spec, plan)');
    assert.strictEqual(res.status, 0, said(res));
    assert.strictEqual(records(h.rec('ship')).length, 1, 'one ship, no retry');
    if (e.ending === 'unknown') {
      assert.ok(res.stderr.includes(UNKNOWN_LINE('In flight')), said(res));
      assert.doesNotMatch(res.stderr, /LOCALLY/);
    } else if (e.ending === 'local') {
      assert.ok(res.stderr.includes(LOCAL_LINE('In flight', e.reason)), said(res));
    } else {
      assert.match(res.stdout, /^Board updated under 'In flight' \(attempt 1\)\.$/m);
      assert.doesNotMatch(res.stderr, /LOCALLY|outcome is unknown/);
    }
    assert.strictEqual(originHead(h), h.seed);
  });
}

test('after the flip an unreadable flip marker prints its BLOCKED line and keeps the board commit local; ship never runs', (t) => {
  const h = makeFlipped(t);
  stubShip(h, { code: 0, lines: ['ship: result ok pushed HEAD, 1 commits'] });
  fs.writeFileSync(h.flip, '{"sha": ');
  const line = 'Board under a torn flip marker (spec, plan)';
  const res = writeBoard(h, 'Recently shipped', line);
  assert.strictEqual(res.status, 0, said(res));
  assert.match(res.stderr, /^Board updated under 'Recently shipped' and committed LOCALLY, not pushed\.$/m);
  assert.match(res.stderr, /^ {2}BLOCKED: the flip marker \S*drb-flip\.json is unreadable; repair or remove it by hand$/m);
  assert.match(res.stderr, /^ {2}The board rides the next real push\. Nothing is lost\.$/m);
  assert.deepStrictEqual(records(h.rec('ship')), [], 'ship never ran');
  assert.strictEqual(originHead(h), h.seed);
  assert.strictEqual(fgit(h.work, 'log', '-1', '--format=%s'), 'board: update Recently shipped');
  assert.ok(boardText(h.work).includes(line));
});

test('after the flip a flip state that cannot be read (markers.js fails to load) keeps the board commit local, failing closed; ship never runs', (t) => {
  const h = makeFlipped(t);
  stubShip(h, { code: 0, lines: ['ship: result ok pushed HEAD, 1 commits'] });
  fs.writeFileSync(path.join(h.scripts, 'lib', 'markers.js'), "throw new Error('markers.js broken on purpose');\n");
  const res = writeBoard(h, 'Ready to build', 'Board with a broken markers module (spec, plan)');
  assert.strictEqual(res.status, 0, said(res));
  assert.match(res.stderr, /^Board updated under 'Ready to build' and committed LOCALLY, not pushed\.$/m);
  assert.match(res.stderr, /^ {2}Could not read the flip state from scripts\/lib\/markers\.js, so refusing to push\.$/m);
  assert.deepStrictEqual(records(h.rec('ship')), [], 'ship never ran');
  assert.strictEqual(originHead(h), h.seed);
});

// ---- The shared index (controller fix, lane board-ship) ---------------------
// os is one checkout that every window shares, its index included. The
// writer's no-change check and its commit both name the board file, so a
// change another window stages while the writer runs stays staged and never
// rides in a board commit, on either branch. The stage is injected by a git
// shim first on PATH, after the writer's pull and right before its own add of
// the board: a file staged before the write never gets that far, because
// git pull --rebase refuses to run over a staged change (exit 128, nothing
// written).

// A shim dir holding `git`: the first time it sees the writer's
// `git add -- docs/build-board.md` it stages `file` through the real git,
// as another window would, then runs the requested command; every other call
// passes straight through. Returns {dir, flag}; flag exists once it fired.
function stagingShim(root, file) {
  const dir = path.join(root, 'shim');
  const flag = path.join(root, 'staged-by-another-window');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'git'), [
    '#!/bin/sh',
    `if [ "$1" = add ] && [ "$3" = docs/build-board.md ] && [ ! -e '${flag}' ]; then`,
    `  : > '${flag}'`,
    `  '${real}' add -- '${file}' || exit 1`,
    'fi',
    `exec '${real}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  return { dir, flag };
}

const withShim = (env, shim) => ({ ...env, PATH: `${shim.dir}${path.delimiter}${env.PATH}` });

test('no flip marker: a file another window stages during the write stays staged and out of the board commit, and the push carries only the board commit', (t) => {
  const { root, remote, work } = makeRepoWithRemote();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const before = git(remote, ['rev-parse', 'main']);
  fs.mkdirSync(path.join(work, 'server'), { recursive: true });
  fs.writeFileSync(path.join(work, 'server', 'quickfix.js'), 'module.exports = 2;\n');
  const shim = stagingShim(root, 'server/quickfix.js');
  const line = 'Board beside a staged quick fix (spec, plan)';
  const res = spawnSync('bash', [SCRIPT, 'In flight', line], { cwd: work, encoding: 'utf8', env: withShim(process.env, shim) });
  assert.strictEqual(res.status, 0, said(res));
  assert.ok(fs.existsSync(shim.flag), 'the other window staged its file during the write');
  assert.deepStrictEqual(git(work, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).split('\n'), ['docs/build-board.md'], 'the board commit carries the board file only');
  assert.deepStrictEqual(git(work, ['diff', '--cached', '--name-only']).split('\n'), ['server/quickfix.js'], 'the quick fix is still staged');
  assert.ok(boardText(work).includes(line));
  // Nothing else was unpushed, so the guarded push went out: the board commit alone.
  assert.strictEqual(git(remote, ['rev-parse', 'main']), git(work, ['rev-parse', 'HEAD']));
  assert.strictEqual(git(remote, ['rev-parse', 'main~1']), before);
  assert.deepStrictEqual(git(remote, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'main']).split('\n'), ['docs/build-board.md']);
  assert.ok(!git(remote, ['ls-tree', '-r', '--name-only', 'main']).split('\n').includes('server/quickfix.js'), 'the staged quick fix never reached origin');
});

test('after the flip a file another window stages during the write stays staged and out of the board commit, and the board ships alone', async (t) => {
  const h = makeFlipped(t);
  fs.writeFileSync(path.join(h.work, 'server', 'quickfix.js'), 'module.exports = 2;\n');
  const shim = stagingShim(h.root, 'server/quickfix.js');
  const line = 'Board beside a staged quick fix after the flip (spec, plan)';
  const res = writeBoard(h, 'In flight', line, { PATH: withShim(h.env, shim).PATH });
  assert.strictEqual(res.status, 0, said(res));
  assert.ok(fs.existsSync(shim.flag), 'the other window staged its file during the write');
  const head = fgit(h.work, 'rev-parse', 'HEAD');
  assert.deepStrictEqual(fgit(h.work, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'), ['docs/build-board.md'], 'the board commit carries the board file only');
  assert.deepStrictEqual(fgit(h.work, 'diff', '--cached', '--name-only').split('\n'), ['server/quickfix.js'], 'the quick fix is still staged');
  assert.ok(boardText(h.work).includes(line));
  assert.deepStrictEqual(shipResults(res.stdout), [['ok', `pushed ${s7(head)}, 1 commits`]]);
  assert.strictEqual(originHead(h), head);
  assert.strictEqual(fgit(h.origin, 'rev-parse', 'main~1'), h.seed);
  assert.ok(!fgit(h.origin, 'ls-tree', '-r', '--name-only', 'main').split('\n').includes('server/quickfix.js'), 'the staged quick fix never reached origin');
  await waitFor('the watch stub', () => records(h.rec('watch')).some((r) => r.sha === head));
});

test('no flip marker: a board missing the target section commits nothing, even with a file another window staged during the write', (t) => {
  const { root, remote, work } = makeRepoWithRemote();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // The append finds no "## Recently shipped" heading, so the board is unchanged.
  fs.writeFileSync(path.join(work, 'docs', 'build-board.md'), BOARD_FIXTURE.replace('## Recently shipped\n', ''));
  git(work, ['commit', '-q', '-m', 'board without its last section', '--', 'docs/build-board.md']);
  git(work, ['push', '-q', 'origin', 'main']);
  const before = git(work, ['rev-parse', 'HEAD']);
  fs.mkdirSync(path.join(work, 'server'), { recursive: true });
  fs.writeFileSync(path.join(work, 'server', 'quickfix.js'), 'module.exports = 2;\n');
  const shim = stagingShim(root, 'server/quickfix.js');
  const res = spawnSync('bash', [SCRIPT, 'Recently shipped', 'Board line with no section (spec, plan)'], { cwd: work, encoding: 'utf8', env: withShim(process.env, shim) });
  assert.strictEqual(res.status, 0, said(res));
  assert.ok(fs.existsSync(shim.flag), 'the other window staged its file during the write');
  assert.match(res.stdout, /^No change to board \(line already present\)\.$/m);
  assert.strictEqual(git(work, ['rev-parse', 'HEAD']), before, 'nothing was committed');
  assert.strictEqual(git(remote, ['rev-parse', 'main']), before, 'nothing was pushed');
  assert.deepStrictEqual(git(work, ['diff', '--cached', '--name-only']).split('\n'), ['server/quickfix.js'], 'the quick fix is still staged');
});

// ---- A temp file for ship's output (fix round 1, lane board-ship) -----------
// The one statement on the flip branch that can fail between the board commit
// and ship's run: a failed mktemp ends with the LOCALLY line, and ship never
// runs.

test('after the flip a temp file that cannot be made for ship\'s output keeps the board commit local with the LOCALLY line, exit 0; ship never runs', (t) => {
  const h = makeFlipped(t);
  stubShip(h, { code: 0, lines: ['ship: result ok pushed HEAD, 1 commits'] });
  const line = 'Board line with no temp dir (spec, plan)';
  const res = writeBoard(h, 'In flight', line, { TMPDIR: path.join(h.root, 'no-such-dir') });
  assert.strictEqual(res.status, 0, said(res));
  assert.ok(res.stderr.includes(LOCAL_LINE('In flight', 'no temp file could be made for ship\'s output, so ship did not run')), said(res));
  assert.deepStrictEqual(records(h.rec('ship')), [], 'ship never ran');
  boardCommitLocal(h, 'In flight', line);
  assert.strictEqual(originHead(h), h.seed);
});
