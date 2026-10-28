'use strict';

// Suite for README's tree reader and the generated header form
// (scripts/lib/migrate/readmeTree.js): depths, paths, directories, route
// groups, continuation lines, the dropped list, and the exports reader on
// every shape the generated form names.

const test = require('node:test');
const assert = require('node:assert/strict');
const tree = require('./readmeTree');

const EM = '\u2014';

const README = [
  '# Project',
  '',
  '## Folder Structure',
  '',
  '```',
  'dr-bartender/',
  '├── server/',
  '│   ├── index.js                # Express app setup, route mounting',
  '│   ├── assets/                 # Bundled audio for the voice line',
  '│   ├── routes/',
  '│   │   ├── admin/              # Admin endpoints (sub-routers)',
  '│   │   │   ├── index.js        # Composition router',
  `│   │   │   └── notes.js        # /notes list ${EM} unreviewed changes`,
  '│   │   └── items.js            # Item endpoints',
  '│   └── utils/',
  '│       └── helpers.js',
  '├── client/',
  '│   └── src/',
  '│       ├── components/         # Layout, Shell,',
  '│       │                       # Toast and Banner (small shared pieces),',
  '│       │                       #   nested detail line',
  '│       ├── pages/',
  '│       │   ├── (auth)          # Login, Register',
  '│       │   ├── admin/          # Dashboard sub-pages',
  '│       │   │   └── editor/core.js # shared editor pieces',
  '│       │   └── Home.jsx        # The home page',
  '│       └── index.css           # Global styles',
  '├── .claude/agents/             # Review lenses (nine)',
  '├── .husky/pre-commit           # Pre-commit hook',
  '└── package.json                # Server deps',
  '```',
  '',
  '## Next',
].join('\n');

test('parseTree: paths from depth, kinds, descriptions, the root dropped', () => {
  const { entries } = tree.parseTree(README);
  const by = Object.fromEntries(entries.map((e) => [e.path, e]));
  assert.equal(by['server/index.js'].description, 'Express app setup, route mounting');
  assert.equal(by['server/index.js'].kind, 'file');
  assert.equal(by['server/routes/admin'].kind, 'dir');
  assert.equal(by['server/routes/admin/notes.js'].description, `/notes list ${EM} unreviewed changes`);
  assert.equal(by['server/routes/items.js'].description, 'Item endpoints');
  assert.equal(by['server/utils/helpers.js'].description, '');
  assert.equal(by['client/src/pages/(auth)'].kind, 'group');
  assert.equal(by['client/src/pages/admin/editor/core.js'].description, 'shared editor pieces');
  assert.equal(by['client/src/pages/Home.jsx'].description, 'The home page');
  assert.equal(by['.claude/agents'].kind, 'dir');
  assert.equal(by['.husky/pre-commit'].kind, 'file');
  assert.equal(by['package.json'].description, 'Server deps');
  assert.ok(!entries.some((e) => /dr-bartender/.test(e.path)));
  assert.equal(entries.length, 22);
});

test('fileDescriptions: the described files only', () => {
  const map = tree.fileDescriptions(tree.parseTree(README));
  assert.equal(map.get('server/routes/admin/index.js'), 'Composition router');
  assert.ok(!map.has('server/utils/helpers.js'));
  assert.ok(!map.has('server/routes/admin'));
  assert.ok(!map.has('client/src/pages/(auth)'));
});

test('droppedLines: every directory and route-group description, every continuation line and every described file that is not a source file, no em dash', () => {
  const lines = tree.droppedLines(tree.parseTree(README));
  assert.deepEqual(lines, [
    'server/assets/: Bundled audio for the voice line',
    'server/routes/admin/: Admin endpoints (sub-routers)',
    'client/src/components/: Layout, Shell,',
    'client/src/components/: Toast and Banner (small shared pieces),',
    'client/src/components/:   nested detail line',
    'client/src/pages/(auth): Login, Register',
    'client/src/pages/admin/: Dashboard sub-pages',
    'client/src/index.css: Global styles',
    '.claude/agents/: Review lenses (nine)',
    '.husky/pre-commit: Pre-commit hook',
    'package.json: Server deps',
  ]);
  assert.equal(tree.parseTree(README).droppedFiles, 3, 'the described files that cannot take a header');
  const withDash = README.replace('Admin endpoints', `Admin ${EM} endpoints`);
  assert.ok(!tree.droppedLines(tree.parseTree(withDash)).join('\n').includes(EM));
});

test('parseTree: no Folder Structure section, or no fence under it, throws', () => {
  assert.throws(() => tree.parseTree('# nothing'), /Folder Structure/);
  assert.throws(() => tree.parseTree('## Folder Structure\n\ntext\n\n## Next\n```\nx\n```'), /fenced/);
});

const read = (text, file) => tree.readExports(text, file);
const gen = (text, file) => tree.generatedDescription(read(text, file), file, '2026-01-02');
const SUFFIX = " Header generated from the file's exports by migrate-headers on 2026-01-02; replace with what it does.";

test('a React component: a default-exported function or class with a capital name under client/src', () => {
  const fn = "import React from 'react';\nexport default function ItemCard({ item }) {\n  return <div>{item.name}</div>;\n}\n";
  assert.equal(gen(fn, 'client/src/components/ItemCard.js'), `ItemCard (React component, default export).${SUFFIX}`);
  const arrow = "const Shell = () => <main />;\nexport default Shell;\n";
  assert.equal(read(arrow, 'client/src/Shell.jsx').kind, 'component');
  const memo = "import { memo } from 'react';\nfunction Row() { return null; }\nexport default memo(Row);\n";
  assert.deepEqual(read(memo, 'client/src/Row.js'), { kind: 'component', name: 'Row', names: [] });
  const cls = "class Board extends React.Component { render() { return <p />; } }\nexport default Board;\n";
  assert.equal(read(cls, 'client/src/Board.js').kind, 'component');
  const jsxFile = "export default function Panel() { return <section />; }\n";
  assert.equal(read(jsxFile, 'scripts/Panel.jsx').kind, 'component');
});

test('a default export that is not a component: lowercase, a value, or a server class', () => {
  assert.equal(gen("function asyncHandler(fn) { return fn; }\nmodule.exports = asyncHandler;\n", 'server/middleware/asyncHandler.js'), `asyncHandler (default export).${SUFFIX}`);
  const router = "const express = require('express');\nconst router = express.Router();\nrouter.get('/', (req, res) => res.json([]));\nmodule.exports = router;\n";
  assert.deepEqual(read(router, 'server/routes/items.js'), { kind: 'default', name: 'router', names: [] });
  assert.deepEqual(read("class Store {}\nmodule.exports = Store;\n", 'server/utils/Store.js'), { kind: 'default', name: 'Store', names: [] });
  assert.deepEqual(read('export default { a: 1 };\n', 'client/src/data/table.js'), { kind: 'default', name: 'table', names: [] });
  assert.deepEqual(read("const r = require('express').Router();\nmodule.exports = Object.assign(r, { helper() {} });\n", 'server/routes/r.js'), { kind: 'default', name: 'r', names: [] });
});

test('named exports: ESM and CommonJS, up to eight then "and N more"', () => {
  assert.equal(gen('export const a = 1;\nexport function b() {}\nexport { c as d };\nconst c = 2;\n', 'client/src/utils/x.js'), `Exports a, b, d.${SUFFIX}`);
  assert.equal(gen('module.exports = { one, two, three };\nfunction one() {}\nfunction two() {}\nfunction three() {}\n', 'server/utils/y.js'), `Exports one, two, three.${SUFFIX}`);
  assert.equal(gen('exports.first = 1;\nmodule.exports.second = 2;\n', 'server/utils/z.js'), `Exports first, second.${SUFFIX}`);
  const many = Array.from({ length: 11 }, (_, k) => `export const n${k} = ${k};`).join('\n');
  assert.equal(gen(many, 'client/src/utils/many.js'), `Exports n0, n1, n2, n3, n4, n5, n6, n7 and 3 more.${SUFFIX}`);
  assert.deepEqual(read("export * from './a';\nexport * as ns from './b';\n", 'client/src/i.js').names, ['everything from ./a', 'ns']);
  assert.deepEqual(read('const { a, b: [c] } = obj;\nexport { a };\nexport const { d, e = 1 } = obj;\n', 'client/src/p.js').names, ['a', 'd', 'e']);
});

test('no exports: an entry point; text that does not parse: null', () => {
  assert.equal(gen("import ReactDOM from 'react-dom';\nReactDOM.render(<App />, document.getElementById('root'));\n", 'client/src/index.js'), `index.js: entry point, no exports.${SUFFIX}`);
  assert.equal(gen("#!/usr/bin/env node\n'use strict';\nmain();\n", 'scripts/run.js'), `run.js: entry point, no exports.${SUFFIX}`);
  assert.equal(read('const = ;', 'client/src/broken.js'), null);
  assert.equal(read('\ufeffexport const a = 1;\n', 'client/src/bom.js').kind, 'named');
});

test('a re-exported default reads its source module name', () => {
  assert.deepEqual(read("export { default } from './Widget';\n", 'client/src/components/widget/index.js'), { kind: 'default', name: 'Widget', names: [] });
});
