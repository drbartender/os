'use strict';

// Tests for scripts/review-receipt.js's finalize contract beyond the plan's
// acceptance checks (those are review-receipt.test.js): tier A, the quick-fix
// and commit kinds, the staged tree and stale verdicts, triage, escalation,
// the selection, base and reviewed_against, superseding, block and the
// console rule. Fixtures: scripts/lib/receiptTestkit.js. The CLI runs against
// throwaway repos under the temp dir; nothing here touches the dev database.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const K = require('./lib/receiptTestkit');
const { laneKey, commitKey, receiptDir, workDir, readReceipt, LENSES } = require('./lib/receipt');

const { git, commit, tmpDir, laneRepo, makeRepo, cli, ok, refused, problems, report, writeFile, suitesRun, position, prepare, selectFile, finalize, MARK, FLOORS } = K;

test('finalize at tier A records the smoke, the suites, verify and the externals', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files, { tier: 'A' });
  const r = ok(finalize(repo, 'lane', base, 'A', '--not-a-fix', 'a feature'));
  const rec = readReceipt(/dir: (\S+)/.exec(r.stdout)[1]);
  assert.deepStrictEqual(rec.lenses.map((l) => l.name), FLOORS.A.slice().sort((a, b) => LENSES.indexOf(a) - LENSES.indexOf(b)));
  const smoke = rec.tests.find((x) => x.type === 'smoke');
  assert.strictEqual(smoke.pass, 15);
  assert.strictEqual(smoke.skipped, false);
  assert.strictEqual(smoke.suites.length, 2);
  assert.strictEqual(rec.verify.run, true);
  assert.deepStrictEqual(rec.verify.passes, ['verify.md']);
  assert.strictEqual(rec.externals.codex.state, 'run');
  assert.strictEqual(rec.externals.gemini.state, 'not_run');
  assert.ok(fs.existsSync(path.join(path.dirname(path.join(r.stdout.match(/dir: (\S+)/)[1], 'x')), 'externals', 'not-run.txt')));
});

test('finalize --kind quick-fix keys the staged tree, and the commit carries exactly that tree', (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'server/a.js'), 'a fixed\n');
  git(repo, 'add', '--', 'server/a.js');
  const r = ok(cli(repo, 'init', '--branch', 'main', '--quick-fix'));
  const name = /name: (\S+)/.exec(r.stdout)[1];
  prepare(t, repo, name, ['server/a.js']);
  const head = git(repo, 'rev-parse', 'HEAD');
  const atA = problems(refused(cli(repo, 'finalize', name, '--kind', 'quick-fix', '--base', head, '--reviewed-against', head, '--tier', 'A', '--not-a-fix', 'x', '--select', selectFile(repo, 'B'))));
  assert.ok(atA.some((l) => /^ {2}- tier: tier A is a lane, never a quick fix$/.test(l)), atA.join('\n'));
  const f = ok(cli(repo, 'finalize', name, '--kind', 'quick-fix', '--base', head, '--reviewed-against', head, '--tier', 'B', '--not-a-fix', 'copy', '--select', selectFile(repo, 'B')));
  const rec = readReceipt(/dir: (\S+)/.exec(f.stdout)[1]);
  git(repo, 'commit', '-q', '-m', 'fix');
  assert.strictEqual(rec.key, git(repo, 'rev-parse', 'HEAD^{tree}'));
  assert.strictEqual(rec.kind, 'quick-fix');
  assert.strictEqual(rec.tip, head);
  assert.deepStrictEqual(rec.coverage.files_in_diff, ['server/a.js']);
});

test('a quick fix refuses a hunk staged after the snapshot, at the store and at finalize, until the lens re-reads a new snapshot', (t) => {
  const repo = makeRepo(t);
  fs.writeFileSync(path.join(repo, 'server/a.js'), 'a fixed\n');
  git(repo, 'add', '--', 'server/a.js');
  const name = /name: (\S+)/.exec(ok(cli(repo, 'init', '--branch', 'main', '--quick-fix')).stdout)[1];
  const wd = workDir(name, { cwd: repo });
  const dir = tmpDir(t, 'reports');
  const rep = writeFile(dir, 'seams.md', report([['server/a.js', 'pass']]));
  let at = position(repo, name);
  const snapTree = git(repo, 'write-tree');
  // Another window stages a second hunk after the snapshot, while the lens runs.
  fs.writeFileSync(path.join(repo, 'server/a.js'), 'a fixed\nand a second hunk\n');
  git(repo, 'add', '--', 'server/a.js');
  assert.match(refused(cli(repo, 'verdicts', name, '--position', at, 'seams', rep)).stderr, /re-run position and the lens: the staged tree moved under it/);
  assert.match(refused(cli(repo, 'tests', name, '--position', at, '--suites', suitesRun(t))).stderr, /re-run position and the tests: the staged tree moved under it/);
  assert.deepStrictEqual(readReceipt(wd).reports, [], 'nothing stored');
  at = position(repo, name);
  const reviewedTree = git(repo, 'write-tree');
  assert.notStrictEqual(reviewedTree, snapTree);
  ok(cli(repo, 'verdicts', name, '--position', at, 'seams', rep));
  ok(cli(repo, 'tests', name, '--position', at, '--suites', suitesRun(t)));
  assert.deepStrictEqual([readReceipt(wd).reports[0].tree, readReceipt(wd).reports[0].position], [reviewedTree, 2], 'the report records the snapshot tree');
  // A third hunk staged after the store: finalize refuses until a re-pass at a new snapshot.
  fs.writeFileSync(path.join(repo, 'server/a.js'), 'a fixed\nand a second hunk\nand a third\n');
  git(repo, 'add', '--', 'server/a.js');
  const head = git(repo, 'rev-parse', 'HEAD');
  const fin = () => cli(repo, 'finalize', name, '--kind', 'quick-fix', '--base', head, '--reviewed-against', head, '--tier', 'B', '--not-a-fix', 'copy', '--select', selectFile(repo, 'B'));
  const lines = problems(refused(fin()));
  assert.ok(lines.some((l) => /^ {2}- stale: the staged tree changed after seams's latest report \(seams\.md\)/.test(l)), lines.join('\n'));
  assert.ok(fs.existsSync(wd), 'a refusal moves nothing');
  refused(cli(repo, 'verdicts', name, '--position', at, 'seams', writeFile(dir, 'seams2.md', report([['server/a.js', 'pass']])), '--pass', '1'));
  at = position(repo, name);
  ok(cli(repo, 'verdicts', name, '--position', at, 'seams', writeFile(dir, 'seams2.md', report([['server/a.js', 'pass']])), '--pass', '1'));
  assert.ok(problems(refused(fin())).some((l) => new RegExp(`tests: the suites entry .* ran at tree ${reviewedTree.slice(0, 7)}`).test(l)), 'the suites ran on the reviewed tree, not the final one');
  ok(cli(repo, 'tests', name, '--position', at, '--suites', suitesRun(t)));
  const rec = readReceipt(/dir: (\S+)/.exec(ok(fin()).stdout)[1]);
  assert.strictEqual(rec.key, git(repo, 'write-tree'));
  assert.notStrictEqual(rec.key, reviewedTree);
});

test('init --commit needs no --branch and names the review commit-<sha7>; finalize --kind commit keys it', (t) => {
  const repo = makeRepo(t);
  const parent = git(repo, 'rev-parse', 'HEAD');
  const sha = commit(repo, 'an old checkpoint', { 'server/a.js': 'a v3\n' });
  const name = `commit-${sha.slice(0, 7)}`;
  const opened = ok(cli(repo, 'init', '--commit', sha));
  assert.match(opened.stdout, new RegExp(`name: ${name}\n`));
  assert.match(refused(cli(repo, 'init', '--commit', sha)).stderr, /already open/);
  const skel = readReceipt(workDir(name, { cwd: repo }));
  assert.deepStrictEqual([skel.mode, skel.commit, skel.branch], ['commit', sha, null]);
  prepare(t, repo, name, ['server/a.js']);
  const wrongBase = cli(repo, 'finalize', name, '--kind', 'commit', '--base', sha, '--reviewed-against', sha, '--tier', 'B', '--not-a-fix', 'x', '--select', selectFile(repo, 'B'));
  assert.ok(problems(refused(wrongBase)).some((l) => /parent/.test(l)));
  const r = ok(cli(repo, 'finalize', name, '--kind', 'commit', '--base', parent, '--reviewed-against', parent, '--tier', 'B', '--not-a-fix', 'x', '--select', selectFile(repo, 'B')));
  const rec = readReceipt(/dir: (\S+)/.exec(r.stdout)[1]);
  assert.strictEqual(rec.key, commitKey(sha, { cwd: repo }));
  assert.strictEqual(rec.tip, sha);
  assert.strictEqual(rec.name, name);
  assert.strictEqual(rec.written_by, 'review --commit');
  assert.match(ok(cli(repo, 'show', name)).stdout, new RegExp(`commit, tier B, ${name} at ${sha.slice(0, 7)} \\(found by branch\\)`));
  // A --branch beside --commit is recorded as the branch it sits on; the name stays commit-<sha7>.
  const other = commit(repo, 'another', { 'server/b.js': 'b v3\n' });
  ok(cli(repo, 'init', '--commit', other, '--branch', 'main'));
  assert.strictEqual(readReceipt(workDir(`commit-${other.slice(0, 7)}`, { cwd: repo })).branch, 'main');
});

test("a commit review refuses --stale-base, and its tests run only with the checkout's HEAD at the commit", (t) => {
  const repo = makeRepo(t);
  const parent = git(repo, 'rev-parse', 'HEAD');
  const sha = commit(repo, 'an old checkpoint', { 'server/a.js': 'a v3\n' });
  const later = commit(repo, 'a later commit', { 'server/b.js': 'b v3\n' });
  const name = `commit-${sha.slice(0, 7)}`;
  ok(cli(repo, 'init', '--commit', sha));
  let at = position(repo, name);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(workDir(name, { cwd: repo }), 'position.json'), 'utf8')).head, later, 'position records the checkout HEAD');
  const dir = tmpDir(t, 'reports');
  // The lens reads parent..commit and stores; the tests would run on the later tree and are refused.
  ok(cli(repo, 'verdicts', name, '--position', at, 'seams', writeFile(dir, 'seams.md', report([['server/a.js', 'pass']]))));
  const r = refused(cli(repo, 'tests', name, '--position', at, '--suites', suitesRun(t)));
  assert.match(r.stderr, new RegExp(`a commit review's tests run on the commit's own tree: HEAD is ${later.slice(0, 7)}, not the commit ${sha.slice(0, 7)}; check out the commit, then run position and the tests; nothing was stored`));
  git(repo, 'checkout', '-q', '--detach', sha);
  // HEAD moved after the snapshot: position again.
  assert.match(refused(cli(repo, 'tests', name, '--position', at, '--suites', suitesRun(t))).stderr, /HEAD is [0-9a-f]{7}, not the commit/);
  at = position(repo, name);
  // A tracked edit in the checkout: the suites would not run the commit's tree.
  fs.writeFileSync(path.join(repo, 'server/b.js'), 'edited\n');
  assert.match(refused(cli(repo, 'tests', name, '--position', at, '--suites', suitesRun(t))).stderr, /the checkout has 1 tracked file\(s\) changed against the commit \(staged or not\)/);
  git(repo, 'checkout', '-q', 'HEAD', '--', 'server/b.js');
  ok(cli(repo, 'tests', name, '--position', at, '--suites', suitesRun(t)));
  const fin = (...extra) => cli(repo, 'finalize', name, '--kind', 'commit', '--base', parent, '--reviewed-against', parent, '--tier', 'B', '--not-a-fix', 'x', '--select', selectFile(repo, 'B'), ...extra);
  assert.ok(problems(refused(fin('--stale-base'))).includes('  - stale-base: a commit review reads parent..commit; --stale-base is for a lane or a quick fix'));
  const rec = readReceipt(/dir: (\S+)/.exec(ok(fin()).stdout)[1]);
  assert.deepStrictEqual(rec.tests.map((x) => [x.type, x.head]), [['suites', sha]]);
});

test('every finding must be triaged; a fix needs a re-pass by the lens that raised it', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = position(repo, 'lane');
  const dir = tmpDir(t, 'reports');
  const first = writeFile(dir, 'seams.md', report([[files[0], 'finding', 'H1, M2'], [files[1], 'pass']], [
    `- H1 \`${files[0]}:1\` One ${MARK}. Failure path: x. Check: SEAM-1.`,
    `- M2 \`${files[0]}:2\` Two ${MARK}. Failure path: y. Check: SEAM-2.`,
  ]));
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', first));
  ok(cli(repo, 'tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  assert.match(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x')))[0], /2 finding\(s\) untriaged \(seams\.md H1, seams\.md M2\)/);
  refused(cli(repo, 'triage', 'lane', 'seams.md', 'H9', 'rejected', '--reason', 'r'));
  refused(cli(repo, 'triage', 'lane', 'seams.md', 'H1', 'maybe', '--reason', 'r'), 2);
  refused(cli(repo, 'triage', 'lane', 'seams.md', 'H1', 'rejected'), 2);
  ok(cli(repo, 'triage', 'lane', 'seams.md', 'h1', 'fixed', '--reason', `the write moved ${MARK}`));
  ok(cli(repo, 'triage', 'lane', 'seams.md', 'M2', 'rejected', '--reason', `guarded upstream ${MARK}`));
  const fixedLine = new RegExp(`seams\\.md H1 \\(seams\\) is marked fixed but no later seams pass lists ${files[0].replace(/[/.]/g, '\\$&')} as pass`);
  assert.match(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x')))[0], fixedLine);
  // A re-pass that does not list the fixed file, or lists it not reached, does not clear it.
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'seams-b.md', report([[files[1], 'pass']])), '--pass', '1'));
  assert.ok(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x'))).some((l) => fixedLine.test(l)));
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'seams-nr.md', report([[files[0], 'not reached', 'budget']])), '--pass', '2'));
  assert.ok(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x'))).some((l) => fixedLine.test(l)));
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'seams2.md', report([[files[0], 'pass']])), '--pass', '3'));
  const r = ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x'));
  const rec = readReceipt(/dir: (\S+)/.exec(r.stdout)[1]);
  const seams = rec.lenses.find((l) => l.name === 'seams');
  assert.deepStrictEqual([seams.raised, seams.confirmed, seams.fixed, seams.rejected], [2, 1, 1, 1]);
  assert.deepStrictEqual(seams.passes, ['seams.md', 'seams.pass-1.md', 'seams.pass-2.md', 'seams.pass-3.md']);
  assert.strictEqual(seams.verdicts[files[0]], 'pass');
  assert.strictEqual(rec.triage['seams.md#M2'].reason, `guarded upstream ${MARK}`);
});

test('an escalate verdict below tier A is refused', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = position(repo, 'lane');
  const dir = tmpDir(t, 'reports');
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 's.md', report([[files[0], 'escalate', 'writes payout rows'], [files[1], 'pass']]))));
  ok(cli(repo, 'tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  const lines = problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x')));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /escalated/);
});

test('finalize refuses a tier below the computed one and a selected lens with no report', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { at } = prepare(t, repo, 'lane', files);
  const dir = tmpDir(t, 'select');
  const select = writeFile(dir, 'select.json', JSON.stringify({
    tier: 'B',
    tiers_by_file: { [files[0]]: 'B', [files[1]]: 'B' },
    matched_paths: [],
    content_rule_hits: [],
    lenses: [{ name: 'seams', fired_because: ['floor'], forecast: true }, { name: 'business-time', fired_because: ['business-time.current-date'], forecast: false }],
    unforecast_lenses: ['business-time'],
  }));
  const camel = writeFile(dir, 'camel.json', JSON.stringify({ tier: 'B', tiersByFile: {} }));
  assert.ok(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', camel))).some((l) => /snake_case; tiersByFile is not read/.test(l)));
  const noSelect = cli(repo, 'finalize', 'lane', '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', 'B', '--not-a-fix', 'x');
  assert.ok(problems(refused(noSelect)).some((l) => /--kind lane needs --select/.test(l)));
  const lines = problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', select)));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /business-time was selected and has no report/);
  const higher = writeFile(dir, 'a.json', JSON.stringify({ tier: 'A', lenses: [] }));
  assert.ok(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', writeFile(dir, 'notier.json', '{}')))).some((l) => /select: no tier/.test(l)));
  assert.ok(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', higher))).some((l) => /lower than the computed tier A/.test(l)));
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'business-time', writeFile(dir, 'bt.md', report(files.map((f) => [f, 'pass'])))));
  const r = ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', select));
  const rec = readReceipt(/dir: (\S+)/.exec(r.stdout)[1]);
  const bt = rec.lenses.find((l) => l.name === 'business-time');
  assert.deepStrictEqual(bt.fired_because, ['business-time.current-date']);
  assert.strictEqual(bt.forecast, false);
  assert.deepStrictEqual(rec.unforecast_lenses, ['business-time']);
  assert.deepStrictEqual(rec.tiers_by_file, { [files[0]]: 'B', [files[1]]: 'B' });
});

test("finalize refuses a select.json whose tiers_by_file is not the diff's file list (a post-review commit added a file)", (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { dir } = prepare(t, repo, 'lane', files);
  const stale = selectFile(repo, 'B', { tiers_by_file: { [files[0]]: 'B', [files[1]]: 'B', 'README.md': 'docs' } });
  commit(repo, 'a post-review commit', { 'server/routes/payouts.js': 'new\n' });
  const at = position(repo, 'lane');
  const all = writeFile(dir, 'all.md', report([...files, 'server/routes/payouts.js'].map((f) => [f, 'pass'])));
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', all, '--pass', '1'));
  ok(cli(repo, 'tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  const notIn = '  - select: tiers_by_file does not match the diff (not in it: server/routes/payouts.js); run review-select again at the final tip';
  // The new route file computes access-egress into the floors, whatever the stale select says.
  assert.deepStrictEqual(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', stale))), [notIn, '  - lenses: access-egress was selected and has no report']);
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'access-egress', all));
  const lines = problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', stale)));
  assert.deepStrictEqual(lines, [notIn]);
  const extra = selectFile(repo, 'B', { tiers_by_file: Object.fromEntries([...files, 'server/routes/payouts.js', 'server/gone.js'].map((f) => [f, 'B'])) });
  assert.match(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', extra)))[0], /not in the diff: server\/gone\.js/);
  ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x'));
});

test("finalize refuses a select.json computed at another tip than the final one, when it carries tip", (t) => {
  const { repo, base, tip, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { dir } = prepare(t, repo, 'lane', files);
  const early = selectFile(repo, 'B', { tip });
  ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', selectFile(repo, 'B', { tip })), 'computed at the final tip');
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  const fixed = commit(repo, 'a post-review fix', { 'server/b.js': 'b v3\n' });
  const at = position(repo, 'lane');
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'repass.md', report(files.map((f) => [f, 'pass']))), '--pass', '1'));
  ok(cli(repo, 'tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  assert.deepStrictEqual(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', early))),
    [`  - select: select.json was computed at ${tip.slice(0, 7)}; the tip is ${fixed.slice(0, 7)}: run review-select again`]);
  ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', selectFile(repo, 'B', { tip: fixed })));
});

test('finalize computes the tier itself: a post-review money write to a listed file is refused with the stale tier B select, naming the file', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { dir } = prepare(t, repo, 'lane', files);
  const stale = selectFile(repo, 'B');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(stale, 'utf8')).tiers_by_file, { 'server/a.js': 'B', 'server/b.js': 'B' });
  // A post-review commit adds a money write to a file the select already lists.
  commit(repo, 'a post-review money write', { 'server/a.js': "a v2\npool.query('UPDATE proposals SET total_price = $1', [t]);\n" });
  const at = position(repo, 'lane');
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'repass.md', report(files.map((f) => [f, 'pass']))), '--pass', '1'));
  ok(cli(repo, 'tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  const lines = problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--select', stale)));
  assert.ok(lines.includes('  - tier: B is lower than the tier sensitive-match computes for the diff, A'), lines.join('\n'));
  assert.ok(lines.includes('  - select: tiers_by_file gives server/a.js (B, computed A) another tier than sensitive-match computes for the diff now; run review-select again at the final tip'), lines.join('\n'));
  // At tier A the stale per-file tier is still refused.
  const atA = problems(refused(finalize(repo, 'lane', base, 'A', '--not-a-fix', 'x', '--select', stale)));
  assert.ok(atA.some((l) => /^ {2}- select: tiers_by_file gives server\/a\.js \(B, computed A\)/.test(l)), atA.join('\n'));
  assert.ok(!atA.some((l) => /^ {2}- tier: A is lower/.test(l)), atA.join('\n'));
});

test('finalize checks base and reviewed_against: equal, --stale-base too (rebase first), both on main, a lane base is merge-base(main, tip)', (t) => {
  const repo = makeRepo(t);
  const seed = git(repo, 'rev-parse', 'main');
  const m1 = commit(repo, 'main 1', { 'server/m.js': 'm\n' });
  git(repo, 'checkout', '-q', '-b', 'lane');
  const l1 = commit(repo, 'lane 1', { 'server/a.js': 'a v2\n' });
  const l2 = commit(repo, 'lane 2', { 'server/b.js': 'b v2\n' });
  git(repo, 'checkout', '-q', 'main');
  const m2 = commit(repo, 'main 2', { 'server/c.js': 'c\n' });
  git(repo, 'checkout', '-q', 'lane');
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', ['server/a.js', 'server/b.js']);
  const fin = (base, reviewed, ...extra) => cli(repo, 'finalize', 'lane', '--kind', 'lane', '--base', base, '--reviewed-against', reviewed, '--tier', 'B',
    '--not-a-fix', 'x', '--select', selectFile(repo, 'B'), ...extra);
  const has = (r, re) => assert.ok(problems(refused(r)).some((l) => re.test(l)), `${re}\n${r.stderr}`);
  has(fin(m1, m2), new RegExp(`reviewed-against: ${m2.slice(0, 7)} is not the base ${m1.slice(0, 7)}; .*--stale-base`));
  const rebaseFirst = (r, b) => new RegExp(`stale-base: --reviewed-against ${r.slice(0, 7)} is not the base ${b.slice(0, 7)}; .*rebase onto ${r.slice(0, 7)} first`);
  has(fin(m1, seed, '--stale-base'), rebaseFirst(seed, m1));
  has(fin(l1, l1), new RegExp(`base: ${l1.slice(0, 7)} is not on main`));
  has(fin(m1, l2, '--stale-base'), new RegExp(`reviewed-against: ${l2.slice(0, 7)} is not on main`));
  has(fin(seed, seed), new RegExp(`base: a lane's base is merge-base\\(main, tip\\) ${m1.slice(0, 7)}, not ${seed.slice(0, 7)}`));
  has(fin(m2, m2), /not an ancestor of the tip/);
  assert.ok(fs.existsSync(workDir('lane', { cwd: repo })), 'a refusal moves nothing');
  // --stale-base against a main the lane was never rebased onto is refused, an overlap pass notwithstanding.
  let at = position(repo, 'lane', '--overlap', m2);
  const dir = tmpDir(t, 'overlap');
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'o.md', report(['server/a.js', 'server/b.js'].map((f) => [f, 'pass']))), '--pass', '1'));
  assert.deepStrictEqual(problems(refused(fin(m1, m2, '--stale-base'))).filter((l) => /^ {2}- stale-base:/.test(l)).length, 1);
  has(fin(m1, m2, '--stale-base'), rebaseFirst(m2, m1));
  // Rebased onto m2: the overlap pass at m2 and the suites on the rebased tip.
  const tip = K.rebase(repo, 'main');
  at = position(repo, 'lane', '--overlap', m2);
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'o2.md', report(['server/a.js', 'server/b.js'].map((f) => [f, 'pass']))), '--pass', '2'));
  ok(cli(repo, 'tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  has(fin(m2, m2), new RegExp(`main: seams\\.md was read on base ${m1.slice(0, 7)} .*finalize with --stale-base`));
  const rec = readReceipt(/dir: (\S+)/.exec(ok(fin(m2, m2, '--stale-base')).stdout)[1]);
  assert.deepStrictEqual([rec.base, rec.reviewed_against, rec.stale_base], [m2, m2, true]);
  assert.strictEqual(rec.key, laneKey(m2, tip, { cwd: repo }));
});

test('externals records run or not run with the reason, and refuses anything else', (t) => {
  const { repo } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const dir = tmpDir(t, 'ext');
  refused(cli(repo, 'externals', 'lane', 'codex=maybe'), 2);
  refused(cli(repo, 'externals', 'lane', 'claude=run'), 2);
  refused(cli(repo, 'externals', 'lane', 'codex=not_run:'), 2);
  refused(cli(repo, 'externals', 'lane'), 2);
  ok(cli(repo, 'externals', 'lane', `codex=run:${writeFile(dir, 'codex-out.md', `${MARK}\n`)}`, `gemini=not_run:429 ${MARK}`));
  const wd = workDir('lane', { cwd: repo });
  const rec = readReceipt(wd);
  assert.deepStrictEqual(rec.externals, { codex: { state: 'run', output: 'externals/codex.md' }, gemini: { state: 'not_run', reason: `429 ${MARK}` } });
  assert.ok(fs.existsSync(path.join(wd, 'externals', 'codex.md')));
  assert.strictEqual(fs.readFileSync(path.join(wd, 'externals', 'not-run.txt'), 'utf8'), `gemini: 429 ${MARK}\n`);
});

test('a second receipt under the same key supersedes the first, which is kept', (t) => {
  const { repo, base, tip, files } = laneRepo(t);
  for (let i = 0; i < 2; i++) {
    ok(cli(repo, 'init', '--branch', 'lane'));
    prepare(t, repo, 'lane', files);
    ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x'));
  }
  const key = laneKey(base, tip, { cwd: repo });
  const sup = path.join(path.dirname(receiptDir(key, { cwd: repo })), '_superseded');
  assert.strictEqual(fs.readdirSync(sup).filter((d) => d.startsWith(`${key}.`)).length, 1);
  assert.ok(readReceipt(receiptDir(key, { cwd: repo })));
});

test('block prints the spec 3.7 block for a receipt', (t) => {
  const { repo, base, tip, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files, { tier: 'A' });
  ok(finalize(repo, 'lane', base, 'A', '--not-a-fix', 'x'));
  const key = laneKey(base, tip, { cwd: repo });
  const lines = ok(cli(repo, 'block', key)).stdout.trimEnd().split('\n');
  assert.strictEqual(lines.length, 6);
  assert.strictEqual(lines[0], 'Review: tier A');
  assert.strictEqual(lines[1], '  lenses:   money, lifecycle, concurrency, outcomes-providers, access-egress, seams; second opinion (codex; gemini not run); verify');
  assert.strictEqual(lines[2], '  files:    2/2 verdicts');
  assert.strictEqual(lines[3], '  findings: 0 raised, 0 confirmed, 0 fixed and re-reviewed, 0 rejected');
  assert.strictEqual(lines[4], '  tests:    money-smoke 2/2, server/a.test.js 4/4');
  assert.match(lines[5], new RegExp(`^ {2}receipt: {2}patch ${key.slice(0, 7)}, reviewed against main ${base.slice(0, 7)}, \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}$`));
});

test('no command prints a value it stored from a report, a log, a reason or a proof', (t) => {
  const { repo, base, files } = laneRepo(t);
  const outs = [];
  const run = (...args) => {
    const r = cli(repo, ...args);
    outs.push(r.out);
    return r;
  };
  ok(run('init', '--branch', 'lane'));
  const at = position(repo, 'lane');
  const dir = tmpDir(t, 'reports');
  const rep = writeFile(dir, 'seams.md', report([[files[0], 'finding', `H1 ${MARK}`], [files[1], 'looks good']], [`- H1 \`${files[0]}:1\` ${MARK}. Check: SEAM-1.`, `- H2 \`${MARK}:7\` ${MARK}. Check: SEAM-2.`]));
  ok(run('verdicts', 'lane', '--position', at, 'seams', rep));
  ok(run('verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'seams2.md', report([[files[0], 'finding', `H1 ${MARK}`], [files[1], 'pass']], [`- H1 \`${files[0]}:1\` ${MARK}. Check: SEAM-1.`])), '--pass', '1'));
  ok(run('triage', 'lane', 'seams.pass-1.md', 'H1', 'rejected', '--reason', MARK));
  ok(run('triage', 'lane', 'seams.md', 'H1', 'rejected', '--reason', MARK));
  refused(run('triage', 'lane', 'seams.md', 'H7', 'rejected', '--reason', MARK));
  ok(run('tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  refused(run('tests', 'lane', '--position', at, '--log', writeFile(dir, 'x.log', `${MARK}\n`)));
  ok(run('externals', 'lane', `codex=not_run:${MARK}`, `gemini=not_run:${MARK}`));
  ok(run('verify', 'lane', '--position', at, writeFile(dir, 'verify.md', `- H1 \`${files[0]}:1\` ${MARK}. Against: money math.\n`)));
  refused(run('finalize', 'lane', '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', 'B', '--not-a-fix', MARK, '--failing-log', writeFile(dir, 'f.log', `${MARK}\n`), '--failing-test', 'x:1'), 2);
  refused(run('finalize', 'lane', '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', 'B', '--failing-test', 'x:1', '--failing-log', writeFile(dir, 'g.log', `${MARK}\n`), '--select', selectFile(repo, 'B')));
  ok(run('triage', 'lane', 'verify.md', 'H1', 'rejected', '--reason', MARK));
  // A finding marked fixed whose location is no file in the diff: named by id and lens only.
  ok(run('triage', 'lane', 'seams.md', 'H2', 'fixed', '--reason', MARK));
  const fixedLine = problems(refused(run('finalize', 'lane', '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', 'B', '--not-a-fix', MARK, '--select', selectFile(repo, 'B'))));
  assert.deepStrictEqual(fixedLine, ['  - triage: seams.md H2 (seams) is marked fixed but no later seams pass lists the file it names (not a file in the diff) as pass (--pass <n>)']);
  ok(run('triage', 'lane', 'seams.md', 'H2', 'rejected', '--reason', MARK));
  ok(run('finalize', 'lane', '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', 'B', '--not-a-fix', MARK, '--select', selectFile(repo, 'B')));
  ok(run('show', 'lane'));
  ok(run('block', 'lane'));
  for (const o of outs) assert.ok(!o.includes(MARK), `printed a stored value:\n${o}`);
});

test('verdicts --collapsed stores a collapsed report per lens, each read from its own section', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = position(repo, 'lane');
  const dir = tmpDir(t, 'reports');
  const collapsed = [`Both checklists. ${MARK}`, '', '## Lens: money', '', `- H1 \`${files[0]}:1\` Written twice ${MARK}. Check: MON-3.`, '',
    '| file | verdict | note |', '|---|---|---|', `| ${files[0]} | finding | H1 |`, `| ${files[1]} | pass | |`, '',
    '## Lens: seams', '', '| file | verdict | note |', '|---|---|---|', `| ${files[0]} | pass | |`, `| ${files[1]} | pass | |`, ''].join('\n');
  const rep = writeFile(dir, 'collapsed.md', collapsed);
  const outs = [];
  const run = (...args) => {
    const r = cli(repo, ...args);
    outs.push(r.out);
    return r;
  };
  assert.match(refused(run('verdicts', 'lane', '--position', at, 'money', rep)).stderr, /line 12: a ## Lens: heading for a lens other than money; a collapsed report is stored with --collapsed/);
  assert.match(refused(run('verdicts', 'lane', '--position', at, '--collapsed', writeFile(dir, 'one.md', report([[files[0], 'pass']])))).stderr, /no ## Lens: <name> heading/);
  assert.match(refused(run('verdicts', 'lane', '--position', at, '--collapsed', writeFile(dir, 'odd.md', collapsed.replace('## Lens: seams', '## Lens: seems')))).stderr, /odd\.md line 12: a heading names a lens but is not ## Lens: <one of the nine lenses>/);
  refused(run('verdicts', 'lane', '--position', at, 'money', '--collapsed', rep), 2);
  const stored = ok(run('verdicts', 'lane', '--position', at, '--collapsed', rep));
  assert.match(stored.stdout, /stored money\.md \(2 row\(s\); 1 finding\(s\)\)/);
  assert.match(stored.stdout, /stored seams\.md \(2 row\(s\); 0 finding\(s\)\)/);
  const wd = workDir('lane', { cwd: repo });
  assert.deepStrictEqual(readReceipt(wd).reports.map((x) => [x.file, x.lens, x.collapsed]), [['money.md', 'money', true], ['seams.md', 'seams', true]]);
  ok(run('verdicts', 'lane', '--position', at, '--collapsed', rep, '--pass', '1'));
  assert.deepStrictEqual(readReceipt(wd).reports.map((x) => [x.file, x.seq]), [['money.md', 1], ['seams.md', 2], ['money.pass-1.md', 3], ['seams.pass-1.md', 4]]);
  refused(run('triage', 'lane', 'seams.md', 'H1', 'rejected', '--reason', 'x'));
  ok(run('triage', 'lane', 'money.md', 'H1', 'rejected', '--reason', `guarded ${MARK}`));
  ok(run('triage', 'lane', 'money.pass-1.md', 'H1', 'rejected', '--reason', `guarded ${MARK}`));
  ok(run('tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  const rec = readReceipt(/dir: (\S+)/.exec(ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x')).stdout)[1]);
  const by = Object.fromEntries(rec.lenses.map((l) => [l.name, l]));
  assert.deepStrictEqual([by.money.raised, by.money.rejected, by.money.verdicts[files[0]]], [2, 2, 'finding']);
  assert.deepStrictEqual([by.seams.raised, by.seams.verdicts[files[0]], by.seams.verdicts[files[1]]], [0, 'pass', 'pass']);
  for (const o of outs) assert.ok(!o.includes(MARK), o);
});

test("a collapsed report's trailing table or mistyped heading never stands in for a lens's own table", (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = position(repo, 'lane');
  ok(cli(repo, 'tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  const dir = tmpDir(t, 'reports');
  const table = (rows) => ['| file | verdict | note |', '|---|---|---|', ...rows.map(([f, v, n = '']) => `| ${f} | ${v} | ${n} |`), ''];
  // seams's own table says not reached; a trailing table says pass.
  const trailing = [`${MARK}`, '', '## Lens: seams', '', ...table([[files[0], 'pass'], [files[1], 'not reached', 'budget']]), '## Overall', '', ...table(files.map((f) => [f, 'pass']))].join('\n');
  ok(cli(repo, 'verdicts', 'lane', '--position', at, '--collapsed', writeFile(dir, 'trailing.md', trailing)));
  const lines = problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x')));
  assert.deepStrictEqual(lines.map((l) => l.replace(/;.*$/, '')), [`  - coverage: 1 file(s) not reached (seams: ${files[1]})`]);
  // Every heading mistyped, stored as one lens's report: read as malformed, never as the last table.
  const typo = [`${MARK}`, '', '## Lens money', '', ...table(files.map((f) => [f, 'pass'])), '## Lens seams', '', ...table(files.map((f) => [f, 'pass']))].join('\n');
  const stored = ok(cli(repo, 'verdicts', 'lane', '--position', at, 'money', writeFile(dir, 'typo.md', typo)));
  assert.match(stored.stdout, /stored money\.md \(malformed, 2 problem\(s\), no rows read/);
  assert.match(refused(cli(repo, 'verdicts', 'lane', '--position', at, '--collapsed', writeFile(dir, 'typo2.md', typo), '--pass', '1')).stderr, /typo2\.md line 3: a heading names a lens but is not ## Lens: <one of the nine lenses>/);
});

test("externals takes second-opinion.md's two fixed lines verbatim, as two arguments or as one", (t) => {
  const { repo } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const wd = workDir('lane', { cwd: repo });
  const r = ok(cli(repo, 'externals', 'lane', `codex: run (3 findings triaged ${MARK})`, `gemini: not run (429 quota ${MARK})`));
  assert.ok(!r.out.includes(MARK));
  assert.deepStrictEqual(readReceipt(wd).externals, { codex: { state: 'run', note: `3 findings triaged ${MARK}` }, gemini: { state: 'not_run', reason: `429 quota ${MARK}` } });
  assert.strictEqual(fs.readFileSync(path.join(wd, 'externals', 'not-run.txt'), 'utf8'), `gemini: 429 quota ${MARK}\n`);
  ok(cli(repo, 'externals', 'lane', 'codex: not run (auth error)\ngemini: run'));
  assert.deepStrictEqual(readReceipt(wd).externals, { codex: { state: 'not_run', reason: 'auth error' }, gemini: { state: 'run' } });
  refused(cli(repo, 'externals', 'lane', 'codex: not run'), 2);
  refused(cli(repo, 'externals', 'lane', 'codex: not run ()'), 2);
  refused(cli(repo, 'externals', 'lane', 'codex: maybe (x)'), 2);
  refused(cli(repo, 'externals', 'lane', 'codex: run', 'codex=run'), 2);
});

test('a finalize whose move fails leaves the review open, and the next finalize publishes it', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores directory permissions');
    return;
  }
  const { repo, base, tip, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  const wd = workDir('lane', { cwd: repo });
  const root = path.dirname(path.dirname(wd));
  let failed;
  fs.chmodSync(root, 0o555);
  try {
    failed = finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x');
  } finally {
    fs.chmodSync(root, 0o755);
  }
  assert.strictEqual(failed.status, 1, failed.stderr);
  assert.strictEqual(readReceipt(wd).state, 'working', 'the working receipt is never marked final before the move');
  assert.deepStrictEqual(fs.readdirSync(root).filter((d) => d !== '_work'), [], 'nothing half-published');
  const r = ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x'));
  const key = laneKey(base, tip, { cwd: repo });
  assert.ok(r.stdout.includes(receiptDir(key, { cwd: repo })));
  assert.strictEqual(readReceipt(receiptDir(key, { cwd: repo })).state, 'final');
  assert.ok(!fs.existsSync(wd));
  assert.deepStrictEqual(fs.readdirSync(root).filter((d) => d.startsWith('.')), [], 'no temporary directory is left');
});

test('a working directory the publish cannot read leaves nothing half-built and exits 1 with one line', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores directory permissions');
    return;
  }
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  const wd = workDir('lane', { cwd: repo });
  const root = path.dirname(path.dirname(wd));
  const unreadable = path.join(wd, 'tests');
  let r;
  fs.chmodSync(unreadable, 0o000);
  try {
    r = finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x');
  } finally {
    fs.chmodSync(unreadable, 0o755);
  }
  assert.strictEqual(r.status, 1, `status ${r.status} signal ${r.signal}\n${r.stderr}`);
  const lines = r.stderr.trim().split('\n').filter((l) => !/REVIEW_RECEIPT_ROOT/.test(l));
  assert.strictEqual(lines.length, 1, r.stderr);
  assert.match(lines[0], /^finalize: could not build the receipt \(EACCES on .*tests\); nothing was published, and the review stays open$/);
  assert.deepStrictEqual(fs.readdirSync(root).filter((d) => d !== '_work'), [], 'no partial directory is left');
  assert.strictEqual(readReceipt(wd).state, 'working');
  ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x'));
});

test('an index that cannot be written after the receipt moved exits 3, naming the key', (t) => {
  const { repo, base, tip, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  const root = path.dirname(path.dirname(workDir('lane', { cwd: repo })));
  fs.writeFileSync(path.join(root, 'index.json'), '{not json');
  const r = finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x');
  const key = laneKey(base, tip, { cwd: repo });
  assert.strictEqual(r.status, 3, r.stderr);
  assert.match(r.stderr, new RegExp(`receipt ${key} is at .*, but the index was not updated`));
  assert.strictEqual(readReceipt(receiptDir(key, { cwd: repo })).state, 'final');
  assert.ok(ok(cli(repo, 'show', key)).stdout.includes(`receipt ${key}`), 'show finds it by key');
});
