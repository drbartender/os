'use strict';

// The flip marker and the two push markers (instruction rewrite step 3, lane
// ship-state; spec 2026-10-19 section 4.4, plan 2026-10-22 decisions 1 and 16).
//
// Three files under the git common dir, so every worktree of the repo reads
// the same ones (receipt.commonDir from the cwd):
//   drb-flip.json           {sha, pushed_at, written_by}. Step 5 writes it once
//                           the flip push is on origin; this module only reads
//                           it. While it is absent every push path keeps
//                           today's cue-only rules, and the two markers below
//                           bind nothing yet (standing() says so).
//   drb-markers/gate.json   {sha, at, reason, gates, on_main, earlier}. The
//                           gate writes it when it fails on a sha on main.
//   drb-markers/watch.json  {sha, at, deploy_at, count, by_issue, earlier}.
//                           The post-ship watch writes it when it reads Sentry
//                           events after a deploy; count null means Sentry
//                           could not be read, which never reads as quiet.
//
// The consumers' branch rule: every reader of the flip state branches on
// flipState(), never on flip() alone. On 'absent' the hook takes the legacy
// fingerprint path and the board writer its guarded push, both with the
// markers unread, and ship refuses. On 'unreadable' every path refuses with
// standing().flip's line. On 'present' every path takes the new one,
// refusing on every line standing() returns. lane-status prints both
// markers' lines whatever the flip state (the before-flip wording exists for
// it), and standing().flip's line on 'unreadable'. The rules this module
// holds:
//   - A marker file that exists but cannot be read as one (not JSON, not an
//     object, no full sha, or any read error but "no such file") reads as
//     STANDING, {unreadable: true, path}, never as absent. Nothing here clears
//     or overwrites an unreadable marker: a person reads the file and repairs
//     or removes it. The flip file is the one exception in shape: flip()
//     returns its object or null, null for a torn file too, so a consumer
//     that refuses without flip() refuses on it; flipState() tells 'absent',
//     'present' and 'unreadable' apart, and standing().flip is the blocker
//     line for a torn file, so a consumer refusing on any standing() line
//     refuses too.
//   - One predicate, placement(sha), says where a sha sits: 'on' (resolves,
//     an ancestor of refs/heads/main), 'off' (resolves, not), 'gone' (only
//     a clean miss: rev-parse --verify --quiet exits 1 with no line on
//     stderr starting with `error:` or `fatal:`, trace output dropped, git
//     run in the C locale, which is load-bearing: git translates both
//     prefixes), 'unknown' (exit 1 with such a line, any other git failure,
//     a spawn error or exit 128 included, an unreadable pack, or no main).
//     setGate throws GATE_RESOLVE_FAILED, and setWatch and clearWatch
//     WATCH_RESOLVE_FAILED, for a short ref git fails to resolve that way.
//     A silent miss is trusted only through cleanMiss: every pack file under
//     <common>/objects/pack and under each alternate (alternates of
//     alternates to depth 5, each file parsed and each entry resolved as git
//     does) can be read, and so can every alternates file (git skips an
//     unreadable pack silently); a store path or a pack file name that is
//     not valid UTF-8 is never followed and reads unknown (git opens it by
//     its bytes; the walk does not try), and so does a repo whose own
//     objects directory the walk cannot find. What stays uncovered: a pack
//     git skips silently for a reason other than readability (a bad index it
//     does not report). Git errors fail closed: 'gone' and 'off' count as off
//     main, so any other sha fixes such a marker and a gate passing on main
//     clears it (a main rewritten before a push, which the replay recipe
//     does); 'unknown' never clears and never counts as fix forward, so its
//     marker stands and its line names the by-hand removal.
//   - setGate writes for a sha 'on' main, refuses one 'off' (a lane tip that
//     fails its gate leaves no marker), and writes one 'gone' or 'unknown'
//     anyway with `on_main: null` and `uncertain`: a marker that stands
//     blocks, the safe direction. Never backwards: a standing marker git
//     proves a strict descendant of the new sha is kept, since fix forward
//     from the older sha would let the failing sha itself through. Otherwise
//     the new failure is recorded; the standing one is dropped when it is
//     'off' or 'gone' or git proves the new sha descends from it, and is
//     otherwise kept under `earlier` (git could not order the two), so a
//     failing sha is never left unrecorded.
//   - Fix forward (decision 16): isFixForward(sha) is true when the sha fixes
//     the marker and every failure under `earlier`: a STRICT descendant of
//     one on main, any other sha for one 'off' or 'gone'. The failing sha is
//     never its own fix by default; with `{self: true}` (the gate's, after it
//     re-ran every check the marker names on that very sha) it is.
//     clearGateIfDescendant clears only for a sha that is itself 'on' main
//     and is such a fix: a lane tip never clears one.
//   - setWatch writes a full sha git cannot resolve with `resolved: false`.
//   - A watch marker stands until it is acked by its sha (clearWatch). A watch
//     that finds events while a marker stands on another sha stacks on top of
//     it (`earlier`, oldest first) rather than replacing it, so no deploy's
//     events go unacked; a re-run on the same sha replaces its own entry.
//     Every ack is appended to drb-markers/acks.jsonl BEFORE the stack is
//     rewritten, so an append that fails clears nothing; the ack command
//     names the full sha of an entry git could not resolve.
//
// Every write is atomic (receipt.writeJsonAtomic: a temp file, then rename),
// and every read-modify-write runs under withLock (below, also used by
// shipLog.js), so a watch and an ack, or two watches, never lose each other's
// marker. Free text (the gate's reason) goes through clean(): control
// characters and the Unicode line separators flattened, the PII mask, then
// the cap, on write and again when a line is built.

const { isUtf8 } = require('buffer');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const R = require('./receipt');
const { mask } = require('./piiShapes');

const SHA_RE = R.KEY_RE;
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCK_WAIT_MS = 10_000;
// A lock whose holder is alive is broken only past this bound: every critical
// section here is a few file operations, so a holder past it is hung.
const STALE_LOCK_MS = LOCK_WAIT_MS;
const TEXT_CAP = 300;
const ZONED_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

// True for a zoned ISO time that names a real instant: the shape, a finite
// Date.parse, and a calendar round trip. V8 rolls February 30 over to March 2
// in both Date.parse and Date.UTC, so comparing those two alone would pass it;
// the fields Date.UTC lands on must be the fields written, and the instant
// they make, moved by the offset, must be Date.parse's.
function isZonedTime(value) {
  if (typeof value !== 'string') return false;
  const m = ZONED_PARTS.exec(value);
  if (!m) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const [y, mo, d, h, mi] = [1, 2, 3, 4, 5].map((i) => Number(m[i]));
  const sec = m[6] ? Number(m[6]) : 0;
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0;
  const local = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  const back = new Date(local);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== sec) return false;
  const offset = m[8] ? (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10])) : 0;
  if (m[8] && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
  return local - offset * 60_000 === parsed;
}

function markerPaths({ cwd } = {}) {
  const common = R.commonDir({ cwd });
  const dir = path.join(common, 'drb-markers');
  return {
    common,
    dir,
    flip: path.join(common, 'drb-flip.json'),
    gate: path.join(dir, 'gate.json'),
    watch: path.join(dir, 'watch.json'),
    acks: path.join(dir, 'acks.jsonl'),
    lock: path.join(dir, '.lock'),
  };
}

// One line of text for a file a person reads: C0 controls, DEL, NEL and the
// Unicode line and paragraph separators become spaces (so no text can start a
// line of its own under any reader's idea of a line), then the PII mask in
// the allowlisted mode with no path, then the cap. Masking first means the cap
// never leaves half of a shape behind.
function clean(text) {
  const flat = String(text === undefined || text === null ? '' : text).replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, ' ').trim();
  const masked = mask(flat);
  return masked.length > TEXT_CAP ? `${masked.slice(0, TEXT_CAP)}...` : masked;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---- the lock ------------------------------------------------------------------
// A lock file created with O_EXCL ('wx') holding {pid, at, token}. A waiter
// breaks it only when its pid is dead (kill 0 answers ESRCH) or its `at` is
// past STALE_LOCK_MS (a file whose content cannot be read is judged by its
// mtime, which covers the instant between create and write), and breaks it by
// renaming it aside: of two breakers only one rename finds the file, and the
// other sees ENOENT and loops. The breaker then checks that what it moved is
// the lock it judged (same inode, same bytes); when another waiter broke it
// first and already holds a fresh lock, that lock is linked back without
// clobbering anything. The release removes the file only while it still
// carries this acquisition's pid and token. The window left: three waiters
// racing inside one breaker's rename-and-check, a few microseconds, on a lock
// whose holder is already dead or hung.

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

// {ino, raw, pid, token, at} of the lock file, or null when it is gone.
function readHolder(lockFile) {
  let fd;
  try {
    fd = fs.openSync(lockFile, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd, 'utf8');
    let v = null;
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
    const pid = v && Number.isInteger(v.pid) && v.pid > 0 ? v.pid : null;
    const at = v && typeof v.at === 'string' ? Date.parse(v.at) : NaN;
    return { ino: st.ino, raw, pid, token: v && typeof v.token === 'string' ? v.token : null, at: Number.isFinite(at) ? at : st.mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

function tryCreate(lockFile, body) {
  let fd;
  try {
    fd = fs.openSync(lockFile, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

function breakLock(lockFile, judged) {
  const aside = `${lockFile}.broken-${process.pid}-${Date.now()}`;
  try {
    fs.renameSync(lockFile, aside);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  const moved = readHolder(aside);
  if (moved && (moved.ino !== judged.ino || moved.raw !== judged.raw)) {
    try {
      fs.linkSync(aside, lockFile);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
  fs.rmSync(aside, { force: true });
}

function releaseLock(lockFile, token) {
  const holder = readHolder(lockFile);
  if (holder && holder.pid === process.pid && holder.token === token) fs.rmSync(lockFile, { force: true });
}

// `beforeBreak` is a TEST-ONLY seam: called with the lock file between the
// judgment that its holder is dead or hung and the break, so a test can put
// another waiter's fresh lock there and see it linked back. Nothing else
// passes it.
function withLock(lockFile, fn, { waitMs = LOCK_WAIT_MS, staleMs = STALE_LOCK_MS, beforeBreak = null } = {}) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryCreate(lockFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }))) break;
    const holder = readHolder(lockFile);
    if (!holder) continue;
    if ((holder.pid !== null && !pidAlive(holder.pid)) || Date.now() - holder.at > staleMs) {
      if (beforeBreak) beforeBreak(lockFile);
      breakLock(lockFile, holder);
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`${lockFile} is held by another writer (pid ${holder.pid === null ? 'unknown' : holder.pid}); try again`);
    sleepMs(20);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockFile, token);
  }
}

// ---- reading -------------------------------------------------------------------

function isMarkerObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && typeof v.sha === 'string' && SHA_RE.test(v.sha);
}

// null when the file does not exist; {unreadable: true, path} when it exists
// and is not a marker; else the parsed object. `extra` checks more fields.
function readMarker(file, extra = () => true) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return { unreadable: true, path: file };
  }
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return { unreadable: true, path: file };
  }
  if (!isMarkerObject(v) || !extra(v)) return { unreadable: true, path: file };
  return v;
}

// A marker file's `earlier`, when present, is a list of marker objects: the
// watch's stack of unacked shas, and the gate's failures git could not order.
function stackShape(v) {
  return v.earlier === undefined || (Array.isArray(v.earlier) && v.earlier.every(isMarkerObject));
}

// The flip marker's object, or null: null for an unreadable file too, so a
// consumer that refuses without flip() refuses on a torn file. flipState()
// tells the three states apart, and standing().flip stands for a torn one.
function flip({ cwd } = {}) {
  const m = readMarker(markerPaths({ cwd }).flip);
  return m && !m.unreadable ? m : null;
}

function flipFrom(file) {
  const m = readMarker(file);
  const none = { sha: null, pushed_at: null, written_by: null, path: file };
  if (m === null) return { state: 'absent', ...none };
  if (m.unreadable) return { state: 'unreadable', ...none };
  return { state: 'present', sha: m.sha, pushed_at: m.pushed_at === undefined ? null : m.pushed_at, written_by: m.written_by === undefined ? null : m.written_by, path: file };
}

function flipState({ cwd } = {}) {
  return flipFrom(markerPaths({ cwd }).flip);
}

function gate({ cwd } = {}) {
  return readMarker(markerPaths({ cwd }).gate, stackShape);
}

function watch({ cwd } = {}) {
  return readMarker(markerPaths({ cwd }).watch, stackShape);
}

// ---- git -----------------------------------------------------------------------

// The full sha of a commit, or an Error carrying git's exit status and its
// stderr. A clean miss (noSuchCommit) is exit 1 with no line on stderr that
// starts with `error:` or `fatal:`: rev-parse --verify --quiet saying there
// is no such commit. Exit 1 with such a line (an empty or unreadable loose
// object, a truncated pack), a spawn error, 128 or any fatal is git failing
// to answer. Every GIT_TRACE* variable is dropped from git's env, so trace
// output never reaches stderr. The same checks as receipt.resolveCommit: a
// value git would read as an option never reaches it. shipLog.js resolves
// through it too.
function resolveStrict(ref, cwd) {
  if (typeof ref !== 'string' || ref === '' || /[\0\n]/.test(ref)) {
    const err = new Error('not a commit');
    err.status = 1;
    err.stderr = '';
    throw err;
  }
  const env = R.gitEnv();
  for (const k of Object.keys(env)) if (k.startsWith('GIT_TRACE')) delete env[k];
  // Load-bearing: git's usage.c marks its `error: ` and `fatal: ` prefixes
  // for translation (French prints `erreur : ` and `fatal : `), so only the C
  // locale keeps noSuchCommit's prefix test true on a box with git's message
  // catalogs installed.
  env.LC_ALL = 'C';
  delete env.LANGUAGE;
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { cwd, env, encoding: 'utf8' });
  if (r.status === 0 && SHA_RE.test(r.stdout.trim())) return r.stdout.trim();
  const err = new Error(r.error ? `git did not run (${r.error.code || 'error'})` : `git rev-parse exited ${r.status}`);
  err.status = r.error ? null : r.status;
  err.stderr = String(r.stderr || '').trim();
  throw err;
}

const noSuchCommit = (err) => Boolean(err) && err.status === 1 && !/^(?:error|fatal):/m.test(String(err.stderr || ''));

// The quoted entry that opens at text[at], unquoted the way git's
// unquote_c_style does: \" \\ \a \b \f \n \r \t \v and three-digit octal
// escapes (bytes), a raw newline kept. {entry, end}, end just past the
// closing quote; null when the quoting is broken.
const C_ESCAPES = new Map([['"', '"'], ['\\', '\\'], ['a', '\x07'], ['b', '\b'], ['f', '\f'], ['n', '\n'], ['r', '\r'], ['t', '\t'], ['v', '\v']]);

function unquoteC(text, at) {
  let out = '';
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { entry: out, end: i + 1 };
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = text[++i];
    if (n === undefined) return null;
    if (C_ESCAPES.has(n)) {
      out += C_ESCAPES.get(n);
      continue;
    }
    const oct = text.slice(i, i + 3);
    if (!/^[0-3][0-7]{2}$/.test(oct)) return null;
    out += String.fromCharCode(parseInt(oct, 8));
    i += 2;
  }
  return null;
}

// The object directories an alternates file names, read the way git's
// parse_alt_odb_entry reads it: the whole file one stream, entry by entry. An
// entry opening with `#` is a comment to the end of its line; one opening
// with `"` that unquotes ends at its closing quote; any other, a broken quote
// included, runs to the end of its line as written. After each entry git
// skips exactly one character, whatever it is, so `"<A>" <B>` names two
// stores and `"<A>" #x` one. Empty entries are skipped. The text is latin1
// (one char per byte), so each entry's bytes are checked (isUtf8) and come
// back as UTF-8; one entry that is not valid UTF-8 makes the whole answer
// null, which the walk refuses. Joined as git joins: an absolute entry
// stands alone, a relative one is appended to `base` (the real path of the
// objects directory holding the file) as a string, and the walk's native
// realpath then follows a link before a later `..`.
function alternateDirs(base, text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    const nl = text.indexOf('\n', i);
    const eol = nl === -1 ? text.length : nl;
    const quoted = text[i] === '"' ? unquoteC(text, i) : null;
    const entry = quoted ? quoted.entry : text[i] === '#' ? '' : text.slice(i, eol);
    i = (quoted ? quoted.end : eol) + 1;
    if (entry === '') continue;
    const bytes = Buffer.from(entry, 'latin1');
    if (!isUtf8(bytes)) return null;
    const name = bytes.toString('utf8');
    out.push(path.isAbsolute(name) ? name : `${base}/${name}`);
  }
  return out;
}

// True when every file in one pack directory can be read. A missing
// directory holds no pack; a file listed and then gone (a concurrent repack
// unlinked it) is no pack either. The names are listed as bytes: git loads a
// pack by the bytes of its name, and a name that is not valid UTF-8 would
// decode to U+FFFD and answer ENOENT, which reads as a pack a repack removed.
// Such a name is false, never checked; every other name is checked by its own
// bytes.
function packDirReadable(dir) {
  let names;
  try {
    names = fs.readdirSync(dir, { encoding: 'buffer' });
  } catch (err) {
    return err.code === 'ENOENT';
  }
  const prefix = Buffer.from(`${dir}/`);
  for (const name of names) {
    if (!isUtf8(name)) return false;
    try {
      fs.accessSync(Buffer.concat([prefix, name]), fs.constants.R_OK);
    } catch (err) {
      if (err.code !== 'ENOENT') return false;
    }
  }
  return true;
}

// The object stores git reads: <common>/objects and every alternate, the
// alternates of alternates followed to depth 5 (git's own limit), cycles
// ignored. True only when every pack file in them, and every alternates file
// on the way, can be read: git skips an unreadable pack silently and answers
// a clean miss, even for a sha it holds, so a silent miss is trusted only
// after this check (cleanMiss). Each store is keyed by its libc realpath
// (realpathSync.native, physical like git's strbuf_realpath; the JS one
// collapses `..` by text before it follows a link). An alternate that is not
// there (ENOENT) holds no pack, and git prints an error for a missing
// alternate, so that miss is never clean anyway; any other error is false.
// The repo's own store (depth 0) is never "not there" for git, which cannot
// run without <common>/objects, so there any realpath error, ENOENT
// included, is false: a missing root store means the walk is looking in the
// wrong place (R.commonDir trims git's output, so a git dir whose name ends
// in a space names a path that does not exist).
// A path that is not valid UTF-8 is false, never followed: an alternates
// entry (alternateDirs answers null), a realpath (taken as bytes, so a link
// to such a store is caught), a pack file's name (packDirReadable), and the
// common dir, whose text git printed with U+FFFD in place of each bad byte.
// Decoded, any of them names a path that is not there, which would read as
// no store or no pack.
const ALTERNATE_DEPTH = 5;
const BAD_BYTE = String.fromCharCode(0xfffd);

function packsReadable(cwd) {
  let objects;
  try {
    const common = R.commonDir({ cwd });
    if (common.includes(BAD_BYTE)) return false;
    objects = path.join(common, 'objects');
  } catch {
    return false;
  }
  const seen = new Set();
  const walk = (dir, depth) => {
    let key;
    try {
      const real = fs.realpathSync.native(dir, { encoding: 'buffer' });
      if (!isUtf8(real)) return false;
      key = real.toString('utf8');
    } catch (err) {
      return depth > 0 && err.code === 'ENOENT';
    }
    if (seen.has(key)) return true;
    seen.add(key);
    if (!packDirReadable(path.join(key, 'pack'))) return false;
    if (depth > ALTERNATE_DEPTH) return true;
    let text = '';
    try {
      text = fs.readFileSync(path.join(key, 'info', 'alternates'), 'latin1');
    } catch (err) {
      if (err.code !== 'ENOENT') return false;
    }
    const alts = alternateDirs(key, text);
    return alts !== null && alts.every((alt) => walk(alt, depth + 1));
  };
  return walk(objects, 0);
}

// The one test of a silent miss: git said no such commit (noSuchCommit) and
// every pack it could have read from was readable. placement, setGate's
// short ref, watchSha and shipLog's resolve all trust a miss only through it.
function cleanMiss(err, { cwd } = {}) {
  return noSuchCommit(err) && packsReadable(cwd === undefined ? REPO_ROOT : cwd);
}

function namedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const statusText = (err) => (err && err.status !== null && err.status !== undefined ? err.status : 'none, git did not run');

// seams.resolve is a TEST-ONLY seam: every resolve here goes through it, so a
// test can make git fail with a status other than 1. Nothing else replaces it.
const seams = { resolve: resolveStrict };

function resolveOrNull(ref, cwd) {
  try {
    return seams.resolve(ref, cwd === undefined ? REPO_ROOT : cwd);
  } catch {
    return null;
  }
}

// isAncestor as true, false, or null when git could not answer.
function ancestor(a, b, cwd) {
  try {
    return R.isAncestor(a, b, { cwd });
  } catch {
    return null;
  }
}

// The one predicate for where a sha sits: 'on' (it resolves and is an
// ancestor of refs/heads/main), 'off' (it resolves and is not), 'gone' (a
// clean miss: rev-parse exits 1 with no `error:` or `fatal:` line on stderr,
// and every pack git could read from is readable), 'unknown' (any other
// failure: an error line, 128, a spawn error, an unreadable pack, git
// failing on the ancestry walk, or no main to answer against).
function placement(sha, { cwd } = {}) {
  let full;
  try {
    full = seams.resolve(sha, cwd === undefined ? REPO_ROOT : cwd);
  } catch (err) {
    return cleanMiss(err, { cwd }) ? 'gone' : 'unknown';
  }
  const main = resolveOrNull('refs/heads/main', cwd);
  if (!main) return 'unknown';
  const a = ancestor(full, main, cwd);
  if (a === null) return 'unknown';
  return a ? 'on' : 'off';
}

// A fix for one failure: another sha that strictly descends from it, or any
// other sha when the failure's sha left main ('off') or is 'gone'. 'unknown'
// never counts. With `self`, the failure's own sha counts too: a gate that
// re-ran on that sha every check the marker names (the gate's ruling,
// amending decision 16, so a transient failure on main's tip cannot wedge
// main until a new commit lands); it is never the default.
function fixesEntry(entrySha, full, cwd, self = false) {
  if (!full) return false;
  if (full === entrySha) return self === true;
  const where = placement(entrySha, { cwd });
  if (where === 'off' || where === 'gone') return true;
  if (where === 'unknown') return false;
  return ancestor(entrySha, full, cwd) === true;
}

// A fix for the marker: a fix for it and for every failure under `earlier`.
function fixesMarker(marker, full, cwd, self = false) {
  return [...(marker.earlier || []), marker].every((e) => fixesEntry(e.sha, full, cwd, self));
}

// ---- the gate marker -----------------------------------------------------------

function setGate({ sha, reason = '', gates = [], cwd } = {}) {
  if (!Array.isArray(gates) || gates.some((g) => typeof g !== 'string')) throw new TypeError('setGate: gates must be a list of gate names');
  // A ref that is not a full sha must resolve: no such commit is a refusal,
  // and git failing to answer throws, so the gate fails loudly rather than
  // record nothing. A full sha git cannot resolve gets the uncertain marker.
  let resolvedSha = null;
  try {
    resolvedSha = seams.resolve(sha, cwd === undefined ? REPO_ROOT : cwd);
  } catch (err) {
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
      if (cleanMiss(err, { cwd })) return { written: false, reason: `${clean(sha)} is not a commit in this repo` };
      throw namedError(`setGate: git could not resolve ${clean(sha)} (status ${statusText(err)}); no gate marker was written`, 'GATE_RESOLVE_FAILED');
    }
  }
  const full = resolvedSha || sha;
  const where = placement(full, { cwd });
  if (where === 'off') return { written: false, reason: `${R.short(full)} is not on main; a lane tip leaves no gate marker` };
  const p = markerPaths({ cwd });
  return withLock(p.lock, () => {
    const cur = readMarker(p.gate, stackShape);
    if (cur && cur.unreadable) return { written: false, reason: `unreadable marker ${cur.path}` };
    // Never backwards: a standing marker git proves a strict descendant of
    // the new sha is kept. Otherwise the new failure is recorded; the standing
    // one is dropped only when it is off main or gone, or git proves the new
    // sha strictly descends from it, and is otherwise kept under `earlier`
    // (git could not order the two), so no failing sha goes unrecorded.
    let earlier = [];
    let unordered = false;
    if (cur) {
      const { earlier: curEarlier, ...curTop } = cur;
      earlier = [...(curEarlier || [])];
      if (curTop.sha !== full) {
        const curWhere = placement(curTop.sha, { cwd });
        if (curWhere === 'on' || curWhere === 'unknown') {
          if (ancestor(full, curTop.sha, cwd) === true && curTop.sha !== full) {
            return { written: false, reason: `the gate marker on ${R.short(curTop.sha)} stands and descends from ${R.short(full)}; it is kept` };
          }
          if (ancestor(curTop.sha, full, cwd) !== true) {
            earlier.push(curTop);
            unordered = true;
          }
        }
      }
      earlier = earlier.filter((e) => e.sha !== full);
    }
    const marker = { sha: full, at: new Date().toISOString(), reason: clean(reason), gates: [...gates], on_main: where === 'on' ? true : null };
    if (!resolvedSha) marker.resolved = false;
    if (earlier.length) marker.earlier = earlier;
    R.writeJsonAtomic(p.gate, marker);
    return where === 'on' && !unordered ? { written: true } : { written: true, uncertain: true };
  });
}

// Clears only for a sha that is itself on main and fixes the marker and every
// failure under it.
function clearGateIfDescendant(sha, { cwd, self = false } = {}) {
  const p = markerPaths({ cwd });
  if (readMarker(p.gate, stackShape) === null) return { cleared: false, marker: null };
  return withLock(p.lock, () => {
    const marker = readMarker(p.gate, stackShape);
    if (!marker || marker.unreadable) return { cleared: false, marker };
    const full = resolveOrNull(sha, cwd);
    if (!full || placement(full, { cwd }) !== 'on' || !fixesMarker(marker, full, cwd, self)) return { cleared: false, marker };
    fs.rmSync(p.gate, { force: true });
    return { cleared: true, marker };
  });
}

function isFixForward(sha, { cwd, self = false } = {}) {
  const marker = gate({ cwd });
  if (!marker || marker.unreadable) return false;
  const full = resolveOrNull(sha, cwd);
  return Boolean(full) && fixesMarker(marker, full, cwd, self);
}

// ---- the watch marker ----------------------------------------------------------

// The stack a watch file holds, oldest first, the standing marker last.
function watchStack(marker) {
  const { earlier, ...top } = marker;
  return [...(earlier || []), top];
}

function writeWatchStack(file, stack) {
  if (stack.length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  const top = stack[stack.length - 1];
  const earlier = stack.slice(0, -1);
  R.writeJsonAtomic(file, earlier.length ? { ...top, earlier } : top);
}

// The sha a watch call names: the resolved commit, or a full sha git cannot
// resolve, taken as written (resolved false; a watch marker that stands
// blocks, the safe direction). A short ref with a clean miss is null (names no
// commit); a short ref git fails to resolve throws WATCH_RESOLVE_FAILED.
function watchSha(sha, cwd) {
  try {
    return { full: seams.resolve(sha, cwd === undefined ? REPO_ROOT : cwd), resolved: true };
  } catch (err) {
    if (typeof sha === 'string' && SHA_RE.test(sha)) return { full: sha, resolved: false };
    if (cleanMiss(err, { cwd })) return null;
    throw namedError(`watch marker: git could not resolve ${clean(sha)} (status ${statusText(err)}); nothing was changed`, 'WATCH_RESOLVE_FAILED');
  }
}

function setWatch({ sha, deploy_at = null, count, by_issue = null, cwd } = {}) {
  if (!(count === null || (Number.isInteger(count) && count >= 0))) throw new TypeError('setWatch: count must be a whole number or null');
  if (!(deploy_at === null || isZonedTime(deploy_at))) {
    throw new TypeError('setWatch: deploy_at must be an ISO time with a zone (Z or +HH:MM) or null');
  }
  if (!(by_issue === null || (typeof by_issue === 'object' && !Array.isArray(by_issue)))) throw new TypeError('setWatch: by_issue must be an object or null');
  const named = watchSha(sha, cwd);
  if (!named) throw new TypeError(`setWatch: ${clean(sha)} names no commit and is not a full sha`);
  const p = markerPaths({ cwd });
  return withLock(p.lock, () => {
    const cur = readMarker(p.watch, stackShape);
    if (cur && cur.unreadable) return { written: false, reason: `unreadable marker ${cur.path}` };
    const stack = (cur ? watchStack(cur) : []).filter((m) => m.sha !== named.full);
    const entry = { sha: named.full, at: new Date().toISOString(), deploy_at: deploy_at === null ? null : new Date(deploy_at).toISOString(), count, by_issue };
    if (!named.resolved) entry.resolved = false;
    stack.push(entry);
    writeWatchStack(p.watch, stack);
    return { written: true };
  });
}

// True when a marker named `sha` stood and is cleared; false when none stands,
// the marker names another sha, or the file is unreadable. Every clear
// appends one masked record {sha, at, note} to drb-markers/acks.jsonl, so an
// ack is recorded even for a sha with no ship log (an unresolved one).
function clearWatch(sha, { note = null, cwd } = {}) {
  const named = watchSha(sha, cwd);
  if (!named) return false;
  const p = markerPaths({ cwd });
  if (readMarker(p.watch, stackShape) === null) return false;
  return withLock(p.lock, () => {
    const cur = readMarker(p.watch, stackShape);
    if (!cur || cur.unreadable) return false;
    const stack = watchStack(cur);
    const at = stack.findIndex((m) => m.sha === named.full);
    if (at === -1) return false;
    // The record first: an append that fails throws with the marker intact.
    const record = { sha: named.full, at: new Date().toISOString(), note: note === null || note === undefined ? null : clean(note) };
    fs.appendFileSync(p.acks, `${JSON.stringify(record)}\n`);
    stack.splice(at, 1);
    writeWatchStack(p.watch, stack);
    return true;
  });
}

// ---- the lines -----------------------------------------------------------------
// After the flip (or with an unreadable flip file) each line is a refusal,
// BLOCKED first. Before it the markers bind nothing yet, and the line says so.

const BEFORE_FLIP = 'it binds every push path from the flip on';

function unreadableLine(kind, m, flipped) {
  const what = `${kind} marker stands (unreadable marker ${m.path})`;
  return flipped
    ? `BLOCKED: ${what}; read it, then repair or remove the file by hand`
    : `${what}; ${BEFORE_FLIP}; read it, then repair or remove the file by hand`;
}

// How one failure under `earlier` clears, by its placement.
const EARLIER_EXIT = Object.freeze({
  on: 'on main, needs a descendant that passes',
  off: 'off main, cleared by any later sha on main that passes',
  gone: 'gone, cleared by any later sha on main that passes',
  unknown: 'git cannot place it, it waits for git or the by-hand removal',
});

function gateLine(m, file, flipped, cwd) {
  if (m.unreadable) return unreadableLine('gate', m, flipped);
  const what = `gate marker stands on ${R.short(m.sha)} (${clean(m.reason) || 'no reason recorded'})`;
  // The gate's clearing rule (shaGate.js clearMarker): a pass on this sha
  // again or on a descendant on main, re-running the checks named.
  const named = Array.isArray(m.gates) && m.gates.length ? m.gates.map(clean).join(', ') : 'none recorded';
  const advice = `a gate that passes on this sha again or on a descendant on main clears it when that run re-runs the checks this marker names (${named}; all of them once the failing sha is on origin/main, otherwise those its range still needs); a marker whose sha left main clears on any gate that passes on main; last resort: remove ${file} by hand`;
  const line = flipped ? `BLOCKED: ${what}; ${advice}` : `${what}; ${BEFORE_FLIP}; ${advice}`;
  const earlier = m.earlier || [];
  if (!earlier.length) return line;
  const one = earlier.length === 1;
  const each = earlier.map((e) => `${R.short(e.sha)} (${EARLIER_EXIT[placement(e.sha, { cwd })]})`).join(', ');
  return `${line}; ${earlier.length} earlier failure${one ? '' : 's'} git could not order stand${one ? 's' : ''} with it: ${each}`;
}

// The sha an ack names: sha7, or the full sha for an entry git could not
// resolve (a sha7 of it would name no commit).
const ackSha = (e) => (e.resolved === false ? e.sha : R.short(e.sha));

function watchLine(m, flipped) {
  if (m.unreadable) return unreadableLine('watch', m, flipped);
  const sha7 = R.short(m.sha);
  const count = Number.isInteger(m.count) ? m.count : 'unknown';
  const what = `watch marker stands on ${sha7} (${count} events since deploy)`;
  const ack = `npm run ship -- --ack-watch ${ackSha(m)} --note <what you saw and decided>`;
  let line = flipped
    ? `BLOCKED: ${what}; read them, then ${ack}`
    : `${what}; ${BEFORE_FLIP}; after the flip, read them and clear it with ${ack}`;
  const earlier = m.earlier || [];
  if (earlier.length) {
    const one = earlier.length === 1;
    line += `; ${earlier.length} earlier watch marker${one ? '' : 's'} stand${one ? 's' : ''} behind it (${earlier.map(ackSha).join(', ')}), each acked by its own sha`;
  }
  return line;
}

// {gate, watch, flip}: the line for each marker that stands, else null. The
// flip line stands only for an unreadable flip file.
function standing({ cwd } = {}) {
  const p = markerPaths({ cwd });
  const f = flipFrom(p.flip);
  const flipped = f.state !== 'absent';
  const g = readMarker(p.gate, stackShape);
  const w = readMarker(p.watch, stackShape);
  return {
    gate: g ? gateLine(g, p.gate, flipped, cwd) : null,
    watch: w ? watchLine(w, flipped) : null,
    flip: f.state === 'unreadable' ? `BLOCKED: the flip marker ${f.path} is unreadable; repair or remove it by hand` : null,
  };
}

module.exports = {
  flip,
  flipState,
  gate,
  watch,
  setGate,
  clearGateIfDescendant,
  isFixForward,
  setWatch,
  clearWatch,
  standing,
  placement,
  seams,
  markerPaths,
  withLock,
  pidAlive,
  clean,
  isZonedTime,
  resolveStrict,
  cleanMiss,
};
