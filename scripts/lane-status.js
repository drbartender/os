'use strict';

// lane-status: stale-lane detection + safe-scrap check for the build-in-lanes
// workflow (workflow-redesign).
//
//   node scripts/lane-status.js        # human-readable status report (CLI)
//   npm run lane:status                # same, via package.json
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
// This module exports its functions for tests AND runs as a CLI.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isSensitive } = require('./sensitive-match');

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

// Render a readable report for the CLI.
function formatReport(statuses) {
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
};

if (require.main === module) {
  try {
    const statuses = laneStatus({ cwd: process.cwd() });
    process.stdout.write(formatReport(statuses) + '\n');
    // Exit non-zero if any lane is stale, so a session-start check can react.
    process.exit(statuses.some((s) => s.stale) ? 1 : 0);
  } catch (e) {
    console.error(`lane-status: ${(e && e.message) || e}`);
    process.exit(2);
  }
}
