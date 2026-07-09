// Parity gate for the Potions par catalog (spec goal 6: day-one generated
// output byte-identical, sole carve-out = consult matching-mixer ORDER).
//
// PURE — no DB at runtime. SEED_ROWS below were dumped from a dev DB freshly
// seeded by schema.sql (so the fixture is byte-faithful to what the seed
// produces, including pg's NUMERIC-as-string). SNAPSHOTS were captured from
// the legacy generator BEFORE any catalog wiring (lane potions-a, 2026-07-09);
// lane potions-b's generator test re-runs the same FIXTURE_INPUTS through the
// catalog-driven generator against these same snapshots.
//
// Run: node -r dotenv/config --test server/utils/potionCatalog.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildCatalogSlices, resolveIngredient, resolveRecipeRow, normalizeName } = require('./potionCatalog');
const {
  generateShoppingList, buildGeneratorInputFromConsult,
  PARS_100, SPIRIT_PARS, INGREDIENT_MAP, BEER_STYLE_MAP, WINE_STYLE_MAP,
  BASIC_MIXERS, GARNISHES, ALWAYS_INCLUDE, SPIRIT_MIXER_PAIRINGS,
} = require('./shoppingList');

const SEED_ROWS = [
 {
  "id": "coca-cola",
  "item": "Coca Cola",
  "size": "12 pack",
  "qty_per_100": "2",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "rum",
   "bourbon",
   "whiskey"
  ],
  "ingredient_aliases": [
   "coca cola",
   "coke"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 10
 },
 {
  "id": "diet-coke",
  "item": "Diet Coke",
  "size": "12 pack",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "diet coke"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 20
 },
 {
  "id": "sprite",
  "item": "Sprite",
  "size": "12 pack",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "sprite"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 30
 },
 {
  "id": "club-soda",
  "item": "Club Soda",
  "size": "8 pack",
  "qty_per_100": "6",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "vodka",
   "gin",
   "tequila",
   "bourbon",
   "whiskey",
   "scotch"
  ],
  "ingredient_aliases": [
   "club soda",
   "soda water"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 40
 },
 {
  "id": "tonic-water",
  "item": "Tonic Water",
  "size": "1L",
  "qty_per_100": "2",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "vodka",
   "gin"
  ],
  "ingredient_aliases": [
   "tonic water",
   "tonic"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 50
 },
 {
  "id": "cranberry-juice",
  "item": "Cranberry Juice",
  "size": "64oz",
  "qty_per_100": "2",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "vodka"
  ],
  "ingredient_aliases": [
   "cranberry"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 60
 },
 {
  "id": "pineapple-juice",
  "item": "Pineapple Juice",
  "size": "64oz",
  "qty_per_100": "2",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "rum"
  ],
  "ingredient_aliases": [
   "pineapple juice"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 70
 },
 {
  "id": "orange-juice",
  "item": "Orange Juice",
  "size": "64oz",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "vodka",
   "rum"
  ],
  "ingredient_aliases": [
   "orange juice"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 80
 },
 {
  "id": "lemon-juice",
  "item": "Lemon Juice",
  "size": "31oz",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "gin"
  ],
  "ingredient_aliases": [
   "lemon juice"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 90
 },
 {
  "id": "lime-juice-unsweet",
  "item": "Lime Juice (UNSWEET)",
  "size": "15oz",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "vodka",
   "rum",
   "tequila",
   "mezcal"
  ],
  "ingredient_aliases": [
   "lime juice"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 100
 },
 {
  "id": "simple-syrup",
  "item": "Simple Syrup",
  "size": "1L",
  "qty_per_100": "2",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "gin",
   "tequila",
   "mezcal"
  ],
  "ingredient_aliases": [
   "simple syrup"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 110
 },
 {
  "id": "angostura-bitters",
  "item": "Angostura Bitters",
  "size": "4oz",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "bourbon",
   "whiskey"
  ],
  "ingredient_aliases": [
   "angostura",
   "bitters"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 120
 },
 {
  "id": "premium-cherries",
  "item": "Premium Cherries",
  "size": "ea.",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "garnish",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "bourbon",
   "whiskey"
  ],
  "ingredient_aliases": [
   "brandied cherry",
   "cherry"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 130
 },
 {
  "id": "lemons",
  "item": "Lemons",
  "size": "ea.",
  "qty_per_100": "4",
  "section": "everythingElse",
  "role": "garnish",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "gin"
  ],
  "ingredient_aliases": [
   "lemon twist",
   "lemon wheel",
   "lemon wedge",
   "lemon peel"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 140
 },
 {
  "id": "limes",
  "item": "Limes",
  "size": "ea.",
  "qty_per_100": "12",
  "section": "everythingElse",
  "role": "garnish",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [
   "vodka",
   "rum",
   "tequila",
   "mezcal"
  ],
  "ingredient_aliases": [
   "lime wedge",
   "lime wheel"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 150
 },
 {
  "id": "oranges",
  "item": "Oranges",
  "size": "ea.",
  "qty_per_100": "2",
  "section": "everythingElse",
  "role": "garnish",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "orange peel",
   "orange slice",
   "orange wheel",
   "orange twist"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 160
 },
 {
  "id": "water",
  "item": "Water",
  "size": "24pk",
  "qty_per_100": "4",
  "section": "everythingElse",
  "role": "supplies",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 170
 },
 {
  "id": "cups-9oz",
  "item": "Cups (9oz)",
  "size": "500",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "supplies",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 180
 },
 {
  "id": "straws",
  "item": "Straws",
  "size": "box",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "supplies",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 190
 },
 {
  "id": "napkins",
  "item": "Napkins",
  "size": "100",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "supplies",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 200
 },
 {
  "id": "ice",
  "item": "Ice",
  "size": "lbs",
  "qty_per_100": "150",
  "section": "everythingElse",
  "role": "supplies",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 210
 },
 {
  "id": "ginger-beer",
  "item": "Ginger Beer",
  "size": "4 pack",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "ginger beer"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 220
 },
 {
  "id": "ginger-ale",
  "item": "Ginger Ale",
  "size": "12 pack",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "ginger ale"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 230
 },
 {
  "id": "lemonade-real",
  "item": "Lemonade (REAL)",
  "size": "1G",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "lemonade"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 240
 },
 {
  "id": "sour-mix",
  "item": "Sour Mix",
  "size": "64oz",
  "qty_per_100": "1",
  "section": "everythingElse",
  "role": "mixer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "sour",
   "sour mix"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 250
 },
 {
  "id": "titos-vodka",
  "item": "Tito's Vodka",
  "size": "1.75L",
  "qty_per_100": "5",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": "vodka",
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "vodka"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 10
 },
 {
  "id": "tanqueray-gin",
  "item": "Tanqueray Gin",
  "size": "1.75L",
  "qty_per_100": "1",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": "gin",
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "gin"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 20
 },
 {
  "id": "bacardi-rum",
  "item": "Bacardi Rum",
  "size": "1.75L",
  "qty_per_100": "2",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": "rum",
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "rum",
   "white rum"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 30
 },
 {
  "id": "bulleit-bourbon",
  "item": "Bulleit Bourbon",
  "size": "1.75L",
  "qty_per_100": "4",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": "bourbon",
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "bourbon",
   "whiskey"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 40
 },
 {
  "id": "1800-blanco-tequila",
  "item": "1800 Blanco Tequila",
  "size": "1.75L",
  "qty_per_100": "4",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": "tequila",
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "tequila",
   "blanco tequila"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 50
 },
 {
  "id": "cabernet-sauvignon",
  "item": "Cabernet Sauvignon",
  "size": "750mL",
  "qty_per_100": "6",
  "section": "liquorBeerWine",
  "role": "wine",
  "spirit_key": null,
  "style_key": "Red",
  "paired_spirits": [],
  "ingredient_aliases": [
   "cabernet sauvignon"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 60
 },
 {
  "id": "pinot-noir",
  "item": "Pinot Noir",
  "size": "750mL",
  "qty_per_100": "6",
  "section": "liquorBeerWine",
  "role": "wine",
  "spirit_key": null,
  "style_key": "Red",
  "paired_spirits": [],
  "ingredient_aliases": [
   "pinot noir"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 70
 },
 {
  "id": "moscato",
  "item": "Moscato",
  "size": "750mL",
  "qty_per_100": "6",
  "section": "liquorBeerWine",
  "role": "wine",
  "spirit_key": null,
  "style_key": "White",
  "paired_spirits": [],
  "ingredient_aliases": [
   "moscato"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 80
 },
 {
  "id": "sauvignon-blanc",
  "item": "Sauvignon Blanc",
  "size": "750mL",
  "qty_per_100": "6",
  "section": "liquorBeerWine",
  "role": "wine",
  "spirit_key": null,
  "style_key": "White",
  "paired_spirits": [],
  "ingredient_aliases": [
   "sauvignon blanc"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 90
 },
 {
  "id": "champagne",
  "item": "Champagne",
  "size": "750mL",
  "qty_per_100": "12",
  "section": "liquorBeerWine",
  "role": "wine",
  "spirit_key": null,
  "style_key": "Sparkling",
  "paired_spirits": [],
  "ingredient_aliases": [
   "champagne",
   "prosecco"
  ],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 100
 },
 {
  "id": "michelob-ultra",
  "item": "Michelob Ultra",
  "size": "24pk",
  "qty_per_100": "2",
  "section": "liquorBeerWine",
  "role": "beer",
  "spirit_key": null,
  "style_key": "Light / Easy Drinking",
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 110
 },
 {
  "id": "corona-light",
  "item": "Corona / Light",
  "size": "24pk",
  "qty_per_100": "3",
  "section": "liquorBeerWine",
  "role": "beer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 120
 },
 {
  "id": "yuengling",
  "item": "Yuengling",
  "size": "24pk",
  "qty_per_100": "2",
  "section": "liquorBeerWine",
  "role": "beer",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": true,
  "is_active": true,
  "sort_order": 130
 },
 {
  "id": "local-craft-beer",
  "item": "Local Craft Beer",
  "size": "24pk",
  "qty_per_100": "2",
  "section": "liquorBeerWine",
  "role": "beer",
  "spirit_key": null,
  "style_key": "Craft / Local",
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 140
 },
 {
  "id": "ipa-lagunitas-voodoo",
  "item": "IPA (Lagunitas / Voodoo Ranger)",
  "size": "12pk",
  "qty_per_100": "2",
  "section": "liquorBeerWine",
  "role": "beer",
  "spirit_key": null,
  "style_key": "IPA",
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 150
 },
 {
  "id": "white-claw-variety",
  "item": "White Claw Variety",
  "size": "12pk",
  "qty_per_100": "2",
  "section": "liquorBeerWine",
  "role": "beer",
  "spirit_key": null,
  "style_key": "Seltzer",
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 160
 },
 {
  "id": "athletic-na",
  "item": "Athletic Brewing NA",
  "size": "12pk",
  "qty_per_100": "1",
  "section": "liquorBeerWine",
  "role": "beer",
  "spirit_key": null,
  "style_key": "Non-Alcoholic",
  "paired_spirits": [],
  "ingredient_aliases": [],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 170
 },
 {
  "id": "scotch-whiskey",
  "item": "Scotch Whiskey",
  "size": "1.75L",
  "qty_per_100": "1",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": "scotch",
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "scotch"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 180
 },
 {
  "id": "mezcal",
  "item": "Mezcal",
  "size": "750mL",
  "qty_per_100": "1",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": "mezcal",
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "mezcal"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 190
 },
 {
  "id": "raspberry-vodka",
  "item": "Raspberry Vodka",
  "size": "750mL",
  "qty_per_100": "1",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "raspberry vodka"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 200
 },
 {
  "id": "malibu-coconut-rum",
  "item": "Malibu Coconut Rum",
  "size": "750mL",
  "qty_per_100": "1",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "coconut rum",
   "malibu"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 210
 },
 {
  "id": "island-blue-pucker",
  "item": "Island Blue Pucker",
  "size": "750mL",
  "qty_per_100": "1",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "island blue pucker"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 220
 },
 {
  "id": "blue-curacao",
  "item": "Blue Curacao",
  "size": "750mL",
  "qty_per_100": "1",
  "section": "liquorBeerWine",
  "role": "spirit",
  "spirit_key": null,
  "style_key": null,
  "paired_spirits": [],
  "ingredient_aliases": [
   "blue curacao"
  ],
  "in_full_bar": false,
  "is_active": true,
  "sort_order": 230
 }
];
const SNAPSHOTS = {
 "full_bar_100": {
  "clientName": "Fixture Client",
  "guestCount": 100,
  "eventDate": "2026-08-01",
  "notes": "",
  "signatureCocktailNames": [
   "Blue Lab Coat",
   "Moscow Mule"
  ],
  "liquorBeerWine": [
   {
    "item": "Tito's Vodka",
    "size": "1.75L",
    "qty": 5
   },
   {
    "item": "Tanqueray Gin",
    "size": "1.75L",
    "qty": 1
   },
   {
    "item": "Bacardi Rum",
    "size": "1.75L",
    "qty": 2
   },
   {
    "item": "Bulleit Bourbon",
    "size": "1.75L",
    "qty": 4
   },
   {
    "item": "1800 Blanco Tequila",
    "size": "1.75L",
    "qty": 4
   },
   {
    "item": "Cabernet Sauvignon",
    "size": "750mL",
    "qty": 6
   },
   {
    "item": "Pinot Noir",
    "size": "750mL",
    "qty": 6
   },
   {
    "item": "Moscato",
    "size": "750mL",
    "qty": 6
   },
   {
    "item": "Sauvignon Blanc",
    "size": "750mL",
    "qty": 6
   },
   {
    "item": "Champagne",
    "size": "750mL",
    "qty": 12
   },
   {
    "item": "Michelob Ultra",
    "size": "24pk",
    "qty": 2
   },
   {
    "item": "Corona / Light",
    "size": "24pk",
    "qty": 3
   },
   {
    "item": "Yuengling",
    "size": "24pk",
    "qty": 2
   },
   {
    "item": "Malibu Coconut Rum",
    "size": "750mL",
    "qty": 4
   },
   {
    "item": "Blue Curacao",
    "size": "750mL",
    "qty": 4
   }
  ],
  "everythingElse": [
   {
    "item": "Coca Cola",
    "size": "12 pack",
    "qty": 2
   },
   {
    "item": "Diet Coke",
    "size": "12 pack",
    "qty": 1
   },
   {
    "item": "Sprite",
    "size": "12 pack",
    "qty": 1
   },
   {
    "item": "Club Soda",
    "size": "8 pack",
    "qty": 6
   },
   {
    "item": "Tonic Water",
    "size": "1L",
    "qty": 2
   },
   {
    "item": "Cranberry Juice",
    "size": "64oz",
    "qty": 2
   },
   {
    "item": "Pineapple Juice",
    "size": "64oz",
    "qty": 2
   },
   {
    "item": "Orange Juice",
    "size": "64oz",
    "qty": 1
   },
   {
    "item": "Lemon Juice",
    "size": "31oz",
    "qty": 1
   },
   {
    "item": "Lime Juice (UNSWEET)",
    "size": "15oz",
    "qty": 1
   },
   {
    "item": "Simple Syrup",
    "size": "1L",
    "qty": 2
   },
   {
    "item": "Angostura Bitters",
    "size": "4oz",
    "qty": 1
   },
   {
    "item": "Premium Cherries",
    "size": "ea.",
    "qty": 1
   },
   {
    "item": "Lemons",
    "size": "ea.",
    "qty": 4
   },
   {
    "item": "Limes",
    "size": "ea.",
    "qty": 12
   },
   {
    "item": "Oranges",
    "size": "ea.",
    "qty": 2
   },
   {
    "item": "Water",
    "size": "24pk",
    "qty": 4
   },
   {
    "item": "Cups (9oz)",
    "size": "500",
    "qty": 1
   },
   {
    "item": "Straws",
    "size": "box",
    "qty": 1
   },
   {
    "item": "Napkins",
    "size": "100",
    "qty": 1
   },
   {
    "item": "Ice",
    "size": "lbs",
    "qty": 150
   },
   {
    "item": "Ginger Beer",
    "size": "4 pack",
    "qty": 4
   }
  ],
  "serviceStyle": "full_bar",
  "beerSelections": [],
  "wineSelections": [],
  "mixersForSignatureDrinks": null,
  "_signatureCocktails": [
   {
    "name": "Blue Lab Coat",
    "ingredients": [
     "coconut rum",
     "blue curacao",
     "pineapple juice"
    ]
   },
   {
    "name": "Moscow Mule",
    "ingredients": [
     "vodka",
     "ginger beer"
    ]
   }
  ],
  "_syrupSelfProvided": []
 },
 "full_bar_175": {
  "clientName": "Fixture Client",
  "guestCount": 175,
  "eventDate": "2026-08-01",
  "notes": "",
  "signatureCocktailNames": [
   "Blue Lab Coat",
   "Moscow Mule",
   "Raspberry Reaction",
   "Screwdriver"
  ],
  "liquorBeerWine": [
   {
    "item": "Tito's Vodka",
    "size": "1.75L",
    "qty": 10
   },
   {
    "item": "Tanqueray Gin",
    "size": "1.75L",
    "qty": 2
   },
   {
    "item": "Bacardi Rum",
    "size": "1.75L",
    "qty": 4
   },
   {
    "item": "Bulleit Bourbon",
    "size": "1.75L",
    "qty": 7
   },
   {
    "item": "1800 Blanco Tequila",
    "size": "1.75L",
    "qty": 7
   },
   {
    "item": "Cabernet Sauvignon",
    "size": "750mL",
    "qty": 11
   },
   {
    "item": "Pinot Noir",
    "size": "750mL",
    "qty": 11
   },
   {
    "item": "Moscato",
    "size": "750mL",
    "qty": 11
   },
   {
    "item": "Sauvignon Blanc",
    "size": "750mL",
    "qty": 11
   },
   {
    "item": "Champagne",
    "size": "750mL",
    "qty": 21
   },
   {
    "item": "Michelob Ultra",
    "size": "24pk",
    "qty": 4
   },
   {
    "item": "Corona / Light",
    "size": "24pk",
    "qty": 6
   },
   {
    "item": "Yuengling",
    "size": "24pk",
    "qty": 4
   },
   {
    "item": "Malibu Coconut Rum",
    "size": "750mL",
    "qty": 7
   },
   {
    "item": "Blue Curacao",
    "size": "750mL",
    "qty": 7
   },
   {
    "item": "Raspberry Vodka",
    "size": "750mL",
    "qty": 7
   }
  ],
  "everythingElse": [
   {
    "item": "Coca Cola",
    "size": "12 pack",
    "qty": 4
   },
   {
    "item": "Diet Coke",
    "size": "12 pack",
    "qty": 2
   },
   {
    "item": "Sprite",
    "size": "12 pack",
    "qty": 2
   },
   {
    "item": "Club Soda",
    "size": "8 pack",
    "qty": 11
   },
   {
    "item": "Tonic Water",
    "size": "1L",
    "qty": 4
   },
   {
    "item": "Cranberry Juice",
    "size": "64oz",
    "qty": 4
   },
   {
    "item": "Pineapple Juice",
    "size": "64oz",
    "qty": 4
   },
   {
    "item": "Orange Juice",
    "size": "64oz",
    "qty": 2
   },
   {
    "item": "Lemon Juice",
    "size": "31oz",
    "qty": 2
   },
   {
    "item": "Lime Juice (UNSWEET)",
    "size": "15oz",
    "qty": 2
   },
   {
    "item": "Simple Syrup",
    "size": "1L",
    "qty": 4
   },
   {
    "item": "Angostura Bitters",
    "size": "4oz",
    "qty": 2
   },
   {
    "item": "Premium Cherries",
    "size": "ea.",
    "qty": 2
   },
   {
    "item": "Lemons",
    "size": "ea.",
    "qty": 7
   },
   {
    "item": "Limes",
    "size": "ea.",
    "qty": 21
   },
   {
    "item": "Oranges",
    "size": "ea.",
    "qty": 4
   },
   {
    "item": "Water",
    "size": "24pk",
    "qty": 7
   },
   {
    "item": "Cups (9oz)",
    "size": "500",
    "qty": 2
   },
   {
    "item": "Straws",
    "size": "box",
    "qty": 2
   },
   {
    "item": "Napkins",
    "size": "100",
    "qty": 2
   },
   {
    "item": "Ice",
    "size": "lbs",
    "qty": 263
   },
   {
    "item": "Ginger Beer",
    "size": "4 pack",
    "qty": 7
   },
   {
    "item": "Lemonade (REAL)",
    "size": "1G",
    "qty": 7
   }
  ],
  "serviceStyle": "full_bar",
  "beerSelections": [],
  "wineSelections": [],
  "mixersForSignatureDrinks": null,
  "_signatureCocktails": [
   {
    "name": "Blue Lab Coat",
    "ingredients": [
     "coconut rum",
     "blue curacao",
     "pineapple juice"
    ]
   },
   {
    "name": "Moscow Mule",
    "ingredients": [
     "vodka",
     "ginger beer"
    ]
   },
   {
    "name": "Raspberry Reaction",
    "ingredients": [
     "raspberry vodka",
     "sprite",
     "lemonade"
    ]
   },
   {
    "name": "Screwdriver",
    "ingredients": [
     "vodka",
     "orange juice"
    ]
   }
  ],
  "_syrupSelfProvided": []
 },
 "full_bar_40_bottles": {
  "clientName": "Fixture Client",
  "guestCount": 40,
  "eventDate": "2026-08-01",
  "notes": "",
  "signatureCocktailNames": [
   "Moscow Mule"
  ],
  "liquorBeerWine": [
   {
    "item": "Tito's Vodka",
    "size": "750mL",
    "qty": 2
   },
   {
    "item": "Tanqueray Gin",
    "size": "750mL",
    "qty": 1
   },
   {
    "item": "Bacardi Rum",
    "size": "750mL",
    "qty": 1
   },
   {
    "item": "Bulleit Bourbon",
    "size": "750mL",
    "qty": 2
   },
   {
    "item": "1800 Blanco Tequila",
    "size": "750mL",
    "qty": 2
   },
   {
    "item": "Cabernet Sauvignon",
    "size": "750mL",
    "qty": 3
   },
   {
    "item": "Pinot Noir",
    "size": "750mL",
    "qty": 3
   },
   {
    "item": "Moscato",
    "size": "750mL",
    "qty": 3
   },
   {
    "item": "Sauvignon Blanc",
    "size": "750mL",
    "qty": 3
   },
   {
    "item": "Champagne",
    "size": "750mL",
    "qty": 5
   },
   {
    "item": "Michelob Ultra",
    "size": "24pk",
    "qty": 1
   },
   {
    "item": "Corona / Light",
    "size": "24pk",
    "qty": 2
   },
   {
    "item": "Yuengling",
    "size": "24pk",
    "qty": 1
   }
  ],
  "everythingElse": [
   {
    "item": "Coca Cola",
    "size": "12 pack",
    "qty": 1
   },
   {
    "item": "Diet Coke",
    "size": "12 pack",
    "qty": 1
   },
   {
    "item": "Sprite",
    "size": "12 pack",
    "qty": 1
   },
   {
    "item": "Club Soda",
    "size": "8 pack",
    "qty": 3
   },
   {
    "item": "Tonic Water",
    "size": "1L",
    "qty": 1
   },
   {
    "item": "Cranberry Juice",
    "size": "64oz",
    "qty": 1
   },
   {
    "item": "Pineapple Juice",
    "size": "64oz",
    "qty": 1
   },
   {
    "item": "Orange Juice",
    "size": "64oz",
    "qty": 1
   },
   {
    "item": "Lemon Juice",
    "size": "31oz",
    "qty": 1
   },
   {
    "item": "Lime Juice (UNSWEET)",
    "size": "15oz",
    "qty": 1
   },
   {
    "item": "Simple Syrup",
    "size": "1L",
    "qty": 1
   },
   {
    "item": "Angostura Bitters",
    "size": "4oz",
    "qty": 1
   },
   {
    "item": "Premium Cherries",
    "size": "ea.",
    "qty": 1
   },
   {
    "item": "Lemons",
    "size": "ea.",
    "qty": 2
   },
   {
    "item": "Limes",
    "size": "ea.",
    "qty": 5
   },
   {
    "item": "Oranges",
    "size": "ea.",
    "qty": 1
   },
   {
    "item": "Water",
    "size": "24pk",
    "qty": 2
   },
   {
    "item": "Cups (9oz)",
    "size": "500",
    "qty": 1
   },
   {
    "item": "Straws",
    "size": "box",
    "qty": 1
   },
   {
    "item": "Napkins",
    "size": "100",
    "qty": 1
   },
   {
    "item": "Ice",
    "size": "lbs",
    "qty": 60
   },
   {
    "item": "Ginger Beer",
    "size": "4 pack",
    "qty": 2
   }
  ],
  "serviceStyle": "full_bar",
  "beerSelections": [],
  "wineSelections": [],
  "mixersForSignatureDrinks": null,
  "_signatureCocktails": [
   {
    "name": "Moscow Mule",
    "ingredients": [
     "vodka",
     "ginger beer"
    ]
   }
  ],
  "_syrupSelfProvided": []
 },
 "sig_beer_wine_120": {
  "clientName": "Fixture Client",
  "guestCount": 120,
  "eventDate": "2026-08-01",
  "notes": "",
  "signatureCocktailNames": [
   "Blue Lab Coat",
   "Moscow Mule",
   "Raspberry Reaction"
  ],
  "liquorBeerWine": [
   {
    "item": "Malibu Coconut Rum",
    "size": "750mL",
    "qty": 5
   },
   {
    "item": "Blue Curacao",
    "size": "750mL",
    "qty": 5
   },
   {
    "item": "Tito's Vodka",
    "size": "750mL",
    "qty": 5
   },
   {
    "item": "Raspberry Vodka",
    "size": "750mL",
    "qty": 5
   },
   {
    "item": "Michelob Ultra",
    "size": "24pk",
    "qty": 3
   },
   {
    "item": "IPA (Lagunitas / Voodoo Ranger)",
    "size": "12pk",
    "qty": 3
   },
   {
    "item": "Cabernet Sauvignon",
    "size": "750mL",
    "qty": 8
   },
   {
    "item": "Pinot Noir",
    "size": "750mL",
    "qty": 8
   },
   {
    "item": "Champagne",
    "size": "750mL",
    "qty": 15
   }
  ],
  "everythingElse": [
   {
    "item": "Pineapple Juice",
    "size": "64oz",
    "qty": 5
   },
   {
    "item": "Ginger Beer",
    "size": "4 pack",
    "qty": 5
   },
   {
    "item": "Sprite",
    "size": "12 pack",
    "qty": 5
   },
   {
    "item": "Lemonade (REAL)",
    "size": "1G",
    "qty": 5
   },
   {
    "item": "Coca Cola",
    "size": "12 pack",
    "qty": 3
   },
   {
    "item": "Diet Coke",
    "size": "12 pack",
    "qty": 2
   },
   {
    "item": "Sprite",
    "size": "12 pack",
    "qty": 2
   },
   {
    "item": "Club Soda",
    "size": "8 pack",
    "qty": 8
   },
   {
    "item": "Tonic Water",
    "size": "1L",
    "qty": 3
   },
   {
    "item": "Cranberry Juice",
    "size": "64oz",
    "qty": 3
   },
   {
    "item": "Pineapple Juice",
    "size": "64oz",
    "qty": 3
   },
   {
    "item": "Orange Juice",
    "size": "64oz",
    "qty": 2
   },
   {
    "item": "Lemon Juice",
    "size": "31oz",
    "qty": 2
   },
   {
    "item": "Lime Juice (UNSWEET)",
    "size": "15oz",
    "qty": 2
   },
   {
    "item": "Simple Syrup",
    "size": "1L",
    "qty": 3
   },
   {
    "item": "Angostura Bitters",
    "size": "4oz",
    "qty": 2
   },
   {
    "item": "Premium Cherries",
    "size": "ea.",
    "qty": 2
   },
   {
    "item": "Lemons",
    "size": "ea.",
    "qty": 5
   },
   {
    "item": "Limes",
    "size": "ea.",
    "qty": 15
   },
   {
    "item": "Oranges",
    "size": "ea.",
    "qty": 3
   },
   {
    "item": "Water",
    "size": "24pk",
    "qty": 5
   },
   {
    "item": "Cups (9oz)",
    "size": "500",
    "qty": 2
   },
   {
    "item": "Straws",
    "size": "box",
    "qty": 2
   },
   {
    "item": "Napkins",
    "size": "100",
    "qty": 2
   },
   {
    "item": "Ice",
    "size": "lbs",
    "qty": 180
   },
   {
    "item": "Lavender Syrup",
    "size": "750mL",
    "qty": 3
   },
   {
    "item": "Jalapeño Syrup",
    "size": "750mL",
    "qty": 3
   }
  ],
  "serviceStyle": "sig_beer_wine",
  "beerSelections": [
   "Light / Easy Drinking",
   "IPA"
  ],
  "wineSelections": [
   "Red",
   "Sparkling"
  ],
  "mixersForSignatureDrinks": true,
  "_signatureCocktails": [
   {
    "name": "Blue Lab Coat",
    "ingredients": [
     "coconut rum",
     "blue curacao",
     "pineapple juice"
    ]
   },
   {
    "name": "Moscow Mule",
    "ingredients": [
     "vodka",
     "ginger beer"
    ]
   },
   {
    "name": "Raspberry Reaction",
    "ingredients": [
     "raspberry vodka",
     "sprite",
     "lemonade"
    ]
   }
  ],
  "_syrupSelfProvided": [
   "lavender",
   "jalapeno"
  ]
 },
 "beer_wine_80": {
  "clientName": "Fixture Client",
  "guestCount": 80,
  "eventDate": "2026-08-01",
  "notes": "",
  "signatureCocktailNames": [],
  "liquorBeerWine": [
   {
    "item": "White Claw Variety",
    "size": "12pk",
    "qty": 2
   },
   {
    "item": "Athletic Brewing NA",
    "size": "12pk",
    "qty": 1
   },
   {
    "item": "Moscato",
    "size": "750mL",
    "qty": 5
   },
   {
    "item": "Sauvignon Blanc",
    "size": "750mL",
    "qty": 5
   }
  ],
  "everythingElse": [
   {
    "item": "Water",
    "size": "24pk",
    "qty": 4
   },
   {
    "item": "Cups (9oz)",
    "size": "500",
    "qty": 1
   },
   {
    "item": "Straws",
    "size": "box",
    "qty": 1
   },
   {
    "item": "Napkins",
    "size": "100",
    "qty": 1
   },
   {
    "item": "Ice",
    "size": "lbs",
    "qty": 120
   }
  ],
  "serviceStyle": "beer_wine",
  "beerSelections": [
   "Seltzer",
   "Non-Alcoholic"
  ],
  "wineSelections": [
   "White"
  ],
  "mixersForSignatureDrinks": null,
  "_signatureCocktails": [],
  "_syrupSelfProvided": []
 },
 "consult_full_120": {
  "clientName": "Fixture Client",
  "guestCount": 120,
  "eventDate": "2026-08-01",
  "notes": "",
  "signatureCocktailNames": [
   "Margarita",
   "House Mule"
  ],
  "liquorBeerWine": [
   {
    "item": "Tito's Vodka",
    "size": "1.75L",
    "qty": 6
   },
   {
    "item": "Bulleit Bourbon",
    "size": "1.75L",
    "qty": 5
   },
   {
    "item": "Michelob Ultra",
    "size": "24pk",
    "qty": 3
   },
   {
    "item": "Local Craft Beer",
    "size": "24pk",
    "qty": 3
   },
   {
    "item": "IPA (Lagunitas / Voodoo Ranger)",
    "size": "12pk",
    "qty": 3
   },
   {
    "item": "Cabernet Sauvignon",
    "size": "750mL",
    "qty": 8
   },
   {
    "item": "Pinot Noir",
    "size": "750mL",
    "qty": 8
   },
   {
    "item": "Champagne",
    "size": "750mL",
    "qty": 15
   },
   {
    "item": "1800 Blanco Tequila",
    "size": "750mL",
    "qty": 5
   }
  ],
  "everythingElse": [
   {
    "item": "Ginger Beer",
    "size": "4 pack",
    "qty": 5
   },
   {
    "item": "Coca Cola",
    "size": "12 pack",
    "qty": 3
   },
   {
    "item": "Diet Coke",
    "size": "12 pack",
    "qty": 2
   },
   {
    "item": "Sprite",
    "size": "12 pack",
    "qty": 2
   },
   {
    "item": "Club Soda",
    "size": "8 pack",
    "qty": 8
   },
   {
    "item": "Tonic Water",
    "size": "1L",
    "qty": 3
   },
   {
    "item": "Cranberry Juice",
    "size": "64oz",
    "qty": 3
   },
   {
    "item": "Pineapple Juice",
    "size": "64oz",
    "qty": 3
   },
   {
    "item": "Orange Juice",
    "size": "64oz",
    "qty": 2
   },
   {
    "item": "Lemon Juice",
    "size": "31oz",
    "qty": 2
   },
   {
    "item": "Lime Juice (UNSWEET)",
    "size": "15oz",
    "qty": 2
   },
   {
    "item": "Simple Syrup",
    "size": "1L",
    "qty": 3
   },
   {
    "item": "Angostura Bitters",
    "size": "4oz",
    "qty": 2
   },
   {
    "item": "Premium Cherries",
    "size": "ea.",
    "qty": 2
   },
   {
    "item": "Lemons",
    "size": "ea.",
    "qty": 5
   },
   {
    "item": "Limes",
    "size": "ea.",
    "qty": 15
   },
   {
    "item": "Oranges",
    "size": "ea.",
    "qty": 3
   },
   {
    "item": "Water",
    "size": "24pk",
    "qty": 5
   },
   {
    "item": "Cups (9oz)",
    "size": "500",
    "qty": 2
   },
   {
    "item": "Straws",
    "size": "box",
    "qty": 2
   },
   {
    "item": "Napkins",
    "size": "100",
    "qty": 2
   },
   {
    "item": "Ice",
    "size": "lbs",
    "qty": 180
   }
  ],
  "serviceStyle": "sig_beer_wine",
  "beerSelections": [
   "Light / Easy Drinking",
   "Craft / Local",
   "IPA"
  ],
  "wineSelections": [
   "Red",
   "Sparkling"
  ],
  "mixersForSignatureDrinks": true,
  "_signatureCocktails": [
   {
    "name": "Margarita",
    "ingredients": [
     "tequila"
    ]
   },
   {
    "name": "House Mule",
    "ingredients": [
     "vodka",
     "ginger beer",
     "lime"
    ]
   }
  ],
  "_syrupSelfProvided": []
 },
 "consult_matching_120": {
  "clientName": "Fixture Client",
  "guestCount": 120,
  "eventDate": "2026-08-01",
  "notes": "",
  "signatureCocktailNames": [
   "Margarita",
   "House Mule"
  ],
  "liquorBeerWine": [
   {
    "item": "Tito's Vodka",
    "size": "1.75L",
    "qty": 6
   },
   {
    "item": "Bulleit Bourbon",
    "size": "1.75L",
    "qty": 5
   },
   {
    "item": "Michelob Ultra",
    "size": "24pk",
    "qty": 3
   },
   {
    "item": "Local Craft Beer",
    "size": "24pk",
    "qty": 3
   },
   {
    "item": "IPA (Lagunitas / Voodoo Ranger)",
    "size": "12pk",
    "qty": 3
   },
   {
    "item": "Cabernet Sauvignon",
    "size": "750mL",
    "qty": 8
   },
   {
    "item": "Pinot Noir",
    "size": "750mL",
    "qty": 8
   },
   {
    "item": "Champagne",
    "size": "750mL",
    "qty": 15
   },
   {
    "item": "1800 Blanco Tequila",
    "size": "750mL",
    "qty": 5
   }
  ],
  "everythingElse": [
   {
    "item": "Ginger Beer",
    "size": "4 pack",
    "qty": 5
   },
   {
    "item": "Cranberry Juice",
    "size": "64oz",
    "qty": 3
   },
   {
    "item": "Orange Juice",
    "size": "64oz",
    "qty": 2
   },
   {
    "item": "Tonic Water",
    "size": "1L",
    "qty": 3
   },
   {
    "item": "Club Soda",
    "size": "8 pack",
    "qty": 8
   },
   {
    "item": "Lime Juice (UNSWEET)",
    "size": "15oz",
    "qty": 2
   },
   {
    "item": "Limes",
    "size": "ea.",
    "qty": 15
   },
   {
    "item": "Coca Cola",
    "size": "12 pack",
    "qty": 3
   },
   {
    "item": "Angostura Bitters",
    "size": "4oz",
    "qty": 2
   },
   {
    "item": "Premium Cherries",
    "size": "ea.",
    "qty": 2
   },
   {
    "item": "Water",
    "size": "24pk",
    "qty": 5
   },
   {
    "item": "Cups (9oz)",
    "size": "500",
    "qty": 2
   },
   {
    "item": "Straws",
    "size": "box",
    "qty": 2
   },
   {
    "item": "Napkins",
    "size": "100",
    "qty": 2
   },
   {
    "item": "Ice",
    "size": "lbs",
    "qty": 180
   }
  ],
  "serviceStyle": "sig_beer_wine",
  "beerSelections": [
   "Light / Easy Drinking",
   "Craft / Local",
   "IPA"
  ],
  "wineSelections": [
   "Red",
   "Sparkling"
  ],
  "mixersForSignatureDrinks": true,
  "_signatureCocktails": [
   {
    "name": "Margarita",
    "ingredients": [
     "tequila"
    ]
   },
   {
    "name": "House Mule",
    "ingredients": [
     "vodka",
     "ginger beer",
     "lime"
    ]
   }
  ],
  "_syrupSelfProvided": []
 }
};

// ─── Fixture inputs (shared with lane potions-b's generator test) ───────────
const SIGS = [
  { name: 'Blue Lab Coat', ingredients: ['coconut rum', 'blue curacao', 'pineapple juice'] },
  { name: 'Moscow Mule', ingredients: ['vodka', 'ginger beer'] },
  { name: 'Raspberry Reaction', ingredients: ['raspberry vodka', 'sprite', 'lemonade'] },
  { name: 'Screwdriver', ingredients: ['vodka', 'orange juice'] },
];
const CONSULT_CTX = { clientName: 'Fixture Client', guestCount: 120, eventDate: '2026-08-01' };
const CONSULT_BASE = {
  barType: 'sig_beer_wine', spirits: ['vodka', 'bourbon'], beer: true, wine: ['red', 'sparkling'],
  customCocktails: [{ name: 'House Mule', ingredients: ['vodka', 'ginger beer', 'lime'] }],
  customMocktails: [], mocktailsEnabled: false, notes: '',
};
const CONSULT_SIGS = [{ name: 'Margarita', ingredients: ['tequila'] }];

function stripIds(list) {
  const clean = JSON.parse(JSON.stringify(list));
  for (const key of ['liquorBeerWine', 'everythingElse']) {
    clean[key] = (clean[key] || []).map(({ _id, ...rest }) => rest);
  }
  return clean;
}

// Runs every fixture through a generator; lane potions-b re-uses this with
// the catalog argument to prove output identity against SNAPSHOTS.
function runFixtures(generate, catalog) {
  const g = (input) => stripIds(catalog === undefined ? generate(input) : generate(input, catalog));
  return {
    full_bar_100: g({ clientName: 'Fixture Client', guestCount: 100, eventDate: '2026-08-01', notes: '', serviceStyle: 'full_bar', signatureCocktails: SIGS.slice(0, 2) }),
    full_bar_175: g({ clientName: 'Fixture Client', guestCount: 175, eventDate: '2026-08-01', notes: '', serviceStyle: 'full_bar', signatureCocktails: SIGS }),
    full_bar_40_bottles: g({ clientName: 'Fixture Client', guestCount: 40, eventDate: '2026-08-01', notes: '', serviceStyle: 'full_bar', signatureCocktails: [SIGS[1]] }),
    sig_beer_wine_120: g({
      clientName: 'Fixture Client', guestCount: 120, eventDate: '2026-08-01', notes: '', serviceStyle: 'sig_beer_wine',
      signatureCocktails: SIGS.slice(0, 3), beerSelections: ['Light / Easy Drinking', 'IPA'], wineSelections: ['Red', 'Sparkling'],
      mixersForSignatureDrinks: true, syrupSelfProvided: ['lavender', 'jalapeno'], syrupNamesById: { lavender: 'Lavender', jalapeno: 'Jalapeño' },
    }),
    beer_wine_80: g({ clientName: 'Fixture Client', guestCount: 80, eventDate: '2026-08-01', notes: '', serviceStyle: 'beer_wine', beerSelections: ['Seltzer', 'Non-Alcoholic'], wineSelections: ['White'] }),
    consult_full_120: g(buildGeneratorInputFromConsult({ ...CONSULT_BASE, mixers: 'full' }, CONSULT_CTX, CONSULT_SIGS, [])),
    consult_matching_120: g(buildGeneratorInputFromConsult({ ...CONSULT_BASE, mixers: 'matching' }, CONSULT_CTX, CONSULT_SIGS, [])),
  };
}

const catalog = buildCatalogSlices(SEED_ROWS);

// Merge-size rule (spec §3.2): sig-merge adds role='spirit' 1.75L items as
// 750mL, reproducing the legacy INGREDIENT_MAP's smaller sig-drink bottles.
function applyMergeSize(resolved) {
  if (!resolved) return resolved;
  const row = catalog.byId.get(resolved.itemId);
  if (row && row.role === 'spirit' && resolved.size === '1.75L') return { ...resolved, size: '750mL' };
  return resolved;
}

test('seed fixture sanity: 48 rows, 34 in_full_bar, both sections', () => {
  assert.equal(SEED_ROWS.length, 48);
  assert.equal(SEED_ROWS.filter((r) => r.in_full_bar).length, 34);
  assert.equal(SEED_ROWS.filter((r) => r.section === 'liquorBeerWine').length, 23);
  assert.equal(SEED_ROWS.filter((r) => r.section === 'everythingElse').length, 25);
});

test('pars100 slices reproduce PARS_100 byte-identical', () => {
  assert.deepEqual(catalog.pars100.liquorBeerWine, PARS_100.liquorBeerWine);
  assert.deepEqual(catalog.pars100.everythingElse, PARS_100.everythingElse);
});

test('spiritPars reproduces SPIRIT_PARS (incl. whiskey = bourbon)', () => {
  assert.deepEqual(Object.keys(catalog.spiritPars).sort(), Object.keys(SPIRIT_PARS).sort());
  for (const key of Object.keys(SPIRIT_PARS)) {
    assert.deepEqual(catalog.spiritPars[key], SPIRIT_PARS[key], `spiritPars.${key}`);
  }
});

test('beer/wine style maps reproduce legacy maps', () => {
  assert.deepEqual(catalog.beerStyleMap, BEER_STYLE_MAP);
  assert.deepEqual(catalog.wineStyleMap, WINE_STYLE_MAP);
});

test('role slices reproduce BASIC_MIXERS / GARNISHES / ALWAYS_INCLUDE', () => {
  assert.deepEqual(catalog.basicMixers, BASIC_MIXERS);
  assert.deepEqual(catalog.garnishes, GARNISHES);
  assert.deepEqual(catalog.alwaysInclude, ALWAYS_INCLUDE);
});

test('spiritMixerPairings reproduce legacy pairings as sets (order is the accepted delta)', () => {
  assert.deepEqual(Object.keys(catalog.spiritMixerPairings).sort(), Object.keys(SPIRIT_MIXER_PAIRINGS).sort());
  for (const [spirit, names] of Object.entries(SPIRIT_MIXER_PAIRINGS)) {
    assert.deepEqual(new Set(catalog.spiritMixerPairings[spirit]), new Set(names), `pairings.${spirit}`);
  }
});

test('all 17 INGREDIENT_MAP keys resolve to identical {item,size,section}', () => {
  const keys = Object.keys(INGREDIENT_MAP);
  assert.equal(keys.length, 17); // NOT 18 — corrected 2026-07-09
  for (const key of keys) {
    const legacy = INGREDIENT_MAP[key];
    const resolved = applyMergeSize(resolveIngredient(key, catalog));
    assert.ok(resolved, `alias resolution missing for legacy key "${key}"`);
    assert.deepEqual(
      { item: resolved.item, size: resolved.size, section: resolved.section },
      { item: legacy.item, size: legacy.size, section: legacy.section },
      `INGREDIENT_MAP["${key}"]`
    );
  }
});

test('alias matching: exact beats substring, longest substring wins', () => {
  // "ginger beer" must NOT resolve to gin (legacy ordering hack, now by length)
  assert.equal(resolveIngredient('ginger beer', catalog).item, 'Ginger Beer');
  assert.equal(resolveIngredient('gin', catalog).item, 'Tanqueray Gin');
  // substring fallback on free text
  assert.equal(resolveIngredient('fresh squeezed orange juice', catalog).item, 'Orange Juice');
  // "diet coke" beats "coke"
  assert.equal(resolveIngredient('diet coke', catalog).item, 'Diet Coke');
  // no match -> null, never a guess
  assert.equal(resolveIngredient('dragonfruit foam', catalog), null);
});

test('normalizeName strips punctuation and collapses whitespace', () => {
  assert.equal(normalizeName('  Lime   Juice (UNSWEET) '), 'lime juice unsweet');
  assert.equal(normalizeName("Tito's Vodka"), 'tito s vodka');
  assert.equal(resolveIngredient('Aperol!', catalog), null); // no aperol row in lane A
});

test('resolveRecipeRow: override wins when active, falls through when inactive/missing', () => {
  // active override
  const withOverride = resolveRecipeRow({ ingredient: 'Rum', override_item_id: 'malibu-coconut-rum' }, catalog);
  assert.equal(withOverride.item, 'Malibu Coconut Rum');
  // inactive override falls through to alias resolution (spec §8.2)
  const rowsWithInactive = SEED_ROWS.map((r) => (r.id === 'malibu-coconut-rum' ? { ...r, is_active: false } : r));
  const cat2 = buildCatalogSlices(rowsWithInactive);
  const fallthrough = resolveRecipeRow({ ingredient: 'Rum', override_item_id: 'malibu-coconut-rum' }, cat2);
  assert.equal(fallthrough.item, 'Bacardi Rum');
  // missing override id falls through
  const missing = resolveRecipeRow({ ingredient: 'Vodka', override_item_id: 'no-such-row' }, catalog);
  assert.equal(missing.item, "Tito's Vodka");
  // override to inactive row with no alias match -> null (visible unresolved, never resurrect)
  const dead = resolveRecipeRow({ ingredient: 'mystery cordial', override_item_id: 'malibu-coconut-rum' }, cat2);
  assert.equal(dead, null);
  // legacy plain-string rows still resolve
  assert.equal(resolveRecipeRow('blue curacao', catalog).item, 'Blue Curacao');
});

test('inactive rows are excluded from every slice', () => {
  const rows = SEED_ROWS.map((r) => (r.id === 'titos-vodka' ? { ...r, is_active: false } : r));
  const cat2 = buildCatalogSlices(rows);
  assert.equal(cat2.pars100.liquorBeerWine.length, PARS_100.liquorBeerWine.length - 1);
  assert.equal(cat2.spiritPars.vodka, undefined);
  assert.equal(resolveIngredient('vodka', cat2), null);
});

test('empty catalog reports isEmpty', () => {
  assert.equal(buildCatalogSlices([]).isEmpty, true);
  assert.equal(catalog.isEmpty, false);
});

test('legacy generator still reproduces the frozen snapshots (capture is faithful)', () => {
  // In lane potions-a the generator is untouched, so this proves the
  // SNAPSHOTS + FIXTURE_INPUTS pair is internally consistent. Lane potions-b
  // re-runs runFixtures(generateShoppingList, catalog) against the SAME
  // snapshots — that run is the real parity gate.
  const out = runFixtures(generateShoppingList);
  for (const name of Object.keys(SNAPSHOTS)) {
    // The generator output gained two ADDITIVE fields in lane potions-b
    // (needsRecipe, _unresolvedIngredients); snapshots predate them. Strip
    // before comparing — lane B's own suite asserts their contents.
    const { needsRecipe, _unresolvedIngredients, ...clean } = out[name];
    assert.deepEqual(clean, SNAPSHOTS[name], `snapshot ${name}`);
  }
});

module.exports = { SEED_ROWS, SNAPSHOTS, runFixtures, stripIds, applyMergeSize };
