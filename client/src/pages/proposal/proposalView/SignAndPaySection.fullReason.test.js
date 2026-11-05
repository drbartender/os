import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import SignAndPaySection from './SignAndPaySection';

// Audit PAY-09 (2026-11-05): a contract at or below the deposit is paid in
// full in one payment. The server flags full_payment_required for it, which
// already hides the deposit tablet, and names the reason, so the explainer
// must not tell a small booking that its event is "within 2 weeks".
jest.mock('../../../components/SignaturePad', () => () => <div data-testid="sigpad" />);
jest.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }) => <div data-testid="stripe-elements">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({}),
  useElements: () => ({}),
}));

beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

const props = {
  mode: 'signAndPay',
  sigName: 'Client',
  setSigName: () => {},
  sigData: 'data:image/png;base64,AAA',
  setSigData: () => {},
  setSigMethod: () => {},
  paymentOption: 'full',
  setPaymentOption: () => {},
  autopayChecked: false,
  setAutopayChecked: () => {},
  totalPrice: 75,
  balanceAmount: 0,
  balanceDueDate: '2026-08-29',
  fullPaymentRequired: true,
  lastMinuteHold: false,
  activeSecret: 'pi_secret_123',
  stripePromise: {},
  payLabel: 'Sign & Pay $75.00',
  payOnlyLabel: 'Pay $75.00',
  handleSign: async () => {},
  venue: {},
  setVenue: () => {},
  venueComplete: true,
  venuePrefilled: true,
  proposalVenue: {},
  fieldErrors: {},
  loadingIntent: false,
  formError: '',
  intentError: '',
};

test('a total at or below the deposit explains itself and never says "within 2 weeks"', () => {
  render(<SignAndPaySection {...props} fullPaymentReason="total_at_or_below_deposit" />);
  expect(screen.getByText(/not more than the deposit/i)).toBeInTheDocument();
  expect(screen.queryByText(/within 2 weeks/i)).toBeNull();
  expect(screen.queryByText(/Deposit$/)).toBeNull();
});

test('the booking window keeps its own explainer', () => {
  render(<SignAndPaySection {...props} fullPaymentReason="booking_window" />);
  expect(screen.getByText(/within 2 weeks/i)).toBeInTheDocument();
});

test('an older payload with no reason still reads as the booking window', () => {
  render(<SignAndPaySection {...props} />);
  expect(screen.getByText(/within 2 weeks/i)).toBeInTheDocument();
});
