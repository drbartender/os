import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, waitFor } from '@testing-library/react';

// `mock` prefix: babel-plugin-jest-hoist only lets a jest.mock factory close over
// variables named mock*, and this one calls jest.fn() so the pure-const exemption
// does not apply.
const mockMobileView = { isPhone: false, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
jest.mock('../mobile/EventsListPhone', () => ({ __esModule: true, default: () => <div data-testid="phone-list" /> }));
// The desktop body pulls in the toolbar, drawers and api; stub what it needs to mount.
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(() => Promise.resolve({ data: [] })) } }));
// Stable identity on purpose: the desktop body's fetchEvents useCallback deps on
// toast, so a fresh object per render would re-run its effect forever.
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
// Toolbar renders GlobalSearchButton, whose usePalette throws outside AdminLayout.
const mockPalette = { openPalette: jest.fn() };
jest.mock('../../context/PaletteContext', () => ({ ...jest.requireActual('../../context/PaletteContext'), usePalette: () => mockPalette }));
import { MemoryRouter } from 'react-router-dom';
import api from '../../utils/api';
import EventsDashboard from './EventsDashboard';

const mount = () => render(<MemoryRouter initialEntries={['/events']}><EventsDashboard /></MemoryRouter>);

test('phone width without a Desktop-view override renders the phone list', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(false);
  mount();
  expect(screen.getByTestId('phone-list')).toBeInTheDocument();
  expect(mockMobileView.desktopView).toHaveBeenCalledWith('events-list');
});

test('phone width with the Desktop-view override renders the desktop dashboard', async () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(true);
  mount();
  expect(screen.queryByTestId('phone-list')).toBeNull();
  expect(await screen.findByText('Events')).toBeInTheDocument();   // the desktop page title
  // The desktop body fetches on mount; let it settle inside act so its state
  // update does not land after the test has returned.
  await waitFor(() => expect(api.get).toHaveBeenCalled());
});

test('desktop width renders the desktop dashboard', async () => {
  mockMobileView.isPhone = false;
  mount();
  expect(screen.queryByTestId('phone-list')).toBeNull();
  await waitFor(() => expect(api.get).toHaveBeenCalled());
});
