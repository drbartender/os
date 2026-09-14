import React from 'react';
import { render } from '@testing-library/react';
import PendingPaymentCard from './PendingPaymentCard';

// 16:05Z is late morning in Chicago and the same calendar day in every US
// zone, so the local-time rule below is deterministic wherever jest runs.
test('renders the title, the amount, the start date, the clearing copy and the contact line, with no em dash', () => {
  const { container } = render(<PendingPaymentCard amountCents={40000} startedAt="2026-09-05T16:05:35.000Z" />);
  const t = container.textContent;
  expect(t).toMatch(/Your bank payment is processing\./);
  expect(t).toMatch(/We received your \$400\.00 bank payment on September 5\./);
  expect(t).toMatch(/four to six business days to clear/);
  expect(t).toMatch(/nothing more is needed from you/);
  expect(t).toMatch(/email contact@drbartender\.com/);
  expect(t).not.toMatch(/—/);
  expect(container.querySelector('[role="status"]')).not.toBeNull();
});

test('formats the start date in local time, not UTC: a Chicago-evening confirm stays on its own day', () => {
  // 2026-09-05T02:30Z is 21:30 on September 4 in Chicago. The assertion only
  // pins that we did NOT hard-code UTC: whatever zone jest runs in, the
  // rendered day must equal the local day of that instant.
  const instant = '2026-09-05T02:30:00.000Z';
  const expected = new Date(instant).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const { container } = render(<PendingPaymentCard amountCents={10000} startedAt={instant} />);
  expect(container.textContent).toMatch(new RegExp(`bank payment on ${expected}\\.`));
});

test('omits the amount when it is missing or not a number, omits the date when there is none, and never says paid or successful', () => {
  const { container } = render(<PendingPaymentCard amountCents={null} startedAt={null} />);
  const t = container.textContent;
  expect(t).toMatch(/We received your bank payment\. Bank payments/);
  expect(t).not.toMatch(/\$/);
  expect(t).not.toMatch(/NaN|paid in full|successful/i);
  const { container: c2 } = render(<PendingPaymentCard amountCents="garbage" startedAt="not a date" />);
  expect(c2.textContent).toMatch(/We received your bank payment\. Bank payments/);
});

test('bare renders one paragraph with the title inline and no card chrome', () => {
  const { container } = render(<PendingPaymentCard amountCents={40000} startedAt="2026-09-05T16:05:35.000Z" bare />);
  expect(container.querySelector('.proposal-paid-card')).toBeNull();
  expect(container.querySelector('h3')).toBeNull();
  expect(container.querySelector('p strong').textContent).toBe('Your bank payment is processing.');
  expect(container.textContent).toMatch(/\$400\.00 bank payment on September 5/);
});
