import { formatMoney } from './formatMoney';

describe('formatMoney', () => {
  test('zero → $0', () => {
    expect(formatMoney(0)).toBe('$0');
  });

  test('whole dollars trim the trailing .00', () => {
    expect(formatMoney(4500)).toBe('$45');
    expect(formatMoney(100)).toBe('$1');
    expect(formatMoney(1000)).toBe('$10');
  });

  test('amounts with cents keep two decimals', () => {
    expect(formatMoney(4550)).toBe('$45.50');
    expect(formatMoney(1)).toBe('$0.01');
    expect(formatMoney(99)).toBe('$0.99');
    expect(formatMoney(105)).toBe('$1.05');
  });

  test('thousands separators on the integer portion', () => {
    expect(formatMoney(123456)).toBe('$1,234.56');
    expect(formatMoney(100000)).toBe('$1,000');
    expect(formatMoney(123456789)).toBe('$1,234,567.89');
    expect(formatMoney(1000000000)).toBe('$10,000,000');
  });

  test('negatives render with a leading dash', () => {
    expect(formatMoney(-1936)).toBe('-$19.36');
    expect(formatMoney(-4500)).toBe('-$45');
    expect(formatMoney(-123456)).toBe('-$1,234.56');
    expect(formatMoney(-1)).toBe('-$0.01');
  });

  test('fractional cents are truncated toward zero', () => {
    expect(formatMoney(4550.9)).toBe('$45.50');
    expect(formatMoney(-4550.9)).toBe('-$45.50');
  });

  test('non-finite / null / undefined input → $0', () => {
    expect(formatMoney(NaN)).toBe('$0');
    expect(formatMoney(Infinity)).toBe('$0');
    expect(formatMoney(-Infinity)).toBe('$0');
    expect(formatMoney(null)).toBe('$0');
    expect(formatMoney(undefined)).toBe('$0');
  });
});
