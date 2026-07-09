'use strict';

/**
 * One-off, idempotent seeder for Potions (Bar Program) recipe DRAFTS.
 *
 * Two jobs, in order:
 *   1. Insert the recipe-support par_items rows: liqueurs, amari, bitters,
 *      vermouths, syrups, and garnishes that the classic specs call for but
 *      that live in no baseline shopping list. Every support row is
 *      in_full_bar=false, spirit_key=NULL, style_key=NULL, paired_spirits='{}',
 *      so it is INVISIBLE to every legacy generator slice (PARS_100,
 *      SPIRIT_PARS, beer/wine style maps, BASIC_MIXERS, GARNISHES,
 *      ALWAYS_INCLUDE, SPIRIT_MIXER_PAIRINGS). It only extends the alias index
 *      so recipes resolve. Inserted with ON CONFLICT (id) DO NOTHING.
 *   2. Write a classic-spec structured recipe (recipe_review='draft') onto each
 *      of the 25 seeded cocktails + 16 mocktails whose ingredients are still
 *      empty. Dallas corrects these in the Recipes tab; the drafts are a
 *      starting point, not gospel.
 *
 * Hard gates (all run BEFORE any write; each exits non-zero on failure):
 *   B. Parity pre-check. Build the eight legacy slices from par_items with and
 *      without the support rows and assert they are byte-identical. The support
 *      rows must be slice-invisible or the Lane A parity contract is broken.
 *   D. Resolution check. Every recipe row must resolve through
 *      resolveRecipeRow(row, catalog) to a real catalog item. An unresolved row
 *      is a missing alias, printed with drink + ingredient, and blocks all
 *      recipe writes.
 *
 * Idempotent:
 *   - support pars: ON CONFLICT (id) DO NOTHING (re-run inserts 0);
 *   - recipes: only drinks whose ingredients is empty ([] / NULL) are written,
 *     so a second live run reports 0 recipe writes.
 *
 * The worktree has no .env. Invoke against the dev DB with:
 *   DOTENV_CONFIG_PATH=/home/drbartender/projects/os/.env \
 *     node -r dotenv/config server/scripts/seedRecipeDrafts.js --dry-run
 *
 * Deploy-day (prod) is a separate, gated step: run against the Neon default
 * branch via the MCP connection string, --dry-run first, Dallas go/no-go.
 */

require('dotenv').config();
const { pool } = require('../db');
const { buildCatalogSlices, resolveRecipeRow } = require('../utils/potionCatalog');

// ── Support par rows ────────────────────────────────────────────────────────
// All in_full_bar=false, is_active=true, spirit_key=NULL, style_key=NULL,
// paired_spirits=[] -> invisible to every legacy slice. liquorBeerWine sort
// continues past the Lane A seed (blue-curacao=230) from 240 step 10;
// everythingElse continues past sour-mix (250) from 260 step 10.
const SUPPORT_PARS = [
  // liquorBeerWine (spirit role, 750mL; bitters in a small bottle)
  sp('sweet-vermouth', 'Sweet Vermouth', '750mL', 'liquorBeerWine', 'spirit', ['sweet vermouth'], 240),
  sp('dry-vermouth', 'Dry Vermouth', '750mL', 'liquorBeerWine', 'spirit', ['dry vermouth', 'vermouth'], 250),
  sp('campari', 'Campari', '750mL', 'liquorBeerWine', 'spirit', ['campari'], 260),
  sp('aperol', 'Aperol', '750mL', 'liquorBeerWine', 'spirit', ['aperol'], 270),
  sp('triple-sec', 'Triple Sec', '750mL', 'liquorBeerWine', 'spirit', ['triple sec', 'orange liqueur', 'cointreau'], 280),
  sp('coffee-liqueur', 'Coffee Liqueur', '750mL', 'liquorBeerWine', 'spirit', ['coffee liqueur', 'kahlua'], 290),
  sp('peychauds-bitters', "Peychaud's Bitters", '10oz', 'liquorBeerWine', 'spirit', ['peychauds'], 300),
  sp('absinthe', 'Absinthe', '750mL', 'liquorBeerWine', 'spirit', ['absinthe'], 310),
  sp('rye-whiskey', 'Rye Whiskey', '750mL', 'liquorBeerWine', 'spirit', ['rye'], 320),
  sp('amaretto', 'Amaretto', '750mL', 'liquorBeerWine', 'spirit', ['amaretto'], 330),
  sp('amaro-nonino', 'Amaro Nonino', '750mL', 'liquorBeerWine', 'spirit', ['amaro nonino', 'amaro'], 340),
  sp('averna', 'Averna', '750mL', 'liquorBeerWine', 'spirit', ['averna'], 350),
  sp('green-chartreuse', 'Green Chartreuse', '750mL', 'liquorBeerWine', 'spirit', ['green chartreuse', 'chartreuse'], 360),
  sp('maraschino-liqueur', 'Maraschino Liqueur', '750mL', 'liquorBeerWine', 'spirit', ['maraschino'], 370),
  sp('lillet-blanc', 'Lillet Blanc', '750mL', 'liquorBeerWine', 'spirit', ['lillet'], 380),
  // everythingElse (mixer, except garnish for produce/rim items)
  sp('orgeat', 'Orgeat', '750mL', 'everythingElse', 'mixer', ['orgeat', 'almond syrup'], 260),
  sp('grenadine', 'Grenadine', '750mL', 'everythingElse', 'mixer', ['grenadine'], 270),
  sp('espresso', 'Espresso', '32oz', 'everythingElse', 'mixer', ['espresso', 'cold brew'], 280),
  sp('mint', 'Mint', 'bunch', 'everythingElse', 'garnish', ['mint', 'mint leaves', 'fresh mint'], 290),
  sp('agave-syrup', 'Agave Syrup', '32oz', 'everythingElse', 'mixer', ['agave'], 300),
  sp('cream-of-coconut', 'Cream of Coconut', '15oz', 'everythingElse', 'mixer', ['cream of coconut', 'coconut cream'], 310),
  sp('heavy-cream', 'Heavy Cream', '32oz', 'everythingElse', 'mixer', ['heavy cream', 'cream'], 320),
  sp('egg-whites', 'Egg Whites', '16oz', 'everythingElse', 'mixer', ['egg white'], 330),
  sp('ginger-syrup', 'Ginger Syrup', '750mL', 'everythingElse', 'mixer', ['ginger syrup'], 340),
  sp('hibiscus-tea', 'Hibiscus Tea', '1G', 'everythingElse', 'mixer', ['hibiscus'], 350),
  sp('apple-cider', 'Apple Cider', '1G', 'everythingElse', 'mixer', ['apple cider'], 360),
  sp('peach-nectar', 'Peach Nectar', '1L', 'everythingElse', 'mixer', ['peach nectar', 'peach'], 370),
  sp('mango-nectar', 'Mango Nectar', '1L', 'everythingElse', 'mixer', ['mango nectar', 'mango'], 380),
  sp('strawberries', 'Strawberries', '1lb', 'everythingElse', 'garnish', ['strawberry', 'strawberries'], 390),
  sp('cucumber', 'Cucumber', 'ea.', 'everythingElse', 'garnish', ['cucumber'], 400),
  sp('basil', 'Basil', 'bunch', 'everythingElse', 'garnish', ['basil'], 410),
  sp('elderflower-syrup', 'Elderflower Syrup', '750mL', 'everythingElse', 'mixer', ['elderflower'], 420),
  sp('chocolate-syrup', 'Chocolate Syrup', '24oz', 'everythingElse', 'mixer', ['chocolate'], 430),
  sp('vanilla-syrup', 'Vanilla Syrup', '750mL', 'everythingElse', 'mixer', ['vanilla'], 440),
  sp('smoked-chips', 'Smoked Chips', 'bag', 'everythingElse', 'garnish', ['smoke', 'smoked'], 450),
];

// Support-par constructor. Every support row carries the same slice-invisible
// flags by construction, so no caller can forget one.
function sp(id, item, size, section, role, aliases, sortOrder) {
  return {
    id,
    item,
    size,
    qty_per_100: 1,
    section,
    role,
    spirit_key: null,
    style_key: null,
    paired_spirits: [],
    ingredient_aliases: aliases,
    in_full_bar: false,
    is_active: true,
    sort_order: sortOrder,
  };
}

// Recipe row constructor. amount per ONE serving; unit in oz|dash|each|splash.
function row(ingredient, amount, unit, note) {
  const r = { ingredient, amount, unit };
  if (note) r.note = note;
  return r;
}

// ── Drink recipes (classic specs, per serving) ──────────────────────────────
// Each entry: { table, id, name, low, rows }. `low` = low-confidence draft
// flagged for Dallas (DRB-original spec, or a par gap covered by a placeholder).
const COCKTAILS = [
  { id: 'vodka-berry-lemonade', name: 'Berry Vodka Lemonade', low: true, rows: [
    row('Vodka', 1.5, 'oz'),
    row('Lemonade', 3, 'oz', 'real lemonade'),
    row('Strawberries', 2, 'each', 'muddled, plus berries to garnish'),
    row('Grenadine', 0.25, 'oz', 'for the pink pop'),
  ] },
  { id: 'moscow-mule', name: 'Moscow Mule', rows: [
    row('Vodka', 2, 'oz'),
    row('Lime Juice', 0.5, 'oz'),
    row('Ginger Beer', 4, 'oz', 'top'),
    row('Lime Wedge', 1, 'each', 'garnish'),
  ] },
  { id: 'margarita', name: 'Margarita', rows: [
    row('Blanco Tequila', 2, 'oz'),
    row('Triple Sec', 0.75, 'oz'),
    row('Lime Juice', 1, 'oz'),
    row('Simple Syrup', 0.25, 'oz'),
    row('Lime Wedge', 1, 'each', 'garnish only'),
  ] },
  { id: 'espresso-martini', name: 'Espresso Martini', rows: [
    row('Vodka', 1.5, 'oz'),
    row('Coffee Liqueur', 0.5, 'oz'),
    row('Espresso', 1, 'oz', 'fresh, chilled'),
    row('Simple Syrup', 0.25, 'oz'),
  ] },
  { id: 'old-fashioned', name: 'Old Fashioned', rows: [
    row('Bourbon', 2, 'oz'),
    row('Simple Syrup', 0.25, 'oz'),
    row('Angostura Bitters', 2, 'dash'),
    row('Orange Peel', 1, 'each', 'expressed, garnish'),
  ] },
  { id: 'cosmopolitan', name: 'Cosmopolitan', rows: [
    row('Vodka', 1.5, 'oz'),
    row('Triple Sec', 0.5, 'oz'),
    row('Cranberry Juice', 1, 'oz'),
    row('Lime Juice', 0.5, 'oz'),
  ] },
  { id: 'aperol-spritz', name: 'Aperol Spritz', rows: [
    row('Aperol', 2, 'oz'),
    row('Prosecco', 3, 'oz'),
    row('Club Soda', 1, 'oz', 'top'),
    row('Orange Slice', 1, 'each', 'garnish'),
  ] },
  { id: 'paloma', name: 'Paloma', low: true, rows: [
    row('Blanco Tequila', 2, 'oz'),
    row('Lime Juice', 0.5, 'oz'),
    row('Sprite', 4, 'oz', 'stand-in for grapefruit soda (Squirt / Jarritos)'),
    row('Lime Wedge', 1, 'each', 'garnish'),
  ] },
  { id: 'mojito', name: 'Mojito', rows: [
    row('Rum', 2, 'oz'),
    row('Lime Juice', 0.75, 'oz'),
    row('Simple Syrup', 0.5, 'oz'),
    row('Mint', 8, 'each', 'leaves, muddled'),
    row('Club Soda', 2, 'oz', 'top'),
  ] },
  { id: 'french-75', name: 'French 75', rows: [
    row('Gin', 1, 'oz'),
    row('Lemon Juice', 0.5, 'oz'),
    row('Simple Syrup', 0.5, 'oz'),
    row('Champagne', 3, 'oz', 'top'),
  ] },
  { id: 'daiquiri', name: 'Daiquiri', rows: [
    row('Rum', 2, 'oz'),
    row('Lime Juice', 1, 'oz'),
    row('Simple Syrup', 0.75, 'oz'),
  ] },
  { id: 'sidecar', name: 'Sidecar', low: true, rows: [
    row('Bourbon', 2, 'oz', 'placeholder: Sidecar is Cognac; no brandy par row yet, swap when added'),
    row('Triple Sec', 0.75, 'oz'),
    row('Lemon Juice', 0.75, 'oz'),
  ] },
  { id: 'martini', name: 'Martini', rows: [
    row('Gin', 2.5, 'oz'),
    row('Dry Vermouth', 0.5, 'oz'),
    row('Lemon Peel', 1, 'each', 'or olives, garnish'),
  ] },
  { id: 'manhattan', name: 'Manhattan', rows: [
    row('Rye', 2, 'oz'),
    row('Sweet Vermouth', 1, 'oz'),
    row('Angostura Bitters', 2, 'dash'),
    row('Brandied Cherry', 1, 'each', 'garnish'),
  ] },
  { id: 'negroni', name: 'Negroni', rows: [
    row('Gin', 1, 'oz'),
    row('Campari', 1, 'oz'),
    row('Sweet Vermouth', 1, 'oz'),
    row('Orange Peel', 1, 'each', 'garnish'),
  ] },
  { id: 'amaretto-sour', name: 'Amaretto Sour', rows: [
    row('Amaretto', 2, 'oz'),
    row('Lemon Juice', 1, 'oz'),
    row('Simple Syrup', 0.5, 'oz'),
    row('Egg White', 1, 'each', 'optional, for foam'),
  ] },
  { id: 'smokey-pina', name: 'Smokey Pina', low: true, rows: [
    row('Mezcal', 2, 'oz'),
    row('Pineapple Juice', 1.5, 'oz'),
    row('Lime Juice', 0.5, 'oz'),
    row('Agave Syrup', 0.25, 'oz'),
  ] },
  { id: 'boulevardier', name: 'Boulevardier', rows: [
    row('Bourbon', 1.5, 'oz'),
    row('Campari', 1, 'oz'),
    row('Sweet Vermouth', 1, 'oz'),
    row('Orange Peel', 1, 'each', 'garnish'),
  ] },
  { id: 'black-manhattan', name: 'Black Manhattan', rows: [
    row('Rye', 2, 'oz'),
    row('Averna', 1, 'oz', 'amaro in place of sweet vermouth'),
    row('Angostura Bitters', 1, 'dash'),
    row('Brandied Cherry', 1, 'each', 'garnish'),
  ] },
  { id: 'sazerac', name: 'Sazerac', rows: [
    row('Rye', 2, 'oz'),
    row('Simple Syrup', 0.25, 'oz'),
    row('Peychauds', 3, 'dash'),
    row('Absinthe', 1, 'dash', 'rinse the glass, discard'),
    row('Lemon Peel', 1, 'each', 'expressed, garnish'),
  ] },
  { id: 'whiskey-sour', name: 'Whiskey Sour', rows: [
    row('Bourbon', 2, 'oz'),
    row('Lemon Juice', 0.75, 'oz'),
    row('Simple Syrup', 0.75, 'oz'),
    row('Egg White', 1, 'each', 'optional, for foam'),
  ] },
  { id: 'mai-tai', name: 'Mai Tai', rows: [
    row('Rum', 2, 'oz'),
    row('Triple Sec', 0.5, 'oz', 'orange curacao'),
    row('Orgeat', 0.5, 'oz'),
    row('Lime Juice', 0.75, 'oz'),
    row('Mint', 1, 'each', 'sprig, garnish'),
  ] },
  { id: 'paper-plane', name: 'Paper Plane', rows: [
    row('Bourbon', 0.75, 'oz'),
    row('Aperol', 0.75, 'oz'),
    row('Amaro Nonino', 0.75, 'oz'),
    row('Lemon Juice', 0.75, 'oz'),
  ] },
  { id: 'corpse-reviver', name: 'Corpse Reviver No. 2', rows: [
    row('Gin', 0.75, 'oz'),
    row('Lillet', 0.75, 'oz', 'Lillet Blanc'),
    row('Triple Sec', 0.75, 'oz', 'Cointreau'),
    row('Lemon Juice', 0.75, 'oz'),
    row('Absinthe', 1, 'dash', 'rinse'),
  ] },
  { id: 'last-word', name: 'Last Word', rows: [
    row('Gin', 0.75, 'oz'),
    row('Green Chartreuse', 0.75, 'oz'),
    row('Maraschino', 0.75, 'oz'),
    row('Lime Juice', 0.75, 'oz'),
  ] },
];

const MOCKTAILS = [
  { id: 'virgin-mojito', name: 'Virgin Mojito', rows: [
    row('Mint', 8, 'each', 'leaves, muddled'),
    row('Lime Juice', 0.75, 'oz'),
    row('Simple Syrup', 0.5, 'oz'),
    row('Club Soda', 4, 'oz', 'top'),
  ] },
  { id: 'strawberry-basil-lemonade', name: 'Strawberry Basil Lemonade', rows: [
    row('Strawberries', 3, 'each', 'muddled'),
    row('Basil', 4, 'each', 'leaves, muddled'),
    row('Lemonade', 4, 'oz'),
  ] },
  { id: 'tropical-sunrise', name: 'Tropical Sunrise', rows: [
    row('Mango Nectar', 2, 'oz'),
    row('Orange Juice', 2, 'oz'),
    row('Grenadine', 0.5, 'oz', 'sink to the bottom'),
  ] },
  { id: 'mango-tango', name: 'Mango Tango', rows: [
    row('Mango Nectar', 3, 'oz'),
    row('Lime Juice', 0.5, 'oz'),
    row('Agave Syrup', 0.25, 'oz'),
    row('Lime Wedge', 1, 'each', 'chili-lime rim, garnish'),
  ] },
  { id: 'virgin-pina-colada', name: 'Virgin Pina Colada', rows: [
    row('Cream of Coconut', 2, 'oz'),
    row('Pineapple Juice', 3, 'oz'),
    row('Lime Juice', 0.5, 'oz'),
  ] },
  { id: 'shirley-temple-deluxe', name: 'Shirley Temple Deluxe', rows: [
    row('Grenadine', 0.75, 'oz'),
    row('Ginger Ale', 6, 'oz', 'top'),
    row('Brandied Cherry', 2, 'each', 'garnish'),
  ] },
  { id: 'lavender-cream-soda', name: 'Lavender Cream Soda', low: true, rows: [
    row('Vanilla Syrup', 0.75, 'oz', 'lavender syrup preferred; no lavender par row yet'),
    row('Heavy Cream', 1, 'oz'),
    row('Club Soda', 4, 'oz', 'top, cream-soda style'),
  ] },
  { id: 'chocolate-mint-shake', name: 'Chocolate Mint Shake', rows: [
    row('Chocolate Syrup', 1, 'oz'),
    row('Mint', 6, 'each', 'leaves, or 0.25 oz mint syrup'),
    row('Heavy Cream', 2, 'oz', 'or vanilla ice cream, blended'),
  ] },
  { id: 'cucumber-spritz', name: 'Cucumber Spritz', rows: [
    row('Cucumber', 3, 'each', 'slices, muddled'),
    row('Elderflower', 0.75, 'oz', 'syrup or cordial'),
    row('Club Soda', 4, 'oz', 'sparkling water, top'),
  ] },
  { id: 'elderflower-fizz', name: 'Elderflower Fizz', rows: [
    row('Elderflower', 1, 'oz', 'cordial'),
    row('Lemon Juice', 0.5, 'oz'),
    row('Club Soda', 4, 'oz', 'soda, top'),
  ] },
  { id: 'ginger-peach-sparkler', name: 'Ginger Peach Sparkler', rows: [
    row('Peach Nectar', 2, 'oz'),
    row('Ginger Syrup', 0.5, 'oz'),
    row('Club Soda', 3, 'oz', 'top'),
  ] },
  { id: 'citrus-cooler', name: 'Citrus Cooler', rows: [
    row('Orange Juice', 1.5, 'oz'),
    row('Lemon Juice', 0.5, 'oz'),
    row('Lime Juice', 0.5, 'oz'),
    row('Club Soda', 3, 'oz', 'sparkling water, top'),
  ] },
  { id: 'virgin-espresso-tonic', name: 'Virgin Espresso Tonic', rows: [
    row('Espresso', 1, 'oz', 'chilled'),
    row('Tonic Water', 4, 'oz'),
    row('Simple Syrup', 0.25, 'oz', 'optional'),
  ] },
  { id: 'spiced-cider-mule', name: 'Spiced Apple Cider Mule', rows: [
    row('Apple Cider', 3, 'oz', 'warm spices'),
    row('Ginger Beer', 3, 'oz', 'top'),
    row('Lime Juice', 0.5, 'oz'),
  ] },
  { id: 'hibiscus-ginger-punch', name: 'Hibiscus Ginger Punch', rows: [
    row('Hibiscus Tea', 3, 'oz'),
    row('Ginger Syrup', 0.5, 'oz'),
    row('Agave Syrup', 0.25, 'oz', 'or honey'),
    row('Lemon Juice', 0.5, 'oz'),
  ] },
  { id: 'smoky-pineapple-sour', name: 'Smoky Pineapple Sour', rows: [
    row('Pineapple Juice', 3, 'oz', 'charred / grilled'),
    row('Lemon Juice', 0.75, 'oz'),
    row('Simple Syrup', 0.5, 'oz'),
    row('Smoked Salt', 1, 'each', 'smoked-salt rim'),
  ] },
];

const COCKTAIL_IDS = COCKTAILS.map((d) => d.id);
const MOCKTAIL_IDS = MOCKTAILS.map((d) => d.id);

const UPDATE_COCKTAIL_SQL =
  "UPDATE cocktails SET ingredients = $1::jsonb, recipe_review = 'draft' " +
  "WHERE id = $2 AND (ingredients IS NULL OR ingredients = '[]'::jsonb)";
const UPDATE_MOCKTAIL_SQL =
  "UPDATE mocktails SET ingredients = $1::jsonb, recipe_review = 'draft' " +
  "WHERE id = $2 AND (ingredients IS NULL OR ingredients = '[]'::jsonb)";

// ── Helpers ─────────────────────────────────────────────────────────────────

function isEmptyIngredients(ing) {
  if (ing === null || ing === undefined) return true;
  if (Array.isArray(ing)) return ing.length === 0;
  if (typeof ing === 'string') {
    const t = ing.trim();
    return t === '' || t === '[]';
  }
  return false;
}

// The eight parity-critical slices, picked by explicit static reads (no dynamic
// object keys) so the diff is lint-clean and the set is auditable.
function paritySlices(cat) {
  return {
    pars100: cat.pars100,
    spiritPars: cat.spiritPars,
    beerStyleMap: cat.beerStyleMap,
    wineStyleMap: cat.wineStyleMap,
    basicMixers: cat.basicMixers,
    garnishes: cat.garnishes,
    alwaysInclude: cat.alwaysInclude,
    spiritMixerPairings: cat.spiritMixerPairings,
  };
}

// Returns the name of the first slice that differs, or null if all match.
function firstSliceDiff(a, b) {
  const sa = paritySlices(a);
  const sb = paritySlices(b);
  const names = [
    'pars100', 'spiritPars', 'beerStyleMap', 'wineStyleMap',
    'basicMixers', 'garnishes', 'alwaysInclude', 'spiritMixerPairings',
  ];
  for (const name of names) {
    if (JSON.stringify(pickSlice(sa, name)) !== JSON.stringify(pickSlice(sb, name))) {
      return name;
    }
  }
  return null;
}

function pickSlice(slices, name) {
  switch (name) {
    case 'pars100': return slices.pars100;
    case 'spiritPars': return slices.spiritPars;
    case 'beerStyleMap': return slices.beerStyleMap;
    case 'wineStyleMap': return slices.wineStyleMap;
    case 'basicMixers': return slices.basicMixers;
    case 'garnishes': return slices.garnishes;
    case 'alwaysInclude': return slices.alwaysInclude;
    case 'spiritMixerPairings': return slices.spiritMixerPairings;
    default: return null;
  }
}

async function loadParItems() {
  const res = await pool.query('SELECT * FROM par_items');
  return res.rows;
}

// Split live rows into base (no support) and with-support sets, then assert the
// eight slices are byte-identical. Returns the diffing slice name or null.
function parityDiff(liveRows) {
  const supportIds = new Set(SUPPORT_PARS.map((r) => r.id));
  const baseRows = liveRows.filter((r) => !supportIds.has(r.id));
  const withRows = baseRows.concat(SUPPORT_PARS);
  return firstSliceDiff(buildCatalogSlices(baseRows), buildCatalogSlices(withRows));
}

function resolutionCatalog(liveRows) {
  const supportIds = new Set(SUPPORT_PARS.map((r) => r.id));
  const baseRows = liveRows.filter((r) => !supportIds.has(r.id));
  return buildCatalogSlices(baseRows.concat(SUPPORT_PARS));
}

async function insertSupportPars() {
  const cols = [
    'id', 'item', 'size', 'qty_per_100', 'section', 'role', 'spirit_key',
    'style_key', 'paired_spirits', 'ingredient_aliases', 'in_full_bar',
    'is_active', 'sort_order',
  ];
  const tuples = [];
  const values = [];
  SUPPORT_PARS.forEach((r, i) => {
    const base = i * cols.length;
    tuples.push(`(${cols.map((_c, j) => `$${base + j + 1}`).join(', ')})`);
    values.push(
      r.id, r.item, r.size, r.qty_per_100, r.section, r.role, r.spirit_key,
      r.style_key, r.paired_spirits, r.ingredient_aliases, r.in_full_bar,
      r.is_active, r.sort_order
    );
  });
  const sql =
    `INSERT INTO par_items (${cols.join(', ')}) VALUES ${tuples.join(', ')} ` +
    'ON CONFLICT (id) DO NOTHING';
  const res = await pool.query(sql, values);
  return res.rowCount;
}

// Build the per-drink plan: existing-recipe check + resolution of every row.
function buildPlan(existingByKey, catalog) {
  const plan = [];
  const unresolved = [];
  const drinks = COCKTAILS.map((d) => ({ ...d, table: 'cocktails' }))
    .concat(MOCKTAILS.map((d) => ({ ...d, table: 'mocktails' })));

  for (const drink of drinks) {
    const existing = existingByKey.get(`${drink.table}:${drink.id}`);
    const present = existing !== undefined;
    const skip = present ? !isEmptyIngredients(existing) : false;
    const resolved = drink.rows.map((rr) => {
      const res = resolveRecipeRow(rr, catalog);
      if (!res && !skip) unresolved.push({ drink: drink.name, ingredient: rr.ingredient });
      return { rr, res };
    });
    plan.push({ ...drink, present, skip, resolved });
  }
  return { plan, unresolved };
}

function printPlan(plan) {
  console.log('\n── Per-drink resolution plan ──────────────────────────────');
  for (const d of plan) {
    if (!d.present) {
      console.warn(`  [${d.table}] ${d.id} (${d.name}): NOT FOUND in DB, skipping`);
      continue;
    }
    if (d.skip) {
      console.log(`  [${d.table}] ${d.name}: SKIP (already has a recipe)`);
      continue;
    }
    const flag = d.low ? '  [LOW CONFIDENCE]' : '';
    console.log(`  [${d.table}] ${d.name}${flag}`);
    for (const { rr, res } of d.resolved) {
      const note = rr.note ? `  (${rr.note})` : '';
      const dest = res ? `-> ${res.item} · ${res.size}` : '-> UNRESOLVED';
      console.log(`      ${rr.amount} ${rr.unit} ${rr.ingredient}  ${dest}${note}`);
    }
  }
}

async function main() {
  const dryRun = process.argv.slice(2).includes('--dry-run');
  console.log(`[seed-recipe-drafts] start${dryRun ? '  (DRY RUN, no writes)' : ''}`);

  // ── Gate B (part 1): parity pre-check against the live table, pre-write. ──
  let liveRows = await loadParItems();
  const preDiff = parityDiff(liveRows);
  if (preDiff) {
    console.error(`[parity] PRE-CHECK FAILED: slice "${preDiff}" changes when support rows are added. Support rows are NOT slice-invisible; aborting before any write.`);
    process.exitCode = 1;
    return;
  }
  console.log('[parity] pre-check OK: all 8 legacy slices are byte-identical with and without the support rows.');

  const catalog = resolutionCatalog(liveRows);

  // ── Step A: insert support par rows. ──
  let supportInserted = 0;
  if (dryRun) {
    console.log(`[dry-run] would upsert ${SUPPORT_PARS.length} support par rows (ON CONFLICT (id) DO NOTHING).`);
  } else {
    supportInserted = await insertSupportPars();
    console.log(`[pars] support rows inserted: ${supportInserted} (of ${SUPPORT_PARS.length}; the rest already existed).`);
  }

  // ── Steps C + D: load existing recipes, build plan, hard-resolve every row. ──
  const cocktailRes = await pool.query(
    'SELECT id, ingredients FROM cocktails WHERE id = ANY($1::text[])', [COCKTAIL_IDS]
  );
  const mocktailRes = await pool.query(
    'SELECT id, ingredients FROM mocktails WHERE id = ANY($1::text[])', [MOCKTAIL_IDS]
  );
  const existingByKey = new Map();
  for (const r of cocktailRes.rows) existingByKey.set(`cocktails:${r.id}`, r.ingredients);
  for (const r of mocktailRes.rows) existingByKey.set(`mocktails:${r.id}`, r.ingredients);

  const { plan, unresolved } = buildPlan(existingByKey, catalog);

  if (unresolved.length > 0) {
    console.error('[resolve] HARD CHECK FAILED: the following recipe rows do not resolve to any catalog item. Add an alias to the matching support row and re-run. No recipes were written.');
    for (const u of unresolved) console.error(`    ${u.drink}: "${u.ingredient}"`);
    process.exitCode = 1;
    return;
  }
  console.log(`[resolve] hard check OK: every recipe row of every to-write drink resolves.`);

  printPlan(plan);

  const toWrite = plan.filter((d) => d.present && !d.skip);
  const skippedCount = plan.filter((d) => d.present && d.skip).length;
  const lowConf = plan.filter((d) => d.low).map((d) => `${d.name}${d.skip ? ' (skipped)' : ''}`);

  if (dryRun) {
    console.log(`\n[dry-run] would write ${toWrite.length} recipe(s); would skip ${skippedCount} (already have recipes).`);
    if (lowConf.length > 0) console.log(`[dry-run] low-confidence drafts flagged for Dallas: ${lowConf.join(', ')}.`);
    console.log('[seed-recipe-drafts] dry run done. No writes.');
    return;
  }

  // ── Step (live write): update recipes in one transaction. ──
  let written = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const d of toWrite) {
      const sql = d.table === 'cocktails' ? UPDATE_COCKTAIL_SQL : UPDATE_MOCKTAIL_SQL;
      const res = await client.query(sql, [JSON.stringify(d.rows), d.id]);
      written += res.rowCount;
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (rb) { console.error('ROLLBACK failed:', rb); }
    throw e;
  } finally {
    client.release();
  }

  console.log(`\n[write] recipes written: ${written}; skipped (already had recipes): ${skippedCount}.`);

  // ── Gate B (part 2): re-verify parity against the live table, post-write. ──
  liveRows = await loadParItems();
  const postDiff = parityDiff(liveRows);
  if (postDiff) {
    console.error(`[parity] POST-WRITE CHECK FAILED: slice "${postDiff}" differs. Investigate immediately.`);
    process.exitCode = 1;
    return;
  }
  console.log('[parity] post-write check OK: all 8 legacy slices remain byte-identical.');

  console.log('\n── Summary ────────────────────────────────────────────────');
  console.log(`  support par rows inserted this run: ${supportInserted}`);
  console.log(`  recipes written this run:           ${written}`);
  console.log(`  drinks skipped (already had one):   ${skippedCount}`);
  if (lowConf.length > 0) console.log(`  low-confidence drafts for Dallas:   ${lowConf.join(', ')}`);
  console.log('[seed-recipe-drafts] done.');
}

main()
  .catch((err) => { console.error('seedRecipeDrafts failed:', err); process.exitCode = 1; })
  .finally(async () => { await pool.end(); });
