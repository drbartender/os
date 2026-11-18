import React from 'react';
import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import { render, screen, fireEvent, act } from '@testing-library/react';
import ProposalDetailPaymentPanel from './ProposalDetailPaymentPanel';
import api from '../../utils/api';

// The create-invoice form has no field-error slot, so a refusal must name its
// reason in the toast. The server's reserved-label refusal (audit PAY-08: every
// system label, not just Service Extension) carries its reason only in
// fieldErrors.label, and the generic "Please fix the errors below" told the
// admin nothing.

jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));

jest.mock('../../components/InvoiceDropdown', () => () => null);
jest.mock('./PendingPaymentsList', () => () => null);
jest.mock('../../components/SendModal', () => ({
  __esModule: true, default: () => null, describeSendResult: () => ({ level: 'success', message: '' }),
}));
jest.mock('../../components/comms/NotifyConfirmModal', () => () => null);

const base = {
  id: 77, status: 'deposit_paid', total_price: 1000, amount_paid: 100,
  autopay_enrolled: false, stripe_payment_method_id: null, autopay_status: null,
  client_name: 'Client Seven', client_email: 'client7@example.com',
};

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: [] });
});

test('a refused reserved label names its reason in the toast, not the generic validation line', async () => {
  const reason = 'This label is reserved for system-generated invoices. Pick a different label.';
  api.post.mockRejectedValue(Object.assign(new Error('Please fix the errors below'), {
    status: 400, code: 'VALIDATION_ERROR', fieldErrors: { label: reason },
  }));
  render(<ProposalDetailPaymentPanel proposal={base} onUpdate={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Create invoice/ }));
  fireEvent.change(screen.getByPlaceholderText(/Label/), { target: { value: 'Balance' } });
  fireEvent.change(screen.getByPlaceholderText(/Amount/), { target: { value: '50' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });

  expect(mockToast.error).toHaveBeenCalledTimes(1);
  expect(mockToast.error.mock.calls[0][0]).toBe(reason);
});

test('a refusal with no field error still shows its message', async () => {
  api.post.mockRejectedValue(Object.assign(new Error('Proposal not found.'), { status: 404, code: 'NOT_FOUND' }));
  render(<ProposalDetailPaymentPanel proposal={base} onUpdate={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: /Create invoice/ }));
  fireEvent.change(screen.getByPlaceholderText(/Label/), { target: { value: 'Rush Fee' } });
  fireEvent.change(screen.getByPlaceholderText(/Amount/), { target: { value: '50' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });

  expect(mockToast.error.mock.calls[0][0]).toBe('Proposal not found.');
});
