'use strict';

// The ship phase's own records (instruction rewrite step 5, lane merge-ship):
// the run log merge-lane.sh ship writes, its stdio sibling and the phase
// manifest, written by scripts/lib/mergeShip.js; scripts/lane-status.js reads
// the manifests through phaseLines. No CLI.
//
// The files, under <git-common-dir>/drb-ship/, keyed on the lane tip the
// check judged (the branch tip for a resume):
//   <tip>.log         one line per step, `<ISO time> <step> <text>`, the text
//                     through markers.clean on one line; its last line is
//                     the run's one `result <state> <text>`.
//   <tip>.stdio.log   the detached run's raw stdout and stderr.
//   phase/<tip>.done-<epoch ms>.json  a manifest phaseLines retired.
//   phase/<tip>.json  the manifest: {version, lane, tip, started_at, pid,
//                     step, step_at, state, squash, result, ended_at, log,
//                     kept}: state running until the run ends, then the
//                     result's state (ok, ok-no-push, pushed-elsewhere,
//                     refused, stale, failed or unknown);
//                     step the step of the run's latest line and step_at when
//                     that step began; kept, null until a cleanup after a push
//                     keeps the branch for what the squash may not hold, then
//                     the words the result carries for it.
// One run, one log: moveAside, called by the run's launcher under the ship
// lock before the run starts, renames a prior run's files to
// <tip>.prev-<epoch ms>.log, <tip>.prev-<epoch ms>.stdio.log and
// phase/<tip>.prev-<epoch ms>.json (shipLog's open does the same for its
// records), so a re-ship of the same tip starts on an empty log. A run writes
// its log through the descriptor it opened (openLog, writeLine), so a line it
// writes after a later run moved its log aside lands in the moved file, never
// in the new log; appendLine writes by path, for a child of the run that
// holds the ship lock meanwhile. A Phase writes the whole manifest at start,
// and later merges a patch only while the file on disk is its run's (its pid
// and started_at), so a run whose files a later run moved aside never
// overwrites the new manifest; each write is a temp file renamed into place.
//
// Kept apart from shipLog's records, which share drb-ship/: the manifests sit
// in the sub-directory phase/, while shipLog's enumeration (and lane-status's
// last-record read) is a readdir of drb-ship/ alone that keeps only names of
// the form <sha>.json, which the directory entry phase never is; the run logs
// are keyed on lane tips, never on a commit shipLog records (a squash).
//
// phaseLines({cwd, max}) is lane-status's read of the current manifests
// (phase/<sha>.json): one line for the newest run in flight (state running,
// its pid alive), `ship phase: <lane> at <tip7>, <step> since <time>`; then a
// line naming each manifest that cannot be read, and one line per lane whose
// latest manifest (by its start) ended other than ok or carries kept, until a
// later run of that lane, newest first: `ship phase: <lane> at <tip7> ended
// <state> at <ended_at>: <result>` (an ok run's `...: <kept>`), or `... ended
// failed: its run is gone with no result, last step <step> at <time>` for a
// running manifest whose pid is gone. Of these at most max are shown
// (lane-status's session start passes three), and `ship phase: ... <n> more;
// run npm run lane:status` stands for the rest, which no git call reads. A
// shown line costs at most three git calls. For a manifest naming a squash: one
// git merge-base --is-ancestor against refs/remotes/origin/main (resolved
// once), and, the squash not in its history, one git log of origin/main since
// the run's start for a commit whose subject opens merge(lane <lane>): (the
// replay the push-rejection ending names rewrites the squash's sha; a squash of
// an earlier lane of the same name is older than the run). Either reads in
// place of the result, with no resume advice, `the squash <sha7> has since
// reached origin` or `a squash of the lane has since reached origin as <sha7>`
// (pushed by this run or another way, as a dry run's squash pushed by hand
// is), the kept words beside it. Then one read of the lane's branch, for a
// squash that reached origin and for a manifest naming none (a run that ended
// before any, its line then `...: <result>; the branch is gone`): with the
// branch gone the line is shown this once and the lane retires, each current
// manifest of the lane that started no later moving to
// phase/<tip>.done-<epoch ms>.json (its pid and start read again first, so a
// run that took the file since keeps it), out of every later read. A manifest that vanished between
// the directory read and its own (another read retired it, a run moved it
// aside) is already gone: no line, as for a rename that meets the same. Every
// text through markers.clean.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('./receipt');
const M = require('./markers');

const CURRENT = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\.json$/;
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');
const isSet = (v) => v !== null && v !== undefined;

function paths(cwd, tip) {
  const dir = path.join(R.commonDir({ cwd }), 'drb-ship');
  const phaseDir = path.join(dir, 'phase');
  return { dir, phaseDir, log: path.join(dir, `${tip}.log`), stdio: path.join(dir, `${tip}.stdio.log`), phase: path.join(phaseDir, `${tip}.json`) };
}

const lineText = (step, text) => `${new Date().toISOString()} ${step} ${M.clean(oneLine(text))}\n`;

// One line appended by path.
function appendLine(file, step, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lineText(step, text));
}

// The run's own descriptor on its log, and a line through it.
function openLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return fs.openSync(file, 'a');
}
const writeLine = (fd, step, text) => fs.writeSync(fd, lineText(step, text));

// A prior run's files moved aside (header): where they moved, relative to
// drb-ship/.
function moveAside(cwd, tip) {
  const p = paths(cwd, tip);
  let ms = Date.now();
  const names = () => [[p.log, path.join(p.dir, `${tip}.prev-${ms}.log`)], [p.stdio, path.join(p.dir, `${tip}.prev-${ms}.stdio.log`)], [p.phase, path.join(p.phaseDir, `${tip}.prev-${ms}.json`)]];
  while (names().some(([, to]) => fs.existsSync(to))) ms += 1;
  const moved = [];
  for (const [from, to] of names()) {
    if (!fs.existsSync(from)) continue;
    fs.renameSync(from, to);
    moved.push(path.relative(p.dir, to));
  }
  return moved;
}

// A manifest file: the object, null when there is none, {unreadable: true}
// when it is not a JSON object.
function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return err.code === 'ENOENT' ? null : { unreadable: true };
  }
  try {
    const m = JSON.parse(raw);
    return m && typeof m === 'object' && !Array.isArray(m) ? m : { unreadable: true };
  } catch {
    return { unreadable: true };
  }
}

// The run's phase manifest (header).
class Phase {
  constructor({ cwd, tip, lane, log }) {
    this.file = paths(cwd, tip).phase;
    this.own = { version: 1, lane, tip, started_at: new Date().toISOString(), pid: process.pid };
    this.log = log;
  }

  start() {
    R.writeJsonAtomic(this.file, { ...this.own, step: 'start', step_at: this.own.started_at, state: 'running', squash: null, result: null, ended_at: null, log: this.log, kept: null });
  }

  // true when it wrote; false when the file is no longer this run's.
  write(patch) {
    const now = readJson(this.file);
    if (!now || now.unreadable || now.pid !== this.own.pid || now.started_at !== this.own.started_at) return false;
    R.writeJsonAtomic(this.file, { ...now, ...patch });
    return true;
  }
}

// lane-status's lines (header).
function phaseLines({ cwd = process.cwd(), max = Infinity } = {}) {
  const dir = paths(cwd, 'x').phaseDir;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const c = M.clean;
  const out = [];
  const torn = [];
  const runs = [];
  const at = (v) => (Number.isFinite(Date.parse(v)) ? Date.parse(v) : -Infinity);
  for (const name of names.sort()) {
    const hit = CURRENT.exec(name);
    if (!hit) continue;
    const file = path.join(dir, name);
    const m = readJson(file);
    if (m === null) continue; // moved since the readdir (a retirement, a move aside): already gone
    if (m.unreadable || m.tip !== hit[1]) {
      torn.push({ line: `ship phase: unreadable manifest ${file}; fix or move it` });
      continue;
    }
    const live = m.state === 'running' && Number.isInteger(m.pid) && m.pid > 0 && M.pidAlive(m.pid);
    runs.push({ m, file, live, started: at(m.started_at), ended: Math.max(at(m.ended_at), at(m.step_at), at(m.started_at)) });
  }
  const newest = (xs, k) => xs.reduce((a, b) => (!a || b[k] > a[k] ? b : a), null);
  const head = (m) => `ship phase: ${c(m.lane)} at ${R.short(m.tip)}`; // tip is the file name's sha
  const since = (m) => c(isSet(m.step_at) ? m.step_at : m.started_at);
  const flying = newest(runs.filter((r) => r.live), 'started');
  if (flying) out.push(`${head(flying.m)}, ${c(flying.m.step)} since ${since(flying.m)}`);
  const latest = new Map();
  for (const r of runs) {
    const was = latest.get(String(r.m.lane));
    if (!was || r.started > was.started) latest.set(String(r.m.lane), r);
  }
  const kept = (m) => (typeof m.kept === 'string' && m.kept ? c(m.kept) : null);
  const ended = [...latest.values()].filter((r) => !r.live && (r.m.state !== 'ok' || kept(r.m))).sort((a, b) => b.ended - a.ended);
  // Only the lines shown are read further: at most three git calls each (header).
  const listed = [...torn, ...ended];
  let origin;
  for (const x of listed.slice(0, max)) {
    if (x.line) {
      out.push(x.line);
      continue;
    }
    const { m } = x;
    const named = typeof m.squash === 'string' && R.KEY_RE.test(m.squash);
    if (origin === undefined && named) origin = originMain(cwd);
    let pushed = null;
    if (named && onOrigin(cwd, m.squash, origin)) pushed = `the squash ${R.short(m.squash)} has since reached origin`;
    else if (named) {
      const as = replayedOn(cwd, m, origin);
      if (as) pushed = `a squash of the lane has since reached origin as ${R.short(as)}`;
    }
    // A run that never squashed, of a lane whose branch is gone, retires too.
    const gone = (pushed || !named) && branchGone(cwd, m.lane);
    const tail = !named && gone ? '; the branch is gone' : '';
    const said = m.state === 'ok' ? kept(m) : pushed && kept(m) ? `${pushed}; ${kept(m)}` : pushed;
    if (m.state === 'running') out.push(`${head(m)} ended failed: ${said || `its run is gone with no result, last step ${c(m.step)} at ${since(m)}`}${tail}`);
    else out.push(`${head(m)} ended ${c(m.state)} at ${c(isSet(m.ended_at) ? m.ended_at : since(m))}: ${said || c(isSet(m.result) ? m.result : 'no result text')}${tail}`);
    if (gone) out.push(...retire(runs, x));
  }
  if (listed.length > max) out.push(`ship phase: ... ${listed.length - max} more; run npm run lane:status`);
  return out;
}

// Whether refs/heads/<lane> is gone (git says it is missing; a name git
// cannot take, or a git that fails, is not gone).
function branchGone(cwd, lane) {
  if (typeof lane !== 'string' || !lane || /[\0\n\r]/.test(lane)) return false;
  const r = spawnSync('git', ['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${lane}`], { cwd, env: R.gitEnv(), stdio: 'ignore' });
  return r.status === 1;
}

// The retirement (header): every current manifest of the run's lane that
// started no later than it moves to phase/<tip>.done-<epoch ms>.json, each
// only while the file still holds the manifest read (its pid and start), so
// a run that took the file since keeps it. The lines of a move that failed.
function retire(runs, r) {
  const said = [];
  for (const q of runs) {
    if (q.live || String(q.m.lane) !== String(r.m.lane) || q.started > r.started) continue;
    const now = readJson(q.file);
    if (!now || now.unreadable || now.pid !== q.m.pid || now.started_at !== q.m.started_at) continue;
    let ms = Date.now();
    const to = () => path.join(path.dirname(q.file), `${q.m.tip}.done-${ms}.json`);
    while (fs.existsSync(to())) ms += 1;
    try {
      fs.renameSync(q.file, to());
    } catch (err) {
      // ENOENT: another read retired it, or a run moved it aside, first.
      if (err.code !== 'ENOENT') said.push(`ship phase: could not retire ${q.file} (${err.code || 'error'}); it is shown again`);
    }
  }
  return said;
}

// refs/remotes/origin/main's sha, or null; and whether `squash` (a manifest
// field, so checked for shape first) is in its history.
function originMain(cwd) {
  try {
    return R.resolveCommit('refs/remotes/origin/main', { cwd });
  } catch {
    return null;
  }
}
function onOrigin(cwd, squash, origin) {
  if (!origin || typeof squash !== 'string' || !R.KEY_RE.test(squash)) return false;
  try {
    return R.isAncestor(squash, origin, { cwd });
  } catch {
    return false;
  }
}

// A commit of origin/main committed since the run started whose subject opens
// the lane's squash subject (a replay rewrites the squash's sha, header), or
// null: the lane name shape-checked and the start read as a time first, one
// git log, its failure null. A squash of an earlier lane of the same name is
// older than the run.
function replayedOn(cwd, m, origin) {
  const start = Date.parse(m.started_at);
  if (!origin || !Number.isFinite(start)) return null;
  try {
    R.checkName(m.lane);
  } catch {
    return null;
  }
  const needle = `merge(lane ${m.lane}): `;
  const r = spawnSync('git', ['log', '-F', `--grep=${needle}`, `--since=${new Date(start).toISOString()}`, '--format=%H%x09%s', origin, '--'], { cwd, env: R.gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (r.status !== 0) return null;
  const hit = r.stdout.split('\n').map((l) => l.split('\t')).find(([h, s]) => R.KEY_RE.test(h) && typeof s === 'string' && s.startsWith(needle));
  return hit ? hit[0] : null;
}

module.exports = { paths, appendLine, openLog, writeLine, moveAside, Phase, phaseLines };
