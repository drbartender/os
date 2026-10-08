import '@testing-library/jest-dom';
import fs from 'fs';
import path from 'path';
import { holdTaps } from './tapGuard';

// eslint-disable-next-line testing-library/no-node-access
const guard = () => document.body.querySelector('.m-tap-guard');
afterEach(() => {
  jest.useRealTimers();
  // eslint-disable-next-line testing-library/no-node-access
  document.body.querySelectorAll('.m-tap-guard').forEach((g) => g.remove());
});

test('holds the whole screen for the time given, then lets go', () => {
  jest.useFakeTimers();
  holdTaps(500);
  expect(guard()).not.toBeNull();
  expect(guard()).toHaveAttribute('aria-hidden', 'true');
  jest.advanceTimersByTime(499);
  expect(guard()).not.toBeNull();
  jest.advanceTimersByTime(1);
  expect(guard()).toBeNull();
});

test('no time, no hold', () => {
  holdTaps(0);
  expect(guard()).toBeNull();
});

test('the layer covers the screen above the sheets, the header and the tab bar', () => {
  const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
  expect(css).toMatch(/html\[data-app="admin-os"\] \.m-tap-guard \{ position: fixed; inset: 0; z-index: 1300; \}/);
});
