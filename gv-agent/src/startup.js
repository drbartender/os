// What the agent checks before it runs at all (spec law 11 and the security
// review): it never talks to the os API over plain http off this box, and it
// never runs on a profile dir anyone but its owner can open. The profile is a
// credential for the owner's whole Google account, and it never runs without
// the API secret. Each check returns null, or a sentence saying why the agent
// must not start. It also holds the single-instance lock (one agent per state
// dir).
const fs = require('fs');
const path = require('path');
const { pruneDiag } = require('./diag');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

// https anywhere; plain http only to this box, since the secret header would
// otherwise cross the network in the clear.
function apiBaseProblem(apiBase) {
  let url;
  try {
    url = new URL(String(apiBase));
  } catch {
    return 'API_BASE_URL is not a URL';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)) return null;
  return `API_BASE_URL must be https (plain http only to localhost or 127.0.0.1), not ${url.protocol}//${url.hostname}`;
}

// A missing dir is fine (startup creates it 700). One that exists must carry
// no group or other permission bit at all.
function profileDirProblem(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch (err) {
    return err.code === 'ENOENT' ? null : `the GV profile dir cannot be read (${err.code})`;
  }
  if (!st.isDirectory()) return `the GV profile path ${dir} is not a directory`;
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return `the GV profile dir ${dir} is mode ${mode.toString(8)}; it holds a Google session and must be 700 (chmod 700 ${dir})`;
  }
  return null;
}

// Check the profile dir, create it 700 when missing, then prune the diag
// captures (the same prune as on every capture). Returns null, or why the
// agent must not start; a refused dir is left exactly as it was.
function prepareProfileDir(dir) {
  const before = profileDirProblem(dir);
  if (before) return before;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const after = profileDirProblem(dir);
  if (after) return after;
  pruneDiag(path.join(dir, 'diag'));
  return null;
}

// The secret has no default anywhere: unset or empty refuses to start. The
// sentence names the variable, never a value.
function secretProblem(secret) {
  return typeof secret === 'string' && secret.trim() !== '' ? null : 'GV_AGENT_SECRET is not set (gv-agent/.env)';
}

// -- One agent per state dir ---------------------------------------------------
//
// A second process (the unit, plus npm start by hand) would reconcile the
// first's in-flight marker against a journal it loaded at its own start, report
// failed_preclick and clear the marker, and the server would send the toll-free
// text beside the first one's post. So the agent holds gv-agent.lock, in the
// dir the journal and the marker live in, for as long as it runs.
const LOCK_FILE = 'gv-agent.lock';
const LOCK_MODE = 0o600;

// Does a process with this pid exist? EPERM means it exists under another user.
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// A process's start time, in clock ticks since boot: the 22nd field of
// /proc/<pid>/stat. The comm field (the 2nd) can hold spaces and parentheses,
// so the fields are split after the LAST ")". null when it cannot be read.
function procStartTime(pid, procDir = '/proc') {
  let stat;
  try {
    stat = fs.readFileSync(path.join(procDir, String(pid), 'stat'), 'utf8');
  } catch {
    return null; // static-checks: allow swallowed-catch, no such pid or no /proc: unknown, which the verdict handles
  }
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  // After the comm come field 3 (state) onward, so field 22 is index 19.
  const field = stat.slice(close + 1).trim().split(/\s+/)[19];
  return /^[1-9][0-9]*$/.test(field || '') ? Number(field) : null;
}

const LOCK_RE = /^([1-9][0-9]*) ([1-9][0-9]*)$/;
const lockLine = (pid, start) => `${pid} ${start}\n`;

// The lock file's content, `<pid> <start>`, decides, through a liveness probe
// and a start-time reader passed in: 'take' (no file); 'stale' (our own pid,
// which no other process can hold; a dead pid; or a live pid started at
// another time, a pid reused after a reboot); 'held' (a live pid started at
// the recorded time, or one whose start cannot be read, the safe side); or
// 'unreadable'. The agent writes the file whole or not at all (a temp file
// linked into place), so content that is not exactly two positive integers is
// not a crash leftover of ours: it refuses rather than guess.
function lockVerdict(content, { ownPid, isAlive, startOf }) {
  if (content == null) return 'take';
  const m = LOCK_RE.exec(String(content).replace(/\n$/, ''));
  if (!m) return 'unreadable';
  const pid = Number(m[1]);
  if (pid === ownPid) return 'stale';
  if (!isAlive(pid)) return 'stale';
  const now = startOf(pid);
  if (now == null) return 'held';
  return now === Number(m[2]) ? 'held' : 'stale';
}

function readLock(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// Create the lock exclusively: write the line to a temp file, then link it into
// place, which fails if the lock exists. Returns true when this call made it.
function linkLock(file, pid, line) {
  const tmp = `${file}.${pid}.tmp`;
  fs.writeFileSync(tmp, line, { mode: LOCK_MODE, flush: true });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Take the lock in dir. Returns { ok: true } or { ok: false, problem }, the
// problem naming the file and never a path. A stale lock is taken over once,
// then read back: a racing taker that won keeps it, and this one refuses.
function acquireLock(dir, { pid = process.pid, isAlive = pidAlive, startOf = procStartTime } = {}) {
  const file = path.join(dir, LOCK_FILE);
  const start = startOf(pid);
  // Without our own start time the lock could never be told from a reused pid.
  if (start == null) return { ok: false, problem: `cannot read this process's start time for ${LOCK_FILE} (no /proc)` };
  const line = lockLine(pid, start);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (linkLock(file, pid, line)) {
      if (readLock(file) === line) return { ok: true };
      break;
    }
    const content = readLock(file);
    const verdict = lockVerdict(content, { ownPid: pid, isAlive, startOf });
    if (verdict === 'held') {
      const holder = String(content).trim().split(' ')[0];
      return {
        ok: false,
        problem: `another gv-agent (pid ${holder}) holds ${LOCK_FILE}. Stop it with systemctl --user stop gv-agent, `
          + `or, if no gv-agent runs under pid ${holder}, remove ${LOCK_FILE} from the profile dir`,
      };
    }
    if (verdict === 'unreadable') {
      return { ok: false, problem: `${LOCK_FILE} in the profile dir holds no pid; remove it once no gv-agent runs` };
    }
    if (verdict === 'stale') fs.rmSync(file, { force: true });
  }
  return { ok: false, problem: `${LOCK_FILE} was taken by another gv-agent starting at the same moment` };
}

// Best effort, on a clean stop: remove the lock only while it holds this
// process's own pid and start time.
function releaseLock(dir, { pid = process.pid, startOf = procStartTime } = {}) {
  const file = path.join(dir, LOCK_FILE);
  try {
    const start = startOf(pid);
    if (start != null && readLock(file) === lockLine(pid, start)) fs.rmSync(file, { force: true });
  } catch { /* static-checks: allow swallowed-catch, exiting anyway; a lock left behind is taken over as stale */ }
}

module.exports = {
  apiBaseProblem, profileDirProblem, prepareProfileDir, secretProblem,
  lockVerdict, acquireLock, releaseLock, pidAlive, procStartTime, LOCK_FILE,
};
