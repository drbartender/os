import { buildTipCardMarks } from './tipCardMarks';

describe('buildTipCardMarks', () => {
  test('no input → no marks', () => {
    expect(buildTipCardMarks()).toEqual([]);
    expect(buildTipCardMarks(null)).toEqual([]);
    expect(buildTipCardMarks([])).toEqual([]);
  });

  test('card → the card-network group', () => {
    expect(buildTipCardMarks(['card']))
      .toEqual(['apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('each P2P method alone', () => {
    expect(buildTipCardMarks(['venmo'])).toEqual(['venmo']);
    expect(buildTipCardMarks(['cashapp'])).toEqual(['cashapp']);
    expect(buildTipCardMarks(['paypal'])).toEqual(['paypal']);
  });

  test('zelle never appears on the sign, and zelle-only yields no marks', () => {
    // A zelle-only bartender still gets a working sign: the QR leads to the
    // chooser page, where Zelle does render.
    expect(buildTipCardMarks(['zelle'])).toEqual([]);
    expect(buildTipCardMarks(['zelle', 'venmo'])).toEqual(['venmo']);
  });

  test('the sign uses its own canonical order, not the saved order', () => {
    expect(buildTipCardMarks(['paypal', 'card', 'venmo']))
      .toEqual(['venmo', 'paypal', 'apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('everything', () => {
    expect(buildTipCardMarks(['card', 'venmo', 'cashapp', 'paypal', 'zelle']))
      .toEqual(['venmo', 'cashapp', 'paypal', 'apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('unknown tokens are ignored', () => {
    expect(buildTipCardMarks(['bogus', 'venmo'])).toEqual(['venmo']);
  });

  test('a non-array is tolerated', () => {
    expect(buildTipCardMarks('venmo')).toEqual([]);
  });
});
