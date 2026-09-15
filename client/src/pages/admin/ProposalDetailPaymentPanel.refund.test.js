import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProposalDetailPaymentPanel from './ProposalDetailPaymentPanel';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));

// Heavy children the panel composes; none of them are under test here.
jest.mock('../../components/InvoiceDropdown', () => () => null);
jest.mock('./PendingPaymentsList', () => () => null);
jest.mock('../../components/SendModal', () => ({
  __esModule: true, default: () => null, describeSendResult: () => ({ level: 'success', message: '' }),
}));
jest.mock('../../components/comms/NotifyConfirmModal', () => () => null);

// The refund scope choice (spec 2026-09-15 section 5). The panel must read the
// SERVER's netted overpayment figure, never amount_paid - total_price: the raw
// difference counts a paid Drink Plan Extras or manual invoice as excess, which
// is why prod 599 reads overpaid today and is not.
const base = {
  id: 77,
  status: 'balance_paid',
  total_price: 500,
  amount_paid: 900,
  overpayment_cents: 40000,
  off_contract_paid_cents: 0,
  max_refundable_cents: 40000,
  max_overpayment_refundable_cents: 40000,
  client_email: 'client@example.com',
};

const renderPanel = (over = {}) =>
  render(<ProposalDetailPaymentPanel proposal={{ ...base, ...over }} onUpdate={() => {}} />);

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: [] });
  api.post.mockResolvedValue({ data: { refunded: 40000, amount_paid: 500, notifications: [] } });
});

test('the overpaid chip reads the netted figure, not the raw difference', async () => {
  // Raw would say $400 here too, so use the shape that separates them: paid 260
  // on a 200 total where $60 is a paid Drink Plan Extras invoice. Netted: zero.
  renderPanel({ total_price: 200, amount_paid: 260, overpayment_cents: 0, off_contract_paid_cents: 6000 });
  expect(screen.queryByText(/Overpaid/)).toBeNull();
});

test('a genuinely overpaid proposal shows the netted amount and offers a refund', async () => {
  renderPanel();
  expect(screen.getByText(/Overpaid \$400\.00/)).toBeInTheDocument();
  expect(screen.getByText(/issue a refund/)).toBeInTheDocument();
});

test('an overpayment that cannot be returned through Stripe says to return it by hand, not to issue a refund', async () => {
  // The external_paid shape: every Stripe charge is fully credited AND the
  // invoices already match the contract, so reversing a credit would push a
  // settled invoice below the contract. Nothing to return through Stripe.
  renderPanel({ max_overpayment_refundable_cents: 0 });
  expect(screen.getByText(/Overpaid \$400\.00/)).toBeInTheDocument();
  expect(screen.getByText(/return it by hand/)).toBeInTheDocument();
});

test('an overpayment refund above the uncredited headroom is refused before the email prompt', async () => {
  renderPanel({ max_overpayment_refundable_cents: 10000 });
  fireEvent.click(screen.getByRole('button', { name: /Issue refund/ }));
  fireEvent.change(screen.getByPlaceholderText('Amount ($)'), { target: { value: '400' } });
  fireEvent.change(screen.getByPlaceholderText('Reason'), { target: { value: 'duplicate' } });
  fireEvent.click(screen.getByRole('button', { name: /Confirm refund/ }));
  await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  expect(mockToast.error.mock.calls[0][0]).toMatch(/Only \$100\.00 of this overpayment can be returned through Stripe/);
  expect(api.post).not.toHaveBeenCalled();
});

test('with no refundable Stripe charge at all the panel offers no refund form', async () => {
  renderPanel({ max_refundable_cents: 0, max_overpayment_refundable_cents: 0 });
  expect(screen.getByText(/return it by hand/)).toBeInTheDocument();
  expect(screen.getByText(/No Stripe payment on this proposal can be refunded/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Issue refund/ })).toBeNull();
});

test('the overpayment checkbox is offered and checked by default, and the request carries the scope', async () => {
  // No usable client email, so the notify modal is skipped and the POST fires
  // straight through: that is what lets this assert the wire field name, which
  // is the one thing a stubbed modal would hide.
  renderPanel({ client_email: '' });
  fireEvent.click(screen.getByRole('button', { name: /Issue refund/ }));
  expect(screen.getByRole('checkbox')).toBeChecked();
  expect(screen.getByText(/The contract total stays at \$500\.00\./)).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText('Amount ($)'), { target: { value: '400' } });
  fireEvent.change(screen.getByPlaceholderText('Reason'), { target: { value: 'duplicate payment' } });
  fireEvent.click(screen.getByRole('button', { name: /Confirm refund/ }));

  await waitFor(() => expect(api.post).toHaveBeenCalled());
  const [url, body] = api.post.mock.calls[0];
  expect(url).toBe('/stripe/refund/77');
  expect(body.total_scope).toBe('overpayment');
  expect(body.amount).toBe(400);
  expect(body.notify_client).toBe(false);
  expect(mockToast.error).not.toHaveBeenCalled();
});

test('unchecking the box sends contract scope on the wire', async () => {
  renderPanel({ client_email: '' });
  fireEvent.click(screen.getByRole('button', { name: /Issue refund/ }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByPlaceholderText('Amount ($)'), { target: { value: '400' } });
  fireEvent.change(screen.getByPlaceholderText('Reason'), { target: { value: 'service credit' } });
  fireEvent.click(screen.getByRole('button', { name: /Confirm refund/ }));
  await waitFor(() => expect(api.post).toHaveBeenCalled());
  expect(api.post.mock.calls[0][1].total_scope).toBe('contract');
});

test('no checkbox when the proposal is not overpaid: the refund can only correct the contract', async () => {
  renderPanel({ amount_paid: 500, overpayment_cents: 0, max_refundable_cents: 50000, max_overpayment_refundable_cents: 0 });
  fireEvent.click(screen.getByRole('button', { name: /Issue refund/ }));
  expect(screen.queryByRole('checkbox')).toBeNull();
});

test('an overpayment refund above the netted excess is refused before the client is asked about email', async () => {
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: /Issue refund/ }));
  fireEvent.change(screen.getByPlaceholderText('Amount ($)'), { target: { value: '500' } });
  fireEvent.change(screen.getByPlaceholderText('Reason'), { target: { value: 'too much' } });
  fireEvent.click(screen.getByRole('button', { name: /Confirm refund/ }));
  await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  expect(mockToast.error.mock.calls[0][0]).toMatch(/overpaid by \$400\.00/);
  expect(api.post).not.toHaveBeenCalled();
});

test('unchecking the box lets the same amount through as a contract correction', async () => {
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: /Issue refund/ }));
  fireEvent.click(screen.getByRole('checkbox')); // uncheck
  fireEvent.change(screen.getByPlaceholderText('Amount ($)'), { target: { value: '400' } });
  fireEvent.change(screen.getByPlaceholderText('Reason'), { target: { value: 'service credit' } });
  fireEvent.click(screen.getByRole('button', { name: /Confirm refund/ }));
  await waitFor(() => expect(mockToast.error).not.toHaveBeenCalled());
});

test('the refund history names an overpayment refund as one', async () => {
  api.get.mockResolvedValue({ data: [
    { id: 1, amount: 40000, reason: 'duplicate', status: 'succeeded', total_scope: 'overpayment',
      total_price_before: '500.00', total_price_after: '500.00', created_at: '2026-09-14T18:31:16Z' },
    { id: 2, amount: 10000, reason: 'service credit', status: 'succeeded', total_scope: 'contract',
      total_price_before: '600.00', total_price_after: '500.00', created_at: '2026-09-10T18:31:16Z' },
  ] });
  renderPanel();
  await waitFor(() => expect(screen.getByText(/duplicate/)).toBeInTheDocument());
  expect(screen.getByText(/overpayment/)).toBeInTheDocument();
});
