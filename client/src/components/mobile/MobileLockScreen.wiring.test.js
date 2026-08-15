import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Wiring proof for the GATE mount (plan fleet 2026-08-14: the ProtectedRoute
// branch needs in-task verification, not just the isolated component suite).
// The overlay mount inside AdminLayout gets its proof in the Task 13 browser
// pass against the real lane app.

const mockUseAuth = jest.fn();
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => mockUseAuth(),
}));
jest.mock('../../utils/webauthnClient', () => ({
  unlockWithPasskey: jest.fn(),
}));

import { ProtectedRoute } from '../../App';
import { ENROLLED_KEY } from '../../utils/mobileLock';

function stubViewport(matches) {
  window.matchMedia = jest.fn().mockReturnValue({
    matches, addEventListener: jest.fn(), removeEventListener: jest.fn(),
  });
}

function renderGuarded() {
  return render(
    <MemoryRouter initialEntries={['/events']}>
      <Routes>
        <Route path="/events" element={<ProtectedRoute><div>guarded content</div></ProtectedRoute>} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  mockUseAuth.mockReturnValue({ user: null, loading: false, login: jest.fn(), logout: jest.fn() });
});

test('no user + armed + token artifact: the lock gate renders, URL untouched', () => {
  stubViewport(true);
  window.localStorage.setItem('token', 'expired-artifact');
  window.localStorage.setItem(ENROLLED_KEY, '1');
  renderGuarded();
  expect(screen.getByRole('dialog', { name: /locked/i })).toBeInTheDocument();
  expect(screen.queryByText('login page')).not.toBeInTheDocument();
  expect(screen.queryByText('guarded content')).not.toBeInTheDocument();
});

test('no user without arming falls through to /login exactly as today', () => {
  stubViewport(true);
  window.localStorage.setItem('token', 'expired-artifact');
  renderGuarded();
  expect(screen.getByText('login page')).toBeInTheDocument();
});

test('no user, armed, but NO token artifact goes to /login (nothing to re-enter)', () => {
  stubViewport(true);
  window.localStorage.setItem(ENROLLED_KEY, '1');
  renderGuarded();
  expect(screen.getByText('login page')).toBeInTheDocument();
});

test('desktop width never gates, even enrolled', () => {
  stubViewport(false);
  window.localStorage.setItem('token', 'expired-artifact');
  window.localStorage.setItem(ENROLLED_KEY, '1');
  renderGuarded();
  expect(screen.getByText('login page')).toBeInTheDocument();
});

test('a live user renders the guarded children', () => {
  stubViewport(true);
  mockUseAuth.mockReturnValue({ user: { id: 12, role: 'admin' }, loading: false, login: jest.fn(), logout: jest.fn() });
  renderGuarded();
  expect(screen.getByText('guarded content')).toBeInTheDocument();
});
