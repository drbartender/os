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

// The lines as a draft stores them (spec 2026-10-19 section 17, lane
// menu-bar-baseline): each carries a server-written key, the builder's label,
// beside the label the owner may rename on the canvas. Update draft finds the
// line to refresh by its key, so a renamed line is still rewritten or removed
// in place; the PATCH keeps the stored key and never takes one. buildAlsoAtBar
// stays keyless, since the fingerprint hashes only the label and text.
function keyedBarLines(bar) {
  return buildAlsoAtBar(bar).map((line) => ({ key: line.label, label: line.label, text: line.text }));
}

// A stored line's key: its own, or for a line stored before keys existed and
// not keyed yet (keyBarLines), its label.
function barLineKey(line) {
  if (!line || typeof line !== 'object') return '';
  if (typeof line.key === 'string' && line.key) return line.key;
  return typeof line.label === 'string' ? line.label : '';
}

const BAR_ORDER = Object.values(LINE_LABELS);
const isLine = (l) => l !== null && typeof l === 'object' && !Array.isArray(l);
const hasKey = (l) => isLine(l) && typeof l.key === 'string' && l.key !== '';

// Every way the unkeyed lines, in stored order, can take the given builder
// labels in strictly rising print order, each between its keyed neighbours.
function readingsOf(slots, labels, limit = 2) {
  const out = [];
  const walk = (i, floor, picked) => {
    if (out.length >= limit) return; // enough readings to know it is ambiguous
    if (i === slots.length) { out.push(picked); return; }
    if (slots[i] !== null) { if (slots[i] > floor) walk(i + 1, slots[i], picked); return; }
    for (const label of labels) {
      const r = BAR_ORDER.indexOf(label);
      if (r > floor && !picked.includes(label)) walk(i + 1, r, [...picked, label]);
    }
  };
  walk(0, -1, []);
  return out;
}

// The words each line prints from the builder's own tables, lower-cased, for
// telling a renamed line's category from its text ("Vodka, Gin." is Spirits).
const LINE_WORDS = new Map([
  [LINE_LABELS.beerWine, [...BEER_TABLE, ...WINE_TABLE].map(([, word]) => word.toLowerCase())],
  [LINE_LABELS.spirits, SPIRIT_TABLE.map(([, word]) => word.toLowerCase())],
  [LINE_LABELS.na, NA_TABLE.map(([, word]) => word.toLowerCase())],
]);
const hasWord = (text, word) => new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(text);

// The one category whose table words a line's text carries most, or null when
// none or a tie.
function categoryByWords(text) {
  const t = typeof text === 'string' ? text.toLowerCase() : '';
  let best = null;
  let bestScore = 0;
  let tied = false;
  for (const [label, words] of LINE_WORDS) {
    const score = words.filter((w) => hasWord(t, w)).length;
    if (score > bestScore) { best = label; bestScore = score; tied = false; } else if (score > 0 && score === bestScore) tied = true;
  }
  return tied ? null : best;
}

// Keys the lines of a draft stored before keys existed (pure; lane
// menu-bar-baseline). A line still under a builder label takes that label. The
// rest, lines the owner renamed, take builder labels by their place in the
// print order (lines are built in that order and a PATCH never adds, removes or
// reorders one); when more than one reading fits, a renamed line whose text
// carries one category's table words (categoryByWords) must take that one. A
// line no single reading fits stays unkeyed: Update draft never matches it, and
// replaces it with freshly built lines when the bar moves (refreshBarLines).
// Lines already keyed are left alone.
function keyBarLines(lines) {
  if (!Array.isArray(lines)) return { lines, byLabel: 0, byOrder: 0, unkeyed: 0 };
  const taken = new Set(lines.filter(hasKey).map((l) => l.key));
  let byLabel = 0;
  const step1 = lines.map((l) => {
    if (!isLine(l) || hasKey(l) || !BAR_ORDER.includes(l.label) || taken.has(l.label)) return l;
    taken.add(l.label);
    byLabel += 1;
    return { key: l.label, ...l };
  });
  const open = step1.map((l, i) => (isLine(l) && !hasKey(l) ? i : -1)).filter((i) => i !== -1);
  if (!open.length) return { lines: step1, byLabel, byOrder: 0, unkeyed: 0 };
  const slots = step1.map((l, i) => {
    if (open.includes(i)) return null;
    return hasKey(l) && BAR_ORDER.includes(l.key) ? BAR_ORDER.indexOf(l.key) : undefined;
  }).filter((v) => v !== undefined);
  const free = BAR_ORDER.filter((label) => !taken.has(label));
  let found = readingsOf(slots, free, Infinity);
  if (found.length > 1) {
    const hints = open.map((i) => categoryByWords(step1[i].text));
    found = found.filter((reading) => reading.every((label, j) => hints[j] === null || hints[j] === label));
  }
  if (found.length !== 1) return { lines: step1, byLabel, byOrder: 0, unkeyed: open.length };
  const assigned = [...found[0]];
  return { lines: step1.map((l, i) => (open.includes(i) ? { key: assigned.shift(), ...l } : l)), byLabel, byOrder: open.length, unkeyed: 0 };
}

module.exports = { buildAlsoAtBar, keyedBarLines, barLineKey, keyBarLines, categoryByWords, LINE_LABELS, HOUSE_BEER_MIX, TEXT_MAX };
