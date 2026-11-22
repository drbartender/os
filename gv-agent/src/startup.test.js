// The startup refusals (review fixes 5 and 6) and the startup diag prune
// (review fix 8). Temp dirs only; never the real profile.
// Run: `node --test src/startup.test.js`.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// config.js (loaded through diag.js) resolves the profile dir once, at load.
// Point it at a throwaway dir first, so no test here can reach the real profile.
process.env.GV_PROFILE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-agent-profile-guard-'));
after(() => fs.rmSync(process.env.GV_PROFILE_DIR, { recursive: true, force: true }));
const { apiBaseProblem, profileDirProblem, prepareProfileDir } = require('./startup');

const tmpDir = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-agent-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const DAY_MS = 24 * 60 * 60 * 1000;

// A capture is a .png and a .json sharing one base name that starts with an ISO stamp.
function writeCaptures(diag, count) {
  const bases = [];
  for (let i = 0; i < count; i += 1) {
    const base = `2026-10-19T17-00-${String(i).padStart(2, '0')}-000Z-41-timeout`;
    for (const ext of ['.png', '.json']) fs.writeFileSync(path.join(diag, base + ext), 'x');
    bases.push(base);
  }
  return bases;
}
const capturesIn = (diag) => [...new Set(fs.readdirSync(diag)
  .filter((n) => /\.(png|json)$/.test(n)).map((n) => n.replace(/\.(png|json)$/, '')))].sort();

test('API_BASE_URL must be https, or plain http to this box only', () => {
  assert.equal(apiBaseProblem('https://api.drbartender.com'), null);
  assert.equal(apiBaseProblem('https://api.drbartender.com/'), null);
  assert.equal(apiBaseProblem('http://localhost:5000'), null);
  assert.equal(apiBaseProblem('http://LOCALHOST:5000'), null);
  assert.equal(apiBaseProblem('http://127.0.0.1:5000'), null);
  for (const bad of [
    'http://api.drbartender.com',
    'http://localhost.example.com:5000',
    'http://127.0.0.1.example.com',
    'http://10.0.0.5:5000',
    'ftp://localhost/x',
    'localhost:5000',
    'not a url',
    '',
  ]) {
    assert.match(String(apiBaseProblem(bad)), /^API_BASE_URL /, `refuses ${JSON.stringify(bad)}`);
  }
});

test('a profile dir open to group or other is refused, and nothing in it is touched', (t) => {
  const dir = tmpDir(t);
  const diag = path.join(dir, 'diag');
  fs.mkdirSync(diag);
  const old = writeCaptures(diag, 1);
  for (const ext of ['.png', '.json']) {
    fs.utimesSync(path.join(diag, old[0] + ext), new Date(Date.now() - 31 * DAY_MS), new Date(Date.now() - 31 * DAY_MS));
  }
  for (const mode of [0o755, 0o750, 0o711, 0o701, 0o770, 0o707]) {
    fs.chmodSync(dir, mode);
    assert.match(String(profileDirProblem(dir)), /must be 700/, mode.toString(8));
    assert.match(String(prepareProfileDir(dir)), /must be 700/, mode.toString(8));
  }
  assert.deepEqual(capturesIn(diag), old, 'a refused start prunes nothing');
  fs.chmodSync(dir, 0o700);
  assert.equal(profileDirProblem(dir), null);
  assert.equal(prepareProfileDir(dir), null);
});

test('a missing profile dir is created mode 700; a file in its place is refused', (t) => {
  const root = tmpDir(t);
  const dir = path.join(root, '.gvoice-profile');
  assert.equal(profileDirProblem(dir), null, 'missing is fine: startup creates it');
  assert.equal(prepareProfileDir(dir), null);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const file = path.join(root, 'not-a-dir');
  fs.writeFileSync(file, 'x');
  assert.match(String(prepareProfileDir(file)), /not a directory/);
});

test('startup prunes diag captures by age and count', (t) => {
  const dir = tmpDir(t);
  const diag = path.join(dir, 'diag');
  fs.mkdirSync(diag);
  const bases = writeCaptures(diag, 45);
  fs.writeFileSync(path.join(diag, 'notes.txt'), 'not a capture');
  const monthAgo = new Date(Date.now() - 31 * DAY_MS);
  for (const base of bases.slice(10, 13)) {
    for (const ext of ['.png', '.json']) fs.utimesSync(path.join(diag, base + ext), monthAgo, monthAgo);
  }
  assert.equal(prepareProfileDir(dir), null);
  // Three went by age; of the 42 left, the 2 oldest names went by count.
  const kept = bases.filter((b, i) => !(i >= 10 && i < 13)).slice(2);
  assert.equal(kept.length, 40);
  assert.deepEqual(capturesIn(diag), kept);
  assert.ok(fs.existsSync(path.join(diag, 'notes.txt')), 'nothing but captures is touched');
  // No diag dir yet is fine.
  const fresh = path.join(tmpDir(t), 'profile');
  assert.equal(prepareProfileDir(fresh), null);
});

test('startup refuses to run without the API secret, naming the variable and never a value', () => {
  const { secretProblem } = require('./startup');
  for (const secret of [undefined, null, '', '   ', 0, {}]) {
    assert.equal(secretProblem(secret), 'GV_AGENT_SECRET is not set (gv-agent/.env)', `secret=${String(secret)}`);
  }
  assert.equal(secretProblem('fixture-secret-value'), null);
});

// The single-instance lock: one agent per state dir. The liveness probe and
// the start-time reader are passed in, so no test depends on which pids exist
// on this machine.
const { lockVerdict, acquireLock, releaseLock, procStartTime, LOCK_FILE } = require('./startup');
const alive = (...pids) => (pid) => pids.includes(pid);
// Start times by pid; a pid not listed has no readable start (no /proc).
const starts = (map) => (pid) => (Object.hasOwn(map, pid) ? map[pid] : null);
const probe = (over = {}) => ({ ownPid: 100, isAlive: alive(), startOf: starts({}), ...over });

test('lockVerdict: no file takes, our own or a dead pid is stale, a reused pid is stale, the same process holds', () => {
  assert.equal(lockVerdict(null, probe()), 'take');
  // Our own pid: no other process can hold it.
  assert.equal(lockVerdict('100 555\n', probe({ isAlive: alive(100), startOf: starts({ 100: 555 }) })), 'stale');
  // A dead pid.
  assert.equal(lockVerdict('4242 777\n', probe()), 'stale');
  // A live pid started at another time: reused by another process after a reboot.
  assert.equal(lockVerdict('4242 777\n', probe({ isAlive: alive(4242), startOf: starts({ 4242: 91 }) })), 'stale');
  // A live pid started at the recorded time: the agent that wrote it.
  assert.equal(lockVerdict('4242 777\n', probe({ isAlive: alive(4242), startOf: starts({ 4242: 777 }) })), 'held');
  // A live pid whose start cannot be read is taken as held, the safe side.
  assert.equal(lockVerdict('4242 777\n', probe({ isAlive: alive(4242) })), 'held');
  // Anything but exactly two positive integers refuses rather than guess.
  for (const content of ['', '   ', 'abc', '4242', '4242\n', '0 777', '4242 0', '-5 777', '4242 777 9', '4242 7x7', '1.5 777', '4242  777']) {
    assert.equal(lockVerdict(content, probe({ isAlive: alive(4242) })), 'unreadable', `content=${JSON.stringify(content)}`);
  }
});

test('procStartTime reads the 22nd stat field, cutting after the last parenthesis', (t) => {
  const proc = tmpDir(t);
  const stat = (pid, comm, start) => {
    fs.mkdirSync(path.join(proc, String(pid)));
    // pid (comm) state, then fields 4 to 21, then the start time (field 22), then more.
    const rest = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 1)), String(start), '9', '9'];
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${comm}) ${rest.join(' ')}\n`);
  };
  stat(4242, 'node', 777);
  stat(4243, 'odd) (name x', 888);
  assert.equal(procStartTime(4242, proc), 777);
  assert.equal(procStartTime(4243, proc), 888, 'a comm holding spaces and parentheses');
  assert.equal(procStartTime(4244, proc), null, 'no such pid');
  assert.equal(procStartTime(process.pid) > 0 || procStartTime(process.pid) === null, true);
});

test('acquireLock takes a free lock, refuses the live holder, takes over a dead or reused one, and releases its own', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, LOCK_FILE);
  const as = (pid, livePids, startMap) => ({ pid, isAlive: alive(...livePids), startOf: starts(startMap) });
  // No file: taken, holding the pid and its start, mode 600.
  assert.deepEqual(acquireLock(dir, as(100, [100], { 100: 555 })), { ok: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '100 555\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // A second copy while the first lives: refused, with both remedies and no path.
  const refused = acquireLock(dir, as(200, [100, 200], { 100: 555, 200: 600 }));
  assert.equal(refused.ok, false);
  assert.match(refused.problem, /pid 100/);
  assert.match(refused.problem, /gv-agent\.lock/);
  assert.match(refused.problem, /systemctl --user stop gv-agent/);
  assert.match(refused.problem, /remove/);
  assert.equal(refused.problem.includes(dir), false, 'no directory path in the message');
  assert.equal(fs.readFileSync(file, 'utf8'), '100 555\n', 'the holder keeps it');
  // After a reboot pid 100 belongs to another process: taken over.
  assert.deepEqual(acquireLock(dir, as(200, [100, 200], { 100: 12, 200: 600 })), { ok: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '200 600\n');
  // The holder died: taken over.
  assert.deepEqual(acquireLock(dir, as(300, [300], { 300: 700 })), { ok: true });
  assert.equal(fs.readFileSync(file, 'utf8'), '300 700\n');
  // Release removes only this process's own pid AND start.
  releaseLock(dir, { pid: 200, startOf: starts({ 200: 600 }) });
  releaseLock(dir, { pid: 300, startOf: starts({ 300: 1 }) });
  assert.equal(fs.existsSync(file), true);
  releaseLock(dir, { pid: 300, startOf: starts({ 300: 700 }) });
  assert.equal(fs.existsSync(file), false);
  releaseLock(dir, { pid: 300, startOf: starts({ 300: 700 }) }); // nothing there: no throw
  // A file the agent never wrote refuses.
  fs.writeFileSync(file, '');
  const odd = acquireLock(dir, as(400, [400], { 400: 800 }));
  assert.equal(odd.ok, false);
  assert.match(odd.problem, /gv-agent\.lock/);
  // Without its own start time the agent cannot write a lock it could later prove.
  fs.rmSync(file);
  assert.equal(acquireLock(dir, as(400, [400], {})).ok, false);
});
