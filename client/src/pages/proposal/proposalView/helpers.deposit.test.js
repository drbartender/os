import { depositDollars, DEFAULT_DEPOSIT_DOLLARS } from './helpers';

// Audit PAY-06 (2026-11-05): the page reads the deposit off the proposal row
// (the public payload carries deposit_amount), the same figure the server
// charges through stripeRouteHelpers.depositCentsFor, with the schema default
// (100) for a row that carries none; the client's REACT_APP_DEPOSIT_AMOUNT
// copy of the figure is gone.
test('the row deposit wins, as a number', () => {
  expect(depositDollars({ deposit_amount: '500.00' })).toBe(500);
  expect(depositDollars({ deposit_amount: 250 })).toBe(250);
});

test('a missing, null, zero or unparseable deposit reads the schema default', () => {
  expect(DEFAULT_DEPOSIT_DOLLARS).toBe(100);
  for (const deposit_amount of [undefined, null, 0, '0', '', 'abc', -5]) {
    expect(depositDollars({ deposit_amount })).toBe(100);
  }
  expect(depositDollars(null)).toBe(100);
});
