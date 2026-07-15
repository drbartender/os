import { subtractMinutesFromTime, formatSetupTime } from './setupTime';

describe('subtractMinutesFromTime', () => {
  test('default output stays 12h (staff pages depend on this)', () => {
    expect(subtractMinutesFromTime('6:00 PM', 60)).toBe('5:00 PM');
    expect(subtractMinutesFromTime('17:00', 90)).toBe('3:30 PM');
  });

  test('hour24 option renders HH:MM', () => {
    expect(subtractMinutesFromTime('6:00 PM', 60, { hour24: true })).toBe('17:00');
    expect(subtractMinutesFromTime('9:15 AM', 30, { hour24: true })).toBe('08:45');
  });

  test('hour24 midnight wrap', () => {
    expect(subtractMinutesFromTime('12:30 AM', 90, { hour24: true })).toBe('23:00');
    expect(subtractMinutesFromTime('00:30', 30, { hour24: true })).toBe('00:00');
  });

  test('unparseable input still returns null in either mode', () => {
    expect(subtractMinutesFromTime('garbage', 60, { hour24: true })).toBeNull();
    expect(subtractMinutesFromTime(null, 60)).toBeNull();
  });
});

describe('formatSetupTime', () => {
  test('passes hour24 through and keeps the 60-minute default', () => {
    expect(formatSetupTime('6:00 PM', null)).toBe('5:00 PM');
    expect(formatSetupTime('6:00 PM', null, { hour24: true })).toBe('17:00');
    expect(formatSetupTime('18:00', 120, { hour24: true })).toBe('16:00');
  });
});
