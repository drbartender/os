'use strict';

// finalize's judgment of the commits and the bases (instruction rewrite step
// 2, lane receipt-lib; spec 2026-10-19 sections 3.7 and 3.8), as pure
// functions, moved out of scripts/lib/receiptFinalize.js, which runs them in
// validate(): the commits against each other (checkCommits), each report
// against the base (checkMains), the overlap pass of a review rebased onto a
// newer main (checkOverlap), and what changed since a report was read
// (changedFor, which the stale rule reads). Nothing here touches the disk or git; the
// facts are the ones scripts/lib/receiptGit.js gathers (receiptFinalize.js's
// header names them). A problem names commits, lenses, files and counts,
// never a word of a report.

const R = require('./receipt');

// Storage order: the seq a store gives each entry (the array position for an
// entry without one). --pass <n> names the file and orders nothing.
function stored(e) {
  return Number.isInteger(e.seq) ? e.seq : e.i + 1;
}

function listed(files, max = 8) {
  return `${files.slice(0, max).join(', ')}${files.length > max ? `, and ${files.length - max} more` : ''}`;
}

// The commits against each other, from the facts the CLI gathered (spec 3.7
// and 3.8). reviewed_against is the base: the skill reviews a lane only when
// its base is current main, so the two are one commit. --stale-base (the
// overlap pass of 3.8) never lets them differ (review 4, M1): a review moved
// onto a newer main is rebased onto it first, so the rebased tip holds main's
// changes, the stale rule re-reads every file the rebase changed and the
// suites run on the merged content; --stale-base then admits the reports read
// on the older base (checkMains) once the overlap pass is in (checkOverlap).
// Both are on main (ancestors of refs/heads/main), and a lane's base is
// merge-base(main, tip), so --base <tip^> cannot narrow the key to the last
// commit. An ancestry fact must be true: false is refused for what it says,
// and one git could not answer (null), or one never gathered, is refused as
// unproven, never passed. A ref git could not resolve is its own problem, and
// the facts that need it are not judged.
function checkCommits(mode, g, flags = {}) {
  const problems = [];
  const P = (s) => problems.push(s);
  const S = R.short;
  const need = (fact, no, unknown) => {
    if (fact === false) P(no);
    else if (fact !== true) P(unknown);
  };
  if (mode === 'commit' && flags.staleBase) P('stale-base: a commit review reads parent..commit; --stale-base is for a lane or a quick fix');
  if (g.base && g.reviewed && g.reviewed !== g.base) {
    const r = S(g.reviewed);
    if (flags.staleBase) {
      P(`stale-base: --reviewed-against ${r} is not the base ${S(g.base)}; --stale-base is for a review moved onto a newer main: rebase onto ${r} first (spec 3.7), re-pass what it changed and run the overlap pass, then finalize with --base ${r} --reviewed-against ${r} --stale-base`);
    } else {
      P(`reviewed-against: ${r} is not the base ${S(g.base)}; review against the base, or rebase onto ${r} first and finalize with both at ${r} and --stale-base (the overlap pass of spec 3.8)`);
    }
  }
  if (g.main) {
    if (g.base) need(g.baseOnMain, `base: ${S(g.base)} is not on main (not an ancestor of refs/heads/main ${S(g.main)})`, `base: git could not say whether ${S(g.base)} is on main (refs/heads/main ${S(g.main)})`);
    if (g.reviewed && g.reviewed !== g.base) {
      need(g.reviewedOnMain, `reviewed-against: ${S(g.reviewed)} is not on main (not an ancestor of refs/heads/main ${S(g.main)})`,
        `reviewed-against: git could not say whether ${S(g.reviewed)} is on main (refs/heads/main ${S(g.main)})`);
    }
  }
  if (mode === 'lane') {
    if (g.base && g.tip) need(g.baseOnTip, `base: ${S(g.base)} is not an ancestor of the tip ${S(g.tip)}; rebase onto it first`, `base: git could not say whether ${S(g.base)} is an ancestor of the tip ${S(g.tip)}`);
    if (g.base && g.mergeBase && g.base !== g.mergeBase) P(`base: a lane's base is merge-base(main, tip) ${S(g.mergeBase)}, not ${S(g.base)}`);
  } else if (mode === 'quick-fix') {
    if (g.base && g.head && g.base !== g.head) problems.push(`base: a quick fix lands on HEAD ${R.short(g.head)}, not on ${R.short(g.base)}`);
    if (g.files && g.files.length === 0) problems.push('key: nothing is staged outside the generated docs');
  } else if (mode === 'commit') {
    if (g.base && g.parent && g.base !== g.parent) problems.push(`base: a commit receipt's base is the commit's parent ${R.short(g.parent)}, not ${R.short(g.base)}`);
  }
  return problems;
}

// Each report against the base (spec 3.8). A report records the main its
// position snapshot read; the base its lens's diff was cut from is
// merge-base(that main, its tip) (readBase), so main moving on during a review
// changes nothing, and a lane rebased after its review shows every earlier
// report on an older base. Without --stale-base every report must have been
// read on the base. With it, every report is read on the base or on an older
// main (a rebase; the stale rule re-reads each file the rebase changed), and
// checkOverlap asks for the overlap pass. A commit review reads
// parent..commit, so main is not its base.
function checkMains(mode, reports, g, flags = {}) {
  const problems = [];
  const P = (s) => problems.push(s);
  const S = R.short;
  if (mode === 'commit' || !g.base) return problems;
  for (const r of reports) {
    if (!r.main || !r.tip) {
      P(`main: ${r.file} records no position; store it again after position`);
      continue;
    }
    const b = (g.readBase || {})[`${r.main} ${r.tip}`];
    if (!b) P(`main: git could not say which base ${r.file} was read on (main ${S(r.main)}, tip ${S(r.tip)})`);
    else if (b === g.base) continue;
    else if (!flags.staleBase) P(`main: ${r.file} was read on base ${S(b)} (main ${S(r.main)}), not the base ${S(g.base)}: the lane moved onto a newer main after it; re-pass at the new main and finalize with --stale-base (the overlap pass of spec 3.8)`);
    else if ((g.olderBase || {})[b] === false) P(`main: ${r.file} was read on base ${S(b)}, which is neither the base ${S(g.base)} nor an older main`);
    else if ((g.olderBase || {})[b] !== true) P(`main: git could not say whether ${r.file}'s base ${S(b)} is older than the base ${S(g.base)}`);
  }
  return problems;
}

// The overlap pass of spec 3.8 (review 3, M1), with --stale-base on a review
// rebased onto --reviewed-against (checkCommits): seams's latest report, and
// at tier A money's and access-egress's, must have been stored under a
// snapshot the skill declared the overlap pass against main at
// --reviewed-against (position --overlap <sha>); a first pass that merely
// recorded a later main never counts. When a sensitive path landed on main
// between an older base a report was read on and --reviewed-against
// (g.landedSensitive), that seams report gives every diff file a verdict. A
// commit review refuses --stale-base (checkCommits); receiptFinalize runs
// this only for a kind it gathers facts for.
function checkOverlap(c) {
  const { state, g, flags, tier, texts, diffFiles } = c;
  if (!flags.staleBase || !g.reviewed || state.mode === 'commit' || c.commentOnly) return [];
  const S = R.short;
  const problems = [];
  const latest = (lens) => state.reports.map((r, i) => ({ ...r, i })).filter((r) => r.lens === lens).sort((a, b) => stored(a) - stored(b)).pop();
  for (const lens of tier === 'A' ? ['seams', 'money', 'access-egress'] : ['seams']) {
    const r = latest(lens);
    if (!r) problems.push(`stale-base: the overlap pass of spec 3.8 needs ${lens} stored under position --overlap ${S(g.reviewed)}; ${lens} has no report`);
    else if (r.overlap !== g.reviewed) problems.push(`stale-base: ${lens}'s latest pass (${r.file}) is not the overlap pass against main ${S(g.reviewed)}; run position --overlap ${S(g.reviewed)}, then ${lens} --pass <n>`);
  }
  const seams = latest('seams');
  if (!seams || seams.overlap !== g.reviewed) return problems;
  if (g.landedSensitive !== true && g.landedSensitive !== false) {
    problems.push(`stale-base: git could not say which files main changed between the base and --reviewed-against ${S(g.reviewed)}`);
  } else if (g.landedSensitive) {
    const rows = R.parseVerdictTable(texts[seams.file], { lens: 'seams' }).rows;
    const missing = diffFiles.filter((f) => !rows.some((r) => r.file === f && r.verdict !== 'not reached'));
    if (missing.length) problems.push(`stale-base: a sensitive path landed on main between the base and --reviewed-against; seams's overlap pass (${seams.file}) must give every diff file a verdict, and gives none to ${listed(missing)}`);
  }
  return problems;
}

// The files changed since a report was read, for its verdicts (spec 3.8 and
// 3.9): the files changed between its position (`posOf`: a lane's tip, a
// quick fix's staged tree) and `final`; and when it was read on an older base
// b (readBase, merge-base of its main and its tip, is not the base: a review
// rebased after it), the files main changed between b and --reviewed-against
// (g.overlapFiles, review 5, M1). A rebase conflict resolved to the lane's
// side leaves such a file byte-identical at the tip while the diff now
// reverts main's change, so no position diff shows it. null when git could
// not say (a position or a base it could not diff, or none recorded): every
// file the report gave a verdict is then stale.
function changedFor(e, final, g, posOf) {
  const pos = posOf(e);
  if (!pos || !final) return null;
  const moved = pos === final ? [] : (g.changedSince || {})[pos];
  if (!Array.isArray(moved)) return null;
  const b = e.main && e.tip ? (g.readBase || {})[`${e.main} ${e.tip}`] : null;
  if (!b || b === g.base) return moved;
  const main = (g.overlapFiles || {})[b];
  return Array.isArray(main) ? [...moved, ...main] : null;
}

module.exports = { checkCommits, checkMains, checkOverlap, changedFor, stored, listed };
