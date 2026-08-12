import { buildTipCardMarks } from './tipCardMarks';

describe('buildTipCardMarks', () => {
  test('no input → no marks', () => {
    expect(buildTipCardMarks()).toEqual([]);
    expect(buildTipCardMarks(null)).toEqual([]);
    expect(buildTipCardMarks([])).toEqual([]);
  });

  test('card expands to the wallet pair plus ONE card emblem', () => {
    // Not all three networks: Visa, Mastercard and Amex are the same Stripe
    // rail, so listing them all says one thing three times.
    expect(buildTipCardMarks(['card'])).toEqual(['apple', 'google', 'visa']);
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
      .toEqual(['apple', 'google', 'visa', 'venmo', 'paypal']);
  });

  test('a full kit caps at five, and P2P is not crowded out by the card rail', () => {
    expect(buildTipCardMarks(['card', 'venmo', 'cashapp', 'paypal', 'zelle']))
      .toEqual(['apple', 'google', 'visa', 'venmo', 'cashapp']);
  });

  test('never returns more than five marks', () => {
    expect(buildTipCardMarks(['card', 'venmo', 'cashapp', 'paypal']).length).toBe(5);
  });

  test('unknown tokens are ignored', () => {
    expect(buildTipCardMarks(['bogus', 'venmo'])).toEqual(['venmo']);
  });

  test('a non-array is tolerated', () => {
    expect(buildTipCardMarks('venmo')).toEqual([]);
  });
});
