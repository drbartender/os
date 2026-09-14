import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';

jest.mock('react-router-dom', () => ({ useParams: () => ({ token: 'tok-1' }) }));
const mockToastSuccess = jest.fn();
jest.mock('../../context/ToastContext', () => ({ useToast: () => ({ success: (...a) => mockToastSuccess(...a), error: jest.fn() }) }));
jest.mock('@stripe/stripe-js', () => ({ loadStripe: () => Promise.resolve({}) }));

const mockConfirmPayment = jest.fn();
jest.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }) => <div data-testid="elements">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({ confirmPayment: mockConfirmPayment }),
  useElements: () => ({}),
}));

const mockApi = { get: jest.fn(), post: jest.fn() };
// The factory is hoisted above this const, so it has to reach mockApi lazily.
jest.mock('../../utils/api', () => ({
  __esModule: true,
  default: { get: (...args) => mockApi.get(...args), post: (...args) => mockApi.post(...args) },
}));

import InvoicePage from './InvoicePage';

// jsdom has no scrollIntoView; FormBanner calls it whenever it becomes visible
// (same stub as SignAndPaySection.errors.test.js).
beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

const baseInvoice = {
  id: 363, token: 'tok-1', proposal_id: 784, invoice_number: 'INV-0363', label: 'Balance',
  amount_due: 40000, amount_paid: 0, status: 'sent', due_date: '2026-09-05', created_at: '2026-09-03T12:45:52Z',
  event_date: '2026-09-19', event_type: 'Cocktail Party', client_name: 'Thekla Eftychiadou',
  line_items: [], payments: [], refunds: [], extension: null,
  pending_payment: null, pending_payment_for_this_invoice: false,
};
const pending = { amount_cents: 40000, started_at: '2026-09-05T16:05:35.000Z', invoice_id: 363, invoice_number: 'INV-0363' };

function apiGet(invoice) {
  mockApi.get.mockImplementation((url) => {
    if (url === '/invoices/t/tok-1') return Promise.resolve({ data: { invoice } });
    if (url === '/stripe/publishable-key') return Promise.resolve({ data: { key: 'pk_test' } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => { mockApi.get.mockReset(); mockApi.post.mockReset(); mockConfirmPayment.mockReset();  mockToastSuccess.mockReset(); });

test('an invoice with a pending payment shows the processing card and no Pay button, no PAID stamp', async () => {
  apiGet({ ...baseInvoice, pending_payment: pending, pending_payment_for_this_invoice: true });
  const { container } = render(<InvoicePage />);
  await waitFor(() => expect(container.textContent).toMatch(/Your bank payment is processing/));
  expect(screen.queryByRole('button', { name: /^Pay \$/ })).toBeNull();
  expect(container.querySelector('.invoice-paid-stamp')).toBeNull();
  expect(container.textContent).not.toMatch(/Payment successful/);
  // No form to build: the page must not fetch the publishable key or load Stripe.js.
  expect(mockApi.get).not.toHaveBeenCalledWith('/stripe/publishable-key');
});

test('a pending payment for another invoice on the proposal still hides Pay (D3)', async () => {
  apiGet({ ...baseInvoice, pending_payment: { ...pending, invoice_id: 999, invoice_number: 'INV-0999' }, pending_payment_for_this_invoice: false });
  const { container } = render(<InvoicePage />);
  await waitFor(() => expect(container.textContent).toMatch(/Your bank payment is processing/));
  expect(screen.queryByRole('button', { name: /^Pay \$/ })).toBeNull();
});

test('a confirm that resolves processing renders the card instead of Payment successful', async () => {
  apiGet(baseInvoice);
  mockApi.post.mockResolvedValue({ data: { clientSecret: 'cs_1' } });
  mockConfirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'processing', amount: 40000 } });
  const { container } = render(<InvoicePage />);
  await waitFor(() => screen.getByRole('button', { name: /^Pay \$400\.00/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Pay \$400\.00/ })); });
  await waitFor(() => screen.getByRole('button', { name: /Pay Now/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Pay Now/ })); });
  await waitFor(() => expect(container.textContent).toMatch(/Your bank payment is processing/));
  expect(container.textContent).toMatch(/\$400\.00 bank payment/);
  expect(container.textContent).not.toMatch(/Payment successful/);
  expect(container.querySelector('.invoice-paid-stamp')).toBeNull();
  expect(screen.queryByTestId('payment-element')).toBeNull();
  expect(mockToastSuccess).not.toHaveBeenCalled();
});

test('a confirm that resolves succeeded still renders Payment successful (cards are unchanged)', async () => {
  apiGet(baseInvoice);
  mockApi.post.mockResolvedValue({ data: { clientSecret: 'cs_1' } });
  mockConfirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'succeeded', amount: 40000 } });
  const { container } = render(<InvoicePage />);
  await waitFor(() => screen.getByRole('button', { name: /^Pay \$400\.00/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Pay \$400\.00/ })); });
  await waitFor(() => screen.getByRole('button', { name: /Pay Now/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Pay Now/ })); });
  await waitFor(() => expect(container.textContent).toMatch(/Payment successful/));
  expect(container.textContent).not.toMatch(/bank payment is processing/);
  expect(mockToastSuccess).toHaveBeenCalledWith('Payment received!');
});

test('a 409 PAYMENT_IN_FLIGHT from the rail shows its message and refetches the invoice', async () => {
  apiGet(baseInvoice);
  mockApi.post.mockRejectedValue({ status: 409, code: 'PAYMENT_IN_FLIGHT', message: 'A $400.00 payment for this event has been processing since September 5. Bank payments take four to six business days to clear, and you will get a receipt by email when it does. If you think this is a mistake, email contact@drbartender.com.' });
  const { container } = render(<InvoicePage />);
  await waitFor(() => screen.getByRole('button', { name: /^Pay \$400\.00/ }));
  const getsBefore = mockApi.get.mock.calls.filter(([u]) => u === '/invoices/t/tok-1').length;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Pay \$400\.00/ })); });
  await waitFor(() => expect(container.textContent).toMatch(/has been processing since September 5/));
  await waitFor(() => expect(mockApi.get.mock.calls.filter(([u]) => u === '/invoices/t/tok-1').length).toBe(getsBefore + 1));  // The rail refused; Pay stays hidden until a reload even if the row has no pending payment yet.
  expect(screen.queryByRole('button', { name: /^Pay \$/ })).toBeNull();
});

test('a confirm that resolves requires_action (microdeposit verification) never claims success', async () => {
  apiGet(baseInvoice);
  mockApi.post.mockResolvedValue({ data: { clientSecret: 'cs_1' } });
  mockConfirmPayment.mockResolvedValue({ paymentIntent: { id: 'pi_1', status: 'requires_action', amount: 40000, next_action: { type: 'verify_with_microdeposits' } } });
  const { container } = render(<InvoicePage />);
  await waitFor(() => screen.getByRole('button', { name: /^Pay \$400\.00/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Pay \$400\.00/ })); });
  await waitFor(() => screen.getByRole('button', { name: /Pay Now/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Pay Now/ })); });
  await waitFor(() => expect(container.textContent).toMatch(/still needs a verification step/));
  expect(container.textContent).not.toMatch(/Payment successful|bank payment is processing/);
  expect(container.querySelector('.invoice-paid-stamp')).toBeNull();
  expect(mockToastSuccess).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: /Pay Now/ }).disabled).toBe(false);
});

test('a confirm that resolves with neither error nor intent (a redirect underway) claims nothing', async () => {
  apiGet(baseInvoice);
  mockApi.post.mockResolvedValue({ data: { clientSecret: 'cs_1' } });
  mockConfirmPayment.mockResolvedValue({});
  const { container } = render(<InvoicePage />);
  await waitFor(() => screen.getByRole('button', { name: /^Pay \$400\.00/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^Pay \$400\.00/ })); });
  await waitFor(() => screen.getByRole('button', { name: /Pay Now/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Pay Now/ })); });
  await waitFor(() => expect(container.textContent).toMatch(/Taking you to your bank/));
  expect(container.textContent).not.toMatch(/Payment successful|bank payment is processing/);
  expect(container.querySelector('.invoice-paid-stamp')).toBeNull();
  expect(mockToastSuccess).not.toHaveBeenCalled();
});
