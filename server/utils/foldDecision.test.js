// server/utils/foldDecision.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideFold } = require('./foldDecision');

test('the invoice rule', () => {
  assert.equal(decideFold({ hasPackage: true, packageCents: 30000, gapCents: 0 }), 'none');
  assert.equal(decideFold({ hasPackage: false, packageCents: 0, gapCents: -500 }), 'skipped');
  assert.equal(decideFold({ hasPackage: true, packageCents: 30000, gapCents: -30000 }), 'package'); // reaches exactly 0
  assert.equal(decideFold({ hasPackage: true, packageCents: 30000, gapCents: -30001 }), 'fallback');
  assert.equal(decideFold({ hasPackage: true, packageCents: 30000, gapCents: 7500 }), 'package');
});

test('one "Pricing adjustment" label names the fallback on the invoice and on the page', () => {
  const { PRICING_ADJUSTMENT_LABEL } = require('./foldDecision');
  const { buildInvoiceLineItems } = require('./invoiceLineItems');
  const { buildClientPriceRows } = require('./clientPriceLines');
  assert.equal(PRICING_ADJUSTMENT_LABEL, 'Pricing adjustment');
  // A $100 package beside $200 of bar rental with nothing owed: both folds fall back.
  const snap = {
    package: { name: 'Test Package', base_cost: 100 }, staffing: { total: 0 },
    bar_rental: { total: 200 }, gratuity: { total: 0 }, subtotal: 300, total: 0,
  };
  const { items } = buildInvoiceLineItems({ snapshot: snap, totalPriceCents: 0 });
  assert.equal(items.at(-1).description, PRICING_ADJUSTMENT_LABEL);
  const { rows } = buildClientPriceRows(snap, { targetCents: 0, packageName: 'Test Package' });
  assert.equal(rows.at(-1).label, PRICING_ADJUSTMENT_LABEL);
});
