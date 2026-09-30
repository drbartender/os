import '@testing-library/jest-dom';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { MobileViewProvider, useMobileView } from './MobileViewContext';

// The live width answer, flipped by each test the way a resize would.
let mockLiveIsPhone = true;
jest.mock('../hooks/useIsPhone', () => ({ __esModule: true, default: () => mockLiveIsPhone }));

const wrapper = ({ children }) => (
  <MemoryRouter initialEntries={['/events']}>
    <MobileViewProvider>{children}</MobileViewProvider>
  </MemoryRouter>
);

beforeEach(() => {
  window.localStorage.clear();
  mockLiveIsPhone = true;
});

test('exposes isPhone and toggles a per-screen override with persistence', () => {
  const { result } = renderHook(() => useMobileView(), { wrapper });
  expect(result.current.isPhone).toBe(true);
  expect(result.current.desktopView('events-list')).toBe(false);
  act(() => result.current.setDesktopView('events-list', true));
  expect(result.current.desktopView('events-list')).toBe(true);
  expect(result.current.desktopView('event-detail')).toBe(false); // per-screen
  expect(
    JSON.parse(window.localStorage.getItem('adminDesktopViewOverrides'))
  ).toEqual({ 'events-list': true });
  act(() => result.current.setDesktopView('events-list', false));
  expect(result.current.desktopView('events-list')).toBe(false);
});

// A width that crosses 700px mid-page must not remount the page: the phone
// chrome and the desktop shell render it at different places in the tree.
test('a width change on the open page keeps its answer until the route changes', () => {
  const { result, rerender } = renderHook(
    () => ({ view: useMobileView(), navigate: useNavigate() }),
    { wrapper },
  );
  expect(result.current.view.isPhone).toBe(true);

  mockLiveIsPhone = false; // the window widens past 700px
  rerender();
  expect(result.current.view.isPhone).toBe(true);

  // A sheet's ?drawer= param is the same page: no re-fork.
  act(() => result.current.navigate('/events?drawer=shift:12'));
  expect(result.current.view.isPhone).toBe(true);

  // Opening another page takes the width as it is now.
  act(() => result.current.navigate('/events/42'));
  expect(result.current.view.isPhone).toBe(false);

  mockLiveIsPhone = true; // and narrows again
  rerender();
  expect(result.current.view.isPhone).toBe(false);
  act(() => result.current.navigate('/events'));
  expect(result.current.view.isPhone).toBe(true);
});
