import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';

const mockToast = { success: jest.fn(), error: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockSupported = jest.fn(() => true);
const mockRegister = jest.fn();
jest.mock('../../utils/webauthnClient', () => ({
  isPasskeySupported: (...a) => mockSupported(...a),
  registerPasskey: (...a) => mockRegister(...a),
}));

import PasskeyEnrollNudge from './PasskeyEnrollNudge';
import { ENROLLED_KEY, NUDGE_DISMISSED_KEY, passkeyEnrolledHere } from '../../utils/mobileLock';

beforeEach(() => {
  jest.clearAllMocks();
  mockSupported.mockReturnValue(true);
  window.localStorage.clear();
});

test('hidden when unsupported, enrolled, or dismissed', () => {
  mockSupported.mockReturnValueOnce(false);
  expect(render(<PasskeyEnrollNudge />).container.firstChild).toBeNull();

  window.localStorage.setItem(ENROLLED_KEY, '1');
  expect(render(<PasskeyEnrollNudge />).container.firstChild).toBeNull();
  window.localStorage.clear();

  window.localStorage.setItem(NUDGE_DISMISSED_KEY, '1');
  expect(render(<PasskeyEnrollNudge />).container.firstChild).toBeNull();
});

test('Turn on enrolls, sets the flag, and hides', async () => {
  mockRegister.mockResolvedValue({ id: 1 });
  render(<PasskeyEnrollNudge />);
  act(() => { screen.getByRole('button', { name: 'Turn on' }).click(); });
  await waitFor(() => expect(passkeyEnrolledHere()).toBe(true));
  expect(mockToast.success).toHaveBeenCalled();
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});

test('Not now dismisses durably', () => {
  render(<PasskeyEnrollNudge />);
  act(() => { screen.getByRole('button', { name: 'Not now' }).click(); });
  expect(window.localStorage.getItem(NUDGE_DISMISSED_KEY)).toBe('1');
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});

test('a failed enrollment keeps the nudge and reports', async () => {
  mockRegister.mockRejectedValue({ message: 'nope' });
  render(<PasskeyEnrollNudge />);
  act(() => { screen.getByRole('button', { name: 'Turn on' }).click(); });
  await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  expect(screen.getByRole('region')).toBeInTheDocument();
  expect(passkeyEnrolledHere()).toBe(false);
});
