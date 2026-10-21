'use strict';

/*
 * flockExec.js: run the calling script under an exclusive flock(1), shared by
 * scripts/run-suites.js (the dev-suite lock) and scripts/testdb-smoke.js (the
 * smoke lock). Instruction rewrite step 2, lane suite-runner.
 *
 *   const { parentPid, lockFd, session } = await underLock({ lockFile, guardVar, waitLine, notice, prepare });
 *
 * `prepare` (optional) is the run's one-time setup that must happen before
 * any wait (claiming a run dir): the outer runs it before the probe, and a
 * run nested inside a holder runs it itself; the re-exec under flock never
 * does, and neither does a run that stops, so a waiter orphaned by a kill -9
 * of its launcher touches nothing when it finally gets the lock. The runners
 * run their claim themselves first thing and call underLock first, with the
 * claim as `prepare`, only when looksLikeReexec(guardVar) says this process
 * sits where the re-exec does (its parent is flock(1)): the re-exec proves
 * its guard before it touches anything, and a process that only looks like
 * it becomes the outer and claims then.
 *
 * In the locked run, exitOnStopSignals() turns SIGTERM, SIGINT and SIGHUP
 * into an exit (128 plus the signal's number) so exit cleanups run,
 * yieldToSignals() lets a pending one be handled between steps, and
 * sweepSession(session) kills what a finished suite left in the run's own
 * session (see boundedNodeSync below).
 *
 * OUTER (the process a person or a script started): prints `notice` when one
 * is given, probes the lock and prints `waitLine` once when it is held, then
 * re-runs the same script under `flock <lockFile>` in a session of its own,
 * with guardVar=<lockFile> and guardVar_PID=<its own pid> in the environment.
 * Its SIGTERM, SIGINT and SIGHUP handlers go in before the probe: a signal
 * that lands before the spawn stops the outer (one line, exit 1, nothing
 * spawned), and one after it is forwarded to flock's group and then to every
 * other group in that session (each suite's GNU timeout leads one), so
 * stopping the outer also stops a waiter that has not yet got the lock and a
 * suite that is running (not a child that left the session), and it exits with
 * the locked run's status (1 and a line naming the signal when the locked run
 * died by one). Its promise never resolves. flock missing or failing to start
 * fails closed: one line, exit 1, nothing runs unlocked.
 *
 * INNER (the re-run under flock): guardVar equals this lock file AND
 * guardVar_PID names a live process that is an ancestor of this one (walking
 * the ppid field of /proc/<pid>/stat) AND the flock is proved on a
 * descriptor. The re-exec holds flock's descriptor itself, and its own
 * /proc/self/fdinfo/<fd> carries a `lock:` line for a FLOCK ADVISORY WRITE:
 * the kernel lists there only the locks that open file description owns, so
 * a descriptor without that line is not the lock. A run nested inside the
 * holder holds no such descriptor (Node hands its children none), so for it
 * a /proc/locks row on the lock file's inode must name this process or an
 * ancestor, and that holder must hold a descriptor that is the lock file (its
 * link is the lock file's real path, stat through it gives the lock file's
 * device and inode) whose fdinfo carries the lock on the device the row
 * names. A row is an inode NUMBER on some device: a file on another
 * filesystem can share it (a tmpfs lock file and an ext4 directory, seen
 * 2026-10-20), and st_dev is no check on the device (btrfs and overlayfs
 * report one that /proc/locks does not print), so the descriptor carries the
 * proof and the row only names who to look at. An ancestor that merely has
 * the file open holds nothing. When /proc/locks cannot be read the run stops
 * (one line, exit 1) rather than risk waiting on a lock it might hold. It
 * resolves to { parentPid, lockFd, session }: session is the run's own
 * session id in the re-exec (null in a nested run), and lockFd the inherited
 * descriptor holding the lock (null in a run nested inside the holder). Node
 * does not pass inherited descriptors on to its own children, so a caller
 * hands lockFd to every child that must keep the lock (spawnSync stdio [in,
 * out, err, lockFd]): a kill -9 of the inner then leaves the lock held until
 * that child ends, instead of freeing it while the child still runs unlocked.
 *
 * The guard is trusted only when its pid is an ancestor and that proof holds:
 * a guard whose pid is dead (the launcher was killed, kill -9 included, while
 * flock waited) prints one line and exits 1 without running; a guard whose
 * pid is alive but not an ancestor, or with no proof (a guard set by hand to
 * one lock beside a pid inherited from a run on another, an ancestor that
 * opened the file without flock), was forged or inherited, so it is ignored
 * and this process takes the lock as an outer. A zombie counts as dead. A
 * run that a row puts the lock above by inode number alone, or that holds a
 * descriptor on the lock file itself, while its guard is not trusted stops
 * too (an orphaned inner whose launcher's pid was reused, an ancestor holding
 * a same-inode file elsewhere), rather than try to take the lock again under
 * what may be its own holder and wait forever.
 *
 * parentGone(parentPid) is the inner's check between steps (run-suites before
 * each suite; testdb-smoke before the Neon reset, before initDb and before each
 * suite): true when the launcher is gone (dead, a zombie, or no longer an
 * ancestor of this run, its pid reused), and the caller then prints one line
 * and exits 1, which releases the lock. A spawnSync blocks the event loop, so
 * no timer can notice mid-suite; the check between steps plus the per-suite
 * bound limit an orphaned run's extra work to one suite.
 *
 * boundedNodeSync(argv, opts) is how both runners start a suite (and the
 * smoke's initDb): under GNU coreutils timeout --signal=KILL --kill-after=5,
 * with the lock fd as fd 3, so a hung suite and every process in its process
 * group (timeout's) die at the bound even when the run above it was killed
 * -9. gnuTimeout() names the binary, or null when there is no GNU timeout,
 * and the runners then refuse to run (one line, exit 1). A child that leaves
 * that group escapes the bound. sweepSession(session) is the runners' check
 * after each suite: one that stayed in the run's session (setpgid, a shell
 * job) is killed then, before the next suite. One that left the session too
 * (setsid, Node's detached) survives the bound, the sweep and a signal to
 * the runner, holds no lock and runs unlocked: a stated limit. A kill -9 of
 * the locked run skips the sweep, so a group-leaver then survives as well.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const FORWARDED = ['SIGTERM', 'SIGINT', 'SIGHUP'];

function who() {
  return path.basename(process.argv[1] || 'node', '.js');
}

// { comm, state, ppid, pgrp, session } from /proc/<pid>/stat, or null when
// there is no such process. The command name sits in parentheses and may
// hold spaces, so fields are read after the last ')'.
function procStat(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    return { comm: raw.slice(raw.indexOf('(') + 1, raw.lastIndexOf(')')), state: rest[0], ppid: Number(rest[1]), pgrp: Number(rest[2]), session: Number(rest[3]) };
  } catch {
    return null;
  }
}

// Every process group in session `sid`, from /proc. The outer starts flock in
// a session of its own (detached), so this is everything the run started that
// stayed in it, including the group each GNU timeout leads.
function sessionGroups(sid) {
  const groups = new Set();
  let names;
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return groups;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const st = procStat(name);
    if (st && st.session === sid && st.pgrp > 1) groups.add(st.pgrp);
  }
  return groups;
}

// Sends `sig` to the flock group first (so the locked run can start nothing
// new), then to every other group in its session: a suite under GNU timeout
// sits in timeout's own group, and timeout passes the signal on to that whole
// group and sends KILL 5 s later to whatever ignored it.
function signalRun(sid, sig) {
  try {
    process.kill(-sid, sig);
  } catch {
    /* the flock group is already gone */
  }
  for (const pgrp of sessionGroups(sid)) {
    if (pgrp === sid) continue;
    try {
      process.kill(-pgrp, sig);
    } catch {
      /* gone meanwhile */
    }
  }
}

// GNU coreutils timeout, the one that kills its whole process group at the
// bound: `gnutimeout` (this box: /usr/bin/timeout is uutils 0.8.0, which kills
// only its direct child, so a suite's own children outlive the bound), else
// `timeout`, each accepted only when its --version says GNU coreutils. Null
// when neither is GNU's. Resolved once per process.
let gnuTimeoutBin;
function gnuTimeout() {
  if (gnuTimeoutBin !== undefined) return gnuTimeoutBin;
  gnuTimeoutBin = null;
  for (const bin of ['gnutimeout', 'timeout']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (!r.error && r.status === 0 && /GNU coreutils/.test(r.stdout || '')) {
      gnuTimeoutBin = bin;
      break;
    }
  }
  return gnuTimeoutBin;
}

const KILL_AFTER_S = 5;
const BACKSTOP_MS = 30_000;

// Runs `node <argv>` as `<GNU timeout> --signal=KILL --kill-after=5 <secs>
// node <argv>`, blocking, with `stdio` (three entries or one string) plus the
// lock's descriptor as fd 3 when lockFd is given. timeout leads a process
// group of its own and outlives the caller, so at the bound it KILLs the
// command and everything the command started in that group, even after a
// kill -9 of the caller; a signal timeout receives goes to the whole group,
// then KILL 5 s later. The spawnSync timeout is a second backstop only, 30 s
// past the bound, so it never fires before timeout has killed the group.
// Returns { status, signal, error, timedOut }. Throws when no GNU timeout is
// found: nothing runs unbounded.
function boundedNodeSync(argv, { timeoutMs, cwd, env, stdio, lockFd = null }) {
  const bin = gnuTimeout();
  if (!bin) throw new Error(NO_GNU_TIMEOUT);
  const base = Array.isArray(stdio) ? stdio : [stdio, stdio, stdio];
  const start = Date.now();
  const r = spawnSync(bin, ['--signal=KILL', `--kill-after=${KILL_AFTER_S}`, String(timeoutMs / 1000), process.execPath, ...argv], {
    cwd,
    env,
    stdio: [...base, ...(lockFd === null || lockFd === undefined ? [] : [lockFd])],
    timeout: timeoutMs + BACKSTOP_MS,
    killSignal: 'SIGKILL',
  });
  const backstop = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  // timeout KILLs its own group, itself included, so a timed-out run reads as
  // timeout killed by SIGKILL at or past the bound (124 is its exit for a
  // catchable signal, never sent here).
  const timedOut = backstop || r.status === 124 || (r.signal === 'SIGKILL' && Date.now() - start >= timeoutMs);
  return { status: r.status, signal: r.signal, error: backstop ? null : r.error || null, timedOut };
}

const NO_GNU_TIMEOUT = 'GNU coreutils timeout (gnutimeout or timeout) is required to bound each suite and its process group; nothing runs unbounded.';

// True when `pid` is gone: kill(pid, 0) says ESRCH, or it is a zombie (dead,
// not yet reaped). EPERM means it exists under another user: not gone.
function pidGone(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return true;
  }
  const st = procStat(pid);
  return Boolean(st && st.state === 'Z');
}

// The inner's check between steps: true when its launcher is no longer there,
// dead, a zombie, or alive but no longer an ancestor of this process (it died
// and its pid now belongs to some unrelated process).
function parentGone(pid) {
  return pidGone(pid) || !isAncestor(pid);
}

function isAncestor(pid) {
  let cur = process.ppid;
  for (let hops = 0; cur > 1 && hops < 4096; hops++) {
    if (cur === pid) return true;
    const st = procStat(cur);
    if (!st) return false;
    cur = st.ppid;
  }
  return false;
}

// The first descriptor (above stdio) that process `pid` ('self' for this one)
// holds open on the file at `target` (a real path), or null.
function fdOn(pid, target) {
  let fds;
  try {
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return null;
  }
  for (const name of fds) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    try {
      if (fs.readlinkSync(`/proc/${pid}/fd/${name}`) === target) return fd;
    } catch {
      /* closed meanwhile (the directory listing's own descriptor) */
    }
  }
  return null;
}

function realLockPath(lockFile) {
  try {
    return fs.realpathSync(lockFile);
  } catch {
    return null;
  }
}

// A lock row's device as "major:minor" in decimal; /proc/locks and fdinfo
// print each half in hex.
function devKey(major, minor) {
  return `${parseInt(major, 16)}:${parseInt(minor, 16)}`;
}

const LOCK_ROW = /^\d+:\s+(->\s+)?FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/;
const FDINFO_LOCK = /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/m;

// The exclusive FLOCK rows of /proc/locks (or locksPath, a test's stand-in)
// on lockFile's inode number, as [{ pid, dev }], waiters (the "->" lines)
// left out. The pid is the process that took the lock (flock(1) itself, the
// parent of the run it starts). A row names an inode NUMBER on some device,
// and a file on another filesystem can share that number, so a row alone
// proves nothing about this lock file (lockProof). [] when the lock file
// does not exist; null when the file cannot be read.
function flockRows(lockFile, locksPath = '/proc/locks') {
  let ino;
  try {
    ino = fs.statSync(lockFile, { bigint: true }).ino.toString();
  } catch {
    return [];
  }
  let raw;
  try {
    raw = fs.readFileSync(locksPath, 'utf8');
  } catch {
    return null;
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const m = LOCK_ROW.exec(line);
    if (m && !m[1] && m[5] === ino) rows.push({ pid: Number(m[2]), dev: devKey(m[3], m[4]) });
  }
  return rows;
}

// The pids of flockRows, as a Set (null when unreadable).
function flockHolders(lockFile, locksPath = '/proc/locks') {
  const rows = flockRows(lockFile, locksPath);
  return rows === null ? null : new Set(rows.map((r) => r.pid));
}

// The descriptor of process `pid` ('self' for this one) that is lockFile
// itself and carries the exclusive flock on it, as { fd, dev }, or null. The
// descriptor's link names the lock file's real path, stat through it gives
// the lock file's device and inode, and its fdinfo holds a `lock:` line for
// a FLOCK ADVISORY WRITE on that inode. The kernel lists in fdinfo only the
// locks that descriptor's open file description owns (flock(1) and every
// process it handed the descriptor to share one), so the line is this lock
// itself, never a lock on another file that shares the inode number. dev is
// the device as that line prints it, the form /proc/locks uses.
function lockedFdOn(pid, lockFile) {
  const target = realLockPath(lockFile);
  if (target === null) return null;
  let st;
  let fds;
  try {
    st = fs.statSync(lockFile, { bigint: true });
    fds = fs.readdirSync(`/proc/${pid}/fd`);
  } catch {
    return null;
  }
  for (const name of fds) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd <= 2) continue;
    try {
      if (fs.readlinkSync(`/proc/${pid}/fd/${name}`) !== target) continue;
      const via = fs.statSync(`/proc/${pid}/fd/${name}`, { bigint: true });
      if (via.dev !== st.dev || via.ino !== st.ino) continue;
      const m = FDINFO_LOCK.exec(fs.readFileSync(`/proc/${pid}/fdinfo/${name}`, 'utf8'));
      if (m && m[3] === st.ino.toString()) return { fd, dev: devKey(m[1], m[2]) };
    } catch {
      /* closed meanwhile (the directory listing's own descriptor) */
    }
  }
  return null;
}

// The descriptor this process holds on lockFile that carries the flock (the
// one inherited from flock), or null.
function heldLockFd(lockFile) {
  const own = lockedFdOn('self', lockFile);
  return own ? own.fd : null;
}

// True when `pid` is this process or one of its ancestors.
function selfOrAncestor(pid) {
  return pid === process.pid || isAncestor(pid);
}

// Whether the flock on lockFile is held for this run, proved on a
// descriptor: { held, lockFd }. The re-exec under flock holds flock's
// descriptor itself, so its own fdinfo carries the lock (lockFd is that
// descriptor). A run nested inside the holder has no such descriptor (Node
// hands its children none), so the proof is a row of `rows` whose holder is
// this process or an ancestor AND holds a descriptor on the lock file that
// carries the lock, on the device the row names. A row whose holder has the
// lock file open but carries no lock on it, or holds a flock on a same-inode
// file on another filesystem, proves nothing.
function lockProof(lockFile, rows) {
  const own = heldLockFd(lockFile);
  if (own !== null) return { held: true, lockFd: own };
  for (const row of rows) {
    if (!selfOrAncestor(row.pid)) continue;
    const theirs = lockedFdOn(row.pid, lockFile);
    if (theirs && theirs.dev === row.dev) return { held: true, lockFd: null };
  }
  return { held: false, lockFd: null };
}

// True when this process sits where the re-exec under flock does: guardVar
// is set and its parent is flock(1). Not "its parent's parent is the guard
// pid": a waiter orphaned by a kill -9 of its launcher has a flock that was
// reparented, and it is exactly the run that must touch nothing. A hint only,
// read first thing so the re-exec proves its guard (underLock) before it
// touches anything; a run that merely looks like the re-exec still faces
// every check in underLock.
function looksLikeReexec(guardVar) {
  if (!process.env[guardVar]) return false;
  const parent = procStat(process.ppid);
  return Boolean(parent && parent.comm === 'flock');
}

// For the locked run (never the outer, which forwards these): SIGTERM,
// SIGINT and SIGHUP become an exit by the signal's conventional code (128
// plus its number), so every process.on('exit') cleanup still runs (the
// smoke's temp witness, the run marker). Node runs a handler only between
// turns of the event loop and a spawnSync blocks it, so a signal that lands
// while a suite runs is handled once that suite has returned and cleaned up
// after itself; the runners yield before each next step so it is handled
// there. Installed once per process.
let stopSignalsInstalled = false;
function exitOnStopSignals() {
  if (stopSignalsInstalled) return;
  stopSignalsInstalled = true;
  for (const sig of FORWARDED) process.on(sig, () => process.exit(128 + os.constants.signals[sig]));
}

// The pids in session `sid`: `ps -eo pid=,sid=` (ps itself left out), or a
// scan of /proc when ps cannot run.
function sessionPids(sid) {
  const r = spawnSync('ps', ['-eo', 'pid=,sid='], { encoding: 'utf8', timeout: 10000 });
  if (!r.error && r.status === 0) {
    return r.stdout.split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([p, s]) => s === sid && p !== r.pid).map(([p]) => p);
  }
  let names;
  try {
    names = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  return names.filter((n) => /^\d+$/.test(n)).map(Number).filter((p) => {
    const st = procStat(p);
    return Boolean(st && st.session === sid);
  });
}

// After a suite (or the smoke's initDb) has ended, kills with SIGKILL every
// process still in session `sid` (underLock's `session`, the one flock leads)
// but this one and its ancestors, and returns their pids. At that point the
// run's session should hold only flock and the locked run, so anything else
// is something the suite started that left GNU timeout's process group
// (setpgid, a shell job) and that the bound never reaches. A child that left
// the session too (setsid, Node's detached) is not found: it survives the
// sweep and the run and runs unlocked, a stated limit. Each pid's session is
// read again from /proc right before the kill, so a pid reused meanwhile by
// an unrelated process is never hit. A null sid (a run nested inside the
// holder) sweeps nothing.
function sweepSession(sid) {
  if (!sid) return [];
  const keep = new Set([process.pid]);
  let cur = process.ppid;
  for (let hops = 0; cur > 1 && hops < 4096; hops++) {
    keep.add(cur);
    const st = procStat(cur);
    if (!st) break;
    cur = st.ppid;
  }
  const killed = [];
  for (let pass = 0; pass < 10; pass++) {
    let hit = false;
    for (const pid of sessionPids(sid)) {
      if (keep.has(pid) || killed.includes(pid)) continue;
      const st = procStat(pid);
      if (!st || st.session !== sid || st.state === 'Z') continue;
      try {
        process.kill(pid, 'SIGKILL');
        killed.push(pid);
        hit = true;
      } catch {
        /* gone meanwhile */
      }
    }
    if (!hit) break;
  }
  return killed;
}

// One turn of the event loop, so a signal recorded meanwhile is handled.
function yieldToSignals() {
  return new Promise((resolve) => setImmediate(resolve));
}

function failClosed(lockFile, err) {
  console.error(`${who()}: could not take the lock ${lockFile} (flock: ${err.code || err.message}); flock (util-linux) is required and nothing runs unlocked.`);
  process.exit(1);
}

async function underLock({ lockFile, guardVar, waitLine, notice, prepare = null, locksPath = '/proc/locks' }) {
  if (process.env[guardVar] === lockFile) {
    const rows = flockRows(lockFile, locksPath);
    if (rows === null) {
      // Never wait on a lock this process might hold itself.
      console.error(`${who()}: cannot read /proc/locks to check the ${guardVar} guard on ${lockFile}; stopping without running.`);
      process.exit(1);
    }
    const proof = lockProof(lockFile, rows);
    const raw = process.env[`${guardVar}_PID`];
    const pid = Number(raw);
    const usable = Number.isInteger(pid) && pid > 1;
    const launcherAbove = usable && isAncestor(pid);
    if (launcherAbove && proof.held) {
      // The re-exec itself (its parent is the flock the launcher started)
      // skips prepare: the launcher ran it before it waited. A run nested
      // inside a holder is its own first process, so it runs it.
      const parent = procStat(process.ppid);
      const reexec = Boolean(parent && parent.ppid === pid);
      if (prepare && !reexec) prepare();
      // The run's own session, for sweepSession: only the re-exec has one
      // (the outer started flock as a session leader); a nested run shares
      // its holder's, which holds processes that are not its own.
      const self = procStat(process.pid);
      const session = reexec && self && self.session === process.ppid ? self.session : null;
      return { parentPid: pid, lockFd: proof.lockFd, session };
    }
    if (usable && pidGone(pid)) {
      console.error(`${who()}: the process that launched this run (pid ${pid}) is gone; stopping without running.`);
      process.exit(1);
    }
    // Not trusted. A run that a row puts the lock above by inode number
    // alone, or that holds a descriptor on the lock file itself, might be
    // waiting on its own lock forever as an outer, so it stops instead.
    const shown = raw === undefined ? 'missing' : JSON.stringify(raw);
    if (rows.some((r) => selfOrAncestor(r.pid))) {
      if (launcherAbove) {
        console.error(`${who()}: an ancestor of this run holds a flock on the inode number of ${lockFile}, but no descriptor above it carries the flock on that file (a same-inode file on another filesystem?); stopping without running.`);
      } else {
        console.error(`${who()}: the lock ${lockFile} is held above this run, but its guard pid (${shown}) is not the process that launched it; stopping without running.`);
      }
      process.exit(1);
    }
    const target = realLockPath(lockFile);
    if (target !== null && fdOn('self', target) !== null) {
      console.error(`${who()}: this run holds a descriptor on ${lockFile} that no flock above it backs, and its guard pid (${shown}) is not a launcher holding the lock; stopping without running.`);
      process.exit(1);
    }
    // Alive but not an ancestor, or no flock held above: forged or
    // inherited. Ignore it and take the lock as an outer.
  }

  // The forwarders go in before anything else the outer does, so no signal
  // can kill it by default action and leave a waiter behind. A signal that
  // lands before the locked run is spawned is recorded; the event loop runs
  // once before the spawn (a signal that arrived during the blocking probe is
  // delivered there), and a recorded signal stops the outer with one line and
  // nothing spawned. One delivered after that check (it cannot run until the
  // spawn has returned) is forwarded at once.
  let child = null;
  let pending = null;
  for (const sig of FORWARDED) {
    process.on(sig, () => {
      if (child) signalRun(child.pid, sig);
      else if (!pending) pending = sig;
    });
  }

  if (prepare) prepare();
  if (notice) console.error(notice);
  const probe = spawnSync('flock', ['-n', lockFile, 'true']);
  if (probe.error) failClosed(lockFile, probe.error);
  if (probe.status === 1) console.error(waitLine);

  await new Promise((resolve) => setImmediate(resolve));
  if (pending) {
    console.error(`${who()}: stopped by ${pending} before the locked run started; nothing ran.`);
    process.exit(1);
  }
  child = spawn('flock', [lockFile, process.execPath, process.argv[1], ...process.argv.slice(2)], {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, [guardVar]: lockFile, [`${guardVar}_PID`]: String(process.pid) },
  });
  if (pending) signalRun(child.pid, pending);
  return new Promise(() => {
    child.on('error', (err) => failClosed(lockFile, err));
    child.on('exit', (code, signal) => {
      if (signal) {
        console.error(`${who()}: the locked run died by ${signal}.`);
        process.exit(1);
      }
      process.exit(code === null ? 1 : code);
    });
  });
}

module.exports = { underLock, parentGone, heldLockFd, flockHolders, looksLikeReexec, exitOnStopSignals, yieldToSignals, sweepSession, gnuTimeout, boundedNodeSync, NO_GNU_TIMEOUT };
