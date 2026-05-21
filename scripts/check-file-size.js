'use strict';

// File-size guard. Two modes:
//   --staged : ratchet check for the pre-commit hook. A file over the hard cap
//              fails ONLY if this commit makes it longer than it is at HEAD.
//   --all    : full-tree RED / YELLOW report. Always exits 0.
// Thresholds, scope, and line counting are defined once and shared by both.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WARN_LIMIT = 700;
const FAIL_LIMIT = 1000;

// Source files the guard governs: server/ and client/src/ .js/.jsx, never tests.
// Matched against forward-slash paths: git emits them on every OS, and --all
// normalizes the filesystem walk to them before matching.
const SCOPE_RE = /^(server|client\/src)\/.+\.(js|jsx)$/;
const TEST_RE = /\.test\.(js|jsx)$/;

function inScope(relPath) {
  return SCOPE_RE.test(relPath) && !TEST_RE.test(relPath);
}

// Count lines the way `wc -l` does: the number of newline characters.
function countLines(content) {
  if (!content) return 0;
  let n = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') n += 1;
  }
  return n;
}

// Ratchet verdict for a staged file, from its new (staged) and old (HEAD) counts.
//   'fail' : over the hard cap AND this commit grows it
//   'note' : over the hard cap but flat or shrinking, so allowed
//   'warn' : in the soft-cap zone, non-blocking
//   'ok'   : under the soft cap
function classify(newCount, oldCount) {
  if (newCount > FAIL_LIMIT) {
    return newCount > oldCount ? 'fail' : 'note';
  }
  if (newCount > WARN_LIMIT) return 'warn';
  return 'ok';
}

// Absolute bucket for the --all report: a snapshot has no "old" to compare.
function bucket(count) {
  if (count > FAIL_LIMIT) return 'red';
  if (count > WARN_LIMIT) return 'yellow';
  return 'green';
}

module.exports = { inScope, countLines, classify, bucket, WARN_LIMIT, FAIL_LIMIT };

// ─── git helpers (used only when run as a script) ───────────────────────────

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // stdin ignored, stdout captured, stderr suppressed. A `git show HEAD:<path>`
    // miss for a newly added file is an expected non-zero exit (countHeadOrZero
    // catches it and returns 0); git's raw "fatal:" line must not leak into the
    // pre-commit hook output. Real failures still throw and are reported by the
    // top-level catch with a clean message.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// Line count of a file in the index (the staged blob).
function countStaged(relPath) {
  return countLines(git(['show', `:${relPath}`]));
}

// Line count of a file at HEAD. Returns 0 when the path is absent at HEAD (a
// newly added file, or the new name of a rename): `git show` exits non-zero in
// that case, and an uncaught throw would abort the whole pre-commit hook.
function countHeadOrZero(headPath) {
  try {
    return countLines(git(['show', `HEAD:${headPath}`]));
  } catch {
    return 0;
  }
}

// Staged source files, as { path, headPath }. `git diff --name-status -M`
// prints "R<score>\t<old>\t<new>" for renames and "<status>\t<path>" otherwise.
// For a rename, headPath is the OLD path so the HEAD lookup reads the
// pre-rename size and the rename is not misread as growth.
function stagedSourceFiles() {
  const out = git(['diff', '--cached', '--name-status', '--diff-filter=ACMR', '-M']);
  const files = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0];
    let p;
    let headPath;
    if (status[0] === 'R' || status[0] === 'C') {
      p = parts[2];
      headPath = parts[1];
    } else {
      p = parts[1];
      headPath = parts[1];
    }
    if (inScope(p)) files.push({ path: p, headPath });
  }
  return files;
}

// ─── modes ──────────────────────────────────────────────────────────────────

function runStaged() {
  const fails = [];
  const infos = [];
  for (const { path: p, headPath } of stagedSourceFiles()) {
    const newCount = countStaged(p);
    const oldCount = countHeadOrZero(headPath);
    const verdict = classify(newCount, oldCount);
    if (verdict === 'fail') {
      fails.push(`FAIL  ${p}: ${newCount} lines (was ${oldCount} at HEAD); over the ${FAIL_LIMIT}-line hard cap and growing.`);
    } else if (verdict === 'note') {
      infos.push(`note  ${p}: ${newCount} lines (over the cap but not growing; allowed).`);
    } else if (verdict === 'warn') {
      infos.push(`WARN  ${p}: ${newCount} lines (soft cap ${WARN_LIMIT}); plan a split.`);
    }
  }
  for (const line of infos) console.log(line);
  for (const line of fails) console.error(line);
  if (fails.length > 0) {
    console.error('');
    console.error(`${fails.length} file(s) over the ${FAIL_LIMIT}-line hard cap and growing.`);
    console.error('Split the file, or extract the new code to a sibling module, so this');
    console.error('commit does not make it longer. Genuine emergency: git commit --no-verify.');
    process.exitCode = 1;
  }
}

function walkSource(dirRel, acc) {
  const abs = path.join(ROOT, dirRel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const childRel = `${dirRel}/${entry.name}`; // forward slash, always
    if (entry.isDirectory()) {
      walkSource(childRel, acc);
    } else if (inScope(childRel)) {
      acc.push(childRel);
    }
  }
}

function runAll() {
  const files = [];
  walkSource('server', files);
  walkSource('client/src', files);
  const red = [];
  const yellow = [];
  for (const relPath of files) {
    const count = countLines(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
    const b = bucket(count);
    if (b === 'red') red.push({ relPath, count });
    else if (b === 'yellow') yellow.push({ relPath, count });
  }
  red.sort((a, b2) => b2.count - a.count);
  yellow.sort((a, b2) => b2.count - a.count);
  console.log(`File-size report: ${files.length} source files scanned`);
  console.log('');
  console.log(`RED (over ${FAIL_LIMIT}, must split): ${red.length}`);
  for (const r of red) console.log(`  ${String(r.count).padStart(5)}  ${r.relPath}`);
  console.log('');
  console.log(`YELLOW (${WARN_LIMIT} to ${FAIL_LIMIT}, plan a split): ${yellow.length}`);
  for (const y of yellow) console.log(`  ${String(y.count).padStart(5)}  ${y.relPath}`);
}

if (require.main === module) {
  try {
    if (process.argv.includes('--all')) runAll();
    else runStaged();
  } catch (err) {
    // Fail closed: if the guard itself errors, block the commit with a clear
    // message rather than crashing the hook with a raw stack trace or, worse,
    // letting the commit through. Catches any unexpected throw, including one
    // from countStaged (whose git call, unlike countHeadOrZero, has no
    // expected failure mode and so is intentionally left unwrapped).
    console.error(`check-file-size: unexpected error: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}
