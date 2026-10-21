#!/usr/bin/env node
'use strict';

/*
 * review-brief.js: the one brief every lens of a review reads (instruction
 * rewrite spec 2026-10-19, section 3.4; plan 2026-10-20 step 2, lane
 * review-tooling, the contract "The brief"). It renders
 * .claude/skills/review/brief-template.md into the review's working directory,
 * <git-common-dir>/drb-review/_work/<name>/ (scripts/lib/receipt.js workDir),
 * beside the receipt's own files.
 *
 *   node scripts/review-brief.js --branch <name> --select <select.json> --pre-steps <static.json>
 *        [--tests <log|run dir>...] [--smoke <run dir>] [--build <log> --exit <code>]
 *        [--artifact <path>] [--captures <png>...] [--plan <path>] [--spec <path>]
 *        [--settled <file>] [--overlap <sha>]
 *
 * --branch is the review's working name (the branch, commit-<sha7> or
 * quick-fix-<timestamp>, as review-receipt.js init printed it); the review
 * must be open. --select is review-select.js's output and --pre-steps
 * static-checks.js's; a pre-step result with a blocking finding stops the brief
 * (an allowed finding is shown as established). --tests takes TAP logs and run
 * directories (a summary.json, run-suites'), --smoke the smoke's run
 * directory, --build and --exit the client build's log and exit code (as
 * review-receipt.js tests --build <log> --exit <code> takes them). --settled is a
 * file of questions already settled, masked into Established. --overlap
 * passes through to position (the stale-base overlap pass, spec 3.8).
 *
 * What it writes, in this order, after every input has been read and checked:
 *   1. `node scripts/review-receipt.js position <name>` runs right before the
 *      diff is written, so the snapshot the stored reports carry is the input
 *      the lenses read; its line `position <seq> tip <sha7>` is printed first,
 *      and the seq is what verdicts, verify and tests take as --position. A
 *      tip (or a staged tree) other than the one review-select read is
 *      refused: run review-select again.
 *   2. diff.patch: the commit list, the stat and the diff with ten lines of
 *      context, a binary file as one Binary files line, git's attributes
 *      pinned to the empty tree so no committed attribute hides a file (a quick fix: HEAD against the staged tree review-select
 *      recorded, tree to tree, never the live index; its coverage and laws
 *      are read from that tree too) (no renames, so every file of the receipt's coverage is one
 *      section), written THROUGH `node scripts/lib/piiShapes.js --mask-diff`:
 *      the unmasked diff is never written, and the lens reads the masked file.
 *   3. brief.md, the sections of the contract in order: Review, Tier and why,
 *      Files (the receipt's coverage set: the diff's files but README.md and
 *      ARCHITECTURE.md), Diff, Plan and spec, Established (built by
 *      scripts/lib/reviewBriefEstablished.js: names through piiShapes.maskPath,
 *      nothing a summary or a pre-step result holds adds a line, and the code
 *      files diff.patch shows only as Binary files lines), Triggers that fired
 *      for you, Money laws (docs/money-laws.md as written, PII-masked by its
 *      own path, fenced, when the money lens or the externals run; from the
 *      tree under review, else from refs/heads/main, and the section says
 *      which), Design
 *      artifact and captures (the client lens only), Budget (30 plus 5 per
 *      file, capped at 150), Standing lines, Output (with the collapse
 *      instruction, ## Lens: <name> per lens, when select.json says collapse).
 * A diff over 4,000 lines is split by area up front: the files are grouped by
 * their top directory, a group over the limit by the next directory down
 * (neither a file nor two sections of one path is ever split), and the groups
 * packed in path order into parts of at most 4,000 lines. A diff that packs
 * into one part is written whole, and the output says it could not be split.
 * Otherwise each part gets brief.part-<n>.md and
 * diff.part-<n>.patch with its own file list, no brief.md is written, and the
 * output names the split. A refusal on an open review leaves no earlier brief
 * or diff: once the review is found open, the brief and diff files of an
 * earlier run are removed before anything else is read. An argv misuse
 * (exit 2), a working name that is not usable, an unreadable receipt.json or a
 * review that is not open stops before anything is known and leaves the
 * directory as it was.
 *
 * A path of the diff (git's --name-only -z list, and every section's path)
 * that holds a control, format, line-separator or pipe character, that
 * sensitive-match's normalize would spell another way, or that carries a PII
 * shape (piiShapes.pathHits) is refused before position, named by its index
 * in git's list (review-select's pathRefusal): every path-derived value, the
 * lists, the split's areas and the console lines, is written as git names it.
 *
 * The brief carries no raw line of the diff: content-rule hits are listed as
 * file:line and rule, and the pre-step texts are masked again by their path
 * (already-masked text is unchanged). The console carries paths and counts
 * only; a child's stderr is relayed masked under the strict class.
 *
 * Exit 0 written, 1 refused (one reason on stderr, nothing written), 2 argv
 * misuse. The repo is the one this script lives in; REVIEW_RECEIPT_ROOT names
 * another, as for review-receipt.js and review-select.js.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const SM = require('./sensitive-match');
const R = require('./lib/receipt');
const { mask } = require('./lib/piiShapes');
const { established, binaryCodeSections } = require('./lib/reviewBriefEstablished');
const { unquote } = require('./lib/lensTriggers');
const { pathRefusal, diffNames } = require('./review-select');

const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(REPO_ROOT, '.claude', 'skills', 'review', 'brief-template.md');
const RECEIPT_CLI = path.join(__dirname, 'review-receipt.js');
const PII_CLI = path.join(__dirname, 'lib', 'piiShapes.js');
const LAWS = 'docs/money-laws.md';
const SPLIT_LIMIT = 4000;
const MAX_BUFFER = 512 * 1024 * 1024;
const REPO_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR'];
const USAGE = [
  'usage: review-brief.js --branch <name> --select <select.json> --pre-steps <static.json>',
  '         [--tests <log|run dir>...] [--smoke <run dir>] [--build <log> --exit <code>]',
  '         [--artifact <path>] [--captures <png>...] [--plan <path>] [--spec <path>] [--settled <file>] [--overlap <sha>]',
].join('\n');

class UsageError extends Error {}
class Refusal extends Error {}
const refuse = (why) => {
  throw new Refusal(why);
};

// ---- the template -----------------------------------------------------------------

/**
 * Render a template: each {{#key}} ... {{/key}} block (its tags on their own
 * lines) is kept when blocks[key] is true and dropped when false, then every
 * {{key}} takes values[key] in one pass, so a value is never read again. A
 * block or a value the template names and the caller does not is an error.
 */
function renderTemplate(template, values, blocks) {
  const kept = template.replace(/^\{\{#(\w+)\}\}\n([\s\S]*?)^\{\{\/\1\}\}\n/gm, (_, key, inner) => {
    if (typeof blocks[key] !== 'boolean') throw new Error(`brief-template: no value for the block ${key}`);
    return blocks[key] ? inner : '';
  });
  if (/\{\{[#/]/.test(kept)) throw new Error('brief-template: a block tag that does not pair');
  // The blank lines a dropped block leaves are tidied in the template, before
  // any value goes in, so a value (the money laws) is inserted verbatim.
  return kept.replace(/\n{3,}/g, '\n\n').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (values[key] === undefined || values[key] === null) throw new Error(`brief-template: no value for ${key}`);
    return String(values[key]);
  });
}

function budget(files) {
  return Math.min(150, 30 + 5 * files);
}

// ---- the split ----------------------------------------------------------------------

// The area of a path at a depth: its first `depth` directories, '(root)' for a
// file at the top; past its own directory depth, the path itself.
function areaAt(p, depth) {
  const dirs = p.split('/').slice(0, -1);
  if (depth > dirs.length) return dirs.length === 0 && depth === 1 ? '(root)' : p;
  return dirs.slice(0, depth).join('/');
}

function groupsOf(sections, depth, limit) {
  const by = new Map();
  for (const s of sections) {
    const a = areaAt(s.path, depth);
    if (!by.has(a)) by.set(a, []);
    by.get(a).push(s);
  }
  const out = [];
  for (const area of [...by.keys()].sort()) {
    const secs = by.get(area);
    const lines = secs.reduce((n, s) => n + s.lines, 0);
    // Descend only while a deeper area can still separate the sections: two
    // sections of one path (a typechange is a delete and an add) stay together.
    if (lines > limit && new Set(secs.map((x) => x.path)).size > 1) out.push(...groupsOf(secs, depth + 1, limit));
    else out.push({ area, sections: secs, lines });
  }
  return out;
}

/**
 * Split diff sections ({path, lines}) by area into parts of at most `limit`
 * lines where the areas allow: [{areas, paths, lines, sections}] in path order.
 */
function splitByArea(sections, limit = SPLIT_LIMIT) {
  const parts = [];
  let cur = null;
  for (const g of groupsOf(sections, 1, limit)) {
    if (cur && cur.lines + g.lines > limit) {
      parts.push(cur);
      cur = null;
    }
    if (!cur) cur = { areas: [], paths: [], lines: 0, sections: [] };
    cur.areas.push(g.area);
    cur.sections.push(...g.sections);
    cur.paths.push(...g.sections.map((s) => s.path));
    cur.lines += g.lines;
  }
  if (cur) parts.push(cur);
  return parts;
}

// ---- git and the diff ----------------------------------------------------------------

function git(root, args, env = SM.gitEnv()) {
  return execFileSync('git', args, { cwd: root, env, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'pipe'] });
}

// git with attributes pinned the way scripts/lib/receipt.js keys its diffs:
// no system or global attributes file, and the attribute source the empty
// tree, so a -diff or binary attribute a lane commits cannot turn a code file
// into one Binary files line while the triggers read its content. The same
// caveat as receipt.js: git still reads $GIT_COMMON_DIR/info/attributes and
// has no switch for it (measured 2026-10-21), so the template makes a code
// file shown as a Binary files line a finding the lens names.
function pinnedGit(root, args) {
  const env = { ...SM.gitEnv(), GIT_ATTR_NOSYSTEM: '1' };
  delete env.GIT_ATTR_SOURCE;
  const empty = git(root, ['hash-object', '-t', 'tree', '/dev/null']).trim();
  return git(root, ['-c', 'core.attributesFile=/dev/null', `--attr-source=${empty}`, ...args], env);
}

function tryGit(root, args) {
  try {
    return git(root, args).trim();
  } catch {
    return null;
  }
}

// The path a diff section names (no renames: one path): the +++ side, else
// the --- side, else the symmetric header; null when none reads. It is the
// path exactly as git names it (C-quoting undone, the tab git adds after a
// name with a space dropped, nothing trimmed or rewritten), so it equals the
// coverage names of the -z reads.
function sectionPath(lines) {
  const side = (raw, prefix) => {
    let s = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
    if (s.startsWith('"')) s = unquote(s);
    return s && s.startsWith(prefix) && s.length > prefix.length ? s.slice(prefix.length) : null;
  };
  let header = null;
  for (const l of lines) {
    if (l.startsWith('@@')) break;
    if (l.startsWith('+++ ')) {
      const p = side(l.slice(4), 'b/');
      if (p) return p;
    }
    if (l.startsWith('--- ')) header = side(l.slice(4), 'a/') || header;
  }
  if (header) return header;
  const rest = lines[0].slice('diff --git '.length);
  const q = /^"((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest);
  if (q) return side(`"${q[2]}"`, 'b/');
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && n > 0 && rest === `a/${rest.slice(2, 2 + n)} b/${rest.slice(2, 2 + n)}`) return rest.slice(2, 2 + n);
  return null;
}

// [{path, start, end, lines}] over the body's lines (end exclusive).
function sectionsOf(lines) {
  const starts = [];
  lines.forEach((l, i) => {
    if (l.startsWith('diff --git ')) starts.push(i);
  });
  return starts.map((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
    return { path: sectionPath(lines.slice(start, end)) || `(unreadable section ${k + 1})`, start, end, lines: end - start };
  });
}

// What a review reads: base..tip for a range; for a quick fix, HEAD against
// the staged tree review-select recorded (tree to tree), never the live index.
const reviewTree = (sel) => (sel.mode === 'staged' ? sel.tree : sel.tip);
const diffTarget = (sel) => ['--end-of-options', sel.mode === 'staged' ? sel.tip : sel.base, reviewTree(sel)];

// The receipt's coverage set over the same two points.
function coverageOf(root, sel) {
  return sel.mode === 'staged' ? R.filesBetweenTrees(sel.tip, sel.tree, { cwd: root }) : R.filesBetween(sel.base, sel.tip, { cwd: root });
}

// docs/money-laws.md from the tree under review, else from refs/heads/main (a
// commit older than the laws), with where they came from; neither refuses.
function readLaws(root, sel) {
  const blob = (rev) => {
    try {
      return git(root, ['cat-file', 'blob', `${rev}:${LAWS}`]);
    } catch {
      return null;
    }
  };
  const own = blob(reviewTree(sel));
  if (own !== null) return { text: own, source: 'from the tree under review' };
  const main = tryGit(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}']);
  const fromMain = main ? blob(main) : null;
  if (fromMain !== null) return { text: fromMain, source: `from refs/heads/main at ${R.short(main)}, because the tree under review has none` };
  return refuse(`${LAWS} is in neither the tree under review nor refs/heads/main; the money lens and the externals need it`);
}

// The commit list and stat (the preamble) and the -U10 body of the reviewed diff.
function rawDiff(root, sel) {
  const staged = sel.mode === 'staged';
  const target = diffTarget(sel);
  // The pinned flags but --text: a binary file is one Binary files ... differ
  // line, never its bytes as text.
  const flags = [...SM.GIT_DIFF_FLAGS.filter((f) => f !== '--text'), '--no-renames'];
  let commits;
  if (staged) {
    commits = [`Staged changes on HEAD ${R.short(sel.tip)} (tree ${R.short(sel.tree)}).`];
  } else {
    commits = git(root, ['log', '--no-color', '--no-decorate', '--format=%h %s', '--end-of-options', `${sel.base}..${sel.tip}`, '--']).split('\n').filter(Boolean);
  }
  const stat = pinnedGit(root, ['diff', ...flags, '--stat=160', ...target, '--']);
  const body = pinnedGit(root, ['diff', ...flags, '--unified=10', ...target, '--']);
  const preamble = `Commits (${commits.length}):\n${commits.join('\n')}\n\nStat:\n${stat}${stat.endsWith('\n') ? '' : '\n'}\n`;
  return { preamble, body };
}

// A child's stderr, relayed masked under the strict class.
function relay(stderr) {
  if (stderr) process.stderr.write(mask(String(stderr), { strict: true }));
}

// The diff through the mask child; any failure (an exit, a signal, nothing
// or a different number of lines back) refuses, so the unmasked diff is never
// written and no position is taken.
function maskDiffText(text, root, spawn) {
  const r = spawn(process.execPath, [PII_CLI, '--mask-diff'], { cwd: root, input: text, encoding: 'utf8', maxBuffer: MAX_BUFFER });
  relay(r.stderr);
  const out = typeof r.stdout === 'string' ? r.stdout : '';
  if (r.error) refuse(`piiShapes.js --mask-diff could not run (${r.error.code || r.error.message}); nothing was written`);
  if (r.status !== 0 || r.signal) refuse(`piiShapes.js --mask-diff failed (${r.signal ? `signal ${r.signal}` : `exit ${r.status}`}); nothing was written`);
  if (text && !out) refuse('piiShapes.js --mask-diff returned nothing; nothing was written');
  if (out.split('\n').length !== text.split('\n').length) refuse('piiShapes.js --mask-diff changed the line count; nothing was written');
  return out;
}

// ---- inputs ------------------------------------------------------------------------------

const isObject = (o) => Boolean(o) && typeof o === 'object' && !Array.isArray(o);

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return refuse(`${what} ${file} is missing or not JSON`);
  }
}

function checkSelect(sel) {
  const p = [];
  if (!isObject(sel)) return ['not an object'];
  if (!SM.TIER_ORDER.includes(sel.tier)) p.push('no tier');
  if (!isObject(sel.tiers_by_file)) p.push('no tiers_by_file');
  if (!Array.isArray(sel.lenses) || !sel.lenses.every((l) => isObject(l) && typeof l.name === 'string' && Array.isArray(l.fired_because))) p.push('no lenses with fired_because');
  if (!R.KEY_RE.test(String(sel.tip))) p.push('no full tip');
  if (sel.mode === 'range' && !R.KEY_RE.test(String(sel.base))) p.push('no full base');
  if (sel.mode === 'staged' && !/^[0-9a-f]{40,64}$/.test(String(sel.tree))) p.push('no staged tree');
  if (sel.mode !== 'range' && sel.mode !== 'staged') p.push('no mode');
  if (!isObject(sel.tests) || !Array.isArray(sel.tests.suites)) p.push('no tests');
  if (!Array.isArray(sel.floors)) p.push('no floors');
  return p;
}

function checkStatic(pre) {
  if (!isObject(pre) || !Array.isArray(pre.findings) || !Number.isInteger(pre.blocking)) refuse('the pre-step result is not static-checks.js output ({findings, blocking, ...})');
  if (pre.blocking > 0) refuse(`static-checks reports ${pre.blocking} blocking finding(s); fix them before the brief (an allowed finding is fine)`);
}

// ---- the sections ------------------------------------------------------------------------

const list = (items, empty = '- none') => (items.length ? items.map((i) => `- ${i}`).join('\n') : empty);

// The Files list: each file with its section number(s) in the brief's diff
// file, counted from the top, so two files whose masked headers read alike
// (two snapshots named by ids) are told apart.
function filesList(files, secs) {
  const at = new Map();
  secs.forEach((x, i) => at.set(x.path, [...(at.get(x.path) || []), i + 1]));
  const which = (n) => (n.length === 0 ? 'no section in the diff file' : n.length === 1 ? `section ${n[0]}` : `sections ${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`);
  return list(files.map((f) => `${f} (${which(at.get(f) || [])})`), "- none: the diff changes only files outside the receipt's coverage");
}

function triggersText(sel) {
  if (sel.lenses.length === 0) return '- No lens is selected: a docs-only diff runs none.';
  return sel.lenses
    .map((l) => {
      const names = l.fired_because.filter((n) => n !== 'floor');
      return `- ${l.name}${l.fired_because.includes('floor') ? ' (floor)' : ''}: ${names.length ? names.join(', ') : 'no trigger fired'}`;
    })
    .join('\n');
}

function planText(sel, opts) {
  const plan = opts.plan || (sel.plan && sel.plan.path) || null;
  const lane = sel.plan && sel.plan.lane;
  const out = [`- Plan: ${plan ? `${plan}${lane ? `, lane ${lane}` : ''}` : 'none given'}`, `- Spec: ${opts.spec || 'none given'}`];
  if (sel.plan) {
    out.push(`- The lane's lenses line (the forecast): ${sel.plan.lenses_line === null ? 'none' : mask(String(sel.plan.lenses_line), { strict: true })}`);
    out.push(`- Unforecast lenses, selected but not named by the lane: ${(sel.unforecast_lenses || []).join(', ') || 'none'}`);
  }
  return out.join('\n');
}

function designText(opts) {
  const out = [
    opts.artifact
      ? `Artifact: ${opts.artifact}. Judge adherence to it, not only usability: a surface that works but is off the design is a finding, not a pass.`
      : 'No design artifact was given for this surface: judge the client checks on the code and the captures.',
    '',
    'Captures the main session took at 320 and 390 wide (a subagent cannot sign in to the dev app, so judge the captures and the static render, never a live admin page):',
    list(opts.captures, '- None were given.'),
  ];
  return out.join('\n');
}

function fenced(text) {
  const runs = text.match(/`+/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}markdown\n${text.endsWith('\n') ? text : `${text}\n`}${fence}`;
}

// ---- the run -----------------------------------------------------------------------------

function expectedTip(root, state) {
  if (state.mode === 'commit') return state.commit;
  return tryGit(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${state.mode === 'quick-fix' ? 'HEAD' : `refs/heads/${state.name}`}^{commit}`]);
}

function checkPlace(root, state, sel) {
  const tip = expectedTip(root, state);
  const what = state.mode === 'lane' ? `branch ${state.name}` : state.mode === 'commit' ? 'commit under review' : 'HEAD';
  if (tip !== sel.tip) refuse(`select.json was read at ${R.short(sel.tip)}; the ${what} is ${tip ? R.short(tip) : 'gone'}: run review-select again`);
  if (sel.mode === 'staged' && tryGit(root, ['write-tree']) !== sel.tree) refuse('the staged tree moved since review-select read it: run review-select again');
}

function runPosition(root, name, overlap, spawn) {
  const env = root === REPO_ROOT ? process.env : { ...process.env, REVIEW_RECEIPT_ROOT: root };
  const r = spawn(process.execPath, [RECEIPT_CLI, 'position', name, ...(overlap ? ['--overlap', overlap] : [])], { cwd: root, env, encoding: 'utf8' });
  relay(r.stderr);
  if (r.error) refuse(`review-receipt.js position could not run (${r.error.code || r.error.message}); nothing was written`);
  const m = /^position (\d+) tip ([0-9a-f]{7,})$/m.exec(r.stdout || '');
  if (r.status !== 0 || !m) refuse(`review-receipt.js position refused (${r.signal ? `signal ${r.signal}` : `exit ${r.status}`}); nothing was written`);
  return { seq: Number(m[1]), tip7: m[2], line: m[0] };
}

function clearOld(dir) {
  for (const f of fs.readdirSync(dir)) {
    if (/^brief(\.part-\d+)?\.md$/.test(f) || /^diff(\.part-\d+)?\.patch$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

/**
 * Write the brief. `deps.spawnSync` stands in for the child spawn (the mask
 * and position children), for the tests only; the CLI never sets it.
 */
function writeBrief(opts, root, deps = {}) {
  const spawn = deps.spawnSync || spawnSync;
  let dir;
  try {
    dir = R.workDir(opts.branch, { cwd: root });
  } catch (err) {
    throw new UsageError(err.message);
  }
  const state = R.readReceipt(dir);
  if (!state || state.state !== 'working') refuse(`no open review named ${opts.branch}; run review-receipt.js init first`);
  // An earlier run's brief and diff go first, so a refusal below leaves none.
  clearOld(dir);
  const sel = readJson(opts.select, 'select.json');
  const bad = checkSelect(sel);
  if (bad.length) refuse(`select.json is not review-select.js output: ${bad.join('; ')}`);
  const pre = readJson(opts.preSteps, 'the pre-step result');
  checkStatic(pre);
  if ((state.mode === 'quick-fix') !== (sel.mode === 'staged')) refuse(`a ${state.mode} review takes a select.json read ${state.mode === 'quick-fix' ? 'with --staged' : 'over --base and --tip'}`);
  checkPlace(root, state, sel);

  const names = sel.lenses.map((l) => l.name);
  const needLaws = names.includes('money') || sel.externals === true;
  const laws = needLaws ? readLaws(root, sel) : null;
  const client = names.includes('client');
  if (!client && (opts.artifact || opts.captures.length)) process.stderr.write('review-brief: the client lens is not selected; --artifact and --captures are left out of the brief\n');
  const coverage = coverageOf(root, sel);

  const { preamble, body } = rawDiff(root, sel);
  const bodyRaw = body.split('\n');
  if (bodyRaw[bodyRaw.length - 1] === '') bodyRaw.pop();
  const sections = sectionsOf(bodyRaw);
  // Every path-derived value below is written as git names it, so a path that
  // holds a control character or a PII shape stops the brief here.
  const unsafe = pathRefusal([...diffNames(root, diffTarget(sel)), ...sections.map((x) => x.path)]);
  if (unsafe) refuse(unsafe);
  const est = established({ pre, opts, sel, binary: binaryCodeSections(bodyRaw, sections) });
  const masked = maskDiffText(preamble + body, root, spawn).split('\n');
  const preLines = preamble.split('\n').length - 1;
  const maskedPre = masked.slice(0, preLines);
  const maskedBody = masked.slice(preLines, preLines + bodyRaw.length);
  const parts = bodyRaw.length > SPLIT_LIMIT ? splitByArea(sections, SPLIT_LIMIT) : null;
  // A split into one part is no split: the brief is written whole.
  const split = parts && parts.length > 1 ? parts : null;

  // The snapshot, right before the diff is written; then nothing may have moved.
  const pos = runPosition(root, opts.branch, opts.overlap, spawn);
  if (!sel.tip.startsWith(pos.tip7)) refuse(`position snapshotted ${pos.tip7}, not the tip select.json read (${R.short(sel.tip)}): run review-select again`);
  checkPlace(root, state, sel);

  const diffFile = path.join(dir, 'diff.patch');
  fs.writeFileSync(diffFile, `${masked.join('\n')}`);

  const inDiff = new Set(sections.map((s) => s.path));
  const generated = R.GENERATED_DOCS.filter((d) => inDiff.has(d) && !coverage.includes(d));
  const common = {
    name: opts.branch,
    kind: state.mode,
    branch: state.branch || (state.mode === 'quick-fix' ? 'none: a staged quick fix' : 'none recorded'),
    tip: sel.tip,
    position: `seq ${pos.seq}, tip ${pos.tip7} (review-receipt.js position, taken right before the diff was written)`,
    reviewed_against: sel.mode === 'staged' ? `HEAD ${sel.tip} with the staged tree ${R.short(sel.tree)}` : sel.base,
    split_limit: SPLIT_LIMIT.toLocaleString('en-US'),
    tier: sel.tier,
    floors: sel.floors.join(', ') || 'none',
    externals: sel.externals ? 'yes' : 'no',
    verify: sel.verify ? 'yes' : 'no',
    matched_paths: list((sel.matched_paths || []).map((m) => `${m.path} (section ${m.section}, pattern ${m.pattern})`)),
    content_rule_hits: list((sel.content_rule_hits || []).map((h) => `${h.file === null ? '(a section with no readable path)' : h.file}:${h.line} ${h.rule}`)),
    tiers_by_file: list(Object.keys(sel.tiers_by_file).sort().map((f) => `${f}: ${sel.tiers_by_file[f]}`)),
    files_note: generated.length ? ` ${generated.join(' and ')} ${generated.length === 1 ? 'is' : 'are'} in the diff but outside this list: generated docs, outside the receipt's coverage.` : '',
    plan_and_spec: planText(sel, opts),
    established: est,
    triggers: triggersText(sel),
    // Masked by its own path (the docs class keeps the business literals).
    money_laws: laws === null ? '' : fenced(mask(laws.text, { path: LAWS })),
    laws_source: laws === null ? '' : laws.source,
    design: client ? designText(opts) : '',
    collapse_headings: names.map((n) => `\`## Lens: ${n}\``).join(', '),
  };
  const blocks = { money_laws: needLaws, design: client, collapse: sel.collapse === true };
  const template = fs.readFileSync(TEMPLATE, 'utf8');
  const render = (files, secs, extra, part) => renderTemplate(template, { ...common, files: filesList(files, secs), budget: budget(files.length), ...extra }, { ...blocks, part });

  const out = [pos.line];
  if (!split) {
    const file = path.join(dir, 'brief.md');
    fs.writeFileSync(file, render(coverage, sections, { part_title: '', diff_path: diffFile, part_number: '', part_count: '', part_areas: '' }, false));
    out.push(parts ? `brief: the diff is ${bodyRaw.length} lines, over ${SPLIT_LIMIT} lines and cannot be split by area (one area or one file): ${file}` : `brief: ${file}`);
  } else {
    out.push(`brief: the diff is ${bodyRaw.length} lines, over ${SPLIT_LIMIT}: split by area into ${split.length} parts`);
    const placed = new Set(split.flatMap((p) => p.paths));
    split.forEach((part, i) => {
      const n = i + 1;
      const files = coverage.filter((f) => part.paths.includes(f) || (n === split.length && !placed.has(f)));
      const partDiff = path.join(dir, `diff.part-${n}.patch`);
      const lines = [...maskedPre, ...part.sections.flatMap((s) => maskedBody.slice(s.start, s.end)), ''];
      fs.writeFileSync(partDiff, lines.join('\n'));
      const file = path.join(dir, `brief.part-${n}.md`);
      fs.writeFileSync(file, render(files, part.sections, { part_title: ` (part ${n} of ${split.length})`, diff_path: partDiff, part_number: n, part_count: split.length, part_areas: part.areas.join(', ') }, true));
      out.push(`  part ${n}: ${file} (${part.areas.join(', ')}, ${files.length} file(s)), diff ${partDiff}`);
    });
  }
  out.push(`diff: ${diffFile}`);
  return out.join('\n');
}

// ---- CLI -----------------------------------------------------------------------------------

const FLAGS = {
  '--branch': 'value',
  '--select': 'value',
  '--pre-steps': 'value',
  '--tests': 'list',
  '--smoke': 'value',
  '--build': 'value',
  '--exit': 'value',
  '--artifact': 'value',
  '--captures': 'list',
  '--plan': 'value',
  '--spec': 'value',
  '--settled': 'value',
  '--overlap': 'value',
};

function parseArgs(argv) {
  const f = { tests: [], captures: [] };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const kind = FLAGS[a];
    if (!kind) throw new UsageError(`unknown argument ${a}`);
    const key = a.slice(2);
    if (kind === 'list') {
      let n = 0;
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        f[key].push(argv[++i]);
        n++;
      }
      if (n === 0) throw new UsageError(`${a} needs at least one value`);
      continue;
    }
    if (seen.has(key)) throw new UsageError(`${a} given twice`);
    seen.add(key);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
    f[key] = v;
  }
  for (const req of ['branch', 'select', 'pre-steps']) if (f[req] === undefined) throw new UsageError(`--${req} is required`);
  if ((f.build === undefined) !== (f.exit === undefined)) throw new UsageError('--build <log> and --exit <code> go together');
  if (f.exit !== undefined && !/^\d{1,3}$/.test(f.exit)) throw new UsageError('--exit takes the build\'s exit code, a whole number');
  return {
    branch: f.branch,
    select: f.select,
    preSteps: f['pre-steps'],
    tests: f.tests,
    smoke: f.smoke,
    build: f.build,
    buildExit: f.exit,
    artifact: f.artifact,
    captures: f.captures,
    plan: f.plan,
    spec: f.spec,
    settled: f.settled,
    overlap: f.overlap,
  };
}

function repoRoot() {
  const env = process.env.REVIEW_RECEIPT_ROOT;
  if (env) {
    process.stderr.write(`review-brief: repo ${path.resolve(env)} (REVIEW_RECEIPT_ROOT)\n`);
    return path.resolve(env);
  }
  return REPO_ROOT;
}

function main(argv) {
  for (const k of REPO_VARS) delete process.env[k];
  try {
    const opts = parseArgs(argv);
    process.stdout.write(`${writeBrief(opts, repoRoot())}\n`);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${USAGE}\n  (${err.message})\n`);
      return 2;
    }
    process.stderr.write(`review-brief: ${String((err && err.message) || err).split('\n')[0]}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { renderTemplate, budget, splitByArea, sectionsOf, areaAt, rawDiff, coverageOf, readLaws, writeBrief, parseArgs, main };
