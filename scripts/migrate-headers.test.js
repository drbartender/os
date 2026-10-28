'use strict';

// Suite for scripts/migrate-headers.js, the CLI run in throwaway git repos
// under the temp dir: headers (every insertion shape, the generated forms, the
// dry run, the dropped list, the refusals), route-rows and route-notes (every
// reason, the write, the rerun), env-draft and env-check, and argv misuse.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const k of Object.keys(process.env)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES)$/.test(k)) delete process.env[k];
}
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const { readHeader } = require('./lib/genDocs/headers');
const { compareFile } = require('./lib/commentOnly');

const CLI = path.join(__dirname, 'migrate-headers.js');
const EM = '\u2014';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
const lines = (...l) => l.join('\n');

function repo(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-headers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', ['test', 'example.com'].join('@'));
  git(dir, 'config', 'user.name', 'Test User');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const LONG = 'Reads the item list for the signed-in user and folds the archived rows in when asked, with the `?archived=true` flag the client sends';

const TREE = lines(
  '# Fixture',
  '',
  '## Folder Structure',
  '',
  '```',
  'fixture/',
  '├── server/',
  '│   ├── index.js                # Express app setup',
  '│   ├── bin/',
  '│   │   └── tool.js             # The command-line tool',
  '│   ├── utils/                  # Shared helpers',
  `│   │   ├── strict.js           # Strict-mode helper ${EM} small`,
  '│   │   ├── lint.js             # Lint-disabled helper',
  '│   │   ├── bom.js              # Byte-order-mark helper',
  `│   │   └── long.js             # ${LONG}`,
  '│   └── routes/',
  '│       └── items.js            # Item endpoints',
  '├── client/',
  '│   └── src/',
  '│       ├── components/         # Shared pieces,',
  '│       │                       # Card and Widget',
  '│       │   └── Card.jsx        # The item card',
  '│       └── pages/',
  '│           └── (auth)          # Login, Register',
  '└── package.json                # Deps',
  '```',
  '',
);

const HEADER_FILES = {
  'README.md': TREE,
  'package.json': '{}\n',
  'server/index.js': lines('// Express app setup.', "const express = require('express');", 'module.exports = express();', ''),
  'server/bin/tool.js': lines('#!/usr/bin/env node', "const fs = require('fs');", 'fs.existsSync(".");', ''),
  'server/utils/strict.js': lines("'use strict';", '', 'module.exports = { one: 1 };', ''),
  'server/utils/lint.js': lines('/* eslint-disable no-console */', 'console.log(1);', ''),
  'server/utils/bom.js': '\ufeffexport const a = 1;\r\nexport const b = 2;\r\n',
  'server/utils/long.js': lines('module.exports = {};', ''),
  'server/utils/fnDefault.js': lines('module.exports = function build(x) { return x; };', ''),
  'server/utils/nextline.js': lines('// eslint-disable-next-line no-var', 'var x = 1;', 'x += 1;', ''),
  'server/utils/has.js': lines('// Already described.', 'module.exports = 1;', ''),
  'server/utils/has.test.js': lines("const test = require('node:test');", "test('x', () => {});", ''),
  'server/routes/items.js': lines("const router = require('express').Router();", "router.get('/', (req, res) => res.json([]));", 'module.exports = router;', ''),
  'client/src/components/Card.jsx': lines("import React from 'react';", 'export default function Card() {', '  return <div />;', '}', ''),
  'client/src/components/Widget.js': lines('const Widget = () => <span />;', 'export default Widget;', ''),
  'client/src/utils/fmt.js': lines('export const pad = (s) => s;', 'export function trim(s) { return s; }', ''),
  'client/src/main.js': lines("import { render } from 'react-dom';", "render(null, document.getElementById('root'));", ''),
};

test('headers: the dry run prints the counts and writes nothing; --dropped writes the directory lines', (t) => {
  const dir = repo(t, HEADER_FILES);
  const drop = path.join(dir, '..', `${path.basename(dir)}-dropped.txt`);
  t.after(() => fs.rmSync(drop, { force: true }));
  const r = run(dir, 'headers', '--dropped', drop);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^described: 7, generated: 5, skipped \(has header\): 2, dropped files: 1$/m);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.deepEqual(read(path.dirname(drop), path.basename(drop)).split('\n'), [
    'server/utils/: Shared helpers',
    'client/src/components/: Shared pieces,',
    'client/src/components/: Card and Widget',
    'client/src/pages/(auth): Login, Register',
    'package.json: Deps',
    '',
  ]);
});

test('headers --write: every insertion shape, the generated forms, each file proved comment-only', (t) => {
  const dir = repo(t, HEADER_FILES);
  const r = run(dir, 'headers', '--write');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^written: 12 files$/m);
  assert.equal(read(dir, 'server/bin/tool.js'), lines('#!/usr/bin/env node', '// The command-line tool', '', "const fs = require('fs');", 'fs.existsSync(".");', ''));
  assert.equal(read(dir, 'server/utils/strict.js'), lines("'use strict';", '', '// Strict-mode helper - small', '', 'module.exports = { one: 1 };', ''));
  assert.equal(read(dir, 'server/utils/lint.js'), lines('/* eslint-disable no-console */', '// Lint-disabled helper', '', 'console.log(1);', ''));
  assert.equal(read(dir, 'server/utils/bom.js'), '\ufeff// Byte-order-mark helper\r\n\r\nexport const a = 1;\r\nexport const b = 2;\r\n');
  assert.equal(read(dir, 'client/src/components/Card.jsx').split('\n').slice(0, 3).join('\n'), lines('// The item card', '', "import React from 'react';"));
  const next = read(dir, 'server/utils/nextline.js').split('\n');
  assert.ok(next[0].startsWith('// nextline.js: entry point, no exports.'), 'the header goes above the next-line directive');
  assert.deepEqual(next.slice(next.indexOf('var x = 1;') - 2, next.indexOf('var x = 1;') + 1), ['', '// eslint-disable-next-line no-var', 'var x = 1;']);
  const long = read(dir, 'server/utils/long.js').split('\n');
  assert.ok(long[0].startsWith('// Reads the item list') && long[1].startsWith('// '), 'a long description wraps');
  assert.ok(long.every((l) => l.length <= 100));
  assert.equal(readHeader(read(dir, 'server/utils/long.js'), '.js').description, LONG);
  const gen = (rel) => readHeader(read(dir, rel), path.extname(rel)).description;
  assert.match(gen('client/src/components/Widget.js'), /^Widget \(React component, default export\)\. Header generated from the file's exports by migrate-headers on \d{4}-\d{2}-\d{2}; replace with what it does\.$/);
  assert.match(gen('client/src/utils/fmt.js'), /^Exports pad, trim\. Header generated /);
  assert.match(gen('server/utils/fnDefault.js'), /^build \(default export\)\. Header generated /);
  assert.match(gen('client/src/main.js'), /^main\.js: entry point, no exports\. Header generated /);
  assert.equal(read(dir, 'server/utils/has.js'), HEADER_FILES['server/utils/has.js']);
  assert.equal(read(dir, 'server/utils/has.test.js'), HEADER_FILES['server/utils/has.test.js']);
  const changed = git(dir, 'diff', '--name-only').split('\n');
  assert.equal(changed.length, 12);
  for (const rel of changed) {
    assert.equal(readHeader(read(dir, rel), path.extname(rel)).present, true, rel);
    assert.equal(compareFile(HEADER_FILES[rel], read(dir, rel), rel).ok, true, rel);
  }
  assert.ok(!git(dir, 'diff').includes(EM));
  const again = run(dir, 'headers');
  assert.match(again.out, /^described: 0, generated: 0, skipped \(has header\): 14, dropped files: 1$/m);
});

test('headers reads README at HEAD by default and --readme from a path', (t) => {
  const dir = repo(t, HEADER_FILES);
  fs.writeFileSync(path.join(dir, 'README.md'), TREE.replace('# The command-line tool', ''));
  assert.match(run(dir, 'headers').out, /^described: 7, generated: 5,/m);
  assert.match(run(dir, 'headers', '--readme', 'README.md').out, /^described: 6, generated: 6,/m);
});

test('headers refuses a header that would read as a directive or pass 1,000 lines, and exits 1', (t) => {
  const tree = TREE.replace('# Strict-mode helper', '# globals for the page');
  const dir = repo(t, { ...HEADER_FILES, 'README.md': tree, 'server/utils/big.js': `${'x();\n'.repeat(999)}` });
  const r = run(dir, 'headers', '--write');
  assert.equal(r.code, 1);
  assert.match(r.err, /^not written \(would not prove comment-only\): server\/utils\/strict\.js$/m);
  assert.match(r.err, /^not written \(file would pass 1,000 lines\): server\/utils\/big\.js$/m);
  assert.match(r.out, /^not written: 2 \(listed on stderr\)$/m);
  assert.equal(read(dir, 'server/utils/strict.js'), HEADER_FILES['server/utils/strict.js']);
});

// ---- routes ------------------------------------------------------------------

const OVER = `${'a long sentence about the item '.repeat(15)}end`;
const ARCH = lines(
  '# Architecture',
  '',
  '## API Routes',
  '',
  `### Items ${EM} \`/api/items\``,
  '| Method | Path | Auth | Description |',
  '|---|---|---|---|',
  '| GET | `/` | Yes | Lists items \\| newest first |',
  '| GET | `/:id` | Yes | Reads one |',
  `| POST | \`/\` | Admin | ${OVER} |`,
  '| DELETE | `/:id` | Admin | Removes one item |',
  '| PUT | `/missing` | Admin | No handler |',
  '| GET | `/dup` | Yes | Registered twice |',
  '',
  `Prose for the items ${EM} mount.`,
  '',
  `### Big ${EM} \`/api/big\``,
  '| Method | Path | Auth | Description |',
  '|---|---|---|---|',
  '| GET | `/` | Yes | Near the cap |',
  '',
  '## Database Schema',
  '',
);

const ITEMS = lines(
  '// Item endpoints.',
  "const express = require('express');",
  'const router = express.Router();',
  '',
  "router.get('/', (req, res) => res.json([]));",
  '',
  '// Reads one item.',
  "router.get('/:id', (req, res) => res.json({}));",
  '',
  "router.post('/', (req, res) => res.json({}));",
  '',
  '// eslint-disable-next-line no-unused-vars',
  "router.delete('/:id', (req, res, next) => res.json({}));",
  "router.get('/dup', (req, res) => res.json(1));",
  "router.get('/dup', (req, res) => res.json(2));",
  '',
  'module.exports = router;',
  '',
);

const BIG = lines(
  '// Big router.',
  "const router = require('express').Router();",
  ...Array.from({ length: 996 }, (_, k) => `const v${k} = ${k};`),
  "router.get('/', (req, res) => res.json([]));",
  'module.exports = router;',
  '',
);

const ROUTE_FILES = {
  'ARCHITECTURE.md': ARCH,
  'server/index.js': lines(
    '// Express app setup.',
    "const express = require('express');",
    'const app = express();',
    "app.use('/api/items', require('./routes/items'));",
    "app.use('/api/big', require('./routes/big'));",
    'module.exports = app;',
    '',
  ),
  'server/routes/items.js': ITEMS,
  'server/routes/big.js': BIG,
};

const COUNTS = lines('moved: 2, left: 5', '  no match: 1', '  more than one: 1', '  handler commented: 1', '  over max: 1', '  file at cap: 1');

test('route-rows: the dry run prints moved and left by reason and writes nothing', (t) => {
  const dir = repo(t, ROUTE_FILES);
  const r = run(dir, 'route-rows');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), COUNTS);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  const wide = run(dir, 'route-rows', '--max-chars', '2000');
  assert.match(wide.out, /^moved: 3, left: 4$/m);
});

test('route-rows --write: unescaped comments directly above the handlers, proved; a rerun writes nothing', (t) => {
  const dir = repo(t, ROUTE_FILES);
  const r = run(dir, 'route-rows', '--write');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^written: 2 comments in 1 files$/m);
  const items = read(dir, 'server/routes/items.js').split('\n');
  const at = (s) => items.indexOf(s);
  assert.equal(items[at("router.get('/', (req, res) => res.json([]));") - 1], '// Lists items | newest first');
  assert.deepEqual(items.slice(at('// eslint-disable-next-line no-unused-vars') - 1, at('// eslint-disable-next-line no-unused-vars') + 2), [
    '// Removes one item',
    '// eslint-disable-next-line no-unused-vars',
    "router.delete('/:id', (req, res, next) => res.json({}));",
  ]);
  assert.equal(compareFile(ITEMS, read(dir, 'server/routes/items.js'), 'server/routes/items.js').ok, true);
  assert.equal(read(dir, 'server/routes/big.js'), BIG);
  const again = run(dir, 'route-rows', '--write');
  assert.equal(again.out.trim(), `${COUNTS}\nwritten: 0 comments in 0 files`);
  assert.equal(git(dir, 'diff', '--stat').split('\n').length, 2);
});

test('route-notes: refuses with the count before the write; after it, the left rows and the prose and nothing else', (t) => {
  const dir = repo(t, ROUTE_FILES);
  const expected = lines(
    '### Items - `/api/items`',
    '',
    '- **GET /api/items/:id** (Yes): Reads one',
    `- **POST /api/items** (Admin): ${OVER}`,
    '- **PUT /api/items/missing** (Admin): No handler',
    '- **GET /api/items/dup** (Yes): Registered twice',
    '',
    'Prose for the items - mount.',
    '',
    '### Big - `/api/big`',
    '',
    '- **GET /api/big** (Yes): Near the cap',
    '',
  );
  const before = run(dir, 'route-notes');
  assert.equal(before.code, 1);
  assert.equal(before.out, '');
  assert.equal(before.err, '2 row(s) would move but are not written: run route-rows --write first\n');
  run(dir, 'route-rows', '--write');
  const after = run(dir, 'route-notes');
  assert.equal(after.code, 0, after.err);
  assert.equal(after.out, expected);
  assert.ok(!after.out.includes('Lists items') && !after.out.includes('Removes one item'), 'the moved rows are absent');
});

test('route-rows reads ARCHITECTURE at HEAD by default and --arch from a path', (t) => {
  const dir = repo(t, ROUTE_FILES);
  fs.writeFileSync(path.join(dir, 'ARCHITECTURE.md'), ARCH.replace('| PUT | `/missing` | Admin | No handler |\n', ''));
  assert.match(run(dir, 'route-rows').out, /^moved: 2, left: 5$/m);
  assert.match(run(dir, 'route-rows', '--arch', 'ARCHITECTURE.md').out, /^moved: 2, left: 4$/m);
});

// ---- env ---------------------------------------------------------------------

const ENV_README = lines(
  '## Environment Variables',
  '',
  '| Variable | Required | Description |',
  '|---|---|---|',
  '| `PORT` | No | Server port (default: 5000) |',
  '| `UPLOAD_KEY` | For uploads | Storage key |',
  '| `DATABASE_URL` | Yes | Connection string |',
  '| `ABSENT_ONE` | No | Not in the template |',
  '',
);
const ENV_CLAUDE = lines('## Environment Variables', '', '| Variable | Purpose |', '|---|---|', '| `DATABASE_URL` | Postgres connection string |', '');
const ENV_FILE = lines('# Server', 'PORT=5000', '', '# Storage', 'UPLOAD_KEY=', '', '# Database', 'DATABASE_URL=x', '');
const ENV_FILES = { 'README.md': ENV_README, '.claude/CLAUDE.md': ENV_CLAUDE, '.env.example': ENV_FILE };

test('env-draft writes the labelled draft to --out and lists the table variables the file lacks', (t) => {
  const dir = repo(t, ENV_FILES);
  const r = run(dir, 'env-draft', '--out', 'draft.txt');
  assert.equal(r.code, 0, r.err);
  assert.equal(r.err, 'not in .env.example: ABSENT_ONE (README)\n');
  assert.equal(read(dir, 'draft.txt'), lines(
    '# Server',
    '# [README] Server port (default: 5000)',
    'PORT=5000',
    '',
    '# Storage',
    '# Required for uploads.',
    '# [README] Storage key',
    'UPLOAD_KEY=',
    '',
    '# Database',
    '# Required.',
    '# [README] Connection string',
    '# [CLAUDE.md] Postgres connection string',
    'DATABASE_URL=x',
    '',
  ));
  assert.equal(read(dir, '.env.example'), ENV_FILE);
});

test('env-check: exit 1 naming each miss, exit 0 once every token is in its block', (t) => {
  const dir = repo(t, ENV_FILES);
  const r = run(dir, 'env-check');
  assert.equal(r.code, 1);
  assert.equal(r.out, lines('PORT: 5000', 'UPLOAD_KEY: required', 'UPLOAD_KEY: for', 'UPLOAD_KEY: uploads', 'DATABASE_URL: required', 'ABSENT_ONE: not in .env.example', ''));
  assert.match(r.err, /^env-check: 6 misses in 4 variables$/m);
  const readme = ENV_README.replace('| `ABSENT_ONE` | No | Not in the template |\n', '');
  fs.writeFileSync(path.join(dir, 'README.ported.md'), readme);
  fs.writeFileSync(path.join(dir, '.env.example'), lines(
    '# Server',
    '',
    '# Server port (default: 5000)',
    'PORT=5000',
    '# Required for uploads. Storage key.',
    'UPLOAD_KEY=',
    '# Required. Connection string; Postgres connection string.',
    'DATABASE_URL=x',
    '',
  ));
  const ok = run(dir, 'env-check', '--readme', 'README.ported.md');
  assert.equal(ok.code, 0, ok.out);
  assert.equal(ok.out, '');
  assert.match(ok.err, /every token of 4 rows found/);
});

test('env-check prints a phone-shaped token by its last four digits only', (t) => {
  const phone = ['+1', '312', '555', '0188'].join('');
  const readme = ENV_README.replace('Storage key', `Storage line \`${phone}\``);
  const dir = repo(t, { ...ENV_FILES, 'README.md': readme });
  const r = run(dir, 'env-check');
  assert.match(r.out, /^UPLOAD_KEY: phone number ending 0188$/m);
  assert.ok(!r.out.includes(phone.slice(2)));
});

test('argv misuse exits 2 with the usage line', (t) => {
  const dir = repo(t, ENV_FILES);
  for (const args of [[], ['nope'], ['headers', '--arch', 'x'], ['route-rows', '--max-chars', '0'], ['env-draft'], ['headers', '--write', '--write'], ['env-draft', '--out']]) {
    const r = run(dir, ...args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.err, /^usage: /m);
  }
  const missing = run(dir, 'route-rows');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /cannot read ARCHITECTURE\.md at HEAD/);
});
