// The client portal never hands a client a hidden line, the price override or
// the fold (spec 2026-10-16 section 4.4; plan Task Q1). The Prescription tab's
// rows come from the server, built by clientPriceLines.js against the
// booking's total_price less its client gratuity, so rows plus gratuity equal
// the Total the portal shows. Every portal route is asserted on its RAW
// response body, so a field the parsed object hides (a duplicate key, a nested
// copy) still fails: no hidden line's label, no hidden line's amount, no
// pre-fold subtotal, no override, no snapshot, no adjustments, no fold report.
// The change-request routes send totals only (price_preview), the arithmetic
// channel spec 4.3 accepts; they are swept here for keys and hidden lines. The
// approved email is pinned in server/utils/changeRequestNotifications.test.js.
//
// Runs ALONE against the shared dev DB:
//   node --test server/routes/clientPortal.test.js

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// The fold report: a fake DSN so reportPriceRowsFold reaches Sentry, and a
// recorder in place of the real call (publicToken.priceRows.test.js
// precedent). Sentry is never initialized here, and nothing from this suite
// reaches a real Sentry project.
process.env.SENTRY_DSN_SERVER = process.env.SENTRY_DSN_SERVER || 'https://test@example.invalid/1';
const sentryModule = require('@sentry/node');
const sentryMessages = [];
sentryModule.captureMessage = (msg, ctx) => { sentryMessages.push({ msg, ctx }); };
sentryModule.captureException = () => {};

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const clientPortalRouter = require('./clientPortal');
const { buildPublicProposalPayload } = require('./proposals/publicToken');

if (process.env.NODE_ENV === 'production') {
  throw new Error('clientPortal.test.js refuses to run against production');
}

const SECRET_LABEL = 'Test portal secret';
const SECRET_AMOUNT = '123.45';     // the hidden discount
const SECRET_SUBTOTAL = '777.77';   // the pre-fold subtotal
const OVERRIDE = '612.34';          // a service-level override, gratuity on top
const GRATUITY = 80;
const SECRETS = [SECRET_LABEL, SECRET_AMOUNT, SECRET_SUBTOTAL];
const FORBIDDEN_KEYS = [
  'total_price_override', 'pricing_snapshot', 'adjustments', 'breakdown', 'subtotal',
  'fold', 'gapCents', 'hiddenNetCents', 'explainedCents', 'unexplainedCents',
];

const NONCE = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
let server;
let baseUrl;
let pkg;
const createdProposalIds = new Set();
const createdClientIds = new Set();

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

function keysDeep(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.add(k); keysDeep(x, out); }
  }
  return out;
}

/** The leak assertions, on the raw body first and the parsed keys second. */
function assertNoLeak(res, what, extraSecrets = []) {
  for (const s of [...SECRETS, ...extraSecrets]) {
    assert.ok(!res.raw.includes(s), `${what}: the raw body carries "${s}"`);
  }
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!res.raw.includes(`"${k}"`), `${what}: the raw body carries a "${k}" key`);
  }
  const keys = keysDeep(res.body);
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `${what}: a "${k}" key at some depth`);
}

const cents = (dollars) => Math.round(Number(dollars) * 100);
const sumCents = (rows) => rows.reduce((s, r) => s + cents(r.amount), 0);
const reportsFor = (id) => sentryMessages.filter((m) => m.ctx && m.ctx.extra && m.ctx.extra.proposalId === id);

// A synthetic engine-shaped snapshot (pricingEngine.calculateProposal):
// subtotal 600 + 50 + 99.77 + 28 = 777.77, a client gratuity of 80 on top.
function baseSnapshot() {
  return {
    _version: 1, // PRICING_SNAPSHOT_VERSION: readSnapshot refuses a future one
    calculated_at: '2026-10-16T00:00:00.000Z',
    inputs: { guestCount: 120, durationHours: 4, numBars: 1, numBartenders: 2 },
    package: { id: pkg.id, slug: pkg.slug, name: pkg.name, category: 'byob', pricing_type: 'flat', base_cost: 600 },
    bar_rental: { num_bars: 1, first_bar_fee: 50, additional_bar_fee: 100, total: 50 },
    staffing: { included: 2, required: 2, actual: 2, extra: 0, hourly_rate: 40, total: 0 },
    addons: [{ name: 'Test Portal Add-on', billing_type: 'flat', rate: 99.77, quantity: 1, line_total: 99.77 }],
    syrups: { selections: ['s-1', 's-2'], count: 2, bottles_per_flavor: 1, total_bottles: 2, packs: 0, singles: 2, total: 28 },
    breakdown: [
      { label: 'Test Portal Package (4hrs, 120 guests)', amount: 600 },
      { label: 'Bar Rental (1 bar)', amount: 50 },
      { label: 'Test Portal Add-on', amount: 99.77 },
      { label: 'Hand-Crafted Syrups (2 flavors, 2 bottles)', amount: 28 },
      { label: 'Gratuity', amount: GRATUITY },
    ],
    staff_noun: 'bartender',
    display_labels: { 'Shared Gratuity': 'Staffing Gratuity', Gratuity: 'Gratuity' },
    gratuity: { rate: 10, tip_jar: true, staff_count: 2, hours: 4, staff_noun: 'bartender', total: GRATUITY, floor_rate: null },
    floor_applied: false,
    floor_reason: null,
    billed_guests: 120,
    adjustments: [],
    total_price_override: null,
    subtotal: 777.77,
    total: 857.77,
  };
}

// One hidden discount: service 777.77 - 123.45 = 654.32, total 734.32.
function hiddenSnapshot() {
  const s = baseSnapshot();
  s.adjustments = [{ type: 'discount', label: SECRET_LABEL, amount: 123.45, visible: false }];
  s.breakdown.splice(4, 0, { label: SECRET_LABEL, amount: -123.45 });
  s.total = 734.32;
  return s;
}

// A $612.34 override with the gratuity on top (pricingEngine: total =
// serviceTotal + gratuity), so total_price is 692.34. The old portal showed
// the override as the Total and left the gratuity out of it.
function overrideSnapshot() {
  const s = baseSnapshot();
  s.total_price_override = 612.34;
  s.total = 692.34;
  return s;
}

// The same hidden line on an override booking: the override fixes the
// service total, so the line moves no figure but is stored all the same.
function withHiddenLine(s) {
  s.adjustments = [{ type: 'discount', label: SECRET_LABEL, amount: 123.45, visible: false }];
  s.breakdown.splice(4, 0, { label: SECRET_LABEL, amount: -123.45 });
  return s;
}

async function mkClient(tag) {
  const email = `cp-rows-${tag}-${NONCE}@example.com`;
  const r = await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id', [`CP Rows ${tag}`, email]);
  const id = r.rows[0].id;
  createdClientIds.add(id);
  return { id, token: jwt.sign({ id, email, role: 'client' }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
}

/** A booking that carries `snapshot` exactly as stored, its lines in the row too. */
async function mkProposal(clientId, { status = 'deposit_paid', snapshot, totalPrice, override = null, paid = 100, dayOffset = 90 }) {
  const r = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, guest_count, event_duration_hours, num_bars,
                            event_date, event_start_time, event_type, total_price, amount_paid,
                            pricing_snapshot, adjustments, total_price_override)
     VALUES ($1, $2, $3, 120, 4, 1, CURRENT_DATE + $4::int, '5:00 PM', 'wedding', $5, $6, $7, $8, $9)
     RETURNING id, token`,
    [clientId, pkg.id, status, dayOffset, totalPrice, paid,
      JSON.stringify(snapshot), JSON.stringify(snapshot.adjustments || []), override]
  );
  createdProposalIds.add(r.rows[0].id);
  return r.rows[0];
}

const detail = (p, c) => request('GET', `/api/client-portal/proposals/${p.token}`, c.token);

before(async () => {
  const byob = await pool.query(
    `SELECT id, slug, name FROM service_packages WHERE category = 'byob' AND is_active = true ORDER BY id LIMIT 1`);
  pkg = byob.rows[0];
  assert.ok(pkg, 'the dev catalog carries an active BYOB package');

  const app = express();
  app.use(express.json());
  app.use('/api/client-portal', clientPortalRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
    console.error('[clientPortal.test] unexpected error:', err);
    return res.status(500).json({ error: 'Internal error', code: 'INTERNAL_ERROR' });
  });
  await new Promise((resolve) => {
    server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  const pids = [...createdProposalIds];
  if (pids.length > 0) {
    await pool.query('DELETE FROM proposal_change_requests WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [pids]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  await pool.end();
});

test('detail: a hidden discount folds into the package row, rows plus gratuity equal total_price, nothing hidden leaves', async () => {
  const c = await mkClient('hidden');
  const p = await mkProposal(c.id, { snapshot: hiddenSnapshot(), totalPrice: '734.32' });
  const res = await detail(p, c);
  assert.equal(res.status, 200, res.raw);
  assertNoLeak(res, 'detail (hidden)');
  const d = res.body.proposal;
  assert.deepEqual(d.price_rows.map((r) => r.key), ['package', 'bar-rental', 'addon-0', 'syrups'], 'no row for the hidden line');
  assert.equal(d.price_rows[0].label, pkg.name, 'the package row carries the name the proposal page uses');
  assert.equal(d.price_rows[0].amount, 476.55, '600 less the hidden 123.45');
  assert.equal(d.gratuity_amount, GRATUITY);
  assert.equal(sumCents(d.price_rows), cents('734.32') - cents(GRATUITY), 'the rows reach total_price less gratuity');
  assert.equal(sumCents(d.price_rows) + cents(d.gratuity_amount), cents(d.total_price), 'rows plus gratuity equal total_price');
  assert.deepEqual(reportsFor(p.id), [], 'a fold the snapshot explains pages nobody');
});

test('detail: an override booking with a gratuity adds up to total_price, and the override never leaves', async () => {
  const c = await mkClient('override');
  const p = await mkProposal(c.id, { snapshot: overrideSnapshot(), totalPrice: '692.34', override: OVERRIDE });
  const stored = (await pool.query('SELECT total_price_override, pricing_snapshot FROM proposals WHERE id = $1', [p.id])).rows[0];
  assert.equal(stored.total_price_override, OVERRIDE, 'premise: the row carries the override');
  assert.equal(Number(stored.pricing_snapshot.total_price_override), Number(OVERRIDE), 'premise: so does its snapshot');

  const res = await detail(p, c);
  assert.equal(res.status, 200, res.raw);
  assertNoLeak(res, 'detail (override)', [OVERRIDE]);
  const d = res.body.proposal;
  assert.equal(cents(d.total_price), cents('692.34'), 'the Total is total_price, gratuity included');
  assert.equal(d.price_rows.find((r) => r.key === 'package').amount, 434.57, '600 less the override difference 165.43');
  assert.equal(d.gratuity_amount, GRATUITY);
  assert.equal(sumCents(d.price_rows) + cents(d.gratuity_amount), cents(d.total_price), 'rows plus gratuity equal total_price');
  assert.deepEqual(reportsFor(p.id), [], 'the override difference is explained by its own snapshot');
});

test('parity: a booking whose total matches its snapshot shows the proposal page rows and gratuity in the portal', async () => {
  // The page's own payload builder (no side effects), so a change to the
  // page's target, gratuity rule or package label that the portal does not
  // share fails here.
  const c = await mkClient('parity');
  const cases = [
    { snapshot: hiddenSnapshot(), totalPrice: '734.32', override: null },
    { snapshot: overrideSnapshot(), totalPrice: '692.34', override: OVERRIDE },
  ];
  for (const [i, k] of cases.entries()) {
    const p = await mkProposal(c.id, { ...k, dayOffset: 90 + i });
    const portal = await detail(p, c);
    assert.equal(portal.status, 200, portal.raw);
    const page = await buildPublicProposalPayload(p.token);
    assert.ok(page && page.price_rows.length > 0, 'premise: the page draws rows');
    assert.deepEqual(portal.body.proposal.price_rows, page.price_rows, `case ${i}: the same rows`);
    assert.equal(cents(portal.body.proposal.gratuity_amount), cents(page.pricing_snapshot.gratuity.total),
      `case ${i}: the same gratuity row`);
  }
});

test('detail: a total_price that drifted off its snapshot folds into the package and pages Sentry once, by id only', async () => {
  const c = await mkClient('drift');
  // $20 above its snapshot with no refund (the shape of prod 59): the portal
  // shows total_price, so the rows reach it and the gap is reported.
  const p = await mkProposal(c.id, { snapshot: baseSnapshot(), totalPrice: '877.77' });
  const res = await detail(p, c);
  assert.equal(res.status, 200, res.raw);
  assertNoLeak(res, 'detail (drift)');
  const d = res.body.proposal;
  assert.equal(d.price_rows.find((r) => r.key === 'package').amount, 620);
  assert.equal(sumCents(d.price_rows) + cents(d.gratuity_amount), cents('877.77'));
  const reports = reportsFor(p.id);
  assert.deepEqual(reports.map((m) => m.msg), ['public_rows_unexplained_gap']);
  assert.deepEqual(reports[0].ctx, {
    level: 'warning', tags: { route: 'client-portal', step: 'price_rows' }, extra: { proposalId: p.id },
  }, 'the proposal id only, never an amount');
  await detail(p, c);
  assert.equal(reportsFor(p.id).length, 1, 'a refreshed tab does not page again');
});

test('detail: a write landing mid-request cannot tear the rows (one statement reads the total and the snapshot)', async () => {
  // The database review's scenario: the payment webhook applies an $80
  // gratuity election in ONE UPDATE (total_price and pricing_snapshot
  // together) right after the route's row read. Rows built from the new
  // snapshot against the old total would fold the gratuity out of the package
  // row and page Sentry for a booking that never drifted.
  const c = await mkClient('torn');
  const before = hiddenSnapshot();
  before.gratuity = { ...before.gratuity, rate: 0, total: 0 };
  before.breakdown = before.breakdown.filter((r) => r.label !== 'Gratuity');
  before.total = 654.32;
  const p = await mkProposal(c.id, { snapshot: before, totalPrice: '654.32' });

  const realQuery = pool.query;
  let fired = false;
  pool.query = async function wrappedQuery(...args) {
    const out = await realQuery.apply(this, args);
    const text = typeof args[0] === 'string' ? args[0] : '';
    if (!fired && text.includes('WHERE p.token = $1 AND p.client_id = $2')) {
      fired = true;
      await realQuery.call(this, 'UPDATE proposals SET total_price = $2, pricing_snapshot = $3 WHERE id = $1',
        [p.id, '734.32', JSON.stringify(hiddenSnapshot())]);
    }
    return out;
  };
  let res;
  try { res = await detail(p, c); } finally { pool.query = realQuery; }

  assert.ok(fired, 'premise: the write landed right after the route read the row');
  assert.equal(res.status, 200, res.raw);
  assertNoLeak(res, 'detail (torn)');
  const d = res.body.proposal;
  assert.equal(cents(d.total_price), cents('654.32'), 'the row predates the write');
  assert.equal(d.gratuity_amount, 0, 'and so does the gratuity the rows leave out');
  assert.equal(d.price_rows.find((r) => r.key === 'package').amount, 476.55, 'only the hidden 123.45 folds');
  assert.equal(sumCents(d.price_rows) + cents(d.gratuity_amount), cents(d.total_price));
  assert.deepEqual(reportsFor(p.id), [], 'no false drift report');
});

test('detail: a hidden discount bigger than the package row keeps the package and adds one Pricing adjustment row', async () => {
  const c = await mkClient('fallback');
  // 777.77 less a hidden 650 = 127.77; the package row (600) cannot carry it.
  const snap = baseSnapshot();
  snap.adjustments = [{ type: 'discount', label: SECRET_LABEL, amount: 650, visible: false }];
  snap.total = 207.77;
  const p = await mkProposal(c.id, { snapshot: snap, totalPrice: '207.77' });
  const res = await detail(p, c);
  assert.equal(res.status, 200, res.raw);
  assertNoLeak(res, 'detail (fallback)');
  const d = res.body.proposal;
  assert.equal(d.price_rows.find((r) => r.key === 'package').amount, 600);
  // By design (spec D3, the invoice rule): the gap rides one visible row
  // under the shared label, never under its own.
  assert.deepEqual(d.price_rows.at(-1), { key: 'pricing-adjustment', label: 'Pricing adjustment', amount: -650 });
  assert.equal(sumCents(d.price_rows) + cents(d.gratuity_amount), cents('207.77'));
  assert.deepEqual(reportsFor(p.id).map((m) => m.msg), ['public_rows_fold_fallback']);
});

test('detail: no priced snapshot, or no total_price, means no rows (never a $0 target) and no report', async () => {
  const c = await mkClient('legacy');
  const empty = await mkProposal(c.id, { snapshot: {}, totalPrice: '500.00' });
  const unpriced = await mkProposal(c.id, { snapshot: hiddenSnapshot(), totalPrice: null, dayOffset: 91 });

  const e = await detail(empty, c);
  assert.equal(e.status, 200, e.raw);
  assertNoLeak(e, 'detail (empty snapshot)');
  assert.deepEqual(e.body.proposal.price_rows, []);
  assert.equal(e.body.proposal.gratuity_amount, 0);

  const u = await detail(unpriced, c);
  assert.equal(u.status, 200, u.raw);
  assertNoLeak(u, 'detail (no total_price)');
  assert.deepEqual(u.body.proposal.price_rows, [], 'a NULL total_price is no target, never $0');
  assert.deepEqual([...reportsFor(empty.id), ...reportsFor(unpriced.id)], []);
});

test("detail: another client's token is a 404 that carries no price data", async () => {
  const owner = await mkClient('owner');
  const other = await mkClient('other');
  const p = await mkProposal(owner.id, { snapshot: hiddenSnapshot(), totalPrice: '734.32' });
  const res = await detail(p, other);
  assert.equal(res.status, 404, res.raw);
  assertNoLeak(res, 'detail (unowned)');
  assert.ok(!res.raw.includes('price_rows') && !res.raw.includes('476.55'), 'no rows for a token the client does not own');
});

test('home: the focus and the archive read total_price (override plus gratuity), never the override', async () => {
  const c = await mkClient('home');
  // Both carry a hidden line too (row and snapshot), so the label and amount
  // checks have something to find if a future focus or archive column leaks.
  const upcoming = await mkProposal(c.id, {
    snapshot: withHiddenLine(overrideSnapshot()), totalPrice: '692.34', override: OVERRIDE, paid: 100,
  });
  const past = await mkProposal(c.id, {
    status: 'completed', snapshot: withHiddenLine(overrideSnapshot()), totalPrice: '692.34', override: OVERRIDE,
    paid: 692.34, dayOffset: -30,
  });
  const res = await request('GET', '/api/client-portal/home', c.token);
  assert.equal(res.status, 200, res.raw);
  assertNoLeak(res, 'home', [OVERRIDE]);
  assert.equal(res.body.focus.token, upcoming.token);
  assert.equal(cents(res.body.focus.total_price), cents('692.34'));
  assert.equal(cents(res.body.focus.balance_due), cents('592.34'), 'the balance counts the gratuity');
  const row = res.body.archive.find((r) => r.token === past.token);
  assert.ok(row, 'the completed booking is in the archive');
  assert.equal(cents(row.total_price), cents('692.34'));
});

test('change requests: calculate, create, list and cancel carry no hidden line, snapshot or override key', async () => {
  const c = await mkClient('cr');
  const p = await mkProposal(c.id, { snapshot: hiddenSnapshot(), totalPrice: '734.32' });
  const base = `/api/client-portal/proposals/${p.token}`;

  const calc = await request('POST', `${base}/calculate`, c.token, { guest_count: 130 });
  assert.equal(calc.status, 200, calc.raw);
  assertNoLeak(calc, 'calculate');

  const created = await request('POST', `${base}/change-requests`, c.token, {
    guest_count: 130, acknowledged_total: calc.body.price_preview.estimated_total,
  });
  assert.equal(created.status, 201, created.raw);
  assertNoLeak(created, 'create');

  const list = await request('GET', `${base}/change-requests`, c.token);
  assert.equal(list.status, 200, list.raw);
  assertNoLeak(list, 'list');
  const open = list.body.requests.find((r) => r.status === 'pending');
  assert.ok(open, 'the request is open');

  const cancel = await request('POST', `${base}/change-requests/${open.id}/cancel`, c.token);
  assert.equal(cancel.status, 200, cancel.raw);
  assertNoLeak(cancel, 'cancel');
});
