'use strict';

// jsScan: the code view of a JS file for scripts/static-checks.js, built from
// espree's tokens. espree is eslint's own parser; it is resolved from the
// repo's node_modules (the reviewed repo first, then this script's own), and
// runs with JSX on and ecmaVersion latest, reading each file both as a script
// (commonjs) and as a module, the one eslint uses for it preferred (see
// scanJs). When neither tokenizes, or both do and disagree, scanJs throws and
// the caller fails closed: the file gets a blocking `scan` finding and no rule
// runs on it.
//
// The code view keeps every code token at its own offset and turns the rest
// into spaces (newlines kept): comments, string, template and regex literal
// text, and JSX text and attribute strings. So a pattern named in a comment,
// a string or JSX text never reads as code, and JSX (a closing tag, an
// apostrophe or a /* in its text) never hides the code after it.
//
// lineStarts and lineAt are local copies: scripts/lib/piiShapes.js has the
// same two helpers but does not export them.

function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid; else hi = mid - 1;
  }
  return lo + 1;
}

// ---- espree ----------------------------------------------------------------

const loaded = new Map();

function loadEspree(root) {
  const key = root || '';
  if (!loaded.has(key)) {
    let value;
    try {
      value = require(require.resolve('espree', { paths: root ? [root, __dirname] : [__dirname] }));
    } catch (err) {
      value = err instanceof Error ? err : new Error(String(err));
    }
    loaded.set(key, value);
  }
  const v = loaded.get(key);
  if (v instanceof Error) {
    const e = new Error(`could not load espree (${v.code || v.message})`);
    e.lineNumber = null;
    throw e;
  }
  return v;
}

const OPTIONS = (sourceType, jsx = true) => ({ ecmaVersion: 'latest', sourceType, ecmaFeatures: { jsx }, range: true, loc: true, comment: true });

// The token types that are code; every other token (String, Template,
// RegularExpression, JSXText) and every comment is blanked in the code view.
const CODE_TYPES = new Set(['Keyword', 'Identifier', 'Punctuator', 'Numeric', 'Boolean', 'Null', 'JSXIdentifier', 'PrivateIdentifier']);

// The two readings of a file, the one to prefer first: a script (commonjs,
// eslint's sourceType there) for a .js under server/ or scripts/ and any
// .cjs, a module for everything else (.mjs and client/src/ included).
const readingsFor = (p) => (/\.cjs$/.test(p) || /^(?:server|scripts)\/.*\.js$/.test(p) ? ['commonjs', 'module'] : ['module', 'commonjs']);

// The spans the code view blanks (comments, strings, templates, regex and JSX
// text), sorted: two readings that differ here would show different code.
function blankedSpans(raw) {
  const out = (raw.comments || []).map((c) => [c.range[0], c.range[1]]);
  for (const t of raw) if (!CODE_TYPES.has(t.type)) out.push([t.range[0], t.range[1]]);
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// The offset where two span lists first differ, or -1 when they are the same.
function firstDifference(a, b) {
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const x = a[k];
    const y = b[k];
    if (!x || !y || x[0] !== y[0] || x[1] !== y[1]) return Math.min(x ? x[0] : Infinity, y ? y[0] : Infinity);
  }
  return -1;
}

// A token's lines come from its offsets and count \n only, as git and the
// diff's line numbers do. espree's own loc also counts U+2028, U+2029 and a
// lone CR, which would move every finding below one of them. `nl` keeps
// espree's reading for ASI: a JS line terminator sits between this token and
// the one before it.
function plainOf(starts) {
  let prevEnd = 0;
  return (t) => {
    const start = t.range[0];
    const end = t.range[1];
    const out = { type: t.type, value: t.value, start, end, line: lineAt(starts, start), endLine: lineAt(starts, Math.max(start, end - 1)), nl: t.loc.start.line > prevEnd };
    prevEnd = t.loc.end.line;
    return out;
  };
}

/**
 * Tokenize `src`: {tokens, comments, code, pair}. Each token and comment is
 * {type, value, start, end, line, endLine, nl}; `pair[i]` is the index of the
 * bracket matching token i, or -1.
 *
 * `path` picks the reading to prefer (readingsFor); both readings are tried.
 * When only one tokenizes it is used; when both do and they disagree on the
 * spans the code view blanks (an HTML-like comment, `<!--` or a `-->` at the
 * start of a line, opens a comment only in a script, so a backtick after it
 * opens a template only in a module), it throws: a file that reads two ways
 * fails closed. `sourceType` (and `jsx`) instead name the one reading, with
 * no fallback, for a caller that must read the file as eslint does. Every
 * throw carries `lineNumber`, a git line.
 */
function scanJs(src, { root, path: p = '', sourceType, jsx = true } = {}) {
  const espree = loadEspree(root);
  const starts = lineStarts(src);
  const readings = (sourceType ? [sourceType] : readingsFor(p)).map((type) => {
    try {
      return { raw: espree.tokenize(src, OPTIONS(type, jsx)) };
    } catch (err) {
      return { err };
    }
  });
  const read = readings.filter((r) => r.raw);
  if (read.length === 0) {
    const first = readings[0].err;
    const e = new Error(String((first && first.message) || first));
    e.lineNumber = first && Number.isInteger(first.index) ? lineAt(starts, first.index) : (first && Number.isInteger(first.lineNumber) ? first.lineNumber : null);
    throw e;
  }
  if (read.length === 2) {
    const at = firstDifference(blankedSpans(read[0].raw), blankedSpans(read[1].raw));
    if (at >= 0) {
      const e = new Error('the script and module readings disagree on its comments, strings or templates (an HTML-like comment <!-- or -->?)');
      e.lineNumber = lineAt(starts, at);
      throw e;
    }
  }
  const raw = read[0].raw;
  const tokens = raw.map(plainOf(starts));
  const comments = (raw.comments || []).map(plainOf(starts));
  const chars = src.split('');
  for (let k = 0; k < chars.length; k++) if (chars[k] !== '\n') chars[k] = ' ';
  for (const t of tokens) {
    if (!CODE_TYPES.has(t.type)) continue;
    for (let k = t.start; k < t.end; k++) chars[k] = src[k];
  }
  return { tokens, comments, code: chars.join(''), pair: pairs(tokens) };
}

// ---- token helpers ---------------------------------------------------------

const isPunc = (t, v) => Boolean(t) && t.type === 'Punctuator' && (v === undefined || t.value === v);
const isName = (t, v) => Boolean(t) && (t.type === 'Identifier' || t.type === 'Keyword') && (v === undefined || t.value === v);
const isOpen = (t) => isPunc(t) && (t.value === '(' || t.value === '[' || t.value === '{');
const isMemberDot = (t) => isPunc(t, '.') || isPunc(t, '?.');

// A literal that is one token: a string, a template with no ${}, a number.
const isStringLit = (t) => Boolean(t) && (t.type === 'String' || (t.type === 'Template' && t.value.startsWith('`') && t.value.endsWith('`') && !t.value.endsWith('${') && t.value.length >= 2));

// The text inside a one-token string or template literal.
const literalText = (t) => t.value.slice(1, -1);

function pairs(tokens) {
  const pair = new Int32Array(tokens.length).fill(-1);
  const stack = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'Punctuator') continue;
    if (t.value === '(' || t.value === '[' || t.value === '{') {
      stack.push(i);
    } else if (t.value === ')' || t.value === ']' || t.value === '}') {
      const j = stack.pop();
      if (j !== undefined) {
        pair[i] = j;
        pair[j] = i;
      }
    }
  }
  return pair;
}

// A ${ written $${ is a placeholder index ($1), never a value.
const dollarBefore = (v) => v.endsWith('$${') && !v.endsWith('\\$${');

/**
 * The template starting at token i: {end, interps}, `end` the index past its
 * closing token and `interps` each ${} body as a token range {from, to,
 * dollar}. A template with no ${} is one token.
 */
function templateParts(tokens, pair, i) {
  const interps = [];
  const head = tokens[i];
  if (!head.value.endsWith('${')) return { end: i + 1, interps };
  let from = i + 1;
  let dollar = dollarBefore(head.value);
  let j = i + 1;
  while (j < tokens.length) {
    const u = tokens[j];
    if (u.type === 'Template' && u.value.startsWith('}')) {
      interps.push({ from, to: j, dollar });
      if (!u.value.endsWith('${')) return { end: j + 1, interps };
      dollar = dollarBefore(u.value);
      from = j + 1;
      j++;
      continue;
    }
    if (u.type === 'Template') {
      j = templateParts(tokens, pair, j).end;
      continue;
    }
    if (isOpen(u) && pair[j] > j) {
      j = pair[j] + 1;
      continue;
    }
    j++;
  }
  return { end: tokens.length, interps };
}

/**
 * The arguments of the call whose opening paren is token `open`:
 * {args: [{from, to, interps, plus}], close}, each argument a token range, its
 * top-level template ${} bodies and its top-level + operators. Null when the
 * paren has no match.
 */
function callArgs(tokens, pair, open) {
  const close = pair[open];
  if (close < 0 || close < open) return null;
  const args = [];
  const fresh = (from) => ({ from, to: from, interps: [], plus: [] });
  let arg = fresh(open + 1);
  let i = open + 1;
  while (i < close) {
    const t = tokens[i];
    if (t.type === 'Template') {
      const p = templateParts(tokens, pair, i);
      arg.interps.push(...p.interps);
      i = p.end;
      continue;
    }
    if (isOpen(t) && pair[i] > i) {
      i = pair[i] + 1;
      continue;
    }
    if (isPunc(t, ',')) {
      arg.to = i;
      args.push(arg);
      arg = fresh(i + 1);
    } else if (isPunc(t, '+')) {
      arg.plus.push(i);
    }
    i++;
  }
  arg.to = close;
  if (arg.to > arg.from) args.push(arg);
  return { args, close };
}

// The call sites whose callee token i satisfies `isCallee(i)`: {callee, open},
// `open` the index of the call's (, which follows the callee directly or
// through ?. (`f(` and `f?.(`).
function callSites(tokens, isCallee) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    let open = -1;
    if (isPunc(tokens[i + 1], '(')) open = i + 1;
    else if (isPunc(tokens[i + 1], '?.') && isPunc(tokens[i + 2], '(')) open = i + 2;
    if (open > 0 && isCallee(i)) out.push({ callee: i, open });
  }
  return out;
}

// The name callee token i stands for: an identifier's or keyword's own name,
// or the string of a computed member (`pool['query']`, token i its `]`).
// Null for anything else.
function calleeName(tokens, pair, i) {
  const t = tokens[i];
  if (isName(t)) return t.value;
  if (isPunc(t, ']') && pair[i] === i - 2 && isStringLit(tokens[i - 1])) return literalText(tokens[i - 1]);
  return null;
}

// The index of the last token of the receiver of callee token i (`a` in a.b,
// a?.b, a['b'] and a?.['b']), or -1 for a bare name.
function receiverEnd(tokens, pair, i) {
  if (isPunc(tokens[i], ']') && pair[i] > 0) {
    const j = pair[i] - 1;
    return isPunc(tokens[j], '?.') ? j - 1 : j;
  }
  return isMemberDot(tokens[i - 1]) ? i - 2 : -1;
}

// A ${} that cannot carry a value: a $${n} placeholder index, an ALL_CAPS
// module constant, or a number.
function constantInterp(tokens, x) {
  if (x.dollar) return true;
  if (x.to - x.from !== 1) return false;
  const t = tokens[x.from];
  return (t.type === 'Identifier' && /^[A-Z][A-Z0-9_]*$/.test(t.value)) || (t.type === 'Numeric' && /^\d+$/.test(t.value));
}

// The token indices that make the first argument of the call at `open`
// unsafe: each ${} that interpolates a non-constant, and each top-level +.
function interpolatedFirstArg(tokens, pair, open) {
  const call = callArgs(tokens, pair, open);
  if (!call || call.args.length === 0) return [];
  const a = call.args[0];
  const out = [];
  for (const x of a.interps) if (x.to > x.from && !constantInterp(tokens, x)) out.push(x.from);
  out.push(...a.plus);
  return out;
}

module.exports = {
  lineStarts,
  lineAt,
  loadEspree,
  scanJs,
  isPunc,
  isName,
  isOpen,
  isMemberDot,
  isStringLit,
  literalText,
  templateParts,
  callArgs,
  callSites,
  calleeName,
  receiverEnd,
  interpolatedFirstArg,
};
