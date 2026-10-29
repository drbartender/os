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
//   phase/<tip>.json  the manifest: {version, lane, tip, started_at, pid,
//                     step, step_at, state, squash, result, ended_at, log}:
//                     state running until the run ends, then the result's
//                     state (ok, ok-no-push, cue-only, pushed-elsewhere,
//                     refused, stale, failed or unknown); step the step of the
//                     run's latest line and step_at when that step began.
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
// phaseLines({cwd}) is lane-status's read of the current manifests
// (phase/<sha>.json): one line for the newest run in flight (state running,
// its pid alive), `ship phase: <lane> at <tip7>, <step> since <time>`, and one
// line per lane whose latest manifest (by its start) ended other than ok,
// until a later run of that lane, newest first: `ship phase: <lane> at <tip7>
// ended <state> at <ended_at>: <result>`, or, when the manifest names a
// squash that is an ancestor of refs/remotes/origin/main (pushed by this run
// or another way, as every cue-only squash is before the flip), `... ended
// <state> at <ended_at>: the squash <sha7> is on origin since`, with no
// resume advice (that read is the one git call). A running manifest whose pid
// is gone ended with no result: `ended failed: its run is gone with no
// result, last step <step> at <time>` (or the on-origin text). A manifest
// that cannot be read is a line naming its file, first. Every text through
// markers.clean.

const fs = require('node:fs');
const path = require('node:path');
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
    R.writeJsonAtomic(this.file, { ...this.own, step: 'start', step_at: this.own.started_at, state: 'running', squash: null, result: null, ended_at: null, log: this.log });
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
function phaseLines({ cwd = process.cwd() } = {}) {
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
  const runs = [];
  const at = (v) => (Number.isFinite(Date.parse(v)) ? Date.parse(v) : -Infinity);
  for (const name of names.sort()) {
    const hit = CURRENT.exec(name);
    if (!hit) continue;
    const m = readJson(path.join(dir, name));
    if (!m || m.unreadable || m.tip !== hit[1]) {
      out.push(`ship phase: unreadable manifest ${path.join(dir, name)}; fix or move it`);
      continue;
    }
    const live = m.state === 'running' && Number.isInteger(m.pid) && m.pid > 0 && M.pidAlive(m.pid);
    runs.push({ m, live, started: at(m.started_at), ended: Math.max(at(m.ended_at), at(m.step_at), at(m.started_at)) });
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
  const origin = originMain(cwd);
  const ended = [...latest.values()].filter((r) => !r.live && r.m.state !== 'ok').sort((a, b) => b.ended - a.ended);
  for (const { m } of ended) {
    const pushed = onOrigin(cwd, m.squash, origin) ? `the squash ${R.short(m.squash)} is on origin since` : null;
    if (m.state === 'running') out.push(`${head(m)} ended failed: ${pushed || `its run is gone with no result, last step ${c(m.step)} at ${since(m)}`}`);
    else out.push(`${head(m)} ended ${c(m.state)} at ${c(isSet(m.ended_at) ? m.ended_at : since(m))}: ${pushed || c(isSet(m.result) ? m.result : 'no result text')}`);
  }
  return out;
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

module.exports = { paths, appendLine, openLog, writeLine, moveAside, Phase, phaseLines };
