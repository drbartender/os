// server/utils/lineItemCancel.comp.test.js
'use strict';
// Cancelling a comped add-on (audit round 2, H1) through the REAL cancel core
// over a scripted transaction client, so it runs with no database. The
// scenario the verify pass traced: a booking paid in full at $1,000, a $100
// toast added through the drink plan and then comped (the comp line carries
// the toast's cents under the toast's catalog id), then the toast removed
// through cancel-line. Before this round the fold kept the comp line in both
// legs, priced Before = 1100 - 100 = 1000 and After = 1000 - 100 = 900, and
// applyLineItemCancel returned a 10000-cent overpayment the route then
// refunded. Now the fold's After leg drops the toast's comped cents with the
// toast: Before 1000, After 1000, overpayment 0, and the comp line leaves the
// row and the snapshot. The DB-backed sibling, in lineItemCancel.test.js,
// drives the same scenario against the shared dev DB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateProposal } = require('./pricingEngine');
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
// The comp line as compLine.js writes it, spelled out here so this suite
// reads the stored shape and not the writer.
const COMP = {
  type: 'discount', label: 'Drink Plan Extras comped (INV0042)', amount: 100, visible: true, source: 'comp',
  comped_addons: [{ addon_id: 42, cents: 10000 }],
};

function engine({ addons, adjustments }) {
  return calculateProposal({
    pkg: PKG, guestCount: 100, durationHours: 4, numBars: 0, numBartenders: null,
    addons, syrupSelections: [], adjustments, totalPriceOverride: null,
    gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
  });
}

// The row as the comp left it: total 1000 (1100 less the comp), paid in full.
function proposalRow() {
  const snapshot = engine({ addons: [{ ...TOAST, quantity: 1 }], adjustments: [COMP] });
  assert.equal(snapshot.total, 1000, 'fixture: 1000 + 100 toast - 100 comp');
  return {
    id: 77, client_id: 5, package_id: 1, status: 'balance_paid', total_price: '1000.00', amount_paid: '1000.00',
    external_paid: 0, total_price_override: null, guest_count: 100, event_duration_hours: '4.0', num_bars: 0,
    num_bartenders: null, gratuity_rate: 0, tip_jar: true, gratuity_floor_rate: null, event_date: '2027-06-12',
    event_start_time: '18:00', event_timezone: 'America/Chicago', adjustments: [COMP], pricing_snapshot: snapshot,
    updated_at: new Date('2026-11-01T12:00:00Z'),
  };
}

// The toast row as REPRICE_ADDON_SQL returns it (sa.* plus the pa_ aliases).
const repriceToast = () => ({
  ...TOAST, pa_quantity: '100', pa_line_total: '100.00', pa_rate: '1.00', pa_duration_hours: '4.0',
  pa_settled_added_hours: 0, pa_min_contracted_hours: null,
});

// A scripted transaction client for the cancel core's whole cascade. Matched
// by statement shape, specific before generic; an unknown statement rejects,
// so a new query in the core shows up here as a failure, never a silent pass.
function scriptedClient(row) {
  const calls = [];
  let toastDeleted = false;
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
        return answer({ rows: toastDeleted ? [] : [{
          id: 9001, addon_id: 42, addon_name: 'Test Toast', billing_type: 'per_guest', quantity: '100',
          slug: 'test-toast', minimum_hours: null,
        }] });
      }
      if (/FROM proposal_addons pa/.test(sql) && /JOIN service_addons sa/.test(sql)) {
        return answer({ rows: toastDeleted ? [] : [repriceToast()] });
      }
      if (/DELETE FROM proposal_addons WHERE id = \$1/.test(sql)) { toastDeleted = true; return answer({ rowCount: 1 }); }
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

test('cancelling the comped toast drops its comp with it: the total holds and nothing is overpaid', async () => {
  const row = proposalRow();
  const client = scriptedClient(row);
  const result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-toast', actorId: 9 });

  assert.equal(result.oldTotal, 1000);
  assert.equal(result.newTotal, 1000, 'Before 1100 - 100 comp; After no toast, no comp');
  assert.equal(result.overpaymentCents, 0, 'nothing to refund');
  assert.equal(result.removedLabel, 'Test Toast');
  assert.deepEqual(result.snapshot.adjustments, [], 'the comp left the snapshot with the toast');
  assert.equal(result.snapshot.addons.length, 0);

  // The fold wrote the column with the comp gone, in the same UPDATE as the total.
  const fold = client.calls.find((c) => /UPDATE proposals/.test(c.sql) && /total_price = \$1/.test(c.sql));
  assert.ok(fold, 'the fold wrote the row');
  assert.equal(Number(fold.params[0]), 1000);
  assert.match(fold.sql, /adjustments = COALESCE\(\$5::jsonb, adjustments\)/);
  assert.deepEqual(JSON.parse(fold.params[4]), []);
  assert.deepEqual(row.adjustments, [], 'the in-memory row follows');
  assert.equal(result.newStatus, 'balance_paid', 'still paid in full at the unchanged total');
  assert.ok(!client.calls.some((c) => /UPDATE proposals SET status/.test(c.sql)), 'no status move');
});

test('a comp whose add-on stays is kept whole, and a mixed comp keeps its bar and syrup remainder', async () => {
  // Two add-ons comped on one invoice with a $50 bar remainder; removing the
  // toast leaves the other add-on's cents and the remainder on the line.
  const OTHER = { ...TOAST, id: 43, slug: 'test-other', name: 'Test Other', rate: 0.5 };
  const mixed = {
    ...COMP, amount: 200, comped_addons: [{ addon_id: 42, cents: 10000 }, { addon_id: 43, cents: 5000 }],
  };
  const snapshot = engine({ addons: [{ ...TOAST, quantity: 1 }, { ...OTHER, quantity: 1 }], adjustments: [mixed] });
  const row = { ...proposalRow(), adjustments: [mixed], pricing_snapshot: snapshot, total_price: String(snapshot.total), amount_paid: String(snapshot.total) };
  const client = scriptedClient(row);
  // The reprice answer must carry both rows, the toast gone after its delete.
  let toastDeleted = false;
  const base = client.query;
  client.query = (sql, params) => {
    if (/DELETE FROM proposal_addons WHERE id = \$1/.test(sql)) toastDeleted = true;
    if (/FROM proposal_addons pa/.test(sql) && /JOIN service_addons sa/.test(sql)) {
      client.calls.push({ sql, params });
      const other = { ...repriceToast(), ...OTHER, pa_line_total: '50.00', pa_rate: '0.50' };
      return Promise.resolve({ rows: toastDeleted ? [other] : [repriceToast(), other] });
    }
    return base(sql, params);
  };
  const result = await applyLineItemCancel(client, { proposalId: 77, target: 'addon:test-toast', actorId: 9 });
  assert.equal(result.newTotal, result.oldTotal, 'the toast and its comped cents leave together');
  assert.equal(result.overpaymentCents, 0);
  assert.deepEqual(result.snapshot.adjustments, [{ ...mixed, amount: 100, comped_addons: [{ addon_id: 43, cents: 5000 }] }]);
});
