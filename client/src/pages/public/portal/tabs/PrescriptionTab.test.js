import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import PrescriptionTab from './PrescriptionTab';
import api from '../../../../utils/api';

// PrescriptionTab can reuse a detail fetched by PortalHome (passed as
// proposalDetail) OR fetch its own. The load-bearing guard: it must reuse the
// prop ONLY when proposalDetail.token === focus.token, else it would render a
// previously-viewed event's add-ons / payments / signature under this event's
// totals (the stale-detail bug Codex flagged).
jest.mock('../../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('@sentry/react', () => ({ captureException: jest.fn() }));
jest.mock('../ShareButton', () => () => null);

const focusA = { token: 'tok-A', total_price: 100, amount_paid: 0, balance_due: 100, booked: false };
const focusB = { token: 'tok-B', total_price: 200, amount_paid: 0, balance_due: 200, booked: false };
const detailA = {
  token: 'tok-A', package_name: 'Package A', package_includes: ['Bar setup'],
  addons: [], payments: [], client_signed_at: null,
};
const detailB = {
  token: 'tok-B', package_name: 'Package B', package_includes: [],
  addons: [], payments: [], client_signed_at: null,
};

beforeEach(() => { jest.clearAllMocks(); localStorage.clear(); });

test('reuses a token-matching proposalDetail without refetching', async () => {
  render(<PrescriptionTab focus={focusA} proposalDetail={detailA} />);
  expect(await screen.findByText('Package A')).toBeInTheDocument();
  // The change-request banner fetch always fires on mount; the guard under
  // test is that the proposal DETAIL endpoint is not refetched.
  expect(api.get).not.toHaveBeenCalledWith('/client-portal/proposals/tok-A', expect.anything());
});

test('ignores a token-MISMATCHED proposalDetail and fetches the focus token instead', async () => {
  api.get.mockResolvedValue({ data: { proposal: detailB } });
  // focus is B but the stale prop is A's detail — must NOT render A.
  render(<PrescriptionTab focus={focusB} proposalDetail={detailA} />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/client-portal/proposals/tok-B', expect.anything()));
  expect(await screen.findByText('Package B')).toBeInTheDocument();
  expect(screen.queryByText('Package A')).not.toBeInTheDocument();
});

test('fetches its own detail when no proposalDetail is provided (home.focus path)', async () => {
  api.get.mockResolvedValue({ data: { proposal: detailB } });
  render(<PrescriptionTab focus={focusB} />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/client-portal/proposals/tok-B', expect.anything()));
  expect(await screen.findByText('Package B')).toBeInTheDocument();
});

test('interpolates {bartenders}/{hours} tokens from the portal detail columns', async () => {
  const detailTokens = {
    token: 'tok-A', package_name: 'Package A',
    package_includes: ['{bartenders} professional bartender{bartenders_s}', '{hours} hours of service'],
    num_bartenders: 2, event_duration_hours: 4,
    addons: [], payments: [], client_signed_at: null,
  };
  render(<PrescriptionTab focus={focusA} proposalDetail={detailTokens} />);
  expect(await screen.findByText('2 professional bartenders')).toBeInTheDocument();
  expect(screen.getByText('4 hours of service')).toBeInTheDocument();
  expect(screen.queryByText(/\{bartenders\}/)).not.toBeInTheDocument();
});
