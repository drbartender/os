'use strict';

// The gate's path constants and its range classifier, a leaf module
// (instruction rewrite step 3, lane ship-state; spec 2026-10-19 sections 4.3
// and 4.7, plan 2026-10-22 decision 18). push-gate.js held MONEY_PATHS and
// CLIENT_PATHS until this step; from the gate-sha lane on it re-exports them
// from here, so its tests and neededGates keep their names, and the sha gate,
// rangeCheck and ship's manifest all classify a range through touches(). This
// file requires only sensitive-match.js and receipt.js, never push-gate.js or
// rangeCheck.js, so no require cycle can form through it.
//
// Matching follows the git pathspecs neededGates passes: an entry ending in
// '/' matches every path under it; any other entry matches that exact path
// (and, as a pathspec does, anything under a directory of that name). No entry
// holds a glob character, so pathspec magic never applies. Paths are compared
// as git names them from the top of the worktree (--no-relative), so a cwd in
// a subdirectory changes nothing.
//
// touches(base, tip) reads `git diff --name-only base tip` (two trees, the way
// neededGates diffs them), with renames off so a file moved out of server/
// still touches server/, and NUL-separated so an unusual name is read exactly.
// It returns:
//   server          a path under server/
//   client          a path under client/ (CLIENT_PATHS)
//   money           a path on MONEY_PATHS: the money smoke must run
//   install         package.json or package-lock.json at the root
//   client_install  client/package.json or client/package-lock.json
//   docs_only       sensitive-match.isDocsOnly over the files (4.7): every file
//                   on the docs allowlist and none listed or hinge. An empty
//                   range is not docs-only (there is nothing to classify); a
//                   caller that cares reads files.length.
//   files           the file list itself
// `listFile` (optional) names the sensitive list isDocsOnly reads; by default
// it is the list beside sensitive-match.js in this checkout.

const path = require('path');
const { spawnSync } = require('child_process');
const SM = require('../sensitive-match');
const R = require('./receipt');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAX_BUFFER = 256 * 1024 * 1024;

// Paths whose change alters what the MONEY gate does or tests. server/ is the
// obvious one; the rest are the gate's own machinery and the dependency set it
// executes under, which a pure server/ trigger would have missed.
const MONEY_PATHS = Object.freeze([
  'server/',
  'scripts/money-smoke-list.txt',
  'scripts/testdb-smoke.js',
  'scripts/lib/tapSummary.js', // testdb-smoke loads it at startup (its summary parser)
  'scripts/lib/flockExec.js', // testdb-smoke loads it at startup (the smoke lock)
  'scripts/push-gate.js',
  'package.json',
  'package-lock.json',
  'scripts/lib/worktreeLinks.js', // the gate worktree's links: a wrong one runs the smoke on another tree's modules or the box's .env
  'scripts/lib/gatePaths.js', // this list and the classifier: a dropped entry drops the smoke for that path
  'scripts/lib/rangeCheck.js', // the receipt check over the push range, run before every gate
  'scripts/lib/shaGate.js', // the sha gate's machinery: it spawns the smoke with the scrubbed env and reads its summary, so a change there changes whether and how the smoke runs
  'scripts/lib/shaGateWorktree.js', // the gate worktree's removal, the smoke logs kept and the children the gate runs and stops
  'scripts/lib/markers.js', // the gate marker the sha gate sets and clears, and the flip state the hook branches on
  'scripts/lib/receipt.js', // the common dir, the commit resolve and the atomic writes every gate path reads through
  'scripts/lib/receiptVerdicts.js', // receipt.js loads it at startup (the verdict tables rangeCheck re-reads)
  'scripts/lib/piiShapes.js', // markers.js and rangeCheck.js load it at startup (the mask and the push-range scan)
  'scripts/sensitive-match.js', // the docs-only and tier rules the classifier and rangeCheck decide by
  'scripts/override-conversion/', // two of its suites are on the money smoke list, so a change there changes what the smoke tests
]);
const CLIENT_PATHS = Object.freeze(['client/']);
const SERVER_PATHS = Object.freeze(['server/']);
const INSTALL_PATHS = Object.freeze(['package.json', 'package-lock.json', 'client/package.json', 'client/package-lock.json']);
const ROOT_INSTALL = Object.freeze(INSTALL_PATHS.filter((p) => !p.startsWith('client/')));
const CLIENT_INSTALL = Object.freeze(INSTALL_PATHS.filter((p) => p.startsWith('client/')));

function matchesEntry(file, entry) {
  if (entry.endsWith('/')) return file.startsWith(entry);
  return file === entry || file.startsWith(`${entry}/`);
}

function touchesAny(files, entries) {
  return files.some((f) => entries.some((e) => matchesEntry(f, e)));
}

// The classification of a file list, without git: what touches() returns for
// a range whose diff names exactly these files.
function classifyFiles(files, { listFile } = {}) {
  const list = [...files].map(String);
  return {
    server: touchesAny(list, SERVER_PATHS),
    client: touchesAny(list, CLIENT_PATHS),
    money: touchesAny(list, MONEY_PATHS),
    install: touchesAny(list, ROOT_INSTALL),
    client_install: touchesAny(list, CLIENT_INSTALL),
    docs_only: SM.isDocsOnly(list, listFile),
    files: list,
  };
}

function namesBetween(base, tip, cwd) {
  const r = spawnSync('git', [
    'diff', '--name-only', '-z', '--no-renames', '--no-relative', '--no-ext-diff', '--no-textconv',
    '--ignore-submodules=none', '--end-of-options', base, tip, '--',
  ], { cwd, env: R.gitEnv(), encoding: 'utf8', maxBuffer: MAX_BUFFER });
  if (r.status !== 0) throw new Error(`git diff --name-only ${R.short(base)} ${R.short(tip)} failed (exit ${r.status})`);
  return r.stdout.split('\0').filter(Boolean);
}

function touches(base, tip, { cwd = REPO_ROOT, listFile } = {}) {
  const from = R.resolveCommit(base, { cwd });
  const to = R.resolveCommit(tip, { cwd });
  return classifyFiles(namesBetween(from, to, cwd), { listFile });
}

module.exports = {
  MONEY_PATHS,
  CLIENT_PATHS,
  SERVER_PATHS,
  INSTALL_PATHS,
  touches,
  classifyFiles,
};
