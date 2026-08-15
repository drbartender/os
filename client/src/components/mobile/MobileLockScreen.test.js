import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockLogin = jest.fn();
const mockLogout = jest.fn();
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin, logout: mockLogout }),
}));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));
const mockUnlock = jest.fn();
jest.mock('../../utils/webauthnClient', () => ({
  unlockWithPasskey: (...a) => mockUnlock(...a),
}));

import MobileLockScreen from './MobileLockScreen';
import { ENROLLED_KEY, LAST_ACTIVE_KEY, LOCK_AFTER_MS, requestMobileLock } from '../../utils/mobileLock';

// jsdom has no matchMedia; a stub controls the "phone viewport" answer.
function stubViewport(matches) {
  window.matchMedia = jest.fn().mockReturnValue({
    matches, addEventListener: jest.fn(), removeEventListener: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
  stubViewport(true);
});

function armAndAge() {
  window.localStorage.setItem('token', 'tok');
  window.localStorage.setItem(ENROLLED_KEY, '1');
  window.localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - LOCK_AFTER_MS - 60_000));
}

test('renders nothing when not armed', () => {
  window.localStorage.setItem('token', 'tok');
  const { container } = render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  expect(container.firstChild).toBeNull();
});

test('overlay locks on mount after a 30-minute-old background stamp', () => {
  armAndAge();
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  expect(screen.getByRole('dialog', { name: /locked/i })).toBeInTheDocument();
});

test('gate mode always renders locked', () => {
  render(<MemoryRouter><MobileLockScreen gate /></MemoryRouter>);
  expect(screen.getByRole('dialog', { name: /locked/i })).toBeInTheDocument();
});

test('unlock success logs in and dismisses', async () => {
  mockUnlock.mockResolvedValue({ token: 'fresh', user: { id: 12 } });
  armAndAge();
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  act(() => { screen.getByRole('button', { name: 'Unlock' }).click(); });
  await waitFor(() => expect(mockLogin).toHaveBeenCalledWith('fresh', { id: 12 }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('offline unlock failure explains itself and keeps the lock', async () => {
  mockUnlock.mockRejectedValue({ status: 0, message: 'Network error.' });
  armAndAge();
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  act(() => { screen.getByRole('button', { name: 'Unlock' }).click(); });
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/offline/i));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

test('use-password logs out (purging phone state) and navigates to /login', () => {
  armAndAge();
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  act(() => { screen.getByRole('button', { name: /use password/i }).click(); });
  expect(mockLogout).toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
});

test('the overlay declines a revocation 401 so the session dies instead of hiding', () => {
  armAndAge();
  // Not locked at mount: a fresh session with no due stamp.
  window.localStorage.removeItem(LAST_ACTIVE_KEY);
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  let claimed;
  act(() => { claimed = requestMobileLock('TOKEN_VERSION_MISMATCH'); });
  expect(claimed).toBe(false);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // An ordinary expiry still claims (act() so the state update renders).
  act(() => { claimed = requestMobileLock('INVALID_TOKEN'); });
  expect(claimed).toBe(true);
  expect(screen.getByRole('dialog', { name: /locked/i })).toBeInTheDocument();
});

test('continuous foreground use never locks on a rotate: the stamp is cleared at mount', () => {
  window.localStorage.setItem('token', 'tok');
  window.localStorage.setItem(ENROLLED_KEY, '1');
  // A short background from earlier that was NOT due (5 minutes).
  window.localStorage.setItem(LAST_ACTIVE_KEY, String(Date.now() - 5 * 60 * 1000));
  render(<MemoryRouter><MobileLockScreen /></MemoryRouter>);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  // Mount cleared the spent stamp, so a rotate 31 minutes into continuous use
  // has no stale timestamp to misread as inactivity.
  expect(window.localStorage.getItem(LAST_ACTIVE_KEY)).toBeNull();
  act(() => { window.dispatchEvent(new Event('resize')); });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
