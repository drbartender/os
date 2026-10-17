import { resolveColors, groundRgb, rgba, overlay, GOLD, DEFAULT_GROUND_RGB } from './menuColors';

describe('resolveColors', () => {
  test('tone dark picks the dark set', () => {
    expect(resolveColors({ pairing: 'rustic', tone: 'dark' })).toEqual({ ink: '#f2e7d3', accent: '#e5a45a', mark: '#f2e7d3' });
  });

  test('tone light and null pick the light set', () => {
    const light = { ink: '#33251a', accent: '#8e3b1c', mark: '#33251a' };
    expect(resolveColors({ pairing: 'rustic', tone: 'light' })).toEqual(light);
    expect(resolveColors({ pairing: 'rustic', tone: null })).toEqual(light);
    expect(resolveColors({ pairing: 'rustic' })).toEqual(light);
  });

  test('overrides win over either set', () => {
    expect(resolveColors({ pairing: 'tropical', tone: 'dark', ink: '#111111', accent: '#222222' }))
      .toMatchObject({ ink: '#111111', accent: '#222222' });
    expect(resolveColors({ pairing: 'tropical', tone: 'light', accent: '#abcdef' }))
      .toMatchObject({ ink: '#173a38', accent: '#abcdef' });
  });

  test('a malformed override falls back to the set', () => {
    expect(resolveColors({ pairing: 'tropical', ink: 'red', accent: '#12345' }))
      .toMatchObject({ ink: '#173a38', accent: '#cf4f37' });
  });

  test('markColor resolves to the resolved ink, the resolved accent, or gold', () => {
    const base = { pairing: 'spooky', tone: 'dark', ink: '#101010' };
    expect(resolveColors({ ...base, markColor: 'ink' }).mark).toBe('#101010');
    expect(resolveColors({ ...base, markColor: 'accent' }).mark).toBe('#f2902e');
    expect(resolveColors({ ...base, markColor: 'gold' }).mark).toBe('#d9b77e');
    expect(GOLD).toBe('#d9b77e');
    expect(resolveColors({ ...base, markColor: undefined }).mark).toBe('#101010');
  });

  test('an unknown pairing uses the default pairing', () => {
    expect(resolveColors({ pairing: 'nope' })).toMatchObject({ ink: '#2c2238', accent: '#8a6a2f' });
  });
});

test('groundRgb keeps a clean r,g,b and falls back to the light ground', () => {
  expect(groundRgb('15,24,48')).toBe('15,24,48');
  expect(groundRgb(' 15, 24 ,48 ')).toBe('15,24,48');
  expect(groundRgb(null)).toBe(DEFAULT_GROUND_RGB);
  expect(groundRgb('15,24')).toBe(DEFAULT_GROUND_RGB);
  expect(groundRgb('256,0,0')).toBe(DEFAULT_GROUND_RGB);
  expect(groundRgb('1,2,x')).toBe(DEFAULT_GROUND_RGB);
  expect(rgba('15,24,48', 0.86)).toBe('rgba(15,24,48,0.86)');
});

test('overlay: the ground at alpha over a hex, opaque (the Panel ring)', () => {
  // Chromium composites the snapshot's ring on the garden ground (252,248,250)
  // over accent #7a4a86 to (233,223,234); the border reproduces it.
  expect(overlay('252,248,250', 0.86, '#7a4a86')).toBe('rgb(234,224,234)');
  expect(overlay('15,24,48', 0.86, '#dcbc6e')).toBe('rgb(44,47,57)');
  expect(overlay('15,24,48', 0.86, 'nope')).toBe('rgb(15,24,48)');
});
