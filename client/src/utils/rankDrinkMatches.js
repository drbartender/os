// Fuzzy ranking of a client-typed custom drink request against the admin
// drink lists, for the shopping list's "Match to existing" picker
// (components/ShoppingList/NeedsRecipeSection.jsx).
//
// Auto-matching is EXACT on the server (shoppingListGen.matchCustomNames: a
// fuzzy server match could put the wrong bottles on a list). This ranking is
// suggestion-only: it orders candidates an admin then confirms by hand, and
// that confirmation is what writes the alias. Pure, no DOM, no network.

// Mirror of the server matcher's matchKey (shoppingListGen.js) and
// RecipeEditor's normalizeName: apostrophes (straight, both curly, backtick:
// phone keyboards emit all of them) dropped BEFORE punctuation goes to
// spaces so "jennys" hits "Jenny's".
export function matchKey(s) {
  return String(s ?? '')
    .replace(/['’‘`]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const MIN_SCORE = 20;
const PREFIX_MIN = 3;

// A query token counts as shared when a candidate token equals it or either
// is a prefix of the other ("marg" ~ "margarita", "fashion" ~ "fashioned").
function tokenShared(qt, candTokens) {
  return candTokens.some((ct) => ct === qt
    || (qt.length >= PREFIX_MIN && ct.startsWith(qt))
    || (ct.length >= PREFIX_MIN && qt.startsWith(ct)));
}

// One key contains the other as a whole run of words: "whiskey sour" inside
// "whiskey sour w egg white", never "gin" inside "virgin" (review finding:
// raw substring put two mocktails above a gin drink for "gin").
function containsWords(longer, shorter) {
  return ` ${longer} `.includes(` ${shorter} `);
}

// 100 exact; 80..95 one key contains the other's words (closer lengths score
// higher); 0..70 by the share of words in common (equal, or one a prefix of
// the other, so "old fashion" still finds "old fashioned"); 0 when nothing
// overlaps.
function scoreKeys(queryKey, candKey) {
  if (!candKey) return 0;
  if (candKey === queryKey) return 100;
  const [shorter, longer] = candKey.length < queryKey.length ? [candKey, queryKey] : [queryKey, candKey];
  if (containsWords(longer, shorter)) {
    return 80 + 15 * (shorter.length / longer.length);
  }
  const qTokens = queryKey.split(' ');
  const cTokens = candKey.split(' ');
  const shared = qTokens.filter((qt) => tokenShared(qt, cTokens)).length;
  if (shared === 0) return 0;
  return 70 * (shared / Math.max(qTokens.length, cTokens.length));
}

// @param query   the client's text as typed
// @param drinks  admin rows: { id, name, request_aliases?, is_active?, ... }
// @returns the input rows (same object identity, untouched) best-first,
//          at most `limit`, dropping anything below the confidence floor.
export function rankDrinkMatches(query, drinks, { limit = 5 } = {}) {
  const queryKey = matchKey(query);
  if (!queryKey) return [];
  const scored = [];
  for (const drink of drinks || []) {
    const keys = [drink.name, ...(drink.request_aliases || [])].map(matchKey);
    const score = Math.max(0, ...keys.map((k) => scoreKeys(queryKey, k)));
    if (score >= MIN_SCORE) scored.push({ drink, score });
  }
  scored.sort((a, b) => (b.score - a.score)
    || (Number(b.drink.is_active !== false) - Number(a.drink.is_active !== false))
    || String(a.drink.name).localeCompare(String(b.drink.name)));
  return scored.slice(0, limit).map((s) => s.drink);
}
