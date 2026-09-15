import React from 'react';
import { render } from '@testing-library/react';
import PaymentReturnNotice, { readPaymentReturn } from './PaymentReturnNotice';

test('readPaymentReturn: paid needs ?paid=true; pending needs a processing or pending redirect_status on top', () => {
  expect(readPaymentReturn('')).toEqual({ paid: false, pending: false, failed: false });
  expect(readPaymentReturn('?paid=true')).toEqual({ paid: true, pending: false, failed: false });
  expect(readPaymentReturn('?paid=true&redirect_status=succeeded')).toEqual({ paid: true, pending: false, failed: false });
  expect(readPaymentReturn('?paid=true&redirect_status=processing')).toEqual({ paid: true, pending: true, failed: false });
  expect(readPaymentReturn('?paid=true&redirect_status=pending')).toEqual({ paid: true, pending: true, failed: false });
  // Only failed is a failure, and it beats the paid flag the return URL carried in.
  expect(readPaymentReturn('?paid=true&redirect_status=failed')).toEqual({ paid: false, pending: false, failed: true });
  expect(readPaymentReturn('?redirect_status=processing')).toEqual({ paid: false, pending: false, failed: false });
});

test('a card return says Payment Received', () => {
  const { container } = render(<PaymentReturnNotice paid pending={false} />);
  expect(container.textContent).toMatch(/Payment Received/);
  expect(container.textContent).toMatch(/processed successfully/);
});

test('a bank-debit return says the payment is processing and never received or successful', () => {
  const { container } = render(<PaymentReturnNotice paid pending />);
  expect(container.querySelector('[role="status"]').textContent).toMatch(/Your bank payment is processing\./);
  expect(container.textContent).toMatch(/We received your bank payment\. Bank payments take four to six business days/);
  expect(container.textContent).not.toMatch(/Payment Received|successful|\$/);
  expect(container.textContent).not.toMatch(/—/);
  expect(container.querySelector('a').getAttribute('href')).toBe('mailto:contact@drbartender.com');
});

test('no return renders nothing', () => {
  const { container } = render(<PaymentReturnNotice paid={false} pending={false} />);
  expect(container.textContent).toBe('');
});

test('a failed return says the payment did not go through and never Payment Received', () => {
  const { container } = render(<PaymentReturnNotice {...readPaymentReturn('?paid=true&redirect_status=failed')} />);
  expect(container.querySelector('[role="status"]').textContent).toMatch(/We did not get a confirmation for that payment\./);
  expect(container.textContent).toMatch(/selections are saved/);
  expect(container.textContent).not.toMatch(/Payment Received|successful|processing/);
});

test('the received box is announced too', () => {
  const { container } = render(<PaymentReturnNotice paid pending={false} />);
  expect(container.querySelector('[role="status"]').textContent).toMatch(/Payment Received/);
});
