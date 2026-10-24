'use strict';

// Tests for scripts/lib/rangeCheck.js (instruction rewrite step 3, lane
// range-check, check 1). Every case runs in a throwaway repo under the temp
// dir, removed when the test ends. The throwaway carries its own copy of the
// scripts (kept out of git through .git/info/exclude), with its own sensitive
// list, so the tier the check recomputes is the throwaway's; its receipts are
// written through that copy's review-receipt CLI, and the kinds finalize does
// not write (revert, comment-only) and the tampered cases through receipt.js.
// A local bare origin stands in where origin/main matters. Nothing here
// touches the real repo, its common dir or the dev database.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { smokeSummary } = require('./tapSummary');

const SCRIPTS = path.resolve(__dirname, '..');
// A string that stands for anything a lens or a log could say: it may be
// stored, never printed.
const MARK = 'STORED-ONLY-7f3a';
const FLOORS = {
  A: ['money', 'lifecycle', 'concurrency', 'outcomes-providers', 'access-egress', 'seams'],
  B: ['seams'],
  C: ['client', 'seams'],
};
const FULL_SHA = /[0-9a-f]{40}/;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tempRoot(t, label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `range-check-${label}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFiles(repo, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function commit(repo, message, files) {
  writeFiles(repo, files);
  git(repo, 'add', '--', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

// The scripts the check and the CLI load, copied into <repo>/scripts, with
// the throwaway's own sensitive list.
function copyScripts(repo) {
  const lib = path.join(repo, 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of ['sensitive-match.js', 'review-receipt.js']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(repo, 'scripts', f));
  for (const f of fs.readdirSync(path.join(SCRIPTS, 'lib'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) fs.copyFileSync(path.join(SCRIPTS, 'lib', f), path.join(lib, f));
  }
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/scripts/\n');
}

function setList(h, lines) {
  fs.writeFileSync(path.join(h.repo, 'scripts', 'sensitive-paths.txt'), ['# The throwaway list.', ...lines, ''].join('\n'));
}

// A repo on main with a seed commit pushed to a local bare origin.
function makeRepo(t, { list = ['server/money.js'] } = {}) {
  const root = tempRoot(t, 'repo');
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(repo);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', ['test', 'example.com'].join('@'));
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'commit.gpgsign', 'false');
  copyScripts(repo);
  const h = { root, repo, lanes: 0 };
  setList(h, list);
  h.seed = commit(repo, 'seed', { 'README.md': 'readme\n', 'docs/notes.md': 'notes\n', 'server/a.js': 'a v1\n', 'server/b.js': 'b v1\n' });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  h.R = require(path.join(repo, 'scripts', 'lib', 'receipt.js'));
  h.check = (base, tip = 'HEAD') => require(path.join(repo, 'scripts', 'lib', 'rangeCheck.js')).checkRange({ base, tip, cwd: repo });
  return h;
}

function cli(h, ...args) {
  const r = spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'review-receipt.js'), ...args], { cwd: h.repo, encoding: 'utf8', env: { ...process.env, REVIEW_RECEIPT_ROOT: h.repo } });
  assert.equal(r.status, 0, `review-receipt ${args[0]} exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r.stdout;
}

function report(rows, findings = []) {
  return [`Read the brief. ${MARK}`, '', ...findings, '', '| file | verdict | note |', '|---|---|---|', ...rows.map(([f, v, n = '']) => `| ${f} | ${v} | ${n} |`), ''].join('\n');
}

function tap(pass, fail = 0, cancelled = 0) {
  return ['TAP version 13', `# ${MARK} something the suite printed`, `ok 1 - a test # ${MARK}`, `1..${pass + fail}`, `# tests ${pass + fail}`, '# suites 0',
    `# pass ${pass}`, `# fail ${fail}`, `# cancelled ${cancelled}`, '# skipped 0', '# todo 0', '# duration_ms 5', ''].join('\n');
}

// A runner directory in the shape run-suites and testdb-smoke write.
function runDir(h, suites) {
  const dir = fs.mkdtempSync(path.join(h.root, 'run-'));
  const summary = smokeSummary(suites.map((s) => ({ file: s.file, text: s.text, exitOk: true })));
  for (const s of suites) {
    const entry = summary.suites.find((e) => e.file === s.file);
    fs.writeFileSync(path.join(dir, entry.log), s.text);
    fs.writeFileSync(path.join(dir, entry.out), `${MARK}\n`);
  }
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  return dir;
}

function scratch(h, name, text) {
  const dir = path.join(h.root, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}-${name}`);
  fs.writeFileSync(p, text);
  return p;
}

// The per-file tiers review-select would compute, through the copy.
function selectFile(h, tier, range) {
  const SM = require(path.join(h.repo, 'scripts', 'sensitive-match.js'));
  const tiers = range.staged ? SM.tierFromGit({ staged: true }, { cwd: h.repo }) : SM.tierFromGit(range, { cwd: h.repo });
  return scratch(h, 'select.json', JSON.stringify({ tier, tiers_by_file: tiers.tiersByFile }));
}

// Stores the reports, tests, verify and externals of a review named `name`
// at one position. `reports(lens)` returns [file, markdown] pairs per pass,
// the first the first pass; `triage` is [report, id, status].
function review(h, name, files, { tier, reports, triage = [], client = false }) {
  const seq = /^position (\d+) /m.exec(cli(h, 'position', name))[1];
  for (const lens of FLOORS[tier]) {
    const passes = reports ? reports(lens) : null;
    const list = passes || [report(files.map((f) => [f, 'pass']))];
    list.forEach((text, i) => cli(h, 'verdicts', name, lens, scratch(h, `${lens}.md`, text), '--position', seq, ...(i ? ['--pass', String(i)] : [])));
  }
  for (const [rep, id, status] of triage) cli(h, 'triage', name, rep, id, status, '--reason', `${MARK} a reason`);
  if (tier === 'A' || tier === 'B') cli(h, 'tests', name, '--suites', runDir(h, [{ file: 'server/a.test.js', text: tap(4) }]), '--position', seq);
  if (tier === 'A') {
    cli(h, 'tests', name, '--smoke', runDir(h, [{ file: 'server/m1.test.js', text: tap(10) }, { file: 'server/m2.test.js', text: tap(5) }]), '--position', seq);
    cli(h, 'verify', name, scratch(h, 'verify.md', `No findings.\nChecked the lane. ${MARK}\n`), '--position', seq);
    cli(h, 'externals', name, 'codex=run', `gemini=not_run:quota ${MARK}`);
  }
  if (client) cli(h, 'tests', name, '--build', scratch(h, 'build.log', `Compiled successfully.\n${MARK}\n`), '--exit', '0', '--position', seq);
}

function receiptAt(stdout) {
  return /dir: (\S+)/.exec(stdout)[1];
}

// A lane commit off main, reviewed at `tier` through the CLI and finalized,
// then main fast-forwarded onto it -> {sha, dir, key}.
function landLane(h, files, opts = {}) {
  const { tier = 'B', allowNotReached = false } = opts;
  const lane = `lane-${++h.lanes}`;
  const base = git(h.repo, 'rev-parse', 'main');
  git(h.repo, 'checkout', '-q', '-b', lane);
  const sha = commit(h.repo, opts.message || `${lane} work`, files);
  cli(h, 'init', '--branch', lane);
  review(h, lane, Object.keys(files).filter((f) => f !== 'README.md'), { ...opts, tier });
  const out = cli(h, 'finalize', lane, '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', tier,
    '--select', selectFile(h, tier, { base, tip: sha }), '--not-a-fix', 'a feature', ...(allowNotReached ? ['--allow-not-reached'] : []));
  git(h.repo, 'checkout', '-q', 'main');
  git(h.repo, 'merge', '-q', '--ff-only', lane);
  const dir = receiptAt(out);
  return { sha, dir, key: path.basename(dir) };
}

function edit(h, dir, fn) {
  const rec = h.R.readReceipt(dir);
  fn(rec);
  h.R.writeReceipt(dir, rec);
}

// The problems of one commit, and the leak checks every refusal runs: no
// stored text and no full sha in any problem.
function problemsOf(res, sha) {
  for (const p of res.problems) {
    assert.ok(!p.includes(MARK), `a stored text leaked: ${p}`);
    assert.ok(!FULL_SHA.test(p), `a full sha leaked: ${p}`);
  }
  const c = res.commits.find((x) => x.sha === sha);
  assert.ok(c, `no entry for ${sha.slice(0, 7)}`);
  return c.problems;
}

function refusedWith(res, sha, ...needles) {
  assert.equal(res.ok, false);
  const ps = problemsOf(res, sha);
  const hit = ps.find((p) => needles.every((n) => p.includes(n)));
  assert.ok(hit, `no problem naming ${needles.join(', ')} in:\n${ps.join('\n')}`);
  assert.ok(hit.startsWith(`${sha.slice(0, 7)}: `), hit);
  return hit;
}

function passes(res) {
  assert.deepEqual(res.problems, []);
  assert.equal(res.ok, true);
}

// ---- docs-only and missing receipts ---------------------------------------------

test('a docs-only commit needs no receipt', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  const res = h.check(h.seed);
  passes(res);
  assert.equal(res.docs_only, true);
  assert.deepEqual(res.commits.map((c) => [c.sha, c.docs_only, c.receipt_key]), [[sha, true, null]]);
});

test('a server/ commit with no receipt is a problem naming its sha', (t) => {
  const h = makeRepo(t);
  const docs = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  const sha = commit(h.repo, 'server work', { 'server/a.js': 'a v2\n' });
  const res = h.check(h.seed);
  refusedWith(res, sha, 'no review receipt');
  assert.deepEqual(problemsOf(res, docs), []);
  assert.equal(res.docs_only, false);
});

test('an empty commit is not docs-only and needs a receipt', (t) => {
  const h = makeRepo(t);
  git(h.repo, 'commit', '-q', '--allow-empty', '-m', 'empty');
  const sha = git(h.repo, 'rev-parse', 'HEAD');
  const res = h.check(h.seed);
  assert.equal(res.commits[0].docs_only, false);
  refusedWith(res, sha, 'no review receipt');
});

test('a base that does not resolve is a problem, never a pass', (t) => {
  const h = makeRepo(t);
  const res = h.check('refs/heads/no-such-branch');
  assert.equal(res.ok, false);
  assert.equal(res.commits.length, 0);
  assert.ok(res.problems.some((p) => p.startsWith('base: ')), res.problems.join('\n'));
});

// ---- receipts that pass ------------------------------------------------------------

test('a commit with a lane receipt under its commit key whose tables pass passes', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' });
  assert.equal(lane.key, h.R.commitKey(lane.sha, { cwd: h.repo }));
  const res = h.check(h.seed);
  passes(res);
  assert.deepEqual(res.commits.map((c) => [c.sha, c.kind, c.receipt_key, c.docs_only]), [[lane.sha, 'lane', lane.key, false]]);
});

test('a quick-fix receipt under the commit tree passes', (t) => {
  const h = makeRepo(t);
  writeFiles(h.repo, { 'server/a.js': 'a fixed\n' });
  git(h.repo, 'add', '--', 'server/a.js');
  const name = /name: (\S+)/.exec(cli(h, 'init', '--branch', 'main', '--quick-fix'))[1];
  review(h, name, ['server/a.js'], { tier: 'B' });
  const head = git(h.repo, 'rev-parse', 'HEAD');
  const dir = receiptAt(cli(h, 'finalize', name, '--kind', 'quick-fix', '--base', head, '--reviewed-against', head, '--tier', 'B',
    '--not-a-fix', 'copy', '--select', selectFile(h, 'B', { staged: true })));
  git(h.repo, 'commit', '-q', '-m', 'quick fix');
  const sha = git(h.repo, 'rev-parse', 'HEAD');
  const res = h.check(h.seed);
  passes(res);
  assert.equal(res.commits[0].kind, 'quick-fix');
  assert.equal(res.commits[0].receipt_key, git(h.repo, 'rev-parse', `${sha}^{tree}`));
  assert.equal(path.basename(dir), res.commits[0].receipt_key);
});

// ---- the tables, read again ------------------------------------------------------

test('tables that leave a diff file out are a problem naming the file, whatever files_in_diff says', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' });
  assert.deepEqual(h.R.readReceipt(lane.dir).coverage.files_in_diff, ['server/a.js', 'server/b.js']);
  fs.writeFileSync(path.join(lane.dir, 'seams.md'), report([['server/a.js', 'pass']]));
  refusedWith(h.check(h.seed), lane.sha, 'seams', 'server/b.js', 'no verdict');
});

test('a not reached row is a problem unless the receipt allowed it', (t) => {
  const h = makeRepo(t);
  const missed = report([['server/a.js', 'pass'], ['server/b.js', 'not reached']]);
  const lane = landLane(h, { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' }, {
    allowNotReached: true,
    reports: () => [missed, report([['server/b.js', 'not reached']])],
  });
  const rec = h.R.readReceipt(lane.dir);
  assert.equal(rec.coverage.allowed_not_reached, true);
  passes(h.check(h.seed));
  edit(h, lane.dir, (r) => { r.coverage.allowed_not_reached = false; });
  refusedWith(h.check(h.seed), lane.sha, 'seams', 'server/b.js', 'not reached');
});

test('a finding row whose ids are all rejected passes; one with an id neither fixed nor rejected is a problem naming the file and the id', (t) => {
  const h = makeRepo(t);
  const found = report([['server/a.js', 'finding', 'M1'], ['server/b.js', 'pass']], ['- M1 `server/a.js:1` the line reads wrong. Check: the caller.']);
  const ok = landLane(h, { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' }, { reports: () => [found], triage: [['seams.md', 'M1', 'rejected']] });
  passes(h.check(h.seed));
  const open = landLane(h, { 'server/a.js': 'a v3\n', 'server/b.js': 'b v3\n' }, { reports: () => [found], triage: [['seams.md', 'M1', 'confirmed']] });
  const res = h.check(h.seed);
  assert.deepEqual(problemsOf(res, ok.sha), []);
  refusedWith(res, open.sha, 'seams', 'server/a.js', 'M1', 'neither fixed nor rejected');
});

test('every finding a report raised must be fixed or rejected, whether or not a row names it', (t) => {
  const h = makeRepo(t);
  const two = report([['server/a.js', 'finding', 'M1'], ['server/b.js', 'pass']],
    ['- M1 `server/a.js:1` the line reads wrong. Check: the caller.', '- M2 `server/a.js:1` a second reading. Check: the caller.']);
  const lane = landLane(h, { 'server/a.js': 'a v2\n', 'server/b.js': 'b v2\n' }, { reports: () => [two], triage: [['seams.md', 'M1', 'rejected'], ['seams.md', 'M2', 'confirmed']] });
  const hit = refusedWith(h.check(h.seed), lane.sha, 'seams', 'M2', 'seams.md', 'server/a.js', 'neither fixed nor rejected');
  assert.ok(!hit.includes('M1'), hit);
  edit(h, lane.dir, (r) => { r.triage['seams.md#M2'].status = 'rejected'; });
  passes(h.check(h.seed));
  const under = report([['server/a.js', 'pass'], ['server/b.js', 'pass']], ['- M1 `server/a.js:1` the line reads wrong. Check: the caller.']);
  const quiet = landLane(h, { 'server/a.js': 'a v3\n', 'server/b.js': 'b v3\n' }, { reports: () => [under], triage: [['seams.md', 'M1', 'confirmed']] });
  refusedWith(h.check(h.seed), quiet.sha, 'seams', 'M1', 'server/a.js', 'neither fixed nor rejected');
});

test('a malformed lens report stands only when a later well-formed report of its lens follows it; a malformed verify report never does', (t) => {
  const h = makeRepo(t);
  const good = report([['server/a.js', 'pass']]);
  const broken = `Read the brief. ${MARK}\nNo table here.\n`;
  const last = landLane(h, { 'server/a.js': 'a v2\n' }, { reports: () => [good, broken] });
  refusedWith(h.check(h.seed), last.sha, 'seams report seams.pass-1.md', 'malformed');
  const healed = landLane(h, { 'server/a.js': 'a v3\n' }, { reports: () => [good, broken, good] });
  assert.deepEqual(problemsOf(h.check(h.seed), healed.sha), []);
  const vh = makeRepo(t);
  const lane = landLane(vh, { 'server/money.js': 'm v1\n' }, { tier: 'A' });
  passes(vh.check(vh.seed));
  fs.writeFileSync(path.join(lane.dir, 'verify.md'), `Looked it over. ${MARK}\n`);
  fs.writeFileSync(path.join(lane.dir, 'verify.pass-1.md'), 'No findings.\n');
  edit(vh, lane.dir, (r) => { r.reports.push({ file: 'verify.pass-1.md', lens: 'verify', seq: Math.max(...r.reports.map((x) => x.seq)) + 1, pass: 1 }); });
  refusedWith(vh.check(vh.seed), lane.sha, 'verify report verify.md');
});

test('an escalate row is a problem', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/money.js': 'm v1\n' }, {
    tier: 'A',
    reports: (lens) => (lens === 'money' ? [report([['server/money.js', 'escalate', 'needs a human read']])] : null),
  });
  refusedWith(h.check(h.seed), lane.sha, 'money', 'escalates', 'server/money.js');
});

// ---- the tier, recomputed --------------------------------------------------------

test('a tier A commit whose receipt is tier B is a problem naming both tiers', (t) => {
  const h = makeRepo(t, { list: [] });
  const lane = landLane(h, { 'server/money.js': 'm v1\n' });
  passes(h.check(h.seed));
  // The list gains the path after the review: the check reads the list as it stands.
  setList(h, ['server/money.js']);
  refusedWith(h.check(h.seed), lane.sha, 'tier A', 'tier B');
});

// ---- the tests, read again -------------------------------------------------------

test('a tier A receipt with no smoke entry, or a smoke summary that says skipped or did not run, is a problem', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/money.js': 'm v1\n' }, { tier: 'A' });
  passes(h.check(h.seed));
  const smoke = h.R.readReceipt(lane.dir).tests.find((x) => x.type === 'smoke');
  const file = path.join(lane.dir, smoke.log);
  const green = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(green), skipped: true }));
  refusedWith(h.check(h.seed), lane.sha, 'smoke', 'skipped');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(green), did_not_run: 'no key' }));
  refusedWith(h.check(h.seed), lane.sha, 'smoke', 'did not run');
  fs.writeFileSync(file, green);
  passes(h.check(h.seed));
  edit(h, lane.dir, (r) => { r.tests = r.tests.filter((x) => x.type !== 'smoke'); });
  refusedWith(h.check(h.seed), lane.sha, 'tier A and no smoke entry');
});

test('a verify report that is empty, or prose with no finding and no No findings record, is a problem naming it', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/money.js': 'm v1\n' }, { tier: 'A' });
  passes(h.check(h.seed));
  const file = path.join(lane.dir, 'verify.md');
  const green = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '');
  refusedWith(h.check(h.seed), lane.sha, 'verify report verify.md');
  fs.writeFileSync(file, `Read the lane and it looks fine. ${MARK}\n`);
  refusedWith(h.check(h.seed), lane.sha, 'verify report verify.md');
  fs.writeFileSync(file, green);
  passes(h.check(h.seed));
});

test('a smoke log with cancelled above 0 is a problem naming the log, whatever its summary says', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/money.js': 'm v1\n' }, { tier: 'A' });
  const entry = h.R.readReceipt(lane.dir).tests.find((x) => x.type === 'smoke');
  assert.equal(JSON.parse(fs.readFileSync(path.join(lane.dir, entry.log), 'utf8')).total_fail, 0);
  const log = entry.suites[0].log;
  fs.writeFileSync(path.join(lane.dir, log), tap(10, 0, 3));
  refusedWith(h.check(h.seed), lane.sha, 'smoke log', path.basename(log), 'cancelled 3');
});

test('a suites summary that says total_fail 0 while a suite log says fail 1 is a problem: the log wins', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const entry = h.R.readReceipt(lane.dir).tests.find((x) => x.type === 'suites');
  assert.equal(JSON.parse(fs.readFileSync(path.join(lane.dir, entry.log), 'utf8')).total_fail, 0);
  fs.writeFileSync(path.join(lane.dir, entry.suites[0].log), tap(3, 1));
  refusedWith(h.check(h.seed), lane.sha, 'suites', 'server/a.test.js', 'fail 1');
});

test('a client/ file with no build entry is a problem', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'client/src/x.js': 'x v1\n' }, { tier: 'C', client: true });
  passes(h.check(h.seed));
  edit(h, lane.dir, (r) => { r.tests = r.tests.filter((x) => x.type !== 'build'); });
  refusedWith(h.check(h.seed), lane.sha, 'client/', 'no build entry');
});

test('a receipt that is not final is a problem', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  edit(h, lane.dir, (r) => { r.state = 'working'; });
  refusedWith(h.check(h.seed), lane.sha, 'not final', lane.key.slice(0, 7));
});

// ---- revert and comment-only -----------------------------------------------------

function revertReceipt(h, sha, extra = {}) {
  const key = h.R.commitKey(sha, { cwd: h.repo });
  h.R.writeReceipt(h.R.receiptDir(key, { cwd: h.repo }), { version: 1, state: 'final', key, kind: 'revert', tier: 'B', written_by: 'ship', ...extra });
  return key;
}

test('a revert receipt passes with no tables when the tree is the reverse-applied parent tree, and is a problem when it is not', (t) => {
  const h = makeRepo(t);
  const shipped = landLane(h, { 'server/a.js': 'a v2\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  git(h.repo, 'fetch', '-q', 'origin');
  git(h.repo, 'revert', '--no-edit', shipped.sha);
  const clean = git(h.repo, 'rev-parse', 'HEAD');
  revertReceipt(h, clean, { reverted: shipped.sha });
  const res = h.check('origin/main');
  passes(res);
  assert.equal(res.commits[0].kind, 'revert');
  // A hand edit rides on the revert: the message still says it reverts.
  git(h.repo, 'reset', '-q', '--hard', 'origin/main');
  git(h.repo, 'revert', '--no-edit', '--no-commit', shipped.sha);
  writeFiles(h.repo, { 'server/b.js': 'b by hand\n' });
  git(h.repo, 'add', '--', 'server/b.js');
  git(h.repo, 'commit', '-q', '--no-edit');
  const edited = git(h.repo, 'rev-parse', 'HEAD');
  assert.match(git(h.repo, 'log', '-1', '--format=%B'), /This reverts commit/);
  revertReceipt(h, edited);
  refusedWith(h.check('origin/main'), edited, shipped.sha.slice(0, 7), 'reverted on its parent');
});

test('a revert of a commit that never shipped is a problem', (t) => {
  const h = makeRepo(t);
  const local = landLane(h, { 'server/a.js': 'a v2\n' });
  git(h.repo, 'revert', '--no-edit', local.sha);
  const sha = git(h.repo, 'rev-parse', 'HEAD');
  revertReceipt(h, sha);
  refusedWith(h.check('origin/main'), sha, local.sha.slice(0, 7), 'not on origin/main');
});

test('a revert of a revert is refused as a change; the plain revert passes', (t) => {
  const h = makeRepo(t);
  const shipped = landLane(h, { 'server/a.js': 'a v2\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  git(h.repo, 'fetch', '-q', 'origin');
  git(h.repo, 'revert', '--no-edit', shipped.sha);
  const first = git(h.repo, 'rev-parse', 'HEAD');
  revertReceipt(h, first);
  passes(h.check('origin/main'));
  git(h.repo, 'push', '-q', 'origin', 'main');
  git(h.repo, 'fetch', '-q', 'origin');
  git(h.repo, 'revert', '--no-edit', first);
  const again = git(h.repo, 'rev-parse', 'HEAD');
  revertReceipt(h, again);
  refusedWith(h.check('origin/main'), again, first.slice(0, 7), 'itself a revert', 'lane or quick-fix receipt');
});

test('revertProof agrees with checkRange on a clean revert, a hand-edited one and a revert of a revert', (t) => {
  const h = makeRepo(t);
  const proof = (sha) => require(path.join(h.repo, 'scripts', 'lib', 'rangeCheck.js')).revertProof(sha, { cwd: h.repo });
  const shipped = landLane(h, { 'server/a.js': 'a v2\n' });
  git(h.repo, 'push', '-q', 'origin', 'main');
  git(h.repo, 'fetch', '-q', 'origin');
  git(h.repo, 'revert', '--no-edit', shipped.sha);
  const clean = git(h.repo, 'rev-parse', 'HEAD');
  const key = revertReceipt(h, clean, { reverted: shipped.sha });
  assert.deepEqual(proof(clean), { ok: true, reverted: shipped.sha, problems: [] });
  passes(h.check('origin/main'));
  // The receipt's own reverted field stays the range check's: a receipt that
  // names another commit is refused though the proof holds.
  edit(h, h.R.receiptDir(key, { cwd: h.repo }), (r) => { r.reverted = h.seed; });
  const named = refusedWith(h.check('origin/main'), clean, 'the receipt names', h.seed.slice(0, 7));
  assert.ok(named.includes(`the message names ${shipped.sha.slice(0, 7)}`), named);
  assert.equal(proof(clean).ok, true);
  // A hand edit rides on the revert.
  git(h.repo, 'reset', '-q', '--hard', 'origin/main');
  git(h.repo, 'revert', '--no-edit', '--no-commit', shipped.sha);
  writeFiles(h.repo, { 'server/b.js': 'b by hand\n' });
  git(h.repo, 'add', '--', 'server/b.js');
  git(h.repo, 'commit', '-q', '--no-edit');
  const edited = git(h.repo, 'rev-parse', 'HEAD');
  revertReceipt(h, edited);
  const hand = proof(edited);
  assert.equal(hand.ok, false);
  assert.equal(hand.reverted, shipped.sha);
  assert.match(hand.problems[0], /reverted on its parent/);
  assert.deepEqual(hand.problems, problemsOf(h.check('origin/main'), edited));
  // A revert of a revert.
  git(h.repo, 'reset', '-q', '--hard', 'origin/main');
  git(h.repo, 'revert', '--no-edit', shipped.sha);
  const first = git(h.repo, 'rev-parse', 'HEAD');
  revertReceipt(h, first);
  git(h.repo, 'push', '-q', 'origin', 'main');
  git(h.repo, 'fetch', '-q', 'origin');
  git(h.repo, 'revert', '--no-edit', first);
  const again = git(h.repo, 'rev-parse', 'HEAD');
  revertReceipt(h, again);
  const twice = proof(again);
  assert.equal(twice.ok, false);
  assert.equal(twice.reverted, first);
  assert.match(twice.problems[0], /itself a revert/);
  assert.deepEqual(twice.problems, problemsOf(h.check('origin/main'), again));
  // A commit whose message names no reverted commit, and a ref that names no commit.
  const plain = proof(shipped.sha);
  assert.deepEqual([plain.ok, plain.reverted], [false, null]);
  assert.match(plain.problems[0], /names no reverted commit/);
  assert.deepEqual([proof('refs/heads/no-such-branch').ok, proof('refs/heads/no-such-branch').reverted], [false, null]);
});

test('a revert of a revert whose commit key holds a twin\'s revert receipt is judged by its tree\'s quick-fix receipt; with none there, the problem names the twin', (t) => {
  const h = makeRepo(t);
  const a = landLane(h, { 'server/a.js': 'a v2\n' });
  // X1 reverts A; ship's revert receipt for it names X1 as its tip.
  git(h.repo, 'revert', '--no-edit', a.sha);
  const x1 = git(h.repo, 'rev-parse', 'HEAD');
  revertReceipt(h, x1, { tip: x1, reverted: a.sha });
  // Y reverts X1 (A's lines again); A, X1 and Y ship.
  git(h.repo, 'revert', '--no-edit', x1);
  git(h.repo, 'push', '-q', 'origin', 'main');
  git(h.repo, 'fetch', '-q', 'origin');
  const y = git(h.repo, 'rev-parse', 'HEAD');
  // W reverts Y, a revert of a revert, committed as a quick fix: its review
  // keys the staged tree, and its patch is X1's.
  git(h.repo, 'revert', '--no-edit', '--no-commit', y);
  const name = /name: (\S+)/.exec(cli(h, 'init', '--branch', 'main', '--quick-fix'))[1];
  review(h, name, ['server/a.js'], { tier: 'B' });
  const tree = path.basename(receiptAt(cli(h, 'finalize', name, '--kind', 'quick-fix', '--base', y, '--reviewed-against', y, '--tier', 'B',
    '--not-a-fix', 'a revert of a revert', '--select', selectFile(h, 'B', { staged: true }))));
  git(h.repo, 'commit', '-q', '--no-edit');
  const w = git(h.repo, 'rev-parse', 'HEAD');
  assert.equal(h.R.commitKey(w, { cwd: h.repo }), h.R.commitKey(x1, { cwd: h.repo }), 'W and X1 share a patch id');
  assert.equal(git(h.repo, 'rev-parse', `${w}^{tree}`), tree);
  const res = h.check('origin/main');
  passes(res);
  assert.deepEqual([res.commits[0].kind, res.commits[0].receipt_key], ['quick-fix', tree]);
  // With no receipt under the tree, the problem names the twin.
  const dir = h.R.receiptDir(tree, { cwd: h.repo });
  fs.renameSync(dir, `${dir}.aside`);
  const hit = refusedWith(h.check('origin/main'), w, 'no review receipt of its own', `holds the revert receipt of ${x1.slice(0, 7)}`, 'another commit with the same patch');
  assert.ok(hit.endsWith('it needs its own receipt'), hit);
});

test('a comment-only receipt with a proof file passes, and one without is a problem', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'comments', { 'server/a.js': 'a v1\n// a comment\n' });
  const key = h.R.commitKey(sha, { cwd: h.repo });
  const dir = h.R.receiptDir(key, { cwd: h.repo });
  h.R.writeReceipt(dir, { version: 1, state: 'final', key, kind: 'comment-only', tier: 'B', proof: 'proof.txt', written_by: 'comment-only proof' });
  refusedWith(h.check(h.seed), sha, 'comment-only', 'no proof file');
  fs.writeFileSync(path.join(dir, 'proof.txt'), `${MARK}\n`);
  const res = h.check(h.seed);
  passes(res);
  assert.equal(res.commits[0].kind, 'comment-only');
});

// ---- merges and the pii scan -----------------------------------------------------

test('a merge commit in the range is a problem', (t) => {
  const h = makeRepo(t);
  git(h.repo, 'checkout', '-q', '-b', 'side');
  commit(h.repo, 'side notes', { 'docs/side.md': 'side\n' });
  git(h.repo, 'checkout', '-q', 'main');
  commit(h.repo, 'main notes', { 'docs/notes.md': 'notes v2\n' });
  git(h.repo, 'merge', '-q', '--no-ff', '--no-edit', 'side');
  const merge = git(h.repo, 'rev-parse', 'HEAD');
  const res = h.check(h.seed);
  refusedWith(res, merge, 'a merge commit');
  assert.equal(res.commits.filter((c) => c.problems.length).length, 1);
});

test('a range whose diff adds a token-shaped line is a pii problem naming the file and line, never the text', (t) => {
  const h = makeRepo(t);
  const run = ['ab12', 'cd34'].join('').repeat(5);
  commit(h.repo, 'notes', { 'docs/notes.md': `notes\nthe key ${run}\n` });
  const res = h.check(h.seed);
  assert.equal(res.ok, false);
  assert.deepEqual(res.pii, [{ file: 'docs/notes.md', line: 2, shape: 'TOKEN' }]);
  assert.deepEqual(res.range_problems, ['pii: docs/notes.md line 2 adds a TOKEN-shaped run']);
  assert.ok(!JSON.stringify(res).includes(run));
});

test('a token-shaped line added and removed again inside the range is a pii problem naming the commit that added it', (t) => {
  const h = makeRepo(t);
  const run = ['ab12', 'cd34'].join('').repeat(5);
  const added = commit(h.repo, 'notes', { 'docs/notes.md': `notes\nthe key ${run}\n` });
  const removed = commit(h.repo, 'notes again', { 'docs/notes.md': 'notes\n' });
  const res = h.check(h.seed);
  assert.deepEqual(res.pii, [], 'the range-level diff no longer carries it');
  assert.equal(refusedWith(res, added, 'pii: docs/notes.md line 2', 'TOKEN'), `${added.slice(0, 7)}: pii: docs/notes.md line 2 adds a TOKEN-shaped run`);
  assert.deepEqual(problemsOf(res, removed), []);
  assert.ok(!JSON.stringify(res).includes(run));
  const clean = makeRepo(t);
  commit(clean.repo, 'notes', { 'docs/notes.md': 'notes\nthe key is elsewhere\n' });
  commit(clean.repo, 'notes again', { 'docs/notes.md': 'notes\n' });
  passes(clean.check(clean.seed));
});

test('a phone-shaped run in a commit message, subject or body, is a problem naming the shape; a plain message and the attribution trailers pass', (t) => {
  const h = makeRepo(t);
  const phone = ['415', '738', '2916'].join('-');
  const inSubject = commit(h.repo, `notes for ${phone}`, { 'docs/notes.md': 'notes v2\n' });
  const inBody = commit(h.repo, `notes again\n\ncall ${phone} first`, { 'docs/notes.md': 'notes v3\n' });
  const res = h.check(h.seed);
  for (const sha of [inSubject, inBody]) {
    const hit = refusedWith(res, sha, 'commit message', 'PHONE');
    assert.ok(!hit.includes(phone) && !hit.includes('2916'), hit);
  }
  assert.ok(!JSON.stringify(res).includes(phone));
  const clean = makeRepo(t);
  const trailers = `notes\n\nCo-Authored-By: Claude Opus 5.5 <${['noreply', 'anthropic.com'].join('@')}>\nClaude-Session: ${['0f1e2d3c', '4b5a', '4978', '8695', 'a4b3c2d1e0f9'].join('-')}`;
  commit(clean.repo, trailers, { 'docs/notes.md': 'notes v2\n' });
  passes(clean.check(clean.seed));
});

// ---- the CLI ----------------------------------------------------------------------

test('the CLI prints one line per commit and the problems, sha7 only, exit 1 on any and 0 clean', (t) => {
  const h = makeRepo(t);
  const docs = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const run = (range) => spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'lib', 'rangeCheck.js'), range], { cwd: h.repo, encoding: 'utf8' });
  const clean = run(`${h.seed}..HEAD`);
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(clean.stdout.trim().split('\n'), [
    `${docs.slice(0, 7)} docs-only: notes`,
    `${lane.sha.slice(0, 7)} lane receipt ${lane.key.slice(0, 7)}: lane-1 work`,
    'range-check: 2 commit(s), 1 docs-only, 1 with a receipt; ok',
  ]);
  const bad = commit(h.repo, 'server work', { 'server/b.js': 'b v2\n' });
  const refused = run(`${h.seed}..HEAD`);
  assert.equal(refused.status, 1);
  const lines = refused.stdout.trim().split('\n');
  assert.equal(lines[2], `${bad.slice(0, 7)} no receipt, refused: server work`);
  assert.match(lines[3], new RegExp(`^ {2}- ${bad.slice(0, 7)}: no review receipt`));
  assert.equal(lines[4], 'range-check: 1 problem(s) over 3 commit(s); refused');
  assert.ok(!FULL_SHA.test(refused.stdout) && !refused.stdout.includes(MARK));
  assert.equal(run('HEAD').status, 2);
  assert.equal(run(`${h.seed}...HEAD`).status, 2);
});
