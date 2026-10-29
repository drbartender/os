#!/usr/bin/env node
'use strict';

// The merge path's receipt check and the merged-lane checks (instruction
// rewrite step 5, lane merge-check; spec 2026-10-19 sections 3.7, 3.8, 4.1,
// 4.6 and D2; plan 2026-10-28 decisions 8 and 22). merge-lane.sh check and
// merged run its CLI; checkLane is the check the ship phase re-runs (lane
// merge-ship).
//
//   node scripts/lib/mergeCheck.js check <branch>    (merge-lane.sh check <branch>)
//   node scripts/lib/mergeCheck.js merged <branch>   (merge-lane.sh merged <branch>)
//   node scripts/lib/mergeCheck.js lock <script> [args...]   (merge-lane.sh's squash)
//
// The ship lock, <git-common-dir>/drb-ship.lock, serializes a merge, a check
// and a ship: check and lock take it through flockExec.underLock with the
// guard DRB_SHIP_LOCK, so a run nested under a trusted holder (flockExec's
// ancestry and held-descriptor proof) runs inside the holder's lock and any
// other run waits for the holder. lock runs `bash <script> [args...]` under
// it, handing the child the lock's descriptor and MERGE_LANE_LOCKED set to its
// own pid (merge-lane.sh runs its squash only when that is its parent), and
// exits with its code; a SIGKILL of the launcher alone leaves the locked run
// to finish, as with ship. check runs checkLane and prints exactly one stdout
// line: ready, ready-moved, stale <files> [sensitive] or refused <reason>,
// exit 0 for the first two and 1 for the others (2 for usage). Before it, a
// lane whose squash is on main and not pushed (merge-lane.sh ship's resume:
// mergeShipSquash.findUnpushed, and resumeProblem, both under the lock) is
// never judged as a lane, whose receipt is the squash's own now: check
// answers `merged <squash7> of <branch>, unpushed; ship resumes it` (exit 0),
// or refused with the line the resume would refuse with (exit 1). A refusal's
// further problems and the receipt the line rests on go to stderr. merged
// takes no lock, prints one pass or fail line per merged-lane check and exits
// 0 only when all three pass.
//
// checkLane({cwd, branch, plan, allowStaged}) judges, in order, and the first
// failure is the refusal (allowStaged is ship's --resolved alone, whose index
// holds the session's resolution, which ship verifies itself: neither read of
// the staged status below refuses then):
//   - cwd is the primary (os) worktree with refs/heads/main checked out;
//   - nothing is staged in os (spec 4.6: git merge --squash stages into the
//     one index and the commit takes all of it), then the branch resolves
//     (refs/heads/<branch>), shares history with main and has a change past
//     it outside README.md and ARCHITECTURE.md (no receipt keys those two);
//   - an unstaged edit or an untracked file refuses only at a path the lane
//     changes (git diff --name-only --no-renames <base> <tip>, base the
//     merge base with main) or at one of the two generated docs;
//   - the receipt: under the lane key (receipt.laneKey of base..tip), else the
//     one the index maps to the branch (receipt.indexLookup). None refuses by
//     name and starts nothing; one whose recorded tip is not the branch tip
//     and is missing or names no commit here refuses. One found by branch
//     covers another diff than the lane's, so it refuses: when its recorded
//     tip is not the branch tip, naming the commits since it as needing
//     review at their own tier (spec 3.8; below), else as keyed over another
//     base. One found by key must be final, record that key and be kind lane
//     or comment-only; when its recorded tip is not the branch tip, that tip
//     and its recorded base must name commits here (else it refuses), and
//     the whitespace-exact patch id (git patch-id --verbatim over the
//     lane-key diff, the two docs excluded) of <recorded base>..<recorded
//     tip> must equal the lane's, else the commits since it are named the
//     same way (the lane key strips whitespace, so it cannot see a
//     whitespace-only amend, a reset back, or a whitespace commit then a
//     rebase). Those commits are the lane's own since the recorded tip (on
//     the branch, in neither the recorded tip's history nor main's, since
//     after a rebase the plain range <recorded tip>..<tip> holds main's
//     commits too), named by count with the tier their change computes to
//     with main's list, over <recorded tip>..<tip> while the two share a lane
//     commit and over base..tip after a rebase ("the N lane commit(s) since
//     the recorded tip <sha7> need review at tier <t>"; a tip moved back
//     behind it is named as that; result.unreviewed holds {count, since,
//     from, tier}); a content-identical
//     rebase, or a change and its revert, holds the same diff and passes, and
//     a tip that differs from the recorded one only in README.md and
//     ARCHITECTURE.md passes without either comparison (the docs ride outside
//     every key);
//   - the tier, recomputed with sensitive-match.tierFromGit over base..tip and
//     the sensitive list as refs/heads/main holds it (git cat-file into a temp
//     file; never os's copy on disk, which another window may be editing; a
//     main without the list refuses), must not be above the receipt's; the
//     receipt's file list
//     (coverage.files_in_diff) must hold every file of the lane's diff but
//     the two docs, the missing ones named;
//   - the receipt judged from its directory, never its summary, by the push
//     gate's own judge: rangeCheck.checkRange over one commit holding the
//     lane's tip tree on the base (git commit-tree with a fixed identity and
//     date, no ref: the one object check writes, and the same object every
//     time), whose commit key is the lane key; so the verdict tables, the
//     triage, verify, the runner logs and the PII scan are read as a push of
//     the squash would read them when main has not moved. checkRange takes
//     no list file: its tier, floors and docs-only reads use the list beside
//     sensitive-match.js (in os, os's working copy), which another window's
//     unstaged edit could lighten. So before the judge runs, a copy there
//     that is not byte for byte main's list refuses ("the sensitive list on
//     disk differs from main's; commit or restore it before the check"), and
//     it is compared once more before an answer that is not a refusal (below):
//     the judge only passes a receipt while the list it reads is main's;
//   - the receipt's reviewed_against against refs/heads/main: equal is ready;
//     an ancestor of main is ready-moved when no file of the lane (the docs
//     aside) changed on main since it and no path main changed since it is
//     on main's sensitive list, else stale with that overlap and the sensitive
//     flag; anything else refuses;
//   - refs/heads/main, the staged status and the list on disk, read once more
//     right before an answer that is not a refusal: main moved, a staged
//     change appeared, or the list on disk no longer is main's, during the
//     check refuses (the answer was read against the old state).
// The test counts are read from the receipt's runner logs as rangeCheck reads
// them (each suite's TAP log beside its summary.json, tapSummary.parse) and
// carried in the result. result.suites, which ship re-runs on ready-moved,
// holds only repo paths of suites a runner's summary.json or a log entry's
// --command names; a log entry recorded with no single-suite command goes
// into result.unnamed_logs (its entry name), never into suites. checkLane
// writes nothing to the index, the working tree or any ref: its git calls run
// with GIT_OPTIONAL_LOCKS=0 and its status read with --no-optional-locks, so
// no refresh rewrites the index. Any error it meets refuses, never passes.
//
// mergedLane({cwd, branch}) runs the three merged-lane checks (decision 8):
// the squash on main, a commit whose subject opens with merge(lane <branch>):;
// every file the lane changed since its merge base with main byte-identical
// on main, README.md and ARCHITECTURE.md compared outside their generated
// sections; and no worktree with the branch checked out (a prunable one
// counts). The generated sections stay excluded because the merge regenerates
// them (decision 8), but prose the lane wrote by hand in either doc, after its
// squash too, is the lane's work: a doc whose text with every section's body
// emptied (the generator's markers.blankSection over its sections, read
// through genDocs/source, the comparison gen-docs.js --generated-only makes
// for the squash) differs between the merge base and the tip must read the
// same on main as on the tip, else it is named as off main; a marker problem
// on either side counts as a difference.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('./receipt');
const SM = require('../sensitive-match');
const RC = require('./rangeCheck');
const FE = require('./flockExec');
const PII = require('./piiShapes');
const MK = require('./genDocs/markers');
const SRC = require('./genDocs/source');
const { parse: parseTap } = require('./tapSummary');

const MAX_BUFFER = 256 * 1024 * 1024;
const DOCS = R.GENERATED_DOCS;
const LIST = 'scripts/sensitive-paths.txt';
// The list the push gate's judge reads: sensitive-match's default, the copy
// beside sensitive-match.js (header).
const DISK_LIST = path.join(path.dirname(require.resolve('../sensitive-match')), 'sensitive-paths.txt');
const DISK_LIST_DIFFERS = 'the sensitive list on disk differs from main\'s; commit or restore it before the check';
const LANE_KINDS = Object.freeze(['lane', 'comment-only']);
const WAIT_LINE = 'merge-lane: a merge, a check or a ship holds the ship lock; waiting for it';
const USAGE = 'usage: node scripts/lib/mergeCheck.js check <branch> | merged <branch> | lock <script> [args...]\n';
// The one commit check writes: fixed, so the same lane makes the same object.
const AS_ONE = Object.freeze({
  GIT_AUTHOR_NAME: 'merge-lane check', GIT_AUTHOR_EMAIL: '', GIT_AUTHOR_DATE: '@0 +0000',
  GIT_COMMITTER_NAME: 'merge-lane check', GIT_COMMITTER_EMAIL: '', GIT_COMMITTER_DATE: '@0 +0000',
});

// ---- git -----------------------------------------------------------------------

function env(extra = {}) {
  return { ...R.gitEnv(), GIT_OPTIONAL_LOCKS: '0', ...extra };
}

function spawnGit(cwd, args, { extra } = {}) {
  return spawnSync('git', args, { cwd, env: env(extra), encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

// A failure that is not the answer asked for, in git's own first words.
function gitFailed(r) {
  const said = String(r.stderr || '').split('\n').map((l) => l.trim()).find(Boolean);
  const err = new Error(`git failed: ${oneLine(said || (r.error ? r.error.code || 'it could not start' : `exit ${r.status}`))}`);
  err.gitFailed = true;
  return err;
}

function git(cwd, args, opts) {
  const r = spawnGit(cwd, args, opts);
  if (r.error || r.status !== 0) throw gitFailed(r);
  return r.stdout;
}

// The full sha of the commit `ref` names; null when git answers that it names
// none (exit 1); any other failure (exit 128 and the rest) throws git failed.
function commitOf(cwd, ref) {
  const r = spawnGit(cwd, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  if (r.status === 0 && R.KEY_RE.test(r.stdout.trim())) return r.stdout.trim();
  if (r.status === 1) return null;
  throw gitFailed(r);
}

// The merge base of two commits; null when git answers there is none (exit 1).
function mergeBaseOf(cwd, a, b) {
  const r = spawnGit(cwd, ['merge-base', '--end-of-options', a, b]);
  if (r.status === 0 && R.KEY_RE.test(r.stdout.trim())) return r.stdout.trim();
  if (r.status === 1) return null;
  throw gitFailed(r);
}

const nul = (out) => out.split('\0').filter(Boolean);

// receipt.js's lane-key diff (its KEY_DIFF_FLAGS, quotePath, attribute pins and
// pathspec, the two generated docs excluded), not exported there, read here by
// git patch-id --verbatim: a patch id that keeps whitespace, which the lane key
// strips (patchid.verbatim=false).
const KEY_DIFF = Object.freeze(['--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
  '--no-relative', '--unified=3', '--inter-hunk-context=0', '--diff-algorithm=myers', '--indent-heuristic', '--ignore-submodules=none']);

function exactId(cwd, a, b) {
  const e = { ...env(), GIT_ATTR_NOSYSTEM: '1' };
  delete e.GIT_ATTR_SOURCE;
  const run = (dir, args, input) => {
    const r = spawnSync('git', args, { cwd: dir, env: e, input, maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'pipe'] });
    if (r.error || r.status !== 0) throw gitFailed({ ...r, stderr: r.stderr ? r.stderr.toString('utf8') : '' });
    return r.stdout;
  };
  const top = run(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  const empty = run(top, ['hash-object', '-t', 'tree', '--stdin'], '').toString('utf8').trim();
  const diff = run(top, ['-c', 'core.quotePath=true', '-c', 'core.attributesFile=/dev/null', `--attr-source=${empty}`, 'diff', ...KEY_DIFF,
    '--end-of-options', a, b, '--', '.', ...DOCS.map((d) => `:!${d}`)]);
  return diff.length ? run(top, ['patch-id', '--verbatim'], diff).toString('utf8').trim().split(/\s+/)[0] || '' : '';
}

function namesBetween(cwd, a, b) {
  return nul(git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--no-relative', '--no-ext-diff', '--ignore-submodules=none', '--end-of-options', a, b, '--']));
}

const S = (x) => (typeof x === 'string' && R.KEY_RE.test(x) ? x.slice(0, 7) : '(none)');
const show = (p) => PII.maskPath(String(p));
const listed = (files, max = 8) => `${files.slice(0, max).map(show).join(', ')}${files.length > max ? `, and ${files.length - max} more` : ''}`;
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ');

// The commit a branch points at; null when there is no such branch (or the
// name is no usable branch name); a git failure throws.
function branchTip(cwd, branch) {
  let name;
  try {
    name = R.checkName(branch);
  } catch {
    return null;
  }
  return commitOf(cwd, `refs/heads/${name}`);
}

// ---- the parts checkLane runs -----------------------------------------------------

// The sensitive list as refs/heads/main holds it, written into `work` (a
// directory checkLane removes), never os's copy on disk, which another window
// may be editing; null when main holds none.
function mainList(cwd, work) {
  const rec = nul(git(cwd, ['ls-tree', '-z', '--full-tree', 'refs/heads/main', '--', LIST]))[0];
  const oid = rec ? rec.split('\t')[0].split(' ')[2] : null;
  if (!oid || !R.KEY_RE.test(oid)) return null;
  const file = path.join(work, 'sensitive-paths.txt');
  fs.writeFileSync(file, git(cwd, ['cat-file', 'blob', oid]));
  return file;
}

// Whether the list the judge reads on disk is byte for byte main's (the copy
// mainList wrote); an unreadable one is not.
function diskListIsMains(listFile) {
  try {
    return fs.readFileSync(DISK_LIST).equals(fs.readFileSync(listFile));
  } catch {
    return false;
  }
}

// Why cwd is not the primary worktree on main, or null.
function primaryProblem(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  if (top !== path.dirname(R.commonDir({ cwd }))) return `check runs only from the primary (os) worktree, not ${top}`;
  const head = spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd, env: env(), encoding: 'utf8' });
  const ref = head.status === 0 ? head.stdout.trim() : '(detached)';
  return ref === 'refs/heads/main' ? null : `os must be on main to check a lane (HEAD is ${ref})`;
}

// os's status as {staged, loose}: staged against HEAD, and unstaged or
// untracked (git status --no-optional-locks, so its refresh stays in memory).
function osStatus(cwd) {
  const out = git(cwd, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none']);
  const staged = [];
  const loose = [];
  for (const rec of nul(out)) {
    const p = rec.slice(3);
    if (rec.startsWith('??')) loose.push(p);
    else {
      if (rec[0] !== ' ') staged.push(p);
      if (rec[1] !== ' ') loose.push(p);
    }
  }
  return { staged, loose };
}

// {key, dir, rec, via, entry} for the receipt under `key`, else the one the
// index maps to `branch`; null when neither finds one.
function findReceipt({ cwd, key, branch }) {
  if (typeof key === 'string' && R.KEY_RE.test(key)) {
    const dir = R.receiptDir(key, { cwd });
    const rec = R.readReceipt(dir);
    if (rec) return { key, dir, rec, via: 'key', entry: null };
  }
  if (typeof branch === 'string' && branch) {
    const hit = R.indexLookup(branch, { cwd });
    const rec = hit && hit.via === 'branch' ? R.readReceipt(hit.dir) : null;
    if (rec) return { key: hit.key, dir: hit.dir, rec, via: 'branch', entry: hit.entry };
  }
  return null;
}

// The text of a regular file inside `dir` (a relative path that stays in it),
// else null.
function insideFile(dir, rel) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || path.isAbsolute(rel)) return null;
  const p = path.resolve(dir, rel);
  if (!p.startsWith(dir + path.sep)) return null;
  try {
    return fs.lstatSync(p).isFile() ? fs.readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

// A path inside the repo (relative, no .. segment), else null.
function repoPath(p) {
  return typeof p === 'string' && p !== '' && !p.includes('\0') && !path.isAbsolute(p) && !p.split('/').includes('..') ? p : null;
}

// The receipt's test counts, read from its runner logs: [{type, file, found,
// pass, fail}] per suite of a suites or smoke run (its TAP log beside its
// summary.json) and per log entry (file the suite its --command named, else
// null, with the entry's name); {type: 'build', ok} per client build.
function testCounts(dir, rec) {
  const out = [];
  for (const e of Array.isArray(rec.tests) ? rec.tests : []) {
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'suites' || e.type === 'smoke') {
      let summary = null;
      try {
        summary = JSON.parse(insideFile(dir, e.log));
      } catch {
        summary = null;
      }
      if (!summary || !Array.isArray(summary.suites)) {
        out.push({ type: e.type, file: null, found: false, pass: 0, fail: 0 });
        continue;
      }
      for (const s of summary.suites) {
        const log = s && typeof s.log === 'string' && path.basename(s.log) === s.log ? path.join(path.dirname(String(e.log)), s.log) : null;
        const t = parseTap(log ? insideFile(dir, log) : null);
        out.push({ type: e.type, file: s ? repoPath(s.file) : null, found: t.found, pass: t.pass, fail: t.fail });
      }
    } else if (e.type === 'log') {
      const t = parseTap(insideFile(dir, e.log));
      out.push({ type: 'log', file: repoPath(e.file), name: typeof e.name === 'string' ? e.name : null, found: t.found, pass: t.pass, fail: t.fail });
    } else if (e.type === 'build') {
      out.push({ type: 'build', file: null, found: true, ok: e.ok === true && e.exit === 0 });
    }
  }
  return out;
}

// The lane's own commits since the receipt's recorded tip (on the branch, in
// neither the recorded tip's history nor main's: after a rebase the plain
// range <recorded tip>..<tip> holds main's commits too) and the tier their
// change computes to with main's list, over <recorded tip>..<tip> while the
// two still share a lane commit (commits on top, a reset back), else over
// <base>..<tip> (a rebase made every lane commit new): {count, since, from,
// tier}.
function sinceRecorded(cwd, { recTip, tip, main, base, listFile }) {
  const shared = mergeBaseOf(cwd, recTip, tip);
  const from = shared && !R.isAncestor(shared, main, { cwd }) ? recTip : base;
  const count = Number(git(cwd, ['rev-list', '--count', tip, `^${recTip}`, `^${main}`, '--']).trim());
  const tier = R.withGitEnv(() => SM.tierFromGit({ base: from, tip }, { cwd, listFile })).tier;
  return { count, since: recTip, from, tier };
}

// The recorded-tip refusal: those commits named with their tier, then why.
function sinceLine(u, tip, why) {
  const head = u.count
    ? `the ${u.count} lane commit(s) since the recorded tip ${S(u.since)} need review at tier ${u.tier}`
    : `the lane's tip ${S(tip)} is behind the recorded tip ${S(u.since)}, with no lane commit since it; the change back needs review at tier ${u.tier}`;
  return `${head}: ${why} (spec 3.8)`;
}

// The receipt judged from its directory by the push gate's judge, over one
// commit holding the tip's tree on the base (header): its problems, the
// commit's sha7 prefix taken off, each once.
function deepProblems(cwd, base, tip) {
  const tree = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${tip}^{tree}`]).trim();
  const one = git(cwd, ['commit-tree', '--no-gpg-sign', '-p', base, '-m', 'merge-lane check: the lane as one commit', tree], { extra: AS_ONE }).trim();
  if (!R.KEY_RE.test(one)) throw new Error('git commit-tree returned no commit');
  const r = RC.checkRange({ base, tip: one, cwd });
  const prefix = `${one.slice(0, 7)}: `;
  return [...new Set(r.problems.map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)))];
}

// ---- checkLane -------------------------------------------------------------------

function result(fields) {
  const r = { state: 'refused', ok: false, exitCode: 1, reason: null, problems: [], overlap: [], sensitive: false, sensitivePaths: [], tests: [], suites: [], unnamed_logs: [], unreviewed: null, ...fields };
  r.ok = r.state === 'ready' || r.state === 'ready-moved';
  r.exitCode = r.ok ? 0 : 1;
  if (r.state === 'refused' && !r.reason) r.reason = r.problems[0] || 'the check could not run';
  return r;
}

function refuse(base, ...problems) {
  return result({ ...base, state: 'refused', problems: problems.flat().map(oneLine) });
}

function judge({ cwd, branch, plan = null, work, allowStaged = false }) {
  const at = { branch, plan };
  const prim = primaryProblem(cwd);
  if (prim) return refuse(at, prim);
  const st = osStatus(cwd);
  if (st.staged.length && !allowStaged) return refuse(at, `os has a staged change (${listed(st.staged)}); a staged path would ride into the squash: commit or unstage it first`);
  const tip = branchTip(cwd, branch);
  if (!tip) return refuse(at, `no branch ${oneLine(branch)}`);
  const main = commitOf(cwd, 'refs/heads/main');
  if (!main) return refuse(at, 'no branch main');
  const base = mergeBaseOf(cwd, main, tip);
  if (!base) return refuse(at, `${branch} shares no history with main`);
  Object.assign(at, { main, tip, base });
  if (base === tip) return refuse(at, `nothing to merge: ${branch} has no change past main`);
  const laneFiles = namesBetween(cwd, base, tip);
  const files = laneFiles.filter((f) => !DOCS.includes(f));
  Object.assign(at, { laneFiles, files });
  if (!files.length) return refuse(at, `nothing a receipt keys: ${branch} changes only ${DOCS.join(' and ')}, which the merge regenerates`);
  const listFile = mainList(cwd, work);
  if (!listFile) return refuse(at, `refs/heads/main holds no ${LIST}; check reads the sensitive list from main`);
  const watched = new Set([...laneFiles, ...DOCS]);
  const blocking = st.loose.filter((p) => watched.has(p));
  if (blocking.length) return refuse(at, `os has an unstaged edit or an untracked file at a path the lane changes or a generated doc (${listed(blocking)}); commit, stash or move it first`);

  const key = R.laneKey(base, tip, { cwd });
  const found = findReceipt({ cwd, key, branch });
  if (!found) return refuse(at, `no review receipt for ${branch}: none under its lane key ${S(key)} and none the index maps to it; run the review on the lane`);
  const { rec, dir, via } = found;
  Object.assign(at, { key: found.key, laneKey: key, dir, via, receipt: rec, tier: SM.TIER_ORDER.includes(rec.tier) ? rec.tier : null, reviewed_against: typeof rec.reviewed_against === 'string' ? rec.reviewed_against : null });
  const k = S(found.key);
  const named = (x) => typeof x === 'string' && R.KEY_RE.test(x) && commitExists(cwd, x);
  if (rec.tip !== tip && !named(rec.tip)) return refuse(at, `the receipt ${k}'s tip is missing or names no commit`);
  const recTip = rec.tip;
  const since = () => (at.unreviewed = sinceRecorded(cwd, { recTip, tip, main, base, listFile }));
  if (via === 'branch') {
    if (recTip !== tip) return refuse(at, sinceLine(since(), tip, `the receipt ${k}, found by branch, records tip ${S(recTip)}`));
    return refuse(at, `the receipt ${k}, found by branch, was keyed over another base than the lane's diff ${S(base)}..${S(tip)} (lane key ${S(key)}); review the lane again`);
  }
  if (rec.state !== 'final') return refuse(at, `the receipt ${k} is not final`);
  if (rec.key !== found.key) return refuse(at, `the receipt under ${k} records another key`);
  if (!LANE_KINDS.includes(rec.kind)) return refuse(at, `the receipt ${k} is of kind ${typeof rec.kind === 'string' && R.KINDS.includes(rec.kind) ? rec.kind : '(unknown)'}; a lane takes ${LANE_KINDS.join(' or ')}`);
  // The lane key strips whitespace, so a tip moved since the review must hold
  // byte for byte the reviewed diff (a content-identical rebase does), unless
  // all it changed since is the two docs, which ride outside every key.
  if (recTip !== tip && !namesBetween(cwd, recTip, tip).every((f) => DOCS.includes(f))) {
    if (!named(rec.base)) return refuse(at, `the receipt ${k}'s base is missing or names no commit`);
    if (exactId(cwd, rec.base, recTip) !== exactId(cwd, base, tip)) {
      return refuse(at, sinceLine(since(), tip, `the receipt ${k} records tip ${S(recTip)}, and the lane's diff to ${S(tip)} is not byte for byte the one it reviewed (the lane key strips whitespace)`));
    }
  }

  if (!at.tier) return refuse(at, `the receipt ${k}'s tier is not one of ${SM.TIER_ORDER.join(', ')}`);
  const computed = R.withGitEnv(() => SM.tierFromGit({ base, tip }, { cwd, listFile })).tier;
  at.computedTier = computed;
  if (SM.TIER_ORDER.indexOf(computed) < SM.TIER_ORDER.indexOf(at.tier)) return refuse(at, `the lane computes to tier ${computed} with main's sensitive list; the receipt ${k} is tier ${at.tier}`);
  const inList = rec.coverage && Array.isArray(rec.coverage.files_in_diff) ? rec.coverage.files_in_diff : [];
  const missing = files.filter((f) => !inList.includes(f));
  if (missing.length) return refuse(at, `the receipt ${k}'s file list is short: ${listed(missing)} ${missing.length === 1 ? 'is' : 'are'} not in it`);
  if (!diskListIsMains(listFile)) return refuse(at, DISK_LIST_DIFFERS);
  const deep = deepProblems(cwd, base, tip);
  if (deep.length) return refuse(at, deep.map((p) => `the receipt ${k}: ${p}`));

  at.tests = testCounts(dir, rec);
  at.suites = [...new Set(at.tests.filter((x) => (x.type === 'suites' || x.type === 'log') && x.file).map((x) => x.file))];
  at.unnamed_logs = at.tests.filter((x) => x.type === 'log' && !x.file).map((x) => x.name || '(no name)');
  at.smoke = at.tests.some((x) => x.type === 'smoke');
  const rv = at.reviewed_against && R.KEY_RE.test(at.reviewed_against) && commitExists(cwd, at.reviewed_against) ? at.reviewed_against : null;
  if (!rv) return refuse(at, `the receipt ${k} records reviewed_against ${S(at.reviewed_against)}, which names no commit here`);
  // main, the index or the list on disk moving while the check read them
  // (another window, or a merge that took no lock) makes the answer stale:
  // read them once more.
  const settle = (r) => {
    const now = commitOf(cwd, 'refs/heads/main');
    if (now !== main) return refuse(at, `main moved during the check (${S(main)} to ${S(now)}); check again`);
    const staged = allowStaged ? [] : osStatus(cwd).staged;
    if (staged.length) return refuse(at, `os gained a staged change during the check (${listed(staged)}); check again`);
    return diskListIsMains(listFile) ? r : refuse(at, DISK_LIST_DIFFERS);
  };
  if (rv === main) return settle(result({ ...at, state: 'ready' }));
  if (!R.isAncestor(rv, main, { cwd })) return refuse(at, `the receipt ${k} was reviewed against ${S(rv)}, which is not on main ${S(main)}`);
  const moved = namesBetween(cwd, rv, main);
  const overlap = files.filter((f) => moved.includes(f));
  const sensitivePaths = SM.matchSensitive(moved, listFile);
  const state = overlap.length || sensitivePaths.length ? 'stale' : 'ready-moved';
  return settle(result({ ...at, state, overlap, sensitive: sensitivePaths.length > 0, sensitivePaths, movedFiles: moved }));
}

function commitExists(cwd, sha) {
  return commitOf(cwd, sha) === sha;
}

// The receipt check (header). Never throws: an error refuses.
function checkLane({ cwd = process.cwd(), branch, plan = null, allowStaged = false } = {}) {
  let work = null;
  try {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-check-'));
    return judge({ cwd, branch, plan, work, allowStaged: allowStaged === true });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return refuse({ branch, plan }, err && err.gitFailed ? msg : `the check could not run: ${msg}`);
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}

// The one line (header).
function line(r) {
  if (r.state === 'stale') return `stale ${r.overlap.length ? r.overlap.map(show).join(', ') : '(no overlap)'}${r.sensitive ? ' sensitive' : ''}`;
  if (r.state === 'refused') return `refused ${oneLine(r.reason)}`;
  return r.state;
}

// Prints the line on stdout; a refusal's other problems, or the receipt the
// line rests on, on stderr.
function report(r, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  out(`${line(r)}\n`);
  for (const p of r.problems.slice(1)) err(`  - ${p}\n`);
  if (r.state !== 'refused') {
    const sens = r.sensitive ? `; sensitive-listed on main since: ${listed(r.sensitivePaths)}` : '';
    err(`check: receipt ${S(r.key)} (by ${r.via}, tier ${r.tier}), reviewed against ${S(r.reviewed_against)}, main ${S(r.main)}${sens}\n`);
  }
}

// ---- the merged-lane checks ---------------------------------------------------------

// A doc's text with every generated section's body emptied, or null for no
// text or a marker problem (header).
function proseOf(text, doc) {
  return text == null ? null : MK.DOC_SECTIONS[doc].reduce((t, s) => (t == null ? null : MK.blankSection(t, s)), text);
}

// The docs whose prose the lane changed over base..tip and main does not hold
// as the tip does (header).
function docsOffMain(cwd, base, tip, main) {
  return R.withGitEnv(() => {
    const [b, t, m] = [base, tip, main].map((ref) => SRC.open({ mode: 'ref', ref, cwd }));
    return DOCS.filter((d) => {
      const [x, y, z] = [b, t, m].map((s) => s.read(d));
      if (x === y) return false;
      const [px, py] = [proseOf(x, d), proseOf(y, d)];
      if (px !== null && py !== null && px === py) return false;
      if (z === y) return false;
      const pz = proseOf(z, d);
      return py === null || pz === null || pz !== py;
    });
  });
}

function mergedLane({ cwd = process.cwd(), branch } = {}) {
  const checks = [];
  const put = (name, ok, text) => checks.push({ name, ok, text: oneLine(text) });
  const attempt = (name, fn) => {
    try {
      fn();
    } catch (err) {
      put(name, false, `${name}: could not run (${err && err.message ? err.message : String(err)})`);
    }
  };
  attempt('squash', () => {
    const needle = `merge(lane ${branch}):`;
    const out = git(cwd, ['log', '-F', `--grep=${needle}`, '--format=%H%x09%s', 'refs/heads/main', '--']);
    const hit = out.split('\n').map((l) => l.split('\t')).find(([h, s]) => R.KEY_RE.test(h) && typeof s === 'string' && s.startsWith(needle));
    if (hit) put('squash', true, `squash on main: ${S(hit[0])} ${PII.mask(hit[1])}`);
    else put('squash', false, `squash on main: no commit on main has a subject opening ${needle}`);
  });
  attempt('files', () => {
    const tip = branchTip(cwd, branch);
    if (!tip) {
      put('files', false, `lane files on main: no branch ${branch}`);
      return;
    }
    const main = commitOf(cwd, 'refs/heads/main');
    const base = main && mergeBaseOf(cwd, main, tip);
    if (!base) {
      put('files', false, `lane files on main: ${branch} shares no history with main`);
      return;
    }
    const files = namesBetween(cwd, base, tip).filter((f) => !DOCS.includes(f));
    const differ = new Set(namesBetween(cwd, main, tip));
    const off = files.filter((f) => differ.has(f));
    const docsOff = docsOffMain(cwd, base, tip, main);
    const said = [];
    if (off.length) said.push(`${listed(off)} ${off.length === 1 ? 'differs' : 'differ'} from the branch`);
    if (docsOff.length) said.push(`${docsOff.join(' and ')} ${docsOff.length === 1 ? 'differs' : 'differ'} from the branch outside ${docsOff.length === 1 ? 'its' : 'their'} generated sections`);
    if (said.length) put('files', false, `lane files on main: ${said.join('; ')}`);
    else put('files', true, `lane files on main: all ${files.length} byte-identical (${DOCS.join(' and ')} compared outside their generated sections)`);
  });
  attempt('worktree', () => {
    const recs = git(cwd, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
    const held = [];
    for (const rec of recs) {
      const attrs = nul(rec);
      if (!attrs.includes(`branch refs/heads/${branch}`)) continue;
      const dir = (attrs.find((a) => a.startsWith('worktree ')) || 'worktree (unknown)').slice('worktree '.length);
      held.push(`${dir}${attrs.some((a) => a === 'prunable' || a.startsWith('prunable ')) ? ' (prunable)' : ''}`);
    }
    if (held.length) put('worktree', false, `worktree: ${branch} is still checked out at ${held.join(', ')}`);
    else put('worktree', true, `worktree: gone (no worktree has ${branch} checked out)`);
  });
  return { ok: checks.length === 3 && checks.every((c) => c.ok), checks };
}

module.exports = { checkLane, report, line, mergedLane, findReceipt, testCounts, osStatus, WAIT_LINE };

// ---- CLI -------------------------------------------------------------------------

// lock: `bash <script> [args...]` under the ship lock (header).
function lockedRun(cwd, held, script, args) {
  const r = spawnSync('bash', [script, ...args], {
    cwd,
    stdio: ['inherit', 'inherit', 'inherit', ...(held.lockFd === null || held.lockFd === undefined ? [] : [held.lockFd])],
    env: { ...process.env, MERGE_LANE_LOCKED: String(process.pid) },
  });
  if (r.error) process.stderr.write(`merge-lane: could not run ${script} under the ship lock (${r.error.code || r.error.message})\n`);
  return r.status === null ? 1 : r.status;
}

async function main(argv) {
  const [cmd, branch, ...rest] = argv;
  const usable = cmd === 'lock' ? Boolean(branch) : ['check', 'merged'].includes(cmd) && Boolean(branch) && rest.length === 0;
  if (!usable) {
    process.stderr.write(USAGE);
    return 2;
  }
  const cwd = process.cwd();
  if (cmd === 'merged') {
    const m = mergedLane({ cwd, branch });
    for (const c of m.checks) process.stdout.write(`${c.ok ? 'pass' : 'fail'} ${c.text}\n`);
    return m.ok ? 0 : 1;
  }
  let lockFile;
  try {
    lockFile = path.join(R.commonDir({ cwd }), 'drb-ship.lock');
  } catch {
    process.stdout.write('refused not inside a git repository\n');
    return 1;
  }
  const held = await FE.underLock({ lockFile, guardVar: 'DRB_SHIP_LOCK', waitLine: WAIT_LINE });
  if (cmd === 'lock') return lockedRun(cwd, held, branch, rest);
  // A lane whose squash is on main unpushed: ship's resume, never the lane check (header).
  const SQ = require('./mergeShipSquash');
  const squash = branchTip(cwd, branch) ? SQ.findUnpushed(cwd, branch) : null;
  if (squash) {
    const why = SQ.resumeProblem(cwd, branch, squash);
    process.stdout.write(why ? `refused ${oneLine(why)}\n` : `merged ${S(squash)} of ${branch}, unpushed; ship resumes it\n`);
    return why ? 1 : 0;
  }
  const r = checkLane({ cwd, branch });
  report(r);
  return r.exitCode;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    process.stdout.write(`refused the check could not run: ${oneLine(err && err.message ? err.message : String(err))}\n`);
    process.exit(1);
  });
}
