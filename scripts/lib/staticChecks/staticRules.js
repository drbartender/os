'use strict';

// staticRules: the per-file rules of scripts/static-checks.js, the allow
// marker and checkFile. A rule's check returns candidate lines; the engine
// keeps those on an added line (a span counts when any line of it was added),
// except for a whole-file rule.
//
// The allow marker, `static-checks: allow <rule>[, <rule>]`, downgrades a
// blocking finding to non-blocking and marks it `allowed`, so the review still
// sees it. It counts only inside a comment token (never in a string, SQL text
// or a package.json key), and only on a line of the finding or on a
// comment-only line directly above it. Only the idiom rules take it:
// parameterized-sql (SQL fragment builders), swallowed-catch (best-effort
// guards) and begin-without-rollback. The secret rules, stripe-direct,
// dangerously-set-inner-html, the package rules, pii, eslint-undef and
// env-ignored never do.

const path = require('path');
const { lineStarts, lineAt, scanJs, isPunc, isName, isMemberDot, isStringLit, literalText, callArgs, callSites, calleeName, receiverEnd, interpolatedFirstArg } = require('./jsScan');
const { envDefaults } = require('./envDefaults');
const { jsonStrings, depEntries, nonRegistry, floatsSecurity } = require('./packageJson');

// A JS file by its extension, in any case and with trailing whitespace after
// it: git's name is the name, never trimmed.
const JS_FILE = /\.(?:js|jsx|mjs|cjs|ts|tsx)\s*$/i;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const CLIENT_TEXT = /\.(?:js|jsx|mjs|cjs|ts|tsx|json|css|scss|html|svg)$/;
const PACKAGE_FILES = new Set(['package.json', 'client/package.json', 'thumbtack-agent/package.json']);
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp3|mp4|webm|wav|ogg|pdf|zip|gz|tgz)$/i;

// What ships to the browser: client/src/ code and text (tests aside), every
// text file under client/public/ (served as is), and client/.env* as a glob,
// any file directly in client/ whose name starts with .env (the build inlines
// REACT_APP_ values into the bundle).
const inClientBundle = (p) => (p.startsWith('client/src/') && CLIENT_TEXT.test(p) && !TEST_FILE.test(p))
  || (p.startsWith('client/public/') && !BINARY_EXT.test(p))
  || /^client\/\.env[^/]*$/.test(p);

// Production code: the security greps never read test files (a test signs
// with a test secret and stubs what it likes) or docs/ (vendored design
// exports); pii and eslint-undef read tests.
const isCode = (p) => JS_FILE.test(p) && !TEST_FILE.test(p) && !p.startsWith('docs/');

// ---- finding text ----------------------------------------------------------

const TEXT_CAP = 300;
const WITHHELD = '<text withheld: the PII mask did not load>';

// The PII mask (scripts/lib/piiShapes.js), loaded on first use. A mask that
// throws when it loads never takes the run down: every text is then withheld,
// never printed unmasked, and the CLI reports the mask as did not run.
let maskState = null;
function loadMask() {
  if (!maskState) {
    try {
      maskState = { mask: require('../piiShapes').mask };
    } catch (err) {
      maskState = { error: err };
    }
  }
  return maskState;
}

// Why the mask is unusable (an error name or code), or null when it loaded.
function maskFailure() {
  const { mask, error } = loadMask();
  if (error) return String((error && (error.code || error.name)) || 'Error');
  return typeof mask === 'function' ? null : 'no mask export';
}

function maskedText(raw, file) {
  const { mask } = loadMask();
  if (typeof mask !== 'function') return WITHHELD;
  const masked = mask(String(raw || '').trim(), { path: file });
  return masked.length > TEXT_CAP ? masked.slice(0, TEXT_CAP) + '...' : masked;
}

function lineRule(re) {
  return ({ added }) => [...added].filter(([, text]) => re.test(text)).map(([line]) => ({ line }));
}

// The same over the code view of each added line (an identifier, never text).
function codeLineRule(re) {
  return ({ added, codeLines }) => [...added].filter(([line]) => re.test(codeLines[line - 1] || '')).map(([line]) => ({ line }));
}

// `try { [await] <a.b>.query('ROLLBACK'); }` just before the catch at token i.
function rollbackTry(tokens, pair, i) {
  const close = i - 1;
  if (!isPunc(tokens[close], '}') || pair[close] < 0) return false;
  const open = pair[close];
  if (!isName(tokens[open - 1], 'try')) return false;
  let body = tokens.slice(open + 1, close);
  if (isPunc(body[body.length - 1], ';')) body = body.slice(0, -1);
  if (isName(body[0], 'await')) body = body.slice(1);
  const n = body.length;
  if (n < 6 || !isPunc(body[n - 1], ')') || !isStringLit(body[n - 2]) || literalText(body[n - 2]).trim().toUpperCase() !== 'ROLLBACK') return false;
  if (!isPunc(body[n - 3], '(')) return false;
  // `query(` or `query?.(`, on a receiver of names joined by . or ?.
  const q = isPunc(body[n - 4], '?.') ? n - 5 : n - 4;
  if (!isName(body[q], 'query')) return false;
  for (let k = 0; k < q; k++) {
    if (k % 2 === 0 ? !isName(body[k]) : !isMemberDot(body[k])) return false;
  }
  return q >= 2 && q % 2 === 0;
}

// A catch body that does nothing: empty, comments only, empty statements, or
// `void e;` statements.
function swallowedBody(tokens, from, to) {
  let k = from;
  while (k < to) {
    if (isPunc(tokens[k], ';')) {
      k++;
    } else if (isName(tokens[k], 'void') && tokens[k + 1] && tokens[k + 1].type === 'Identifier' && k + 2 <= to && (k + 2 === to || isPunc(tokens[k + 2], ';'))) {
      k += 2;
    } else {
      return false;
    }
  }
  return true;
}

const JWT_CALLS = new Set(['sign', 'verify']);

// The names a file signs or verifies through jsonwebtoken: {bare, members}.
// `bare` holds sign, verify and their aliases destructured from
// require('jsonwebtoken'), imported from it, or destructured from a member
// name; `members` holds jwt, jsonwebtoken and any name bound to the module.
function jwtNames(tokens, pair) {
  const bare = new Set();
  const members = new Set(['jwt', 'jsonwebtoken']);
  const fromBraces = (close, aliasWord) => {
    const open = pair[close];
    if (open < 0) return;
    for (let k = open + 1; k < close; k++) {
      if (!isName(tokens[k]) || !JWT_CALLS.has(tokens[k].value) || !(isPunc(tokens[k - 1], ',') || k === open + 1)) continue;
      const alias = isPunc(tokens[k + 1], aliasWord) || isName(tokens[k + 1], aliasWord) ? tokens[k + 2] : null;
      bare.add(alias && alias.type === 'Identifier' ? alias.value : tokens[k].value);
    }
  };
  tokens.forEach((t, k) => {
    if (!isStringLit(t) || literalText(t) !== 'jsonwebtoken') return;
    if (isPunc(tokens[k - 1], '(') && isName(tokens[k - 2], 'require') && isPunc(tokens[k - 3], '=')) {
      const left = tokens[k - 4];
      if (isPunc(left, '}')) fromBraces(k - 4, ':');
      else if (left && left.type === 'Identifier') members.add(left.value);
    } else if (isName(tokens[k - 1], 'from')) {
      const left = tokens[k - 2];
      if (isPunc(left, '}')) fromBraces(k - 2, 'as');
      else if (left && left.type === 'Identifier') members.add(left.value);
    }
  });
  // `const { sign: s } = jwt;`, the module object itself, never a property.
  tokens.forEach((t, k) => {
    if (t.type !== 'Identifier' || !members.has(t.value) || !isPunc(tokens[k - 1], '=') || !isPunc(tokens[k - 2], '}')) return;
    const next = tokens[k + 1];
    if (!isMemberDot(next) && !isPunc(next, '[') && !isPunc(next, '(')) fromBraces(k - 2, ':');
  });
  return { bare, members };
}

// A require('jsonwebtoken') call that ends at token c (its closing paren).
const jwtRequireAt = (tokens, pair, c) => isPunc(tokens[c], ')') && pair[c] === c - 2 && isStringLit(tokens[c - 1]) && literalText(tokens[c - 1]) === 'jsonwebtoken' && isName(tokens[c - 3], 'require');

// A literal naming the stripe package or one of its subpaths.
const isStripeSpec = (t) => isStringLit(t) && /^stripe(?:\/|$)/.test(literalText(t));

const AXIOS_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'request']);

// Every member-call matcher reads ?. as . (isMemberDot), and every call site
// comes from callSites, which reads f?.( as f(.

// The index of the argument's one literal token (a string, a template with no
// ${}, a number or a negative number), or null.
function literalArg(tokens, a) {
  const n = a.to - a.from;
  const t = tokens[a.from];
  if (n === 1 && (isStringLit(t) || t.type === 'Numeric')) return a.from;
  if (n === 2 && isPunc(t, '-') && tokens[a.from + 1].type === 'Numeric') return a.from + 1;
  return null;
}

// One reading per file, shared by secret-default and env-default.
function envDefaultsOf(ctx) {
  if (!ctx.envDefaults) ctx.envDefaults = envDefaults(ctx);
  return ctx.envDefaults;
}

const RULES = [
  {
    name: 'parameterized-sql',
    applies: isCode,
    // query( on any receiver, through ?. and as a computed member too
    // (pool['query'](, pool?.['query']().
    check: ({ tokens, pair }) => callSites(tokens, (i) => calleeName(tokens, pair, i) === 'query')
      .flatMap(({ callee, open }) => interpolatedFirstArg(tokens, pair, open).map((k) => ({ line: tokens[k].line, startLine: tokens[callee].line }))),
  },
  {
    name: 'command-injection',
    applies: isCode,
    // Any exec( or execSync(, bare or on any receiver (childProc, cp, a
    // require('child_process') result), through ?. or as a computed member
    // too, but never on a regex literal, which is RegExp.prototype.exec and
    // never a shell. The finding spans the call's line to the interpolation's.
    check: ({ tokens, pair }) => callSites(tokens, (i) => {
      const name = calleeName(tokens, pair, i);
      if (name !== 'exec' && name !== 'execSync') return false;
      if (tokens[i].type === 'Keyword' || isName(tokens[i - 1], 'function')) return false;
      const r = receiverEnd(tokens, pair, i);
      return !(r >= 0 && tokens[r] && tokens[r].type === 'RegularExpression');
    }).flatMap(({ callee, open }) => interpolatedFirstArg(tokens, pair, open).map((k) => ({ line: tokens[k].line, startLine: tokens[callee].line }))),
  },
  {
    name: 'ssrf',
    // Server-side only: a service worker's fetch(req.url) is the browser's own.
    applies: (p) => isCode(p) && !p.startsWith('client/'),
    check: ({ tokens, pair }) => {
      const out = [];
      const callee = (i) => {
        const t = tokens[i];
        if (isName(t, 'fetch') || isName(t, 'axios')) return true;
        if (!isMemberDot(tokens[i - 1])) return false;
        if (isName(tokens[i - 2], 'axios')) return AXIOS_METHODS.has(t.value);
        return (isName(tokens[i - 2], 'http') || isName(tokens[i - 2], 'https')) && (t.value === 'get' || t.value === 'request');
      };
      for (const { open } of callSites(tokens, callee)) {
        const call = callArgs(tokens, pair, open);
        if (!call || call.args.length === 0) continue;
        const a = call.args[0];
        for (let k = a.from; k < a.to; k++) {
          if (isName(tokens[k], 'req') && isMemberDot(tokens[k + 1])) {
            out.push({ line: tokens[k].line });
            break;
          }
        }
      }
      return out;
    },
  },
  {
    name: 'secrets-in-client-bundle',
    applies: inClientBundle,
    // A Stripe secret or restricted key, a webhook secret, or 32+ hex.
    check: lineRule(/\b[sr]k_(?:live|test)|\bwhsec_|(?<![0-9A-Za-z])[0-9A-Fa-f]{32,}(?![0-9A-Za-z])/),
  },
  {
    name: 'stripe-direct',
    applies: (p) => isCode(p) && p !== 'server/utils/stripeClient.js',
    // On tokens, over any lines: 'stripe' or 'stripe/...' (any quote) after
    // from or a bare import, or as the sole argument of require(, import(, a
    // name ending in Require (localRequire), or createRequire(...)(. A comment
    // or a string that names it is not a load.
    check: ({ tokens, pair }) => {
      const out = [];
      tokens.forEach((t, k) => {
        if (!isStripeSpec(t)) return;
        const prev = tokens[k - 1];
        if (isName(prev, 'from') || isName(prev, 'import')) {
          out.push({ line: t.line, startLine: prev.line });
          return;
        }
        if (!isPunc(prev, '(') || pair[k - 1] !== k + 1) return;
        const c = isPunc(tokens[k - 2], '?.') ? k - 3 : k - 2;
        const callee = tokens[c];
        if (!callee) return;
        const named = isName(callee, 'require') || isName(callee, 'import') || (callee.type === 'Identifier' && /Require$/.test(callee.value) && callee.value !== 'createRequire');
        const created = isPunc(callee, ')') && pair[c] > 0 && isName(tokens[pair[c] - 1], 'createRequire');
        if (named || created) out.push({ line: (created ? tokens[pair[c] - 1] : callee).line, endLine: tokens[k + 1].line });
      });
      return out;
    },
  },
  {
    name: 'stripe-test-mode-until',
    advisory: true,
    applies: (p) => !p.endsWith('.md') && !TEST_FILE.test(p) && path.posix.basename(p) !== '.env.example',
    check: lineRule(/STRIPE_TEST_MODE_UNTIL['"]?\s*[=:]\s*['"`]?\d{4}-\d{2}-\d{2}/),
  },
  {
    name: 'jwt-literal-secret',
    applies: isCode,
    check: ({ tokens, pair }) => {
      const { bare, members } = jwtNames(tokens, pair);
      // jwt.sign( and jwt.verify( on any name bound to the module or on a
      // require('jsonwebtoken') result, or a bare sign or verify (or alias)
      // taken from it.
      const callee = (i) => {
        const t = tokens[i];
        if (t.type !== 'Identifier') return false;
        if (isMemberDot(tokens[i - 1])) {
          const r = tokens[i - 2];
          return JWT_CALLS.has(t.value) && ((isName(r) && members.has(r.value)) || jwtRequireAt(tokens, pair, i - 2));
        }
        return bare.has(t.value) && !isName(tokens[i - 1], 'function');
      };
      const out = [];
      for (const { callee: i, open } of callSites(tokens, callee)) {
        const call = callArgs(tokens, pair, open);
        if (!call || call.args.length < 2) continue;
        const lit = literalArg(tokens, call.args[1]);
        if (lit !== null) out.push({ line: tokens[lit].line, startLine: tokens[i].line, literal: { start: tokens[call.args[1].from].start, end: tokens[lit].end } });
      }
      return out;
    },
  },
  {
    name: 'secret-default',
    applies: isCode,
    check: (ctx) => envDefaultsOf(ctx).filter((d) => d.secret).map((d) => ({ line: d.line, startLine: d.from, endLine: d.to, literal: d.literal })),
  },
  {
    name: 'env-default',
    advisory: true,
    applies: isCode,
    check: (ctx) => envDefaultsOf(ctx).filter((d) => !d.secret).map((d) => ({ line: d.line, startLine: d.from, endLine: d.to, literal: d.literal })),
  },
  {
    name: 'missing-auth-import',
    advisory: true,
    wholeFile: true,
    applies: (p) => p.startsWith('server/routes/') && isCode(p),
    check: ({ src, code, starts, isNew }) => {
      if (!isNew) return [];
      const handler = /\brouter\.(?:get|post|put|patch|delete|all)\s*\(/.exec(code);
      const imported = /(?:const|let|var)\s*\{[^}]*\bauth\b[^}]*\}\s*=\s*require\s*\(|\bimport\s*\{[^}]*\bauth\b[^}]*\}\s*from\b|\bauth\s*=\s*require\s*\(/.test(src);
      return handler && !imported ? [{ line: lineAt(starts, handler.index) }] : [];
    },
  },
  {
    name: 'dangerously-set-inner-html',
    applies: isCode,
    check: codeLineRule(/dangerouslySetInnerHTML/),
  },
  {
    name: 'swallowed-catch',
    applies: isCode,
    check: ({ tokens, pair }) => {
      // The try/catch clause only; a promise .catch(() => {}) is the codebase's
      // fire-and-forget idiom (the ROLLBACK and stream-cancel tails) and out of
      // scope, as it was in the security-review check this replaces. So is the
      // same tail as a try: a failed ROLLBACK inside a catch that rethrows the
      // original error has nothing left to report.
      const out = [];
      for (let i = 0; i < tokens.length; i++) {
        if (!(tokens[i].type === 'Keyword' && tokens[i].value === 'catch') || isMemberDot(tokens[i - 1])) continue;
        let open = i + 1;
        if (isPunc(tokens[open], '(')) open = pair[open] + 1;
        if (open <= i || !isPunc(tokens[open], '{') || pair[open] < open) continue;
        if (rollbackTry(tokens, pair, i)) continue;
        const close = pair[open];
        if (swallowedBody(tokens, open + 1, close)) out.push({ line: tokens[i].line, endLine: tokens[close].line });
      }
      return out;
    },
  },
  {
    name: 'begin-without-rollback',
    applies: isCode,
    // A SQL BEGIN or START TRANSACTION (any case) opening a string or
    // template, or alone on a line of a template outside a dollar-quoted
    // body, in a file whose strings and templates hold no ROLLBACK (a ROLLBACK
    // in a comment does not count). An iCal 'BEGIN:VEVENT' is not SQL.
    check: ({ tokens }) => {
      const lits = tokens.filter((t) => t.type === 'String' || t.type === 'Template');
      if (lits.some((t) => /\bROLLBACK\b/i.test(t.value))) return [];
      const out = [];
      let template = '';
      for (const t of lits) {
        // The template text so far: a ${} splits one template into tokens
        // (a string inside the ${} leaves it alone).
        if (t.type === 'Template') template = t.value.startsWith('}') ? template + t.value : t.value;
        const at = (offset) => t.line + (t.value.slice(0, offset).match(/\n/g) || []).length;
        const head = /^([`'"}]\s*)(?:BEGIN|START\s+TRANSACTION)(?![:\w-])/i.exec(t.value);
        if (head) {
          out.push({ line: at(head[1].length) });
          continue;
        }
        if (t.type !== 'Template') continue;
        // Inside a dollar-quoted body (DO $$ ... $$, a function body) or after
        // a DECLARE section, a BEGIN opens a PL/pgSQL block, which runs as one
        // statement.
        const alone = /\n[ \t]*BEGIN[ \t]*;?[ \t]*(?=\n|`|\$\{)/i.exec(t.value);
        if (!alone) continue;
        const before = template.slice(0, template.length - t.value.length + alone.index);
        const block = (before.match(/\$[A-Za-z_]*\$/g) || []).length % 2 === 1 || /\bDECLARE\b/i.test(before);
        if (!block) out.push({ line: at(alone.index + 1) });
      }
      return out;
    },
  },
  {
    name: 'floating-security-versions',
    applies: (p) => PACKAGE_FILES.has(p),
    check: (ctx) => depEntries(ctx).filter(floatsSecurity).map(({ line }) => ({ line })),
  },
  {
    name: 'file-or-git-deps',
    applies: (p) => PACKAGE_FILES.has(p),
    check: (ctx) => depEntries(ctx).filter(({ spec }) => nonRegistry(spec)).map(({ line }) => ({ line })),
  },
];

const ALLOWABLE = new Set(['parameterized-sql', 'swallowed-catch', 'begin-without-rollback']);
const MARKER = /static-checks:\s*allow\s+([a-z][a-z-]*(?:\s*,\s*[a-z][a-z-]*)*)/;

// True when a comment token names `rule` in the marker and sits on a line of
// the finding (from..to), or fills a comment-only line directly above it.
function allowedBy({ comments, codeLines }, rule, from, to) {
  if (!ALLOWABLE.has(rule)) return false;
  const blank = (n) => (codeLines[n - 1] || '').trim() === '';
  for (const c of comments) {
    const m = MARKER.exec(c.value);
    if (!m || !m[1].split(/\s*,\s*/).includes(rule)) continue;
    if (c.line <= to && c.endLine >= from) return true;
    if (c.endLine === from - 1) {
      let commentOnly = true;
      for (let n = c.line; n <= c.endLine && commentOnly; n++) commentOnly = blank(n);
      if (commentOnly) return true;
    }
  }
  return false;
}

// The rules whose literal (hit.literal, source offsets) no finding prints:
// every finding's text on a line one of them touches, any rule's, eslint's and
// pii's included, has <LITERAL> in its place.
const LITERAL_RULES = new Set(['secret-default', 'jwt-literal-secret', 'env-default']);

// Line `line` of `src` with every span of `spans` ({start, end} offsets, end
// exclusive) that reaches it replaced by <LITERAL>.
function redactedLine(src, starts, line, spans = []) {
  const lineStart = starts[line - 1] ?? 0;
  const nl = src.indexOf('\n', lineStart);
  const lineEnd = nl < 0 ? src.length : nl;
  const cuts = spans.filter((s) => s.start < lineEnd && s.end > lineStart)
    .map((s) => [Math.max(s.start, lineStart), Math.min(s.end, lineEnd)])
    .sort((x, y) => x[0] - y[0]);
  let out = '';
  let pos = lineStart;
  for (const [a, b] of cuts) {
    if (b <= pos) continue;
    if (a >= pos) out += src.slice(pos, a) + '<LITERAL>';
    pos = b;
  }
  return out + src.slice(pos, lineEnd);
}

// The rule findings for one changed file. `spans`, when given, is a Map that
// receives this file's secret-rule literal spans (path -> [{start, end}]),
// so the eslint and pii texts can leave them out too.
function checkFile(file, src, { root, spans: spanMap } = {}) {
  // A blob git cannot hand over (a gitlink, a path holding a newline, a
  // missing object). A code file or package.json, whose rules read the whole
  // file, fails closed: never an empty file or a rebuild from the added lines.
  // Any other file runs its line rules on the added lines, which come from the
  // diff itself; the rebuild only gives their text a line to print.
  if (src === undefined && (JS_FILE.test(file.path) || PACKAGE_FILES.has(file.path))) {
    return [{ rule: 'scan', file: file.path, line: null, text: maskedText('the file could not be read from git as a blob (a gitlink, a path cat-file cannot take, or a missing object); no rule ran on it', file.path), blocking: true }];
  }
  let text = src;
  if (text === undefined) {
    const sparse = [];
    for (const [n, t] of file.added) sparse[n - 1] = t;
    text = Array.from(sparse, (t) => t ?? '').join('\n');
  }
  let scan = { tokens: [], comments: [], code: text, pair: new Int32Array(0) };
  if (JS_FILE.test(file.path)) {
    try {
      scan = scanJs(text, { root, path: file.path });
    } catch (err) {
      // Fail closed: a file the scanner cannot read runs no rule.
      return [{ rule: 'scan', file: file.path, line: err.lineNumber || null, text: maskedText(`could not tokenize: ${err.message}`, file.path), blocking: true }];
    }
  }
  let json = null;
  if (PACKAGE_FILES.has(file.path)) {
    json = jsonStrings(text);
    if (json === null) return [{ rule: 'scan', file: file.path, line: null, text: 'could not parse the file as JSON', blocking: true }];
  }
  const { tokens, comments, code, pair } = scan;
  const ctx = { json, path: file.path, src: text, code, codeLines: code.split('\n'), starts: lineStarts(text), tokens, comments, pair, added: file.added, isNew: file.status === 'A' };
  const results = RULES.filter((rule) => rule.applies(file.path)).map((rule) => [rule, rule.check(ctx)]);
  // Every secret-rule literal, whatever line was added.
  const spans = [];
  for (const [rule, hits] of results) if (LITERAL_RULES.has(rule.name)) for (const h of hits) if (h.literal) spans.push(h.literal);
  if (spanMap && spans.length > 0) spanMap.set(file.path, spans);
  // One finding per rule and line (the output keeps one per rule, file and
  // line anyway), each line's text masked once: a minified line with
  // thousands of hits costs one mask of that line, not one per hit. The allow
  // marker is read per hit, before that dedupe: a line's finding is allowed
  // only when every hit of the rule on it is, so an allowed call never hides
  // an un-allowed one that lands on the same line. Only the marker comments
  // are searched, and a line already blocking skips its later hits.
  const marks = { comments: comments.filter((c) => MARKER.test(c.value)), codeLines: ctx.codeLines };
  const out = [];
  const texts = new Map();
  for (const [rule, hits] of results) {
    const byLine = new Map();
    for (const hit of hits) {
      const prior = byLine.get(hit.line);
      // Blocking or advisory already: no later hit can change it.
      if (prior && !prior.allowed) continue;
      // The lines the finding spans: its own line, or startLine..endLine.
      const begin = Math.min(hit.startLine || hit.line, hit.line);
      const end = Math.max(hit.endLine || hit.line, hit.line);
      if (!rule.wholeFile) {
        let touched = false;
        for (let n = begin; n <= end && !touched; n++) touched = file.added.has(n);
        if (!touched) continue;
      }
      const allowed = !rule.advisory && allowedBy(marks, rule.name, begin, end);
      if (prior) {
        if (!allowed) {
          prior.blocking = true;
          delete prior.allowed;
        }
        continue;
      }
      if (!texts.has(hit.line)) texts.set(hit.line, maskedText(redactedLine(text, ctx.starts, hit.line, spans), file.path));
      const f = { rule: rule.name, file: file.path, line: hit.line, text: texts.get(hit.line), blocking: !rule.advisory && !allowed };
      if (allowed) f.allowed = true;
      byLine.set(hit.line, f);
      out.push(f);
    }
  }
  return out;
}

module.exports = { RULES, ALLOWABLE, allowedBy, checkFile, maskedText, maskFailure, redactedLine, TEXT_CAP };
