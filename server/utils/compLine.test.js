// server/utils/compLine.test.js
'use strict';
// The comp line (audit PRC-01, rounds 1 to 3), pure: the engine prices the
// fixtures, the caller's transaction client is a scripted fake, so this runs
// with no database. A comp is "these items are free": applyCompLines sets a
// comp line to the current price of the items it comps, at every pricing,
// and drops it when they are all gone. Pinned here: the amount follows a
// headcount change (the verifier's H1 case, 75 to 50 to 100 guests), leaves
// with a cancelled add-on, a cancelled bar or a cancelled syrup flavor (H2),
// the bar's marginal fee and the syrups' marginal price in the set, the
// writer's own derivation at comp time, the legacy {} snapshot and the
// refusals. A legal hold is ADDED through __setLegalHoldIdsForTest on a
// synthetic id; nothing here reads or writes a real held booking.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { appendCompLine, compLineFor, applyCompLines, calculateProposalWithComps } = require('./compLine');
const { isProtectedAdjustment, validateAdjustments, COMP_LABEL } = require('./adjustmentRules');
const { calculateProposal, calculateSyrupCost } = require('./pricingEngine');
const { __setLegalHoldIdsForTest } = require('./legalHold');
const { GRATUITY_LABEL } = require('./gratuityLabels');

after(() => __setLegalHoldIdsForTest(null));

// A Core Reaction-shaped flat package ($350 up to 4h) and a $2.50-a-guest
// toast, in the shape the catalog rows take (pricingEngine.test.js).
const PKG = {
  id: 1, slug: 'test-core', name: 'Test Core', category: 'byob', pricing_type: 'flat', bar_type: 'service_only',
  base_rate_4hr: 350, base_rate_3hr: null, extra_hour_rate: 100, min_guests: 0, bartenders_included: 1,
  guests_per_bartender: 100, extra_bartender_hourly: 40, first_bar_fee: 50, additional_bar_fee: 100, min_total: null,
};
const TOAST = { id: 42, slug: 'test-toast', name: 'Test Toast', billing_type: 'per_guest', rate: 2.5, extra_hour_rate: null };
const OTHER = { id: 43, slug: 'test-other', name: 'Test Other', billing_type: 'flat', rate: 80, extra_hour_rate: null };
const cents = (n) => Math.round(Number(n) * 100);

function price({ guests = 75, addons = [], numBars = 0, syrups = [], adjustments = [], gratuityRate = 0 } = {}) {
  return calculateProposal({
    pkg: PKG, guestCount: guests, durationHours: 4, numBars, numBartenders: null,
    addons: addons.map((a) => ({ ...a, quantity: 1 })), syrupSelections: syrups, adjustments,
    totalPriceOverride: null, gratuityRate, tipJar: true, gratuityFloorRate: null,
  });
}
const comp = (amount, comped) => ({
  type: 'discount', label: `${COMP_LABEL} (INV0001)`, amount, visible: true, source: 'comp',
  comped: { addons: [], bar: false, syrups: [], ...comped },
});
const PLAIN = { type: 'discount', label: 'Test discount A', amount: 50, visible: true };
const REFUND = { type: 'discount', label: 'Refund', amount: 20, visible: true, source: 'refund', refund_id: 3 };

test('compLineFor is a whole-cent, visible, protected discount the editor validator accepts unchanged, carrying what it comps', () => {
  const line = compLineFor({ compCents: 18750, invoiceNumber: 'INV0001', comped: { addons: [42], bar: true, syrups: ['mint'] } });
  assert.deepEqual(line, {
    type: 'discount', label: `${COMP_LABEL} (INV0001)`, amount: 187.5, visible: true, source: 'comp',
    comped: { addons: [42], bar: true, syrups: ['mint'] },
  });
  assert.equal(isProtectedAdjustment(line), true);
  assert.deepEqual(validateAdjustments([line]).value, [line], 'a later editor save keeps the identity');
  assert.equal(compLineFor({ compCents: 1 }).label, COMP_LABEL, 'no invoice number: the bare label');
  assert.equal('comped' in compLineFor({ compCents: 100, comped: { addons: [], bar: false, syrups: [] } }), false, 'names nothing: no marker');
});

// ─── the derivation ─────────────────────────────────────────────────────────

test('H1: the comp follows the toast through a headcount change: 75 guests 18750, 50 guests 12500, 100 guests 25000, the total always 35000', () => {
  // Paid in full at 35000, the toast at 75 guests comped: the stored line
  // holds the cents the comp was written with.
  const stored = [comp(187.5, { addons: [42] })];
  for (const [guests, toastCents] of [[75, 18750], [50, 12500], [100, 25000]]) {
    const args = {
      pkg: PKG, guestCount: guests, durationHours: 4, numBars: 0, numBartenders: null,
      addons: [{ ...TOAST, quantity: 1 }], syrupSelections: [], adjustments: stored,
      totalPriceOverride: null, gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
    };
    const { snapshot, lines, changed } = calculateProposalWithComps(args);
    assert.equal(cents(snapshot.addons[0].line_total), toastCents, `${guests} guests: the toast`);
    assert.equal(cents(lines[0].amount), toastCents, `${guests} guests: the comp equals the toast`);
    assert.equal(cents(snapshot.total), 35000, `${guests} guests: the total holds`);
    assert.deepEqual(snapshot.adjustments, lines, 'the final snapshot carries the derived line');
    assert.equal(changed, guests !== 75);
  }
  // The toast cancelled: the comp leaves with it.
  const gone = calculateProposalWithComps({
    pkg: PKG, guestCount: 50, durationHours: 4, numBars: 0, numBartenders: null, addons: [], syrupSelections: [],
    adjustments: stored, totalPriceOverride: null, gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
  });
  assert.deepEqual(gone.lines, []);
  assert.equal(cents(gone.snapshot.total), 35000);
  assert.deepEqual(stored[0].comped, { addons: [42], bar: false, syrups: [] }, 'the input is never mutated');
  assert.equal(stored[0].amount, 187.5);
});

test('applyCompLines: an add-on comp is its add-on\'s current line total; absent, the line is dropped; the same array when nothing moved', () => {
  const lines = [PLAIN, comp(187.5, { addons: [42] }), REFUND];
  const same = applyCompLines(lines, price({ guests: 75, addons: [TOAST] }));
  assert.equal(same.changed, false);
  assert.equal(same.lines, lines, 'the same array when nothing changed');
  const moved = applyCompLines(lines, price({ guests: 50, addons: [TOAST] }));
  assert.equal(moved.changed, true);
  assert.deepEqual(moved.lines, [PLAIN, comp(125, { addons: [42] }), REFUND]);
  const gone = applyCompLines(lines, price({ guests: 50, addons: [OTHER] }));
  assert.deepEqual(gone.lines, [PLAIN, REFUND]);
  // Ids spelled as strings on a stored line compare as numbers.
  assert.equal(cents(applyCompLines([comp(1, { addons: ['42'] })], price({ addons: [TOAST] })).lines[0].amount), 18750);
  // A comped add-on whose current price is $0 is present at $0, never dropped.
  const free = { ...TOAST, rate: 0 };
  assert.deepEqual(applyCompLines([comp(5, { addons: [42] })], price({ addons: [free] })).lines, [comp(0, { addons: [42] })]);
});

test('H2 bar: a comped bar is priced at its marginal fee in the current bar count, and leaves when the bars go', () => {
  const one = comp(50, { bar: true });
  assert.equal(cents(applyCompLines([one], price({ numBars: 1 })).lines[0].amount), 5000, 'the only bar: the first bar fee');
  assert.equal(cents(applyCompLines([one], price({ numBars: 2 })).lines[0].amount), 10000, 'a second bar: the additional fee');
  assert.deepEqual(applyCompLines([one], price({ numBars: 0 })).lines, [], 'no bar: the comp leaves');
  // Two comps each naming a bar take the top of the count one after another: never the same fee twice.
  const two = applyCompLines([comp(100, { bar: true }), comp(100, { bar: true })], price({ numBars: 2 })).lines;
  assert.deepEqual(two.map((l) => cents(l.amount)), [10000, 5000]);
  assert.equal(two[0].amount + two[1].amount, price({ numBars: 2 }).bar_rental.total, 'together they comp every bar, no more');
  // Three comps for two bars: the third finds none left.
  const three = applyCompLines([comp(1, { bar: true }), comp(1, { bar: true }), comp(1, { bar: true })], price({ numBars: 2 })).lines;
  assert.equal(three.length, 2);
});

test('H2 syrups: comped flavors are priced at their marginal price in the current selection; a cancelled flavor takes exactly its price with it', () => {
  // At 50 guests one bottle a flavor: two comped flavors are 2 singles, $60.
  const both = comp(60, { syrups: ['mint', 'ginger'] });
  assert.equal(cents(applyCompLines([both], price({ guests: 50, syrups: ['mint', 'ginger'] })).lines[0].amount), 6000);
  // 'mint' cancelled: the comp is ginger alone, $30, down by exactly mint's price.
  assert.equal(cents(applyCompLines([both], price({ guests: 50, syrups: ['ginger'] })).lines[0].amount), 3000);
  assert.deepEqual(applyCompLines([both], price({ guests: 50, syrups: [] })).lines, [], 'both cancelled: the comp leaves');
  // With a contract flavor beside them the set prices as a 3-pack ($75): the
  // comped two are the set less the contract flavor alone, $75 - $30 = $45,
  // exactly what the fold added for them.
  const set = price({ guests: 50, syrups: ['vanilla-bean', 'mint', 'ginger'] });
  assert.equal(cents(set.syrups.total), 7500);
  assert.equal(cents(applyCompLines([both], set).lines[0].amount), 7500 - cents(calculateSyrupCost(['vanilla-bean'], 50).total));
  // Guests scale the bottles: at 75 guests two bottles a flavor, two flavors = 1 pack + 1 single = $105.
  assert.equal(cents(applyCompLines([both], price({ guests: 75, syrups: ['mint', 'ginger'] })).lines[0].amount), 10500);
  // Two comps over flavors take the set one after another, together the whole set.
  const two = applyCompLines([comp(1, { syrups: ['mint'] }), comp(1, { syrups: ['ginger'] })], price({ guests: 50, syrups: ['mint', 'ginger'] })).lines;
  assert.equal(two[0].amount + two[1].amount, 60);
  // A flavor the selection does not carry contributes nothing.
  assert.deepEqual(applyCompLines([comp(1, { syrups: ['mint'] })], price({ guests: 50, syrups: ['ginger'] })).lines, []);
});

test('a mixed comp (toast, bar, syrups) follows each item, and keeps the rest when one leaves', () => {
  const mixed = comp(342.5, { addons: [42], bar: true, syrups: ['mint', 'ginger'] });
  const all = price({ guests: 75, addons: [TOAST], numBars: 1, syrups: ['mint', 'ginger'] });
  assert.equal(cents(applyCompLines([mixed], all).lines[0].amount), 18750 + 5000 + 10500);
  const noToast = price({ guests: 75, numBars: 1, syrups: ['mint', 'ginger'] });
  assert.equal(cents(applyCompLines([mixed], noToast).lines[0].amount), 5000 + 10500, 'the toast gone: the bar and the syrups stay comped');
  const barOnly = price({ guests: 75, numBars: 1 });
  assert.equal(cents(applyCompLines([mixed], barOnly).lines[0].amount), 5000);
  assert.deepEqual(applyCompLines([mixed], price({ guests: 75 })).lines, []);
});

test('every other line, a comp naming nothing, and junk input pass through', () => {
  const untied = { type: 'discount', label: COMP_LABEL, amount: 30, visible: true, source: 'comp' };
  const lines = [PLAIN, REFUND, untied, null];
  const out = applyCompLines(lines, price({ addons: [TOAST] }));
  assert.equal(out.changed, false);
  assert.equal(out.lines, lines);
  assert.deepEqual(applyCompLines('junk', price()), { lines: [], changed: false });
  assert.deepEqual(applyCompLines(undefined, undefined), { lines: [], changed: false });
  // A snapshot with no item shapes prices every comped item as absent.
  assert.deepEqual(applyCompLines([comp(5, { addons: [42], bar: true, syrups: ['mint'] })], {}).lines, []);
});

// ─── the writer ──────────────────────────────────────────────────────────────

// The row as the fold left it: toast, one bar, one syrup, a plain discount, a
// client gratuity ($10 a staff-hour, one bartender, 4h = $40, the last row).
const DISCOUNT_A = { type: 'discount', label: 'Test discount A', amount: 50, visible: true };
const fullSnapshot = () => price({ guests: 75, addons: [TOAST], numBars: 1, syrups: ['mint'], adjustments: [DISCOUNT_A], gratuityRate: 10 });

// A scripted transaction client: the FOR UPDATE read answers with `row`, the
// UPDATE records its SQL and params and answers with the row's money columns
// after the SQL arithmetic the real statement does (dollars, floored at 0).
function fakeClient(row, { totalPrice = 637.5, override = null, amountPaid = 637.5, status = 'balance_paid' } = {}) {
  const calls = [];
  return {
    calls,
    query: (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT id, adjustments, pricing_snapshot FROM proposals WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return Promise.resolve({ rows: row ? [row] : [] });
      }
      if (/UPDATE proposals/.test(sql)) {
        const c = params[3];
        const total = Math.max(0, Math.round(totalPrice * 100) - c) / 100;
        return Promise.resolve({
          rowCount: 1,
          rows: [{ status, amount_paid: amountPaid.toFixed(2), total_price: total.toFixed(2),
            total_price_override: override === null ? null : Math.max(0, Math.round(override * 100) - c) / 100 }],
        });
      }
      return Promise.reject(new Error(`unexpected query: ${sql}`));
    },
  };
}

test('writes the line to the row and the snapshot in one UPDATE, at the items\' price in the snapshot, lowering the snapshot total and total_price by the same cents', async () => {
  const snap = fullSnapshot();
  assert.equal(cents(snap.total), 63750, 'fixture: 350 + 50 bar + 187.5 toast + 60 syrup - 50 discount + 40 gratuity');
  const row = { id: 7, adjustments: [DISCOUNT_A], pricing_snapshot: snap };
  const client = fakeClient(row);
  // The invoice's folded cents carry a 10-cent rounding drift; the comp is
  // written at the items' price in the snapshot, not the invoice's figure.
  const out = await appendCompLine(client, {
    proposalId: 7, compCents: 29760, invoiceNumber: 'INV0007', comped: { addons: [42], bar: true, syrups: ['mint', 'vanilla-bean'] },
  });

  assert.equal(client.calls.length, 2, 'one locking read, one UPDATE');
  const upd = client.calls[1];
  assert.match(upd.sql, /SET adjustments = \$2::jsonb/);
  assert.match(upd.sql, /pricing_snapshot = COALESCE\(\$3::jsonb, pricing_snapshot\)/);
  assert.match(upd.sql, /total_price = GREATEST\(total_price - \(\$4 \/ 100\.0\), 0\)/);
  assert.match(upd.sql, /ELSE GREATEST\(total_price_override - \(\$4 \/ 100\.0\), 0\)/);
  assert.doesNotMatch(upd.sql, /total_price = total_price - \$1/, 'never the bare subtraction');
  assert.equal(upd.params[0], 7);
  assert.equal(upd.params[3], 29750, 'toast 18750 + bar 5000 + mint 6000: the items\' price, as cents');
  assert.equal(out.compCents, 29750);

  const line = {
    type: 'discount', label: `${COMP_LABEL} (INV0007)`, amount: 297.5, visible: true, source: 'comp',
    comped: { addons: [42], bar: true, syrups: ['mint'] },
  };
  assert.deepEqual(out.line, line, 'a flavor the booking does not carry is not named');
  assert.deepEqual(JSON.parse(upd.params[1]), [DISCOUNT_A, line], 'appended after the stored lines');

  const written = JSON.parse(upd.params[2]);
  assert.deepEqual(written.adjustments, [DISCOUNT_A, line]);
  assert.equal(cents(written.total), 63750 - 29750);
  assert.equal(written.subtotal, snap.subtotal, 'the itemized sum is untouched; the line explains the gap');
  const rows = written.breakdown;
  assert.deepEqual(rows[rows.length - 1], { label: GRATUITY_LABEL, amount: 40 }, 'the client gratuity row stays last');
  assert.deepEqual(rows[rows.length - 2], { label: line.label, amount: -297.5, visible: true }, 'the comp row sits before it');
  assert.deepEqual(rows.slice(0, -2), snap.breakdown.slice(0, -1));
  assert.deepEqual(written.addons, snap.addons, 'the comped add-on stays: it is delivered, free');

  // The two totals agree after the comp.
  assert.equal(cents(out.proposal.total_price), cents(written.total));
  assert.equal(row.pricing_snapshot.total, snap.total, 'the input snapshot is not mutated');
  assert.equal(row.adjustments.length, 1);
});

test('an override moves by the same cents and NULL stays NULL', async () => {
  const row = { id: 8, adjustments: [], pricing_snapshot: fullSnapshot() };
  const a = await appendCompLine(fakeClient(row, { override: 1200 }), { proposalId: 8, compCents: 18750, comped: { addons: [42] } });
  assert.equal(a.proposal.total_price_override, 1200 - 187.5);
  const b = await appendCompLine(fakeClient(row), { proposalId: 8, compCents: 18750, comped: { addons: [42] } });
  assert.equal(b.proposal.total_price_override, null);
});

test('a comp naming nothing the snapshot prices is refused: the invoice is a correction, not a comp', async () => {
  const client = fakeClient({ id: 9, adjustments: [], pricing_snapshot: price({ guests: 75 }) });
  await assert.rejects(
    () => appendCompLine(client, { proposalId: 9, compCents: 18750, comped: { addons: [42], bar: true, syrups: ['mint'] } }),
    (e) => e.code === 'COMP_ITEMS_NOT_PRICED'
  );
  assert.equal(client.calls.length, 1, 'no write');
});

test('a legacy {} snapshot (the column default) takes the line at the invoice\'s folded cents with its identity, and nothing else: no total, no breakdown row', async () => {
  for (const snapshot of [{}, { adjustments: [] }, { total: null }, { total: 'not money' }, { total: '' }]) {
    const client = fakeClient({ id: 10, adjustments: null, pricing_snapshot: snapshot }, { totalPrice: 1390 });
    const out = await appendCompLine(client, { proposalId: 10, compCents: 31000, comped: { addons: [42], bar: true } });
    const upd = client.calls[1];
    assert.equal(upd.params[3], 31000, JSON.stringify(snapshot));
    assert.deepEqual(out.line.comped, { addons: [42], bar: true, syrups: [] });
    assert.equal(out.line.amount, 310);
    const written = JSON.parse(upd.params[2]);
    assert.deepEqual(written.adjustments, [out.line], JSON.stringify(snapshot));
    assert.equal('breakdown' in written, false, 'no breakdown row where there is no breakdown');
    if ('total' in snapshot) {
      assert.deepEqual(written.total, snapshot.total, 'a total that is not money is left as it was, never NaN');
    } else {
      assert.equal('total' in written, false, 'no total invented');
    }
    assert.deepEqual(JSON.parse(upd.params[1]), [out.line]);
    assert.equal(out.proposal.total_price, '1080.00', '1390 - 310: total_price still moves');
  }
});

test('a legacy numeric-string snapshot total is lowered too, and the total floors at 0', async () => {
  const snap = { ...fullSnapshot(), total: '637.50' };
  const client = fakeClient({ id: 11, adjustments: [], pricing_snapshot: snap });
  await appendCompLine(client, { proposalId: 11, compCents: 1, comped: { addons: [42] } });
  assert.equal(JSON.parse(client.calls[1].params[2]).total, 450, '637.5 - 187.5');
  const tiny = { ...fullSnapshot(), total: 100 };
  const c2 = fakeClient({ id: 11, adjustments: [], pricing_snapshot: tiny }, { totalPrice: 100 });
  await appendCompLine(c2, { proposalId: 11, compCents: 1, comped: { addons: [42] } });
  assert.equal(JSON.parse(c2.calls[1].params[2]).total, 0, 'floored at 0, never negative');
});

test('a snapshot that is not an object at all is left alone; the line still reaches the adjustments column', async () => {
  for (const snapshot of [null, undefined, 'not a snapshot']) {
    const client = fakeClient({ id: 12, adjustments: null, pricing_snapshot: snapshot }, { totalPrice: 1390 });
    const out = await appendCompLine(client, { proposalId: 12, compCents: 31000, comped: { addons: [42] } });
    const upd = client.calls[1];
    assert.equal(upd.params[2], null, `snapshot ${String(snapshot)}: COALESCE keeps the column`);
    assert.deepEqual(JSON.parse(upd.params[1]), [out.line]);
    assert.equal(out.proposal.total_price, '1080.00', '1390 - 310');
  }
});

test('refuses a held booking before any write', async () => {
  __setLegalHoldIdsForTest([13]);
  const client = fakeClient({ id: 13, adjustments: [], pricing_snapshot: fullSnapshot() });
  await assert.rejects(() => appendCompLine(client, { proposalId: 13, compCents: 100, comped: { addons: [42] } }), (e) => e.code === 'LEGAL_HOLD');
  assert.equal(client.calls.length, 1, 'the locking read only');
  __setLegalHoldIdsForTest(null);
});

test('refuses an unreadable line list before any write, never falling back to a bare subtraction', async () => {
  const bad = [
    { id: 14, adjustments: 'junk', pricing_snapshot: fullSnapshot() },
    { id: 14, adjustments: [], pricing_snapshot: { ...fullSnapshot(), adjustments: { not: 'a list' } } },
    { id: 14, adjustments: [], pricing_snapshot: { ...fullSnapshot(), breakdown: 'junk' } },
  ];
  for (const row of bad) {
    const client = fakeClient(row);
    await assert.rejects(() => appendCompLine(client, { proposalId: 14, compCents: 100, comped: { addons: [42] } }), (e) => e.code === 'COMP_LINE_UNWRITABLE');
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
