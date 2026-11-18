import { depositDollars } from './helpers';

// Audit PAY-06 (2026-11-05): the page reads the deposit the server will
// charge. Round 2 L2: that figure is the payload's deposit_amount_effective
// (stripeRouteHelpers.depositCentsFor on the server, with its own default for
// a row whose deposit_amount is NULL or 0); the client's literal fallback
// (100) is gone, since under a non-default STRIPE_DEPOSIT_AMOUNT it quoted a
// figure the server did not charge. The client reads only that field.
test('the effective deposit wins, as a number', () => {
  expect(depositDollars({ deposit_amount_effective: 500 })).toBe(500);
  expect(depositDollars({ deposit_amount_effective: '250.00' })).toBe(250);
});

test('the row column alone is not read: without the effective figure there is no deposit to quote, and never a literal 100', () => {
  expect(depositDollars({ deposit_amount: '500.00' })).toBe(null);
  for (const deposit_amount_effective of [undefined, null, 0, '0', '', 'abc', -5]) {
    expect(depositDollars({ deposit_amount_effective })).toBe(null);
  }
  expect(depositDollars(null)).toBe(null);
});
