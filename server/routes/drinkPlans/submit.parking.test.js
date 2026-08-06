require('dotenv').config();

// Parking rewire (contractor duty pay, spec 2026-08-06 §4.3 / plan Task 8).
//
// The v2 planner records the paid-lot answer as TEXT ONLY, so `parking-fee`
// never attached on the live path. These tests pin the rewire:
//   1. A v2 submit with logistics.parking === 'paid' attaches parking-fee
//      through the SAME fold/extras path v1 add-ons take: total_price rises by
//      rate x totalStaff (staff = bartenders PLUS barback/server, not just
//      bartenders) and the payment status is re-evaluated on the increase.
//   2. Any other parking value attaches nothing (attach-only, no detach path).
//   3. A legacy v1 plan is untouched by the rewire (version gate): it keeps
//      billing purely off `addOns`, as it always has.
//   4. Re-submit stays blocked by the submit-once gate, so nothing double-bills.
//
// Harness per submitPlannerV2.test.js: real router over HTTP against the dev
// DB, nonce-suffixed self-contained rows, full teardown. Fixtures are
// America/Chicago-keyed. Run ALONE (shared dev DB):
//   node -r dotenv/config --test server/routes/drinkPlans/submit.parking.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

if (process.env.NODE_ENV === 'production') {
  throw new Error('submit.parking.test.js refuses to run against production');
}

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { calculateProposal } = require('../../utils/pricingEngine');
const drinkPlansRouter = require('../drinkPlans');

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

// Fixture shape, chosen so the expected parking math is exact and hand-checkable:
//   2 bartenders (num_bartenders override) + 1 barback add-on = 3 staff
//   parking-fee is per_staff @ $20  ->  3 x $20 = $60
const GUESTS = 100;
const HOURS = 4;
const BARTENDERS = 2;
const PARKING_RATE = 20;
const EXPECTED_STAFF = 3;
const EXPECTED_PARKING = PARKING_RATE * EXPECTED_STAFF; // dollars (proposal money is dollars)

let server;
let baseUrl;
let clientId;
let packageId;
let barbackAddon;
let parkingAddon;
const fixtures = {}; // key -> { proposalId, token, baselineTotal }
const proposalIds = [];

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const bodyBuf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: { ...(bodyBuf ? { 'Content-Type': 'application/json', 'Content-Length': bodyBuf.length } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch (_) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function readProposal(id) {
  const r = await pool.query(
    'SELECT status, total_price, amount_paid, pricing_snapshot FROM proposals WHERE id = $1',
    [id]
  );
  return r.rows[0];
}

async function readAddonSlugs(id) {
  const r = await pool.query(
    `SELECT sa.slug, pa.quantity, pa.line_total, pa.billing_type
       FROM proposal_addons pa JOIN service_addons sa ON sa.id = pa.addon_id
      WHERE pa.proposal_id = $1 ORDER BY sa.slug`,
    [id]
  );
  return r.rows;
}

/**
 * Seed one proposal + drink plan, with a barback already on the proposal, and
 * settle total_price / pricing_snapshot to the catalog baseline so the post-
 * submit delta is exactly the parking line and nothing else. amount_paid is set
 * to the full baseline (status 'balance_paid') so the raise must demote it.
 */
async function seedFixture(key, { plannerVersion = 2, syrups = [] } = {}) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, num_bartenders, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', $3, 'America/Chicago',
             'balance_paid', 'birthday-party', $4, 0, $5, 0, 0, '{}'::jsonb)
     RETURNING id`,
    [clientId, packageId, HOURS, GUESTS, BARTENDERS]
  );
  const proposalId = p.rows[0].id;
  proposalIds.push(proposalId);

  // Barback already contracted: engine-OUTPUT shape (per_hour stores hours x count).
  const barbackRate = Number(barbackAddon.rate);
  await pool.query(
    `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [proposalId, barbackAddon.id, barbackAddon.name, barbackAddon.billing_type,
      barbackRate, HOURS, barbackRate * HOURS]
  );

  // Baseline contract = catalog price of exactly what is on the row now.
  const pkg = (await pool.query('SELECT * FROM service_packages WHERE id = $1', [packageId])).rows[0];
  const baseline = calculateProposal({
    pkg,
    guestCount: GUESTS,
    durationHours: HOURS,
    numBars: 0,
    numBartenders: BARTENDERS,
    addons: [{ ...barbackAddon, quantity: 1 }], // input count, not the stored output
    syrupSelections: syrups,
  });
  await pool.query(
    `UPDATE proposals SET total_price = $1, amount_paid = $1, pricing_snapshot = $2 WHERE id = $3`,
    [baseline.total, JSON.stringify(baseline), proposalId]
  );

  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email, planner_version)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3, $4) RETURNING token`,
    [proposalId, `Parking Test ${NONCE}`, `parking-${NONCE}@example.com`, plannerVersion]
  );

  fixtures[key] = { proposalId, token: dp.rows[0].token, baselineTotal: Number(baseline.total) };
  return fixtures[key];
}

before(async () => {
  const addons = await pool.query(
    "SELECT * FROM service_addons WHERE slug IN ('barback', 'parking-fee') AND is_active = true"
  );
  barbackAddon = addons.rows.find((a) => a.slug === 'barback');
  parkingAddon = addons.rows.find((a) => a.slug === 'parking-fee');
  assert.ok(barbackAddon, 'barback add-on must exist in the catalog');
  assert.ok(parkingAddon, 'parking-fee add-on must exist in the catalog');
  assert.strictEqual(parkingAddon.billing_type, 'per_staff', 'parking-fee bills per staff member');
  assert.strictEqual(Number(parkingAddon.rate), PARKING_RATE, 'parking-fee rate is $20');

  const c = await pool.query(
    "INSERT INTO clients (name, email, phone) VALUES ($1, $2, '+15555551212') RETURNING id",
    [`Parking Test ${NONCE}`, `parking-${NONCE}@example.com`]
  );
  clientId = c.rows[0].id;

  // BYOB flat package (pricing_type <> 'per_guest'), so staffing.actual is the
  // num_bartenders override verbatim and the parking basis is unambiguous.
  const pkg = await pool.query(
    `INSERT INTO service_packages
       (slug, name, category, pricing_type, base_rate_4hr, extra_hour_rate, min_guests,
        bartenders_included, guests_per_bartender, extra_bartender_hourly, bar_type, includes)
     VALUES ($1, 'Parking Test BYOB', 'byob', 'flat', 800, 100, 0, 1, 100, 40, 'full_bar', '[]')
     RETURNING id`,
    [`parking-test-${NONCE}`]
  );
  packageId = pkg.rows[0].id;

  await seedFixture('paid');
  await seedFixture('free');
  await seedFixture('legacy', { plannerVersion: 1 });
  await seedFixture('syrups', { syrups: ['lavender', 'ginger', 'honey'] });
  await seedFixture('paynow');

  const app = express();
  app.use(express.json());
  app.use('/api/drink-plans', drinkPlansRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code, fieldErrors: err.fieldErrors });
    }
    console.error('unexpected test-harness error:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  // Let the fire-and-forget submit tail (shopping-list gen, comms lookups) settle.
  await new Promise((r) => setTimeout(r, 400));
  for (const pid of proposalIds) {
    await pool.query('DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)', [pid]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id=$1)', [pid]);
    await pool.query('DELETE FROM invoices WHERE proposal_id=$1', [pid]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id=$1', [pid]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id=$1', [pid]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id=$1', [pid]);
    await pool.query('DELETE FROM proposals WHERE id=$1', [pid]);
  }
  if (packageId) await pool.query('DELETE FROM service_packages WHERE id=$1', [packageId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id=$1', [clientId]);
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});

test("v2 submit with parking 'paid' attaches parking-fee, priced per STAFF, and re-evaluates payment status", async () => {
  const fx = fixtures.paid;
  const res = await request('PUT', `/api/drink-plans/t/${fx.token}`, {
    body: {
      status: 'submitted',
      selections: { logistics: { parking: 'paid', dayOfContact: { name: 'Dana', phone: '5555551212' } } },
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  // The add-on is attached exactly once, priced by the engine off totalStaff
  // (2 bartenders + 1 barback), never off num_bartenders alone.
  const rows = await readAddonSlugs(fx.proposalId);
  const parking = rows.filter((r) => r.slug === 'parking-fee');
  assert.strictEqual(parking.length, 1, `exactly one parking-fee row (got: ${rows.map((r) => r.slug).join(',')})`);
  assert.strictEqual(Number(parking[0].quantity), EXPECTED_STAFF, 'quantity is the total staff count');
  assert.strictEqual(Number(parking[0].line_total), EXPECTED_PARKING, 'line_total is rate x totalStaff');

  const prop = await readProposal(fx.proposalId);
  // total_price rose by exactly rate x totalStaff, nothing else moved.
  assert.strictEqual(
    Number(prop.total_price) - fx.baselineTotal, EXPECTED_PARKING,
    `total_price rose by $${EXPECTED_PARKING} (was ${fx.baselineTotal}, now ${prop.total_price})`
  );

  // The snapshot the client is shown agrees with the stored row.
  const snapParking = (prop.pricing_snapshot.addons || []).find((a) => a.slug === 'parking-fee');
  assert.ok(snapParking, 'parking-fee is in the refreshed pricing snapshot');
  assert.strictEqual(Number(snapParking.quantity), EXPECTED_STAFF);
  assert.strictEqual(Number(snapParking.line_total), EXPECTED_PARKING);

  // Payment status re-evaluated on the increase: a fully-paid proposal that now
  // owes must not keep showing paid-in-full.
  assert.strictEqual(prop.status, 'deposit_paid', 'balance_paid demoted on the raise');
  assert.ok(Number(prop.amount_paid) < Number(prop.total_price), 'now underpaid by the parking fee');

  // The client-facing activity log names what was added.
  const log = await pool.query(
    `SELECT details FROM proposal_activity_log
      WHERE proposal_id = $1 AND action = 'drink_plan_addons_added'`,
    [fx.proposalId]
  );
  assert.strictEqual(log.rows.length, 1);
  assert.ok((log.rows[0].details.addons || []).includes('parking-fee'), 'parking-fee logged as added');
});

test("v2 submit with parking 'free' attaches nothing and leaves the contract untouched", async () => {
  const fx = fixtures.free;
  const res = await request('PUT', `/api/drink-plans/t/${fx.token}`, {
    body: {
      status: 'submitted',
      selections: { logistics: { parking: 'free', dayOfContact: { name: 'Dana', phone: '5555551212' } } },
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const rows = await readAddonSlugs(fx.proposalId);
  assert.deepEqual(rows.map((r) => r.slug), ['barback'], 'only the pre-existing barback remains');

  const prop = await readProposal(fx.proposalId);
  assert.strictEqual(Number(prop.total_price), fx.baselineTotal, 'total_price unchanged');
  assert.strictEqual(prop.status, 'balance_paid', 'payment status unchanged');
});

test("legacy v1 plan is untouched by the rewire even with parking 'paid' (version gate)", async () => {
  const fx = fixtures.legacy;
  const res = await request('PUT', `/api/drink-plans/t/${fx.token}`, {
    body: {
      status: 'submitted',
      selections: { logistics: { parking: 'paid', dayOfContact: { name: 'Dana', phone: '5555551212' } } },
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const rows = await readAddonSlugs(fx.proposalId);
  assert.deepEqual(rows.map((r) => r.slug), ['barback'], 'v1 bills only through addOns, as before');

  const prop = await readProposal(fx.proposalId);
  assert.strictEqual(Number(prop.total_price), fx.baselineTotal, 'total_price unchanged');
  assert.strictEqual(prop.status, 'balance_paid', 'payment status unchanged');
});

test('re-submit stays blocked by the submit-once gate, so parking never double-bills', async () => {
  const fx = fixtures.paid;
  const before2 = await readProposal(fx.proposalId);

  const res = await request('PUT', `/api/drink-plans/t/${fx.token}`, {
    body: { status: 'submitted', selections: { logistics: { parking: 'paid' } } },
  });
  assert.strictEqual(res.status, 409, JSON.stringify(res.body));

  const rows = await readAddonSlugs(fx.proposalId);
  assert.strictEqual(rows.filter((r) => r.slug === 'parking-fee').length, 1, 'still exactly one parking-fee row');
  const after2 = await readProposal(fx.proposalId);
  assert.strictEqual(Number(after2.total_price), Number(before2.total_price), 'total_price did not move again');
});

test('v2 submit NEVER strips contracted syrups: total rises by exactly the parking fee (security fix)', async () => {
  const fx = fixtures.syrups;
  const before = await readProposal(fx.proposalId);
  const syrupsBefore = before.pricing_snapshot?.syrups?.selections || [];
  assert.strictEqual(syrupsBefore.length, 3, 'fixture carries 3 contracted syrups');

  const res = await request('PUT', `/api/drink-plans/t/${fx.token}`, {
    body: {
      status: 'submitted',
      // A v2 payload never carries syrupSelections; before the carry-forward
      // fix this submit re-priced the contract WITHOUT its syrups and total
      // NET-LOWERED (3-pack $75 vs $60 parking) from a public token.
      selections: { logistics: { parking: 'paid', dayOfContact: { name: 'Dana', phone: '5555551212' } } },
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));

  const prop = await readProposal(fx.proposalId);
  assert.strictEqual(
    Number(prop.total_price) - fx.baselineTotal, EXPECTED_PARKING,
    `total rose by exactly the parking fee (was ${fx.baselineTotal}, now ${prop.total_price})`
  );
  assert.ok(Number(prop.total_price) > fx.baselineTotal, 'total can only RISE on this path');
  const syrupsAfter = prop.pricing_snapshot?.syrups?.selections || [];
  assert.deepStrictEqual([...syrupsAfter].sort(), [...syrupsBefore].sort(), 'contracted syrups survive verbatim');
});

test('paid_separately submit never attaches parking (would fold money nothing invoices)', async () => {
  const fx = fixtures.paynow;
  const res = await request('PUT', `/api/drink-plans/t/${fx.token}`, {
    body: {
      status: 'submitted',
      paid_separately: true,
      selections: { logistics: { parking: 'paid', dayOfContact: { name: 'Dana', phone: '5555551212' } } },
    },
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const rows = await readAddonSlugs(fx.proposalId);
  assert.strictEqual(rows.filter((r) => r.slug === 'parking-fee').length, 0, 'no parking row on the pay-now path');
  const prop = await readProposal(fx.proposalId);
  assert.strictEqual(Number(prop.total_price), fx.baselineTotal, 'total_price untouched');
});
