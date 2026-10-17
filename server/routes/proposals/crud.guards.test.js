'use strict';
// Route tests for the editor PATCH guards (plan 2026-10-16 Task E2; spec
// sections 5.1 and 5.3): the stale-lines token, the legal hold, the retired
// override, line validation, the audit, and the original duration bug.
//
// Runs against the dev database (DATABASE_URL from .env) with the real crud
// and getOne routers on express() + app.listen(0), the harness of crud.test.js.
// Every row is synthetic (synthetic labels and amounts) and purged in after().
// A legal hold is ADDED through __setLegalHoldIdsForTest on a fixture's own id;
// nothing here reads or writes a real held booking.

require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const { calculateProposal } = require('../../utils/pricingEngine');
const { __setLegalHoldIdsForTest } = require('../../utils/legalHold');
const crudRouter = require('./crud');

if (process.env.NODE_ENV === 'production') throw new Error('crud.guards.test.js refuses to run against production');

const NONCE = `crg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server; let baseUrl; let token; let clientId; let corePkg;
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
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const cents = (n) => Math.round(Number(n) * 100);
// updated_at to the millisecond: String(Date) drops the milliseconds.
const at = (r) => new Date(r.updated_at).getTime();
const discount = (label, amount, visible = true) => ({ type: 'discount', label, amount, visible });
const AGREED = (amount) => ({ type: 'discount', label: 'Agreed price adjustment', amount, visible: false, source: 'agreed_price' });

function engine({ hours = 4, guests = 50, adjustments = [], override = null } = {}) {
  return calculateProposal({
    pkg: corePkg, guestCount: guests, durationHours: hours, numBars: 0, numBartenders: null,
    addons: [], syrupSelections: [], adjustments, totalPriceOverride: override,
    gratuityRate: 0, tipJar: true, gratuityFloorRate: null,
  });
}

// A proposal priced by the engine from its own inputs, so a re-price that
// changes nothing lands on the same total. `storedLines` lets a fixture store
// the lines in another spelling than the engine read (prod keeps 58 of 72
// amounts as numeric strings).
async function seed({ adjustments = [], storedLines, storedJson, override = null, status = 'sent', paid = false, hours = 4, guests = 50 } = {}) {
  const snap = engine({ hours, guests, adjustments, override });
  const r = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, status, guest_count, event_duration_hours, num_bars, num_bartenders,
        gratuity_rate, tip_jar, total_price, total_price_override, amount_paid,
        event_date, event_start_time, event_timezone, pricing_snapshot, adjustments, payment_type, event_type,
        venue_street, venue_city, venue_state)
     VALUES ($1, $2, $3, $4, $5, 0, NULL, 0, true, $6, $7, $8,
        '2027-06-12', '6:00 PM', 'America/Chicago', $9, $10, 'full', 'Wedding',
        '123 Test St', 'Rockford', 'IL')
     RETURNING *`,
    [clientId, corePkg.id, status, guests, hours, snap.total, override, paid ? snap.total : 0,
      JSON.stringify(snap), storedJson || JSON.stringify(storedLines || adjustments)]
  );
  made.proposals.push(r.rows[0].id);
  return r.rows[0];
}

async function row(id) {
  const r = await pool.query(
    `SELECT *, md5(COALESCE(adjustments, '[]'::jsonb)::text) AS db_token, adjustments::text AS lines_text
       FROM proposals WHERE id = $1`, [id]);
  return r.rows[0];
}
async function activity(id, action = 'updated') {
  const r = await pool.query(
    'SELECT details FROM proposal_activity_log WHERE proposal_id = $1 AND action = $2 ORDER BY id', [id, action]);
  return r.rows.map((x) => x.details);
}
async function tokenFromGet(id) {
  const res = await request('GET', `/api/proposals/${id}`);
  assert.equal(res.status, 200, res.raw);
  assert.equal(typeof res.body.adjustments_token, 'string', 'the GET carries adjustments_token');
  return res.body.adjustments_token;
}

before(async () => {
  const c = await pool.query('INSERT INTO clients (name, email, source) VALUES ($1, $2, $3) RETURNING id',
    [`${NONCE} client`, `${NONCE}@example.test`, 'direct']);
  clientId = c.rows[0].id;
  corePkg = (await pool.query("SELECT * FROM service_packages WHERE slug = 'the-core-reaction'")).rows[0];
  assert.ok(corePkg, 'dev catalog is missing The Core Reaction');

  const u = await pool.query(
    `INSERT INTO users (email, password_hash, role, token_version) VALUES ($1, 'x', 'admin', 0) RETURNING id, token_version`,
    [`${NONCE}-admin@example.test`]
  );
  made.users.push(u.rows[0].id);
  token = jwt.sign({ userId: u.rows[0].id, tokenVersion: u.rows[0].token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });

  crudRouter.__setDeps({
    sendProposalSentEmail: () => Promise.resolve(),
    createInvoiceOnSend: () => Promise.resolve(),
    sendRescheduleEmail: () => Promise.resolve({ email: 'skipped', sms: 'skipped', skip_reasons: {} }),
  });
  const app = express();
  app.use(express.json());
  app.use('/api/proposals', crudRouter);
  app.use('/api/proposals', require('./getOne'));
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
  __setLegalHoldIdsForTest(null);
  if (server) await new Promise((r) => server.close(r));
  if (made.proposals.length) {
    const ids = made.proposals;
    await pool.query(
      `DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1::int[])`, [ids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [ids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [ids]);
  }
  if (made.users.length) await pool.query('DELETE FROM users WHERE id = ANY($1)', [made.users]);
  await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await pool.end();
});

// ─── 1. the token round trip ────────────────────────────────────────────────
test('1: a line change carrying the GET token saves, and the response carries the new token', async () => {
  const p = await seed({ adjustments: [discount('Test discount A', 25)] });
  const t0 = await tokenFromGet(p.id);
  assert.equal(t0, (await row(p.id)).db_token, 'the GET token is md5 of the stored lines');
  const lines = [discount('Test discount A', 25), discount('Test discount B', 10)];
  const res = await request('PATCH', `/api/proposals/${p.id}`, { adjustments: lines, adjustments_token: t0 });
  assert.equal(res.status, 200, res.raw);
  const after1 = await row(p.id);
  assert.deepEqual(after1.adjustments, lines);
  assert.equal(cents(after1.total_price), cents(engine({ adjustments: lines }).total));
  assert.equal(res.body.adjustments_token, after1.db_token, 'the response carries the stored lines\' token');
  assert.notEqual(res.body.adjustments_token, t0);
  assert.equal(await tokenFromGet(p.id), res.body.adjustments_token, 'the next GET agrees');
});

// ─── 2. an old token ────────────────────────────────────────────────────────
test('2: the same kind of change with an old token is 409 STALE_EDIT and changes nothing', async () => {
  const p = await seed({ adjustments: [discount('Test discount A', 25)] });
  const t0 = await tokenFromGet(p.id);
  const first = await request('PATCH', `/api/proposals/${p.id}`, {
    adjustments: [discount('Test discount A', 30)], adjustments_token: t0,
  });
  assert.equal(first.status, 200, first.raw);
  const before2 = await row(p.id);
  const updatesBefore = (await activity(p.id)).length;
  const res = await request('PATCH', `/api/proposals/${p.id}`, {
    adjustments: [discount('Test discount A', 40)], adjustments_token: t0,
  });
  assert.equal(res.status, 409, res.raw);
  assert.equal(res.body.code, 'STALE_EDIT');
  assert.equal(res.body.error, 'This booking changed since you opened it. Reload to see the latest.');
  const after2 = await row(p.id);
  assert.deepEqual(after2.adjustments, before2.adjustments);
  assert.equal(after2.total_price, before2.total_price);
  assert.equal(at(after2), at(before2), 'no write landed');
  assert.equal((await activity(p.id)).length, updatesBefore, 'no activity entry');
  // Missing token: refused the same way.
  const missing = await request('PATCH', `/api/proposals/${p.id}`, { adjustments: [discount('Test discount A', 40)] });
  assert.equal(missing.status, 409, missing.raw);
  assert.equal(missing.body.code, 'STALE_EDIT');
});

// ─── 3. a server-written line vs a client page view (Review Focus 5) ────────
test('3: a client page view does not refuse the editor; a server-written line does', async () => {
  const p = await seed({ adjustments: [discount('Test discount A', 25)] });
  const t0 = await tokenFromGet(p.id);
  const beforeView = await row(p.id);
  // A client page view: publicToken.js bumps view_count, and the trigger moves updated_at.
  await pool.query('UPDATE proposals SET view_count = view_count + 1 WHERE id = $1', [p.id]);
  const afterView = await row(p.id);
  assert.notEqual(at(afterView), at(beforeView), 'the view moved updated_at');
  assert.equal(afterView.db_token, t0, 'the view left the lines, so the token stands');
  const tabLines = [discount('Test discount A', 25), discount('Test discount C', 15)];
  const saved = await request('PATCH', `/api/proposals/${p.id}`, { adjustments: tabLines, adjustments_token: t0 });
  assert.equal(saved.status, 200, saved.raw);
  const t1 = saved.body.adjustments_token;

  // A server-written line (a refund line, the conversion) lands after the tab loaded t1.
  await pool.query(
    `UPDATE proposals SET adjustments = adjustments || '[{"type":"discount","label":"Test server line","amount":5,"visible":true}]'::jsonb WHERE id = $1`,
    [p.id]
  );
  const refused = await request('PATCH', `/api/proposals/${p.id}`, {
    adjustments: [...tabLines, discount('Test discount D', 1)], adjustments_token: t1,
  });
  assert.equal(refused.status, 409, refused.raw);
  assert.equal(refused.body.code, 'STALE_EDIT');
  const kept = await row(p.id);
  assert.ok(kept.adjustments.some((a) => a.label === 'Test server line'), 'the server line survives');
});

// ─── 4. unchanged lines need no token ───────────────────────────────────────
test('4: a body echoing the stored lines (another spelling) saves with no token', async () => {
  const p = await seed({
    adjustments: [discount('Test discount A', 25)],
    storedLines: [{ type: 'discount', label: 'Test discount A', amount: '25.00', visible: true }],
  });
  const before4 = await row(p.id);
  // The shape contractDuration.extension.test.js sends: the full editor body,
  // the lines as read, the override as read, no token.
  const res = await request('PATCH', `/api/proposals/${p.id}`, {
    guest_count: 50, package_id: corePkg.id, num_bars: 0, addon_ids: [], addon_quantities: {},
    adjustments: [{ visible: true, amount: 25, label: 'Test discount A', type: 'discount' }],
    total_price_override: before4.total_price_override, venue_name: `${NONCE} venue`,
  });
  assert.equal(res.status, 200, res.raw);
  const after4 = await row(p.id);
  assert.equal(after4.total_price, before4.total_price);
  assert.equal(after4.venue_name, `${NONCE} venue`);
  // The lines went back as stored, so their token holds: another tab that
  // loaded them can still change them.
  assert.deepEqual(after4.adjustments, [{ type: 'discount', label: 'Test discount A', amount: '25.00', visible: true }]);
  assert.equal(after4.db_token, before4.db_token);
  assert.equal(res.body.adjustments_token, before4.db_token);
  // A partial body with no adjustments key needs no token either.
  const partial = await request('PATCH', `/api/proposals/${p.id}`, { guest_count: 55 });
  assert.equal(partial.status, 200, partial.raw);
  assert.equal((await row(p.id)).db_token, before4.db_token);
  // A tab that loaded the lines before both saves changes them with its token.
  const other = await request('PATCH', `/api/proposals/${p.id}`, {
    adjustments: [discount('Test discount A', 30)], adjustments_token: before4.db_token,
  });
  assert.equal(other.status, 200, other.raw);
});

// ─── 5. the legal hold ──────────────────────────────────────────────────────
test('5: a held booking is refused before any write, change request included; a crafted id is a 400', async () => {
  const p = await seed({ adjustments: [discount('Test discount A', 25)] });
  const cr = await pool.query(
    `INSERT INTO proposal_change_requests (proposal_id, status, edit_window, requested_changes)
     VALUES ($1, 'pending', 'pre_booking', $2) RETURNING id`,
    [p.id, JSON.stringify({ guest_count: 60 })]
  );
  __setLegalHoldIdsForTest([p.id]);
  try {
    const before5 = await row(p.id);
    const res = await request('PATCH', `/api/proposals/${p.id}`, { guest_count: 60, change_request_id: cr.rows[0].id });
    assert.equal(res.status, 409, res.raw);
    assert.equal(res.body.code, 'LEGAL_HOLD');
    assert.equal(res.body.error, 'This booking is on legal hold and cannot be edited.');
    const after5 = await row(p.id);
    assert.equal(after5.guest_count, before5.guest_count);
    assert.equal(after5.total_price, before5.total_price);
    assert.equal(at(after5), at(before5), 'no write landed');
    const crAfter = await pool.query('SELECT status FROM proposal_change_requests WHERE id = $1', [cr.rows[0].id]);
    assert.equal(crAfter.rows[0].status, 'pending', 'the change request was neither approved nor superseded');
    assert.equal((await activity(p.id, 'updated')).length, 0);
    assert.equal((await activity(p.id, 'change_approved')).length, 0);

    // The id as Postgres would read it but no plain parse would: 400, never a write.
    const s = String(p.id);
    const crafted = `${s[0]}_${s.slice(1)}`;
    const res2 = await request('PATCH', `/api/proposals/${crafted}`, { guest_count: 60 });
    assert.equal(res2.status, 400, res2.raw);
    assert.deepEqual(res2.body.fieldErrors, { id: 'Invalid proposal id.' });
    assert.equal(at(await row(p.id)), at(before5));

    // The admin GET carries the flag, so the editor opens read-only.
    const got = await request('GET', `/api/proposals/${p.id}`);
    assert.equal(got.status, 200, got.raw);
    assert.equal(got.body.legal_hold, true);
  } finally {
    __setLegalHoldIdsForTest(null);
  }
  const got2 = await request('GET', `/api/proposals/${p.id}`);
  assert.equal(got2.body.legal_hold, false);
});

// ─── 6. the retired override ────────────────────────────────────────────────
test('6: a changed override is a 400 on total_price_override; the stored value saves', async () => {
  const p = await seed({ override: 2425 });
  const before6 = await row(p.id);
  assert.equal(before6.total_price_override, '2425.00');
  const changed = await request('PATCH', `/api/proposals/${p.id}`, { total_price_override: 2400 });
  assert.equal(changed.status, 400, changed.raw);
  assert.deepEqual(changed.body.fieldErrors, { total_price_override: 'Price overrides are retired. Use Set agreed price.' });
  assert.equal((await row(p.id)).total_price_override, '2425.00');
  for (const same of ['2425.00', 2425]) {
    const res = await request('PATCH', `/api/proposals/${p.id}`, { total_price_override: same, guest_count: 50 });
    assert.equal(res.status, 200, res.raw);
  }
  const after6 = await row(p.id);
  assert.equal(after6.total_price_override, '2425.00');
  assert.equal(cents(after6.total_price), 242500);
  // A new override on a booking that has none is refused too (a stored NULL against 0 differs).
  const native = await seed();
  const zero = await request('PATCH', `/api/proposals/${native.id}`, { total_price_override: 0 });
  assert.equal(zero.status, 400, zero.raw);
  assert.equal((await row(native.id)).total_price_override, null);
});

// ─── 7. a bad line ──────────────────────────────────────────────────────────
test('7: a bad adjustment is a 400 on adjustments and writes nothing', async () => {
  const p = await seed({ adjustments: [discount('Test discount A', 25)] });
  const t0 = await tokenFromGet(p.id);
  const before7 = await row(p.id);
  for (const lines of [
    [{ type: 'gift', label: 'Test bad', amount: 1, visible: true }],
    [discount('Test discount A', -5)],
    [discount('x'.repeat(256), 5)],
  ]) {
    const res = await request('PATCH', `/api/proposals/${p.id}`, { adjustments: lines, adjustments_token: t0 });
    assert.equal(res.status, 400, res.raw);
    assert.equal(typeof res.body.fieldErrors.adjustments, 'string');
  }
  // A refund line the booking never had: refused, never minted.
  const minted = await request('PATCH', `/api/proposals/${p.id}`, {
    adjustments: [discount('Test discount A', 25), { type: 'discount', label: 'Refund', amount: 5, visible: true, source: 'refund', refund_id: 2147480000 }],
    adjustments_token: t0,
  });
  assert.equal(minted.status, 400, minted.raw);
  assert.equal(typeof minted.body.fieldErrors.adjustments, 'string');
  const after7 = await row(p.id);
  assert.deepEqual(after7.adjustments, before7.adjustments);
  assert.equal(at(after7), at(before7));
});

// ─── 8. the audit ───────────────────────────────────────────────────────────
test('8: a save that changed the lines logs the old and new arrays; one that did not, neither', async () => {
  const p = await seed({ adjustments: [discount('Test discount A', 25)] });
  const t0 = await tokenFromGet(p.id);
  const lines = [discount('Test discount A', 25), AGREED(12.5)];
  const res = await request('PATCH', `/api/proposals/${p.id}`, { adjustments: lines, adjustments_token: t0 });
  assert.equal(res.status, 200, res.raw);
  const quiet = await request('PATCH', `/api/proposals/${p.id}`, { guest_count: 50 });
  assert.equal(quiet.status, 200, quiet.raw);
  const entries = await activity(p.id);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0].old_adjustments, [discount('Test discount A', 25)]);
  assert.deepEqual(entries[0].new_adjustments, lines);
  assert.equal(typeof entries[0].new_total, 'number');
  assert.equal('old_adjustments' in entries[1], false);
  assert.equal('new_adjustments' in entries[1], false);
});

// ─── 9. the original bug ────────────────────────────────────────────────────
test('9: a hidden agreed-price discount and no override: one more hour adds exactly that hour\'s catalog price', async () => {
  const lines = [AGREED(100)];
  const p = await seed({ adjustments: lines });
  const before9 = await row(p.id);
  const res = await request('PATCH', `/api/proposals/${p.id}`, {
    event_duration_hours: 5, guest_count: 50, package_id: corePkg.id, num_bars: 0,
    addon_ids: [], addon_quantities: {}, adjustments: lines,
  });
  assert.equal(res.status, 200, res.raw);
  const after9 = await row(p.id);
  const hourCents = cents(engine({ hours: 5, adjustments: lines }).total) - cents(engine({ hours: 4, adjustments: lines }).total);
  assert.equal(hourCents, cents(corePkg.extra_hour_rate), 'the engine prices the hour at the catalog extra-hour rate');
  assert.ok(hourCents > 0);
  assert.equal(cents(after9.total_price) - cents(before9.total_price), hourCents);
  assert.deepEqual(after9.adjustments, lines, 'the agreed-price line rides along unchanged');
});

// ─── 10. the token survives the status reconcile ────────────────────────────
test('10: a line save that demotes a fully paid booking still answers with the stored lines\' token', async () => {
  const p = await seed({ status: 'balance_paid', paid: true });
  const t0 = await tokenFromGet(p.id);
  const res = await request('PATCH', `/api/proposals/${p.id}`, {
    adjustments: [{ type: 'surcharge', label: 'Test surcharge', amount: 50, visible: true }], adjustments_token: t0,
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.status, 'deposit_paid', 'the price rise demoted the booking');
  assert.equal(res.body.adjustments_token, (await row(p.id)).db_token);
});

// ─── fix round 1 ────────────────────────────────────────────────────────────
// Database and code review MINOR-1: freshness decides whether a body may speak
// about the lines at all, so a stale tab gets 409 with Reload, never a 400.
test('11: a stale tab still holding a refund line another tab removed gets 409 STALE_EDIT, not the marker 400', async () => {
  const refund = { type: 'discount', label: 'Refund', amount: 5, visible: true, source: 'refund', refund_id: 2147480001 };
  const p = await seed({ adjustments: [refund] });
  const t0 = await tokenFromGet(p.id);
  // Another tab removed the refund line.
  await pool.query(`UPDATE proposals SET adjustments = '[]'::jsonb WHERE id = $1`, [p.id]);
  const res = await request('PATCH', `/api/proposals/${p.id}`, { adjustments: [refund], adjustments_token: t0 });
  assert.equal(res.status, 409, res.raw);
  assert.equal(res.body.code, 'STALE_EDIT');
  assert.deepEqual((await row(p.id)).adjustments, []);
});

// Code MINOR-2, database NIT-1, consistency MINOR-2: a save that leaves the
// lines alone does not rewrite the column, so a jsonb number keeps its scale
// (162.50 would come back from a JS round trip as 162.5) and the token holds.
test('12: a save that leaves the lines alone leaves the column untouched, scale and token included', async () => {
  const lines = [discount('Test discount A', 162.5)];
  const p = await seed({ adjustments: lines, storedJson: '[{"type":"discount","label":"Test discount A","amount":162.50,"visible":true}]' });
  const before12 = await row(p.id);
  assert.match(before12.lines_text, /162\.50/);
  const partial = await request('PATCH', `/api/proposals/${p.id}`, { guest_count: 55 });
  assert.equal(partial.status, 200, partial.raw);
  const echo = await request('PATCH', `/api/proposals/${p.id}`, { guest_count: 50, adjustments: lines });
  assert.equal(echo.status, 200, echo.raw);
  const after12 = await row(p.id);
  assert.equal(after12.lines_text, before12.lines_text, 'the column was not rewritten');
  assert.equal(after12.db_token, before12.db_token);
  assert.equal(echo.body.adjustments_token, before12.db_token);
  // A real change still writes, and emptying the lines writes [].
  const t = await tokenFromGet(p.id);
  const emptied = await request('PATCH', `/api/proposals/${p.id}`, { adjustments: [], adjustments_token: t });
  assert.equal(emptied.status, 200, emptied.raw);
  assert.deepEqual((await row(p.id)).adjustments, []);
});

// Security MINOR-1: a half-cent string passed the cents compare and
// NUMERIC(10,2) then stored the next cent. It is refused, and when the guard
// passes the route writes the stored override, never the body's spelling.
test('13: a half-cent override string is refused and never moves the stored override', async () => {
  const p = await seed({ override: 1024.21 });
  assert.equal((await row(p.id)).total_price_override, '1024.21');
  const half = await request('PATCH', `/api/proposals/${p.id}`, { total_price_override: '1024.215' });
  assert.equal(half.status, 400, half.raw);
  assert.deepEqual(half.body.fieldErrors, { total_price_override: 'Price overrides are retired. Use Set agreed price.' });
  assert.equal((await row(p.id)).total_price_override, '1024.21');
  const same = await request('PATCH', `/api/proposals/${p.id}`, { total_price_override: 1024.21, guest_count: 50 });
  assert.equal(same.status, 200, same.raw);
  const after13 = await row(p.id);
  assert.equal(after13.total_price_override, '1024.21');
  assert.equal(cents(after13.total_price), 102421);
});
