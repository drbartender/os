'use strict';

// envDefaults: the env-default reader behind the secret-default and
// env-default rules of scripts/lib/staticChecks/staticRules.js, over the
// espree tokens of scripts/lib/staticChecks/jsScan.js.
//
// An env read (`process.env.NAME`, `process.env['NAME']`, or the same through
// an alias: `const { env } = process` or `const e = process.env`) that falls
// back to a value: any term after it in a || or ?? chain of any length it sits
// in (split over lines or not; a literal mid-chain is the value the chain
// yields), the right side of a `||=` or `??=` it is the target of, the other
// arm of a ternary it is an arm of, or the default of a destructuring from
// process.env or an alias. Grouping parens around a fallback are unwrapped.
// A secret name with a literal fallback (a string, a number, a template with
// or without ${}, or a concatenation with a literal part; an empty string
// included: createHmac computes with '') is secret-default, blocking; `null`
// and `undefined` are exempt there (createHmac and jwt.sign throw on them).
// Any other literal, `null`, and a named constant (an ALL_CAPS identifier,
// advisory by ruling) are env-default, advisory.

const { isPunc, isName, isMemberDot, isStringLit, literalText } = require('./jsScan');

// A secret name, any case: SECRET, PASSWORD, PASSWD, APIKEY or PRIVATE
// anywhere (JWT_SECRET, VAPID_PRIVATE, a bare SECRET), _KEY or _TOKEN anywhere
// (STRIPE_SECRET_KEY_TEST, X_KEYFILE, GITHUB_TOKENS), or KEY or TOKEN as the
// first segment. KEYBOARD_LAYOUT, MONKEY and TOKENIZER_MODEL are not.
const isSecretName = (name) => {
  const n = String(name).toUpperCase();
  return /SECRET|PASSWORD|PASSWD|APIKEY|PRIVATE/.test(n) || /_(?:KEY|TOKEN)/.test(n) || /^(?:KEY|TOKEN)(?:_|$)/.test(n);
};

const isOpenTok = (t) => isPunc(t) && (t.value === '(' || t.value === '[' || t.value === '{');

// The names that stand for process.env in this file: `{ env } = process`,
// `{ env: e } = process` and `e = process.env`.
function envAliases(tokens, pair) {
  const names = new Set();
  tokens.forEach((t, k) => {
    if (!isName(t, 'process') || isMemberDot(tokens[k - 1]) || !isPunc(tokens[k - 1], '=')) return;
    const left = tokens[k - 2];
    if (isMemberDot(tokens[k + 1]) && isName(tokens[k + 2], 'env')) {
      const after = tokens[k + 3];
      if (left && left.type === 'Identifier' && !isMemberDot(after) && !isPunc(after, '[')) names.add(left.value);
      return;
    }
    if (isMemberDot(tokens[k + 1]) || isPunc(tokens[k + 1], '[') || !isPunc(left, '}') || pair[k - 2] < 0) return;
    const open = pair[k - 2];
    for (let j = open + 1; j < k - 2; j++) {
      if (isOpenTok(tokens[j]) && pair[j] > j) {
        j = pair[j];
        continue;
      }
      if (!isName(tokens[j], 'env') || !(j === open + 1 || isPunc(tokens[j - 1], ','))) continue;
      const alias = isPunc(tokens[j + 1], ':') ? tokens[j + 2] : null;
      names.add(alias && alias.type === 'Identifier' ? alias.value : 'env');
    }
  });
  return names;
}

// The env read starting at token i: {name, end}, or null.
function envRead(tokens, i, aliases) {
  let k;
  if (isName(tokens[i], 'process') && !isMemberDot(tokens[i - 1]) && isMemberDot(tokens[i + 1]) && isName(tokens[i + 2], 'env')) k = i + 3;
  else if (aliases && tokens[i] && tokens[i].type === 'Identifier' && aliases.has(tokens[i].value) && !isMemberDot(tokens[i - 1])) k = i + 1;
  else return null;
  const a = tokens[k];
  if (isMemberDot(a) && isName(tokens[k + 1])) return { name: tokens[k + 1].value, end: k + 2 };
  const b = isPunc(a, '?.') ? k + 1 : k;
  if (isPunc(tokens[b], '[') && isStringLit(tokens[b + 1]) && isPunc(tokens[b + 2], ']')) return { name: literalText(tokens[b + 1]), end: b + 3 };
  return null;
}

const STOPS = new Set([',', ';', '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=', '?', ':', '=>', '...']);
const STOP_WORDS = new Set(['return', 'throw', 'case', 'yield', 'const', 'let', 'var', 'export', 'default', 'if', 'else', 'while', 'for', 'do', 'switch', 'in', 'of']);
const isStop = (t) => (isPunc(t) && STOPS.has(t.value)) || (t.type === 'Keyword' && STOP_WORDS.has(t.value));
const isClose = (t) => isPunc(t) && (t.value === ')' || t.value === ']' || t.value === '}');
const isPlainTpl = (t) => t.type === 'Template' && isStringLit(t);
// Two consecutive tokens with a line terminator between them that ASI would
// split: an expression ends at `a` and a new one starts at `b`. `b.nl` is
// espree's reading (any JS line terminator), not the git line.
const endsExpr = (t) => isClose(t) || ['Identifier', 'Keyword', 'String', 'Numeric', 'Boolean', 'Null', 'RegularExpression'].includes(t.type) || isPlainTpl(t) || (t.type === 'Template' && t.value.endsWith('`'));
const startsExpr = (t) => ['Identifier', 'Keyword', 'String', 'Numeric', 'Boolean', 'Null'].includes(t.type) || (t.type === 'Template' && t.value.startsWith('`'));
const asiBetween = (a, b) => b.nl && endsExpr(a) && startsExpr(b);

// Template openers and closers matched: {open: closer -> opener, close: opener -> closer}.
function templateIndex(tokens) {
  const open = new Map();
  const close = new Map();
  const stack = [];
  tokens.forEach((t, i) => {
    if (t.type !== 'Template') return;
    const o = t.value.endsWith('${');
    const c = t.value.startsWith('}');
    if (o && !c) {
      stack.push(i);
    } else if (c && !o) {
      const j = stack.pop();
      if (j !== undefined) {
        open.set(i, j);
        close.set(j, i);
      }
    }
  });
  return { open, close };
}

// The first token of the expression segment that holds token r: walking left
// over whole groups and templates, up to an enclosing bracket, a ${, a
// separator or statement keyword, or a line break ASI would split at.
function segmentStart(tokens, pair, tpl, r) {
  for (let i = r - 1; i >= 0; i--) {
    const t = tokens[i];
    if (asiBetween(t, tokens[i + 1])) return i + 1;
    if (isClose(t)) {
      if (pair[i] < 0) return i + 1;
      i = pair[i];
    } else if (isOpenTok(t) || isStop(t)) {
      return i + 1;
    } else if (t.type === 'Template' && !isPlainTpl(t)) {
      if (!tpl.open.has(i)) return i + 1;
      i = tpl.open.get(i);
    }
  }
  return 0;
}

// The index just past the expression segment that starts at token e.
function segmentEnd(tokens, pair, tpl, e) {
  for (let i = e; i < tokens.length; i++) {
    const t = tokens[i];
    if (i > e && asiBetween(tokens[i - 1], t)) return i;
    if (isOpenTok(t)) {
      if (pair[i] < 0) return i;
      i = pair[i];
    } else if (isClose(t) || isStop(t)) {
      return i;
    } else if (t.type === 'Template' && !isPlainTpl(t)) {
      if (!tpl.close.has(i)) return i;
      i = tpl.close.get(i);
    }
  }
  return tokens.length;
}

// The top-level token indices of [from, to) that satisfy `pred`, skipping
// groups and templates.
function topLevel(tokens, pair, tpl, from, to, pred) {
  const out = [];
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    if (pred(i)) out.push(i);
    if (isOpenTok(t) && pair[i] > i) i = pair[i];
    else if (t.type === 'Template' && tpl.close.has(i)) i = tpl.close.get(i);
  }
  return out;
}

// [from, to) with the grouping parens that wrap all of it taken off.
function unwrap(tokens, pair, from, to) {
  let a = from;
  let b = to;
  while (b - a >= 2 && isPunc(tokens[a], '(') && pair[a] === b - 1) {
    a++;
    b--;
  }
  return [a, b];
}

// A term that is a literal on its own: a string, a number, a boolean, a
// negative number, or a whole template (with ${} bodies or without).
function isLiteralTerm(tokens, tpl, from, to) {
  const n = to - from;
  const t = tokens[from];
  if (n === 1) return isStringLit(t) || t.type === 'Numeric' || t.type === 'Boolean';
  if (n === 2) return isPunc(t, '-') && tokens[from + 1].type === 'Numeric';
  return n > 2 && t.type === 'Template' && tpl.close.get(from) === to - 1;
}

// The fallback in [from, to): {kind, from, to}, its grouping parens taken off.
// kind is 'literal' (a literal term, or a concatenation with a literal part),
// 'null', 'undefined', 'constant', or null when the term is anything else.
function fallbackOf(tokens, pair, tpl, from0, to0) {
  const [from, to] = unwrap(tokens, pair, from0, to0);
  const out = (kind) => ({ kind, from, to });
  if (to <= from) return out(null);
  if (isLiteralTerm(tokens, tpl, from, to)) return out('literal');
  if (to - from === 1) {
    const t = tokens[from];
    if (t.type === 'Null') return out('null');
    if (isName(t, 'undefined')) return out('undefined');
    if (t.type === 'Identifier' && /^[A-Z][A-Z0-9_]*$/.test(t.value)) return out('constant');
    return out(null);
  }
  const plus = topLevel(tokens, pair, tpl, from, to, (i) => isPunc(tokens[i], '+'));
  const bounds = [from - 1, ...plus, to];
  for (let k = 0; plus.length > 0 && k + 1 < bounds.length; k++) {
    const [a, b] = unwrap(tokens, pair, bounds[k] + 1, bounds[k + 1]);
    if (b > a && isLiteralTerm(tokens, tpl, a, b)) return out('literal');
  }
  return out(null);
}

// A ( that groups an expression rather than calling or opening a statement's
// condition: nothing before it, an operator, or an expression keyword.
const GROUP_WORDS = new Set(['return', 'typeof', 'void', 'await', 'yield', 'in', 'of', 'case', 'throw', 'delete', 'instanceof']);
function isGroupParen(tokens, i) {
  if (!isPunc(tokens[i], '(')) return false;
  const p = tokens[i - 1];
  if (!p) return true;
  if (p.type === 'Keyword') return GROUP_WORDS.has(p.value);
  return p.type === 'Punctuator' && !isClose(p) && p.value !== '?.';
}

// The colon of the ternary whose ? is token q, or -1.
function ternaryColon(tokens, pair, tpl, q) {
  let nest = 0;
  for (let i = q + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (isOpenTok(t) && pair[i] > i) {
      i = pair[i];
    } else if (t.type === 'Template' && tpl.close.has(i)) {
      i = tpl.close.get(i);
    } else if (isClose(t) || isPunc(t, ';') || (isPunc(t, ',') && nest === 0)) {
      return -1;
    } else if (isPunc(t, '?')) {
      nest++;
    } else if (isPunc(t, ':')) {
      if (nest === 0) return i;
      nest--;
    }
  }
  return -1;
}

// Every env default in the file: [{secret, kind, line, from, to, literal}],
// `line` the fallback's line, from..to the lines it spans with its env read,
// and `literal` the fallback's source offsets {start, end}.
function envDefaults({ tokens, pair }) {
  const tpl = templateIndex(tokens);
  const aliases = envAliases(tokens, pair);
  const readAt = (i) => envRead(tokens, i, aliases);
  const out = [];
  const seen = new Set();
  const push = (secret, fallback, firstIdx) => {
    const { kind, from, to } = fallback;
    if (kind === null || kind === 'undefined') return;
    const lit = to - from === 2 && isPunc(tokens[from], '-') ? from + 1 : from;
    if (seen.has(lit)) return;
    seen.add(lit);
    const a = tokens[firstIdx].line;
    const b = tokens[lit].line;
    out.push({ secret: secret && kind === 'literal', kind, line: b, from: Math.min(a, b), to: Math.max(a, b), literal: { start: tokens[from].start, end: tokens[to - 1].end } });
  };
  // The env reads at the top level of [from, to), and inside grouping parens
  // there (never inside a call: foo(process.env.X) || 'y' defaults foo's value).
  const readsIn = (from, to) => {
    const out2 = [];
    for (const i of topLevel(tokens, pair, tpl, from, to, (k) => readAt(k) !== null || isGroupParen(tokens, k))) {
      if (isGroupParen(tokens, i)) out2.push(...readsIn(i + 1, pair[i]));
      else out2.push(readAt(i));
    }
    return out2;
  };
  for (let r = 0; r < tokens.length; r++) {
    const read = readAt(r);
    if (!read) continue;
    // `process.env.X ||= <fallback>` and `??=`: the right side.
    if (isPunc(tokens[read.end], '||=') || isPunc(tokens[read.end], '??=')) {
      push(isSecretName(read.name), fallbackOf(tokens, pair, tpl, read.end + 1, segmentEnd(tokens, pair, tpl, read.end + 1)), r);
    }
    // The || or ?? chain the read sits in: its segment split at the top-level
    // || and ?? operators; every term after the read is a fallback (a literal
    // mid-chain is the value the chain yields). A chain inside grouping parens
    // is one term of the chain around them.
    let at = r;
    let after = read.end;
    for (;;) {
      const start = segmentStart(tokens, pair, tpl, at);
      const end = segmentEnd(tokens, pair, tpl, after);
      const ops = topLevel(tokens, pair, tpl, start, end, (i) => isPunc(tokens[i], '||') || isPunc(tokens[i], '??'));
      ops.forEach((op, j) => {
        if (op <= at) return;
        push(readsIn(start, op).some((x) => isSecretName(x.name)), fallbackOf(tokens, pair, tpl, op + 1, j + 1 < ops.length ? ops[j + 1] : end), start);
      });
      const open = start - 1;
      if (!isGroupParen(tokens, open) || pair[open] !== end) break;
      at = open;
      after = end + 1;
    }
  }
  // A destructuring default: `{ NAME = <fallback>, ... } = process.env` (or
  // an alias), the env object itself, never a property of it.
  for (let r = 0; r + 1 < tokens.length; r++) {
    let next;
    if (isName(tokens[r], 'process') && isMemberDot(tokens[r + 1]) && isName(tokens[r + 2], 'env')) next = tokens[r + 3];
    else if (tokens[r].type === 'Identifier' && aliases.has(tokens[r].value)) next = tokens[r + 1];
    else continue;
    if (isMemberDot(tokens[r - 1]) || isMemberDot(next) || isPunc(next, '[') || isPunc(next, '(')) continue;
    if (!isPunc(tokens[r - 1], '=') || !isPunc(tokens[r - 2], '}') || pair[r - 2] < 0) continue;
    const open = pair[r - 2];
    const commas = topLevel(tokens, pair, tpl, open + 1, r - 2, (i) => isPunc(tokens[i], ','));
    const bounds = [open, ...commas, r - 2];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const from = bounds[k] + 1;
      const to = bounds[k + 1];
      const key = tokens[from];
      if (from >= to) continue;
      const name = isStringLit(key) ? literalText(key) : isName(key) ? key.value : null;
      const eq = topLevel(tokens, pair, tpl, from, to, (i) => isPunc(tokens[i], '='));
      if (name && eq.length === 1) push(isSecretName(name), fallbackOf(tokens, pair, tpl, eq[0] + 1, to), from);
    }
  }
  // A ternary arm: `cond ? <read> : <fallback>` or `cond ? <fallback> : <read>`.
  for (let q = 0; q < tokens.length; q++) {
    if (!isPunc(tokens[q], '?')) continue;
    const colon = ternaryColon(tokens, pair, tpl, q);
    if (colon < 0) continue;
    const arms = [[q + 1, colon], [colon + 1, segmentEnd(tokens, pair, tpl, colon + 1)]];
    for (const [self, other] of [[arms[0], arms[1]], [arms[1], arms[0]]]) {
      const reads = readsIn(self[0], self[1]);
      if (reads.length > 0) push(reads.some((x) => isSecretName(x.name)), fallbackOf(tokens, pair, tpl, other[0], other[1]), self[0]);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

module.exports = { envDefaults, isSecretName };
