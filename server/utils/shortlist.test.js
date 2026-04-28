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
});
