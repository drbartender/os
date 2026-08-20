'use strict';
// dotenv BEFORE anything that reaches ../db. Without it DATABASE_URL is unset,
// pg falls back to a local socket, and every DB-touching test in this file dies
// on ECONNREFUSED 127.0.0.1:5432 -- which is how this whole suite sat silently
// red since it was written (found 2026-08-20).
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pool } = require('../db');
const { computeExtensionDelta, MAX_EXTENSION_HOURS } = require('./serviceExtensionPricing');

const NONCE = `sxp-${Date.now()}`;
let clientId, flatPkgId, hostedPkgId, classPkgId;
const made = [];

async function mkProposal(fields) {
  const {
    packageId, guests = 100, hours = 4, gratuityRate = 0, numBartenders = null,
    override = null, totalPrice = 350,
  } = fields;
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
        num_bartenders, gratuity_rate, tip_jar, total_price, total_price_override,
        amount_paid, event_date, event_start_time, event_timezone, pricing_snapshot, adjustments)
     VALUES ($1,$2,'deposit_paid',$3,$4,1,$5,$6,true,$7,$8,$7,'2026-09-12','6:00 PM','America/Chicago','{}','[]')
     RETURNING id`,
    [clientId, packageId, guests, hours, numBartenders, gratuityRate, totalPrice, override]
  );
  made.push(r.rows[0].id);
  return r.rows[0].id;
}

before(async () => {
  const c = await pool.query(
    'INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`]
  );
  clientId = c.rows[0].id;
  // Pinned by slug. The Core Reaction: flat, base_rate_4hr 350, extra_hour_rate 100.
  const f = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-core-reaction'");
  flatPkgId = f.rows[0].id;
  // The Base Compound: per_guest, base 18, extra_hour_rate 5.
  const h = await pool.query("SELECT id FROM service_packages WHERE slug = 'the-base-compound'");
  hostedPkgId = h.rows[0].id;
  // A per-guest CLASS package: extra_hour_rate 0, so extending is always $0.
  const cl = await pool.query(
    "SELECT id FROM service_packages WHERE bar_type = 'class' AND pricing_type = 'per_guest' AND is_active = true ORDER BY sort_order LIMIT 1"
  );
  classPkgId = cl.rows[0].id;
});

after(async () => {
  if (made.length) await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [made]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

test('flat package, +30 min above the 4h base, zero gratuity: $50', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 5000);
  assert.equal(r.gratuityDeltaCents, 0);
  assert.equal(r.serviceDeltaCents, 5000);
});

test('gratuity rides along: +30 min at $50/staff/hr adds $25', async () => {
  const id = await mkProposal({ packageId: flatPkgId, gratuityRate: 50 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.5 });
  assert.equal(r.ok, true);
  assert.equal(r.gratuityDeltaCents, 2500);
  assert.equal(r.amountCents, 7500);
});

test('flat package below the 4h tier: 3h -> 4h is $0, the zero-delta path', async () => {
  const id = await mkProposal({ packageId: flatPkgId, hours: 3 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 0);
});

test('over-ratio bartender at 50 guests carries the sub-100 surcharge: +60 min is $165', async () => {
  // 50 guests -> staffing.required = 1; num_bartenders override 2 -> 1 extra.
  // extra x hours x (extra_bartender_hourly 40 + gratuityPerHour 25 for <75)
  // = 1 x 1 x 65 = $65, plus the $100 base extra hour.
  const id = await mkProposal({ packageId: flatPkgId, guests: 50, numBartenders: 2 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 16500);
});

test('at 100 guests the same two-bartender shape has no surcharge: $140', async () => {
  const id = await mkProposal({ packageId: flatPkgId, guests: 100, numBartenders: 2 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 14000);
});

test('the sub-100 surcharge is classified as STAFF gratuity, not service revenue', async () => {
  // The load-bearing case, and the one the cross-model review caught. The
  // $25/hr over-ratio surcharge carries the 'Shared Gratuity' breakdown label,
  // which payroll pools into the staff gratuity. Reading snapshot.gratuity.total
  // instead of extractGratuityCents would put it in serviceDeltaCents and DRB
  // would keep money that belongs to the bartenders. gratuity_rate is 0 here, so
  // the ONLY gratuity in play is the surcharge: it must be $25, not $0.
  const id = await mkProposal({ packageId: flatPkgId, guests: 50, numBartenders: 2, gratuityRate: 0 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.gratuityDeltaCents, 2500, 'the Shared Gratuity surcharge must land in the staff pool');
  assert.equal(r.serviceDeltaCents, 14000, '$100 base hour + $40 extra-bartender hour');
  assert.equal(r.serviceDeltaCents + r.gratuityDeltaCents, r.amountCents, 'the three figures must reconcile');
});

test('with a client gratuity rate AND a surcharge, both labels reach the staff pool', async () => {
  const id = await mkProposal({ packageId: flatPkgId, guests: 50, numBartenders: 2, gratuityRate: 50 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.ok(r.gratuityDeltaCents > 2500, 'both gratuity labels must be pooled, not just one');
  assert.equal(r.serviceDeltaCents + r.gratuityDeltaCents, r.amountCents);
});

test('hosted per-guest: 100 guests x $5 x 1h = $500', async () => {
  const id = await mkProposal({ packageId: hostedPkgId, guests: 100, totalPrice: 1800 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 50000);
  assert.equal(r.isHosted, true);
});

test('a negotiated override does not swallow the delta', async () => {
  // Sold at $400 against a $350 catalog. The delta must still be the catalog
  // $100/hr, not $0 (which is what differencing .total with the override on
  // would produce).
  const id = await mkProposal({ packageId: flatPkgId, override: 400, totalPrice: 400 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 10000);
});

test('refuses a requested end at or before the contracted end', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4 })).reason, 'not_an_extension');
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 3.5 })).reason, 'not_an_extension');
});

test('refuses beyond the 3 hour cap and refuses non-30-minute increments', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4 + MAX_EXTENSION_HOURS + 0.5 })).reason, 'over_cap');
  assert.equal((await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.25 })).reason, 'bad_increment');
});

test('a per-guest class package extends for $0 (extra_hour_rate 0)', async () => {
  const id = await mkProposal({ packageId: classPkgId, guests: 20, totalPrice: 700 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 0);
});

test('a tiny hosted event still owes the billed-guest extra hour, NOT $0', async () => {
  // VERIFIED against the live engine 2026-07-26. The Base Compound carries
  // min_billed_guests = 25 and min_total = $550, so a 1-guest event bills as 25
  // heads. The extra-hour term is 25 x $5 = $125, and it is ADDITIVE on top of
  // the billed-guest base rather than absorbed by the dollar floor.
  //
  // An earlier draft asserted $0 here on the theory that min_total swallows the
  // delta. It does not: the floor binds the 4-hour base, and the extra hour
  // clears it. That wrong expectation would have sent the implementer hunting a
  // non-bug in correct pricing code, so the number below is measured, not
  // reasoned. If a package's floor is ever high enough to bind at BOTH
  // durations the delta really is $0, which is why Task 8 keeps the
  // zero-delta settle path; it is just not this package.
  const id = await mkProposal({ packageId: hostedPkgId, guests: 1, totalPrice: 550 });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 12500, '25 billed heads x $5 x 1 hour');
  assert.equal(r.gratuityDeltaCents, 0);
});

test('returns the contracted end instant that Task 7 uses for expires_at', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  const r = await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 4.5 });
  assert.ok(r.contractedEndInstant instanceof Date || typeof r.contractedEndInstant === 'string');
});

test('never mutates the proposal', async () => {
  const id = await mkProposal({ packageId: flatPkgId });
  await computeExtensionDelta({ client: pool, proposalId: id, requestedDurationHours: 5 });
  const r = await pool.query(
    'SELECT event_duration_hours, total_price, amount_paid, status FROM proposals WHERE id = $1',
    [id]
  );
  assert.equal(Number(r.rows[0].event_duration_hours), 4);
  assert.equal(Number(r.rows[0].total_price), 350);
  assert.equal(r.rows[0].status, 'deposit_paid');
});
