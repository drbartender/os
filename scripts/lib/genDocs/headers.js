'use strict';

// The header rule (instruction rewrite step 4, lane gen-docs; plan 2026-10-27
// decision 1 and the contract "The header rule"). One reading of "a file's
// header comment" for the generated tree, the pre-commit check, the route
// walker's handler descriptions and the migration that writes headers.
//
//   isSource(path)            a .js, .jsx, .mjs or .cjs file under one of
//                             CODE_PATHS.roots that none of CODE_PATHS.exclude
//                             matches (scripts/sensitive-match.js, the content
//                             rule's one definition: today server/,
//                             client/src/ and scripts/, with the test globs and
//                             the calibration script excluded)
//   isTest(path)              a path one of CODE_PATHS.exclude's test globs
//                             (the `**/` ones: *.test.js, *.test.jsx) matches
//   ROOTS                     CODE_PATHS.roots itself, which the tree and the
//                             untracked-file line read
//   readHeader(text, ext)     {present, description, start, end}: start is the
//                             header's first line index, end the index after
//                             its last line (both 0-based); with no header both
//                             are insertionPoint
//   insertionPoint(text, ext) the line index after the skipped prefix, where a
//                             header goes
//   describeComment(lines)    the first paragraph of a comment given as its raw
//                             lines (a `//` run or one block), the stripping
//                             readHeader uses; eslint directive lines dropped,
//                             a rule of decoration characters at a line's ends
//                             stripped (a line that is only a rule is blank)
//
// The JS prefix skipped before the header, in any mix and order: blank lines,
// one shebang (only as the very first line), 'use strict' or "use strict"
// with or without the semicolon, and eslint directive comments (a line or
// block comment whose text starts with eslint). The header is then the first
// comment: a run of consecutive `//` lines, or one block comment. A .sh header
// is the `#` run after the shebang (a `# shellcheck` line skipped), a .sql
// header the `--` run, a .css header one block comment. The description is the
// first paragraph: the comment markers and one leading space stripped, up to
// the first blank comment line, joined with single spaces; an empty one is no
// header. A byte-order mark is ignored for reading (the writer keeps it first)
// and CRLF endings read as LF.

const path = require('node:path');
const { CODE_PATHS, patternToRegex } = require('../../sensitive-match');

const ROOTS = CODE_PATHS.roots;
const SOURCE_EXTENSIONS = Object.freeze(['.js', '.jsx', '.mjs', '.cjs']);
const EXCLUDE = CODE_PATHS.exclude.map(patternToRegex);
const TESTS = CODE_PATHS.exclude.filter((g) => g.startsWith('**/')).map(patternToRegex);

function extOf(p) {
  return path.posix.extname(String(p)).toLowerCase();
}

function isTest(p) {
  const s = String(p);
  return TESTS.some((re) => re.test(s));
}

function isSource(p) {
  const s = String(p);
  return ROOTS.some((r) => s.startsWith(r)) && SOURCE_EXTENSIONS.includes(extOf(s)) && !EXCLUDE.some((re) => re.test(s));
}

// The comment style a file's extension reads, or null for a kind with no header.
function styleOf(ext) {
  const e = String(ext || '').toLowerCase();
  const dotted = e.startsWith('.') ? e : `.${e}`;
  if (SOURCE_EXTENSIONS.includes(dotted)) return 'js';
  if (dotted === '.sh') return 'sh';
  if (dotted === '.sql') return 'sql';
  if (dotted === '.css') return 'css';
  return null;
}

function splitLines(text) {
  let t = String(text == null ? '' : text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

const isBlank = (l) => l.trim() === '';
const USE_STRICT = /^(['"])use strict\1;?$/;

// The index of the block comment's last line, from the line that opens it.
function blockEnd(lines, i) {
  const first = lines[i];
  const open = first.indexOf('/*');
  if (first.indexOf('*/', open + 2) !== -1) return i;
  for (let j = i + 1; j < lines.length; j += 1) {
    if (lines[j].includes('*/')) return j;
  }
  return lines.length - 1;
}

function skipPrefix(lines, style) {
  let i = 0;
  if ((style === 'js' || style === 'sh') && lines.length && lines[0].startsWith('#!')) i = 1;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '') { i += 1; continue; }
    if (style === 'js') {
      if (USE_STRICT.test(t)) { i += 1; continue; }
      if (/^\/\/\s*eslint(?:[-\s]|$)/.test(t)) { i += 1; continue; }
      if (/^\/\*+\s*eslint(?:[-\s]|\*|$)/.test(t)) { i = blockEnd(lines, i) + 1; continue; }
    }
    if (style === 'sh' && /^#\s*shellcheck\b/.test(t)) { i += 1; continue; }
    break;
  }
  return i;
}

// The raw lines of the first comment at line i, or null when line i is not one.
function commentAt(lines, i, style) {
  if (i >= lines.length) return null;
  const t = lines[i].trimStart();
  const run = (marker) => {
    let j = i;
    while (j < lines.length && lines[j].trimStart().startsWith(marker) && !lines[j].trimStart().startsWith('#!')) j += 1;
    return { start: i, end: j, raw: lines.slice(i, j) };
  };
  if (style === 'js' && t.startsWith('//')) return run('//');
  if (style === 'sh' && t.startsWith('#') && !t.startsWith('#!')) return run('#');
  if (style === 'sql' && t.startsWith('--')) return run('--');
  if ((style === 'js' || style === 'css') && t.startsWith('/*')) {
    const j = blockEnd(lines, i);
    return { start: i, end: j + 1, raw: lines.slice(i, j + 1) };
  }
  return null;
}

// One comment's text lines with its markers stripped.
function commentBody(raw) {
  const first = (raw[0] || '').trimStart();
  if (first.startsWith('/*')) {
    const joined = raw.join('\n');
    const open = joined.indexOf('/*');
    const close = joined.indexOf('*/', open + 2);
    const inner = joined.slice(open + 2, close === -1 ? joined.length : close).replace(/^\*+/, '');
    return inner.split('\n').map((l, k) => {
      let s = k === 0 ? l : l.trimStart();
      if (k > 0 && s.startsWith('*')) s = s.slice(1);
      return s.startsWith(' ') ? s.slice(1) : s;
    });
  }
  const marker = first.startsWith('//') ? '//' : first.startsWith('--') ? '--' : '#';
  return raw.map((l) => {
    let s = l.trimStart();
    if (s.startsWith(marker)) s = s.slice(marker.length);
    return s.startsWith(' ') ? s.slice(1) : s;
  });
}

// A rule of three or more box-drawing, `=`, `-`, `_`, `*` or `~` characters at
// either end of a line is decoration, not words: `// ─── Title ───` reads
// "Title", and a line that is only a rule reads as blank.
const RULE = '[\\u2500-\\u257F=_*~-]{3,}';
const RULE_EDGES = new RegExp(`^\\s*${RULE}(?=\\s|$)|(?:^|\\s)${RULE}\\s*$`, 'g');
const undecorate = (l) => l.replace(RULE_EDGES, ' ').trim();

function describeComment(raw) {
  const body = commentBody(raw).filter((l) => !/^\s*eslint(?:[-\s]|$)/.test(l));
  const para = [];
  for (const l of body) {
    const words = undecorate(l);
    if (words === '') {
      if (para.length) break;
      continue;
    }
    para.push(words);
  }
  return para.join(' ').replace(/\s+/g, ' ').trim();
}

function insertionPoint(text, ext) {
  const style = styleOf(ext);
  const lines = splitLines(text);
  return style ? skipPrefix(lines, style) : 0;
}

function readHeader(text, ext) {
  const style = styleOf(ext);
  const lines = splitLines(text);
  const at = style ? skipPrefix(lines, style) : 0;
  const none = { present: false, description: '', start: at, end: at };
  if (!style) return none;
  const c = commentAt(lines, at, style);
  if (!c) return none;
  const description = describeComment(c.raw);
  if (!description) return none;
  return { present: true, description, start: c.start, end: c.end };
}

module.exports = {
  ROOTS,
  SOURCE_EXTENSIONS,
  isSource,
  isTest,
  extOf,
  styleOf,
  readHeader,
  insertionPoint,
  describeComment,
  splitLines,
};
