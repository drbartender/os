'use strict';

// The ship log and its manifest (instruction rewrite step 3, lane ship-state;
// spec 2026-10-19 sections 4.1 and 4.4, plan 2026-10-22 decision 6).
//
// This header states what the library guarantees. The ship flow that drives
// these writers and readers, the watch's windows and the lines lane-status
// prints are the plan's contracts (docs/superpowers/plans/
// 2026-10-22-instruction-rewrite-step3.md: the ship.js, post-ship-watch.js
// and lane-status.js paragraphs) and live there alone; this header never
// restates them.
//
// The files, under <git-common-dir>/drb-ship/ (receipt.commonDir from the
// cwd):
//   <sha>.log        one line per event, `<ISO time> <stage> <text>`, the
//                    stage one of STAGES. At most one line is a result line,
//                    `result <state> <text>` with the state one of
//                    RESULT_STATES; only setResult writes it, and line
//                    writes nothing after it but an ack.
//   <sha>.json       the manifest: {sha, base, started_at, pid, docs_only,
//                    touches_server, touches_client, commits: [{sha,
//                    subject}], gate, push_started_at, push_unknown_at,
//                    pushed_at, watch_started_at, result: {state, text, at}
//                    | null, last_stage, last_stage_at, watch}. open writes
//                    every key: started_at its own time, pid the opener's
//                    process id (an integer), the fields it was given, and
//                    null for the rest. gate and watch hold what setManifest
//                    stores there; push_started_at, push_unknown_at and
//                    pushed_at are stamps setManifest writes;
//                    watch_started_at is written only by claimWatch.
//   <sha>.watch.log  the post-ship watch's own log, in the same line format,
//                    at most one result line in it.
//   last             the full sha of the latest record open started.
// A prior attempt that open moves aside keeps its files as
// <sha>.prev-<epoch ms>.log, .json and .watch.log.
//
// The resolve: every call that names a ship takes any ref that names a
// commit (a sha7 included) and resolves it through markers' status-carrying
// resolve; the full sha is the file key. A ref that names no commit throws
// SHIP_NO_COMMIT only on a clean miss (markers.cleanMiss: git said no such
// commit and every pack it reads from is readable); any other failure throws
// SHIP_RESOLVE_FAILED. A manifest whose stored sha is not its file's sha is
// refused wherever it is read.
//
// Set has one meaning for every manifest key the module reads: present and
// not null. An empty string, 0 or false is set; no rule reads a key as truthy.
//
// A result stands when the manifest's result is set or ANY line of the log
// is a result line. No text can forge or block one: the stage word is the
// second token of a line, and every text is flattened to one line first.
//
// The writers, each write to a ship's files under that sha's lock file
// (markers.withLock):
//   open(sha, {..., offOrigin}) starts a record. Three guards, in this
//     order, each throwing with nothing moved or written:
//     SHIP_ALREADY_OK when the prior record pushed (its pushed_at is set,
//     whatever its result, or ANY line of its log is a `result ok` line);
//     SHIP_PUSHED_ELSEWHERE when the prior result is pushed-elsewhere (the
//     manifest's, or such a line anywhere in its log), unless offOrigin is
//     true; SHIP_UNSETTLED when the prior push started (push_started_at set)
//     with no result standing, unless offOrigin is true. offOrigin true is
//     the caller's word that it fetched origin/main and the sha is not on
//     it. Otherwise a prior attempt moves aside whole, and open writes an
//     empty log, the manifest and last.
//   line(sha, stage, text) appends one event to the ship log and records
//     last_stage and last_stage_at in the manifest. It never writes a
//     result (SHIP_RESULT_VIA_SETRESULT), and once a result stands it writes
//     only an ack: any other stage throws SHIP_LINE_AFTER_RESULT with
//     nothing written.
//   setResult(sha, state, text) writes the result line and the manifest's
//     result together, once: when a result already stands it writes nothing
//     and returns false. Three guards throw and write nothing: an ok result
//     needs pushed_at set first (SHIP_OK_NEEDS_PUSH) and then a watch claim,
//     watch_started_at set (SHIP_OK_NEEDS_CLAIM); and once pushed_at is set
//     ok is the only result (SHIP_RESULT_AFTER_PUSH).
//   setManifest(sha, patch) merges the masked patch shallowly and returns
//     the manifest. It refuses `result` (SHIP_RESULT_VIA_SETRESULT),
//     `watch_started_at` (SHIP_WATCH_VIA_CLAIM), a `sha` that is not the
//     literal key naming this record's sha, and, once a result stands,
//     `push_started_at`, `pushed_at` and `push_unknown_at`, null included
//     (SHIP_STAMP_AFTER_RESULT: no push stamp lands on a settled record),
//     each read from the cleaned key and writing nothing.
//   watchLine(sha, stage, text) appends one line to the watch log; a result
//     line when a line of the watch log already is one returns false,
//     unwritten.
//   claimWatch(sha) is the one way a watch spawn is authorized, a settled ok
//     record's included (the re-watch). Its stamp is fresh when it is a
//     zoned time within WATCH_CLAIM_STALE_MS (60 seconds) of the clock,
//     either side. Any other set stamp is stale: one that is not a zoned
//     time, or a zoned time further off either way, since claimWatch writes
//     only the current Z time and neither shape can be a claim made this
//     minute. It answers one of three words, never a boolean:
//     'claimed'  it stamped watch_started_at now: the stamp was null; or the
//                watch never started (a stale stamp and no non-blank line in
//                the watch log); or the watch died (the watch log holds
//                non-blank lines but no result line, its last write, the
//                mtime, is older than WATCH_DEAD_MS, 60 minutes, and the
//                stamp is stale).
//     'started'  the stamp is set and the manifest's watch is set (the
//                watch recorded its result through setManifest), whatever
//                the watch log says; or the watch log holds a non-blank line
//                and the watch did not die by that rule; a result line
//                anywhere in it is a watch that started and finished.
//     'pending'  the stamp is fresh and no watch has written since it: no
//                non-blank line; or a died watch's lines (a re-claim just
//                made, its watch not yet written).
//     Only 'claimed' stamps, under the per-sha lock; a watch log that cannot
//     be read throws with nothing stamped. What makes a claim provable is
//     the watch lane's contract: the watch's first act is watchLine(sha,
//     'start', ...), so a watch that started has a line inside the minute,
//     and WATCH_DEAD_MS is above the longest run the plan's watch windows
//     allow. The plan's ship contract spawns a watch only on 'claimed',
//     leaves a completion that got 'pending' unsettled, and re-claims the
//     unwatched() records in its opening pass.
//
// The readers write nothing:
//   readManifest(sha) is the manifest, or null when there is none; a file
//     that is not a JSON object, or names another sha, throws.
//   readLast() is the sha last holds, or null when there is no file or it
//     holds no full sha; any other read error throws.
//   tail(sha, n) is the last n lines of the ship log, oldest first; [] when
//     there is no log.
//   inFlight() is the ship running now, or null. When last names a readable
//     manifest, that record is the one: with a result standing or
//     push_unknown_at set, nothing is in flight. Only when last is absent,
//     cannot be read or names no readable manifest is it the newest readable
//     record by started_at. That record is in flight while no result stands
//     for it, push_unknown_at is not set, its ship is alive (its pid, a
//     positive integer, answers kill 0 without ESRCH; EPERM counts as alive)
//     and its log was written within two hours (the cap against a reused
//     pid). A record with no such pid (an older one) has the two-hour rule
//     alone.
//   unsettled({all}) is every record with no result standing whose
//     push_started_at is set, as {sha, state, since, manifest}: state
//     `pushed` when pushed_at is set, else `unknown`; since is
//     push_unknown_at when set, else pushed_at when set, else
//     push_started_at. A manifest that cannot be read (not JSON, not an
//     object, naming another sha, a read error) is listed as {sha,
//     unreadable: true, path}, the sha from its file name, never passed
//     over. Every unreadable entry comes first, then the rest oldest
//     started_at first (one whose started_at is null, absent or not a zoned
//     time sorts as oldest). The record inFlight() returns is left out
//     unless all is true.
//   unwatched() is every readable record that ended ok (its manifest's
//     result.state is ok, or a line of its log is a `result ok` line) with
//     watch_started_at set and a claim claimWatch would take again, as {sha,
//     state, since, last_write, manifest}: state `never-started` or `died`
//     by claimWatch's rules, since the watch_started_at stamp, last_write
//     the watch log's last write (its mtime) as a Z time for a died entry
//     and null for a never-started one. setResult writes ok only over a
//     claim, so an ok record it wrote always carries one. Oldest since
//     first; a since that is not a zoned time sorts as oldest. Nothing in
//     flight is ok, so nothing is left out for it. An unreadable manifest
//     is passed over (unsettled lists it); a watch log that cannot be read
//     throws.
//
// Masking: every text written to either log, and every string a manifest
// gets (open's fields and setManifest's patch, nested objects and arrays
// included, and every object key), passes through markers.clean: control
// characters and the Unicode line separators flattened, piiShapes.mask with
// no path (the allowlisted mode the static pre-step runs, at the code-path
// class), then the cap. Every rule reads the CLEANED key, the name the value
// is stored under: the reserved names (setManifest refuses `result` and
// `watch_started_at`, and a `sha` that is not the literal key or names
// another sha), the shape families below, and by_issue, whose all-digit keys
// (Sentry issue ids) pass raw. A key whose masked form collides with another
// key in the same object gets a ` #2`, ` #3` suffix, so no value is lost.
// Every object is built with a null prototype, so an own `__proto__` key is
// stored as a property. Three key families are judged by the shape of their
// value, at any depth:
//   sha keys   sha, base, and any key holding "sha": a full 40- or 64-hex
//              sha passes raw; anything else is masked like any string.
//   time keys  started_at, push_started_at, push_unknown_at, pushed_at,
//              watch_started_at, last_stage_at, deploy_at, finished_at, at:
//              null, or a zoned ISO time that names a real instant
//              (markers.isZonedTime: no February 30) stored normalized to Z;
//              anything else is refused (SHIP_BAD_TIME), never stored, so
//              every stamp inFlight and unsettled order by is a Z time.
//   path keys  receipt, log, path: a path with no whitespace, no control
//              character and no `?` keeps its full-sha runs and has every
//              other shape in it masked (a UUID, an email, a phone); a value
//              of any other form is masked like any string.
// Anywhere else a full 40-hex sha is token-shaped and masks, and a ten-digit
// id can read as a phone number, so texts carry sha7 and the watch logs
// counts, not ids.
//
// Durability: the manifest, last and the two logs are written through this
// module's own writers. The manifest and last keep receipt.writeJsonAtomic's
// shape (a temp file, then rename; the manifest in the same bytes), with the
// temp file fsynced before the rename and the directory after it; a log line
// is fsynced after its append, and a log the append created has its
// directory fsynced too; open's new empty log is fsynced, and its moves
// aside are followed by a directory fsync. So a stamp written before a step
// that depends on it is on disk before that step starts. fsyncSeam.sync is a
// TEST-ONLY seam: every fsync goes through it with the path it syncs, so a
// test can record the calls; nothing else replaces it.

const fs = require('fs');
const path = require('path');
const R = require('./receipt');
const { withLock, pidAlive, clean, isZonedTime, seams, cleanMiss } = require('./markers');
const { mask } = require('./piiShapes');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STAGES = Object.freeze(['start', 'fetch', 'range', 'receipts', 'revert', 'gate', 'push', 'watch', 'ack', 'result']);
// ok-no-push: the flow ran to the push and stopped there (--no-push), so the
// sha was never pushed and its real ship may follow.
const RESULT_STATES = Object.freeze(['ok', 'ok-no-push', 'refused', 'failed', 'pushed-elsewhere']);
const IN_FLIGHT_MS = 2 * 60 * 60 * 1000;
// A zoned claim stamp within this of the clock, either side, is fresh (a
// claim made this minute); any other set stamp is stale, and a stale claim
// whose watch never started or died may be claimed again.
const WATCH_CLAIM_STALE_MS = 60 * 1000;
// A watch log with lines, no result line and no write for this long is a
// watch that died: above the longest run the plan's watch windows allow.
const WATCH_DEAD_MS = 60 * 60 * 1000;
// The push stamps setManifest writes, refused once a result stands.
const STAMP_KEYS = new Set(['push_started_at', 'pushed_at', 'push_unknown_at']);
const MANIFEST_NAME = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\.json$/;
const RESULT_LINE = /^\S+ result(?: |$)/; // one line at a time, never a whole file
const OK_LINE = /^\S+ result ok(?: |$)/; // never matches ok-no-push
const ELSEWHERE_LINE = /^\S+ result pushed-elsewhere(?: |$)/;
const ANY_TEXT = /\S/;
const SHA_KEYS = new Set(['sha', 'base']);
const TIME_KEYS = new Set(['started_at', 'push_started_at', 'push_unknown_at', 'pushed_at', 'watch_started_at', 'last_stage_at', 'deploy_at', 'finished_at', 'at']);
const PATH_KEYS = new Set(['receipt', 'log', 'path']);
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHA_RUN = /((?<![0-9a-f])[0-9a-f]{40}(?:[0-9a-f]{24})?(?![0-9a-f]))/;
const PATH_SHAPE = /^[^\s?\x00-\x1f\x7f\x85]+$/;

function namedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function shipDir(cwd) {
  return path.join(R.commonDir({ cwd }), 'drb-ship');
}

// Through markers' status-carrying resolve (and its test-only seam): only a
// clean miss (markers.cleanMiss) is SHIP_NO_COMMIT; anything else, an
// unreadable pack included, is SHIP_RESOLVE_FAILED.
function resolveSha(ref, cwd) {
  try {
    return seams.resolve(ref, cwd === undefined ? REPO_ROOT : cwd);
  } catch (err) {
    if (cleanMiss(err, { cwd })) throw namedError(`shipLog: ${JSON.stringify(clean(String(ref)))} names no commit in this repo`, 'SHIP_NO_COMMIT');
    const status = err && err.status !== null && err.status !== undefined ? err.status : 'none, git did not run';
    throw namedError(`shipLog: git could not resolve ${JSON.stringify(clean(String(ref)))} (status ${status})`, 'SHIP_RESOLVE_FAILED');
  }
}

function pathsFor(dir, full) {
  const manifest = path.join(dir, `${full}.json`);
  return {
    sha: full,
    dir,
    log: path.join(dir, `${full}.log`),
    manifest,
    watchLog: path.join(dir, `${full}.watch.log`),
    last: path.join(dir, 'last'),
    lock: `${manifest}.lock`,
  };
}

function shipPaths(sha, { cwd } = {}) {
  return pathsFor(shipDir(cwd), resolveSha(sha, cwd));
}

const isShaKey = (key) => typeof key === 'string' && (SHA_KEYS.has(key) || /sha/i.test(key));

// A time key's value: null, or a zoned ISO time normalized to Z; else refused.
function normalTime(value, key) {
  if (value === null) return null;
  if (isZonedTime(value)) return new Date(value).toISOString();
  throw namedError(`shipLog: ${key} must be an ISO time with a zone (Z or +HH:MM) or null`, 'SHIP_BAD_TIME');
}

// A path key's value: its full-sha runs kept, every other shape masked.
function maskPathValue(value) {
  if (!PATH_SHAPE.test(value)) return clean(value);
  return value.split(SHA_RUN).map((part, i) => (i % 2 === 1 ? part : mask(part))).join('');
}

// Every string and every key masked, by the shape rules in the header. `key`
// is the cleaned key the value is stored under.
function maskDeep(value, key) {
  if (typeof key === 'string' && TIME_KEYS.has(key)) return normalTime(value, key);
  if (typeof value === 'string') {
    if (isShaKey(key) && FULL_SHA.test(value)) return value;
    if (typeof key === 'string' && PATH_KEYS.has(key)) return maskPathValue(value);
    return clean(value);
  }
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, key));
  if (value && typeof value === 'object') {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      const base = key === 'by_issue' && /^[0-9]+$/.test(k) ? k : clean(k);
      let name = base;
      for (let n = 2; Object.prototype.hasOwnProperty.call(out, name); n++) name = `${base} #${n}`;
      out[name] = maskDeep(v, base);
    }
    return out;
  }
  return value;
}

// ---- the durable writers -------------------------------------------------------

// TEST-ONLY seam (see the header): every fsync here goes through sync, with
// the path of the file or directory it syncs.
const fsyncSeam = { sync: (fd) => fs.fsyncSync(fd) };

function syncPath(target, flags) {
  const fd = fs.openSync(target, flags);
  try {
    fsyncSeam.sync(fd, target);
  } finally {
    fs.closeSync(fd);
  }
}

const syncDir = (dir) => syncPath(dir, 'r');

// receipt.writeJsonAtomic's shape (a temp file, then rename), the temp file
// fsynced before the rename and the directory after it.
function writeTextDurable(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text);
    fsyncSeam.sync(fd, tmp);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  syncDir(dir);
}

// The same bytes receipt.writeJsonAtomic writes.
const writeJsonDurable = (file, value) => writeTextDurable(file, `${JSON.stringify(value, null, 2)}\n`);

// Appends `text` and fsyncs the file; a file this append created has its
// directory fsynced too, so its name is on disk with its first line.
function appendDurable(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let created = true;
  let fd;
  try {
    fd = fs.openSync(file, 'ax');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    created = false;
    fd = fs.openSync(file, 'a');
  }
  try {
    fs.writeFileSync(fd, text);
    fsyncSeam.sync(fd, file);
  } finally {
    fs.closeSync(fd);
  }
  if (created) syncDir(dir);
}

// An empty file, fsynced; the caller fsyncs its directory.
const createEmptyDurable = (file) => syncPath(file, 'w');

// ---- reading -------------------------------------------------------------------

// The manifest in `file`, or null when there is none. A file that is not a
// JSON object, or that names another sha, is refused by its path.
function readManifestFile(file, full) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON; fix or move it`);
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`${file} is not a manifest object; fix or move it`);
  if (m.sha !== full) throw new Error(`${file} does not name its own sha; fix or move it`);
  return m;
}

// True when any line of the log matches `re` (RESULT_LINE, OK_LINE, which
// never matches ok-no-push, ELSEWHERE_LINE, or ANY_TEXT); false when there is
// no log.
function anyLine(file, re) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
  return raw.split('\n').some((l) => re.test(l));
}

const isSet = (v) => v !== null && v !== undefined;

// A result stands: the manifest's, or a result line anywhere in the log.
const settled = (m, log) => isSet(m.result) || anyLine(log, RESULT_LINE);

// Appends one line and returns its time.
function appendLine(file, stage, text) {
  const at = new Date().toISOString();
  const body = clean(text);
  appendDurable(file, `${at} ${stage}${body ? ` ${body}` : ''}\n`);
  return at;
}

function checkStage(stage) {
  if (!STAGES.includes(stage)) throw new Error(`shipLog: unknown stage ${JSON.stringify(clean(String(stage)))} (stages: ${STAGES.join(', ')})`);
}

function moveAside(p) {
  const stamp = Date.now();
  let moved = false;
  for (const [file, ext] of [[p.log, 'log'], [p.manifest, 'json'], [p.watchLog, 'watch.log']]) {
    if (fs.existsSync(file)) {
      fs.renameSync(file, path.join(p.dir, `${p.sha}.prev-${stamp}.${ext}`));
      moved = true;
    }
  }
  if (moved) syncDir(p.dir);
}

// ---- the writers ---------------------------------------------------------------

// offOrigin: the caller's word that it fetched origin/main and the sha is
// not on it; only then does a prior record whose result is pushed-elsewhere,
// or whose push started with no result, move aside.
function open(sha, { cwd, base = null, commits = [], docs_only = null, touches_server = null, touches_client = null, offOrigin = false } = {}) {
  const p = shipPaths(sha, { cwd });
  const manifest = maskDeep({
    sha: p.sha,
    base,
    started_at: new Date().toISOString(),
    pid: process.pid,
    docs_only,
    touches_server,
    touches_client,
    commits: (commits || []).map((c) => ({ sha: String(c.sha), subject: String(c.subject === undefined || c.subject === null ? '' : c.subject) })),
    gate: null,
    push_started_at: null,
    push_unknown_at: null,
    pushed_at: null,
    watch_started_at: null,
    result: null,
    last_stage: null,
    last_stage_at: null,
    watch: null,
  });
  fs.mkdirSync(p.dir, { recursive: true });
  withLock(p.lock, () => {
    const prior = readManifestFile(p.manifest, p.sha);
    if ((prior && isSet(prior.pushed_at)) || anyLine(p.log, OK_LINE)) {
      throw namedError(`shipLog: the ship of ${R.short(p.sha)} already pushed; nothing to start`, 'SHIP_ALREADY_OK');
    }
    const elsewhere = Boolean(prior && prior.result && prior.result.state === 'pushed-elsewhere') || anyLine(p.log, ELSEWHERE_LINE);
    if (elsewhere && offOrigin !== true) {
      throw namedError(`shipLog: ${R.short(p.sha)} was found on origin/main (pushed-elsewhere); a new record needs the caller's word that it left origin`, 'SHIP_PUSHED_ELSEWHERE');
    }
    if (prior && isSet(prior.push_started_at) && !settled(prior, p.log) && offOrigin !== true) {
      throw namedError(`shipLog: the push of ${R.short(p.sha)} started and has no result; run ship again, which completes the record from its evidence`, 'SHIP_UNSETTLED');
    }
    moveAside(p);
    createEmptyDurable(p.log);
    writeJsonDurable(p.manifest, manifest); // its directory fsync covers the new log's name
  });
  writeTextDurable(p.last, `${p.sha}\n`);
  return { log: p.log, manifest: p.manifest };
}

function openManifest(p) {
  const m = readManifestFile(p.manifest, p.sha);
  if (!m) throw namedError(`shipLog: no manifest for ${R.short(p.sha)}; open the ship first`, 'SHIP_NOT_OPEN');
  return m;
}

// One event in the ship log, and the manifest's last stage. Never a result.
function line(sha, stage, text, { cwd } = {}) {
  checkStage(stage);
  if (stage === 'result') throw namedError('shipLog: a result is written by setResult, never by line', 'SHIP_RESULT_VIA_SETRESULT');
  const p = shipPaths(sha, { cwd });
  return withLock(p.lock, () => {
    const m = openManifest(p);
    if (stage !== 'ack' && settled(m, p.log)) throw namedError(`shipLog: a result stands for ${R.short(p.sha)}; only an ack line follows it, never ${stage}`, 'SHIP_LINE_AFTER_RESULT');
    const at = appendLine(p.log, stage, text);
    writeJsonDurable(p.manifest, { ...m, last_stage: stage, last_stage_at: at });
    return true;
  });
}

// The result line and the manifest's result together; false, with nothing
// written, when a result already stands (the manifest's, or a result line
// anywhere in the log). ok needs pushed_at, then a watch claim; once
// pushed_at is set, ok is the only result.
function setResult(sha, state, text, { cwd } = {}) {
  if (!RESULT_STATES.includes(state)) throw new Error(`shipLog: a result state is one of ${RESULT_STATES.join(', ')}`);
  const p = shipPaths(sha, { cwd });
  return withLock(p.lock, () => {
    const m = openManifest(p);
    if (settled(m, p.log)) return false;
    if (state === 'ok' && !isSet(m.pushed_at)) throw namedError(`shipLog: an ok result for ${R.short(p.sha)} needs pushed_at set first; a dry run ends ok-no-push`, 'SHIP_OK_NEEDS_PUSH');
    if (state === 'ok' && !isSet(m.watch_started_at)) throw namedError(`shipLog: an ok result for ${R.short(p.sha)} needs a watch claim first (claimWatch)`, 'SHIP_OK_NEEDS_CLAIM');
    if (state !== 'ok' && isSet(m.pushed_at)) throw namedError(`shipLog: the push of ${R.short(p.sha)} landed (pushed_at is set); its only result is ok, never ${state}`, 'SHIP_RESULT_AFTER_PUSH');
    const t = clean(text);
    const at = appendLine(p.log, 'result', t ? `${state} ${t}` : state);
    writeJsonDurable(p.manifest, { ...m, result: { state, text: t, at }, last_stage: 'result', last_stage_at: at });
    return true;
  });
}

// One line in the watch log; a second result line (a result line anywhere in
// the watch log already) returns false, unwritten.
function watchLine(sha, stage, text, { cwd } = {}) {
  checkStage(stage);
  const p = shipPaths(sha, { cwd });
  return withLock(p.lock, () => {
    if (stage === 'result' && anyLine(p.watchLog, RESULT_LINE)) return false;
    appendLine(p.watchLog, stage, text);
    return true;
  });
}

// The watch log's text and its last write, read through one descriptor;
// {text: '', mtime: null} when there is none. Any other read error throws.
function readWatchLog(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err.code === 'ENOENT') return { text: '', mtime: null };
    throw err;
  }
  try {
    return { text: fs.readFileSync(fd, 'utf8'), mtime: fs.fstatSync(fd).mtimeMs };
  } finally {
    fs.closeSync(fd);
  }
}

// Where a record's watch claim stands, by the header's rules, as {state,
// mtime}: state 'unclaimed' (no stamp), 'never-started' or 'died'
// (claimWatch claims again), 'started' or 'pending' (it stamps nothing);
// mtime the watch log's last write when the log was read, else null. A watch
// log that cannot be read throws.
function watchState(m, watchLog, now = Date.now()) {
  if (!isSet(m.watch_started_at)) return { state: 'unclaimed', mtime: null };
  // The watch recorded its result in the manifest: it finished, whatever its log holds.
  if (isSet(m.watch)) return { state: 'started', mtime: null };
  const at = isZonedTime(m.watch_started_at) ? Date.parse(m.watch_started_at) : NaN;
  // Fresh: a zoned stamp within the minute either side of the clock, the only
  // shape a claim made this minute has; any other set stamp is stale.
  const fresh = Number.isFinite(at) && Math.abs(now - at) <= WATCH_CLAIM_STALE_MS;
  const { text, mtime } = readWatchLog(watchLog);
  const lines = text.split('\n');
  if (!lines.some((l) => ANY_TEXT.test(l))) return { state: fresh ? 'pending' : 'never-started', mtime };
  if (lines.some((l) => RESULT_LINE.test(l)) || !(now - mtime > WATCH_DEAD_MS)) return { state: 'started', mtime };
  // A died watch's lines under a fresh claim: the watch that claim spawned
  // has not written yet, so the claim is not taken twice.
  return { state: fresh ? 'pending' : 'died', mtime };
}

// The one authorization of a watch spawn, under the per-sha lock: 'claimed'
// with watch_started_at stamped now, or 'started' or 'pending' with nothing
// stamped (the rules are in the header).
function claimWatch(sha, { cwd } = {}) {
  const p = shipPaths(sha, { cwd });
  return withLock(p.lock, () => {
    const m = openManifest(p);
    const { state } = watchState(m, p.watchLog);
    if (state === 'started' || state === 'pending') return state;
    writeJsonDurable(p.manifest, { ...m, watch_started_at: new Date().toISOString() });
    return 'claimed';
  });
}

function readManifest(sha, { cwd } = {}) {
  const p = shipPaths(sha, { cwd });
  return readManifestFile(p.manifest, p.sha);
}

// Shallow merge of the masked patch into the manifest; returns the result.
function setManifest(sha, patch, { cwd } = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError('setManifest: patch must be an object');
  const p = shipPaths(sha, { cwd });
  // The reserved names, read from the cleaned key the value would land under.
  let stamps = false;
  for (const [k, v] of Object.entries(patch)) {
    const name = clean(k);
    if (name === 'result') throw namedError('setManifest: a result is written by setResult', 'SHIP_RESULT_VIA_SETRESULT');
    if (name === 'watch_started_at') throw namedError('setManifest: watch_started_at is written by claimWatch', 'SHIP_WATCH_VIA_CLAIM');
    if (name === 'sha' && (k !== 'sha' || v !== p.sha)) throw new Error('setManifest: a manifest keeps its sha');
    if (STAMP_KEYS.has(name)) stamps = true;
  }
  const masked = maskDeep(patch);
  return withLock(p.lock, () => {
    const m = openManifest(p);
    if (stamps && settled(m, p.log)) throw namedError(`setManifest: a result stands for ${R.short(p.sha)}; no push stamp is written to a settled record`, 'SHIP_STAMP_AFTER_RESULT');
    const next = { ...m, ...masked };
    writeJsonDurable(p.manifest, next);
    return JSON.parse(JSON.stringify(next)); // plain objects, as readManifest gives
  });
}

// ---- the readers ---------------------------------------------------------------

function readLast({ cwd } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(shipDir(cwd), 'last'), 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  return R.KEY_RE.test(raw) ? raw : null;
}

// The last n lines of the ship log, oldest first; [] when there is no log.
function tail(sha, n = 15, { cwd } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(shipPaths(sha, { cwd }).log, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const lines = raw.split('\n').filter((l) => l !== '');
  return n > 0 ? lines.slice(-n) : [];
}

// Every manifest under drb-ship as {sha, m, when}, `when` its started_at as a
// number (-Infinity for one that is not a zoned time), and every file that
// cannot be read as one (not JSON, not an object, naming another sha, a read
// error) as {sha, unreadable: true, path, when: -Infinity}, the sha from its
// file name. Read by file key with no git call, so a full directory stays
// quick at session start.
function manifests(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names) {
    const hit = MANIFEST_NAME.exec(name);
    if (!hit) continue;
    const file = path.join(dir, name);
    let m;
    try {
      m = readManifestFile(file, hit[1]);
    } catch {
      out.push({ sha: hit[1], unreadable: true, path: file, when: -Infinity });
      continue;
    }
    if (!m) continue;
    const at = isZonedTime(m.started_at) ? Date.parse(m.started_at) : NaN;
    out.push({ sha: m.sha, m, when: Number.isFinite(at) ? at : -Infinity });
  }
  return out;
}

// The time lane-status prints beside an unsettled record.
const sinceOf = (m) => (isSet(m.push_unknown_at) ? m.push_unknown_at : isSet(m.pushed_at) ? m.pushed_at : m.push_started_at);

// Every record with no result standing whose push_started_at is set: every
// unreadable entry first, then oldest started_at first. The record inFlight
// returns is left out unless all is true.
function unsettled({ cwd, all = false } = {}) {
  const dir = shipDir(cwd);
  const live = all === true ? null : inFlight({ cwd });
  return manifests(dir)
    .filter((e) => e.unreadable || (isSet(e.m.push_started_at) && !settled(e.m, pathsFor(dir, e.sha).log) && !(live && live.sha === e.sha)))
    .sort((a, b) => (b.unreadable === true) - (a.unreadable === true) || (a.when === b.when ? 0 : a.when - b.when))
    .map((e) => (e.unreadable
      ? { sha: e.sha, unreadable: true, path: e.path }
      : { sha: e.sha, state: isSet(e.m.pushed_at) ? 'pushed' : 'unknown', since: sinceOf(e.m), manifest: e.m }));
}

// Every readable record that ended ok (the manifest's result, or a result ok
// line in its log, a setResult cut short) whose watch claim claimWatch would
// take again: never-started or died, a died one with its watch log's last
// write, oldest claim first (a stamp that is not a zoned time sorts as
// oldest). An unreadable manifest is passed over here; a watch log that
// cannot be read throws.
function unwatched({ cwd } = {}) {
  const dir = shipDir(cwd);
  const now = Date.now();
  const out = [];
  for (const e of manifests(dir)) {
    if (e.unreadable) continue;
    const p = pathsFor(dir, e.sha);
    const ok = (isSet(e.m.result) && e.m.result.state === 'ok') || anyLine(p.log, OK_LINE);
    if (!ok) continue;
    const { state, mtime } = watchState(e.m, p.watchLog, now); // 'unclaimed' when no stamp is set
    if (state !== 'never-started' && state !== 'died') continue;
    const at = isZonedTime(e.m.watch_started_at) ? Date.parse(e.m.watch_started_at) : NaN;
    const lastWrite = state === 'died' ? new Date(mtime).toISOString() : null;
    out.push({ entry: { sha: e.sha, state, since: e.m.watch_started_at, last_write: lastWrite, manifest: e.m }, when: Number.isFinite(at) ? at : -Infinity });
  }
  return out.sort((a, b) => (a.when === b.when ? 0 : a.when - b.when)).map((x) => x.entry);
}

// The ship in flight, or null. Ships run one at a time under the ship lock,
// and last names the latest one open started, so its record is the only one
// that can be in flight; the newest readable record by started_at stands in
// only when last is absent, cannot be read or names no readable manifest.
// That record is in flight when no result stands for it, push_unknown_at is
// not set (that ship ended), its ship is alive, and the log was written to
// within two hours (the cap against a reused pid). Alive: its pid answers
// kill 0 without ESRCH. Only a positive integer is probed (0 and a negative
// pid name a process group); a record with no such pid, an older one, has
// the two-hour rule alone.
function inFlight({ cwd, now = Date.now() } = {}) {
  const dir = shipDir(cwd);
  let lastSha = null;
  try {
    lastSha = readLast({ cwd });
  } catch {
    lastSha = null; // a last that cannot be read: the newest record stands in
  }
  const readable = manifests(dir).filter((e) => !e.unreadable);
  const named = lastSha === null ? undefined : readable.find((e) => e.sha === lastSha);
  let rec = named ? named.m : null;
  if (!named) {
    let newestAt = -Infinity;
    for (const { m, when } of readable) {
      if (!rec || when > newestAt) {
        rec = m;
        newestAt = when;
      }
    }
  }
  if (!rec || isSet(rec.push_unknown_at)) return null;
  if (Number.isInteger(rec.pid) && rec.pid > 0 && !pidAlive(rec.pid)) return null;
  const p = pathsFor(dir, rec.sha);
  if (settled(rec, p.log)) return null;
  let mtime;
  try {
    mtime = fs.statSync(p.log).mtimeMs;
  } catch {
    return null;
  }
  return now - mtime > IN_FLIGHT_MS ? null : rec;
}

module.exports = {
  STAGES,
  RESULT_STATES,
  open,
  line,
  setResult,
  watchLine,
  claimWatch,
  setManifest,
  readManifest,
  readLast,
  tail,
  inFlight,
  unsettled,
  unwatched,
  shipPaths,
  fsyncSeam,
};
