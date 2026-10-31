'use strict';

// Tests for scripts/lib/shaGate.js (instruction rewrite step 3, lane gate-sha,
// checks 3, 4 and 5). Every case that touches git runs in a throwaway repo
// under the temp dir, removed when the test ends: <root>/repo with a local
// bare origin at <root>/origin.git, so the gate's worktrees dir is
// <root>/worktrees. The throwaway carries its own copy of the scripts (kept
// out of git through .git/info/exclude) and its own sensitive list, and sha
// mode runs through that copy's push-gate.js with every gate replaced by a
// stub (DRB_GATE_SMOKE_CMD, DRB_GATE_BUILD_CMD, DRB_GATE_INSTALL_CMD,
// DRB_GATE_STATIC_CMD, DRB_GATE_DOCS_CMD), but for one docs case that runs
// this checkout's real generator through a shim committed in the throwaway.
// Nothing here touches the real repo, its common dir, origin, Neon or any
// provider.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.DRB_GATE_LOCKED;

const SG = require('./shaGate');

const SCRIPTS = path.resolve(__dirname, '..');
// A value the gate's own environment carries that must never reach the smoke.
const PARENT_ONLY = ['parent', 'only', 'value'].join('-');
const ALLOWED_SMOKE_KEYS = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR', 'NEON_API_KEY', ...SG.GATE_ENV_KEYS]);

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

// A stub executable that reads its own config from <path>.json.
function stub(h, name, body, cfg) {
  const p = path.join(h.root, 'stubs', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [`#!${process.execPath}`, "'use strict';", "const fs = require('fs');", "const path = require('path');",
    "const cfg = JSON.parse(fs.readFileSync(__filename + '.json', 'utf8'));", body, ''].join('\n'), { mode: 0o755 });
  fs.writeFileSync(`${p}.json`, JSON.stringify(cfg));
  return p;
}

function setCfg(p, patch) {
  const cur = JSON.parse(fs.readFileSync(`${p}.json`, 'utf8'));
  fs.writeFileSync(`${p}.json`, JSON.stringify({ ...cur, ...patch }));
}

const SMOKE = `
const dir = process.argv[process.argv.indexOf('--tap-dir') + 1];
let nm = 'missing';
try { const st = fs.lstatSync(path.join(process.cwd(), 'node_modules')); nm = st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'other'; } catch (e) { if (e.code !== 'ENOENT') throw e; }
fs.appendFileSync(cfg.record, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), env: process.env, node_modules: nm, env_file: fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8') }) + '\\n');
if (cfg.mode === 'sleep') { fs.writeFileSync(cfg.started, String(process.pid)); setTimeout(() => {}, 60000); return; }
const summaries = {
  pass: { suites: [], total_pass: 1, total_fail: 0, skipped: false },
  fail: { suites: [{ file: 'server/m1.test.js', ok: false }], total_pass: 0, total_fail: 1, skipped: false },
  skipped: { suites: [], total_pass: 0, total_fail: 0, skipped: true },
  didnotrun: { suites: [], total_pass: 0, total_fail: 1, skipped: false, did_not_run: 'the reset failed' },
};
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summaries[cfg.mode]));
fs.writeFileSync(path.join(dir, 'server-m1.test.js.000000.log'), 'TAP version 13\\n');
process.exit(cfg.mode === 'fail' || cfg.mode === 'didnotrun' ? 1 : 0);
`;
const BUILD = `
fs.appendFileSync(cfg.record, JSON.stringify({ cwd: process.cwd(), ci: process.env.CI }) + '\\n');
if (cfg.exit) console.log('Failed to compile.');
process.exit(cfg.exit);
`;
const INSTALL = `
fs.appendFileSync(cfg.record, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), husky: process.env.HUSKY }) + '\\n');
process.exit(cfg.exit);
`;
const STATIC = `
if (cfg.mode === 'exit2') process.exit(2);
const findings = cfg.mode === 'blocking' ? [{ rule: 'sql-concat', file: 'server/x.js', line: 1, text: 'x', blocking: true }] : [];
process.stdout.write(JSON.stringify({ findings, blocking: findings.length, allowed: 0, files: 1, eslint_files: 0 }));
process.exit(findings.length ? 1 : 0);
`;
// gen-docs.js --check --ref in place: clean, stale (two problems and the run
// line, exit 1), many (25 problems and the run line), error (exit 1 naming no
// problem) or exit2.
const DOCS = `
fs.appendFileSync(cfg.record, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + '\\n');
if (cfg.mode === 'stale') {
  console.log('stale: README.md gen:tree');
  console.log('no header: scripts/tool.js');
  console.log('run: add a header comment (see docs/dev.md), then npm run docs');
  process.exit(1);
}
if (cfg.mode === 'many') {
  for (let i = 0; i < 25; i += 1) console.log('no header: scripts/tool' + i + '.js');
  console.log('run: add a header comment (see docs/dev.md)');
  process.exit(1);
}
if (cfg.mode === 'error') console.error('gen-docs: git ls-tree failed');
process.exit(cfg.mode === 'error' ? 1 : cfg.mode === 'exit2' ? 2 : 0);
`;

// main: seed (pushed to origin). The primary root holds the shared
// node_modules, client/node_modules and .husky/_ the gate links.
function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sha-gate-'));
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
  const h = { root, repo, origin, worktrees: path.join(root, 'worktrees') };
  h.seed = commit(repo, 'seed', {
    'README.md': 'readme\n', 'docs/notes.md': 'notes\n', 'server/a.js': 'a v1\n', 'client/package.json': '{}\n',
    'client/src/app.js': 'app v1\n', 'package.json': '{}\n', 'package-lock.json': '{}\n',
  });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  h.rec = (name) => path.join(root, `${name}.jsonl`);
  h.smoke = stub(h, 'smoke', SMOKE, { mode: 'pass', record: h.rec('smoke'), started: path.join(root, 'started') });
  h.build = stub(h, 'build', BUILD, { exit: 0, record: h.rec('build') });
  h.install = stub(h, 'install', INSTALL, { exit: 0, record: h.rec('install') });
  h.static = stub(h, 'static', STATIC, { mode: 'clean' });
  h.docs = stub(h, 'docs', DOCS, { mode: 'clean', record: h.rec('docs') });
  h.env = {
    ...process.env, STRIPE_SECRET_KEY: PARENT_ONLY, DATABASE_URL: PARENT_ONLY,
    DRB_GATE_ALLOW_STUBBED: '1', DRB_GATE_SMOKE_CMD: h.smoke, DRB_GATE_BUILD_CMD: h.build, DRB_GATE_INSTALL_CMD: h.install, DRB_GATE_STATIC_CMD: h.static,
    DRB_GATE_DOCS_CMD: h.docs,
  };
  h.lib = (name) => require(path.join(repo, 'scripts', 'lib', name));
  return h;
}

function runGate(h, sha, env = {}) {
  return spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'push-gate.js'), 'sha', sha], { cwd: h.repo, encoding: 'utf8', env: { ...h.env, ...env } });
}

function records(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function receiptOf(h, sha) {
  return JSON.parse(fs.readFileSync(path.join(h.repo, '.git', 'drb-gate', `${sha}.json`), 'utf8'));
}

function lastLine(text) {
  return text.trim().split('\n').pop();
}

function gateMarker(h) {
  const p = path.join(h.repo, '.git', 'drb-markers', 'gate.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

// No registered worktree but the repo itself, and no .gate-* directory.
function assertNoGateWorktree(h) {
  const listed = git(h.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree '));
  assert.equal(listed.length, 1, `a worktree is still registered:\n${listed.join('\n')}`);
  const left = fs.existsSync(h.worktrees) ? fs.readdirSync(h.worktrees).filter((n) => n.startsWith('.gate-')) : [];
  assert.deepEqual(left, [], 'a gate worktree directory was left behind');
  assert.ok(fs.existsSync(path.join(h.repo, 'node_modules', 'keep.txt')), 'the shared node_modules must survive the gate');
}

// ---- check 3: classifyRange --------------------------------------------------------

test('classifyRange: a server change two commits before the tip needs money and the static checks', (t) => {
  const h = makeRepo(t);
  commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const tip = commit(h.repo, 'docs', { 'docs/notes.md': 'notes v2\n' });
  const c = h.lib('shaGate.js').classifyRange(h.seed, tip, { cwd: h.repo });
  assert.deepEqual(c.needed, ['money']);
  assert.equal(c.static, true);
  assert.equal(c.install, false);
  assert.equal(c.nothing_to_run, false);
  assert.deepEqual(c.touches.files.sort(), ['docs/notes.md', 'server/a.js']);
});

test('classifyRange: a client change needs client and the static checks', (t) => {
  const h = makeRepo(t);
  const tip = commit(h.repo, 'client', { 'client/src/app.js': 'app v2\n' });
  const c = h.lib('shaGate.js').classifyRange(h.seed, tip, { cwd: h.repo });
  assert.deepEqual(c.needed, ['client']);
  assert.equal(c.static, true);
  assert.equal(c.nothing_to_run, false);
});

test('classifyRange: a range of docs only is nothing_to_run', (t) => {
  const h = makeRepo(t);
  const tip = commit(h.repo, 'docs', { 'docs/notes.md': 'notes v2\n', 'README.md': 'readme v2\n' });
  const c = h.lib('shaGate.js').classifyRange(h.seed, tip, { cwd: h.repo });
  assert.equal(c.touches.docs_only, true);
  assert.deepEqual(c.needed, []);
  assert.equal(c.nothing_to_run, true);
});

test('classifyRange: .claude/ files and an unlisted scripts/<name>.js are nothing_to_run', (t) => {
  const h = makeRepo(t);
  const tip = commit(h.repo, 'hinge', { '.claude/settings.json': '{}\n', 'scripts/some-tool.js': 'x\n' });
  const c = h.lib('shaGate.js').classifyRange(h.seed, tip, { cwd: h.repo });
  assert.equal(c.touches.docs_only, false, 'neither file is docs');
  assert.deepEqual(c.needed, []);
  assert.equal(c.static, false);
  assert.equal(c.nothing_to_run, true);
});

test('classifyRange: a lock change needs money and install', (t) => {
  const h = makeRepo(t);
  const tip = commit(h.repo, 'lock', { 'package-lock.json': '{"v":2}\n' });
  const c = h.lib('shaGate.js').classifyRange(h.seed, tip, { cwd: h.repo });
  assert.deepEqual(c.needed, ['money']);
  assert.equal(c.install, true);
  assert.equal(c.nothing_to_run, false);
  const client = h.lib('shaGate.js').classifyRange(tip, commit(h.repo, 'client lock', { 'client/package.json': '{"v":2}\n' }), { cwd: h.repo });
  assert.deepEqual(client.needed, ['client']);
  assert.equal(client.install, true);
});

test('classifyRange: an empty range is nothing_to_run', (t) => {
  const h = makeRepo(t);
  const c = h.lib('shaGate.js').classifyRange(h.seed, h.seed, { cwd: h.repo });
  assert.deepEqual(c.touches.files, []);
  assert.equal(c.nothing_to_run, true);
});

// Step 5, lane gate-markers, item 4: when the docs check (spec 5.1, 5.3) is needed.
const GEN_STAND_IN = '// The docs generator stand-in (the gate runs DRB_GATE_DOCS_CMD).\n';

test('classifyRange: a path outside docs/ on a tree with generated docs needs the docs check', (t) => {
  const h = makeRepo(t);
  const c = (a, b) => h.lib('shaGate.js').classifyRange(a, b, { cwd: h.repo });
  const gen = commit(h.repo, 'generator', { 'scripts/gen-docs.js': GEN_STAND_IN });
  assert.deepEqual([c(h.seed, gen).needed, c(h.seed, gen).static, c(h.seed, gen).nothing_to_run], [['docs'], false, false]);
  const tool = commit(h.repo, 'tool', { 'scripts/tool.js': '// A tool.\n' });
  assert.deepEqual(c(gen, tool).needed, ['docs'], 'the tip carries the generator');
  const notes = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  assert.deepEqual([c(tool, notes).needed, c(tool, notes).nothing_to_run], [[], true], 'a range under docs/ alone reads nothing gen-docs reads');
  const readme = commit(h.repo, 'readme', { 'README.md': 'readme v2\n' });
  assert.deepEqual(c(notes, readme).needed, ['docs'], 'README.md is one of the two docs');
  const server = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  assert.deepEqual(c(readme, server).needed, ['money', 'docs']);
  git(h.repo, 'rm', '-q', '--', 'scripts/gen-docs.js');
  git(h.repo, 'commit', '-q', '-m', 'the generator removed');
  const gone = git(h.repo, 'rev-parse', 'HEAD');
  assert.deepEqual(c(server, gone).needed, ['docs'], 'a range that removes the generator still needs the check');
  const plain = commit(h.repo, 'tool v2', { 'scripts/tool.js': '// A tool, v2.\n' });
  assert.deepEqual([c(gone, plain).needed, c(gone, plain).nothing_to_run], [[], true], 'no generator and no gen marker: no generated docs');
  const marked = commit(h.repo, 'marked readme', { 'README.md': 'readme\n<!-- gen:tree -->\n<!-- /gen:tree -->\n' });
  assert.deepEqual(c(plain, marked).needed, ['docs'], 'a gen marker in README.md is enough');
});

// ---- check 5: checkShaReceipt ------------------------------------------------------

const NOW = Date.parse('2026-10-23T12:00:00Z');
const SHA = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const good = (over = {}) => ({
  version: 2, sha: SHA, tree: OTHER, base: BASE, files: ['server/a.js'], gates_needed: ['money'], gates_passed: ['money'],
  nothing_to_run: false, static_checks: { blocking: 0, file: null }, node_modules: 'linked', env_keys: [...SG.GATE_ENV_KEYS], stubbed: [],
  started_at: new Date(NOW - 600_000).toISOString(), finished_at: new Date(NOW - 60_000).toISOString(), ...over,
});
const check = (rec, over = {}) => SG.checkShaReceipt(rec, { sha: SHA, base: BASE, needed: ['money'], now: NOW, ...over });

test('checkShaReceipt: a valid receipt passes', () => {
  assert.equal(check(good()), null);
  assert.equal(check(good({ finished_at: new Date(NOW - SG.MAX_AGE_MS + 1000).toISOString() })), null, 'just under seven days');
});

test('checkShaReceipt: no receipt says run npm run ship', () => {
  assert.match(check(null), /no sha receipt \(run: npm run ship\)/);
});

test('checkShaReceipt: a sha mismatch refuses', () => {
  assert.match(check(good({ sha: OTHER })), /is for ccccccc, not aaaaaaa/);
});

test('checkShaReceipt: a base that is no longer origin/main refuses', () => {
  assert.match(check(good(), { base: OTHER }), /gated against origin\/main at bbbbbbb; origin\/main is now ccccccc/);
});

test('checkShaReceipt: a needed gate missing refuses, naming it', () => {
  assert.match(check(good({ gates_needed: [], gates_passed: [] })), /does not cover: money/);
  assert.match(check(good(), { needed: ['money', 'client'] }), /does not cover: client/);
});

test('checkShaReceipt: a receipt whose own run left a gate unpassed never vouches', () => {
  assert.match(check(good({ gates_needed: ['money', 'client'], gates_passed: ['money'] })), /did not pass: client/);
  assert.match(check(good({ static_checks: { blocking: 2, file: 'server/a.js' } })), /2 blocking static finding/);
});

test('checkShaReceipt: eight days old refuses and says the age', () => {
  assert.match(check(good({ finished_at: new Date(NOW - 8 * 86_400_000).toISOString() })), /8\.0 days old \(max 7\)/);
});

test('checkShaReceipt: a future or unreadable finished_at refuses', () => {
  assert.match(check(good({ finished_at: new Date(NOW + 3_600_000).toISOString() })), /dated in the future/);
  assert.match(check(good({ finished_at: 'yesterday' })), /finished_at is unreadable/);
});

test('checkShaReceipt: an unreadable file and a wrong version refuse', () => {
  assert.match(check({ unreadable: true, path: '/x/drb-gate/y.json' }), /unreadable \(run: npm run ship\)/);
  assert.match(check(good({ version: 1 })), /version 1, not 2 \(run: npm run ship\)/);
});

test('checkShaReceipt: nothing_to_run stands for an empty needed list, never a non-empty one', () => {
  const none = good({ gates_needed: [], gates_passed: [], nothing_to_run: true, static_checks: null, node_modules: null, env_keys: [] });
  assert.equal(check(none, { needed: [] }), null);
  assert.match(check(none), /does not cover: money .*never stands for a needed gate/);
  assert.match(check(good({ gates_needed: [], gates_passed: [] }), { needed: [] }), /records no gate/);
});

test('readShaReceipt: no file is null, a torn or partial file is unreadable', (t) => {
  const h = makeRepo(t);
  const L = h.lib('shaGate.js');
  assert.equal(L.readShaReceipt(h.seed, { cwd: h.repo }), null);
  const file = L.receiptPath(h.seed, { cwd: h.repo });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"version": 1,');
  assert.deepEqual(L.readShaReceipt(h.seed, { cwd: h.repo }), { unreadable: true, path: file });
  fs.writeFileSync(file, JSON.stringify({ version: 2, sha: h.seed }));
  assert.equal(L.readShaReceipt(h.seed, { cwd: h.repo }).unreadable, true, 'a version 2 receipt missing its fields');
  fs.writeFileSync(file, JSON.stringify({ version: 'one', sha: h.seed }));
  assert.equal(L.readShaReceipt(h.seed, { cwd: h.repo }).unreadable, true, 'no integer version');
  // A version 1 receipt (every field but stubbed) reads as itself and is
  // refused by its version, not as unreadable.
  const { stubbed, ...v1 } = good({ sha: h.seed, version: 1 });
  assert.deepEqual(stubbed, []);
  fs.writeFileSync(file, JSON.stringify(v1));
  const read = L.readShaReceipt(h.seed, { cwd: h.repo });
  assert.equal(read.version, 1);
  assert.equal(read.unreadable, undefined);
  assert.match(L.checkShaReceipt(read, { sha: h.seed, base: BASE, needed: ['money'], now: NOW }), /version 1, not 2 \(run: npm run ship\)/);
  const rec = good({ sha: h.seed });
  assert.equal(L.writeShaReceipt(rec, { cwd: h.repo }), file);
  assert.deepEqual(L.readShaReceipt(h.seed, { cwd: h.repo }), rec);
  assert.throws(() => L.writeShaReceipt({ ...rec, env_keys: undefined }, { cwd: h.repo }), /not a version 2 sha receipt/);
});

const PLACEHOLDER = ['gate', 'placeholder', 'not', 'a', 'stripe', 'key'].join('-');

test('gateEnvFile: the decision 3 names in order plus the placeholder secret key, no real key, no DATABASE_URL', () => {
  const text = SG.gateEnvFile();
  const lines = text.trim().split('\n');
  assert.deepEqual(lines.map((l) => l.split('=')[0]), [...SG.GATE_ENV_KEYS]);
  assert.deepEqual(SG.GATE_ENV_KEYS, ['NODE_ENV', 'SEND_NOTIFICATIONS', 'RUN_SCHEDULERS', 'JWT_SECRET', 'ENCRYPTION_KEY', 'STRIPE_TEST_MODE_UNTIL', 'STRIPE_SECRET_KEY']);
  assert.ok(lines.includes('NODE_ENV=test') && lines.includes('STRIPE_TEST_MODE_UNTIL='));
  assert.ok(lines.includes(`STRIPE_SECRET_KEY=${PLACEHOLDER}`), 'the secret key is the placeholder');
  assert.doesNotMatch(text, /STRIPE_(PUBLISHABLE|WEBHOOK)|DATABASE_URL/);
  const values = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.match(values.ENCRYPTION_KEY, /^[0-9a-f]{64}$/);
  assert.match(values.STRIPE_SECRET_KEY, /^[a-z]+(-[a-z]+)+$/, 'the placeholder is dashed words only, nothing shaped like a credential');
  assert.ok(values.JWT_SECRET.length >= 32, 'the server refuses a JWT_SECRET under 32 characters');
});

test('gateWorktreePath: .gate-<sha7> in the worktrees dir beside the primary root', (t) => {
  const h = makeRepo(t);
  assert.equal(h.lib('shaGate.js').gateWorktreePath(h.seed, { cwd: h.repo }), path.join(h.worktrees, `.gate-${h.seed.slice(0, 7)}`));
});

// ---- check 4: sha mode with the overrides ----------------------------------------------

test('sha mode: a docs-only sha writes a nothing_to_run receipt and creates no worktree', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'docs', { 'docs/notes.md': 'notes v2\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 0, r.stderr);
  const rec = receiptOf(h, sha);
  assert.equal(rec.nothing_to_run, true);
  assert.deepEqual([rec.gates_needed, rec.gates_passed, rec.env_keys], [[], [], []]);
  assert.equal(rec.node_modules, null);
  assert.deepEqual(rec.stubbed, [], 'no stub ran on a nothing_to_run range');
  assert.equal(rec.static_checks, null);
  assert.equal(rec.base, h.seed);
  assert.equal(rec.tree, git(h.repo, 'rev-parse', `${sha}^{tree}`));
  assert.equal(lastLine(r.stdout), path.join(h.repo, '.git', 'drb-gate', `${sha}.json`), 'the receipt path is the last stdout line');
  assert.ok(!fs.existsSync(h.worktrees), 'no worktrees dir was even made');
  assert.equal(records(h.rec('smoke')).length, 0);
  for (const name of ['DRB_GATE_SMOKE_CMD', 'DRB_GATE_BUILD_CMD', 'DRB_GATE_INSTALL_CMD', 'DRB_GATE_STATIC_CMD']) assert.match(r.stderr, new RegExp(`${name} is set`));
});

test('sha mode: a server sha runs the stub smoke in a worktree under the gate env file, node_modules linked', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 0, r.stderr);
  const [run] = records(h.rec('smoke'));
  assert.equal(run.cwd, path.join(h.worktrees, `.gate-${sha.slice(0, 7)}`));
  assert.deepEqual(run.argv, ['--tap-dir', path.join(run.cwd, '.gate-smoke')]);
  assert.equal(run.env.NODE_ENV, 'test');
  assert.equal(run.env.STRIPE_SECRET_KEY, PLACEHOLDER, 'the smoke gets the placeholder');
  assert.notEqual(run.env.STRIPE_SECRET_KEY, PARENT_ONLY, 'the parent environment\'s Stripe key must never reach the smoke');
  assert.equal(run.env.DATABASE_URL, undefined);
  for (const k of SG.GATE_ENV_KEYS) assert.ok(Object.prototype.hasOwnProperty.call(run.env, k), `${k} missing from the smoke's environment`);
  for (const k of Object.keys(run.env)) assert.ok(ALLOWED_SMOKE_KEYS.has(k), `${k} leaked into the scrubbed environment`);
  assert.equal(run.env_file, SG.gateEnvFile());
  assert.equal(run.node_modules, 'link');
  const rec = receiptOf(h, sha);
  assert.deepEqual(rec.gates_needed, ['money']);
  assert.deepEqual(rec.gates_passed, ['money']);
  assert.equal(rec.node_modules, 'linked');
  assert.deepEqual(rec.env_keys, [...SG.GATE_ENV_KEYS]);
  assert.deepEqual(rec.static_checks, { blocking: 0, file: null });
  assert.deepEqual(rec.stubbed, ['static', 'smoke'], 'the receipt names the stubs that ran');
  assert.match(r.stdout, /PASSED at \S+ \(money\) \(stubbed: static, smoke\)/);
  assert.match(SG.checkShaReceipt(rec, { sha, base: rec.base, needed: ['money'] }), /written with stubs in place of static, smoke/);
  assert.equal(SG.checkShaReceipt(rec, { sha, base: rec.base, needed: ['money'], stubbedOk: true }), null);
  assert.equal(rec.nothing_to_run, false);
  const kept = path.join(h.repo, '.git', 'drb-gate', `${sha}.smoke`);
  assert.ok(fs.existsSync(path.join(kept, 'summary.json')), 'a passing run keeps the smoke directory too');
  assert.match(r.stdout, new RegExp(`PASSED at .*\\(smoke logs: ${kept.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
  assert.equal(lastLine(r.stdout), path.join(h.repo, '.git', 'drb-gate', `${sha}.json`));
  assertNoGateWorktree(h);
});

test('sha mode: a failed smoke keeps its TAP directory beside the receipt; a second run replaces it whole', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const kept = path.join(h.repo, '.git', 'drb-gate', `${sha}.smoke`);
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  assert.ok(fs.existsSync(path.join(kept, 'summary.json')));
  assert.ok(fs.existsSync(path.join(kept, 'server-m1.test.js.000000.log')));
  assert.ok(r.stderr.includes(`FAILED at ${sha.slice(0, 7)}: money smoke: 1 failing of 1 suite(s)`));
  assert.ok(r.stderr.includes(`(smoke logs: ${kept})`), 'the FAILED line names the kept directory');
  assert.match(gateMarker(h).reason, /smoke logs kept beside the sha receipt/);
  assertNoGateWorktree(h);
  fs.writeFileSync(path.join(kept, 'old-run.txt'), 'from the first run\n');
  const again = runGate(h, sha);
  assert.equal(again.status, 1);
  assert.ok(!fs.existsSync(path.join(kept, 'old-run.txt')), 'the earlier directory is replaced whole');
  assert.ok(fs.existsSync(path.join(kept, 'summary.json')));
  assertNoGateWorktree(h);
});

test('sha mode: a client sha runs the stub build in <wt>/client with CI=true', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'client', { 'client/src/app.js': 'app v2\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 0, r.stderr);
  const [b] = records(h.rec('build'));
  assert.equal(b.cwd, path.join(h.worktrees, `.gate-${sha.slice(0, 7)}`, 'client'));
  assert.equal(b.ci, 'true');
  assert.deepEqual(receiptOf(h, sha).gates_passed, ['client']);
  assert.equal(records(h.rec('smoke')).length, 0, 'a client-only range needs no smoke');
  assertNoGateWorktree(h);
});

test('sha mode: a lock change runs the stub install in the root and client/, node_modules a real directory', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'lock', { 'package-lock.json': '{"v":2}\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 0, r.stderr);
  const wt = path.join(h.worktrees, `.gate-${sha.slice(0, 7)}`);
  const installs = records(h.rec('install'));
  assert.deepEqual(installs.map((x) => x.cwd), [wt, path.join(wt, 'client')]);
  assert.ok(installs.every((x) => x.argv.join(' ') === 'ci' && x.husky === '0'));
  assert.equal(records(h.rec('smoke'))[0].node_modules, 'dir');
  const rec = receiptOf(h, sha);
  assert.equal(rec.node_modules, 'npm ci');
  assert.deepEqual(rec.gates_passed, ['money']);
  assertNoGateWorktree(h);
});

test('sha mode: a failing stub install is a failed gate of its own, and writes no marker even on main', (t) => {
  const h = makeRepo(t);
  setCfg(h.install, { exit: 1 });
  const sha = commit(h.repo, 'lock', { 'package-lock.json': '{"v":3}\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /npm ci in \.: exit 1/);
  assert.match(r.stderr, /a failure of the gate itself/);
  assert.deepEqual(receiptOf(h, sha).gates_passed, []);
  assert.equal(records(h.rec('smoke')).length, 0, 'the smoke never ran');
  assert.equal(gateMarker(h), null, 'a registry failure must never wedge main');
  assertNoGateWorktree(h);
});

test('sha mode: a failing smoke on main writes no money pass and sets the marker; a passing child clears it', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const bad = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const r = runGate(h, bad);
  assert.equal(r.status, 1);
  const rec = receiptOf(h, bad);
  assert.deepEqual(rec.gates_passed, []);
  assert.equal(lastLine(r.stdout), path.join(h.repo, '.git', 'drb-gate', `${bad}.json`));
  const m = gateMarker(h);
  assert.equal(m.sha, bad);
  assert.match(m.reason, /money smoke: 1 failing of 1 suite\(s\), exit 1; failing: m1\.test\.js/);
  assert.match(r.stderr, /gate marker written on/);
  setCfg(h.smoke, { mode: 'pass' });
  const fix = commit(h.repo, 'fix', { 'server/a.js': 'a v3\n' });
  const ok = runGate(h, fix);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`cleared the gate marker on ${bad.slice(0, 7)} \\(fix forward\\)`));
  assert.equal(gateMarker(h), null);
  assertNoGateWorktree(h);
});

test('sha mode: a failing smoke on a lane tip writes no marker and says so', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  git(h.repo, 'checkout', '-q', '-b', 'lane');
  const tip = commit(h.repo, 'lane work', { 'server/a.js': 'a lane\n' });
  git(h.repo, 'checkout', '-q', 'main');
  const r = runGate(h, tip);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no gate marker: .*a lane tip leaves no gate marker/);
  assert.equal(gateMarker(h), null);
  assert.deepEqual(receiptOf(h, tip).gates_passed, []);
  assertNoGateWorktree(h);
});

test('sha mode: a stub summary with skipped true is not a pass and writes no marker', (t) => {
  const h = makeRepo(t);
  for (const mode of ['skipped', 'didnotrun']) {
    setCfg(h.smoke, { mode });
    const sha = commit(h.repo, `server ${mode}`, { 'server/a.js': `a ${mode}\n` });
    const r = runGate(h, sha);
    assert.equal(r.status, 1, mode);
    assert.match(r.stderr, mode === 'skipped' ? /SKIPPED/ : /did not run/);
    assert.match(r.stderr, /a failure of the gate itself/);
    assert.deepEqual(receiptOf(h, sha).gates_passed, [], `${mode} is never in gates_passed`);
    assert.equal(gateMarker(h), null, `${mode}: a failure of the gate itself writes no marker, even on main`);
  }
  assertNoGateWorktree(h);
});

test('sha mode: a blocking static finding fails the gate naming the file; exit 2 is the gate\'s own failure', (t) => {
  const h = makeRepo(t);
  setCfg(h.static, { mode: 'blocking' });
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /static checks: 1 blocking finding\(s\), the first in server\/x\.js/);
  assert.deepEqual(receiptOf(h, sha).static_checks, { blocking: 1, file: 'server/x.js' });
  assert.equal(gateMarker(h).sha, sha);
  assert.equal(records(h.rec('smoke')).length, 0);
  fs.rmSync(path.join(h.repo, '.git', 'drb-markers'), { recursive: true, force: true });
  setCfg(h.static, { mode: 'exit2' });
  const two = commit(h.repo, 'server 2', { 'server/a.js': 'a v3\n' });
  const r2 = runGate(h, two);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /the static checks did not run \(exit 2\)/);
  assert.equal(gateMarker(h), null);
  assertNoGateWorktree(h);
});

test('sha mode: with no static override and no static-checks.js at the sha, the pre-step did not run', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const r = runGate(h, sha, { DRB_GATE_STATIC_CMD: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /static checks (did not run|printed no JSON)/);
  assert.equal(gateMarker(h), null);
  assertNoGateWorktree(h);
});

test('sha mode: an env file already in the commit refuses before the gate writes its own', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'server and env', { 'server/a.js': 'a v2\n', '.env': 'NODE_ENV=development\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already holds \.env/);
  assert.equal(records(h.rec('smoke')).length, 0);
  assert.equal(gateMarker(h), null);
  assertNoGateWorktree(h);
});

test('sha mode: a ref that names no commit and a failing fetch write no receipt', (t) => {
  const h = makeRepo(t);
  const r = runGate(h, 'no-such-ref');
  assert.doesNotMatch(r.stdout, /removed the gate worktree/);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /names no commit/);
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  git(h.repo, 'remote', 'set-url', 'origin', path.join(h.root, 'gone.git'));
  const f = runGate(h, sha);
  assert.equal(f.status, 1);
  assert.match(f.stderr, /git fetch origin main failed/);
  assert.ok(!fs.existsSync(path.join(h.repo, '.git', 'drb-gate', `${sha}.json`)));
  assert.equal(gateMarker(h), null);
});

test('sha mode: a crash-left .gate-* directory is swept on the next run', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(path.join(h.worktrees, '.gate-1234567'), { recursive: true });
  git(h.repo, 'worktree', 'add', '-q', '--detach', path.join(h.worktrees, '.gate-abcdefa'), h.seed);
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /swept \.gate-1234567/);
  assert.match(r.stdout, /swept \.gate-abcdefa/);
  assertNoGateWorktree(h);
});

test('sha mode: a second gate refuses while the push-gate lock is held', async (t) => {
  const h = makeRepo(t);
  const lock = path.join(h.repo, '.git', 'drb-push-gate.lock');
  const holder = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  for (let i = 0; i < 100 && spawnSync('flock', ['-n', lock, 'true']).status === 0; i++) await new Promise((r) => setTimeout(r, 50));
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /another push gate is already running/);
  assert.equal(records(h.rec('smoke')).length, 0);
});

test('sha mode: a SIGTERM mid-gate stops the smoke and leaves no registered worktree and no directory', async (t) => {
  const h = makeRepo(t);
  const started = path.join(h.root, 'started');
  setCfg(h.smoke, { mode: 'sleep' });
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const child = spawn(process.execPath, [path.join(h.repo, 'scripts', 'push-gate.js'), 'sha', sha], { cwd: h.repo, env: h.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const closed = new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal })));
  for (let i = 0; i < 400 && !fs.existsSync(started); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(started), `the stub smoke never started:\n${err}`);
  const stubPid = Number(fs.readFileSync(started, 'utf8'));
  child.kill('SIGTERM');
  const end = await closed;
  assert.equal(end.status, 1, `exit ${end.status} ${end.signal}\n${err}`);
  assert.match(err, /SIGTERM received/);
  let alive = true;
  for (let i = 0; i < 100 && alive; i++) {
    try {
      process.kill(stubPid, 0);
      await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      if (e.code !== 'ESRCH') throw e;
      alive = false;
    }
  }
  assert.equal(alive, false, 'the stub smoke must be stopped with the gate');
  assertNoGateWorktree(h);
});

// ---- fix round 1 -----------------------------------------------------------------------

test('sha mode: a worktree add that fails partway leaves no directory and no registration', (t) => {
  const h = makeRepo(t);
  // git worktree add checks the tree out, then runs post-checkout; a failing
  // hook makes the add exit non-zero with the worktree made and registered.
  const hook = path.join(h.repo, '.git', 'hooks', 'post-checkout');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git worktree add failed/);
  assert.match(r.stdout, /removed the gate worktree/, 'what the failed add left was removed');
  assertNoGateWorktree(h);
});

test('sha mode: an add that leaves nothing prints no removal line', (t) => {
  const h = makeRepo(t);
  fs.writeFileSync(h.worktrees, 'a file where the worktrees dir belongs\n');
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /git worktree add failed/);
  assert.doesNotMatch(r.stdout, /removed the gate worktree/);
  assert.equal(git(h.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1);
});

test('sha mode: the marker names only the verdict checks the failing run did not prove', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const sha = commit(h.repo, 'server and client', { 'server/a.js': 'a v2\n', 'client/package.json': '{"v":2}\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /needs money \+ client \+ static checks \+ npm ci/);
  // npm ci and the static checks passed before the smoke failed; the build was never reached.
  assert.deepEqual(gateMarker(h).gates.sort(), ['client', 'money']);
});

test('sha mode: a git revert of an unshipped failing commit (an empty range) clears its marker', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const A = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  assert.equal(runGate(h, A).status, 1);
  assert.equal(gateMarker(h).sha, A);
  git(h.repo, 'revert', '--no-edit', A);
  const rev = git(h.repo, 'rev-parse', 'HEAD');
  const r = runGate(h, rev);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(receiptOf(h, rev).nothing_to_run, true);
  assert.match(r.stdout, new RegExp(`cleared the gate marker on ${A.slice(0, 7)} \\(fix forward\\)`));
  assert.equal(gateMarker(h), null);
});

test('sha mode: a partial revert that keeps the server change and restores the lock clears on money and static', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const A = commit(h.repo, 'server and lock', { 'server/a.js': 'a v2\n', 'package-lock.json': '{"v":2}\n' });
  assert.equal(runGate(h, A).status, 1);
  setCfg(h.smoke, { mode: 'pass' });
  const F = commit(h.repo, 'restore the lock', { 'package-lock.json': '{}\n' });
  const r = runGate(h, F);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /needs money \+ static checks$/m);
  assert.doesNotMatch(r.stdout, /npm ci in/);
  assert.equal(gateMarker(h), null);
});

test('sha mode: a partial revert that drops the client change clears without the client build', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const A = commit(h.repo, 'server and client', { 'server/a.js': 'a v2\n', 'client/src/app.js': 'app v2\n' });
  assert.equal(runGate(h, A).status, 1);
  assert.deepEqual(gateMarker(h).gates.sort(), ['client', 'money']);
  setCfg(h.smoke, { mode: 'pass' });
  const F = commit(h.repo, 'drop the client change', { 'client/src/app.js': 'app v1\n' });
  const r = runGate(h, F);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(records(h.rec('build')).length, 0, 'the range no longer needs the build');
  assert.equal(gateMarker(h), null, 'an unshipped failure needs only what the range still needs');
});

test('sha mode: a stubbed passing run without DRB_GATE_ALLOW_STUBBED leaves the marker standing', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const A = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  assert.equal(runGate(h, A).status, 1);
  setCfg(h.smoke, { mode: 'pass' });
  const C = commit(h.repo, 'fix', { 'server/a.js': 'a v3\n' });
  const r = runGate(h, C, { DRB_GATE_ALLOW_STUBBED: '' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stands; a run with stubs in place of static, smoke never clears one/);
  assert.equal(gateMarker(h).sha, A);
});

test('sha mode: a pass that did not re-run what the marker names leaves it standing; one that did clears it', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const A = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  assert.equal(runGate(h, A).status, 1);
  assert.equal(gateMarker(h).sha, A);
  setCfg(h.smoke, { mode: 'pass' });
  // B descends from A, but the range origin/main..B still holds A's server
  // change; to get a docs-only range the origin must hold A. Push A first.
  git(h.repo, 'push', '-q', 'origin', `${A}:refs/heads/main`);
  const B = commit(h.repo, 'docs', { 'docs/notes.md': 'notes v2\n' });
  const rb = runGate(h, B);
  assert.equal(rb.status, 0, rb.stderr);
  assert.match(rb.stdout, new RegExp(`gate marker on ${A.slice(0, 7)} stands; this run did not re-run money, which the failure on ${A.slice(0, 7)} still requires`));
  assert.equal(gateMarker(h).sha, A);
  const C = commit(h.repo, 'server fix', { 'server/a.js': 'a v3\n' });
  const rc = runGate(h, C);
  assert.equal(rc.status, 0, rc.stderr);
  assert.match(rc.stdout, new RegExp(`cleared the gate marker on ${A.slice(0, 7)} \\(fix forward\\)`));
  assert.equal(gateMarker(h), null);
});

test('sha mode: a marker naming static checks is not cleared by a pass that ran money alone', (t) => {
  const h = makeRepo(t);
  const A = commit(h.repo, 'docs', { 'docs/notes.md': 'notes v2\n' });
  git(h.repo, 'push', '-q', 'origin', `${A}:refs/heads/main`); // shipped: every named check is required
  fs.mkdirSync(path.join(h.repo, '.git', 'drb-markers'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, '.git', 'drb-markers', 'gate.json'), JSON.stringify({ sha: A, at: new Date().toISOString(), reason: 'static checks: 1 blocking finding(s)', gates: ['money', 'static checks'] }));
  const C = commit(h.repo, 'lock', { 'package-lock.json': '{"v":4}\n' });
  const r = runGate(h, C);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /stands; this run did not re-run static checks/);
  assert.equal(gateMarker(h).sha, A);
});

// Step 5, lane gate-markers, item 3 (it read as naming none and cleared).
test('sha mode: a shipped marker with no gates list, or a gates field that is not a list, reads as every check', (t) => {
  const h = makeRepo(t);
  const A = commit(h.repo, 'docs', { 'docs/notes.md': 'notes v2\n' });
  git(h.repo, 'push', '-q', 'origin', `${A}:refs/heads/main`); // shipped: every named check is required
  const file = path.join(h.repo, '.git', 'drb-markers', 'gate.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let n = 0;
  for (const extra of [{}, { gates: 'client' }]) {
    fs.writeFileSync(file, JSON.stringify({ sha: A, at: new Date().toISOString(), reason: 'money smoke failed', ...extra }));
    n += 1;
    const C = commit(h.repo, `client ${n}`, { 'client/src/app.js': `app v${n + 1}\n` });
    const r = runGate(h, C);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`gate marker on ${A.slice(0, 7)} stands; this run did not re-run money`), JSON.stringify(extra));
    assert.equal(gateMarker(h).sha, A, JSON.stringify(extra));
  }
});

// Step 5, lane gate-markers, item 1 (the superseded failure was dropped).
test('sha mode: a superseded failure that shipped untested stands until a pass on a descendant re-runs what it names', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const A = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  assert.equal(runGate(h, A).status, 1);
  git(h.repo, 'push', '-q', 'origin', `${A}:refs/heads/main`); // shipped untested
  setCfg(h.build, { exit: 1 });
  const C = commit(h.repo, 'client', { 'client/src/app.js': 'app v2\n' });
  assert.equal(runGate(h, C).status, 1);
  const m = gateMarker(h);
  assert.deepEqual([m.sha, m.gates], [C, ['client']]);
  assert.deepEqual((m.earlier || []).map((e) => [e.sha, e.gates]), [[A, ['money']]], 'the run on C never re-ran money');
  const line = h.lib('markers.js').standing({ cwd: h.repo }).gate;
  assert.ok(line.includes(`1 earlier failure stands with it: ${A.slice(0, 7)} (money; on main and origin/main, shipped untested: cleared only by a later sha on main whose one pass re-runs every check it names)`), line);
  setCfg(h.build, { exit: 0 });
  const D = commit(h.repo, 'client fix', { 'client/src/app.js': 'app v3\n' });
  const rd = runGate(h, D);
  assert.equal(rd.status, 0, rd.stderr);
  assert.match(rd.stdout, new RegExp(`gate marker on ${C.slice(0, 7)} stands; this run did not re-run money, which the failure on ${A.slice(0, 7)} still requires`));
  assert.equal(gateMarker(h).sha, C);
  setCfg(h.smoke, { mode: 'pass' });
  const E = commit(h.repo, 'server fix', { 'server/a.js': 'a v3\n' });
  const re = runGate(h, E);
  assert.equal(re.status, 0, re.stderr);
  assert.match(re.stdout, new RegExp(`cleared the gate marker on ${C.slice(0, 7)} \\(fix forward\\)`));
  assert.equal(gateMarker(h), null);
});

// Step 5, lane gate-markers, item 2: main replayed without A (a docs-only pass cleared it).
test('sha mode: a failure whose sha left main requires every check it names: a docs-only pass leaves it standing', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const A = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  assert.equal(runGate(h, A).status, 1);
  assert.equal(gateMarker(h).sha, A);
  git(h.repo, 'checkout', '-q', '-b', 'replay', h.seed);
  const D = commit(h.repo, 'docs', { 'docs/notes.md': 'notes v2\n' });
  git(h.repo, 'branch', '-f', 'main', D);
  git(h.repo, 'checkout', '-q', 'main');
  assert.equal(h.lib('markers.js').placement(A, { cwd: h.repo }), 'off');
  setCfg(h.smoke, { mode: 'pass' });
  const rd = runGate(h, D);
  assert.equal(rd.status, 0, rd.stderr);
  assert.equal(receiptOf(h, D).nothing_to_run, true);
  assert.match(rd.stdout, new RegExp(`gate marker on ${A.slice(0, 7)} stands; this run did not re-run money, which the failure on ${A.slice(0, 7)} still requires`));
  assert.equal(gateMarker(h).sha, A);
  setCfg(h.build, { exit: 1 });
  const Y = commit(h.repo, 'client', { 'client/src/app.js': 'app v2\n' });
  assert.equal(runGate(h, Y).status, 1);
  assert.deepEqual([gateMarker(h).sha, gateMarker(h).earlier.map((e) => e.sha)], [Y, [A]]);
  const line = h.lib('markers.js').standing({ cwd: h.repo }).gate;
  assert.ok(line.includes(`1 earlier failure stands with it: ${A.slice(0, 7)} (money; off main: cleared only by a later sha on main whose one pass re-runs every check it names)`), line);
  setCfg(h.build, { exit: 0 });
  const E = commit(h.repo, 'server', { 'server/b.js': 'b\n' });
  const re = runGate(h, E);
  assert.equal(re.status, 0, re.stderr);
  assert.match(re.stdout, new RegExp(`cleared the gate marker on ${Y.slice(0, 7)} \\(fix forward\\)`));
  assert.equal(gateMarker(h), null);
});

// Step 5, lane gate-markers, item 4: the docs check in the gate (it ran no docs check).
test('sha mode: the docs check runs on the sha in the gate worktree; problems fail the gate by name, the marker names docs, and a current tree passes', (t) => {
  const h = makeRepo(t);
  const gen = commit(h.repo, 'generator', { 'scripts/gen-docs.js': GEN_STAND_IN });
  git(h.repo, 'push', '-q', 'origin', 'main');
  setCfg(h.docs, { mode: 'stale' });
  const sha = commit(h.repo, 'tool', { 'scripts/tool.js': '// A tool.\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`against origin/main ${gen.slice(0, 7)}: 1 file\\(s\\), needs docs$`, 'm'));
  assert.ok(r.stderr.includes(`FAILED at ${sha.slice(0, 7)}: docs check: 2 problem(s): stale: README.md gen:tree; no header: scripts/tool.js`), r.stderr);
  assert.match(r.stderr, /^gate: docs: stale: README\.md gen:tree$/m);
  const echoed = r.stderr.split('\n').filter((l) => l.startsWith('gate: docs: '));
  assert.deepEqual(echoed.slice(-1), ['gate: docs: run: add a header comment (see docs/dev.md), then npm run docs'], 'the generator\'s own remedy, after the problem lines');
  assert.match(r.stderr, /a verdict about the code/);
  const [d] = records(h.rec('docs'));
  assert.equal(d.cwd, path.join(h.worktrees, `.gate-${sha.slice(0, 7)}`));
  assert.deepEqual(d.argv, ['--check', '--ref', sha]);
  const m = gateMarker(h);
  assert.deepEqual([m.sha, m.gates], [sha, ['docs']]);
  assert.match(m.reason, /stale: README\.md gen:tree/);
  const rec = receiptOf(h, sha);
  assert.deepEqual([rec.gates_needed, rec.gates_passed, rec.stubbed], [['docs'], [], ['docs']]);
  assert.equal(records(h.rec('smoke')).length, 0);
  setCfg(h.docs, { mode: 'clean' });
  const fix = commit(h.repo, 'regenerated', { 'README.md': 'readme v2\n' });
  const ok = runGate(h, fix);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(receiptOf(h, fix).gates_passed, ['docs']);
  assert.match(ok.stdout, /PASSED at \S+ \(docs\) \(stubbed: docs\)/);
  assert.match(ok.stdout, new RegExp(`cleared the gate marker on ${sha.slice(0, 7)} \\(fix forward\\)`));
  assertNoGateWorktree(h);
});

// Fix round 1, item 3: the remedy line is echoed inside the 20-line cap (it was dropped).
test('sha mode: the docs check echoes at most 20 lines, the problems first with a count of the rest, then the generator\'s remedy', (t) => {
  const h = makeRepo(t);
  commit(h.repo, 'generator', { 'scripts/gen-docs.js': GEN_STAND_IN });
  setCfg(h.docs, { mode: 'many' });
  const sha = commit(h.repo, 'tools', { 'scripts/tool.js': '// A tool.\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 1);
  const echoed = r.stderr.split('\n').filter((l) => l.startsWith('gate: docs: '));
  assert.equal(echoed.filter((l) => l.startsWith('gate: docs: no header: ')).length, 19);
  assert.deepEqual(echoed.slice(-2), ['gate: docs: and 6 more', 'gate: docs: run: add a header comment (see docs/dev.md)']);
  assert.ok(r.stderr.includes('docs check: 25 problem(s): no header: scripts/tool0.js; no header: scripts/tool1.js; no header: scripts/tool2.js; and 22 more'), r.stderr);
  assertNoGateWorktree(h);
});

test('sha mode: a docs check that names no problem on exit 1, or exits 2, is the gate\'s own failure and writes no marker', (t) => {
  const h = makeRepo(t);
  commit(h.repo, 'generator', { 'scripts/gen-docs.js': GEN_STAND_IN });
  for (const mode of ['error', 'exit2']) {
    setCfg(h.docs, { mode });
    const sha = commit(h.repo, `tool ${mode}`, { 'scripts/tool.js': `// A tool, ${mode}.\n` });
    const r = runGate(h, sha);
    assert.equal(r.status, 1, mode);
    assert.match(r.stderr, new RegExp(`the docs check did not run \\(exit ${mode === 'error' ? 1 : 2}`), mode);
    assert.match(r.stderr, /a failure of the gate itself/, mode);
    assert.equal(gateMarker(h), null, mode);
  }
  assertNoGateWorktree(h);
});

test('sha mode: with no docs override, a range that removes the generator fails the gate: the docs check did not run', (t) => {
  const h = makeRepo(t);
  commit(h.repo, 'generator', { 'scripts/gen-docs.js': GEN_STAND_IN });
  git(h.repo, 'push', '-q', 'origin', 'main');
  git(h.repo, 'rm', '-q', '--', 'scripts/gen-docs.js');
  git(h.repo, 'commit', '-q', '-m', 'the generator removed');
  const sha = git(h.repo, 'rev-parse', 'HEAD');
  const r = runGate(h, sha, { DRB_GATE_DOCS_CMD: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the docs check did not run \(exit 1, no problem named\)/);
  assert.equal(gateMarker(h), null);
  assertNoGateWorktree(h);
});

// The real generator, through a shim that runs this checkout's gen-docs.js.
test('sha mode: the real generator through the gate: a stale README tree fails naming gen:tree, a regenerated one passes', (t) => {
  const h = makeRepo(t);
  const shim = `// Runs the docs generator under test on this repo.\n'use strict';\nprocess.exitCode = require(${JSON.stringify(path.join(SCRIPTS, 'gen-docs.js'))}).main(process.argv.slice(2));\n`;
  const docs = {
    'README.md': '# readme\n\n<!-- gen:tree -->\n<!-- /gen:tree -->\n\n<!-- gen:scripts -->\n<!-- /gen:scripts -->\n\n<!-- gen:env -->\n<!-- /gen:env -->\n',
    'ARCHITECTURE.md': '# arch\n\n<!-- gen:routes -->\n<!-- /gen:routes -->\n\n<!-- gen:schema -->\n<!-- /gen:schema -->\n\n<!-- gen:agents -->\n<!-- /gen:agents -->\n',
  };
  const render = () => {
    const out = spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'gen-docs.js'), '--staged'], { cwd: h.repo, encoding: 'utf8', env: h.env });
    assert.equal(out.status, 0, out.stderr);
  };
  commit(h.repo, 'docs and headers', { ...docs, 'scripts/gen-docs.js': shim, 'server/a.js': '// The server file a.\n', 'client/src/app.js': '// The client app.\n' });
  render();
  git(h.repo, 'commit', '-q', '-m', 'docs rendered');
  git(h.repo, 'push', '-q', 'origin', 'main');
  const stale = commit(h.repo, 'tool', { 'scripts/tool.js': '// A tool.\n' });
  const r = runGate(h, stale, { DRB_GATE_DOCS_CMD: '' });
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stderr.includes(`FAILED at ${stale.slice(0, 7)}: docs check: 1 problem(s): stale: README.md gen:tree`), r.stderr);
  assert.deepEqual(gateMarker(h).gates, ['docs']);
  render();
  git(h.repo, 'commit', '-q', '-m', 'docs regenerated');
  const fixed = git(h.repo, 'rev-parse', 'HEAD');
  const ok = runGate(h, fixed, { DRB_GATE_DOCS_CMD: '' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /PASSED at \S+ \(docs\)$/m);
  assert.equal(gateMarker(h), null);
  assertNoGateWorktree(h);
});

// Fix round 1, item 2: a stubbed run proves nothing unless DRB_GATE_ALLOW_STUBBED=1 (it dropped A).
test('sha mode: a failing run with stubs and no DRB_GATE_ALLOW_STUBBED proves nothing: the failure it stubbed past stays', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const A = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  assert.equal(runGate(h, A).status, 1);
  git(h.repo, 'push', '-q', 'origin', `${A}:refs/heads/main`); // shipped untested
  setCfg(h.smoke, { mode: 'pass' });
  setCfg(h.build, { exit: 1 });
  const D = commit(h.repo, 'server and client', { 'server/a.js': 'a v3\n', 'client/src/app.js': 'app v2\n' });
  const r = runGate(h, D, { DRB_GATE_ALLOW_STUBBED: '' });
  assert.equal(r.status, 1);
  assert.equal(records(h.rec('smoke')).length, 2, 'the stub smoke ran and passed on D');
  const m = gateMarker(h);
  assert.deepEqual([m.sha, m.gates], [D, ['client']]);
  assert.deepEqual((m.earlier || []).map((e) => [e.sha, e.gates]), [[A, ['money']]], 'a stubbed smoke never re-proves money');
});

// Fix round 1, item 5: beside and uncertain together print both warnings (the uncertain one was dropped).
test('sha mode: a failure recorded beside the standing marker while git cannot order another warns of both', (t) => {
  const h = makeRepo(t);
  git(h.repo, 'checkout', '-q', '-b', 'side', h.seed);
  const X = commit(h.repo, 'side work', { 'server/x.js': 'x\n' });
  git(h.repo, 'checkout', '-q', 'main');
  const Y = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  git(h.repo, 'merge', '-q', '--no-edit', 'side'); // X and Y both on main, neither an ancestor of the other
  const T = commit(h.repo, 'later', { 'server/t.js': 't\n' });
  const entry = (sha) => ({ sha, at: new Date().toISOString(), reason: 'client build: exit 1', gates: ['client'] });
  const file = path.join(h.repo, '.git', 'drb-markers', 'gate.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...entry(T), earlier: [entry(X)] }));
  setCfg(h.smoke, { mode: 'fail' });
  const r = runGate(h, Y);
  assert.equal(r.status, 1);
  assert.match(r.stderr, new RegExp(`the failure on ${Y.slice(0, 7)} is recorded beside the gate marker on ${T.slice(0, 7)}`));
  assert.match(r.stderr, new RegExp(`gate marker written on ${Y.slice(0, 7)} \\(git could not place it for certain\\)`));
  const m = gateMarker(h);
  assert.deepEqual([m.sha, m.earlier.map((e) => e.sha)], [T, [X, Y]]);
});

test('sha mode: the marker\'s own sha re-run with every named check passing clears it', (t) => {
  const h = makeRepo(t);
  setCfg(h.smoke, { mode: 'fail' });
  const A = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  assert.equal(runGate(h, A).status, 1);
  assert.equal(gateMarker(h).sha, A);
  setCfg(h.smoke, { mode: 'pass' });
  const r = runGate(h, A);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`cleared the gate marker on ${A.slice(0, 7)} \\(re-run on its own sha\\)`));
  assert.equal(gateMarker(h), null);
});

test('sha mode: a swept worktree\'s smoke logs are kept before it is removed', (t) => {
  const h = makeRepo(t);
  const left = path.join(h.worktrees, '.gate-1234567', '.gate-smoke');
  fs.mkdirSync(left, { recursive: true });
  fs.writeFileSync(path.join(left, 'summary.json'), '{"left": "by a crash"}\n');
  const sha = commit(h.repo, 'server', { 'server/a.js': 'a v2\n' });
  const r = runGate(h, sha);
  assert.equal(r.status, 0, r.stderr);
  const m = /swept \.gate-1234567, .*\(its smoke logs kept in (\S+)\)/.exec(r.stdout);
  assert.ok(m, r.stdout);
  assert.equal(path.dirname(m[1]), path.join(h.repo, '.git', 'drb-gate'));
  assert.match(path.basename(m[1]), /^\.gate-1234567\.smoke-swept-\d+$/);
  assert.equal(fs.readFileSync(path.join(m[1], 'summary.json'), 'utf8'), '{"left": "by a crash"}\n');
  assertNoGateWorktree(h);
});
