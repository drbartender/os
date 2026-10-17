import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import api from '../utils/api';
import AdminLayout from './AdminLayout';

// The real AdminLayout at phone width with its side effects stubbed (the
// badges suite's harness), proving the search route is a takeover (lane
// ma-f3): the screen alone in the shell, no phone header, no tab bar.
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
  // Phone width. The same stub answers the standalone query, which is
  // harmless: nothing is recorded, so nothing is restored.
  window.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
  window.localStorage.clear();
  window.sessionStorage.clear();
  api.get.mockResolvedValue({ data: {} });
});

function mount(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AdminLayout />}>
          <Route path="/search" element={<div data-testid="screen">search screen</div>} />
          <Route path="/events" element={<div data-testid="screen">events screen</div>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

test('the search route is a takeover: the screen alone in the shell', async () => {
  mount('/search');
  const s = await screen.findByTestId('screen');
  expect(s).toHaveTextContent('search screen');
  expect(document.querySelector('.m-shell')).toContainElement(s);
  expect(document.querySelector('.m-header')).toBeNull();
  expect(document.querySelector('.m-tabbar')).toBeNull();
});

test('every other phone route keeps the phone header and the tab bar', async () => {
  mount('/events');
  expect(await screen.findByTestId('screen')).toHaveTextContent('events screen');
  expect(document.querySelector('.m-header')).not.toBeNull();
  expect(document.querySelector('.m-tabbar')).not.toBeNull();
});
