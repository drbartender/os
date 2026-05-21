const BAR_TYPE_LABELS = {
  full_bar: 'Full bar',
  sig_beer_wine: 'Signature cocktails plus beer and wine',
  beer_wine: 'Beer and wine',
  mocktails: 'Mocktails',
};

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Render the saved consult_selections JSON into a list of one-line strings
 * suitable for the postConsultClient email recap.
 *
 * Fields are all optional; missing fields are skipped. Returns at least one
 * line (a placeholder if the consult is empty), never an empty array.
 */
function formatConsultRecap(consult = {}) {
  if (!consult || typeof consult !== 'object') {
    return ['(no specific selections captured; notes are on file)'];
  }
  const lines = [];

  if (consult.barType && BAR_TYPE_LABELS[consult.barType]) {
    lines.push(`Bar style: ${BAR_TYPE_LABELS[consult.barType]}`);
  }

  if (Array.isArray(consult.spirits) && consult.spirits.length) {
    lines.push(`Spirits: ${consult.spirits.map(titleCase).join(', ')}`);
  }

  if (Array.isArray(consult.signatureDrinks) && consult.signatureDrinks.length) {
    lines.push(`Signature cocktails: ${consult.signatureDrinks.join(', ')}`);
  }

  if (Array.isArray(consult.customCocktails) && consult.customCocktails.length) {
    for (const c of consult.customCocktails) {
      if (!c || !c.name) continue;
      const ingredients = Array.isArray(c.ingredients) && c.ingredients.length
        ? ` (${c.ingredients.join(', ')})`
        : '';
      lines.push(`Custom cocktail: ${c.name}${ingredients}`);
    }
  }

  if (consult.mocktailsEnabled || (Array.isArray(consult.mocktails) && consult.mocktails.length)) {
    if (Array.isArray(consult.mocktails) && consult.mocktails.length) {
      lines.push(`Mocktails: ${consult.mocktails.join(', ')}`);
    } else {
      lines.push('Mocktails: yes (selections TBD)');
    }
  }

  if (Array.isArray(consult.customMocktails) && consult.customMocktails.length) {
    for (const c of consult.customMocktails) {
      if (!c || !c.name) continue;
      const ingredients = Array.isArray(c.ingredients) && c.ingredients.length
        ? ` (${c.ingredients.join(', ')})`
        : '';
      lines.push(`Custom mocktail: ${c.name}${ingredients}`);
    }
  }

  if (consult.beer) lines.push('Beer: yes');

  if (Array.isArray(consult.wine) && consult.wine.length) {
    lines.push(`Wine: ${consult.wine.join(', ')}`);
  }

  if (consult.notes && typeof consult.notes === 'string' && consult.notes.trim()) {
    lines.push(`Notes: ${consult.notes.trim()}`);
  }

  return lines.length ? lines : ['(no specific selections captured; notes are on file)'];
}

/**
 * Choose the right next-step line based on bar option. BYOB sends the
 * shopping-list pointer; Hosted points at bartender prep. Unknown defaults
 * to BYOB.
 */
function pickNextStepLine(barOption) {
  if (barOption === 'hosted') return 'Your bartender will prep based on this.';
  return "We'll send your shopping list shortly.";
}

module.exports = { formatConsultRecap, pickNextStepLine };
