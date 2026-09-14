import React from 'react';
import { render } from '@testing-library/react';
import PendingPaymentsList from './PendingPaymentsList';

test('renders nothing for an empty list', () => {
  const { container } = render(<PendingPaymentsList pendingPayments={[]} />);
  expect(container.textContent).toBe('');
});

test('renders one Processing line per in-flight payment, invoice number when known', () => {
  const { container } = render(<PendingPaymentsList pendingPayments={[
    { amount_cents: 40000, started_at: '2026-09-05T16:05:35.000Z', invoice_id: 363, invoice_number: 'INV-0363' },
    { amount_cents: 10000, started_at: '2026-08-30T16:13:14.000Z', invoice_id: null, invoice_number: null },
  ]} />);
  const t = container.textContent;
  expect(t).toMatch(/Processing: \$400\.00 bank payment, started Sep 5, INV-0363/);
  expect(t).toMatch(/Processing: \$100\.00 bank payment, started Aug 30/);
  expect(t).not.toMatch(/—/);
});

test('a malformed amount or date drops its clause instead of rendering NaN or a dangling comma', () => {
  const { container } = render(<PendingPaymentsList pendingPayments={[
    { amount_cents: 'x', started_at: null, invoice_id: null, invoice_number: 'INV-0001' },
  ]} />);
  expect(container.textContent).toBe('Processing: bank payment, INV-0001');
});

test('formats the start date in local time, not UTC', () => {
  const instant = '2026-09-05T02:30:00.000Z';
  const expected = new Date(instant).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const { container } = render(<PendingPaymentsList pendingPayments={[{ amount_cents: 100, started_at: instant, invoice_id: null, invoice_number: null }]} />);
  expect(container.textContent).toBe(`Processing: $1.00 bank payment, started ${expected}`);
});
