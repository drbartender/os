import { buildTipCardMarks } from './tipCardMarks';

describe('buildTipCardMarks', () => {
  test('no input → no marks', () => {
    expect(buildTipCardMarks()).toEqual([]);
    expect(buildTipCardMarks({})).toEqual([]);
    expect(buildTipCardMarks(null)).toEqual([]);
  });

  test('stripe link only → card-network group only', () => {
    expect(buildTipCardMarks({ has_stripe_link: true }))
      .toEqual(['apple', 'google', 'visa', 'mc', 'amex']);
  });

  test('each P2P handle alone', () => {
    expect(buildTipCardMarks({ venmo_handle: 'x' })).toEqual(['venmo']);
    expect(buildTipCardMarks({ cashapp_handle: 'x' })).toEqual(['cashapp']);
    expect(buildTipCardMarks({ paypal_url: 'https://paypal.me/x' })).toEqual(['paypal']);
  });

  test('empty-string handles are treated as absent', () => {
    expect(buildTipCardMarks({ venmo_handle: '', cashapp_handle: '', paypal_url: '' }))
      .toEqual([]);
  });

  test('P2P handles without a stripe link → no card-network marks', () => {
    expect(buildTipCardMarks({ venmo_handle: 'a', cashapp_handle: 'b' }))
      .toEqual(['venmo', 'cashapp']);
  });

  test('everything → P2P first, then card-network group, canonical order', () => {
    expect(buildTipCardMarks({
      venmo_handle: 'a', cashapp_handle: 'b', paypal_url: 'c', has_stripe_link: true,
    })).toEqual(['venmo', 'cashapp', 'paypal', 'apple', 'google', 'visa', 'mc', 'amex']);
  });
});
