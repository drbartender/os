// server/utils/invoiceLineItems.test.js
// Invoice line items that add up (spec 2026-10-08). The builder signs every
// adjustment the way the pricing engine and the proposal page do, prints only
// the adjustments the client sees, and folds whatever the itemized lines leave
// short of the contract (a hidden adjustment, an override, snapshot drift) into
// the package line. Expected values are hand-derived cents, never recomputed
// with the code under test.
require('dotenv').config();

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Sentry = require('@sentry/node');
const { pool } = require('../db');
const { buildInvoiceLineItems, generateLineItemsFromProposal } = require('./invoiceLineItems');
const { refreshUnlockedInvoices } = require('./invoiceLifecycle');

if (process.env.NODE_ENV === 'production') {
  throw new Error('invoiceLineItems.test.js refuses to run against production');
}

const proposalIds = [];
after(async () => {
  if (proposalIds.length) {
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1::int[])', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1::int[])', [proposalIds]);
  }
  await pool.end();
});

function snap({ base = 350, barRental = 0, subtotal, total, adjustments = [], gratuity = 0, override = null } = {}) {
  return {
    package: { name: 'The Core Reaction', base_cost: base },
    staffing: { extra: 0, total: 0 },
    bar_rental: { total: barRental },
    syrups: { total: 0 },
    gratuity: { total: gratuity },
    adjustments,
    total_price_override: override,
    subtotal,
    total,
  };
}

const lines = (items) => items.map((i) => [i.description, i.line_total]);
const sum = (items) => items.reduce((s, i) => s + i.line_total, 0);

// ─── The adjustment lines ────────────────────────────────────────────────────

test('a visible discount prints as a negative line and the lines add up to the contract', () => {
  const { items, fold } = buildInvoiceLineItems({
    snapshot: snap({ subtotal: 350, total: 250, adjustments: [{ type: 'discount', label: 'Courtesy', amount: '100', visible: true }] }),
    totalPriceCents: 25000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 35000], ['Courtesy', -10000]]);
  assert.equal(sum(items), 25000);
  assert.equal(fold.applied, null, 'nothing to fold when the lines already reach the contract');
});

test('a surcharge prints as a positive line', () => {
  const { items } = buildInvoiceLineItems({
    snapshot: snap({ subtotal: 350, total: 550, adjustments: [{ type: 'surcharge', label: 'Remote Staffing Fee', amount: '200', visible: true }] }),
    totalPriceCents: 55000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 35000], ['Remote Staffing Fee', 20000]]);
});

test('a label is printed verbatim, trailing space and all', () => {
  const { items } = buildInvoiceLineItems({
    snapshot: snap({ subtotal: 350, total: 300, adjustments: [{ type: 'discount', label: 'Courtesy ', amount: '50', visible: true }] }),
    totalPriceCents: 30000,
  });
  assert.equal(items[1].description, 'Courtesy ');
});

test('an empty label falls back to Discount or Surcharge by type, and a zero amount prints nothing', () => {
  const { items } = buildInvoiceLineItems({
    snapshot: snap({
      subtotal: 350, total: 330,
      adjustments: [
        { type: 'discount', label: '', amount: '50', visible: true },
        { type: 'surcharge', label: '', amount: '30', visible: true },
        { type: 'discount', label: 'Nothing', amount: '0', visible: true },
      ],
    }),
    totalPriceCents: 33000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 35000], ['Discount', -5000], ['Surcharge', 3000]]);
});

// ─── The fold ────────────────────────────────────────────────────────────────

test('a hidden discount prints no line and comes off the package line instead', () => {
  const { items, fold } = buildInvoiceLineItems({
    snapshot: snap({ base: 400, subtotal: 400, total: 300, adjustments: [{ type: 'discount', label: 'Budget Match Discount', amount: '100', visible: false }] }),
    totalPriceCents: 30000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 30000]]);
  assert.equal(items[0].unit_price, 30000, 'unit price follows the folded line');
  assert.equal(fold.applied, 'package');
  assert.equal(fold.gapCents, -10000);
  assert.equal(fold.explainedCents, -10000, 'the snapshot itself accounts for the whole gap');
  assert.equal(fold.unexplainedCents, 0);
  assert.equal(fold.drift, false);
});

test('an adjustment with no visible flag is hidden, the same test the proposal page applies', () => {
  const { items } = buildInvoiceLineItems({
    snapshot: snap({ base: 400, subtotal: 400, total: 350, adjustments: [{ type: 'discount', label: 'Legacy', amount: '50' }] }),
    totalPriceCents: 35000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 35000]]);
});

test('an override folds into the package line and leaves the other lines at catalog', () => {
  const { items, fold } = buildInvoiceLineItems({
    snapshot: snap({ base: 350, barRental: 50, subtotal: 400, total: 300, override: 300 }),
    totalPriceCents: 30000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 25000], ['Bar Rental', 5000]]);
  assert.equal(fold.applied, 'package');
  assert.equal(fold.unexplainedCents, 0);
});

test('a hidden surcharge raises the package line by its amount', () => {
  const { items, fold } = buildInvoiceLineItems({
    snapshot: snap({ base: 350, subtotal: 350, total: 425, adjustments: [{ type: 'surcharge', label: 'Rush', amount: '75', visible: false }] }),
    totalPriceCents: 42500,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 42500]]);
  assert.equal(fold.gapCents, 7500);
  assert.equal(fold.unexplainedCents, 0);
});

// The printed unit price multiplies to the line total (audit PRC-04). The
// engine stores the display quantity (law 6): a per-guest add-on with a count
// above one stores the guest count and folds the count into line_total; the
// additional bartender stores hours and folds its sub-100-guest surcharge into
// line_total. Printing the catalog rate beside them read 100 x $2.50 = $500
// and 4 x $40 = $260.
//
// Which shapes multiply after the derivation (round 2, L1): per_guest at any
// count (guests x rate x count over guests is rate x count, whole cents), the
// additional bartender (hours x count x (rate + surcharge) over hours x count),
// per_hour at any hours and count (the rate itself), per_staff, per_100_guests
// and flat (rate x units over units), and per_guest_timed on whole extra hours
// (rate + hours x extra rate, whole cents). The ONE shape that does not:
// per_guest_timed on a fractional extra hour whose extra cents are not whole
// (the Foundation at 4.5h: 300 + 37.5 cents a guest); it keeps the catalog
// rate, and the test below pins that it keeps it rather than printing a
// rounded unit that would not multiply either.
test('a unit price that would not multiply to the line total is derived from it, so every add-on row multiplies', () => {
  const { items, fold } = buildInvoiceLineItems({
    snapshot: snap({ base: 350, subtotal: 1110, total: 1110 }),
    addonRows: [
      // Champagne Toast, 100 guests, count 2: engine quantity 100, line 500 (engine case L).
      { addon_id: 7, addon_name: 'Champagne Toast', billing_type: 'per_guest', rate: '2.50', quantity: '100', line_total: '500.00' },
      // Additional bartender on a 60-guest hosted 4h booking: quantity 4 (hours), line 260 = 4 x (40 + 25) (engine case I).
      { addon_id: 8, addon_name: 'Additional Bartender', billing_type: 'per_hour', rate: '40.00', quantity: '4', line_total: '260.00' },
    ],
    totalPriceCents: 111000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 35000], ['Champagne Toast', 50000], ['Additional Bartender', 26000]]);
  assert.equal(items[1].quantity, 100);
  assert.equal(items[1].unit_price, 500, '$5.00 a guest: the count of two folded into the rate');
  assert.equal(items[2].quantity, 4);
  assert.equal(items[2].unit_price, 6500, '$65.00 an hour: the surcharge folded into the rate');
  for (const it of items) assert.equal(it.quantity * it.unit_price, it.line_total, it.description);
  assert.equal(sum(items), 111000, 'the fold is by line_total, unchanged');
  assert.equal(fold.applied, null);
});

test('a per_guest_timed add-on on a fractional extra hour keeps the catalog rate: its exact unit is not whole cents', () => {
  const { items } = buildInvoiceLineItems({
    snapshot: snap({ base: 350, subtotal: 1062.5, total: 1062.5 }),
    addonRows: [
      // The Foundation, 100 guests, 4.5h: 100 x ($3.00 + 0.5 x $0.75) = $337.50; 33750 / 100 is 337.5 cents.
      { addon_id: 11, addon_name: 'The Foundation', billing_type: 'per_guest_timed', rate: '3.00', quantity: '100', line_total: '337.50' },
      // The same add-on on a whole extra hour, 5h: 100 x ($3.00 + $0.75) = $375; 375 cents a guest, derived.
      { addon_id: 11, addon_name: 'The Foundation', billing_type: 'per_guest_timed', rate: '3.00', quantity: '100', line_total: '375.00' },
    ],
    totalPriceCents: 106250,
  });
  assert.deepEqual(items.slice(1).map((i) => [i.quantity, i.unit_price, i.line_total]), [[100, 300, 33750], [100, 375, 37500]]);
  assert.notEqual(items[1].quantity * items[1].unit_price, items[1].line_total, 'the one shape that cannot multiply keeps the catalog rate');
  assert.equal(items[2].quantity * items[2].unit_price, items[2].line_total);
  assert.equal(sum(items), 106250, 'the fold is by line_total either way');
});

test('an add-on whose rate multiplies to its line total keeps the catalog rate as its unit price', () => {
  const { items } = buildInvoiceLineItems({
    snapshot: snap({ base: 350, subtotal: 935, total: 935 }),
    addonRows: [
      { addon_id: 7, addon_name: 'Champagne Toast', billing_type: 'per_guest', rate: '2.50', quantity: '100', line_total: '250.00' },
      { addon_id: 9, addon_name: 'Banquet Server', billing_type: 'per_hour', rate: '75.00', quantity: '4.5', line_total: '337.50' },
      { addon_id: 10, addon_name: 'Parking Fee', billing_type: 'per_staff', rate: '20.00', quantity: '3', line_total: '60.00' },
    ],
    totalPriceCents: 93500,
  });
  assert.deepEqual(items.slice(1).map((i) => [i.quantity, i.unit_price, i.line_total]),
    [[100, 250, 25000], [4.5, 7500, 33750], [3, 2000, 6000]]);
});

test('a null addonRows is treated as none', () => {
  const { items } = buildInvoiceLineItems({ snapshot: snap({ subtotal: 350, total: 350 }), addonRows: null, totalPriceCents: 35000 });
  assert.deepEqual(lines(items), [['The Core Reaction', 35000]]);
});

test('a gap bigger than the package lands on one Pricing adjustment line and the package stays at catalog', () => {
  const { items, fold } = buildInvoiceLineItems({
    snapshot: snap({ base: 300, subtotal: 800, total: 400, adjustments: [{ type: 'discount', label: 'Hidden', amount: '400', visible: false }] }),
    addonRows: [{ addon_id: 7, addon_name: 'Champagne Toast', rate: '500.00', quantity: '1', line_total: '500.00' }],
    totalPriceCents: 40000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 30000], ['Champagne Toast', 50000], ['Pricing adjustment', -40000]]);
  assert.equal(items[2].source_type, 'manual');
  assert.equal(sum(items), 40000);
  assert.equal(fold.applied, 'fallback');
});

test('the gratuity line is printed and counted toward the contract', () => {
  const { items, fold } = buildInvoiceLineItems({
    snapshot: snap({ base: 1000, subtotal: 1000, total: 1100, gratuity: 100 }),
    totalPriceCents: 110000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 100000], ['Gratuity', 10000]]);
  assert.equal(fold.applied, null);
});

test('no package line means no fold', () => {
  const { items, fold } = buildInvoiceLineItems({
    snapshot: {},
    addonRows: [{ addon_id: 3, addon_name: 'Ice Delivery', rate: '100.00', quantity: '1', line_total: '100.00' }],
    totalPriceCents: 50000,
  });
  assert.deepEqual(lines(items), [['Ice Delivery', 10000]]);
  assert.equal(fold.applied, null);
});

test('a null or NaN contract total means no fold, never a fold to zero', () => {
  for (const totalPriceCents of [null, NaN]) {
    const { items, fold } = buildInvoiceLineItems({
      snapshot: snap({ base: 400, subtotal: 400, total: 300, adjustments: [{ type: 'discount', label: 'Hidden', amount: '100', visible: false }] }),
      totalPriceCents,
    });
    assert.deepEqual(lines(items), [['The Core Reaction', 40000]], `total ${totalPriceCents}`);
    assert.equal(fold.applied, null);
  }
});

// ─── Drift reporting ─────────────────────────────────────────────────────────

test('a row that disagrees with its snapshot is folded and reported as drift', () => {
  // Proposal 527's shape: snapshot says $450, the contract says $370.
  const { items, fold } = buildInvoiceLineItems({
    snapshot: snap({ base: 450, subtotal: 450, total: 450 }),
    totalPriceCents: 37000,
  });
  assert.deepEqual(lines(items), [['The Core Reaction', 37000]]);
  assert.equal(fold.explainedCents, 0);
  assert.equal(fold.unexplainedCents, -8000);
  assert.equal(fold.drift, true);
});

test('a one-cent rounding difference is folded but not reported as drift', () => {
  const { items, fold } = buildInvoiceLineItems({
    snapshot: snap({ base: 350, barRental: 50, subtotal: 400.01, total: 400.01 }),
    totalPriceCents: 40001,
  });
  assert.equal(sum(items), 40001);
  assert.equal(fold.unexplainedCents, 1);
  assert.equal(fold.drift, false);
});

// ─── The DB wrapper ──────────────────────────────────────────────────────────

async function seedProposal({ snapshot, totalPrice }) {
  const r = await pool.query(
    `INSERT INTO proposals (pricing_snapshot, total_price, status) VALUES ($1, $2, 'sent') RETURNING id`,
    [JSON.stringify(snapshot), totalPrice]
  );
  proposalIds.push(r.rows[0].id);
  return r.rows[0].id;
}

const hiddenSnap = () => snap({ base: 400, subtotal: 400, total: 300, adjustments: [{ type: 'discount', label: 'Budget Match Discount', amount: '100', visible: false }] });

test('the wrapper reads the contract from the row and folds to it', async () => {
  const id = await seedProposal({ snapshot: hiddenSnap(), totalPrice: 300 });
  const items = await generateLineItemsFromProposal(id);
  assert.deepEqual(lines(items), [['The Core Reaction', 30000]]);
});

test('the wrapper reads add-ons from proposal_addons', async () => {
  const id = await seedProposal({ snapshot: snap({ base: 350, subtotal: 450, total: 450 }), totalPrice: 450 });
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, NULL, 'Ice Delivery', 'flat', 100, 1, 100)`, [id]);
  const items = await generateLineItemsFromProposal(id);
  assert.deepEqual(lines(items), [['The Core Reaction', 35000], ['Ice Delivery', 10000]]);
});

test('a total the caller passes wins over the row', async () => {
  const id = await seedProposal({ snapshot: hiddenSnap(), totalPrice: 300 });
  const items = await generateLineItemsFromProposal(id, null, { totalPrice: '250.00' });
  assert.deepEqual(lines(items), [['The Core Reaction', 25000]]);
});

test('a caller-passed null total means no fold', async () => {
  const id = await seedProposal({ snapshot: hiddenSnap(), totalPrice: 300 });
  const items = await generateLineItemsFromProposal(id, null, { totalPrice: null });
  assert.deepEqual(lines(items), [['The Core Reaction', 40000]]);
});

test('an explicit undefined total reads the row, so only a real null turns the fold off', async () => {
  const id = await seedProposal({ snapshot: hiddenSnap(), totalPrice: 300 });
  const items = await generateLineItemsFromProposal(id, null, { totalPrice: undefined });
  assert.deepEqual(lines(items), [['The Core Reaction', 30000]]);
});

// ─── Reporting ───────────────────────────────────────────────────────────────

// Swap Sentry's captureMessage for a recorder, with a DSN set so the guard opens.
async function sentryCalls(fn) {
  const seen = [];
  const orig = Sentry.captureMessage;
  const dsn = process.env.SENTRY_DSN_SERVER;
  Sentry.captureMessage = (msg) => { seen.push(String(msg)); };
  process.env.SENTRY_DSN_SERVER = dsn || 'test-dsn';
  try {
    await fn();
  } finally {
    Sentry.captureMessage = orig;
    if (dsn === undefined) delete process.env.SENTRY_DSN_SERVER; else process.env.SENTRY_DSN_SERVER = dsn;
  }
  return seen;
}

const driftSnap = () => snap({ base: 450, subtotal: 450, total: 450 });

test('a fold the snapshot does not explain is reported to Sentry', async () => {
  const id = await seedProposal({ snapshot: driftSnap(), totalPrice: 370 });
  const seen = await sentryCalls(() => generateLineItemsFromProposal(id));
  assert.deepEqual(seen, ['invoice_lines_unexplained_fold']);
});

test('a fold the snapshot explains (a hidden discount) is not reported', async () => {
  const id = await seedProposal({ snapshot: hiddenSnap(), totalPrice: 300 });
  const seen = await sentryCalls(() => generateLineItemsFromProposal(id));
  assert.deepEqual(seen, []);
});

test('the Pricing adjustment fallback is always reported', async () => {
  const id = await seedProposal({
    snapshot: snap({ base: 300, subtotal: 800, total: 400, adjustments: [{ type: 'discount', label: 'Hidden', amount: '400', visible: false }] }),
    totalPrice: 400,
  });
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, NULL, 'Champagne Toast', 'flat', 500, 1, 500)`, [id]);
  const seen = await sentryCalls(() => generateLineItemsFromProposal(id));
  assert.deepEqual(seen, ['invoice_lines_fold_fallback']);
});

test('a refresh with no unlocked invoice builds nothing, so it reports nothing', async () => {
  // The refund shape: total_price moved, the snapshot did not, every invoice locked.
  const id = await seedProposal({ snapshot: driftSnap(), totalPrice: 370 });
  const nonce = `${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, 'Full Payment', 37000, 37000, 'paid', true)`, [id, `ILT${nonce}`]);
  const seen = await sentryCalls(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await refreshUnlockedInvoices(id, client);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  });
  assert.deepEqual(seen, [], 'no invoice was written, so there is no fold to report');
});
