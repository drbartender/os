'use strict';

// node:test suite for scripts/board-write.sh beside board-write.test.js (which
// sits at the 700-line mark): the writer's opening sync and its refusals
// before any write (instruction rewrite step 5, lane board-writer). Each case
// runs in a throwaway repo on main under os.tmpdir() with a local bare origin,
// carrying its own copy of scripts/ (out of git through .git/info/exclude)
// with ship.js replaced by a stub that records its runs and pushes nothing,
// and the flip marker in its common dir, so the writer reaches ship as it
// does in os. Nothing here touches the real repo, its common dir or origin.

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BOARD_FIXTURE = ['# Build Board', '', 'Titles and paths only.', '', '## Ready to build', '', '## In flight', '', '## Recently shipped', '', ''].join('\n');

// No git config and no repo-locating variable from outside reaches the
// throwaway, and no ship or gate override leaks in from the shell.
function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) continue;
    if (/^DRB_(SHIP|GATE)_/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...extra };
}

function g(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const said = (r) => `exit ${r.status} signal ${r.signal}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
const occurrences = (text, s) => text.split(s).length - 1;
const boardText = (h) => fs.readFileSync(path.join(h.work, 'docs', 'build-board.md'), 'utf8');
const shipRuns = (h) => (fs.existsSync(h.shipRec) ? fs.readFileSync(h.shipRec, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const rebaseLeft = (h) => ['rebase-merge', 'rebase-apply'].filter((d) => fs.existsSync(path.join(h.work, '.git', d)));

const MOVED_LINE = (section) => `Board updated under '${section}' and committed LOCALLY, not pushed: origin/main moved during this write (a push from outside this checkout). Stop and ask: main's unpushed commits have to be replayed onto origin/main by hand, the owner's call under the push-failure rule (never a merge, which ship refuses since main holds squashes only, an auto-pull or a force), then run npm run ship; until then a board write refuses, since main cannot fast-forward.`;
const DIVERGED_LINE = (ahead, behind) => `BLOCKED: main cannot fast-forward to origin/main: main holds ${ahead} commit(s) origin/main does not, and origin/main holds ${behind} commit(s) main does not. Nothing was written or committed. Stop and ask: replaying main's unpushed commits onto origin/main is the owner's call under the push-failure rule (never a merge, which ship refuses since main holds squashes only, an auto-pull or a force); after it, run npm run ship, then write the board again unless one of those commits already holds this line.`;
const REJECTED = 'ship: result failed push rejected (fetch first): origin/main moved since the fetch; nothing was pushed and nothing is retried';

// ship.js replaced: a record of each run and the HEAD it saw; with
// cfg.advance another clone moves the remote first; then its lines on stdout
// and its exit code.
const SHIP_STUB = `
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.appendFileSync(cfg.record, JSON.stringify({ argv: process.argv.slice(2), head }) + '\\n');
if (cfg.advance) execFileSync('git', ['-C', cfg.advance, 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { stdio: 'ignore' });
for (const line of cfg.lines) process.stdout.write(line + '\\n');
process.exit(cfg.code);
`;

function stubShip(h, { lines = ['ship: result ok pushed HEAD, 1 commits'], code = 0, advance = null } = {}) {
  const cfg = { record: h.shipRec, lines, code, advance };
  fs.writeFileSync(path.join(h.scripts, 'ship.js'), ["'use strict';", "const fs = require('fs');", "const { execFileSync } = require('child_process');", `const cfg = ${JSON.stringify(cfg)};`, SHIP_STUB].join('\n'));
}

// A throwaway on main: the board fixture and one server file pushed to a
// local bare origin, its own copy of scripts/ with ship.js stubbed (or, with
// realShip, the real ship.js and a throwaway sensitive list), and the flip
// marker in its common dir.
function makeThrowaway(t, { realShip = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-write-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  g(root, 'init', '-q', '--bare', '-b', 'main', origin);
  g(root, 'init', '-q', '-b', 'main', work);
  for (const [k, v] of [['user.email', ['board', 'example.com'].join('@')], ['user.name', 'Board Writer'], ['commit.gpgsign', 'false']]) g(work, 'config', k, v);
  const scripts = path.join(work, 'scripts');
  fs.mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  for (const f of ['board-write.sh', 'push-gate.js', 'sensitive-match.js', ...(realShip ? ['ship.js', 'post-ship-watch.js'] : [])]) fs.copyFileSync(path.join(__dirname, f), path.join(scripts, f));
  if (realShip) fs.writeFileSync(path.join(scripts, 'sensitive-paths.txt'), ['# The throwaway list.', 'server/money.js', ''].join('\n'));
  for (const f of fs.readdirSync(path.join(__dirname, 'lib'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) fs.copyFileSync(path.join(__dirname, 'lib', f), path.join(scripts, 'lib', f));
  }
  fs.appendFileSync(path.join(work, '.git', 'info', 'exclude'), '/scripts/\n');
  fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(work, 'server'), { recursive: true });
  fs.writeFileSync(path.join(work, 'docs', 'build-board.md'), BOARD_FIXTURE);
  fs.writeFileSync(path.join(work, 'server', 'a.js'), 'a v1\n');
  g(work, 'add', '--', 'docs/build-board.md', 'server/a.js');
  g(work, 'commit', '-q', '-m', 'seed board');
  g(work, 'remote', 'add', 'origin', origin);
  g(work, 'push', '-q', 'origin', 'main');
  g(work, 'fetch', '-q', 'origin');
  const seed = g(work, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(work, '.git', 'drb-flip.json'), JSON.stringify({ sha: seed, pushed_at: new Date().toISOString(), written_by: 'test' }));
  const h = { root, origin, work, scripts, seed, shipRec: path.join(root, 'ship.jsonl'), env: cleanEnv() };
  if (!realShip) stubShip(h);
  return h;
}

// A second clone of the throwaway's origin with one commit writing `file`;
// pushed to origin unless push is false. Returns {dir, sha}.
function peer(h, { file = 'docs/peer.md', text = 'a peer window\n', push = true } = {}) {
  const dir = path.join(h.root, `peer-${fs.readdirSync(h.root).length}`);
  g(h.root, 'clone', '-q', h.origin, dir);
  for (const [k, v] of [['user.email', ['peer', 'example.com'].join('@')], ['user.name', 'Peer Window'], ['commit.gpgsign', 'false']]) g(dir, 'config', k, v);
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  g(dir, 'add', '--', file);
  g(dir, 'commit', '-q', '-m', `peer: ${file}`);
  if (push) g(dir, 'push', '-q', 'origin', 'main');
  return { dir, sha: g(dir, 'rev-parse', 'HEAD') };
}

// A dir holding `git`, first on PATH: it records each call's arguments (one
// line, split by \x1f) and runs the real git; with edit set, it appends a line
// to that file right after a fetch, an edit another window makes mid-write.
function gitShim(h, { edit = null } = {}) {
  const dir = path.join(h.root, 'shim');
  const rec = path.join(h.root, 'git-calls.log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const body = ['#!/bin/sh', `printf '%s\\037' "$@" >> '${rec}'`, `printf '\\n' >> '${rec}'`];
  if (edit) body.push(`if [ "$1" = fetch ]; then '${real}' "$@"; code=$?; printf 'an edit in progress\\n' >> '${edit}'; exit $code; fi`);
  body.push(`exec '${real}' "$@"`, '');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'git'), body.join('\n'), { mode: 0o755 });
  const calls = () => (fs.existsSync(rec) ? fs.readFileSync(rec, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\x1f').slice(0, -1)) : []);
  return { PATH: `${dir}${path.delimiter}${h.env.PATH}`, calls };
}

// The throwaway's copy of the writer, by the relative path a session uses.
function writeBoard(h, section, line, env = {}) {
  return spawnSync('bash', ['scripts/board-write.sh', section, line], { cwd: h.work, env: { ...h.env, ...env }, encoding: 'utf8', timeout: 60000 });
}

// The same write run in the background, for the cases where two run at once.
function writeAsync(h, section, line, env = {}) {
  return new Promise((resolve) => {
    const c = spawn('bash', ['scripts/board-write.sh', section, line], { cwd: h.work, env: { ...h.env, ...env } });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => { stdout += d; });
    c.stderr.on('data', (d) => { stderr += d; });
    c.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function waitFor(what, fn, ms = 10000) {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Nothing written or committed: main at `head`, the board as the fixture had
// it (or `board`), no rebase in progress, ship never run.
function untouched(h, head, board = BOARD_FIXTURE) {
  assert.strictEqual(g(h.work, 'rev-parse', 'HEAD'), head, 'main did not move');
  assert.strictEqual(g(h.work, 'symbolic-ref', 'HEAD'), 'refs/heads/main');
  assert.strictEqual(boardText(h), board, 'the board was not written');
  assert.deepStrictEqual(rebaseLeft(h), [], 'no rebase is in progress');
  assert.deepStrictEqual(shipRuns(h), [], 'ship never ran');
}

// ---- The sync: a fetch and a fast-forward-only merge ------------------------

test('a write behind origin fetches and fast-forwards main to origin/main: no pull, rebase or reset, and the board commit sits on the peer\'s', (t) => {
  const h = makeThrowaway(t);
  const p = peer(h);
  const shim = gitShim(h);
  const line = 'Sync by fetch and fast-forward (spec, plan)';
  const res = writeBoard(h, 'Ready to build', line, { PATH: shim.PATH });
  assert.strictEqual(res.status, 0, said(res));
  const calls = shim.calls();
  assert.deepStrictEqual(calls.filter((a) => ['pull', 'rebase', 'reset', 'checkout', 'switch', 'push', 'stash'].includes(a[0])), [], 'the writer never pulls, rebases, resets or moves the checkout another way');
  assert.ok(calls.some((a) => a.join(' ') === 'fetch --quiet origin main'), JSON.stringify(calls));
  assert.ok(calls.some((a) => a.join(' ') === `merge --ff-only --quiet ${p.sha}`), JSON.stringify(calls));
  assert.deepStrictEqual(g(h.work, 'log', '-g', '-2', '--format=%gs', 'HEAD').split('\n'), ['commit: board: update Ready to build', `merge ${p.sha}: Fast-forward`]);
  assert.strictEqual(g(h.work, 'rev-parse', 'HEAD~1'), p.sha, 'the board commit sits on the peer\'s');
  assert.strictEqual(occurrences(boardText(h), line), 1);
  assert.deepStrictEqual(shipRuns(h).map((r) => r.head), [g(h.work, 'rev-parse', 'HEAD')], 'ship ran once, on the board commit');
});

test('main holding an unpushed commit while origin moved cannot fast-forward: exit 1 and the BLOCKED line, nothing written or committed, the unpushed commit as it was', (t) => {
  const h = makeThrowaway(t);
  fs.writeFileSync(path.join(h.work, 'docs', 'notes.md'), 'another window\n');
  g(h.work, 'add', '--', 'docs/notes.md');
  g(h.work, 'commit', '-q', '-m', 'docs: another window');
  const local = g(h.work, 'rev-parse', 'HEAD');
  const p = peer(h);
  const res = writeBoard(h, 'In flight', 'A write that cannot fast-forward (spec, plan)');
  assert.strictEqual(res.status, 1, said(res));
  assert.ok(res.stderr.includes(DIVERGED_LINE(1, 1)), said(res));
  untouched(h, local);
  assert.strictEqual(g(h.work, 'rev-parse', 'HEAD~1'), h.seed, 'the unpushed commit was not replayed');
  assert.strictEqual(g(h.work, 'rev-parse', 'refs/remotes/origin/main'), p.sha, 'the fetch ran');
  assert.strictEqual(g(h.origin, 'rev-parse', 'refs/heads/main'), p.sha);
  assert.strictEqual(g(h.work, 'status', '--porcelain', '--untracked-files=no'), '', 'nothing staged or edited');
});

test('a write run again after its push was turned away keeps the board line once: the moved-origin ending, then the re-run refuses at the fast-forward', (t) => {
  const h = makeThrowaway(t);
  const other = peer(h, { push: false });
  stubShip(h, { code: 1, advance: other.dir, lines: ['ship: push git push origin HEAD:main', REJECTED] });
  const line = 'A write whose push was turned away (spec, plan)';
  const first = writeBoard(h, 'Ready to build', line);
  assert.strictEqual(first.status, 0, said(first));
  assert.match(first.stderr, /committed LOCALLY, not pushed: origin\/main moved during this write/);
  const board = g(h.work, 'rev-parse', 'HEAD');
  const again = writeBoard(h, 'Ready to build', line);
  assert.strictEqual(occurrences(boardText(h), line), 1, `the board line is there once, not twice\n${said(again)}`);
  assert.strictEqual(again.status, 1, said(again));
  assert.ok(again.stderr.includes(DIVERGED_LINE(1, 1)), said(again));
  assert.ok(first.stderr.includes(MOVED_LINE('Ready to build')), said(first));
  assert.strictEqual(g(h.work, 'rev-parse', 'HEAD'), board, 'the re-run moved nothing');
  assert.strictEqual(g(h.work, 'rev-list', '--count', `${h.seed}..HEAD`), '1', 'one board commit on the seed');
  assert.strictEqual(shipRuns(h).length, 1, 'ship ran once, for the first write');
  assert.strictEqual(g(h.origin, 'rev-parse', 'refs/heads/main'), other.sha);
  assert.deepStrictEqual(rebaseLeft(h), []);
});

test('a fetch that fails refuses: exit 1 and the BLOCKED line, nothing written or committed', (t) => {
  const h = makeThrowaway(t);
  g(h.work, 'remote', 'set-url', 'origin', path.join(h.root, 'no-such-origin.git'));
  const res = writeBoard(h, 'In flight', 'A write with no origin to fetch (spec, plan)');
  assert.strictEqual(res.status, 1, said(res));
  assert.ok(res.stderr.includes('BLOCKED: git fetch origin main failed, so main could not be synced before the write. Nothing was written or committed; write the board again once origin answers.'), said(res));
  untouched(h, h.seed);
});

test('a fast-forward git stops (another window edits a file origin changed, after the writer\'s checks) refuses: exit 1 and the BLOCKED line, nothing written or committed, the edit kept', (t) => {
  const h = makeThrowaway(t);
  peer(h, { file: 'server/a.js', text: 'a v2\n' });
  const edited = path.join(h.work, 'server', 'a.js');
  const shim = gitShim(h, { edit: edited });
  const res = writeBoard(h, 'In flight', 'A fast-forward git stops (spec, plan)', { PATH: shim.PATH });
  assert.strictEqual(res.status, 1, said(res));
  assert.match(res.stderr, /would be overwritten by merge/);
  assert.ok(res.stderr.includes('BLOCKED: git stopped the fast-forward of main to origin/main: a file it names above is uncommitted in this checkout, another window\'s work in progress; leave it alone (never commit, stash or remove it for that window). The board was not written and nothing was committed; write the board again once that window has committed it.'), said(res));
  untouched(h, h.seed);
  assert.strictEqual(fs.readFileSync(edited, 'utf8'), 'a v1\nan edit in progress\n', 'the edit is kept');
});

// ---- A clean checkout before any write ---------------------------------------
// A staged change or an edited tracked file refuses before the sync, the
// board and the commit: another window's edit of the board would ride in the
// board commit, and one in a file origin changed would stop the fast-forward
// half way. origin moves first in each case, so a fetch would show.

const CHANGES = [
  { kind: 'a staged change', path: 'server/a.js', make: (h) => { fs.writeFileSync(path.join(h.work, 'server', 'a.js'), 'a v2\n'); g(h.work, 'add', '--', 'server/a.js'); }, staged: ['server/a.js'], edited: [''] },
  { kind: 'an edited tracked file (the board itself)', path: 'docs/build-board.md', make: (h) => fs.appendFileSync(path.join(h.work, 'docs', 'build-board.md'), 'an edit in progress\n'), staged: [''], edited: ['docs/build-board.md'] },
];

for (const c of CHANGES) {
  test(`${c.kind} in the checkout refuses before anything is fetched, written or committed: exit 1 and the BLOCKED line naming it, the change kept`, (t) => {
    const h = makeThrowaway(t);
    peer(h);
    c.make(h);
    const board = boardText(h);
    const res = writeBoard(h, 'In flight', 'A write over another window\'s change (spec, plan)');
    assert.strictEqual(res.status, 1, said(res));
    assert.ok(res.stderr.includes(`BLOCKED: this checkout has a staged change or an edited tracked file (1: ${c.path}), so the board writer refuses before it fetches or touches the board: another window's work in progress never rides in a board commit or stops the fast-forward. Nothing was written or committed; write the board again once it is committed.`), said(res));
    untouched(h, h.seed, board);
    assert.strictEqual(g(h.work, 'rev-parse', 'refs/remotes/origin/main'), h.seed, 'nothing was fetched');
    assert.deepStrictEqual(g(h.work, 'diff', '--cached', '--name-only').split('\n'), c.staged, 'the staged change is still staged');
    assert.deepStrictEqual(g(h.work, 'diff', '--name-only').split('\n'), c.edited, 'the edit is still in the working tree');
  });
}

test('an untracked file is not a refusal: the write goes on, and the file stays untracked and out of the board commit', (t) => {
  const h = makeThrowaway(t);
  fs.writeFileSync(path.join(h.work, 'docs', 'draft.md'), 'an untracked draft\n');
  const line = 'A write beside an untracked file (spec, plan)';
  const res = writeBoard(h, 'Ready to build', line);
  assert.strictEqual(res.status, 0, said(res));
  assert.match(res.stdout, /^Board updated under 'Ready to build'\.$/m);
  assert.strictEqual(occurrences(boardText(h), line), 1);
  assert.deepStrictEqual(g(h.work, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n'), ['docs/build-board.md']);
  assert.strictEqual(g(h.work, 'status', '--porcelain'), '?? docs/draft.md');
  assert.strictEqual(shipRuns(h).length, 1);
});

// ---- The header (the step 4 follow-up) ---------------------------------------

test('the header comes first and the docs generator reads it; it tells callers a board write runs a real ship, minutes not seconds, and the set line sits below it', () => {
  const file = path.join(__dirname, 'board-write.sh');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  assert.strictEqual(lines[0], '#!/usr/bin/env bash');
  const header = require('./lib/genDocs/headers.js').readHeader(text, '.sh');
  assert.strictEqual(header.present, true, 'README\'s tree reads a header');
  assert.strictEqual(header.start, 1, 'the header is the line after the shebang');
  assert.strictEqual(header.description, 'board-write.sh: concurrency-safe writer for docs/build-board.md.');
  const body = lines.slice(header.start, header.end).join('\n');
  assert.match(body, /^# Callers: .*\n# .*minutes, not seconds/m, 'the long-timeout instruction for callers');
  assert.match(lines.slice(1, 5).join('\n'), /^# Callers: /m, 'the instruction is in the first five lines');
  const set = lines.indexOf('set -euo pipefail');
  assert.ok(set >= header.end, `the set line (line ${set + 1}) sits below the header (ending at line ${header.end})`);
  assert.strictEqual(lines.slice(header.end, set).every((l) => l.trim() === ''), true, 'nothing but blank lines between the header and the set line');
  assert.strictEqual(spawnSync('bash', ['-n', file]).status, 0, 'bash -n');
});

// ---- One writer at a time (the board lock) -----------------------------------

test('two writes started together in one checkout run one at a time: each line lands once and neither is lost (an mv shim holds each writer at its rename until both read the board, or 3 s)', async (t) => {
  const h = makeThrowaway(t);
  const dir = path.join(h.root, 'mvshim');
  const realMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'mv'), ['#!/bin/sh', `: > '${h.root}/at-mv-'"$WRITER"`, 'n=0',
    `while { [ ! -e '${h.root}/at-mv-A' ] || [ ! -e '${h.root}/at-mv-B' ]; } && [ "$n" -lt 60 ]; do sleep 0.05; n=$((n + 1)); done`,
    'if [ "$WRITER" = B ]; then sleep 1; fi', `exec '${realMv}' "$@"`, ''].join('\n'), { mode: 0o755 });
  const PATH = `${dir}${path.delimiter}${h.env.PATH}`;
  const [lineA, lineB] = ['A line from window A (spec, plan)', 'A line from window B (spec, plan)'];
  const [a, b] = await Promise.all([writeAsync(h, 'Ready to build', lineA, { PATH, WRITER: 'A' }), writeAsync(h, 'In flight', lineB, { PATH, WRITER: 'B' })]);
  const head = g(h.work, 'show', 'HEAD:docs/build-board.md');
  assert.deepStrictEqual([occurrences(head, lineA), occurrences(head, lineB)], [1, 1], `both lines at HEAD once\nA: ${said(a)}\nB: ${said(b)}`);
  assert.deepStrictEqual([a.status, b.status], [0, 0]);
  assert.strictEqual(g(h.work, 'rev-list', '--count', `${h.seed}..HEAD`), '2', 'one board commit per write');
  assert.strictEqual(g(h.work, 'status', '--porcelain', '--untracked-files=no'), '', 'nothing left staged or edited');
  assert.strictEqual(shipRuns(h).length, 2);
});

test('a write while another board write holds the board lock past the wait refuses: exit 1 and the BLOCKED line, nothing fetched, written or committed', async (t) => {
  const h = makeThrowaway(t);
  peer(h);
  const lock = path.join(h.work, '.git', 'drb-board.lock');
  const held = path.join(h.root, 'held');
  const holder = spawn('flock', [lock, 'sh', '-c', `: > '${held}'; sleep 20`], { stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* gone */ } });
  await waitFor('the other write to hold the board lock', () => fs.existsSync(held));
  const res = writeBoard(h, 'In flight', 'A write behind the board lock (spec, plan)', { BOARD_WRITE_LOCK_WAIT: '1' });
  assert.strictEqual(res.status, 1, said(res));
  assert.ok(res.stderr.includes(`BLOCKED: another board write held the board lock (${lock}) past the wait of 1 second(s), so this write refused before it fetched or touched the board. Nothing was written or committed; write the board again once that write is done.`), said(res));
  untouched(h, h.seed);
  assert.strictEqual(g(h.work, 'rev-parse', 'refs/remotes/origin/main'), h.seed, 'nothing was fetched');
});

// ---- The board never sits staged in the shared index -------------------------

test('a plain commit another window starts mid-write, its hook spanning the writer\'s commit, never carries the board line, and the line is on main at most once', async (t) => {
  const h = makeThrowaway(t);
  fs.writeFileSync(path.join(h.work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nsleep 2\n', { mode: 0o755 });
  const done = path.join(h.root, 'quick-fix-done');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = path.join(h.root, 'shim');
  fs.mkdirSync(dir);
  // On the writer's fetch, after its clean-checkout read: another window's
  // one-call quick fix (git add, then a plain git commit) in the background.
  fs.writeFileSync(path.join(dir, 'git'), ['#!/bin/sh',
    `if [ "$1" = fetch ]; then ( cd '${h.work}' && printf 'a quick fix\\n' > server/a.js && '${real}' add -- server/a.js && '${real}' commit -q -m 'quick fix from another window'; : > '${done}' ) 9>&- >/dev/null 2>&1 & sleep 0.5; fi`,
    `exec '${real}' "$@"`, ''].join('\n'), { mode: 0o755 });
  const line = 'A write beside another window\'s plain commit (spec, plan)';
  const res = writeBoard(h, 'In flight', line, { PATH: `${dir}${path.delimiter}${h.env.PATH}` });
  await waitFor('the other window\'s commit to end', () => fs.existsSync(done));
  const commits = g(h.work, 'log', '--format=%H', `${h.seed}..HEAD`).split('\n').filter(Boolean);
  for (const c of commits) {
    const files = g(h.work, 'diff-tree', '--no-commit-id', '--name-only', '-r', c).split('\n');
    const subject = g(h.work, 'log', '-1', '--format=%s', c);
    if (subject === 'quick fix from another window') assert.deepStrictEqual(files, ['server/a.js'], `the other window's commit carries its own file only\n${said(res)}`);
    else assert.deepStrictEqual([subject, files], ['board: update In flight', ['docs/build-board.md']]);
  }
  assert.ok(occurrences(g(h.work, 'show', 'HEAD:docs/build-board.md'), line) <= 1, 'the line is on main at most once');
  assert.strictEqual(g(h.work, 'diff', '--cached', '--name-only', '--', 'docs/build-board.md'), '', 'the board is never left staged');
  if (res.status === 0) assert.strictEqual(occurrences(g(h.work, 'show', 'HEAD:docs/build-board.md'), line), 1, said(res));
  else assert.ok(res.stderr.includes('BLOCKED: the board commit failed: main moved while the board commit ran'), said(res));
  assert.strictEqual(g(h.work, 'status', '--porcelain', '--', 'docs/build-board.md'), '', 'the board is clean in the tree either way');
});

// ---- A failed write leaves the tree as it found it ---------------------------
// Every failure after the board file is written ends with the writer's own
// BLOCKED line, the board file back at HEAD's content, the shared index and
// HEAD as they were, and ship never run.

function putBack(h, res, why, head = h.seed) {
  assert.strictEqual(res.status, 1, said(res));
  assert.ok(res.stderr.includes(`BLOCKED: the board commit failed: ${why}`), said(res));
  assert.match(res.stderr, /This write committed nothing, and the board file is back at HEAD's content\./);
  untouched(h, head, execFileSync('git', ['show', 'HEAD:docs/build-board.md'], { cwd: h.work, env: cleanEnv(), encoding: 'utf8' }));
  assert.strictEqual(g(h.work, 'status', '--porcelain', '--untracked-files=no'), '', 'nothing left staged or edited');
}

test('a commit that meets another git\'s index.lock waits it out: the lock released mid-wait, the write goes on and the line lands once', async (t) => {
  const h = makeThrowaway(t);
  const lock = path.join(h.work, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const line = 'A write that waits out index.lock (spec, plan)';
  const run = writeAsync(h, 'In flight', line, { BOARD_WRITE_LOCK_WAIT: '10' });
  setTimeout(() => fs.rmSync(lock, { force: true }), 700);
  const res = await run;
  assert.strictEqual(res.status, 0, said(res));
  assert.strictEqual(occurrences(g(h.work, 'show', 'HEAD:docs/build-board.md'), line), 1);
  assert.strictEqual(g(h.work, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('a commit behind an index.lock held past the wait puts the board back: exit 1 and the BLOCKED line, the lock left alone', (t) => {
  const h = makeThrowaway(t);
  const lock = path.join(h.work, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const res = writeBoard(h, 'In flight', 'A write behind a held index.lock (spec, plan)', { BOARD_WRITE_LOCK_WAIT: '1' });
  assert.ok(fs.existsSync(lock), 'the writer never removes another git\'s lock');
  fs.rmSync(lock);
  putBack(h, res, 'another git held index.lock past the wait of 1 second(s)');
  assert.doesNotMatch(res.stderr, /remove the file manually/, 'git\'s advice to remove the lock is not relayed');
});

test('a commit the pre-commit hook refuses puts the board back: exit 1, the hook\'s reason and the BLOCKED line', (t) => {
  const h = makeThrowaway(t);
  fs.writeFileSync(path.join(h.work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "the hook refuses this commit" >&2\nexit 1\n', { mode: 0o755 });
  const res = writeBoard(h, 'In flight', 'A write the hook refuses (spec, plan)');
  assert.match(res.stderr, /the hook refuses this commit/);
  putBack(h, res, 'git commit exited 1 (the hook\'s or git\'s reason is above)');
});

test('a commit during which another window moves main puts the board back: exit 1 and the BLOCKED line, main where that window put it', (t) => {
  const h = makeThrowaway(t);
  const flag = path.join(h.root, 'moved');
  fs.writeFileSync(path.join(h.work, '.git', 'hooks', 'pre-commit'), ['#!/bin/sh', `if [ ! -e '${flag}' ]; then`, `  : > '${flag}'`,
    '  c=$(git commit-tree "HEAD^{tree}" -p HEAD -m "another window commits during the hook") && git update-ref refs/heads/main "$c"', 'fi', ''].join('\n'), { mode: 0o755 });
  const res = writeBoard(h, 'In flight', 'A write whose HEAD moved (spec, plan)');
  const moved = g(h.work, 'rev-parse', 'HEAD');
  assert.notStrictEqual(moved, h.seed, 'the other window moved main');
  assert.strictEqual(g(h.work, 'log', '-1', '--format=%s'), 'another window commits during the hook');
  putBack(h, res, 'main moved while the board commit ran (another window committed during it)', moved);
});

// ---- A re-run never doubles the line -----------------------------------------

test('a write run again after a write that ended without its push (ship refused, the board commit local) writes nothing: the line is already under its section', (t) => {
  const h = makeThrowaway(t);
  stubShip(h, { code: 1, lines: ['ship: result refused a standing gate marker'] });
  const line = 'A write run twice (spec, plan)';
  const first = writeBoard(h, 'In flight', line);
  assert.strictEqual(first.status, 0, said(first));
  const board = g(h.work, 'rev-parse', 'HEAD');
  const again = writeBoard(h, 'In flight', line);
  assert.strictEqual(occurrences(boardText(h), line), 1, `the line is there once\n${said(again)}`);
  assert.strictEqual(again.status, 0, said(again));
  assert.match(again.stdout, /^No change to board \(line already present under 'In flight'\); nothing was written\. If the commit that holds it has not reached origin yet, npm run ship carries it\.$/m);
  assert.strictEqual(g(h.work, 'rev-parse', 'HEAD'), board, 'no second board commit');
  assert.strictEqual(shipRuns(h).length, 1, 'ship ran for the first write only');
  assert.strictEqual(g(h.work, 'status', '--porcelain', '--untracked-files=no'), '');
});

test('the same line under another section is a new line, and a section the board lacks is its own refusal: exit 3, nothing written', (t) => {
  const h = makeThrowaway(t);
  const line = 'A line in two sections (spec, plan)';
  for (const section of ['Ready to build', 'In flight']) assert.strictEqual(writeBoard(h, section, line).status, 0);
  assert.strictEqual(occurrences(boardText(h), line), 2, 'once under each section');
  const text = BOARD_FIXTURE.replace('## Recently shipped\n', '');
  fs.writeFileSync(path.join(h.work, 'docs', 'build-board.md'), text);
  g(h.work, 'commit', '-q', '-m', 'board without its last section', '--', 'docs/build-board.md');
  const head = g(h.work, 'rev-parse', 'HEAD');
  const res = writeBoard(h, 'Recently shipped', 'A line with no section (spec, plan)');
  assert.strictEqual(res.status, 3, said(res));
  assert.ok(res.stderr.includes('ERROR: docs/build-board.md has no \'## Recently shipped\' heading, so the line was not written; nothing was committed.'), said(res));
  assert.doesNotMatch(res.stdout, /line already present/);
  assert.strictEqual(g(h.work, 'rev-parse', 'HEAD'), head);
  assert.strictEqual(boardText(h), text);
});

// ---- The endings' wording ----------------------------------------------------

test('origin moving between the writer\'s sync and ship\'s own fetch (the real ship refuses: not an ancestor) is the moved-origin ending, never "rides the next ship"', (t) => {
  const h = makeThrowaway(t, { realShip: true });
  const other = peer(h, { push: false });
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = path.join(h.root, 'shim');
  fs.mkdirSync(dir);
  // Right after the writer's board commit, another clone pushes to origin.
  fs.writeFileSync(path.join(dir, 'git'), ['#!/bin/sh', `if [ "$1" = commit ]; then '${real}' "$@"; code=$?; '${real}' -C '${other.dir}' push -q origin HEAD:refs/heads/main 9>&-; exit $code; fi`, `exec '${real}' "$@"`, ''].join('\n'), { mode: 0o755 });
  const res = writeBoard(h, 'In flight', 'A write whose origin moved before ship fetched (spec, plan)', { PATH: `${dir}${path.delimiter}${h.env.PATH}` });
  assert.strictEqual(res.status, 0, said(res));
  assert.match(res.stdout, /^ {2}- [0-9a-f]{7} is not an ancestor of [0-9a-f]{7}; the range is not a push onto it$/m, 'the real ship refused on the range');
  assert.ok(res.stderr.includes(MOVED_LINE('In flight')), said(res));
  assert.doesNotMatch(res.stderr, /rides the next ship/);
  assert.strictEqual(g(h.origin, 'rev-parse', 'refs/heads/main'), other.sha, 'the board commit stayed local');
});

test('a fast-forward that meets another git\'s index.lock waits it out: the lock released mid-wait, main fast-forwards and the line lands once', async (t) => {
  const h = makeThrowaway(t);
  const p = peer(h);
  const lock = path.join(h.work, '.git', 'index.lock');
  fs.writeFileSync(lock, '');
  const line = 'A fast-forward that waits out index.lock (spec, plan)';
  const run = writeAsync(h, 'In flight', line, { BOARD_WRITE_LOCK_WAIT: '10' });
  setTimeout(() => fs.rmSync(lock, { force: true }), 700);
  const res = await run;
  assert.strictEqual(res.status, 0, said(res));
  assert.strictEqual(g(h.work, 'rev-parse', 'HEAD~1'), p.sha);
  assert.strictEqual(occurrences(g(h.work, 'show', 'HEAD:docs/build-board.md'), line), 1);
});

// ---- main in the primary checkout only ---------------------------------------

test('a write from a lane worktree, a detached HEAD or another branch refuses before anything else: exit 1 and the BLOCKED line, nothing fetched, written or committed', (t) => {
  const h = makeThrowaway(t);
  peer(h);
  const lane = path.join(h.root, 'lane');
  g(h.work, 'worktree', 'add', '-q', '-b', 'lane-x', lane);
  const cases = [
    { where: lane, setup: () => {}, said: `here HEAD is on lane-x in ${lane}` },
    { where: h.work, setup: () => g(h.work, 'checkout', '-q', '--detach', 'HEAD'), said: `here HEAD is detached in ${h.work}` },
    { where: h.work, setup: () => g(h.work, 'checkout', '-q', '-b', 'other'), said: `here HEAD is on other in ${h.work}` },
  ];
  for (const c of cases) {
    c.setup();
    const res = spawnSync('bash', [path.join(h.scripts, 'board-write.sh'), 'In flight', 'A write off main (spec, plan)'], { cwd: c.where, env: h.env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(res.status, 1, said(res));
    assert.ok(res.stderr.includes(`BLOCKED: the board writer runs only in the primary checkout (os) with main checked out; ${c.said}. Nothing was written or committed.`), said(res));
    assert.strictEqual(g(c.where, 'rev-parse', 'HEAD'), h.seed, 'nothing was committed');
    assert.strictEqual(fs.readFileSync(path.join(c.where, 'docs', 'build-board.md'), 'utf8'), BOARD_FIXTURE);
  }
  assert.strictEqual(g(h.work, 'rev-parse', 'refs/heads/main'), h.seed);
  assert.strictEqual(g(h.work, 'rev-parse', 'refs/remotes/origin/main'), h.seed, 'nothing was fetched');
  assert.deepStrictEqual(shipRuns(h), []);
});

test('a write stopped by a signal during its commit (a caller\'s timeout) puts the board back: the BLOCKED line, nothing committed, the tree clean', async (t) => {
  const h = makeThrowaway(t);
  const started = path.join(h.root, 'hook-started');
  fs.writeFileSync(path.join(h.work, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\n: > '${started}'\nsleep 20\n`, { mode: 0o755 });
  const c = spawn('bash', ['scripts/board-write.sh', 'In flight', 'A write stopped mid-commit (spec, plan)'], { cwd: h.work, env: h.env, detached: true });
  let stderr = '';
  c.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((resolve) => c.on('close', (status, signal) => resolve({ status, signal })));
  t.after(() => { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } });
  await waitFor('the commit hook to start', () => fs.existsSync(started));
  process.kill(-c.pid, 'SIGTERM');
  const res = { ...(await closed), stdout: '', stderr };
  assert.ok(stderr.includes('BLOCKED: the board commit failed: the write was stopped by a signal before its commit landed. This write committed nothing, and the board file is back at HEAD\'s content.'), said(res));
  untouched(h, h.seed);
  assert.strictEqual(g(h.work, 'status', '--porcelain', '--untracked-files=no'), '', 'nothing left staged or edited');
  assert.ok(!fs.existsSync(path.join(h.work, '.git', 'index.lock')), 'no index.lock left behind');
});
