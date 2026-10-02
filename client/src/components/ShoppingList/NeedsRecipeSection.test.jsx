import React from 'react';
import '@testing-library/jest-dom'; // per-file import — this repo has no setupTests.js
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import NeedsRecipeSection from './NeedsRecipeSection';
import api from '../../utils/api';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
// The drawer + editor are heavy (portal, debounce, par catalog); the section
// under test only needs to know WHICH drink it opened them on.
jest.mock('../adminos/Drawer', () => ({
  __esModule: true,
  default: ({ open, children, footer, onClose }) => (open ? (
    <div data-testid="drawer">
      <button type="button" onClick={onClose}>Close drawer</button>
      {children}
      {footer}
    </div>
  ) : null),
}));
// "Add ingredient" stands in for the admin typing a recipe row; "Save" for
// the editor's save landing (it reports the saved drink back). flush lands
// unless a test sets mockFlushResult to false (a save that failed).
let mockFlushResult = true;
jest.mock('../potions/RecipeEditor', () => {
  const ReactMock = require('react');
  return {
    __esModule: true,
    default: ReactMock.forwardRef(({ drink, type, onRowsChange, onDrinkChange }, ref) => {
      ReactMock.useImperativeHandle(ref, () => ({ flush: () => Promise.resolve(mockFlushResult) }));
      return (
        <div data-testid="recipe-editor">
          {drink.name} ({(drink.ingredients || []).length} rows)
          <button type="button" onClick={() => onRowsChange(1)}>Add ingredient</button>
          <button
            type="button"
            onClick={() => { onRowsChange(1); onDrinkChange({ ...drink, ingredients: [{ ingredient: 'lime' }] }, type); }}
          >
            Save
          </button>
        </div>
      );
    }),
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
  mockFlushResult = true;
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

  fireEvent.click(screen.getByRole('button', { name: 'Edit recipe' }));
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

// ─── Next: work through every request before the list is rewritten ──────────

// New drafts for texts no admin drink matches; alias appends echo the drink.
function mockCreates() {
  api.post.mockImplementation((url, body) => {
    if (url === '/cocktails') {
      return Promise.resolve({ data: {
        id: body.name.replace(/\s+/g, '-'), name: body.name, is_active: false,
        ingredients: [], request_aliases: [body.name],
      } });
    }
    if (url === '/cocktails/old-fashioned/request-aliases') {
      return Promise.resolve({ data: { ...OLD_FASHIONED, request_aliases: [body.alias] } });
    }
    return Promise.reject(new Error(`unexpected POST ${url}`));
  });
}

test('Next walks the remaining requests without rewriting the list; Done folds them in once', async () => {
  mockCreates();
  const { onRegenerate } = renderSection([{ name: 'ranch water' }, { name: 'lavender fizz' }, { name: 'smoky thing' }]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add recipe' })[0]);
  expect(await screen.findByTestId('recipe-editor')).toHaveTextContent('ranch water');

  fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next: "lavender fizz"' }));
  await waitFor(() => expect(screen.getByTestId('recipe-editor')).toHaveTextContent('lavender fizz'));

  fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next: "smoky thing"' }));
  await waitFor(() => expect(screen.getByTestId('recipe-editor')).toHaveTextContent('smoky thing'));
  expect(window.confirm).not.toHaveBeenCalled();
  expect(onRegenerate).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done, update list' }));
  await waitFor(() => expect(onRegenerate).toHaveBeenCalledTimes(1));
  expect(window.confirm).toHaveBeenCalledTimes(1);
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Fold 3 drinks into the list'));
  expect(screen.queryByTestId('drawer')).not.toBeInTheDocument();
});

test('closing the drawer partway leaves the list alone; the last recipe folds them all in', async () => {
  mockCreates();
  const { onRegenerate } = renderSection([{ name: 'ranch water' }, { name: 'lavender fizz' }]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add recipe' })[0]);
  await screen.findByTestId('recipe-editor');
  fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));

  await waitFor(() => expect(screen.queryByTestId('drawer')).not.toBeInTheDocument());
  expect(window.confirm).not.toHaveBeenCalled();
  expect(onRegenerate).not.toHaveBeenCalled();
  expect(screen.getByText('Recipe added')).toBeInTheDocument();

  // The one still open is the last: closing it after a recipe folds both.
  fireEvent.click(screen.getByRole('button', { name: 'Add recipe' }));
  expect(await screen.findByRole('button', { name: 'Done, update list' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
  await waitFor(() => expect(onRegenerate).toHaveBeenCalledTimes(1));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Fold 2 drinks into the list'));
});

test('Match existing mid-run marks the row and waits for the rest', async () => {
  mockCreates();
  const { onRegenerate } = renderSection([{ name: 'old fashion' }, { name: 'ranch water' }]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Match existing' })[0]);
  fireEvent.click(await screen.findByRole('button', { name: /Old Fashioned/ }));

  expect(await screen.findByText('Matched to Old Fashioned')).toBeInTheDocument();
  expect(window.confirm).not.toHaveBeenCalled();
  expect(onRegenerate).not.toHaveBeenCalled();
});

test('Next skips a request already handled', async () => {
  mockCreates();
  renderSection([{ name: 'ranch water' }, { name: 'old fashion' }, { name: 'smoky thing' }]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Match existing' })[1]);
  fireEvent.click(await screen.findByRole('button', { name: /Old Fashioned/ }));
  await screen.findByText('Matched to Old Fashioned');

  fireEvent.click(screen.getAllByRole('button', { name: 'Add recipe' })[0]);
  await screen.findByTestId('recipe-editor');
  expect(screen.getByRole('button', { name: 'Next: "smoky thing"' })).toBeInTheDocument();
});

test('a failed save on Next stays on the recipe', async () => {
  mockCreates();
  const { onRegenerate } = renderSection([{ name: 'ranch water' }, { name: 'lavender fizz' }]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add recipe' })[0]);
  await screen.findByTestId('recipe-editor');
  fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
  mockFlushResult = false;
  fireEvent.click(screen.getByRole('button', { name: 'Next: "lavender fizz"' }));

  await waitFor(() => expect(screen.getByRole('button', { name: 'Next: "lavender fizz"' })).toBeEnabled());
  expect(screen.getByTestId('recipe-editor')).toHaveTextContent('ranch water');
  expect(api.post).toHaveBeenCalledTimes(1); // only the first draft; the next was never opened
  expect(onRegenerate).not.toHaveBeenCalled();
});

test('closing while Next is still opening the next drink does nothing', async () => {
  let finishCreate;
  api.post.mockImplementation((url, body) => {
    const draft = { id: body.name.replace(/\s+/g, '-'), name: body.name, is_active: false, ingredients: [], request_aliases: [body.name] };
    if (body.name === 'lavender fizz') return new Promise((resolve) => { finishCreate = () => resolve({ data: draft }); });
    return Promise.resolve({ data: draft });
  });
  const { onRegenerate } = renderSection([{ name: 'ranch water' }, { name: 'lavender fizz' }, { name: 'smoky thing' }]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add recipe' })[0]);
  await screen.findByTestId('recipe-editor');
  fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
  fireEvent.click(screen.getByRole('button', { name: 'Next: "lavender fizz"' }));
  await waitFor(() => expect(finishCreate).toBeDefined());

  fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  // Ignored, not queued: the drawer never closed, so it cannot pop back open.
  expect(screen.getByTestId('drawer')).toBeInTheDocument();
  finishCreate();
  await waitFor(() => expect(screen.getByTestId('recipe-editor')).toHaveTextContent('lavender fizz'));
  expect(window.confirm).not.toHaveBeenCalled();
  expect(onRegenerate).not.toHaveBeenCalled();
});

test('Edit recipe reopens the recipe that was saved, not the empty draft', async () => {
  mockCreates();
  renderSection([{ name: 'ranch water' }, { name: 'lavender fizz' }]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Add recipe' })[0]);
  expect(await screen.findByTestId('recipe-editor')).toHaveTextContent('ranch water (0 rows)');
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
  await screen.findByText('Recipe added');

  fireEvent.click(screen.getByRole('button', { name: 'Edit recipe' }));
  expect(await screen.findByTestId('recipe-editor')).toHaveTextContent('ranch water (1 rows)');
  expect(api.post).toHaveBeenCalledTimes(1); // reused, never a second draft
});

test('a matched row reopened with Edit recipe stays matched', async () => {
  mockCreates();
  renderSection([{ name: 'old fashion' }, { name: 'ranch water' }]);
  fireEvent.click(screen.getAllByRole('button', { name: 'Match existing' })[0]);
  fireEvent.click(await screen.findByRole('button', { name: /Old Fashioned/ }));
  await screen.findByText('Matched to Old Fashioned');

  fireEvent.click(screen.getByRole('button', { name: 'Edit recipe' }));
  await screen.findByTestId('recipe-editor');
  fireEvent.click(screen.getByRole('button', { name: 'Add ingredient' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));
  await waitFor(() => expect(screen.queryByTestId('drawer')).not.toBeInTheDocument());
  expect(screen.getByText('Matched to Old Fashioned')).toBeInTheDocument();
});
