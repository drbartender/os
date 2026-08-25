import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PayPage from './PayPage';
import api from '../../utils/api';

// The paystub list prints `Paid <date>` from payout.paid_at, a TIMESTAMPTZ.
// Sliced as a UTC day it reads one ahead for anything after ~18:00 Chicago.
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

const paidPayout = {
  id: 9, status: 'paid', total_cents: 54740, event_count: 2,
  paid_at: '2027-01-01T00:01:00.000Z', // 2026-12-31 18:01 CST on the wire
  period: { id: 1, start_date: '2026-12-18', end_date: '2026-12-24', payday: '2026-12-31', status: 'paid' },
};

function mockApi(payouts) {
  api.get.mockImplementation((url) => {
    if (url === '/me/payouts') return Promise.resolve({ data: { payouts } });
    if (url === '/me/payment-history') return Promise.resolve({ data: { history: [], blended_total_cents: 0 } });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => { jest.clearAllMocks(); });

test('an evening paid_at prints its Chicago day, not the UTC one', async () => {
  mockApi([paidPayout]);
  render(<MemoryRouter><PayPage /></MemoryRouter>);
  expect(await screen.findByText(/Dec 31/)).toBeInTheDocument();
  expect(screen.queryByText(/Jan 1/)).not.toBeInTheDocument();
});
