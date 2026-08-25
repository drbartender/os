import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import RevenueChartCard from './RevenueChartCard';

// Compare needs a prior window to overlay. priorPeriodClient refuses one whose
// start falls before the 2000 floor (a very wide range subtracts an equally wide
// window off its own start, and the money board's date input fires mid-keystroke).
// The toggle was gated on `allTime` alone, so on a refused window it stayed lit,
// pushed a dashed "Prior" chip into the legend and drew nothing, with no reason
// given. Found by the push review, 2026-08-25.
jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(() => new Promise(() => {})) } }));

const compareBtn = () => screen.getByRole('button', { name: /Compare/i });

test('Compare is available for an ordinary bounded range', () => {
  render(<RevenueChartCard data={[]} filter={{ from: '2026-01-01', to: '2026-03-31' }} />);
  expect(compareBtn()).toBeEnabled();
});

test('Compare is disabled when there is no bounded range at all', () => {
  render(<RevenueChartCard data={[]} filter={{ from: null, to: null }} />);
  expect(compareBtn()).toBeDisabled();
});

test('Compare is disabled when the prior window would fall before the floor', () => {
  // A ~26-year range: the prior window starts around 1974, which the floor refuses.
  render(<RevenueChartCard data={[]} filter={{ from: '2000-01-01', to: '2026-08-25' }} />);
  expect(compareBtn()).toBeDisabled();
});

test('the disabled Compare explains WHY, and does not reuse the bounded-range reason', () => {
  render(<RevenueChartCard data={[]} filter={{ from: '2000-01-01', to: '2026-08-25' }} />);
  const title = compareBtn().getAttribute('title') || '';
  // Not the generic "Overlay the prior period" hover, and not the allTime reason:
  // this range IS bounded, so that message would be a lie.
  expect(title).not.toMatch(/^Overlay the prior period$/);
  expect(title).not.toMatch(/needs a bounded date range/i);
  expect(title).toMatch(/prior/i);
});
