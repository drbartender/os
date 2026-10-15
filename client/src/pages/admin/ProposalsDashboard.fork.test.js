import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';

// `mock` prefix: babel-plugin-jest-hoist only lets a jest.mock factory close over
// variables named mock*, and this one calls jest.fn().
const mockMobileView = { isPhone: false, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
jest.mock('../mobile/ProposalsListPhone', () => ({ __esModule: true, default: () => <div data-testid="phone-list" /> }));
// The desktop body reads the list (an array plus the X-Total-Count header) and
// the counts; one stub answers both shapes it can meet (re-armed in beforeEach).
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
// Stable identity on purpose: a fresh toast object per render re-runs the
// desktop body's fetch effect forever.
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockPalette = { openPalette: jest.fn() };
jest.mock('../../context/PaletteContext', () => ({ ...jest.requireActual('../../context/PaletteContext'), usePalette: () => mockPalette }));
import { MemoryRouter } from 'react-router-dom';
import api from '../../utils/api';
import ProposalsDashboard from './ProposalsDashboard';

const mount = () => render(<MemoryRouter initialEntries={['/proposals']}><ProposalsDashboard /></MemoryRouter>);

// CRA's jest runs with resetMocks: true, which wipes the implementation given
// in the jest.mock factory before each test; the desktop body calls
// api.get(...).then(...) synchronously inside an effect, so an undefined
// return crashes the render. Re-arm the stub here, every test.
beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockImplementation(() => Promise.resolve({ data: [], headers: { 'x-total-count': '0' } }));
});

test('phone width without a Desktop-view override renders the phone list', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(false);
  mount();
  expect(screen.getByTestId('phone-list')).toBeInTheDocument();
  expect(mockMobileView.desktopView).toHaveBeenCalledWith('proposals-list');
  expect(api.get).not.toHaveBeenCalled();
});

test('phone width with the Desktop-view override renders the desktop dashboard', async () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(true);
  mount();
  expect(screen.queryByTestId('phone-list')).toBeNull();
  expect(await screen.findByText('Proposals')).toBeInTheDocument();   // the desktop page title
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(mockToast.error).not.toHaveBeenCalled();
});

test('desktop width renders the desktop dashboard', async () => {
  mockMobileView.isPhone = false;
  mount();
  expect(screen.queryByTestId('phone-list')).toBeNull();
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(mockToast.error).not.toHaveBeenCalled();
});
