const { test, describe } = require('node:test');
const assert = require('node:assert');

const { buildShortlist } = require('./shortlist');

const M = (id, area, estMinutes, opts = {}) => ({
  id, area, estMinutes,
  needsAdminComfort: false,
  priority: 'p1',
  device: ['desktop', 'mobile'],
  ...opts,
});

const ALL = [
  M('a', 'customer', 5,  { priority: 'p0' }),
  M('b', 'customer', 30, { priority: 'p0' }),
  M('c', 'admin',    8,  { priority: 'p0', needsAdminComfort: true }),
  M('d', 'customer', 10, { priority: 'p1' }),
  M('e', 'admin',    5,  { priority: 'p2', needsAdminComfort: true }),
  M('f', 'edge',     3,  { priority: 'p2' }),
];

describe('buildShortlist', () => {
  test('new tester sees only p0 when p0 not saturated', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    assert.deepStrictEqual(out.missions.map(m => m.priority), ['p0', 'p0']);
  });
  test('returning tester graduates after personally completing all p0', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop',
      completedIds: ['a', 'b'],
      counts: {}, openBugCounts: {},
    });
    assert.ok(out.missions.map(m => m.id).includes('d'));
  });
  test('crowd graduation: when all p0 are saturated globally, p1 surfaces too', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: { a: 5, b: 5, c: 5 },
      openBugCounts: {},
    });
    const priorities = out.missions.map(m => m.priority);
    assert.ok(priorities.includes('p0'));
    assert.ok(priorities.includes('p1'));
  });
  test('bug-saturated missions are excluded', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: { a: 2 },
    });
    assert.ok(!out.missions.map(m => m.id).includes('a'));
  });
  test('mission with 1 open bug is still shown', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: { a: 1 },
    });
    assert.ok(out.missions.map(m => m.id).includes('a'));
  });
  test('admin-skip drops needsAdminComfort missions', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['admin'], timeBudget: 60,
      adminComfort: 'skip', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    assert.deepStrictEqual(out.missions, []);
  });
  test('respects device filter', () => {
    const desktopOnly = M('z', 'customer', 5, { device: ['desktop'], priority: 'p0' });
    const out = buildShortlist({
      missions: [desktopOnly], areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'mobile', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    assert.deepStrictEqual(out.missions, []);
  });
  test('within tier, sorts by completion count ascending', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: { a: 5, b: 0 },
      openBugCounts: {},
    });
    assert.strictEqual(out.missions[0].id, 'b');
  });

  test('hard filter, wrong area excluded', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['edge'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    assert.deepStrictEqual(out.missions.map(m => m.id), ['f']);
  });

  test('hard filter, mission exceeding timeBudget excluded', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 6,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    // `a` is 5 min (in), `b` is 30 min (out), `d` is 10 min (out).
    assert.deepStrictEqual(out.missions.map(m => m.id), ['a']);
  });

  test('hard filter, completed mission excluded by id', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: ['a'],
      counts: {}, openBugCounts: {},
    });
    assert.ok(!out.missions.map(m => m.id).includes('a'));
  });

  test('time-budget relaxation fires when widening surfaces new in-tier candidates', () => {
    // One p0 in-budget so candidates is non-empty (relaxation only runs when
    // result.length < 3, early return short-circuits if there's nothing).
    // Two more p0 missions just over budget; widening to 15 surfaces them.
    const missions = [
      M('p0a', 'customer', 5,  { priority: 'p0' }),
      M('x1',  'customer', 12, { priority: 'p0' }),
      M('x2',  'customer', 14, { priority: 'p0' }),
    ];
    const out = buildShortlist({
      missions, areas: ['customer'], timeBudget: 10,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    assert.strictEqual(out.relaxed, true);
    assert.deepStrictEqual(out.missions.map(m => m.id).sort(), ['p0a', 'x1', 'x2']);
  });

  test('time-budget relaxation does NOT abandon chosen tier even if widening would add out-of-tier missions', () => {
    // Two in-budget p0 missions exist, so shortlist already has p0 candidates.
    // A p1 mission is just over budget; relaxation should NOT surface it
    // because the chosen tier (p0) is not abandoned.
    const missions = [
      M('p0a', 'customer', 5,  { priority: 'p0' }),
      M('p0b', 'customer', 8,  { priority: 'p0' }),
      M('p1a', 'customer', 12, { priority: 'p1' }),
    ];
    const out = buildShortlist({
      missions, areas: ['customer'], timeBudget: 10,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    assert.deepStrictEqual(out.missions.map(m => m.priority), ['p0', 'p0']);
    assert.strictEqual(out.relaxed, false);
  });
});
