import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen } from '@testing-library/react';
import WelcomeV2 from './WelcomeV2';

// A hosted package never owes a shopping list, so the roadmap must not promise
// one on a hosted plan (it already branches the drinks part; the crowd part
// did not). BYOB keeps its copy.
const plan = (over) => ({ client_name: 'Test Client', guest_count: 50, event_date: '2026-10-01', package_name: 'The Enhanced Solution', ...over });

test('BYOB roadmap promises the shopping list', () => {
  render(<WelcomeV2 plan={plan({ package_category: 'byob' })} onStart={() => {}} />);
  expect(screen.getAllByText(/shopping list/i).length).toBeGreaterThan(0);
});

test('hosted roadmap never mentions a shopping list', () => {
  render(<WelcomeV2 plan={plan({ package_category: 'hosted' })} onStart={() => {}} />);
  expect(screen.queryAllByText(/shopping list/i)).toHaveLength(0);
});
