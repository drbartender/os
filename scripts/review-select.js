#!/usr/bin/env node
'use strict';

/*
 * review-select.js: the tier and the lenses a review runs, from the diff
 * (instruction rewrite spec 2026-10-19, sections 3.2 and 3.3; plan 2026-10-20
 * step 2, lane review-tooling). The review skill runs it after
 * `review-receipt.js init` and saves the output as select.json, which
 * review-brief.js renders and `review-receipt.js finalize --select` records.
 *
 *   node scripts/review-select.js --base <sha> --tip <sha> [--plan <path> --lane <id>]
 *   node scripts/review-select.js --staged [--plan <path> --lane <id>]
 *
 * Prints one JSON object, snake_case throughout (the receipt reads it in
 * snake_case only):
 *   tier, tiers_by_file, floors, matched_paths, sections, content_rule_hits,
 *   status_writes, hinge_paths, docs_only
 *                     sensitive-match's tierFromGit over the range (or the
 *                     staged index); each hit text PII-masked strict
 *                     (scripts/lib/piiShapes.js) and capped
 *                     at 300 characters, so the console never carries a real
 *                     value
 *   lenses            [{name, fired_because, forecast}] in the receipt's lens
 *                     order: fired_because is 'floor' first when a tier floor
 *                     brings the lens, then the trigger names that fired
 *                     (scripts/lib/lensTriggers.js); forecast is true when the
 *                     plan's lane names the lens, false otherwise and always
 *                     false with no --plan
 *   unforecast_lenses the selected lenses the lane did not name; [] with no
 *                     --plan (no forecast to compare)
 *   externals, verify tier A
 *   tests             {smoke: any tier A file, suites: run-suites'
 *                     reachedSuites over the changed paths when a file is tier
 *                     A, B or hinge (else []), client_build: any client/ file}
 *   collapse          a tier A diff whose coverage set (the files but README.md
 *                     and ARCHITECTURE.md) is one or two files may run as one
 *                     agent carrying every selected lens's checklist
 *   refuse_quick_fix  --staged computes a tier A file: tier A is a lane
 *   mode              'range' or 'staged'
 *   base, tip         the full shas read (a range); tip is HEAD for --staged,
 *                     and finalize refuses a select.json whose tip is not the
 *                     final one
 *   tree              --staged only: the staged tree read (git write-tree)
 *   files             the changed paths, a rename's old path included
 *   plan              {path, lane, lenses_line (masked strict)} or null
 *
 * The triggers read a second diff of the same range with no context and no
 * renames (a moved file's body is added lines, as the lens reads it); the tier
 * reads tierFromGit's own (its precondition holds). Refs are resolved to full
 * shas once and both reads take the shas, so a moving branch cannot split them;
 * with --staged the staged tree is read before and after, and a change between
 * the two is refused.
 *
 * A changed path holding a control, format, line-separator or pipe character, a
 * spelling sensitive-match's normalize would change, or a PII shape
 * (piiShapes.pathHits) is refused, named by its index in git's own
 * --name-only -z order (pathRefusal); so is a reached suite whose name fails
 * the same check. Hit texts and the plan's lenses line are masked strict.
 *
 * Exit 0 printed, 1 refused or failed (one line on stderr, nothing on stdout),
 * 2 argv misuse or a ref that names no commit. The repo is the one this script
 * lives in; REVIEW_RECEIPT_ROOT names another (the receipt CLI reads the same
 * variable, so the toolchain agrees on one repo), and says so in one stderr
 * line.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const SM = require('./sensitive-match');
const { reachedSuites } = require('./run-suites');
const { selectLenses, forecastDiff, laneLensesLine, normalize } = require('./lib/lensTriggers');
const { mask, pathHits } = require('./lib/piiShapes');
const { GENERATED_DOCS: R_GENERATED } = require('./lib/receipt');

const REPO_ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: review-select.js --base <sha> --tip <sha> | --staged [--plan <path> --lane <id>]';
const TEXT_CAP = 300;
const MAX_BUFFER = 256 * 1024 * 1024;
// Variables that point git at another repository, worktree or index; dropped
// so every read, tierFromGit's included, is of the repo named.
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR'];

class UsageError extends Error {}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, env: SM.gitEnv(), encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

function resolveCommit(root, ref) {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).trim();
  } catch {
    throw new UsageError(`${ref} is not a commit in ${root}`);
  }
}

// The diff the triggers read: added lines only, the pinned flags, no renames,
// so a moved file's body fires the content triggers the way the lens reads it.
function triggerDiff(root, range, run = git) {
  const target = range.staged ? ['--cached', '--end-of-options'] : ['--end-of-options', range.base, range.tip];
  return run(root, ['diff', ...SM.GIT_DIFF_FLAGS, '--no-renames', '--unified=0', ...target, '--']);
}

// Characters no path may carry into a brief: the Unicode categories Cc
// (C0, DEL, C1), Cf (the bidi marks, embeddings, overrides and isolates, the
// zero-width characters, the word joiner, the BOM, the soft hyphen, U+061C),
// Zl and Zp (the line and paragraph separators), and the pipe, since a verdict
// row for the path could not be written plainly. The census over the tracked
// tree was 0 when this was written, so it refuses nothing there today.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}|]/u;
const ch = (c) => String.fromCharCode(c);
const GIT_ORDER = "in the order git diff --name-only -z --no-renames lists the diff's paths";

/**
 * Why paths cannot go into a brief, or null. Every path-derived value
 * (select.json's files and tiers, the brief's lists, a split's areas) is
 * written as git names it, so a path is refused, before anything is written,
 * when it holds a control, format, line-separator or pipe character (a newline
 * makes one path several lines of the brief: a heading, a table row); when
 * sensitive-match's normalize would read it as another path (a backslash, a
 * leading ./, a space at either end, a . or .. segment: another spelling is
 * another file, and the tier and the mask would judge the wrong one); or when
 * it carries a PII shape in the path itself (piiShapes.pathHits, the check the
 * static pre-step uses: the strict class, UUIDs exempt under
 * docs/design-artifacts/ only). The reason names the path by its 1-based index
 * in `paths` as given (`where` says whose order; for the diff, git's own, byte
 * order) and the problem, never the path. review-brief.js runs the same check.
 */
function pathRefusal(paths, where = GIT_ORDER, noun = 'path') {
  const list = [...new Set(paths)];
  for (const [i, p] of list.entries()) {
    const at = `${noun} ${i + 1} of ${list.length}, ${where},`;
    const why = UNSAFE.test(p)
      ? 'holds a control, format, line-separator or pipe character'
      : normalize(p) !== p
        ? 'is spelled so that the tier reads it as another path (a backslash, a leading ./, a space at either end, a . or .. segment)'
        : pathHits(p).length ? `carries a ${pathHits(p)[0].shape} shape` : null;
    if (why) return `${at} ${why}; rename it before the review (the path is not printed)`;
  }
  return null;
}

// The diff's paths exactly as git names them, in git's order: the list the
// refusal indexes. `target` is the diff's revision arguments.
function diffNames(root, target) {
  return git(root, ['diff', '--name-only', '-z', '--no-renames', '--no-relative', ...target, '--']).split(ch(0)).filter(Boolean);
}

// select.json never needs a raw value: every hit text is masked strict.
function maskHit(h) {
  return { ...h, text: mask(String(h.text || ''), { strict: true }).slice(0, TEXT_CAP) };
}

/**
 * The selection for a range or the staged index.
 * @param {{base: string, tip: string} | {staged: true}} range
 * @param {{root?: string, plan?: string, lane?: string, deps?: {git?: Function}}} [o]
 *   deps.git stands in for this module's git runner (the staged-tree reads and
 *   the trigger diff), for the tests only; the CLI never sets it.
 * @returns {object} select.json, snake_case
 */
function selectFor(range, { root = REPO_ROOT, plan = null, lane = null, deps = {} } = {}) {
  const run = deps.git || git;
  const staged = range.staged === true;
  let base;
  let tip;
  let tree;
  if (staged) {
    tip = resolveCommit(root, 'HEAD');
    tree = run(root, ['write-tree']).trim();
  } else {
    base = resolveCommit(root, range.base);
    tip = resolveCommit(root, range.tip);
  }
  const unsafe = pathRefusal(diffNames(root, staged ? ['--cached', '--end-of-options'] : ['--end-of-options', base, tip]));
  if (unsafe) throw new Error(unsafe);
  const t = SM.tierFromGit(staged ? { staged: true } : { base, tip }, { cwd: root });
  const diffText = triggerDiff(root, staged ? { staged } : { base, tip }, run);
  if (staged && run(root, ['write-tree']).trim() !== tree) throw new Error('the staged tree moved while review-select read it; run it again');
  const files = Object.keys(t.tiersByFile);
  // The receipt's coverage: the files but the generated docs at the root.
  const coverage = files.filter((f) => !R_GENERATED.includes(f));
  const selected = selectLenses({ tiersByFile: t.tiersByFile, floors: t.floors, diffText, paths: files });
  let unforecast = [];
  let planOut = null;
  if (plan) {
    unforecast = forecastDiff(selected, plan, lane);
    const line = laneLensesLine(plan, lane);
    planOut = { path: plan, lane, lenses_line: line === null ? null : mask(line, { strict: true }) };
  }
  // A reached suite's name goes into select.json and the brief like a path.
  const suites = t.tests.suites ? reachedSuites(files, { root }) : [];
  const badSuite = pathRefusal(suites, "in run-suites' reached-suite order", 'reached suite');
  if (badSuite) throw new Error(badSuite);
  return {
    tier: t.tier,
    tiers_by_file: t.tiersByFile,
    floors: t.floors,
    matched_paths: t.matchedPaths,
    sections: t.sections,
    content_rule_hits: t.contentRuleHits.map(maskHit),
    status_writes: t.statusWrites.map(maskHit),
    hinge_paths: t.hingePaths,
    docs_only: t.docsOnly,
    lenses: selected.map((l) => ({ name: l.name, fired_because: l.firedBecause, forecast: plan ? !unforecast.includes(l.name) : false })),
    unforecast_lenses: unforecast,
    externals: t.externals,
    verify: t.verify,
    tests: { smoke: t.tests.smoke, suites, client_build: t.tests.clientBuild },
    collapse: t.tier === 'A' && coverage.length >= 1 && coverage.length <= 2,
    refuse_quick_fix: staged && t.tier === 'A',
    mode: staged ? 'staged' : 'range',
    ...(staged ? {} : { base }),
    tip,
    ...(staged ? { tree } : {}),
    files,
    plan: planOut,
  };
}

// ---- CLI ----------------------------------------------------------------------------

const FLAGS = { '--base': 'value', '--tip': 'value', '--staged': 'bool', '--plan': 'value', '--lane': 'value' };

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const kind = FLAGS[a];
    if (!kind) throw new UsageError(`unknown argument ${a}`);
    const key = a.slice(2);
    if (flags[key] !== undefined) throw new UsageError(`${a} given twice`);
    if (kind === 'bool') {
      flags[key] = true;
      continue;
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith('-')) throw new UsageError(`${a} needs a value`);
    flags[key] = v;
  }
  const range = flags.staged ? { staged: true } : { base: flags.base, tip: flags.tip };
  if (flags.staged && (flags.base !== undefined || flags.tip !== undefined)) throw new UsageError('--staged or --base and --tip, not both');
  if (!flags.staged && (flags.base === undefined || flags.tip === undefined)) throw new UsageError('pass --base <sha> --tip <sha>, or --staged');
  if ((flags.plan === undefined) !== (flags.lane === undefined)) throw new UsageError('--plan and --lane go together');
  return { range, plan: flags.plan === undefined ? null : path.resolve(flags.plan), lane: flags.lane === undefined ? null : flags.lane };
}

function repoRoot() {
  const env = process.env.REVIEW_RECEIPT_ROOT;
  if (env) {
    process.stderr.write(`review-select: repo ${path.resolve(env)} (REVIEW_RECEIPT_ROOT)\n`);
    return path.resolve(env);
  }
  return REPO_ROOT;
}

function main(argv) {
  for (const k of REPO_VARS) delete process.env[k];
  try {
    const { range, plan, lane } = parseArgs(argv);
    const out = selectFor(range, { root: repoRoot(), plan, lane });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${USAGE}\n  (${err.message})\n`);
      return 2;
    }
    process.stderr.write(`review-select: ${String((err && err.message) || err).split('\n')[0]}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { selectFor, parseArgs, main, pathRefusal, diffNames, UNSAFE };
