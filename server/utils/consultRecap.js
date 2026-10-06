const { recipeRowLabel } = require('./potionCatalog');

const BAR_TYPE_LABELS = {
  full_bar: 'Full bar',
  sig_beer_wine: 'Signature cocktails plus beer and wine',
  beer_wine: 'Beer and wine',
  mocktails: 'Mocktails',
};

// The three mixer modes ConsultationForm.jsx writes, in the form's own terms.
// Printed only on the two bars that offer the choice: the form forces 'none'
// on beer-and-wine and mocktail-only bars. 'none' still puts signature
// cocktail ingredients on the list, so a bare "None" would contradict the
// list the client then receives.
const MIXER_LABELS = new Map([
  ['full', 'Full set'],
  ['matching', 'Only those that match your spirits'],
  ['none', 'None beyond your signature cocktail ingredients'],
]);
const MIXER_BAR_TYPES = new Set(['full_bar', 'sig_beer_wine']);

const EMPTY_PLACEHOLDER = '(no specific selections captured; notes are on file)';

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b\w/g, c => c.toUpperCase());
}

// "french-75" -> "French 75". The consult form stores catalog ids, so a drink
// that has since left the catalog still reads as words, never as a slug.
function humanizeDrinkId(id) {
  const raw = String(id || '');
  const words = raw.split(/[-_\s]+/).filter(Boolean);
  // An id made only of separators keeps its raw form rather than vanishing
  // into an empty entry.
  return words.length ? words.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : raw;
}

// The picked ids as strings. Anything else (an object, a boolean, a blank)
// is skipped, never stringified into "[object Object]".
function drinkIds(v) {
  if (!Array.isArray(v)) return [];
  return v
    .filter(x => (typeof x === 'string' && x.trim()) || (typeof x === 'number' && Number.isFinite(x)))
    .map(String);
}

// ids -> display names through a Map from loadConsultDrinkNames. A caller with
// no names (or an id the catalog no longer holds) gets the humanized id.
function drinkNames(ids, map) {
  return ids.map(id => (map instanceof Map && map.get(id)) || humanizeDrinkId(id));
}

// " (gin, lime, simple syrup)" for a custom drink's ingredient rows, or '' when
// there is nothing usable to name. Array.join() stringifies each element, so a
// structured { ingredient, amount, unit } row (the shape cocktails.ingredients
// uses) would join as '[object Object]' — in an email a client reads. Fork on
// the row shape through the one shared helper instead.
function ingredientSuffix(rows) {
  if (!Array.isArray(rows)) return '';
  const labels = rows.map(recipeRowLabel).filter(Boolean);
  return labels.length ? ` (${labels.join(', ')})` : '';
}

/**
 * The saved consult_selections JSON as one-line strings, drink ids resolved
 * through `names` ({ cocktails: Map, mocktails: Map }). Fields are all
 * optional; missing fields are skipped. [] when there is nothing to say.
 */
function consultRecapLines(consult, names = {}) {
  if (!consult || typeof consult !== 'object') return [];
  const { cocktails, mocktails } = names || {};
  const lines = [];

  if (consult.barType && BAR_TYPE_LABELS[consult.barType]) {
    lines.push(`Bar style: ${BAR_TYPE_LABELS[consult.barType]}`);
  }

  if (Array.isArray(consult.spirits) && consult.spirits.length) {
    lines.push(`Spirits: ${consult.spirits.map(titleCase).join(', ')}`);
  }

  const sigIds = drinkIds(consult.signatureDrinks);
  if (sigIds.length) {
    lines.push(`Signature cocktails: ${drinkNames(sigIds, cocktails).join(', ')}`);
  }

  if (Array.isArray(consult.customCocktails) && consult.customCocktails.length) {
    for (const c of consult.customCocktails) {
      if (!c || !c.name) continue;
      lines.push(`Custom cocktail: ${c.name}${ingredientSuffix(c.ingredients)}`);
    }
  }

  const mockIds = drinkIds(consult.mocktails);
  if (consult.mocktailsEnabled || mockIds.length) {
    if (mockIds.length) {
      lines.push(`Mocktails: ${drinkNames(mockIds, mocktails).join(', ')}`);
    } else {
      lines.push('Mocktails: yes (selections TBD)');
    }
  }

  if (Array.isArray(consult.customMocktails) && consult.customMocktails.length) {
    for (const c of consult.customMocktails) {
      if (!c || !c.name) continue;
      lines.push(`Custom mocktail: ${c.name}${ingredientSuffix(c.ingredients)}`);
    }
  }

  if (consult.beer) lines.push('Beer: yes');

  if (Array.isArray(consult.wine) && consult.wine.length) {
    lines.push(`Wine: ${consult.wine.map(titleCase).join(', ')}`);
  }

  if (MIXER_BAR_TYPES.has(consult.barType) && MIXER_LABELS.has(consult.mixers)) {
    lines.push(`Mixers: ${MIXER_LABELS.get(consult.mixers)}`);
  }

  if (consult.notes && typeof consult.notes === 'string' && consult.notes.trim()) {
    lines.push(`Notes: ${consult.notes.trim()}`);
  }

  return lines;
}

/**
 * Render the saved consult_selections JSON into a list of one-line strings
 * suitable for the postConsultClient email recap. Never empty: a consult with
 * nothing to say gets the notes-on-file placeholder, as it always has.
 */
function formatConsultRecap(consult = {}, names = {}) {
  const lines = consultRecapLines(consult, names);
  return lines.length ? lines : [EMPTY_PLACEHOLDER];
}

// Reported, never thrown: every caller would rather print a humanized name,
// or hide the card, than fail (the one-shot first-save client email, the
// staff brief, the consult form's load). Same shape as reportCatalogIssue in
// shoppingListGen, with the Sentry call itself guarded so the report can
// never become the failure.
function reportRecapIssue(what, op, err) {
  console.error(`[consultRecap] ${what} failed:`, err ? err.message : '');
  try {
    if (process.env.SENTRY_DSN_SERVER) {
      const Sentry = require('@sentry/node');
      Sentry.captureException(err, { tags: { op } });
    }
  } catch (_) { /* reporting must never throw */ }
}

// One query per drink table, only for the ids the consult holds, whatever
// is_active says (a drink retired after the client picked it still reads by
// name). `db` is the caller's handle: the pool, or a client it already holds
// (one pooled connection per request, CLAUDE.md). Never rejects.
async function loadConsultDrinkNames(consult, db) {
  const empty = () => ({ cocktails: new Map(), mocktails: new Map() });
  const safe = consult && typeof consult === 'object' ? consult : {};
  const sigIds = drinkIds(safe.signatureDrinks);
  const mockIds = drinkIds(safe.mocktails);
  if (!sigIds.length && !mockIds.length) return empty();
  try {
    const none = { rows: [] };
    const [c, m] = await Promise.all([
      sigIds.length ? db.query('SELECT id, name FROM cocktails WHERE id = ANY($1::text[])', [sigIds]) : none,
      mockIds.length ? db.query('SELECT id, name FROM mocktails WHERE id = ANY($1::text[])', [mockIds]) : none,
    ]);
    return {
      cocktails: new Map(c.rows.map(r => [r.id, r.name])),
      mocktails: new Map(m.rows.map(r => [r.id, r.name])),
    };
  } catch (err) {
    reportRecapIssue('drink name lookup', 'consult_recap_names', err);
    // failed lets a caller tell a lookup that failed from ids the catalog lacks.
    return { ...empty(), failed: true };
  }
}

// The picked ids the lookup did not name: catalog drift that would otherwise
// be humanized silently into a client email.
function unmatchedDrinkIds(consult, names = {}) {
  const safe = consult && typeof consult === 'object' ? consult : {};
  const { cocktails, mocktails } = names || {};
  const named = (map, id) => map instanceof Map && map.has(id);
  return [
    ...drinkIds(safe.signatureDrinks).filter(id => !named(cocktails, id)),
    ...drinkIds(safe.mocktails).filter(id => !named(mocktails, id)),
  ];
}

/**
 * The consult as readable lines for the staff Consult card and the shopping
 * list's answers panel, or null. Null, never the email's placeholder, for a
 * missing, non-object or empty consult, or one with nothing to say, so those
 * surfaces hide instead of printing a line about nothing. Never rejects.
 */
async function buildConsultRecap(consult, db) {
  if (!consult || typeof consult !== 'object' || Array.isArray(consult)) return null;
  try {
    if (consultRecapLines(consult).length === 0) return null;
    const names = await loadConsultDrinkNames(consult, db);
    return consultRecapLines(consult, names);
  } catch (err) {
    // A row written before the sanitizer, or by hand, that the formatter
    // cannot read: the card hides instead of failing the staff brief or the
    // consult form's load.
    reportRecapIssue('recap format', 'consult_recap_format', err);
    return null;
  }
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

module.exports = {
  formatConsultRecap,
  consultRecapLines,
  humanizeDrinkId,
  loadConsultDrinkNames,
  unmatchedDrinkIds,
  buildConsultRecap,
  pickNextStepLine,
};
