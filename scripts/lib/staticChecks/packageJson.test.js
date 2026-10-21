'use strict';

// node:test suite for scripts/lib/staticChecks/packageJson.js. The rules that
// read it are covered through checkFile in staticRules.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const { jsonStrings, depEntries, nonRegistry, floatsSecurity } = require('./packageJson');

test('jsonStrings keeps each string value with its key path and line, and is null on text that is not JSON', () => {
  const text = '{\n  "a": "x",\n  "b": { "c": ["y", 1, true, null] }\n}\n';
  assert.deepStrictEqual(jsonStrings(text), [{ keys: ['a'], value: 'x', line: 2 }, { keys: ['b', 'c', 0], value: 'y', line: 3 }]);
  assert.strictEqual(jsonStrings('{ "a": }'), null);
});

test('depEntries names an override by its own package, its . entry by the parent, a version selector dropped', () => {
  const json = jsonStrings(JSON.stringify({ overrides: { 'pg@8': '8.11.3', foo: { '.': '1.0.0', express: '4.22.2' } }, repository: { url: 'x' } }, null, 2));
  assert.deepStrictEqual(depEntries({ json }).map((e) => [e.name, e.spec]), [['pg', '8.11.3'], ['foo', '1.0.0'], ['express', '4.22.2']]);
});

test('nonRegistry and floatsSecurity', () => {
  assert.deepStrictEqual(['file:a', 'o/r', 'o/r#v1', './x', 'x.tgz', '1.2.3', '^1.2.3', 'npm:a@1.0.0'].map(nonRegistry), [true, true, true, true, true, false, false, false]);
  assert.strictEqual(floatsSecurity({ name: 'pg', spec: '8.11.3' }), false);
  assert.strictEqual(floatsSecurity({ name: 'pg', spec: 'v8.11.3' }), false);
  assert.strictEqual(floatsSecurity({ name: 'pg', spec: '8.11' }), true);
  assert.strictEqual(floatsSecurity({ name: 'pg', spec: 'npm:pg@8.11.3' }), false);
  assert.strictEqual(floatsSecurity({ name: 'pg', spec: 'npm:pg-fork@8.11.3' }), true);
  assert.strictEqual(floatsSecurity({ name: 'cors', spec: '^2.8.5' }), false);
});
