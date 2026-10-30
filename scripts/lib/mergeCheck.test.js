'use strict';

// Tests for scripts/lib/mergeCheck.js (instruction rewrite step 5, lane
// merge-check): checkLane's ready, ready-moved, stale and refused, the dirty
// tree rule of spec 4.6, the receipt lookup and the three merged-lane checks,
// in the library, without the shell (merge-lane.check.test.js runs them
// through merge-lane.sh). Every case builds a throwaway os repo under the temp
// dir with the lane in a linked worktree, and writes real receipts through the
// review-receipt CLI (scripts/lib/receiptTestkit.js) into that repo's common
// dir; a tampered field is edited in a real receipt.json. Nothing here
// touches the real repo, its common dir or the dev database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const K = require('./receiptTestkit');
const M = require('./mergeCheck');
const SQ = require('./mergeShipSquash');
const R = require('./receipt');
const SM = require('../sensitive-match');

const { git, commit, tmpDir, cli, ok } = K;
// A path on the real sensitive list, which the check reads by default.
const LISTED = 'server/utils/encryption.js';

// A throwaway os: main checked out in the repo, seeded by the testkit, with
// the real sensitive list committed where check reads it, on main.
const LIST = path.join(__dirname, '..', 'sensitive-paths.txt');
function osRepo(t) {
  const repo = K.makeRepo(t);
  commit(repo, 'the sensitive list', { 'scripts/sensitive-paths.txt': fs.readFileSync(LIST, 'utf8') });
  return repo;
}

// A lane branch in its own worktree, one commit past main.
function lane(t, repo, branch, files) {
  const wt = path.join(tmpDir(t, 'wt'), branch);
  git(repo, 'worktree', 'add', '-q', '-b', branch, wt, 'main');
  const tip = commit(wt, `${branch} work`, files);
  return { wt, tip, base: git(repo, 'merge-base', 'main', branch) };
}

// A real lane receipt at `tier`: init, a passing report from each floor lens,
// the runs the tier needs, finalize. Returns the receipt directory.
let selects = 0;
function review(t, repo, branch, { tier = 'B', more = () => {} } = {}) {
  ok(cli(repo, 'init', '--branch', branch));
  const base = git(repo, 'merge-base', 'main', branch);
  const files = git(repo, 'diff', '--name-only', base, branch).split('\n').filter((f) => f && !R.GENERATED_DOCS.includes(f));
  more(K.prepare(t, repo, branch, files, { tier }).at);
  const select = path.join(repo, '.git', `select-mc-${++selects}.json`);
  fs.writeFileSync(select, JSON.stringify({ tier, tiers_by_file: SM.tierFromGit({ base, tip: branch }, { cwd: repo }).tiersByFile }));
  const r = ok(cli(repo, 'finalize', branch, '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', tier, '--select', select, '--not-a-fix', 'a test lane'));
  return /dir: (\S+)/.exec(r.stdout)[1];
}

function edit(dir, fn) {
  const file = path.join(dir, 'receipt.json');
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(rec);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
}

function onMain(repo, files, message = 'main moves') {
  return commit(repo, message, files);
}

const check = (repo, branch, extra = {}) => M.checkLane({ cwd: repo, branch, ...extra });

// What check must leave as it found it: the index file's bytes, HEAD and the status.
function snapshot(repo) {
  const index = crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, '.git', 'index'))).digest('hex');
  return { index, head: git(repo, 'rev-parse', 'HEAD'), status: git(repo, '--no-optional-locks', 'status', '--porcelain') };
}

function refusedWith(r, re) {
  assert.equal(r.state, 'refused', `expected a refusal, got ${M.line(r)}`);
  assert.equal(r.exitCode, 1);
  assert.match(M.line(r), re);
}

test('ready: a lane reviewed on main as it stands, its test counts read from the runner logs', (t) => {
  const repo = osRepo(t);
  const { tip, base } = lane(t, repo, 'lane-r', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-r');
  const r = check(repo, 'lane-r', { plan: 'docs/plan.md' });
  assert.equal(M.line(r), 'ready');
  assert.equal(r.exitCode, 0);
  assert.equal(r.via, 'key');
  assert.equal(r.key, R.laneKey(base, tip, { cwd: repo }));
  assert.equal(r.tier, 'B');
  assert.equal(r.plan, 'docs/plan.md');
  assert.deepEqual(r.tests, [{ type: 'suites', file: 'server/a.test.js', found: true, pass: 4, fail: 0 }]);
  assert.deepEqual(r.suites, ['server/a.test.js']);
  const out = [];
  const err = [];
  M.report(r, { out: (s) => out.push(s), err: (s) => err.push(s) });
  assert.deepEqual(out, ['ready\n']);
  assert.match(err.join(''), /^check: receipt [0-9a-f]{7} \(by key, tier B\), reviewed against [0-9a-f]{7}, main [0-9a-f]{7}\n$/);
});

test('ready-moved and stale: main moving past the files the lane touches (a generated doc both changed among them), then onto one', (t) => {
  const repo = osRepo(t);
  lane(t, repo, 'lane-m', { 'server/a.js': 'a v2\n', 'README.md': 'readme\nlane prose\n' });
  review(t, repo, 'lane-m');
  onMain(repo, { 'docs/notes.md': 'notes\n', 'server/c.js': 'c\n' });
  const moved = check(repo, 'lane-m');
  assert.equal(M.line(moved), 'ready-moved');
  assert.equal(moved.exitCode, 0);
  assert.deepEqual(moved.overlap, []);
  onMain(repo, { 'README.md': 'readme from main\n' });
  assert.equal(M.line(check(repo, 'lane-m')), 'ready-moved', 'a generated doc is never overlap');
  onMain(repo, { 'server/a.js': 'a from main\n' });
  const stale = check(repo, 'lane-m');
  assert.equal(M.line(stale), 'stale server/a.js');
  assert.equal(stale.exitCode, 1);
  assert.deepEqual(stale.overlap, ['server/a.js']);
  assert.equal(stale.sensitive, false);
});

test('stale with the sensitive flag: a sensitive-listed path landed on main, overlap or none', (t) => {
  assert.ok(SM.isSensitive([LISTED]), `${LISTED} is on the real sensitive list`);
  const repo = osRepo(t);
  lane(t, repo, 'lane-s', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-s');
  onMain(repo, { [LISTED]: '// a stand-in\n' });
  const r = check(repo, 'lane-s');
  assert.equal(M.line(r), 'stale (no overlap) sensitive');
  assert.deepEqual(r.sensitivePaths, [LISTED]);
  onMain(repo, { 'server/a.js': 'a from main\n' });
  assert.equal(M.line(check(repo, 'lane-s')), 'stale server/a.js sensitive');
});

test('a content-identical rebase keeps the key: found by key, the old tip no ancestor, ready-moved', (t) => {
  const repo = osRepo(t);
  const { wt, tip } = lane(t, repo, 'lane-cr', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-cr');
  onMain(repo, { 'docs/notes.md': 'notes\n' });
  const rebased = K.rebase(wt, 'main');
  assert.notEqual(rebased, tip);
  const r = check(repo, 'lane-cr');
  assert.equal(r.via, 'key');
  assert.equal(M.line(r), 'ready-moved');
});

test('refused: no receipt, by name, and nothing started', (t) => {
  const repo = osRepo(t);
  lane(t, repo, 'lane-n', { 'server/a.js': 'a v2\n' });
  const r = check(repo, 'lane-n');
  refusedWith(r, /^refused no review receipt for lane-n: none under its lane key [0-9a-f]{7} and none the index maps to it; run the review on the lane$/);
  assert.ok(!fs.existsSync(path.join(repo, '.git', 'drb-review', '_work', 'lane-n')), 'no review was opened');
});

test('refused: a receipt whose tier is below the one main\'s sensitive list computes', (t) => {
  const repo = osRepo(t);
  lane(t, repo, 'lane-t', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-t');
  assert.equal(M.line(check(repo, 'lane-t')), 'ready');
  // A later edit of the list on main that lists the lane's file.
  onMain(repo, { 'scripts/sensitive-paths.txt': `${fs.readFileSync(LIST, 'utf8')}server/a.js\n` });
  refusedWith(check(repo, 'lane-t'), /^refused the lane computes to tier A with main's sensitive list; the receipt [0-9a-f]{7} is tier B$/);
});

// check's own modules, copied into the throwaway os (untracked, excluded), so
// the list beside them on disk, the one the push gate's judge reads, is os's
// copy: the loaded copy of mergeCheck.js.
function ownModules(repo) {
  for (const sub of ['', 'genDocs']) {
    const from = path.join(__dirname, sub);
    const to = path.join(repo, 'scripts', 'lib', sub);
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) if (f.endsWith('.js') && !f.endsWith('.test.js')) fs.copyFileSync(path.join(from, f), path.join(to, f));
  }
  fs.copyFileSync(path.join(__dirname, '..', 'sensitive-match.js'), path.join(repo, 'scripts', 'sensitive-match.js'));
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/scripts/lib/\n/scripts/sensitive-match.js\n');
  return require(path.join(repo, 'scripts', 'lib', 'mergeCheck.js'));
}

test('the sensitive list is main\'s: an unstaged edit of os\'s copy that would lower the tier leaves the verdict as main\'s list gives it', (t) => {
  const repo = osRepo(t);
  const C = ownModules(repo);
  lane(t, repo, 'lane-l', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-l');
  const list = path.join(repo, 'scripts', 'sensitive-paths.txt');
  const before = fs.readFileSync(list, 'utf8');
  onMain(repo, { 'scripts/sensitive-paths.txt': `${before}server/a.js\n` });
  fs.writeFileSync(list, before);
  assert.match(git(repo, '--no-optional-locks', 'status', '--porcelain'), /^M scripts\/sensitive-paths\.txt$/m, 'another window edits os\'s copy');
  refusedWith(C.checkLane({ cwd: repo, branch: 'lane-l' }), /^refused the lane computes to tier A with main's sensitive list; the receipt [0-9a-f]{7} is tier B$/);
});

test('the push gate\'s judge reads the list on disk, so an unstaged edit of os\'s copy that drops a lane file\'s pattern refuses before it, never ready', (t) => {
  const repo = osRepo(t);
  const C = ownModules(repo);
  lane(t, repo, 'lane-j', { [LISTED]: '// a stand-in\n' });
  const dir = review(t, repo, 'lane-j', { tier: 'A' });
  // The receipt lacks a report the tier A floor needs and a lighter floor does not: money's.
  edit(dir, (rec) => { rec.reports = rec.reports.filter((e) => e.lens !== 'money'); });
  const list = path.join(repo, 'scripts', 'sensitive-paths.txt');
  const mains = fs.readFileSync(list, 'utf8');
  assert.equal(mains.split('\n').filter((l) => l === LISTED).length, 1);
  fs.writeFileSync(list, mains.split('\n').filter((l) => l !== LISTED).join('\n'));
  assert.ok(!SM.tierFromGit({ base: 'main', tip: 'lane-j' }, { cwd: repo, listFile: list }).floors.includes('money'), 'the disk copy drops the money floor');
  refusedWith(C.checkLane({ cwd: repo, branch: 'lane-j' }), /^refused the sensitive list on disk differs from main's; commit or restore it before the check$/);
  fs.writeFileSync(list, mains);
  refusedWith(C.checkLane({ cwd: repo, branch: 'lane-j' }), /^refused the receipt [0-9a-f]{7}: no money report; the tier floor needs one$/);
  // The same edit landing during the check, after the first comparison and before the judge reads the list.
  const during = `grep -vxF '${LISTED}' '${list}' > '${list}.new'; mv '${list}.new' '${list}'`;
  refusedWith(withGitAt(t, 'commit-tree', during, () => C.checkLane({ cwd: repo, branch: 'lane-j' })), /^refused the sensitive list on disk differs from main's; commit or restore it before the check$/);
});

test('refused: a short file list, by name, from the receipt and from its verdict tables', (t) => {
  const repo = osRepo(t);
  lane(t, repo, 'lane-f', { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' });
  const dir = review(t, repo, 'lane-f');
  edit(dir, (rec) => { rec.coverage.files_in_diff = ['server/a.js']; });
  refusedWith(check(repo, 'lane-f'), /^refused the receipt [0-9a-f]{7}'s file list is short: server\/b\.js is not in it$/);
  edit(dir, (rec) => { rec.coverage.files_in_diff = ['server/a.js', 'server/b.js']; });
  fs.writeFileSync(path.join(dir, 'seams.md'), K.report([['server/a.js', 'pass']]));
  refusedWith(check(repo, 'lane-f'), /^refused the receipt [0-9a-f]{7}: seams has no verdict for server\/b\.js$/);
});

test('refused: a recorded tip behind the branch tip names the lane commits since it and their tier, found by branch; a change and its revert passes by key', (t) => {
  const repo = osRepo(t);
  const { wt, tip } = lane(t, repo, 'lane-p', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-p');
  commit(wt, 'after the review', { 'server/b.js': 'b v2\n' });
  const r = check(repo, 'lane-p');
  assert.equal(r.via, 'branch');
  refusedWith(r, sinceTip(tip, 1, 'B', ', found by branch,', `records tip ${tip.slice(0, 7)} \\(spec 3\\.8\\)$`));
  assert.deepEqual(r.unreviewed, { count: 1, since: tip, from: tip, tier: 'B' });
  // A commit and its revert after the review: the diff is byte for byte the reviewed one.
  commit(wt, 'revert it', { 'server/b.js': 'b v1\n' });
  const k = check(repo, 'lane-p');
  assert.equal(k.via, 'key');
  assert.equal(M.line(k), 'ready');
  // Then a commit to a listed path: the three lane commits since the recorded tip, at their own tier.
  commit(wt, 'a listed path', { [LISTED]: '// a stand-in\n' });
  refusedWith(check(repo, 'lane-p'), sinceTip(tip, 3, 'A', ', found by branch,', `records tip ${tip.slice(0, 7)} \\(spec 3\\.8\\)$`));
});

// The recorded-tip refusal: the lane's own commits since the recorded tip
// (n of them, at `tier`), then why; n 0 is a tip moved back behind it.
function sinceTip(from, n, tier, how, rest) {
  const f = from.slice(0, 7);
  const head = n ? `the ${n} lane commit\\(s\\) since the recorded tip ${f} need review at tier ${tier}`
    : `the lane's tip [0-9a-f]{7} is behind the recorded tip ${f}, with no lane commit since it; the change back needs review at tier ${tier}`;
  return new RegExp(`^refused ${head}: the receipt [0-9a-f]{7}${how} ${rest}`);
}
const notReviewed = (from, to, n) => sinceTip(from, n, 'B', '', `records tip ${from.slice(0, 7)}, and the lane's diff to ${to.slice(0, 7)} is not byte for byte the one it reviewed`);

test('the recorded tip, whitespace exact: an amend, a reset back, a commit then a rebase, each a whitespace change the lane key cannot see', (t) => {
  const repo = osRepo(t);
  const { wt } = lane(t, repo, 'lane-w', { 'server/run.sh': 'echo start\nX  =  1\n' });
  const before = commit(wt, 'the assignment', { 'server/run.sh': 'echo start\nX=1\n' });
  review(t, repo, 'lane-w');
  assert.equal(M.line(check(repo, 'lane-w')), 'ready');
  fs.writeFileSync(path.join(wt, 'server/run.sh'), 'echo start\nX = 1\n');
  git(wt, 'commit', '-q', '-a', '--amend', '--no-edit');
  const amended = check(repo, 'lane-w');
  assert.equal(amended.via, 'key', 'the lane key strips whitespace');
  refusedWith(amended, notReviewed(before, git(wt, 'rev-parse', 'HEAD'), 1));
  git(wt, 'reset', '-q', '--hard', before);
  assert.equal(M.line(check(repo, 'lane-w')), 'ready');
  git(wt, 'reset', '-q', '--hard', 'HEAD~1');
  refusedWith(check(repo, 'lane-w'), notReviewed(before, git(wt, 'rev-parse', 'HEAD'), 0));
  git(wt, 'reset', '-q', '--hard', before);
  commit(wt, 'spacing', { 'server/run.sh': 'echo start\nX = 1\n' });
  onMain(repo, { 'docs/notes.md': 'notes\n' });
  const rebased = K.rebase(wt, 'main');
  // The plain range <recorded tip>..<tip> holds main's commit too; the lane's own are its three, all new.
  assert.equal(git(repo, 'rev-list', '--count', `${before}..${rebased}`), '4');
  refusedWith(check(repo, 'lane-w'), notReviewed(before, rebased, 3));
});

test('the recorded tip: a change and its revert after a rebase passes; a removed or garbage tip, or a base that names no commit, refuses', (t) => {
  const repo = osRepo(t);
  const { wt, tip } = lane(t, repo, 'lane-v', { 'server/a.js': 'a v2\n' });
  const dir = review(t, repo, 'lane-v');
  commit(wt, 'a change', { 'server/b.js': 'b v2\n' });
  commit(wt, 'its revert', { 'server/b.js': 'b v1\n' });
  onMain(repo, { 'docs/notes.md': 'notes\n' });
  K.rebase(wt, 'main');
  assert.equal(M.line(check(repo, 'lane-v')), 'ready-moved');
  edit(dir, (rec) => { delete rec.tip; });
  refusedWith(check(repo, 'lane-v'), /^refused the receipt [0-9a-f]{7}'s tip is missing or names no commit$/);
  edit(dir, (rec) => { rec.tip = 'not a sha'; });
  refusedWith(check(repo, 'lane-v'), /^refused the receipt [0-9a-f]{7}'s tip is missing or names no commit$/);
  edit(dir, (rec) => { rec.tip = 'e'.repeat(40); });
  refusedWith(check(repo, 'lane-v'), /^refused the receipt [0-9a-f]{7}'s tip is missing or names no commit$/);
  edit(dir, (rec) => { rec.tip = tip; rec.base = 'e'.repeat(40); });
  refusedWith(check(repo, 'lane-v'), /^refused the receipt [0-9a-f]{7}'s base is missing or names no commit$/);
});

test('refused: a tampered receipt (not final, another kind, reviewed against a commit off main)', (t) => {
  const repo = osRepo(t);
  const { tip } = lane(t, repo, 'lane-x', { 'server/a.js': 'a v2\n' });
  const dir = review(t, repo, 'lane-x');
  edit(dir, (rec) => { rec.state = 'open'; });
  refusedWith(check(repo, 'lane-x'), /^refused the receipt [0-9a-f]{7} is not final$/);
  edit(dir, (rec) => { rec.state = 'final'; rec.kind = 'quick-fix'; });
  refusedWith(check(repo, 'lane-x'), /is of kind quick-fix; a lane takes lane or comment-only$/);
  edit(dir, (rec) => { rec.kind = 'lane'; rec.reviewed_against = tip; });
  refusedWith(check(repo, 'lane-x'), new RegExp(`was reviewed against ${tip.slice(0, 7)}, which is not on main`));
});

test('ready at tier A: the deep check reads the smoke, verify and the externals from a real tier A receipt', (t) => {
  const repo = osRepo(t);
  lane(t, repo, 'lane-a', { [LISTED]: '// a stand-in\n' });
  review(t, repo, 'lane-a', { tier: 'A' });
  const r = check(repo, 'lane-a');
  assert.equal(M.line(r), 'ready');
  assert.equal(r.smoke, true);
  assert.deepEqual(r.tests.filter((x) => x.type === 'smoke').map((x) => [x.file, x.pass]), [['server/m1.test.js', 10], ['server/m2.test.js', 5]]);
});

test('the dirty tree (spec 4.6): any staged change refuses; an unstaged edit or untracked file only at a lane path or a doc', (t) => {
  const repo = osRepo(t);
  lane(t, repo, 'lane-d', { 'server/a.js': 'a v2\n', 'server/new.js': 'new\n' });
  review(t, repo, 'lane-d');
  const put = (rel, body) => fs.writeFileSync(path.join(repo, rel), body);
  put('server/b.js', 'b edited in os\n');
  put('scratch.txt', 'mine\n');
  assert.equal(M.line(check(repo, 'lane-d')), 'ready', 'outside the lane paths: allowed');
  git(repo, 'add', '--', 'scratch.txt');
  refusedWith(check(repo, 'lane-d'), /^refused os has a staged change \(scratch\.txt\); a staged path would ride into the squash/);
  git(repo, 'restore', '--staged', '--', 'scratch.txt');
  for (const [rel, body] of [['server/a.js', 'a edited in os\n'], ['server/new.js', 'untracked here\n'], ['README.md', 'readme edited\n']]) {
    const before = fs.existsSync(path.join(repo, rel)) ? fs.readFileSync(path.join(repo, rel)) : null;
    put(rel, body);
    refusedWith(check(repo, 'lane-d'), new RegExp(`^refused os has an unstaged edit or an untracked file at a path the lane changes or a generated doc \\(${rel.replace(/[./]/g, '\\$&')}\\)`));
    if (before === null) fs.rmSync(path.join(repo, rel));
    else fs.writeFileSync(path.join(repo, rel), before);
  }
  assert.equal(M.line(check(repo, 'lane-d')), 'ready');
});

test('check changes nothing: the index file, HEAD and the status, a stat-dirty entry included', (t) => {
  const repo = osRepo(t);
  lane(t, repo, 'lane-z', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-z');
  // Same content, an older mtime: a refreshing git status would rewrite the index.
  const old = new Date(Date.now() - 3600e3);
  fs.utimesSync(path.join(repo, 'server/b.js'), old, old);
  for (const branch of ['lane-z', 'lane-none']) {
    const before = snapshot(repo);
    check(repo, branch);
    assert.deepEqual(snapshot(repo), before, branch);
  }
  M.mergedLane({ cwd: repo, branch: 'lane-z' });
  const before = snapshot(repo);
  git(repo, 'status', '--porcelain');
  assert.notEqual(snapshot(repo).index, before.index, 'a plain git status does rewrite it, so the case can fail');
});

test('refused: not the primary worktree on main, a branch at main, a lane of the generated docs alone', (t) => {
  const repo = osRepo(t);
  const { wt } = lane(t, repo, 'lane-o', { 'server/a.js': 'a v2\n' });
  refusedWith(check(wt, 'lane-o'), /^refused check runs only from the primary \(os\) worktree, not /);
  git(repo, 'branch', 'lane-at-main', 'main');
  refusedWith(check(repo, 'lane-at-main'), /^refused nothing to merge: lane-at-main has no change past main$/);
  lane(t, repo, 'lane-docs', { 'README.md': 'readme, lane prose\n' });
  refusedWith(check(repo, 'lane-docs'), /^refused nothing a receipt keys: lane-docs changes only README\.md and ARCHITECTURE\.md/);
  refusedWith(check(repo, 'no-such-lane'), /^refused no branch no-such-lane$/);
  git(repo, 'checkout', '-q', '--detach');
  refusedWith(check(repo, 'lane-o'), /^refused os must be on main to check a lane \(HEAD is \(detached\)\)$/);
});

test('findReceipt: by the lane key, then by branch through the index', (t) => {
  const repo = osRepo(t);
  const { base, tip } = lane(t, repo, 'lane-k', { 'server/a.js': 'a v2\n' });
  const dir = review(t, repo, 'lane-k');
  const key = R.laneKey(base, tip, { cwd: repo });
  const byKey = M.findReceipt({ cwd: repo, key, branch: 'lane-k' });
  assert.equal(byKey.via, 'key');
  assert.equal(byKey.dir, dir);
  const byBranch = M.findReceipt({ cwd: repo, key: 'f'.repeat(40), branch: 'lane-k' });
  assert.equal(byBranch.via, 'branch');
  assert.equal(byBranch.key, key);
  assert.equal(byBranch.rec.tip, tip);
  assert.equal(M.findReceipt({ cwd: repo, key: 'f'.repeat(40), branch: 'other' }), null);
});

// A generated doc as the generator lays it out: each of its sections between
// the markers, holding `body`, and hand prose below them ending in `prose`.
const MK = require('./genDocs/markers');
function doc(name, { body = 'v1', prose = '' } = {}) {
  return ['# doc', '', ...MK.DOC_SECTIONS[name].flatMap((s) => [MK.openMarker(s), `${s} ${body}`, MK.closeMarker(s), '']), `prose below${prose}`, ''].join('\n');
}

test('mergedLane: the three checks pass on a squash-merged lane whose worktree is gone, and each fails alone', (t) => {
  const repo = osRepo(t);
  onMain(repo, { 'README.md': doc('README.md') }, 'the docs with their markers');
  const { wt } = lane(t, repo, 'lane-g', { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n', 'README.md': doc('README.md', { prose: ', lane prose' }) });
  const before = M.mergedLane({ cwd: repo, branch: 'lane-g' });
  assert.equal(before.ok, false);
  assert.deepEqual(before.checks.map((c) => c.ok), [false, false, false]);
  assert.match(before.checks[0].text, /^squash on main: no commit on main has a subject opening merge\(lane lane-g\):$/);
  assert.match(before.checks[1].text, /^lane files on main: server\/a\.js, server\/b\.js differ from the branch; README\.md differs from the branch outside its generated sections$/);
  assert.match(before.checks[2].text, new RegExp(`^worktree: lane-g is still checked out at ${wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
  git(repo, 'merge', '--squash', '-q', 'lane-g');
  git(repo, 'commit', '-q', '-m', 'merge(lane lane-g): docs/plan.md');
  // The sections a merge regenerates differ from the branch and are excluded; the lane's prose is on main.
  onMain(repo, { 'README.md': doc('README.md', { body: 'v2', prose: ', lane prose' }) });
  const kept = M.mergedLane({ cwd: repo, branch: 'lane-g' });
  assert.deepEqual(kept.checks.map((c) => c.ok), [true, true, false]);
  assert.match(kept.checks[0].text, /^squash on main: [0-9a-f]{7} merge\(lane lane-g\): docs\/plan\.md$/);
  assert.equal(kept.checks[1].text, 'lane files on main: all 2 byte-identical (README.md and ARCHITECTURE.md compared outside their generated sections)');
  git(repo, 'worktree', 'remove', wt);
  const done = M.mergedLane({ cwd: repo, branch: 'lane-g' });
  assert.equal(done.ok, true);
  assert.equal(done.checks[2].text, 'worktree: gone (no worktree has lane-g checked out)');
  onMain(repo, { 'server/a.js': 'a, a later lane\n' });
  const moved = M.mergedLane({ cwd: repo, branch: 'lane-g' });
  assert.deepEqual(moved.checks.map((c) => c.ok), [true, false, true]);
  assert.match(moved.checks[1].text, /^lane files on main: server\/a\.js differs from the branch$/);
});

test('mergedLane: the two docs compared outside their generated sections; a post-squash prose commit to either is named, a section-only one passes', (t) => {
  const repo = osRepo(t);
  onMain(repo, { 'README.md': doc('README.md'), 'ARCHITECTURE.md': doc('ARCHITECTURE.md') }, 'the docs with their markers');
  const { wt } = lane(t, repo, 'lane-h', { 'server/a.js': 'a v2\n' });
  git(repo, 'merge', '--squash', '-q', 'lane-h');
  git(repo, 'commit', '-q', '-m', 'merge(lane lane-h): docs/plan.md');
  const files = () => M.mergedLane({ cwd: repo, branch: 'lane-h' }).checks[1];
  assert.equal(files().ok, true);
  for (const name of ['ARCHITECTURE.md', 'README.md']) {
    commit(wt, `${name}, its sections`, { [name]: doc(name, { body: 'v2' }) });
    assert.equal(files().ok, true, `a post-squash commit inside the ${name} sections only`);
    commit(wt, `${name}, prose below the markers`, { [name]: doc(name, { body: 'v2', prose: ', hand prose' }) });
    assert.deepEqual(files(), { name: 'files', ok: false, text: `lane files on main: ${name} differs from the branch outside its generated sections` });
    commit(wt, `${name}, the prose taken out`, { [name]: doc(name, { body: 'v2' }) });
    assert.equal(files().ok, true, `${name}: no prose of the lane's left off main`);
  }
  // main's prose moving in a doc whose prose the lane never changed is not the lane's.
  onMain(repo, { 'ARCHITECTURE.md': doc('ARCHITECTURE.md', { prose: ', a later lane' }) });
  assert.equal(files().ok, true);
  // A doc whose markers the lane broke fails closed.
  commit(wt, 'a broken marker', { 'README.md': doc('README.md', { body: 'v2' }).replace('<!-- /gen:env -->', '') });
  assert.match(files().text, /^lane files on main: README\.md differs from the branch outside its generated sections$/);
});

// A lane window's rebase stopped at a conflict, or its bisect, as git leaves
// it: the operation's state file in the worktree's own git dir naming the
// branch (git's bisect needs its BISECT_LOG beside it), the worktree's HEAD
// detached at the lane tip and refs/heads/<branch> where it was. Returns the
// undo, which puts the worktree back on the branch it had checked out.
const HELD = [['rebase-merge/head-name', 'refs/heads/', 'rebasing'], ['rebase-apply/head-name', 'refs/heads/', 'rebasing'], ['BISECT_START', '', 'bisecting']];
function holdBranch(wt, branch, file, prefix) {
  const dir = git(wt, 'rev-parse', '--absolute-git-dir');
  const on = git(wt, 'symbolic-ref', 'HEAD');
  const state = path.join(dir, file);
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(state, `${prefix}${branch}\n`);
  if (file === 'BISECT_START') fs.writeFileSync(path.join(dir, 'BISECT_LOG'), 'git bisect start\n');
  git(wt, 'update-ref', '--no-deref', 'HEAD', git(wt, 'rev-parse', 'HEAD'));
  return () => {
    for (const f of [file.split('/')[0], 'BISECT_LOG']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    git(wt, 'symbolic-ref', 'HEAD', on);
  };
}

test('mergedLane: a worktree holding the branch in a rebase or a bisect, its HEAD detached and the branch where it was, fails the worktree check, as git branch -D refuses it; a prunable one too; another branch\'s, the plain detached state and a state file that cannot be read are read as they are', (t) => {
  const repo = osRepo(t);
  const { wt } = lane(t, repo, 'lane-r', { 'server/a.js': 'a v2\n' });
  git(repo, 'merge', '--squash', '-q', 'lane-r');
  git(repo, 'commit', '-q', '-m', 'merge(lane lane-r): docs/plan.md');
  const at = git(repo, 'rev-parse', 'refs/heads/lane-r');
  const worktree = () => M.mergedLane({ cwd: repo, branch: 'lane-r' }).checks[2];
  const branchD = () => spawnSync('git', ['branch', '-D', 'lane-r'], { cwd: repo, encoding: 'utf8' });
  for (const [file, prefix, op] of HELD) {
    const undo = holdBranch(wt, 'lane-r', file, prefix);
    assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: wt }).status, 1, `${file}: the worktree's HEAD is detached`);
    assert.deepEqual(worktree(), { name: 'worktree', ok: false, text: `worktree: ${wt} is ${op} lane-r` }, file);
    assert.match(branchD().stderr, /used by worktree/, `${file}: git branch -D refuses the same state`);
    assert.equal(git(repo, 'rev-parse', 'refs/heads/lane-r'), at);
    undo();
  }
  // The same state of another branch is not this one's: the plain detached state passes, as git branch -D deletes there.
  const undoOther = holdBranch(wt, 'lane-other', 'rebase-merge/head-name', 'refs/heads/');
  assert.deepEqual(worktree(), { name: 'worktree', ok: true, text: 'worktree: gone (no worktree has lane-r checked out)' }, 'detached, no rebase or bisect of lane-r');
  assert.deepEqual(SQ.branchInUse(repo, 'lane-other'), { path: wt, op: 'rebasing', text: `${wt} is rebasing lane-other` });
  undoOther();
  // A state file that cannot be read answers in use, the safe direction.
  const undoTorn = holdBranch(wt, 'lane-r', 'rebase-merge/head-name', 'refs/heads/');
  const dir = git(wt, 'rev-parse', '--absolute-git-dir');
  fs.rmSync(path.join(dir, 'rebase-merge', 'head-name'));
  fs.mkdirSync(path.join(dir, 'rebase-merge', 'head-name'));
  assert.deepEqual(worktree(), { name: 'worktree', ok: false, text: `worktree: ${wt} could not be read (EISDIR at head-name); lane-r counts as in use` });
  undoTorn();
  // A prunable worktree, its directory gone, is read from its git dir, as git reads it.
  holdBranch(wt, 'lane-r', 'rebase-merge/head-name', 'refs/heads/');
  fs.rmSync(wt, { recursive: true, force: true });
  assert.match(git(repo, 'worktree', 'list', '--porcelain'), /\nprunable /);
  assert.deepEqual(worktree(), { name: 'worktree', ok: false, text: `worktree: ${wt} is rebasing lane-r` });
  assert.match(branchD().stderr, /used by worktree/);
  git(repo, 'worktree', 'prune');
  assert.deepEqual(M.mergedLane({ cwd: repo, branch: 'lane-r' }).checks.map((c) => c.ok), [true, true, true], 'pruned, the lane passes the three');
});

// A git on PATH that fails the given subcommand (not merge-base --is-ancestor)
// with exit 128, for the run of fn.
function withFailingGit(t, sub, fn) {
  return withShim(t, `if [ "$1" = ${sub} ] && [ "$2" != --is-ancestor ]; then echo 'fatal: a shim refuses ${sub}' >&2; exit 128; fi`, fn);
}

// A git on PATH that runs the bash line once, at the first call of the given
// subcommand, then goes on, for the run of fn.
function withGitAt(t, sub, line, fn) {
  const done = path.join(tmpDir(t, 'shim-done'), 'done');
  return withShim(t, `if [ "$1" = ${sub} ] && [ ! -e '${done}' ]; then : > '${done}'; { ${line}; } > /dev/null 2>&1; fi`, fn);
}

function withShim(t, body, fn) {
  const real = execFileSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const dir = tmpDir(t, 'shim');
  fs.writeFileSync(path.join(dir, 'git'), `#!/usr/bin/env bash\n${body}\nexec '${real}' "$@"\n`);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  try {
    return fn();
  } finally {
    process.env.PATH = saved;
  }
}

test('git failing is "git failed", never the cause its answer would name: exit 1 is the answer, 128 is a failure', (t) => {
  const repo = osRepo(t);
  lane(t, repo, 'lane-gf', { 'server/a.js': 'a v2\n' });
  review(t, repo, 'lane-gf');
  refusedWith(withFailingGit(t, 'merge-base', () => check(repo, 'lane-gf')), /^refused git failed: fatal: a shim refuses merge-base$/);
  refusedWith(withFailingGit(t, 'rev-parse', () => check(repo, 'lane-gf')), /^refused git failed: fatal: a shim refuses rev-parse$/);
  const empty = execFileSync('git', ['mktree'], { cwd: repo, input: '', encoding: 'utf8' }).trim();
  git(repo, 'branch', 'lane-orphan', git(repo, 'commit-tree', empty, '-m', 'no shared history'));
  refusedWith(check(repo, 'lane-orphan'), /^refused lane-orphan shares no history with main$/);
  refusedWith(check(repo, 'lane-none'), /^refused no branch lane-none$/);
  const m = withFailingGit(t, 'rev-parse', () => M.mergedLane({ cwd: repo, branch: 'lane-gf' }));
  assert.match(m.checks[1].text, /git failed: fatal: a shim refuses rev-parse/);
});

test('a docs-only range after the review: a README prose commit on top is ready, its recorded base never needed', (t) => {
  const repo = osRepo(t);
  const { wt, tip } = lane(t, repo, 'lane-dr', { 'server/a.js': 'a v2\n' });
  const dir = review(t, repo, 'lane-dr');
  commit(wt, 'readme prose', { 'README.md': 'readme\nmore prose\n' });
  const r = check(repo, 'lane-dr');
  assert.equal(r.via, 'key');
  assert.equal(M.line(r), 'ready');
  edit(dir, (rec) => { rec.base = 'e'.repeat(40); });
  assert.equal(M.line(check(repo, 'lane-dr')), 'ready', 'the docs ride outside every key');
  commit(wt, 'a code change', { 'server/b.js': 'b v2\n' });
  refusedWith(check(repo, 'lane-dr'), sinceTip(tip, 2, 'B', ', found by branch,', `records tip ${tip.slice(0, 7)} \\(spec 3\\.8\\)$`));
});

test('the suites list holds only repo paths a runner or a command names; a log with no single-suite command is an unnamed log', (t) => {
  const repo = osRepo(t);
  lane(t, repo, 'lane-c', { 'client/src/components/Plain.js': '// plain\n' });
  const logs = tmpDir(t, 'logs');
  review(t, repo, 'lane-c', {
    tier: 'C',
    more: (at) => {
      ok(cli(repo, 'tests', 'lane-c', '--build', K.writeFile(logs, 'build.log', 'Compiled successfully.\n'), '--exit', '0', '--position', at));
      ok(cli(repo, 'tests', 'lane-c', '--log', K.writeFile(logs, 'extra-suite.log', K.tap(3)), '--position', at));
      ok(cli(repo, 'tests', 'lane-c', '--log', K.writeFile(logs, 'named.log', K.tap(2)), '--command', 'node --test server/a.test.js', '--position', at));
    },
  });
  const r = check(repo, 'lane-c');
  assert.equal(M.line(r), 'ready');
  assert.deepEqual(r.suites, ['server/a.test.js']);
  assert.deepEqual(r.unnamed_logs, ['extra-suite']);
});
