import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from '../utils/api';
import AdminLayout from './AdminLayout';

// The real AdminLayout and Sidebar with their side effects stubbed, so the
// badge poll is what this file proves (spec 2026-10-06 section 4.7: a failed
// badge fetch sets inbox_waiting to null and keeps every other count). Plain
// functions where a stub must keep its behavior: CRA's resetMocks wipes a
// jest.fn implementation before every test.
jest.mock('../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, role: 'admin', name: 'Dee Admin' }, logout: () => {} }),
}));
jest.mock('../context/UserPrefsContext', () => ({ useUserPrefs: () => ({ prefs: {}, setPref: () => {} }) }));
jest.mock('../utils/adminSw', () => ({ registerAdminSw: () => Promise.resolve(), announceAdminSwUser: () => {} }));
jest.mock('../utils/installAdminPwaMeta', () => ({ installAdminPwaMeta: () => {} }));
jest.mock('@sentry/react', () => ({ setTag: () => {} }));
jest.mock('./adminos/PresenceStrip', () => ({ __esModule: true, default: () => null }));
jest.mock('./adminos/Header', () => ({ __esModule: true, default: () => null }));
jest.mock('./adminos/CommandPalette', () => ({ __esModule: true, default: () => null }));
jest.mock('./mobile/MobileLockScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('./mobile/PasskeyEnrollNudge', () => ({ __esModule: true, default: () => null }));

beforeEach(() => {
  // Desktop width: the shell with the Sidebar.
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
});

const badgeOf = (label) => screen.getByText(label).closest('.nav-item').querySelector('.nav-badge');

function mount() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="/dashboard" element={<div>overview</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

test('a failed badge fetch turns the Inbox badge into "!" and keeps every other count', async () => {
  api.get.mockResolvedValue({ data: { inbox_waiting: 3, unstaffed_events: 2 } });
  mount();
  await waitFor(() => expect(badgeOf('Inbox')).toHaveTextContent('3'));
  expect(badgeOf('Events')).toHaveTextContent('2');

  api.get.mockRejectedValue({ status: 0, code: 'NETWORK_ERROR', message: 'Network error. Check your connection.' });
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await waitFor(() => expect(badgeOf('Inbox')).toHaveTextContent('!'));
  expect(badgeOf('Events')).toHaveTextContent('2');
});

test('a server null (the count could not be computed) draws "!" too', async () => {
  api.get.mockResolvedValue({ data: { inbox_waiting: null, unstaffed_events: 1 } });
  mount();
  await waitFor(() => expect(badgeOf('Inbox')).toHaveTextContent('!'));
  expect(badgeOf('Events')).toHaveTextContent('1');
});
