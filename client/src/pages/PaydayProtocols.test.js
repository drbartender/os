import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mockNavigate = jest.fn();
const mockBuild = jest.fn();

jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));
jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ refreshUser: jest.fn().mockResolvedValue() }),
}));
jest.mock('../context/ToastContext', () => ({
  useToast: () => ({ success: jest.fn(), error: jest.fn() }),
}));
// jsdom has no canvas; a button that signs by typed name stands in for the pad.
jest.mock('../components/SignaturePad', () => {
  const ReactInMock = require('react');
  return function MockSignaturePad({ onChange }) {
    return ReactInMock.createElement(
      'button',
      { type: 'button', onClick: () => onChange('Test Recruit', 'type') },
      'Sign here'
    );
  };
});
jest.mock('../utils/w9Pdf', () => {
  const actual = jest.requireActual('../utils/w9Pdf');
  return { ...actual, buildW9File: (...args) => mockBuild(...args), preloadW9Pdf: () => Promise.resolve() };
});

import api from '../utils/api';
import PaydayProtocols from './PaydayProtocols';

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn();
});

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: {} });
  mockBuild.mockResolvedValue(new File(['%PDF'], 'W9_Test_Recruit_1.pdf', { type: 'application/pdf' }));
});

function type(label, value) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillPayoutAndW9({ skipZip = false } = {}) {
  fireEvent.click(screen.getByLabelText('Venmo'));
  type(/Venmo handle/, 'testrecruit');
  type(/^1\. Name as shown/, 'Test Recruit');
  type(/^5\. Street Address/, '100 Example St');
  type(/^City/, 'Chicago');
  type(/^State/, 'IL');
  if (!skipZip) type(/^ZIP/, '60601');
  type('SSN, first 3 digits', '000');
  type('SSN, middle 2 digits', '00');
  type('SSN, last 4 digits', '0000');
  fireEvent.click(screen.getByText('Sign here'));
}

test('the W-9 has no finish button of its own; Submit Onboarding is the only one', async () => {
  render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(screen.queryByRole('button', { name: /Generate/i })).not.toBeInTheDocument();
  expect(screen.getAllByRole('button', { name: /Submit Onboarding/i })).toHaveLength(1);
});

test('one press of Submit builds the W-9 and posts it with the payout method', async () => {
  render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  fillPayoutAndW9();
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));

  await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/complete'));
  expect(mockBuild).toHaveBeenCalledTimes(1);
  expect(mockBuild.mock.calls[0][0]).toMatchObject({ name: 'Test Recruit', zip: '60601', signatureData: 'Test Recruit' });
  expect(api.post).toHaveBeenCalledTimes(1);
  const [url, body] = api.post.mock.calls[0];
  expect(url).toBe('/payment');
  expect(body.get('preferred_payment_method')).toBe('venmo');
  expect(body.get('venmo_handle')).toBe('testrecruit');
  expect(body.get('payment_username')).toBe('testrecruit');
  expect(body.get('w9')).toBeInstanceOf(File);
});

test('a missing W-9 field posts nothing and shows the error under that field', async () => {
  render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  fillPayoutAndW9({ skipZip: true });
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));

  expect(await screen.findByText('ZIP is required.')).toBeInTheDocument();
  expect(screen.getByLabelText(/^ZIP/)).toHaveAttribute('aria-invalid', 'true');
  expect(mockBuild).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});

test('a missing payout method and an empty W-9 are reported together on one press', async () => {
  render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));

  // Each message sits under its own field, not only in the banner at the bottom.
  expect(await screen.findByText('Pick how you want to be paid.')).toBeInTheDocument();
  expect(screen.getByText('Please sign the W-9.')).toBeInTheDocument();
  expect(screen.getByText(/Some answers above need a fix/, { selector: '.form-banner' })).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();
});

test('a handle typed for a method the recruit switched away from is not sent', async () => {
  render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText('Cash App'));
  type(/Cash App handle/, 'not-valid');
  fillPayoutAndW9();
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));

  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  const body = api.post.mock.calls[0][1];
  expect(body.get('preferred_payment_method')).toBe('venmo');
  expect(body.get('venmo_handle')).toBe('testrecruit');
  expect(body.get('cashapp_handle')).toBe('');
  expect(body.get('paypal_url')).toBe('');
  expect(body.get('zelle_handle')).toBe('');
});

test('masked bank numbers on file are never put back in the inputs or posted', async () => {
  api.get.mockResolvedValue({ data: {
    preferred_payment_method: 'direct_deposit', routing_number: '****0015', account_number: '****4321', w9_filename: 'w9.pdf',
  } });
  render(<PaydayProtocols />);
  expect(await screen.findByText(/bank account on file ending in 4321/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Routing Number/)).toHaveValue('');
  expect(screen.getByLabelText(/Account Number/)).toHaveValue('');

  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));
  expect(await screen.findByText('Enter your 9-digit routing number.')).toBeInTheDocument();
  expect(screen.getByLabelText(/Routing Number/)).toHaveAttribute('aria-invalid', 'true');
  expect(api.post).not.toHaveBeenCalled();
});

test('a routing number that fails the checksum is refused; a valid one is posted', async () => {
  api.get.mockResolvedValue({ data: { preferred_payment_method: 'direct_deposit', w9_filename: 'w9.pdf' } });
  render(<PaydayProtocols />);
  await screen.findByRole('button', { name: /Upload Existing W-9/i, pressed: true });
  type(/Routing Number/, '123456789');
  type(/Account Number/, '000123456');
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));
  expect(await screen.findByText(/isn't a valid routing number/)).toBeInTheDocument();
  expect(api.post).not.toHaveBeenCalled();

  type(/Routing Number/, '011000015');
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(api.post.mock.calls[0][1].get('routing_number')).toBe('011000015');
  expect(api.post.mock.calls[0][1].get('account_number')).toBe('000123456');
});

test("the server's refusal of a handle shows under that handle's field", async () => {
  api.post.mockRejectedValue({ message: 'Please fix the errors below.', fieldErrors: { venmo_handle: 'That Venmo username has a character Venmo does not allow.' } });
  render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  fillPayoutAndW9();
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));

  expect(await screen.findByText('That Venmo username has a character Venmo does not allow.')).toBeInTheDocument();
  expect(screen.getByLabelText(/Venmo handle/)).toHaveAttribute('aria-invalid', 'true');
  // The banner sits below the fields, so it never says "below".
  expect(screen.getByText(/Some answers above need a fix/, { selector: '.form-banner' })).toBeInTheDocument();
});

test('attaching a W-9 clears only the W-9 error, not the payout marks', async () => {
  const { container } = render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  fireEvent.click(screen.getByLabelText('Direct deposit'));
  fireEvent.click(screen.getByRole('button', { name: /Upload Existing W-9/i }));
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));
  expect(await screen.findByText('Please upload your signed W-9.')).toBeInTheDocument();
  expect(screen.getByText('Enter your 9-digit routing number.')).toBeInTheDocument();

  const pdf = new File(['%PDF-1.4 test'], 'w9.pdf', { type: 'application/pdf' });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [pdf] } });
  await waitFor(() => expect(screen.queryByText('Please upload your signed W-9.')).not.toBeInTheDocument());
  expect(screen.getByText('Enter your 9-digit routing number.')).toBeInTheDocument();
  expect(screen.getByLabelText(/Routing Number/)).toHaveAttribute('aria-invalid', 'true');
});

test('a payout handle is disclosed as showing on the public tip page', async () => {
  render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  for (const name of ['Venmo', 'Cash App', 'PayPal', 'Zelle']) {
    fireEvent.click(screen.getByLabelText(name));
    expect(screen.getByText(/shows on your public tip page/)).toBeInTheDocument();
  }
  fireEvent.click(screen.getByLabelText('Direct deposit'));
  expect(screen.queryByText(/shows on your public tip page/)).not.toBeInTheDocument();
  expect(screen.getByText(/never shared outside Dr. Bartender/)).toBeInTheDocument();
});

test('switching W-9 mode clears the other mode\'s errors', async () => {
  render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /Upload Existing W-9/i }));
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));
  expect(await screen.findByText('Please upload your signed W-9.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Fill Out Online/i }));
  expect(screen.queryByText('Please upload your signed W-9.')).not.toBeInTheDocument();
});

test('upload mode with a W-9 already on file submits without a new one', async () => {
  api.get.mockResolvedValue({ data: { preferred_payment_method: 'check', w9_filename: 'w9.pdf' } });
  render(<PaydayProtocols />);
  await screen.findByRole('button', { name: /Upload Existing W-9/i, pressed: true });
  fireEvent.click(screen.getByRole('button', { name: /Submit Onboarding/i }));

  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(mockBuild).not.toHaveBeenCalled();
  expect(api.post.mock.calls[0][1].get('w9')).toBeNull();
});

test('the pay-rate reading and the optional tip-handle card are gone', async () => {
  render(<PaydayProtocols />);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(screen.queryByText('Your Pay Rate')).not.toBeInTheDocument();
  expect(screen.queryByText(/Time Expectations/)).not.toBeInTheDocument();
  expect(screen.queryByText('Your public tip page')).not.toBeInTheDocument();
});
