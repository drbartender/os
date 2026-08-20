import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useOutletContext } from 'react-router-dom';
import api from '../../../utils/api';
import { useAuth } from '../../../context/AuthContext';
import StaffHubLayout from './StaffHubLayout';

// babel-plugin-jest-hoist lifts these above the imports, so the modules above
// resolve to the mocks. Imports stay first, matching the rest of the suite.
jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../../../context/AuthContext', () => ({ useAuth: jest.fn() }));

const SUMMARY = {
  active_count: 16, deactivated_count: 14, former_staff_count: 5, imported_count: 9,
  new_applications: 1, pending_reviews: 1,
  open_period: { start_date: '2026-08-18', end_date: '2026-08-24', payday: '2026-08-25', exists: false, status: null, payouts_accrued: 0 },
};

function Child() {
  const { summary, setActions } = useOutletContext();
  React.useEffect(() => { setActions(<button type="button">Child action</button>); return () => setActions(null); }, [setActions]);
  return <div data-testid="child">{summary ? `active=${summary.active_count}` : 'no summary'}</div>;
}

function mount(path, role = 'admin') {
  useAuth.mockReturnValue({ user: { role } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/staffing" element={<StaffHubLayout />}>
          <Route index element={<Child />} />
          <Route path="hiring" element={<Child />} />
          <Route path="payroll" element={<Child />} />
          <Route path="reviews" element={<Child />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => { api.get.mockReset(); });

test('admin: four tabs, count on Roster, badges on Hiring and Reviews, live subtitle, child action in the header', async () => {
  api.get.mockResolvedValue({ data: SUMMARY });
  mount('/staffing');
  expect(screen.getByRole('link', { name: /Roster/ })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('16 active · pay run Aug 18 to 24 open, payday Tue Aug 25 · 1 review to confirm')).toBeInTheDocument());
  expect(screen.getByRole('link', { name: /Roster/ })).toHaveTextContent('16');
  expect(screen.getByRole('link', { name: /Hiring/ })).toHaveTextContent('1');
  expect(screen.getByRole('link', { name: /Reviews/ })).toHaveTextContent('1');
  expect(screen.getByRole('link', { name: /Payroll/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Child action' })).toBeInTheDocument();
  expect(screen.getByTestId('child')).toHaveTextContent('active=16');
});

test('manager: no tab strip, roster-only subtitle', async () => {
  api.get.mockResolvedValue({ data: { ...SUMMARY, new_applications: null, pending_reviews: null, open_period: null } });
  mount('/staffing', 'manager');
  await waitFor(() => expect(screen.getByText('16 active')).toBeInTheDocument());
  expect(screen.queryByRole('link', { name: /Hiring/ })).toBeNull();
  expect(screen.queryByRole('navigation', { name: /Staff sections/ })).toBeNull();
});

test('summary failure: tabs still render, a retry is offered, the child is unaffected', async () => {
  api.get.mockRejectedValue(new Error('boom'));
  mount('/staffing/hiring');
  await waitFor(() => expect(screen.getByRole('button', { name: /Retry/ })).toBeInTheDocument());
  expect(screen.getByRole('link', { name: /Hiring/ })).toBeInTheDocument();
  expect(screen.getByTestId('child')).toHaveTextContent('no summary');
});
