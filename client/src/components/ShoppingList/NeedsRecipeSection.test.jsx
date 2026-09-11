import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import NeedsRecipeSection from './NeedsRecipeSection';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
// The drawer + editor are heavy (portal, debounce, par catalog); the section
// under test only needs to know WHICH drink it opened them on.
jest.mock('../adminos/Drawer', () => ({
  __esModule: true,
  default: ({ open, children }) => (open ? <div data-testid="drawer">{children}</div> : null),
}));
jest.mock('../potions/RecipeEditor', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ReactMock.forwardRef(({ drink }, ref) => <div data-testid="recipe-editor">{drink.name}</div>),
  };
});

const OLD_FASHIONED = { id: 'old-fashioned', name: 'Old Fashioned', emoji: '🥃', is_active: true, ingredients: [{ item: 'bourbon' }], request_aliases: [] };
const MARGARITA = { id: 'margarita', name: 'Margarita', emoji: '🍹', is_active: true, ingredients: [{ item: 'tequila' }], request_aliases: [] };
const PALOMA = { id: 'paloma', name: 'Paloma', emoji: '🍊', is_active: false, ingredients: [], request_aliases: [] };
const NOJITO = { id: 'nojito', name: 'Nojito', emoji: '🌿', is_active: true, ingredients: [{ item: 'mint' }], request_aliases: [] };

function mockLists() {
  api.get.mockImplementation((url) => {
    if (url === '/cocktails/admin') return Promise.resolve({ data: { cocktails: [OLD_FASHIONED, MARGARITA, PALOMA] } });
    if (url === '/mocktails/admin') return Promise.resolve({ data: { mocktails: [NOJITO] } });
    if (url === '/potions/pars') return Promise.resolve({ data: { pars: [] } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

function renderSection(needsRecipe = [{ name: 'old fashion' }]) {
  const onRegenerate = jest.fn();
  render(<NeedsRecipeSection needsRecipe={needsRecipe} unresolved={[]} onRegenerate={onRegenerate} />);
  return { onRegenerate };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLists();
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});

test('each needs-recipe row offers Match existing beside Add recipe', () => {
  renderSection([{ name: 'old fashion' }, { name: 'ranch water' }]);
  expect(screen.getAllByRole('button', { name: 'Match existing' })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Add recipe' })).toHaveLength(2);
});

test('opening the picker suggests the closest drinks from both admin lists, tagged', async () => {
  renderSection([{ name: 'old fashion' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Match existing' }));
  const row = await screen.findByRole('button', { name: /Old Fashioned/ });
  expect(row).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('old fashion');

  // Re-ranking over the FULL pool as the admin types, with the tags that
  // tell them what they are about to point the client's text at.
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'palo' } });
  const paloma = await screen.findByRole('button', { name: /Paloma/ });
  expect(paloma).toHaveTextContent('Off menu');
  expect(paloma).toHaveTextContent('No recipe');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'nojito' } });
  expect(await screen.findByRole('button', { name: /Nojito/ })).toHaveTextContent('Mocktail');
});

test('picking a drink that has a recipe remembers the alias, then offers the fold-in', async () => {
  api.post.mockResolvedValue({ data: { ...OLD_FASHIONED, request_aliases: ['old fashion'] } });
  const { onRegenerate } = renderSection([{ name: 'old fashion' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Match existing' }));
  fireEvent.click(await screen.findByRole('button', { name: /Old Fashioned/ }));

  await waitFor(() => expect(onRegenerate).toHaveBeenCalledTimes(1));
  expect(api.post).toHaveBeenCalledWith('/cocktails/old-fashioned/request-aliases', { alias: 'old fashion' });
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Fold "Old Fashioned" into the list?'));
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  expect(screen.queryByTestId('drawer')).not.toBeInTheDocument();
});

test('declining the fold-in still keeps the alias and closes the picker', async () => {
  window.confirm.mockReturnValue(false);
  api.post.mockResolvedValue({ data: { ...OLD_FASHIONED, request_aliases: ['old fashion'] } });
  const { onRegenerate } = renderSection([{ name: 'old fashion' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Match existing' }));
  fireEvent.click(await screen.findByRole('button', { name: /Old Fashioned/ }));
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(onRegenerate).not.toHaveBeenCalled();
});

test('picking a drink with no recipe opens the recipe drawer on that drink instead of folding', async () => {
  api.post.mockResolvedValue({ data: { ...PALOMA, request_aliases: ['grapefruit tequila thing'] } });
  const { onRegenerate } = renderSection([{ name: 'grapefruit tequila thing' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Match existing' }));
  // The client's text has no close match; the admin searches by hand.
  expect(await screen.findByText(/No close match/)).toBeInTheDocument();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'paloma' } });
  fireEvent.click(await screen.findByRole('button', { name: /Paloma/ }));

  expect(await screen.findByTestId('drawer')).toHaveTextContent('Paloma');
  expect(api.post).toHaveBeenCalledWith('/cocktails/paloma/request-aliases', { alias: 'grapefruit tequila thing' });
  expect(window.confirm).not.toHaveBeenCalled();
  expect(onRegenerate).not.toHaveBeenCalled();
});

test('a refusal from the server shows its reason and keeps the picker open', async () => {
  api.post.mockRejectedValue({ message: '"old fashion" already matches Whiskey Sour. Pick that drink instead.', status: 409 });
  const { onRegenerate } = renderSection([{ name: 'old fashion' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Match existing' }));
  fireEvent.click(await screen.findByRole('button', { name: /Old Fashioned/ }));

  expect(await screen.findByText(/already matches Whiskey Sour/)).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toBeInTheDocument();
  expect(onRegenerate).not.toHaveBeenCalled();
  expect(window.confirm).not.toHaveBeenCalled();
});

test('Add recipe on a text the picker already matched reuses that drink, never a new one', async () => {
  api.post.mockResolvedValue({ data: { ...OLD_FASHIONED, request_aliases: ['old fashion'] } });
  window.confirm.mockReturnValue(false);
  renderSection([{ name: 'old fashion' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Match existing' }));
  fireEvent.click(await screen.findByRole('button', { name: /Old Fashioned/ }));
  await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());

  fireEvent.click(screen.getByRole('button', { name: 'Add recipe' }));
  expect(await screen.findByTestId('drawer')).toHaveTextContent('Old Fashioned');
  // Only the alias append hit the network; no POST /cocktails minted a duplicate.
  expect(api.post).toHaveBeenCalledTimes(1);
});

test('suggestions lock while Add recipe on another row is still on the wire', async () => {
  renderSection([{ name: 'old fashion' }, { name: 'ranch water' }]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Match existing' })[0]);
  const suggestion = await screen.findByRole('button', { name: /Old Fashioned/ });
  expect(suggestion).toBeEnabled();
  api.post.mockImplementation(() => new Promise(() => {})); // create never settles
  fireEvent.click(screen.getAllByRole('button', { name: /Add recipe|Adding/ })[1]);
  await waitFor(() => expect(suggestion).toBeDisabled());
});

test('the picker closes when the list it was opened on is replaced', async () => {
  const onRegenerate = jest.fn();
  const { rerender } = render(
    <NeedsRecipeSection needsRecipe={[{ name: 'old fashion' }, { name: 'ranch water' }]} unresolved={[]} onRegenerate={onRegenerate} />
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'Match existing' })[0]);
  expect(await screen.findByRole('button', { name: /Old Fashioned/ })).toBeInTheDocument();
  expect(screen.getByRole('textbox')).toHaveValue('old fashion');
  // A regenerate reorders the rows: row 0 is now a different request.
  rerender(
    <NeedsRecipeSection needsRecipe={[{ name: 'ranch water' }, { name: 'old fashion' }]} unresolved={[]} onRegenerate={onRegenerate} />
  );
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

test('no close match tells the admin so, rather than guessing', async () => {
  renderSection([{ name: 'the blue drink from my cousins wedding' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Match existing' }));
  expect(await screen.findByText(/No close match/)).toBeInTheDocument();
});
