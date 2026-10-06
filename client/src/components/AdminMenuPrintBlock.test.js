import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('../utils/api', () => ({ __esModule: true, default: { post: jest.fn(), patch: jest.fn(), delete: jest.fn() } }));
jest.mock('../utils/downloadMenuPrint', () => ({ downloadMenuPrint: jest.fn() }));
import { downloadMenuPrint } from '../utils/downloadMenuPrint';
import AdminMenuPrintBlock from './AdminMenuPrintBlock';

// Dallas could upload, replace and remove the print file but never read it
// back (fix list, 2026-09-22). Download reads it through the admin route.

beforeEach(() => jest.clearAllMocks());

test('a posted file offers Download, which reads it back through the admin route', async () => {
  downloadMenuPrint.mockResolvedValue();
  render(<AdminMenuPrintBlock proposalId={42} menuPrintKey="menu-print/42/a.pdf" menuNotRequired={false} />);
  fireEvent.click(screen.getByRole('button', { name: /^Download$/ }));
  expect(screen.getByRole('button', { name: /Downloading/ })).toBeDisabled();
  await waitFor(() => expect(screen.getByRole('button', { name: /^Download$/ })).toBeEnabled());
  expect(downloadMenuPrint).toHaveBeenCalledWith('/proposals/42/menu-print');
});

test('no Download when nothing is posted', () => {
  render(<AdminMenuPrintBlock proposalId={42} menuPrintKey={null} menuNotRequired={false} />);
  expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Upload file/ })).toBeInTheDocument();
});

// The helper rejects with a status-mapped message (downloadMenuPrint.test.js);
// the card prints whatever message it is handed.
test('a failed download says so on the card', async () => {
  downloadMenuPrint.mockRejectedValue({ status: 502, message: 'The menu file is temporarily unavailable. Try again in a minute.' });
  render(<AdminMenuPrintBlock proposalId={42} menuPrintKey="menu-print/42/a.pdf" menuNotRequired={false} />);
  fireEvent.click(screen.getByRole('button', { name: /^Download$/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The menu file is temporarily unavailable. Try again in a minute.');
});
