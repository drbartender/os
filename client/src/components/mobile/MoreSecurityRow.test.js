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

import MoreSecurityRow from './MoreSecurityRow';
import { ENROLLED_KEY, passkeyEnrolledHere } from '../../utils/mobileLock';

beforeEach(() => {
  jest.clearAllMocks();
  mockSupported.mockReturnValue(true);
  window.localStorage.clear();
});

test('hidden when passkeys are unsupported', () => {
  mockSupported.mockReturnValueOnce(false);
  expect(render(<MoreSecurityRow />).container.firstChild).toBeNull();
});

test('enrolled state renders the on-row, not the button', () => {
  window.localStorage.setItem(ENROLLED_KEY, '1');
  render(<MoreSecurityRow />);
  expect(screen.getByText('Fingerprint unlock is on')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('enroll flips the row and sets the flag', async () => {
  mockRegister.mockResolvedValue({ id: 1 });
  render(<MoreSecurityRow />);
  act(() => { screen.getByRole('button', { name: /set up fingerprint unlock/i }).click(); });
  await waitFor(() => expect(passkeyEnrolledHere()).toBe(true));
  expect(screen.getByText('Fingerprint unlock is on')).toBeInTheDocument();
  expect(mockToast.success).toHaveBeenCalled();
});

test('a failed enroll keeps the button and reports', async () => {
  mockRegister.mockRejectedValue({ message: 'nope' });
  render(<MoreSecurityRow />);
  act(() => { screen.getByRole('button', { name: /set up fingerprint unlock/i }).click(); });
  await waitFor(() => expect(mockToast.error).toHaveBeenCalled());
  expect(passkeyEnrolledHere()).toBe(false);
});
