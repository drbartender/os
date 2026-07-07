// refreshUnlockedInvoices must net proposals.external_paid (money collected
// off-platform in CheckCherry, cc-transfer 2026-07-07) out of refreshed
// Balance / Full Payment invoices — otherwise a proposal edit or drink-plan
// resubmit re-inflates the invoice and re-bills money the client already
// paid, the exact v1-class failure the transfer project exists to prevent.
//
// Shared dev DB conventions: run alone (node -r dotenv/config --test), one
// synthetic proposal, cleaned up in finally.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { refreshUnlockedInvoices } = require('./invoiceLifecycle');

test('refreshUnlockedInvoices nets external_paid on Balance and Full Payment labels', async () => {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('refuses to run against production');
  }
  const ids = { client: null, proposal: null, invoices: [] };
  try {
    const c = await pool.query(
      `INSERT INTO clients (name, email, source) VALUES ('Ada Lovelace', $1, 'other') RETURNING id`,
      [`invoice-external-test-${process.pid}@example.com`]
    );
    ids.client = c.rows[0].id;
    const p = await pool.query(
      `INSERT INTO proposals (client_id, event_date, guest_count, total_price, amount_paid, external_paid, status)
       VALUES ($1, '2026-12-01', 50, 930, 100, 100, 'confirmed') RETURNING id`,
      [ids.client]
    );
    ids.proposal = p.rows[0].id;

    for (const label of ['Balance', 'Full Payment']) {
      const inv = await pool.query(
        `INSERT INTO invoices (proposal_id, label, amount_due, status, locked, invoice_number)
         VALUES ($1, $2, 1, 'draft', false, $3) RETURNING id`,
        [ids.proposal, label, `TX${String(process.pid).slice(-5)}${label === 'Balance' ? 'B' : 'F'}`]
      );
      ids.invoices.push({ id: inv.rows[0].id, label });
    }

    await refreshUnlockedInvoices(ids.proposal);

    for (const { id, label } of ids.invoices) {
      const { rows: [row] } = await pool.query('SELECT amount_due FROM invoices WHERE id = $1', [id]);
      // $930 total − $100 external = $83,000 cents for BOTH labels (no locked invoices exist).
      assert.equal(Number(row.amount_due), 83000, `${label} must net external_paid`);
    }
  } finally {
    if (ids.proposal) {
      await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = ANY($1)', [ids.invoices.map((i) => i.id)]);
      await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [ids.proposal]);
      await pool.query('DELETE FROM proposals WHERE id = $1', [ids.proposal]);
    }
    if (ids.client) await pool.query('DELETE FROM clients WHERE id = $1', [ids.client]);
    await pool.end();
  }
});
