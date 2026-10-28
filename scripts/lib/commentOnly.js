'use strict';

// The comment-only proof of spec 2026-10-19 section 3.7 (instruction rewrite
// step 4, lane comment-proof; plan decision 11): whether a diff adds, removes
// or rewords nothing but comments. scripts/comment-only-proof.js is its CLI,
// and review-receipt.js finalize --kind comment-only reads the JSON it writes.
//
// compareFile(oldText, newText, path) -> {ok, reason}, by the path's kind:
//   .js .jsx .mjs .cjs  both sides parsed with acorn (acorn-jsx for .js and
//                 .jsx, since the client's .js files hold JSX), the token
//                 stream taken from the parser's onToken, comments never in
//                 it. sourceType is module, or script when module fails on the
//                 old text, and the new text must parse under the same choice.
//                 The two streams must agree token by token in type label and
//                 raw source text (a template, a regex and a number by their
//                 raw text, so 1 and 1.0 differ), and in whether a line break
//                 sits between each token and the one before it, since the
//                 grammar reads line breaks (automatic semicolons, return,
//                 postfix ++); the line break before the first token and before
//                 the end are free. The shebang line, which acorn drops as a
//                 comment, must be the same on both sides, and so must the
//                 comments a compiler or the linter reads (a JSX pragma, a
//                 pure or no-side-effects annotation, a webpack magic comment,
//                 an ESLint configuration comment),
//                 compared as a multiset of their texts. A side that does not
//                 parse fails the file. The parser, not the bare tokenizer:
//                 acorn.tokenizer guesses regex against division without the
//                 grammar, and `await /[//]/.test(s) && f()` reads to it as a
//                 division followed by a line comment, which would hide a
//                 change to f().
//   .sql          read the way server/db/index.js's splitStatements reads it
//                 (not required: that module opens a pool at load): a -- or
//                 /* */ comment is a comment only outside single-quoted
//                 strings (with the '' escape, and backslash escapes after E),
//                 double-quoted identifiers and dollar-quoted bodies ($$ ... $$,
//                 $tag$ ... $tag$, closed only by the same tag). The text of
//                 every string, identifier and body is code and must be the
//                 same byte for byte, so a comment edited inside a DO block or
//                 a function body is refused; the code between them must be
//                 the same with each run of ASCII blanks (space, tab, LF, CR,
//                 FF, VT; no other character JavaScript's \s matches) read
//                 as one blank, or as one line break when it holds one
//                 (psql's meta-commands end at a line break), a comment read
//                 as a blank (a line break when it spans lines), the ends
//                 trimmed. An unterminated comment,
//                 string or body is code to the end of the file. A side
//                 holding a lone CR (one not followed by LF) is refused here
//                 and in the line rule below: Postgres ends a -- comment at
//                 it, and the rules read only CRLF as a line end.
//   .sh and a file named .env.example
//                 the line rule: a comment line is one whose first non-blank
//                 character is #, the blanks being ASCII space and tab only;
//                 blank lines are free; every other line is code, and the code
//                 lines, CRLF read as LF and trailing spaces and tabs trimmed,
//                 must be the same in the same order. In .sh the first
//                 line, when it is a shebang, is code; a heredoc's body,
//                 through its delimiter line, is code compared as written; and
//                 a line whose trimmed form ends in a backslash keeps its
//                 trailing blanks, since an escaped blank and a line
//                 continuation are different commands; a line after a code
//                 line ending in an unescaped backslash is code whatever it
//                 holds, a blank or a # line included, since bash joins the
//                 two. Known limits: a line
//                 inside a multi-line quoted string in .sh that begins with #
//                 is read as a comment, and in .env.example a commented-out
//                 sample line (# VAR=value) is a comment, so its sample value
//                 may change.
//   anything else not ok: unsupported file type.
// A reason names lines and counts, never a word of the source.
//
// proveDiff({base, tip, staged, cwd}) -> {version: 1, mode, base, tip, tree,
// files: [{path, ok, reason}], skipped: [path], ok}. A range compares <base>
// and <tip> (full shas recorded; tree is tip's tree); --staged writes the
// index as a tree (git write-tree, the tree a quick fix's receipt keys) and
// compares HEAD with it (base is HEAD, tip null), so the files and the tree
// recorded are one read.
// The diff is git diff --raw --no-renames (a rename or a copy is a delete and
// an add), from the top of the worktree; a file that is added, deleted,
// type-changed, unmerged, changes mode, or is a symlink or a submodule is not
// ok, and both sides of a modified file are read by blob id through
// git cat-file --batch. The generated docs (receipt.js's GENERATED_DOCS,
// README.md and ARCHITECTURE.md at the root) are skipped exactly as the
// receipt key skips them: they are regenerated by every change to the tree
// and are tier docs on their own, reviewed by no lens either way, so their
// presence in a diff must not stop a comment-only receipt, and finalize's
// files check already leaves them out. They get no verdict and are listed in
// skipped (empty when none), so the proof still says what it did not read. ok
// is true only when at least one file was proved and every file is ok: an
// empty diff, or one of nothing but generated docs, proves nothing. An
// unresolvable ref throws with code USAGE. Every git call runs with
// receipt.js's gitEnv (no GIT_DIR, GIT_INDEX_FILE or other repo variable, no
// external diff, no replace refs), so the proof reads the repo cwd names, the
// way the receipt it feeds does.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const acorn = require('acorn');
const acornJsx = require('acorn-jsx');
const R = require('./receipt');

const JSX_PARSER = acorn.Parser.extend(acornJsx());
const JS_PARSERS = Object.freeze({ '.js': JSX_PARSER, '.jsx': JSX_PARSER, '.mjs': acorn.Parser, '.cjs': acorn.Parser });
const SQL_TAG = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y;
const ENV_TEMPLATE = '.env.example';
// ECMAScript's line terminators: CR, LF, CRLF and the two separators, built from
// their code points so this file holds none of them.
const TERMINATORS = `\\r\\n?|[\\n${String.fromCharCode(0x2028, 0x2029)}]`;
const LINE_BREAK = new RegExp(TERMINATORS);
const LINE_BREAKS = new RegExp(TERMINATORS, 'g');
const MAX_BUFFER = 256 * 1024 * 1024;

const ok = () => ({ ok: true, reason: null });
const no = (reason) => ({ ok: false, reason });

// ---- one file -------------------------------------------------------------------

function lineAt(text, pos) {
  return (text.slice(0, pos).match(LINE_BREAKS) || []).length + 1;
}

function shebang(text) {
  return text.startsWith('#!') ? text.split(LINE_BREAK, 1)[0] : null;
}

// The parser's tokens, with the texts of the comments that are compiler
// directives on tokens.directives.
function parseTokens(Parser, text, sourceType) {
  const tokens = [];
  const directives = [];
  Parser.parse(text, {
    ecmaVersion: 'latest',
    sourceType,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    onToken: (t) => tokens.push(t),
    onComment: (block, body) => {
      if (DIRECTIVE.test(body) || ESLINT_DIRECTIVE.test(body)) directives.push(body);
    },
  });
  tokens.directives = directives.sort();
  return tokens;
}

// A parse failure as its class and acorn's line and column, never its
// message: acorn quotes identifiers and regex sources there.
function failure(err) {
  const name = err && typeof err.name === 'string' && /^[A-Za-z]+$/.test(err.name) ? err.name : 'Error';
  const loc = err && err.loc && Number.isInteger(err.loc.line) && Number.isInteger(err.loc.column) ? ` at line ${err.loc.line}, column ${err.loc.column}` : '';
  return `${name}${loc}`;
}

// A comment a compiler or the linter reads: the JSX pragmas (@jsx,
// @jsxRuntime, @jsxImportSource, @jsxFrag), the pure and no-side-effects
// annotations bundlers and minifiers act on, webpack's magic comments
// (webpackChunkName, webpackIgnore, ...), and ESLint's configuration comments
// (eslint, eslint-disable, eslint-enable, eslint-env and the -line forms,
// global, globals, exported: the keyword first, then a blank or the end, as
// ESLint reads them), which the CI client build and the static check obey.
// Adding, removing or changing one changes the build, so such a comment is
// compared like code.
const DIRECTIVE = /@jsx|__PURE__|__NO_SIDE_EFFECTS__|\bwebpack[A-Z]/;
const ESLINT_DIRECTIVE = /^\s*(?:eslint(?:-[a-z-]+)?|exported|globals?)(?:\s|$)/;

// Whether a line break sits between token i and the one before it.
function breakBefore(text, tokens, i) {
  return LINE_BREAK.test(text.slice(tokens[i - 1].end, tokens[i].start));
}

function compareJs(oldText, newText, Parser) {
  const before = shebang(oldText);
  const after = shebang(newText);
  if (before !== after) return no(before === null ? 'a shebang line was added' : after === null ? 'the shebang line was removed' : 'the shebang line changed');
  let sourceType = 'module';
  let a;
  try {
    a = parseTokens(Parser, oldText, sourceType);
  } catch {
    sourceType = 'script';
    try {
      a = parseTokens(Parser, oldText, sourceType);
    } catch (err) {
      return no(`tokenize failed: the old text: ${failure(err)}`);
    }
  }
  let b;
  try {
    b = parseTokens(Parser, newText, sourceType);
  } catch (err) {
    return no(`tokenize failed: the new text (as ${sourceType}): ${failure(err)}`);
  }
  const where = (i) => `line ${lineAt(newText, b[i] ? b[i].start : newText.length)} of the new text, line ${lineAt(oldText, a[i] ? a[i].start : oldText.length)} of the old`;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.type.label !== y.type.label || oldText.slice(x.start, x.end) !== newText.slice(y.start, y.end)) {
      return no(`code changed at token ${i + 1} (${where(i)})`);
    }
    if (i > 0 && y.type !== acorn.tokTypes.eof && breakBefore(oldText, a, i) !== breakBefore(newText, b, i)) {
      return no(`a line break between two tokens was added or removed at token ${i + 1} (${where(i)}); the grammar reads line breaks`);
    }
  }
  if (a.directives.join('\0') !== b.directives.join('\0')) return no('a comment that is a compiler directive changed');
  return ok();
}

// The heredocs a .sh line opens, in order: [{word, tabs}] (<<- strips leading
// tabs from the delimiter line). A here-string (<<<) opens none.
const HEREDOC = /(?<!<)<<(?!<)(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([^\s;&|<>()'"]+))/g;

function heredocs(line) {
  return [...line.matchAll(HEREDOC)].map((m) => ({ word: [m[2], m[3], m[4]].find((w) => w !== undefined), tabs: m[1] === '-' }));
}

// The code lines of a line-rule file: [{text, line}].
function codeLines(text, marker, sh) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let open = [];
  // In .sh, a line after one ending in an unescaped backslash is joined to it
  // by bash, so it is code whatever it holds, a blank or a # line included.
  let joined = false;
  lines.forEach((raw, i) => {
    if (open.length) {
      out.push({ text: raw, line: i + 1 });
      if ((open[0].tabs ? raw.replace(/^\t+/, '') : raw) === open[0].word) open = open.slice(1);
      return;
    }
    // Blanks are ASCII space and tab only: a line led by an NBSP is no comment
    // line to the shell, and a trailing NBSP is part of a word.
    const trimmed = raw.replace(/[ \t]+$/, '');
    const lead = trimmed.replace(/^[ \t]+/, '');
    const comment = lead === '' || lead.startsWith(marker);
    if (!joined && !(sh && i === 0 && raw.startsWith('#!')) && comment) return;
    out.push({ text: sh && trimmed.endsWith('\\') ? raw : trimmed, line: i + 1 });
    // A joined line carries the join on when it too ends in an unescaped
    // backslash, a # line included (bash read its # inside a word); a
    // standalone comment line continues nothing.
    joined = sh && (joined || !lead.startsWith(marker)) && /(?:^|[^\\])(?:\\\\)*\\$/.test(raw);
    if (sh) open = heredocs(trimmed);
  });
  return out;
}

function compareLines(oldText, newText, marker, sh) {
  const a = codeLines(oldText, marker, sh);
  const b = codeLines(newText, marker, sh);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] && b[i] && a[i].text === b[i].text) continue;
    const at = (x) => (x ? `line ${x.line}` : 'the end');
    return no(`code line ${i + 1} differs (${at(b[i])} of the new text, ${at(a[i])} of the old)`);
  }
  return ok();
}

// A .sql text as parts, [{lit, text, start}]: lit marks a single-quoted
// string, a double-quoted identifier or a dollar body, kept as written; a code
// part has its comments dropped and its blanks folded (the header's rule).
function sqlParts(raw) {
  const t = raw.replace(/\r\n/g, '\n');
  const len = t.length;
  const parts = [];
  let code = '';
  let codeStart = 0;
  const flush = () => {
    // Only ASCII blanks fold: any other character \s matches (NBSP, the
    // line and paragraph separators, a BOM, the U+2000 range) is code.
    const folded = code.replace(/[ \t\n\r\f\v]+/g, (w) => (w.includes('\n') ? '\n' : ' '));
    if (folded) parts.push({ lit: false, text: folded, start: codeStart });
    code = '';
  };
  const lit = (from, to) => {
    flush();
    parts.push({ lit: true, text: t.slice(from, to), start: from });
    codeStart = to;
    return to;
  };
  // The end of a quoted run opened at i by q: past its closing quote, or len.
  const quoted = (i, q, backslash) => {
    let j = i + 1;
    while (j < len) {
      if (backslash && t[j] === '\\') j += 2;
      else if (t[j] === q && t[j + 1] === q) j += 2;
      else if (t[j] === q) return j + 1;
      else j++;
    }
    return len;
  };
  let i = 0;
  while (i < len) {
    const ch = t[i];
    const next = t[i + 1];
    if (ch === '-' && next === '-') {
      const eol = t.indexOf('\n', i);
      code += ' ';
      i = eol === -1 ? len : eol;
    } else if (ch === '/' && next === '*') {
      const end = t.indexOf('*/', i + 2);
      if (end === -1) {
        i = lit(i, len);
      } else {
        code += t.slice(i, end).includes('\n') ? '\n' : ' ';
        i = end + 2;
      }
    } else if (ch === "'") {
      const e = (t[i - 1] === 'E' || t[i - 1] === 'e') && !/[A-Za-z0-9_$]/.test(t[i - 2] || '');
      i = lit(i, quoted(i, "'", e));
    } else if (ch === '"') {
      i = lit(i, quoted(i, '"', false));
    } else {
      SQL_TAG.lastIndex = i;
      const m = ch === '$' ? SQL_TAG.exec(t) : null;
      if (m) {
        const close = t.indexOf(m[0], i + m[0].length);
        i = lit(i, close === -1 ? len : close + m[0].length);
      } else {
        code += ch;
        i++;
      }
    }
  }
  flush();
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (first && !first.lit) first.text = first.text.replace(/^[ \n]+/, '');
  if (last && !last.lit) last.text = last.text.replace(/[ \n]+$/, '');
  return { t, parts: parts.filter((p) => p.lit || p.text) };
}

function compareSql(oldText, newText) {
  const a = sqlParts(oldText);
  const b = sqlParts(newText);
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const x = a.parts[i];
    const y = b.parts[i];
    if (x && y && x.lit === y.lit && x.text === y.text) continue;
    const at = (side, p) => (p ? `line ${lineAt(side.t, p.start)}` : 'the end');
    return no(`code differs from ${at(b, y)} of the new text (${at(a, x)} of the old)`);
  }
  return ok();
}

// A CR not followed by LF: Postgres ends a -- comment at it, and the line
// rules read CRLF as LF only, so a side holding one is not compared.
const LONE_CR = /\r(?!\n)/;

function compareFile(oldText, newText, filePath) {
  const p = String(filePath);
  const ext = path.posix.extname(p);
  if (Object.prototype.hasOwnProperty.call(JS_PARSERS, ext)) return compareJs(oldText, newText, JS_PARSERS[ext]);
  const env = path.posix.basename(p) === ENV_TEMPLATE;
  if (!env && ext !== '.sql' && ext !== '.sh') return no('unsupported file type');
  if (LONE_CR.test(oldText) || LONE_CR.test(newText)) return no('a lone carriage return is not comparable');
  if (env) return compareLines(oldText, newText, '#', false);
  if (ext === '.sql') return compareSql(oldText, newText);
  return compareLines(oldText, newText, '#', true);
}

// ---- the diff -------------------------------------------------------------------

function git(top, args, input) {
  return execFileSync('git', args, { cwd: top, env: R.gitEnv(), input, maxBuffer: MAX_BUFFER, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
}

// A ref as a full commit sha; one git cannot resolve is misuse (exit 2).
function resolve(cwd, ref, label) {
  try {
    return R.resolveCommit(ref, { cwd });
  } catch {
    throw Object.assign(new Error(`${label} is not a commit`), { code: 'USAGE' });
  }
}

// git diff --raw -z: ":<mode> <mode> <blob> <blob> <status>\0<path>\0" per file.
function rawDiff(top, from, to) {
  // Pinned against config: no colour, no renames (diff.renames), full blob ids,
  // paths from the top (diff.relative), submodules shown, git's own order
  // (diff.orderFile).
  const out = git(top, ['diff', '--raw', '-z', '--no-color', '--no-renames', '--no-abbrev', '--no-relative', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '-O/dev/null', '--end-of-options', from, to, '--']).toString('utf8');
  const parts = out.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(parts[i]);
    if (!m) throw new Error(`git diff --raw printed a line this proof cannot read (entry ${i / 2 + 1})`);
    entries.push({ oldMode: m[1], newMode: m[2], oldBlob: m[3], newBlob: m[4], status: m[5], path: parts[i + 1] });
  }
  return entries;
}

// {blob id: text} for every id, read in one git cat-file --batch.
function readBlobs(top, ids) {
  const out = {};
  const list = [...new Set(ids)];
  if (!list.length) return out;
  const buf = git(top, ['cat-file', '--batch'], `${list.join('\n')}\n`);
  let pos = 0;
  for (const id of list) {
    const nl = buf.indexOf(10, pos);
    const head = buf.slice(pos, nl).toString('utf8').split(' ');
    if (head[0] !== id || head[1] !== 'blob') throw new Error(`git cat-file could not read blob ${R.short(id)}`);
    const size = Number(head[2]);
    out[id] = buf.slice(nl + 1, nl + 1 + size).toString('utf8');
    pos = nl + 1 + size + 1;
  }
  return out;
}

const STATUS = Object.freeze({ A: 'added', D: 'deleted', T: 'type changed', U: 'unmerged', X: 'unknown to git' });
const REGULAR = /^100(644|755)$/;

function verdict(e, texts) {
  if (e.status !== 'M') return no(STATUS[e.status] || `git status ${e.status}`);
  if (e.oldMode !== e.newMode) return no(`mode changed (${e.oldMode} to ${e.newMode})`);
  if (!REGULAR.test(e.newMode)) return no(`not a regular file (mode ${e.newMode})`);
  return compareFile(texts[e.oldBlob], texts[e.newBlob], e.path);
}

function proveDiff({ base, tip, staged = false, cwd = process.cwd() } = {}) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  let proof;
  if (staged) {
    const head = resolve(top, 'HEAD', 'HEAD');
    proof = { version: 1, mode: 'staged', base: head, tip: null, tree: R.quickFixKey({ cwd: top }) };
  } else {
    const from = resolve(top, base, `--base ${base}`);
    const to = resolve(top, tip, `--tip ${tip}`);
    proof = { version: 1, mode: 'range', base: from, tip: to, tree: git(top, ['rev-parse', '--verify', '--end-of-options', `${to}^{tree}`]).toString('utf8').trim() };
  }
  const entries = rawDiff(top, proof.base, proof.mode === 'staged' ? proof.tree : proof.tip);
  const modified = entries.filter((e) => e.status === 'M' && e.oldMode === e.newMode && REGULAR.test(e.newMode) && !R.GENERATED_DOCS.includes(e.path));
  const texts = readBlobs(top, modified.flatMap((e) => [e.oldBlob, e.newBlob]));
  const generated = (e) => R.GENERATED_DOCS.includes(e.path);
  const files = entries.filter((e) => !generated(e)).map((e) => ({ path: e.path, ...verdict(e, texts) }));
  const skipped = entries.filter(generated).map((e) => e.path);
  return { ...proof, files, skipped, ok: files.length > 0 && files.every((f) => f.ok) };
}

module.exports = { compareFile, proveDiff };
