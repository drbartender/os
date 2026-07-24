require('dotenv').config();

// Fold before/after legs for staffing + adjustments (lane cancel-line-server,
// plan Task 1). The cancel-line feature removes extra bartenders and
// adjustments from override'd contracts; the fold's catalog delta must be able
// to vary those inputs per leg or the removal delta is zero and the negotiated
// price never moves. Defaults (params omitted) must preserve the existing
// single-valued behavior byte-for-byte for lab.js / submit.js.
// Run ALONE against the shared dev DB, FROM THE os CHECKOUT ROOT (or from a
// lane with --env-file):
//   node -r dotenv/config --test server/utils/proposalExtrasFold.legs.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool } = require('../db');
const { foldExtrasIntoProposal, loadRepriceAddons } = require('./proposalExtrasFold');
const { calculateProposal } = require('./pricingEngine');

if (process.env.NODE_ENV === 'production') {
  throw new Error('proposalExtrasFold.legs.test.js refuses to run against production');
}

const NONCE = `foldlegs-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const TRAVEL = [{ type: 'surcharge', label: 'Travel', amount: 100 }];

let clientId;
let pkg;          // full service_packages row
let proposalId;

// Price the seeded event at catalog (override OFF) with the given staffing,
// mirroring the fold's own leg computation. Adjustments included on both
// sides of any delta so they cancel exactly as they do inside the fold.
function catalogAt({ numBartenders, adjustments = TRAVEL, addons = [] }) {
  return calculateProposal({
    pkg,
    guestCount: 80,
    durationHours: 4,
    numBars: 0,
    numBartenders,
    addons,
    syrupSelections: [],
    adjustments,
    totalPriceOverride: null,
    gratuityRate: 0,
    tipJar: true,
  });
}
const serviceOf = (s) => Math.round((s.total - (s.gratuity?.total || 0)) * 100) / 100;

before(async () => {
  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`Fold Legs ${NONCE}`, `fold-legs-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  const pkgIns = await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'Fold Legs Test', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]')
     RETURNING id`,
    [`fold-legs-${NONCE}`]
  );
  pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [pkgIns.rows[0].id])).rows[0];

  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, adjustments,
        total_price, total_price_override, amount_paid, gratuity_rate, tip_jar, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 80, 0, 3, $3::jsonb,
             2000, 2000, 100, 0, true, '{}'::jsonb)
     RETURNING id`,
    [clientId, pkg.id, JSON.stringify(TRAVEL)]
  );
  proposalId = p.rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = $1', [proposalId]);
  await pool.query('DELETE FROM proposals WHERE id = $1', [proposalId]);
  if (pkg) await pool.query('DELETE FROM service_packages WHERE id = $1', [pkg.id]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// Each test opens its own transaction and rolls back, so the seeded row is
// pristine for the next test and nothing persists on the shared dev DB.
async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [proposalId])).rows[0];
    await fn(client, p);
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    client.release();
  }
}

test('adjustments leg moves the override by the removed adjustment', async () => {
  await inTx(async (client, p) => {
    const addons = await loadRepriceAddons(client, proposalId);
    const { snapshot } = await foldExtrasIntoProposal({
      client, proposal: p, pkg,
      addonsBefore: addons, addonsAfter: addons,
      syrupsBefore: [], syrupsAfter: [],
      numBarsBefore: 0, numBarsAfter: 0,
      adjustmentsBefore: TRAVEL, adjustmentsAfter: [],
      statusChangeReason: 'test',
    });
    const row = (await client.query('SELECT total_price, total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.total_price_override), 1900); // 2000 - 100 surcharge
    assert.equal(Number(row.total_price), Number(snapshot.total));
    assert.deepEqual(snapshot.adjustments, []);           // final snapshot uses the After leg
  });
});

test('numBartenders leg moves the override by the engine delta for the dropped extra', async () => {
  const delta = Math.round(
    (serviceOf(catalogAt({ numBartenders: 2 })) - serviceOf(catalogAt({ numBartenders: 3 }))) * 100
  ) / 100;
  assert.ok(delta < 0, `expected a negative staffing delta, got ${delta}`);
  await inTx(async (client, p) => {
    const addons = await loadRepriceAddons(client, proposalId);
    const { snapshot } = await foldExtrasIntoProposal({
      client, proposal: p, pkg,
      addonsBefore: addons, addonsAfter: addons,
      syrupsBefore: [], syrupsAfter: [],
      numBarsBefore: 0, numBarsAfter: 0,
      numBartendersBefore: 3, numBartendersAfter: 2,
      statusChangeReason: 'test',
    });
    const row = (await client.query('SELECT total_price, total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.total_price_override), Math.round((2000 + delta) * 100) / 100);
    // The final snapshot must price staffing at the After count.
    assert.equal(snapshot.inputs.numBartenders, 2);
    assert.equal(Number(row.total_price), Number(snapshot.total));
  });
});

test('omitting the new params preserves existing behavior', async () => {
  await inTx(async (client, p) => {
    const addons = await loadRepriceAddons(client, proposalId);
    const { snapshot } = await foldExtrasIntoProposal({
      client, proposal: p, pkg,
      addonsBefore: addons, addonsAfter: addons,
      syrupsBefore: [], syrupsAfter: [],
      numBarsBefore: 0, numBarsAfter: 0,
      statusChangeReason: 'test',
    });
    const row = (await client.query('SELECT total_price, total_price_override FROM proposals WHERE id = $1', [proposalId])).rows[0];
    assert.equal(Number(row.total_price_override), 2000); // nothing changed, override untouched
    assert.deepEqual(snapshot.adjustments, TRAVEL);       // stored adjustments still flow through
    assert.equal(snapshot.inputs.numBartenders, 3);
  });
});
