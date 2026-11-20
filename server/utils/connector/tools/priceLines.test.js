// The connector's price lines (priceLines.js) against the admin screen's own rule: the server's hiddenFlags and the client's hiddenRowFlags (client/src/utils/hiddenRows.js) run on one fixture set and must agree row for row.
//
// The client file is an ES module with extensionless imports, which node
// loads here through a resolve and load hook kept to client/src (no build
// step, no copy of the rule). Pure: no database.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const nodeModule = require('node:module');
const { hiddenFlags, adminPriceLines, ADD_ON_UNITS } = require('./priceLines');

const CLIENT_SRC = path.resolve(__dirname, '../../../../client/src');
let hiddenRowFlags;

before(async () => {
  nodeModule.registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL && context.parentURL.includes('/client/src/') && specifier.startsWith('.') && !path.extname(specifier)) {
        return next(`${specifier}.js`, context);
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      const r = next(url, context);
      return url.includes('/client/src/') ? { ...r, format: 'module' } : r;
    },
  });
  ({ hiddenRowFlags } = await import(pathToFileURL(path.join(CLIENT_SRC, 'utils/hiddenRows.js')).href));
});

const SERVICE_ROWS = [
  { label: 'BYOB Bar (4hrs, 60 guests)', amount: 1000 },
  { label: 'Bar Rental (1 bar)', amount: 50 },
  { label: 'Shared Gratuity', amount: 100 },
];

const FIXTURES = {
  'rows carrying visible': {
    gratuity: { total: 200 },
    adjustments: [{ type: 'discount', label: 'A', amount: 100, visible: true }, { type: 'surcharge', label: '', amount: 40, visible: false }],
    breakdown: [...SERVICE_ROWS, { label: 'A', amount: -100, visible: true }, { label: 'Surcharge', amount: 40, visible: false }, { label: 'Gratuity', amount: 200 }],
  },
  'a legacy hidden discount (no visible key on the row)': {
    adjustments: [{ type: 'discount', label: 'Courtesy', amount: 50 }],
    breakdown: [...SERVICE_ROWS, { label: 'Courtesy', amount: -50 }],
  },
  'a hidden surcharge copying a service row': {
    adjustments: [{ type: 'surcharge', label: 'Shared Gratuity', amount: 100, visible: false }],
    breakdown: [...SERVICE_ROWS, { label: 'Shared Gratuity', amount: 100 }],
  },
  'a mandated gratuity last beside a hidden surcharge named Gratuity': {
    gratuity: { total: 80 },
    adjustments: [{ type: 'surcharge', label: 'Gratuity', amount: 30, visible: false }],
    breakdown: [...SERVICE_ROWS, { label: 'Gratuity', amount: 30 }, { label: 'Gratuity', amount: 80 }],
  },
  'a line with no row': {
    adjustments: [{ type: 'discount', label: 'Gone', amount: 10, visible: false }, { type: 'surcharge', label: 'Rush', amount: 25, visible: true }],
    breakdown: [...SERVICE_ROWS, { label: 'Rush', amount: 25 }],
  },
  'no adjustments, no breakdown': {},
  'half cents rounded as the line is': {
    adjustments: [{ type: 'discount', label: 'Odd', amount: 10.005 }],
    breakdown: [...SERVICE_ROWS, { label: 'Odd', amount: -10.005 }],
  },
};

test('the server copy marks exactly the rows the admin screen marks, on every fixture', () => {
  for (const [name, snapshot] of Object.entries(FIXTURES)) {
    assert.deepEqual(hiddenFlags(snapshot), hiddenRowFlags(snapshot), name);
  }
  assert.ok(hiddenFlags(FIXTURES['a legacy hidden discount (no visible key on the row)']).includes(true), 'the fixtures exercise a hidden row');
});

test('adminPriceLines: the display label, the stored amount, the hidden mark; add-on units per billing type', () => {
  const lines = adminPriceLines(FIXTURES['a hidden surcharge copying a service row']);
  assert.deepEqual(lines.map((l) => [l.label, l.amount, l.hidden_from_client]), [
    ['BYOB Bar (4hrs, 60 guests)', 1000, false], ['Bar Rental (1 bar)', 50, false],
    ['Staffing Gratuity', 100, false], ['Staffing Gratuity', 100, true],
  ]);
  assert.deepEqual(Object.keys(ADD_ON_UNITS).sort(), ['flat', 'per_100_guests', 'per_guest', 'per_guest_timed', 'per_hour', 'per_staff']);
});
