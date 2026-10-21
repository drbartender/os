'use strict';

// Tests for the position snapshot of scripts/review-receipt.js (instruction
// rewrite step 2, lane receipt-lib): `position <name>` records where the
// lenses' input was taken (the branch tip, a quick fix's staged tree, and
// refs/heads/main), every stored report and test entry carries that snapshot,
// and a store is refused when the branch moved after it. Fixtures:
// scripts/lib/receiptTestkit.js; throwaway repos under the temp dir, nothing
// here touches the dev database.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const K = require('./lib/receiptTestkit');
const { workDir, readReceipt } = require('./lib/receipt');

const { git, commit, tmpDir, laneRepo, makeRepo, cli, ok, refused, report, writeFile, suitesRun } = K;

test('a store needs a position snapshot; the entry carries the snapshot, never a store-time fact', (t) => {
  const { repo, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const dir = tmpDir(t, 'reports');
  const rep = writeFile(dir, 'seams.md', report(files.map((f) => [f, 'pass'])));
  const wd = workDir('lane', { cwd: repo });
  for (const args of [['verdicts', 'lane', 'seams', rep], ['verify', 'lane', rep], ['tests', 'lane', '--suites', suitesRun(t)]]) {
    assert.match(refused(cli(repo, ...args, '--position', '1')).stderr, /no position snapshot for lane; run position lane right before the lens's input is taken/, args[0]);
  }
  assert.deepStrictEqual([readReceipt(wd).reports, readReceipt(wd).tests], [[], []], 'nothing stored');
  const tip = git(repo, 'rev-parse', 'lane');
  const main = git(repo, 'rev-parse', 'main');
  assert.strictEqual(ok(cli(repo, 'position', 'lane')).stdout, `position 1 tip ${tip.slice(0, 7)}\n`, 'the seq the skill passes through');
  const snap = JSON.parse(fs.readFileSync(path.join(wd, 'position.json'), 'utf8'));
  assert.deepStrictEqual([snap.seq, snap.tip, snap.main, snap.tree], [1, tip, main, null]);
  ok(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', '1'));
  ok(cli(repo, 'tests', 'lane', '--suites', suitesRun(t), '--position', '1'));
  const st = readReceipt(wd);
  assert.deepStrictEqual([st.reports[0].tip, st.reports[0].main, st.reports[0].position], [tip, main, 1]);
  assert.deepStrictEqual([st.tests[0].tip, st.tests[0].main, st.tests[0].position], [tip, main, 1]);
  // main moving after the snapshot does not change what the next store records.
  git(repo, 'checkout', '-q', 'main');
  commit(repo, 'main moves', { 'server/m.js': 'm\n' });
  git(repo, 'checkout', '-q', 'lane');
  ok(cli(repo, 'verdicts', 'lane', 'money', rep, '--position', '1'));
  assert.strictEqual(readReceipt(wd).reports[1].main, main, 'the snapshot main, not refs/heads/main at the store');
});

test('position replaces an unreadable position.json with one stderr line, and stdout stays the one seq line', (t) => {
  const { repo } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const file = path.join(workDir('lane', { cwd: repo }), 'position.json');
  fs.writeFileSync(file, `{"seq": 1, ${K.MARK}`);
  const r = ok(cli(repo, 'position', 'lane'));
  assert.strictEqual(r.stdout, `position 1 tip ${git(repo, 'rev-parse', 'lane').slice(0, 7)}\n`);
  assert.deepStrictEqual(r.stderr.split('\n').filter((l) => l && !/REVIEW_RECEIPT_ROOT/.test(l)), [`position: ${file} was unreadable; replaced with a new snapshot`]);
});

test('a commit on the branch after the snapshot refuses the store until position runs again', (t) => {
  const { repo, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = K.position(repo, 'lane');
  const dir = tmpDir(t, 'reports');
  const rep = writeFile(dir, 'seams.md', report(files.map((f) => [f, 'pass'])));
  // The session commits a fix while the lens runs.
  const moved = commit(repo, 'a fix while the lens ran', { 'server/a.js': 'a v3\n' });
  for (const [args, what] of [[['verdicts', 'lane', 'seams', rep], 'the lens'], [['verify', 'lane', rep], 'the lens'], [['tests', 'lane', '--suites', suitesRun(t)], 'the tests']]) {
    const r = refused(cli(repo, ...args, '--position', at));
    assert.match(r.stderr, new RegExp(`re-run position and ${what}: the branch moved under it`), args[0]);
  }
  assert.strictEqual(readReceipt(workDir('lane', { cwd: repo })).reports.length, 0);
  const again = K.position(repo, 'lane');
  assert.strictEqual(again, '2');
  ok(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', again));
  const entry = readReceipt(workDir('lane', { cwd: repo })).reports[0];
  assert.deepStrictEqual([entry.tip, entry.position], [moved, 2]);
});

test('a quick fix snapshots the staged tree and HEAD; a commit review snapshots its commit', (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'server/a.js'), 'a fixed\n');
  git(repo, 'add', '--', 'server/a.js');
  const name = /name: (\S+)/.exec(ok(cli(repo, 'init', '--branch', 'main', '--quick-fix')).stdout)[1];
  const head = git(repo, 'rev-parse', 'HEAD');
  const tree = git(repo, 'write-tree');
  assert.strictEqual(ok(cli(repo, 'position', name)).stdout, `position 1 tip ${head.slice(0, 7)}\n`);
  const snap = JSON.parse(fs.readFileSync(path.join(workDir(name, { cwd: repo }), 'position.json'), 'utf8'));
  assert.deepStrictEqual([snap.tip, snap.tree, snap.main], [head, tree, head]);
  const sha = commit(repo, 'an old checkpoint', { 'server/b.js': 'b v9\n' });
  ok(cli(repo, 'init', '--commit', sha));
  ok(cli(repo, 'position', `commit-${sha.slice(0, 7)}`));
  const csnap = JSON.parse(fs.readFileSync(path.join(workDir(`commit-${sha.slice(0, 7)}`, { cwd: repo }), 'position.json'), 'utf8'));
  assert.deepStrictEqual([csnap.tip, csnap.tree, csnap.main], [sha, null, sha]);
  refused(cli(repo, 'position', 'nobody'));
  refused(cli(repo, 'position'), 2);
});

// A lane reviewed at main M0, then main moves to M1 (editing `mainFiles`).
function movedMain(t, mainFiles) {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { dir } = K.prepare(t, repo, 'lane', files);
  git(repo, 'checkout', '-q', 'main');
  const m1 = commit(repo, 'main moves', mainFiles);
  git(repo, 'checkout', '-q', 'lane');
  return { repo, m0: base, m1, files, dir };
}

// The refusal when `lens`'s latest report is no overlap pass against `main`.
function notOverlap(lens, file, main) {
  return `  - stale-base: ${lens}'s latest pass (${file}) is not the overlap pass against main ${main.slice(0, 7)}; run position --overlap ${main.slice(0, 7)}, then ${lens} --pass <n>`;
}

test('a rebase after the review is refused until a seams pass is read at the new main, and then only with --stale-base', (t) => {
  const { repo, m0, m1, files, dir } = movedMain(t, { 'server/m.js': 'm\n' });
  git(repo, 'rebase', '-q', 'main');
  const fin = (...extra) => cli(repo, 'finalize', 'lane', '--kind', 'lane', '--base', m1, '--reviewed-against', m1, '--tier', 'B', '--not-a-fix', 'x', '--select', K.selectFile(repo, 'B'), ...extra);
  const has = (r, re) => assert.ok(K.problems(refused(r)).some((l) => re.test(l)), `${re}\n${r.stderr}`);
  const readOnOld = new RegExp(`main: seams\\.md was read on base ${m0.slice(0, 7)} \\(main ${m0.slice(0, 7)}\\), not the base ${m1.slice(0, 7)}`);
  has(fin(), readOnOld);
  assert.ok(K.problems(refused(fin('--stale-base'))).includes(notOverlap('seams', 'seams.md', m1)));
  const at = K.position(repo, 'lane', '--overlap', m1);
  ok(cli(repo, 'verdicts', 'lane', 'seams', writeFile(dir, 'overlap.md', report(files.map((f) => [f, 'pass']))), '--pass', '1', '--position', at));
  ok(cli(repo, 'tests', 'lane', '--suites', suitesRun(t), '--position', at));
  has(fin(), readOnOld);
  const rec = readReceipt(/dir: (\S+)/.exec(ok(fin('--stale-base')).stdout)[1]);
  assert.deepStrictEqual([rec.base, rec.reviewed_against, rec.stale_base], [m1, m1, true]);
  assert.deepStrictEqual(rec.reports.map((r) => [r.file, r.main, r.overlap]), [['seams.md', m0, undefined], ['seams.pass-1.md', m1, m1]]);
});

// The refusal of --stale-base on a lane not rebased onto `main` (review 4, M1).
function notRebased(main, base) {
  const [m, b] = [main.slice(0, 7), base.slice(0, 7)];
  return `  - stale-base: --reviewed-against ${m} is not the base ${b}; --stale-base is for a review moved onto a newer main: rebase onto ${m} first (spec 3.7), re-pass what it changed and run the overlap pass, then finalize with --base ${m} --reviewed-against ${m} --stale-base`;
}

test('--stale-base needs the lane rebased onto --reviewed-against; a lens that read an overlap file before the rebase re-reads it', (t) => {
  // main moves on server/a.js, a file the lane changed too: an overlap file.
  const { repo, m0, m1, files, dir } = movedMain(t, { 'server/a.js': 'a from main\n' });
  const fin = (base) => cli(repo, 'finalize', 'lane', '--kind', 'lane', '--base', base, '--reviewed-against', m1, '--tier', 'B', '--not-a-fix', 'x', '--select', K.selectFile(repo, 'B'), '--stale-base');
  assert.ok(K.problems(refused(fin(m0))).includes(notRebased(m1, m0)));
  // An overlap pass on the lane as it stands does not stand in for the rebase: its suites never ran main's change.
  let at = K.position(repo, 'lane', '--overlap', m1);
  ok(cli(repo, 'verdicts', 'lane', 'seams', writeFile(dir, 'o0.md', report(files.map((f) => [f, 'pass']))), '--pass', '1', '--position', at));
  assert.deepStrictEqual(K.problems(refused(fin(m0))), [notRebased(m1, m0)]);
  // Rebased onto m1, the overlap resolved: the tip now holds main's change to a.js.
  const tip = K.rebase(repo, 'main', () => fs.writeFileSync(path.join(repo, 'server/a.js'), 'a v2\na from main\n'));
  at = K.position(repo, 'lane', '--overlap', m1);
  // The overlap pass re-reads b.js only; every seams verdict on a.js was read before the rebase.
  ok(cli(repo, 'verdicts', 'lane', 'seams', writeFile(dir, 'o1.md', report([[files[1], 'pass']])), '--pass', '2', '--position', at));
  ok(cli(repo, 'tests', 'lane', '--suites', suitesRun(t), '--position', at));
  assert.deepStrictEqual(K.problems(refused(fin(m1))), [`  - stale: seams read ${files[0]} before a later change to it; re-pass seams on it (--pass <n>)`]);
  ok(cli(repo, 'verdicts', 'lane', 'seams', writeFile(dir, 'o2.md', report([[files[0], 'pass']])), '--pass', '3', '--position', at));
  const rec = readReceipt(/dir: (\S+)/.exec(ok(fin(m1)).stdout)[1]);
  assert.deepStrictEqual([rec.base, rec.reviewed_against, rec.stale_base, rec.tip], [m1, m1, true, tip]);
  assert.deepStrictEqual(rec.tests.map((x) => x.tip), [tip], "the suites ran on the rebased tip, main's change in it");
});

// main changes server/a.js, which the lane changed too, and the rebase's
// conflict on it is resolved to the lane's side: a.js is byte-identical to what
// every lens read, and the lane's diff now reverts main's change (review 5, M1).
function lanesSide(t, tier) {
  const { repo, base: m0, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { dir } = K.prepare(t, repo, 'lane', files, { tier });
  const read = git(repo, 'rev-parse', 'lane');
  git(repo, 'checkout', '-q', 'main');
  const m1 = commit(repo, 'main fixes a.js', { 'server/a.js': 'a from main\n' });
  git(repo, 'checkout', '-q', 'lane');
  const tip = K.rebase(repo, 'main', () => fs.writeFileSync(path.join(repo, 'server/a.js'), 'a v2\n'));
  assert.strictEqual(git(repo, 'rev-parse', `${tip}:server/a.js`), git(repo, 'rev-parse', `${read}:server/a.js`), 'a.js is byte-identical at the rebased tip');
  assert.strictEqual(git(repo, 'diff', '--name-only', read, tip), '', 'no file changed between the two tips');
  const fin = () => cli(repo, 'finalize', 'lane', '--kind', 'lane', '--base', m1, '--reviewed-against', m1, '--tier', tier, '--not-a-fix', 'x', '--select', K.selectFile(repo, tier), '--stale-base');
  const at = K.position(repo, 'lane', '--overlap', m1);
  const pass = (lens, n, list) => ok(cli(repo, 'verdicts', 'lane', lens, writeFile(dir, `${lens}-o${n}.md`, report(list.map((f) => [f, 'pass']))), '--pass', String(n), '--position', at));
  ok(cli(repo, 'tests', 'lane', '--suites', suitesRun(t), '--position', at));
  if (tier === 'A') ok(cli(repo, 'tests', 'lane', '--smoke', K.smokeRun(t), '--position', at));
  return { repo, m0, m1, tip, files, dir, at, fin, pass };
}

const STALE = (lens, file) => `  - stale: ${lens} read ${file} before a later change to it; re-pass ${lens} on it (--pass <n>)`;

test('a conflict on an overlap file resolved to the lane side leaves it byte-identical; a lens that read it on the older base re-reads it', (t) => {
  const { files, fin, pass } = lanesSide(t, 'B');
  // The overlap pass reads b.js only: seams's verdict on a.js was read before main's change to it landed under the lane.
  pass('seams', 1, [files[1]]);
  assert.deepStrictEqual(K.problems(refused(fin())), [STALE('seams', files[0])]);
  pass('seams', 2, [files[0]]);
  ok(fin());
});

test('the same at tier A: money and access-egress re-read the overlap file, and verify re-runs', (t) => {
  const { repo, files, dir, at, fin, pass } = lanesSide(t, 'A');
  // seams and the other three lenses re-read a.js; money and access-egress pass on b.js only; verify does not re-run.
  pass('seams', 1, files);
  for (const lens of ['lifecycle', 'concurrency', 'outcomes-providers']) pass(lens, 1, [files[0]]);
  pass('money', 1, [files[1]]);
  pass('access-egress', 1, [files[1]]);
  const verifyStale = `  - stale: verify's latest pass (verify.md) read the lane before a later change to ${files[0]}; re-pass verify (--pass <n>)`;
  assert.deepStrictEqual(K.problems(refused(fin())), [STALE('money', files[0]), STALE('access-egress', files[0]), verifyStale]);
  pass('money', 2, [files[0]]);
  pass('access-egress', 2, [files[0]]);
  assert.deepStrictEqual(K.problems(refused(fin())), [verifyStale]);
  ok(cli(repo, 'verify', 'lane', writeFile(dir, 'verify-o.md', 'No findings.\n'), '--pass', '1', '--position', at));
  const rec = readReceipt(/dir: (\S+)/.exec(ok(fin()).stdout)[1]);
  assert.deepStrictEqual(rec.verify.passes, ['verify.md', 'verify.pass-1.md']);
});

test('main moving before the first position is no overlap pass: after the rebase, only a pass under position --overlap counts', (t) => {
  // The lane is cut at M0; main moves to M1 before the review opens.
  const { repo, base: m0, files } = laneRepo(t);
  git(repo, 'checkout', '-q', 'main');
  const m1 = commit(repo, 'main moves', { 'server/m.js': 'm\n' });
  git(repo, 'checkout', '-q', 'lane');
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { dir } = K.prepare(t, repo, 'lane', files);
  assert.strictEqual(readReceipt(workDir('lane', { cwd: repo })).reports[0].main, m1, 'the first pass recorded the later main');
  const fin = (base) => cli(repo, 'finalize', 'lane', '--kind', 'lane', '--base', base, '--reviewed-against', m1, '--tier', 'B', '--not-a-fix', 'x', '--select', K.selectFile(repo, 'B'), '--stale-base');
  assert.ok(K.problems(refused(fin(m0))).includes(notRebased(m1, m0)), 'not rebased');
  K.rebase(repo, 'main');
  assert.ok(K.problems(refused(fin(m1))).includes(notOverlap('seams', 'seams.md', m1)));
  // --overlap takes a commit on main.
  assert.match(refused(cli(repo, 'position', 'lane', '--overlap', 'no-such-ref')).stderr, /position: --overlap no-such-ref is not a commit/);
  assert.match(refused(cli(repo, 'position', 'lane', '--overlap', git(repo, 'rev-parse', 'lane'))).stderr, /position: --overlap [0-9a-f]{7} is not on main/);
  const at = K.position(repo, 'lane', '--overlap', m1);
  ok(cli(repo, 'verdicts', 'lane', 'seams', writeFile(dir, 'overlap.md', report(files.map((f) => [f, 'pass']))), '--pass', '1', '--position', at));
  ok(cli(repo, 'tests', 'lane', '--suites', suitesRun(t), '--position', at));
  const rec = readReceipt(/dir: (\S+)/.exec(ok(fin(m1)).stdout)[1]);
  assert.deepStrictEqual(rec.reports.map((r) => [r.file, r.overlap]), [['seams.md', undefined], ['seams.pass-1.md', m1]]);
});

test('at tier A the overlap pass is seams, money and access-egress', (t) => {
  const { repo, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { dir } = K.prepare(t, repo, 'lane', files, { tier: 'A' });
  git(repo, 'checkout', '-q', 'main');
  const m1 = commit(repo, 'main moves', { 'server/m.js': 'm\n' });
  git(repo, 'checkout', '-q', 'lane');
  K.rebase(repo, 'main');
  const fin = () => cli(repo, 'finalize', 'lane', '--kind', 'lane', '--base', m1, '--reviewed-against', m1, '--tier', 'A', '--not-a-fix', 'x', '--select', K.selectFile(repo, 'A'), '--stale-base');
  const at = K.position(repo, 'lane', '--overlap', m1);
  const pass = (lens, n) => ok(cli(repo, 'verdicts', 'lane', lens, writeFile(dir, `${lens}-o${n}.md`, report(files.map((f) => [f, 'pass']))), '--pass', String(n), '--position', at));
  pass('seams', 1);
  ok(cli(repo, 'tests', 'lane', '--suites', suitesRun(t), '--position', at));
  ok(cli(repo, 'tests', 'lane', '--smoke', K.smokeRun(t), '--position', at));
  ok(cli(repo, 'verify', 'lane', writeFile(dir, 'verify-o.md', 'No findings.\n'), '--pass', '1', '--position', at));
  const lines = K.problems(refused(fin()));
  assert.deepStrictEqual(lines, [notOverlap('money', 'money.md', m1), notOverlap('access-egress', 'access-egress.md', m1)]);
  pass('money', 1);
  pass('access-egress', 1);
  ok(fin());
});

test('when a sensitive path landed on main in the overlap range, the overlap seams pass must give every diff file a verdict', (t) => {
  const { repo, m1, files, dir } = movedMain(t, { 'server/utils/pricingEngine.js': 'module.exports = {};\n' });
  K.rebase(repo, 'main');
  const fin = () => cli(repo, 'finalize', 'lane', '--kind', 'lane', '--base', m1, '--reviewed-against', m1, '--tier', 'B', '--not-a-fix', 'x', '--select', K.selectFile(repo, 'B'), '--stale-base');
  const at = K.position(repo, 'lane', '--overlap', m1);
  ok(cli(repo, 'verdicts', 'lane', 'seams', writeFile(dir, 'o1.md', report([[files[0], 'pass']])), '--pass', '1', '--position', at));
  ok(cli(repo, 'tests', 'lane', '--suites', suitesRun(t), '--position', at));
  assert.deepStrictEqual(K.problems(refused(fin())), [
    `  - stale-base: a sensitive path landed on main between the base and --reviewed-against; seams's overlap pass (seams.pass-1.md) must give every diff file a verdict, and gives none to ${files[1]}`,
  ]);
  ok(cli(repo, 'verdicts', 'lane', 'seams', writeFile(dir, 'o2.md', report(files.map((f) => [f, 'pass']))), '--pass', '2', '--position', at));
  ok(fin());
});

test('a test entry that ran before a fix commit is refused at finalize, naming it; a run at the final tip supersedes it', (t) => {
  const { repo, base, tip, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { dir } = K.prepare(t, repo, 'lane', files);
  const fixed = commit(repo, 'the fix', { 'server/a.js': 'a fixed\n' });
  const at = K.position(repo, 'lane');
  ok(cli(repo, 'verdicts', 'lane', 'seams', writeFile(dir, 'repass.md', report(files.map((f) => [f, 'pass']))), '--pass', '1', '--position', at));
  const lines = K.problems(refused(K.finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x')));
  assert.deepStrictEqual(lines, [`  - tests: the suites entry tests/suites-1/summary.json ran at ${tip.slice(0, 7)}, the tip is ${fixed.slice(0, 7)}; run it again on the final tip`]);
  const r = ok(cli(repo, 'tests', 'lane', '--suites', suitesRun(t), '--position', at));
  assert.match(r.stdout, /1 earlier entry ran at another tip; moved to tests_superseded/);
  const rec = readReceipt(/dir: (\S+)/.exec(ok(K.finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x')).stdout)[1]);
  assert.deepStrictEqual(rec.tests.map((x) => [x.type, x.tip]), [['suites', fixed]]);
  assert.deepStrictEqual(rec.tests_superseded.map((x) => [x.type, x.tip]), [['suites', tip]]);
});

test('a report read at an earlier snapshot is refused once position has run again, for verdicts, verify and tests', (t) => {
  const { repo, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const wd = workDir('lane', { cwd: repo });
  const dir = tmpDir(t, 'reports');
  const rep = writeFile(dir, 'seams.md', report(files.map((f) => [f, 'pass'])));
  // The dispatch reads its input at snapshot 1; one report comes back and is stored.
  const first = K.position(repo, 'lane');
  ok(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', first));
  // position runs again (a re-dispatch) before the rest of the first dispatch is stored; the tip has not moved.
  const second = K.position(repo, 'lane');
  assert.deepStrictEqual([first, second], ['1', '2']);
  for (const [args, what] of [[['verdicts', 'lane', 'money', rep], 'the lens'], [['verify', 'lane', rep], 'the lens'], [['tests', 'lane', '--suites', suitesRun(t)], 'the tests']]) {
    const r = refused(cli(repo, ...args, '--position', first));
    assert.match(r.stderr, new RegExp(`this report was read at position 1; the current snapshot is 2: store it before running position again, or re-run ${what}; nothing was stored`), args[0]);
  }
  assert.match(refused(cli(repo, 'verdicts', 'lane', 'money', rep, '--position', '3')).stderr, /this report was read at position 3; the current snapshot is 2/);
  assert.deepStrictEqual([readReceipt(wd).reports.length, readReceipt(wd).tests.length], [1, 0], 'nothing more stored');
  // --position is required, a whole number from 1.
  for (const args of [['verdicts', 'lane', 'money', rep], ['verify', 'lane', rep], ['tests', 'lane', '--suites', suitesRun(t)]]) {
    assert.match(refused(cli(repo, ...args), 2).stderr, /needs --position <seq> \(the seq position printed\)/, args[0]);
    refused(cli(repo, ...args, '--position', '0'), 2);
    refused(cli(repo, ...args, '--position', 'x'), 2);
  }
  // Read again at the current snapshot, it is stored.
  ok(cli(repo, 'verdicts', 'lane', 'money', rep, '--position', second));
  assert.deepStrictEqual(readReceipt(wd).reports.map((r) => [r.file, r.position]), [['seams.md', 1], ['money.md', 2]]);
});

// The dirty-checkout refusal (review 3, M2; review 4, M2): the tracked and
// untracked counts, never a path or its content.
const DIRTY = /the checkout of lane has (\d+) tracked file\(s\) changed against the tip \(staged or not\) and (\d+) untracked file\(s\) git does not ignore; the lenses and the tests would read content the snapshot does not record: commit, restore or remove them, then run position/;

test('a lane whose checkout has tracked changes against the tip refuses position and every store; an untracked file counts too', (t) => {
  const { repo, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = K.position(repo, 'lane');
  const dir = tmpDir(t, 'reports');
  const rep = writeFile(dir, 'seams.md', report(files.map((f) => [f, 'pass'])));
  // An unstaged edit: the lens and the suites would read it, the receipt would key the tip.
  fs.writeFileSync(path.join(repo, 'server/a.js'), `edited ${K.MARK}\n`);
  for (const args of [['verdicts', 'lane', 'seams', rep], ['verify', 'lane', rep], ['tests', 'lane', '--suites', suitesRun(t)]]) {
    const r = refused(cli(repo, ...args, '--position', at));
    assert.strictEqual(DIRTY.exec(r.stderr)[1], '1', args[0]);
    assert.match(r.stderr, /nothing was stored/);
    assert.ok(!r.stderr.includes('server/a.js') && !r.stderr.includes(K.MARK), r.stderr);
  }
  assert.match(refused(cli(repo, 'position', 'lane')).stderr, /^review-receipt: position: the checkout of lane has 1 tracked file/m);
  // Staged, and a second file: still refused, by count.
  git(repo, 'add', '--', 'server/a.js');
  fs.writeFileSync(path.join(repo, 'server/b.js'), 'edited\n');
  assert.strictEqual(DIRTY.exec(refused(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', at)).stderr)[1], '2');
  // Restored, with an untracked file beside it: refused for that file; removed, clean.
  git(repo, 'checkout', '-q', 'HEAD', '--', 'server/a.js', 'server/b.js');
  fs.writeFileSync(path.join(repo, 'server/new.js'), 'untracked\n');
  assert.deepStrictEqual(DIRTY.exec(refused(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', at)).stderr).slice(1), ['0', '1']);
  fs.rmSync(path.join(repo, 'server/new.js'));
  ok(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', at));
  assert.strictEqual(readReceipt(workDir('lane', { cwd: repo })).reports.length, 1);
});

test('an untracked file git does not ignore refuses position and every store, by count: a helper a changed file requires', (t) => {
  // The lane's a.js requires a helper the session never added: green suites at a tip that crashes on require.
  const { repo, files } = laneRepo(t, { 'server/a.js': "require('./helper');\n", 'server/b.js': 'b v2\n' });
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = K.position(repo, 'lane');
  const rep = writeFile(tmpDir(t, 'reports'), 'seams.md', report(files.map((f) => [f, 'pass'])));
  fs.writeFileSync(path.join(repo, 'server/helper.js'), `module.exports = 1; // ${K.MARK}\n`);
  for (const args of [['verdicts', 'lane', 'seams', rep], ['verify', 'lane', rep], ['tests', 'lane', '--suites', suitesRun(t)]]) {
    const r = refused(cli(repo, ...args, '--position', at));
    assert.deepStrictEqual(DIRTY.exec(r.stderr).slice(1), ['0', '1'], args[0]);
    assert.ok(!r.stderr.includes('helper') && !r.stderr.includes(K.MARK), r.stderr);
  }
  assert.match(refused(cli(repo, 'position', 'lane')).stderr, /^review-receipt: position: the checkout of lane has 0 tracked file\(s\) changed against the tip \(staged or not\) and 1 untracked file/m);
  assert.strictEqual(readReceipt(workDir('lane', { cwd: repo })).reports.length, 0, 'nothing stored');
  // A file git ignores is no content of the lane.
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'server/helper.js\n');
  ok(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', at));
  // A commit review's tests: an untracked file is content the commit does not hold.
  const c = makeRepo(t);
  const sha = commit(c, 'a checkpoint', { 'server/a.js': "require('./helper');\n" });
  const name = `commit-${sha.slice(0, 7)}`;
  ok(cli(c, 'init', '--commit', sha));
  const cat = K.position(c, name);
  fs.writeFileSync(path.join(c, 'server/helper.js'), 'module.exports = 1;\n');
  const r = refused(cli(c, 'tests', name, '--suites', suitesRun(t), '--position', cat));
  assert.match(r.stderr, /the checkout has 0 tracked file\(s\) changed against the commit \(staged or not\) and 1 untracked file\(s\) git does not ignore; the tests would run content the commit does not hold/);
  assert.ok(!r.stderr.includes('helper'), r.stderr);
  fs.rmSync(path.join(c, 'server/helper.js'));
  ok(cli(c, 'tests', name, '--suites', suitesRun(t), '--position', cat));
});

// The refusal of review 5, L1: index entries git diff never compares.
const HIDDEN = (who) => new RegExp(`${who} (\\d+) index entr(?:y|ies) marked assume-unchanged or skip-worktree, which git diff never compares with the disk; clear them \\(git update-index --no-assume-unchanged --no-skip-worktree\\), then run position`);

test('an index entry marked assume-unchanged or skip-worktree refuses position and every store, by count (review 5, L1)', (t) => {
  const { repo, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = K.position(repo, 'lane');
  const rep = writeFile(tmpDir(t, 'reports'), 'seams.md', report(files.map((f) => [f, 'pass'])));
  // Marked, then edited: git diff does not see the edit, and the lens and the suites would read it.
  git(repo, 'update-index', '--assume-unchanged', '--', 'server/a.js');
  fs.writeFileSync(path.join(repo, 'server/a.js'), `hidden edit ${K.MARK}\n`);
  assert.strictEqual(git(repo, 'status', '--porcelain'), '', 'git status shows nothing');
  const lane = HIDDEN('the checkout of lane has');
  for (const args of [['verdicts', 'lane', 'seams', rep], ['verify', 'lane', rep], ['tests', 'lane', '--suites', suitesRun(t)]]) {
    const r = refused(cli(repo, ...args, '--position', at));
    assert.strictEqual(lane.exec(r.stderr)[1], '1', args[0]);
    assert.ok(!r.stderr.includes('server/a.js') && !r.stderr.includes(K.MARK), r.stderr);
  }
  assert.match(refused(cli(repo, 'position', 'lane')).stderr, lane);
  // Cleared, the edit is a tracked change; restored, the store goes through.
  git(repo, 'update-index', '--no-assume-unchanged', '--', 'server/a.js');
  assert.strictEqual(DIRTY.exec(refused(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', at)).stderr)[1], '1');
  git(repo, 'checkout', '-q', 'HEAD', '--', 'server/a.js');
  ok(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', at));
  // skip-worktree is refused while set, edited or not.
  git(repo, 'update-index', '--skip-worktree', '--', 'server/a.js', 'server/b.js');
  assert.strictEqual(lane.exec(refused(cli(repo, 'verdicts', 'lane', 'money', rep, '--position', at)).stderr)[1], '2');
  git(repo, 'update-index', '--no-skip-worktree', '--', 'server/a.js', 'server/b.js');
  ok(cli(repo, 'verdicts', 'lane', 'money', rep, '--position', at));
  // A quick fix, at position and every store; a commit review's tests.
  const q = makeRepo(t);
  fs.writeFileSync(path.join(q, 'server/a.js'), 'a fixed\n');
  git(q, 'add', '--', 'server/a.js');
  const name = /name: (\S+)/.exec(ok(cli(q, 'init', '--branch', 'main', '--quick-fix')).stdout)[1];
  const qat = K.position(q, name);
  git(q, 'update-index', '--assume-unchanged', '--', 'server/b.js');
  const qrep = writeFile(tmpDir(t, 'reports'), 'qf.md', report([['server/a.js', 'pass']]));
  for (const args of [['verdicts', name, 'seams', qrep], ['tests', name, '--suites', suitesRun(t)]]) {
    assert.strictEqual(HIDDEN('the checkout has').exec(refused(cli(q, ...args, '--position', qat)).stderr)[1], '1', args[0]);
  }
  assert.match(refused(cli(q, 'position', name)).stderr, HIDDEN('the checkout has'));
  const sha = git(q, 'rev-parse', 'HEAD');
  ok(cli(q, 'init', '--commit', sha));
  const cat = K.position(q, `commit-${sha.slice(0, 7)}`);
  assert.match(refused(cli(q, 'tests', `commit-${sha.slice(0, 7)}`, '--suites', suitesRun(t), '--position', cat)).stderr, HIDDEN('the checkout has'));
});

// The refusals of review 4, M4: a lane in no worktree, and a lane mid-rebase.
const NOWHERE = /lane is checked out in no worktree; the lenses and the tests read a checkout: check the lane out in a worktree first, then run position/;
const MID_REBASE = /lane is mid-rebase in a worktree \(git's rebase-merge or rebase-apply state\); the checkout holds content no commit records: finish or abort the rebase, then run position/;
const MANY = /the (\d+) checkouts of lane have (\d+) tracked file\(s\) changed against the tip \(staged or not\) and (\d+) untracked file\(s\) git does not ignore/;

test('a lane checked out in no worktree is refused; every worktree that has it checked out is compared, a detached one at the tip and a forced second one too', (t) => {
  const { repo, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const dir = tmpDir(t, 'reports');
  const rep = writeFile(dir, 'seams.md', report(files.map((f) => [f, 'pass'])));
  let at = K.position(repo, 'lane');
  // lane leaves the checkout: nothing holds what the lens would read.
  git(repo, 'checkout', '-q', 'main');
  for (const args of [['verdicts', 'lane', 'seams', rep], ['verify', 'lane', rep], ['tests', 'lane', '--suites', suitesRun(t)]]) {
    assert.match(refused(cli(repo, ...args, '--position', at)).stderr, NOWHERE, args[0]);
  }
  assert.match(refused(cli(repo, 'position', 'lane')).stderr, NOWHERE);
  // lane in its own worktree: that checkout is compared, and main's dirty one is not.
  const wts = tmpDir(t, 'wt');
  const wt = path.join(wts, 'lane');
  git(repo, 'worktree', 'add', '-q', wt, 'lane');
  fs.writeFileSync(path.join(repo, 'server/a.js'), 'main edited\n');
  at = K.position(repo, 'lane');
  ok(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', at));
  fs.writeFileSync(path.join(wt, 'server/b.js'), 'lane edited\n');
  assert.strictEqual(DIRTY.exec(refused(cli(repo, 'position', 'lane')).stderr)[1], '1');
  git(wt, 'checkout', '-q', 'HEAD', '--', 'server/b.js');
  // A second worktree detached at the lane tip is the lane's checkout too.
  const detached = path.join(wts, 'detached');
  git(repo, 'worktree', 'add', '-q', '--detach', detached, 'lane');
  fs.writeFileSync(path.join(detached, 'server/a.js'), `detached edit ${K.MARK}\n`);
  let r = refused(cli(repo, 'verdicts', 'lane', 'money', rep, '--position', at));
  assert.deepStrictEqual(MANY.exec(r.stderr).slice(1), ['2', '1', '0']);
  assert.ok(!r.stderr.includes(K.MARK) && !r.stderr.includes('server/a.js'), r.stderr);
  git(detached, 'checkout', '-q', 'HEAD', '--', 'server/a.js');
  ok(cli(repo, 'verdicts', 'lane', 'money', rep, '--position', at));
  // The branch forced into a third worktree: compared as well.
  const forced = path.join(wts, 'forced');
  git(repo, 'worktree', 'add', '-q', '--force', forced, 'lane');
  fs.writeFileSync(path.join(forced, 'server/new.js'), 'untracked\n');
  r = refused(cli(repo, 'position', 'lane'));
  assert.deepStrictEqual(MANY.exec(r.stderr).slice(1), ['3', '0', '1']);
  fs.rmSync(path.join(forced, 'server/new.js'));
  at = K.position(repo, 'lane');
  ok(cli(repo, 'verdicts', 'lane', 'lifecycle', rep, '--position', at));
});

test('a lane mid-rebase in any worktree refuses position and every store, under either rebase backend', (t) => {
  for (const backend of ['--merge', '--apply']) {
    const { repo, files } = laneRepo(t);
    ok(cli(repo, 'init', '--branch', 'lane'));
    const dir = tmpDir(t, 'reports');
    const rep = writeFile(dir, 'seams.md', report(files.map((f) => [f, 'pass'])));
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'main edits the lane file', { 'server/a.js': 'a from main\n' });
    git(repo, 'checkout', '-q', 'lane');
    const at = K.position(repo, 'lane');
    // The rebase stops on the conflict: the checkout is detached, its files hold conflict markers.
    const stopped = spawnSync('git', ['rebase', '-q', backend, 'main'], { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
    assert.notStrictEqual(stopped.status, 0, `${backend}: the rebase should stop on the conflict`);
    for (const args of [['verdicts', 'lane', 'seams', rep], ['verify', 'lane', rep], ['tests', 'lane', '--suites', suitesRun(t)]]) {
      assert.match(refused(cli(repo, ...args, '--position', at)).stderr, MID_REBASE, `${backend} ${args[0]}`);
    }
    assert.match(refused(cli(repo, 'position', 'lane')).stderr, MID_REBASE, backend);
    git(repo, 'rebase', '--abort');
    ok(cli(repo, 'verdicts', 'lane', 'seams', rep, '--position', at));
  }
});

// A quick fix's tests store (review 5, M3, the owner's ruling): the suites
// run on the working tree, so it must hold exactly the staged tree.
const QF_TESTS = /the checkout has (\d+) tracked file\(s\) with unstaged changes and (\d+) untracked file\(s\) git does not ignore; a quick fix's tests run on the working tree, which must hold exactly the staged tree: stage, restore or remove them, then run position and the tests/;

test('a quick fix refuses an unstaged change on a staged path at position and the lens stores; a change elsewhere counts only at the tests store', (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'server/a.js'), 'a fixed\n');
  git(repo, 'add', '--', 'server/a.js');
  const name = /name: (\S+)/.exec(ok(cli(repo, 'init', '--branch', 'main', '--quick-fix')).stdout)[1];
  const at = K.position(repo, name);
  const rep = writeFile(tmpDir(t, 'reports'), 'seams.md', report([['server/a.js', 'pass']]));
  // Another window's edit on a path the fix does not stage: not the fix's content for a lens.
  fs.writeFileSync(path.join(repo, 'server/b.js'), 'elsewhere\n');
  ok(cli(repo, 'verdicts', name, 'seams', rep, '--position', at));
  // An unstaged edit on the staged path: the lens would read it, the key is the staged tree.
  fs.writeFileSync(path.join(repo, 'server/a.js'), `a fixed\nunstaged ${K.MARK}\n`);
  const r = refused(cli(repo, 'verdicts', name, 'money', rep, '--position', at));
  assert.match(r.stderr, /1 staged path\(s\) have unstaged changes; the lenses and the tests would read content the staged tree does not hold: stage or restore them, then run position/);
  assert.ok(!r.stderr.includes('server/a.js') && !r.stderr.includes(K.MARK), r.stderr);
  assert.match(refused(cli(repo, 'position', name)).stderr, /^review-receipt: position: 1 staged path\(s\) have unstaged changes/m);
  // The tests store counts both edits: the suites would run them.
  const tr = refused(cli(repo, 'tests', name, '--suites', suitesRun(t), '--position', at));
  assert.deepStrictEqual(QF_TESTS.exec(tr.stderr).slice(1), ['2', '0']);
  assert.ok(!tr.stderr.includes('server/') && !tr.stderr.includes(K.MARK), tr.stderr);
});

test("a quick fix's tests store refuses an untracked helper the staged file requires, and any unstaged change; the lens stores do not (review 5, M3)", (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'server/a.js'), "require('./helper');\n");
  git(repo, 'add', '--', 'server/a.js');
  const name = /name: (\S+)/.exec(ok(cli(repo, 'init', '--branch', 'main', '--quick-fix')).stdout)[1];
  // The helper was never added: the suites would pass on the tree and the commit would crash on require.
  fs.writeFileSync(path.join(repo, 'server/helper.js'), `module.exports = 1; // ${K.MARK}\n`);
  const at = K.position(repo, name);
  const rep = writeFile(tmpDir(t, 'reports'), 'seams.md', report([['server/a.js', 'pass']]));
  ok(cli(repo, 'verdicts', name, 'seams', rep, '--position', at));
  let r = refused(cli(repo, 'tests', name, '--suites', suitesRun(t), '--position', at));
  assert.deepStrictEqual(QF_TESTS.exec(r.stderr).slice(1), ['0', '1']);
  assert.ok(!r.stderr.includes('helper') && !r.stderr.includes(K.MARK), r.stderr);
  assert.strictEqual(readReceipt(workDir(name, { cwd: repo })).tests.length, 0, 'nothing stored');
  // Removed, an unstaged edit to a tracked file the fix does not stage refuses the tests store too.
  fs.rmSync(path.join(repo, 'server/helper.js'));
  fs.writeFileSync(path.join(repo, 'server/b.js'), 'unstaged\n');
  r = refused(cli(repo, 'tests', name, '--suites', suitesRun(t), '--position', at));
  assert.deepStrictEqual(QF_TESTS.exec(r.stderr).slice(1), ['1', '0']);
  ok(cli(repo, 'verdicts', name, 'money', rep, '--position', at));
  git(repo, 'checkout', '-q', '--', 'server/b.js');
  ok(cli(repo, 'tests', name, '--suites', suitesRun(t), '--position', at));
});

test('externals entries carry the snapshot they were recorded at, and are never refused for it', (t) => {
  const { repo } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const wd = workDir('lane', { cwd: repo });
  // No snapshot yet: recorded as before, with no position.
  ok(cli(repo, 'externals', 'lane', 'codex=run'));
  assert.deepStrictEqual(readReceipt(wd).externals.codex, { state: 'run' });
  const tip = git(repo, 'rev-parse', 'lane');
  const main = git(repo, 'rev-parse', 'main');
  K.position(repo, 'lane');
  // The branch moves after the snapshot: an external is recorded, not gated (spec 3.10).
  commit(repo, 'a later fix', { 'server/a.js': 'a v3\n' });
  ok(cli(repo, 'externals', 'lane', 'codex: run (2 findings)', 'gemini: not run (quota)'));
  const ext = readReceipt(wd).externals;
  assert.deepStrictEqual(ext.codex, { state: 'run', note: '2 findings', tip, main, position: 1 });
  assert.deepStrictEqual(ext.gemini, { state: 'not_run', reason: 'quota', tip, main, position: 1 });
});
