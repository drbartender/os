const catalog = require('..');

describe('mission catalog', () => {
  test('loads without throwing', () => expect(catalog.all).toBeDefined());
  test('all ids are unique', () => {
    const ids = catalog.all.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('catalog is frozen', () => expect(Object.isFrozen(catalog.all)).toBe(true));
});
