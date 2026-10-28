'use strict';

// Suite for the generated tree (scripts/lib/genDocs/tree.js) over an in-memory
// fixture source: order, test omission, descriptions from headers, directories
// outside the roots by name alone, and the padding rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('./tree');

function fixture(files) {
  return {
    list: () => Object.keys(files),
    read: (p) => (p in files ? files[p] : null),
  };
}

const FILES = {
  'server/index.js': '// The app.\nconst x = 1;\n',
  'server/b.js': 'module.exports = 1;\n',
  'server/a.test.js': '// A test.\n',
  'server/Z.js': '// Upper case sorts first.\n',
  'server/routes/item.js': "'use strict';\n// The item routes.\n",
  'server/routes/item.test.js': '',
  'server/onlytests/x.test.js': '',
  'server/assets/greeting.mp3': 'not text',
  'server/db/schema.sql': '-- The schema.\nCREATE TABLE a (id INT);\n',
  'scripts/merge-lane.sh': '#!/usr/bin/env bash\n# Merges a lane.\n',
  'scripts/a-very-long-file-name-for-padding.js': '// Long.\n',
  'client/package.json': '{}',
  'client/public/index.html': '<html></html>',
  'client/src/App.jsx': '// The shell.\nexport default 1;\n',
  'client/src/index.css': '/* The styles. */\n',
  'docs/a.md': '# a',
  'docs/b/c.md': '# c',
  'one.md': '# one',
  'README.md': '# readme',
  '.env.example': 'A=1\n',
  'eslint.config.mjs': '// The lint rules.\nexport default [];\n',
};

test('renders the fenced tree: files first, then directories, each in byte order', () => {
  const out = render(fixture(FILES));
  const lines = out.split('\n');
  assert.equal(lines[0], '```');
  assert.equal(lines[1], 'tests omitted');
  assert.equal(lines[lines.length - 1], '```');
  const body = lines.slice(2, -1);
  assert.deepEqual(body, [
    '├── .env.example',
    '├── README.md',
    '├── eslint.config.mjs         # The lint rules.',
    '├── one.md',
    '├── client/',
    '│   ├── package.json',
    '│   ├── public/',
    '│   └── src/',
    '│       ├── App.jsx           # The shell.',
    '│       └── index.css         # The styles.',
    '├── docs/',
    '├── scripts/',
    '│   ├── a-very-long-file-name-for-padding.js # Long.',
    '│   └── merge-lane.sh         # Merges a lane.',
    '└── server/',
    '    ├── Z.js                  # Upper case sorts first.',
    '    ├── b.js',
    '    ├── index.js              # The app.',
    '    ├── assets/',
    '    │   └── greeting.mp3',
    '    ├── db/',
    '    │   └── schema.sql        # The schema.',
    '    └── routes/',
    '        └── item.js           # The item routes.',
  ]);
});

test('the padding rule: names under 30 characters pad to 30, longer ones get one space', () => {
  const lines = render(fixture(FILES)).split('\n');
  const padded = lines.find((l) => l.includes('eslint.config.mjs'));
  assert.equal(padded.indexOf('#'), 30);
  const long = lines.find((l) => l.includes('a-very-long-file-name'));
  assert.ok(long.length > 30);
  assert.match(long, /\.js # Long\.$/);
  const exactly29 = render(fixture({ 'abcdefghijklmnopqrstuvwxy.js': '// D.\n' })).split('\n')[2];
  assert.equal(exactly29, '└── abcdefghijklmnopqrstuvwxy.js # D.');
});

test('test files are omitted in the roots; a tests-only directory is left out', () => {
  const out = render(fixture(FILES));
  assert.ok(!out.includes('a.test.js'));
  assert.ok(!out.includes('item.test.js'));
  assert.ok(!out.includes('onlytests'));
  assert.match(out, /^tests omitted$/m);
});

test('no line carries a count: a file added outside the roots, or a test added in one, changes nothing', () => {
  const before = render(fixture(FILES));
  const more = { ...FILES, 'docs/specs/new-spec.md': '# s', 'docs/d.md': '# d', 'client/public/x.png': '', 'server/routes/more.test.js': '', 'server/onlytests/y.test.js': '' };
  assert.equal(render(fixture(more)), before);
  assert.ok(!/\(\d+ files?\)/.test(before));
});

test('a file with no header and a binary file show the name alone', () => {
  const out = render(fixture(FILES));
  assert.match(out, /── b\.js$/m);
  assert.match(out, /── greeting\.mp3$/m);
});

test('a directory outside the roots is its name alone, never descended', () => {
  const out = render(fixture(FILES));
  assert.match(out, /── docs\/$/m);
  assert.ok(!out.includes('c.md'));
});

test('descriptions are one line, with no em dash and no fence break', () => {
  const out = render(fixture({ 'server/x.js': '// A \u2014 B,\n// with ``` inside.\n' }));
  assert.match(out, /# A - B, with `` inside\.$/m);
  assert.ok(!out.includes('\u2014'));
});

test('the same source renders the same bytes twice', () => {
  assert.equal(render(fixture(FILES)), render(fixture(FILES)));
});
