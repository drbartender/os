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
