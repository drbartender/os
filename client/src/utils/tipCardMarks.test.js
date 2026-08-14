import { buildTipCardMarks, buildCardMarks, splitMarkRows } from './tipCardMarks';

describe('buildTipCardMarks (sign + phone, cap 5, wallets and the credit cue lead)', () => {
  test('no input → no marks', () => {
    expect(buildTipCardMarks()).toEqual([]);
    expect(buildTipCardMarks(null)).toEqual([]);
    expect(buildTipCardMarks([])).toEqual([]);
  });

  test('Stripe-only fills the row with the whole wallet + network rail', () => {
    // Stripe ships with every tip page, so this is the FLOOR, never empty.
    expect(buildTipCardMarks(['card']))
      .toEqual(['apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('a full kit drops the generic cue rather than a real handle', () => {
    // Every network mark gives way to a rail that actually routes money to this
    // bartender. Dropping PayPal to keep a Visa logo would hide the handle from
    // the one surface that sits out all night, and Apple/Google Pay already say
    // cards are accepted.
    expect(buildTipCardMarks(['card', 'venmo', 'cashapp', 'paypal', 'zelle']))
      .toEqual(['apple', 'google', 'venmo', 'cashapp', 'paypal']);
  });

  test('the cue survives whenever the handles leave room for it', () => {
    expect(buildTipCardMarks(['card', 'venmo', 'cashapp']))
      .toEqual(['apple', 'google', 'visa', 'venmo', 'cashapp']);
  });

  test('filler expands only into slots the real methods leave', () => {
    expect(buildTipCardMarks(['card', 'venmo']))
      .toEqual(['apple', 'google', 'visa', 'venmo', 'mc']);
  });

  test('P2P without a Stripe link shows only those handles', () => {
    expect(buildTipCardMarks(['venmo', 'cashapp'])).toEqual(['venmo', 'cashapp']);
  });

  test('zelle never appears, and zelle-only yields no marks', () => {
    expect(buildTipCardMarks(['zelle'])).toEqual([]);
    expect(buildTipCardMarks(['zelle', 'venmo'])).toEqual(['venmo']);
  });

  test('never returns more than five', () => {
    expect(buildTipCardMarks(['card', 'venmo', 'cashapp', 'paypal']).length).toBe(5);
  });

  test('unknown tokens ignored, non-array tolerated', () => {
    expect(buildTipCardMarks(['bogus', 'venmo'])).toEqual(['venmo']);
    expect(buildTipCardMarks('venmo')).toEqual([]);
  });
});

describe('buildCardMarks (hand-out card, cap 8, P2P leads)', () => {
  test('a full kit shows everything, handles ahead of the networks', () => {
    expect(buildCardMarks(['card', 'venmo', 'cashapp', 'paypal', 'zelle']))
      .toEqual(['apple', 'google', 'venmo', 'cashapp', 'paypal', 'visa', 'mc', 'amex']);
  });

  test('Stripe-only matches the sign floor', () => {
    expect(buildCardMarks(['card'])).toEqual(['apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('never returns more than eight', () => {
    expect(buildCardMarks(['card', 'venmo', 'cashapp', 'paypal']).length).toBe(8);
  });

  test('no methods → no marks', () => {
    expect(buildCardMarks([])).toEqual([]);
  });
});

describe('splitMarkRows', () => {
  test('short lists stay on one row', () => {
    expect(splitMarkRows(['a', 'b', 'c', 'd'])).toEqual([['a', 'b', 'c', 'd']]);
  });

  test('balances rather than orphaning a single mark', () => {
    expect(splitMarkRows(['a', 'b', 'c', 'd', 'e'])).toEqual([['a', 'b', 'c'], ['d', 'e']]);
    expect(splitMarkRows(['a', 'b', 'c', 'd', 'e', 'f', 'g']))
      .toEqual([['a', 'b', 'c', 'd'], ['e', 'f', 'g']]);
  });

  test('eight splits evenly', () => {
    expect(splitMarkRows(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']))
      .toEqual([['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']]);
  });

  test('empty yields no rows at all, not one empty row', () => {
    expect(splitMarkRows([])).toEqual([]);
  });
});
