import '@testing-library/jest-dom';
import React from 'react';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockToastError = jest.fn();
jest.mock('../context/ToastContext', () => ({ useToast: () => ({ error: mockToastError }) }));
const mockLogout = jest.fn();
jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ logout: mockLogout }) }));
const mockClientLogout = jest.fn();
jest.mock('../context/ClientAuthContext', () => ({ useClientAuth: () => ({ clientLogout: mockClientLogout }) }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));
const mockRequestLock = jest.fn(() => false);
jest.mock('../utils/mobileLock', () => ({
  ...jest.requireActual('../utils/mobileLock'),
  requestMobileLock: (...a) => mockRequestLock(...a),
}));

import SessionExpiryHandler from './SessionExpiryHandler';

function fireExpired(url = '/admin/badge-counts') {
  act(() => {
    window.dispatchEvent(new CustomEvent('session-expired', { detail: { url } }));
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestLock.mockReturnValue(false);
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

test('unclaimed 401 keeps today: toast, logout, navigate to /login', () => {
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  fireExpired();
  expect(mockToastError).toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1600));
  expect(mockLogout).toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
});

test('phone-claimed 401 locks instead: no toast, no logout, guard stays open', () => {
  mockRequestLock.mockReturnValue(true);
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  fireExpired();
  expect(mockToastError).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1600));
  expect(mockLogout).not.toHaveBeenCalled();
  // Guard untouched: when the claim stops (unlock failed, passkey revoked),
  // the next 401 still gets the full logout path.
  mockRequestLock.mockReturnValue(false);
  fireExpired();
  expect(mockToastError).toHaveBeenCalledTimes(1);
});

test('client-portal 401s never route to the phone lock', () => {
  mockRequestLock.mockReturnValue(true);
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  fireExpired('/client-portal/summary');
  expect(mockRequestLock).not.toHaveBeenCalled();
  expect(mockToastError).toHaveBeenCalled();
});

test('session-restored resets the once-only guard', () => {
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  fireExpired();
  act(() => jest.advanceTimersByTime(1600));
  expect(mockToastError).toHaveBeenCalledTimes(1);
  act(() => { window.dispatchEvent(new Event('session-restored')); });
  fireExpired();
  expect(mockToastError).toHaveBeenCalledTimes(2);
});

test('a revocation-class 401 is NEVER claimed by the lock: full logout + purge path runs', () => {
  // The handler declines revocations in real code; here the claim is asked
  // with the code, and the handler's decision is what routes it. Pinning the
  // WIRING: the code must reach requestMobileLock (external review 8/14).
  mockRequestLock.mockImplementation((code) => code !== 'TOKEN_VERSION_MISMATCH');
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  act(() => {
    window.dispatchEvent(new CustomEvent('session-expired', {
      detail: { url: '/admin/badge-counts', code: 'TOKEN_VERSION_MISMATCH' },
    }));
  });
  expect(mockRequestLock).toHaveBeenCalledWith('TOKEN_VERSION_MISMATCH');
  expect(mockToastError).toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1600));
  expect(mockLogout).toHaveBeenCalled();
  expect(mockNavigate).toHaveBeenCalledWith('/login', { replace: true });
});

test('an ordinary expiry 401 still reaches the claim with its code', () => {
  mockRequestLock.mockImplementation((code) => code !== 'TOKEN_VERSION_MISMATCH');
  render(<MemoryRouter><SessionExpiryHandler /></MemoryRouter>);
  act(() => {
    window.dispatchEvent(new CustomEvent('session-expired', {
      detail: { url: '/admin/badge-counts', code: 'INVALID_TOKEN' },
    }));
  });
  expect(mockRequestLock).toHaveBeenCalledWith('INVALID_TOKEN');
  expect(mockLogout).not.toHaveBeenCalled();
});
