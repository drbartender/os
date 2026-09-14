import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen } from '@testing-library/react';
import CelebrationV2 from './CelebrationV2';

jest.mock('../../../../utils/api', () => ({ __esModule: true, API_BASE_URL: 'http://test', default: {} }));

// The "What happens next?" copy must not promise a hosted client a shopping
// list: DRB stocks the bar on a hosted package and the server never stages
// one. ConfirmationStep already branches on package_category the same way.
const plan = (over = {}) => ({ client_name: 'Test', lab_enabled: false, ...over });

test('a BYOB finish promises the shopping list', () => {
  render(<CelebrationV2 plan={plan({ package_category: 'byob' })} token="t" selections={{ menuStyle: 'none' }} paidFromRedirect={false} />);
  expect(screen.getByText(/shopping list/i)).toBeInTheDocument();
});

test('a hosted finish never mentions a shopping list', () => {
  render(<CelebrationV2 plan={plan({ package_category: 'hosted' })} token="t" selections={{ menuStyle: 'custom' }} paidFromRedirect={false} />);
  expect(screen.queryByText(/shopping list/i)).toBeNull();
  expect(screen.getByText(/menu/i)).toBeInTheDocument();
});

test('a hosted finish with no menu owed still says what comes next', () => {
  render(<CelebrationV2 plan={plan({ package_category: 'hosted' })} token="t" selections={{ menuStyle: 'none' }} paidFromRedirect={false} />);
  expect(screen.queryByText(/shopping list/i)).toBeNull();
  expect(screen.getByText(/run sheet/i)).toBeInTheDocument();
});

test('a bank-debit return (redirect_status processing) says the payment is processing, never received', () => {
  render(<CelebrationV2 plan={plan({ package_category: 'byob' })} token="t" selections={{ menuStyle: 'none' }} paidFromRedirect pendingFromRedirect />);
  expect(screen.getByRole('status').textContent).toMatch(/Your bank payment is processing\./);
  expect(screen.getByRole('status').textContent).toMatch(/four to six business days/);
  expect(screen.queryByText(/Payment Received/)).toBeNull();
  expect(screen.queryByText(/processed successfully/)).toBeNull();
});

test('a card return still says Payment Received', () => {
  render(<CelebrationV2 plan={plan({ package_category: 'byob' })} token="t" selections={{ menuStyle: 'none' }} paidFromRedirect pendingFromRedirect={false} />);
  expect(screen.getByText(/Payment Received/)).toBeInTheDocument();
  expect(screen.queryByText(/bank payment is processing/)).toBeNull();
});

test('a failed return says the payment did not go through, never received', () => {
  render(<CelebrationV2 plan={plan({ package_category: 'byob' })} token="t" selections={{ menuStyle: 'none' }} paidFromRedirect={false} pendingFromRedirect={false} failedFromRedirect />);
  expect(screen.getByRole('status').textContent).toMatch(/did not go through/);
  expect(screen.queryByText(/Payment Received/)).toBeNull();
});
