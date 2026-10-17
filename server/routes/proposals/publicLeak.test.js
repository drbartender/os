// No hidden line reaches a token holder as a line (spec 2026-10-16 section
// 4.3; plan Task C4). Every public route that hands a booking's snapshot to a
// token holder is asserted against its RAW response body, so a field the
// parsed object hides (a duplicate key, a nested copy) still fails the test:
// no hidden line's label, no hidden line's amount, no override, no pre-fold
// subtotal, and the client's rows add up to the page's service total. These
// fixtures fold into the package row; a hidden amount larger than the package
// row is sent, by design, as one visible "Pricing adjustment" row (spec D3,
// pinned in publicToken.priceRows.test.js), never under its own label.
//
// Public-route sweep (2026-10-17, plan Task C4 Step 3:
// grep -rn "pricing_snapshot\|adjustments" server/routes | grep -v test).
// Token-holder responses that carry a booking's snapshot, all sanitized now:
//   GET /api/proposals/t/:token and the switch's 200 (both are
//   buildPublicProposalPayload, publicToken.js), GET /api/drink-plans/t/:token
//   (drinkPlans.js; a pre-booking plan answers { locked } with no snapshot).
// Public responses that carry none of it:
//   POST /api/proposals/public/calculate (public.js) prices the caller's own
//   configuration through the catalog, no booking data (spec 4.3 accepts it);
//   POST /api/stripe/create-intent/:token sends total_price and the gratuity
//   block only (stripeCreateIntent.js); POST /api/stripe/create-drink-plan-intent
//   sends extras and balance figures (stripe.js); the Lab's GET and PUT send
//   lab_breakdown, which prices only Lab additions, and balance totals
//   (drinkPlans/lab.js); drink-plan submit RETURNs plan columns only
//   (drinkPlans/submit.js); the quote draft is the visitor's own form state;
//   compareGroup.js is a positive allowlist (floor fields); the options quote
//   (publicOptions.js) sends totals priced with the booking's adjustments,
//   which is the arithmetic recovery spec 4.3 accepts, and no label (asserted
//   below); the client portal's change requests send price_preview totals.
//   Everything else the grep matches is admin-gated, a webhook, or internal.

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// Dev talks to live Stripe: the switch reaches Stripe only through getStripe,
// so a fake lands BEFORE the router chain is required (publicSwitch.test.js
// precedent). These fixtures carry no intents, so nothing is ever called.
const fakeStripe = {
  paymentIntents: {
    retrieve: (id) => {
      const e = new Error(`No such payment_intent: ${id}`);
      e.code = 'resource_missing';
      return Promise.reject(e);
    },
    cancel: (id) => Promise.resolve({ id, status: 'canceled' }),
  },
};
require('../../utils/stripeClient').getStripe = () => fakeStripe;

// Nothing from this suite may reach a real Sentry project.
const sentryModule = require('@sentry/node');
sentryModule.captureMessage = () => {};
sentryModule.captureException = () => {};

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../../db');
const { AppError } = require('../../utils/errors');
const publicTokenRouter = require('./publicToken');
const optionsRouter = require('./publicOptions');
const switchRouter = require('./publicSwitch');
const drinkPlansRouter = require('../drinkPlans');

if (process.env.NODE_ENV === 'production') {
  throw new Error('publicLeak.test.js refuses to run against production');
}

const SECRET_LABEL = 'Test leak label';
const SECRET_AMOUNT = '123.45';     // the hidden discount
const SECRET_SUBTOTAL = '777.77';   // the pre-fold subtotal
const SECRETS = [SECRET_LABEL, SECRET_AMOUNT, SECRET_SUBTOTAL];
const FORBIDDEN_KEYS = ['total_price_override', 'subtotal', 'breakdown'];

let server;
let baseUrl;
let byobPkg;
let hostedPkgId;
const createdProposalIds = new Set();
const createdClientIds = new Set();
const createdPlanIds = new Set();
const stamp = `leak-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

function request(method, path, { body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let json = null;
          try { json = data ? JSON.parse(data) : null; } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: json, raw: data });
        });
      }
    );
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
function assertNoLeak(res, what) {
  assert.equal(res.status, 200, `${what}: ${res.raw}`);
  for (const s of SECRETS) {
    assert.ok(!res.raw.includes(s), `${what}: the raw body carries "${s}"`);
  }
  for (const k of FORBIDDEN_KEYS) {
    assert.ok(!res.raw.includes(`"${k}"`), `${what}: the raw body carries a "${k}" key`);
  }
  const keys = keysDeep(res.body);
  for (const k of FORBIDDEN_KEYS) assert.ok(!keys.has(k), `${what}: a "${k}" key at some depth`);
}

const sumCents = (rows) => rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);

/** price_rows add up to the page's service total: snapshot.total less gratuity. */
function assertRowsAddUp(body, what) {
  assert.ok(Array.isArray(body.price_rows) && body.price_rows.length > 0, `${what}: price_rows present`);
  const snap = body.pricing_snapshot;
  const target = Math.round(Number(snap.total) * 100) - Math.round(Number((snap.gratuity && snap.gratuity.total) || 0) * 100);
  assert.equal(sumCents(body.price_rows), target, `${what}: the rows reach snapshot.total less gratuity`);
}

// A synthetic engine-shaped snapshot with one hidden discount.
// subtotal 600 + 50 + 99.77 + 28 = 777.77; less the hidden 123.45 = 654.32.
function hiddenSnapshot() {
  return {
    _version: 3,
    calculated_at: '2026-10-16T00:00:00.000Z',
    inputs: { guestCount: 120, durationHours: 4, numBars: 1, numBartenders: 2 },
    package: { id: byobPkg.id, slug: byobPkg.slug, name: byobPkg.name, category: 'byob', pricing_type: 'flat', base_cost: 600 },
    bar_rental: { num_bars: 1, first_bar_fee: 50, additional_bar_fee: 100, total: 50 },
    staffing: { included: 2, required: 2, actual: 2, extra: 0, hourly_rate: 40, total: 0 },
    addons: [{ name: 'Test Leak Add-on', billing_type: 'flat', rate: 99.77, quantity: 1, line_total: 99.77 }],
    syrups: { selections: ['s-1', 's-2'], count: 2, bottles_per_flavor: 1, total_bottles: 2, packs: 0, singles: 2, total: 28 },
    breakdown: [
      { label: 'Test Leak Package (4hrs, 120 guests)', amount: 600 },
      { label: 'Bar Rental (1 bar)', amount: 50 },
      { label: 'Test Leak Add-on', amount: 99.77 },
      { label: 'Hand-Crafted Syrups (2 flavors, 2 bottles)', amount: 28 },
      { label: SECRET_LABEL, amount: -123.45 },
    ],
    staff_noun: 'bartender',
    display_labels: { 'Shared Gratuity': 'Staffing Gratuity', Gratuity: 'Gratuity' },
    gratuity: { rate: 0, tip_jar: true, staff_count: 2, hours: 4, staff_noun: 'bartender', total: 0, floor_rate: null },
    floor_applied: false,
    floor_reason: null,
    billed_guests: 120,
    adjustments: [{ type: 'discount', label: SECRET_LABEL, amount: 123.45, visible: false }],
    total_price_override: null,
    subtotal: 777.77,
    total: 654.32,
  };
}

// The same booking priced by a $650 override (row and snapshot), no hidden line.
function overrideSnapshot() {
  const s = hiddenSnapshot();
  s.adjustments = [];
  s.breakdown = s.breakdown.filter((r) => r.label !== SECRET_LABEL);
  s.total_price_override = 650;
  s.total = 650;
  return s;
}

async function insertClient() {
  const c = await pool.query(
    `INSERT INTO clients (name, email, source) VALUES ($1, $2, 'direct') RETURNING id`,
    [`Leak Route ${stamp}`, `${stamp}-${crypto.randomBytes(3).toString('hex')}@test.local`]
  );
  createdClientIds.add(c.rows[0].id);
  return c.rows[0].id;
}

/** A booking that carries `snapshot` exactly as the engine would have stored it. */
async function insertPricedProposal({ status, snapshot, override = null, amountPaid = 0 }) {
  const clientId = await insertClient();
  const p = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, guest_count, event_duration_hours,
                            num_bars, event_date, event_start_time, total_price, amount_paid,
                            pricing_snapshot, adjustments, total_price_override)
     VALUES ($1, $2, $3, 120, 4, 1, CURRENT_DATE + 90, '5:00 PM', $4, $5, $6, $7, $8)
     RETURNING id, token`,
    [clientId, byobPkg.id, status, snapshot.total, amountPaid,
      JSON.stringify(snapshot), JSON.stringify(snapshot.adjustments), override]
  );
  createdProposalIds.add(p.rows[0].id);
  return p.rows[0];
}

async function insertDrinkPlan(proposalId) {
  const r = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status) VALUES ($1, 'pending') RETURNING id, token`,
    [proposalId]
  );
  createdPlanIds.add(r.rows[0].id);
  return r.rows[0];
}

before(async () => {
  const byob = await pool.query(
    `SELECT id, slug, name FROM service_packages WHERE category = 'byob' AND is_active = true ORDER BY id LIMIT 1`);
  byobPkg = byob.rows[0];
  const hosted = await pool.query(
    `SELECT id FROM service_packages
      WHERE pricing_type = 'per_guest' AND is_active = true AND bar_type IS DISTINCT FROM 'class'
      ORDER BY id LIMIT 1`);
  hostedPkgId = hosted.rows[0].id;
  assert.ok(byobPkg && hostedPkgId, 'the dev catalog carries a BYOB and a hosted package');

  const app = express();
  app.use(express.json());
  app.use('/api/proposals', publicTokenRouter);
  app.use('/api/proposals', optionsRouter);
  app.use('/api/proposals', switchRouter);
  app.use('/api/drink-plans', drinkPlansRouter);
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof AppError) {
      const out = { error: err.message, code: err.code };
      if (err.fieldErrors) out.fieldErrors = err.fieldErrors;
      return res.status(err.statusCode).json(out);
    }
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
  if (server) await new Promise((r) => server.close(r));
  const pids = [...createdProposalIds];
  if (createdPlanIds.size > 0) {
    await pool.query('DELETE FROM drink_plans WHERE id = ANY($1)', [[...createdPlanIds]]);
  }
  if (pids.length > 0) {
    await pool.query(
      'DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [pids]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM stripe_sessions WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [pids]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [pids]);
  }
  if (createdClientIds.size > 0) {
    await pool.query('DELETE FROM clients WHERE id = ANY($1)', [[...createdClientIds]]);
  }
  await pool.end();
});

test('(a) a sent proposal with a hidden discount: the page payload carries folded rows and nothing hidden', async () => {
  const p = await insertPricedProposal({ status: 'sent', snapshot: hiddenSnapshot() });
  const res = await request('GET', `/api/proposals/t/${p.token}`);
  assertNoLeak(res, 'GET /t/:token (a)');
  assertRowsAddUp(res.body, '(a)');
  // The package row absorbed the hidden 123.45: 600 - 123.45.
  const pkgRow = res.body.price_rows.find((r) => r.key === 'package');
  assert.equal(pkgRow.amount, 476.55);
  // A browser on the old bundle draws base_cost + staffing.total: the same figure.
  const snap = res.body.pricing_snapshot;
  assert.equal(Number(snap.package.base_cost) + Number(snap.staffing.total), pkgRow.amount);
  assert.deepEqual(snap.adjustments, [], 'no hidden line survives');

  // A pre-booking drink plan answers locked, with no snapshot at all.
  const plan = await insertDrinkPlan(p.id);
  const dp = await request('GET', `/api/drink-plans/t/${plan.token}`);
  assertNoLeak(dp, 'GET /drink-plans/t/:token (a, locked)');
  assert.deepEqual(dp.body, { locked: true, proposalToken: p.token });
});

test('(b) a viewed proposal with an override: no override key, no pre-fold subtotal', async () => {
  const snapshot = overrideSnapshot();
  const p = await insertPricedProposal({ status: 'viewed', snapshot, override: 650 });
  const stored = await pool.query('SELECT total_price_override, pricing_snapshot FROM proposals WHERE id = $1', [p.id]);
  assert.equal(Number(stored.rows[0].total_price_override), 650, 'premise: the row carries the override');
  assert.equal(Number(stored.rows[0].pricing_snapshot.total_price_override), 650, 'premise: so does the snapshot');
  const res = await request('GET', `/api/proposals/t/${p.token}`);
  assertNoLeak(res, 'GET /t/:token (b)');
  assertRowsAddUp(res.body, '(b)');
  assert.equal(res.body.price_rows.find((r) => r.key === 'package').amount, 472.23, '600 less the override difference 127.77');
});

test('(c) the switch response carries folded rows and nothing hidden; the options quote carries no label', async () => {
  // A switchable booking (sent, no override, unsigned, unpaid) whose ROW holds
  // the hidden discount: the switch re-prices from the row's adjustments, so the
  // committed snapshot lists it in adjustments and breakdown.
  const clientId = await insertClient();
  const ins = await pool.query(
    `INSERT INTO proposals (client_id, package_id, status, guest_count, event_duration_hours,
                            num_bars, event_date, event_start_time, total_price, adjustments)
     VALUES ($1, $2, 'sent', 120, 4, 1, CURRENT_DATE + 90, '5:00 PM', 0, $3)
     RETURNING id, token`,
    [clientId, byobPkg.id, JSON.stringify([{ type: 'discount', label: SECRET_LABEL, amount: 123.45, visible: false }])]
  );
  const p = ins.rows[0];
  createdProposalIds.add(p.id);

  const quote = await request('POST', `/api/proposals/t/${p.token}/options`, {
    body: { extra_addon_ids: [], tier_addon_id: null },
  });
  assert.equal(quote.status, 200, quote.raw);
  assert.equal(quote.body.comparable, true, `the quote must be comparable: ${quote.raw}`);
  assert.ok(!quote.raw.includes(SECRET_LABEL), 'the options quote carries no hidden label');
  assert.ok(!quote.raw.includes('"total_price_override"'), 'nor an override key');
  const target = quote.body.options.find((o) => o.package_id === hostedPkgId);
  assert.ok(target && target.available, 'the hosted package is offered');

  const res = await request('POST', `/api/proposals/t/${p.token}/switch`, {
    body: { package_id: hostedPkgId, tier_addon_id: null, extra_addon_ids: [], acknowledged_total: target.total },
  });
  const committed = (await pool.query('SELECT pricing_snapshot FROM proposals WHERE id = $1', [p.id])).rows[0].pricing_snapshot;
  // Premise: the committed snapshot really holds what the response must hide,
  // and no legitimate figure on the response happens to spell the secret.
  assert.ok(JSON.stringify(committed.adjustments).includes(SECRET_LABEL), 'premise: the snapshot holds the hidden line');
  assert.ok(Array.isArray(committed.breakdown) && committed.subtotal !== undefined, 'premise: breakdown and subtotal stored');
  for (const legit of [committed.total, committed.subtotal]) {
    assert.ok(!String(legit).includes(SECRET_AMOUNT), `premise: ${legit} does not spell ${SECRET_AMOUNT}`);
  }
  assertNoLeak(res, 'POST /t/:token/switch (c)');
  assert.ok(!res.raw.includes(`"subtotal":${committed.subtotal}`), 'the stored subtotal is not sent');
  assertRowsAddUp(res.body, '(c)');
  assert.equal(Number(res.body.pricing_snapshot.total), Number(target.total), 'the response snapshot is the committed one');
});

test('(d) a booked proposal: the drink plan page gets the same folded package and nothing hidden', async () => {
  const p = await insertPricedProposal({ status: 'deposit_paid', snapshot: hiddenSnapshot(), amountPaid: 100 });
  const plan = await insertDrinkPlan(p.id);

  const page = await request('GET', `/api/proposals/t/${p.token}`);
  assertNoLeak(page, 'GET /t/:token (d)');
  assertRowsAddUp(page.body, '(d)');

  const dp = await request('GET', `/api/drink-plans/t/${plan.token}`);
  assertNoLeak(dp, 'GET /drink-plans/t/:token (d)');
  assert.ok(!dp.body.locked, 'a booked plan opens');
  const snap = dp.body.pricing_snapshot;
  assert.ok(snap && typeof snap === 'object', 'the drink plan payload still carries the public snapshot');
  assert.equal(Number(snap.total), 654.32);
  assert.deepEqual(snap.bar_rental, hiddenSnapshot().bar_rental, 'the drink plan steps keep bar_rental');
  assert.deepEqual(snap.syrups.selections, ['s-1', 's-2'], 'the planner keeps syrups.selections');
  const pkgRow = page.body.price_rows.find((r) => r.key === 'package');
  assert.equal(Number(snap.package.base_cost) + Number(snap.staffing.total), pkgRow.amount,
    'the drink plan and the proposal page agree on the package row');
});
