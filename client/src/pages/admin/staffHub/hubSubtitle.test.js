import { hubSubtitle, ymdLabel } from './hubSubtitle';

const S = {
  active_count: 16,
  pending_reviews: 1,
  open_period: { start_date: '2026-08-18', end_date: '2026-08-24', payday: '2026-08-25', exists: false, status: null, payouts_accrued: 0 },
};

test('ymdLabel formats a YMD (or a pg ISO date) in UTC, no off-by-one', () => {
  expect(ymdLabel('2026-08-18')).toBe('Aug 18');
  expect(ymdLabel('2026-08-25T00:00:00.000Z', { weekday: true })).toBe('Tue Aug 25');
});

test('admin, quiet week: names the derived window, says open, counts the review', () => {
  expect(hubSubtitle(S, { isAdmin: true }))
    .toBe('16 active · pay run Aug 18 to 24 open, payday Tue Aug 25 · 1 review to confirm');
});

test('cross-month window repeats the month; processing status replaces "open"; plural reviews', () => {
  const s = { ...S, pending_reviews: 2,
    open_period: { ...S.open_period, start_date: '2026-09-29', end_date: '2026-10-05', payday: '2026-10-06', exists: true, status: 'processing' } };
  expect(hubSubtitle(s, { isAdmin: true }))
    .toBe('16 active · pay run Sep 29 to Oct 5 processing, payday Tue Oct 6 · 2 reviews to confirm');
});

test('zero reviews says nothing to confirm; zero active says no active staff yet', () => {
  expect(hubSubtitle({ ...S, pending_reviews: 0 }, { isAdmin: true }))
    .toBe('16 active · pay run Aug 18 to 24 open, payday Tue Aug 25 · nothing to confirm');
  expect(hubSubtitle({ ...S, active_count: 0, pending_reviews: 0 }, { isAdmin: true }))
    .toMatch(/^No active staff yet · /);
});

test('manager: the roster count only; null counts render nothing', () => {
  expect(hubSubtitle({ active_count: 16, pending_reviews: null, open_period: null }, { isAdmin: false })).toBe('16 active');
  expect(hubSubtitle({ active_count: null, pending_reviews: null, open_period: null }, { isAdmin: false })).toBe('');
  expect(hubSubtitle(null, { isAdmin: true })).toBe('');
});
