import React from 'react';
import { render, screen } from '@testing-library/react';
import PaidCard from './PaidCard';

const full = { kind: 'full', amountPaid: 550, total: 550, remaining: 0, completed: false };
const done = { kind: 'full', amountPaid: 550, total: 550, remaining: 0, completed: true };
const deposit = { kind: 'deposit', amountPaid: 100, total: 550, remaining: 450, completed: false };
const none = { kind: 'none', amountPaid: 0, total: 350, remaining: 350, completed: false };
const base = { autopayEnrolled: false, balanceDueDate: '2026-09-12', openInvoiceToken: 'tok', drinkPlanToken: null, onRefresh: () => {} };

test('settling shows no dollar figure, no pay link, and no claim about the payment', () => {
  const { container } = render(<PaidCard phase="settling" state={none} {...base} />);
  expect(container.textContent).toMatch(/Confirming your payment/);
  expect(container.textContent).not.toMatch(/\$/);
  expect(container.textContent).not.toMatch(/went through|received|confirmed/i);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
});

test('fallback asserts nothing, shows no dollar figure or pay link, and offers refresh', () => {
  const onRefresh = jest.fn();
  const { container } = render(<PaidCard phase="fallback" state={none} {...base} onRefresh={onRefresh} />);
  expect(container.textContent).toMatch(/still confirming your payment/i);
  expect(container.textContent).not.toMatch(/\$/);
  expect(container.textContent).not.toMatch(/went through|on its way/i);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
  screen.getByRole('button', { name: /Refresh/ }).click();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('paid + full renders Fully paid, the closer-to-the-date line, and no balance', () => {
  const { container } = render(<PaidCard phase="paid" state={full} {...base} openInvoiceToken={null} drinkPlanToken="dp" />);
  expect(container.textContent).toMatch(/Fully paid\./);
  expect(container.textContent).toMatch(/closer to the date/);
  expect(container.textContent).not.toMatch(/remaining balance/i);
  expect(screen.getByText(/Open the Potion Planner/)).toBeTruthy();
});

test('paid + completed renders Fully paid with a past-tense line, never closer-to-the-date', () => {
  const { container } = render(<PaidCard phase="paid" state={done} {...base} openInvoiceToken={null} />);
  expect(container.textContent).toMatch(/Fully paid\./);
  expect(container.textContent).toMatch(/Thanks for having us/);
  expect(container.textContent).not.toMatch(/closer to the date/);
});

test('paid + deposit renders the remainder, the due date, and the pay link when an invoice is open', () => {
  const { container } = render(<PaidCard phase="paid" state={deposit} {...base} openInvoiceToken="inv-tok" />);
  expect(container.textContent).toMatch(/Deposit received\./);
  expect(container.textContent).toMatch(/\$450\.00/);
  expect(screen.getByText(/Pay balance/).getAttribute('href')).toBe('/invoice/inv-tok');
});

test('paid + deposit + autopay names the automatic charge instead of a due-by', () => {
  const { container } = render(<PaidCard phase="paid" state={deposit} {...base} autopayEnrolled openInvoiceToken={null} />);
  expect(container.textContent).toMatch(/automatically charged/);
  expect(container.textContent).toMatch(/\$450\.00/);
});

test('paid + full never offers Pay balance, even with an open invoice token', () => {
  // An open Additional-Services invoice on a fully paid row is real; a pay
  // affordance on a "Fully paid." card is exactly this lane's class of bug.
  render(<PaidCard phase="paid" state={full} {...base} openInvoiceToken="inv-tok" />);
  expect(screen.getByText(/Fully paid/)).toBeTruthy();
  expect(screen.queryByText(/Pay balance/)).toBeNull();
});

const pendingPayment = { amount_cents: 40000, started_at: '2026-09-05T16:05:35.000Z', invoice_id: 363, invoice_number: 'INV-0363' };

test('pending phase renders the processing card alone: no pay link, no paid claim', () => {
  const { container } = render(<PaidCard phase="pending" state={none} pendingPayment={pendingPayment} {...base} />);
  expect(container.textContent).toMatch(/Your bank payment is processing\./);
  expect(container.textContent).toMatch(/\$400\.00 bank payment on September 5/);
  expect(container.textContent).not.toMatch(/Deposit received|Fully paid|Confirming your payment/);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
});

test('blocked phase shows the rail\'s own 409 message, never the processing card, and offers refresh', () => {
  const onRefresh = jest.fn();
  const message = 'A bank payment for this event is waiting on a verification step. Check your email from Stripe to finish it, and it will clear four to six business days after that. If you would rather pay another way, email contact@drbartender.com.';
  const { container } = render(<PaidCard phase="blocked" state={none} blockedMessage={message} {...base} onRefresh={onRefresh} />);
  expect(container.textContent).toMatch(/already underway/);
  expect(container.textContent).toMatch(/waiting on a verification step/);
  expect(container.textContent).not.toMatch(/Your bank payment is processing|We received your|nothing more is needed/);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
  screen.getByRole('button', { name: /Refresh/ }).click();
  expect(onRefresh).toHaveBeenCalledTimes(1);
});

test('blocked phase with no message falls back to a neutral line that claims nothing', () => {
  const { container } = render(<PaidCard phase="blocked" state={none} {...base} />);
  expect(container.textContent).toMatch(/could not start another payment/);
  expect(container.textContent).not.toMatch(/\$|processing|received/i);
});

test('paid + deposit with a pending balance payment replaces the due-by line and hides Pay balance', () => {
  const { container } = render(<PaidCard phase="paid" state={deposit} pendingPayment={pendingPayment} {...base} openInvoiceToken="inv-tok" />);
  expect(container.textContent).toMatch(/Deposit received\./);
  expect(container.textContent).toMatch(/Your bank payment is processing\./);
  expect(container.textContent).not.toMatch(/is due by/);
  expect(screen.queryByText(/Pay balance/)).toBeNull();
});

test('paid + deposit + autopay with a pending balance payment never promises an automatic charge', () => {
  // Autopay will not charge while money is in flight (the server scan skips a
  // settling intent), so the autopay sentence would be false for the window.
  const { container } = render(<PaidCard phase="paid" state={deposit} pendingPayment={pendingPayment} {...base} autopayEnrolled openInvoiceToken={null} />);
  expect(container.textContent).toMatch(/Deposit received\./);
  expect(container.textContent).toMatch(/Your bank payment is processing\./);
  expect(container.textContent).not.toMatch(/automatically charged/);
  expect(container.textContent).not.toMatch(/\$450\.00/);
});

test('paid + pending renders the processing copy inside the one paid card, never a card inside a card', () => {
  const { container } = render(<PaidCard phase="paid" state={deposit} pendingPayment={pendingPayment} {...base} openInvoiceToken="inv-tok" />);
  expect(container.querySelectorAll('.proposal-paid-card').length).toBe(1);
  expect(container.querySelectorAll('h3').length).toBe(1);
});
