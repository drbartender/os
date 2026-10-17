// Drink-plan routes on a legal-hold booking (plan 2026-10-16-price-override-
// removal, Task F1 fix round; spec section 5.3, plan decision 4). Real routers
// over HTTP against the shared dev DB.
//
// - Submit: an extras submit reaches the extras fold, which refuses a held
//   booking with 409 NOT_CHANGEABLE. submit.js:605 rolls back the plan update
//   and the add-on and bar writes, so nothing is saved, and an expected refusal
//   is not reported to Sentry. A submit that fails for real is reported, and no
//   Sentry payload carries more than the drink-plan token's last six characters
//   (it is a bearer credential).
// - Lab: the GET reports a held booking's open lab as locked, so the page
//   offers no addition. A PUT that arrives anyway (a page opened before the
//   hold) is refused before any write with a 400 save error, never the
//   window's 409, which the page would turn into "Your additions below are
//   locked in."
// Client copy never names the hold. Held ids are synthetic, ADDED through
// __setLegalHoldIdsForTest; every case has its unheld control. Run ALONE:
//   node --test server/routes/drinkPlans.legalHold.test.js

require('dotenv').config();
process.env.SEND_NOTIFICATIONS = 'false';

// Sentry stub, installed before submit.js loads. The captures are gated on the
// DSN, so the suite sets a fake one: without it every capture is a silent no-op
// and the "nothing reported" checks would pass for the wrong reason.
process.env.SENTRY_DSN_SERVER = process.env.SENTRY_DSN_SERVER || 'https://test@example.invalid/1';
const captures = [];
const sentryModule = require('@sentry/node');
sentryModule.captureException = (err, ctx) => { captures.push({ err, ctx }); };
sentryModule.captureMessage = (msg, ctx) => { captures.push({ msg, ctx }); };

// Pass-through wrappers, installed before the routers destructure them, so one
// case can make each submit transaction fail for real.
const foldModule = require('../utils/proposalExtrasFold');
const realFold = foldModule.foldExtrasIntoProposal;
let foldOverride = null;
foldModule.foldExtrasIntoProposal = (...args) => (foldOverride || realFold)(...args);
const extrasModule = require('../utils/drinkPlanExtras');
const realBreakdown = extrasModule.computeExtrasBreakdown;
let breakdownOverride = null;
extrasModule.computeExtrasBreakdown = (...args) => (breakdownOverride || realBreakdown)(...args);

const { test, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');

const { pool } = require('../db');
const { AppError } = require('../utils/errors');
const { __setLegalHoldIdsForTest } = require('../utils/legalHold');
const drinkPlansRouter = require('./drinkPlans');

if (process.env.NODE_ENV === 'production') {
  throw new Error('drinkPlans.legalHold.test.js refuses to run against production');
}

const NONCE = `dplh-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const REFUSAL = "This booking can't be changed online right now.";
let server; let baseUrl; let clientId; let barPkg; let labPkgId; let cocktailId;
const proposalIds = [];

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(baseUrl + path);
    const buf = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
      headers: buf ? { 'Content-Type': 'application/json', 'Content-Length': buf.length } : {},
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
    if (buf) req.write(buf);
    req.end();
  });
}

/** Everything a submit or a Lab save could touch on the booking. */
async function state(proposalId) {
  const one = async (sql) => (await pool.query(sql, [proposalId])).rows[0];
  return {
    row: await one(`SELECT total_price, total_price_override, num_bars, status, pricing_snapshot, adjustments, updated_at
                      FROM proposals WHERE id = $1`),
    plan: await one('SELECT status, submitted_at, selections FROM drink_plans WHERE proposal_id = $1'),
    addons: (await one('SELECT COUNT(*)::int AS n FROM proposal_addons WHERE proposal_id = $1')).n,
    log: (await one('SELECT COUNT(*)::int AS n FROM proposal_activity_log WHERE proposal_id = $1')).n,
    invoices: (await one('SELECT COUNT(*)::int AS n FROM invoices WHERE proposal_id = $1')).n,
  };
}

/** A confirmed booking with one bar and a draft plan; override null = native. */
async function seedSubmit(override) {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, package_id, event_type, guest_count, num_bars, num_bartenders,
        total_price, total_price_override, amount_paid, external_paid,
        adjustments, autopay_enrolled, pricing_snapshot, gratuity_rate, tip_jar)
     VALUES ($1, CURRENT_DATE + 30, '14:00', 4, 'America/Chicago',
             'confirmed', $2, 'wedding-reception', 175, 1, 2,
             $3, $4, 100, 100, '[]'::jsonb, false, '{}'::jsonb, 0, true)
     RETURNING id`,
    [clientId, barPkg.id, override ?? 1000, override]
  );
  const id = p.rows[0].id;
  proposalIds.push(id);
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, 'draft', '{}'::jsonb, $2, $3) RETURNING token`,
    [id, `DPLH ${NONCE}`, `${NONCE}@example.com`]
  );
  return { id, token: dp.rows[0].token };
}

/** A deposit-paid booking whose lab window is open (or a draft plan). */
async function seedLab(planStatus = 'submitted') {
  const p = await pool.query(
    `INSERT INTO proposals
       (client_id, package_id, event_date, event_start_time, event_duration_hours, event_timezone,
        status, event_type, guest_count, num_bars, total_price, amount_paid, pricing_snapshot)
     VALUES ($1, $2, CURRENT_DATE + 30, '18:00', 4, 'America/Chicago',
             'deposit_paid', 'birthday-party', 80, 0, 2000, 100, '{}'::jsonb)
     RETURNING id`,
    [clientId, labPkgId]
  );
  const id = p.rows[0].id;
  proposalIds.push(id);
  const dp = await pool.query(
    `INSERT INTO drink_plans (proposal_id, status, selections, client_name, client_email)
     VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING token`,
    [id, planStatus, JSON.stringify({ signatureDrinks: [cocktailId] }), `DPLH ${NONCE}`, `${NONCE}@example.com`]
  );
  return { id, token: dp.rows[0].token };
}

const BAR_SUBMIT = { status: 'submitted', paid_separately: false, selections: { logistics: { addBarRental: true } } };
const LAB_ADD = () => ({
  addOns: { 'champagne-toast': { servingStyle: 'Passed on trays', toastTime: '8:30 PM' } },
  labSyrupSelections: { [cocktailId]: ['jalapeno'] },
});

before(async () => {
  const pk = await pool.query(
    `SELECT * FROM service_packages
      WHERE is_active = true AND pricing_type = 'per_guest' AND bar_type <> 'class'
        AND first_bar_fee > 0 AND additional_bar_fee > 0
      ORDER BY id LIMIT 1`);
  barPkg = pk.rows[0];
  assert.ok(barPkg, 'need an active per_guest, non-class package with both bar fees');
  clientId = (await pool.query('INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING id',
    [`DPLH ${NONCE}`, `${NONCE}@example.com`])).rows[0].id;
  cocktailId = `dplh-cock-${NONCE}`;
  await pool.query(
    `INSERT INTO cocktails (id, name, is_active, syrup_id, enhancements) VALUES ($1, $2, true, 'jalapeno', '[]'::jsonb)`,
    [cocktailId, `DPLH Cocktail ${NONCE}`]);
  labPkgId = (await pool.query(
    `INSERT INTO service_packages (slug, name, category, pricing_type, base_rate_4hr, base_rate_4hr_small,
        min_guests, guests_per_bartender, bar_type, includes)
     VALUES ($1, 'DPLH Lab Pkg', 'hosted', 'per_guest', 28, 33, 50, 100, 'full_bar', '[]') RETURNING id`,
    [`dplh-${NONCE}`])).rows[0].id;

  const app = express();
  app.use(express.json());
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
  await new Promise((r) => { server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; r(); }); });
});

afterEach(() => {
  __setLegalHoldIdsForTest(null);
  foldOverride = null;
  breakdownOverride = null;
  captures.length = 0;
});

after(async () => {
  __setLegalHoldIdsForTest(null);
  // Let the fire-and-forget submit tail (shopping list, lab follow-up) settle.
  await new Promise((r) => setTimeout(r, 500));
  if (proposalIds.length) {
    await pool.query(
      "DELETE FROM scheduled_messages WHERE entity_type = 'proposal' AND entity_id = ANY($1::int[])", [proposalIds]);
    await pool.query(
      'DELETE FROM invoice_line_items WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [proposalIds]);
    await pool.query(
      'DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE proposal_id = ANY($1))', [proposalIds]);
    await pool.query('DELETE FROM invoices WHERE proposal_id = ANY($1)', [proposalIds]);
    await pool.query('DELETE FROM proposal_addons WHERE proposal_id = ANY($1)', [proposalIds]);
    await pool.query('DELETE FROM proposal_activity_log WHERE proposal_id = ANY($1)', [proposalIds]);
    await pool.query('DELETE FROM drink_plans WHERE proposal_id = ANY($1)', [proposalIds]);
    await pool.query('DELETE FROM proposals WHERE id = ANY($1)', [proposalIds]);
  }
  if (cocktailId) await pool.query('DELETE FROM cocktails WHERE id = $1', [cocktailId]);
  if (labPkgId) await pool.query('DELETE FROM service_packages WHERE id = $1', [labPkgId]);
  if (clientId) await pool.query('DELETE FROM clients WHERE id = $1', [clientId]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

for (const override of [null, 3000]) {
  test(`submit with a bar on a held ${override === null ? 'native' : 'override'} booking: 409, nothing saved, no Sentry event`, async () => {
    const s = await seedSubmit(override);
    __setLegalHoldIdsForTest([s.id]);
    const beforeState = await state(s.id);
    const res = await request('PUT', `/api/drink-plans/t/${s.token}`, BAR_SUBMIT);
    assert.equal(res.status, 409, res.raw);
    assert.equal(res.body.code, 'NOT_CHANGEABLE');
    assert.equal(res.body.error, REFUSAL);
    assert.deepEqual(await state(s.id), beforeState, 'the plan stays draft and the booking is unchanged');
    assert.equal(beforeState.plan.status, 'draft');
    assert.deepEqual(captures, [], 'an expected refusal is not an incident');

    __setLegalHoldIdsForTest(null);
    const ok = await request('PUT', `/api/drink-plans/t/${s.token}`, BAR_SUBMIT);
    assert.equal(ok.status, 200, ok.raw);
    const afterOk = await state(s.id);
    assert.equal(afterOk.plan.status, 'submitted');
    assert.equal(afterOk.row.num_bars, 2);
  });
}

test('a submit that fails for real is reported to Sentry with only the token tail', async () => {
  const s = await seedSubmit(null);
  const beforeState = await state(s.id);
  foldOverride = () => { throw new Error('synthetic submit failure'); };
  const res = await request('PUT', `/api/drink-plans/t/${s.token}`, BAR_SUBMIT);
  assert.equal(res.status, 500, res.raw);
  assert.deepEqual(await state(s.id), beforeState, 'rolled back');
  assert.equal(captures.length, 1);
  const { ctx } = captures[0];
  assert.equal(ctx.extra.tokenTail, s.token.slice(-6));
  assert.equal(ctx.extra.proposalId, s.id);
  assert.ok(!('token' in ctx.extra));
  assert.ok(!JSON.stringify(ctx).includes(s.token), 'the full token never leaves');
});

test('the pay-now extras transaction reports with only the token tail too', async () => {
  const s = await seedSubmit(null);
  breakdownOverride = () => { throw new Error('synthetic extras failure'); };
  const res = await request('PUT', `/api/drink-plans/t/${s.token}`,
    { status: 'submitted', paid_separately: true, selections: {} });
  assert.equal(res.status, 500, res.raw);
  assert.equal(captures.length, 1);
  const { ctx } = captures[0];
  assert.equal(ctx.tags.op, 'submit_extras_invoice');
  assert.equal(ctx.extra.tokenTail, s.token.slice(-6));
  assert.ok(!JSON.stringify(ctx).includes(s.token), 'the full token never leaves');
});

test('the Lab GET reports a held booking\'s open lab as locked; a draft plan stays not_ready', async () => {
  const open = await seedLab();
  const draft = await seedLab('draft');
  const unheld = await request('GET', `/api/drink-plans/t/${open.token}/lab`);
  assert.equal(unheld.status, 200, unheld.raw);
  assert.equal(unheld.body.state, 'open', 'the control');

  __setLegalHoldIdsForTest([open.id, draft.id]);
  const held = await request('GET', `/api/drink-plans/t/${open.token}/lab`);
  assert.equal(held.status, 200, held.raw);
  assert.equal(held.body.state, 'locked');
  assert.doesNotMatch(held.raw, /legal|hold/i, 'the page copy never names the hold');
  const heldDraft = await request('GET', `/api/drink-plans/t/${draft.token}/lab`);
  assert.equal(heldDraft.body.state, 'not_ready', 'an unfiled plan is not called locked in');
});

test('a Lab PUT on a held booking is a 400 save error before any write, never the window\'s 409', async () => {
  const s = await seedLab();
  __setLegalHoldIdsForTest([s.id]);
  const beforeState = await state(s.id);
  const res = await request('PUT', `/api/drink-plans/t/${s.token}/lab`, LAB_ADD());
  assert.equal(res.status, 400, res.raw);
  assert.equal(res.body.code, 'VALIDATION_ERROR');
  assert.equal(res.body.error, REFUSAL);
  assert.deepEqual(res.body.fieldErrors, { addOns: REFUSAL });
  assert.deepEqual(await state(s.id), beforeState, 'selections and booking unchanged');

  __setLegalHoldIdsForTest(null);
  const ok = await request('PUT', `/api/drink-plans/t/${s.token}/lab`, LAB_ADD());
  assert.equal(ok.status, 200, ok.raw);
  const afterOk = await state(s.id);
  assert.equal(afterOk.addons, 1);
  assert.equal(afterOk.plan.selections.addOns['champagne-toast'].labAdded, true);
});
