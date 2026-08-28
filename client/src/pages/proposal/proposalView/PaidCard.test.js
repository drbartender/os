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
