'use strict';

// Suite for scripts/merge-lane.sh's check and merged subcommands (plan
// 2026-10-28 step 5, lane merge-check) and the carried-by check reading the
// two docs, beside merge-lane.test.js and merge-lane.docs.test.js, which are
// full. Every case runs the script in a throwaway os repo under the temp dir
// with the lane in a linked worktree; the receipts are real, written through
// the review-receipt CLI (scripts/lib/receiptTestkit.js) into that repo's
// common dir, a tampered field edited in a real receipt.json. Every check run
// asserts one stdout line and that the index file, HEAD and the status are as
// they were. MERGE_LANE_SCRIPT runs the suite against another copy.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every repo and every merge's own temp directory under one directory the suite removes.
const SUITE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-lane-check-suite-'));
process.env.TMPDIR = SUITE_TMP;
process.env.MERGE_LANE_LOCK_WAIT = '2';
test.after(() => fs.rmSync(SUITE_TMP, { recursive: true, force: true }));

const K = require('./lib/receiptTestkit');
const SM = require('./sensitive-match');
const { WAIT_LINE } = require('./lib/mergeCheck');

const SCRIPT = process.env.MERGE_LANE_SCRIPT || path.resolve(__dirname, 'merge-lane.sh');
const FLOCK_EXEC = path.resolve(__dirname, 'lib', 'flockExec.js');
const LISTED = 'server/utils/encryption.js';
// A throwaway os carrying the real sensitive list on main, where check reads it.
function makeOs(t) {
  const repo = K.makeRepo(t);
  commit(repo, 'the sensitive list', { 'scripts/sensitive-paths.txt': fs.readFileSync(path.join(__dirname, 'sensitive-paths.txt'), 'utf8') });
  return repo;
}
const { git, commit, tmpDir, cli, ok } = K;

function lane(t, repo, branch, files) {
  const wt = path.join(tmpDir(t, 'wt'), branch);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  return { wt, tip: commit(wt, `${branch} work`, files) };
}

let selects = 0;
function review(t, repo, branch, tier = 'B') {
  ok(cli(repo, 'init', '--branch', branch));
  const base = git(repo, 'merge-base', 'main', branch);
  const files = git(repo, 'diff', '--name-only', base, branch).split('\n').filter((f) => f && f !== 'README.md' && f !== 'ARCHITECTURE.md');
  K.prepare(t, repo, branch, files, { tier });
  const select = path.join(repo, '.git', `select-mlc-${++selects}.json`);
  fs.writeFileSync(select, JSON.stringify({ tier, tiers_by_file: SM.tierFromGit({ base, tip: branch }, { cwd: repo }).tiersByFile }));
  return /dir: (\S+)/.exec(ok(cli(repo, 'finalize', branch, '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', tier, '--select', select, '--not-a-fix', 'a test lane')).stdout)[1];
}

function edit(dir, fn) {
  const file = path.join(dir, 'receipt.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(rec);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
}

function state(repo) {
  const index = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, '.git', 'index'))).digest('hex');
  return { index, head: git(repo, 'rev-parse', 'HEAD'), status: git(repo, '--no-optional-locks', 'status', '--porcelain') };
}

function script(repo, args, opts = {}) {
  const r = spawnSync('bash', [SCRIPT, ...args], { cwd: repo, encoding: 'utf8', timeout: 60000, ...opts });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// merge-lane.sh check <branch>: one stdout line, and nothing changed.
function check(repo, branch, opts) {
  const before = state(repo);
  const r = script(repo, ['check', branch], opts);
  assert.deepEqual(state(repo), before, `check ${branch} changed nothing`);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `one stdout line: ${r.stdout}${r.stderr}`);
  return { ...r, line: lines[0] };
}

function expect(r, code, re) {
  assert.match(r.line, re);
  assert.equal(r.code, code, `${r.line}\n${r.stderr}`);
}

test('check: ready, then ready-moved, then stale with the overlap list, exit 0, 0 and 1', (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-1', { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' });
  review(t, repo, 'lane-1');
  const ready = check(repo, 'lane-1');
  expect(ready, 0, /^ready$/);
  assert.match(ready.stderr, /^check: receipt [0-9a-f]{7} \(by key, tier B\), reviewed against [0-9a-f]{7}, main [0-9a-f]{7}$/m);
  commit(repo, 'main moves', { 'docs/notes.md': 'notes\n' });
  expect(check(repo, 'lane-1'), 0, /^ready-moved$/);
  commit(repo, 'main moves onto the lane', { 'server/b.js': 'b from main\n', 'server/a.js': 'a from main\n' });
  expect(check(repo, 'lane-1'), 1, /^stale server\/a\.js, server\/b\.js$/);
});

test('check: stale with the sensitive flag when a sensitive-listed path landed on main', (t) => {
  assert.ok(SM.isSensitive([LISTED]), `${LISTED} is on the real sensitive list`);
  const repo = makeOs(t);
  lane(t, repo, 'lane-2', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-2');
  commit(repo, 'main moves', { [LISTED]: '// a stand-in\n' });
  const r = check(repo, 'lane-2');
  expect(r, 1, /^stale \(no overlap\) sensitive$/);
  assert.match(r.stderr, /sensitive-listed on main since: server\/utils\/encryption\.js/);
});

test('check refuses: no receipt, a lower tier, a short file list, a recorded tip behind the branch tip', (t) => {
  const repo = makeOs(t);
  const { wt, tip } = lane(t, repo, 'lane-3', { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' });
  expect(check(repo, 'lane-3'), 1, /^refused no review receipt for lane-3: none under its lane key [0-9a-f]{7}/);
  const dir = review(t, repo, 'lane-3');
  edit(dir, (rec) => { rec.tier = 'C'; });
  expect(check(repo, 'lane-3'), 1, /^refused the lane computes to tier B with main's sensitive list; the receipt [0-9a-f]{7} is tier C$/);
  edit(dir, (rec) => { rec.tier = 'B'; rec.coverage.files_in_diff = ['server/b.js']; });
  expect(check(repo, 'lane-3'), 1, /^refused the receipt [0-9a-f]{7}'s file list is short: server\/a\.js is not in it$/);
  edit(dir, (rec) => { rec.coverage.files_in_diff = ['server/a.js', 'server/b.js']; });
  expect(check(repo, 'lane-3'), 0, /^ready$/);
  commit(wt, 'after the review', { 'server/c.js': 'c\n' });
  expect(check(repo, 'lane-3'), 1, new RegExp(`^refused the 1 lane commit\\(s\\) since the recorded tip ${tip.slice(0, 7)} need review at tier B: the receipt [0-9a-f]{7}, found by branch, records tip ${tip.slice(0, 7)} \\(spec 3\\.8\\)$`));
});

test('check and the dirty tree: a staged change refuses; an unstaged edit outside the lane paths is allowed, inside refused', (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-4', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-4');
  fs.writeFileSync(path.join(repo, 'server/b.js'), 'b edited in os\n');
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'untracked, mine\n');
  expect(check(repo, 'lane-4'), 0, /^ready$/);
  git(repo, 'add', '--', 'notes.txt');
  expect(check(repo, 'lane-4'), 1, /^refused os has a staged change \(notes\.txt\); a staged path would ride into the squash: commit or unstage it first$/);
  git(repo, 'restore', '--staged', '--', 'notes.txt');
  fs.writeFileSync(path.join(repo, 'server/a.js'), 'a edited in os\n');
  expect(check(repo, 'lane-4'), 1, /^refused os has an unstaged edit or an untracked file at a path the lane changes or a generated doc \(server\/a\.js\)/);
});

test('merged: the three checks, failing on an unmerged lane and passing once it is squash-merged and its worktree removed', (t) => {
  const repo = makeOs(t);
  const { wt } = lane(t, repo, 'lane-5', { 'server/a.js': 'a v2\n' });
  const before = script(repo, ['merged', 'lane-5']);
  assert.equal(before.code, 1);
  assert.deepEqual(before.stdout.split('\n').filter(Boolean).map((l) => l.split(' ')[0]), ['fail', 'fail', 'fail']);
  // The squash through the script itself (the positional form, unchanged).
  const merge = script(repo, ['lane-5', 'docs/plan.md']);
  assert.equal(merge.code, 0, merge.stderr);
  const kept = script(repo, ['merged', 'lane-5']);
  assert.equal(kept.code, 1);
  assert.match(kept.stdout, /^pass squash on main: [0-9a-f]{7} merge\(lane lane-5\): docs\/plan\.md\npass lane files on main: all 1 byte-identical \(README\.md and ARCHITECTURE\.md compared outside their generated sections\)\nfail worktree: lane-5 is still checked out at /);
  git(repo, 'worktree', 'remove', wt);
  const done = script(repo, ['merged', 'lane-5']);
  assert.equal(done.code, 0, done.stdout);
  assert.match(done.stdout, /\npass worktree: gone \(no worktree has lane-5 checked out\)\n$/);
  assert.equal(script(repo, ['check']).code, 2, 'check without a branch is a usage error');
});

// A generated doc: each of its sections between the generator's markers
// holding `body`, hand prose below them ending in `prose`.
const MK = require('./lib/genDocs/markers');
const doc = (name, body, prose = '') => ['# doc', '', ...MK.DOC_SECTIONS[name].flatMap((s) => [MK.openMarker(s), `${s} ${body}`, MK.closeMarker(s), '']), `prose below${prose}`, ''].join('\n');

test('merged compares the two docs outside their generated sections: a post-squash prose commit names the doc and exits 1, a section-only one passes', (t) => {
  const repo = makeOs(t);
  commit(repo, 'the docs with their markers', { 'README.md': doc('README.md', 'v1'), 'ARCHITECTURE.md': doc('ARCHITECTURE.md', 'v1') });
  const { wt } = lane(t, repo, 'lane-11', { 'server/a.js': 'a v2\n' });
  assert.equal(script(repo, ['lane-11', 'docs/plan.md']).code, 0, 'the squash');
  git(repo, 'worktree', 'remove', wt);
  // A commit on the merged lane's branch, through a worktree removed after it.
  const onBranch = (files) => {
    const w = path.join(tmpDir(t, 'wt-later'), 'lane-11');
    git(repo, 'worktree', 'add', '-q', w, 'lane-11');
    commit(w, 'after the squash', files);
    git(repo, 'worktree', 'remove', w);
  };
  for (const name of ['ARCHITECTURE.md', 'README.md']) {
    onBranch({ [name]: doc(name, 'v2') });
    const sections = script(repo, ['merged', 'lane-11']);
    assert.equal(sections.code, 0, `${name}, its sections only: ${sections.stdout}`);
    onBranch({ [name]: doc(name, 'v2', ', hand prose') });
    const prose = script(repo, ['merged', 'lane-11']);
    assert.equal(prose.code, 1, prose.stdout);
    assert.match(prose.stdout, new RegExp(`^fail lane files on main: ${name.replace('.', '\\.')} differs from the branch outside its generated sections$`, 'm'));
    onBranch({ [name]: doc(name, 'v2') });
    assert.equal(script(repo, ['merged', 'lane-11']).code, 0, `${name}, the prose taken out`);
  }
});

function lockFile(repo) {
  return path.join(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'drb-ship.lock');
}

// The waits are proved by order, never by elapsed time: a holder holds the
// lock until the test writes its go file (the release marker; a bash loop
// that gives up after about 30 seconds, so a failed case leaves nothing
// running), and the waiter must print the wait line and no answer before it.
const untilGo = (go) => `for _ in $(seq 600); do [ -e '${go}' ] && break; sleep 0.05; done`;

// merge-lane.sh in the background: its output so far, and its exit code once it ends.
function background(repo, args, opts = {}) {
  const child = spawn('bash', [SCRIPT, ...args], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  const run = { stdout: '', stderr: '', code: undefined };
  child.stdout.on('data', (d) => { run.stdout += d; });
  child.stderr.on('data', (d) => { run.stderr += d; });
  run.done = new Promise((resolve) => child.on('close', (code) => { run.code = code; resolve(code); }));
  return run;
}

// Resolves once fn() holds, polled every 50 ms; fails after 30 seconds.
async function until(fn, what) {
  for (const end = Date.now() + 30000; !fn(); await new Promise((r) => setTimeout(r, 50))) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
  }
}

// The waiter is waiting on the held lock, has answered nothing, and is still running.
async function waiting(run, what) {
  await until(() => run.stderr.includes(WAIT_LINE), `${what} to wait`);
  assert.equal(run.stdout, '', `${what} answers nothing while the lock is held`);
  assert.equal(run.code, undefined, `${what} is still running`);
}

test('check takes the ship lock: it waits behind a holder, and a run nested under one (DRB_SHIP_LOCK) runs inside its lock', async (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-6', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-6');
  const lock = lockFile(repo);
  const go = path.join(tmpDir(t, 'go'), 'go');
  const holder = spawn('flock', [lock, 'bash', '-c', untilGo(go)], { stdio: 'ignore' });
  const exited = new Promise((resolve) => holder.on('exit', resolve));
  try {
    assert.ok(held(lock), 'the holder holds the ship lock');
    const before = state(repo);
    const waiter = background(repo, ['check', 'lane-6']);
    await waiting(waiter, 'check');
    fs.writeFileSync(go, '');
    assert.equal(await waiter.done, 0, waiter.stderr);
    assert.equal(waiter.stdout, 'ready\n', 'the answer came after the holder released');
    assert.deepEqual(state(repo), before, 'the waiting check changed nothing');
  } finally {
    fs.writeFileSync(go, '');
    await exited;
  }
  // A holder that took the lock through flockExec, as ship does, running check inside it.
  const nest = path.join(tmpDir(t, 'nest'), 'holder.js');
  fs.writeFileSync(nest, [
    "'use strict';",
    `const FE = require(${JSON.stringify(FLOCK_EXEC)});`,
    "const { spawnSync } = require('node:child_process');",
    '(async () => {',
    "  await FE.underLock({ lockFile: process.argv[2], guardVar: 'DRB_SHIP_LOCK', waitLine: 'the holder waits' });",
    "  const r = spawnSync('bash', [process.argv[3], 'check', process.argv[4]], { cwd: process.argv[5], encoding: 'utf8', timeout: 15000 });",
    '  process.stdout.write(r.stdout || \'\');',
    '  process.stderr.write(r.stderr || \'\');',
    '  process.exit(r.status === null ? 99 : r.status);',
    '})();',
    '',
  ].join('\n'));
  const nested = spawnSync(process.execPath, [nest, lock, SCRIPT, 'lane-6', repo], { encoding: 'utf8', timeout: 30000 });
  assert.equal(nested.status, 0, `the nested check ran inside the holder's lock: ${nested.stdout}${nested.stderr}`);
  assert.equal(nested.stdout, 'ready\n');
  assert.ok(!nested.stderr.includes(WAIT_LINE), 'the nested run did not wait on its own holder');
});

test('a prose-only lane carried by another window\'s plain commit during the hook -> the refusal says that commit carries it, never that nothing was merged', (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-7', { 'README.md': 'readme\nlane prose\n' });
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, ['#!/usr/bin/env bash', '[ -e .git/hook-done ] && exit 0', ': > .git/hook-done', "printf 'w\\n' > w.txt",
    'env -u GIT_INDEX_FILE git add -- w.txt', "env -u GIT_INDEX_FILE git commit -q -m 'another window'", ''].join('\n'));
  fs.chmodSync(hook, 0o755);
  const head = git(repo, 'rev-parse', 'HEAD');
  const r = script(repo, ['lane-7', 'docs/plan.md', 'seven']);
  assert.notEqual(r.code, 0, 'the merge refuses');
  assert.doesNotMatch(r.stderr, /merge-lane[^:\n]*: line \d+: /, 'no shell error');
  assert.match(r.stderr, /REFUSED: main moved under the merge: [0-9a-f]+ another window from another window already carries every path of the squash/);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /nothing of the lane is on main|Nothing was merged|Nothing of the lane is left/, 'no false line');
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'another window');
  assert.equal(git(repo, 'rev-parse', 'HEAD~1'), head);
  assert.equal(git(repo, 'show', 'HEAD:README.md'), 'readme\nlane prose');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

test('the dispatch: check or merged first is the subcommand at any argument count, and the squash form refuses a lane branch named check', (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-8', { 'server/a.js': 'a v2\n' });
  const head = git(repo, 'rev-parse', 'HEAD');
  for (const args of [['check', 'lane-8', 'extra'], ['merged', 'lane-8', 'extra'], ['check']]) {
    const r = script(repo, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^usage: /m);
  }
  lane(t, repo, 'check', { 'server/b.js': 'b v2\n' });
  const r = script(repo, ['refs/heads/check', 'docs/plan.md']);
  assert.equal(r.code, 1, `${r.stdout}${r.stderr}`);
  assert.deepEqual(r.stderr.split('\n').filter(Boolean), ['REFUSED: a lane branch named check, merged or ship is never squashed (those are this script\'s subcommands); rename it.']);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'nothing was squashed');
  assert.equal(git(repo, 'status', '--porcelain'), '');
});

// A git on PATH that runs the bash lines once, at the first call of the
// subcommand given (a check reaches commit-tree after it read main and the
// status), then goes on; REAL_GIT names the real one.
function gitAt(t, sub, lines) {
  const real = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const dir = tmpDir(t, 'shim');
  fs.writeFileSync(path.join(dir, 'git'), ['#!/usr/bin/env bash', `if [ "$1" = ${sub} ] && [ ! -e '${dir}/done' ]; then`, `  : > '${dir}/done'`,
    ...lines.map((l) => `  { ${l}; } > /dev/null 2>&1`), 'fi', `exec '${real}' "$@"`, ''].join('\n'));
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return { ...process.env, PATH: `${dir}:${process.env.PATH}`, REAL_GIT: real };
}

// Whether something holds the lock within five seconds.
function held(lock) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    if (spawnSync('flock', ['-n', lock, 'true']).status === 1) return true;
    spawnSync('sleep', ['0.05']);
  }
  return false;
}

test('check reads main and the status once more before it answers: a squash or a staging landing during a paused check refuses, never ready', (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-9', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-9');
  const squash = gitAt(t, 'commit-tree', ['"$REAL_GIT" merge --squash -q lane-9', '"$REAL_GIT" commit -q -m "merge(lane lane-9): docs/plan.md"']);
  const r = script(repo, ['check', 'lane-9'], { env: squash });
  assert.equal(git(repo, 'log', '-1', '--format=%s'), 'merge(lane lane-9): docs/plan.md', 'a squash landed during the check');
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^refused main moved during the check \([0-9a-f]{7} to [0-9a-f]{7}\); check again\n$/);
  lane(t, repo, 'lane-10', { 'server/c.js': 'c\n' });
  review(t, repo, 'lane-10');
  const staging = gitAt(t, 'commit-tree', ['printf "x\\n" > x.txt', '"$REAL_GIT" add -- x.txt']);
  const s = script(repo, ['check', 'lane-10'], { env: staging });
  assert.equal(s.code, 1);
  assert.equal(s.stdout, 'refused os gained a staged change during the check (x.txt); check again\n');
});

test('the squash takes the ship lock: a check started during a squash waits for it, and answers on main as the squash left it', async (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-a1', { 'server/c.js': 'c\n' });
  lane(t, repo, 'lane-b1', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-b1');
  const go = path.join(tmpDir(t, 'go'), 'go');
  fs.writeFileSync(path.join(repo, '.git', 'hooks', 'pre-commit'), `#!/usr/bin/env bash\n${untilGo(go)}\n`);
  fs.chmodSync(path.join(repo, '.git', 'hooks', 'pre-commit'), 0o755);
  const squash = background(repo, ['lane-a1', 'docs/plan.md']);
  try {
    assert.ok(held(lockFile(repo)), 'the squash holds the ship lock');
    const r = background(repo, ['check', 'lane-b1']);
    await waiting(r, 'check');
    assert.equal(squash.code, undefined, 'the squash is still in its hook');
    fs.writeFileSync(go, '');
    assert.equal(await r.done, 0, r.stderr);
    assert.equal(r.stdout, 'ready-moved\n', 'answered on main as the squash left it');
    assert.equal(await squash.done, 0, squash.stderr);
  } finally {
    fs.writeFileSync(go, '');
    await squash.done;
  }
});

test('the squash takes the ship lock: a squash started during a check waits for it', async (t) => {
  const repo = makeOs(t);
  lane(t, repo, 'lane-a2', { 'server/a.js': 'a v2\n' });
  lane(t, repo, 'lane-b2', { 'server/c.js': 'c\n' });
  review(t, repo, 'lane-a2');
  const go = path.join(tmpDir(t, 'go'), 'go');
  const head = git(repo, 'rev-parse', 'HEAD');
  const chk = background(repo, ['check', 'lane-a2'], { env: gitAt(t, 'commit-tree', [untilGo(go)]) });
  try {
    assert.ok(held(lockFile(repo)), 'check holds the ship lock');
    const m = background(repo, ['lane-b2', 'docs/plan.md']);
    await waiting(m, 'the squash');
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head, 'nothing squashed while the check holds the lock');
    fs.writeFileSync(go, '');
    assert.equal(await chk.done, 0, chk.stderr);
    assert.equal(chk.stdout, 'ready\n', 'main did not move under the check');
    assert.equal(await m.done, 0, m.stderr);
    assert.match(git(repo, 'log', '-1', '--format=%s'), /^merge\(lane lane-b2\): docs\/plan\.md$/);
  } finally {
    fs.writeFileSync(go, '');
    await chk.done;
  }
});
