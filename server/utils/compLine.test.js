// server/utils/compLine.test.js
'use strict';
// The comp line writer (audit PRC-01), pure: the caller's transaction client
// is a scripted fake, so this runs with no database. It pins what the one
// UPDATE carries: the line itself (whole cents, source 'comp', protected by
// the shared rule), the same cents off proposals.adjustments' twin in the
// snapshot, the snapshot total and total_price, the override moved alongside,
// and the refusals (a held booking, an unreadable line list, a bad amount).
// A legal hold is ADDED through __setLegalHoldIdsForTest on a synthetic id;
// nothing here reads or writes a real held booking.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { appendCompLine, compLineFor, netCompLinesAgainstAddons } = require('./compLine');
const { isProtectedAdjustment, validateAdjustments, COMP_LABEL } = require('./adjustmentRules');
const { __setLegalHoldIdsForTest } = require('./legalHold');
const { GRATUITY_LABEL, SHARED_GRATUITY_LABEL } = require('./gratuityLabels');

after(() => __setLegalHoldIdsForTest(null));

const DISCOUNT_A = { type: 'discount', label: 'Test discount A', amount: 50, visible: true };
// Package, a staffing Shared Gratuity row, the comped add-on, an ordinary
// discount and the client Gratuity row (gratuity 40), in the engine's order.
const fullSnapshot = () => ({
  package: { name: 'Test Package', base_cost: 1000 },
  breakdown: [
    { label: 'Test Package (4hrs, 120 guests)', amount: 1000 },
    { label: SHARED_GRATUITY_LABEL, amount: 100 },
    { label: 'Test Add-on A (120 guests)', amount: 300 },
    { label: 'Test discount A', amount: -50 },
    { label: GRATUITY_LABEL, amount: 40 },
  ],
  adjustments: [DISCOUNT_A],
  addons: [{ id: 42, slug: 'test-add-on-a', name: 'Test Add-on A', billing_type: 'per_guest', rate: 2.5, quantity: 120, line_total: 300 }],
  gratuity: { rate: 10, tip_jar: true, staff_count: 1, hours: 4, staff_noun: 'bartender', total: 40, floor_rate: null },
  subtotal: 1400,
  total: 1390,
});

// A scripted transaction client: the FOR UPDATE read answers with `row`, the
// UPDATE records its SQL and params and answers with the row's money columns
// after the SQL arithmetic the real statement does (dollars, floored at 0).
function fakeClient(row, { totalPrice = 1390, override = null, amountPaid = 1390, status = 'balance_paid' } = {}) {
  const calls = [];
  return {
    calls,
    query: (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id, adjustments, pricing_snapshot FROM proposals WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return Promise.resolve({ rows: row ? [row] : [] });
      }
      if (/UPDATE proposals/.test(sql)) {
        const cents = params[3];
        const total = Math.max(0, Math.round(totalPrice * 100) - cents) / 100;
        return Promise.resolve({
          rowCount: 1,
          rows: [{ status, amount_paid: amountPaid.toFixed(2), total_price: total.toFixed(2),
            total_price_override: override === null ? null : Math.max(0, Math.round(override * 100) - cents) / 100 }],
        });
      }
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    },
  };
}

test('compLineFor is a whole-cent, visible, protected discount the editor validator accepts unchanged', () => {
  const line = compLineFor({ compCents: 31000, invoiceNumber: 'INV0001' });
  assert.deepEqual(line, { type: 'discount', label: `${COMP_LABEL} (INV0001)`, amount: 310, visible: true, source: 'comp' });
  assert.equal(isProtectedAdjustment(line), true);
  assert.deepEqual(validateAdjustments([line]).value, [line]);
  assert.equal(compLineFor({ compCents: 1 }).label, COMP_LABEL, 'no invoice number: the bare label');
  assert.equal(compLineFor({ compCents: 1 }).amount, 0.01);
  // The comped add-ons ride on the line (audit round 2, H1), in the invoice
  // line items' own identity: service_addons.id and that line's cents.
  const tied = compLineFor({ compCents: 31000, invoiceNumber: 'INV0001', compedAddons: [{ addon_id: 42, cents: 20000 }] });
  assert.deepEqual(tied.comped_addons, [{ addon_id: 42, cents: 20000 }]);
  assert.deepEqual(validateAdjustments([tied]).value, [tied], 'a later editor save keeps the tie');
  assert.equal('comped_addons' in compLineFor({ compCents: 100, compedAddons: [] }), false, 'none named: no key');
});

// ─── the fold-side drop ───────────────────────────────────────────────────────
const comp = (amount, comped) => ({
  type: 'discount', label: COMP_LABEL, amount, visible: true, source: 'comp', comped_addons: comped,
});
const PLAIN = { type: 'discount', label: 'Test discount A', amount: 50, visible: true };
const REFUND = { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 3 };

test('netCompLinesAgainstAddons: a comp for add-on 7 leaves when 7 leaves the After set, and stays while 7 is present', () => {
  const lines = [PLAIN, comp(100, [{ addon_id: 7, cents: 10000 }]), REFUND];
  const gone = netCompLinesAgainstAddons(lines, [8, 9]);
  assert.equal(gone.changed, true);
  assert.deepEqual(gone.lines, [PLAIN, REFUND]);
  const kept = netCompLinesAgainstAddons(lines, [7, 8]);
  assert.equal(kept.changed, false);
  assert.equal(kept.lines, lines, 'the same array when nothing changed');
  assert.deepEqual(lines[1].comped_addons, [{ addon_id: 7, cents: 10000 }], 'the input is never mutated');
  // Ids arrive as strings from some rows: compared as numbers.
  assert.equal(netCompLinesAgainstAddons(lines, ['7']).changed, false);
});

test('netCompLinesAgainstAddons: a comp of two add-ons loses only the gone one, keeps its bar and syrup remainder, and drops at zero', () => {
  // Toast 200 + other 50 comped, with a 110 bar-and-syrup remainder: 360.
  const mixed = comp(360, [{ addon_id: 7, cents: 20000 }, { addon_id: 8, cents: 5000 }]);
  const toastGone = netCompLinesAgainstAddons([mixed], [8]);
  assert.deepEqual(toastGone.lines, [comp(160, [{ addon_id: 8, cents: 5000 }])]);
  const bothGone = netCompLinesAgainstAddons([mixed], []);
  assert.deepEqual(bothGone.lines, [comp(110, [])], 'the bar and syrup portion stays, naming no add-on');
  assert.equal(netCompLinesAgainstAddons(bothGone.lines, []).changed, false, 'a remainder is never dropped again');
  // A comp that was exactly its add-ons drops whole.
  assert.deepEqual(netCompLinesAgainstAddons([comp(250, [{ addon_id: 7, cents: 20000 }, { addon_id: 8, cents: 5000 }])], []).lines, []);
  // Junk cents never go negative: a non-integer entry counts as 0.
  assert.deepEqual(netCompLinesAgainstAddons([comp(100, [{ addon_id: 7, cents: 'x' }])], []).lines, [comp(100, [])]);
});

test('netCompLinesAgainstAddons: every other line, a comp naming no add-ons, and junk input pass through', () => {
  const untied = { type: 'discount', label: COMP_LABEL, amount: 30, visible: true, source: 'comp' };
  const lines = [PLAIN, REFUND, untied, comp(10, []), null];
  const out = netCompLinesAgainstAddons(lines, []);
  assert.equal(out.changed, false);
  assert.equal(out.lines, lines);
  assert.deepEqual(netCompLinesAgainstAddons('junk', [1]), { lines: [], changed: false });
  assert.deepEqual(netCompLinesAgainstAddons(undefined, undefined), { lines: [], changed: false });
});

test('writes the line to the row and the snapshot in one UPDATE, lowering the snapshot total and total_price by the same cents', async () => {
  const row = { id: 7, adjustments: [DISCOUNT_A], pricing_snapshot: fullSnapshot() };
  const client = fakeClient(row);
  const out = await appendCompLine(client, {
    proposalId: 7, compCents: 30000, invoiceNumber: 'INV0007', compedAddons: [{ addon_id: 42, cents: 30000 }],
  });

  assert.equal(client.calls.length, 2, 'one locking read, one UPDATE');
  const upd = client.calls[1];
  assert.match(upd.sql, /SET adjustments = \$2::jsonb/);
  assert.match(upd.sql, /pricing_snapshot = COALESCE\(\$3::jsonb, pricing_snapshot\)/);
  assert.match(upd.sql, /total_price = GREATEST\(total_price - \(\$4 \/ 100\.0\), 0\)/);
  assert.match(upd.sql, /ELSE GREATEST\(total_price_override - \(\$4 \/ 100\.0\), 0\)/);
  assert.doesNotMatch(upd.sql, /total_price = total_price - \$1/, 'never the bare subtraction');
  assert.equal(upd.params[0], 7);
  assert.equal(upd.params[3], 30000, 'the cents, sent as integer cents');

  const line = {
    type: 'discount', label: `${COMP_LABEL} (INV0007)`, amount: 300, visible: true, source: 'comp',
    comped_addons: [{ addon_id: 42, cents: 30000 }],
  };
  assert.deepEqual(out.line, line);
  assert.deepEqual(JSON.parse(upd.params[1]), [DISCOUNT_A, line], 'appended after the stored lines');

  const snap = JSON.parse(upd.params[2]);
  assert.deepEqual(snap.adjustments, [DISCOUNT_A, line]);
  assert.equal(snap.total, 1090, '1390 - 300');
  assert.equal(snap.subtotal, 1400, 'the itemized sum is untouched; the line explains the gap');
  assert.deepEqual(snap.breakdown.slice(0, 4), fullSnapshot().breakdown.slice(0, 4));
  assert.deepEqual(snap.breakdown[4], { label: line.label, amount: -300, visible: true }, 'the row sits before the client gratuity row');
  assert.deepEqual(snap.breakdown[5], { label: GRATUITY_LABEL, amount: 40 });
  assert.deepEqual(snap.addons, fullSnapshot().addons, 'the comped add-on stays: it is delivered, free');

  // The two totals agree after the comp (the audit's PRC-01 invariant).
  assert.equal(Math.round(Number(out.proposal.total_price) * 100), Math.round(snap.total * 100));
  assert.equal(row.pricing_snapshot.total, 1390, 'the input snapshot is not mutated');
  assert.equal(row.adjustments.length, 1);
});

test('an override moves by the same cents and NULL stays NULL', async () => {
  const row = { id: 8, adjustments: [], pricing_snapshot: fullSnapshot() };
  const withOverride = fakeClient(row, { override: 1200 });
  const a = await appendCompLine(withOverride, { proposalId: 8, compCents: 30000 });
  assert.equal(a.proposal.total_price_override, 900);
  const without = fakeClient(row);
  const b = await appendCompLine(without, { proposalId: 8, compCents: 30000 });
  assert.equal(b.proposal.total_price_override, null);
});

test('a snapshot that is not an object is left alone; the line still reaches the adjustments column', async () => {
  for (const snapshot of [null, undefined, 'not a snapshot']) {
    const client = fakeClient({ id: 9, adjustments: null, pricing_snapshot: snapshot });
    const out = await appendCompLine(client, { proposalId: 9, compCents: 31000 });
    const upd = client.calls[1];
    assert.equal(upd.params[2], null, `snapshot ${String(snapshot)}: COALESCE keeps the column`);
    assert.deepEqual(JSON.parse(upd.params[1]), [out.line]);
    assert.equal(out.proposal.total_price, '1080.00', '1390 - 310');
  }
});

test('a legacy numeric-string snapshot total is lowered too, and the total floors at 0', async () => {
  const snap = { ...fullSnapshot(), total: '1390.00' };
  const client = fakeClient({ id: 10, adjustments: [], pricing_snapshot: snap });
  await appendCompLine(client, { proposalId: 10, compCents: 150000 });
  assert.equal(JSON.parse(client.calls[1].params[2]).total, 0);
});

test('a snapshot with no breakdown gets the line and the total, no breakdown row', async () => {
  const snap = { adjustments: [], total: 500 };
  const client = fakeClient({ id: 11, adjustments: [], pricing_snapshot: snap });
  const out = await appendCompLine(client, { proposalId: 11, compCents: 10000 });
  const written = JSON.parse(client.calls[1].params[2]);
  assert.deepEqual(written, { adjustments: [out.line], total: 400 });
});

test('refuses a held booking before any write', async () => {
  __setLegalHoldIdsForTest([12]);
  const client = fakeClient({ id: 12, adjustments: [], pricing_snapshot: fullSnapshot() });
  await assert.rejects(() => appendCompLine(client, { proposalId: 12, compCents: 100 }), (e) => e.code === 'LEGAL_HOLD');
  assert.equal(client.calls.length, 1, 'the locking read only');
  __setLegalHoldIdsForTest(null);
});

test('refuses an unreadable line list before any write, never falling back to a bare subtraction', async () => {
  const bad = [
    { id: 13, adjustments: 'junk', pricing_snapshot: fullSnapshot() },
    { id: 13, adjustments: [], pricing_snapshot: { ...fullSnapshot(), adjustments: { not: 'a list' } } },
    { id: 13, adjustments: [], pricing_snapshot: { ...fullSnapshot(), breakdown: 'junk' } },
  ];
  for (const row of bad) {
    const client = fakeClient(row);
    await assert.rejects(() => appendCompLine(client, { proposalId: 13, compCents: 100 }), (e) => e.code === 'COMP_LINE_UNWRITABLE');
    assert.equal(client.calls.length, 1);
  }
});

test('a missing row is NotFound and a non-positive or fractional amount is a programming error', async () => {
  await assert.rejects(() => appendCompLine(fakeClient(null), { proposalId: 1, compCents: 100 }), (e) => e.statusCode === 404);
  for (const compCents of [0, -5, 10.5, '100', NaN, undefined]) {
    const client = fakeClient({ id: 1, adjustments: [], pricing_snapshot: null });
    await assert.rejects(() => appendCompLine(client, { proposalId: 1, compCents }), /positive integer/);
    assert.equal(client.calls.length, 0, 'refused before the read');
  }
});
