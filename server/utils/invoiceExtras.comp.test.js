// server/utils/invoiceExtras.comp.test.js
'use strict';
// The comp path of voidExtrasInvoiceWithReconcile (audit PRC-01) over a
// scripted transaction client, so it runs with no database: a comp must leave
// as a protected comp line written with the snapshot and the totals in ONE
// proposals UPDATE, never as the bare `total_price = total_price - $1` that
// left pricing_snapshot.total and the add-on row behind; the payment ladder
// still runs on the returned columns; the path-switch mode (reconcileTotalPrice
// false) and a syrup-only comp touch the proposal not at all. The DB-backed
// sibling, server/routes/invoices.extrasVoid.test.js, drives the real route.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { voidExtrasInvoiceWithReconcile } = require('./invoiceExtras');
const { COMP_LABEL } = require('./adjustmentRules');

// source_id is service_addons.id on an addon line and null on a fee line, as
// writeExtrasLineItems writes them.
const MIXED_LINES = [
  { description: 'Champagne Toast (75 guests)', line_total: 20000, source_type: 'addon', source_id: 42 },
  { description: 'Portable Bar Rental', line_total: 5000, source_type: 'fee', source_id: null },
  { description: 'Hand-Crafted Syrups (2 bottles)', line_total: 6000, source_type: 'fee', source_id: null },
];
const SYRUP_ONLY = [{ description: 'Hand-Crafted Syrups (2 bottles)', line_total: 6000, source_type: 'fee', source_id: null }];

const snapshot = () => ({
  package: { name: 'Test Package', base_cost: 1000 },
  breakdown: [{ label: 'Test Package (4hrs, 75 guests)', amount: 1000 }, { label: 'Champagne Toast (75 guests)', amount: 200 },
    { label: 'Bar Rental (1 bar)', amount: 50 }, { label: 'Handcrafted Syrups (2 bottles)', amount: 60 }],
  adjustments: [],
  addons: [{ id: 42, slug: 'champagne-toast', name: 'Champagne Toast', billing_type: 'per_guest', rate: 2.5, quantity: 75, line_total: 200 }],
  gratuity: { total: 0 },
  subtotal: 1310,
  total: 1310,
});

// Scripted by statement shape, so the fake answers the old code's statements
// too and the assertions, not a missing script, say what changed.
function scriptedClient({ lines, invoice, proposal, totalPrice }) {
  const calls = [];
  return {
    calls,
    query: (sql, params) => {
      calls.push({ sql, params });
      const answer = (v) => Promise.resolve(v);
      if (/FROM invoices WHERE id = \$1/.test(sql)) return answer({ rows: [invoice] });
      if (/UPDATE invoices SET status = 'void'/.test(sql)) return answer({ rowCount: 1 });
      if (/INSERT INTO proposal_activity_log/.test(sql)) return answer({ rowCount: 1 });
      if (/FROM invoice_line_items WHERE invoice_id = \$1/.test(sql)) return answer({ rows: lines });
      if (/SELECT id, adjustments, pricing_snapshot FROM proposals WHERE id = \$1 FOR UPDATE/.test(sql)) return answer({ rows: [proposal] });
      if (/UPDATE proposals SET status = \$1/.test(sql)) return answer({ rowCount: 1 });
      if (/UPDATE proposals SET autopay_status = NULL/.test(sql)) return answer({ rowCount: 1 });
      if (/UPDATE proposals/.test(sql)) {
        // The money columns after the statement's own arithmetic. The old
        // statement sends dollars as $1; the comp line sends cents as $4.
        const dropCents = /\$4 \/ 100\.0/.test(sql) ? params[3] : Math.round(Number(params[0]) * 100);
        const total = Math.max(0, Math.round(totalPrice * 100) - dropCents) / 100;
        return answer({ rowCount: 1, rows: [{ status: proposal.status, amount_paid: proposal.amount_paid, total_price: total.toFixed(2) }] });
      }
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    },
  };
}

const invoiceRow = (overrides = {}) => ({
  id: 501, proposal_id: 77, label: 'Drink Plan Extras', amount_due: 31000, amount_paid: 0, status: 'sent',
  invoice_number: 'INV0501', ...overrides,
});
const proposalRow = (overrides = {}) => ({
  id: 77, status: 'deposit_paid', amount_paid: '1000.00', adjustments: [], pricing_snapshot: snapshot(), ...overrides,
});
const proposalUpdates = (calls) => calls.filter((c) => /UPDATE proposals/.test(c.sql));

test('comp (reconcile mode): the folded cents leave as a comp line in one UPDATE with the snapshot and the totals, never a bare subtraction', async () => {
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow(), proposal: proposalRow(), totalPrice: 1310 });
  const out = await voidExtrasInvoiceWithReconcile(501, 9, client, {});
  assert.equal(out.id, 501);

  for (const c of client.calls) {
    assert.doesNotMatch(c.sql, /total_price = total_price - \$1/, 'the bare subtraction is gone');
  }
  const money = proposalUpdates(client.calls).filter((c) => /total_price = GREATEST/.test(c.sql));
  assert.equal(money.length, 1, 'exactly one money UPDATE on the proposal');
  const upd = money[0];
  assert.match(upd.sql, /adjustments = \$2::jsonb/);
  assert.match(upd.sql, /pricing_snapshot = COALESCE\(\$3::jsonb, pricing_snapshot\)/);
  assert.equal(upd.params[0], 77);
  assert.equal(upd.params[3], 31000, 'the WHOLE folded extras (add-on + bar + syrup), as cents');
  const lineRead = client.calls.find((c) => /FROM invoice_line_items WHERE invoice_id = \$1/.test(c.sql));
  assert.match(lineRead.sql, /source_id/, 'the add-on identity is read off the invoice lines');

  // The comp is tied to the add-on it waived (audit round 2, H1): the invoice's
  // addon line's catalog id and cents; the bar and syrup lines name none.
  const line = {
    type: 'discount', label: `${COMP_LABEL} (INV0501)`, amount: 310, visible: true, source: 'comp',
    comped_addons: [{ addon_id: 42, cents: 20000 }],
  };
  assert.deepEqual(JSON.parse(upd.params[1]), [line]);
  const snap = JSON.parse(upd.params[2]);
  assert.deepEqual(snap.adjustments, [line]);
  assert.equal(snap.total, 1000, 'snapshot total moves with total_price: 1310 - 310');
  assert.deepEqual(snap.breakdown[4], { label: line.label, amount: -310, visible: true });
  assert.equal(snap.addons.length, 1, 'the comped add-on stays on the snapshot');

  // The ladder ran on the returned columns: paid 1000 now covers total 1000.
  const status = client.calls.find((c) => /UPDATE proposals SET status = \$1/.test(c.sql));
  assert.ok(status, 'the payment ladder re-ran');
  assert.deepEqual(status.params, ['balance_paid', 77]);

  // The void and the audit row are as before.
  assert.ok(client.calls.some((c) => /UPDATE invoices SET status = 'void'/.test(c.sql) && c.params[0] === 501));
  const audit = client.calls.find((c) => /INSERT INTO proposal_activity_log/.test(c.sql));
  assert.deepEqual(JSON.parse(audit.params[3]), { amount_cents: 31000, invoice_id: 501, reason: 'comp' });
  assert.equal(audit.params[1], 'admin');
});

test('comp: the proposals row is locked before the money moves', async () => {
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow(), proposal: proposalRow(), totalPrice: 1310 });
  await voidExtrasInvoiceWithReconcile(501, 9, client, {});
  const idx = (re) => client.calls.findIndex((c) => re.test(c.sql));
  const lock = idx(/FROM proposals WHERE id = \$1 FOR UPDATE/);
  const money = idx(/total_price = GREATEST/);
  assert.ok(lock >= 0 && money > lock, 'FOR UPDATE read, then the UPDATE');
  const lockCall = client.calls.find((c) => /FROM proposals WHERE id = \$1 FOR UPDATE/.test(c.sql));
  assert.deepEqual(lockCall.params, [77]);
});

test('syrup-only comp: void and audit only, the proposal is not touched', async () => {
  const client = scriptedClient({ lines: SYRUP_ONLY, invoice: invoiceRow({ amount_due: 6000 }), proposal: proposalRow(), totalPrice: 1000 });
  await voidExtrasInvoiceWithReconcile(501, 9, client, {});
  assert.equal(proposalUpdates(client.calls).length, 0);
  assert.ok(!client.calls.some((c) => /FROM proposals WHERE id = \$1 FOR UPDATE/.test(c.sql)));
});

test('path-switch mode (reconcileTotalPrice false): a pure void, no comp line, no proposal write', async () => {
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow(), proposal: proposalRow(), totalPrice: 1310 });
  await voidExtrasInvoiceWithReconcile(501, null, client, { reconcileTotalPrice: false, reason: 'resubmit_add_to_balance' });
  assert.equal(proposalUpdates(client.calls).length, 0);
  assert.ok(!client.calls.some((c) => /FROM proposals WHERE id = \$1 FOR UPDATE/.test(c.sql)));
  const audit = client.calls.find((c) => /INSERT INTO proposal_activity_log/.test(c.sql));
  assert.equal(JSON.parse(audit.params[3]).reason, 'resubmit_add_to_balance');
  assert.equal(audit.params[1], 'system');
});

test('a comp on a row whose lines cannot be read throws, so the caller rolls the void back', async () => {
  const client = scriptedClient({
    lines: MIXED_LINES, invoice: invoiceRow(), proposal: proposalRow({ adjustments: 'junk' }), totalPrice: 1310,
  });
  await assert.rejects(() => voidExtrasInvoiceWithReconcile(501, 9, client, {}), (e) => e.code === 'COMP_LINE_UNWRITABLE');
  assert.equal(proposalUpdates(client.calls).length, 0, 'no money moved');
});

test('an already-void invoice is idempotent: nothing is written', async () => {
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow({ status: 'void' }), proposal: proposalRow(), totalPrice: 1000 });
  const out = await voidExtrasInvoiceWithReconcile(501, 9, client, {});
  assert.equal(out.status, 'void');
  assert.equal(client.calls.length, 1, 'the invoice read only');
});

test('a paid invoice is refused before any write', async () => {
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow({ amount_paid: 100 }), proposal: proposalRow(), totalPrice: 1310 });
  await assert.rejects(() => voidExtrasInvoiceWithReconcile(501, 9, client, {}), (e) => e.code === 'INVOICE_HAS_PAYMENTS');
  assert.equal(client.calls.length, 1);
});
