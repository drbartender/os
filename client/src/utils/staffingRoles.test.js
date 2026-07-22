import {
  ASSIGN_ROLE_PREFERENCE,
  computeRemaining,
  defaultAssignRole,
  parsePositionsNeeded,
} from './staffingRoles';

// Helper mirroring how the real callers build their arguments: roster from
// positions_needed, remaining from roster minus the approved-by-role aggregate.
function forShift(positionsNeeded, approvedByRole = {}) {
  const roster = parsePositionsNeeded(positionsNeeded);
  return defaultAssignRole(roster, computeRemaining(roster, approvedByRole));
}

describe('defaultAssignRole', () => {
  test('preference order is Bartender, Banquet Server, Barback', () => {
    expect(ASSIGN_ROLE_PREFERENCE).toEqual(['Bartender', 'Banquet Server', 'Barback']);
  });

  test('open bar slot wins', () => {
    expect(forShift(['Bartender', 'Bartender'])).toBe('Bartender');
  });

  test('bar full, only barback open -> Barback', () => {
    expect(forShift(['Bartender', 'Bartender', 'Barback'], { Bartender: 2 })).toBe('Barback');
  });

  test('bar full, server and barback both open -> Banquet Server', () => {
    expect(
      forShift(['Bartender', 'Banquet Server', 'Barback'], { Bartender: 1 })
    ).toBe('Banquet Server');
  });

  test('bartender-less roster -> Banquet Server', () => {
    expect(forShift(['Banquet Server', 'Banquet Server'])).toBe('Banquet Server');
  });

  test('barback-only roster -> Barback', () => {
    expect(forShift(['Barback'])).toBe('Barback');
  });

  test('every role full falls back to the roster, preferred order', () => {
    expect(forShift(['Bartender', 'Bartender'], { Bartender: 2 })).toBe('Bartender');
    expect(forShift(['Banquet Server', 'Barback'], { 'Banquet Server': 1, Barback: 1 }))
      .toBe('Banquet Server');
    expect(forShift(['Barback'], { Barback: 1 })).toBe('Barback');
  });

  test('over-filled roles count as full, not as open', () => {
    expect(forShift(['Bartender', 'Barback'], { Bartender: 3 })).toBe('Barback');
  });

  test('empty roster falls back to Bartender', () => {
    expect(forShift([])).toBe('Bartender');
    expect(defaultAssignRole([], {})).toBe('Bartender');
  });

  test('malformed positions_needed falls back to Bartender', () => {
    expect(forShift('not-json')).toBe('Bartender');
    expect(forShift(null)).toBe('Bartender');
    expect(forShift({ position: 'Bartender' })).toBe('Bartender');
  });

  test('non-canonical roster labels are dropped, so a Sous Chef roster is Bartender', () => {
    expect(forShift(['Sous Chef'])).toBe('Bartender');
  });

  test('lowercase and {position,count} rosters canonicalize before the pick', () => {
    expect(forShift('["bartender","barback"]', { Bartender: 1 })).toBe('Barback');
    expect(forShift([{ position: 'server', count: 2 }])).toBe('Banquet Server');
  });

  test('tolerates a missing or junk remaining argument', () => {
    expect(defaultAssignRole(['Barback'])).toBe('Barback');
    expect(defaultAssignRole(['Barback'], null)).toBe('Barback');
  });
});
