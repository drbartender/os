require('dotenv').config();

// lineItemCancel — target parsing + enumeration (Task 4) and, extended in
// Task 5, the applyLineItemCancel per-kind core. All money assertions are
// computed from the ENGINE at catalog (never hardcoded dollars) so a rate
// change in the seeded catalog rows can't silently rot the suite.
// Run ALONE against the shared dev DB:
//   node -r dotenv/config --test server/utils/lineItemCancel.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { calculateProposal } = require('./pricingEngine');
const {
  parseCancelTarget,
  computeCancelTargets,
  removableBartenders,
  applyLineItemCancel,
  CANCEL_BLOCKED_STATUSES,
} = require('./lineItemCancel');

if (process.env.NODE_ENV === 'production') {
  throw new Error('lineItemCancel.test.js refuses to run against production');
}

const NONCE = `licancel-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const SLUGS = {
  photoBooth: `photo-booth-${NONCE}`,
  champagne: `champagne-${NONCE}`,
};

let clientId;
let pkg; // full service_packages row
const seededProposals = [];
const seededAddonCatalog = []; // service_addons ids
const seededUsers = [];

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`LICancel ${NONCE}`, `licancel-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;
  const pkgIns = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'LICancel Test Pkg', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]')
     RETURNING id`,
    [`licancel-${NONCE}`]
  );
  pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [pkgIns.rows[0].id])).rows[0];
});

after(async () => {
  for (const pid of seededProposals) {
    await pool.query('DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = $1)', [pid]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_refunds WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [pid]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = $1)', [pid]);
    await pool.query('DELETE FROM proposal_payments WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = $1', [pid]);
    await pool.query("DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = $1", [pid]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  }
  for (const uid of seededUsers) await pool.query('DELETE FROM users WHERE id = $1', [uid]);
  for (const aid of seededAddonCatalog) await pool.query('DELETE FROM service_addons WHERE id = $1', [aid]);
  if (pkg) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.id]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// Seed a real catalog addon (nonce slug) once per distinct slug.
const catalogCache = {};
async function seedCatalogAddon({ slug, name, billingType = 'flat', rate = 200, minimumHours = null }) {
  if (catalogCache[slug]) return catalogCache[slug];
  // A REAL catalog slug (additional-bartender) is reused as-is and deliberately
  // NOT registered in seededAddonCatalog: the engine's bespoke branch and the
  // gratuity basis both key on that exact string, so the test must run against
  // the live row, and teardown must never delete it. Every other slug here is
  // nonce'd and cannot pre-exist, so this lookup is inert for them.
  const existing = await pool.query('SELECT * FROM service_addons WHERE slug = $1', [slug]);
  if (existing.rows[0]) {
    catalogCache[slug] = existing.rows[0];
    return existing.rows[0];
  }
  const r = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active, minimum_hours)
     VALUES ($1, $2, $3, $4, 'all', true, $5) RETURNING id`,
    [slug, name, billingType, rate, minimumHours]
  );
  seededAddonCatalog.push(r.rows[0].id);
  const row = (await pool.query('SELECT * FROM service_addons WHERE id = $1', [r.rows[0].id])).rows[0];
  catalogCache[slug] = row;
  return row;
}

/**
 * Seed a proposal with a REAL engine snapshot so stored money is honest.
 * addons: [{ slug, name, billingType, rate, quantity, minimumHours }]; labAddedSlugs mark a
 * subset as lab-owned in a drink_plans row. Returns ids + the seeded snapshot.
 */
async function seedProposal(opts = {}) {
  const {
    status = 'deposit_paid',
    guestCount = 80,
    durationHours = 4,
    numBars = 0,
    numBartenders = null,
    adjustments = [],
    gratuityRate = 0,
    tipJar = true,
    override = null,
    amountPaid = 100,
    addons = [],
    labAddedSlugs = [],
    labSyrups = {}, // { drinkId: [syrupId] } stored as labSyrupSelections
    syrups = [],
  } = opts;

  const engineAddons = [];
  for (const a of addons) {
    const cat = await seedCatalogAddon({
      slug: a.slug, name: a.name, billingType: a.billingType, rate: a.rate, minimumHours: a.minimumHours ?? null,
    });
    engineAddons.push({ ...cat, quantity: a.quantity || 1 });
  }

  const snapshot = calculateProposal({
    pkg,
    guestCount,
    durationHours,
    numBars,
    numBartenders,
    addons: engineAddons,
    syrupSelections: syrups,
    adjustments,
    totalPriceOverride: override,
    gratuityRate,
    tipJar,
  });

  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, total_price_override, amount_paid, gratuity_rate, tip_jar, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', $3, 'America/Chicago',
             $4, 'birthday-party', $5, $6, $7, $8::jsonb,
             $9, $10, $11, $12, $13, $14::jsonb)
     RETURNING id`,
    [clientId, pkg.id, durationHours, status, guestCount, numBars,
     snapshot.inputs.numBartenders, JSON.stringify(adjustments),
     snapshot.total, override, amountPaid, gratuityRate, tipJar, JSON.stringify(snapshot)]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);

  for (const sa of snapshot.addons) {
    // Store the ENGINE'S OUTPUT quantity, exactly as crud.js / proposalInsert.js
    // / public.js do. Seeding a hand-written raw count here is what hid the
    // per_hour squaring defect from this suite (push review, 2026-07-26).
    await pool.query(
      `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [proposalId, sa.id, sa.name, sa.billing_type, sa.rate, sa.quantity, sa.line_total, sa.variant ?? null]
    );
  }

  let planId = null;
  if (labAddedSlugs.length > 0 || Object.keys(labSyrups).length > 0) {
    const addOns = {};
    for (const slug of labAddedSlugs) addOns[slug] = { enabled: true, labAdded: true };
    const dp = await pool.query(
      `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
       VALUES ($1, 'submitted', $2::jsonb, $3, $4) RETURNING id`,
      [proposalId, JSON.stringify({ signatureDrinks: [], addOns, labSyrupSelections: labSyrups }),
       `LICancel ${NONCE}`, `licancel-${NONCE}@example.com`]
    );
    planId = dp.rows[0].id;
  }

  return { proposalId, planId, snapshot };
}

async function seedInvoice(proposalId, { label, dueCents, paidCents = 0, status = 'sent', locked = false }) {
  const r = await pool.query(
    `INSERT INTO invoices (proposal_id, invoice_number, label, amount_due, amount_paid, status, locked)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [proposalId, `INV${crypto.randomBytes(5).toString('hex')}`, label, dueCents, paidCents, status, locked]
  );
  return r.rows[0].id;
}

async function seedShiftWithApproved(proposalId, n) {
  const s = await pool.query(
    `INSERT INTO shifts (proposal_id, event_date, status) VALUES ($1, CURRENT_DATE + 30, 'confirmed') RETURNING id`,
    [proposalId]
  );
  for (let i = 0; i < n; i++) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
      [`${NONCE}-bt-${seededUsers.length}@example.test`]
    );
    seededUsers.push(u.rows[0].id);
    await pool.query(
      `INSERT INTO shift_requests (shift_id, user_id, position, status) VALUES ($1, $2, 'bartender', 'approved')`,
      [s.rows[0].id, u.rows[0].id]
    );
  }
  return s.rows[0].id;
}

// Run applyLineItemCancel inside a rolled-back transaction (the preview
// pattern): assertions run in-tx against uncommitted state, then everything
// unwinds so the shared dev DB never keeps mutations.
async function applyCancel(proposalId, opts, assertFn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyLineItemCancel(client, { proposalId, actorId: null, ...opts });
    await assertFn(result, client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

async function expectCancelError(proposalId, opts, matcher) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assert.rejects(
      applyLineItemCancel(client, { proposalId, actorId: null, ...opts }),
      matcher
    );
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------- Task 4 ---

test('parseCancelTarget accepts every kind and rejects junk', () => {
  assert.deepEqual(parseCancelTarget('addon:champagne-toast'), { kind: 'addon', key: 'champagne-toast' });
  assert.deepEqual(parseCancelTarget('bar'), { kind: 'bar', key: null });
  assert.deepEqual(parseCancelTarget('syrup:jalapeno'), { kind: 'syrup', key: 'jalapeno' });
  assert.deepEqual(parseCancelTarget('extra-bartender'), { kind: 'extra-bartender', key: null });
  assert.deepEqual(parseCancelTarget('adjustment:2'), { kind: 'adjustment', key: 2 });
  assert.deepEqual(parseCancelTarget('gratuity'), { kind: 'gratuity', key: null });
  // ValidationError carries the specific text in fieldErrors.target, not message.
  const rejects = (input, re) => assert.throws(
    () => parseCancelTarget(input),
    (err) => err.code === 'VALIDATION_ERROR' && re.test(String(err.fieldErrors?.target))
  );
  rejects('adjustment:x', /adjustment/i);
  rejects('addon:', /malformed/i);
  rejects('package:1', /malformed/i);
  rejects('drop-everything', /unknown/i);
  rejects('', /missing/i);
});

test('computeCancelTargets enumerates every client-visible line', async () => {
  const { proposalId } = await seedProposal({
    override: 2500,
    numBars: 2,
    numBartenders: 2, // required for 80 guests @1:100 is 1 -> one removable
    addons: [
      { slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 200, quantity: 2 },
      { slug: SLUGS.champagne, name: 'Champagne Toast', billingType: 'flat', rate: 150, quantity: 1 },
    ],
    labAddedSlugs: [SLUGS.champagne],
    syrups: ['jalapeno'],
    adjustments: [{ type: 'discount', label: 'Referral', amount: 50 }],
    gratuityRate: 25,
  });
  const { eligible, targets } = await computeCancelTargets(pool, proposalId);
  assert.equal(eligible, true);
  const byTarget = Object.fromEntries(targets.filter((t) => t.target).map((t) => [t.target, t]));
  assert.equal(byTarget['package'].cancellable, false);
  assert.equal(byTarget['package'].reason, 'event_cancel');
  assert.equal(byTarget['bar'].quantity, 2);
  assert.equal(byTarget[`addon:${SLUGS.photoBooth}`].quantity, 2);
  assert.equal(byTarget[`addon:${SLUGS.photoBooth}`].amount, 400); // engine: flat 200 x 2
  assert.equal(byTarget[`addon:${SLUGS.champagne}`].labOwned, true);
  assert.equal(byTarget[`addon:${SLUGS.champagne}`].quantity, undefined); // qty 1: no picker
  assert.ok(byTarget['syrup:jalapeno']);
  assert.equal(byTarget['extra-bartender'].count, 1);
  assert.equal(byTarget['adjustment:0'].amount, -50);
  assert.equal(byTarget['adjustment:0'].label, 'Referral');
  assert.equal(byTarget['gratuity'].rate, 25);
});

test('hosted proposal at included staffing offers NO extra-bartender target', async () => {
  const { proposalId } = await seedProposal({ numBartenders: 1 }); // floor for 80 guests
  const { targets } = await computeCancelTargets(pool, proposalId);
  assert.equal(targets.find((t) => t.target === 'extra-bartender'), undefined);
  const rb = removableBartenders({ pkg, guestCount: 80, durationHours: 4, actual: 1 });
  assert.equal(rb.removable, 0);
});

test('archived proposal is ineligible', async () => {
  const { proposalId } = await seedProposal({ status: 'archived' });
  const r = await computeCancelTargets(pool, proposalId);
  assert.deepEqual(r, { eligible: false, targets: [] });
  assert.ok(CANCEL_BLOCKED_STATUSES.includes('archived'));
});

test('orphaned addon row (addon_id NULL) is listed but not cancellable', async () => {
  const { proposalId } = await seedProposal({
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 200, quantity: 1 }],
  });
  await pool.query('UPDATE proposal_addons SET addon_id = NULL WHERE proposal_id = $1', [proposalId]);
  const { targets } = await computeCancelTargets(pool, proposalId);
  const orphan = targets.find((t) => t.reason === 'orphaned_addon');
  assert.ok(orphan);
  assert.equal(orphan.target, null);
  assert.equal(orphan.cancellable, false);
  assert.equal(orphan.label, 'Photo Booth');
});

// ---------------------------------------------------------------- Task 5 ---

test('addon full removal deletes the row and lowers an override contract by catalog price', async () => {
  const { proposalId } = await seedProposal({
    override: 2500,
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 200, quantity: 2 }],
  });
  await applyCancel(proposalId, { target: `addon:${SLUGS.photoBooth}` }, async (result, client) => {
    assert.equal(result.removedLabel, 'Photo Booth');
    assert.equal(result.newTotal, 2100); // 2500 - 200 x 2, flat at catalog
    const row = (await client.query('SELECT total_price, total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.total_price), 2100);
    assert.equal(Number(row.total_price_override), 2100);
    const addons = (await client.query('SELECT id FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows;
    assert.equal(addons.length, 0);
    assert.equal(result.overpaymentCents, 0); // amount_paid 100 < 2100
    const log = (await client.query(
      "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'line_item_cancelled'",
      [proposalId])).rows;
    assert.equal(log.length, 1);
    assert.equal(log[0].details.removed_label, 'Photo Booth');
    assert.equal(Number(log[0].details.new_total), 2100);
  });
});

test('addon partial removal lowers quantity; snapshot line and row line_total agree', async () => {
  const { proposalId } = await seedProposal({
    override: 2500,
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 200, quantity: 2 }],
  });
  await applyCancel(proposalId, { target: `addon:${SLUGS.photoBooth}`, quantity: 1 }, async (result, client) => {
    assert.equal(result.newTotal, 2300); // one 200 unit removed
    const row = (await client.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.quantity), 1);
    const snapEntry = result.snapshot.addons.find((a) => a.slug === SLUGS.photoBooth);
    assert.equal(Number(row.line_total), snapEntry.line_total);
    assert.equal(snapEntry.line_total, 200);
  });
});

test('quantity param rejected for per_staff addons', async () => {
  const { proposalId } = await seedProposal({
    addons: [{ slug: `perstaff-${NONCE}`, name: 'Staff Meal', billingType: 'per_staff', rate: 25, quantity: 1 }],
  });
  await expectCancelError(proposalId, { target: `addon:perstaff-${NONCE}`, quantity: 1 },
    (err) => err.code === 'VALIDATION_ERROR' && /a few at a time/i.test(String(err.fieldErrors?.quantity)));
});

test('bar removal drops num_bars and prices via additional_bar_fee', async () => {
  const { proposalId } = await seedProposal({ override: 2500, numBars: 2 });
  await applyCancel(proposalId, { target: 'bar', quantity: 1 }, async (result, client) => {
    // Second bar off: catalog delta = -additional_bar_fee (engine default 100).
    assert.equal(result.newTotal, 2400);
    const row = (await client.query('SELECT num_bars, total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(row.num_bars, 1);
    assert.equal(Number(row.total_price_override), 2400);
  });
});

test('syrup removal prunes snapshot selections and prices the pack delta', async () => {
  const { proposalId, snapshot: seeded } = await seedProposal({ override: 2500, syrups: ['jalapeno'] });
  const syrupTotal = Number(seeded.syrups.total);
  assert.ok(syrupTotal > 0, 'seeded syrup must carry real price');
  await applyCancel(proposalId, { target: 'syrup:jalapeno' }, async (result) => {
    assert.equal(result.newTotal, Math.round((2500 - syrupTotal) * 100) / 100);
    assert.deepEqual(result.snapshot.syrups.selections, []);
    assert.equal(result.labCleaned, false); // contract syrup, no drink plan involved
  });
});

test('extra-bartender default removal lands exactly on the staffing floor', async () => {
  const { proposalId } = await seedProposal({ numBartenders: 3 }); // floor for 80 guests is 1
  await applyCancel(proposalId, { target: 'extra-bartender' }, async (result, client) => {
    const row = (await client.query('SELECT num_bartenders FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(row.num_bartenders, 1);
    assert.equal(result.snapshot.staffing.extra, 0);
    assert.equal(result.snapshot.inputs.numBartenders, 1);
  });
});

test('extra-bartender quantity above removable is rejected; at-floor proposal conflicts', async () => {
  const { proposalId } = await seedProposal({ numBartenders: 3 });
  await expectCancelError(proposalId, { target: 'extra-bartender', quantity: 5 },
    (err) => err.code === 'VALIDATION_ERROR');
  const atFloor = await seedProposal({ numBartenders: 1 });
  await expectCancelError(atFloor.proposalId, { target: 'extra-bartender' },
    (err) => err.code === 'AT_STAFFING_FLOOR');
});

test('extra-bartender removal with approved heads above the new roster sets staffingWarning', async () => {
  const { proposalId } = await seedProposal({ numBartenders: 3 });
  await seedShiftWithApproved(proposalId, 3);
  await applyCancel(proposalId, { target: 'extra-bartender' }, async (result) => {
    assert.ok(result.staffingWarning, 'expected a staffing warning');
    assert.equal(result.staffingWarning.role, 'Bartender');
    assert.equal(result.staffingWarning.approved, 3);
    assert.equal(result.staffingWarning.desired, 1);
  });
});

test('adjustment removal of a discount RAISES the total', async () => {
  const { proposalId } = await seedProposal({
    override: 2500,
    adjustments: [{ type: 'discount', label: 'Referral', amount: 50 }],
  });
  await applyCancel(proposalId, { target: 'adjustment:0' }, async (result, client) => {
    assert.equal(result.removedLabel, 'Referral');
    assert.equal(result.newTotal, 2550); // removing a -50 discount raises
    assert.equal(result.overpaymentCents, 0);
    const row = (await client.query('SELECT adjustments FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.deepEqual(row.adjustments, []);
  });
});

test('discount removal with locked invoices mints an Additional Services invoice for the rise', async () => {
  const { proposalId } = await seedProposal({
    override: 2500,
    adjustments: [{ type: 'discount', label: 'Referral', amount: 50 }],
    amountPaid: 2500,
    status: 'balance_paid',
  });
  await seedInvoice(proposalId, { label: 'Balance', dueCents: 250000, paidCents: 250000, status: 'paid', locked: true });
  await applyCancel(proposalId, { target: 'adjustment:0' }, async (result, client) => {
    assert.equal(result.newTotal, 2550);
    const as = (await client.query(
      "SELECT amount_due FROM invoices WHERE proposal_id = $1 AND label = 'Additional Services' AND status != 'void'",
      [proposalId])).rows;
    assert.equal(as.length, 1);
    assert.equal(Number(as[0].amount_due), 5000); // exactly the rise, in cents
  });
});

test('discount removal with an unlocked Balance invoice mints NOTHING extra', async () => {
  const { proposalId } = await seedProposal({
    override: 2500,
    adjustments: [{ type: 'discount', label: 'Referral', amount: 50 }],
  });
  await seedInvoice(proposalId, { label: 'Balance', dueCents: 250000, status: 'sent', locked: false });
  await applyCancel(proposalId, { target: 'adjustment:0' }, async (result, client) => {
    const as = (await client.query(
      "SELECT id FROM invoices WHERE proposal_id = $1 AND label = 'Additional Services'",
      [proposalId])).rows;
    assert.equal(as.length, 0); // the refreshed Balance absorbs the rise
  });
});

test('gratuity full removal zeroes rate, flips tip_jar on, passes the DB CHECK', async () => {
  const { proposalId, snapshot: seeded } = await seedProposal({
    override: 2500, gratuityRate: 50, tipJar: false, // valid no-jar state at the floor
  });
  assert.ok(Number(seeded.gratuity.total) > 0);
  await applyCancel(proposalId, { target: 'gratuity' }, async (result, client) => {
    const row = (await client.query('SELECT gratuity_rate, tip_jar, total_price, total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.gratuity_rate), 0);
    assert.equal(row.tip_jar, true); // the only valid state under the CHECK
    assert.equal(Number(row.total_price), 2500); // gratuity line gone, service contract stands
    assert.equal(Number(row.total_price_override), 2500); // serviceOf strips gratuity: override untouched
    assert.deepEqual(result.gratuity, { newRate: 0, tipJarAfter: true, staffNotice: true });
    assert.equal(result.newTotal, 2500);
  });
});

test('gratuity lower to 30 forces the jar on with notice (below the $50 floor)', async () => {
  const { proposalId } = await seedProposal({ gratuityRate: 50, tipJar: false });
  await applyCancel(proposalId, { target: 'gratuity', newRate: 30 }, async (result, client) => {
    const row = (await client.query('SELECT gratuity_rate, tip_jar FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.gratuity_rate), 30);
    assert.equal(row.tip_jar, true);
    assert.deepEqual(result.gratuity, { newRate: 30, tipJarAfter: true, staffNotice: true });
  });
});

test('gratuity lower to 60 from 80 with jar off: no flip, no notice', async () => {
  const { proposalId } = await seedProposal({ gratuityRate: 80, tipJar: false });
  await applyCancel(proposalId, { target: 'gratuity', newRate: 60 }, async (result, client) => {
    const row = (await client.query('SELECT gratuity_rate, tip_jar FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.gratuity_rate), 60);
    assert.equal(row.tip_jar, false); // 60 >= 50: the no-jar state stays valid
    assert.deepEqual(result.gratuity, { newRate: 60, tipJarAfter: false, staffNotice: false });
  });
});

test('gratuity raise (or equal) rejected', async () => {
  const { proposalId } = await seedProposal({ gratuityRate: 25 });
  await expectCancelError(proposalId, { target: 'gratuity', newRate: 40 },
    (err) => err.code === 'VALIDATION_ERROR');
  await expectCancelError(proposalId, { target: 'gratuity', newRate: 25 },
    (err) => err.code === 'VALIDATION_ERROR');
});

test('package target throws PACKAGE_IS_EVENT_CANCEL', async () => {
  const { proposalId } = await seedProposal({});
  await expectCancelError(proposalId, { target: 'package' },
    (err) => err.code === 'PACKAGE_IS_EVENT_CANCEL');
});

test('archived proposal throws NOT_CANCELLABLE', async () => {
  const { proposalId } = await seedProposal({ status: 'archived' });
  await expectCancelError(proposalId, { target: 'bar' },
    (err) => err.code === 'NOT_CANCELLABLE');
});

test('stale fingerprint throws STALE_PREVIEW', async () => {
  const { proposalId } = await seedProposal({
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 200, quantity: 1 }],
  });
  await expectCancelError(proposalId, {
    target: `addon:${SLUGS.photoBooth}`,
    expectFingerprint: { updated_at: '1999-01-01T00:00:00.000Z', amount_paid: 100, total_price: 1 },
  }, (err) => err.code === 'STALE_PREVIEW');
});

test('lab-added addon removal strips drink_plans.selections and reports labCleaned', async () => {
  const { proposalId, planId } = await seedProposal({
    addons: [{ slug: SLUGS.champagne, name: 'Champagne Toast', billingType: 'flat', rate: 150, quantity: 1 }],
    labAddedSlugs: [SLUGS.champagne],
    labSyrups: { 'drink-x': ['jalapeno'] },
  });
  await applyCancel(proposalId, { target: `addon:${SLUGS.champagne}` }, async (result, client) => {
    assert.equal(result.labCleaned, true);
    assert.equal(result.labPlanId, planId);
    const sel = (await client.query('SELECT selections FROM drink_plans WHERE id = $1', [planId])).rows[0].selections;
    assert.equal(sel.addOns[SLUGS.champagne], undefined);
    assert.deepEqual(sel.labSyrupSelections, { 'drink-x': ['jalapeno'] }); // untouched
  });
});

test('lab syrup removal strips labSyrupSelections for that syrup id', async () => {
  const { proposalId, planId } = await seedProposal({
    syrups: ['jalapeno'],
    labSyrups: { 'drink-x': ['jalapeno'] },
  });
  await applyCancel(proposalId, { target: 'syrup:jalapeno' }, async (result, client) => {
    assert.equal(result.labCleaned, true);
    const sel = (await client.query('SELECT selections FROM drink_plans WHERE id = $1', [planId])).rows[0].selections;
    assert.deepEqual(sel.labSyrupSelections, {}); // emptied array dropped
  });
});

test('fully-paid removal computes overpaymentCents without demotion', async () => {
  const { proposalId } = await seedProposal({
    override: 2500, amountPaid: 2500, status: 'balance_paid',
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 200, quantity: 1 }],
  });
  await applyCancel(proposalId, { target: `addon:${SLUGS.photoBooth}` }, async (result) => {
    assert.equal(result.newTotal, 2300);
    assert.equal(result.overpaymentCents, 20000); // paid 2500 vs new total 2300
    assert.equal(result.statusChanged, false);    // demote-only ladder: still fully paid
    assert.equal(result.newStatus, 'balance_paid');
  });
});

test('open Additional Services invoice reconciles down to the remainder; locked invoices stand', async () => {
  const { proposalId } = await seedProposal({
    override: 2500, amountPaid: 2300, status: 'balance_paid',
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 200, quantity: 1 }],
  });
  const lockedId = await seedInvoice(proposalId, { label: 'Balance', dueCents: 230000, paidCents: 230000, status: 'paid', locked: true });
  const asId = await seedInvoice(proposalId, { label: 'Additional Services', dueCents: 15000, status: 'sent', locked: false });
  await applyCancel(proposalId, { target: `addon:${SLUGS.photoBooth}` }, async (result, client) => {
    assert.equal(result.newTotal, 2300);
    // headroom = 230000 - 0 external - 230000 locked - 0 others = 0 -> AS zeroes
    assert.deepEqual(result.deltaInvoicesAdjusted, [{ id: asId, label: 'Additional Services', fromCents: 15000, toCents: 0 }]);
    const as = (await client.query('SELECT amount_due FROM invoices WHERE id = $1', [asId])).rows[0];
    assert.equal(Number(as.amount_due), 0);
    const lines = (await client.query('SELECT id FROM invoice_line_items WHERE invoice_id = $1', [asId])).rows;
    assert.equal(lines.length, 0);
    const locked = (await client.query('SELECT amount_due FROM invoices WHERE id = $1', [lockedId])).rows[0];
    assert.equal(Number(locked.amount_due), 230000); // never touched
    assert.ok(result.lockedInvoices.some((i) => i.id === lockedId && i.amount_due === 230000));
  });
});

// ---------------------------------------------------------------- Task 6 ---

test('gratuity staff notice emails approved non-dropped staff and logs the activity row', async () => {
  const { proposalId } = await seedProposal({ gratuityRate: 50, tipJar: false });
  const shiftId = await seedShiftWithApproved(proposalId, 2);
  // One dropped staffer who must NOT be notified.
  const dropped = await pool.query(
    `INSERT INTO users (email, password_hash, role) VALUES ($1, 'x', 'staff') RETURNING id`,
    [`${NONCE}-dropped@example.test`]
  );
  seededUsers.push(dropped.rows[0].id);
  await pool.query(
    `INSERT INTO shift_requests (shift_id, user_id, position, status, dropped_at)
     VALUES ($1, $2, 'bartender', 'approved', NOW())`,
    [shiftId, dropped.rows[0].id]
  );

  const notice = require('./gratuityStaffNotice');
  const sends = [];
  notice.__setDeps({ sendEmail: async (args) => { sends.push(args); return { id: 'stub' }; } });
  try {
    const r = await notice.sendGratuityRemovedStaffNotice({ proposalId, newRate: 0 });
    assert.equal(r.sent, 2);
    assert.equal(r.failed, 0);
    assert.equal(sends.length, 2);
    assert.match(sends[0].subject, /tip jar update/i);
    assert.match(sends[0].text, /was removed/i);
    assert.match(sends[0].text, /tip jar/i);
    const log = (await pool.query(
      "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'gratuity_removed_staff_notified'",
      [proposalId])).rows;
    assert.equal(log.length, 1);
    assert.equal(log[0].details.sent, 2);
    assert.equal(log[0].details.recipients.length, 2);
    assert.ok(!log[0].details.recipients.includes(dropped.rows[0].id));
  } finally {
    notice.__setDeps({ sendEmail: require('./email').sendEmail });
  }
});

test('gratuity staff notice with zero recipients is a clean no-op that still logs', async () => {
  const { proposalId } = await seedProposal({ gratuityRate: 50, tipJar: false });
  const notice = require('./gratuityStaffNotice');
  const r = await notice.sendGratuityRemovedStaffNotice({ proposalId, newRate: 30 });
  assert.deepEqual(r, { sent: 0, failed: 0 });
  const log = (await pool.query(
    "SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = 'gratuity_removed_staff_notified'",
    [proposalId])).rows;
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].details.recipients, []);
  assert.equal(log[0].details.new_rate, 30);
});

test('per_hour partial removal: the picker counts UNITS and the row stays in stored shape', async () => {
  // 3 banquet servers on a 4h event: the engine stores 12 (hours x count) and
  // charges 4h x 75 x 3 = 900. Removing ONE server must leave 2 servers: a
  // stored 8, a $600 line, and $300 off the contract. The pre-2026-07-26 code
  // read the stored 12 as "12 units" and subtracted 1 to get 11, i.e. 2.75
  // servers.
  const slug = `perhour-${NONCE}`;
  const { proposalId } = await seedProposal({
    override: 2500,
    addons: [{ slug, name: 'Banquet Server X', billingType: 'per_hour', rate: 75, quantity: 3 }],
  });
  const seeded = (await pool.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(seeded.quantity), 12, 'stored = 4 hours x 3 servers');
  assert.equal(Number(seeded.line_total), 900);

  const { targets } = await computeCancelTargets(pool, proposalId);
  const t = targets.find((x) => x.target === `addon:${slug}`);
  assert.equal(t.quantity, 3, 'the picker offers 3 SERVERS, not 12');
  assert.equal(t.billed_unit, 'hour', 'how the line is BILLED, not the unit of the 3');

  await applyCancel(proposalId, { target: `addon:${slug}`, quantity: 1 }, async (result, client) => {
    const row = (await client.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.quantity), 8, 'stored = 4 hours x 2 remaining servers');
    const entry = result.snapshot.addons.find((a) => a.slug === slug);
    assert.equal(Number(row.quantity), entry.quantity, 'row and snapshot agree');
    assert.equal(Number(row.line_total), entry.line_total);
    assert.equal(entry.line_total, 600);
    assert.equal(result.newTotal, 2200, 'one server off a 2500 override = -300');

    // The corruption gate: repricing from the row must reproduce 2 servers.
    const { loadRepriceAddons } = require('./proposalExtrasFold');
    const reload = await loadRepriceAddons(client, proposalId);
    assert.equal(reload.find((a) => a.slug === slug).quantity, 2);
  });
});

test('removing ALL units of a per_hour addon deletes the row', async () => {
  const slug = `perhour-all-${NONCE}`;
  const { proposalId } = await seedProposal({
    override: 2500,
    addons: [{ slug, name: 'Banquet Server All', billingType: 'per_hour', rate: 75, quantity: 2 }],
  });
  await applyCancel(proposalId, { target: `addon:${slug}` }, async (result, client) => {
    const rows = (await client.query('SELECT id FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows;
    assert.equal(rows.length, 0);
    assert.equal(result.newTotal, 2500 - 600, 'both servers off: 4h x 75 x 2');
  });
});

test('per_hour under its minimum_hours: picker and write-back use the BILLED hours', async () => {
  // 2 banquet servers on a 2h event with a 4h minimum. The engine bills 4 hours
  // and stores 8. Dividing by the RAW 2 (what happens whenever the row is loaded
  // without sa.minimum_hours) recovers FOUR units, so the picker offers to
  // remove 4 servers from a proposal that has 2, and removing 1 writes back 6,
  // which the fold reads as 2 servers: the removal does nothing and the client
  // is still billed for both. The event must be well under the minimum for this
  // to bite; a 3.5h event rounds back to the right answer on its own.
  const slug = `perhour-min-${NONCE}`;
  const { proposalId } = await seedProposal({
    override: 2500,
    durationHours: 2,
    addons: [{ slug, name: 'Banquet Server Min', billingType: 'per_hour', rate: 75, quantity: 2, minimumHours: 4 }],
  });
  const seeded = (await pool.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(seeded.quantity), 8, 'stored = 4 BILLED hours x 2 servers, not 2 x 2');
  assert.equal(Number(seeded.line_total), 600);

  const { targets } = await computeCancelTargets(pool, proposalId);
  const t = targets.find((x) => x.target === `addon:${slug}`);
  assert.equal(t.quantity, 2, 'the picker offers 2 SERVERS, not 4');

  await applyCancel(proposalId, { target: `addon:${slug}`, quantity: 1 }, async (result, client) => {
    const row = (await client.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.quantity), 4, 'stored = 4 BILLED hours x 1 remaining server');
    assert.equal(Number(row.line_total), 300);
    assert.equal(result.newTotal, 2200, 'one server off a 2500 override = -300, not a no-op');
  });
});

test('additional-bartender: the bespoke raw-duration branch converts end to end', async () => {
  // The one slug the engine prices in its OWN branch (pricingEngine.js:386-406):
  // it stores durationHours x qty and multiplies by RAW duration, never
  // minimum_hours, and BOTH storedToInputCount and effectiveHoursFor dispatch on
  // that slug ahead of billing_type to mirror it. Uses the REAL catalog slug on
  // purpose: the engine branch AND the sub-100-guest gratuity basis key on that
  // exact string, so a nonce slug would price through calculateAddonCost and
  // prove nothing. seedCatalogAddon reuses the live row and never deletes it, so
  // the billingType/rate below are documentation, not the values in play.
  const slug = 'additional-bartender';
  const { proposalId } = await seedProposal({
    override: 2500,
    addons: [{ slug, name: 'Additional Bartender', billingType: 'per_hour', rate: 40, quantity: 3 }],
  });
  // 80 guests puts the $15/hr sub-100 gratuity surcharge on top of the $40 rate.
  const seeded = (await pool.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(seeded.quantity), 12, 'stored = 4 hours x 3 bartenders');
  assert.equal(Number(seeded.line_total), 660, '3 x 4h x (40 + 15)');

  const { targets } = await computeCancelTargets(pool, proposalId);
  const t = targets.find((x) => x.target === `addon:${slug}`);
  assert.equal(t.quantity, 3, 'the picker offers 3 BARTENDERS, not 12');
  assert.equal(t.billed_unit, 'hour');

  await applyCancel(proposalId, { target: `addon:${slug}`, quantity: 1 }, async (result, client) => {
    const row = (await client.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.quantity), 8, 'stored = 4 hours x 2 remaining bartenders');
    assert.equal(Number(row.line_total), 440, '2 x 4h x (40 + 15)');
    const { loadRepriceAddons } = require('./proposalExtrasFold');
    const reload = await loadRepriceAddons(client, proposalId);
    assert.equal(reload.find((a) => a.slug === slug).quantity, 2, 'the fold recovers 2 bartenders');
    assert.equal(result.newTotal, 2280, 'one bartender off a 2500 override = -220');
  });
});

test('per_100_guests offers NO picker and refuses a partial removal', async () => {
  // The one deliberate behavior change in this lane. The old quantityIsCount let
  // per_100_guests through, so the picker offered "remove 1 of 3 blocks", which
  // removed nothing: the engine recomputes blocks from guestCount. Whole line
  // only now. 250 guests = 3 blocks, so the OLD code WOULD have shown a picker.
  const slug = `per100-${NONCE}`;
  const { proposalId } = await seedProposal({
    guestCount: 250,
    addons: [{ slug, name: 'Garnish Per Hundred', billingType: 'per_100_guests', rate: 50, quantity: 1 }],
  });
  const seeded = (await pool.query('SELECT quantity FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(seeded.quantity), 3, 'stored = ceil(250 / 100) blocks, not a unit count');

  const { targets } = await computeCancelTargets(pool, proposalId);
  const t = targets.find((x) => x.target === `addon:${slug}`);
  assert.equal(t.quantity, undefined, 'no picker: blocks are not a removable count');
  assert.equal(t.billed_unit, undefined);

  await expectCancelError(proposalId, { target: `addon:${slug}`, quantity: 1 },
    (err) => err.code === 'VALIDATION_ERROR' && /a few at a time/i.test(String(err.fieldErrors?.quantity)));
});

test('extra-bartender target label matches the engine breakdown row EXACTLY', async () => {
  // Anti-drift pin for the 2026-07-26 mis-bind: the admin UI binds a remove
  // button to its money row by label + amount, so this target's label must be
  // byte-identical to the row pricingEngine emits. A hand-written label here
  // matched no row, orphaned the control, and let the neighbouring
  // additional-bartender add-on row claim a button that removed the wrong line.
  const { proposalId, snapshot } = await seedProposal({ numBartenders: 3 });
  const { targets } = await computeCancelTargets(pool, proposalId);
  const t = targets.find((x) => x.target === 'extra-bartender');
  assert.ok(t, 'expected an extra-bartender target');
  const row = snapshot.breakdown.find((b) => b.label === t.label);
  assert.ok(row, `no breakdown row matches target label "${t.label}" (labels: ${snapshot.breakdown.map((b) => b.label).join(' | ')})`);
  assert.equal(Math.round(Number(row.amount) * 100), Math.round(Number(t.amount) * 100),
    'amount must corroborate the label, or the UI refuses to bind');
});

// ── overpaymentCents netting: "not in total_price", NOT "∉ CONTRACT_LABELS" ──

test('overpaymentCents nets out PAID syrup-only Drink Plan Extras', async () => {
  // Syrup-only extras took the fast path and never folded into total_price
  // (submit.js: "syrups are additive money that never fold into total_price"),
  // so this money is not overpayment and must not be offered to Stripe.
  const { proposalId } = await seedProposal({
    override: 400, amountPaid: 460, status: 'balance_paid',
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 100, quantity: 1 }],
  });
  await seedInvoice(proposalId, { label: 'Balance', dueCents: 40000, paidCents: 40000, status: 'paid', locked: true });
  const extrasId = await seedInvoice(proposalId, { label: 'Drink Plan Extras', dueCents: 6000, paidCents: 6000, status: 'paid', locked: true });
  // Syrup-only: a single non-addon, non-bar line.
  await pool.query(
    `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type)
     VALUES ($1, 'Strawberry syrup', 1, 6000, 6000, 'manual')`, [extrasId]
  );

  await applyCancel(proposalId, { target: `addon:${SLUGS.photoBooth}` }, async (result) => {
    const raw = Math.round(460 * 100) - Math.round(result.newTotal * 100);
    assert.ok(raw > 6000, 'fixture must produce an apparent overpayment');
    assert.equal(result.overpaymentCents, raw - 6000, 'the paid syrup money must be netted out');
  });
});

test('overpaymentCents does NOT net out PAID Additional Services (it IS in total_price)', async () => {
  // The regression this pins: netting by ∉ CONTRACT_LABELS treated Additional
  // Services as off-contract and under-refunded the client by its full amount.
  const { proposalId } = await seedProposal({
    override: 400, amountPaid: 460, status: 'balance_paid',
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 100, quantity: 1 }],
  });
  await seedInvoice(proposalId, { label: 'Balance', dueCents: 40000, paidCents: 40000, status: 'paid', locked: true });
  await seedInvoice(proposalId, { label: 'Additional Services', dueCents: 6000, paidCents: 6000, status: 'paid', locked: true });

  await applyCancel(proposalId, { target: `addon:${SLUGS.photoBooth}` }, async (result) => {
    const raw = Math.round(460 * 100) - Math.round(result.newTotal * 100);
    assert.equal(result.overpaymentCents, raw, 'contract money must stay refundable');
  });
});

test('overpaymentCents does NOT net out a FOLDED Drink Plan Extras invoice', async () => {
  // An extras invoice carrying an add-on line went through the submit
  // transaction path, where the whole extras folded into total_price. Same
  // label as the syrup case, opposite answer: the line items decide.
  const { proposalId } = await seedProposal({
    override: 400, amountPaid: 460, status: 'balance_paid',
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 100, quantity: 1 }],
  });
  await seedInvoice(proposalId, { label: 'Balance', dueCents: 40000, paidCents: 40000, status: 'paid', locked: true });
  const extrasId = await seedInvoice(proposalId, { label: 'Drink Plan Extras', dueCents: 6000, paidCents: 6000, status: 'paid', locked: true });
  await pool.query(
    `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, line_total, source_type)
     VALUES ($1, 'Champagne Toast', 1, 6000, 6000, 'addon')`, [extrasId]
  );

  await applyCancel(proposalId, { target: `addon:${SLUGS.photoBooth}` }, async (result) => {
    const raw = Math.round(460 * 100) - Math.round(result.newTotal * 100);
    assert.equal(result.overpaymentCents, raw, 'folded extras money IS contract money');
  });
});

test('overpaymentCents nets out a PAID free-text manual invoice', async () => {
  const { proposalId } = await seedProposal({
    override: 400, amountPaid: 460, status: 'balance_paid',
    addons: [{ slug: SLUGS.photoBooth, name: 'Photo Booth', billingType: 'flat', rate: 100, quantity: 1 }],
  });
  await seedInvoice(proposalId, { label: 'Balance', dueCents: 40000, paidCents: 40000, status: 'paid', locked: true });
  await seedInvoice(proposalId, { label: 'Damage Fee', dueCents: 6000, paidCents: 6000, status: 'paid', locked: true });

  await applyCancel(proposalId, { target: `addon:${SLUGS.photoBooth}` }, async (result) => {
    const raw = Math.round(460 * 100) - Math.round(result.newTotal * 100);
    assert.equal(result.overpaymentCents, raw - 6000, 'a damage fee is not contract money');
  });
});
