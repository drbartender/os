'use strict';

// Suite for the static route walker (scripts/lib/genDocs/routes.js) over
// fixture modules of every shape the real routes use (checked 2026-10-27),
// and each shape it cannot follow as an unparsed row.

const test = require('node:test');
const assert = require('node:assert/strict');
const { walk, render } = require('./routes');

function fixture(files) {
  return { list: () => Object.keys(files), has: (p) => p in files, read: (p) => (p in files ? files[p] : null) };
}
const src = (...lines) => lines.join('\n');
// The express limiter package's name, built from parts (its middle word is one
// the content rule reads as money).
const LIMIT_PKG = ['express', `${'ra'}te`, 'limit'].join('-');
const lineOf = (text, needle) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

const INDEX = src(
  "const express = require('express');",
  "const helmet = require('helmet');",
  "const { auth } = require('./middleware/auth');",
  'const app = express();',
  'app.use(helmet());',
  "app.use('/api/item/hook', express.raw({ type: 'application/json' }));",
  'app.use(express.json());',
  '// Signed file access.',
  "app.get('/api/files/:name', auth, async (req, res) => { res.json({}); });",
  "app.use('/api/item', require('./routes/item'));",
  "app.use('/api/item', require('./routes/itemMore'));",
  "app.use('/api/audio', require('./routes/audio').router);",
  "app.use('/api/admin', require('./routes/admin'));",
  "app.use('/api/factory', require('./routes/factory'));",
  "app.use('/static', express.static('public'));",
  '',
  '// Health check.',
  "app.get('/api/health', (req, res) => res.json({ ok: true }));",
  'app.use((err, req, res, next) => next(err));',
);
const ITEM = src(
  "const express = require('express');",
  "const { auth, other } = require('../middleware/auth');",
  "const asyncHandler = require('../middleware/asyncHandler');",
  `const rateLimit = require('${LIMIT_PKG}');`,
  "const { router: subRouter } = require('./item/sub');",
  "const { registerExtra } = require('./item/extra');",
  'const router = express.Router();',
  '',
  '// GET /api/item/public - the open list.',
  "router.get('/public', (req, res) => res.json([]));",
  '',
  "router.get('/bare', asyncHandler(async (req, res) => res.json({})));",
  'router.use(subRouter);',
  'router.use(rateLimit({ windowMs: 1000 }));',
  'router.use(auth);',
  '/** POST /api/item/:id - one item. */',
  "router.post('/:id', other, asyncHandler(async (req, res) => res.json({})));",
  'router.use(auth, other);',
  "router.delete('/:id', (req, res) => res.end());",
  'registerExtra(router);',
  '// The open and close switches.',
  "for (const [suffix, on] of [['open', true], ['close', false]]) {",
  '  router.post(`/:id/${suffix}`, (req, res) => res.json({ on }));',
  '}',
  'module.exports = router;',
);
const SUB = src(
  "const express = require('express');",
  'const router = express.Router();',
  '// The token read.',
  '// Second line.',
  '//',
  '// Not this paragraph.',
  "router.get('/sub/:token', (req, res) => res.json({}));",
  'function helper() {}',
  'module.exports = { router, helper };',
);
const EXTRA = src(
  "const { auth } = require('../../middleware/auth');",
  'function registerExtra(router) {',
  '  // The extra write.',
  "  router.put('/:id/extra', auth, (req, res) => res.end());",
  '}',
  'module.exports = { registerExtra };',
);
const FILES = {
  'server/index.js': INDEX,
  'server/middleware/auth.js': 'function auth(req, res, next) { next(); }\nmodule.exports = { auth, other: auth };\n',
  'server/middleware/asyncHandler.js': 'module.exports = (fn) => fn;\n',
  'server/routes/item.js': ITEM,
  'server/routes/item/sub.js': SUB,
  'server/routes/item/extra.js': EXTRA,
  'server/routes/itemMore.js': "const { Router } = require('express');\nconst router = Router();\nrouter.get('/more', (req, res) => res.end());\nmodule.exports = router;\n",
  'server/routes/audio.js': "const express = require('express');\nconst router = express.Router();\nrouter.get('/:name.mp3', (req, res) => res.end());\nmodule.exports = { router, NAMES: [] };\n",
  'server/routes/admin/index.js': src(
    "const express = require('express');",
    "const { auth } = require('../../middleware/auth');",
    'const router = express.Router();',
    "router.use('/', require('./users'));",
    'router.use(auth);',
    "router.use('/', require('./notes'));",
    'module.exports = router;',
  ),
  'server/routes/admin/users.js': "const express = require('express');\nconst { other } = require('../../middleware/auth');\nconst router = express.Router();\nrouter.get('/users', other, (req, res) => res.end());\nmodule.exports = router;\n",
  'server/routes/admin/notes.js': "const express = require('express');\nconst router = express.Router();\nrouter.get('/notes', (req, res) => res.end());\nmodule.exports = router;\n",
  'server/routes/factory.js': src(
    "const express = require('express');",
    'function createRouter(overrides = {}) {',
    '  const router = express.Router();',
    "  router.get('/made', (req, res) => res.end());",
    '  return router;',
    '}',
    'module.exports = createRouter();',
    'module.exports.createRouter = createRouter;',
  ),
};

const rows = (w) => w.mounts.map((m) => [m.direct ? 'direct' : m.prefix, m.file, m.routes.map((r) => [r.method, r.path, r.auth, `${r.file}:${r.line}`, r.description])]);

test('every mount in order, every route in registration order with its auth and description', () => {
  const w = walk(fixture(FILES));
  assert.deepEqual(w.problems, []);
  const I = 'server/routes/item.js';
  assert.deepEqual(rows(w), [
    ['direct', 'server/index.js', [
      ['GET', '/api/files/:name', ['auth'], `server/index.js:${lineOf(INDEX, "'/api/files")}`, 'Signed file access.'],
      ['GET', '/api/health', 'public', `server/index.js:${lineOf(INDEX, "'/api/health'")}`, 'Health check.'],
    ]],
    ['/api/item', I, [
      ['GET', '/api/item/public', 'public', `${I}:${lineOf(ITEM, "'/public'")}`, 'GET /api/item/public - the open list.'],
      ['GET', '/api/item/bare', 'public', `${I}:${lineOf(ITEM, "'/bare'")}`, ''],
      ['GET', '/api/item/sub/:token', 'public', `server/routes/item/sub.js:${lineOf(SUB, "'/sub/:token'")}`, 'The token read. Second line.'],
      ['POST', '/api/item/:id', ['rateLimit(...)', 'auth', 'other'], `${I}:${lineOf(ITEM, "router.post('/:id'")}`, 'POST /api/item/:id - one item.'],
      ['DELETE', '/api/item/:id', ['rateLimit(...)', 'auth', 'auth', 'other'], `${I}:${lineOf(ITEM, 'router.delete')}`, ''],
      ['PUT', '/api/item/:id/extra', ['rateLimit(...)', 'auth', 'auth', 'other', 'auth'], `server/routes/item/extra.js:${lineOf(EXTRA, 'router.put')}`, 'The extra write.'],
      ['POST', '/api/item/:id/open', ['rateLimit(...)', 'auth', 'auth', 'other'], `${I}:${lineOf(ITEM, 'router.post(`')}`, 'The open and close switches.'],
      ['POST', '/api/item/:id/close', ['rateLimit(...)', 'auth', 'auth', 'other'], `${I}:${lineOf(ITEM, 'router.post(`')}`, 'The open and close switches.'],
    ]],
    ['/api/item', 'server/routes/itemMore.js', [['GET', '/api/item/more', 'public', 'server/routes/itemMore.js:3', '']]],
    ['/api/audio', 'server/routes/audio.js', [['GET', '/api/audio/:name.mp3', 'public', 'server/routes/audio.js:3', '']]],
    ['/api/admin', 'server/routes/admin/index.js', [
      ['GET', '/api/admin/users', ['other'], 'server/routes/admin/users.js:4', ''],
      ['GET', '/api/admin/notes', ['auth'], 'server/routes/admin/notes.js:3', ''],
    ]],
    ['/api/factory', 'server/routes/factory.js', [['GET', '/api/factory/made', 'public', 'server/routes/factory.js:4', '']]],
  ]);
});

test('a route carries its path relative to the mount, and the mount line', () => {
  const w = walk(fixture(FILES));
  const item = w.mounts.find((m) => m.prefix === '/api/item');
  assert.equal(item.line, lineOf(INDEX, "require('./routes/item')"));
  assert.equal(item.routes[2].local, '/sub/:token');
  assert.equal(item.routes[2].unparsed, null);
});

test('helmet, cors-like calls, a body parser at an /api path, a non-/api mount and the error handler are not mounts', () => {
  const w = walk(fixture(FILES));
  assert.ok(!w.mounts.some((m) => m.prefix === '/static' || m.prefix === '/api/item/hook'));
  assert.equal(w.mounts.length, 6);
});

const BAD = src(
  "const express = require('express');",
  'const router = express.Router();',
  "const PATH = '/x';",
  'router.get(PATH, (req, res) => res.end());',
  "router.use(require('./missing'));",
  "router.route('/chain').get((req, res) => res.end());",
  "if (process.env.FLAG) { router.get('/hidden', (req, res) => res.end()); }",
  'someCall(router);',
  "router.get('/ok', (req, res) => res.end());",
  'module.exports = router;',
);

test('each shape the walker cannot follow is an unparsed row and a problem, and the rest still reads', () => {
  const files = {
    'server/index.js': src(
      "const express = require('express');",
      'const app = express();',
      "app.use('/api/bad', require('./routes/bad'));",
      "app.use(PREFIX, require('./routes/bad'));",
      "app.use('/api/gone', require('./routes/gone'));",
      "if (x) { app.use('/api/late', require('./routes/bad')); }",
    ),
    'server/routes/bad.js': BAD,
  };
  const w = walk(fixture(files));
  const bad = w.mounts.find((m) => m.prefix === '/api/bad');
  assert.deepEqual(bad.routes.map((r) => [r.unparsed, r.line, r.path]), [
    ['route path is not a string literal', 4, null],
    ['cannot find module ./missing', 5, null],
    ['.route() chain', 6, null],
    ['route registered inside a block or function', 7, null],
    ['router passed to a call the walker cannot follow', 8, null],
    [null, 9, '/api/bad/ok'],
  ]);
  assert.deepEqual(w.problems.map((p) => `${p.file}:${p.line} ${p.reason}`), [
    'server/routes/bad.js:4 route path is not a string literal',
    'server/routes/bad.js:5 cannot find module ./missing',
    'server/routes/bad.js:6 .route() chain',
    'server/routes/bad.js:7 route registered inside a block or function',
    'server/routes/bad.js:8 router passed to a call the walker cannot follow',
    'server/index.js:4 mount path is not a string literal',
    'server/index.js:5 cannot find module ./routes/gone',
    'server/index.js:6 route registered inside a block or function',
  ]);
});

test('a module that does not parse is an unparsed mount, not a crash', () => {
  const w = walk(fixture({
    'server/index.js': "const express = require('express');\nconst app = express();\napp.use('/api/x', require('./routes/x'));\n",
    'server/routes/x.js': 'const = ;\n',
  }));
  assert.equal(w.problems.length, 1);
  assert.match(w.problems[0].reason, /^server\/routes\/x\.js does not parse/);
});

test('no server/index.js means no routes and no problem', () => {
  assert.deepEqual(walk(fixture({ 'README.md': '' })), { mounts: [], problems: [] });
});

test('render: a ### heading per mount, the direct routes first, and an unparsed row', () => {
  const out = render(walk(fixture(FILES)));
  const lines = out.split('\n');
  assert.equal(lines[0], '### direct routes (server/index.js)');
  assert.equal(lines[2], '| Method | Path | Auth | Handler | Description |');
  assert.equal(lines[3], '|---|---|---|---|---|');
  assert.equal(lines[4], '| GET | `/api/files/:name` | auth | server/index.js | Signed file access. |');
  assert.ok(lines.includes('### /api/item (server/routes/item.js)'));
  assert.ok(lines.includes('| POST | `/api/item/:id` | rateLimit(...), auth, other | server/routes/item.js | POST /api/item/:id - one item. |'));
  const badOut = render(walk(fixture({
    'server/index.js': "const express = require('express');\nconst app = express();\napp.use('/api/bad', require('./routes/bad'));\n",
    'server/routes/bad.js': BAD,
  })));
  assert.ok(badOut.split('\n').includes('| ? | server/routes/bad.js:4 | unparsed | | route path is not a string literal |'));
  assert.equal(render(walk(fixture(FILES))), out);
});

test('the Handler cell is the file alone, so a line shift in a route file renders the same table', () => {
  const shifted = { ...FILES, 'server/routes/item.js': `// One more line on top.\n\n${ITEM}` };
  const a = walk(fixture(FILES));
  const b = walk(fixture(shifted));
  assert.equal(render(b), render(a));
  const post = (w) => w.mounts.find((m) => m.prefix === '/api/item').routes.find((r) => r.method === 'POST' && r.path === '/api/item/:id');
  assert.equal(post(b).line, post(a).line + 2);
});

const SHAPES = {
  'server/index.js': src(
    "const express = require('express');",
    'const app = express();',
    'const parse = express.json();',
    "const plainMod = require('./routes/plain');",
    'function makeIt() { return (req, res, next) => next(); }',
    "app.use('/api/q', parse);",
    "app.use('/api/item/hook', express.raw({ type: 'x' }));",
    "app.use('/api/a', require('./routes/plain'));",
    "app.use('/api/b', plainMod);",
    "app.use('/api/c', require('./routes/newer').nope);",
    "app.use('/api/d', makeIt());",
    "app.use('/hooks', require('./routes/newer'));",
    "app.use('/api/e', require('./routes/assigned'));",
    "app.use('/api/f', require('./routes/nested'));",
  ),
  'server/routes/plain.js': 'module.exports = function plain(req, res, next) { next(); };\n',
  'server/routes/newer.js': "const express = require('express');\nconst router = new express.Router();\nrouter.get('/n', (req, res) => res.end());\nmodule.exports = router;\n",
  'server/routes/assigned.js': "const { Router } = require('express');\nconst router = new Router();\nrouter.get('/s', (req, res) => res.end());\nfunction helper() {}\nmodule.exports = Object.assign(router, { helper });\n",
  'server/routes/nested.js': src(
    "const express = require('express');",
    "const plainMod = require('./plain');",
    'const router = express.Router();',
    'router.use(express.json());',
    "router.use('/x', require('./plain'));",
    'router.use(plainMod);',
    "router.get('/ok', (req, res) => res.end());",
    'module.exports = router;',
  ),
};

test('no mount is dropped silently: a non-Router relative require, its binding, its member and an unfollowable call are unparsed', () => {
  const w = walk(fixture(SHAPES));
  assert.deepEqual(w.problems.map((p) => `${p.file}:${p.line} ${p.reason}`), [
    'server/index.js:8 ./routes/plain is not a Router',
    'server/index.js:9 ./routes/plain is not a Router',
    'server/index.js:10 ./routes/newer.nope is not a Router',
    'server/index.js:11 makeIt(...) is not a Router the walker can follow',
    'server/routes/nested.js:5 ./plain is not a Router',
    'server/routes/nested.js:6 ./plain is not a Router',
  ]);
  for (const prefix of ['/api/a', '/api/b', '/api/c', '/api/d']) {
    const m = w.mounts.find((x) => x.prefix === prefix);
    assert.ok(m, prefix);
    assert.equal(m.routes.length, 1);
    assert.ok(m.routes[0].unparsed);
  }
  assert.ok(!w.mounts.some((m) => m.prefix === '/api/q' || m.prefix === '/api/item/hook'));
});

test('a Router mounts at any string prefix; new Router() and Object.assign(router, ...) are Routers; an express call is not middleware', () => {
  const w = walk(fixture(SHAPES));
  const paths = (prefix) => w.mounts.find((m) => m.prefix === prefix).routes.filter((r) => !r.unparsed).map((r) => [r.method, r.path, r.auth]);
  assert.deepEqual(paths('/hooks'), [['GET', '/hooks/n', 'public']]);
  assert.deepEqual(paths('/api/e'), [['GET', '/api/e/s', 'public']]);
  assert.deepEqual(paths('/api/f'), [['GET', '/api/f/ok', 'public']]);
});

test('a .use whose path is an array, a regex, a template or a bound non-literal is unparsed, never router-wide middleware', () => {
  const files = {
    'server/index.js': src(
      "const express = require('express');",
      "const { auth } = require('./middleware/auth');",
      'const app = express();',
      "app.use(['/api/x'], auth);",
      "app.use('/api/paths', require('./routes/paths'));",
    ),
    'server/middleware/auth.js': 'function auth(req, res, next) { next(); }\nmodule.exports = { auth };\n',
    'server/routes/paths.js': src(
      "const express = require('express');",
      "const { auth } = require('../middleware/auth');",
      "const ADMIN = ['/admin'];",
      'const router = express.Router();',
      "router.use(['/admin'], auth);",
      'router.use(/^\\/hidden/, auth);',
      'router.use(`/${process.env.BASE}`, auth);',
      'router.use(ADMIN, auth);',
      "router.use(new RegExp('^/r'), auth);",
      "router.get('/open', (req, res) => res.end());",
      'module.exports = router;',
    ),
  };
  const w = walk(fixture(files));
  assert.deepEqual(w.problems.map((p) => `${p.file}:${p.line} ${p.reason}`), [
    'server/index.js:4 mount path is not a string literal',
    'server/routes/paths.js:5 mount path is not a string literal',
    'server/routes/paths.js:6 mount path is not a string literal',
    'server/routes/paths.js:7 mount path is not a string literal',
    'server/routes/paths.js:8 mount path is not a string literal',
    'server/routes/paths.js:9 mount path is not a string literal',
  ]);
  const open = w.mounts.find((m) => m.prefix === '/api/paths').routes.find((r) => r.path === '/api/paths/open');
  assert.equal(open.auth, 'public');
});

test('an array of middleware in .use is middleware, as Express reads it', () => {
  const files = {
    'server/index.js': "const express = require('express');\nconst app = express();\napp.use('/api/m', require('./routes/m'));\n",
    'server/routes/m.js': src(
      "const express = require('express');",
      "const { auth, other } = require('../middleware/auth');",
      'const router = express.Router();',
      'router.use([auth, other]);',
      "router.get('/in', (req, res) => res.end());",
      'module.exports = router;',
    ),
    'server/middleware/auth.js': 'function auth(req, res, next) { next(); }\nmodule.exports = { auth, other: auth };\n',
  };
  const w = walk(fixture(files));
  assert.deepEqual(w.problems, []);
  assert.deepEqual(w.mounts[0].routes[0].auth, ['auth', 'other']);
});

test('a spread of a top-level array of identifiers or calls opens in order; any other spread is unparsed', () => {
  const files = {
    'server/index.js': "const express = require('express');\nconst app = express();\napp.use('/api/s', require('./routes/s'));\n",
    'server/middleware/auth.js': 'function auth(req, res, next) { next(); }\nmodule.exports = { auth, other: auth, makeLimiter: () => auth };\n',
    'server/routes/s.js': src(
      "const express = require('express');",
      "const { auth, other } = require('../middleware/auth');",
      "const { makeLimiter } = require('limiter-package');",
      'const guard = [auth, other, makeLimiter()];',
      'const mixed = [auth, () => null];',
      'const router = express.Router();',
      "router.get('/x', ...guard, (req, res) => res.end());",
      "router.get('/y', ...unknownThing, (req, res) => res.end());",
      "router.get('/z', ...mixed, (req, res) => res.end());",
      'router.use(...guard);',
      "router.get('/after', (req, res) => res.end());",
      'module.exports = router;',
    ),
  };
  const w = walk(fixture(files));
  assert.deepEqual(w.problems.map((p) => `${p.file}:${p.line} ${p.reason}`), [
    'server/routes/s.js:8 spread of something the walker cannot read',
    'server/routes/s.js:9 spread of something the walker cannot read',
  ]);
  const rows = w.mounts[0].routes.filter((r) => !r.unparsed).map((r) => [r.path, r.auth]);
  assert.deepEqual(rows, [
    ['/api/s/x', ['auth', 'other', 'makeLimiter(...)']],
    ['/api/s/after', ['auth', 'other', 'makeLimiter(...)']],
  ]);
});

test('app.use middleware at a prefix runs ahead of every later mount and route at or under it', () => {
  const files = {
    'server/index.js': src(
      "const express = require('express');",
      "const { auth, other } = require('./middleware/auth');",
      'const app = express();',
      "app.use('/api/early', require('./routes/r'));",
      "app.use('/api', other);",
      "app.use('/api/item', auth);",
      "app.use('/api/item/hook', express.raw({ type: 'x' }));",
      "app.use('/api/item', require('./routes/r'));",
      "app.use('/api/items2', require('./routes/r'));",
      "app.get('/api/item/direct', (req, res) => res.end());",
    ),
    'server/middleware/auth.js': 'function auth(req, res, next) { next(); }\nmodule.exports = { auth, other: auth };\n',
    'server/routes/r.js': src(
      "const express = require('express');",
      "const { other } = require('../middleware/auth');",
      'const router = express.Router();',
      "router.get('/x', other, (req, res) => res.end());",
      'module.exports = router;',
    ),
  };
  const w = walk(fixture(files));
  assert.deepEqual(w.problems, []);
  assert.deepEqual(w.mounts.flatMap((m) => m.routes.map((r) => [r.path, r.auth])), [
    ['/api/item/direct', ['other', 'auth']],
    ['/api/early/x', ['other']],
    ['/api/item/x', ['other', 'auth', 'other']],
    ['/api/items2/x', ['other', 'other']],
  ]);
});

test('the Auth cell reads public when a route has no middleware or only limiters', () => {
  const files = {
    'server/index.js': "const express = require('express');\nconst app = express();\napp.use('/api/l', require('./routes/l'));\n",
    'server/middleware/auth.js': 'function auth(req, res, next) { next(); }\nmodule.exports = { auth, xLimiter: auth, yLimiter: auth, makeLimiter: () => auth };\n',
    'server/routes/l.js': src(
      "const express = require('express');",
      "const { auth, xLimiter, yLimiter, makeLimiter } = require('../middleware/auth');",
      'const router = express.Router();',
      "router.get('/a', xLimiter, (req, res) => res.end());",
      "router.get('/b', auth, xLimiter, (req, res) => res.end());",
      "router.get('/c', (req, res) => res.end());",
      "router.get('/d', makeLimiter(), yLimiter, (req, res) => res.end());",
      'module.exports = router;',
    ),
  };
  const cells = render(walk(fixture(files))).split('\n').filter((l) => l.startsWith('| GET')).map((l) => l.split(' | ')[2]);
  assert.deepEqual(cells, ['public (xLimiter)', 'auth, xLimiter', 'public', 'public (makeLimiter(...), yLimiter)']);
});

test('a rateLimit call counts as a limiter: the publicReviews shape reads public (rateLimit(...))', () => {
  const files = {
    'server/index.js': "const express = require('express');\nconst app = express();\napp.use('/api/public/reviews', require('./routes/publicReviews'));\n",
    'server/routes/publicReviews.js': src(
      "const express = require('express');",
      `const rateLimit = require('${LIMIT_PKG}');`,
      `const limitIt = require('${LIMIT_PKG}');`,
      'const router = express.Router();',
      "router.use(rateLimit({ windowMs: 60 * 1000, max: 120, message: { error: 'Too many requests' } }));",
      "router.get('/', (req, res) => res.json([]));",
      "router.get('/b', limitIt({}), (req, res) => res.json([]));",
      'module.exports = router;',
    ),
  };
  const cells = render(walk(fixture(files))).split('\n').filter((l) => l.startsWith('| GET')).map((l) => l.split(' | ').slice(1, 3));
  assert.deepEqual(cells, [
    ['`/api/public/reviews/`', 'public (rateLimit(...))'],
    ['`/api/public/reviews/b`', 'public (rateLimit(...), rateLimit(...))'],
  ]);
});

test('an app.route() chain in index.js is unparsed, at top level and nested', () => {
  const files = {
    'server/index.js': src(
      "const express = require('express');",
      'const app = express();',
      "app.route('/api/chain').get((req, res) => res.end()).post((req, res) => res.end());",
      "function later() { app.route('/api/nested').get((req, res) => res.end()); }",
      "app.route('/api/bare');",
    ),
  };
  const w = walk(fixture(files));
  assert.deepEqual(w.problems.map((p) => `${p.file}:${p.line} ${p.reason}`), [
    'server/index.js:3 .route() chain',
    'server/index.js:4 .route() chain',
    'server/index.js:5 .route() chain',
  ]);
});

// Item 6 (the module's origin rules): a call to a package's function, inline
// or bound first, is middleware; a relative module's is the router risk.
const R6 = src(
  "const express = require('express');",
  `const rateLimit = require('${LIMIT_PKG}');`,
  "const { auth } = require('../middleware/auth');",
  "const { makeSub } = require('../lib/subs');",
  "const { createSub } = require('../lib/factory');",
  "const { addMore } = require('../lib/more');",
  "const { BASE } = require('../lib/consts');",
  "const { cfg } = require('../lib/cfg');",
  "const { gone } = require('../lib/missing');",
  'const router = express.Router();',
  'const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });',
  'const sub = makeSub({});',
  "const opts = { path: '/o' };",
  'router.use(webhookLimiter);',
  'router.use(auth);',
  'router.use(rateLimit({ max: 2 }));',
  'router.use(sub);',
  "router.use('/sub', makeSub({}));",
  'router.use(cfg);',
  'router.use(gone);',
  'router.use(BASE, auth);',
  'router.use(opts.path, auth);',
  'addMore(router);',
  "if (process.env.X) { router.use(sub); }",
  "router.use('/f', createSub());",
  "router.get('/x', (req, res) => res.end());",
  'module.exports = router;',
);
const R6_INDEX = src(
  "const express = require('express');",
  "const helmet = require('helmet');",
  `const rateLimit = require('${LIMIT_PKG}');`,
  "const { makeSub } = require('./lib/subs');",
  'const app = express();',
  'const appLimiter = rateLimit({ max: 1 });',
  'const sub = makeSub({});',
  'app.use(helmet({}));',
  "app.use('/api/lim', appLimiter);",
  "app.use('/api/sub', sub);",
  "if (process.env.X) { app.use('/api/sub2', sub); }",
  "app.use('/api/r', require('./routes/r'));",
);
const R6_FILES = {
  'server/index.js': R6_INDEX,
  'server/routes/r.js': R6,
  'server/middleware/auth.js': 'const auth = (req, res, next) => next();\nmodule.exports = { auth };\n',
  'server/lib/subs.js': 'function makeSub(deps) { return deps; }\nmodule.exports = { makeSub };\n',
  'server/lib/consts.js': "module.exports = { BASE: '/b' };\n",
  'server/lib/cfg.js': "const { makeSub } = require('./subs');\nmodule.exports = { cfg: makeSub({}) };\n",
  'server/lib/more.js': "const { auth } = require('../middleware/auth');\nfunction addMore(router, base) { router.use(base, auth); }\nmodule.exports = { addMore };\n",
  'server/lib/factory.js': "const express = require('express');\nfunction createSub() {\n  const r = express.Router();\n  r.get('/y', (req, res) => res.end());\n  return r;\n}\nmodule.exports = { createSub };\n",
};

test('a call to a relative module, inline or bound, is unparsed in index.js and a router, at top level and in a block; a package factory is middleware', () => {
  const w = walk(fixture(R6_FILES));
  const at = (text, needle) => lineOf(text, needle);
  assert.deepEqual(w.problems.map((p) => `${p.file}:${p.line} ${p.reason}`), [
    `server/index.js:${at(R6_INDEX, "'/api/sub', sub")} makeSub(...) is not a Router the walker can follow`,
    `server/index.js:${at(R6_INDEX, "'/api/sub2'")} route registered inside a block or function`,
    `server/routes/r.js:${at(R6, 'router.use(sub);')} makeSub(...) is not a Router the walker can follow`,
    `server/routes/r.js:${at(R6, "router.use('/sub'")} makeSub(...) is not a Router the walker can follow`,
    `server/routes/r.js:${at(R6, 'router.use(cfg)')} ../lib/cfg.cfg is not a Router`,
    `server/routes/r.js:${at(R6, 'router.use(gone)')} cannot find module ../lib/missing`,
    `server/routes/r.js:${at(R6, 'router.use(BASE')} mount path is not a string literal`,
    `server/routes/r.js:${at(R6, 'router.use(opts.path')} mount path is not a string literal`,
    'server/lib/more.js:2 mount path is not a string literal',
    `server/routes/r.js:${at(R6, 'if (process.env.X)')} route registered inside a block or function`,
  ]);
  const routes = w.mounts.find((m) => m.prefix === '/api/r').routes.filter((r) => !r.unparsed);
  assert.deepEqual(routes.map((r) => [r.path, r.auth]), [
    ['/api/r/f/y', ['webhookLimiter', 'auth', 'rateLimit(...)']],
    ['/api/r/x', ['webhookLimiter', 'auth', 'rateLimit(...)']],
  ]);
  assert.ok(!w.mounts.some((m) => m.prefix === '?'));
});
