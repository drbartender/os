import { readOverrides, persistOverrides } from './desktopViewStore';

beforeEach(() => window.localStorage.clear());

test('round-trips a map through storage', () => {
  expect(readOverrides()).toEqual({});
  persistOverrides({ 'events-list': true });
  expect(readOverrides()).toEqual({ 'events-list': true });
  persistOverrides({});
  expect(readOverrides()).toEqual({});
});

test('survives corrupt storage', () => {
  window.localStorage.setItem('adminDesktopViewOverrides', 'not json');
  expect(readOverrides()).toEqual({});
  window.localStorage.setItem('adminDesktopViewOverrides', '[1,2]');
  expect(readOverrides()).toEqual({});
});
