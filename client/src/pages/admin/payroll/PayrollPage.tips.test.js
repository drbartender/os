import React, { useState } from 'react';
import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet, useLocation } from 'react-router-dom';
import PayrollPage from './PayrollPage';
import api from '../../../utils/api';

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() } }));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../context/ToastContext', () => ({ useToast: () => mockToast }));
// GlobalSearchButton (inside Toolbar) throws outside AdminLayout's provider.
jest.mock('../../../context/PaletteContext', () => ({
  __esModule: true,
  usePalette: () => ({ openPalette: jest.fn() }),
  default: {},
}));

const OPEN_PERIOD = { start_date: '2026-08-18', end_date: '2026-08-24', payday: '2026-08-25', exists: false, status: null, payouts_accrued: 0 };

// Every read the page's children make on the Tips and Pay run tabs.
function routeGet(url) {
  if (url === '/admin/payroll/periods') return Promise.resolve({ data: { periods: [] } });
  if (url === '/admin/payroll/unassigned-tips') return Promise.resolve({ data: { tips: [] } });
  if (url === '/admin/payroll/deferred-tips') return Promise.resolve({ data: { tips: [] } });
  if (url === '/admin/staff-reviews') return Promise.resolve({ data: { reviews: [], bounty_cents: 1000 } });
  if (url.startsWith('/admin/tips?')) return Promise.resolve({ data: { tips: [], next_cursor: null } });
  return Promise.reject(new Error(`unexpected GET ${url}`));
}

// The hub owns the page header and hands the child { summary, setActions,
// refresh } through Outlet context; the stand-in mirrors that shape.
function HubStandIn({ summary }) {
  const [actions, setActions] = useState(null);
  const loc = useLocation();
  return (
    <div className="page">
      <div className="page-header"><div className="page-title">Staff</div>{actions}</div>
      <div data-testid="search">{loc.search}</div>
      <Outlet context={{ summary, setActions, refresh: jest.fn() }} />
    </div>
  );
}

function renderPayroll({ entry = '/staffing/payroll', summary = null } = {}) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/staffing" element={<HubStandIn summary={summary} />}>
          <Route path="payroll" element={<PayrollPage />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); api.get.mockImplementation(routeGet); });

// The tab strip was btn/btn-primary buttons in an hstack and the tab was
// labelled "Tips repair"; it is a real .seg in the shared Toolbar now, and the
// page no longer carries a header of its own (spec section 3 and section 7).
test('the views render as a .seg under the hub header, with no second page header and no back button', async () => {
  const { container } = renderPayroll({ summary: { open_period: OPEN_PERIOD, pending_reviews: 0 } });

  const seg = container.querySelector('.seg');
  expect(seg).not.toBeNull();
  expect(Array.from(seg.querySelectorAll('button')).map(b => b.textContent))
    .toEqual(['Pay run', 'History', 'Tips', '1099 / tax']);
  expect(seg.querySelector('button.active').textContent).toBe('Pay run');
  // One page header on screen, the hub's.
  expect(container.querySelectorAll('.page-header')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: /Overview/ })).toBeNull();
  // The summary reaches PayRunView: the derived window renders its card.
  expect(await screen.findByText(/Aug 18 to 24/)).toBeInTheDocument();
});

// Old bookmarks and the retired /tips redirect both land on ids this page
// renamed; they still have to open the right view.
test('a legacy ?tab=unassigned link lands on Tips: repair queues first, then the ledger', async () => {
  const { container } = renderPayroll({ entry: '/staffing/payroll?tab=unassigned' });

  await waitFor(() => expect(container.querySelector('.seg button.active').textContent).toBe('Tips'));
  // Both queues came back empty, so they collapse to one clear line.
  expect(await screen.findByText('Repair queues are clear: no unassigned tips, nothing deferred.')).toBeInTheDocument();
  expect(screen.queryByText(/No unassigned tips\./)).toBeNull();
  expect(screen.queryByText('No deferred tips. Nothing is stuck.')).toBeNull();
  // The ledger is the page below them, with its context sentence.
  expect(screen.getByText('Activity')).toBeInTheDocument();
  expect(screen.getByText(/this ledger is the cross-staff view/)).toBeInTheDocument();
});

// hideWhenEmpty must not turn a failed read into a blank space beside a line
// claiming the queues are clear.
test('a repair queue that failed to load shows its failure and blocks the clear line', async () => {
  api.get.mockImplementation((url) => (
    url === '/admin/payroll/unassigned-tips'
      ? Promise.reject(new Error('boom'))
      : routeGet(url)
  ));
  renderPayroll({ entry: '/staffing/payroll?tab=tips' });

  expect(await screen.findByText(/Failed to load unassigned tips\./)).toBeInTheDocument();
  expect(screen.queryByText(/Repair queues are clear/)).toBeNull();
});

// Both Pay run and History read ?period; a stale non-paid id bounces History
// straight back to Pay run, so a tab click drops the param.
test('switching views clears the period param', async () => {
  renderPayroll({ entry: '/staffing/payroll?tab=payrun&period=7', summary: { open_period: OPEN_PERIOD, pending_reviews: 0 } });

  expect(screen.getByTestId('search').textContent).toBe('?tab=payrun&period=7');
  fireEvent.click(screen.getByRole('button', { name: 'Tips' }));
  await waitFor(() => expect(screen.getByTestId('search').textContent).toBe('?tab=tips'));
  // Let the Tips children finish their reads inside the test.
  expect(await screen.findByText(/Repair queues are clear/)).toBeInTheDocument();
});
