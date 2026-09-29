import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import api from '../../utils/api';
import EventDetailPage from './EventDetailPage';

// jest.mock calls are hoisted above every import by babel-plugin-jest-hoist,
// so the imports above already get the mocks below.
// `mock` prefix: babel-plugin-jest-hoist only lets a jest.mock factory close
// over variables named mock*.
const mockMobileView = { isPhone: false, desktopView: jest.fn(() => false), setDesktopView: jest.fn() };
jest.mock('../../context/MobileViewContext', () => ({ useMobileView: () => mockMobileView }));
// Counts MOUNTS, so a test can tell a new screen from the same one re-rendered.
const mockPhone = { mounts: 0 };
jest.mock('../mobile/EventDetailPhone', () => {
  const { useEffect } = require('react');
  function MockPhoneDetail() {
    useEffect(() => { mockPhone.mounts += 1; }, []);
    return <div data-testid="phone-detail" />;
  }
  return { __esModule: true, default: MockPhoneDetail };
});
// The desktop body is left in its loading state on purpose: this test is about
// which branch mounts, and a read that never lands keeps every heavy card out.
jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
// Stable identity: the desktop body's reload callbacks depend on toast, so a
// fresh object per render would re-run its load effect forever.
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../context/ToastContext', () => ({ useToast: () => mockToast }));
const mockAuth = { user: { id: 1, role: 'admin' } };
jest.mock('../../context/AuthContext', () => ({ useAuth: () => mockAuth }));

const mount = () => render(
  <MemoryRouter initialEntries={['/events/13']}>
    <Routes><Route path="/events/:id" element={<EventDetailPage />} /></Routes>
  </MemoryRouter>
);

beforeEach(() => {
  api.get.mockReturnValue(new Promise(() => {}));   // never lands
});

test('phone width without a Desktop-view override renders the phone detail', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(false);
  mount();
  expect(screen.getByTestId('phone-detail')).toBeInTheDocument();
  expect(mockMobileView.desktopView).toHaveBeenCalledWith('event-detail');
  expect(api.get).not.toHaveBeenCalled();   // the desktop body never mounted
});

test('phone width with the Desktop-view override renders the desktop page', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(true);
  mount();
  expect(screen.queryByTestId('phone-detail')).toBeNull();
  expect(screen.getByText(/Loading event/)).toBeInTheDocument();
  expect(api.get).toHaveBeenCalledWith('/proposals/13');
});

test('desktop width renders the desktop page', () => {
  mockMobileView.isPhone = false; mockMobileView.desktopView.mockReturnValue(false);
  mount();
  expect(screen.queryByTestId('phone-detail')).toBeNull();
  expect(screen.getByText(/Loading event/)).toBeInTheDocument();
});

test('another event is a new phone detail, not the same one handed a new id', () => {
  mockMobileView.isPhone = true; mockMobileView.desktopView.mockReturnValue(false);
  mockPhone.mounts = 0;
  function Go() {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate('/events/14')}>go to 14</button>;
  }
  render(
    <MemoryRouter initialEntries={['/events/13']}>
      <Routes><Route path="/events/:id" element={<><EventDetailPage /><Go /></>} /></Routes>
    </MemoryRouter>
  );
  expect(mockPhone.mounts).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'go to 14' }));
  expect(screen.getByTestId('phone-detail')).toBeInTheDocument();
  expect(mockPhone.mounts).toBe(2);
});
