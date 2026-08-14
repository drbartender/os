import '@testing-library/jest-dom';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { MobileViewProvider, useMobileView } from './MobileViewContext';

jest.mock('../hooks/useIsPhone', () => ({ __esModule: true, default: () => true }));

const wrapper = ({ children }) => <MobileViewProvider>{children}</MobileViewProvider>;

beforeEach(() => window.localStorage.clear());

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
