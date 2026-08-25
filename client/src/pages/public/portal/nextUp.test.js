import { deriveNextUp } from './nextUp';

// An ARCHIVED proposal is not reachable by its own token: publicToken.js filters
// `status <> 'archived'`, so /proposal/:token is the not-found page for one.
// deriveNextUp returned the book CTA for anything not in BOOKED, and 'archived'
// is not in BOOKED, so the overview widget offered a link that could only 404
// (found 2026-08-25, introduced by the archived door-close). A past event has no
// next action, so the honest answer is none.

const base = {
  token: 'tok-1', status: 'sent', booked: false, past: false,
  balance_due: 0, open_invoice_token: null,
  drink_plan_token: null, drink_plan_submitted: false,
};

test('a past (archived) event has no next action', () => {
  expect(deriveNextUp({ ...base, status: 'archived', past: true })).toBeNull();
});

test('a past event with a balance still has no next action: its invoice was voided on archive', () => {
  expect(deriveNextUp({ ...base, status: 'archived', past: true, balance_due: 250 })).toBeNull();
});

test('an unbooked LIVE proposal still gets the book CTA', () => {
  const n = deriveNextUp(base);
  expect(n).toMatchObject({ key: 'book', href: '/proposal/tok-1' });
});

test('a booked proposal with a balance still gets the pay CTA', () => {
  const n = deriveNextUp({ ...base, status: 'confirmed', booked: true, balance_due: 100 });
  expect(n).toMatchObject({ key: 'pay' });
});

test('no focus is still null', () => {
  expect(deriveNextUp(null)).toBeNull();
});
