'use strict';

// Tests for ship's side of the sha gate's smoke reuse (scripts/ship.js and
// scripts/lib/shipFlow.js): --fresh-smoke reaches the gate, and a gate that
// reused an earlier passing smoke is named in the ship log and the result.
// Every case runs in a throwaway repo under the temp dir with a local bare
// origin and its own copy of scripts/ (kept out of git through
// .git/info/exclude), with the flip marker in its common dir and the gate a
// stub named by DRB_SHIP_GATE_CMD (ship.test.js's helpers, copied, not
// imported). Every ship is a --no-push dry run of a docs-only commit, so no
// review receipt is owed and nothing is pushed or watched. Nothing here
// touches the real repo, its common dir, origin, Neon or any provider.

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

const SCRIPTS = __dirname;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(repo, message, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(repo, 'add', '--', ...Object.keys(files));
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function copyScripts(repo) {
  const lib = path.join(repo, 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of ['sensitive-match.js', 'review-receipt.js', 'push-gate.js', 'ship.js', 'post-ship-watch.js']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(repo, 'scripts', f));
  for (const f of fs.readdirSync(path.join(SCRIPTS, 'lib'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) fs.copyFileSync(path.join(SCRIPTS, 'lib', f), path.join(lib, f));
  }
  fs.writeFileSync(path.join(repo, 'scripts', 'sensitive-paths.txt'), '# The throwaway list.\nserver/money.js\n');
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/scripts/\n/node_modules/\n/client/node_modules/\n/.husky/_/\n');
}

// The gate: records its argv, then writes a passing version 2 receipt through
// the copy's shaGate, with cfg.reused as its smoke_reused when set.
const GATE = `
const sha = process.argv[3];
const cwd = process.cwd();
const out = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
fs.appendFileSync(cfg.record, JSON.stringify(process.argv.slice(2)) + '\\n');
const SG = require(path.join(cfg.scripts, 'lib', 'shaGate.js'));
const base = out('rev-parse', 'refs/remotes/origin/main');
const cls = SG.classifyRange(base, sha, { cwd });
const at = new Date().toISOString();
const file = SG.writeShaReceipt({ version: 2, sha, tree: out('rev-parse', sha + '^{tree}'), base, files: cls.touches.files,
  gates_needed: cls.needed, gates_passed: cls.needed, nothing_to_run: cls.nothing_to_run, static_checks: null,
  node_modules: null, env_keys: [], stubbed: [], smoke_reused: cfg.reused || null, started_at: at, finished_at: at }, { cwd });
console.log(file);
`;

function makeRepo(t, { reused = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-fresh-'));
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
  const seed = commit(repo, 'seed', { 'README.md': 'readme\n', 'docs/notes.md': 'notes\n', 'server/a.js': 'a v1\n' });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  fs.writeFileSync(path.join(repo, '.git', 'drb-flip.json'), JSON.stringify({ sha: seed, pushed_at: new Date().toISOString(), written_by: 'test' }));
  const record = path.join(root, 'gate.jsonl');
  const gate = path.join(root, 'gate');
  fs.writeFileSync(gate, [`#!${process.execPath}`, "'use strict';", "const fs = require('fs');", "const path = require('path');",
    "const { execFileSync } = require('child_process');", "const cfg = JSON.parse(fs.readFileSync(__filename + '.json', 'utf8'));", GATE, ''].join('\n'), { mode: 0o755 });
  fs.writeFileSync(`${gate}.json`, JSON.stringify({ scripts: path.join(repo, 'scripts'), record, reused }));
  const sha = commit(repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  return { root, repo, sha, record, env: { ...process.env, DRB_SHIP_ALLOW_STUBS: '1', DRB_SHIP_GATE_CMD: gate, DRB_SHIP_WATCH_CMD: gate } };
}

function ship(h, args) {
  return spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'ship.js'), '--foreground', '--no-push', ...args], { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 120000 });
}

const said = (r) => `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
const gateArgv = (h) => fs.readFileSync(h.record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const LINE = /^\S+ (\S+)(?: (.*))?$/;
function texts(h, stage) {
  const lines = fs.readFileSync(path.join(h.repo, '.git', 'drb-ship', `${h.sha}.log`), 'utf8').split('\n').filter(Boolean);
  return lines.map((l) => LINE.exec(l)).filter((m) => m[1] === stage).map((m) => m[2] || '');
}

test('ship --fresh-smoke hands the gate --fresh-smoke; without it the gate gets none', (t) => {
  const h = makeRepo(t);
  const plain = ship(h, []);
  assert.equal(plain.status, 0, said(plain));
  const fresh = ship(h, ['--fresh-smoke']);
  assert.equal(fresh.status, 0, said(fresh));
  assert.deepEqual(gateArgv(h), [['sha', h.sha], ['sha', h.sha, '--fresh-smoke']]);
  assert.ok(texts(h, 'gate').includes(`DRB_SHIP_GATE_CMD on ${h.sha.slice(0, 7)} --fresh-smoke`), texts(h, 'gate').join('\n'));
});

test('ship refuses --fresh-smoke beside --status or --ack-watch', (t) => {
  const h = makeRepo(t);
  for (const args of [['--status', '--fresh-smoke'], ['--ack-watch', h.sha, '--note', 'x', '--fresh-smoke']]) {
    const r = spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'ship.js'), ...args], { cwd: h.repo, env: h.env, encoding: 'utf8' });
    assert.equal(r.status, 1, said(r));
    assert.match(r.stderr, /usage: node scripts\/ship\.js \[--no-push\] \[--foreground\] \[--fresh-smoke\]/);
  }
});

test('a gate that reused a smoke is named in the ship log and the result', (t) => {
  const tree = 'c'.repeat(40);
  const at = new Date().toISOString();
  const h = makeRepo(t, { reused: { tree, finished_at: at, summary: '/x/summary.json', reason: 'the same tree' } });
  const r = ship(h, []);
  assert.equal(r.status, 0, said(r));
  assert.ok(texts(h, 'gate').includes(`smoke reused: passed on tree ccccccc at ${at}, the same tree`), texts(h, 'gate').join('\n'));
  assert.match(texts(h, 'result')[0], /; smoke reused from tree ccccccc$/);
  assert.match(r.stdout, /gate smoke reused: passed on tree ccccccc/);
});
