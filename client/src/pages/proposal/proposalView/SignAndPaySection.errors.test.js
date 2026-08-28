import React from 'react';
import { render, screen } from '@testing-library/react';
import SignAndPaySection from './SignAndPaySection';

// The signature pad wants a real canvas and <Elements> wants a real Stripe
// promise; neither is what these tests are about. Stub both so the assertions
// are about the error banner and nothing else. FormBanner scrolls itself into
// view, which jsdom has no layout for.
jest.mock('../../../components/SignaturePad', () => () => <div data-testid="sigpad" />);
jest.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }) => <div data-testid="stripe-elements">{children}</div>,
  PaymentElement: () => <div data-testid="payment-element" />,
  useStripe: () => ({}),
  useElements: () => ({}),
}));

beforeAll(() => { Element.prototype.scrollIntoView = jest.fn(); });

// The state a FAILED SIGN leaves behind: handleSign clears both client secrets,
// which drives the intent effect to setLoadingIntent(true), which unmounts
// <PaymentForm/> (and the payError it was holding). The sign error therefore has
// exactly one place left to live: the banner ABOVE the form. If that message
// does not survive here, the client watches the payment box silently reset
// itself back to the saved-card view with nothing explaining why — which is how
// a 409 TOTAL_CHANGED reached a real client as "it keeps going back to Link".
const props = {
  mode: 'signAndPay',
  sigName: 'Mike Boswell',
  setSigName: () => {},
  sigData: 'data:image/png;base64,AAA',
  setSigData: () => {},
  setSigMethod: () => {},
  paymentOption: 'full',
  setPaymentOption: () => {},
  autopayChecked: false,
  setAutopayChecked: () => {},
  totalPrice: 550,
  balanceAmount: 450,
  balanceDueDate: '2026-08-29',
  fullPaymentRequired: false,
  lastMinuteHold: false,
  activeSecret: 'pi_secret_123',
  stripePromise: {},
  payLabel: 'Sign & Pay $550.00',
  payOnlyLabel: 'Pay $550.00',
  handleSign: async () => {},
  venue: {},
  setVenue: () => {},
  venueComplete: true,
  venuePrefilled: true,
  proposalVenue: {},
  fieldErrors: {},
};

const SIGN_MSG = 'Your total changed while this page was open. Take another look, then sign.';
const LOAD_MSG = 'Unable to load payment form. Please refresh the page.';

test('a sign error survives the payment-form remount it just caused', () => {
  render(<SignAndPaySection {...props} loadingIntent formError={SIGN_MSG} intentError="" />);
  expect(screen.getByRole('alert').textContent).toBe(SIGN_MSG);
});

test('the intent-load error still shows on its own', () => {
  render(<SignAndPaySection {...props} loadingIntent={false} activeSecret="" formError="" intentError={LOAD_MSG} />);
  expect(screen.getByRole('alert').textContent).toBe(LOAD_MSG);
});

test('a sign error and an intent error both show, in one banner', () => {
  render(<SignAndPaySection {...props} loadingIntent formError={SIGN_MSG} intentError={LOAD_MSG} />);
  const alerts = screen.getAllByRole('alert');
  expect(alerts).toHaveLength(1);
  expect(alerts[0].textContent).toBe(`${SIGN_MSG} ${LOAD_MSG}`);
});

test('no banner when nothing failed', () => {
  render(<SignAndPaySection {...props} loadingIntent={false} formError="" intentError="" />);
  expect(screen.queryByRole('alert')).toBeNull();
});

// The "Unable to load payment form" fallback paragraph must stay suppressed
// while EITHER banner is up, or the client gets two competing explanations.
test('the fallback paragraph stays quiet while a banner explains the failure', () => {
  render(<SignAndPaySection {...props} loadingIntent={false} activeSecret="" formError={SIGN_MSG} intentError="" />);
  expect(screen.queryByText(/contact us at contact@drbartender.com/i)).toBeNull();
});
