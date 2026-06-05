require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert');
const { generateLineItemsFromProposal } = require('./invoiceHelpers');
const { pool } = require('../db');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoiceHelpers.gratuity.test.js refuses to run against production');
}

after(async () => { await pool.end(); });

test('invoice line items include a Gratuity line when gratuity > 0', async () => {
  const snap = {
    package: { name: 'BYOB', base_cost: 1000 }, staffing: { extra: 0, total: 0 },
    bar_rental: { total: 0 }, syrups: { total: 0 }, adjustments: [],
    gratuity: { rate: 25, tip_jar: true, staff_count: 1, hours: 4, total: 100 },
  };
  const r = await pool.query(
    `INSERT INTO proposals (pricing_snapshot, total_price, status, tip_jar, gratuity_rate)
     VALUES ($1, 1100, 'sent', true, 25) RETURNING id`, [JSON.stringify(snap)]);
  const id = r.rows[0].id;
  try {
    const items = await generateLineItemsFromProposal(id);
    const grat = items.find(i => i.description === 'Gratuity');
    assert.ok(grat, 'Gratuity line present');
    assert.strictEqual(grat.line_total, 10000); // $100 -> cents
    assert.strictEqual(grat.unit_price, 10000);
  } finally {
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
});

test('no Gratuity line when gratuity is 0', async () => {
  const snap = {
    package: { name: 'BYOB', base_cost: 1000 }, staffing: { extra: 0, total: 0 },
    bar_rental: { total: 0 }, syrups: { total: 0 }, adjustments: [],
    gratuity: { rate: 0, tip_jar: true, staff_count: 1, hours: 4, total: 0 },
  };
  const r = await pool.query(
    `INSERT INTO proposals (pricing_snapshot, total_price, status) VALUES ($1, 1000, 'sent') RETURNING id`,
    [JSON.stringify(snap)]);
  const id = r.rows[0].id;
  try {
    const items = await generateLineItemsFromProposal(id);
    assert.ok(!items.some(i => i.description === 'Gratuity'));
  } finally {
    await pool.query('DELETE FROM proposals WHERE id = $1', [id]);
  }
});
