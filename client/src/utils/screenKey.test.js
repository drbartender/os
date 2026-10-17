import { routeScreenKey, screenTitle } from './screenKey';

test.each([
  ['/events', 'events-list'],
  ['/events/123', 'event-detail'],
  ['/proposals', 'proposals-list'],
  ['/proposals/42', 'proposal-detail'],
  ['/more', 'more'],
  ['/staffing/users/9', 'staffing'],
  ['/staffing/payroll', 'staffing'],
  ['/dashboard', 'dashboard'],
  ['/inbox', 'inbox'],
  ['/inbox/c-12', 'inbox-item'],
  ['/inbox/t-neg_123', 'inbox-item'],
  ['/search', 'search'],
])('routeScreenKey(%s) -> %s', (path, key) => {
  expect(routeScreenKey(path)).toBe(key);
});

test('titles for the known screens, fallback capitalizes', () => {
  expect(screenTitle('events-list')).toBe('Events');
  expect(screenTitle('event-detail')).toBe('Event');
  expect(screenTitle('proposals-list')).toBe('Proposals');
  expect(screenTitle('proposal-detail')).toBe('Proposal');
  expect(screenTitle('more')).toBe('More');
  expect(screenTitle('staffing')).toBe('Staff');
  expect(screenTitle('blog')).toBe('Lab Notes');
  expect(screenTitle('inbox')).toBe('Inbox');
  expect(screenTitle('inbox-item')).toBe('Inbox');
});

test('/more/notifications is its own screen, titled Notifications; /more stays More', () => {
  expect(routeScreenKey('/more/notifications')).toBe('notifications');
  expect(screenTitle('notifications')).toBe('Notifications');
  expect(routeScreenKey('/more')).toBe('more');
});
