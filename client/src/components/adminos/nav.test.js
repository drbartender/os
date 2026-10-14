import '@testing-library/jest-dom'; // per-file import: this repo has no setupTests.js
import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NAV, { navBadgeCount } from './nav';
import Sidebar from './Sidebar';

// Sidebar's own dependencies are not what this file is testing: the contexts
// are stubbed and PresenceStrip (which fetches) is stubbed out entirely.
jest.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { role: 'admin', name: 'Dallas Reed' }, logout: jest.fn() }),
}));
jest.mock('../../context/UserPrefsContext', () => ({
  useUserPrefs: () => ({ prefs: {}, setPref: jest.fn() }),
}));
jest.mock('./PresenceStrip', () => ({ __esModule: true, default: () => null }));

const find = (id) => NAV.flatMap(s => s.items).find(i => i.id === id);

test('Staff is the one people entry; Hiring, Tips and Reviews are gone from the sidebar', () => {
  expect(find('staff')).toBeTruthy();
  expect(find('hiring')).toBeUndefined();
  expect(find('tips')).toBeUndefined();
  expect(find('reviews')).toBeUndefined();
});

test('navBadgeCount sums badgeKeys, falls back to badgeKey, and tolerates missing keys', () => {
  expect(navBadgeCount({ badgeKeys: ['a', 'b'] }, { a: 2, b: 3 })).toBe(5);
  expect(navBadgeCount({ badgeKeys: ['a', 'b'] }, { a: 2 })).toBe(2);
  expect(navBadgeCount({ badgeKey: 'a' }, { a: 4 })).toBe(4);
  expect(navBadgeCount({ label: 'x' }, { a: 4 })).toBe(0);
  expect(navBadgeCount({ badgeKey: 'a' }, undefined)).toBe(0);
});

test('the Staff entry sums new applications and pending reviews', () => {
  expect(navBadgeCount(find('staff'), { new_applications: 1, pending_reviews: 1 })).toBe(2);
});

test('Sidebar renders no Hiring/Tips/Reviews items and badges Staff with the summed count', () => {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar badges={{ new_applications: 1, pending_reviews: 1 }} />
    </MemoryRouter>
  );
  expect(screen.getByText('Staff')).toBeInTheDocument();
  expect(screen.queryByText('Hiring')).toBe(null);
  expect(screen.queryByText('Tips & Feedback')).toBe(null);
  expect(screen.queryByText('Reviews')).toBe(null);
  const staffItem = screen.getByText('Staff').closest('.nav-item');
  expect(staffItem.querySelector('.nav-badge')).toHaveTextContent('2');
});

// Inbox (spec 2026-10-06 section 9): under Overview, badged by the waiting
// count, and "!" when the server says the count could not be computed.
test('Inbox sits right under Overview and reads the waiting count', () => {
  const ids = NAV.find(s => s.section === 'Workspace').items.map(i => i.id);
  expect(ids.slice(0, 2)).toEqual(['dashboard', 'inbox']);
  expect(find('inbox')).toMatchObject({ path: '/inbox', badgeKey: 'inbox_waiting', badgeTone: 'danger' });
});

test('navBadgeCount returns null only when its key is present and null', () => {
  expect(navBadgeCount(find('inbox'), { inbox_waiting: null })).toBeNull();
  expect(navBadgeCount(find('inbox'), {})).toBe(0);
  expect(navBadgeCount(find('inbox'), { inbox_waiting: 0 })).toBe(0);
  expect(navBadgeCount(find('inbox'), { inbox_waiting: 7 })).toBe(7);
  // A summed badge treats a null part as nothing, exactly as before.
  expect(navBadgeCount({ badgeKeys: ['a', 'b'] }, { a: null, b: 2 })).toBe(2);
});

test('Sidebar draws "!" for a null Inbox count and keeps the other badges', () => {
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar badges={{ inbox_waiting: null, unstaffed_events: 3 }} />
    </MemoryRouter>
  );
  const inboxBadge = screen.getByText('Inbox').closest('.nav-item').querySelector('.nav-badge');
  expect(inboxBadge).toHaveTextContent('!');
  expect(inboxBadge).toHaveClass('danger');
  expect(screen.getByText('Events').closest('.nav-item').querySelector('.nav-badge')).toHaveTextContent('3');
});

test('Sidebar draws a count for Inbox, and nothing at zero', () => {
  const { unmount } = render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar badges={{ inbox_waiting: 4 }} />
    </MemoryRouter>
  );
  expect(screen.getByText('Inbox').closest('.nav-item').querySelector('.nav-badge')).toHaveTextContent('4');
  unmount();
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Sidebar badges={{ inbox_waiting: 0 }} />
    </MemoryRouter>
  );
  expect(screen.getByText('Inbox').closest('.nav-item').querySelector('.nav-badge')).toBeNull();
});
