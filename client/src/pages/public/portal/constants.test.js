import { mapDetailToFocus, mapArchiveRow, BOOKED, PAST } from './constants';

// Audit PAY-01 (2026-11-05): the portal detail carries balance_due, the
// contract balance net of money collected outside the contract, exactly as the
// server's shapeFocus reports it on /home. The drill-down focus reads it
// instead of recomputing total - paid, which forgave a paid syrup-only extras
// invoice; a detail without it (an older server) keeps the arithmetic.
const detail = {
  token: 'tok-R', status: 'deposit_paid', total_price: '1000.00', amount_paid: '160.00',
  event_type: 'wedding', venue_name: 'Hall', drink_plan_submitted_at: null,
};

test('balance_due comes from the detail when it is carried', () => {
  const f = mapDetailToFocus({ ...detail, balance_due: 900 });
  expect(f.total_price).toBe(1000);
  expect(f.amount_paid).toBe(160);
  expect(f.balance_due).toBe(900);
  expect(f.booked).toBe(true);
});

test('a detail without balance_due falls back to total minus paid', () => {
  for (const balance_due of [undefined, null, '', 'abc']) {
    expect(mapDetailToFocus({ ...detail, balance_due }).balance_due).toBe(840);
  }
});

test('a served zero or negative balance is kept as served (the tab gates on > 0)', () => {
  expect(mapDetailToFocus({ ...detail, balance_due: 0 }).balance_due).toBe(0);
  expect(mapDetailToFocus({ ...detail, balance_due: '-40' }).balance_due).toBe(-40);
});

test('the archive row shape and the status sets are unchanged', () => {
  expect(mapArchiveRow({ token: 't', status: 'completed', total_price: '5' }).balance_due).toBe(0);
  expect(BOOKED.has('deposit_paid')).toBe(true);
  expect(PAST.has('archived')).toBe(true);
});
