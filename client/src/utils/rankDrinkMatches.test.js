// Pure ranking for the shopping list's "Match to existing" picker: a
// client-typed custom request against the admin drink lists. Auto-matching
// stays EXACT server-side (shoppingListGen.matchCustomNames); this fuzzy
// ranking only orders suggestions an admin then confirms by hand.
import { rankDrinkMatches, matchKey } from './rankDrinkMatches';

const drink = (name, extra = {}) => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  name,
  is_active: true,
  ingredients: [{ item: 'x' }],
  request_aliases: [],
  table: 'cocktails',
  ...extra,
});

const POOL = [
  drink('Old Fashioned'),
  drink('Margarita'),
  drink('Spicy Margarita'),
  drink('Whiskey Sour'),
  drink('Amaretto Sour'),
  drink('Paloma', { is_active: false, ingredients: [] }),
  drink("Jenny's Lemonade", { table: 'mocktails' }),
  drink('Moscow Mule', { request_aliases: ['vodka mule'] }),
];

const names = (query, opts) => rankDrinkMatches(query, POOL, opts).map((d) => d.name);

test('matchKey mirrors the server matcher: lowercase, punctuation to spaces, apostrophes dropped', () => {
  expect(matchKey("Jenny's  Lemonade!")).toBe('jennys lemonade');
  expect(matchKey('  Old-Fashioned ')).toBe('old fashioned');
  expect(matchKey('Jenny‘s')).toBe('jennys'); // curly open quote, some phone keyboards
  expect(matchKey('Jenny`s')).toBe('jennys');
  expect(matchKey('')).toBe('');
});

test('a query buried inside another word is not a hit (gin never surfaces Virgin)', () => {
  const pool = [drink('Virgin Mary'), drink('Gin Fizz'), drink('Gin Basil Smash'), drink('Virgin Mojito')];
  expect(rankDrinkMatches('gin', pool).map((d) => d.name)).toEqual(['Gin Fizz', 'Gin Basil Smash']);
});

test('a near-miss spelling ranks the drink it contains first', () => {
  expect(names('old fashion')[0]).toBe('Old Fashioned');
});

test('extra words around a real drink name still find it, and not its sour cousin', () => {
  const ranked = names('Whiskey Sour w/ egg white');
  expect(ranked[0]).toBe('Whiskey Sour');
  expect(ranked).not.toContain('Amaretto Sour');
});

test('an abbreviated token prefers the drink that shares more of its words', () => {
  expect(names('spicy marg').slice(0, 2)).toEqual(['Spicy Margarita', 'Margarita']);
});

test('an exact name outranks everything, even when the drink is off-menu with no recipe', () => {
  expect(names('paloma')[0]).toBe('Paloma');
});

test('stored aliases count as names', () => {
  expect(names('vodka mule')[0]).toBe('Moscow Mule');
});

test('unrelated text yields nothing rather than a wrong guess', () => {
  expect(names('the blue drink from my cousins wedding')).toEqual([]);
});

test('limit caps the list and results carry the drink intact', () => {
  const ranked = rankDrinkMatches('sour', POOL, { limit: 1 });
  expect(ranked).toHaveLength(1);
  expect(ranked[0]).toMatchObject({ table: 'cocktails', is_active: true });
  expect(ranked[0].name.endsWith('Sour')).toBe(true);
});

test('ties break active first, then by name', () => {
  const pool = [drink('Zeta Sour', { is_active: false }), drink('Beta Sour'), drink('Alfa Sour')];
  expect(rankDrinkMatches('sour', pool).map((d) => d.name)).toEqual(['Alfa Sour', 'Beta Sour', 'Zeta Sour']);
});

test('a blank query yields nothing', () => {
  expect(names('   ')).toEqual([]);
});
