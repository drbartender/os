#!/usr/bin/env node
'use strict';

// content-rule-calibrate: a read-only report on the content rule in
// scripts/sensitive-match.js (instruction rewrite spec 2026-10-19, 3.3; step 2
// lane sensitive-match-2). Two questions:
//
//   recall    Over every row of docs/superpowers/specs/lens-audit/defects.jsonl
//             with money: true, bites: true and an 8-hex fixed_ref whose commit
//             exists here, does the rule fire on that fix's diff? Two measures,
//             each against the 85 percent floor with its own verdict: the rule
//             alone (the plan's letter), and the sensitive list OR the rule, today
//             and after the flip (the measure the lane adopted; widening the rule
//             to the generic money words instead is Dallas's call, see the
//             money-word comment in sensitive-match.js). Misses are listed by id
//             with their area. The false-positive sample behind that comment was
//             a one-off measurement; this script does not rerun it.
//   docs      Over every commit on main since 2026-10-01 whose paths are all on
//             the docs allowlist, does the rule fire at all? Expected zero: the
//             rule is scoped to code paths.
//
// A 'diff-unparsed' hit (a section the module could not read) is not the rule
// firing: both questions leave it out and the report counts it apart.
//
// Usage: node scripts/content-rule-calibrate.js [--since 2026-10-01] [--json]
// Runs from the repo (or a lane worktree). Reads git; writes nothing.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sm = require('./sensitive-match');

const REPO = path.resolve(__dirname, '..');

// The flip commit's additions to the sensitive list (spec 3.3), as globs, so the
// report can say what the tier A floor (list plus rule) catches after the flip.
// They move into scripts/sensitive-paths.txt in step 5; until then they live here
// as a measurement aid only.
const FLIP_ADDITIONS = ['server/routes/drinkPlans/*', 'server/routes/stripeCreateIntent.js', 'server/utils/serviceExtension*.js',
  'server/utils/drinkPlanExtras.js', 'server/utils/proposalGroupCommit.js', 'server/routes/proposals/metadata.js',
  'server/utils/metricsQueries.js', 'server/utils/autoAssign.js', 'server/routes/admin/payrollTax.js', 'server/db/index.js',
  'server/scripts/**', 'scripts/cc-*.js', 'server/routes/serviceExtensions/*', 'client/src/pages/proposal/proposalView/*',
  'client/src/pages/admin/proposalEditor/*', 'client/src/pages/admin/ProposalDetail.js', 'client/src/pages/admin/ProposalDetailPaymentPanel.js',
  'client/src/components/PricingBreakdown.js', 'client/src/pages/admin/overview/*', 'client/src/pages/admin/payroll/*',
  'client/src/pages/staff/PayPage.js', 'server/utils/paystubData.js', 'client/src/data/eventServicesAgreement.js',
  'server/data/contractorAgreement.js', 'client/src/pages/website/ServicesPage.js'].map(sm.patternToRegex);
const flipListed = (p) => FLIP_ADDITIONS.some((re) => re.test(p));
const DEFECTS = path.join(REPO, 'docs/superpowers/specs/lens-audit/defects.jsonl');

// Every git call runs with sm.gitEnv(): no GIT_DIFF_OPTS or GIT_EXTERNAL_DIFF.
function git(args) {
  return execFileSync('git', args, { cwd: REPO, env: sm.gitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// The fix diff in the same pinned form tierFromGit reads (GIT_DIFF_FLAGS,
// DIFF_CONTEXT_LINES, gitEnv), so the rule is measured on what it will see.
function showDiff(sha) {
  return git(['show', '--format=', ...sm.GIT_DIFF_FLAGS, `--unified=${sm.DIFF_CONTEXT_LINES}`, '--end-of-options', sha]);
}

function changedPaths(sha) {
  return git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--end-of-options', sha]).split('\0').filter(Boolean);
}

function commitExists(sha) {
  try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: REPO, env: sm.gitEnv(), stdio: 'ignore' }); return true; } catch { return false; }
}

// A fix commit or docs commit counts as a rule hit only for a real rule hit. A
// 'diff-unparsed' hit says the module could not read a section (it fails tier()
// closed), not that the rule fired, so it is counted apart.
function splitHits(hits) {
  const unparsed = hits.filter((h) => h.rule === 'diff-unparsed').length;
  const real = hits.length - unparsed;
  return { fired: real > 0, real, unparsed };
}

function main() {
  const args = process.argv.slice(2);
  const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : '2026-10-01';
  const json = args.includes('--json');

  const rows = fs.readFileSync(DEFECTS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const selected = rows.filter((r) => r.money === true && r.bites === true && /^[0-9a-f]{8}$/.test(r.fixed_ref || '') && commitExists(r.fixed_ref));
  const diffCache = new Map();
  const hitCache = new Map();
  const fileCache = new Map();
  const misses = [];
  let hits = 0;
  let hitOrListed = 0;
  let hitOrFlip = 0;
  let unlisted = 0;
  let unlistedHit = 0;
  let unparsedFix = 0;
  for (const r of selected) {
    const sha = r.fixed_ref;
    if (!hitCache.has(sha)) {
      if (!diffCache.has(sha)) diffCache.set(sha, showDiff(sha));
      const split = splitHits(sm.contentRuleHits(diffCache.get(sha)));
      hitCache.set(sha, split.fired);
      unparsedFix += split.unparsed;
      fileCache.set(sha, changedPaths(sha));
    }
    const hit = hitCache.get(sha);
    const files = fileCache.get(sha);
    const listedToday = sm.isSensitive(files);
    const listedFlip = listedToday || files.some(flipListed);
    if (hit) hits++;
    else misses.push({ id: r.id, area: r.area, fixed_ref: sha, cls: r.class, listed_after_flip: listedFlip });
    if (hit || listedToday) hitOrListed++;
    if (hit || listedFlip) hitOrFlip++;
    if (!listedFlip) { unlisted++; if (hit) unlistedHit++; }
  }

  // docs-only commits since <since>: every path on the docs allowlist
  const shas = git(['log', `--since=${since}`, '--format=%h', 'main']).split('\n').filter(Boolean);
  let docsCommits = 0;
  let docsHits = 0;
  let unparsedDocs = 0;
  for (const sha of shas) {
    const paths = changedPaths(sha);
    if (paths.length === 0 || !paths.every(sm.isDocsAllowlisted)) continue;
    docsCommits += 1;
    const split = splitHits(sm.contentRuleHits(showDiff(sha)));
    docsHits += split.real;
    unparsedDocs += split.unparsed;
  }

  const report = summarize({ selected: selected.length, distinctCommits: hitCache.size, hits, hitOrListed, hitOrFlip, unlisted, unlistedHit, misses, since, docsCommits, docsHits, unparsedFix, unparsedDocs });
  if (json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return; }
  for (const line of formatReport(report, new Date().toISOString().slice(0, 10))) console.log(line);
}

const FLOOR = 85;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// The report from the raw counts. Two measures, each with its own verdict: the
// content rule alone, which is what the plan's letter puts the 85 percent floor
// on, and the measure the lane adopted, the tier A floor (sensitive list OR
// rule), today and after the flip's list additions.
function summarize({ selected, distinctCommits, hits, hitOrListed, hitOrFlip, unlisted, unlistedHit, misses, since, docsCommits, docsHits, unparsedFix = 0, unparsedDocs = 0 }) {
  const recallRuleAlone = pct(hits, selected);
  const today = pct(hitOrListed, selected);
  const afterFlip = pct(hitOrFlip, selected);
  return {
    defects_selected: selected,
    distinct_fix_commits: distinctCommits,
    hits,
    floor: FLOOR,
    recall_rule_alone: recallRuleAlone,
    floor_rule_alone_met: recallRuleAlone >= FLOOR,
    // rule_or_listed_* and floor_combined_met_* describe the same measure: the sensitive list OR the rule.
    rule_or_listed_today: today,
    floor_combined_met_today: today >= FLOOR,
    rule_or_listed_after_flip: afterFlip,
    floor_combined_met_after_flip: afterFlip >= FLOOR,
    unlisted_after_flip: unlisted,
    unlisted_after_flip_caught_by_rule: unlistedHit,
    misses,
    docs_only_commits_since: since,
    docs_only_commits: docsCommits,
    docs_only_hits: docsHits,
    diff_unparsed_hits_in_fix_commits: unparsedFix,
    diff_unparsed_hits_in_docs_commits: unparsedDocs,
  };
}

function formatReport(r, date) {
  const verdict = (met) => (met ? 'OK' : 'BELOW FLOOR');
  return [
    `content rule calibration (${date})`,
    `  defects selected: ${r.defects_selected} (money, biting, fix commit present) across ${r.distinct_fix_commits} commits`,
    `  content rule alone (the plan's letter): ${r.recall_rule_alone}% (${r.hits} of ${r.defects_selected})  floor ${r.floor}%  ${verdict(r.floor_rule_alone_met)}`,
    `  sensitive list OR rule (the adopted measure), today: ${r.rule_or_listed_today}%  floor ${r.floor}%  ${verdict(r.floor_combined_met_today)}`,
    `  sensitive list OR rule (the adopted measure), after the flip's list additions: ${r.rule_or_listed_after_flip}%  floor ${r.floor}%  ${verdict(r.floor_combined_met_after_flip)}`,
    `  the rule's own job, defects in files unlisted even after the flip: ${r.unlisted_after_flip_caught_by_rule} of ${r.unlisted_after_flip} caught (${pct(r.unlisted_after_flip_caught_by_rule, r.unlisted_after_flip)}%)`,
    `  misses of the rule (${r.misses.length}; * = not listed even after the flip):`,
    ...r.misses.map((m) => `    ${m.listed_after_flip ? ' ' : '*'} ${m.id} ${m.fixed_ref} [${m.cls}] ${m.area}`),
    `  docs-only commits since ${r.docs_only_commits_since}: ${r.docs_only_commits}, content-rule hits: ${r.docs_only_hits} ${r.docs_only_hits === 0 ? 'OK' : 'UNEXPECTED'}`,
    `  diff-unparsed hits (left out of both counts): ${r.diff_unparsed_hits_in_fix_commits} in the fix commits, ${r.diff_unparsed_hits_in_docs_commits} in the docs-only commits`,
  ];
}

module.exports = { summarize, formatReport, showDiff, splitHits, FLOOR };

if (require.main === module) main();
