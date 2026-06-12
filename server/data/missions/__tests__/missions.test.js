const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('..');

describe('mission catalog', () => {
  test('loads without throwing', () => assert.ok(catalog.all));
  test('all ids are unique', () => {
    const ids = catalog.all.map(m => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });
  test('catalog is frozen', () => assert.equal(Object.isFrozen(catalog.all), true));
});
