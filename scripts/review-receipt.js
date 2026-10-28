#!/usr/bin/env node
'use strict';

/*
 * review-receipt.js: the CLI over scripts/lib/receipt.js (instruction rewrite
 * step 2, lane receipt-lib; spec 2026-10-19 sections 3.5 to 3.9). The review
 * skill builds a receipt with it, one step at a time, in a working directory
 * under the git common dir, and finalize keys it at the end.
 *
 *   init --branch <b> [--quick-fix] | --commit <sha> [--branch <b>]
 *   position <name> [--overlap <sha>]
 *   verdicts <name> <lens> <report.md> | --collapsed <report.md> --position <seq>
 *            [--pass <n> | --part <n>]
 *   triage <name> <report> <finding-id> confirmed|fixed|rejected --reason <text>
 *   tests <name> --log <file> | --suites <dir> | --smoke <dir> | --build <log> --exit <code>
 *         --position <seq> [--command <text>]
 *   externals <name> codex=run[:<file>]|not_run:<reason> [gemini=...]
 *             | 'codex: run (<note>)' 'gemini: not run (<reason>)'
 *   verify <name> <report.md> --position <seq> [--pass <n>]
 *   finalize <name> --kind <kind> --base <sha> --reviewed-against <sha> --tier <t>
 *            --select <select.json> (every kind but comment-only)
 *            [--failing-test <file>:<count> --failing-log <log> | --not-a-fix <reason>]
 *            [--stale-base] [--allow-not-reached] [--proof <proof.json>]
 *   show <key|name>
 *   block <key|name>
 *
 * <name> is the review's working name: the branch for a lane,
 * commit-<sha7> for a commit review, and quick-fix-<UTC timestamp> for a
 * quick fix (init prints it). The working directory is
 * <git-common-dir>/drb-review/_work/<name>/ and holds receipt.json (the
 * working state), each report under its contract name (<lens>.md,
 * <lens>.pass-<n>.md, <lens>.part-<n>.md, verify.md; a collapsed one-agent
 * report, one `## Lens: <name>` section per lens, is stored under each lens it
 * has a section for and read one section at a time), tests/ (a copy of every
 * runner log and summary), externals/ and, at finalize, proof.json and
 * tests/failing-on-old-code.log.
 *
 * finalize checks every field against the contract
 * (scripts/lib/receiptFinalize.js, over the git facts of
 * scripts/lib/receiptGit.js), computes the key from the current tip (lane:
 * laneKey(base, branch tip); quick fix: the staged tree; commit: commitKey),
 * builds the receipt (scripts/lib/receiptPublish.js) in a fresh directory
 * beside its key and renames it to <git-common-dir>/drb-review/<key>/ (an
 * earlier receipt under the same key moves to _superseded/<key>.<time>/,
 * never deleted), removes the working directory and maps <name> to the key in
 * index.json. A refused finalize names every problem, one line each, and
 * moves nothing. --allow-not-reached admits a file not reached only when a
 * --pass report of its lens (the one re-dispatch of spec 3.5) has a not
 * reached row for it.
 * --reviewed-against must equal --base, --stale-base or not. A review that
 * moved onto a newer main is rebased onto it first (spec 3.7), so the
 * rebased tip holds main's changes, then finalized with --base and
 * --reviewed-against both that main and --stale-base (the overlap pass of
 * spec 3.8): rebase first, then --stale-base. Both must be on main, a lane's
 * --base is merge-base(main, tip), and an ancestry git cannot answer is
 * refused. Each report must have been read on --base (merge-base of the main
 * and tip its snapshot recorded); with --stale-base, every report is read on
 * the base or an older main, the stale rule refuses each verdict on a file
 * the rebase changed (a file main and the lane both changed among them) until
 * its lens re-reads it, the tests run again on the rebased tip, and the
 * overlap pass is seams's latest report (at tier A money's and
 * access-egress's too) stored under `position --overlap <reviewed-against>`;
 * when a sensitive path landed on main in the range, that seams report gives
 * every diff file a verdict. A
 * commit review is exempt (it reads parent..commit) and refuses --stale-base;
 * its tests are stored only while the checkout's HEAD is the commit (position
 * records HEAD). The receipt records stale_base.
 *
 * Position (scripts/lib/receiptPosition.js): `position <name>` snapshots the
 * branch tip (a quick fix's HEAD and staged tree, a commit review's commit)
 * and refs/heads/main into position.json, and prints `position <seq> tip
 * <sha7>`. The skill runs it right before the lenses' input is taken
 * (review-brief runs it when it writes the diff) and again before any
 * re-dispatch, and passes the seq through: verdicts, verify and tests take
 * the required --position <seq>. They record the snapshot (tip, tree, main,
 * position) on the entry and refuse to store when there is none, when the seq
 * is not the current snapshot's (position ran again before the report was
 * stored: store each report before running position again, or re-run the
 * lens), or when the branch tip (or staged tree) moved since it. position
 * and every store also refuse a lane checked out in no worktree or mid-rebase
 * in one, and a checkout holding tracked changes or untracked files the
 * snapshot does not record (every checkout of a lane; at a quick fix's tests
 * store, any unstaged change or untracked file, since the suites run on the
 * working tree), or an index entry marked assume-unchanged or skip-worktree,
 * which hides an edit from git diff, by count. Each
 * stored report also carries seq, its storage order, which the verdict merge
 * and the fixed-finding clearing follow (--pass <n> only names the file).
 * finalize refuses a verdict read before a later commit or staged hunk
 * changed its file, naming the lens and the files, until a re-pass of that
 * lens lists them (spec 3.8 and 3.9), and a quick fix whose staged tree
 * differs from the tree of any lens's latest report (verify's too).
 *
 * Additions to the plan's command list, each because a contract field or rule
 * had no other way in: `position` (above); `triage` (the per-lens raised,
 * confirmed, fixed and rejected counts and the block's findings line need
 * the session's triage; a finding marked fixed needs a later pass of the lens
 * that raised it whose table lists the finding's file as pass, spec 3.9);
 * `tests --suites <dir>` (run-suites' summary.json, read the way --smoke
 * reads the smoke's); `tests --build` (the client build, spec 3.3's tier C
 * tests); `init --commit <sha>` (the commit kind of spec 3.7 keys a commit,
 * not a branch); `verify --pass`; `verdicts --collapsed` (the collapse rule's
 * one-agent report); `externals codex=run:<file>` and second-opinion.md's two
 * fixed lines as it prints them (scripts/lib/receiptExternals.js; each entry
 * carries the position snapshot it was recorded at, when there is one:
 * recorded, never gated, spec 3.10); `finalize --stale-base` (spec 3.8). finalize
 * refuses kinds squash and revert: spec 3.7 has merge-lane.sh ship write
 * those. The comment-only kind is live (step 4): --proof <proof.json> is the
 * JSON scripts/comment-only-proof.js writes (--base <base> --tip <tip> for a
 * lane, --staged for a quick fix), and finalize refuses one that is not JSON,
 * is not version 1, does not say ok, is for another mode, base, tip or staged
 * tree than the review's, or leaves a file of the review's diff (the
 * generated docs aside) out or not ok, one line each. The receipt stores it as
 * proof.json and names it in its proof field; it runs no lens (the proof is
 * the body), so it needs no select.json, lens, verify, externals, tests or
 * failing test at any tier. Every other kind needs one of --failing-test or
 * --not-a-fix (D13).
 *
 * select.json is review-select.js's output, read in snake_case only; its
 * shape is in scripts/lib/receiptFinalize.js's header. finalize computes the
 * diff's tier itself (sensitive-match's tierFromGit) and refuses a --tier
 * below it, or a select.json whose per-file tiers are not the computed ones.
 *
 * Tests are recorded by scripts/lib/receiptTests.js: every entry but the
 * client build is a green run, copied into the receipt; the client build is
 * recorded green or failed, and finalize needs a green latest build when a
 * client/ file is in the diff or select.json's tests.client_build is true,
 * and refuses a failed latest build. Every entry carries its snapshot, and
 * finalize refuses one that ran anywhere but the final tip (a quick fix's
 * final tree); recording a run at a new position moves the earlier entries
 * to tests_superseded, kept in the receipt and never counted.
 *
 * The console carries names, paths, ids and counts only. Text that came from a
 * lens report, a log, a reason or a proof is stored as given (the brief and the
 * diff were masked before dispatch, scripts/lib/piiShapes.js) and never
 * printed. Exit 0 done, 1 refused, 2 usage, 3 finalize published the receipt
 * but could not update index.json (show still finds it by key).
 *
 * The repo is the one this script lives in; REVIEW_RECEIPT_ROOT names another
 * (the tests' throwaway repos), and says so in one stderr line.
 */

const fs = require('fs');
const path = require('path');
const R = require('./lib/receipt');
const F = require('./lib/receiptFinalize');
const RT = require('./lib/receiptTests');
const G = require('./lib/receiptGit');
const P = require('./lib/receiptPosition');
const X = require('./lib/receiptExternals');
const { publish, stamp } = require('./lib/receiptPublish');
const { TIER_ORDER } = require('./sensitive-match');

const USAGE = [
  'usage: review-receipt.js init --branch <b> [--quick-fix] | --commit <sha> [--branch <b>]',
  '       review-receipt.js position <name> [--overlap <sha>]',
  '       review-receipt.js verdicts <name> <lens> <report.md> | --collapsed <report.md> --position <seq> [--pass <n> | --part <n>]',
  '       review-receipt.js triage <name> <report> <finding-id> confirmed|fixed|rejected --reason <text>',
  '       review-receipt.js tests <name> --log <file> | --suites <dir> | --smoke <dir> | --build <log> --exit <code> --position <seq> [--command <text>]',
  '       review-receipt.js externals <name> codex=run[:<file>]|not_run:<reason> [gemini=...] | \'codex: run|not run (<reason>)\' ...',
  '       review-receipt.js verify <name> <report.md> --position <seq> [--pass <n>]',
  '       review-receipt.js finalize <name> --kind <kind> --base <sha> --reviewed-against <sha> --tier <t>',
  '                 --select <select.json> [--failing-test <file>:<count> --failing-log <log> | --not-a-fix <reason>]',
  '                 [--stale-base] [--allow-not-reached] [--proof <proof.json>] (comment-only: --proof, no --select)',
  '       review-receipt.js show <key|name>',
  '       review-receipt.js block <key|name>',
].join('\n');

const TRIAGE = Object.freeze(['confirmed', 'fixed', 'rejected']);

class UsageError extends Error {}
class Refusal extends Error {}

function usage(why) {
  throw new UsageError(why);
}

function refuse(why) {
  throw new Refusal(why);
}

function repoRoot() {
  const env = process.env.REVIEW_RECEIPT_ROOT;
  if (env) {
    console.error(`review-receipt: repo ${path.resolve(env)} (REVIEW_RECEIPT_ROOT)`);
    return path.resolve(env);
  }
  return path.resolve(__dirname, '..');
}

// Flags per spec: 'bool' or 'value'. A value never starts with --, so a flag
// left without one is caught, never swallowed.
function parseArgs(argv, spec) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const kind = spec[a];
    if (!kind) usage(`unknown flag ${a}`);
    const key = a.slice(2);
    if (flags[key] !== undefined) usage(`${a} given twice`);
    if (kind === 'bool') {
      flags[key] = true;
    } else {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage(`${a} needs a value`);
      flags[key] = v;
    }
  }
  return { positional, flags };
}

// ---- the working state ----------------------------------------------------------

function loadWork(name, cwd) {
  let dir;
  try {
    dir = R.workDir(name, { cwd });
  } catch (err) {
    return usage(err.message);
  }
  const state = R.readReceipt(dir);
  if (!state || state.state !== 'working') refuse(`no open review named ${name}; run init first`);
  return { dir, state };
}

function saveWork(dir, state) {
  R.writeReceipt(dir, state);
}

// {report file: text} for every stored report.
function reportTexts(dir, state) {
  return Object.fromEntries(state.reports.map((r) => [r.file, fs.readFileSync(path.join(dir, r.file), 'utf8')]));
}

function summary(dir, state, lens) {
  return F.lensSummary(state, reportTexts(dir, state), lens);
}

// The snapshot fields a store records, or a refusal naming what to re-run.
// `seq` is the caller's --position; `opts.tests` marks a test entry.
function snapshot(dir, state, cwd, what, seq, opts) {
  try {
    return P.forStore(dir, state, cwd, what, seq, opts);
  } catch (err) {
    return refuse(`${err.message}; nothing was stored`);
  }
}

// The required --position <seq>: the seq position printed when the input
// was taken.
function positionSeq(flags, cmd) {
  if (flags.position === undefined) usage(`${cmd} needs --position <seq> (the seq position printed)`);
  if (!/^[1-9]\d{0,8}$/.test(flags.position)) usage('--position takes the seq position printed, a whole number from 1');
  return Number(flags.position);
}

// Stores one report under each lens's contract name (a collapsed report
// under every lens it has a section for), all or none.
function storeReports(dir, state, lenses, text, { pass, part, collapsed = false, seq }, cwd) {
  const targets = lenses.map((lens) => (pass ? `${lens}.pass-${pass}.md` : part ? `${lens}.part-${part}.md` : `${lens}.md`));
  for (const [i, lens] of lenses.entries()) {
    const target = targets[i];
    if (state.reports.some((r) => r.file === target) || fs.existsSync(path.join(dir, target))) {
      refuse(`${target} is already stored; a re-pass takes --pass <n> with a new n`);
    }
    if (pass && !state.reports.some((r) => r.lens === lens && r.pass === 0)) refuse(`${lens} has no first pass stored; a re-pass comes after one`);
  }
  // The report records the position snapshot its input was taken at
  // (receiptPosition.js), never where git stands when it is stored.
  const snap = snapshot(dir, state, cwd, 'the lens', seq);
  for (const [i, lens] of lenses.entries()) {
    fs.writeFileSync(path.join(dir, targets[i]), text, { flag: 'wx' });
    // seq is the storage order the merge and the fix clearing follow.
    state.seq = (state.seq || 0) + 1;
    const entry = { file: targets[i], lens, seq: state.seq, pass: pass ? Number(pass) : 0, part: part ? Number(part) : null, ...snap, at: new Date().toISOString() };
    if (collapsed) entry.collapsed = true;
    state.reports.push(entry);
  }
  saveWork(dir, state);
  return targets;
}

function passNumber(flags, key) {
  const v = flags[key];
  if (v === undefined) return null;
  if (!/^[1-9]\d{0,3}$/.test(v)) usage(`--${key} takes a whole number from 1`);
  return v;
}

// ---- init ---------------------------------------------------------------------

function cmdInit(args, cwd) {
  const { positional, flags } = parseArgs(args, { '--branch': 'value', '--quick-fix': 'bool', '--commit': 'value' });
  if (positional.length) usage('init takes flags only');
  if (flags.branch === undefined && flags.commit === undefined) usage('init needs --branch <b> (or --commit <sha>)');
  if (flags['quick-fix'] && flags.commit !== undefined) usage('--quick-fix or --commit, not both');
  if (flags.branch !== undefined) {
    try {
      R.checkName(flags.branch);
    } catch (err) {
      usage(err.message);
    }
  }
  let mode = 'lane';
  let name = flags.branch;
  let commit = null;
  if (flags['quick-fix']) {
    mode = 'quick-fix';
    const base = `quick-fix-${stamp()}`;
    name = base;
    for (let i = 2; fs.existsSync(R.workDir(name, { cwd })); i++) name = `${base}-${i}`;
  } else if (flags.commit !== undefined) {
    mode = 'commit';
    try {
      commit = R.resolveCommit(flags.commit, { cwd });
    } catch (err) {
      refuse(err.message);
    }
    // A commit review is named for its commit; --branch, when given, is only
    // recorded as the branch the commit sits on.
    name = `commit-${R.short(commit)}`;
  } else {
    try {
      R.resolveCommit(`refs/heads/${name}`, { cwd });
    } catch {
      refuse(`no branch ${name}; init --branch takes a branch (or add --quick-fix, or --commit <sha>)`);
    }
  }
  const dir = R.workDir(name, { cwd });
  if (fs.existsSync(dir)) refuse(`a review of ${name} is already open at ${dir}; finalize it, or remove that directory to start over`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if (err.code === 'EEXIST') refuse(`a review of ${name} was opened at ${dir} just now by another process`);
    throw err;
  }
  saveWork(dir, {
    version: 1,
    state: 'working',
    name,
    mode,
    branch: flags.branch === undefined ? null : flags.branch,
    commit,
    created_at: new Date().toISOString(),
    reports: [],
    triage: {},
    tests: [],
    externals: {},
  });
  console.log(`init: review opened\n  name: ${name}\n  dir:  ${dir}`);
  return 0;
}

// ---- position ---------------------------------------------------------------------

// Snapshots where the lenses' input is taken (receiptPosition.js): run it right
// before the input is taken and again before any re-dispatch.
function cmdPosition(args, cwd) {
  const { positional, flags } = parseArgs(args, { '--overlap': 'value' });
  if (positional.length !== 1) usage('position takes <name> [--overlap <sha>]');
  const { dir, state } = loadWork(positional[0], cwd);
  let snap;
  try {
    snap = P.take(dir, state, cwd, { overlap: flags.overlap, onReplace: (file) => console.error(`position: ${file} was unreadable; replaced with a new snapshot`) });
  } catch (err) {
    refuse(`position: ${err.message}`);
  }
  // The one line the skill and review-brief read the seq from.
  console.log(`position ${snap.seq} tip ${R.short(snap.tip)}`);
  return 0;
}

// ---- verdicts, verify, triage -----------------------------------------------------

// The lenses a report is stored under: the one named, or (--collapsed) every
// `## Lens: <name>` section. A one-lens report carrying another lens's
// heading is refused, so a collapsed report is never read as one lens.
function reportLenses(file, text, lens) {
  const { sectioned, sections, problems } = R.lensHeadings(text);
  const base = path.basename(file);
  if (lens) {
    const other = sections.find((x) => x.name !== lens);
    if (other) refuse(`${base} line ${other.line}: a ## Lens: heading for a lens other than ${lens}; a collapsed report is stored with --collapsed`);
    return [lens];
  }
  if (!sectioned) refuse(`${base} has no ## Lens: <name> heading; a one-lens report is stored with verdicts <name> <lens> <report.md>`);
  if (problems.length) refuse(`${base} ${problems.join('; ')} (one of ${R.LENSES.join(', ')})`);
  return sections.map((x) => x.name);
}

function cmdVerdicts(args, cwd) {
  const { positional, flags } = parseArgs(args, { '--pass': 'value', '--part': 'value', '--collapsed': 'value', '--position': 'value' });
  const collapsed = flags.collapsed !== undefined;
  if (positional.length !== (collapsed ? 1 : 3)) usage('verdicts takes <name> <lens> <report.md>, or <name> --collapsed <report.md>');
  const [name, lens, single] = positional;
  if (!collapsed && !R.LENSES.includes(lens)) usage(`unknown lens ${lens} (one of ${R.LENSES.join(', ')}; verify has its own command)`);
  const pass = passNumber(flags, 'pass');
  const part = passNumber(flags, 'part');
  if (pass && part) usage('--pass or --part, not both');
  const seq = positionSeq(flags, 'verdicts');
  const file = collapsed ? flags.collapsed : single;
  const { dir, state } = loadWork(name, cwd);
  const text = RT.readFile(file, 'report');
  const lenses = reportLenses(file, text.toString('utf8'), collapsed ? null : lens);
  const targets = storeReports(dir, state, lenses, text, { pass, part, collapsed, seq }, cwd);
  const files = G.previewFiles(state, cwd);
  for (const [i, l] of lenses.entries()) {
    const s = summary(dir, state, l);
    const mine = s.parsed.find((p) => p.name === targets[i]);
    const shape = mine.malformed ? `malformed, ${mine.problems.length} problem(s), no rows read` : `${mine.rows.length} row(s)`;
    console.log(`verdicts: stored ${targets[i]} (${shape}; ${mine.findings.length} finding(s))`);
    for (const p of mine.problems) console.log(`  ${p}`);
    if (!files) {
      console.log(`${l}: coverage is checked at finalize`);
      continue;
    }
    const cov = R.coverage(files, s.merged);
    console.log(`${l}: ${cov.files_with_verdicts.length}/${files.length} files with a verdict`);
    if (cov.not_reached.length) console.log(`  not reached: ${cov.not_reached.join(', ')}`);
  }
  return 0;
}

function cmdVerify(args, cwd) {
  const { positional, flags } = parseArgs(args, { '--pass': 'value', '--position': 'value' });
  if (positional.length !== 2) usage('verify takes <name> <report.md>');
  const [name, file] = positional;
  const pass = passNumber(flags, 'pass');
  const seq = positionSeq(flags, 'verify');
  const { dir, state } = loadWork(name, cwd);
  const [target] = storeReports(dir, state, ['verify'], RT.readFile(file, 'report'), { pass, part: null, seq }, cwd);
  const parsed = F.parseStored(fs.readFileSync(path.join(dir, target), 'utf8'), 'verify');
  console.log(`verify: stored ${target} (${parsed.malformed ? `malformed, ${parsed.problems.length} problem(s); ` : ''}${parsed.findings.length} finding(s))`);
  for (const p of parsed.problems) console.log(`  ${p}`);
  return 0;
}

function cmdTriage(args, cwd) {
  const { positional, flags } = parseArgs(args, { '--reason': 'value' });
  if (positional.length !== 4) usage('triage takes <name> <report> <finding-id> confirmed|fixed|rejected --reason <text>');
  const [name, report, rawId, status] = positional;
  const id = rawId.toUpperCase();
  if (!TRIAGE.includes(status)) usage(`triage status is one of ${TRIAGE.join(', ')}`);
  if (flags.reason === undefined || !flags.reason.trim()) usage('triage needs --reason <text>: the failure path, the fix or why it is rejected');
  const { dir, state } = loadWork(name, cwd);
  const entry = state.reports.find((r) => r.file === report);
  if (!entry) refuse(`${report} is not a stored report of ${name}`);
  const parsed = F.parseStored(fs.readFileSync(path.join(dir, report), 'utf8'), entry.lens);
  if (!parsed.findings.some((f) => f.id === id)) refuse(`${report} has no finding ${id}`);
  state.triage[`${report}#${id}`] = { status, reason: flags.reason, at: new Date().toISOString() };
  saveWork(dir, state);
  const s = summary(dir, state, entry.lens);
  console.log(`triage: ${report} ${id} ${status}; ${entry.lens}: ${s.raised} raised, ${s.untriaged.length} untriaged`);
  return 0;
}

// ---- tests ----------------------------------------------------------------------

function cmdTests(args, cwd) {
  const { positional, flags } = parseArgs(args, { '--log': 'value', '--suites': 'value', '--smoke': 'value', '--build': 'value', '--exit': 'value', '--command': 'value', '--position': 'value' });
  if (positional.length !== 1) usage('tests takes <name> and one of --log, --suites, --smoke or --build');
  const modes = ['log', 'suites', 'smoke', 'build'].filter((m) => flags[m] !== undefined);
  if (modes.length !== 1) usage('tests takes exactly one of --log <file>, --suites <dir>, --smoke <dir> or --build <log> --exit <code>');
  const type = modes[0];
  if ((type === 'build') !== (flags.exit !== undefined)) usage('--build <log> and --exit <code> go together');
  if (type === 'build' && !/^\d{1,3}$/.test(flags.exit)) usage('--exit takes the build\'s exit code, a whole number');
  const seq = positionSeq(flags, 'tests');
  const { dir, state } = loadWork(positional[0], cwd);
  const snap = snapshot(dir, state, cwd, 'the tests', seq, { tests: true });
  let entry;
  try {
    if (type === 'log') entry = RT.recordLog(dir, state, flags.log, flags.command);
    else if (type === 'build') entry = RT.recordBuild(dir, state, flags.build, Number(flags.exit), flags.command);
    else entry = RT.recordRun(dir, state, type, flags[type], flags.command);
  } catch (err) {
    refuse(err.message);
  }
  // A run at a new position replaces the runs recorded elsewhere: they move
  // to tests_superseded, kept and never counted.
  const here = (x) => x.tip === snap.tip && (x.tree || null) === (snap.tree || null);
  const old = state.tests.filter((x) => !here(x));
  if (old.length) {
    state.tests_superseded = [...(state.tests_superseded || []), ...old];
    state.tests = state.tests.filter(here);
    console.log(`tests: ${old.length} earlier ${old.length === 1 ? 'entry' : 'entries'} ran at another ${snap.tree ? 'tree' : 'tip'}; moved to tests_superseded`);
  }
  state.tests.push({ ...entry, ...snap });
  saveWork(dir, state);
  if (type === 'build') console.log(`tests: recorded the client build: ${entry.ok ? 'green' : `failed (${entry.why})`}`);
  else console.log(`tests: recorded ${type === 'log' ? entry.name : `${type} run, ${entry.suites.length} suite(s)`}: pass ${entry.pass} fail ${entry.fail}`);
  return 0;
}

// ---- externals --------------------------------------------------------------------

// scripts/lib/receiptExternals.js reads and records the reviewers.
function cmdExternals(args, cwd) {
  if (args.length < 2) usage('externals takes <name> and codex=... and/or gemini=...');
  const [name, ...rest] = args;
  let updates;
  try {
    updates = X.externalUpdates(rest);
  } catch (err) {
    if (err.code === 'USAGE') usage(err.message);
    throw err;
  }
  const { dir, state } = loadWork(name, cwd);
  const line = X.recordExternals(dir, state, updates);
  saveWork(dir, state);
  console.log(line);
  return 0;
}

// ---- finalize ---------------------------------------------------------------------

const FINALIZE_FLAGS = {
  '--kind': 'value',
  '--base': 'value',
  '--reviewed-against': 'value',
  '--tier': 'value',
  '--select': 'value',
  '--failing-test': 'value',
  '--failing-log': 'value',
  '--not-a-fix': 'value',
  '--allow-not-reached': 'bool',
  '--stale-base': 'bool',
  '--proof': 'value',
};

// --proof: the JSON scripts/comment-only-proof.js wrote, parsed ({json}), or
// why it could not be ({error}: a file it cannot read, or not JSON).
function readProof(file) {
  if (file === undefined) return undefined;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { error: `cannot read ${file}` };
  }
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { error: 'not JSON' };
  }
}

function cmdFinalize(args, cwd) {
  const { positional, flags } = parseArgs(args, FINALIZE_FLAGS);
  if (positional.length !== 1) usage('finalize takes <name>');
  for (const f of ['kind', 'base', 'reviewed-against', 'tier']) if (flags[f] === undefined) usage(`finalize needs --${f}`);
  const tier = flags.tier;
  if (!TIER_ORDER.includes(tier)) usage(`--tier is one of ${TIER_ORDER.join(', ')}`);
  const hasFailing = flags['failing-test'] !== undefined || flags['failing-log'] !== undefined;
  if (hasFailing && (flags['failing-test'] === undefined || flags['failing-log'] === undefined)) usage('--failing-test and --failing-log go together');
  if (hasFailing && flags['not-a-fix'] !== undefined) usage('--failing-test (a fix) or --not-a-fix (not a fix), not both');
  let failing = null;
  if (hasFailing) {
    const m = /^(.+):(\d+)$/.exec(flags['failing-test']);
    if (!m) usage('--failing-test takes <file>:<count>');
    failing = { file: m[1], count: Number(m[2]), logName: path.basename(flags['failing-log']) };
    try {
      failing.text = fs.readFileSync(flags['failing-log'], 'utf8');
    } catch {
      failing.error = `cannot read ${flags['failing-log']}`;
    }
  }
  if (flags['not-a-fix'] !== undefined && !flags['not-a-fix'].trim()) usage('--not-a-fix needs a reason');

  const name = positional[0];
  const { dir, state } = loadWork(name, cwd);
  const kind = flags.kind;
  let select = null;
  let selectError = null;
  if (flags.select !== undefined) {
    try {
      select = JSON.parse(fs.readFileSync(flags.select, 'utf8'));
    } catch {
      selectError = `${flags.select} is missing or not JSON`;
    }
  }
  const { ok: kindOk } = F.checkKind(state.mode, kind);
  const git = G.finalizeFacts(state, { base: flags.base, reviewed: flags['reviewed-against'] }, kindOk, cwd);
  const proof = readProof(flags.proof);
  const { problems, receipt } = F.validate({
    name,
    kind,
    tier,
    state,
    texts: reportTexts(dir, state),
    select,
    selectError,
    git,
    flags: { allowNotReached: Boolean(flags['allow-not-reached']), staleBase: Boolean(flags['stale-base']), notAFix: flags['not-a-fix'], proof, failing },
    now: new Date().toISOString(),
  });
  if (problems.length) {
    console.error(`finalize refused: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`  - ${p}`);
    return 1;
  }
  // The proof goes into the receipt as proof.json through the working
  // directory publish copies. finalize never deletes its --proof input: a
  // --proof that is <work>/proof.json itself is left as it is; one elsewhere
  // is copied there, validated JSON pretty-printed, and a publish that fails
  // removes only that copy, leaving the review open as it was.
  const proofFile = path.join(dir, 'proof.json');
  const copied = Boolean(receipt.proof) && !samePath(flags.proof, proofFile);
  if (copied) fs.writeFileSync(proofFile, `${JSON.stringify(proof.json, null, 2)}\n`);
  const code = publish(dir, receipt, { failing, cwd });
  if (code === 1 && copied) fs.rmSync(proofFile, { force: true });
  return code;
}

// Whether two paths name one file (through symlinks when both exist).
function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

// ---- show and block ---------------------------------------------------------------

function lookup(arg, cwd) {
  let found;
  try {
    found = R.indexLookup(arg, { cwd });
  } catch (err) {
    refuse(err.message);
  }
  if (!found) refuse(`no receipt for ${arg}`);
  const rec = R.readReceipt(found.dir);
  if (!rec) refuse(`no receipt.json in ${found.dir}`);
  return { found, rec };
}

function cmdShow(args, cwd) {
  if (args.length !== 1) usage('show takes <key|name>');
  const { found, rec } = lookup(args[0], cwd);
  console.log(`receipt ${found.key}`);
  console.log(`  kind:     ${rec.kind}, tier ${rec.tier}, ${rec.mode === 'commit' ? rec.name : rec.branch} at ${R.short(rec.tip)} (found by ${found.via})`);
  console.log(`  dir:      ${found.dir}`);
  console.log(R.commitBlock(rec));
  return 0;
}

function cmdBlock(args, cwd) {
  if (args.length !== 1) usage('block takes <key|name>');
  const { rec } = lookup(args[0], cwd);
  console.log(R.commitBlock(rec));
  return 0;
}

// ---- main -------------------------------------------------------------------------

const COMMANDS = {
  init: cmdInit,
  position: cmdPosition,
  verdicts: cmdVerdicts,
  triage: cmdTriage,
  tests: cmdTests,
  externals: cmdExternals,
  verify: cmdVerify,
  finalize: cmdFinalize,
  show: cmdShow,
  block: cmdBlock,
};

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) usage('no subcommand');
  if (!Object.prototype.hasOwnProperty.call(COMMANDS, cmd)) usage(`unknown subcommand ${cmd}`);
  return COMMANDS[cmd](rest, repoRoot());
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`${USAGE}\n  (${err.message})`);
      process.exitCode = 2;
    } else {
      console.error(`review-receipt: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

module.exports = { main };
