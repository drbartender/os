import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PlansDrawer from './PlansDrawer';
import api from '../../../utils/api';

jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn() } }));

// The "List to review" chip is the Potions face of the same rule the Events
// Plan column and the overview prep queue apply: a hosted package never owes a
// shopping list, so a hosted row wears no chip even when a stale or
// admin-built list sits in pending_review.
const plan = (over) => ({
  id: 1, status: 'submitted', client_name: 'C', event_type: 'birthday-party',
  event_date: '2026-10-01', guest_count: 50, drink_names: [], ...over,
});

test('the List to review chip skips hosted plans', async () => {
  api.get.mockResolvedValue({ data: [
    plan({ id: 1, client_name: 'Hosted Client', shopping_list_status: 'pending_review', package_category: 'hosted' }),
    plan({ id: 2, client_name: 'Byob Client', shopping_list_status: 'pending_review', package_category: 'byob' }),
    plan({ id: 3, client_name: 'Class Client', shopping_list_status: 'pending_review', package_category: 'hosted', package_bar_type: 'class' }),
  ] });
  render(<MemoryRouter><PlansDrawer open onClose={() => {}} /></MemoryRouter>);
  await screen.findByText('Byob Client', { exact: false });
  expect(screen.getByText('Hosted Client', { exact: false })).toBeInTheDocument();
  expect(screen.getAllByText('List to review')).toHaveLength(2);
});
