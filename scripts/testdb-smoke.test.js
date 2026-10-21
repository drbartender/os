'use strict';

// node:test suite for scripts/testdb-smoke.js: its flags, the smoke lock and
// the --tap-dir summary. SAFETY: testdb-smoke resets a shared Neon branch and
// runs the money suites when it finds a key, so every run of it in this file
// goes through noKeyEnv (HOME is an empty directory, NEON_API_KEY and
// NODE_OPTIONS are gone, cwd is a temp dir with no .env): even a regression in
// the flag handling can only reach the SKIP path. The module is required in
// this process only after a child process has proved that requiring it runs
// nothing.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SMOKE = path.resolve(__dirname, 'testdb-smoke.js');
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

// No Neon key can resolve in this environment.
function noKeyEnv(root, extra) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, ...extra };
  delete env.NEON_API_KEY;
  delete env.NODE_OPTIONS;
  return env;
}

function smoke(root, args, extra = {}) {
  return spawnSync(process.execPath, [SMOKE, ...args], {
    cwd: root, encoding: 'utf8', timeout: 20000, env: noKeyEnv(root, { DRB_SMOKE_LOCK_FILE: path.join(root, 'smoke.lock'), ...extra }),
  });
}

test('requiring testdb-smoke.js runs nothing: no output, no lock, no summary', () => {
  const root = tmp('smoke-require-');
  const tapDir = path.join(root, 'tap');
  // The argv a top-level flow would read is `--tap-dir <dir>`: if requiring the
  // module ran the flow, it would print the SKIP banner and write summary.json.
  const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(SMOKE)})`, '--', 'x', '--tap-dir', tapDir], {
    cwd: root, encoding: 'utf8', timeout: 20000, env: noKeyEnv(root, { DRB_SMOKE_LOCK_FILE: path.join(root, 'smoke.lock') }),
  });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(r.stdout + r.stderr, '', 'requiring the module printed something');
  assert.ok(!fs.existsSync(path.join(tapDir, 'summary.json')), 'requiring the module wrote a summary');
  assert.ok(!fs.existsSync(path.join(root, 'smoke.lock')), 'requiring the module took the lock');
});

test('parseArgs: --dry-lock and --tap-dir once each; anything else is an error', () => {
  const { parseArgs } = require(SMOKE);
  assert.deepStrictEqual(parseArgs([]), { dryLock: false, tapDir: null });
  assert.deepStrictEqual(parseArgs(['--dry-lock']), { dryLock: true, tapDir: null });
  assert.deepStrictEqual(parseArgs(['--tap-dir', 'out', '--dry-lock']), { dryLock: true, tapDir: path.resolve('out') });
  for (const bad of [['--bogus'], ['--tap-dir'], ['--tap-dir', '--dry-lock'], ['--dry-lock', '--dry-lock'], ['--tap-dir', 'a', '--tap-dir', 'b'], ['extra']]) {
    assert.ok(parseArgs(bad).error, JSON.stringify(bad));
  }
});

test('smokeLockFile: DRB_SMOKE_LOCK_FILE wins, else drb-smoke.lock in the git common dir', () => {
  const { smokeLockFile } = require(SMOKE);
  const saved = process.env.DRB_SMOKE_LOCK_FILE;
  try {
    process.env.DRB_SMOKE_LOCK_FILE = 'rel/smoke.lock';
    assert.strictEqual(smokeLockFile(), path.resolve('rel/smoke.lock'));
    delete process.env.DRB_SMOKE_LOCK_FILE;
    assert.match(smokeLockFile(), /\/drb-smoke\.lock$/);
    assert.ok(path.isAbsolute(smokeLockFile()));
  } finally {
    if (saved === undefined) delete process.env.DRB_SMOKE_LOCK_FILE;
    else process.env.DRB_SMOKE_LOCK_FILE = saved;
  }
});

// ---- The smoke lock and the flags, each run in the no-key env ----

test('a holder killed with -9 releases the smoke lock and --dry-lock acquires it', () => {
  const root = tmp('smoke-lock-');
  const lock = path.join(root, 'smoke.lock');
  // flock(1) hands the locked fd to its child, so flock and sleep both hold the
  // lock: -9 goes to the holder's whole process group, as a crash would.
  const holder = track(spawn('flock', [lock, 'sleep', '30'], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
  spawnSync('sleep', ['0.3']);
  const busy = spawnSync('flock', ['-n', lock, 'true']);
  assert.notStrictEqual(busy.status, 0, 'the lock should be held before the kill');
  process.kill(-holder.pid, 'SIGKILL');
  spawnSync('sleep', ['0.3']);
  const res = smoke(root, ['--dry-lock'], { DRB_SMOKE_LOCK_FILE: lock });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /smoke lock acquired/);
});

test('testdb-smoke --tap-dir with no Neon key writes a summary with skipped: true', () => {
  const root = tmp('smoke-skip-');
  const tapDir = path.join(root, 'tap');
  const res = smoke(root, ['--tap-dir', tapDir]);
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  const summary = JSON.parse(fs.readFileSync(path.join(tapDir, 'summary.json'), 'utf8'));
  assert.strictEqual(summary.skipped, true);
  assert.deepStrictEqual(summary.suites, []);
  assert.strictEqual(summary.total_pass, 0);
});

test('testdb-smoke: a usage error exits 2 before the lock and before any key lookup', () => {
  const root = tmp('smoke-usage-');
  for (const bad of [['--bogus'], ['--tap-dir'], ['--tap-dir', '--dry-lock']]) {
    const r = smoke(root, bad);
    assert.strictEqual(r.status, 2, JSON.stringify(bad) + r.stdout + r.stderr);
    assert.match(r.stderr, /usage/);
    assert.doesNotMatch(r.stdout + r.stderr, /MONEY SMOKE/, 'a usage error never reaches the key lookup');
  }
  assert.ok(!fs.existsSync(path.join(root, 'smoke.lock')), 'a usage error never touches the lock');
});

test('testdb-smoke --dry-lock touches nothing else, not even the --tap-dir directory', () => {
  const root = tmp('smoke-dry-');
  const tapDir = path.join(root, 'tap');
  const r = smoke(root, ['--dry-lock', '--tap-dir', tapDir]);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /smoke lock acquired/);
  assert.doesNotMatch(r.stdout + r.stderr, /MONEY SMOKE/);
  assert.ok(!fs.existsSync(tapDir));
});

test('testdb-smoke waits on a held smoke lock and says so, then acquires it', async () => {
  const root = tmp('smoke-wait-');
  const lock = path.join(root, 'smoke.lock');
  const holder = track(spawn('flock', [lock, 'sleep', '1.5'], { stdio: 'ignore' }));
  await sleep(300);
  const start = Date.now();
  const r = smoke(root, ['--dry-lock'], { DRB_SMOKE_LOCK_FILE: lock });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /waiting for the smoke lock/);
  assert.match(r.stdout, /smoke lock acquired/);
  assert.ok(Date.now() - start >= 1000, 'it waited for the holder');
  await exited(holder);
});

// ---- How the smoke runs one suite (a fixture, a dummy URL: no database) ----

test('runSuite: a money suite that registers no tests is a failure in the summary, never "pass 1"', () => {
  const { runSuite } = require(SMOKE);
  const { smokeSummary } = require('./lib/tapSummary');
  const root = tmp('smoke-runsuite-');
  const tapDir = path.join(root, 'tap');
  fs.mkdirSync(tapDir);
  const zero = path.join(root, 'zero.test.js');
  fs.writeFileSync(zero, "process.stdout.write('no tests here\\n');\n");
  const results = [];
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT; // the smoke is never itself started from node:test
  try {
    runSuite(zero, 'postgres://unused.invalid/none', tapDir, results);
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
  const s = smokeSummary(results);
  assert.deepStrictEqual(s.suites[0], { file: zero, log: logName(zero), out: outName(zero), pass: 0, fail: 1, found: false, ok: false, exit_ok: true });
  assert.strictEqual(s.total_fail, 1);
});

// ---- Stopping a waiting smoke, the stale summary, the override line, the fd ----

function startSmoke(root, args, lock) {
  const c = track(spawn(process.execPath, [SMOKE, ...args], { cwd: root, env: noKeyEnv(root, { DRB_SMOKE_LOCK_FILE: lock }), stdio: ['ignore', 'pipe', 'pipe'] }));
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

const lockIsFree = (lock) => spawnSync('flock', ['-n', lock, 'true']).status === 0;
const pgrepFinds = (text) => spawnSync('pgrep', ['-f', text]).status === 0;

for (const sig of ['SIGTERM', 'SIGKILL']) {
  test(`a smoke stopped with ${sig} while it waits never takes the lock later and leaves no process`, async () => {
    const root = tmp('smoke-waitkill-');
    const lock = path.join(root, 'smoke.lock');
    const holder = track(spawn('flock', [lock, 'sleep', '30'], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
    await until(() => !lockIsFree(lock));
    const run = startSmoke(root, ['--dry-lock'], lock);
    assert.ok(await until(() => /waiting for the smoke lock/.test(run.err)), run.err);
    process.kill(run.pid, sig);
    await exited(run);
    process.kill(-holder.pid, 'SIGKILL');
    await exited(holder);
    await sleep(1500);
    assert.doesNotMatch(run.out, /smoke lock acquired/, 'the stopped smoke took the lock later');
    assert.ok(!pgrepFinds(lock), 'a process naming the lock file is still alive');
  });
}

test('--tap-dir: the previous summary.json, .log and .out files are gone while the smoke waits for its lock', async () => {
  const root = tmp('smoke-stale-');
  const tapDir = path.join(root, 'tap');
  fs.mkdirSync(tapDir);
  fs.writeFileSync(path.join(tapDir, 'summary.json'), '{"stale":true}\n');
  fs.writeFileSync(path.join(tapDir, 'server-gone.test.js.log'), '# pass 3\n# fail 0\n');
  fs.writeFileSync(path.join(tapDir, 'server-gone.test.js.out'), 'old\n');
  const lock = path.join(root, 'smoke.lock');
  const holder = track(spawn('flock', [lock, 'sleep', '30'], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
  await until(() => !lockIsFree(lock));
  const run = startSmoke(root, ['--tap-dir', tapDir], lock);
  assert.ok(await until(() => /waiting for the smoke lock/.test(run.err)), run.err);
  assert.ok(!fs.existsSync(path.join(tapDir, 'summary.json')), 'the previous summary still stands in for a run that has not happened');
  assert.ok(!fs.existsSync(path.join(tapDir, 'server-gone.test.js.log')), 'an old log still stands in the reused dir');
  assert.ok(!fs.existsSync(path.join(tapDir, 'server-gone.test.js.out')), 'an old .out still stands in the reused dir');
  process.kill(run.pid, 'SIGTERM');
  await exited(run);
  process.kill(-holder.pid, 'SIGKILL');
  await exited(holder);
});

test('an override of the smoke lock file is named on stderr, once', () => {
  const root = tmp('smoke-override-');
  const r = smoke(root, ['--dry-lock']);
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const lines = r.stderr.split('\n').filter((l) => /override/.test(l));
  assert.strictEqual(lines.length, 1, r.stderr);
  assert.match(lines[0], /DRB_SMOKE_LOCK_FILE=/);
});

test('runSuite hands the lock fd to the suite as fd 3', () => {
  const { runSuite } = require(SMOKE);
  const { smokeSummary } = require('./lib/tapSummary');
  const root = tmp('smoke-fd-');
  const tapDir = path.join(root, 'tap');
  fs.mkdirSync(tapDir);
  const lockPath = path.join(root, 'smoke.lock');
  const lockFd = fs.openSync(lockPath, 'w');
  const suite = path.join(root, 'fd.test.js');
  fs.writeFileSync(suite, `const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
test('fd 3 is the lock file', () => assert.strictEqual(fs.readlinkSync('/proc/self/fd/3'), ${JSON.stringify(fs.realpathSync(lockPath))}));
`);
  const results = [];
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    runSuite(suite, 'postgres://unused.invalid/none', tapDir, results, lockFd);
  } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
    fs.closeSync(lockFd);
  }
  assert.deepStrictEqual(smokeSummary(results).suites[0], { file: suite, log: logName(suite), out: outName(suite), pass: 1, fail: 0, found: true, ok: true, exit_ok: true });
});

test('runSuite strips NODE_TEST_CONTEXT: a suite the smoke runs from inside node:test still reports TAP', () => {
  const { runSuite } = require(SMOKE);
  const { smokeSummary } = require('./lib/tapSummary');
  const root = tmp('smoke-ctx-');
  const tapDir = path.join(root, 'tap');
  fs.mkdirSync(tapDir);
  const suite = path.join(root, 'ctx.test.js');
  fs.writeFileSync(suite, "const { test } = require('node:test');\ntest('one', () => {});\n");
  const results = [];
  const saved = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = 'child-v8'; // what node --test gives a file it runs
  try {
    runSuite(suite, 'postgres://unused.invalid/none', tapDir, results);
  } finally {
    if (saved === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = saved;
  }
  const [entry] = smokeSummary(results).suites;
  assert.strictEqual(entry.found, true, 'the suite reported v8-serialized results instead of TAP');
  assert.strictEqual(entry.pass, 1);
  assert.strictEqual(entry.ok, true);
});

// ---- The gate path: the tick is the verdict, never the exit code alone ----

// Runs the smoke's runSuite in a child (so its console is captured) with
// TMPDIR inside the test's own dir, and returns its stdout and the verdict.
function runSuiteInChild(root, suite, tapDir, opts = {}) {
  const tmpdir = path.join(root, 'tmpdir');
  fs.mkdirSync(tmpdir, { recursive: true });
  const code = `const { runSuite } = require(${JSON.stringify(SMOKE)});
const ok = runSuite(${JSON.stringify(suite)}, 'postgres://unused.invalid/none', ${JSON.stringify(tapDir)}, [], null, ${JSON.stringify(opts)});
process.stdout.write('\\nRESULT ' + JSON.stringify({ ok }) + '\\n');`;
  const r = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', env: noKeyEnv(root, { TMPDIR: tmpdir }) });
  const m = /RESULT (\{.*\})/.exec(r.stdout);
  return { r, ok: m ? JSON.parse(m[1]).ok : undefined, tmpdir };
}

const ZERO_SUITE = "process.stdout.write('no tests here\\n');\n";
const EXIT0_SUITE = "const { test } = require('node:test');\ntest('a', () => {});\ntest('b', async () => { await new Promise((r) => setTimeout(r, 50)); process.exit(0); });\ntest('c', () => {});\n";
const GREEN_SUITE = "const { test } = require('node:test');\ntest('one', () => {});\ntest('two', () => {});\n";

for (const [name, body] of [['registers no tests', ZERO_SUITE], ['calls process.exit(0) mid-file', EXIT0_SUITE]]) {
  test(`a money suite that ${name} prints a cross and fails, on the gate path and with --tap-dir`, () => {
    const root = tmp('smoke-verdict-');
    const suite = path.join(root, 'v.test.js');
    fs.writeFileSync(suite, body);
    const gate = runSuiteInChild(root, suite, null);
    assert.strictEqual(gate.r.status, 0, gate.r.stdout + gate.r.stderr);
    assert.strictEqual(gate.ok, false, 'the gate path read a suite with no TAP summary as a pass');
    assert.match(gate.r.stdout, /\u2717 .*v\.test\.js/);
    assert.doesNotMatch(gate.r.stdout, /\u2713/);
    const tapDir = path.join(root, 'tap');
    fs.mkdirSync(tapDir);
    const tap = runSuiteInChild(root, suite, tapDir);
    assert.strictEqual(tap.ok, false, 'with --tap-dir the tick came from the exit code');
    assert.match(tap.r.stdout, /\u2717 .*v\.test\.js/);
  });
}

// Node's own console report for a suite run with no reporter flags, timings
// removed, so two runs compare line for line.
function untimed(text) {
  return text.split('\n').filter((l) => !/duration_ms/.test(l)).map((l) => l.replace(/ \(\d+(\.\d+)?ms\)/, '')).join('\n');
}

test('the gate path keeps Node\'s default console report and a clean suite still ticks; its TAP witness is removed', () => {
  const root = tmp('smoke-console-');
  const suite = path.join(root, 'g.test.js');
  fs.writeFileSync(suite, GREEN_SUITE);
  const gate = runSuiteInChild(root, suite, null);
  assert.strictEqual(gate.ok, true, gate.r.stdout + gate.r.stderr);
  assert.match(gate.r.stdout, /\u2713 .*g\.test\.js/);
  const plainEnv = { ...process.env };
  delete plainEnv.NODE_TEST_CONTEXT;
  const plain = spawnSync(process.execPath, [suite], { encoding: 'utf8', timeout: 20000, env: plainEnv });
  assert.ok(untimed(plain.stdout).trim().length > 0, 'the default run printed nothing to compare');
  assert.ok(untimed(gate.r.stdout).includes(untimed(plain.stdout).trim()), `the console report changed:\n${gate.r.stdout}\n---\n${plain.stdout}`);
  assert.deepStrictEqual(fs.readdirSync(gate.tmpdir), [], 'the per-suite TAP witness was left behind');
});

test('the smoke bounds a hung money suite and everything it started (no sleep survives)', async () => {
  const root = tmp('smoke-bound-');
  const marker = path.join(root, `drbmark-smoke-${process.pid}-${Date.now()}`);
  const suite = path.join(root, 'hang.test.js');
  fs.writeFileSync(suite, `const { test } = require('node:test');
const { spawn } = require('node:child_process');
test('hangs with a child', () => {
  spawn('sleep', ['30'], { argv0: ${JSON.stringify(marker)}, stdio: 'ignore' });
  setInterval(() => {}, 1000);
});
`);
  const start = Date.now();
  const gate = runSuiteInChild(root, suite, null, { timeoutMs: 2000 });
  const took = Date.now() - start;
  try {
    assert.ok(!gate.r.error, `the smoke's suite was never bounded (${gate.r.error && gate.r.error.code})`);
    assert.strictEqual(gate.ok, false);
    assert.match(gate.r.stdout, /✗ .*hang\.test\.js .*TIMED OUT at 2s/);
    assert.ok(took < 10000, `took ${took} ms`);
    assert.ok(await until(() => !pgrepFinds(marker), 1500), 'the suite\'s sleep outlived the bound');
  } finally {
    spawnSync('pkill', ['-9', '-f', marker]);
    spawnSync('pkill', ['-9', '-f', root]);
  }
});

test('smokeLockFile throws when git cannot name the common dir (it never exits its caller); the CLI turns that into its BLOCKED line', () => {
  const root = tmp('smoke-nogit-');
  const empty = path.join(root, 'bin');
  fs.mkdirSync(empty);
  const code = `const { smokeLockFile } = require(${JSON.stringify(SMOKE)});
try { smokeLockFile(); process.stdout.write('returned\\n'); } catch (err) { process.stdout.write('threw: ' + err.message + '\\n'); }`;
  const env = noKeyEnv(root, { PATH: empty });
  delete env.DRB_SMOKE_LOCK_FILE;
  const lib = spawnSync(process.execPath, ['-e', code], { cwd: root, encoding: 'utf8', timeout: 20000, env });
  assert.strictEqual(lib.status, 0, `smokeLockFile exited its caller: ${lib.stdout}${lib.stderr}`);
  assert.match(lib.stdout, /^threw: .*git common dir/m);
  const cli = spawnSync(process.execPath, [SMOKE, '--dry-lock'], { cwd: root, encoding: 'utf8', timeout: 20000, env });
  assert.strictEqual(cli.status, 1, cli.stdout + cli.stderr);
  assert.match(cli.stderr, /BLOCKED/);
  assert.match(cli.stderr, /git common dir/);
  assert.doesNotMatch(cli.stdout, /smoke lock acquired/);
});

test('a smoke waiter orphaned by a kill -9 never touches the --tap-dir when it finally gets the lock', async () => {
  const root = tmp('smoke-orphanclear-');
  const tapDir = path.join(root, 'tap');
  const lock = path.join(root, 'smoke.lock');
  const holder = track(spawn('flock', [lock, 'sleep', '30'], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
  await until(() => !lockIsFree(lock));
  const run = startSmoke(root, ['--tap-dir', tapDir], lock);
  assert.ok(await until(() => /waiting for the smoke lock/.test(run.err)), run.err);
  process.kill(run.pid, 'SIGKILL');
  await exited(run);
  fs.writeFileSync(path.join(tapDir, 'summary.json'), '{"other":true}\n');
  process.kill(-holder.pid, 'SIGKILL');
  await exited(holder);
  assert.ok(await until(() => !pgrepFinds(lock) && lockIsFree(lock)), 'the orphaned waiter never ended');
  assert.strictEqual(fs.readFileSync(path.join(tapDir, 'summary.json'), 'utf8'), '{"other":true}\n', 'the orphaned smoke cleared another run\'s summary');
});

test('--tap-dir: smokeLockFile failing replaces an old passing summary with a did-not-run one', () => {
  const root = tmp('smoke-refuse-');
  const tapDir = path.join(root, 'tap');
  fs.mkdirSync(tapDir);
  fs.writeFileSync(path.join(tapDir, 'summary.json'), '{"suites":[],"total_pass":5,"total_fail":0,"skipped":false}\n');
  const empty = path.join(root, 'bin');
  fs.mkdirSync(empty);
  const env = noKeyEnv(root, { PATH: empty });
  delete env.DRB_SMOKE_LOCK_FILE;
  const r = spawnSync(process.execPath, [SMOKE, '--tap-dir', tapDir], { cwd: root, encoding: 'utf8', timeout: 20000, env });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /BLOCKED/);
  const summary = JSON.parse(fs.readFileSync(path.join(tapDir, 'summary.json'), 'utf8'));
  assert.match(summary.did_not_run, /git common dir/);
  assert.deepStrictEqual(summary, { suites: [], total_pass: 0, total_fail: 1, skipped: false, did_not_run: summary.did_not_run });
});

test('--tap-dir holding a file no runner wrote is refused in one line and left exactly as it was', () => {
  const root = tmp('smoke-foreign-');
  const tapDir = path.join(root, 'tap');
  fs.mkdirSync(tapDir);
  fs.writeFileSync(path.join(tapDir, 'notes.txt'), 'mine\n');
  fs.writeFileSync(path.join(tapDir, 'summary.json'), '{"stale":true}\n');
  const before = fs.readdirSync(tapDir).sort().map((n) => `${n}=${fs.readFileSync(path.join(tapDir, n), 'utf8')}`);
  const r = smoke(root, ['--tap-dir', tapDir]);
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.strictEqual(r.stderr.trim().split('\n').filter((l) => !/override in effect/.test(l)).length, 1, r.stderr);
  assert.match(r.stderr, /notes\.txt/);
  assert.doesNotMatch(r.stdout + r.stderr, /MONEY SMOKE/);
  assert.deepStrictEqual(fs.readdirSync(tapDir).sort().map((n) => `${n}=${fs.readFileSync(path.join(tapDir, n), 'utf8')}`), before);
});

test('two smokes on one --tap-dir: the second refuses in one line while the first lives', async () => {
  const root = tmp('smoke-onedir-');
  const tapDir = path.join(root, 'tap');
  const lock = path.join(root, 'smoke.lock');
  const holder = track(spawn('flock', [lock, 'sleep', '30'], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
  await until(() => !lockIsFree(lock));
  const first = startSmoke(root, ['--tap-dir', tapDir], lock);
  assert.ok(await until(() => /waiting for the smoke lock/.test(first.err)), first.err);
  const second = smoke(root, ['--tap-dir', tapDir], { DRB_SMOKE_LOCK_FILE: lock });
  assert.strictEqual(second.status, 1, second.stdout + second.stderr);
  assert.match(second.stderr, new RegExp(`in use by another run \\(pid ${first.pid}`));
  process.kill(-holder.pid, 'SIGKILL');
  await exited(first);
  assert.strictEqual(first.exitCode, 0, first.out + first.err);
  assert.ok(!fs.existsSync(path.join(tapDir, '.drb-run')), 'the marker outlived its run');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tapDir, 'summary.json'), 'utf8')).skipped, true);
});

test('SIGTERM to a process running the exported runSuite leaves no drb-smoke-tap-* dir and exits 143', async () => {
  const root = tmp('smoke-sigtemp-');
  const tmpdir = path.join(root, 'tmpdir');
  fs.mkdirSync(tmpdir);
  const started = path.join(root, 'started');
  const suite = path.join(root, 'slow.test.js');
  fs.writeFileSync(suite, `const { test } = require('node:test');
test('slow', async () => {
  require('node:fs').writeFileSync(${JSON.stringify(started)}, 'x');
  await new Promise((r) => setTimeout(r, 1500));
});
`);
  const code = `const { runSuite } = require(${JSON.stringify(SMOKE)});
runSuite(${JSON.stringify(suite)}, 'postgres://unused.invalid/none', null, [], null, { timeoutMs: 20000 });
setTimeout(() => process.stdout.write('NOT STOPPED\\n'), 300);`;
  const child = track(spawn(process.execPath, ['-e', code], { cwd: root, env: noKeyEnv(root, { TMPDIR: tmpdir }), stdio: ['ignore', 'pipe', 'pipe'] }));
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  try {
    assert.ok(await until(() => fs.existsSync(started)), 'the suite never started');
    assert.strictEqual(fs.readdirSync(tmpdir).filter((n) => n.startsWith('drb-smoke-tap-')).length, 1, 'no temp witness while the suite runs');
    child.kill('SIGTERM');
    await exited(child);
    assert.deepStrictEqual(fs.readdirSync(tmpdir).filter((n) => n.startsWith('drb-smoke-tap-')), [], 'the temp witness outlived the signal');
    assert.deepStrictEqual({ code: child.exitCode, signal: child.signalCode }, { code: 143, signal: null }, 'the signal killed it before its cleanup could run');
    assert.doesNotMatch(out, /NOT STOPPED/);
  } finally {
    spawnSync('pkill', ['-9', '-f', root]);
  }
});
