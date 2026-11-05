// The stored fold fact on a Drink Plan Extras invoice (round 2, H1, 2026-11-05).
//
// THE DEFECT. Whether an extras invoice's money sits inside total_price was
// read from its line shape (an addon or bar line = folded), but a pay-now
// submit on the transaction path that adds no NEW add-on row (an upgrade
// already sold, plus two new syrups) folds the syrups and mints an invoice
// with only a syrup line: every reader then called it unfolded and the client
// was charged the 6000 twice. Money law 5: provenance is stored, never read
// off a label or a line shape. The minters now write invoices.folded_into_total
// (the transaction path true, the fast path false; the out-of-order webhook
// mint leaves it NULL and the submit stamps it when it runs).
//
// PURE: a scripted transaction client records every statement; the create
// path's invoice number and INSERT are answered by shape.
//
//   node --test server/utils/invoiceExtras.foldFact.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDrinkPlanExtrasInvoice, findOrRefreshExtrasInvoice } = require('./invoiceExtras');

const SYRUP_LINE = { description: 'Hand-Crafted Syrups (2 bottles)', quantity: 1, unit_price: 6000, line_total: 6000, source_type: 'fee', source_id: null };

function scriptedClient({ existing = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(text, params) {
      calls.push({ text, params });
      if (/nextval\('invoice_number_seq'\)/.test(text)) return { rows: [{ val: 42 }], rowCount: 1 };
      if (/INSERT INTO invoices/.test(text)) {
        return { rows: [{ id: 900, proposal_id: params[0], label: params[2], amount_due: params[3], status: params[4] }], rowCount: 1 };
      }
      if (/FROM invoices\s+WHERE proposal_id = \$1 AND label = 'Drink Plan Extras'/.test(text)) {
        return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}
const stamps = (client) => client.calls.filter((c) => /UPDATE invoices SET folded_into_total/.test(c.text));
const amountWrites = (client) => client.calls.filter((c) => /UPDATE invoices SET amount_due/.test(c.text));
const lineWrites = (client) => client.calls.filter((c) => /INSERT INTO invoice_line_items/.test(c.text));

const breakdown = { totalCents: 6000, lines: [SYRUP_LINE], folded: true };
const args = (client, over = {}) => ({
  proposalId: 4242, drinkPlanId: 55, breakdown, selections: {}, guestCount: 50, pricingSnapshot: {}, numBars: 0, ...over,
});

test('create: the fact is written on the new invoice and the row carries it', async () => {
  const client = scriptedClient();
  const inv = await createDrinkPlanExtrasInvoice(
    { proposalId: 4242, drinkPlanId: 55, extrasAmountCents: 6000, lineItemState: { lines: [SYRUP_LINE] }, foldedIntoTotal: true },
    client
  );
  assert.equal(inv.folded_into_total, true);
  const s = stamps(client);
  assert.equal(s.length, 1, 'one provenance write');
  assert.deepEqual(s[0].params, [true, 900]);
});

test('create without the fact (the out-of-order webhook mint, the backfill): nothing is stamped, the column stays NULL', async () => {
  const client = scriptedClient();
  await createDrinkPlanExtrasInvoice(
    { proposalId: 4242, drinkPlanId: 55, extrasAmountCents: 6000, lineItemState: { lines: [SYRUP_LINE] } },
    client
  );
  assert.equal(stamps(client).length, 0);
});

test('find-or-refresh, no existing invoice: the create carries the fact (the fast path writes false)', async () => {
  const client = scriptedClient();
  await findOrRefreshExtrasInvoice(args(client, { foldedIntoTotal: false }), client);
  const s = stamps(client);
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].params, [false, 900]);
});

test('find-or-refresh, an open unlocked invoice: the refresh rewrites the demand, the lines and the fact', async () => {
  const client = scriptedClient({ existing: { id: 77, label: 'Drink Plan Extras', status: 'sent', locked: false, amount_due: 2500, amount_paid: 0, folded_into_total: false } });
  await findOrRefreshExtrasInvoice(args(client, { foldedIntoTotal: true }), client);
  assert.equal(amountWrites(client).length, 1);
  assert.match(amountWrites(client)[0].text, /folded_into_total/);
  assert.deepEqual(amountWrites(client)[0].params, [6000, true, 77]);
  assert.equal(lineWrites(client).length, 1);
});

test('find-or-refresh, a paid locked invoice (the webhook settled it first): only the fact is stamped, never the demand or the lines', async () => {
  const client = scriptedClient({ existing: { id: 78, label: 'Drink Plan Extras', status: 'paid', locked: true, amount_due: 6000, amount_paid: 6000, folded_into_total: null } });
  const inv = await findOrRefreshExtrasInvoice(args(client, { foldedIntoTotal: true }), client);
  assert.equal(inv.id, 78);
  assert.equal(amountWrites(client).length, 0, 'a paid invoice is never re-priced');
  assert.equal(lineWrites(client).length, 0, 'its lines stand');
  const s = stamps(client);
  assert.equal(s.length, 1, 'the provenance the submit decided is recorded');
  assert.deepEqual(s[0].params, [true, 78]);
});

test('find-or-refresh, a paid locked invoice already carrying the same fact: nothing is written', async () => {
  const client = scriptedClient({ existing: { id: 79, label: 'Drink Plan Extras', status: 'paid', locked: true, amount_due: 6000, amount_paid: 6000, folded_into_total: true } });
  await findOrRefreshExtrasInvoice(args(client, { foldedIntoTotal: true }), client);
  assert.equal(stamps(client).length, 0);
});

// ── The stored fact is monotone upward (round 3, L1) ─────────────────────────
// A re-submit through the fast path onto an open invoice stamped false over a
// stored true while the earlier fold's 6000 stayed in total_price, so once
// paid the netting added the 6000 back. Money is in total_price until a fold
// takes it out, which the fast path never does: a true is never overwritten by
// false; a NULL or a false takes the caller's value.
test('L1: an open invoice stored NULL takes the caller\'s false', async () => {
  const client = scriptedClient({ existing: { id: 80, label: 'Drink Plan Extras', status: 'sent', locked: false, amount_due: 2500, amount_paid: 0, folded_into_total: null } });
  await findOrRefreshExtrasInvoice(args(client, { foldedIntoTotal: false }), client);
  assert.deepEqual(amountWrites(client)[0].params, [6000, false, 80]);
});

test('L1: an open invoice stored false takes the caller\'s true (the fold ran this time)', async () => {
  const client = scriptedClient({ existing: { id: 81, label: 'Drink Plan Extras', status: 'sent', locked: false, amount_due: 2500, amount_paid: 0, folded_into_total: false } });
  const inv = await findOrRefreshExtrasInvoice(args(client, { foldedIntoTotal: true }), client);
  assert.deepEqual(amountWrites(client)[0].params, [6000, true, 81]);
  assert.equal(inv.folded_into_total, true);
});

test('L1: an open invoice stored true keeps true on a fast-path re-submit that says false', async () => {
  const client = scriptedClient({ existing: { id: 82, label: 'Drink Plan Extras', status: 'sent', locked: false, amount_due: 2500, amount_paid: 0, folded_into_total: true } });
  const inv = await findOrRefreshExtrasInvoice(args(client, { foldedIntoTotal: false }), client);
  assert.deepEqual(amountWrites(client)[0].params, [6000, true, 82], 'the demand and the lines refresh; the fact stands');
  assert.equal(inv.folded_into_total, true);
});

test('L1: a paid locked invoice stored true is never stamped false either', async () => {
  const client = scriptedClient({ existing: { id: 83, label: 'Drink Plan Extras', status: 'paid', locked: true, amount_due: 6000, amount_paid: 6000, folded_into_total: true } });
  await findOrRefreshExtrasInvoice(args(client, { foldedIntoTotal: false }), client);
  assert.equal(stamps(client).length, 0);
});
