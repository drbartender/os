'use strict';

// node:test suite for scripts/run-suites.js and the dev-suite lock (instruction
// rewrite step 2, lane suite-runner). Every case runs in a temp directory with
// its own lock file; nothing touches the dev database or Neon. The smoke lock
// and testdb-smoke's flags are tested in scripts/testdb-smoke.test.js. Temp
// directories are removed and every process started here is killed when the
// file finishes.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RUNNER = path.resolve(__dirname, 'run-suites.js');
const { reachedSuites, stagedPaths } = require(RUNNER);
const { logName, outName } = require('./lib/tapSummary');

const dirs = [];
const children = [];
after(() => {
  for (const c of children) {
    if (c.exitCode === null && c.signalCode === null) {
      try {
        process.kill(c.detachedGroup ? -c.pid : c.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function track(child, { detachedGroup = false } = {}) {
  child.detachedGroup = detachedGroup;
  children.push(child);
  return child;
}

function exited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.on('exit', () => resolve());
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeTree(root, files) {
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
}

const PASSING_SUITE = "const { test } = require('node:test'); const assert = require('node:assert');\ntest('one', () => assert.ok(true));\ntest('two', () => assert.ok(true));\n";
const FAILING_SUITE = "const { test } = require('node:test'); const assert = require('node:assert');\ntest('bad', () => assert.ok(false));\n";
const DEAD_SUITE = "process.stdout.write('no tap here\\n');\n"; // exits 0 with no summary
const SLOW_SUITE = "const { test } = require('node:test');\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 2500)); });\n";

test('reachedSuites: the sibling and the importer, and one more hop through a non-test module, nothing further', () => {
  const root = tmp('reached-');
  writeTree(root, {
    'server/utils/a.js': 'module.exports = 1;',
    'server/utils/a.test.js': PASSING_SUITE,
    'server/utils/b.test.js': "const a = require('./a');\n" + PASSING_SUITE,
    'server/utils/c.test.js': PASSING_SUITE,
    'server/routes/d.test.js': "const a = require('../utils/a');\n" + PASSING_SUITE,
    'server/utils/e.js': "const a = require('./a'); module.exports = a;", // requires a.js: counts as changed for one more hop
    'server/utils/e.test.js': PASSING_SUITE, // e.js's sibling
    'server/utils/f.test.js': "const e = require('./e');\n" + PASSING_SUITE, // requires e.js
    'server/utils/g.js': "const e = require('./e'); module.exports = e;", // two module hops from a.js: not followed
    'server/utils/g.test.js': "const g = require('./g');\n" + PASSING_SUITE,
    'scripts/x.js': 'module.exports = 2;',
    'scripts/x.test.js': PASSING_SUITE,
  });
  assert.deepStrictEqual(reachedSuites(['server/utils/a.js'], { root }), ['server/routes/d.test.js', 'server/utils/a.test.js', 'server/utils/b.test.js', 'server/utils/e.test.js', 'server/utils/f.test.js']);
  assert.deepStrictEqual(reachedSuites(['scripts/x.js'], { root }), ['scripts/x.test.js']);
  assert.deepStrictEqual(reachedSuites(['server/utils/a.test.js'], { root }), ['server/utils/a.test.js'], 'a changed test runs itself');
  assert.deepStrictEqual(reachedSuites(['docs/x.md', 'client/src/App.js'], { root }), []);
});

test('stagedPaths resolves the staged files of a repo', () => {
  const root = tmp('staged-');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeTree(root, { 'server/utils/a.js': 'module.exports = 1;' });
  execFileSync('git', ['add', 'server/utils/a.js'], { cwd: root });
  assert.deepStrictEqual(stagedPaths({ root }), ['server/utils/a.js']);
});

test('counts come from the TAP summary; a log without one is a failure; the log file exists', () => {
  const root = tmp('counts-');
  writeTree(root, { 'server/utils/good.test.js': PASSING_SUITE, 'server/utils/dead.test.js': DEAD_SUITE, 'server/utils/bad.test.js': FAILING_SUITE });
  const logDir = path.join(root, 'logs');
  const lock = path.join(root, 'lock');
  const run = (files) => spawnSync(process.execPath, [RUNNER, '--log-dir', logDir, ...files], { cwd: root, encoding: 'utf8', env: { ...process.env, DRB_DEVDB_LOCK_FILE: lock, RUN_SUITES_ROOT: root } });
  const good = run(['server/utils/good.test.js']);
  assert.strictEqual(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /pass 2 fail 0/);
  assert.ok(fs.existsSync(path.join(logDir, logName('server/utils/good.test.js'))));
  const dead = run(['server/utils/dead.test.js']);
  assert.strictEqual(dead.status, 1, 'a suite with no TAP summary is a failure, never a zero');
  assert.match(dead.stdout + dead.stderr, /no TAP summary/);
  const bad = run(['server/utils/bad.test.js']);
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /fail 1/);
});

test('two runners on one lock serialize, and the second says it is waiting', async () => {
  const root = tmp('lock-');
  writeTree(root, { 'server/utils/slow.test.js': SLOW_SUITE });
  const lock = path.join(root, 'lock');
  const env = { ...process.env, DRB_DEVDB_LOCK_FILE: lock, RUN_SUITES_ROOT: root };
  const start = Date.now();
  const first = track(spawn(process.execPath, [RUNNER, '--log-dir', path.join(root, 'l1'), 'server/utils/slow.test.js'], { cwd: root, env }));
  await new Promise((r) => setTimeout(r, 400));
  const second = spawnSync(process.execPath, [RUNNER, '--log-dir', path.join(root, 'l2'), 'server/utils/slow.test.js'], { cwd: root, env, encoding: 'utf8', timeout: 20000 });
  await exited(first);
  const elapsed = Date.now() - start;
  assert.strictEqual(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout + second.stderr, /waiting for the dev-suite lock/);
  assert.ok(elapsed >= 5000, `two 2.5 s suites serialized should take at least 5 s, took ${elapsed} ms`);
});

// ---- Behavior beyond the contract above: flags, git modes, defaults, guards ----

const { parseArgs } = require(RUNNER);

function gitRepo(prefix, files) {
  const root = tmp(prefix);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeTree(root, files);
  return root;
}
function gitCommit(root, paths, msg) {
  execFileSync('git', ['add', ...paths], { cwd: root });
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture', 'commit', '-q', '-m', msg], { cwd: root });
}
function runIn(root, args, extraEnv = {}) {
  const env = { ...process.env, RUN_SUITES_ROOT: root, DRB_DEVDB_LOCK_FILE: path.join(root, 'test.lock'), ...extraEnv };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return spawnSync(process.execPath, [RUNNER, ...args], { cwd: root, encoding: 'utf8', env, timeout: 20000 });
}

test('parseArgs: one mode, an optional --log-dir, and a usage error for anything else', () => {
  assert.deepStrictEqual(parseArgs(['--changed', 'a..b']), { mode: 'changed', range: 'a..b', files: [], logDir: null });
  assert.deepStrictEqual(parseArgs(['--staged', '--log-dir', 'out']), { mode: 'staged', range: null, files: [], logDir: 'out' });
  assert.deepStrictEqual(parseArgs(['x.test.js', 'y.js']), { mode: 'files', range: null, files: ['x.test.js', 'y.js'], logDir: null });
  for (const bad of [[], ['--log-dir'], ['--log-dir', '--staged'], ['--bogus'], ['--changed'], ['--changed', 'abc'], ['--changed', 'a..b', '--staged'], ['--staged', 'x.test.js'], ['--staged', '--staged']]) {
    assert.throws(() => parseArgs(bad), /usage/, JSON.stringify(bad));
  }
});

test('a usage error exits 2 and runs nothing', () => {
  const root = tmp('usage-');
  const r = runIn(root, ['--bogus']);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /usage/);
});

test('--changed runs what the range reaches; a docs-only range reaches nothing and exits 0', () => {
  const root = gitRepo('changed-', { 'server/utils/a.js': 'module.exports = 1;', 'server/utils/a.test.js': PASSING_SUITE, 'docs/x.md': 'one' });
  gitCommit(root, ['server/utils/a.js', 'server/utils/a.test.js', 'docs/x.md'], 'one');
  writeTree(root, { 'server/utils/a.js': 'module.exports = 2;' });
  gitCommit(root, ['server/utils/a.js'], 'two');
  writeTree(root, { 'docs/x.md': 'three' });
  gitCommit(root, ['docs/x.md'], 'three');
  const code = runIn(root, ['--changed', 'HEAD~2..HEAD~1', '--log-dir', path.join(root, 'logs')]);
  assert.strictEqual(code.status, 0, code.stdout + code.stderr);
  assert.match(code.stdout, /server\/utils\/a\.test\.js pass 2 fail 0/);
  const docs = runIn(root, ['--changed', 'HEAD~1..HEAD', '--log-dir', path.join(root, 'logs')]);
  assert.strictEqual(docs.status, 0, docs.stdout + docs.stderr);
  assert.match(docs.stdout, /no suites reached/);
  const badRange = runIn(root, ['--changed', 'nope..HEAD']);
  assert.strictEqual(badRange.status, 2, 'a range git cannot read is a usage error, never "no suites reached"');
  assert.match(badRange.stderr, /usage/);
  assert.doesNotMatch(badRange.stdout, /no suites reached/);
});

test('--staged with no overrides takes the lock and writes the logs under the git common dir', () => {
  const root = gitRepo('defaults-', { 'server/utils/a.js': 'module.exports = 1;', 'server/utils/a.test.js': PASSING_SUITE });
  execFileSync('git', ['add', 'server/utils/a.js'], { cwd: root });
  const r = runIn(root, ['--staged'], { DRB_DEVDB_LOCK_FILE: undefined, DRB_DEVDB_LOCKED: undefined });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /server\/utils\/a\.test\.js pass 2 fail 0/);
  assert.ok(fs.existsSync(path.join(root, '.git', 'drb-devdb.lock')), 'the default lock lives in the git common dir');
  const runs = fs.readdirSync(path.join(root, '.git', 'drb-review', '_runs'));
  assert.strictEqual(runs.length, 1);
  assert.ok(fs.existsSync(path.join(root, '.git', 'drb-review', '_runs', runs[0], logName('server/utils/a.test.js'))));
});

test('explicit files: a missing one is an error; a non-test file expands to what it reaches; a named test runs wherever it lives', () => {
  const root = tmp('explicit-');
  writeTree(root, { 'server/utils/a.js': 'module.exports = 1;', 'server/utils/a.test.js': PASSING_SUITE, 'tools/t.test.js': PASSING_SUITE });
  const logs = ['--log-dir', path.join(root, 'logs')];
  const missing = runIn(root, ['server/utils/nope.test.js', ...logs]);
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /no such file: server\/utils\/nope\.test\.js/);
  assert.doesNotMatch(missing.stdout, /no suites reached/);
  const expanded = runIn(root, ['server/utils/a.js', ...logs]);
  assert.strictEqual(expanded.status, 0, expanded.stdout + expanded.stderr);
  assert.match(expanded.stdout, /server\/utils\/a\.test\.js pass 2 fail 0/);
  const named = runIn(root, ['tools/t.test.js', ...logs]);
  assert.strictEqual(named.status, 0, named.stdout + named.stderr);
  assert.match(named.stdout, /tools\/t\.test\.js pass 2 fail 0/);
});

test('a suite whose summary says fail 0 but which exits non-zero is a failure', () => {
  const root = tmp('exit-');
  writeTree(root, { 'server/utils/odd.test.js': PASSING_SUITE + "process.on('exit', () => { process.exitCode = 3; });\n" });
  const r = runIn(root, ['server/utils/odd.test.js', '--log-dir', path.join(root, 'logs')]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /odd\.test\.js pass 2 fail 0 \(exit 3\)/);
});

// A suite that runs the runner again on the SAME lock from inside a run: it
// must go straight through (re-entrant), never wait on its own holder.
const NESTED_SUITE = (runner) => `const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
test('nested run on the same lock', () => {
  const r = spawnSync(process.execPath, [${JSON.stringify(runner)}, 'server/utils/good.test.js', '--log-dir', path.join(process.env.RUN_SUITES_ROOT, 'nested-logs')], { encoding: 'utf8', timeout: 10000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /waiting/);
});
`;

test('the lock guard: a run nested inside the holder is re-entrant; a forged guard and another file still lock', async () => {
  const root = tmp('guard-');
  writeTree(root, { 'server/utils/good.test.js': PASSING_SUITE, 'server/utils/nest.test.js': NESTED_SUITE(RUNNER) });
  const lock = path.join(root, 'test.lock');
  const logs = ['--log-dir', path.join(root, 'logs')];
  const nested = runIn(root, ['server/utils/nest.test.js', ...logs]);
  assert.strictEqual(nested.status, 0, nested.stdout + nested.stderr);
  assert.match(nested.stdout, /nest\.test\.js pass 1 fail 0/);
  const holder = track(spawn('flock', [lock, 'sleep', '2'], { stdio: 'ignore' }));
  await sleep(300);
  const forged = runIn(root, ['server/utils/good.test.js', ...logs], { DRB_DEVDB_LOCKED: lock });
  assert.strictEqual(forged.status, 0, forged.stdout + forged.stderr);
  assert.match(forged.stdout + forged.stderr, /waiting for the dev-suite lock/, 'a guard no ancestor set must not skip the lock');
  const other = runIn(root, ['server/utils/good.test.js', ...logs], { DRB_DEVDB_LOCKED: path.join(root, 'some-other.lock') });
  assert.strictEqual(other.status, 0, other.stdout + other.stderr);
  await exited(holder);
});

// ---- summary.json, cancelled tests and the per-suite timeout ----

const CANCEL_EXIT0_SUITE = "const { test } = require('node:test');\ntest('slow', { timeout: 200 }, async () => { await new Promise((r) => setTimeout(r, 1500)); });\nprocess.on('exit', () => { process.exitCode = 0; });\n";
const HANG_SUITE = "const { test } = require('node:test');\ntest('hangs', () => { setInterval(() => {}, 1000); });\n";

test('run-suites writes summary.json in the smoke shape; a cancelled test fails the suite even on exit 0', () => {
  const root = tmp('summary-');
  writeTree(root, {
    'server/utils/good.test.js': PASSING_SUITE,
    'server/utils/bad.test.js': FAILING_SUITE,
    'server/utils/dead.test.js': DEAD_SUITE,
    'server/utils/cancel.test.js': CANCEL_EXIT0_SUITE,
  });
  const logDir = path.join(root, 'logs');
  const r = runIn(root, ['server/utils/good.test.js', 'server/utils/bad.test.js', 'server/utils/dead.test.js', 'server/utils/cancel.test.js', '--log-dir', logDir]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /server\/utils\/cancel\.test\.js pass 0 fail 0 cancelled 1 .*\(log: /, 'the cancelled suite is reported as failed');
  const summary = JSON.parse(fs.readFileSync(path.join(logDir, 'summary.json'), 'utf8'));
  assert.deepStrictEqual(summary, {
    suites: [
      { file: 'server/utils/bad.test.js', log: logName('server/utils/bad.test.js'), out: outName('server/utils/bad.test.js'), pass: 0, fail: 1, found: true, ok: false, exit_ok: false },
      { file: 'server/utils/cancel.test.js', log: logName('server/utils/cancel.test.js'), out: outName('server/utils/cancel.test.js'), pass: 0, fail: 1, found: true, ok: false, exit_ok: true },
      { file: 'server/utils/dead.test.js', log: logName('server/utils/dead.test.js'), out: outName('server/utils/dead.test.js'), pass: 0, fail: 1, found: false, ok: false, exit_ok: true },
      { file: 'server/utils/good.test.js', log: logName('server/utils/good.test.js'), out: outName('server/utils/good.test.js'), pass: 2, fail: 0, found: true, ok: true, exit_ok: true },
    ],
    total_pass: 2,
    total_fail: 3,
    skipped: false,
  });
  for (const e of summary.suites) {
    assert.ok(fs.existsSync(path.join(logDir, e.log)), `${e.file}: no ${e.log}`);
    assert.ok(fs.existsSync(path.join(logDir, e.out)), `${e.file}: no ${e.out}`);
  }
});

test('a reused --log-dir is claimed and loses its old summary.json, .log and .out files before the lock wait', async () => {
  const root = tmp('stale-');
  writeTree(root, {
    'server/utils/good.test.js': PASSING_SUITE,
    'logs/summary.json': '{"stale":true}\n',
    'logs/server-utils-gone.test.js.log': '# pass 4\n# fail 0\n',
    'logs/server-utils-gone.test.js.out': 'old output\n',
  });
  const lock = path.join(root, 'test.lock');
  const holder = track(spawn('flock', [lock, 'sleep', '30'], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
  await sleep(300);
  const env = { ...process.env, RUN_SUITES_ROOT: root, DRB_DEVDB_LOCK_FILE: lock };
  const runner = track(spawn(process.execPath, [RUNNER, 'server/utils/good.test.js', '--log-dir', path.join(root, 'logs')], { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }), { detachedGroup: true });
  let err = '';
  runner.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 50 && !/waiting for the dev-suite lock/.test(err); i++) await sleep(100);
  assert.match(err, /waiting for the dev-suite lock/);
  assert.ok(!fs.existsSync(path.join(root, 'logs', 'summary.json')), 'the old summary still stands in for a run that has not happened');
  assert.ok(!fs.existsSync(path.join(root, 'logs', 'server-utils-gone.test.js.log')), 'an old log still stands in the reused dir');
  assert.ok(!fs.existsSync(path.join(root, 'logs', 'server-utils-gone.test.js.out')), 'an old .out still stands in the reused dir');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'logs')), ['.drb-run'], 'the waiting run holds the dir by its marker, and nothing old is left');
  process.kill(-runner.pid, 'SIGTERM');
  await exited(runner);
  process.kill(-holder.pid, 'SIGKILL');
  await exited(holder);
});

test('a suite that outlives the per-suite timeout is killed and is a failure', () => {
  const { runSuite, SUITE_TIMEOUT_MS } = require(RUNNER);
  assert.strictEqual(SUITE_TIMEOUT_MS, 180000);
  const root = tmp('timeout-');
  writeTree(root, { 'server/utils/hang.test.js': HANG_SUITE });
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir);
  const start = Date.now();
  const res = runSuite(root, 'server/utils/hang.test.js', logDir, { timeoutMs: 1000, quiet: true });
  assert.ok(Date.now() - start < 10000, 'the hung suite was not killed');
  assert.strictEqual(res.failed, true);
  assert.match(res.line, /hang\.test\.js .*\(timed out at 1s\)/);
  assert.strictEqual(res.exitOk, false);
});

// ---- Stopping a runner: nothing runs later, nothing runs unlocked ----

function startRunner(root, args, lock) {
  const env = { ...process.env, RUN_SUITES_ROOT: root, DRB_DEVDB_LOCK_FILE: lock };
  const c = track(spawn(process.execPath, [RUNNER, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }));
  c.out = '';
  c.err = '';
  c.stdout.on('data', (d) => { c.out += d; });
  c.stderr.on('data', (d) => { c.err += d; });
  return c;
}

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

function childPids(pid) {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return r.stdout.split('\n').filter(Boolean).map(Number);
}

const lockIsFree = (lock) => spawnSync('flock', ['-n', lock, 'true']).status === 0;
const pgrepFinds = (text) => spawnSync('pgrep', ['-f', text]).status === 0;

for (const sig of ['SIGTERM', 'SIGKILL']) {
  test(`a runner stopped with ${sig} while it waits never runs later and leaves no process`, async () => {
    const root = tmp('waitkill-');
    writeTree(root, { 'server/utils/good.test.js': PASSING_SUITE });
    const lock = path.join(root, 'test.lock');
    const holder = track(spawn('flock', [lock, 'sleep', '30'], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
    await until(() => !lockIsFree(lock));
    const logDir = path.join(root, 'logs');
    const runner = startRunner(root, ['server/utils/good.test.js', '--log-dir', logDir], lock);
    assert.ok(await until(() => /waiting for the dev-suite lock/.test(runner.err)), runner.err);
    process.kill(runner.pid, sig);
    await exited(runner);
    process.kill(-holder.pid, 'SIGKILL');
    await exited(holder);
    await sleep(1500);
    assert.ok(!fs.existsSync(path.join(logDir, logName('server/utils/good.test.js'))), 'the stopped runner ran its suite later');
    assert.ok(!pgrepFinds(lock), 'a process naming the lock file is still alive');
  });
}

test('a kill -9 of the runner is noticed between suites and the run stops there', async () => {
  const root = tmp('betweenkill-');
  writeTree(root, { 'server/utils/a-slow.test.js': SLOW_SUITE, 'server/utils/b-good.test.js': PASSING_SUITE });
  const lock = path.join(root, 'test.lock');
  const logDir = path.join(root, 'logs');
  const runner = startRunner(root, ['server/utils/a-slow.test.js', 'server/utils/b-good.test.js', '--log-dir', logDir], lock);
  assert.ok(await until(() => fs.existsSync(path.join(logDir, logName('server/utils/a-slow.test.js')))));
  process.kill(runner.pid, 'SIGKILL');
  await exited(runner);
  assert.ok(await until(() => !pgrepFinds(lock) && lockIsFree(lock)), 'the orphaned run never ended');
  assert.ok(!fs.existsSync(path.join(logDir, logName('server/utils/b-good.test.js'))), 'the orphaned run went on to the next suite');
  assert.ok(!fs.existsSync(path.join(logDir, 'summary.json')), 'a stopped run must not write a summary');
});

test('a kill -9 of the inner run leaves the lock held until its suite ends', async () => {
  const root = tmp('innerkill-');
  writeTree(root, { 'server/utils/slow.test.js': "const { test } = require('node:test');\ntest('slow', async () => { await new Promise((r) => setTimeout(r, 3000)); });\n" });
  const lock = path.join(root, 'test.lock');
  const logDir = path.join(root, 'logs');
  const runner = startRunner(root, ['server/utils/slow.test.js', '--log-dir', logDir], lock);
  assert.ok(await until(() => fs.existsSync(path.join(logDir, logName('server/utils/slow.test.js')))));
  await sleep(300);
  const [flockPid] = childPids(runner.pid);
  const [innerPid] = childPids(flockPid);
  assert.ok(innerPid, 'the inner run (the child of flock) was not found');
  const killedAt = Date.now();
  process.kill(innerPid, 'SIGKILL');
  await exited(runner);
  assert.ok(!lockIsFree(lock), 'the lock was freed while the suite still ran unlocked');
  assert.ok(await until(() => lockIsFree(lock), 8000), 'the lock never freed after the suite ended');
  assert.ok(Date.now() - killedAt >= 1500, 'the lock freed long before the suite could have ended');
});

test('an override of the root or the lock file is named on stderr, once', () => {
  const root = tmp('override-');
  writeTree(root, { 'server/utils/good.test.js': PASSING_SUITE });
  const r = runIn(root, ['server/utils/good.test.js', '--log-dir', path.join(root, 'logs')]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const lines = r.stderr.split('\n').filter((l) => /override/.test(l));
  assert.strictEqual(lines.length, 1, r.stderr);
  assert.match(lines[0], /RUN_SUITES_ROOT=/);
  assert.match(lines[0], /DRB_DEVDB_LOCK_FILE=/);
});

// ---- Reach: the defaults, the basename rule, and a --changed range git must verify ----

test('reachedSuites and stagedPaths default to the repo root (the plan calls reachedSuites(changedPaths))', () => {
  assert.ok(reachedSuites(['scripts/run-suites.js']).includes('scripts/run-suites.test.js'));
  assert.ok(Array.isArray(stagedPaths()));
});

test('reachedSuites: a test that names a changed file in quotes is reached, for a file of any extension', () => {
  const root = tmp('basename-');
  writeTree(root, {
    'server/db/schema.sql': '-- schema',
    'server/routes/a.test.js': "const sql = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');\n" + PASSING_SUITE,
    'server/routes/b.test.js': '// schema.sql is named only in a comment here\n' + PASSING_SUITE,
    'server/routes/c.test.js': "const f = 'old-schema.sql';\n" + PASSING_SUITE,
    'scripts/sensitive-paths.txt': 'server/\n',
    'scripts/x.test.js': 'const LIST = path.join(__dirname, "sensitive-paths.txt");\n' + PASSING_SUITE,
    'scripts/money-smoke-list.txt': 'server/a.test.js\n',
    'scripts/y.test.js': 'const LIST = `${__dirname}/money-smoke-list.txt`;\n' + PASSING_SUITE,
    'scripts/testdb-smoke.js': '// the smoke',
    'scripts/z.test.js': "const SMOKE = path.resolve(__dirname, 'testdb-smoke.js');\n" + PASSING_SUITE,
    'docs/schema.sql': '-- not under a root',
  });
  assert.deepStrictEqual(reachedSuites(['server/db/schema.sql'], { root }), ['server/routes/a.test.js']);
  assert.deepStrictEqual(reachedSuites(['scripts/sensitive-paths.txt'], { root }), ['scripts/x.test.js']);
  assert.deepStrictEqual(reachedSuites(['scripts/money-smoke-list.txt'], { root }), ['scripts/y.test.js']);
  assert.deepStrictEqual(reachedSuites(['scripts/testdb-smoke.js'], { root }), ['scripts/z.test.js']);
  assert.deepStrictEqual(reachedSuites(['docs/schema.sql'], { root }), []);
});

test('--changed: both ends must be commits git can verify; anything else is a usage error (exit 2)', () => {
  const root = gitRepo('range-', { 'server/utils/a.js': 'module.exports = 1;', 'server/utils/a.test.js': PASSING_SUITE });
  gitCommit(root, ['server/utils/a.js', 'server/utils/a.test.js'], 'one');
  writeTree(root, { 'server/utils/a.js': 'module.exports = 2;' });
  gitCommit(root, ['server/utils/a.js'], 'two');
  for (const bad of ['-SHEAD~1..HEAD', '...', '..HEAD', 'HEAD..', 'HEAD~1...HEAD', '--output=x..HEAD']) {
    const r = runIn(root, ['--changed', bad, '--log-dir', path.join(root, 'logs')]);
    assert.strictEqual(r.status, 2, `${bad}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /usage/, bad);
    assert.doesNotMatch(r.stdout, /no suites reached/, bad);
  }
  assert.ok(!fs.existsSync(path.join(root, 'x')), 'an option smuggled in as a range must never reach git');
  const good = runIn(root, ['--changed', 'HEAD~1..HEAD', '--log-dir', path.join(root, 'logs')]);
  assert.strictEqual(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /server\/utils\/a\.test\.js pass 2 fail 0/);
});


// ---- The TAP witness: counts come from the reporter's own file ----

test('a suite that prints a TAP summary of its own and registers no tests is a failure; its output lands in the .out file', () => {
  const root = tmp('witness-');
  writeTree(root, { 'server/utils/fake.test.js': "process.stdout.write('# pass 9\\n# fail 0\\n'); process.stderr.write('to stderr\\n');\n" });
  const logDir = path.join(root, 'logs');
  const r = runIn(root, ['server/utils/fake.test.js', '--log-dir', logDir]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /fake\.test\.js no TAP summary/);
  const summary = JSON.parse(fs.readFileSync(path.join(logDir, 'summary.json'), 'utf8'));
  assert.deepStrictEqual(summary.suites[0], { file: 'server/utils/fake.test.js', log: logName('server/utils/fake.test.js'), out: outName('server/utils/fake.test.js'), pass: 0, fail: 1, found: false, ok: false, exit_ok: true });
  const out = fs.readFileSync(path.join(logDir, outName('server/utils/fake.test.js')), 'utf8');
  assert.match(out, /# pass 9/);
  assert.match(out, /to stderr/);
  assert.doesNotMatch(fs.readFileSync(path.join(logDir, logName('server/utils/fake.test.js')), 'utf8'), /# pass 9/, 'the log is the TAP record alone');
});

// ---- The bound: GNU timeout kills a hung suite and everything it started ----

// A suite that starts a `sleep 30` whose argv[0] is a unique marker (so pgrep
// -f finds it and nothing else), writes the marker to a file, then hangs.
// TRAP=1 also ignores SIGTERM.
const HANG_SPAWN_SUITE = (marker, { trap = false } = {}) => `const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
${trap ? "process.on('SIGTERM', () => {});\n" : ''}test('hangs with a child', () => {
  spawn('sleep', ['30'], { argv0: ${JSON.stringify(marker)}, stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(marker)} + '.started', String(process.pid));
  setInterval(() => {}, 1000);
});
`;

function markerFor(root, name) {
  return path.join(root, `drbmark-${name}-${process.pid}-${Date.now()}`);
}

function killMarked(text) {
  spawnSync('pkill', ['-9', '-f', text]);
}

test('a hung suite and the child it started both die at the bound (no sleep survives)', async () => {
  const { runSuite } = require(RUNNER);
  const root = tmp('bound-');
  const marker = markerFor(root, 'bound');
  writeTree(root, { 'server/utils/hang.test.js': HANG_SPAWN_SUITE(marker) });
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir);
  const start = Date.now();
  const res = runSuite(root, 'server/utils/hang.test.js', logDir, { timeoutMs: 2000, quiet: true });
  const took = Date.now() - start;
  try {
    assert.ok(fs.existsSync(`${marker}.started`), 'the suite never started its child');
    assert.ok(took >= 1900 && took < 8000, `the bound did not hold: ${took} ms`);
    assert.strictEqual(res.failed, true);
    assert.match(res.line, /hang\.test\.js .*\(timed out at 2s\)/);
    assert.ok(await until(() => !pgrepFinds(marker), 1500), 'the suite\'s sleep outlived the bound');
  } finally {
    killMarked(marker);
  }
});

// A runner of one suite, outside the CLI, so the bound can be 2 s: it takes
// the lock through underLock exactly as run-suites does and hands runSuite the
// lock fd.
const BOUND_DRIVER = (runner, flockExec) => `'use strict';
const { underLock } = require(${JSON.stringify(flockExec)});
const { runSuite } = require(${JSON.stringify(runner)});
(async () => {
  const lock = await underLock({ lockFile: process.env.BD_LOCK, guardVar: 'BD_LOCKED', waitLine: 'driver: waiting' });
  const res = runSuite(process.env.BD_ROOT, 'server/utils/hang.test.js', process.env.BD_LOGS, { timeoutMs: 2000, quiet: true, lockFd: lock.lockFd });
  process.exit(res.failed ? 1 : 0);
})();
`;

test('after a kill -9 of the inner run, a hung suite still dies at the bound and the lock frees', async () => {
  const root = tmp('boundkill-');
  const marker = markerFor(root, 'boundkill');
  writeTree(root, {
    'server/utils/hang.test.js': HANG_SPAWN_SUITE(marker),
    'driver.js': BOUND_DRIVER(RUNNER, path.resolve(__dirname, 'lib', 'flockExec.js')),
  });
  const lock = path.join(root, 'test.lock');
  const logDir = path.join(root, 'logs');
  fs.mkdirSync(logDir);
  const env = { ...process.env, BD_LOCK: lock, BD_ROOT: root, BD_LOGS: logDir };
  const driver = track(spawn(process.execPath, [path.join(root, 'driver.js')], { env, stdio: 'ignore' }));
  try {
    assert.ok(await until(() => fs.existsSync(`${marker}.started`)), 'the suite never started');
    const started = Date.now();
    const [flockPid] = childPids(driver.pid);
    const [innerPid] = childPids(flockPid);
    assert.ok(innerPid, 'the inner run (the child of flock) was not found');
    process.kill(innerPid, 'SIGKILL');
    await exited(driver);
    assert.ok(!lockIsFree(lock), 'the lock freed while the suite still ran');
    assert.ok(await until(() => lockIsFree(lock), 6000), 'the lock never freed: the hung suite outlived its bound');
    assert.ok(Date.now() - started < 6000);
    assert.ok(await until(() => !pgrepFinds(marker), 1500), 'the suite\'s sleep outlived the bound');
  } finally {
    killMarked(marker);
    killMarked(root);
  }
});

test('a signal to a running runner stops a suite that ignores SIGTERM, and its child, within the kill-after, and frees the lock', async () => {
  const root = tmp('sigrun-');
  const marker = markerFor(root, 'sigrun');
  writeTree(root, { 'server/utils/hang.test.js': HANG_SPAWN_SUITE(marker, { trap: true }) });
  const lock = path.join(root, 'test.lock');
  const logDir = path.join(root, 'logs');
  const runner = startRunner(root, ['server/utils/hang.test.js', '--log-dir', logDir], lock);
  try {
    assert.ok(await until(() => fs.existsSync(`${marker}.started`)), runner.err);
    const sent = Date.now();
    process.kill(runner.pid, 'SIGTERM');
    await exited(runner);
    assert.strictEqual(runner.exitCode, 1, runner.err);
    assert.match(runner.err, /SIGTERM/);
    assert.ok(await until(() => lockIsFree(lock) && !pgrepFinds(marker), 9000), 'the trapping suite or its child outlived the signal');
    assert.ok(Date.now() - sent < 9000);
  } finally {
    killMarked(marker);
    killMarked(root);
  }
});

test('GNU coreutils timeout is required: without it the runner says so in one line and runs nothing', () => {
  const root = tmp('notimeout-');
  writeTree(root, { 'server/utils/good.test.js': PASSING_SUITE });
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // A timeout that is not GNU's (uutils prints this), and no gnutimeout.
  fs.writeFileSync(path.join(bin, 'timeout'), '#!/bin/sh\necho "timeout (uutils coreutils) 0.8.0"\n', { mode: 0o755 });
  const logDir = path.join(root, 'logs');
  const r = runIn(root, ['server/utils/good.test.js', '--log-dir', logDir], { PATH: bin });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /GNU coreutils timeout/);
  assert.strictEqual(r.stderr.trim().split('\n').filter((l) => !/override in effect/.test(l)).length, 1, r.stderr);
  assert.ok(!fs.existsSync(path.join(logDir, logName('server/utils/good.test.js'))), 'a suite ran unbounded');
});

test('a run that reaches nothing still writes an empty summary.json, in --log-dir or the default dir', () => {
  const root = gitRepo('empty-', { 'server/utils/a.js': 'module.exports = 1;', 'server/utils/a.test.js': PASSING_SUITE, 'docs/x.md': 'one' });
  gitCommit(root, ['server/utils/a.js', 'server/utils/a.test.js', 'docs/x.md'], 'one');
  writeTree(root, { 'docs/x.md': 'two' });
  gitCommit(root, ['docs/x.md'], 'two');
  const logDir = path.join(root, 'logs');
  writeTree(root, { 'logs/summary.json': '{"stale":true}\n' });
  const r = runIn(root, ['--changed', 'HEAD~1..HEAD', '--log-dir', logDir]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /no suites reached/);
  const empty = { suites: [], total_pass: 0, total_fail: 0, skipped: false };
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(logDir, 'summary.json'), 'utf8')), empty);
  const staged = runIn(root, ['--staged'], { DRB_DEVDB_LOCK_FILE: undefined });
  assert.strictEqual(staged.status, 0, staged.stdout + staged.stderr);
  const runs = fs.readdirSync(path.join(root, '.git', 'drb-review', '_runs'));
  assert.strictEqual(runs.length, 1);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, '.git', 'drb-review', '_runs', runs[0], 'summary.json'), 'utf8')), empty);
  assert.match(staged.stdout, new RegExp(runs[0]), 'the line names where the summary went');
});

test('reachedSuites: a list a module quotes reaches that module\'s tests (one more hop, through the module)', () => {
  const root = tmp('hop-');
  writeTree(root, {
    'scripts/list.txt': 'a\n',
    'scripts/matcher.js': "const LIST = path.join(__dirname, 'list.txt'); module.exports = LIST;",
    'scripts/matcher.test.js': "const m = require('./matcher');\n" + PASSING_SUITE,
    'scripts/gate.test.js': "const { m } = require('./matcher');\n" + PASSING_SUITE,
    'scripts/other.test.js': PASSING_SUITE,
  });
  assert.deepStrictEqual(reachedSuites(['scripts/list.txt'], { root }), ['scripts/gate.test.js', 'scripts/matcher.test.js']);
});

test('reachedSuites on this repo: the lane machinery reaches the suites that run it', () => {
  const lists = reachedSuites(['scripts/sensitive-paths.txt']);
  for (const t of ['scripts/sensitive-match.test.js', 'scripts/push-gate.test.js']) assert.ok(lists.includes(t), `sensitive-paths.txt does not reach ${t}`);
  const lock = reachedSuites(['scripts/lib/flockExec.js']);
  for (const t of ['scripts/run-suites.test.js', 'scripts/testdb-smoke.test.js']) assert.ok(lock.includes(t), `flockExec.js does not reach ${t}`);
  const tap = reachedSuites(['scripts/lib/tapSummary.js']);
  for (const t of ['scripts/run-suites.test.js', 'scripts/testdb-smoke.test.js']) assert.ok(tap.includes(t), `tapSummary.js does not reach ${t}`);
});

test('a waiter orphaned by a kill -9 of its runner never touches the log dir when it finally gets the lock', async () => {
  const root = tmp('orphanclear-');
  writeTree(root, { 'server/utils/good.test.js': PASSING_SUITE });
  const lock = path.join(root, 'test.lock');
  const logDir = path.join(root, 'logs');
  const holder = track(spawn('flock', [lock, 'sleep', '30'], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
  await until(() => !lockIsFree(lock));
  const runner = startRunner(root, ['server/utils/good.test.js', '--log-dir', logDir], lock);
  assert.ok(await until(() => /waiting for the dev-suite lock/.test(runner.err)), runner.err);
  process.kill(runner.pid, 'SIGKILL');
  await exited(runner);
  // Another run's finished results land in the same dir meanwhile.
  writeTree(root, { 'logs/summary.json': '{"other":true}\n', 'logs/server-utils-other.test.js.log': '# pass 1\n# fail 0\n' });
  process.kill(-holder.pid, 'SIGKILL');
  await exited(holder);
  assert.ok(await until(() => !pgrepFinds(lock) && lockIsFree(lock)), 'the orphaned waiter never ended');
  assert.strictEqual(fs.readFileSync(path.join(logDir, 'summary.json'), 'utf8'), '{"other":true}\n', 'the orphaned run cleared another run\'s summary');
  assert.ok(fs.existsSync(path.join(logDir, 'server-utils-other.test.js.log')), 'the orphaned run cleared another run\'s log');
});

// ---- A refusal never leaves an old passing summary standing ----

const STALE_PASS = '{"suites":[],"total_pass":5,"total_fail":0,"skipped":false}\n';
const didNotRun = (reason) => ({ suites: [], total_pass: 0, total_fail: 1, skipped: false, did_not_run: reason });

function readSummary(logDir) {
  const p = path.join(logDir, 'summary.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

test('every refusal after the log dir is prepared replaces an old passing summary with a did-not-run one', () => {
  const cases = [
    {
      name: 'a missing named file',
      tree: { 'server/utils/good.test.js': PASSING_SUITE },
      args: ['server/utils/nope.test.js'],
      reason: /no such file: server\/utils\/nope\.test\.js/,
    },
    {
      name: 'git failing under --staged',
      tree: {},
      args: ['--staged'],
      reason: /not a git repository/i,
    },
    {
      name: 'no GNU timeout',
      tree: { 'server/utils/good.test.js': PASSING_SUITE, 'bin/timeout': '#!/bin/sh\necho "timeout (uutils coreutils) 0.8.0"\n' },
      args: ['server/utils/good.test.js'],
      env: (root) => ({ PATH: path.join(root, 'bin') }),
      reason: /GNU coreutils timeout/,
    },
    {
      name: 'git failing to name the default lock',
      tree: { 'server/utils/good.test.js': PASSING_SUITE },
      args: ['server/utils/good.test.js'],
      env: () => ({ DRB_DEVDB_LOCK_FILE: undefined }),
      reason: /not a git repository/i,
    },
  ];
  for (const c of cases) {
    const root = tmp('refuse-');
    writeTree(root, { ...c.tree, 'logs/summary.json': STALE_PASS });
    if (c.tree['bin/timeout']) fs.chmodSync(path.join(root, 'bin', 'timeout'), 0o755);
    const logDir = path.join(root, 'logs');
    const r = runIn(root, [...c.args, '--log-dir', logDir], c.env ? c.env(root) : {});
    assert.strictEqual(r.status, 1, `${c.name}: ${r.stdout}${r.stderr}`);
    const lines = r.stderr.trim().split('\n').filter((l) => !/override in effect/.test(l));
    assert.strictEqual(lines.length, 1, `${c.name}: one line, never a stack trace: ${r.stderr}`);
    const summary = readSummary(logDir);
    assert.ok(summary, `${c.name}: no summary.json at all`);
    assert.match(String(summary.did_not_run), c.reason, `${c.name}: ${JSON.stringify(summary)}`);
    assert.deepStrictEqual(summary, didNotRun(summary.did_not_run), c.name);
  }
});

test('a usage error after parseArgs (a --changed end git cannot verify) still removes an old passing summary', () => {
  const root = gitRepo('refuse-range-', { 'server/utils/a.test.js': PASSING_SUITE, 'logs/summary.json': STALE_PASS });
  gitCommit(root, ['server/utils/a.test.js'], 'one');
  const logDir = path.join(root, 'logs');
  const r = runIn(root, ['--changed', 'nope..HEAD', '--log-dir', logDir]);
  assert.strictEqual(r.status, 2, r.stdout + r.stderr);
  assert.strictEqual(readSummary(logDir), null, 'the old passing summary survived the refusal');
});

// ---- One run per log dir, and only the runner's own files ----

function listing(dir) {
  return fs.readdirSync(dir).sort().map((n) => `${n}=${fs.readFileSync(path.join(dir, n), 'utf8')}`);
}

test('a --log-dir holding a file no runner wrote is refused in one line and left exactly as it was', () => {
  const root = tmp('foreign-');
  writeTree(root, {
    'server/utils/good.test.js': PASSING_SUITE,
    'logs/notes.txt': 'mine\n',
    'logs/summary.json': STALE_PASS,
    'logs/server-utils-old.test.js.log': 'old\n',
  });
  const logDir = path.join(root, 'logs');
  const before = listing(logDir);
  const r = runIn(root, ['server/utils/good.test.js', '--log-dir', logDir]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(r.stderr.trim().split('\n').filter((l) => !/override in effect/.test(l)).length, 1, r.stderr);
  assert.match(r.stderr, /notes\.txt/);
  assert.deepStrictEqual(listing(logDir), before, 'the refused dir was changed');
});

test('two runs on one --log-dir: the second refuses in one line while the first lives; the marker goes when the first ends', async () => {
  const root = tmp('onedir-');
  writeTree(root, { 'server/utils/good.test.js': PASSING_SUITE });
  const lock = path.join(root, 'test.lock');
  const logDir = path.join(root, 'logs');
  const holder = track(spawn('flock', [lock, 'sleep', '30'], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
  await until(() => !lockIsFree(lock));
  const first = startRunner(root, ['server/utils/good.test.js', '--log-dir', logDir], lock);
  assert.ok(await until(() => /waiting for the dev-suite lock/.test(first.err)), first.err);
  const marker = path.join(logDir, '.drb-run');
  assert.ok(fs.existsSync(marker), 'the waiting run left no marker');
  const second = runIn(root, ['server/utils/good.test.js', '--log-dir', logDir], { DRB_DEVDB_LOCK_FILE: lock });
  assert.strictEqual(second.status, 1, second.stdout + second.stderr);
  assert.strictEqual(second.stderr.trim().split('\n').filter((l) => !/override in effect/.test(l)).length, 1, second.stderr);
  assert.match(second.stderr, new RegExp(`in use by another run \\(pid ${first.pid}`));
  assert.ok(fs.existsSync(marker), 'the second run took the first one\'s marker');
  process.kill(-holder.pid, 'SIGKILL');
  await exited(first);
  assert.strictEqual(first.exitCode, 0, first.out + first.err);
  assert.ok(!fs.existsSync(marker), 'the marker outlived its run');
  assert.strictEqual(readSummary(logDir).total_pass, 2);
});

test('a marker naming a dead pid is cleared, and the run goes ahead', async () => {
  const root = tmp('stalemark-');
  const gone = spawn('true');
  await exited(gone);
  writeTree(root, { 'server/utils/good.test.js': PASSING_SUITE, 'logs/.drb-run': `${gone.pid}\n` });
  const logDir = path.join(root, 'logs');
  const r = runIn(root, ['server/utils/good.test.js', '--log-dir', logDir]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.ok(!fs.existsSync(path.join(logDir, '.drb-run')), 'the stale marker was left behind');
  assert.strictEqual(readSummary(logDir).total_pass, 2);
});

test('after a kill -9 of the launcher, a second run on its dir still refuses while the orphaned inner finishes its suite', async () => {
  const root = tmp('orphandir-');
  writeTree(root, { 'server/utils/a-slow.test.js': SLOW_SUITE, 'server/utils/b-good.test.js': PASSING_SUITE });
  const lock = path.join(root, 'test.lock');
  const logDir = path.join(root, 'logs');
  const runner = startRunner(root, ['server/utils/a-slow.test.js', 'server/utils/b-good.test.js', '--log-dir', logDir], lock);
  assert.ok(await until(() => fs.existsSync(path.join(logDir, logName('server/utils/a-slow.test.js')))));
  process.kill(runner.pid, 'SIGKILL');
  await exited(runner);
  const second = runIn(root, ['server/utils/b-good.test.js', '--log-dir', logDir], { DRB_DEVDB_LOCK_FILE: lock });
  assert.strictEqual(second.status, 1, `the second run went ahead under the orphaned inner: ${second.stdout}${second.stderr}`);
  assert.match(second.stderr, /in use by another run/);
  assert.ok(await until(() => !pgrepFinds(lock) && lockIsFree(lock)), 'the orphaned run never ended');
  assert.ok(!fs.existsSync(path.join(logDir, '.drb-run')), 'the orphaned inner left its marker');
  const third = runIn(root, ['server/utils/b-good.test.js', '--log-dir', logDir], { DRB_DEVDB_LOCK_FILE: lock });
  assert.strictEqual(third.status, 0, third.stdout + third.stderr);
});

test('a SIGTERM to the locked run, once its launcher is killed -9, still lets its log dir go', async () => {
  const root = tmp('innersig-');
  writeTree(root, { 'server/utils/a-slow.test.js': SLOW_SUITE, 'server/utils/b-good.test.js': PASSING_SUITE });
  const lock = path.join(root, 'test.lock');
  const logDir = path.join(root, 'logs');
  const runner = startRunner(root, ['server/utils/a-slow.test.js', 'server/utils/b-good.test.js', '--log-dir', logDir], lock);
  assert.ok(await until(() => fs.existsSync(path.join(logDir, logName('server/utils/a-slow.test.js')))));
  const [flockPid] = childPids(runner.pid);
  const [innerPid] = childPids(flockPid);
  assert.ok(innerPid, 'the inner run (the child of flock) was not found');
  process.kill(runner.pid, 'SIGKILL');
  await exited(runner);
  process.kill(innerPid, 'SIGTERM');
  assert.ok(await until(() => !pgrepFinds(lock) && lockIsFree(lock)), 'the locked run never ended');
  assert.ok(!fs.existsSync(path.join(logDir, '.drb-run')), 'the locked run died with the dir still claimed');
  assert.ok(!fs.existsSync(path.join(logDir, logName('server/utils/b-good.test.js'))), 'the signalled run went on to the next suite');
});

// ---- The session sweep: what a suite leaves outside timeout's group dies after it ----

// A suite that starts a marked `sleep 30` which leaves GNU timeout's process
// group (setpgrp) but stays in the run's session, then ends at once.
const LEAK_SUITE = (marker) => `const { test } = require('node:test');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
test('leaves a process behind, outside its process group', () => {
  const c = spawn('perl', ['-e', 'setpgrp(0, 0); sleep 30', ${JSON.stringify(marker)}], { stdio: 'ignore' });
  c.unref();
  fs.writeFileSync(${JSON.stringify(marker)} + '.started', String(c.pid));
});
`;

test('a process a suite left in the run\'s session, outside its group, is killed once the suite ends', async () => {
  const root = tmp('sweep-');
  const marker = markerFor(root, 'sweep');
  writeTree(root, { 'server/utils/leak.test.js': LEAK_SUITE(marker), 'server/utils/good.test.js': PASSING_SUITE });
  const logDir = path.join(root, 'logs');
  try {
    const r = runIn(root, ['server/utils/leak.test.js', 'server/utils/good.test.js', '--log-dir', logDir]);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    assert.ok(fs.existsSync(`${marker}.started`), 'the suite never started its child');
    assert.ok(await until(() => !pgrepFinds(marker), 1500), 'the detached sleep outlived the suite');
    assert.match(r.stderr, /leak\.test\.js left 1 process/);
    assert.strictEqual(readSummary(logDir).total_pass, 3);
  } finally {
    killMarked(marker);
  }
});

test('stagedPaths reads HEAD under an env that ignores replace refs: a replaced HEAD does not fake a staged change (pii quick-fix security L4)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-replace-'));
  try {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', ['t', 'example.com'].join('@'));
    git('config', 'user.name', 't');
    git('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(dir, 'x.js'), 'const a = 1;\n');
    git('add', 'x.js');
    git('commit', '-q', '-m', 'A');
    const A = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(dir, 'x.js'), 'const a = 2;\n');
    git('add', 'x.js');
    git('commit', '-q', '-m', 'B');
    const B = git('rev-parse', 'HEAD');
    git('replace', B, A);
    assert.deepStrictEqual(stagedPaths({ root: dir }), [], 'the index equals the real HEAD; only a replace ref would make x.js look staged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
