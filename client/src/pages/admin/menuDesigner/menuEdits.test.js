import { textPatch, textLimit, cleanText, toggleHidden, drinkCounts, TEXT_LIMITS } from './menuEdits';

// The editor's content edits mirror server/utils/menuDraftValidation.js (spec
// 7.1): the limits, the fixed key set, the AI flags, the drink limits.

const drink = (key, over = {}) => ({
  key, source: 'custom', group: 'sig', display_name: key.toUpperCase(), description: `${key} desc`,
  hidden: false, has_art: true, name_ai_suggested: true, description_ai_written: true, ...over,
});
const content = (over = {}) => ({
  title: 'Bar Menu',
  headings: { sig: 'Signature Cocktails', mock: 'Mocktails', more: 'More from the bar', also: 'Also at the bar' },
  drinks: [drink('custom:a'), drink('cocktail:7')],
  also_at_bar: [{ label: 'Beer and Wine', text: 'Pinot, Lager.', extra: 'kept on the server' }, { label: 'Spirits', text: '' }],
  ...over,
});

test('the limits are the server\'s', () => {
  expect(TEXT_LIMITS).toEqual({
    title: { min: 1, max: 60 }, heading: { min: 1, max: 40 }, display_name: { min: 1, max: 60 },
    description: { min: 0, max: 200 }, label: { min: 1, max: 30 }, text: { min: 0, max: 120 },
  });
  expect(textLimit('title').max).toBe(60);
  expect(textLimit('headings.sig').max).toBe(40);
  expect(textLimit('drinks.custom:a.description').max).toBe(200);
  expect(textLimit('also_at_bar.1.label').max).toBe(30);
  expect(cleanText('  two\n words  ')).toBe('two words');
});

describe('textPatch', () => {
  test('the title, cleaned; unchanged or out of its limits is nothing', () => {
    expect(textPatch(content(), 'title', '  Cheers\n ')).toEqual({ title: 'Cheers' });
    expect(textPatch(content(), 'title', 'Bar Menu ')).toBeNull();
    expect(textPatch(content(), 'title', '   ')).toBeNull();
    expect(textPatch(content(), 'title', 'x'.repeat(61))).toBeNull();
    expect(textPatch(content(), 'title', 'x'.repeat(60))).toEqual({ title: 'x'.repeat(60) });
  });

  test('a stored text read back as saved is no edit: a newline, a double space, past its limit', () => {
    const drinks = [drink('cocktail:7', { description: 'Bourbon,  bitters,\n orange.' }), drink('cocktail:9', { description: 'y'.repeat(230) })];
    const c = content({ title: 'Cheers\nto  Love', drinks, also_at_bar: [{ label: 'Beer  and Wine', text: 'Pinot,\nLager.' }] });
    expect(textPatch(c, 'drinks.cocktail:7.description', 'Bourbon, bitters, orange.')).toBeNull();
    expect(textPatch(c, 'drinks.cocktail:9.description', 'y'.repeat(230))).toBeNull();
    expect(textPatch(c, 'title', 'Cheers to Love')).toBeNull();
    expect(textPatch(c, 'also_at_bar.0.label', 'Beer and Wine')).toBeNull();
    expect(textPatch(c, 'also_at_bar.0.text', ' Pinot, Lager. ')).toBeNull();
    // A real change past the limit is still refused; one within it is sent.
    expect(textPatch(c, 'drinks.cocktail:9.description', 'y'.repeat(229))).toBeNull();
    expect(textPatch(c, 'drinks.cocktail:9.description', 'y'.repeat(200)).drinks[1].description).toBe('y'.repeat(200));
  });

  test('a heading sends all four, defaults filled in', () => {
    const patch = textPatch(content({ headings: { sig: 'Ours' } }), 'headings.mock', 'Zero proof');
    expect(patch).toEqual({ headings: { sig: 'Ours', mock: 'Zero proof', more: 'More from the bar', also: 'Also at the bar' } });
    expect(textPatch(content(), 'headings.nope', 'x')).toBeNull();
    expect(textPatch(content(), 'headings.sig', 'x'.repeat(41))).toBeNull();
  });

  test('a drink name or description changes only that field and drops its AI flag', () => {
    const before = content();
    const patch = textPatch(before, 'drinks.custom:a.display_name', "Roscoe's Paloma");
    expect(patch.drinks).toHaveLength(2);
    expect(patch.drinks[0]).toEqual({ ...before.drinks[0], display_name: "Roscoe's Paloma", name_ai_suggested: false });
    expect(patch.drinks[1]).toBe(before.drinks[1]);
    const desc = textPatch(before, 'drinks.cocktail:7.description', '');
    expect(desc.drinks[1]).toEqual({ ...before.drinks[1], description: '', description_ai_written: false });
    expect(textPatch(before, 'drinks.custom:a.display_name', '')).toBeNull();
    expect(textPatch(before, 'drinks.custom:zzz.display_name', 'X')).toBeNull();
    expect(textPatch(before, 'drinks.custom:a.group', 'mock')).toBeNull();
  });

  test('an Also at the bar line keeps every line, each as its label and text only', () => {
    const patch = textPatch(content(), 'also_at_bar.1.text', 'Vodka, Gin.');
    expect(patch).toEqual({ also_at_bar: [{ label: 'Beer and Wine', text: 'Pinot, Lager.' }, { label: 'Spirits', text: 'Vodka, Gin.' }] });
    expect(textPatch(content(), 'also_at_bar.0.label', '')).toBeNull();
    expect(textPatch(content(), 'also_at_bar.5.text', 'x')).toBeNull();
    expect(textPatch(content(), 'also_at_bar.0.text', 'x'.repeat(121))).toBeNull();
  });
});

describe('toggleHidden', () => {
  const many = (n, over = () => ({})) => Array.from({ length: n }, (_, i) => drink(`custom:d${i}`, over(i)));

  test('Hide always hides', () => {
    const { patch, why } = toggleHidden(content(), 'custom:a');
    expect(why).toBe('');
    expect(patch.drinks[0].hidden).toBe(true);
    expect(patch.drinks[1].hidden).toBe(false);
  });

  test('Show while 8 visible have art lists the drink as text', () => {
    const drinks = [...many(8), drink('custom:x', { hidden: true })];
    const { patch } = toggleHidden({ drinks }, 'custom:x');
    expect(patch.drinks[8]).toMatchObject({ hidden: false, has_art: false });
    expect(drinkCounts(patch.drinks)).toEqual({ visible: 9, art: 8, noArt: 1 });
  });

  test('Show is refused past 12 visible or 4 without art', () => {
    const twelve = [...many(8), ...many(4, () => ({ has_art: false })).map((d, i) => ({ ...d, key: `custom:t${i}` })), drink('custom:x', { hidden: true })];
    expect(toggleHidden({ drinks: twelve }, 'custom:x')).toEqual({ patch: null, why: 'At most 12 drinks can show on the menu. Hide another first.' });
    const fourText = [...many(4, () => ({ has_art: false })), ...many(2).map((d, i) => ({ ...d, key: `custom:a${i}` })), drink('custom:x', { hidden: true, has_art: false })];
    expect(toggleHidden({ drinks: fourText }, 'custom:x').why).toBe('At most 4 drinks can list without art. Hide another first.');
  });

  test('an unknown key is nothing', () => {
    expect(toggleHidden(content(), 'custom:nope')).toEqual({ patch: null, why: '' });
  });
});
