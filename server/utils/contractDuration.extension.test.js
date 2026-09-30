'use strict';
// Contract hours vs worked hours after an on-site extension, end to end on the
// dev database. Spec: docs/superpowers/specs/2026-09-30-extension-contract-duration-design.md
//
// Fixtures rounding cannot mask (spec-gaps finding): THREE additional
// bartenders on a 4h booking extended to 5h store quantity 12, which reads
// back as 2 at the worked hours and 3 at the contract's.
//
//   A: Core Reaction, 4h contract, 3 additional bartenders, one PAID extension
//      4h -> 5h, row at 5.0, one open shift.
//   B: the 606 shape: hosted, total_price_override set, PAID extension.
//   C: Core Reaction with a gratuity mandate and an OVERRIDDEN extension.
//   Z: Core Reaction, 3 additional bartenders, no extension rows (the no-op
//      control for the 128 open bookings that have none).
//
// Runs against the dev DB (DATABASE_URL from .env); creates real rows and
// purges them in after(). Mounts the real crud + getOne + metadata routers.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../db');
const { AppError } = require('./errors');
const { calculateProposal } = require('./pricingEngine');
const { loadRepriceAddons, foldExtrasIntoProposal } = require('./proposalExtrasFold');
const { computeExtensionDelta } = require('./serviceExtensionPricing');
const { computeCancelTargets, applyLineItemCancel } = require('./lineItemCancel');
const { syncShiftsFromProposal } = require('./eventCreation');
const { priceProposedState } = require('./changeRequests');
const { contractDurationHours } = require('./contractDuration');
const crudRouter = require('../routes/proposals/crud');

const NONCE = `cdx-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server; let baseUrl; let token; let adminId;
let clientId; let corePkg; let hostedPkg; let bartenderAddon;
const made = { proposals: [], users: [] };

// ─── harness ────────────────────────────────────────────────────────────────
function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const dollars = (n) => Math.round(Number(n) * 100) / 100;

function engine({ pkg, hours, addonCount = 3, override = null, gratuityRate = 0, tipJar = true, floorRate = null, guests = 100 }) {
  const addons = addonCount > 0 ? [{ ...bartenderAddon, variant: null, quantity: addonCount }] : [];
  return calculateProposal({
    pkg, guestCount: guests, durationHours: hours, numBars: 0, numBartenders: null,
    addons, syrupSelections: [], adjustments: [], totalPriceOverride: override,
    gratuityRate, tipJar, gratuityFloorRate: floorRate,
  });
}

// A booked proposal whose stored price, snapshot and add-on rows were all
// computed at `contractHours`, with the ROW then moved to `workedHours` by an
// extension row of the given status (none when workedHours === contractHours).
async function seed({ name, pkg, contractHours, workedHours, extStatus = 'paid', addonCount = 3, override = null, gratuityRate = 0, tipJar = true, floorRate = null, guests = 100, shift = true, startTime = '6:00 PM' }) {
  const snap = engine({ pkg, hours: contractHours, addonCount, override, gratuityRate, tipJar, floorRate, guests });
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars, num_bartenders,
        gratuity_rate, tip_jar, gratuity_floor_rate, total_price, total_price_override, amount_paid,
        event_date, event_start_time, event_timezone, pricing_snapshot, adjustments, payment_type, event_type,
        venue_street, venue_city, venue_state)
     VALUES ($1, $2, 'confirmed', $3, $4, 0, NULL, $5, $6, $7, $8, $9, $8,
        '2027-06-12', $11, 'America/Chicago', $10, '[]', 'full', 'Wedding',
        '123 Test St', 'Rockford', 'IL')
     RETURNING id`,
    [clientId, pkg.id, guests, workedHours, gratuityRate, tipJar, floorRate, snap.total, override, JSON.stringify(snap), startTime]
  );
  const id = p.rows[0].id;
  made.proposals.push(id);
  for (const a of snap.addons) {
    await pool.query(
      `INSERT INTO proposal_addons (proposal_id, addon_id, addon_name, billing_type, rate, quantity, line_total, variant)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)`,
      [id, a.id, a.name, a.billing_type, a.rate, a.quantity, a.line_total]
    );
  }
  if (shift) {
    await pool.query(
      `INSERT INTO shifts (proposal_id, event_date, event_duration_hours, status, positions_needed)
       VALUES ($1, '2027-06-12', $2, 'open', '["Bartender"]')`,
      [id, workedHours]
    );
  }
  if (workedHours !== contractHours) {
    await pool.query(
      `INSERT INTO service_extensions
         (proposal_id, contracted_duration_hours, requested_duration_hours, amount_cents, gratuity_cents,
          status, expires_at, finalized_at)
       VALUES ($1, $2, $3, 10000, 0, $4, NOW() + INTERVAL '1 hour', NOW())`,
      [id, contractHours, workedHours, extStatus]
    );
  }
  return { id, snap, name };
}

async function row(id) {
  const r = await pool.query('SELECT * FROM proposals WHERE id = $1', [id]);
  return r.rows[0];
}
async function addonRows(id) {
  const r = await pool.query('SELECT addon_id, quantity, line_total FROM proposal_addons WHERE proposal_id = $1 ORDER BY id', [id]);
  return r.rows;
}

// The full editor body: the editor sends event_duration_hours on EVERY save.
function editorBody(p, extra = {}) {
  return {
    event_date: p.event_date, event_start_time: p.event_start_time,
    event_duration_hours: Number(p.event_duration_hours),
    guest_count: p.guest_count, package_id: p.package_id, num_bars: 0,
    addon_ids: [bartenderAddon.id], addon_quantities: { [String(bartenderAddon.id)]: 3 },
    adjustments: p.adjustments || [], total_price_override: p.total_price_override,
    ...extra,
  };
}

before(async () => {
  const c = await pool.query('INSERT INTO clients (name, email, source) VALUES ($1, $2, $3) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`, 'direct']);
  clientId = c.rows[0].id;
  corePkg = (await pool.query("SELECT * FROM service_packages WHERE slug = 'the-core-reaction'")).rows[0];
  hostedPkg = (await pool.query("SELECT * FROM service_packages WHERE slug = 'the-carbon-suspension'")).rows[0];
  bartenderAddon = (await pool.query("SELECT * FROM service_addons WHERE slug = 'additional-bartender' AND is_active = true")).rows[0];
  assert.ok(corePkg && hostedPkg && bartenderAddon, 'dev catalog is missing a fixture package or the additional-bartender add-on');
  assert.equal(Number(corePkg.extra_hour_rate), 100, 'Core Reaction extra-hour rate is the seeded 100');

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version) VALUES ($1, 'x', 'admin', 0) RETURNING id, token_version`,
    [`${NONCE}-admin@example.test`]
  );
  adminId = u.rows[0].id;
  made.users.push(adminId);
  token = jwt.sign({ userId: adminId, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

  crudRouter.__setDeps({ sendProposalSentEmail: () => Promise.resolve(), createInvoiceOnSend: () => Promise.resolve() });
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', crudRouter);
  app.use('/api/proposals', require('../routes/proposals/metadata'));
  app.use('/api/proposals', require('../routes/proposals/getOne'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    console.error(err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (made.proposals.length) {
    // scheduled_messages is keyed by entity, not proposal_id: the venue PATCHes
    // enrol pre-event reminders on a confirmed booking (preEventScheduling).
    await pool.query(
      `DELETE FROM scheduled_messages
        WHERE (entity_type = 'proposal' AND entity_id = ANY($1::int[]))
           OR (entity_type = 'shift' AND entity_id IN (SELECT id FROM shifts WHERE proposal_id = ANY($1::int[])))`,
      [made.proposals]
    );
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [made.proposals]);
    await pool.query('DELETE FROM service_extensions WHERE proposal_id = ANY($1)', [made.proposals]);
    await pool.query('DELETE FROM shift_requests WHERE shift_id IN (SELECT id FROM shifts WHERE proposal_id = ANY($1))', [made.proposals]);
    await pool.query('DELETE FROM shifts WHERE proposal_id = ANY($1)', [made.proposals]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1)', [made.proposals]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [made.proposals]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [made.proposals]);
  }
  if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// ─── the rule on real rows ──────────────────────────────────────────────────
test('A: contract hours are 4 on a row at 5 with a paid extension; Z: the row is the contract', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const Z = await seed({ name: 'Z', pkg: corePkg, contractHours: 4, workedHours: 4 });
  assert.equal(await contractDurationHours(pool, A.id, '5.0'), 4);
  assert.equal(await contractDurationHours(pool, Z.id, '4.0'), 4);
});

test('loadRepriceAddons inverts three bartenders at the contract hours (the worked hours would say two); Z is untouched', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const Z = await seed({ name: 'Z', pkg: corePkg, contractHours: 4, workedHours: 4 });
  const a = (await loadRepriceAddons(pool, A.id)).find((r) => r.slug === 'additional-bartender');
  const z = (await loadRepriceAddons(pool, Z.id)).find((r) => r.slug === 'additional-bartender');
  assert.equal(a.quantity, 3);
  assert.equal(z.quantity, 3);
  assert.equal(Number((await addonRows(A.id))[0].quantity), 12, 'stored quantity is still 3 x 4h');
});

test('a second extension on A is priced from three bartenders, not two', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const delta = await computeExtensionDelta({ client: pool, proposalId: A.id, requestedDurationHours: 6 });
  assert.equal(delta.ok, true, JSON.stringify(delta));
  // 5h -> 6h: package $100 (past the base) + 3 bartenders x $40 x 1h = $220.
  // At the wrong count the staffing share is $80, so $180.
  assert.equal(delta.amountCents, 22000);
});

test('the extras fold with no change leaves an extended booking priced at its contract hours', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const p = (await client.query('SELECT * FROM proposals WHERE id = $1 FOR UPDATE', [A.id])).rows[0];
    const addons = await loadRepriceAddons(client, A.id);
    const { snapshot } = await foldExtrasIntoProposal({
      client, proposal: p, pkg: corePkg,
      addonsBefore: addons, addonsAfter: addons, syrupsBefore: [], syrupsAfter: [],
      numBarsBefore: 0, numBarsAfter: 0, statusChangeReason: 'test',
    });
    await client.query('COMMIT');
    assert.equal(dollars(snapshot.total), dollars(A.snap.total));
    assert.equal(snapshot.inputs.durationHours, 4);
  } finally {
    client.release();
  }
});

// ─── the admin PATCH ─────────────────────────────────────────────────────────
test('PATCH of a venue field on A, B and C leaves the price, the override, the gratuity line and the snapshot hours alone', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const B = await seed({ name: 'B', pkg: hostedPkg, contractHours: 5, workedHours: 6, addonCount: 0, override: 2425 });
  const C = await seed({ name: 'C', pkg: corePkg, contractHours: 4, workedHours: 5, extStatus: 'overridden', gratuityRate: 50, tipJar: false, floorRate: 50 });
  for (const fx of [A, B, C]) {
    const before = await row(fx.id);
    const body = editorBody(before, { venue_name: `${NONCE} venue ${fx.name}` });
    if (fx.name === 'B') { body.addon_ids = []; body.addon_quantities = {}; }
    const res = await request('PATCH', `/api/proposals/${fx.id}`, body);
    assert.equal(res.status, 200, `${fx.name}: ${JSON.stringify(res.body)}`);
    const after = await row(fx.id);
    assert.equal(dollars(after.total_price), dollars(before.total_price), `${fx.name}: total moved`);
    assert.equal(after.total_price_override, before.total_price_override, `${fx.name}: override moved`);
    assert.equal(after.pricing_snapshot.inputs.durationHours, fx.snap.inputs.durationHours, `${fx.name}: snapshot hours moved`);
    assert.equal(dollars(after.pricing_snapshot.gratuity?.total || 0), dollars(before.pricing_snapshot.gratuity?.total || 0), `${fx.name}: gratuity line moved`);
    assert.equal(Number(after.event_duration_hours), Number(before.event_duration_hours), `${fx.name}: worked hours moved`);
  }
  // C proves the status list is not 'paid' alone: its extension is overridden.
  assert.equal(Number((await row(C.id)).event_duration_hours), 5);
});

test('PATCH duration 6 on A stores 6 on the row and the shift, prices 5, and adds exactly one catalog hour', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const before = await row(A.id);
  const res = await request('PATCH', `/api/proposals/${A.id}`, editorBody(before, { event_duration_hours: 6 }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const after = await row(A.id);
  assert.equal(Number(after.event_duration_hours), 6);
  assert.equal(after.pricing_snapshot.inputs.durationHours, 5);
  const expected = engine({ pkg: corePkg, hours: 5 });
  assert.equal(dollars(after.total_price), dollars(expected.total));
  assert.ok(dollars(after.total_price) > dollars(before.total_price), 'one contract hour was added');
  const shift = (await pool.query('SELECT event_duration_hours FROM shifts WHERE proposal_id = $1', [A.id])).rows[0];
  assert.equal(Number(shift.event_duration_hours), 6);
});

test('the curfew gate reads the WORKED hours: an 8:30 PM start extended to 5h clears 2:00 AM, an edit to 6h does not', async () => {
  // Contract hours (4) or even the row (5) would end at 12:30 or 1:30 AM and
  // pass. Only a gate fed the body's 6h reaches 2:30 AM and refuses. This pins
  // that workedHours, not contractHours, feeds curfewGateForSave.
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5, startTime: '8:30 PM' });
  const before = await row(A.id);
  const refused = await request('PATCH', `/api/proposals/${A.id}`, editorBody(before, { event_duration_hours: 6 }));
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.fieldErrors.past_curfew, 'true');
  const after = await row(A.id);
  assert.equal(Number(after.event_duration_hours), 5, 'nothing saved');
  assert.equal(dollars(after.total_price), dollars(before.total_price));
});

test('a duration change is refused while a request is pending; the same body with the duration unchanged saves and moves nothing', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  await pool.query(
    `INSERT INTO service_extensions (proposal_id, contracted_duration_hours, requested_duration_hours, amount_cents, status, expires_at)
     VALUES ($1, 5, 5.5, 5000, 'pending', NOW() + INTERVAL '1 hour')`, [A.id]
  );
  const before = await row(A.id);
  const refused = await request('PATCH', `/api/proposals/${A.id}`, editorBody(before, { event_duration_hours: 6.5 }));
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.fieldErrors.event_duration_hours, /extension request is pending/i);
  assert.equal(refused.body.fieldErrors.past_curfew, undefined, 'never confused with the curfew refusal');
  const ok = await request('PATCH', `/api/proposals/${A.id}`, editorBody(before, { venue_name: `${NONCE} still pending` }));
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const after = await row(A.id);
  assert.equal(dollars(after.total_price), dollars(before.total_price));
  assert.equal(Number(after.event_duration_hours), 5);
});

// ─── cancel line item ────────────────────────────────────────────────────────
test('cancel-line preview offers the bartenders at three; a partial removal of one stores 2 x 4h and reads back as 2', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const { targets } = await computeCancelTargets(pool, A.id);
  const t = targets.find((x) => x.target === 'addon:additional-bartender');
  assert.ok(t, JSON.stringify(targets));
  assert.equal(t.quantity, 3);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyLineItemCancel(client, { proposalId: A.id, target: 'addon:additional-bartender', quantity: 1, actorId: adminId });
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  const stored = await addonRows(A.id);
  assert.equal(Number(stored[0].quantity), 8, '2 remaining x 4 contract hours');
  const after = (await loadRepriceAddons(pool, A.id)).find((r) => r.slug === 'additional-bartender');
  assert.equal(after.quantity, 2);
  const p = await row(A.id);
  assert.equal(dollars(p.total_price), dollars(engine({ pkg: corePkg, hours: 4, addonCount: 2 }).total));
  assert.equal(p.pricing_snapshot.inputs.durationHours, 4);
});

// ─── the roster ──────────────────────────────────────────────────────────────
test('the shift roster keeps all three additional bartenders after the extension', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  await syncShiftsFromProposal(A.id, pool);
  const shift = (await pool.query('SELECT positions_needed FROM shifts WHERE proposal_id = $1', [A.id])).rows[0];
  const positions = typeof shift.positions_needed === 'string' ? JSON.parse(shift.positions_needed) : shift.positions_needed;
  const bartenders = positions.filter((p) => p === 'Bartender').length;
  // 1 package bartender + 3 additional. At the worked hours: 12/5 = 2.4 -> 3 total.
  assert.equal(bartenders, 4);
});

// ─── the preview and the read ────────────────────────────────────────────────
test('POST /calculate with proposal_id prices the contract hours; without it, the body hours; garbage is ignored', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const base = {
    package_id: corePkg.id, guest_count: 100, duration_hours: 5, num_bars: 0,
    addon_ids: [bartenderAddon.id], addon_quantities: { [String(bartenderAddon.id)]: 3 },
  };
  const withId = await request('POST', '/api/proposals/calculate', { ...base, proposal_id: A.id });
  assert.equal(withId.status, 200, JSON.stringify(withId.body));
  assert.equal(dollars(withId.body.total), dollars(A.snap.total));
  const without = await request('POST', '/api/proposals/calculate', base);
  assert.equal(dollars(without.body.total), dollars(engine({ pkg: corePkg, hours: 5 }).total));
  const garbage = await request('POST', '/api/proposals/calculate', { ...base, proposal_id: 'abc' });
  assert.equal(garbage.status, 200);
  assert.equal(dollars(garbage.body.total), dollars(without.body.total));
  // A draft mandate derives its rate from the same hours as the PATCH would.
  const mandate = await request('POST', '/api/proposals/calculate', { ...base, proposal_id: A.id, gratuity_mandate_total: 800 });
  assert.equal(mandate.status, 200, JSON.stringify(mandate.body));
  // 4 staff (1 + 3) x 4 contract hours = 16 staff-hours: $800 is $50/hr.
  assert.equal(Number(mandate.body.gratuity.rate), 50);
});

test('GET /proposals/:id always carries settled_extension_hours: 1 on A, 0 on Z', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const Z = await seed({ name: 'Z', pkg: corePkg, contractHours: 4, workedHours: 4 });
  const a = await request('GET', `/api/proposals/${A.id}`);
  const z = await request('GET', `/api/proposals/${Z.id}`);
  assert.equal(a.status, 200);
  assert.equal(a.body.settled_extension_hours, 1);
  assert.equal(z.body.settled_extension_hours, 0);
});

test('priceProposedState with no settled rows never touches service_extensions (the public routes pay nothing)', async () => {
  const A = await seed({ name: 'A', pkg: corePkg, contractHours: 4, workedHours: 5 });
  const p = await row(A.id);
  const catalog = { packages: [corePkg], addons: [bartenderAddon] };
  const fakeDb = {
    query: async (sql) => {
      if (/service_extensions/i.test(sql)) throw new Error('public pricing must not read service_extensions');
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  };
  const snap = await priceProposedState(p, { addon_ids: [bartenderAddon.id], addon_quantities: { [String(bartenderAddon.id)]: 3 } }, fakeDb, catalog);
  // Priced at the ROW's hours, exactly as before this lane.
  assert.equal(snap.inputs.durationHours, 5);
});
