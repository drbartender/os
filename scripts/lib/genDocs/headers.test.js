'use strict';

// Suite for the header rule (scripts/lib/genDocs/headers.js): every shape
// readHeader reads, the prefix it skips, and insertionPoint on each.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readHeader, insertionPoint, isSource, isTest, describeComment, ROOTS } = require('./headers');
const { CODE_PATHS } = require('../../sensitive-match');

const js = (...lines) => lines.join('\n');

test('a // run is the header, joined with single spaces', () => {
  const t = js('// The item list.', '// Second line   of it.', 'const x = 1;');
  assert.deepEqual(readHeader(t, '.js'), { present: true, description: 'The item list. Second line of it.', start: 0, end: 2 });
  assert.equal(insertionPoint(t, '.js'), 0);
});

test('a /* */ block is the header', () => {
  const t = js('/* One block', '   over two lines. */', 'module.exports = {};');
  assert.deepEqual(readHeader(t, '.js'), { present: true, description: 'One block over two lines.', start: 0, end: 2 });
});

test('a JSDoc block: stars stripped, the first paragraph only', () => {
  const t = js('/**', ' * Reads the notes.', ' * Two sentences.', ' *', ' * @param {string} id', ' */', 'function f() {}');
  const h = readHeader(t, '.js');
  assert.equal(h.description, 'Reads the notes. Two sentences.');
  assert.equal(h.start, 0);
  assert.equal(h.end, 6);
});

test('a header after a shebang', () => {
  const t = js('#!/usr/bin/env node', '// The CLI.', 'main();');
  assert.equal(readHeader(t, '.js').description, 'The CLI.');
  assert.equal(readHeader(t, '.js').start, 1);
  assert.equal(insertionPoint(js('#!/usr/bin/env node', 'main();'), '.js'), 1);
});

test("a header after 'use strict' (either quote, with or without the semicolon)", () => {
  for (const d of ["'use strict';", '"use strict";', "'use strict'", '"use strict"']) {
    const t = js(d, '', '// After the directive.', 'x();');
    assert.equal(readHeader(t, '.js').description, 'After the directive.', d);
    assert.equal(readHeader(t, '.js').start, 2, d);
  }
  assert.equal(insertionPoint(js("'use strict';", '', 'x();'), '.js'), 2);
});

test('a header after an eslint directive, line or block', () => {
  assert.equal(readHeader(js('/* eslint-disable no-console */', '// After it.', 'x();'), '.js').description, 'After it.');
  assert.equal(readHeader(js('// eslint-disable-next-line', '// After it.', 'x();'), '.js').description, 'After it.');
  assert.equal(readHeader(js('/* eslint-env node,', '   browser */', '// After a two-line one.'), '.js').description, 'After a two-line one.');
  assert.equal(insertionPoint(js('/* eslint-disable */', 'x();'), '.js'), 1);
});

test('a comment that only starts with the word eslint is still a header', () => {
  const h = readHeader(js('// eslint.config.mjs: the lint rules.', 'export default [];'), '.mjs');
  assert.equal(h.description, 'eslint.config.mjs: the lint rules.');
});

test('a header after all three, in any order, blank lines between', () => {
  const t = js('#!/usr/bin/env node', '', '/* eslint-disable */', "'use strict';", '', '/*', ' * The real header.', ' */', 'run();');
  const h = readHeader(t, '.js');
  assert.equal(h.description, 'The real header.');
  assert.equal(h.start, 5);
  assert.equal(h.end, 8);
  assert.equal(insertionPoint(t, '.js'), 5);
});

test('the first paragraph is cut at a blank comment line', () => {
  const t = js('// First paragraph,', '// still first.', '//', '// Second paragraph.', 'x();');
  const h = readHeader(t, '.js');
  assert.equal(h.description, 'First paragraph, still first.');
  assert.equal(h.end, 4);
});

test('a comment with no words is no header', () => {
  for (const t of [js('//', '//', 'x();'), js('/* */', 'x();'), js('/**', ' *', ' */', 'x();'), js('// ──────────', 'x();')]) {
    const h = readHeader(t, '.js');
    assert.equal(h.present, false);
    assert.equal(h.description, '');
    assert.equal(h.start, h.end);
  }
});

test('no comment at all is no header, at the insertion point', () => {
  const t = js("'use strict';", 'const a = 1;');
  assert.deepEqual(readHeader(t, '.js'), { present: false, description: '', start: 1, end: 1 });
});

test('decoration rules at a line end are not words', () => {
  assert.equal(readHeader(js('// ─── The section ───', 'x();'), '.js').description, 'The section');
  assert.equal(describeComment(['// ======', '// Title', '// ======', '// more']), 'Title');
  assert.equal(describeComment(['// --flag stays', '// a -- b']), '--flag stays a -- b');
});

test('a .sh header after a shebang and a shellcheck line', () => {
  const t = js('#!/usr/bin/env bash', '# shellcheck disable=SC2086', '# Merges a lane.', '# Second line.', '', 'set -e');
  const h = readHeader(t, '.sh');
  assert.equal(h.description, 'Merges a lane. Second line.');
  assert.equal(h.start, 2);
  assert.equal(insertionPoint(js('#!/usr/bin/env bash', '# shellcheck disable=SC2086', 'set -e'), '.sh'), 2);
});

test('a .sql header is the -- run', () => {
  const t = js('', '-- The schema.', '-- All of it.', 'CREATE TABLE a (id INT);');
  assert.equal(readHeader(t, '.sql').description, 'The schema. All of it.');
  assert.equal(readHeader(t, '.sql').start, 1);
  assert.equal(insertionPoint(t, '.sql'), 1);
});

test('a .css header is one block comment', () => {
  const t = js('/* The palette.', ' * Tokens only. */', ':root { --a: 1; }');
  assert.equal(readHeader(t, '.css').description, 'The palette. Tokens only.');
  assert.equal(readHeader(js('// not css', 'a {}'), '.css').present, false);
  assert.equal(insertionPoint(t, '.css'), 0);
});

test('a BOM and CRLF file reads like LF, the BOM ignored', () => {
  const t = '\uFEFF#!/usr/bin/env node\r\n\'use strict\';\r\n// Windows header.\r\n// Two lines.\r\nx();\r\n';
  const h = readHeader(t, '.js');
  assert.equal(h.description, 'Windows header. Two lines.');
  assert.equal(h.start, 2);
  assert.equal(h.end, 4);
  assert.equal(insertionPoint('\uFEFF\'use strict\';\r\nx();\r\n', '.js'), 1);
});

test('the same rules for .jsx, .mjs and .cjs; an unknown kind has no header', () => {
  for (const ext of ['.jsx', 'jsx', '.mjs', '.cjs']) assert.equal(readHeader('// A component.\nexport default 1;', ext).description, 'A component.');
  assert.equal(readHeader('// words', '.md').present, false);
  assert.equal(insertionPoint('# words', '.md'), 0);
});

test('isSource is decision 1: the four extensions under the three roots, tests out', () => {
  assert.equal(isSource('server/routes/item.js'), true);
  assert.equal(isSource('client/src/App.jsx'), true);
  assert.equal(isSource('scripts/lib/x.mjs'), true);
  assert.equal(isSource('scripts/x.cjs'), true);
  assert.equal(isSource('server/routes/item.test.js'), false);
  assert.equal(isSource('client/public/x.js'), false);
  assert.equal(isSource('scripts/merge-lane.sh'), false);
  assert.equal(isSource('server/db/schema.sql'), false);
  assert.equal(isTest('client/src/a.test.jsx'), true);
  assert.equal(isTest('server/a.js'), false);
});

test("the roots and the exclusions are sensitive-match's CODE_PATHS, the one definition", () => {
  assert.equal(ROOTS, CODE_PATHS.roots);
  for (const p of CODE_PATHS.exclude.filter((g) => !g.includes('*'))) assert.equal(isSource(p), false, p);
  assert.equal(isSource('scripts/content-rule-calibrate.js'), false);
  assert.equal(isTest('scripts/content-rule-calibrate.js'), false);
  assert.equal(isTest('server/x.test.js'), true);
  assert.equal(isTest('client/src/x.test.jsx'), true);
});
