'use strict';

// Tests for scripts/review-receipt.js (instruction rewrite step 2, lane
// receipt-lib), the plan's acceptance check 3 among them: init, verdicts, the
// finalize refusals the plan names, tests, show. The rest of finalize's
// contract is review-receipt.finalize.test.js; the fixtures are
// scripts/lib/receiptTestkit.js. The CLI runs against throwaway repos under
// the temp dir; nothing here touches the dev database.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const K = require('./lib/receiptTestkit');
const { laneKey, receiptDir, workDir, readReceipt } = require('./lib/receipt');

const { commit, tmpDir, laneRepo, cli, ok, refused, problems, report, writeFile, tap, suitesRun, smokeRun, position, prepare, selectFile, finalize, MARK } = K;

const PROOF_CLI = path.join(__dirname, 'comment-only-proof.js');

// The two server files as code the proof parses (the testkit's seed is not).
const A_JS = "module.exports = 'a';\n";
const B_JS = "module.exports = 'b';\n";

// A repo whose main holds A_JS and B_JS.
function codeRepo(t) {
  const repo = K.makeRepo(t);
  commit(repo, 'code', { 'server/a.js': A_JS, 'server/b.js': B_JS });
  return repo;
}

// A lane of two comment-only commits (a comment above server/a.js, then
// above server/b.js with README.md regenerated beside it; the proof skips the
// generated docs as the key does) -> {repo, base, mid, tip}.
function commentLane(t) {
  const repo = codeRepo(t);
  const base = K.git(repo, 'rev-parse', 'main');
  K.git(repo, 'checkout', '-q', '-b', 'lane');
  const mid = commit(repo, 'a comment', { 'server/a.js': `// what a holds\n${A_JS}` });
  const tip = commit(repo, 'another comment', { 'server/b.js': `// what b holds\n${B_JS}`, 'README.md': 'readme, regenerated\n' });
  return { repo, base, mid, tip };
}

// scripts/comment-only-proof.js's JSON for `args`, written to a file; the
// proof must say yes.
function proofFile(t, repo, ...args) {
  const out = path.join(tmpDir(t, 'proof'), 'proof.json');
  const r = spawnSync(process.execPath, [PROOF_CLI, ...args, '--out', out], { cwd: repo, encoding: 'utf8', env: { ...process.env, REVIEW_RECEIPT_ROOT: repo } });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  return out;
}

// A staged proof after staging `files`; unless keep, the files are put back
// and unstaged after, so the checkout is as it was.
function stagedProof(t, repo, files, { keep = false } = {}) {
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, rel), text);
  if (Object.keys(files).length) K.git(repo, 'add', '--', ...Object.keys(files));
  const out = proofFile(t, repo, '--staged');
  if (!keep && Object.keys(files).length) K.git(repo, 'checkout', '-q', 'HEAD', '--', ...Object.keys(files));
  return out;
}

test('init opens a working directory with a skeleton receipt, once per name', (t) => {
  const { repo } = laneRepo(t);
  const r = ok(cli(repo, 'init', '--branch', 'lane'));
  const dir = workDir('lane', { cwd: repo });
  assert.ok(r.stdout.includes(dir));
  const skel = readReceipt(dir);
  assert.strictEqual(skel.version, 1);
  assert.strictEqual(skel.state, 'working');
  assert.strictEqual(skel.mode, 'lane');
  assert.strictEqual(skel.branch, 'lane');
  refused(cli(repo, 'init', '--branch', 'lane'));
  refused(cli(repo, 'init', '--branch', 'no-such-branch'));
  refused(cli(repo, 'init', '--branch', 'lane', '--quick-fix', '--commit', 'HEAD'), 2);
  refused(cli(repo, 'init'), 2);
});

test('init --quick-fix names the review quick-fix-<timestamp>', (t) => {
  const { repo } = laneRepo(t);
  const r = ok(cli(repo, 'init', '--branch', 'main', '--quick-fix'));
  const name = /name: (quick-fix-\d{8}T\d{6}Z(?:-\d+)?)/.exec(r.stdout)[1];
  const skel = readReceipt(workDir(name, { cwd: repo }));
  assert.strictEqual(skel.mode, 'quick-fix');
  assert.strictEqual(skel.branch, 'main');
  const again = ok(cli(repo, 'init', '--branch', 'main', '--quick-fix'));
  assert.notStrictEqual(/name: (\S+)/.exec(again.stdout)[1], name);
});

test('verdicts stores each report under the contract name and refuses to overwrite one', (t) => {
  const { repo, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = position(repo, 'lane');
  const dir = tmpDir(t, 'reports');
  const first = writeFile(dir, 'r1.md', report([[files[0], 'finding', 'H1'], [files[1], 'pass']], [`- H1 \`${files[0]}:1\` A defect ${MARK}. Check: MON-1.`]));
  const repass = writeFile(dir, 'r2.md', report([[files[0], 'pass']]));
  refused(cli(repo, 'verdicts', 'lane', '--position', at, 'money', repass, '--pass', '1'));
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'money', first));
  assert.match(refused(cli(repo, 'verdicts', 'lane', '--position', at, 'money', first)).stderr, /money\.md is already stored/);
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'money', repass, '--pass', '1'));
  assert.match(refused(cli(repo, 'verdicts', 'lane', '--position', at, 'money', repass, '--pass', '1')).stderr, /money\.pass-1\.md is already stored/);
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', first, '--part', '2'));
  refused(cli(repo, 'verdicts', 'lane', '--position', at, 'moneyy', first), 2);
  refused(cli(repo, 'verdicts', 'lane', '--position', at, 'money', first, '--pass', '0'), 2);
  refused(cli(repo, 'verdicts', 'lane', '--position', at, 'money', first, '--pass', '2', '--part', '1'), 2);
  refused(cli(repo, 'verdicts', 'nobody', 'money', first, '--position', at));
  const wd = workDir('lane', { cwd: repo });
  assert.deepStrictEqual(fs.readdirSync(wd).filter((f) => f.endsWith('.md')).sort(), ['money.md', 'money.pass-1.md', 'seams.part-2.md']);
  assert.strictEqual(fs.readFileSync(path.join(wd, 'money.md'), 'utf8'), fs.readFileSync(first, 'utf8'));
});

test('verdicts reports the files a lens did not reach, by name from the diff', (t) => {
  const { repo, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = position(repo, 'lane');
  const dir = tmpDir(t, 'reports');
  const r = ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 's.md', report([[files[0], 'pass']]))));
  assert.match(r.stdout, /seams: 1\/2 files with a verdict/);
  assert.match(r.stdout, new RegExp(`not reached: ${files[1].replace(/\//g, '\\/')}`));
  const broken = ok(cli(repo, 'verdicts', 'lane', '--position', at, 'money', writeFile(dir, 'm.md', `prose only ${MARK}\n`)));
  assert.match(broken.stdout, /malformed/);
  assert.match(broken.stdout, /money: 0\/2 files with a verdict/);
});

test('finalize writes receipt.json to the contract, moves the directory and updates the index', (t) => {
  const { repo, base, tip, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  const r = ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', `a feature ${MARK}`));
  const key = laneKey(base, tip, { cwd: repo });
  const dir = receiptDir(key, { cwd: repo });
  assert.ok(r.stdout.includes(dir));
  assert.ok(!fs.existsSync(workDir('lane', { cwd: repo })));
  const rec = readReceipt(dir);
  for (const field of ['version', 'key', 'kind', 'branch', 'tip', 'reviewed_against', 'base', 'tier', 'tiers_by_file', 'matched_paths', 'content_rule_hits',
    'lenses', 'unforecast_lenses', 'coverage', 'tests', 'failing_test_on_old_code', 'externals', 'verify', 'escalated', 'timestamp', 'written_by']) {
    assert.ok(Object.prototype.hasOwnProperty.call(rec, field), `receipt.json has ${field}`);
  }
  assert.strictEqual(rec.version, 1);
  assert.strictEqual(rec.key, key);
  assert.strictEqual(rec.kind, 'lane');
  assert.strictEqual(rec.branch, 'lane');
  assert.strictEqual(rec.tip, tip);
  assert.strictEqual(rec.base, base);
  assert.strictEqual(rec.reviewed_against, base);
  assert.strictEqual(rec.tier, 'B');
  assert.strictEqual(rec.written_by, 'review skill');
  assert.strictEqual(rec.failing_test_on_old_code, null);
  assert.strictEqual(rec.not_a_fix, `a feature ${MARK}`);
  assert.deepStrictEqual(rec.lenses.map((l) => l.name), ['seams']);
  const seams = rec.lenses[0];
  for (const field of ['name', 'fired_because', 'forecast', 'raised', 'confirmed', 'fixed', 'rejected', 'passes', 'verdicts']) assert.ok(field in seams, `lens has ${field}`);
  assert.deepStrictEqual(seams.fired_because, ['floor']);
  assert.deepStrictEqual(seams.passes, ['seams.md']);
  assert.deepStrictEqual(seams.verdicts, { [files[0]]: 'pass', [files[1]]: 'pass' });
  assert.deepStrictEqual(rec.coverage, { files_in_diff: files, files_with_verdicts: files, not_reached: [], allowed_not_reached: false });
  assert.strictEqual(rec.tests.length, 1);
  assert.strictEqual(rec.tests[0].type, 'suites');
  assert.strictEqual(rec.tests[0].pass, 4);
  assert.strictEqual(rec.tests[0].fail, 0);
  assert.ok(fs.existsSync(path.join(dir, rec.tests[0].log)), 'the summary is copied into the receipt');
  assert.ok(fs.existsSync(path.join(dir, rec.tests[0].suites[0].log)), 'the suite log is copied into the receipt');
  assert.deepStrictEqual(rec.externals, { codex: { state: 'not_run', reason: 'not required at tier B' }, gemini: { state: 'not_run', reason: 'not required at tier B' } });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'externals', 'not-run.txt'), 'utf8'), 'codex: not required at tier B\ngemini: not required at tier B\n', 'below tier A too');
  assert.strictEqual(rec.verify.run, false);
  assert.deepStrictEqual(rec.escalated, []);
  assert.ok(!Number.isNaN(Date.parse(rec.timestamp)));
  assert.ok(fs.existsSync(path.join(dir, 'seams.md')));
  const idx = JSON.parse(fs.readFileSync(path.join(path.dirname(dir), 'index.json'), 'utf8'));
  assert.strictEqual(idx.lane.key, key);
  assert.strictEqual(idx.lane.tip, tip);
  assert.strictEqual(idx.lane.reviewed_against, base);
});

test('finalize refuses a file not reached unless --allow-not-reached is passed after a re-dispatch that missed it too', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { at } = prepare(t, repo, 'lane', files.slice(0, 1));
  const lines = problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x')));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /not reached/);
  assert.ok(lines[0].includes(`seams: ${files[1]}`));
  assert.ok(fs.existsSync(workDir('lane', { cwd: repo })), 'a refusal moves nothing');
  // --allow-not-reached needs the one re-dispatch of spec 3.5 first: a --pass report that missed it too.
  const early = problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--allow-not-reached')));
  assert.deepStrictEqual(early, [`  - coverage: --allow-not-reached admits a file only after its one re-dispatch missed it too, a --pass report of its lens with a not reached row for it; none for seams: ${files[1]} (re-dispatch it to that lens once, --pass <n>)`]);
  const dir = tmpDir(t, 'repass');
  // A re-pass of the other file is no re-dispatch of this one.
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'other.md', report([[files[0], 'pass']])), '--pass', '2'));
  assert.deepStrictEqual(problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--allow-not-reached'))), early);
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 'r.md', report([[files[1], 'not reached', 'budget']])), '--pass', '1'));
  const r = ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x', '--allow-not-reached'));
  const rec = readReceipt(/dir: (\S+)/.exec(r.stdout)[1]);
  assert.strictEqual(rec.coverage.allowed_not_reached, true);
  assert.deepStrictEqual(rec.coverage.not_reached, [{ lens: 'seams', file: files[1] }]);
});

test('a report with no table leaves every file not reached and finalize refuses', (t) => {
  const { repo, base } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = position(repo, 'lane');
  const dir = tmpDir(t, 'reports');
  ok(cli(repo, 'verdicts', 'lane', '--position', at, 'seams', writeFile(dir, 's.md', `Everything looks fine. ${MARK}\n`)));
  ok(cli(repo, 'tests', 'lane', '--position', at, '--suites', suitesRun(t)));
  const lines = problems(refused(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x')));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /2 file\(s\) not reached/);
});

for (const tier of ['A', 'B', 'hinge']) {
  test(`finalize refuses a missing tests entry at tier ${tier}`, (t) => {
    const { repo, base, files } = laneRepo(t);
    ok(cli(repo, 'init', '--branch', 'lane'));
    prepare(t, repo, 'lane', files, { tier, tests: false });
    const lines = problems(refused(finalize(repo, 'lane', base, tier, '--not-a-fix', 'x')));
    assert.ok(lines.length >= 1);
    assert.ok(lines.every((l) => /^ {2}- tests: /.test(l)), lines.join('\n'));
    if (tier === 'A') assert.ok(lines.some((l) => /smoke/.test(l)));
  });
}

test('tier C needs the client build and no suites; tier A with suites but no smoke is refused', (t) => {
  const { repo, base } = laneRepo(t, { 'client/src/x.js': 'x\n' });
  ok(cli(repo, 'init', '--branch', 'lane'));
  const { at } = prepare(t, repo, 'lane', ['client/src/x.js'], { tier: 'C' });
  const noBuild = problems(refused(finalize(repo, 'lane', base, 'C', '--not-a-fix', 'x')));
  assert.deepStrictEqual(noBuild.map((l) => l.replace(/ \(.*$/, '')), ['  - tests: no client build recorded; a client/ file in the diff needs one']);
  const logs = tmpDir(t, 'build');
  refused(cli(repo, 'tests', 'lane', '--position', at, '--build', writeFile(logs, 'build.log', 'ok\n')), 2);
  refused(cli(repo, 'tests', 'lane', '--position', at, '--build', writeFile(logs, 'build.log', 'ok\n'), '--exit', 'x'), 2);
  ok(cli(repo, 'tests', 'lane', '--position', at, '--build', writeFile(logs, 'red.log', `Failed to compile. ${MARK}\n`), '--exit', '1'));
  assert.match(problems(refused(finalize(repo, 'lane', base, 'C', '--not-a-fix', 'x')))[0], /the latest client build failed \(exit 1\)/);
  // Exit 0 is not enough: the log must say it compiled, and never Failed to compile.
  assert.match(ok(cli(repo, 'tests', 'lane', '--position', at, '--build', writeFile(logs, 'lies.log', `Failed to compile. ${MARK}\n`), '--exit', '0')).stdout, /recorded the client build: failed \(exit 0, but the log says Failed to compile\)/);
  assert.match(problems(refused(finalize(repo, 'lane', base, 'C', '--not-a-fix', 'x')))[0], /the latest client build failed \(exit 0, but the log says Failed to compile\)/);
  const built = ok(cli(repo, 'tests', 'lane', '--position', at, '--build', writeFile(logs, 'green.log', 'Compiled successfully.\n'), '--exit', '0', '--command', 'CI=true npx react-scripts build'));
  assert.ok(!built.out.includes(MARK));
  const rec = readReceipt(/dir: (\S+)/.exec(ok(finalize(repo, 'lane', base, 'C', '--not-a-fix', 'x')).stdout)[1]);
  assert.deepStrictEqual(rec.tests.map((x) => [x.type, x.ok, x.exit]), [['build', false, 1], ['build', false, 0], ['build', true, 0]]);

  const b = laneRepo(t);
  ok(cli(b.repo, 'init', '--branch', 'lane'));
  const atB = prepare(t, b.repo, 'lane', b.files, { tier: 'A', tests: false }).at;
  ok(cli(b.repo, 'tests', 'lane', '--position', atB, '--suites', suitesRun(t)));
  const lines = problems(refused(finalize(b.repo, 'lane', b.base, 'A', '--not-a-fix', 'x')));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /smoke/);

  const c = laneRepo(t);
  ok(cli(c.repo, 'init', '--branch', 'lane'));
  const atC = prepare(t, c.repo, 'lane', c.files, { tier: 'A', tests: false }).at;
  ok(cli(c.repo, 'tests', 'lane', '--position', atC, '--smoke', smokeRun(t)));
  const noSuites = problems(refused(finalize(c.repo, 'lane', c.base, 'A', '--not-a-fix', 'x')));
  assert.strictEqual(noSuites.length, 1);
  assert.match(noSuites[0], /no reached-suites run recorded; tier A/);
});

test('finalize refuses a kind outside the six, the two kinds only ship writes, and a kind the review mode cannot carry', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  const kind = (k) => cli(repo, 'finalize', 'lane', '--kind', k, '--base', base, '--reviewed-against', base, '--tier', 'B', '--not-a-fix', 'x', '--select', selectFile(repo, 'B'));
  assert.ok(problems(refused(kind('hotfix'))).some((l) => /not one of the six kinds/.test(l)));
  // A refused kind gathers no git facts for the reports, so none is judged against the base.
  for (const k of ['hotfix', 'squash', 'quick-fix']) assert.ok(!problems(refused(kind(k))).some((l) => /^ {2}- (main|stale-base|tier):/.test(l)), k);
  assert.ok(problems(refused(kind('squash'))).some((l) => /merge-lane\.sh ship/.test(l)));
  assert.ok(problems(refused(kind('revert'))).some((l) => /merge-lane\.sh ship/.test(l)));
  assert.ok(problems(refused(kind('quick-fix'))).some((l) => /lane review/.test(l)));
  assert.ok(problems(refused(kind('commit'))).some((l) => /lane review/.test(l)));
  ok(kind('lane'));
});

test('finalize refuses --failing-test whose count disagrees with the log, and records one that agrees', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  const dir = tmpDir(t, 'logs');
  const log = writeFile(dir, 'old.log', tap(3, 2));
  const bad = problems(refused(finalize(repo, 'lane', base, 'B', '--failing-test', 'server/a.test.js:3', '--failing-log', log)));
  assert.strictEqual(bad.length, 1);
  assert.match(bad[0], /# fail line says 2, not 3/);
  const none = writeFile(dir, 'none.log', `no summary here ${MARK}\n`);
  assert.match(problems(refused(finalize(repo, 'lane', base, 'B', '--failing-test', 'server/a.test.js:2', '--failing-log', none)))[0], /no TAP summary/);
  const zero = writeFile(dir, 'zero.log', tap(5, 0));
  assert.match(problems(refused(finalize(repo, 'lane', base, 'B', '--failing-test', 'server/a.test.js:0', '--failing-log', zero)))[0], /count/);
  refused(finalize(repo, 'lane', base, 'B', '--failing-test', 'server/a.test.js:2'), 2);
  refused(finalize(repo, 'lane', base, 'B', '--failing-test', 'server/a.test.js:2', '--failing-log', log, '--not-a-fix', 'x'), 2);
  assert.match(problems(refused(finalize(repo, 'lane', base, 'B')))[0], /--not-a-fix/);
  const r = ok(finalize(repo, 'lane', base, 'B', '--failing-test', 'server/a.test.js:2', '--failing-log', log));
  const rdir = /dir: (\S+)/.exec(r.stdout)[1];
  const rec = readReceipt(rdir);
  assert.deepStrictEqual(rec.failing_test_on_old_code, { file: 'server/a.test.js', count: 2, log: 'tests/failing-on-old-code.log' });
  assert.strictEqual(rec.not_a_fix, null);
  assert.strictEqual(fs.readFileSync(path.join(rdir, 'tests', 'failing-on-old-code.log'), 'utf8'), tap(3, 2));
});

test('finalize refuses --proof with any kind but comment-only, and comment-only without a proof', (t) => {
  const { repo, base, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  const dir = tmpDir(t, 'proof');
  const proof = writeFile(dir, 'proof.txt', `every added line is a comment ${MARK}\n`);
  for (const kind of ['lane', 'quick-fix', 'commit', 'squash', 'revert']) {
    const lines = problems(refused(cli(repo, 'finalize', 'lane', '--kind', kind, '--base', base, '--reviewed-against', base, '--tier', 'B', '--not-a-fix', 'x', '--proof', proof, '--select', selectFile(repo, 'B'))));
    assert.ok(lines.some((l) => /--proof is only for --kind comment-only/.test(l)), `${kind}: ${lines.join('\n')}`);
  }
  assert.ok(problems(refused(cli(repo, 'finalize', 'lane', '--kind', 'comment-only', '--base', base, '--reviewed-against', base, '--tier', 'B'))).some((l) => /needs --proof/.test(l)));
  // The comment-only kind on a real proof: comment-only-proof.test.js is the proof's own suite.
  const lane = commentLane(t);
  const good = proofFile(t, lane.repo, '--base', lane.base, '--tip', lane.tip);
  const co = (file) => cli(lane.repo, 'finalize', 'lane', '--kind', 'comment-only', '--base', lane.base, '--reviewed-against', lane.base, '--tier', 'B', '--proof', file);
  ok(cli(lane.repo, 'init', '--branch', 'lane'));
  const S = (sha) => sha.slice(0, 7);
  const edited = (change) => writeFile(tmpDir(t, 'edited'), 'proof.json', JSON.stringify(change(JSON.parse(fs.readFileSync(good, 'utf8')))));
  const refusals = [
    [proofFile(t, lane.repo, '--base', lane.base, '--tip', lane.mid), `proof: tip ${S(lane.mid)} is not the review's tip ${S(lane.tip)}`],
    [proofFile(t, lane.repo, '--base', lane.mid, '--tip', lane.tip), `proof: base ${S(lane.mid)} is not the review's base ${S(lane.base)}`],
    [stagedProof(t, lane.repo, { 'server/a.js': `// staged\n// what a holds\n${A_JS}` }), 'proof: a staged proof cannot finalize a lane review'],
    [edited((p) => ({ ...p, files: p.files.filter((f) => f.path !== 'server/b.js') })), 'proof: server/b.js is not in the proof'],
    [edited((p) => ({ ...p, ok: false })), 'proof: the proof says not comment-only'],
    [writeFile(tmpDir(t, 'text'), 'proof.json', `every added line is a comment ${MARK}\n`), 'proof: not JSON'],
    [edited((p) => ({ ...p, version: 2 })), 'proof: version 2 is not 1'],
  ];
  for (const [file, line] of refusals) assert.deepStrictEqual(problems(refused(co(file))), [`  - ${line}`]);
  assert.ok(fs.existsSync(workDir('lane', { cwd: lane.repo })), 'a refusal moves nothing');
  // No --select, lens, verify, externals or tests: the proof is the body.
  const r = ok(co(good));
  const rdir = /dir: (\S+)/.exec(r.stdout)[1];
  const rec = readReceipt(rdir);
  assert.strictEqual(rec.kind, 'comment-only');
  assert.strictEqual(rec.key, laneKey(lane.base, lane.tip, { cwd: lane.repo }));
  assert.strictEqual(rec.written_by, 'comment-only proof');
  assert.strictEqual(rec.proof, 'proof.json');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(rdir, 'proof.json'), 'utf8')), JSON.parse(fs.readFileSync(good, 'utf8')));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(good, 'utf8')).skipped, ['README.md']);
  assert.strictEqual(rec.not_a_fix, 'comment-only: the proof shows the diff adds nothing but comment lines');
  assert.deepStrictEqual([rec.lenses, rec.tests, rec.verify.run], [[], [], false]);
  assert.ok(!fs.existsSync(workDir('lane', { cwd: lane.repo })), 'the working directory is gone');
  for (const o of [r.stdout, r.stderr]) assert.ok(!o.includes(MARK));
});

test('finalize never deletes its --proof input, at <work>/proof.json or elsewhere, when the publish fails', (t) => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('root ignores directory permissions');
    return;
  }
  const lane = commentLane(t);
  const good = proofFile(t, lane.repo, '--base', lane.base, '--tip', lane.tip);
  const text = fs.readFileSync(good, 'utf8');
  ok(cli(lane.repo, 'init', '--branch', 'lane'));
  const wd = workDir('lane', { cwd: lane.repo });
  const inWork = path.join(wd, 'proof.json');
  const co = (file) => cli(lane.repo, 'finalize', 'lane', '--kind', 'comment-only', '--base', lane.base, '--reviewed-against', lane.base, '--tier', 'B', '--proof', file);
  // A directory publish cannot read forces the publish to fail (exit 1).
  const blocker = path.join(wd, 'unreadable');
  fs.mkdirSync(blocker);
  fs.copyFileSync(good, inWork);
  let atWork;
  let kept;
  let elsewhere;
  fs.chmodSync(blocker, 0o000);
  try {
    atWork = co(inWork);
    kept = fs.existsSync(inWork) ? fs.readFileSync(inWork, 'utf8') : null;
    fs.rmSync(inWork, { force: true });
    elsewhere = co(good);
  } finally {
    fs.chmodSync(blocker, 0o755);
  }
  assert.strictEqual(atWork.status, 1, atWork.stderr);
  assert.strictEqual(kept, text, 'the --proof input at <work>/proof.json is left as it was');
  assert.strictEqual(elsewhere.status, 1, elsewhere.stderr);
  assert.strictEqual(fs.readFileSync(good, 'utf8'), text, 'the --proof input elsewhere is untouched');
  assert.ok(!fs.existsSync(inWork), 'the copy finalize wrote is removed');
  // The proof at <work>/proof.json itself is left as it was, and publishes.
  fs.rmSync(blocker, { recursive: true });
  fs.copyFileSync(good, inWork);
  const r = ok(co(inWork));
  assert.strictEqual(fs.readFileSync(path.join(/dir: (\S+)/.exec(r.stdout)[1], 'proof.json'), 'utf8'), text);
});

test('a quick fix finalizes comment-only on a staged proof of its staged tree, and refuses a range proof or a stale tree', (t) => {
  const repo = codeRepo(t);
  const head = K.git(repo, 'rev-parse', 'HEAD');
  const parent = commit(repo, 'a comment on main', { 'server/a.js': `// on main\n${A_JS}` });
  const name = /name: (quick-fix-\S+)/.exec(ok(cli(repo, 'init', '--branch', 'main', '--quick-fix')).stdout)[1];
  const range = proofFile(t, repo, '--base', head, '--tip', parent);
  const staged = stagedProof(t, repo, { 'server/b.js': `// staged\n${B_JS}` }, { keep: true });
  const co = (file) => cli(repo, 'finalize', name, '--kind', 'comment-only', '--base', parent, '--reviewed-against', parent, '--tier', 'B', '--proof', file);
  assert.deepStrictEqual(problems(refused(co(range))), ['  - proof: a range proof cannot finalize a quick fix']);
  // Another comment staged after the proof: the staged tree moved.
  fs.writeFileSync(path.join(repo, 'server/a.js'), `// on main, reworded\n${A_JS}`);
  K.git(repo, 'add', '--', 'server/a.js');
  const tree = K.git(repo, 'write-tree');
  const stale = JSON.parse(fs.readFileSync(staged, 'utf8')).tree;
  assert.deepStrictEqual(problems(refused(co(staged))), [`  - proof: tree ${stale.slice(0, 7)} is not the staged tree ${tree.slice(0, 7)}`]);
  const r = ok(co(stagedProof(t, repo, {}, { keep: true })));
  const rec = readReceipt(/dir: (\S+)/.exec(r.stdout)[1]);
  assert.deepStrictEqual([rec.kind, rec.mode, rec.key, rec.proof, rec.written_by], ['comment-only', 'quick-fix', tree, 'proof.json', 'comment-only proof']);
});

test('tests records through the CLI: usage, a refusal and a green log (the recording rules are receiptTests.test.js)', (t) => {
  const { repo } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  const at = position(repo, 'lane');
  const dir = tmpDir(t, 'logs');
  refused(cli(repo, 'tests', 'lane', '--position', at), 2);
  refused(cli(repo, 'tests', 'lane', '--position', at, '--log', 'x', '--smoke', 'y'), 2);
  const skipped = tmpDir(t, 'skip');
  fs.writeFileSync(path.join(skipped, 'summary.json'), JSON.stringify({ suites: [], total_pass: 0, total_fail: 0, skipped: true }));
  assert.match(refused(cli(repo, 'tests', 'lane', '--position', at, '--smoke', skipped)).stderr, /skipped/);
  assert.match(refused(cli(repo, 'tests', 'lane', '--position', at, '--log', writeFile(dir, 'b.log', tap(2, 1)))).stderr, /1 failing/);
  ok(cli(repo, 'tests', 'lane', '--position', at, '--log', writeFile(dir, 'scripts-lib-receipt.test.js.ab12cd.log', tap(7)), '--command', 'node --test scripts/lib/receipt.test.js'));
  ok(cli(repo, 'tests', 'lane', '--position', at, '--smoke', smokeRun(t)));
  const rec = readReceipt(workDir('lane', { cwd: repo }));
  assert.deepStrictEqual(rec.tests.map((x) => [x.type, x.pass]), [['log', 7], ['smoke', 15]]);
  assert.ok(fs.existsSync(path.join(workDir('lane', { cwd: repo }), rec.tests[0].log)));
});

test('show finds a receipt by branch through the index after the key changed', (t) => {
  const { repo, base, tip, files } = laneRepo(t);
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x'));
  const k1 = laneKey(base, tip, { cwd: repo });
  const tip2 = commit(repo, 'post-merge-check fix', { 'server/a.js': 'a v3\n' });
  ok(cli(repo, 'init', '--branch', 'lane'));
  prepare(t, repo, 'lane', files);
  ok(finalize(repo, 'lane', base, 'B', '--not-a-fix', 'x'));
  const k2 = laneKey(base, tip2, { cwd: repo });
  assert.notStrictEqual(k2, k1);
  const byBranch = ok(cli(repo, 'show', 'lane'));
  assert.ok(byBranch.stdout.includes(`receipt ${k2}`));
  assert.ok(byBranch.stdout.includes(receiptDir(k2, { cwd: repo })));
  assert.ok(ok(cli(repo, 'show', k1)).stdout.includes(`receipt ${k1}`));
  refused(cli(repo, 'show', 'no-such-branch'));
});

test('an unknown subcommand or a missing argument is a usage error', (t) => {
  const { repo } = laneRepo(t);
  refused(cli(repo), 2);
  refused(cli(repo, 'frobnicate'), 2);
  refused(cli(repo, 'verdicts', 'lane'), 2);
  refused(cli(repo, 'finalize', 'lane', '--kind', 'lane'), 2);
  refused(cli(repo, 'finalize', 'lane', '--kind', 'lane', '--base', 'main', '--reviewed-against', 'main', '--tier', 'Z', '--not-a-fix', 'x'), 2);
});
