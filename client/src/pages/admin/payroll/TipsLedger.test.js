import React from 'react';
import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TipsLedger from './TipsLedger';
import api from '../../../utils/api';

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../context/ToastContext', () => ({ useToast: () => mockToast }));

const TIP = {
  id: 41, amount_cents: 600, refunded_amount_cents: 0, tipped_at: '2026-08-16T20:41:00Z',
  customer_email: 'guest@example.com', bartender_name: 'Ada Bar', target_user_id: 12,
  shift_id: 377, deferred_at: null, rolled_forward_at: null, dispute_won_at: null,
};

function renderLedger(entry = '/staffing/payroll?tab=tips') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/staffing/payroll" element={<TipsLedger />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => { jest.clearAllMocks(); });

// The /tips redirect carries its search params onto /staffing/payroll?tab=tips,
// which only means something because the filters are URL-backed.
test('a from param off the legacy /tips redirect is applied to the read and the row renders its derived Status', async () => {
  api.get.mockResolvedValue({ data: { tips: [TIP], next_cursor: null } });
  const { container } = renderLedger('/staffing/payroll?tab=tips&from=2026-08-01');

  expect(await screen.findByText('Ada Bar')).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/admin/tips?limit=50&from=2026-08-01');
  expect(screen.getByRole('link', { name: 'Ada Bar' })).toHaveAttribute('href', '/staffing/users/12?tab=payouts');
  expect(screen.getByText('on the Aug 16 event')).toBeInTheDocument();
  expect(Array.from(container.querySelectorAll('tbody td.num')).map(td => td.textContent)).toEqual(['$6.00']);
  expect(container.querySelector('.stat-value')).toHaveTextContent('$6.00');
  // The date input carries the redirect's value, so Clear has something to clear.
  expect(screen.getByLabelText('From')).toHaveValue('2026-08-01');
});

test('a refunded tip shows net with the gross struck through, and an unassigned tip points at the repair queue', async () => {
  api.get.mockResolvedValue({
    data: {
      tips: [
        { ...TIP, id: 42, refunded_amount_cents: 250 },
        { ...TIP, id: 43, shift_id: null, bartender_name: 'Sam Pour' },
      ],
      next_cursor: null,
    },
  });
  const { container } = renderLedger();

  expect(await screen.findByText('$3.50')).toBeInTheDocument();
  const struck = container.querySelector('tbody td.num span.tiny');
  expect(struck).toHaveTextContent('$6.00');
  expect(struck).toHaveStyle('text-decoration: line-through');
  expect(screen.getByText('refunded $2.50')).toBeInTheDocument();
  expect(screen.getByText('unassigned')).toBeInTheDocument();
  expect(screen.getByText('see the repair queue above')).toBeInTheDocument();
  // The stat sums NET, not gross: 350 + 600.
  expect(container.querySelector('.stat-value')).toHaveTextContent('$9.50');
});

test('Load more appends the next cursor page', async () => {
  api.get
    .mockResolvedValueOnce({ data: { tips: [TIP], next_cursor: 41 } })
    .mockResolvedValueOnce({ data: { tips: [{ ...TIP, id: 40, bartender_name: 'Sam Pour' }], next_cursor: null } });
  renderLedger();

  await screen.findByText('Ada Bar');
  await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Load more' })); });

  expect(await screen.findByText('Sam Pour')).toBeInTheDocument();
  expect(api.get).toHaveBeenLastCalledWith('/admin/tips?limit=50&cursor=41');
  expect(screen.getByText('Ada Bar')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

// Two clicks land before the first page resolves. Without an in-flight guard
// both fetches carry the SAME cursor, both append, and that page is counted
// twice by the "Net in view" stat (and duplicates the React keys).
test('a second Load more click while the first is in flight is ignored', async () => {
  let resolvePage2;
  const page2 = new Promise(res => { resolvePage2 = res; });
  api.get
    .mockResolvedValueOnce({ data: { tips: [TIP], next_cursor: 41 } })
    .mockReturnValue(page2);
  const { container } = renderLedger();

  await screen.findByText('Ada Bar');
  const btn = screen.getByRole('button', { name: 'Load more' });
  fireEvent.click(btn);
  fireEvent.click(btn);

  // The initial load plus exactly one page read, not two.
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(btn).toBeDisabled();
  expect(btn).toHaveTextContent('Loading…');

  await act(async () => {
    resolvePage2({ data: { tips: [{ ...TIP, id: 40, bartender_name: 'Sam Pour' }], next_cursor: null } });
  });

  expect(screen.getAllByText('Sam Pour')).toHaveLength(1);
  expect(container.querySelectorAll('tbody tr')).toHaveLength(2);
  // 600 + 600 in net cents: the appended page is counted once.
  expect(container.querySelector('.stat-value')).toHaveTextContent('$12.00');
  expect(api.get).toHaveBeenCalledTimes(2);
});

// The guard must not wedge the button when the page read fails.
test('a failed Load more re-enables the button', async () => {
  api.get.mockResolvedValueOnce({ data: { tips: [TIP], next_cursor: 41 } });
  renderLedger();
  await screen.findByText('Ada Bar');

  api.get.mockRejectedValueOnce(new Error('boom'));
  await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Load more' })); });
  expect(mockToast.error).toHaveBeenCalledWith('Could not load more tips.');

  const btn = await screen.findByRole('button', { name: 'Load more' });
  expect(btn).not.toBeDisabled();

  api.get.mockResolvedValueOnce({ data: { tips: [{ ...TIP, id: 40, bartender_name: 'Sam Pour' }], next_cursor: null } });
  await act(async () => { userEvent.click(btn); });
  expect(await screen.findByText('Sam Pour')).toBeInTheDocument();
});

test('a failed refetch drops the rows it could not refresh and Retry reloads them', async () => {
  api.get.mockResolvedValueOnce({ data: { tips: [TIP], next_cursor: null } });
  renderLedger();
  await screen.findByText('Ada Bar');

  api.get.mockRejectedValueOnce(new Error('boom'));
  // Wrapped in act: the change fires the refetch effect, whose rejection
  // settles a state update outside React's batch otherwise.
  await act(async () => {
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
  });

  expect(await screen.findByText('Could not load tips.')).toBeInTheDocument();
  expect(screen.queryByText('Ada Bar')).toBeNull();

  api.get.mockResolvedValueOnce({ data: { tips: [TIP], next_cursor: null } });
  await act(async () => { userEvent.click(screen.getByRole('button', { name: 'Retry' })); });

  expect(await screen.findByText('Ada Bar')).toBeInTheDocument();
  expect(screen.queryByText('Could not load tips.')).toBeNull();
});

// ONE Load more click plus a filter change is enough, so the loadingMore
// double-click guard does not cover this. The page-2 read was issued FOR the
// unfiltered view; by the time it lands the effect has replaced the rows with
// the date-filtered window. Appending it splices rows from OUTSIDE the
// requested window into the table and adds their cents to "Net in view",
// which sums exactly what is loaded.
test('a Load more page that lands after the date filter moved is dropped', async () => {
  let resolveStalePage;
  const stalePage = new Promise(res => { resolveStalePage = res; });
  api.get
    .mockResolvedValueOnce({ data: { tips: [TIP], next_cursor: 41 } })
    .mockReturnValueOnce(stalePage)
    .mockResolvedValueOnce({
      data: {
        tips: [{ ...TIP, id: 90, amount_cents: 100, bartender_name: 'Iris Shaker', tipped_at: '2026-08-02T18:00:00Z' }],
        next_cursor: null,
      },
    });
  const { container } = renderLedger();

  await screen.findByText('Ada Bar');
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  expect(api.get).toHaveBeenLastCalledWith('/admin/tips?limit=50&cursor=41');

  // The view identity moves while that page is still in flight.
  await act(async () => {
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
  });
  expect(api.get).toHaveBeenLastCalledWith('/admin/tips?limit=50&from=2026-08-01');
  expect(await screen.findByText('Iris Shaker')).toBeInTheDocument();

  // Now the stale page resolves, against a result set it was never read for.
  await act(async () => {
    resolveStalePage({ data: { tips: [{ ...TIP, id: 40, bartender_name: 'Sam Pour' }], next_cursor: 40 } });
  });

  // The new window's $1.00 alone, not $1.00 + the stale page's $6.00.
  expect(container.querySelector('.stat-value')).toHaveTextContent('$1.00');
  expect(screen.queryByText('Sam Pour')).toBeNull();
  expect(container.querySelectorAll('tbody tr')).toHaveLength(1);
  // The stale cursor must not resurrect paging for a view whose own page said
  // there is nothing more.
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  expect(mockToast.error).not.toHaveBeenCalled();
});
