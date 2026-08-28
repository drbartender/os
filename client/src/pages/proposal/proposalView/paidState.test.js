import { PAID_STATES, isPaidState, paidState, readRedirect } from './paidState';

// The exact row Mike Boswell's browser received at 17:04:11 on 2026-08-28:
// the webhook had not committed, so the row still said unpaid and pre-tip.
const mikePreCommit = { status: 'accepted', amount_paid: '0', total_price: '350.00' };

test('PAID_STATES matches the set balanceAmount already used (inPaidState), completed included', () => {
  expect(PAID_STATES).toEqual(['deposit_paid', 'balance_paid', 'confirmed', 'completed']);
  expect(isPaidState('completed')).toBe(true);
  expect(isPaidState('accepted')).toBe(false);
  expect(isPaidState(undefined)).toBe(false);
});

test('the pre-commit row is NOT paid, whatever the URL says', () => {
  expect(paidState(mikePreCommit)).toEqual({ kind: 'none', amountPaid: 0, total: 350, remaining: 350, completed: false });
});

test('balance_paid is full regardless of the arithmetic', () => {
  const s = paidState({ status: 'balance_paid', amount_paid: '550.00', total_price: '550.00' });
  expect(s.kind).toBe('full');
  expect(s.remaining).toBe(0);
});

test('completed is full, and says so', () => {
  const s = paidState({ status: 'completed', amount_paid: '550', total_price: '550' });
  expect(s.kind).toBe('full');
  expect(s.completed).toBe(true);
});

test('confirmed with amount_paid covering the row total is full, within a cent', () => {
  expect(paidState({ status: 'confirmed', amount_paid: '550', total_price: '550' }).kind).toBe('full');
  expect(paidState({ status: 'confirmed', amount_paid: '549.995', total_price: '550' }).kind).toBe('full');
});

test('deposit_paid with money still owed is deposit; the remainder uses the RENDERED total when given', () => {
  const s = paidState({ status: 'deposit_paid', amount_paid: '100', total_price: '550' }, 560);
  expect(s.kind).toBe('deposit');
  expect(s.amountPaid).toBe(100);
  expect(s.total).toBe(550);
  expect(s.remaining).toBe(460);
});

test('the remainder falls back to the row total when no rendered total is given', () => {
  expect(paidState({ status: 'deposit_paid', amount_paid: '100', total_price: '550' }).remaining).toBe(450);
});

test('a NaN rendered total falls back to the row total, never to zero', () => {
  expect(paidState({ status: 'deposit_paid', amount_paid: '100', total_price: '550' }, NaN).remaining).toBe(450);
});

test('an unparseable rendered total falls back to the row total too', () => {
  expect(paidState({ status: 'deposit_paid', amount_paid: '100', total_price: '550' }, 'abc').remaining).toBe(450);
});

test('remaining never goes negative on an overpaid row', () => {
  expect(paidState({ status: 'balance_paid', amount_paid: '600', total_price: '550' }).remaining).toBe(0);
});

test('a null or missing proposal is none', () => {
  expect(paidState(null).kind).toBe('none');
  expect(paidState(undefined).kind).toBe('none');
});

test('kind is gated on status first: accepted with full arithmetic is still none', () => {
  expect(paidState({ status: 'accepted', amount_paid: '550', total_price: '550' }).kind).toBe('none');
});

test('readRedirect: paid=true alone is a redirect that did not fail', () => {
  expect(readRedirect('?paid=true')).toEqual({ redirected: true, failed: false });
});

test('readRedirect: redirect_status=succeeded and =pending are both redirects that did not fail', () => {
  expect(readRedirect('?paid=true&payment_intent=pi_1&redirect_status=succeeded')).toEqual({ redirected: true, failed: false });
  expect(readRedirect('?paid=true&redirect_status=pending')).toEqual({ redirected: true, failed: false });
});

test('readRedirect: only redirect_status=failed is a failure', () => {
  expect(readRedirect('?paid=true&redirect_status=failed')).toEqual({ redirected: true, failed: true });
});

test('readRedirect: no paid flag is not a redirect at all', () => {
  expect(readRedirect('')).toEqual({ redirected: false, failed: false });
  expect(readRedirect('?choose=1')).toEqual({ redirected: false, failed: false });
});
