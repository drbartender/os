import { checkoutVisibility } from './checkoutVisibility';

const unsignedSent = { status: 'sent', client_signed_at: null };
const signedAccepted = { status: 'accepted', client_signed_at: '2026-09-05T16:00:00Z' };
const depositPaid = { status: 'deposit_paid', client_signed_at: '2026-09-05T16:00:00Z' };
const pending = { amount_cents: 10000, started_at: '2026-09-05T16:05:35Z' };

test('plain visit, unsigned sent row: sign and pay is shown, nothing is settling', () => {
  const v = checkoutVisibility({ proposal: unsignedSent, paid: false, settlePhase: 'idle', isPaid: false, pendingPayment: null });
  expect(v).toEqual({ settling: false, isPayableStatus: true, showSignAndPay: true, showPayOnly: false, showPaidCard: false, paidCardPhase: 'settling' });
});

test('redirect landed on a signed accepted row: settling, no pay controls, spinner phase', () => {
  const v = checkoutVisibility({ proposal: signedAccepted, paid: true, settlePhase: 'settling', isPaid: false, pendingPayment: null });
  expect(v.settling).toBe(true);
  expect(v.isPayableStatus).toBe(false);
  expect(v.showSignAndPay).toBe(false);
  expect(v.showPayOnly).toBe(false);
  expect(v.showPaidCard).toBe(true);
  expect(v.paidCardPhase).toBe('settling');
});

test('fallback keeps the card and names the fallback phase', () => {
  const v = checkoutVisibility({ proposal: signedAccepted, paid: true, settlePhase: 'fallback', isPaid: false, pendingPayment: null });
  expect(v.paidCardPhase).toBe('fallback');
  expect(v.showPaidCard).toBe(true);
});

test('a pending payment on an unpaid row is a settling state with the pending card, no intents, no pay controls', () => {
  for (const proposal of [unsignedSent, signedAccepted]) {
    const v = checkoutVisibility({ proposal, paid: false, settlePhase: 'idle', isPaid: false, pendingPayment: pending });
    expect(v.settling).toBe(true);
    expect(v.isPayableStatus).toBe(false);
    expect(v.showSignAndPay).toBe(false);
    expect(v.showPayOnly).toBe(false);
    expect(v.showPaidCard).toBe(true);
    expect(v.paidCardPhase).toBe('pending');
  }
});

test('a paid row is the truth: paid phase whatever the poll or the pending flag says', () => {
  const v = checkoutVisibility({ proposal: depositPaid, paid: true, settlePhase: 'fallback', isPaid: true, pendingPayment: pending });
  expect(v).toEqual({ settling: false, isPayableStatus: false, showSignAndPay: false, showPayOnly: false, showPaidCard: true, paidCardPhase: 'paid' });
});

test('signed accepted row, plain visit, nothing pending: pay-only section', () => {
  const v = checkoutVisibility({ proposal: signedAccepted, paid: false, settlePhase: 'idle', isPaid: false, pendingPayment: null });
  expect(v.showPayOnly).toBe(true);
  expect(v.showSignAndPay).toBe(false);
  expect(v.isPayableStatus).toBe(true);
});

test('a 409 latch (payBlocked) with no pending payment gates the pay controls and lands the blocked phase, not the processing card', () => {
  for (const proposal of [unsignedSent, signedAccepted]) {
    const v = checkoutVisibility({ proposal, paid: false, settlePhase: 'idle', isPaid: false, pendingPayment: null, payBlocked: true });
    expect(v.settling).toBe(true);
    expect(v.isPayableStatus).toBe(false);
    expect(v.showSignAndPay).toBe(false);
    expect(v.showPayOnly).toBe(false);
    expect(v.showPaidCard).toBe(true);
    expect(v.paidCardPhase).toBe('blocked');
  }
  const paidRow = checkoutVisibility({ proposal: depositPaid, paid: false, settlePhase: 'idle', isPaid: true, pendingPayment: null, payBlocked: true });
  expect(paidRow.paidCardPhase).toBe('paid');
});

test('a 409 latch whose reload found the processing row lands the pending phase (the row wins over the latch)', () => {
  const v = checkoutVisibility({ proposal: signedAccepted, paid: false, settlePhase: 'idle', isPaid: false, pendingPayment: pending, payBlocked: true });
  expect(v.paidCardPhase).toBe('pending');
  expect(v.showPayOnly).toBe(false);
});
