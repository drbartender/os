'use strict';

// Tests for scripts/ship.js and scripts/lib/shipFlow.js (instruction rewrite
// step 3, lane ship, checks 1 to 6). Every case runs in a throwaway repo under
// the temp dir with a local bare origin, removed when the test ends. The
// throwaway carries its own copy of scripts/ (kept out of git through
// .git/info/exclude), so the primary root, the common dir, the locks, the
// markers, the receipts and the ship records are all the throwaway's; the
// flip marker is written in its common dir. Review receipts are written
// through the copy's review-receipt CLI (rangeCheck.test.js's helpers,
// copied, not imported). The sha gate, the watch and, where a case needs it,
// git's push and fetch are stubs named by DRB_SHIP_GATE_CMD,
// DRB_SHIP_WATCH_CMD and DRB_SHIP_GIT_CMD; the check 2 cases run the real
// gate with the hook installed. Nothing here touches the real repo, its
// common dir, origin, Neon, Sentry, Vercel or Render.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|DIFF_OPTS|EXTERNAL_DIFF)$/.test(k)) delete process.env[k];
  if (/^DRB_(SHIP|GATE)_/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { smokeSummary } = require('./lib/tapSummary');

const SCRIPTS = __dirname;
// A string that stands for anything a lens or a log could say: it may be
// stored, never printed.
const MARK = 'STORED-ONLY-7f3a';
const FULL_SHA = /[0-9a-f]{40}/;
const FLOORS = {
  A: ['money', 'lifecycle', 'concurrency', 'outcomes-providers', 'access-egress', 'seams'],
  B: ['seams'],
};
const CUE_ONLY = 'ship: no flip marker; pushes stay cue-only through npm run gate';
const WAIT_LINE = 'ship: a merge, a check or a ship holds the ship lock; waiting for it';
const s7 = (sha) => sha.slice(0, 7);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ago = (ms) => new Date(Date.now() - ms).toISOString();

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

// The scripts ship, the gate and the receipt CLI load, copied into
// <repo>/scripts (the throwaway's own sensitive list is written beside them).
function copyScripts(repo) {
  const lib = path.join(repo, 'scripts', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of ['sensitive-match.js', 'review-receipt.js', 'push-gate.js', 'ship.js', 'post-ship-watch.js']) fs.copyFileSync(path.join(SCRIPTS, f), path.join(repo, 'scripts', f));
  for (const f of fs.readdirSync(path.join(SCRIPTS, 'lib'))) {
    if (f.endsWith('.js') && !f.endsWith('.test.js')) fs.copyFileSync(path.join(SCRIPTS, 'lib', f), path.join(lib, f));
  }
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '/scripts/\n/node_modules/\n/client/node_modules/\n/.husky/_/\n');
}

// ---- stubs ----------------------------------------------------------------------

// A stub executable that reads its own config from <path>.json.
function stub(h, name, body, cfg) {
  const p = path.join(h.root, 'stubs', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [`#!${process.execPath}`, "'use strict';", "const fs = require('fs');", "const path = require('path');",
    "const { execFileSync, spawnSync } = require('child_process');",
    "const cfg = JSON.parse(fs.readFileSync(__filename + '.json', 'utf8'));", body, ''].join('\n'), { mode: 0o755 });
  fs.writeFileSync(`${p}.json`, JSON.stringify(cfg));
  return p;
}

function setCfg(p, patch) {
  const cur = JSON.parse(fs.readFileSync(`${p}.json`, 'utf8'));
  fs.writeFileSync(`${p}.json`, JSON.stringify({ ...cur, ...patch }));
}

function records(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// The sha gate: a passing version 2 receipt through the copy's shaGate,
// its path printed last. Modes: pass, fail (a failing receipt and the gate
// marker, exit 1), noreceipt (exit 0, nothing written), sleep (holds until a
// signal). locks: takes drb-push-gate.lock itself and probes the ship lock;
// watch_marker: sets a watch marker while it runs; unflip: removes the flip
// marker while it runs; advance: pushes a second clone's main to origin
// while it runs; clear: clears a gate marker it fixes; flag: a file it
// writes as its very last act.
const GATE = `
const sha = process.argv[3];
const cwd = process.cwd();
const lib = (n) => require(path.join(cfg.scripts, 'lib', n));
const out = (...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const rec = { argv: process.argv.slice(2), cwd, fd3: null };
try {
  rec.fd3 = fs.readlinkSync('/proc/self/fd/3');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
if (cfg.locks) {
  const common = out('rev-parse', '--path-format=absolute', '--git-common-dir');
  const fd = fs.openSync(path.join(common, 'drb-push-gate.lock'), 'a');
  rec.gate_lock = spawnSync('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd] }).status;
  rec.ship_lock = spawnSync('flock', ['-n', path.join(common, 'drb-ship.lock'), 'true']).status;
}
fs.appendFileSync(cfg.record, JSON.stringify(rec) + '\\n');
if (cfg.mode === 'sleep') {
  fs.writeFileSync(cfg.ready, String(process.pid));
  setInterval(() => {}, 1000);
  return;
}
if (cfg.watch_marker) lib('markers.js').setWatch({ sha, deploy_at: new Date().toISOString(), count: 3, by_issue: null, cwd });
if (cfg.unflip) fs.rmSync(path.join(out('rev-parse', '--path-format=absolute', '--git-common-dir'), 'drb-flip.json'));
if (cfg.advance) execFileSync('git', ['-C', cfg.advance, 'push', '-q', 'origin', 'HEAD:refs/heads/main'], { stdio: 'ignore' });
if (cfg.mode === 'noreceipt') {
  console.log('gate: the stub passed and wrote no receipt');
  process.exit(0);
}
const SG = lib('shaGate.js');
const base = out('rev-parse', 'refs/remotes/origin/main');
const cls = SG.classifyRange(base, sha, { cwd });
const at = new Date().toISOString();
const pass = cfg.mode !== 'fail';
const file = SG.writeShaReceipt({ version: 2, sha, tree: out('rev-parse', sha + '^{tree}'), base, files: cls.touches.files,
  gates_needed: cls.needed, gates_passed: pass ? cls.needed : [], nothing_to_run: cls.nothing_to_run, static_checks: null,
  node_modules: null, env_keys: [], stubbed: [], started_at: at, finished_at: at }, { cwd });
if (!pass) {
  lib('markers.js').setGate({ sha, reason: 'stub smoke failed', gates: cls.needed, cwd });
  console.error('gate: the stub FAILED');
  console.log(file);
  process.exit(1);
}
if (cfg.clear) lib('markers.js').clearGateIfDescendant(sha, { cwd, self: true });
console.log('gate: the stub PASSED');
console.log(file);
if (cfg.flag) fs.writeFileSync(cfg.flag, '');
`;

// The watch: a start line through the copy's shipLog (mode silent: none),
// then a record of its argument.
const WATCH = `
const sha = process.argv[2];
let fd3 = null;
try {
  fd3 = fs.readlinkSync('/proc/self/fd/3');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
if (cfg.mode !== 'silent') require(path.join(cfg.scripts, 'lib', 'shipLog.js')).watchLine(sha, 'start', 'stub watch', { cwd: process.cwd() });
fs.appendFileSync(cfg.record, JSON.stringify({ sha, cwd: process.cwd(), fd3 }) + '\\n');
`;

// git for the push and the fetches: real git by default; fail; reject (the
// bracketed fetch first line, exit 1); hold (wait for a signal, the caller's
// pid in the ready file); reject-hold (the line, then hold); land-fail (the
// real push, then exit 1 with no bracketed reason); sleep-push (its own pid
// in the self file, then sleep_ms, then the real push). fetch_after_push is
// the fetch mode once a push was attempted.
const GIT = `
const args = process.argv.slice(2);
fs.appendFileSync(cfg.record, JSON.stringify(args) + '\\n');
const sub = args[0];
const mode = sub === 'push' ? cfg.push : (fs.existsSync(cfg.flag) && cfg.fetch_after_push ? cfg.fetch_after_push : cfg.fetch);
if (sub === 'push') fs.writeFileSync(cfg.flag, '1');
if (mode === 'fail') {
  process.stderr.write('stub: ' + sub + ' failed\\n');
  process.exit(1);
}
if (mode === 'reject' || mode === 'reject-hold') process.stderr.write(' ! [rejected]        HEAD -> main (fetch first)\\nerror: failed to push some refs\\n');
if (mode === 'reject') process.exit(1);
if (mode === 'hold' || mode === 'reject-hold') {
  fs.writeFileSync(cfg.ready, String(process.ppid));
  setInterval(() => {}, 1000);
  return;
}
if (mode === 'sleep-push') {
  fs.writeFileSync(cfg.self, String(process.pid));
  fs.writeFileSync(cfg.ready, String(process.ppid));
  setTimeout(() => {
    const p = spawnSync('git', args, { stdio: 'inherit' });
    process.exit(p.status === null ? 1 : p.status);
  }, cfg.sleep_ms);
  return;
}
const r = spawnSync('git', args, { stdio: 'inherit' });
if (mode === 'land-fail') {
  process.stderr.write('stub: the connection dropped after the pack was sent\\n');
  process.exit(1);
}
process.exit(r.status === null ? 1 : r.status);
`;

// ---- the throwaway ------------------------------------------------------------------

function writeFlip(h, dir = h.common) {
  fs.writeFileSync(path.join(dir, 'drb-flip.json'), JSON.stringify({ sha: h.seed, pushed_at: new Date().toISOString(), written_by: 'test' }));
}

// A repo on main with a seed commit pushed to a local bare origin, the flip
// marker written, and the three stubs ready.
function makeRepo(t, { flip = true, list = ['server/money.js'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-test-'));
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
  fs.writeFileSync(path.join(repo, 'scripts', 'sensitive-paths.txt'), ['# The throwaway list.', ...list, ''].join('\n'));
  const h = { root, repo, origin, lanes: 0, common: path.join(repo, '.git') };
  h.seed = commit(repo, 'seed', { 'README.md': 'readme\n', 'docs/notes.md': 'notes\n', 'server/a.js': 'a v1\n', 'server/b.js': 'b v1\n' });
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'main');
  git(repo, 'fetch', '-q', 'origin');
  if (flip) writeFlip(h);
  h.ship = path.join(repo, 'scripts', 'ship.js');
  h.lib = (name) => require(path.join(repo, 'scripts', 'lib', name));
  h.rec = (name) => path.join(root, `${name}.jsonl`);
  const scripts = path.join(repo, 'scripts');
  h.gate = stub(h, 'gate', GATE, { scripts, record: h.rec('gate'), ready: path.join(root, 'gate-ready'), mode: 'pass' });
  h.watch = stub(h, 'watch', WATCH, { scripts, record: h.rec('watch'), mode: 'start' });
  h.git = stub(h, 'git', GIT, { record: h.rec('git'), flag: path.join(root, 'push-tried'), ready: path.join(root, 'git-ready'), self: path.join(root, 'git-self'), fetch: 'git', push: 'git' });
  h.env = { ...process.env, DRB_SHIP_ALLOW_STUBS: '1', DRB_SHIP_GATE_CMD: h.gate, DRB_SHIP_WATCH_CMD: h.watch, DRB_SHIP_FETCH_WINDOW_MS: '1500' };
  return h;
}

function ship(h, args = [], env = {}) {
  return spawnSync(process.execPath, [h.ship, '--foreground', ...args], { cwd: h.repo, env: { ...h.env, ...env }, encoding: 'utf8', timeout: 120000 });
}

function shipAsync(h, args = [], env = {}, { foreground = true } = {}) {
  const child = spawn(process.execPath, [h.ship, ...(foreground ? ['--foreground'] : []), ...args], { cwd: h.repo, env: { ...h.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  // A hard bound, so a run that never ends fails the test instead of holding it.
  const done = new Promise((resolve, reject) => {
    const bound = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ship did not end within a minute\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 60000);
    child.on('close', (status, signal) => {
      clearTimeout(bound);
      resolve({ status, signal, stdout, stderr });
    });
  });
  return { child, done };
}

const said = (r) => `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`;
const shipDir = (h) => path.join(h.common, 'drb-ship');
const originMain = (h) => git(h.origin, 'rev-parse', 'refs/heads/main');

function manifest(h, sha) {
  const p = path.join(shipDir(h), `${sha}.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function editManifest(h, sha, fn) {
  const p = path.join(shipDir(h), `${sha}.json`);
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(m);
  fs.writeFileSync(p, `${JSON.stringify(m, null, 2)}\n`);
}

function logLines(h, sha, ext = 'log') {
  const p = path.join(shipDir(h), `${sha}.${ext}`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
}

const LINE = /^\S+ (\S+)(?: (.*))?$/;
const stagesOf = (lines) => lines.map((l) => LINE.exec(l)[1]);
const textsOf = (lines, stage) => lines.map((l) => LINE.exec(l)).filter((m) => m[1] === stage).map((m) => m[2] || '');
const resultOf = (h, sha, ext) => textsOf(logLines(h, sha, ext), 'result')[0] || null;

// Every name and byte under drb-ship/, to prove a run wrote nothing.
function snapshot(h) {
  const dir = shipDir(h);
  if (!fs.existsSync(dir)) return {};
  return Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
}

// No full sha (shipLog masks one as a token) and no stored text in a ship log.
function hygiene(h, sha) {
  for (const l of logLines(h, sha)) {
    assert.ok(!FULL_SHA.test(l) && !l.includes('<TOKEN>'), `a full sha in the ship log: ${l}`);
    assert.ok(!l.includes(MARK), `a stored text in the ship log: ${l}`);
  }
}

async function waitFor(what, fn, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const watchedFor = (h, sha) => records(h.rec('watch')).filter((r) => r.sha === sha);
const gateRuns = (h) => records(h.rec('gate'));
const gitCalls = (h, sub) => records(h.rec('git')).filter((a) => a[0] === sub);

// ---- review receipts through the copy's CLI (rangeCheck.test.js's helpers) -------

function cli(h, ...args) {
  const r = spawnSync(process.execPath, [path.join(h.repo, 'scripts', 'review-receipt.js'), ...args], { cwd: h.repo, encoding: 'utf8', env: { ...process.env, REVIEW_RECEIPT_ROOT: h.repo } });
  assert.equal(r.status, 0, `review-receipt ${args[0]} exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r.stdout;
}

function report(rows) {
  return [`Read the brief. ${MARK}`, '', '', '| file | verdict | note |', '|---|---|---|', ...rows.map(([f, v, n = '']) => `| ${f} | ${v} | ${n} |`), ''].join('\n');
}

function tap(pass) {
  return ['TAP version 13', `# ${MARK} something the suite printed`, `ok 1 - a test # ${MARK}`, `1..${pass}`, `# tests ${pass}`, '# suites 0',
    `# pass ${pass}`, '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0', '# duration_ms 5', ''].join('\n');
}

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

function review(h, name, files, tier) {
  const seq = /^position (\d+) /m.exec(cli(h, 'position', name))[1];
  for (const lens of FLOORS[tier]) cli(h, 'verdicts', name, lens, scratch(h, `${lens}.md`, report(files.map((f) => [f, 'pass']))), '--position', seq);
  cli(h, 'tests', name, '--suites', runDir(h, [{ file: 'server/a.test.js', text: tap(4) }]), '--position', seq);
  if (tier === 'A') {
    cli(h, 'tests', name, '--smoke', runDir(h, [{ file: 'server/m1.test.js', text: tap(10) }]), '--position', seq);
    cli(h, 'verify', name, scratch(h, 'verify.md', `No findings.\nChecked the lane. ${MARK}\n`), '--position', seq);
    cli(h, 'externals', name, 'codex=run', `gemini=not_run:quota ${MARK}`);
  }
}

// A lane commit off main, reviewed at `tier` through the CLI and finalized,
// then main fast-forwarded onto it -> {sha, dir, key}.
function landLane(h, files, { tier = 'B', message } = {}) {
  const lane = `lane-${++h.lanes}`;
  const base = git(h.repo, 'rev-parse', 'main');
  git(h.repo, 'checkout', '-q', '-b', lane);
  const sha = commit(h.repo, message || `${lane} work`, files);
  cli(h, 'init', '--branch', lane);
  review(h, lane, Object.keys(files), tier);
  const SM = require(path.join(h.repo, 'scripts', 'sensitive-match.js'));
  const select = scratch(h, 'select.json', JSON.stringify({ tier, tiers_by_file: SM.tierFromGit({ base, tip: sha }, { cwd: h.repo }).tiersByFile }));
  const out = cli(h, 'finalize', lane, '--kind', 'lane', '--base', base, '--reviewed-against', base, '--tier', tier, '--select', select, '--not-a-fix', 'a feature');
  git(h.repo, 'checkout', '-q', 'main');
  git(h.repo, 'merge', '-q', '--ff-only', lane);
  const dir = /dir: (\S+)/.exec(out)[1];
  return { sha, dir, key: path.basename(dir) };
}

// Main pushed to origin by hand: an earlier window's push.
function pushByHand(h) {
  git(h.repo, 'push', '-q', 'origin', 'main');
  git(h.repo, 'fetch', '-q', 'origin');
}

// A record of `sha` whose push started and has no result, the way a run that
// died leaves it: pushed (pushed_at set too), a claim (fresh or stale) and a
// watch line as asked.
function stuck(h, sha, { pushed = false, claim = null, watchLine = false } = {}) {
  const L = h.lib('shipLog.js');
  const o = { cwd: h.repo };
  L.open(sha, { cwd: h.repo, base: h.seed, commits: [{ sha, subject: 'stuck work' }], docs_only: true, touches_server: false, touches_client: false });
  L.setManifest(sha, { push_started_at: ago(5 * 60000), ...(pushed ? { pushed_at: ago(4 * 60000) } : {}) }, o);
  if (claim) L.claimWatch(sha, o);
  if (claim === 'stale') editManifest(h, sha, (m) => { m.watch_started_at = ago(2 * 60000); });
  if (watchLine) L.watchLine(sha, 'start', 'an earlier watch', o);
}

// ---- check 1: the flow ------------------------------------------------------------

test('without the flip marker, --foreground and the detached form refuse with the cue-only line, push nothing and write nothing', (t) => {
  const h = makeRepo(t, { flip: false });
  commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.equal(r.stdout.trim(), CUE_ONLY);
  const d = spawnSync(process.execPath, [h.ship], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  assert.equal(d.status, 1, said(d));
  assert.equal(d.stdout.trim(), CUE_ONLY);
  assert.equal(originMain(h), h.seed);
  assert.equal(fs.existsSync(shipDir(h)), false, 'no drb-ship directory');
  assert.equal(fs.existsSync(path.join(h.common, 'drb-ship.lock')), false, 'no lock file either');
  assert.deepEqual(gateRuns(h), []);
});

test('an unreadable flip marker refuses with its line; a cwd that is not the primary worktree on main refuses with one line', (t) => {
  const h = makeRepo(t);
  fs.writeFileSync(path.join(h.common, 'drb-flip.json'), '{"sha": ');
  const torn = ship(h);
  assert.equal(torn.status, 1, said(torn));
  assert.match(torn.stdout, /^BLOCKED: the flip marker .* is unreadable; repair or remove it by hand$/m);
  writeFlip(h);
  git(h.repo, 'checkout', '-q', '-b', 'side');
  const side = ship(h);
  assert.equal(side.status, 1, said(side));
  assert.equal(side.stdout.trim(), 'ship: HEAD is on refs/heads/side, not on main; ship ships main only');
  git(h.repo, 'checkout', '-q', 'main');
  const lane = path.join(h.root, 'lane');
  git(h.repo, 'worktree', 'add', '-q', '-b', 'lane-x', lane);
  const linked = spawnSync(process.execPath, [h.ship, '--foreground'], { cwd: lane, env: h.env, encoding: 'utf8' });
  assert.equal(linked.status, 1, said(linked));
  assert.match(linked.stdout, /not the primary worktree/);
  assert.equal(fs.existsSync(shipDir(h)), false);
  assert.deepEqual(gateRuns(h), []);
});

const stubLine = (k) => `ship: ${k} is set; the test overrides run only with DRB_SHIP_ALLOW_STUBS=1, never in a real ship`;

test('a command override set without DRB_SHIP_ALLOW_STUBS=1 refuses before anything is written, in the foreground and the detached forms', (t) => {
  const h = makeRepo(t);
  commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  const run = (args, env) => spawnSync(process.execPath, [h.ship, ...args], { cwd: h.repo, env: { ...process.env, ...env }, encoding: 'utf8' });
  for (const [k, v] of [['DRB_SHIP_GATE_CMD', h.gate], ['DRB_SHIP_WATCH_CMD', h.watch], ['DRB_SHIP_GIT_CMD', h.git]]) {
    for (const args of [['--foreground'], []]) {
      const r = run(args, { [k]: v });
      assert.equal(r.status, 1, `${k} ${args.join(' ') || 'detached'}: ${said(r)}`);
      assert.equal(r.stdout.trim(), stubLine(k));
    }
  }
  // Exactly 1: any other value is no allowance, and each set override has its line.
  const two = run(['--foreground'], { DRB_SHIP_GATE_CMD: h.gate, DRB_SHIP_GIT_CMD: h.git, DRB_SHIP_ALLOW_STUBS: 'yes' });
  assert.equal(two.status, 1, said(two));
  assert.deepEqual(two.stdout.trim().split('\n'), [stubLine('DRB_SHIP_GATE_CMD'), stubLine('DRB_SHIP_GIT_CMD')]);
  assert.equal(fs.existsSync(shipDir(h)), false, 'no drb-ship directory, no record');
  assert.equal(fs.existsSync(path.join(h.common, 'drb-ship.lock')), false);
  assert.deepEqual([gateRuns(h), records(h.rec('git')), records(h.rec('watch'))], [[], [], []]);
  assert.equal(originMain(h), h.seed);
});

test('shipFlow refuses a command override set without the allow variable before it reads anything, for a caller that runs it directly', async (t) => {
  const h = makeRepo(t);
  const { shipFlow } = h.lib('shipFlow.js');
  process.env.DRB_SHIP_GATE_CMD = h.gate;
  t.after(() => { delete process.env.DRB_SHIP_GATE_CMD; });
  const lines = [];
  const res = await shipFlow({ cwd: h.repo, log: (l) => lines.push(l) });
  assert.deepEqual([res.state, res.code], ['refused', 1]);
  assert.equal(lines[0], stubLine('DRB_SHIP_GATE_CMD'));
  assert.equal(fs.existsSync(shipDir(h)), false);
  assert.deepEqual(gateRuns(h), []);
});

test('a server/ commit with a lane receipt ships through the stub gate: the remote moves, the watch runs with the sha, the log ends result ok', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.equal(originMain(h), lane.sha);
  const lines = logLines(h, lane.sha);
  assert.deepEqual(stagesOf(lines), ['start', 'fetch', 'range', 'receipts', 'gate', 'gate', 'push', 'push', 'watch', 'result']);
  assert.equal(textsOf(lines, 'start')[0], `ship ${s7(lane.sha)} on main; test overrides in effect: DRB_SHIP_GATE_CMD, DRB_SHIP_WATCH_CMD`);
  assert.equal(textsOf(lines, 'range')[0], `1 commits: ${s7(lane.sha)} lane-1 work`);
  assert.equal(resultOf(h, lane.sha), `ok pushed ${s7(lane.sha)}, 1 commits`);
  assert.match(r.stdout, new RegExp(`^ship: result ok pushed ${s7(lane.sha)}, 1 commits$`, 'm'));
  const m = manifest(h, lane.sha);
  for (const k of ['push_started_at', 'pushed_at', 'watch_started_at']) assert.ok(m[k], k);
  assert.equal(m.push_unknown_at, null);
  assert.deepEqual(m.result.state, 'ok');
  assert.deepEqual([m.docs_only, m.touches_server, m.touches_client], [false, true, false]);
  assert.deepEqual(m.commits, [{ sha: lane.sha, subject: 'lane-1 work' }]);
  // A path key keeps its full-sha runs and masks every other shape in it.
  const raw = path.join(h.lib('receipt.js').commonDir({ cwd: h.repo }), 'drb-gate', `${lane.sha}.json`);
  assert.deepEqual(m.gate, { receipt: raw.split(lane.sha).map((part) => h.lib('piiShapes.js').mask(part)).join(lane.sha), result: 'ok' });
  assert.deepEqual(gateRuns(h).map((g) => g.argv), [['sha', lane.sha]]);
  assert.equal(fs.realpathSync(gateRuns(h)[0].cwd), fs.realpathSync(h.repo));
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
  const lock = fs.realpathSync(path.join(h.lib('receipt.js').commonDir({ cwd: h.repo }), 'drb-ship.lock'));
  assert.equal(gateRuns(h)[0].fd3, lock, 'the gate holds the ship lock\'s descriptor');
  assert.notEqual(watchedFor(h, lane.sha)[0].fd3, lock, 'the detached watch never holds it');
  assert.equal(h.lib('shipLog.js').inFlight({ cwd: h.repo }), null);
  hygiene(h, lane.sha);
});

test('two commits in the range are both listed and the result says 2', (t) => {
  const h = makeRepo(t);
  const one = landLane(h, { 'server/a.js': 'a v2\n' });
  const two = commit(h.repo, 'more notes', { 'docs/notes.md': 'notes v3\n' });
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.equal(originMain(h), two);
  assert.equal(textsOf(logLines(h, two), 'range')[0], `2 commits: ${s7(one.sha)} lane-1 work; ${s7(two)} more notes`);
  assert.equal(resultOf(h, two), `ok pushed ${s7(two)}, 2 commits`);
  assert.equal(textsOf(logLines(h, two), 'receipts')[0], '2 commits: 1 docs-only, 1 with a receipt');
  hygiene(h, two);
});

test('a server/ commit with no receipt is refused naming its sha, before the gate, and nothing is pushed', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'server work', { 'server/a.js': 'a v2\n' });
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.match(resultOf(h, sha), new RegExp(`^refused ${s7(sha)}: no review receipt`));
  assert.match(r.stdout, new RegExp(`^ {2}- ${s7(sha)}: no review receipt`, 'm'));
  assert.deepEqual(gateRuns(h), []);
  assert.equal(originMain(h), h.seed);
  assert.equal(manifest(h, sha).push_started_at, null);
  hygiene(h, sha);
});

test('a gate marker HEAD does not fix forward refuses before the gate: one git cannot place, and an unreadable one', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  // Any readable marker on a sha that left main is fixed by any sha on main,
  // and one on main is an ancestor of HEAD; only a sha git cannot place (a
  // broken alternate turns its miss into an error) is never fixed forward.
  fs.mkdirSync(path.join(h.common, 'drb-markers'), { recursive: true });
  const ghost = ['ab', 'cd'].join('').repeat(10);
  fs.writeFileSync(path.join(h.common, 'drb-markers', 'gate.json'), JSON.stringify({ sha: ghost, at: new Date().toISOString(), reason: 'stub smoke failed', gates: ['money'], on_main: true }));
  fs.mkdirSync(path.join(h.common, 'objects', 'info'), { recursive: true });
  fs.writeFileSync(path.join(h.common, 'objects', 'info', 'alternates'), `${path.join(h.root, 'no-such-store')}\n`);
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.match(resultOf(h, lane.sha), /^refused BLOCKED: gate marker stands on abcdabc \(stub smoke failed\)/);
  fs.rmSync(path.join(h.common, 'objects', 'info', 'alternates'));
  fs.writeFileSync(path.join(h.common, 'drb-markers', 'gate.json'), '{"sha": ');
  const torn = ship(h);
  assert.equal(torn.status, 1, said(torn));
  assert.match(resultOf(h, lane.sha), /^refused BLOCKED: gate marker stands \(unreadable marker /);
  assert.deepEqual(gateRuns(h), []);
  assert.equal(originMain(h), h.seed);
});

test('a gate marker on HEAD\'s parent is fixed forward: the gate runs, its pass clears the marker, and the ship goes on', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const marker = path.join(h.common, 'drb-markers', 'gate.json');
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ sha: h.seed, at: new Date().toISOString(), reason: 'stub smoke failed', gates: ['money'], on_main: true }));
  // A pass that does not clear it still refuses, right before the push.
  const kept = ship(h);
  assert.equal(kept.status, 1, said(kept));
  assert.equal(gateRuns(h).length, 1, 'the gate ran');
  assert.match(resultOf(h, lane.sha), /^refused BLOCKED: gate marker stands on /);
  assert.equal(manifest(h, lane.sha).push_started_at, null);
  assert.equal(originMain(h), h.seed);
  setCfg(h.gate, { clear: true });
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.equal(fs.existsSync(marker), false, 'the pass cleared the marker');
  assert.match(textsOf(logLines(h, lane.sha), 'gate')[0], /fixes it forward/);
  assert.equal(originMain(h), lane.sha);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

test('a gate marker on HEAD itself is a re-test: the gate runs again on that sha and a pass that clears it ships', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.gate, { mode: 'fail' });
  assert.equal(ship(h).status, 1);
  const marker = path.join(h.common, 'drb-markers', 'gate.json');
  assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).sha, lane.sha);
  setCfg(h.gate, { mode: 'pass', clear: true });
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.equal(gateRuns(h).length, 2, 'the gate ran on the marker\'s own sha');
  assert.equal(fs.existsSync(marker), false);
  assert.equal(originMain(h), lane.sha);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

test('a standing watch marker refuses with the ack line, before the gate', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  h.lib('markers.js').setWatch({ sha: h.seed, deploy_at: new Date().toISOString(), count: 2, by_issue: null, cwd: h.repo });
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.equal(resultOf(h, lane.sha), `refused BLOCKED: watch marker stands on ${s7(h.seed)} (2 events since deploy); read them, then npm run ship -- --ack-watch ${s7(h.seed)} --note <what you saw and decided>`);
  assert.deepEqual(gateRuns(h), []);
  assert.equal(originMain(h), h.seed);
});

test('--ack-watch clears the marker for its sha, writes the ack line and pushes nothing; another sha, or none standing, is refused', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  assert.equal(ship(h).status, 0);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
  h.lib('markers.js').setWatch({ sha: lane.sha, deploy_at: new Date().toISOString(), count: 3, by_issue: null, cwd: h.repo });
  const ack = (sha, note) => spawnSync(process.execPath, [h.ship, '--ack-watch', sha, '--note', note], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  const other = ack(s7(h.seed), 'not this one');
  assert.equal(other.status, 1, said(other));
  assert.match(other.stdout, new RegExp(`^BLOCKED: watch marker stands on ${s7(lane.sha)}`));
  const before = originMain(h);
  const r = ack(s7(lane.sha), 'read the three events; all from an old client build');
  assert.equal(r.status, 0, said(r));
  assert.equal(fs.existsSync(path.join(h.common, 'drb-markers', 'watch.json')), false);
  const lines = logLines(h, lane.sha);
  assert.equal(stagesOf(lines).pop(), 'ack');
  assert.equal(textsOf(lines, 'ack')[0], 'read the three events; all from an old client build');
  const acks = fs.readFileSync(path.join(h.common, 'drb-markers', 'acks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(acks.map((a) => [a.sha, a.note]), [[lane.sha, 'read the three events; all from an old client build']]);
  assert.equal(originMain(h), before);
  const none = ack(s7(lane.sha), 'again');
  assert.equal(none.status, 1);
  assert.equal(none.stdout.trim(), 'ship: no watch marker stands; nothing to ack');
});

test('a stub gate that exits 1 is failed with the gates it did not pass; the marker it set stands and nothing is pushed', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.gate, { mode: 'fail' });
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.equal(resultOf(h, lane.sha), `failed gate failed at ${s7(lane.sha)} (exit 1); not passed: money`);
  const marker = JSON.parse(fs.readFileSync(path.join(h.common, 'drb-markers', 'gate.json'), 'utf8'));
  assert.equal(marker.sha, lane.sha);
  assert.equal(manifest(h, lane.sha).gate.result, 'failed');
  assert.equal(manifest(h, lane.sha).push_started_at, null);
  assert.equal(originMain(h), h.seed);
});

test('a stub gate that exits 0 without writing a receipt ends failed before any push', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.gate, { mode: 'noreceipt' });
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.equal(resultOf(h, lane.sha), `failed the gate exited 0 at ${s7(lane.sha)}, but the hook would refuse its receipt: no sha receipt (run: npm run ship)`);
  assert.deepEqual(manifest(h, lane.sha).gate, { receipt: null, result: 'failed' });
  assert.equal(manifest(h, lane.sha).push_started_at, null);
  assert.equal(originMain(h), h.seed);
});

test('a watch marker that appears while the gate runs refuses right before the push stamp', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.gate, { watch_marker: true });
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.match(resultOf(h, lane.sha), new RegExp(`^refused BLOCKED: watch marker stands on ${s7(lane.sha)} \\(3 events since deploy\\)`));
  assert.equal(manifest(h, lane.sha).gate.result, 'ok');
  assert.equal(manifest(h, lane.sha).push_started_at, null);
  assert.equal(originMain(h), h.seed);
});

test('a flip marker removed while the gate runs refuses with the cue-only line before the push stamp', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.gate, { unflip: true });
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.equal(resultOf(h, lane.sha), `refused ${CUE_ONLY}`);
  assert.equal(manifest(h, lane.sha).push_started_at, null);
  assert.equal(originMain(h), h.seed);
});

test('a sha already on the remote is pushed-elsewhere with no gate and no push; run again, its record stands and nothing is written', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  pushByHand(h);
  const r = ship(h, [], { DRB_SHIP_GIT_CMD: h.git });
  assert.equal(r.status, 0, said(r));
  assert.equal(resultOf(h, sha), `pushed-elsewhere ${s7(sha)} is already on origin/main; another push carried it`);
  assert.deepEqual(stagesOf(logLines(h, sha)), ['start', 'fetch', 'result']);
  assert.deepEqual(gateRuns(h), []);
  assert.deepEqual(gitCalls(h, 'push'), []);
  assert.deepEqual(watchedFor(h, sha), []);
  const before = snapshot(h);
  const again = ship(h);
  assert.equal(again.status, 0, said(again));
  assert.match(again.stdout, /result pushed-elsewhere .*\(its record stands at pushed-elsewhere; nothing written\)/);
  assert.deepEqual(snapshot(h), before);
});

test('a rejected push is failed with the bracketed reason, no retry and pushed_at null, and the same sha opens again', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const other = path.join(h.root, 'other');
  git(h.root, 'clone', '-q', h.origin, other);
  git(other, 'config', 'user.email', ['other', 'example.com'].join('@'));
  git(other, 'config', 'user.name', 'Other Window');
  commit(other, 'another window', { 'docs/other.md': 'other\n' });
  setCfg(h.gate, { advance: other });
  const r = ship(h, [], { DRB_SHIP_GIT_CMD: h.git });
  assert.equal(r.status, 1, said(r));
  assert.equal(resultOf(h, lane.sha), 'failed push rejected (fetch first): origin/main moved since the fetch; nothing was pushed and nothing is retried');
  const m = manifest(h, lane.sha);
  assert.ok(m.push_started_at);
  assert.deepEqual([m.pushed_at, m.push_unknown_at], [null, null]);
  assert.equal(gitCalls(h, 'push').length, 1, 'no retry');
  assert.equal(gitCalls(h, 'fetch').length, 1, 'no fetch after a rejection');
  assert.equal(git(h.repo, 'rev-parse', 'main'), lane.sha, 'the local branch is unchanged');
  setCfg(h.gate, { advance: null });
  const again = ship(h);
  assert.equal(again.status, 1, said(again));
  const aside = fs.readdirSync(shipDir(h)).filter((f) => f.startsWith(`${lane.sha}.prev-`) && f.endsWith('.json'));
  assert.equal(aside.length, 1, 'the rejected record moved aside');
  assert.match(resultOf(h, lane.sha), /is not an ancestor of/);
});

test('--no-push runs everything but the push and the watch and ends ok-no-push; the real ship of the same HEAD opens normally after it', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const dry = ship(h, ['--no-push'], { DRB_SHIP_GIT_CMD: h.git });
  assert.equal(dry.status, 0, said(dry));
  assert.equal(resultOf(h, lane.sha), `ok-no-push dry run of ${s7(lane.sha)}, 1 commits: gated, not pushed and not watched`);
  assert.equal(textsOf(logLines(h, lane.sha), 'start')[0], `ship ${s7(lane.sha)} on main, a dry run (--no-push); test overrides in effect: DRB_SHIP_GATE_CMD, DRB_SHIP_WATCH_CMD, DRB_SHIP_GIT_CMD`);
  assert.equal(gateRuns(h).length, 1);
  assert.deepEqual(gitCalls(h, 'push'), []);
  assert.equal(originMain(h), h.seed);
  const m = manifest(h, lane.sha);
  assert.deepEqual([m.push_started_at, m.watch_started_at], [null, null]);
  await sleep(300);
  assert.deepEqual(watchedFor(h, lane.sha), []);
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.equal(resultOf(h, lane.sha), `ok pushed ${s7(lane.sha)}, 1 commits`);
  assert.equal(originMain(h), lane.sha);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

test('DRB_SHIP_LOCK naming a lock the caller holds runs the flow inside it, with no wait', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.gate, { locks: true });
  const lock = path.join(h.lib('receipt.js').commonDir({ cwd: h.repo }), 'drb-ship.lock');
  const r = spawnSync('bash', ['-c', 'lock="$1"; shift; exec flock "$lock" env "DRB_SHIP_LOCK_PID=$$" "$@"', 'bash', lock, process.execPath, h.ship, '--foreground'],
    { cwd: h.repo, env: { ...h.env, DRB_SHIP_LOCK: lock }, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, said(r));
  assert.ok(!r.stderr.includes(WAIT_LINE), r.stderr);
  assert.equal(gateRuns(h)[0].ship_lock, 1, 'the caller held the ship lock while the flow ran');
  // A caller running ship under flock(1) passes its descriptor down, and ship hands it on.
  assert.equal(gateRuns(h)[0].fd3, fs.realpathSync(lock), 'the gate holds the caller\'s lock descriptor as its fd 3');
  assert.equal(originMain(h), lane.sha);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

test('the unknown arm: a push that fails with no bracketed reason, then a fetch that fails or still lacks the sha, leaves no result, push_unknown_at set and exit 2', (t) => {
  for (const after of ['fail', 'git']) {
    const h = makeRepo(t);
    const lane = landLane(h, { 'server/a.js': 'a v2\n' });
    setCfg(h.git, { push: 'fail', fetch_after_push: after });
    const r = ship(h, [], { DRB_SHIP_GIT_CMD: h.git });
    assert.equal(r.status, 2, `${after}: ${said(r)}`);
    const m = manifest(h, lane.sha);
    assert.ok(m.push_started_at && m.push_unknown_at, after);
    assert.deepEqual([m.pushed_at, m.result], [null, null], after);
    assert.equal(resultOf(h, lane.sha), null, `${after}: no result line`);
    assert.match(textsOf(logLines(h, lane.sha), 'push').pop(), /is unknown \(exit 1; no fetch found it on origin\/main in 2 seconds\); run npm run ship again to complete it/);
    assert.ok(gitCalls(h, 'fetch').length >= 2, `${after}: the window fetched`);
    assert.equal(h.lib('shipLog.js').inFlight({ cwd: h.repo }), null, after);
    assert.equal(originMain(h), h.seed);
  }
});

test('the completion: the same HEAD run again ends ok when the sha is on the remote, and failed push did not land when it is not', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.git, { push: 'fail', fetch_after_push: 'fail' });
  assert.equal(ship(h, [], { DRB_SHIP_GIT_CMD: h.git }).status, 2);
  const startedAt = manifest(h, lane.sha).push_started_at;
  git(h.repo, 'push', '-q', 'origin', 'main');
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  const m = manifest(h, lane.sha);
  assert.equal(m.push_started_at, startedAt, 'push_started_at stays the lower bound');
  assert.ok(m.pushed_at && m.watch_started_at);
  assert.equal(resultOf(h, lane.sha), `ok pushed ${s7(lane.sha)}, 1 commits; completed by a later run`);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
  assert.match(r.stdout, /result pushed-elsewhere .*its record stands at ok/);

  const g = makeRepo(t);
  const other = landLane(g, { 'server/a.js': 'a v2\n' });
  setCfg(g.git, { push: 'fail', fetch_after_push: 'fail' });
  assert.equal(ship(g, [], { DRB_SHIP_GIT_CMD: g.git }).status, 2);
  const again = ship(g);
  assert.equal(again.status, 0, said(again));
  const aside = fs.readdirSync(shipDir(g)).filter((f) => f.startsWith(`${other.sha}.prev-`) && f.endsWith('.log'));
  assert.equal(aside.length, 1);
  const prior = fs.readFileSync(path.join(shipDir(g), aside[0]), 'utf8').trim().split('\n');
  assert.match(prior.pop(), /result failed push did not land$/);
  assert.equal(resultOf(g, other.sha), `ok pushed ${s7(other.sha)}, 1 commits`);
  assert.equal(originMain(g), other.sha);
  await waitFor('the watch stub', () => watchedFor(g, other.sha).length === 1);
});

test('a record with pushed_at and a claim but no result: ended ok with no second watch when its watch wrote, re-watched when the claim is stale and the watch log empty, left unsettled when the claim is fresh', async (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  pushByHand(h);
  stuck(h, sha, { pushed: true, claim: 'fresh', watchLine: true });
  const pushedAt = manifest(h, sha).pushed_at;
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.match(resultOf(h, sha), /^ok pushed .*completed by a later run$/);
  assert.equal(manifest(h, sha).pushed_at, pushedAt, 'pushed_at is never stamped again');
  await sleep(300);
  assert.deepEqual(watchedFor(h, sha), [], 'no second watch');

  const g = makeRepo(t);
  const stale = commit(g.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  pushByHand(g);
  stuck(g, stale, { pushed: true, claim: 'stale' });
  const claimed = manifest(g, stale).watch_started_at;
  const s = ship(g);
  assert.equal(s.status, 0, said(s));
  await waitFor('the watch stub', () => watchedFor(g, stale).length === 1);
  assert.notEqual(manifest(g, stale).watch_started_at, claimed, 'claimed again');
  assert.match(resultOf(g, stale), /^ok /);

  const f = makeRepo(t);
  const fresh = commit(f.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  pushByHand(f);
  stuck(f, fresh, { pushed: true, claim: 'fresh' });
  const p = ship(f);
  assert.equal(p.status, 2, said(p));
  assert.equal(resultOf(f, fresh), null);
  assert.equal(textsOf(logLines(f, fresh), 'watch')[0], `watch claim pending for ${s7(fresh)}; run npm run ship again in a minute`);
  await sleep(300);
  assert.deepEqual(watchedFor(f, fresh), []);
});

test('a settled ok record whose claim is stale with an empty watch log is re-watched by the opening pass, with nothing written to its logs', async (t) => {
  const h = makeRepo(t);
  const old = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  pushByHand(h);
  const L = h.lib('shipLog.js');
  stuck(h, old, { pushed: true, claim: 'fresh' });
  L.setResult(old, 'ok', 'pushed earlier', { cwd: h.repo });
  editManifest(h, old, (m) => { m.watch_started_at = ago(2 * 60000); });
  assert.deepEqual(L.unwatched({ cwd: h.repo }).map((e) => [e.sha, e.state]), [[old, 'never-started']]);
  const before = fs.readFileSync(path.join(shipDir(h), `${old}.log`), 'utf8');
  const head = commit(h.repo, 'more notes', { 'docs/notes.md': 'notes v3\n' });
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.match(r.stdout, new RegExp(`^ship: re-watching ${s7(old)} \\(its watch never started\\)$`, 'm'));
  await waitFor('the re-watch', () => watchedFor(h, old).length === 1);
  assert.equal(fs.readFileSync(path.join(shipDir(h), `${old}.log`), 'utf8'), before, 'nothing written to its ship log');
  assert.deepEqual(logLines(h, old, 'watch.log').map((l) => LINE.exec(l)[2]), ['stub watch'], 'only the watch\'s own start line');
  assert.equal(originMain(h), head);
});

test('a watch command that cannot be spawned leaves the record result-less, exit 2', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const r = ship(h, [], { DRB_SHIP_WATCH_CMD: path.join(h.root, 'no-such-watch') });
  assert.equal(r.status, 2, said(r));
  const m = manifest(h, lane.sha);
  assert.ok(m.pushed_at && m.watch_started_at);
  assert.deepEqual([m.result, m.push_unknown_at], [null, null]);
  assert.match(textsOf(logLines(h, lane.sha), 'push').pop(), /landed; the run ended \(the watch for \S+ could not start \(ENOENT\)\) before its watch and result/);
  assert.equal(originMain(h), lane.sha);
});

test('a watch that runs and exits before writing a line ends ok, is listed by unwatched a minute later and re-watched by the next run', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.watch, { mode: 'silent' });
  assert.equal(ship(h).status, 0);
  assert.match(resultOf(h, lane.sha), /^ok /);
  await waitFor('the silent watch', () => watchedFor(h, lane.sha).length === 1);
  const L = h.lib('shipLog.js');
  assert.deepEqual(L.unwatched({ cwd: h.repo }), [], 'a fresh claim is not stale yet');
  editManifest(h, lane.sha, (m) => { m.watch_started_at = ago(61 * 1000); });
  assert.deepEqual(L.unwatched({ cwd: h.repo }).map((e) => [e.sha, e.state]), [[lane.sha, 'never-started']]);
  setCfg(h.watch, { mode: 'start' });
  commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  await waitFor('the re-watch', () => watchedFor(h, lane.sha).length === 2);
});

test('a stop signal during the opening fetch, with HEAD\'s earlier settled record standing, writes nothing and exits 1', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  assert.equal(ship(h, ['--no-push']).status, 0);
  const before = snapshot(h);
  setCfg(h.git, { fetch: 'hold' });
  const run = shipAsync(h, [], { DRB_SHIP_GIT_CMD: h.git });
  const pid = Number(await waitFor('the held fetch', () => fs.existsSync(path.join(h.root, 'git-ready')) && fs.readFileSync(path.join(h.root, 'git-ready'), 'utf8')));
  process.kill(pid, 'SIGTERM');
  const r = await run.done;
  assert.equal(r.status, 1, said(r));
  assert.match(r.stdout, /result failed killed by SIGTERM; no record was opened and nothing was written/);
  assert.deepEqual(snapshot(h), before, 'the earlier record is byte-identical');
  assert.equal(resultOf(h, lane.sha), `ok-no-push dry run of ${s7(lane.sha)}, 1 commits: gated, not pushed and not watched`);
});

test('a stop signal after this run\'s own rejection keeps the failed result, exit 1, with no unknown line', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.git, { push: 'reject-hold' });
  const run = shipAsync(h, [], { DRB_SHIP_GIT_CMD: h.git });
  const pid = Number(await waitFor('the held push', () => fs.existsSync(path.join(h.root, 'git-ready')) && fs.readFileSync(path.join(h.root, 'git-ready'), 'utf8')));
  process.kill(pid, 'SIGTERM');
  const r = await run.done;
  assert.equal(r.status, 1, said(r));
  assert.match(resultOf(h, lane.sha), /^failed push rejected \(fetch first\)/);
  assert.equal(manifest(h, lane.sha).push_unknown_at, null);
  assert.ok(!logLines(h, lane.sha).some((l) => /unknown/.test(l)), 'no unknown line');
});

test('a stop signal after push_started_at stops the push, leaves no result and stamps push_unknown_at, exit 2', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.git, { push: 'hold' });
  const run = shipAsync(h, [], { DRB_SHIP_GIT_CMD: h.git });
  const pid = Number(await waitFor('the held push', () => fs.existsSync(path.join(h.root, 'git-ready')) && fs.readFileSync(path.join(h.root, 'git-ready'), 'utf8')));
  process.kill(pid, 'SIGTERM');
  const r = await run.done;
  assert.equal(r.status, 2, said(r));
  const m = manifest(h, lane.sha);
  assert.ok(m.push_started_at && m.push_unknown_at);
  assert.deepEqual([m.pushed_at, m.result], [null, null]);
  assert.match(textsOf(logLines(h, lane.sha), 'push').pop(), /is unknown \(killed by SIGTERM\); run npm run ship again to complete it/);
});

test('a throw while completing a record (its watch cannot start) leaves it result-less and ends the run unknown, exit 2', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  pushByHand(h);
  stuck(h, sha);
  const r = ship(h, [], { DRB_SHIP_WATCH_CMD: path.join(h.root, 'no-such-watch') });
  assert.equal(r.status, 2, said(r));
  const m = manifest(h, sha);
  assert.ok(m.pushed_at, 'the sha was found on origin/main and stamped');
  assert.equal(m.result, null);
  assert.equal(resultOf(h, sha), null);
  assert.match(r.stdout, /result unknown the run ended \(the watch for \S+ could not start \(ENOENT\)\) while completing/);
});

test('a ship killed with SIGKILL keeps the ship lock until its orphaned push ends; the next ship then completes the push that landed', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.git, { push: 'sleep-push', sleep_ms: 3000 });
  const lock = path.join(h.lib('receipt.js').commonDir({ cwd: h.repo }), 'drb-ship.lock');
  const probe = () => spawnSync('flock', ['-n', lock, 'true']).status;
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
      return false;
    }
  };
  const first = shipAsync(h, [], { DRB_SHIP_GIT_CMD: h.git });
  const parent = Number(await waitFor('the sleeping push', () => fs.existsSync(path.join(h.root, 'git-ready')) && fs.readFileSync(path.join(h.root, 'git-ready'), 'utf8')));
  const push = Number(fs.readFileSync(path.join(h.root, 'git-self'), 'utf8'));
  // The locked run is the record's opener, the push's parent.
  const locked = manifest(h, lane.sha).pid;
  assert.equal(parent, locked);
  process.kill(locked, 'SIGKILL');
  const killed = await first.done;
  assert.notEqual(killed.status, 0, said(killed));
  assert.equal(alive(push), true, 'the push outlives its run');
  assert.equal(probe(), 1, 'and holds the ship lock while it runs');
  await waitFor('the orphaned push to end', () => !alive(push), 20000);
  assert.equal(probe(), 0, 'the lock is free once the push ended');
  assert.equal(originMain(h), lane.sha, 'the push landed after its run died');
  const m = manifest(h, lane.sha);
  assert.ok(m.push_started_at);
  assert.deepEqual([m.pushed_at, m.push_unknown_at, m.result], [null, null, null]);
  const next = ship(h);
  assert.equal(next.status, 0, said(next));
  assert.equal(resultOf(h, lane.sha), `ok pushed ${s7(lane.sha)}, 1 commits; completed by a later run`);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

test('a failed opening fetch with a pushed-elsewhere record standing for HEAD writes nothing and exits 0', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  pushByHand(h);
  assert.equal(ship(h).status, 0);
  assert.match(resultOf(h, sha), /^pushed-elsewhere /);
  const before = snapshot(h);
  setCfg(h.git, { fetch: 'fail' });
  const r = ship(h, [], { DRB_SHIP_GIT_CMD: h.git });
  assert.equal(r.status, 0, said(r));
  assert.deepEqual(snapshot(h), before);
});

test('an older unsettled record with HEAD moved on is completed before HEAD\'s record opens', async (t) => {
  const h = makeRepo(t);
  const old = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  pushByHand(h);
  stuck(h, old);
  const head = commit(h.repo, 'more notes', { 'docs/notes.md': 'notes v3\n' });
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  const done = manifest(h, old);
  assert.equal(done.result.state, 'ok');
  assert.ok(Date.parse(done.result.at) <= Date.parse(manifest(h, head).started_at), 'completed before HEAD\'s record opened');
  assert.equal(resultOf(h, head), `ok pushed ${s7(head)}, 1 commits`);
  await waitFor('both watches', () => watchedFor(h, old).length === 1 && watchedFor(h, head).length === 1);
});

test('a failed opening fetch writes nothing and exits 2 while an unsettled record stands; with none it ends result failed fetch failed, exit 1', (t) => {
  const h = makeRepo(t);
  const old = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  stuck(h, old);
  const head = commit(h.repo, 'more notes', { 'docs/notes.md': 'notes v3\n' });
  const before = snapshot(h);
  setCfg(h.git, { fetch: 'fail' });
  const r = ship(h, [], { DRB_SHIP_GIT_CMD: h.git });
  assert.equal(r.status, 2, said(r));
  assert.deepEqual(snapshot(h), before);
  assert.equal(manifest(h, head), null);

  const g = makeRepo(t);
  const sha = commit(g.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  setCfg(g.git, { fetch: 'fail' });
  const f = ship(g, [], { DRB_SHIP_GIT_CMD: g.git });
  assert.equal(f.status, 1, said(f));
  assert.deepEqual(stagesOf(logLines(g, sha)), ['start', 'fetch', 'result']);
  assert.equal(resultOf(g, sha), 'failed fetch failed');
});

test('an unreadable ship record refuses the run naming its sha7; --no-push with an unsettled record refuses before opening, exit 2', (t) => {
  const h = makeRepo(t);
  fs.mkdirSync(shipDir(h), { recursive: true });
  fs.writeFileSync(path.join(shipDir(h), `${h.seed}.json`), '{"sha": ');
  const head = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.match(r.stdout, new RegExp(`result refused unreadable ship record ${s7(h.seed)}; fix or move it`));
  assert.equal(manifest(h, head), null);

  const g = makeRepo(t);
  const old = commit(g.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  stuck(g, old);
  const next = commit(g.repo, 'more notes', { 'docs/notes.md': 'notes v3\n' });
  const before = snapshot(g);
  const dry = ship(g, ['--no-push']);
  assert.equal(dry.status, 2, said(dry));
  assert.match(dry.stdout, /an earlier push's outcome is unsettled; run npm run ship to complete it/);
  assert.equal(manifest(g, next), null);
  assert.deepEqual(snapshot(g), before);
});

test('a push that exits non-zero with no bracketed reason, whose sha a fetch then finds on origin/main, is treated as pushed', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.git, { push: 'land-fail' });
  const r = ship(h, [], { DRB_SHIP_GIT_CMD: h.git });
  assert.equal(r.status, 0, said(r));
  assert.equal(textsOf(logLines(h, lane.sha), 'push')[1], `the push ended (exit 1), but a fetch finds ${s7(lane.sha)} on origin/main: it landed`);
  assert.equal(resultOf(h, lane.sha), `ok pushed ${s7(lane.sha)}, 1 commits`);
  assert.equal(manifest(h, lane.sha).push_unknown_at, null);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

test('a thrown error before the push stamp ends failed with its message masked', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', lane.sha);
  const rev = git(h.repo, 'rev-parse', 'HEAD');
  // A file where the revert receipt's directory goes: the write throws.
  const R = h.lib('receipt.js');
  fs.writeFileSync(R.receiptDir(R.commitKey(rev, { cwd: h.repo }), { cwd: h.repo }), 'in the way\n');
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.match(resultOf(h, rev), /^failed EEXIST: file already exists, mkdir '\S*drb-review\/<TOKEN>'$/);
  assert.ok(!logLines(h, rev).some((l) => FULL_SHA.test(l)), 'the key in the message is masked');
  assert.equal(manifest(h, rev).push_started_at, null);
  assert.equal(originMain(h), lane.sha);
});

test('open refusing a sha this box pushed (origin rewritten since) is a one-line refusal that writes nothing', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  assert.equal(ship(h).status, 0);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
  git(h.origin, 'update-ref', 'refs/heads/main', h.seed);
  const before = snapshot(h);
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.match(r.stdout, new RegExp(`^ship: the record of ${s7(lane.sha)} cannot be opened \\(SHIP_ALREADY_OK\\): origin/main no longer holds a sha this box pushed`, 'm'));
  assert.deepEqual(snapshot(h), before);
  assert.equal(originMain(h), h.seed);
});

test('a record that died before its push is moved aside: the ship goes on, or ends pushed-elsewhere when the sha is on origin/main', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  h.lib('shipLog.js').open(lane.sha, { cwd: h.repo, base: h.seed });
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  const aside = fs.readdirSync(shipDir(h)).filter((f) => f.startsWith(`${lane.sha}.prev-`) && f.endsWith('.json'));
  assert.equal(aside.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(shipDir(h), aside[0]), 'utf8')).result, null);
  assert.equal(resultOf(h, lane.sha), `ok pushed ${s7(lane.sha)}, 1 commits`);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);

  const g = makeRepo(t);
  const sha = commit(g.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  pushByHand(g);
  g.lib('shipLog.js').open(sha, { cwd: g.repo, base: g.seed });
  const e = ship(g);
  assert.equal(e.status, 0, said(e));
  assert.match(resultOf(g, sha), /^pushed-elsewhere /);
  assert.equal(fs.readdirSync(shipDir(g)).filter((f) => f.startsWith(`${sha}.prev-`) && f.endsWith('.json')).length, 1);
});

test('a failed opening fetch with a record that did not ship standing for HEAD writes nothing and exits 1', (t) => {
  const h = makeRepo(t);
  const sha = commit(h.repo, 'server work', { 'server/a.js': 'a v2\n' });
  assert.equal(ship(h).status, 1);
  assert.match(resultOf(h, sha), /^refused /);
  const before = snapshot(h);
  setCfg(h.git, { fetch: 'fail' });
  const r = ship(h, [], { DRB_SHIP_GIT_CMD: h.git });
  assert.equal(r.status, 1, said(r));
  assert.match(r.stdout, new RegExp(`result failed git fetch origin main failed; the record of ${s7(sha)} stands at refused; nothing written`));
  assert.deepEqual(snapshot(h), before);
});

// ---- check 2: the real gate and the hook ------------------------------------------

function installHook(dir, repo) {
  const hook = path.join(dir, 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\nexec "${process.execPath}" "${path.join(repo, 'scripts', 'push-gate.js')}" verify\n`, { mode: 0o755 });
}

const noGateWorktree = (h) => !fs.existsSync(path.join(h.root, 'worktrees')) || fs.readdirSync(path.join(h.root, 'worktrees')).every((n) => !n.startsWith('.gate-'));

test('the real gate on a docs-only commit writes nothing_to_run with no worktree and the hook passes; a second clone with no sha receipt is refused by its hook', async (t) => {
  const h = makeRepo(t);
  installHook(h.common, h.repo);
  const sha = commit(h.repo, 'notes', { 'docs/notes.md': 'notes v2\n' });
  const other = path.join(h.root, 'other');
  git(h.root, 'clone', '-q', h.origin, other);
  git(other, 'fetch', '-q', h.repo, 'main');
  git(other, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  assert.equal(git(other, 'rev-parse', 'HEAD'), sha, 'the second clone holds the commit');
  writeFlip(h, path.join(other, '.git'));
  installHook(path.join(other, '.git'), h.repo);
  const plain = spawnSync('git', ['push', 'origin', 'main'], { cwd: other, env: process.env, encoding: 'utf8' });
  assert.notEqual(plain.status, 0, plain.stderr);
  assert.match(plain.stderr, /no sha receipt \(run: npm run ship\)/);
  assert.equal(originMain(h), h.seed);
  const env = { ...h.env };
  delete env.DRB_SHIP_GATE_CMD;
  const r = spawnSync(process.execPath, [h.ship, '--foreground'], { cwd: h.repo, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, said(r));
  const rec = JSON.parse(fs.readFileSync(path.join(h.common, 'drb-gate', `${sha}.json`), 'utf8'));
  assert.deepEqual([rec.version, rec.nothing_to_run, rec.stubbed, rec.gates_needed], [2, true, [], []]);
  assert.ok(noGateWorktree(h));
  assert.match(r.stdout + r.stderr, new RegExp(`pre-push: ${s7(sha)}: the sha receipt and the review receipts over origin/main are valid`));
  assert.equal(originMain(h), sha);
  await waitFor('the watch stub', () => watchedFor(h, sha).length === 1);
});

test('the real gate on a server commit with the smoke and static checks stubbed: without DRB_GATE_ALLOW_STUBBED ship ends failed before any push; with it the hook passes', async (t) => {
  const h = makeRepo(t);
  for (const rel of ['node_modules', 'client/node_modules', '.husky/_']) writeFiles(h.repo, { [`${rel}/keep.txt`]: 'shared\n' });
  installHook(h.common, h.repo);
  const smoke = stub(h, 'smoke', `
const dir = process.argv[process.argv.indexOf('--tap-dir') + 1];
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ suites: [], total_pass: 1, total_fail: 0, skipped: false }));
`, {});
  const statik = stub(h, 'static', "process.stdout.write(JSON.stringify({ findings: [], blocking: 0, allowed: 0, files: 1, eslint_files: 0 }));", {});
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const env = { ...h.env, DRB_GATE_SMOKE_CMD: smoke, DRB_GATE_STATIC_CMD: statik };
  delete env.DRB_SHIP_GATE_CMD;
  const run = (extra, args = []) => spawnSync(process.execPath, [h.ship, '--foreground', ...args], { cwd: h.repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 120000 });
  const refused = run({});
  assert.equal(refused.status, 1, said(refused));
  assert.match(resultOf(h, lane.sha), /^failed the gate exited 0 at \S+, but the hook would refuse its receipt: the sha receipt was written with stubs in place of static, smoke; a stubbed gate never vouches for a push$/);
  assert.equal(manifest(h, lane.sha).push_started_at, null);
  assert.equal(originMain(h), h.seed);
  // The accepted stubs are named in the gate line and the result, dry run or not.
  const stubbedLine = `passed at ${s7(lane.sha)} (money); stubbed: static, smoke`;
  const dry = run({ DRB_GATE_ALLOW_STUBBED: '1' }, ['--no-push']);
  assert.equal(dry.status, 0, said(dry));
  assert.equal(textsOf(logLines(h, lane.sha), 'gate').pop(), stubbedLine);
  assert.equal(resultOf(h, lane.sha), `ok-no-push dry run of ${s7(lane.sha)}, 1 commits: gated, not pushed and not watched; gate stubbed: static, smoke`);
  const r = run({ DRB_GATE_ALLOW_STUBBED: '1' });
  assert.equal(r.status, 0, said(r));
  assert.equal(textsOf(logLines(h, lane.sha), 'gate').pop(), stubbedLine);
  assert.equal(resultOf(h, lane.sha), `ok pushed ${s7(lane.sha)}, 1 commits; gate stubbed: static, smoke`);
  const rec = JSON.parse(fs.readFileSync(path.join(h.common, 'drb-gate', `${lane.sha}.json`), 'utf8'));
  assert.deepEqual([rec.gates_passed, rec.stubbed, rec.node_modules], [['money'], ['static', 'smoke'], 'linked']);
  assert.ok(noGateWorktree(h));
  assert.match(r.stdout + r.stderr, /the sha receipt and the review receipts over origin\/main are valid \(stubbed: static, smoke\)/);
  assert.equal(originMain(h), lane.sha);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

test('a completion names the stubs of the gate its record passed', async (t) => {
  const h = makeRepo(t);
  for (const rel of ['node_modules', 'client/node_modules', '.husky/_']) writeFiles(h.repo, { [`${rel}/keep.txt`]: 'shared\n' });
  const smoke = stub(h, 'smoke', `
const dir = process.argv[process.argv.indexOf('--tap-dir') + 1];
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ suites: [], total_pass: 1, total_fail: 0, skipped: false }));
`, {});
  const statik = stub(h, 'static', "process.stdout.write(JSON.stringify({ findings: [], blocking: 0, allowed: 0, files: 1, eslint_files: 0 }));", {});
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const env = { ...h.env, DRB_GATE_SMOKE_CMD: smoke, DRB_GATE_STATIC_CMD: statik, DRB_GATE_ALLOW_STUBBED: '1' };
  delete env.DRB_SHIP_GATE_CMD;
  setCfg(h.git, { push: 'fail', fetch_after_push: 'fail' });
  const first = spawnSync(process.execPath, [h.ship, '--foreground'], { cwd: h.repo, env: { ...env, DRB_SHIP_GIT_CMD: h.git }, encoding: 'utf8', timeout: 120000 });
  assert.equal(first.status, 2, said(first));
  git(h.repo, 'push', '-q', 'origin', 'main');
  const r = spawnSync(process.execPath, [h.ship, '--foreground'], { cwd: h.repo, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, said(r));
  assert.equal(resultOf(h, lane.sha), `ok pushed ${s7(lane.sha)}, 1 commits; completed by a later run; gate stubbed: static, smoke`);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

test('a stop that lands after the gate exits and before the push stamp ends failed killed by SIGTERM, with no stamp and no push', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  // A git first on ship's PATH that holds the first diff after the gate
  // stub's last act until the stop is sent: that diff is classifyRange's,
  // inside the synchronous checks between the gate's exit and the stamp.
  const real = spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = path.join(h.root, 'bin');
  const flag = path.join(h.root, 'gate-done');
  const held = path.join(h.root, 'diff-held');
  const sent = path.join(h.root, 'stop-sent');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    `if [ "$1" = diff ] && [ -e '${flag}' ] && [ ! -e '${held}' ]; then`,
    `  : > '${held}'`,
    `  while [ ! -e '${sent}' ]; do sleep 0.05; done`,
    'fi',
    `exec '${real}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  setCfg(h.gate, { flag });
  const run = shipAsync(h, [], { PATH: `${bin}:${process.env.PATH}` });
  await waitFor('the held diff', () => fs.existsSync(held), 30000);
  assert.equal(stagesOf(logLines(h, lane.sha)).pop(), 'gate', 'the gate has run');
  process.kill(manifest(h, lane.sha).pid, 'SIGTERM');
  fs.writeFileSync(sent, '');
  const r = await run.done;
  assert.equal(r.status, 1, said(r));
  assert.equal(resultOf(h, lane.sha), 'failed killed by SIGTERM');
  assert.equal(manifest(h, lane.sha).push_started_at, null);
  assert.equal(originMain(h), h.seed);
});

// ---- check 3: reverts ---------------------------------------------------------------

const RECEIPT_FIELDS = ['base', 'branch', 'content_rule_hits', 'coverage', 'created_at', 'escalated', 'externals', 'failing_test_on_old_code', 'key', 'kind', 'lenses',
  'matched_paths', 'mode', 'name', 'not_a_fix', 'proof', 'reports', 'reverted', 'reviewed_against', 'stale_base', 'state', 'tests', 'tests_superseded', 'tier',
  'tiers_by_file', 'timestamp', 'tip', 'triage', 'unforecast_lenses', 'verify', 'version', 'written_by'];

test('a clean git revert of a shipped server/ commit ships with a revert receipt under its commit key', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', lane.sha);
  const rev = git(h.repo, 'rev-parse', 'HEAD');
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  const R = h.lib('receipt.js');
  const key = R.commitKey(rev, { cwd: h.repo });
  const rec = R.readReceipt(R.receiptDir(key, { cwd: h.repo }));
  assert.deepEqual(Object.keys(rec).sort(), RECEIPT_FIELDS);
  assert.deepEqual([rec.version, rec.state, rec.key, rec.kind, rec.written_by, rec.reverted, rec.tip, rec.base], [1, 'final', key, 'revert', 'ship', lane.sha, rev, lane.sha]);
  assert.deepEqual([rec.lenses, rec.reports, rec.tests, rec.verify.run], [[], [], [], false]);
  assert.equal(textsOf(logLines(h, rev), 'revert')[0], `revert receipt written for ${s7(rev)}, reverting ${s7(lane.sha)}`);
  assert.equal(originMain(h), rev);
  await waitFor('the watch stub', () => watchedFor(h, rev).length === 1);
  hygiene(h, rev);
});

test('a revert of a shipped tier A commit ships the same way, the gate stub in place of the smoke', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/money.js': 'm v1\n' }, { tier: 'A' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', lane.sha);
  const rev = git(h.repo, 'rev-parse', 'HEAD');
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  const R = h.lib('receipt.js');
  assert.equal(R.readReceipt(R.receiptDir(R.commitKey(rev, { cwd: h.repo }), { cwd: h.repo })).kind, 'revert');
  assert.deepEqual(gateRuns(h).map((g) => g.argv), [['sha', rev]]);
  assert.equal(originMain(h), rev);
  await waitFor('the watch stub', () => watchedFor(h, rev).length === 1);
});

test('a revert with a hand edit, or of a commit not on origin/main, gets no receipt and is refused naming its sha', (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', '--no-commit', lane.sha);
  writeFiles(h.repo, { 'server/b.js': 'b by hand\n' });
  git(h.repo, 'add', '--', 'server/b.js');
  git(h.repo, 'commit', '-q', '--no-edit');
  const edited = git(h.repo, 'rev-parse', 'HEAD');
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.equal(textsOf(logLines(h, edited), 'revert')[0], `no revert receipt for ${s7(edited)}: its tree is not ${s7(lane.sha)} reverted on its parent; the commit carries more than the revert`);
  assert.match(resultOf(h, edited), new RegExp(`^refused ${s7(edited)}: no review receipt`));
  assert.deepEqual(gateRuns(h), []);

  const g = makeRepo(t);
  const local = landLane(g, { 'server/a.js': 'a v2\n' });
  git(g.repo, 'revert', '--no-edit', local.sha);
  const rev = git(g.repo, 'rev-parse', 'HEAD');
  const s = ship(g);
  assert.equal(s.status, 1, said(s));
  assert.equal(textsOf(logLines(g, rev), 'revert')[0], `no revert receipt for ${s7(rev)}: reverts ${s7(local.sha)}, which is not on origin/main (a revert receipt is for a shipped commit)`);
  assert.match(resultOf(g, rev), new RegExp(`^refused ${s7(rev)}: no review receipt`));
  assert.equal(originMain(g), g.seed);
});

test('a clean revert whose tree a quick fix keys gets its own revert receipt under its commit key and ships', async (t) => {
  const h = makeRepo(t);
  // A quick fix Q keys its staged tree; the lane A lands on Q; git revert of A
  // restores Q's tree, so the revert's tree holds Q's quick-fix receipt.
  writeFiles(h.repo, { 'server/a.js': 'a fixed\n' });
  git(h.repo, 'add', '--', 'server/a.js');
  const name = /name: (\S+)/.exec(cli(h, 'init', '--branch', 'main', '--quick-fix'))[1];
  review(h, name, ['server/a.js'], 'B');
  const head = git(h.repo, 'rev-parse', 'HEAD');
  const SM = require(path.join(h.repo, 'scripts', 'sensitive-match.js'));
  const select = scratch(h, 'select.json', JSON.stringify({ tier: 'B', tiers_by_file: SM.tierFromGit({ staged: true }, { cwd: h.repo }).tiersByFile }));
  cli(h, 'finalize', name, '--kind', 'quick-fix', '--base', head, '--reviewed-against', head, '--tier', 'B', '--not-a-fix', 'copy', '--select', select);
  git(h.repo, 'commit', '-q', '-m', 'quick fix');
  const q = git(h.repo, 'rev-parse', 'HEAD');
  const lane = landLane(h, { 'server/b.js': 'b v2\n' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', lane.sha);
  const rev = git(h.repo, 'rev-parse', 'HEAD');
  const R = h.lib('receipt.js');
  const tree = git(h.repo, 'rev-parse', `${rev}^{tree}`);
  assert.equal(tree, git(h.repo, 'rev-parse', `${q}^{tree}`), 'the revert restores the quick fix\'s tree');
  assert.equal(R.readReceipt(R.receiptDir(tree, { cwd: h.repo })).kind, 'quick-fix');
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  const rec = R.readReceipt(R.receiptDir(R.commitKey(rev, { cwd: h.repo }), { cwd: h.repo }));
  assert.deepEqual([rec.kind, rec.tip, rec.reverted], ['revert', rev, lane.sha]);
  assert.equal(textsOf(logLines(h, rev), 'revert')[0], `revert receipt written for ${s7(rev)}, reverting ${s7(lane.sha)}`);
  assert.equal(originMain(h), rev);
  await waitFor('the watch stub', () => watchedFor(h, rev).length === 1);
});

test('a revert whose commit key holds a shipped twin\'s revert receipt replaces it and ships; an unshipped twin\'s is left and the run is refused naming the clash', async (t) => {
  const h = makeRepo(t);
  const R = h.lib('receipt.js');
  const keyOf = (sha) => R.commitKey(sha, { cwd: h.repo });
  const receiptAt = (key) => R.readReceipt(R.receiptDir(key, { cwd: h.repo }));
  const a = landLane(h, { 'server/a.js': 'a v2\n' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', a.sha);
  const x1 = git(h.repo, 'rev-parse', 'HEAD');
  assert.equal(ship(h).status, 0, 'the first revert ships with its revert receipt');
  await waitFor('the watch stub', () => watchedFor(h, x1).length === 1);
  // The same lines land again through a lane, then are reverted again.
  const l2 = landLane(h, { 'server/a.js': 'a v2\n' });
  assert.equal(ship(h).status, 0, 'the re-land ships on its lane receipt');
  await waitFor('the watch stub', () => watchedFor(h, l2.sha).length === 1);
  git(h.repo, 'revert', '--no-edit', l2.sha);
  const z = git(h.repo, 'rev-parse', 'HEAD');
  assert.equal(keyOf(z), keyOf(x1), 'the two reverts share a patch id');
  assert.equal(receiptAt(keyOf(z)).tip, x1);
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.equal(textsOf(logLines(h, z), 'revert')[0], `revert receipt for ${s7(z)} replaces the one ${s7(x1)} held under the same patch`);
  assert.deepEqual([receiptAt(keyOf(z)).tip, receiptAt(keyOf(z)).reverted], [z, l2.sha]);
  assert.equal(originMain(h), z);
  await waitFor('the watch stub', () => watchedFor(h, z).length === 1);

  // The twin not shipped: the first revert, the re-land and the second revert in one range.
  const g = makeRepo(t);
  const G = g.lib('receipt.js');
  const ga = landLane(g, { 'server/a.js': 'a v2\n' });
  pushByHand(g);
  git(g.repo, 'revert', '--no-edit', ga.sha);
  const gx1 = git(g.repo, 'rev-parse', 'HEAD');
  const gl2 = landLane(g, { 'server/a.js': 'a v2\n' });
  git(g.repo, 'revert', '--no-edit', gl2.sha);
  const gz = git(g.repo, 'rev-parse', 'HEAD');
  const s = ship(g);
  assert.equal(s.status, 1, said(s));
  assert.deepEqual(textsOf(logLines(g, gz), 'revert'), [
    `revert receipt written for ${s7(gx1)}, reverting ${s7(ga.sha)}`,
    `no revert receipt for ${s7(gz)}: its commit key holds the revert receipt of ${s7(gx1)}, the same patch, which has not shipped`,
  ]);
  assert.match(resultOf(g, gz), new RegExp(`^refused ${s7(gz)}: no review receipt of its own \\(its commit key \\S+ holds the revert receipt of ${s7(gx1)}, another commit with the same patch`));
  assert.equal(G.readReceipt(G.receiptDir(G.commitKey(gz, { cwd: g.repo }), { cwd: g.repo })).tip, gx1, 'the twin\'s receipt is left');
  assert.equal(originMain(g), ga.sha);
});

test('a revert receipt for this very commit under its key stands, a dry run\'s or one with no tip: the real ship writes no second one', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', lane.sha);
  const rev = git(h.repo, 'rev-parse', 'HEAD');
  const R = h.lib('receipt.js');
  const file = path.join(R.receiptDir(R.commitKey(rev, { cwd: h.repo }), { cwd: h.repo }), 'receipt.json');
  assert.equal(ship(h, ['--no-push']).status, 0);
  const written = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(written).tip, rev);
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.deepEqual(textsOf(logLines(h, rev), 'revert'), [], 'no second receipt');
  assert.equal(fs.readFileSync(file, 'utf8'), written, 'the dry run\'s receipt stands untouched');
  await waitFor('the watch stub', () => watchedFor(h, rev).length === 1);

  const g = makeRepo(t);
  const gl = landLane(g, { 'server/a.js': 'a v2\n' });
  pushByHand(g);
  git(g.repo, 'revert', '--no-edit', gl.sha);
  const grev = git(g.repo, 'rev-parse', 'HEAD');
  const G = g.lib('receipt.js');
  const key = G.commitKey(grev, { cwd: g.repo });
  G.writeReceipt(G.receiptDir(key, { cwd: g.repo }), { version: 1, state: 'final', key, kind: 'revert', written_by: 'ship', reverted: gl.sha });
  const gfile = path.join(G.receiptDir(key, { cwd: g.repo }), 'receipt.json');
  const before = fs.readFileSync(gfile, 'utf8');
  const s = ship(g);
  assert.equal(s.status, 0, said(s));
  assert.deepEqual(textsOf(logLines(g, grev), 'revert'), [], 'a receipt with no tip is read as this commit\'s');
  assert.equal(fs.readFileSync(gfile, 'utf8'), before);
  await waitFor('the watch stub', () => watchedFor(g, grev).length === 1);
});

test('a twin rewritten away (its revert amended after a dry run) has its receipt replaced, and the amended revert ships', async (t) => {
  const h = makeRepo(t);
  const R = h.lib('receipt.js');
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', lane.sha);
  const x = git(h.repo, 'rev-parse', 'HEAD');
  assert.equal(ship(h, ['--no-push']).status, 0);
  const key = R.commitKey(x, { cwd: h.repo });
  assert.equal(R.readReceipt(R.receiptDir(key, { cwd: h.repo })).tip, x, 'the dry run wrote the revert receipt');
  git(h.repo, 'commit', '-q', '--amend', '-m', 'Revert the lane work, reworded', '-m', `This reverts commit ${lane.sha}.`);
  const amended = git(h.repo, 'rev-parse', 'HEAD');
  assert.notEqual(amended, x);
  assert.equal(R.commitKey(amended, { cwd: h.repo }), key, 'the amend keeps the patch');
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.equal(textsOf(logLines(h, amended), 'revert')[0], `revert receipt for ${s7(amended)} replaces the one ${s7(x)} held under the same patch`);
  assert.equal(R.readReceipt(R.receiptDir(key, { cwd: h.repo })).tip, amended);
  assert.equal(originMain(h), amended);
  await waitFor('the watch stub', () => watchedFor(h, amended).length === 1);
});

test('a twin git cannot place is left, failing closed, and the run refused; a twin that is gone on a clean miss is replaced', async (t) => {
  const h = makeRepo(t);
  const R = h.lib('receipt.js');
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', lane.sha);
  const rev = git(h.repo, 'rev-parse', 'HEAD');
  const key = R.commitKey(rev, { cwd: h.repo });
  const ghost = ['ab', 'cd'].join('').repeat(10);
  R.writeReceipt(R.receiptDir(key, { cwd: h.repo }), { version: 1, state: 'final', key, kind: 'revert', written_by: 'ship', tip: ghost, reverted: lane.sha });
  // A broken alternate turns git's miss on the twin into an error.
  const alternates = path.join(h.common, 'objects', 'info', 'alternates');
  fs.mkdirSync(path.dirname(alternates), { recursive: true });
  fs.writeFileSync(alternates, `${path.join(h.root, 'no-such-store')}\n`);
  const left = ship(h);
  assert.equal(left.status, 1, said(left));
  assert.equal(textsOf(logLines(h, rev), 'revert')[0], `no revert receipt for ${s7(rev)}: git could not place abcdabc, whose revert receipt holds the same commit key; it is left`);
  assert.equal(R.readReceipt(R.receiptDir(key, { cwd: h.repo })).tip, ghost, 'the receipt is left');
  assert.match(resultOf(h, rev), /holds the revert receipt of abcdabc, another commit with the same patch/);
  assert.equal(originMain(h), lane.sha);
  fs.rmSync(alternates);
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.equal(textsOf(logLines(h, rev), 'revert')[0], `revert receipt for ${s7(rev)} replaces the one abcdabc held under the same patch`);
  assert.equal(R.readReceipt(R.receiptDir(key, { cwd: h.repo })).tip, rev);
  assert.equal(originMain(h), rev);
  await waitFor('the watch stub', () => watchedFor(h, rev).length === 1);
});

test('a revert followed by a docs commit gets its revert receipt and ships', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  pushByHand(h);
  git(h.repo, 'revert', '--no-edit', lane.sha);
  const rev = git(h.repo, 'rev-parse', 'HEAD');
  const head = commit(h.repo, 'notes after the revert', { 'docs/notes.md': 'notes v2\n' });
  const r = ship(h);
  assert.equal(r.status, 0, said(r));
  assert.equal(textsOf(logLines(h, head), 'revert')[0], `revert receipt written for ${s7(rev)}, reverting ${s7(lane.sha)}`);
  assert.equal(resultOf(h, head), `ok pushed ${s7(head)}, 2 commits`);
  assert.equal(originMain(h), head);
  await waitFor('the watch stub', () => watchedFor(h, head).length === 1);
});

// ---- check 4: the pii scan ----------------------------------------------------------

test('a token-shaped line in a docs file is refused naming the file and line, never the text', (t) => {
  const h = makeRepo(t);
  const run = ['ab12', 'cd34'].join('').repeat(5);
  const sha = commit(h.repo, 'notes', { 'docs/notes.md': `notes\nthe key ${run}\n` });
  const r = ship(h);
  assert.equal(r.status, 1, said(r));
  assert.equal(resultOf(h, sha), `refused ${s7(sha)}: pii: docs/notes.md line 2 adds a TOKEN-shaped run`);
  for (const text of [r.stdout, r.stderr, fs.readFileSync(path.join(shipDir(h), `${sha}.log`), 'utf8'), fs.readFileSync(path.join(shipDir(h), `${sha}.json`), 'utf8')]) {
    assert.ok(!text.includes(run), 'the token never leaves the diff');
  }
  assert.deepEqual(gateRuns(h), []);
  assert.equal(originMain(h), h.seed);
});

// ---- check 5: the lock order --------------------------------------------------------

test('a ship waits on a held ship lock with one line and completes after; the gate takes the push-gate lock inside the ship lock', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.gate, { locks: true });
  const lock = path.join(h.lib('receipt.js').commonDir({ cwd: h.repo }), 'drb-ship.lock');
  const holder = spawn('flock', [lock, 'sleep', '2'], { stdio: 'ignore' });
  t.after(() => holder.kill('SIGKILL'));
  await waitFor('the holder', () => spawnSync('flock', ['-n', lock, 'true']).status === 1, 5000);
  const exited = new Promise((resolve) => holder.on('exit', () => resolve(Date.now())));
  const r = await shipAsync(h).done;
  const released = await exited;
  assert.equal(r.status, 0, said(r));
  assert.equal(r.stderr.split('\n').filter((l) => l === WAIT_LINE).length, 1, 'one wait line');
  const gate = gateRuns(h)[0];
  assert.equal(gate.gate_lock, 0, 'the gate took the push-gate lock');
  assert.equal(gate.ship_lock, 1, 'while ship held the ship lock');
  assert.equal(gate.fd3, fs.realpathSync(lock), 'the gate holds the ship lock\'s descriptor as its fd 3');
  assert.ok(Date.parse(manifest(h, lane.sha).started_at) >= released - 50, 'the flow ran after the holder let go');
  assert.equal(originMain(h), lane.sha);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

// ---- check 6: detached ------------------------------------------------------------

const ppidOf = (pid) => Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ')[1]);

test('detached: ship returns at once with the started line and the log reaches result ok', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [h.ship], { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 10000 });
  assert.ok(Date.now() - t0 < 2000, 'returns within two seconds');
  assert.equal(r.status, 0, said(r));
  assert.equal(r.stdout.trim(), `ship: started ${s7(lane.sha)}, log ${h.lib('shipLog.js').shipPaths(lane.sha, { cwd: h.repo }).log}`);
  await waitFor('the result line', () => resultOf(h, lane.sha), 30000);
  assert.equal(resultOf(h, lane.sha), `ok pushed ${s7(lane.sha)}, 1 commits`);
  assert.match(fs.readFileSync(path.join(shipDir(h), `${lane.sha}.stdio.log`), 'utf8'), /ship: result ok/);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
});

test('detached: a SIGTERM to the ship after the gate stage leaves result failed killed by SIGTERM last and the manifest\'s result set', async (t) => {
  const h = makeRepo(t);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  setCfg(h.gate, { mode: 'sleep' });
  const r = spawnSync(process.execPath, [h.ship], { cwd: h.repo, env: h.env, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 0, said(r));
  const gatePid = Number(await waitFor('the sleeping gate', () => fs.existsSync(path.join(h.root, 'gate-ready')) && fs.readFileSync(path.join(h.root, 'gate-ready'), 'utf8'), 30000));
  assert.equal(stagesOf(logLines(h, lane.sha)).pop(), 'gate');
  // The process the detached spawn started is the lock's outer: the locked
  // run (the manifest's pid) under flock under it.
  const outer = ppidOf(ppidOf(manifest(h, lane.sha).pid));
  assert.match(fs.readFileSync(`/proc/${outer}/cmdline`, 'utf8'), /ship\.js/);
  process.kill(outer, 'SIGTERM');
  await waitFor('the result line', () => resultOf(h, lane.sha), 30000);
  const lines = logLines(h, lane.sha);
  assert.equal(lines[lines.length - 1].split(' ').slice(1).join(' '), 'result failed killed by SIGTERM');
  assert.deepEqual([manifest(h, lane.sha).result.state, manifest(h, lane.sha).result.text], ['failed', 'killed by SIGTERM']);
  assert.equal(h.lib('shipLog.js').inFlight({ cwd: h.repo }), null);
  await waitFor('the gate stub to stop', () => {
    try {
      process.kill(gatePid, 0);
      return false;
    } catch (err) {
      if (err.code !== 'ESRCH') throw err;
      return true;
    }
  });
  assert.equal(originMain(h), h.seed);
});

// ---- --status ---------------------------------------------------------------------

test('--status prints no ship yet with no record, then the manifest and the log tail, and writes nothing', async (t) => {
  const h = makeRepo(t);
  const status = (...args) => spawnSync(process.execPath, [h.ship, '--status', ...args], { cwd: h.repo, env: h.env, encoding: 'utf8' });
  const none = status();
  assert.equal(none.status, 0, said(none));
  assert.equal(none.stdout.trim(), 'no ship yet');
  assert.equal(fs.existsSync(shipDir(h)), false);
  const lane = landLane(h, { 'server/a.js': 'a v2\n' });
  assert.equal(ship(h).status, 0);
  await waitFor('the watch stub', () => watchedFor(h, lane.sha).length === 1);
  const before = snapshot(h);
  const r = status();
  assert.equal(r.status, 0, said(r));
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], `ship ${s7(lane.sha)}: result ok pushed ${s7(lane.sha)}, 1 commits`);
  assert.ok(lines.includes(`  sha: ${lane.sha}`));
  assert.ok(lines.some((l) => /^log .*, its last 10 lines:$/.test(l)));
  assert.equal(status(s7(lane.sha)).stdout, r.stdout);
  assert.deepEqual(snapshot(h), before);
});
