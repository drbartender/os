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
const wrapperAt = (path) => ({ children }) => (
  <MemoryRouter initialEntries={[path]}>
    <MobileViewProvider>{children}</MobileViewProvider>
  </MemoryRouter>
);
const stored = () => JSON.parse(window.localStorage.getItem('adminDesktopViewOverrides') || '{}');
const atSearch = () => renderHook(
  () => ({ view: useMobileView(), navigate: useNavigate() }),
  { wrapper: wrapperAt('/search') },
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

// Global search opens a desktop page for ONE visit (lane ma-f3; Dallas,
// 2026-10-16: "I'd rather it not stick").
test('a visit keeps the desktop list through its own navigation and a page opened from it, and ends when the user backs out', () => {
  const { result } = atSearch();
  const dv = (k) => result.current.view.desktopView(k);
  act(() => {
    result.current.view.setDesktopForVisit('events-list');
    result.current.navigate('/events?tab=all');
  });
  expect(dv('events-list')).toBe(true);
  expect(stored()).toEqual({});
  // The page's own tabs, filters and drawers are the same visit.
  act(() => result.current.navigate('/events?tab=upcoming', { replace: true }));
  act(() => result.current.navigate('/events?tab=upcoming&drawer=shift:12'));
  expect(dv('events-list')).toBe(true);
  // An event opened from the list shows as it always does; Back returns to
  // the desktop list.
  act(() => result.current.navigate('/events/42'));
  expect(dv('events-list')).toBe(false);
  expect(dv('event-detail')).toBe(false);
  act(() => result.current.navigate(-1));
  expect(dv('events-list')).toBe(true);
  act(() => result.current.navigate(-1));
  expect(dv('events-list')).toBe(true);
  // Backing out past the page the search opened ends it; Forward does not
  // bring it back.
  act(() => result.current.navigate(-1));
  expect(dv('events-list')).toBe(false);
  act(() => result.current.navigate(1));
  expect(dv('events-list')).toBe(false);
  expect(stored()).toEqual({});
});

test('arriving at the screen afresh from a page of the visit ends it; one that lands elsewhere is dropped', () => {
  const { result } = atSearch();
  const dv = (k) => result.current.view.desktopView(k);
  act(() => {
    result.current.view.setDesktopForVisit('events-list');
    result.current.navigate('/events?tab=all');
  });
  act(() => result.current.navigate('/events/42'));
  act(() => result.current.navigate('/events')); // the tab bar
  expect(dv('events-list')).toBe(false);
  act(() => result.current.navigate(-2));
  expect(dv('events-list')).toBe(false); // the visit is over, not paused
  // Armed in one step, navigated in the next: it still lands.
  act(() => result.current.navigate('/search'));
  act(() => result.current.view.setDesktopForVisit('clients'));
  expect(dv('clients')).toBe(false); // waiting, still on /search
  act(() => result.current.navigate('/clients/3'));
  expect(dv('clients')).toBe(true);
  // A visit whose navigation lands on another screen is dropped, not left
  // lying in wait.
  act(() => result.current.navigate('/search'));
  act(() => result.current.view.setDesktopForVisit('staffing'));
  act(() => result.current.navigate('/events'));
  act(() => result.current.navigate('/staffing/users/12'));
  expect(dv('staffing')).toBe(false);
});

test('the Phone view pill ends a visit; a sticky override is untouched by visits', () => {
  const { result } = atSearch();
  act(() => result.current.view.setDesktopView('inbox', true));
  act(() => {
    result.current.view.setDesktopForVisit('clients');
    result.current.navigate('/clients/3');
  });
  expect(result.current.view.desktopView('clients')).toBe(true);
  act(() => result.current.view.setDesktopView('clients', false));
  expect(result.current.view.desktopView('clients')).toBe(false);
  expect(result.current.view.desktopView('inbox')).toBe(true);
  expect(stored()).toEqual({ inbox: true });
});

// Null never names a screen: with no visit active, before one or after one
// has ended, desktopView(null) is false.
test('a null key is never in desktop view, before a visit or after one has ended', () => {
  const { result } = atSearch();
  const dv = (k) => result.current.view.desktopView(k);
  expect(dv(null)).toBe(false);
  act(() => {
    result.current.view.setDesktopForVisit('clients');
    result.current.navigate('/clients/3');
  });
  expect(dv('clients')).toBe(true);
  act(() => result.current.navigate(-1)); // backed out past it: the visit ends
  expect(dv('clients')).toBe(false);
  expect(dv(null)).toBe(false);
});
