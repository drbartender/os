import { extractMenuSections } from './menuSections';

const baseSelections = {
  signatureDrinks: [],
  mocktails: [],
  beerFromFullBar: [],
  wineFromFullBar: [],
  beerFromBeerWine: [],
  wineFromBeerWine: [],
};

const baseModules = { signatureDrinks: false, mocktails: false, fullBar: false, beerWineOnly: false };

const sig = (ids) => ids.map((id) => ({ id, name: `Cocktail ${id}` }));
const moc = (ids) => ids.map((id) => ({ id, name: `Mocktail ${id}` }));

describe('extractMenuSections', () => {
  it('returns empty sections when nothing is selected', () => {
    const result = extractMenuSections(baseSelections, baseModules, [], []);
    expect(result.sections).toEqual([]);
    expect(result.isEmpty).toBe(true);
  });

  it('renders Cocktails section in selection order with resolved names', () => {
    const selections = { ...baseSelections, signatureDrinks: [3, 1, 2] };
    const cocktails = sig([1, 2, 3]);
    const result = extractMenuSections(selections, { ...baseModules, signatureDrinks: true }, cocktails, []);
    expect(result.sections).toEqual([
      { kind: 'cocktails', title: 'Cocktails', items: ['Cocktail 3', 'Cocktail 1', 'Cocktail 2'] },
    ]);
  });

  it('silently drops cocktail IDs that no longer exist in the resolver array', () => {
    const selections = { ...baseSelections, signatureDrinks: [1, 99, 2] };
    const result = extractMenuSections(selections, { ...baseModules, signatureDrinks: true }, sig([1, 2]), []);
    expect(result.sections[0].items).toEqual(['Cocktail 1', 'Cocktail 2']);
  });

  it('renders Mocktails section when selections.mocktails has items', () => {
    const selections = { ...baseSelections, mocktails: [10, 11] };
    const result = extractMenuSections(selections, { ...baseModules, mocktails: true }, [], moc([10, 11]));
    expect(result.sections).toEqual([
      { kind: 'mocktails', title: 'Mocktails', items: ['Mocktail 10', 'Mocktail 11'] },
    ]);
  });

  it('collapses beer/wine arrays into fixed labels in display order', () => {
    const selections = {
      ...baseSelections,
      beerFromFullBar: ['IPA', 'Seltzer', 'Light / Easy Drinking'],
      wineFromFullBar: ['Red', 'White', 'Sparkling'],
    };
    const result = extractMenuSections(selections, { ...baseModules, fullBar: true, signatureDrinks: false }, [], []);
    const bw = result.sections.find((s) => s.kind === 'beer-wine');
    expect(bw).toBeDefined();
    expect(bw.items).toEqual(['Beer', 'Seltzer', 'Red', 'White', 'Sparkling']);
  });

  it('rolls Light / Easy Drinking and Craft / Local and IPA and Non-Alcoholic into a single Beer label', () => {
    const selections = { ...baseSelections, beerFromBeerWine: ['Light / Easy Drinking', 'Craft / Local', 'IPA', 'Non-Alcoholic'] };
    const result = extractMenuSections(selections, { ...baseModules, beerWineOnly: true }, [], []);
    const bw = result.sections.find((s) => s.kind === 'beer-wine');
    expect(bw.items).toEqual(['Beer']);
  });

  it('omits the Beer label when only Seltzer is in the beer array', () => {
    const selections = { ...baseSelections, beerFromBeerWine: ['Seltzer'] };
    const result = extractMenuSections(selections, { ...baseModules, beerWineOnly: true }, [], []);
    const bw = result.sections.find((s) => s.kind === 'beer-wine');
    expect(bw.items).toEqual(['Seltzer']);
  });

  it('omits "Other" wine entries from the menu labels', () => {
    const selections = { ...baseSelections, wineFromBeerWine: ['Red', 'Other'] };
    const result = extractMenuSections(selections, { ...baseModules, beerWineOnly: true }, [], []);
    const bw = result.sections.find((s) => s.kind === 'beer-wine');
    expect(bw.items).toEqual(['Red']);
  });

  it('does not render the Beer & Wine section when only "Other" wine is selected', () => {
    const selections = { ...baseSelections, wineFromBeerWine: ['Other'] };
    const result = extractMenuSections(selections, { ...baseModules, beerWineOnly: true }, [], []);
    expect(result.sections.find((s) => s.kind === 'beer-wine')).toBeUndefined();
  });

  it('renders Bar Service fallback when fullBar is active and no signature cocktails are selected', () => {
    const selections = { ...baseSelections };
    const result = extractMenuSections(selections, { ...baseModules, fullBar: true }, [], []);
    const fallback = result.sections.find((s) => s.kind === 'bar-service');
    expect(fallback).toEqual({ kind: 'bar-service', title: 'Bar Service', items: ['Call Drinks'] });
  });

  it('does NOT render Bar Service when signature cocktails ARE selected', () => {
    const selections = { ...baseSelections, signatureDrinks: [1] };
    const result = extractMenuSections(selections, { ...baseModules, fullBar: true, signatureDrinks: true }, sig([1]), []);
    expect(result.sections.find((s) => s.kind === 'bar-service')).toBeUndefined();
  });

  it('renders all sections in the fixed order: Cocktails, Mocktails, Beer & Wine, Bar Service', () => {
    // Pathological mix: signature drinks + mocktails + beer/wine + fullBar.
    // Bar Service should NOT appear because signature drinks are present.
    const selections = {
      ...baseSelections,
      signatureDrinks: [1],
      mocktails: [10],
      beerFromFullBar: ['IPA'],
      wineFromFullBar: ['Red'],
    };
    const result = extractMenuSections(
      selections,
      { ...baseModules, fullBar: true, mocktails: true, signatureDrinks: true },
      sig([1]),
      moc([10])
    );
    expect(result.sections.map((s) => s.kind)).toEqual(['cocktails', 'mocktails', 'beer-wine']);
  });

  it('deduplicates by id within Cocktails and Mocktails sections', () => {
    const selections = { ...baseSelections, signatureDrinks: [1, 1, 2] };
    const result = extractMenuSections(selections, { ...baseModules, signatureDrinks: true }, sig([1, 2]), []);
    expect(result.sections[0].items).toEqual(['Cocktail 1', 'Cocktail 2']);
  });
});
