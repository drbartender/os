'use strict';

// smokeReuse: whether the sha gate may skip its money smoke because an earlier
// passing smoke already covers the tree being shipped, a leaf module the
// sha gate (shaGate.js) calls before it would run the smoke. It requires only
// gatePaths.js, markers.js, receipt.js and Node's own modules.
//
// The rule, fail closed (anything it cannot prove means the smoke runs):
//   - The evidence is a summary.json testdb-smoke wrote with --tap-dir and
//     stamped as its own (kind money-smoke, the full tree hash of the HEAD it
//     ran on, clean true: the tree was clean, bar the tap dir, before the
//     reset and after the last suite, on the same tree, and finished_at), found
//     under <git-common-dir>/drb-review (a review's tests/smoke dirs) or
//     <git-common-dir>/drb-gate (the gate's own <sha>.smoke dirs), never
//     through a symlink. It is trusted only when skipped is false, there is no
//     did_not_run, total_fail is 0, every suite is ok with no failure, the
//     suites are exactly the smoke list at the sha being shipped, and it
//     finished within the last 24 hours (and not in the future).
//   - Reuse (a): a trusted summary whose tree equals the shipped sha's tree.
//   - Reuse (b): a trusted summary on tree T0 where `git diff --name-only T0
//     <tree>` names no path gatePaths.classifyFiles counts as money (the
//     gate's own rule for when the smoke must run, which holds testdb-smoke.js,
//     the smoke list, its loaders and server/) and no suite on the smoke list.
//   - Never while a gate marker stands that names money (or is unreadable):
//     only a fresh run proves a money failure fixed.
//   - The newest trusted summary on the same tree wins, else the newest that
//     reuse (b) admits; the caller logs reuseLine() and records the reuse in
//     the sha receipt (smoke_reused). --fresh-smoke (push-gate.js sha, npm run
//     ship) skips this module; no flag forces a skip.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const GP = require('./gatePaths');
const M = require('./markers');
const R = require('./receipt');

const KIND = 'money-smoke';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SMOKE_LIST = 'scripts/money-smoke-list.txt';
const ROOTS = Object.freeze(['drb-review', 'drb-gate']);
const MAX_DEPTH = 5;
const MAX_ENTRIES = 50000;
const MAX_DIFFS = 20;
const TREE_RE = /^[0-9a-f]{40}$/;

function git(cwd, args) {
  return spawnSync('git', args, { cwd, env: R.gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// The smoke list at a commit, or null when it has none.
function listAt(sha, cwd) {
  const r = git(cwd, ['show', `${sha}:${SMOKE_LIST}`]);
  if (r.status !== 0) return null;
  const files = r.stdout.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return files.length ? files : null;
}

// Every summary.json under the two roots, depth-bounded, symlinks never followed.
function summaryFiles(common) {
  const found = [];
  let seen = 0;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES) return;
      const p = path.join(dir, e.name);
      if (e.isFile() && e.name === 'summary.json') found.push(p);
      else if (e.isDirectory() && depth < MAX_DEPTH) walk(p, depth + 1);
    }
  };
  for (const r of ROOTS) walk(path.join(common, r), 1);
  return found;
}

function readJson(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Null when the summary is a trusted pass of the whole list, else one reason.
function untrusted(s, { list, now }) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not a summary';
  if (s.kind !== KIND) return 'not stamped by testdb-smoke';
  if (typeof s.tree !== 'string' || !TREE_RE.test(s.tree)) return 'no tree';
  if (s.clean !== true) return 'not run on a clean tree';
  if (s.skipped !== false) return 'skipped';
  if (s.did_not_run !== undefined && s.did_not_run !== null) return 'did not run';
  if (s.total_fail !== 0 || !Array.isArray(s.suites) || !s.suites.length) return 'not a pass';
  if (!s.suites.every((x) => x && x.ok === true && x.fail === 0 && typeof x.file === 'string')) return 'a suite did not pass';
  const ran = s.suites.map((x) => x.file).sort();
  const want = [...list].sort();
  if (ran.length !== want.length || ran.some((f, i) => f !== want[i])) return 'not the smoke list at this sha';
  if (!M.isZonedTime(s.finished_at)) return 'no finish time';
  const age = now - Date.parse(s.finished_at);
  if (age < 0 || age > MAX_AGE_MS) return 'too old or dated in the future';
  return null;
}

function namesBetween(from, to, cwd) {
  const r = git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--no-relative', '--no-ext-diff', '--no-textconv', '--end-of-options', from, to, '--']);
  return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : null;
}

// Null when no gate marker blocks a reuse, else the reason.
function markerBlocks(cwd) {
  const cur = M.gate({ cwd });
  if (!cur) return null;
  if (cur.unreadable) return 'the gate marker is unreadable';
  const named = [cur, ...(cur.earlier || [])].some((e) => M.namedChecks(e).includes('money'));
  return named ? `the gate marker on ${R.short(cur.sha)} names money` : null;
}

// {reuse: {tree, finished_at, summary, reason}} or {reuse: null, why}; an
// error on the way is a reason to run the smoke, never a throw.
function reusableSmoke(opts) {
  try {
    return decide(opts);
  } catch (err) {
    return { reuse: null, why: `the reuse check failed (${M.clean(err && err.message ? err.message : String(err))})` };
  }
}

function decide({ sha, tree, cwd, now = Date.now(), install = false }) {
  const none = (why) => ({ reuse: null, why });
  // A stamp records the tracked tree, not the node_modules the smoke ran
  // under, so a range that changes the installed packages always runs it.
  if (install) return none('the range changes the installed packages, which no stamp records');
  if (!TREE_RE.test(String(tree))) return none('the shipped tree is unknown');
  const blocked = markerBlocks(cwd);
  if (blocked) return none(blocked);
  const list = listAt(sha, cwd);
  if (!list) return none(`no ${SMOKE_LIST} at ${R.short(sha)}`);
  const trusted = [];
  for (const file of summaryFiles(R.commonDir({ cwd }))) {
    const s = readJson(file);
    if (!untrusted(s, { list, now })) trusted.push({ file, s });
  }
  if (!trusted.length) return none('no passing smoke on record carries a tree');
  trusted.sort((x, y) => Date.parse(y.s.finished_at) - Date.parse(x.s.finished_at));
  const hit = (t, reason) => ({ reuse: { tree: t.s.tree, finished_at: t.s.finished_at, summary: t.file, reason } });
  const same = trusted.find((t) => t.s.tree === tree);
  if (same) return hit(same, 'the same tree');
  const listed = new Set(list);
  for (const t of trusted.filter((x, i, a) => a.findIndex((y) => y.s.tree === x.s.tree) === i).slice(0, MAX_DIFFS)) {
    const files = namesBetween(t.s.tree, tree, cwd);
    if (!files || !files.length) continue;
    if (GP.classifyFiles(files).money || files.some((f) => listed.has(f))) continue;
    return hit(t, `only ${files.length} file(s) outside the money paths changed since`);
  }
  return none('every passing smoke on record predates a money path change');
}

function reuseLine(reuse) {
  return `smoke reused: passed on tree ${R.short(reuse.tree)} at ${reuse.finished_at}, ${reuse.reason}`;
}

module.exports = { KIND, MAX_AGE_MS, reusableSmoke, reuseLine, untrusted };
