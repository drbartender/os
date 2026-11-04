import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import api from '../../../utils/api';
import AdminUserDetail from './AdminUserDetail';

// The route keeps its element when only :id changes. These tests move the page
// from one staffer to another the way global search does and check that nothing
// of the first staffer reaches the second: the open edit form, and a record
// request for the first that answers late.

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn(), post: jest.fn() } }));
// Stable identities: the page's effects read toast, so a fresh object per
// render would re-run them.
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockAuth = { user: { id: 1, role: 'admin' } };
jest.mock('../../../context/AuthContext', () => ({ useAuth: () => mockAuth }));

const record = (id, name) => ({
  user: { id, email: `staff${id}@example.com`, onboarding_status: 'approved', role: 'staff', created_at: '2026-01-05T12:00:00Z' },
  progress: { onboarding_completed: true },
  profile: { preferred_name: name, hourly_rate: 25 },
  agreement: null,
  payment: { preferred_payment_method: 'venmo', payment_username: `@${name.toLowerCase()}` },
  application: null,
});

// The record GET for each id is a promise the test settles, so it can answer
// out of order; the side reads answer at once.
let pending;
beforeEach(() => {
  jest.clearAllMocks();
  pending = {};
  api.get.mockImplementation((url) => {
    const m = url.match(/^\/admin\/users\/(\d+)$/);
    if (m) return new Promise((resolve) => { pending[m[1]] = resolve; });
    if (url.startsWith('/shifts/user/')) return Promise.resolve({ data: { upcoming: [], past: [] } });
    if (url.endsWith('/stub-co-participated-proposals')) return Promise.resolve({ data: { proposal_ids: [] } });
    return Promise.resolve({ data: {} });
  });
  api.put.mockImplementation((url, body) => Promise.resolve({
    data: { profile: { preferred_name: body.preferred_name }, payment: {} },
  }));
});

function Go() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/staffing/users/2')}>go to 2</button>;
}

const mount = () => render(
  <MemoryRouter initialEntries={['/staffing/users/1']}>
    <Routes><Route path="/staffing/users/:id" element={<><AdminUserDetail /><Go /></>} /></Routes>
  </MemoryRouter>
);

const answer = async (id, name) => { await act(async () => { pending[id]({ data: record(id, name) }); }); };

test('an edit form open on one staffer is not open on the next', async () => {
  mount();
  await answer('1', 'Alpha');
  fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
  expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'go to 2' }));
  await answer('2', 'Bravo');

  expect(screen.getByRole('heading', { name: 'Bravo' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
});

test('a save after moving writes the new staffer\'s own values, never the first staffer\'s', async () => {
  mount();
  await answer('1', 'Alpha');
  fireEvent.click(screen.getByRole('button', { name: /Edit/ }));

  fireEvent.click(screen.getByRole('button', { name: 'go to 2' }));
  await answer('2', 'Bravo');
  fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });

  expect(api.put).toHaveBeenCalledTimes(1);
  const [url, body] = api.put.mock.calls[0];
  expect(url).toBe('/admin/users/2/profile');
  expect(body.preferred_name).toBe('Bravo');
  expect(body.payment_username).toBe('@bravo');
});

test('the first staffer\'s record answering late never replaces the second\'s', async () => {
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'go to 2' }));
  await answer('2', 'Bravo');
  await answer('1', 'Alpha');

  expect(screen.getByRole('heading', { name: 'Bravo' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Alpha' })).toBeNull();
});
