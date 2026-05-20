// Pure helper consumed by both <MenuPreview> (HTML preview on MenuDesignStep)
// and <MenuPNG> (admin-side PNG export via html2canvas). Extracts the menu's
// section structure from selections so both renderers stay in sync. Order is
// fixed: Cocktails, Mocktails, Beer & Wine, Bar Service. Empty sections are
// skipped. See spec section 5 for the rationale and full rule set.

const BEER_WINE_DISPLAY_ORDER = ['Beer', 'Seltzer', 'Red', 'White', 'Sparkling'];

function uniq(arr) {
  return Array.from(new Set(arr));
}

function resolveNames(ids, lookupArray) {
  const byId = new Map((lookupArray || []).map((d) => [d.id, d.name]));
  return uniq(ids).map((id) => byId.get(id)).filter(Boolean);
}

function collapseBeerWine(selections) {
  const beerEntries = [
    ...(selections.beerFromFullBar || []),
    ...(selections.beerFromBeerWine || []),
  ];
  const wineEntries = [
    ...(selections.wineFromFullBar || []),
    ...(selections.wineFromBeerWine || []),
  ];

  const labels = new Set();
  // Any beer entry other than "Seltzer" rolls up to "Beer".
  if (beerEntries.some((e) => e && e !== 'Seltzer')) labels.add('Beer');
  if (beerEntries.includes('Seltzer')) labels.add('Seltzer');
  if (wineEntries.includes('Red')) labels.add('Red');
  if (wineEntries.includes('White')) labels.add('White');
  if (wineEntries.includes('Sparkling')) labels.add('Sparkling');
  // "Other" wine entries do NOT render a label.

  return BEER_WINE_DISPLAY_ORDER.filter((label) => labels.has(label));
}

export function extractMenuSections(selections, activeModules, cocktails, mocktails) {
  const sections = [];

  // 1. Cocktails
  const sigIds = Array.isArray(selections.signatureDrinks) ? selections.signatureDrinks : [];
  if (sigIds.length > 0) {
    const items = resolveNames(sigIds, cocktails);
    if (items.length > 0) {
      sections.push({ kind: 'cocktails', title: 'Cocktails', items });
    }
  }

  // 2. Mocktails
  const mocIds = Array.isArray(selections.mocktails) ? selections.mocktails : [];
  if (mocIds.length > 0) {
    const items = resolveNames(mocIds, mocktails);
    if (items.length > 0) {
      sections.push({ kind: 'mocktails', title: 'Mocktails', items });
    }
  }

  // 3. Beer & Wine
  const beerWineLabels = collapseBeerWine(selections);
  if (beerWineLabels.length > 0) {
    sections.push({ kind: 'beer-wine', title: 'Beer & Wine', items: beerWineLabels });
  }

  // 4. Bar Service fallback (full bar with no signature cocktails)
  if (activeModules?.fullBar === true && sigIds.length === 0) {
    sections.push({ kind: 'bar-service', title: 'Bar Service', items: ['Call Drinks'] });
  }

  return { sections, isEmpty: sections.length === 0 };
}
