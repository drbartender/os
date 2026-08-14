import { routeScreenKey, screenTitle } from './screenKey';

test.each([
  ['/events', 'events-list'],
  ['/events/123', 'event-detail'],
  ['/proposals', 'proposals-list'],
  ['/proposals/42', 'proposal-detail'],
  ['/more', 'more'],
  ['/financials/payroll', 'financials'],
  ['/staffing/users/9', 'staffing'],
  ['/dashboard', 'dashboard'],
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
  expect(screenTitle('financials')).toBe('Payroll');
});
