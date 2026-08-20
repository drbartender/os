import { tipStatus, netCents } from './tipStatus';

const base = { amount_cents: 600, refunded_amount_cents: 0, shift_id: 377, deferred_at: null, rolled_forward_at: null, dispute_won_at: null, tipped_at: '2026-08-16T20:41:00Z' };

test('first match wins, in the spec order', () => {
  expect(tipStatus({ ...base, dispute_won_at: '2026-08-20T00:00:00Z' }).label).toBe('dispute won');
  expect(tipStatus({ ...base, refunded_amount_cents: 600 }).label).toBe('refunded $6.00');
  expect(tipStatus({ ...base, deferred_at: '2026-08-17T00:00:00Z' }).label).toBe('deferred, waiting for an open period');
  expect(tipStatus({ ...base, shift_id: null }).label).toBe('unassigned');
  expect(tipStatus({ ...base, rolled_forward_at: '2026-08-19T12:00:00Z' }).label).toBe('rolled forward Aug 19');
  expect(tipStatus(base).label).toBe('on the Aug 16 event');
});

test('net strips refunds and never goes negative', () => {
  expect(netCents({ amount_cents: 600, refunded_amount_cents: 250 })).toBe(350);
  expect(netCents({ amount_cents: 600, refunded_amount_cents: 900 })).toBe(0);
  expect(netCents({ amount_cents: 600 })).toBe(600);
});
