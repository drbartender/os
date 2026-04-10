// shoppingListPars.js — 100-guest baseline quantities for a full bar

// Beer style → product mapping (BeerWineStep selections → shopping list items)
// Quantities are 100-guest baselines, scaled by generateShoppingList
export const BEER_STYLE_MAP = {
  'Light / Easy Drinking': [
    { item: 'Michelob Ultra', size: '24pk', qty: 2 },
  ],
  'Craft / Local': [
    { item: 'Local Craft Beer', size: '24pk', qty: 2 },
  ],
  'IPA': [
    { item: 'IPA (Lagunitas / Voodoo Ranger)', size: '12pk', qty: 2 },
  ],
  'Seltzer': [
    { item: 'White Claw Variety', size: '12pk', qty: 2 },
  ],
  'Non-Alcoholic': [
    { item: 'Athletic Brewing NA', size: '12pk', qty: 1 },
  ],
};

// Wine style → product mapping
export const WINE_STYLE_MAP = {
  'Red': [
    { item: 'Cabernet Sauvignon', size: '750mL', qty: 6 },
    { item: 'Pinot Noir', size: '750mL', qty: 6 },
  ],
  'White': [
    { item: 'Moscato', size: '750mL', qty: 6 },
    { item: 'Sauvignon Blanc', size: '750mL', qty: 6 },
  ],
  'Sparkling': [
    { item: 'Champagne', size: '750mL', qty: 12 },
  ],
};

// Basic mixers (sodas, juices, syrups) — included when mixers are requested
export const BASIC_MIXERS = [
  { item: 'Coca Cola',           size: '12 pack', qty: 2 },
  { item: 'Diet Coke',           size: '12 pack', qty: 1 },
  { item: 'Ginger Ale',          size: '12 pack', qty: 1 },
  { item: 'Ginger Beer',         size: '4 pack',  qty: 3 },
  { item: 'Sprite',              size: '12 pack', qty: 1 },
  { item: 'Club Soda',           size: '1L',      qty: 6 },
  { item: 'Tonic Water',         size: '1L',      qty: 2 },
  { item: 'Lemonade (REAL)',     size: '1G',      qty: 1 },
  { item: 'Cranberry Juice',     size: '64oz',    qty: 2 },
  { item: 'Pineapple Juice',     size: '64oz',    qty: 2 },
  { item: 'Orange Juice',        size: '1G',      qty: 1 },
  { item: 'Sour Mix',            size: '64oz',    qty: 1 },
  { item: 'Lemon Juice',         size: '31oz',    qty: 1 },
  { item: 'Lime Juice (UNSWEET)',size: '15oz',    qty: 1 },
  { item: 'Simple Syrup',        size: '1L',      qty: 2 },
];

// Garnishes — included with mixers
export const GARNISHES = [
  { item: 'Angostura Bitters',   size: '4oz',     qty: 1 },
  { item: 'Premium Cherries',    size: 'ea.',     qty: 1 },
  { item: 'Lemons',              size: 'ea.',     qty: 4 },
  { item: 'Limes',               size: 'ea.',     qty: 12 },
  { item: 'Oranges',             size: 'ea.',     qty: 2 },
];

// Supplies every event gets regardless of service style
export const ALWAYS_INCLUDE = [
  { item: 'Water',               size: '24pk',    qty: 4 },
  { item: 'Cups (9oz)',          size: '500',     qty: 1 },
  { item: 'Straws',              size: 'box',     qty: 1 },
  { item: 'Napkins',             size: '100',     qty: 1 },
  { item: 'Ice',                 size: 'lbs',     qty: 150 },
];

export const PARS_100 = {
  liquorBeerWine: [
    { item: "Tito's Vodka",        size: "1.75L",   qty: 5 },
    { item: "Tanqueray Gin",       size: "1.75L",   qty: 1 },
    { item: "Bacardi Rum",         size: "1.75L",   qty: 2 },
    { item: "Malibu Coconut Rum",  size: "1.75L",   qty: 2 },
    { item: "Bulleit Bourbon",     size: "1.75L",   qty: 4 },
    { item: "1800 Blanco Tequila", size: "1.75L",   qty: 4 },
    { item: "Cabernet Sauvignon",  size: "750mL",   qty: 6 },
    { item: "Pinot Noir",          size: "750mL",   qty: 6 },
    { item: "Moscato",             size: "750mL",   qty: 6 },
    { item: "Sauvignon Blanc",     size: "750mL",   qty: 6 },
    { item: "Champagne",           size: "750mL",   qty: 12 },
    { item: "Michelob Ultra",      size: "24pk",    qty: 2 },
    { item: "Corona / Light",      size: "24pk",    qty: 3 },
    { item: "Yuengling",           size: "24pk",    qty: 2 },
  ],
  everythingElse: [
    { item: "Coca Cola",           size: "12 pack", qty: 2 },
    { item: "Diet Coke",           size: "12 pack", qty: 1 },
    { item: "Ginger Ale",          size: "12 pack", qty: 1 },
    { item: "Ginger Beer",         size: "4 pack",  qty: 3 },
    { item: "Sprite",              size: "12 pack", qty: 1 },
    { item: "Club Soda",           size: "1L",      qty: 6 },
    { item: "Tonic Water",         size: "1L",      qty: 2 },
    { item: "Lemonade (REAL)",     size: "1G",      qty: 1 },
    { item: "Cranberry Juice",     size: "64oz",    qty: 2 },
    { item: "Pineapple Juice",     size: "64oz",    qty: 2 },
    { item: "Orange Juice",        size: "1G",      qty: 1 },
    { item: "Sour Mix",            size: "64oz",    qty: 1 },
    { item: "Lemon Juice",         size: "31oz",    qty: 1 },
    { item: "Lime Juice (UNSWEET)",size: "15oz",    qty: 1 },
    { item: "Simple Syrup",        size: "1L",      qty: 2 },
    { item: "Angostura Bitters",   size: "4oz",     qty: 1 },
    { item: "Premium Cherries",    size: "ea.",     qty: 1 },
    { item: "Lemons",              size: "ea.",     qty: 4 },
    { item: "Limes",               size: "ea.",     qty: 12 },
    { item: "Oranges",             size: "ea.",     qty: 2 },
    { item: "Water",               size: "24pk",    qty: 4 },
    { item: "Cups (9oz)",          size: "500",     qty: 1 },
    { item: "Straws",              size: "box",     qty: 1 },
    { item: "Napkins",             size: "100",     qty: 1 },
    { item: "Ice",                 size: "lbs",     qty: 150 },
  ],
};
