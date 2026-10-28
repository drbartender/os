'use strict';

// Suite for ARCHITECTURE's route rows and the shared comment writer
// (scripts/lib/migrate/archRows.js): the wrap, the inserts that keep CRLF and a
// BOM, the route section parse, the match rule's every reason, and the notes.

const test = require('node:test');
const assert = require('node:assert/strict');
const arch = require('./archRows');
const { describeComment } = require('../genDocs/headers');

const EM = '\u2014';
const lines = (...l) => l.join('\n');

test('wrapText: lines stay within the width and a code span is never split', () => {
  const text = 'one two three `a span with spaces in it` four five six seven eight nine';
  const out = arch.wrapText(text, 24);
  for (const l of out) {
    if (!l.includes('`')) assert.ok(l.length <= 24, l);
  }
  assert.ok(out.some((l) => l.includes('`a span with spaces in it`')));
  assert.equal(out.join(' '), text);
});

test('wrapText: a unit longer than the width sits alone; a double-backtick span is one unit', () => {
  assert.deepEqual(arch.wrapText('x averyveryverylongword y', 6), ['x', 'averyveryverylongword', 'y']);
  assert.deepEqual(arch.units('a ``b ` c`` d'), ['a', '``b ` c``', 'd']);
  assert.deepEqual(arch.units('an `unclosed span'), ['an', '`unclosed', 'span']);
});

test('wrapText: no line opens with a word ESLint reads as a directive', () => {
  for (const word of ['global', 'globals', 'exported', 'eslint', 'eslint-disable']) {
    const text = `the handler funnels every rejection to the ${word} error middleware here`;
    const out = arch.wrapText(text, 42);
    assert.equal(out.join(' '), text);
    for (const l of out.slice(1)) assert.ok(!l.startsWith(`${word} `), `${word}: ${JSON.stringify(out)}`);
    for (const l of arch.commentLines(text, '', 48)) assert.ok(!/^\/\/ (?:eslint|exported|globals?)(?:\s|$|-)/.test(l), l);
  }
});

test('commentLines: `//` lines at the indent, at most width columns, reading back as the text', () => {
  const text = 'Lists the items for the signed-in user, newest first, with the `?limit=` cap and the cursor the client pages with.';
  const out = arch.commentLines(text, '    ', 60);
  assert.ok(out.length > 1);
  for (const l of out) {
    assert.ok(l.startsWith('    // '));
    assert.ok(l.length <= 60, l);
  }
  assert.equal(describeComment(out), text);
});

test('noEmDash replaces the dash with a spaced hyphen', () => {
  assert.equal(arch.noEmDash(`a ${EM} b${EM}c`), 'a - b - c');
});

test('insertAt keeps CRLF endings and a byte-order mark, and appends at the end', () => {
  const crlf = '\ufeffconst a = 1;\r\nconst b = 2;\r\n';
  assert.equal(arch.insertAt(crlf, 1, ['// note']), '\ufeffconst a = 1;\r\n// note\r\nconst b = 2;\r\n');
  assert.equal(arch.insertAt('x\ny', 2, ['// end']), 'x\ny\n// end\n');
  assert.equal(arch.insertAt('', 0, ['// only']), '// only\n');
  const parts = arch.splitText('a\r\nb\nc');
  assert.equal(arch.joinText(parts), 'a\r\nb\nc');
  assert.equal(parts.eol, '\r\n');
});

test('isDirectiveLine: the ESLint and build comments, not prose', () => {
  assert.ok(arch.isDirectiveLine('  // eslint-disable-next-line no-console'));
  assert.ok(arch.isDirectiveLine('/* eslint-disable */'));
  assert.ok(arch.isDirectiveLine('// global window'));
  assert.ok(arch.isDirectiveLine('/* webpackChunkName: "x" */'));
  assert.ok(!arch.isDirectiveLine('// Global styles for the page'));
  assert.ok(!arch.isDirectiveLine('const x = 1; // eslint-disable-line'));
});

const ARCH = lines(
  '# Architecture',
  '',
  '## API Routes',
  '',
  `### Items ${EM} \`/api/items\``,
  '| Method | Path | Auth | Description |',
  '|---|---|---|---|',
  '| GET | `/` | Yes | List the items |',
  '| POST | `/:id/note` | Admin | Add a note \\| keep the pipe |',
  '| PATCH | `/:id` | Admin | Set a field (`a || b` stays) |',
  '| GET/POST | `/a`, `/b` | Admin | Two at once |',
  '',
  'Prose under the items mount.',
  `It has an em dash ${EM} here.`,
  '',
  '### Item helpers (`/api/items`, spec 2026-01-01)',
  '| Method | Path | Auth | Description |',
  '|---|---|---|---|',
  '| DELETE | `/:id` | Admin | Remove an item |',
  '',
  '### Other',
  '| Method | Path | Auth | Description |',
  '|---|---|---|---|',
  '| GET | `/api/health` | No | Health check |',
  '',
  '### Pages (Client-Side Only)',
  '| Path | Component | Description |',
  '|---|---|---|',
  '| `/` | `HomePage` | Home |',
  '| GET | `/api/files/:name` | Admin | Download a file |',
  '',
  '## Database Schema',
  '| GET | `/never` | No | outside the section |',
);

test('parseArch: mounts, rows, irregular rows, prose and the section bounds', () => {
  const { sections } = arch.parseArch(ARCH);
  assert.deepEqual(sections.map((s) => s.prefix), ['/api/items', '/api/items', '', '']);
  const rows = sections.flatMap((s) => s.items.filter((i) => i.type === 'row'));
  assert.deepEqual(rows.map((r) => `${r.method} ${r.path} ${r.matchable}`), [
    'GET / true',
    'POST /:id/note true',
    'PATCH /:id true',
    'GET/POST `/a`, `/b` false',
    'DELETE /:id true',
    'GET /api/health true',
    'GET /api/files/:name true',
  ]);
  assert.equal(rows[1].description, 'Add a note | keep the pipe');
  assert.equal(rows[2].description, 'Set a field (`a || b` stays)');
  const prose = sections[0].items.filter((i) => i.type === 'prose' && i.text.trim()).map((i) => i.text);
  assert.deepEqual(prose, ['Prose under the items mount.', `It has an em dash ${EM} here.`]);
  const pageProse = sections[3].items.filter((i) => i.type === 'prose' && i.text.trim()).map((i) => i.text);
  assert.deepEqual(pageProse, ['| Path | Component | Description |', '|---|---|---|', '| `/` | `HomePage` | Home |']);
  assert.throws(() => arch.parseArch('# nothing here'), /API Routes/);
});

test('fullPath: a `/` row is the prefix alone, trailing slashes and a query string trimmed', () => {
  assert.equal(arch.fullPath('/api/items', '/'), '/api/items');
  assert.equal(arch.fullPath('/api/items/', '/x/'), '/api/items/x');
  assert.equal(arch.fullPath('', '/api/health'), '/api/health');
  assert.equal(arch.fullPath('/api/items', '/search?q='), '/api/items/search');
});

// A fake walk: each route {method, path, file, line, description}.
function walked(routes) {
  return { mounts: [{ prefix: '/api', routes: routes.map((r) => ({ auth: 'public', unparsed: null, description: '', ...r })) }], problems: [] };
}

function plan(archText, routes, files, maxChars = 400) {
  const { sections } = arch.parseArch(archText);
  return { sections, ...arch.planRows(sections, walked(routes), { maxChars, read: (f) => (f in files ? files[f] : null) }) };
}

const section = (...rows) => lines('## API Routes', `### Items ${EM} \`/api/items\``, '| Method | Path | Auth | Description |', '|---|---|---|---|', ...rows, '## Database Schema');

test('planRows: a row matching one handler moves and is written above it, unescaped', () => {
  const file = lines("'use strict';", '', 'router.get(\'/\', auth, list);', '');
  const p = plan(section('| GET | `/` | Yes | Lists items \\| newest first |'), [{ method: 'GET', path: '/api/items', file: 'r.js', line: 3 }], { 'r.js': file });
  assert.equal(p.decisions[0].status, 'moved');
  const out = arch.applyInserts(file, p.inserts.get('r.js'));
  assert.equal(out, lines("'use strict';", '', '// Lists items | newest first', 'router.get(\'/\', auth, list);', ''));
});

test('planRows: every left reason', () => {
  const big = `${'x();\n'.repeat(999)}router.get('/big', h);\n`;
  const routes = [
    { method: 'GET', path: '/api/items/twice', file: 'a.js', line: 1 },
    { method: 'GET', path: '/api/items/twice', file: 'a.js', line: 2 },
    { method: 'GET', path: '/api/items/loop1', file: 'a.js', line: 3 },
    { method: 'GET', path: '/api/items/loop2', file: 'a.js', line: 3 },
    { method: 'GET', path: '/api/items/commented', file: 'a.js', line: 5, description: 'Already says what it does.' },
    { method: 'GET', path: '/api/items/long', file: 'a.js', line: 6 },
    { method: 'GET', path: '/api/items/big', file: 'big.js', line: 1000 },
  ];
  const p = plan(section(
    '| GET | `/nowhere` | Yes | Not registered |',
    '| GET | `/twice` | Yes | Two handlers |',
    '| GET | `/loop1` | Yes | A loop body |',
    '| GET | `/commented` | Yes | Has a comment |',
    `| GET | \`/long\` | Yes | ${'word '.repeat(90)}|`,
    '| GET | `/big` | Yes | The file is near the cap and this comment does not fit |',
    '| GET/POST | `/a`, `/b` | Yes | Irregular |',
  ), routes, { 'a.js': 'a\nb\nc\nd\ne\nf\n', 'big.js': big });
  assert.deepEqual(p.decisions.map((d) => d.reason), ['no match', 'more than one', 'more than one', 'handler commented', 'over max', 'file at cap', 'no match']);
  assert.deepEqual(arch.counts(p.decisions), { moved: 0, left: 7, byReason: { 'no match': 2, 'more than one': 2, 'handler commented': 1, 'over max': 1, 'file at cap': 1 } });
});

test('planRows: --max-chars moves the bar; a second row for a taken handler is left', () => {
  const routes = [{ method: 'GET', path: '/api/items', file: 'a.js', line: 1 }];
  const two = section('| GET | `/` | Yes | First words |', '| GET | `/` | Yes | Second words |');
  const p = plan(two, routes, { 'a.js': 'router.get(\'/\', h);\n' }, 5);
  assert.deepEqual(p.decisions.map((d) => d.reason), ['over max', 'over max']);
  const q = plan(two, routes, { 'a.js': 'router.get(\'/\', h);\n' });
  assert.deepEqual(q.decisions.map((d) => d.status), ['moved', 'left']);
  assert.equal(q.decisions[1].reason, 'handler commented');
});

test('planRows: a row already above its handler is moved and done (the run is idempotent)', () => {
  const routes = [{ method: 'GET', path: '/api/items', file: 'a.js', line: 2, description: 'Lists items, newest first' }];
  const p = plan(section('| GET | `/` | Yes | Lists items, newest first |'), routes, { 'a.js': '// Lists items, newest first\nrouter.get(\'/\', h);\n' });
  assert.equal(p.decisions[0].status, 'moved');
  assert.equal(p.decisions[0].done, true);
  assert.equal(p.inserts.size, 0);
});

test('applyInserts: above a directive directly over the statement, at its indent, bottom first', () => {
  const file = lines('function wire(router) {', '  // eslint-disable-next-line no-unused-vars', '  router.get(\'/a\', h);', '', '  router.get(\'/b\', h);', '}', '');
  const out = arch.applyInserts(file, [{ line: 3, lines: ['  // A'] }, { line: 5, lines: ['  // B one', '  // B two'] }]);
  assert.equal(out, lines('function wire(router) {', '  // A', '  // eslint-disable-next-line no-unused-vars', '  router.get(\'/a\', h);', '', '  // B one', '  // B two', '  router.get(\'/b\', h);', '}', ''));
});

test('renderNotes: the left rows under their headings, then the prose, no em dash', () => {
  const routes = [{ method: 'GET', path: '/api/items', file: 'a.js', line: 2, description: 'List the items' }];
  const { sections } = arch.parseArch(ARCH);
  const p = arch.planRows(sections, walked(routes), { maxChars: 400, read: () => '// List the items\nrouter.get(\'/\', h);\n' });
  const notes = arch.renderNotes(sections, p.decisions);
  assert.ok(!notes.includes(EM));
  assert.ok(!notes.includes('List the items'), 'a row whose comment is on disk is not in the notes');
  const pending = arch.planRows(sections, walked([{ method: 'GET', path: '/api/items', file: 'a.js', line: 1 }]), { maxChars: 400, read: () => 'router.get(\'/\', h);\n' });
  assert.equal(pending.decisions[0].status, 'moved');
  assert.ok(arch.renderNotes(sections, pending.decisions).includes('- **GET /api/items** (Yes): List the items'), 'a row not yet written stays in the notes');
  assert.ok(notes.startsWith('### Items - `/api/items`\n\n- **POST /api/items/:id/note** (Admin): Add a note | keep the pipe\n'));
  assert.ok(notes.includes('- **GET/POST /api/items `/a`, `/b`** (Admin): Two at once\n\nProse under the items mount.\nIt has an em dash - here.\n'));
  assert.ok(notes.includes('### Other\n\n- **GET /api/health** (No): Health check\n'));
  assert.ok(notes.includes('### Pages (Client-Side Only)\n\n- **GET /api/files/:name** (Admin): Download a file\n\n| Path | Component | Description |\n'));
  assert.ok(!notes.includes('| Method | Path |'));
  assert.ok(!notes.includes('/never'));
});

test('planRows: a file at exactly 1,000 lines after the insert still takes it', () => {
  const routes = [{ method: 'GET', path: '/api/items', file: 'b.js', line: 999 }];
  const file = `${'x();\n'.repeat(998)}router.get('/', h);\n`;
  const p = plan(section('| GET | `/` | Yes | Fits exactly |'), routes, { 'b.js': file });
  assert.equal(p.decisions[0].status, 'moved');
  assert.equal(arch.applyInserts(file, p.inserts.get('b.js')).split('\n').length - 1, 1000);
});

// ---- a row's full path (fix round 1, item 1) ---------------------------------

const { walk } = require('../genDocs/routes');

// The real route walker over an in-memory tree.
function walkFiles(files) {
  return walk({ has: (p) => Object.prototype.hasOwnProperty.call(files, p), read: (p) => (p in files ? files[p] : null) });
}

const MOUNT_FILES = (extra = {}) => ({
  'server/index.js': lines(
    "const express = require('express');",
    'const app = express();',
    "app.use('/api/admin', require('./routes/admin'));",
    "app.use('/api/me', require('./routes/me'));",
    "app.use('/api/plans', require('./routes/regenerate'));",
    "app.use('/api/items', require('./routes/items'));",
    '',
  ),
  'server/routes/admin.js': lines("const router = require('express').Router();", "router.get('/list', (req, res) => res.json([]));", 'module.exports = router;', ''),
  'server/routes/me.js': lines("const router = require('express').Router();", "router.get('/history', (req, res) => res.json([]));", 'module.exports = router;', ''),
  'server/routes/regenerate.js': lines("const router = require('express').Router();", "router.post('/:id/list/regenerate', (req, res) => res.json({}));", 'module.exports = router;', ''),
  'server/routes/items.js': lines("const router = require('express').Router();", "router.get('/:id(\\\\d+)', (req, res) => res.json({}));", "router.put('/:id(\\\\d+)/name', (req, res) => res.json({}));", 'module.exports = router;', ''),
  ...extra,
});

const MOUNT_ARCH = lines(
  '## API Routes',
  `### Admin ${EM} \`/api/admin\``,
  '| Method | Path | Auth | Description |',
  '|---|---|---|---|',
  '| GET | `/list` | Admin | The list |',
  '| GET | `/api/me/history` | Staff (self) | The caller history, absolute in the doc |',
  '',
  `### Bar program ${EM} \`/api/bar\``,
  '| Method | Path | Auth | Description |',
  '|---|---|---|---|',
  '| GET | `/unmounted` | Admin | Stays under the heading prefix |',
  '',
  'Regenerate (mounted at `/api/plans` BEFORE the flat router, from `routes/regenerate.js`):',
  '| Method | Path | Auth | Description |',
  '|---|---|---|---|',
  '| POST | `/:id/list/regenerate` | Admin | Fresh list from the stored inputs |',
  '',
  `### Items ${EM} \`/api/items\``,
  '| Method | Path | Auth | Description |',
  '|---|---|---|---|',
  '| GET | `/:id` | Yes | One item by its numeric id |',
  '| PUT | `/:id/name` | Admin | Rename one item |',
  '',
  '## Database Schema',
);

test('fullPath: an absolute /api row path is used as is, never glued to the mount', () => {
  assert.equal(arch.fullPath('/api/admin', '/api/me/history'), '/api/me/history');
  assert.equal(arch.fullPath('/api/admin', '/apiary'), '/api/admin/apiary');
});

test('planRows: an absolute row, a re-mounted sub-table and a regex-constrained parameter each match and move', () => {
  const files = MOUNT_FILES();
  const { sections } = arch.parseArch(MOUNT_ARCH);
  const p = arch.planRows(sections, walkFiles(files), { maxChars: 400, read: (f) => files[f] });
  const by = Object.fromEntries(p.decisions.map((d) => [`${d.row.method} ${d.row.path}`, d]));
  assert.equal(by['GET /api/me/history'].status, 'moved');
  assert.equal(by['GET /api/me/history'].route.file, 'server/routes/me.js');
  assert.equal(by['POST /:id/list/regenerate'].status, 'moved');
  assert.equal(by['POST /:id/list/regenerate'].full, '/api/plans/:id/list/regenerate');
  assert.equal(by['GET /unmounted'].full, '/api/bar/unmounted');
  assert.equal(by['GET /unmounted'].reason, 'no match');
  assert.equal(by['GET /:id'].status, 'moved');
  assert.equal(by['PUT /:id/name'].status, 'moved');
  const out = arch.applyInserts(files['server/routes/items.js'], p.inserts.get('server/routes/items.js'));
  assert.ok(out.includes("// One item by its numeric id\nrouter.get('/:id(\\\\d+)'"));
});

test('renderNotes prints the doc path for an absolute, a re-mounted and a constrained row', () => {
  const files = MOUNT_FILES({
    'server/routes/me.js': lines("const router = require('express').Router();", '// Already said.', "router.get('/history', (req, res) => res.json([]));", 'module.exports = router;', ''),
    'server/routes/regenerate.js': lines("const router = require('express').Router();", '// Already said.', "router.post('/:id/list/regenerate', (req, res) => res.json({}));", 'module.exports = router;', ''),
    'server/routes/items.js': lines("const router = require('express').Router();", '// Already said.', "router.get('/:id(\\\\d+)', (req, res) => res.json({}));", 'module.exports = router;', ''),
  });
  const { sections } = arch.parseArch(MOUNT_ARCH);
  const p = arch.planRows(sections, walkFiles(files), { maxChars: 400, read: (f) => files[f] });
  const notes = arch.renderNotes(sections, p.decisions);
  assert.ok(notes.includes('- **GET /api/me/history** (Staff (self)): The caller history, absolute in the doc'), notes);
  assert.ok(notes.includes('- **POST /api/plans/:id/list/regenerate** (Admin): Fresh list from the stored inputs'), notes);
  assert.ok(notes.includes('- **GET /api/items/:id** (Yes): One item by its numeric id'), notes);
  assert.ok(!notes.includes('/api/admin/api/'), notes);
  assert.equal(p.decisions.filter((d) => d.reason === 'handler commented').length, 3);
});
