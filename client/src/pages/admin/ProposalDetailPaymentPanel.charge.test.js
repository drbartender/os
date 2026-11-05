import React from 'react';
import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import { render, screen, fireEvent, act } from '@testing-library/react';
import ProposalDetailPaymentPanel from './ProposalDetailPaymentPanel';
import api from '../../utils/api';

// Charge balance's outcome must reach the admin wherever they are: the answer
// can land after they moved to another record, where the panel's own line no
// longer shows, so both outcomes also raise a toast naming the record. A charge
// that did not go through stays visible on the panel through autopay_status.

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

// A booked proposal with autopay on and a card saved: the Charge balance button shows.
const base = {
  id: 77,
  status: 'deposit_paid',
  total_price: 1000,
  amount_paid: 100,
  autopay_enrolled: true,
  stripe_payment_method_id: 'pm_saved',
  autopay_status: null,
  client_name: 'Client Seven',
  client_email: 'client7@example.com',
};

const renderPanel = (over = {}) =>
  render(<ProposalDetailPaymentPanel proposal={{ ...base, ...over }} onUpdate={() => {}} />);

const chargeButton = () => screen.getByRole('button', { name: /Charge balance/ });

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: [] });
});

test('a declined charge raises an error toast naming the record and the reason', async () => {
  api.post.mockRejectedValue(Object.assign(new Error('Card declined: Your card has insufficient funds.'), { status: 402, code: 'CARD_DECLINED' }));
  renderPanel();
  await act(async () => { fireEvent.click(chargeButton()); });

  expect(mockToast.error).toHaveBeenCalledTimes(1);
  const msg = mockToast.error.mock.calls[0][0];
  expect(msg).toContain('Client Seven');
  expect(msg).toContain('#77');
  expect(msg).toContain('Card declined: Your card has insufficient funds.');
  // The panel's own line still shows for an admin who stayed.
  expect(screen.getByText('Card declined: Your card has insufficient funds.')).toBeInTheDocument();
});

test('a successful charge raises a success toast naming the record', async () => {
  api.post.mockResolvedValue({ data: { amount: 90000 } });
  renderPanel();
  await act(async () => { fireEvent.click(chargeButton()); });

  expect(mockToast.success).toHaveBeenCalledTimes(1);
  const msg = mockToast.success.mock.calls[0][0];
  expect(msg).toContain('$900.00');
  expect(msg).toContain('Client Seven');
  expect(msg).toContain('#77');
  expect(mockToast.error).not.toHaveBeenCalled();
});

test('a bank debit still processing is announced as started, never as charged', async () => {
  api.post.mockResolvedValue({ data: { status: 'processing', amount: 90000 } });
  renderPanel();
  await act(async () => { fireEvent.click(chargeButton()); });

  expect(mockToast.success).not.toHaveBeenCalled();
  expect(mockToast.info).toHaveBeenCalledTimes(1);
  const msg = mockToast.info.mock.calls[0][0];
  expect(msg).toContain('Bank debit of $900.00 started');
  expect(msg).toContain('Client Seven');
  expect(screen.queryByText(/Charged/)).toBeNull();
  expect(screen.getByText(/Bank debit of \$900\.00 started/)).toBeInTheDocument();
});

test('a charge that did not go through stays noted on the panel', () => {
  const { unmount } = renderPanel({ autopay_status: 'failed' });
  expect(screen.getByText(/last balance charge did not go through/)).toBeInTheDocument();
  unmount();

  renderPanel({ autopay_status: null });
  expect(screen.queryByText(/last balance charge did not go through/)).toBeNull();
});

test('a decline that lands after the admin left still names the record it was for', async () => {
  let fail;
  api.post.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
  const { unmount } = renderPanel();
  await act(async () => { fireEvent.click(chargeButton()); });
  unmount();

  await act(async () => { fail(Object.assign(new Error('Card declined: Your card was declined.'), { status: 402, code: 'CARD_DECLINED' })); });

  expect(mockToast.error).toHaveBeenCalledTimes(1);
  const msg = mockToast.error.mock.calls[0][0];
  expect(msg).toContain('Client Seven');
  expect(msg).toContain('#77');
  expect(msg).toContain('Card declined: Your card was declined.');
});

test('a refusal while money is already moving says not started, never that it failed', async () => {
  api.post.mockRejectedValue(Object.assign(new Error('A prior balance charge is already settling for this proposal'), { status: 409, code: 'CHARGE_SETTLING' }));
  renderPanel();
  await act(async () => { fireEvent.click(chargeButton()); });

  expect(mockToast.error).not.toHaveBeenCalled();
  expect(mockToast.info).toHaveBeenCalledTimes(1);
  const msg = mockToast.info.mock.calls[0][0];
  expect(msg).toContain('not started');
  expect(msg).toContain('Client Seven');
  expect(msg).not.toContain('did not go through');
  // The line under the button reads the same: muted, not the failure color.
  expect(screen.getByText(/already settling/)).toHaveAttribute('data-tone', 'muted');
});

test('a lost answer says the outcome is unknown, never that the charge failed', async () => {
  api.post.mockRejectedValue({ message: 'Network error. Check your connection.', code: 'NETWORK_ERROR', status: 0 });
  renderPanel();
  await act(async () => { fireEvent.click(chargeButton()); });

  expect(mockToast.error).toHaveBeenCalledTimes(1);
  const msg = mockToast.error.mock.calls[0][0];
  expect(msg).toContain('Could not confirm the balance charge for Client Seven (proposal #77)');
  expect(msg).not.toContain('did not go through');
});

test('a server failure that can land after the charge says the outcome is unknown', async () => {
  for (const err of [
    { message: 'An unexpected error occurred. Please try again.', code: 'INTERNAL_ERROR', status: 500 },
    { message: 'Payment temporarily unavailable. Please try again.', code: 'EXTERNAL_SERVICE_ERROR', status: 502 },
  ]) {
    jest.clearAllMocks();
    api.get.mockResolvedValue({ data: [] });
    api.post.mockRejectedValue(err);
    const { unmount } = renderPanel();
    await act(async () => { fireEvent.click(chargeButton()); });

    expect(mockToast.error).toHaveBeenCalledTimes(1);
    const msg = mockToast.error.mock.calls[0][0];
    expect(msg).toContain('Could not confirm the balance charge for Client Seven (proposal #77)');
    expect(msg).not.toContain('did not go through');
    expect(screen.getByText(/Could not confirm the charge/)).toBeInTheDocument();
    unmount();
  }
});

test('a 409 refusal reloads the record so a stale panel shows its real state; a decline does not', async () => {
  const onUpdate = jest.fn();
  api.post.mockRejectedValue(Object.assign(new Error('Proposal must be in deposit_paid status to charge balance'), { status: 409, code: 'INVALID_STATUS' }));
  const { unmount } = render(<ProposalDetailPaymentPanel proposal={base} onUpdate={onUpdate} />);
  await act(async () => { fireEvent.click(chargeButton()); });
  expect(onUpdate).toHaveBeenCalledTimes(1);
  unmount();

  const onUpdate2 = jest.fn();
  api.post.mockRejectedValue(Object.assign(new Error('Card declined: Your card was declined.'), { status: 402, code: 'CARD_DECLINED' }));
  render(<ProposalDetailPaymentPanel proposal={base} onUpdate={onUpdate2} />);
  await act(async () => { fireEvent.click(chargeButton()); });
  expect(onUpdate2).not.toHaveBeenCalled();
});
