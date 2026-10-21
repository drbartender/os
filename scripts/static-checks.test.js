'use strict';

// node:test suite for scripts/static-checks.js.
//
// Every case runs in a throwaway git repo under the OS temp dir (the pattern of
// board-write.test.js), removed when the suite ends. Nothing here touches the
// real repo. Each repo that lints gets a copy of the real eslint.config.mjs and
// a node_modules link to the real install, so the eslint-undef rule runs
// through the repo's own config and binary, as it does in a lane.
//
// The values piiShapes treats as live keys are assembled at run time, so this
// file never carries one (a live key is never exempt, test paths included).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.resolve(__dirname, 'static-checks.js');
const REPO_ROOT = path.resolve(__dirname, '..');

const LIVE_SECRET = ['sk', 'live', 'Q'.repeat(24)].join('_');
const WEBHOOK_SECRET = ['whsec', 'W'.repeat(24)].join('_');
const HEX32 = 'ab'.repeat(16);

const roots = [];

function L(...lines) {
  return lines.join('\n') + '\n';
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' }).trim();
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === null) {
      fs.rmSync(abs, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

// Write, stage by explicit path (forced, so a tracked .env fixture can exist),
// commit, and return the new sha.
function commit(dir, files, msg) {
  writeFiles(dir, files);
  const paths = Object.keys(files);
  git(dir, ['add', '-f', '-A', '--', ...paths]);
  git(dir, ['commit', '-q', '--no-gpg-sign', '-m', msg]);
  return git(dir, ['rev-parse', 'HEAD']);
}

function makeRepo({ eslint = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-'));
  roots.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test User']);
  if (eslint) {
    fs.copyFileSync(path.join(REPO_ROOT, 'eslint.config.mjs'), path.join(dir, 'eslint.config.mjs'));
    fs.symlinkSync(fs.realpathSync(path.join(REPO_ROOT, 'node_modules')), path.join(dir, 'node_modules'));
  }
  return dir;
}

function run(dir, args, { env, script = SCRIPT } = {}) {
  const res = spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env });
  let json = null;
  try {
    json = JSON.parse(res.stdout);
  } catch {
    json = null;
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

function lineOf(text, needle) {
  const idx = text.split('\n').findIndex((l) => l.includes(needle));
  if (idx < 0) throw new Error(`fixture lacks ${needle}`);
  return idx + 1;
}

function hits(result, rule, file) {
  return result.json.findings.filter((f) => f.rule === rule && (file === undefined || f.file === file));
}

// ---- Fixtures ------------------------------------------------------------------

const SEED = {
  '.gitignore': L('node_modules', '.env', '.env.*', '!.env.example'),
  '.env.example': L('STRIPE_TEST_MODE_UNTIL=2026-12-01'),
  'client/.env.production': L('REACT_APP_API_URL=https://api.example.test'),
  'package.json': JSON.stringify({ name: 'fixture', dependencies: { express: '4.22.2', cors: '^2.8.5' } }, null, 2) + '\n',
  'client/package.json': JSON.stringify({ name: 'fixture-client', dependencies: { react: '^18.2.0' } }, null, 2) + '\n',
  'server/routes/legacyRoute.js': L(
    "'use strict';",
    "const express = require('express');",
    'const router = express.Router();',
    "router.get('/', async (req, res) => {",
    '  res.json([]);',
    '});',
    'module.exports = router;',
  ),
  'server/utils/esc.js': L("'use strict';", 'function esc(s) {', '  return String(s);', '}', 'module.exports = { esc };'),
  'server/utils/dropped.js': L(
    "'use strict';",
    "const { esc } = require('./esc');",
    '',
    'function render(s) {',
    '  return esc(s);',
    '}',
    '',
    'module.exports = { render };',
  ),
  // Lint debt that predates the change (a no-undef inside a function): a
  // touched file must not report it.
  'server/utils/legacy.js': L("'use strict';", 'function read() {', '  return missingThing;', '}', 'module.exports = { read };'),
};

const FIRE = {
  'server/utils/sqlFire.js': L(
    "'use strict';",
    "const { pool } = require('../db');",
    'async function byEmail(email) {',
    "  return pool.query(`SELECT id FROM users WHERE email = '${email}'`);",
    '}',
    'async function byId(id) {',
    "  return pool.query('SELECT id FROM users WHERE id = ' + id);",
    '}',
    'module.exports = { byEmail, byId };',
  ),
  'server/utils/shell.js': L(
    "'use strict';",
    "const { exec, execSync } = require('child_process');",
    'function list(dir) {',
    '  exec(`ls ${dir}`);',
    "  return execSync('cat ' + dir);",
    '}',
    'module.exports = { list };',
  ),
  'server/utils/proxy.js': L(
    "'use strict';",
    "const axios = require('axios');",
    'async function relay(req) {',
    '  const a = await fetch(req.query.url);',
    '  const b = await axios.get(req.body.target);',
    '  return [a, b];',
    '}',
    'module.exports = { relay };',
  ),
  'client/src/keys.js': L(
    `export const secret = '${LIVE_SECRET}';`,
    `export const hook = '${WEBHOOK_SECRET}';`,
    `export const hash = '${HEX32}';`,
  ),
  '.env': L('PORT=5000'),
  'client/.env.local': L('API_SECRET=placeholder'),
  'server/utils/pay.js': L("'use strict';", "const Stripe = require('stripe');", 'module.exports = { Stripe };'),
  'server/utils/testMode.js': L("'use strict';", "process.env.STRIPE_TEST_MODE_UNTIL = '2026-12-01';"),
  'server/utils/token.js': L(
    "'use strict';",
    "const jwt = require('jsonwebtoken');",
    'function mint(id) {',
    "  return jwt.sign({ id }, 'hunter2', { expiresIn: '1h' });",
    '}',
    'module.exports = { mint };',
  ),
  'server/utils/config.js': L(
    "'use strict';",
    "const webhookSecret = process.env.WEBHOOK_SECRET || 'dev-secret';",
    "const jwtSecret = process.env.JWT_SECRET || 'changeme';",
    `const apiKey = process.env.STRIPE_SECRET_KEY || '${LIVE_SECRET}';`,
    "const optional = process.env.OPTIONAL_SECRET || '';",
    'const port = process.env.PORT || 5000;',
    'module.exports = { webhookSecret, jwtSecret, apiKey, optional, port };',
  ),
  'server/routes/widgets.js': L(
    "'use strict';",
    "const express = require('express');",
    'const router = express.Router();',
    "router.get('/', async (req, res) => {",
    '  res.json([]);',
    '});',
    'module.exports = router;',
  ),
  'client/src/Post.js': L('export function Post({ html }) {', '  return <div dangerouslySetInnerHTML={{ __html: html }} />;', '}'),
  'server/utils/swallow.js': L(
    "'use strict';",
    'function a(fn) {',
    '  try {',
    '    fn();',
    '  } catch (e) {}',
    '}',
    'function b(fn) {',
    '  try {',
    '    fn();',
    '  } catch {',
    '    // nothing to do',
    '  }',
    '}',
    'function d(fn) {',
    '  try {',
    '    fn();',
    '  } catch {',
    '    // static-checks: allow swallowed-catch (best-effort cleanup)',
    '  }',
    '}',
    'function e(p) {',
    '  return p.catch(() => {});',
    '}',
    'module.exports = { a, b, d, e };',
  ),
  'server/utils/tx.js': L(
    "'use strict';",
    'async function save(client) {',
    "  await client.query('BEGIN');",
    "  await client.query('UPDATE t SET a = 1');",
    "  await client.query('COMMIT');",
    '}',
    'module.exports = { save };',
  ),
  'package.json': JSON.stringify({ name: 'fixture', dependencies: { express: '^4.22.2', cors: '^2.8.5', 'local-lib': 'file:../lib' } }, null, 2) + '\n',
  'client/package.json': JSON.stringify({ name: 'fixture-client', dependencies: { react: '^18.2.0', jsonwebtoken: '~9.0.3', forked: 'git+https://example.test/forked.git' } }, null, 2) + '\n',
  'server/utils/undef.js': L("'use strict';", 'const x = y;', 'module.exports = x;'),
  'scripts/tdz.js': L("'use strict';", 'const total = base + 1;', 'const base = 2;', 'module.exports = total;'),
  // The import is dropped; the reference that now throws is on an unchanged line.
  'server/utils/dropped.js': L("'use strict';", '', 'function render(s) {', '  return esc(s);', '}', '', 'module.exports = { render };'),
  'server/utils/contact.js': L("'use strict';", "const to = 'person@example.com';", 'module.exports = { to };'),
};

const QUIET = {
  'server/utils/sqlQuiet.js': L(
    "'use strict';",
    "const { pool } = require('../db');",
    "const BASE_SELECT = 'SELECT id FROM users';",
    'async function byEmail(email) {',
    "  return pool.query('SELECT id FROM users WHERE email = $1', [email]);",
    '}',
    'async function byIds(ids) {',
    '  return pool.query(`${BASE_SELECT} WHERE id = ANY($1)`, [ids]);',
    '}',
    'async function setAt(n, params) {',
    '  return pool.query(`UPDATE t SET a = $${n} WHERE id = $1`, params);',
    '}',
    'module.exports = { byEmail, byIds, setAt };',
  ),
  'server/utils/shellQuiet.js': L(
    "'use strict';",
    "const { execFileSync } = require('child_process');",
    'function list(dir, line, suffix) {',
    "  execFileSync('ls', [dir]);",
    '  const m = /x/.exec(`${dir}`);',
    '  const n = /y/.exec(line + suffix);',
    '  return [m, n];',
    '}',
    'module.exports = { list };',
  ),
  'server/utils/proxyQuiet.js': L(
    "'use strict';",
    "const axios = require('axios');",
    "const API_BASE = 'https://api.example.test';",
    'async function status() {',
    '  const a = await fetch(`${API_BASE}/status`);',
    '  const b = await axios.get(API_BASE);',
    '  return [a, b];',
    '}',
    'module.exports = { status };',
  ),
  'client/src/pay.js': L('export const key = process.env.REACT_APP_STRIPE_PUBLISHABLE_KEY;'),
  'tools/.env.example': L('TOOL_TOKEN='),
  'server/utils/stripeClient.js': L("'use strict';", "const Stripe = require('stripe');", 'module.exports = { Stripe };'),
  'server/utils/charge.js': L(
    "'use strict';",
    "const { Stripe } = require('./stripeClient');",
    'const until = process.env.STRIPE_TEST_MODE_UNTIL;',
    'module.exports = { Stripe, until };',
  ),
  '.env.example': L('STRIPE_TEST_MODE_UNTIL=2027-01-01'),
  'server/utils/tokenQuiet.js': L(
    "'use strict';",
    "const jwt = require('jsonwebtoken');",
    'function mint(id) {',
    "  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });",
    '}',
    'const unsub = process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET;',
    'const port = Number(process.env.PORT);',
    'module.exports = { mint, unsub, port };',
  ),
  'server/routes/gadgets.js': L(
    "'use strict';",
    "const express = require('express');",
    "const { auth } = require('../middleware/auth');",
    'const router = express.Router();',
    "router.get('/', auth, async (req, res) => {",
    '  res.json([]);',
    '});',
    'module.exports = router;',
  ),
  // An existing route without auth, edited: not a new file, so no advisory.
  'server/routes/legacyRoute.js': L(
    "'use strict';",
    "const express = require('express');",
    'const router = express.Router();',
    "router.get('/', async (req, res) => {",
    '  res.json([1]);',
    '});',
    'module.exports = router;',
  ),
  'client/src/Note.js': L('export function Note({ text }) {', '  return <div>{text}</div>;', '}'),
  // An iCal line is not SQL; a service worker's fetch is not server-side; a
  // vendored design export under docs/ is not production code.
  'server/utils/ical.js': L("'use strict';", 'function head() {', "  return ['BEGIN:VCALENDAR', 'VERSION:2.0'];", '}', 'module.exports = { head };'),
  // Patterns named in comments, strings and regex literals are not code.
  'server/utils/mentions.js': L(
    "'use strict';",
    '// A service worker calls fetch(req.url); a query(`SELECT ${x}`) is unsafe;',
    '/* never write catch (e) {} or process.env.PORT || 5000 */',
    "const NOTE = 'see dangerouslySetInnerHTML and exec(`ls ${dir}`)';",
    'const RE = /dangerouslySetInnerHTML|jwt.sign(x, "k")/;',
    'module.exports = { NOTE, RE };',
  ),
  'client/public/sw.js': L("self.addEventListener('fetch', (event) => {", '  const req = event.request;', '  event.respondWith(fetch(req.url));', '});'),
  'docs/design-artifacts/export.js': L('function boot(run) {', '  try {', '    run();', '  } catch (e) {}', '}'),
  'server/utils/handled.js': L(
    "'use strict';",
    'function a(fn) {',
    '  try {',
    '    fn();',
    '  } catch (err) {',
    '    console.error(err);',
    '    throw err;',
    '  }',
    '}',
    'module.exports = { a };',
  ),
  'server/utils/txQuiet.js': L(
    "'use strict';",
    'async function save(client) {',
    '  try {',
    "    await client.query('BEGIN');",
    "    await client.query('COMMIT');",
    '  } catch (err) {',
    "    try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }",
    '    throw err;',
    '  }',
    '}',
    'module.exports = { save };',
  ),
  'package.json': JSON.stringify({ name: 'fixture', dependencies: { express: '4.22.2', cors: '^2.8.6', helmet: '8.1.0' } }, null, 2) + '\n',
  'client/package.json': JSON.stringify({ name: 'fixture-client', dependencies: { react: '^18.3.1' } }, null, 2) + '\n',
  'server/utils/legacy.js': L(
    "'use strict';",
    'function read() {',
    '  return missingThing;',
    '}',
    'const extra = 2;',
    'module.exports = { read, extra };',
  ),
  // A module constant read inside a function declared above it: the read runs
  // after the module loads, so it cannot throw (the piiShapes.test.js shape).
  'scripts/later.js': L("'use strict';", 'function limit() {', '  return LIMIT;', '}', 'const LIMIT = 5;', 'module.exports = { limit };'),
  'scripts/tool.js': L(
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    'main();',
    'function main() {',
    "  fs.existsSync(path.join(__dirname, 'x'));",
    '  process.exitCode = 0;',
    '}',
  ),
  'server/utils/contact.js': L("'use strict';", 'const from = process.env.ADMIN_EMAIL;', 'module.exports = { from };'),
  'server/utils/contact.test.js': L("'use strict';", "const assert = require('node:assert');", "assert.ok('person@example.com');"),
};

// ---- Runs (built once, read by the per-rule tests) -----------------------------

let fire;
let quiet;
let fireRepo;

before(() => {
  fireRepo = makeRepo();
  const seed = commit(fireRepo, SEED, 'seed');
  const fireSha = commit(fireRepo, FIRE, 'fire');
  git(fireRepo, ['checkout', '-q', '-b', 'quiet', seed]);
  const quietSha = commit(fireRepo, QUIET, 'quiet');
  fire = run(fireRepo, ['--base', seed, '--tip', fireSha]);
  quiet = run(fireRepo, ['--base', seed, '--tip', quietSha]);
});

after(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

// ---- Shape of the output -------------------------------------------------------

test('fire run: exit 1, JSON findings, blocking counts the blocking findings', () => {
  assert.strictEqual(fire.status, 1, fire.stderr);
  assert.ok(fire.json, `stdout is JSON; stderr: ${fire.stderr.slice(0, 2000)}`);
  assert.ok(Array.isArray(fire.json.findings));
  for (const f of fire.json.findings) {
    for (const k of ['rule', 'file', 'line', 'text', 'blocking']) assert.ok(k in f, `finding has ${k}`);
  }
  assert.strictEqual(fire.json.blocking, fire.json.findings.filter((f) => f.blocking).length);
  assert.ok(fire.json.eslint_files > 0, 'eslint ran over the changed server and scripts files');
  assert.strictEqual(fire.json.allowed, 1, 'a top-level count of the findings an allow marker downgraded');
  assert.strictEqual(quiet.json.allowed, 0);
});

test('quiet run: exit 0, no findings at all, blocking 0 (patterns named in comments, strings and regex literals included)', () => {
  assert.strictEqual(quiet.status, 0, quiet.stderr);
  assert.deepStrictEqual(quiet.json.findings, []);
  assert.strictEqual(quiet.json.blocking, 0);
});

// ---- One fixture per rule that fires, one that stays quiet ----------------------

test('parameterized-sql fires on an interpolated and a concatenated query', () => {
  const f = FIRE['server/utils/sqlFire.js'];
  const got = hits(fire, 'parameterized-sql', 'server/utils/sqlFire.js').map((h) => h.line);
  assert.deepStrictEqual(got, [lineOf(f, "email = '${email}'"), lineOf(f, "' + id")]);
  assert.ok(hits(fire, 'parameterized-sql').every((h) => h.blocking));
});

test('parameterized-sql stays quiet on $1 params, a constant fragment and a $${n} placeholder', () => {
  assert.deepStrictEqual(hits(quiet, 'parameterized-sql'), []);
});

test('command-injection fires on exec with a template and execSync with concatenation', () => {
  const f = FIRE['server/utils/shell.js'];
  const got = hits(fire, 'command-injection', 'server/utils/shell.js').map((h) => h.line);
  assert.deepStrictEqual(got, [lineOf(f, 'exec(`ls'), lineOf(f, 'execSync(')]);
});

test('command-injection stays quiet on execFileSync with an argv and RegExp exec', () => {
  assert.deepStrictEqual(hits(quiet, 'command-injection'), []);
});

test('ssrf fires on fetch and axios.get with a URL from req', () => {
  const f = FIRE['server/utils/proxy.js'];
  const got = hits(fire, 'ssrf', 'server/utils/proxy.js').map((h) => h.line);
  assert.deepStrictEqual(got, [lineOf(f, 'fetch(req'), lineOf(f, 'axios.get(req')]);
});

test('ssrf stays quiet on a constant URL and on client-side code', () => {
  assert.deepStrictEqual(hits(quiet, 'ssrf'), []);
});

test('secrets-in-client-bundle fires on a live key, a webhook secret and a 32-hex literal, masked', () => {
  const got = hits(fire, 'secrets-in-client-bundle', 'client/src/keys.js');
  assert.deepStrictEqual(got.map((h) => h.line), [1, 2, 3]);
  for (const h of got) {
    assert.ok(h.blocking);
    assert.ok(h.text.includes('<TOKEN>'), h.text);
    for (const raw of [LIVE_SECRET, WEBHOOK_SECRET, HEX32]) assert.ok(!h.text.includes(raw), 'text never carries the raw value');
  }
});

test('secrets-in-client-bundle stays quiet on an env read', () => {
  assert.deepStrictEqual(hits(quiet, 'secrets-in-client-bundle'), []);
});

test('env-ignored fires on a tracked .env and a tracked client env file with a server key', () => {
  const files = hits(fire, 'env-ignored').map((h) => h.file).sort();
  assert.deepStrictEqual(files, ['.env', 'client/.env.local']);
  assert.ok(hits(fire, 'env-ignored').every((h) => h.blocking));
});

test('env-ignored stays quiet on .env.example files and client/.env.production with REACT_APP_ keys only', () => {
  assert.deepStrictEqual(hits(quiet, 'env-ignored'), []);
});

test('stripe-direct fires on require of stripe outside stripeClient.js', () => {
  const got = hits(fire, 'stripe-direct');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line]), [['server/utils/pay.js', 2]]);
});

test('stripe-direct stays quiet inside stripeClient.js', () => {
  assert.deepStrictEqual(hits(quiet, 'stripe-direct'), []);
});

test('stripe-test-mode-until fires advisory on a literal date outside .env.example', () => {
  const got = hits(fire, 'stripe-test-mode-until');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line, h.blocking]), [['server/utils/testMode.js', 2, false]]);
});

test('stripe-test-mode-until stays quiet in .env.example and on an env read', () => {
  assert.deepStrictEqual(hits(quiet, 'stripe-test-mode-until'), []);
});

test('jwt-literal-secret fires on jwt.sign with a string secret', () => {
  const f = FIRE['server/utils/token.js'];
  const got = hits(fire, 'jwt-literal-secret');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line]), [['server/utils/token.js', lineOf(f, 'jwt.sign(')]]);
});

test('jwt-literal-secret stays quiet on jwt.sign with an env secret', () => {
  assert.deepStrictEqual(hits(quiet, 'jwt-literal-secret'), []);
});

test('secret-default fires blocking on a literal fallback for a _SECRET, _KEY or JWT_SECRET, an empty one included, masked', () => {
  const f = FIRE['server/utils/config.js'];
  const got = hits(fire, 'secret-default', 'server/utils/config.js');
  assert.deepStrictEqual(got.map((h) => h.line), [lineOf(f, 'WEBHOOK_SECRET'), lineOf(f, 'JWT_SECRET'), lineOf(f, 'STRIPE_SECRET_KEY'), lineOf(f, 'OPTIONAL_SECRET')]);
  assert.ok(got.every((h) => h.blocking));
  assert.ok(!got[2].text.includes(LIVE_SECRET) && got[2].text.includes('<LITERAL>'), got[2].text);
});

test('secret-default stays quiet on a fallback to another env var', () => {
  assert.deepStrictEqual(hits(quiet, 'secret-default'), []);
});

test('env-default fires advisory on any other literal fallback', () => {
  const f = FIRE['server/utils/config.js'];
  const got = hits(fire, 'env-default', 'server/utils/config.js');
  assert.deepStrictEqual(got.map((h) => [h.line, h.blocking]), [[lineOf(f, 'PORT'), false]]);
});

test('env-default stays quiet on a bare env read', () => {
  assert.deepStrictEqual(hits(quiet, 'env-default'), []);
});

test('missing-auth-import fires advisory on a new route file with handlers and no auth import', () => {
  const f = FIRE['server/routes/widgets.js'];
  const got = hits(fire, 'missing-auth-import');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line, h.blocking]), [['server/routes/widgets.js', lineOf(f, 'router.get('), false]]);
});

test('missing-auth-import stays quiet on a new route with auth and an edited existing route', () => {
  assert.deepStrictEqual(hits(quiet, 'missing-auth-import'), []);
});

test('dangerously-set-inner-html fires', () => {
  const got = hits(fire, 'dangerously-set-inner-html');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line, h.blocking]), [['client/src/Post.js', 2, true]]);
});

test('dangerously-set-inner-html stays quiet on plain JSX', () => {
  assert.deepStrictEqual(hits(quiet, 'dangerously-set-inner-html'), []);
});

test('swallowed-catch fires on an empty and a comment-only catch; an allow marker downgrades it; a promise .catch is out of scope', () => {
  const f = FIRE['server/utils/swallow.js'];
  const got = hits(fire, 'swallowed-catch', 'server/utils/swallow.js');
  const catchLines = f.split('\n').map((l, i) => (/^\s*\} catch\b/.test(l) ? i + 1 : 0)).filter(Boolean);
  assert.strictEqual(catchLines.length, 3);
  assert.deepStrictEqual(got.map((h) => h.line), catchLines);
  assert.deepStrictEqual(got.map((h) => h.blocking), [true, true, false]);
  assert.strictEqual(got[2].allowed, true);
});

test('swallowed-catch stays quiet on a catch that handles the error, a failed-ROLLBACK swallow, and under docs/', () => {
  assert.deepStrictEqual(hits(quiet, 'swallowed-catch'), []);
});

test('begin-without-rollback fires on a file adding BEGIN with no ROLLBACK', () => {
  const f = FIRE['server/utils/tx.js'];
  const got = hits(fire, 'begin-without-rollback');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line, h.blocking]), [['server/utils/tx.js', lineOf(f, "'BEGIN'"), true]]);
});

test('begin-without-rollback stays quiet when the file holds a ROLLBACK, and on an iCal BEGIN: line', () => {
  assert.deepStrictEqual(hits(quiet, 'begin-without-rollback'), []);
});

test('floating-security-versions fires on ^ or ~ for a security package in either package.json', () => {
  const got = hits(fire, 'floating-security-versions');
  assert.deepStrictEqual(got.map((h) => h.file).sort(), ['client/package.json', 'package.json']);
  assert.ok(got.some((h) => h.text.includes('"express"')) && got.some((h) => h.text.includes('"jsonwebtoken"')));
});

test('floating-security-versions stays quiet on a pinned security package and a floating ordinary one', () => {
  assert.deepStrictEqual(hits(quiet, 'floating-security-versions'), []);
});

test('file-or-git-deps fires on file: and git+ in either package.json', () => {
  const got = hits(fire, 'file-or-git-deps');
  assert.deepStrictEqual(got.map((h) => h.file).sort(), ['client/package.json', 'package.json']);
});

test('file-or-git-deps stays quiet on semver ranges', () => {
  assert.deepStrictEqual(hits(quiet, 'file-or-git-deps'), []);
});

test('eslint-undef fires on const x = y in a server file, a TDZ read in scripts, and a dropped import', () => {
  const got = hits(fire, 'eslint-undef').map((h) => [h.file, h.line]);
  assert.deepStrictEqual(got, [
    ['scripts/tdz.js', 2],
    ['server/utils/dropped.js', lineOf(FIRE['server/utils/dropped.js'], 'return esc(s)')],
    ['server/utils/undef.js', 2],
  ]);
  assert.ok(hits(fire, 'eslint-undef').every((h) => h.blocking));
  assert.ok(hits(fire, 'eslint-undef', 'server/utils/undef.js')[0].text.includes("'y' is not defined"));
});

test('eslint-undef stays quiet on node globals, a hoisted function, a constant read from an inner function, and lint debt that predates the change', () => {
  assert.deepStrictEqual(hits(quiet, 'eslint-undef'), []);
});

test('pii fires on an email in a code path, with the text masked', () => {
  const got = hits(fire, 'pii', 'server/utils/contact.js');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].line, 2);
  assert.ok(got[0].blocking);
  assert.ok(got[0].text.includes('<EMAIL>') && !got[0].text.includes('person@example.com'), got[0].text);
});

test('a pii hit is re-masked and capped at 300 characters like every other finding', () => {
  const { r } = runChange(README, { 'server/utils/long.js': L("'use strict';", `const note = 'person@example.com ${'x'.repeat(400)}';`, 'module.exports = { note };') });
  const got = hits(r, 'pii', 'server/utils/long.js');
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].text.length <= 303, `text is ${got[0].text.length} characters`);
  assert.ok(got[0].text.includes('<EMAIL>') && !got[0].text.includes('person@example.com'), got[0].text.slice(0, 80));
});

test('pii stays quiet on an env read and on a fixture address in a test path', () => {
  assert.deepStrictEqual(hits(quiet, 'pii'), []);
});

test('eslint-undef and pii text on a line holding a secret literal print <LITERAL>, never the literal or a fragment of it', () => {
  const { r } = runChange(README, {
    'server/utils/leak.js': L("'use strict';", "const hook = process.env.HOOK_SECRET || 'sesame person@example.com'; const x = y;", 'module.exports = { hook, x };'),
  });
  assert.deepStrictEqual(r.json.findings.filter((f) => f.line === 2).map((f) => f.rule).sort(), ['eslint-undef', 'pii', 'secret-default']);
  for (const f of r.json.findings) assert.ok(!f.text.includes('sesame'), `${f.rule}: ${f.text}`);
  assert.ok(hits(r, 'eslint-undef')[0].text.includes('<LITERAL>') && hits(r, 'pii')[0].text.includes('<LITERAL>'), JSON.stringify(r.json.findings));
});

test('a pii hit on a line holding a secret literal prints <LITERAL> when git names the file with a backslash or a leading space', () => {
  const line = "const hook = process.env.HOOK_SECRET || 'sesame person@example.com';";
  const { r } = runChange(README, {
    'server/back\\slash.js': L("'use strict';", line, 'module.exports = { hook };'),
    ' server/lead.js': L("'use strict';", line, 'module.exports = { hook };'),
  });
  assert.deepStrictEqual(hits(r, 'secret-default').map((h) => h.file).sort(), [' server/lead.js', 'server/back\\slash.js']);
  assert.strictEqual(hits(r, 'pii').length, 2, JSON.stringify(r.json.findings));
  for (const f of r.json.findings) assert.ok(!f.text.includes('sesame'), `${f.rule} ${JSON.stringify(f.file)}: ${f.text}`);
  assert.ok(hits(r, 'pii').every((h) => h.text.includes('<LITERAL>')), JSON.stringify(hits(r, 'pii')));
});

test('two changed paths that differ only by a backslash are two files: each pii hit names its own path and the literal is redacted from its own blob', () => {
  const { r } = runChange(README, {
    'server/a/b.js': L("'use strict';", 'const n = 1;', "const who = 'person@example.com';", 'module.exports = { n, who };'),
    'server/a\\b.js': L("'use strict';", "const hook = process.env.HOOK_SECRET || 'sesame person@example.com';", 'module.exports = { hook };'),
  });
  assert.deepStrictEqual(hits(r, 'pii').map((h) => [h.file, h.line, h.blocking]).sort(), [['server/a/b.js', 3, true], ['server/a\\b.js', 2, true]]);
  for (const f of r.json.findings) assert.ok(!f.text.includes('sesame'), `${f.rule} ${JSON.stringify(f.file)}: ${f.text}`);
  assert.ok(hits(r, 'pii', 'server/a\\b.js')[0].text.includes('<LITERAL>'), JSON.stringify(hits(r, 'pii')));
});

test('a changed path that itself carries an address is a blocking pii finding with no line and a masked text (review-tooling security H1)', () => {
  const name = ['docs/clients/contact-x', 'example.com.md'].join('@');
  const { r } = runChange(README, { [name]: 'notes\n' });
  const got = hits(r, 'pii').filter((f) => f.line === null);
  assert.strictEqual(got.length, 1, JSON.stringify(r.json.findings));
  assert.ok(got[0].blocking);
  assert.ok(got[0].text.includes('<EMAIL>') && !got[0].text.includes(name), got[0].text);
  assert.ok(String(got[0].file).includes('<EMAIL>') && !String(got[0].file).includes(name), 'the file field is masked too: ' + got[0].file);
});

test('no finding text in either run carries a raw secret or address', () => {
  for (const r of [fire, quiet]) {
    assert.ok(r.json, 'the run printed its JSON');
    for (const raw of [LIVE_SECRET, WEBHOOK_SECRET, HEX32, 'person@example.com']) assert.ok(!r.stdout.includes(raw), `stdout carries ${raw.slice(0, 4)}`);
  }
});

// ---- Modes, scope and fail-closed ----------------------------------------------

test('a docs-only change: no findings, no eslint run, exit 0', () => {
  const dir = makeRepo();
  const base = commit(dir, { 'README.md': L('# fixture') }, 'seed');
  const tip = commit(dir, {
    'docs/plan.md': L(
      'Quotes code: dangerouslySetInnerHTML, process.env.JWT_SECRET || default, catch (e) {},',
      "pool.query(`SELECT ${x}`), require('stripe'), STRIPE_TEST_MODE_UNTIL=2026-12-01.",
    ),
  }, 'docs');
  const r = run(dir, ['--base', base, '--tip', tip]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(r.json.findings, []);
  assert.strictEqual(r.json.eslint_files, 0);
});

test('--staged reads the index: const x = y staged in a server file fires eslint-undef', () => {
  const dir = makeRepo();
  commit(dir, { 'server/utils/ok.js': L("'use strict';", 'module.exports = 1;') }, 'seed');
  const clean = run(dir, ['--staged']);
  assert.strictEqual(clean.status, 0, clean.stderr);
  assert.deepStrictEqual(clean.json.findings, []);
  writeFiles(dir, { 'server/utils/staged.js': L("'use strict';", 'const x = y;', 'module.exports = x;') });
  git(dir, ['add', '--', 'server/utils/staged.js']);
  const r = run(dir, ['--staged']);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.deepStrictEqual(hits(r, 'eslint-undef').map((h) => [h.file, h.line]), [['server/utils/staged.js', 2]]);
});

test('eslint-undef fails closed when the repo has no eslint config', () => {
  const dir = makeRepo({ eslint: false });
  const base = commit(dir, { 'server/utils/ok.js': L("'use strict';", 'module.exports = 1;') }, 'seed');
  const tip = commit(dir, { 'server/utils/ok.js': L("'use strict';", 'module.exports = 2;') }, 'edit');
  const r = run(dir, ['--base', base, '--tip', tip]);
  assert.strictEqual(r.status, 1);
  const got = hits(r, 'eslint-undef');
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].blocking && /did not run/.test(got[0].text), got[0].text);
});

// A repo with `seed` committed, then `change` committed on top: the run over
// the change.
function runChange(seed, change, { eslint = true, env, script } = {}) {
  const dir = makeRepo({ eslint });
  const base = commit(dir, seed, 'seed');
  const tip = commit(dir, change, 'change');
  return { dir, base, tip, r: run(dir, ['--base', base, '--tip', tip], { env, script }) };
}

const at = (r, rule) => hits(r, rule).map((h) => [h.file, h.line]);

// ---- The code view fails closed end to end (ruling 1) ---------------------------

test('a JS file espree cannot tokenize blocks the run with a scan finding, and its other rules stay silent', () => {
  const { r } = runChange(README, {
    'client/src/Broken.js': L("const { exec } = require('child_process');", "const s = 'open;", 'exec(`ls ${s}`);'),
    'client/src/Fine.js': L('export function Fine({ html }) {', "  return <p>Don't</p>;", '}'),
  });
  assert.strictEqual(r.status, 1);
  assert.deepStrictEqual(hits(r, 'scan').map((h) => [h.file, h.line, h.blocking]), [['client/src/Broken.js', 2, true]]);
  assert.deepStrictEqual(hits(r, 'command-injection'), []);
  assert.deepStrictEqual(r.json.findings.filter((f) => f.file === 'client/src/Fine.js'), []);
});

// ---- Paths (ruling 2) ----------------------------------------------------------

test('a path with a space and a renamed path with a space: every rule and eslint read them', () => {
  const run1 = (body) => L("'use strict';", "const { exec } = require('child_process');", 'function run(dir) {', body, '}', 'module.exports = { run };');
  const { r } = runChange(
    { 'server/utils/old name.js': run1("  return exec('ls');") },
    {
      'server/utils/old name.js': null,
      'server/utils/new name.js': run1('  return exec(`ls ${dir}`);'),
      'server/utils/my helper.js': L("'use strict';", 'const x = y;', 'module.exports = x;'),
    },
  );
  assert.ok(r.json, r.stderr);
  assert.deepStrictEqual(at(r, 'command-injection'), [['server/utils/new name.js', 4]]);
  assert.deepStrictEqual(at(r, 'eslint-undef'), [['server/utils/my helper.js', 2]]);
  assert.strictEqual(r.json.eslint_files, 2);
  assert.strictEqual(r.json.files, 2);
});

test('parseDiff reads C-quoted paths, rename lines, a deleted spaced path, and the TAB a ---/+++ line carries', () => {
  const { parseDiff } = require('./static-checks.js');
  const diff = [
    'diff --git "a/server/q\\"x.js" "b/server/q\\"x.js"',
    'new file mode 100644',
    '--- /dev/null',
    '+++ "b/server/q\\"x.js"',
    '@@ -0,0 +1 @@',
    '+one',
    'diff --git a/server/a b.js b/server/c d.js',
    'similarity index 90%',
    'rename from server/a b.js',
    'rename to server/c d.js',
    '--- a/server/a b.js\t',
    '+++ b/server/c d.js\t',
    '@@ -2,0 +3 @@',
    '+three',
    'diff --git a/gone file.js b/gone file.js',
    'deleted file mode 100644',
    '--- a/gone file.js\t',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-x',
  ].join('\n');
  const files = parseDiff(diff);
  assert.deepStrictEqual(files.map((f) => [f.path, f.oldPath, f.status, [...f.added]]), [
    ['server/q"x.js', null, 'A', [[1, 'one']]],
    ['server/c d.js', 'server/a b.js', 'R', [[3, 'three']]],
    ['gone file.js', 'gone file.js', 'D', []],
  ]);
});

test('parseDiff refuses a path with an empty, . or .. component on either side, and a path that does not parse', () => {
  const { parseDiff } = require('./static-checks.js');
  const entry = (p) => [`diff --git a/${p} b/${p}`, 'new file mode 100644', '--- /dev/null', `+++ b/${p}`, '@@ -0,0 +1 @@', '+x'];
  const diff = [
    ...entry('server/../../x.js'),
    ...entry('./a.js'),
    ...entry('server//b.js'),
    ...entry('server/ok.js'),
    'diff --git a/server/new.js b/server/new.js',
    'similarity index 100%',
    'rename from server/../old.js',
    'rename to server/new.js',
    'diff --git nothing-here',
  ].join('\n');
  const files = parseDiff(diff);
  assert.deepStrictEqual(files.map((f) => [f.path, Boolean(f.refused)]), [
    ['server/../../x.js', true],
    ['./a.js', true],
    ['server//b.js', true],
    ['server/ok.js', false],
    ['server/new.js', true],
    [null, true],
  ]);
});

// A commit on top of `parent` whose tree adds `server/../../../../escape.js`
// (git plumbing builds a tree entry named `..`; checkout and fsck refuse one).
function dotDotCommit(dir, parent) {
  const sh = (args, input) => execFileSync('git', args, { cwd: dir, input, encoding: 'utf8' }).trim();
  const tree = (entries) => sh(['mktree'], entries.map(([mode, type, sha, name]) => `${mode} ${type} ${sha}\t${name}`).join('\n') + '\n');
  let t = tree([['100644', 'blob', sh(['hash-object', '-w', '--stdin'], L("'use strict';", 'module.exports = 1;')), 'escape.js']]);
  for (let k = 0; k < 4; k++) t = tree([['040000', 'tree', t, '..']]);
  const root = tree([['100644', 'blob', sh(['rev-parse', `${parent}:README.md`]), 'README.md'], ['040000', 'tree', t, 'server']]);
  return sh(['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit-tree', root, '-p', parent, '-m', 'dotdot']);
}

test('a tree entry named .. is refused at parse time: JSON prints, exit 1, a blocking scan finding, nothing written outside the temp dir', () => {
  const dir = makeRepo();
  const base = commit(dir, README, 'seed');
  const tip = dotDotCommit(dir, base);
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-outer-'));
  roots.push(outer);
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner);
  const r = run(dir, ['--base', base, '--tip', tip], { env: { TMPDIR: inner } });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.ok(r.json, `JSON on stdout; stderr: ${r.stderr.slice(0, 300)}`);
  assert.deepStrictEqual(hits(r, 'scan').map((h) => [h.file, h.line, h.blocking]), [['server/../../../../escape.js', null, true]]);
  assert.match(hits(r, 'scan')[0].text, /refused/);
  assert.deepStrictEqual(fs.readdirSync(outer), ['inner']);
  assert.deepStrictEqual(fs.readdirSync(inner), []);
});

// ---- eslint-undef runs over every target or says it did not (rulings 3, 4) -----

const README = { 'README.md': L('# fixture') };
const UNDEF = L("'use strict';", 'const x = y;', 'module.exports = x;');

test('eslint-undef still runs when the temp dir sits behind a symlinked TMPDIR, and removes its temp dir', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-realtmp-'));
  roots.push(real);
  const link = `${real}-link`;
  fs.symlinkSync(real, link);
  roots.push(link);
  const { r } = runChange(README, { 'server/utils/undef.js': UNDEF }, { env: { TMPDIR: link } });
  assert.deepStrictEqual(at(r, 'eslint-undef'), [['server/utils/undef.js', 2]]);
  assert.strictEqual(r.json.eslint_files, 1);
  assert.deepStrictEqual(fs.readdirSync(real).filter((n) => n.startsWith('static-checks-')), []);
});

test('a target eslint ignores is never a silent pass: a blocking did-not-run finding for that file', () => {
  const { r } = runChange(README, { 'scripts/node_modules/shim.js': UNDEF, 'server/utils/undef.js': UNDEF });
  const got = hits(r, 'eslint-undef');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line]), [['scripts/node_modules/shim.js', null], ['server/utils/undef.js', 2]]);
  assert.ok(got[0].blocking && /^eslint did not run: /.test(got[0].text), got[0].text);
});

test('a target git cannot hand over as a blob is not linted: a blocking did-not-run finding for that file', () => {
  const dir = makeRepo();
  const base = commit(dir, README, 'seed');
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${base},server/utils/sub.js`]);
  writeFiles(dir, { 'server/utils/undef.js': UNDEF });
  git(dir, ['add', '--', 'server/utils/undef.js']);
  git(dir, ['commit', '-q', '--no-gpg-sign', '-m', 'gitlink']);
  const r = run(dir, ['--base', base, '--tip', git(dir, ['rev-parse', 'HEAD'])]);
  const got = hits(r, 'eslint-undef');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line]), [['server/utils/sub.js', null], ['server/utils/undef.js', 2]]);
  assert.ok(got[0].blocking && /^eslint did not run: /.test(got[0].text), got[0].text);
});

test('a gitlink named like a client .js file is never read as an empty file: a blocking scan finding, no rule runs on it', () => {
  const dir = makeRepo();
  const base = commit(dir, README, 'seed');
  git(dir, ['update-index', '--add', '--cacheinfo', `160000,${base},client/src/x.js`]);
  git(dir, ['commit', '-q', '--no-gpg-sign', '-m', 'gitlink']);
  const r = run(dir, ['--base', base, '--tip', git(dir, ['rev-parse', 'HEAD'])]);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.deepStrictEqual(hits(r, 'scan').map((h) => [h.file, h.line, h.blocking]), [['client/src/x.js', null, true]]);
  assert.match(hits(r, 'scan')[0].text, /could not be read from git/);
  // pii reads the diff's own added line (Subproject commit <sha>), not the blob.
  assert.deepStrictEqual(r.json.findings.filter((f) => f.file === 'client/src/x.js' && f.rule !== 'scan' && f.rule !== 'pii'), []);
});

test('a code file whose path holds a newline cannot go through cat-file: a blocking scan finding, never a rebuild from the added lines', () => {
  const { r } = runChange(README, { 'server/utils/a\nb.js': L("'use strict';", 'module.exports = 1;') });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.deepStrictEqual(hits(r, 'scan').map((h) => [h.file, h.line, h.blocking]), [['server/utils/a\nb.js', null, true]]);
});

test('eslint-undef reports the git line and its text when a U+2028 or a lone CR sits above the hit', () => {
  const { r } = runChange(README, {
    'server/utils/ls.js': L("'use strict';", "const note = 'a\u2028b';", 'const x = y;', 'module.exports = { note, x };'),
    'server/utils/cr.js': L("'use strict';", 'const one = 1;\rconst two = 2;', 'const x = z;', 'module.exports = { one, two, x };'),
  });
  assert.deepStrictEqual(at(r, 'eslint-undef'), [['server/utils/cr.js', 3], ['server/utils/ls.js', 3]]);
  assert.ok(hits(r, 'eslint-undef').every((h) => /const x = [yz];$/.test(h.text)), JSON.stringify(hits(r, 'eslint-undef').map((h) => h.text)));
});

test('an undefined call in a target named with U+2028, trailing whitespace or an upper-case extension is never silent: eslint-undef fires or did not run', () => {
  const src = L("'use strict';", 'module.exports = () => missingFn();');
  const names = ['server/bs/u\u2028v.js', 'server/trail.js ', 'server/UP.JS'];
  const { r } = runChange(README, Object.fromEntries(names.map((n) => [n, src])));
  for (const n of names) {
    const got = hits(r, 'eslint-undef', n);
    assert.ok(got.length > 0 && got.every((h) => h.blocking), `${JSON.stringify(n)}: ${JSON.stringify(r.json.findings)}`);
  }
  assert.strictEqual(r.status, 1);
});

test('crypto is not a declared global in scripts/: a dropped require fires eslint-undef', () => {
  const { r } = runChange(README, { 'scripts/hash.js': L("'use strict';", "const h = crypto.createHash('sha256');", 'module.exports = h;') });
  assert.deepStrictEqual(at(r, 'eslint-undef'), [['scripts/hash.js', 2]]);
});

test('eslint-undef maps lines through the hunks: a new undefined foo() on an unchanged line is reported though another pre-existing foo() was deleted', () => {
  const { r } = runChange({
    'server/utils/twofoo.js': L(
      "'use strict';",
      'function a() {',
      "  const { foo } = require('./foo');",
      '  return foo();',
      '}',
      'function b() {',
      '  return foo();',
      '}',
      'module.exports = { a, b };',
    ),
    'server/utils/shifted.js': L("'use strict';", 'function read() {', '  return missingThing;', '}', 'module.exports = { read };'),
  }, {
    'server/utils/twofoo.js': L("'use strict';", 'function a() {', '  return foo();', '}', 'module.exports = { a };'),
    'server/utils/shifted.js': L("'use strict';", 'const extra = 2;', 'function read() {', '  return missingThing;', '}', 'module.exports = { read, extra };'),
  });
  assert.deepStrictEqual(at(r, 'eslint-undef'), [['server/utils/twofoo.js', 3]]);
});

test('diff.interHunkContext in the repo config never merges hunks: a new undefined foo on an unchanged line still blocks though the base held the same message one line lower', () => {
  const dir = makeRepo();
  git(dir, ['config', 'diff.interHunkContext', '1']);
  const base = commit(dir, {
    'server/utils/merged.js': L(
      "'use strict';",
      'function f(foo) {',
      '  return foo; }',
      'const g = () => foo;',
      'module.exports = { f, g };',
    ),
  }, 'seed');
  // The dropped parameter (line 2 becomes two lines) leaves foo undefined on
  // the unchanged line 4; line 4 at base, gone at tip, held the same message.
  const tip = commit(dir, {
    'server/utils/merged.js': L(
      "'use strict';",
      'function f() {',
      '  const unused = 1;',
      '  return foo; }',
      'const g = 1;',
      'module.exports = { f, g };',
    ),
  }, 'change');
  const r = run(dir, ['--base', base, '--tip', tip]);
  assert.deepStrictEqual(hits(r, 'eslint-undef').map((h) => [h.file, h.line, h.blocking]), [['server/utils/merged.js', 4, true]]);
  assert.strictEqual(r.json.eslint_files, 1);
});

test('parseDiff records each hunk: old start and count, new start and count', () => {
  const { parseDiff } = require('./static-checks.js');
  const diff = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -3 +2,0 @@', '-gone', '@@ -6,3 +5 @@', '-a', '-b', '-c', '+d', '@@ -9,0 +7,2 @@', '+e', '+f'].join('\n');
  assert.deepStrictEqual(parseDiff(diff)[0].hunks, [
    { oldStart: 3, oldCount: 1, newStart: 2, newCount: 0 },
    { oldStart: 6, oldCount: 3, newStart: 5, newCount: 1 },
    { oldStart: 9, oldCount: 0, newStart: 7, newCount: 2 },
  ]);
  assert.deepStrictEqual([...parseDiff(diff)[0].added], [[5, 'd'], [7, 'e'], [8, 'f']]);
});

// ---- eslint-undef cannot be silenced by the base or a file directive (ruling 9) ---

test('a parse error at the tip blocks even when the base has the same error', () => {
  const broken = (n) => L("'use strict';", 'const = 1;', `module.exports = ${n};`);
  const { r } = runChange({ 'server/utils/broken.js': broken(1) }, { 'server/utils/broken.js': broken(2) });
  const got = hits(r, 'eslint-undef', 'server/utils/broken.js');
  assert.deepStrictEqual(got.map((h) => [h.line, h.blocking]), [[2, true]]);
  assert.match(got[0].text, /^parse error: /);
});

test('a whole-file eslint-disable or an inline rule config does not silence eslint-undef; a line-level directive still does', () => {
  const { r } = runChange(README, {
    'server/utils/disabled.js': L('/* eslint-disable */', "'use strict';", 'const x = y;', 'module.exports = x;'),
    'server/utils/ruleoff.js': L('/* eslint-disable no-undef */', '/* eslint no-undef: "off" */', "'use strict';", 'const x = z;', 'module.exports = x;'),
    'server/utils/nextline.js': L("'use strict';", '// eslint-disable-next-line no-undef', 'const x = w;', 'module.exports = x;'),
  });
  assert.deepStrictEqual(at(r, 'eslint-undef'), [['server/utils/disabled.js', 3], ['server/utils/ruleoff.js', 4]]);
});

test('the <!-- and backtick shape cannot hide a whole-file eslint-disable from the neutralizer', () => {
  const { r } = runChange(README, {
    'server/utils/hidden.js': L("'use strict';", 'let b = 0;', 'const a = 1 <!-- b + `', '/* eslint-disable */', 'const x = y;', '// `;', 'module.exports = { a, b, x };'),
  });
  assert.deepStrictEqual(at(r, 'eslint-undef'), [['server/utils/hidden.js', 5]]);
  assert.deepStrictEqual(at(r, 'scan'), [['server/utils/hidden.js', 3]]);
});

// ---- The client bundle and tracked env files (ruling 11) ------------------------

test('secrets-in-client-bundle also reads client/public/ (every text file) and client/.env*', () => {
  const { r } = runChange(README, {
    'client/public/sw.js': L(`const k = '${LIVE_SECRET}';`),
    'client/public/notes.md': L(`hook ${WEBHOOK_SECRET}`),
    'client/.env.production': L(`REACT_APP_HOOK=${WEBHOOK_SECRET}`),
    'client/public/raw.bin.png': L(`${HEX32}`),
  });
  assert.deepStrictEqual(at(r, 'secrets-in-client-bundle'), [['client/.env.production', 1], ['client/public/notes.md', 1], ['client/public/sw.js', 1]]);
  assert.ok(hits(r, 'secrets-in-client-bundle').every((h) => h.blocking && h.text.includes('<TOKEN>')));
});

test('env-ignored exempts only .env.example files and client/.env.production, whatever their keys', () => {
  const { r } = runChange(README, {
    'client/.env.local': L('REACT_APP_API_URL=https://api.example.test'),
    'client/.env.production': L('REACT_APP_API_URL=https://api.example.test'),
    'tools/.env.example': L('TOOL_TOKEN='),
    'server/.env.production': L('PORT=5000'),
  });
  assert.deepStrictEqual(hits(r, 'env-ignored').map((h) => [h.file, h.line, h.blocking]), [['client/.env.local', null, true], ['server/.env.production', null, true]]);
});

test('client/.env* and server/.env* are globs for env-ignored and the bundle; thumbtack-agent/package.json takes the package rules; rk_live_ is a bundle shape', () => {
  const restricted = ['rk', 'live', 'R'.repeat(24)].join('_');
  const pkg = JSON.stringify({ name: 'agent', dependencies: { express: '^4.0.0', lib: 'file:../lib' } }, null, 2) + '\n';
  const { r } = runChange(README, {
    'client/.env-staging': L('REACT_APP_API_URL=https://api.example.test'),
    'client/.envrc': L(`export HOOK=${WEBHOOK_SECRET}`),
    'server/.env_prod': L('PORT=5000'),
    'thumbtack-agent/.env.example': L('AGENT_TOKEN='),
    'thumbtack-agent/package.json': pkg,
    'client/src/restricted.js': L(`export const k = '${restricted}';`),
  });
  assert.deepStrictEqual(hits(r, 'env-ignored').map((h) => [h.file, h.blocking]), [['client/.env-staging', true], ['client/.envrc', true], ['server/.env_prod', true]]);
  assert.deepStrictEqual(at(r, 'secrets-in-client-bundle'), [['client/.envrc', 1], ['client/src/restricted.js', 1]]);
  assert.deepStrictEqual(at(r, 'floating-security-versions'), [['thumbtack-agent/package.json', lineOf(pkg, '"express"')]]);
  assert.deepStrictEqual(at(r, 'file-or-git-deps'), [['thumbtack-agent/package.json', lineOf(pkg, '"lib"')]]);
  assert.ok(!r.stdout.includes(restricted) && !r.stdout.includes(WEBHOOK_SECRET), 'no key prints');
});

// ---- Usage errors and ref validation -------------------------------------------

let usageRepo;
let usageSha;

function usageSetup() {
  if (!usageRepo) {
    usageRepo = makeRepo({ eslint: false });
    usageSha = commit(usageRepo, { 'README.md': L('# fixture') }, 'seed');
  }
  return { dir: usageRepo, sha: usageSha };
}

for (const [name, args] of [
  ['no arguments', []],
  ['--base without --tip', ['--base', 'HEAD']],
  ['--tip without --base', ['--tip', 'HEAD']],
  ['--staged with --base', ['--staged', '--base', 'HEAD', '--tip', 'HEAD']],
  ['an unknown flag', ['--bogus']],
  ['a flag with no value', ['--base', 'HEAD', '--tip']],
]) {
  test(`usage error, exit 2: ${name}`, () => {
    const { dir } = usageSetup();
    const r = run(dir, args);
    assert.strictEqual(r.status, 2, r.stdout);
    assert.match(r.stderr, /usage/);
  });
}

test('ref validation: an unknown ref exits 2', () => {
  const { dir, sha } = usageSetup();
  const r = run(dir, ['--base', 'no-such-ref', '--tip', sha]);
  assert.strictEqual(r.status, 2);
});

test('ref validation: a blob is not a commit, exit 2', () => {
  const { dir, sha } = usageSetup();
  const r = run(dir, ['--base', `${sha}:README.md`, '--tip', sha]);
  assert.strictEqual(r.status, 2);
});

test('ref validation: an option-shaped ref never reaches git as an option', () => {
  const { dir, sha } = usageSetup();
  const out = path.join(dir, 'leak.txt');
  const r = run(dir, ['--base', `--output=${out}`, '--tip', sha]);
  assert.strictEqual(r.status, 2);
  assert.ok(!fs.existsSync(out), 'no file written by an injected --output');
});

// ---- Every failure prints JSON and exits 1; only argv misuse exits 2 (ruling 12) --

const didNotRun = (r) => hits(r, 'did-not-run');

test('outside a git repo: JSON with a blocking did-not-run finding, exit 1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-nogit-'));
  roots.push(dir);
  const r = run(dir, ['--staged']);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.ok(r.json, 'JSON on stdout');
  assert.deepStrictEqual(didNotRun(r).map((f) => [f.file, f.line, f.blocking]), [[null, null, true]]);
  assert.strictEqual(r.json.blocking, 1);
});

test('a git diff that fails (a blob missing from the object store): JSON with a blocking did-not-run finding, exit 1', () => {
  const dir = makeRepo({ eslint: false });
  const base = commit(dir, README, 'seed');
  const tip = commit(dir, { 'server/utils/a.js': L("'use strict';", 'module.exports = 1;') }, 'add');
  const blob = git(dir, ['rev-parse', `${tip}:server/utils/a.js`]);
  fs.rmSync(path.join(dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const r = run(dir, ['--base', base, '--tip', tip]);
  assert.strictEqual(r.status, 1, r.stderr);
  assert.ok(r.json, `JSON on stdout; stderr: ${r.stderr.slice(0, 500)}`);
  const got = didNotRun(r);
  assert.strictEqual(got.length, 1);
  assert.ok(got[0].blocking && got[0].file === null && got[0].line === null && /did not run/.test(got[0].text), got[0].text);
});

test('eslint that exits 2 (a config that throws): one blocking did-not-run finding per target, eslint_files 0', () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'eslint.config.mjs'), "throw new Error('broken config');\n");
  const base = commit(dir, README, 'seed');
  const tip = commit(dir, { 'server/utils/a.js': L("'use strict';", 'module.exports = 1;'), 'scripts/b.js': L("'use strict';", 'module.exports = 2;') }, 'add');
  const r = run(dir, ['--base', base, '--tip', tip]);
  assert.strictEqual(r.status, 1, r.stderr);
  const got = hits(r, 'eslint-undef');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line, h.blocking]), [['scripts/b.js', null, true], ['server/utils/a.js', null, true]]);
  assert.ok(got.every((h) => /^eslint did not run: eslint exited 2/.test(h.text)), got[0].text);
  assert.strictEqual(r.json.eslint_files, 0);
});

test('a missing eslint binary with the config present: the finding names the binary, per target', () => {
  const dir = makeRepo({ eslint: false });
  fs.copyFileSync(path.join(REPO_ROOT, 'eslint.config.mjs'), path.join(dir, 'eslint.config.mjs'));
  const base = commit(dir, README, 'seed');
  const tip = commit(dir, { 'server/utils/a.js': L("'use strict';", 'module.exports = 1;') }, 'add');
  const r = run(dir, ['--base', base, '--tip', tip]);
  assert.strictEqual(r.status, 1);
  const got = hits(r, 'eslint-undef');
  assert.deepStrictEqual(got.map((h) => [h.file, h.line]), [['server/utils/a.js', null]]);
  assert.match(got[0].text, /node_modules\/\.bin\/eslint/);
});

// A copy of the script tree with its piiShapes.js replaced by `stub`.
function scriptCopy(stub) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-copy-'));
  roots.push(tree);
  const lib = path.join(tree, 'scripts', 'lib', 'staticChecks');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(tree, 'scripts', 'static-checks.js'));
  for (const f of fs.readdirSync(path.join(__dirname, 'lib', 'staticChecks'))) {
    if (!f.endsWith('.test.js')) fs.copyFileSync(path.join(__dirname, 'lib', 'staticChecks', f), path.join(lib, f));
  }
  fs.writeFileSync(path.join(tree, 'scripts', 'lib', 'piiShapes.js'), stub);
  return path.join(tree, 'scripts', 'static-checks.js');
}

test('the pii pre-step not running: a blocking pii finding with a null file and line, exit 1', () => {
  const script = scriptCopy("'use strict';\nmodule.exports = { mask: (t) => String(t) };\nif (require.main === module) process.exit(3);\n");
  const { r } = runChange(README, { 'docs/x.md': L('# x') }, { script });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.deepStrictEqual(hits(r, 'pii').map((h) => [h.file, h.line, h.blocking]), [[null, null, true]]);
  assert.match(hits(r, 'pii')[0].text, /did not run/);
});

test('a PII mask that throws when it loads: JSON still prints, every text is withheld, a blocking did-not-run, exit 1', () => {
  const script = scriptCopy("'use strict';\nthrow new ReferenceError('the mask could not initialize');\n");
  const { r } = runChange(README, { 'server/utils/a.js': L("'use strict';", "const { exec } = require('child_process');", 'function f(dir) {', '  exec(`ls ${dir}`);', '}', 'module.exports = { f };') }, { script });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.ok(r.json, `JSON on stdout; stderr: ${r.stderr.slice(0, 300)}`);
  assert.ok(didNotRun(r).some((f) => /mask/.test(f.text)), JSON.stringify(didNotRun(r)));
  assert.deepStrictEqual(hits(r, 'command-injection').map((h) => h.line), [4]);
  const withFile = r.json.findings.filter((f) => f.file !== null);
  assert.ok(withFile.length > 0 && withFile.every((f) => /withheld/.test(f.text)), JSON.stringify(r.json.findings.map((f) => f.text)));
  assert.deepStrictEqual(hits(r, 'pii').map((h) => [h.file, h.blocking]), [[null, true]]);
  assert.ok(!r.stdout.includes('exec(`ls'), 'no raw line is printed without the mask');
});

test('SIGTERM mid-eslint with a slow pipe reader: the JSON (about 2 MB) still arrives whole', async () => {
  const dir = makeRepo({ eslint: false });
  fs.copyFileSync(path.join(REPO_ROOT, 'eslint.config.mjs'), path.join(dir, 'eslint.config.mjs'));
  const bin = path.join(dir, 'node_modules', '.bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'eslint'), '#!/bin/sh\necho $$ > "$STATIC_CHECKS_TEST_PIDFILE"\nexec sleep 30\n', { mode: 0o755 });
  const base = commit(dir, README, 'seed');
  const many = Array.from({ length: 5000 }, (_, k) => `try { f(${k}); } catch {} // ${'note '.repeat(60)}`).join('\n') + '\n';
  const tip = commit(dir, { 'server/utils/many.js': many }, 'add');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-sigtmp-'));
  roots.push(tmp);
  const pidFile = path.join(tmp, 'eslint.pid');
  const child = spawn(process.execPath, [SCRIPT, '--base', base, '--tip', tip], { cwd: dir, env: { ...process.env, TMPDIR: tmp, STATIC_CHECKS_TEST_PIDFILE: pidFile } });
  child.stderr.resume();
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const t0 = Date.now();
  while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8').trim() === '') {
    if (Date.now() - t0 > 30000) {
      child.kill('SIGKILL');
      throw new Error('the fake eslint never started');
    }
    await sleep(50);
  }
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  child.kill('SIGTERM');
  await sleep(1500);
  const chunks = [];
  child.stdout.on('data', (b) => chunks.push(b));
  const code = await closed;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone: abortAll killed it
  }
  const stdout = Buffer.concat(chunks).toString('utf8');
  assert.strictEqual(code, 1);
  assert.ok(stdout.length > 1024 * 1024, `stdout is ${stdout.length} bytes`);
  const json = JSON.parse(stdout);
  assert.strictEqual(hits({ json }, 'swallowed-catch').length, 5000);
  assert.ok(json.findings.some((f) => f.rule === 'did-not-run' && f.text.includes('SIGTERM')));
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  test(`${sig} while eslint runs: eslint is killed, the temp dir removed, JSON with a blocking did-not-run, exit 1`, async () => {
    const dir = makeRepo({ eslint: false });
    fs.copyFileSync(path.join(REPO_ROOT, 'eslint.config.mjs'), path.join(dir, 'eslint.config.mjs'));
    const bin = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'eslint'), '#!/bin/sh\necho $$ > "$STATIC_CHECKS_TEST_PIDFILE"\nexec sleep 30\n', { mode: 0o755 });
    const base = commit(dir, README, 'seed');
    const tip = commit(dir, { 'server/utils/a.js': L("'use strict';", 'module.exports = 1;') }, 'add');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-sigtmp-'));
    roots.push(tmp);
    const pidFile = path.join(tmp, 'eslint.pid');
    const child = spawn(process.execPath, [SCRIPT, '--base', base, '--tip', tip], { cwd: dir, env: { ...process.env, TMPDIR: tmp, STATIC_CHECKS_TEST_PIDFILE: pidFile } });
    let stdout = '';
    child.stdout.on('data', (b) => { stdout += b; });
    child.stderr.resume();
    const exited = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const t0 = Date.now();
    while (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, 'utf8').trim() === '') {
      if (Date.now() - t0 > 20000) {
        child.kill('SIGKILL');
        throw new Error('the fake eslint never started');
      }
      await sleep(50);
    }
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    child.kill(sig);
    const { code } = await exited;
    let alive = true;
    for (let k = 0; k < 40 && alive; k++) {
      try {
        process.kill(pid, 0);
        await sleep(50);
      } catch {
        alive = false;
      }
    }
    if (alive) process.kill(pid, 'SIGKILL');
    assert.strictEqual(code, 1);
    const json = JSON.parse(stdout);
    assert.ok(json.findings.some((f) => f.rule === 'did-not-run' && f.blocking && f.text.includes(sig)), stdout.slice(0, 500));
    assert.deepStrictEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('static-checks-')), []);
    assert.strictEqual(alive, false, 'the eslint child was killed');
  });
}

test('a replace ref on the tip does not hide a secret default: static-checks reads the real tip (gemini on the pii quick fix)', () => {
  const dir = makeRepo({ eslint: false });
  const base = commit(dir, README, 'seed');
  const tip = commit(dir, { 'server/utils/hook.js': L("'use strict';", "const hook = process.env.HOOK_SECRET || 'sesame';", 'module.exports = { hook };') }, 'change');
  const other = commit(dir, { 'server/utils/hook.js': L("'use strict';", 'const hook = process.env.HOOK_SECRET;', 'module.exports = { hook };') }, 'other');
  execFileSync('git', ['replace', tip, other], { cwd: dir, encoding: 'utf8' });
  const r = run(dir, ['--base', base, '--tip', tip]);
  assert.deepStrictEqual(hits(r, 'secret-default').map((h) => [h.file, h.line]), [['server/utils/hook.js', 2]], JSON.stringify(r.json && r.json.findings));
});

test('a finding on a file whose name carries an address prints the file masked, in the path hit and in every other finding on it (pii quick-fix security M1)', () => {
  const name = ['server/utils/c-contact', 'example.com.js'].join('@');
  const { r } = runChange(README, { [name]: L("'use strict';", "const hook = process.env.HOOK_SECRET || 'sesame';", 'module.exports = { hook };') });
  const onIt = r.json.findings.filter((f) => f.rule === 'pii' || f.rule === 'secret-default');
  assert.ok(onIt.length >= 2, JSON.stringify(r.json.findings));
  for (const f of onIt) {
    assert.ok(!String(f.file).includes(name) && !String(f.file).includes('contact@'), `${f.rule} prints the name raw: ${JSON.stringify(f.file)}`);
    assert.ok(String(f.file).includes('<EMAIL>'), `${f.rule} names the file by its masked form: ${JSON.stringify(f.file)}`);
  }
});
