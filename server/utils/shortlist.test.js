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
    expect(out.missions.map(m => m.priority)).toEqual(['p0', 'p0']);
  });
  test('returning tester graduates after personally completing all p0', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop',
      completedIds: ['a', 'b'],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions.map(m => m.id)).toContain('d');
  });
  test('crowd graduation: when all p0 are saturated globally, p1 surfaces too', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: { a: 5, b: 5, c: 5 },
      openBugCounts: {},
    });
    expect(out.missions.map(m => m.priority)).toEqual(expect.arrayContaining(['p0', 'p1']));
  });
  test('bug-saturated missions are excluded', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: { a: 2 },
    });
    expect(out.missions.map(m => m.id)).not.toContain('a');
  });
  test('mission with 1 open bug is still shown', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: { a: 1 },
    });
    expect(out.missions.map(m => m.id)).toContain('a');
  });
  test('admin-skip drops needsAdminComfort missions', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['admin'], timeBudget: 60,
      adminComfort: 'skip', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions).toEqual([]);
  });
  test('respects device filter', () => {
    const desktopOnly = M('z', 'customer', 5, { device: ['desktop'], priority: 'p0' });
    const out = buildShortlist({
      missions: [desktopOnly], areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'mobile', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions).toEqual([]);
  });
  test('within tier, sorts by completion count ascending', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: { a: 5, b: 0 },
      openBugCounts: {},
    });
    expect(out.missions[0].id).toBe('b');
  });

  test('hard filter — wrong area excluded', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['edge'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions.map(m => m.id)).toEqual(['f']);
  });

  test('hard filter — mission exceeding timeBudget excluded', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 6,
      adminComfort: 'yes', device: 'desktop', completedIds: [],
      counts: {}, openBugCounts: {},
    });
    // `a` is 5 min (in), `b` is 30 min (out), `d` is 10 min (out).
    expect(out.missions.map(m => m.id)).toEqual(['a']);
  });

  test('hard filter — completed mission excluded by id', () => {
    const out = buildShortlist({
      missions: ALL, areas: ['customer'], timeBudget: 60,
      adminComfort: 'yes', device: 'desktop', completedIds: ['a'],
      counts: {}, openBugCounts: {},
    });
    expect(out.missions.map(m => m.id)).not.toContain('a');
  });

  test('time-budget relaxation fires when widening surfaces new in-tier candidates', () => {
    // One p0 in-budget so candidates is non-empty (relaxation only runs when
    // result.length < 3 — early return short-circuits if there's nothing).
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
    expect(out.relaxed).toBe(true);
    expect(out.missions.map(m => m.id).sort()).toEqual(['p0a', 'x1', 'x2']);
  });

  test('time-budget relaxation does NOT abandon chosen tier even if widening would add out-of-tier missions', () => {
    // Two in-budget p0 missions exist → shortlist already has p0 candidates.
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
    expect(out.missions.map(m => m.priority)).toEqual(['p0', 'p0']);
    expect(out.relaxed).toBe(false);
  });
});
