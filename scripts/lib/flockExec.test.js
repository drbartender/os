'use strict';

// node:test suite for scripts/lib/flockExec.js, the lock wrapper run-suites and
// testdb-smoke share. Every case runs a tiny fixture script in a temp dir with
// its own lock file. Temp dirs are removed and every process started here is
// killed when the file finishes.

const { test, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FLOCK_EXEC = path.resolve(__dirname, 'flockExec.js');

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

function track(child, { detachedGroup = false } = {}) {
  child.detachedGroup = detachedGroup;
  children.push(child);
  return child;
}

function exited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve({ code: child.exitCode, signal: child.signalCode });
    else child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The fixture: take the lock through underLock, optionally hold it, optionally
// run a nested fixture on the same lock, optionally leave a child holding the
// inherited lock fd, then write a marker with what it saw.
const FIXTURE = `'use strict';
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const { underLock } = require(${JSON.stringify(FLOCK_EXEC)});
(async () => {
  // FX_LOCKS: a test's stand-in for /proc/locks (underLock's locksPath).
  const lock = await underLock({ lockFile: process.env.FX_LOCK, guardVar: 'FX_LOCKED', waitLine: 'fixture: waiting for the lock', locksPath: process.env.FX_LOCKS || undefined });
  const start = Date.now();
  const hold = Number(process.env.FX_HOLD_MS || 0);
  if (hold) await new Promise((r) => setTimeout(r, hold));
  if (process.env.FX_NESTED === '1') {
    const nestedEnv = { ...process.env, FX_NESTED: '0', FX_HOLD_MS: '0', FX_MARKER: process.env.FX_MARKER + '.nested' };
    // FX_NESTED_LOCK: the nested run is on ANOTHER lock and sets the guard to
    // it by hand, keeping the guard pid it inherited from this run.
    if (process.env.FX_NESTED_LOCK) Object.assign(nestedEnv, { FX_LOCK: process.env.FX_NESTED_LOCK, FX_LOCKED: process.env.FX_NESTED_LOCK });
    const r = spawnSync(process.execPath, [__filename], { encoding: 'utf8', env: nestedEnv });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.status !== 0) process.exit(r.status);
  }
  if (process.env.FX_LEAVE_HOLDER === '1') {
    const c = spawn('sleep', ['2'], { detached: true, stdio: ['ignore', 'ignore', 'ignore', lock.lockFd] });
    c.unref();
  }
  fs.writeFileSync(process.env.FX_MARKER, JSON.stringify({ start, end: Date.now(), pid: process.pid, parentPid: lock.parentPid, lockFd: lock.lockFd }));
  process.exit(Number(process.env.FX_EXIT || 0));
})();
`;

function setup(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  const fixture = path.join(dir, 'fixture.js');
  fs.writeFileSync(fixture, FIXTURE);
  return { dir, fixture, lock: path.join(dir, 'fx.lock') };
}

// The fixture's environment: no guard inherited from this process, then the
// test's own extras (a guard among them, when the test forges one).
function fxEnv(dir, lock, marker, extra = {}) {
  const env = { ...process.env };
  delete env.FX_LOCKED;
  delete env.FX_LOCKED_PID;
  Object.assign(env, { FX_LOCK: lock, FX_MARKER: path.join(dir, marker) }, extra);
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
}

function startFixture(fixture, env) {
  const c = track(spawn(process.execPath, [fixture], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
  c.out = '';
  c.err = '';
  c.stdout.on('data', (d) => { c.out += d; });
  c.stderr.on('data', (d) => { c.err += d; });
  return c;
}

async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}

function holdLock(lock, secs = '30') {
  return track(spawn('flock', [lock, 'sleep', secs], { detached: true, stdio: 'ignore' }), { detachedGroup: true });
}

function lockIsFree(lock) {
  return spawnSync('flock', ['-n', lock, 'true']).status === 0;
}

function pgrepFinds(text) {
  return spawnSync('pgrep', ['-f', text]).status === 0;
}

test('(a) two runs on one lock serialize, and the second says it is waiting', async () => {
  const { dir, fixture, lock } = setup('fx-serial-');
  const first = startFixture(fixture, fxEnv(dir, lock, 'one.json', { FX_HOLD_MS: '1200' }));
  await until(() => !lockIsFree(lock));
  const second = startFixture(fixture, fxEnv(dir, lock, 'two.json'));
  const [r1, r2] = await Promise.all([exited(first), exited(second)]);
  assert.strictEqual(r1.code, 0, first.err);
  assert.strictEqual(r2.code, 0, second.err);
  const one = JSON.parse(fs.readFileSync(path.join(dir, 'one.json'), 'utf8'));
  const two = JSON.parse(fs.readFileSync(path.join(dir, 'two.json'), 'utf8'));
  assert.ok(two.start >= one.end, `the second started at ${two.start}, before the first ended at ${one.end}`);
  assert.strictEqual((second.err.match(/fixture: waiting for the lock/g) || []).length, 1, second.err);
  assert.doesNotMatch(first.err, /waiting/);
});

test('(b) SIGTERM to a waiting run kills its waiter: it never runs later and leaves no process', async () => {
  const { dir, fixture, lock } = setup('fx-sigterm-');
  const holder = holdLock(lock);
  await until(() => !lockIsFree(lock));
  const run = startFixture(fixture, fxEnv(dir, lock, 'marker.json'));
  assert.ok(await until(() => /waiting for the lock/.test(run.err)), run.err);
  process.kill(run.pid, 'SIGTERM');
  const r = await exited(run);
  assert.strictEqual(r.code, 1, run.err);
  assert.match(run.err, /SIGTERM/, 'the run names the signal that stopped it');
  process.kill(-holder.pid, 'SIGKILL');
  await exited(holder);
  await sleep(700);
  assert.ok(!fs.existsSync(path.join(dir, 'marker.json')), 'the waiter ran after its launcher was stopped');
  assert.ok(!pgrepFinds(lock), 'a process naming the lock file is still alive');
});

test('(c) a forged guard (a live pid that is not an ancestor) is ignored: the run waits, then proceeds', async () => {
  const { dir, fixture, lock } = setup('fx-forged-');
  const stranger = track(spawn('sleep', ['30'], { stdio: 'ignore' }));
  const holder = holdLock(lock);
  await until(() => !lockIsFree(lock));
  const run = startFixture(fixture, fxEnv(dir, lock, 'marker.json', { FX_LOCKED: lock, FX_LOCKED_PID: String(stranger.pid) }));
  await sleep(1500);
  assert.ok(!fs.existsSync(path.join(dir, 'marker.json')), 'a forged guard skipped the lock');
  process.kill(-holder.pid, 'SIGKILL');
  const r = await exited(run);
  assert.strictEqual(r.code, 0, run.err);
  assert.ok(fs.existsSync(path.join(dir, 'marker.json')));
  stranger.kill('SIGKILL');
  await exited(stranger);
});

test('(d) a guard whose pid is dead stops the run: exit 1, one line, nothing run', async () => {
  const { dir, fixture, lock } = setup('fx-dead-');
  const gone = spawn('true');
  await exited(gone);
  const r = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000, env: fxEnv(dir, lock, 'marker.json', { FX_LOCKED: lock, FX_LOCKED_PID: String(gone.pid) }) });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /is gone/);
  assert.strictEqual(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'marker.json')));
});

test('(d2) a run already inside flock whose guard pid is alive but not an ancestor (a reused pid) stops instead of waiting on itself', async () => {
  const { dir, fixture, lock } = setup('fx-reused-');
  const stranger = track(spawn('sleep', ['30'], { stdio: 'ignore' }));
  // As an orphaned inner would be: flock holds the lock and runs the fixture,
  // whose guard names this lock and a pid that is now some unrelated process.
  const r = spawnSync('flock', [lock, process.execPath, fixture], { encoding: 'utf8', timeout: 5000, env: fxEnv(dir, lock, 'marker.json', { FX_LOCKED: lock, FX_LOCKED_PID: String(stranger.pid) }) });
  if (r.error && r.error.code === 'ETIMEDOUT') spawnSync('pkill', ['-9', '-f', dir]); // the deadlocked pair outlives flock
  assert.ok(!(r.error && r.error.code === 'ETIMEDOUT'), 'the run waited on the lock its own parent holds');
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /is not the process that launched it/, 'a live reused pid is not "gone"');
  assert.doesNotMatch(r.stderr, /is gone/);
  assert.ok(!fs.existsSync(path.join(dir, 'marker.json')));
  stranger.kill('SIGKILL');
  await exited(stranger);
});

test('(e) a run nested inside the holder on the same lock is re-entrant', () => {
  const { dir, fixture, lock } = setup('fx-nested-');
  const r = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000, env: fxEnv(dir, lock, 'marker.json', { FX_NESTED: '1' }) });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /waiting/);
  const outer = JSON.parse(fs.readFileSync(path.join(dir, 'marker.json'), 'utf8'));
  const nested = JSON.parse(fs.readFileSync(path.join(dir, 'marker.json.nested'), 'utf8'));
  assert.strictEqual(nested.parentPid, outer.parentPid, 'the nested run watches the same launching process');
});

test('(e2) a guard set by hand to another lock, with an inherited ancestor pid that holds a different lock, is ignored', async () => {
  const { dir, fixture, lock } = setup('fx-crosslock-');
  const other = path.join(dir, 'other.lock');
  const holder = holdLock(other, '1.5');
  await until(() => !lockIsFree(other));
  const r = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000, env: fxEnv(dir, lock, 'marker.json', { FX_NESTED: '1', FX_NESTED_LOCK: other }) });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /fixture: waiting for the lock/, 'the nested run skipped a lock no ancestor holds');
  assert.ok(fs.existsSync(path.join(dir, 'marker.json.nested')));
  await exited(holder);
});

test('(f) the inner gets its inherited lock fd, and a child given that fd keeps the lock after the inner exits', async () => {
  const { dir, fixture, lock } = setup('fx-fd-');
  const r = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000, env: fxEnv(dir, lock, 'marker.json', { FX_LEAVE_HOLDER: '1' }) });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(dir, 'marker.json'), 'utf8'));
  assert.strictEqual(typeof m.lockFd, 'number');
  assert.ok(!lockIsFree(lock), 'the child given the fd should still hold the lock');
  assert.ok(await until(() => lockIsFree(lock), 5000), 'the lock should free once that child exits');
});

test('the run exits with the locked run\'s status', () => {
  const { dir, fixture, lock } = setup('fx-status-');
  const r = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000, env: fxEnv(dir, lock, 'marker.json', { FX_EXIT: '3' }) });
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
});

test('flock missing fails closed: exit 1, one line, nothing run', () => {
  const { dir, fixture, lock } = setup('fx-noflock-');
  const r = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 10000, env: fxEnv(dir, lock, 'marker.json', { PATH: dir }) });
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /flock/);
  assert.strictEqual(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.ok(!fs.existsSync(path.join(dir, 'marker.json')));
});

test('parentGone: false for a live ancestor; true for a live pid that is not an ancestor, a dead one and a zombie', async () => {
  const { parentGone } = require(FLOCK_EXEC);
  assert.strictEqual(parentGone(process.ppid), false, 'the process that started this one is a live ancestor');
  const stranger = track(spawn('sleep', ['30'], { stdio: 'ignore' }));
  assert.strictEqual(parentGone(stranger.pid), true, 'a live pid that is not an ancestor (a reused launcher pid) is not the launcher');
  stranger.kill('SIGKILL');
  await exited(stranger);
  const gone = spawn('true');
  await exited(gone);
  assert.strictEqual(parentGone(gone.pid), true);
  // A zombie: the background sleep exits while its parent (exec'd into sleep 3) never reaps it.
  const sh = track(spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 3'], { stdio: ['ignore', 'pipe', 'ignore'] }));
  let out = '';
  sh.stdout.on('data', (d) => { out += d; });
  assert.ok(await until(() => /\d+\n/.test(out)));
  const zpid = Number(out.trim());
  assert.ok(await until(() => {
    try {
      return /\) Z /.test(fs.readFileSync(`/proc/${zpid}/stat`, 'utf8'));
    } catch {
      return false;
    }
  }), 'the fixture zombie never appeared');
  assert.strictEqual(parentGone(zpid), true, 'a zombie is a dead launcher');
  sh.kill('SIGKILL');
  await exited(sh);
});

test('boundedNodeSync: GNU timeout, the exit status passed through, the lock fd as fd 3, and a timeout read as one', () => {
  const { gnuTimeout, boundedNodeSync } = require(FLOCK_EXEC);
  const bin = gnuTimeout();
  assert.ok(bin, 'no GNU coreutils timeout on this box');
  assert.match(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout, /GNU coreutils/);
  const { dir, lock } = setup('fx-bounded-');
  const status = boundedNodeSync(['-e', 'process.exit(3)'], { timeoutMs: 10000, cwd: dir, env: process.env, stdio: 'ignore' });
  assert.deepStrictEqual(status, { status: 3, signal: null, error: null, timedOut: false });
  const out = path.join(dir, 'fd3.txt');
  const lockFd = fs.openSync(lock, 'w');
  try {
    const r = boundedNodeSync(['-e', "require('fs').writeFileSync(process.argv[1], require('fs').readlinkSync('/proc/self/fd/3'))", out], { timeoutMs: 10000, cwd: dir, env: process.env, stdio: 'ignore', lockFd });
    assert.strictEqual(r.status, 0);
  } finally {
    fs.closeSync(lockFd);
  }
  assert.strictEqual(fs.readFileSync(out, 'utf8'), fs.realpathSync(lock));
  const start = Date.now();
  const hung = boundedNodeSync(['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 1000, cwd: dir, env: process.env, stdio: 'ignore' });
  assert.strictEqual(hung.timedOut, true, JSON.stringify(hung));
  assert.ok(Date.now() - start < 5000);
});

test('(b2) a signal that lands before the locked run is spawned exits 1 naming it, and nothing is spawned', async () => {
  const { dir, fixture, lock } = setup('fx-early-');
  // A flock that makes the probe (flock -n) take a second, after saying so.
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const probing = path.join(dir, 'probing');
  fs.writeFileSync(path.join(bin, 'flock'), `#!/bin/sh\nif [ "$1" = "-n" ]; then : > ${JSON.stringify(probing)}; sleep 1; fi\nexec /usr/bin/flock "$@"\n`, { mode: 0o755 });
  const run = startFixture(fixture, fxEnv(dir, lock, 'marker.json', { PATH: `${bin}:${process.env.PATH}` }));
  assert.ok(await until(() => fs.existsSync(probing)), run.err);
  process.kill(run.pid, 'SIGTERM');
  const r = await exited(run);
  assert.deepStrictEqual(r, { code: 1, signal: null }, `the run died by the signal instead of handling it: ${run.err}`);
  assert.match(run.err, /SIGTERM/);
  assert.strictEqual(run.err.trim().split('\n').length, 1, run.err);
  await sleep(1500);
  assert.ok(!fs.existsSync(path.join(dir, 'marker.json')), 'the locked run was spawned after the signal');
  assert.ok(!pgrepFinds(lock), 'a process naming the lock file is alive');
});

// ---- The guard is trusted only when an ancestor holds the flock itself ----

// A forger: opens the lock file WITHOUT flock, sets the guard to that file and
// its own pid, and runs the fixture under it; FORGE_PASS_FD=1 also hands the
// open descriptor down as fd 3, so the fixture holds one itself.
const FORGER = (fixture) => `'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
const fd = fs.openSync(process.env.FX_LOCK, 'a');
const env = { ...process.env, FX_LOCKED: process.env.FX_LOCK, FX_LOCKED_PID: String(process.pid) };
const pass = process.env.FORGE_PASS_FD === '1';
const c = spawn(process.execPath, [${JSON.stringify(fixture)}], { env, stdio: ['ignore', 'inherit', 'inherit', ...(pass ? [fd] : [])] });
c.on('exit', (code) => process.exit(code === null ? 1 : code));
`;

test('(c2) a guard whose ancestor merely has the lock file open (no flock) is forged: the run waits for the real holder, then proceeds', async () => {
  const { dir, fixture, lock } = setup('fx-openonly-');
  const forger = path.join(dir, 'forger.js');
  fs.writeFileSync(forger, FORGER(fixture));
  const holder = holdLock(lock);
  await until(() => !lockIsFree(lock));
  const run = startFixture(forger, fxEnv(dir, lock, 'marker.json'));
  assert.ok(await until(() => /waiting for the lock/.test(run.err), 3000), `the run trusted a guard no flock backs: ${run.err}`);
  await sleep(500);
  assert.ok(!fs.existsSync(path.join(dir, 'marker.json')), 'the run went ahead while the real holder held the lock');
  process.kill(-holder.pid, 'SIGKILL');
  const r = await exited(run);
  assert.strictEqual(r.code, 0, run.err);
  assert.ok(fs.existsSync(path.join(dir, 'marker.json')));
});

test('(c3) the same forgery with the open descriptor handed down never runs while the real holder holds the lock', async () => {
  const { dir, fixture, lock } = setup('fx-openfd-');
  const forger = path.join(dir, 'forger.js');
  fs.writeFileSync(forger, FORGER(fixture));
  const holder = holdLock(lock);
  await until(() => !lockIsFree(lock));
  const run = startFixture(forger, fxEnv(dir, lock, 'marker.json', { FORGE_PASS_FD: '1' }));
  const r = await Promise.race([exited(run), sleep(2500).then(() => null)]);
  assert.ok(!fs.existsSync(path.join(dir, 'marker.json')), 'the run went ahead on a descriptor no flock backs');
  if (r !== null) {
    assert.strictEqual(r.code, 1, run.err);
    assert.strictEqual(run.err.trim().split('\n').length, 1, run.err);
  }
  process.kill(-holder.pid, 'SIGKILL');
  await exited(holder);
});

// A forger that runs under flock(1) on ANOTHER file, so it really holds an
// exclusive flock (fd 3), only not on the lock file. FORGE_OPEN=1 also opens
// the lock file without flock, so it holds the lock path open. It writes the
// stand-in /proc/locks: one FLOCK WRITE row naming itself on the lock file's
// inode but another device, which is what the kernel prints when a file on
// another filesystem shares the lock file's inode number (a tmpfs lock file
// and an ext4 directory, say). Then it sets the guard to the lock file and
// its own pid and runs the fixture.
const SAME_INODE_FORGER = (fixture) => `'use strict';
const fs = require('fs');
const { spawn } = require('child_process');
if (process.env.FORGE_OPEN === '1') fs.openSync(process.env.FX_LOCK, 'r');
const st = fs.statSync(process.env.FX_LOCK);
const major = (st.dev >> 8) & 0xfff;
const minor = (st.dev & 0xff) | ((st.dev >> 12) & 0xfff00);
const hex = (n) => n.toString(16).padStart(2, '0');
fs.writeFileSync(process.env.FX_LOCKS, '1: FLOCK  ADVISORY  WRITE ' + process.pid + ' ' + hex(major + 1) + ':' + hex(minor) + ':' + st.ino + ' 0 EOF\\n');
const env = { ...process.env, FX_LOCKED: process.env.FX_LOCK, FX_LOCKED_PID: String(process.pid) };
const c = spawn(process.execPath, [${JSON.stringify(fixture)}], { env, stdio: ['ignore', 'inherit', 'inherit'] });
c.on('exit', (code) => process.exit(code === null ? 1 : code));
`;

for (const open of ['0', '1']) {
  test(`(c4) an ancestor that holds a flock on a same-inode file on another device${open === '1' ? ' and has the lock path open' : ''} is no proof: the run waits or stops, never proceeds`, async () => {
    const { dir, fixture, lock } = setup('fx-sameino-');
    const forger = path.join(dir, 'forger.js');
    fs.writeFileSync(forger, SAME_INODE_FORGER(fixture));
    const holder = holdLock(lock);
    await until(() => !lockIsFree(lock));
    const env = fxEnv(dir, lock, 'marker.json', { FX_LOCKS: path.join(dir, 'locks'), FORGE_OPEN: open });
    const run = track(spawn('flock', [path.join(dir, 'other.lock'), process.execPath, forger], { env, stdio: ['ignore', 'pipe', 'pipe'] }));
    run.err = '';
    run.stderr.on('data', (d) => { run.err += d; });
    const r = await Promise.race([exited(run), sleep(2500).then(() => null)]);
    assert.ok(!fs.existsSync(path.join(dir, 'marker.json')), `the run went ahead on a flock that is not on the lock file: ${run.err}`);
    if (r !== null) {
      assert.strictEqual(r.code, 1, run.err);
      assert.strictEqual(run.err.trim().split('\n').length, 1, run.err);
    }
    process.kill(-holder.pid, 'SIGKILL');
    await exited(holder);
  });
}

test('flockHolders: the pids holding an exclusive FLOCK on the file, by inode, waiters and other locks excluded; null when unreadable', () => {
  const { flockHolders } = require(FLOCK_EXEC);
  const { dir, lock } = setup('fx-holders-');
  fs.writeFileSync(lock, '');
  const ino = fs.statSync(lock).ino;
  const other = ino + 1;
  const locks = path.join(dir, 'locks');
  fs.writeFileSync(locks, [
    `1: FLOCK  ADVISORY  WRITE 4242 00:2c:${ino} 0 EOF`,
    `1: -> FLOCK  ADVISORY  WRITE 4343 00:2c:${ino} 0 EOF`,
    `2: POSIX  ADVISORY  WRITE 4444 00:2c:${ino} 0 EOF`,
    `3: FLOCK  ADVISORY  READ 4545 00:2c:${ino} 0 EOF`,
    `4: FLOCK  ADVISORY  WRITE 4646 00:2c:${other} 0 EOF`,
    `5: OFDLCK ADVISORY  WRITE -1 00:2c:${ino} 0 EOF`,
    '',
  ].join('\n'));
  assert.deepStrictEqual([...flockHolders(lock, locks)], [4242]);
  assert.strictEqual(flockHolders(lock, path.join(dir, 'no-such-file')), null);
  assert.deepStrictEqual([...flockHolders(path.join(dir, 'no-such.lock'), locks)], [], 'no lock file, no holder');
  const live = holdLock(lock, '2');
  assert.ok(spawnSync('sleep', ['0.3']).status === 0);
  assert.ok(flockHolders(lock).has(live.pid), 'the real /proc/locks names flock(1) as the holder');
});

test('(d3) a run inside flock whose guard pid is 1, 0, empty, not a number or missing stops instead of waiting on its own lock', () => {
  const { dir, fixture, lock } = setup('fx-badpid-');
  for (const bad of ['1', '0', '', 'abc', undefined]) {
    const r = spawnSync('flock', [lock, process.execPath, fixture], { encoding: 'utf8', timeout: 5000, env: fxEnv(dir, lock, 'marker.json', { FX_LOCKED: lock, FX_LOCKED_PID: bad }) });
    const hung = Boolean(r.error && r.error.code === 'ETIMEDOUT');
    if (hung) spawnSync('pkill', ['-9', '-f', dir]); // the deadlocked pair outlives flock
    assert.ok(!hung, `guard pid ${JSON.stringify(bad)}: the run waited on the lock its own parent holds`);
    assert.strictEqual(r.status, 1, `guard pid ${JSON.stringify(bad)}: ${r.stdout}${r.stderr}`);
    assert.strictEqual(r.stderr.trim().split('\n').length, 1, r.stderr);
    assert.ok(!fs.existsSync(path.join(dir, 'marker.json')));
  }
});
