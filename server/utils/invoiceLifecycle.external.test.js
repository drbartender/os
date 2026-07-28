// refreshUnlockedInvoices must not re-bill proposals.external_paid (money
// collected off-platform in CheckCherry, cc-transfer 2026-07-07) on a
// refreshed Balance / Full Payment invoice — otherwise a proposal edit or
// drink-plan resubmit re-inflates the invoice and re-bills money the client
// already paid, the exact v1-class failure the transfer project exists to
// prevent.
//
// MECHANISM CHANGED 2026-07-28, assertion deliberately unchanged. The old
// derivation subtracted external_paid from total_price explicitly. It is no
// longer named in the formula at all: owed = total_price − amount_paid, and
// external_paid already lives INSIDE amount_paid (verified on prod prop 599,
// paid 360 = payments 260 + external 100). The arithmetic lands on the same
// figure, and the protection is now structural rather than a special case.
//
// FIXTURE SPLIT 2026-07-28: this seeded an open Balance AND an open Full
// Payment on ONE proposal to cover both labels in a single pass. That is two
// remainder bills on one proposal, which the derivation now deliberately
// refuses to allocate across (no prod proposal has ever had both; there are
// zero Full Payment rows in prod). Each label gets its own proposal so the
// suite tests the real shape.
//
// Shared dev DB conventions: run alone (node -r dotenv/config --test),
// synthetic rows cleaned up in finally.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('../db');
const { refreshUnlockedInvoices } = require('./invoiceLifecycle');

test.after(async () => { await pool.end(); });

for (const label of ['Balance', 'Full Payment']) {
  test(`refreshUnlockedInvoices does not re-bill external_paid on a ${label} invoice`, async () => {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('refuses to run against production');
    }
    const ids = { client: null, proposal: null, invoices: [] };
    try {
      const suffix = `${process.pid}-${label === 'Balance' ? 'B' : 'F'}`;
      const c = await pool.query(
        `INSERT INTO clients (name, email, source) VALUES ('Ada Lovelace', $1, 'other') RETURNING id`,
        [`invoice-external-test-${suffix}@example.com`]
      );
      ids.client = c.rows[0].id;
      const p = await pool.query(
        `INSERT INTO proposals (client_id, event_date, guest_count, total_price, amount_paid, external_paid, status)
         VALUES ($1, '2026-12-01', 50, 930, 100, 100, 'confirmed') RETURNING id`,
        [ids.client]
      );
      ids.proposal = p.rows[0].id;

      const inv = await pool.query(
        `INSERT INTO invoices (proposal_id, label, amount_due, status, locked, invoice_number)
         VALUES ($1, $2, 1, 'draft', false, $3) RETURNING id`,
        [ids.proposal, label, `TX${String(process.pid).slice(-5)}${label === 'Balance' ? 'B' : 'F'}`]
      );
      ids.invoices.push({ id: inv.rows[0].id, label });

      await refreshUnlockedInvoices(ids.proposal);

      const { rows: [row] } = await pool.query(
        'SELECT amount_due FROM invoices WHERE id = $1', [inv.rows[0].id]
      );
      // $930 total − $100 amount_paid (which CONTAINS the $100 external) = 83000 cents.
      assert.equal(Number(row.amount_due), 83000, `${label} must not re-bill external_paid`);
    } finally {
      if (ids.proposal) {
        await pool.query('DELETE FROM invoice_line_items WHERE invoice_id = ANY($1)', [ids.invoices.map((i) => i.id)]);
        await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [ids.proposal]);
        await pool.query('DELETE FROM proposals WHERE id = $1', [ids.proposal]);
      }
      if (ids.client) await pool.query('DELETE FROM clients WHERE id = $1', [ids.client]);
    }
  });
}
