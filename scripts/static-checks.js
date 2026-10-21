#!/usr/bin/env node
'use strict';

// static-checks: the mechanical pre-step the review skill runs before any lens
// (instruction rewrite spec 2026-10-19, 3.3; plan 2026-10-20, lane
// static-checks). The greps that used to be security-review prose (lens audit
// section 7) run here over the changed files only.
//
//   node scripts/static-checks.js --base <sha> --tip <sha>
//   node scripts/static-checks.js --staged
//
// Output, one JSON object on stdout:
//
//   {
//     findings: [{rule, file, line, text, blocking, allowed?}],
//     blocking: n,       the findings with blocking true
//     allowed: n,        the findings an allow marker downgraded (allowed: true)
//     files: n,          the changed files in the diff
//     eslint_files: n    the files eslint really linted (0: none, or it did not run)
//   }
//
// `text` is the flagged line (or the reason), PII-masked and then capped at
// 300 characters, so a transcript never carries a real value; a literal that
// secret-default, jwt-literal-secret or env-default flags prints as <LITERAL>
// in every finding's text on its line, any rule's, eslint's and pii's. `file` is
// repo-relative; `line` is the new-file line. Findings that say a check did
// not run are blocking, never a pass:
//   scan, line null or the error's line   a JS file espree cannot tokenize, a
//                                         package.json that is not JSON, or a
//                                         JS file or package.json git cannot
//                                         hand over as a blob, or a path
//                                         refused at parse time (an empty, .
//                                         or .. component; file null when the
//                                         path did not parse)
//   eslint-undef, line null               "eslint did not run: <why>", one per
//                                         target file eslint did not lint
//   pii, file null, line null             the pii pre-step did not run
//   did-not-run, file null, line null     "static-checks did not run: <why>":
//                                         not in a git repo, a git command
//                                         failed, an unexpected throw, or a
//                                         SIGTERM or SIGINT (eslint is killed
//                                         and its temp dir removed first)
// eslint runs under a 120 s timeout; a timeout is an eslint did-not-run.
// env-ignored findings carry line null (a whole tracked file).
//
// Exit 0 when blocking is 0, 1 when it is not (every did-not-run finding
// blocks, so every failure exits 1 with the JSON printed), 2 only on argv
// misuse: an unknown or repeated flag, a missing value, --staged with --base or
// --tip, or a --base or --tip that names no commit (nothing is printed on
// stdout then).
//
// This file holds the CLI, git, diff parsing, env-ignored, pii and the output.
// The rest lives in scripts/lib/staticChecks/: jsScan.js (the code view),
// staticRules.js (the per-file rules and the allow marker), envDefaults.js and
// packageJson.js (the readers two rule pairs share) and eslintUndef.js.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkFile, maskedText, maskedPath, maskFailure, redactedLine, RULES } = require('./lib/staticChecks/staticRules');
const { lineStarts } = require('./lib/staticChecks/jsScan');
const { eslintUndef, abortAll } = require('./lib/staticChecks/eslintUndef');

const USAGE = 'usage: static-checks.js --base <sha> --tip <sha> | --staged\n';

// ---- git -------------------------------------------------------------------
// The user's diff environment never shapes the diff: no external diff, no
// textconv, no color, fixed a/ and b/ prefixes, renames found, paths unquoted
// where git allows. GIT_DIFF_OPTS and GIT_EXTERNAL_DIFF are dropped.
// --inter-hunk-context=0 overrides a diff.interHunkContext in the config,
// which would merge nearby hunks and put unchanged lines inside one: the
// eslint delta's base-line map (baseLineOf) reads every hunk line as changed.

const GIT_ENV = (() => {
  const env = { ...process.env };
  delete env.GIT_DIFF_OPTS;
  delete env.GIT_EXTERNAL_DIFF;
  // A replace ref would swap the blob and the diff read under the real sha.
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
})();

const DIFF_FLAGS = Object.freeze(['--no-color', '--no-ext-diff', '--no-textconv', '--text', '--unified=0',
  '--inter-hunk-context=0', '--no-relative', '--find-renames', '--src-prefix=a/', '--dst-prefix=b/']);

function git(root, args, { buffer = false, input } = {}) {
  const stdin = input === undefined ? undefined : Buffer.from(input, 'utf8');
  return spawnSync('git', args, { cwd: root, env: GIT_ENV, encoding: buffer ? 'buffer' : 'utf8', input: stdin, maxBuffer: 1024 * 1024 * 1024 });
}

// Argv misuse is the only exit 2. Every other failure (git, cat-file, eslint,
// the pii pre-step, a throw, a signal) is a blocking did-not-run finding in the
// JSON and exit 1, so a caller can never read a check that did not run as a
// pass.
function usage(msg = '') {
  process.stderr.write(msg + USAGE);
  process.exit(2);
}

function gitFailed(what) {
  return new Error(`git ${what} failed`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--staged' && !out.staged) {
      out.staged = true;
    } else if ((a === '--base' || a === '--tip') && out[a.slice(2)] === undefined && i + 1 < argv.length) {
      out[a.slice(2)] = argv[++i];
    } else {
      return null;
    }
  }
  if (out.staged) return out.base === undefined && out.tip === undefined ? { staged: true } : null;
  return out.base !== undefined && out.tip !== undefined ? { base: out.base, tip: out.tip } : null;
}

// The full sha of `ref` when it names a commit, else null. --end-of-options
// keeps an option-shaped ref (--output=<path>) from ever reading as an option.
function resolveCommit(root, ref) {
  const res = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const sha = res.status === 0 ? String(res.stdout).trim() : '';
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

function repoRoot() {
  const res = spawnSync('git', ['rev-parse', '--show-toplevel'], { env: GIT_ENV, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function readDiff(root, mode) {
  const range = mode.staged ? ['--cached', '--end-of-options', '--'] : ['--end-of-options', mode.base, mode.tip, '--'];
  const res = git(root, ['-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS, ...range]);
  if (res.status !== 0 || res.error) throw gitFailed('diff');
  return res.stdout;
}

// ---- diff parsing ----------------------------------------------------------

// Paths come from the `diff --git` header and the rename and copy lines, never
// from the ---/+++ lines: git ends those with a TAB when the path holds a
// space, so `+++ b/my helper.js` would read as "my helper.js<TAB>". A path is
// bare, or C-quoted when it holds a quote, a backslash or a control character.
// unquoteC, closingQuote and the header split are local copies of the same
// helpers in scripts/lib/piiShapes.js, which does not export them.

const C_ESCAPES = Object.freeze({ a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 });

// One C-quoted token decoded to a string, or null when it is not well formed.
function unquoteC(token) {
  if (token.length < 2 || token[0] !== '"' || token[token.length - 1] !== '"') return null;
  const bytes = [];
  for (let i = 1; i < token.length - 1; i++) {
    const c = token[i];
    if (c === '"') return null;
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const n = token[i + 1];
    if (/^[0-7]{3}$/.test(token.slice(i + 1, i + 4))) {
      bytes.push(parseInt(token.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (n !== undefined && i + 1 < token.length - 1 && Object.prototype.hasOwnProperty.call(C_ESCAPES, n)) {
      bytes.push(C_ESCAPES[n]);
      i += 1;
    } else {
      return null;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

// Index of the closing quote of the quoted token starting at `from`, or -1.
function closingQuote(s, from) {
  for (let i = from + 1; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '"') return i;
  }
  return -1;
}

// The new-side path of a `diff --git` line, or null when it does not parse.
// Each side is C-quoted or bare; two bare sides are split where they are the
// same path (every change but a rename or copy, whose own lines name both).
function headerPath(line) {
  const rest = line.slice('diff --git '.length);
  let b;
  if (rest.startsWith('"')) {
    const end = closingQuote(rest, 0);
    if (end < 0 || rest[end + 1] !== ' ') return null;
    const tail = rest.slice(end + 2);
    b = tail.startsWith('"') ? (closingQuote(tail, 0) === tail.length - 1 ? unquoteC(tail) : null) : tail;
  } else if (rest.includes('"')) {
    const cut = rest.indexOf(' "');
    if (cut < 0 || rest.slice(0, cut).includes('"')) return null;
    const tail = rest.slice(cut + 1);
    b = closingQuote(tail, 0) === tail.length - 1 ? unquoteC(tail) : null;
  } else {
    const n = (rest.length - 5) / 2;
    const same = Number.isInteger(n) && n > 0 ? rest.slice(2, 2 + n) : null;
    if (same !== null && rest === `a/${same} b/${same}`) return same;
    const m = /^a\/.+? (b\/.+)$/.exec(rest);
    b = m ? m[1] : null;
  }
  return b && b.startsWith('b/') && b.length > 2 ? b.slice(2) : null;
}

// The path of a `rename from`, `rename to`, `copy from` or `copy to` line (no
// a/ or b/ prefix there), or null when it does not parse.
function namedPath(rest) {
  if (!rest) return null;
  if (!rest.startsWith('"')) return rest;
  return closingQuote(rest, 0) === rest.length - 1 ? unquoteC(rest) : null;
}

// A ---/+++ side, used only when the header did not parse: the trailing TAB
// git adds after a path with a space is dropped.
function sidePath(raw, prefix) {
  const s = raw.endsWith('\t') ? raw.slice(0, -1) : raw;
  if (s === '/dev/null') return null;
  const p = s.startsWith('"') ? namedPath(s) : s;
  return p && p.startsWith(prefix) ? p.slice(prefix.length) : null;
}

// A path with an empty, `.` or `..` component. Git's plumbing can build a tree
// entry named `..` (checkout and fsck refuse one), and joined onto a temp dir
// such a path writes outside it.
const unsafePath = (p) => p.split('/').some((c) => c === '' || c === '.' || c === '..');

// Each changed file: {path, oldPath, status (A, M, D, R or C), added: Map of
// new-file line number to the added line's text, hunks: [{oldStart, oldCount,
// newStart, newCount}] in order, refused?}. `refused` (why)
// marks an entry nothing may read or write: a path with an empty, . or ..
// component on either side, or a path that did not parse (path null).
function parseDiff(text) {
  const files = [];
  let cur = null;
  let inHunk = false;
  let next = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = { path: headerPath(line), oldPath: null, status: 'M', added: new Map(), hunks: [], side: null };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      next = m ? Number(m[3]) : 0;
      if (m) cur.hunks.push({ oldStart: Number(m[1]), oldCount: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newCount: m[4] === undefined ? 1 : Number(m[4]) });
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      const named = /^(rename|copy) (from|to) (.*)$/.exec(line);
      if (line.startsWith('new file mode')) cur.status = 'A';
      else if (line.startsWith('deleted file mode')) cur.status = 'D';
      else if (named && named[2] === 'from') { cur.status = named[1] === 'rename' ? 'R' : 'C'; cur.oldPath = namedPath(named[3]); }
      else if (named) cur.path = namedPath(named[3]);
      else if (line.startsWith('--- ')) cur.side = cur.side || sidePath(line.slice(4), 'a/');
      else if (line.startsWith('+++ ')) cur.side = sidePath(line.slice(4), 'b/') || cur.side;
      continue;
    }
    if (line.startsWith('+')) {
      cur.added.set(next, line.slice(1));
      next++;
    } else if (!line.startsWith('-') && !line.startsWith('\\')) {
      next++;
    }
  }
  for (const f of files) {
    if (!f.path) f.path = f.side;
    if (!f.oldPath && f.status !== 'A') f.oldPath = f.path;
    delete f.side;
    if (!f.path) f.refused = 'a changed path in the diff did not parse';
    else if (unsafePath(f.path) || (f.oldPath && unsafePath(f.oldPath))) f.refused = 'the path has an empty, . or .. component';
  }
  return files;
}

// The text of each spec (`<tip>:<path>` or `:<path>`) through one
// `git cat-file --batch`; a missing object maps to undefined, and so does a
// spec holding a newline or a CR (the batch reads one name per line and drops
// a trailing CR, so it would name another path).
function catFiles(root, specs) {
  const out = new Map();
  const list = specs.filter((s) => !/[\n\r]/.test(s));
  if (list.length === 0) return out;
  const res = git(root, ['cat-file', '--batch'], { buffer: true, input: list.join('\n') + '\n' });
  if (res.status !== 0 || res.error) throw gitFailed('cat-file');
  const buf = res.stdout;
  let pos = 0;
  for (const spec of list) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = /^[0-9a-f]+ (\w+) (\d+)$/.exec(header);
    if (!m) continue; // "<spec> missing" or "ambiguous"
    const size = Number(m[2]);
    if (m[1] === 'blob') out.set(spec, buf.subarray(pos, pos + size).toString('utf8'));
    pos += size + 1;
  }
  return out;
}

// ---- env-ignored (whole repo) ----------------------------------------------
// A tracked env file: any file whose basename starts with `.env`, at any
// depth (client/.env*, server/.env* and the rest as globs: .env, .env.local,
// .env-staging, .env_prod, .envrc), except a `.env.example` and
// client/.env.production (tracked by design: it holds the public REACT_APP_
// values the build inlines; secrets-in-client-bundle reads what is added to
// it). Every other env file blocks.

function envIgnored(root, mode) {
  const res = mode.staged ? git(root, ['ls-files', '-z']) : git(root, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', mode.tip]);
  if (res.status !== 0 || res.error) throw gitFailed(mode.staged ? 'ls-files' : 'ls-tree');
  return res.stdout.split('\0').filter((p) => {
    const b = path.posix.basename(p);
    return b.startsWith('.env') && b !== '.env.example' && p !== 'client/.env.production';
  }).map((p) => ({ rule: 'env-ignored', file: p, line: null, text: maskedText(`${p} is tracked by git`, p), blocking: true }));
}

// ---- pii -------------------------------------------------------------------
// piiShapes --find over the same range: the added lines of every path, the
// allowlist applied per path, each hit's text already masked. The text is
// masked again and capped like every other finding; a pre-step that did not
// run is a blocking finding. A hit on a line holding a secret-rule literal
// (`spans`, from checkFile) takes its text from the tip blob with that
// literal as <LITERAL>, then masked, so no fragment of it prints.
//
// piiShapes names a path exactly as git does (a spelling its normalization
// would change is another file, review-tooling security H2), so a hit's path
// keys the spans and the blobs directly. A hit with a null line is the path
// itself carrying a shape; its text is already masked.

function piiRule(root, mode, { spans, content, tipSpec } = {}) {
  const args = mode.staged ? ['--find', '--staged'] : ['--find', '--added', mode.base, mode.tip];
  const res = spawnSync(process.execPath, [path.join(__dirname, 'lib', 'piiShapes.js'), ...args],
    { cwd: root, env: GIT_ENV, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  let hits = null;
  try {
    hits = res.status === 0 ? JSON.parse(res.stdout) : null;
  } catch {
    hits = null;
  }
  if (!Array.isArray(hits)) return [{ rule: 'pii', file: null, line: null, text: `the pii pre-step did not run (exit ${res.status})`, blocking: true }];
  // One finding per path and line, masked once (the output keeps one anyway).
  const seen = new Set();
  const textOf = (h) => {
    const gitPath = h.path;
    const fileSpans = spans && spans.get(gitPath);
    const src = fileSpans && content ? content.get(tipSpec(gitPath)) : undefined;
    if (src === undefined) return maskedText(h.text, h.path);
    const starts = lineStarts(src);
    if (!Number.isInteger(h.line) || h.line < 1 || h.line > starts.length) return maskedText(h.text, h.path);
    const redacted = redactedLine(src, starts, h.line, fileSpans);
    return maskedText(redacted !== redactedLine(src, starts, h.line) ? redacted : h.text, h.path);
  };
  return hits.filter((h) => !seen.has(`${h.path}\0${h.line}`) && seen.add(`${h.path}\0${h.line}`))
    .map((h) => ({ rule: 'pii', file: h.path, line: h.line, text: textOf(h), blocking: true }));
}

// ---- output ----------------------------------------------------------------

const didNotRun = (why) => ({ rule: 'did-not-run', file: null, line: null, text: maskedText(`static-checks did not run: ${why}`, null), blocking: true });

// The whole text to `fd`, synchronously, so a process.exit right after it
// (the signal path) can never cut it short, as an async pipe write could. A
// full non-blocking pipe answers EAGAIN: wait a moment and write the rest.
function writeAllSync(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let off = 0; off < buf.length;) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (err) {
      if (err.code !== 'EAGAIN') throw err;
      Atomics.wait(nap, 0, 0, 5);
    }
  }
}

// Print the JSON once and set the exit code: 1 when anything blocks.
function finish(state) {
  if (state.done) return;
  state.done = true;
  const unmasked = maskFailure();
  if (unmasked) {
    state.findings.push({ rule: 'did-not-run', file: null, line: null, text: `static-checks did not run in full: the PII mask (scripts/lib/piiShapes.js) did not load (${unmasked}); every text is withheld`, blocking: true });
  }
  const seen = new Set();
  const out = [];
  for (const f of state.findings) {
    // A finding with no file is about the run; two such are told apart by text.
    const key = `${f.rule}\0${f.file}\0${f.line}\0${f.file === null ? f.text : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A path that itself carries a shape prints masked in every finding on it.
    out.push({ ...f, file: maskedPath(f.file) });
  }
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  out.sort((a, b) => cmp(String(a.file ?? ''), String(b.file ?? '')) || (a.line ?? 0) - (b.line ?? 0) || cmp(a.rule, b.rule));
  const blocking = out.filter((f) => f.blocking).length;
  const allowed = out.filter((f) => f.allowed).length;
  process.exitCode = blocking > 0 ? 1 : 0;
  writeAllSync(1, JSON.stringify({ findings: out, blocking, allowed, ...state.extra }, null, 2) + '\n');
}

async function main(argv) {
  const mode = parseArgs(argv);
  if (!mode) usage();
  const state = { findings: [], extra: { files: 0, eslint_files: 0 }, done: false };
  // A signal kills eslint, removes its temp dir and still prints the JSON
  // (whole: finish writes synchronously), then exits 1 whatever happened.
  const onSignal = (sig) => {
    abortAll();
    try {
      if (!state.done) {
        state.findings.push(didNotRun(`interrupted by ${sig}`));
        finish(state);
      }
    } finally {
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  try {
    const root = repoRoot();
    if (!root) throw new Error('not inside a git repository');
    if (!mode.staged) {
      const base = resolveCommit(root, mode.base);
      const tip = resolveCommit(root, mode.tip);
      if (!base || !tip) usage('static-checks.js: --base and --tip must each name a commit\n');
      mode.base = base;
      mode.tip = tip;
    }
    const files = parseDiff(readDiff(root, mode));
    state.extra.files = files.length;
    // A refused path is never read, written or linted: one blocking scan
    // finding, at parse time.
    for (const f of files.filter((x) => x.refused)) {
      state.findings.push({ rule: 'scan', file: f.path, line: null, text: maskedText(`refused: ${f.refused}; nothing was read or written for it`, f.path), blocking: true });
    }
    const live = files.filter((f) => !f.refused && f.status !== 'D');
    const tipSpec = (p) => (mode.staged ? `:${p}` : `${mode.tip}:${p}`);
    const content = catFiles(root, live.map((f) => tipSpec(f.path)));
    // The secret-rule literal spans per file, kept out of every text.
    const spans = new Map();
    for (const f of live) state.findings.push(...checkFile(f, content.get(tipSpec(f.path)), { root, spans }));
    state.findings.push(...envIgnored(root, mode));
    const eslint = await eslintUndef(root, mode, live, content, (specs) => catFiles(root, specs), { spans });
    state.findings.push(...eslint.findings);
    state.extra.eslint_files = eslint.ran;
    state.findings.push(...piiRule(root, mode, { spans, content, tipSpec, paths: files.filter((f) => f.path).map((f) => f.path) }));
  } catch (err) {
    abortAll();
    state.findings.push(didNotRun(err && err.message ? err.message : String(err)));
  }
  finish(state);
}

module.exports = { RULES, parseArgs, parseDiff, checkFile, maskedText };

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    // finish itself failed (stdout closed, say): nothing more can be printed.
    process.stderr.write(`static-checks.js: ${err && err.message ? err.message : err}\n`);
    process.exitCode = 1;
  });
}
