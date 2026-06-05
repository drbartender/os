import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PayoutDetail from './PayoutDetail';
import api from '../../utils/api';

// The paystub Download pre-opens a tab INSIDE the click gesture (mobile-Safari /
// popup-blocker safe), severs opener, then navigates it to the signed URL once
// the lazy-generate endpoint responds. On failure it must close the pre-opened
// tab and surface an error.
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../components/staff/PayoutEventRow', () => () => null);

const paidDetail = {
  period: { id: 1, start_date: '2026-05-01', end_date: '2026-05-15', payday: '2026-05-16', status: 'paid' },
  payout: { id: 9, status: 'paid', total_cents: 54740, paid_at: '2026-05-16', paystub_storage_key: 'k' },
  events: [],
  summary: { wages_cents: 54740, total_cents: 54740 },
};

function renderAt(periodId = '1') {
  return render(
    <MemoryRouter initialEntries={[`/pay/${periodId}`]}>
      <Routes><Route path="/pay/:periodId" element={<PayoutDetail />} /></Routes>
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); });

test('Download pre-opens a tab in the gesture and navigates it to the signed URL', async () => {
  api.get.mockImplementation((url) => {
    if (url === '/me/payouts/1') return Promise.resolve({ data: paidDetail });
    if (url === '/me/payouts/1/paystub') return Promise.resolve({ data: { url: 'https://signed.example/p.pdf' } });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const fakeTab = { location: {}, opener: {}, close: jest.fn() };
  const openSpy = jest.spyOn(window, 'open').mockReturnValue(fakeTab);

  renderAt('1');
  const btn = await screen.findByRole('button', { name: /download pdf/i });
  fireEvent.click(btn);

  await waitFor(() => expect(fakeTab.location).toBe('https://signed.example/p.pdf'));
  expect(openSpy).toHaveBeenCalledWith('', '_blank');
  expect(fakeTab.opener).toBeNull();
  openSpy.mockRestore();
});

test('paystub fetch failure closes the pre-opened tab and shows an error', async () => {
  api.get.mockImplementation((url) => {
    if (url === '/me/payouts/1') return Promise.resolve({ data: paidDetail });
    if (url === '/me/payouts/1/paystub') return Promise.reject({ message: 'Could not prepare the paystub. Try again.' });
    return Promise.reject(new Error(`unexpected ${url}`));
  });
  const fakeTab = { location: {}, opener: {}, close: jest.fn() };
  const openSpy = jest.spyOn(window, 'open').mockReturnValue(fakeTab);

  renderAt('1');
  const btn = await screen.findByRole('button', { name: /download pdf/i });
  fireEvent.click(btn);

  await waitFor(() => expect(fakeTab.close).toHaveBeenCalled());
  expect(await screen.findByText(/could not prepare the paystub/i)).toBeInTheDocument();
  openSpy.mockRestore();
});
