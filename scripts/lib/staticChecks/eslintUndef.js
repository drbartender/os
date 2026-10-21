'use strict';

// eslintUndef: the eslint-undef rule of scripts/static-checks.js. eslint
// through the repo's own binary and config, over the changed .js files under
// server/ and scripts/ (the client is covered by its CI build), with an
// override that reports only no-undef and no-use-before-define, as errors.
// The override strips every other rule, gives scripts/ the server block's
// language options (the repo config has no block for scripts/, where eslint's
// defaults would flag every require) plus the Node globals scripts use, and
// sets no-use-before-define to same-scope reads only: a const, let or class
// read before its line in its own scope is the TDZ family the lens audit
// recorded (D0491, D2469), while a hoisted function declaration (121 of the
// 125 default-option hits on the tree) and a module constant read from inside
// a function that runs later (the rest, and six in piiShapes.test.js) cannot
// throw. no-undef catches the dropped import (D0645, D0739).
//
// Both sides are linted from the blobs, never the working tree: the tip (or
// the index) and the base (or HEAD) of each file, written to a temp dir, so
// the check describes the commit under review. A file reports only what is
// new against its base, line by line through the diff's hunks, so a
// pre-existing hit in a touched file never blocks, while a dropped import,
// whose throwing reference sits on an unchanged line, does. A parse error at
// the tip always blocks, even when the base has the same one. Any failure to
// run is a blocking finding: a check that did not run is never a pass.
//
// The copies are linted with every range directive neutralized: a
// /* eslint-disable */ (whole file or from that point, any rule list) and an
// inline rule config (/* eslint no-undef: "off" */) have their keyword's first
// letter changed, same length, so eslint no longer reads them. A line-level
// directive (eslint-disable-line, eslint-disable-next-line) and a /* global */
// declaration stay.
//
// Known limit, stated so no one reads a pass as more than it is: with
// variables: false, a module const read inside a function that is called at
// load time before the const's line (a TDZ reached through a call) is not
// caught, and client files are outside this rule (their CI build lints them).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { maskedText, redactedLine } = require('./staticRules');
const { scanJs, lineStarts, lineAt } = require('./jsScan');

// The base line of tip line n, a line the diff left unchanged, through its
// --unified=0 hunks: n less the net line count of every hunk before it. A
// hunk with new lines is before n when its last new line is; a pure deletion
// (newCount 0, newStart the line it follows) when newStart is.
function baseLineOf(hunks, n) {
  let shift = 0;
  for (const h of hunks) {
    const before = h.newCount > 0 ? h.newStart + h.newCount - 1 < n : h.newStart < n;
    if (before) shift += h.newCount - h.oldCount;
  }
  return n - shift;
}

// eslint counts \r\n, \r, \n, U+2028 and U+2029 as line breaks (after a BOM
// it strips); git counts \n. The returned function maps an eslint line and
// column of `text` to the git line.
function gitLines(text) {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const eslintStarts = [0];
  const breaks = /\r\n|[\r\n\u2028\u2029]/g;
  for (let m = breaks.exec(body); m; m = breaks.exec(body)) eslintStarts.push(m.index + m[0].length);
  const starts = lineStarts(body);
  return (line, column) => {
    if (!Number.isInteger(line) || line < 1) return line;
    const at = eslintStarts[Math.min(line, eslintStarts.length) - 1] + Math.max(0, (Number(column) || 1) - 1);
    return lineAt(starts, at);
  };
}

// The text with its range eslint directives made inert (same length, same
// lines). The comments are read exactly as eslint reads a lint target (a
// commonjs script, no JSX), never through the module reading, where `<!--`
// and a backtick could hide a real comment inside a fake template. A file
// that reading cannot tokenize is copied as is: eslint reports its parse
// error anyway.
function neutralizeDirectives(text, root) {
  let comments;
  try {
    ({ comments } = scanJs(text, { root, sourceType: 'commonjs', jsx: false }));
  } catch {
    return text;
  }
  const chars = text.split('');
  for (const c of comments) {
    if (c.type !== 'Block' && c.type !== 'Line') continue;
    const lead = c.value.length - c.value.trimStart().length;
    const body = c.value.slice(lead);
    if (!/^eslint(?:-disable(?![\w-])|\s)/.test(body)) continue;
    chars[c.start + 2 + lead] = 'x';
  }
  return chars.join('');
}


const ESLINT_RULES = Object.freeze({
  'no-undef': 'error',
  'no-use-before-define': ['error', { functions: false, classes: false, variables: false }],
});
const SCRIPT_GLOBALS = Object.freeze(Object.fromEntries(
  // Not crypto: Node's global crypto is Web Crypto, with no createHash or
  // createHmac, so a script that dropped require('crypto') must still fire.
  ['global', 'clearImmediate', 'performance', 'queueMicrotask', 'Headers', 'Request', 'Response'].map((g) => [g, 'readonly']),
));

// A live .js under server/ or scripts/, read on git's own name, never trimmed:
// any character but \n (U+2028 and U+2029 included, which `.` skips), the
// extension in any case, and trailing whitespace after it. eslint lints such a
// name or ignores it, and an ignored target is a blocking did-not-run.
const isLintTarget = (f) => f.status !== 'D' && /^(?:server|scripts)\/[^\n]+\.[jJ][sS]\s*$/.test(f.path);

function eslintConfig(repoConfig) {
  return [
    `import base from ${JSON.stringify(require('url').pathToFileURL(repoConfig).href)};`,
    'const list = Array.isArray(base) ? base : [base];',
    "const server = list.find((b) => b && Array.isArray(b.files) && b.files.includes('server/**/*.js')) || {};",
    'const lo = server.languageOptions || {};',
    'export default [',
    '  ...list.map(({ rules, ...rest }) => rest),',
    `  { files: ['scripts/**/*.js'], languageOptions: { ...lo, globals: { ...(lo.globals || {}), ...${JSON.stringify(SCRIPT_GLOBALS)} } } },`,
    `  { files: ['server/**/*.js', 'scripts/**/*.js'], rules: ${JSON.stringify(ESLINT_RULES)} },`,
    '];',
    '',
  ].join('\n');
}

// eslint runs as a child under a timeout; a timeout is a did-not-run.
const ESLINT_TIMEOUT_MS = 120 * 1000;
const MAX_REPORT_BYTES = 256 * 1024 * 1024;

// What is live right now, so a signal can kill eslint and remove the temp dir
// (see abortAll; the CLI calls it from its SIGTERM and SIGINT handlers).
const live = { children: new Set(), dirs: new Set() };

// kill() returns false, never throws, for a child that already exited.
function abortAll() {
  for (const child of live.children) child.kill('SIGKILL');
  live.children.clear();
  for (const dir of live.dirs) fs.rmSync(dir, { recursive: true, force: true });
  live.dirs.clear();
}

// Lint the files in `dir` (repo-relative paths): a Promise of a Map of path
// to {ignored, messages}, or of a string naming why eslint did not run. No
// --no-warn-ignored: a file eslint ignores must come back with its "File
// ignored" warning, so the caller can tell it was never linted.
function lintDir(bin, config, dir, rels, { timeoutMs = ESLINT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(bin, ['-c', config, '--format', 'json', '--report-unused-disable-directives-severity', 'off', ...rels], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      done(`eslint could not start (${err.code || err.message})`);
      return;
    }
    live.children.add(child);
    const chunks = [];
    let size = 0;
    let timedOut = false;
    let tooBig = false;
    child.stdout.on('data', (b) => {
      size += b.length;
      if (size > MAX_REPORT_BYTES) {
        tooBig = true;
        child.kill('SIGKILL');
      } else {
        chunks.push(b);
      }
    });
    child.stderr.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      live.children.delete(child);
      done(`eslint could not start (${err.code || err.message})`);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      live.children.delete(child);
      if (timedOut) return done(`eslint timed out after ${Math.round(timeoutMs / 1000)} s`);
      if (tooBig) return done('eslint printed a report over 256 MB');
      if (code !== 0 && code !== 1) return done(`eslint exited ${code === null ? signal : code}`);
      let report;
      try {
        report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return done('eslint printed no JSON report');
      }
      if (!Array.isArray(report)) return done('eslint printed no JSON report');
      const out = new Map();
      for (const r of report) {
        const rel = path.relative(dir, r.filePath).split(path.sep).join('/');
        const ignored = r.messages.some((m) => !m.ruleId && !m.fatal && /^File ignored\b/.test(m.message || ''));
        const messages = r.messages.filter((m) => m.fatal || (m.severity === 2 && Object.prototype.hasOwnProperty.call(ESLINT_RULES, m.ruleId)));
        out.set(rel, { ignored, messages });
      }
      return done(out);
    });
  });
}

// `readBlobs(specs)` returns a Map of spec to text (git cat-file) and throws
// when git fails; the throw reaches the CLI, which reports the run as did not
// run, after the finally here has removed the temp dir. Every target
// eslint did not lint (it could not run, the blob could not be read, eslint
// ignored the file or left it out of its report) gets a blocking finding of
// its own, line null; `ran` counts the files eslint really linted. `spans`
// (path -> the secret-rule literal spans checkFile found) keeps those literals
// out of every finding's text as <LITERAL>.
async function eslintUndef(root, mode, files, tipContent, readBlobs, { timeoutMs = ESLINT_TIMEOUT_MS, spans } = {}) {
  const targets = files.filter(isLintTarget);
  if (targets.length === 0) return { findings: [], ran: 0 };
  const notRun = (f, why) => ({ rule: 'eslint-undef', file: f.path, line: null, text: maskedText(`eslint did not run: ${why}`, f.path), blocking: true });
  const noneRan = (why) => ({ findings: targets.map((f) => notRun(f, why)), ran: 0 });
  const bin = path.join(root, 'node_modules', '.bin', 'eslint');
  const repoConfig = path.join(root, 'eslint.config.mjs');
  if (!fs.existsSync(repoConfig)) return noneRan('no eslint.config.mjs at the repo root');
  if (!fs.existsSync(bin)) return noneRan('no node_modules/.bin/eslint in the repo');
  const tipSpec = (p) => (mode.staged ? `:${p}` : `${mode.tip}:${p}`);
  const baseSpec = (p) => (mode.staged ? `HEAD:${p}` : `${mode.base}:${p}`);
  const baseContent = readBlobs(targets.filter((f) => f.status !== 'A').map((f) => baseSpec(f.oldPath)));
  // realpath: eslint reports real paths, so a symlinked TMPDIR would otherwise
  // match no report entry and read as clean.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-eslint-')));
  live.dirs.add(tmp);
  try {
    const config = path.join(tmp, 'eslint.static-checks.mjs');
    fs.writeFileSync(config, eslintConfig(repoConfig));
    // Every path must land inside its side dir (the CLI refuses a path with an
    // empty, . or .. component at parse time; this holds without it).
    const write = (side, rel, text) => {
      const dir = path.join(tmp, side);
      const abs = path.resolve(dir, rel);
      if (!abs.startsWith(dir + path.sep)) throw new Error(`eslint-undef refused to write ${JSON.stringify(rel)}: it resolves outside its temp dir`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, neutralizeDirectives(text, root));
    };
    const findings = [];
    const linted = [];
    const baseRels = [];
    for (const f of targets) {
      const text = tipContent.get(tipSpec(f.path));
      if (text === undefined) {
        findings.push(notRun(f, 'the file could not be read from git as a blob'));
        continue;
      }
      write('tip', f.path, text);
      linted.push(f);
      const old = f.status === 'A' ? undefined : baseContent.get(baseSpec(f.oldPath));
      if (old !== undefined) {
        write('base', f.path, old);
        baseRels.push(f.path);
      }
    }
    if (linted.length === 0) return { findings, ran: 0 };
    const tip = await lintDir(bin, config, path.join(tmp, 'tip'), linted.map((f) => f.path), { timeoutMs });
    if (typeof tip === 'string') return { findings: [...findings, ...linted.map((f) => notRun(f, tip))], ran: 0 };
    const base = baseRels.length ? await lintDir(bin, config, path.join(tmp, 'base'), baseRels, { timeoutMs }) : new Map();
    if (typeof base === 'string') return { findings: [...findings, ...linted.map((f) => notRun(f, `${base} (base side)`))], ran: 0 };
    let ran = 0;
    for (const f of linted) {
      const got = tip.get(f.path);
      if (!got || got.ignored) {
        findings.push(notRun(f, got ? 'eslint ignored the file' : 'eslint left the file out of its report'));
        continue;
      }
      ran++;
      const tipText = tipContent.get(tipSpec(f.path)) || '';
      const starts = lineStarts(tipText);
      const fileSpans = (spans && spans.get(f.path)) || [];
      const toGit = gitLines(tipText);
      const tipMessages = got.messages.map((m) => ({ ...m, line: toGit(m.line, m.column) }));
      // One finding per line, its text masked once (the output keeps one per
      // rule, file and line anyway).
      const reported = new Set();
      const report = (m) => {
        if (reported.has(m.line)) return;
        reported.add(m.line);
        const what = m.fatal ? `parse error: ${m.message}` : `${m.message} (${m.ruleId})`;
        const line = Number.isInteger(m.line) && m.line >= 1 && m.line <= starts.length ? redactedLine(tipText, starts, m.line, fileSpans) : '';
        findings.push({ rule: 'eslint-undef', file: f.path, line: m.line, text: maskedText(`${what}: ${line.trim()}`, f.path), blocking: true });
      };
      // A parse error blocks whatever the base held: the tip does not parse.
      for (const m of tipMessages) if (m.fatal) report(m);
      const msgs = tipMessages.filter((m) => !m.fatal);
      if (msgs.length === 0) continue;
      // What is new against the base, line by line through the diff's hunks:
      // a message on an added line is always new; one on an unchanged line is
      // old only when the base holds the same rule and message, as many
      // times, on the line it came from. A count over the whole file would let
      // a new undefined reference cancel against a deleted old one.
      const key = (m, line) => `${line}\0${m.ruleId}\0${m.message}`;
      const before = new Map();
      const prior = base.get(f.path);
      const baseText = f.status === 'A' ? undefined : baseContent.get(baseSpec(f.oldPath));
      if (prior && !prior.ignored && baseText !== undefined) {
        const toBaseGit = gitLines(baseText);
        for (const m of prior.messages) {
          if (m.fatal) continue;
          const k = key(m, toBaseGit(m.line, m.column));
          before.set(k, (before.get(k) || 0) + 1);
        }
      }
      const groups = new Map();
      for (const m of msgs) groups.set(key(m, m.line), [...(groups.get(key(m, m.line)) || []), m]);
      for (const group of groups.values()) {
        const m = group[0];
        if (f.added.has(m.line) || group.length > (before.get(key(m, baseLineOf(f.hunks || [], m.line))) || 0)) report(m);
      }
    }
    return { findings, ran };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    live.dirs.delete(tmp);
  }
}

module.exports = { ESLINT_RULES, ESLINT_TIMEOUT_MS, SCRIPT_GLOBALS, isLintTarget, eslintConfig, lintDir, eslintUndef, neutralizeDirectives, abortAll, baseLineOf };
