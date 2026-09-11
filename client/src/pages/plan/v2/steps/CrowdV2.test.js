import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen } from '@testing-library/react';
import CrowdV2 from './CrowdV2';

// The crowd questions size what DRB brings on a hosted package and what the
// client buys on BYOB; the copy must say which.
const plan = (over) => ({ guest_count: 50, ...over });

test('BYOB crowd copy talks about the shopping list and what to buy', () => {
  render(<CrowdV2 plan={plan({ package_category: 'byob' })} selections={{}} updateSelections={() => {}} />);
  expect(screen.getAllByText(/shopping list/i).length).toBeGreaterThan(0);
  expect(screen.getAllByText(/to buy/i).length).toBeGreaterThan(0);
});

test('hosted crowd copy never mentions a shopping list or buying', () => {
  render(<CrowdV2 plan={plan({ package_category: 'hosted' })} selections={{}} updateSelections={() => {}} />);
  expect(screen.queryAllByText(/shopping list/i)).toHaveLength(0);
  expect(screen.queryAllByText(/to buy/i)).toHaveLength(0);
});
