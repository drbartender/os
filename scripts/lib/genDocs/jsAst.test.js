'use strict';

// Suite for the JavaScript syntax helpers of the route walker
// (scripts/lib/genDocs/jsAst.js), over small parsed snippets.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseText, isId, str, evalStr, literal, unroll, requireSpec, propName, scanNested } = require('./jsAst');

const expr = (code) => parseText(`(${code});`).ast.body[0].expression;
const stmt = (code) => parseText(code).ast.body[0];

test('parseText: a script, a module, comments with lines, and a refusal', () => {
  const s = parseText('#!/usr/bin/env node\n// one\nconst a = 1; /* two */\n');
  assert.equal(s.ast.body.length, 1);
  assert.deepEqual(s.comments.map((c) => [c.type, c.value, c.loc.start.line]), [['Line', '/usr/bin/env node', 1], ['Line', ' one', 2], ['Block', ' two ', 3]]);
  assert.equal(parseText('import x from "y";\nexport default x;\n').ast.sourceType, 'module');
  assert.throws(() => parseText('const = ;'), /^Error: does not parse \(/);
});

test('isId, str, propName and requireSpec read only what they say', () => {
  assert.equal(isId(expr('a')), true);
  assert.equal(isId(expr('a'), 'b'), false);
  assert.equal(str(expr("'x'")), 'x');
  assert.equal(str(expr('`y`')), 'y');
  assert.equal(str(expr('`y${z}`')), null);
  assert.equal(str(expr('1')), null);
  assert.equal(propName(expr('a.b')), 'b');
  assert.equal(propName(expr('a[b]')), null);
  assert.deepEqual(requireSpec(expr("require('./x')")), { spec: './x' });
  assert.deepEqual(requireSpec(expr('require(name)')), { spec: null });
  assert.equal(requireSpec(expr("load('./x')")), null);
});

test('evalStr reads a template or + over loop-bound names, and nothing else', () => {
  const env = new Map([['k', 'open'], ['n', 2]]);
  assert.equal(evalStr(expr('`/:id/${k}`'), env), '/:id/open');
  assert.equal(evalStr(expr("'/a/' + k"), env), '/a/open');
  assert.equal(evalStr(expr('`/${n}`'), env), '/2');
  assert.equal(evalStr(expr('`/${other}`'), env), null);
  assert.equal(evalStr(expr("'/plain'"), new Map()), '/plain');
  assert.equal(evalStr(expr('k'), new Map()), null);
});

test('literal and unroll: one environment per element of a literal array, else null', () => {
  assert.deepEqual(literal(expr('true')), { v: true });
  assert.equal(literal(expr('/re/')), null);
  const pairs = unroll(stmt("for (const [k, on] of [['open', true], ['close', false]]) {}"), new Map());
  assert.deepEqual(pairs.map((m) => [...m]), [[['k', 'open'], ['on', true]], [['k', 'close'], ['on', false]]]);
  assert.deepEqual(unroll(stmt("for (const k of ['a', 'b']) {}"), null).map((m) => m.get('k')), ['a', 'b']);
  assert.equal(unroll(stmt('for (const k of list) {}'), null), null);
  assert.equal(unroll(stmt('for (const k of [a]) {}'), null), null);
  assert.equal(unroll(stmt('for (let i = 0; i < 2; i++) {}'), null), null);
});

test('scanNested visits calls in source order and skips a function that shadows the name', () => {
  const seen = [];
  const s = stmt('if (x) { r.get(1); f(r); (function (r) { r.post(2); })(); h(() => r.put(3)); }');
  scanNested(s, (c) => seen.push(c.callee.type === 'MemberExpression' ? c.callee.property.name : c.callee.name || 'iife'), 'r');
  assert.deepEqual(seen, ['get', 'f', 'iife', 'h', 'put']);
});
