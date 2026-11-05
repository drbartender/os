// server/utils/lineItemCancel.comp.test.js
'use strict';
// Cancelling a comped item (audit PRC-01, rounds 2 and 3) through the REAL
// cancel core over a scripted transaction client, so it runs with no
// database. A booking paid in full at $1,000, items added through the drink
// plan and comped (the comp line names them: the toast by catalog id, the bar,
// the syrups by flavor), then one of them removed through cancel-line. The
// fold's After leg prices the comp at the price of the comped items still
// present (compLine.js), so Before and After agree, the total holds,
// applyLineItemCancel reports no overpayment and the route refunds nothing.
// Before round 2 the comp line was netted in both legs (After priced $100
// lower, a 10000-cent refund of money never paid); before round 3 a comped
// bar or syrup had no identity and did the same. The DB-backed sibling, in
// lineItemCancel.test.js, drives the toast case against the shared dev DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateProposal, calculateSyrupCost } = require('./pricingEngine');
const { applyLineItemCancel } = require('./lineItemCancel');

// A flat test package at $1,000 and a $1-a-guest test toast: engine fixtures
// in the shape the catalog rows take (pricingEngine.test.js).
const PKG = {
  id: 1, slug: 'test-flat', name: 'Test Package', category: 'byob', pricing_type: 'flat', bar_type: 'service_only',
  base_rate_4hr: 1000, base_rate_3hr: null, extra_hour_rate: 100, min_guests: 0, bartenders_included: 1,
  guests_per_bartender: 100, extra_bartender_hourly: 40, first_bar_fee: 50, additional_bar_fee: 100, min_total: null,
};
const TOAST = {
  id: 42, slug: 'test-toast', name: 'Test Toast', billing_type: 'per_guest', rate: 1, extra_hour_rate: null,
  applies_to: 'all', is_active: true, minimum_hours: null,
};
const cents = (n) => Math.round(Number(n) * 100);
// The comp line as compLine.js writes it, spelled out here so this suite
// reads the stored shape and not the writer.
const comp = (amount, comped) => ({
  type: 'discount', label: 'Drink Plan Extras comped (INV0042)', amount, visible: true, source: 'comp',
  comped: { addons: [], bar: false, syrups: [], ...comped },
});

function engine({ addons = [], adjustments = [], numBars = 0, syrups = [] }) {
  return calculateProposal({
    pkg: PKG, guestCount: 100, durationHours: 4, numBars, numBartenders: null,
    addons, syrupSelections: syrups, adjustments, totalPriceOverride: null,
    gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
  });
}

// The row as the comp left it: paid in full at the comped total.
function proposalRow({ addons = [], numBars = 0, syrups = [], adjustments }) {
  const snapshot = engine({ addons: addons.map((a) => ({ ...a, quantity: 1 })), adjustments, numBars, syrups });
  return {
    id: 77, client_id: 5, package_id: 1, status: 'balance_paid', total_price: snapshot.total.toFixed(2),
    amount_paid: snapshot.total.toFixed(2), external_paid: 0, total_price_override: null, guest_count: 100,
    event_duration_hours: '4.0', num_bars: numBars, num_bartenders: null, gratuity_rate: 0, tip_jar: true,
    gratuity_floor_rate: null, event_date: '2027-06-12', event_start_time: '18:00', event_timezone: 'America/Chicago',
    adjustments, pricing_snapshot: snapshot, updated_at: new Date('2026-11-01T12:00:00Z'),
  };
}

// An add-on row as REPRICE_ADDON_SQL returns it (sa.* plus the pa_ aliases),
// priced at 100 guests.
const repriceRow = (addon) => ({
  ...addon, pa_quantity: '100', pa_line_total: (100 * addon.rate).toFixed(2), pa_rate: Number(addon.rate).toFixed(2),
  pa_duration_hours: '4.0', pa_settled_added_hours: 0, pa_min_contracted_hours: null,
});

// A scripted transaction client for the cancel core's whole cascade. Matched
// by statement shape, specific before generic; an unknown statement rejects,
// so a new query in the core shows up here as a failure, never a silent pass.
function scriptedClient(row, { addons = [] } = {}) {
  const calls = [];
  let present = addons.map((a) => a.slug);
  let totalPrice = row.total_price;
  const answer = (v) => Promise.resolve(v);
  return {
    calls,
    query: (sql, params) => {
      calls.push({ sql, params });
      if (/FROM proposals WHERE id = \$1 FOR UPDATE/.test(sql)) return answer({ rows: [row] });
      if (/FROM service_extensions/.test(sql)) return answer({ rows: [] });
      if (/FROM service_packages WHERE id = \$1/.test(sql)) return answer({ rows: [PKG] });
      if (/sa\.slug = \$2/.test(sql)) {
        const a = addons.find((x) => x.slug === params[1] && present.includes(x.slug));
        return answer({ rows: a ? [{
          id: 9000 + a.id, addon_id: a.id, addon_name: a.name, billing_type: a.billing_type, quantity: '100',
          slug: a.slug, minimum_hours: null,
        }] : [] });
      }
      if (/FROM proposal_addons pa/.test(sql) && /JOIN service_addons sa/.test(sql)) {
        return answer({ rows: addons.filter((a) => present.includes(a.slug)).map(repriceRow) });
      }
      if (/DELETE FROM proposal_addons WHERE id = \$1/.test(sql)) {
        present = present.filter((slug) => 9000 + addons.find((a) => a.slug === slug).id !== params[0]);
        return answer({ rowCount: 1 });
      }
      if (/UPDATE proposals SET num_bars = \$1/.test(sql)) return answer({ rowCount: 1 });
      if (/FROM drink_plans/.test(sql)) return answer({ rows: [] });
      if (/UPDATE proposals/.test(sql) && /total_price = \$1/.test(sql)) {
        totalPrice = Number(params[0]).toFixed(2);
        return answer({ rowCount: 1 });
      }
      if (/UPDATE proposals SET status/.test(sql)) return answer({ rowCount: 1 });
      if (/INSERT INTO proposal_activity_log/.test(sql)) return answer({ rowCount: 1 });
      if (/SELECT total_price, deposit_amount, external_paid FROM proposals/.test(sql)) {
        return answer({ rows: [{ total_price: totalPrice, deposit_amount: '100.00', external_paid: 0 }] });
      }
      if (/AS locked_total/.test(sql)) return answer({ rows: [{ locked_total: '100000' }] });
      if (/SELECT COUNT\(\*\)::int AS n FROM shifts/.test(sql)) return answer({ rows: [{ n: 0 }] });
      if (/FROM invoices/.test(sql)) return answer({ rows: [] });
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    },
  };
}

function foldWrite(client) {
  const fold = client.calls.find((c) => /UPDATE proposals/.test(c.sql) && /total_price = \$1/.test(c.sql));
  assert.ok(fold, 'the fold wrote the row');
  assert.match(fold.sql, /adjustments = COALESCE\(\$5::jsonb, adjustments\)/);
  return { total: Number(fold.params[0]), lines: fold.params[4] === null ? null : JSON.parse(fold.params[4]) };
}

test('H1: cancelling the comped toast drops its comp with it: the total holds and nothing is overpaid', async () => {
  const row = proposalRow({ addons: [TOAST], adjustments: [comp(100, { addons: [42] })] });
  assert.equal(cents(row.total_price), 100000, 'fixture: 1000 + 100 toast - 100 comp');
  const client = scriptedClient(row, { addons: [TOAST] });
  const result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-toast', actorId: 9 });

  assert.equal(result.oldTotal, 1000);
  assert.equal(result.newTotal, 1000, 'Before 1100 - 100 comp; After no toast, no comp');
  assert.equal(result.overpaymentCents, 0, 'nothing to refund');
  assert.equal(result.removedLabel, 'Test Toast');
  assert.deepEqual(result.snapshot.adjustments, [], 'the comp left the snapshot with the toast');
  assert.equal(result.snapshot.addons.length, 0);
  const wrote = foldWrite(client);
  assert.equal(wrote.total, 1000);
  assert.deepEqual(wrote.lines, [], 'the column follows, in the same UPDATE as the total');
  assert.deepEqual(row.adjustments, [], 'the in-memory row follows');
  assert.equal(result.newStatus, 'balance_paid', 'still paid in full at the unchanged total');
  assert.ok(!client.calls.some((c) => /UPDATE proposals SET status/.test(c.sql)), 'no status move');
});

test('a mixed comp (toast and bar) keeps the bar comped when the toast is cancelled', async () => {
  const row = proposalRow({ addons: [TOAST], numBars: 1, adjustments: [comp(150, { addons: [42], bar: true })] });
  assert.equal(cents(row.total_price), 100000, 'fixture: 1000 + 100 toast + 50 bar - 150 comp');
  const client = scriptedClient(row, { addons: [TOAST] });
  const result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-toast', actorId: 9 });
  assert.equal(result.newTotal, result.oldTotal, 'the toast and its comped price leave together');
  assert.equal(result.overpaymentCents, 0);
  assert.deepEqual(result.snapshot.adjustments, [comp(50, { addons: [42], bar: true })], 'the bar is still comped, at its fee');
  assert.deepEqual(foldWrite(client).lines, [comp(50, { addons: [42], bar: true })]);
});

test('H2 bar: cancelling the comped bar drops its comp with it: the total holds and nothing is overpaid', async () => {
  const row = proposalRow({ numBars: 1, adjustments: [comp(50, { bar: true })] });
  assert.equal(cents(row.total_price), 100000, 'fixture: 1000 + 50 bar - 50 comp');
  const client = scriptedClient(row);
  const result = await applyLineItemCancel(client, { proposalId: 77, target: 'bar', actorId: 9 });
  assert.equal(result.oldTotal, 1000);
  assert.equal(result.newTotal, 1000, 'Before 1050 - 50 comp; After no bar, no comp');
  assert.equal(result.overpaymentCents, 0, 'no 5000-cent refund');
  assert.deepEqual(result.snapshot.adjustments, []);
  assert.equal(result.snapshot.bar_rental.total, 0);
  assert.ok(client.calls.some((c) => /UPDATE proposals SET num_bars = \$1/.test(c.sql) && c.params[0] === 0));
  assert.deepEqual(foldWrite(client).lines, []);
});

test('H2 syrups: cancelling one of two comped flavors takes exactly that flavor\'s price off the comp: the total holds', async () => {
  // At 100 guests two bottles a flavor: mint and ginger are 4 bottles, a
  // 3-pack and a single, $105; ginger alone is 2 singles, $60.
  const both = cents(calculateSyrupCost(['mint', 'ginger'], 100).total);
  const gingerAlone = cents(calculateSyrupCost(['ginger'], 100).total);
  assert.equal(both, 10500);
  assert.equal(gingerAlone, 6000);
  const row = proposalRow({ syrups: ['mint', 'ginger'], adjustments: [comp(both / 100, { syrups: ['mint', 'ginger'] })] });
  assert.equal(cents(row.total_price), 100000, 'fixture: 1000 + 105 syrups - 105 comp');
  const client = scriptedClient(row);
  const result = await applyLineItemCancel(client, { proposalId: 77, target: 'syrup:mint', actorId: 9 });
  assert.equal(result.newTotal, 1000, 'Before 1105 - 105; After 1060 - 60');
  assert.equal(result.overpaymentCents, 0);
  assert.deepEqual(result.snapshot.syrups.selections, ['ginger']);
  assert.deepEqual(result.snapshot.adjustments, [comp(gingerAlone / 100, { syrups: ['mint', 'ginger'] })],
    'the comp dropped by exactly mint\'s price in the set (105 - 60 = 45)');
  assert.deepEqual(foldWrite(client).lines, result.snapshot.adjustments);
});
