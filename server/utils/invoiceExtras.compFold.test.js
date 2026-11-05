// The comp path reads the stored fold fact, and its ladder nets the
// off-contract money (round 3, H1 and M1, 2026-11-05).
//
// THE DEFECTS. (H1) voidExtrasInvoiceWithReconcile never selected
// folded_into_total and handed extrasLinesAreFolded no invoice, so comping an
// unpaid transaction-path invoice whose lines are syrup-only subtracted 0
// while its 6000 was folded: total_price stayed 106000 and the next Balance
// refresh billed the waived syrups (96000 against a 90000 contract). (M1) Its
// ladder call passed no offContractPaidCents, so the M2 shape (15000 total,
// 10000 deposit, a paid 6000 syrup-only invoice) read as fully paid again.
//
// PURE: a scripted transaction client answers the comp's reads by shape and
// records every statement.
//
//   node --test server/utils/invoiceExtras.compFold.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { voidExtrasInvoiceWithReconcile } = require('./invoiceExtras');

const SYRUP_LINES = [{ line_total: 6000, source_type: 'fee', description: 'Hand-Crafted Syrups (2 bottles)' }];
const ADDON_LINES = [{ line_total: 6000, source_type: 'addon', description: 'Banquet Server' }];

function scriptedClient({ invoice, lines, afterVoid, offContract = [] }) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (/FROM invoices WHERE id = \$1/.test(text)) return { rows: [invoice], rowCount: 1 };
      if (/FROM invoice_line_items WHERE invoice_id = \$1/.test(text)) return { rows: lines, rowCount: lines.length };
      if (/UPDATE proposals SET total_price = total_price - \$1/.test(text)) return { rows: [afterVoid], rowCount: 1 };
      if (/FROM invoices\s+WHERE proposal_id = \$1 AND status <> 'void' AND amount_paid > 0/.test(text)) {
        return { rows: offContract, rowCount: offContract.length };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}
const unpaid = (over = {}) => ({ id: 77, proposal_id: 4242, label: 'Drink Plan Extras', amount_due: 6000, amount_paid: 0, status: 'sent', ...over });
const totalDrops = (client) => client.calls.filter((c) => /UPDATE proposals SET total_price = total_price - \$1/.test(c.text));
const statusWrites = (client) => client.calls.filter((c) => /^UPDATE proposals SET status = \$1/.test(c.text.trim()));

test('H1: comping an unpaid invoice stored as folded, with only a syrup line, takes its 6000 back out of total_price', async () => {
  const client = scriptedClient({
    invoice: unpaid({ folded_into_total: true }), lines: SYRUP_LINES,
    afterVoid: { status: 'deposit_paid', amount_paid: '100.00', total_price: '1000.00' },
  });
  await voidExtrasInvoiceWithReconcile(77, 9001, client);
  assert.match(client.calls[0].text, /folded_into_total/, 'the invoice read selects the stored fact');
  const drops = totalDrops(client);
  assert.equal(drops.length, 1, 'the folded money comes back out');
  assert.deepEqual(drops[0].params, [60, 4242], '6000 cents, subtracted as dollars from the NUMERIC column');
  assert.ok(client.calls.some((c) => /SET status = 'void'/.test(c.text)), 'voided');
});

test('H1: an invoice stored as NOT folded with addon-looking lines (a fast-path mint) subtracts nothing', async () => {
  const client = scriptedClient({ invoice: unpaid({ folded_into_total: false }), lines: ADDON_LINES, afterVoid: null });
  await voidExtrasInvoiceWithReconcile(77, 9001, client);
  assert.equal(totalDrops(client).length, 0);
});

test('H1: a row minted before the column (NULL) keeps the line-shape classification', async () => {
  const bySyrup = scriptedClient({ invoice: unpaid({ folded_into_total: null }), lines: SYRUP_LINES, afterVoid: null });
  await voidExtrasInvoiceWithReconcile(77, 9001, bySyrup);
  assert.equal(totalDrops(bySyrup).length, 0);
  const byAddon = scriptedClient({
    invoice: unpaid({ folded_into_total: null }), lines: ADDON_LINES,
    afterVoid: { status: 'deposit_paid', amount_paid: '100.00', total_price: '1000.00' },
  });
  await voidExtrasInvoiceWithReconcile(77, 9001, byAddon);
  assert.equal(totalDrops(byAddon).length, 1);
});
