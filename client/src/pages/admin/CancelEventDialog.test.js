import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CancelEventDialog from './CancelEventDialog';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { post: jest.fn() } }));

// ToastContext exposes only success/error/info (no warning method).
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({
  useToast: () => mockToast,
}));

// B7 (known-bugs batch): when /cancel/refund reports shortfall_cents > 0 the
// dialog must tell the admin the remainder needs a manual Stripe refund, via
// toast.info plus a persistent client-alert-warning. The step driver walks the
// REAL dialog sequence: mode select -> POST /cancel/preview -> preview step ->
// POST /cancel -> done step -> POST /cancel/refund.

const PREVIEW = {
  blocking: [],
  days_out: 30,
  refund_cents: 30000,
  refund_breakdown: { gratuity_cents: 10000, excess_cents: 19000, fee_cents: 1000 },
  staff: [],
  comms_halted: [],
  email_preview: null,
};

const CANCEL_RESULT = {
  refund_cents: 30000,
  refund_breakdown: { gratuity_cents: 10000, excess_cents: 19000, fee_cents: 1000 },
};

function mockDialogApi(refundResponse) {
  api.post.mockImplementation((url) => {
    if (url === '/proposals/1/cancel/preview') return Promise.resolve({ data: PREVIEW });
    if (url === '/proposals/1/cancel/refund') return Promise.resolve({ data: refundResponse });
    if (url === '/proposals/1/cancel') return Promise.resolve({ data: CANCEL_RESULT });
    return Promise.reject(new Error(`unmocked POST ${url}`));
  });
}

// Drives mode -> preview -> done and clicks Issue refund; resolves once the
// post-refund result alert is rendered.
async function driveToRefund(refundResponse) {
  mockDialogApi(refundResponse);
  render(
    <CancelEventDialog proposalId={1} clientName="Ana Smith" onClose={jest.fn()} onCancelled={jest.fn()} />
  );

  // mode step -> preview step (POST /cancel/preview)
  fireEvent.click(screen.getByRole('button', { name: 'Review consequences' }));
  const lastName = await screen.findByPlaceholderText('Last name');

  // preview step -> done step (POST /cancel)
  fireEvent.change(lastName, { target: { value: 'Smith' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
  const issueBtn = await screen.findByRole('button', { name: 'Issue $300.00 refund' });

  // done step: issue the refund (POST /cancel/refund)
  fireEvent.click(issueBtn);
  await screen.findByText(
    refundResponse.refunded_cents > 0
      ? `Refund of $${(refundResponse.refunded_cents / 100).toFixed(2)} issued.`
      : 'Nothing left to refund on this proposal.'
  );
}

describe('CancelEventDialog refund shortfall surfacing (B7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('shortfall_cents > 0 renders the persistent warning and fires toast.info with the manual amount', async () => {
    await driveToRefund({
      refunded_cents: 10000,
      already_refunded_cents: 0,
      shortfall_cents: 20000,
      charges: [],
    });

    const warning = document.querySelector('.client-alert-warning');
    expect(warning).not.toBeNull();
    expect(warning.textContent).toMatch(/\$200\.00/);
    expect(warning.textContent).toMatch(/by hand in Stripe/i);

    expect(mockToast.info).toHaveBeenCalledWith(expect.stringContaining('$200.00'));
    expect(mockToast.info).toHaveBeenCalledWith(expect.stringContaining('refunded manually'));
  });

  test('shortfall_cents === 0 renders NO warning and keeps the plain success toast', async () => {
    await driveToRefund({
      refunded_cents: 30000,
      already_refunded_cents: 0,
      shortfall_cents: 0,
      charges: [],
    });

    expect(document.querySelector('.client-alert-warning')).toBeNull();
    expect(screen.queryByText(/by hand in Stripe/i)).toBeNull();
    expect(mockToast.success).toHaveBeenCalledWith('Refund of $300.00 issued.');
    expect(mockToast.info).not.toHaveBeenCalled();
  });
});

// api.js rejects with the flat { message, code, fieldErrors, status } shape,
// never an axios err.response, so every catch reads err.code / err.message.
describe('CancelEventDialog error surfacing (api.js reject shape)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockWith(overrides) {
    api.post.mockImplementation((url) => {
      if (overrides[url]) return overrides[url]();
      if (url === '/proposals/1/cancel/preview') return Promise.resolve({ data: PREVIEW });
      if (url === '/proposals/1/cancel') return Promise.resolve({ data: CANCEL_RESULT });
      return Promise.reject(new Error(`unmocked POST ${url}`));
    });
    render(
      <CancelEventDialog proposalId={1} clientName="Ana Smith" onClose={jest.fn()} onCancelled={jest.fn()} />
    );
  }

  async function toPreview() {
    fireEvent.click(screen.getByRole('button', { name: 'Review consequences' }));
    const lastName = await screen.findByPlaceholderText('Last name');
    fireEvent.change(lastName, { target: { value: 'Smyth' } });
  }

  test('a LAST_NAME_MISMATCH rejection shows the mismatch message', async () => {
    mockWith({
      '/proposals/1/cancel': () => Promise.reject({
        message: 'Server wording', code: 'LAST_NAME_MISMATCH', fieldErrors: undefined, status: 422,
      }),
    });
    await toPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(mockToast.error).toHaveBeenCalledWith('The last name does not match our records.');
  });

  test('any other cancel rejection shows the server message', async () => {
    mockWith({
      '/proposals/1/cancel': () => Promise.reject({
        message: 'This booking is already archived.', code: 'CONFLICT', fieldErrors: undefined, status: 409,
      }),
    });
    await toPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(mockToast.error).toHaveBeenCalledWith('This booking is already archived.');
  });

  test('a refund rejection shows the provider decline reason', async () => {
    mockWith({
      '/proposals/1/cancel/refund': () => Promise.reject({
        message: 'Refund failed: the charge was already disputed.', code: 'PAYMENT_ERROR', fieldErrors: undefined, status: 402,
      }),
    });
    await toPreview();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel event' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Issue $300.00 refund' }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(mockToast.error).toHaveBeenCalledWith('Refund failed: the charge was already disputed.');
  });

  test('a preview rejection shows the server message', async () => {
    mockWith({
      '/proposals/1/cancel/preview': () => Promise.reject({
        message: 'Proposal not found.', code: 'NOT_FOUND', fieldErrors: undefined, status: 404,
      }),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review consequences' }));
    await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
    expect(mockToast.error).toHaveBeenCalledWith('Proposal not found.');
  });
});
