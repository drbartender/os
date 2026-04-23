import { parseTimeInput, formatTime12h, generateTimeOptions } from './timeOptions';

describe('parseTimeInput', () => {
  const cases12hPm = [
    ['6:30 PM', '18:30'],
    ['6:30pm', '18:30'],
    ['6:30p', '18:30'],
    ['06:30 PM', '18:30'],
    ['  6:30 PM  ', '18:30'],
    ['6 PM', '18:00'],
    ['6pm', '18:00'],
    ['6p', '18:00'],
    ['630pm', '18:30'],
    ['630p', '18:30'],
    ['12 PM', '12:00'],
    ['12:30 PM', '12:30'],
  ];
  test.each(cases12hPm)('parses 12h PM %s -> %s', (input, expected) => {
    expect(parseTimeInput(input)).toBe(expected);
  });

  const cases12hAm = [
    ['6:30 AM', '06:30'],
    ['6:30am', '06:30'],
    ['6:30a', '06:30'],
    ['12 AM', '00:00'],
    ['12:30 AM', '00:30'],
    ['1:00 AM', '01:00'],
  ];
  test.each(cases12hAm)('parses 12h AM %s -> %s', (input, expected) => {
    expect(parseTimeInput(input)).toBe(expected);
  });

  const cases24h = [
    ['18:30', '18:30'],
    ['1830', '18:30'],
    ['0:00', '00:00'],
    ['0030', '00:30'],
    ['23:59', '23:59'],
    ['08:15', '08:15'],
    ['6:15', '06:15'],
  ];
  test.each(cases24h)('parses 24h %s -> %s', (input, expected) => {
    expect(parseTimeInput(input)).toBe(expected);
  });

  const rejected = [
    '', '   ', 'asdf', '99', '25:00', '6:75', '13 PM', '0 AM',
    '6:30xm', '6::30', ':30', '123456', '6:', 'pm',
  ];
  test.each(rejected)('rejects %s', (input) => {
    expect(parseTimeInput(input)).toBeNull();
  });

  test('honors minHour bound', () => {
    expect(parseTimeInput('7:00 AM', { minHour: 8 })).toBeNull();
    expect(parseTimeInput('8:00 AM', { minHour: 8 })).toBe('08:00');
  });

  test('honors maxHour bound', () => {
    expect(parseTimeInput('11:30 PM', { maxHour: 22 })).toBeNull();
    expect(parseTimeInput('10:30 PM', { maxHour: 22 })).toBe('22:30');
  });

  test('allows any minute within bounds', () => {
    expect(parseTimeInput('6:17 PM')).toBe('18:17');
    expect(parseTimeInput('18:45')).toBe('18:45');
  });

  test('returns null for non-string input', () => {
    expect(parseTimeInput(null)).toBeNull();
    expect(parseTimeInput(undefined)).toBeNull();
    expect(parseTimeInput(630)).toBeNull();
  });
});

describe('formatTime12h', () => {
  test.each([
    ['00:00', '12:00 AM'],
    ['00:30', '12:30 AM'],
    ['06:00', '6:00 AM'],
    ['08:15', '8:15 AM'],
    ['11:59', '11:59 AM'],
    ['12:00', '12:00 PM'],
    ['13:00', '1:00 PM'],
    ['18:30', '6:30 PM'],
    ['23:30', '11:30 PM'],
  ])('formats %s -> %s', (input, expected) => {
    expect(formatTime12h(input)).toBe(expected);
  });

  test.each(['', null, undefined, 'nope', '25:00', '1830'])('returns "" for invalid %s', (input) => {
    expect(formatTime12h(input)).toBe('');
  });
});

describe('generateTimeOptions', () => {
  test('default range returns 48 slots (00:00 to 23:30)', () => {
    const slots = generateTimeOptions();
    expect(slots).toHaveLength(48);
    expect(slots[0]).toEqual({ value: '00:00', label: '12:00 AM' });
    expect(slots[47]).toEqual({ value: '23:30', label: '11:30 PM' });
  });

  test('honors custom range (8am–11pm exclusive)', () => {
    const slots = generateTimeOptions(8, 23);
    expect(slots).toHaveLength(30);
    expect(slots[0]).toEqual({ value: '08:00', label: '8:00 AM' });
    expect(slots[slots.length - 1]).toEqual({ value: '22:30', label: '10:30 PM' });
  });
});
