'use strict';

// node:test suite for scripts/lib/staticChecks/eslintUndef.js: the pieces that
// need no git repo. The rule end to end is in scripts/static-checks.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const eslintUndef = require('./eslintUndef');
const { neutralizeDirectives, isLintTarget } = eslintUndef;

test('lintDir gives up at its timeout and says so; the default timeout is 120 s', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-timeout-'));
  try {
    const bin = path.join(dir, 'eslint');
    fs.writeFileSync(bin, '#!/bin/sh\nexec sleep 3\n', { mode: 0o755 });
    const t0 = Date.now();
    const got = await eslintUndef.lintDir(bin, path.join(dir, 'cfg.mjs'), dir, ['a.js'], { timeoutMs: 300 });
    assert.match(String(got), /timed out/);
    assert.ok(Date.now() - t0 < 2500, `took ${Date.now() - t0} ms`);
    assert.strictEqual(eslintUndef.ESLINT_TIMEOUT_MS, 120000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('neutralizeDirectives makes range directives and inline rule configs inert, same length, and keeps line-level ones', () => {
  const src = [
    '/* eslint-disable */',
    '/*eslint-disable no-undef*/',
    '/* eslint no-undef: "off" */',
    '// eslint-disable-next-line no-undef',
    'x(); // eslint-disable-line no-undef',
    '/* global y */',
    "const s = '/* eslint-disable */';",
  ].join('\n');
  const out = neutralizeDirectives(src);
  assert.strictEqual(out.length, src.length);
  assert.deepStrictEqual(out.split('\n'), [
    '/* xslint-disable */',
    '/*xslint-disable no-undef*/',
    '/* xslint no-undef: "off" */',
    '// eslint-disable-next-line no-undef',
    'x(); // eslint-disable-line no-undef',
    '/* global y */',
    "const s = '/* eslint-disable */';",
  ]);
});

test('eslintUndef refuses a path that resolves outside its side dir and writes nothing outside the temp dir', async () => {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'static-checks-outer-'));
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(inner);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = inner;
  try {
    const rel = 'server/../../../../escape.js';
    const files = [{ path: rel, oldPath: null, status: 'A', added: new Map() }];
    const tip = new Map([[`TIP:${rel}`, "'use strict';\nmodule.exports = 1;\n"]]);
    const repo = path.resolve(__dirname, '..', '..', '..');
    await assert.rejects(eslintUndef.eslintUndef(repo, { base: 'BASE', tip: 'TIP' }, files, tip, () => new Map()), /outside/);
    assert.deepStrictEqual(fs.readdirSync(outer), ['inner']);
    assert.deepStrictEqual(fs.readdirSync(inner), []);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    fs.rmSync(outer, { recursive: true, force: true });
  }
});

test('baseLineOf maps an unchanged tip line to its base line through --unified=0 hunks', () => {
  const hunks = [
    { oldStart: 3, oldCount: 1, newStart: 2, newCount: 0 },
    { oldStart: 6, oldCount: 3, newStart: 5, newCount: 1 },
    { oldStart: 9, oldCount: 0, newStart: 7, newCount: 2 },
  ];
  // tip 1-2 are base 1-2; base 3 is gone; tip 3-4 are base 4-5; tip 5
  // replaced base 6-8; tip 6 is base 9; tip 7-8 were added after it; tip 9-10
  // are base 10-11.
  assert.deepStrictEqual([1, 2, 3, 4, 6, 9, 10].map((n) => eslintUndef.baseLineOf(hunks, n)), [1, 2, 4, 5, 9, 10, 11]);
  assert.strictEqual(eslintUndef.baseLineOf([], 7), 7);
});

test('isLintTarget: a live .js file under server/ or scripts/', () => {
  const t = (path, status = 'M') => isLintTarget({ path, status });
  assert.deepStrictEqual([t('server/a.js'), t('scripts/b.js'), t('client/src/c.js'), t('server/a.js', 'D'), t('server/a.mjs')], [true, true, false, false, false]);
});

test('isLintTarget: any filename character (U+2028, U+2029), trailing whitespace and an upper-case extension still make a target; git\'s name is not trimmed', () => {
  const t = (path, status = 'M') => isLintTarget({ path, status });
  assert.deepStrictEqual(
    [t('server/bs/u v.js'), t('scripts/a b.js'), t('server/trail.js '), t('server/tab.js\t'), t('server/UP.JS'), t('scripts/mixed.Js')],
    [true, true, true, true, true, true],
  );
  assert.deepStrictEqual([t('client/src/U .js'), t('server/a.mjs '), t('server/UP.JS', 'D')], [false, false, false]);
});
