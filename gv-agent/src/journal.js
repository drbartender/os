// The box's on-disk state, all inside the GV profile dir (mode 700, out of
// restic): the never-send-twice journal, the current-job marker, the daily
// counts, and the stale Chrome singleton cleanup. Every file is written mode
// 600 (the dir is the real guard; startup refuses one open to anyone else).
const fs = require('fs');
const path = require('path');

const FILE_MODE = 0o600;

// -- Never-send-twice journal (spec law 4) -----------------------------------
// One gv_posts id per line, appended and fsynced immediately BEFORE Send is
// clicked; a journaled id is never driven through the UI again. It is never
// trimmed: ids are server serials capped at 25 a day, so a year is a few KB,
// and a trim is a rewrite that could lose the guard mid-write.
const ID_RE = /^[A-Za-z0-9_-]+$/;

function loadJournal(file) {
  try {
    return new Set(fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

// Throws on any failure, so the caller can refuse the click.
function journalBeforeClick(file, id) {
  const line = String(id == null ? '' : id);
  if (!ID_RE.test(line)) throw new Error('refusing to journal an unusable job id');
  fs.appendFileSync(file, `${line}\n`, { flush: true, mode: FILE_MODE });
}

// -- Current-job marker (plan decision 10) -----------------------------------
// Written the moment a lease arrives, rewritten with the outcome the moment
// the job settles (before the browser closes), cleared once the report is
// delivered. A leftover marker is reported on the next loop, so a crash
// between lease and report still ends in a report. Written to a temp file and
// renamed, so a crash mid-write never leaves half a marker.
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { flush: true, mode: FILE_MODE });
  fs.renameSync(tmp, file);
}

function writeCurrentJob(file, id, result = null) {
  const marker = { id };
  if (result && result.outcome) {
    marker.outcome = result.outcome;
    if (result.reason) marker.reason = result.reason;
  }
  writeAtomic(file, JSON.stringify(marker));
}

function readCurrentJob(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!m || typeof m !== 'object' || m.id == null || m.id === '') return null;
    const out = { id: m.id };
    if (typeof m.outcome === 'string') out.outcome = m.outcome;
    if (typeof m.reason === 'string') out.reason = m.reason;
    return out;
  } catch {
    return null;
  }
}

function clearCurrentJob(file) {
  fs.rmSync(file, { force: true });
}

// -- Stale Chrome singletons -------------------------------------------------
// A crashed Chrome leaves these behind and the next launch on the profile
// fails. They are removed only when no process holds the profile: deleting a
// live Chrome's lock would let two browsers share one cookie store.
const SINGLETONS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];

function clearStaleSingletons(profileDir, isProfileInUse) {
  let inUse;
  try { inUse = Boolean(isProfileInUse(profileDir)); } catch { inUse = true; }
  if (inUse) return { inUse: true, removed: [] };
  const removed = [];
  for (const name of SINGLETONS) {
    try {
      fs.unlinkSync(path.join(profileDir, name)); // removes the symlink itself, dangling or not
      removed.push(name);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return { inUse: false, removed };
}

// Does any process carry --user-data-dir=<profileDir>? Reads /proc; anything
// it cannot read counts as in use.
function profileInUse(profileDir, procDir = '/proc') {
  const want = path.resolve(profileDir);
  let pids;
  try {
    pids = fs.readdirSync(procDir).filter((name) => /^\d+$/.test(name));
  } catch {
    return true;
  }
  for (const pid of pids) {
    let args;
    try {
      args = fs.readFileSync(path.join(procDir, pid, 'cmdline'), 'utf8').split('\0');
    } catch {
      continue; // the process exited while we looked
    }
    for (const arg of args) {
      if (!arg.startsWith('--user-data-dir=')) continue;
      let dir = arg.slice('--user-data-dir='.length);
      if (!path.isAbsolute(dir)) {
        try { dir = path.resolve(fs.readlinkSync(path.join(procDir, pid, 'cwd')), dir); } catch { return true; }
      }
      if (path.resolve(dir) === want) return true;
    }
  }
  return false;
}

// -- Box daily counts ---------------------------------------------------------
// { day: 'YYYY-MM-DD' in America/Chicago, count }, one file per counter: the
// clicks (gv-sent-count.json, the box's cap, spec law 7) and the jobs the box
// drove a browser for (gv-attempt-count.json, the attempt budget). Read at
// start so a restart keeps both. An unreadable file reads as 0 (the server
// holds its own rolling-24h cap); a bump that cannot be saved throws.
function readDayCount(file, dayKey) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    return c && c.day === dayKey && Number.isInteger(c.count) && c.count > 0 ? c.count : 0;
  } catch {
    return 0;
  }
}

function bumpDayCount(file, dayKey) {
  const count = readDayCount(file, dayKey) + 1;
  writeAtomic(file, JSON.stringify({ day: dayKey, count }));
  return count;
}

module.exports = {
  loadJournal, journalBeforeClick,
  writeCurrentJob, readCurrentJob, clearCurrentJob,
  clearStaleSingletons, profileInUse,
  readDayCount, bumpDayCount,
};
