import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UserPrefsProvider, useUserPrefs } from './UserPrefsContext';
import Sidebar from '../components/adminos/Sidebar';

// The sidebar override (menu art spec 2026-10-01 section 10.1, Review Focus 7):
// the bar menu editor shows the sidebar as its rail through sidebarOverride,
// its own state and never a key inside prefs, so html[data-sidebar] follows
// the override while the saved pref and localStorage stay untouched, and the
// Sidebar's footer collapse toggle (the one control that saves the layout) is
// not rendered while it is set.

// A stable user object: the provider keys its load off user.id.
const mockAuth = { user: { id: 7, name: 'Dallas', role: 'admin' }, logout: () => {} };
jest.mock('./AuthContext', () => ({ useAuth: () => mockAuth }));
jest.mock('../components/adminos/PresenceStrip', () => ({ __esModule: true, default: () => null }));

const KEY = 'drb-admin-prefs-7';
let ctx = null;
function Grab() {
  ctx = useUserPrefs();
  return null;
}
const mount = (withSidebar = false) => render(
  <MemoryRouter>
    <UserPrefsProvider>
      <Grab />
      {withSidebar && <Sidebar />}
    </UserPrefsProvider>
  </MemoryRouter>,
);
const sidebarAttr = () => document.documentElement.dataset.sidebar;

beforeEach(() => {
  localStorage.clear();
  ctx = null;
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

test('the override drives html[data-sidebar] while the saved pref and localStorage stay untouched', () => {
  localStorage.setItem(KEY, JSON.stringify({ skin: 'light', density: 'comfy', sidebar: 'full' }));
  mount();
  expect(sidebarAttr()).toBe('full');
  expect(ctx.prefs.sidebar).toBe('full');
  expect(ctx.sidebarOverride).toBe(null);
  const saved = localStorage.getItem(KEY);
  const setItem = jest.spyOn(Storage.prototype, 'setItem');

  act(() => ctx.setSidebarOverride('rail'));
  expect(sidebarAttr()).toBe('rail');
  expect(ctx.sidebarOverride).toBe('rail');
  expect(ctx.prefs.sidebar).toBe('full');
  expect(ctx.prefs).not.toHaveProperty('sidebarOverride');
  expect(setItem).not.toHaveBeenCalled();
  expect(localStorage.getItem(KEY)).toBe(saved);

  act(() => ctx.setSidebarOverride(null));
  expect(sidebarAttr()).toBe('full');
  expect(setItem).not.toHaveBeenCalled();
  expect(localStorage.getItem(KEY)).toBe(saved);
  // The skin the override's effect re-applies is the saved one.
  expect(document.documentElement.dataset.skin).toBe('light');
});

test('a saved rail stays a rail under no override, and the override never writes prefs', () => {
  localStorage.setItem(KEY, JSON.stringify({ skin: 'dark', density: 'compact', sidebar: 'rail' }));
  mount();
  expect(sidebarAttr()).toBe('rail');
  act(() => ctx.setSidebarOverride('rail'));
  act(() => ctx.setSidebarOverride(null));
  expect(sidebarAttr()).toBe('rail');
  expect(JSON.parse(localStorage.getItem(KEY)).sidebar).toBe('rail');
});

test('a real pref change still saves (the override did not break setPref)', () => {
  mount();
  act(() => ctx.setPref('density', 'compact'));
  expect(JSON.parse(localStorage.getItem(KEY))).toMatchObject({ density: 'compact', sidebar: 'full' });
});

test('Sidebar: rail while overridden, and the footer collapse toggle is hidden until it clears', () => {
  mount(true);
  expect(screen.getByTitle('Collapse to rail')).toBeInTheDocument();
  // In the full layout the nav items carry no aria-label (rail mode labels them).
  expect(document.querySelector('.nav-item[aria-label]')).toBeNull();

  act(() => ctx.setSidebarOverride('rail'));
  expect(screen.queryByTitle('Collapse to rail')).not.toBeInTheDocument();
  expect(screen.queryByTitle('Expand sidebar')).not.toBeInTheDocument();
  expect(document.querySelector('.nav-item[aria-label]')).not.toBeNull();
  expect(ctx.prefs.sidebar).toBe('full');

  act(() => ctx.setSidebarOverride(null));
  expect(screen.getByTitle('Collapse to rail')).toBeInTheDocument();
  expect(document.querySelector('.nav-item[aria-label]')).toBeNull();
});
