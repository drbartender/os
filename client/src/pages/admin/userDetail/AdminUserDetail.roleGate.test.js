import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from '../../../utils/api';
import AdminUserDetail from './AdminUserDetail';

// A manager can open the staff record page, but the server keeps a manager out
// of pay data (GET /api/admin/users/:id sends payment {} and no pay rate) and
// out of every action on it except Assign to event, which needs can_staff. A
// manager must see only what they can read and do; an admin keeps everything,
// short of the status and permission writes the server refuses on an admin row.

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn(), post: jest.fn() } }));
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockAuth = { user: { id: 1, role: 'admin' } };
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }));

// The record as the server sends it to each role.
const recordFor = (viewerRole, { targetRole = 'staff' } = {}) => ({
  user: { id: 5, email: 'staff5@example.com', onboarding_status: 'approved', role: targetRole, can_hire: false, can_staff: false, created_at: '2026-01-05T12:00:00Z' },
  progress: { onboarding_completed: true },
  profile: viewerRole === 'admin'
    ? { preferred_name: 'Staffer Five', hourly_rate: 25 }
    : { preferred_name: 'Staffer Five' },
  agreement: {},
  payment: viewerRole === 'admin'
    ? { preferred_payment_method: 'venmo', w9_file_url: 'w9-key', w9_filename: 'w9.pdf' }
    : {},
  application: { id: 9, full_name: 'Staffer Five' },
});

let record;
beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockImplementation((url) => {
    if (url === '/admin/users/5') return Promise.resolve({ data: record });
    if (url === '/admin/users/5/seniority') return Promise.resolve({ data: { seniority_adjustment: 0, hire_date: null, historical_events_worked: 0, computed_score: 1, events_worked: 0 } });
    if (url.startsWith('/shifts/user/')) return Promise.resolve({ data: { upcoming: [], past: [] } });
    if (url.endsWith('/stub-co-participated-proposals')) return Promise.resolve({ data: { proposal_ids: [] } });
    return Promise.resolve({ data: [] });
  });
});

const mount = async (viewer, opts) => {
  mockAuth.user = { id: 1, ...viewer };
  record = recordFor(viewer.role, opts);
  await act(async () => {
    render(
      <MemoryRouter initialEntries={['/staffing/users/5']}>
        <Routes><Route path="/staffing/users/:id" element={<AdminUserDetail />} /></Routes>
      </MemoryRouter>
    );
  });
};

const openTab = async (name) => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name })); });
};

test('a manager sees only what a manager can read and do', async () => {
  await mount({ role: 'manager', can_staff: false });
  expect(screen.getByRole('heading', { name: 'Staffer Five' })).toBeInTheDocument();

  // Header and stats.
  expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Message/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Assign to event/ })).toBeNull();
  expect(screen.queryByText(/YTD earnings/)).toBeNull();

  // Tabs the server keeps from a manager.
  expect(screen.queryByRole('button', { name: 'Payouts' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Tip Page' })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Messages/ })).toBeNull();

  // Overview: no Edit, the role and permissions read-only with the reason.
  expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
  for (const name of ['Staff', 'Manager']) expect(screen.getByRole('button', { name })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /Can hire/ })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: /Can staff/ })).toBeDisabled();
  expect(screen.getByText('Only an admin can change these.')).toBeInTheDocument();

  // Documents: no W-9 row (withheld); Application: no link to the admin-only page.
  await openTab('Documents');
  expect(screen.queryByText('W-9 (current year)')).toBeNull();
  expect(screen.getByText('Contractor agreement')).toBeInTheDocument();
  await openTab('Application');
  expect(screen.queryByText('Open full application')).toBeNull();
});

test('a manager with can_staff gets Assign to event, and nothing else more', async () => {
  await mount({ role: 'manager', can_staff: true });
  expect(screen.getByRole('button', { name: /Assign to event/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Payouts' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Edit/ })).toBeNull();
});

test('an admin keeps every control', async () => {
  await mount({ role: 'admin' });

  expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Message' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Assign to event/ })).toBeInTheDocument();
  expect(screen.getByText(/YTD earnings/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
  for (const name of ['Staff', 'Manager']) expect(screen.getByRole('button', { name })).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: /Can hire/ })).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: /Can staff/ })).toBeEnabled();
  expect(screen.queryByText('Only an admin can change these.')).toBeNull();

  await openTab('Payouts');
  expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Save seniority/ })).toBeInTheDocument();
  for (const input of screen.getAllByRole('spinbutton')) expect(input).toBeEnabled();

  await openTab('Documents');
  expect(screen.getByText('W-9 (current year)')).toBeInTheDocument();
  await openTab('Application');
  expect(screen.getByText('Open full application')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Tip Page' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Messages/ })).toBeInTheDocument();
});

test('an admin on an admin record gets no status or permission control the server refuses there', async () => {
  await mount({ role: 'admin' }, { targetRole: 'admin' });
  expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
  expect(screen.getByRole('checkbox', { name: /Can hire/ })).toBeDisabled();
  expect(screen.getByText("An admin's role and permissions are fixed.")).toBeInTheDocument();
  // Profile editing is still allowed on an admin's record.
  expect(screen.getByRole('button', { name: /Edit/ })).toBeInTheDocument();
});
