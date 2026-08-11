import { isGratuityBelowFloor, gratuityFloorMessage, gratuityFloorDollars } from './gratuityFloor';

const base = { gratuityEnabled: true, tipJar: false, gratuityTotal: 0, gratuityFloor: 600 };

test('isGratuityBelowFloor > false when gratuity is disabled', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityEnabled: false, gratuityTotal: 0 })).toBe(false);
});

test('isGratuityBelowFloor > false in jar mode regardless of amount', () => {
  expect(isGratuityBelowFloor({ ...base, tipJar: true, gratuityTotal: 0 })).toBe(false);
});

test('isGratuityBelowFloor > false at or above the floor (no jar)', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: 600 })).toBe(false);
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: 700 })).toBe(false);
});

test('isGratuityBelowFloor > true below the floor (no jar)', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: 300 })).toBe(true);
});

test('isGratuityBelowFloor > empty/undefined/non-numeric coerce to 0, not NaN (no jar)', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: '' })).toBe(true);
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: undefined })).toBe(true);
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: 'abc' })).toBe(true);
});

test('isGratuityBelowFloor > accepts numeric strings from the input', () => {
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: '300' })).toBe(true);
  expect(isGratuityBelowFloor({ ...base, gratuityTotal: '600' })).toBe(false);
});

test('gratuityFloorMessage > builds the shared floor copy', () => {
  expect(gratuityFloorMessage('$600', 'bartender'))
    .toBe('Without a tip jar, gratuity must be at least $600 so your bartenders are covered.');
});

describe('admin gratuity mandate (spec 2026-08-10)', () => {
  it('mandated: jar-yes no longer exempts the floor', () => {
    expect(isGratuityBelowFloor({ gratuityEnabled: true, tipJar: true, gratuityTotal: 40, gratuityFloor: 100, mandated: true })).toBe(true);
  });

  it('mandated: at the floor passes', () => {
    expect(isGratuityBelowFloor({ gratuityEnabled: true, tipJar: true, gratuityTotal: 100, gratuityFloor: 100, mandated: true })).toBe(false);
  });

  it('legacy path pinned: jar-yes without a mandate never floors', () => {
    expect(isGratuityBelowFloor({ gratuityEnabled: true, tipJar: true, gratuityTotal: 0, gratuityFloor: 100, mandated: false })).toBe(false);
  });

  it('mandate message names the requirement, no em dash', () => {
    const msg = gratuityFloorMessage('$100.00', 'bartender', true);
    expect(msg).toMatch(/required gratuity of at least \$100\.00/);
    expect(msg.includes('—')).toBe(false);
  });

  it('legacy message unchanged without the flag', () => {
    expect(gratuityFloorMessage('$100.00', 'bartender'))
      .toBe('Without a tip jar, gratuity must be at least $100.00 so your bartenders are covered.');
  });

  it('gratuityFloorDollars: mandate rate wins', () => {
    expect(gratuityFloorDollars({ mandateRate: 50, staffCount: 1, hours: 2 })).toBe(100);
  });

  it('gratuityFloorDollars: no mandate falls back to the 50-rule dollars', () => {
    expect(gratuityFloorDollars({ mandateRate: 0, staffCount: 1, hours: 2 })).toBe(100);
  });

  it('gratuityFloorDollars: rescaled 4dp mandate rounds to cents', () => {
    expect(gratuityFloorDollars({ mandateRate: 33.3333, staffCount: 1, hours: 7 })).toBe(233.33);
  });
});
