import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Stable identity: the tab's load() useCallback must not re-run on every render.
const mockToast = { success: jest.fn(), error: jest.fn(), info: jest.fn() };
jest.mock('../../../context/ToastContext', () => ({ useToast: () => mockToast }));
jest.mock('../../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), put: jest.fn(), post: jest.fn() } }));
import api from '../../../utils/api';
import PantryParsTab from './PantryParsTab';

// Recipe @ 100 (par_items.recipe_qty_per_100): blank keeps the generator's
// 1 per 25 guests; a number replaces it. pg sends NUMERIC as a string.

const row = (over) => ({
  item: 'X', size: 'ea.', qty_per_100: '1', section: 'everythingElse', role: 'garnish',
  spirit_key: null, style_key: null, paired_spirits: [], ingredient_aliases: [], in_full_bar: false,
  is_active: true, sort_order: 10, cost: null, recipe_qty_per_100: null, used_by: [], ...over,
});
const PARS = [
  row({ id: 'margarita-salt', item: 'Margarita Salt', size: 'container', recipe_qty_per_100: '1' }),
  row({ id: 'ginger-beer', item: 'Ginger Beer', size: '4 pack', role: 'mixer', sort_order: 20 }),
];

beforeEach(() => {
  jest.clearAllMocks();
  api.get.mockResolvedValue({ data: { pars: PARS.map((p) => ({ ...p })) } });
  api.put.mockResolvedValue({ data: {} });
});

const recipeCell = async (item) => {
  const name = await screen.findByDisplayValue(item);
  return name.closest('tr').querySelector('input[aria-label="Recipe quantity at 100 guests"]');
};
const edit = (input, value) => {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

test('shows the set value and an empty cell for an item without one', async () => {
  render(<PantryParsTab />);
  expect(await recipeCell('Margarita Salt')).toHaveValue('1');
  expect(await recipeCell('Ginger Beer')).toHaveValue('');
  expect(screen.getAllByText('Recipe @ 100')).toHaveLength(2); // one table per section
});

test('typing a number saves it as a number', async () => {
  render(<PantryParsTab />);
  edit(await recipeCell('Ginger Beer'), '0.5');
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/potions/pars/ginger-beer', { recipe_qty_per_100: 0.5 }));
});

test('clearing the cell saves null (back to 1 per 25 guests)', async () => {
  render(<PantryParsTab />);
  edit(await recipeCell('Margarita Salt'), '');
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/potions/pars/margarita-salt', { recipe_qty_per_100: null }));
});

test('zero, negative, junk or over the cap is not saved; the catalog reloads instead', async () => {
  render(<PantryParsTab />);
  const cell = await recipeCell('Ginger Beer');
  for (const bad of ['0', '-1', 'abc', '10001']) edit(cell, bad);
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(5)); // mount + one reload per bad value
  expect(api.put).not.toHaveBeenCalled();
});

test('an unchanged blur saves nothing', async () => {
  render(<PantryParsTab />);
  const cell = await recipeCell('Margarita Salt');
  fireEvent.focus(cell);
  fireEvent.blur(cell);
  expect(api.put).not.toHaveBeenCalled();
});
