import { isGratuityBelowFloor, gratuityFloorMessage } from './gratuityFloor';

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
