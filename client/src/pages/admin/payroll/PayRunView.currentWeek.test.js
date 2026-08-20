import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PayRunView from './PayRunView';
import api from '../../../utils/api';

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../context/ToastContext', () => ({ useToast: () => mockToast }));

const OPEN_PERIOD = { start_date: '2026-08-18', end_date: '2026-08-24', payday: '2026-08-25', exists: false, status: null, payouts_accrued: 0 };

const STALE_PERIOD = {
  id: 7, start_date: '2026-08-11', end_date: '2026-08-17', payday: '2026-08-18',
  status: 'open', owed_cents: 40266, total_cents: 40266, paid_cents: 0, paid_count: 0, pending_count: 3,
};

function routeGet(url, periods = []) {
  if (url === '/admin/payroll/periods') return Promise.resolve({ data: { periods } });
  if (url === '/admin/staff-reviews') return Promise.resolve({ data: { reviews: [], bounty_cents: 1000 } });
  if (url === '/admin/payroll/periods/7') return Promise.resolve({ data: { period: STALE_PERIOD, payouts: [] } });
  return Promise.reject(new Error(`unexpected GET ${url}`));
}

beforeEach(() => { jest.clearAllMocks(); api.get.mockImplementation(routeGet); });

const renderView = (props) => render(<MemoryRouter><PayRunView periodParam="" {...props} /></MemoryRouter>);

test('the derived window renders above an empty queue, and the queue zero state stands down', async () => {
  renderView({ openPeriod: OPEN_PERIOD, pendingReviews: 0 });
  expect(await screen.findByText(/Aug 18 to 24/)).toBeInTheDocument();
  expect(screen.getByText(/Nothing accrued yet/)).toBeInTheDocument();
  // Two empty states would otherwise stack: the card already says the week is quiet.
  expect(screen.queryByText(/Every period is paid/)).toBeNull();
  expect(api.get).not.toHaveBeenCalledWith('/admin/staff-reviews');
});

test('a pending review pulls the bounty from the staff-reviews envelope', async () => {
  const { container } = renderView({ openPeriod: OPEN_PERIOD, pendingReviews: 1 });
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/admin/staff-reviews'));
  await waitFor(() => expect(container.textContent).toContain('adds $10.00 to the next open run.'));
});

test('a week whose row already accrued leaves the queue to speak', async () => {
  renderView({ openPeriod: { ...OPEN_PERIOD, exists: true, status: 'open', payouts_accrued: 2 }, pendingReviews: 0 });
  expect(await screen.findByText(/Every period is paid/)).toBeInTheDocument();
  expect(screen.queryByText(/Nothing accrued yet/)).toBeNull();
});

test('the card sits above the queue, never among the period rows', async () => {
  api.get.mockImplementation((url) => routeGet(url, [STALE_PERIOD]));
  const { container } = renderView({ openPeriod: OPEN_PERIOD, pendingReviews: 0 });
  const card = await screen.findByText(/Aug 18 to 24/);
  const queueRow = screen.getByText(/Aug 11 .* Aug 17/);
  // Neither node contains the other, so a plain FOLLOWING is the whole answer:
  // the queue row comes after the card in document order.
  expect(card.compareDocumentPosition(queueRow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  // A real queue keeps its own zero state suppressed for the right reason.
  expect(screen.queryByText(/Every period is paid/)).toBeNull();
  expect(container.textContent).toContain('Nothing accrued yet');
});

test('no summary yet (or a manager) renders the plain queue, no card and no bounty read', async () => {
  renderView({});
  expect(await screen.findByText(/Every period is paid/)).toBeInTheDocument();
  expect(screen.queryByText(/Nothing accrued yet/)).toBeNull();
  expect(api.get).not.toHaveBeenCalledWith('/admin/staff-reviews');
});
