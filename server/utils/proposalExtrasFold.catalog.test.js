require('dotenv').config();

// The shared catalog compute (plan 2026-10-16-price-override-removal, Task F2;
// spec section 8.2). computeCatalogSnapshot(client, proposal, { adjustments })
// is the engine output for a booking's CURRENT inputs at today's catalog with no
// override; the override conversion calls it for the live bookings, and the
// fold keeps calling the same engine-args builder for its own compute. Not a
// copy: these tests pin that the conversion's compute hands the engine EXACTLY
// the inputs the fold hands it for the same booking, and that the snapshot
// equals the one the fold writes.
//
// The engine is wrapped BEFORE proposalExtrasFold loads (it destructures
// calculateProposal at load), so every call either side makes is recorded and
// compared argument for argument. Fixtures are rich on purpose: three add-on
// billing types, two syrups, a bar count, an explicit bartender count, a hidden
// line with a string amount, a gratuity mandate without a tip jar, and a settled
// extension that moves the row's hours off the contract's.
// Each test runs in its own transaction and rolls back. Run ALONE against the
// shared dev DB:
//   node --test server/utils/proposalExtrasFold.catalog.test.js
const engine = require('./pricingEngine');

const realCalculate = engine.calculateProposal;
const engineCalls = [];
engine.calculateProposal = (args) => {
  engineCalls.push(structuredClone(args));
  return realCalculate(args);
};

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const {
  foldExtrasIntoProposal, loadRepriceAddons, computeCatalogSnapshot,
} = require('./proposalExtrasFold');

if (process.env.NODE_ENV === 'production') {
  throw new Error('proposalExtrasFold.catalog.test.js refuses to run against production');
}

const NONCE = `foldcat-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const CONTRACT_HOURS = 4;
const WORKED_HOURS = 5; // a paid extension added an hour on site
const SYRUPS = Object.freeze(['jalapeno', 'lavender']);
const LINES = Object.freeze([
  { type: 'discount', label: 'Test discount A', amount: '37.50', visible: true },
  { type: 'surcharge', label: 'Test surcharge B', amount: 20, visible: false },
]);
const OVERRIDE = 3456.78;
const cents = (n) => Math.round(Number(n) * 100);
// calculated_at is a wall-clock stamp, the one field two computes never share.
const strip = ({ calculated_at, ...rest }) => rest; // eslint-disable-line no-unused-vars

let clientId;
let pkg;
let bartenderAddon;
const seededAddons = [];
const seeded = new Map(); // name -> { id, snapshot }

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`Fold Catalog ${NONCE}`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  const p = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        extra_hour_rate, extra_hour_rate_small, min_guests, guests_per_bartender, bar_type, includes,
        first_bar_fee, additional_bar_fee)
     VALUES ($1, 'Fold Catalog Pkg', 'hosted', 'per_guest', 28, 33, 6, 7, 50, 100, 'full_bar', '[]', 75, 125)
     RETURNING id`,
    [NONCE]
  );
  pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [p.rows[0].id])).rows[0];
  // The real slug: the engine's gratuity basis and staffing branch key on it.
  bartenderAddon = (await pool.query(
    "SELECT * FROM service_addons WHERE slug = 'additional-bartender' AND is_active = true")).rows[0];
  assert.ok(bartenderAddon, 'dev catalog has the additional-bartender add-on');
  const flat = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active)
     VALUES ($1, 'Fold Catalog Flat', 'flat', 150, 'all', true) RETURNING *`, [`${NONCE}-flat`]);
  const perGuest = await pool.query(
    `INSERT INTO service_addons (slug, name, billing_type, rate, applies_to, is_active)
     VALUES ($1, 'Fold Catalog Guest', 'per_guest', 3, 'all', true) RETURNING *`, [`${NONCE}-guest`]);
  seededAddons.push(flat.rows[0].id, perGuest.rows[0].id);
  // THREE additional bartenders: stored as 12 at the contract's 4 hours, which
  // reads back as 2 at the worked 5 hours, so a wrong-hours inversion cannot
  // round its way to the right count (contractDuration.extension.test.js).
  const engineAddons = [
    { ...bartenderAddon, quantity: 3 },
    { ...flat.rows[0], quantity: 2 },
    { ...perGuest.rows[0], quantity: 2 },
  ];

  for (const [name, override] of [['native', null], ['override', OVERRIDE]]) {
    // Priced at the CONTRACT's hours, the way the writers price it; the row then
    // carries the worked hours and the settled extension that explains them.
    const snapshot = realCalculate({
      pkg, guestCount: 120, durationHours: CONTRACT_HOURS, numBars: 2, numBartenders: 3,
      addons: engineAddons, syrupSelections: [...SYRUPS], adjustments: LINES,
      totalPriceOverride: override, gratuityRate: 25, tipJar: false, gratuityFloorRate: 25,
    });
    const row = await pool.query(
      `INSERT INTO proposals
         (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
          status, event_type, guest_count, num_bars, num_bartenders, adjustments,
          total_price, total_price_override, amount_paid, gratuity_rate, tip_jar, gratuity_floor_rate,
          pricing_snapshot)
       VALUES ($1, $2, CURRENT_DATE + 30, '18:00', $3, 'America/Chicago',
               'confirmed', 'birthday-party', 120, 2, 3, $4::jsonb,
               $5, $6, 100, 25, false, 25, $7::jsonb)
       RETURNING id`,
      [clientId, pkg.id, WORKED_HOURS, JSON.stringify(LINES), snapshot.total, override, JSON.stringify(snapshot)]
    );
    const id = row.rows[0].id;
    seeded.set(name, { id, snapshot });
    for (const a of snapshot.addons) {
      await pool.query(
        `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, a.id, a.name, a.billing_type, a.rate, a.quantity, a.line_total, a.variant ?? null]
      );
    }
    await pool.query(
      `INSERT INTO service_extensions
         (proposal_id, contracted_duration_hours, requested_duration_hours, amount_cents, gratuity_cents,
          status, expires_at, finalized_at)
       VALUES ($1, $2, $3, 10000, 0, 'paid', NOW() + INTERVAL '1 hour', NOW())`,
      [id, CONTRACT_HOURS, WORKED_HOURS]
    );
  }

  const bare = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, guest_count, event_duration_hours, total_price)
     VALUES ($1, NULL, 'draft', 50, 4, 0) RETURNING id`,
    [clientId]
  );
  seeded.set('packageless', { id: bare.rows[0].id });
});

after(async () => {
  const ids = [...seeded.values()].map((s) => s.id);
  if (ids.length) {
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM service_extensions WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  for (const id of seededAddons) await pool.query('DELETE FROM service_addons WHERE id = $1', [id]);
  if (pkg) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.id]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// Lock the row, run fn, roll back: nothing persists on the shared dev DB.
async function inTx(proposalId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proposal = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
    return await fn(client, proposal);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// The engine calls `fn` makes, in order.
async function callsOf(fn) {
  engineCalls.length = 0;
  const result = await fn();
  return { result, calls: engineCalls.splice(0) };
}

// The fold with identical legs, built the way its callers build them.
async function noChangeFold(client, proposal, adjustments) {
  const addons = await loadRepriceAddons(client, proposal.id);
  const syrups = proposal.pricing_snapshot.syrups.selections;
  return callsOf(() => foldExtrasIntoProposal({
    client, proposal, pkg,
    addonsBefore: addons, addonsAfter: addons,
    syrupsBefore: syrups, syrupsAfter: syrups,
    numBarsBefore: proposal.num_bars ?? 0, numBarsAfter: proposal.num_bars ?? 0,
    ...(adjustments ? { adjustmentsBefore: adjustments, adjustmentsAfter: adjustments } : {}),
    statusChangeReason: 'catalog compute test',
  }));
}

const ROW_COLS = `SELECT total_price, total_price_override, pricing_snapshot, adjustments, status, updated_at
                    FROM proposals WHERE id = $1`;

test('native booking: the catalog compute hands the engine the fold\'s exact inputs and equals the snapshot the fold writes', async () => {
  const { id, snapshot: seededSnap } = seeded.get('native');
  await inTx(id, async (client, proposal) => {
    const rowBefore = (await client.query(ROW_COLS, [id])).rows[0];
    const fresh = await callsOf(() => computeCatalogSnapshot(client, proposal));
    assert.deepEqual((await client.query(ROW_COLS, [id])).rows[0], rowBefore, 'the compute reads only');

    const fold = await noChangeFold(client, proposal);
    assert.equal(fresh.calls.length, 1);
    assert.equal(fold.calls.length, 1, 'a native fold makes one engine call');
    assert.deepEqual(fresh.calls[0], fold.calls[0], 'one set of engine inputs');
    assert.deepEqual(strip(fresh.result), strip(fold.result.snapshot));

    const written = (await client.query(ROW_COLS, [id])).rows[0];
    assert.deepEqual(strip(JSON.parse(JSON.stringify(fresh.result))), strip(written.pricing_snapshot),
      'equals the snapshot the fold writes');
    assert.equal(cents(written.total_price), cents(fresh.result.total));

    // The booking's CURRENT inputs, read the way the fold's callers read them.
    const snap = fresh.result;
    assert.equal(snap.inputs.durationHours, CONTRACT_HOURS, 'the contract\'s hours, never the worked hours');
    assert.equal(snap.inputs.numBars, 2);
    assert.equal(snap.inputs.numBartenders, 3);
    assert.deepEqual(snap.syrups.selections, SYRUPS);
    assert.deepEqual(snap.adjustments, LINES);
    assert.equal(snap.gratuity.rate, 25);
    assert.equal(snap.gratuity.tip_jar, false);
    assert.equal(snap.gratuity.floor_rate, 25);
    assert.equal(snap.total_price_override, null);
    assert.equal(cents(snap.total), cents(seededSnap.total), 'reprices to what the booking was priced at');
  });
});

test('override booking: the catalog compute is the fold\'s catalog leg, with no override', async () => {
  const { id } = seeded.get('override');
  await inTx(id, async (client, proposal) => {
    const fresh = await callsOf(() => computeCatalogSnapshot(client, proposal));
    const fold = await noChangeFold(client, proposal);
    assert.equal(fresh.calls.length, 1);
    assert.equal(fold.calls.length, 3, 'an override fold prices a before leg, an after leg and the final snapshot');
    assert.deepEqual(fold.calls[0], fresh.calls[0], 'the before leg is the catalog compute');
    assert.deepEqual(fold.calls[1], fresh.calls[0], 'and so is the after leg (nothing changed)');
    assert.deepEqual(fold.calls[2], { ...fresh.calls[0], totalPriceOverride: OVERRIDE },
      'the final snapshot is the same inputs at the contract price');

    assert.equal(fresh.result.total_price_override, null);
    assert.notEqual(cents(fresh.result.total), cents(OVERRIDE));
    const written = (await client.query(ROW_COLS, [id])).rows[0];
    assert.equal(cents(written.total_price_override), cents(OVERRIDE), 'a no-change fold leaves the contract');
  });
});

test('the adjustments option replaces the row\'s lines and matches the fold given the same lines', async () => {
  const { id } = seeded.get('native');
  const withAgreed = [
    ...LINES,
    { type: 'surcharge', label: 'Agreed price adjustment', amount: 12.34, visible: false, source: 'agreed_price' },
  ];
  await inTx(id, async (client, proposal) => {
    const fresh = await callsOf(() => computeCatalogSnapshot(client, proposal, { adjustments: withAgreed }));
    const fold = await noChangeFold(client, proposal, withAgreed);
    assert.deepEqual(fresh.calls[0], fold.calls[0]);
    assert.deepEqual(strip(fresh.result), strip(fold.result.snapshot));
    assert.deepEqual(fresh.result.adjustments, withAgreed);

    const rowLines = await computeCatalogSnapshot(client, proposal);
    assert.deepEqual(rowLines.adjustments, LINES, 'no option reads the row\'s lines');
    assert.deepEqual((await computeCatalogSnapshot(client, proposal, { adjustments: undefined })).adjustments, LINES);
    assert.equal(cents(fresh.result.total), cents(rowLines.total) + 1234);
    const none = await computeCatalogSnapshot(client, proposal, { adjustments: [] });
    assert.deepEqual(none.adjustments, []);
    assert.equal(cents(none.total), cents(rowLines.total) + 3750 - 2000, 'no lines: the discount and surcharge are gone');
  });
});

test('a booking with no package is refused with a plain error, not priced', async () => {
  await inTx(seeded.get('packageless').id, async (client, proposal) => {
    await assert.rejects(computeCatalogSnapshot(client, proposal), /no package/);
  });
});

// A client that records every query the compute sends, then forwards it.
function recording(client) {
  const sent = [];
  return { sent, client: { query: (...args) => { sent.push(args[0]); return client.query(...args); } } };
}

test('a row missing a field the compute reads is refused before any query, naming each field', async () => {
  // The conversion once planned to pass an export row without guest_count: a
  // flat package then prices silently wrong, and the agreed-price line absorbs
  // the error (fold-holds code review, 2026-10-17). A partial row is refused.
  const { id } = seeded.get('native');
  await inTx(id, async (client, proposal) => {
    const without = (...keys) => Object.fromEntries(Object.entries(proposal).filter(([k]) => !keys.includes(k)));
    // The fields the message names, read off its "missing: a, b" tail.
    const named = (err) => (err.message.split('missing: ')[1] || '').split(', ');
    const rec = recording(client);
    await assert.rejects(computeCatalogSnapshot(rec.client, without('guest_count')), (err) => {
      assert.equal(err.statusCode, undefined, 'a plain Error, never a client-facing AppError');
      assert.deepEqual(named(err), ['guest_count']);
      return true;
    });
    for (const key of ['id', 'package_id', 'guest_count', 'event_duration_hours', 'num_bars', 'num_bartenders',
      'gratuity_rate', 'tip_jar', 'gratuity_floor_rate', 'adjustments', 'pricing_snapshot']) {
      await assert.rejects(computeCatalogSnapshot(rec.client, without(key)),
        (err) => named(err).includes(key) && named(err).length === 1, `${key} missing`);
    }
    await assert.rejects(computeCatalogSnapshot(rec.client, without('guest_count', 'tip_jar', 'pricing_snapshot')),
      (err) => ['guest_count', 'tip_jar', 'pricing_snapshot'].every((k) => named(err).includes(k)));
    // Null is a real value for most columns, but nothing can be priced without
    // an id, a guest count or hours.
    for (const key of ['id', 'guest_count', 'event_duration_hours']) {
      await assert.rejects(computeCatalogSnapshot(rec.client, Object.fromEntries([...Object.entries(proposal), [key, null]])),
        (err) => named(err).includes(key), `${key} null`);
    }
    assert.deepEqual(rec.sent, [], 'refused before any query');

    const nulls = await computeCatalogSnapshot(client, { ...proposal, num_bartenders: null, gratuity_floor_rate: null });
    assert.equal(nulls.gratuity.floor_rate, null, 'legitimate nulls still price');
  });
});

test('the pool is refused: the compute runs on the transaction client that read the row', async () => {
  const { id } = seeded.get('native');
  await inTx(id, async (client, proposal) => {
    await assert.rejects(computeCatalogSnapshot(pool, proposal), /transaction client/);
  });
});
