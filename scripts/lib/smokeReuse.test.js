'use strict';

// Tests for scripts/lib/smokeReuse.js through the sha gate (push-gate.js sha
// --fresh-smoke and without it). Every case runs in a throwaway repo under the
// temp dir with a local bare origin, removed when the test ends; the throwaway
// carries its own copy of the scripts (kept out of git through
// .git/info/exclude) and a committed money-smoke-list.txt, and every gate but
// the smoke's reuse decision is a stub (DRB_GATE_SMOKE_CMD and the rest), as
// in shaGate.test.js, whose helpers are copied here, not imported. Earlier
// passing smokes are planted as summary.json files in the throwaway's own
// common dir. Nothing here touches the real repo, its common dir, origin,
// Neon or any provider.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
  if (/^DRB_(SHIP|GATE)_/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const SCRIPTS = path.resolve(__dirname, '..');
const SUITES = ['server/m1.test.js', 'tests/extra.test.js'];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(repo, message, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(repo, 'add', '-f', '--', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function copyScripts(repo) {
  const lib = path.join(repo, 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of ['sensitive-match.js', 'review-receipt.js', 'push-gate.js']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(repo, 'scripts', f));
  for (const f of fs.readdirSync(path.join(SCRIPTS, 'lib'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) fs.copyFileSync(path.join(SCRIPTS, 'lib', f), path.join(lib, f));
  }
  fs.writeFileSync(path.join(repo, 'scripts', 'sensitive-paths.txt'), '# The throwaway list.\nserver/money.js\n');
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/scripts/\n/node_modules/\n/client/node_modules/\n/.husky/_/\n');
}

function stub(h, name, body, cfg) {
  const p = path.join(h.root, 'stubs', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [`#!${process.execPath}`, "'use strict';", "const fs = require('fs');", "const path = require('path');",
    "const { execFileSync } = require('child_process');",
    "const cfg = JSON.parse(fs.readFileSync(__filename + '.json', 'utf8'));", body, ''].join('\n'), { mode: 0o755 });
  fs.writeFileSync(`${p}.json`, JSON.stringify(cfg));
  return p;
}

function setCfg(p, patch) {
  const cur = JSON.parse(fs.readFileSync(`${p}.json`, 'utf8'));
  fs.writeFileSync(`${p}.json`, JSON.stringify({ ...cur, ...patch }));
}

// The smoke: plain (a passing summary of the old shape, no tree) or real (the
// shape testdb-smoke writes on a clean tree: kind, tree, clean, finished_at).
const SMOKE = `
const dir = process.argv[process.argv.indexOf('--tap-dir') + 1];
fs.appendFileSync(cfg.record, JSON.stringify({ cwd: process.cwd() }) + '\\n');
const suites = cfg.suites.map((file) => ({ file, ok: true, pass: 1, fail: 0, found: true, exit_ok: true }));
const s = { suites, total_pass: suites.length, total_fail: 0, skipped: false };
if (cfg.mode === 'real') Object.assign(s, { kind: 'money-smoke', tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(), clean: true, finished_at: new Date().toISOString() });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(s));
`;
const OK = 'process.exit(0);';
const STATIC = "process.stdout.write(JSON.stringify({ findings: [], blocking: 0, allowed: 0, files: 1, eslint_files: 0 }));";

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const origin = path.join(root, 'origin.git');
  fs.mkdirSync(repo);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', ['test', 'example.com'].join('@'));
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'commit.gpgsign', 'false');
  copyScripts(repo);
  for (const rel of ['node_modules', 'client/node_modules', '.husky/_']) {
    fs.mkdirSync(path.join(repo, rel), { recursive: true });
    fs.writeFileSync(path.join(repo, rel, 'keep.txt'), 'shared\n');
  }
  const h = { root, repo, common: path.join(repo, '.git') };
  h.seed = commit(repo, 'seed', {
    'README.md': 'readme\n', 'docs/notes.md': 'notes\n', 'server/a.js': 'a v1\n', 'server/m1.test.js': 'm1\n', 'tests/extra.test.js': 'extra\n',
    'scripts/money-smoke-list.txt': `# the throwaway smoke list\n${SUITES.join('\n')}\n`, 'scripts/testdb-smoke.js': '// the throwaway smoke\n',
  });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  h.record = path.join(root, 'smoke.jsonl');
  h.smoke = stub(h, 'smoke', SMOKE, { mode: 'plain', record: h.record, suites: SUITES });
  const ok = stub(h, 'ok', OK, {});
  h.env = {
    ...process.env, DRB_GATE_ALLOW_STUBBED: '1', DRB_GATE_SMOKE_CMD: h.smoke, DRB_GATE_BUILD_CMD: ok, DRB_GATE_INSTALL_CMD: ok,
    DRB_GATE_STATIC_CMD: stub(h, 'static', STATIC, {}), DRB_GATE_DOCS_CMD: ok,
  };
  return h;
}

function runGate(h, sha, args = []) {
  return spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'push-gate.js'), 'sha', sha, ...args], { cwd: h.repo, encoding: 'utf8', env: h.env });
}

const said = (r) => `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
const smokeRuns = (h) => (fs.existsSync(h.record) ? fs.readFileSync(h.record, 'utf8').split('\n').filter(Boolean).length : 0);
const receiptOf = (h, sha) => JSON.parse(fs.readFileSync(path.join(h.common, 'drb-gate', `${sha}.json`), 'utf8'));
const treeOf = (h, ref) => git(h.repo, 'rev-parse', `${ref}^{tree}`);

// A passing smoke summary as testdb-smoke writes it, with `patch` over it.
function summary(tree, patch = {}) {
  const suites = SUITES.map((file) => ({ file, ok: true, pass: 1, fail: 0, found: true, exit_ok: true }));
  return { suites, total_pass: suites.length, total_fail: 0, skipped: false, kind: 'money-smoke', tree, clean: true, finished_at: new Date().toISOString(), ...patch };
}

// A review's smoke dir under the common dir, as the review skill leaves it.
function plant(h, s, key = 'a'.repeat(40)) {
  const dir = path.join(h.common, 'drb-review', key, 'tests', 'smoke');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(s));
  return dir;
}

// The gate passed with the smoke reused: no smoke ran, money passed, the line said so.
function assertReused(h, sha, r, before, reason) {
  assert.equal(r.status, 0, said(r));
  assert.equal(smokeRuns(h), before, `the smoke ran though a passing one covered the tree\n${said(r)}`);
  const rec = receiptOf(h, sha);
  assert.ok(rec.gates_passed.includes('money'), JSON.stringify(rec));
  assert.ok(rec.smoke_reused && rec.smoke_reused.reason, JSON.stringify(rec));
  assert.match(r.stdout, new RegExp(`gate: smoke reused: passed on tree [0-9a-f]{7} at \\S+, ${reason}`));
}

function assertRan(h, sha, r, before, why) {
  assert.equal(r.status, 0, said(r));
  assert.equal(smokeRuns(h), before + 1, `the smoke did not run (${why})\n${said(r)}`);
  const rec = receiptOf(h, sha);
  assert.ok(rec.gates_passed.includes('money'));
  assert.ok(!rec.smoke_reused, `the receipt records a reuse (${why})`);
  assert.doesNotMatch(r.stdout, /smoke reused/);
}

test('(a) a passing smoke on the same tree is reused: no smoke runs, money passes, one line says so', (t) => {
  const h = makeRepo(t);
  const c1 = commit(h.repo, 'money', { 'server/a.js': 'a v2\n' });
  plant(h, summary(treeOf(h, c1)));
  const r = runGate(h, c1);
  assertReused(h, c1, r, 0, 'the same tree');
});

test('(b) a passing smoke whose tree differs only outside the money paths is reused; the gate\'s own kept smoke counts', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'real' });
  const c1 = commit(h.repo, 'money', { 'server/a.js': 'a v2\n' });
  const first = runGate(h, c1);
  assert.equal(first.status, 0, said(first));
  assert.equal(smokeRuns(h), 1);
  assert.ok(fs.existsSync(path.join(h.common, 'drb-gate', `${c1}.smoke`, 'summary.json')));
  const c2 = commit(h.repo, 'notes and the client', { 'docs/notes.md': 'notes v2\n', 'client/src/app.js': 'app\n' });
  const r = runGate(h, c2);
  assertReused(h, c2, r, 1, 'only 2 file\\(s\\) outside the money paths changed since');
});

test('a range that changes the installed packages runs the smoke even on a same-tree stamp', (t) => {
  // The stamp records the tracked tree, not the node_modules its smoke ran
  // under: a review smoke on the old packages must not stand in for the new.
  const h = makeRepo(t);
  const c1 = commit(h.repo, 'a dependency bump', { 'server/a.js': 'a v2\n', 'package-lock.json': '{"lockfileVersion":3}\n' });
  plant(h, summary(treeOf(h, c1)));
  const r = runGate(h, c1);
  assertRan(h, c1, r, 0, 'package-lock.json changed');
  assert.match(r.stdout, /the range changes the installed packages/);
});

test('(c) a money path changed since the passing smoke: the smoke runs', (t) => {
  const h = makeRepo(t);
  const c1 = commit(h.repo, 'money', { 'server/a.js': 'a v2\n' });
  plant(h, summary(treeOf(h, c1)));
  const c2 = commit(h.repo, 'money again', { 'server/a.js': 'a v3\n', 'docs/notes.md': 'notes v2\n' });
  assertRan(h, c2, runGate(h, c2), 0, 'server/a.js changed');
});

test('(d) a summary that is missing, failed, skipped, did not run, dirty, lacks a tree, is stale or not a full list: the smoke runs', (t) => {
  const h = makeRepo(t);
  const c1 = commit(h.repo, 'money', { 'server/a.js': 'a v2\n' });
  const tree = treeOf(h, c1);
  const day = 25 * 60 * 60 * 1000;
  const bad = [
    ['missing', null],
    ['unreadable', '{not json'],
    ['failed', summary(tree, { total_fail: 1, suites: summary(tree).suites.map((s, i) => (i ? s : { ...s, ok: false, fail: 1 })) })],
    ['a failing suite under a zero total', summary(tree, { suites: summary(tree).suites.map((s, i) => (i ? s : { ...s, ok: false })) })],
    ['skipped', summary(tree, { skipped: true })],
    ['did not run', summary(tree, { did_not_run: 'the reset failed' })],
    ['dirty', summary(tree, { clean: false })],
    ['no clean field', summary(tree, { clean: undefined })],
    ['no tree', summary(undefined)],
    ['a short tree', summary(tree.slice(0, 7))],
    ['not the smoke', summary(tree, { kind: undefined })],
    ['stale', summary(tree, { finished_at: new Date(Date.now() - day).toISOString() })],
    ['dated in the future', summary(tree, { finished_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() })],
    ['no time', summary(tree, { finished_at: undefined })],
    ['one suite short', summary(tree, { suites: summary(tree).suites.slice(1), total_pass: 1 })],
    ['no suites', summary(tree, { suites: [], total_pass: 0 })],
  ];
  let runs = 0;
  for (const [why, s] of bad) {
    fs.rmSync(path.join(h.common, 'drb-review'), { recursive: true, force: true });
    if (s !== null) {
      const dir = plant(h, {});
      fs.writeFileSync(path.join(dir, 'summary.json'), typeof s === 'string' ? s : JSON.stringify(s));
    }
    assertRan(h, c1, runGate(h, c1), runs, why);
    runs += 1;
  }
});

test('(d) a symlinked summary is never read', (t) => {
  const h = makeRepo(t);
  const c1 = commit(h.repo, 'money', { 'server/a.js': 'a v2\n' });
  const elsewhere = path.join(h.root, 'elsewhere.json');
  fs.writeFileSync(elsewhere, JSON.stringify(summary(treeOf(h, c1))));
  const dir = plant(h, {});
  fs.rmSync(path.join(dir, 'summary.json'));
  fs.symlinkSync(elsewhere, path.join(dir, 'summary.json'));
  assertRan(h, c1, runGate(h, c1), 0, 'a symlink');
});

test('(e) testdb-smoke.js or a listed suite outside the money paths changed since the passing smoke: the smoke runs', (t) => {
  const h = makeRepo(t);
  const c1 = commit(h.repo, 'money', { 'server/a.js': 'a v2\n' });
  plant(h, summary(treeOf(h, c1)));
  const c2 = commit(h.repo, 'the smoke itself', { 'scripts/testdb-smoke.js': '// the throwaway smoke, v2\n' });
  assertRan(h, c2, runGate(h, c2), 0, 'testdb-smoke.js changed');
  plant(h, summary(treeOf(h, c2)), 'b'.repeat(40));
  const c3 = commit(h.repo, 'a listed suite', { 'tests/extra.test.js': 'extra v2\n' });
  assertRan(h, c3, runGate(h, c3), 1, 'a listed suite changed');
});

test('(f) --fresh-smoke runs the smoke though a passing one covers the tree, and says why', (t) => {
  const h = makeRepo(t);
  const c1 = commit(h.repo, 'money', { 'server/a.js': 'a v2\n' });
  plant(h, summary(treeOf(h, c1)));
  const r = runGate(h, c1, ['--fresh-smoke']);
  assertRan(h, c1, r, 0, '--fresh-smoke');
  assert.match(r.stdout, /gate: --fresh-smoke: the money smoke runs/);
});

test('push-gate.js sha refuses an unknown flag after the sha', (t) => {
  const h = makeRepo(t);
  const r = runGate(h, h.seed, ['--skip-smoke']);
  assert.equal(r.status, 1, said(r));
  assert.match(r.stderr, /usage: node scripts\/push-gate\.js sha <sha> \[--fresh-smoke\]/);
});

test('a standing gate marker that names money: the smoke runs, so only a fresh run can clear it', (t) => {
  const h = makeRepo(t);
  const c1 = commit(h.repo, 'money', { 'server/a.js': 'a v2\n' });
  plant(h, summary(treeOf(h, c1)));
  const M = require(path.join(h.repo, 'scripts', 'lib', 'markers.js'));
  M.setGate({ sha: c1, reason: 'money smoke: 1 failing', gates: ['money'], cwd: h.repo });
  assertRan(h, c1, runGate(h, c1), 0, 'a marker names money');
});
