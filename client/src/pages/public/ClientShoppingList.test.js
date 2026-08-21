import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import axios from 'axios';

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('react-router-dom', () => ({ useParams: () => ({ token: 't0ken' }) }));

import ClientShoppingList from './ClientShoppingList';

// Every line was a bare <div> with onClick and a hand-drawn 22px checkbox: no
// role, no tabIndex, no aria-checked, no key handler, and no real
// <input type="checkbox"> anywhere in the file. The only two <button>s are the
// PDF download and a retry, so there was no alternative path -- a total keyboard
// lockout, on the public page a client works a liquor-store aisle with, where the
// checklist IS the feature. (2026-08-20 dead-affordance sweep, item 3.)

const PAYLOAD = {
  ready: true,
  client_name: 'Test Client',
  shopping_list: {
    liquorBeerWine: [{ item: "Tito's Vodka", size: '1.75L', qty: 2 }],
    everythingElse: [{ item: 'Limes', size: 'ea.', qty: 17 }],
  },
};

beforeEach(() => {
  // The page persists ticks to localStorage per token (that is the feature: a
  // client works the aisle over several visits), so without this the previous
  // test's ticks are still checked when the next one mounts.
  localStorage.clear();
  axios.get.mockReset();
  axios.get.mockResolvedValue({ data: PAYLOAD });
});

const rows = () => screen.getAllByRole('checkbox');

test('every line is a real checkbox widget, reachable by keyboard', async () => {
  render(<ClientShoppingList />);
  await waitFor(() => expect(rows().length).toBe(2));
  for (const row of rows()) {
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).toHaveAttribute('aria-checked', 'false');
  }
});

test('Enter and Space check a line, and the state is announced', async () => {
  render(<ClientShoppingList />);
  await waitFor(() => expect(rows().length).toBe(2));

  fireEvent.keyDown(rows()[0], { key: 'Enter' });
  await waitFor(() => expect(rows().some(r => r.getAttribute('aria-checked') === 'true')).toBe(true));

  const stillOpen = rows().find(r => r.getAttribute('aria-checked') === 'false');
  fireEvent.keyDown(stillOpen, { key: ' ' });
  await waitFor(() => expect(rows().every(r => r.getAttribute('aria-checked') === 'true')).toBe(true));
});

test('an unrelated key does not check a line', async () => {
  render(<ClientShoppingList />);
  await waitFor(() => expect(rows().length).toBe(2));
  fireEvent.keyDown(rows()[0], { key: 'a' });
  expect(rows().every(r => r.getAttribute('aria-checked') === 'false')).toBe(true);
});

test('the mouse path still works, since it was never the broken one', async () => {
  render(<ClientShoppingList />);
  await waitFor(() => expect(rows().length).toBe(2));
  fireEvent.click(rows()[0]);
  await waitFor(() => expect(rows().some(r => r.getAttribute('aria-checked') === 'true')).toBe(true));
});
