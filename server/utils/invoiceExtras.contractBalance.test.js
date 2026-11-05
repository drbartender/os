// contractBalanceDueCents and its SQL twin (audit PAY-01, 2026-11-05).
//
// The contract balance due is total_price - amount_paid PLUS the money a
// proposal collected outside the contract (sumOffContractPaidCents): a paid
// syrup-only Drink Plan Extras invoice or a free-text manual invoice rolls into
// amount_paid and never into total_price, so the raw difference forgives the
// contract by that money. The report's cents: total 100000, deposit 10000,
// syrups 6000 -> 90000, not 84000.
//
// PURE: a scripted client answers the netting helper's two reads (the invoice
// list, then each extras invoice's lines) so the partition is pinned without a
// database. The SQL twin is pinned to the same labels and the same folded-lines
// predicate; its arithmetic runs on the dev box through
// balanceInvoiceMonitor.netting.test.js.
//
//   node --test server/utils/invoiceExtras.contractBalance.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  contractBalanceDueCents, sumOffContractPaidCents, offContractPaidCentsSql,
  NOT_OFF_CONTRACT_LABELS, IN_TOTAL_PRICE_LABELS,
} = require('./invoiceExtras');
const { OFF_LEDGER_INVOICE_LABELS } = require('./proposalMoneyShared');

const SYRUP_LINES = [
  { line_total: 3000, source_type: 'fee', description: 'Blackberry syrup' },
  { line_total: 3000, source_type: 'fee', description: 'Vanilla syrup' },
];
const FOLDED_LINES = [
  { line_total: 7500, source_type: 'addon', description: 'Banquet Server' },
  { line_total: 3000, source_type: 'fee', description: 'Blackberry syrup' },
];

// A client scripted on the two queries the helper runs. `invoices` is what the
// invoice read returns AFTER the SQL's own label filter would have applied,
// i.e. the test states which rows the database would hand back; the label
// filter itself is pinned separately below through the bound parameter.
function scriptedClient({ invoices = [], linesByInvoice = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (/FROM invoices/.test(text)) return { rows: invoices, rowCount: invoices.length };
      if (/FROM invoice_line_items/.test(text)) {
        const rows = linesByInvoice[params[0]] || [];
        return { rows, rowCount: rows.length };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

const ROW = { id: 4242, total_price: '1000.00', amount_paid: '160.00' };

test('the report: total 100000, paid 10000 deposit + 6000 syrup-only extras -> balance due 90000', async () => {
  const client = scriptedClient({
    invoices: [{ id: 77, label: 'Drink Plan Extras', amount_paid: 6000 }],
    linesByInvoice: { 77: SYRUP_LINES },
  });
  assert.equal(await contractBalanceDueCents(ROW, client), 90000);
});

test('no off-contract money: the balance is the raw difference', async () => {
  const client = scriptedClient();
  assert.equal(await contractBalanceDueCents(ROW, client), 84000);
});

test('a FOLDED extras invoice (an addon line) is contract money and is not netted', async () => {
  const client = scriptedClient({
    invoices: [{ id: 78, label: 'Drink Plan Extras', amount_paid: 10500 }],
    linesByInvoice: { 78: FOLDED_LINES },
  });
  assert.equal(await contractBalanceDueCents({ ...ROW, amount_paid: '205.00' }, client), 79500);
});

test('a paid free-text manual invoice is netted too (money law 5, the third kind)', async () => {
  const client = scriptedClient({
    invoices: [{ id: 79, label: 'Damage fee', amount_paid: 25000 }],
  });
  assert.equal(await contractBalanceDueCents({ ...ROW, amount_paid: '350.00' }, client), 90000);
});

test('signed: an overpaid contract reads negative, callers clamp', async () => {
  const client = scriptedClient();
  assert.equal(await contractBalanceDueCents({ ...ROW, amount_paid: '1040.00' }, client), -4000);
});

test('a NULL amount_paid or total_price reads as 0, never NaN', async () => {
  const client = scriptedClient();
  assert.equal(await contractBalanceDueCents({ id: 1, total_price: '1000.00', amount_paid: null }, client), 100000);
  assert.equal(await contractBalanceDueCents({ id: 1, total_price: null, amount_paid: null }, client), 0);
});

test('the netting read is keyed on the proposal id and skips exactly the in-contract and off-ledger labels', async () => {
  const client = scriptedClient();
  await sumOffContractPaidCents(4242, client);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].params[0], 4242);
  assert.deepEqual(client.calls[0].params[1], [...IN_TOTAL_PRICE_LABELS, ...OFF_LEDGER_INVOICE_LABELS]);
  assert.deepEqual([...NOT_OFF_CONTRACT_LABELS], [...IN_TOTAL_PRICE_LABELS, ...OFF_LEDGER_INVOICE_LABELS]);
  for (const label of ['Deposit', 'Balance', 'Full Payment', 'Additional Services', 'Enhancement Lab', 'Service Extension']) {
    assert.ok(NOT_OFF_CONTRACT_LABELS.includes(label), label);
  }
  assert.ok(!NOT_OFF_CONTRACT_LABELS.includes('Drink Plan Extras'));
});

test('the SQL twin carries the same partition: the bound skip list, the extras label and the folded-lines predicate', () => {
  const sql = offContractPaidCentsSql('p.id', '$2');
  assert.match(sql, /oc\.proposal_id = p\.id/);
  assert.match(sql, /ANY\(\$2::text\[\]\)/);
  assert.match(sql, /oc\.status <> 'void'/);
  assert.match(sql, /oc\.amount_paid > 0/);
  assert.match(sql, /oc\.label = 'Drink Plan Extras' AND COALESCE\(oc\.folded_into_total, EXISTS/);
  assert.match(sql, /ocl\.source_type = 'addon'/);
  assert.match(sql, /'Portable Bar Rental', 'Additional Portable Bar'/);
  assert.match(sql, /COALESCE\(\(/);
});

// ── The stored fold fact (round 2, H1) ────────────────────────────────────────
// A pay-now submit on the transaction path that adds no new add-on row (an
// upgrade already sold, plus two new syrups) folds the syrups into total_price
// yet mints an invoice with only a syrup line, which the line-shape heuristic
// reads as unfolded: the helper then added the 6000 back on top of a total that
// already held it (106000 - 16000 + 6000 = 96000 against 90000 owed). The
// submit now stores the fact on the invoice (invoices.folded_into_total) and
// the readers take it first, falling back to the line shape only on NULL.

test('H1: a paid extras invoice stored as folded, with only a syrup line, is contract money: 106000 - 16000 -> 90000, lines unread', async () => {
  const client = scriptedClient({
    invoices: [{ id: 80, label: 'Drink Plan Extras', amount_paid: 6000, folded_into_total: true }],
    linesByInvoice: { 80: SYRUP_LINES },
  });
  assert.equal(await contractBalanceDueCents({ id: 4242, total_price: '1060.00', amount_paid: '160.00' }, client), 90000);
  assert.ok(!client.calls.some((c) => /FROM invoice_line_items/.test(c.text)), 'the stored fact answers; no lines read');
});

test('H1: a paid extras invoice stored as NOT folded (the fast path) is netted even when its lines look folded', async () => {
  const client = scriptedClient({
    invoices: [{ id: 81, label: 'Drink Plan Extras', amount_paid: 6000, folded_into_total: false }],
    linesByInvoice: { 81: FOLDED_LINES },
  });
  assert.equal(await contractBalanceDueCents(ROW, client), 90000);
  assert.ok(!client.calls.some((c) => /FROM invoice_line_items/.test(c.text)), 'the stored fact answers; no lines read');
});

test('H1: a row minted before the column (NULL) is classified by its line shape, as before', async () => {
  const unfolded = scriptedClient({
    invoices: [{ id: 82, label: 'Drink Plan Extras', amount_paid: 6000, folded_into_total: null }],
    linesByInvoice: { 82: SYRUP_LINES },
  });
  assert.equal(await contractBalanceDueCents(ROW, unfolded), 90000);
  const folded = scriptedClient({
    invoices: [{ id: 83, label: 'Drink Plan Extras', amount_paid: 10500, folded_into_total: null }],
    linesByInvoice: { 83: FOLDED_LINES },
  });
  assert.equal(await contractBalanceDueCents({ ...ROW, amount_paid: '205.00' }, folded), 79500);
});

test('H1: the netting read carries the stored fact and the SQL twin reads it first, the line shape only on NULL', async () => {
  const client = scriptedClient();
  await sumOffContractPaidCents(4242, client);
  assert.match(client.calls[0].text, /folded_into_total/, 'the invoice read selects the stored fact');
  const sql = offContractPaidCentsSql('p.id', '$2');
  assert.match(sql, /oc\.label = 'Drink Plan Extras' AND COALESCE\(oc\.folded_into_total, EXISTS/);
});
