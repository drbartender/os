require('dotenv').config();

// REPRICE STABILITY: a fold whose before/after legs are IDENTICAL must not move
// money, for every billing type. This is the invariant that catches the whole
// family of stored-quantity-vs-input-count bugs, and the one the earlier
// per_hour test missed because it seeded a hand-written raw count instead of
// the shape the writers actually store.
//
// Fixtures store add-on rows EXACTLY as crud.js / proposalInsert.js /
// public.js do: `snapshot.addons[].quantity`, the engine's OUTPUT.
//   node -r dotenv/config --test server/utils/proposalExtrasFold.stability.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { calculateProposal } = require('./pricingEngine');
const { foldExtrasIntoProposal, loadRepriceAddons } = require('./proposalExtrasFold');

if (process.env.NODE_ENV === 'production') {
  throw new Error('proposalExtrasFold.stability.test.js refuses to run against production');
}

const NONCE = `stab-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let clientId;
let pkg;
const seededProposals = [];
const seededAddons = [];

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id",
    [`Stability ${NONCE}`, `stab-${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'Stability Pkg', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]') RETURNING id`,
    [`stab-${NONCE}`]
  );
  pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [p.rows[0].id])).rows[0];
});

after(async () => {
  for (const pid of seededProposals) {
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id = $1', [pid]);
  }
  for (const aid of seededAddons) await pool.query('DELETE FROM service_addons WHERE id = $1', [aid]);
  if (pkg) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.id]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

async function catalogAddonFor(spec) {
  if (spec.existingSlug) {
    // A REAL catalog row, needed when the engine branches on the slug itself
    // (additional-bartender). Never pushed to seededAddons: teardown must not
    // delete a live catalog row.
    const r = await pool.query('SELECT * FROM service_addons WHERE slug = $1 AND is_active = true', [spec.existingSlug]);
    assert.ok(r.rows[0], `dev DB has the ${spec.existingSlug} addon`);
    return r.rows[0];
  }
  const r = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active, minimum_hours)
     VALUES ($1, $2, $3, $4, 'all', true, $5) RETURNING *`,
    [spec.slug, spec.name, spec.billingType, spec.rate, spec.minimumHours ?? null]
  );
  seededAddons.push(r.rows[0].id);
  return r.rows[0];
}

/**
 * Seed a proposal the way the ADMIN EDITOR does: price with the engine, then
 * store snapshot.addons[].quantity (the engine's OUTPUT) into proposal_addons.
 * This is crud.js:610-620 verbatim in miniature.
 */
async function seedPricedProposal({
  addonSpecs, durationHours = 4, guestCount = 80, override = null, gratuityRate = 0,
  gratuityFloorRate = null,
}) {
  const engineAddons = [];
  for (const s of addonSpecs) {
    const cat = await catalogAddonFor(s);
    engineAddons.push({ ...cat, quantity: s.count });
  }
  const snapshot = calculateProposal({
    pkg, guestCount, durationHours, numBars: 0, numBartenders: null,
    addons: engineAddons, syrupSelections: [], adjustments: [],
    totalPriceOverride: override, gratuityRate, tipJar: true, gratuityFloorRate,
  });
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, total_price_override, gratuity_rate, tip_jar, amount_paid, pricing_snapshot,
        gratuity_floor_rate)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', $3, 'America/Chicago',
             'deposit_paid', 'other', $4, 0, $5, '[]'::jsonb, $6, $7, $8, true, 100, $9::jsonb, $10)
     RETURNING id`,
    [clientId, pkg.id, durationHours, guestCount, snapshot.inputs.numBartenders,
     snapshot.total, override, gratuityRate, JSON.stringify(snapshot), gratuityFloorRate]
  );
  const proposalId = p.rows[0].id;
  seededProposals.push(proposalId);
  for (const a of snapshot.addons) {
    await pool.query(
      `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [proposalId, a.id, a.name, a.billing_type, a.rate, a.quantity, a.line_total, a.variant ?? null]
    );
  }
  return { proposalId, snapshot };
}

/** Run a fold with IDENTICAL legs and return before/after totals. */
async function noOpFold(proposalId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proposal = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
    const legs = await loadRepriceAddons(client, proposalId);
    const { snapshot } = await foldExtrasIntoProposal({
      client, proposal, pkg,
      addonsBefore: legs, addonsAfter: legs,
      syrupsBefore: [], syrupsAfter: [],
      numBarsBefore: proposal.num_bars ?? 0, numBarsAfter: proposal.num_bars ?? 0,
      statusChangeReason: 'stability probe',
    });
    return { before: Number(proposal.total_price), after: Number(snapshot.total), snapshot };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

test('per_hour add-on: a no-op fold does not move money', async () => {
  // 1 banquet server on a 6h event. Prod shape (proposal 624): stored 6.00,
  // line_total 450. Feeding 6 back as a COUNT reprices it as 6 servers.
  const { proposalId } = await seedPricedProposal({
    durationHours: 6,
    addonSpecs: [{ slug: `stab-srv-${NONCE}`, name: 'Stability Server', billingType: 'per_hour', rate: 75, count: 1 }],
  });
  const stored = (await pool.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(stored.quantity), 6, 'engine OUTPUT quantity is hours x count');
  assert.equal(Number(stored.line_total), 450);

  const { before, after, snapshot } = await noOpFold(proposalId);
  assert.equal(after, before, `no-op fold moved the total from ${before} to ${after}`);
  assert.equal(Number(snapshot.addons[0].line_total), 450);
  assert.equal(Number(snapshot.addons[0].quantity), 6, 'and it re-emits the same stored shape');
});

test('per_hour with count > 1 and a minimum_hours floor: stable', async () => {
  // 2 servers, 2h event, 4h minimum: engine bills 4h, stores 8.
  const { proposalId } = await seedPricedProposal({
    durationHours: 2,
    addonSpecs: [{ slug: `stab-min-${NONCE}`, name: 'Stability Min', billingType: 'per_hour', rate: 75, count: 2, minimumHours: 4 }],
  });
  const stored = (await pool.query('SELECT quantity FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(stored.quantity), 8);
  const { before, after } = await noOpFold(proposalId);
  assert.equal(after, before);
});

test('flat add-on with quantity 2: stable (the type that already round-tripped)', async () => {
  const { proposalId } = await seedPricedProposal({
    addonSpecs: [{ slug: `stab-flat-${NONCE}`, name: 'Stability Flat', billingType: 'flat', rate: 200, count: 2 }],
  });
  const { before, after, snapshot } = await noOpFold(proposalId);
  assert.equal(after, before);
  assert.equal(Number(snapshot.addons[0].line_total), 400);
});

test('per_guest add-on at count 2: stable (the count lives in line_total)', async () => {
  // Seeded at TWO deliberately. At count 1 this test compares 1 against 1 and
  // CANNOT fail, and that false negative certified a live defect as safe:
  // prod proposal 482 carries a Pre-Batched Mocktail at a real count of 2
  // (quantity 50 = guestCount, rate 2.00, line_total 200.00), and a no-op fold
  // reprices it to $100. per_guest stores guestCount in `quantity`, so the count
  // survives only in line_total and is recovered as line_total / (quantity x
  // rate), the same inversion the admin editor already uses (formState.js:92-98).
  const { proposalId } = await seedPricedProposal({
    addonSpecs: [{ slug: `stab-guest-${NONCE}`, name: 'Stability Guest', billingType: 'per_guest', rate: 5, count: 2 }],
  });
  const stored = (await pool.query('SELECT quantity, line_total FROM proposal_addons WHERE proposal_id = $1', [proposalId])).rows[0];
  assert.equal(Number(stored.quantity), 80, 'per_guest stores the guest count, not the unit count');
  assert.equal(Number(stored.line_total), 800, '80 guests x $5 x 2 units');

  const { before, after, snapshot } = await noOpFold(proposalId);
  assert.equal(after, before, `no-op fold moved the total from ${before} to ${after}`);
  assert.equal(Number(snapshot.addons[0].line_total), 800, 'and it re-emits BOTH units');
});

test('override + gratuity: a no-op fold does not move the gratuity line', async () => {
  // The channel the add-on line alone hides, and the reason this test exists at
  // all. On an override proposal the add-on inflation CANCELS in the fold's
  // catalog delta, so total_price looks safe. But gratuity is layered on TOP of
  // the override (pricingEngine.js:441-443) and its staff basis reads the SAME
  // input quantity (pricingEngine.js:369, :437). Two addon bartenders on a 4h
  // event store 8; read back as 8 HEADS the basis goes 3 to 9 and the gratuity
  // line roughly triples with the override untouched.
  // Uses the REAL additional-bartender slug: both the engine branch and the
  // gratuity basis key on that exact string, so a nonce slug proves nothing.
  const { proposalId, snapshot: seeded } = await seedPricedProposal({
    durationHours: 4,
    override: 3000,
    gratuityRate: 60,
    addonSpecs: [{ existingSlug: 'additional-bartender', count: 2 }],
  });
  const stored = (await pool.query(
    `SELECT pa.quantity FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id
      WHERE pa.proposal_id = $1 AND sa.slug = 'additional-bartender'`,
    [proposalId]
  )).rows[0];
  assert.equal(Number(stored.quantity), 8, 'stored = 4 hours x 2 bartenders');

  const { before, after, snapshot } = await noOpFold(proposalId);
  assert.equal(after, before, `no-op fold moved the total from ${before} to ${after}`);
  assert.equal(snapshot.gratuity.staff_count, seeded.gratuity.staff_count,
    'the gratuity staff basis is a HEADCOUNT and must not move on a no-op fold');
});

test('TWO folds in a row: the second reads what the first wrote (no slow drift)', async () => {
  // Both folds run in ONE transaction on purpose. noOpFold ROLLBACKs, so
  // calling it twice would just repeat the first test from identical state and
  // prove nothing about drift.
  // Nor is total_price the vector: the fold never reads it back. Drift shows
  // only when the second fold reads the QUANTITY the first one persisted,
  // which is why the loop below re-stores it.
  const { proposalId } = await seedPricedProposal({
    durationHours: 5,
    addonSpecs: [{ slug: `stab-twice-${NONCE}`, name: 'Stability Twice', billingType: 'per_hour', rate: 40, count: 2 }],
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rounds = [];
    for (let i = 0; i < 2; i++) {
      const proposal = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
      const legs = await loadRepriceAddons(client, proposalId);
      const { snapshot } = await foldExtrasIntoProposal({
        client, proposal, pkg,
        addonsBefore: legs, addonsAfter: legs,
        syrupsBefore: [], syrupsAfter: [],
        numBarsBefore: proposal.num_bars ?? 0, numBarsAfter: proposal.num_bars ?? 0,
        statusChangeReason: 'stability probe',
      });
      rounds.push({ before: Number(proposal.total_price), after: Number(snapshot.total) });
      // Re-persist the row the way every WRITER does (crud.js:608-620, and the
      // re-sync Task 5 adds): snapshot.addons[].quantity back onto the row.
      // Without this the second fold re-reads an untouched stored value and
      // recomputes bit-identically, so the test silently collapses into the
      // first one. THIS is the compounding vector: pre-fix, round 1 stores 50
      // and round 2 bills 5h x $40 x 50 on top of the base.
      for (const entry of snapshot.addons || []) {
        await client.query(
          'UPDATE proposal_addons SET quantity = $1, line_total = $2 WHERE proposal_id = $3 AND addon_id = $4',
          [entry.quantity, entry.line_total, proposalId, entry.id]
        );
      }
    }
    assert.equal(rounds[0].after, rounds[0].before, 'the first fold moved the total');
    assert.equal(rounds[1].after, rounds[1].before,
      `the second fold compounded: ${rounds[1].before} to ${rounds[1].after}`);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
});

test('admin gratuity mandate: a fold preserves snapshot gratuity.floor_rate (spec 2026-08-10)', async () => {
  const { proposalId, snapshot: seeded } = await seedPricedProposal({
    addonSpecs: [{ slug: `stab-mand-${NONCE}`, name: 'Stability Mandate', billingType: 'per_hour', rate: 75, count: 1 }],
    gratuityRate: 25, gratuityFloorRate: 25,
  });
  assert.equal(seeded.gratuity.floor_rate, 25, 'seed snapshot carries the floor');

  const { before, after, snapshot } = await noOpFold(proposalId);
  assert.equal(after, before, 'no-op fold still moves no money on a mandated row');
  assert.equal(snapshot.gratuity.floor_rate, 25,
    'fold must carry the row floor into the recomputed snapshot (a null here strips the mandate client-side)');
  assert.equal(snapshot.gratuity.rate, 25, 'stored rate preserved');
});
