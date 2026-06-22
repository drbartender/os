require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../../db');
const { generateLineItemsFromProposal, writeLineItems, createInvoice } = require('../../utils/invoiceHelpers');

// SERVER-15 regression. A half-hour event window yields a FRACTIONAL add-on
// quantity (a per-hour add-on for a 6:00-9:30 PM window = 3.5 hours). Before the
// fix, both proposal_addons.quantity AND invoice_line_items.quantity were
// INTEGER, so 3.5 raised 22P02 and 500'd the public proposal submit (and would
// have 500'd invoice generation). Both columns are now NUMERIC(10,2); readers
// coerce back to a JS number.
//
// REQUIRES the NUMERIC migration applied to the test DB (schema.sql initDb).

let clientId;
let proposalId;
let invoiceId;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ('S15 Test', $1) RETURNING id",
    [`s15-${Date.now()}@example.com`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    "INSERT INTO proposals (client_id, status, event_date, total_price, pricing_snapshot) VALUES ($1, 'sent', '2099-09-09', 1000, '{}') RETURNING id",
    [clientId]
  );
  proposalId = p.rows[0].id;
  // A per-hour add-on priced for a 3.5h window: quantity 3.5, $40/hr, $140 line.
  // On the old INTEGER column this INSERT itself 22P02'd (the original bug).
  await pool.query(
    "INSERT INTO proposal_addons (proposal_id, addon_name, billing_type, rate, quantity, line_total) VALUES ($1, 'Barback', 'per_hour', 40, 3.5, 140)",
    [proposalId]
  );
});

after(async () => {
  if (invoiceId) await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = $1', [invoiceId]);
  if (invoiceId) await pool.query('DELETE FROM invoices WHERE id = $1', [invoiceId]);
  if (proposalId) await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]); // cascades proposal_addons
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('proposal_addons.quantity stores 3.5 and reads back as the number 3.5', async () => {
  const r = await pool.query(
    'SELECT quantity::float8 AS quantity FROM proposal_addons WHERE proposal_id = $1',
    [proposalId]
  );
  assert.strictEqual(r.rows[0].quantity, 3.5);
});

test('the 3.5 add-on flows into an invoice line item without a 500 (invoice_line_items.quantity)', async () => {
  const items = await generateLineItemsFromProposal(proposalId);
  const addonItem = items.find((i) => i.source_type === 'addon');
  assert.ok(addonItem, 'an add-on line item was generated');
  assert.strictEqual(Number(addonItem.quantity), 3.5, 'generated line item carries quantity 3.5');

  const invoice = await createInvoice({ proposalId, label: 'Test', amountDueCents: 14000, status: 'draft' });
  invoiceId = invoice.id;
  // Pre-fix, this INSERT 22P02'd on the INTEGER invoice_line_items.quantity.
  await writeLineItems(invoiceId, items);

  const li = await pool.query(
    "SELECT quantity::float8 AS quantity FROM invoice_line_items WHERE invoice_id = $1 AND source_type = 'addon'",
    [invoiceId]
  );
  assert.strictEqual(li.rows[0].quantity, 3.5, 'invoice line item quantity round-trips as 3.5');
});
