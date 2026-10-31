'use strict';

// The git facts a review reads (instruction rewrite step 2, lane receipt-lib;
// scripts/review-receipt.js): the diff's files as git sees them now
// (previewFiles, for the coverage line verdicts prints), and everything
// finalize judges (finalizeFacts), handed to scripts/lib/receiptFinalize.js,
// which judges and never asks git itself. Nothing here writes but the tree
// object git write-tree stores for the quick-fix key.
//
// finalizeFacts(state, {base, reviewed}, kindOk, cwd) returns
//   problems          a ref git cannot resolve, a key it cannot compute
//   base, reviewed    the resolved --base and --reviewed-against
//   main              refs/heads/main
//   baseOnMain, reviewedOnMain
//                     ancestry (true, false, or null when git cannot say;
//                     receiptFinalize refuses anything but true)
//   tip               the branch tip (lane), HEAD (quick fix), the commit
//   mergeBase, baseOnTip       (lane)
//   head, tree                 (quick fix; tree is the staged tree, the key)
//   parent                     (commit)
//   key, files        the receipt key and the diff's files, generated docs
//                     excluded
//   changedSince      {position a report was read at: the files changed
//                     between it and the final position} (lane: tips; quick
//                     fix: trees); a position git cannot diff is left out,
//                     so every verdict read there reads as stale
//   readBase          {'<main> <tip>' a report recorded: merge-base(main,
//                     tip), the base its lens's diff was cut from, or null}
//                     (lane and quick fix)
//   olderBase         {a readBase other than base: is it an ancestor of
//                     base (true, false, or null when git cannot say)}
//   overlapFiles      {a readBase other than base: the files main changed
//                     between it and reviewed} (review 5, M1); a base git
//                     cannot diff is left out, so every verdict read on it
//                     reads as stale
//   reviewedPatch     {patchKey of a report (its main and tip, and a quick
//                     fix's staged tree): the stable patch id of the diff
//                     from its readBase to its tip (a quick fix: to its
//                     staged tree), generated docs excluded; '' for an empty
//                     diff, null when git cannot say} (lane and quick fix;
//                     receiptFinalize's review cap reads it)
//   landedSensitive   whether a sensitive path (sensitive-match's
//                     isSensitive) is among the files main changed between
//                     an older base a report was read on (and the base, when
//                     it is not reviewed) and reviewed (true, false, or null
//                     when git cannot say)
//   computedTier, computedTiers, computedFloors
//                     the tier, per-file tiers and floor lenses
//                     sensitive-match's tierFromGit computes for the diff
//                     now (lane: base..tip; quick fix: the staged index;
//                     commit: parent..commit); a diff it cannot read is a
//                     problem, never a lighter tier
// When kindOk is false (a kind finalize refuses) no key is gathered.

const { execFileSync } = require('child_process');
const R = require('./receipt');
const { tierFromGit, isSensitive } = require('../sensitive-match');

// The tier of the diff, as review-select computes it, into g; tierFromGit
// runs with receipt.js's REPO_VARS out of the environment (review 4, L3).
function computeTier(g, range, cwd) {
  try {
    const t = R.withGitEnv(() => tierFromGit(range, { cwd }));
    g.computedTier = t.tier;
    g.computedTiers = t.tiersByFile;
    g.computedFloors = t.floors;
  } catch {
    g.problems.push('tier: sensitive-match could not compute the tier of the diff; finalize computes it itself, so nothing is finalized without it');
  }
}

// The diff's files as git sees them now, for the coverage line verdicts
// prints; finalize recomputes them against --base. Null when git cannot say.
function previewFiles(state, cwd) {
  try {
    if (state.mode === 'quick-fix') return R.stagedFiles({ cwd });
    if (state.mode === 'commit') return R.filesBetween(R.parentOf(state.commit, { cwd }), state.commit, { cwd });
    const tip = R.resolveCommit(`refs/heads/${state.name}`, { cwd });
    return R.filesBetween(R.mergeBase('refs/heads/main', tip, { cwd }), tip, { cwd });
  } catch {
    return null;
  }
}

// receipt.js names a position git cannot resolve this way (resolveCommit,
// resolveTree); only that error means stale. Anything else is a defect in the
// diff and propagates.
const UNRESOLVED = /^not a (?:commit|tree): /;

// {position: files changed between it and final} for every recorded position
// but final itself; a position git cannot diff is left out (stale).
function changedSince(positions, final, diff) {
  const out = {};
  for (const p of new Set(positions.filter((x) => x && x !== final))) {
    try {
      out[p] = diff(p, final);
    } catch (err) {
      if (!UNRESOLVED.test(err && err.message)) throw err;
      // left out: every verdict read there is stale
    }
  }
  return out;
}

function finalizeFacts(state, { base, reviewed }, kindOk, cwd) {
  const g = { problems: [], base: null, reviewed: null, main: null, tip: null, key: null, files: null };
  const P = (s) => g.problems.push(s);
  // An ancestry git cannot answer is null, which finalize refuses.
  const anc = (a, b) => {
    try {
      return R.isAncestor(a, b, { cwd });
    } catch {
      return null;
    }
  };
  try {
    g.base = R.resolveCommit(base, { cwd });
  } catch (err) {
    P(`base: ${err.message}`);
  }
  try {
    g.reviewed = R.resolveCommit(reviewed, { cwd });
  } catch (err) {
    P(`reviewed-against: ${err.message}`);
  }
  try {
    g.main = R.resolveCommit('refs/heads/main', { cwd });
  } catch {
    P('main: refs/heads/main does not resolve; base and reviewed_against are checked against it');
  }
  if (g.main && g.base) g.baseOnMain = anc(g.base, g.main);
  if (g.main && g.reviewed) g.reviewedOnMain = anc(g.reviewed, g.main);
  if (!kindOk) return g;
  try {
    if (state.mode === 'lane') {
      try {
        g.tip = R.resolveCommit(`refs/heads/${state.name}`, { cwd });
      } catch {
        P(`branch: ${state.name} no longer exists`);
      }
      if (g.main && g.tip) g.mergeBase = R.mergeBase(g.main, g.tip, { cwd });
      if (g.base && g.tip) {
        g.baseOnTip = R.isAncestor(g.base, g.tip, { cwd });
        if (g.baseOnTip) {
          g.key = R.laneKey(g.base, g.tip, { cwd });
          g.files = R.filesBetween(g.base, g.tip, { cwd });
          computeTier(g, { base: g.base, tip: g.tip }, cwd);
        }
      }
      if (g.tip) g.changedSince = changedSince(state.reports.map((r) => r.tip), g.tip, (a, b) => R.filesBetween(a, b, { cwd }));
    } else if (state.mode === 'quick-fix') {
      g.head = R.resolveCommit('HEAD', { cwd });
      g.tip = g.head;
      g.key = R.quickFixKey({ cwd });
      g.tree = g.key;
      g.files = R.stagedFiles({ cwd });
      computeTier(g, { staged: true }, cwd);
      g.changedSince = changedSince(state.reports.map((r) => r.tree), g.tree, (a, b) => R.filesBetweenTrees(a, b, { cwd }));
    } else {
      g.tip = state.commit;
      g.parent = R.parentOf(g.tip, { cwd });
      g.key = R.commitKey(g.tip, { cwd });
      g.files = R.filesBetween(g.parent, g.tip, { cwd });
      computeTier(g, { base: g.parent, tip: g.tip }, cwd);
    }
  } catch (err) {
    P(`key: ${err.message}`);
  }
  if (state.mode !== 'commit') {
    readBases(g, state.reports, anc, cwd);
    reviewedPatches(g, state.reports, state.mode === 'quick-fix', cwd);
    overlap(g, cwd);
    landed(g, cwd);
  }
  return g;
}

// Whether a sensitive path landed on main in the overlap range: from every
// older base a report was read on (and the base, when it is not reviewed,
// which finalize refuses) to reviewed.
function landed(g, cwd) {
  if (!g.base || !g.reviewed) return;
  const starts = [g.base, ...Object.keys(g.olderBase || {}).filter((b) => g.olderBase[b] === true)].filter((b) => b !== g.reviewed);
  try {
    g.landedSensitive = isSensitive([...new Set(starts.flatMap((b) => R.filesBetween(b, g.reviewed, { cwd })))]);
  } catch {
    g.landedSensitive = null;
  }
}

// What main changed between each older base a report was read on and
// reviewed (review 5, M1): receiptBase.changedFor counts the diff files among
// them as changed since that report, since a rebase conflict resolved to the
// lane's side leaves such a file byte-identical at the tip.
function overlap(g, cwd) {
  g.overlapFiles = {};
  if (!g.reviewed) return;
  for (const b of new Set(Object.values(g.readBase).filter((x) => x && x !== g.base))) {
    try {
      g.overlapFiles[b] = R.filesBetween(b, g.reviewed, { cwd });
    } catch (err) {
      if (!UNRESOLVED.test(err && err.message)) throw err;
      // left out: every verdict read on it is stale
    }
  }
}

// The base each report was read on (receiptBase.checkMains).
function readBases(g, reports, anc, cwd) {
  g.readBase = {};
  for (const r of reports) {
    const k = `${r.main} ${r.tip}`;
    if (!r.main || !r.tip || k in g.readBase) continue;
    try {
      g.readBase[k] = R.mergeBase(r.main, r.tip, { cwd });
    } catch {
      g.readBase[k] = null;
    }
  }
  g.olderBase = {};
  if (!g.base) return;
  for (const b of new Set(Object.values(g.readBase).filter((x) => x && x !== g.base))) g.olderBase[b] = anc(b, g.base);
}

// The key of the reviewed patch at a report's position, or null.
function patchKey(r) {
  return r && r.main && r.tip ? `${r.main} ${r.tip}${r.tree ? ` ${r.tree}` : ''}` : null;
}

// The diff is pinned (no colour, external driver or textconv, full binary
// content, no renames, fixed prefixes, myers) and read from the top of the
// worktree, so the two sides of one comparison are read alike. It carries no
// context lines: patch-id hashes context, so main editing a line beside a
// lane hunk would change the id of a rebase that carried no fix.
const PATCH_DIFF = Object.freeze(['-c', 'core.quotePath=true', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--full-index', '--binary',
  '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '--diff-algorithm=myers', '--ignore-submodules=none']);
const PATCH_PATHS = Object.freeze([':(top)', ...R.GENERATED_DOCS.map((p) => `:(top,exclude)${p}`)]);

// The stable patch id of the diff from a commit to a commit or a tree, the
// generated docs excluded; '' when that diff is empty.
function patchOf(from, to, cwd) {
  const git = (args, input) => execFileSync('git', args, { cwd, env: R.gitEnv(), input, maxBuffer: 1024 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
  const diff = git([...PATCH_DIFF, '--end-of-options', from, to, '--', ...PATCH_PATHS]);
  if (!diff.length) return '';
  const id = git(['patch-id', '--stable'], diff).toString('utf8').trim().split(/\s+/)[0] || '';
  if (!R.KEY_RE.test(id)) throw new Error('git patch-id returned no id');
  return id;
}

// The reviewed patch at each report's position (readBases first), so the
// cap can tell a rebase that moved only the base from one that carried a
// change; a position git cannot diff is null, which the cap counts.
function reviewedPatches(g, reports, qf, cwd) {
  g.reviewedPatch = {};
  for (const r of reports) {
    const k = patchKey(r);
    if (!k || k in g.reviewedPatch) continue;
    const base = g.readBase[`${r.main} ${r.tip}`];
    const to = qf ? r.tree : r.tip;
    try {
      g.reviewedPatch[k] = base && to ? patchOf(base, to, cwd) : null;
    } catch {
      g.reviewedPatch[k] = null;
    }
  }
}

module.exports = { previewFiles, changedSince, finalizeFacts, patchKey };
