'use strict';

// node:test suite for scripts/lib/staticChecks/staticRules.js: checkFile over
// synthetic changed files (no git), one case per shape the rules must read.
// The CLI end to end, eslint-undef and pii are in scripts/static-checks.test.js.
//
// Ids only: no names, no assignable number, no key literal (the live-key shapes
// are built from parts at run time).

const { test } = require('node:test');
const assert = require('node:assert');
const { checkFile } = require('./staticRules');

function L(...lines) {
  return lines.join('\n') + '\n';
}

// A changed file whose every line was added (a new file), or only `addedLines`.
function changed(path, text, { status = 'A', addedLines } = {}) {
  const added = new Map();
  text.split('\n').forEach((t, i) => {
    if (!addedLines || addedLines.includes(i + 1)) added.set(i + 1, t);
  });
  return { path, oldPath: status === 'A' ? null : path, status, added };
}

function run(path, text, opts) {
  return checkFile(changed(path, text, opts), text);
}

function lines(findings, rule) {
  return findings.filter((f) => f.rule === rule).map((f) => f.line);
}

function lineOf(text, needle) {
  const idx = text.split('\n').findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`fixture lacks ${needle}`);
  return idx + 1;
}

// ---- the code view (ruling 1) -------------------------------------------------

test('code view: a JSX closing tag before dangerouslySetInnerHTML on the same line does not hide it', () => {
  const src = L(
    'export function A({ html }) {',
    '  return <p><b>x</b><span dangerouslySetInnerHTML={{ __html: html }} /></p>;',
    '}',
  );
  assert.deepStrictEqual(lines(run('client/src/A.js', src), 'dangerously-set-inner-html'), [2]);
});

test('code view: an apostrophe in JSX text does not open a string', () => {
  const src = L(
    'export function B({ html }) {',
    "  return <p>Don't<span dangerouslySetInnerHTML={{ __html: html }} /></p>;",
    '}',
  );
  assert.deepStrictEqual(lines(run('client/src/B.js', src), 'dangerously-set-inner-html'), [2]);
});

test('code view: a /* in JSX text does not open a comment over the lines after it', () => {
  const src = L(
    'export function C({ html }) {',
    '  return (',
    '    <div>',
    '      <p>Use /* here</p>',
    '      <span dangerouslySetInnerHTML={{ __html: html }} />',
    '    </div>',
    '  );',
    '}',
  );
  assert.deepStrictEqual(lines(run('client/src/C.js', src), 'dangerously-set-inner-html'), [5]);
});

test('code view: i++ / 2 is a division, so an exec at column 0 of the next line is still code', () => {
  const src = L(
    "const { exec } = require('child_process');",
    'let i = 0;',
    'const dir = process.argv[2];',
    'i++ / 2;',
    'exec(`ls ${dir}`);',
  );
  assert.deepStrictEqual(lines(run('server/utils/div.js', src), 'command-injection'), [5]);
});

test('code view: a regex literal holding a quote and a backtick does not open a string', () => {
  const src = L(
    "const { exec } = require('child_process');",
    'function f(dir, s) {',
    "  const q = /['`]/.test(s);",
    '  exec(`ls ${dir}`);',
    '  return q;',
    '}',
  );
  assert.deepStrictEqual(lines(run('server/utils/rx.js', src), 'command-injection'), [4]);
});

test('code view: a division after a closing paren is not a regex', () => {
  const src = L(
    "const { exec } = require('child_process');",
    'function f(n, dir) {',
    "  const half = (n) / 2; exec(`ls ${dir}`); const s = '/';",
    '  return [half, s];',
    '}',
  );
  assert.deepStrictEqual(lines(run('server/utils/half.js', src), 'command-injection'), [3]);
});

test('code view: a pattern inside a template, a string or a comment is not code', () => {
  const src = L(
    'const a = `dangerouslySetInnerHTML ${1}`;',
    "const b = 'exec(`ls ${dir}`)';",
    '// catch (e) {}',
    'module.exports = { a, b };',
  );
  const got = run('server/utils/quiet.js', src);
  assert.deepStrictEqual(got, []);
});

test('a file that does not tokenize gets one blocking scan finding and no rule runs on it (fail closed)', () => {
  const src = L(
    "const { exec } = require('child_process');",
    "const s = 'unterminated;",
    'exec(`ls ${s}`);',
  );
  const got = run('server/utils/broken.js', src);
  assert.strictEqual(got.length, 1, JSON.stringify(got));
  assert.strictEqual(got[0].rule, 'scan');
  assert.strictEqual(got[0].blocking, true);
  assert.match(got[0].text, /^could not tokenize: /);
  assert.strictEqual(got[0].line, 2);
});

test('a U+2028, a U+2029 or a lone CR above a change shifts neither the finding line nor its text', () => {
  for (const [name, head] of [
    ['U+2028 in a string', "const note = 'a\u2028b';"],
    ['U+2029 in a block comment', '/* a\u2029b */'],
    ['a lone CR between statements', 'const one = 1;\rconst two = 2;'],
  ]) {
    const src = L("'use strict';", head, "const hook = process.env.HOOK_SECRET || 'changeme';", 'try { f(); } catch {}', 'module.exports = { hook };');
    const got = run('server/utils/sep.js', src, { status: 'M', addedLines: [3, 4] });
    assert.deepStrictEqual(verdicts(got, 'secret-default'), [[3, true, false]], name);
    assert.deepStrictEqual(verdicts(got, 'swallowed-catch'), [[4, true, false]], name);
    assert.strictEqual(got.find((f) => f.rule === 'secret-default').text, 'const hook = process.env.HOOK_SECRET || <LITERAL>;', name);
  }
});

// `<!--` opens a comment in a script and is three operators in a module, so a
// backtick after it opens a template only in the module reading.
const HTML_COMMENT = L(
  "'use strict';",
  'let b = 0;',
  'const a = 1 <!-- b + `',
  "function f(dir) { return require('child_process').exec('ls ' + dir); }",
  '// `;',
  'module.exports = { a, f };',
);

test('the <!-- and backtick shape never yields 0 findings: the two readings disagree, so the file blocks with a scan finding', () => {
  for (const p of ['server/utils/html.js', 'scripts/html.js', 'client/src/html.js']) {
    const got = run(p, HTML_COMMENT);
    assert.deepStrictEqual(got.map((f) => [f.rule, f.line, f.blocking]), [['scan', 3, true]], p);
    assert.match(got[0].text, /disagree/, p);
  }
});

test('a code file or package.json with no blob is one blocking scan finding; a text file still runs its line rules on the added lines', () => {
  const js = changed('server/utils/gone.js', L("const { exec } = require('child_process');", 'exec(`ls ${process.argv[2]}`);'));
  assert.deepStrictEqual(checkFile(js, undefined).map((f) => [f.rule, f.line, f.blocking]), [['scan', null, true]]);
  const pkg = changed('package.json', L('{ "dependencies": { "a": "file:../a" } }'));
  assert.deepStrictEqual(checkFile(pkg, undefined).map((f) => [f.rule, f.line, f.blocking]), [['scan', null, true]]);
  const notes = changed('client/public/notes.md', L('hook whsec_' + 'W'.repeat(24)));
  assert.deepStrictEqual(checkFile(notes, undefined).map((f) => [f.rule, f.line]), [['secrets-in-client-bundle', 1]]);
});

test('a code file named with U+2028, trailing whitespace or an upper-case extension still runs the code rules', () => {
  const src = L('async function f(pool, x) {', '  return pool.query(`SELECT ${x}`);', '}');
  for (const p of ['server/bs/u\u2028v.js', 'server/trail.js ', 'server/UP.JS', 'server/x.Ts']) {
    assert.deepStrictEqual(lines(run(p, src), 'parameterized-sql'), [2], JSON.stringify(p));
  }
  // No blob: the same names fail closed as code, never a rebuild from the added lines.
  for (const p of ['server/trail.js ', 'server/UP.JS']) {
    assert.deepStrictEqual(checkFile(changed(p, src), undefined).map((f) => [f.rule, f.blocking]), [['scan', true]], JSON.stringify(p));
  }
});

test('a JSON or CSS file is never tokenized as JS', () => {
  assert.deepStrictEqual(run('client/src/a.css', L('.a { content: "\'"; }')), []);
  assert.deepStrictEqual(run('client/src/a.json', L('{ "a": "it\'s" }')), []);
});

// ---- the allow marker (ruling 5) ----------------------------------------------

function verdicts(findings, rule) {
  return findings.filter((f) => f.rule === rule).map((f) => [f.line, f.blocking, Boolean(f.allowed)]);
}

test('allow marker: a comment on the same line or on a comment-only line directly above downgrades an idiom rule', () => {
  const src = L(
    "const { pool } = require('../db');",
    'async function f(cols, where) {',
    '  await pool.query(`SELECT ${cols} FROM t`); // static-checks: allow parameterized-sql (column list)',
    '  // static-checks: allow parameterized-sql (built where clause)',
    '  return pool.query(`SELECT a FROM t WHERE ${where}`);',
    '}',
  );
  assert.deepStrictEqual(verdicts(run('server/utils/sqlok.js', src), 'parameterized-sql'), [[3, false, true], [5, false, true]]);
});

test('allow marker: one inside the swallowed catch body, and one above a BEGIN, downgrade those rules', () => {
  const src = L(
    'async function f(client, fn) {',
    '  try {',
    '    fn();',
    '  } catch {',
    '    // static-checks: allow swallowed-catch (best-effort cleanup)',
    '  }',
    '  /* static-checks: allow begin-without-rollback (read-only snapshot) */',
    "  await client.query('BEGIN');",
    '}',
  );
  const got = run('server/utils/okidioms.js', src);
  assert.deepStrictEqual(verdicts(got, 'swallowed-catch'), [[4, false, true]]);
  assert.deepStrictEqual(verdicts(got, 'begin-without-rollback'), [[8, false, true]]);
});

test('allow marker: inside a string, inside SQL text, or trailing a code line above does nothing', () => {
  const src = L(
    "const { pool } = require('../db');",
    'async function f(x, fn) {',
    "  await pool.query(`SELECT ${x}`, ['static-checks: allow parameterized-sql']);",
    '  await pool.query(`SELECT /* static-checks: allow parameterized-sql */ ${x}`);',
    '  fn(); // static-checks: allow swallowed-catch',
    '  try { fn(); } catch {}',
    '}',
  );
  const got = run('server/utils/notok.js', src);
  assert.deepStrictEqual(verdicts(got, 'parameterized-sql'), [[3, true, false], [4, true, false]]);
  assert.deepStrictEqual(verdicts(got, 'swallowed-catch'), [[6, true, false]]);
});

test('allow marker: a comment two lines above does nothing', () => {
  const src = L(
    'function f(fn) {',
    '  // static-checks: allow swallowed-catch',
    '  const n = 1;',
    '  try { fn(); } catch {}',
    '  return n;',
    '}',
  );
  assert.deepStrictEqual(verdicts(run('server/utils/far.js', src), 'swallowed-catch'), [[4, true, false]]);
});

test('allow marker: never for the secret rules or dangerouslySetInnerHTML', () => {
  const src = L(
    "const jwt = require('jsonwebtoken');",
    'function mint(id) {',
    "  return jwt.sign({ id }, 'k'); // static-checks: allow jwt-literal-secret",
    '}',
    "const s = process.env.HOOK_SECRET || 'x'; // static-checks: allow secret-default",
    '// static-checks: allow dangerously-set-inner-html',
    'const el = <div dangerouslySetInnerHTML={{ __html: s }} />;',
    'module.exports = { mint, el };',
  );
  const got = run('server/utils/never.js', src);
  assert.deepStrictEqual(verdicts(got, 'jwt-literal-secret'), [[3, true, false]]);
  assert.deepStrictEqual(verdicts(got, 'secret-default'), [[5, true, false]]);
  assert.deepStrictEqual(verdicts(got, 'dangerously-set-inner-html'), [[7, true, false]]);
});

test('allow marker: an allowed hit never hides an un-allowed hit of the same rule on the same line', () => {
  const src = L(
    'async function f(pool, req) {',
    '  const rows = await pool.query( // static-checks: allow parameterized-sql',
    "    `SELECT a FROM t WHERE id IN (${pool.query(`SELECT id FROM u WHERE name = '${req.query.name}'`)})`);",
    '  return rows;',
    '}',
  );
  const got = run('server/utils/twoOnALine.js', src);
  assert.deepStrictEqual(verdicts(got, 'parameterized-sql'), [[3, true, false]]);
  assert.strictEqual(got.filter((f) => f.blocking).length, 1);
});

test('allow marker: a "//" key in package.json does nothing', () => {
  const pkg = L('{', '  "name": "fixture",', '  "dependencies": {', '    "//": "static-checks: allow file-or-git-deps",', '    "lib": "file:../lib"', '  }', '}');
  assert.deepStrictEqual(verdicts(run('package.json', pkg), 'file-or-git-deps'), [[5, true, false]]);
});

// ---- secret-default and env-default (ruling 6) -----------------------------------

test('secret-default blocks a literal at the end of a chain of any length, bracket access and an empty literal included', () => {
  const src = L(
    "const a = process.env.PRIMARY_TOKEN || process.env.FALLBACK_URL || 'dev-token';",
    "const b = process.env['SIGNING_SECRET'] || 'x';",
    "const c = process.env.DB_PASSWORD ?? 'pw';",
    "const d = process.env.OPTIONAL_SECRET || '';",
    "const e = process.env.STRIPE_SECRET_KEY_TEST || 'k';",
    "const f = String(process.env.HOOK_SECRET || '').trim();",
    'module.exports = { a, b, c, d, e, f };',
  );
  const got = run('server/utils/defaults.js', src);
  assert.deepStrictEqual(verdicts(got, 'secret-default'), [1, 2, 3, 4, 5, 6].map((n) => [n, true, false]));
  assert.deepStrictEqual(verdicts(got, 'env-default'), []);
});

test('secret-default blocks a ternary literal arm and a destructuring default from process.env', () => {
  const src = L(
    "const isProd = process.env.NODE_ENV === 'production';",
    "const k = isProd ? process.env.API_KEY : 'dev-key';",
    "const { SESSION_SECRET = 'dev', PORT = 5000 } = process.env;",
    "const m = process.env.API_KEY ? 'set' : 'unset';",
    'module.exports = { k, SESSION_SECRET, PORT, m };',
  );
  const got = run('server/utils/ternary.js', src);
  assert.deepStrictEqual(verdicts(got, 'secret-default'), [[2, true, false], [3, true, false]]);
  assert.deepStrictEqual(verdicts(got, 'env-default'), [[3, false, false]]);
});

test('secret-default reads a chain split over three lines as one, when only the fallback line was added', () => {
  const src = L('const pw =', '  process.env.DB_PASSWORD', "  || 'hunter2';", 'module.exports = { pw };');
  const got = run('server/utils/split.js', src, { status: 'M', addedLines: [3] });
  assert.deepStrictEqual(verdicts(got, 'secret-default'), [[3, true, false]]);
  const readOnly = run('server/utils/split.js', src, { status: 'M', addedLines: [2] });
  assert.deepStrictEqual(verdicts(readOnly, 'secret-default'), [[3, true, false]], 'touching the env read line counts too');
  const neither = run('server/utils/split.js', src, { status: 'M', addedLines: [4] });
  assert.deepStrictEqual(verdicts(neither, 'secret-default'), []);
});

test('secret-default reads through grouping parens, never through a call', () => {
  const src = L(
    "const a = (process.env.X_SECRET ?? process.env.Y_SECRET) || 'z';",
    "const b = ((process.env.API_TOKEN)) ?? 'tok';",
    "const c = String(process.env.HOOK_SECRET) || 'not-the-secret';",
    "const d = wrap(process.env.HOOK_SECRET ?? process.env.OTHER) || 'x';",
    'module.exports = { a, b, c, d };',
  );
  const got = run('server/utils/groups.js', src);
  assert.deepStrictEqual(verdicts(got, 'secret-default'), [[1, true, false], [2, true, false]]);
});

test('secret-default exempts null and undefined fallbacks; a named constant fallback is advisory env-default', () => {
  const src = L(
    "const DEFAULT_HOOK_SECRET = ['d', 'ev'].join('');",
    'const a = process.env.NULL_SECRET || null;',
    'const b = process.env.UNDEF_SECRET ?? undefined;',
    'const c = process.env.HOOK_SECRET || DEFAULT_HOOK_SECRET;',
    'const d = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;',
    'module.exports = { a, b, c, d };',
  );
  const got = run('server/utils/exempt.js', src);
  assert.deepStrictEqual(verdicts(got, 'secret-default'), []);
  assert.deepStrictEqual(verdicts(got, 'env-default'), [[2, false, false], [4, false, false]]);
});

test('secret-default unwraps grouping parens, reads ||= and ??=, a template or concatenation fallback, a literal mid-chain and an env alias', () => {
  const src = L(
    "const a = process.env.JWT_SECRET || ('fallback');",
    "const b = isProd ? process.env.API_KEY : ('dev-key');",
    "process.env.HOOK_SECRET ||= 'dev';",
    "process.env.SIGNING_TOKEN ??= 'dev';",
    'const c = process.env.SESSION_SECRET || `dev-${Date.now()}`;',
    "const d = process.env.DB_PASSWORD || 'pw-' + os.hostname();",
    "const e = process.env.API_TOKEN || 'mid' || process.env.OTHER;",
    'const { env } = process;',
    "const f = env.CRON_SECRET || 'x';",
    'const penv = process.env;',
    "const g = penv['VAPID_PRIVATE'] ?? 'x';",
    "const { WEBHOOK_SECRET = 'w' } = env;",
    "const h = process.env.SECRET || 'x';",
    "const i = process.env.APIKEY || 'x';",
    "const j = process.env.PRIVATE || 'x';",
    "const k = process.env.MAILSECRETS || 'x';",
    'module.exports = { a, b, c, d, e, f, g, h, i, j, k, WEBHOOK_SECRET };',
  );
  const got = run('server/utils/wider.js', src);
  assert.deepStrictEqual(verdicts(got, 'secret-default'), [1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 13, 14, 15, 16].map((n) => [n, true, false]));
  assert.deepStrictEqual(verdicts(got, 'env-default'), []);
});

test('env-default stays advisory for a non-secret literal fallback, and nothing fires on a read in a string', () => {
  const src = L(
    'const port = process.env.PORT || 5000;',
    'const url = process.env.CLIENT_URL',
    "  || 'http://localhost:3000';",
    "const note = 'process.env.JWT_SECRET || x';",
    'module.exports = { port, url, note };',
  );
  const got = run('server/utils/plain.js', src);
  assert.deepStrictEqual(verdicts(got, 'env-default'), [[1, false, false], [3, false, false]]);
  assert.deepStrictEqual(verdicts(got, 'secret-default'), []);
});

// ---- package.json (ruling 7) -----------------------------------------------------

const json = (o) => JSON.stringify(o, null, 2) + '\n';

test('file-or-git-deps reads the dependency sections and overrides only, never repository, and knows every non-registry form', () => {
  const pkg = json({
    name: 'fixture',
    repository: { type: 'git', url: 'git+https://example.test/r.git' },
    scripts: { fetch: 'git+https://example.test/not-a-dep' },
    dependencies: {
      a: 'file:../a', b: 'link:../b', c: 'git+https://example.test/c.git', d: 'git://example.test/d.git',
      e: 'git@example.test:o/e.git', f: 'github:o/f', g: 'gitlab:o/g', h: 'bitbucket:o/h',
      i: 'http://example.test/i.tgz', j: 'https://example.test/j.tgz', k: 'o/k', pinned: '1.2.3', ranged: '^1.2.3',
    },
    devDependencies: { l: 'o/l#main' },
    optionalDependencies: { m: 'file:m' },
    peerDependencies: { n: 'github:o/n' },
    overrides: { o: 'file:../o', p: { q: 'github:o/q' } },
  });
  const want = 'abcdefghijklmnoq'.split('').map((k) => lineOf(pkg, `"${k}": `));
  assert.deepStrictEqual(verdicts(run('package.json', pkg), 'file-or-git-deps'), want.map((n) => [n, true, false]));
});

test('floating-security-versions catches every range that is not an exact version, and npm: aliases, for the listed packages', () => {
  const pkg = json({
    dependencies: {
      express: '*', helmet: 'latest', pg: '>=8.0.0', stripe: '14.x', bcryptjs: '2',
      jsonwebtoken: '9.0.0 - 9.1.0', 'jwt-alias': 'npm:jsonwebtoken@^9.0.0', cors: '^2.8.5', 'cors-alias': 'npm:cors@^2.8.5',
    },
    devDependencies: { express: '4.22.2' },
    overrides: { pg: '~8.11.0' },
  });
  const want = ['"express": "*"', '"helmet"', '"pg": ">=', '"stripe"', '"bcryptjs"', '"jsonwebtoken"', '"jwt-alias"', '"pg": "~'].map((k) => lineOf(pkg, k));
  assert.deepStrictEqual(verdicts(run('client/package.json', pkg), 'floating-security-versions'), want.map((n) => [n, true, false]));
});

test('a package.json that is not JSON fails closed with a scan finding', () => {
  const got = run('package.json', L('{', '  "dependencies": {', '    "express": "4.22.2",', '}'));
  assert.deepStrictEqual(got.map((f) => [f.rule, f.blocking]), [['scan', true]]);
});

// ---- the call rules (ruling 8) --------------------------------------------------

test('command-injection fires on .exec( and .execSync( whatever the receiver; a RegExp exec on a plain value stays quiet', () => {
  const src = L(
    "const childProc = require('child_process');",
    'function f(dir, line, re, x) {',
    '  childProc.exec(`ls ${dir}`);',
    "  require('child_process').execSync('cat ' + dir);",
    '  x.y.exec(`rm ${dir}`);',
    '  execSync(`git ${dir}`);',
    '  re.exec(line);',
    '  /x/.exec(line);',
    '  return re.exec(String(line));',
    '}',
  );
  assert.deepStrictEqual(lines(run('server/utils/shells.js', src), 'command-injection'), [3, 4, 5, 6]);
});

test('ssrf covers https.request, https.get, http.get and http.request with a URL from req', () => {
  const src = L(
    "const https = require('https');",
    "const http = require('http');",
    'function relay(req) {',
    '  https.request(req.query.url);',
    '  https.get(req.body.u);',
    '  http.get(req.params.u);',
    '  http.request(req.query.v);',
    "  https.get('https://example.test/x');",
    '}',
    'module.exports = { relay };',
  );
  assert.deepStrictEqual(lines(run('server/utils/relay.js', src), 'ssrf'), [4, 5, 6, 7]);
});

test('jwt-literal-secret covers jwt.sign, jsonwebtoken.sign, and a bare sign destructured from jsonwebtoken (aliased too)', () => {
  const src = L(
    "const { sign, sign: mintToken } = require('jsonwebtoken');",
    "const jsonwebtoken = require('jsonwebtoken');",
    'function mint(id) {',
    "  const a = sign({ id }, 'k1');",
    "  const b = jsonwebtoken.sign({ id }, 'k2');",
    "  const c = mintToken({ id }, 'k3');",
    '  const d = sign({ id }, process.env.JWT_SECRET);',
    '  return [a, b, c, d];',
    '}',
  );
  assert.deepStrictEqual(lines(run('server/utils/mint.js', src), 'jwt-literal-secret'), [4, 5, 6]);
});

test('jwt-literal-secret leaves a bare sign alone when the file does not take it from jsonwebtoken', () => {
  const src = L("const { sign } = require('./signer');", "const s = sign({ id: 1 }, 'not-a-jwt');", 'module.exports = { s };');
  assert.deepStrictEqual(lines(run('server/utils/othersign.js', src), 'jwt-literal-secret'), []);
});

test('stripe-direct reads tokens across lines: any quote, a subpath, import, import() and createRequire; never a comment, a string or another package', () => {
  const src = L(
    'const a = require(',
    "  'stripe'",
    ');',
    'const b = require("stripe");',
    'const c = require(`stripe`);',
    "const d = require('stripe/lib/stripe');",
    "import e from 'stripe';",
    "const f = import('stripe');",
    "const g = createRequire(__filename)('stripe');",
    "// require('stripe') in a comment",
    'const note = "require(\'stripe\')";',
    "const k = require('stripe-mock');",
    "const m = require.resolve('stripe');",
    'module.exports = { a, b, c, d, e, f, g, note, k, m };',
  );
  assert.deepStrictEqual(lines(run('server/utils/pay.js', src), 'stripe-direct'), [1, 4, 5, 6, 7, 8, 9]);
  assert.deepStrictEqual(lines(run('server/utils/pay.js', src, { status: 'M', addedLines: [2] }), 'stripe-direct'), [1], 'touching the string line counts');
  assert.deepStrictEqual(lines(run('server/utils/stripeClient.js', src), 'stripe-direct'), []);
});

test('jwt-literal-secret covers verify, destructured and aliased verify and sign, a member destructure, a require receiver and a split call', () => {
  const src = L(
    "const jwt = require('jsonwebtoken');",
    "const { verify, verify: check } = require('jsonwebtoken');",
    "import { sign as mint } from 'jsonwebtoken';",
    'const { sign: s2 } = jwt;',
    'function f(t, p) {',
    "  const a = jwt.verify(t, 'k1');",
    "  const b = verify(t, 'k2');",
    "  const c = check(t, 'k3');",
    "  const d = mint(p, 'k4');",
    '  const e = jwt.sign(',
    '    p,',
    "    'k5',",
    '  );',
    "  const g = require('jsonwebtoken').verify(t, 'k6');",
    "  const h = s2(p, 'k7');",
    '  const i = jwt.verify(t, process.env.JWT_SECRET);',
    '  return [a, b, c, d, e, g, h, i];',
    '}',
  );
  assert.deepStrictEqual(lines(run('server/utils/verify.js', src), 'jwt-literal-secret'), [6, 7, 8, 9, 12, 14, 15]);
  assert.deepStrictEqual(lines(run('server/utils/verify.js', src, { status: 'M', addedLines: [10] }), 'jwt-literal-secret'), [12], 'touching the call line counts');
});

test('command-injection reads a call split over lines, and the ?. forms; a regex-literal receiver stays quiet', () => {
  const src = L(
    "const cp = require('child_process');",
    "const { exec } = require('child_process');",
    'function f(dir) {',
    '  cp.exec(',
    '    `ls ${dir}`,',
    '  );',
    "  cp?.exec('ls ' + dir);",
    '  cp.exec?.(`ls ${dir}`);',
    '  exec?.(`ls ${dir}`);',
    "  cp?.execSync?.('ls ' + dir);",
    '  /x/?.exec(`${dir}`);',
    '}',
  );
  assert.deepStrictEqual(lines(run('server/utils/shell2.js', src), 'command-injection'), [5, 7, 8, 9, 10]);
  assert.deepStrictEqual(lines(run('server/utils/shell2.js', src, { status: 'M', addedLines: [4] }), 'command-injection'), [5], 'touching the call line counts');
});

test('every member-call matcher reads ?. as .: ssrf, parameterized-sql, stripe-direct, jwt-literal-secret, the ROLLBACK guard and a process?.env destructure', () => {
  const src = L(
    "const axios = require('axios');",
    "const http = require('http');",
    "const jwt = require('jsonwebtoken');",
    'async function relay(req, pool, client) {',
    '  axios?.get(req.query.url);',
    '  axios.get?.(req.query.url);',
    '  http?.request(req.body.u);',
    '  fetch?.(req.query.url);',
    '  axios?.(req.query.url);',
    '  pool?.query(`SELECT ${req.query.id}`);',
    '  pool.query?.(`SELECT ${req.query.id}`);',
    "  const s = require?.('stripe');",
    "  const t = jwt?.sign({}, 'k1');",
    "  const u = jwt.verify?.(t, 'k2');",
    '  try {',
    '    return [s, t, u];',
    '  } catch (err) {',
    "    try { await client?.query('ROLLBACK'); } catch { /* already rolled back */ }",
    '    throw err;',
    '  }',
    '}',
    "const { HOOK_SECRET = 'x' } = process?.env;",
    'module.exports = { relay, HOOK_SECRET };',
  );
  const got = run('server/utils/optional.js', src);
  assert.deepStrictEqual(lines(got, 'ssrf'), [5, 6, 7, 8, 9]);
  assert.deepStrictEqual(lines(got, 'parameterized-sql'), [10, 11]);
  assert.deepStrictEqual(lines(got, 'stripe-direct'), [12]);
  assert.deepStrictEqual(lines(got, 'jwt-literal-secret'), [13, 14]);
  assert.deepStrictEqual(lines(got, 'swallowed-catch'), []);
  assert.deepStrictEqual(lines(got, 'secret-default'), [22]);
});

test("parameterized-sql and command-injection accept a computed callee: pool['query'](, pool?.['query'](, cp['exec']?.(", () => {
  const src = L(
    "const cp = require('child_process');",
    'async function f(pool, id) {',
    "  await pool['query'](`SELECT ${id}`);",
    '  await pool?.["query"](`SELECT ${id}`);',
    "  await pool['query']?.('SELECT ' + id);",
    "  await pool['other'](`SELECT ${id}`);",
    "  cp['exec']?.(`ls ${id}`);",
    "  /x/['exec'](`${id}`);",
    '}',
  );
  const got = run('server/utils/computed.js', src);
  assert.deepStrictEqual(lines(got, 'parameterized-sql'), [3, 4, 5]);
  assert.deepStrictEqual(lines(got, 'command-injection'), [7]);
});

test('begin-without-rollback is case-insensitive, reads START TRANSACTION and a BEGIN alone on a template line, and a ROLLBACK in a comment does not count', () => {
  const src = L(
    'async function f(client) {',
    "  await client.query('begin');",
    "  await client.query('START TRANSACTION');",
    '  await client.query(`',
    '    BEGIN',
    '  `);',
    '  // on error we ROLLBACK',
    '}',
  );
  assert.deepStrictEqual(verdicts(run('server/utils/txs.js', src), 'begin-without-rollback'), [[2, true, false], [3, true, false], [5, true, false]]);
});

test('begin-without-rollback stays quiet when a string holds the ROLLBACK, and on an iCal BEGIN: line', () => {
  const src = L(
    'async function f(client) {',
    '  try {',
    "    await client.query('BEGIN');",
    "    return ['BEGIN:VCALENDAR'];",
    '  } catch (err) {',
    "    await client.query('rollback');",
    '    throw err;',
    '  }',
    '}',
  );
  assert.deepStrictEqual(lines(run('server/utils/txok.js', src), 'begin-without-rollback'), []);
});

test('begin-without-rollback leaves the BEGIN of a PL/pgSQL block alone (dollar-quoted, or after a DECLARE)', () => {
  const src = L(
    'async function f(client, wrap) {',
    '  await client.query(`DO $$',
    'BEGIN',
    '  PERFORM 1;',
    'END $$;`);',
    '  return wrap(`-- a block the caller wraps in DO $ $',
    'DECLARE',
    '  v_n numeric;',
    'BEGIN',
    '  PERFORM 2;',
    'END;`);',
    '}',
  );
  assert.deepStrictEqual(lines(run('server/utils/doblock.js', src), 'begin-without-rollback'), []);
});

test('swallowed-catch counts a body of only ; and one of only void e; as swallowed', () => {
  const src = L(
    'function f(fn) {',
    '  try { fn(); } catch { ; }',
    '  try { fn(); } catch (e) { void e; }',
    '  try { fn(); } catch (e) { void e; return 1; }',
    '}',
  );
  assert.deepStrictEqual(lines(run('server/utils/swallows.js', src), 'swallowed-catch'), [2, 3]);
});

// ---- finding text (ruling 10) -----------------------------------------------------

test('every finding on a line holding a secret-rule literal prints <LITERAL>, env-default included, so no rule prints the literal', () => {
  const src = L(
    "const { pool } = require('../db');",
    "const jwt = require('jsonwebtoken');",
    "const k = process.env.HOOK_SECRET || 'sesame', p = process.env.PORT || 5000; pool.query(`SELECT ${k}`); try { f(); } catch {}",
    "const t = jwt.sign({}, 'opensesame'); require('child_process').exec(`ls ${t}`);",
    'const s = process.env.DB_PASSWORD',
    "  || 'hunter2'; try { f(); } catch {}",
    'module.exports = { k, p, t, s };',
  );
  const got = run('server/utils/mixed.js', src);
  const on = (n) => got.filter((f) => f.line === n);
  assert.deepStrictEqual(on(3).map((f) => f.rule).sort(), ['env-default', 'parameterized-sql', 'secret-default', 'swallowed-catch']);
  assert.deepStrictEqual(on(4).map((f) => f.rule).sort(), ['command-injection', 'jwt-literal-secret']);
  assert.deepStrictEqual(on(6).map((f) => f.rule).sort(), ['secret-default', 'swallowed-catch']);
  for (const f of got) {
    for (const raw of ["'sesame'", '5000', 'opensesame', 'hunter2']) assert.ok(!f.text.includes(raw), `${f.rule} line ${f.line}: ${f.text}`);
  }
  assert.ok(on(3).every((f) => f.text === 'const k = process.env.HOOK_SECRET || <LITERAL>, p = process.env.PORT || <LITERAL>; pool.query(`SELECT ${k}`); try { f(); } catch {}'), JSON.stringify(on(3)));
});

test('a 54 KB line with 2,000 hits is masked once: checkFile finishes well under a second with one finding per rule and line', () => {
  const stmt = 'pool.query(`SELECT ${id}`);';
  assert.strictEqual(stmt.length * 2000, 54000);
  const src = L('async function f(pool, id) {', stmt.repeat(2000), '}');
  run('server/utils/warm.js', L('const a = 1;'));
  const t0 = process.hrtime.bigint();
  const got = run('server/utils/wide.js', src);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.deepStrictEqual(got.map((f) => [f.rule, f.line]), [['parameterized-sql', 2]]);
  assert.ok(ms < 1000, `checkFile took ${Math.round(ms)} ms`);
});

test('secret-default and jwt-literal-secret replace the quoted literal in the text with <LITERAL>', () => {
  const src = L(
    "const jwt = require('jsonwebtoken');",
    "const hook = process.env.HOOK_SECRET || 'changeme';",
    'const pw = process.env.DB_PASSWORD',
    "  || 'hunter2';",
    'function mint(id) {',
    "  return jwt.sign({ id }, 'sesame', { expiresIn: '1h' });",
    '}',
    'module.exports = { hook, pw, mint };',
  );
  const got = run('server/utils/literals.js', src);
  const text = (rule) => got.filter((f) => f.rule === rule).map((f) => f.text);
  assert.deepStrictEqual(text('secret-default'), ['const hook = process.env.HOOK_SECRET || <LITERAL>;', '|| <LITERAL>;']);
  assert.deepStrictEqual(text('jwt-literal-secret'), ["return jwt.sign({ id }, <LITERAL>, { expiresIn: '1h' });"]);
});

module.exports = { changed, L, lineOf };
