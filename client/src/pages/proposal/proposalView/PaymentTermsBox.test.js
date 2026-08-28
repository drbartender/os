import React from 'react';
import { render } from '@testing-library/react';
import PaymentTermsBox from './PaymentTermsBox';

const none = { kind: 'none', amountPaid: 0, total: 350, remaining: 350, completed: false };
const full = { kind: 'full', amountPaid: 550, total: 550, remaining: 0, completed: false };
const deposit = { kind: 'deposit', amountPaid: 100, total: 550, remaining: 450, completed: false };
const base = { settling: false, fullPaymentRequired: false, snapshotTotal: 350, balanceAmount: 250, balanceDueDate: '2026-08-29' };

test('settling renders the heading and no money rows at all', () => {
  const { container } = render(<PaymentTermsBox state={none} {...base} settling />);
  expect(container.textContent).toMatch(/Payment Terms/);
  expect(container.textContent).not.toMatch(/\$/);
  expect(container.textContent).not.toMatch(/Deposit Due at Signing/);
});

test('with no state prop at all it renders the pre-payment rows (safe before the parent passes it)', () => {
  const { container } = render(<PaymentTermsBox {...base} />);
  expect(container.textContent).toMatch(/Deposit Due at Signing/);
});

test('unpaid deposit terms render the pre-payment rows exactly as before', () => {
  const { container } = render(<PaymentTermsBox state={none} {...base} />);
  expect(container.textContent).toMatch(/Deposit Due at Signing/);
  expect(container.textContent).toMatch(/\$100\.00/);
  expect(container.textContent).toMatch(/Remaining Balance/);
  expect(container.textContent).toMatch(/\$250\.00/);
});

test('unpaid full-payment-required renders the single full row', () => {
  const { container } = render(<PaymentTermsBox state={none} {...base} fullPaymentRequired />);
  expect(container.textContent).toMatch(/Full Payment Due/);
  expect(container.textContent).toMatch(/\$350\.00/);
  expect(container.textContent).not.toMatch(/Deposit Due at Signing/);
});

test('a paid-in-full row never shows Deposit Due at Signing, even when full payment was required', () => {
  for (const fpr of [false, true]) {
    const { container } = render(<PaymentTermsBox state={full} {...base} fullPaymentRequired={fpr} snapshotTotal={550} balanceAmount={0} />);
    expect(container.textContent).toMatch(/Paid in full/);
    expect(container.textContent).toMatch(/\$550\.00/);
    expect(container.textContent).not.toMatch(/Deposit Due at Signing/);
    expect(container.textContent).not.toMatch(/Remaining Balance/);
    expect(container.textContent).not.toMatch(/Full Payment Due/);
  }
});

test('a deposit-paid row shows what was paid, the true remainder, and the due date', () => {
  const { container } = render(<PaymentTermsBox state={deposit} {...base} snapshotTotal={550} balanceAmount={450} balanceDueDate="2026-09-12" />);
  expect(container.textContent).toMatch(/Deposit paid/);
  expect(container.textContent).toMatch(/\$100\.00/);
  expect(container.textContent).toMatch(/Remaining balance/);
  expect(container.textContent).toMatch(/\$450\.00/);
  expect(container.textContent).toMatch(/Balance due by/);
});
