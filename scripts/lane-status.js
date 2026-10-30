'use strict';

// lane-status: stale-lane detection + safe-scrap check for the build-in-lanes
// workflow (workflow-redesign).
//
//   node scripts/lane-status.js        # human-readable status report (CLI)
//   npm run lane:status                # same, via package.json
//   node scripts/lane-status.js --session-start
//                                      # the short report the SessionStart
//                                      # hook prints; always exits 0
//
// The SessionStart hook in .claude/settings.json runs --session-start after
// show-location.js at every session start; the plain CLI runs on demand.
//
// A "lane" is a linked git worktree on its own branch, cut off main, holding
// code only. This script lists the open lanes (excluding the primary/os
// worktree), cross-references docs/build-board.md, flags any lane that has gone
// stale, and reports whether a lane is safe to auto-scrap.
//
// A lane is STALE when ANY of these hold:
//   (a) older than 48h with no new commit on it,
//   (b) main has advanced 15+ commits since the lane was cut (merge-base),
//   (c) any sensitive path has landed on main since the lane was cut.
//
// Safe-scrap (the hard line, "never lose my code"): a lane may be auto-scrapped
// ONLY if `git log main..<lane-branch>` is empty (no distinct unmerged work).
// Scrap always uses `git branch -d` (which itself refuses unmerged), never -D.
// A non-empty lane is refused and Dallas must approve.
//
// Ahead of the lanes the report prints the markers and the ship record
// (instruction rewrite step 3, lane session-status; plan 2026-10-22
// decisions 6 and 7 and its lane-status.js contract). markersReport reads the
// flip state through markers.flipState and the two markers' lines through
// markers.standing, both markers whatever the flip state. shipReport reads
// the manifests under <git-common-dir>/drb-ship/ and the shipLog readers
// (inFlight, unsettled, unwatched), never the log's prose, and prints sha7.
// phaseReport (instruction rewrite step 5, lane merge-ship) prints the merge
// script's ship phase from its manifests under drb-ship/phase/, through
// scripts/lib/mergeShipLog.js's phaseLines: one line for a run in flight
// (its step and since when), one per manifest that cannot be read, and one
// per lane whose latest run ended other than ok, or ended ok carrying the
// manifest's kept (a cleanup after a push kept the branch for what the
// squash may not hold, or for a worktree holding it; the line reads the kept
// words), until a later run of that lane (its state, when it ended, and its
// result, or that its squash, or a replay of it, has since reached origin,
// the kept words beside it, shown once more and retired when the lane's
// branch is gone too, as a run that never squashed is once its branch is
// gone).
//
// --session-start: the markers, the ship record, the ship phase (at most
// SESSION_PHASE_MAX lines past the one in flight, unreadable manifests first
// and counted toward the cap, then the ended lines, and a pointer to
// lane:status for the rest, so the stale-lane lines and the child's time
// bound stay clear of them),
// then one line per stale lane, at most SESSION_MAX_LINES lines, and exit 0
// whatever it finds, so the hook can never fail or hang a session. The work runs in a
// child process of this same file (--session-start-run) under a hard timeout;
// the child loads markers.js, shipLog.js, mergeShipLog.js and
// sensitive-match.js only inside its guard, and a failed load, a crash, a cwd
// outside git or the timeout is one line naming it. The plain CLI keeps its
// exit 1 on a stale lane.
//
// This module exports its functions for tests AND runs as a CLI.

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Loaded on first use, so a missing or broken module is caught by the caller
// (the session-start guard) instead of failing this file's own load.
function isSensitive(paths) {
  return require('./sensitive-match').isSensitive(paths);
}

const STALE_AGE_MS = 48 * 60 * 60 * 1000; // 48h with no new commit
const STALE_MAIN_ADVANCE = 15; // main commits since the lane was cut
const DEFAULT_BOARD = path.join(__dirname, '..', 'docs', 'build-board.md');

// Run a git command in `cwd`, returning trimmed stdout. Throws on failure
// unless `allowFail` is set, in which case it returns null.
function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

// Locate the primary (os) worktree: dirname of the shared --git-common-dir.
// Every linked worktree resolves the same common dir, so this is stable from
// any checkout.
function primaryRoot(cwd) {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return path.dirname(common);
}

// Parse `git worktree list --porcelain` into { path, branch } records.
function parseWorktrees(porcelain) {
  const out = [];
  let cur = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null };
      out.push(cur);
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line.startsWith('detached') && cur) {
      cur.branch = null;
    }
  }
  return out;
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

// List the open lanes: every worktree except the primary/os one. Each lane is
// { path, branch }.
function listLanes(cwd = process.cwd()) {
  const porcelain = git(cwd, ['worktree', 'list', '--porcelain']);
  const primary = primaryRoot(cwd);
  return parseWorktrees(porcelain).filter(
    (wt) => !samePath(wt.path, primary) && wt.branch
  );
}

// Read the build board (titles/paths only) if present; tolerate absence.
// Returns the raw text, or '' when the file is missing.
function readBoard(boardFile = DEFAULT_BOARD) {
  try {
    return fs.readFileSync(boardFile, 'utf8');
  } catch {
    return '';
  }
}

// True if the board mentions a lane branch name anywhere (loose substring
// match: the board is freeform titles/paths, not a parsed registry).
function boardMentions(boardText, branch) {
  return boardText.includes(branch);
}

// Evaluate one lane against the three staleness triggers. `mainRef` is the ref
// that names integrated main (default 'main'). Returns the full evaluation
// including the reasons so the CLI can explain itself.
function evaluateLane(lane, opts = {}) {
  const cwd = opts.cwd || lane.path;
  const mainRef = opts.mainRef || 'main';
  const now = opts.now || Date.now();

  const reasons = [];

  // Newest commit timestamp on the lane branch (unix seconds).
  const lastCommitRaw = git(cwd, ['log', '-1', '--format=%ct', lane.branch], {
    allowFail: true,
  });
  const lastCommitMs = lastCommitRaw ? parseInt(lastCommitRaw, 10) * 1000 : null;
  const ageMs = lastCommitMs == null ? null : now - lastCommitMs;

  // (a) older than 48h with no new commit on it.
  if (ageMs != null && ageMs > STALE_AGE_MS) {
    const hours = Math.floor(ageMs / (60 * 60 * 1000));
    reasons.push(`no new commit in ${hours}h (over 48h)`);
  }

  // The point main and the lane diverged: where the lane was cut.
  const mergeBase = git(cwd, ['merge-base', mainRef, lane.branch], {
    allowFail: true,
  });

  // (b) main has advanced 15+ commits since the lane was cut.
  let mainAdvance = null;
  if (mergeBase) {
    const count = git(cwd, ['rev-list', '--count', `${mergeBase}..${mainRef}`], {
      allowFail: true,
    });
    mainAdvance = count == null ? null : parseInt(count, 10);
    if (mainAdvance != null && mainAdvance >= STALE_MAIN_ADVANCE) {
      reasons.push(`main advanced ${mainAdvance} commits since cut (over ${STALE_MAIN_ADVANCE})`);
    }
  }

  // (c) any sensitive path has landed on main since the lane was cut.
  let sensitiveLanded = false;
  if (mergeBase) {
    const diff = git(cwd, ['diff', '--name-only', `${mergeBase}..${mainRef}`], {
      allowFail: true,
    });
    const changed = diff ? diff.split('\n').filter(Boolean) : [];
    if (changed.length && isSensitive(changed)) {
      sensitiveLanded = true;
      reasons.push('a sensitive path landed on main since cut');
    }
  }

  return {
    branch: lane.branch,
    path: lane.path,
    ageMs,
    mainAdvance,
    sensitiveLanded,
    stale: reasons.length > 0,
    reasons,
  };
}

// Safe-scrap check. A lane may be auto-scrapped ONLY if it holds no distinct
// unmerged work, i.e. `git log main..<lane-branch>` is empty. Returns
// { safe, unmergedCount, command, message }.
function safeScrapCheck(lane, opts = {}) {
  const cwd = opts.cwd || lane.path;
  const mainRef = opts.mainRef || 'main';
  const log = git(cwd, ['log', '--oneline', `${mainRef}..${lane.branch}`], {
    allowFail: true,
  });
  const unmerged = log ? log.split('\n').filter(Boolean) : [];
  const safe = unmerged.length === 0;
  return {
    branch: lane.branch,
    safe,
    unmergedCount: unmerged.length,
    // Auto-scrap always uses -d (refuses unmerged itself), NEVER -D.
    command: safe ? `git branch -d ${lane.branch}` : null,
    message: safe
      ? 'fully merged: safe to auto-scrap with `git branch -d` (never -D)'
      : `${unmerged.length} unmerged commit(s) on '${lane.branch}': refusing auto-scrap, Dallas must approve`,
  };
}

// Build the full status of every open lane: staleness + safe-scrap + whether
// the board knows about it.
function laneStatus(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const boardText = readBoard(opts.boardFile);
  const lanes = listLanes(cwd);
  return lanes.map((lane) => {
    const evalOpts = { cwd, mainRef: opts.mainRef, now: opts.now };
    return {
      ...evaluateLane(lane, evalOpts),
      scrap: safeScrapCheck(lane, evalOpts),
      onBoard: boardMentions(boardText, lane.branch),
    };
  });
}

// ---- the markers and the ship record (step 3, lane session-status) ---------

const SESSION_MAX_LINES = 12;
// The child's hard bound: under the two seconds the plan allows the hook,
// with room for the parent's own start and the line it adds.
const SESSION_TIMEOUT_MS = 1500;
// The ship phase's ended lines at session start (phaseLines' max).
const SESSION_PHASE_MAX = 3;

const isSet = (v) => v !== null && v !== undefined;
const short = (sha) => String(sha).slice(0, 7);
const FULL_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MANIFEST_FILE = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\.json$/;

// The first line of an error's message, flattened and capped, for the one
// line a caught failure prints.
function firstLine(err) {
  const text = String((err && err.message) || err).split('\n')[0].replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

// The flip state and the two markers' lines. The gate and watch lines are
// refusals whatever the flip state (since the flip an absent marker was
// lost); on an unreadable flip file the flip line is standing().flip, never a
// read of flip() alone.
function markersReport({ cwd = process.cwd() } = {}) {
  const markers = require('./lib/markers');
  const f = markers.flipState({ cwd });
  const s = markers.standing({ cwd });
  const lines = [];
  if (f.state === 'absent') lines.push(`flip marker: missing (the flip happened, so it was lost); every push refuses until it is restored: ${markers.flipRestore(f.path)}`);
  else if (f.state === 'present') lines.push(`flip marker: ${short(f.sha)} ${isSet(f.pushed_at) ? markers.clean(f.pushed_at) : 'no date recorded'}`);
  else lines.push(s.flip);
  if (s.gate) lines.push(s.gate);
  if (s.watch) lines.push(s.watch);
  return lines;
}

// One manifest read by its file key with no git call: {sha, m}, {sha,
// unreadable: true} for a file that is not a manifest naming its own sha, or
// null when there is none.
function readRecord(dir, sha) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, `${sha}.json`), 'utf8');
  } catch (err) {
    return err && err.code === 'ENOENT' ? null : { sha, unreadable: true };
  }
  try {
    const m = JSON.parse(raw);
    if (m && typeof m === 'object' && !Array.isArray(m) && m.sha === sha) return { sha, m };
  } catch (err) {
    // A manifest that does not parse is unreadable; anything else is not ours to hide.
    if (!(err instanceof SyntaxError)) throw err;
  }
  return { sha, unreadable: true };
}

// The record the last file names; without a usable last, the newest readable
// manifest by started_at (shipLog.inFlight's own fallback).
function lastRecord(dir, shipLog, cwd) {
  let sha = null;
  try {
    sha = shipLog.readLast({ cwd });
  } catch {
    sha = null;
  }
  const named = sha ? readRecord(dir, sha) : null;
  if (named) return named;
  let best = null;
  let bestAt = -Infinity;
  for (const name of fs.readdirSync(dir)) {
    const hit = MANIFEST_FILE.exec(name);
    if (!hit) continue;
    const rec = readRecord(dir, hit[1]);
    if (!rec || rec.unreadable) continue;
    const at = Date.parse(rec.m.started_at);
    const when = Number.isFinite(at) ? at : -Infinity;
    if (!best || when > bestAt) {
      best = rec;
      bestAt = when;
    }
  }
  return best;
}

// The watch marker's entry for a sha (the newest entry or one stacked under
// `earlier`), or null.
function watchEntry(markers, sha, cwd) {
  const w = markers.watch({ cwd });
  if (!w || w.unreadable) return null;
  const { earlier, ...top } = w;
  return [...(Array.isArray(earlier) ? earlier : []), top].find((e) => e && e.sha === sha) || null;
}

// The ship record, from the manifests and the shipLog readers, never from the
// log's prose: the last ship or the one in flight, every unsettled record by
// its state, every settled record whose watch must run again, and what the
// last ship's watch found.
function shipReport({ cwd = process.cwd(), now = Date.now() } = {}) {
  const markers = require('./lib/markers');
  const shipLog = require('./lib/shipLog');
  const R = require('./lib/receipt');
  const dir = path.join(R.commonDir({ cwd }), 'drb-ship');
  if (!fs.existsSync(dir)) return ['no ship yet'];
  const c = markers.clean;
  const at = (v) => (isSet(v) ? c(v) : 'an unrecorded time');
  const lines = [];
  const live = shipLog.inFlight({ cwd, now });
  const open = shipLog.unsettled({ cwd });
  const rewatch = shipLog.unwatched({ cwd });
  const last = lastRecord(dir, shipLog, cwd);

  if (live) {
    const stage = isSet(live.last_stage) ? c(live.last_stage) : 'open';
    const since = isSet(live.last_stage_at) ? live.last_stage_at : live.started_at;
    lines.push(`ship in flight: ${short(live.sha)} at stage ${stage} since ${at(since)}, log ${path.join(dir, `${live.sha}.log`)}`);
  } else if (last && last.m && !open.some((e) => e.sha === last.sha)) {
    const m = last.m;
    if (isSet(m.result) && typeof m.result === 'object') {
      lines.push(`last ship: ${short(m.sha)} ${c(m.result.state)} ${at(m.result.at)}`);
    } else {
      const stage = isSet(m.last_stage) ? `last stage ${c(m.last_stage)}` : 'no stage';
      lines.push(`last ship: ${short(m.sha)} no result, ${stage} at ${at(isSet(m.last_stage_at) ? m.last_stage_at : m.started_at)}`);
    }
  }

  for (const e of open) {
    if (e.unreadable) lines.push(`unreadable ship record ${short(e.sha)}; fix or move it`);
    else if (e.state === 'pushed') lines.push(`ship ${short(e.sha)}: pushed at ${at(e.since)}, unfinished; run npm run ship again to finish it`);
    else lines.push(`ship ${short(e.sha)}: push outcome unknown since ${at(e.since)}; run npm run ship again to complete it`);
  }

  for (const e of rewatch) {
    if (e.state === 'died') lines.push(`ship ${short(e.sha)}: watch died, last wrote at ${at(e.last_write)}; run npm run ship again to re-watch it`);
    else lines.push(`ship ${short(e.sha)}: watch claimed at ${at(e.since)} never started; run npm run ship again to re-watch it`);
  }

  // What the last ship's watch found: the count its marker holds, else the
  // count the manifest's watch field holds; an unknown count never reads as
  // quiet. Nothing is printed when the watch counted nothing at all.
  if (!live && last && last.m && isSet(last.m.result) && last.m.result.state === 'ok' && isSet(last.m.watch) && typeof last.m.watch === 'object') {
    const m = last.m;
    const entry = watchEntry(markers, m.sha, cwd);
    if (entry || Number.isInteger(m.watch.count)) {
      const counted = entry ? entry.count : m.watch.count;
      const n = Number.isInteger(counted) ? counted : 'unknown';
      const when = (entry && isSet(entry.deploy_at) && entry.deploy_at) || (isSet(m.watch.deploy_at) && m.watch.deploy_at) || m.pushed_at;
      lines.push(`shipped ${short(m.sha)} at ${at(when)}, ${n} events since`);
    }
  }

  if (!lines.length) lines.push('no ship yet');
  return lines;
}

// The ship phase's lines (header), from its manifests; max caps the ended ones.
function phaseReport({ cwd = process.cwd(), max = Infinity } = {}) {
  return require('./lib/mergeShipLog').phaseLines({ cwd, max });
}

// One line per stale lane, or one line saying none is.
function staleLines(cwd) {
  const lanes = listLanes(cwd);
  const stale = lanes.map((lane) => evaluateLane(lane, { cwd })).filter((s) => s.stale);
  if (!stale.length) return [`lanes: ${lanes.length} open, none stale`];
  return stale.map((s) => `stale lane ${s.branch}: ${s.reasons.join('; ')}`);
}

// A report section that cannot fail the caller: its lines, or one line
// naming the failure.
function guarded(name, fn) {
  try {
    return fn();
  } catch (err) {
    return [`lane-status: the ${name} report failed (${firstLine(err)})`];
  }
}

function capLines(lines, max = SESSION_MAX_LINES) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max - 1);
  kept.push(`... ${lines.length - kept.length} more lines; run npm run lane:status for the full report`);
  return kept;
}

// The session-start lines, computed in this process (the child's half).
// Every require of markers.js, shipLog.js and sensitive-match.js happens in
// here, inside a guard.
function sessionStartLines({ cwd = process.cwd() } = {}) {
  if (git(cwd, ['rev-parse', '--git-common-dir'], { allowFail: true }) === null) {
    return [`lane-status: ${cwd} is not inside a git repo; nothing to report`];
  }
  const out = [];
  let loaded = true;
  for (const mod of ['./lib/markers', './lib/shipLog']) {
    try {
      require(mod);
    } catch (err) {
      out.push(`lane-status: could not load scripts/${mod.slice(2)}.js (${firstLine(err)}); markers and ship not reported`);
      loaded = false;
      break;
    }
  }
  if (loaded) {
    out.push(...guarded('markers', () => markersReport({ cwd })));
    out.push(...guarded('ship', () => shipReport({ cwd })));
    out.push(...guarded('ship phase', () => phaseReport({ cwd, max: SESSION_PHASE_MAX })));
  }
  out.push(...guarded('lanes', () => staleLines(cwd)));
  return capLines(out);
}

// The hook's entry (the parent's half): runs sessionStartLines in a child of
// this file under a hard timeout and returns at most SESSION_MAX_LINES lines,
// a timeout, a crash or a child that could not start included as one line.
// It never throws; the CLI exits 0 after it.
function sessionStart({ cwd = process.cwd(), timeoutMs = SESSION_TIMEOUT_MS } = {}) {
  try {
    const r = spawnSync(process.execPath, [__filename, '--session-start-run'], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    const lines = String(r.stdout || '').split('\n').filter((l) => l !== '');
    let failure = null;
    if (r.error && r.error.code === 'ETIMEDOUT') failure = `lane-status: the session check did not finish in ${timeoutMs} ms; run npm run lane:status`;
    else if (r.error) failure = `lane-status: the session check could not start (${firstLine(r.error)})`;
    else if (r.status !== 0) {
      const why = String(r.stderr || '').split('\n').find((l) => l.trim() !== '');
      failure = `lane-status: the session check ended with ${r.signal || `exit ${r.status}`}${why ? ` (${firstLine(why)})` : ''}`;
    }
    if (!failure) return capLines(lines);
    return [...lines.slice(0, SESSION_MAX_LINES - 1), failure];
  } catch (err) {
    return [`lane-status: the session check failed (${firstLine(err)})`];
  }
}

// Render a readable report for the CLI. With `extra` ({markers, ship}, each a
// list of lines) those lines come first; without it the report is the lanes
// alone, as before.
function formatReport(statuses, extra = null) {
  const lanes = formatLanes(statuses);
  if (!extra) return lanes;
  const head = [...(extra.markers || []), ...(extra.ship || [])];
  return head.length ? `${head.join('\n')}\n\n${lanes}` : lanes;
}

function formatLanes(statuses) {
  if (statuses.length === 0) {
    return 'No open lanes (only the primary os/main worktree).';
  }
  const lines = [`Open lanes: ${statuses.length}`, ''];
  for (const s of statuses) {
    const flag = s.stale ? 'STALE' : 'fresh';
    lines.push(`[${flag}] ${s.branch}`);
    lines.push(`  path: ${s.path}`);
    lines.push(`  board: ${s.onBoard ? 'listed' : 'NOT on build-board.md'}`);
    if (s.stale) {
      for (const r of s.reasons) lines.push(`  stale: ${r}`);
    }
    lines.push(`  scrap: ${s.scrap.message}`);
    lines.push('');
  }
  const staleCount = statuses.filter((s) => s.stale).length;
  lines.push(`${staleCount} stale, ${statuses.length - staleCount} fresh.`);
  return lines.join('\n');
}

module.exports = {
  parseWorktrees,
  listLanes,
  readBoard,
  boardMentions,
  evaluateLane,
  safeScrapCheck,
  laneStatus,
  formatReport,
  primaryRoot,
  STALE_AGE_MS,
  STALE_MAIN_ADVANCE,
  markersReport,
  shipReport,
  phaseReport,
  sessionStartLines,
  sessionStart,
  SESSION_MAX_LINES,
  SESSION_TIMEOUT_MS,
  SESSION_PHASE_MAX,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--session-start-run')) {
    // The child: its lines, and exit 0 whatever happened.
    let lines;
    try {
      lines = sessionStartLines({ cwd: process.cwd() });
    } catch (e) {
      lines = [`lane-status: the session check failed (${firstLine(e)})`];
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = 0;
  } else if (argv.includes('--session-start')) {
    // The hook: never a non-zero exit, never past the child's timeout.
    try {
      process.stdout.write(`${sessionStart({ cwd: process.cwd() }).join('\n')}\n`);
    } catch (err) {
      // The exit stays 0, but the failure is named in one line.
      process.stdout.write(`lane-status: the session check failed (${firstLine(err)})\n`);
    }
    process.exitCode = 0;
  } else {
    try {
      const cwd = process.cwd();
      const statuses = laneStatus({ cwd });
      const extra = {
        markers: guarded('markers', () => markersReport({ cwd })),
        ship: [...guarded('ship', () => shipReport({ cwd })), ...guarded('ship phase', () => phaseReport({ cwd }))],
      };
      process.stdout.write(formatReport(statuses, extra) + '\n');
      // Exit non-zero if any lane is stale, so a caller can react.
      process.exit(statuses.some((s) => s.stale) ? 1 : 0);
    } catch (e) {
      console.error(`lane-status: ${(e && e.message) || e}`);
      process.exit(2);
    }
  }
}
