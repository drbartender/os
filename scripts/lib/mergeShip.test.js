'use strict';

// Suite for scripts/lib/mergeShip.js (plan 2026-10-28 step 5, lane
// merge-ship): the argument and name rules, merge-lane.sh's ship-mode hooks
// read straight (a run directory of another parent, a tip or a main that moved
// after the check, the body and the sha handed back), the suites callback, the
// wrapper's own refused line for flockExec's silent stops, the detached run's
// lock proof, and a ship nested under a holder of the ship lock. Every case
// runs in a throwaway os under the temp dir with the real sensitive list on
// its main, where check reads it; receipts are written through the
// review-receipt CLI (scripts/lib/receiptTestkit.js). The squash helpers'
// cases are scripts/lib/mergeShipSquash.test.js, the end to end cases
// scripts/merge-lane.ship.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SUITE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-ship-suite-'));
process.env.TMPDIR = SUITE_TMP;
process.env.MERGE_LANE_LOCK_WAIT = '2';
for (const k of Object.keys(process.env)) if (/^DRB_(SHIP|GATE)_|^MERGE_LANE_SHIP$/.test(k)) delete process.env[k];
test.after(() => fs.rmSync(SUITE_TMP, { recursive: true, force: true }));

const K = require('./receiptTestkit');
const SM = require('../sensitive-match');
const MC = require('./mergeCheck');
const MS = require('./mergeShip');
const SQ = require('./mergeShipSquash');

const { git, commit, tmpDir } = K;
const LIB = path.join(__dirname, 'mergeShip.js');
const SHELL = path.resolve(__dirname, '..', 'merge-lane.sh');
const FLOCK_EXEC = path.join(__dirname, 'flockExec.js');
const s7 = (sha) => sha.slice(0, 7);

function makeOs(t) {
  const repo = K.makeRepo(t);
  commit(repo, 'the sensitive list', { 'scripts/sensitive-paths.txt': fs.readFileSync(path.join(__dirname, '..', 'sensitive-paths.txt'), 'utf8') });
  return repo;
}

function lane(t, repo, branch, files) {
  const wt = path.join(tmpDir(t, 'wt'), branch);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  return { wt, tip: commit(wt, `${branch} work`, files) };
}

let selects = 0;
function review(t, repo, branch) {
  K.ok(K.cli(repo, 'init', '--branch', branch));
  const base = git(repo, 'merge-base', 'main', branch);
  const files = git(repo, 'diff', '--name-only', base, branch).split('\n').filter((f) => f && f !== 'README.md' && f !== 'ARCHITECTURE.md');
  K.prepare(t, repo, branch, files, { tier: 'B' });
  const select = path.join(repo, '.git', `select-ms-${++selects}.json`);
  fs.writeFileSync(select, JSON.stringify({ tier: 'B', tiers_by_file: SM.tierFromGit({ base, tip: branch }, { cwd: repo }).tiersByFile }));
  K.ok(K.cli(repo, 'finalize', branch, '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', 'B', '--select', select, '--not-a-fix', 'a test lane'));
}

test('the arguments: two positionals and three flags; --tip and --resume only with a full sha, --resume only for the run; a reserved or unusable branch name is refused; the usage line names check, merged and ship only', () => {
  assert.deepEqual(MS.parseArgs(['lane-1', 'docs/p.md']), { branch: 'lane-1', plan: 'docs/p.md', noPush: false, resolved: false, foreground: false, tip: null, resume: null });
  assert.deepEqual(MS.parseArgs(['lane-1', 'docs/p.md', '--no-push', '--resolved', '--foreground']), { branch: 'lane-1', plan: 'docs/p.md', noPush: true, resolved: true, foreground: true, tip: null, resume: null });
  const sha = 'ab'.repeat(20);
  assert.equal(MS.parseArgs(['lane-1', 'docs/p.md', '--tip', sha]).tip, sha);
  assert.equal(MS.parseArgs(['lane-1', 'docs/p.md', '--resume', sha]).resume, sha);
  for (const bad of [['lane-1'], ['lane-1', 'docs/p.md', 'more'], ['lane-1', 'docs/p.md', '--bogus'], ['lane-1', 'docs/p\nmd'], ['lane-1', 'docs/p.md', '--tip', 'abc'], ['lane-1', 'docs/p.md', '--resume', 'abc']]) {
    assert.equal(MS.parseArgs(bad), null, bad.join(' '));
  }
  for (const name of ['check', 'merged', 'ship']) assert.match(MS.nameProblem(name), /is never shipped \(check, merged and ship are this script's subcommands\)/);
  assert.match(MS.nameProblem('a..b'), /is not a usable branch name/);
  assert.equal(MS.nameProblem('lane-1'), null);
  assert.match(MS.USAGE, /^usage: scripts\/merge-lane\.sh ship <lane-branch> <plan-link> \[--no-push\] \[--resolved\] \[--foreground\] \| check <lane-branch> \| merged <lane-branch>\n$/);
  const r = spawnSync(process.execPath, [LIB, 'ship', 'lane-1'], { encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, '', MS.USAGE]);
  const resumeFlag = spawnSync(process.execPath, [LIB, 'ship', 'lane-1', 'docs/p.md', '--resume', sha], { encoding: 'utf8' });
  assert.deepEqual([resumeFlag.status, resumeFlag.stderr], [2, MS.USAGE], '--resume is the run\'s own flag');
  const named = spawnSync(process.execPath, [LIB, 'ship', 'ship', 'docs/p.md'], { encoding: 'utf8' });
  assert.equal(named.status, 1);
  assert.match(named.stdout, /^refused a lane branch named ship is never shipped/);
});

test('the shell\'s ship mode: a run directory of another parent refuses, a tip or a main that moved after the check refuses, and a pinned run lands its body and hands back its sha with no notice', (t) => {
  const repo = makeOs(t);
  const seed = git(repo, 'rev-parse', 'HEAD~1');
  const { tip } = lane(t, repo, 'lane-h', { 'server/a.js': 'a v2\n' });
  const head = git(repo, 'rev-parse', 'HEAD');
  const dir = tmpDir(t, 'run');
  const put = (files) => { for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(dir, k), `${v}\n`); };
  const run = () => spawnSync('bash', [SHELL, 'lane-h', 'docs/plan.md'], { cwd: repo, encoding: 'utf8', env: { ...process.env, MERGE_LANE_LOCKED: String(process.pid), MERGE_LANE_SHIP: dir } });
  put({ pid: 1, tip, main: head });
  let r = run();
  assert.deepEqual([r.status, r.stderr], [1, "REFUSED: MERGE_LANE_SHIP names no ship run of this merge's parent; nothing was merged.\n"]);
  put({ pid: process.pid, tip: seed });
  r = run();
  assert.equal(r.stderr, `REFUSED: 'lane-h' moved after the ship's check judged it at ${s7(seed)} (now ${s7(tip)}); nothing was merged.\n`);
  put({ tip, main: seed });
  r = run();
  assert.equal(r.stderr, `REFUSED: main moved after the ship's check judged it at ${s7(seed)} (${git(repo, 'log', '-1', '--format=%h %s', head)} landed from another window); the merge staged nothing and merged nothing. Run it again.\n`);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'nothing squashed');
  assert.equal(git(repo, 'status', '--porcelain'), '');
  put({ main: head, body: 'Review: tier B\n  lenses:   seams' });
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /NEXT: re-run/, 'no notice');
  const squash = git(repo, 'rev-parse', 'HEAD');
  assert.equal(fs.readFileSync(path.join(dir, 'commit'), 'utf8'), `${squash}\n`);
  assert.equal(git(repo, 'log', '-1', '--format=%B'), 'merge(lane lane-h): docs/plan.md\n\nReview: tier B\n  lenses:   seams');
});

// A conflict on README.md resolved and staged in os as the session would,
// and a ship's run directory naming the main it judged and that tree.
function stagedResolution(t, label) {
  const repo = makeOs(t);
  const { tip } = lane(t, repo, `lane-${label}`, { 'README.md': 'readme\nlane prose\n', 'server/c.js': 'c\n' });
  const main = commit(repo, 'main prose', { 'README.md': 'readme\nmain prose\n' });
  spawnSync('git', ['merge', '--squash', `lane-${label}`], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'README.md'), 'readme\nlane prose\nmain prose\n');
  git(repo, 'add', '--', 'README.md');
  const dir = tmpDir(t, 'run');
  for (const [k, v] of Object.entries({ pid: process.pid, tip, main, resolved: SQ.indexTree(repo) })) fs.writeFileSync(path.join(dir, k), `${v}\n`);
  const run = () => spawnSync('bash', [SHELL, `lane-${label}`, 'docs/plan.md'], { cwd: repo, encoding: 'utf8', env: { ...process.env, MERGE_LANE_LOCKED: String(process.pid), MERGE_LANE_SHIP: dir } });
  return { repo, main, run, dir };
}

test('the shell\'s ship mode under --resolved, main moved past the judged main: a plain commit of the shared index that took the resolution is named as carrying it; a pathspec commit of another file leaves the resolution staged', (t) => {
  const a = stagedResolution(t, 'rc');
  git(a.repo, 'commit', '-q', '-m', 'another window');
  const took = git(a.repo, 'log', '-1', '--format=%h %s');
  let r = a.run();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, new RegExp(`^REFUSED: main moved under the merge \\(after the ship's check judged it at ${s7(a.main)}\\): ${took} from another window already carries every path of the squash `, 'm'));
  assert.doesNotMatch(r.stderr, /the merge staged nothing/);
  assert.equal(git(a.repo, 'status', '--porcelain'), '');
  const b = stagedResolution(t, 'rn');
  fs.writeFileSync(path.join(b.repo, 'other.txt'), 'theirs\n');
  git(b.repo, 'add', '--', 'other.txt');
  git(b.repo, 'commit', '-q', '-m', 'another window', '--', 'other.txt');
  r = b.run();
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stderr, `REFUSED: main moved after the ship's check judged it at ${s7(b.main)} (${git(b.repo, 'log', '-1', '--format=%h %s')} landed from another window); the merge staged nothing and merged nothing. Run it again.\n`);
  assert.equal(git(b.repo, 'diff', '--cached', '--name-only'), 'README.md\nserver/c.js', 'the resolution stays staged');
});

test('the shell\'s ship mode under --resolved plans the squash against the pin only: a commit landing at the ORIG_HEAD read (no merge ran, so ORIG_HEAD is not this run\'s) is never planned against', (t) => {
  const a = stagedResolution(t, 'ow');
  fs.rmSync(path.join(a.repo, '.git', 'ORIG_HEAD'), { force: true });
  const shim = tmpDir(t, 'shim');
  const log = path.join(shim, 'merge-tree.log');
  const flag = path.join(shim, 'landed');
  const real = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(shim, 'git'), ['#!/usr/bin/env bash',
    `if [ "$1" = merge-tree ]; then printf '%s\\n' "$*" >> '${log}'; fi`,
    `if [ "$*" = "rev-parse -q --verify ORIG_HEAD" ] && [ ! -e '${flag}' ]; then : > '${flag}'; printf 'theirs\\n' > other.txt; '${real}' add -- other.txt && '${real}' commit -q -m 'another window' -- other.txt; fi`,
    `exec '${real}' "$@"`, ''].join('\n'), { mode: 0o755 });
  const r = spawnSync('bash', [SHELL, 'lane-ow', 'docs/plan.md'], { cwd: a.repo, encoding: 'utf8', env: { ...process.env, PATH: `${shim}:${process.env.PATH}`, MERGE_LANE_LOCKED: String(process.pid), MERGE_LANE_SHIP: a.dir } });
  assert.ok(fs.existsSync(flag), `the commit landed at the ORIG_HEAD read: ${r.stderr}`);
  assert.equal(r.status, 1, r.stderr);
  const planned = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').at(-2));
  assert.deepEqual(planned, [a.main], 'merge-tree ran against the pin alone');
});

test('dropBranch keeps the branch and says why in plain words: merged-lane checks that could not run, one that failed, two that failed', (t) => {
  const log = path.join(tmpDir(t, 'log'), 'tip.log');
  const ship = new MS.Ship({ cwd: makeOs(t), branch: 'lane-1', log, foreground: false });
  const checks = (...bad) => ({ ok: false, checks: ['squash', 'files', 'worktree'].map((name) => ({ name, ok: !bad.includes(name), text: name })) });
  assert.equal(ship.dropBranch(null), 'the branch lane-1 is kept (the merged-lane checks could not run)');
  assert.equal(ship.dropBranch(checks('worktree')), 'the branch lane-1 is kept (the worktree merged-lane check failed)');
  assert.equal(ship.dropBranch(checks('files', 'worktree')), 'the branch lane-1 is kept (the files and worktree merged-lane checks failed)');
  const said = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(1).join(' '));
  assert.deepEqual(said, ['branch lane-1 is kept: the merged-lane checks could not run', 'branch lane-1 is kept: the worktree merged-lane check failed', 'branch lane-1 is kept: the files and worktree merged-lane checks failed']);
});

test('the branch delete is tied to the tip the comparison read: a lane commit landing between the comparison and the delete, one that passes the three merged-lane checks, keeps the branch, named; at the tip compared the branch goes, its config section with it', (t) => {
  const repo = makeOs(t);
  const base = git(repo, 'rev-parse', 'main');
  const { wt, tip } = lane(t, repo, 'lane-u', { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' });
  git(repo, 'merge', '--squash', '-q', 'lane-u');
  git(repo, 'commit', '-q', '-m', 'merge(lane lane-u): docs/plan.md');
  const squash = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'remove', wt);
  git(repo, 'config', 'branch.lane-u.description', 'a lane');
  const ship = new MS.Ship({ cwd: repo, branch: 'lane-u', log: path.join(tmpDir(t, 'log'), 'tip.log'), foreground: false });
  assert.equal(SQ.strandLine(repo, 'lane-u', squash, tip), null, 'the comparison reads the branch at the lane tip');
  // The lane window's commit, as git commit makes it: a.js back to its base content, the branch moved by update-ref.
  const idx = path.join(tmpDir(t, 'idx'), 'index');
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: idx } }).stdout.trim();
  g('read-tree', tip);
  g('update-index', '--cacheinfo', `100644,${git(repo, 'rev-parse', `${base}:server/a.js`)},server/a.js`);
  const back = g('commit-tree', '-p', tip, '-m', 'a back to its base content', g('write-tree'));
  git(repo, 'update-ref', 'refs/heads/lane-u', back, tip);
  const m = MC.mergedLane({ cwd: repo, branch: 'lane-u' });
  assert.equal(m.ok, true, `the three merged-lane checks pass on the moved tip: ${m.checks.map((c) => c.text).join('; ')}`);
  assert.equal(ship.dropBranch(m, null, tip), `the branch lane-u is kept for a new review (it moved after the comparison read ${s7(tip)}, now at ${s7(back)})`);
  assert.equal(git(repo, 'rev-parse', 'refs/heads/lane-u'), back, 'the branch keeps the commit');
  assert.equal(ship.dropBranch(m, null, back), 'no worktree, the three merged-lane checks passed, the branch lane-u deleted', 'at the tip compared it goes; the worktree went by hand, not by the cleanup');
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/lane-u'], { cwd: repo }).status, 1, 'deleted');
  assert.equal(spawnSync('git', ['config', '--get', 'branch.lane-u.description'], { cwd: repo }).status, 1, 'its config section with it');
});

test('the cleanup\'s kept-branch line runs inside its step guard: a log that cannot take it is a worktree step failure named in the result, never a throw past the cleanup', (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-k', { 'server/b.js': 'b v2\n' });
  const ship = new MS.Ship({ cwd: repo, branch: 'lane-k', log: repo, foreground: false, out: () => {} }); // a directory: no line lands
  ship.squash = commit(repo, 'merge(lane lane-k): docs/plan.md', { 'docs/other.md': 'not the lane\n' });
  const err = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let told;
  try {
    told = ship.cleanup();
  } finally {
    process.stderr.write = write;
  }
  assert.match(told, /^the cleanup's worktree step failed \(EISDIR[^;]*; /, told);
  assert.match(told, /the branch lane-k is kept$/);
  assert.ok(err.some((l) => /^merge-lane ship: cleanup the worktree step failed \(EISDIR/.test(l)), err.join(''));
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/lane-k'], { cwd: repo }).status, 0, 'the branch stays');
});

test('the suites callback: the named suites through run-suites into the run directory, green exits 0, red exits 1 naming the suite, an option-shaped path is refused', (t) => {
  const repo = K.makeRepo(t);
  commit(repo, 'two suites', {
    'server/ok.test.js': "const test = require('node:test');\ntest('ok', () => {});\n",
    'server/red.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\ntest('red', () => assert.fail('red'));\n",
  });
  const dir = tmpDir(t, 'run');
  const log = path.join(tmpDir(t, 'log'), 'tip.log');
  const run = (list) => {
    fs.rmSync(path.join(dir, 'suites-run'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dir, 'log'), `${log}\n`);
    fs.writeFileSync(path.join(dir, 'suites'), `${list.join('\n')}\n`);
    return spawnSync(process.execPath, [LIB, 'suites', dir], { cwd: repo, encoding: 'utf8', timeout: 120000 });
  };
  assert.equal(run(['server/ok.test.js']).status, 0);
  assert.equal(run(['server/red.test.js']).status, 1);
  assert.equal(run(['--staged']).status, 1);
  const said = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(1).join(' '));
  assert.deepEqual(said, [
    "suites the receipt's 1 suite(s) green on the merged tree, pass 1",
    "suites the receipt's suites failed on the merged tree (exit 1; not green: server/red.test.js)",
    'suites the run directory names no suite the runner may take; refused',
  ]);
});

const SILENT = 'before it answered, so nothing was merged: flock exits 66 on a lock file it cannot open, flockExec exits 1 when the DRB_SHIP_LOCK guard\'s pid is gone, and a stop signal or a crash can end it before its first line; its stderr says which\n';

test('the wrapper\'s own refused line for a silent stop names the exit and every way it comes about: a lock file flock cannot open, a guard whose pid is gone, a stop while it waits for the lock', async (t) => {
  const repo = K.makeRepo(t);
  const lockFile = path.join(repo, '.git', 'drb-ship.lock');
  fs.writeFileSync(lockFile, '');
  fs.chmodSync(lockFile, 0o000);
  const r = spawnSync(process.execPath, [LIB, 'ship', 'lane-1', 'docs/plan.md'], { cwd: repo, encoding: 'utf8', timeout: 30000 });
  fs.chmodSync(lockFile, 0o600);
  assert.deepEqual([r.status, r.stdout], [66, `refused the locked run ended exit 66 ${SILENT}`]);
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  const g = spawnSync(process.execPath, [LIB, 'ship', 'lane-1', 'docs/plan.md'], { cwd: repo, encoding: 'utf8', timeout: 30000, env: { ...process.env, DRB_SHIP_LOCK: lockFile, DRB_SHIP_LOCK_PID: gone } });
  assert.equal(g.status, 1);
  assert.equal(g.stdout, `refused the locked run ended exit 1 ${SILENT}`);
  assert.match(g.stderr, new RegExp(`\\(pid ${gone}\\) is gone; stopping without running`));
  // A stop while the locked run waits for a lock another holder has.
  const holder = spawn('flock', [lockFile, 'sleep', '30'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  for (let i = 0; i < 100 && spawnSync('flock', ['-n', lockFile, 'true']).status === 0; i++) await new Promise((res) => setTimeout(res, 50));
  const w = spawn(process.execPath, [LIB, 'ship', 'lane-1', 'docs/plan.md'], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
  const said = { out: '', err: '' };
  w.stdout.on('data', (b) => { said.out += b; });
  w.stderr.on('data', (b) => { said.err += b; });
  for (let i = 0; i < 200 && !said.err.includes(MC.WAIT_LINE); i++) await new Promise((res) => setTimeout(res, 50));
  assert.ok(said.err.includes(MC.WAIT_LINE), said.err);
  const ended = new Promise((res) => w.on('close', res));
  w.kill('SIGTERM');
  assert.notEqual(await ended, 0);
  const how = /^refused the locked run ended (exit \d+|by SIGTERM) /.exec(said.out);
  assert.ok(how, said.out);
  assert.equal(said.out.slice(how[0].length), SILENT);
});

test('the detached run proves the lock on its descriptor 3 before anything, and ends failed with nothing merged when it holds none', (t) => {
  const repo = makeOs(t);
  const head = git(repo, 'rev-parse', 'HEAD');
  const r = spawnSync(process.execPath, [LIB, 'run', 'lane-1', 'docs/plan.md', '--tip', head], { cwd: repo, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1);
  const lines = fs.readFileSync(path.join(repo, '.git', 'drb-ship', `${head}.log`), 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(1).join(' '));
  assert.deepEqual(lines, [`start ship of lane-1 at ${s7(head)}, plan docs/plan.md, in the background`, 'result failed this run holds no ship lock on its descriptor 3; nothing was merged']);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
});

test('a ship nested under a holder of the ship lock (DRB_SHIP_LOCK) runs in the foreground inside that lock, never waiting on it, and leaves the lock with it', (t) => {
  const repo = makeOs(t);
  const { tip } = lane(t, repo, 'lane-n', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-n');
  const holder = path.join(tmpDir(t, 'holder'), 'holder.js');
  fs.writeFileSync(holder, [
    "'use strict';",
    `const FE = require(${JSON.stringify(FLOCK_EXEC)});`,
    "const { spawn, spawnSync } = require('node:child_process');",
    '(async () => {',
    "  await FE.underLock({ lockFile: process.argv[2], guardVar: 'DRB_SHIP_LOCK', waitLine: 'the holder waits' });",
    "  const r = spawnSync('bash', [process.argv[3], 'ship', 'lane-n', 'docs/plan.md'], { cwd: process.argv[4], encoding: 'utf8', timeout: 120000 });",
    "  process.stdout.write(r.stdout || '');",
    "  process.stderr.write(r.stderr || '');",
    '  process.exit(r.status === null ? 99 : r.status);',
    '})();',
    '',
  ].join('\n'));
  const r = spawnSync(process.execPath, [holder, path.join(repo, '.git', 'drb-ship.lock'), SHELL, repo], { encoding: 'utf8', timeout: 150000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const out = r.stdout.split('\n');
  assert.match(out[0], new RegExp(`^ready ${s7(tip)}: shipping in the foreground inside its caller's ship lock, log \\S+; no flip marker`));
  assert.ok(!r.stderr.includes(MC.WAIT_LINE), 'it did not wait on its own holder');
  assert.ok(out.includes('merge-lane ship: lock inside the ship lock its caller holds (DRB_SHIP_LOCK)'));
  assert.match(out.filter(Boolean).at(-1), /^merge-lane ship: result cue-only /);
  assert.match(git(repo, 'log', '-1', '--format=%s'), /^merge\(lane lane-n\): docs\/plan\.md$/);
});

test('the run\'s two fallbacks are observable: a failed phase manifest write is one phase line in the log, once, before the result line; a cleanup line the log cannot take goes to stderr', (t) => {
  const dir = tmpDir(t, 'ship-log');
  const log = path.join(dir, 'tip.log');
  const ship = new MS.Ship({ cwd: dir, branch: 'lane-1', log, foreground: false, out: () => {} });
  let writes = 0;
  ship.phase = { write: () => { writes += 1; throw new Error('the disk is full'); } };
  ship.say('check', 'ready');
  ship.say('commit', 'the squash');
  ship.end('refused', 'a test ending');
  const said = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(1).join(' '));
  assert.deepEqual(said, ['check ready', 'phase phase manifest write failed (the disk is full); the log is the record', 'commit the squash', 'result refused a test ending']);
  assert.equal(writes, 3, 'every write is still tried; only the first failure is logged');
  // A log that cannot be written (its path is a directory).
  const broken = new MS.Ship({ cwd: dir, branch: 'lane-1', log: dir, foreground: false, out: () => {} });
  const err = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };
  let told;
  try {
    told = broken.cleanupFailed('the worktree step', 'the cleanup\'s worktree step', 'git worktree failed');
  } finally {
    process.stderr.write = write;
  }
  assert.equal(told, 'the cleanup\'s worktree step failed (git worktree failed)');
  assert.equal(err.length, 1);
  assert.match(err[0], /^merge-lane ship: cleanup the worktree step failed \(git worktree failed\); the push stands \(the log could not take this line: EISDIR[^\n]*\)\n$/);
});
