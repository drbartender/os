// The "Also at the bar" lines of a generated bar menu (spec 5.2, Bar lines).
//
// A fixed label table, deliberately finer than the house menu's
// collapseBeerWine (client/src/pages/plan/data/menuSections.js): each beer
// style keeps its own word, the two non-alcoholic picks become one
// "Athletic Brewing NA" on its own line, "None" and "Other" render nothing.
// Dallas adds brand names by editing the lines in the designer.
//
// Pure. The input is the `bar` that menuDrinkSource.normalizePlan builds from
// whichever side feeds the menu. It is read loosely on purpose, so either side
// works without a translation step in between:
//   beer:         an array of planner labels ("Light / Easy Drinking", ...),
//                 or the consult side's boolean (true = the house mix, the
//                 same three styles buildGeneratorInputFromConsult uses)
//   na:           an array of non-alcoholic labels (also accepted in `beer`)
//   wine:         planner labels ("Red") or consult categories ("red")
//   spirits:      planner names ("Vodka") or consult slugs ("vodka")
//   spiritsOther: the planner's free-text "Other" spirit, appended as typed
// Labels match case-insensitively, and an already-mapped word ("Light beer")
// maps to itself, so running the table twice changes nothing.

const LINE_LABELS = Object.freeze({
  beerWine: 'Beer and Wine',
  spirits: 'Spirits',
  na: 'Non-Alcoholic',
});

// The also_at_bar[].text limit the draft PATCH enforces (spec 7.1). A built
// line never exceeds it, so the stored text always passes its own validation.
const TEXT_MAX = 120;

// The consult form's beer: true means this house mix (shoppingList.js).
const HOUSE_BEER_MIX = Object.freeze(['Light / Easy Drinking', 'Craft / Local', 'IPA']);

// [source label, menu word], in the order the words print.
const BEER_TABLE = [
  ['Light / Easy Drinking', 'Light beer'],
  ['Craft / Local', 'Craft beer'],
  ['IPA', 'IPA'],
  ['Seltzer', 'Seltzer'],
];
const NA_TABLE = [
  ['Non-Alcoholic', 'Athletic Brewing NA'],
  ['Non-Alcoholic (Athletic Brewing)', 'Athletic Brewing NA'],
];
const WINE_TABLE = [
  ['Red', 'Red'],
  ['White', 'White'],
  ['Sparkling', 'Sparkling'],
];
// Planner names and consult slugs, in the order they print. A spirit name
// outside this table is still listed by its own name, after these.
const SPIRIT_TABLE = [
  ['Vodka', 'Vodka'],
  ['Gin', 'Gin'],
  ['Rum', 'Rum'],
  ['Tequila', 'Tequila'],
  ['Bourbon', 'Bourbon'],
  ['Whiskey', 'Whiskey'],
  ['Scotch', 'Scotch'],
  ['Mezcal', 'Mezcal'],
];
const RENDERS_NOTHING = new Set(['none', 'other']);

// Input caps, applied before any per-item work. The caller caps too, but this
// module stays safe on its own: no list or name a menu could use comes close.
const MAX_ITEMS = 50;
const MAX_ITEM_CHARS = 200;

// One trailing character the line trim strips: whitespace or . , ; :
const TRAILING_PUNCTUATION = /[\s.,;:]/;

function norm(value) {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

// Map source label (and the menu word itself) to its menu word.
function lookupFor(table) {
  const map = new Map();
  for (const [source, word] of table) {
    map.set(norm(source), word);
    map.set(norm(word), word);
  }
  return map;
}
const BEER_LOOKUP = lookupFor(BEER_TABLE);
const NA_LOOKUP = lookupFor(NA_TABLE);
const WINE_LOOKUP = lookupFor(WINE_TABLE);
const SPIRIT_LOOKUP = lookupFor(SPIRIT_TABLE);

// A string is cut to MAX_ITEM_CHARS; a list keeps its first MAX_ITEMS entries,
// each cut the same way. Anything else passes through for asList to judge.
function capItem(value) {
  return typeof value === 'string' ? value.slice(0, MAX_ITEM_CHARS) : value;
}
function capInput(value) {
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(capItem);
  return capItem(value);
}

function asList(value) {
  if (value === true) return HOUSE_BEER_MIX.slice();
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim());
  if (typeof value === 'string' && value.trim()) return [value];
  return [];
}

// Words found in `table` order, each once.
function inTableOrder(table, found) {
  const words = [];
  for (const [, word] of table) {
    if (found.has(word) && !words.includes(word)) words.push(word);
  }
  return words;
}

// Walks back from the end, so it is linear. The regex /[\s.,;:]+$/ did the
// same job but backtracked quadratically on a long run of those characters
// that stops short of the end ("a.,.,.,...b").
function trimTrailingPunctuation(text) {
  let end = text.length;
  while (end > 0 && TRAILING_PUNCTUATION.test(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

function cleanFreeText(value) {
  if (typeof value !== 'string') return '';
  return trimTrailingPunctuation(value.replace(/\s+/g, ' ').trim());
}

// Join with ", " and end with ".", cut back to TEXT_MAX at a word boundary.
function joinLine(words) {
  const text = `${words.join(', ')}.`;
  if (text.length <= TEXT_MAX) return text;
  let cut = text.slice(0, TEXT_MAX - 1);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  return `${trimTrailingPunctuation(cut)}.`;
}

function buildAlsoAtBar(bar) {
  const raw = bar && typeof bar === 'object' ? bar : {};
  const src = {
    beer: capInput(raw.beer),
    na: capInput(raw.na),
    wine: capInput(raw.wine),
    spirits: capInput(raw.spirits),
    spiritsOther: capInput(raw.spiritsOther),
  };

  const beerFound = new Set();
  const naFound = new Set();
  for (const label of [...asList(src.beer), ...asList(src.na)]) {
    const key = norm(label);
    if (BEER_LOOKUP.has(key)) beerFound.add(BEER_LOOKUP.get(key));
    else if (NA_LOOKUP.has(key)) naFound.add(NA_LOOKUP.get(key));
  }

  const wineFound = new Set();
  for (const label of asList(src.wine)) {
    const key = norm(label);
    if (WINE_LOOKUP.has(key)) wineFound.add(WINE_LOOKUP.get(key));
  }

  const spiritFound = new Set();
  const spiritExtra = [];
  const extraKeys = new Set();
  for (const label of asList(src.spirits)) {
    const key = norm(label);
    if (RENDERS_NOTHING.has(key)) continue;
    if (SPIRIT_LOOKUP.has(key)) {
      spiritFound.add(SPIRIT_LOOKUP.get(key));
    } else {
      const named = cleanFreeText(label);
      const namedKey = norm(named);
      if (named && !extraKeys.has(namedKey)) {
        extraKeys.add(namedKey);
        spiritExtra.push(named);
      }
    }
  }
  const other = cleanFreeText(src.spiritsOther);

  const beerWine = [...inTableOrder(BEER_TABLE, beerFound), ...inTableOrder(WINE_TABLE, wineFound)];
  const spirits = [...inTableOrder(SPIRIT_TABLE, spiritFound), ...spiritExtra];
  const otherKey = norm(other);
  if (other && !spirits.some((s) => norm(s) === otherKey)) spirits.push(other);
  const na = inTableOrder(NA_TABLE, naFound);

  const lines = [];
  if (beerWine.length) lines.push({ label: LINE_LABELS.beerWine, text: joinLine(beerWine) });
  if (spirits.length) lines.push({ label: LINE_LABELS.spirits, text: joinLine(spirits) });
  if (na.length) lines.push({ label: LINE_LABELS.na, text: joinLine(na) });
  return lines;
}

module.exports = { buildAlsoAtBar, LINE_LABELS, HOUSE_BEER_MIX, TEXT_MAX };
