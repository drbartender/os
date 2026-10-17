import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import DrinksTab from './DrinksTab';

// The editor's Drinks tab (spec 2026-10-01 section 11.1, Drinks tab; 4.5).

const drink = (key, name, over = {}) => ({ key, group: 'sig', display_name: name, description: '', hidden: false, has_art: true, ...over });
const DRINKS = () => [
  drink('custom:paloma', "Roscoe's Paloma"),
  drink('mocktail:3', 'Coral Crush', { group: 'mock' }),
  drink('cocktail:7', 'Old Fashioned'),
  drink('cocktail:9', 'Lemon Drop', { hidden: true }),
  drink('custom:mule', 'Cucumber Mule', { added_by_sync: true }),
  drink('cocktail:2', 'Daiquiri', { has_art: false }),
];
const piece = (key, status, provider = 'openai') => ({ piece_key: key, status, provider });
const PIECES = () => [
  piece('background', 'done'), piece('custom:paloma', 'done', 'gemini'), piece('mocktail:3', 'failed'),
  piece('cocktail:7', 'working', 'gemini'), piece('cocktail:9', 'done'), piece('custom:mule', 'pending'),
];
const props = (over = {}) => ({
  draft: { id: 1 }, content: { words_status: 'done', drinks: DRINKS() }, pieces: PIECES(),
  configured: { openai: true, gemini: true }, cap: { used: 0, limit: 60, remaining: 60 },
  onPatch: jest.fn(), onReroll: jest.fn(), onSelectDrink: jest.fn(), selectedDrink: null, wordsDone: true, ...over,
});
const rowOf = (name) => screen.getByText(name).closest('.md-drink');

test('inert at 0.45 until the words land', () => {
  const { container, rerender } = render(<DrinksTab {...props({ wordsDone: false })} />);
  const pane = container.querySelector('.md-tabpane');
  expect(pane).toHaveAttribute('inert');
  expect(pane).toHaveClass('is-off');
  rerender(<DrinksTab {...props()} />);
  expect(pane).not.toHaveAttribute('inert');
});

test('"<k> of 8 illustrated", the rows in menu order, numbered', () => {
  render(<DrinksTab {...props()} />);
  // Visible with art: Paloma, Coral Crush, Old Fashioned, Cucumber Mule.
  expect(screen.getByText('4 of 8 illustrated')).toHaveClass('md-num');
  const rows = screen.getAllByRole('button', { expanded: false });
  expect(rows.map((b) => b.querySelector('.md-drink-n').textContent)).toEqual(['01', '02', '03', '04', '05', '06']);
  expect(rows.map((b) => b.querySelector('.md-drink-name').firstChild.textContent))
    .toEqual(["Roscoe's Paloma", 'Old Fashioned', 'Lemon Drop', 'Cucumber Mule', 'Daiquiri', 'Coral Crush']);
  expect(screen.getByText('Up to 8 are illustrated. Drinks 9 to 12 list as text under “More from the bar”.')).toBeInTheDocument();
});

test('the row statuses and sub lines', () => {
  render(<DrinksTab {...props()} />);
  const st = (name) => rowOf(name).querySelector('.md-drink-st');
  const sub = (name) => rowOf(name).querySelector('.md-drink-sub').textContent;
  expect(st('Old Fashioned')).toHaveTextContent('PAINTING');
  expect(st('Old Fashioned')).toHaveClass('md-st-info');
  expect(st('Cucumber Mule')).toHaveTextContent('WAITING');
  expect(st('Coral Crush')).toHaveTextContent('FAILED');
  expect(st('Coral Crush')).toHaveClass('md-st-danger');
  expect(st('Lemon Drop')).toHaveTextContent('HIDDEN');
  expect(st("Roscoe's Paloma")).toHaveTextContent('');
  expect(st('Daiquiri')).toHaveTextContent('');
  // " · Gemini" only on done art Gemini drew; New from plan reads added_by_sync.
  expect(sub("Roscoe's Paloma")).toBe('Signature · Gemini');
  expect(sub('Old Fashioned')).toBe('Signature');
  expect(sub('Coral Crush')).toBe('Mocktail');
  expect(sub('Cucumber Mule')).toBe('New from plan');
  expect(sub('Lemon Drop')).toBe('Signature');
});

test('hidden rows are struck through', () => {
  render(<DrinksTab {...props()} />);
  expect(rowOf('Lemon Drop').querySelector('.md-drink-name')).toHaveClass('is-hidden');
  expect(rowOf('Old Fashioned').querySelector('.md-drink-name')).not.toHaveClass('is-hidden');
});

test('a row selects its drink; the selected row toggles it off', () => {
  const p = props();
  const { rerender } = render(<DrinksTab {...p} />);
  fireEvent.click(within(rowOf('Old Fashioned')).getAllByRole('button')[0]);
  expect(p.onSelectDrink).toHaveBeenLastCalledWith('cocktail:7');
  rerender(<DrinksTab {...p} selectedDrink="cocktail:7" />);
  expect(rowOf('Old Fashioned')).toHaveClass('is-sel');
  fireEvent.click(screen.getByRole('button', { expanded: true }));
  expect(p.onSelectDrink).toHaveBeenLastCalledWith(null);
});

describe('the open row', () => {
  test('the 200-character note, Re-roll art with it, and Hide', () => {
    const p = props({ selectedDrink: 'custom:paloma' });
    render(<DrinksTab {...p} />);
    const open = rowOf("Roscoe's Paloma");
    const note = within(open).getByPlaceholderText('Note for the re-roll, e.g. add a salt rim');
    expect(note).toHaveAttribute('maxLength', '200');
    fireEvent.change(note, { target: { value: '  add a salt rim ' } });
    fireEvent.click(within(open).getByRole('button', { name: 'Re-roll art' }));
    expect(p.onReroll).toHaveBeenCalledWith('custom:paloma', 'add a salt rim');
    expect(note).toHaveValue('');
    fireEvent.click(within(open).getByRole('button', { name: 'Hide' }));
    const sent = p.onPatch.mock.calls[0][0].content.drinks;
    expect(sent.find((d) => d.key === 'custom:paloma').hidden).toBe(true);
    expect(sent).toHaveLength(6);
  });

  test('a drink with no description can be given one again (the canvas prints none to click)', () => {
    const drinks = DRINKS().map((d) => (d.key === 'cocktail:7' ? { ...d, description: '', description_ai_written: true } : d));
    const p = props({ selectedDrink: 'cocktail:7', content: { words_status: 'done', drinks } });
    const { rerender } = render(<DrinksTab {...p} />);
    const field = within(rowOf('Old Fashioned')).getByPlaceholderText('Add a description');
    expect(field).toHaveAttribute('maxLength', '200');
    fireEvent.blur(field);
    expect(p.onPatch).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: '  Bourbon, bitters,  orange. ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);
    const sent = p.onPatch.mock.calls[0][0].content.drinks.find((d) => d.key === 'cocktail:7');
    expect(sent).toMatchObject({ description: 'Bourbon, bitters, orange.', description_ai_written: false });
    // A drink with a description edits it on the canvas instead.
    rerender(<DrinksTab {...props({ selectedDrink: 'custom:paloma', content: { words_status: 'done', drinks: DRINKS().map((d) => ({ ...d, description: 'Tequila.' })) } })} />);
    expect(screen.queryByPlaceholderText('Add a description')).toBeNull();
  });

  test('a read-only draft (no plan): inert, no re-roll, no Hide, no description', () => {
    const p = props({ draft: { id: 1, read_only: true }, selectedDrink: 'custom:paloma' });
    const { container } = render(<DrinksTab {...p} />);
    expect(container.querySelector('.md-tabpane')).toHaveAttribute('inert');
    const open = rowOf("Roscoe's Paloma");
    const reroll = within(open).getByRole('button', { name: 'Re-roll art' });
    expect(reroll).toBeDisabled();
    expect(reroll).toHaveAttribute('title', 'No drink plan on this event. The draft is read-only.');
    expect(within(open).getByRole('button', { name: 'Hide' })).toBeDisabled();
    expect(within(open).getByPlaceholderText('Add a description')).toBeDisabled();
    fireEvent.click(reroll);
    fireEvent.click(within(open).getByRole('button', { name: 'Hide' }));
    expect(p.onReroll).not.toHaveBeenCalled();
    expect(p.onPatch).not.toHaveBeenCalled();
  });

  test('a hidden drink shows again', () => {
    const p = props({ selectedDrink: 'cocktail:9' });
    render(<DrinksTab {...p} />);
    fireEvent.click(within(rowOf('Lemon Drop')).getByRole('button', { name: 'Show' }));
    expect(p.onPatch.mock.calls[0][0].content.drinks.find((d) => d.key === 'cocktail:9').hidden).toBe(false);
  });

  test('Re-roll art is disabled when no image remains, for a text-only drink, and while it draws', () => {
    const { rerender } = render(<DrinksTab {...props({ selectedDrink: 'custom:paloma', cap: { used: 60, limit: 60, remaining: 0 } })} />);
    const btn = () => screen.getByRole('button', { name: 'Re-roll art' });
    expect(btn()).toBeDisabled();
    expect(btn()).toHaveAttribute('title', 'Daily image limit reached.');
    rerender(<DrinksTab {...props({ selectedDrink: 'custom:paloma', configured: { openai: false, gemini: false } })} />);
    expect(btn()).toBeDisabled();
    rerender(<DrinksTab {...props({ selectedDrink: 'cocktail:2' })} />);
    expect(btn()).toBeDisabled();
    rerender(<DrinksTab {...props({ selectedDrink: 'cocktail:7' })} />);
    expect(btn()).toBeDisabled();
    rerender(<DrinksTab {...props({ selectedDrink: 'mocktail:3' })} />);
    expect(btn()).toBeEnabled();
  });

  test('Show is held, with its reason, past the drink limits', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => drink(`custom:d${i}`, `D${i}`, { has_art: i < 8 }));
    const drinks = [...twelve, drink('custom:x', 'Extra', { hidden: true })];
    render(<DrinksTab {...props({ content: { words_status: 'done', drinks }, pieces: [], selectedDrink: 'custom:x' })} />);
    const show = within(rowOf('Extra')).getByRole('button', { name: 'Show' });
    expect(show).toBeDisabled();
    expect(show).toHaveAttribute('title', 'At most 12 drinks can show on the menu. Hide another first.');
  });
});

test('visible drinks past the menu\'s limits are named', () => {
  const drinks = Array.from({ length: 14 }, (_, i) => drink(`custom:d${i}`, `D${i}`, { has_art: i < 8 }));
  render(<DrinksTab {...props({ content: { words_status: 'done', drinks }, pieces: [] })} />);
  expect(screen.getByText('8 of 8 illustrated')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent("2 drinks won't fit on the menu. Hide 2 to fit.");
});
