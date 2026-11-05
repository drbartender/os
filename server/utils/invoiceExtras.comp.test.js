// server/utils/invoiceExtras.comp.test.js
'use strict';
// The comp path of voidExtrasInvoiceWithReconcile (audit PRC-01) over a
// scripted transaction client, so it runs with no database: a comp must leave
// as a protected comp line, written with the snapshot and the totals in ONE
// proposals UPDATE, never as the bare `total_price = total_price - $1` that
// left pricing_snapshot.total and the add-on row behind; the line names what
// it comps by the identity each kind carries (the add-on by catalog id off the
// invoice line, the bar off its line, the syrup flavors off the drink plan)
// and is written at those items' price in the snapshot; the payment ladder
// still runs on the returned columns; the path-switch mode (reconcileTotalPrice
// false) and a syrup-only comp touch the proposal not at all. The DB-backed
// sibling, server/routes/invoices.extrasVoid.test.js, drives the real route.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { voidExtrasInvoiceWithReconcile } = require('./invoiceExtras');
const { COMP_LABEL } = require('./adjustmentRules');
const { calculateProposal } = require('./pricingEngine');

// A flat test package at $1,000, a $2-a-guest test toast, one bar, one syrup
// flavor at 75 guests (two bottles, $60): the fold's own snapshot.
const PKG = {
  id: 1, slug: 'test-flat', name: 'Test Package', category: 'byob', pricing_type: 'flat', bar_type: 'service_only',
  base_rate_4hr: 1000, base_rate_3hr: null, extra_hour_rate: 100, min_guests: 0, bartenders_included: 1,
  guests_per_bartender: 100, extra_bartender_hourly: 40, first_bar_fee: 50, additional_bar_fee: 100, min_total: null,
};
const TOAST = { id: 42, slug: 'test-toast', name: 'Test Toast', billing_type: 'per_guest', rate: 2, extra_hour_rate: null };
const snapshot = () => calculateProposal({
  pkg: PKG, guestCount: 75, durationHours: 4, numBars: 1, numBartenders: null,
  addons: [{ ...TOAST, quantity: 1 }], syrupSelections: ['mint'], adjustments: [],
  totalPriceOverride: null, gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
});

// The invoice's lines as writeExtrasLineItems writes them: source_id is
// service_addons.id on an addon line and null on a fee line.
const MIXED_LINES = [
  { description: 'Test Toast (75 guests)', line_total: 15000, source_type: 'addon', source_id: 42 },
  { description: 'Portable Bar Rental', line_total: 5000, source_type: 'fee', source_id: null },
  { description: 'Hand-Crafted Syrups (2 bottles)', line_total: 6000, source_type: 'fee', source_id: null },
];
const SYRUP_ONLY = [{ description: 'Hand-Crafted Syrups (2 bottles)', line_total: 6000, source_type: 'fee', source_id: null }];
const PLAN = { selections: { syrupSelections: { drink1: ['mint', 'ginger'] }, syrupSelfProvided: ['ginger'] } };

// Scripted by statement shape, so the fake answers the old code's statements
// too and the assertions, not a missing script, say what changed.
function scriptedClient({ lines, invoice, proposal, totalPrice, plan = PLAN }) {
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
      if (/FROM drink_plans WHERE proposal_id = \$1/.test(sql)) return answer({ rows: plan ? [plan] : [] });
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
  id: 501, proposal_id: 77, label: 'Drink Plan Extras', amount_due: 26000, amount_paid: 0, status: 'sent',
  invoice_number: 'INV0501', ...overrides,
});
const proposalRow = (overrides = {}) => ({
  id: 77, status: 'deposit_paid', amount_paid: '1000.00', adjustments: [], pricing_snapshot: snapshot(), ...overrides,
});
const proposalUpdates = (calls) => calls.filter((c) => /UPDATE proposals/.test(c.sql));

test('comp (reconcile mode): the comp leaves as a line naming the toast, the bar and the flavor, at their price, in one UPDATE with the snapshot and the totals', async () => {
  const snap = snapshot();
  assert.equal(Math.round(snap.total * 100), 126000, 'fixture: 1000 + 150 toast + 50 bar + 60 syrup');
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow(), proposal: proposalRow(), totalPrice: 1260 });
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
  assert.equal(upd.params[3], 26000, 'the items\' price in the snapshot: toast 15000 + bar 5000 + mint 6000, as cents');
  const lineRead = client.calls.find((c) => /FROM invoice_line_items WHERE invoice_id = \$1/.test(c.sql));
  assert.match(lineRead.sql, /source_id/, 'the add-on identity is read off the invoice lines');

  // The identity by kind: the add-on's catalog id, the bar, the flavor the
  // plan charged for (ginger was self-provided and is not named).
  const line = {
    type: 'discount', label: `${COMP_LABEL} (INV0501)`, amount: 260, visible: true, source: 'comp',
    comped: { addons: [42], bar: true, syrups: ['mint'] },
  };
  assert.deepEqual(JSON.parse(upd.params[1]), [line]);
  const written = JSON.parse(upd.params[2]);
  assert.deepEqual(written.adjustments, [line]);
  assert.equal(written.total, 1000, 'snapshot total moves with total_price: 1260 - 260');
  assert.deepEqual(written.breakdown[written.breakdown.length - 1], { label: line.label, amount: -260, visible: true });
  assert.equal(written.addons.length, 1, 'the comped add-on stays on the snapshot');

  // The ladder ran on the returned columns: paid 1000 now covers total 1000.
  const status = client.calls.find((c) => /UPDATE proposals SET status = \$1/.test(c.sql));
  assert.ok(status, 'the payment ladder re-ran');
  assert.deepEqual(status.params, ['balance_paid', 77]);

  // The void and the audit row are as before: the audit records what the invoice demanded.
  assert.ok(client.calls.some((c) => /UPDATE invoices SET status = 'void'/.test(c.sql) && c.params[0] === 501));
  const audit = client.calls.find((c) => /INSERT INTO proposal_activity_log/.test(c.sql));
  assert.deepEqual(JSON.parse(audit.params[3]), { amount_cents: 26000, invoice_id: 501, reason: 'comp' });
  assert.equal(audit.params[1], 'admin');
});

test('comp: the proposals row is locked before the money moves', async () => {
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow(), proposal: proposalRow(), totalPrice: 1260 });
  await voidExtrasInvoiceWithReconcile(501, 9, client, {});
  const idx = (re) => client.calls.findIndex((c) => re.test(c.sql));
  const lock = idx(/FROM proposals WHERE id = \$1 FOR UPDATE/);
  const money = idx(/total_price = GREATEST/);
  assert.ok(lock >= 0 && money > lock, 'FOR UPDATE read, then the UPDATE');
  const lockCall = client.calls.find((c) => /FROM proposals WHERE id = \$1 FOR UPDATE/.test(c.sql));
  assert.deepEqual(lockCall.params, [77]);
});

test('comp without a drink plan row: the syrup portion names no flavor and the comp is the toast and the bar', async () => {
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow(), proposal: proposalRow(), totalPrice: 1260, plan: null });
  await voidExtrasInvoiceWithReconcile(501, 9, client, {});
  const upd = proposalUpdates(client.calls).find((c) => /total_price = GREATEST/.test(c.sql));
  const line = JSON.parse(upd.params[1])[0];
  assert.deepEqual(line.comped, { addons: [42], bar: true, syrups: [] });
  assert.equal(upd.params[3], 20000);
});

test('syrup-only comp: void and audit only, the proposal is not touched', async () => {
  const client = scriptedClient({ lines: SYRUP_ONLY, invoice: invoiceRow({ amount_due: 6000 }), proposal: proposalRow(), totalPrice: 1000 });
  await voidExtrasInvoiceWithReconcile(501, 9, client, {});
  assert.equal(proposalUpdates(client.calls).length, 0);
  assert.ok(!client.calls.some((c) => /FROM proposals WHERE id = \$1 FOR UPDATE/.test(c.sql)));
  assert.ok(!client.calls.some((c) => /FROM drink_plans/.test(c.sql)));
});

test('path-switch mode (reconcileTotalPrice false): a pure void, no comp line, no proposal write', async () => {
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow(), proposal: proposalRow(), totalPrice: 1260 });
  await voidExtrasInvoiceWithReconcile(501, null, client, { reconcileTotalPrice: false, reason: 'resubmit_add_to_balance' });
  assert.equal(proposalUpdates(client.calls).length, 0);
  assert.ok(!client.calls.some((c) => /FROM proposals WHERE id = \$1 FOR UPDATE/.test(c.sql)));
  const audit = client.calls.find((c) => /INSERT INTO proposal_activity_log/.test(c.sql));
  assert.equal(JSON.parse(audit.params[3]).reason, 'resubmit_add_to_balance');
  assert.equal(audit.params[1], 'system');
});

test('a comp on a row whose lines cannot be read throws, so the caller rolls the void back', async () => {
  const client = scriptedClient({
    lines: MIXED_LINES, invoice: invoiceRow(), proposal: proposalRow({ adjustments: 'junk' }), totalPrice: 1260,
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
  const client = scriptedClient({ lines: MIXED_LINES, invoice: invoiceRow({ amount_paid: 100 }), proposal: proposalRow(), totalPrice: 1260 });
  await assert.rejects(() => voidExtrasInvoiceWithReconcile(501, 9, client, {}), (e) => e.code === 'INVOICE_HAS_PAYMENTS');
  assert.equal(client.calls.length, 1);
});
