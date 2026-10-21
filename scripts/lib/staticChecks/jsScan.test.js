'use strict';

// node:test suite for scripts/lib/staticChecks/jsScan.js: the espree code view
// and the token helpers the rules read.

const { test } = require('node:test');
const assert = require('node:assert');
const { scanJs, callArgs, lineStarts, lineAt } = require('./jsScan');

test('the code view keeps every offset and newline and blanks comments, strings, regex, template text and JSX text', () => {
  const src = [
    '#!/usr/bin/env node',
    "const a = 'x'; // note",
    'const r = /q/g; /* block',
    '   still */ const t = `t${a}u`;',
    'const j = <p title="z">Don\'t</p>;',
  ].join('\n');
  const { code } = scanJs(src);
  assert.strictEqual(code.length, src.length);
  assert.deepStrictEqual(code.split('\n').length, src.split('\n').length);
  const lines = code.split('\n');
  assert.strictEqual(lines[0].trim(), '');
  assert.strictEqual(lines[1].replace(/\s+/g, ' ').trim(), 'const a = ;');
  assert.strictEqual(lines[2].replace(/\s+/g, ' ').trim(), 'const r = ;');
  assert.strictEqual(lines[3].replace(/\s+/g, ' ').trim(), 'const t = a ;');
  assert.strictEqual(lines[4].replace(/\s+/g, ' ').trim(), 'const j = <p title= > </p>;');
});

test('a file only sloppy mode reads falls back to sourceType script', () => {
  const { tokens } = scanJs('var mode = 0755;\n');
  assert.ok(tokens.some((t) => t.type === 'Numeric' && t.value === '0755'));
});

test('a file neither source type tokenizes throws with the line number', () => {
  assert.throws(() => scanJs("const a = 1;\nconst s = 'open;\n"), (err) => err.lineNumber === 2 && /Unterminated/.test(err.message));
});

test('token and error lines count \\n only, as git does: a U+2028, a U+2029 or a lone CR does not move them', () => {
  const { tokens, comments } = scanJs("const a = 'x\u2028y'; /* p\u2029q */\rz;\nconst t = `m\nn`;\n");
  const at = (v) => tokens.find((t) => t.value === v);
  assert.deepStrictEqual([at('z').line, at('z').endLine], [1, 1]);
  assert.deepStrictEqual([at('`m\nn`').line, at('`m\nn`').endLine], [2, 3]);
  assert.deepStrictEqual(comments.map((c) => [c.line, c.endLine]), [[1, 1]]);
  assert.throws(() => scanJs("const a = 'x\u2028y';\nconst s = 'open;\n"), (err) => err.lineNumber === 2);
});

test('server/ and scripts/ .js and any .cjs read as a script first, everything else as a module first; a disagreement throws', () => {
  // `<!--` anywhere and `-->` at the start of a line open a comment in a
  // script and are operators in a module, so a backtick after one opens a
  // template only in the module reading.
  const html = "const a = 1 <!-- `\nconst b = 2;\n// `\n";
  const close = "let n = 1\n--> `\nconst b = 2;\n// `\n";
  for (const [src, line] of [[html, 1], [close, 2]]) {
    for (const p of ['server/a.js', 'scripts/a.js', 'x.cjs', 'client/src/a.js', 'a.mjs']) {
      assert.throws(() => scanJs(src, { path: p }), (err) => /disagree/.test(err.message) && err.lineNumber === line, p);
    }
  }
  // A file only one reading tokenizes uses that reading, whatever the order.
  assert.ok(scanJs('var mode = 0755;\n', { path: 'client/src/m.js' }).tokens.some((t) => t.value === '0755'));
  assert.ok(scanJs('var mode = 0755;\n', { path: 'server/m.js' }).tokens.some((t) => t.value === '0755'));
  // An explicit source type is the one reading, with no fallback.
  assert.deepStrictEqual(scanJs(html, { sourceType: 'commonjs', jsx: false }).comments.map((c) => c.line), [1, 3]);
  assert.deepStrictEqual(scanJs(html, { sourceType: 'module' }).comments, []);
});

test('callArgs splits the arguments and records top-level ${} bodies, a $${ placeholder and + operators', () => {
  const src = 'q(`a ${x} $${n} ${f(y)}`, b + c, [d, e]);';
  const { tokens, pair } = scanJs(src);
  const call = callArgs(tokens, pair, 1);
  assert.strictEqual(call.args.length, 3);
  const [first, second, third] = call.args;
  assert.deepStrictEqual(first.interps.map((x) => [tokens[x.from].value, x.dollar]), [['x', false], ['n', true], ['f', false]]);
  assert.deepStrictEqual(second.plus.map((k) => tokens[k].value), ['+']);
  assert.deepStrictEqual(third.interps, []);
  assert.strictEqual(tokens[call.close].value, ')');
});

test('lineAt maps an offset to its 1-based line', () => {
  const starts = lineStarts('a\nbb\nccc');
  assert.deepStrictEqual([0, 1, 2, 4, 5, 8].map((i) => lineAt(starts, i)), [1, 1, 2, 2, 3, 3]);
});
