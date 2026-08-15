import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

const mockGet = jest.fn();
jest.mock('../utils/api', () => ({
  __esModule: true,
  default: { get: (...a) => mockGet(...a), post: jest.fn() },
}));
const mockPurge = jest.fn();
const mockAnnounce = jest.fn();
jest.mock('../utils/adminSw', () => ({
  purgeMobileAdminState: (...a) => mockPurge(...a),
  announceAdminSwUser: (...a) => mockAnnounce(...a),
}));
const mockArmed = jest.fn(() => false);
jest.mock('../utils/mobileLock', () => {
  const real = jest.requireActual('../utils/mobileLock');
  return { ...real, phoneUnlockArmed: (...a) => mockArmed(...a) };
});

import { AuthProvider, useAuth } from './AuthContext';

function Probe() {
  const { user, loading, login } = useAuth();
  return (
    <div>
      <span data-testid="state">{loading ? 'loading' : user ? user.email : 'no-user'}</span>
      <button onClick={() => login('tok-2', { id: 2, email: 'b@x.com' })}>login</button>
    </div>
  );
}

function renderWithToken(rejection) {
  window.localStorage.setItem('token', 'tok-1');
  mockGet.mockRejectedValueOnce(rejection);
  return render(<AuthProvider><Probe /></AuthProvider>);
}

afterEach(() => {
  jest.clearAllMocks();
  window.localStorage.clear();
});

test('transport failure keeps the token and never purges (offline cold launch)', async () => {
  renderWithToken({ status: 0, code: 'NETWORK_ERROR', message: 'Network error.' });
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  expect(window.localStorage.getItem('token')).toBe('tok-1');
  expect(mockPurge).not.toHaveBeenCalled();
});

test('revocation (TOKEN_VERSION_MISMATCH) purges and clears even when armed', async () => {
  mockArmed.mockReturnValue(true);
  renderWithToken({ status: 401, code: 'TOKEN_VERSION_MISMATCH', message: 'Session expired' });
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  expect(window.localStorage.getItem('token')).toBeNull();
  expect(mockPurge).toHaveBeenCalled();
});

test('plain 401 with unlock NOT armed purges and clears (desktop behavior)', async () => {
  mockArmed.mockReturnValue(false);
  renderWithToken({ status: 401, code: 'INVALID_TOKEN', message: 'Invalid token' });
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  expect(window.localStorage.getItem('token')).toBeNull();
  expect(mockPurge).toHaveBeenCalled();
});

test('plain 401 with unlock armed keeps the token artifact and caches (lock owns re-entry)', async () => {
  mockArmed.mockReturnValue(true);
  renderWithToken({ status: 401, code: 'INVALID_TOKEN', message: 'Invalid token' });
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  expect(window.localStorage.getItem('token')).toBe('tok-1');
  expect(mockPurge).not.toHaveBeenCalled();
});

test('login stores the token, announces, and dispatches session-restored', async () => {
  const restored = jest.fn();
  window.addEventListener('session-restored', restored);
  render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('no-user'));
  act(() => { screen.getByText('login').click(); });
  expect(window.localStorage.getItem('token')).toBe('tok-2');
  expect(mockAnnounce).toHaveBeenCalledWith(2);
  expect(restored).toHaveBeenCalled();
  window.removeEventListener('session-restored', restored);
});
